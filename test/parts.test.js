// Parts of one message are one message.
//
// Every fixture in here is the shape of ONE real failure, from Omari's own phone at 1:35 AM on
// 2026-10-05. He sent "Can you find me a good deal on this type of doc martens:" and, a second
// later, pasted a drmartens.com link; iMessage rendered it as one bubble with a rich link card.
// Sendblue delivered three `receive` webhooks ten seconds apart — the text and the link, then
// `_1` and `_2` carrying the card's preview images with empty content — and Reason answered all
// three, telling him twice that files had "come through blank".
//
// The handles are the real ones. Nothing in here goes anywhere near a network or a model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-parts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not a burst test: the quiet window an arriving message waits in is off, so a webhook runs its
// turn the moment it lands. test/burst.test.js is where the window itself is proven.
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel, splitHandle, attachmentOf } = await import("../src/channels/sendblue.js");
const { urlsIn } = await import("../src/parts.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
// Usage is counted against the operator's day, not UTC's (accounts.today); asking for the UTC
// date finds no row at all every evening in New York, and 0 === 0 proves nothing.
const { today } = await import("../src/accounts.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const SECRET = "a-shared-webhook-secret";
/** The real handle stem from that message, and the link he pasted. */
const STEM = "E32ECEF5-7B41-4C2A-9D18-5A6F0B2E3C77";
const LINK = "https://www.drmartens.com/us/en/p/1460-smooth-leather-lace-up-boots";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM conversations; DELETE FROM usage;");
  unconfigure();
});

function configure() {
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = SECRET;
  config.sendblueWebhookSecretHeader = "sb-signing-secret";
}
function unconfigure() {
  config.sendblueKeyId = "";
  config.sendblueSecretKey = "";
  config.sendblueFrom = "";
  config.sendblueWebhookSecret = "";
}

const headers = () => ({ "sb-signing-secret": SECRET, "content-type": "application/json" });

/** The documented inbound body, with only the fields a part test is about varied. */
function inbound({ handle = STEM, from = OWNER, content = "", mediaUrl = "", at = "2026-10-05T05:35:00.000Z" } = {}) {
  return JSON.stringify({
    accountEmail: "your-account-email",
    content,
    is_outbound: false,
    status: "RECEIVED",
    error_code: null, error_message: null, error_reason: null,
    message_handle: handle,
    date_sent: at, date_updated: at,
    from_number: from, number: from, to_number: LINE,
    was_downgraded: null, plan: "free",
    media_url: mediaUrl,
    message_type: "message",
    group_id: "",
    participants: [from, LINE],
    send_style: "", opted_out: false, error_detail: null,
    sendblue_number: LINE, service: "iMessage", group_display_name: null,
  });
}

/** A router whose turns are recorded instead of being sent to a model. */
function harness() {
  const turns = [];
  const runtime = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return "ok"; },
  });
  const router = new Router({ runtime });
  router.register(new SendblueChannel({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "out-1" }) }),
  }));
  router.register(new ConsoleChannel());
  return { router, turns };
}

// ---------- reading a handle ----------

test("a handle ending _N is part N of the message whose handle is the stem", () => {
  assert.deepEqual(splitHandle(STEM), { base: STEM, partIndex: 0 });
  assert.deepEqual(splitHandle(`${STEM}_1`), { base: STEM, partIndex: 1 });
  assert.deepEqual(splitHandle(`${STEM}_2`), { base: STEM, partIndex: 2 });
  assert.deepEqual(splitHandle(`${STEM}_12`), { base: STEM, partIndex: 12 });
  // Greedy, so a stem that itself ends in _1 keeps it and only the last suffix is the part.
  assert.deepEqual(splitHandle(`${STEM}_1_2`), { base: `${STEM}_1`, partIndex: 2 });
  // Not a part suffix: a trailing word, a bare handle, nothing at all.
  assert.deepEqual(splitHandle(`${STEM}_x`), { base: `${STEM}_x`, partIndex: 0 });
  assert.deepEqual(splitHandle(""), { base: "", partIndex: 0 });
});

test("an attachment is named by the only clue the payload carries, its extension", () => {
  assert.equal(attachmentOf(""), null, "no media_url is no attachment");
  assert.equal(attachmentOf("https://cdn/x/IMG_4021.HEIC").kind, "image", "what an iPhone shoots by default");
  assert.equal(attachmentOf("https://cdn/x/preview.jpg?sig=abc").kind, "image");
  assert.equal(attachmentOf("https://cdn/x/preview.jpg?sig=abc").filename, "preview.jpg", "the query string is not part of the name");
  assert.equal(attachmentOf("https://cdn/x/AudioMessage.caf").kind, "voice");
  assert.equal(attachmentOf("https://cdn/x/demo.m4a").kind, "audio");
  assert.equal(attachmentOf("https://cdn/x/lease.pdf").kind, "file");
  // No extension to go on, so it is a file and not a guess.
  assert.equal(attachmentOf("https://cdn/x/9f3a1b").kind, "file");
});

test("the normalised inbound says which message this is and which part of it", async () => {
  configure();
  try {
    const ch = new SendblueChannel();
    const whole = (await ch.receive({ rawBody: inbound({ content: "hey" }), headers: headers() })).inbound[0];
    assert.equal(whole.externalId, STEM, "the full handle is still the dedupe key");
    assert.equal(whole.baseHandle, STEM);
    assert.equal(whole.partIndex, 0);
    assert.equal(whole.said, "hey", "their words, with nothing added");
    assert.deepEqual(whole.attachments, []);

    const part = (await ch.receive({
      rawBody: inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "https://cdn/x/preview.jpg" }),
      headers: headers(),
    })).inbound[0];
    assert.equal(part.externalId, `${STEM}_1`, "each part is its own at-least-once delivery");
    assert.equal(part.baseHandle, STEM, "and all of them point at one message");
    assert.equal(part.partIndex, 1);
    assert.equal(part.said, "");
    assert.deepEqual(part.attachments, [{ url: "https://cdn/x/preview.jpg", filename: "preview.jpg", kind: "image" }]);
  } finally { unconfigure(); }
});

test("every URL in a line of text is found, and a line with none is none", () => {
  assert.deepEqual(urlsIn(`Can you find me a good deal on this type of doc martens: ${LINK}`), [LINK]);
  assert.deepEqual(urlsIn("dinner friday?"), []);
  assert.deepEqual(urlsIn(""), []);
  assert.deepEqual(urlsIn("http://a.com and https://b.com"), ["http://a.com", "https://b.com"]);
  // A trailing bracket or quote is punctuation around the link, not part of it.
  assert.deepEqual(urlsIn("(https://a.com/x)"), ["https://a.com/x"]);
});

// ---------- the 1:35 AM failure, end to end ----------

test("the pasted link that arrived as three webhooks is ONE turn, not three", async () => {
  configure();
  try {
    const { router, turns } = harness();

    // The message: his words and the link he pasted.
    const first = await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ content: `Can you find me a good deal on this type of doc martens: ${LINK}` }),
    });
    // Ten seconds later, twice: the link card's preview images, with no words on them.
    clock.skip(10_000);
    const p1 = await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "https://cdn/x/E32ECEF5_preview_0.jpg" }),
    });
    clock.skip(10_000);
    const p2 = await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_2`, content: "", mediaUrl: "https://cdn/x/E32ECEF5_preview_1.png" }),
    });

    assert.equal(turns.length, 1, "one message, one turn");
    assert.match(turns[0].text, /doc martens/);
    assert.match(turns[0].text, /drmartens\.com/, "and the link is in it");
    assert.equal(/blank/i.test(turns[0].text), false);

    // Every webhook still gets a 2xx, so Sendblue stops retrying.
    for (const r of [first, p1, p2]) assert.equal(r.status, 200);
    // And the two previews say, on the record, why they were not messages.
    assert.match(p1.results[0].dropped, /link preview/);
    assert.match(p1.results[0].dropped, /drmartens\.com/);
    assert.match(p2.results[0].dropped, /link preview/);
    assert.equal(p1.results[0].replied, false);
  } finally { unconfigure(); }
});

test("a dropped preview costs nothing: no turn, and nothing off the day's allowance", async () => {
  configure();
  try {
    const { router, turns } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: `look ${LINK}` }) });
    const used = db.usageToday(config.ownerConversation, today());
    assert.equal(used?.turns, 1, "the message with the link in it was one turn");

    await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, mediaUrl: "https://cdn/x/preview.jpg" }),
    });
    const after = db.usageToday(config.ownerConversation, today());

    assert.equal(turns.length, 1);
    assert.equal(after?.turns ?? 0, used?.turns ?? 0, "a fragment of a message is not a message somebody sent");
  } finally { unconfigure(); }
});

test("the tapback target is the message, not the last part of it to land", async () => {
  configure();
  try {
    const { router } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: `look at these ${LINK}` }) });
    assert.equal(db.getThread(config.ownerConversation)?.last_inbound_id, STEM, "the message's own handle");

    // The two previews land after it and are dropped — but they still touch the thread row on the
    // way past, and a tapback aimed at `_2` is the 422 api-v2/reactions documents for an
    // attachment-specific handle. Every tapback on a pasted link would have failed.
    clock.skip(10_000);
    await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "https://cdn/x/preview_0.jpg" }),
    });
    clock.skip(10_000);
    await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_2`, content: "", mediaUrl: "https://cdn/x/preview_1.png" }),
    });

    assert.equal(
      db.getThread(config.ownerConversation)?.last_inbound_id, STEM,
      "still the primary handle after both parts, because that is the one a reaction can go on",
    );
  } finally { unconfigure(); }
});

test("a part with no words and no file at all is not a message", async () => {
  configure();
  try {
    const { router, turns } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: "u up" }) });
    const empty = await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "" }),
    });
    assert.equal(turns.length, 1);
    assert.match(empty.results[0].dropped, /no words and no file/);
  } finally { unconfigure(); }
});

// ---------- and the opposite mistake ----------

test("a photo sent with a caption that has no link in it is a photo, and gets answered", async () => {
  configure();
  try {
    const { router, turns } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: "what do you think of these" }) });
    const photo = await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "https://cdn/x/IMG_4021.jpg" }),
    });
    assert.equal(photo.results[0].dropped, undefined, "nothing was dropped");
    assert.equal(turns.length, 2, "the picture is its own thing to answer");
  } finally { unconfigure(); }
});

test("a part that carries words is always a message, even alongside a link", async () => {
  configure();
  try {
    const { router, turns } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: `these ${LINK}` }) });
    await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, content: "in black tho", mediaUrl: "https://cdn/x/preview.jpg" }),
    });
    assert.equal(turns.length, 2);
    assert.match(turns[1].text, /in black tho/);
  } finally { unconfigure(); }
});

test("a PDF or a voice note attached to a message with a link in it is never a preview", async () => {
  configure();
  try {
    const { router, turns } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: `sign this ${LINK}` }) });
    const pdf = await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "https://cdn/x/lease.pdf" }),
    });
    assert.equal(pdf.results[0].dropped, undefined);
    assert.equal(turns.length, 2);
    assert.match(turns[1].text, /lease\.pdf/, "and Reason is told what it is");
  } finally { unconfigure(); }
});

test("a preview whose message was never seen is treated as a real file, not eaten", async () => {
  configure();
  try {
    // What a restart between parts looks like: `_1` arrives with nothing on record to read it
    // against. Answering about a photo nobody sent is a smaller failure than losing one.
    const { router, turns } = harness();
    const orphan = await router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "https://cdn/x/preview.jpg" }),
    });
    assert.equal(orphan.results[0].dropped, undefined);
    assert.equal(turns.length, 1);
  } finally { unconfigure(); }
});

test("the parts of a message survive a restart, because they are rows", async () => {
  configure();
  try {
    const { router } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: `look ${LINK}` }) });

    // Nothing in memory is consulted: this is the same read the next process would do.
    const base = db.getInboundPart({ channel: "sendblue", baseHandle: STEM, partIndex: 0 });
    assert.deepEqual(base.urls, [LINK]);
    assert.equal(base.text, `look ${LINK}`, "his words, as he typed them");

    const fresh = harness();
    const preview = await fresh.router.webhook({
      channel: "sendblue", headers: headers(),
      rawBody: inbound({ handle: `${STEM}_1`, mediaUrl: "https://cdn/x/preview.jpg" }),
    });
    assert.match(preview.results[0].dropped, /link preview/);
    assert.equal(fresh.turns.length, 0);
  } finally { unconfigure(); }
});

test("Sendblue redelivering a part is still one event, and the table does not grow", async () => {
  configure();
  try {
    const { router, turns } = harness();
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: inbound({ content: "what about these" }) });
    const body = inbound({ handle: `${STEM}_1`, content: "", mediaUrl: "https://cdn/x/IMG_1.jpg" });

    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body });
    const again = await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body });

    assert.equal(again.results[0].duplicate, true);
    assert.equal(turns.length, 2, "the photo got one turn, the retry got none");
    assert.equal(db.inboundPartsOf({ channel: "sendblue", baseHandle: STEM }).length, 2, "two parts, however many deliveries");
  } finally { unconfigure(); }
});
