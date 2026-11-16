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
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config, clock } from "./config.js";
import * as zonescope from "./zonescope.js";
import { sniff, READABLE } from "./pictures.js";
import { isPdfBytes } from "./pdf.js";
import { isDocx, isPlainText } from "./docread.js";
import { readPlain, writeSealed } from "./restfiles.js";
import * as digest from "./opsdigest.js";

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
export function store({ conversationId, bytes, name = "", voice = false, extra = {}, quota = true, inbound = false }) {
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
  // `quota: false` (the caller's plan.freeForGood: the owner, anybody invited) skips the per-person total.
  if (quota && keptBytes(conversationId) + buf.length > QUOTA_BYTES) return { error: "too_big", kind: what.kind, limit: QUOTA_BYTES };
  // Everyone, whoever they are: a file a PERSON sends (`inbound`, src/webmedia.js) never fills the disk the
  // whole service runs on. What Reason makes or sends itself (a card, a table, a picture it sends) is not
  // refused here: below the floor that would break replies, not slow uploads (review 2026-11-15).
  const room = inbound ? diskRoom(buf.length) : { ok: true };
  if (!room.ok) {
    try { digest.hold({ key: "uploads:disk_floor", text: DISK_FLOOR_OWNER_LINE(room) }); } catch { /* the refusal stands either way */ }
    return { error: "disk_full", say: DISK_FULL_WORDS };
  }
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

/**
 * What one conversation may keep here at once (30 days of it). Not for the owner or anybody free for
 * good (owner 2026-11-15: "lift the upload limits"); still for the monthly free tier and paying accounts.
 */
export const QUOTA_BYTES = 300 * 1024 * 1024;

// ---------- the one system-wide guard: free disk on the data volume
// With no per-person total for some people, what stops one person filling the disk (and taking the
// service down for everyone) is this: a new file is refused while the data volume has less free than
// the floor. Not a limit on anybody: it lifts by itself as space comes back (30-day prune, a bigger disk).
// The floor: REASON_UPLOAD_DISK_FLOOR_GB, 5 GB by default. Flat rather than a share of the disk: a
// share is too strict on a big disk and too loose on a small one, and room for the database, logs and
// backups to keep working is what it protects. The status page's Server row turns amber at 20% free
// and red at 10% (src/ops.js serverCheck), so the owner normally hears long before this.
const GB = 1024 ** 3;
/** Swapped by a test for a disk of its own, as src/ops.js serverStats is. */
export const diskStats = { statfs: (d) => statfsSync(d) };
export const DISK_FLOOR_GB_DEFAULT = 5;
export function diskFloorBytes() {
  const raw = String(process.env.REASON_UPLOAD_DISK_FLOOR_GB ?? "").trim();
  const set = Number(raw);
  return Math.round((raw !== "" && Number.isFinite(set) && set >= 0 ? set : DISK_FLOOR_GB_DEFAULT) * GB);
}
/** Is there room for `bytes` more above the floor? An unreadable disk is not a reason to refuse. */
export function diskRoom(bytes = 0) {
  let s;
  try { s = diskStats.statfs(config.dataDir); } catch { return { ok: true, unknown: true }; }
  const total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize);
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return { ok: true, unknown: true };
  const floor = diskFloorBytes();
  return { ok: free - bytes >= floor, free, total, floor };
}
/** What the person is told: the machine, never them. */
export const DISK_FULL_WORDS = "I can't take more files right now; that's on my side, not a limit on you.";
/** The owner's line in the daily digest: numbers only. */
export const DISK_FLOOR_OWNER_LINE = (r) => `Uploads refused: the data disk has ${(r.free / GB).toFixed(1)} GB free, under the ${(r.floor / GB).toFixed(1)} GB floor (REASON_UPLOAD_DISK_FLOOR_GB). New files are refused for everyone until space is freed.`;
/** How many of this conversation's uploads were kept since `since` and pass `pred` (src/pictureout.js's day count). */
export function countSince(conversationId, since, pred = () => true) {
  let n = 0;
  let names = [];
  try { names = readdirSync(dir()); } catch { return 0; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try { const m = JSON.parse(readPlain(join(dir(), f)).toString("utf8")); if (m.conversationId === conversationId && Number(m.at) >= since && pred(m)) n++; } catch { /* half-written; skip */ }
  }
  return n;
}

/**
 * Their delete (src/data.js deleteData): every upload of theirs, file and record, or every upload of
 * everybody's when `conversationId` is null. → { listed, files_deleted, failed }
 */
export function forget(conversationId = null) {
  const out = { listed: 0, files_deleted: 0, failed: [] };
  let names = [];
  try { names = readdirSync(dir()); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    if (!ID.test(id)) continue;
    let m = null;
    try { m = JSON.parse(readPlain(join(dir(), f)).toString("utf8")); } catch { m = null; }
    if (conversationId && m?.conversationId !== conversationId) continue;
    out.listed++;
    try {
      if (m?.ext) rmSync(filePath(m), { force: true });
      rmSync(join(dir(), f), { force: true });
      out.files_deleted++;
    } catch (e) { out.failed.push({ id, error: String(e?.message ?? e).split("\n")[0] }); }
  }
  return out;
}

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
