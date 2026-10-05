// Getting a Reason of your own: you text the number, and the master says yes.
//
// Two things have to be true at once, and they pull against each other:
//
//   - **anyone may text it.** No invite list to maintain, no number turned away unheard.
//   - **nothing of a stranger's reaches the model, or the master's bill, until the master agrees.**
//     Their first message is written down as a quote, not run as a turn.
//
// And then the part that is really about trust: the master answers in their own words, so what
// they meant is read by the same judge the confirm gate uses everywhere — while every fact a model
// cannot be trusted with is owned by code. A real new message from the master's own number, tied
// to one request, single use, with an expiry. Nobody can approve themselves. Nobody else's "yes
// let them in" counts for anything.
//
// No API key, no network, no model: the judge is stated, which is the point — these tests are
// about the bookkeeping around it, not about whether a model can read "yeah go on".
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-access-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_DECLINE_COOLOFF_DAYS = "7";
process.env.REASON_WAITING_GAP_MIN = "360";
process.env.REASON_ACCESS_WINDOW_MIN = "10080";
process.env.REASON_MAX_REQUESTS_PER_HOUR = "3";

const access = await import("../src/access.js");
const accounts = await import("../src/accounts.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const KOFI = "+14155559876";
const AMA = "+13475550000";
const NUISANCE = "+19995551111";
const DAY = 24 * 60 * 60 * 1000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM blocked_numbers; DELETE FROM turned_away; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM plans; DELETE FROM people; DELETE FROM person_facts; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

/** A router whose turns are recorded instead of sent to a model, and whose judge is stated. */
function harness({ verdict = "yes", reply = "ok" } = {}) {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return reply; } });
  const judge = async () => (typeof verdict === "function" ? verdict() : { verdict });
  const router = new Router({ runtime, judge });
  const channel = router.register(new FakeChannel({}));
  // The judge is what reads the master's words. Stated here so these tests are about everything
  // around it; test/flow-gate.test.js proves a real model reads real sentences.
  return { runtime, router, channel, turns, judge, setVerdict: (v) => { verdict = v; } };
}

const texts = (from, body, id = String(Math.random())) =>
  ({ channel: "fake", externalId: id, from, text: body, at: clock.now() });

/** What went to one number. */
const sentTo = (channel, to) => channel.sent.filter(m => m.to === to);

/** Drive the master's reply through the real path, with a stated judge. */
async function masterSays(h, words) {
  const messages = [
    ...db.loadConversation(config.ownerConversation),
    { role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${words}` },
  ];
  return await access.readMasterReply({
    messages, masterConversationId: config.ownerConversation, judge: h.judge,
  });
}

// ---------- an unknown number ----------

test("an unknown number reaches the master once, quoting them exactly", async () => {
  const h = harness();
  const out = await h.router.deliver(texts(KOFI, "hey is this omari's thing? can you book me a table"));

  assert.equal(out.admitted, false);
  assert.equal(out.asked, true);
  assert.equal(h.turns.length, 0, "NO MODEL TURN — their words do not reach the model unapproved");

  // One line to them.
  const toKofi = sentTo(h.channel, KOFI);
  assert.equal(toKofi.length, 1);
  assert.match(toKofi[0].text, /asked them whether to set you up/i);

  // And the question to the master, with the message quoted exactly.
  const toMaster = sentTo(h.channel, MASTER);
  assert.equal(toMaster.length, 1);
  assert.ok(toMaster[0].text.includes(`"hey is this omari's thing? can you book me a table"`),
    "the master sees their words verbatim, not a summary");
  assert.ok(toMaster[0].text.includes(KOFI));
  assert.match(toMaster[0].text, /separate from yours/i, "and what approving actually means");

  // It is a real gate confirmation, tied to that number.
  const req = access.requestInFrontOfMaster();
  assert.equal(req.address, KOFI);
  const c = db.getConfirmation(config.ownerConversation, req.confirmation_id);
  assert.equal(c.action, "access_grant");
  assert.equal(c.target, KOFI);
});

test("a name from the channel is passed on; without one the number stands alone", async () => {
  const h = harness();
  await h.router.deliver({ ...texts(KOFI, "hi"), displayName: "Kofi Mensah" });
  const toMaster = sentTo(h.channel, MASTER)[0].text;
  assert.ok(toMaster.includes("Kofi Mensah"));
  assert.ok(toMaster.includes(KOFI));
});

test("while waiting, more texts cost nothing and get at most one nudge", async () => {
  const h = harness();
  await h.router.deliver(texts(KOFI, "hello?", "a"));
  const after1 = sentTo(h.channel, KOFI).length;

  for (const id of ["b", "c", "d"]) await h.router.deliver(texts(KOFI, "still there?", id));
  assert.equal(sentTo(h.channel, KOFI).length, after1, "not a word more while they wait");
  assert.equal(h.turns.length, 0, "and no model turns at all");
  assert.equal(sentTo(h.channel, MASTER).length, 1, "the master is asked once, not once per text");

  // Hours later, one "still waiting".
  clock.skip(7 * 60 * 60 * 1000);
  await h.router.deliver(texts(KOFI, "any news", "e"));
  const now = sentTo(h.channel, KOFI);
  assert.equal(now.length, after1 + 1);
  assert.match(now.at(-1).text, /still waiting/i);
  assert.equal(h.turns.length, 0);
});

// ---------- the master says yes ----------

test("yes creates the account, welcomes them, and their next text gets a real turn", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi", "a"));

  const out = await masterSays(h, "yeah go on then");
  assert.equal(out.decided, true);
  assert.equal(out.granted, true);
  assert.equal(out.quote, "yeah go on then", "their actual words are on the record");

  // The account exists, in its own conversation.
  const acct = db.getAccount(`dm:fake:${KOFI}`);
  assert.ok(acct);
  assert.equal(acct.address, KOFI);
  assert.equal(acct.is_operator, 0);
  assert.equal(acct.state, "active");
  assert.equal(db.getAccessRequest(out.requestId).state, "approved");

  // They are welcomed, and from then on they are a real person with a real Reason.
  assert.match(out.toThem, /you're in/i);
  const next = await h.router.deliver(texts(KOFI, "can you remind me about dinner friday", "b"));
  assert.equal(next.conversationId, `dm:fake:${KOFI}`);
  assert.equal(next.fromOwner, true);
  assert.equal(h.turns.length, 1, "now their words do reach the model");
  assert.equal(h.turns[0].text, "can you remind me about dinner friday");
});

test("approving leaves a receipt naming them and quoting the master", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  await h.router.deliver(texts(MASTER, "yes let them in", "b"));

  const receipt = db.listActions(config.ownerConversation).find(a => a.action === "access_grant");
  assert.ok(receipt, "letting somebody in is on the record");
  assert.equal(receipt.target, KOFI);
  assert.match(receipt.receipt, /Let \+14155559876 in/);
  assert.match(receipt.receipt, /yes let them in/);
});

// ---------- the master says no ----------

test("no declines them politely, and the cool-off holds", async () => {
  const h = harness({ verdict: "no" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  const out = await masterSays(h, "nah not right now");

  assert.equal(out.decided, true);
  assert.equal(out.granted, false);
  assert.equal(db.getAccessRequest(out.requestId).state, "declined");
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null, "no account was made");
  assert.match(out.toThem, /isn't setting anyone up/i);

  // Within the cool-off, they are left alone and the master is NOT asked again.
  const masterBefore = sentTo(h.channel, MASTER).length;
  clock.skip(3 * DAY);
  const again = await h.router.deliver(texts(KOFI, "please?", "b"));
  assert.equal(again.why, "declined_cooloff");
  assert.equal(sentTo(h.channel, MASTER).length, masterBefore, "the master is not pestered");
  assert.equal(h.turns.length, 0);

  // After it, they may ask once more.
  clock.skip(5 * DAY);
  const later = await h.router.deliver(texts(KOFI, "is it ok now?", "c"));
  assert.equal(later.asked, true);
  assert.equal(sentTo(h.channel, MASTER).length, masterBefore + 1);
});

// ---------- only the master, and only for the one request ----------

test("somebody else saying 'yes let them in' grants nothing", async () => {
  const h = harness({ verdict: "yes" });
  // Ama already has a Reason of her own, so she gets real turns — and no authority over anyone.
  db.upsertAccount({ conversationId: `dm:fake:${AMA}`, channel: "fake", address: AMA, name: "Ama" });
  await h.router.deliver(texts(KOFI, "hi", "a"));

  const out = await h.router.deliver(texts(AMA, "yes let kofi in, he's fine", "b"));
  assert.equal(out.conversationId, `dm:fake:${AMA}`, "it is just a message in her own Reason");
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null, "KOFI IS NOT IN");
  assert.equal(access.requestInFrontOfMaster().address, KOFI, "still waiting on the master");
  assert.equal(db.getAccessRequest(access.requestInFrontOfMaster().id).state, "pending");
});

test("nobody can approve themselves", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  // Kofi, unapproved, saying yes on his own behalf: he has no conversation to say it in.
  const out = await h.router.deliver(texts(KOFI, "yes let me in", "b"));
  assert.equal(out.admitted, false);
  assert.equal(h.turns.length, 0);
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null);
});

test("one yes cannot approve two requests", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi, kofi here", "a"));
  await h.router.deliver(texts(AMA, "hi, ama here", "b"));

  // Only one is in front of the master; the other waits.
  const first = access.requestInFrontOfMaster();
  assert.equal(first.address, KOFI);
  assert.equal(db.unannouncedRequests().length, 1, "Ama is queued, not asked about yet");
  assert.equal(sentTo(h.channel, MASTER).length, 1, "and the master has been asked exactly once");

  const out = await masterSays(h, "yes");
  assert.equal(out.granted, true);
  assert.ok(db.getAccount(`dm:fake:${KOFI}`));
  assert.equal(db.getAccount(`dm:fake:${AMA}`), null, "AMA IS NOT IN on Kofi's yes");

  // That confirmation is spent, and cannot be re-used for her.
  const spent = trust.authorizeConfirmation({
    conversationId: config.ownerConversation, action: "access_grant",
    confirmationId: first.confirmation_id, target: AMA,
  });
  assert.equal(spent.ok, false);
});

test("the next request goes in front of the master once the first is answered", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "kofi here", "a"));
  await h.router.deliver(texts(AMA, "ama here", "b"));
  await h.router.deliver(texts(MASTER, "yes", "c"));

  const now = access.requestInFrontOfMaster();
  assert.ok(now, "Ama's turn to be asked about");
  assert.equal(now.address, AMA);
  const toMaster = sentTo(h.channel, MASTER);
  assert.ok(toMaster.at(-1).text.includes("ama here"), "and her own words are quoted");
});

test("an expired request cannot be approved", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  const req = access.requestInFrontOfMaster();

  clock.skip(8 * DAY); // past REASON_ACCESS_WINDOW_MIN
  const out = await masterSays(h, "yes go on");
  assert.equal(out.decided, false);
  assert.equal(out.reason, "expired");
  assert.equal(db.getAccessRequest(req.id).state, "expired");
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null, "a yes after the window grants nothing");
});

test("an unclear answer grants nothing and leaves it pending", async () => {
  const h = harness({ verdict: "unclear" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  const out = await masterSays(h, "who even is that");

  assert.equal(out.decided, false);
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null);
  assert.equal(access.requestInFrontOfMaster().address, KOFI, "still there to be answered");
});

test("an answer that wants it different grants nothing either", async () => {
  const h = harness({ verdict: "change" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  const out = await masterSays(h, "yeah but only for a week");
  assert.equal(out.decided, false);
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null);
});

test("the master's ordinary messages are not read as answers", async () => {
  const h = harness({ verdict: "unclear" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  const out = await h.router.deliver(texts(MASTER, "what's the weather friday", "b"));

  assert.equal(out.conversationId, config.ownerConversation);
  assert.equal(h.turns.length, 1, "their turn runs as normal");
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null);
  assert.ok(access.requestInFrontOfMaster(), "and the request is still waiting");
});

// ---------- limits that protect the master ----------

test("the master is asked about at most so many an hour; the rest wait", async () => {
  const h = harness();
  // Four strangers, a cap of three an hour. Each is announced only when the one before is
  // answered, so what this really pins is that nothing is ever asked twice over.
  for (const [i, n] of [KOFI, AMA, NUISANCE, "+18885550000"].entries()) {
    await h.router.deliver(texts(n, `person ${i}`, `p${i}`));
  }
  assert.equal(sentTo(h.channel, MASTER).length, 1, "one question at a time");
  assert.equal(db.listAccessRequests({ state: "pending" }).length, 4, "the rest are queued, not lost");
  assert.equal(h.turns.length, 0, "and none of them cost a model turn");
});

test("a blocked number gets nothing at all and is never announced", async () => {
  const h = harness();
  db.blockNumber(NUISANCE, "spam");
  const out = await h.router.deliver(texts(NUISANCE, "let me in", "a"));

  assert.equal(out.blocked, true);
  assert.equal(h.turns.length, 0);
  assert.equal(h.channel.sent.length, 0, "not even a refusal — that is what blocked means");
  assert.equal(db.pendingRequestFor(NUISANCE), null);
});

test("blocking somebody who is waiting takes them off the master's plate", async () => {
  const h = harness();
  await h.router.deliver(texts(NUISANCE, "oi", "a"));
  assert.ok(db.pendingRequestFor(NUISANCE));

  const out = await runTool("admin_block", { number: NUISANCE, note: "spam" }, { conversationId: config.ownerConversation });
  assert.equal(out.ok, true);
  assert.equal(db.pendingRequestFor(NUISANCE), null, "the live request is closed");
  assert.equal(db.isBlocked(NUISANCE), true);
});

// ---------- stopping someone, without destroying anything ----------

test("a removed account stops answering, and keeps everything", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  await h.router.deliver(texts(MASTER, "yes", "b"));
  const k = `dm:fake:${KOFI}`;
  await runTool("plan_create", { title: "Kofi's dinner" }, { conversationId: k });
  const turnsBefore = h.turns.length;

  const removed = await runTool("admin_remove", { number: KOFI }, { conversationId: config.ownerConversation });
  assert.equal(removed.ok, true);
  assert.match(removed.note, /KEPT/);

  const out = await h.router.deliver(texts(KOFI, "you there?", "c"));
  assert.equal(out.stopped, "removed");
  assert.equal(h.turns.length, turnsBefore, "no model turn for a removed account");
  assert.match(sentTo(h.channel, KOFI).at(-1).text, /not set up to help/i);
  // And their data is still there, because removing is not deleting.
  assert.deepEqual(db.listPlans(k).map(p => p.title), ["Kofi's dinner"]);
});

test("pausing is the same, and resuming puts it back", async () => {
  const h = harness({ verdict: "yes" });
  db.upsertAccount({ conversationId: `dm:fake:${KOFI}`, channel: "fake", address: KOFI, name: "Kofi" });

  await runTool("admin_pause", { number: KOFI }, { conversationId: config.ownerConversation });
  const paused = await h.router.deliver(texts(KOFI, "hi", "a"));
  assert.equal(paused.stopped, "paused");
  assert.match(sentTo(h.channel, KOFI).at(-1).text, /paused/i);

  await runTool("admin_resume", { number: KOFI }, { conversationId: config.ownerConversation });
  const back = await h.router.deliver(texts(KOFI, "hi again", "b"));
  assert.equal(back.conversationId, `dm:fake:${KOFI}`);
  assert.equal(h.turns.length, 1);
});

test("deleting is a separate, gated act that really removes everything", async () => {
  db.upsertAccount({ conversationId: `dm:fake:${KOFI}`, channel: "fake", address: KOFI, name: "Kofi" });
  const k = `dm:fake:${KOFI}`;
  await runTool("plan_create", { title: "theirs" }, { conversationId: k });

  // It cannot be done without a yes naming them: it is irreversible.
  const ungated = await runTool("admin_delete", { number: KOFI }, { conversationId: config.ownerConversation });
  assert.equal(ungated.ok, false);
  assert.equal(ungated.blocked, "needs_confirmation");
  assert.deepEqual(db.listPlans(k).map(p => p.title), ["theirs"], "nothing happened");

  const msgs = [{ role: "user", content: "[Wed, Sep 30, 2026, 3:00 PM] Omari: delete kofi's stuff" }];
  const req = await runTool("confirm_request",
    { action: "admin_delete", summary: `delete everything of ${KOFI}'s`, target: KOFI },
    { conversationId: config.ownerConversation, messages: msgs });
  msgs.push({ role: "user", content: "[Wed, Sep 30, 2026, 3:01 PM] Omari: yes delete it" });
  await runTool("confirm_record", { confirmation_id: req.confirmation_id },
    { conversationId: config.ownerConversation, messages: msgs, judge: async () => ({ verdict: "yes" }) });

  const gone = await runTool("admin_delete", { number: KOFI, confirmation_id: req.confirmation_id },
    { conversationId: config.ownerConversation });
  assert.equal(gone.ok, true);
  assert.equal(db.listPlans(k).length, 0);
  assert.equal(db.getAccount(k), null);
});

// ---------- what the master can and cannot see ----------

test("the master sees the first message and usage counts, and nothing else ever", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi can you help me plan a trip", "a"));
  await h.router.deliver(texts(MASTER, "yes", "b"));
  const k = `dm:fake:${KOFI}`;

  // Kofi gets on with his own life, including a real turn of his own.
  await h.router.deliver(texts(KOFI, "help me plan lisbon", "c"));
  await runTool("plan_create", { title: "Lisbon in March, secretly" }, { conversationId: k });
  await runTool("remember", { about: "Ama", fact: "hates coriander" }, { conversationId: k });
  await runTool("page_create", { title: "Kofi's packing list", blocks: [{ type: "text", text: "private" }] }, { conversationId: k });

  const usage = await runTool("admin_usage", {}, { conversationId: config.ownerConversation });
  const asText = JSON.stringify(usage);
  assert.ok(usage.people.some(p => p.number === KOFI));
  assert.ok(usage.people.find(p => p.number === KOFI).usage[0].turns >= 1, "counts are visible");
  assert.equal(asText.includes("Lisbon"), false);
  assert.equal(asText.includes("coriander"), false);
  assert.equal(asText.includes("packing list"), false);
  assert.match(usage.note, /no tool that shows you what anybody said/i);

  // Nor through any of the master's own reading tools, which are all scoped to their own Reason.
  const mine = config.ownerConversation;
  assert.equal(JSON.stringify(await runTool("plan_list", {}, { conversationId: mine })).includes("Lisbon"), false);
  assert.equal(JSON.stringify(await runTool("recall", {}, { conversationId: mine })).includes("coriander"), false);
  assert.equal(JSON.stringify(await runTool("page_list", {}, { conversationId: mine })).includes("packing list"), false);
  assert.equal(JSON.stringify(await runTool("ledger_list", {}, { conversationId: mine })).includes("packing list"), false);
});

test("one person cannot see another's, either", async () => {
  db.upsertAccount({ conversationId: `dm:fake:${KOFI}`, channel: "fake", address: KOFI, name: "Kofi" });
  db.upsertAccount({ conversationId: `dm:fake:${AMA}`, channel: "fake", address: AMA, name: "Ama" });
  await runTool("plan_create", { title: "Kofi's thing" }, { conversationId: `dm:fake:${KOFI}` });

  const hers = await runTool("plan_list", {}, { conversationId: `dm:fake:${AMA}` });
  assert.equal(JSON.stringify(hers).includes("Kofi's thing"), false);
  const herRequests = await runTool("admin_requests", {}, { conversationId: `dm:fake:${AMA}` });
  assert.equal(herRequests.blocked, "master_only", "and she has no admin view at all");
});

test("the master's own Reason is a normal one: their plans are theirs", async () => {
  await runTool("plan_create", { title: "my own dinner" }, { conversationId: config.ownerConversation });
  const me = accounts.ownerOf(config.ownerConversation);
  assert.equal(me.isOperator, true);
  assert.equal(me.name, "Omari");
  assert.deepEqual(db.listPlans(config.ownerConversation).map(p => p.title), ["my own dinner"]);
});

// ---------- the subscription backend still only answers test numbers ----------

test("a number the master listed as a test number is already approved: first text gets a real turn", async () => {
  const keptBackend = config.backend;
  const keptTest = config.testNumbers;
  config.backend = "claude-cli";
  config.testNumbers = [MASTER, KOFI];
  try {
    const h = harness({ verdict: "yes" });
    const out = await h.router.deliver(texts(KOFI, "hey, what can you do", "a"));
    assert.equal(sentTo(h.channel, MASTER).length, 0, "the master is not asked a question they already answered");
    assert.equal(db.unannouncedRequests().length, 0, "no access request is made");
    assert.ok(db.getAccount(`dm:fake:${KOFI}`), "their own account exists");
    assert.equal(db.getAccount(`dm:fake:${KOFI}`).is_operator ? 1 : 0, 0, "and it is not the master's");
    assert.equal(h.turns.length, 1, "their first message is a real turn");
    assert.notEqual(out.conversationId, config.ownerConversation, "in their own conversation, not the master's");

    // Somebody NOT on the list still has to be let in the usual way.
    await h.router.deliver(texts(AMA, "hi", "b"));
    assert.equal(sentTo(h.channel, MASTER).length, 1);
    assert.equal(h.turns.length, 1, "and their message spent no turn");
  } finally { config.backend = keptBackend; config.testNumbers = keptTest; }
});

test("a blocked number is refused even if it is on the test list", async () => {
  const keptTest = config.testNumbers;
  config.testNumbers = [MASTER, KOFI];
  try {
    const h = harness({ verdict: "yes" });
    db.blockNumber(KOFI, "test");
    assert.ok(db.isBlocked(KOFI));
    await h.router.deliver(texts(KOFI, "hi", "a"));
    assert.equal(h.turns.length, 0);
    assert.ok(!db.getAccount(`dm:fake:${KOFI}`), "and no account is made for them");
  } finally { config.testNumbers = keptTest; }
});


test("on claude-cli the approval flow runs, but only a test number can hold an account", async () => {
  const keptBackend = config.backend;
  const keptTest = config.testNumbers;
  config.backend = "claude-cli";
  config.testNumbers = [MASTER];
  try {
    const h = harness({ verdict: "yes" });
    // A stranger can still ask, and the master is still asked: that costs no model turn either way.
    await h.router.deliver(texts(KOFI, "hi", "a"));
    assert.equal(sentTo(h.channel, MASTER).length, 1);

    await masterSays(h, "yes");
    assert.ok(db.getAccount(`dm:fake:${KOFI}`), "the account is made");

    // But on this backend they still get no turn: it is not their plan to spend.
    const out = await h.router.deliver(texts(KOFI, "plan my week", "b"));
    assert.equal(out.served, false);
    assert.equal(out.why, "subscription_backend_test_only");
    assert.equal(h.turns.length, 0);
  } finally { config.backend = keptBackend; config.testNumbers = keptTest; }
});

// ---------- the master number itself ----------

test("REASON_OWNER_NUMBER still works, so an existing install is not locked out", async () => {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const read = (env) => JSON.parse(execFileSync(process.execPath, ["-e",
    `import("./src/config.js").then(({config})=>console.log(JSON.stringify(config.masterNumbers)))`],
    { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, REASON_MASTER_NUMBER: "", REASON_OWNER_NUMBER: "", ...env }, encoding: "utf8" }));

  assert.deepEqual(read({ REASON_OWNER_NUMBER: "+12025551234" }), ["+12025551234"], "the old name still works");
  assert.deepEqual(read({ REASON_MASTER_NUMBER: "+13475550000" }), ["+13475550000"]);
  assert.deepEqual(read({ REASON_MASTER_NUMBER: "+13475550000", REASON_OWNER_NUMBER: "+12025551234" }), ["+13475550000"],
    "and the new name wins when both are set");
});

// ---------- the answer itself costs nothing, and is answered once ----------

test("answering an access request spends no model turn and replies once", async () => {
  const h = harness({ verdict: "yes" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  const beforeMaster = sentTo(h.channel, MASTER).length;

  const out = await h.router.deliver(texts(MASTER, "yeah go on then", "b"));
  assert.equal(out.access, "granted");
  assert.equal(h.turns.length, 0, "code answered, so there is nothing for the model to add");
  assert.equal(sentTo(h.channel, MASTER).length, beforeMaster + 1,
    "one reply about one decision — not a code line and a model line saying the same thing twice");
});

test("a message that is not an answer still gets the master's normal turn", async () => {
  const h = harness({ verdict: "unclear" });
  await h.router.deliver(texts(KOFI, "hi", "a"));
  const out = await h.router.deliver(texts(MASTER, "remind me to call mum", "b"));
  assert.equal(out.access, undefined);
  assert.equal(h.turns.length, 1, "their own life carries on");
});

test("the master can be reached even if their recorded channel is not running", async () => {
  // Their account can be seeded with a channel this install does not have — which is exactly how
  // the master silently stopped receiving access questions the first time this was built.
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "linq", address: MASTER, name: "Omari", isOperator: true });
  const h = harness();
  await h.router.deliver(texts(KOFI, "hi", "a"));
  assert.equal(sentTo(h.channel, MASTER).length, 1, "it falls back to a channel that is actually live");
});

test("a judge that cannot be reached grants nothing and loses nothing", async () => {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ text }) => { turns.push(text); return "ok"; } });
  const router = new Router({ runtime, judge: async () => { throw new Error("no model"); } });
  const channel = router.register(new FakeChannel({}));
  await router.deliver(texts(KOFI, "hi", "a"));

  const out = await router.deliver(texts(MASTER, "yes", "b"));
  assert.equal(out.access, undefined);
  assert.equal(db.getAccount(`dm:fake:${KOFI}`), null, "nothing was granted on a broken judge");
  assert.ok(access.requestInFrontOfMaster(), "and the request is still there to answer");
  assert.equal(turns.length, 1, "the master's message was not swallowed either");
  void channel;
});
