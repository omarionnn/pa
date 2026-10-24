// Verified offers and the purchase path they feed (2026-10-23): one pinned test per bug the audit
// raised and the code confirmed, plus the money paths the offer records now sit on. Fake AgentCard,
// no key, no network.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { startAgentCard } from "./fixture-agentcard.js";

const dir = mkdtempSync(join(tmpdir(), "reason-offers-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "22".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const agentcard = await import("../src/agentcard.js");
const db = await import("../src/db.js");
const offers = await import("../src/offers.js");
const { agentcardWebhookRequest } = await import("../src/http.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const ADDRESS = {
  address_street: "40 Washington Sq S", address_city: "New York", address_state: "NY",
  address_zip: "10012", address_phone: "+12025551234", address_name: "Omari Nyarko",
};
let fake;
let messages;
const owner = (t) => ({ role: "user", content: "[Sun, Oct 11, 2026, 3:00 PM] Omari: " + t });
const readsYes = async () => ({ verdict: "yes" });
const call = (name, input, extra = {}) => runTool(name, input, { conversationId: OMARI, messages, judge: readsYes, ...extra });

before(async () => {
  fake = await startAgentCard();
  config.agentcardClientId = "ac-client-abc";
  config.agentcardClientSecret = "ac-secret-xyz";
  config.agentcardApiBase = fake.url;
  config.agentcardWebhookSecret = "whsec_test";
  config.publicUrl = "";
});
after(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  clock.reset();
  agentcard.forgetAccessToken();
  db.db.exec(`DELETE FROM agentcard_users; DELETE FROM agentcard_purchases; DELETE FROM agentcard_events;
    DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend;
    DELETE FROM spend_caps; DELETE FROM permissions; DELETE FROM conversations; DELETE FROM unknown_outcomes;
    DELETE FROM offers; DELETE FROM timers;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.setSpendCaps(OMARI, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "fifty a thing" });
  messages = [owner("get me a bag of coffee")];
  fake.set({ ask: "cart", confirms: ["placed"], sessionStatus: "pending", sessionUser: "usr_8f3k2m", knownUsers: ["usr_8f3k2m"], cardsByUser: null, trackEmpty: false, exchange: "ok", conversation: null });
  for (const k of ["asks", "confirmCalls", "vaultSessions", "buyTokenCalls", "cardReads", "exchanges", "refreshes", "tokenCalls", "convReads"]) fake.state[k].length = 0;
  for (const k of ["exchanged", "liveRefresh", "tokenUser", "liveOrgTokens", "liveBuyTokens"]) fake.state[k].clear();
  offers.beginTurn(OMARI, "get me a bag of coffee");
});

async function enroll() {
  const link = await call("vault_enroll", {});
  assert.equal(link.ok, true, JSON.stringify(link));
  fake.set({ sessionStatus: "linked", sessionUser: "usr_8f3k2m" });
}
async function shop(extra = {}) {
  const out = await call("purchase", { ask: "a bag of colombian coffee", ...ADDRESS, ...extra });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}
async function yesFor(conv, hash) {
  const refused = await call("purchase_confirm", { conversation_id: conv, cart_hash: hash });
  assert.ok(refused.use_target, JSON.stringify(refused));
  const req = await call("confirm_request", { action: "purchase_confirm", summary: "Buy the coffee from Amazon for $23.06?", stakes: "money", amount: 23.06, target: refused.use_target });
  assert.ok(req.confirmation_id, JSON.stringify(req));
  messages.push(owner("yes buy it"));
  const granted = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(granted.state, "granted", JSON.stringify(granted));
  return { id: req.confirmation_id, req };
}
const sign = (body, t = Math.floor(clock.now() / 1000)) => ({ "agentcard-signature": "t=" + t + ",v1=" + createHmac("sha256", "whsec_test").update(t + "." + body).digest("hex") });
const deliver = (event) => { const raw = JSON.stringify(event); return agentcardWebhookRequest({ rawBody: raw, headers: sign(raw) }); };

// ---------- 2a: an offer record is written from the page, and only from the page ----------

const PAGE = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Cafe Mesa Colombian Ground Coffee, 16 oz","sku":"B07ZQ5C4RB","offers":{"@type":"Offer","price":"22.50","priceCurrency":"USD","availability":"https://schema.org/InStock","seller":{"@type":"Organization","name":"Cafe Mesa"}}}</script></head><body>Cafe Mesa $22.50</body></html>';

test("offerFromHtml: what the markup states is verified, what it does not is unverified and empty", () => {
  const rec = offers.offerFromHtml(PAGE, "https://www.amazon.com/dp/B07ZQ5C4RB", 1000);
  assert.equal(rec.price_cents, 2250);
  assert.equal(rec.stock, "in stock");
  assert.equal(rec.seller, "Cafe Mesa");
  assert.equal(rec.shipping_cents, null, "no shipping in the markup, so none is invented");
  assert.equal(rec.return_terms, "");
  assert.deepEqual(rec.unverified, ["shipping cost", "shipping time", "return terms"]);
  const bare = offers.offerFromHtml("<html><body>Great coffee only $9.99!</body></html>", "https://x.example/p", 1000);
  assert.equal(bare.price_cents, null, "a price in prose is not machine-readable markup, so it stays unverified");
  assert.ok(bare.unverified.includes("price"));
});

test("offer_check saves the record with fetched_at and hands back 'unverified' for missing fields", async () => {
  const fetchImpl = async (url) => ({ ok: true, status: 200, url, text: async () => PAGE });
  const out = await call("offer_check", { url: "https://www.amazon.com/dp/B07ZQ5C4RB" }, { fetchImpl });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.offer.price, "$22.50");
  assert.equal(out.offer.shipping_cost, "unverified");
  assert.equal(out.offer.return_terms, "unverified");
  const row = db.getOffer(OMARI, out.offer.offer_id);
  assert.equal(row.url, "https://www.amazon.com/dp/B07ZQ5C4RB");
  assert.ok(row.fetched_at > 0);
  const blocked = await call("offer_check", { url: "https://www.amazon.com/dp/X" }, { fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }) });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /nothing on that page is verified/);
});

// ---------- 2c: the reply check ----------

test("guardReply labels a dollar figure no source carried, and leaves sourced ones alone", () => {
  offers.beginTurn("c1", "my budget is $40");
  offers.noteSource("c1", { cart: { total: "$23.06" } });
  const g = offers.guardReply("c1", "it's $23.06 all in, well under your $40. shipping is usually $5.99");
  assert.equal(g.text, "it's $23.06 all in, well under your $40. shipping is usually $5.99 (unverified)");
  const ok = offers.guardReply("c1", "about $7 (unverified) for shipping");
  assert.equal(ok.changed, false, "already labelled");
});

test("guardReply: a coupon claim with no live source this turn gets a plain line; with one it does not", () => {
  offers.beginTurn("c2", "");
  offers.noteSource("c2", { text: "Cafe Mesa coffee $22.50" });
  const g = offers.guardReply("c2", "there's a coupon on it too");
  assert.match(g.text, /didn't find a live source for any coupon/);
  offers.noteSource("c2", { text: "Clip coupon: save 15%" });
  assert.equal(offers.guardReply("c2", "there's a coupon on it too").changed, false);
});

test("guardReply: 'best deal' needs two verified offers this turn, else it says what was compared", () => {
  offers.beginTurn("c3", "");
  offers.noteOffer("c3", { seller: "Amazon", price_cents: 2250 });
  offers.noteSource("c3", "$22.50");
  const one = offers.guardReply("c3", "amazon is the best deal at $22.50");
  assert.match(one.text, /not a checked best price — i only looked at Amazon: \$22\.50/);
  offers.noteOffer("c3", { seller: "Walmart", price_cents: 2499 });
  offers.noteSource("c3", "$24.99");
  const two = offers.guardReply("c3", "amazon is the best deal at $22.50");
  assert.match(two.text, /compared: Amazon \$22\.50, Walmart \$24\.99/);
});

// ---------- 2b / 3b: the money ask carries the offer record ----------

test("the purchase ask carries merchant, items, AgentCard's all-in total, the address and the source", async () => {
  await enroll();
  const cart = await shop();
  const { req } = await yesFor(cart.conversation_id, cart.cart_hash);
  assert.match(req.say_with_ask, /^Amazon: Cafe Mesa/);
  assert.match(req.say_with_ask, /total \$23\.06 — AgentCard's all-in total, incl\. \$0\.56 fees/);
  assert.match(req.say_with_ask, /ships to Omari Nyarko, 40 Washington Sq S, New York, NY 10012/);
  assert.match(req.say_with_ask, /delivery: not quoted before ordering/);
  assert.match(req.say_with_ask, /source: https:\/\/www\.amazon\.com\/dp\/B07ZQ5C4RB/);
  assert.equal(req.offer.total_label, "AgentCard's all-in total");
  // A reply that asks without the total and source gets the record added by code.
  const g = offers.guardReply(OMARI, "want me to grab it?");
  assert.ok(g.text.includes(req.say_with_ask), g.text);
  const fine = offers.guardReply(OMARI, "buy it? " + req.say_with_ask);
  assert.ok(!fine.flags.some(f => f.rule === "ask_without_offer"));
});

// Pinned: purchase_confirm's schema had no address fields, so the confirm always went out with
// delivery_address null — against AgentCard's every-call rule.
test("pinned: the confirm sends the same delivery address the cart was built with", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  const out = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(fake.state.confirmCalls[0].delivery_address, {
    street: "40 Washington Sq S", city: "New York", state: "NY", zip: "10012", phone: "+12025551234", name: "Omari Nyarko",
  });
});

test("a later purchase turn with no address re-sends the one on the row", async () => {
  await enroll();
  const cart = await shop();
  await call("purchase", { ask: "make it two bags", conversation_id: cart.conversation_id });
  assert.equal(fake.state.asks.at(-1).delivery_address.zip, "10012");
});

// ---------- 3a: a picked offer is named in the ask and the cart is matched by product id ----------

test("picking a catalog offer sends its product_id as the pick and names it in the ask; a matching cart goes on", async () => {
  await enroll();
  fake.set({ ask: "needs_input" });
  const first = await call("purchase", { ask: "colombian coffee", ...ADDRESS });
  const offerId = first.catalog.items[0].offer_id;
  assert.ok(offerId, JSON.stringify(first.catalog));
  fake.set({ ask: "cart" });
  const out = await call("purchase", { ask: "that one", conversation_id: first.conversation_id, offer_id: offerId });
  assert.equal(out.ok, true, JSON.stringify(out));
  const sent = fake.state.asks.at(-1);
  assert.deepEqual(sent.pick, { product_id: "https://www.amazon.com/dp/B07ZQ5C4RB" });
  assert.match(sent.ask, /exactly this product from Amazon: Cafe Mesa/);
  assert.equal(db.getAgentcardPurchase(first.conversation_id).offer_match, "match");
});

test("a cart whose product is not the picked offer stops, shows the difference, and cannot be confirmed", async () => {
  await enroll();
  const fetchImpl = async (url) => ({ ok: true, status: 200, url, text: async () => PAGE });
  const checked = await call("offer_check", { url: "https://www.amazon.com/dp/B07ZQ5C4RB" }, { fetchImpl });
  fake.set({ ask: "other" });
  const out = await call("purchase", { ask: "buy this coffee", ...ADDRESS, offer_id: checked.offer.offer_id });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "offer_mismatch");
  assert.equal(out.offered.url, "https://www.amazon.com/dp/B07ZQ5C4RB");
  assert.match(out.cart_has[0].name, /Amazon Fresh/);
  assert.match(out.error, /They picked: Cafe Mesa .* The cart has: Amazon Fresh/s);
  const conf = await call("purchase_confirm", { conversation_id: out.conversation_id, cart_hash: "0ther0ther0ther0", confirmation_id: 1 });
  assert.equal(conf.ok, false);
  assert.equal(fake.state.confirmCalls.length, 0, "nothing was confirmed");
});

// ---------- 3c: approvals, unknown charges, partial orders ----------

// Pinned: partially_placed was recorded but only 'placed' was refused, so the same cart could be
// bought again on a fresh yes.
test("pinned: a partially placed cart cannot be bought again", async () => {
  await enroll();
  const cart = await shop();
  fake.set({ confirms: ["partial"] });
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  const first = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(first.status, "partially_placed", JSON.stringify(first));
  const again = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(again.ok, false);
  // Either guard is a refusal; the row guard is the one that holds even with a new yes.
  const yes2 = await yesFor(cart.conversation_id, cart.cart_hash).catch(() => null);
  if (yes2) {
    const third = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes2.id });
    assert.equal(third.blocked, "already_placed", JSON.stringify(third));
  }
  assert.equal(fake.state.confirmCalls.length, 1, "one confirm, ever");
});

// Pinned: checkout_authorization.approved set authorization_state and nothing read it, so the
// purchase stalled at awaiting_approval.
test("pinned: an approval webhook wakes Reason to resend the SAME confirm, and the approval itself places nothing", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["approval_required", "placed"] });
  const paused = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(paused.blocked, "vault_approval_required");
  assert.match(paused.error, /authorization, not an order/);
  const res = await deliver({ id: "evt_ap", type: "checkout_authorization.approved", data: { user_id: "usr_8f3k2m", authorization_id: "cauth_" + cart.conversation_id } });
  assert.equal(res.body.matched, true);
  const timers = db.listTimers(OMARI);
  assert.equal(timers.length, 1, "one wake");
  assert.match(timers[0].note, new RegExp("conversation_id " + cart.conversation_id + ", cart_hash " + cart.cart_hash + " and confirmation_id " + id));
  assert.match(timers[0].note, /authorization, not an order/);
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "awaiting_approval", "still not an order");
  // The wake's confirm, with the same yes, places it.
  const done = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(fake.state.confirmCalls.length, 2);
  // A redelivery does not wake it twice.
  await deliver({ id: "evt_ap", type: "checkout_authorization.approved", data: { user_id: "usr_8f3k2m", authorization_id: "cauth_" + cart.conversation_id } });
  assert.equal(db.listTimers(OMARI).length, 1);
});

test("byoc_approval_required is a pause like the vault one: link relayed, yes kept", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["byoc_approval", "placed"] });
  const paused = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(paused.blocked, "vault_approval_required");
  assert.match(paused.approval_url, /authorize\?id=cauth_/);
  const done = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(done.ok, true, JSON.stringify(done));
});

test("an approved purchase that is not placed yet says so — never 'nothing was charged'", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["approval_required", "needs_input"] });
  await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  await deliver({ id: "evt_ap2", type: "checkout_authorization.approved", data: { user_id: "usr_8f3k2m", authorization_id: "cauth_" + cart.conversation_id } });
  const out = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(out.blocked, "approved_not_placed", JSON.stringify(out));
  assert.doesNotMatch(out.error, /nothing was charged/i);
});

test("charge_status unknown on a placed order: no retry, the conversation is read by order_id, and the unknown is said", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["charge_unknown"], conversation: "tracked" });
  const out = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.note, /whether the card was actually charged is NOT known/);
  assert.match(out.note, new RegExp("AgentCard lists order " + out.order_id + " at Amazon"));
  assert.doesNotMatch(out.note, /ordered and charged/);
  assert.deepEqual(fake.state.convReads, [cart.conversation_id]);
  assert.equal(fake.state.confirmCalls.length, 1);
});

test("declined with charge_status unknown is not 'nothing was charged', and blocks the retry", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["declined_unknown"] });
  const out = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(out.blocked, "charge_unknown", JSON.stringify(out));
  assert.doesNotMatch(out.error, /Nothing was charged/);
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "outcome_unknown");
  const again = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(again.ok, false);
  assert.equal(fake.state.confirmCalls.length, 1, "never retried");
});

test("a confirm that never answers is reconciled by reading the conversation; a listed order makes it placed", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  const t = config.agentcardTimeoutMs;
  config.agentcardTimeoutMs = 150;
  fake.set({ confirms: ["hang"] });
  let out;
  try {
    // The read after the hang answers normally; the hang is only on the confirm.
    fake.set({ conversation: { orders: [{ order_id: "order_77", status: "placed", merchant_name: "Amazon", total_cents: 2306 }] } });
    out = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  } finally { config.agentcardTimeoutMs = t; }
  assert.equal(out.blocked, "outcome_was_unknown", JSON.stringify(out));
  assert.equal(out.order_id, "order_77");
  const row = db.getAgentcardPurchase(cart.conversation_id);
  assert.equal(row.status, "placed");
  assert.equal(row.order_id, "order_77");
  assert.equal(fake.state.confirmCalls.length, 1, "read, never resent");
});

test("purchase_track with a conversation_id reads AgentCard's record and says plainly what is not known", async () => {
  await enroll();
  const cart = await shop();
  db.markAgentcardPurchase(cart.conversation_id, { status: "outcome_unknown" });
  const out = await call("purchase_track", { conversation_id: cart.conversation_id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.placed, null);
  assert.match(out.note, /lists no order .* not proof nothing was charged/s);
  assert.equal(fake.state.confirmCalls.length, 0);
});



// ---------- 2c gap: a message sent mid-turn passes the same figures check as the reply ----------

// Pinned: message_send went out without guardReply, so a remembered figure texted mid-turn was sent
// as fact while the same figure in the reply would have been labelled.
test("pinned: message_send to their own person labels an unsourced dollar figure, the same as the reply", async () => {
  const sent = [];
  const channels = { list: () => [{ name: "test" }], send: async (m) => { sent.push(m); return { ok: true, delivered: true }; } };
  offers.noteSource(OMARI, { cart: { total: "$23.06" } });
  const out = await call("message_send", { to: "owner", text: "found it — $23.06 all in, and shipping is usually $5.99" }, { channels });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\$23\.06 all in/);
  assert.doesNotMatch(sent[0].text, /\$23\.06 \(unverified\)/, "a sourced figure is left alone");
  assert.match(sent[0].text, /\$5\.99 \(unverified\)/, "what was sent is the labelled text");
  assert.ok(out.figures_labelled?.some(f => f.rule === "dollar_unsourced"));
  // The ask line is the reply's to carry, never glued onto a mid-turn message.
  offers.noteAsk(OMARI, { line: "ASK-LINE", total: "$99.00", url: "https://x.test/p" });
  await call("message_send", { to: "owner", text: "one sec, checking the cart" }, { channels });
  assert.doesNotMatch(sent[1].text, /ASK-LINE/);
});

test("pinned: message_send to somebody else with an unsourced figure is refused and sends nothing", async () => {
  const sent = [];
  const channels = { list: () => [{ name: "test" }], send: async (m) => { sent.push(m); return { ok: true, delivered: true }; } };
  const text = "hi, this is Reason, Omari's assistant — the speaker is $49.99 at best buy, cheapest anywhere";
  const req = await call("confirm_request", { action: "message_send", summary: "Text +12025550111 about the speaker?", stakes: "reach", target: "+12025550111" });
  assert.ok(req.confirmation_id, JSON.stringify(req));
  messages.push(owner("yes send it"));
  const granted = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(granted.state, "granted", JSON.stringify(granted));
  const out = await call("message_send", { to: "+12025550111", text, confirmation_id: req.confirmation_id }, { channels });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "unchecked_figures", JSON.stringify(out));
  assert.match(out.error, /Not sent/);
  assert.equal(sent.length, 0, "nothing handed to a channel");
});



// ---------- step 5: the handoff when it cannot be bought ----------

const { handoffFor, cartLinkFromHtml } = await import("../src/handoff.js");
const SHOPIFY_PAGE = '<html><head><link rel="preconnect" href="https://cdn.shopify.com"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Ceramic Pour-Over","sku":"PO-1","offers":[{"@type":"Offer","price":"38.00","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"https://shop.example.com/products/pour-over?variant=40112233445566"}]}</script></head></html>';
const SHOPIFY_TWO = SHOPIFY_PAGE.replace(']}</script>', ',{"@type":"Offer","price":"42.00","url":"https://shop.example.com/products/pour-over?variant=40112233445577"}]}</script>');

test("cart links: a Shopify cart permalink only when the page pins one variant; never for a non-Shopify page", () => {
  assert.equal(cartLinkFromHtml(SHOPIFY_PAGE, "https://shop.example.com/products/pour-over"), "https://shop.example.com/cart/40112233445566:1?storefront=true");
  assert.equal(cartLinkFromHtml(SHOPIFY_TWO, "https://shop.example.com/products/pour-over"), "", "two variants and none in the url: ambiguous, no cart link");
  assert.equal(cartLinkFromHtml(SHOPIFY_TWO, "https://shop.example.com/products/pour-over?variant=40112233445577"), "https://shop.example.com/cart/40112233445577:1?storefront=true");
  assert.equal(cartLinkFromHtml(PAGE, "https://www.amazon.com/Cafe-Mesa/dp/B07ZQ5C4RB?ref=x"), "", "Amazon gets no add-to-cart link");
});

test("a handoff carries one link and what it opens, verified vs unverified from the record, one next step, and never a transferred cart", () => {
  const amazon = db.saveOffer(OMARI, offers.offerFromHtml(PAGE, "https://www.amazon.com/Cafe-Mesa/dp/B07ZQ5C4RB?ref=sr_1", clock.now()));
  const h = handoffFor(amazon, { why: "AgentCard could not be reached" });
  assert.equal(h.link.kind, "product_page");
  assert.equal(h.link.url, "https://www.amazon.com/dp/B07ZQ5C4RB", "Amazon's canonical product page");
  assert.match(h.link.opens, /Nothing is in their cart/);
  assert.deepEqual(h.verified.map(v => v.field), ["price", "seller", "stock"]);
  assert.equal(h.verified[0].value, "$22.50");
  assert.ok(h.verified.every(v => v.source && v.read_at));
  assert.deepEqual(h.unverified, ["shipping cost", "shipping time", "return terms"]);
  assert.equal(typeof h.next_step, "string");
  assert.equal(h.next_step.split(/(?<=\.)\s/).length, 1, "exactly one next step");
  assert.equal(h.cart_transferred, false);
  assert.equal(h.reason_browser_cart, undefined);
  // A cart in Reason's own browser on that site is said to stay there.
  const inBrowser = handoffFor(amazon, { reasonCartOn: "www.amazon.com" });
  assert.match(inBrowser.reason_browser_cart, /stays in Reason's browser profile — it is NOT in their Amazon account/);
  assert.match(inBrowser.say, /opens the site, not that cart/);
  assert.match(inBrowser.say, /Never say or imply a cart is ready/);
});

test("offer_check on a Shopify page stores the cart permalink; shop_handoff hands back an add-to-cart link that is a NEW cart", async () => {
  const fetchImpl = async (u) => ({ ok: true, status: 200, url: String(u), text: async () => SHOPIFY_PAGE });
  const checked = await call("offer_check", { url: "https://shop.example.com/products/pour-over" }, { fetchImpl });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const out = await call("shop_handoff", { offer_id: checked.offer.offer_id, why: "they'd rather order it themselves" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.handoff.link.kind, "add_to_cart");
  assert.equal(out.handoff.link.url, "https://shop.example.com/cart/40112233445566:1?storefront=true");
  assert.match(out.handoff.link.opens, /a NEW cart .* not anything Reason filled/);
  assert.equal(out.handoff.cart_transferred, false);
  assert.equal((await call("shop_handoff", { offer_id: 999999 })).ok, false, "no offer, no made-up handoff");
});

// Pinned (audit: "AgentCard failures hand nothing back"): a failed purchase used to return one
// error sentence. Now the picked offer comes back as a handoff.
test("pinned: AgentCard unreachable on a picked offer hands the offer back, not just an error", async () => {
  await enroll();
  await shop(); // connected first: the exchange is done, so what fails below is AgentCard itself
  const picked = db.saveOffer(OMARI, offers.offerFromHtml(PAGE, "https://www.amazon.com/dp/B07ZQ5C4RB", clock.now()));
  const base = config.agentcardApiBase;
  config.agentcardApiBase = "http://127.0.0.1:9"; // nothing listens
  let out;
  try { out = await call("purchase", { ask: "this coffee", offer_id: picked.id, ...ADDRESS }); }
  finally { config.agentcardApiBase = base; }
  assert.equal(out.ok, false);
  assert.match(out.error, /Could not reach AgentCard/);
  assert.equal(out.handoff?.link.url, "https://www.amazon.com/dp/B07ZQ5C4RB", JSON.stringify(out));
  assert.equal(out.handoff.cart_transferred, false);
});

test("pinned: buying not set up, with a picked offer, still hands the offer over", async () => {
  const picked = db.saveOffer(OMARI, offers.offerFromHtml(PAGE, "https://www.amazon.com/dp/B07ZQ5C4RB", clock.now()));
  const id = config.agentcardClientId;
  config.agentcardClientId = "";
  let out;
  try { out = await call("purchase", { ask: "this coffee", offer_id: picked.id, ...ADDRESS }); }
  finally { config.agentcardClientId = id; }
  assert.equal(out.status, "not_configured");
  assert.equal(out.handoff?.link.kind, "product_page");
});

test("pinned: a declined confirm hands over the cart's offer; an unknown outcome never does", async () => {
  await enroll();
  const cart = await shop();
  const { id } = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["unavailable"] });
  const declined = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: id });
  assert.equal(declined.blocked, "declined", JSON.stringify(declined));
  assert.ok(declined.handoff, "declined carries a handoff");
  assert.equal(declined.handoff.verified[0].field, "price");
  assert.match(declined.handoff.verified[0].value, /AgentCard's all-in total/);
  assert.equal(declined.handoff.cart_transferred, false);

  const cart2 = await shop();
  const y2 = await yesFor(cart2.conversation_id, cart2.cart_hash);
  fake.set({ confirms: ["declined_unknown"] });
  const unknown = await call("purchase_confirm", { conversation_id: cart2.conversation_id, cart_hash: cart2.cart_hash, confirmation_id: y2.id });
  assert.equal(unknown.blocked, "charge_unknown");
  assert.equal(unknown.handoff, undefined, "a link to buy it again is how somebody pays twice");
});

