// The speaking brain (src/calls/brainfirst.js, docs/calls-brain-first.md). No network: the model stream,
// Reason's full turn and the preload are stand-ins. Off by default; only a person's own call; the done
// guard, markers, careful topics, the passphrase screen and the deferral line hold on every turn.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-brainfirst-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
delete process.env.REASON_CALL_BRAIN;
delete process.env.REASON_CALL_TRUST;
delete process.env.ANTHROPIC_API_KEY;

const bf = await import("../src/calls/brainfirst.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const SECRET = "s".repeat(32);
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  config.callBrain = "off";
  delete process.env.REASON_CALL_BRAIN_SECRET;
  db.db.exec("DELETE FROM calls; DELETE FROM accounts;");
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
});
const ownCall = (conversationId = C) => db.createCall(conversationId, {
  provider: "gptlive", toNumber: conversationId === C ? "+12025551234" : "+13105550000", isOwner: true, goal: "check in", facts: [],
  announcement: "Hey, it's Reason.", state: "in_progress",
});
const businessCall = () => db.createCall(C, { provider: "gptlive", toNumber: "+12125550100", isOwner: false, goal: "book a table", facts: [], announcement: "Hi.", state: "in_progress" });

/** A stand-in Anthropic stream: text deltas, then optionally a tool call. */
const fakeStream = (texts, { tool = null } = {}) => async function* () {
  yield { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100 } } };
  for (const t of texts) yield { type: "content_block_delta", delta: { type: "text_delta", text: t } };
  if (tool) {
    yield { type: "content_block_start", content_block: { type: "tool_use", name: bf.HANDOFF_TOOL.name, id: "t1" } };
    yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ ask: tool }) } };
  }
  yield { type: "message_delta", usage: { output_tokens: 20 } };
};
const run = async (gen) => { const out = []; for await (const e of gen) out.push(e); return out; };
const session = { system: "test system", preloaded: [] };

test("off by default, and off means no call gets it", () => {
  assert.equal(config.callBrain, "off");
  assert.equal(bf.brainFirstFor(ownCall()), false);
});

test("owner: the operator's own call only; never a business call or another account at owner", () => {
  config.callBrain = "owner";
  assert.equal(bf.brainFirstFor(ownCall()), true);
  assert.equal(bf.brainFirstFor(businessCall()), false);
  assert.equal(bf.brainFirstFor(ownCall(OTHER)), false);
  config.callBrain = "on";
  assert.equal(bf.brainFirstFor(businessCall()), false);
});

test("the first sentence is given as soon as it is written, before the rest", async () => {
  let n = 0;
  const now = () => (n += 100);
  const out = await run(bf.speakTurn({ system: "s", messages: [{ role: "user", content: "where were we?" }], theirWords: "where were we?", stream: fakeStream(["We were on the events ", "idea. Still sizing", " the market."]), now }));
  const says = out.filter(e => e.type === "say");
  assert.equal(says[0].text, "We were on the events idea.");
  assert.equal(says[1].text, "Still sizing the market.");
  assert.ok(says[0].ms < says[1].ms);
  assert.equal(out.at(-1).type, "done");
});

test("a done-claim is never said: the turn hands over to the full brain instead", async () => {
  const out = await run(bf.speakTurn({ system: "s", messages: [{ role: "user", content: "what's the plan tonight?" }], theirWords: "what's the plan tonight?", stream: fakeStream(["Yeah, it's booked for 8. ", "Anything else?"]) }));
  assert.equal(out.filter(e => e.type === "say").length, 0);
  assert.equal(out.find(e => e.type === "handoff").why, "done_claim");
});

test("'is it done?' in any wording goes to the full brain before a model word; a bare yes is never said", async () => {
  for (const q of ["is it done?", "did you send it?", "have you booked the Genius Bar?", "So is it done", "did it go through yet", "did you text her"]) {
    let called = false;
    const stream = async function* () { called = true; yield* fakeStream(["Yes."])(); };
    const out = await run(bf.speakTurn({ system: "s", messages: [{ role: "user", content: q }], theirWords: q, stream }));
    assert.equal(called, false, q);
    assert.equal(out[0].why, "done_question", q);
  }
  for (const q of ["where were we?", "how are you?", "what do you think of the events idea?", "what did we say on the last call?"]) assert.equal(bf.asksIfDone(q), false, q);
  assert.deepEqual(bf.guardSentence("Yeah.", { theirWords: "is the booking done?" }), { handoff: "done_yes" });
  assert.deepEqual(bf.guardSentence("It's booked for 8.", {}), { handoff: "done_claim" });
});

test("markers and tool names never reach the voice", async () => {
  const out = await run(bf.speakTurn({ system: "s", messages: [{ role: "user", content: "ok" }], theirWords: "ok", stream: fakeStream(["Skipping for now. ", "Sure, ask_reason can help."]) }));
  const said = out.filter(e => e.type === "say").map(e => e.text).join(" ");
  assert.ok(!/skip|ask_reason/i.test(said), said);
});

test("money, cards, codes and logins go straight to the full brain, before any model word", async () => {
  let called = false;
  const stream = async function* () { called = true; yield* fakeStream(["Your card ends in 4242."])(); };
  const out = await run(bf.speakTurn({ system: "s", messages: [{ role: "user", content: "pay with my card" }], theirWords: "pay with my card", stream }));
  assert.equal(called, false);
  assert.equal(out[0].why, "careful_topic");
});

test("the lead-in is said, then the full brain answers after the hold", async () => {
  const row = ownCall();
  let asked = null;
  const full = async (messages) => { asked = messages; return { text: "The market is about two hundred million in the US.", endCall: null }; };
  const out = await run(bf.brainTurn({ call: row, history: [{ role: "user", content: "how big is the market?" }], full, session, stream: fakeStream(["Let me check that. "], { tool: "market size for the events idea" }) }));
  assert.deepEqual(out.map(e => e.type), ["say", "hold", "say", "done"]);
  assert.equal(out[0].from, "speak");
  assert.equal(out[2].from, "full");
  assert.equal(out.at(-1).handoff, "asked");
  assert.equal(asked.at(-2).role, "assistant");
  assert.match(asked.at(-1).content, /market size/);
});

test("the full brain's words go through the marker filter and say nothing for a skip", async () => {
  const row = ownCall();
  const out1 = await run(bf.brainTurn({ call: row, history: [{ role: "user", content: "x" }], full: async () => ({ text: "Done thinking. skip_turn" }), session, stream: fakeStream([], { tool: "x" }) }));
  assert.ok(!out1.some(e => e.type === "say" && /skip_turn/.test(e.text)));
  const out2 = await run(bf.brainTurn({ call: row, history: [{ role: "user", content: "x" }], full: async () => ({ text: "nothing", skip: true }), session, stream: fakeStream([], { tool: "x" }) }));
  assert.equal(out2.filter(e => e.type === "say").length, 0);
});

test("something put off until after the call is said with the deferral line", async () => {
  const row = ownCall();
  const full = async () => { db.updateCall(row.conversation_id, row.id, { verify_deferred: "send the page" }); return { text: "Sure." }; };
  const out = await run(bf.brainTurn({ call: row, history: [{ role: "user", content: "text her the page" }], full, session, stream: fakeStream([], { tool: "text her the page" }) }));
  assert.ok(out.some(e => e.type === "say" && e.from === "full" && e.text.startsWith("I can't do that one from a call.")));
});

test("the endpoint does not exist with the switch off, and needs the secret and a known own call when on", async () => {
  const row = ownCall();
  const body = JSON.stringify({ token: row.webhook_token, history: [{ role: "user", content: "hi" }] });
  assert.equal((await bf.brainTurnRequest({ rawBody: body, headers: { "x-reason-brain": SECRET } })).status, 404);
  config.callBrain = "owner";
  assert.equal((await bf.brainTurnRequest({ rawBody: body, headers: {} })).status, 401);
  process.env.REASON_CALL_BRAIN_SECRET = SECRET;
  assert.equal((await bf.brainTurnRequest({ rawBody: body, headers: { "x-reason-brain": "wrong".padEnd(32, "x") } })).status, 401);
  const biz = businessCall();
  assert.equal((await bf.brainTurnRequest({ rawBody: JSON.stringify({ token: biz.webhook_token, history: [] }), headers: { "x-reason-brain": SECRET } })).status, 403);
  assert.equal((await bf.brainTurnRequest({ rawBody: JSON.stringify({ token: "nope", history: [] }), headers: { "x-reason-brain": SECRET } })).status, 403);
});

test("the speaking prompt keeps the persona and the call context, and drops the tool manual", () => {
  const text = ["You are Reason.", "How you work\n" + "x".repeat(9000), "Hard rules\n- Never claim it is done.", "How you lay a message out\nbubbles"].join("\n\n");
  const sys = bf.speakingSystem({ context: { system: `${text}\n\n--- you are ON A PHONE CALL right now, not texting ---\n\nEARLIER CALLS with them: the events idea` }, preloaded: ["- events: 2% cut"] });
  assert.match(sys, /You are Reason\./);
  assert.match(sys, /Hard rules/);
  assert.match(sys, /EARLIER CALLS/);
  assert.match(sys, /2% cut/);
  assert.ok(!/How you work|How you lay a message out/.test(sys));
  assert.match(sys, /think_it_through/);
});

test("the preload never throws and reads nothing after the call began", async () => {
  const row = ownCall();
  const seen = [];
  const lines = await bf.preloadFor(row, { topics: ["the events idea"], until: 1000, find: async (c, t) => { seen.push(t); return ["- a fact"]; }, history: async (c, t, { until }) => { assert.equal(until, 1000); return ["- (Nov 13, a call) the events idea"]; } });
  assert.deepEqual(lines, ["- a fact", "- (Nov 13, a call) the events idea"]);
  assert.deepEqual(await bf.preloadFor(row, { topics: ["x"], find: async () => { throw new Error("down"); }, history: async () => { throw new Error("down"); } }), []);
});
