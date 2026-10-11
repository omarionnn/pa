// The Sendblue channel, offline.
//
// Every fixture in here is built from the example payloads in Sendblue's own docs (read
// 2026-10-04): the inbound body from getting-started/receiving-messages, the outbound status body
// from getting-started/sending-messages, the typing payload from api-v2/typing-indicators, the
// upload response from api-v2/media, and the decline shape (HTTP 400, status DECLINED, error_key,
// error_code) from limits#before-the-first-reply.
//
// No request in here goes anywhere. There are no Sendblue credentials on this machine and the
// adapter's `fetch` is injected, so a test that passes proves the SHAPE is right — not that the
// real API accepts it. See docs/unverified.md.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-sendblue-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not a burst test: the quiet window an arriving message waits in is off, so a webhook runs its
// turn the moment it lands. test/burst.test.js is where the window itself is proven.
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
// A bare install: no Sendblue credentials at all, which is what not_connected has to look like.
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel, PLAN_LIMITS, TYPING_DEFAULT_MS, canRetry } = await import("../src/channels/sendblue.js");
const { subscriptionBackendBlock } = await import("../src/backends/guard.js");
const { capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const STRANGER = "+14155559876";
const LINE = "+15122164639";
const SECRET = "a-shared-webhook-secret";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM blocked_numbers; DELETE FROM usage; DELETE FROM turned_away; DELETE FROM plans; DELETE FROM people; DELETE FROM person_facts; DELETE FROM connected_accounts; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM conversations; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM tasks; DELETE FROM task_log;");
  unconfigure();
});

/** Credentials, for the tests that need the channel live. Always undone in `finally`. */
function configure({ secret = SECRET } = {}) {
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = secret;
  config.sendblueWebhookSecretHeader = "sb-signing-secret";
}
function unconfigure() {
  config.sendblueKeyId = "";
  config.sendblueSecretKey = "";
  config.sendblueFrom = "";
  config.sendblueWebhookSecret = "";
  config.sendblueWebhookSecretHeader = "sb-signing-secret";
}

/** A router whose turns are recorded instead of being sent to a model. */
function harness() {
  const turns = [];
  const runtime = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return "ok"; },
  });
  const router = new Router({ runtime });
  const sendblue = router.register(new SendblueChannel({
    // Nothing in a routing test should reach a network: an outbound line (the turned-away note,
    // the master being asked) is recorded, not sent.
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "out-1" }) }),
  }));
  router.register(new ConsoleChannel());
  return { runtime, router, sendblue, turns };
}

const headers = (secret = SECRET) => ({ "sb-signing-secret": secret, "content-type": "application/json" });

/**
 * The inbound receive payload, exactly the fields Sendblue documents, with the example's own
 * values where they are not what the test is about.
 */
function inbound({ handle = "99DCC379-DD76-4712-BA65-11EFB33B8CD6", from = STRANGER, content = "Hello!", groupId = "", mediaUrl = "", at = "2025-12-12T15:41:20.932Z" } = {}) {
  return JSON.stringify({
    accountEmail: "your-account-email",
    content,
    is_outbound: false,
    status: "RECEIVED",
    error_code: null, error_message: null, error_reason: null,
    message_handle: handle,
    date_sent: at,
    date_updated: at,
    from_number: from,
    number: from,
    to_number: LINE,
    was_downgraded: null,
    plan: "free",
    media_url: mediaUrl,
    message_type: "message",
    group_id: groupId,
    participants: [from, LINE],
    send_style: "",
    opted_out: false,
    error_detail: null,
    sendblue_number: LINE,
    service: "iMessage",
    group_display_name: groupId ? "the group" : null,
  });
}

// ---------- not connected ----------

test("with no credentials Sendblue is not_connected and names every missing variable", () => {
  const st = new SendblueChannel().status();
  assert.equal(st.status, "not_connected");
  assert.deepEqual(st.missing, [
    "SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET_KEY", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET",
  ]);
  assert.equal(st.configured, false, "nothing in .env means nobody is on their way to letting others text it");
  assert.equal(st.number, null);
});

test("a key without a line is still not_connected, because every send needs from_number", () => {
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  try {
    const st = new SendblueChannel().status();
    assert.equal(st.status, "not_connected");
    assert.deepEqual(st.missing, ["SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"]);
    assert.equal(st.configured, true, "a key in .env counts as configured for the subscription guard");
  } finally { unconfigure(); }
});

test("not connected refuses to send rather than throwing, and says what is missing", async () => {
  const out = await new SendblueChannel().send({ to: STRANGER, text: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
  assert.match(out.error, /SENDBLUE_API_KEY_ID/);
  assert.match(out.error, /SENDBLUE_FROM_NUMBER/);

  const media = await new SendblueChannel().sendMedia({ to: STRANGER, text: "hi", file: "/tmp/x.wav", mimeType: "audio/wav" });
  assert.equal(media.ok, false);
  assert.equal(media.supported, true, "attachments ARE supported — there are just no credentials");

  const typing = await new SendblueChannel().typing({ to: STRANGER, on: true });
  assert.deepEqual(typing, { ok: true, supported: false }, "no typing indicator is never an error");
});

test("with Sendblue the only texting channel and no keys, capabilities says so by name", () => {
  const router = new Router({});
  router.register(new ConsoleChannel());
  router.register(new SendblueChannel());
  const texting = capabilitiesNow({ channels: router }).find(c => c.name === "message_people");
  assert.equal(texting.status, "not connected");
  assert.match(texting.what, /SENDBLUE_API_KEY_ID/);
  assert.match(texting.what, /do not offer to text anyone/i);
});

test("with Sendblue live, capabilities names it and the gate — a Sendblue-only install reads like the Linq one did", () => {
  configure();
  try {
    const router = new Router({});
    router.register(new ConsoleChannel());
    router.register(new SendblueChannel());
    const texting = capabilitiesNow({ channels: router }).find(c => c.name === "message_people");
    assert.equal(texting.status, "live");
    assert.match(texting.what, /sendblue/);
    assert.match(texting.what, new RegExp(LINE.replace("+", "\\+")), "and the number it texts from");
    assert.match(texting.what, /needs an explicit yes/i);
  } finally { unconfigure(); }
});

// ---------- the webhook ----------

test("an inbound DM is one turn, in that person's own Reason", async () => {
  configure();
  try {
    const { router, turns } = harness();
    db.upsertAccount({ conversationId: `dm:sendblue:${STRANGER}`, channel: "sendblue", address: STRANGER, name: "", isOperator: false });

    const out = await router.webhook({ channel: "sendblue", rawBody: inbound({ content: "you up?" }), headers: headers() });
    assert.equal(out.status, 200);
    assert.equal(out.body.delivered, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "you up?", "their words arrive as their words");
    assert.equal(turns[0].conversationId, `dm:sendblue:${STRANGER}`);
  } finally { unconfigure(); }
});

test("the owner's own number lands in the owner's conversation", async () => {
  configure();
  try {
    const { router, turns } = harness();
    const out = await router.webhook({ channel: "sendblue", rawBody: inbound({ from: OWNER, content: "dinner friday?" }), headers: headers() });
    assert.equal(out.results[0].conversationId, config.ownerConversation);
    assert.equal(turns[0].text, "dinner friday?");
  } finally { unconfigure(); }
});

test("a message_handle Sendblue delivers twice is one turn — their delivery is at-least-once", async () => {
  configure();
  try {
    const { router, turns } = harness();
    db.upsertAccount({ conversationId: `dm:sendblue:${STRANGER}`, channel: "sendblue", address: STRANGER, name: "", isOperator: false });
    const body = inbound({ handle: "SAME-HANDLE-1" });

    const first = await router.webhook({ channel: "sendblue", rawBody: body, headers: headers() });
    const retry = await router.webhook({ channel: "sendblue", rawBody: body, headers: headers() });

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200, "a retry still gets a 2xx so Sendblue stops retrying");
    assert.equal(retry.results[0].duplicate, true);
    assert.equal(turns.length, 1, "but it costs no second turn");
  } finally { unconfigure(); }
});

test("a wrong secret, a missing secret header, and no configured secret are all refused", async () => {
  configure();
  try {
    const ch = new SendblueChannel();
    const body = inbound({});

    const wrong = await ch.receive({ rawBody: body, headers: headers("not-the-secret") });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error, /did not match/);
    assert.deepEqual(wrong.inbound, []);

    const none = await ch.receive({ rawBody: body, headers: { "content-type": "application/json" } });
    assert.equal(none.status, 401);
    assert.match(none.body.error, /sb-signing-secret/, "and it says which header it looked in");
    assert.deepEqual(none.inbound, []);

    // A secret of a different length must be refused too, not crash timingSafeEqual.
    const shorter = await ch.receive({ rawBody: body, headers: headers("short") });
    assert.equal(shorter.status, 401);
  } finally { unconfigure(); }
});

test("with no SENDBLUE_WEBHOOK_SECRET on this machine, nothing is accepted at all", async () => {
  const out = await new SendblueChannel().receive({ rawBody: inbound({}), headers: headers() });
  assert.equal(out.status, 401);
  assert.match(out.body.error, /no SENDBLUE_WEBHOOK_SECRET/);
  assert.deepEqual(out.inbound, []);
});

test("a refused webhook never reaches the router, so no turn and no account are created", async () => {
  configure();
  try {
    const { router, turns } = harness();
    const out = await router.webhook({ channel: "sendblue", rawBody: inbound({}), headers: headers("wrong") });
    assert.equal(out.status, 401);
    assert.equal(turns.length, 0);
    assert.equal(db.getAccount(`dm:sendblue:${STRANGER}`), null);
  } finally { unconfigure(); }
});

test("our own outbound echo and every status callback are acknowledged and cost nothing", async () => {
  configure();
  try {
    const ch = new SendblueChannel();
    // The outbound example from getting-started/webhooks, verbatim in shape.
    const echo = JSON.stringify({
      accountEmail: "your-account-email", content: "Hello world!", is_outbound: true, status: "SENT",
      message_handle: "5a17319e-cbcf-443e-897e-d8b0c04b1b09", date_sent: "2025-12-12T15:35:35.410Z",
      from_number: LINE, number: STRANGER, to_number: STRANGER, group_id: "", service: "iMessage",
    });
    const out = await ch.receive({ rawBody: echo, headers: headers() });
    assert.equal(out.status, 200, "Sendblue is told we have it");
    assert.deepEqual(out.inbound, [], "and no turn is spent on our own message coming back");
    assert.match(out.body.ignored, /outbound/);

    for (const status of ["REGISTERED", "PENDING", "QUEUED", "ACCEPTED", "SENT", "DELIVERED", "ERROR", "DECLINED"]) {
      const cb = JSON.stringify({ content: "Hello world!", status, message_handle: `h-${status}`, number: STRANGER, group_id: "" });
      const r = await ch.receive({ rawBody: cb, headers: headers() });
      assert.equal(r.status, 200, `${status} is acknowledged`);
      assert.deepEqual(r.inbound, [], `${status} is not somebody talking`);
    }
  } finally { unconfigure(); }
});

test("the other webhook types pointed at the same account URL are ignored, not misread as texts", async () => {
  configure();
  try {
    const ch = new SendblueChannel();
    const cases = [
      // api-v2/typing-indicators
      [JSON.stringify({ number: STRANGER, is_typing: true, from_number: LINE, timestamp: "2025-01-30T12:34:56.789Z" }), "typing_indicator"],
      // getting-started/webhooks
      [JSON.stringify({ event_type: "inbound_call", event_id: "inbound-call-CA123", call_id: "CA123", from_number: STRANGER, to_number: LINE, status: "NO_ANSWER", answered: false }), "inbound_call"],
      [JSON.stringify({ event_type: "call_log", call_id: "cs_abc123", from_number: LINE, to_number: STRANGER, status: "COMPLETED" }), "call_log"],
      [JSON.stringify({ event_type: "contact_profile.completed", event_id: "contact-profile:bc03:completed", from_number: LINE, status: "completed" }), "contact_profile.completed"],
    ];
    for (const [body, expected] of cases) {
      const r = await ch.receive({ rawBody: body, headers: headers() });
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, expected);
      assert.deepEqual(r.inbound, []);
    }
  } finally { unconfigure(); }
});

test("a group message is never treated as one person's DM", async () => {
  configure();
  try {
    const { router, turns } = harness();
    const out = await router.webhook({
      channel: "sendblue",
      rawBody: inbound({ groupId: "group-abc-123", content: "yo everyone" }),
      headers: headers(),
    });
    assert.equal(out.status, 200, "acknowledged, so Sendblue stops retrying");
    assert.equal(out.body.ignored, "group");
    assert.equal(out.body.group_id, "group-abc-123");
    assert.equal(out.body.delivered, 0);
    assert.equal(turns.length, 0, "nobody's private Reason answers on behalf of a group");
    assert.equal(db.getAccount(`dm:sendblue:${STRANGER}`), null);
  } finally { unconfigure(); }
});

test("a file nobody can open is described rather than arriving as an empty message", async () => {
  configure();
  try {
    const out = await new SendblueChannel().receive({
      rawBody: inbound({ content: "sign this", mediaUrl: "https://storage.googleapis.com/inbound-file-store/abc123_Contract.docx?x=1" }),
      headers: headers(),
    });
    assert.equal(out.inbound.length, 1);
    assert.match(out.inbound[0].text, /sign this/);
    assert.match(out.inbound[0].text, /you cannot open/);
    assert.match(out.inbound[0].text, /Contract\.docx/);
  } finally { unconfigure(); }
});

test("a PDF is carried as an attachment, not described as a file that cannot be opened", async () => {
  configure();
  try {
    const url = "https://storage.googleapis.com/inbound-file-store/abc123_Lease.pdf?x=1";
    const out = await new SendblueChannel().receive({
      rawBody: inbound({ content: "sign this", mediaUrl: url }),
      headers: headers(),
    });
    assert.equal(out.inbound[0].text, "sign this", "their words, with nothing invented around them");
    assert.equal(out.inbound[0].attachments.length, 1);
    assert.equal(out.inbound[0].attachments[0].kind, "pdf");
    assert.match(out.inbound[0].attachments[0].filename, /Lease\.pdf/);
  } finally { unconfigure(); }
});

test("a picture is carried as a picture, not described as a file that cannot be opened", async () => {
  configure();
  try {
    // The turn looks at it (src/media.js), so a sentence here saying "you cannot open this" would
    // contradict what the model can see. The adapter's job is to say it IS a picture, and where.
    const url = "https://storage.googleapis.com/inbound-file-store/abc123_Receipt.jpg?x=1";
    const out = await new SendblueChannel().receive({
      rawBody: inbound({ content: "look at this", mediaUrl: url }),
      headers: headers(),
    });
    assert.equal(out.inbound[0].text, "look at this", "their words, with nothing invented around them");
    assert.equal(/cannot open/.test(out.inbound[0].text), false);
    assert.deepEqual(out.inbound[0].attachments, [{ url, filename: "abc123_Receipt.jpg", kind: "image" }]);
  } finally { unconfigure(); }
});

test("a video is carried as a video attachment, not described as a file that cannot be opened", async () => {
  configure();
  try {
    const url = "https://storage.googleapis.com/inbound-file-store/abc123_Clip.mov?x=1";
    const out = await new SendblueChannel().receive({
      rawBody: inbound({ content: "check this out", mediaUrl: url }),
      headers: headers(),
    });
    assert.equal(out.inbound[0].text, "check this out", "their words, with nothing invented around them");
    assert.equal(out.inbound[0].attachments.length, 1);
    assert.equal(out.inbound[0].attachments[0].kind, "video");
    assert.match(out.inbound[0].attachments[0].filename, /Clip\.mov/);

    const mp4 = await new SendblueChannel().receive({
      rawBody: inbound({ content: "", mediaUrl: "https://storage.googleapis.com/inbound-file-store/abc123_Recording.mp4" }),
      headers: headers(),
    });
    assert.equal(mp4.inbound[0].attachments[0].kind, "video");
  } finally { unconfigure(); }
});

test("a voice note is called a voice note, and Reason is told it has not heard it", async () => {
  configure();
  try {
    // ".caf files are rendered as voice memos on the recipient's device" is documented for the
    // sending direction; nothing inbound flags a voice note, so the extension is all there is.
    const note = await new SendblueChannel().receive({
      rawBody: inbound({ content: "", mediaUrl: "https://storage.googleapis.com/inbound-file-store/abc_AudioMessage.caf" }),
      headers: headers(),
    });
    assert.match(note.inbound[0].text, /voice note/);
    assert.match(note.inbound[0].text, /cannot listen to it/);
    assert.match(note.inbound[0].text, /ask them to type it/);

    // An ordinary audio file is audio, not a voice memo bubble, and still unheard.
    const audio = await new SendblueChannel().receive({
      rawBody: inbound({ content: "", mediaUrl: "https://storage.googleapis.com/inbound-file-store/abc_Demo.m4a" }),
      headers: headers(),
    });
    assert.match(audio.inbound[0].text, /audio file/);
    assert.match(audio.inbound[0].text, /cannot listen to/);
    assert.equal(/voice note/.test(audio.inbound[0].text), false);
  } finally { unconfigure(); }
});

test("an iMessage from an Apple ID is not dropped as a malformed payload", async () => {
  configure();
  try {
    // "Can receive from iCloud email addresses" (faq). Reason is keyed by phone number, so this
    // cannot become a turn — but it has to be refused with its own reason, not look like a bug.
    const out = await new SendblueChannel().receive({
      rawBody: JSON.stringify({
        content: "hey", is_outbound: false, status: "RECEIVED", message_handle: "H-mail",
        number: "someone@icloud.com", from_number: "someone@icloud.com", to_number: LINE,
        group_id: "", media_url: "", service: "iMessage",
      }),
      headers: headers(),
    });
    assert.equal(out.status, 200);
    assert.match(out.body.ignored, /email address/);
    assert.equal(out.body.from, "someone@icloud.com");
    assert.deepEqual(out.inbound, []);
  } finally { unconfigure(); }
});

test("the normalised inbound is the shape the router accepts, with message_handle as the dedupe key", async () => {
  configure();
  try {
    const out = await new SendblueChannel().receive({ rawBody: inbound({ handle: "H-1", from: "+1 (415) 555-9876" }), headers: headers() });
    const one = out.inbound[0];
    assert.equal(one.channel, "sendblue");
    assert.equal(one.externalId, "H-1");
    assert.equal(one.from, STRANGER, "E.164, however Sendblue formatted it");
    assert.equal(one.chatId, null, "Sendblue has no thread id for a 1:1 conversation");
    assert.equal(one.at, Date.parse("2025-12-12T15:41:20.932Z"));
    // Which rail it came in on, because a tapback, a typing bubble and a read receipt are all
    // iMessage-only and this is the documented field that says so.
    assert.equal(one.service, "iMessage");
  } finally { unconfigure(); }
});

test("a number nobody approved gets the master-approval path and no model turn", async () => {
  configure();
  try {
    const { router, turns } = harness();
    const out = await router.webhook({ channel: "sendblue", rawBody: inbound({ content: "hey is this Omari's assistant?" }), headers: headers() });

    assert.equal(out.status, 200);
    assert.equal(out.results[0].admitted, false);
    assert.equal(out.results[0].asked, true, "the master is asked whether to let them in");
    assert.equal(turns.length, 0, "and nothing they said reached the model");

    // Their words are written down as a quote for the master to read, and nothing more.
    const req = db.getAccessRequest(out.results[0].requestId);
    assert.equal(req.address, STRANGER);
    assert.equal(req.channel, "sendblue");
    assert.match(req.first_message, /is this Omari's assistant/);
  } finally { unconfigure(); }
});

// ---------- sending ----------

test("Sendblue sends to the documented endpoint, with the documented headers and body", async () => {
  configure();
  try {
    const calls = [];
    const ch = new SendblueChannel({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({
          status: "QUEUED", message_handle: "msg_abc123def456", from_number: LINE, number: STRANGER, service: "iMessage",
        }) };
      },
    });

    const out = await ch.send({ to: "+1 (415) 555-9876", text: "on my way", idempotencyKey: "k1" });
    assert.equal(out.ok, true);
    assert.equal(out.delivered.message_id, "msg_abc123def456");
    assert.equal(out.delivered.to, STRANGER);
    assert.equal(out.delivered.status, "QUEUED");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.sendblue.com/api/send-message");
    assert.equal(calls[0].init.headers["sb-api-key-id"], "test-key-id");
    assert.equal(calls[0].init.headers["sb-api-secret-key"], "test-secret-key");
    assert.deepEqual(JSON.parse(calls[0].init.body), { number: STRANGER, from_number: LINE, content: "on my way" });
    assert.equal("idempotency_key" in JSON.parse(calls[0].init.body), false, "Sendblue's send endpoint documents none, so none is invented");
  } finally { unconfigure(); }
});

test("a send to an unverified contact comes back in words Reason can repeat", async () => {
  configure();
  try {
    // The documented decline: HTTP 400, status DECLINED, the key in error_key, the code in
    // error_code (limits#before-the-first-reply).
    const declined = (error_key, error_code) => new SendblueChannel({
      fetchImpl: async () => ({
        ok: false, status: 400,
        text: async () => JSON.stringify({
          status: "DECLINED", error_key, error_message: error_key, error_code,
          error_reason: "This contact has not replied yet, so links are not allowed.",
        }),
      }),
    });

    const content = await declined("PRE_REPLY_CONTENT_BLOCKED", 4007).send({ to: STRANGER, text: "here you go https://x.com" });
    assert.equal(content.ok, false);
    assert.match(content.error, /they need to text this number once first/);
    assert.equal(content.error_key, "PRE_REPLY_CONTENT_BLOCKED");
    assert.equal(content.error_code, 4007);

    const tooLong = await declined("PRE_REPLY_LENGTH_EXCEEDED", 4008).send({ to: STRANGER, text: "x".repeat(400) });
    assert.match(tooLong.error, /they need to text this number once first/);
    assert.match(tooLong.error, /300 characters/);

    const used = await declined("PRE_REPLY_LIMIT_REACHED", 4009).send({ to: STRANGER, text: "you there?" });
    assert.match(used.error, /only their reply lifts that/);

    // A 403 is read as the free shared line refusing an unverified contact, which is the one
    // place the docs put that status (api-v2/read-receipts).
    const forbidden = await new SendblueChannel({
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ status: "ERROR", message: "Contact not verified" }) }),
    }).send({ to: STRANGER, text: "hi" });
    assert.equal(forbidden.ok, false);
    assert.match(forbidden.error, /they need to text this number once first/);
    assert.match(forbidden.error, /free shared Sendblue line/);

    // An opt-out is a different refusal and must not be dressed up as "text us first".
    const out = await declined("OPTED_OUT", 4000).send({ to: STRANGER, text: "hi" });
    assert.match(out.error, /opted out/);
    assert.equal(/text this number once first/.test(out.error), false);
  } finally { unconfigure(); }
});

test("a 200 whose body says DECLINED is still a refusal, not a delivery", async () => {
  configure();
  try {
    const ch = new SendblueChannel({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "DECLINED", error_key: "PRE_REPLY_LIMIT_REACHED", error_code: 4009 }) }),
    });
    const out = await ch.send({ to: STRANGER, text: "hi" });
    assert.equal(out.ok, false);
    assert.match(out.error, /they need to text this number once first/);
  } finally { unconfigure(); }
});

test("an undocumented failure is reported in Sendblue's own words, not swallowed or guessed at", async () => {
  configure();
  try {
    const ch = new SendblueChannel({
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ status: "ERROR", error_reason: "Too Many Requests", error_code: 5509 }) }),
    });
    const out = await ch.send({ to: STRANGER, text: "hi" });
    assert.equal(out.ok, false);
    assert.match(out.error, /HTTP 429/);
    assert.match(out.error, /Too Many Requests/);
    assert.equal(out.error_code, 5509);
  } finally { unconfigure(); }
});

test("a non-number and an over-long message are refused before any request is made", async () => {
  configure();
  try {
    let called = 0;
    const ch = new SendblueChannel({ fetchImpl: async () => { called++; return { ok: true, status: 200, text: async () => "{}" }; } });

    const bad = await ch.send({ to: "omari@example.com", text: "hi" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /E\.164/);

    const huge = await ch.send({ to: STRANGER, text: "x".repeat(19_000) });
    assert.equal(huge.ok, false);
    assert.match(huge.error, /18996/);
    assert.equal(called, 0, "nothing was sent to find that out");
  } finally { unconfigure(); }
});

test("the length limit is 'less than 18996', so 18996 itself is too many", async () => {
  configure();
  try {
    let called = 0;
    const ch = new SendblueChannel({
      fetchImpl: async () => { called++; return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "h" }) }; },
    });
    // "Messages sent using Sendblue must be less than 18996 characters in length."
    const edge = await ch.send({ to: STRANGER, text: "x".repeat(18_996) });
    assert.equal(edge.ok, false);
    assert.equal(edge.retryable, false, "the same text is the same length tomorrow");
    assert.equal(called, 0);

    const under = await ch.send({ to: STRANGER, text: "x".repeat(18_995) });
    assert.equal(under.ok, true);
    assert.equal(called, 1);
  } finally { unconfigure(); }
});

test("sending to this line's own number is named, not reported as an unexplained 400", async () => {
  configure();
  try {
    // Seen for real on this install: a send where number === from_number is HTTP 400 "Cannot send
    // messages to self", with no error_key on it.
    const ch = new SendblueChannel({
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({
        status: "ERROR", message: "Cannot send messages to self",
      }) }),
    });
    const out = await ch.send({ to: LINE, text: "hello me" });
    assert.equal(out.ok, false);
    assert.equal(out.error_key, "cannot_send_to_self");
    assert.equal(out.retryable, false);
    assert.match(out.error, /cannot text itself/);
  } finally { unconfigure(); }
});

test("a dropped connection is a transport failure, not Sendblue refusing", async () => {
  configure();
  try {
    const ch = new SendblueChannel({
      fetchImpl: async () => { throw new Error("fetch failed: ECONNRESET\n  at somewhere"); },
    });
    const out = await ch.send({ to: STRANGER, text: "hi" });
    assert.equal(out.ok, false);
    assert.equal(out.retryable, true, "never reaching Sendblue is not an answer from Sendblue");
    assert.equal(out.error_key, "transport");
    assert.match(out.error, /could not be reached/);
    assert.equal(/\n/.test(out.error), false, "one line, not a stack");
  } finally { unconfigure(); }
});

test("retryability comes from Sendblue's own error table, and defaults to no", () => {
  // sending-messages#error-codes and limits#before-the-first-reply. Each of these is a documented
  // row; the point of the test is that nothing was decided by feel.
  assert.equal(canRetry({ status: 400, errorCode: 4001 }), true, "4001 Rate Limit Exceeded");
  assert.equal(canRetry({ status: 500, errorCode: 5000 }), true, "5000 Internal Error");
  assert.equal(canRetry({ status: 400, errorCode: 5003 }), true, "5003 Server Rate Exceeded");
  assert.equal(canRetry({ status: 400, errorCode: 5509 }), true, "5509 rate limit window exceeded");
  assert.equal(canRetry({ status: 400, errorCode: 10001 }), true, "10001 Message failed to send");
  assert.equal(canRetry({ status: 400, errorCode: "SMS_LIMIT_REACHED" }), true, "wait for the window to reset");
  assert.equal(canRetry({ status: 429 }), true, "limits: slow down, then retry");
  assert.equal(canRetry({ status: 503 }), true);

  assert.equal(canRetry({ status: 400, errorCode: 4000 }), false, "4000 Validation Error");
  assert.equal(canRetry({ status: 400, errorCode: 4002 }), false, "4002 Blacklisted Number");
  for (const [key, code] of [["PRE_REPLY_CONTENT_BLOCKED", 4007], ["PRE_REPLY_LENGTH_EXCEEDED", 4008], ["PRE_REPLY_LIMIT_REACHED", 4009], ["PRE_REPLY_OVERRIDE_EXHAUSTED", 4010]]) {
    assert.equal(canRetry({ status: 400, errorKey: key, errorCode: code }), false, `${key} cannot be fixed by waiting`);
  }
  assert.equal(canRetry({ status: 400, errorKey: "OPTED_OUT" }), false);
  assert.equal(canRetry({ status: 403, errorKey: "unverified_contact_inferred" }), false, "only their own text lifts it");

  // The default. An unrecognised refusal retried on a timer is how somebody gets texted six times.
  assert.equal(canRetry({ status: 400 }), false);
  assert.equal(canRetry({}), false);
});

test("a 429 and a 5xx are retryable, a decline is not — read off the send result itself", async () => {
  configure();
  try {
    const at = (status, body) => new SendblueChannel({
      fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify(body) }),
    }).send({ to: STRANGER, text: "hi" });

    assert.equal((await at(429, { status: "ERROR", error_reason: "Too Many Requests" })).retryable, true);
    assert.equal((await at(500, { status: "ERROR", error_reason: "Internal Error" })).retryable, true);
    assert.equal((await at(400, { status: "DECLINED", error_key: "PRE_REPLY_LIMIT_REACHED", error_code: 4009 })).retryable, false);
    assert.equal((await at(403, { status: "ERROR", message: "Contact not verified" })).retryable, false);
  } finally { unconfigure(); }
});

// ---------- attachments ----------

test("text and a file go as ONE message, via upload-file then send-message", async () => {
  configure();
  try {
    const calls = [];
    const ch = new SendblueChannel({
      statFile: () => ({ size: 4844 }),
      readFile: () => Buffer.alloc(4844, 7),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/api/upload-file")) {
          return { ok: true, status: 200, text: async () => JSON.stringify({
            status: "OK", message: "File uploaded successfully",
            media_url: "https://storage.googleapis.com/inbound-file-store/abc123_call-7.wav",
            mediaObjectId: "abc123_call-7.wav",
          }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "msg_media_1", service: "iMessage" }) };
      },
    });

    const out = await ch.sendMedia({
      to: STRANGER, text: "they said 8:15 works", file: "/tmp/call-7.wav",
      mimeType: "audio/wav", filename: "call-7.wav", idempotencyKey: "k9",
    });
    assert.equal(out.ok, true);
    assert.equal(out.supported, true);
    assert.equal(out.delivered.media.bytes, 4844);
    assert.equal(out.delivered.media.media_url, "https://storage.googleapis.com/inbound-file-store/abc123_call-7.wav");
    assert.equal(out.delivered.media.renders_as, "attachment", "a .wav is a playable attachment, not a voice memo");

    assert.equal(calls.length, 2, "two requests, one message");

    // Step 1: multipart, the file in a field called `file`, with the auth headers and NO
    // hand-written content-type (FormData sets its own boundary).
    assert.equal(calls[0].url, "https://api.sendblue.com/api/upload-file");
    assert.equal(calls[0].init.headers["sb-api-key-id"], "test-key-id");
    assert.equal(calls[0].init.headers["Content-Type"], undefined);
    assert.ok(calls[0].init.body instanceof FormData);
    const file = calls[0].init.body.get("file");
    assert.equal(file.name, "call-7.wav");
    assert.equal(file.size, 4844, "the real bytes, read off disk");

    // Step 2: one message carrying the text and the uploaded file.
    assert.equal(calls[1].url, "https://api.sendblue.com/api/send-message");
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      number: STRANGER, from_number: LINE, content: "they said 8:15 works",
      media_url: "https://storage.googleapis.com/inbound-file-store/abc123_call-7.wav",
    });
  } finally { unconfigure(); }
});

test("a .caf file is recorded as the voice memo Apple renders it as", async () => {
  configure();
  try {
    const ch = new SendblueChannel({
      statFile: () => ({ size: 1200 }),
      readFile: () => Buffer.alloc(1200),
      fetchImpl: async (url) => url.endsWith("/api/upload-file")
        ? { ok: true, status: 200, text: async () => JSON.stringify({ media_url: "https://storage.googleapis.com/inbound-file-store/note.caf" }) }
        : { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "m2" }) },
    });
    const out = await ch.sendMedia({ to: STRANGER, text: "", file: "/tmp/note.caf", mimeType: "audio/x-caf" });
    assert.equal(out.ok, true);
    assert.equal(out.delivered.media.renders_as, "voice memo");
  } finally { unconfigure(); }
});

test("a file that is legal over iMessage but over the SMS ceiling says so on the record", async () => {
  configure();
  try {
    // sending-messages: iMessage 20 MB recommended / 100 MB max, SMS 5 MB max — and on a fallback
    // to SMS "Sendblue will attempt to compress the file ... If compression fails, the message will
    // fail to send". So this send is accepted and still might not arrive.
    const at = async (size) => {
      const ch = new SendblueChannel({
        statFile: () => ({ size }),
        readFile: () => Buffer.alloc(1),
        fetchImpl: async (url) => url.endsWith("/api/upload-file")
          ? { ok: true, status: 200, text: async () => JSON.stringify({ media_url: "https://storage.googleapis.com/inbound-file-store/clip.mp4" }) }
          : { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "m3" }) },
      });
      return await ch.sendMedia({ to: STRANGER, text: "here", file: "/tmp/clip.mp4", mimeType: "video/mp4" });
    };

    const small = await at(2 * 1024 * 1024);
    assert.equal(small.ok, true);
    assert.equal("note" in small.delivered.media, false, "2MB is under both ceilings; nothing to warn about");

    const overSms = await at(8 * 1024 * 1024);
    assert.equal(overSms.ok, true, "8MB is fine over iMessage, so it is sent");
    assert.match(overSms.delivered.media.note, /SMS ceiling/);
    assert.match(overSms.delivered.media.note, /fails if that does not work/);
    assert.equal(/recommended 20MB/.test(overSms.delivered.media.note), false, "8MB is under 20MB");

    const big = await at(40 * 1024 * 1024);
    assert.match(big.delivered.media.note, /recommended 20MB/);
    assert.match(big.delivered.media.note, /SMS ceiling/, "both ceilings, both said");
  } finally { unconfigure(); }
});

test("an upload that is rejected is reported, and no message is sent", async () => {
  configure();
  try {
    const calls = [];
    const ch = new SendblueChannel({
      statFile: () => ({ size: 10 }),
      readFile: () => Buffer.alloc(10),
      fetchImpl: async (url) => {
        calls.push(url);
        return { ok: false, status: 500, text: async () => JSON.stringify({ status: "ERROR", message: "Failed to upload file to storage" }) };
      },
    });
    const out = await ch.sendMedia({ to: STRANGER, text: "here", file: "/tmp/x.wav", mimeType: "audio/wav" });
    assert.equal(out.ok, false);
    assert.equal(out.supported, true);
    assert.match(out.error, /Failed to upload file to storage/);
    assert.equal(calls.length, 1, "and nothing was sent claiming the file went");
  } finally { unconfigure(); }
});

test("a missing, empty or too-large file is refused before anything is uploaded", async () => {
  configure();
  try {
    let called = 0;
    const fetchImpl = async () => { called++; return { ok: true, status: 200, text: async () => "{}" }; };

    const gone = await new SendblueChannel({ statFile: () => { throw new Error("ENOENT"); }, fetchImpl }).sendMedia({ to: STRANGER, text: "x", file: "/tmp/nope.wav", mimeType: "audio/wav" });
    assert.match(gone.error, /not there/);

    const empty = await new SendblueChannel({ statFile: () => ({ size: 0 }), fetchImpl }).sendMedia({ to: STRANGER, text: "x", file: "/tmp/empty.wav", mimeType: "audio/wav" });
    assert.match(empty.error, /empty/);

    const huge = await new SendblueChannel({ statFile: () => ({ size: 200 * 1024 * 1024 }), fetchImpl }).sendMedia({ to: STRANGER, text: "x", file: "/tmp/big.mov", mimeType: "video/quicktime" });
    assert.match(huge.error, /100MB/);

    assert.equal(called, 0);
  } finally { unconfigure(); }
});

// ---------- "did that one go out?" ----------
//
// Only ever asked about a send that was interrupted mid-flight. /api/send-message has no
// idempotency key and returns the message_handle in the response that was lost, so content inside
// a time window is all there is to match on.

test("an interrupted send is resolved by asking Sendblue, in the window it happened in", async () => {
  configure();
  try {
    const asked = [];
    const ch = new SendblueChannel({
      now: () => 2_000_000,
      fetchImpl: async (url, init) => {
        asked.push({ url, method: init?.method, headers: init?.headers });
        return { ok: true, status: 200, text: async () => JSON.stringify({
          status: "OK",
          data: [
            { message_handle: "other", content: "something else", status: "DELIVERED" },
            { message_handle: "msg-the-one", content: "table's at 8", status: "SENT" },
          ],
          pagination: { limit: 100, offset: 0, total: 2 },
        }) };
      },
    });

    const found = await ch.findSent({ to: STRANGER, text: "table's at 8", since: 1_000_000, until: 2_000_000 });
    assert.equal(found.ok, true);
    assert.equal(found.found, true);
    assert.equal(found.message_id, "msg-the-one");

    const u = new URL(asked[0].url);
    assert.equal(u.pathname, "/api/v2/messages");
    assert.equal(asked[0].method, "GET");
    assert.equal(asked[0].headers["sb-api-key-id"], "test-key-id");
    assert.equal(u.searchParams.get("number"), STRANGER);
    assert.equal(u.searchParams.get("is_outbound"), "true");
    assert.equal(u.searchParams.get("limit"), "100");
    // The window matters: the same reply could legitimately have gone to the same person last week,
    // and matching that copy would make Reason silently drop this one.
    assert.equal(u.searchParams.get("created_at_gte"), new Date(1_000_000).toISOString());
    assert.equal(u.searchParams.get("created_at_lte"), new Date(2_000_000).toISOString());
  } finally { unconfigure(); }
});

test("nothing matching in the window means it never went, so it is safe to send", async () => {
  configure();
  try {
    const ch = new SendblueChannel({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "OK", data: [] }) }),
    });
    const out = await ch.findSent({ to: STRANGER, text: "table's at 8", since: 1, until: 2 });
    assert.deepEqual(out, { ok: true, found: false });
  } finally { unconfigure(); }
});

test("a message Sendblue has but refused is not a delivery", async () => {
  configure();
  try {
    // It reached Sendblue and Sendblue declined it, which ends in the same place as never sending
    // it. `found: false`, so the outbox may try again rather than recording a delivery.
    const ch = new SendblueChannel({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
        status: "OK", data: [{ message_handle: "m-dead", content: "hi", status: "DECLINED" }],
      }) }),
    });
    const out = await ch.findSent({ to: STRANGER, text: "hi", since: 1, until: 2 });
    assert.equal(out.ok, true);
    assert.equal(out.found, false);
    assert.equal(out.refused, "DECLINED");
  } finally { unconfigure(); }
});

test("Sendblue refusing to answer is 'cannot tell', which is not 'did not send'", async () => {
  configure();
  try {
    const down = await new SendblueChannel({
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ status: "ERROR", message: "Internal Error" }) }),
    }).findSent({ to: STRANGER, text: "hi", since: 1, until: 2 });
    assert.equal(down.ok, false, "the outbox must not resend on this");
    assert.match(down.error, /would not answer/);

    const unreachable = await new SendblueChannel({
      fetchImpl: async () => { throw new Error("ECONNRESET"); },
    }).findSent({ to: STRANGER, text: "hi", since: 1, until: 2 });
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.error, /could not be reached/);

    // A bare attachment has no text to match on, so there is nothing to ask about.
    const noText = await new SendblueChannel({
      fetchImpl: async () => { throw new Error("should not be called"); },
    }).findSent({ to: STRANGER, text: "", since: 1, until: 2 });
    assert.equal(noText.ok, false);
    assert.match(noText.error, /no text to match on/);
  } finally { unconfigure(); }
});

// ---------- typing ----------

test("typing is per recipient, start and stop, as the endpoint documents", async () => {
  configure();
  try {
    const calls = [];
    const ch = new SendblueChannel({
      now: () => 1_000_000,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", status_code: 200, error_message: null, number: STRANGER }) };
      },
    });

    // The duration is always sent, never left to Sendblue's default, and the expiry comes back so
    // the caller can refresh before the bubble lapses.
    const on = await ch.typing({ to: STRANGER, on: true });
    assert.equal(on.ok, true);
    assert.equal(on.supported, true);
    assert.equal(on.duration_ms, TYPING_DEFAULT_MS);
    assert.equal(on.expires_at, 1_000_000 + TYPING_DEFAULT_MS);
    assert.equal(calls[0].url, "https://api.sendblue.com/api/send-typing-indicator");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      number: STRANGER, from_number: LINE, state: "start", max_duration_ms: TYPING_DEFAULT_MS,
    });

    await ch.typing({ to: STRANGER, on: false });
    assert.deepEqual(JSON.parse(calls[1].init.body), { number: STRANGER, from_number: LINE, state: "stop" });

    // max_duration_ms is clamped to the documented 1–300000 rather than sent as given.
    const long = await ch.typing({ to: STRANGER, on: true, maxDurationMs: 999_999 });
    assert.equal(JSON.parse(calls[2].init.body).max_duration_ms, 300_000);
    assert.equal(long.duration_ms, 300_000);
  } finally { unconfigure(); }
});

test("Sendblue's 60s typing default is a named constant, because a longer turn outlives the bubble", () => {
  // api-v2/typing-indicators: max_duration_ms "Defaults to 60000 (60 seconds)". Pinned so nobody
  // later assumes one `start` covers a three-minute turn.
  assert.equal(TYPING_DEFAULT_MS, 60_000);
});

test("a line whose worker is too old for typing-v2 falls back to the legacy start the docs promise", async () => {
  configure();
  try {
    const bodies = [];
    const ch = new SendblueChannel({
      now: () => 500,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        // The documented 503: the firmware does not honour state or an explicit duration. The docs
        // say in the same paragraph that a bare legacy start "always succeeds".
        if ("max_duration_ms" in body || "state" in body) {
          return { ok: false, status: 503, text: async () => JSON.stringify({
            status: "ERROR", status_code: 503, number: STRANGER,
            error_message: 'Worker firmware iowa-1.9.80 does not yet support typing-v2 state="stop". Fleet update is rolling out; retry shortly.',
          }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", status_code: 200, number: STRANGER }) };
      },
    });

    const out = await ch.typing({ to: STRANGER, on: true, maxDurationMs: 120_000 });
    assert.equal(out.ok, true, "the bubble did show — on an old worker, but it showed");
    assert.equal(out.degraded, true);
    assert.equal(out.duration_ms, TYPING_DEFAULT_MS, "an old worker ignores the duration, so the real expiry is Sendblue's 60s");
    assert.equal(out.expires_at, 500 + TYPING_DEFAULT_MS);
    assert.match(out.note, /cannot be stopped early/);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], { number: STRANGER, from_number: LINE }, "the legacy form is a bare start: no state, no duration");

    // There is no legacy stop, so a 503 on a stop is reported rather than retried into a start.
    const stop = await ch.typing({ to: STRANGER, on: false });
    assert.equal(stop.ok, false);
    assert.equal(stop.supported, true);
    assert.match(stop.error, /typing-v2/);
    assert.equal(bodies.length, 3, "nothing was retried");
  } finally { unconfigure(); }
});

test("a typing indicator for somebody with no conversation yet fails readably, and never fails the turn", async () => {
  configure();
  try {
    const ch = new SendblueChannel({
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({
        status: "ERROR", status_code: 400,
        error_message: "No route mapping found for number, have you messaged them before?", number: STRANGER,
      }) }),
    });
    const out = await ch.typing({ to: STRANGER, on: true });
    assert.equal(out.ok, false);
    assert.equal(out.supported, true);
    assert.match(out.error, /have you messaged them before/);
  } finally { unconfigure(); }
});

// ---------- the subscription-backend guard ----------
//
// The rule is the channel's name-independent one: an external channel that is live OR merely
// configured restricts the subscription backend to the operator's own test numbers, and refuses to
// start with none. These are the three cases, with Sendblue in the place Linq used to hold.

test("claude-cli with Sendblue connected and NO test numbers refuses to start", () => {
  const r = subscriptionBackendBlock({
    backend: "claude-cli",
    channels: [{ name: "console", status: "live", missing: [] }, { name: "sendblue", status: "live", missing: [], configured: true }],
    testNumbers: [],
    ownerName: "Omari",
  });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.channels, ["sendblue"]);
  assert.match(r.message, /REASON_TEST_NUMBERS/);
  assert.match(r.message, /sendblue/);
});

test("claude-cli with Sendblue connected AND a test number starts, restricted to it", () => {
  const r = subscriptionBackendBlock({
    backend: "claude-cli",
    channels: [{ name: "console", status: "live", missing: [] }, { name: "sendblue", status: "live", missing: [], configured: true }],
    testNumbers: [OWNER],
  });
  assert.equal(r.blocked, false);
  assert.equal(r.restricted, true);
  assert.deepEqual(r.channels, ["sendblue"]);
  assert.deepEqual(r.testNumbers, [OWNER]);
});

test("a half-configured Sendblue still blocks: configured counts, not just live", () => {
  const halfway = { name: "sendblue", status: "not_connected", missing: ["SENDBLUE_WEBHOOK_SECRET"], configured: true };
  const r = subscriptionBackendBlock({
    backend: "claude-cli",
    channels: [{ name: "console", status: "live", missing: [] }, halfway],
    testNumbers: [],
  });
  assert.equal(r.blocked, true, "a Sendblue key in .env is somebody on their way to letting others text it");
  assert.deepEqual(r.channels, ["sendblue"]);
});

test("the plan limits Reason repeats are the ones the limits page states", () => {
  // Not an API test — a pin, so nobody rounds these off or invents a number later. The free
  // plan's verified-contact ceiling is deliberately absent: the docs never give one.
  assert.equal(PLAN_LIMITS.ai_agent_inbound_contacts_per_day, 1000);
  assert.equal(PLAN_LIMITS.ai_agent_reply_window_hours, 24);
  assert.equal(PLAN_LIMITS.ai_agent_follow_ups_per_day_after_window, 200);
  assert.match(PLAN_LIMITS.cite, /docs\.sendblue\.com\/limits/);
  assert.equal("free_plan_contact_ceiling" in PLAN_LIMITS, false);
});
