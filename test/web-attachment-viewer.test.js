// Reason Web: a photo or a file on a line opens in a viewer over the thread (src/pages/webviewer.js),
// not on its raw address. 2026-10-31, Omari: tapping a photo took the whole tab to
// /web/media/m/1611/0, a black page with the picture small in the corner and no Reason around it.
//
// The page side: every photo and file on a line carries what the viewer needs (what it is, the
// address to show, its name and size), the conversation page and a day in History load the viewer,
// and the page may frame its own PDFs. The server side: a HEIC is shown as a JPEG (`?as=jpeg`), to
// its own conversation only, while the plain address still gives the original as before.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-viewer-"));
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
const uploads = await import("../src/webuploads.js");

const KOFI_C = "dm:fake:+14155559876", AMA_C = "dm:fake:+13475550000";
// An iPhone HEIC's first bytes (ftyp heic), and a JPEG the stand-in converter "makes" of it.
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(4000, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(900, 2)]);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(600, 3)]);
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  config.web = true;
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM page_sessions;");
  for (const [c, a, nm] of [[KOFI_C, "+14155559876", "Kofi"], [AMA_C, "+13475550000", "Ama"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: nm, isOperator: false });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
});
let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { cookie: `reason_page=${token}` };
}
const H = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
let converted = 0;
const convert = async ({ bytes }) => { converted++; return bytes.toString("ascii", 4, 8) === "ftyp" ? { ok: true, bytes: JPEG } : { ok: false }; };
const get = (b, path, { as = null, method = "GET", extra = {}, conv = convert } = {}) => media.webMediaRoute({ path, method, headers: H(b, extra), as, convert: conv });

/** A photo the person sent from Web: the upload kept, and the history row naming it. */
function sentPhoto(conv, { bytes = HEIC, name = "IMG_4012.HEIC", text = "" } = {}) {
  const m = uploads.store({ conversationId: conv, bytes, name });
  assert.ok(m.id, JSON.stringify(m));
  db.writeMessage({ conversationId: conv, role: "user", channel: "web", externalId: `${conv}:c${++n}`, text, media: [{ url: uploads.uploadUrl(m.id, m.name), filename: m.name, kind: "image", web_upload: m.id }], at: Date.now() + n });
  const r = db.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 1").get();
  return { row: { ...r, media: JSON.parse(r.media) }, m };
}
function reasonSent(conv, { bytes, mime, filename }) {
  const path = join(config.documentRoot, `x${++n}-${filename}`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  const ob = db.enqueueOutbound({ idemKey: `k${++n}`, conversationId: conv, channel: "fake", address: "+1", body: "here", media: { file: path, mimeType: mime, filename } }).row;
  db.writeMessage({ conversationId: conv, role: "assistant", channel: "sendblue", outboxId: ob.id, text: "here", media: [{ kind: "file", mimeType: mime, filename }], at: Date.now() + n });
  const r = db.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 1").get();
  return { ...r, media: JSON.parse(r.media) };
}

test("a photo on a line opens in the viewer: it says it is a photo, where to show it from, and its name", () => {
  const { row, m } = sentPhoto(KOFI_C, { bytes: JPEG, name: "listing.jpg", text: "is this place any good" });
  const { html } = convo.rowOut(row, { conversationId: KOFI_C });
  const a = /<a class="photo"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(a, /data-view="image"/);
  assert.match(a, new RegExp(`href="/web/media/u/${m.id}/listing\\.jpg"`), "the link keeps the file's own address (new tab, no script)");
  assert.match(a, new RegExp(`data-src="/web/media/u/${m.id}/listing\\.jpg"`));
  assert.match(a, /data-name="listing\.jpg"/);
  assert.match(a, /aria-haspopup="dialog"/);
});

test("a HEIC on a line is shown from its JPEG address; the link still downloads the original", () => {
  const { row, m } = sentPhoto(KOFI_C);
  const { html } = convo.rowOut(row, { conversationId: KOFI_C });
  assert.match(html, new RegExp(`<img src="/web/media/u/${m.id}/IMG_4012\\.heic\\?as=jpeg"`, "i"));
  assert.match(html, new RegExp(`href="/web/media/u/${m.id}/IMG_4012\\.heic"`, "i"));
});

test("?as=jpeg turns a HEIC into a JPEG for its own conversation, once; nobody else gets anything", async () => {
  const { m } = sentPhoto(KOFI_C);
  const path = `/web/media/u/${m.id}/${m.name}`;
  converted = 0;
  const kofi = browser(KOFI_C);
  const got = await get(kofi, path, { as: "jpeg" });
  assert.equal(got.status, 200);
  assert.equal(got.headers["Content-Type"], "image/jpeg");
  assert.equal(got.headers["X-Content-Type-Options"], "nosniff");
  assert.ok(Buffer.compare(got.body, JPEG) === 0);
  assert.match(got.headers["Content-Disposition"], /^inline; filename="IMG_4012\.jpg"/);
  assert.equal(got.headers["Content-Length"], JPEG.length);
  await get(kofi, path, { as: "jpeg" });
  await get(kofi, `/web/media/u/${m.id}/another-spelling.heic`, { as: "jpeg" });
  assert.equal(converted, 1, "kept, not converted again, however the address is spelled");
  // The plain address is untouched: the original HEIC, as before.
  const orig = await get(kofi, path);
  assert.equal(orig.headers["Content-Type"], "image/heic");
  assert.ok(Buffer.compare(orig.body, HEIC) === 0);
  for (const b of [browser(AMA_C), null, { cookie: "reason_page=nope" }]) assert.equal((await get(b, path, { as: "jpeg" })).status, 404);
  // A HEAD of it: the headers, no body.
  const head = await get(kofi, path, { as: "jpeg", method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["Content-Type"], "image/jpeg");
  assert.equal(head.body, "");
});

test("?as=jpeg on a HEIC this machine can't convert is a 404 (the viewer shows a file card); on a JPEG it changes nothing", async () => {
  const { m } = sentPhoto(KOFI_C, { bytes: Buffer.concat([HEIC, Buffer.from("other")]), name: "other.heic" });
  const none = await get(browser(KOFI_C), `/web/media/u/${m.id}/${m.name}`, { as: "jpeg", conv: async () => ({ ok: false, error: "there is no image converter on this machine" }) });
  assert.equal(none.status, 404);
  const { m: j } = sentPhoto(KOFI_C, { bytes: JPEG, name: "plain.jpg" });
  const same = await get(browser(KOFI_C), `/web/media/u/${j.id}/${j.name}`, { as: "jpeg" });
  assert.equal(same.status, 200);
  assert.equal(same.headers["Content-Type"], "image/jpeg");
  assert.ok(Buffer.compare(same.body, JPEG) === 0);
});

test("files on a line say what the viewer does with them: a PDF previews, a .docx is a card, sizes shown", () => {
  const pdf = reasonSent(KOFI_C, { bytes: Buffer.from("%PDF-1.4\n%%EOF\n"), mime: "application/pdf", filename: "lease.pdf" });
  const doc = reasonSent(KOFI_C, { bytes: Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(12511, 7)]), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "prompt.docx" });
  const txt = reasonSent(KOFI_C, { bytes: Buffer.from("milk\neggs\n"), mime: "text/plain", filename: "list.txt" });
  const png = reasonSent(KOFI_C, { bytes: PNG, mime: "image/png", filename: "map.png" });
  const chip = (row) => /<a class="slip fslip fchip"[^>]*>/.exec(convo.rowOut(row, { conversationId: KOFI_C }).html)?.[0] ?? "";
  assert.match(chip(pdf), new RegExp(`data-view="pdf" data-src="/web/media/m/${pdf.id}/0" data-name="lease\\.pdf"`));
  assert.match(chip(doc), /data-view="file"[^>]* data-name="prompt\.docx" data-size="12 KB"/);
  assert.match(chip(txt), /data-view="text"/);
  for (const r of [pdf, doc, txt]) assert.match(chip(r), /aria-haspopup="dialog"/);
  // A picture Reason sent as a file is a photo that opens (it was a grey PHOTO box with nothing to open).
  const ph = /<a class="photo"[^>]*>/.exec(convo.rowOut(png, { conversationId: KOFI_C }).html)?.[0] ?? "";
  assert.match(ph, new RegExp(`href="/web/media/m/${png.id}/0"[^>]* data-view="image"`));
});

test("the thread and a day in History load the viewer; the page may frame its own PDFs, nothing else", async () => {
  const { row } = sentPhoto(KOFI_C, { bytes: JPEG, name: "a.jpg" });
  const page = convo.conversationPage({ account: { conversation_id: KOFI_C }, headers: H(browser(KOFI_C)), sendId: "s1", query: { thread: "" } });
  const html = typeof page === "string" ? page : page.body;
  assert.match(html, /window\.reasonViewer=/);
  assert.match(html, /\.vw\{position:fixed/);
  assert.match(html, new RegExp(`id="m-${row.id}"`));
  const ws = await import("../src/pages/websignin.js");
  const csp = ws.SECURITY_HEADERS["Content-Security-Policy"];
  assert.match(csp, /frame-src 'self';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(ws.SECURITY_HEADERS["X-Frame-Options"], "DENY", "nobody else frames Reason's pages");
  assert.equal((csp.match(/frame-src/g) ?? []).length, 1);
  const hist = await import("../src/pages/webhistory.js");
  const day = hist.renderHistory({ account: { conversation_id: KOFI_C }, query: { day: hist.dayKey(Date.now() + 1000) } });
  assert.ok(day, "the day with the photo draws");
  assert.match(day, /window\.reasonViewer=/);
  assert.match(day, /data-view="image"/);
  const { VIEWER_JS } = await import("../src/pages/webviewer.js");
  assert.doesNotThrow(() => new Function(VIEWER_JS), "the viewer's script parses");
});

test("viewOf / viewSrc: what opens how, and only a HEIC asks for a JPEG", async () => {
  const { viewOf, viewSrc } = await import("../src/pages/webviewer.js");
  assert.equal(viewOf("a.pdf"), "pdf");
  assert.equal(viewOf("IMG_1.HEIC"), "image");
  assert.equal(viewOf("clip.mov"), "video");
  assert.equal(viewOf("note.m4a"), "audio");
  assert.equal(viewOf("notes.md"), "text");
  assert.equal(viewOf("sheet.xlsx"), "file");
  assert.equal(viewOf("drawing.svg"), "file", "an SVG is never shown inline");
  assert.equal(viewOf("x", "application/pdf"), "pdf");
  assert.equal(viewSrc("/web/media/m/1/0", "IMG.heic"), "/web/media/m/1/0?as=jpeg");
  assert.equal(viewSrc("/web/media/m/1/0", "a.jpg"), "/web/media/m/1/0");
  assert.equal(viewSrc("blob:x", "a.heic"), "blob:x");
});

test("a video texted in plays in the viewer: a video chip, served as video inline (not turned into audio)", async () => {
  const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(3000, 4)]);
  db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "sendblue", externalId: `v${++n}`, text: "", media: [{ url: "https://cdn.example.test/u/IMG_0007.mov", filename: "IMG_0007.mov", kind: "video" }], at: Date.now() + n });
  const r = db.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 1").get();
  const { html } = convo.rowOut({ ...r, media: JSON.parse(r.media) }, { conversationId: KOFI_C });
  assert.match(html, new RegExp(`<a class="slip fslip fchip" href="/web/media/m/${r.id}/0"[^>]* data-view="video"`));
  const fetchImpl = async () => new Response(MOV, { status: 200, headers: { "content-type": "video/quicktime" } });
  const got = await media.webMediaRoute({ path: `/web/media/m/${r.id}/0`, method: "GET", headers: H(browser(KOFI_C)), fetchImpl });
  assert.equal(got.status, 200);
  assert.equal(got.headers["Content-Type"], "video/quicktime");
  assert.match(got.headers["Content-Disposition"], /^inline;/);
  assert.equal(got.headers["X-Content-Type-Options"], "nosniff");
  assert.ok(Buffer.compare(got.body, MOV) === 0);
});

test("two asks for the same HEIC at once share one conversion; conversions run one at a time", async () => {
  const { m } = sentPhoto(KOFI_C, { bytes: Buffer.concat([HEIC, Buffer.from("twice")]), name: "twice.heic" });
  const { m: m2 } = sentPhoto(KOFI_C, { bytes: Buffer.concat([HEIC, Buffer.from("third")]), name: "third.heic" });
  let calls = 0, running = 0, most = 0;
  const slow = async () => { calls++; running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 30)); running--; return { ok: true, bytes: JPEG }; };
  const kofi = browser(KOFI_C);
  const outs = await Promise.all([get(kofi, `/web/media/u/${m.id}/${m.name}`, { as: "jpeg", conv: slow }), get(kofi, `/web/media/u/${m.id}/x.heic`, { as: "jpeg", conv: slow }), get(kofi, `/web/media/u/${m2.id}/${m2.name}`, { as: "jpeg", conv: slow })]);
  assert.deepEqual(outs.map(o => o.status), [200, 200, 200]);
  assert.equal(calls, 2, "one per file");
  assert.equal(most, 1, "never two at once");
  assert.equal(media.fileKey("/web/media/m/0001/0"), media.fileKey("/web/media/m/1/0"));
});
