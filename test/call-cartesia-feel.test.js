// How a Cartesia call feels (call 113, 2026-11-13): markers never spoken, the "You still there?" check-in,
// answers talked over before their point, the deferral said out loud, times read back, a slow answer that
// owns its wait. Guards, prompt and config only: nothing here changes when anyone speaks. No network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cartesia-feel-"));
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
delete process.env.REASON_CALL_PASSPHRASE;

const cartesia = await import("../src/calls/cartesia.js");
const verify = await import("../src/calls/verify.js");
const { ownerCallFrame } = await import("../src/calls/voice-prompt.js");
const setup = await import("../scripts/cartesia-agent-setup.mjs");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  Object.assign(config, { callCartesia: "owner", cartesiaKey: "ck-test", cartesiaAgentId: "agent_test" });
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
  const h = { msg: [], close: [] };
  return { send: () => {}, open: () => true, close: () => {}, onMessage: (f) => h.msg.push(f), onClose: (f) => h.close.push(f), say: (o) => h.msg.forEach(f => f(JSON.stringify(o))) };
}
function fakeSocket() {
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
const ownCall = (over = {}) => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "", facts: [], announcement: "", state: "in_progress", direction: "in", ...over,
});

/** One relay; `replies` are Reason's turns in order, each `{ ms, reply, before }` (`before` runs inside the turn). */
function relay(replies, extra = {}) {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const agent = fakeSocket();
  const lines = [];
  const row = ownCall();
  const queue = [...replies];
  const call = new cartesia.CartesiaAgentCall({
    call: row, twilio, openAgent: () => agent.socket, now: timers.now, timers, log: (l) => lines.push(l),
    brain: () => {
      const next = queue.shift() ?? { ms: 100, reply: { text: "Okay." } };
      next.before?.(row);
      return new Promise((r) => timers.setTimeout(() => r(next.reply), next.ms ?? 100));
    },
    deleteCall: async () => ({ ok: true, redacted: true, status: 200 }),
    textOwner: () => ({ ok: true }),
    ...extra,
  });
  call.begin();
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  agent.open();
  agent.emit({ type: "session_ready", call_id: "ac_feel" });
  let n = 1;
  const user = (text) => agent.emit({ type: "turn_ended", turn: n++, role: "user", text, interrupted: false });
  const said = (text, interrupted = false) => agent.emit({ type: "turn_ended", turn: n++, role: "assistant", text, interrupted });
  const ask = (request) => agent.emit({ type: "client_tool_call", tool_call_id: `tc_${n++}`, tool_name: "ask_reason", parameters: { request }, expects_response: true });
  const results = () => agent.of("client_tool_result").map(r => r.result);
  const stop = () => { for (const k of ["roomTimer", "readyTimer"]) if (call[k]) timers.clearTimeout(call[k]); call.done = true; };
  return { call, row, timers, agent, lines, user, said, ask, results, stop };
}

// ---------- A: markers are never handed to the voice ----------

test("every internal marker comes out of Reason's words; the words around it, links and [laughter] stay", () => {
  for (const m of cartesia.VOICE_MARKERS) {
    assert.equal(cartesia.forVoice(m), "", `${m} alone is nothing to say`);
    assert.ok(cartesia.hasMarker(m), `${m} is seen as a marker`);
    assert.equal(cartesia.forVoice(`${m} Course, take your time.`), "Course, take your time.", `${m} before words`);
  }
  assert.equal(cartesia.forVoice("Skipping for now. Course, take your time."), "Course, take your time.");
  assert.equal(cartesia.forVoice("Calling web_search now."), "Calling now.");
  assert.equal(cartesia.forVoice("I'm skipping this turn."), "");
  for (const keep of ["Got it, 8:10 PM. I'll pick it up by text after the call.", "The page is apple.com/retail/genius_bar.", "Ha, fair. [laughter]", "Done what?", "I'll skip the gym then."]) {
    assert.equal(cartesia.forVoice(keep), keep, keep);
    assert.ok(!cartesia.hasMarker(keep), keep);
  }
});

test("call 113: a marker in Reason's turn is never in the tool result; a marker-only turn is nothing to add; one the agent says is logged", async () => {
  const s = relay([{ reply: { text: "Skipping for now. Course, take your time." } }, { reply: { text: "NO_REPLY skip_turn" } }]);
  s.user("Please, give me one second.");
  s.ask("give me a second");
  await s.timers.advance(200);
  s.said("Course, take your time.");
  s.ask("um");
  await s.timers.advance(200);
  const [first, second] = s.results();
  assert.equal(first, "Course, take your time.");
  assert.equal(second, cartesia.NOTHING_TO_ADD);
  for (const r of s.results()) for (const m of ["Skipping", "skip_turn", "NO_REPLY"]) assert.ok(!r.includes(m), `${m} not handed to the voice`);
  s.said("Skipping for now.");
  assert.equal(s.lines.filter(l => l.cartesia_marker_spoken).length, 1);
  s.stop();
});

// ---------- B: the check-in ----------

test("a wait ask is told from a time (\"wait for like 8\"), and a check-in from an ordinary line", () => {
  for (const yes of ["Please, give me one second.", "I said just give me a second.", "hold on", "Hang on.", "one sec", "Wait.", "wait a sec", "just a minute"]) assert.ok(cartesia.WAIT_ASK.test(yes), yes);
  for (const no of ["So, um, do wait for like 8, 10 PM.", "I can't wait to see it.", "What's on tomorrow?"]) assert.ok(!cartesia.WAIT_ASK.test(no), no);
  for (const yes of ["You still there?", "Are you still there?", "Still with me?", "Are you there?"]) assert.ok(cartesia.CHECK_IN.test(yes), yes);
  for (const no of ["Hey, I'm here. What's up?", "Just here,", "Course, take your time."]) assert.ok(!cartesia.CHECK_IN.test(no), no);
});

test("a check-in is logged with what it came after: their wait ask, a pending lookup, a skip", async () => {
  const s = relay([{ ms: 20_000, reply: { text: "Here's the link." } }]);
  s.user("Please, give me one second.");
  await s.timers.advance(9_000);
  s.said("You still there?");
  s.ask("send me the link");
  await s.timers.advance(8_000);
  s.said("You still there?");
  const logged = s.lines.filter(l => l.cartesia_check_in);
  assert.equal(logged.length, 2);
  assert.equal(logged[0].after_wait_ask_ms, 9_000);
  assert.equal(logged[0].lookup_pending, false);
  assert.equal(logged[1].lookup_pending, true);
  s.stop();
});

test("the check-in is fixed where it comes from: the agent's turn settings and a silent skip_turn that holds check-ins off (proposed, never applied here)", async () => {
  assert.equal(setup.CALL_FEEL.turn.inactivity_check_in_secs, 20, "Cartesia's default 8 s came ~8 s after every pause");
  assert.ok(setup.CALL_FEEL.turn.inactivity_check_in_secs < setup.CALL_FEEL.turn.inactivity_end_call_secs, "their rule: check-in before end-call");
  assert.equal(setup.CALL_FEEL.turn.inactivity_end_call_secs, 240, "unchanged");
  assert.equal(setup.CALL_FEEL.skip_turn.wait_timeout_secs, -1, "no check-in after a skip until they speak");
  assert.equal(setup.CALL_FEEL.skip_turn.pre_tool_speech, "off", "no words with a skip");
  assert.match(setup.SKIP_TURN_DESCRIPTION, /give me a second/);
  assert.match(setup.SKIP_TURN_DESCRIPTION, /not even a word about skipping/);
  assert.ok(setup.SKIP_TURN_DESCRIPTION.length <= 2000);
  const up = setup.updateBody({ callFeel: true });
  assert.deepEqual(Object.keys(up.config).sort(), ["system_tools", "turn"], "sparse: nothing else on the agent");
  assert.deepEqual(Object.keys(up.config.system_tools), ["skip_turn"], "end_call left as it is");
  const made = setup.agentBody({ model: "m", toolId: "t" }).config;
  assert.deepEqual(made.turn, setup.CALL_FEEL.turn);
  assert.equal(made.system_tools.skip_turn.wait_timeout_secs, -1);
  const said = [];
  const calls = [];
  assert.equal(await setup.main(["--update", "agent_x", "--call-feel"], { log: (l) => said.push(l), call: async (...a) => { calls.push(a); return { ok: true }; }, key: "ck" }), 0);
  assert.equal(calls.length, 0, "the plan only without --yes");
  assert.match(said.join("\n"), /check-in after 20 s/);
});

test("the agent's per-call lines carry the turn rules: skip on a filler or a wait ask, silent skips, no check-in after a wait or during a lookup, at most twice", () => {
  const lines = cartesia.cartesiaCallLines({ tags: false });
  for (const l of cartesia.TURN_LINES) assert.ok(lines.includes(l));
  assert.match(lines, /When they ask you to wait \("give me a second", "hold on", "one sec", "wait"\), use skip_turn/);
  assert.match(lines, /When you skip a turn, say nothing at all: never say "skipping"/);
  assert.match(lines, /never while Reason is looking something up, never after they asked you to wait, never right after you skipped a turn, at most once per silence and at most twice in a call/);
  for (const bad of ["Omari", "Genius", "Apple"]) assert.ok(!lines.includes(bad));
});

// ---------- C: an answer talked over before its point ----------

test("call 113: Reason's answer cut to \"Got\" is kept, written into the record, and offered again in short form by the next answer", async () => {
  const lost = "Got it, eight ten PM tonight. I can't book from a call, so I'll do it by text right after.";
  const s = relay([{ reply: { text: lost } }, { reply: { text: "It's on West 14th." } }]);
  s.ask("book it for 8:10");
  await s.timers.advance(200);
  s.said("Got", true);
  s.user("Yeah, then just let me know if you need anything else.");
  assert.equal(s.lines.filter(l => l.cartesia_answer_unheard).length, 1);
  assert.ok(s.call.turns.some(t => t.text === cartesia.unheardNote("Got it, eight ten PM tonight.")), "the brain's next turn sees it was not heard");
  s.ask("where is it again?");
  await s.timers.advance(200);
  const next = s.results()[1];
  assert.ok(next.startsWith(cartesia.reofferLead("Got it, eight ten PM tonight.")), next);
  assert.ok(next.endsWith("Reason's answer: It's on West 14th."));
  // Offered once: the answer after it is plain.
  s.said("Got it, eight ten tonight. It's on West 14th.");
  s.ask("thanks");
  await s.timers.advance(200);
  assert.equal(s.results()[2], "Okay.");
  s.stop();
});

test("an answer lost when they spoke over it, and Reason has nothing new: the lost point is the result, never \"nothing to add\"", async () => {
  const s = relay([{ reply: { text: "I'll pick up the booking by text after the call." } }, { reply: { text: "", skip: true } }]);
  s.ask("book the Genius Bar");
  await s.timers.advance(200);
  s.said("", true);
  s.ask("any specific things you need from me?");
  await s.timers.advance(200);
  assert.equal(s.results()[1], cartesia.reofferOnly("I'll pick up the booking by text after the call."));
  s.stop();
});

test("cut in near the end, or not cut at all: heard, nothing offered again; the agent saying it again itself clears it", async () => {
  const answer = "The closest one is West 14th Street, open until nine tonight.";
  const s = relay([{ reply: { text: answer } }, { reply: { text: answer } }, { reply: { text: "Sure." } }, { reply: { text: "Okay then." } }]);
  s.ask("closest store?");
  await s.timers.advance(200);
  s.said("The closest one is West 14th Street, open until nine", true);
  s.ask("and?");
  await s.timers.advance(200);
  s.said("Lost", true);
  assert.ok(s.call.unheard, "the second one was lost");
  s.said("Oh, and the closest one is West 14th Street, open until nine tonight.");
  assert.equal(s.call.unheard, null, "the agent gave it again on its own");
  s.ask("ok");
  await s.timers.advance(200);
  assert.equal(s.results()[2], "Sure.");
  assert.equal(s.lines.filter(l => l.cartesia_answer_unheard).length, 1);
  s.stop();
});

test("the agent is told to give a talked-over point again and never drop it", () => {
  assert.match(cartesia.cartesiaCallLines({ tags: false }), /If they talk over you before you got to the point of Reason's answer, first answer what they just said, then give that point again in one short sentence\. Never drop it\./);
});

// ---------- D: a booking put off until after the call is said out loud, at once ----------

test("call 113: Reason's turn defers the booking (caller not verified) and skips: the deferral line is said, never a skip", async () => {
  const s = relay([{ before: (row) => verify.queueForAfter(row, "book a Genius Bar appointment for 8:10 PM"), reply: { text: "", skip: true } }]);
  s.ask("book it for 8:10");
  await s.timers.advance(200);
  assert.equal(s.results()[0], cartesia.DEFERRED_LINE);
  assert.match(cartesia.DEFERRED_LINE, /can't do that one from a call\. I'll do it by text right after we hang up, and tell you there\./);
  assert.equal(s.lines.filter(l => l.cartesia_deferred_said).length, 1);
  s.stop();
});

test("a deferral whose words leave it out gets the line in front; one that says it is left alone; no deferral, no line", async () => {
  let s = relay([{ before: (row) => verify.queueForAfter(row, "book it"), reply: { text: "Eight ten works." } }]);
  s.ask("book it");
  await s.timers.advance(200);
  assert.equal(s.results()[0], `${cartesia.DEFERRED_LINE} Eight ten works.`);
  s.stop();
  s = relay([{ before: (row) => verify.queueForAfter(row, "book it"), reply: { text: "Got it. I'll do the booking by text as soon as we hang up." } }]);
  s.ask("book it");
  await s.timers.advance(200);
  assert.equal(s.results()[0], "Got it. I'll do the booking by text as soon as we hang up.");
  s.stop();
  s = relay([{ reply: { text: "Eight ten works." } }]);
  s.ask("does 8:10 work?");
  await s.timers.advance(200);
  assert.equal(s.results()[0], "Eight ten works.");
  assert.ok(!s.lines.some(l => l.cartesia_deferred_said));
  s.stop();
});

test("the verification rule is unchanged: an inbound call from the owner's number is not verified by caller ID; one Reason placed is", () => {
  assert.equal(verify.isVerified({ is_owner: 1, direction: "in" }), false);
  assert.equal(verify.isVerified({ is_owner: 1, direction: "out" }), true);
  assert.equal(verify.isVerified({ is_owner: 1, direction: "in", verified_at: 1 }), true);
  assert.equal(verify.passphraseSet({ expected: "" }), false, "no passphrase set: every consequential ask on an inbound call waits for a text");
});

// ---------- E: times read back before acting; the ways a time is said, favoured ----------

test("the brain reads a time back once before acting on it (\"eight ten PM, right?\"), on every owner call", () => {
  for (const manner of [false, true]) {
    const frame = ownerCallFrame({ name: "Sam", manner });
    assert.match(frame, /Before you act on a time, date, number or amount they said .* read it back once, in words, and wait for their yes: "eight ten PM, right\?"/);
    assert.match(frame, /Once is enough/);
  }
  assert.match(cartesia.cartesiaCallLines({ tags: false }), /Never read one back or confirm one yourself: Reason does that\./);
});

test("the per-call keyterms carry the ways a time is said, two slots kept whatever the names", () => {
  const vars = cartesia.sessionVariables(ownCall());
  const terms = Object.entries(vars).filter(([k]) => k.startsWith("keyterm_")).map(([, v]) => v);
  assert.equal(terms.length, cartesia.KEYTERM_SLOTS);
  assert.ok(terms.includes("PM") && terms.includes("AM"), terms.join(","));
  for (const t of terms) assert.ok(t.length > 0);
});

// ---------- F: a slow answer owns its wait ----------

test("an answer back after 12 s opens by owning the wait; one back sooner is just the answer (the wait itself is unchanged)", async () => {
  let s = relay([{ ms: 13_000, reply: { text: "About seventy five with tax." } }]);
  s.ask("total with tax?");
  await s.timers.advance(13_100);
  assert.equal(s.results()[0], `${cartesia.SLOW_ACK_LEAD} Reason's answer: About seventy five with tax.`);
  s.stop();
  s = relay([{ ms: 10_000, reply: { text: "About seventy five with tax." } }]);
  s.ask("total with tax?");
  await s.timers.advance(10_100);
  assert.equal(s.results()[0], "About seventy five with tax.");
  assert.equal(cartesia.TEXT_MS, 25_000, "the 25 s hand-off to a text is as it was");
  s.stop();
});
