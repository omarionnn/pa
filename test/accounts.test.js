// Every person who texts Reason gets their own Reason.
//
// The three things that have to be true, and are tested here because getting any of them wrong is
// the kind of mistake you only find out about from somebody else:
//
//   1. **Isolation.** Nothing one person stored, connected or approved is readable, usable or
//      actionable from another person's conversation, and a yes from one is not a yes in another.
//   2. **Who may have one.** Invite-only by default. An unapproved number gets one line and *no
//      model turn* — the cost of being texted by a stranger has to be zero.
//   3. **What it costs.** A cap per person per day, counted in the database, because the operator
//      pays for every turn and should not learn the limit from a bill.
//
// Plus: the operator is the first account with admin rights and nothing more — there is no tool
// that shows them anybody else's content.
//
// No API key, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-accounts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MAX_TURNS_PER_DAY = "3";
process.env.REASON_MAX_PROACTIVE_PER_DAY = "1";

const accounts = await import("../src/accounts.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { exportData, deleteData } = await import("../src/data.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OPERATOR = "+12025551234";
const KOFI = "+14155559876";
const AMA = "+13475550000";
const NOBODY = "+19995551111";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM invites; DELETE FROM usage; DELETE FROM turned_away; DELETE FROM plans; DELETE FROM people; DELETE FROM person_facts; DELETE FROM connected_accounts; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM conversations; DELETE FROM nudges; DELETE FROM timers; DELETE FROM pages;");
  config.openToAnyone = false;
});

function harness({ reply = "ok" } = {}) {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return reply; } });
  const router = new Router({ runtime });
  const channel = router.register(new FakeChannel({}));
  return { runtime, router, channel, turns };
}

const text = (from, id = String(Math.random())) => ({ channel: "fake", externalId: id, from, text: "hi", at: clock.now() });

// ---------- who may have one ----------

test("invite-only by default: an unapproved number costs nothing", async () => {
  const { router, turns, channel } = harness();
  const out = await router.deliver(text(NOBODY, "n1"));

  assert.equal(out.admitted, false);
  assert.equal(turns.length, 0, "NO MODEL TURN — this is the whole point");
  assert.equal(channel.sent.length, 1);
  assert.match(channel.sent[0].text, /invite only/i);
  assert.equal(db.getAccount(`dm:fake:${NOBODY}`), null, "and no account was created for them");
});

test("the operator never needs an invite", async () => {
  const { router, turns } = harness();
  const out = await router.deliver(text(OPERATOR, "o1"));
  assert.equal(out.isOperator, true);
  assert.equal(out.conversationId, config.ownerConversation, "their existing data is already under this id");
  assert.equal(turns.length, 1);
});

test("an invite is what admits somebody, and removing it shuts them out again", async () => {
  const { router, turns, channel } = harness();
  assert.equal((await router.deliver(text(KOFI, "k1"))).admitted, false);

  db.addInvite(KOFI, { note: "Kofi" });
  const inside = await router.deliver(text(KOFI, "k2"));
  assert.equal(inside.conversationId, `dm:fake:${KOFI}`);
  assert.equal(inside.isOperator, false);
  assert.equal(turns.length, 1);

  db.removeInvite(KOFI);
  clock.skip(25 * 60 * 60 * 1000); // past the "told once a day" window
  const out = await router.deliver(text(KOFI, "k3"));
  assert.equal(out.admitted, false);
  assert.equal(turns.length, 1, "no further turns once the invite is gone");
  assert.match(channel.sent.at(-1).text, /invite only/i);
});

test("an invite in config works without the database, for a plain self-hosted setup", () => {
  const kept = config.invitedNumbers;
  config.invitedNumbers = [KOFI];
  try {
    assert.equal(accounts.isInvited(KOFI), true);
    assert.equal(accounts.isInvited(AMA), false);
    // Formatting is not identity.
    assert.equal(accounts.isInvited("+1 (415) 555-9876"), true);
  } finally { config.invitedNumbers = kept; }
});

test("open-to-anyone is a deliberate switch, off by default", async () => {
  assert.equal(config.openToAnyone, false, "off unless somebody turns it on");
  const { router, turns } = harness();
  assert.equal((await router.deliver(text(NOBODY, "x1"))).admitted, false);

  config.openToAnyone = true;
  const out = await router.deliver(text(NOBODY, "x2"));
  assert.equal(out.conversationId, `dm:fake:${NOBODY}`);
  assert.equal(turns.length, 1);
});

test("a number nobody approved is told once a day, not once a message", async () => {
  const { router, channel } = harness();
  for (const id of ["a", "b", "c", "d"]) await router.deliver(text(NOBODY, id));
  assert.equal(channel.sent.length, 1);

  clock.skip(23 * 60 * 60 * 1000);
  await router.deliver(text(NOBODY, "e"));
  assert.equal(channel.sent.length, 1, "still the same day");

  clock.skip(2 * 60 * 60 * 1000);
  await router.deliver(text(NOBODY, "f"));
  assert.equal(channel.sent.length, 2, "a day later it may say so again, in case they were added");
});

// ---------- isolation ----------

test("two people's plans, memory and receipts never meet", async () => {
  db.addInvite(KOFI); db.addInvite(AMA);
  const { router } = harness();
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;
  const a = (await router.deliver(text(AMA, "a"))).conversationId;
  assert.notEqual(k, a);

  await runTool("plan_create", { title: "Kofi's dinner" }, { conversationId: k });
  await runTool("plan_create", { title: "Ama's trip" }, { conversationId: a });
  await runTool("remember", { about: "Mum", fact: "allergic to shellfish" }, { conversationId: k });
  await runTool("page_create", { title: "Kofi's list", blocks: [{ type: "text", text: "private" }] }, { conversationId: k });

  assert.deepEqual(db.listPlans(k).map(p => p.title), ["Kofi's dinner"]);
  assert.deepEqual(db.listPlans(a).map(p => p.title), ["Ama's trip"]);

  const amaRecall = await runTool("recall", {}, { conversationId: a });
  assert.equal(JSON.stringify(amaRecall).includes("shellfish"), false);
  const amaPages = await runTool("page_list", {}, { conversationId: a });
  assert.equal(amaPages.count, 0, "one person's pages are not another's");
  const amaLedger = await runTool("ledger_list", {}, { conversationId: a });
  assert.equal(JSON.stringify(amaLedger).includes("Kofi's list"), false, "nor their receipts");
});

test("a connected account belongs to one person, not to the install", async () => {
  // This used to be install-wide, which with a Reason per person would have been a real leak:
  // one person's connected Gmail reachable from everybody's thread.
  db.addInvite(KOFI);
  const { router } = harness();
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;
  const o = (await router.deliver(text(OPERATOR, "o"))).conversationId;

  db.connectAccount(o, "gmail", ["read_mail"]);
  assert.equal(db.liveAccount(o, "gmail")?.name, "gmail");
  assert.equal(db.liveAccount(k, "gmail"), null);

  const theirs = await runTool("account_list", {}, { conversationId: k });
  assert.equal(theirs.accounts.find(x => x.name === "gmail").status, "not_connected",
    "in their Reason it is simply not connected");
});

test("a yes in one Reason authorizes nothing in another", async () => {
  db.addInvite(KOFI);
  const { router } = harness();
  const o = (await router.deliver(text(OPERATOR, "o"))).conversationId;
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;

  const msgs = [{ role: "user", content: "[Wed, Sep 30, 2026, 3:00 PM] Omari: text kofi" }];
  const req = await runTool("confirm_request",
    { action: "message_send", summary: `text ${KOFI} 'hi'`, target: KOFI },
    { conversationId: o, messages: msgs });
  msgs.push({ role: "user", content: "[Wed, Sep 30, 2026, 3:01 PM] Omari: yeah go" });
  assert.equal((await runTool("confirm_record", { confirmation_id: req.confirmation_id },
    { conversationId: o, messages: msgs, judge: async () => ({ verdict: "yes" }) })).state, "granted");

  // The same id, from the other person's Reason.
  const stolen = await runTool("message_send", { to: AMA, text: "hi", confirmation_id: req.confirmation_id },
    { conversationId: k, messages: [] });
  assert.equal(stolen.ok, false);
  assert.match(stolen.error, /No confirmation/i);
});

test("'owner' means whoever's Reason it is, so nobody rings the operator by saying owner", async () => {
  db.addInvite(KOFI);
  const { router } = harness();
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;
  const { FakeCallProvider } = await import("../src/calls/fake.js");
  const calls = new FakeCallProvider();

  const out = await runTool("call_place", { to: "owner", goal: "say hi" }, { conversationId: k, calls });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.to, KOFI, "it rang Kofi, whose Reason this is — not the operator");
  assert.match(out.announced, /on behalf of/, "and announced itself for them");
});

test("export and delete are per person", async () => {
  db.addInvite(KOFI);
  const { router } = harness();
  const o = (await router.deliver(text(OPERATOR, "o"))).conversationId;
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;
  await runTool("plan_create", { title: "mine" }, { conversationId: o });
  await runTool("plan_create", { title: "theirs" }, { conversationId: k });

  const mine = exportData({ conversation: o, audio: false });
  assert.deepEqual(mine.tables.plans.map(p => JSON.parse(p.data).title), ["mine"]);
  assert.equal(mine.tables.accounts.length, 1);
  assert.equal(mine.tables.accounts[0].conversation_id, o);

  deleteData({ conversation: k });
  assert.equal(db.listPlans(k).length, 0, "theirs is gone");
  assert.deepEqual(db.listPlans(o).map(p => p.title), ["mine"], "mine is untouched");
  assert.equal(db.getAccount(k), null, "their account went with it");
  assert.ok(db.getAccount(o), "the operator's did not");
});

// ---------- what it costs ----------

test("a person has a daily turn cap, and is told when they hit it", async () => {
  db.addInvite(KOFI);
  const { router, turns, channel } = harness();
  for (const id of ["1", "2", "3"]) await router.deliver(text(KOFI, id));
  assert.equal(turns.length, 3, "three is the cap in this test's config");

  const capped = await router.deliver(text(KOFI, "4"));
  assert.equal(capped.capped, true);
  assert.equal(turns.length, 3, "the fourth costs no model call");
  assert.match(channel.sent.at(-1).text, /limit/i, "and they are told, rather than ignored");

  // A new day, a new allowance.
  clock.skip(26 * 60 * 60 * 1000);
  await router.deliver(text(KOFI, "5"));
  assert.equal(turns.length, 4);
});

test("one person's cap is not another's", async () => {
  db.addInvite(KOFI); db.addInvite(AMA);
  const { router, turns } = harness();
  for (const id of ["1", "2", "3", "4"]) await router.deliver(text(KOFI, id));
  assert.equal(turns.length, 3);
  await router.deliver(text(AMA, "a1"));
  assert.equal(turns.length, 4, "Ama has her own day's worth");
});

test("the cap survives a restart, because it is counted in the database", async () => {
  db.addInvite(KOFI);
  const first = harness();
  for (const id of ["1", "2", "3"]) await first.router.deliver(text(KOFI, id));

  const second = harness(); // a fresh Runtime and Router: a new process
  const capped = await second.router.deliver(text(KOFI, "4"));
  assert.equal(capped.capped, true);
  assert.equal(second.turns.length, 0);
});

test("Reason interrupting people is capped separately from their own messages", async () => {
  db.addInvite(KOFI);
  const { router, runtime } = harness();
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;

  assert.equal(runtime.mayInterrupt(k), true);
  accounts.countUse(k, "proactive");
  assert.equal(runtime.mayInterrupt(k), false, "one a day in this test's config");
  // Their own messages are unaffected by Reason having spoken first.
  assert.equal(accounts.withinCap(k, "turn").ok, true);
});

test("a cap of 0 means uncapped, for a self-hosted install that wants no limit", () => {
  const kept = config.maxTurnsPerDay;
  config.maxTurnsPerDay = 0;
  try {
    for (let i = 0; i < 50; i++) accounts.countUse("dm:owner", "turn");
    assert.equal(accounts.withinCap("dm:owner", "turn").ok, true);
  } finally { config.maxTurnsPerDay = kept; }
});

// ---------- the operator is an account with admin rights, and nothing more ----------

test("only the operator can invite, remove or see usage", async () => {
  db.addInvite(KOFI);
  const { router } = harness();
  const o = (await router.deliver(text(OPERATOR, "o"))).conversationId;
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;

  for (const [name, input] of [["admin_invite", { number: AMA }], ["admin_remove", { number: KOFI }], ["admin_usage", {}]]) {
    const theirs = await runTool(name, input, { conversationId: k });
    assert.equal(theirs.ok, false, `${name} must be operator-only`);
    assert.equal(theirs.blocked, "operator_only");
  }
  const invited = await runTool("admin_invite", { number: AMA, note: "my sister" }, { conversationId: o });
  assert.equal(invited.ok, true);
  assert.equal(invited.invited, AMA);
  assert.equal(accounts.isInvited(AMA), true);
});

test("admin_usage shows counts and no content, ever", async () => {
  db.addInvite(KOFI);
  const { router } = harness();
  const o = (await router.deliver(text(OPERATOR, "o"))).conversationId;
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;
  await runTool("plan_create", { title: "Kofi's very private dinner" }, { conversationId: k });
  await runTool("remember", { about: "Ama", fact: "hates coriander" }, { conversationId: k });

  const usage = await runTool("admin_usage", {}, { conversationId: o });
  const asText = JSON.stringify(usage);
  assert.equal(usage.count, 2);
  assert.ok(usage.people.some(p => p.number === KOFI));
  assert.ok(usage.people.find(p => p.number === KOFI).usage[0].turns >= 1, "their counts are visible");
  // The line that matters: not one word of what they said.
  assert.equal(asText.includes("very private dinner"), false);
  assert.equal(asText.includes("coriander"), false);
  assert.match(usage.note, /no tool that shows you what anybody said/i);
});

test("a removed invite does not delete anybody's data", async () => {
  db.addInvite(KOFI);
  const { router } = harness();
  const o = (await router.deliver(text(OPERATOR, "o"))).conversationId;
  const k = (await router.deliver(text(KOFI, "k"))).conversationId;
  await runTool("plan_create", { title: "theirs" }, { conversationId: k });

  await runTool("admin_remove", { number: KOFI }, { conversationId: o });
  assert.deepEqual(db.listPlans(k).map(p => p.title), ["theirs"], "inviting them back picks up where they left off");
});

// ---------- the single-owner install is unchanged ----------

test("one number in config behaves exactly as it did before any of this", async () => {
  const { router, turns } = harness();
  const out = await router.deliver(text(OPERATOR, "solo"));
  assert.equal(out.conversationId, "dm:owner");
  assert.equal(out.isOperator, true);
  assert.equal(turns[0].conversationId, "dm:owner");
  // And the console is always the operator: there is nobody else on the end of a terminal.
  assert.equal(accounts.conversationIdFor({ channel: "console", address: "console" }), "dm:owner");
  assert.equal(accounts.ownerOf("dm:owner").name, "Omari");
  assert.equal(accounts.ownerOf("dm:owner").isOperator, true);
});

test("the operator's account exists from the first load, with their data already under it", () => {
  // The whole migration: nothing moves, because everything was already keyed by this id.
  db.db.exec("DELETE FROM accounts;");
  assert.equal(db.getAccount("dm:owner"), null);
  // ownerOf still answers correctly from config, so a half-migrated install is not a broken one.
  const me = accounts.ownerOf("dm:owner");
  assert.equal(me.name, "Omari");
  assert.equal(me.isOperator, true);
  assert.equal(me.address, OPERATOR);
});
