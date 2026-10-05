// Read receipts, without a model or a network.
//
// A text that has been picked up and is being worked on looks exactly like a text that fell into a
// hole. One request fixes that, before a single token is spent.
//
// The questions worth asking are all about restraint rather than about the happy path:
//
//   is it sent only when the message was REALLY taken?  (not on a retry, not for somebody refused)
//   does a line that cannot do it get asked twice?       (no — remembered, for good)
//   does one unverified contact switch it off for all?   (no — scope is the whole bug risk here)
//   does a "not right now" get remembered?               (no, that would switch it off forever)
//   does any of it ever reach the person?                (no. the log, once, and nowhere else)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-receipts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not a burst test: the quiet window an arriving message waits in is off, so a webhook runs its
// turn the moment it lands. test/burst.test.js is where the window itself is proven.
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { markRead } = await import("../src/receipts.js");
const { health } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const STRANGER = "+14155559876";
const LINE = "+15122164639";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.readReceipts = true;
  db.db.exec("DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM access_requests; DELETE FROM turned_away; DELETE FROM blocked_numbers;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function harness(channelOpts = {}) {
  const logs = [];
  const turns = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return null; },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: LINE, ...channelOpts }));
  runtime.turnExtras.channels = router;
  return { runtime, router, fake, logs, turns };
}

const inbound = (over = {}) => ({
  channel: "fake", externalId: "e-1", from: OWNER, text: "you there?",
  chatId: null, service: "iMessage", at: clock.now(), ...over,
});

// ---------- only when the message was really taken ----------

test("a message Reason takes is marked read", async () => {
  const { router, fake } = harness();
  await router.deliver(inbound());
  assert.deepEqual(fake.markReadCalls, [{ to: OWNER }]);
});

test("a delivery the provider sent twice is marked read once", async () => {
  // Sendblue's delivery is at-least-once. The receipt is sent after the event id is claimed, so the
  // retry stops before it and the same message is not marked read again.
  const { router, fake } = harness();
  await router.deliver(inbound({ externalId: "same" }));
  const out = await router.deliver(inbound({ externalId: "same" }));
  assert.equal(out.duplicate, true);
  assert.equal(fake.markReadCalls.length, 1);
});

test("a number nobody approved is never marked read", async () => {
  // Nothing is going to answer it, and marking something read that Reason then ignores is worse
  // than silence.
  const { router, fake, turns } = harness();
  const out = await router.deliver(inbound({ from: STRANGER, externalId: "e-stranger" }));
  assert.equal(out.admitted, false);
  assert.equal(turns.length, 0);
  assert.equal(fake.markReadCalls.length, 0);
});

test("the switch turns it off, and nothing is asked at all", async () => {
  config.readReceipts = false;
  try {
    const { router, fake } = harness();
    await router.deliver(inbound());
    assert.equal(fake.markReadCalls.length, 0);
  } finally { config.readReceipts = true; }
});

test("it is on unless somebody turns it off", () => {
  // The default is the behaviour, so it is pinned rather than left to a reading of the config file.
  assert.equal(config.readReceipts, true);
});

// ---------- a refusal that is permanent is remembered ----------

test("a line that cannot do read receipts is asked once, ever", async () => {
  const { router, fake, logs } = harness({ markReadAs: "line" });
  await router.deliver(inbound({ externalId: "a" }));
  assert.equal(fake.markReadCalls.length, 1);

  // Remembered against the LINE, so it is off for everybody on it.
  const learned = db.blockedFeature({ channel: "fake", feature: "read_receipt", line: LINE });
  assert.ok(learned);
  assert.match(learned.why, /cannot send read receipts/);
  assert.equal(learned.code, "422");

  // Three more messages, from two different people. None of them asks.
  await router.deliver(inbound({ externalId: "b" }));
  await router.deliver(inbound({ externalId: "c" }));
  db.upsertAccount({ conversationId: `dm:fake:${STRANGER}`, channel: "fake", address: STRANGER, name: "Kofi" });
  await router.deliver(inbound({ externalId: "d", from: STRANGER }));
  assert.equal(fake.markReadCalls.length, 1, "asking again would be a wasted request nobody here can fix");

  // Said once in the log, and never to the person.
  assert.equal(logs.filter(l => l.read_receipt === "off_for_good").length, 1);
  assert.equal(fake.sent.length, 0, "a read receipt that failed is not news for whoever texted");
});

test("one unverified contact does not switch read receipts off for everybody", async () => {
  // The scope is the whole bug risk here: remembering a per-contact refusal against the line would
  // quietly kill a working feature for every other person.
  const { router, fake } = harness({ markReadAs: "contact" });
  await router.deliver(inbound({ externalId: "a" }));

  assert.equal(db.blockedFeature({ channel: "fake", feature: "read_receipt", line: LINE }), null);
  const learned = db.blockedFeature({ channel: "fake", feature: "read_receipt", contact: OWNER });
  assert.ok(learned);
  assert.equal(learned.code, "403");

  // That contact is not asked again...
  await router.deliver(inbound({ externalId: "b" }));
  assert.equal(fake.markReadCalls.length, 1);
  // ...but somebody else still is.
  db.upsertAccount({ conversationId: `dm:fake:${STRANGER}`, channel: "fake", address: STRANGER, name: "Kofi" });
  await router.deliver(inbound({ externalId: "c", from: STRANGER }));
  assert.equal(fake.markReadCalls.length, 2);
  assert.deepEqual(fake.markReadCalls[1], { to: STRANGER });
});

test("the line's refusal beats the contact's, because it is the broader fact", () => {
  db.recordChannelLimit({ channel: "fake", feature: "read_receipt", scope: `contact:${OWNER}`, why: "contact", code: "403" });
  db.recordChannelLimit({ channel: "fake", feature: "read_receipt", scope: `line:${LINE}`, why: "line", code: "422" });
  const hit = db.blockedFeature({ channel: "fake", feature: "read_receipt", line: LINE, contact: OWNER });
  assert.equal(hit.why, "line");
});

test("learning the same refusal twice keeps the first time it was learned", () => {
  db.recordChannelLimit({ channel: "fake", feature: "read_receipt", scope: `line:${LINE}`, why: "first", code: "422" });
  clock.skip(60_000);
  db.recordChannelLimit({ channel: "fake", feature: "read_receipt", scope: `line:${LINE}`, why: "second", code: "422" });
  const hit = db.channelLimit({ channel: "fake", feature: "read_receipt", scope: `line:${LINE}` });
  assert.equal(hit.why, "first", "the second refusal is the same fact, not a new one");
});

// ---------- a refusal that is temporary is not remembered ----------

test("a line that is momentarily unavailable is asked again next time", async () => {
  // 503 worker_unavailable and 429 are both "not now". Remembering those would switch the feature
  // off forever over a bad minute.
  const { router, fake, logs } = harness({ markReadAs: "transient" });
  await router.deliver(inbound({ externalId: "a" }));
  await router.deliver(inbound({ externalId: "b" }));
  assert.equal(fake.markReadCalls.length, 2);
  assert.deepEqual(db.listChannelLimits(), []);
  assert.ok(logs.some(l => l.not_now), "visible in the log, in case a line is permanently flapping");
});

test("a mark-read that throws cannot stop the turn", async () => {
  const { router, fake, turns, logs } = harness({ markReadAs: "throws" });
  const out = await router.deliver(inbound());
  assert.equal(out.ok, true);
  assert.equal(turns.length, 1, "the message was still answered");
  assert.ok(logs.some(l => l.threw));
  assert.deepEqual(db.listChannelLimits(), [], "a crash is not a fact about the line");
  void fake;
});

test("a channel with no read receipts at all, and one with no credentials, are skipped quietly", async () => {
  assert.deepEqual(await markRead({ channel: null, to: OWNER }), { skipped: "unsupported" });
  assert.deepEqual(
    await markRead({ channel: { name: "x", status: () => ({ status: "live" }) }, to: OWNER }),
    { skipped: "unsupported" },
  );
  assert.deepEqual(
    await markRead({ channel: new FakeChannel({ live: false }), to: OWNER }),
    { skipped: "not_connected" },
  );
});

// ---------- the real request ----------

test("Sendblue's mark-read is the endpoint and body its docs document", async () => {
  const saved = { id: config.sendblueKeyId, key: config.sendblueSecretKey, from: config.sendblueFrom, secret: config.sendblueWebhookSecret };
  config.sendblueKeyId = "k"; config.sendblueSecretKey = "s"; config.sendblueFrom = LINE; config.sendblueWebhookSecret = "w";
  try {
    const calls = [];
    const ch = new SendblueChannel({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "OK", message: "Mark read request sent", number: STRANGER }) };
      },
    });
    const out = await ch.markRead({ to: "+1 (415) 555-9876" });
    assert.deepEqual(out, { ok: true, supported: true });
    assert.equal(calls[0].url, "https://api.sendblue.com/api/mark-read");
    assert.deepEqual(JSON.parse(calls[0].init.body), { number: STRANGER, from_number: LINE });
    assert.equal(calls[0].init.headers["sb-api-key-id"], "k");
  } finally {
    config.sendblueKeyId = saved.id; config.sendblueSecretKey = saved.key;
    config.sendblueFrom = saved.from; config.sendblueWebhookSecret = saved.secret;
  }
});

test("each documented mark-read error is read as the thing Sendblue says it is", async () => {
  const saved = { id: config.sendblueKeyId, key: config.sendblueSecretKey, from: config.sendblueFrom, secret: config.sendblueWebhookSecret };
  config.sendblueKeyId = "k"; config.sendblueSecretKey = "s"; config.sendblueFrom = LINE; config.sendblueWebhookSecret = "w";
  try {
    const at = (status, body) => new SendblueChannel({
      fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify(body) }),
    }).markRead({ to: STRANGER });

    // 422 Unsupported Line — true for every contact, so it is the line's fact.
    const line = await at(422, { status: "ERROR", message: "unsupported_on_this_line", detail: "Read receipts are not supported on this line." });
    assert.equal(line.ok, false);
    assert.equal(line.remember.scope, "line");
    assert.match(line.remember.why, /not supported on this line/);

    // 403 Contact Not Verified — free plan only, so it is one person's.
    const contact = await at(403, { status: "ERROR", message: "Contact has not been verified for this account" });
    assert.equal(contact.remember.scope, "contact");
    assert.match(contact.remember.why, /not verified/);

    // 404 Line Not Found and 400 are misconfigurations: permanent, and the line's.
    assert.equal((await at(404, { status: "ERROR", message: "The from_number is not registered" })).remember.scope, "line");
    assert.equal((await at(400, { status: "ERROR", message: "You must specify a `number` in the request body." })).remember.scope, "line");

    // 503 and 429 are "not now" and must not be remembered.
    for (const code of [503, 429]) {
      const soon = await at(code, { status: "ERROR", message: "worker_unavailable", detail: "The line is not currently connected." });
      assert.equal(soon.ok, false);
      assert.equal(soon.transient, true);
      assert.equal("remember" in soon, false, `a ${code} must not switch read receipts off for good`);
    }

    // And a dropped socket is neither.
    const gone = await new SendblueChannel({ fetchImpl: async () => { throw new Error("ECONNRESET"); } }).markRead({ to: STRANGER });
    assert.equal(gone.ok, false);
    assert.equal("remember" in gone, false);
    assert.match(gone.error, /could not be reached/);
  } finally {
    config.sendblueKeyId = saved.id; config.sendblueSecretKey = saved.key;
    config.sendblueFrom = saved.from; config.sendblueWebhookSecret = saved.secret;
  }
});

test("health says what the install has learned it cannot do", async () => {
  const { router, runtime } = harness({ markReadAs: "line" });
  await router.deliver(inbound());
  assert.deepEqual(health({ router, runtime }).channel_limits, [{
    channel: "fake", feature: "read_receipt", scope: `line:${LINE}`,
    why: "this line cannot send read receipts",
  }]);
});
