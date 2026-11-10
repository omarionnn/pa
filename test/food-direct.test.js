// Ordering direct (owner, 2026-11-10): the restaurant's own online ordering (Toast, Square Online,
// ChowNow, Olo, Clover, BentoBox, Owner.com, its own site) first; DoorDash, Uber Eats, Grubhub only
// when the place has none or they ask for the app. Proved here, offline, on the real food + checkout path:
//   1. a direct link known for the restaurant → an app cart is refused (unless they chose the app);
//   2. no direct link checked → the app cart is refused until the model looked; none found → the app;
//   3. the "why it's cheaper" line goes on the FIRST direct order's ask only, never on an app order,
//      never twice, and never with a number in it;
//   4. a checkout runs where the cart was built; a shared ordering host is keyed per restaurant.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-fooddirect-"));
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
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "spend", "food_orders", "food_notes", "food_places", "food_told", "confirmations"]) { try { db.db.exec(`DELETE FROM ${t}`); } catch { /* table made later */ } }
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_secret_4821', 'visa', '4821', ?, 1)").run(OMARI, clock.now());
  // Signed in to DoorDash already, so the checkout starts in their profile.
  q("INSERT OR REPLACE INTO shop_profiles (conversation_id, profile_id, created_at) VALUES (?, 'prof_1', ?)").run(OMARI, clock.now());
  try { shop.markConnected(OMARI, "doordash"); } catch { /* fine */ }
  db.upsertThread({ conversationId: OMARI, channel: "fake", address: "+15551110000", isOwner: true, service: "iMessage", lastInboundId: "H-req" });
  db.claimInbound({ channel: "fake", externalId: "H-req", conversationId: OMARI, text: "get me habibi, the usual" });
});

const CART = {
  // They asked for DoorDash themselves (ordering direct is test/food-direct.test.js).
  platform: "doordash", restaurant: "Habibi Halal", store_url: STORE, their_choice: true,
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

const TOAST = "https://order.toasttab.com/online/habibi-halal-bronx";
const TOAST2 = "https://order.toasttab.com/online/tacos-el-gordo";
const SQUARE = "https://habibi-halal.square.site/s/order";
const DIRECT_CART = { ...CART, store_url: TOAST, their_choice: undefined };
const ctx = { conversationId: OMARI };

/** start → cart on `url` → store_checkout through the tool (linked) → the run reaches payment. */
async function directToPayment({ cart = DIRECT_CART, startUrl = cart.store_url, store = cart.restaurant, value = "31.42" } = {}) {
  const st = await runTool("food_order", { action: "start" }, ctx);
  const ct = await runTool("food_order", { action: "cart", order_id: st.order_id, ...cart }, ctx);
  assert.equal(ct.ok, true, JSON.stringify(ct));
  const out = await runTool("store_checkout", { store, start_url: startUrl, what: "Chicken over rice (white sauce, no hot sauce), fries. Stop at payment.", item: `${cart.restaurant} order`, max_usd: 60, food_order_id: st.order_id }, { ...ctx, messages: asked([]) });
  assert.equal(out.ok, true, JSON.stringify(out));
  runs[out.run_id].requiredAction = PAY(`req_${out.run_id}`, value); runs[out.run_id].revision = 2;
  await shop.step(out.run_id);
  return { orderId: st.order_id, runId: out.run_id };
}

// ---------------------------------------------------------------- the route, by the link
test("ordering links: the restaurant's own ordering hosts are direct, the apps are platforms, a look-alike is neither", () => {
  for (const [url, via] of [[TOAST, "toast"], ["https://www.toasttab.com/local/order/maneros", "toast"], [SQUARE, "square"], ["https://ordering.chownow.com/order/29271/locations", "chownow"],
    ["https://sweetgreen.olo.com/menu", "olo"], ["https://www.clover.com/online-ordering/habibi", "clover"], ["https://habibi.getbento.com/online-ordering", "bentobox"],
    ["https://habibi.owner.com/order", "owner"], ["https://order.online/store/chiapparelli-159816", "storefront"], ["https://habibihalal.com/order", "own_site"],
    ["https://nottoasttab.com/x", "own_site"]]) {
    const r = food.orderingRoute(url);
    assert.equal(r.route, "direct", url);
    assert.equal(r.via, via, url);
  }
  for (const [url, p] of [[STORE, "doordash"], ["https://www.ubereats.com/store/habibi/abc", "ubereats"], ["https://www.grubhub.com/restaurant/habibi/1", "grubhub"], ["https://www.seamless.com/menu/x", "grubhub"], ["https://postmates.com/store/x", "ubereats"]]) {
    assert.deepEqual([food.orderingRoute(url).route, food.orderingRoute(url).platform], ["platform", p], url);
  }
  assert.equal(food.orderingRoute("habibi halal"), null);
  assert.equal(food.orderingRoute("javascript:alert(1)"), null);
});

test("a direct link known for the restaurant: the DoorDash cart is refused and nothing recorded; their own choice of the app is respected", async () => {
  const kept = await runTool("food_order", { action: "place", restaurant: "Habibi Halal", store_url: TOAST, menu_checked: true }, ctx);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(kept.route, "direct");
  const st = await runTool("food_order", { action: "start" }, ctx);
  const app = await runTool("food_order", { action: "cart", order_id: st.order_id, ...CART, their_choice: undefined }, ctx);
  assert.equal(app.ok, false);
  assert.equal(app.error, "direct_exists");
  assert.equal(app.direct_url, TOAST);
  assert.equal(food.ownOrder(OMARI, st.order_id).items.length, 0, "nothing was recorded");
  // A place named a little differently is the same place.
  const app2 = await runTool("food_order", { action: "cart", order_id: st.order_id, ...CART, restaurant: "habibi halal!", their_choice: undefined }, ctx);
  assert.equal(app2.error, "direct_exists");
  // They asked for DoorDash themselves: that is their call.
  const theirs = await runTool("food_order", { action: "cart", order_id: st.order_id, ...CART, their_choice: true }, ctx);
  assert.equal(theirs.ok, true, JSON.stringify(theirs));
  assert.equal(food.ownOrder(OMARI, st.order_id).route, "platform");
  assert.equal(food.ownOrder(OMARI, st.order_id).platform, "doordash");
});

test("no direct link checked yet: the app is refused until the model looked; a place with none falls back to the app", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  const first = await runTool("food_order", { action: "cart", order_id: st.order_id, ...CART, their_choice: undefined }, ctx);
  assert.equal(first.error, "check_direct_first");
  assert.match(first.say, /order online/);
  // An app page is never kept as the restaurant's own ordering.
  const wrong = await runTool("food_order", { action: "place", restaurant: "Habibi Halal", store_url: STORE }, ctx);
  assert.equal(wrong.error, "platform_link");
  const none = await runTool("food_order", { action: "place", restaurant: "Habibi Halal", no_direct: true }, ctx);
  assert.equal(none.ok, true);
  const fallback = await runTool("food_order", { action: "cart", order_id: st.order_id, ...CART, their_choice: undefined }, ctx);
  assert.equal(fallback.ok, true, JSON.stringify(fallback));
  assert.equal(fallback.route, "DoorDash");
  assert.deepEqual(food.history(OMARI).places, [{ restaurant: "Habibi Halal", own_ordering: "none found" }]);
});

test("a direct cart is kept as the restaurant's ordering link in their history; another person never sees it", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  const ct = await runTool("food_order", { action: "cart", order_id: st.order_id, ...DIRECT_CART }, ctx);
  assert.equal(ct.ok, true, JSON.stringify(ct));
  assert.equal(ct.route, "direct (Toast)");
  assert.deepEqual(food.history(OMARI).places, [{ restaurant: "Habibi Halal", order_direct_at: TOAST, menu_checked: false }]);
  assert.deepEqual(food.history(AMA).places, []);
  assert.equal(food.placeFor(AMA, "Habibi Halal"), null);
});

// ---------------------------------------------------------------- the checkout on the direct site
test("the checkout runs where the cart was built, and a shared ordering host is keyed per restaurant", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...DIRECT_CART }, ctx);
  const elsewhere = await runTool("store_checkout", { store: "DoorDash", start_url: STORE, what: "Chicken over rice. Stop at payment.", item: "Habibi Halal order", max_usd: 60, food_order_id: st.order_id }, { ...ctx, messages: asked([]) });
  assert.equal(elsewhere.error, "start_url_elsewhere");
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, 0, "nothing started");
  const ok = await runTool("store_checkout", { store: "Habibi Halal", start_url: TOAST, what: "Chicken over rice. Stop at payment.", item: "Habibi Halal order", max_usd: 60, food_order_id: st.order_id }, { ...ctx, messages: asked([]) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.plan, "guest", "a restaurant's own ordering checks out as a guest");
  const run = q("SELECT store FROM shop_runs WHERE run_id = ?").get(ok.run_id);
  assert.equal(run.store, "habibihalaltoast");
  assert.equal(shop.storeName(run.store), "Habibi Halal");
  // A second Toast restaurant is its own store, with its own name.
  assert.equal(food.directStoreKey("Tacos El Gordo", TOAST2), "tacoselgordotoast");
  assert.equal(food.directStoreKey("Habibi Halal", "https://habibihalal.com/order"), null, "its own site keeps the site's own key");
  assert.equal(food.directStoreKey("Habibi Halal", STORE), null);
});

// ---------------------------------------------------------------- why it's cheaper: once, direct only, no numbers
test("the first direct order's ask says why it's cheaper, once, before the money line; the next direct order doesn't repeat it", async () => {
  const first = await directToPayment();
  const line = food.whyDirectLine("Habibi Halal");
  assert.equal(said.at(-1).t, `${line} $31.42 to your Visa 4821, here by 8:15. Place it?`);
  assert.equal(line, "I'm ordering straight from Habibi Halal, not through a delivery app: no app menu markup, no app service fee, and more of what you pay goes to them.");
  assert.doesNotMatch(line, /\d|\$|%/, "never a number: no saving was measured");
  await shop.letGo(first.runId, "test: that one is over");
  said.length = 0;
  await directToPayment({ cart: { ...DIRECT_CART, store_url: SQUARE, total: "18.40" }, value: "18.40" });
  assert.equal(said.at(-1).t, "$18.40 to your Visa 4821, here by 8:15. Place it?", "said once, never again");
});

test("an app order never gets the cheaper line, even as their first order, and it is still owed on the first direct one", async () => {
  await runTool("food_order", { action: "place", restaurant: "Habibi Halal", no_direct: true }, ctx);
  await toPayment();
  assert.equal(said.at(-1).t, "$31.42 to your Visa 4821, here by 8:15. Place it?");
  assert.equal(food.toldPerson(OMARI, "why_direct"), false);
  const why = await runTool("food_order", { action: "why_direct", why_reason: "asked" }, ctx);
  assert.equal(why.direct, false);
  assert.equal(why.line, undefined, "nothing cheaper to claim about an app order");
  said.length = 0;
  await directToPayment({ cart: { ...DIRECT_CART, restaurant: "Tacos El Gordo", store_url: TOAST2 } });
  assert.match(said.at(-1).t, /^I'm ordering straight from Tacos El Gordo/);
});

test("a cart built direct but a checkout that somehow runs off it gets no cheaper line", async () => {
  const st = await runTool("food_order", { action: "start" }, ctx);
  await runTool("food_order", { action: "cart", order_id: st.order_id, ...DIRECT_CART }, ctx);
  // Code started it on DoorDash (not through the tool's gate): the line must not claim direct.
  const out = await shop.startCheckout({ conversationId: OMARI, store: "doordash", startUrl: STORE, what: "x. Stop at payment.", item: "Habibi Halal order", maxUsd: 60 });
  assert.equal(food.linkRun(OMARI, st.order_id, out.runId), true);
  runs[out.runId].requiredAction = PAY("req_1", "31.42"); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(said.at(-1).t, "$31.42 to your Visa 4821, here by 8:15. Place it?");
  assert.equal(food.toldPerson(OMARI, "why_direct"), false);
});

test("they ask why not DoorDash: the line from the record, every time they ask; an app suggestion after it was said gets no repeat", async () => {
  await runTool("food_order", { action: "place", restaurant: "Habibi Halal", store_url: TOAST }, ctx);
  const asked1 = await runTool("food_order", { action: "why_direct", restaurant: "Habibi Halal", why_reason: "suggested_app" }, ctx);
  assert.equal(asked1.line, food.whyDirectLine("Habibi Halal"));
  assert.match(asked1.say, /Never a dollar saving or an app's price unless a tool showed you both totals/);
  const again = await runTool("food_order", { action: "why_direct", restaurant: "Habibi Halal", why_reason: "suggested_app" }, ctx);
  assert.equal(again.already_told, true);
  assert.equal(again.line, undefined);
  assert.match(again.say, /respect it/);
  const asked2 = await runTool("food_order", { action: "why_direct", restaurant: "Habibi Halal", why_reason: "asked" }, ctx);
  assert.equal(asked2.line, food.whyDirectLine("Habibi Halal"), "they asked: answer");
  // Once told by the tool, the first direct card doesn't say it again.
  await directToPayment();
  assert.equal(said.at(-1).t, "$31.42 to your Visa 4821, here by 8:15. Place it?");
});

// ---------------------------------------------------------------- the model's rules and tool
test("the rules and the tool say direct first, the app as fallback, their choice respected, no invented numbers", async () => {
  const rules = food.FOOD_RULES;
  assert.match(rules, /RESTAURANT'S OWN online ordering first/);
  assert.match(rules, /only when the place has no ordering of its own, or when they ask for the app/);
  assert.match(rules, /Never state a dollar saving or an app's price unless a tool showed you both totals/);
  assert.doesNotMatch(rules, /Platform: the one they're signed into/);
  const def = food.FOOD_TOOL_DEFS[0];
  assert.ok(def.input_schema.properties.action.enum.includes("place") && def.input_schema.properties.action.enum.includes("why_direct"));
  assert.ok(food.FOOD_SCHEMAS.food_order.safeParse({ action: "place", restaurant: "x", no_direct: true }).success);
  // Off for someone else: no tool, no rules.
  assert.equal(food.foodToolVisible("food_order", AMA), false);
  assert.equal(food.foodRules({ isOperator: false }), "");
  assert.match(food.foodRules({ isOperator: true }), /RESTAURANT'S OWN/);
});
