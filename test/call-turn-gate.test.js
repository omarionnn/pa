// The turn gate (REASON_CALL_TURN_GATE, src/calls/turngate.js; Omari 11-12): on their own call Reason
// listens like a person — a short acknowledgement in a mid-thought pause, a real answer when the
// thought is finished. No network: the voice session, the Twilio stream and the clock are stand-ins
// (scripts/turn-gate-replay.mjs drives the real relay); every assertion reads what was sent.
//   - off: no trigger, no new prompt lines, decisions ignored, the same bytes to the phone and the session
//   - mid-thought: a short sound of the voice's plays in the pause; never on their words; cut if they
//     carry on; not the same one twice; one per ~8 s of their talking; asked for when the voice gave none;
//     a full reply to half a thought is not played (the acknowledgement is asked for instead)
//   - finished: the reply goes out with nothing added, the long-turn wait is skipped, "go on" gets "answer"
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

// The call's first exchange, then a turn of theirs: 3 s of talking that stops at 9000 ms.
const OPEN = [
  { at: 0, voice: 600 },
  { at: 1500, them: 400 },
  { at: 2300, heard: "w1", end: 1900 },
  { at: 2500, decision: "w1", finished: 0.98 },
  { at: 3000, voice: 600 },
];
const STOP = 9000;
const THEIRS = { at: 6000, them: 3000 };
/** Their words in by 9300 and the verdict by 9400: before anything the voice does about them. */
const said = (finished, extra = [], theirs = THEIRS) => [...OPEN, theirs, { at: 9300, heard: "p1", end: STOP }, { at: 9400, decision: "p1", finished }, ...extra];
const mid = (extra, theirs) => said(0.03, extra, theirs);
const fin = (extra, theirs) => said(0.97, extra, theirs);
/** The voice's own short sound, and a full reply, starting `at`. */
const ack = (at, words = "Mm-hm.") => [{ at, voice: 400, own: true }, { at: at + 100, said: words, own: true }];
const reply = (at, words = "Sure, I can do that for you now.") => [{ at, voice: 1800, own: true }, { at: at + 200, said: words, own: true }];
const heardIn = (r, from, to = Infinity) => r.heard.filter(ms => ms >= from && ms < to);
const notes = (r, type, test) => r.live.sent.filter(e => e.type === type && test(String(e.content ?? "")));
const asks = (r) => notes(r, "session.instructions.append", c => /say only "/.test(c));
const acked = (r) => r.gate.filter(l => l.ack === "played");

// ---------- off ----------

test("off (the default): no trigger, no new prompt lines, and a decision event changes nothing — the same bytes to the phone and the session", async () => {
  assert.equal(tg.turnGateSwitch(undefined), "off");
  assert.equal(config.callTurnGate, "off", "unset in the environment is off");
  const strip = (r) => JSON.stringify([r.sentTwilio, r.live.sent, r.lines.map(({ gptlive_session, ...l }) => l)]).replace(/"gptlive_[a-z_]+":\d+/g, "").replace(/_\d+(?=[_"])/g, "");
  const withDecisions = await run(mid(ack(9500)), { gate: "off" });
  const without = await run(mid(ack(9500)).filter(e => !e.decision), { gate: "off" });
  assert.equal(strip(withDecisions), strip(without), "decision events are ignored entirely");
  assert.equal(withDecisions.live.sent.find(e => e.type === "session.start").session.triggers, undefined);
  assert.equal(withDecisions.call.turnGate, null);
  assert.equal(withDecisions.gate.length, 0, "no gate line is logged");
  assert.equal(asks(withDecisions).length, 0, "nothing is asked of the voice");
  assert.equal("turnGate" in gl.whoFor(ownCall()), false, "nothing added to who is on the line");
  assert.deepEqual(Object.keys(gl.sessionConfig({ name: "Omari", named: true, owner: true })), ["model", "instructions", "audio", "delegation"]);
  const before = gl.liveInstructions({ name: "Omari", named: true, owner: true, carry: true });
  assert.match(before, /say NOTHING/, "the line that forbids every listening sound stands");
  assert.doesNotMatch(before, /small sign that you're there/);
  assert.equal(gl.liveInstructions({ name: "Omari", named: true, owner: true, carry: true, turnGate: "" }), before);
  assert.equal(gl.liveInstructions({ name: "Omari", named: true, owner: true, carry: true, turnGate: "line" }), before, "and a business call's gate changes no own-call words");
});

// ---------- what the voice is told ----------

test("on: the session is started with one trigger asking only 'finished?', and the voice is allowed brief, varied acknowledgements", async () => {
  const r = await run(fin([{ at: 9800, voice: 500 }]));
  const start = r.live.sent.find(e => e.type === "session.start").session;
  assert.deepEqual(start.triggers, [{ type: "decisions", event_type: "session.input_transcript.delta", decisions: { questions: [{ type: "predicate", name: "finished", instructions: tg.FINISHED_Q }] } }]);
  assert.match(start.instructions, /a small sign that you're there is welcome, now and then/);
  assert.match(start.instructions, /never the same one twice running, and not at every pause/);
  assert.match(start.instructions, /no content, no question/);
  assert.match(start.instructions, /"Go on" is never an answer to a finished thought/);
  const withCarry = gl.liveInstructions({ name: "Omari", named: true, owner: true, carry: true, turnGate: "own" });
  assert.doesNotMatch(withCarry, /say NOTHING/, "the line that forbade them gives way");
  // #509's rule stays, once: "what did you say?" means say the last real question again.
  assert.equal(withCarry.match(/they did not catch (?:YOU|you)/g).length, 1);
  assert.match(withCarry, /Never answer that with "go on"/);
  assert.equal(gl.liveInstructions({ name: "Omari", named: true, owner: true, turnGate: "own" }).match(/they did not catch you/g).length, 1, "and is there with carry-over off too");
  config.callTurnGate = "on";
  assert.match(gl.voiceInstructionsFor(lineCall()), /No listening sounds/, "a business call keeps its own rule");
  assert.doesNotMatch(gl.voiceInstructionsFor(lineCall()), /small sign that you're there/);
});

// ---------- a mid-thought pause ----------

test("mid-thought: the voice's short 'Mm-hm' plays, whole, in the pause — a real pause, not a breath", async () => {
  const r = await run(mid(ack(9500)), { react: 0 });
  const got = heardIn(r, STOP);
  assert.ok(got.length >= 18 && got.length <= 22, `the whole of it: ${got.length} frames`);
  assert.ok(got[0] >= STOP + tg.ACK_PAUSE_MS, `at ${got[0] - STOP} ms into the pause`);
  const line = acked(r)[0];
  assert.ok(line && line.verdict === "unfinished" && line.dropped === false && line.pause_ms >= tg.ACK_PAUSE_MS && line.speech_ms === 400 && !line.prompted, JSON.stringify(line));
  assert.equal(asks(r).length, 0, "it gave one itself: none is asked for");
  assert.ok(r.call.turns.some(x => x.who === "reason" && /Mm-hm/.test(x.text)), "and it is on the record: it was heard");
});

test("mid-thought: an acknowledgement that would land on their words is never heard — they carried on", async () => {
  const r = await run(mid([...ack(9500), { at: 9800, them: 1500 }]), { react: 0 });
  assert.equal(heardIn(r, STOP).length, 0);
  assert.ok(r.gate.some(l => l.ack === "they carried on" && l.dropped), JSON.stringify(r.gate));
  assert.ok(!r.call.turns.some(x => x.who === "reason" && /Mm-hm/.test(x.text)), "never heard, so not written down");
  assert.equal(notes(r, "session.thinking.append", c => /did not hear/.test(c)).length, 0, "and nothing is made of it");
});

test("mid-thought: a breath is not a pause — nothing plays before 650 ms of quiet, however early the voice starts", async () => {
  const r = await run(mid([{ at: 9020, voice: 200, own: true }, { at: 9300, heard: "p0", end: STOP }, { at: 9320, decision: "p0", finished: 0.03 }]), { react: 0 });
  const got = heardIn(r, STOP);
  // (Their last sound is a frame before STOP.)
  assert.ok(got.length > 0 && got[0] >= STOP - 20 + tg.ACK_PAUSE_MS && got[0] <= STOP + tg.ACK_PAUSE_MS + 60, JSON.stringify(got.slice(0, 3)));
});

test("mid-thought: if they speak while it plays it is cut at once and never said again", async () => {
  const r = await run(mid([...ack(9500), { at: 10340, them: 1500 }]), { react: 0 });
  const got = heardIn(r, STOP);
  assert.ok(got.length > 0 && got[0] < 10340, "it had begun");
  assert.ok(got.at(-1) < 10340 + 80, `nothing of it after they spoke: last frame at ${got.at(-1)}`);
  assert.ok(r.sentTwilio.some(m => m.event === "clear" && m.at - r.zero >= 10340 && m.at - r.zero <= 10400));
  assert.ok(r.lines.some(l => l.gptlive_turn_gate_ack_cut != null));
  assert.equal(heardIn(r, 10500).length, 0, "and it is not started again");
});

test("mid-thought: now and then — one per 8 s of their talking, never two without them speaking in between, never the same one twice", async () => {
  const more = (at, ms, id, voiceAt, words) => [{ at, them: ms }, { at: at + ms + 300, heard: id, end: at + ms }, { at: at + ms + 400, decision: id, finished: 0.03 }, ...ack(voiceAt, words)];
  // "Mm-hm" (played) … 2 s more talking … "Yeah" (too soon) … 7 s more … "Mm-hm" again (the same) / "Yeah" (played).
  const base = [...mid(ack(9500)), ...more(10600, 2000, "p2", 13100, "Yeah.")];
  const again = await run([...base, ...more(14200, 7000, "p3", 21700, "Mm-hm.")], { react: 0 });
  assert.equal(heardIn(again, STOP, 10600).length > 0, true, "the first is heard");
  assert.equal(heardIn(again, 12600, 14200).length, 0, "the second, 2 s of talking later, is not");
  assert.ok(again.gate.some(l => l.ack === "not due"));
  assert.equal(heardIn(again, 21200).length, 0, "the same one twice running is not heard");
  assert.ok(again.gate.some(l => l.ack === "same as the last"));
  const varied = await run([...base, ...more(14200, 7000, "p3", 21700, "Yeah.")], { react: 0 });
  assert.ok(heardIn(varied, 21200).length >= 18, "a different one, 9 s of talking on, is");
  assert.equal(acked(varied).length, 2);
  // Never before they have said much at all.
  const short = await run(mid(ack(9500), { at: 7500, them: 1500 }), { react: 0 });
  assert.equal(heardIn(short, STOP).length, 0);
});

test("mid-thought: the voice gives no sign of its own — it is asked for one, once, and that one plays without being kept waiting", async () => {
  const r = await run(mid([]));
  const asked = asks(r);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].content, tg.ackPromptNote("Mm-hm."));
  assert.ok(Math.abs(asked[0].at - r.zero - (STOP + tg.ACK_PROMPT_AFTER_MS)) <= 20, `asked ${asked[0].at - r.zero - STOP} ms into the pause`);
  const got = heardIn(r, STOP);
  assert.ok(got.length >= 18 && got.length <= 22 && got[0] - (asked[0].at - r.zero) <= 660, `heard ${got.length} frames from ${got[0]}`);
  assert.ok(acked(r)[0].prompted === true);
  // Not when the thought is finished, when there is no verdict, or when one is not due.
  assert.equal(asks(await run(fin([]))).length, 0);
  assert.equal(asks(await run(mid([]).filter(e => e.decision !== "p1"))).length, 0);
  assert.equal(asks(await run(mid([], { at: 7500, them: 1500 }))).length, 0);
});

test("mid-thought: an asked-for acknowledgement that turns into a speech is cut at 1.2 s; one that arrives after they carried on is not played", async () => {
  const long = await run(mid([{ at: 10300, voice: 3000 }]), { react: 0 });
  const got = heardIn(long, STOP);
  assert.ok(got.length > 0 && got.length <= tg.ACK_MAX_SPEECH_MS / 20 + 2, `${got.length} frames`);
  assert.ok(long.sentTwilio.some(m => m.event === "clear"));
  const late = await run(mid([{ at: 10000, them: 2000 }]), { react: 900 });
  assert.equal(asks(late).length, 1);
  assert.equal(heardIn(late, STOP, 12600).length, 0, "they had carried on by the time it came");
});

test("mid-thought: a full reply to half a thought is not played — the voice is told, and says the short acknowledgement instead", async () => {
  const r = await run(mid(reply(9500)));
  const told = notes(r, "session.instructions.append", c => /^They paused in the middle of a thought/.test(c));
  assert.equal(told.length, 1);
  assert.equal(told[0].content, tg.heldNote("Mm-hm."));
  assert.ok(told[0].at - r.zero <= 9500 + 400, "as soon as its words show it is a reply, not 1.2 s in");
  const got = heardIn(r, STOP);
  assert.ok(got.length >= 18 && got.length <= 22, `only the acknowledgement is heard: ${got.length} frames`);
  assert.ok(got[0] >= told[0].at - r.zero + 600);
  assert.ok(!r.call.turns.some(x => x.who === "reason" && /Sure, I can/.test(x.text)), "the reply's words were never said, so never written down");
  assert.ok(r.gate.some(l => l.dropped && l.verdict === "unfinished" && l.prompted));
  // No words yet (the transcript trails): it is a reply once it has run past 1.2 s of speech.
  const wordless = await run(mid([{ at: 9500, voice: 1800, own: true }]));
  assert.equal(heardIn(wordless, STOP, 10700).length, 0);
  assert.equal(notes(wordless, "session.instructions.append", c => /^They paused in the middle/.test(c)).length, 1);
  // With no acknowledgement due (they had barely begun): told to say nothing.
  const quiet = await run(mid(reply(9500), { at: 7500, them: 1500 }), { until: 11500 });
  assert.equal(notes(quiet, "session.instructions.append", c => c === tg.heldNote("")).length, 1);
  assert.equal(heardIn(quiet, STOP).length, 0);
});

// ---------- a finished thought ----------

test("finished: the reply goes out the moment it arrives — nothing added, the same frames at the same times as with the gate off", async () => {
  const on = await run(fin([{ at: 9800, voice: 500 }]));
  const off = await run(fin([{ at: 9800, voice: 500 }]), { gate: "off" });
  assert.deepEqual(on.played, off.played);
  assert.ok(heardIn(on, STOP).length >= 24);
  const line = on.gate.at(-1);
  assert.ok(line.verdict === "finished" && line.dropped === false && line.waited_ms === 0 && !line.ack, JSON.stringify(line));
  assert.equal(asks(on).length, 0);
});

test("finished: 'Go on' is not an answer — the voice is told so, once, and to answer; a real short answer is left alone", async () => {
  const r = await run(fin([{ at: 9800, voice: 400 }, { at: 9900, said: "Go on." }]), { until: 13500 });
  const told = notes(r, "session.commentary.append", c => c === tg.ANSWER_NUDGE);
  assert.equal(told.length, 1);
  assert.ok(told[0].at - r.zero >= 11000 && told[0].at - r.zero <= 12000, `at ${told[0].at - r.zero}`);
  assert.match(tg.ANSWER_NUDGE, /say your last real sentence or question again/, "#509: 'what did you say?' is answered by repeating, never 'go on'");
  for (const words of ["Okay.", "Yeah, six works.", "Go on then, book it for seven."]) {
    const ok = await run(fin([{ at: 9800, voice: 400 }, { at: 9900, said: words }]), { until: 13500 });
    assert.equal(notes(ok, "session.commentary.append", c => c === tg.ANSWER_NUDGE).length, 0, words);
  }
  for (const w of ["Go on.", "Mm-hm.", "I'm with you, keep going.", "mhm", "Uh-huh."]) assert.ok(tg.CONTINUER.test(w), w);
  for (const w of ["Okay.", "Yeah.", "Go on then, book it.", "Right, seven it is."]) assert.ok(!tg.CONTINUER.test(w), w);
});

test("finished after a long stretch of talking: the reply does not wait out the 1.5 s long-turn quiet; with no verdict that wait stands", async () => {
  config.callCarryover = "on";
  try {
    const long = { at: 6000, them: 9000 };
    const end = 15000;
    const turn = (decided) => [...OPEN, long, { at: end + 100, heard: "p1", end }, ...(decided ? [{ at: end + 150, decision: "p1", finished: 0.97 }] : []), { at: end + 200, voice: 600 }];
    const on = await run(turn(true));
    const off = await run(turn(true), { gate: "off" });
    const blind = await run(turn(false));
    assert.ok(heardIn(off, end)[0] >= end - 20 + gl.LONG_TURN_QUIET_MS, `today: ${heardIn(off, end)[0] - end} ms`);
    assert.ok(heardIn(on, end)[0] <= end + gl.TALKOVER_QUIET_MS + 60, `with a finished verdict: ${heardIn(on, end)[0] - end} ms`);
    const waited = heardIn(blind, end)[0] - heardIn(off, end)[0];
    assert.ok(waited >= 0 && waited <= tg.TURN_GATE_BUDGET_MS + 40, `no verdict: the long wait stands (+${waited} ms)`);
  } finally { config.callCarryover = "off"; }
});

test("the verdict arrives just after the voice starts: the audio waits for it, then goes out whole (finished) or not at all (a reply to half a thought)", async () => {
  const late = (p, voice) => [...OPEN, THEIRS, { at: 9700, heard: "p1", end: STOP }, { at: 10000, decision: "p1", finished: p }, ...voice];
  const on = await run(late(0.97, [{ at: 9800, voice: 500 }]));
  const off = await run(late(0.97, [{ at: 9800, voice: 500 }]), { gate: "off" });
  assert.equal(heardIn(on, STOP).length, heardIn(off, STOP).length, "every frame of it is played");
  const added = heardIn(on, STOP)[0] - heardIn(off, STOP)[0];
  assert.ok(added >= 160 && added <= 220, `about 200 ms later, when the verdict came: ${added}`);
  assert.equal(on.gate.at(-1).waited_ms, 200);
  const held = await run(late(0.03, reply(9800)), { react: 0 });
  assert.equal(heardIn(held, STOP).length, 0);
  assert.ok(held.gate.at(-1).dropped && held.gate.at(-1).waited_ms <= tg.TURN_GATE_BUDGET_MS, JSON.stringify(held.gate.at(-1)));
});

test("'not finished' about the first half of a sentence never holds the reply to the whole of it", async () => {
  // The piece that came in covers their words only up to 600 ms before they stopped; the last piece is late.
  const r = await run([...OPEN, THEIRS, { at: 9200, heard: "p1", end: STOP - 600 }, { at: 9400, decision: "p1", finished: 0.02 }, ...reply(9800), { at: 10400, heard: "p2", end: STOP }, { at: 10600, decision: "p2", finished: 0.97 }], { react: 0 });
  assert.ok(heardIn(r, STOP).length >= 80, "played");
  assert.equal(r.gate.some(l => l.dropped), false);
  assert.equal(asks(r).length, 0);
});

// ---------- fail open ----------

test("fail open: no verdict inside the budget and the reply goes out exactly as it would have, at most 500 ms late; nothing is asked", async () => {
  const events = [...OPEN, THEIRS, { at: 9400, heard: "p1", end: STOP }, ...reply(9800)]; // the decision never comes
  const on = await run(events);
  const off = await run(events, { gate: "off" });
  assert.equal(heardIn(on, STOP).length, heardIn(off, STOP).length, "all of it is played");
  const added = heardIn(on, STOP)[0] - heardIn(off, STOP)[0];
  assert.ok(added > 0 && added <= tg.TURN_GATE_BUDGET_MS + 40, `added ${added} ms`);
  const line = on.gate.at(-1);
  assert.ok(line.verdict === "none" && line.dropped === false && line.decision_ms === null && line.waited_ms <= tg.TURN_GATE_BUDGET_MS + 40, JSON.stringify(line));
  assert.equal(on.live.sent.filter(e => e.type !== "session.start" && e.type !== "session.input_audio.append").length, off.live.sent.filter(e => e.type !== "session.start" && e.type !== "session.input_audio.append").length, "the session is told nothing it is not told today");
});

test("fail open: a transcript that is late (the 2.7 s one) is the same — the budget, then the reply", async () => {
  const events = [...OPEN, THEIRS, ...reply(9800), { at: STOP + 2700, heard: "p1", end: STOP }, { at: STOP + 2900, decision: "p1", finished: 0.02 }];
  const on = await run(events, { react: 0 });
  const off = await run(events, { gate: "off" });
  assert.equal(heardIn(on, STOP).length, heardIn(off, STOP).length);
  assert.ok(heardIn(on, STOP)[0] - heardIn(off, STOP)[0] <= tg.TURN_GATE_BUDGET_MS + 40);
  assert.equal(on.gate.some(l => l.dropped), false, "a verdict after the reply has played takes nothing back");
});

test("fail open: a failed or refused decision is no verdict — the reply goes out at once", async () => {
  const failed = await run([...OPEN, THEIRS, { at: 9300, heard: "p1", end: STOP }, { at: 9400, decision: "p1", failed: true }, ...reply(9800)]);
  const off = await run(mid(reply(9800)), { gate: "off" });
  assert.deepEqual(heardIn(failed, STOP), heardIn(off, STOP));
  assert.ok(failed.gate.at(-1).verdict === "open" && failed.gate.at(-1).why === "error", JSON.stringify(failed.gate.at(-1)));
  assert.equal(asks(failed).length, 0);
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
  // One answered, then nothing for four replies running.
  const turns = [...OPEN];
  for (let i = 0; i < 4; i++) { const t0 = 6000 + i * 4000; turns.push({ at: t0, them: 1000 }, { at: t0 + 1400, heard: `q${i}`, end: t0 + 1000 }, { at: t0 + 1800, voice: 400 }); }
  const r = await run(turns);
  const waits = r.gate.slice(-4).map(l => l.waited_ms);
  assert.ok(waits[0] > 0 && waits[1] > 0 && waits[2] > 0 && waits[3] === 0, JSON.stringify(waits));
});

test("fail open: a session.start the server refuses with the trigger in it is sent again without it — no gate, and the old prompt lines", async () => {
  const r = await run(mid(reply(9500)), { beforeStart: (emit) => emit({ type: "error", error: { code: "invalid_request", message: "unknown field triggers" } }) });
  const starts = r.live.sent.filter(e => e.type === "session.start");
  assert.equal(starts.length, 2);
  assert.ok(starts[0].session.triggers && !("triggers" in starts[1].session));
  assert.match(starts[0].session.instructions, /small sign that you're there/);
  assert.doesNotMatch(starts[1].session.instructions, /small sign that you're there/, "not encouraged to interject with nothing keeping the timing");
  config.callTurnGate = "off";
  assert.deepEqual(starts[1].session, gl.sessionConfig({ ...gl.whoFor(r.call.call), greeting: "Hey Omari, what's up?" }), "exactly the start a call gets with the gate off");
  assert.equal(r.call.turnGate, null);
  assert.ok(heardIn(r, STOP).length >= 80, "and the call behaves as it does today");
  assert.ok(r.lines.some(l => l.gptlive_turn_gate_off != null));
});

// ---------- after a held reply ----------

test("after a held reply: they go quiet for 3 s and a few words are welcome — asked once, and what it says then is played", async () => {
  const r = await run([...mid(reply(9500), { at: 7500, them: 1500 }), { at: 12500, voice: 500 }], { until: 14500 });
  const nudges = notes(r, "session.commentary.append", c => c === tg.TURN_GATE_QUIET_NUDGE);
  assert.equal(nudges.length, 1);
  const ms = nudges[0].at - r.zero;
  assert.ok(ms >= STOP + tg.TURN_GATE_QUIET_MS && ms <= STOP + tg.TURN_GATE_QUIET_MS + 400, `asked at ${ms}`);
  assert.ok(heardIn(r, 12500).length >= 24, "what it says then reaches the phone");
});

test("a pause that runs to 3 s after an acknowledgement: a few words are welcome, asked once", async () => {
  const r = await run([...mid(ack(9500)), { at: 12500, voice: 500 }], { react: 0, until: 14500 });
  assert.equal(acked(r).length, 1);
  assert.equal(notes(r, "session.commentary.append", c => c === tg.TURN_GATE_QUIET_NUDGE).length, 1);
  assert.ok(heardIn(r, 12500).length >= 24);
});

test("after a held reply: they carry on and finish — nothing over them, and the answer to the whole thought plays", async () => {
  const r = await run([...mid(reply(9500), { at: 7500, them: 1500 }), { at: 10200, them: 1400 }, { at: 12000, heard: "p2", end: 11600 }, { at: 12200, decision: "p2", finished: 0.98 }, { at: 12400, voice: 800 }], { until: 14500 });
  assert.equal(heardIn(r, STOP, 12300).length, 0, "nothing over them");
  assert.ok(heardIn(r, 12400).length >= 39, "the reply to the finished thought goes out");
  assert.equal(notes(r, "session.commentary.append", c => c === tg.TURN_GATE_QUIET_NUDGE).length, 0);
});

test("a second reply to the same words is not held (if the verdict was wrong, they are waiting)", async () => {
  const first = [{ at: 9500, voice: 600 }, { at: 9700, said: "Sure, I can do that for you now." }];
  const r = await run([...mid(first, { at: 7500, them: 1500 }), ...reply(10600, "Right, so what I'd do is this.")], { react: 0, until: 11900 });
  assert.equal(r.gate.filter(l => l.dropped).length, 1);
  assert.ok(r.gate.some(l => l.why === "held once"));
  assert.ok(heardIn(r, 10600).length >= 50, "the second is played");
  const g = new tg.TurnGate();
  g.heard("a", 1000, 900);
  g.decided({ type: "decision.event", source_event_id: "a", event: { type: "decision.completed", decision: { answers: [{ type: "predicate", name: "finished", probability: 0.1 }] } } }, 1200);
  const at = { speechAt: 800, speechMs: 900 };
  assert.equal(g.read(1250, at).state, "wait", "too fresh to stand: the next piece may finish the sentence");
  assert.equal(g.read(1400, at).heldOnce, false);
  g.dropped(g.read(1400, at).seq);
  assert.ok(g.read(1500, at).state === "unfinished" && g.read(1500, at).heldOnce === true);
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
  // The words code asks for: in turn, never the last one played.
  assert.equal(tg.nextAckWord(0, ""), "Mm-hm.");
  assert.equal(tg.nextAckWord(0, "mm-hm"), "Yeah.");
  assert.equal(tg.nextAckWord(2, "Yeah."), "Go on.");
  assert.ok(tg.looksLikeAck("") && tg.looksLikeAck("I'm with you.") && !tg.looksLikeAck("Sure, I can do that") && !tg.looksLikeAck("Which one?"));
});

test("the log: one line per gated run, numbers and fixed labels only — never a word of the call", async () => {
  const r = await run(mid(reply(9500)));
  const labels = ["finished", "unfinished", "none", "open", "wait", "error", "held once", "decisions quiet", "long quiet", "no timeline", "no transcript", "no decision", "settling", "played", "not due", "same as the last", "not an acknowledgement", "they carried on"];
  for (const l of r.gate) {
    const { at, ...line } = l;
    for (const [k, v] of Object.entries(line)) {
      assert.ok(["gptlive_turn_gate", "verdict", "why", "decision_ms", "transcript_ms", "lead_ms", "waited_ms", "dropped", "p", "matched", "observe", "ack", "pause_ms", "speech_ms", "prompted"].includes(k), k);
      if (typeof v === "string") assert.ok(labels.includes(v), v);
    }
  }
  assert.equal(r.gate.length, 3, "the first exchange's reply, the held reply, the acknowledgement");
  for (const l of r.lines.filter(x => Object.keys(x).some(k => /^gptlive_turn_gate_/.test(k)))) assert.ok(!JSON.stringify(l).match(/Mm-hm|Sure|words/), JSON.stringify(l));
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
  const r = await replay.replayOne(mid(reply(9500)), { gate: "owner", row: ownCall(OTHER) });
  assert.equal(r.call.turnGate, null);
  assert.ok(heardIn(r, STOP).length >= 80, "the reply into the pause plays, as today");
  assert.doesNotMatch(r.live.sent.find(e => e.type === "session.start").session.instructions, /small sign that you're there/);
  const mine = await replay.replayOne(mid(reply(9500)), { gate: "owner", row: ownCall(C) });
  assert.ok(heardIn(mine, STOP).length <= 22, "on the operator's, only the acknowledgement");
});

// ---------- a business call ----------

test("a business call: the trigger also asks 'are they asking if this is a machine, or who is calling?', and Reason answers honestly at once", async () => {
  const ask = (asks, at = 9500) => ({ at, decision: "p1", finished: 0.9, asks });
  const talking = (call) => { call.talking = true; };
  const r = await replay.replayOne([...OPEN, THEIRS, { at: 9300, heard: "p1", end: STOP }, ask("asks_ai"), { at: 9550, heard: "p2", end: STOP }, { at: 9700, decision: "p2", finished: 0.9, asks: "asks_ai" }], { row: lineCall(), setup: talking });
  const qs = r.live.sent.find(e => e.type === "session.start").session.triggers[0].decisions.questions;
  assert.deepEqual(qs.map(q => q.name), ["finished", "asks"]);
  assert.deepEqual(qs[1].choices.map(c => c.value), ["asks_ai", "asks_who", "neither"]);
  const told = r.live.sent.filter(e => e.type === "session.instructions.append" && /^They just asked/.test(e.content));
  assert.equal(told.length, 1, "once per question, not once per piece of it");
  assert.match(told[0].content, /"I'm an AI assistant calling for Omari\."/);
  assert.match(told[0].content, /Never say or imply you are human/);
  assert.equal(told[0].at - r.zero, 9500, "the moment the decision arrives");
  assert.ok(r.lines.some(l => l.gptlive_turn_gate_asked != null && l.asks === "asks_ai" && l.decision_ms === 200));

  const who = await replay.replayOne([...OPEN, THEIRS, { at: 9300, heard: "p1", end: STOP }, ask("asks_who")], { row: lineCall(), setup: talking });
  assert.match(who.live.sent.find(e => /^They just asked who is calling/.test(e.content ?? "")).content, /"I'm an AI assistant calling for Omari\."/);
  assert.match(tg.honestAnswerNote("asks_who", "Omari Nyarko"), /never say you are Omari,/);
  assert.match(tg.honestAnswerNote("asks_ai", ""), /"I'm an AI assistant\."/);

  const neither = await replay.replayOne([...OPEN, THEIRS, { at: 9300, heard: "p1", end: STOP }, ask("neither")], { row: lineCall(), setup: talking });
  assert.equal(neither.live.sent.some(e => /^They just asked/.test(e.content ?? "")), false);
});

test("a business call: 'not finished' is only logged — nothing of Reason's is held, and nothing is added, on a business line", async () => {
  const talking = (call) => { call.talking = true; };
  const on = await replay.replayOne(mid(reply(9500)), { row: lineCall(), setup: talking });
  const off = await replay.replayOne(mid(reply(9500)), { row: lineCall(), setup: talking, gate: "off" });
  assert.deepEqual(on.played, off.played);
  assert.equal(asks(on).length + notes(on, "session.instructions.append", c => /^They paused/.test(c)).length, 0, "no acknowledgements on a business line");
  assert.ok(on.gate.length > 0 && on.gate.every(l => l.observe === true && l.dropped === false));
});

// ---------- the replay ----------

test("the replay harness: with the transcript close behind, acknowledgements sit in the pause, half-thought replies stay off, and real replies are prompt", async () => {
  const fast = await replay.scenario([300, 800], { n: 18, seed: 3 });
  assert.ok(fast.pauses.ack >= 12, JSON.stringify(fast.pauses));
  assert.equal(fast.pauses.ackOnSpeech, 0, JSON.stringify(fast.pauses));
  assert.ok(fast.pauses.fullHeard <= 1, JSON.stringify(fast.pauses));
  assert.ok(fast.finished.prompt >= 15, JSON.stringify(fast.finished));
  // The late transcript: the gate does nothing, and nothing is lost but the budget.
  const late = await replay.scenario([1500, 2700], { n: 9, seed: 3 });
  assert.equal(late.finished.never, 0);
  assert.ok(Math.max(...late.finished.delays) <= tg.TURN_GATE_BUDGET_MS + 40);
  assert.match(replay.render({ fast }), /wholly in the pause/);
});
