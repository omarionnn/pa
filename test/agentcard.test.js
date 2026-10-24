// AgentCard, against a fake AgentCard that answers the routes their docs document.
//
// What these tests are for, in the order the money gets closer:
//   1. With no credentials, every tool says not_configured and promises nothing.
//   2. Enrollment: one link per person, never a second one for somebody who already has a card.
//   3. The /buy loop cannot charge anything, and a cart's real total is what gets recorded.
//   4. The gate holds at the confirm — no yes, no purchase — and the yes is pinned to the cart
//      that was really shown, so a price that moved cannot ride the old one.
//   5. A passkey pause is a pause: nothing charged, and the same yes finishes the job.
//   6. Nothing is bought twice: a placed cart, a stale hash and a confirm whose outcome nobody
//      knows are all refused rather than resent.
//   7. One person's vault and one person's orders are never another's.
//   8. The webhook is verified before it is acted on, and a redelivery changes nothing.
//
// No key, no network: the API base points at the fixture.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { startAgentCard } from "./fixture-agentcard.js";

const dir = mkdtempSync(join(tmpdir(), "reason-agentcard-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "11".repeat(32); // stored AgentCard tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool, capabilitiesNow, toolsFor } = await import("../src/tools.js");
const agentcard = await import("../src/agentcard.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { agentcardWebhookRequest } = await import("../src/http.js");
const permissions = await import("../src/permissions.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";

const ADDRESS = {
  address_street: "40 Washington Sq S",
  address_city: "New York",
  address_state: "NY",
  address_zip: "10012",
  address_phone: "+12025551234",
  address_name: "Omari Nyarko",
};

let fake;
const owner = (t) => ({ role: "user", content: `[Sun, Oct 11, 2026, 3:00 PM] Omari: ${t}` });
let messages;

// What the owner's reply means is the judge's call; these tests are about the purchase tools and
// the gate's bookkeeping, so the verdict is stated outright (see flow-gate.test.js for the judge
// reading real sentences).
const readsYes = async () => ({ verdict: "yes" });
const call = (name, input, conversationId = OMARI) =>
  runTool(name, input, { conversationId, messages, judge: readsYes });

before(async () => {
  fake = await startAgentCard();
  config.agentcardClientId = "ac-client-abc";
  config.agentcardClientSecret = "ac-secret-xyz";
  config.agentcardApiBase = fake.url;
  config.agentcardWebhookSecret = "whsec_test";
  config.publicUrl = "";
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  agentcard.forgetAccessToken();
  // `unknown_outcomes` is cleared along with the rest because the fixture reuses its conversation
  // ids: a row left by the never-answered confirm below would block a later test's confirm as a
  // retry of it, which is the right production behaviour and the wrong starting state for a test.
  db.db.exec(`DELETE FROM agentcard_users; DELETE FROM agentcard_purchases; DELETE FROM agentcard_events;
    DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend;
    DELETE FROM spend_caps; DELETE FROM permissions; DELETE FROM conversations;
    DELETE FROM unknown_outcomes;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  // A purchase is checked against the person's own limits, and with none set every confirm stops to
  // ask for them. These are generous on purpose so the tests below are about the gate, not the caps.
  db.setSpendCaps(OMARI, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "fifty a thing, two grand a month" });
  db.setSpendCaps(AMA, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "same" });
  messages = [owner("get me a bag of coffee")];
  fake.set({ ask: "cart", confirms: ["placed"], sessionStatus: "pending", sessionUser: "usr_8f3k2m", knownUsers: ["usr_8f3k2m"], cardsByUser: null, trackEmpty: false, exchange: "ok" });
  fake.state.asks.length = 0;
  fake.state.confirmCalls.length = 0;
  fake.state.vaultSessions.length = 0;
  fake.state.buyTokenCalls.length = 0;
  fake.state.cardReads.length = 0;
  fake.state.exchanges.length = 0;
  fake.state.refreshes.length = 0;
  fake.state.exchanged.clear();
  fake.state.liveRefresh.clear();
  fake.state.tokenUser.clear();
  fake.state.tokenCalls.length = 0;
  fake.state.liveOrgTokens.clear();
  fake.state.liveBuyTokens.clear();
});

/**
 * Enroll this person the way a real one does: a link, then they finish it.
 *
 * Finishing is all that is simulated — the fixture's session goes `linked`, exactly as AgentCard's
 * would. Nothing here writes a user id or a token by hand, because the whole point of the exchange
 * is that connecting is something the code does; a test that forged the tokens would have passed
 * against the version that could not connect anybody at all.
 */
async function enroll(conversationId = OMARI) {
  const link = await call("vault_enroll", {}, conversationId);
  assert.equal(link.ok, true, JSON.stringify(link));
  fake.set({ sessionStatus: "linked", sessionUser: "usr_8f3k2m" });
  return link;
}

/** A cart on the record, and the hash the person was really shown. */
async function shop(conversationId = OMARI) {
  const out = await call("purchase", { ask: "a bag of colombian coffee", ...ADDRESS }, conversationId);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.cart_hash, "a cart has a hash");
  return out;
}

/**
 * A spent-able yes for one cart, through the real gate.
 *
 * The target is never typed here: the confirm is called once with no confirmation_id — which presses
 * nothing — and the `use_target` string it refuses with is what the yes is collected against. That is
 * the documented order for every gated money tool in this repo, and doing it this way is also what
 * proves the yes is pinned to AgentCard's own cart rather than to anything a caller retyped.
 */
async function yesFor(buyConversationId, cartHash, conversationId = OMARI) {
  const refused = await call("purchase_confirm", {
    conversation_id: buyConversationId, cart_hash: cartHash,
  }, conversationId);
  assert.equal(refused.ok, false, "a confirm with no yes presses nothing");
  assert.ok(refused.use_target, "the refusal hands back the string the yes is checked against");

  const req = await call("confirm_request", {
    action: "purchase_confirm",
    summary: "Buy the Colombian coffee from Amazon for $23.06?",
    stakes: "money",
    target: refused.use_target,
  }, conversationId);
  assert.ok(req.confirmation_id, JSON.stringify(req));
  messages.push(owner("yes buy it"));
  const granted = await call("confirm_record", { confirmation_id: req.confirmation_id }, conversationId);
  assert.equal(granted.state, "granted", JSON.stringify(granted));
  return req.confirmation_id;
}

// ---------- no credentials ----------

test("with no client id, every purchase tool says not_configured and claims nothing", async () => {
  const id = config.agentcardClientId;
  config.agentcardClientId = "";
  try {
    for (const [tool, input] of [
      ["vault_enroll", {}],
      ["purchase", { ask: "coffee", ...ADDRESS }],
      ["purchase_track", { order_id: "order_1" }],
    ]) {
      const out = await call(tool, input);
      assert.equal(out.ok, false, tool);
      assert.equal(out.status, "not_configured", tool);
      assert.ok(out.missing.includes("AGENTCARD_CLIENT_ID"), tool);
      assert.match(out.error, /not set up on this install/, tool);
    }

    // purchase_confirm never even gets as far as the credentials: the gate stops it first, which is
    // the right order — an install with no AgentCard still must not let a confirm through ungated.
    const confirm = await call("purchase_confirm", { conversation_id: "conv_1abc", cart_hash: "9f2c4a1b8e3d5f07" });
    assert.equal(confirm.ok, false);
    assert.equal(confirm.blocked, "needs_confirmation");

    assert.equal(fake.state.asks.length, 0, "nothing was asked of AgentCard");
  } finally {
    config.agentcardClientId = id;
  }
});

// ---------- enrolling ----------

test("vault_enroll opens one session, records it, and hands back the link untouched", async () => {
  const out = await call("vault_enroll", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.url, /^https:\/\/vault\.agentcard\.sh\/v\?vs=/);
  assert.equal(fake.state.vaultSessions.length, 1);
  // Open rather than connected: no user_id is sent, which is what lets a returning person unlock
  // with the passkey they already have instead of making an account.
  assert.equal(fake.state.vaultSessions[0].body.user_id, undefined);

  const row = db.getAgentcardUser(OMARI);
  assert.equal(row.vault_session_id, out.vault_session_id);
  assert.equal(row.user_id, "", "nobody is linked until AgentCard says who it was");

  const led = db.listActions(OMARI);
  assert.equal(led.length, 1);
  assert.equal(led[0].action, "vault_enroll");
  assert.match(led[0].receipt, /vault link/i);
  assert.match(led[0].receipt, /never sees the number/i);
});

test("somebody who already has a card is not sent through enrolling twice", async () => {
  await enroll();
  fake.state.vaultSessions.length = 0;

  const again = await call("vault_enroll", {});
  assert.equal(again.ok, true);
  assert.equal(again.already_enrolled, true);
  assert.equal(again.card, "Visa ••••4832");
  assert.equal(again.url, undefined, "no link is handed out");
  assert.equal(fake.state.vaultSessions.length, 0, "no session was minted");
  assert.match(db.listActions(OMARI)[0].receipt, /already has/i);
});

// 2026-10-12, the night the live install moved from sandbox to production credentials: the tool
// handed back a live link twice and the model sent neither, telling the person "don't add it
// again, it's in test mode anyway" — because nothing in the result said the link was live, or
// that a card stored under the old credentials cannot be seen from here.
test("a live link says so, and says to send it even to somebody who already added a card", async () => {
  const out = await call("vault_enroll", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.mode, "live");
  assert.equal(out.test_mode, undefined);
  assert.match(out.note, /LIVE link on production credentials/);
  assert.match(out.note, /NOT reachable from this install until they open THIS link/);
  assert.match(out.note, /never tell them not to add it/);
  assert.doesNotMatch(out.note, /This install is on sandbox credentials/);
});

test("a card this install can no longer see is a link to send, never a reason to say don't add it", async () => {
  await enroll();
  await shop();
  assert.equal(db.getAgentcardUser(OMARI).card_last4, "4832", "a card was seen here once");
  // The install is re-keyed: the stored token dies, nothing refreshes it, and the new organization
  // has no vault for that user id.
  db.db.prepare("UPDATE agentcard_users SET token_expires_at = ?, refresh_token = '' WHERE conversation_id = ?").run(clock.now() - 1, OMARI);
  fake.set({ knownUsers: [] });
  fake.state.asks.length = 0;

  const out = await call("purchase", { ask: "coffee", ...ADDRESS });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "connection_expired");
  assert.match(out.error, /no longer reachable from this install/);
  assert.match(out.error, /credentials changed/);
  assert.match(out.error, /vault_enroll/);
  assert.match(out.error, /never tell them not to add it/);
  assert.equal(fake.state.asks.length, 0, "no shop was contacted");

  const sent = await call("purchase", { ask: "coffee", ...ADDRESS });
  assert.equal(sent.blocked, "connection_expired", "and it stays a link to send, not a guess");
  fake.set({ knownUsers: ["usr_8f3k2m"] });
});

test("a card that landed without a webhook is still noticed, by reading the session", async () => {
  const link = await call("vault_enroll", {});
  // No webhook ever arrives — the install has no secret, or the person signed in to the vault
  // themselves. The session is the other half of learning that a card is there.
  fake.set({ sessionStatus: "linked", sessionUser: "usr_8f3k2m" });

  const out = await shop();
  assert.equal(out.ok, true, "a purchase picks the card up by itself");
  assert.equal(db.getAgentcardUser(OMARI).user_id, "usr_8f3k2m");
  assert.equal(db.getAgentcardUser(OMARI).vault_session_id, link.vault_session_id);
  assert.deepEqual(fake.state.exchanges, [link.vault_session_id], "the finished link was exchanged, once");
});

// This is the one that was missing, and the live install paid for it on 2026-10-11: with no webhook
// the user id is never written, so asking "done?" used to mint a SECOND link and overwrite the
// session id of the one the person had already finished — destroying the only handle on it and
// guaranteeing they could never be connected, however many times they tried.
test("asking twice with no webhook connects them, instead of burning the finished link", async () => {
  const first = await call("vault_enroll", {});
  assert.equal(first.ok, true);
  assert.ok(first.url, "a first-timer gets a link");

  // They go and do it. Nothing tells this machine: no secret, so no hook.
  fake.set({ sessionStatus: "linked", sessionUser: "usr_8f3k2m" });
  assert.equal(db.getAgentcardUser(OMARI).user_id, "", "nothing has told this machine anything yet");

  const second = await call("vault_enroll", {});
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.already_enrolled, true, "it recognises the finished link rather than minting another");
  assert.equal(second.card, "Visa ••••4832");
  assert.equal(second.url, undefined, "no second link is handed out");

  const row = db.getAgentcardUser(OMARI);
  assert.equal(row.vault_session_id, first.vault_session_id, "the finished session was NOT overwritten");
  assert.equal(row.user_id, "usr_8f3k2m");
  assert.ok(row.access_token, "they are connected, with their own token");
  assert.equal(fake.state.vaultSessions.length, 1, "exactly one link was ever minted");

  // And a purchase now works off that same connection, with no further enrolling.
  assert.equal((await shop()).ok, true);
});

test("the exchange is spent once, however many times it is reached for", async () => {
  await enroll();
  await shop();
  const after = fake.state.exchanges.length;
  // More turns, a second purchase, another enrol check: none of them may exchange again.
  await shop();
  await call("vault_enroll", {});
  assert.equal(fake.state.exchanges.length, after, "no second exchange");
  assert.equal(fake.state.exchanged.size, 1);
});

test("an expiring token is rotated rather than used dead", async () => {
  await enroll();
  await shop();
  const first = db.getAgentcardUser(OMARI).access_token;

  // A turn against a live merchant takes ~20s, so a token with a moment left is one that dies in
  // flight. Age it past the slack and the next call must rotate it.
  db.db.prepare("UPDATE agentcard_users SET token_expires_at = ? WHERE conversation_id = ?").run(clock.now() - 1, OMARI);
  assert.equal((await shop()).ok, true);

  assert.equal(fake.state.refreshes.length, 1, "it refreshed");
  assert.notEqual(db.getAgentcardUser(OMARI).access_token, first, "and kept the new token");
  assert.equal(fake.state.exchanges.length, 1, "without exchanging again");
});

test("somebody who already had an AgentCard account is told, not handed another link", async () => {
  await call("vault_enroll", {});
  fake.set({ sessionStatus: "linked", exchange: "needs_verification" });

  const out = await call("vault_enroll", {});
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_verification");
  assert.match(out.error, /account that already existed/i);
  assert.match(out.error, /fresh link will not fix it/);
  assert.equal(fake.state.vaultSessions.length, 1, "no pointless second link");
});

test("purchase refuses honestly for somebody with no card, and never invents one", async () => {
  const out = await call("purchase", { ask: "coffee", ...ADDRESS });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "not_enrolled");
  assert.match(out.error, /no card stored/i);
  assert.match(out.error, /vault_enroll/);
  assert.equal(fake.state.asks.length, 0, "no shop was contacted");

  // Enrolled with AgentCard, but the vault is empty — a different sentence, and the one worth
  // getting right: this person did tap the link.
  await enroll();
  fake.set({ cards: [] });
  const empty = await call("purchase", { ask: "coffee", ...ADDRESS });
  assert.equal(empty.blocked, "no_card");
  assert.match(empty.error, /no card in their vault/i);
  fake.set({ cards: [{ id: "vc_1", brand: "visa", last4: "4832", expiry_month: 12, expiry_year: 2029 }] });
});

// ---------- shopping: the loop that cannot charge ----------

test("purchase comes back with the real cart, records it, and charges nothing", async () => {
  await enroll();
  const out = await shop();

  assert.equal(out.status, "needs_input", "a cart is not an order");
  assert.equal(out.cart.total, "$23.06");
  assert.equal(out.cart.total_cents, 2306);
  assert.equal(out.cart_hash, fake.CART.hash);
  assert.equal(out.cart.items[0].price, "$22.50");
  assert.equal(out.cart.service_fees_cents, 56);
  assert.match(out.cart_line, /Amazon/);
  assert.match(out.note, /Nothing is bought and nothing is charged/);
  assert.match(out.note, /never from `reply`/);

  // /buy runs as ONE user: the fixture refuses an organization token outright, so getting a cart at
  // all proves the call went out on this person's own token — the one their exchange produced.
  assert.equal(fake.state.exchanges.length, 1, "their finished link was exchanged for their tokens");
  assert.ok(db.getAgentcardUser(OMARI).access_token, "and the pair was kept");
  assert.equal(fake.state.asks[0].ask, "a bag of colombian coffee");
  assert.equal(fake.state.asks[0].delivery_address.zip, "10012");

  const row = db.getAgentcardPurchase(out.conversation_id);
  assert.equal(row.status, "cart_shown");
  assert.equal(row.cart_hash, fake.CART.hash);
  assert.equal(row.amount_cents, 2306, "the recorded total is AgentCard's number");
  assert.equal(row.merchant, "Amazon");
  assert.equal(row.conversation_id, OMARI);

  assert.equal(trust.spendToday(OMARI).spent_cents, 0, "nothing is committed by shopping");
  const led = db.listActions(OMARI).find(a => a.action === "purchase");
  assert.match(led.receipt, /Nothing was confirmed and nothing was charged/);
});

test("a new purchase with no address is refused before a shop is ever asked", async () => {
  await enroll();
  const out = await call("purchase", { ask: "coffee" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "no_address");
  assert.match(out.error, /street, city, state, ZIP/);
  assert.equal(fake.state.asks.length, 0);
});

test("an address the shop will not take names the missing part", async () => {
  await enroll();
  fake.set({ ask: "bad_address" });
  const out = await call("purchase", { ask: "coffee", ...ADDRESS });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "bad_address");
  assert.match(out.error, /zip is required/);
  assert.match(out.error, /Nothing was ordered/);
});

test("a question instead of a cart leaves nothing confirmable", async () => {
  await enroll();
  fake.set({ ask: "needs_input" });
  const out = await call("purchase", { ask: "coffee", ...ADDRESS });
  assert.equal(out.ok, true);
  assert.equal(out.status, "needs_input");
  assert.equal(out.cart_hash, undefined, "no hash, so there is nothing a yes could be about");
  assert.ok(out.catalog.items.length, "the catalog is there to pick from");
  assert.match(out.note, /No cart yet/);
  assert.equal(db.getAgentcardPurchase(out.conversation_id).status, "shopping");
});

// ---------- the gate ----------

test("purchase_confirm will not spend a penny without a yes", async () => {
  await enroll();
  const cart = await shop();

  const noYes = await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash });
  assert.equal(noYes.ok, false);
  assert.equal(noYes.blocked, "needs_confirmation");
  assert.equal(fake.state.confirmCalls.length, 0, "AgentCard was never asked to charge anything");

  // The model cannot self-authorize inside the one turn: a confirmation nobody has answered yet is
  // still waiting, and the confirm stays refused.
  const req = await call("confirm_request", {
    action: "purchase_confirm", summary: "Buy the coffee for $23.06?", stakes: "money",
    target: `buy:${cart.conversation_id}:cart:${cart.cart_hash}`,
  });
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "waiting_for_yes");
  const stillNo = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id,
  });
  assert.equal(stillNo.blocked, "not_granted", "a confirmation with no yes on it yet is not a yes");
  assert.equal(fake.state.confirmCalls.length, 0, "still nothing");
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "cart_shown");
});

test("with a real yes the cart is bought once, and the record says so exactly", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);

  const out = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, "order_placed");
  assert.ok(out.order_id);
  assert.equal(out.amount, "$23.06");
  assert.equal(out.card, "Visa ••••4832");
  assert.equal(out.charge_status, "settled");

  // The hash that was sent is the hash the person was shown — the fixture echoes it back on the
  // order, so this is the cart that was agreed to and not a retyped one.
  assert.equal(fake.state.confirmCalls.length, 1);
  assert.equal(fake.state.confirmCalls[0].confirm, fake.CART.hash);
  assert.equal(fake.state.confirmCalls[0].payment_source, "vault");

  const row = db.getAgentcardPurchase(cart.conversation_id);
  assert.equal(row.status, "placed");
  assert.equal(row.order_id, out.order_id);
  assert.equal(row.amount_cents, 2306);

  // The money is counted against their own limits, and the receipt says the thing out loud.
  assert.equal(trust.spendToday(OMARI).spent_cents, 2306);
  const led = db.listActions(OMARI).find(a => a.action === "purchase_confirm");
  assert.match(led.receipt, /^BOUGHT/);
  assert.match(led.receipt, /\$23\.06/);
});

test("a yes for one cart cannot buy a cart whose price moved", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["price_changed"] });

  const out = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "cart_changed");
  assert.match(out.error, /Nothing was charged/);
  assert.equal(out.cart_hash, fake.CART_DEARER.hash, "the fresh cart comes back on the 409");
  assert.equal(out.total, "$27.06");
  assert.match(out.error, /cannot cover this/);
  assert.equal(trust.spendToday(OMARI).spent_cents, 0, "nothing was committed");

  // The row now holds the new cart, and the old hash is dead: the stale one is refused outright.
  const row = db.getAgentcardPurchase(cart.conversation_id);
  assert.equal(row.cart_hash, fake.CART_DEARER.hash);
  assert.equal(row.amount_cents, 2706);
  // The old hash on the old yes is refused twice over, and the gate gets there first: the row's
  // cart moved, so the target that yes was collected against no longer describes anything. Either
  // refusal is a refusal, and the gate's is the one that cannot be reasoned around.
  fake.set({ confirms: ["placed"] });
  const stale = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.blocked, "wrong_target");
  assert.equal(fake.state.confirmCalls.length, 1, "only the 409 ever reached AgentCard");

  // The dispatch guard behind it says the same thing. Reaching it takes a yes collected against
  // the un-describable target a dead hash produces — which is the only way past the gate, and
  // exactly why the gate is the first line rather than the only one.
  const req = await call("confirm_request", {
    action: "purchase_confirm", summary: "Buy the coffee for $23.06?", stakes: "money", target: stale.use_target,
  });
  messages.push(owner("yes"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "granted");
  const staleAgain = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id,
  });
  assert.equal(staleAgain.blocked, "stale_cart");
  assert.match(staleAgain.error, /only good for the cart it came back with/);

  // And the old yes cannot be spent on the new total: a new hash is a different target, so the
  // gate asks again rather than letting the first answer through.
  const onOldYes = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: fake.CART_DEARER.hash, confirmation_id: yes,
  });
  assert.equal(onOldYes.ok, false, "the dearer cart cannot ride the cheaper cart's yes");
  assert.equal(trust.spendToday(OMARI).spent_cents, 0);
});

test("a cart hash with no purchase behind it is refused, not guessed at", async () => {
  await enroll();
  const input = { conversation_id: "conv_nope", cart_hash: "deadbeef" };

  // The gate stops it first, with nothing to describe: a cart nobody has a row for cannot be put
  // into words for somebody to agree to.
  const ungated = await call("purchase_confirm", input);
  assert.equal(ungated.ok, false);
  assert.equal(ungated.blocked, "needs_confirmation");
  assert.match(ungated.use_target, /unknown cart deadbeef/);

  // Even carrying a yes collected against that nothing, the dispatch guard refuses rather than
  // inventing a purchase to confirm.
  const req = await call("confirm_request", {
    action: "purchase_confirm", summary: "Buy that cart for $23.06?", stakes: "money", target: ungated.use_target,
  });
  messages.push(owner("yes"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "granted");
  const out = await call("purchase_confirm", { ...input, confirmation_id: req.confirmation_id });
  assert.equal(out.ok, false);
  assert.match(out.error, /no purchase on record/i);
  assert.equal(fake.state.confirmCalls.length, 0, "AgentCard was never asked to charge anything");
});

// ---------- the passkey pause ----------

test("a passkey pause charges nothing, keeps the yes, and the same yes finishes it", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["approval_required", "placed"] });

  const paused = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(paused.ok, false);
  assert.equal(paused.blocked, "vault_approval_required");
  assert.match(paused.approval_url, /^https:\/\/vault\.agentcard\.sh\/authorize/);
  assert.match(paused.error, /Nothing has been charged yet/);
  assert.match(paused.error, /SAME confirmation_id/);
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "awaiting_approval");
  assert.equal(trust.spendToday(OMARI).spent_cents, 0, "a pause is not a charge");

  // The receipt has to be unmistakable about this one: a paused confirm and a placed order read
  // almost the same in a conversation.
  const pausedLed = db.listActions(OMARI).find(a => a.action === "purchase_confirm");
  assert.match(pausedLed.receipt, /NOTHING WAS CHARGED/);

  // They approve on their phone, and the SAME yes is used again — being asked twice for one
  // purchase would be the bug.
  const done = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.status, "order_placed");
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "placed");
  assert.equal(trust.spendToday(OMARI).spent_cents, 2306);
});

test("a decline is said plainly, and sandbox is not read as a refused card", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["sandbox"] });

  const out = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "declined");
  assert.equal(out.decline_code, "sandbox_mode");
  assert.match(out.error, /sandbox/i);
  assert.match(out.error, /Nothing was charged/);
  // The one thing a sandbox decline must never do is send somebody to their bank.
  assert.doesNotMatch(out.error, /card was refused|contact your bank/i);
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "declined");
  assert.equal(trust.spendToday(OMARI).spent_cents, 0);
});

// ---------- never twice ----------

test("a cart that was already bought is refused rather than bought again", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);
  const first = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(first.ok, true);

  // The same yes cannot carry a second charge: it was spent on the first one.
  const again = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });
  assert.equal(again.ok, false);
  assert.equal(again.blocked, "already_spent");

  // And neither can a brand new one. This is the assertion that matters: a placed cart is refused
  // on the row's own status, so even somebody saying yes a second time cannot buy it twice.
  const secondYes = await yesFor(cart.conversation_id, cart.cart_hash);
  const withNewYes = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: secondYes,
  });
  assert.equal(withNewYes.ok, false);
  assert.equal(withNewYes.blocked, "already_placed");
  assert.match(withNewYes.error, /already bought/i);
  assert.match(withNewYes.error, /Do not buy it again/);

  assert.equal(fake.state.confirmCalls.length, 1, "AgentCard was asked to charge exactly once");
  assert.equal(trust.spendToday(OMARI).spent_cents, 2306, "and counted exactly once");
});

test("a confirm nobody got an answer to is never retried by itself", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["hang"] });
  const slow = config.agentcardTimeoutMs;
  config.agentcardTimeoutMs = 300;
  try {
    const out = await call("purchase_confirm", {
      conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
    });
    assert.equal(out.ok, false);
    assert.equal(out.blocked, "outcome_unknown");
    assert.match(out.error, /NOBODY KNOWS/);
    assert.match(out.error, /charged twice/);
    assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "outcome_unknown");
    // Counted against the day even though nobody knows: the alternative is under-counting money
    // that may really have left.
    assert.equal(trust.spendToday(OMARI).spent_cents, 2306);

    // The yes was spent, so the same call cannot go out again on it.
    fake.set({ confirms: ["placed"] });
    const retry = await call("purchase_confirm", {
      conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
    });
    assert.equal(retry.ok, false, "a spent yes cannot carry a second attempt");
    assert.match(JSON.stringify(retry), /unknown|needs_confirmation|retry/i);
  } finally {
    config.agentcardTimeoutMs = slow;
  }
});

// ---------- whose vault, whose order ----------

test("one person's purchase and one person's order are never another's", async () => {
  await enroll(OMARI);
  const cart = await shop(OMARI);
  const yes = await yesFor(cart.conversation_id, cart.cart_hash, OMARI);
  const bought = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  }, OMARI);
  assert.equal(bought.ok, true);

  // Ama is enrolled in her own right, so this is not a "no card" refusal — it is a refusal to touch
  // somebody else's purchase.
  const link = await call("vault_enroll", {}, AMA);
  db.linkAgentcardUser({ vaultSessionId: link.vault_session_id, userId: "usr_8f3k2m" });

  // With a yes of her own, collected in her own conversation, against Omari's cart: the gate is
  // satisfied and the refusal has to come from the row's owner instead. That is the one that proves
  // a purchase is not reachable from another person's Reason.
  const refused = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash,
  }, AMA);
  assert.equal(refused.ok, false);
  const req = await call("confirm_request", {
    action: "purchase_confirm", summary: "Buy the coffee for $23.06?", stakes: "money", target: refused.use_target,
  }, AMA);
  messages.push({ role: "user", content: `[Sun, Oct 11, 2026, 3:05 PM] Ama: yes` });
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id }, AMA)).state, "granted");

  const theirs = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: req.confirmation_id,
  }, AMA);
  assert.equal(theirs.ok, false);
  assert.equal(theirs.blocked, "not_theirs");
  assert.equal(fake.state.confirmCalls.length, 1, "only Omari's own confirm ever reached AgentCard");

  const order = await call("purchase_track", { order_id: bought.order_id }, AMA);
  assert.equal(order.ok, false);
  assert.equal(order.blocked, "not_theirs");
});

// The question that decides whether this can be handed to more than one person: does a household
// of them, each with their own card, stay separate? Every assertion here is about one person's
// money not being reachable from another person's thread.
test("several people each keep their own card, and nobody can spend anybody else's", async () => {
  const KOFI = "dm:sendblue:+15016131490";
  const AGU = "dm:sendblue:+13477326636";
  db.upsertAccount({ conversationId: KOFI, channel: "fake", address: "+15016131490", name: "Kofi", isOperator: false });
  db.upsertAccount({ conversationId: AGU, channel: "fake", address: "+13477326636", name: "Agu", isOperator: false });
  for (const who of [KOFI, AGU]) db.setSpendCaps(who, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "fine" });

  const people = [
    { c: OMARI, user: "usr_omari", last4: "4832" },
    { c: AMA, user: "usr_ama", last4: "1111" },
    { c: KOFI, user: "usr_kofi", last4: "2222" },
    { c: AGU, user: "usr_agu", last4: "3333" },
  ];
  fake.set({
    knownUsers: people.map(p => p.user),
    cardsByUser: Object.fromEntries(people.map(p => [p.user, [{ id: `vc_${p.user}`, brand: "visa", last4: p.last4, expiry_month: 12, expiry_year: 2029 }]])),
  });

  // Each one enrolls on their own link and finishes it. The fixture hands the exchange a different
  // person each time, exactly as four real people with four passkeys would.
  for (const p of people) {
    fake.set({ sessionStatus: "pending", sessionUser: p.user });
    const link = await call("vault_enroll", {}, p.c);
    assert.equal(link.ok, true, `${p.c} link`);
    assert.ok(link.vault_session_id);
    fake.set({ sessionStatus: "linked" });
    p.session = link.vault_session_id;
  }

  // Four separate sessions, four separate rows, four separate exchanges.
  assert.equal(new Set(people.map(p => p.session)).size, 4, "nobody shared a vault link");

  for (const p of people) {
    fake.set({ sessionUser: p.user });
    const out = await call("purchase", { ask: "coffee", ...ADDRESS }, p.c);
    assert.equal(out.ok, true, `${p.c} should be able to shop: ${JSON.stringify(out)}`);
    p.buyConversation = out.conversation_id;

    const row = db.getAgentcardUser(p.c);
    assert.equal(row.user_id, p.user, `${p.c} is connected as themselves`);
    assert.equal(row.card_last4, p.last4, `${p.c} sees their OWN card`);
    assert.ok(row.access_token, `${p.c} has their own token`);
  }

  // No two people share a token, a user id, or a card.
  const rows = people.map(p => db.getAgentcardUser(p.c));
  assert.equal(new Set(rows.map(r => r.access_token)).size, 4, "four distinct tokens");
  assert.equal(new Set(rows.map(r => r.user_id)).size, 4, "four distinct AgentCard users");
  assert.equal(new Set(rows.map(r => r.card_last4)).size, 4, "four distinct cards");

  // And every call really went out as the right person — checked at the fixture, which records
  // whose token each /buy arrived on rather than taking the caller's word for it.
  for (const p of people) {
    const theirs = fake.state.asks.filter(a => a.conversation_id === p.buyConversation);
    assert.ok(theirs.length, `${p.c} reached the shop`);
    for (const ask of theirs) assert.equal(ask.user, p.user, `${p.c}'s shopping ran as ${p.user}, not somebody else`);
  }

  // Kofi buys his own coffee. His money, his card, his caps.
  fake.set({ sessionUser: "usr_kofi" });
  const kofiCart = await call("purchase", { ask: "coffee", ...ADDRESS }, KOFI);
  const kofiYes = await yesFor(kofiCart.conversation_id, kofiCart.cart_hash, KOFI);
  const bought = await call("purchase_confirm", {
    conversation_id: kofiCart.conversation_id, cart_hash: kofiCart.cart_hash, confirmation_id: kofiYes,
  }, KOFI);
  assert.equal(bought.ok, true, JSON.stringify(bought));
  assert.equal(fake.state.confirmCalls.at(-1).user, "usr_kofi", "the charge ran on KOFI's token");
  assert.equal(trust.spendToday(KOFI).spent_cents, 2306, "counted against Kofi");
  assert.equal(trust.spendToday(AGU).spent_cents, 0, "and against nobody else");
  assert.equal(trust.spendToday(OMARI).spent_cents, 0);

  // Agu cannot touch Kofi's cart, even carrying a yes of his own.
  const refused = await call("purchase_confirm", { conversation_id: kofiCart.conversation_id, cart_hash: kofiCart.cart_hash }, AGU);
  assert.equal(refused.ok, false);
  const req = await call("confirm_request", {
    action: "purchase_confirm", summary: "Buy that for $23.06?", stakes: "money", target: refused.use_target,
  }, AGU);
  messages.push({ role: "user", content: `[Sun, Oct 11, 2026, 4:00 PM] Agu: yes` });
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id }, AGU)).state, "granted");
  const stillNo = await call("purchase_confirm", {
    conversation_id: kofiCart.conversation_id, cart_hash: kofiCart.cart_hash, confirmation_id: req.confirmation_id,
  }, AGU);
  assert.equal(stillNo.blocked, "not_theirs", "Kofi's cart is not Agu's to confirm");

  // Nor can Agu track Kofi's order.
  assert.equal((await call("purchase_track", { order_id: bought.order_id }, AGU)).blocked, "not_theirs");
});

test("a conversation belonging to nobody cannot store a card or spend anything", async () => {
  const STRANGER = "dm:sendblue:+19998887777";
  for (const [tool, input] of [
    ["vault_enroll", {}],
    ["purchase", { ask: "coffee", ...ADDRESS }],
    ["purchase_confirm", { conversation_id: "conv_1abc", cart_hash: "x" }],
  ]) {
    const out = await call(tool, input, STRANGER);
    assert.equal(out.ok, false, tool);
    assert.equal(out.blocked, "no_account", tool);
  }
  assert.equal(fake.state.vaultSessions.length, 0, "no link was minted for nobody");
});

test("nobody may pre-authorize a purchase", () => {
  assert.ok(permissions.NEVER_STANDING.has("purchase_confirm"));
  assert.ok(permissions.GATED_ACTIONS.has("purchase_confirm"));
  assert.match(permissions.WHY_NEVER_STANDING.purchase_confirm, /cart/);
});

// ---------- tracking ----------

test("purchase_track reads the shop's own numbers and never invents them", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);
  const bought = await call("purchase_confirm", {
    conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes,
  });

  const out = await call("purchase_track", { order_id: bought.order_id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.order_number, "112-9988776-5544332");
  assert.equal(out.delivery_window, "Tue 14 Oct — Wed 15 Oct");
  assert.equal(out.shipments[0].tracking_number, "1Z999AA10123456784");
  assert.match(db.listActions(OMARI).find(a => a.action === "purchase_track").receipt, /112-9988776-5544332/);

  // An order just placed may have nothing on it yet, and that has to read as "not yet" rather than
  // as a delivery window somebody can plan around.
  fake.set({ trackEmpty: true });
  const early = await call("purchase_track", { order_id: bought.order_id });
  assert.equal(early.ok, true);
  assert.equal(early.delivery_window, undefined);
});

// ---------- the webhook ----------

const sign = (body, { secret = "whsec_test", t = Math.floor(clock.now() / 1000) } = {}) => ({
  "agentcard-signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`,
});

const deliver = (event, opts = {}) => {
  const raw = JSON.stringify(event);
  return agentcardWebhookRequest({ rawBody: raw, headers: sign(raw, opts), ...opts.extra });
};

test("an unsigned, badly signed or stale delivery is refused and changes nothing", async () => {
  const link = await call("vault_enroll", {});
  const event = { id: "evt_1", type: "vault.session_linked", data: { vault_session_id: link.vault_session_id, user_id: "usr_8f3k2m" } };
  const raw = JSON.stringify(event);

  for (const headers of [
    {},
    { "agentcard-signature": "t=1,v1=deadbeef" },
    sign(raw, { secret: "whsec_wrong" }),
    sign(raw, { t: Math.floor(clock.now() / 1000) - 3600 }),
  ]) {
    const out = await agentcardWebhookRequest({ rawBody: raw, headers });
    assert.equal(out.status, 401, JSON.stringify(headers));
  }
  assert.equal(db.getAgentcardUser(OMARI).user_id, "", "nobody was linked by an unproven call");

  // And with no secret on the machine at all it fails closed rather than open.
  const secret = config.agentcardWebhookSecret;
  config.agentcardWebhookSecret = "";
  try {
    assert.equal((await agentcardWebhookRequest({ rawBody: raw, headers: sign(raw) })).status, 401);
  } finally {
    config.agentcardWebhookSecret = secret;
  }
});

test("vault.session_linked attaches the user to whoever the link was sent to", async () => {
  const link = await call("vault_enroll", {});
  const out = await deliver({
    id: "evt_link", type: "vault.session_linked",
    data: { vault_session_id: link.vault_session_id, user_id: "usr_8f3k2m" },
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.linked, true);
  assert.equal(db.getAgentcardUser(OMARI).user_id, "usr_8f3k2m");

  // A session this machine never minted writes nothing rather than guessing at a person.
  const stray = await deliver({ id: "evt_stray", type: "vault.session_linked", data: { vault_session_id: "vs_nope", user_id: "usr_other" } });
  assert.equal(stray.status, 200);
  assert.equal(stray.body.linked, false);
});

test("a card landing is said in the thread, and a redelivery is not said twice", async () => {
  const link = await enroll();
  const said = [];
  const runtime = { say: (conversationId, text) => said.push({ conversationId, text }) };

  // The real order: `vault.session_linked` lands first and is what connects them, then
  // `vault.card_stored` follows seconds later. The second event only has somebody to be about
  // because the first one did the exchange.
  const linked = await deliver({
    id: "evt_linked", type: "vault.session_linked",
    data: { vault_session_id: link.vault_session_id, user_id: "usr_8f3k2m" },
  }, { extra: { runtime } });
  assert.equal(linked.body.connected, true, "the hook connected them");
  assert.equal(fake.state.exchanges.length, 1);

  const event = { id: "evt_card", type: "vault.card_stored", data: { user_id: "usr_8f3k2m", brand: "visa", last4: "4832" } };

  const first = await deliver(event, { extra: { runtime } });
  assert.equal(first.status, 200);
  assert.equal(first.body.stored, true);
  assert.equal(said.length, 1);
  assert.equal(said[0].conversationId, OMARI);
  assert.match(said[0].text, /Visa ••••4832/);
  assert.equal(db.getAgentcardUser(OMARI).card_last4, "4832");
  assert.doesNotMatch(said[0].text, /\d{13,}/, "no card number is ever in a message");

  // At-least-once delivery: the same id again is a no-op, not a second text.
  const again = await deliver(event, { extra: { runtime } });
  assert.equal(again.body.duplicate, true);
  assert.equal(said.length, 1, "told once");
});

test("an approval moves the row and stays quiet; a decline says so and marks it failed", async () => {
  await enroll();
  const cart = await shop();
  const yes = await yesFor(cart.conversation_id, cart.cart_hash);
  fake.set({ confirms: ["approval_required", "placed"] });
  await call("purchase_confirm", { conversation_id: cart.conversation_id, cart_hash: cart.cart_hash, confirmation_id: yes });

  const said = [];
  const runtime = { say: (conversationId, text) => said.push({ conversationId, text }) };

  // Approved: nothing is said, because the confirm call that is about to be repeated is the only
  // thing that knows whether the shop took the order.
  const ok = await deliver({
    id: "evt_ok", type: "checkout_authorization.approved",
    data: { user_id: "usr_8f3k2m", amount: 2306, authorization_id: "cauth_1", settlement: { status: "pending" } },
  }, { extra: { runtime } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.matched, true);
  assert.equal(db.getAgentcardPurchase(cart.conversation_id).status, "approved");
  assert.equal(said.length, 0, "nothing is promised before the order exists");

  // Declined on a second purchase: this one IS said, because the person tapped a link and walked
  // away and is owed the news.
  const two = await shop();
  const yes2 = await yesFor(two.conversation_id, two.cart_hash);
  fake.set({ confirms: ["approval_required"] });
  await call("purchase_confirm", { conversation_id: two.conversation_id, cart_hash: two.cart_hash, confirmation_id: yes2 });

  const no = await deliver({
    id: "evt_no", type: "checkout_authorization.declined",
    data: { user_id: "usr_8f3k2m", amount: 2306, authorization_id: "cauth_2", decline_code: "insufficient_funds" },
  }, { extra: { runtime } });
  assert.equal(no.status, 200);
  assert.equal(db.getAgentcardPurchase(two.conversation_id).status, "failed");
  assert.equal(db.getAgentcardPurchase(two.conversation_id).decline_code, "insufficient_funds");
  assert.equal(said.length, 1);
  assert.match(said[0].text, /nothing was charged/i);
});

test("an event type this install does not act on is dropped flat", async () => {
  const out = await deliver({ id: "evt_other", type: "cards.updated", data: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.ignored, "cards.updated");
});

// ---------- what Reason says it can do ----------

test("the capability line is three different honest answers, not one", async () => {
  const notSet = config.agentcardClientId;
  config.agentcardClientId = "";
  try {
    const row = capabilitiesNow({ conversationId: OMARI }).find(c => c.name === "buy_things");
    assert.equal(row.status, "not connected");
    assert.match(row.what, /not set up on this install/);
    assert.match(row.what, /Do not offer to buy anything/);
  } finally {
    config.agentcardClientId = notSet;
  }

  // Credentials, but this person has never stored a card.
  const noCard = capabilitiesNow({ conversationId: OMARI }).find(c => c.name === "buy_things");
  assert.equal(noCard.status, "not connected");
  assert.match(noCard.what, /has not stored a card yet/);

  // Connected for real — the finished link exchanged, the card read back off the vault. Nothing is
  // written by hand here, so "live" means the same thing it means in production.
  await enroll();
  assert.equal((await call("vault_enroll", {})).already_enrolled, true);
  const live = capabilitiesNow({ conversationId: OMARI }).find(c => c.name === "buy_things");
  assert.equal(live.status, "live");
  assert.match(live.what, /Visa ••••4832/);
  assert.match(live.what, /never sees the card number/);
});

// ---------- adding a card is AgentCard's, for everybody ----------

test("with AgentCard set up, 'add my card' goes to the vault", async () => {
  const offered = toolsFor(AMA).map(t => t.name);
  assert.ok(!offered.includes("payment_setup"), "no Stripe setup tool");
  assert.ok(!offered.includes("payment_charge"), "no Stripe charge tool");
  assert.ok(offered.includes("vault_enroll"), "vault_enroll is offered");
});
