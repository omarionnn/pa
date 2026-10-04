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
const { judgeReply } = await import("../src/judge.js");

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

// Reading meaning is the model's job, so here the tests simply say what a reply meant and check
// what the guard does with it. Whether the judge reads real sentences correctly is a separate
// question, asked against the live model in flow-gate.test.js.
function fakeJudge(result) {
  const judge = async (arg) => { judge.calls.push(arg); return result; };
  judge.calls = [];
  return judge;
}
const readsYes = () => fakeJudge({ verdict: "yes" });

test("ownerTexts sees only the owner's own words", () => {
  const msgs = [owner("dinner friday"), toolResult(), event("timer #1 fired"), owner("yeah do it")];
  assert.deepEqual(trust.ownerTexts(msgs), ["dinner friday", "yeah do it"]);
});

test("a bare refusal is the whole message, never a word inside one", () => {
  for (const t of ["no", "No", " nope ", "nah", "naw", "cancel", "stop", "don't", "dont", "No."]) {
    assert.equal(trust.isBareRefusal(t), true, `${JSON.stringify(t)} is a flat no`);
  }
  // The sentences the old word list got wrong. None of these are refusals.
  for (const t of ["no problem, book it", "don't wait, do it now", "no worries go ahead",
    "stop asking and book it", "cancel the 8 and get the 9", "", "yes"]) {
    assert.equal(trust.isBareRefusal(t), false, `${JSON.stringify(t)} is not a flat no`);
  }
});

test("a flat no is refused without asking the judge at all", async () => {
  const judge = readsYes(); // it would say yes; it must never be reached
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect payments" }, { conversationId: C, messages: msgs });
  msgs.push(owner("no"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge });
  assert.equal(rec.state, "refused");
  assert.equal(judge.calls.length, 0, "code settled it, so nothing was sent to the judge");
  assert.ok(db.getConfirmation(C, req.confirmation_id).refused_at);
});

test("the judge sees only the recorded summary and their reply, verbatim", async () => {
  const judge = readsYes();
  const msgs = [owner("book carbone"), owner("and invite kofi")];
  const req = await runTool("confirm_request", { action: "browser_submit", summary: "Book Carbone, party of 4, 8:00 PM" }, { conversationId: C, messages: msgs });
  msgs.push(owner("no problem, book it"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge });
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(judge.calls[0], { summary: "Book Carbone, party of 4, 8:00 PM", reply: "no problem, book it" },
    "no conversation history, no plan, nothing but the action and the answer");
});

// The real judge, against a call that cannot succeed: it must come back unclear, not throw and not
// guess. Pointed at a closed port, so it needs no API key, spends nothing, and never reaches the
// network even when a working key is present.
test("the real judge returns unclear when the call itself fails", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  try {
    const out = await judgeReply({ summary: "Book Carbone at 8:00 PM", reply: "yeah do it" });
    assert.equal(out.verdict, "unclear", "an unreachable judge authorizes nothing");
    assert.ok(out.error, "and it says why");
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
  }
});

test("a judge that fails authorizes nothing", async () => {
  for (const broken of [
    { verdict: "unclear", error: "Connection timed out" },
    { verdict: "probably", note: "off-schema" },
    {},
  ]) {
    db.db.exec("DELETE FROM confirmations;");
    const judge = fakeJudge(broken);
    const msgs = [owner("connect payments")];
    const req = await runTool("confirm_request", { action: "account_connect", summary: "connect payments" }, { conversationId: C, messages: msgs });
    msgs.push(owner("yeah go for it"));
    const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge });
    assert.equal(rec.ok, false, `${JSON.stringify(broken)} must not grant`);
    assert.equal(rec.state, "waiting_for_yes");
    assert.equal(db.getConfirmation(C, req.confirmation_id).granted_at, null, "nothing granted");
    assert.equal(db.getConfirmation(C, req.confirmation_id).refused_at, null, "and nothing refused either");
    // The guarded tool is still shut.
    const gate = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
    assert.equal(gate.blocked, "not_granted");
  }
});

test("a yes that changes a detail authorizes nothing and is not a refusal", async () => {
  const judge = fakeJudge({ verdict: "change", note: "9pm instead of 8" });
  const msgs = [owner("book carbone at 8")];
  const req = await runTool("confirm_request", { action: "browser_submit", summary: "Book Carbone, party of 4, 8:00 PM, under Omari" }, { conversationId: C, messages: msgs });
  msgs.push(owner("ok but make it 9 instead"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge });

  assert.equal(rec.ok, false);
  assert.equal(rec.state, "changed");
  assert.equal(rec.wants, "9pm instead of 8", "what they want different is passed back");
  assert.equal(rec.quote, "ok but make it 9 instead");
  const row = db.getConfirmation(C, req.confirmation_id);
  assert.equal(row.granted_at, null, "the 8:00 they rejected is not authorized");
  assert.equal(row.refused_at, null, "and they did not say no, so it is not dead either");

  // A fresh ask with the corrected details is what unlocks it.
  const again = await runTool("confirm_request", { action: "browser_submit", summary: "Book Carbone, party of 4, 9:00 PM, under Omari" }, { conversationId: C, messages: msgs });
  assert.notEqual(again.confirmation_id, req.confirmation_id, "a new yes for the new details");
  msgs.push(owner("yeah that's it"));
  const granted = await runTool("confirm_record", { confirmation_id: again.confirmation_id }, { conversationId: C, messages: msgs, judge: readsYes() });
  assert.equal(granted.state, "granted");
  // And the stale one still authorizes nothing.
  assert.equal(db.getConfirmation(C, req.confirmation_id).granted_at, null);
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
  // No new owner message has arrived, so the guard will not grant — and will not even ask.
  const judge = readsYes();
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge });
  assert.equal(rec.ok, false);
  assert.equal(rec.state, "waiting_for_yes");
  assert.equal(judge.calls.length, 0, "there is no reply to read, so nothing was read");
  const gate = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(gate.blocked, "not_granted");
});

test("an unclear reply authorizes nothing", async () => {
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect payments" }, { conversationId: C, messages: msgs });
  msgs.push(owner("what would that let you do"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge: fakeJudge({ verdict: "unclear" }) });
  assert.equal(rec.ok, false);
  assert.equal(rec.state, "waiting_for_yes");
  assert.equal(db.getConfirmation(C, req.confirmation_id).granted_at, null);
});

test("a no refuses the confirmation for good", async () => {
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect payments" }, { conversationId: C, messages: msgs });
  msgs.push(owner("nah forget it"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge: fakeJudge({ verdict: "no" }) });
  assert.equal(rec.state, "refused");
  assert.ok(db.getConfirmation(C, req.confirmation_id).refused_at);
  // And it stays refused even if a later message is a yes.
  msgs.push(owner("ok fine yes"));
  const judge = readsYes();
  const again = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge });
  assert.equal(again.state, "refused");
  assert.equal(judge.calls.length, 0, "a dead confirmation is not reopened by asking again");
});

test("a real yes is granted, quoted, spent once, and never reusable", async () => {
  process.env.REASON_PAYMENTS_KEY = "test-key";
  const msgs = [owner("connect payments")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect the payments account with pay_link and refund" }, { conversationId: C, messages: msgs });
  msgs.push(owner("yeah go for it"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge: readsYes() });
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
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge: readsYes() });
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
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge: readsYes() });
  const out = await runTool("account_connect", { name: "payments", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(out.blocked, "wrong_action");
});

test("a provider with no credentials is not_connected and says what is missing", async () => {
  const msgs = [owner("read my email")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect gmail" }, { conversationId: C, messages: msgs });
  msgs.push(owner("yes please"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge: readsYes() });
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

// A model reaching these tools over MCP (the owner's claude-cli backend) sees them under an
// mcp__reason__ prefix and will sometimes write that name into confirm_request. Caught live on
// 2026-10-04: the gate compared the two strings, decided the yes was for a different action,
// and refused a booking the owner had approved. One name, normalised where both sides read it.
test("a yes recorded under its MCP tool name still opens the gate", async () => {
  const C = "dm:mcp-name";
  const messages = [owner("book me a table")];
  const req = await runTool("confirm_request",
    { action: "mcp__reason__browser_submit", summary: "Book Carbone, 8pm, party of 4", stakes: "third_party" },
    { conversationId: C, messages });

  assert.equal(db.getConfirmation(C, req.confirmation_id).action, "browser_submit",
    "it is recorded under the tool's own name, not the dressing");

  messages.push(owner("yeah book it"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id },
    { conversationId: C, messages, judge: fakeJudge({ verdict: "yes" }) });
  assert.equal(rec.state, "granted");

  const gate = trust.authorizeConfirmation({ conversationId: C, action: "browser_submit", confirmationId: req.confirmation_id });
  assert.equal(gate.ok, true, "and the real tool can spend it");
});

test("the prefix does not let one action's yes cover another", () => {
  const C = "dm:mcp-name-2";
  const c = db.askConfirmation({ conversationId: C, action: "browser_submit", summary: "s", stakes: "", askedAfterMsgs: 0 });
  db.grantConfirmation(c.id, "yes");
  const gate = trust.authorizeConfirmation({ conversationId: C, action: "mcp__reason__account_connect", confirmationId: c.id });
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked, "wrong_action");
});

// ---------- apps Omari has chosen, that nothing is built for ----------
//
// These are in the registry so `capabilities` and `account_list` can answer honestly about them
// today: he has picked them, and none of them work. The failure to avoid is a registry that says
// "connectable" about an integration nobody has written, because the next turn acts on that.

test("a chosen app with nothing built for it is not_connected, and says so", () => {
  for (const name of ["spotify", "google_drive", "opentable", "uber", "lyft", "doordash", "uber_eats", "amazon", "airlines", "ticketmaster", "fandango"]) {
    const st = trust.accountStatus(name);
    assert.equal(st.status, "not_connected", `${name} must not claim to be usable`);
    assert.match(st.why, /nothing is built/i, `${name} should say why`);
    assert.ok(st.owner_must_supply, `${name} should say what Omari has to supply`);
    assert.ok(st.what, `${name} should say what it would do`);
  }
});

test("nothing unbuilt invents a credential name it has not got", () => {
  // Making up SPOTIFY_CLIENT_ID here would be inventing an integration's shape before anyone has
  // read its docs — and the capabilities tool would repeat the invention as fact.
  assert.deepEqual(trust.PROVIDERS.spotify.needs, []);
  for (const name of ["opentable", "uber", "lyft", "doordash", "uber_eats", "amazon", "airlines", "ticketmaster", "fandango"]) {
    assert.deepEqual(trust.PROVIDERS[name].needs, [], `${name} needs no env var; it needs a signed-in browser`);
    assert.equal(trust.PROVIDERS[name].via, "browser");
    assert.match(trust.PROVIDERS[name].supply, /saved logins/i, "and saved logins are not built either");
  }
});

test("an unbuilt app cannot be connected, even with a granted yes", async () => {
  const msgs = [owner("connect opentable")];
  const req = await runTool("confirm_request", { action: "account_connect", summary: "connect the opentable account" }, { conversationId: C, messages: msgs });
  msgs.push(owner("yeah do it"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs, judge: readsYes() });
  assert.equal(rec.state, "granted");

  const out = await runTool("account_connect", { name: "opentable", confirmation_id: req.confirmation_id }, { conversationId: C, messages: msgs });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_built");
  assert.match(out.error, /nothing is built for it yet/i);
  assert.match(out.error, /would be pretending/i);
  assert.equal(db.liveAccount("opentable"), null, "no access was recorded");
});

test("account_list reports every chosen app, so 'what can you reach' is complete", () => {
  const names = trust.listAccounts().accounts.map(a => a.name);
  for (const expected of ["spotify", "google_drive", "opentable", "uber", "lyft", "doordash", "uber_eats", "amazon", "airlines", "ticketmaster", "fandango"]) {
    assert.ok(names.includes(expected), `${expected} should be in account_list`);
  }
  // And none of them is pretending.
  const chosen = trust.listAccounts().accounts.filter(a => a.why);
  assert.ok(chosen.length >= 11);
  assert.equal(chosen.every(a => a.status === "not_connected"), true);
});
