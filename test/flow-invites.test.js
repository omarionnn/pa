// Invites, read by meaning (src/invites.js): with the real model, the handful of things people say
// about invites reach the right tool. No regex decides any of these — the model does, off the tool
// descriptions — so this is the test that the descriptions are good enough. Skipped with no model
// reachable; on a key, run it with REASON_BACKEND=api so it never touches a subscription.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-invites-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
// Switched on for everybody, so a non-owner's words can reach the tools; the dark state is pinned in
// test/invites-dark.test.js.
process.env.REASON_INVITES_OPEN = "1";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const invites = await import("../src/invites.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const OWNER_C = "dm:owner";
const KOFI_C = `dm:fake:${KOFI}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM invite_requests;");
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  db.backfillInviteAllowances();
});

function harness() {
  const tools = [];
  const rt = new Runtime({ log: (e) => { if (e?.tool) tools.push({ name: e.tool, input: e.input }); } });
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  async function says(c, address, handle, text) {
    clock.skip(90_000);
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: c, text });
    db.upsertThread({ conversationId: c, channel: "fake", address, isOwner: true, service: "iMessage", lastInboundId: handle });
    return await rt.inbound(c, text, { channel: "fake", to: address, fromOwner: true });
  }
  return { rt, fake, tools, says };
}

const called = (tools, name) => tools.filter(t => t.name === name);

test(`"my invites" lists them (${label})`, { skip }, async () => {
  invites.makeLink(KOFI_C);
  const { rt, tools, says } = harness();
  try {
    await says(KOFI_C, KOFI, "I-1", "my invites");
    assert.ok(called(tools, "invites_list").length, `invites_list ran: ${JSON.stringify(tools.map(t => t.name))}`);
  } finally { await rt.shutdown(); }
});

test(`"request more invites" asks how many and why before filing (${label})`, { skip }, async () => {
  const { rt, tools, says } = harness();
  try {
    await says(KOFI_C, KOFI, "R-1", "request more invites");
    assert.equal(called(tools, "invite_request_more").length, 0, "nothing filed before a count and a reason");
    await says(KOFI_C, KOFI, "R-2", "5");
    await says(KOFI_C, KOFI, "R-3", "for my roommates, they keep asking about it");
    const filed = db.pendingInviteRequest(KOFI_C);
    assert.ok(filed, `a request was filed: ${JSON.stringify(tools.map(t => t.name))}`);
    assert.equal(filed.requested_count, 5);
    assert.match(filed.explanation, /roommate/i);
  } finally { await rt.shutdown(); }
});

test(`"cancel my unused invite" cancels it, and the invite is not lost (${label})`, { skip }, async () => {
  const made = invites.makeLink(KOFI_C);
  const { rt, tools, says } = harness();
  try {
    await says(KOFI_C, KOFI, "C-1", "cancel my unused invite");
    // It may look first; what matters is the link ended up canceled.
    assert.equal(db.getInvite(KOFI_C, made.number).state, "canceled", `canceled: ${JSON.stringify(tools.map(t => t.name))}`);
    assert.equal(db.inviteAllowance(KOFI_C), 2);
  } finally { await rt.shutdown(); }
});

test(`the owner's "approve 3" approves request #3, not the third in a list (${label})`, { skip }, async () => {
  // Two requests so a position and an id differ: Kofi's is #3, filed second.
  db.db.prepare("INSERT INTO invite_requests (id, conversation_id, requested_count, explanation, state, created_at, updated_at) VALUES (7, 'dm:fake:+15550000001', 2, 'cousins', 'pending', 1, 1)").run();
  db.db.prepare("INSERT INTO invite_requests (id, conversation_id, requested_count, explanation, state, created_at, updated_at) VALUES (3, ?, 4, 'my band', 'pending', 2, 2)").run(KOFI_C);
  const { rt, tools, says } = harness();
  try {
    // What the owner saw: the request line, as the tool sends it.
    db.saveConversation(OWNER_C, [{ role: "assistant", content: invites.requestLineForMaster(db.getInviteRequest(3)) }]);
    await says(OWNER_C, OWNER, "A-1", "approve 3");
    assert.equal(db.getInviteRequest(3).state, "approved", `#3 approved: ${JSON.stringify(tools)}`);
    assert.equal(db.getInviteRequest(7).state, "pending", "and #7 untouched");
    assert.equal(db.inviteAllowance(KOFI_C), 6);
  } finally { await rt.shutdown(); }
});

test(`switched off, a non-owner asking to invite a friend is never handed an invite tool (${label})`, { skip }, async (t) => {
  config.invitesOpen = false;
  const { rt, fake, tools, says } = harness();
  try {
    await says(KOFI_C, KOFI, "D-1", "can i get an invite link to send my friend so she can use you too?");
    const reply = fake.sent.filter(m => m.to === KOFI).map(m => m.text).join("\n");
    t.diagnostic(`reply: ${reply}`);
    // A real answer, not a failed turn passing for one.
    assert.ok(reply && !/broke on my end/.test(reply), `the turn answered: ${reply}`);
    assert.ok(!/\/i\/[A-Za-z0-9_-]{32}/.test(reply), "no invite link in it");
    assert.deepEqual(tools.filter(t => /^invite/.test(t.name)), [], `no invite tool ran: ${JSON.stringify(tools.map(t => t.name))}`);
    assert.equal(db.listInvites(KOFI_C).length, 0, "and no link exists");
  } finally { config.invitesOpen = true; await rt.shutdown(); }
});
