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
// Openers are on with the brain; the tests that are not about them turn them off per call.
process.env.REASON_CALL_BRAIN_OPENERS = "off";

const bf = await import("../src/calls/brainfirst.js");
const op = await import("../src/calls/brainopener.js");
const bank = await import("../src/calls/brainbank.js");
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

// ---------- openers (src/calls/brainopener.js) ----------

test("every opener is content-free: no fact, number, yes/no, sure/done/got it, nothing upbeat, no done-claim", () => {
  assert.ok(op.ALL_OPENERS.length >= 36);
  for (const o of op.ALL_OPENERS) assert.ok(op.openerSafe(o), o);
  for (const bad of ["Sure,", "Yes,", "Got it,", "No problem,", "Done.", "Great news,", "It's booked.", "Last time,", "I'll do it,", "Okay, 8 pm"]) assert.equal(op.openerSafe(bad), false, bad);
  for (const k of op.CLASSES) assert.ok(op.OPENERS[k].length >= 6, k);
  for (const s of op.STANDALONE) assert.match(s, /[.]$/);
});

test("never the same opener twice running, nor within the last three", () => {
  const recent = [];
  let seq = [];
  for (let i = 0; i < 60; i++) seq.push(op.pickOpener(op.CLASSES[i % 2 ? 1 : 4], recent));
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
  const r2 = [];
  seq = Array.from({ length: 40 }, () => op.pickOpener("lookup", r2));
  for (let i = 3; i < seq.length; i++) assert.ok(!seq.slice(i - 3, i).includes(seq[i]), seq.slice(i - 3, i + 1).join(" | "));
});

test("their turn is read by rules, in well under a millisecond", () => {
  const cases = { "How are you?": "chat", "Hello.": "chat", "Good. I have a thing to tell you. Hello?": "chat", "Where were we?": "memory", "what did we say on the last call?": "memory",
    "can you book it for me?": "request", "Yeah, do that.": "request", "how much is it with tax?": "lookup", "what time does it close?": "lookup",
    "what do you think of the idea?": "question", "No, I said when I get there": "repair", "Uh no, I didn't want that": "repair", "what the hell, that's wrong": "repair" };
  const t0 = process.hrtime.bigint();
  for (const [t, k] of Object.entries(cases)) assert.equal(op.classify(t), k, t);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 / Object.keys(cases).length < 1);
});

test("the continuation joins the opener as one sentence: nothing said twice, no filler restart", () => {
  assert.equal(op.joinAfter("Okay, so", "Okay, so we were on the events idea."), "we were on the events idea.");
  assert.equal(op.joinAfter("Alright, so", "so the idea is this."), "the idea is this.");
  assert.equal(op.joinAfter("Fair,", "... fair, I should be clearer."), "I should be clearer.");
  assert.equal(op.joinAfter("Okay, so", "We were on it."), "we were on it.");
  assert.equal(op.joinAfter("So,", "Sorry about that."), "Sorry about that.");
  assert.equal(op.joinAfter("Let me see.", "the store is close."), "The store is close.");
  assert.equal(op.joinAfter("Okay, so", "Apple West is closest."), "Apple West is closest.");
  assert.match(op.openerNote("Hmm,"), /ALREADY said.*"Hmm,"/);
  const m = op.withOpener([{ role: "user", content: "hi" }], "Mm,");
  assert.equal(m.length, 1);
  assert.match(m[0].content, /^hi\n\n\[You have ALREADY said/);
});

const later = (ms, gen) => async function* () { await new Promise(r => setTimeout(r, ms)); yield* gen; };
async function* says(...texts) { for (const t of texts) yield { type: "say", text: t }; yield { type: "done" }; }

test("the speaking turn's own first sentence in before the deadline: no opener, the other turn stopped", async () => {
  let stoppedB = false;
  const out = await run(bf.withOpenerRace({ speakA: later(5, says("We were on the events idea."))(), speakB: later(50, says("we were on it."))(), opener: "Okay, so", atMs: 40, stopB: () => { stoppedB = true; } }));
  assert.deepEqual(out.filter(e => e.type === "say").map(e => e.text), ["We were on the events idea."]);
  assert.ok(stoppedB);
});

test("not in by the deadline: the opener is said, then the continuation that was told about it", async () => {
  let stoppedA = false;
  const out = await run(bf.withOpenerRace({ speakA: later(200, says("Never heard."))(), speakB: later(60, says("Okay, so we were on the events idea.", "Still sizing it."))(), opener: "Okay, so", atMs: 20, stopA: () => { stoppedA = true; } }));
  const s = out.filter(e => e.type === "say");
  assert.deepEqual(s.map(e => e.text), ["Okay, so", "we were on the events idea.", "Still sizing it."]);
  assert.ok(s[0].opener && stoppedA);
});

test("a hand-off right after an unfinished opener closes the sentence before the music", async () => {
  async function* handsOff() { yield { type: "handoff", why: "asked", ask: "x" }; yield { type: "done" }; }
  const out = await run(bf.withOpenerRace({ speakA: later(200, says("x"))(), speakB: later(5, handsOff())(), opener: "Okay, so", atMs: 10 }));
  assert.deepEqual(out.filter(e => e.type === "say").map(e => e.text), ["Okay, so", op.HANDOFF_TAIL]);
  assert.ok(out.some(e => e.type === "handoff"));
  const out2 = await run(bf.withOpenerRace({ speakA: later(200, says("x"))(), speakB: later(5, handsOff())(), opener: "Let me see.", atMs: 10 }));
  assert.deepEqual(out2.filter(e => e.type === "say").map(e => e.text), ["Let me see."]);
});

test("a done-claim in the continuation is still never said; the opener alone is heard, then the hand-off", async () => {
  const row = ownCall();
  const full = async () => ({ text: "Let me check the record: not booked yet." });
  const out = await run(bf.brainTurn({ call: row, history: [{ role: "user", content: "what's the plan tonight?" }], full, session, openers: true, openerAtMs: 30,
    stream: later(300, fakeStream(["Never heard."])()), streamB: fakeStream(["it's booked for 8."]), timers: globalThis }));
  const said = out.filter(e => e.type === "say").map(e => e.text).join(" ");
  assert.ok(!/booked for 8/.test(said), said);
  assert.ok(out.some(e => e.type === "hold"));
  assert.match(said, /not booked yet/);
});

test("'is it done?' gets a stand-alone opener at once, then the hold and the full brain; no model word", async () => {
  const row = ownCall();
  let modelCalled = false;
  const stream = async function* () { modelCalled = true; yield* fakeStream(["Yes."])(); };
  const out = await run(bf.brainTurn({ call: row, history: [{ role: "user", content: "did you send it?" }], full: async () => ({ text: "Not yet: it is still waiting on your yes." }), session, openers: true, stream, streamB: stream }));
  assert.equal(modelCalled, false);
  assert.deepEqual(out.map(e => e.type), ["say", "hold", "say", "done"]);
  assert.ok(op.STANDALONE.includes(out[0].text));
});

// ---------- the bank: bucket A answered with no brain (src/calls/brainbank.js) ----------

test("the placeholder bank loads whole: every line passes its check", () => {
  bank.resetBank();
  const b = bank.bank({ path: "" });
  assert.deepEqual(b.dropped, { lines: 0, cues: 0, buckets: 0 });
  assert.ok(b.buckets.some(x => x.kind === "instant") && b.buckets.some(x => x.kind === "opener"));
});

test("a bank file can never put a claim, a number or a promise in Reason's mouth", () => {
  const b = bank.checkBank({ version: "t", buckets: [
    { id: "a", kind: "instant", cues: ["^thanks$", "("], lines: [{ text: "Of course." }, { text: "Done, it's booked." }, { text: "I'll text you at 8." }, { text: "Yes." }] },
    { id: "b", kind: "opener", cues: [], lines: [{ text: "So," }, { text: "Sure, got it," }] },
    { id: "c", kind: "weird", lines: [{ text: "x" }] },
  ] });
  assert.deepEqual(b.buckets.map(x => [x.id, x.lines.map(l => l.text)]), [["a", ["Of course."]], ["b", ["So,"]]]);
  assert.deepEqual(b.dropped, { lines: 4, cues: 1, buckets: 1 });
});

test("bucket A: a whole-turn presence check, greeting, thanks or wait is answered from the bank", () => {
  bank.resetBank();
  for (const [t, id] of [["are you with me?", "presence_check"], ["Hello?", "presence_check"], ["You there?", "presence_check"], ["How are you?", "greeting"], ["hey, what's up", "greeting"], ["thanks so much", "thanks"], ["give me a second", "wait_ask"], ["hold on", "wait_ask"]]) {
    assert.equal(bank.instantReply(t, { history: [{ role: "assistant", content: "Hi." }, { role: "user", content: t }] })?.bucket, id, t);
  }
});

test("bucket A never takes a turn with more in it, or one that follows an unanswered turn of theirs", () => {
  for (const t of ["how are you? also did you book it", "thanks, now text her the page", "are you with me on the pricing idea", "where were we?", "is it done?"]) assert.equal(bank.instantReply(t, { history: [] }), null, t);
  const owed = [{ role: "user", content: "remember the events conversation" }, { role: "user", content: "Hello?" }];
  assert.equal(bank.instantReply("Hello?", { history: owed }), null);
});

test("a bucket A turn calls no model and says the bank's line", async () => {
  const row = ownCall();
  let modelCalled = false;
  const stream = async function* () { modelCalled = true; yield* fakeStream(["Hi."])(); };
  const out = await run(bf.brainTurn({ call: row, history: [{ role: "assistant", content: "Hey." }, { role: "user", content: "are you with me?" }], full: async () => { throw new Error("no"); }, session, openers: true, stream, streamB: stream }));
  assert.equal(modelCalled, false);
  assert.equal(out[0].from, "bank");
  assert.equal(out.at(-1).instant, "presence_check");
});
