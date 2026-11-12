// The turn gate's offline replay (REASON_CALL_TURN_GATE, src/calls/turngate.js): recorded-style event
// timelines — their audio frames, their transcript pieces, the decisions about them, the voice's audio —
// fed through the real call relay (GptLiveCall) with stand-ins for Twilio, the voice session and the
// clock. No network, no key, no real call data: every timeline is synthetic.
//
//   node scripts/turn-gate-replay.mjs            # the report
//   node scripts/turn-gate-replay.mjs --json     # the same, as JSON
//
// What it answers, for a turn where they pause mid-thought, carry on, and then finish:
//   - in the pause: was a short acknowledgement heard, did it sit in the pause or land on their words,
//     and did a full reply to half the thought reach the phone;
//   - when they finished: was the real reply prompt, or delayed, and by how much.
// The one thing it cannot know is how late GPT-Live's transcript really is, so it runs three
// assumptions for that lag; the first real call's `gptlive_turn_gate` log lines (transcript_ms,
// decision_ms, lead_ms, pause_ms) say which one is true.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Decisions latency as measured 2026-11-12 (120 requests, synthetic lines): p50 209, p95 432, max 582 ms. */
export const DECISION_MS = [141, 142, 144, 148, 148, 150, 152, 153, 155, 157, 158, 160, 162, 163, 164, 165, 166, 169, 169, 170, 170, 171, 173, 174, 175, 176, 176, 176, 177, 177, 178, 180, 181, 181, 182, 182, 182, 182, 182, 183, 184, 185, 186, 188, 190, 193, 194, 198, 199, 199, 199, 202, 202, 202, 202, 203, 204, 207, 208, 209, 209, 210, 210, 210, 210, 212, 214, 214, 215, 215, 217, 218, 219, 221, 221, 222, 224, 226, 229, 236, 238, 238, 238, 242, 242, 243, 247, 249, 250, 251, 253, 253, 254, 254, 256, 258, 260, 265, 267, 276, 285, 288, 289, 292, 294, 326, 331, 339, 339, 346, 347, 397, 417, 432, 434, 498, 521, 533, 538, 582];
/** The predicate's accuracy on the spike's cases: 39 of 40. */
export const ACCURACY = 39 / 40;

/**
 * How far their transcript trails their voice — the open question. The repo's own notes: 0.5–1.5 s
 * usual (TALKOVER_WORDLESS_MS), one seen 2.7 s late (TRANSCRIPT_LAG_MS).
 */
export const LAGS = {
  "transcript 0.3–0.8 s behind": [300, 800],
  "transcript 0.5–1.5 s behind (the repo's notes)": [500, 1500],
  "transcript 1.5–2.7 s behind (the late one seen)": [1500, 2700],
};

const SILENT = Buffer.alloc(160, 0xff).toString("base64");
const LOUD = Buffer.alloc(160, 0x00).toString("base64");

/** A small seeded generator, so a report can be reproduced. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r, [lo, hi]) => Math.round((lo + r() * (hi - lo)) / 20) * 20;

function fakeTimers() {
  let t = 1_000_000;
  let q = [];
  let n = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++n; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { q = q.filter(x => x.id !== id); },
    /** Run everything due up to `ms` from now, in order, moving the clock to each as it runs. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

let mods = null;
let made = null;
/** The relay and a throwaway database of its own (unless a test has already set one up). */
async function load() {
  if (mods) return mods;
  if (!process.env.REASON_DB_PATH) {
    made = mkdtempSync(join(tmpdir(), "reason-turn-gate-replay-"));
    Object.assign(process.env, {
      REASON_DB_PATH: join(made, "reason.db"), REASON_RECORDING_ROOT: join(made, "recordings"), REASON_OWNER_NAME: "Sam",
      REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_OWNER_NUMBER: "+12025550100", REASON_PUBLIC_URL: "https://reason.example.test",
    });
    process.on("exit", () => { try { rmSync(made, { recursive: true, force: true }); } catch { /* gone */ } });
  }
  const gl = await import("../src/calls/gptlive.js");
  const db = await import("../src/db.js");
  const { config } = await import("../src/config.js");
  mods = { gl, db, config };
  return mods;
}

/**
 * One timeline through one call. `events` are `{ at, ... }` in ms from the timeline's zero:
 *   { at, them: ms }                     their side makes sound for `ms`
 *   { at, heard: "id", end: ms }         a piece of their transcript arrives (the trigger's source), its words
 *                                        ending at `end` on the timeline (the session's `end_ms`)
 *   { at, decision: "id", finished: p }  the decision about that piece arrives (`failed: true` for an error)
 *   { at, voice: ms }                    the voice's audio arrives for `ms` (a run of speech)
 *   { at, said: "words" }                a piece of the voice's own transcript arrives
 * Returns what reached the phone and what the gate logged.
 */
export async function replayOne(events, { gate = "on", row = null, until = null, beforeStart = null, setup = null, react = 600 } = {}) {
  events = [...events];
  const { gl, db, config } = await load();
  const before = config.callTurnGate;
  config.callTurnGate = gate;
  try {
    const timers = fakeTimers();
    const sentTwilio = [];
    const handlers = [];
    const twilio = { send: (s) => sentTwilio.push({ at: timers.now(), ...JSON.parse(s) }), close: () => {}, onMessage: (f) => handlers.push(f), onClose: () => {} };
    const live = { sent: [], h: { open: [], event: [], close: [] } };
    const socket = { send: (o) => live.sent.push({ at: timers.now(), ...o }), close: () => {}, on: (k, f) => live.h[k].push(f) };
    const lines = [];
    const call = new gl.GptLiveCall({
      call: row ?? db.createCall(config.ownerConversation, { provider: "gptlive", toNumber: "+12025550100", isOwner: true, goal: "check in", facts: [], announcement: "Hey, what's up?", state: "placing" }),
      twilio, openLive: () => socket, brain: () => new Promise(() => {}), judge: async () => ({ ended: false }), now: timers.now, timers, log: (o) => lines.push({ at: timers.now(), ...o }), finish: async () => {},
    });
    const say = (obj) => handlers.forEach(f => f(JSON.stringify(obj)));
    const emit = (e) => live.h.event.forEach(f => f(e));
    say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
    live.h.open.forEach(f => f());
    if (beforeStart) beforeStart(emit);
    emit({ type: "session.started", session: { id: "live_1" } });
    if (setup) setup(call);
    const zero = timers.now();
    // 20 ms slots: who is making sound in each.
    const end = until ?? Math.max(...events.map(e => e.at + (e.them ?? e.voice ?? 0))) + 2500;
    let seen = 0;
    const asked = [];
    const at = (ms) => events.filter(e => e.at >= ms && e.at < ms + 20);
    const span = (key, ms) => events.some(e => e[key] && ms >= e.at && ms < e.at + e[key]);
    for (let ms = 0; ms < end; ms += 20) {
      for (const e of at(ms)) {
        if (e.heard) emit({ type: "session.input_transcript.delta", event_id: e.heard, delta: " words", ...(e.end != null ? { start_ms: Math.max(0, e.end - 400), end_ms: e.end } : {}) });
        if (e.said) emit({ type: "session.output_transcript.delta", delta: e.said });
        if (e.decision) {
          emit({ type: "decision.event", delegation_id: null, trigger_id: "trg_1", source_event_type: "session.input_transcript.delta", source_event_id: e.decision,
            event: e.failed ? { type: "decision.failed", error: { message: "synthetic" } } : { type: "decision.completed", decision: { answers: [{ type: "predicate", name: "finished", probability: e.finished }, ...(e.asks ? [{ type: "choice", name: "asks", choice: e.asks }] : [])] } } });
        }
      }
      // The voice does as it is asked: told to say only a word, it says it `react` ms later (0 = never).
      for (; seen < live.sent.length; seen++) {
        const m = /say only "([^"]+)"/.exec(String(live.sent[seen].content ?? ""));
        // Asked, it says that and not something of its own (what it had not yet begun is not said).
        // (An instruction stops what it is saying, per the docs: its own run ends here.)
        if (m && react) events = events.filter(e => !(e.own && e.at > ms)).map(e => (e.own && e.voice && e.at + e.voice > ms ? { ...e, voice: Math.max(0, ms - e.at) } : e));
        if (m && react) { asked.push(ms); events.push({ at: ms + react, voice: 400, asked: true }, { at: ms + react + 100, said: m[1] }); }
      }
      // Their speech has the gaps speech has (60 ms in every 300): a steady tone is line noise to the relay, as it should be.
      const theirs = events.find(e => e.them && ms >= e.at && ms < e.at + e.them);
      say({ event: "media", media: { payload: theirs && ((ms - theirs.at) % 300 < 240 || ms >= theirs.at + theirs.them - 60) ? LOUD : SILENT } });
      if (span("voice", ms)) emit({ type: "session.output_audio.delta", delta: LOUD });
      timers.advance(20);
    }
    call.done = true;
    const played = sentTwilio.filter(m => m.event === "media" && m.media?.payload && m.media.payload !== SILENT).map(m => m.at - zero);
    // What the phone plays, and when: Twilio plays what it is sent in order, 20 ms a frame, and a clear empties what has not played.
    const heard = [];
    let head = 0;
    for (const m of sentTwilio) {
      const at = m.at - zero;
      if (m.event === "clear") { while (heard.length && heard.at(-1) >= at) heard.pop(); head = at; continue; }
      if (m.event !== "media" || !m.media?.payload) continue;
      head = Math.max(head, at);
      if (m.media.payload !== SILENT) heard.push(head);
      head += 20;
    }
    return { played, heard, asked, lines, live, sentTwilio, zero, call, events, gate: lines.filter(l => l.gptlive_turn_gate != null) };
  } finally {
    config.callTurnGate = before;
  }
}

/**
 * A call's first exchange (the greeting, their hello, its verdict, the reply), so the turn under test
 * is an ordinary later turn: decisions are known to be answering, and it is not the first exchange.
 */
const WARMUP = [
  { at: 0, voice: 600 },
  { at: 1500, them: 400 },
  { at: 2300, heard: "w1", end: 1900 },
  { at: 2500, decision: "w1", finished: 0.98 },
  { at: 3000, voice: 600 },
];
const T0 = 6000;

/**
 * One synthetic turn of theirs: they talk for `talk`, pause mid-thought for `pause`, carry on for
 * `more`, and stop — finished. Their transcript comes in pieces, the last words of each stretch `lag`
 * behind their voice, with a decision on each (`right`: whether each verdict is the true one).
 * In the pause the voice does one of three things (`voice`): "ack" a short sound of its own, "reply" a
 * full answer to half the thought, or "none" (code then asks it for one). After they finish, the
 * voice's real reply starts `onset` later.
 */
export function turn({ talk = 4000, pause = 1800, more = 2000, lag, onset, pauseOnset, voice = "ack", d = [200, 200, 200], right = [true, true], said = "Mm-hm." }) {
  const stop1 = T0 + talk;
  const resume = stop1 + pause;
  const stop2 = resume + more;
  const events = [
    ...WARMUP,
    { at: T0, them: talk },
    { at: Math.max(T0 + 200, stop1 - 600 + lag), heard: "p1", end: stop1 - 600 },
    { at: Math.max(T0 + 200, stop1 - 600 + lag) + d[0], decision: "p1", finished: 0.03 },
    { at: stop1 + lag, heard: "p2", end: stop1 },
    { at: stop1 + lag + d[1], decision: "p2", finished: right[0] ? 0.03 : 0.97 },
    { at: resume, them: more },
    { at: stop2 + lag, heard: "p3", end: stop2 },
    { at: stop2 + lag + d[2], decision: "p3", finished: right[1] ? 0.97 : 0.03 },
    { at: stop2 + onset, voice: 1400, reply: true },
    { at: stop2 + onset + 200, said: "Okay, so here's what I'd do." },
  ];
  if (voice === "ack") events.push({ at: stop1 + pauseOnset, voice: 400, own: true }, { at: stop1 + pauseOnset + 100, said, own: true });
  if (voice === "reply") events.push({ at: stop1 + pauseOnset, voice: 1800, own: true }, { at: stop1 + pauseOnset + 200, said: "Sure, I can do that for you now.", own: true });
  return { events, stop1, resume, stop2, replyAt: stop2 + onset };
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** What the phone played in one replayed turn, read against when they were talking. */
export function measure(t, res) {
  const inPause = res.heard.filter(ms => ms >= t.stop1 && ms < t.resume);
  // Voice audio begun in the pause (or asked for in it) that was still playing once they had carried on.
  const onSpeech = res.heard.filter(ms => ms >= t.resume && ms < t.stop2).length * 20;
  const reply = res.heard.filter(ms => ms >= t.replyAt - 20);
  return {
    ackMs: inPause.length * 20, ackAt: inPause.length ? inPause[0] - t.stop1 : null, onSpeech,
    fullReply: inPause.length * 20 + onSpeech > 700,
    replied: reply.length > 0, replyDelay: reply.length ? Math.max(0, reply[0] - t.replyAt - 20) : null,
  };
}

/** `n` turns under one assumption about the transcript's lag: a third each of the voice's three behaviours in the pause. */
export async function scenario(lagRange, { n = 150, seed = 7, gate = "on" } = {}) {
  const r = rng(seed);
  const pick = () => DECISION_MS[Math.floor(r() * DECISION_MS.length)];
  const out = { n, pauses: { ack: 0, ackInPause: 0, ackOnSpeech: 0, onSpeechMs: [], ackAt: [], none: 0, fullReplies: 0, fullHeard: 0 }, finished: { n: 0, prompt: 0, delayed: 0, never: 0, delays: [] } };
  for (let i = 0; i < n; i++) {
    const voice = ["ack", "reply", "none"][i % 3];
    const t = turn({
      talk: between(r, [2500, 9000]), pause: between(r, [1200, 2800]), more: between(r, [1500, 4000]), voice,
      lag: between(r, lagRange), onset: between(r, [700, 1300]), pauseOnset: between(r, [500, 1000]),
      d: [pick(), pick(), pick()], right: [r() < ACCURACY, r() < ACCURACY], said: ["Mm-hm.", "Yeah.", "Go on."][Math.floor(r() * 3)],
    });
    const m = measure(t, await replayOne(t.events, { gate, until: t.replyAt + 2600 }));
    const p = out.pauses;
    if (voice === "reply") { p.fullReplies++; if (m.fullReply) p.fullHeard++; }
    if (m.ackMs || m.onSpeech) {
      if (!m.fullReply) { p.ack++; if (m.onSpeech > 40) p.ackOnSpeech++; else p.ackInPause++; if (m.ackAt != null) p.ackAt.push(m.ackAt); }
      p.onSpeechMs.push(m.onSpeech);
    } else p.none++;
    const f = out.finished;
    f.n++;
    if (!m.replied) f.never++;
    else { f.delays.push(m.replyDelay); if (m.replyDelay <= 100) f.prompt++; else f.delayed++; }
  }
  return out;
}

export async function report({ n = 150, seed = 7 } = {}) {
  const rows = {};
  for (const [name, range] of Object.entries(LAGS)) rows[name] = await scenario(range, { n, seed });
  rows["gate off (as live today), transcript 0.5–1.5 s behind"] = await scenario(LAGS["transcript 0.5–1.5 s behind (the repo's notes)"], { n, seed, gate: "off" });
  return rows;
}

export function render(rows) {
  const lines = ["Turn gate replay — synthetic turns through the real relay: they talk, pause mid-thought, carry on, finish", "(in the pause the voice gives a short sound of its own, starts a full reply, or says nothing: a third each)", ""];
  for (const [name, s] of Object.entries(rows)) {
    const p = s.pauses;
    const f = s.finished;
    lines.push(name,
      `  mid-thought pauses (${s.n}): an acknowledgement heard in ${pct(p.ack, s.n)} — ${p.ackInPause} wholly in the pause, ${p.ackOnSpeech} still playing when they carried on; nothing heard in ${pct(p.none, s.n)}`,
      `  an acknowledgement began ${q(p.ackAt, 0.5) ?? "–"} ms into the pause (median); voice audio on top of their words: worst ${q(p.onSpeechMs, 1) ?? 0} ms`,
      `  full replies to half a thought (${p.fullReplies}): reached the phone ${pct(p.fullHeard, p.fullReplies)}`,
      `  when they finished (${f.n}): real reply prompt (≤100 ms added) ${pct(f.prompt, f.n)}, delayed ${pct(f.delayed, f.n)}, not within 2.5 s ${pct(f.never, f.n)}; added delay median ${q(f.delays, 0.5)} ms, p90 ${q(f.delays, 0.9)} ms, worst ${q(f.delays, 1)} ms`, "");
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rows = await report();
  console.log(process.argv.includes("--json") ? JSON.stringify(rows, null, 1) : render(rows));
  process.exit(0);
}
