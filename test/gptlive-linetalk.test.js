// GPT-Live business calls that TALK (REASON_LINE_TALK, default on; 2026-10-31, call 59). Once a person
// answers, the voice talks with them itself, like an own call; code keeps it silent before anybody is
// there, stops a stale line turn from talking over it, ignores Twilio's 30 s "machine" guess once a
// person is talking, says the recording line only where the law wants it (src/calls/consent.js), and
// tells the owner how the call really went. Same stand-ins as test/gptlive-thirdparty.test.js.
// (The header below is that file's.) GPT-Live phase 3 (src/calls/gptlive.js, "a line call"): the calls Reason makes to businesses and
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

const dir = mkdtempSync(join(tmpdir(), "reason-linetalk-"));
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
  Object.assign(config, { lineTalk: true, callIdentity: false, makerName: "Saafi Interactions Lab", callVoice: "gptlive", thirdPartyVoice: "owner", ...TWILIO });
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


const { recordingNoticeFor, ALL_PARTY_STATES } = await import("../src/calls/consent.js");
const { thirdPartyEvent } = await import("../src/calls/postcall.js");

const BRIEF = JSON.stringify({ goal: "Ask which service they would recommend for low back pain, and how much an hour costs. Asking only.", facts: [], questions: ["Which service for low back pain?", "How much for 60 minutes?"], cannotAgree: [], approved: { book: false, maxCents: null, terms: [], upTo: "" }, readBack: [], requirements: {}, place: "", language: "en" });
const bizRow = (over = {}) => lineRow({ to: "+16468580667", goal: "ask which service for low back pain and the hour price", ...over, fields: { brief: BRIEF, ...(over.fields ?? {}) } });

/** The voice talks on its own (no words handed over): audio first, then its transcript. */
async function voiceOwn(s, text) {
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  s.live.emit({ type: "session.output_transcript.delta", delta: text });
  await s.timers.advance(20);
}

test("consent table: all-party states say it, one-party states don't, unknown says it", () => {
  assert.equal(recordingNoticeFor("+16468580667").notice, false, "New York is one-party");
  assert.deepEqual(recordingNoticeFor("+13105559999"), { notice: true, state: "CA", why: "all-party-consent state" });
  for (const n of ["+12065550100", "+13125550100", "+16175550100", "+12155550100", "+17025550100", "+16035550100", "+14065550100", "+13025550100", "+12035550100", "+13135550100", "+14105550100", "+13055550100", "+15035550100"]) assert.equal(recordingNoticeFor(n).notice, true, n);
  assert.equal(recordingNoticeFor("+18885550100").notice, true, "toll-free: state unknown");
  assert.equal(recordingNoticeFor("+447700900123").notice, true, "abroad");
  assert.equal(recordingNoticeFor("").notice, true, "unreadable");
  assert.equal(Object.keys(ALL_PARTY_STATES).length, 14);
});

test("talk mode: instructions sound like a person calling; the first reply says it's Reason, an AI, and may be recorded — every state; never denied", () => {
  const s = startLine({ brain: async () => ({ text: "", tools: [], calls: [], endCall: null }), row: bizRow() });
  const ins = s.live.of("session.start")[0].session.instructions;
  assert.doesNotMatch(ins, /never speak on your own/);
  assert.match(ins, /Oh hey, hi! I'm calling to find out/);
  // Omari 11-11: the disclosure is on every call Reason places, whatever REASON_CALL_MANNER says (off here).
  const DISCLOSURE = "Hi there, this is Reason, an AI assistant calling for Omari. Just so you know, this call may be recorded.";
  assert.ok(ins.includes(DISCLOSURE));
  assert.match(ins, /say plainly yes, you're an AI assistant calling for Omari\./);
  assert.doesNotMatch(ins, /Don't open by saying you're an AI/);
  assert.match(ins, /Never say "no rush" or "take your time" unless they ask you to hold on/);
  assert.doesNotMatch(ins, /Don't bring up that the call is recorded/);
  assert.match(ins, /rather not be recorded/);
  assert.doesNotMatch(ins, /one notch more polite/);
  assert.match(ins, /low back pain/);
  assert.equal(db.getCall(C, s.row.id).announcement, DISCLOSURE, "New York (one-party): said too");
  const ca = startLine({ brain: async () => ({ text: "", tools: [], calls: [], endCall: null }), row: bizRow({ to: "+13105559999" }) });
  assert.ok(ca.live.of("session.start")[0].session.instructions.includes(DISCLOSURE));
  assert.equal(db.getCall(C, ca.row.id).announcement, DISCLOSURE);
});

test("call 59: their greeting → the voice answers at once itself; the line turn that was running is not said over it; no more line turns", async () => {
  let release;
  let n = 0;
  const s = startLine({ row: bizRow(), brain: () => { n++; return new Promise(r => { release = r; }); } });
  // The voice's own words before anybody spoke: dropped.
  await voiceOwn(s, "Hello?");
  assert.equal(s.twilio.media().length, 0);
  await theySay(s, "Hi, Chelsea Bodywork, can I help you?");
  assert.equal(n, 1, "Reason's turn still reads the line (a menu, a mailbox)");
  await voiceOwn(s, "Oh hey, hi! I'm calling to find out what you'd recommend for low back pain?");
  assert.equal(s.twilio.media().length, 1, "the voice's answer reaches them straight away");
  assert.equal(s.call.talking, true);
  assert.deepEqual(hold.partiesTold(db.getCall(C, s.row.id)), [1]);
  release({ text: "Hey, hi — thanks for picking up. I'm calling for Omari.", tools: [], calls: [], endCall: null });
  await s.timers.advance(50);
  assert.equal(s.live.of("session.commentary.append").length, 0, "the stale turn's words are never handed over (call 59: two openers)");
  await theySay(s, "Hello? Hello?");
  await theySay(s, "uh");
  assert.equal(n, 1, "no line turn per sound once they're talking");
  await voiceOwn(s, "Sorry — I was asking about low back pain.");
  assert.equal(s.twilio.media().length, 2, "its own replies are the conversation now");
});

test("nobody speaks ~3 s after pickup: Reason opens; then the call talks", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null }) });
  await s.timers.advance(gl.LINE_OPEN_AFTER_MS - 100);
  assert.equal(s.live.of("session.commentary.append").length, 0);
  await s.timers.advance(200);
  const open = s.live.of("session.commentary.append").at(-1);
  assert.match(open.content, /Say only this, then stop and wait for them to answer: "Hi there, hello\?"/);
  await voiceSays(s, "Hi there, hello?");
  assert.equal(s.twilio.media().length, 1);
  assert.equal(s.call.talking, false, "the hello alone is not somebody answering (review 4)");
  assert.deepEqual(hold.partiesTold(db.getCall(C, s.row.id)), [], "nobody written down as reached");
  await s.timers.advance(gl.LINE_GATE_QUIET_MS + 100);
  await theySay(s, "Yes, Chelsea Bodywork.");
  await voiceOwn(s, "Oh hi! I'm calling about low back pain.");
  assert.equal(s.call.talking, true);
  assert.equal(s.twilio.media().length, 2);
});

test("somebody is speaking at 3 s but not transcribed yet: no opener over them (2026-10-31 drive)", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  await s.timers.advance(900);
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  await s.timers.advance(gl.LINE_OPEN_AFTER_MS);
  assert.equal(s.live.of("session.commentary.append").length, 0);
  await voiceOwn(s, "Oh hey, hi!");
  assert.equal(s.twilio.media().length, 1, "the voice answering their (untranscribed) greeting is let through");
});

test("line hiss is not a voice: a noisy silent line still gets the opener", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null }) });
  const hiss = Buffer.from(Array.from({ length: 160 }, (_, i) => gl.pcmToUlaw(i % 2 ? 1700 : -1700))).toString("base64");
  assert.equal(gl.hasVoice(hiss), false);
  assert.equal(gl.hasVoice(SPEECH), true);
  for (let i = 0; i < 20; i++) s.twilio.say({ event: "media", media: { payload: hiss } });
  await s.timers.advance(gl.LINE_OPEN_AFTER_MS + 100);
  assert.match(s.live.of("session.commentary.append").at(-1)?.content ?? "", /"Hi there, hello\?"/);
});

test("somebody spoke first: no quiet opener", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  await theySay(s, "Hello?");
  await s.timers.advance(gl.LINE_OPEN_AFTER_MS);
  assert.ok(!s.live.of("session.commentary.append").some(e => /Hi there, hello/.test(e.content)));
});

test("the voice stays quiet on a person: Reason's turn speaks (the old path) and from its first word the call talks", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "Hi! I'm calling about low back pain — what would you recommend?", tools: [], calls: [], endCall: null }) });
  await theySay(s, "Chelsea Bodywork.");
  await s.timers.advance(50);
  const say = s.live.of("session.commentary.append").at(-1);
  assert.match(say.content, /^Hi! I'm calling about low back pain/, "no AI opener in front of it on a one-party line");
  await voiceSays(s, "Hi! I'm calling about low back pain");
  assert.equal(s.call.talking, true);
});

test("a menu: Reason's turn presses a key; the voice's own words to the recording stay off the line", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "1" } }], endCall: null }) });
  await theySay(s, "Thank you for calling. For appointments press 1.");
  await s.timers.advance(50);
  assert.equal(s.posted.length, 1, "pressed through Twilio");
  assert.match(s.posted[0].form.Twiml, /digits="w1"/);
});

test("AMD: Twilio's 30 s 'machine' guess while a person is talking with us changes nothing; a beep still stops the voice", async () => {
  let n = 0;
  const s = startLine({ row: bizRow(), brain: async () => { n++; return { text: "", tools: [], calls: [], endCall: null, skip: true }; } });
  await theySay(s, "Hi, Chelsea Bodywork?");
  await voiceOwn(s, "Oh hi!");
  await theySay(s, "Uh, you wanna come in?");
  const before = n;
  s.call.amd("machine_end_other");
  await s.timers.advance(50);
  assert.equal(n, before, "no turn re-introducing the call (call 59)");
  assert.equal(s.call.talking, true);
  s.call.amd("machine_end_beep");
  await s.timers.advance(50);
  assert.equal(s.call.talking, false, "a real beep: it was a mailbox");
  assert.match(s.live.of("session.instructions.append").at(-1).content, /voicemail greeting, not a person/);
  assert.equal(n, before + 1, "Reason's turn decides the message");
});

test("talking: the voice's hand-off runs Reason's turn and its words come back on the hand-off; a key is pressed after them", async () => {
  const asked = [];
  const s = startLine({ row: bizRow(), brain: async (m) => { asked.push(m); return asked.length === 1 ? { text: "", tools: [], calls: [], endCall: null, skip: true } : { text: "He'd rather not book yet — I'll check with him.", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "2" } }], endCall: null }; } });
  await theySay(s, "Hi there!");
  await voiceOwn(s, "Oh hey, hi!");
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d9" } });
  await s.timers.advance(20);
  const res = s.live.of("session.commentary.append").find(e => e.delegation_id === "d9");
  assert.equal(res.content, "He'd rather not book yet — I'll check with him.");
  assert.equal(s.posted.length, 0, "not over its own words");
  await voiceOwn(s, "He'd rather not book yet");
  await s.timers.advance(gl.LINE_GATE_QUIET_MS + 1500);
  assert.equal(s.posted.length, 1);
});

test("disclosure check: a call that didn't say it's an AI and may be recorded gets told to, in any state; one that did is left alone", async () => {
  const quiet = async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true });
  const a = startLine({ row: bizRow({ to: "+13105559999" }), brain: quiet });
  await theySay(a, "Hello, Spa LA?");
  await voiceOwn(a, "Oh hey, hi! I'm calling about massages.");
  await a.timers.advance(gl.LINE_NOTICE_CHECK_MS + 10);
  assert.match(a.live.of("session.instructions.append").at(-1).content, /this is Reason, an AI assistant calling for Omari\. Just so you know, this call may be recorded/);
  const b = startLine({ row: bizRow({ to: "+13105559998" }), brain: quiet });
  await theySay(b, "Hello, Spa LA?");
  await voiceOwn(b, "Hi there, this is Reason, an AI assistant calling for Omari. Just so you know, this call may be recorded. I'm calling about massages.");
  await b.timers.advance(gl.LINE_NOTICE_CHECK_MS + 10);
  assert.ok(!b.live.of("session.instructions.append").some(e => /recorded/.test(e.content)));
  const ny = startLine({ row: bizRow(), brain: quiet });
  await theySay(ny, "Hello?");
  await voiceOwn(ny, "Hi!");
  await ny.timers.advance(gl.LINE_NOTICE_CHECK_MS + 10);
  assert.ok(ny.live.of("session.instructions.append").some(e => /may be recorded/.test(e.content)), "New York: told too");
});

test("after the call: the owner's recap is given what really happened on Reason's side, and told not to guess a bad line", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  await s.timers.advance(700);
  await theySay(s, "Hi, Chelsea Bodywork, can I help you?");
  await s.timers.advance(6000);
  await voiceOwn(s, "Hey, hi!");
  s.twilio.close();
  await s.timers.advance(4000);
  const live = s.finished[0];
  assert.match(live.howItWent, /they first spoke 0\.7 s after picking up/);
  assert.match(live.howItWent, /Reason's first words reached them 7\.7 s after pickup \(7\.0 s after they first spoke\)/);
  assert.match(live.howItWent, /because they hung up/);
  const ev = thirdPartyEvent({ row: { ...db.getCall(C, s.row.id), duration_s: 9 }, live });
  assert.match(ev, /how it went on Reason's side, measured on the call: they first spoke/);
  assert.match(ev, /Never guess a cause .* not a bad line/);
});

test("puppet line (talk off): words of Reason's that were heard never make the voice 'stop, nobody heard you'", async () => {
  config.lineTalk = false;
  try {
    let n = 0;
    const s = startLine({ row: bizRow(), brain: async () => { n++; return { text: n === 1 ? "Hi — I'm calling about low back pain." : "Which service would you recommend?", tools: [], calls: [], endCall: null }; } });
    await theySay(s, "Chelsea Bodywork.");
    await voiceSays(s, "Hi — I'm calling about low back pain.");
    assert.equal(s.twilio.media().length, 1);
    await theySay(s, "uh");
    assert.equal(n, 2);
    assert.ok(!s.live.of("session.instructions.append").some(e => /Nothing you said on your own reached/.test(e.content)), "call 59: it was told so mid-sentence and said the intro again");
  } finally { config.lineTalk = true; }
});

test("after a menu and hold, the person who comes on gets the voice's answer at once (not Reason's turn 12 s later); hold ends", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  db.updateCall(C, s.row.id, { outcome_kind: "machine_menu", hold_since: clock.now() });
  await theySay(s, "Hi, thanks for holding, this is Sam.");
  await voiceOwn(s, "Oh hi Sam!");
  assert.equal(s.twilio.media().length, 1);
  const row = db.getCall(C, s.row.id);
  assert.equal(Number(row.hold_since), 0, "off hold");
  assert.equal(row.outcome_kind, "", "no longer a machine");
});

test("a voicemail Reason leaves is not a conversation: no talk mode, no recording nudge after it", async () => {
  const s = startLine({ row: bizRow({ to: "+13105559999" }), brain: async () => ({ text: "Hi, it's Reason calling for Omari about a massage — please call back.", tools: ["end_call"], calls: [], endCall: { message: "" } }) });
  db.updateCall(C, s.row.id, { outcome_kind: "voicemail_left" });
  s.call.amd("machine_end_beep");
  await s.timers.advance(50);
  await voiceSays(s, "Hi, it's Reason calling for Omari");
  assert.equal(s.call.talking, false);
  await s.timers.advance(gl.LINE_NOTICE_CHECK_MS + 10);
  assert.ok(!s.live.of("session.instructions.append").some(e => /recorded/.test(e.content)));
});

test("review 5: the voice talking to a mailbox greeting (nothing from them since) is not a person: Twilio's 'machine' stops it", async () => {
  let n = 0;
  const s = startLine({ row: bizRow(), brain: async () => { n++; return { text: "", tools: [], calls: [], endCall: null, skip: true }; } });
  await theySay(s, "Hi, you've reached Chelsea Bodywork");
  await voiceOwn(s, "Oh hi!");
  const before = n;
  s.call.amd("machine_end_other");
  await s.timers.advance(50);
  assert.equal(s.call.talking, false);
  assert.equal(n, before + 1, "Reason's turn reads the machine");
  // Review 3: the old greeting no longer counts as somebody speaking — the voice stays off the line.
  s.call.callerVoiceAt = 0;
  await voiceOwn(s, "Hello?");
  assert.equal(s.twilio.media().length, 1, "only the first 'Oh hi!' ever played");
});

test("review 2: a key decided on menu words is not pressed at the person who came on meanwhile", async () => {
  let release;
  const s = startLine({ row: bizRow(), brain: () => new Promise(r => { release = r; }) });
  await theySay(s, "For appointments press 1.");
  await theySay(s, "Front desk, this is Ana!");
  await voiceOwn(s, "Oh hi Ana!");
  release({ text: "", tools: ["play_keypad_touch_tone"], calls: [{ name: "play_keypad_touch_tone", args: { dtmf_tones: "1" } }], endCall: null });
  await s.timers.advance(50);
  assert.equal(s.posted.length, 0);
  assert.equal(s.call.talking, true);
});

test("review 7: words waiting to be handed over are dropped when the voice starts talking; its silent hand-off is answered", async () => {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d0" } });
  await s.timers.advance(10);
  s.call.pendingSay = { text: "stale words", at: s.timers.now() };
  await theySay(s, "Hello?");
  await voiceOwn(s, "Oh hey, hi!");
  assert.equal(s.call.pendingSay, null);
  assert.ok(s.live.of("session.thinking.append").some(e => e.delegation_id === "d0" && /nothing to add/.test(e.content)));
});

test("review 8: talk-mode hold: a hold recording talking doesn't reset the budget; the voice's silence past it rings off", async () => {
  const s = startLine({ row: bizRow({ fields: { hold_budget_s: 60 } }), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  await theySay(s, "Hi, can you hold?");
  await voiceOwn(s, "Sure.");
  for (let i = 0; i < 5; i++) { await s.timers.advance(15_000); s.live.emit({ type: "session.input_transcript.delta", delta: " your call is important to us" }); }
  assert.ok(s.live.of("session.commentary.append").some(e => /try again another time/.test(e.content)));
});

// 2026-10-31 greet drives: one opener. A listening sound ("Mm.") into their pause or after its own
// words never reaches them; a reply to a finished sentence is not held at all.
async function frames(s, payload, n, { from = "voice" } = {}) {
  for (let i = 0; i < n; i++) {
    if (from === "voice") s.live.emit({ type: "session.output_audio.delta", delta: payload });
    else s.twilio.say({ event: "media", media: { payload } });
    await s.timers.advance(20);
  }
}

const spoken = (s) => s.twilio.media().filter(m => gl.hasSpeech(m.media.payload)).length;

async function talkingCall() {
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  await theySay(s, "Chelsea Bodywork, can I help you?");
  await voiceOwn(s, "Oh hey, hi! I'm calling about low back pain.");
  assert.equal(s.call.talking, true);
  return s;
}

test("one opener: 'Mm.' into the receptionist's mid-sentence pause is dropped, words and all", async () => {
  const s = await talkingCall();
  await s.timers.advance(5000);
  await frames(s, SPEECH, 40, { from: "them" });
  const before = spoken(s);
  // 200 ms into their pause the voice says "Mm." (300 ms) …
  await s.timers.advance(200);
  s.live.emit({ type: "session.output_transcript.delta", delta: " Mm." });
  await frames(s, SPEECH, 15);
  await frames(s, QUIET, 16);
  assert.equal(spoken(s), before, "nothing of it reached the line");
  assert.ok(!s.call.turns.some(t => t.who === "reason" && /^\s*Mm/.test(t.text)), "and it is not in the transcript");
  // … and the same sound they talk over is dropped too.
  await frames(s, SPEECH, 10, { from: "them" });
  await s.timers.advance(300);
  await frames(s, SPEECH, 5);
  await frames(s, SPEECH, 5, { from: "them" });
  await frames(s, SPEECH, 30);
  assert.equal(spoken(s), before, "a sound they talked over never plays");
  assert.equal(s.call.soundsDropped, 2);
});

test("one opener: 'Mm.' a second after its own opener, into silence, is dropped (no audio after it either)", async () => {
  const s = await talkingCall();
  const before = spoken(s);
  await s.timers.advance(1000);
  await frames(s, SPEECH, 12);
  await s.timers.advance(gl.BC_WAIT_MS + 20);
  assert.equal(spoken(s), before);
  assert.equal(s.call.sound, null);
});

test("a reply to their finished sentence plays at once; a held start that grows into words plays in full", async () => {
  const s = await talkingCall();
  await s.timers.advance(4000);
  await frames(s, SPEECH, 30, { from: "them" });
  await s.timers.advance(900);
  const before = spoken(s);
  await frames(s, SPEECH, 1);
  assert.equal(spoken(s), before + 1, "~1 s after their sentence: no hold, no added wait");
  // Starting 200 ms into their pause but carrying on: held, then all of it plays, from its first frame.
  await s.timers.advance(3000);
  await frames(s, SPEECH, 30, { from: "them" });
  await s.timers.advance(200);
  const n = spoken(s);
  await frames(s, SPEECH, 10);
  assert.equal(spoken(s), n, "held while it might be a sound");
  await frames(s, SPEECH, 15);
  assert.equal(spoken(s), n + 25, "a real reply: every frame, none lost");
});

test("talk off (puppet line) and before talking: nothing is held", async () => {
  config.lineTalk = false;
  const s = startLine({ row: bizRow(), brain: async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true }) });
  assert.equal(s.call.talk, false);
  assert.equal(s.call.heldSound.length, 2);
  await frames(s, SPEECH, 5);
  assert.equal(s.call.sound, null);
});
