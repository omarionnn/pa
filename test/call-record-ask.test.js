// A call Reason places for somebody, recorded only because they asked for THAT call to be
// (REASON_CALL_RECORD_ASK = off | owner | on, default off; src/calls/manner.js `recordAskFor`):
//   - the recording is offered in the same question as "want me to call?" (one message); a plain yes is
//     not a yes to recording; "call them and record it" up front is not asked again; a call set up for
//     later keeps the choice;
//   - on the call the first words to a person are whose assistant it is and that it is recorded, nothing
//     before that is kept, and after a hold or a transfer it is said again or nothing after is kept;
//   - an objection stops it and deletes everything captured; the person is told;
//   - the audio goes out the way their own calls' does, sent only when it really went, and is covered by
//     delete-my-data; asked for audio of a call that was not recorded, the answer is honest;
//   - off: nothing changes.
// No network, no paid model, nothing rings: voice, Twilio and the judges are stand-ins.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-record-ask-"));
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

test("asked in the SAME question: confirm_request hands back the offer, in its exact words, for one message — never a second ask", async () => {
  const { asked } = await askThenCall(C, { request: "call Luigi's and see if they have a table at 8", reply: "yes" });
  assert.equal(manner.RECORD_ASK_OFFER, "I can record it and send you the audio if you like; I'd tell them at the start that it's recorded.");
  assert.ok(asked.record_offer.includes(`"${manner.RECORD_ASK_OFFER}"`));
  assert.match(asked.record_offer, /IN THIS SAME MESSAGE as your question — one message, never a second one/);
  assert.match(asked.record_offer, /"Want me to call them\? I can record it and send you the audio if you like; I'd tell them at the start that it's recorded\."/);
  assert.match(asked.record_offer, /If they just say yes, the call is NOT recorded/);
  // The model is told the same in call_place's own description, and given record_said.
  const def = toolsFor(C).find(t => t.name === "call_place");
  assert.ok(def.description.includes(manner.RECORD_ASK_OFFER));
  assert.match(def.description, /IN THAT SAME MESSAGE, one message, never a second one/);
  assert.ok(def.input_schema.properties.record_said);
  // Nobody is asked about recording a call to themselves.
  assert.equal(recordOfferFor(C, "+12025551234"), "");
  // What Reason says it can do matches.
  const { capabilitiesNow } = await import("../src/tools.js");
  const gpt = { status: () => ({ name: "gptlive", status: "live", records: true, missing: [] }) };
  const phone = () => capabilitiesNow({ calls: gpt, conversationId: C }).find(x => x.name === "phone_calls").what;
  assert.match(phone(), /not audio-recorded unless Omari Test asks for that one call to be \(you offer it in the same question as "want me to call\?"\)/);
  config.callRecordAsk = "off";
  assert.match(phone(), /those calls are not audio-recorded, so Omari Test gets the summary and what was said, never audio/);
  config.callRecordAsk = "on";
});

test("a plain \"yes\" places the call NOT recorded", async () => {
  const { out, row } = await askThenCall(C, { request: "call Luigi's and see if they have a table at 8", reply: "yes" });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(Number(row.record_asked), 0);
  assert.equal(row.record_said, "");
  assert.doesNotMatch(out.note, /Recorded because/);
});

test("\"yes, record it\" places it recorded, on their own words — words they did not write are refused and nothing is dialled", async () => {
  const { out, row } = await askThenCall(C, { request: "call Luigi's and see if they have a table at 8", reply: "yes, record it", extra: { record_said: "record it" } });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(Number(row.record_asked), 1);
  assert.equal(row.record_said, "record it");
  assert.match(out.note, /Recorded because Omari Test asked \("record it"\)/);
  // The model quoting a recording ask that is not in what they wrote: refused, nobody's phone rang.
  const made = await askThenCall(C, { request: "call the bakery and ask if they're open", reply: "yeah go", input: { to: "+16468580668", goal: "ask if they're open" }, extra: { record_said: "record it" } });
  assert.equal(made.out.ok, false);
  assert.equal(made.out.status, "record_not_accepted");
  assert.match(made.out.error, /Nothing was dialled/);
  assert.equal(made.calls.placed.length, 0);
  // A quote that is theirs but does not ask for a recording does not make one either.
  const notAsk = await askThenCall(C, { request: "call the florist", reply: "yes please", input: { to: "+16468580669", goal: "ask about roses" }, extra: { record_said: "yes please" } });
  assert.equal(notAsk.out.status, "record_not_accepted");
});

test("\"call them and record it\" up front: the question does not ask about recording again, and the call is recorded on a plain yes", async () => {
  const calls = new FakeCallProvider();
  const request = "call Luigi's and ask about a table at 8, and record the call";
  // The first try, before any yes: refused for a confirmation, the recording ask kept.
  const first = await runTool("call_place", { ...ASK, record_said: "record the call" }, { conversationId: C, calls, messages: [said(C, request)], kind: "user" });
  assert.equal(first.ok, false);
  assert.equal(calls.placed.length, 0);
  const asked = await runTool("confirm_request", { action: "call_place", summary: `ring ${SHOP}`, target: first.use_target ?? trust.personPin("call_place", ASK) }, { conversationId: C, messages: [said(C, request)] });
  assert.match(asked.record_offer, /They already asked for this call to be recorded \("record the call"\): do NOT ask about recording again/);
  assert.ok(!asked.record_offer.includes(manner.RECORD_ASK_OFFER), "no second offer");
  const msgs = [said(C, request), said(C, "yes")];
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: C, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  const out = await runTool("call_place", { ...ASK, confirmation_id: asked.confirmation_id }, { conversationId: C, calls, messages: msgs, kind: "user" });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(Number(db.getCall(C, out.call_id).record_asked), 1);
  // Used by that call: the next call to the same place is not recorded unless asked again.
  assert.equal(db.recordAskFor(C, SHOP), null);
});

test("a call set up for later keeps the choice: agreed with \"record it\" at night, dialled by a timer in the morning without asking again", async () => {
  const setClock = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };
  config.callQuietHours = "21:00-08:00";
  setClock(Date.parse("2026-11-15T22:30:00-05:00"));
  const msgs = [said(C, "call Luigi's about a table and record it"), said(C, "yes, record it")];
  const asked = await runTool("confirm_request", { action: "call_place", summary: `ring ${SHOP}`, target: trust.personPin("call_place", ASK) }, { conversationId: C, messages: msgs.slice(0, 1) });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: C, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  const night = await runTool("call_place", { ...ASK, confirmation_id: asked.confirmation_id, record_said: "record it" }, { conversationId: C, calls: new FakeCallProvider(), messages: msgs, kind: "user" });
  assert.equal(night.status, "quiet_hours");
  assert.equal(db.recordAskFor(C, SHOP).said, "record it");
  // 8am: the timer's turn places it (a standing permission stands in for the yes here), nothing asked.
  setClock(Date.parse("2026-11-16T08:01:00-05:00"));
  await runTool("permission_grant", { action: "call_place", scope: SHOP, said: "you can call Luigi's whenever" }, { conversationId: C, messages: [said(C, "you can call Luigi's whenever")], kind: "user" }).catch(() => null);
  const asked2 = await runTool("confirm_request", { action: "call_place", summary: `ring ${SHOP}`, target: trust.personPin("call_place", ASK) }, { conversationId: C, messages: [said(C, "ok")] });
  assert.match(asked2.record_offer, /already asked for this call to be recorded/, "a fresh yes, if one is needed, still does not ask about recording");
  await runTool("confirm_record", { confirmation_id: asked2.confirmation_id }, { conversationId: C, messages: [said(C, "ok"), said(C, "go")], judge: async () => ({ verdict: "yes" }) });
  // The timer's turn passes the words again (or not): either way it is the stored choice that counts.
  const morning = await runTool("call_place", { ...ASK, confirmation_id: asked2.confirmation_id, record_said: "record it" }, { conversationId: C, calls: new FakeCallProvider(), messages: [], kind: "timer" });
  assert.equal(morning.ok, true, JSON.stringify(morning).slice(0, 300));
  assert.equal(Number(db.getCall(C, morning.call_id).record_asked), 1);
  // And a choice is only kept a couple of days.
  db.noteRecordAsk(C, "+16468580670", "record it");
  setClock(clock.now() + db.RECORD_ASK_KEEP_MS + 1000);
  assert.equal(db.recordAskFor(C, "+16468580670"), null);
});

test("owner: only the operator's account gets the ask; everybody else is exactly as off", async () => {
  config.callRecordAsk = "owner";
  assert.equal(manner.recordAskFor(C), true);
  assert.equal(manner.recordAskFor(OTHER), false);
  assert.equal(toolsFor(OTHER).find(t => t.name === "call_place"), tools.find(t => t.name === "call_place"));
  const { out, row, asked } = await askThenCall(OTHER, { request: "call Luigi's", reply: "yes, record it", extra: { record_said: "record it" } });
  assert.equal(out.ok, true);
  assert.equal(asked.record_offer, undefined);
  assert.equal(Number(row.record_asked), 0, "not recorded: the switch does not reach them");
});

test("switch OFF: the tool, the question, the call and the answers are what they were — nothing is asked and nothing is recorded", async () => {
  config.callRecordAsk = "off";
  // The model is shown call_place exactly as before (the same object, not a copy).
  for (const conv of [C, OTHER]) assert.equal(toolsFor(conv).find(t => t.name === "call_place"), tools.find(t => t.name === "call_place"));
  assert.ok(!("record_said" in tools.find(t => t.name === "call_place").input_schema.properties));
  const { out, row, asked } = await askThenCall(C, { request: "call Luigi's and record it", reply: "yes, record it", extra: { record_said: "record it" } });
  assert.equal(asked.record_offer, undefined);
  assert.equal(out.ok, true, "a record_said is ignored, never a refusal");
  assert.equal(Number(row.record_asked), 0);
  assert.doesNotMatch(out.note, /Recorded because/);
  assert.equal(db.recordAskFor(C, SHOP), null, "nothing kept for later either");
  // The answer about a call that was not recorded is the old one, word for word.
  db.updateCall(C, row.id, { state: "completed", recording_state: "not_applicable", recording_why: manner.NOT_RECORDED_WHY });
  const note = thirdPartyEvent({ row: db.getCall(C, row.id), live: {} });
  assert.ok(note.includes(`No audio recording was made of this call (${manner.NOT_RECORDED_WHY}), and that is not a fault: do not mention a recording or offer one.`));
  const st = await runTool("call_status", { call_id: row.id }, { conversationId: C, calls: new FakeCallProvider() });
  assert.ok(st.calls[0].recording_note.includes("say plainly that calls to other people aren't recorded"), JSON.stringify(st.calls?.[0]?.recording_note));
});

test("\"send me the audio\" for a call that was not recorded: it wasn't, and next time they can ask for it to be", async () => {
  const { row } = await askThenCall(C, { request: "call Luigi's", reply: "yes" });
  db.updateCall(C, row.id, { state: "completed", recording_state: "not_applicable", recording_why: manner.NOT_RECORDED_WHY });
  const st = await runTool("call_status", { call_id: row.id }, { conversationId: C, calls: new FakeCallProvider() });
  assert.match(st.calls[0].recording_note, /say plainly that this call wasn't recorded, and that next time they can ask you to record the call and you'll send them the audio/);
  assert.equal(st.calls[0].recording, null);
  const note = thirdPartyEvent({ row: db.getCall(C, row.id), live: {} });
  assert.match(note, /nobody asked for it to be recorded/);
  assert.match(note, /next time they can ask you to record the call/);
});

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

test("the notice is the first thing a person hears: in the voice's rules, on the row, in the pickup clip — and the call is recorded only from it on", async () => {
  assert.equal(manner.recordNoticeLine("Ama"), NOTICE_AMA);
  const row = lineRow();
  const s = start(row);
  const ins = s.live.of("session.start")[0].session.instructions;
  assert.ok(ins.includes(`your very first words are exactly: "${NOTICE_AMA}"`), "the voice is told to open with it");
  assert.match(ins, /Say it before anything else; nothing you say before it is kept/);
  assert.ok(ins.includes(`say "${manner.RENOTICE_LINE}" before anything else`), "and to say it again after a hold or transfer");
  assert.match(ins, /Never say it to a phone menu, a recording or a voicemail greeting/);
  assert.match(ins, /rather not be recorded/);
  assert.doesNotMatch(ins, /No preamble about who or what you are/);
  assert.equal(gl.voiceInstructionsFor(db.getCall(OTHER, row.id)), ins, "a session opened ahead gets the same words");
  assert.equal(db.getCall(OTHER, row.id).announcement, NOTICE_AMA, "Reason's own turns put it in front of their first words");
  assert.equal(gl.lineAnnouncement(row), NOTICE_AMA);
  assert.equal(s.call.recorded, true);
  const opener = await import("../src/calls/opener.js");
  assert.equal(opener.openerText({ about: "to ask about a table for two tonight", disclose: gl.lineAnnouncement(row) }).text, `${NOTICE_AMA} I'm calling to ask about a table for two tonight.`);
  // A phone menu first: nothing said to it, and none of it kept.
  await line(s, 2000);
  await theySay(s, "Hello, Luigi's, how can I help?");
  await voice(s, `${NOTICE_AMA} I'm calling to ask if you have a table for two at eight tonight.`);
  const before = s.call.tape.callerBytes;
  await line(s, 3000);
  await s.timers.advance(gl.LINE_NOTICE_CHECK_MS);
  assert.ok(!s.live.of("session.instructions.append").some(e => /not yet told them/.test(e.content)), "said, so not nudged");
  const live = await hangUp(s);
  assert.ok(live.recording, live.recordingWhy);
  assert.ok(s.call.tape.from > 0 && s.call.tape.from <= before, "nothing from before the notice is kept");
  assert.ok(live.recording.seconds >= 3 && live.recording.seconds < 6, String(live.recording.seconds));
  await fileRecording(OTHER, db.getCall(OTHER, row.id), live);
  assert.equal(db.getCall(OTHER, row.id).recording_state, "stored");
  assert.match(thirdPartyEvent({ row: db.getCall(OTHER, row.id), live }), /The recording is saved and goes out attached to this message automatically/);
});

test("no notice confirmed as said: the voice is nudged, and if it never says it, no audio is kept and the person is told plainly", async () => {
  const row = lineRow();
  const s = start(row);
  await theySay(s, "Luigi's, hello?");
  await voice(s, "Oh hey, hi! I'm calling to ask about a table for two at eight.");
  await line(s, 2000);
  await s.timers.advance(gl.LINE_NOTICE_CHECK_MS);
  const nudge = s.live.of("session.instructions.append").find(e => /not yet told them this call is recorded/.test(e.content));
  assert.ok(nudge && nudge.content.includes(NOTICE_AMA));
  await line(s, 2000);
  const live = await hangUp(s);
  assert.equal(live.recording, null);
  assert.equal(live.recordingWhy, manner.RECORD_UNCONFIRMED_WHY);
  assert.equal(live.notRecorded, true);
  await fileRecording(OTHER, db.getCall(OTHER, row.id), live);
  const r = db.getCall(OTHER, row.id);
  assert.equal(r.recording_state, "not_applicable", "not a fault: nothing was kept on purpose");
  assert.equal(r.recording_why, manner.RECORD_UNCONFIRMED_WHY);
  assert.match(thirdPartyEvent({ row: r, live }), /They asked for this call to be recorded, but there is NO audio: Reason could not confirm it told them/);
  // A voicemail or a menu only: nobody to tell, nothing kept.
  const vm = start(lineRow());
  await line(vm, 3000);
  const vmLive = await hangUp(vm);
  assert.equal(vmLive.recording, null);
  assert.equal(vmLive.recordingWhy, manner.RECORD_NO_PERSON_WHY);
});

test("after a hold or transfer the notice is said again: nudged if not, their side before it blanked; never said again, nothing after the hold is kept", async () => {
  // Said again: the whole call kept, the new person's words before the notice silenced.
  const a = start(lineRow());
  await theySay(a, "Luigi's, hello?");
  await voice(a, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(a, 1000);
  await theySay(a, "Let me put you through to bookings.");
  await line(a, manner.RENOTICE_GAP_MS + 2000);
  await theySay(a, "Bookings, this is Sam.");
  await voice(a, `Hi Sam! ${manner.RENOTICE_LINE} I'm after a table for two at eight tonight.`);
  await line(a, 1000);
  const aLive = await hangUp(a);
  assert.ok(aLive.recording, aLive.recordingWhy);
  assert.equal(a.call.tape.blanks.length, 1, "Sam's hello before the notice is not kept");
  assert.ok(!Number.isFinite(a.call.tape.limit), "nothing cut");
  // Not said again: nudged, and when it still isn't, the tape ends where the voice went quiet.
  const b = start(lineRow());
  await theySay(b, "Luigi's, hello?");
  await voice(b, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(b, 1500);
  await voice(b, " Lovely, thanks.");
  const quietFrom = b.call.tape.callerBytes;
  await line(b, 500);
  await line(b, manner.RENOTICE_GAP_MS + 2000);
  await theySay(b, "Bookings, this is Sam.");
  await voice(b, "Hi Sam! I'm after a table for two at eight tonight.");
  await line(b, 200);
  await b.timers.advance(gl.LINE_NOTICE_CHECK_MS);
  const nudge = b.live.of("session.instructions.append").find(e => /a hold or a transfer/.test(e.content));
  assert.ok(nudge && nudge.content.includes(manner.RENOTICE_LINE));
  await line(b, 5000);
  await voice(b, "Great, thanks.");
  await line(b, 1000);
  const bLive = await hangUp(b);
  assert.ok(Number.isFinite(b.call.tape.limit) && b.call.tape.limit <= quietFrom + 8000, "cut at the quiet, not later");
  assert.ok(bLive.recording && bLive.recording.seconds >= 1 && bLive.recording.seconds < 4, String(bLive.recording?.seconds));
  assert.ok(b.lines.some(l => l.gptlive_renotice_missing === b.row.id));
});

test("they object: Reason says okay, recording stops, EVERYTHING captured is deleted, the call carries on, and the person is told", async () => {
  const row = lineRow();
  const s = start(row, { objectionJudge: async (t) => /don't want to be recorded/.test(t) });
  await theySay(s, "Luigi's, hello?");
  await voice(s, `${NOTICE_AMA} Do you have a table for two at eight?`);
  await line(s, 3000);
  assert.ok(s.call.tape.seconds() > 2.5);
  await theySay(s, "Actually I don't want to be recorded.");
  await s.timers.advance(manner.OBJECTION_SETTLE_MS + 50);
  assert.equal(s.call.recordingStopWhy, "objected");
  assert.equal(s.call.tape.seconds(), 0, "deleted, not only stopped");
  assert.ok(s.live.of("session.instructions.append").some(e => e.content === manner.RECORDING_OFF_NOTE), "the voice says that's fine and carries on");
  await voice(s, "No problem, the recording's off. So, a table for two at eight?");
  await line(s, 2000);
  assert.equal(s.call.tape.seconds(), 0);
  assert.equal(s.call.done, false, "the call carried on");
  const live = await hangUp(s);
  assert.equal(live.recording, null);
  assert.equal(live.recordingWhy, manner.RECORD_DECLINED_WHY);
  assert.match(live.howItWent, /they asked not to be recorded, so recording stopped and all of the audio captured so far was deleted; the call carried on/);
  db.updateCall(OTHER, row.id, { state: "completed" });
  await fileRecording(OTHER, db.getCall(OTHER, row.id), live);
  const r = db.getCall(OTHER, row.id);
  assert.equal(r.recording_state, "not_applicable");
  assert.equal(r.recording_file, null);
  const note = thirdPartyEvent({ row: r, live });
  assert.match(note, /the other side said they didn't want to be recorded: recording stopped and the audio captured so far was deleted/);
  assert.match(note, /what was actually said/, "the transcript still comes");
  const st = await runTool("call_status", { call_id: r.id }, { conversationId: OTHER, calls: new FakeCallProvider() });
  assert.match(st.calls[0].recording_note, /There is NO audio of this call, though .* asked for it to be recorded: the other side asked not to be recorded/);
});

test("never recorded on the ask: a place ringing back, their own call, or a call they did not ask to be recorded", () => {
  assert.equal(gl.recordAskedCall(lineRow(OTHER, { direction: "in" })), false);
  assert.equal(gl.recordAskedCall({ ...lineRow(), is_owner: 1 }), false);
  const plain = start(lineRow(OTHER, { asked: false }));
  assert.equal(plain.call.recorded, false);
  assert.equal(plain.call.recordAsked, false);
  assert.equal(db.getCall(OTHER, plain.row.id).announcement, "");
  assert.doesNotMatch(plain.live.of("session.start")[0].session.instructions, /this call is recorded/i);
  // REASON_THIRDPARTY_RECORDING keeps its own words, untouched by the ask.
  config.thirdPartyRecording = true;
  try { assert.equal(gl.lineAnnouncement(lineRow()), manner.RECORDING_NOTICE_LINE); } finally { config.thirdPartyRecording = false; }
});

// ---------- the audio afterwards ----------

async function storedAskedCall(conv = C) {
  const row = lineRow(conv);
  const s = start(row);
  await theySay(s, "Luigi's, hello?");
  await voice(s, `${manner.recordNoticeLine(conv === C ? "Omari" : "Ama")} Do you have a table for two at eight?`);
  await line(s, 2000);
  const live = await hangUp(s);
  db.updateCall(conv, row.id, { state: "completed" });
  await fileRecording(conv, db.getCall(conv, row.id), live);
  const r = db.getCall(conv, row.id);
  assert.equal(r.recording_state, "stored");
  assert.ok(existsSync(r.recording_file));
  return r;
}

test("delivery: the audio goes to the person who asked, the way their own calls' does — marked sent only once it really went", async () => {
  const r = await storedAskedCall(C);
  let ok = false;
  const seen = [];
  const rt = new Runtime({ runTurn: async () => "they've got 8, want it?", deliver: async ({ media }) => { seen.push(media); return ok ? { ok: true, mediaOk: true } : { ok: false, mediaOk: false, error: "upload failed" }; } });
  await rt.inbound(C, "how did it go?");
  assert.equal(seen[0]?.call_id, r.id, "attached to the message about it");
  assert.equal(db.getCall(C, r.id).recording_sent_at, null, "a failed send is not a send");
  const waiting = await runTool("call_status", { call_id: r.id }, { conversationId: C, calls: new FakeCallProvider() });
  assert.equal(waiting.calls[0].recording.already_sent, false);
  assert.match(waiting.calls[0].recording_note, /goes out with your next message/);
  ok = true;
  await rt.inbound(C, "send me the audio");
  assert.equal(seen[1]?.call_id, r.id);
  assert.ok(db.getCall(C, r.id).recording_sent_at, "sent once it went");
  const sent = await runTool("call_status", { call_id: r.id }, { conversationId: C, calls: new FakeCallProvider() });
  assert.match(sent.calls[0].recording_note, /already been sent/);
});

test("delete my data: their recordings of calls they asked to be recorded go with the rest", async () => {
  const r = await storedAskedCall(C);
  const two = await storedAskedCall(C);
  // "Delete all my call recordings": gated by the yes like every other one, then everything goes.
  const blocked = await runTool("call_recording_delete", { all: true }, { conversationId: C, messages: [] });
  assert.equal(blocked.blocked, "needs_confirmation");
  const { deleteCallRecordings } = await import("../src/calls/recordingdelete.js");
  const out = deleteCallRecordings(C, { all: true });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(out.counts.deleted, 2);
  for (const x of [r, two]) {
    assert.equal(existsSync(x.recording_file), false, "the file is gone");
    assert.equal(db.getCall(C, x.id).recording_state, "deleted");
  }
  // And one of them on its own, by the tool.
  const three = await storedAskedCall(C);
  const one = await runTool("call_recording_delete", { call_id: three.id }, { conversationId: C, messages: [] });
  assert.equal(one.ok, true, one.error);
  assert.equal(existsSync(three.recording_file), false);
});

// ---------- calls with no question before them ----------
//
// Which calls to somebody else get what, before they dial (src/tools.js runTool → call_place):
//   (a) a yes is asked (confirm_request): the offer rides in that question;
//   (b) no yes asked — their request was the yes (src/askedcall.js), a standing permission, a to-do plan —
//       but the undo window holds it: the offer rides in the "calling … in 30s" line;
//   (c) neither (their call undo window set to 0): nothing waits; the text after the call carries a
//       one-time tip.

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

test("(b) no question, undo window: the offer is IN the \"calling … in 30s\" line; \"record it\" inside the window records that call, which still goes on time", () => withWindow(30, async () => {
  const calls = new FakeCallProvider();
  const held = await plainAskCall(C, { calls });
  assert.equal(held.undo_held, true, JSON.stringify(held).slice(0, 300));
  assert.equal(manner.HOLD_RECORD_OFFER, ", or say \"record it\" if you want the audio (I'd tell them it's recorded)");
  assert.match(held.say_exactly, /^calling .+ in 30s — just tell me if you want to stop it, or say "record it" if you want the audio \(I'd tell them it's recorded\)$/);
  assert.match(held.note, /call call_place again with the same 'to' and record_said/);
  assert.equal(calls.placed.length, 0);
  const due = db.liveHolds(C)[0].due_at;
  // Ten seconds in, they say "record it".
  clock.skip(10_000);
  const added = await runTool("call_place", { ...ASK, record_said: "record it" }, { conversationId: C, calls, messages: [said(C, REQUEST), said(C, "record it")], kind: "user" });
  assert.equal(added.ok, true, JSON.stringify(added).slice(0, 300));
  assert.equal(added.recording_added, true);
  assert.equal(added.going_out_in_seconds, 20);
  assert.match(added.say_exactly, /^ok, I'll record it and tell them at the start that it's recorded — still calling in 20s$/);
  assert.equal(calls.placed.length, 0, "nothing new dialled");
  assert.equal(db.liveHolds(C).length, 1);
  assert.equal(db.liveHolds(C)[0].due_at, due, "no later than it would have gone");
  // Not before its time; at its time, recorded, with the notice on the row.
  assert.equal((await release(calls)).due, 0);
  clock.skip(due - clock.now());
  assert.equal((await release(calls)).sent, 1);
  assert.equal(calls.placed.length, 1);
  const row = db.db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY id DESC").get(C);
  assert.equal(Number(row.record_asked), 1);
  assert.equal(row.record_said, "record it");
  assert.equal(gl.lineAnnouncement(row), manner.recordNoticeLine("Omari"));
  assert.equal(db.recordAskFor(C, SHOP), null, "used by that call");
}));

test("(b) no reply in the window: not recorded, and it goes exactly on time; \"record it\" after it went is too late and is not kept for a later call", () => withWindow(30, async () => {
  const calls = new FakeCallProvider();
  await plainAskCall(C, { calls });
  const due = db.liveHolds(C)[0].due_at;
  clock.skip(due - clock.now() - 1);
  assert.equal((await release(calls)).due, 0);
  clock.skip(1);
  assert.equal((await release(calls)).sent, 1);
  const row = db.db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY id DESC").get(C);
  assert.equal(Number(row.record_asked), 0);
  assert.equal(row.record_offer, "hold");
  const late = await runTool("call_place", { ...ASK, record_said: "record it" }, { conversationId: C, calls, messages: [said(C, REQUEST), said(C, "record it")], kind: "user" });
  assert.equal(late.status, "too_late", JSON.stringify(late).slice(0, 300));
  assert.equal(db.recordAskFor(C, SHOP), null, "never left for the next call to that number");
  assert.equal(calls.placed.length, 1);
}));

test("(a) a question was asked: the offer was in it, so the \"calling … in 30s\" line is today's, word for word", () => withWindow(30, async () => {
  const { out } = await askThenCall(C, { request: REQUEST, reply: "yes" });
  assert.equal(out.undo_held, true);
  assert.doesNotMatch(out.say_exactly, /record it/);
  assert.match(out.say_exactly, /^calling .+ in 30s — just tell me if you want to stop it$/);
}));

test("switch off: the \"calling … in 30s\" line and its note are today's, byte for byte", () => withWindow(30, async () => {
  config.callRecordAsk = "off";
  const held = await plainAskCall(C);
  assert.equal(held.undo_held, true);
  assert.equal(held.say_exactly, undo.holdLine({ doing: undo.describe({ action: "call_place", input: ASK, conversationId: C, to: SHOP }).doing, seconds: 30 }));
  assert.equal(held.note, "NOTHING HAS GONE YET. It goes in 30 seconds unless they stop it. Say the line in say_exactly, word for word, as your whole reply — do not add to it, do not explain the window, and do NOT say you sent it. If they say anything in the next 30 seconds that means stop, call undo_send.");
}));

test("(c) neither a question nor a window: it dials at once; the text after it says, ONCE per person ever, that next time they can say \"record it\"", async () => {
  // Window 0 (this file's REASON_UNDO_SECONDS): nothing waits.
  const calls = new FakeCallProvider();
  const events = [];
  const runtime = { event: async (_c, text) => { events.push(text); return events.length === 2 ? "" : "they have a table at 8"; } };
  let n = 0;
  const placeAndTell = async () => {
    const out = await plainAskCall(C, { calls, input: { to: `+1646858070${n++}`, goal: "ask about a table for two at 8" } });
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
    assert.ok(!out.undo_held, "no wait added");
    db.updateCall(C, out.call_id, { state: "completed", recording_state: "not_applicable", recording_why: manner.NOT_RECORDED_WHY });
    const row = db.getCall(C, out.call_id);
    assert.equal(row.record_offer, "none");
    await tellTheOwner({ row, live: {}, runtime });
    return events.at(-1);
  };
  const first = await placeAndTell();
  assert.ok(first.includes(`End the message with this one line, as written: ${manner.RECORD_TIP_LINE}`));
  assert.equal(manner.RECORD_TIP_LINE, "Next time, just say \"record it\" when you ask me to call somewhere and I'll send you the audio (I'd tell them it's recorded).");
  assert.ok(db.db.prepare("SELECT record_tip_told_at FROM accounts WHERE conversation_id = ?").get(C).record_tip_told_at, "kept on their account");
  for (let i = 0; i < 3; i++) assert.ok(!(await placeAndTell()).includes(manner.RECORD_TIP_LINE), "never again");
  // Another person gets theirs once too; a call they asked to be recorded never carries it.
  const other = await plainAskCall(OTHER, { messages: [said(OTHER, REQUEST)], input: { to: "+16468580799", goal: "ask about a table" } });
  db.updateCall(OTHER, other.call_id, { state: "completed" });
  const otherRow = db.getCall(OTHER, other.call_id);
  await tellTheOwner({ row: { ...otherRow, record_asked: 1 }, live: {}, runtime: { event: async (_c, t) => { events.push(t); return "ok"; } } });
  assert.ok(!events.at(-1).includes(manner.RECORD_TIP_LINE));
  await tellTheOwner({ row: otherRow, live: {}, runtime: { event: async (_c, t) => { events.push(t); return "ok"; } } });
  assert.ok(events.at(-1).includes(manner.RECORD_TIP_LINE));
});

test("(c) a message that never went keeps the tip owed; switch off, never a tip and no offer marker", async () => {
  const out = await plainAskCall(C);
  db.updateCall(C, out.call_id, { state: "completed" });
  await tellTheOwner({ row: db.getCall(C, out.call_id), live: {}, runtime: { event: async () => "" } });
  assert.equal(db.db.prepare("SELECT record_tip_told_at FROM accounts WHERE conversation_id = ?").get(C).record_tip_told_at, null);
  config.callRecordAsk = "off";
  const off = await plainAskCall(C, { input: { to: "+16468580671", goal: "ask about a table" } });
  const row = db.getCall(C, off.call_id);
  assert.equal(row.record_offer, "");
  const seen = [];
  await tellTheOwner({ row: { ...row, state: "completed" }, live: {}, runtime: { event: async (_c, t) => { seen.push(t); return "ok"; } } });
  assert.ok(!seen[0].includes(manner.RECORD_TIP_LINE));
});

test("Reason's own offer of a call may carry the recording option; \"yes, record it\" to it records the call that follows, now or later", async () => {
  const def = toolsFor(C).find(t => t.name === "call_place");
  assert.match(def.description, /When you offer a call yourself \("want me to call B&H and ask what they've got\?"\), you can add in the same offer, briefly, that you can record it; a "yes, record it" to that counts/);
  assert.doesNotMatch(tools.find(t => t.name === "call_place").description, /When you offer a call yourself/, "not where the switch is off");
  // Reason offered; they said "yes, record it"; the call goes on their own words.
  const msgs = [said(C, "what lenses does B&H have?"), said(C, "yes, record it")];
  const out = await runTool("call_place", { ...ASK, record_said: "record it" }, { conversationId: C, calls: new FakeCallProvider(), messages: msgs, kind: "user", askedCallJudge: yesJudge });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.ok(out.call_id, JSON.stringify(out).slice(0, 300));
  assert.equal(Number(db.getCall(C, out.call_id).record_asked), 1);
  assert.equal(db.getCall(C, out.call_id).record_offer, "asked_for");
});
