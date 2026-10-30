// iMessage's link card, as a file, is not something anybody sent.
//
// 2026-10-30 01:08 UTC, live: the owner pasted https://basistheory.com/solution/payment-vault and
// the model read "…payment-vault [they sent a file, which you cannot open: ….pluginPayloadAttachment]"
// and then a second user line that was ONLY that placeholder — then told him his files didn't come
// through. The card arrives as `<8 chars>_<UUID>.pluginPayloadAttachment`, on the same Sendblue
// webhook as the link or on its own empty `_1` part. Ids below are redacted, shapes are real.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-linkpreview-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";
process.env.LINQ_API_KEY = "";
process.env.LINQ_WEBHOOK_SECRET = "";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel, attachmentOf } = await import("../src/channels/sendblue.js");
const { LinqChannel } = await import("../src/channels/linq.js");
const media = await import("../src/webmedia.js");
const uploads = await import("../src/webuploads.js");
const harm = await import("../src/harm.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const SECRET = "a-shared-webhook-secret";
const STEM = "8F1C2A77-0000-4000-8000-REDACTED0001";
const LINK = "https://basistheory.com/solution/payment-vault";
const CARD = "zwpuJHMN_2D9D4818-0000-4000-8000-REDACTED00AD0.pluginPayloadAttachment";
const CARD_URL = `https://storage.googleapis.com/inbound-file-store/${CARD}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM conversations; DELETE FROM usage; DELETE FROM pending_inbound;");
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = SECRET;
  config.sendblueWebhookSecretHeader = "sb-signing-secret";
});

const headers = () => ({ "sb-signing-secret": SECRET, "content-type": "application/json" });
function inbound({ handle = STEM, content = "", mediaUrl = "", at = "2026-10-30T01:08:00.000Z" } = {}) {
  return JSON.stringify({
    accountEmail: "x", content, is_outbound: false, status: "RECEIVED", message_handle: handle,
    date_sent: at, date_updated: at, from_number: OWNER, number: OWNER, to_number: LINE,
    media_url: mediaUrl, message_type: "message", group_id: "", participants: [OWNER, LINE],
    send_style: "", opted_out: false, sendblue_number: LINE, service: "iMessage",
  });
}
function harness() {
  const turns = [], sent = [];
  const runtime = new Runtime({ runTurn: async ({ text }) => { turns.push(text); return "ok"; } });
  const router = new Router({ runtime });
  router.register(new SendblueChannel({
    fetchImpl: async (_u, opts) => { sent.push(opts?.body); return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "out-1" }) }; },
  }));
  router.register(new ConsoleChannel({ write: () => {} }));
  return { router, turns, sent };
}
const hook = (router, body) => router.webhook({ channel: "sendblue", headers: headers(), rawBody: body });

// ---------- Sendblue ----------

test("sendblue: link + card on one webhook -> just the link, no file line, no attachment", async () => {
  const { router, turns } = harness();
  const r = await hook(router, inbound({ content: LINK, mediaUrl: CARD_URL }));
  assert.equal(r.status, 200);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].trim().endsWith(LINK), true, "the link goes through unchanged");
  assert.doesNotMatch(turns[0], /cannot open|pluginPayload|they sent a file/i);
  const row = db.db.prepare("SELECT attachments FROM inbound_parts WHERE base_handle = ?").get(STEM);
  assert.ok(row, "the part is on record");
  assert.deepEqual(JSON.parse(row.attachments), [], "the card is not stored as a file");
});

test("sendblue: the card on its own empty `_1` part -> no turn, no reply, no empty user line", async () => {
  const { router, turns, sent } = harness();
  await hook(router, inbound({ content: LINK }));
  const before = sent.length;
  clock.skip(10_000);
  const p = await hook(router, inbound({ handle: `${STEM}_1`, mediaUrl: CARD_URL }));
  assert.equal(p.status, 200);
  assert.equal(turns.length, 1, "one message, one turn");
  assert.equal(sent.length, before, "nothing sent about it");
  assert.equal(turns.some(t => /cannot open|pluginPayload/i.test(t) || !t.trim()), false);
});

test("sendblue: a card on part 0 with no words at all is nothing either", async () => {
  const { router, turns } = harness();
  const r = await hook(router, inbound({ handle: STEM, mediaUrl: CARD_URL }));
  assert.equal(r.status, 200);
  assert.equal(turns.length, 0);
});

test("sendblue: a real pdf, zip and jpg are still handled as before", async () => {
  assert.equal(attachmentOf(CARD_URL), null, "the card is no attachment");
  assert.equal(attachmentOf(CARD_URL.toUpperCase().replace("PLUGINPAYLOADATTACHMENT", "pluginpayloadattachment")), null, "case-insensitive");
  assert.equal(attachmentOf("https://storage.googleapis.com/inbound-file-store/lease.pdf").kind, "pdf");
  assert.equal(attachmentOf("https://storage.googleapis.com/inbound-file-store/photo.jpg").kind, "image");
  const zip = attachmentOf("https://storage.googleapis.com/inbound-file-store/archive.zip");
  assert.equal(zip.kind, "file");
  const { router, turns } = harness();
  await hook(router, inbound({ handle: "ZIP-1", content: "here", mediaUrl: "https://storage.googleapis.com/inbound-file-store/archive.zip" }));
  assert.match(turns[0], /\[they sent a file, which you cannot open: archive\.zip\]/, "a real file is still said");
  // A real file on its own part is still a message.
  clock.skip(10_000);
  await hook(router, inbound({ handle: "ZIP-1_1", mediaUrl: "https://storage.googleapis.com/inbound-file-store/notes.zip" }));
  assert.equal(turns.length, 2);
  assert.match(turns[1], /notes\.zip/);
});

// ---------- Linq ----------

const LSECRET = "whsec_" + Buffer.from("a-test-signing-key-32-bytes-long").toString("base64");
function signed(body, { id = "msg_1", ts = Math.floor(Date.now() / 1000) } = {}) {
  const sig = createHmac("sha256", Buffer.from(LSECRET.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
}
const linqEvent = (parts, eventId = "evt-1") => JSON.stringify({
  event_type: "message.received", event_id: eventId, created_at: "2026-10-30T01:08:00Z",
  data: { chat: { id: "chat-abc", is_group: false }, id: "m1", direction: "inbound", sender_handle: { handle: "+14155550000", is_me: false }, parts, sent_at: "2026-10-30T01:08:00Z" },
});

test("linq: the card is left out of the words; a card-only message is no message; a real file still said", async () => {
  config.linqWebhookSecret = LSECRET;
  try {
    const ch = new LinqChannel();
    const card = { type: "media", filename: CARD, mime_type: "application/octet-stream", url: CARD_URL };
    let body = linqEvent([{ type: "text", value: LINK }, card]);
    let out = await ch.receive({ rawBody: body, headers: signed(body) });
    assert.equal(out.inbound.length, 1);
    assert.equal(out.inbound[0].text, LINK);

    body = linqEvent([card], "evt-2");
    out = await ch.receive({ rawBody: body, headers: signed(body) });
    assert.equal(out.status, 200);
    assert.equal(out.inbound.length, 0, "nothing to answer");

    body = linqEvent([{ type: "media", filename: "x", uti: "com.apple.messages.URLBalloonProvider" }], "evt-3");
    out = await ch.receive({ rawBody: body, headers: signed(body) });
    assert.equal(out.inbound.length, 0, "known by its UTI too");

    body = linqEvent([{ type: "media", filename: "lease.pdf", mime_type: "application/pdf" }], "evt-4");
    out = await ch.receive({ rawBody: body, headers: signed(body) });
    assert.equal(out.inbound.length, 1);
    assert.match(out.inbound[0].text, /lease\.pdf/);
  } finally { config.linqWebhookSecret = ""; }
});

// ---------- Reason Web ----------

const KOFI = "+14155559876", KOFI_C = `dm:fake:${KOFI}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
function browser() {
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${KOFI_C}`, token, { conversationId: KOFI_C });
  return { cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const up = (b, bytes, name) => media.uploadRequest({
  account: db.getAccount(KOFI_C), readBody: async () => bytes,
  headers: { host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", cookie: b.cookie, "x-reason-csrf": b.csrf, "x-reason-name": encodeURIComponent(name) },
});

test("web: an upload named .pluginPayloadAttachment is dropped quietly and never kept", async () => {
  media.resetUploadLimits();
  const b = browser();
  const r = await up(b, PNG, CARD);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
  assert.equal(j.dropped, "link_preview");
  assert.equal(j.id, undefined, "nothing stored, so nothing to name");
  assert.ok(!existsSync(uploads.dir()) || readdirSync(uploads.dir()).length === 0);
  // A real photo still goes up as before.
  const ok = JSON.parse((await up(b, PNG, "listing.png")).body);
  assert.equal(ok.kind, "image");
  assert.ok(ok.id);
});

// ---------- the line the harm screen reads stays the same ----------

test("harm: an old placeholder for the card still reads as a link preview card", () => {
  assert.equal(harm.ownWords(`[they sent a file, which you cannot open: ${CARD}]`), "(a link preview card)");
});
