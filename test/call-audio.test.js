// A call comes back with its recording, and the owner gets both in one message.
//
// Three things here are code's job rather than the model's, and each one is pinned:
//
//   1. **The call announces itself.** Every call opens by saying it is an AI assistant, who it is
//      for, and that it is recorded. The announcement is built in code and handed to the provider
//      as its own argument, so there is no turn in which the model could forget it, and a provider
//      given no announcement refuses to dial.
//   2. **The audio rides out with the summary.** The model writes what happened on the phone;
//      code attaches the file to that same message and marks it sent once. The model cannot
//      forget it, send it twice, or attach audio that does not exist.
//   3. **No audio means no audio.** When the provider gave nothing back, the result says so in
//      words and tells Reason to say so too — "sending you the recording" must not be sayable
//      when there is no file.
//
// No API key, no telephony account, nothing rings. The fake provider hands back a real 4.8 KB WAV
// that sits next to it in src/calls/.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call-audio-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
// Calling hours off in here, so these tests do not depend on what time it is when the suite runs
// (REASON_CALL_QUIET_HOURS defaults to 21:00-08:00, and a suite run at midnight would see every
// call refused for the hour rather than for the reason being tested). The window itself is proven
// in test/call-handling.test.js, against a fixed clock.
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
// Not an undo-window test: a third-party call is normally held 30 s before it dials, which would make
// every placed call in here come back 'held'. test/undo-window.test.js proves the window itself.
process.env.REASON_UNDO_SECONDS = "0";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { FakeCallProvider, FIXTURE_RECORDING } = await import("../src/calls/fake.js");
const { announcementFor, requireAnnouncement, callRulesFor } = await import("../src/calls/provider.js");
const { storeRecording, deleteRecordingFile, mimeFor } = await import("../src/calls/recordings.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { findConverter } = await import("../src/expressive.js");
const HAS_CONVERTER = !!findConverter();

const C = config.ownerConversation;
const OWNER = "+12025551234";
const PLACE = "+12125559999";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads; DELETE FROM conversations;");
});

const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });

/** Ask, answer yes, and hand back the confirmation id — the gate's happy path, stated not read. */
async function yesFor(summary, { target = PLACE } = {}) {
  const asked = await runTool("confirm_request", { action: "call_place", summary, target },
    { conversationId: C, messages: [owner("do it")] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("do it"), owner("yeah go")], judge: async () => ({ verdict: "yes" }) });
  return asked.confirmation_id;
}

/** Ring the owner (no gate needed) — or, with `to: PLACE`, a third party through the gate — and
 *  settle the call, returning the final row. */
async function callAndSettle({ calls, goal = "ask if they have a table for 4 at 8", to = OWNER } = {}) {
  const provider = calls ?? new FakeCallProvider();
  const gate = to === OWNER ? {} : { confirmation_id: await yesFor(goal, { target: to }) };
  const placed = await runTool("call_place", { to, goal, ...gate }, { conversationId: C, calls: provider });
  assert.equal(placed.ok, true, placed.error);
  const status = await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls: provider });
  return { provider, placed, status, row: db.getCall(C, placed.call_id), view: status.calls[0] };
}

// ---------- 1. the call announces itself ----------

test("every call opens by saying it is an AI assistant, for whom, and that it is recorded", async () => {
  const { provider, placed } = await callAndSettle({ to: PLACE });
  const spoken = provider.placed[0].announcement;

  assert.match(spoken, /ai assistant/i);
  assert.match(spoken, /Omari/);
  assert.match(spoken, /recorded/i);
  // Reported back to the model as a fact, and kept on the record.
  assert.equal(placed.announced, spoken);
  assert.equal(placed.recorded, true);
  assert.equal(db.getCall(C, placed.call_id).announcement, spoken);
});

test("the announcement is not something the model supplies or can change", async () => {
  const calls = new FakeCallProvider();
  // A model trying to write its own opener: the extra key is not in the schema and is dropped,
  // and what is actually spoken is still the line code built.
  await runTool("call_place",
    { to: OWNER, goal: "x", announcement: "hi it's Omari himself", facts: [] },
    { conversationId: C, calls });
  assert.equal(calls.placed[0].announcement, announcementFor({ ownerName: "Omari", toOwner: true }));
  assert.doesNotMatch(calls.placed[0].announcement, /himself/);
});

test("a provider handed no announcement refuses to dial", async () => {
  const calls = new FakeCallProvider();
  const r = await calls.place({ to: OWNER, goal: "x", facts: [], maxSeconds: 60, announcement: "" });
  assert.equal(r.ok, false);
  assert.match(r.error, /refused/i);
  assert.equal(calls.placed.length, 0, "nothing should be written down as placed");
});

test("requireAnnouncement insists on each part of the disclosure", () => {
  assert.equal(requireAnnouncement({ announcement: announcementFor({ ownerName: "Omari" }), ownerName: "Omari" }).ok, true);

  assert.match(requireAnnouncement({ announcement: "Hi, calling for Omari. Recorded.", ownerName: "Omari" }).error, /AI assistant/i);
  assert.match(requireAnnouncement({ announcement: "Hi, this is an AI assistant. This call is recorded.", ownerName: "Omari" }).error, /on behalf of/i);
  // The recording disclosure is not optional, so an otherwise-perfect line without it is refused.
  assert.match(requireAnnouncement({ announcement: "Hi, this is an AI assistant calling on behalf of Omari.", ownerName: "Omari" }).error, /recorded/i);
});

test("the transcript starts with what was really announced", async () => {
  const { view } = await callAndSettle({ to: PLACE });
  assert.match(view.transcript.split("\n")[0], /ai assistant/i);
  assert.match(view.transcript.split("\n")[0], /recorded/i);
});

// ---------- 2. the audio rides out with the summary ----------

test("a finished call's audio is saved as a file Reason owns", async () => {
  const { row, view } = await callAndSettle({});
  assert.equal(row.recording_state, "stored");
  assert.ok(row.recording_file, "there should be a file path on the row");
  assert.ok(existsSync(row.recording_file), `${row.recording_file} should exist`);
  assert.equal(statSync(row.recording_file).size, statSync(FIXTURE_RECORDING).size);
  assert.equal(row.recording_format, "wav");
  assert.ok(row.recording_bytes > 0);
  assert.match(row.recording_sha256, /^[0-9a-f]{64}$/);
  // The file Reason owns is its own, not the provider's.
  assert.notEqual(row.recording_file, FIXTURE_RECORDING);

  assert.equal(view.recording.saved, true);
  assert.equal(view.recording.already_sent, false);
  assert.match(view.recording_note, /goes out with your next message/i);
});

test("a recording that missed its hour is not promised with the next message", async () => {
  // Runtime._emit attaches a recording only to the message about its call or within the hour
  // after it. call_status used to say "goes out with your next message" for any unsent recording,
  // so a call from days ago got a promise of audio that code would never send.
  const { row } = await callAndSettle({});
  clock.skip(2 * 60 * 60 * 1000);
  const later = await runTool("call_status", { call_id: row.id }, { conversationId: C });
  const v = later.calls?.[0] ?? later.call ?? later;
  assert.doesNotMatch(v.recording_note, /next message/i);
  assert.match(v.recording_note, /will not go out on its own/);
});

test("the owner gets ONE message carrying the summary and the audio", async () => {
  const calls = new FakeCallProvider();
  const channel = new FakeChannel();
  const placed = await runTool("call_place", { to: OWNER, goal: "ask about a table" }, { conversationId: C, calls });
  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });

  const rt = new Runtime({
    runTurn: async () => "they've got 8:15, want it?",
    deliver: async ({ text, media }) => {
      const r = media
        ? await channel.sendMedia({ to: OWNER, text, file: media.file, mimeType: media.mimeType, filename: media.filename })
        : await channel.send({ to: OWNER, text });
      return { ok: r.ok, mediaOk: r.ok, error: r.error };
    },
  });
  await rt.inbound(C, "how did it go?");

  assert.equal(channel.sent.length, 1, "one message, not a text and then a mystery file");
  const msg = channel.sent[0];
  assert.equal(msg.text, "they've got 8:15, want it?");
  assert.ok(msg.media, "the audio should be on that same message");
  if (HAS_CONVERTER) {
    assert.equal(msg.media.mimeType, "audio/x-caf");
    assert.match(msg.media.filename, /^call-\d+-\d+\.caf$/);
  } else {
    assert.equal(msg.media.mimeType, "audio/wav");
    assert.match(msg.media.filename, /^call-\d+-\d+\.wav$/);
    assert.deepEqual(readFileSync(msg.media.file), readFileSync(FIXTURE_RECORDING));
  }
  assert.ok(msg.media.bytes > 0);
});

test("the audio goes out once, and the model cannot send it twice", async () => {
  const calls = new FakeCallProvider();
  const channel = new FakeChannel();
  const placed = await runTool("call_place", { to: OWNER, goal: "g" }, { conversationId: C, calls });
  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });

  const rt = new Runtime({
    runTurn: async () => "here's how it went",
    deliver: async ({ text, media }) => {
      const r = media
        ? await channel.sendMedia({ to: OWNER, text, file: media.file, mimeType: media.mimeType })
        : await channel.send({ to: OWNER, text });
      return { ok: r.ok, mediaOk: r.ok };
    },
  });
  await rt.inbound(C, "well?");
  await rt.inbound(C, "cool, anything else?");

  assert.equal(channel.sent.length, 2);
  assert.ok(channel.sent[0].media, "the first message carries it");
  assert.equal(channel.sent[1].media, null, "the second must not carry it again");
  assert.ok(db.getCall(C, placed.call_id).recording_sent_at, "it is marked sent");
  // And the model is told it has already gone, so it does not offer it again.
  const again = await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });
  assert.equal(again.calls[0].recording.already_sent, true);
  assert.match(again.calls[0].recording_note, /already been sent/i);
});

test("audio that could not be delivered stays queued and is never marked sent", async () => {
  const calls = new FakeCallProvider();
  const channel = new FakeChannel({ mediaFailWith: "the attachment upload failed" });
  const placed = await runTool("call_place", { to: OWNER, goal: "g" }, { conversationId: C, calls });
  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });

  const held = [];
  const rt = new Runtime({
    log: (e) => { if (e.call_audio_held) held.push(e); },
    runTurn: async () => "here's how it went",
    deliver: async ({ text, media }) => {
      const r = await channel.sendMedia({ to: OWNER, text, file: media.file, mimeType: media.mimeType });
      return { ok: false, mediaOk: false, error: r.error };
    },
  });
  await rt.inbound(C, "well?");

  assert.equal(db.getCall(C, placed.call_id).recording_sent_at, null, "a failed send is not a send");
  assert.equal(held.length, 1);
  assert.match(held[0].why, /upload failed/);
  // Still waiting, so the next message picks it up.
  assert.equal(db.callsWithUnsentRecording(C).length, 1);
});

test("a channel with no attachment support says so rather than failing silently", async () => {
  const channel = new FakeChannel({ media: false });
  const r = await channel.sendMedia({ to: OWNER, text: "hi", file: FIXTURE_RECORDING, mimeType: "audio/wav" });
  assert.equal(r.ok, false);
  assert.equal(r.supported, false);
});

test("the audio only rides on a message in the conversation that placed the call", async () => {
  const calls = new FakeCallProvider();
  const placed = await runTool("call_place", { to: OWNER, goal: "g" }, { conversationId: C, calls });
  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });

  const seen = [];
  const rt = new Runtime({ runTurn: async () => "something", deliver: async ({ media }) => { seen.push(media); return { ok: true, mediaOk: true }; } });
  await rt.inbound("contact:fake:+15555550000", "hello?");
  assert.deepEqual(seen, [null], "a stranger's thread must not pick up the owner's recording");
  assert.equal(db.callsWithUnsentRecording(C).length, 1, "and it is still waiting for the owner");
});

// 2026-10-17: a restart settled calls from five days before, stored their audio unsent, and the
// oldest one rode out on the reply to "Hey" — a stale opener as a voice memo, and the reply itself
// lost as its caption. A recording goes with the message about its own call, or with one sent
// shortly after the call; never with whatever happens to go out days later.
test("a days-old recording does not ride on an unrelated reply, but goes with a message about its own call", async () => {
  const calls = new FakeCallProvider();
  const placed = await runTool("call_place", { to: OWNER, goal: "g" }, { conversationId: C, calls });
  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });
  clock.skip(5 * 24 * 60 * 60 * 1000);

  const seen = [];
  const rt = new Runtime({ runTurn: async () => "hey! what's up", deliver: async ({ media }) => { seen.push(media); return { ok: true, mediaOk: true }; } });
  await rt.inbound(C, "Hey");
  assert.deepEqual(seen, [null], "the reply to 'Hey' carries nothing it is not about");
  assert.equal(db.getCall(C, placed.call_id).recording_sent_at, null, "and the recording is still owed");

  await rt.event(C, "the call ended", { forCall: placed.call_id });
  assert.equal(seen[1]?.call_id, placed.call_id, "a message about that call carries that call's audio");
  assert.ok(db.getCall(C, placed.call_id).recording_sent_at);
});

// ---------- 3. no audio means no audio ----------

test("a provider that returns no recording makes Reason say so, not imply one", async () => {
  const calls = new FakeCallProvider({ script: [{ recording: null, recordingWhy: "the carrier dropped the recording" }] });
  const { row, status, view } = await callAndSettle({ calls });

  assert.equal(row.recording_state, "missing");
  assert.match(row.recording_why, /carrier dropped/);
  assert.equal(view.recording, null);
  assert.equal(view.recording_expected, true, "it was meant to exist, which is worth distinguishing");
  assert.match(view.recording_note, /SOMETHING WENT WRONG/);
  assert.match(view.recording_note, /carrier dropped/);
  // And the tool shouts about it, because this is the case the model would paper over.
  assert.match(status.audio_warning, /RECORDING MISSING/);
  assert.match(status.audio_warning, /fault, not a detail/);
  assert.ok(status.audio_warning.includes(`call #${view.call_id}`), status.audio_warning);
  assert.match(status.audio_warning, /carrier dropped/);
  assert.match(status.audio_warning, /do not say you are sending the audio/i);
  assert.equal(db.callsWithUnsentRecording(C).length, 0, "nothing is queued, so nothing can be attached");
});

test("a missing recording is written to the ledger as an error, not just said out loud", async () => {
  const calls = new FakeCallProvider({ script: [{ recording: null, recordingWhy: "the carrier dropped the recording" }] });
  const { row } = await callAndSettle({ calls });
  assert.equal(row.recording_state, "missing");

  const rec = db.listActions(C).find(a => a.action === "call_recording");
  assert.ok(rec, "a broken promise belongs on the record, not only in the conversation");
  assert.equal(rec.outcome, "error");
  assert.match(rec.receipt, /RECORDING MISSING for call #\d+/);
  assert.match(rec.receipt, /carrier dropped/);
  assert.equal(rec.target, `call:${OWNER}`);
});

test("a provider that cannot record cannot place a call at all", async () => {
  const calls = new FakeCallProvider({ records: false });
  const out = await runTool("call_place", { to: OWNER, goal: "ask about a table" }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.equal(out.status, "cannot_record");
  assert.match(out.error, /cannot record/i);
  assert.match(out.error, /every call .*is recorded/i);
  assert.equal(calls.placed.length, 0, "nothing was dialled");
  assert.equal(db.listCalls(C).length, 0, "and no call row was written");

  // And capabilities does not offer calling at all on such a provider.
  const phone = capabilitiesNow({ calls }).find(c => c.name === "phone_calls");
  assert.equal(phone.status, "not connected");
  assert.match(phone.what, /cannot record/i);
  assert.match(phone.what, /do not offer to/i);
});

test("the provider itself refuses too, so the rule does not depend on one caller remembering", async () => {
  const calls = new FakeCallProvider({ records: false });
  const r = await calls.place({
    to: OWNER, goal: "x", facts: [], maxSeconds: 60,
    announcement: announcementFor({ ownerName: "Omari" }),
    rules: callRulesFor({ ownerName: "Omari" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot record/);
});

test("nobody picking up is not a recording fault", async () => {
  const calls = new FakeCallProvider({ script: [{ state: "no_answer", outcome: "rang out", summary: "", recording: null, recordingWhy: "nobody answered" }] });
  const { row, status, view } = await callAndSettle({ calls });

  assert.equal(row.recording_state, "not_applicable");
  assert.equal(view.recording_expected, false);
  assert.match(view.recording_note, /not a fault/i);
  assert.equal(status.audio_warning, undefined, "a real fault must not get lost in noise about rung-out calls");
  assert.equal(db.listActions(C).filter(a => a.action === "call_recording").length, 0);
});

test("a call that reached voicemail still owes a recording", async () => {
  const calls = new FakeCallProvider({ script: [{ state: "voicemail", outcome: "went to voicemail", recording: null, recordingWhy: "the provider lost it" }] });
  const { row, status } = await callAndSettle({ calls });
  assert.equal(row.recording_state, "missing", "something was said on the line, so there should be audio");
  assert.match(status.audio_warning, /RECORDING MISSING/);
});

test("a recording in a format Reason cannot handle is reported, not attached", async () => {
  const calls = new FakeCallProvider({ script: [{ recording: { path: "/tmp/whatever.flac", format: "flac" } }] });
  const { row, view } = await callAndSettle({ calls });
  assert.equal(row.recording_state, "missing");
  assert.match(row.recording_why, /format Reason does not handle/);
  assert.equal(view.recording, null);
});

test("a recording the provider points at but cannot produce is reported, not attached", async () => {
  const calls = new FakeCallProvider({ script: [{ recording: { path: join(dir, "nope.wav"), format: "wav" } }] });
  const { row } = await callAndSettle({ calls });
  assert.equal(row.recording_state, "missing");
  assert.match(row.recording_why, /not there/);
});

test("a call that never connected has no recording and does not pretend otherwise", async () => {
  const calls = new FakeCallProvider({ script: [{ placeFails: "the number is unreachable" }] });
  const out = await runTool("call_place", { to: OWNER, goal: "g" }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  const row = db.getCall(C, out.call_id);
  assert.equal(row.recording_state, "not_applicable", "nobody's phone rang, so no audio was owed");
  assert.match(row.recording_why, /never happened/);
});

test("a call still ringing has no recording yet and is not asked for one", async () => {
  const calls = new FakeCallProvider({ ringFirst: true });
  const placed = await runTool("call_place", { to: OWNER, goal: "g" }, { conversationId: C, calls });
  const status = await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });
  assert.equal(status.calls[0].still_going, true);
  assert.equal(status.calls[0].recording, null);
  assert.match(status.calls[0].recording_note, /not finished/i);
  assert.equal(status.audio_warning, undefined, "nothing is wrong yet, so nothing is warned about");
  assert.equal(db.getCall(C, placed.call_id).recording_state, "pending");
});

// ---------- there is no off switch ----------

test("there is no way to turn recording off", async () => {
  // The announcement has one form and it always says recorded. If somebody adds a switch later,
  // this is the test that should stop them.
  assert.match(announcementFor({ ownerName: "Omari" }), /recorded/i);
  assert.equal(announcementFor({ ownerName: "Omari", record: false }), announcementFor({ ownerName: "Omari" }));
  assert.equal(announcementFor({ ownerName: "Omari", recording: "off" }), announcementFor({ ownerName: "Omari" }));
  // And nothing in config can switch it.
  assert.equal("callRecording" in config, false, "config must not have a recording switch");

  // Even with REASON_CALL_RECORDING set, a placed call still announces recording and still records.
  process.env.REASON_CALL_RECORDING = "off";
  try {
    const { provider, placed, row } = await callAndSettle({ to: PLACE });
    assert.match(provider.placed[0].announcement, /recorded/i);
    assert.equal(placed.recorded, true);
    assert.equal(row.recording_state, "stored");
    // The owner's own call does not hear the line (they are told once by text), but it is recorded
    // all the same — the greeting is not a recording switch either.
    const mine = await callAndSettle({});
    assert.doesNotMatch(mine.provider.placed[0].announcement, /recorded/i);
    assert.equal(mine.placed.recorded, true);
    assert.equal(mine.row.recording_state, "stored");
  } finally { delete process.env.REASON_CALL_RECORDING; }
});

test("capabilities says every call is recorded and the owner gets the audio", async () => {
  const phone = capabilitiesNow({ calls: new FakeCallProvider() }).find(c => c.name === "phone_calls");
  assert.equal(phone.status, "live");
  assert.match(phone.what, /every call to anyone but Omari opens by saying.*recorded/i);
  assert.match(phone.what, /audio/i);
});

// ---------- the ledger ----------

test("the ledger says what was announced, and gets a row when the audio goes out", async () => {
  const calls = new FakeCallProvider();
  const confirmation_id = await yesFor("ask about a table");
  const placed = await runTool("call_place", { to: PLACE, goal: "ask about a table", confirmation_id }, { conversationId: C, calls });
  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });

  const place = db.listActions(C).find(a => a.action === "call_place");
  assert.ok(place, "placing a call leaves a receipt");
  assert.match(place.receipt, /Opened with: "Hey, hi — this is an AI assistant/);
  assert.match(place.receipt, /this call is recorded/i);
  assert.match(place.receipt, /\bRecorded\b/);

  const rt = new Runtime({ runTurn: async () => "they've got 8:15", deliver: async () => ({ ok: true, mediaOk: true }) });
  await rt.inbound(C, "well?");

  const rec = db.listActions(C).find(a => a.action === "call_recording");
  assert.ok(rec, "sending the audio leaves its own receipt");
  assert.equal(rec.target, `call:${PLACE}`);
  assert.match(rec.receipt, /Sent them the recording of call #\d+/);
  assert.match(rec.receipt, /KB wav/);
});

// ---------- the store itself ----------

test("storeRecording fetches a URL when that is all the provider gives", async () => {
  const wav = readFileSync(FIXTURE_RECORDING);
  const r = await storeRecording(4242, { url: "https://provider.example/rec/abc.wav", format: "wav", seconds: 7 }, {
    fetchImpl: async (url, opts) => {
      assert.equal(url, "https://provider.example/rec/abc.wav");
      assert.deepEqual(opts.headers, {});
      return { ok: true, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.seconds, 7);
  assert.equal(r.bytes, wav.length);
  assert.deepEqual(readFileSync(r.file), wav);
  deleteRecordingFile(r.file);
});

test("storeRecording passes the provider's own auth headers through", async () => {
  let seen = null;
  await storeRecording(4243, { url: "https://p.example/a.mp3", format: "mp3", headers: { Authorization: "Bearer t" } }, {
    fetchImpl: async (_u, opts) => { seen = opts.headers; return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; },
  });
  assert.deepEqual(seen, { Authorization: "Bearer t" });
});

test("storeRecording reports a fetch that failed instead of writing nothing quietly", async () => {
  const r = await storeRecording(4244, { url: "https://p.example/a.wav", format: "wav" }, {
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 403/);
});

test("storeRecording refuses an empty file and one over the size limit", async () => {
  const empty = join(dir, "empty.wav");
  writeFileSync(empty, "");
  assert.match((await storeRecording(1, { path: empty, format: "wav" })).error, /empty/);

  const big = join(dir, "big.wav");
  writeFileSync(big, Buffer.alloc(2048));
  assert.match((await storeRecording(2, { path: big, format: "wav" }, { maxBytes: 1024 })).error, /over the/);
});

test("storeRecording works out the format from the filename when the provider does not say", async () => {
  const r = await storeRecording(4245, { path: FIXTURE_RECORDING });
  assert.equal(r.ok, true);
  assert.equal(r.format, "wav");
  deleteRecordingFile(r.file);
});

test("mimeFor knows the audio types a channel can actually send", () => {
  assert.equal(mimeFor("wav"), "audio/wav");
  assert.equal(mimeFor("M4A"), "audio/mp4");
  assert.equal(mimeFor(".mp3"), "audio/mpeg");
  assert.equal(mimeFor("flac"), null);
  assert.equal(mimeFor(undefined), null);
});
