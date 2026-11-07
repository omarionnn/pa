// Saving a standing permission is itself a yes-gated act (src/tools.js permission_grant). Reason reads
// back what it is about to save, in the person's terms, and nothing is saved until their yes. The yes
// is pinned to what would be saved — the action, who or what for, the amount, the dates, the limits —
// so a yes to one permission can never save a different one. No model, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-readback-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CONFIRM_WINDOW_MIN = "10";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_UNDO_SECONDS = "0";
after(() => rmSync(dir, { recursive: true, force: true }));

const { runTool, tools } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const C = "dm:readback";
const KOFI = "+14155559876";
const OTHER = "+13475550000";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

const owner = (t) => ({ role: "user", content: `[Sat, Nov 7, 2026, 3:00 PM] Omari: ${t}` });
const readsYes = async () => ({ verdict: "yes" });
let messages;
const call = (name, input, extra = {}) => runTool(name, input, { conversationId: C, messages, judge: readsYes, ...extra });
const saved = () => db.listPermissions(C);
const asks = () => db.db.prepare("SELECT COUNT(*) AS n FROM confirmations WHERE conversation_id = ?").get(C).n;

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM permissions; DELETE FROM confirmations; DELETE FROM spend_caps; DELETE FROM important_people;");
  db.addImportantPerson(C, { who: "Kofi", contact: KOFI });
  messages = [owner("you can text kofi without asking me")];
});

/** Ask for this permission, they answer `reply`, and the answer is recorded. Returns the id and what was asked. */
async function askAndAnswer(input, reply = "yes", judge = readsYes) {
  const first = await call("permission_grant", input);
  assert.equal(first.blocked, "needs_confirmation", JSON.stringify(first));
  const req = await call("confirm_request", { action: "permission_grant", summary: "save that: I can text Kofi without asking?", target: first.use_target });
  assert.ok(req.confirmation_id, JSON.stringify(req));
  messages.push(owner(reply));
  const rec = await call("confirm_record", { confirmation_id: req.confirmation_id }, { judge });
  return { id: req.confirmation_id, first, rec };
}

const KOFI_GRANT = { text: "you can text kofi without asking me", scope: { action: "texts", target: KOFI } };

test("their own sentence with no yes saves nothing: it asks first, with what would be saved", async () => {
  const out = await call("permission_grant", KOFI_GRANT);
  assert.equal(out.ok, false, `saved with no yes: ${JSON.stringify(out)}`);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(saved().length, 0, "nothing was saved");
  // What the yes is pinned to names the action, the number AND who it is on record as.
  assert.match(out.use_target, /texts/);
  assert.match(out.use_target, /\+14155559876/);
  assert.match(out.use_target, /kofi/i);
  // The model is told to read it back by name, not by number.
  assert.match(out.error, /Kofi/);
  assert.match(out.error, /never the number/i);
});

test("after their yes it saves exactly what was read back, and that yes is then spent", async () => {
  const { id, rec } = await askAndAnswer(KOFI_GRANT);
  assert.equal(rec.state, "granted");
  const out = await call("permission_grant", { ...KOFI_GRANT, confirmation_id: id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(saved().length, 1);
  assert.equal(saved()[0].target, KOFI);
  const again = await call("permission_grant", { ...KOFI_GRANT, confirmation_id: id });
  assert.equal(again.ok, false, "one yes saved two permissions");
  assert.equal(again.blocked, "already_spent");
  assert.equal(saved().length, 1);
});

test("a no saves nothing", async () => {
  const { id, rec } = await askAndAnswer(KOFI_GRANT, "no actually don't");
  assert.equal(rec.state, "refused");
  const out = await call("permission_grant", { ...KOFI_GRANT, confirmation_id: id });
  assert.equal(out.ok, false);
  assert.equal(saved().length, 0);
});

test("a yes to one permission never saves a different one", async () => {
  messages = [owner("you can text kofi without asking me"), owner("you can text anyone without asking me")];
  const { id } = await askAndAnswer(KOFI_GRANT);
  // Another person on the same yes.
  const other = await call("permission_grant", { text: "you can text kofi without asking me", scope: { action: "texts", target: OTHER }, confirmation_id: id });
  assert.equal(other.blocked, "wrong_target", JSON.stringify(other));
  // Everybody on the same yes.
  const anyone = await call("permission_grant", { text: "you can text anyone without asking me", scope: { action: "texts" }, confirmation_id: id });
  assert.equal(anyone.blocked, "wrong_target", JSON.stringify(anyone));
  // A different kind of thing on the same yes.
  const calls = await call("permission_grant", { text: "you can text kofi without asking me", scope: { action: "calls", target: KOFI }, confirmation_id: id });
  assert.equal(calls.blocked, "wrong_target", JSON.stringify(calls));
  assert.equal(saved().length, 0, "nothing but the one they said yes to may be saved");
});

test("a yes is pinned to the amount and the limits as well", async () => {
  const said = "you can order groceries without asking up to $40, and never more than $300 a month";
  messages = [owner(said)];
  const grant = { text: said, scope: { action: "purchases", target: "groceries", max_amount: 40 }, caps: { per_purchase: 40, monthly: 300 } };
  const { id } = await askAndAnswer(grant);
  const more = await call("permission_grant", { ...grant, scope: { ...grant.scope, max_amount: 300 }, confirmation_id: id });
  assert.equal(more.blocked, "wrong_target", JSON.stringify(more));
  const looser = await call("permission_grant", { ...grant, caps: { per_purchase: 300, monthly: 300 }, confirmation_id: id });
  assert.equal(looser.blocked, "wrong_target", JSON.stringify(looser));
  const noCaps = await call("permission_grant", { text: said, scope: grant.scope, confirmation_id: id });
  assert.equal(noCaps.blocked, "wrong_target", JSON.stringify(noCaps));
  assert.equal(saved().length, 0);
  assert.equal(db.getSpendCaps(C), null);
  const right = await call("permission_grant", { ...grant, confirmation_id: id });
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(saved()[0].max_cents, 4000);
  assert.equal(db.getSpendCaps(C).monthly_cents, 30000);
});

test("what can never be saved is refused before anything is asked", async () => {
  messages = [owner("you can approve builds without asking")];
  const never = await call("permission_grant", { text: "you can approve builds without asking", scope: { action: "remote_approve" } });
  assert.equal(never.blocked, "never_standing");
  const unknown = await call("permission_grant", { text: "you can approve builds without asking", scope: { action: "everything" } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.blocked, undefined);
  messages = [owner("just order the groceries yourself")];
  const noAmount = await call("permission_grant", { text: "just order the groceries yourself", scope: { action: "purchases", target: "groceries" } });
  assert.equal(noAmount.blocked, "needs_an_amount");
  assert.equal(asks(), 0, "a question was put to them about something that could never be saved");
});

test("a yes does not stand in for their own sentence, or for what it meant", async () => {
  const { id } = await askAndAnswer(KOFI_GRANT);
  // Their sentence is no longer in what they said (a different thread, a forged one): refused.
  messages = [owner("yes")];
  const forged = await call("permission_grant", { ...KOFI_GRANT, confirmation_id: id });
  assert.equal(forged.blocked, "not_their_words", JSON.stringify(forged));
  // The judge reads their sentence as not granting it: refused, whatever the yes.
  messages = [owner("you can text kofi without asking me"), owner("yes")];
  const meant = await call("permission_grant", { ...KOFI_GRANT, confirmation_id: id }, { judge: async () => ({ verdict: "no" }) });
  assert.equal(meant.blocked, "not_what_they_said", JSON.stringify(meant));
  assert.equal(saved().length, 0);
});

test("confirm_request accepts permission_grant as something the gate stops, and needs its target", async () => {
  const bare = await call("confirm_request", { action: "permission_grant", summary: "save that: I can text Kofi without asking?" });
  assert.equal(bare.ok, false, JSON.stringify(bare));
  assert.equal(bare.blocked, "ask_says_nothing");
  const desc = tools.find(t => t.name === "permission_grant").description;
  assert.match(desc, /confirm_request/);
  assert.match(desc, /name/i);
});
