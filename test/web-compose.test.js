// Reason Web: the composer's inputs and the message types that are not plain words (HANDOFF §3,
// reference composer 01–04, listening, sheet-messages 4A/4B, sheet-states 5A/5B, sheet-global 9C/9E).
// src/webuploads.js, src/webmedia.js, src/pages/webcompose.js and their hooks in webconvo.js. One
// pinned test per rule:
//
//   - an upload is same-origin + the session's secret, capped by kind, typed by its bytes; signed out 401
//   - a file is served back to its own conversation's session only; anybody else gets the same 404
//   - a Web message with files goes through the SAME pipeline as a texted photo/PDF: the router's
//     attachments, the reviewed record, the history row — and the readers read it from disk
//   - a file of somebody else's can never ride on a send; a send with files and no words is fine
//   - a voice note: the browser's own words are the message; with none, it is heard on the server
//     (src/voice.js), never twice; the thread draws its words in Caveat with ▶ and its length
//   - a photo texted in from iMessage draws in the thread too, served from Web's own address
//   - the reply to any of it stays on Web: nothing is texted to the phone
//   - the screens' copy and roles (drop, slips, dictating, Listening) are the reference's
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-web-compose-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_EVENTS_URL = "https://events.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.GEMINI_API_KEY;

const { webRequestFor, createServer } = await import("../src/http.js");
const convo = await import("../src/pages/webconvo.js");
const compose = await import("../src/pages/webcompose.js");
const uploads = await import("../src/webuploads.js");
const media = await import("../src/webmedia.js");
const { imagesFor, fetchPdf } = await import("../src/media.js");
const voice = await import("../src/voice.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const zonescope = await import("../src/zonescope.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876", AMA = "+13475550000";
const KOFI_C = `dm:fake:${KOFI}`, AMA_C = `dm:fake:${AMA}`;
/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n");
const WEBM = Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(64, 1)]);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  convo.resetSendLimits();
  media.resetUploadLimits();
  db.db.exec(`DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM extraction_queue;
    DELETE FROM requests; DELETE FROM page_sessions; DELETE FROM media_items; DELETE FROM confirmations;`);
  for (const [c, a, n] of [[KOFI_C, KOFI, "Kofi"], [AMA_C, AMA, "Ama"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: false });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
});

function harness({ turn = async ({ text }) => `re: ${text}` } = {}) {
  const logs = [], turns = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => { turns.push(args); return turn(args); } });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  const web = router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { router, runtime, fake, web, logs, turns };
}
let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token), conv: conversationId };
}
const H = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
/** POST /web/upload as the page's script does it. */
const up = (b, bytes, { name = "x", csrf = b?.csrf, headers = {} } = {}) => media.webMediaRoute({
  path: "/web/upload", method: "POST", readBody: async (max) => (bytes.length > max ? null : bytes),
  headers: H(b, { "x-reason-csrf": csrf, "x-reason-name": encodeURIComponent(name), "content-length": String(bytes.length), ...headers }),
});
const getMedia = (b, path, headers = {}, fetchImpl) => media.webMediaRoute({ path, method: "GET", headers: H(b, headers), fetchImpl });
const send = (h, b, fields) => webRequestFor({ sub: "send", method: "POST", headers: H(b, { accept: "application/json", "x-reason-csrf": b.csrf }), readBody: async () => new URLSearchParams({ c: b.csrf, ...fields }).toString(), runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const J = (r) => JSON.parse(r.body);

// ---------- the upload ----------

test("upload: same-origin and the session's secret, or nothing is kept; signed out is 401", async () => {
  const kofi = browser(KOFI_C);
  assert.equal((await up(kofi, PNG, { csrf: "wrong" })).status, 403);
  assert.equal((await up(kofi, PNG, { headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await up(null, PNG, { csrf: "x" })).status, 401);
  assert.equal((await media.webMediaRoute({ path: "/web/upload", method: "GET", headers: H(kofi) })).status, 405);
  assert.ok(!existsSync(uploads.dir()) || (await import("node:fs")).readdirSync(uploads.dir()).length === 0, "nothing was written");
});

test("upload: the bytes decide what it is — a photo, a PDF; anything else is refused; caps by kind", async () => {
  const kofi = browser(KOFI_C);
  const ok = J(await up(kofi, PNG, { name: "listing.png" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, "image");
  assert.equal(ok.name, "listing.png");
  assert.equal(ok.label, "LISTING.PNG");
  assert.match(ok.src, /^\/web\/media\/u\/[A-Za-z0-9_-]{22}\/listing\.png$/);
  // A PNG named .pdf is a PNG; the name follows the bytes.
  assert.equal(J(await up(kofi, PNG, { name: "lease.pdf" })).name, "lease.png");
  const notOne = await up(kofi, Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]), { name: "photo.jpg" });
  assert.equal(notOne.status, 415);
  assert.equal(J(notOne).error, "unsupported");
  const big = Buffer.concat([PNG, Buffer.alloc(uploads.LIMITS.image)]);
  assert.equal((await up(kofi, big, { name: "huge.png" })).status, 413, "a photo past 20 MB (PHOTOS, PDFS, DOCS · UP TO 20 MB EACH)");
  assert.equal((await up(kofi, Buffer.alloc(uploads.MAX_UPLOAD_BYTES + 1))).status, 413, "past every cap, refused on the length");
  // A recording is only ever taken as a voice note, from the mic.
  assert.equal((await up(kofi, WEBM)).status, 415);
  const v = J(await up(kofi, WEBM, { headers: { "x-reason-voice": "1", "x-reason-seconds": "7" } }));
  assert.equal(v.kind, "voice");
  assert.equal(v.seconds, 7);
});

test("a PDF's slip says its pages: LEASE.PDF · 4 PP", async () => {
  const kofi = browser(KOFI_C);
  const r = J(await media.uploadRequest({ account: db.getAccount(KOFI_C), headers: H(kofi, { "x-reason-csrf": kofi.csrf, "x-reason-name": "lease.pdf" }), readBody: async () => PDF, readPdf: async () => ({ ok: true, pages: 4 }) }));
  assert.equal(r.kind, "pdf");
  assert.equal(r.label, "LEASE.PDF · 4 PP");
  assert.equal(uploads.slipLabel({ name: "one.pdf", kind: "pdf", pages: 1 }), "ONE.PDF · 1 P");
});

test("a file is served to its own conversation's session only; anybody else, or nobody, gets the same 404", async () => {
  const kofi = browser(KOFI_C), ama = browser(AMA_C);
  const { id, src } = J(await up(kofi, PNG, { name: "listing.png" }));
  const mine = await getMedia(kofi, src);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers["Content-Type"], "image/png");
  assert.ok(Buffer.compare(mine.body, PNG) === 0);
  assert.match(mine.headers["Cache-Control"], /^private/);
  assert.equal(mine.headers["X-Content-Type-Options"], "nosniff");
  assert.equal((await getMedia(ama, src)).status, 404, "Ama never sees Kofi's photo");
  assert.equal((await getMedia(null, src)).status, 404, "signed out");
  assert.equal((await getMedia(kofi, `/web/media/u/${"A".repeat(22)}`)).status, 404, "a guessed id");
  // Audio needs ranges (Safari asks for them).
  const part = await getMedia(kofi, `/web/media/u/${id}`, { range: "bytes=0-3" });
  assert.equal(part.status, 206);
  assert.equal(part.headers["Content-Range"], `bytes 0-3/${PNG.length}`);
  assert.equal(part.body.length, 4);
});

// ---------- the same pipeline ----------

test("a photo sent on Web goes through the texted-photo pipeline: router attachments, the record, history, and vision reads it from disk", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  const { id } = J(await up(kofi, PNG, { name: "listing.png" }));
  const r = await send(h, kofi, { id: "w-photo-0001", text: "Is this the same place?", files: id });
  assert.equal(r.status, 200);
  assert.ok(await until(() => h.web.recent.length === 1), "Reason answered");
  const turn = h.turns[0];
  assert.equal(turn.attachments.length, 1);
  const a = turn.attachments[0];
  assert.equal(a.kind, "image");
  assert.equal(a.filename, "listing.png");
  assert.match(a.url, /^https:\/\/files\.heyreason\.test\/web\/media\/u\/[A-Za-z0-9_-]{22}\/listing\.png$/);
  assert.ok(a.media_id, "the reviewed record has a row for it, as for a texted photo");
  assert.equal(db.mediaItem(KOFI_C, a.media_id).kind, "image");
  // Vision (src/media.js) reads it from disk — no network: the fetch that would go out is never called.
  // Read inside Kofi's turn (src/agent.js runs it on his scope), as the turn does.
  const seen = await zonescope.runFor(KOFI_C, () => imagesFor(turn.attachments, { fetchImpl: () => { throw new Error("no network for a Web upload"); } }));
  assert.equal(seen.blocks.length, 1);
  // Somebody else's turn, or nobody's, handed the same link reads nothing: not from disk, not over the network.
  for (const who of [AMA_C, ""]) {
    const theirs = await zonescope.runFor(who, () => imagesFor(turn.attachments, { fetchImpl: () => { throw new Error("no network for a Web upload"); } }));
    assert.equal(theirs.blocks.length, 0, `not ${who || "nobody"}'s upload`);
  }
  assert.equal(seen.blocks[0].source.media_type, "image/png");
  assert.equal(seen.blocks[0].source.data, PNG.toString("base64"));
  // The history row, as the thread draws it: words, the photo framed and served from Web's own address.
  const rows = db.messagesFor(KOFI_C);
  assert.deepEqual(rows.map(x => [x.role, x.channel]), [["user", "web"], ["assistant", "web"]]);
  const line = convo.rowOut(rows[0], { conversationId: KOFI_C });
  assert.match(line.html, /<p class="lbl"><span>YOU · WEB · <\/span><time[^>]*>[^<]*<\/time><\/p><a class="photo" href="\/web\/media\/u\/[A-Za-z0-9_-]{22}\/listing\.png" target="_blank" rel="noopener" data-view="image"[^>]*><img src="\/web\/media\/u\/[^"]+" alt="Photo you sent"[^>]*><\/a><div class="said">Is this the same place\?<\/div>/);
  assert.ok(!JSON.stringify(line).includes("files.heyreason.test"), "only the path leaves the server");
  assert.equal(h.fake.sent.length, 0, "nothing texted to the phone");
});

test("a PDF sent on Web is read by the PDF reader from disk; the thread shows its slip", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  const { id } = J(await media.uploadRequest({ account: db.getAccount(KOFI_C), headers: H(kofi, { "x-reason-csrf": kofi.csrf, "x-reason-name": "lease.pdf" }), readBody: async () => PDF, readPdf: async () => ({ ok: true, pages: 4 }) }));
  assert.equal((await send(h, kofi, { id: "w-pdf-00001", text: "", files: id })).status, 200, "a file with no words is a message");
  assert.ok(await until(() => h.turns.length === 1));
  const a = h.turns[0].attachments[0];
  assert.equal(a.kind, "pdf");
  assert.equal(a.pages, 4);
  let got = null;
  assert.equal((await fetchPdf({ url: a.url, filename: a.filename, conversationId: AMA_C, fetchImpl: () => { throw new Error("no network"); } })).ok, false, "not Ama's to read");
  const read = await fetchPdf({ url: a.url, filename: a.filename, conversationId: KOFI_C, fetchImpl: () => { throw new Error("no network"); }, read: async ({ bytes }) => { got = bytes; return { ok: true, text: "LEASE TERMS", pages: 4, pages_read: 4 }; } });
  assert.equal(read.ok, true);
  assert.ok(Buffer.compare(got, PDF) === 0, "the reader got the very bytes uploaded");
  const line = convo.rowOut(db.messagesFor(KOFI_C)[0], { conversationId: KOFI_C });
  assert.match(line.html, /<a class="slip fslip fchip" href="\/web\/media\/u\/[^"]+\/lease\.pdf" target="_blank" rel="noopener" data-view="pdf"[^>]* aria-label="Open lease\.pdf, \d+ B">.*<span class="fn">lease\.pdf<\/span><span class="fs">PDF · 4 PAGES · \d+ B · OPEN<\/span><\/span><\/a>/, "3D: the file slip, TAP TO OPEN");
});

test("somebody else's file never rides on a send; nor a made-up id; and an empty send with no files is refused", async () => {
  const h = harness();
  const kofi = browser(KOFI_C), ama = browser(AMA_C);
  const { id } = J(await up(ama, PNG, { name: "ama.png" }));
  const theirs = await send(h, kofi, { id: "w-forge-0001", text: "look", files: id });
  assert.equal(theirs.status, 400);
  assert.equal(J(theirs).error, "bad_file");
  assert.equal((await send(h, kofi, { id: "w-forge-0002", text: "look", files: "../../etc/passwd" })).status, 400);
  assert.equal((await send(h, kofi, { id: "w-empty-0001", text: "" })).status, 400);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.turns.length, 0, "no turn ran");
  assert.equal(db.messagesFor(KOFI_C).length, 0);
});

test("a retried send with files is one turn and one row (the browser's id, the router's claim)", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  const { id } = J(await up(kofi, PNG, { name: "a.png" }));
  await send(h, kofi, { id: "w-dupe-00001", text: "once", files: id });
  await until(() => h.web.recent.length === 1);
  const again = J(await send(h, kofi, { id: "w-dupe-00001", text: "once", files: id }));
  assert.equal(again.duplicate, true);
  assert.equal(h.turns.length, 1);
  assert.equal(db.messagesFor(KOFI_C).filter(r => r.role === "user").length, 1);
});

// ---------- voice ----------

test("a voice note with the browser's own words: the words are the message, heard once, drawn as 4B (Caveat, ▶, 0:07)", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  const { id } = J(await up(kofi, WEBM, { headers: { "x-reason-voice": "1", "x-reason-seconds": "7" } }));
  await send(h, kofi, { id: "w-voice-0001", text: "also see if they take dogs, we might bring Juno", files: id, voice: "7" });
  assert.ok(await until(() => h.web.recent.length === 1));
  assert.equal(h.turns[0].text, "also see if they take dogs, we might bring Juno", "Reason reads the words, not a note that it can't listen");
  const a = h.turns[0].attachments[0];
  assert.equal(a.kind, "voice");
  assert.equal(a.transcribed, "browser");
  assert.equal(db.mediaItem(KOFI_C, a.media_id).coverage, "transcribed", "the record says it was heard");
  const line = convo.rowOut(db.messagesFor(KOFI_C)[0], { conversationId: KOFI_C });
  assert.match(line.html, /<p class="lbl"><span>YOU · VOICE · WEB · <\/span>/);
  assert.match(line.html, /<p class="said hand">also see if they take dogs, we might bring Juno<\/p><div class="slip achip" data-src="\/web\/media\/u\/[A-Za-z0-9_-]{22}\/voice-note\.webm"><button type="button" class="vplay ap" data-src="\/web\/media\/u\/[A-Za-z0-9_-]{22}\/voice-note\.webm" aria-pressed="false" aria-label="Play voice note, 7 seconds"><svg[^]*<span class="vt">0:07<\/span><\/span> · VOICE NOTE<\/span><\/span><\/div>$/);
});

test("a voice note with no words (Firefox): heard on the server by Reason's own listening, never the Anthropic API; heard once", async () => {
  const kofi = browser(KOFI_C);
  const { id } = J(await up(kofi, WEBM, { headers: { "x-reason-voice": "1", "x-reason-seconds": "4" } }));
  let asked = 0;
  const prep = await media.prepareSend({ conversationId: KOFI_C, text: "", files: [id], canHear: () => ({ ok: true }), listen: async ({ url }) => { asked++; assert.ok(uploads.localUpload(url), "the listener reads the file from disk"); return { ok: true, text: "book the 7pm table" }; } });
  assert.equal(asked, 1);
  assert.equal(prep.text, "book the 7pm table");
  // A retried send (the browser's id again) reuses the words: still one listen.
  const retry = await media.prepareSend({ conversationId: KOFI_C, text: "", files: [id], canHear: () => ({ ok: true }), listen: async () => { asked++; return { ok: true, text: "other" }; } });
  assert.equal(asked, 1, "never heard twice for one note");
  assert.equal(retry.text, "book the 7pm table");
  assert.equal(prep.attachments[0].transcribed, "server");
  // The router's listening then leaves it alone.
  let again = 0;
  const out = await voice.hearInto(prep.text, prep.attachments, { status: () => ({ ok: true }), listen: async () => { again++; return { ok: true, text: "x" }; } });
  assert.equal(again, 0, "never heard twice");
  assert.equal(out, "book the 7pm table");
  uploads.update(id, { transcript: null });
  // Nothing could hear it: it goes in unheard, the way a texted note does — and the thread never shows that framing.
  const none = await media.prepareSend({ conversationId: KOFI_C, text: "", files: [id], canHear: () => ({ ok: false }) });
  assert.match(none.text, /^\[they sent a voice note \(voice-note\.webm\)\. you cannot listen to it/);
  assert.equal(compose.ownWords(none.text, [{ kind: "voice" }]), "");
  // The page only offers the mic where the words can come from somewhere (webcompose.js).
  assert.match(compose.COMPOSE_JS, /if\(!mic\|\|!MR\|\|!GUM\|\|!window\.isSecureContext\|\|!\(SR\|\|R\.hear\)\)return;/);
  assert.match(compose.composeBoot(), /window\.REASON_WEB\.hear=false;/, "no GEMINI_API_KEY here, so no server listening");
});

test("a photo and a voice note texted in from iMessage draw in the thread, served from Web's own address, to that session only", async () => {
  const h = harness();
  const kofi = browser(KOFI_C), ama = browser(AMA_C);
  await h.router.deliver({ channel: "fake", externalId: "im-photo-1", from: KOFI, text: "", attachments: [{ url: "https://cdn.example/inbound/IMG_8846.png", filename: "IMG_8846.png", kind: "image" }], at: clock.now() });
  const row = db.messagesFor(KOFI_C).find(r => r.role === "user");
  const line = convo.rowOut(row, { conversationId: KOFI_C });
  assert.match(line.html, new RegExp(`<a class="photo" href="/web/media/m/${row.id}/0"[^>]*><img src="/web/media/m/${row.id}/0" alt="Photo you sent"`));
  assert.ok(!JSON.stringify(line).includes("cdn.example"));
  const fetchImpl = async (url) => { assert.equal(url, "https://cdn.example/inbound/IMG_8846.png"); return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }); };
  const got = await getMedia(kofi, `/web/media/m/${row.id}/0`, {}, fetchImpl);
  assert.equal(got.status, 200);
  assert.equal(got.headers["Content-Type"], "image/png");
  assert.equal((await getMedia(ama, `/web/media/m/${row.id}/0`, {}, fetchImpl)).status, 404, "another conversation's row is nothing");
  // A voice note heard by the router: its words (from the record) in Caveat, not the pipeline's framing.
  db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "fake", externalId: "im-voice-1", text: '[they sent a voice note. this is what they said in it, transcribed — treat it as their message: "running late"]', media: [{ url: "https://cdn.example/a.caf", filename: "Audio.caf", kind: "voice", media_id: 999999 }] });
  const vrow = db.messagesFor(KOFI_C).find(r => r.external_id === "im-voice-1");
  const media0 = db.recordMedia({ conversationId: KOFI_C, channel: "fake", externalId: "im-voice-1", ordinal: 1, kind: "voice", filename: "Audio.caf", url: "https://cdn.example/a.caf" });
  db.coverMedia(media0.id, { coverage: "transcribed", transcript: "running late", seconds: 3 });
  db.db.prepare("UPDATE messages SET media = ? WHERE id = ?").run(JSON.stringify([{ url: "https://cdn.example/a.caf", filename: "Audio.caf", kind: "voice", media_id: media0.id }]), vrow.id);
  const v = convo.rowOut(db.messagesFor(KOFI_C).find(r => r.id === vrow.id), { conversationId: KOFI_C });
  assert.match(v.html, /YOU · VOICE · IMESSAGE · [^]*<p class="said hand">running late<\/p><div class="slip achip"[^>]*><button type="button" class="vplay ap"[^>]*aria-label="Play voice note, 3 seconds">/);
  assert.ok(!v.html.includes("they sent"), "the model's framing never shows");
});

// ---------- message types the thread draws (4A, 4C) ----------

test("4A: Reason's own page and event links are paper cards; Web's own addresses never are; the approval card carries the nudge as intent", () => {
  assert.equal(convo.linkCard("https://files.heyreason.test/web/media/u/AAAAAAAAAAAAAAAAAAAAAA/x.png", KOFI_C), null);
  assert.match(convo.reasonBody("Put the three side by side:\nhttps://files.heyreason.test/p/abcdefgh12", KOFI_C), /<a class="card lcard"[^>]*><span class="lc-dom">FILES\.HEYREASON\.TEST<\/span><span class="lc-t">A page Reason made<\/span><span class="lc-go">Open <span aria-hidden="true">→<\/span><\/span><\/a>/);
  const ask = clock.now() - 60_000;
  db.askConfirmation({ conversationId: KOFI_C, action: "book", summary: "Hold the Hudson inn, $540", stakes: "money", askedAfterMsgs: 0 });
  db.db.prepare("UPDATE confirmations SET asked_at = ?").run(ask);
  db.writeMessage({ conversationId: KOFI_C, role: "assistant", channel: "web", text: "Found it.", at: ask - 1000 });
  const lines = db.messagesFor(KOFI_C).map(r => convo.rowOut(r, { conversationId: KOFI_C }));
  const page = convo.renderConversation({ account: db.getAccount(KOFI_C), csrf: "c", lines, more: false, sendId: "s", items: [], approvals: convo.waitingApprovals(KOFI_C) });
  assert.match(page, /<div class="msg re approval"><p class="lbl">REASON · WEB · [0-9]{1,2}:[0-9]{2} [AP]M<\/p><div class="card appr"><p class="lbl pen">NEEDS YOUR APPROVAL<\/p><p class="appr-t">Hold the Hudson inn, \$540<\/p><p class="lbl">NOTHING CHARGED YET<\/p><a class="appr-go" href="\/web\/ongoing\/approval\/\d+">Review details <span aria-hidden="true">→<\/span><\/a><\/div><p class="hand">just tell me in the chat when you want it\.<\/p>/);
  assert.ok(!/reply ["“']?book it/i.test(page), "never a phrase to type");
});

test("4C: a numbered reply is 01 02 03 in pen between dashed rules", () => {
  const html = convo.reasonBody("Here's the plan.\n1. Friday: drive up\n2. Saturday: the trail\n3. Sunday: home by 3", KOFI_C);
  assert.match(html, /<ol class="rl"><li><span class="rl-n" aria-hidden="true">01<\/span><span class="rl-t">Friday: drive up<\/span><\/li><li><span class="rl-n" aria-hidden="true">02<\/span>[^]*03<\/span><span class="rl-t">Sunday: home by 3<\/span><\/li><\/ol>/);
});

// ---------- the composer's states, as drawn ----------

test("composer 01–04 and Listening (D): the reference's copy, real buttons with names, roles", () => {
  const html = compose.composerHtml({ csrf: "c", sendId: "s", maxText: 4000 });
  assert.match(html, /<div class="cdrop" aria-hidden="true"><div><svg[^]*?<\/svg><span class="hand">let go\. i’ll read it\.<\/span><span class="lbl">ON DESKTOP, DROP ANYWHERE<\/span><\/div><\/div>/, "3E: drop anywhere");
  assert.match(html, /<div class="upl" hidden><ul class="on-line" aria-label="Attached"><\/ul>/, "3B: the slips' shelf");
  assert.match(html, /<button class="ic d-stop" type="button" aria-label="Stop without sending">[^]*<span class="d-clock" role="timer"[^>]*>0:00<\/span><button class="send d-send" type="button" aria-label="Stop and send">/, "03: dictating on the line");
  assert.match(html, /<p class="hand c-note" role="alert" hidden><\/p>/, "an upload error is one Caveat line");
  const ls = compose.listeningHtml();
  assert.match(ls, /<div class="listen" role="dialog" aria-modal="true" aria-label="Listening" data-mode="listening" tabindex="-1" hidden>/);
  assert.match(ls, /LISTENING · <span class="ls-t" role="timer">0:00<\/span>/);
  assert.match(ls, /<button class="ls-never" type="button"><span aria-hidden="true">←<\/span><span class="u">NEVER MIND<\/span><\/button>/);
  assert.match(ls, /<button class="ls-send" type="button">Send it <span aria-hidden="true">→<\/span><\/button>/);
  assert.match(ls, /<span>PAUSE AND IT SENDS<\/span><span class="ls-sp"> · SPACE TO KEEP TALKING<\/span>/, "4A: the phone says PAUSE AND IT SENDS; a desk adds Space");
  assert.match(ls, /<span class="ls-fin"><\/span> <span class="ls-int"><\/span>/, "final words and not-yet-final ones");
  assert.match(compose.COMPOSE_CSS, /\.ls-words\{[^}]*var\(--hand\);color:var\(--pen\)/, "the transcript in Caveat, pen");
  assert.match(compose.COMPOSE_CSS, /\.ls-int\{color:var\(--muted\)\}/, "not-yet-final words muted");
  assert.match(compose.COMPOSE_CSS, /\.dict\{[^}]*border-top:1px solid var\(--pen\)/, "dictating turns the rule pen");
  assert.match(compose.COMPOSE_CSS, /\.cdrop\{[^}]*border:1\.5px dashed var\(--ink\)/);
  // Pausing sends, in Listening only; Space keeps it open.
  assert.match(compose.COMPOSE_JS, /if\(r\.full&&r\.spoke&&Date\.now\(\)-r\.last>2600/);
  assert.match(compose.COMPOSE_JS, /e\.key===' '\|\|e\.code==='Space'[^]*rec\.last=Date\.now\(\)/);
  // Every word typed or said reaches the page as text, never markup.
  assert.ok(!/innerHTML=(?!"|\$\{JSON)/.test(compose.COMPOSE_JS.replace(/b\.innerHTML="[^"]*"/g, "")), "no innerHTML from anything a person made");
});

// ---------- over real HTTP ----------

test("real HTTP: POST /web/upload through src/http.js, a send naming it, the history line, the file back — and 404 to a stranger", async () => {
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const kofi = browser(KOFI_C), ama = browser(AMA_C);
  const call = (method, path, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
  try {
    const own = { cookie: kofi.cookie, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" };
    const u = await call("POST", "/web/upload", { headers: { ...own, "x-reason-csrf": kofi.csrf, "x-reason-name": "listing.png", "content-type": "image/png", "content-length": PNG.length }, body: PNG });
    assert.equal(u.status, 200, u.body.toString());
    const j = JSON.parse(u.body);
    const s = await call("POST", "/web/send", { headers: { ...own, accept: "application/json", "x-reason-csrf": kofi.csrf, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ c: kofi.csrf, id: "w-http-00001", text: "same place?", files: j.id }).toString() });
    assert.equal(s.status, 200, s.body.toString());
    assert.ok(await until(() => h.web.recent.length === 1));
    const hist = JSON.parse((await call("GET", "/web/history?after=0", { headers: { cookie: kofi.cookie, accept: "application/json" } })).body);
    assert.equal(hist.messages[0].cid, "w-http-00001");
    assert.match(hist.messages[0].html, /<img src="\/web\/media\/u\/[A-Za-z0-9_-]{22}\/listing\.png" alt="Photo you sent"/);
    const back = await call("GET", j.src, { headers: { cookie: kofi.cookie } });
    assert.equal(back.status, 200);
    assert.equal(back.headers["content-type"], "image/png");
    assert.ok(Buffer.compare(back.body, PNG) === 0);
    assert.equal((await call("GET", j.src, { headers: { cookie: ama.cookie } })).status, 404);
    assert.equal((await call("GET", j.src)).status, 404);
    const big = await call("POST", "/web/upload", { headers: { ...own, "x-reason-csrf": kofi.csrf, "x-reason-name": "big.png" }, body: Buffer.concat([PNG, Buffer.alloc(uploads.LIMITS.image)]) });
    assert.equal(big.status, 413, "past the photo cap, over the wire");
    // The page's CSP lets a photo preview and a voice note play from this host (blob: for the moment before upload).
    const page = await call("GET", "/web?thread", { headers: { cookie: kofi.cookie } });
    assert.match(page.headers["content-security-policy"], /img-src 'self' data: blob:; media-src 'self' blob:;/);
    assert.equal(h.fake.sent.length, 0, "nothing went to the phone");
  } finally {
    await new Promise(r => server.close(r));
  }
});

// ---------- v2: uploads (sheet-uploads 3A–3E), voice (sheet-voice 4A–4E), L9 ----------

const { docsFor, docText, isDocx } = await import("../src/docread.js");
const doing = await import("../src/doing.js");
const { fitPhoto, FIT_BYTES } = await import("../src/webshrink.js");
const { Document, Packer, Paragraph } = await import("docx");
const DOCX = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Rent is $2,400 a month."), new Paragraph("No dogs over 40 lb.")] }] }));

test("3C limits: the typed line is the server's own numbers — PHOTOS, PDFS, DOCS · UP TO 20 MB EACH", () => {
  assert.equal(uploads.LIMITS_LINE, "PHOTOS, PDFS, DOCS · UP TO 20 MB EACH");
  for (const k of ["image", "pdf", "doc"]) assert.equal(uploads.LIMITS[k], 20 * 1024 * 1024, k);
  const html = compose.composerHtml({ csrf: "c", sendId: "s", maxText: 4000 });
  assert.match(html, /<div class="upfail" role="status" hidden><div class="uf-list"><\/div><p class="lbl uf-lim">PHOTOS, PDFS, DOCS · UP TO 20 MB EACH<\/p><\/div>/);
});

test("docs: a Word file and plain text are taken and read; a video or a program is refused at the door", async () => {
  const kofi = browser(KOFI_C);
  assert.ok(isDocx(DOCX));
  const d = J(await up(kofi, DOCX, { name: "lease.docx" }));
  assert.equal(d.kind, "doc");
  assert.equal(d.label, "LEASE.DOCX");
  const t = J(await up(kofi, Buffer.from("# Packing\n- passport\n"), { name: "notes.md" }));
  assert.equal(t.kind, "doc");
  assert.equal(t.name, "notes.md", "plain text keeps a name that says text");
  assert.equal((await up(kofi, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64)]), { name: "clip.mp4" })).status, 415, "a video is not a photo, a PDF or a doc");
  assert.equal((await up(kofi, Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0xff, 0xff]), { name: "setup.exe" })).status, 415);
  // The text the model is handed.
  assert.match(docText(DOCX).text, /^Rent is \$2,400 a month\.\nNo dogs over 40 lb\.$/);
  const atts = uploads.attachmentsFor(KOFI_C, [d.id, t.id]);
  assert.match((await docsFor(atts, { conversationId: AMA_C })).notes[0], /no longer on this machine/, "not Ama's to read");
  const read = await docsFor(atts, { conversationId: KOFI_C });
  assert.equal(read.notes.length, 2);
  assert.match(read.notes[0], /^they sent a document \(lease\.docx\) — here is the text from it:\nRent is \$2,400 a month\./);
  assert.match(read.notes[1], /passport/);
  assert.match(read.seen[0], /you read it when it arrived/);
  // A crafted entity can't take the turn down with it.
  const { docxText } = await import("../src/docread.js");
  assert.doesNotThrow(() => docxText(DOCX));
  assert.equal((await import("../src/docread.js")).docText(Buffer.from("&#99999999; &#xFFFFFFF; fine")).ok, true);
});

test("a photo past what the model looks at (7 MB) is made to fit on the way in, not refused; one that can't be is 413", async () => {
  const kofi = browser(KOFI_C);
  const big = Buffer.concat([PNG, Buffer.alloc(FIT_BYTES + 10)]);
  const small = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z", "base64");
  let fitted = 0;
  const call = (fit) => media.uploadRequest({ account: db.getAccount(KOFI_C), headers: H(kofi, { "x-reason-csrf": kofi.csrf, "x-reason-name": "camera.png" }), readBody: async () => big, fit });
  const ok = J(await call(async (b) => { fitted++; assert.equal(b.length, big.length); return { ok: true, bytes: small, changed: true }; }));
  assert.equal(fitted, 1);
  assert.equal(ok.kind, "image");
  assert.equal(ok.name, "camera.jpg");
  assert.equal(uploads.meta(ok.id).bytes, small.length);
  assert.equal((await call(async () => ({ ok: false }))).status, 413);
  // Already small enough: as it was, never touched.
  assert.deepEqual(await fitPhoto(PNG, { resizer: null }), { ok: true, bytes: PNG, changed: false });
  assert.deepEqual(await fitPhoto(big, { resizer: null }), { ok: false });
  // A pixel bomb is refused before anything decodes it.
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(60000, 16); bomb.writeUInt32BE(60000, 20);
  assert.deepEqual(await fitPhoto(Buffer.concat([bomb, Buffer.alloc(FIT_BYTES)]), { resizer: { bin: "/bin/false", args: () => [] } }), { ok: false });
});

test("4B / L9, no speech recognition in the browser: the words are written down at upload, and the send never listens twice", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  let heard = 0;
  const listen = async ({ url }) => { heard++; assert.match(url, /^https:\/\/files\.heyreason\.test\/web\/media\/u\//); return { ok: true, text: "hold the hudson one for me" }; };
  const r = J(await media.uploadRequest({ account: db.getAccount(KOFI_C), headers: H(kofi, { "x-reason-csrf": kofi.csrf, "x-reason-voice": "1", "x-reason-hear": "1", "x-reason-seconds": "4" }), readBody: async () => WEBM, listen, canHear: () => ({ ok: true }) }));
  assert.equal(r.kind, "voice");
  assert.equal(r.words, "hold the hudson one for me");
  assert.equal(heard, 1);
  // Without the ask, nothing is heard at upload.
  const quiet = J(await media.uploadRequest({ account: db.getAccount(KOFI_C), headers: H(kofi, { "x-reason-csrf": kofi.csrf, "x-reason-voice": "1" }), readBody: async () => WEBM, listen, canHear: () => ({ ok: true }) }));
  assert.equal(quiet.words, undefined);
  assert.equal(heard, 1);
  assert.equal((await send(h, kofi, { id: "w-voice-early1", text: "", files: r.id })).status, 200);
  assert.ok(await until(() => h.turns.length === 1));
  assert.equal(h.turns[0].text, "hold the hudson one for me");
  assert.equal(heard, 1, "heard once, at upload");
  // Heard and nothing came of it: marked, and the send doesn't listen again either.
  const deaf = J(await media.uploadRequest({ account: db.getAccount(KOFI_C), headers: H(kofi, { "x-reason-csrf": kofi.csrf, "x-reason-voice": "1", "x-reason-hear": "1" }), readBody: async () => WEBM, listen: async () => { heard++; return { ok: false, error: "x" }; }, canHear: () => ({ ok: true }) }));
  assert.equal(heard, 2);
  const prep = await media.prepareSend({ conversationId: KOFI_C, text: "", files: [deaf.id], listen: async () => { heard++; return { ok: true, text: "no" }; }, canHear: () => ({ ok: true }) });
  assert.equal(heard, 2, "never a second listen");
  assert.match(prep.text, /voice/i);
});

test("3D: 'on it.' says what Reason is doing from the turn's own record — reading the lease… — and nothing it isn't", async () => {
  assert.equal(doing.nameOf("lease.pdf"), "the lease");
  assert.equal(doing.nameOf("Lease_Agreement-2026.pdf"), "the lease agreement 2026");
  assert.equal(doing.nameOf("IMG_2041.pdf"), null);
  assert.equal(doing.nameOf("document.pdf"), null);
  assert.equal(doing.lineFor([{ kind: "pdf", filename: "lease.pdf" }]), "reading the lease…");
  assert.equal(doing.lineFor([{ kind: "pdf", filename: "scan0001.pdf" }]), "reading the PDF…");
  assert.equal(doing.lineFor([{ kind: "doc", filename: "notes.md" }]), "reading the notes…");
  assert.equal(doing.lineFor([{ kind: "pdf", filename: "a.pdf" }, { kind: "doc", filename: "b.docx" }]), "reading the 2 files…");
  assert.equal(doing.lineFor([{ kind: "image", filename: "x.png" }]), "looking at the photo…");
  assert.equal(doing.lineFor([{ kind: "image" }, { kind: "image" }]), "looking at the 2 photos…");
  assert.equal(doing.lineFor([{ kind: "voice" }]), null, "a voice note's words are the message; nothing to say");
  assert.equal(doing.lineFor([]), null);
  // While a turn with the lease runs, the open tab's history says so; when it ends, it doesn't.
  doing.resetDoing();
  // The turn below waits on a promise with no timer behind it, and the send's own wait is unref'd:
  // something has to keep the loop awake while it's held.
  const awake = setInterval(() => {}, 50);
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({ turn: async ({ text }) => { await gate; return `re: ${text}`; } });
  const kofi = browser(KOFI_C);
  const { id } = J(await media.uploadRequest({ account: db.getAccount(KOFI_C), headers: H(kofi, { "x-reason-csrf": kofi.csrf, "x-reason-name": "lease.pdf" }), readBody: async () => PDF, readPdf: async () => ({ ok: true, pages: 4 }) }));
  assert.equal((await send(h, kofi, { id: "w-doing-00001", text: "Is this the same place?", files: id })).status, 200);
  assert.ok(await until(() => h.turns.length === 1));
  const hist = () => J(convo.historyRequest({ account: db.getAccount(KOFI_C), query: { after: "0" } }));
  assert.equal(hist().doing, "reading the lease…");
  assert.equal(J(convo.historyRequest({ account: db.getAccount(AMA_C), query: { after: "0" } })).doing, null, "nobody else's tab hears it");
  release();
  assert.ok(await until(() => hist().doing === null));
  assert.equal(doing.doingFor(KOFI_C, { at: Date.now() + doing.STALE_MS + 1 }), null);
  // Two turns at once: the newer one's line shows; when it ends first, the older one's is back.
  const endA = doing.begin(KOFI_C, [{ kind: "pdf", filename: "lease.pdf" }]);
  const endB = doing.begin(KOFI_C, [{ kind: "image" }]);
  assert.equal(doing.doingFor(KOFI_C), "looking at the photo…");
  endB(); assert.equal(doing.doingFor(KOFI_C), "reading the lease…");
  endA(); endA(); assert.equal(doing.doingFor(KOFI_C), null);
  clearInterval(awake);
});

test("3A + 4A–4E as drawn: the + sheet, the slips' states, FROM YOUR VOICE, PAUSED + SENDING IN, writing it down…, I can't hear you yet.", () => {
  const html = compose.composerHtml({ csrf: "c", sendId: "s", maxText: 4000 });
  assert.match(html, /<div class="addsheet" role="dialog" aria-label="Add to your message" hidden><span class="lbl as-h">ADD TO YOUR MESSAGE<\/span><button class="as-pick" type="button" data-pick="media">Photo or video<\/button><button class="as-pick" type="button" data-pick="camera">Take a photo<\/button><button class="as-pick" type="button" data-pick="file">A file or PDF<\/button><button class="as-never" type="button">NEVER MIND<\/button><\/div>/, "3A");
  assert.match(html, /<input class="c-file" data-pick="camera" type="file" accept="image\/\*" capture="environment" hidden/, "Take a photo opens the camera");
  assert.match(html, /<p class="lbl fromvoice" hidden>FROM YOUR VOICE · EDIT ANYTHING<\/p>/, "4C");
  assert.match(html, /<h2 id="mo-h" class="mo-h" tabindex="-1">I can’t hear you yet\.<\/h2><p class="mo-p">Your browser hasn’t allowed the microphone\. Allow it next to the address bar, then try again\.<\/p><button class="mo-try" type="button">Try again <span aria-hidden="true">→<\/span><\/button><p class="hand mo-or">or just type it\. that works too\.<\/p>/, "4E");
  const ls = compose.listeningHtml();
  assert.match(ls, /<span class="ls-paused">PAUSED<\/span>/, "4B header");
  assert.match(ls, /<div class="ls-count" role="status"><span class="ls-cn">SENDING IN 3…<\/span><span class="ls-dots" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span><\/div>/, "4B countdown");
  assert.match(ls, /<button class="ls-keep" type="button">KEEP TALKING<\/button><button class="ls-edit" type="button">Edit it first<\/button><button class="ls-now" type="button">Send now <span aria-hidden="true">→<\/span><\/button>/, "4B actions");
  assert.match(ls, /<p class="hand ls-writing" role="status">writing it down…<\/p><div class="ls-ruled" aria-hidden="true">/, "L9");
  assert.match(compose.COMPOSE_CSS, /\.on-line li\[data-state=up\]\{opacity:\.55\}/, "3B: uploading is faded, no bars");
  assert.ok(!/progress/i.test(compose.COMPOSE_JS + compose.COMPOSE_CSS), "no progress bars");
});
