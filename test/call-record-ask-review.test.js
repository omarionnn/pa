// Review of PR 590 (REASON_CALL_RECORD_ASK): each hole found, pinned. Setup and harness copied from call-record-ask.test.js.
// No network, no paid model, nothing rings: voice, Twilio and the judges are stand-ins.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-record-ask-review-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_MAX_CALLS_PER_DAY = "0";
delete process.env.REASON_THIRDPARTY_RECORDING;
delete process.env.REASON_CALL_RECORD_ASK;

const gl = await import("../src/calls/gptlive.js");
const manner = await import("../src/calls/manner.js");
const { runTool, fileRecording, toolsFor, tools, recordOfferFor } = await import("../src/tools.js");
const { thirdPartyEvent } = await import("../src/calls/postcall.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const { Runtime } = await import("../src/runtime.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };
const SHOP = "+16468580667";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM held_actions;");
  db.saveConversation(C, []);
  db.saveConversation(OTHER, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari Test", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama Mensah", isOperator: false });
  Object.assign(config, { callRecordAsk: "on", thirdPartyRecording: false, callManner: "off", lineTalk: true, callIdentity: false, callVoice: "gptlive", thirdPartyVoice: "owner", callCacheWarm: false, callHearing: true, pickupOpener: false, callQuietHours: "", ...TWILIO });
});

// ---------- the ask, on text ----------

const said = (conv, t) => ({ role: "user", content: `[Sun, Nov 15, 2026, 9:10 AM] ${conv === C ? "Omari" : "Ama"}: ${t}` });
const ASK = { to: SHOP, goal: "ask whether they have a table for two at 8 tonight" };

/** The usual texted path: ask (confirm_request), their reply (confirm_record), the call. */
async function askThenCall(conv, { request, reply, input = ASK, extra = {}, kind = "user", calls = new FakeCallProvider() } = {}) {
  const asked = await runTool("confirm_request", { action: "call_place", summary: `ring ${input.to}`, target: trust.personPin("call_place", input) }, { conversationId: conv, messages: [said(conv, request)] });
  const msgs = [said(conv, request), said(conv, reply)];
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: conv, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  const out = await runTool("call_place", { ...input, ...extra, confirmation_id: asked.confirmation_id }, { conversationId: conv, calls, messages: msgs, kind });
  return { asked, out, calls, row: out.call_id ? db.getCall(conv, out.call_id) : null };
}
// ---------- on the call ----------

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
const BRIEF = JSON.stringify({ goal: "Ask whether they have a table for two at 8 tonight. Asking only.", facts: [], questions: ["A table for two at 8?"], cannotAgree: [], approved: { book: false, maxCents: null, terms: [], upTo: "" }, readBack: [], requirements: {}, place: "", language: "en" });
const quiet = async () => ({ text: "", tools: [], calls: [], endCall: null, skip: true });

const lineRow = (conv = OTHER, { asked = true, direction } = {}) => {
  const row = db.createCall(conv, { provider: "gptlive", toNumber: SHOP, isOwner: false, goal: "ask whether they have a table for two at 8 tonight", facts: [], announcement: "", state: "placing", direction });
  db.updateCall(conv, row.id, { opening_waits: 1, brief: BRIEF, ...(asked ? { record_asked: 1, record_said: "record it" } : {}) });
  return db.getCall(conv, row.id);
};
function start(row, { objectionJudge = async () => false } = {}) {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const finished = [];
  const lines = [];
  const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain: quiet, judge: async () => null, objectionJudge, now: timers.now, timers, log: (o) => lines.push(o), finish: async (l) => { finished.push(l); }, twilioApi: async () => ({ ok: true, status: 200, json: {} }) });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  return { call, timers, twilio, live, finished, lines, row };
}
/** Their line carries audio for `ms` (speech, hold music: the tape keeps it either way). */
async function line(s, ms) { for (let i = 0; i < ms / 20; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); } }
async function theySay(s, text) {
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  s.live.emit({ type: "session.input_transcript.delta", delta: ` ${text}` });
  await s.timers.advance(gl.LINE_QUIET_MS + 10);
}
async function voice(s, text) {
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  s.live.emit({ type: "session.output_transcript.delta", delta: text });
  await s.timers.advance(20);
}
async function hangUp(s) {
  const ending = s.call.end("caller hung up");
  await s.timers.advance(3200);
  await ending;
  return s.finished.at(-1);
}
const NOTICE_AMA = "Hi, this is Reason, an AI assistant calling for Ama. Just so you know, this call is recorded.";
const undo = await import("../src/undo.js");
const { runReleasedAction } = await import("../src/tools.js");
const { tellTheOwner } = await import("../src/calls/postcall.js");
const yesJudge = async () => ({ value: { asked: "yes", callee: "business", only_asks: "yes" } });
const REQUEST = "call Luigi's and ask if they have a table at 8";

async function plainAskCall(conv, { calls = new FakeCallProvider(), messages = [said(conv, REQUEST)], input = ASK } = {}) {
  return runTool("call_place", input, { conversationId: conv, calls, messages, kind: "user", askedCallJudge: yesJudge });
}
async function release(calls) {
  return undo.pass({ run: (row) => runReleasedAction(row, { calls }) });
}
function withWindow(seconds, fn) {
  const was = config.undoWindowSeconds;
  config.undoWindowSeconds = seconds;
  return Promise.resolve().then(fn).finally(() => { config.undoWindowSeconds = was; });
}

const { recordChoice, asksForRecording } = await import("../src/tools.js");

// ---------- 1. the requester's own words, and only for this call ----------

test("a quote found inside \"don't record it\", \"no need to record it\" or \"is it recorded?\" is not an ask: refused, nothing dialled", async () => {
  const cases = [
    ["no, don't record it", "record it"],
    ["yes but no need to record it", "record it"],
    ["sure. is it recorded?", "is it recorded"],
    ["go ahead, is this call being recorded", "is this call being recorded"],
    ["yes, please do not record the call", "record the call"],
    ["call them but never record it", "record it"],
  ];
  let n = 0;
  for (const [reply, quote] of cases) {
    const to = `+1646858071${n++}`;
    const { out, calls } = await askThenCall(C, { request: "call the bakery and ask if they're open", reply, input: { to, goal: "ask if they're open" }, extra: { record_said: quote } });
    assert.equal(out.status, "record_not_accepted", `${reply} -> ${JSON.stringify(out).slice(0, 200)}`);
    assert.equal(calls.placed.length, 0, reply);
    assert.equal(db.recordAskFor(C, to), null, `nothing saved for ${reply}`);
  }
  // Real asks still are.
  for (const [reply, quote] of [["yes, record it", "record it"], ["no problem, record it", "record it"], ["can you record it?", "record it"], ["will you record the call", "record the call"], ["yes and get me the audio", "get me the audio"]]) {
    const to = `+1646858072${n++ % 10}`;
    const { out } = await askThenCall(C, { request: "call the bakery and ask if they're open", reply, input: { to, goal: "ask if they're open" }, extra: { record_said: quote } });
    assert.equal(out.ok, true, `${reply} -> ${JSON.stringify(out).slice(0, 200)}`);
    assert.equal(Number(db.getCall(C, out.call_id).record_asked), 1, reply);
  }
  assert.equal(asksForRecording("record it", ["don't record it"]).ok, false);
});

test("\"record it\" from an earlier request in the thread is not an ask for this call", async () => {
  const to = "+16468580731";
  const msgs = [said(C, "call Luigi's and record it"), said(C, "thanks!"), said(C, "now call the bakery and ask if they're open"), said(C, "yes")];
  const asked = await runTool("confirm_request", { action: "call_place", summary: `ring ${to}`, target: trust.personPin("call_place", { to, goal: "ask if they're open" }) }, { conversationId: C, messages: msgs.slice(0, 3) });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: C, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to, goal: "ask if they're open", record_said: "record it", confirmation_id: asked.confirmation_id }, { conversationId: C, calls, messages: msgs, kind: "user" });
  assert.equal(out.status, "record_not_accepted", JSON.stringify(out).slice(0, 200));
  assert.equal(calls.placed.length, 0);
});

test("a call asked for by voice during their own call, or in a group thread, is never recorded — not even on a saved ask", () => {
  db.noteRecordAsk(C, SHOP, "record it");
  assert.equal(recordChoice(C, SHOP, {}, { kind: "user", onCall: 7, messages: [] }), null, "voice dial (src/calls/voice.js passes onCall)");
  assert.equal(recordChoice(C, SHOP, { record_said: "record it" }, { kind: "user", onCall: 7, messages: [said(C, "call them and record it")] }), null);
  assert.equal(recordChoice(C, SHOP, { record_said: "record it" }, { kind: "user", isGroup: true, messages: [said(C, "call them and record it")] }), null, "group thread");
  assert.ok(db.recordAskFor(C, SHOP), "not used up by a call it did not apply to");
});

test("a saved ask that was never used (declined, abandoned) does not record a later call nobody asked about", async () => {
  // Up front "call Luigi's and record it", then they never said yes: the ask stays saved.
  db.noteRecordAsk(C, SHOP, "record it");
  clock.skip(3 * 60 * 60 * 1000);
  // Hours later a plain "call Luigi's" goes without a question (their request was the yes): not recorded.
  const calls = new FakeCallProvider();
  const out = await plainAskCall(C, { calls });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(Number(db.getCall(C, out.call_id).record_asked), 0);
  // A yes asked AFTER it was saved (whose question said it would be recorded) still counts, as does a timer's dial.
  db.noteRecordAsk(C, "+16468580741", "record it");
  clock.skip(3 * 60 * 60 * 1000);
  assert.ok(recordChoice(C, "+16468580741", {}, { kind: "timer", messages: [] }));
  assert.equal(recordChoice(C, "+16468580741", {}, { kind: "user", messages: [] }), null);
});

test("undo_send on a waiting call takes its \"record it\" with it", () => withWindow(30, async () => {
  const calls = new FakeCallProvider();
  const held = await plainAskCall(C, { calls });
  assert.equal(held.undo_held, true);
  const added = await runTool("call_place", { ...ASK, record_said: "record it" }, { conversationId: C, calls, messages: [said(C, REQUEST), said(C, "record it please")], kind: "user" });
  assert.equal(added.recording_added, true, JSON.stringify(added).slice(0, 200));
  const stopped = await runTool("undo_send", {}, { conversationId: C, kind: "user", messages: [said(C, "actually stop")] });
  assert.equal(stopped.stopped, true);
  assert.equal(db.recordAskFor(C, SHOP), null);
}));

// ---------- 2. the notice, really heard by the person there now ----------

test("a notice cut off by a barge-in does not count: its transcript is whole, its audio was not played — no audio kept", async () => {
  const s = start(lineRow());
  await theySay(s, "Luigi's, hello?");
  s.live.emit({ type: "session.output_transcript.delta", delta: NOTICE_AMA });
  for (let i = 0; i < 150; i++) s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  await s.timers.advance(20);
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  s.live.emit({ type: "session.input_transcript.delta", delta: " sorry, who is this?" });
  await s.timers.advance(500);
  assert.ok(s.lines.some(l => l.gptlive_cleared === s.row.id && l.why === "barge_in"), "barge-in cleared the queue");
  await theySay(s, "sorry, who is this?");
  await voice(s, "Do you have a table for two at eight?");
  await line(s, 1000);
  await s.timers.advance(gl.LINE_NOTICE_CHECK_MS);
  const live = await hangUp(s);
  assert.equal(live.recording, null);
  assert.equal(live.recordingWhy, manner.RECORD_UNCONFIRMED_WHY);
});

test("a hedged near-miss (\"not sure whether this call is recorded\") is not the notice", async () => {
  assert.equal(manner.noticeSaid("I'm not sure whether this call is recorded."), false);
  assert.equal(manner.noticeSaid("Hi Sam! Just so you know, this call is recorded."), true);
  const s = start(lineRow());
  await theySay(s, "Luigi's, hello?");
  await voice(s, "Hi! I'm not sure whether this call is recorded. Do you have a table for two at eight?");
  await line(s, 2000);
  const live = await hangUp(s);
  assert.equal(live.recording, null);
});

test("notice said to a machine, then a person: owed again however short the gap — nudged, and not said, nothing from there is kept", async () => {
  const s = start(lineRow());
  await theySay(s, "Luigi's, hello?");
  await voice(s, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(s, 1000);
  const quietFrom = s.call.tape.callerBytes;
  s.call.stopTalking("a mailbox after all");
  await line(s, 3000);
  await theySay(s, "Hi, Sam here, sorry about that.");
  await voice(s, "Hi Sam! I'm after a table for two at eight tonight.");
  assert.equal(s.call.talking, true);
  assert.equal(s.call.talkRestarts?.length, 1);
  await line(s, 200);
  await s.timers.advance(gl.LINE_NOTICE_CHECK_MS);
  assert.ok(s.live.of("session.instructions.append").some(e => e.content.includes(manner.RENOTICE_LINE)), "nudged");
  await line(s, 1000);
  const live = await hangUp(s);
  assert.ok(Number.isFinite(s.call.tape.limit) && s.call.tape.limit <= quietFrom, String(s.call.tape.limit));
  assert.ok(!live.recording || live.recording.seconds < 4);
  // Said again to the new person: kept, their words before it silenced.
  const t = start(lineRow());
  await theySay(t, "Luigi's, hello?");
  await voice(t, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(t, 1000);
  t.call.stopTalking("a mailbox after all");
  await line(t, 3000);
  await theySay(t, "Hi, Sam here.");
  await voice(t, `Hi Sam! ${manner.RENOTICE_LINE} A table for two at eight?`);
  await line(t, 1000);
  const tLive = await hangUp(t);
  assert.ok(tLive.recording, tLive.recordingWhy);
  assert.ok(!Number.isFinite(t.call.tape.limit));
  assert.equal(t.call.tape.blanks.length, 1);
});

test("a long hold after the voice's last words and a new person before it speaks again: nothing from the quiet on is kept", async () => {
  const s = start(lineRow());
  await theySay(s, "Luigi's, hello?");
  await voice(s, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(s, 1500);
  const end = s.call.turns.findLast(x => x.who === "reason").tapeEnd;
  await line(s, manner.RENOTICE_GAP_MS + 5000);
  await theySay(s, "Hello? Bookings, this is Sam. Hello?");
  const live = await hangUp(s);
  assert.ok(Number.isFinite(s.call.tape.limit) && s.call.tape.limit <= end, `${s.call.tape.limit} vs ${end}`);
  assert.ok(s.lines.some(l => l.gptlive_renotice_missing === s.row.id && l.trailing));
  assert.ok(!live.recording || live.recording.seconds < 3);
});

test("a recording kept only up to a long hold says so when it is delivered: never passed off as the whole call", async () => {
  const s = start(lineRow());
  await theySay(s, "Luigi's, hello?");
  await voice(s, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(s, 1500);
  await voice(s, " Or eight thirty?");
  await line(s, 1500);
  await voice(s, " Either is fine.");
  await line(s, manner.RENOTICE_GAP_MS + 5000);
  await theySay(s, "Hello? Bookings, this is Sam. Hello?");
  const live = await hangUp(s);
  assert.ok(live.recording, live.recordingWhy);
  assert.equal(live.recordingPartial, manner.RECORD_PART_WHY);
  const text = thirdPartyEvent({ row: { ...s.row, state: "completed", recording_state: "stored", recording_why: live.recordingPartial }, live });
  assert.match(text, /NOT the whole call/);
  const whole = thirdPartyEvent({ row: { ...s.row, state: "completed", recording_state: "stored", recording_why: "" }, live });
  assert.doesNotMatch(whole, /whole call/, "a whole recording reads as before");
});

// ---------- 3. objection, fail closed ----------

test("their words can't be read for an objection (the read failed or is past its cap): nothing from them on is kept", async () => {
  const s = start(lineRow(), { objectionJudge: async () => null });
  await theySay(s, "Luigi's, hello?");
  await voice(s, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(s, 2000);
  await theySay(s, "honestly I'd rather you didn't tape this");
  await s.timers.advance(manner.OBJECTION_SETTLE_MS + 50);
  await voice(s, "Okay. Do you have a table at eight?");
  await line(s, 2000);
  const live = await hangUp(s);
  assert.ok(s.call.tape.stopped);
  assert.ok(s.lines.some(l => l.gptlive_recording_unread_stop === s.row.id));
  assert.ok(!live.recording || live.recording.seconds < 1, String(live.recording?.seconds));
});

test("an objection in Spanish on a call recorded on request: the read is told any language counts, and nothing is kept", async () => {
  const seen = [];
  const s = start(lineRow(), { objectionJudge: async (t, o) => { seen.push({ t, o }); return /no me grabe/.test(t); } });
  await theySay(s, "Luigi's, ¿bueno?");
  await voice(s, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(s, 2000);
  await theySay(s, "Perdón, no me grabe, por favor");
  await s.timers.advance(manner.OBJECTION_SETTLE_MS + 50);
  await line(s, 2000);
  const live = await hangUp(s);
  assert.ok(seen.some(x => x.o?.recordAsked === true), "the read knows the call was recorded on request");
  assert.ok(s.call.tape.stopped);
  assert.ok(!live.recording || live.recording.seconds < 1, String(live.recording?.seconds));
  assert.match(manner.objectionPrompt("x", { recordAsked: true }), /no me grabe/);
  assert.doesNotMatch(manner.objectionPrompt("x"), /Spanish/, "the business-call read with the switch off is unchanged");
});

// ---------- 5. scope: a call that goes into Spanish ----------

test("a person who answers in Spanish is told in Spanish, and that notice counts; a question or a 'no' about it never does", async () => {
  assert.ok(manner.noticeSaid("Hola, habla Reason. Le aviso que esta llamada se está grabando."));
  assert.ok(manner.noticeSaid(manner.recordNoticeLineEs("Ama")) && manner.noticeSaid(manner.RENOTICE_LINE_ES));
  for (const t of ["¿Esta llamada se graba?", "No sé si esta llamada se está grabando.", "Esta llamada no se graba.", "Is this call recorded?"]) assert.equal(manner.noticeSaid(t), false, t);
  const text = gl.lineTalkInstructions({ name: "Ama", noticeLine: manner.recordNoticeLine("Ama") });
  assert.ok(text.includes(manner.recordNoticeLineEs("Ama")) && text.includes(manner.RENOTICE_LINE_ES));
  assert.ok(!gl.lineTalkInstructions({ name: "Ama" }).includes(manner.RENOTICE_LINE_ES), "a call nobody asked to record is unchanged");
  const s = start(lineRow());
  await theySay(s, "Luigi's, ¿bueno?");
  await voice(s, `${manner.recordNoticeLineEs("Ama")} ¿Tienen mesa para dos a las ocho?`);
  await line(s, 1500);
  await voice(s, " O a las ocho y media.");
  await line(s, 1500);
  const live = await hangUp(s);
  assert.ok(live.recording && live.recording.seconds >= 1, live.recordingWhy);
});
