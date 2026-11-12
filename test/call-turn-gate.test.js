// The turn gate (REASON_CALL_TURN_GATE, src/calls/turngate.js; Omari 11-12): the voice's reply is held
// back while they are mid-thought. No network: the voice session, the Twilio stream and the clock are
// stand-ins (scripts/turn-gate-replay.mjs drives the real relay); every assertion reads what was sent.
//   - off: no trigger asked for, decisions ignored, the same bytes to the phone and the session as ever
//   - "not finished": the reply never reaches the phone, the voice is told to stay silent
//   - "finished": the reply goes out with nothing added
//   - no verdict in the budget, a failed decision, a refused start: exactly as with no gate
//   - owner: the operator's calls only; a business call only answers "are you a robot?"
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-turn-gate-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_CALL_TURN_GATE;

const gl = await import("../src/calls/gptlive.js");
const tg = await import("../src/calls/turngate.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const replay = await import("../scripts/turn-gate-replay.mjs");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callIdentity: false, callVoice: "gptlive", callHearing: true, lineTalk: true, callTurnGate: "off", twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" });
});

const ownCall = (conversationId = C) => db.createCall(conversationId, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey Omari, what's up?", state: "placing" });
const lineCall = (conversationId = C) => db.createCall(conversationId, { provider: "gptlive", toNumber: "+12125550199", isOwner: false, goal: "book a table for two at eight", facts: [], announcement: "", state: "placing" });
const run = (events, opts = {}) => replay.replayOne(events, { row: ownCall(), ...opts });

// The call's first exchange, then a turn of theirs that stops at 7800 ms.
const OPEN = [
  { at: 0, voice: 600 },
  { at: 1500, them: 400 },
  { at: 2300, heard: "w1", end: 1900 },
  { at: 2500, decision: "w1", finished: 0.98 },
  { at: 3000, voice: 600 },
];
const STOP = 7800;
const THEIRS = { at: 6000, them: 1800 };
/** Their words in by 8200, the verdict by 8400; the voice starts at 8600 (800 ms after their last sound). */
const turnOf = (finished, extra = []) => [...OPEN, THEIRS, { at: 8200, heard: "p1", end: STOP }, { at: 8400, decision: "p1", finished }, { at: 8600, voice: 500 }, ...extra];
const after8 = (r) => r.played.filter(ms => ms >= 8500);
const WORDS = ["turn", "said", "text", "delta", "words", "transcript"];

// ---------- off ----------

test("off (the default): no trigger is asked for, and a decision event changes nothing — the same bytes to the phone and the session", async () => {
  assert.equal(tg.turnGateSwitch(undefined), "off");
  assert.equal(tg.turnGateSwitch(""), "off");
  assert.equal(config.callTurnGate, "off", "unset in the environment is off");
  const strip = (r) => JSON.stringify([r.sentTwilio, r.live.sent, r.lines.map(({ gptlive_session, ...l }) => l)]).replace(/"gptlive_[a-z_]+":\d+/g, "").replace(/_\d+(?=[_"])/g, "");
  const withDecisions = await run(turnOf(0.02), { gate: "off" });
  const without = await run(turnOf(0.02).filter(e => !e.decision), { gate: "off" });
  assert.equal(strip(withDecisions), strip(without), "decision events are ignored entirely");
  assert.equal(withDecisions.live.sent.find(e => e.type === "session.start").session.triggers, undefined);
  assert.equal(withDecisions.call.turnGate, null);
  assert.equal(withDecisions.gate.length, 0, "no gate line is logged");
  assert.ok(after8(withDecisions).length > 0, "the 'Go on' reaches the phone, as it does today");
  assert.equal("turnGate" in gl.whoFor(ownCall()), false, "nothing added to who is on the line");
  assert.deepEqual(Object.keys(gl.sessionConfig({ name: "Omari", named: true, owner: true })), ["model", "instructions", "audio", "delegation"]);
});

// ---------- the gate ----------

test("on: the session is started with one trigger on their transcript asking only 'finished?' — question text, no call words", async () => {
  const r = await run(turnOf(0.98));
  const triggers = r.live.sent.find(e => e.type === "session.start").session.triggers;
  assert.deepEqual(triggers, [{ type: "decisions", event_type: "session.input_transcript.delta", decisions: { questions: [{ type: "predicate", name: "finished", instructions: tg.FINISHED_Q }] } }]);
});

test("not finished: the voice's 'Go on' never reaches the phone, the voice is told to stay silent, and its words come off the record", async () => {
  const events = turnOf(0.03);
  const r = await run(events);
  assert.equal(after8(r).length, 0, "not one frame of it is played");
  const told = r.live.sent.filter(e => e.type === "session.instructions.append" && e.content === tg.TURN_GATE_NOTE);
  assert.equal(told.length, 1, "told once, as an instruction (it can stop speech in progress)");
  assert.equal(told[0].at - r.zero >= 8600 && told[0].at - r.zero <= 8640, true, "at the first frame of the reply");
  const line = r.gate.find(l => l.dropped);
  assert.ok(line && line.verdict === "unfinished" && line.decision_ms === 200 && line.waited_ms === 0 && line.lead_ms === 200 && line.transcript_ms > 300, JSON.stringify(line));
});

test("not finished: the reply's words are taken back off the transcript", async () => {
  const r = await run([...turnOf(0.03), { at: 8620, said: "Sure." }, { at: 8700, said: " Go on." }]);
  assert.equal(r.gate.filter(l => l.dropped).length, 1);
  assert.ok(!r.call.turns.some(x => x.who === "reason" && /Sure|Go on/.test(x.text)), "never heard, so never written down");
  const played = await run([...turnOf(0.97), { at: 8700, said: " Go on." }]);
  assert.ok(played.call.turns.some(x => x.who === "reason" && /Go on/.test(x.text)), "a reply that was played is");
});

test("finished: the reply goes out the moment it arrives — nothing added, the same frames at the same times as with the gate off", async () => {
  const on = await run(turnOf(0.97));
  const off = await run(turnOf(0.97), { gate: "off" });
  assert.deepEqual(on.played, off.played);
  assert.ok(after8(on).length >= 24);
  const line = on.gate.at(-1);
  assert.ok(line.verdict === "finished" && line.dropped === false && line.waited_ms === 0, JSON.stringify(line));
  assert.equal(on.live.sent.filter(e => e.content === tg.TURN_GATE_NOTE).length, 0);
});

test("the verdict arrives just after the voice starts: the audio waits for it, then goes out whole (finished) or not at all (not finished)", async () => {
  const late = (p) => [...OPEN, THEIRS, { at: 8500, heard: "p1", end: STOP }, { at: 8800, decision: "p1", finished: p }, { at: 8600, voice: 500 }];
  const fin = await run(late(0.97));
  const off = await run(late(0.97), { gate: "off" });
  assert.equal(after8(fin).length, after8(off).length, "every frame of it is played");
  const added = after8(fin)[0] - after8(off)[0];
  assert.ok(added >= 160 && added <= 220, `about 200 ms later, when the verdict came: ${added}`);
  assert.equal(fin.gate.at(-1).waited_ms, 200);
  const mid = await run(late(0.03));
  // "Not finished" stands once no newer piece has followed for UNFINISHED_SETTLE_MS (in case the next one finishes the sentence).
  assert.equal(after8(mid).length, 0);
  assert.ok(mid.gate.at(-1).dropped && mid.gate.at(-1).waited_ms <= tg.TURN_GATE_BUDGET_MS, JSON.stringify(mid.gate.at(-1)));
});

test("'not finished' about the first half of a sentence never holds the reply to the whole of it", async () => {
  // The piece that came in covers their words only up to 600 ms before they stopped; the last piece is late.
  const r = await run([...OPEN, THEIRS, { at: 8000, heard: "p1", end: STOP - 600 }, { at: 8200, decision: "p1", finished: 0.02 }, { at: 8600, voice: 500 }, { at: 9000, heard: "p2", end: STOP }, { at: 9200, decision: "p2", finished: 0.97 }]);
  assert.ok(after8(r).length >= 24, "played");
  const line = r.gate.at(-1);
  assert.ok(line.verdict === "finished" || line.verdict === "none", JSON.stringify(line));
  assert.equal(r.gate.some(l => l.dropped), false);
});

// ---------- fail open ----------

test("fail open: no verdict inside the budget and the reply goes out exactly as it would have, at most 500 ms late", async () => {
  const events = [...OPEN, THEIRS, { at: 8200, heard: "p1", end: STOP }, { at: 8600, voice: 500 }]; // the decision never comes
  const on = await run(events);
  const off = await run(events, { gate: "off" });
  assert.equal(after8(on).length, after8(off).length, "all of it is played");
  const added = after8(on)[0] - after8(off)[0];
  assert.ok(added > 0 && added <= tg.TURN_GATE_BUDGET_MS + 40, `added ${added} ms`);
  const line = on.gate.at(-1);
  assert.ok(line.verdict === "none" && line.dropped === false && line.decision_ms === null && line.waited_ms <= tg.TURN_GATE_BUDGET_MS + 40, JSON.stringify(line));
  assert.equal(on.live.sent.filter(e => e.content === tg.TURN_GATE_NOTE).length, 0);
});

test("fail open: a transcript that is late (the 2.7 s one) is the same — the budget, then the reply", async () => {
  const events = [...OPEN, THEIRS, { at: 8600, voice: 500 }, { at: STOP + 2700, heard: "p1", end: STOP }, { at: STOP + 2900, decision: "p1", finished: 0.02 }];
  const on = await run(events);
  const off = await run(events, { gate: "off" });
  assert.equal(after8(on).length, after8(off).length);
  assert.ok(after8(on)[0] - after8(off)[0] <= tg.TURN_GATE_BUDGET_MS + 40);
  assert.equal(on.gate.some(l => l.dropped), false, "a verdict after the reply has played takes nothing back");
});

test("fail open: a failed or refused decision is no verdict — the reply goes out at once", async () => {
  const failed = await run([...OPEN, THEIRS, { at: 8200, heard: "p1", end: STOP }, { at: 8400, decision: "p1", failed: true }, { at: 8600, voice: 500 }]);
  const off = await run(turnOf(0.5), { gate: "off" });
  assert.deepEqual(after8(failed), after8(off));
  assert.ok(failed.gate.at(-1).verdict === "open" && failed.gate.at(-1).why === "error", JSON.stringify(failed.gate.at(-1)));
  const g = new tg.TurnGate();
  g.heard("a", 100, 900);
  g.decided({ type: "decision.event", source_event_type: tg.INPUT_DELTA, source_event_id: "a", event: { type: "decision.completed", decision: { answers: [{ type: "refusal", name: "finished" }] } } }, 300);
  assert.equal(g.read(400, { speechAt: 50, speechMs: 900 }).state, "open");
});

test("fail open: decisions that never answer cost nothing — the first reply does not wait, and after three misses none does", async () => {
  const none = [{ at: 0, voice: 600 }, { at: 1500, them: 400 }, { at: 2300, heard: "w1", end: 1900 }, { at: 3000, voice: 600 }];
  const on = await run(none);
  const off = await run(none, { gate: "off" });
  assert.deepEqual(on.played, off.played, "no decision has ever come: no waiting on one");
  assert.equal(on.gate.at(-1).why, "decisions quiet");
  // One answered, then nothing for three replies running.
  const turns = [...OPEN];
  for (let i = 0; i < 4; i++) { const t0 = 6000 + i * 4000; turns.push({ at: t0, them: 1000 }, { at: t0 + 1400, heard: `q${i}`, end: t0 + 1000 }, { at: t0 + 1800, voice: 400 }); }
  const r = await run(turns);
  const waits = r.gate.slice(-4).map(l => l.waited_ms);
  assert.ok(waits[0] > 0 && waits[1] > 0 && waits[2] > 0 && waits[3] === 0, JSON.stringify(waits));
});

test("fail open: a session.start the server refuses with the trigger in it is sent again without it, and the call has no gate", async () => {
  const r = await run(turnOf(0.02), { beforeStart: (emit) => emit({ type: "error", error: { code: "invalid_request", message: "unknown field triggers" } }) });
  const starts = r.live.sent.filter(e => e.type === "session.start");
  assert.equal(starts.length, 2);
  assert.ok(starts[0].session.triggers && !("triggers" in starts[1].session));
  const { triggers, ...first } = starts[0].session;
  assert.deepEqual(starts[1].session, first, "the same start, less the trigger");
  assert.equal(r.call.turnGate, null);
  assert.ok(after8(r).length > 0, "and the call behaves as it does today");
  assert.ok(r.lines.some(l => l.gptlive_turn_gate_off != null));
});

// ---------- after a held reply ----------

test("after a held reply: they go quiet for 3 s and a few words are welcome — asked once, and that reply is not held", async () => {
  const r = await run([...turnOf(0.03), { at: 12200, voice: 500 }], { until: 14000 });
  const nudges = r.live.sent.filter(e => e.type === "session.commentary.append" && e.content === tg.TURN_GATE_QUIET_NUDGE);
  assert.equal(nudges.length, 1);
  const ms = nudges[0].at - r.zero;
  assert.ok(ms >= STOP + tg.TURN_GATE_QUIET_MS && ms <= STOP + tg.TURN_GATE_QUIET_MS + 400, `asked at ${ms}`);
  assert.ok(r.played.some(x => x >= 12200), "what it says then reaches the phone");
  assert.equal(r.gate.filter(l => l.dropped).length, 1);
});

test("after a held reply: they carry on and finish — nothing is asked while they talk, and the answer to the whole thought plays", async () => {
  const r = await run([...turnOf(0.03), { at: 9800, them: 1400 }, { at: 11600, heard: "p2", end: 11200 }, { at: 11800, decision: "p2", finished: 0.98 }, { at: 12000, voice: 800 }], { until: 14000 });
  assert.equal(after8(r).filter(ms => ms < 11900).length, 0, "nothing over them");
  assert.ok(r.played.filter(ms => ms >= 12000).length >= 39, "the reply to the finished thought goes out");
  assert.equal(r.live.sent.filter(e => e.content === tg.TURN_GATE_QUIET_NUDGE).length, 0);
  assert.equal(r.gate.filter(l => l.dropped).length, 1);
});

test("the same words are never held twice", () => {
  const g = new tg.TurnGate();
  g.heard("a", 1000, 900);
  g.decided({ type: "decision.event", source_event_id: "a", event: { type: "decision.completed", decision: { answers: [{ type: "predicate", name: "finished", probability: 0.1 }] } } }, 1200);
  const at = { speechAt: 800, speechMs: 900 };
  assert.equal(g.read(1250, at).state, "wait", "too fresh to stand: the next piece may finish the sentence");
  assert.equal(g.read(1400, at).state, "unfinished");
  g.dropped(g.read(1400, at).seq);
  assert.equal(g.read(1500, at).state, "open");
});

// ---------- the bookkeeping ----------

test("verdicts: only the newest words' counts, whatever order results arrive in; an unknown source is taken as the newest", () => {
  const ev = (id, p) => ({ type: "decision.event", delegation_id: null, source_event_type: tg.INPUT_DELTA, source_event_id: id, event: { type: "decision.completed", decision: { answers: [{ type: "predicate", name: "finished", probability: p }] } } });
  const g = new tg.TurnGate();
  const at = { speechAt: 900, speechMs: 2000 };
  assert.equal(g.decided(ev("a", 0.9), 10), null, "nothing heard yet");
  g.heard("a", 1000, 1500);
  g.heard("b", 1300, 2000);
  assert.equal(g.read(1400, at).state, "wait");
  assert.ok(g.decided(ev("b", 0.9), 1500));
  assert.equal(g.decided(ev("a", 0.1), 1550), null, "an older piece's result, arriving late, is dropped");
  assert.equal(g.read(1600, at).state, "finished");
  g.heard("c", 2000, 2600);
  assert.equal(g.read(2100, { speechAt: 1900, speechMs: 2600 }).state, "wait", "newer words, no verdict on them yet");
  const v = g.decided(ev("combined_9", 0.2), 2200);
  assert.ok(v && v.matched === false && v.seq === 3);
  assert.equal(g.decided({ ...ev("c", 0.9), delegation_id: "del_1" }, 2300), null, "a delegation's decision is not the trigger's");
  assert.equal(g.decided({ ...ev("c", 0.9), source_event_type: "session.output_transcript.delta" }, 2300), null);
  assert.equal(g.decided({ type: "decision.event", source_event_id: "c", event: { type: "decision.created" } }, 2300), null, "not final");
  // Without timing on the pieces nothing says which words a verdict covers: no gate.
  const bare = new tg.TurnGate();
  bare.heard("a", 1000);
  bare.decided(ev("a", 0.1), 1200);
  assert.equal(bare.read(2000, at).state, "open");
});

test("the log: one line per gated turn, numbers only — never a word of the call", async () => {
  const r = await run(turnOf(0.03));
  for (const l of r.gate) {
    const { at, ...line } = l;
    for (const [k, v] of Object.entries(line)) {
      assert.ok(["gptlive_turn_gate", "verdict", "why", "decision_ms", "transcript_ms", "lead_ms", "waited_ms", "dropped", "p", "matched", "observe"].includes(k), k);
      if (typeof v === "string") assert.ok(["finished", "unfinished", "none", "open", "wait", "error", "held once", "decisions quiet", "no timeline", "no transcript", "no decision", "settling"].includes(v), v);
    }
    assert.ok(!WORDS.some(w => w in line));
  }
  assert.equal(r.gate.length, 2, "one for the first exchange's reply, one for the held one");
});

// ---------- scope ----------

test("owner: the operator's calls only; on: everyone's; a puppet line or a stranger: never", () => {
  config.callTurnGate = "owner";
  assert.equal(tg.turnGateFor(ownCall(C)), "own");
  assert.equal(tg.turnGateFor(ownCall(OTHER)), "", "somebody else's call with their Reason is untouched");
  assert.equal(tg.turnGateFor(lineCall(C)), "line");
  assert.equal(tg.turnGateFor(lineCall(OTHER)), "");
  assert.equal(gl.sessionConfig(gl.whoFor(ownCall(OTHER))).triggers, undefined);
  assert.equal(gl.sessionConfig(gl.whoFor(ownCall(C))).triggers.length, 1);
  config.callTurnGate = "on";
  assert.equal(tg.turnGateFor(ownCall(OTHER)), "own");
  assert.equal(tg.turnGateFor(lineCall(OTHER)), "line");
  assert.equal(tg.turnGateFor({ ...lineCall(C), direction: "in" }), "", "a place ringing back is spoken to by code");
  assert.equal(tg.turnGateFor({ id: "stranger:1", conversation_id: "", is_owner: 0 }), "");
  config.lineTalk = false;
  assert.equal(tg.turnGateFor(lineCall(C)), "");
  config.callTurnGate = "off";
  assert.equal(tg.turnGateFor(ownCall(C)), "");
  for (const v of ["on", "1", "true", "everyone"]) assert.equal(tg.turnGateSwitch(v), "on");
  for (const v of ["off", "0", "", "nope", undefined]) assert.equal(tg.turnGateSwitch(v), "off");
});

test("owner: somebody else's call runs with no gate at all", async () => {
  const r = await replay.replayOne(turnOf(0.02), { gate: "owner", row: ownCall(OTHER) });
  assert.equal(r.call.turnGate, null);
  assert.ok(after8(r).length > 0);
  const mine = await replay.replayOne(turnOf(0.02), { gate: "owner", row: ownCall(C) });
  assert.equal(after8(mine).length, 0);
});

// ---------- a business call ----------

test("a business call: the trigger also asks 'are they asking if this is a machine, or who is calling?', and Reason answers honestly at once", async () => {
  const ask = (asks, at = 8400) => ({ at, decision: "p1", finished: 0.9, asks });
  const talking = (call) => { call.talking = true; };
  const r = await replay.replayOne([...OPEN, THEIRS, { at: 8200, heard: "p1", end: STOP }, ask("asks_ai"), { at: 8450, heard: "p2", end: STOP }, { at: 8600, decision: "p2", finished: 0.9, asks: "asks_ai" }], { row: lineCall(), setup: talking });
  const qs = r.live.sent.find(e => e.type === "session.start").session.triggers[0].decisions.questions;
  assert.deepEqual(qs.map(q => q.name), ["finished", "asks"]);
  assert.deepEqual(qs[1].choices.map(c => c.value), ["asks_ai", "asks_who", "neither"]);
  const told = r.live.sent.filter(e => e.type === "session.instructions.append" && /^They just asked/.test(e.content));
  assert.equal(told.length, 1, "once per question, not once per piece of it");
  assert.match(told[0].content, /"I'm an AI assistant calling for Omari\."/);
  assert.match(told[0].content, /Never say or imply you are human/);
  assert.equal(told[0].at - r.zero, 8400, "the moment the decision arrives");
  assert.ok(r.lines.some(l => l.gptlive_turn_gate_asked != null && l.asks === "asks_ai" && l.decision_ms === 200));

  const who = await replay.replayOne([...OPEN, THEIRS, { at: 8200, heard: "p1", end: STOP }, ask("asks_who")], { row: lineCall(), setup: talking });
  assert.match(who.live.sent.find(e => /^They just asked who is calling/.test(e.content ?? "")).content, /"I'm an AI assistant calling for Omari\."/);
  assert.match(tg.honestAnswerNote("asks_who", "Omari Nyarko"), /never say you are Omari,/);
  assert.match(tg.honestAnswerNote("asks_ai", ""), /"I'm an AI assistant\."/);

  const neither = await replay.replayOne([...OPEN, THEIRS, { at: 8200, heard: "p1", end: STOP }, ask("neither")], { row: lineCall(), setup: talking });
  assert.equal(neither.live.sent.some(e => /^They just asked/.test(e.content ?? "")), false);
});

test("a business call: 'not finished' is only logged — nothing of Reason's is held on a business line", async () => {
  const talking = (call) => { call.talking = true; };
  const on = await replay.replayOne(turnOf(0.02), { row: lineCall(), setup: talking });
  const off = await replay.replayOne(turnOf(0.02), { row: lineCall(), setup: talking, gate: "off" });
  assert.deepEqual(on.played, off.played);
  assert.equal(on.live.sent.some(e => e.content === tg.TURN_GATE_NOTE), false);
  assert.ok(on.gate.length > 0 && on.gate.every(l => l.observe === true && l.dropped === false));
});

// ---------- the replay ----------

test("the replay harness: with the transcript close behind, mid-thought pauses are held and finished thoughts are not", async () => {
  const fast = await replay.scenario([300, 800], { n: 20, seed: 3 });
  assert.ok(fast.mid.kept >= 16, JSON.stringify(fast.mid));
  assert.ok(fast.finished.played >= 18, JSON.stringify(fast.finished));
  assert.ok(Math.max(...fast.finished.delays) <= tg.TURN_GATE_BUDGET_MS + 40);
  // The late transcript: the gate does nothing, and nothing is lost but the budget.
  const late = await replay.scenario([1500, 2700], { n: 10, seed: 3 });
  assert.equal(late.finished.played, 10);
  assert.equal(late.mid.kept, 0);
  assert.match(replay.render({ fast }), /kept off the phone/);
});
