// "Is my card connected now?" is answered from the CONNECTION, and no refusal is ever pinned on the
// card unless its code says the card was refused.
//
// The incident (dm:owner, 2026-10-25 ~01:30Z): the owner said "Add my card", opened the vault link and
// picked his stored Mastercard ••••1929. `vault.session_linked` came in, the row got a fresh pair at
// 01:32:06 — the reconnect worked. Asked "is my card connected now?", Reason said "nothing new has
// come through from that link" and that ••••1929 was "the card that's been getting declined all
// week". vault_enroll had told it only "already has Mastercard ••••1929 stored … no link is needed"
// beside stored_at 2026-10-12, and its purchases read "declined, not bought" with no reason — the
// one Walmart decline was `commerce_billing_required` (Reason's own fee setup) and the other try was
// cancelled for `invalid_shipping_address`.
//
// Pinned, one each:
//   - a re-link that picks the card already stored reads as connected, just linked;
//   - `commerce_billing_required` is never the card being declined, in the block, purchases_recent
//     or vault_enroll — and only a card-refused code ever is;
//   - a dead connection with a card still stored reads as "needs reconnecting", with why;
//   - session_linked over an old dead token exchanges the new link instead of logging connected.
//
// No key, no network: the API base points at the fixture.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { startAgentCard } from "./fixture-agentcard.js";

const dir = mkdtempSync(join(tmpdir(), "reason-card-honest-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "33".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const tools = await import("../src/tools.js");
const { runTool, cardConnectionReport } = tools;
const agentcard = await import("../src/agentcard.js");
const db = await import("../src/db.js");
const { purchasesNote, blockFor, recentPurchases } = await import("../src/purchasesnote.js");
const { agentcardWebhookRequest } = await import("../src/http.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const MASTERCARD = [{ id: "vc_65116662b54c8be1e02dd856", brand: "mastercard", last4: "1929", expiry_month: 6, expiry_year: 2030, created_at: "2026-10-12T15:52:40.556Z" }];
let fake;

const call = (name, input = {}) => runTool(name, input, { conversationId: OMARI, messages: [] });
const sign = (body, t = Math.floor(clock.now() / 1000)) => ({
  "agentcard-signature": `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`,
});
const deliver = (event) => { const raw = JSON.stringify(event); return agentcardWebhookRequest({ rawBody: raw, headers: sign(raw) }); };

before(async () => {
  fake = await startAgentCard({ cards: MASTERCARD });
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
  db.db.exec("DELETE FROM agentcard_users; DELETE FROM agentcard_purchases; DELETE FROM agentcard_events; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM offers;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fake.set({ sessionStatus: "pending", sessionUser: "usr_8f3k2m", knownUsers: ["usr_8f3k2m"], cardsByUser: null, exchange: "ok", refresh: "ok", refreshDelayMs: 0 });
  fake.state.exchanged.clear();
  fake.state.liveRefresh.clear();
});

/** Linked on Oct 12 through the real path, then the connection died (refresh refused) a while ago. */
async function linkedLongAgoThenDied() {
  await call("vault_enroll");
  fake.set({ sessionStatus: "linked" });
  const first = await call("vault_enroll");
  assert.equal(first.already_enrolled, true, JSON.stringify(first));
  clock.skip(12 * 24 * 3_600_000); // twelve days on
  db.db.prepare("UPDATE agentcard_users SET token_expires_at = ?, connection_dead_at = ? WHERE conversation_id = ?")
    .run(clock.now() - 3_600_000, clock.now() - 3_000_000, OMARI);
  fake.set({ sessionStatus: "pending" });
}

/** The owner's real purchase rows: one declined for Reason's fee setup, one cancelled for the address. */
function theWalmartTries() {
  db.recordAgentcardPurchase({ conversationId: OMARI, buyConversationId: "conv_70255fa", status: "cart_shown", cartHash: "h_1", amountCents: 1676, merchant: "Walmart", what: "Cerave PM Niacinamide & Hyaluronic Acid" });
  db.markAgentcardPurchase("conv_70255fa", { status: "declined", declineCode: "commerce_billing_required" });
  db.recordAgentcardPurchase({ conversationId: OMARI, buyConversationId: "conv_3137fea", status: "cart_shown", cartHash: "h_2", amountCents: 1676, merchant: "Walmart", what: "Cerave PM Niacinamide & Hyaluronic Acid" });
  db.markAgentcardPurchase("conv_3137fea", { status: "cancelled" });
  db.noteAgentcardCancelReason("conv_3137fea", { code: "invalid_shipping_address", detail: "The store could not use this shipping address." });
}

const CARD_BLAMED = /card (was|is|has been|keeps|getting|got) (being )?(declined|refused)|declined (the|your) card|card['’]s been (getting )?declined/i;

test("pinned 2026-10-25: re-linking by picking the card already stored reads as CONNECTED, just linked", async () => {
  await linkedLongAgoThenDied();

  // "Add my card": the connection is dead, so a link goes out — and it says the card is still stored.
  const link = await call("vault_enroll");
  assert.ok(link.url, JSON.stringify(link));

  // He opens it and picks Mastercard ••••1929, the one already in his vault; the session links.
  fake.set({ sessionStatus: "linked" });
  const hook = await deliver({ id: "evt_relink", type: "vault.session_linked", data: { vault_session_id: link.vault_session_id, user_id: "usr_8f3k2m" } });
  assert.equal(hook.status, 200);
  assert.equal(hook.body.connected, true);
  const row = db.getAgentcardUser(OMARI);
  assert.ok(Number(row.token_expires_at) > clock.now(), "a live pair from THIS link, not the old dead one");
  assert.equal(row.exchanged_session, link.vault_session_id);
  assert.equal(row.connection_dead_at, null);

  // "Is my card connected now?"
  const minted = fake.state.vaultSessions.length;
  const out = await call("vault_enroll");
  assert.equal(out.already_enrolled, true);
  assert.equal(out.connection, "connected");
  assert.equal(out.auto_renewing, true);
  assert.equal(out.just_linked, true);
  assert.ok(out.last_linked, "when it was last linked");
  assert.match(out.note, /^CONNECTED\. Omari opened the card link and picked Mastercard ••••1929 — that IS the link coming through/);
  assert.match(out.note, /Picking a card already stored in their vault is the normal way to reconnect it/);
  assert.match(out.note, /the answer is yes: Mastercard ••••1929 is linked again/);
  assert.match(out.note, /stored_at is when the card was first saved, not when it was last linked/);
  assert.doesNotMatch(out.note.replace(/Never say nothing came through[^.]*\./, ""), /nothing (new )?(has )?(came|come) through|hasn['’]t shown up/i);
  assert.equal(fake.state.vaultSessions.length, minted, "no second link minted for a question");
});

test("pinned 2026-10-25: session_linked over an old dead token exchanges the link — it is not 'connected' already", async () => {
  await linkedLongAgoThenDied();
  const link = await call("vault_enroll");
  const exchangesBefore = fake.state.exchanges.length;
  fake.set({ sessionStatus: "linked" });
  const hook = await deliver({ id: "evt_relink2", type: "vault.session_linked", data: { vault_session_id: link.vault_session_id, user_id: "usr_8f3k2m" } });
  assert.equal(hook.body.connected, true);
  assert.equal(fake.state.exchanges.length, exchangesBefore + 1, "the new link was cashed in by the webhook itself");
  assert.ok(db.getAgentcardUser(OMARI).linked_at >= clock.now() - 1_000, "last linked moves with a new link");
});

test("pinned 2026-10-25: commerce_billing_required is never the card being declined", async () => {
  // The words for each refusal, attributed.
  const fee = agentcard.refusalWhy({ status: "declined", decline_code: "commerce_billing_required" });
  assert.equal(fee.card, false);
  assert.equal(fee.whose, "reason_setup");
  assert.doesNotMatch(fee.words, /\bcard\b/i);
  const addr = agentcard.refusalWhy({ status: "cancelled", cancel_reason: "invalid_shipping_address" });
  assert.equal(addr.whose, "address");
  assert.equal(addr.card, false);
  assert.equal(agentcard.refusalWhy({ status: "declined", decline_code: "mystery_code" }).card, false, "an unknown code is AgentCard's, never the card's");
  assert.equal(agentcard.refusalWhy({ status: "declined", decline_code: "card_declined" }).card, true, "only a card-refused code is the card");
  assert.equal(agentcard.refusalWhy({ status: "placed" }), null);

  theWalmartTries();
  // The block that rides on a buying turn.
  const note = purchasesNote(OMARI);
  assert.match(note, /declined, not bought · why: Reason's AgentCard fee setup wasn't finished \(Reason's own setup, not the card\)/);
  assert.match(note, /CANCELLED by the shop, not coming · why: the store couldn't use the shipping address/);
  assert.match(note, /NONE of these was their card being declined; never say it was, whatever the chat or memory says/);
  assert.doesNotMatch(note, CARD_BLAMED);

  // purchases_recent says the same.
  const recent = await call("purchases_recent");
  const declined = recent.purchases.find(p => p.status.startsWith("declined"));
  assert.equal(declined.card_refused, false);
  assert.equal(declined.whose, "Reason's own setup, not the card");
  assert.match(recent.note, /NONE of these was their card being declined/);

  // And the card question itself carries the record.
  await call("vault_enroll");
  fake.set({ sessionStatus: "linked" });
  const out = await call("vault_enroll");
  assert.match(out.note, /Purchases that did not go through, from the record: .*Walmart: declined, not bought — Reason's AgentCard fee setup wasn't finished \(Reason's own setup, not the card\)/);
  assert.match(out.note, /Walmart: CANCELLED by the shop, not coming — the store couldn't use the shipping address \(the delivery address, not the card\)/);
  assert.match(out.note, /NONE of these was their card being declined/);
  assert.doesNotMatch(out.note, CARD_BLAMED);

  // Only a real card refusal is ever said as one.
  const rows = recentPurchases(OMARI);
  const withCard = [{ ...rows[0], reason: "the bank turned the card down", whose: "the card itself", card_refused: true }, ...rows.slice(1)];
  assert.match(blockFor(withCard), /Only a row marked as the card itself was their card being declined/);
});

test("pinned 2026-10-25: a dead connection with a card still stored reads as 'needs reconnecting', with why", async () => {
  await linkedLongAgoThenDied();
  const out = await call("vault_enroll");
  assert.equal(out.connection, "needs_reconnecting");
  assert.equal(out.auto_renewing, false);
  assert.equal(out.card, "Mastercard ••••1929");
  assert.match(out.why, /AgentCard stopped accepting Reason's saved renewal/);
  assert.ok(out.last_linked);
  assert.match(out.note, /^NOT CONNECTED — needs reconnecting\. Mastercard ••••1929 is still stored in Omari's vault, but the link between it and Reason is gone/);
  assert.match(out.note, /Never call it connected because a card is on file/);
  assert.ok(out.url, "and the one link that brings it back");
});

test("the report: a lapsed token with a refresh token renews itself; none at all needs reconnecting", () => {
  const now = Date.parse("2026-10-25T02:00:00Z");
  const base = { card_brand: "mastercard", card_last4: "1929", linked_at: now - 30 * 60_000, vault_session_id: "vs_1", exchanged_session: "vs_1" };
  assert.deepEqual(
    { ...cardConnectionReport({ ...base, access_token: "a", refresh_token: "r", token_expires_at: now + 50 * 60_000 }, now), last_linked: "x" },
    { connection: "connected", auto_renewing: true, card: "Mastercard ••••1929", last_linked: "x", just_linked: true });
  assert.equal(cardConnectionReport({ ...base, access_token: "a", refresh_token: "r", token_expires_at: now - 60_000 }, now).connection, "connected", "the sweep renews it");
  const none = cardConnectionReport({ ...base, access_token: "a", refresh_token: "", token_expires_at: now - 60_000 }, now);
  assert.equal(none.connection, "needs_reconnecting");
  assert.match(none.why, /no saved renewal/);
  assert.equal(cardConnectionReport({ ...base, linked_at: now - 7 * 3_600_000, access_token: "a", refresh_token: "r", token_expires_at: now + 1 }, now).just_linked, false, "old news is not 'just linked'");
});
