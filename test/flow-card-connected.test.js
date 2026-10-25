// The real model, asked "Is my card connected now?" in the state of 2026-10-25 ~01:32Z: the owner
// opened the vault link and picked the Mastercard ••••1929 already in his vault, the session linked,
// and the connection is fresh. His record has a Walmart try declined for Reason's own fee setup
// (`commerce_billing_required`) and one cancelled for the address — and his memory carries the old
// wrong lines that the card was "declined repeatedly this week". The reply must say it IS connected,
// and say neither "declined" nor "nothing came through". Skipped with no model reachable; AgentCard
// is the local fixture, no texts leave the machine.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentCard } from "./fixture-agentcard.js";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-card-connected-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const agentcard = await import("../src/agentcard.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const MASTERCARD = [{ id: "vc_65116662b54c8be1e02dd856", brand: "mastercard", last4: "1929", expiry_month: 6, expiry_year: 2030, created_at: "2026-10-12T15:52:40.556Z" }];
let fake;

before(async () => {
  fake = await startAgentCard({ cards: MASTERCARD });
  config.agentcardClientId = "ac-client-abc";
  config.agentcardClientSecret = "ac-secret-xyz";
  config.agentcardApiBase = fake.url;
  config.publicUrl = "";
});
after(async () => { await fake?.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  agentcard.forgetAccessToken();
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** The state of 01:32Z: linked Oct 12, died, re-linked just now by picking the stored card. */
async function theReconnect() {
  const call = (name) => runTool(name, {}, { conversationId: C, messages: [] });
  await call("vault_enroll");
  fake.set({ sessionStatus: "linked" });
  await call("vault_enroll");
  db.db.prepare("UPDATE agentcard_users SET token_expires_at = ?, connection_dead_at = ? WHERE conversation_id = ?").run(clock.now() - 3_600_000, clock.now() - 3_000_000, C);
  fake.set({ sessionStatus: "pending" });
  const link = await call("vault_enroll");
  fake.set({ sessionStatus: "linked" });
  await call("vault_enroll"); // the exchange of the new link (the webhook's job on live)

  db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "conv_70255fa", status: "cart_shown", cartHash: "h_1", amountCents: 1676, merchant: "Walmart", what: "Cerave PM Niacinamide & Hyaluronic Acid 3 oz" });
  db.markAgentcardPurchase("conv_70255fa", { status: "declined", declineCode: "commerce_billing_required" });
  db.recordAgentcardPurchase({ conversationId: C, buyConversationId: "conv_3137fea", status: "cart_shown", cartHash: "h_2", amountCents: 1676, merchant: "Walmart", what: "Cerave PM Niacinamide & Hyaluronic Acid 3 oz" });
  db.markAgentcardPurchase("conv_3137fea", { status: "cancelled" });
  db.noteAgentcardCancelReason("conv_3137fea", { code: "invalid_shipping_address", detail: "The store could not use this shipping address." });
  // The wrong lines live memory really held (person_facts 724, 747).
  db.remember(C, "user", "Has a Mastercard ending in 1929 that was declined at Walmart on a Friday", { source: "inferred" });
  db.remember(C, "user", "Has a card that was declined repeatedly this week, and the assistant said it is the one on file", { source: "inferred" });

  db.saveConversation(C, [
    { role: "user", content: "[Sat, Oct 24, 2026, 9:30 PM] Omari: Add my card" },
    { role: "assistant", content: `here's your card link, it opens agentcard's own page:\n${link.url}` },
  ]);
}

test("'Is my card connected now?' after re-linking the stored card: yes, connected — no 'declined', no 'nothing came through'", { skip }, async () => {
  await theReconnect();
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const ch = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  try {
    clock.skip(60_000);
    const ask = "Is my card connected now?";
    db.claimInbound({ channel: "fake", externalId: "H-card", conversationId: C, text: ask });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: "H-card" });
    await rt.inbound(C, ask, { channel: "fake", to: OWNER, fromOwner: true });
    const reply = ch.sent.map(m => m.text).join("\n");
    console.log(JSON.stringify({ model: label, reply }));
    assert.ok(reply.trim(), "it answered");
    assert.doesNotMatch(reply, /declin/i, `never blames the card: ${reply}`);
    assert.doesNotMatch(reply, /nothing (new )?(has )?(came|come|went) through|hasn['’]t (shown|come) (up|through)|didn['’]t (go|come) through/i, `the link came through: ${reply}`);
    assert.match(reply, /connected|linked/i, `says it is connected: ${reply}`);
    assert.match(reply, /1929/, `names the card: ${reply}`);
    assert.doesNotMatch(reply, /not (connected|linked)|isn['’]t (connected|linked)|needs? (to be )?reconnect/i, `and does not say it isn't: ${reply}`);
  } finally { await rt.shutdown(); }
});
