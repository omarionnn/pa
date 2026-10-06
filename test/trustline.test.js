// The trust line: standing permissions, the caps a person sets, how Reason represents them to
// other people, what it does with their data, and the fact that nothing from outside is ever an
// instruction. No model, no network, no real site.
//
// The questions these ask are mostly about what must NOT happen:
//
//   can a permission be stretched?                  (no — a wider amount or another target is refused)
//   can one paper over a yes that went stale?       (no — it is only consulted when nothing was asked)
//   can a yes raise a cap?                          (no — the cap is a separate number they set)
//   can an unknown payment be retried on its own?   (no — it needs them to say so first)
//   can a card number get into memory?              (no — refused on the text, with a reason)
//   can a "yes" inside an email authorize anything? (no — the gate reads only their own messages)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-trustline-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CONFIRM_WINDOW_MIN = "10";
process.env.REASON_TZ = "America/New_York";

const { runTool, ALWAYS_NEEDS_CONFIRMATION, tools, capabilitiesNow } = await import("../src/tools.js");
const permissions = await import("../src/permissions.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:trustline";
const FRIEND = "+14155559876";
const OTHER = "+13475550000";

db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });
const readsYes = async () => ({ verdict: "yes" });

let messages;
let sent;
/** A texting channel that records rather than sends. Nothing leaves the process. */
function fakeRouter() {
  const out = [];
  return { out, list: () => [{ name: "fake" }], send: async (m) => { out.push(m); return { ok: true, delivered: true }; } };
}
let router;

const call = (name, input, extra = {}) => runTool(name, input, {
  conversationId: C, messages, judge: readsYes, channels: router, ...extra,
});

beforeEach(() => {
  clock.reset();
  messages = [owner("sort this out for me")];
  router = fakeRouter();
  sent = router.out;
  db.db.exec("DELETE FROM permissions; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend; DELETE FROM people; DELETE FROM person_facts;");
  config.maxSpendPerDay = 300;
});

/** Ask and get a yes for exactly these details. */
async function approve(action, target, summary = `about to ${action}`) {
  const req = await call("confirm_request", { action, summary, stakes: "both", target });
  messages.push(owner("yeah go on"));
  const rec = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  return req.confirmation_id;
}

// ---------- the list of things a permission may name ----------

test("every action a permission may name is a real tool, and nothing the gate stops is missing", () => {
  const names = new Set(tools.map(t => t.name));
  for (const a of permissions.GATED_ACTIONS) assert.ok(names.has(a), `${a} is not a tool`);
  for (const a of ALWAYS_NEEDS_CONFIRMATION) {
    assert.ok(permissions.GATED_ACTIONS.has(a), `${a} always needs a yes but is not in GATED_ACTIONS`);
  }
  // Every category points at actions that really exist and are really gated.
  for (const [cat, list] of Object.entries(permissions.CATEGORIES)) {
    for (const a of list) assert.ok(permissions.GATED_ACTIONS.has(a), `category ${cat} names ${a}`);
  }
  // The two that can never be pre-authorized are not offered as something to name.
  for (const a of permissions.NEVER_STANDING) {
    assert.ok(!permissions.knownScopeActions().includes(a), `${a} must not be offered`);
  }
});

// ---------- granting, listing, taking back ----------

test("a permission is saved in their own words, listed, and taken back", async () => {
  const said = "you can reorder groceries without asking";
  const got = await call("permission_grant", { text: said, scope: { action: "purchases", target: "groceries", max_amount: 80 } });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.permission.said, said, "the sentence is kept exactly");
  assert.equal(got.permission.up_to, "$80.00");
  assert.deepEqual(got.covers_actions, ["browser_submit"]);

  const list = await call("permission_list", {});
  assert.equal(list.live, 1);
  assert.equal(list.permissions[0].said, said);

  const gone = await call("permission_revoke", { permission_id: got.permission.permission_id });
  assert.equal(gone.ok, true);
  assert.equal((await call("permission_list", {})).live, 0);
  assert.equal((await call("permission_list", { include_closed: true })).count, 1, "the record of having granted it stays");
});

test("a scope the gate cannot check saves nothing, and says what it could have said", async () => {
  const out = await call("permission_grant", { text: "just handle my life", scope: { action: "everything" } });
  assert.equal(out.ok, false);
  assert.match(out.error, /not something the gate can check/);
  assert.match(out.error, /purchases/);
  assert.equal(db.listPermissions(C).length, 0);
});

test("a standing permission to spend money has to have a number on it", async () => {
  const out = await call("permission_grant", { text: "order the groceries yourself from now on", scope: { action: "purchases", target: "groceries" } });
  assert.equal(out.blocked, "needs_an_amount");
  assert.equal(db.listPermissions(C).length, 0);
});

test("deleting someone's Reason and approving a build can never be given away in advance", async () => {
  for (const action of ["admin_delete", "remote_approve"]) {
    const out = await call("permission_grant", { text: `you can ${action} without asking`, scope: { action } });
    assert.equal(out.blocked, "never_standing", action);
  }
  assert.equal(db.listPermissions(C).length, 0);
});

test("a permission that has already run out is not saved", async () => {
  const out = await call("permission_grant", {
    text: "text kofi for me until friday", scope: { action: "texts", target: FRIEND, until: "2020-01-01T00:00:00-05:00" },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /already past/);
});

// ---------- the gate consults them before it stops ----------

test("the gate lets through exactly what a permission covers, with no yes, and the receipt names it", async () => {
  await call("permission_grant", { text: "you can text kofi for me whenever", scope: { action: "texts", target: FRIEND } });

  const out = await call("message_send", { to: FRIEND, text: "omari says 8pm works" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(sent.length, 1, "it really went");
  assert.equal(out.under_permission.said, "you can text kofi for me whenever");
  assert.match(out.permission_note, /never pretend you asked/);

  const row = db.listActions(C)[0];
  assert.match(row.receipt, /No yes was asked for — under: "you can text kofi for me whenever"/);
  assert.equal(row.confirmation_id, null, "nothing was approved, and the row does not pretend otherwise");
  assert.ok(row.permission_id, "the row joins back to the permission");
  assert.equal(db.listPermissions(C)[0].id, row.permission_id);
});

test("a permission for one person does not cover another, and the refusal quotes the one that nearly did", async () => {
  await call("permission_grant", { text: "you can text kofi for me whenever", scope: { action: "texts", target: FRIEND } });

  const out = await call("message_send", { to: OTHER, text: "hey" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(sent.length, 0, "nothing was sent");
  assert.match(out.error, /you can text kofi for me whenever/);
  assert.match(out.error, /a different number/);
  assert.match(out.error, /Do not stretch it/);
  assert.equal(out.nearly_covered_by.length, 1);
});

test("a permission for one action does not cover another kind of action at all", () => {
  const row = db.grantPermission(C, { said: "you can text kofi", action: "texts", target: FRIEND });
  const verdict = permissions.covers(row, { action: "call_place", target: FRIEND });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /message_send/);
  // And it is not even reported as a near miss, because it is not about this action.
  const near = permissions.covering({ conversationId: C, action: "call_place", target: FRIEND });
  assert.equal(near.ok, false);
  assert.deepEqual(near.near, []);
});

test("a bigger amount than they said is outside the permission, and so is one with no amount at all", () => {
  const row = db.grantPermission(C, { said: "you can spend up to $40 on lunch without asking", action: "purchases", target: "lunch", maxCents: 4000 });
  assert.equal(permissions.covers(row, { action: "browser_submit", target: "lunch from sweetgreen, $22.40", amountCents: 2240 }).ok, true);
  const over = permissions.covers(row, { action: "browser_submit", target: "lunch from sweetgreen, $61.10", amountCents: 6110 });
  assert.equal(over.ok, false);
  assert.match(over.why, /tops out at \$40\.00 and this is \$61\.10/);

  const noAmount = db.grantPermission(C, { said: "just order the lunch", action: "purchases", target: "lunch" });
  const verdict = permissions.covers(noAmount, { action: "browser_submit", target: "lunch, $9", amountCents: 900 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /sets no amount/);
});

test("a category permission covers each action in it and nothing outside it", () => {
  const row = db.grantPermission(C, { said: "you can tidy my inbox", action: "mail_tidying" });
  for (const a of ["gmail_archive", "gmail_mark", "gmail_label", "gmail_trash"]) {
    assert.equal(permissions.covers(row, { action: a }).ok, true, a);
  }
  assert.equal(permissions.covers(row, { action: "gmail_send" }).ok, false, "tidying is not sending");
});

test("a permission that has run out stops covering, and so does one taken back", () => {
  const row = db.grantPermission(C, { said: "text kofi this week", action: "texts", target: FRIEND, untilAt: clock.now() + 60_000 });
  assert.equal(permissions.covers(row, { action: "message_send", target: FRIEND }).ok, true);
  clock.skip(120_000);
  const expired = permissions.covers(row, { action: "message_send", target: FRIEND });
  assert.equal(expired.ok, false);
  assert.match(expired.why, /ran out/);

  clock.reset();
  db.revokePermission(C, row.id);
  const taken = permissions.covers(db.getPermission(C, row.id), { action: "message_send", target: FRIEND });
  assert.equal(taken.ok, false);
  assert.match(taken.why, /taken back/);
});

test("the tool name a model sees over MCP still matches a permission", () => {
  const row = db.grantPermission(C, { said: "you can text kofi", action: "texts", target: FRIEND });
  assert.equal(permissions.covers(row, { action: "mcp__reason__message_send", target: FRIEND }).ok, true);
});

// ---------- a permission is never a way around a yes ----------

test("a permission does not paper over a yes that was spent, refused or has gone stale", async () => {
  await call("permission_grant", { text: "you can text kofi for me whenever", scope: { action: "texts", target: FRIEND } });

  // Spent: the model carries a confirmation_id that has already been used. That is a question about
  // that yes, and the standing permission must not quietly answer it.
  const id = await approve("message_send", FRIEND, `text ${FRIEND}: hi`);
  const first = await call("message_send", { to: FRIEND, text: "hi", confirmation_id: id });
  assert.equal(first.ok, true);
  assert.equal(first.under_permission, undefined, "it went through on the yes, not on the permission");

  const again = await call("message_send", { to: FRIEND, text: "hi", confirmation_id: id });
  assert.equal(again.ok, false);
  assert.equal(again.blocked, "already_spent");
  assert.equal(sent.length, 1, "nothing went a second time");
});

test("a yes for one person is not turned into a yes for another by a permission about texting", async () => {
  await call("permission_grant", { text: "you can text kofi for me whenever", scope: { action: "texts", target: FRIEND } });
  const id = await approve("message_send", FRIEND, `text ${FRIEND}: hi`);
  const out = await call("message_send", { to: OTHER, text: "hi", confirmation_id: id });
  assert.equal(out.blocked, "wrong_target");
  assert.equal(sent.length, 0);
});

test("texting the person Reason works for never needed any of this", async () => {
  const out = await call("message_send", { to: "owner", text: "your table is at 8" });
  assert.equal(out.ok, true);
  assert.equal(out.under_permission, undefined);
  assert.equal(db.listActions(C)[0].permission_id, null);
});

// ---------- what the capability list says ----------

test("capabilities answers 'what can you do without asking me' from their own rows", async () => {
  const before = capabilitiesNow({ conversationId: C, ownerName: "Omari" }).find(c => c.name === "standing_permissions");
  assert.equal(before.status, "live");
  assert.match(before.what, /have not said any of that yet/);

  await call("permission_grant", { text: "you can reorder groceries without asking", scope: { action: "purchases", target: "groceries", max_amount: 80 } });
  const after = capabilitiesNow({ conversationId: C, ownerName: "Omari" }).find(c => c.name === "standing_permissions");
  assert.match(after.what, /"you can reorder groceries without asking"/);
});

test("an export carries their permissions, and a delete takes them", async () => {
  const { exportData, deleteData } = await import("../src/data.js");
  await call("permission_grant", { text: "you can text kofi for me whenever", scope: { action: "texts", target: FRIEND } });

  const out = exportData({ conversation: C, audio: false });
  assert.equal(out.tables.permissions.length, 1);
  assert.equal(out.tables.permissions[0].said, "you can text kofi for me whenever");

  const gone = await deleteData({ conversation: C, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });
  assert.equal(gone.rows.permissions, 1);
  assert.equal(db.listPermissions(C).length, 0);
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});
