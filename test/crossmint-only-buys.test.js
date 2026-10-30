// Crossmint is the only way to buy where it is on (src/shoptools.js AGENTCARD_BUY_TOOLS).
//
// 2026-10-30: the owner asked for a CeraVe cleanser from Walmart and Reason built an AgentCard cart
// (purchase → purchase_confirm → passkey link), because both flows were offered side by side. His
// decision: every buy goes through Crossmint. These pin it: the owner's model is shown
// store_checkout and shop_card and no AgentCard buying, card or flight-booking tool, no description it
// reads names AgentCard, a named AgentCard tool is refused, and everybody else keeps today's tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cm-only-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.REASON_FLIGHT_BOOKING = "on";
process.env.AGENTCARD_CLIENT_ID = "ac_test";
process.env.AGENTCARD_CLIENT_SECRET = "acs_test";
process.env.REASON_SITE_URL = "https://heyreason.test";

const { tools, toolsFor, runTool, runReleasedAction, capabilitiesNow } = await import("../src/tools.js");
const { mcpToolsFor } = await import("../src/backends/mcp-core.js");
const { AGENTCARD_BUY_TOOLS } = await import("../src/shoptools.js");
const { startPurchasesNote } = await import("../src/purchasesnote.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const names = (c) => toolsFor(c).map((t) => t.name);
const OLD_WORDS = /AgentCard|vault_enroll|purchase_confirm|purchase_track|purchases_recent|flight_book|finishes the purchase themselves|offer_id to purchase/;

test("the owner is shown store_checkout and shop_card, and no AgentCard buying, card or flight-booking tool", () => {
  const mine = names(OMARI);
  for (const n of ["store_checkout", "shop_pay", "shop_decline", "shop_card"]) assert.ok(mine.includes(n), n);
  for (const n of AGENTCARD_BUY_TOOLS) assert.ok(!mine.includes(n), n);
  // The flight search still hands over its Google Flights link, and never offers booking.
  const search = toolsFor(OMARI).find((t) => t.name === "flight_search");
  assert.match(search.description, /SEARCH ONLY/);
});

test("nothing the owner's model reads names AgentCard or sends buying anywhere but store_checkout", () => {
  for (const t of toolsFor(OMARI)) assert.doesNotMatch(t.description, OLD_WORDS, t.name);
  for (const t of mcpToolsFor(OMARI)) assert.doesNotMatch(t.description, OLD_WORDS, t.name);
  const offer = toolsFor(OMARI).find((t) => t.name === "offer_check");
  assert.match(offer.description, /store_checkout/);
  const findAll = mcpToolsFor(OMARI).find((t) => t.name === "find_all");
  assert.match(findAll.description, /store_checkout does the checkout/);
});

test("an AgentCard tool named anyway is refused, and nothing reaches AgentCard", async () => {
  for (const [name, input] of [["purchase", { ask: "cerave cleanser from walmart" }], ["vault_enroll", {}], ["purchase_confirm", { conversation_id: "conv_x", cart_hash: "abc", confirmation_id: 1 }], ["flight_book", { search_id: 1, option: 1, traveler_ids: [1] }]]) {
    const out = await runTool(name, input, { conversationId: OMARI });
    assert.equal(out.blocked, "not_available", name);
    assert.match(out.error, /store_checkout/);
    assert.doesNotMatch(out.error, /AgentCard/);
  }
});

test("a held AgentCard confirm released later is refused too", async () => {
  const out = await runReleasedAction({ conversation_id: OMARI, action: "purchase_confirm", input: { conversation_id: "conv_x", cart_hash: "abc" }, confirmation_id: 1 });
  assert.equal(out.blocked, "not_available");
});

test("everybody else keeps today's tools and today's words exactly", () => {
  const theirs = names(AMA);
  for (const n of ["purchase", "purchase_confirm", "vault_enroll", "purchase_track", "purchases_recent", "flight_book"]) assert.ok(theirs.includes(n), n);
  for (const n of ["store_checkout", "shop_pay", "shop_decline", "shop_card"]) assert.ok(!theirs.includes(n), n);
  const base = new Map(tools.map((t) => [t.name, t.description]));
  for (const t of toolsFor(AMA)) if (t.name !== "flight_search") assert.equal(t.description, base.get(t.name), t.name);
  assert.match(toolsFor(AMA).find((t) => t.name === "flight_search").description, /flight_book/);
});

test("with the switch off the owner is back on AgentCard, unchanged", () => {
  process.env.REASON_SHOP_CONNECT = "off";
  try {
    const mine = names(OMARI);
    assert.ok(mine.includes("purchase") && mine.includes("vault_enroll") && mine.includes("flight_book"));
    assert.ok(!mine.includes("store_checkout") && !mine.includes("shop_card"));
  } finally { process.env.REASON_SHOP_CONNECT = "owner"; }
});

test("'add a card' is Crossmint's: shop_card says the saved card and mints a link only when asked", async () => {
  db.db.exec("DELETE FROM shop_cards");
  const none = await runTool("shop_card", {}, { conversationId: OMARI });
  assert.equal(none.card, null);
  assert.match(none.url, /^https:\/\/heyreason\.test\/web\/connect\/[A-Za-z0-9_-]{20,}$/);
  db.db.prepare("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'mastercard', '1929', ?)").run(OMARI, clock.now());
  const has = await runTool("shop_card", {}, { conversationId: OMARI });
  assert.equal(has.card, "Mastercard ••••1929");
  assert.equal(has.url, undefined);
  const change = await runTool("shop_card", { send_link: true }, { conversationId: OMARI });
  assert.ok(change.url);
  const cap = capabilitiesNow({ conversationId: OMARI }).find((c) => c.name === "buy_things");
  assert.equal(cap.status, "live");
  assert.match(cap.what, /store_checkout/);
  assert.doesNotMatch(cap.what, /AgentCard|vault_enroll|passkey/);
  assert.equal((await runTool("shop_card", {}, { conversationId: AMA })).ok, false);
});

test("old AgentCard rows read as the retired checkout for the owner, and as before for everybody else", async () => {
  const now = clock.now();
  const put = db.db.prepare("INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, amount_cents, merchant, what, decline_code, created_at, updated_at) VALUES (?, ?, 'declined', 1779, 'Walmart', 'CeraVe Foaming Cleanser', ?, ?, ?)");
  put.run(OMARI, "conv_owner_1", "retired_moved_to_crossmint", now, now);
  put.run(AMA, "conv_ama_1", "items_unavailable", now, now);
  const mine = await startPurchasesNote(OMARI, { text: "did the cerave go through?", now });
  assert.match(mine, /CeraVe/);
  assert.match(mine, /nothing was ordered or charged/);
  assert.match(mine, /store_checkout/);
  assert.doesNotMatch(mine, /AgentCard|purchase_track/);
  const theirs = await startPurchasesNote(AMA, { text: "did it go through?", now });
  assert.match(theirs, /PURCHASES ON RECORD \(AgentCard/);
  assert.doesNotMatch(theirs, /store_checkout/);
});
