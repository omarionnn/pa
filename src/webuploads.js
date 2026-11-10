// Reason Web: a photo, a PDF or a voice note somebody hands Reason from the browser.
//
// A text's attachment arrives as a provider's CDN link (`media_url`), and everything that reads one
// — vision (src/media.js fetchImage, HEIC converted first), the PDF reader (fetchPdf → pdftotext),
// listening (src/voice.js hear) — starts from that link. A browser has no CDN, so Web keeps the bytes
// here, on this machine, and gives each file a link of the same shape: an https address on Reason's
// own pages host, `/web/media/u/<id>/<name>`. The attachment then goes through the router exactly as
// a text's does (`{ url, filename, kind }`, the kinds src/channels/sendblue.js attachmentOf uses), and
// the readers fetch it — except that `localUpload` answers that fetch from disk, so nothing goes out
// over the network and nothing about the file is public. The same address, asked for by a browser,
// is served only to a signed-in session of the conversation it belongs to (src/webmedia.js).
//
// What is accepted is decided by the bytes, never the name or the browser's type: a photo the model
// can read or this machine can convert (src/pictures.js sniff), a real PDF, or a recorded voice note.
// Anything else is refused at the door. Kept like a text's media link is: 30 days.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config, clock } from "./config.js";
import * as zonescope from "./zonescope.js";
import { sniff, READABLE } from "./pictures.js";
import { isPdfBytes } from "./pdf.js";
import { isDocx, isPlainText } from "./docread.js";
import { readPlain, writeSealed } from "./restfiles.js";

/**
 * The ceilings, by kind: exactly what the failed slip types under it, "PHOTOS, PDFS, DOCS · UP TO
 * 20 MB EACH" (sheet-uploads 3C). A photo past what the model looks at (7 MB) is made smaller on the
 * way in (src/webshrink.js) rather than refused.
 */
export const LIMITS = { image: 20 * 1024 * 1024, pdf: 20 * 1024 * 1024, doc: 20 * 1024 * 1024, voice: 20 * 1024 * 1024 };
/** The line a failed slip types, from the same numbers the server holds. */
export const LIMITS_LINE = `PHOTOS, PDFS, DOCS · UP TO ${Math.round(LIMITS.image / 1048576)} MB EACH`;
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(LIMITS));
/** As long as an inbound media_url lives ("expires after 30 days for inbound", Sendblue). */
export const KEEP_MS = 30 * 24 * 60 * 60_000;
/** The most files one message carries. */
export const MAX_FILES = 6;

const ID = /^[A-Za-z0-9_-]{22}$/;
export const dir = () => join(config.dataDir, "web-uploads");

const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", heic: ".heic" };
const IMAGE_MIME = { "image/jpeg": "image/jpeg", "image/png": "image/png", "image/gif": "image/gif", "image/webp": "image/webp", heic: "image/heic" };

/** What a recording really is, from its first bytes. */
export function sniffAudio(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length < 12) return null;
  if (b.toString("hex", 0, 4) === "1a45dfa3") return { mime: "audio/webm", ext: ".webm" };
  if (b.toString("ascii", 0, 4) === "OggS") return { mime: "audio/ogg", ext: ".ogg" };
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return { mime: "audio/wav", ext: ".wav" };
  if (b.toString("ascii", 4, 8) === "ftyp") return { mime: "audio/mp4", ext: ".m4a" };
  if (b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", ext: ".mp3" };
  return null;
}

/**
 * The bytes → `{ kind, mime, ext }` or null. `voice` says the browser recorded it with the mic, the
 * only way a sound file is taken: a recording's container can look like a video's (mp4), and a
 * photo or PDF is never read as sound.
 */
export function classify(bytes, { voice = false } = {}) {
  if (voice) { const a = sniffAudio(bytes); return a ? { kind: "voice", ...a } : null; }
  const img = sniff(bytes);
  if (img && (READABLE.has(img) || img === "heic")) return { kind: "image", mime: IMAGE_MIME[img], ext: IMAGE_EXT[img] };
  if (isPdfBytes(bytes)) return { kind: "pdf", mime: "application/pdf", ext: ".pdf" };
  if (isDocx(bytes)) return { kind: "doc", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" };
  if (isPlainText(bytes)) return { kind: "doc", mime: "text/plain; charset=utf-8", ext: ".txt" };
  return null;
}

/** A name fit to show and to read in a sentence: no path, no control characters, the right extension. */
export function cleanName(raw, ext) {
  let n = String(raw ?? "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>"`]/g, "").replace(/\s+/g, " ").trim();
  if (!n || n === "." || n === "..") n = ext === ".pdf" || ext === ".docx" || ext === ".txt" ? "document" : ext && /webm|ogg|wav|m4a|mp3/.test(ext) ? "voice-note" : "photo";
  const has = /\.[A-Za-z0-9]{2,5}$/.exec(n)?.[0]?.toLowerCase();
  const same = has && (has === ext || (ext === ".jpg" && has === ".jpeg") || (ext === ".heic" && has === ".heif"));
  if (!same) n = `${n.replace(/\.[A-Za-z0-9]{2,5}$/, "")}${ext}`;
  if (n.length > 80) n = `${n.slice(0, 80 - ext.length)}${ext}`;
  return n;
}

/** The https base the upload links hang off: Reason's own pages host (the address's host is all that matters). */
const base = () => [config.pagesUrl, config.siteUrl, config.publicUrl].find(u => /^https:\/\//.test(u || "")) || "https://reason.invalid";
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

/** The link an upload goes through the pipeline under. */
export const uploadUrl = (id, name) => `${base().replace(/\/+$/, "")}/web/media/u/${id}/${encodeURIComponent(name)}`;
/** Where a browser asks for it (the same path, on whatever host it is on). */
export const uploadPath = (id, name = "") => `/web/media/u/${id}${name ? `/${encodeURIComponent(name)}` : ""}`;

const metaPath = (id) => join(dir(), `${id}.json`);

/** One upload's record, or null. */
export function meta(id) {
  if (!ID.test(String(id ?? ""))) return null;
  try {
    const m = JSON.parse(readPlain(metaPath(id)).toString("utf8"));
    return m && m.id === id ? m : null;
  } catch { return null; }
}
export const filePath = (m) => join(dir(), `${m.id}${m.ext}`);

/**
 * Keep one file for one conversation. `extra` carries what is known about it already (a PDF's page
 * count, a voice note's length). Returns the record, or `{ error }`.
 */
export function store({ conversationId, bytes, name = "", voice = false, extra = {} }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (!conversationId) return { error: "no_conversation" };
  if (!buf.length) return { error: "empty" };
  let what = classify(buf, { voice });
  if (!what) return { error: "unsupported" };
  // Plain text keeps the name it came with when that name says text (notes.md stays notes.md).
  const textExt = /\.(md|markdown|csv|txt)$/i.exec(String(name ?? ""))?.[0]?.toLowerCase();
  if (what.ext === ".txt" && textExt) what = { ...what, ext: textExt };
  if (buf.length > LIMITS[what.kind]) return { error: "too_big", kind: what.kind, limit: LIMITS[what.kind] };
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  prune();
  if (keptBytes(conversationId) + buf.length > QUOTA_BYTES) return { error: "too_big", kind: what.kind, limit: QUOTA_BYTES };
  const id = randomBytes(16).toString("base64url");
  const m = { id, conversationId, kind: what.kind, mime: what.mime, ext: what.ext, name: cleanName(name, what.ext), bytes: buf.length, at: clock.now(), ...extra };
  writeSealed(filePath(m), conversationId, buf); // sealed for them with REASON_ENCRYPT_REST2=on
  writeSealed(metaPath(id), conversationId, JSON.stringify(m)); // its name and later its words: sealed too
  return m;
}

/** Add what was learned later (a PDF's pages, a voice note's words). */
export function update(id, patch) {
  const m = meta(id);
  if (!m) return null;
  const next = { ...m, ...patch, id: m.id, conversationId: m.conversationId };
  writeSealed(metaPath(id), m.conversationId, JSON.stringify(next));
  return next;
}

/** What one conversation may keep here at once (30 days of it). */
export const QUOTA_BYTES = 300 * 1024 * 1024;
/** The bytes this conversation's uploads take now. */
export function keptBytes(conversationId) {
  let total = 0;
  let names = [];
  try { names = readdirSync(dir()); } catch { return 0; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try { const m = JSON.parse(readPlain(join(dir(), f)).toString("utf8")); if (m.conversationId === conversationId) total += Number(m.bytes) || 0; } catch { /* half-written; skip */ }
  }
  return total;
}

let lastPrune = 0;
/** Past KEEP_MS a file goes, like an inbound media link does. At most once an hour. */
export function prune(now = clock.now(), { force = false } = {}) {
  if (!force && now - lastPrune < 60 * 60_000) return 0;
  lastPrune = now;
  let gone = 0;
  let names = [];
  try { names = readdirSync(dir()); } catch { return 0; }
  for (const f of names) {
    const p = join(dir(), f);
    try { if (now - statSync(p).mtimeMs > KEEP_MS) { rmSync(p, { force: true }); gone++; } } catch { /* already gone */ }
  }
  return gone;
}

/** The id in an upload link (on any of Reason's own hosts), or null. */
export function uploadIdOf(url) {
  let u;
  try { u = new URL(String(url ?? "")); } catch { return null; }
  const ours = new Set([config.pagesUrl, config.siteUrl, config.publicUrl, base()].map(hostOf).filter(Boolean));
  if (!ours.has(u.host.toLowerCase())) return null;
  const m = /^\/web\/media\/u\/([A-Za-z0-9_-]{22})(?:\/|$)/.exec(u.pathname);
  return m ? m[1] : null;
}

/**
 * The readers' way in. For an upload link whose file is here and belongs to the person asking:
 * `{ meta, fetch }`, where `fetch` is a drop-in for `globalThis.fetch` that answers from disk (so
 * src/media.js and src/voice.js read it with every check they already make). The person asking is
 * `conversationId`, else whoever's turn or request is running (src/zonescope.js). An upload link
 * that is somebody else's, gone, or asked for by nobody in particular gets `{ meta: null, fetch }`
 * with a fetch that answers 404: never read from disk, and never fetched over the network either
 * (2026-11-08, security: one person's link pasted into another's thread opens nothing). For
 * anything that is not an upload link: null, and they fetch as they always do.
 */
const refused = { meta: null, fetch: async () => new Response(null, { status: 404 }) };
export function localUpload(url, { conversationId = "" } = {}) {
  const id = uploadIdOf(url);
  if (!id) return null;
  const m = meta(id);
  const owner = conversationId || zonescope.conversation();
  if (!m || !owner || m.conversationId !== owner || !existsSync(filePath(m))) return refused;
  const fetch = async () => {
    const bytes = readPlain(filePath(m));
    return new Response(bytes, { status: 200, headers: { "content-type": m.mime, "content-length": String(bytes.length) } });
  };
  return { meta: m, fetch };
}

/**
 * The uploads a message names, as the router's attachments — only this conversation's, in order.
 * One that is not theirs, or is gone, makes the whole list null: a send never silently drops a file.
 */
export function attachmentsFor(conversationId, ids = []) {
  const out = [];
  for (const id of ids.slice(0, MAX_FILES)) {
    const m = meta(id);
    if (!m || m.conversationId !== conversationId || !existsSync(filePath(m))) return null;
    out.push({
      url: uploadUrl(m.id, m.name), filename: m.name, kind: m.kind, web_upload: m.id,
      ...(m.pages ? { pages: m.pages } : {}), ...(m.seconds ? { seconds: m.seconds } : {}),
    });
  }
  return out;
}

/** The typed name a slip shows: `LEASE.PDF · 4 PP`. */
export function slipLabel({ name = "", kind = "", pages = null } = {}) {
  const n = String(name || (kind === "pdf" ? "document.pdf" : "file")).toUpperCase();
  return pages && kind === "pdf" ? `${n} · ${pages} ${pages === 1 ? "P" : "PP"}` : n;
}
