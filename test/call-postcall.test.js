// The call is over: what gets written down, who gets told, and the things that must NOT happen.
//
// Every call is GPT-Live over Twilio, and every finished one settles through `settleGptLive`. Two of
// these pin failures that have already cost something real. A recording that is not audio — that one
// cost a real call, where 111 bytes of JSON were filed as call-1.wav and the owner was told the audio
// was saved. And a call that reached an answering machine still "completed" on the line, so filing one
// as a conversation would tell the owner their message was heard by a person.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-postcall-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";

const {
  writeCallIntoThread, turnsFromTranscriptString, noteOnTask, tellTheOwner,
  thirdPartyEvent, ownerEvent,
} = await import("../src/calls/postcall.js");
const { settleGptLive } = await import("../src/calls/gptlive.js");
const hold = await import("../src/calls/hold.js");
const { settleCall } = await import("../src/tools.js");
const { announcementFor } = await import("../src/calls/provider.js");
const { FIXTURE_RECORDING } = await import("../src/calls/fake.js");
const db = await import("../src/db.js");
const { readPlain } = await import("../src/restfiles.js"); // a file sealed with REASON_ENCRYPT_REST2=on reads plain
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const PLACE = "+12125559999";
const ANN = announcementFor({ ownerName: "Omari" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
});

/** A runtime that records the event turns it was asked to run, and what it replied. */
function fakeRuntime({ reply = "told them", interrupt = true } = {}) {
  const events = [];
  return {
    events,
    mayInterrupt: () => interrupt,
    event: async (conversationId, text) => { events.push({ conversationId, text }); return reply; },
  };
}

const ownerCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true,
  goal: "Omari called Reason", facts: [], direction: "in", externalId: "gptlive:CA_in", state: "in_progress",
});
const thirdPartyCall = (over = {}) => db.createCall(C, {
  provider: "gptlive", toNumber: PLACE, isOwner: false,
  goal: "ask for a table for four at eight on Saturday", facts: ["the name is Omari"],
  announcement: ANN, externalId: "gptlive:CA_out", ...over,
});

const callTurns = [
  { who: "reason", text: "hey Omari — you're in the middle of booking Carbone. what's up?" },
  { who: "them", text: "yeah, make it Friday instead of Saturday" },
  { who: "reason", text: "Friday it is. I'll text you the new link now." },
];
const asTranscript = (turns) => turns.map(t => `${t.who === "them" ? "Them" : "Reason"}: ${t.text}`).join("\n");

const fixtureAudio = () => ({ path: FIXTURE_RECORDING, format: "wav", seconds: 9 });

// Nine seconds, because the fixture recording really is about a second of tone and
// `storeRecording` refuses a file too small to be a call of the length it claims. A call saying
// 95 seconds with 4.8 KB of audio is not a thing to assert against; it is a thing that should fail,
// and it does — see the test at the bottom of the audio section.
/** What a finished GPT-Live call hands its settle (`finishCall` in src/calls/gptlive.js). */
const liveOf = (over = {}) => {
  const turns = over.turns ?? callTurns;
  return {
    state: "completed", outcome: "", summary: "",
    transcript: asTranscript(turns), turns,
    durationS: 9, costCents: 1, termination: "hung up", cutOff: null,
    recording: fixtureAudio(), recordingWhy: "",
    ...over,
  };
};

/** Settle one call the way a GPT-Live call that just ended does. */
const settle = (row, live = liveOf(), { runtime = fakeRuntime() } = {}) =>
  settleGptLive({ row: db.getCall(C, row.id), live, settle: settleCall, runtime });

// ---------- the transcript becomes the conversation ----------

test("an owner call lands in their thread as turns, so a text ten minutes later carries on", async () => {
  const call = ownerCall();
  const out = await settle(call);
  assert.equal(out.state, "completed");

  const thread = db.loadConversation(C);
  assert.equal(thread.length, 4);
  // One line saying these words were SPOKEN, so a model reading the thread back does not take
  // "Friday it is" for a text that was never sent.
  assert.match(String(thread[0].content), /on a phone call with Omari, they called/);
  assert.match(String(thread[0].content), /9s/);
  // Their words are theirs, and Reason's are Reason's.
  assert.equal(thread[1].role, "assistant");
  // An inbound call matched by caller ID alone is tagged: the words are kept, but are never the owner's yes.
  assert.match(String(thread[2].content), /Omari \(on the call, caller not verified\): yeah, make it Friday instead of Saturday/);
  assert.equal(thread[3].role, "assistant");
  assert.match(String(thread[3].content), /Friday it is/);
  // A thread must not end on a user turn nothing answered, or the next real message reads as a
  // reply to the last thing said on the phone.
  assert.equal(thread.at(-1).role, "assistant");

  // And the call row carries the whole of it too.
  const row = db.getCall(C, call.id);
  assert.equal(row.duration_s, 9);
  assert.match(row.transcript, /Them: yeah, make it Friday instead of Saturday/);
  assert.ok(row.settled_at, "the settle finished");
});

test("a third-party call is NOT written into the thread as though they had said it", async () => {
  // The restaurant is not in this conversation. Writing their half in as turns would make "you told
  // me Friday" a thing Reason could believe about the wrong person.
  const call = thirdPartyCall();
  await settle(call);
  assert.equal(db.getCall(C, call.id).state, "completed");
  assert.equal(db.loadConversation(C).length, 0);
});

test("a voicemail is never filed as a conversation that happened", async () => {
  // Bland's lesson, and the one that matters most here: an answering machine on the line is still a
  // call that completed. Filing it would tell the owner their message was heard by a person.
  const call = thirdPartyCall();
  hold.noteVoicemail(db.getCall(C, call.id), { message: "" });
  await settle(call, liveOf({
    durationS: 6, termination: "hung up",
    turns: [{ who: "them", text: "Hi, you've reached Carbone, please leave a message" }],
  }));

  const row = db.getCall(C, call.id);
  assert.equal(row.state, "voicemail");
  assert.equal(db.loadConversation(C).length, 0);
  // There IS audio of the greeting and the owner still gets it; what must not happen is the call
  // being treated as having reached somebody.
  assert.equal(row.recording_state, "stored");
  assert.match(row.outcome, /a machine answered; no message was left/);
  assert.equal(row.end_reason, "voicemail");
});

test("a voicemail Reason left itself ends as end_call on the line, and is still filed as a voicemail", async () => {
  // The message is left through end_call, so the line's own ending does not say "voicemail". The row
  // knew during the call.
  const call = thirdPartyCall();
  hold.noteVoicemail(db.getCall(C, call.id), { message: "Hi, this is an AI assistant calling for Omari..." });
  const runtime = fakeRuntime();
  await settle(call, liveOf({
    termination: "end_call (mutual goodbye)",
    turns: [
      { who: "them", text: "Hi, you've reached Jeffrey, leave a message after the tone" },
      { who: "reason", text: "Hi, this is an AI assistant calling for Omari..." },
    ],
  }), { runtime });

  const row = db.getCall(C, call.id);
  assert.equal(row.state, "voicemail", "not 'completed': nobody was spoken to");
  assert.equal(db.loadConversation(C).length, 0);
  assert.equal(row.outcome_kind, "voicemail_left");
  assert.match(row.outcome, /one message was left/);
  assert.equal(row.recording_state, "stored");
  // The owner is told what was left, in the row's words rather than "they answered".
  assert.equal(runtime.events.length, 1);
  assert.match(runtime.events[0].text, /one message was left/);
});

test("an owner call that reached voicemail is not written in either", () => {
  const call = thirdPartyCall({ isOwner: true });
  db.updateCall(C, call.id, { state: "voicemail" });
  const r = writeCallIntoThread({ row: db.getCall(C, call.id), live: { turns: [{ who: "them", text: "leave a message" }] } });
  assert.equal(r.turns, 0);
  assert.match(r.why, /voicemail/);

  // Nor is one nobody picked up.
  db.updateCall(C, call.id, { state: "no_answer" });
  assert.match(writeCallIntoThread({ row: db.getCall(C, call.id), live: { turns: [] } }).why, /nothing was said/);
});

test("a transcript that only came back as a string is still written as turns", () => {
  const call = ownerCall();
  db.updateCall(C, call.id, { state: "completed" });
  const r = writeCallIntoThread({ row: db.getCall(C, call.id), live: { transcript: "Reason: hey\nThem: hi there\nReason: ok" } });
  assert.equal(r.turns, 3);
  assert.deepEqual(turnsFromTranscriptString("Reason: a\nThem: b\nnot a turn"), [
    { who: "reason", text: "a" }, { who: "them", text: "b" },
  ]);
});

// ---------- the audio ----------

test("the audio is saved as real bytes, and a file that is not audio is refused", async () => {
  const call = thirdPartyCall();
  await settle(call);
  const row = db.getCall(C, call.id);
  assert.equal(row.recording_state, "stored");
  // Named for what the bytes ARE, not for what the file said it would be.
  assert.equal(row.recording_format, "wav");
  assert.ok(row.recording_bytes > 1000);
  assert.ok(readPlain(row.recording_file).length === row.recording_bytes);

  // The failure that cost a real call: 111 bytes of JSON, filed as audio and reported as saved.
  // The sniff is what makes that impossible.
  db.db.exec("DELETE FROM calls");
  const second = thirdPartyCall();
  const fake = join(dir, "not-audio.wav");
  writeFileSync(fake, JSON.stringify({ code: 200, status: "success", url: "https://example/x" }));
  await settle(second, liveOf({ recording: { path: fake, format: "wav", seconds: 9 } }));
  const bad = db.getCall(C, second.id);
  assert.equal(bad.recording_state, "missing");
  assert.match(bad.recording_why, /not audio/);
  // On the record as a failure, not just in the conversation: "every call is recorded" is a promise.
  const ledger = db.db.prepare("SELECT * FROM action_ledger WHERE action = 'call_recording'").all();
  assert.equal(ledger.length, 1);
});

test("audio too small to be a call that long is refused, not filed as the recording", async () => {
  // A truncated tape has a valid header on the front. "A WAV exists" is not the same as "the call's
  // audio exists", and the only thing that can tell is how many bytes there are for how many seconds
  // the call ran.
  const call = thirdPartyCall();
  await settle(call, liveOf({ durationS: 95, recording: { path: FIXTURE_RECORDING, format: "wav", seconds: 95 } }));
  const row = db.getCall(C, call.id);
  assert.equal(row.recording_state, "missing");
  assert.match(row.recording_why, /too small to be the recording/);
  assert.match(row.recording_why, /for a 95-second call/);
});

test("a call that was answered with no audio is a reported fault, not a shrug", async () => {
  const call = thirdPartyCall();
  await settle(call, liveOf({ recording: null, recordingWhy: "the line carried less than a second of audio" }));
  const row = db.getCall(C, call.id);
  assert.equal(row.recording_state, "missing");
  assert.match(row.recording_why, /less than a second of audio/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM action_ledger WHERE action = 'call_recording'").get().n, 1);
});

// ---------- minutes, retries, and jobs ----------

test("the minutes are counted once, however often the call is settled", async () => {
  const call = thirdPartyCall();
  await settle(call);
  const day = new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: config.tz });
  assert.equal(db.usageToday(C, day).call_seconds, 9);

  // The stream end and the status callback can both arrive. Settling twice would count the same
  // minutes twice.
  const runtime = fakeRuntime();
  await settle(call, liveOf(), { runtime });
  assert.equal(db.usageToday(C, day).call_seconds, 9);
  assert.equal(db.getCall(C, call.id).state, "completed");
  assert.equal(runtime.events.length, 0, "the owner is not told twice");
});

test("a call that never started is written down as that, with no audio fault", async () => {
  // What Twilio's status callback hands the settle for a call that never connected.
  const call = thirdPartyCall();
  await settle(call, {
    state: "failed", outcome: "", summary: "", transcript: "", turns: [],
    durationS: 0, costCents: 0, termination: "failed",
    recording: null, recordingWhy: "the call never connected, so there was nothing to record",
  });
  const row = db.getCall(C, call.id);
  assert.equal(row.state, "failed");
  assert.equal(row.recording_state, "not_applicable");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM action_ledger WHERE action = 'call_recording'").get().n, 0);
  assert.equal(db.loadConversation(C).length, 0);
});

test("the job the call belonged to hears what the call said", async () => {
  const { runTool } = await import("../src/tools.js");
  const started = await runTool("task_start", { title: "book Carbone", goal: "a table for four" }, { conversationId: C, messages: [] });
  const call = thirdPartyCall({ taskId: started.task.id });

  await settle(call);
  const logged = db.db.prepare("SELECT * FROM task_log WHERE task_id = ? AND kind = 'call'").all(started.task.id);
  assert.equal(logged.length, 1);
  // A GPT-Live call carries no outcome words or summary of its own, so the note is the state.
  assert.equal(logged[0].note, `called ${PLACE}: completed`);

  // An outcome the call wrote on its row is what the job hears.
  db.updateCall(C, call.id, { outcome: "they have a table at eight on Friday" });
  noteOnTask({ row: db.getCall(C, call.id), live: {} });
  const again = db.db.prepare("SELECT * FROM task_log WHERE task_id = ? AND kind = 'call' ORDER BY id").all(started.task.id);
  assert.match(again.at(-1).note, /they have a table at eight on Friday/);

  // A call that belonged to no job writes onto none.
  assert.equal(noteOnTask({ row: db.getCall(C, call.id), live: {} }).taskId, started.task.id);
  assert.equal(noteOnTask({ row: { ...db.getCall(C, call.id), task_id: null }, live: {} }).taskId, null);
});

// ---------- who gets told ----------

test("a third-party call becomes an event turn, with the whole transcript and the audio's real state", async () => {
  // Told as an event rather than a line this module writes, so the audio rides out attached by code
  // off the calls table and Reason reports it in its own words.
  const call = thirdPartyCall();
  const runtime = fakeRuntime();
  await settle(call, liveOf(), { runtime });

  assert.equal(runtime.events.length, 1);
  const said = runtime.events[0].text;
  assert.match(said, new RegExp(`call you placed to \\${PLACE}`));
  assert.match(said, /ask for a table for four at eight on Saturday/);
  // The whole transcript, not a summary of a summary.
  assert.match(said, /yeah, make it Friday instead of Saturday/);
  assert.match(said, /goes out attached to this message automatically/);
  assert.match(said, /If it did not get the answer it was for, say so rather than rounding it up/);
  assert.ok(db.getCall(C, call.id).told_at);

  // It counts against their day, because it is Reason starting a conversation.
  const day = new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: config.tz });
  assert.equal(db.usageToday(C, day).proactive, 1);
});

test("a silent line is filed as nobody speaking, not as 'they answered', and the summary is ours", async () => {
  // The 2026-10-27 call to the Strand: connected, Reason spoke twice, and every turn back was
  // "..." — digital silence.
  const call = thirdPartyCall({ goal: "ask whether they have Thank God for Cats in stock" });
  const runtime = fakeRuntime();
  await settle(call, liveOf({
    termination: "nobody said anything on the line",
    turns: [
      { who: "reason", text: "Hi, this is an AI assistant calling for Omari." },
      { who: "them", text: "..." },
      { who: "reason", text: "Are you still on the line?" },
      { who: "them", text: "..." },
    ],
  }), { runtime });

  const row = db.getCall(C, call.id);
  assert.equal(row.state, "completed");
  assert.equal(row.outcome_kind, "line_silent");
  assert.doesNotMatch(row.outcome, /answered/);
  assert.match(row.outcome, /silent — nobody spoke/);
  assert.doesNotMatch(row.summary, /called Omari/);
  assert.match(row.summary, new RegExp(`^Reason called \\${PLACE} on Omari's behalf \\(Omari was not on the call\\)`));
  assert.match(row.summary, /Thank God for Cats/);
  assert.match(row.summary, /Nobody on their side spoke/);
  // What Reason is told to report from: the silence, in the row's words.
  assert.match(runtime.events[0].text, /outcome: the line was silent — nobody spoke/);
  assert.doesNotMatch(runtime.events[0].text, /called Omari/);

  // Settling the same call again keeps it silent.
  await settleCall(C, db.getCall(C, call.id), {
    state: "completed", outcome: "they answered", summary: "The AI agent called Omari.",
    transcript: "Reason: Hi?\nThem: ...", durationS: 9,
  });
  assert.equal(db.getCall(C, call.id).outcome_kind, "line_silent");
  assert.doesNotMatch(db.getCall(C, call.id).summary, /called Omari/);

  // And one whose transcript turns out to have them talking is not a silent line after all.
  await settleCall(C, db.getCall(C, call.id), {
    state: "completed", outcome: "they answered", summary: "They have two copies.",
    transcript: "Reason: hi\nThem: yes, we have two copies", durationS: 9,
  });
  assert.equal(db.getCall(C, call.id).outcome_kind, "dropped_before_confirmation");
  assert.equal(db.getCall(C, call.id).outcome, "they answered");
});

test("a third-party call where they did speak is not filed as a silent line", async () => {
  const call = thirdPartyCall();
  await settle(call);
  const row = db.getCall(C, call.id);
  assert.notEqual(row.outcome_kind, "line_silent");
  assert.doesNotMatch(row.outcome, /silent/);
  assert.doesNotMatch(row.summary, /Nobody on their side spoke/);
});

test("a third-party call with no audio tells Reason to say so rather than imply a recording", () => {
  const call = thirdPartyCall();
  db.updateCall(C, call.id, { recording_state: "missing", recording_why: "the provider never gave it to Reason" });
  const said = thirdPartyEvent({ row: db.getCall(C, call.id), live: {} });
  assert.match(said, /There is NO audio for this call/);
  assert.match(said, /rather than implying a recording exists/);
});

test("their daily proactive limit holds for a call recap too", async () => {
  const call = thirdPartyCall();
  const runtime = fakeRuntime({ interrupt: false });
  await settle(call, liveOf(), { runtime });
  assert.equal(runtime.events.length, 0);
  // The call is still fully settled; only the interruption was held.
  const row = db.getCall(C, call.id);
  assert.equal(row.state, "completed");
  assert.equal(row.recording_state, "stored");
  assert.ok(row.settled_at);
});

test("after their OWN call, silence is the expected answer", async () => {
  const call = ownerCall();
  const runtime = fakeRuntime({ reply: null });
  await settle(call, liveOf(), { runtime });

  assert.equal(runtime.events.length, 1);
  const said = runtime.events[0].text;
  // They were on the call. Recounting it back is the thing that makes a product feel like it is
  // talking to itself.
  assert.match(said, /do NOT recount it to them: they were on the call/);
  assert.match(said, /Otherwise reply NO_REPLY/);
  assert.match(said, /A friendly sign-off is not news/);
  // Not counted against their day: finishing a conversation they started thirty seconds ago is not
  // Reason starting one.
  const day = new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: config.tz });
  assert.equal(db.usageToday(C, day).proactive, 0);
});

test("nobody is told anything about a call to their own number that nobody picked up", async () => {
  const call = ownerCall();
  db.updateCall(C, call.id, { state: "no_answer" });
  const runtime = fakeRuntime();
  const r = await tellTheOwner({ row: db.getCall(C, call.id), live: {}, runtime });
  assert.equal(r.sent, false);
  assert.match(r.why, /nobody was on it/);
  assert.equal(runtime.events.length, 0);
});

test("the owner's own missing audio is the one thing worth a line after their call", () => {
  const call = ownerCall();
  db.updateCall(C, call.id, { state: "completed", duration_s: 95, recording_state: "missing", recording_why: "it never came back" });
  const said = ownerEvent({ row: db.getCall(C, call.id) });
  assert.match(said, /There is NO audio for it/);
  assert.match(said, /they were told that, so this one is worth a short honest line/);
  assert.match(said, /about 2 minutes/);
});
