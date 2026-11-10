// Food ordering (src/food.js, REASON_FOOD), owner spec 2026-11-10 (~/Desktop/reason-food-1110/spec.txt).
// The money rules first, each against the real checkout path (src/shopconnect.js step, the shop_pay gate):
//   1. the approval is ONE card picture then ONE line on Crossmint's exact total: "$31.42 to your Visa 4821, here by 8:15. Place it?"
//   2. an allergy or diet flag sits in that line BEFORE the question; a check that cannot run says so;
//   3. a changed total is a fresh card and a fresh ask, and a yes to the old total cannot pay the new one;
//   4. silence is not a yes; past the 15-minute hold no yes pays, the cart is let go with one line;
//   5. never the full card number, on the card, in the line, or from the model's own words;
// then the rest of the flow: the placed text (address, no order number), status tapbacks on THEIR
// request message (never someone else's), no silent move to another restaurant, the flag off.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-food-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.REASON_FOOD = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
await shop.foodReady;
const food = await import("../src/food.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { systemFor } = await import("../src/agent.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const STORE = "https://www.doordash.com/store/habibi-halal-bronx-123/";

// ---------------------------------------------------------------- a fake Crossmint, a fake line
let calls, runs, nextRun;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: u.pathname, body });
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1 };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages|\/cancel)?$/.exec(p);
  if (m && m[2]) return reply(202, { ok: true });
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { message: "not found" });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  if (/^\/api\/unstable\/order-intents\/[^/]+$/.test(p)) return reply(200, { orderIntentId: decodeURIComponent(p.split("/").pop()), status: "active", rails: [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] });
  return reply(404, { message: "no route" });
}
const PAY = (requestId, value) => ({
  requestId, request: {
    question: `Please approve a card payment of $${value} to DoorDash.`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
    interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "DoorDash", countryCode: "US", url: "https://www.doordash.com/" } },
  },
});
const intents = () => calls.filter((c) => c.path === "/api/unstable/order-intents" && c.method === "POST").length;

const said = [], pictures = [], reacts = [], woke = [];
const line = { name: "fake", status: () => ({ status: "live", number: "+15550000000" }), react: async ({ messageHandle, reaction }) => { reacts.push({ messageHandle, reaction }); return { ok: true, supported: true, reaction }; } };
const channels = { get: (n) => (n === "fake" ? line : null) };
const q = (sql) => db.db.prepare(sql);
const fakeShoot = async (html) => Buffer.from(`JPEG:${html.length}`);
let lastHtml = "";

before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: () => {}, picture: async (c, file) => pictures.push({ c, file, at: said.length }), base: "https://heyreason.test/web/connect" });
  food._attach({ say: (c, t) => said.push({ c, t }), wake: async (c, t, o) => woke.push({ c, t, key: o?.key }), channels: () => channels });
  food._setShoot(async (html, opts) => { lastHtml = html; return fakeShoot(html, opts); });
  db.upsertAccount({ conversationId: OMARI, channel: "fake", address: "+15551110000", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; said.length = 0; pictures.length = 0; reacts.length = 0; woke.length = 0; lastHtml = ""; clock.reset();
  food._setAllergyAsk(async () => ({ value: { constraints: [], conflicts: [] } }));
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "spend", "food_orders", "food_notes", "confirmations"]) { try { db.db.exec(`DELETE FROM ${t}`); } catch { /* table made later */ } }
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_secret_4821', 'visa', '4821', ?, 1)").run(OMARI, clock.now());
  // Signed in to DoorDash already, so the checkout starts in their profile.
  q("INSERT OR REPLACE INTO shop_profiles (conversation_id, profile_id, created_at) VALUES (?, 'prof_1', ?)").run(OMARI, clock.now());
  try { shop.markConnected(OMARI, "doordash"); } catch { /* fine */ }
  db.upsertThread({ conversationId: OMARI, channel: "fake", address: "+15551110000", isOwner: true, service: "iMessage", lastInboundId: "H-req" });
  db.claimInbound({ channel: "fake", externalId: "H-req", conversationId: OMARI, text: "get me habibi, the usual" });
});

const CART = {
  platform: "doordash", restaurant: "Habibi Halal", store_url: STORE,
  items: [{ name: "Chicken over rice", qty: 1, modifiers: ["white sauce", "no hot sauce"], price: "14.99" }, { name: "Fries", qty: 1, price: "4.50" }],
  fees: [{ label: "Subtotal", amount: "19.49" }, { label: "Delivery fee", amount: "2.99" }, { label: "Service fee", amount: "3.12" }, { label: "Tax", amount: "1.82" }],
  tip: "4.00", total: "31.42", address: "3247 Bruner Ave, Apt 1", address_label: "Home", eta: "7:55–8:15",
  eta_latest: "2026-11-11T01:15:00Z", // 8:15 PM in New York
};
/** start → cart → store_checkout (linked) → the run reaches payment for `value`. */
async function toPayment(value = "31.42", cart = CART) {
  const st = await runTool("food_order", { action: "start" }, { conversationId: OMARI });
  assert.equal(st.ok, true, JSON.stringify(st));
  const ct = await runTool("food_order", { action: "cart", order_id: st.order_id, ...cart }, { conversationId: OMARI });
  assert.equal(ct.ok, true, JSON.stringify(ct));
  const out = await shop.startCheckout({ conversationId: OMARI, store: "doordash", startUrl: STORE, what: "Chicken over rice (white sauce, no hot sauce), fries. Uncheck extras. No utensils. Tip $4. Stop at payment.", item: "Habibi Halal order", maxUsd: 60 });
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(food.linkRun(OMARI, st.order_id, out.runId), true);
  runs[out.runId].requiredAction = PAY("req_1", value); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  return { orderId: st.order_id, runId: out.runId, pay: q("SELECT * FROM shop_payments WHERE run_id = ? ORDER BY id DESC").get(out.runId) };
}
const asked = (msgs) => [{ role: "user", content: "[Tue, Nov 10 2026, 7:30 PM] get me habibi, the usual" }, ...msgs];

// ---------------------------------------------------------------- 1. the card and the one line
test("the ask is one card picture, then one line on Crossmint's exact total: '$31.42 to your Visa 4821, here by 8:15. Place it?'", async () => {
  const { pay } = await toPayment();
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.equal(said[0].t, "$31.42 to your Visa 4821, here by 8:15. Place it?");
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].at, 0, "the picture goes before the line");
  assert.ok(existsSync(pictures[0].file));
  // The card: restaurant, every item with its modifiers and price, each fee, tip, total, ETA, address, card brand + last 4.
  for (const want of ["Habibi Halal", "Chicken over rice", "white sauce · no hot sauce", "$14.99", "Fries", "Delivery fee", "Service fee", "Tax", "Tip", "$4.00", "Total", "$31.42", "8:15", "3247 Bruner Ave, Apt 1", "Visa 4821"]) assert.ok(lastHtml.includes(want), `card shows ${want}`);
  assert.equal(pay.amount, "31.42");
  // ❓ on their request message while it waits on them (after ⏳ at the start).
  assert.deepEqual(reacts.map((r) => [r.messageHandle, r.reaction]), [["H-req", "⏳"], ["H-req", "❓"]]);
});

test("the total on the card and the line is Crossmint's, never the cart's; a difference is said before the question", async () => {
  await toPayment("33.10");
  assert.equal(said[0].t, "The total came to $33.10, not the $31.42 the cart showed. $33.10 to your Visa 4821, here by 8:15. Place it?");
  assert.ok(lastHtml.includes("$33.10") && lastHtml.includes("Total updated at checkout"));
  assert.ok(!/Total<\/span><span>\$31\.42/.test(lastHtml), "the cart's number is never the card's total");
});

// ---------------------------------------------------------------- 2. allergies before the ask
test("an allergy conflict on an item they picked themselves is flagged in the line BEFORE the question", async () => {
  db.remember(OMARI, "me", "Omari is allergic to sesame");
  let seen = "";
  food._setAllergyAsk(async ({ prompt }) => { seen = prompt; return { value: { constraints: ["sesame allergy"], conflicts: [{ item: "Chicken over rice", constraint: "sesame allergy", why: "the white sauce on the chicken over rice is usually made with tahini (sesame)" }] } }; });
  q("INSERT INTO food_notes (conversation_id, kind, text, created_at) VALUES (?, 'allergy', 'allergic to sesame', ?)").run(OMARI, clock.now());
  await toPayment();
  const t = said[0].t;
  assert.equal(t, "Heads up: the white sauce on the chicken over rice is usually made with tahini (sesame). $31.42 to your Visa 4821, here by 8:15. Place it?");
  assert.ok(t.indexOf("Heads up") < t.indexOf("Place it?"));
  // Every item and modifier went to the check, the ones they named included.
  assert.match(seen, /Chicken over rice \(white sauce, no hot sauce\)/);
  assert.match(seen, /Fries/);
  assert.match(seen, /Omari is allergic to sesame/);
  assert.match(seen, /allergic to sesame/);
});

test("a check that cannot run says so in the same place; no facts at all is no flag", async () => {
  q("INSERT INTO food_notes (conversation_id, kind, text, created_at) VALUES (?, 'allergy', 'no peanuts ever', ?)").run(OMARI, clock.now());
  food._setAllergyAsk(async () => { throw new Error("cli down"); });
  await toPayment();
  assert.equal(said[0].t, "Heads up: I couldn't double-check this against your allergies and diet just now. $31.42 to your Visa 4821, here by 8:15. Place it?");
  assert.equal(food.allergyFlag({ ok: true, constraints: [], conflicts: [] }), "");
  const many = food.allergyFlag({ ok: true, conflicts: [1, 2, 3, 4, 5].map((i) => ({ item: `dish ${i}`, constraint: "nuts", why: `dish ${i} has nuts` })) });
  assert.equal(many, "Heads up: dish 1 has nuts; dish 2 has nuts; dish 3 has nuts; and 2 more items that may not fit your diet.");
});

// ---------------------------------------------------------------- 3. a changed total is a fresh ask
test("a new total before placing is a fresh card and ask, and a yes to the old total cannot pay the new one", async () => {
  const { runId, pay: first } = await toPayment("31.42");
  const ctx = { conversationId: OMARI };
  // They say yes to the $31.42 card.
  const t1 = await runTool("shop_pay", { payment_id: first.id }, ctx);
  assert.equal(t1.blocked, "needs_confirmation");
  assert.match(t1.use_target, /31\.42/);
  assert.match(t1.use_target, /food#\d+ r1/, "the yes is pinned to this cart revision too");
  const msgs = asked([{ role: "assistant", content: said[0].t }]);
  const c1 = await runTool("confirm_request", { action: "shop_pay", summary: said[0].t, target: t1.use_target, stakes: "money" }, { conversationId: OMARI, messages: msgs });
  msgs.push({ role: "user", content: "[Tue, Nov 10 2026, 7:31 PM] yes" });
  const r1 = await runTool("confirm_record", { confirmation_id: c1.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  assert.equal(r1.state, "granted");
  // The fee changed before it was placed: Crossmint asks again for $32.07.
  runs[runId].requiredAction = PAY("req_2", "32.07"); runs[runId].revision = 3;
  await shop.step(runId);
  const second = q("SELECT * FROM shop_payments WHERE run_id = ? AND request_id = 'req_2'").get(runId);
  assert.ok(second && second.id !== first.id);
  assert.equal(said.at(-1).t, "The total came to $32.07, not the $31.42 the cart showed. $32.07 to your Visa 4821, here by 8:15. Place it?");
  assert.equal(pictures.length, 2, "a fresh card");
  // The yes to $31.42 does not pay $32.07.
  const before = intents();
  const r2 = await runTool("shop_pay", { payment_id: second.id, confirmation_id: c1.confirmation_id }, ctx);
  assert.notEqual(r2.ok, true, JSON.stringify(r2));
  assert.equal(intents(), before, "no order intent for the new total");
});

test("a change while the card is out lets the old checkout go (its yes can't pay), is checked again, and needs a new checkout", async () => {
  const { orderId, runId, pay } = await toPayment();
  let checked = 0;
  food._setAllergyAsk(async () => { checked++; return { value: { constraints: [], conflicts: [] } }; });
  db.remember(OMARI, "me", "Omari doesn't eat pork");
  const out = await runTool("food_order", { action: "cart", order_id: orderId, ...CART, items: [{ name: "Lamb over rice", price: "15.99" }] }, { conversationId: OMARI });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(checked, 1, "the new cart is checked");
  assert.equal(q("SELECT status FROM shop_payments WHERE id = ?").get(pay.id).status, "declined", "the old card can't be paid");
  assert.equal(q("SELECT status FROM shop_runs WHERE run_id = ?").get(runId).status, "cancelled");
  const n = said.length;
  await shop.step(runId);
  assert.equal(said.length, n, "letting it go texts nothing");
  // A new checkout links; a second one while it runs is refused.
  const ok = await runTool("store_checkout", { store: "DoorDash", start_url: STORE, what: "Lamb over rice. Stop at payment.", item: "Habibi Halal order", max_usd: 60, food_order_id: orderId }, { conversationId: OMARI, messages: asked([]) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const again = await runTool("store_checkout", { store: "DoorDash", start_url: STORE, what: "Lamb over rice. Stop at payment.", item: "Habibi Halal order", max_usd: 60, food_order_id: orderId }, { conversationId: OMARI, messages: asked([]) });
  assert.equal(again.error, "checkout_running");
});

test("a food checkout never starts without a recorded, checked cart", async () => {
  const st = await runTool("food_order", { action: "start" }, { conversationId: OMARI });
  const out = await runTool("store_checkout", { store: "DoorDash", start_url: STORE, what: "Chicken over rice. Stop at payment.", item: "Habibi Halal order", max_usd: 60, food_order_id: st.order_id }, { conversationId: OMARI, messages: asked([]) });
  assert.equal(out.ok, false);
  assert.equal(out.error, "no_cart");
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, 0);
  // And an ask on an order that somehow skipped the check says so before the question.
  q("UPDATE food_orders SET allergy_checked = 0, allergy_flag = '' WHERE id = ?").run(st.order_id);
  assert.equal(food.allergyFlag({ ok: false }), "Heads up: I couldn't double-check this against your allergies and diet just now.");
});

test("Crossmint letting go at ~10 minutes is asked again inside the 15, with a fresh card; the deadline stays the first ask's", async () => {
  const { runId, pay } = await toPayment();
  const deadline = shop.askDeadline(pay);
  clock.skip(10 * 60_000);
  runs[runId] = { status: "failed", result: { code: "input_expired" }, revision: 5 };
  await shop.step(runId);
  const next = q("SELECT run_id FROM shop_runs WHERE run_id <> ? ORDER BY created_at DESC LIMIT 1").get(runId)?.run_id;
  assert.ok(next, "asked again");
  assert.equal(food.orderForRun(next)?.restaurant, "Habibi Halal", "the order follows the new checkout");
  runs[next].requiredAction = PAY("req_r", "31.42"); runs[next].revision = 2;
  await shop.step(next);
  const p2 = q("SELECT * FROM shop_payments WHERE run_id = ?").get(next);
  assert.equal(shop.askDeadline(p2), deadline);
  assert.equal(said.at(-1).t, "$31.42 to your Visa 4821, here by 8:15. Place it?");
  assert.equal(pictures.length, 2);
});

// ---------------------------------------------------------------- 4. silence, and the 15-minute hold
test("silence is not a yes: no reply after the ask grants nothing and pays nothing", async () => {
  const { pay } = await toPayment();
  const t1 = await runTool("shop_pay", { payment_id: pay.id }, { conversationId: OMARI });
  const msgs = asked([{ role: "assistant", content: said[0].t }]);
  const c1 = await runTool("confirm_request", { action: "shop_pay", summary: said[0].t, target: t1.use_target, stakes: "money" }, { conversationId: OMARI, messages: msgs });
  // Nothing from them since the ask.
  const r1 = await runTool("confirm_record", { confirmation_id: c1.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  assert.notEqual(r1.state, "granted", JSON.stringify(r1));
  const p = await runTool("shop_pay", { payment_id: pay.id, confirmation_id: c1.confirmation_id }, { conversationId: OMARI });
  assert.notEqual(p.ok, true);
  assert.equal(intents(), 0);
});

test("the hold is 15 minutes: after it no yes pays, and the cart is let go with one line and ❓", async () => {
  const { pay } = await toPayment();
  const since = q("SELECT ask_since FROM shop_runs WHERE run_id = ?").get(pay.run_id).ask_since;
  assert.equal(shop.askDeadline(pay) - since, 15 * 60_000, "food holds 15 minutes, not shopping's 30");
  // They answer at minute 14 (inside the hold); the pay call lands at minute 16 (outside it).
  clock.skip(14 * 60_000);
  const t1 = await runTool("shop_pay", { payment_id: pay.id }, { conversationId: OMARI });
  const msgs = asked([{ role: "assistant", content: said[0].t }]);
  const c1 = await runTool("confirm_request", { action: "shop_pay", summary: said[0].t, target: t1.use_target, stakes: "money" }, { conversationId: OMARI, messages: msgs });
  msgs.push({ role: "user", content: "[Tue, Nov 10 2026, 7:44 PM] yes place it" });
  const r1 = await runTool("confirm_record", { confirmation_id: c1.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: async () => ({ verdict: "yes" }) });
  assert.equal(r1.state, "granted");
  clock.skip(2 * 60_000);
  const late = await runTool("shop_pay", { payment_id: pay.id, confirmation_id: c1.confirmation_id }, { conversationId: OMARI, messages: msgs });
  assert.equal(late.error, "hold_lapsed", JSON.stringify(late));
  assert.equal(intents(), 0, "a yes given in time does not pay once the hold is over");
  const n = said.length;
  await food.sweep();
  await food.sweep();
  assert.equal(said.length, n + 1, "said once");
  assert.equal(said.at(-1).t, "I let the Habibi Halal cart go after 15 minutes, nothing charged. Want me to rebuild it?");
  assert.equal(q("SELECT status FROM shop_payments WHERE id = ?").get(pay.id).status, "declined");
  assert.equal(reacts.at(-1).reaction, "❓");
  // Crossmint's end of that run says nothing more, and puts no other tapback on.
  const m = said.length, r = reacts.length;
  runs[pay.run_id] = { status: "cancelled", revision: 9 };
  await shop.step(pay.run_id);
  assert.equal(said.length, m);
  assert.equal(reacts.length, r);
});

test("a restaurant closing inside the hold is warned once, 15 minutes ahead", async () => {
  await toPayment("31.42", { ...CART, closes_at: new Date(clock.now() + 20 * 60_000).toISOString() });
  await food.sweep();
  assert.equal(said.length, 1, "not yet");
  clock.skip(6 * 60_000);
  await food.sweep(); await food.sweep();
  assert.equal(said.length, 2);
  assert.match(said.at(-1).t, /^Habibi Halal closes at \d{1,2}:\d{2}, so it has to go in soon\. Place it\?$/);
});

// ---------------------------------------------------------------- 5. never the full card number
test("never the full card number: the card and line show brand + last 4, and digits the model typed are masked", async () => {
  q("UPDATE shop_cards SET last4 = '4242424242424821' WHERE conversation_id = ?").run(OMARI);
  const cart = { ...CART, notes: "card 4242 4242 4242 4821 on file, ring twice", items: [{ name: "Chicken over rice 4242424242424821", price: "14.99" }] };
  await toPayment("31.42", cart);
  for (const s of [said[0].t, lastHtml]) {
    assert.doesNotMatch(s, /4242\s?4242\s?4242/, "no long card digits");
    assert.match(s, /Visa 4821/);
  }
  assert.equal(food.maskCardNumbers("pay with 4111-1111-1111-1111 please"), "pay with ••••1111 please");
  assert.equal(food.cardLabel({ brand: "mastercard", last4: "5555555555554444" }), "Mastercard 4444");
  const o = food.orderRow(q("SELECT id FROM food_orders ORDER BY id DESC").get().id, OMARI);
  assert.doesNotMatch(JSON.stringify(o.items) + o.notes, /4242424242424821|4242 4242 4242 4821/);
});

// ---------------------------------------------------------------- placed, failed, the flag
test("placed: one text with restaurant, items, total, ETA and the address line, no order number; ✅ on their request; kept as history", async () => {
  const { runId, pay } = await toPayment();
  const paid = await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  runs[runId] = { status: "succeeded", result: { orderId: "DD-778812" }, revision: 9 };
  await shop.step(runId);
  assert.equal(said.at(-1).t, "Placed: Habibi Halal, Chicken over rice, Fries. $31.42 charged, here by 8:15. Going to Home (3247 Bruner Ave, Apt 1).");
  assert.doesNotMatch(said.at(-1).t, /DD-778812/);
  assert.deepEqual(reacts.at(-1), { messageHandle: "H-req", reaction: "✅" });
  const h = await runTool("food_order", { action: "history" }, { conversationId: OMARI });
  assert.equal(h.orders, 1);
  assert.equal(h.usual[0].restaurant, "Habibi Halal");
  assert.deepEqual(h.usual[0].last_two[0].items, ["Chicken over rice (white sauce, no hot sauce)", "Fries"]);
  assert.equal(h.normal_cost, "$31.42");
  assert.equal(h.tip_default, "$4.00");
  assert.deepEqual(h.addresses, [{ address: "3247 Bruner Ave, Apt 1", label: "Home", card: "Visa 4821" }]);
  // 15 minutes after the latest arrival: the model is woken once to look; nothing texted by code.
  clock.skip(Date.parse(CART.eta_latest) + 16 * 60_000 - clock.now());
  const n = said.length;
  await food.sweep(); await food.sweep();
  assert.equal(said.length, n);
  assert.equal(woke.filter((w) => /was due by 8:15/.test(w.t)).length, 1);
  assert.match(woke.at(-1).t, /Never file a complaint or cancel without their yes/);
});

test("a failed checkout never moves to another restaurant by itself: ❓ and one fix asked for; the second failure is ❌", async () => {
  const st = await runTool("food_order", { action: "start" }, { conversationId: OMARI });
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...CART }, { conversationId: OMARI });
  const a = await shop.startCheckout({ conversationId: OMARI, store: "doordash", startUrl: STORE, what: "x", item: "Habibi Halal order", maxUsd: 60 });
  food.linkRun(OMARI, st.order_id, a.runId);
  runs[a.runId] = { status: "failed", result: { code: "merchant.no_safe_path", summary: "The restaurant is not accepting orders" }, revision: 4 };
  await shop.step(a.runId);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, 1, "no second checkout started elsewhere");
  assert.equal(reacts.at(-1).reaction, "❓");
  assert.equal(woke.length, 1);
  assert.match(woke[0].t, /Bring ONE fix/);
  const b = await shop.startCheckout({ conversationId: OMARI, store: "doordash", startUrl: STORE, what: "x", item: "Habibi Halal order", maxUsd: 60 });
  food.linkRun(OMARI, st.order_id, b.runId);
  runs[b.runId] = { status: "failed", result: { code: "merchant.error", summary: "page errored" }, revision: 4 };
  await shop.step(b.runId);
  assert.equal(reacts.at(-1).reaction, "❌");
  assert.equal(food.orderRow(st.order_id, OMARI).status, "failed");
});

test("a status tapback only goes on their own message in their own conversation", async () => {
  db.claimInbound({ channel: "fake", externalId: "H-ama", conversationId: AMA, text: "hi" });
  const { sendTapback } = await import("../src/tapbacks.js");
  const r = await sendTapback({ conversationId: OMARI, channels, reaction: "✅", messageHandle: "H-ama" });
  assert.equal(r.ok, false);
  assert.equal(reacts.length, 0);
  const ok = await sendTapback({ conversationId: OMARI, channels, reaction: "✅", messageHandle: "H-req" });
  assert.equal(ok.ok, true);
});

test("another person's order id reads as missing", async () => {
  const st = await runTool("food_order", { action: "start" }, { conversationId: OMARI });
  assert.equal(food.ownOrder(AMA, st.order_id), null);
  assert.equal(food.linkRun(AMA, st.order_id, "run_x"), false);
});

test("REASON_FOOD gates it: owner-only hides the tool and the rules from everyone else; off leaves shopping's ask untouched", async () => {
  const names = (c) => toolsFor(c).map((t) => t.name);
  assert.ok(names(OMARI).includes("food_order"));
  assert.ok(!names(AMA).includes("food_order"));
  assert.match(systemFor({ name: "Omari", isOperator: true }), /FOOD ORDERS/);
  assert.doesNotMatch(systemFor({ name: "Ama", isOperator: false }), /FOOD ORDERS/);
  assert.doesNotMatch(systemFor({ name: "Omari", isOperator: true, onCall: true }), /FOOD ORDERS/);
  const out = await runTool("food_order", { action: "start" }, { conversationId: AMA });
  assert.equal(out.ok, false);
  process.env.REASON_FOOD = "off";
  try {
    const st = food.startOrder; void st;
    q("INSERT INTO food_orders (conversation_id, status, run_id, created_at, updated_at) VALUES (?, 'building', 'run_1', ?, ?)").run(OMARI, clock.now(), clock.now());
    const a = await shop.startCheckout({ conversationId: OMARI, store: "doordash", startUrl: STORE, what: "x", item: "Habibi Halal order", maxUsd: 60 });
    runs[a.runId].requiredAction = PAY("req_9", "31.42"); runs[a.runId].revision = 2;
    await shop.step(a.runId);
    assert.match(said.at(-1).t, /^OK to pay \$31\.42/);
    assert.equal(pictures.length, 0);
  } finally { process.env.REASON_FOOD = "owner"; }
});

test("the comparison: up to three real photos as ONE numbered picture; a picture Reason made is refused", async () => {
  const photo = "https://img.example-cdn.com/habibi/chicken.jpg";
  db.rememberSeenUrls(OMARI, [photo, "https://img.example-cdn.com/k/lamb.jpg"], { kind: "search", from: "https://example.com" });
  const fetchPhoto = async () => ({ ok: true, base64: Buffer.from("x").toString("base64"), mediaType: "image/jpeg" });
  const bad = await food.showOptions(OMARI, [{ dish: "A", restaurant: "R", photo_url: "https://files.heyreason.com/img/abc.png" }, { dish: "B", restaurant: "R", photo_url: photo }], { fetchPhoto, shoot: fakeShoot });
  assert.equal(bad.ok, false);
  const ok = await food.showOptions(OMARI, [{ dish: "Chicken over rice", restaurant: "Habibi", price: "$14.99", eta: "25 min", photo_url: photo }, { dish: "Lamb over rice", restaurant: "Kebab King", price: "$15.99", eta: "35 min", photo_url: "https://img.example-cdn.com/k/lamb.jpg" }], { fetchPhoto, shoot: async (html) => { lastHtml = html; return fakeShoot(html); } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(lastHtml, />1<\/div>[\s\S]*>2<\/div>/);
  const unseen = await food.showOptions(OMARI, [{ dish: "A", restaurant: "R", photo_url: "https://stock.example.com/a.jpg" }, { dish: "B", restaurant: "R", photo_url: photo }], { fetchPhoto, shoot: fakeShoot });
  assert.equal(unseen.ok, false, "a photo no tool returned is refused");
});

test("with REASON_FOOD off the food platforms are ordinary stores (a guest first), as before", async () => {
  const { spawnSync } = await import("node:child_process");
  const probe = `const s = await import(${JSON.stringify(new URL("../src/shopconnect.js", import.meta.url).href)}); console.log(JSON.stringify([s.storeSignIn("doordash"), s.STORES.doordash ?? null]));`;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, REASON_DB_PATH: join(dir, "off.db"), REASON_DATA_DIR: dir, REASON_FOOD: "off" };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" });
  assert.equal(r.stdout.trim(), JSON.stringify(["", null]), r.stderr);
  assert.equal(shop.storeSignIn("doordash"), "required", "on (owner), DoorDash needs their account");
});
