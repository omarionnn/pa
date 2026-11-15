// REASON_CALL_FEEL=classic (src/calls/callclassic.js): the owner's Cartesia calls as on call 112. The golden
// file (test/fixtures/call-classic-baseline.json) is the output of the build that was live on that call,
// main 752a9e72, for the same scenarios (test/fixtures/call-classic-scenarios.mjs). Classic output must be that
// text exactly, followed only by the keep-list; current mode, other calls and the agent's other settings are
// untouched. No network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = await import("./fixtures/call-classic-scenarios.mjs");
const dir = mkdtempSync(join(tmpdir(), "reason-call-classic-"));
Object.assign(process.env, S.ENV, { REASON_DB_PATH: join(dir, "reason.db"), REASON_RECORDING_ROOT: join(dir, "recordings") });
for (const k of S.UNSET) delete process.env[k];
delete process.env.CARTESIA_API_KEY;

const cartesia = await import("../src/calls/cartesia.js");
const classic = await import("../src/calls/callclassic.js");
const carry = await import("../src/calls/carryover.js");
const { openingLineFor } = await import("../src/calls/inbound.js");
const { ownerCallFrame } = await import("../src/calls/voice-prompt.js");
const agentClassic = await import("../scripts/cartesia-agent-classic.mjs");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const BASE = JSON.parse(readFileSync(new URL("./fixtures/call-classic-baseline.json", import.meta.url), "utf8"));
const AGENT112 = JSON.parse(readFileSync(new URL("./fixtures/cartesia-agent-call112.json", import.meta.url), "utf8"));
const random = Math.random;

after(() => { Math.random = random; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  S.pin(clock);
  Math.random = () => 0;
  delete process.env.REASON_CALL_TRUST;
  Object.assign(config, { callFeel: "current", callCartesia: "owner", cartesiaKey: "ck-test", cartesiaAgentId: "agent_test" });
  carry.resetCarryover();
});

/** The scenario's call row, seeded; classic or current. */
function scenario(name, { feel = "classic", trust = "" } = {}) {
  config.callFeel = feel;
  if (trust) process.env.REASON_CALL_TRUST = trust; else delete process.env.REASON_CALL_TRUST;
  carry.resetCarryover();
  return S.SCENARIOS[name](db, C);
}

// ---------- the golden file: call 112's words, exactly ----------

test("classic: every scenario's reason_call is the 752a9e72 build's own text exactly, then only the keep-list", () => {
  assert.equal(BASE.commit, "752a9e72");
  for (const name of Object.keys(S.SCENARIOS)) {
    const call = scenario(name);
    const vars = cartesia.sessionVariables(call);
    const want = BASE.scenarios[name];
    assert.ok(vars.reason_call.startsWith(`${want.reason_call}\n`), `${name}: the call-112 text first, byte for byte`);
    const extra = vars.reason_call.slice(want.reason_call.length + 1).split("\n");
    assert.equal(extra[0], classic.MEMORY_LINE, `${name}: the memory line comes first after it`);
    // Every other line after it belongs to the two note sections (keep-list c).
    const notes = classic.keptSections(call).filter(s => s.name === "earlier_calls" || s.name === "since_last_call").flatMap(s => s.lines);
    for (const l of extra.slice(1)) assert.ok(notes.includes(l), `${name}: only notes after the memory line: ${l.slice(0, 60)}`);
    for (const k of Object.keys(want)) if (k !== "reason_call") assert.equal(vars[k], want[k], `${name}: ${k} as on call 112`);
  }
});

test("classic: the call-112 part is cut where it was then (12,000 in all); the notes after it fit inside the classic cap and are never trimmed on a busy day", () => {
  const call = scenario("busy", { trust: "owner" });
  const c = classic.classicReasonCall(call);
  assert.equal(c.base, BASE.scenarios.busy.reason_call.length);
  assert.equal(c.base, 12_000, "the busy day fills the old limit, as call 112's did");
  assert.ok(c.size <= classic.CLASSIC_MAX, `${c.size} within ${classic.CLASSIC_MAX}`);
  assert.deepEqual(c.trimmed, []);
  assert.deepEqual(c.dropped, []);
  assert.deepEqual(c.kept.map(k => k.split(":")[0]), ["classic_base", "memory_line", "earlier_calls", "since_last_call", "passphrase"]);
  assert.equal(classic.CLASSIC_MAX, 16_500);
});

test("classic: the earlier-calls notes and what was texted since are there, with no link in anything handed to the voice", () => {
  const call = scenario("busy");
  const t = cartesia.sessionVariables(call).reason_call;
  assert.match(t, /EARLIER CALLS with them, newest first/);
  assert.match(t, /SINCE YOUR LAST CALL \(it ended/);
  assert.match(t, /Here is the market page you asked for/);
  assert.doesNotMatch(t, /https?:\/\/|heyreason\.com\/p\/|secretkey/);
});

test("classic: the passphrase line is there only with call trust on (keep-list f)", () => {
  assert.ok(!cartesia.sessionVariables(scenario("quiet")).reason_call.includes("If they say a passphrase"));
  const t = cartesia.sessionVariables(scenario("quiet", { trust: "owner" })).reason_call;
  assert.ok(t.endsWith("never the phrase itself."), "the passphrase line is last");
  assert.ok(t.startsWith(BASE.scenarios.quiet.reason_call), "and the call-112 text is still first, unchanged");
});

test("classic: none of the later rule lines (honesty list, turn lines, time read-back, 'Asking Reason to', their clock) are in the voice's words", () => {
  const t = cartesia.sessionVariables(scenario("busy", { trust: "owner" })).reason_call;
  for (const l of [...cartesia.HONESTY_LINES, ...cartesia.TURN_LINES]) assert.ok(!t.includes(l), l.slice(0, 60));
  assert.doesNotMatch(t, /Asking Reason to|Their clock: it is|eight ten PM, right/);
  assert.match(t, /Voice: a young woman with a light, natural British \(London\) accent/, "the voice line call 112 had");
  assert.match(t, /Like this \(made-up examples\):/, "and its examples");
});

test("classic: keyterms are today's names then \"Reason\", never the time words", () => {
  const vars = cartesia.sessionVariables(scenario("quiet"));
  for (let i = 1; i <= cartesia.KEYTERM_SLOTS; i++) assert.ok(!cartesia.TIME_KEYTERMS.includes(vars[`keyterm_${i}`]));
});

// ---------- current mode and other calls ----------

test("current mode (the default): reason_call is the ranked fit exactly as before, and nothing from classic", () => {
  const call = scenario("busy", { feel: "current" });
  const vars = cartesia.sessionVariables(call);
  assert.equal(vars.reason_call, cartesia.reasonCallFit(call).text);
  assert.ok(!vars.reason_call.includes(classic.MEMORY_LINE));
  assert.ok(!vars.reason_call.startsWith(BASE.scenarios.busy.reason_call));
  assert.equal(config.callFeel, "current");
});

test("classic applies only to their own calls: a business call or another person's is never classic", () => {
  config.callFeel = "classic";
  assert.equal(classic.classicFor({ is_owner: 0, conversation_id: C }), false);
  assert.equal(classic.classicFor({ is_owner: 1, conversation_id: C }), true);
  config.callFeel = "current";
  assert.equal(classic.classicFor({ is_owner: 1, conversation_id: C }), false);
});

test("the time read-back line is in Claude's call frame unless classic asks it out", () => {
  const rule = /read it back once,\s+in words, and wait for their yes/;
  assert.match(ownerCallFrame({ name: "Sam", identity: true }), rule);
  assert.doesNotMatch(ownerCallFrame({ name: "Sam", identity: true, readBack: false }), rule);
});

// The greeting is the one owner-approved exception to call 112's words (2026-11-15): written ahead for
// them by a model (src/calls/greetings.js), the plain "Hey <name>." with none written yet.
test("greeting: classic opens with the line written for them (plain with none yet, no lead-in, no pick-up line); current keeps its pick-up", () => {
  const call = scenario("busy");
  const person = { name: "Sam" };
  assert.equal(openingLineFor({ person, conversationId: C, classic: true }), BASE.scenarios.busy.greeting);
  assert.equal(BASE.scenarios.busy.greeting, "Hey Sam.");
  // Twenty-five minutes after a call with notes: current picks up from it, classic does not.
  assert.match(openingLineFor({ person, conversationId: C }), /picking up from just now/);
  assert.doesNotMatch(openingLineFor({ person, conversationId: C, classic: true }), /picking up/);
  void call;
});

// ---------- what the voice is told on a turn, in classic ----------

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
function relay(replies, { feel = "classic" } = {}) {
  const row = scenario("quiet", { feel });
  const timers = fakeTimers();
  const sent = [];
  const h = { open: [], event: [], close: [] };
  const socket = { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) };
  const th = { msg: [], close: [] };
  const twilio = { send: () => {}, open: () => true, close: () => {}, onMessage: (f) => th.msg.push(f), onClose: (f) => th.close.push(f) };
  const lines = [];
  const queue = [...replies];
  const call = new cartesia.CartesiaAgentCall({
    call: row, twilio, openAgent: () => socket, now: timers.now, timers, log: (l) => lines.push(l),
    brain: () => { const next = queue.shift() ?? { reply: { text: "Okay." } }; next.before?.(row); return new Promise((r) => timers.setTimeout(() => r(next.reply), next.ms ?? 100)); },
    deleteCall: async () => ({ ok: true, redacted: true, status: 200 }), textOwner: () => ({ ok: true }),
  });
  call.begin();
  th.msg.forEach(f => f(JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } })));
  h.open.forEach(f => f());
  const emit = (e) => h.event.forEach(f => f(e));
  emit({ type: "session_ready", call_id: "ac_classic" });
  let n = 1;
  return {
    call, row, timers, lines, sent,
    user: (text) => emit({ type: "turn_ended", turn: n++, role: "user", text, interrupted: false }),
    said: (text, interrupted = false) => emit({ type: "turn_ended", turn: n++, role: "assistant", text, interrupted }),
    ask: (request) => emit({ type: "client_tool_call", tool_call_id: `tc_${n++}`, tool_name: "ask_reason", parameters: { request }, expects_response: true }),
    results: () => sent.filter(e => e.type === "client_tool_result").map(r => r.result),
    stop: () => { for (const k of ["roomTimer", "readyTimer"]) if (call[k]) timers.clearTimeout(call[k]); call.done = true; },
  };
}

test("classic: a quiet turn tells the voice no fact and nothing done (keep-list b), never \"Reply yourself\"", async () => {
  const s = relay([{ reply: { text: "", skip: true } }, { reply: { text: "NO_REPLY" } }]);
  s.ask("have you finished filling the form?");
  await s.timers.advance(200);
  s.ask("and submitted?");
  await s.timers.advance(200);
  assert.deepEqual(s.results(), [cartesia.NOTHING_TO_ADD, cartesia.NOTHING_TO_ADD]);
  assert.match(cartesia.NOTHING_TO_ADD, /no fact, number or time of your own, and never say anything is done/);
  assert.ok(!s.results().some(r => /Reply yourself/.test(r)));
  s.stop();
});

test("classic: the done-claim check still fires and writes the record note (keep-list b)", async () => {
  const s = relay([{ reply: { text: "", skip: true } }]);
  s.user("Have you finished filling the form?");
  s.ask("have you finished filling the form?");
  await s.timers.advance(200);
  s.said("Yeah, it's done.");
  assert.equal(s.lines.filter(l => l.cartesia_unbacked_claim).length, 1);
  assert.ok(s.call.turns.some(t => t.text === cartesia.UNBACKED_NOTE), "the after-call text and the next turn see it was not done");
  s.stop();
});

test("classic: Reason's words go as they came (markers out, keep-list d); no slow-wait opening, no lost answer offered again, no deferral line", async () => {
  const verify = await import("../src/calls/verify.js");
  const s = relay([
    { ms: 15_000, reply: { text: "Skipping for now. It's on West 14th." } },
    { reply: { text: "Got it, eight ten PM tonight. I'll do it by text after." } },
    { before: (row) => verify.queueForAfter(row, "book it"), reply: { text: "Eight ten works." } },
    { reply: { text: "Sure." } },
  ]);
  s.ask("where is it?");
  await s.timers.advance(15_100);
  s.ask("book it for 8:10");
  await s.timers.advance(200);
  s.said("Got", true);
  s.ask("book it");
  await s.timers.advance(200);
  s.ask("thanks");
  await s.timers.advance(200);
  assert.deepEqual(s.results(), ["It's on West 14th.", "Got it, eight ten PM tonight. I'll do it by text after.", "Eight ten works.", "Sure."]);
  assert.ok(!s.lines.some(l => l.cartesia_deferred_said || l.cartesia_answer_unheard || l.cartesia_answer_reoffered));
  s.stop();
});

test("classic: an error turn gets the call-112 line", async () => {
  const s = relay([{ reply: { text: "", error: "model down" } }]);
  s.ask("weather?");
  await s.timers.advance(200);
  assert.deepEqual(s.results(), [classic.ERROR_LINE]);
  s.stop();
});

test("current mode keeps its own turn handling (the slow-wait opening, as before)", async () => {
  const s = relay([{ ms: 15_000, reply: { text: "It's on West 14th." } }], { feel: "current" });
  s.ask("where is it?");
  await s.timers.advance(15_100);
  assert.ok(s.results()[0].startsWith(cartesia.SLOW_ACK_LEAD));
  s.stop();
});

test("classic logs its fit as sizes and names only", () => {
  const r = cartesia.reasonCallReport(scenario("busy"));
  assert.equal(r.feel, "classic");
  assert.equal(r.base, 12_000);
  assert.ok(r.kept.every(k => /^[a-z_]+:\d+$/.test(k)));
});

// ---------- the agent's saved settings ----------

test("agent: the classic config is call 112's (version av_f1C22…) in every field but the check-in, which is 20 s", () => {
  assert.equal(AGENT112.id, agentClassic.REF_VERSION);
  const want = agentClassic.classicConfig(AGENT112.config);
  assert.deepEqual(agentClassic.differences(AGENT112.config, want), [".turn.inactivity_check_in_secs"]);
  assert.equal(want.turn.inactivity_check_in_secs, 20);
  assert.equal(AGENT112.config.turn.inactivity_check_in_secs, 8);
  assert.equal(want.system_tools.skip_turn.wait_timeout_secs, null);
  assert.equal(want.instructions.length, 789);
  assert.ok(!/Asking Reason to/.test(want.instructions));
});

test("agent: the script reads, PATCHes the classic config and checks the read-back; without --yes it changes nothing", async () => {
  const now = { ...AGENT112, version: { id: "av_now" }, config: { ...agentClassic.classicConfig(AGENT112.config), instructions: "newer words" } };
  let saved = null;
  const calls = [];
  const fake = async (key, p, { method = "GET", body = null } = {}) => {
    calls.push(`${method} ${p}`);
    if (method === "PATCH") { saved = body.config; return { ok: true, status: 200, json: {} }; }
    if (p.includes("/versions/")) return { ok: true, status: 200, json: AGENT112 };
    return { ok: true, status: 200, json: saved ? { config: saved, version: { id: "av_after" } } : now };
  };
  const log = [];
  assert.equal(await agentClassic.main(["--agent", "agent_x"], { call: fake, key: "k", log: (l) => log.push(l) }), 0);
  assert.ok(!calls.some(c => c.startsWith("PATCH")));
  assert.equal(await agentClassic.main(["--agent", "agent_x", "--yes"], { call: fake, key: "k", log: (l) => log.push(l) }), 0);
  assert.deepEqual(saved, agentClassic.classicConfig(AGENT112.config));
  assert.ok(log.some(l => /Read back: equal to the plan in every field/.test(l)));
  assert.ok(!log.join("\n").includes("\"k\""), "the key is never printed");
});
