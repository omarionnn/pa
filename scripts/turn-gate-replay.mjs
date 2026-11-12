// The turn gate's offline replay (REASON_CALL_TURN_GATE, src/calls/turngate.js): recorded-style event
// timelines — their audio frames, their transcript pieces, the decisions about them, the voice's audio —
// fed through the real call relay (GptLiveCall) with stand-ins for Twilio, the voice session and the
// clock. No network, no key, no real call data: every timeline is synthetic.
//
//   node scripts/turn-gate-replay.mjs            # the report
//   node scripts/turn-gate-replay.mjs --json     # the same, as JSON
//
// What it answers: how often does the verdict land before the voice's first audio, how often inside
// the gate's budget, how often does a mid-thought "Go on" still reach the phone, how often is a good
// reply held by mistake, and how much delay does the gate add. The one thing it cannot know is how
// late GPT-Live's transcript really is, so it runs three assumptions for that lag; the first real
// call's `gptlive_turn_gate` log lines (transcript_ms, decision_ms, lead_ms) say which one is true.
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
export async function replayOne(events, { gate = "on", row = null, until = null, beforeStart = null, setup = null } = {}) {
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
      say({ event: "media", media: { payload: span("them", ms) ? LOUD : SILENT } });
      if (span("voice", ms)) emit({ type: "session.output_audio.delta", delta: LOUD });
      timers.advance(20);
    }
    call.done = true;
    const played = sentTwilio.filter(m => m.event === "media" && m.media?.payload && m.media.payload !== SILENT).map(m => m.at - zero);
    return { played, lines, live, sentTwilio, zero, call, gate: lines.filter(l => l.gptlive_turn_gate != null) };
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
 * One synthetic turn of theirs, ending at `T0 + talk`: the transcript in two pieces (the last words
 * `lag` behind their voice, the piece before it 600 ms earlier), a decision on each, and the voice
 * starting `onset` after their last sound.
 *   finished: a whole thought; the voice's reply should reach the phone, undelayed.
 *   mid:      they stop mid-thought; the voice's "Go on" should never reach the phone. They carry on 2.4 s later.
 */
export function turn({ kind, lag, onset, d1, d2, right = true, talk = 1800 }) {
  const stop = T0 + talk;
  const finished = kind === "finished";
  const verdict = (finished ? right : !right) ? 0.97 : 0.03;
  return {
    stop, kind,
    events: [
      ...WARMUP,
      { at: T0, them: talk },
      { at: Math.max(T0 + 200, stop - 600 + lag), heard: "p1", end: stop - 600 },
      { at: Math.max(T0 + 200, stop - 600 + lag) + d1, decision: "p1", finished: 0.03 },
      { at: stop + lag, heard: "p2", end: stop },
      { at: stop + lag + d2, decision: "p2", finished: verdict },
      { at: stop + onset, voice: finished ? 1200 : 500 },
      ...(finished ? [] : [{ at: stop + 2400, them: 1500 }]),
    ],
  };
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** `n` finished turns and `n` mid-thought turns under one assumption about the transcript's lag. */
export async function scenario(lagRange, { n = 150, seed = 7 } = {}) {
  const r = rng(seed);
  const pick = () => DECISION_MS[Math.floor(r() * DECISION_MS.length)];
  const out = { turns: 2 * n, finished: { n, before: 0, inBudget: 0, played: 0, heldWrong: 0, delays: [] }, mid: { n, before: 0, inBudget: 0, kept: 0, slipped: 0 } };
  for (const kind of ["finished", "mid"]) {
    for (let i = 0; i < n; i++) {
      // The voice's reply to a finished sentence starts about a second after it; a listening sound into a pause, sooner.
      const onset = between(r, kind === "finished" ? [700, 1300] : [500, 1000]);
      const lag = between(r, lagRange);
      const d2 = pick();
      const t = turn({ kind, lag, onset, d1: pick(), d2, right: r() < ACCURACY });
      const res = await replayOne(t.events, { until: t.stop + 2300 });
      const first = t.stop + onset;
      const verdictAt = t.stop + lag + d2;
      const heard = res.played.filter(ms => ms >= first - 20);
      const o = out[kind];
      if (verdictAt <= first) o.before++;
      if (verdictAt <= first + 500) o.inBudget++;
      if (kind === "finished") {
        // Played when its audio reached the phone before the turn's window closed.
        if (heard.length) { o.played++; o.delays.push(Math.max(0, heard[0] - first - 20)); } else o.heldWrong++;
      } else if (heard.length) o.slipped++; else o.kept++;
    }
  }
  return out;
}

export async function report({ n = 150, seed = 7 } = {}) {
  const rows = {};
  for (const [name, range] of Object.entries(LAGS)) rows[name] = await scenario(range, { n, seed });
  return rows;
}

export function render(rows) {
  const lines = ["Turn gate replay — synthetic timelines through the real relay (REASON_CALL_TURN_GATE=on)", ""];
  for (const [name, s] of Object.entries(rows)) {
    const all = s.finished.n + s.mid.n;
    lines.push(name, `  verdict in before the voice's first audio: ${pct(s.finished.before + s.mid.before, all)}; inside the 500 ms budget: ${pct(s.finished.inBudget + s.mid.inBudget, all)}`,
      `  mid-thought pauses (${s.mid.n}): "Go on" kept off the phone ${pct(s.mid.kept, s.mid.n)}, slipped through ${pct(s.mid.slipped, s.mid.n)}`,
      `  finished thoughts (${s.finished.n}): reply played ${pct(s.finished.played, s.finished.n)}, held by mistake ${pct(s.finished.heldWrong, s.finished.n)}`,
      `  delay added to a played reply: median ${q(s.finished.delays, 0.5)} ms, p90 ${q(s.finished.delays, 0.9)} ms, worst ${q(s.finished.delays, 1)} ms`, "");
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rows = await report();
  console.log(process.argv.includes("--json") ? JSON.stringify(rows, null, 1) : render(rows));
  process.exit(0);
}
