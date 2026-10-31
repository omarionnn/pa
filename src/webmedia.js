// Reason Web: the routes for what is not words (HANDOFF §3: "Photo you sent", "File slip", "Voice
// note in the thread"; composer states 02 and 04, Listening).
//
//   POST /web/upload               one photo, PDF or recorded voice note into this conversation's
//                                  keeping (src/webuploads.js). Same-origin and the session's secret,
//                                  like /web/send; the bytes decide what it is; size-capped by kind.
//                                  Nothing reaches Reason until the message naming it is sent.
//   GET  /web/media/u/<id>[/<name>] one of those files, back to a signed-in session of ITS conversation
//   GET  /web/media/m/<row>/<n>    the nth thing on one history row of this conversation — so a photo
//                                  or voice note texted in from iMessage draws in the thread too. A
//                                  CDN photo is fetched through src/media.js (HEIC → JPEG), never
//                                  linked: the browser only ever sees Reason's own address.
//
// Everything answers the same 404 to anybody else: another person's file, a signed-out browser, a
// guessed id. There is no public URL for any of it.
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import * as uploads from "./webuploads.js";
import { fetchImage } from "./media.js";
import { cardFile } from "./choicecards.js";
import { checkUrl } from "./pictures.js";
import { pdfText } from "./pdf.js";
import { hear, hearingStatus, cannotHearLine } from "./voice.js";
import { clock } from "./config.js";
import { isLinkPreviewAttachment } from "./linkpreview.js";
import { sentFile, mimeOf } from "./sentfiles.js";
import { playable } from "./webaudio.js";
import { fitPhoto, FIT_BYTES } from "./webshrink.js";
import { readCookie } from "./pages/access.js";
import { SECURITY_HEADERS, sameOrigin, sessionAccount } from "./pages/websignin.js";

/** Uploads per conversation per ten minutes. */
export const UPLOAD_LIMIT = 40;

const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};
const json = (status, obj) => {
  const body = JSON.stringify(obj);
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
};
const notFound = () => ({ status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": 9 }, body: "Not found" });

const recent = new Map();
function underLimit(conv, now = clock.now()) {
  const t = (recent.get(conv) ?? []).filter(x => now - x < 10 * 60_000);
  if (t.length >= UPLOAD_LIMIT) { recent.set(conv, t); return false; }
  t.push(now); recent.set(conv, t);
  return true;
}
/** For tests. */
export const resetUploadLimits = () => recent.clear();

/** The request's body, whole, or null past `max` (the read stops there). */
export function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > max) { over = true; resolve(null); req.resume?.(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

/** The pages of a PDF, for its slip (`LEASE.PDF · 4 PP`). Null when the reader can't say. */
async function pagesOf(bytes, read = pdfText) {
  try { const r = await read({ bytes, maxPages: 1 }); return Number(r?.pages) || null; } catch { return null; }
}

/**
 * POST /web/upload. The body is the file itself; `X-Reason-Name` its name (URI-encoded),
 * `X-Reason-Voice: 1` for a recording from the mic (with `X-Reason-Seconds`).
 */
export async function uploadRequest({ account, headers = {}, readBody, log = () => {}, readPdf = pdfText, fit = fitPhoto, listen = hear, canHear = hearingStatus }) {
  const token = readCookie(headers.cookie);
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"], db.pageSessionCsrf(token))) {
    log({ web_upload_refused: "origin_or_token" });
    return json(403, { ok: false, error: "not_from_this_page" });
  }
  const conv = account.conversation_id;
  const claimed = Number(headers["content-length"] ?? 0);
  if (claimed > uploads.MAX_UPLOAD_BYTES) return json(413, { ok: false, error: "too_big" });
  if (!underLimit(conv)) { log({ web_upload_refused: "rate_limited" }); return json(429, { ok: false, error: "slow_down" }); }
  const bytes = await readBody(uploads.MAX_UPLOAD_BYTES);
  if (bytes == null) return json(413, { ok: false, error: "too_big" });
  let name = "";
  try { name = decodeURIComponent(String(headers["x-reason-name"] ?? "")); } catch { name = ""; }
  const voice = String(headers["x-reason-voice"] ?? "") === "1";
  // iMessage's link card, dragged in from Messages (src/linkpreview.js): not kept, not handed to
  // Reason, and not an error either — the page just leaves it off the message.
  if (!voice && isLinkPreviewAttachment({ filename: name, mime: headers["content-type"] })) {
    log({ web_upload_dropped: "link_preview" });
    return json(200, { ok: true, dropped: "link_preview" });
  }
  const seconds = Math.min(600, Math.max(0, Math.round(Number(headers["x-reason-seconds"]) || 0)));
  // A photo bigger than the model looks at is made to fit here (src/webshrink.js), not refused.
  let body = bytes;
  const what = voice ? null : uploads.classify(bytes);
  if (what?.kind === "image" && bytes.length <= uploads.LIMITS.image && bytes.length > FIT_BYTES) {
    const f = await fit(bytes);
    if (!f.ok) { log({ web_upload_refused: "could_not_fit", bytes: bytes.length }); return json(413, { ok: false, error: "too_big", kind: "image" }); }
    body = f.bytes;
    if (f.changed) name = (name.replace(/\.[A-Za-z0-9]{2,5}$/, "") || "photo") + ".jpg";
  }
  const m = uploads.store({ conversationId: conv, bytes: body, name: voice ? `voice-note` : name, voice, extra: voice && seconds ? { seconds } : {} });
  if (m.error) {
    log({ web_upload_refused: m.error, bytes: bytes.length });
    return json(m.error === "too_big" ? 413 : m.error === "unsupported" ? 415 : 400, { ok: false, error: m.error, ...(m.kind ? { kind: m.kind } : {}) });
  }
  let rec = m;
  if (m.kind === "pdf") { const pages = await pagesOf(bytes, readPdf); if (pages) rec = uploads.update(m.id, { pages }) ?? m; }
  // Voice, sheet-voice 4B / L9 where the browser hears nothing itself (Firefox): the words written
  // down here, now, so they can be shown before the note is sent. Kept on the upload, so the send
  // that follows never listens twice (prepareSend).
  let words = null;
  if (rec.kind === "voice" && String(headers["x-reason-hear"] ?? "") === "1" && canHear().ok) {
    let r = null;
    try { r = await listen({ url: uploads.uploadUrl(rec.id, rec.name), filename: rec.name }); } catch (e) { r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    if (r?.ok && !r.silent && String(r.text ?? "").trim()) {
      words = String(r.text).trim();
      rec = uploads.update(rec.id, { transcript: words }) ?? rec;
      log({ web_voice_heard_early: rec.name, chars: words.length });
    } else {
      // Tried once and nothing came of it: marked, so the send that follows doesn't listen again.
      rec = uploads.update(rec.id, { unheard: true }) ?? rec;
      log({ web_voice_unheard_early: rec.name, why: r?.error ?? (r?.silent ? "silent" : "no words") });
    }
  }
  log({ web_upload: rec.kind, bytes: rec.bytes });
  return json(200, { ok: true, id: rec.id, kind: rec.kind, name: rec.name, label: uploads.slipLabel(rec), pages: rec.pages ?? null, seconds: rec.seconds ?? null, src: uploads.uploadPath(rec.id, rec.name), ...(words ? { words } : {}) });
}

/**
 * What a Web message with files goes to the router as. A voice note's words: the ones the browser
 * heard as it was said (`text`), or — where the browser has no speech recognition — heard here, by
 * the same listening a texted voice note gets (src/voice.js hear, Gemini; never the Anthropic API).
 * Either way the words are the message, and the note is marked heard so nothing listens twice.
 * When nothing could hear it, the note goes in unheard, exactly as a texted one would.
 */
export async function prepareSend({ conversationId, text = "", files = [], listen = hear, canHear = hearingStatus, log = () => {} }) {
  const all = uploads.attachmentsFor(conversationId, files);
  if (!all) return null;
  const atts = all.filter(a => !isLinkPreviewAttachment({ filename: a.filename }));
  let words = String(text ?? "");
  for (const a of atts) {
    if (a.kind !== "voice") continue;
    if (words.trim()) {
      Object.assign(a, { transcribed: "browser", transcript: words.trim() });
      uploads.update(a.web_upload, { transcript: words.trim() });
      continue;
    }
    // Heard already (a retried send): the same words, never a second listen.
    const kept = uploads.meta(a.web_upload)?.transcript;
    if (kept) { words = kept; Object.assign(a, { transcribed: "server", transcript: kept }); continue; }
    let r = null;
    if (canHear().ok && !uploads.meta(a.web_upload)?.unheard) {
      try { r = await listen({ url: a.url, filename: a.filename }); } catch (e) { r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    }
    if (r?.ok && !r.silent && String(r.text ?? "").trim()) {
      words = String(r.text).trim();
      Object.assign(a, { transcribed: "server", transcript: words, ...(r.seconds && !a.seconds ? { seconds: Math.round(r.seconds) } : {}) });
      uploads.update(a.web_upload, { transcript: words });
      log({ web_voice_heard: a.filename, chars: words.length });
    } else {
      words = [words, cannotHearLine(a)].filter(s => s.trim()).join("\n");
      log({ web_voice_unheard: a.filename, why: r?.error ?? (r?.silent ? "silent" : "no listening") });
    }
  }
  return { text: words, attachments: atts };
}

// ---------------------------------------------------------------- serving

const RANGE = /^bytes=(\d*)-(\d*)$/;
/** Bytes to the browser: private, never cached by anything shared, ranges for audio (Safari asks for them). */
function bytesOut({ bytes, mime, name = "", headers = {}, method = "GET" }) {
  // A recording converted for the browser (src/webaudio.js) is named for what it now is.
  if (mime === "audio/mp4" && name && !/\.(m4a|mp4)$/i.test(name)) name = String(name).replace(/\.[a-z0-9]{1,5}$/i, "") + ".m4a";
  const base = {
    "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400",
    "Referrer-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", "Accept-Ranges": "bytes",
    // A PDF, a picture or a recording opens in the browser; anything else (a .docx, a sheet) comes
    // down as the file under its own name, which iPhone Safari hands to Quick Look.
    "Content-Disposition": `${/^(application\/pdf|image\/(png|jpeg|gif|webp|heic)$|audio\/|video\/|text\/plain)/.test(mime) ? "inline" : "attachment"}; filename="${String(name || "file").replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name || "file")}`,
    ...(mime === "application/pdf" ? {} : { "Content-Security-Policy": "default-src 'none'; sandbox" }),
  };
  const r = RANGE.exec(String(headers.range ?? ""));
  if (r && (r[1] || r[2])) {
    let start = r[1] ? Number(r[1]) : Math.max(0, bytes.length - Number(r[2]));
    let end = r[1] && r[2] ? Math.min(Number(r[2]), bytes.length - 1) : bytes.length - 1;
    if (start >= bytes.length || start > end) return { status: 416, headers: { ...base, "Content-Range": `bytes */${bytes.length}`, "Content-Length": 0 }, body: "" };
    const part = bytes.subarray(start, end + 1);
    return { status: 206, headers: { ...base, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": part.length }, body: method === "HEAD" ? "" : part };
  }
  return { status: 200, headers: { ...base, "Content-Length": bytes.length }, body: method === "HEAD" ? "" : bytes };
}

function serveUpload(m, opts) {
  if (!m || !existsSync(uploads.filePath(m))) return notFound();
  return bytesOut({ bytes: readFileSync(uploads.filePath(m)), mime: m.mime, name: m.name, ...opts });
}

const AUDIO_MIME = { ".caf": "audio/x-caf", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac", ".amr": "audio/amr", ".webm": "audio/webm" };
const cache = new Map(); // url → { bytes, mime }, a few recent CDN fetches, at most CACHE_BYTES in all
const CACHE_BYTES = 64 * 1024 * 1024;
const remember = (url, v) => {
  cache.set(url, v);
  let total = 0; for (const x of cache.values()) total += x.bytes.length;
  while (cache.size > 1 && (cache.size > 24 || total > CACHE_BYTES)) { const k = cache.keys().next().value; total -= cache.get(k).bytes.length; cache.delete(k); }
  return v;
};

/** One CDN file, fetched the careful way (https only, never this machine's network, capped). */
async function fetchRemote(a, { fetchImpl = globalThis.fetch } = {}) {
  if (cache.has(a.url)) return cache.get(a.url);
  if (a.kind === "image") {
    const got = await fetchImage({ url: a.url, filename: a.filename, fetchImpl });
    return got.ok ? remember(a.url, { bytes: Buffer.from(got.base64, "base64"), mime: got.mediaType }) : null;
  }
  try {
    // Every hop re-checked (https, never this machine's network), like fetchImage; the body capped as it streams.
    let target = a.url, res = null;
    for (let hop = 0; hop < 4; hop++) {
      const ok = checkUrl(target);
      if (!ok.ok) return null;
      res = await fetchImpl(ok.url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = res.headers?.get?.("location");
      if (!next || hop === 3) return null;
      target = new URL(next, ok.url).href;
    }
    if (!res?.ok) return null;
    if (Number(res.headers?.get?.("content-length") ?? 0) > uploads.MAX_UPLOAD_BYTES) return null;
    const chunks = []; let size = 0;
    if (res.body && typeof res.body[Symbol.asyncIterator] === "function") {
      for await (const c of res.body) { size += c.length; if (size > uploads.MAX_UPLOAD_BYTES) return null; chunks.push(Buffer.from(c)); }
    } else chunks.push(Buffer.from(await res.arrayBuffer()));
    const bytes = Buffer.concat(chunks);
    if (!bytes.length || bytes.length > uploads.MAX_UPLOAD_BYTES) return null;
    const ext = extname(String(a.filename || a.url).split("?")[0]).toLowerCase();
    const mime = a.kind === "pdf" ? "application/pdf" : (AUDIO_MIME[ext] ?? mimeOf(a.filename || a.url, a.mimeType));
    return remember(a.url, { bytes, mime });
  } catch { return null; }
}

/** GET /web/media/m/<row>/<n>: the nth attachment on a history row of THIS conversation. */
export async function serveRowMedia({ account, rowId, index, headers = {}, method = "GET", fetchImpl }) {
  const row = db.db.prepare("SELECT media FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL").get(Number(rowId), account.conversation_id);
  let media = [];
  try { media = JSON.parse(row?.media || "[]"); } catch { media = []; }
  const a = media[Number(index)];
  // A file Reason sent keeps no address on the row: it is served from where the send read it.
  if (a && !a.url) {
    const f = sentFile(account.conversation_id, rowId);
    if (!f || Number(index) !== 0) return notFound();
    // A voice note or call recording: something the browser plays (src/webaudio.js), from its own root only.
    if (f.audio) return bytesOut({ ...(await playable({ path: f.path, root: f.root, mime: f.mime })), name: a.filename || f.name, headers, method });
    return bytesOut({ bytes: readFileSync(f.path), mime: f.mime, name: a.filename || f.name, headers, method });
  }
  if (!a?.url) return notFound();
  // A choice card Reason drew (src/choicecards.js): its own file on this machine, by name only.
  if (String(a.url).startsWith("card:")) {
    const file = cardFile(String(a.url).slice(5));
    return file && existsSync(file) ? bytesOut({ bytes: readFileSync(file), mime: "image/jpeg", name: a.filename, headers, method }) : notFound();
  }
  const id = uploads.uploadIdOf(a.url);
  if (id) {
    const m = uploads.meta(id);
    return m && m.conversationId === account.conversation_id ? serveUpload(m, { headers, method }) : notFound();
  }
  const got = await fetchRemote(a, { fetchImpl });
  if (!got) return notFound();
  // A voice note texted in is a .caf: Chrome plays none of them, so it goes out as .m4a.
  if (String(got.mime).startsWith("audio/")) return bytesOut({ ...(await playable({ bytes: got.bytes, mime: got.mime })), name: a.filename, headers, method });
  return bytesOut({ ...got, name: a.filename, headers, method });
}

/**
 * Everything under /web/upload and /web/media/, from src/http.js. `readBody(max)` reads the raw body
 * up to `max` bytes (null past it).
 */
export async function webMediaRoute({ path, method, headers = {}, readBody, log = () => {}, fetchImpl }) {
  const account = sessionAccount(headers);
  if (path === "/web/upload") {
    if (method !== "POST") return { ...json(405, { ok: false, error: "post_only" }), headers: { ...json(405, {}).headers, Allow: "POST" } };
    if (!account) return json(401, { ok: false, error: "signed_out" });
    return uploadRequest({ account, headers, readBody, log });
  }
  if (method !== "GET" && method !== "HEAD") return notFound();
  if (!account) return notFound();
  let m;
  if ((m = /^\/web\/media\/u\/([A-Za-z0-9_-]{22})(?:\/[^/]*)?$/.exec(path))) {
    const rec = uploads.meta(m[1]);
    return rec && rec.conversationId === account.conversation_id ? serveUpload(rec, { headers, method }) : notFound();
  }
  if ((m = /^\/web\/media\/m\/(\d{1,15})\/(\d{1,2})$/.exec(path))) return serveRowMedia({ account, rowId: m[1], index: m[2], headers, method, fetchImpl });
  return notFound();
}
