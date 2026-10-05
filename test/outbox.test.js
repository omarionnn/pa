// Lost replies: the outbox, without a model and without a network.
//
// What this file is really about is one night's bug. A reply that failed to send was logged to
// stderr and dropped, and the first real text anybody sent Reason was lost that way — Reason wrote
// an answer, the send failed, and the person on the other end saw silence while Reason carried on
// as though it had replied.
//
// So every test in here is a question about a failure, not a success:
//
//   does a message that could not go out still exist afterwards?        (yes, as a row)
//   does it come back on its own when the failure was temporary?        (yes, with backoff)
//   does it come back when the failure was a refusal?                   (no, never)
//   can it go out twice?                                                (no, not once)
//   what happens if the process dies mid-send?                          (the channel is asked)
//   what if the channel cannot say whether it went?                     (it is NOT resent, and said)
//   who finds out when it is finally dead?                              (Reason, then the owner)
//
// No API key needed. The clock is the fake one, so backoff is asserted rather than waited for.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-outbox-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const outbox = await import("../src/outbox.js");
const { runTool } = await import("../src/tools.js");
const { health } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const OWNER_CONV = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM access_requests; DELETE FROM usage; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: OWNER_CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: OWNER_CONV, channel: "fake", address: OWNER, chatId: null, isOwner: true });
});

/** A router and runtime whose turns are recorded rather than run. */
function harness(channelOpts = {}) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return null; },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel(channelOpts));
  router.register(new ConsoleChannel());
  runtime.turnExtras.channels = router;
  return { runtime, router, fake, turns, logs };
}

const send = (router, over = {}) => router.send({
  channel: "fake", to: OWNER, text: "on my way", conversationId: OWNER_CONV, toOwner: true, ...over,
});

// ---------- a message is a row before it is an attempt ----------

test("a message that went out is a row saying so, with the channel's own handle on it", async () => {
  const { router, fake } = harness();
  const r = await send(router);
  assert.equal(r.ok, true);
  assert.equal(fake.sent.length, 1);

  const row = db.getOutbound(r.outbox_id);
  assert.equal(row.state, "sent");
  assert.equal(row.attempts, 1);
  assert.equal(row.address, OWNER);
  assert.equal(row.body, "on my way");
  assert.equal(row.message_id, "fake-1");
  assert.ok(row.sent_at);
  assert.equal(row.next_attempt_at, null, "a sent message is not due for anything");
});

test("a message that could not go out still exists afterwards — that is the whole point", async () => {
  const { router, fake } = harness({ failWith: "the network dropped it", retryable: true });
  const r = await send(router);
  assert.equal(r.ok, false);
  assert.equal(r.queued, true, "not sent, and not lost either");
  assert.equal(fake.sent.length, 0);

  const row = db.getOutbound(r.outbox_id);
  assert.equal(row.state, "queued");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, "the network dropped it");
  assert.ok(row.next_attempt_at > clock.now(), "it has a time to come back at");
});

// ---------- retry what can work, never what cannot ----------

test("a temporary failure comes back on its own, and the text goes exactly once", async () => {
  // Two attempts fail, the third works — a flaky network, which is the case retrying is for.
  const { runtime, router, fake } = harness({ failTimes: 2 });
  const r = await send(router);
  assert.equal(r.queued, true);
  assert.equal(fake.attempts.length, 1);

  // Nothing is due yet, so a sweep now must not spend an attempt.
  assert.deepEqual(await runtime.outbox(), { tried: 0, sent: 0, requeued: 0, failed: 0, resolved: 0, owner_told: 0 });
  assert.equal(fake.attempts.length, 1);

  clock.skip(config.outboxBackoffMs);
  const second = await runtime.outbox();
  assert.equal(second.tried, 1);
  assert.equal(second.requeued, 1, "second attempt failed too");

  clock.skip(config.outboxBackoffMs * 2);
  const third = await runtime.outbox();
  assert.equal(third.sent, 1);

  assert.equal(fake.attempts.length, 3, "three attempts");
  assert.equal(fake.sent.length, 1, "ONE text");
  assert.equal(db.getOutbound(r.outbox_id).state, "sent");
});

test("a refusal is never retried, however many sweeps run", async () => {
  // Not retryable: a bad number, an opted-out contact, "cannot send to self". Retrying these is
  // not persistence — it is texting somebody who said stop.
  const { runtime, router, fake } = harness({ failWith: "they've opted out of messages from this number", retryable: false });
  const r = await send(router);
  assert.equal(r.ok, false);
  assert.equal(r.queued, undefined, "there is nothing to wait for");
  assert.equal(r.retryable, false);

  const row = db.getOutbound(r.outbox_id);
  assert.equal(row.state, "failed");
  assert.ok(row.failed_at);
  assert.equal(row.next_attempt_at, null);

  clock.skip(60 * 60 * 1000);
  await runtime.outbox();
  await runtime.outbox();
  assert.equal(fake.attempts.length, 1, "one attempt, ever");
});

test("a failure that does not say whether it can be retried is treated as final", async () => {
  // The default direction matters more than it looks. An unclassified failure retried on a timer is
  // how a messaging system texts somebody four times.
  const { router } = harness({ failWith: "something went wrong" });
  const r = await send(router);
  assert.equal(db.getOutbound(r.outbox_id).state, "failed");
});

test("backoff grows and then stops growing", () => {
  assert.equal(outbox.backoffMs(1), config.outboxBackoffMs);
  assert.equal(outbox.backoffMs(2), config.outboxBackoffMs * 2);
  assert.equal(outbox.backoffMs(3), config.outboxBackoffMs * 4);
  assert.equal(outbox.backoffMs(99), config.outboxBackoffMaxMs, "capped, so nothing waits an hour");
});

test("the attempt budget runs out, and that is reported rather than retried forever", async () => {
  const { runtime, router, fake } = harness({ failWith: "502 from upstream", retryable: true });
  const r = await send(router);

  for (let i = 0; i < config.outboxMaxAttempts + 3; i++) {
    clock.skip(config.outboxBackoffMaxMs);
    await runtime.outbox();
  }
  const row = db.getOutbound(r.outbox_id);
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, config.outboxMaxAttempts);
  assert.match(row.last_error, /tried 5 times/);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.attempts.length, config.outboxMaxAttempts, "no attempt past the budget");
});

test("a channel with no credentials fails the message rather than retrying against nothing", async () => {
  const { runtime, router, fake } = harness({ live: false });
  const r = await send(router);
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/);
  assert.equal(r.retryable, false, "a missing credential does not clear on its own");
  // Refused before a row exists: there is nothing to come back to.
  assert.equal(r.outbox_id, undefined);
  assert.deepEqual(db.outboxCounts(), {});
  await runtime.outbox();
  assert.equal(fake.attempts.length, 0);
});

// ---------- never twice ----------

test("the same idempotency key is one row and one text, however often it is asked for", async () => {
  const { router, fake } = harness();
  const first = await send(router, { idempotencyKey: "reply-7" });
  const second = await send(router, { idempotencyKey: "reply-7" });
  const third = await send(router, { idempotencyKey: "reply-7", text: "different words, same key" });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.equal(first.outbox_id, second.outbox_id);
  assert.equal(fake.sent.length, 1, "one text");
  assert.equal(db.outboxCounts().sent, 1);
});

test("a dead message asked for again stays dead instead of going out late", async () => {
  const { router, fake } = harness({ failWith: "bad number", retryable: false });
  const first = await send(router, { idempotencyKey: "reply-8" });
  assert.equal(db.getOutbound(first.outbox_id).state, "failed");

  const again = await send(router, { idempotencyKey: "reply-8" });
  assert.equal(again.ok, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.error, "bad number");
  assert.equal(fake.attempts.length, 1);
});

test("two overlapping sweeps cannot both send the same row", async () => {
  const { runtime, router, fake } = harness({ failTimes: 1 });
  await send(router);
  clock.skip(config.outboxBackoffMs);

  // Both passes start before either finishes, which is what two sweeps ticking together look like.
  const [a, b] = await Promise.all([runtime.outbox(), runtime.outbox()]);
  assert.equal(fake.sent.length, 1, "one of them claimed it; the other found nothing to do");
  assert.equal(a.sent + b.sent, 1);
});

// ---------- the process died mid-send ----------

test("a message interrupted mid-send is not resent until the channel is asked", async () => {
  const { runtime, router, fake } = harness({ findSentAs: "found" });
  // A row stuck in `sending` is a crash: nothing else leaves one there.
  const { row } = db.enqueueOutbound({
    idemKey: "crashed-1", conversationId: OWNER_CONV, channel: "fake", address: OWNER,
    body: "i booked it", toOwner: true,
  });
  db.claimOutbound(row.id);
  assert.equal(db.getOutbound(row.id).state, "sending");

  // Startup. Nothing is sent here — the state only becomes "we do not know".
  const rescued = outbox.recoverStranded();
  assert.deepEqual(rescued, [row.id]);
  assert.equal(db.getOutbound(row.id).state, "unknown");
  assert.equal(fake.attempts.length, 0, "nothing went out on the strength of a guess");

  // The first sweep asks, and the channel says it already went.
  const pass = await runtime.outbox();
  assert.equal(pass.resolved, 1);
  assert.equal(db.getOutbound(row.id).state, "sent");
  assert.equal(db.getOutbound(row.id).message_id, "fake-recovered");
  assert.equal(fake.sent.length, 0, "it was already out there — sending again would be the second copy");
  assert.equal(fake.findSentCalls[0].text, "i booked it");
  assert.ok(fake.findSentCalls[0].since <= fake.findSentCalls[0].until);
});

test("an interrupted message the channel never received does go out, once", async () => {
  const { runtime, router, fake } = harness({ findSentAs: "missing" });
  const { row } = db.enqueueOutbound({
    idemKey: "crashed-2", conversationId: OWNER_CONV, channel: "fake", address: OWNER,
    body: "table's at 8", toOwner: true,
  });
  db.claimOutbound(row.id);
  outbox.recoverStranded();

  await runtime.outbox();                 // asks, is told no, requeues
  assert.equal(db.getOutbound(row.id).state, "queued");
  await runtime.outbox();                 // sends
  assert.equal(db.getOutbound(row.id).state, "sent");
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].text, "table's at 8");
});

test("when the channel cannot say whether it went, it is NOT sent again, and that is said out loud", async () => {
  // The one place the system chooses to lose a message rather than risk sending it twice.
  const { runtime, router, fake } = harness();  // no findSentAs: this channel cannot check
  const { row } = db.enqueueOutbound({
    idemKey: "crashed-3", conversationId: OWNER_CONV, channel: "fake", address: OWNER,
    body: "sent kofi the address", toOwner: true,
  });
  db.claimOutbound(row.id);
  outbox.recoverStranded();

  const pass = await runtime.outbox();
  assert.equal(pass.failed, 1);
  const after = db.getOutbound(row.id);
  assert.equal(after.state, "failed");
  assert.equal(fake.sent.length, 0, "nothing was risked");
  assert.match(after.last_error, /cannot say whether it arrived/);
  assert.match(after.last_error, /was NOT sent again/);
});

test("the whole restart is survivable: a queued message outlives the process that queued it", async () => {
  const first = harness({ failWith: "502 from upstream", retryable: true });
  const r = await send(first.router);
  assert.equal(r.queued, true);

  // A brand-new runtime and router, as if the process had been killed and restarted. The row is
  // all that carries over, because the row is all there is.
  const second = harness();
  assert.equal(outbox.recoverStranded().length, 0, "it was queued, not mid-flight");
  clock.skip(config.outboxBackoffMs);
  const pass = await second.runtime.outbox();

  assert.equal(pass.sent, 1);
  assert.equal(second.fake.sent.length, 1);
  assert.equal(second.fake.sent[0].text, "on my way");
  assert.equal(db.getOutbound(r.outbox_id).state, "sent");
  assert.equal(first.fake.sent.length, 0, "the process that failed never sent it");
});

// ---------- somebody is always told ----------

test("Reason's next turn opens with the fact that its last reply never arrived", async () => {
  const { router } = harness({ failWith: "they've opted out of messages from this number", retryable: false });
  const r = await send(router, { text: "sorted — 8pm friday" });
  assert.equal(db.getOutbound(r.outbox_id).state, "failed");

  const lost = db.undeliveredFor(OWNER_CONV);
  assert.equal(lost.length, 1);
  const notice = outbox.undeliveredNotice(lost.filter(x => db.markUndeliveredTold(x.id)));
  assert.match(notice, /\[delivery failure\]/);
  assert.match(notice, /sorted — 8pm friday/);
  assert.match(notice, /opted out/);
  assert.match(notice, /do not talk as though it landed/);

  // Once. An apology repeated every turn is its own bug.
  assert.deepEqual(db.undeliveredFor(OWNER_CONV), []);
  assert.equal(outbox.undeliveredNotice(db.undeliveredFor(OWNER_CONV)), "");
});

test("two lost replies are both owed, oldest first", async () => {
  const { router } = harness({ failWith: "bad number", retryable: false });
  await send(router, { text: "first thing" });
  await send(router, { text: "second thing" });
  const lost = db.undeliveredFor(OWNER_CONV);
  assert.equal(lost.length, 2);
  const notice = outbox.undeliveredNotice(lost);
  assert.match(notice, /2 messages you sent/);
  assert.ok(notice.indexOf("first thing") < notice.indexOf("second thing"));
});

test("a failed message to somebody else reaches the owner, in code's words, once", async () => {
  // Kofi's number is unreachable; the owner's is fine. That is the ordinary shape of this failure.
  const { runtime, router, fake } = harness({
    failFor: FRIEND, failWith: "they've opted out of messages from this number", retryable: false,
  });
  // Reason told the owner it would text Kofi. Kofi's text died. The owner is who needs to know.
  const r = await router.send({
    channel: "fake", to: FRIEND, text: "hey, omari says 8pm friday", conversationId: OWNER_CONV, toOwner: false,
  });
  assert.equal(db.getOutbound(r.outbox_id).state, "failed");

  const pass = await runtime.outbox();
  assert.equal(pass.owner_told, 1);
  const toOwner = fake.sent.filter(s => s.to === OWNER);
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0].text, new RegExp(FRIEND.replace("+", "\\+")));
  assert.match(toOwner[0].text, /never actually went out/);
  assert.match(toOwner[0].text, /opted out/);

  // Said once, not every sweep.
  await runtime.outbox();
  await runtime.outbox();
  assert.equal(fake.sent.filter(s => s.to === OWNER).length, 1);
});

test("when even the line to the owner is down, the bad news becomes a row instead of vanishing", async () => {
  // The nastiest case: Reason cannot reach Kofi AND cannot reach the owner to say so. The notice is
  // itself a durable message, so it retries — and if it never gets there either, it lands at the top
  // of the owner's next turn like any other lost reply. Nothing is dropped on the floor.
  const { runtime, router } = harness({ failWith: "the whole line is down", retryable: true });
  await router.send({ channel: "fake", to: FRIEND, text: "omari says 8pm", conversationId: OWNER_CONV, toOwner: false });

  // Kofi's message dies on the budget; the owner notice is then attempted and queued.
  for (let i = 0; i < config.outboxMaxAttempts + 1; i++) {
    clock.skip(config.outboxBackoffMaxMs);
    await runtime.outbox();
  }
  const rows = db.db.prepare("SELECT body, state, to_owner FROM outbox ORDER BY id").all();
  assert.equal(rows.length, 2, "the failure to Kofi, and the attempt to tell the owner about it");
  assert.match(rows[1].body, /never actually went out/);
  assert.equal(rows[1].to_owner, 1);
  assert.ok(["queued", "failed"].includes(rows[1].state), "still trying, or itself owed to the next turn");
});

test("a failed message to the owner is not also announced to the owner", async () => {
  // They are told at the top of their own next turn. A text about the text that failed, sent down
  // the same channel that just failed, would be both redundant and unlikely to arrive.
  const { runtime, router, fake } = harness({ failWith: "bad number", retryable: false });
  await send(router, { text: "yours" });
  const pass = await runtime.outbox();
  assert.equal(pass.owner_told, 0);
  assert.equal(fake.sent.length, 0);
  assert.equal(db.ownerUntoldFailures().length, 0);
});

test("the model is told 'queued' is not 'sent', in the words it has to repeat", async () => {
  const { router } = harness({ failWith: "502 from upstream", retryable: true });
  const out = await runTool("message_send", { to: "owner", text: "i'll be there" }, { conversationId: OWNER_CONV, channels: router });
  assert.equal(out.ok, false);
  assert.equal(out.queued, true);
  assert.match(out.note, /NOT sent yet/);
  assert.match(out.note, /Do not say you sent it/);
  assert.equal(/You may say you sent it/.test(out.note), false);
});

test("a send that worked still tells the model it may say so", async () => {
  const { router } = harness();
  const out = await runTool("message_send", { to: "owner", text: "i'll be there" }, { conversationId: OWNER_CONV, channels: router });
  assert.equal(out.ok, true);
  assert.equal(out.queued, undefined);
  assert.match(out.note, /actually went out/);
});

// ---------- what is still owed, at a glance ----------

test("health shows what the outbox is holding", async () => {
  const { router, runtime } = harness({ failWith: "bad number", retryable: false });
  await send(router, { text: "dead one" });
  assert.deepEqual(health({ router, runtime }).outbox, { failed: 1 });
});

test("the console is not in the outbox, because there is nothing to retry about a terminal", async () => {
  const { router, runtime } = harness();
  const r = await router.send({ channel: "console", to: "console", text: "hello", conversationId: OWNER_CONV, toOwner: true });
  assert.equal(r.ok, true);
  assert.equal(r.outbox_id, undefined);
  assert.deepEqual(health({ router, runtime }).outbox, {});
});
