// Call 76 (2026-11-08): what Reason hears on a call. Quiet speech lifted before the voice hears it
// (src/calls/hearing.js), the voice told to ask rather than guess and to sound like a friend rather than
// a therapist (src/calls/gptlive.js), and each turn kept on the person's own call row (turn_log),
// emptied by the retention sweep with the transcript. No network: stand-in voice session and Twilio.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-hearing-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const hearing = await import("../src/calls/hearing.js");
const { ulawToPcm, pcmToUlaw } = await import("../src/calls/ulaw.js");
const gl = await import("../src/calls/gptlive.js");
const db = await import("../src/db.js");
const privacy = await import("../src/privacy.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM accounts;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  Object.assign(config, { callIdentity: false, callHearing: true, callVoice: "gptlive", twilioSid: "AC_test", twilioToken: "t", twilioFrom: "+16562167455", openaiKey: "sk-test" });
});

// ---------- audio helpers ----------

let phase = 0;
/** 20 ms of a voice-ish tone (two partials) at `db` dBFS RMS, as base64 μ-law. */
function tone(db, n = 160) {
  const rms = 32768 * 10 ** (db / 20);
  const a = rms * Math.SQRT2 / Math.SQRT2; // two equal partials: each sqrt(2)·rms/sqrt(2)
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++, phase++) {
    const s = a * Math.sin(2 * Math.PI * 220 * phase / 8000) + a * Math.sin(2 * Math.PI * 610 * phase / 8000);
    out[i] = pcmToUlaw(Math.round(s));
  }
  return out.toString("base64");
}
/** Line hiss at `db` dBFS RMS (seeded, so the suite is repeatable). */
let seed = 7;
function hiss(db, n = 160) {
  const rms = 32768 * 10 ** (db / 20);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = pcmToUlaw(Math.round(((seed / 0x7fffffff) * 2 - 1) * rms * Math.sqrt(3)));
  }
  return out.toString("base64");
}
const dbOf = (b64) => { const b = Buffer.from(b64, "base64"); let s = 0; for (const u of b) { const x = ulawToPcm(u); s += x * x; } return 20 * Math.log10(Math.sqrt(s / b.length) / 32768 || 1e-9); };
const peakOf = (b64) => Math.max(...[...Buffer.from(b64, "base64")].map(u => Math.abs(ulawToPcm(u))));
const run = (h, frames, opts) => frames.map((f, i) => h.frame(f, i * 20, opts));

// ---------- the lift ----------

test("quiet speech (−45 dBFS, call 76's quiet words) comes up to a normal phone level within half a second", () => {
  const h = new hearing.Hearing();
  run(h, Array.from({ length: 50 }, () => hiss(-74)));
  const out = run(h, Array.from({ length: 40 }, () => tone(-45)));
  const settled = out.slice(25).map(dbOf);
  for (const d of settled) assert.ok(d > -30 && d <= hearing.TARGET_DB + 1, `settled at ${d.toFixed(1)} dBFS`);
  assert.ok(dbOf(out[0]) < -40, "the first frame is not jumped up in one step");
});

test("loud speech is left as it came: never cut, never pumped", () => {
  const h = new hearing.Hearing();
  const frames = Array.from({ length: 60 }, () => tone(-20));
  const out = run(h, frames);
  assert.deepEqual(out, frames, "byte for byte");
});

test("silence and line noise are never lifted into something that sounds like words", () => {
  const h = new hearing.Hearing();
  const quiet = Array.from({ length: 200 }, () => hiss(-74));
  for (const [i, o] of run(h, quiet).entries()) assert.ok(Math.abs(dbOf(o) - dbOf(quiet[i])) < 0.5);
  // A noisy line (hiss at −50) and a voice barely over it: not speech by the gate, so not lifted.
  const h2 = new hearing.Hearing();
  run(h2, Array.from({ length: 150 }, () => hiss(-50)));
  const mumble = Array.from({ length: 40 }, () => tone(-46));
  for (const [i, o] of run(h2, mumble).entries()) assert.ok(dbOf(o) - dbOf(mumble[i]) < 1, "under the gate, no lift");
});

test("after their words stop, the lift eases off: a long silence goes back to the line's own level", () => {
  const h = new hearing.Hearing();
  run(h, Array.from({ length: 50 }, () => hiss(-74)));
  run(h, Array.from({ length: 40 }, () => tone(-45)));
  const gap = Array.from({ length: 60 }, () => hiss(-74));
  const out = run(h, gap);
  // Held through a short pause inside a phrase...
  assert.ok(dbOf(out[5]) - dbOf(gap[5]) > 10, "a 100 ms pause keeps the lift");
  // ...then back to nothing.
  for (const i of [45, 50, 59]) assert.ok(Math.abs(dbOf(out[i]) - dbOf(gap[i])) < 0.5, `frame ${i} after 0.9 s+ of silence is unlifted`);
});

test("the limiter: a loud word straight after quiet ones is never clipped", () => {
  const h = new hearing.Hearing();
  run(h, Array.from({ length: 30 }, () => hiss(-74)));
  run(h, Array.from({ length: 40 }, () => tone(-45)));
  const out = run(h, Array.from({ length: 10 }, () => tone(-8)));
  for (const o of out) assert.ok(peakOf(o) <= hearing.LIMIT + 300, `peak ${peakOf(o)}`);
});

test("while Reason's own voice is playing, their phone's echo of it is not lifted (no false barge-in)", () => {
  const h = new hearing.Hearing();
  run(h, Array.from({ length: 50 }, () => hiss(-74)));
  const echo = Array.from({ length: 40 }, () => tone(-50));
  const out = run(h, echo, { reasonTalking: true });
  for (const [i, o] of out.entries()) assert.ok(dbOf(o) - dbOf(echo[i]) <= hearing.ECHO_GAIN_DB + 0.5);
});

test("review: gusty noise is not read as speech, and a noisy line's floor is never lifted past the ceiling", () => {
  const h = new hearing.Hearing();
  const gust = Array.from({ length: 150 }, (_, i) => hiss(i % 10 < 5 ? -57 : -62));
  const out = run(h, gust);
  for (const [i, o] of out.entries()) assert.ok(dbOf(o) - dbOf(gust[i]) < 1, `gust frame ${i} lifted ${(dbOf(o) - dbOf(gust[i])).toFixed(1)} dB`);
  // Hiss at −62 under −45 speech: lift capped at NOISE_CEIL_DB − floor = 7 dB.
  const h2 = new hearing.Hearing();
  const mix = [...Array.from({ length: 100 }, () => hiss(-62)), ...Array.from({ length: 50 }, () => tone(-45))];
  const o2 = run(h2, mix);
  for (const i of [120, 140, 149]) assert.ok(dbOf(o2[i]) - dbOf(mix[i]) <= -55 - -62 + 1, `lift ${(dbOf(o2[i]) - dbOf(mix[i])).toFixed(1)} dB`);
});

test("review: when Reason starts talking right after them, the lift drops to the echo cap at once", () => {
  const h = new hearing.Hearing();
  run(h, Array.from({ length: 50 }, () => hiss(-74)));
  run(h, Array.from({ length: 40 }, () => tone(-45)));
  const echo = tone(-48);
  const after = h.frame(echo, 99999, { reasonTalking: true });
  // Past the 5 ms ramp, the very first echo frame is at the cap.
  const tail = (b64) => Buffer.from(b64, "base64").subarray(40).toString("base64");
  assert.ok(dbOf(tail(after)) - dbOf(tail(echo)) <= hearing.ECHO_GAIN_DB + 0.5, `first echo frame lifted ${(dbOf(tail(after)) - dbOf(tail(echo))).toFixed(1)} dB past the ramp`);
});

test("review: a long quiet stretch with short gaps keeps its lift past three seconds", () => {
  const h = new hearing.Hearing();
  run(h, Array.from({ length: 50 }, () => hiss(-74)));
  const talk = Array.from({ length: 250 }, (_, i) => (i % 25 < 22 ? tone(-45) : hiss(-74)));
  const out = run(h, talk);
  for (const i of [150, 200, 240]) assert.ok(dbOf(out[i]) - dbOf(talk[i]) > 12, `frame ${i} lift ${(dbOf(out[i]) - dbOf(talk[i])).toFixed(1)} dB`);
});

test("levelsBetween: their speech in a window, as it came in and how much it was lifted", () => {
  const h = new hearing.Hearing();
  run(h, Array.from({ length: 50 }, () => hiss(-74)));
  for (let i = 0; i < 50; i++) h.frame(tone(-45), 1000 + i * 20);
  const lv = h.levelsBetween(1000, 2000);
  assert.ok(lv.level_db <= -44 && lv.level_db >= -46, JSON.stringify(lv));
  assert.ok(lv.boost_db >= 15, JSON.stringify(lv));
  assert.equal(h.levelsBetween(5000, 6000), null, "no speech, no numbers");
});

// ---------- on a call ----------

function fakeTimers() {
  let t = 1_000_000;
  let q = [], n = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++n; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { q = q.filter(x => x.id !== id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift(); t = next.at; next.fn();
        await new Promise(r => setImmediate(r));
      }
      t = end;
    },
  };
}
function fakeTwilio() {
  const h = { msg: [], close: [] };
  let open = true;
  return { sent: [], open: () => open, send() {}, close: () => { open = false; }, onMessage: (f) => h.msg.push(f), onClose: (f) => h.close.push(f), say: (o) => h.msg.forEach(f => f(JSON.stringify(o))) };
}
function fakeLive() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  return { sent, socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) }, open: () => h.open.forEach(f => f()), emit: (e) => h.event.forEach(f => f(e)), of: (t) => sent.filter(e => e.type === t) };
}
const ownerCall = () => db.createCall(C, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey Omari, it's Reason.", state: "placing" });

async function startCall() {
  const timers = fakeTimers(), twilio = fakeTwilio(), live = fakeLive(), finished = [];
  const row = ownerCall();
  const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain: async () => ({ text: "", tools: [], endCall: null }), now: timers.now, timers, finish: async (l) => { finished.push(l); } });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  return { call, timers, twilio, live, finished, row };
}

test("a call: the model hears their quiet words lifted; the recording keeps the line as it came", async () => {
  const { call, timers, twilio, live } = await startCall();
  const frames = [...Array.from({ length: 30 }, () => hiss(-74)), ...Array.from({ length: 40 }, () => tone(-45))];
  for (const f of frames) { twilio.say({ event: "media", media: { payload: f } }); await timers.advance(20); }
  const sent = live.of("session.input_audio.append").map(e => e.audio);
  assert.equal(sent.length, frames.length);
  assert.ok(dbOf(sent.at(-1)) > -31, `the model heard ${dbOf(sent.at(-1)).toFixed(1)} dBFS`);
  const tape = Buffer.concat(call.tape.caller);
  assert.deepEqual(tape, Buffer.concat(frames.map(f => Buffer.from(f, "base64"))), "the recording is untouched");
});

test("REASON_CALL_HEARING=off: their audio goes to the model byte for byte, as before", async () => {
  config.callHearing = false;
  const { timers, twilio, live } = await startCall();
  const frames = Array.from({ length: 40 }, () => tone(-45));
  for (const f of frames) { twilio.say({ event: "media", media: { payload: f } }); await timers.advance(20); }
  assert.deepEqual(live.of("session.input_audio.append").map(e => e.audio), frames);
});

test("turn_log: what was heard each turn, when, and how loud — on their own call row, never in the journal", async () => {
  const logs = [];
  const timers = fakeTimers(), twilio = fakeTwilio(), live = fakeLive();
  const row = ownerCall();
  new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain: async () => ({ text: "", tools: [], endCall: null }), now: timers.now, timers, log: (l) => logs.push(l), finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  live.emit({ type: "session.output_transcript.delta", delta: "Hey Omari, what's up?", start_ms: 0, end_ms: 1400 });
  await timers.advance(2000);
  for (let i = 0; i < 25; i++) { twilio.say({ event: "media", media: { payload: hiss(-74) } }); await timers.advance(20); }
  for (let i = 0; i < 60; i++) { twilio.say({ event: "media", media: { payload: tone(-45) } }); await timers.advance(20); }
  live.emit({ type: "session.input_transcript.delta", delta: " I'm in Kibi", start_ms: 2600, end_ms: 3200 });
  await timers.advance(300);
  live.emit({ type: "session.input_transcript.delta", delta: " Kibi.", start_ms: 3200, end_ms: 3700 });
  live.emit({ type: "session.output_transcript.delta", delta: "", start_ms: 9000, end_ms: 9100 });
  twilio.say({ event: "stop" });
  await timers.advance(4000);

  const fresh = db.getCall(C, row.id);
  const turns = JSON.parse(fresh.turn_log);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].who, "reason");
  assert.deepEqual(turns[0].session_ms, [0, 1400]);
  assert.equal(turns[1].who, "them");
  assert.equal(turns[1].text, "I'm in Kibi Kibi.");
  assert.deepEqual(turns[1].session_ms, [2600, 3700]);
  assert.ok(turns[1].from_s >= 3.5 && turns[1].to_s >= turns[1].from_s, JSON.stringify(turns[1]));
  assert.ok(turns[1].level_db <= -44 && turns[1].level_db >= -46, JSON.stringify(turns[1]));
  assert.ok(turns[1].boost_db >= 10, JSON.stringify(turns[1]));
  assert.ok(!JSON.stringify(logs).includes("Kibi"), "the words never reach the journal");
});

test("the retention sweep empties turn_log with the transcript; a newer call keeps it", () => {
  const old = ownerCall(), fresh = ownerCall();
  db.updateCall(C, old.id, { transcript: "Them: hi", turn_log: JSON.stringify([{ who: "them", text: "hi" }]) });
  db.updateCall(C, fresh.id, { transcript: "Them: hello", turn_log: JSON.stringify([{ who: "them", text: "hello" }]) });
  const longAgo = Date.now() - 400 * 86400_000;
  db.db.prepare("UPDATE calls SET ended_at = ?, created_at = ? WHERE id = ?").run(longAgo, longAgo, old.id);
  Object.assign(config, { keepContentDays: 30, keepRecordsDays: 0 });
  const out = privacy.sweepRetention({ now: Date.now() });
  assert.equal(db.getCall(C, old.id).turn_log, "");
  assert.equal(db.getCall(C, old.id).transcript, "");
  assert.match(db.getCall(C, fresh.id).turn_log, /hello/);
  assert.equal(out.dropped.call_turn_logs, 1);
});

// ---------- what the voice is told ----------

test("every call where the voice talks is told to ask once when a word is unclear, not to guess", () => {
  const own = gl.liveInstructions({ name: "Omari", owner: true });
  const errand = gl.lineTalkInstructions({ name: "Omari", goal: "ask about a table" });
  const stranger = gl.strangerInstructions();
  for (const p of [own, errand, stranger, gl.liveInstructions({ name: "Ama" })]) {
    assert.match(p, /sorry, you cut out — where\?/);
    assert.match(p, /at most once/);
    assert.match(p, /don't guess and don't repeat the strange word back/);
  }
});

test("the owner's own call: a friend, never a therapist", () => {
  const own = gl.liveInstructions({ name: "Omari", owner: true });
  assert.match(own, /Never sound like a therapist or a coach/);
  assert.doesNotMatch(own, /chatty|enjoy the small talk/i, "the lines that pushed it to probe are gone");
  assert.match(own, /easy, practical and short/);
  // Not on somebody else's call: they get no own-call tone lines at all.
  assert.doesNotMatch(gl.lineTalkInstructions({ name: "Omari", goal: "x" }), /therapist/);
});
