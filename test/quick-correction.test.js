// REASON_QUICK_CORRECTION (src/verifications.js): after an action that reached the outside world,
// a check on the sweep; if it did not hold, one unprompted line starting "quick correction:".
//
//   is a bounced email said in one line, unprompted?                 (yes — with the fix / next step)
//   is an email that held said about at all?                          (no — verified, silence)
//   does "cannot tell yet" wait rather than guess?                    (yes — retried, then left alone)
//   are their quiet hours and the daily cap respected?                (yes — deferred, never skipped)
//   does a failed text to somebody else get it, once, not twice?      (yes — the outbox's line is spent)
//   does the switch being off change nothing?                         (yes — nothing is scheduled)
//
// The checks against Google are mocked (setChecker); what is proved here is everything around them.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-quick-correction-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_QUICK_CORRECTION = "on";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const ver = await import("../src/verifications.js");
const accounts = await import("../src/accounts.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
/** 2pm in New York on a Thursday: nobody's quiet hours. */
const DAY = Date.UTC(2026, 10, 12, 19, 0, 0);
/** 3am the same morning. */
const NIGHT = Date.UTC(2026, 10, 12, 8, 0, 0);
const MIN = 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_QUICK_CORRECTION = "on";
  config.maxProactivePerDay = 0;
  for (const k of ver.KINDS) ver.setChecker(k, null);
  db.db.exec("DELETE FROM verifications; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM incidents;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: "H-1" });
});

function harness({ channel = {} } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async () => null, channels: router, deliver });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639", ...channel }));
  return { runtime, router, fake, logs };
}

const EMAIL = { account: "me@example.com", message_id: "m-1", thread_id: "t-1", to: ["kofi@example.com"], subject: "Friday" };

// ---------- the mocked failed email send ----------

test("an email that bounced: one unprompted line, starting 'quick correction:', with the next step", async () => {
  const { runtime, fake } = harness();
  const v = ver.schedule(CONV, "email", EMAIL, { now: DAY });
  assert.ok(v, "scheduled");
  assert.equal(v.state, "due");
  assert.equal(v.due_at, DAY + ver.SCHEDULE.email.afterMs, "checked a few minutes after the send, not at once");

  // Too early: nothing is checked, nothing is said.
  let out = await ver.pass({ runtime, now: DAY + MIN });
  assert.deepEqual(out, { due: 0, verified: 0, told: 0, retried: 0, deferred: 0, dropped: 0 });
  assert.equal(fake.sent.length, 0);

  // Due, and Gmail's thread now holds a bounce.
  ver.setChecker("email", async (row) => {
    assert.equal(row.ref.thread_id, "t-1", "checked against the provider's own id");
    return { ok: false, why: "it bounced (Address not found)" };
  });
  out = await ver.pass({ runtime, now: DAY + 4 * MIN });
  assert.equal(out.told, 1, JSON.stringify(out));
  assert.equal(fake.sent.length, 1);
  const line = fake.sent[0].text;
  assert.match(line, /^quick correction: the email "Friday" to kofi@example\.com didn't get through — it bounced \(Address not found\)\./);
  assert.match(line, /another address|send it yourself/, "the next step is in the line");
  assert.equal(ver.get(v.id).state, "told");
  assert.equal(db.usageToday(CONV, accounts.today()).proactive, 1, "it spent one of their unprompted texts");

  // Never twice.
  out = await ver.pass({ runtime, now: DAY + 30 * MIN });
  assert.equal(out.due, 0);
  assert.equal(fake.sent.length, 1);
});

test("an email that held: verified, and nothing is said", async () => {
  const { runtime, fake } = harness();
  const v = ver.schedule(CONV, "email", EMAIL, { now: DAY });
  ver.setChecker("email", async () => ({ ok: true }));
  const out = await ver.pass({ runtime, now: DAY + 4 * MIN });
  assert.equal(out.verified, 1);
  assert.equal(fake.sent.length, 0);
  assert.equal(ver.get(v.id).state, "verified");
});

test("cannot tell yet: checked again later, and left alone after the last try — never a guess", async () => {
  const { runtime, fake } = harness();
  const v = ver.schedule(CONV, "email", EMAIL, { now: DAY });
  ver.setChecker("email", async () => ({ pending: true, why: "Google did not answer" }));
  let out = await ver.pass({ runtime, now: DAY + 4 * MIN });
  assert.equal(out.retried, 1);
  assert.equal(ver.get(v.id).due_at, DAY + 4 * MIN + ver.SCHEDULE.email.retryMs);
  for (let i = 1; i < ver.SCHEDULE.email.tries; i++) out = await ver.pass({ runtime, now: DAY + 4 * MIN + i * ver.SCHEDULE.email.retryMs });
  assert.equal(out.dropped, 1);
  assert.equal(ver.get(v.id).state, "dropped");
  assert.equal(fake.sent.length, 0, "nothing was said about something nobody could check");
});

// ---------- quiet hours and the cap ----------

test("in their night the line waits for their morning; it is not dropped and not sent", async () => {
  const { runtime, fake } = harness();
  const v = ver.schedule(CONV, "email", EMAIL, { now: NIGHT - 10 * MIN });
  ver.setChecker("email", async () => ({ ok: false, why: "it bounced" }));
  const out = await ver.pass({ runtime, now: NIGHT });
  assert.equal(out.deferred, 1);
  assert.equal(fake.sent.length, 0);
  const after = ver.get(v.id);
  assert.equal(after.state, "due");
  assert.ok(after.due_at >= Date.UTC(2026, 10, 12, 13, 0, 0), "8am New York or later");
  // Morning comes.
  const morning = await ver.pass({ runtime, now: after.due_at });
  assert.equal(morning.told, 1);
  assert.match(fake.sent[0].text, /^quick correction:/);
});

test("over the day's proactive cap it waits an hour rather than skipping the correction", async () => {
  const { runtime, fake } = harness();
  config.maxProactivePerDay = 1;
  accounts.countUse(CONV, "proactive");
  const v = ver.schedule(CONV, "email", EMAIL, { now: DAY });
  ver.setChecker("email", async () => ({ ok: false, why: "it bounced" }));
  const out = await ver.pass({ runtime, now: DAY + 4 * MIN });
  assert.equal(out.deferred, 1);
  assert.equal(fake.sent.length, 0);
  assert.equal(ver.get(v.id).due_at, DAY + 4 * MIN + 60 * MIN);
});

// ---------- calendar and a text to somebody else ----------

test("an event that is gone: 'quick correction:' with the offer to put it back", async () => {
  const { runtime, fake } = harness();
  ver.schedule(CONV, "calendar", { account: "me@example.com", event_id: "e-9", summary: "dentist", start: "2026-11-14T15:00:00" }, { now: DAY });
  ver.setChecker("calendar", async () => ({ ok: false, why: "it isn't on the calendar any more" }));
  await ver.pass({ runtime, now: DAY + 3 * MIN });
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].text, /^quick correction: "dentist" isn't on your calendar after all — it isn't on the calendar any more\. want me to put it back on\?$/);
});

test("a text to somebody else that never went: told once, and the outbox's own line about it is spent", async () => {
  const { runtime, router, fake } = harness({ channel: { failFor: FRIEND, failWith: "that number cannot be reached", retryable: false } });
  const r = await router.send({ channel: "fake", to: FRIEND, text: "omari's running late", conversationId: CONV, toOwner: false });
  assert.equal(r.ok, false);
  const v = ver.schedule(CONV, "text", { outbox_id: r.outbox_id, to: FRIEND }, { now: DAY });
  // The real checker, against the real outbox row: no mock here.
  await ver.pass({ runtime, now: DAY + 3 * MIN });
  const toOwner = fake.sent.filter(s => s.to === OWNER).map(s => s.text);
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0], new RegExp(`^quick correction: that text to \\${FRIEND} didn't go through — that number cannot be reached\\.`));
  assert.equal(ver.get(v.id).state, "told");
  assert.equal(db.ownerUntoldFailures().length, 0, "the outbox pass has nothing left to say about it");
  await runtime.outbox({ router });
  assert.equal(fake.sent.filter(s => s.to === OWNER).length, 1, "and says nothing more");
});

test("a text to somebody else that went: verified, silence", async () => {
  const { runtime, router, fake } = harness();
  const r = await router.send({ channel: "fake", to: FRIEND, text: "omari's running late", conversationId: CONV, toOwner: false });
  ver.schedule(CONV, "text", { outbox_id: r.outbox_id, to: FRIEND }, { now: DAY });
  const out = await ver.pass({ runtime, now: DAY + 3 * MIN });
  assert.equal(out.verified, 1);
  assert.equal(fake.sent.filter(s => s.to === OWNER).length, 0);
});

// ---------- the switch ----------

test("off: nothing is scheduled, and a row left from when it was on is dropped unsaid", async () => {
  const { runtime, fake } = harness();
  const v = ver.schedule(CONV, "email", EMAIL, { now: DAY });
  process.env.REASON_QUICK_CORRECTION = "off";
  assert.equal(ver.schedule(CONV, "email", EMAIL, { now: DAY }), null);
  ver.setChecker("email", async () => ({ ok: false, why: "it bounced" }));
  const out = await ver.pass({ runtime, now: DAY + 4 * MIN });
  assert.equal(out.dropped, 1);
  assert.equal(ver.get(v.id).state, "dropped");
  assert.equal(fake.sent.length, 0);
});
