// Calls to businesses and other people (Omari, 2026-11-12), for every account:
//   1. they start NORMALLY — hello, then what the call is about; no "this is Reason, an AI assistant calling
//      for <name> … this call may be recorded". Asked who is calling, or whether it is a person / a robot /
//      an AI, it says at once it is an AI assistant calling for <first name>. Same for a place ringing back.
//   2. no notice at the start means no audio is kept: not one byte of a third-party call is recorded
//      (placed or a ring-back). Their own calls stay recorded. REASON_THIRDPARTY_RECORDING=on brings the
//      notice, the recording and the objection handling back together.
//   3. the 9pm-8am rule (callee's clock) says plainly why and when the call can be placed, "call now anyway"
//      in their own words places that one call, and they can set their own hours (stored per person).
// No network: voice, Twilio and the judges are stand-ins.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-plain-open-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_MAX_CALLS_PER_DAY = "0";
delete process.env.REASON_CALL_QUIET_HOURS;
delete process.env.REASON_THIRDPARTY_RECORDING;

const gl = await import("../src/calls/gptlive.js");
const manner = await import("../src/calls/manner.js");
const prompt = await import("../src/calls/voice-prompt.js");
const opener = await import("../src/calls/opener.js");
const voice = await import("../src/calls/voice.js");
const hold = await import("../src/calls/hold.js");
const brief = await import("../src/calls/brief.js");
const { recordingFileFor } = await import("../src/calls/recordings.js");
const { runTool, fileRecording } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };
const OLD_LINE = /this is Reason, an AI assistant|this call (may be|is|'s) recorded/i;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM confirmations; DELETE FROM action_ledger;");
  db.saveConversation(C, []);
  db.saveConversation(OTHER, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari Test", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama Mensah", isOperator: false });
  Object.assign(config, { callManner: "off", lineTalk: true, callIdentity: false, callVoice: "gptlive", thirdPartyVoice: "owner", callCacheWarm: false, callHearing: true, pickupOpener: false, thirdPartyRecording: false, callQuietHours: "21:00-08:00", ...TWILIO });
});

function fakeTimers() {
  let t = 1_000_000;
  let q = [];
  let n = 0;
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
        q.shift();
        t = next.at;
        next.fn();
        for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
      }
      t = end;
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    },
  };
}
function fakeTwilio() {
  const handlers = { msg: [], close: [] };
  const sent = [];
  return {
    sent, open: () => true, send: (s) => sent.push(JSON.parse(s)), close: () => {},
    onMessage: (f) => handlers.msg.push(f), onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
  };
}
function fakeLive() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  return {
    sent, socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()), emit: (e) => h.event.forEach(f => f(e)),
    of: (type) => sent.filter(e => e.type === type),
  };
}
const SPEECH = Buffer.alloc(160, 0x00).toString("base64");

const ownRow = (conv = C) => db.createCall(conv, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey, what's up?", state: "placing" });
// The row as call_place writes it: the older provider line on it, which a GPT-Live call must never say.
const lineRow = (conv = C, to = "+14155559999") => {
  const row = db.createCall(conv, {
    provider: "gptlive", toNumber: to, isOwner: false, goal: "ask whether they have a table for two at 8 tonight",
    facts: [], announcement: "Hey, hi — this is an AI assistant calling for Omari. Just so you know, this call is recorded.", state: "placing",
  });
  db.updateCall(row.conversation_id, row.id, { opening_waits: 1, pickup_about: "to book a table for two tonight at eight" });
  return db.getCall(row.conversation_id, row.id);
};
const ringBackRow = (conv = OTHER) => {
  const row = db.createCall(conv, {
    provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "They are ringing back about: a table for two at 8 tonight",
    facts: [], announcement: gl.lineAnnouncement(), state: "in_progress", direction: "in",
  });
  return db.getCall(row.conversation_id, row.id);
};
function start({ row, objectionJudge = async () => false }) {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const lines = [];
  const finished = [];
  const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain: () => new Promise(() => {}), judge: async () => null, objectionJudge, now: timers.now, timers, log: (o) => lines.push(o), finish: async (l) => { finished.push(l); }, twilioApi: async () => ({ ok: true, status: 200, json: {} }) });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  return { call, timers, twilio, live, lines, finished };
}
async function talkThenHangUp(s, { words = " Hello, Luigi's, can I help you?" } = {}) {
  for (let i = 0; i < 150; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  s.live.emit({ type: "session.input_transcript.delta", delta: words });
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  for (let i = 0; i < 150; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  const ending = s.call.end("caller hung up");
  await s.timers.advance(3200);
  await ending;
  return s.finished.at(-1);
}

// ---------- 1. the call starts normally ----------

test("no opener line: a call Reason places says nothing about who or what it is, or about recording — voice, row, pickup clip — for every account, in every state", () => {
  for (const [conv, first] of [[C, "Omari"], [OTHER, "Ama"]]) {
    for (const to of ["+14155559999" /* California: all-party */, "+12125559999" /* New York: one-party */]) {
      const row = lineRow(conv, to);
      const s = start({ row });
      const ins = s.live.of("session.start")[0].session.instructions;
      // The line that was added on 11-11 is gone, and so is every instruction to say it.
      assert.doesNotMatch(ins, /Hi there, this is Reason, an AI assistant calling for/);
      assert.doesNotMatch(ins, /say who you are and that the call may be recorded/);
      assert.doesNotMatch(ins, /just so you know, this call/i);
      // It opens like a capable person: hello, then the purpose.
      assert.ok(ins.includes(manner.plainOpenLine()));
      assert.match(ins, /No preamble about who or what you are/);
      assert.match(ins, /I'd like to book a table for two tonight at eight/);
      // Code says nothing first: the row's opening line is empty, so Reason's own turn puts nothing in front.
      assert.equal(db.getCall(conv, row.id).announcement, "");
      assert.equal(hold.openingOwed(db.getCall(conv, row.id)), false);
      assert.deepEqual([s.call.notice.notice, s.call.notice.disclose], [false, false]);
      assert.equal(gl.voiceInstructionsFor(row), ins, "a session opened ahead of the call gets the same words");
      assert.match(ins, new RegExp(`calling for ${first}\\b`), "it knows whose first name to give when asked");
    }
  }
  // The clip played at pickup: hello and what it is about, nothing else.
  assert.equal(gl.lineAnnouncement(), "");
  const clip = opener.openerText({ about: "to book a table for two tonight at eight", disclose: gl.lineAnnouncement() });
  assert.equal(clip.text, "Hi there! I'm calling to book a table for two tonight at eight.");
  assert.doesNotMatch(clip.text, OLD_LINE);
  assert.doesNotMatch(opener.openerText({ disclose: gl.lineAnnouncement() }).text, OLD_LINE);
});

test("the cancelled call manner (flag on) does not bring the opener back", () => {
  config.callManner = "on";
  const s = start({ row: lineRow(OTHER) });
  const ins = s.live.of("session.start")[0].session.instructions;
  assert.doesNotMatch(ins, /Hi there, this is Reason/);
  assert.doesNotMatch(ins, /may be recorded/);
  assert.doesNotMatch(ins, /turn the recording off/, "nothing is promised about a recording that does not exist");
  assert.equal(db.getCall(OTHER, s.call.call.id).announcement, "");
});

test("asked \"is this a robot?\" / \"who is this?\": the honest answer at once — an AI assistant calling for <first name> — never human, never a made-up name, never a dodge", () => {
  for (const [conv, first] of [[C, "Omari"], [OTHER, "Ama"]]) {
    // The voice that talks on a call Reason placed.
    const ins = start({ row: lineRow(conv) }).live.of("session.start")[0].session.instructions;
    // Reason's own call turn (it writes the words on a ring-back, and whatever the voice hands it).
    const turn = voice.thirdPartyContext({ call: db.getCall(conv, lineRow(conv).id), callMessages: [] }).system;
    const back = voice.thirdPartyContext({ call: ringBackRow(conv), callMessages: [] }).system;
    for (const text of [ins, turn, back]) {
      assert.ok(text.includes(manner.askedLine(first)), "the rule is in the prompt, with their first name");
      assert.match(text, /whether you're a real person, a robot, an AI, a recording or automated/);
      assert.match(text, new RegExp(`answer honestly and at once — "I'm an AI assistant calling for ${first}"`));
      assert.match(text, /then carry on with the call/);
      assert.match(text, /Never say or imply you are human/);
      assert.match(text, /never make up a person's name/);
      assert.match(text, /never dodge the question/);
      assert.doesNotMatch(text, /Hi there, this is Reason, an AI assistant calling for/);
    }
    // First name only, never the full name on the account.
    assert.doesNotMatch(manner.askedLine(first), /Mensah|Test/);
  }
});

test("Reason's call turn: no line said for it, no 'say you are an AI and recorded' to a new person or in another language", () => {
  const row = lineRow(OTHER);
  const s = start({ row });
  const call = db.getCall(OTHER, row.id);
  const sys = voice.thirdPartyContext({ call, callMessages: [] }).system;
  assert.doesNotMatch(sys, /said for you word for word/);
  assert.doesNotMatch(sys, /Your opening line was already spoken/);
  assert.ok(sys.includes(manner.plainOpenLine()));
  assert.ok(sys.includes(manner.NOT_RECORDED_LINE));
  assert.doesNotMatch(sys, /rather not be recorded/);
  // Somebody new comes on the line: caught up in a sentence, not announced at.
  const next = hold.newParty(call, { who: "the manager" });
  assert.equal(next.announce, false);
  assert.doesNotMatch(next.note, /AI assistant|recorded/);
  assert.match(next.note, /Do not introduce who or what you are\s+unless they ask/);
  // The call moves to Spanish: no disclosure to repeat.
  assert.equal(prompt.announcementAgainIn("Spanish", { ownerName: "Ama", recorded: false }), "");
  db.updateCall(OTHER, row.id, { language: "Spanish" });
  assert.doesNotMatch(voice.thirdPartyContext({ call: db.getCall(OTHER, row.id), callMessages: [] }).system, /say in Spanish that you are an AI assistant/);
  void s;
});

test("a place ringing back: a plain hello and what it is about — no 'this is Reason, an AI assistant', no recording line", () => {
  for (const conv of [C, OTHER]) {
    const row = ringBackRow(conv);
    assert.equal(row.announcement, "");
    const s = start({ row });
    assert.equal(s.call.talk, false);
    assert.equal(s.call.greeting, "Hi there! You're calling back about a table for two at 8 tonight — thanks for ringing back.");
    assert.doesNotMatch(s.call.greeting, OLD_LINE);
    assert.equal(s.call.notice.disclose, false);
  }
});

// ---------- 2. no audio of a third-party call ----------

test("no audio recording on a third-party call: not a byte is held while it runs, no file is written, and it is filed as not recorded — not as a lost recording", async () => {
  for (const conv of [C, OTHER]) {
    const row = lineRow(conv);
    let reads = 0;
    const s = start({ row, objectionJudge: async () => { reads += 1; return false; } });
    assert.equal(s.call.recorded, false);
    const live = await talkThenHangUp(s);
    // Nothing was ever held in memory, from the first frame.
    assert.equal(s.call.tape.caller.length, 0);
    assert.equal(s.call.tape.segs.length, 0);
    assert.equal(s.call.tape.seconds(), 0);
    assert.ok(s.call.tape.callerBytes > 0, "the call's clock still ran");
    // Nothing was written.
    assert.equal(live.recording, null);
    assert.equal(live.notRecorded, true);
    assert.equal(live.recordingWhy, manner.NOT_RECORDED_WHY);
    assert.equal(existsSync(recordingFileFor(row.id, "wav")), false);
    assert.equal(reads, 0, "no recording, so nothing is read for an objection to one");
    // What is still kept: the words.
    assert.match(live.transcript, /Them: Hello, Luigi's, can I help you\?/);
    assert.equal(live.state, "completed");
    // Filed on the row as by design, with no fault on the ledger.
    const filed = await fileRecording(conv, db.getCall(conv, row.id), live);
    assert.equal(filed.recording_state, "not_applicable");
    assert.equal(filed.recording_why, manner.NOT_RECORDED_WHY);
    assert.equal(filed.recording_file ?? null, null);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'call_recording'").get().n, 0);
  }
});

test("no audio recording on a ring-back either", async () => {
  const row = ringBackRow(OTHER);
  const s = start({ row });
  const live = await talkThenHangUp(s, { words: " Hi, yes, we do have that table." });
  assert.equal(s.call.tape.caller.length, 0);
  assert.equal(s.call.tape.segs.length, 0);
  assert.equal(live.recording, null);
  assert.equal(live.notRecorded, true);
  assert.equal(existsSync(recordingFileFor(row.id, "wav")), false);
});

test("their own call with Reason is untouched: still recorded, never marked not-recorded", async () => {
  const row = ownRow(C);
  const s = start({ row });
  assert.equal(s.call.recorded, true);
  for (let i = 0; i < 150; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  assert.ok(s.call.tape.caller.length > 0);
  assert.ok(s.call.tape.seconds() >= 2.9);
  assert.equal(s.call.tape.stopped, false);
  assert.equal(manner.callRecorded(row), true);
  assert.equal(manner.callRecorded(lineRow(C)), false);
  // An older provider announces and records itself: not changed here.
  assert.equal(manner.callRecorded({ is_owner: 0, provider: "bland" }), true);
});

test("after the call: Reason is told there is no audio by design, and never offers one", async () => {
  const row = lineRow(OTHER);
  const s = start({ row });
  const live = await talkThenHangUp(s);
  await fileRecording(OTHER, db.getCall(OTHER, row.id), live);
  const { thirdPartyEvent } = await import("../src/calls/postcall.js");
  const note = thirdPartyEvent({ row: db.getCall(OTHER, row.id), live });
  assert.match(note, /No audio recording was made of this call/);
  assert.match(note, /not a fault/);
  assert.doesNotMatch(note, /The recording is saved/);
  assert.doesNotMatch(note, /Every call is meant to be recorded/);
});

test("REASON_THIRDPARTY_RECORDING=on: the notice is said at the start, the call is recorded, and an objection stops it — still no 'this is Reason, an AI assistant'", async () => {
  config.thirdPartyRecording = true;
  const row = lineRow(OTHER);
  const s = start({ row, objectionJudge: async (t) => /don't want to be recorded/.test(t) });
  const ins = s.live.of("session.start")[0].session.instructions;
  assert.equal(gl.lineAnnouncement(), manner.RECORDING_NOTICE_LINE);
  assert.equal(db.getCall(OTHER, row.id).announcement, "Hi there — just so you know, this call may be recorded.");
  assert.match(ins, /just so you know, this call may be recorded/);
  assert.match(ins, /rather not be recorded/);
  assert.doesNotMatch(ins, /this is Reason, an AI assistant calling for/);
  assert.ok(ins.includes(manner.askedLine("Ama")));
  assert.equal(s.call.recorded, true);
  for (let i = 0; i < 150; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  assert.ok(s.call.tape.seconds() >= 2.9);
  s.live.emit({ type: "session.input_transcript.delta", delta: " I don't want to be recorded." });
  for (let i = 0; i < 100; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  assert.equal(s.call.recordingStopWhy, "objected");
  const kept = s.call.tape.seconds();
  for (let i = 0; i < 100; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  assert.equal(s.call.tape.seconds(), kept);
});

// ---------- 3. no-call hours: the why, the first allowed time, the override, their own hours ----------

const owner = (t) => ({ role: "user", content: `[Thu, Nov 12, 2026, 9:10 AM] Omari: ${t}` });
const LA = "+13105550142";
const SIX_TEN_LA = Date.parse("2026-11-12T06:10:00-08:00");
const setClock = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };

async function place(conv, input, { messages = [owner("call them")], kind = "user", calls = new FakeCallProvider() } = {}) {
  const asked = await runTool("confirm_request", { action: "call_place", summary: `ring ${input.to}`, target: trust.personPin("call_place", input) }, { conversationId: conv, messages: [owner("do it")] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: conv, messages: [owner("do it"), owner("yeah go")], judge: async () => ({ verdict: "yes" }) });
  const out = await runTool("call_place", { ...input, confirmation_id: asked.confirmation_id }, { conversationId: conv, calls, messages, kind });
  return { out, calls };
}

test("held by the hour: the refusal says what time it is THERE, why, and the first time it can be placed (their time and the user's)", async () => {
  setClock(SIX_TEN_LA);
  const { out, calls } = await place(C, { to: LA, goal: "ask what time they open" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "quiet_hours");
  assert.equal(calls.placed.length, 0);
  assert.equal(out.local_time, "6:10am");
  assert.equal(out.place, "Los Angeles");
  assert.equal(out.zone, "America/Los_Angeles");
  assert.equal(out.opens_local, "8am");
  assert.equal(out.opens_your_time, "11am", "the user is on Eastern time");
  assert.equal(out.opens_at, new Date(Date.parse("2026-11-12T08:00:00-08:00")).toISOString());
  assert.match(out.error, /it is 6:10am \(06:10\) in Los Angeles/);
  assert.match(out.error, /Nobody's phone rang/);
  assert.match(out.error, /offer to place the call at the first allowed time, 8am their time \(11am for the person you work for\)/);
  assert.match(out.error, /"it's 6:10am in Los Angeles, they're likely not open yet; I'll call at 8am their time, or say call now\."/);
  assert.match(out.error, /call_now_said/);
  // At the first allowed minute it goes through with no override.
  setClock(Date.parse(out.opens_at));
  assert.equal((await place(C, { to: LA, goal: "ask what time they open" })).out.ok, true);
});

test("override: \"call now anyway\" in their own words places that one call; the next one is held again", async () => {
  setClock(SIX_TEN_LA);
  const said = [owner("call the bakery in LA"), owner("call now anyway")];
  const { out, calls } = await place(C, { to: LA, goal: "ask what time they open", call_now_said: "call now anyway" }, { messages: said });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(calls.placed.length, 1);
  assert.match(out.placed_outside_call_hours, /It is 6:10am where they are .*placed anyway because Omari Test said: "call now anyway"\. This one call only\./);
  // One call, not a setting: a different call a minute later, with nothing said, is held.
  const next = await place(C, { to: "+13105550143", goal: "ask about a cake" }, { messages: [...said, owner("and ring the cake shop")] });
  assert.equal(next.out.status, "quiet_hours");
  assert.equal(db.callHours(C).hours, null, "their standing hours were not touched");
});

test("override is never inferred: words they did not say, an empty quote, or a turn they did not start all leave the call unplaced", async () => {
  setClock(SIX_TEN_LA);
  // The model quotes words that are not in what they said.
  const made = await place(C, { to: LA, goal: "ask what time they open", call_now_said: "call now anyway" }, { messages: [owner("call the bakery in LA when you can")] });
  assert.equal(made.out.ok, false);
  assert.equal(made.out.status, "quiet_hours");
  assert.match(made.out.error, /override was NOT accepted: those words are not in what they just said or wrote/);
  assert.equal(made.calls.placed.length, 0);
  // A turn Reason started itself (a timer, a wake) cannot carry an override, whatever is quoted.
  const self = await place(C, { to: LA, goal: "ask what time they open", call_now_said: "call now anyway" }, { messages: [owner("call now anyway")], kind: "timer" });
  assert.equal(self.out.status, "quiet_hours");
  assert.match(self.out.error, /not a turn they started/);
  assert.equal(self.calls.placed.length, 0);
  // Nothing quoted: held as before.
  const none = await place(C, { to: LA, goal: "ask what time they open", call_now_said: "  " }, { messages: [owner("call now anyway")] });
  assert.equal(none.out.status, "quiet_hours");
  assert.equal(brief.callNowSaid({ said: "Call NOW — anyway!", words: ["ok call now anyway"], kind: "user" }).ok, true);
  assert.equal(brief.callNowSaid({ said: "yes", words: [], kind: "user" }).ok, false);
});

test("per-person hours: they set their own by text, stored on their account, and it changes only their calls", async () => {
  // 9:30pm in LA: held by default for both accounts.
  setClock(Date.parse("2026-11-12T21:30:00-08:00"));
  assert.equal((await place(C, { to: LA, goal: "ask about a table" })).out.status, "quiet_hours");
  // Ama says so; the tool keeps her sentence with it.
  const amaSaid = { role: "user", content: "[Thu] Ama: you can call places until 11pm, not after" };
  const set = await runTool("call_hours_set", { hours: "23:00-08:00", said: "you can call places until 11pm" }, { conversationId: OTHER, messages: [amaSaid], kind: "user" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.hours, "23:00-08:00");
  assert.deepEqual({ hours: db.callHours(OTHER).hours, said: db.callHours(OTHER).said }, { hours: "23:00-08:00", said: "you can call places until 11pm" });
  assert.deepEqual(brief.callHoursFor(OTHER), { window: "23:00-08:00", own: true, said: "you can call places until 11pm", off: false });
  // Her 9:30pm call goes; the owner's is still held (his setting is his own).
  assert.equal((await place(OTHER, { to: LA, goal: "ask about a table" }, { messages: [amaSaid] })).out.ok, true);
  assert.equal((await place(C, { to: "+13105550150", goal: "ask about a table" })).out.status, "quiet_hours");
  assert.equal(brief.callHoursFor(C).own, false);
  // 11:30pm there: hers holds too, and the refusal says the hours are her own.
  setClock(Date.parse("2026-11-12T23:30:00-08:00"));
  const late = await place(OTHER, { to: "+13105550151", goal: "ask about a table" }, { messages: [amaSaid] });
  assert.equal(late.out.status, "quiet_hours");
  assert.match(late.out.error, /held between 11pm and 8am/);
  assert.match(late.out.error, /the hours this person set for their own calls/);
});

test("per-person hours: off, back to default, and only ever from their own words", async () => {
  setClock(Date.parse("2026-11-12T23:30:00-08:00"));
  const said = owner("turn off the no-call hours for my calls");
  // Not their words, or not their turn: nothing changes.
  const invented = await runTool("call_hours_set", { hours: "off", said: "sure, call whenever" }, { conversationId: C, messages: [said], kind: "user" });
  assert.equal(invented.ok, false);
  assert.match(invented.error, /only ever set from their own words/);
  const self = await runTool("call_hours_set", { hours: "off", said: "turn off the no-call hours" }, { conversationId: C, messages: [said], kind: "timer" });
  assert.equal(self.ok, false);
  assert.equal(db.callHours(C).hours, null);
  assert.equal((await runTool("call_hours_set", { hours: "whenever", said: "turn off the no-call hours" }, { conversationId: C, messages: [said], kind: "user" })).ok, false);
  // Off.
  const off = await runTool("call_hours_set", { hours: "off", said: "turn off the no-call hours" }, { conversationId: C, messages: [said], kind: "user" });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.hours, "off");
  assert.equal(db.callHours(C).hours, "off");
  assert.equal((await place(C, { to: LA, goal: "ask about a table" }, { messages: [said] })).out.ok, true);
  // Back to the default.
  const back = owner("go back to the normal call hours");
  const reset = await runTool("call_hours_set", { hours: "default", said: "go back to the normal call hours" }, { conversationId: C, messages: [back], kind: "user" });
  assert.equal(reset.ok, true);
  assert.equal(reset.theirs, false);
  assert.equal(db.callHours(C).hours, null);
  assert.equal((await place(C, { to: "+13105550152", goal: "ask about a table" }, { messages: [back] })).out.status, "quiet_hours");
});

test("the window is read the way people write it; a call to their own phone is never held", () => {
  assert.equal(brief.parseCallHours("21:00-08:00"), "21:00-08:00");
  assert.equal(brief.parseCallHours("9pm-8am"), "21:00-08:00");
  assert.equal(brief.parseCallHours("10:30pm to 7am"), "22:30-07:00");
  assert.equal(brief.parseCallHours("off"), "off");
  assert.equal(brief.parseCallHours("25:00-08:00"), null);
  assert.equal(brief.parseCallHours("soon"), null);
  const night = Date.parse("2026-11-12T23:30:00-05:00");
  assert.equal(brief.withinCallingHours({ now: night, toOwner: true, tz: "America/New_York" }).ok, true);
  assert.equal(brief.withinCallingHours({ now: night, window: "", tz: "America/New_York" }).ok, true);
  assert.equal(brief.withinCallingHours({ now: night, window: "off", tz: "America/New_York" }).ok, true);
  // Two clocks under one area code: the first allowed time is when it is morning on both.
  const idaho = brief.withinCallingHours({ now: Date.parse("2026-11-12T07:30:00-07:00"), tz: ["America/Boise", "America/Los_Angeles"], whose: "number" });
  assert.equal(idaho.ok, false);
  assert.equal(idaho.opens_at, new Date(Date.parse("2026-11-12T08:00:00-08:00")).toISOString());
});
