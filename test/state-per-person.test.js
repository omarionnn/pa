// A pause or a removal belongs to the person, not to the line they texted.
//
// Reason can have two texting lines at once (Sendblue and Linq). The master's "stop answering
// +1415…" is about a number. Before this, the state was kept on one (channel, number) row and
// admission only looked under the channel the text arrived on, so a paused or removed number that
// texted the OTHER line looked like a stranger: with auto-admit on it got a fresh, active Reason
// and a model turn on the master's bill; with it off the master was asked again with no word that
// the number had been stopped. (security audit run-1, lead 8)
//
// No API key, no network, no model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-state-per-person-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const access = await import("../src/access.js");
const accounts = await import("../src/accounts.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { whoseCallIsThis } = await import("../src/calls/inbound.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const KOFI = "+14155559876";

/** A second texting line: the same fake, under another channel name. */
class OtherLine extends FakeChannel { name = "other"; }

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM ops_digest; DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM blocked_numbers; DELETE FROM turned_away; DELETE FROM usage; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: `dm:fake:${KOFI}`, channel: "fake", address: KOFI, name: "Kofi" });
});

function harness() {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "ok"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "yes" }) });
  const fake = router.register(new FakeChannel({}));
  const other = router.register(new OtherLine({}));
  return { router, fake, other, turns };
}
const text = (channel, from, body, id = String(Math.random())) => ({ channel, externalId: id, from, text: body, at: clock.now() });

async function withAutoAdmit(on, fn) {
  const kept = config.autoAdmit;
  config.autoAdmit = on;
  try { return await fn(); } finally { config.autoAdmit = kept; }
}

for (const action of ["admin_remove", "admin_pause"]) {
  const state = action === "admin_remove" ? "removed" : "paused";

  test(`${state} on one line is ${state} on the other: admission refuses, nothing is created`, async () => {
    const out = await runTool(action, { number: KOFI }, { conversationId: config.ownerConversation });
    assert.equal(out.ok, true);
    assert.equal(accounts.admit({ channel: "fake", address: KOFI }).reason, state);
    const other = accounts.admit({ channel: "other", address: KOFI });
    assert.equal(other.allow, false);
    assert.equal(other.reason, state, "the other line sees the same stop, not a stranger");
    assert.equal(db.getAccount(`dm:other:${KOFI}`), null, "no second Reason was made");
  });

  test(`${state}: texting the other line with auto-admit on gets no account and no model turn`, async () => {
    await runTool(action, { number: KOFI }, { conversationId: config.ownerConversation });
    await withAutoAdmit(true, async () => {
      const h = harness();
      const out = await h.router.deliver(text("other", KOFI, "hey you there?"));
      assert.equal(out.admitted, false);
      assert.equal(out.stopped, state);
      assert.equal(h.turns.length, 0, "no turn on the master's bill");
      assert.equal(db.getAccount(`dm:other:${KOFI}`), null);
      // Even called directly, the unknown-number path does not make one.
      const unknown = access.handleUnknown({ channel: "other", address: KOFI, text: "hi" });
      assert.notEqual(unknown.action, "auto_admitted");
      assert.equal(db.getAccount(`dm:other:${KOFI}`), null);
    });
  });

  test(`${state}: without auto-admit the master is not asked again from the other line`, async () => {
    await runTool(action, { number: KOFI }, { conversationId: config.ownerConversation });
    await withAutoAdmit(false, async () => {
      const h = harness();
      const out = await h.router.deliver(text("other", KOFI, "let me back in"));
      assert.equal(out.stopped, state);
      assert.equal(db.unannouncedRequests().length, 0, "no fresh access request");
      assert.equal(h.turns.length, 0);
    });
  });
}

test("an unused invite cannot bring a removed number back on the other line", async () => {
  await runTool("admin_remove", { number: KOFI }, { conversationId: config.ownerConversation });
  db.db.prepare(`INSERT INTO invites (conversation_id, token, claim_code, state, created_at) VALUES (?, ?, ?, 'unused', ?)`)
    .run(config.ownerConversation, "tok-l8", "ABCD2345", clock.now());
  const out = db.redeemInvite({ claimCode: "ABCD2345", channel: "other", address: KOFI });
  assert.equal(out.ok, false);
  assert.equal(db.getAccount(`dm:other:${KOFI}`), null);
  assert.equal(db.inviteByClaimCode("ABCD2345").state, "unused", "the invite is not spent");
});

test("resume puts the number back on every line, including a row the pause did not touch", async () => {
  // Kofi already had a second Reason on the other line (made before this fix, or legitimately).
  db.upsertAccount({ conversationId: `dm:other:${KOFI}`, channel: "other", address: KOFI, name: "Kofi" });
  await runTool("admin_pause", { number: KOFI }, { conversationId: config.ownerConversation });
  assert.equal(accounts.admit({ channel: "fake", address: KOFI }).reason, "paused");
  assert.equal(accounts.admit({ channel: "other", address: KOFI }).reason, "paused");
  await runTool("admin_resume", { number: KOFI }, { conversationId: config.ownerConversation });
  assert.equal(accounts.admit({ channel: "fake", address: KOFI }).allow, true);
  assert.equal(accounts.admit({ channel: "other", address: KOFI }).allow, true);
});

test("a harm pause on one conversation stops the number on the other line too", () => {
  db.upsertAccount({ conversationId: `dm:other:${KOFI}`, channel: "other", address: KOFI, name: "Kofi" });
  db.setAccountState(`dm:fake:${KOFI}`, "paused");
  assert.equal(accounts.accountState("other", KOFI), "paused");
  assert.equal(accounts.admit({ channel: "other", address: KOFI }).reason, "paused");
});

test("an active account on one line is untouched: the other line still asks, as before", () => {
  assert.equal(accounts.accountState("fake", KOFI), "active");
  assert.equal(accounts.accountState("other", KOFI), null, "no stop anywhere, so the other line is still a fresh ask");
  assert.equal(accounts.admit({ channel: "other", address: KOFI }).reason, "no_account_yet");
});

test("a call from the number is refused when a non-newest row is paused", () => {
  db.upsertAccount({ conversationId: `dm:other:${KOFI}`, channel: "other", address: KOFI, name: "Kofi" });
  db.setAccountState(`dm:other:${KOFI}`, "paused");
  // The active fake row is the newest seen, which is the one a call joins.
  db.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE conversation_id = ?").run(clock.now() + 60_000, `dm:fake:${KOFI}`);
  assert.equal(db.accountByNumber(KOFI).conversation_id, `dm:fake:${KOFI}`);
  const who = whoseCallIsThis(KOFI);
  assert.equal(who.allow, false);
  assert.equal(who.reason, "paused");
});

test("background sweeps skip a number paused on its other line", async () => {
  db.db.exec("DELETE FROM commitments;");
  db.saveCommitment(`dm:fake:${KOFI}`, { what: "morning run", days: [0, 1, 2, 3, 4, 5, 6], atMin: 420, timeZone: "America/New_York", said: "morning run" });
  const runtime = new Runtime({ runTurn: async () => "ok" });
  assert.equal((await runtime.commitments()).people, 1, "active everywhere: the sweep looks at them");
  db.upsertAccount({ conversationId: `dm:other:${KOFI}`, channel: "other", address: KOFI, name: "Kofi" });
  db.setAccountState(`dm:other:${KOFI}`, "paused");
  assert.equal((await runtime.commitments()).people, 0, "paused on the other line: nothing unprompted on this one");
});
