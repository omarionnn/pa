// A person who iMessages from an Apple ID email, not a phone number (REASON_EMAIL_HANDLES).
//
// Sendblue's receive webhook carries `number`/`from_number` = that email with service iMessage, and
// a reply goes back by passing the same email as `number` on /api/send-message (proved live
// 2026-11-11: DELIVERED, service iMessage). Until then such a person was dropped at the webhook —
// normalizeNumber() is phone-only on purpose — with nothing but {status:200, delivered:0} in the
// journal. Now the email IS their address: one account, the intro, replies, typing, all to it.
// Nothing rings an email: a call for such a person says it needs a phone number.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-email-handles-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TEST_NUMBERS = "";
process.env.REASON_AUTO_ADMIT = "1";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { config, clock, normalizeNumber, normalizeHandle, isEmailHandle, isOwnerNumber } = await import("../src/config.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { modelBannerLines, servesOnThisBackend } = await import("../src/backends/guard.js");
const accounts = await import("../src/accounts.js");
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.emailHandles = true;
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM blocked_numbers; DELETE FROM usage; DELETE FROM turned_away; DELETE FROM people; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM conversations; DELETE FROM outbox;");
  unconfigure();
});

const MAIL = "someone@icloud.com";
const LINE = "+15122164639";
const SECRET = "a-shared-webhook-secret";
const headers = () => ({ "sb-signing-secret": SECRET, "content-type": "application/json" });

function configure() {
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = SECRET;
  config.sendblueWebhookSecretHeader = "sb-signing-secret";
}
function unconfigure() {
  config.sendblueKeyId = ""; config.sendblueSecretKey = ""; config.sendblueFrom = ""; config.sendblueWebhookSecret = "";
}

/** The receive payload Sendblue sends for an Apple ID sender (fields seen live 2026-11-11). */
function fromMail({ handle = "H-mail-1", from = MAIL, content = "hey" } = {}) {
  return JSON.stringify({
    accountEmail: "your-account-email", content, is_outbound: false, status: "RECEIVED",
    error_code: null, error_message: null, message_handle: handle,
    date_sent: "2026-11-11T19:12:41.000Z", date_updated: "2026-11-11T19:12:41.000Z",
    from_number: from, number: from, to_number: LINE, was_downgraded: null, plan: "free",
    media_url: "", message_type: "message", group_id: "", participants: [from, LINE],
    send_style: "", opted_out: false, error_detail: null, sendblue_number: LINE, service: "iMessage",
  });
}

function harness() {
  const turns = [];
  const posts = [];
  const runtime = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return "ok"; },
  });
  const router = new Router({ runtime });
  const sendblue = router.register(new SendblueChannel({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "out-1", number: MAIL, service: "iMessage" }) };
    },
  }));
  router.register(new ConsoleChannel());
  return { runtime, router, sendblue, turns, posts };
}

// ---------- the normalizer ----------

test("normalizeHandle: a phone is what normalizeNumber says, an email is itself lowercased, the rest is nothing", () => {
  assert.equal(normalizeHandle("+1 (415) 555-9876"), "+14155559876");
  assert.equal(normalizeHandle("tel:+14155559876"), "+14155559876");
  assert.equal(normalizeHandle("  Someone@iCloud.com "), MAIL);
  assert.equal(normalizeHandle("12025551234@attacker.example"), "12025551234@attacker.example", "the digits inside an email are never a number");
  for (const bad of ["", "   ", "a@b", "two@@x.com", "a b@icloud.com", "sip:+12025551234@evil.example", "client:12025551234", "14155559876%40icloud.com", "14155559876＠icloud.com", "mailto:x@y.com", "@icloud.com", "x@"]) {
    assert.equal(normalizeHandle(bad), "", JSON.stringify(bad));
  }
  assert.equal(isEmailHandle(MAIL), true);
  assert.equal(isEmailHandle("+14155559876"), false);
  assert.equal(isEmailHandle("nonsense"), false);
});

test("normalizeNumber is unchanged: an email is not a number, and never the owner", () => {
  assert.equal(normalizeNumber(MAIL), "");
  assert.equal(normalizeNumber("12025551234@attacker.example"), "");
  assert.equal(isOwnerNumber("12025551234@attacker.example"), false);
});

test("with REASON_EMAIL_HANDLES off an email normalizes to nothing", () => {
  config.emailHandles = false;
  assert.equal(normalizeHandle(MAIL), "");
  assert.equal(isEmailHandle(MAIL), false);
  assert.equal(normalizeHandle("+14155559876"), "+14155559876", "phones are untouched by the flag");
});

// ---------- the webhook ----------

test("an iMessage from an Apple ID parses with the email as the sender", async () => {
  configure();
  try {
    const out = await new SendblueChannel().receive({ rawBody: fromMail({ from: "Someone@iCloud.com" }), headers: headers() });
    assert.equal(out.status, 200);
    assert.equal(out.body.ignored, undefined);
    assert.equal(out.inbound.length, 1);
    assert.equal(out.inbound[0].from, MAIL, "lowercased, so one Apple ID is one person");
    assert.equal(out.inbound[0].externalId, "H-mail-1");
    assert.equal(out.inbound[0].text, "hey");
  } finally { unconfigure(); }
});

test("with the flag off the same message is dropped, with the reason on the answer", async () => {
  configure();
  config.emailHandles = false;
  try {
    const out = await new SendblueChannel().receive({ rawBody: fromMail(), headers: headers() });
    assert.equal(out.status, 200);
    assert.deepEqual(out.inbound, []);
    assert.match(out.body.ignored, /email address/);
    assert.match(out.body.ignored, /REASON_EMAIL_HANDLES/);
    assert.equal(out.body.from, MAIL);
  } finally { unconfigure(); }
});

test("an Apple ID email with the operator's digits is still not the operator", async () => {
  configure();
  try {
    const h = "12025551234@attacker.example";
    const out = await new SendblueChannel().receive({ rawBody: fromMail({ from: h }), headers: headers() });
    assert.equal(out.inbound[0].from, h);
    assert.equal(accounts.isOperatorAddress(h), false);
    assert.notEqual(accounts.conversationIdFor({ channel: "sendblue", address: h }), config.ownerConversation);
  } finally { unconfigure(); }
});

// ---------- the account ----------

test("the email round-trips to one account however it is capitalised, and the turn runs", async () => {
  configure();
  try {
    const { router, turns } = harness();
    const first = await router.webhook({ channel: "sendblue", rawBody: fromMail({ handle: "H-1", from: "Someone@iCloud.com", content: "hey" }), headers: headers() });
    assert.equal(first.status, 200);
    assert.equal(first.body.delivered, 1);
    assert.equal(first.results[0].ok, true, "auto-admit lets a new person in");
    assert.equal(first.results[0].replied, true);
    const convo = first.results[0].conversationId;
    assert.equal(convo, `dm:sendblue:${MAIL}`);
    assert.equal(turns.length, 1, "a real turn ran for them");
    assert.equal(turns[0].conversationId, convo);

    const again = await router.webhook({ channel: "sendblue", rawBody: fromMail({ handle: "H-2", from: "SOMEONE@ICLOUD.COM", content: "still me" }), headers: headers() });
    assert.equal(again.results[0].conversationId, convo, "a different capitalisation is the same person");
        assert.equal(db.listAccountsOfPeople().filter(a => a.address === MAIL).length, 1);
    assert.equal(accounts.accountState("sendblue", "Someone@icloud.com"), "active");
    assert.equal(servesOnThisBackend(MAIL).serves, true);
  } finally { unconfigure(); }
});

test("that account's address is the email, so a reply is addressed to it", async () => {
  configure();
  try {
    const { router } = harness();
    const out = await router.webhook({ channel: "sendblue", rawBody: fromMail(), headers: headers() });
    const me = accounts.ownerOf(out.results[0].conversationId);
    assert.equal(me.address, MAIL);
    assert.equal(me.channel, "sendblue");
  } finally { unconfigure(); }
});

// ---------- sending ----------

test("a text to an email handle goes to Sendblue with the email as `number`", async () => {
  configure();
  try {
    const { sendblue, posts } = harness();
    const out = await sendblue.send({ to: "Someone@iCloud.com", text: "hi there", idempotencyKey: "k-mail" });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.delivered.to, MAIL);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://api.sendblue.com/api/send-message");
    assert.equal(posts[0].body.number, MAIL);
    assert.equal(posts[0].body.from_number, LINE);
    assert.equal(posts[0].body.content, "hi there");
  } finally { unconfigure(); }
});

test("typing, mark-read, media and carousel take an email handle too", async () => {
  configure();
  try {
    const { sendblue, posts } = harness();
    const typing = await sendblue.typing({ to: MAIL, on: true });
    assert.equal(typing.ok, true, typing.error);
    const read = await sendblue.markRead({ to: MAIL });
    assert.equal(read.ok, true, read.error);
    const media = await sendblue.sendMediaUrl({ to: MAIL, mediaUrl: "https://files.example/a.png" });
    assert.equal(media.ok, true, media.error);
    const carousel = await sendblue.sendCarousel({ to: MAIL, mediaUrls: ["https://files.example/a.png", "https://files.example/b.png"] });
    assert.equal(carousel.ok, true, carousel.error);
    for (const p of posts) assert.equal(p.body.number, MAIL, p.url);
  } finally { unconfigure(); }
});

test("with the flag off a send to an email is refused, not thrown, and says what it needs", async () => {
  configure();
  config.emailHandles = false;
  try {
    const { sendblue, posts } = harness();
    const out = await sendblue.send({ to: MAIL, text: "hi" });
    assert.equal(out.ok, false);
    assert.equal(out.retryable, false);
    assert.match(out.error, /E\.164/);
    assert.equal(posts.length, 0);
  } finally { unconfigure(); }
});

test("a 4xx from Sendblue on a typing indicator to an email is a quiet no, never a throw", async () => {
  configure();
  try {
    const ch = new SendblueChannel({ fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ status: "ERROR", message: "unsupported" }) }) });
    const typing = await ch.typing({ to: MAIL, on: true });
    assert.equal(typing.ok, false);
    assert.equal(typing.supported, true);
  } finally { unconfigure(); }
});

// ---------- the journal and /ops ----------

test("a dropped delivery is counted by its reason, by channel, never by who", () => {
  const before = ops.droppedInbound()["sendblue: sender is an email address, not a phone number (REASON_EMAIL_HANDLES is off)"] ?? 0;
  ops.noteDroppedInbound("sendblue", "sender is an email address, not a phone number (REASON_EMAIL_HANDLES is off)");
  ops.noteDroppedInbound("sendblue", "sender is an email address, not a phone number (REASON_EMAIL_HANDLES is off)");
  const after = ops.alive().dropped_inbound;
  assert.equal(after["sendblue: sender is an email address, not a phone number (REASON_EMAIL_HANDLES is off)"], before + 2);
  assert.equal(JSON.stringify(after).includes("@"), false);
});

// ---------- the banner ----------

test("the startup banner does not promise a restriction that auto-admit makes inert", () => {
  const restricted = modelBannerLines({ ownerName: "Omari", testNumbers: ["+12025551234"], autoAdmit: false }).join("\n");
  assert.match(restricted, /ONLY these numbers get answers: \+12025551234/);
  assert.match(restricted, /Every other number gets one "not available yet" line/);

  const open = modelBannerLines({ ownerName: "Omari", testNumbers: ["+12025551234"], autoAdmit: true }).join("\n");
  assert.doesNotMatch(open, /ONLY these numbers/);
  assert.match(open, /REASON_AUTO_ADMIT=1: EVERYBODY who texts is admitted/);
  assert.match(open, /restricts nothing/);
  assert.match(open, /Anthropic API key with credit/);
});
