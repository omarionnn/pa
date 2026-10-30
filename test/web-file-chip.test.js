// Reason Web: a file on a line is a chip that opens (src/pages/webcompose.js fileChip, src/sentfiles.js,
// src/webmedia.js). 2026-10-30: a .docx Reason texted showed on Web as a grey all-caps box with nothing to
// open: the history row kept only its name, while the file itself sat in data/documents (outbox.media.file).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-filechip-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";

const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const convo = await import("../src/pages/webconvo.js");
const media = await import("../src/webmedia.js");

const KOFI_C = "dm:fake:+14155559876", AMA_C = "dm:fake:+13475550000";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(12511, 7)]); // 12,515 bytes, like the live one
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  config.web = true;
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM page_sessions;");
  for (const [c, a, nm] of [[KOFI_C, "+14155559876", "Kofi"], [AMA_C, "+13475550000", "Ama"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: nm, isOperator: false });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
});
let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { cookie: `reason_page=${token}` };
}
const H = (b) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}) });
const getMedia = (b, path) => media.webMediaRoute({ path, method: "GET", headers: H(b) });

/** A file Reason sent, the way the send path stores it: the file on disk, its path on the outbox row, its name on the history row. */
function reasonSent(conv, { file, bytes = DOCX, mime = DOCX_MIME, filename = "reason-onboarding-build-prompt.docx" } = {}) {
  const path = file ?? join(config.documentRoot, `dSuQmP5wnG-${filename}`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  const ob = db.enqueueOutbound({ idemKey: `k${++n}`, conversationId: conv, channel: "fake", address: "+1", body: "here's the onboarding prompt as a doc", media: { file: path, mimeType: mime, filename } }).row;
  db.writeMessage({ conversationId: conv, role: "assistant", channel: "sendblue", externalId: null, outboxId: ob.id, text: "here's the onboarding prompt as a doc", media: [{ kind: "file", mimeType: mime, filename }], at: Date.now() });
  const r = db.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 1").get();
  return { ...r, media: JSON.parse(r.media) };
}

test("a .docx Reason sent is a chip: type mark, its name as written, DOCX · 12 KB, and it downloads", () => {
  const row = reasonSent(KOFI_C);
  const { html } = convo.rowOut(row, { conversationId: KOFI_C });
  assert.match(html, new RegExp(`<a class="slip fslip fchip" href="/web/media/m/${row.id}/0"[^>]* download="reason-onboarding-build-prompt.docx"`));
  assert.match(html, /<span class="fn">reason-onboarding-build-prompt\.docx<\/span>/, "the name as written, not all caps");
  assert.match(html, /DOCX · 12 KB · DOWNLOAD/);
  assert.match(html, /class="fc-i"/);
  assert.doesNotMatch(html, /REASON-ONBOARDING/);
});

test("the chip's link serves the file's own bytes, as a download under its real name, to its conversation only", async () => {
  const row = reasonSent(KOFI_C);
  const got = await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`);
  assert.equal(got.status, 200);
  assert.ok(Buffer.compare(got.body, DOCX) === 0, "the same bytes");
  assert.equal(got.headers["Content-Type"], DOCX_MIME);
  assert.match(got.headers["Content-Disposition"], /^attachment; filename="reason-onboarding-build-prompt\.docx"; filename\*=UTF-8''reason-onboarding-build-prompt\.docx$/);
  assert.equal((await getMedia(browser(AMA_C), `/web/media/m/${row.id}/0`)).status, 404, "another person gets nothing");
  assert.equal((await getMedia(null, `/web/media/m/${row.id}/0`)).status, 404, "signed out gets nothing");
});

test("a PDF Reason sent opens in the browser", async () => {
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
  const row = reasonSent(KOFI_C, { bytes: pdf, mime: "application/pdf", filename: "lease.pdf" });
  assert.match(convo.rowOut(row, { conversationId: KOFI_C }).html, /PDF · \d+ B · OPEN/);
  const got = await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`);
  assert.equal(got.headers["Content-Type"], "application/pdf");
  assert.match(got.headers["Content-Disposition"], /^inline;/);
});

test("an outbox path outside where Reason writes what it sends is never served", async () => {
  const row = reasonSent(KOFI_C, { file: join(dir, "secrets", "x.docx") });
  assert.doesNotMatch(convo.rowOut(row, { conversationId: KOFI_C }).html, /href=/);
  assert.equal((await getMedia(browser(KOFI_C), `/web/media/m/${row.id}/0`)).status, 404);
});
