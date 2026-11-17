// What stopped a food order finishing (diagnosis of 2026-11-17, research/food-today-2026-11-17.md),
// each against the real path with the existing fakes (a fake Crossmint, fake call rows; no real
// checkout, no real call, no paid model, no message to anyone):
//   1. the model starting a food checkout over keeps the food card, its 15-minute hold, and a yes
//      pinned to the exact amount and the NEW cart revision;
//   2. a new request closes the older orders left waiting on nothing (letting go of what is attached),
//      quietly, and a daily sweep closes any idle more than a day;
//   3. pickup: no delivery address, no tip unless named, the card says pickup, where and when ready,
//      no late check, one "should be ready now" line;
//   4. an own site whose delivery hands off to a delivery app is caught at once and said in one line;
//   5. a place with no online ordering: a phone order for pickup offered once, placed, recorded
//      (the total as the restaurant's quote), stopped when they want a card, held by the no-call hours.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-food1117-"));
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
const shipping = await import("../src/shipping.js");
const offers = await import("../src/offers.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const CHIPOTLE = "https://order.chipotle.com/order/build/burrito";
const LUCAS = "https://order.lucaspizza.com/menu";
const CFA = "https://order.chick-fil-a.com/menu";

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
const PAY = (requestId, value, merchant = "Chipotle", url = "https://www.chipotle.com/") => ({
  requestId, request: {
    question: `Please approve a card payment of $${value} to ${merchant}.`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
    interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: merchant, countryCode: "US", url } },
  },
});
const QUESTION = (requestId) => ({ requestId, request: { question: "Delivery instructions?", interaction: { kind: "form", fields: [{ key: "dropoff", label: "Drop-off option", type: "select", options: ["Hand it to me", "Meet outside"] }] } } });
const SIGNIN = (requestId) => ({ requestId, request: { question: "Please sign in to continue.", interaction: { kind: "form", fields: [{ key: "dd_email", label: "Email", handling: "protected" }, { key: "dd_password", label: "Password", handling: "protected" }] } } });
const checkoutsStarted = () => calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length;
const intents = () => calls.filter((c) => c.path === "/api/unstable/order-intents" && c.method === "POST").length;

const said = [], pictures = [], reacts = [], woke = [];
const line = { name: "fake", status: () => ({ status: "live", number: "+15550000000" }), react: async ({ messageHandle, reaction }) => { reacts.push({ messageHandle, reaction }); return { ok: true, supported: true, reaction }; } };
const channels = { get: (n) => (n === "fake" ? line : null) };
const q = (sql) => db.db.prepare(sql);
let lastHtml = "";

before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: () => {}, picture: async (c, file) => pictures.push({ c, file, at: said.length }), base: "https://heyreason.test/web/connect" });
  food._attach({ say: (c, t) => said.push({ c, t }), wake: async (c, t, o) => woke.push({ c, t, key: o?.key }), channels: () => channels });
  food._setShoot(async (html) => { lastHtml = html; return Buffer.from(`JPEG:${html.length}`); });
  db.upsertAccount({ conversationId: OMARI, channel: "fake", address: "+15551110000", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
});
after(() => rmSync(dir, { recursive: true, force: true }));
// 6pm in New York on a Tuesday: calls to a business are allowed.
const SIX_PM = Date.parse("2026-11-17T23:00:00Z");
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; said.length = 0; pictures.length = 0; reacts.length = 0; woke.length = 0; lastHtml = "";
  clock.reset(); clock.skip(SIX_PM - clock.now());
  food._setAllergyAsk(async () => ({ value: { constraints: [], conflicts: [] } }));
  food._resetIdleSweep?.();
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "spend", "food_orders", "food_notes", "food_places", "food_told", "confirmations", "calls", "call_commitments"]) { try { db.db.exec(`DELETE FROM ${t}`); } catch { /* table made later */ } }
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_secret_4821', 'visa', '4821', ?, 1)").run(OMARI, clock.now());
  db.upsertThread({ conversationId: OMARI, channel: "fake", address: "+15551110000", isOwner: true, service: "iMessage", lastInboundId: "H-req" });
  db.claimInbound({ channel: "fake", externalId: "H-req", conversationId: OMARI, text: "chipotle burrito please" });
  // The once-ever "why it's cheaper" line went with an earlier order (it is test/food-direct.test.js's).
  food.markTold(OMARI, "why_direct");
});
const ctx = { conversationId: OMARI };
const asked = (msgs = []) => [{ role: "user", content: "[Tue, Nov 17 2026, 6:00 PM] chipotle burrito please" }, ...msgs];
const BURRITO = {
  restaurant: "Chipotle", store_url: CHIPOTLE,
  items: [{ name: "Chicken burrito", qty: 1, modifiers: ["white rice", "black beans"], price: "11.25" }],
  fees: [{ label: "Subtotal", amount: "11.25" }, { label: "Delivery fee", amount: "3.99" }, { label: "Tax", amount: "1.08" }],
  tip: "2.00", total: "18.32", address: "3247 Bruner Ave, Apt 1", address_label: "Home", eta: "6:40–6:55", eta_latest: "2026-11-17T23:55:00Z",
};
const checkout = (extra = {}) => runTool("store_checkout", { store: "Chipotle", start_url: CHIPOTLE, what: "Chicken burrito, white rice, black beans. Leave at door. Tip $2. Stop at payment.", item: "Chipotle burrito order", max_usd: 60, variant_confirmed: true, ...extra }, { conversationId: OMARI, messages: asked() });
const payRow = (runId) => q("SELECT * FROM shop_payments WHERE run_id = ? ORDER BY id DESC").get(runId);

// ---------------------------------------------------------------- 1. a restart keeps the food card
test("the model starting the checkout over (a form answer it could not fill) keeps the food card, the 15-minute hold, and the order", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  assert.equal((await runTool("food_order", { action: "cart", order_id: st.order_id, ...BURRITO }, ctx)).ok, true);
  const a = await checkout({ food_order_id: st.order_id });
  assert.equal(a.ok, true, JSON.stringify(a));
  // Chipotle's form asks something the record can't answer; the model starts the same checkout over,
  // this time without food_order_id and with its own wording for the item.
  runs[a.run_id].requiredAction = QUESTION("req_q"); runs[a.run_id].revision = 2;
  await shop.step(a.run_id);
  const b = await checkout({ item: "burrito from Chipotle", what: "Chicken burrito, white rice, black beans. Drop-off: hand it to me. Tip $2. Stop at payment." });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.notEqual(b.run_id, a.run_id);
  assert.equal(q("SELECT status FROM shop_runs WHERE run_id = ?").get(a.run_id).status, "cancelled", "the old run is let go");
  const o = food.orderRow(st.order_id, OMARI);
  assert.equal(o.run_id, b.run_id, "the food order follows the new run");
  assert.equal(o.revision, 2, "at a new cart revision");
  runs[b.run_id].requiredAction = PAY("req_p", "28.32"); runs[b.run_id].revision = 3;
  const before = said.length;
  await shop.step(b.run_id);
  const pay = payRow(b.run_id);
  // The food card and its one line, not shopping's generic ask.
  assert.equal(pictures.length, 1, "the food card picture");
  assert.equal(said.at(-1).t, "The total came to $28.32, not the $18.32 the cart showed. $28.32 to your Visa 4821, here by 6:55. Place it?");
  assert.equal(said.length, before + 1);
  assert.doesNotMatch(said.at(-1).t, /OK to pay/);
  // The 15-minute hold, not shopping's 30.
  assert.equal(shop.askDeadline(pay) - pay.created_at, food.HOLD_MS);
  assert.equal(food.orderRow(st.order_id, OMARI).status, "asked");
});

test("across a restart the yes is pinned to the exact amount and the new cart revision; a yes to the old card pays nothing", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...BURRITO }, ctx);
  const a = await checkout({ food_order_id: st.order_id });
  runs[a.run_id].requiredAction = PAY("req_1", "28.32"); runs[a.run_id].revision = 2;
  await shop.step(a.run_id);
  const first = payRow(a.run_id);
  const t1 = await runTool("shop_pay", { payment_id: first.id }, ctx);
  assert.match(t1.use_target, /28\.32/);
  assert.match(t1.use_target, new RegExp(`food#${st.order_id} r1\\b`));
  const msgs = asked([{ role: "assistant", content: said.at(-1).t }]);
  const c1 = await runTool("confirm_request", { action: "shop_pay", summary: said.at(-1).t, target: t1.use_target, stakes: "money" }, { conversationId: OMARI, messages: msgs });
  msgs.push({ role: "user", content: "[Tue, Nov 17 2026, 6:02 PM] yes" });
  assert.equal((await runTool("confirm_record", { confirmation_id: c1.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: async () => ({ verdict: "yes" }) })).state, "granted");
  // Before it is paid the model starts the same checkout over: the old card is declined, the new run is the order's.
  const b = await checkout({ item: "Chipotle burrito", what: "Chicken burrito, white rice, black beans. Hand it to me. Tip $2. Stop at payment." });
  assert.equal(q("SELECT status FROM shop_payments WHERE id = ?").get(first.id).status, "declined");
  runs[b.run_id].requiredAction = PAY("req_2", "28.32"); runs[b.run_id].revision = 2;
  await shop.step(b.run_id);
  const second = payRow(b.run_id);
  const t2 = await runTool("shop_pay", { payment_id: second.id }, ctx);
  assert.equal(t2.blocked, "needs_confirmation");
  assert.match(t2.use_target, /USD/);
  assert.match(t2.use_target, / 28\.32 USD /, "pinned to the exact amount");
  assert.match(t2.use_target, new RegExp(`food#${st.order_id} r2\\b`), "and to the new cart revision");
  // The yes to the old card cannot pay the new one, nor the old one.
  const n = intents();
  assert.notEqual((await runTool("shop_pay", { payment_id: second.id, confirmation_id: c1.confirmation_id }, ctx)).ok, true);
  assert.notEqual((await runTool("shop_pay", { payment_id: first.id, confirmation_id: c1.confirmation_id }, ctx)).ok, true);
  assert.equal(intents(), n, "no order intent from the old yes");
});

test("a restart after the old run already ended links the new run to the order; a checkout elsewhere stays shopping", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...BURRITO }, ctx);
  const a = await checkout({ food_order_id: st.order_id });
  runs[a.run_id] = { status: "failed", result: { code: "merchant.checkout_error" }, revision: 4 };
  await shop.step(a.run_id);
  assert.equal(food.orderRow(st.order_id, OMARI).run_id, null);
  const b = await checkout();
  assert.equal(food.orderRow(st.order_id, OMARI).run_id, b.run_id);
  assert.equal(food.isFoodRun(b.run_id), true);
  const other = await runTool("store_checkout", { store: "Cables R Us", start_url: "https://shop.cablesrus.test/p/usb-c-cable", what: "A USB-C cable. Stop at payment.", item: "USB-C cable", max_usd: 20, variant_confirmed: true }, { conversationId: OMARI, messages: asked() });
  assert.equal(other.ok, true);
  assert.equal(food.isFoodRun(other.run_id), false);
  assert.equal(food.orderRow(st.order_id, OMARI).run_id, b.run_id);
});

// ---------------------------------------------------------------- 2. stale orders
test("a new food request closes older orders left in draft, building or needs, letting go of what is attached, and says nothing", async () => {
  const now = clock.now();
  const ins = (c, status, runId = null) => Number(q("INSERT INTO food_orders (conversation_id, request_handle, status, run_id, created_at, updated_at) VALUES (?, 'H-old', ?, ?, ?, ?)").run(c, status, runId, now, now).lastInsertRowid);
  const needs1 = ins(OMARI, "needs"), needs2 = ins(OMARI, "needs"), draft = ins(OMARI, "draft");
  // One still building with a checkout running at Crossmint and a payment out for a yes.
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...BURRITO }, ctx);
  const a = await checkout({ food_order_id: st.order_id });
  runs[a.run_id].requiredAction = PAY("req_1", "18.32"); runs[a.run_id].revision = 2;
  await shop.step(a.run_id);
  q("UPDATE food_orders SET status = 'building' WHERE id = ?").run(st.order_id);
  const pay = payRow(a.run_id);
  const placedId = ins(OMARI, "placed"), amaNeeds = ins(AMA, "needs");
  const n = said.length, r = reacts.length;
  const fresh = await runTool("food_order", { action: "start" }, ctx);
  assert.equal(fresh.ok, true);
  for (const id of [needs1, needs2, draft, st.order_id]) {
    const o = q("SELECT status, closed_why, run_id FROM food_orders WHERE id = ?").get(id);
    assert.equal(o.status, "cancelled", `order ${id}`);
    assert.equal(o.closed_why, "a new food request replaced it");
    assert.equal(o.run_id, null);
  }
  assert.equal(q("SELECT status FROM shop_payments WHERE id = ?").get(pay.id).status, "declined", "its payment can never be paid");
  assert.equal(q("SELECT status FROM shop_runs WHERE run_id = ?").get(a.run_id).status, "cancelled", "its checkout is let go");
  assert.ok(calls.some((c) => c.path.endsWith(`/${a.run_id}/cancel`)), "cancelled at Crossmint");
  assert.equal(said.length, n, "nothing said about the old orders");
  assert.deepEqual(reacts.slice(r).map((x) => x.reaction), ["⏳"], "only the new request's ⏳");
  assert.equal(q("SELECT status FROM food_orders WHERE id = ?").get(placedId).status, "placed");
  assert.equal(q("SELECT status FROM food_orders WHERE id = ?").get(amaNeeds).status, "needs", "another person's order is theirs");
  // A status call without an order_id now reads the new order, never a stale one.
  assert.equal(food.openOrder(OMARI).id, fresh.order_id);
});

test("the daily sweep closes any order idle more than a day in draft, building or needs; once a day; quietly", async () => {
  const now = clock.now();
  const ins = (status, ago, c = OMARI) => Number(q("INSERT INTO food_orders (conversation_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)").run(c, status, now - ago, now - ago).lastInsertRowid);
  const old1 = ins("needs", 25 * 3600_000), old2 = ins("draft", 30 * 3600_000), old3 = ins("building", 48 * 3600_000, AMA);
  const young = ins("needs", 3600_000), asked1 = ins("asked", 30 * 3600_000);
  await food.sweep({ now });
  for (const id of [old1, old2, old3]) assert.deepEqual({ ...q("SELECT status, closed_why FROM food_orders WHERE id = ?").get(id) }, { status: "cancelled", closed_why: "idle over 24 hours" });
  assert.equal(q("SELECT status FROM food_orders WHERE id = ?").get(young).status, "needs");
  assert.equal(q("SELECT status FROM food_orders WHERE id = ?").get(asked1).status, "asked", "a card out for a yes is the hold's to end");
  assert.equal(said.length, 0);
  // Not again for a day.
  const later = ins("needs", 25 * 3600_000);
  await food.sweep({ now: now + 3600_000 });
  assert.equal(q("SELECT status FROM food_orders WHERE id = ?").get(later).status, "needs");
  await food.sweep({ now: now + 25 * 3600_000 });
  assert.equal(q("SELECT status FROM food_orders WHERE id = ?").get(later).status, "cancelled");
});

// ---------------------------------------------------------------- 3. pickup
const PIZZA = {
  restaurant: "Lucas Pizza", store_url: LUCAS, fulfillment: "pickup", place_address: "12 Main St",
  items: [{ name: "Cheese slice", qty: 2, price: "7.00" }],
  fees: [{ label: "Subtotal", amount: "7.00" }, { label: "Tax", amount: "0.62" }],
  tip: "2.00", total: "7.62", address: "3247 Bruner Ave, Apt 1", eta: "6:30", eta_latest: "2026-11-17T23:30:00Z",
};
test("pickup end to end on the restaurant's own site: no address, no tip unless named, the card says pickup, where and when; placed; ready line; no late check", async () => {
  shipping.learn(OMARI, { first_name: "Omari", last_name: "I", address1: "3247 Bruner Ave", address2: "Apt 1", city: "Bronx", state: "NY", zip: "10469", phone: "+15551110000", email: "o@example.test" }, { source: "test" });
  const st = await runTool("food_order", { action: "start", fulfillment: "pickup" }, ctx);
  assert.equal(st.fulfillment, "pickup");
  assert.match(st.say, /no delivery address question and no tip unless they name one/);
  const ct = await runTool("food_order", { action: "cart", order_id: st.order_id, ...PIZZA }, ctx);
  assert.equal(ct.ok, true, JSON.stringify(ct));
  assert.match(ct.pickup, /Pickup at 12 Main St/);
  assert.match(ct.pickup, /tip was left off/);
  const o = food.orderRow(st.order_id, OMARI);
  assert.equal(o.fulfillment, "pickup");
  assert.equal(o.address, "", "no delivery address on a pickup");
  assert.equal(o.tip, "", "no tip they didn't name");
  const a = await runTool("store_checkout", { store: "Lucas Pizza", start_url: LUCAS, what: "2 cheese slices for pickup at 12 Main St, earliest time. No tip. Stop at payment.", item: "Lucas Pizza pickup", max_usd: 30, variant_confirmed: true, food_order_id: st.order_id }, { conversationId: OMARI, messages: asked() });
  assert.equal(a.ok, true, JSON.stringify(a));
  const what = q("SELECT what FROM shop_run_asks WHERE run_id = ?").get(a.run_id).what;
  assert.match(what, /12 Main St/, "the restaurant's address is left as written");
  assert.doesNotMatch(what, /Bruner/, "their home address is never put into a pickup");
  runs[a.run_id].requiredAction = PAY("req_1", "7.62", "Lucas Pizza", LUCAS); runs[a.run_id].revision = 2;
  await shop.step(a.run_id);
  assert.equal(said.at(-1).t, "$7.62 to your Visa 4821, for pickup at 12 Main St, ready by 6:30. Place it?");
  for (const want of ["Your pickup order", "Pickup", "12 Main St", "Ready by", "6:30", "Visa 4821"]) assert.ok(lastHtml.includes(want), `card shows ${want}`);
  assert.ok(!lastHtml.includes("Here by") && !lastHtml.includes("Bruner") && !lastHtml.includes(">Tip<"), "no delivery ETA, no address, no tip");
  const pay = payRow(a.run_id);
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 })).ok, true);
  runs[a.run_id] = { status: "succeeded", result: { orderId: "LP-1" }, revision: 9 };
  await shop.step(a.run_id);
  assert.equal(said.at(-1).t, "Placed for pickup: Lucas Pizza, 2 Cheese slice. $7.62 charged, ready by 6:30. Pick it up at 12 Main St.");
  assert.deepEqual(reacts.at(-1).reaction, "✅");
  // The figures said on this path are sourced: the reply check leaves them as they are.
  offers.startTurn?.(OMARI, "is my pizza ordered?");
  const g = offers.guardReply(OMARI, "Yes: Lucas Pizza, $7.62 charged, ready by 6:30 at 12 Main St.", { turnReply: true });
  assert.equal(g.changed, false, JSON.stringify(g.flags));
  assert.equal(g.recompose, null);
  // At the ready time: one line. Never the late check (nobody is bringing it).
  const n = said.length;
  await food.sweep({ now: Date.parse(PIZZA.eta_latest) + 60_000 });
  await food.sweep({ now: Date.parse(PIZZA.eta_latest) + 2 * 60_000 });
  assert.deepEqual(said.slice(n).map((s) => s.t), ["Your Lucas Pizza order should be ready now at 12 Main St."]);
  await food.sweep({ now: Date.parse(PIZZA.eta_latest) + 30 * 60_000 });
  assert.equal(woke.filter((w) => /was due by/.test(w.t)).length, 0, "no late check on a pickup");
  const h = await runTool("food_order", { action: "history" }, ctx);
  assert.equal(h.usual[0].last_two[0].fulfillment, "pickup");
});

test("pickup keeps a tip they named themselves; delivery is unchanged", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  const ct = await runTool("food_order", { action: "cart", order_id: st.order_id, ...PIZZA, their_tip: true }, ctx);
  assert.equal(ct.fulfillment, "pickup");
  assert.equal(food.orderRow(st.order_id, OMARI).tip, "$2.00");
  const st2 = await runTool("food_order", { action: "start" }, ctx);
  const d = await runTool("food_order", { action: "cart", order_id: st2.order_id, ...BURRITO }, ctx);
  assert.equal(d.fulfillment, "delivery");
  assert.equal(d.pickup, undefined);
  assert.equal(food.orderRow(st2.order_id, OMARI).address, "3247 Bruner Ave, Apt 1");
  assert.equal(food.approvalLine({ amount: "$9.00", card: "Visa 4821", eta: "8:15" }), "$9.00 to your Visa 4821, here by 8:15. Place it?");
});

// ---------------------------------------------------------------- 4. an own site that hands off to a delivery app
const NUGGETS = { restaurant: "Chick-fil-A", store_url: CFA, items: [{ name: "8 ct nuggets", price: "5.95" }], total: "9.80", address: "3247 Bruner Ave, Apt 1", eta: "7:10", eta_latest: "2026-11-18T00:10:00Z" };
test("an own site whose delivery hands off to DoorDash's sign-in is caught at once: one plain line, no sign-in waited on, nothing charged", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...NUGGETS }, ctx);
  const a = await runTool("store_checkout", { store: "Chick-fil-A", start_url: CFA, what: "8 ct nuggets. Deliver. Stop at payment.", item: "Chick-fil-A nuggets", max_usd: 30, variant_confirmed: true, food_order_id: st.order_id }, { conversationId: OMARI, messages: asked() });
  assert.equal(a.ok, true, JSON.stringify(a));
  runs[a.run_id].requiredAction = SIGNIN("req_s"); runs[a.run_id].revision = 2;
  const out = await shop.step(a.run_id);
  assert.equal(out.handoff, "doordash");
  assert.equal(q("SELECT COUNT(*) AS n FROM shop_links WHERE kind = 'signin'").get().n, 0, "no sign-in link waited on");
  assert.equal(q("SELECT status FROM shop_runs WHERE run_id = ?").get(a.run_id).status, "cancelled");
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.equal(said[0].t, "Chick-fil-A's own delivery runs through DoorDash, and DoorDash wants you signed in, so I stopped there. Nothing was charged. I can order it for pickup from Chick-fil-A's own site if they offer it, or send you the DoorDash sign-in link to have it delivered through DoorDash.");
  const o = food.orderRow(st.order_id, OMARI);
  assert.equal(o.status, "needs");
  assert.equal(o.run_id, null);
  assert.equal(reacts.at(-1).reaction, "❓");
  // Kept: the next delivery cart there says so up front.
  const again = await runTool("food_order", { action: "cart", order_id: st.order_id, ...NUGGETS }, ctx);
  assert.match(again.handoff, /handed off to DoorDash/);
  assert.equal((await runTool("food_order", { action: "cart", order_id: st.order_id, ...NUGGETS, fulfillment: "pickup", place_address: "1 Fordham Rd" }, ctx)).handoff, undefined);
});

test("a checkout that lands on a delivery app's own site is caught too; a direct order's own sign-in and a storefront are not a hand-off", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...NUGGETS }, ctx);
  const a = await runTool("store_checkout", { store: "Chick-fil-A", start_url: CFA, what: "8 ct nuggets. Deliver. Stop at payment.", item: "Chick-fil-A nuggets", max_usd: 30, variant_confirmed: true, food_order_id: st.order_id }, { conversationId: OMARI, messages: asked() });
  runs[a.run_id].currentUrl = "https://www.doordash.com/consumer/login/?next=checkout"; runs[a.run_id].revision = 2;
  assert.equal((await shop.step(a.run_id)).handoff, "doordash");
  assert.match(said.at(-1).t, /runs through DoorDash/);
  assert.equal(food.handoffApp({ run_id: "nope", store: "x" }, { urls: ["https://www.doordash.com/"] }), "", "not a food run: nothing");
  // The restaurant's own account sign-in is not a hand-off.
  const st2 = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st2.order_id, ...BURRITO }, ctx);
  const b = await checkout({ food_order_id: st2.order_id });
  const own = { requestId: "r", request: { question: "Sign in to your Chipotle Rewards account", interaction: { kind: "form", fields: [{ key: "email", label: "Email", handling: "protected" }, { key: "password", label: "Password", handling: "protected" }] } } };
  assert.equal(food.handoffApp(shop.runRow(b.run_id), { rq: own, account: shop.signinAccount(shop.runRow(b.run_id).store, own) }), "");
  // DoorDash's storefront (order.online) is the restaurant's own ordering: its pages are not a hand-off.
  q("UPDATE food_orders SET via = 'storefront' WHERE id = ?").run(st2.order_id);
  assert.equal(food.handoffApp(shop.runRow(b.run_id), { urls: ["https://www.doordash.com/checkout"] }), "");
});

// ---------------------------------------------------------------- 5. a phone order for pickup
const DELI = "+12125550142";
const SANDWICH = { restaurant: "Best Stop Deli", phone: DELI, items: [{ name: "Turkey club", qty: 1 }], order_name: "Omari", pickup_time: "around 6:30", place_address: "88 E 170th St" };
/** A finished call to the deli, as the calls module leaves it, with what it agreed (or refused). */
function finishedCall({ kind = "confirmed", commitment = null } = {}) {
  const call = db.createCall(OMARI, { provider: "fake", toNumber: DELI, isOwner: false, goal: "Place a pickup order", facts: [] });
  db.updateCall(OMARI, call.id, { state: "completed", outcome_kind: kind });
  if (commitment) db.createCommitment(OMARI, { callId: call.id, ...commitment });
  return call;
}
test("no online ordering: the phone order for pickup is offered once, placed by the call, and recorded with the restaurant's own quote", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  const offer = await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH }, ctx);
  assert.equal(offer.offer, true, JSON.stringify(offer));
  assert.match(offer.say, /phone the order in for pickup and they pay at the counter/);
  // The call's fields come with the offer, so the offer can be the call's own confirm ask: one yes.
  assert.equal(offer.call_place.to, DELI);
  assert.match(offer.say, /their one yes covers the call/);
  assert.equal((await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH }, ctx)).offered_already, true, "offered once");
  const yes = await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH, they_said_yes: true }, ctx);
  assert.equal(yes.ok, true, JSON.stringify(yes));
  const c = yes.call_place;
  assert.equal(c.to, DELI);
  assert.equal(c.may_book, true);
  assert.match(c.goal, /under the name Omari: Turkey club\. Pickup around 6:30\. Payment is at the counter/);
  assert.ok(c.facts.includes("Paying at the counter on pickup."));
  assert.ok(!/card|\d{12,}/i.test(JSON.stringify(c.facts)), "no card detail is ever in what the call may say");
  assert.equal(food.orderRow(st.order_id, OMARI).fulfillment, "phone");
  // The call (placed through call_place, by the model) agrees the order: ready 6:30, $14.50 quoted.
  clock.skip(5 * 60_000);
  finishedCall({ commitment: { what: "Turkey club for pickup under Omari", totalCents: 1450, state: "committed", readback: { time: { kind: "time", exact: "18:30", spoken: "6:30" }, price: { kind: "price", exact: 1450, spoken: "fourteen fifty" } } } });
  const n = said.length;
  await food.sweep();
  const o = food.orderRow(st.order_id, OMARI);
  assert.equal(o.status, "placed");
  assert.equal(o.phone.outcome, "placed_by_phone");
  assert.equal(o.phone.ready, "6:30");
  assert.equal(o.phone.quoted, "$14.50");
  assert.equal(o.phone.quoted_by, "the restaurant, on the phone");
  assert.equal(o.paid_amount, "", "nothing charged by Reason");
  assert.equal(food.phoneRecordLine(o), "Best Stop Deli: placed by phone for pickup under Omari, ready 6:30; total quoted by the restaurant on the phone: $14.50, paid at the counter.");
  assert.equal(reacts.at(-1).reaction, "✅");
  assert.equal(said.length, n, "the call's own report says it; nothing doubled by code");
  // The restaurant's quote, said as theirs, passes the reply check as sourced.
  offers.startTurn?.(OMARI, "did the deli take it?");
  const g = offers.guardReply(OMARI, "They took it: ready at 6:30, and they quoted $14.50, paid at the counter.", { turnReply: true });
  assert.equal(g.changed, false, JSON.stringify(g.flags));
  assert.equal(g.recompose, null);
  const h = await runTool("food_order", { action: "history" }, ctx);
  assert.match(h.usual[0].last_two[0].by_phone, /quoted by the restaurant on the phone: \$14\.50/);
});

test("a place that wants a card over the phone: the order stops there, nothing placed, said once in plain words", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH }, ctx);
  await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH, they_said_yes: true }, ctx);
  clock.skip(60_000);
  finishedCall({ kind: "needs_owner", commitment: { what: "Turkey club, prepaid by card over the phone", state: "declined", why: "they wanted payment details: card number" } });
  await food.sweep(); await food.sweep();
  const o = food.orderRow(st.order_id, OMARI);
  assert.equal(o.status, "needs");
  assert.equal(o.phone.outcome, "card_on_phone");
  assert.equal(said.filter((s) => /card over the phone/.test(s.t)).length, 1);
  assert.equal(said.at(-1).t, "Best Stop Deli wanted a card over the phone, and I never give card details on a call, so the order wasn't placed. Nothing was charged. I can order online from another place instead.");
  assert.equal(reacts.at(-1).reaction, "❓");
});

test("the no-call hours block the phone order after 9pm on the place's clock, said plainly with what can be done instead", async () => {
  clock.skip(Date.parse("2026-11-18T03:30:00Z") - clock.now()); // 10:30pm in New York
  const st = await runTool("food_order", { action: "start" }, ctx);
  const offer = await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH }, ctx);
  assert.equal(offer.blocked_line, "Best Stop Deli is closed to calls from me until 8am their time (it's 10:30pm there).");
  assert.match(offer.say, /ordering online from another nearby place now, or phoning this one at 8am their time/);
  const yes = await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH, they_said_yes: true }, ctx);
  assert.equal(yes.ok, false);
  assert.equal(yes.error, "call_hours");
  assert.equal(yes.call_place, undefined, "no call handed over");
  assert.equal(food.orderRow(st.order_id, OMARI).fulfillment, "delivery", "nothing recorded as a phone order");
});

test("a phone order whose call goes unanswered waits on them, and the call's own report is the only word", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "phone", order_id: st.order_id, ...SANDWICH, they_said_yes: true }, ctx);
  clock.skip(60_000);
  const call = db.createCall(OMARI, { provider: "fake", toNumber: DELI, isOwner: false, goal: "x", facts: [] });
  await food.sweep();
  assert.equal(food.orderRow(st.order_id, OMARI).status, "building", "a call still going is waited on");
  // A new request while that call is going leaves this order alone (a call is never let go from here).
  db.updateCall(OMARI, call.id, { state: "in_progress" });
  await food.closeStale(OMARI);
  assert.equal(food.orderRow(st.order_id, OMARI).status, "building");
  db.updateCall(OMARI, call.id, { state: "completed", outcome_kind: "no_answer" });
  const n = said.length;
  await food.sweep();
  assert.equal(food.orderRow(st.order_id, OMARI).status, "needs");
  assert.equal(said.length, n);
});
