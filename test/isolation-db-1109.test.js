// Isolation fixes from the 11-09 database review: one person's rows and names never reach another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-iso1109-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY ??= "11".repeat(32);

const db = await import("../src/db.js");

const ALICE = "dm:test:+15550001111";
const BOB = "dm:test:+15550002222";

test("a number that is another person's Reason never comes back with their registered name", () => {
  db.upsertAccount({ conversationId: BOB, channel: "test", address: "+15550002222", name: "Bobby Secretname" });
  const hit = db.knownPersonByNumber(ALICE, "(555) 000-2222");
  assert.ok(hit, "still treated as a person, so asks stay gated");
  assert.equal(hit.from, "accounts");
  assert.equal(hit.who, db.OTHER_ACCOUNT_WHO);
  assert.doesNotMatch(JSON.stringify(hit), /Bobby|Secretname/);
});

test("a name from their own records still wins over the accounts lookup", () => {
  db.upsertAccount({ conversationId: BOB, channel: "test", address: "+15550002222", name: "Bobby Secretname" });
  db.remember(ALICE, "+15550002222", "this is my brother Kwame");
  const hit = db.knownPersonByNumber(ALICE, "+15550002222");
  assert.ok(hit);
  assert.doesNotMatch(String(hit.who), /Bobby|Secretname/);
});

test("saving a to-do list under someone else's list id leaves their list alone", () => {
  const bobs = db.saveTodoList(BOB, { title: "Bob's errands", items: [{ text: "pick up the cake", grp: "mine" }] });
  assert.equal(db.todoItems(bobs.id).length, 1);
  assert.throws(() => db.saveTodoList(ALICE, { listId: bobs.id, title: "hijack", items: [{ text: "x", grp: "mine" }, { text: "y", grp: "mine" }] }), /No to-do list/);
  const after = db.todoItems(bobs.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].text, "pick up the cake");
  assert.equal(db.getTodoList(BOB, bobs.id).title, "Bob's errands");
  // Their own list still saves and replaces its items as before.
  const again = db.saveTodoList(BOB, { listId: bobs.id, title: "Bob's errands", items: [{ text: "a", grp: "mine" }, { text: "b", grp: "mine" }] });
  assert.equal(db.todoItems(again.id).length, 2);
});

test("an AgentCard purchase upsert never rewrites another person's purchase row", () => {
  db.recordAgentcardPurchase({ conversationId: BOB, buyConversationId: "buy-1", status: "awaiting_approval", cartHash: "h-bob", amountCents: 1200, merchant: "Store", what: "socks" });
  db.recordAgentcardPurchase({ conversationId: ALICE, buyConversationId: "buy-1", status: "awaiting_approval", cartHash: "h-alice", amountCents: 99999, merchant: "Evil", what: "tv" });
  const row = db.getAgentcardPurchase("buy-1");
  assert.equal(row.conversation_id, BOB);
  assert.equal(row.cart_hash, "h-bob");
  assert.equal(Number(row.amount_cents), 1200);
  // The owner's own update still lands.
  db.recordAgentcardPurchase({ conversationId: BOB, buyConversationId: "buy-1", status: "placed", cartHash: "h-bob", amountCents: 1200, merchant: "Store", what: "socks" });
  assert.equal(db.getAgentcardPurchase("buy-1").status, "placed");
});

test("check-then-act updates are pinned to the owner in SQL too", () => {
  const plan = db.createPlan ? db.createPlan(BOB, { title: "trip" }) : null;
  if (plan?.id) {
    assert.equal(db.updatePlan(ALICE, plan.id, { title: "x" }).ok, false);
    assert.equal(db.setPlanStatus(ALICE, plan.id, "cancelled").ok, false);
  }
  const t = db.createTimer(BOB, { fireAt: Date.now() + 3_600_000, note: "call mom" });
  const tid = typeof t === "object" ? t.id ?? t.timer?.id : t;
  assert.equal(db.cancelTimer(ALICE, tid).ok, false);
  assert.equal(db.cancelTimer(BOB, tid).ok, true);
});
