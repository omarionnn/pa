// One owner reply is a yes to one ask, never to every ask that happened to be open when it arrived
// (security audit 2026-11-06, lead 27). Two asks opened in the same turn used to share one mark, so a
// "yes" aimed at the one the owner was shown also granted one they never saw.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-onereply-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONFIRM_WINDOW_MIN = "10";
process.env.REASON_TZ = "America/New_York";
delete process.env.REASON_PAYMENTS_KEY;

const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const C = "dm:onereply";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });
const readsYes = async () => ({ verdict: "yes" });

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM confirmations; DELETE FROM action_ledger;");
});

async function twoAsks(msgs) {
  const a = await runTool("confirm_request", { action: "call_place", target: "+15550000001", summary: "Call the dentist at +15550000001" }, { conversationId: C, messages: msgs });
  const b = await runTool("confirm_request", { action: "message_send", target: "+15550000002", summary: "Text +15550000002 the code" }, { conversationId: C, messages: msgs });
  assert.ok(a.confirmation_id && b.confirmation_id, JSON.stringify({ a, b }));
  return [a.confirmation_id, b.confirmation_id];
}

test("one reply grants one ask: a second ask open at the same time is not granted by it", async () => {
  const msgs = [owner("call the dentist")];
  const [a, b] = await twoAsks(msgs);
  msgs.push(owner("yes go ahead"));

  const ra = await runTool("confirm_record", { confirmation_id: a }, { conversationId: C, messages: msgs, judge: readsYes });
  assert.equal(ra.state, "granted");
  const rb = await runTool("confirm_record", { confirmation_id: b }, { conversationId: C, messages: msgs, judge: readsYes });
  assert.notEqual(rb.state, "granted", "the same reply must not also grant the other ask");
  assert.equal(rb.ok, false);
  assert.equal(trust.authorizeConfirmation({ conversationId: C, action: "message_send", confirmationId: b, target: "+15550000002" }).ok, false);
  // The ask it did answer still works.
  assert.equal(trust.authorizeConfirmation({ conversationId: C, action: "call_place", confirmationId: a, target: "+15550000001" }).ok, true);
  // Nothing is refused: the second ask is still open, and only a reply of its own can be its yes.
  assert.equal(db.getConfirmation(C, b).refused_at, null);
});

test("the second ask is granted by a later reply of its own", async () => {
  const msgs = [owner("call the dentist and text Sam the code")];
  const [a, b] = await twoAsks(msgs);
  msgs.push(owner("yes"));
  assert.equal((await runTool("confirm_record", { confirmation_id: a }, { conversationId: C, messages: msgs, judge: readsYes })).state, "granted");
  assert.equal((await runTool("confirm_record", { confirmation_id: b }, { conversationId: C, messages: msgs, judge: readsYes })).state, "waiting_for_yes");
  msgs.push(owner("yes text Sam too"));
  assert.equal((await runTool("confirm_record", { confirmation_id: b }, { conversationId: C, messages: msgs, judge: readsYes })).state, "granted");
  assert.equal(trust.authorizeConfirmation({ conversationId: C, action: "message_send", confirmationId: b, target: "+15550000002" }).ok, true);
});

test("asking about a granted ask again still says granted (not a second use of the reply)", async () => {
  const msgs = [owner("call the dentist")];
  const [a] = await twoAsks(msgs);
  msgs.push(owner("yes"));
  assert.equal((await runTool("confirm_record", { confirmation_id: a }, { conversationId: C, messages: msgs, judge: readsYes })).state, "granted");
  assert.equal((await runTool("confirm_record", { confirmation_id: a }, { conversationId: C, messages: msgs, judge: readsYes })).state, "granted");
});

test("a reply that was used survives the thread being trimmed: its mark moves with the thread", async () => {
  const msgs = [owner("one"), owner("two"), owner("call the dentist")];
  const [a, b] = await twoAsks(msgs);
  msgs.push(owner("yes"));
  assert.equal((await runTool("confirm_record", { confirmation_id: a }, { conversationId: C, messages: msgs, judge: readsYes })).state, "granted");
  // The two oldest lines are cut away; the same "yes" is still the latest reply.
  const trimmed = msgs.slice(2);
  db.shiftThreadMarks(C, { ownerTexts: 2 });
  assert.notEqual((await runTool("confirm_record", { confirmation_id: b }, { conversationId: C, messages: trimmed, judge: readsYes })).state, "granted");
});
