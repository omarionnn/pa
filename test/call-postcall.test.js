// The call is over: what gets written down, who gets told, and the things that must NOT happen.
//
// Three of these pin failures that have already cost something real. A post-call delivery writes
// into somebody's own conversation, so an unsigned one is refused rather than taken on trust. A
// recording endpoint's 200 is not audio — that one cost a real call, where 111 bytes of JSON were
// filed as call-1.wav and the owner was told the audio was saved. And a call that reached an
// answering machine is still "done" at the platform, so filing one as a conversation would tell the
// owner their message was heard by a person.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-postcall-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.ELEVENLABS_API_KEY = "eleven-test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ELEVENLABS_LLM_SECRET = "llm-test-secret";
process.env.ELEVENLABS_WEBHOOK_SECRET = "hook-test-secret";
process.env.REASON_UNDO_SECONDS = "0";

const {
  postCallRequest, writeCallIntoThread, turnsFromTranscriptString, noteOnTask, tellTheOwner,
  thirdPartyEvent, ownerEvent, POST_CALL_PATH,
} = await import("../src/calls/postcall.js");
const { ElevenLabsCallProvider } = await import("../src/calls/elevenlabs.js");
const { settleCall } = await import("../src/tools.js");
const { announcementFor } = await import("../src/calls/provider.js");
const { FIXTURE_RECORDING } = await import("../src/calls/fake.js");
const db = await import("../src/db.js");
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

const provider = (over = {}) => new ElevenLabsCallProvider(over);

const sign = (raw, { secret = "hook-test-secret", t = Math.floor(Date.now() / 1000) } = {}) =>
  `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

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
  provider: "elevenlabs", toNumber: "+12025551234", isOwner: true,
  goal: "Omari called Reason", facts: [], direction: "in", externalId: "conv_in", state: "in_progress",
});
const thirdPartyCall = (over = {}) => db.createCall(C, {
  provider: "elevenlabs", toNumber: PLACE, isOwner: false,
  goal: "ask for a table for four at eight on Saturday", facts: ["the name is Omari"],
  announcement: ANN, externalId: "conv_out", ...over,
});

const transcript = [
  { role: "agent", message: "hey Omari — you're in the middle of booking Carbone. what's up?" },
  { role: "user", message: "yeah, make it Friday instead of Saturday" },
  { role: "agent", message: "Friday it is. I'll text you the new link now." },
];

// Nine seconds, because the fixture recording really is about a second of tone and
// `storeRecording` refuses a file too small to be a call of the length it claims. A payload saying
// 95 seconds with 4.8 KB of audio is not a thing to assert against; it is a thing that should fail,
// and it does — see the test at the bottom of the audio section.
const payload = (over = {}) => ({
  type: "post_call_transcription",
  data: {
    conversation_id: over.conversation_id ?? "conv_in",
    status: "done",
    metadata: { call_duration_secs: 9, termination_reason: "the caller hung up", ...(over.metadata ?? {}) },
    analysis: { transcript_summary: over.summary ?? "They moved it to Friday." },
    transcript: over.transcript ?? transcript,
    ...(over.has_audio === false ? { has_audio: false } : {}),
  },
});

/** Deliver one payload, signed, with the audio fetch stubbed to whatever is handed in. */
const deliver = async (body, { runtime = fakeRuntime(), bytes = null, contentType = "audio/mpeg", status = 200 } = {}) => {
  const raw = JSON.stringify(body);
  const fetchImpl = async () => ({
    ok: status === 200, status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => (bytes ?? Buffer.alloc(0)),
    json: async () => ({}),
  });
  return await postCallRequest({
    rawBody: raw, headers: { "ElevenLabs-Signature": sign(raw) },
    provider: provider(), runtime, settle: settleCall, fetchImpl,
  });
};

const mp3 = readFileSync(FIXTURE_RECORDING); // a real WAV; the sniff names it for what it is

// ---------- the door ----------

test("an unsigned or wrongly signed delivery writes nothing at all", async () => {
  ownerCall();
  const raw = JSON.stringify(payload());

  for (const headers of [{}, { "elevenlabs-signature": sign(raw, { secret: "nope" }) }, { "elevenlabs-signature": "garbage" }]) {
    const out = await postCallRequest({ rawBody: raw, headers, provider: provider(), settle: settleCall });
    assert.equal(out.status, 401);
  }
  // Nothing in the thread, and the call is untouched.
  assert.equal(db.loadConversation(C).length, 0);
  assert.equal(db.listCalls(C)[0].state, "in_progress");

  assert.equal((await postCallRequest({ rawBody: raw, headers: {}, provider: null })).status, 404);
  assert.equal(POST_CALL_PATH, "/calls/elevenlabs/post-call");
});

test("a delivery for a conversation Reason never made is acknowledged and nothing is written", async () => {
  // Not an error: a conversation started outside Reason looks exactly like this, and 200 is what
  // stops them retrying forever.
  const out = await deliver(payload({ conversation_id: "conv_someone_elses" }));
  assert.equal(out.status, 200);
  assert.equal(out.body.known, false);
  assert.equal(db.loadConversation(C).length, 0);
});

// ---------- the transcript becomes the conversation ----------

test("an owner call lands in their thread as turns, so a text ten minutes later carries on", async () => {
  const call = ownerCall();
  const out = await deliver(payload(), { bytes: mp3 });

  assert.equal(out.status, 200);
  assert.equal(out.body.state, "completed");
  assert.equal(out.body.turns_written, 3);

  const thread = db.loadConversation(C);
  // One line saying these words were SPOKEN, so a model reading the thread back does not take
  // "Friday it is" for a text that was never sent.
  assert.match(String(thread[0].content), /on a phone call with Omari, they called/);
  assert.match(String(thread[0].content), /9s/);
  // Their words are theirs, and Reason's are Reason's.
  assert.equal(thread[1].role, "assistant");
  assert.match(String(thread[2].content), /Omari \(on the call\): yeah, make it Friday instead of Saturday/);
  assert.equal(thread[3].role, "assistant");
  assert.match(String(thread[3].content), /Friday it is/);
  // A thread must not end on a user turn nothing answered, or the next real message reads as a
  // reply to the last thing said on the phone.
  assert.equal(thread.at(-1).role, "assistant");

  // And the call row carries the whole of it too.
  const row = db.getCall(C, call.id);
  assert.equal(row.duration_s, 9);
  assert.match(row.transcript, /Them: yeah, make it Friday instead of Saturday/);
});

test("a third-party call is NOT written into the thread as though they had said it", async () => {
  // The restaurant is not in this conversation. Writing their half in as turns would make "you told
  // me Friday" a thing Reason could believe about the wrong person.
  thirdPartyCall();
  const out = await deliver(payload({ conversation_id: "conv_out" }), { bytes: mp3 });
  assert.equal(out.body.turns_written, 0);
  assert.equal(db.loadConversation(C).length, 0);
});

test("a voicemail is never filed as a conversation that happened", async () => {
  // Bland's lesson, and the one that matters most here: an answering machine at the platform is
  // still status 'done'. Filing it would tell the owner their message was heard by a person.
  const call = thirdPartyCall();
  const out = await deliver(payload({
    conversation_id: "conv_out",
    metadata: { call_duration_secs: 6, termination_reason: "voicemail detected" },
    transcript: [{ role: "user", message: "Hi, you've reached Carbone, please leave a message" }],
  }), { bytes: mp3 });

  assert.equal(out.body.state, "voicemail");
  assert.equal(out.body.turns_written, 0);
  assert.equal(db.loadConversation(C).length, 0);
  // There IS audio of the greeting and the owner still gets it; what must not happen is the call
  // being treated as having reached somebody.
  assert.equal(db.getCall(C, call.id).recording_state, "stored");
  assert.match(db.getCall(C, call.id).outcome, /went to voicemail/);
});

test("a voicemail Reason left itself ends as end_call at the platform, and is still filed as a voicemail", async () => {
  // Since 2026-10-13 the message is left through end_call rather than by forwarding detection, so the
  // platform's termination reason no longer says "voicemail". The row knew during the call.
  const call = thirdPartyCall();
  db.updateCall(C, call.id, {
    voicemail_left: 1, outcome_kind: "voicemail_left",
    outcome: `a machine answered; one message was left: "Hi, this is an AI assistant calling for Omari..."`,
  });
  const runtime = fakeRuntime();
  const out = await deliver(payload({
    conversation_id: "conv_out",
    metadata: { call_duration_secs: 9, termination_reason: "end_call tool was called" },
    transcript: [
      { role: "user", message: "Hi, you've reached Jeffrey, leave a message after the tone" },
      { role: "agent", message: "Hi, this is an AI assistant calling for Omari..." },
    ],
  }), { bytes: mp3, runtime });

  assert.equal(out.body.state, "voicemail", "not 'completed': nobody was spoken to");
  assert.equal(out.body.turns_written, 0);
  const row = db.getCall(C, call.id);
  assert.equal(row.outcome_kind, "voicemail_left");
  assert.match(row.outcome, /one message was left/);
  assert.equal(row.recording_state, "stored");
  // The owner is told what was left, in the row's words rather than the platform's "they answered".
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

test("the audio is saved as real bytes, and a body that is not audio is refused", async () => {
  const call = thirdPartyCall();
  const out = await deliver(payload({ conversation_id: "conv_out" }), { bytes: mp3 });
  const row = db.getCall(C, call.id);
  assert.equal(row.recording_state, "stored");
  assert.equal(out.body.recording, "stored");
  // Named for what the bytes ARE, not for what the provider said they would be.
  assert.equal(row.recording_format, "wav");
  assert.ok(row.recording_bytes > 1000);
  assert.ok(readFileSync(row.recording_file).length === row.recording_bytes);

  // The failure that cost a real call: 111 bytes of JSON, 200 OK, filed as audio and reported as
  // saved. The sniff is what makes that impossible.
  db.db.exec("DELETE FROM calls");
  const second = thirdPartyCall();
  await deliver(payload({ conversation_id: "conv_out" }), {
    bytes: Buffer.from(JSON.stringify({ code: 200, status: "success", url: "https://example/x" })),
    contentType: "application/json",
  });
  const bad = db.getCall(C, second.id);
  assert.equal(bad.recording_state, "missing");
  assert.match(bad.recording_why, /not audio/);
  // On the record as a failure, not just in the conversation: "every call is recorded" is a promise.
  const ledger = db.db.prepare("SELECT * FROM action_ledger WHERE action = 'call_recording'").all();
  assert.equal(ledger.length, 1);
});

test("their audio-only webhook files the bytes, and refuses a body that is not audio", async () => {
  const call = thirdPartyCall();
  const good = await deliver({ type: "post_call_audio", data: { conversation_id: "conv_out", full_audio: mp3.toString("base64") } });
  assert.equal(good.body.recording, "stored");
  assert.equal(db.getCall(C, call.id).recording_format, "wav");

  db.db.exec("DELETE FROM calls");
  const second = thirdPartyCall();
  const bad = await deliver({ type: "post_call_audio", data: { conversation_id: "conv_out", full_audio: Buffer.from("not audio at all, just words").toString("base64") } });
  assert.equal(bad.body.ok, false);
  assert.equal(db.getCall(C, second.id).recording_state, "missing");
  assert.match(bad.body.error, /not audio/);

  // And a delivery carrying no audio at all says so rather than claiming a file.
  db.db.exec("DELETE FROM calls");
  thirdPartyCall();
  const empty = await deliver({ type: "post_call_audio", data: { conversation_id: "conv_out" } });
  assert.equal(empty.body.ok, false);
  assert.match(empty.body.error, /carried no audio/);
});

test("audio too small to be a call that long is refused, not filed as the recording", async () => {
  // A truncated download and a stub both answer 200 with a valid header on the front. "A WAV
  // arrived" is not the same as "the call's audio arrived", and the only thing that can tell is how
  // many bytes there are for how many seconds the call ran.
  const call = thirdPartyCall();
  const out = await deliver(payload({ conversation_id: "conv_out", metadata: { call_duration_secs: 95 } }), { bytes: mp3 });
  assert.equal(out.body.recording, "missing");
  const row = db.getCall(C, call.id);
  assert.match(row.recording_why, /too small to be the recording/);
  assert.match(row.recording_why, /for a 95-second call/);
});

test("a call that was answered with no audio is a reported fault, not a shrug", async () => {
  const call = thirdPartyCall();
  const out = await deliver(payload({ conversation_id: "conv_out", has_audio: false }));
  assert.equal(out.body.recording, "missing");
  assert.match(db.getCall(C, call.id).recording_why, /no audio/);
});

// ---------- minutes, retries, and jobs ----------

test("the minutes are counted once, whichever delivery arrives first and however often they retry", async () => {
  const call = thirdPartyCall();
  await deliver(payload({ conversation_id: "conv_out" }), { bytes: mp3 });
  const day = new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: config.tz });
  assert.equal(db.usageToday(C, day).call_seconds, 9);

  // They retry. Settling twice would count the same minutes twice.
  const again = await deliver(payload({ conversation_id: "conv_out" }), { bytes: mp3 });
  assert.equal(again.body.already, true);
  assert.equal(db.usageToday(C, day).call_seconds, 9);
  assert.equal(db.getCall(C, call.id).state, "completed");
});

test("a call still going has nothing written for it", async () => {
  const call = thirdPartyCall();
  const out = await deliver({ type: "post_call_transcription", data: { conversation_id: "conv_out", status: "in-progress" } });
  assert.equal(out.body.state, "in_progress");
  assert.equal(db.getCall(C, call.id).state, "placing");
});

test("a call that never started is written down as that, with no audio fault", async () => {
  const call = thirdPartyCall();
  const out = await deliver({ type: "call_initiation_failure", data: { conversation_id: "conv_out", reason: "the number is unreachable" } });
  assert.equal(out.body.state, "failed");
  const row = db.getCall(C, call.id);
  assert.match(row.outcome, /never started/);
  assert.equal(row.recording_state, "not_applicable");
});

test("the job the call belonged to hears what the call said", async () => {
  const { runTool } = await import("../src/tools.js");
  const started = await runTool("task_start", { title: "book Carbone", goal: "a table for four" }, { conversationId: C, messages: [] });
  const call = thirdPartyCall({ taskId: started.task.id });

  await deliver(payload({ conversation_id: "conv_out" }), { bytes: mp3 });
  const logged = db.db.prepare("SELECT * FROM task_log WHERE task_id = ? AND kind = 'call'").all(started.task.id);
  assert.equal(logged.length, 1);
  assert.match(logged[0].note, new RegExp(`called \\${PLACE}`));
  assert.match(logged[0].note, /They moved it to Friday/);

  // A call that belonged to no job writes onto none.
  assert.equal(noteOnTask({ row: db.getCall(C, call.id), live: {} }).taskId, started.task.id);
  assert.equal(noteOnTask({ row: { ...db.getCall(C, call.id), task_id: null }, live: {} }).taskId, null);
});

// ---------- who gets told ----------

test("a third-party call becomes an event turn, with the whole transcript and the audio's real state", async () => {
  // Told as an event rather than a line this module writes, so the audio rides out attached by code
  // off the calls table and Reason reports it in its own words.
  thirdPartyCall();
  const runtime = fakeRuntime();
  await deliver(payload({ conversation_id: "conv_out" }), { runtime, bytes: mp3 });

  assert.equal(runtime.events.length, 1);
  const said = runtime.events[0].text;
  assert.match(said, new RegExp(`call you placed to \\${PLACE}`));
  assert.match(said, /ask for a table for four at eight on Saturday/);
  // The whole transcript, not a summary of a summary.
  assert.match(said, /yeah, make it Friday instead of Saturday/);
  assert.match(said, /goes out attached to this message automatically/);
  assert.match(said, /If it did not get the answer it was for, say so rather than rounding it up/);

  // It counts against their day, because it is Reason starting a conversation.
  const day = new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: config.tz });
  assert.equal(db.usageToday(C, day).proactive, 1);
});

test("a silent line is filed as nobody speaking, not as 'they answered', and the summary is ours", async () => {
  // The 2026-10-27 call to the Strand: connected, Reason spoke three times, and every turn back was
  // "..." — digital silence. The row said "they answered", and ElevenLabs' summary said "The AI agent
  // called Omari", which Reason could later read back as a call to the owner.
  const call = thirdPartyCall({ goal: "ask whether they have Thank God for Cats in stock" });
  const runtime = fakeRuntime();
  await deliver(payload({
    conversation_id: "conv_out",
    metadata: { call_duration_secs: 9, termination_reason: "end_call tool was called" },
    summary: "The AI agent called Omari to inquire about the stock. Despite repeated attempts, no audible response from the user.",
    transcript: [
      { role: "agent", message: "Hi, this is an AI assistant calling for Omari." },
      { role: "user", message: "..." },
      { role: "agent", message: "Are you still on the line?" },
      { role: "user", message: "..." },
    ],
  }), { bytes: mp3, runtime });

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

  // Settling the same call again (a poll after the webhook) keeps it silent.
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

test("a third-party call where they did speak keeps the service's notes, behind who was really called", async () => {
  const call = thirdPartyCall();
  await deliver(payload({ conversation_id: "conv_out", summary: "The AI agent called Omari about a table." }), { bytes: mp3 });
  const row = db.getCall(C, call.id);
  assert.notEqual(row.outcome_kind, "line_silent");
  assert.equal(row.outcome, "they answered");
  assert.match(row.summary, new RegExp(`^Reason called \\${PLACE} on Omari's behalf \\(Omari was not on the call\\), to: ask for a table`));
  assert.match(row.summary, /The call service's notes: The AI agent called Omari about a table\./);
});

test("a third-party call with no audio tells Reason to say so rather than imply a recording", () => {
  const call = thirdPartyCall();
  db.updateCall(C, call.id, { recording_state: "missing", recording_why: "the provider never gave it to Reason" });
  const said = thirdPartyEvent({ row: db.getCall(C, call.id), live: {} });
  assert.match(said, /There is NO audio for this call/);
  assert.match(said, /rather than implying a recording exists/);
});

test("their daily proactive limit holds for a call recap too", async () => {
  thirdPartyCall();
  const runtime = fakeRuntime({ interrupt: false });
  await deliver(payload({ conversation_id: "conv_out" }), { runtime, bytes: mp3 });
  assert.equal(runtime.events.length, 0);
  // The call is still fully settled; only the interruption was held.
  assert.equal(db.listCalls(C)[0].state, "completed");
  assert.equal(db.listCalls(C)[0].recording_state, "stored");
});

test("after their OWN call, silence is the expected answer", async () => {
  ownerCall();
  const runtime = fakeRuntime({ reply: null });
  await deliver(payload(), { runtime, bytes: mp3 });

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
