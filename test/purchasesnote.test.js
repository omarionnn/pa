// What Reason has really bought goes in front of the model when buying is in play, from the database,
// and beats the thread; and the model can read the same list itself with purchases_recent.
//
// The incident (2026-10-24): Reason texted the owner "the cerave's ordered" (Walmart order e66d7f2b…,
// buy conversation conv_3137fea70f6bcc5aca754052). AgentCard cancelled it minutes later; #92 moved
// the row to cancelled at 13:36 and that one cancellation was deliberately never texted
// (cancel_told_at). At 13:45Z the owner asked "can you check to see if target has it and if they ship
// to my address" and Reason said "the Walmart order already went through this morning, so this would
// be a second bottle" — believing its own old line, with no tool called, because nothing about
// purchases was in the turn's context.
//
// No model in here. What is tested is what the model is handed. No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-purchasesnote-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { purchasesNote, shoppingMoment, statusWords, startPurchasesNote, setTopicReader, previousAssistant, topicPrompt } = await import("../src/purchasesnote.js");
const agent = await import("../src/agent.js");
const { userMessageFor } = agent;
const { config } = await import("../src/config.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const { runTool, toolsFor } = await import("../src/tools.js");

const C = "dm:owner";
const OTHER = "dm:fake:+13475550000";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INCIDENT = Date.parse("2026-10-24T13:45:00Z");
const ASK = "can you check to see if target has it and if they ship to my address";
const CERAVE = "Cerave PM Niacinamide & Hyaluronic Acid Facial Moisturizer For All Skin Types 3 oz";
/** The clock only moves by offsets; this puts it at a moment. */
const setClock = (ms) => { clock.reset(); clock.skip(ms - clock.now()); };

const realCreate = agent.model.create;
after(() => { setTopicReader(null); agent.model.create = realCreate; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  setTopicReader(null);
  setClock(INCIDENT);
  db.db.exec("DELETE FROM agentcard_purchases; DELETE FROM conversations; DELETE FROM action_ledger; DELETE FROM offers;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
});

/** A purchase row as the tools leave it, moved where it got to, at `at`. */
function purchase({ conv = C, buy, status, cartHash = "h_1", cents = 1676, merchant = "Walmart", what = CERAVE, at = clock.now() }) {
  const now = clock.now();
  setClock(at);
  db.recordAgentcardPurchase({ conversationId: conv, buyConversationId: buy, status: "cart_shown", cartHash, amountCents: cents, merchant, what });
  db.markAgentcardPurchase(buy, { status });
  setClock(now);
  return db.getAgentcardPurchase(buy);
}

/** A buying tool's ledger row, `ago` before now. */
function ledger(action, ago) {
  const now = clock.now();
  setClock(now - ago);
  db.recordAction({ conversationId: C, action, attempted: {}, outcome: "ok", result: {}, receipt: action });
  setClock(now);
}

/** The 2026-10-24 morning as the database has it now. */
function theMorning() {
  const at = (iso) => Date.parse(iso);
  setClock(at("2026-10-24T03:55:39Z"));
  db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "conv_88aafaa", status: "shopping" }); // browsing, no cart
  purchase({ buy: "conv_70255fa", status: "declined", at: at("2026-10-24T03:57:55Z") });
  purchase({ buy: "conv_3137fea70f6bcc5aca754052", status: "placed", at: at("2026-10-24T12:58:05Z") });
  setClock(at("2026-10-24T13:36:56Z")); // the order.updated that cancelled it
  db.markAgentcardPurchase("conv_3137fea70f6bcc5aca754052", { orderId: "e66d7f2b", orderState: "cancelled", status: "cancelled" });
  db.claimAgentcardCancelNotice("conv_3137fea70f6bcc5aca754052"); // the text that was deliberately never sent
  setClock(INCIDENT);
  db.saveConversation(C, [
    { role: "user", content: "[Sat, Oct 24, 2026, 8:57 AM] Omari: yeah get it" },
    { role: "assistant", content: "done, the cerave's ordered from walmart. $16.76" },
  ]);
}

/** A CLI turn (the backend the live Reason runs on) with the CLI, pictures and MCP all stubbed. */
async function cliTurn(text, { images = async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }) } = {}) {
  let prompt;
  await runTurnViaCli({
    conversationId: C, text,
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images,
    recall: async () => [],
    run: async (args) => { prompt = args.prompt; return { ok: true, envelope: { result: "ok" } }; },
  });
  return prompt;
}

// ---------- the incident ----------

test("pinned 2026-10-24: the thread says ordered, the row says cancelled — the turn is shown cancelled", async () => {
  theMorning();
  assert.equal(shoppingMoment(C), "purchase_row_changed", "the row was cancelled nine minutes before the question");

  const note = purchasesNote(C);
  const lines = note.split("\n").slice(1);
  assert.equal(lines.length, 2, "the cancelled order and the declined try; the cartless browse is left out");
  assert.match(lines[0], /^- Oct 24 · Walmart · Cerave PM Niacinamide .* · \$16\.76 · CANCELLED by the shop, not coming$/);
  assert.match(lines[1], /declined, not bought$/);
  assert.doesNotMatch(note, /· placed\b/, "nothing on the record is placed");
  assert.match(note, /current state and overrides anything said earlier in the chat, including your own messages/);
  assert.doesNotMatch(note, /conv_|e66d7f2b|h_1/, "no ids the model has no use for");

  // The owner's own words, on the backend the live Reason runs on: the block is in the very prompt
  // that still carries the old "ordered".
  const prompt = await cliTurn(ASK);
  assert.match(prompt, /the cerave's ordered/, "the stale claim is still in the thread...");
  assert.match(prompt, /CANCELLED by the shop, not coming/, "...and the record that overrides it is right there");
  assert.ok(prompt.indexOf("PURCHASES ON RECORD") > prompt.indexOf("The new message:"), "beside the message it bears on");
  assert.doesNotMatch(JSON.stringify(db.loadConversation(C)), /PURCHASES ON RECORD/, "never saved into the thread");
});

test("pinned 2026-10-24: purchases_recent returns the cancelled order, as it stands now", async () => {
  theMorning();
  assert.ok(toolsFor(C).some(t => t.name === "purchases_recent"), "the model is shown the tool");
  const desc = toolsFor(C).find(t => t.name === "purchases_recent").description;
  assert.match(desc, /Check this before you say whether anything was ordered/);
  assert.match(desc, /never go by what was said earlier in the chat/);

  const out = await runTool("purchases_recent", {}, { conversationId: C });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.purchases.length, 2);
  assert.deepEqual(out.purchases[0], {
    date: "Oct 24", merchant: "Walmart", item: out.purchases[0].item, amount: "$16.76", status: "CANCELLED by the shop, not coming",
    reason: "no reason given",
  });
  assert.match(out.purchases[0].item, /^Cerave PM Niacinamide/);
  assert.match(out.purchases[1].status, /declined/);
  assert.match(out.note, /overrides anything said earlier in the chat/);
  assert.doesNotMatch(JSON.stringify(out), /conv_|e66d7f2b/);
  // Somebody else asking sees nothing of the owner's.
  const theirs = await runTool("purchases_recent", {}, { conversationId: OTHER });
  assert.equal(theirs.ok, true);
  assert.deepEqual(theirs.purchases, []);
  assert.match(theirs.note, /Nothing was bought or tried/);
});

test("purchases_recent answers on a turn with no block, and reaches further back when asked", async () => {
  purchase({ buy: "conv_lamp", status: "placed", merchant: "Target", what: "desk lamp", at: clock.now() - 20 * DAY });
  assert.equal(purchasesNote(C), "");
  assert.deepEqual((await runTool("purchases_recent", {}, { conversationId: C })).purchases, []);
  const far = await runTool("purchases_recent", { days: 30 }, { conversationId: C });
  assert.equal(far.days, 30);
  assert.equal(far.purchases[0].status, "placed");
  assert.equal(far.purchases[0].merchant, "Target");
});

// ---------- when it rides ----------

test("pinned: a turn with nothing to do with buying gets no block, though purchases are on record", async () => {
  // Bought five days ago, nothing since: no row moved in 48h, no buying tool, no offer read.
  purchase({ buy: "conv_old", status: "placed", merchant: "Amazon", what: "phone charger", at: clock.now() - 5 * DAY });
  ledger("web_search", HOUR); // something else ran recently; it is not a shopping flow
  assert.equal(shoppingMoment(C), "");
  assert.equal(purchasesNote(C), "");
  const prompt = await cliTurn("what's the weather tomorrow");
  assert.doesNotMatch(prompt, /PURCHASES/);
});

test("a shopping flow going on switches it on: a buying tool or an offer read in the last 6 hours", () => {
  purchase({ buy: "conv_old", status: "placed", merchant: "Amazon", what: "phone charger", at: clock.now() - 5 * DAY });
  ledger("purchase", 7 * HOUR);
  assert.equal(purchasesNote(C), "", "a flow from 7 hours ago is over");
  ledger("offer_check", 2 * HOUR);
  assert.equal(shoppingMoment(C), "buying_tool_ran");
  assert.match(purchasesNote(C), /Amazon · phone charger · \$16\.76 · placed/);

  db.db.exec("DELETE FROM action_ledger");
  db.saveOffer(C, { source: "page", url: "https://www.target.com/p/x", product: "CeraVe PM", price_cents: 1599 });
  assert.equal(shoppingMoment(C), "offer_read");
  assert.match(purchasesNote(C), /phone charger/);
});

test("somebody else's activity does not switch it on for them, nor show them anything", () => {
  purchase({ conv: OTHER, buy: "conv_ama", status: "placed" });
  assert.equal(shoppingMoment(C), "");
  purchase({ buy: "conv_mine", status: "placed", merchant: "Target", what: "lotion", at: clock.now() - 5 * DAY });
  ledger("purchase", HOUR);
  const note = purchasesNote(C);
  assert.match(note, /Target · lotion/);
  assert.equal(note.split("\n").length, 2, "theirs only");
});

test("the API path: the block goes to the model and not into the thread; every backend reads it", () => {
  theMorning();
  const { forModel, forHistory } = userMessageFor({ prefix: "[Sat, Oct 24, 2026, 9:45 AM] Omari:", text: ASK, turnNote: [purchasesNote(C)] });
  assert.match(forModel.content, /CANCELLED by the shop/);
  assert.doesNotMatch(forHistory.content, /PURCHASES ON RECORD/);
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js", "../src/calls/voice.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /[pP]urchasesNote\(conversationId\b/, `${file} must put the purchase record in front of the model`);
  }
});

// ---------- small ----------

test("empty: buying in play but nothing on record — no block", async () => {
  ledger("offer_check", HOUR);
  assert.equal(shoppingMoment(C), "buying_tool_ran");
  assert.equal(purchasesNote(C), "");
  // Browsing that never got a cart is not a purchase (and is what switched it on).
  db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "conv_browse", status: "shopping" });
  assert.equal(purchasesNote(C), "");
  assert.doesNotMatch(await cliTurn("find me a target lotion"), /PURCHASES/);
});

test("the window: older than 14 days is gone, unless it changed since", () => {
  purchase({ buy: "conv_old", status: "placed", merchant: "Target", what: "old lamp", at: clock.now() - 20 * DAY });
  ledger("purchase", HOUR);
  assert.equal(purchasesNote(C), "");
  // Placed three weeks ago and cancelled today: today's news, so it is shown.
  db.markAgentcardPurchase("conv_old", { status: "cancelled" });
  assert.match(purchasesNote(C), /Target · old lamp · \$16\.76 · CANCELLED/);
});

test("the cap: at most five, newest first", () => {
  for (let i = 0; i < 8; i++) purchase({ buy: `conv_${i}`, status: "placed", what: `thing ${i}`, at: clock.now() - (8 - i) * HOUR });
  const lines = purchasesNote(C).split("\n").slice(1);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /thing 7/);
  assert.match(lines[4], /thing 3/);
  assert.doesNotMatch(purchasesNote(C), /thing 2\b/);
});

test("tiny: the incident's block stays a few hundred characters, and a long item name is cut", () => {
  theMorning();
  const note = purchasesNote(C);
  assert.ok(note.length < 600, `${note.length} chars`);
  assert.ok(note.split("\n")[1].length < 140);
});

test("every status reads in plain words", () => {
  assert.equal(statusWords("placed"), "placed");
  assert.match(statusWords("cancelled"), /CANCELLED/);
  assert.match(statusWords("declined"), /not bought/);
  assert.match(statusWords("failed"), /not bought/);
  assert.match(statusWords("awaiting_approval"), /pending.*not charged/);
  assert.match(statusWords("outcome_unknown"), /pending/);
  assert.match(statusWords("cart_shown"), /not bought/);
  assert.match(statusWords("partially_placed"), /partly/);
});

// ---------- the meaning gate (2026-10-24, after #94) ----------
//
// The block rides only on a message that is ABOUT buying, read by one small side call — stubbed here,
// the live lane in test/flow-purchases-topic.test.js asks the real model. What is tested is the
// wiring: the call is made only when there is something to show, the answer switches the block,
// and a check that fails falls back to #94's structural signals.

/** A stub for the side call that answers `about` and remembers what it was asked. */
function reader(about) {
  const asked = [];
  setTopicReader(async (q) => { asked.push(q); return typeof about === "function" ? about(q) : { about }; });
  return asked;
}

/** An API-path turn with the model stubbed: what it was handed (tools and the turn's message). */
async function apiTurn(text) {
  let params;
  agent.model.create = async (p) => {
    params = params ?? structuredClone({ messages: p.messages, tools: p.tools }); // the thread is rewritten after the turn
    return { id: "m1", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  };
  try {
    await agent.runTurn({ conversationId: C, text, images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }), capture: async () => ({ ok: false }) });
  } finally { agent.model.create = realCreate; }
  const last = params.messages.findLast(m => m.role === "user");
  const body = typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  return { tools: params.tools.map(t => t.name), body };
}

test("pinned: off-topic ('what's the weather') with purchases on record and the check saying no — no block, on both backends", async () => {
  theMorning();
  assert.equal(shoppingMoment(C), "purchase_row_changed", "the structural signal alone would have shown it");
  const asked = reader(false);
  assert.doesNotMatch(await cliTurn("what's the weather"), /PURCHASES/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].text, "what's the weather");
  theMorning();
  const api = await apiTurn("what's the weather");
  assert.doesNotMatch(api.body, /PURCHASES/);
  assert.equal(asked.length, 2);
});

test("pinned 2026-10-24: the incident message, check says yes — the block shows the cancelled order", async () => {
  theMorning();
  const asked = reader(true);
  const prompt = await cliTurn(ASK);
  assert.match(prompt, /PURCHASES ON RECORD/);
  assert.match(prompt, /Walmart · Cerave PM .* · \$16\.76 · CANCELLED by the shop, not coming/);
  assert.equal(asked[0].text, ASK);
  assert.equal(asked[0].previous, "done, the cerave's ordered from walmart. $16.76", "shown Reason's last message");
  theMorning();
  assert.match((await apiTurn(ASK)).body, /CANCELLED by the shop, not coming/);
});

test("pinned: 'any updates on the order?' — yes, and the block rides", async () => {
  // Five days old and nothing moved since: no structural signal, so only the meaning switches it on.
  purchase({ buy: "conv_old", status: "placed", merchant: "Amazon", what: "phone charger", at: clock.now() - 5 * DAY });
  assert.equal(shoppingMoment(C), "");
  const asked = reader(true);
  const prompt = await cliTurn("any updates on the order?");
  assert.match(prompt, /PURCHASES ON RECORD[^]*Amazon · phone charger · \$16\.76 · placed/);
  assert.equal(asked.length, 1);
});

test("pinned: the check timing out or failing falls back to the structural signals", async () => {
  const saved = config.purchaseTopicTimeoutMs;
  config.purchaseTopicTimeoutMs = 40;
  try {
    // Timeout, incident state (a row changed 9 minutes ago): the block still shows.
    theMorning();
    let aborted = false;
    setTopicReader(({ signal }) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }));
    const logs = [];
    const note = await startPurchasesNote(C, { text: ASK, log: (x) => logs.push(x) });
    assert.match(note, /CANCELLED by the shop/);
    assert.ok(aborted, "the hung request is aborted, not left running");
    assert.match(logs.find(x => x.purchases_topic_failed).purchases_topic_failed, /timeout after 40ms/);
    assert.equal(logs.find(x => x.purchases_topic === "structural").why, "check_failed");
    const t0 = Date.now();
    assert.match(await cliTurn(ASK), /CANCELLED by the shop/);
    assert.ok(Date.now() - t0 < 2_000, "the timeout is hard");

    // An error, incident state: the block still shows.
    setTopicReader(async () => { throw new Error("529 overloaded"); });
    assert.match(await cliTurn(ASK), /CANCELLED by the shop/);
    // An answer that is neither: the same.
    setTopicReader(async () => ({ about: "maybe" }));
    assert.match(await startPurchasesNote(C, { text: ASK }), /CANCELLED/);

    // An error with no structural signal (bought 5 days ago, nothing since): no block, as in #94.
    db.db.exec("DELETE FROM agentcard_purchases");
    purchase({ buy: "conv_old", status: "placed", merchant: "Amazon", what: "phone charger", at: clock.now() - 5 * DAY });
    setTopicReader(async () => { throw new Error("boom"); });
    assert.equal(await startPurchasesNote(C, { text: "what's the weather" }), "");
  } finally { config.purchaseTopicTimeoutMs = saved; }
});

test("pinned: no purchase rows — the check is never called", async () => {
  const asked = reader(true);
  ledger("offer_check", HOUR); // a shopping flow, but nothing on record
  db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "conv_browse", status: "shopping" }); // cartless: not shown
  purchase({ buy: "conv_lamp", status: "placed", what: "desk lamp", at: clock.now() - 20 * DAY }); // outside the window
  assert.doesNotMatch(await cliTurn("any updates on the order?"), /PURCHASES/);
  assert.doesNotMatch((await apiTurn("any updates on the order?")).body, /PURCHASES/);
  assert.equal(await startPurchasesNote(C, { text: ASK }), "");
  assert.equal(asked.length, 0);
});

test("pinned: purchases_recent is in the tool list on a turn whose block is off", async () => {
  theMorning();
  reader(false);
  const api = await apiTurn("what's the weather");
  assert.doesNotMatch(api.body, /PURCHASES/);
  assert.ok(api.tools.includes("purchases_recent"), "the model can still look it up itself");
  assert.ok(toolsFor(C).some(t => t.name === "purchases_recent"));
  assert.match(toolsFor(C).find(t => t.name === "purchases_recent").description, /Check this before you say whether anything was ordered/);
});

test("the check runs alongside context building, not in front of it", async () => {
  theMorning();
  const order = [];
  setTopicReader(async () => { order.push("check started"); await new Promise(r => setTimeout(r, 30)); order.push("check done"); return { about: true }; });
  const images = async () => { order.push("images started"); await new Promise(r => setTimeout(r, 30)); order.push("images done"); return { blocks: [], notes: [], seen: [], viewedMediaIds: [] }; };
  assert.match(await cliTurn(ASK, { images }), /CANCELLED/);
  assert.ok(order.indexOf("check started") < order.indexOf("images done"), order.join(" > "));
});

test("an event turn is not a message: no side call, the structural signals decide", async () => {
  theMorning();
  const asked = reader(false);
  assert.match(await startPurchasesNote(C, { text: "timer fired", kind: "event" }), /CANCELLED/);
  assert.equal(asked.length, 0);
});

test("with no API key and no stub there is no side call: the structural signals decide", async () => {
  theMorning();
  setTopicReader(null);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const logs = [];
    assert.match(await startPurchasesNote(C, { text: "what's the weather", log: (x) => logs.push(x) }), /CANCELLED/);
    assert.equal(logs.find(x => x.purchases_topic).why, "no_api_key");
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});

test("what the check is shown: Reason's last message (a snippet) and the new message", () => {
  const msgs = [
    { role: "user", content: "[x] Omari: get the cerave" },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "purchase", input: {} }, { type: "text", text: "done, it's   ordered." }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "{}" }] },
    { role: "assistant", content: "NO_REPLY" },
  ];
  assert.equal(previousAssistant(msgs), "done, it's ordered.");
  assert.equal(previousAssistant([{ role: "assistant", content: "x".repeat(500) }]).length, 300);
  assert.equal(previousAssistant([]), "");
  const prompt = topicPrompt({ text: "any update?", previous: "done, it's ordered." });
  assert.match(prompt, /last message, for context:\ndone, it's ordered\.[^]*The new message, verbatim:\nany update\?$/);
  assert.equal(topicPrompt({ text: "hi" }), "The new message, verbatim:\nhi");
});


// ---------- the reply check reads the purchase record (2026-10-24) ----------
//
// Live logged dollar_unsourced twice on the owner's thread for "$16.76" — the total on his own
// Walmart rows — and once on a local instance a correct order reply went out as "($18.99
// (unverified))". The record is code-written from AgentCard's own cart, so its amounts are sourced,
// exactly like a verified offer or a cart read this turn. Anything else stays strict.

const offers = await import("../src/offers.js");
const { purchaseRecordSource } = await import("../src/purchasesnote.js");

/** An API-path turn whose model says `reply`: what was sent (the guarded reply). */
async function apiReply(text, reply) {
  agent.model.create = async () => ({ id: "m1", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  try {
    return await agent.runTurn({ conversationId: C, text, images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }), capture: async () => ({ ok: false }) });
  } finally { agent.model.create = realCreate; }
}
/** A CLI turn (the live backend) whose CLI says `reply`: the last thing kept in the thread. */
async function cliReply(text, reply) {
  await runTurnViaCli({
    conversationId: C, text,
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    recall: async () => [],
    run: async () => ({ ok: true, envelope: { result: reply } }),
  });
  const last = db.loadConversation(C).findLast(m => m.role === "assistant");
  return typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("");
}
/** No "(" opened inside another, anywhere. */
const nested = (s) => { let d = 0; for (const ch of s) { if (ch === "(") { if (d > 0) return true; d++; } else if (ch === ")") d = Math.max(0, d - 1); } return false; };

test("pinned 2026-10-24: an order reply quoting the purchase-row amount is not flagged, on both backends", async () => {
  theMorning();
  // The block is OFF (the check says no): the row alone has to vouch for the figure.
  reader(false);
  const said = "your walmart order for the cerave ($16.76) was cancelled — the store couldn't use the address. want me to try again?";
  assert.equal(await apiReply("what happened with my order", said), said);
  theMorning();
  assert.equal(await cliReply("what happened with my order", said), said);
  // Item price and fee lines on the cart the row was built from count too.
  db.markAgentcardPurchase("conv_3137fea70f6bcc5aca754052", { cartJson: JSON.stringify({ items: [{ price_cents: 1497 }], fee_lines: [{ amount_cents: 100 }, { amount_cents: 79 }], total_cents: 1676, ceiling_cents: 2612 }) });
  offers.beginTurn(C, "why was it that much");
  const parts = "it was $14.97 for the lotion plus a $1.00 order fee and $0.79 card processing, $16.76 all in";
  assert.equal(offers.guardReply(C, parts, { extraSources: [purchaseRecordSource(C)] }).changed, false);
  // The local instance's "($18.99)" — a row amount in brackets — stays exactly as written.
  purchase({ buy: "conv_local", status: "placed", cents: 1899, merchant: "Target", what: "desk lamp" });
  offers.beginTurn(C, "did the lamp go through");
  const lamp = "yep, the desk lamp from target ($18.99) is placed";
  const g = offers.guardReply(C, lamp, { extraSources: [purchaseRecordSource(C)] });
  assert.equal(g.text, lamp);
  assert.deepEqual(g.flags, []);
  // Someone else's record vouches for nothing on theirs.
  assert.equal(purchaseRecordSource(OTHER), "");
});

test("pinned 2026-10-24: the purchases block, when it rides, is a source for the reply", async () => {
  theMorning();
  reader(true);
  db.db.exec("UPDATE agentcard_purchases SET amount_cents = 1676"); // as on live
  const said = "the walmart one ($16.76) got cancelled, so nothing's coming";
  assert.equal(await cliReply("did my cerave ship", said), said);
});

test("pinned 2026-10-24: an amount from purchases_recent this turn is not flagged", async () => {
  theMorning();
  offers.beginTurn(C, "did anything go through");
  const out = await runTool("purchases_recent", {}, { conversationId: C, messages: [] });
  assert.equal(out.purchases[0].amount, "$16.76");
  // No extraSources here: the tool's own output, noted by runTool, is what vouches for it.
  const g = offers.guardReply(C, "nothing went through — the walmart cerave ($16.76) was cancelled");
  assert.equal(g.changed, false, JSON.stringify(g));
});

test("pinned 2026-10-24: an invented price is still flagged, with the record in play", async () => {
  theMorning();
  reader(true);
  const sent = await apiReply("is target cheaper", "target has it for $12.49, cheaper than the walmart one at $16.76");
  assert.equal(sent, "target has it for $12.49 (unverified), cheaper than the walmart one at $16.76");
  theMorning();
  const cli = await cliReply("is target cheaper", "target has it for $12.49");
  assert.equal(cli, "target has it for $12.49 (unverified)");
  offers.beginTurn(C, "");
  const g = offers.guardReply(C, "shipping would be $5.99", { extraSources: [purchaseRecordSource(C)] });
  assert.deepEqual(g.flags, [{ rule: "dollar_unsourced", figures: ["$5.99"] }]);
});

test("pinned 2026-10-24: no nested '(unverified)' parentheses, whatever the figure sits in", () => {
  offers.beginTurn("c-paren", "");
  const cases = [
    ["the lamp ($18.99) is placed", "the lamp ($18.99, unverified) is placed"],
    ["about ($5–$7) for shipping", "about ($5, unverified–$7, unverified) for shipping"],
    ["(was $3, now $4)", "(was $3, unverified, now $4, unverified)"],
    ["it's $9.99 :) and the other ($2)", "it's $9.99 (unverified) :) and the other ($2, unverified)"],
    ["(see above)\nshipping is $5.99", "(see above)\nshipping is $5.99 (unverified)"],
    ["$4 (ish)", "$4 (unverified) (ish)"],
  ];
  for (const [reply, want] of cases) {
    const g = offers.guardReply("c-paren", reply);
    assert.equal(g.text, want, reply);
    assert.equal(nested(g.text), false, g.text);
    assert.doesNotMatch(g.text, /\(unverified\)\)/);
  }
  assert.doesNotMatch(offers.guardReply("c-paren", "($18.99)").text, /\(\$18\.99 \(unverified\)\)/);
});

test("pinned 2026-10-24: a vault_enroll that did nothing (AgentCard not set up) does not turn the block on", async () => {
  const saved = config.agentcardClientId;
  config.agentcardClientId = "";
  try {
    // Bought five days ago, nothing since: the block is off.
    purchase({ buy: "conv_old", status: "placed", merchant: "Amazon", what: "phone charger", at: clock.now() - 5 * DAY });
    assert.equal(shoppingMoment(C), "");
    const out = await runTool("vault_enroll", {}, { conversationId: C, messages: [] });
    assert.equal(out.status, "not_configured", JSON.stringify(out));
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM action_ledger WHERE action = 'vault_enroll'").get().n, 0, "nothing happened, so no receipt");
    assert.equal(shoppingMoment(C), "");
    assert.equal(purchasesNote(C), "");
    // A row written before this fix is not counted either; a real buying tool still is.
    db.recordAction({ conversationId: C, action: "vault_enroll", attempted: {}, outcome: "error", result: { ok: false, status: "not_configured" }, receipt: "vault_enroll" });
    assert.equal(shoppingMoment(C), "");
    ledger("purchase", HOUR);
    assert.equal(shoppingMoment(C), "buying_tool_ran");
  } finally { config.agentcardClientId = saved; }
});

test("pinned 2026-10-24: purchase_track answers from the local row when AgentCard isn't configured", async () => {
  const saved = config.agentcardClientId;
  config.agentcardClientId = "";
  try {
    theMorning();
    db.noteAgentcardCancelReason("conv_3137fea70f6bcc5aca754052", { code: "invalid_shipping_address", detail: "The store could not use this shipping address." });
    for (const input of [{ conversation_id: "conv_3137fea70f6bcc5aca754052" }, { order_id: "e66d7f2b" }]) {
      const t = await runTool("purchase_track", input, { conversationId: C, messages: [] });
      assert.equal(t.ok, true, JSON.stringify(t));
      assert.notEqual(t.status, "not_configured");
      assert.equal(t.status, "cancelled");
      assert.equal(t.cancelled, true);
      assert.equal(t.amount, "$16.76");
      assert.equal(t.read_from, "local_record");
      assert.equal(t.live_check, "not_configured");
      assert.match(t.note, /^Reason's record: .* was CANCELLED — reason: the store couldn't use the shipping address/);
      assert.match(t.note, /side note, after the answer: AgentCard isn't set up on this install/);
    }
    // No row: "not set up" is still the answer; somebody else's order is still not theirs.
    const none = await runTool("purchase_track", { order_id: "nope" }, { conversationId: C, messages: [] });
    assert.equal(none.status, "not_configured");
    const theirs = await runTool("purchase_track", { order_id: "e66d7f2b" }, { conversationId: OTHER, messages: [] });
    assert.equal(theirs.blocked, "not_theirs");
  } finally { config.agentcardClientId = saved; }
});


// ---------- the meaning gate's own reply (2026-10-24) ----------
//
// "the check answered \"\"" 13 times out of 16 live answers: max_tokens was 3, and a reply that
// opened with a newline or markdown spent all three before the word. Room for the word, and the
// word read out of whatever it is wrapped in.

test("pinned: the purchase-topic ask has room for its answer and reads yes/no out of any wrapping", async () => {
  const { askTopicApi, readYesNo, TOPIC_MAX_TOKENS } = await import("../src/purchasesnote.js");
  assert.ok(TOPIC_MAX_TOKENS >= 16, `max_tokens ${TOPIC_MAX_TOKENS} leaves no room`);
  for (const [said, want] of [["yes", true], ["Yes.", true], ["\n\nyes", true], ["**No**", false], ["Answer: no", false], ["no\n\n", false], ["", null], ["\n\n", null], ["maybe", null], ["nothing", null], ["yesterday", null]]) {
    assert.equal(readYesNo(said), want, JSON.stringify(said));
  }
  const asked = [];
  const client = (text, stop = "end_turn") => ({ messages: { create: async (body) => { asked.push(body); return { content: [{ type: "text", text }], stop_reason: stop, usage: {} }; } } });
  assert.equal((await askTopicApi({ text: "did it ship?", client: client("\n\nYes") })).about, true);
  assert.equal(asked[0].max_tokens, TOPIC_MAX_TOKENS);
  assert.equal((await askTopicApi({ text: "weather?", client: client("**no**") })).about, false);
  await assert.rejects(askTopicApi({ text: "hm", client: client("\n\n", "max_tokens") }), /answered "" \(stop: max_tokens\)/);
});
