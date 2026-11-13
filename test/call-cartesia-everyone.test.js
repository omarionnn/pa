// The Cartesia call voice for everyone (REASON_CALL_CARTESIA=on; src/calls/calltrial.js, src/calls/cartesia.js,
// docs/calls-cartesia.md section 5). No network: Twilio's stream, the Cartesia agent socket and GPT-Live are
// stand-ins, as in test/call-cartesia.test.js. Two accounts, often on calls at the same time: nothing of one
// may reach the other (instructions, tool results, texts, transcripts, deletes), and only a person's own
// call with Reason is ever on Cartesia, in any mode.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-cartesia-all-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Ola";
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
const tools = await import("../src/tools.js");
const ops = await import("../src/ops.js");
const accounts = await import("../src/accounts.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

// Made-up people: the operator (A) and an invited account (B), each with their own Reason name and places.
const A = config.ownerConversation;
const B = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test", callVoice: "gptlive" };
const KEYS = { cartesiaKey: "ck-test", cartesiaAgentId: "agent_test" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM cartesia_daily;");
  try { db.db.exec("DELETE FROM messages;"); } catch { /* no table on this build */ }
  db.saveConversation(A, []);
  db.saveConversation(B, []);
  db.upsertAccount({ conversationId: A, channel: "sendblue", address: "+12025551234", name: "Ola", isOperator: true });
  db.upsertAccount({ conversationId: B, channel: "sendblue", address: "+13105550000", name: "Bea", isOperator: false });
  Object.assign(config, { callIdentity: false, callCartesia: "off", cartesiaKey: "", cartesiaAgentId: "", callAmbience: "", cartesiaLookupMusic: "", cartesiaLookupMusicFile: "", cartesiaLookupMusicGain: "", ...TWILIO });
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
    shut: (code = 1000, said = "") => h.close.forEach(f => f(code, said)),
    of: (type) => sent.filter(e => e.type === type),
  };
}

const SPEECH = Buffer.alloc(160, 0x10).toString("base64");
const OTHER_SPEECH = Buffer.alloc(160, 0x20).toString("base64");
const settle = () => new Promise(r => setImmediate(r));

const NUMBER = { [A]: "+12025551234", [B]: "+13105550000" };
const NAME = { [A]: "Ola", [B]: "Bea" };
const ownCall = (c, over = {}) => db.createCall(c, {
  provider: "gptlive", toNumber: NUMBER[c], isOwner: true, goal: "check in", facts: [],
  announcement: `Hey ${NAME[c]}, it's Reason.`, state: "placing", ...over,
});
const lineCall = (c, over = {}) => db.createCall(c, {
  provider: "gptlive", toNumber: "+12125550100", isOwner: false, goal: "book a table", facts: [],
  announcement: `Hi, I'm calling for ${NAME[c]}.`, state: "placing", ...over,
});

/** acceptStream with stand-ins; every agent socket opened is a new one (one agent, many calls at once). */
function accept(row, extra = {}) {
  const twilio = fakeTwilio();
  const live = fakeSocket();
  const agents = [];
  const lines = [];
  const seen = { loaded: 0, live: 0, deleted: [] };
  // The settle as the server's does it, in short: the call's own row gets its state and transcript.
  const settleRow = async (c, fresh, live) => { db.updateCall(c, fresh.id, { state: live.state, transcript: live.transcript }); return db.getCall(c, fresh.id); };
  const call = gl.acceptStream({
    token: row.webhook_token, socket: twilio, log: (o) => lines.push(o), settle: settleRow, openLive: () => { seen.live++; return live.socket; },
    openCartesia: async () => { seen.loaded++; return cartesia; },
    cartesiaOpts: {
      openAgent: () => { const a = fakeSocket(); agents.push(a); return a.socket; },
      deleteCall: async (id) => { seen.deleted.push(id); return { ok: true, redacted: true, status: 200 }; },
      ...extra,
    },
  });
  return { call, twilio, live, agents, get agent() { return agents[0]; }, lines, seen, row };
}

const stop = (call) => {
  const c = call?.holder ?? call;
  if (!c) return;
  for (const k of ["capTimer", "roomTimer", "openTimer", "noticeTimer", "byeTimer", "readyTimer", "lateTimer"]) if (c[k]) clearTimeout(c[k]);
  c.done = true;
  if (call !== c) call.done = true;
};

const run = (c, choice) => tools.runTool("call_voice_trial", { choice }, { conversationId: c });

// ---------- the switch ----------

test("REASON_CALL_CARTESIA reads on, owner or off; anything else is off", () => {
  for (const [v, want] of [["on", "on"], [" ON ", "on"], ["owner", "owner"], ["off", "off"], ["", "off"], ["yes", "off"], ["everyone", "off"], ["1", "off"]]) {
    const env = { ...process.env, REASON_CALL_CARTESIA: v, REASON_DB_PATH: join(dir, "switch.db") };
    const got = execFileSync(process.execPath, ["--input-type=module", "-e", "const { config } = await import(process.argv[1]); process.stdout.write(config.callCartesia);", new URL("../src/config.js", import.meta.url).href], { env, encoding: "utf8" });
    assert.equal(got, want, `REASON_CALL_CARTESIA=${JSON.stringify(v)}`);
  }
});

// ---------- who gets it ----------

test("on: every account's own call is on Cartesia by default, either direction", () => {
  Object.assign(config, KEYS, { callCartesia: "on" });
  for (const c of [A, B]) {
    assert.equal(db.callTrial(c), "", "never chosen");
    assert.equal(trial.trialOffered(c), true, `${c} is offered the choice`);
    assert.equal(trial.cartesiaTrialFor(ownCall(c)), true, `${c}: a call Reason placed to them`);
    assert.equal(trial.cartesiaTrialFor(ownCall(c, { direction: "in" })), true, `${c}: them ringing Reason`);
  }
});

for (const mode of ["on", "owner", "off"]) {
  test(`${mode}: a call to a business or another person, for either account, is never on Cartesia`, async () => {
    Object.assign(config, KEYS, { callCartesia: mode });
    for (const c of [A, B]) {
      db.setCallTrial(c, "cartesia");
      for (const row of [lineCall(c), lineCall(c, { direction: "in" })]) {
        assert.equal(trial.cartesiaTrialFor(db.getCall(c, row.id)), false, `${c} ${row.direction}`);
        const s = accept(row);
        assert.ok(s.call instanceof gl.GptLiveCall, "GptLiveCall as today");
        s.twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
        await settle();
        assert.equal(s.seen.loaded, 0, "the Cartesia relay was never loaded");
        assert.equal(s.agents.length, 0, "no Cartesia socket");
        stop(s.call);
      }
    }
    assert.equal(trial.cartesiaTrialFor(null), false, "no row (a stranger, an event line) never reaches it");
    assert.equal(trial.cartesiaTrialFor({ conversation_id: B, is_owner: 0 }), false);
  });
}

test("on: a person who chose the usual voice gets GPT-Live; the choice is theirs alone", async () => {
  Object.assign(config, KEYS, { callCartesia: "on" });
  const off = await run(B, "off");
  assert.equal(off.ok, true);
  assert.equal(off.voice, "usual");
  assert.equal(db.callTrial(B), "usual", "stored so the default does not win");
  assert.equal(trial.cartesiaTrialFor(ownCall(B)), false);
  assert.equal(trial.cartesiaTrialFor(ownCall(A)), true, "the other account is untouched");
  const s = accept(ownCall(B));
  assert.ok(s.call instanceof gl.GptLiveCall);
  await settle();
  assert.equal(s.seen.loaded, 0);
  stop(s.call);
  const on = await run(B, "on");
  assert.equal(on.voice, "cartesia");
  assert.match(on.say, /new voice/);
  assert.equal(trial.cartesiaTrialFor(ownCall(B)), true, "\"use the new voice\" turns it back on");
  assert.equal((await run(B, "status")).voice, "cartesia");
  assert.equal(db.callTrial(A), "", "nothing written on the other account");
});

test("owner: nothing changes; the operator's stored choice keeps working, nobody else is offered it", async () => {
  Object.assign(config, KEYS, { callCartesia: "owner" });
  assert.equal(trial.cartesiaTrialFor(ownCall(A)), false, "unset is the usual voice under owner");
  db.setCallTrial(A, "cartesia");
  assert.equal(trial.cartesiaTrialFor(ownCall(A)), true);
  db.setCallTrial(B, "cartesia");
  assert.equal(trial.trialOffered(B), false);
  assert.equal(trial.cartesiaTrialFor(ownCall(B)), false, "another account, even with a stored choice");
  assert.equal((await run(B, "on")).ok, false, "the tool refuses anyone else");
  const off = await run(A, "off");
  assert.equal(off.voice, "usual");
  assert.equal(db.callTrial(A), "", "off stores what it always did under owner");
  db.setCallTrial(A, "usual");
  assert.equal(trial.cartesiaTrialFor(ownCall(A)), false, "a choice made under on still reads as usual");
});

test("off or unset: nothing is reachable, whatever is stored", async () => {
  Object.assign(config, KEYS, { callCartesia: "off" });
  for (const c of [A, B]) {
    db.setCallTrial(c, "cartesia");
    assert.equal(trial.trialOffered(c), false);
    assert.equal(trial.cartesiaTrialFor(ownCall(c)), false);
    assert.equal((await run(c, "on")).ok, false);
  }
});

test("the tool is shown to every account at on, the operator only at owner, nobody at off", () => {
  const shown = (c) => tools.callTrialToolVisible("call_voice_trial", c);
  config.callCartesia = "on";
  assert.equal(shown(A), true); assert.equal(shown(B), true);
  assert.equal(shown("sendblue:+19995550000"), false, "no account, no choice");
  config.callCartesia = "owner";
  assert.equal(shown(A), true); assert.equal(shown(B), false);
  config.callCartesia = "off";
  assert.equal(shown(A), false); assert.equal(shown(B), false);
  assert.equal(tools.callTrialToolVisible("web_search", B), true, "other tools untouched");
});

// ---------- per person: two accounts on calls at the same time ----------

/** A line of theirs today in their own thread, stamped the way their texts are, so today's names are read. */
function chatToday(c, text) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(clock.now()));
  db.saveConversation(c, [...db.loadConversation(c), { role: "user", content: `[${day}, 9:00 AM] ${NAME[c]}: ${text}` }, { role: "assistant", content: "Noted." }]);
}

test("two accounts at once: each agent session gets that person's name, greeting, brief, keyterms and clock only", async () => {
  Object.assign(config, KEYS, { callCartesia: "on" });
  chatToday(A, "Lunch with Kwame at Dishoom Kensington later");
  chatToday(B, "Picking up Marisol from Lakeview Pottery at six");
  db.setZoneFields(B, { confirmed: "America/Los_Angeles", confirmedAt: clock.now() });
  const ta = fakeTimers();
  const tb = fakeTimers();
  const a = accept(ownCall(A), { timers: ta, now: ta.now });
  const b = accept(ownCall(B, { direction: "in" }), { timers: tb, now: tb.now });
  await settle(); await settle();
  assert.ok(a.call.holder instanceof cartesia.CartesiaAgentCall);
  assert.ok(b.call.holder instanceof cartesia.CartesiaAgentCall);
  assert.equal(a.agents.length, 1); assert.equal(b.agents.length, 1);
  a.twilio.say({ event: "start", start: { streamSid: "MZA", callSid: "CAA" } });
  b.twilio.say({ event: "start", start: { streamSid: "MZB", callSid: "CAB" } });
  b.agent.open();
  a.agent.open();
  const va = a.agent.of("session_create")[0].dynamic_variables;
  const vb = b.agent.of("session_create")[0].dynamic_variables;
  assert.equal(va.their_name, "Ola"); assert.equal(vb.their_name, "Bea");
  assert.match(va.greeting, /Ola/);
  assert.doesNotMatch(vb.greeting, /Ola/);
  assert.match(va.reason_call, /Ola/); assert.doesNotMatch(va.reason_call, /Bea/);
  assert.match(vb.reason_call, /Bea/); assert.doesNotMatch(vb.reason_call, /\bOla\b/);
  const terms = (v) => Object.entries(v).filter(([k]) => k.startsWith("keyterm_")).map(([, t]) => t);
  assert.ok(terms(va).some(t => /Kwame|Dishoom/.test(t)), `A's own names: ${terms(va)}`);
  assert.ok(terms(vb).some(t => /Marisol|Lakeview/.test(t)), `B's own names: ${terms(vb)}`);
  assert.equal(terms(va).some(t => /Marisol|Lakeview/.test(t)), false, "never another account's places or people");
  assert.equal(terms(vb).some(t => /Kwame|Dishoom/.test(t)), false, "never another account's places or people");
  assert.doesNotMatch(vb.reason_call, /Kwame|Dishoom/);
  assert.doesNotMatch(va.reason_call, /Marisol|Lakeview/);
  assert.match(vb.reason_call, /Their clock: .*\(America\/Los_Angeles\)/, "B's own confirmed zone");
  assert.match(va.reason_call, /Their clock: .*\(America\/New_York\)/);
  // Audio goes to that call's own agent, and the agent's audio to that call's own phone.
  a.agent.emit({ type: "session_ready", call_id: "ac_A" });
  b.agent.emit({ type: "session_ready", call_id: "ac_B" });
  a.twilio.say({ event: "media", media: { payload: SPEECH } });
  b.twilio.say({ event: "media", media: { payload: OTHER_SPEECH } });
  assert.deepEqual(a.agent.of("audio_input").map(e => e.audio), [SPEECH]);
  assert.deepEqual(b.agent.of("audio_input").map(e => e.audio), [OTHER_SPEECH]);
  b.agent.emit({ type: "audio_output", audio: OTHER_SPEECH });
  assert.equal(a.twilio.sent.some(m => m.streamSid === "MZB"), false);
  assert.ok(b.twilio.sent.some(m => m.event === "media" && m.streamSid === "MZB"));
  // Both end; each deletes only its own Cartesia call, and each thread gets only its own turns.
  a.agent.emit({ type: "turn_ended", turn: 1, role: "user", text: "Ola here, about Kwame." });
  b.agent.emit({ type: "turn_ended", turn: 1, role: "user", text: "Bea here, about Marisol." });
  b.twilio.say({ event: "stop" });
  a.twilio.say({ event: "stop" });
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(a.seen.deleted, ["ac_A"]);
  assert.deepEqual(b.seen.deleted, ["ac_B"]);
  const words = (c) => JSON.stringify(db.loadConversation(c));
  assert.match(words(A), /about Kwame/); assert.doesNotMatch(words(A), /about Marisol/);
  assert.match(words(B), /about Marisol/); assert.doesNotMatch(words(B), /about Kwame/);
  const ca = db.getCall(A, a.row.id);
  const cb = db.getCall(B, b.row.id);
  assert.doesNotMatch(JSON.stringify(ca), /Marisol/, "A's call record has none of B's call");
  assert.doesNotMatch(JSON.stringify(cb), /Kwame/, "B's call record has none of A's call");
  stop(a.call); stop(b.call);
});

test("two accounts at once: each ask goes to its own Reason, its answer to its own agent, a late answer to its own thread", async () => {
  Object.assign(config, KEYS, { callCartesia: "on" });
  const timers = fakeTimers();
  const mk = (c, answer, ms) => {
    const twilio = fakeTwilio();
    const agent = fakeSocket();
    const asked = [];
    const finished = [];
    const deleted = [];
    const call = new cartesia.CartesiaAgentCall({
      call: ownCall(c), twilio, openAgent: () => agent.socket, now: timers.now, timers, log: () => {},
      brain: async (messages) => { asked.push(messages); await new Promise(r => timers.setTimeout(r, ms)); return { text: answer, tools: [] }; },
      finish: async (live) => { finished.push(live); },
      deleteCall: async (id) => { deleted.push(id); return { ok: true, redacted: true, status: 200 }; },
    });
    call.begin();
    twilio.say({ event: "start", start: { streamSid: `MZ${c}`, callSid: `CA${c}` } });
    agent.open();
    return { c, call, twilio, agent, asked, finished, deleted };
  };
  // A's answer is quick; B's is slow enough to go by text.
  const a = mk(A, "Your dentist is at 3 on Tuesday.", 800);
  const b = mk(B, "The pottery shop shuts at 7.", cartesia.TEXT_MS + 2000);
  a.agent.emit({ type: "session_ready", call_id: "ac_A" });
  b.agent.emit({ type: "session_ready", call_id: "ac_B" });
  a.agent.emit({ type: "turn_ended", turn: 1, role: "user", text: "When's my dentist?" });
  b.agent.emit({ type: "turn_ended", turn: 1, role: "user", text: "When does the pottery shop shut?" });
  a.agent.emit({ type: "client_tool_call", tool_call_id: "tc_1", tool_name: "ask_reason", parameters: { request: "dentist" }, expects_response: true });
  b.agent.emit({ type: "client_tool_call", tool_call_id: "tc_1", tool_name: "ask_reason", parameters: { request: "pottery shop hours" }, expects_response: true });
  await timers.advance(cartesia.TEXT_MS + 3000);
  for (let i = 0; i < 5; i++) await settle();
  assert.match(JSON.stringify(a.asked), /dentist/); assert.doesNotMatch(JSON.stringify(a.asked), /pottery/);
  assert.match(JSON.stringify(b.asked), /pottery/); assert.doesNotMatch(JSON.stringify(b.asked), /dentist/);
  assert.deepEqual(a.agent.of("client_tool_result").map(r => r.result), ["Your dentist is at 3 on Tuesday."]);
  assert.deepEqual(b.agent.of("client_tool_result").map(r => r.result), [cartesia.TEXT_RESULT], "B's slow one: the agent says it will text");
  const outbox = db.db.prepare("SELECT conversation_id, address, body FROM outbox").all();
  assert.deepEqual(outbox.map(r => [r.conversation_id, r.address, r.body]), [[B, "+13105550000", "From our call: The pottery shop shuts at 7."]],
    "the late answer goes to B's own thread and number, nobody else's");
  a.twilio.say({ event: "stop" });
  b.twilio.say({ event: "stop" });
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(a.deleted, ["ac_A"]); assert.deepEqual(b.deleted, ["ac_B"]);
  assert.match(a.finished[0].transcript, /dentist/); assert.doesNotMatch(a.finished[0].transcript, /pottery/);
  assert.match(b.finished[0].transcript, /pottery/); assert.doesNotMatch(b.finished[0].transcript, /dentist/);
});

test("an account with no name given: no stand-in name goes to the agent", () => {
  Object.assign(config, KEYS, { callCartesia: "on" });
  db.db.prepare("UPDATE accounts SET name = '' WHERE conversation_id = ?").run(B);
  assert.equal(accounts.ownerOf(B).name, "the person I work for", "the stand-in an unnamed account reads as");
  const v = cartesia.sessionVariables(db.getCall(B, ownCall(B).id));
  assert.equal(v.their_name, "");
  assert.doesNotMatch(v.reason_call, /Ola/);
});

// ---------- refused sessions and the day's numbers ----------

for (const [label, refuse, reason] of [
  ["not ready in 1.5 s", async (s) => { await s.timers.advance(cartesia.READY_MS + 10); }, "not_ready"],
  ["out of credits (fatal error before ready)", async (s) => { s.agent.open(); s.agent.emit({ type: "error", code: "insufficient_credits", message: "Your agent balance is $0", fatal: true }); }, "refused_out_of_credits"],
  ["402 on the socket", async (s) => { s.agent.shut(1008, "402 Payment Required"); }, "refused_out_of_credits"],
  ["the plan's concurrency limit (429)", async (s) => { s.agent.shut(1008, "429 Too Many Requests: concurrency limit reached"); }, "refused_plan_limit"],
  ["a refused key", async (s) => { s.agent.shut(1008, "401 Unauthorized"); }, "refused_auth"],
  ["closed with nothing said", async (s) => { s.agent.shut(1006, ""); }, "closed_before_ready"],
]) {
  test(`B's call, ${label}: the same call carries on with GPT-Live, logged with reason ${reason}, counted`, async () => {
    Object.assign(config, KEYS, { callCartesia: "on" });
    const timers = fakeTimers();
    const s = accept(ownCall(B), { timers, now: timers.now });
    s.timers = timers;
    await settle(); await settle();
    s.twilio.say({ event: "start", start: { streamSid: "MZB", callSid: "CAB" } });
    await refuse(s);
    await settle();
    assert.ok(s.call.holder instanceof gl.GptLiveCall, "GPT-Live has the call");
    const fell = s.lines.find(l => l.cartesia_fell_back);
    assert.equal(fell?.reason, reason);
    assert.ok(db.CARTESIA_FALLBACK_REASONS.has(fell.reason));
    const day = db.cartesiaDaily(accounts.today());
    assert.equal(day.calls, 1);
    assert.equal(day.ready, 0);
    assert.equal(day.fell_back[reason], 1);
    assert.equal(day.fell_back.total, 1);
    stop(s.call);
  });
}

test("the day's numbers: calls, ready and fall-backs by reason in /ops.json's counts, and nothing about anyone", async () => {
  Object.assign(config, KEYS, { callCartesia: "on" });
  for (const c of [A, B]) {
    const timers = fakeTimers();
    const s = accept(ownCall(c), { timers, now: timers.now });
    await settle(); await settle();
    s.agent.open();
    s.agent.emit({ type: "session_ready", call_id: `ac_${c}` });
    stop(s.call);
  }
  db.bumpCartesia(accounts.today(), "fell_back:refused_plan_limit");
  db.bumpCartesia(accounts.today(), "fell_back:something new");
  db.bumpCartesia(accounts.today(), "a person's name");
  const counts = ops.countsOf(accounts.today()).cartesia;
  assert.equal(counts.calls, 2);
  assert.equal(counts.ready, 2);
  assert.deepEqual(counts.fell_back, { total: 2, refused_plan_limit: 1, other: 1 });
  const rows = db.db.prepare("SELECT * FROM cartesia_daily").all();
  assert.deepEqual(Object.keys(rows[0]).sort(), ["day", "n", "what"], "numbers only: no conversation, no call id");
  assert.equal(rows.some(r => /name|\+1|dm:|sendblue/.test(r.what)), false);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0, "no texts to anyone");
});

test("fallBackReason reads codes and plain words, and is otherwise the fallback given", () => {
  assert.equal(cartesia.fallBackReason("1008 429 Too Many Requests"), "refused_plan_limit");
  assert.equal(cartesia.fallBackReason("concurrency limit reached"), "refused_plan_limit");
  assert.equal(cartesia.fallBackReason("402"), "refused_out_of_credits");
  assert.equal(cartesia.fallBackReason("insufficient credits"), "refused_out_of_credits");
  assert.equal(cartesia.fallBackReason("401 invalid API key"), "refused_auth");
  assert.equal(cartesia.fallBackReason("1006 ", "closed_before_ready"), "closed_before_ready");
  assert.equal(cartesia.fallBackReason("4290"), "other", "a number that only contains 429 is not one");
});

// ---------- lookup music: every Cartesia call with the switch set ----------

test("lookup music: B's own Cartesia call gets it with the music switch on; a call to someone else never", () => {
  Object.assign(config, KEYS, { callCartesia: "on", cartesiaLookupMusic: "on" });
  const mk = (row) => new cartesia.CartesiaAgentCall({ call: row, twilio: fakeTwilio(), openAgent: () => fakeSocket().socket, brain: async () => ({ text: "" }), timers: fakeTimers() });
  const own = mk(ownCall(B));
  assert.ok(own.music, "music on a non-operator account's own call");
  const line = mk(lineCall(B));
  assert.equal(line.music, null, "never on a line call");
  config.cartesiaLookupMusic = "";
  assert.equal(mk(ownCall(B)).music, null, "switch off: none");
});

test("the agent setup: nothing saved on the shared agent is about one person; --clear-keyterms resets it", async () => {
  const setup = await import("../scripts/cartesia-agent-setup.mjs");
  const body = setup.agentBody({ model: "m", toolId: "t" });
  assert.deepEqual(body.config.audio.input.keyterms, setup.sharedKeyterms());
  assert.doesNotMatch(JSON.stringify(body), /operator|\bhis\b|owner/i);
  const up = setup.updateBody({ clearKeyterms: true });
  assert.deepEqual(up.config.audio.input.keyterms, ["Reason", ...Array.from({ length: setup.KEYTERM_SLOTS }, (_, i) => `{{keyterm_${i + 1}}}`)]);
  const both = setup.updateBody({ clearKeyterms: true, voice: "v1" });
  assert.equal(both.config.audio.output.voice_id, "v1");
  assert.ok(both.config.audio.input.keyterms);
  const said = [];
  const calls = [];
  assert.equal(await setup.main(["--update", "agent_1", "--clear-keyterms"], { log: (l) => said.push(l), call: async (...a) => { calls.push(a); return { ok: true }; }, key: "ck" }), 0);
  assert.equal(calls.length, 0, "the plan only without --yes");
});
