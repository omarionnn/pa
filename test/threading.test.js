// Reply threading (src/threading.js, REASON_THREADING): the structure code hands the model so that
// it is never unclear what a reply is about. Offline: the model is stubbed and what is asserted is
// the turn text it would have read. The judgement itself is test/flow-threading.test.js.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-threading-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const threading = await import("../src/threading.js");
const { systemFor } = await import("../src/agent.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const LINE = "+15122164639";
const SECRET = "a-shared-webhook-secret";
const STEM = "5B0D3C1A-1111-4C2A-9D18-5A6F0B2E3C77";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  delete process.env.REASON_THREADING;
  db.db.exec("DELETE FROM pending_inbound; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM conversations; DELETE FROM usage; DELETE FROM tasks;");
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = SECRET;
  config.sendblueWebhookSecretHeader = "sb-signing-secret";
  config.burstQuietMs = 0;
});

const headers = () => ({ "sb-signing-secret": SECRET, "content-type": "application/json" });

/** The documented receive body, plus `is_reaction` the way the messages API showed it live. */
function body({ handle = STEM, from = OWNER, content = "", mediaUrl = "", reaction = false } = {}) {
  return JSON.stringify({
    content, is_outbound: false, status: "RECEIVED", message_handle: handle,
    date_sent: "2026-11-10T15:00:00.000Z", from_number: from, number: from, to_number: LINE,
    media_url: mediaUrl, message_type: "message", group_id: "", send_style: "",
    sendblue_number: LINE, service: "iMessage", ...(reaction ? { is_reaction: true } : {}),
  });
}

function harness() {
  const turns = [];
  const runtime = new Runtime({
    runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "ok"; },
  });
  const router = new Router({ runtime });
  router.register(new SendblueChannel({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "out-1" }) }),
  }));
  router.register(new ConsoleChannel());
  return { router, turns, runtime };
}

/** A message of Reason's on record as sent, the way findByQuote and the thread read it. */
function reasonSaid(conversationId, handle, text) {
  db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, message_id, sent_at, to_owner, created_at, updated_at)
    VALUES (?, ?, 'sendblue', ?, ?, 'sent', ?, ?, 1, ?, ?)`).run(`k-${handle}`, conversationId, OWNER, text, handle, clock.now(), clock.now(), clock.now());
}

// ---------- the grammar of a tapback that arrives as text ----------

test("Apple's tapback wording is read as a tapback and its quoted target", () => {
  assert.deepEqual(threading.parseReaction("Liked “want me to book 8pm?”"), { kind: "like", emoji: "👍", quoted: "want me to book 8pm?", removed: false });
  assert.equal(threading.parseReaction("Disliked “want me to book 8pm?”").kind, "dislike");
  assert.equal(threading.parseReaction("Loved \"ok\"").kind, "love");
  assert.equal(threading.parseReaction("Laughed at “lol”").kind, "laugh");
  assert.equal(threading.parseReaction("Reacted 🔥 to “new pr”").emoji, "🔥");
  assert.equal(threading.parseReaction("Removed a like from “x”").removed, true);
  // Words that merely start the same way are not a tapback.
  assert.equal(threading.parseReaction("Liked the place a lot"), null);
  assert.equal(threading.parseReaction("hello"), null);
});

test("the flag: off by default, owner means the operator's thread only, on means everyone", () => {
  assert.equal(threading.threadingOn({ isOperator: true }), false);
  process.env.REASON_THREADING = "owner";
  assert.equal(threading.threadingOn({ isOperator: true }), true);
  assert.equal(threading.threadingOn({ isOperator: false }), false);
  process.env.REASON_THREADING = "on";
  assert.equal(threading.threadingOn({ isOperator: false }), true);
  process.env.REASON_THREADING = "banana";
  assert.equal(threading.threadingOn({ isOperator: true }), false);
});

test("the prompt changes only where the flag reaches", () => {
  const off = systemFor({ name: "Omari", isOperator: true });
  assert.match(off, /Tapbacks only go one way/);
  assert.doesNotMatch(off, /Never "above"/);
  process.env.REASON_THREADING = "owner";
  const owner = systemFor({ name: "Omari", isOperator: true });
  assert.match(owner, /Never "above"/);
  assert.match(owner, /ask ONE short question that names both/);
  assert.match(owner, /later one wins/);
  assert.doesNotMatch(owner, /Tapbacks only go one way/);
  const other = systemFor({ name: "Sam", isOperator: false });
  assert.match(other, /Tapbacks only go one way/, "somebody else's thread is untouched");
  assert.doesNotMatch(other, /Never "above"/);
});

// ---------- a tapback through the real webhook ----------

test("a tapback on Reason's yes/no question reaches the turn named, with what it is on", async () => {
  process.env.REASON_THREADING = "owner";
  const { router, turns, runtime } = harness();
  try {
    reasonSaid("dm:owner", "R-ask", "found a table at carbone for 8pm friday. want me to book it?");
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: "T-1", content: "Liked “found a table at carbone for 8pm friday. want me to book it?”", reaction: true }) });
    await router.idle();
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /this is a tapback, not a typed message/);
    assert.match(turns[0].text, /👍 \(like\) on your message "found a table at carbone/);
    assert.match(turns[0].text, /a 👍 like means yes/);
    assert.match(turns[0].text, /NO_REPLY/, "and anything else needs no answer");
  } finally { await runtime.shutdown?.(); }
});

test("a long target Apple cut short with … still finds the message", async () => {
  process.env.REASON_THREADING = "owner";
  const { router, turns, runtime } = harness();
  try {
    reasonSaid("dm:owner", "R-long", "here are the three flights to lisbon i found for the 14th, cheapest first, all nonstop out of jfk");
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: "T-2", content: "Loved “here are the three flights to lisbon i found…”", reaction: true }) });
    await router.idle();
    assert.match(turns[0].text, /on your message "here are the three flights to lisbon/);
  } finally { await runtime.shutdown?.(); }
});

test("flag off, a tapback goes through exactly as before: no line", async () => {
  const { router, turns, runtime } = harness();
  try {
    reasonSaid("dm:owner", "R-ask", "want me to book it?");
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: "T-3", content: "Liked “want me to book it?”", reaction: true }) });
    await router.idle();
    assert.equal(turns.length, 1);
    assert.doesNotMatch(turns[0].text, /tapback/);
  } finally { await runtime.shutdown?.(); }
});

test("a message that only looks like a tapback, with no is_reaction, is words", async () => {
  process.env.REASON_THREADING = "owner";
  const { router, turns, runtime } = harness();
  try {
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: "T-4", content: "Loved “the bear” season 2 tbh" }) });
    await router.idle();
    assert.doesNotMatch(turns[0].text, /tapback/);
  } finally { await runtime.shutdown?.(); }
});

// ---------- one send, numbered ----------

test("one message with two photos is ONE text, and the photos are numbered in the order sent", async () => {
  process.env.REASON_THREADING = "owner";
  config.burstQuietMs = 400;
  const { router, turns, runtime } = harness();
  try {
    const first = router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ content: "which of these jackets" }) });
    await new Promise(r => setTimeout(r, 30));
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: `${STEM}_1`, mediaUrl: "https://cdn/x/IMG_1.jpg" }) });
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: `${STEM}_2`, mediaUrl: "https://cdn/x/IMG_2.HEIC" }) });
    await first;
    await router.idle();
    assert.equal(turns.length, 1, "one turn");
    assert.match(turns[0].text, /one message from them with 2 attachments, numbered in the order they sent them: photo 1, photo 2/);
    assert.doesNotMatch(turns[0].text, /separate texts/, "parts of one send are not a burst of separate texts");
  } finally { await runtime.shutdown?.(); }
});

test("two separate texts are still two texts, each to be answered under its own", async () => {
  process.env.REASON_THREADING = "owner";
  config.burstQuietMs = 400;
  const { router, turns, runtime } = harness();
  try {
    const first = router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: "A-1", content: "did the dentist call back" }) });
    await new Promise(r => setTimeout(r, 30));
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: "B-1", content: "also whats the weather sat" }) });
    await first;
    await router.idle();
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /2 separate texts in a row/);
  } finally { await runtime.shutdown?.(); }
});

test("attachmentLine numbers by kind and names files; one attachment needs no numbers", () => {
  assert.equal(threading.attachmentLine([{ attachments: [{ kind: "image" }] }]), "");
  const line = threading.attachmentLine([{ attachments: [{ kind: "image" }] }, { attachments: [{ kind: "pdf", filename: "lease.pdf" }, { kind: "image" }] }]);
  assert.match(line, /photo 1, PDF 1 \(lease\.pdf\), photo 2/);
});

test("sendsOf groups parts by their base handle, Sendblue only", () => {
  const g = threading.sendsOf([
    { channel: "sendblue", external_id: "H" }, { channel: "sendblue", external_id: "H_1" },
    { channel: "sendblue", external_id: "J" }, { channel: "web", external_id: "w_1" }, { channel: "web", external_id: "w_2" },
  ]);
  assert.deepEqual(g.map(x => [x.base, x.rows.length]), [["H", 2], ["J", 1], ["w_1", 1], ["w_2", 1]]);
});

// ---------- jobs and where they started ----------

test("a job still running is named with the text that started it", () => {
  db.claimInbound({ channel: "sendblue", externalId: "O-1", conversationId: "dm:owner", text: "find me an airbnb in lisbon under 150 a night" });
  db.createTask("dm:owner", { title: "Lisbon airbnb", goal: "find one", maxAttempts: 5, originHandle: "O-1" });
  const line = threading.jobsLine("dm:owner");
  assert.match(line, /Lisbon airbnb — started by their "find me an airbnb in lisbon/);
  assert.equal(threading.jobsLine("dm:nobody"), "");
});

test("a friend's thread gets none of it while the flag is owner-only", async () => {
  process.env.REASON_THREADING = "owner";
  const FC = `dm:sendblue:${FRIEND}`;
  db.upsertAccount({ conversationId: FC, channel: "sendblue", address: FRIEND, name: "Sam", isOperator: false });
  const { router, turns, runtime } = harness();
  try {
    reasonSaid(FC, "R-f", "want me to book it?");
    await router.webhook({ channel: "sendblue", headers: headers(), rawBody: body({ handle: "F-1", from: FRIEND, content: "Liked “want me to book it?”", reaction: true }) });
    await router.idle();
    const held = db.db.prepare("SELECT text FROM inbound_messages WHERE external_id = ?").get("F-1");
    assert.ok(held, "the friend's tapback was taken in");
    for (const t of turns) assert.doesNotMatch(t.text, /this is a tapback/);
    assert.equal(turns.length, 1, "and it got a turn");
  } finally { await runtime.shutdown?.(); }
});
