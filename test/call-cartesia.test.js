// The Cartesia voice trial on the operator's own calls (src/calls/cartesia.js, src/calls/calltrial.js;
// docs/calls-cartesia.md section 5). No network: Twilio's stream, the Cartesia agent socket, GPT-Live and
// Reason's turn are stand-ins, as in test/gptlive.test.js. Every case that is not his own call with his
// choice on must build GptLiveCall and open no Cartesia socket.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cartesia-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_CALL_CARTESIA;
delete process.env.CARTESIA_API_KEY;

const gl = await import("../src/calls/gptlive.js");
const trial = await import("../src/calls/calltrial.js");
const cartesia = await import("../src/calls/cartesia.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test", callVoice: "gptlive" };
const CARTESIA = { callCartesia: "owner", cartesiaKey: "ck-test", cartesiaAgentId: "agent_test" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callIdentity: false, callCartesia: "off", cartesiaKey: "", cartesiaAgentId: "", callAmbience: "", ...TWILIO });
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
        await new Promise(r => setImmediate(r));
      }
      t = end;
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
    close: () => { open = false; handlers.close.forEach(f => f(1000)); },
    onMessage: (f) => handlers.msg.push(f),
    onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
  };
}

/** A stand-in for GPT-Live's socket and Cartesia's agent socket (both are `{ send, close, on }`). */
function fakeSocket() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  let closed = false;
  return {
    sent,
    closed: () => closed,
    socket: { send: (o) => sent.push(o), close: () => { closed = true; }, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()),
    emit: (e) => h.event.forEach(f => f(e)),
    shut: (code = 1000) => h.close.forEach(f => f(code)),
    of: (type) => sent.filter(e => e.type === type),
  };
}

const SPEECH = Buffer.alloc(160, 0x10).toString("base64"); // loud μ-law
const QUIET = Buffer.alloc(160, 0xff).toString("base64");

const ownCall = (conversationId = C, over = {}) => db.createCall(conversationId, {
  provider: "gptlive", toNumber: conversationId === C ? "+12025551234" : "+13105550000", isOwner: true, goal: "check in", facts: [],
  announcement: "Hey Omari, it's Reason.", state: "placing", ...over,
});
const businessCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12125550100", isOwner: false, goal: "book a table", facts: [],
  announcement: "Hi, I'm calling for Omari.", state: "placing",
});

/** acceptStream with every outside thing a stand-in; counts any Cartesia module load or agent socket. */
function accept(row, extra = {}) {
  const twilio = fakeTwilio();
  const live = fakeSocket();
  const agent = fakeSocket();
  const lines = [];
  const seen = { loaded: 0, opened: 0, live: 0, deleted: [] };
  const call = gl.acceptStream({
    token: row.webhook_token, socket: twilio, log: (o) => lines.push(o), openLive: () => { seen.live++; return live.socket; },
    openCartesia: async () => { seen.loaded++; return cartesia; },
    cartesiaOpts: { openAgent: () => { seen.opened++; return agent.socket; }, deleteCall: async (id) => { seen.deleted.push(id); return { ok: true, redacted: true, status: 200 }; }, ...extra },
  });
  return { call, twilio, live, agent, lines, seen };
}

const settle = () => new Promise(r => setImmediate(r));
const stop = (call) => {
  const c = call?.holder ?? call;
  if (!c) return;
  for (const k of ["capTimer", "roomTimer", "openTimer", "noticeTimer", "byeTimer", "readyTimer"]) if (c[k]) clearTimeout(c[k]);
  c.done = true;
  if (call !== c) call.done = true;
};

// ---------- who gets it: everything else builds GptLiveCall and opens no Cartesia socket ----------

for (const [label, setup, rowOf] of [
  ["the switch unset", () => { db.setCallTrial(C, "cartesia"); Object.assign(config, { cartesiaKey: "ck-test", cartesiaAgentId: "agent_test" }); }, () => ownCall()],
  ["the switch at owner, his choice off", () => { Object.assign(config, CARTESIA); }, () => ownCall()],
  ["another account's own call", () => { Object.assign(config, CARTESIA); db.setCallTrial(C, "cartesia"); db.setCallTrial(OTHER, "cartesia"); }, () => ownCall(OTHER)],
  ["a business or third-party call of his", () => { Object.assign(config, CARTESIA); db.setCallTrial(C, "cartesia"); }, () => businessCall()],
  ["no Cartesia key on this machine", () => { Object.assign(config, CARTESIA, { cartesiaKey: "" }); db.setCallTrial(C, "cartesia"); }, () => ownCall()],
]) {
  test(`${label}: GptLiveCall as today, no Cartesia socket`, async () => {
    setup();
    const row = rowOf();
    assert.equal(trial.cartesiaTrialFor(db.getCall(row.conversation_id, row.id)), false);
    const s = accept(row);
    assert.ok(s.call instanceof gl.GptLiveCall, "built GptLiveCall");
    s.twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
    await settle();
    assert.equal(s.seen.loaded, 0, "the Cartesia relay was never loaded");
    assert.equal(s.seen.opened, 0, "no Cartesia socket");
    assert.equal(s.lines.some(l => Object.keys(l).some(k => k.startsWith("cartesia_"))), false);
    stop(s.call);
  });
}

test("the switch reads off for anything but owner; there is no on", async () => {
  Object.assign(config, CARTESIA);
  db.setCallTrial(C, "cartesia");
  assert.equal(trial.cartesiaTrialFor(ownCall()), true);
  config.callCartesia = "on";
  assert.equal(trial.cartesiaTrialFor(ownCall()), false, "an \"on\" is not a value it takes");
  assert.equal(trial.trialOffered(C), false);
  config.callCartesia = "owner";
  assert.equal(trial.trialOffered(C), true);
  assert.equal(trial.trialOffered(OTHER), false, "nobody else is offered it");
});

// ---------- his own call, his choice on ----------

async function trialCall(extra = {}) {
  Object.assign(config, CARTESIA);
  db.setCallTrial(C, "cartesia");
  const timers = fakeTimers();
  const brainAsked = [];
  const finished = [];
  const row = ownCall();
  const s = accept(row, { timers, now: timers.now, ...extra });
  // finish: the real settle is not run here; the relay hands it the same surface GptLiveCall does.
  await settle(); await settle();
  return { ...s, row, timers, brainAsked, finished };
}

test("his call with his choice on: one Cartesia agent, mulaw both ways, his persona and name as variables", async () => {
  const s = await trialCall();
  assert.equal(s.seen.loaded, 1);
  assert.equal(s.seen.opened, 1);
  assert.ok(s.call.holder instanceof cartesia.CartesiaAgentCall, "the stream's holder is the Cartesia relay");
  assert.equal(s.seen.live, 0, "no GPT-Live session opened for a trial call");
  s.twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  s.agent.open();
  const [create] = s.agent.of("session_create");
  assert.deepEqual(create.audio, { input_format: "mulaw_8000", output_delivery: "speaking_pace", continuous_input: true });
  assert.equal(create.dynamic_variables.their_name, "Omari");
  assert.equal(create.dynamic_variables.greeting, "Hey Omari, it's Reason.");
  assert.equal(create.dynamic_variables.reason_call, gl.voiceInstructionsFor(db.getCall(C, s.row.id), { line: false, turnGate: false }).slice(0, cartesia.VARIABLE_MAX),
    "the same instructions a GPT-Live own call gets, not a second persona");
  s.twilio.say({ event: "media", media: { payload: QUIET } });
  assert.equal(s.agent.of("audio_input").length, 0, "nothing sent before session_ready");
  s.agent.emit({ type: "session_ready", call_id: "ac_1" });
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  assert.equal(s.agent.of("audio_input").length, 1);
  assert.equal(s.agent.of("audio_input")[0].audio, SPEECH);
  await s.timers.advance(2000);
  assert.ok(!s.lines.some(l => l.cartesia_fell_back), "ready in time: no fall-back");
  stop(s.call);
});

test("the agent's audio reaches Twilio, a clear clears the phone, and the numbers are logged", async () => {
  const s = await trialCall();
  s.twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  s.agent.open();
  s.agent.emit({ type: "session_ready", call_id: "ac_1" });
  s.agent.emit({ type: "turn_ended", turn: 1, role: "user", text: "Hey, how's it going?", end_time: 2.1, eager_end_timestamp: 1.9 });
  await s.timers.advance(400);
  s.agent.emit({ type: "audio_output", audio: SPEECH });
  const media = s.twilio.sent.filter(m => m.event === "media");
  assert.equal(media.length, 1);
  assert.equal(media[0].streamSid, "MZ1");
  const reply = s.lines.find(l => l.cartesia_reply);
  assert.deepEqual({ kind: reply.kind, ms: reply.ms }, { kind: "plain", ms: 400 });
  const turn = s.lines.find(l => l.cartesia_turn);
  assert.equal(turn.end_time, 2.1);
  assert.equal(turn.eager_end, 1.9);
  // Talked over: his sound while the agent speaks, then their clear.
  await s.timers.advance(100);
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  await s.timers.advance(150);
  s.agent.emit({ type: "audio_output_clear" });
  assert.ok(s.twilio.sent.some(m => m.event === "clear" && m.streamSid === "MZ1"));
  const over = s.lines.find(l => l.cartesia_talked_over);
  assert.equal(over.sound_to_clear_ms, 150);
  // Numbers only: no words in the measurement lines.
  for (const l of s.lines.filter(l => l.cartesia_reply || l.cartesia_talked_over || l.cartesia_turn)) for (const v of Object.values(l)) assert.ok(typeof v !== "string" || v.length < 20);
  stop(s.call);
});

test("ask_reason runs Reason's turn with the call so far and answers the agent with its words", async () => {
  Object.assign(config, CARTESIA);
  const asked = [];
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const agent = fakeSocket();
  const finished = [];
  const deleted = [];
  const call = new cartesia.CartesiaAgentCall({
    call: ownCall(), twilio, openAgent: () => agent.socket, now: timers.now, timers, log: () => {},
    brain: async (messages) => { asked.push(messages); await timers.advance(900); return { text: "It's 14 degrees and dry near work.", tools: [] }; },
    finish: async (live) => { finished.push(live); },
    deleteCall: async (id) => { deleted.push(id); return { ok: true, redacted: true, status: 200 }; },
  });
  call.begin();
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  agent.open();
  agent.emit({ type: "session_ready", call_id: "ac_9" });
  agent.emit({ type: "turn_ended", turn: 1, role: "assistant", text: "Hey Omari, it's Reason." });
  agent.emit({ type: "turn_ended", turn: 2, role: "user", text: "What's the weather near work?" });
  agent.emit({ type: "client_tool_call", tool_call_id: "tc_1", tool_name: "ask_reason", parameters: { request: "weather near work" }, expects_response: true });
  await settle(); await settle();
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].map(m => m.role), ["assistant", "user"]);
  assert.match(asked[0][1].content, /weather near work/);
  const [res] = agent.of("client_tool_result");
  assert.deepEqual(res, { type: "client_tool_result", tool_call_id: "tc_1", result: "It's 14 degrees and dry near work.", is_error: false });
  agent.emit({ type: "client_tool_call", tool_call_id: "tc_2", tool_name: "open_cart", parameters: {}, expects_response: true });
  await settle();
  assert.equal(agent.of("client_tool_result")[1].is_error, true, "only ask_reason is ours");
  // The end: the settle gets the surface GptLiveCall gives it; their copy is deleted and checked.
  agent.emit({ type: "turn_ended", turn: 3, role: "assistant", text: "Fourteen and dry. [laughter] Bring a jacket though." });
  twilio.say({ event: "stop" });
  await settle(); await settle();
  assert.equal(finished.length, 1);
  const live = finished[0];
  assert.equal(live.state, "completed");
  assert.equal(live.termination, "hung up");
  assert.deepEqual(live.turns.map(t => t.who), ["reason", "them", "reason"]);
  assert.match(live.transcript, /^Reason: Hey Omari/);
  for (const k of ["outcome", "summary", "durationS", "costCents", "recordingWhy"]) assert.ok(k in live, k);
  assert.deepEqual(deleted, ["ac_9"]);
  assert.equal(agent.closed(), true);
  assert.equal(twilio.open(), false);
});

// ---------- falling back to GPT-Live ----------

test("not ready within 1.5 s: the same call carries on with GPT-Live, which hears the stream's start", async () => {
  const s = await trialCall();
  s.twilio.say({ event: "start", start: { streamSid: "MZ7", callSid: "CA7" } });
  s.agent.open();
  await s.timers.advance(1499);
  assert.equal(s.lines.some(l => l.cartesia_fell_back), false);
  await s.timers.advance(2);
  const fell = s.lines.find(l => l.cartesia_fell_back);
  assert.ok(fell, "the fall-back is logged");
  assert.match(fell.why, /not ready in 1500 ms/);
  assert.equal(s.agent.closed(), false, "held a moment for a late session_ready…");
  s.agent.emit({ type: "session_ready", call_id: "ac_late" });
  await settle();
  assert.equal(s.agent.closed(), true, "…then closed");
  assert.deepEqual(s.seen.deleted, ["ac_late"], "the late session is deleted on their side");
  assert.ok(s.lines.some(l => l.cartesia_recording_deleted && l.ok === true));
  assert.equal(s.agent.of("audio_input").length, 0, "no audio ever went to it");
  const taken = gl.acceptStream({ token: s.row.webhook_token, socket: fakeTwilio(), log: () => {} });
  assert.equal(taken, null, "the call's stream is held (by GPT-Live now)");
  assert.equal(s.seen.live, 1, "GPT-Live's session was opened on the same stream");
  assert.ok(s.call.holder instanceof gl.GptLiveCall);
  assert.equal(s.call.holder.streamSid, "MZ7", "and it heard the start said before it existed");
  // Twilio's audio from here goes to GPT-Live, not the agent.
  const before = s.agent.sent.length;
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  assert.equal(s.agent.sent.length, before);
  stop(s.call);
});

test("the agent fails before it is ready: GPT-Live takes the call, and a session it did start is deleted", async () => {
  const s = await trialCall();
  s.twilio.say({ event: "start", start: { streamSid: "MZ8", callSid: "CA8" } });
  s.agent.open();
  s.agent.emit({ type: "error", code: "agent_failed", message: "x", fatal: true });
  await settle();
  assert.match(s.lines.find(l => l.cartesia_fell_back)?.why ?? "", /error before ready/);
  assert.equal(s.seen.live, 1);
  stop(s.call);
  const t = await trialCall();
  t.twilio.say({ event: "start", start: { streamSid: "MZ9", callSid: "CA9" } });
  t.agent.open();
  t.agent.shut(1011);
  await settle();
  assert.match(t.lines.find(l => l.cartesia_fell_back)?.why ?? "", /closed before ready/);
  assert.equal(t.seen.live, 1);
  stop(t.call);
  // Ready, then broken mid-call: he is still on the line, so GPT-Live takes the rest, with what was said.
  const u = await trialCall();
  u.twilio.say({ event: "start", start: { streamSid: "MZ10", callSid: "CA10" } });
  u.agent.open();
  u.agent.emit({ type: "session_ready", call_id: "ac_mid" });
  u.agent.emit({ type: "turn_ended", turn: 1, role: "user", text: "Remind me about the dentist." });
  u.agent.shut(1011);
  await settle(); await settle();
  assert.match(u.lines.find(l => l.cartesia_fell_back)?.why ?? "", /closed mid-call \(1011\)/);
  assert.equal(u.seen.live, 1, "GPT-Live opened on the same stream");
  assert.ok(u.call.holder instanceof gl.GptLiveCall);
  assert.ok(u.call.holder.turns.some(t => t.who === "them" && /dentist/.test(t.text)), "the turns so far went with it");
  assert.deepEqual(u.seen.deleted, ["ac_mid"], "and their copy is deleted");
  assert.equal(u.twilio.open(), true, "the phone line stayed up");
  stop(u.call);
  // A clean close is the agent's own hang-up: the call ends, no fall-back.
  const v = await trialCall();
  v.twilio.say({ event: "start", start: { streamSid: "MZ11", callSid: "CA11" } });
  v.agent.open();
  v.agent.emit({ type: "session_ready", call_id: "ac_bye" });
  v.agent.shut(1000);
  await settle(); await settle(); await settle();
  assert.equal(v.seen.live, 0);
  assert.equal(v.twilio.open(), false);
  assert.deepEqual(v.seen.deleted, ["ac_bye"]);
});

test("the relay fails to load: GPT-Live takes the call and that is logged", async () => {
  Object.assign(config, CARTESIA);
  db.setCallTrial(C, "cartesia");
  const row = ownCall();
  const twilio = fakeTwilio();
  const live = fakeSocket();
  const lines = [];
  let opened = 0;
  const slot = gl.acceptStream({ token: row.webhook_token, socket: twilio, log: (o) => lines.push(o), openLive: () => { opened++; return live.socket; }, openCartesia: async () => { throw new Error("broken build"); } });
  twilio.say({ event: "start", start: { streamSid: "MZ2", callSid: "CA2" } });
  await settle(); await settle();
  assert.match(lines.find(l => l.cartesia_fell_back)?.why ?? "", /not loaded/);
  assert.equal(opened, 1, "GPT-Live opened, having heard the start said before it existed");
  assert.equal(slot.holder.streamSid, "MZ2");
  stop(slot);
});

// ---------- the pieces ----------

test("deleteAgentCall: tried again while the call is not finished; ok only with redacted_at", async () => {
  const seen = [];
  const answers = [{ status: 400, json: { message: "not terminal" } }, { status: 200, json: { id: "ac_1", redacted_at: "2026-11-13T13:00:00Z" } }];
  const fetchImpl = async (url, init) => { seen.push({ url, method: init.method, key: init.headers["X-API-Key"] }); const a = answers.shift(); return { ok: a.status < 300, status: a.status, json: async () => a.json }; };
  const d = await cartesia.deleteAgentCall("ac_1", { key: "ck-test", fetchImpl, sleep: async () => {} });
  assert.deepEqual(d, { ok: true, redacted: true, status: 200, why: "" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "https://api.cartesia.ai/agents/calls/ac_1");
  assert.equal(seen[0].method, "DELETE");
  const no = await cartesia.deleteAgentCall("ac_2", { key: "ck-test", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: "ac_2" }) }), sleep: async () => {} });
  assert.equal(no.ok, false, "a 200 with no redacted_at is not proof");
  assert.equal((await cartesia.deleteAgentCall("")).ok, false);
});

test("passableSocket: a new holder hears the stream's start again, never stale audio, and the old one goes deaf", () => {
  const tw = fakeTwilio();
  const line = trial.passableSocket(tw);
  tw.say({ event: "connected" });
  tw.say({ event: "start", start: { streamSid: "MZ" } });
  tw.say({ event: "media", media: { payload: QUIET } });
  const a = line.pass();
  const heardA = [];
  a.onMessage((t) => heardA.push(JSON.parse(t).event));
  a.flush();
  tw.say({ event: "media", media: { payload: SPEECH } });
  assert.deepEqual(heardA, ["connected", "start", "media"]);
  const b = line.pass();
  const heardB = [];
  b.onMessage((t) => heardB.push(JSON.parse(t).event));
  b.flush();
  tw.say({ event: "media", media: { payload: SPEECH } });
  assert.deepEqual(heardB, ["connected", "start", "media"]);
  assert.equal(heardA.length, 3, "the first holder hears nothing more");
});
