// Step 4 (2026-10-23): the whole purchase loop, offline, through the real code — the sandbox proof
// that could not be run live because this install has no AgentCard sandbox credentials (the pair in
// .env and on Hetzner introspects as test_mode:false at GET /api/v2). One loop, start to end:
//
//   ask → catalog offer picked by offer_id → cart → yes pinned to the cart hash → confirm →
//   passkey pause (authorization_id) → SIGNED checkout_authorization.approved POSTed to the real
//   HTTP server → wake → the same confirm, whose answer is DROPPED → unknown outcome → reconciled by
//   reading the conversation (never resent) → SIGNED order.placed / order.confirmed keyed on
//   data.order_id → the row carries the order's state.
//
// Fake AgentCard (test/fixture-agentcard.js), no key, no network beyond 127.0.0.1. What this proves
// is wiring: each event family keyed on its documented id, and the money path holding. It proves
// nothing about a merchant fulfilling an order — and neither would sandbox.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { startAgentCard } from "./fixture-agentcard.js";

const dir = mkdtempSync(join(tmpdir(), "reason-loop-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "33".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const agentcard = await import("../src/agentcard.js");
const db = await import("../src/db.js");
const offers = await import("../src/offers.js");
const { createServer } = await import("../src/http.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const ADDRESS = { address_street: "40 Washington Sq S", address_city: "New York", address_state: "NY", address_zip: "10012", address_phone: "+12025551234", address_name: "Omari Nyarko" };
const SECRET = "whsec_loop";
let fake, server, base, messages;
const said = [];
const owner = (t) => ({ role: "user", content: "[Sun, Oct 11, 2026, 3:00 PM] Omari: " + t });
const call = (name, input) => runTool(name, input, { conversationId: OMARI, messages, judge: async () => ({ verdict: "yes" }) });

/** POST one event to the real server, signed the way AgentCard signs: HMAC-SHA256 of "t.rawBody". */
async function post(event, { secret = SECRET, t = Math.floor(clock.now() / 1000) } = {}) {
  const raw = JSON.stringify(event);
  const sig = "t=" + t + ",v1=" + createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  const res = await fetch(base + "/agentcard/webhook", { method: "POST", headers: { "content-type": "application/json", "AgentCard-Signature": sig }, body: raw });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  fake = await startAgentCard();
  config.agentcardClientId = "ac-client-loop";
  config.agentcardClientSecret = "ac-secret-loop";
  config.agentcardApiBase = fake.url;
  config.agentcardWebhookSecret = SECRET;
  config.publicUrl = "";
  server = createServer({ router: { list: () => [] }, runtime: { say: (c, text) => said.push({ c, text }) } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.setSpendCaps(OMARI, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "fifty a thing" });
  agentcard.forgetAccessToken();
});
after(async () => { await new Promise(r => server.close(r)); await fake.close(); rmSync(dir, { recursive: true, force: true }); });

test("the full loop: pick → cart → hash yes → passkey pause → signed approval → dropped confirm → reconcile → signed order events", async () => {
  messages = [owner("get me a bag of colombian coffee")];
  offers.beginTurn(OMARI, "get me a bag of colombian coffee");

  // Enrollment: the vault link, then the session reads linked and is exchanged for their token.
  const link = await call("vault_enroll", {});
  assert.equal(link.ok, true, JSON.stringify(link));
  fake.set({ sessionStatus: "linked", sessionUser: "usr_8f3k2m", ask: "needs_input" });

  // 1. The ask. AgentCard shows a catalog; every item becomes an offer record with an offer_id.
  const first = await call("purchase", { ask: "a bag of colombian coffee", ...ADDRESS });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.catalog?.items?.length, "a catalog to pick from");
  const pick = first.catalog.items[0];
  assert.ok(pick.offer_id);

  // 2. They pick one; it goes as BuyRequest.pick and the cart is checked against it by id.
  fake.set({ ask: "cart" });
  const cart = await call("purchase", { ask: "that first one", conversation_id: first.conversation_id, offer_id: pick.offer_id });
  assert.equal(cart.ok, true, JSON.stringify(cart));
  assert.ok(cart.cart_hash);
  assert.equal(fake.state.asks.at(-1).pick?.product_id, pick.product_id, "the pick went to AgentCard by its own id");
  const conv = cart.conversation_id;

  // 3. The yes, pinned to that cart's hash (the gate refuses a confirm with none).
  const refused = await call("purchase_confirm", { conversation_id: conv, cart_hash: cart.cart_hash });
  assert.ok(refused.use_target, JSON.stringify(refused));
  assert.match(refused.use_target, new RegExp(cart.cart_hash));
  const req = await call("confirm_request", { action: "purchase_confirm", summary: "Buy it for " + cart.total + "?", stakes: "money", amount: Number(cart.total.slice(1)), target: refused.use_target });
  messages.push(owner("yes buy it"));
  const granted = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(granted.state, "granted", JSON.stringify(granted));

  // 4. The confirm pauses for their passkey; the row keeps the authorization id from the link.
  fake.set({ confirms: ["approval_required", "hang_placed"], conversation: "tracked" });
  const paused = await call("purchase_confirm", { conversation_id: conv, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id });
  assert.equal(paused.blocked, "vault_approval_required", JSON.stringify(paused));
  const authId = "cauth_" + conv;
  assert.equal(db.getAgentcardPurchase(conv).authorization_id, authId);
  assert.equal(fake.state.confirmCalls[0].confirm, cart.cart_hash, "the hash shown is the hash confirmed");

  // 5. Webhooks through the real HTTP server. A bad signature and a stale one are refused.
  assert.equal((await post({ id: "evt_bad", type: "checkout_authorization.approved", data: {} }, { secret: "whsec_wrong" })).status, 401);
  assert.equal((await post({ id: "evt_old", type: "checkout_authorization.approved", data: {} }, { t: Math.floor(clock.now() / 1000) - 3600 })).status, 401);
  // checkout_authorization.* is keyed on data.authorization_id ONLY: the same event carrying just
  // an order_id or the conversation id matches nothing.
  const miskeyed = await post({ id: "evt_ca_mis", type: "checkout_authorization.approved", data: { user_id: "usr_8f3k2m", order_id: "order_1", conversation_id: conv } });
  assert.deepEqual([miskeyed.status, miskeyed.body.matched], [200, false]);
  const approved = await post({ id: "evt_ca_ok", type: "checkout_authorization.approved", data: { user_id: "usr_8f3k2m", authorization_id: authId } });
  assert.deepEqual([approved.status, approved.body.matched], [200, true]);
  const dup = await post({ id: "evt_ca_ok", type: "checkout_authorization.approved", data: { user_id: "usr_8f3k2m", authorization_id: authId } });
  assert.equal(dup.body.duplicate, true, "at-least-once delivery is deduplicated on event id");
  const wake = db.listTimers(OMARI);
  assert.equal(wake.length, 1, "one wake to resend the same confirm");
  assert.match(wake[0].note, new RegExp("cart_hash " + cart.cart_hash + " and confirmation_id " + req.confirmation_id));
  assert.equal(db.getAgentcardPurchase(conv).status, "awaiting_approval", "an approval is not an order");

  // 6. The wake's confirm — same hash, same yes — and its answer is dropped. AgentCard did place it.
  const t0 = config.agentcardTimeoutMs;
  config.agentcardTimeoutMs = 150;
  let lost;
  try { lost = await call("purchase_confirm", { conversation_id: conv, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id }); }
  finally { config.agentcardTimeoutMs = t0; }
  // Unknown-outcome recovery: read the conversation, never resend; the listed order makes it placed.
  assert.equal(lost.blocked, "outcome_was_unknown", JSON.stringify(lost));
  assert.equal(lost.order_id, "order_1");
  assert.equal(fake.state.confirmCalls.length, 2, "the dropped confirm was not retried");
  assert.deepEqual(fake.state.convReads, [conv], "reconciled by one read of the conversation");
  let row = db.getAgentcardPurchase(conv);
  assert.equal(row.status, "placed");
  assert.equal(row.order_id, "order_1");
  // And it cannot be bought twice.
  const again = await call("purchase_confirm", { conversation_id: conv, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id });
  assert.equal(again.ok, false);
  assert.equal(fake.state.confirmCalls.length, 2);

  // 7. order.* is keyed on data.order_id ONLY: carrying just the authorization id matches nothing.
  const omis = await post({ id: "evt_o_mis", type: "order.placed", data: { user_id: "usr_8f3k2m", authorization_id: authId } });
  assert.equal(omis.body.matched, false);
  for (const [id, type] of [["evt_o1", "order.placed"], ["evt_o2", "order.confirmed"]]) {
    const r = await post({ id, type, data: { user_id: "usr_8f3k2m", order_id: "order_1", charge_status: "settled" } });
    assert.deepEqual([r.status, r.body.matched], [200, true], type);
  }
  row = db.getAgentcardPurchase(conv);
  assert.equal(row.order_state, "confirmed");
  assert.equal(row.charge_status, "settled");
  assert.equal(row.status, "placed", "order events annotate; they never create or re-place a purchase");
});

test("a dropped confirm AgentCard has no order for stays unknown, is said to be, and blocks the retry", async () => {
  messages = [owner("and a second bag")];
  offers.beginTurn(OMARI, "and a second bag");
  fake.set({ ask: "cart", conversation: null });
  const cart = await call("purchase", { ask: "another bag of colombian coffee", ...ADDRESS });
  const refused = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash });
  const req = await call("confirm_request", { action: "purchase_confirm", summary: "Buy it for " + cart.total + "?", stakes: "money", amount: Number(cart.total.slice(1)), target: refused.use_target });
  messages.push(owner("yes"));
  await call("confirm_record", { confirmation_id: req.confirmation_id });
  const before = fake.state.confirmCalls.length;
  fake.set({ confirms: ["hang"] });
  const t0 = config.agentcardTimeoutMs;
  config.agentcardTimeoutMs = 150;
  let out;
  try { out = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id }); }
  finally { config.agentcardTimeoutMs = t0; }
  assert.equal(out.blocked, "outcome_unknown", JSON.stringify(out));
  assert.match(out.reconcile, /not proof nothing was charged/);
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "outcome_unknown");
  const retry = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id });
  assert.equal(retry.ok, false);
  assert.equal(fake.state.confirmCalls.length, before + 1, "never resent");
});

