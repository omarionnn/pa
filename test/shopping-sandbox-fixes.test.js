// Four things the real AgentCard sandbox run found on 2026-10-23 (/opt/reason-sandbox on Hetzner,
// sbdrive.mjs against sandbox credentials), each pinned against the payload shapes that run really
// got back. Fake AgentCard (test/fixture-agentcard.js), no key, no network beyond 127.0.0.1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { startAgentCard } from "./fixture-agentcard.js";

const dir = mkdtempSync(join(tmpdir(), "reason-sbfix-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const agentcard = await import("../src/agentcard.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const offers = await import("../src/offers.js");
const { createServer } = await import("../src/http.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const ADDRESS = { address_street: "40 Washington Sq S", address_city: "New York", address_state: "NY", address_zip: "10012", address_phone: "+12025551234", address_name: "Omari Nyarko" };
const SECRET = "whsec_sbfix";
let fake, server, base, messages;
const owner = (t) => ({ role: "user", content: "[Fri, Oct 23, 2026, 11:30 PM] Omari: " + t });
const call = (name, input) => runTool(name, input, { conversationId: OMARI, messages, judge: async () => ({ verdict: "yes" }) });

/**
 * last_checkout exactly as the real sandbox answered GET /buy/conversations/{id} after a confirm
 * whose answer was dropped (conv_dfed13cde2cfb5ff39ad0abb, 2026-10-24T03:31Z). Note "denied", not
 * "declined". approval_url and authorization_id were present there and are left out here.
 */
const SANDBOX_LAST_CHECKOUT = {
  at: "2026-10-24T03:31:57.476Z", merchant: "retail", merchant_name: "Amazon", status: "denied", code: "sandbox_mode",
  message: "This connection is in sandbox mode, and sandbox test cards cannot pay real merchants, so a live Amazon, Walmart, Target & Best Buy order cannot be placed.",
  order_id: null, payment_source: null, decline_code: "sandbox_mode", refusal_code: null, approval_expires_at: null,
  approval_in_progress: null, placement_announced: null, add_card_url: null, add_card_expires_at: null, charge_status: "none",
  merchant_total_cents: null, merchant_currency: null, total_cents: null, items: null,
};
const sandboxRead = (over = {}) => ({ status: "open", turn_in_progress: false, cart_building: null,
  approval_history: { complete: true, created: 0 }, last_checkout: { ...SANDBOX_LAST_CHECKOUT }, orders: [], open_offers: [], browser_checkouts: [], unmatched: [], ...over });

async function post(event, { secret = SECRET, t = Math.floor(clock.now() / 1000) } = {}) {
  const raw = JSON.stringify(event);
  const sig = "t=" + t + ",v1=" + createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  const res = await fetch(base + "/agentcard/webhook", { method: "POST", headers: { "content-type": "application/json", "AgentCard-Signature": sig }, body: raw });
  return { status: res.status, body: await res.json() };
}

async function cartAndYes(ask) {
  messages = [owner(ask)];
  offers.beginTurn(OMARI, ask);
  fake.set({ ask: "cart", conversation: null });
  const cart = await call("purchase", { ask, ...ADDRESS });
  assert.equal(cart.ok, true, JSON.stringify(cart));
  const refused = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash });
  const req = await call("confirm_request", { action: "purchase_confirm", summary: "Buy it for " + cart.total + "?", stakes: "money", amount: Number(cart.total.slice(1)), target: refused.use_target });
  messages.push(owner("yes buy it"));
  const granted = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(granted.state, "granted", JSON.stringify(granted));
  return { cart, target: refused.use_target, yes: req.confirmation_id };
}

async function dropped(cart, yes) {
  const t0 = config.agentcardTimeoutMs;
  config.agentcardTimeoutMs = 150;
  fake.set({ confirms: ["hang"], conversation: { turn_in_progress: true } });
  try { return await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes }); }
  finally { config.agentcardTimeoutMs = t0; }
}

before(async () => {
  fake = await startAgentCard();
  config.agentcardClientId = "ac-client-sbfix";
  config.agentcardClientSecret = "ac-secret-sbfix";
  config.agentcardApiBase = fake.url;
  config.agentcardWebhookSecret = SECRET;
  config.publicUrl = "";
  config.maxSpendPerDay = 100;
  server = createServer({ router: { list: () => [] }, runtime: { say: () => {} } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.setSpendCaps(OMARI, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "fifty a thing" });
  agentcard.forgetAccessToken();
  messages = [owner("add my card")];
  assert.equal((await call("vault_enroll", {})).ok, true);
  fake.set({ sessionStatus: "linked", sessionUser: "usr_8f3k2m" });
});
after(async () => { await new Promise(r => server.close(r)); await fake.close(); rmSync(dir, { recursive: true, force: true }); });

test("fix 1: an unknown purchase AgentCard later reads as finished, no order, sandbox_mode decline settles to declined — never retried", async () => {
  const { cart, yes } = await cartAndYes("a 12oz bag of whole bean colombian coffee");
  const before = fake.state.confirmCalls.length;
  const lost = await dropped(cart, yes);
  // The read straight after the drop said the turn was still running, as the real one did.
  assert.equal(lost.blocked, "outcome_unknown", JSON.stringify(lost));
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "outcome_unknown");
  assert.ok(trust.spendToday(OMARI).spent_cents > 0, "counted against the day while unknown");

  // Ambiguous reads leave it alone: no decline code; a passkey pause; charge unknown; still running.
  for (const lc of [{ decline_code: "", code: "" }, { decline_code: "vault_approval_required" }, { charge_status: "unknown" }]) {
    fake.set({ conversation: sandboxRead({ last_checkout: { ...SANDBOX_LAST_CHECKOUT, ...lc } }) });
    const t = await call("purchase_track", { conversation_id: cart.conversation_id });
    assert.equal(t.status, "outcome_unknown", JSON.stringify(lc));
  }
  fake.set({ conversation: sandboxRead({ turn_in_progress: true }) });
  assert.equal((await call("purchase_track", { conversation_id: cart.conversation_id })).status, "outcome_unknown");

  // The real sandbox answer: finished, no order, last checkout denied with sandbox_mode.
  fake.set({ conversation: sandboxRead() });
  const t = await call("purchase_track", { conversation_id: cart.conversation_id });
  assert.equal(t.status, "declined", JSON.stringify(t));
  const row = db.getAgentcardPurchase(cart.conversation_id);
  assert.equal(row.decline_code, "sandbox_mode");
  assert.equal(db.listUnknownOutcomes(OMARI).length, 0, "the retry block is lifted");
  assert.equal(trust.spendToday(OMARI).spent_cents, 0, "and it no longer counts against the day");
  assert.equal(fake.state.confirmCalls.length, before + 1, "never auto-retried");
});

test("fix 2: a last checkout reading \"denied\" (the real sandbox word) is a decline", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ conversation_id: "conv_x", ...sandboxRead({ last_checkout: { ...SANDBOX_LAST_CHECKOUT, decline_code: null } }) }), { status: 200 });
  const read = await agentcard.readConversation("tok", "conv_x", { fetchImpl });
  assert.equal(read.last_checkout.status, "denied");
  const r = agentcard.reconcileLine(read);
  assert.equal(r.known, true);
  assert.equal(r.placed, false);
  assert.match(r.line, /declined \(sandbox_mode\)/);
  assert.equal(r.declined, undefined, "no decline code, so not definite enough to settle anything");
  assert.ok(agentcard.DECLINED_CHECKOUT.has("declined") && agentcard.DECLINED_CHECKOUT.has("denied"));
});

test("fix 3: the same cart in two buy conversations is two different yeses", async () => {
  const a = await cartAndYes("coffee, conversation A");
  messages = [owner("coffee, conversation B")];
  const b = await call("purchase", { ask: "coffee, conversation B", ...ADDRESS });
  assert.equal(b.cart_hash, a.cart.cart_hash, "the fixture hands both the same cart hash, as the sandbox did");
  assert.notEqual(b.conversation_id, a.cart.conversation_id);
  const bRefused = await call("purchase_confirm", { conversation_id: b.conversation_id, cart_hash: b.cart_hash });
  assert.notEqual(bRefused.use_target, a.target);
  assert.match(a.target, new RegExp(a.cart.conversation_id));
  const before = fake.state.confirmCalls.length;
  // A's yes, spent on B's cart: refused, nothing sent to AgentCard.
  const stolen = await call("purchase_confirm", { conversation_id: b.conversation_id, cart_hash: b.cart_hash, confirmation_id: a.yes });
  assert.equal(stolen.ok, false, JSON.stringify(stolen));
  assert.equal(fake.state.confirmCalls.length, before, "the yes for A cannot spend B");
  // And it still spends A, once.
  fake.set({ confirms: ["placed"] });
  const ok = await call("purchase_confirm", { conversation_id: a.cart.conversation_id, cart_hash: a.cart.cart_hash, confirmation_id: a.yes });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("fix 4: a sandbox decline says Nothing was charged once", async () => {
  const { cart, yes } = await cartAndYes("one more bag");
  fake.set({ confirms: ["sandbox"] });
  const out = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes });
  assert.equal(out.blocked, "declined", JSON.stringify(out));
  assert.equal(out.error.match(/Nothing was charged/g).length, 1, out.error);
  // A code whose own words do not say it still gets it, once.
  assert.equal(("Not bought — " + agentcard.declineLine("items_unavailable")).match(/Nothing was charged/g), null);
});

test("connection.created is logged and ignored, explicitly", async () => {
  const users = db.getAgentcardUser(OMARI);
  const r = await post({ id: "evt_b3fb162df97e2d97fd27da9f", type: "connection.created", created: Math.floor(clock.now() / 1000), livemode: false, data: { user_id: "usr_8f3k2m" } });
  assert.deepEqual([r.status, r.body.ignored], [200, "connection.created"]);
  assert.deepEqual(db.getAgentcardUser(OMARI), users, "nothing about the person changed");
});
