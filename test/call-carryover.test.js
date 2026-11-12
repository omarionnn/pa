// What a call carries over (call audit 2026-11-11; src/calls/carryover.js), REASON_CALL_CARRYOVER off|owner|on.
// Call 85 -> 86: eleven minutes on the launch on Monday, and Tuesday's call started with none of it.
// Call 94: "you're off at 8, yeah?" on a Wednesday, because the voice was never told the day.
// No network: the read of a finished call is a stand-in.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-carry-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";

const gl = await import("../src/calls/gptlive.js");
const voice = await import("../src/calls/voice.js");
const carry = await import("../src/calls/carryover.js");
const postcall = await import("../src/calls/postcall.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
// Wed Nov 11 2026, 9:26 PM in New York (02:26 UTC on the 12th — the server's own clock says Thursday).
const WED_NIGHT = Date.UTC(2026, 10, 12, 2, 26, 15);
const HOUR = 3600_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM timers; DELETE FROM tasks;");
  db.saveConversation(C, []);
  db.saveConversation(OTHER, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callCarryover: "owner", callManner: "off", callIdentity: false, callVoice: "gptlive", callCacheWarm: false, openaiKey: "sk-test" });
  carry.resetCarryover();
  await voice.prime();
});

/** A call row at a given time, finished unless told otherwise. */
function callAt(at, { conversationId = C, isOwner = true, direction = "in", transcript = "", state = "completed", outcomeKind = "talked", summary = "", seconds = 120 } = {}) {
  const row = db.createCall(conversationId, {
    provider: "gptlive", toNumber: "+12025551234", isOwner, goal: direction === "in" ? "Omari called Reason" : "Omari asked to be called",
    facts: [], announcement: "hey Omari, what's up?", direction, state: "in_progress",
  });
  db.updateCall(conversationId, row.id, { state, transcript, outcome_kind: outcomeKind, duration_s: seconds, ...(summary ? { summary } : {}) });
  db.db.prepare("UPDATE calls SET created_at = ?, ended_at = ? WHERE id = ?").run(at, at + seconds * 1000, row.id);
  return db.getCall(conversationId, row.id);
}

const LAUNCH_CALL = [
  "Reason: Oh, hey Omari — what's up?",
  "Them: Me, pretty well. I'm actually sitting at a park",
  "Reason: Oh, no-",
  "Them: You know Union Square",
  "Reason: Union Square Park. Nice spot. You've still got a bit before you need to head up, right?",
  "Them: I want to set it up such that tomorrow by this time the ads are already launched",
  "Reason: Yeah.",
  "Them: do you get what I'm saying",
  "Reason: That all tracks. Want me to put together a pre-launch checklist from your notes?",
  "Them: Um, yeah. But also, let's keep talking",
].join("\n");
const READ = { told: ["wants the Reason ads launched by this time tomorrow", "heading to the Roastery to work before his shift"], promised: ["put together a pre-launch checklist from his notes"], open: [] };

test("their side of a call is read back as whole breaths, not the line's fragments", () => {
  const lines = carry.theirLines("Reason: Hey Om\nThem: I'm good, how are\nReason: Good,\nThem: you\nReason: Just hanging with you. What's on your mind?\nThem: I'm on my way to Bo Peep");
  assert.deepEqual(lines, ["I'm good, how are you", "I'm on my way to Bo Peep"]);
});

test("a finished call of theirs is read once and the read is kept on its own row", async () => {
  const row = callAt(WED_NIGHT - 26 * HOUR, { transcript: LAUNCH_CALL });
  let asked = 0;
  const ask = async (q) => { asked++; assert.match(q.prompt, /ads are already launched/); assert.equal(q.feature, "call_carryover"); return { value: READ }; };
  const after = await carry.settleCarry(row, { ask });
  assert.equal(asked, 1);
  assert.match(after.summary, /^They told you: wants the Reason ads launched by this time tomorrow; heading to the Roastery/);
  assert.deepEqual(carry.itemsFrom(db.getCall(C, row.id).summary, "promised"), ["put together a pre-launch checklist from his notes"]);
  // Already read: not asked again.
  assert.equal(carry.settleCarry(db.getCall(C, row.id), { ask }), null);
  assert.equal(asked, 1);
});

test("no answer leaves the row as it was — nothing is guessed", async () => {
  const row = callAt(WED_NIGHT - 3 * HOUR, { transcript: LAUNCH_CALL });
  await carry.settleCarry(row, { ask: async () => ({ error: "timeout" }) });
  assert.equal(db.getCall(C, row.id).summary, "");
  const thrown = callAt(WED_NIGHT - 2 * HOUR, { transcript: LAUNCH_CALL });
  await carry.settleCarry(thrown, { ask: async () => { throw new Error("cli down"); } });
  assert.equal(db.getCall(C, thrown.id).summary, "");
});

test("the next call starts with what was said on the one before: the voice's brief and Reason's own turn", async () => {
  const before = callAt(WED_NIGHT - 26 * HOUR, { transcript: LAUNCH_CALL, seconds: 641 });
  await carry.settleCarry(before, { ask: async () => ({ value: READ }) });
  const now = callAt(WED_NIGHT, { state: "in_progress" });

  const brief = gl.preCallBrief(now);
  assert.match(brief, /EARLIER CALLS with them/);
  assert.match(brief, /- yesterday 7:26 PM, they called, 11 min: They told you: wants the Reason ads launched by this time tomorrow/);
  assert.match(brief, /You said you'd: put together a pre-launch checklist from his notes/);

  const system = voice.ownerContext({ call: now, callMessages: [] }).system;
  assert.match(system, /EARLIER CALLS with them/);
  assert.match(system, /You said you'd: put together a pre-launch checklist/);
  assert.ok(system.includes(carry.CARRY_TURN_LINE));
  // The voice's instructions as a whole carry it, with the one-open-thing line.
  const instructions = gl.voiceInstructionsFor(now);
  assert.match(instructions, /EARLIER CALLS with them/);
  assert.ok(instructions.includes(carry.CARRY_VOICE_LINES[0]));
});

test("a call whose read never came back still gives their own words", () => {
  callAt(WED_NIGHT - 5 * HOUR, { transcript: LAUNCH_CALL });
  const note = carry.earlierCallsNote(callAt(WED_NIGHT, { state: "in_progress" }));
  assert.match(note, /- today 4:26 PM, they called, 2 min \(their own words, as the line heard them\): /);
  assert.match(note, /"I want to set it up such that tomorrow by this time the ads are already launched do you get what I'm saying"/);
});

test("the same words on every turn of a call, even when a later call lands meanwhile", () => {
  callAt(WED_NIGHT - 5 * HOUR, { transcript: LAUNCH_CALL });
  const now = callAt(WED_NIGHT, { state: "in_progress" });
  const first = carry.earlierCallsNote(now);
  callAt(WED_NIGHT - 1 * HOUR, { transcript: "Them: this one was written after the note was read, never mind it" });
  assert.equal(carry.earlierCallsNote(now), first);
});

test("only a call a person of this conversation was really on rides along", () => {
  callAt(WED_NIGHT - 2 * HOUR, { isOwner: false, transcript: "Them: Thanks for calling the salon, an hour is fifty dollars cash" });
  callAt(WED_NIGHT - 3 * HOUR, { outcomeKind: "voicemail_no_message", transcript: "Them: The person you're trying to reach is not available. At the tone, please record your message" });
  callAt(WED_NIGHT - 4 * HOUR, { outcomeKind: "line_silent", transcript: "Reason: hey — hey Omari — what's up?" });
  callAt(WED_NIGHT - 60 * HOUR, { transcript: "Them: this was three days ago and has had its time already" });
  callAt(WED_NIGHT + 1 * HOUR, { transcript: "Them: this call has not happened yet as far as that one knows" });
  callAt(WED_NIGHT - 2 * HOUR, { conversationId: OTHER, transcript: "Them: I'm Ama and this is my own private business, thanks" });
  const now = callAt(WED_NIGHT, { state: "in_progress" });
  assert.equal(carry.earlierCallsNote(now), "");
  assert.doesNotMatch(gl.preCallBrief(now), /EARLIER CALLS|salon|Ama|three days ago/);
});

test("the voice is told the day and time where they are, not the server's", () => {
  const brief = gl.preCallBrief(callAt(WED_NIGHT, { state: "in_progress" }));
  assert.match(brief, /Right now, where they are: Wednesday, November 11 at 9:26 PM\./);
  assert.doesNotMatch(brief, /Thursday/);
  assert.match(brief, /standing patterns, not today's plan/);
});

test("what is due in the next day and still open is in the voice's brief", () => {
  db.createTimer(C, { fireAt: WED_NIGHT + 2 * HOUR, note: "check the laundry" });
  db.createTimer(C, { fireAt: WED_NIGHT + 40 * HOUR, note: "renew the passport" });
  const brief = gl.preCallBrief(callAt(WED_NIGHT, { state: "in_progress" }));
  assert.match(brief, /Coming up and still open/);
  assert.match(brief, /- reminder today 11:26 PM: check the laundry/);
  assert.doesNotMatch(brief, /passport/);
});

test("after the call, the turn that follows is handed what Reason said it would do", async () => {
  const row = callAt(WED_NIGHT - 1 * HOUR, { transcript: LAUNCH_CALL });
  assert.doesNotMatch(postcall.ownerEvent({ row }), /On the call you said you'd/);
  const read = await carry.settleCarry(row, { ask: async () => ({ value: READ }) });
  const event = postcall.ownerEvent({ row: read });
  assert.match(event, /On the call you said you'd: put together a pre-launch checklist from his notes\./);
  assert.match(event, /that text IS owed/);
  // Nothing promised: the event is as it always was.
  const quiet = callAt(WED_NIGHT - 2 * HOUR, { transcript: LAUNCH_CALL, summary: "They told you: is at the park" });
  assert.doesNotMatch(postcall.ownerEvent({ row: quiet }), /On the call you said you'd/);
});

test("off (unset) and for anyone but the operator on 'owner': nothing is read, added or asked", async () => {
  const mine = callAt(WED_NIGHT - 5 * HOUR, { transcript: LAUNCH_CALL, summary: "You said you'd: send the checklist" });
  const theirs = callAt(WED_NIGHT - 5 * HOUR, { conversationId: OTHER, transcript: LAUNCH_CALL });
  // Ama's own call, with the flag on for the operator only.
  const amaNow = callAt(WED_NIGHT, { conversationId: OTHER, state: "in_progress" });
  assert.equal(carry.settleCarry(theirs, { ask: async () => { throw new Error("must not be asked"); } }), null);
  assert.doesNotMatch(gl.preCallBrief(amaNow), /EARLIER CALLS|Right now, where they are/);

  config.callCarryover = "off";
  carry.resetCarryover();
  const now = callAt(WED_NIGHT, { state: "in_progress" });
  assert.doesNotMatch(gl.preCallBrief(now), /EARLIER CALLS|Right now, where they are|Coming up and still open/);
  assert.doesNotMatch(voice.ownerContext({ call: now, callMessages: [] }).system, /EARLIER CALLS/);
  assert.ok(!gl.voiceInstructionsFor(now).includes(carry.CARRY_VOICE_LINES[0]));
  assert.doesNotMatch(postcall.ownerEvent({ row: mine }), /On the call you said you'd/);
  assert.equal(carry.settleCarry(callAt(WED_NIGHT - 3 * HOUR, { transcript: LAUNCH_CALL }), { ask: async () => { throw new Error("must not be asked"); } }), null);

  // On for everyone: Ama's calls carry over to Ama, and only hers.
  config.callCarryover = "on";
  carry.resetCarryover();
  const amaNote = carry.earlierCallsNote(callAt(WED_NIGHT, { conversationId: OTHER, state: "in_progress" }));
  assert.match(amaNote, /ads are already launched/);
  assert.doesNotMatch(amaNote, /send the checklist/);
});
