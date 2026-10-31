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
const { outgoingTexts } = await import("../src/plain.js");
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

// 2026-10-31, the owner's phone: the Walmart sign-in link landed at 13:59:43 and the sentence saying
// what it was at 13:59:44. The words go first, then the bare link, always.
test("the words about a link leave first, and the link follows as its own message", () => {
  assert.deepEqual(
    linkParts(`made you a page with the shortlist ${PAGE} have a look`),
    ["made you a page with the shortlist", PAGE, "have a look"],
  );
  assert.deepEqual(linkParts(`${PAGE} that's the itinerary`), [PAGE, "that's the itinerary"], "nothing before it: the link, then what was written after");
  assert.deepEqual(linkParts(PAGE), [PAGE], "a link and nothing else is already its own message");
  assert.deepEqual(linkParts(`here it is ${PAGE}`), ["here it is", PAGE]);
  assert.deepEqual(
    linkParts("Walmart needs you signed in before it lets anyone check out. Sign in once here and I'll use it for Walmart orders from now on. Your password goes straight to Walmart, not to me.\nhttps://heyreason.test/web/connect/abc"),
    ["Walmart needs you signed in before it lets anyone check out. Sign in once here and I'll use it for Walmart orders from now on. Your password goes straight to Walmart, not to me.", "https://heyreason.test/web/connect/abc"],
    "the 13:59 sign-in text: explanation, then the link",
  );
});

// 2026-10-06, Omari's own thread: the connect notice ends "Privacy policy: <link>". Words that end on
// a colon were the one case that already went words-first; they still do.
test("words that end on a colon stay above the link they point at", () => {
  assert.deepEqual(linkParts(`Privacy policy: ${PAGE}`), ["Privacy policy:", PAGE]);
  assert.deepEqual(
    linkParts(`here's the page: ${PAGE} have a look`),
    ["here's the page:", PAGE, "have a look"],
    "and what comes after the last link follows it",
  );
  // The exchange as it was written: each link under its own line.
  const google = "https://accounts.google.test/o/oauth2/v2/auth?scope=drive";
  assert.deepEqual(
    linkParts(`this link adds drive to 25. ${google}\n\nit runs out in 15 min.\n\nnever sells or shares it. Privacy policy: ${PAGE}`),
    ["this link adds drive to 25.", google, "it runs out in 15 min.\n\nnever sells or shares it. Privacy policy:", PAGE],
  );
});

test("a full stop at the end of a sentence is not part of the address", () => {
  assert.deepEqual(linkParts(`here it is ${PAGE}.`), ["here it is", PAGE]);
  assert.deepEqual(linkParts(`here it is ${PAGE}!`), ["here it is", PAGE]);
  // A path that really ends in a dot is vanishingly rare and a trailing dot breaks the tap, which
  // is the failure worth avoiding.
  assert.deepEqual(linkParts(`see ${PAGE}, it has prices`), ["see", PAGE, "it has prices"]);
});

test("several links keep their own words, and never each other's", () => {
  const a = "https://a.test/one";
  const b = "https://b.test/two";
  assert.deepEqual(
    linkParts(`the cheap one ${a} and the good one ${b} i'd take the second`),
    ["the cheap one", a, "and the good one", b, "i'd take the second"],
  );
});

test("a link with nothing written about it is just the link", () => {
  const a = "https://a.test/one";
  const b = "https://b.test/two";
  assert.deepEqual(linkParts(`${a} ${b}`), [a, b]);
});

// ---------- the paragraphs around a link ----------

test("the words about a link keep the paragraphs they were written in", () => {
  // The bug Omari caught on his phone on 2026-10-05: the message that goes with a page is the
  // longest one Reason routinely sends, and this function was flattening it into one slab. Four
  // goes at fixing it in the prompt failed, because the model had been writing it correctly and
  // the flattening happened here.
  const words = "made you a back guide to keep. two sessions a week.\n\n"
    + "to progress, add the smallest jump you can. log every session.\n\n"
    + "the page has every exercise with its reps.";
  const link = "https://reason.test/p/abc123";
  assert.deepEqual(linkParts(`${words}\n\n${link}`), [words, link], "byte for byte, blank lines and all");
});

test("a link in the middle of a sentence: the words before it, the link, the words after it", () => {
  // Three messages, in the order written: neither half is glued to the other across the link.
  assert.deepEqual(
    linkParts("grab it at https://x.test/a before friday"),
    ["grab it at", "https://x.test/a", "before friday"],
  );
});

test("a link on its own line separates two blocks, and they stay two blocks", () => {
  assert.deepEqual(
    linkParts("here's the shortlist\n\nhttps://x.test/a\n\nthe second one is cheaper"),
    ["here's the shortlist", "https://x.test/a", "the second one is cheaper"],
  );
});

test("spacing is tidied without the structure being lost", () => {
  // Stray trailing spaces and a run of blank lines are noise; one blank line is meaning.
  assert.deepEqual(
    linkParts("first para   \n   \n\n\n   second para\n\nhttps://x.test/a"),
    ["first para\n\nsecond para", "https://x.test/a"],
  );
});

test("a list under a link keeps its dashes and its lines", () => {
  // The leading-punctuation trim must not eat the first bullet of a list.
  assert.deepEqual(
    linkParts("https://x.test/a\n\n- eggs\n- milk\n- bread"),
    ["https://x.test/a", "- eggs\n- milk\n- bread"],
  );
});

test("numbered steps under a link survive the split and keep their spacing", () => {
  const parts = outgoingTexts("here's how\n\n1. unplug it\n\n2. plug it back in\n\nhttps://x.test/a");
  assert.equal(parts[0], "here's how\n\n1. unplug it\n\n2. plug it back in");
  assert.equal(parts[1], "https://x.test/a");
});

test("something that only looks like a link is left in the words", () => {
  assert.deepEqual(linkParts("it said https:// and then nothing"), ["it said https:// and then nothing"]);
});

// ---------- what actually leaves ----------

test("the delivery layer sends the words, then the bare link, then what came after, whatever the model wrote", async () => {
  const router = new Router({});
  const ch = router.register(new FakeChannel({ number: "+15122164639" }));
  const deliver = makeDeliver({ router });

  const r = await deliver({
    conversationId: "dm:owner", channel: "fake", to: OWNER, fromOwner: true,
    text: `your shortlist is here ${PAGE} four picks, prices on each`,
  });

  assert.equal(r.ok, true);
  assert.equal(ch.sent.length, 3);
  assert.equal(ch.sent[0].text, "your shortlist is here");
  assert.equal(ch.sent[1].text, PAGE, "the bare URL, with nothing around it");
  assert.equal(ch.sent[2].text, "four picks, prices on each");
  assert.equal(r.parts.length, 3);
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
  assert.equal(rows[0].body, "have a look");
  assert.equal(rows[1].body, PAGE);
  assert.equal(rows[0].after_id, null);
  assert.equal(rows[1].after_id, rows[0].id, "the link is chained behind its words");
  assert.equal(rows.every(r => r.state === "sent"), true);
  assert.notEqual(rows[0].idem_key, rows[1].idem_key, "two messages, two keys");
});

test("the pin goes on the first part, once, not on both halves", async () => {
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
  assert.equal(ch.sent.length, 0, "nothing arrived, and in particular not the link ahead of its words");
  const rows = db.db.prepare("SELECT body, state FROM outbox ORDER BY id").all();
  assert.equal(rows[0].state, "queued");
  assert.equal(rows[1].state, "queued");
  assert.equal(rows[2].state, "queued");

  // The link is not even DUE until its words have gone.
  assert.deepEqual(db.dueOutbound(clock.now() + 60_000).map(x => x.body), ["your shortlist"]);

  // The sweep, once the backoff has elapsed and the provider has calmed down: the words, the link
  // behind them, the rest behind that.
  clock.skip(60_000);
  const pass1 = await outbox.pass({ router });
  assert.equal(pass1.sent, 1);
  assert.deepEqual(ch.sent.map(s => s.text), ["your shortlist"]);
  const pass2 = await outbox.pass({ router });
  assert.equal(pass2.sent, 1);
  assert.deepEqual(ch.sent.map(s => s.text), ["your shortlist", PAGE]);
  const pass3 = await outbox.pass({ router });
  assert.equal(pass3.sent, 1);
  assert.deepEqual(ch.sent.map(s => s.text), ["your shortlist", PAGE, "four picks"]);
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
  assert.equal(rows[2].state, "failed");
  assert.match(rows[1].last_error, /the message it goes with never arrived/);

  // And all of it is owed to the next turn, in the order it was meant to arrive.
  assert.deepEqual(db.undeliveredFor("dm:owner").map(x => x.body), ["your shortlist", PAGE, "four picks"]);
});

// ---------- and what the model is told about it ----------

test("the prompt tells the model how a link goes out, and forbids promising a card", () => {
  assert.match(SYSTEM, /A link you send goes out on its own/);
  assert.match(SYSTEM, /never promise a preview card/i);
  assert.match(SYSTEM, /the link below/);
});
