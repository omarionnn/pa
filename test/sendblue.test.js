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
const { SendblueChannel, PLAN_LIMITS } = await import("../src/channels/sendblue.js");
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

test("an attachment is described rather than arriving as an empty message", async () => {
  configure();
  try {
    const out = await new SendblueChannel().receive({
      rawBody: inbound({ content: "look at this", mediaUrl: "https://storage.googleapis.com/inbound-file-store/abc123_Receipt.jpg?x=1" }),
      headers: headers(),
    });
    assert.equal(out.inbound.length, 1);
    assert.match(out.inbound[0].text, /look at this/);
    assert.match(out.inbound[0].text, /you cannot open/);
    assert.match(out.inbound[0].text, /Receipt\.jpg/);
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

// ---------- typing ----------

test("typing is per recipient, start and stop, as the endpoint documents", async () => {
  configure();
  try {
    const calls = [];
    const ch = new SendblueChannel({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", status_code: 200, error_message: null, number: STRANGER }) };
      },
    });

    assert.deepEqual(await ch.typing({ to: STRANGER, on: true }), { ok: true, supported: true });
    assert.equal(calls[0].url, "https://api.sendblue.com/api/send-typing-indicator");
    assert.deepEqual(JSON.parse(calls[0].init.body), { number: STRANGER, from_number: LINE, state: "start" });

    await ch.typing({ to: STRANGER, on: false });
    assert.deepEqual(JSON.parse(calls[1].init.body), { number: STRANGER, from_number: LINE, state: "stop" });

    // max_duration_ms is clamped to the documented 1–300000 rather than sent as given.
    await ch.typing({ to: STRANGER, on: true, maxDurationMs: 999_999 });
    assert.equal(JSON.parse(calls[2].init.body).max_duration_ms, 300_000);
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
