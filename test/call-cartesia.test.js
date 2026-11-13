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

test("the switch: owner offers the choice to the operator only; on offers it to nobody (test/call-cartesia-everyone.test.js)", async () => {
  Object.assign(config, CARTESIA);
  db.setCallTrial(C, "cartesia");
  assert.equal(trial.cartesiaTrialFor(ownCall()), true);
  config.callCartesia = "on";
  assert.equal(trial.cartesiaTrialFor(ownCall()), true, "on: his own call too");
  assert.equal(trial.trialOffered(C), false, "on: no choice, not even the operator's");
  assert.equal(trial.trialOffered(OTHER), false);
  config.callCartesia = "off";
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
  assert.equal(create.dynamic_variables.reason_call, `${gl.voiceInstructionsFor(db.getCall(C, s.row.id), { line: false, turnGate: false })}\n${cartesia.clockLine(db.getCall(C, s.row.id))}\n${cartesia.cartesiaCallLines()}`,
    "the same instructions a GPT-Live own call gets, not a second persona, then this line's manner");
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
  s.agent.emit({ type: "audio_output", audio: SPEECH });
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  await s.timers.advance(150);
  s.agent.emit({ type: "audio_output_clear" });
  assert.ok(s.twilio.sent.some(m => m.event === "clear" && m.streamSid === "MZ1"));
  const over = s.lines.find(l => l.cartesia_talked_over);
  assert.equal(over.sound_to_clear_ms, 150);
  assert.equal(over.playing, true);
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

// ---------- his choice, by text ----------

test("call_voice_trial: only the operator with the switch at owner is shown it; on, off and status say which voice", async () => {
  const tools = await import("../src/tools.js");
  const names = (c) => tools.toolsFor(c).map(t => t.name);
  assert.equal(names(C).includes("call_voice_trial"), false, "switch off: nobody is shown it");
  Object.assign(config, CARTESIA);
  assert.equal(names(C).includes("call_voice_trial"), true, "the operator, switch at owner");
  assert.equal(names(OTHER).includes("call_voice_trial"), false, "nobody else is shown it");
  const run = (c, choice) => tools.runTool("call_voice_trial", { choice }, { conversationId: c });
  const refused = await run(OTHER, "on");
  assert.ok(refused.ok !== true && refused.error, "and the dispatch refuses it for anyone else");
  assert.equal(db.callTrial(OTHER), "");
  assert.equal(db.callTrial(C), "", "empty by default");
  const on = await run(C, "on");
  assert.equal(on.voice, "cartesia");
  assert.match(on.say, /Cartesia voice/);
  assert.equal(db.callTrial(C), "cartesia");
  assert.equal(trial.cartesiaTrialFor(ownCall()), true);
  assert.equal((await run(C, "status")).voice, "cartesia");
  const off = await run(C, "off");
  assert.equal(off.voice, "usual");
  assert.equal(trial.cartesiaTrialFor(ownCall()), false);
  // Set on while the agent is not connected here: it says so, and calls stay on GPT-Live.
  config.cartesiaAgentId = "";
  assert.match((await run(C, "on")).say, /not connected/);
  assert.equal(trial.cartesiaTrialFor(ownCall()), false);
  config.callCartesia = "off";
  const gone = await run(C, "status");
  assert.ok(gone.ok !== true && gone.error, "switch back off: the tool is gone");
});

// ---------- the agent, made once ----------

test("setup script: calls nobody without --yes; with it, makes ask_reason then the agent in Gemma and prints its id", async () => {
  const setup = await import("../scripts/cartesia-agent-setup.mjs");
  const said = [];
  const calls = [];
  const call = async (key, p, opts = {}) => {
    calls.push({ p, method: opts.method ?? "GET", body: opts.body });
    if (p.startsWith("/v1/agents/models")) return { ok: true, json: { data: [{ id: "slow", average_latency_ms: 900 }, { id: "fast", average_latency_ms: 500 }] } };
    if (p === "/v1/agents/tools") return { ok: true, json: { id: "tool_1" } };
    if (p === "/v1/agents") return { ok: true, json: { id: "agent_new" } };
    return { ok: false, error: "unexpected" };
  };
  assert.equal(await setup.main([], { log: (l) => said.push(l), call, key: "ck-test" }), 0);
  assert.equal(calls.length, 0, "no --yes: nothing asked of Cartesia");
  assert.match(said.join("\n"), /Nothing was made/);
  said.length = 0;
  assert.equal(await setup.main(["--yes", "--keyterms", "Kibaga, Shoreditch"], { log: (l) => said.push(l), call, key: "ck-test" }), 0);
  assert.deepEqual(calls.map(c => `${c.method} ${c.p.split("?")[0]}`), ["GET /v1/agents/models", "POST /v1/agents/tools", "POST /v1/agents"]);
  const tool = calls[1].body;
  assert.equal(tool.type, "client");
  assert.equal(tool.name, cartesia.ASK_REASON);
  assert.equal(tool.expects_response, true);
  const agent = calls[2].body.config;
  assert.equal(agent.audio.output.voice_id, "62ae83ad-4f6a-430b-af41-a9bede9286ca", "Gemma");
  assert.equal(agent.language.primary, "en-GB");
  assert.equal(agent.model.id, "fast");
  assert.deepEqual(agent.tools, [{ id: "tool_1" }]);
  assert.ok(agent.system_tools.end_call);
  assert.match(agent.instructions, /\{\{reason_call\}\}/);
  assert.equal(agent.initial_message, "{{greeting}}");
  assert.ok(agent.audio.input.keyterms.includes("Kibaga"));
  assert.equal(setup.KEYTERM_SLOTS, cartesia.KEYTERM_SLOTS);
  for (let i = 1; i <= setup.KEYTERM_SLOTS; i++) assert.ok(agent.audio.input.keyterms.includes(`{{keyterm_${i}}}`));
  assert.match(said.join("\n"), /REASON_CARTESIA_AGENT_ID=agent_new/);
  assert.ok(!said.join("\n").includes("ck-test"), "the key is never printed");
});

test("every variable the agent's text uses is supplied at session_create", async () => {
  const setup = await import("../scripts/cartesia-agent-setup.mjs");
  const body = JSON.stringify(setup.agentBody({ model: "m", toolId: "t" }));
  const used = new Set([...body.matchAll(/\{\{([a-z0-9_]+)\}\}/gi)].map(m => m[1]));
  const vars = cartesia.sessionVariables(ownCall());
  for (const v of used) assert.ok(v in vars, `${v} is supplied`);
  for (const v of Object.values(vars)) assert.ok(typeof v === "string" && v.length > 0, "no empty value");
});

// ---------- the number to compare against, on a normal call ----------

test("a normal GPT-Live call logs the first audio WITH SPEECH after a hand-back, once (log only)", async () => {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeSocket();
  const lines = [];
  const call = new gl.GptLiveCall({
    call: ownCall(), twilio, openLive: () => live.socket, now: timers.now, timers, log: (o) => lines.push(o),
    brain: async () => ({ text: "It's 3 pm in Accra.", tools: [] }), finish: async () => {},
  });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  live.emit({ type: "session.input_transcript.delta", delta: " What time is it in Accra?" });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_t" } });
  await timers.advance(300);
  live.emit({ type: "session.output_audio.delta", delta: QUIET });
  assert.equal(lines.filter(l => l.gptlive_handback_speech).length, 0, "silence is not speech");
  await timers.advance(200);
  live.emit({ type: "session.output_audio.delta", delta: Buffer.alloc(160, gl.pcmToUlaw(9000)).toString("base64") });
  await timers.advance(100);
  live.emit({ type: "session.output_audio.delta", delta: Buffer.alloc(160, gl.pcmToUlaw(9000)).toString("base64") });
  const got = lines.filter(l => l.gptlive_handback_speech);
  assert.equal(got.length, 1, "once per hand-back");
  assert.ok(got[0].from_ask_ms >= 500, `from_ask_ms ${got[0].from_ask_ms}`);
  assert.ok(Object.values(got[0]).every(v => typeof v === "number"), "numbers only");
  stop(call);
});

// ---------- how this call sounds (the agent's words on this line only) ----------

test("this line's manner: follow-ups now and then, never an interview, stay in the moment; nothing personal in it", async () => {
  const lines = cartesia.cartesiaCallLines({ tags: false });
  // The behaviour, as rules the agent can follow.
  assert.match(lines, /React first/);
  assert.match(lines, /ONE short follow-up question or a thought of your own/);
  assert.match(lines, /one reply in three at most/);
  assert.match(lines, /never two questions in a row/);
  assert.match(lines, /No follow-up after a lookup, a task, a goodbye, or when they sound busy/);
  assert.match(lines, /Never repeat their sentence back/);
  assert.match(lines, /no lists/);
  assert.match(lines, /never "is there anything else"/);
  assert.ok((lines.match(/Closed: /g) ?? []).length >= 3, "a few closed-vs-better examples");
  assert.match(lines, /That is a conversation, not a lookup/);
  assert.match(lines, /Call ask_reason only for what needs their data or an action/);
  assert.match(lines, /these win over any line above/);
  // Nothing about anyone: no name, number, place or conversation in the rules.
  for (const bad of ["Omari", "+1202", "dm:owner", "sendblue", "Chelsea", "SMS"]) assert.ok(!lines.includes(bad), `no ${bad}`);
  // Units follow Reason's answer (their profile, as texts do), never a unit of the line's own.
  assert.match(lines, /units Reason's answer uses/);
  assert.ok(!/celsius|fahrenheit/i.test(lines), "no unit is named");
  // Emotion tags only when switched on.
  assert.ok(!lines.includes("<emotion"));
  assert.match(cartesia.cartesiaCallLines({ tags: true }), /<emotion value="calm"\/>/);
  // On the agent, after the brief, and never the part cut to fit.
  Object.assign(config, CARTESIA);
  const vars = cartesia.sessionVariables(ownCall());
  assert.ok(vars.reason_call.endsWith(cartesia.cartesiaCallLines()));
  assert.ok(vars.reason_call.length <= cartesia.VARIABLE_MAX);
  // GPT-Live's own-call words are untouched.
  const gptlive = gl.voiceInstructionsFor(ownCall(), { line: false });
  assert.ok(!gptlive.includes("How this call sounds") && !gptlive.includes("That is a conversation, not a lookup"));
});

/** One relay with a brain that answers after `ms` (fake time), and every text it would send. */
function slowRelay(ms, reply = { text: "Overcast, 52 degrees near work." }) {
  Object.assign(config, CARTESIA);
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const agent = fakeSocket();
  const lines = [];
  const texts = [];
  let release;
  const call = new cartesia.CartesiaAgentCall({
    call: ownCall(), twilio, openAgent: () => agent.socket, now: timers.now, timers, log: (l) => lines.push(l),
    brain: () => new Promise((r) => { release = () => r(reply); timers.setTimeout(() => r(reply), ms); }),
    deleteCall: async () => ({ ok: true, redacted: true, status: 200 }),
    textOwner: (text) => { texts.push(text); return { ok: true }; },
  });
  call.begin();
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  agent.open();
  agent.emit({ type: "session_ready", call_id: "ac_s" });
  agent.emit({ type: "turn_ended", turn: 1, role: "user", text: "What's the weather near work?" });
  const ask = (id, request) => agent.emit({ type: "client_tool_call", tool_call_id: id, tool_name: "ask_reason", parameters: { request }, expects_response: true });
  const results = () => agent.of("client_tool_result");
  return { call, timers, agent, lines, texts, ask, results, release: () => release() };
}

test("a 7.7 s and a 10.4 s lookup (calls 109 and 110): the tool call stays open and its result is the answer, spoken, never texted", async () => {
  for (const ms of [7_700, 10_400]) {
    const s = slowRelay(ms);
    s.ask("tc_1", "Brooklyn news");
    await s.timers.advance(ms - 100);
    assert.equal(s.results().length, 0, `nothing answered before the answer (${ms} ms): no holding line`);
    await s.timers.advance(200);
    const [back] = s.results();
    assert.deepEqual({ id: back.tool_call_id, result: back.result, err: back.is_error }, { id: "tc_1", result: "Overcast, 52 degrees near work.", err: false });
    assert.equal(s.results().length, 1, "one result: the answer");
    await s.timers.advance(30_000);
    assert.equal(s.texts.length, 0, "said on the call, not texted");
    assert.ok(!s.lines.some(l => l.cartesia_late_answer || l.cartesia_ask_to_text), "no late answer");
    assert.equal(s.lines.find(l => l.cartesia_ask_reason).to_text, false);
    stop(s.call);
  }
  assert.ok(!("HOLD_MS" in cartesia) && !("COLLECT" in cartesia) && !("HOLD_LINES" in cartesia), "no holding line left");
});

test("a 30 s lookup: at 25 s one result says it'll come by text, then the answer is texted once when it lands", async () => {
  assert.equal(cartesia.TEXT_MS, 25_000);
  const s = slowRelay(30_000);
  s.ask("tc_1", "weather near work");
  await s.timers.advance(24_900);
  assert.equal(s.results().length, 0, "still waiting at 24.9 s");
  await s.timers.advance(200);
  const [handOff] = s.results();
  assert.equal(handOff.tool_call_id, "tc_1");
  assert.equal(handOff.result, cartesia.TEXT_RESULT);
  assert.match(handOff.result, /one short sentence/);
  assert.match(handOff.result, /Reason will text them the answer/);
  assert.match(handOff.result, /don't say it's still loading, don't ask if they're still there/);
  assert.equal(s.texts.length, 0, "nothing to text yet");
  await s.timers.advance(5_000);
  assert.deepEqual(s.texts, ["From our call: Overcast, 52 degrees near work."]);
  assert.equal(s.results().length, 1, "never spoken after the hand-off");
  assert.ok(s.lines.some(l => l.cartesia_ask_to_text));
  assert.ok(s.lines.some(l => l.cartesia_late_answer && l.texted === true));
  assert.equal(s.lines.find(l => l.cartesia_ask_reason).to_text, true);
  assert.match(s.call.turns.at(-1).text, /^\(Texted them: Overcast/, "the call's record says it went");
  await s.timers.advance(30_000);
  assert.equal(s.texts.length, 1, "texted once");
  stop(s.call);
});

test("hung up mid-lookup: the answer is texted when it lands, once, and nothing goes to the closed agent", async () => {
  for (const hangAt of [3_000, 12_000]) {
    const s = slowRelay(20_000);
    s.ask("tc_1", "weather near work");
    await s.timers.advance(hangAt);
    await s.call.end("caller hung up");
    await s.timers.advance(5_000);
    assert.equal(s.texts.length, 0, "nothing to text yet");
    await s.timers.advance(40_000);
    assert.deepEqual(s.texts, ["From our call: Overcast, 52 degrees near work."], `hung up at ${hangAt} ms`);
    assert.equal(s.results().length, 0, "nothing sent to the agent after the end");
    assert.ok(!s.lines.some(l => l.cartesia_ask_to_text), "no 'I'll text you' line on a call that is over");
  }
});

test("a late answer with nothing in it, or a fast one, is never texted", async () => {
  const s = slowRelay(27_000, { text: "", error: "weather service timed out" });
  s.ask("tc_1", "weather near work");
  await s.timers.advance(28_000);
  assert.equal(s.texts.length, 0);
  assert.ok(s.lines.some(l => l.cartesia_late_answer && l.texted === false));
  const f = slowRelay(900);
  f.ask("tc_1", "weather near work");
  await f.timers.advance(1_000);
  assert.equal(f.results()[0].result, "Overcast, 52 degrees near work.");
  assert.equal(f.lines.find(l => l.cartesia_ask_reason).to_text, false);
  await f.timers.advance(30_000);
  assert.equal(f.texts.length, 0);
  stop(s.call); stop(f.call);
});

// ---------- talked over: what the number measures ----------

test("talked over is timed from when both were talking, never from an old sound; a clear with nothing playing is no barge-in", async () => {
  const s = await trialCall();
  s.twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  s.agent.open();
  s.agent.emit({ type: "session_ready", call_id: "ac_1" });
  // The agent talks; he coughs once over it (no clear follows), and it carries on.
  s.agent.emit({ type: "audio_output", audio: SPEECH });
  await s.timers.advance(100);
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  for (let i = 0; i < 30; i++) { await s.timers.advance(200); s.agent.emit({ type: "audio_output", audio: SPEECH }); s.twilio.say({ event: "media", media: { payload: QUIET } }); }
  // Six seconds on, he starts talking and their clear comes 250 ms later.
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  await s.timers.advance(100);
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  await s.timers.advance(150);
  s.agent.emit({ type: "audio_output_clear" });
  let over = s.lines.filter(l => l.cartesia_talked_over).at(-1);
  assert.equal(over.sound_to_clear_ms, 250, "from his run's onset, not the cough 6 s earlier");
  assert.equal(over.playing, true);
  // He is mid-sentence and the agent starts over him ("Yeah,"): timed from the agent's start.
  for (let i = 0; i < 10; i++) { await s.timers.advance(100); s.twilio.say({ event: "media", media: { payload: SPEECH } }); }
  s.agent.emit({ type: "audio_output", audio: SPEECH });
  await s.timers.advance(100);
  s.twilio.say({ event: "media", media: { payload: SPEECH } });
  await s.timers.advance(80);
  s.agent.emit({ type: "audio_output_clear" });
  over = s.lines.filter(l => l.cartesia_talked_over).at(-1);
  assert.equal(over.sound_to_clear_ms, 180);
  // Their clear at the start of his turn, with nothing playing and him quiet: no time, not a barge-in.
  await s.timers.advance(3_000);
  s.agent.emit({ type: "audio_output_clear" });
  over = s.lines.filter(l => l.cartesia_talked_over).at(-1);
  assert.deepEqual({ ms: over.sound_to_clear_ms, playing: over.playing }, { ms: null, playing: false });
  stop(s.call);
});

test("setup script --update: the plan by default; with --yes, one sparse PATCH of only what was named", async () => {
  const setup = await import("../scripts/cartesia-agent-setup.mjs");
  const said = [];
  const calls = [];
  const call = async (key, p, opts = {}) => { calls.push({ p, method: opts.method ?? "GET", body: opts.body }); return { ok: true, json: {} }; };
  assert.equal(await setup.main(["--update", "agent_x", "--skip-turn"], { log: (l) => said.push(l), call, key: "ck-test" }), 0);
  assert.equal(calls.length, 0);
  assert.match(said.join("\n"), /Nothing was changed/);
  assert.equal(await setup.main(["--update", "agent_x", "--voice", setup.LUCY, "--skip-turn", "--yes"], { log: (l) => said.push(l), call, key: "ck-test" }), 0);
  assert.deepEqual(calls.map(c => `${c.method} ${c.p}`), ["PATCH /v1/agents/agent_x"]);
  const body = calls[0].body;
  assert.deepEqual(Object.keys(body.config).sort(), ["audio", "system_tools"]);
  assert.equal(body.config.audio.output.voice_id, setup.LUCY);
  assert.ok(body.config.system_tools.skip_turn.description.length <= 2000);
  assert.ok(!("end_call" in body.config.system_tools), "other system tools are left as they are");
  assert.ok(!("instructions" in body.config));
  assert.equal(await setup.main(["--update", "agent_x"], { log: (l) => said.push(l), call, key: "ck-test" }), 1, "nothing named, nothing done");
  assert.ok(!said.join("\n").includes("ck-test"));
});

// ---------- honesty: done is Reason's word (call 113, 2026-11-13) ----------

test("call 113: the agent's own \"Yeah, it's done.\" / \"Yeah, submitted.\" with no ask_reason behind them is caught, logged and written into the record", async () => {
  const s = slowRelay(100, { text: "Here's the Genius Bar page." });
  s.agent.emit({ type: "turn_ended", turn: 2, role: "user", text: "Have you finished filling the form?" });
  s.agent.emit({ type: "turn_ended", turn: 3, role: "assistant", text: "Yeah, it's done." });
  s.agent.emit({ type: "turn_ended", turn: 4, role: "user", text: "and submitted?" });
  s.agent.emit({ type: "turn_ended", turn: 5, role: "assistant", text: "Yeah, submitted." });
  const flagged = s.lines.filter(l => l.cartesia_unbacked_claim);
  assert.deepEqual(flagged.map(l => l.turn), [3, 5]);
  assert.equal(s.call.turns.filter(t => t.text === cartesia.UNBACKED_NOTE).length, 2, "the record says it was not confirmed");
  assert.match(cartesia.UNBACKED_NOTE, /NOT done/);
  // Reason's next turn reads it.
  assert.ok(s.call.messages("proof?").some(m => m.content.includes("without Reason confirming it")));
  stop(s.call);
});

test("a done-claim Reason's answer made in the last minute is backed; a negation or a plain line is not a claim", async () => {
  const s = slowRelay(100, { text: "Booked: Genius Bar at West 14th Street, 8:10 PM tonight. Confirmation R123." });
  s.ask("tc_1", "book the Genius Bar for 8:10");
  await s.timers.advance(200);
  s.agent.emit({ type: "turn_ended", turn: 3, role: "assistant", text: "You're booked for eight ten tonight." });
  assert.ok(!s.lines.some(l => l.cartesia_unbacked_claim), "Reason said it, so the agent may");
  await s.timers.advance(cartesia.CLAIM_BACKED_MS + 1_000);
  s.agent.emit({ type: "turn_ended", turn: 5, role: "assistant", text: "Nothing's booked yet. Yeah, I know you're at work until eight." });
  assert.ok(!s.lines.some(l => l.cartesia_unbacked_claim), "a negation and a plain line claim nothing");
  s.agent.emit({ type: "turn_ended", turn: 7, role: "assistant", text: "Yeah, it's done." });
  assert.equal(s.lines.filter(l => l.cartesia_unbacked_claim).length, 1, "a minute on, the old answer no longer backs a new claim");
  stop(s.call);
});

test("Reason with nothing to add: the agent is told to add no fact and claim nothing done, never to reply on its own", async () => {
  const s = slowRelay(100, { text: "", skip: true });
  s.ask("tc_1", "book it for 8:10");
  await s.timers.advance(200);
  const [back] = s.results();
  assert.equal(back.result, cartesia.NOTHING_TO_ADD);
  assert.match(back.result, /no fact, number or time/);
  assert.match(back.result, /never say anything is done, booked, sent or submitted/);
  assert.ok(!/Reply yourself/.test(back.result));
  stop(s.call);
});

test("the honesty lines are on the agent, after the conversation lines, and name the action line", async () => {
  const lines = cartesia.cartesiaCallLines({ tags: false });
  for (const l of cartesia.HONESTY_LINES) assert.ok(lines.includes(l));
  assert.ok(lines.indexOf(cartesia.HONESTY_LINES[0]) > lines.indexOf(cartesia.MOMENT_LINES.at(-1)), "after \"answer from this conversation\"");
  assert.match(lines, /Only Reason's answer \(ask_reason\) in this call can tell you something has been done/);
  assert.match(lines, /If they ask whether something is done, booked, sent, submitted or finished, call ask_reason/);
  assert.match(lines, /never that it is happening or done \("Booking it\."/);
  assert.match(lines, /picked up by text after the call, say exactly that/);
  for (const bad of ["Omari", "Genius", "Apple"]) assert.ok(!lines.includes(bad), `no ${bad}`);
  const { INSTRUCTIONS } = await import("../scripts/cartesia-agent-setup.mjs");
  assert.match(INSTRUCTIONS, /Before an action, the line says you're asking Reason/);
  assert.match(INSTRUCTIONS, /Only an ask_reason answer from this call can say something is done/);
});

test("a slow tool on a call: the turn is told not to estimate the answer itself (call 113's guessed walk)", async () => {
  const { withinBudget } = await import("../src/calls/voice.js");
  const out = await withinBudget(new Promise(() => {}), 5, { name: "directions" });
  assert.equal(out.slow, true);
  assert.match(out.say, /Do not guess or estimate the answer yourself meanwhile: no rough time, distance, price or count/);
});

test("saysDone: the forms a voice uses, and not their negations", () => {
  for (const yes of ["Yeah, it's done.", "Yeah, submitted.", "Booked: 8:10 tonight.", "Done.", "I've sent it.", "You're all set."]) assert.ok(cartesia.saysDone(yes), yes);
  for (const no of ["Nothing's booked yet.", "It's not done yet.", "I haven't sent it.", "Booking eight ten PM.", "Asking Reason to book that.", "Yeah, I know you're at work until eight.", "", "Done what?"]) assert.ok(!cartesia.saysDone(no), no);
});
