// GPT-Live phase 3 (src/calls/gptlive.js, "a line call"): the calls Reason makes to businesses and
// other people, and places ringing back about them, on GPT-Live behind REASON_THIRD_PARTY_VOICE.
// Silent opening, the disclosure word for word, key presses through Twilio, answering-machine
// detection and voicemail, hold and its budget, Reason's own third-party turn for every word, and a
// stranger's recording kept. This file is the puppet line (REASON_LINE_TALK=off); talk mode is
// test/gptlive-linetalk.test.js. No network: the voice session, the Twilio stream, the Twilio API and
// Reason's turn are stand-ins; every assertion reads what was sent or the database.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-gptlive3-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";

const gl = await import("../src/calls/gptlive.js");
const db = await import("../src/db.js");
const hold = await import("../src/calls/hold.js");
const strangerCalls = await import("../src/strangercalls.js");
const { announcementFor } = await import("../src/calls/provider.js");
const { config, clock } = await import("../src/config.js");
const { settleCall } = await import("../src/tools.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };
const ANN = announcementFor({ ownerName: "Omari" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM stranger_calls;");
  try { db.db.exec("DELETE FROM call_turns; DELETE FROM event_log;"); } catch { /* fresh db */ }
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  // REASON_THIRDPARTY_RECORDING=on here: this file drives the line that says a notice first, by code, and
  // records. The default since 2026-11-12 (no notice, no audio) is test/call-plain-open.test.js.
  Object.assign(config, { lineTalk: false, callIdentity: false, makerName: "Saafi Interactions Lab", callVoice: "gptlive", thirdPartyVoice: "owner", thirdPartyRecording: true, ...TWILIO });
});

const lineRow = (over = {}) => {
  const row = db.createCall(over.conversationId ?? C, {
    provider: "gptlive", toNumber: over.to ?? "+13105559999", isOwner: false, goal: over.goal ?? "ask whether they have a table for two at 7 tonight",
    facts: [], announcement: gl.lineAnnouncement(ANN), state: "placing", direction: over.direction,
  });
  db.updateCall(row.conversation_id, row.id, { opening_waits: 1, ...(over.fields ?? {}) });
  return db.getCall(row.conversation_id, row.id);
};

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
  const sent = [];
  const handlers = { msg: [], close: [] };
  let open = true;
  return {
    sent,
    open: () => open,
    send: (s) => sent.push(JSON.parse(s)),
    close: () => { open = false; handlers.close.forEach(f => f()); },
    onMessage: (f) => handlers.msg.push(f),
    onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
    media: () => sent.filter(m => m.event === "media"),
  };
}

function fakeLive() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  return {
    sent,
    socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()),
    emit: (e) => h.event.forEach(f => f(e)),
    of: (type) => sent.filter(e => e.type === type),
  };
}

// Loud enough to count as speech (hasSpeech), and silence.
const SPEECH = Buffer.alloc(160, 0x00).toString("base64");
const QUIET = Buffer.alloc(160, 0xff).toString("base64");

function startLine({ brain, row = lineRow(), api = null }) {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const finished = [];
  const posted = [];
  const twilioApi = api ?? (async (path, form) => { posted.push({ path, form }); return { ok: true, status: 200, json: {} }; });
  const call = new gl.GptLiveCall({
    call: row, twilio, openLive: () => live.socket, brain, now: timers.now, timers, twilioApi,
    judge: async () => null, finish: async (l) => { finished.push(l); },
  });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  return { call, timers, twilio, live, finished, posted, row };
}

/** Their side says something; Reason's turn runs once they pause. */
async function theySay(s, text) {
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  s.live.emit({ type: "session.input_transcript.delta", delta: ` ${text}` });
  await s.timers.advance(gl.LINE_QUIET_MS + 10);
}

/** The voice says what it was asked to, as audio and its transcript (after the words' ack). */
async function voiceSays(s, text) {
  const say = s.live.of("session.commentary.append").at(-1);
  if (say && s.call.gate && !s.call.gate.acked) s.live.emit({ type: "session.commentary.appended", client_event_id: say.event_id });
  s.live.emit({ type: "session.output_transcript.delta", delta: text });
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  await s.timers.advance(20);
}

// ---------- who gets it ----------

test("the flag: owner = the operator's errands only, gptlive = everyone's, unset = nobody's; the routes are listened for", () => {
  assert.equal(gl.thirdPartyVoiceFor(C), true);
  assert.equal(gl.thirdPartyVoiceFor(OTHER), false, "owner: another person's errands stay on the wrapped provider");
  config.thirdPartyVoice = "gptlive";
  assert.equal(gl.thirdPartyVoiceFor(OTHER), true);
  config.thirdPartyVoice = "";
  assert.equal(gl.thirdPartyVoiceFor(C), false);
  config.callVoice = "";
  assert.equal(gl.gptliveOn(), false);
  config.thirdPartyVoice = "owner";
  assert.equal(gl.gptliveOn(), true, "phase 3 alone still opens the stream and webhooks");
});

test("place: an errand on GPT-Live dials with async AMD, opens silent; the row's line is the recording notice (recorded) or nothing (the default), never the older provider's AI line; everything else as before", async () => {
  const innerCalls = [];
  const inner = { place: async (a) => { innerCalls.push(a); return { ok: true, externalId: "conv_x" }; }, check: async () => ({}), status: () => ({}) };
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push({ url, body: String(init.body) }); return { ok: true, status: 201, json: async () => ({ sid: "CA77" }) }; };
  const p = gl.withGptLive(inner, { fetchImpl });
  const row = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "a table", facts: [], announcement: ANN, state: "placing" });
  const out = await p.place({ to: "+13105559999", kind: "third_party", conversationId: C, callId: row.id, announcement: ANN });
  assert.equal(out.provider, "gptlive");
  assert.equal(out.openingWaits, true);
  const form = new URLSearchParams(posted[0].body);
  assert.equal(form.get("MachineDetection"), "DetectMessageEnd");
  assert.equal(form.get("AsyncAmd"), "true");
  assert.equal(form.get("AsyncAmdStatusCallback"), `https://reason.example.test/calls/gptlive/amd/${row.webhook_token}`);
  assert.doesNotMatch(form.get("Twiml"), /<Say|<Play/, "nothing is said at pick-up");
  const ann = db.getCall(C, row.id).announcement;
  assert.equal(ann, "Hi there — just so you know, this call may be recorded.");
  assert.deepEqual([out.recorded, out.announced], [true, ann]);
  // The default: not recorded, and nothing is said first by code.
  config.thirdPartyRecording = false;
  const plain = db.createCall(C, { provider: "gptlive", toNumber: "+13105559997", isOwner: false, goal: "a table", facts: [], announcement: ANN, state: "placing" });
  const plainOut = await p.place({ to: "+13105559997", kind: "third_party", conversationId: C, callId: plain.id, announcement: ANN });
  assert.equal(db.getCall(C, plain.id).announcement, "");
  assert.deepEqual([plainOut.recorded, plainOut.announced], [false, ""]);
  config.thirdPartyRecording = true;

  // Another user's errand on =owner, and every errand with the flag unset: the wrapped provider.
  const theirs = db.createCall(OTHER, { provider: "gptlive", toNumber: "+13105559998", isOwner: false, goal: "x", facts: [], announcement: ANN, state: "placing" });
  await p.place({ to: "+13105559998", kind: "third_party", conversationId: OTHER, callId: theirs.id });
  config.thirdPartyVoice = "";
  await p.place({ to: "+13105559999", kind: "third_party", conversationId: C, callId: row.id });
  assert.equal(innerCalls.length, 2);
  // An own call is untouched: no AMD on it.
  const own = db.createCall(C, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "hey Omari", state: "placing" });
  config.thirdPartyVoice = "owner";
  await p.place({ to: "+12025551234", kind: "owner", conversationId: C, callId: own.id });
  assert.equal(new URLSearchParams(posted.at(-1).body).get("MachineDetection"), null);
});

// ---------- 1. silent opening, then the disclosure ----------

test("silent opening: nothing reaches the line until their side speaks; then the disclosure, word for word, from Reason's turn", async () => {
  const asked = [];
  const s = startLine({
    brain: async (messages) => { asked.push(messages); return { text: `${gl.lineAnnouncement(ANN)} Do you have a table for two at seven tonight?`, tools: [], calls: [], endCall: null }; },
  });
  const start = s.live.of("session.start")[0];
  assert.match(start.session.instructions, /never speak on your own/);
  assert.equal(start.session.input, undefined, "no greeting asked for");
  assert.equal(s.live.of("session.commentary.append").length, 0, "no greeting");
  // The voice says something of its own at pick-up: dropped, and never part of the call.
  await voiceSays(s, "Hello?");
  assert.equal(s.twilio.media().length, 0, "nothing of the voice's own reaches the line");
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Luigi's, how can I help?" });
  await s.timers.advance(gl.LINE_QUIET_MS - 300);
  // The voice answers them itself, just before Reason's words are ready: still dropped.
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  await s.timers.advance(310);
  assert.equal(asked.length, 1, "their words went to Reason");
  assert.deepEqual(asked[0], [{ role: "user", content: "Luigi's, how can I help?" }]);
  // The voice was talking (on its own, never played): stopped first, told nobody heard it…
  const stop = s.live.of("session.instructions.append").at(-1);
  assert.match(stop.content, /Stop speaking now.*Nothing you said on your own reached the other side/);
  assert.equal(s.live.of("session.commentary.append").length, 0, "…and only then handed the words");
  // …which it keeps up for a moment: still dropped.
  s.live.emit({ type: "session.output_transcript.delta", delta: "…to make a reservation" });
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  assert.equal(s.twilio.media().length, 0, "the voice's own tail never reaches the line");
  await s.timers.advance(gl.LINE_BUSY_MS + 200);
  const say = s.live.of("session.commentary.append").at(-1);
  assert.equal(say.delegation_id, null);
  assert.equal(s.call.gate.acked, true, "quiet now, so the words play from their first frame");
  assert.match(say.content, /Hi there — just so you know, this call may be recorded\./);
  assert.doesNotMatch(say.content, /this is Reason, an AI assistant calling for/);
  await voiceSays(s, "Hey, hi — this is Reason, an AI assistant calling for Omari.");
  assert.doesNotMatch(s.call.turns.map(t => t.text).join(" "), /reservation/, "and is not in the call's record");
  assert.equal(s.twilio.media().length, 1, "the words Reason handed over are played");
  assert.deepEqual(s.call.messages().map(m => m.role), ["user", "assistant"]);
  // Once that speech has gone quiet, the line shuts again.
  await s.timers.advance(gl.LINE_GATE_QUIET_MS + 100);
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  assert.equal(s.twilio.media().length, 1);
});

test("the voice's own hand-off on a line call: its acknowledgement cancelled, Reason's turn started by the line, the words its result", async () => {
  let n = 0;
  const s = startLine({ brain: async () => { n++; return { text: "Hi — this is Reason.", tools: [], calls: [], endCall: null }; } });
  assert.deepEqual(s.live.of("session.start")[0].session.delegation, { type: "client", acknowledgement_delay_ms: 800 });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d1" } });
  await s.timers.advance(10);
  assert.equal(n, 0, "the hand-off alone does not run a turn");
  const quiet = s.live.of("session.thinking.append").find(e => e.delegation_id === "d1");
  assert.equal(quiet.content, "", "an empty quiet update cancels the automatic acknowledgement");
  await theySay(s, "Hello?");
  assert.equal(n, 1);
  const said = s.live.of("session.commentary.append").at(-1);
  assert.equal(said.delegation_id, "d1", "Reason's words are the hand-off's result");
  assert.equal(said.content, "Hi — this is Reason.");
});

test("words while a turn runs: the answer is said and no second turn; a silent answer reads the line again", async () => {
  let release;
  let n = 0;
  const s = startLine({ brain: () => { n++; return new Promise(r => { release = r; }); } });
  await theySay(s, "Hello?");
  assert.equal(n, 1);
  await theySay(s, "Hello, anyone there?");
  assert.equal(n, 1, "not a second turn while one runs");
  release({ text: "Hi! Sorry — this is Reason.", tools: [], calls: [], endCall: null });
  await s.timers.advance(10);
  assert.equal(n, 1, "the answer covers them");
  await theySay(s, "Press 1 for bookings.");
  assert.equal(n, 2);
  await theySay(s, "Press 2 for hours.");
  release({ text: "", tools: ["skip_turn"], calls: [{ name: "skip_turn", args: {} }], endCall: null, skip: true });
  await s.timers.advance(10);
  assert.equal(n, 3, "nothing was said, so the line is read again with the new words");
});

// ---------- 2. the keypad ----------

test("keypad: Reason's play_keypad_touch_tone is pressed through Twilio, the stream comes back on the same call, the voice is told", async () => {
  const row = lineRow();
  const s = startLine({ row, brain: async () => ({ text: "", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "1" } }], endCall: null }) });
  await theySay(s, "Thanks for calling Luigi's. For reservations press 1. For hours press 2.");
  assert.equal(s.posted.length, 1);
  assert.equal(s.posted[0].path, "/Calls/CA1.json");
  assert.match(s.posted[0].form.Twiml, /<Play digits="w1"\/><Connect><Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//);
  assert.match(s.posted[0].form.Twiml, new RegExp(row.webhook_token));
  assert.match(s.live.of("session.thinking.append").at(-1).content, /Reason pressed 1 on the keypad/);
  // The menu's tail heard while that turn ran is not read again: the key answered it.
  assert.equal(s.posted.length, 1);
  assert.equal(s.twilio.media().length, 0, "nothing said into the menu");
  // Twilio stops the old stream to play the digits: not the end of the call.
  s.twilio.say({ event: "stop" });
  s.twilio.close();
  await s.timers.advance(50);
  assert.equal(s.finished.length, 0);
  // …and connects a new one to the same call (as acceptStream hands it over).
  const again = fakeTwilio();
  s.call.rejoin(again);
  again.say({ event: "start", start: { streamSid: "MZ2", callSid: "CA1" } });
  assert.equal(s.call.rejoining, null);
  assert.equal(s.live.of("session.start").length, 1, "the same voice session carries on");
  s.call.gate = { since: s.timers.now(), heard: false, lastSpeech: s.timers.now(), acked: true };
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  assert.equal(again.media()[0].streamSid, "MZ2", "audio goes down the new stream");
});

test("keypad: a stream that never comes back ends the call; junk in the tones is never sent to Twilio", async () => {
  const s = startLine({ brain: async () => ({ text: "", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "1\"/><Hangup/>" } }], endCall: null }) });
  await theySay(s, "Press 1 for sales.");
  assert.match(s.posted[0].form.Twiml, /<Play digits="w1"\/>/);
  assert.doesNotMatch(s.posted[0].form.Twiml, /Hangup/);
  s.twilio.close();
  await s.timers.advance(gl.LINE_REJOIN_MS + 10);
  await s.timers.advance(3500);
  assert.equal(s.finished.length, 1);
  assert.match(s.finished[0].termination, /did not come back/);
});

test("keypad: acceptStream hands the new stream to the running call", async () => {
  const row = lineRow();
  db.updateCall(C, row.id, { state: "in_progress" });
  const live = fakeLive();
  const first = fakeTwilio();
  const call = gl.acceptStream({ token: row.webhook_token, socket: first, openLive: () => live.socket, log: () => {} });
  assert.ok(call);
  first.say({ event: "start", start: { streamSid: "MZa", callSid: "CAa" } });
  assert.equal(gl.acceptStream({ token: row.webhook_token, socket: fakeTwilio(), log: () => {} }), null, "a second stream is refused…");
  call.rejoining = { at: Date.now(), digits: "1" };
  const second = fakeTwilio();
  assert.equal(gl.acceptStream({ token: row.webhook_token, socket: second, log: () => {} }), call, "…unless a key press is bringing it back");
  call.done = true;
  clearTimeout(call.capTimer);
});

// ---------- 3. answering machines and voicemail ----------

test("AMD: a machine's beep has Reason leave the voicemail under its own rules, then hang up; the row says one message was left", async () => {
  const asked = [];
  const row = lineRow();
  const s = startLine({
    row,
    brain: async (messages) => {
      asked.push(messages);
      // What Reason's turn does on a machine: the message in end_call, written down by hold.noteVoicemail.
      hold.noteVoicemail(db.getCall(C, row.id), { message: "Hi, this is Reason, an AI assistant calling for Omari, about a table for two tonight." });
      return { text: "", tools: ["end_call"], calls: [{ name: "end_call", args: {} }], endCall: { message: "Hi, this is Reason, an AI assistant calling for Omari, about a table for two tonight." } };
    },
  });
  s.call.amd("machine_end_beep");
  await s.timers.advance(10);
  assert.equal(db.getCall(C, row.id).outcome_kind, "voicemail_left");
  assert.match(asked[0].at(-1).content, /machine took this call.*voicemail_greeting.*phone menu/s);
  assert.match(s.live.of("session.commentary.append").at(-1).content, /calling for Omari, about a table/);
  await voiceSays(s, "Hi, this is Reason.");
  await s.timers.advance(5000);
  await s.timers.advance(3500);
  assert.equal(s.finished.length, 1, "hung up once the message was said");
});

test("AMD on a phone menu: Twilio's 'machine' is only a fact for Reason's turn, which keeps pressing; nothing is left as a voicemail", async () => {
  const row = lineRow();
  const asked = [];
  const s = startLine({
    row,
    brain: async (messages) => {
      asked.push(messages.at(-1).content);
      hold.noteMachineLine(db.getCall(C, row.id), { what: "phone_menu" });
      return { text: "", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "0" } }], endCall: null };
    },
  });
  await theySay(s, "For reservations press 1, for everything else press 0.");
  s.call.amd("machine_end_silence");
  await s.timers.advance(10);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /Twilio's answering-machine check/);
  assert.equal(db.getCall(C, row.id).outcome_kind, "machine_menu", "not filed as a mailbox");
  assert.equal(Number(db.getCall(C, row.id).voicemail_left), 0);
  assert.equal(s.live.of("session.commentary.append").length, 0, "nothing said into the menu");
  assert.equal(s.posted.length, 2, "and each key press answered the menu once — no second read of the same words");
});

test("voicemail before the beep: the message waits for Twilio's verdict, then goes onto the tape", async () => {
  const row = lineRow();
  const s = startLine({
    row,
    brain: async () => {
      hold.noteMachine(db.getCall(C, row.id), {});
      return { text: "", tools: ["end_call"], calls: [], endCall: { message: "Hi, it's Reason for Omari." } };
    },
  });
  await theySay(s, "You've reached Luigi's. Leave a message after the tone.");
  assert.equal(s.live.of("session.commentary.append").length, 0, "held: the greeting has not ended");
  s.call.amd("machine_end_beep");
  await s.timers.advance(10);
  assert.match(s.live.of("session.commentary.append").at(-1).content, /Hi, it's Reason for Omari/);
});

test("AMD: a person changes nothing; a fax is hung up on as a dead end; a verdict before the session waits for it", async () => {
  let n = 0;
  const s = startLine({ brain: async () => { n++; return { text: "", tools: [], calls: [], endCall: null }; } });
  s.call.amd("human");
  await s.timers.advance(10);
  assert.equal(n, 0);
  assert.equal(s.finished.length, 0);
  const row2 = lineRow({ to: "+13105559997" });
  const f = startLine({ row: row2, brain: async () => ({ text: "", tools: [], calls: [], endCall: null }) });
  f.call.amd("fax");
  await f.timers.advance(3500);
  assert.equal(f.finished.length, 1);
  assert.equal(db.getCall(C, row2.id).outcome_kind, "voicemail_full");
  // Before the session started: kept, then acted on.
  const twilio = fakeTwilio();
  const live = fakeLive();
  const early = new gl.GptLiveCall({ call: lineRow({ to: "+13105559996" }), twilio, openLive: () => live.socket, brain: async () => ({ text: "", tools: [], calls: [] }), timers: fakeTimers(), twilioApi: async () => ({ ok: true }) });
  early.amd("machine_end_silence");
  assert.equal(early.amdLater, "machine_end_silence");
  early.done = true;
});

test("AMD webhook: Twilio-signed only; a verdict that beats the stream is handed to it when it connects", async () => {
  const row = lineRow();
  const url = `${config.publicUrl}${gl.AMD_PATH}${row.webhook_token}`;
  const params = { CallSid: "CA1", AnsweredBy: "machine_end_beep", MachineDetectionDuration: "4200" };
  const rawBody = new URLSearchParams(params).toString();
  assert.equal((await gl.amdRequest({ token: row.webhook_token, rawBody, headers: { "x-twilio-signature": "nope" } })).status, 403);
  assert.equal((await gl.amdRequest({ token: "nope", rawBody, headers: {} })).status, 404);
  assert.equal((await gl.amdRequest({ token: row.webhook_token, rawBody, headers: { "x-twilio-signature": gl.twilioSignature(url, params) } })).status, 204);
  db.updateCall(C, row.id, { state: "in_progress" });
  const live = fakeLive();
  const call = gl.acceptStream({ token: row.webhook_token, socket: fakeTwilio(), openLive: () => live.socket, log: () => {} });
  assert.equal(call.amdVerdict, "machine_end_beep");
  call.done = true;
});

// ---------- 4. hold ----------

test("hold: silent while waiting; past the budget Reason's turn rings off politely (hold_gave_up); a person back resumes", async () => {
  let n = 0;
  const notes = [];
  const row = lineRow({ fields: { hold_budget_s: 120 } });
  const s = startLine({
    row,
    brain: async (messages) => {
      n++;
      notes.push(messages.at(-1)?.content ?? "");
      const fresh = db.getCall(C, row.id);
      const wait = hold.noteWaiting(fresh, {});
      if (!wait.wait) {
        db.updateCall(C, row.id, { outcome_kind: "hold_gave_up" });
        return { text: wait.line, tools: ["end_call"], calls: [], endCall: { message: "" } };
      }
      return { text: "", tools: ["skip_turn"], calls: [{ name: "skip_turn", args: {} }], endCall: null, skip: true };
    },
  });
  await theySay(s, "Please hold, your call is important to us.");
  assert.equal(n, 1);
  assert.ok(hold.onHold(db.getCall(C, row.id)), "the wait clock is running (hold_since)");
  // Hold music, no words: nothing said and no turns while there is budget.
  for (let i = 0; i < 6; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(gl.LINE_HOLD_TICK_MS); }
  assert.equal(n, 1, "no turn while there is budget left");
  assert.equal(s.twilio.media().length, 0);
  assert.equal(s.finished.length, 0, "never hung up while holding");
  // Past the budget: one more turn, and its wait rule gives up.
  db.updateCall(C, row.id, { hold_since: clock.now() - 200_000 });
  await s.timers.advance(gl.LINE_HOLD_TICK_MS);
  assert.equal(n, 2);
  assert.match(notes[1], /Still on hold/);
  assert.match(s.live.of("session.commentary.append").at(-1).content, /I've been holding a while/);
  assert.equal(db.getCall(C, row.id).outcome_kind, "hold_gave_up");
});

test("hold: a person coming back is words on the line, and Reason's turn takes the call off hold", async () => {
  const row = lineRow();
  let first = true;
  const s = startLine({
    row,
    brain: async () => {
      const fresh = db.getCall(C, row.id);
      if (first) { first = false; hold.noteWaiting(fresh, {}); return { text: "", tools: ["skip_turn"], calls: [], skip: true, endCall: null }; }
      hold.noteSpeaking(fresh, {});
      return { text: "No problem at all — a table for two at seven?", tools: [], calls: [], endCall: null };
    },
  });
  await theySay(s, "Please hold.");
  assert.ok(hold.onHold(db.getCall(C, row.id)));
  await s.timers.advance(30_000);
  await theySay(s, "Hi, sorry about that, how can I help?");
  assert.equal(hold.onHold(db.getCall(C, row.id)), false);
  assert.match(s.live.of("session.commentary.append").at(-1).content, /No problem at all/);
});

test("a line where nobody ever says anything is ended, not kept open to the cap", async () => {
  const s = startLine({ brain: async () => ({ text: "", tools: [], calls: [] }) });
  await s.timers.advance(gl.LINE_SILENT_MS + gl.LINE_HOLD_TICK_MS);
  await s.timers.advance(3500);
  assert.equal(s.finished.length, 1);
  assert.match(s.finished[0].termination, /nobody said anything/);
});

// ---------- 5. the errand's own turn, and what is kept ----------

test("settle: a line call's turns feed memory as call events, the transcript and audio are kept, the row is its own", async () => {
  const row = lineRow();
  db.updateCall(C, row.id, { state: "in_progress" });
  const live = {
    state: "completed", outcome: "", summary: "", transcript: "Them: Luigi's, how can I help?\nReason: Hey, hi — this is Reason.", turns: [{ who: "them", text: "Luigi's, how can I help?" }, { who: "reason", text: "Hey, hi — this is Reason." }],
    durationS: 40, costCents: 3, termination: "end_call", recording: null, recordingWhy: "test",
  };
  const settled = await gl.settleGptLive({ row: db.getCall(C, row.id), live, settle: settleCall, log: () => {} });
  assert.equal(settled.state, "completed");
  const evs = db.db.prepare("SELECT role, content FROM event_log WHERE conversation_id = ? AND channel = 'call'").all(C);
  assert.deepEqual(evs.map(e => e.role), ["call_user", "call_assistant"]);
  assert.equal(JSON.stringify(db.loadConversation(C)), "[]", "a third-party call is not written into the thread");
});

// ---------- ring-backs ----------

test("a place ringing back about an errand: GPT-Live on =owner, the disclosure said at once, the errand's brief and budget kept", async () => {
  const errand = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "a table for two at 7 tonight", facts: ["party of two"], announcement: ANN, state: "completed" });
  db.updateCall(C, errand.id, { brief: JSON.stringify({ goal: "a table for two at 7 tonight" }), hold_budget_s: 240, outcome_kind: "voicemail_left", ended_at: clock.now() });
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  const ring = (from, sid) => {
    const params = { CallSid: sid, From: from, To: "+16562167455" };
    return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) } });
  };
  const out = ring("+13105559999", "CA_back");
  assert.match(out.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//);
  const back = db.db.prepare("SELECT * FROM calls WHERE external_id = 'gptlive:CA_back'").get();
  assert.equal(back.is_owner, 0);
  assert.equal(back.direction, "in");
  assert.equal(back.hold_budget_s, 240);
  assert.match(back.goal, /ringing back about: a table for two/);
  // The call itself: the disclosure, word for word, before anything else.
  const s = startLine({ row: back, brain: async () => ({ text: "", tools: [], calls: [] }) });
  const first = s.live.of("session.commentary.append")[0];
  assert.match(first.content, /Hi there — just so you know, this call may be recorded\. You're calling back about a table for two at 7 tonight/);
  assert.doesNotMatch(first.content, /this is Reason, an AI assistant calling for/);
  // Flag unset: still the errand line on GPT-Live (there is no other voice to hand it to), never a Redirect.
  config.thirdPartyVoice = "";
  const again = ring("+13105559999", "CA_back2").body;
  assert.match(again, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//);
  assert.doesNotMatch(again, /<Redirect|eleven/i);
  const back2 = db.db.prepare("SELECT * FROM calls WHERE external_id = 'gptlive:CA_back2'").get();
  assert.equal(back2.is_owner, 0, "a ring-back is the errand line, not an owner call");
});

// ---------- an owner call is untouched ----------

test("an own call with phase 3 on is exactly as before: greeted through commentary, its own audio played, delegation answered", async () => {
  const row = db.createCall(C, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey Omari, it's Reason.", state: "placing" });
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain: async () => ({ text: "Sure.", tools: [], endCall: null }), now: timers.now, timers });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "l" } });
  assert.equal(call.line, false);
  assert.match(live.of("session.commentary.append")[0].content, /Hey Omari, it's Reason/);
  assert.match(live.of("session.start")[0].session.instructions, /^You are Reason, Omari's personal assistant/);
  live.emit({ type: "session.output_audio.delta", delta: QUIET });
  assert.equal(twilio.media().length, 1, "no gate on an own call");
  call.done = true;
});

// ---------- 6. a stranger's call is recorded, as it says ----------

test("a stranger's GPT-Live call keeps its audio on their row (as the intro says), and drops it with their words", async () => {
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  const params = { CallSid: "CA_s3", From: "+14155550177", To: "+16562167455" };
  const out = gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) } });
  const token = out.body.match(/stream\/([0-9a-f]{32})/)[1];
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const generate = async function* () { yield { type: "text", text: "It's an assistant you text. heyreason.com. END" }; };
  const call = gl.acceptStream({ token, socket: twilio, openLive: () => live.socket, generate, log: () => {} });
  call.timers = timers; call.now = timers.now; call.judge = async () => null;
  twilio.say({ event: "start", start: { streamSid: "MZ9", callSid: "CA_s3" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_s" } });
  for (let i = 0; i < 100; i++) twilio.say({ event: "media", media: { payload: SPEECH } });
  live.emit({ type: "session.input_transcript.delta", delta: " What is this?" });
  const ended = call.end("caller hung up");
  await timers.advance(3500);
  await ended;
  const kept = db.db.prepare("SELECT * FROM stranger_calls WHERE phone IN (SELECT value FROM json_each(?))").get(JSON.stringify(db.restcrypt.blindIndexes("phone", "+14155550177")));
  assert.ok(kept.recording_path, "the audio is kept");
  assert.match(kept.recording_path, /stranger-\d+\.wav$/);
  assert.ok(existsSync(kept.recording_path));
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls WHERE to_number = ?").get("+14155550177").n, 0, "still no call row");
  // Retention: with their words, the audio goes.
  strangerCalls.prune({ content: clock.now() + 1, records: 0 });
  assert.equal(existsSync(kept.recording_path), false);
  assert.equal(db.db.prepare("SELECT recording_path FROM stranger_calls WHERE id = ?").get(kept.id).recording_path, null);
  // A withheld caller is kept on a row of its own that matches nobody.
  const p2 = { CallSid: "CA_w", From: "anonymous", To: "+16562167455" };
  gl.inboundTwiml({ rawBody: new URLSearchParams(p2).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, p2) } });
  const w = db.db.prepare("SELECT * FROM stranger_calls WHERE external_id = 'gptlive:CA_w'").get();
  assert.equal(w.phone, "");
});

test("readTurn: platform tools come back with their arguments", async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "play_keypad_touch_tone", arguments: "{\"dtmf_tones\":" } }] } }] })}\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"2\"}" } }] } }] })}\n`,
    "data: [DONE]\n",
  ];
  const out = await gl.readTurn((async function* () { for (const c of chunks) yield c; })());
  assert.deepEqual(out.calls, [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "2" } }]);
  assert.deepEqual(out.tools, ["play_keypad_touch_tone"]);
});

test("the first person after a menu and hold still gets the disclosure from code; a genuinely second person is the model's to tell", () => {
  const row = lineRow();
  hold.noteMachineLine(row, { what: "phone_menu" });
  const first = hold.newParty(row, { who: "Sam" });
  assert.equal(first.announce, false);
  assert.equal(first.party, 1, "not counted as a second party");
  assert.match(first.note, /said for you, word for word/);
  assert.equal(hold.openingOwed(db.getCall(C, row.id)), true, "so the turn puts the disclosure in front of its words");
  hold.markAnnounced(row, { party: 1 });
  const second = hold.newParty(row, { who: "the manager" });
  assert.equal(second.announce, true);
  assert.equal(second.party, 2);
});

// ---------- the independent review's findings (2026-10-31) ----------

test("review 1+2: a voicemail held for the beep is the call's last word — no more turns — and one never said is not 'left'", async () => {
  const row = lineRow();
  let n = 0;
  const s = startLine({
    row,
    brain: async () => {
      n++;
      const fresh = db.getCall(C, row.id);
      hold.noteMachine(fresh, {});
      hold.noteVoicemail(fresh, { message: "Hi, it's Reason for Omari." });
      return { text: "", tools: ["end_call"], calls: [], endCall: { message: "Hi, it's Reason for Omari." } };
    },
  });
  await theySay(s, "You've reached Luigi's.");
  assert.equal(n, 1);
  assert.ok(s.call.heldVoicemail, "held: no beep yet");
  await theySay(s, "Please leave a message after the tone.");
  assert.equal(n, 1, "the rest of the greeting is not another turn");
  // The mailbox hangs up before the beep: nothing was said, so nothing was left.
  s.twilio.say({ event: "stop" });
  await s.timers.advance(3500);
  const after = db.getCall(C, row.id);
  assert.equal(after.outcome_kind, "voicemail_no_message");
  assert.equal(Number(after.voicemail_left), 0);
});

test("review 4: a turn that speaks AND presses says its words first, then presses", async () => {
  const s = startLine({ brain: async () => ({ text: "Sorry, one moment.", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "2" } }], endCall: null }) });
  await theySay(s, "Press 2 to speak to someone.");
  assert.equal(s.posted.length, 0, "not pressed while the words are still to be said");
  assert.equal(s.live.of("session.commentary.append").at(-1).content, "Sorry, one moment.");
  await voiceSays(s, "Sorry, one moment.");
  await s.timers.advance(gl.LINE_GATE_QUIET_MS + 500);
  assert.equal(s.posted.length, 1);
  assert.match(s.posted[0].form.Twiml, /<Play digits="w2"\/>/);
});

test("review 5: no second turn while the first is still carrying out its key press", async () => {
  let release;
  let n = 0;
  const api = (path, form) => new Promise(r => { release = () => r({ ok: true, status: 200, json: {} }); });
  const s = startLine({ api, brain: async () => { n++; return { text: "", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "1" } }], endCall: null }; } });
  await theySay(s, "For reservations press 1.");
  assert.equal(n, 1);
  await theySay(s, "For hours press 2.");
  assert.equal(n, 1, "the press is still going to Twilio: no overlapping turn");
  release();
  await s.timers.advance(50);
  await theySay(s, "press 2.");
  assert.equal(n, 1, "late words from the menu just answered are not a turn while the stream comes back");
});

test("review 6: a machine verdict during a turn that spoke is read once those words are said", async () => {
  let release;
  const notes = [];
  const s = startLine({ brain: (messages) => { notes.push(messages.at(-1).content); return notes.length === 1 ? new Promise(r => { release = r; }) : Promise.resolve({ text: "", tools: [], calls: [], endCall: null }); } });
  await theySay(s, "Hi there!");
  s.call.amd("machine_end_beep");
  release({ text: "Hi — this is Reason.", tools: [], calls: [], endCall: null });
  await s.timers.advance(10);
  assert.equal(notes.length, 1, "not over the words being said");
  await voiceSays(s, "Hi — this is Reason.");
  await s.timers.advance(gl.LINE_GATE_QUIET_MS + 500);
  assert.equal(notes.length, 2);
  assert.match(notes[1], /answering-machine check/);
});

test("review 8: the first-person disclosure floor is GPT-Live's only; another provider's call is as before", () => {
  const row = db.createCall(C, { provider: "bland", toNumber: "+13105559990", isOwner: false, goal: "x", facts: [], announcement: ANN, state: "in_progress" });
  db.updateCall(C, row.id, { opening_waits: 1 });
  const r = hold.newParty(db.getCall(C, row.id), { who: "Sam" });
  assert.equal(r.party, 2);
  assert.equal(r.announce, true);
});

test("review 3: a stranger's recording is in the data export and goes with a data delete", async () => {
  const { deleteData, exportData } = await import("../src/data.js");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const kept = strangerCalls.open({ phone: "+14155550166", externalId: "gptlive:CA_x" });
  const path = strangerCalls.recordingPathFor(kept.id);
  mkdirSync(join(dir, "recordings"), { recursive: true });
  writeFileSync(path, Buffer.alloc(100));
  db.db.prepare("UPDATE stranger_calls SET recording_path = ?, matched_conversation_id = ? WHERE id = ?").run(path, OTHER, kept.id);
  const ex = exportData({ conversation: OTHER, audio: false, files: false });
  assert.ok(ex.recordings.some(r => r.stranger_call_id === kept.id && r.file === path));
  assert.equal(exportData({ conversation: C, audio: false, files: false }).recordings.some(r => r.stranger_call_id), false, "nobody else's");
  const out = await deleteData({ conversation: OTHER });
  assert.equal(existsSync(path), false);
  assert.equal(out.rows.stranger_calls, 1);
});
