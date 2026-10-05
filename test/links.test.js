// A link Reason sends leaves as its own message, with the words about it as the next one.
//
// Nothing here asserts a wording: what is tested is how many messages leave, which of them is the
// bare URL, and that a summary can never arrive before, or instead of, the link it belongs to.
// Whether iMessage then draws a preview card is not something a test can know — see
// docs/iphone-checklist.md.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-links-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { linkParts, splitsForLinks } = await import("../src/links.js");
const { makeDeliver } = await import("../src/deliver.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { SYSTEM } = await import("../src/agent.js");
const outbox = await import("../src/outbox.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const PAGE = "https://reason.test/p/ab12cd";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: "dm:owner", channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

// ---------- the split itself ----------

test("a reply with no link in it is one message, exactly as it was written", () => {
  assert.deepEqual(linkParts("yeah 8 works, i'll sort it"), ["yeah 8 works, i'll sort it"]);
  assert.equal(splitsForLinks("yeah 8 works"), false);
  assert.deepEqual(linkParts(""), []);
});

test("the link leaves on its own, and the words about it follow as their own message", () => {
  assert.deepEqual(
    linkParts(`made you a page with the shortlist ${PAGE} have a look`),
    [PAGE, "made you a page with the shortlist have a look"],
  );
  assert.deepEqual(linkParts(`${PAGE} that's the itinerary`), [PAGE, "that's the itinerary"]);
  assert.deepEqual(linkParts(PAGE), [PAGE], "a link and nothing else is already its own message");
});

test("a full stop at the end of a sentence is not part of the address", () => {
  assert.deepEqual(linkParts(`here it is ${PAGE}.`), [PAGE, "here it is"]);
  assert.deepEqual(linkParts(`here it is ${PAGE}!`), [PAGE, "here it is"]);
  // A path that really ends in a dot is vanishingly rare and a trailing dot breaks the tap, which
  // is the failure worth avoiding.
  assert.deepEqual(linkParts(`see ${PAGE}, it has prices`), [PAGE, "see it has prices"]);
});

test("several links keep their own words, and never each other's", () => {
  const a = "https://a.test/one";
  const b = "https://b.test/two";
  assert.deepEqual(
    linkParts(`the cheap one ${a} and the good one ${b} i'd take the second`),
    [a, "the cheap one", b, "and the good one i'd take the second"],
  );
});

test("a link with nothing written about it is just the link", () => {
  const a = "https://a.test/one";
  const b = "https://b.test/two";
  assert.deepEqual(linkParts(`${a} ${b}`), [a, b]);
});

test("something that only looks like a link is left in the words", () => {
  assert.deepEqual(linkParts("it said https:// and then nothing"), ["it said https:// and then nothing"]);
});

// ---------- what actually leaves ----------

test("the delivery layer sends two messages, the link first, whatever the model wrote", async () => {
  const router = new Router({});
  const ch = router.register(new FakeChannel({ number: "+15122164639" }));
  const deliver = makeDeliver({ router });

  const r = await deliver({
    conversationId: "dm:owner", channel: "fake", to: OWNER, fromOwner: true,
    text: `your shortlist is here ${PAGE} four picks, prices on each`,
  });

  assert.equal(r.ok, true);
  assert.equal(ch.sent.length, 2);
  assert.equal(ch.sent[0].text, PAGE, "the bare URL, with nothing around it");
  assert.equal(ch.sent[1].text, "your shortlist is here four picks, prices on each");
  assert.equal(r.parts.length, 2);
});

test("a reply with no link is still one send, and one outbox row", async () => {
  const router = new Router({});
  const ch = router.register(new FakeChannel({ number: "+15122164639" }));
  const deliver = makeDeliver({ router });

  await deliver({ conversationId: "dm:owner", channel: "fake", to: OWNER, fromOwner: true, text: "8 works" });
  assert.equal(ch.sent.length, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 1);
});

test("each part is its own outbox row, chained, so neither is lost and neither is doubled", async () => {
  const router = new Router({});
  router.register(new FakeChannel({ number: "+15122164639" }));
  const deliver = makeDeliver({ router });

  await deliver({
    conversationId: "dm:owner", channel: "fake", to: OWNER, fromOwner: true,
    text: `have a look ${PAGE}`,
  });

  const rows = db.db.prepare("SELECT id, body, state, after_id, idem_key FROM outbox ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].body, PAGE);
  assert.equal(rows[0].after_id, null);
  assert.equal(rows[1].after_id, rows[0].id, "the summary is chained behind the link");
  assert.equal(rows.every(r => r.state === "sent"), true);
  assert.notEqual(rows[0].idem_key, rows[1].idem_key, "two messages, two keys");
});

test("the pin goes on the link, once, not on both halves", async () => {
  const router = new Router({});
  router.register(new FakeChannel({ number: "+15122164639" }));
  const deliver = makeDeliver({ router });

  await deliver({
    conversationId: "dm:owner", channel: "fake", to: OWNER, fromOwner: true,
    text: `found it ${PAGE}`, replyTo: "handle-of-their-question",
  });
  const rows = db.db.prepare("SELECT body, reply_to FROM outbox ORDER BY id").all();
  assert.equal(rows[0].reply_to, "handle-of-their-question");
  assert.equal(rows[1].reply_to, null);
});

// ---------- order, through failure ----------

test("when the link cannot go yet, the summary does not go instead of it", async () => {
  const router = new Router({});
  const ch = router.register(new FakeChannel({ number: "+15122164639" }));
  // The first send is refused in a way that comes back later; everything after it works.
  let n = 0;
  ch.send = async ({ to, text }) => {
    n++;
    if (n === 1) return { ok: false, retryable: true, error: "Sendblue said 429: slow down" };
    ch.sent.push({ to, text });
    return { ok: true, delivered: { channel: "fake", to, message_id: `m-${n}` } };
  };
  const deliver = makeDeliver({ router, warn: () => {} });

  const r = await deliver({
    conversationId: "dm:owner", channel: "fake", to: OWNER, fromOwner: true,
    text: `your shortlist ${PAGE} four picks`,
  });

  assert.equal(r.ok, true, "not delivered yet, but not lost either");
  assert.equal(ch.sent.length, 0, "nothing arrived, and in particular not the summary");
  const rows = db.db.prepare("SELECT body, state FROM outbox ORDER BY id").all();
  assert.equal(rows[0].state, "queued");
  assert.equal(rows[1].state, "queued");

  // The summary is not even DUE until the link has gone.
  assert.deepEqual(db.dueOutbound(clock.now() + 60_000).map(x => x.body), [PAGE]);

  // The sweep, once the backoff has elapsed and the provider has calmed down: the link, and then
  // the summary behind it.
  clock.skip(60_000);
  const pass1 = await outbox.pass({ router });
  assert.equal(pass1.sent, 1);
  assert.deepEqual(ch.sent.map(s => s.text), [PAGE]);
  const pass2 = await outbox.pass({ router });
  assert.equal(pass2.sent, 1);
  assert.deepEqual(ch.sent.map(s => s.text), [PAGE, "your shortlist four picks"]);
});

test("a link that is never going takes its summary with it, rather than leaving a line about nothing", async () => {
  const router = new Router({});
  const ch = router.register(new FakeChannel({ number: "+15122164639" }));
  ch.send = async () => ({ ok: false, retryable: false, error: "Sendblue said 400: that number cannot receive messages" });
  const deliver = makeDeliver({ router, warn: () => {} });

  const r = await deliver({
    conversationId: "dm:owner", channel: "fake", to: OWNER, fromOwner: true,
    text: `your shortlist ${PAGE} four picks`,
  });

  assert.equal(r.ok, false);
  const rows = db.db.prepare("SELECT body, state, last_error FROM outbox ORDER BY id").all();
  assert.equal(rows[0].state, "failed");
  assert.equal(rows[1].state, "failed");
  assert.match(rows[1].last_error, /the message it goes with never arrived/);

  // And both are owed to the next turn, in the order they were meant to arrive.
  assert.deepEqual(db.undeliveredFor("dm:owner").map(x => x.body), [PAGE, "your shortlist four picks"]);
});

// ---------- and what the model is told about it ----------

test("the prompt tells the model how a link goes out, and forbids promising a card", () => {
  assert.match(SYSTEM, /A link you send goes out on its own/);
  assert.match(SYSTEM, /never promise a preview card/i);
  assert.match(SYSTEM, /the link below/);
});
