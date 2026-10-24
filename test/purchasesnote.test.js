// What Reason has really bought rides on every turn, from the database, and beats the thread.
//
// The incident (2026-10-24): Reason texted the owner "the cerave's ordered" (Walmart order e66d7f2b…,
// buy conversation conv_3137fea70f6bcc5aca754052). AgentCard cancelled it minutes later; #92 moved
// the row to cancelled and that one cancellation was deliberately never texted (cancel_told_at). At
// 13:45Z the owner asked whether Target had the lotion and Reason said "the Walmart order already
// went through this morning, so this would be a second bottle" — believing its own old line, with no
// tool called, because nothing about purchases was in the turn's context.
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
const { purchasesNote, statusWords } = await import("../src/purchasesnote.js");
const { userMessageFor } = await import("../src/agent.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");

const C = "dm:owner";
const OTHER = "dm:fake:+13475550000";
const DAY = 86_400_000;
/** The clock only moves by offsets; this puts it at a moment. */
const setClock = (ms) => { clock.reset(); clock.skip(ms - clock.now()); };
const CERAVE = "Cerave PM Niacinamide & Hyaluronic Acid Facial Moisturizer For All Skin Types 3 oz";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  setClock(Date.parse("2026-10-24T13:45:00Z"));
  db.db.exec("DELETE FROM agentcard_purchases; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

/** A purchase row as the tools leave it, then moved where it got to. */
function purchase({ conv = C, buy, status, cartHash = "h_1", cents = 1676, merchant = "Walmart", what = CERAVE, at = clock.now() }) {
  const now = clock.now();
  setClock(at);
  db.recordAgentcardPurchase({ conversationId: conv, buyConversationId: buy, status: "cart_shown", cartHash, amountCents: cents, merchant, what });
  db.markAgentcardPurchase(buy, { status });
  setClock(now);
  return db.getAgentcardPurchase(buy);
}

/** The 2026-10-24 morning as the database has it now: the declined try, then the order AgentCard cancelled. */
function theMorning() {
  db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "conv_88aafaa", status: "shopping" }); // browsing, no cart
  purchase({ buy: "conv_70255fa", status: "declined", at: Date.parse("2026-10-24T03:57:55Z") });
  purchase({ buy: "conv_3137fea70f6bcc5aca754052", status: "placed", at: Date.parse("2026-10-24T12:58:05Z") });
  db.markAgentcardPurchase("conv_3137fea70f6bcc5aca754052", { orderId: "e66d7f2b", orderState: "cancelled", status: "cancelled" });
  db.claimAgentcardCancelNotice("conv_3137fea70f6bcc5aca754052"); // the text that was deliberately never sent
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

test("pinned 2026-10-24: the thread says ordered, the row says cancelled — the turn is shown cancelled", async () => {
  theMorning();
  // What the thread holds: Reason's own word that it was ordered.
  db.saveConversation(C, [
    { role: "user", content: "[Sat, Oct 24, 2026, 8:57 AM] Omari: yeah get it" },
    { role: "assistant", content: "done, the cerave's ordered from walmart. $16.76" },
  ]);

  const note = purchasesNote(C);
  const lines = note.split("\n").slice(1);
  assert.equal(lines.length, 2, "the cancelled order and the declined try; the cartless browse is left out");
  assert.match(lines[0], /^- Oct 24 · Walmart · Cerave PM Niacinamide .* · \$16\.76 · CANCELLED by the shop, not coming$/);
  assert.match(lines[1], /declined, not bought$/);
  assert.doesNotMatch(note, /· placed\b/, "nothing on the record is placed");
  assert.match(note, /current state and overrides anything said earlier in the chat, including your own messages/);
  assert.doesNotMatch(note, /conv_|e66d7f2b|h_1/, "no ids the model has no use for");

  // On the backend the live Reason runs on, it is in the very prompt that carries the old "ordered".
  const prompt = await cliTurn("does target have the cerave lotion");
  assert.match(prompt, /the cerave's ordered/, "the stale claim is still in the thread...");
  assert.match(prompt, /CANCELLED by the shop, not coming/, "...and the record that overrides it is right there");
  assert.ok(prompt.indexOf("PURCHASES ON RECORD") > prompt.indexOf("The new message:"), "after the history, beside the message it bears on");
  // And never saved into the thread, where it would go stale itself.
  assert.doesNotMatch(JSON.stringify(db.loadConversation(C)), /PURCHASES ON RECORD/);
});

test("API path: the block goes to the model and not into the thread", () => {
  theMorning();
  const { forModel, forHistory } = userMessageFor({ prefix: "[Sat, Oct 24, 2026, 9:45 AM] Omari:", text: "does target have it", turnNote: [purchasesNote(C)] });
  assert.match(forModel.content, /CANCELLED by the shop/);
  assert.doesNotMatch(forHistory.content, /PURCHASES ON RECORD/);
});

test("every backend reads it, including the phone", () => {
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js", "../src/calls/voice.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /purchasesNote\(conversationId\)/, `${file} must put the purchase record in front of the model`);
  }
});

test("empty: no purchases, no block — an ordinary turn carries nothing", async () => {
  assert.equal(purchasesNote(C), "");
  // Browsing that never got a cart is not a purchase.
  db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "conv_browse", status: "shopping" });
  assert.equal(purchasesNote(C), "");
  // Somebody else's purchase is not theirs.
  purchase({ conv: OTHER, buy: "conv_ama", status: "placed" });
  assert.equal(purchasesNote(C), "");
  const prompt = await cliTurn("hey");
  assert.doesNotMatch(prompt, /PURCHASES/);
});

test("the window: older than 14 days is gone, unless it changed since", () => {
  purchase({ buy: "conv_old", status: "placed", merchant: "Target", what: "old lamp", at: clock.now() - 20 * DAY });
  assert.equal(purchasesNote(C), "");
  // Placed three weeks ago and cancelled today: today's news, so it is shown.
  db.markAgentcardPurchase("conv_old", { status: "cancelled" });
  assert.match(purchasesNote(C), /Target · old lamp · \$16\.76 · CANCELLED/);
});

test("the cap: at most five, newest first", () => {
  for (let i = 0; i < 8; i++) purchase({ buy: `conv_${i}`, status: "placed", what: `thing ${i}`, at: clock.now() - (8 - i) * 3600_000 });
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
