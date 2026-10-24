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
const { purchasesNote, shoppingMoment, statusWords } = await import("../src/purchasesnote.js");
const { userMessageFor } = await import("../src/agent.js");
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

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
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
async function cliTurn(text) {
  let prompt;
  await runTurnViaCli({
    conversationId: C, text,
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
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
    assert.match(src, /purchasesNote\(conversationId\b/, `${file} must put the purchase record in front of the model`);
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
