// The confirm gate, the ledger and the accounts registry, without the model.
// These are the guards, so they get tested directly: no API key needed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-trust-"));
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

const C = "dm:trust";
// A conversation the way the agent builds it: owner turns are prefixed strings.
const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });
const event = (t) => ({ role: "user", content: `[event Wed, Sep 30, 2026, 3:00 PM] ${t}` });
const toolResult = () => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "{}" }] });

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM connected_accounts;");
});

test("ownerTexts sees only the owner's own words", () => {
  const msgs = [owner("dinner friday"), toolResult(), event("timer #1 fired"), owner("yeah do it")];
  assert.deepEqual(trust.ownerTexts(msgs), ["dinner friday", "yeah do it"]);
});

test("a negative inside an affirmative still reads as no", () => {
  assert.equal(trust.readsAsYes("yeah no don't"), "no");
  assert.equal(trust.readsAsYes("nah"), "no");
  assert.equal(trust.readsAsYes("hold on"), "no");
  assert.equal(trust.readsAsYes("yes do it"), "yes");
  assert.equal(trust.readsAsYes("bet"), "yes");
  assert.equal(trust.readsAsYes("go ahead"), "yes");
  assert.equal(trust.readsAsYes("what does that cost"), "unclear");
  assert.equal(trust.readsAsYes(""), "unclear");
});

test("a guarded tool refuses with no confirmation at all", async () => {
  const out = await runTool("account_connect", { name: "payments" }, { conversationId: C, messages: [owner("connect payments")] });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  // The refusal itself is a receipt.
  const led = db.listActions(C);
  assert.equal(led.length, 1);
  assert.equal(led[0].outcome, "blocked");
  assert.equal(led[0].target, "account:payments");
});

test("the model cannot grant its own confirmation in the same turn", async () => {
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect the payments account", stakes: "money" }, { conversationId: C, messages: msgs });
  assert.equal(req.ok, true);
  // No new owner message has arrived, so the guard will not grant.
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(rec.ok, false);
  assert.equal(rec.state, "waiting_for_yes");
  const gate = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(gate.blocked, "not_granted");
});

test("an unclear reply authorizes nothing", async () => {
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect payments" }, { conversationId: C, messages: msgs });
  msgs.push(owner("what would that let you do"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(rec.ok, false);
  assert.equal(rec.state, "waiting_for_yes");
  assert.equal(db.getConfirmation(C, req.confirmation_id).granted_at, null);
});

test("a no refuses the confirmation for good", async () => {
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect payments" }, { conversationId: C, messages: msgs });
  msgs.push(owner("nah forget it"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(rec.state, "refused");
  assert.ok(db.getConfirmation(C, req.confirmation_id).refused_at);
  // And it stays refused even if a later message is a yes.
  msgs.push(owner("ok fine yes"));
  const again = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(again.state, "refused");
});

test("a real yes is granted, quoted, spent once, and never reusable", async () => {
  process.env.REASON_PAYMENTS_KEY = "test-key";
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect the payments account with pay_link and refund" }, { conversationId: C, messages: msgs });
  msgs.push(owner("yeah go for it"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(rec.state, "granted");
  assert.equal(rec.quote, "yeah go for it", "the guard stores their actual words");

  const out = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(out.ok, true);
  assert.equal(out.status, "connected");
  assert.equal(db.liveAccount("payments").name, "payments");
  assert.ok(db.getConfirmation(C, req.confirmation_id).consumed_at, "spent");

  // Same yes cannot buy a second action.
  const twice = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(twice.blocked, "already_spent");

  // Ledger holds both: the success and the blocked retry.
  const led = db.listActions(C);
  assert.equal(led.length, 2);
  assert.equal(led[0].outcome, "blocked");
  assert.equal(led[1].outcome, "ok");
  assert.equal(led[1].confirmation_id, req.confirmation_id);
  assert.match(led[1].receipt, /Connected the payments account/);
  delete process.env.REASON_PAYMENTS_KEY;
});

test("a yes goes stale after the window", async () => {
  process.env.REASON_PAYMENTS_KEY = "test-key";
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect payments" }, { conversationId: C, messages: msgs });
  msgs.push(owner("yes"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  clock.skip(11 * 60_000);
  const out = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(out.blocked, "stale");
  assert.equal(db.liveAccount("payments"), null);
  delete process.env.REASON_PAYMENTS_KEY;
});

test("a yes for one action does not authorize another", async () => {
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "browser_submit", summary: "submit the booking" }, { conversationId: C, messages: msgs });
  msgs.push(owner("yep"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  const out = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(out.blocked, "wrong_action");
});

test("a provider with no credentials is not_connected and says what is missing", async () => {
  const msgs = [owner("read my email")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect gmail" }, { conversationId: C, messages: msgs });
  msgs.push(owner("yes please"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  const out = await runTool("account_connect", { name: "gmail", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
  assert.ok(out.missing.includes("GOOGLE_OAUTH_CLIENT_ID"));
  assert.equal(db.liveAccount("gmail"), null, "nothing was recorded as connected");
  // The honest failure still leaves a receipt.
  assert.match(db.listActions(C)[0].receipt, /Tried to connect the gmail account/);
});

test("account_list reports every provider honestly", async () => {
  const { accounts } = trust.listAccounts();
  const byName = Object.fromEntries(accounts.map(a => [a.name, a]));
  for (const n of ["gmail", "google_calendar", "phone_out", "payments"]) {
    assert.equal(byName[n].status, "not_connected", `${n} must not claim to be connected`);
    assert.ok(byName[n].missing.length > 0);
  }
});

test("revoke cuts access and needs no confirmation", async () => {
  process.env.REASON_PAYMENTS_KEY = "test-key";
  db.connectAccount("payments", ["pay_link"]);
  const out = await runTool("account_revoke", { name: "payments" }, { conversationId: C, messages: [owner("revoke payments")] });
  assert.equal(out.ok, true);
  assert.equal(db.liveAccount("payments"), null);
  assert.match(db.listActions(C)[0].receipt, /Revoked the payments account/);
  delete process.env.REASON_PAYMENTS_KEY;
});

test("ledger_list reads back only what really happened", async () => {
  const out = await runTool("ledger_list", {}, { conversationId: C, messages: [owner("what did you do today")] });
  assert.equal(out.count, 0);
  db.recordAction({ conversationId: C, action: "account_revoke", target: "account:payments", attempted: {}, outcome: "ok", result: {}, receipt: "Revoked the payments account." });
  const out2 = await runTool("ledger_list", {}, { conversationId: C, messages: [owner("what did you do today")] });
  assert.equal(out2.count, 1);
  assert.equal(out2.actions[0].outcome, "ok");
  // Another conversation's actions never leak in.
  db.recordAction({ conversationId: "dm:someone-else", action: "account_revoke", target: "x", attempted: {}, outcome: "ok", result: {}, receipt: "not yours" });
  const out3 = await runTool("ledger_list", {}, { conversationId: C, messages: [] });
  assert.equal(out3.count, 1);
});
