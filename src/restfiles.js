// Encryption at rest, phase 2, for files on disk (REASON_ENCRYPT_REST2=on): call recordings, voice
// notes, photos (Web uploads, event albums and covers, generated pictures), documents, page cards
// and previews, browser screenshots, the Web's playable audio copies.
//
// Each file is sealed under its owner's person key (src/restcrypt.js sealBytes; the key id is in the
// file's first bytes), so:
//   - writing needs the owner: writeSealed(path, conversationId, bytes);
//   - reading never does: readPlain(path) opens a sealed file and passes a plain one through, so a
//     file written before the flag, or by a test fixture, still reads;
//   - a tool that wants a path (ffmpeg, afconvert) gets a short-lived plain copy: withPlainPath();
//   - every HTTP route reads with readPlain and serves the bytes, so a third party fetching by URL
//     (Sendblue, Linq, a link preview) gets the picture, never the envelope;
//   - "forget everything" re-seals the files that stay under the new key (restcrypt.rotatePersonKey
//     walks fileRoots()); deleting a person destroys the key, and with it every copy of the file.
// Transient files that a function writes and deletes in the same call (a resize, a transcode) are
// left plain: they exist for seconds. Shared caches that are nobody's (product photos mirrored by
// URL, choice cards, invite cards, the cached pickup opener) are not sealed.
import { readFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, copyFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import * as rc from "./restcrypt.js";

/** Every directory a sealed file may sit in. */
export function fileRoots() {
  const d = config.dataDir;
  return [
    config.recordingRoot, config.webAudioRoot, config.documentRoot, config.audioTmpRoot, config.shotRoot,
    config.imagenOutputDir, config.imageTmpRoot, join(d, "web-uploads"), join(d, "event-albums"), join(d, "event-covers"), join(d, "cards"),
  ];
}
rc.registerFileRoots(fileRoots);

export const isSealedFile = (bytes) => rc.isSealedBytes(bytes);

/** The person key id a stored file is sealed under (its first 12 bytes), or null. */
export function keyIdOfFile(path) {
  let fd;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const head = Buffer.alloc(rc.FILE_MAGIC.length + rc.FILE_ID_BYTES);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < head.length || !head.subarray(0, rc.FILE_MAGIC.length).equals(rc.FILE_MAGIC)) return null;
    return head.readUIntBE(rc.FILE_MAGIC.length, rc.FILE_ID_BYTES);
  } finally { closeSync(fd); }
}

/** Bytes as they should be stored for this owner (sealed with the flag on, else unchanged). */
export function sealedBytes(conversationId, bytes) {
  if (!conversationId) return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return rc.sealBytes(conversationId, bytes);
}

/** Write a person's file: sealed for them with REASON_ENCRYPT_REST2=on, atomically, 0600. */
export function writeSealed(path, conversationId, bytes, { mode = 0o600 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  rc.writeFileAtomic(path, sealedBytes(conversationId, bytes), mode);
}

/** A stored file's plain bytes, sealed or not. Throws like readFileSync when it is missing. */
export function readPlain(path) {
  return rc.openBytes(readFileSync(path));
}

/** Plain size of a stored file (for Content-Length / a declared upload size). */
export function plainSize(path) {
  const st = statSync(path);
  return keyIdOfFile(path) == null ? st.size : st.size - rc.FILE_OVERHEAD;
}
/** statSync, with the size a sealed file opens to (Linq signs the declared length of an upload). */
export function plainStat(path) {
  const st = statSync(path);
  return keyIdOfFile(path) == null ? st : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: st.size - rc.FILE_OVERHEAD });
}

/** Any sealed file at all (boot: the keystore must unlock to read them even with the flags off). */
export function anySealedFile() {
  for (const root of fileRoots()) for (const p of walk(abs(root))) if (keyIdOfFile(p) != null) return true;
  return false;
}

/** Seal a file already on disk for its owner, in place. True when it changed. */
export function sealInPlace(path, conversationId) {
  if (!rc.flag2On() || !conversationId || !existsSync(path)) return false;
  const raw = readFileSync(path);
  if (rc.isSealedBytes(raw)) return false;
  rc.writeFileAtomic(path, rc.sealBytes(conversationId, raw), statSync(path).mode & 0o777 || 0o600);
  return true;
}

/** Rollback: write a sealed file back as plain bytes, in place. True when it changed. */
export function openInPlace(path) {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path);
  if (!rc.isSealedBytes(raw)) return false;
  rc.writeFileAtomic(path, rc.openBytes(raw), statSync(path).mode & 0o777 || 0o600);
  return true;
}

/** Copy a stored file to a new path for the same owner (sealed stays sealed, plain is sealed now). */
export function copySealed(from, to, conversationId) {
  const raw = readFileSync(from);
  if (rc.isSealedBytes(raw) || !conversationId || !rc.flag2On()) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); return; }
  writeSealed(to, conversationId, raw);
}

/**
 * A file made from another (a transcode, a playable copy): sealed under the same person key as its
 * source. A plain source leaves it plain. True when `out` was sealed.
 */
export function sealLike(source, out) {
  if (!rc.flag2On() || !existsSync(out)) return false;
  const id = keyIdOfFile(source);
  if (id == null) return false;
  const raw = readFileSync(out);
  if (rc.isSealedBytes(raw)) return false;
  rc.writeFileAtomic(out, rc.sealBytesUnder(id, raw), 0o600);
  return true;
}

/** Bytes for a new file made from `source`, sealed under the source's key when it is sealed. */
export function bytesLike(source, bytes) {
  if (!rc.flag2On()) return bytes;
  const id = keyIdOfFile(source);
  return id == null ? bytes : rc.sealBytesUnder(id, bytes);
}

/** Where plain copies for external tools live for the seconds they are used; swept at boot. */
export function plainTmpDir() { return join(config.dataDir, ".plain-tmp"); }

/**
 * Run fn(path) on a plain copy of a stored file (ffmpeg, afconvert, sips want a path). A plain file
 * is handed over as it is; a sealed one is opened to a 0600 temp file that is removed afterwards.
 */
export async function withPlainPath(path, fn) {
  if (keyIdOfFile(path) == null) return fn(path); // plain, or not there: the tool says so itself
  const raw = readFileSync(path);
  const dir = plainTmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${randomBytes(8).toString("hex")}${extname(path)}`);
  rc.writeFileAtomic(tmp, rc.openBytes(raw), 0o600);
  try { return await fn(tmp); } finally { rmSync(tmp, { force: true }); }
}

/**
 * Boot: a crash mid-withPlainPath may leave a plain copy behind, and a crash mid-write a half-written
 * `<name>.rs-<pid>-<hex>` (which may hold plain bytes, from a rollback). Both go.
 */
export function sweepPlainTmp() {
  let n = 0;
  const dir = plainTmpDir();
  if (existsSync(dir)) for (const f of readdirSync(dir)) { rmSync(join(dir, f), { force: true }); n++; }
  for (const root of fileRoots()) for (const p of walk(abs(root), 0, true)) if (rc.TEMP_RE.test(p)) { rmSync(p, { force: true }); n++; }
  return n;
}

// ---------- the migration for files already on disk ----------
// Each file's owner comes from the database row that names it (or, for a name that carries a row id
// or a page id, that row). A file nobody can be found for is left plain and counted as `unowned`.
// Reason's drawn event covers (g-/v-), mirrored web photos (m-) and its own og/stamp cards are
// nobody's and are skipped.
function tableHas(rawPrepare, t) { return !!rawPrepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t); }
function all(rawPrepare, t, sql, ...args) { return tableHas(rawPrepare, t) ? rawPrepare(sql).all(...args) : []; }
const abs = (p) => (p ? (String(p).startsWith("/") ? String(p) : join(process.cwd(), String(p))) : "");

/** path -> owner conversation id (or "stranger:<id>"), for every file the database names. */
export function fileOwners(rawPrepare) {
  const own = new Map();
  const put = (p, c) => { if (p && c && !own.has(abs(p))) own.set(abs(p), String(c)); };
  const callOwner = new Map();
  for (const r of all(rawPrepare, "calls", "SELECT id, conversation_id, recording_file FROM calls")) {
    callOwner.set(Number(r.id), r.conversation_id);
    put(r.recording_file, r.conversation_id);
  }
  for (const r of all(rawPrepare, "stranger_calls", "SELECT id, recording_path FROM stranger_calls WHERE recording_path IS NOT NULL")) put(r.recording_path, `stranger:${r.id}`);
  for (const r of all(rawPrepare, "documents", "SELECT conversation_id, path FROM documents")) put(r.path, r.conversation_id);
  for (const r of all(rawPrepare, "conversation_files", "SELECT conversation_id, path FROM conversation_files")) put(r.path, r.conversation_id);
  const evs = all(rawPrepare, "events", "SELECT * FROM events");
  const pub = new Map(evs.map(e => [Number(e.id), e]));
  for (const r of all(rawPrepare, "event_photos", "SELECT event_id, conversation_id, file FROM event_photos")) {
    const e = pub.get(Number(r.event_id));
    if (e) put(join(config.dataDir, "event-albums", e.public_id, r.file), r.conversation_id);
  }
  const organizerByPub = new Map(evs.map(e => [e.public_id, e.organizer_conversation_id]));
  // Outbox media (voice notes, generated pictures waiting to go) names its file.
  for (const r of all(rawPrepare, "outbox", "SELECT conversation_id, media FROM outbox WHERE media IS NOT NULL AND media <> ''")) {
    try { const m = JSON.parse(r.media); for (const x of Array.isArray(m) ? m : [m]) put(x?.file ?? x?.path, r.conversation_id); } catch { /* not JSON */ }
  }
  // Generated pictures handed out by link: /img/<name>.
  const byImg = new Map();
  for (const r of all(rawPrepare, "seen_urls", "SELECT conversation_id, url FROM seen_urls WHERE url LIKE '%/img/%'")) {
    const name = String(r.url).split("/img/")[1]?.split(/[?#]/)[0];
    if (name && !byImg.has(name)) byImg.set(name, r.conversation_id);
  }
  const pageOwner = new Map(all(rawPrepare, "pages", "SELECT id, conversation_id FROM pages").map(r => [r.id, r.conversation_id]));
  const convs = new Set([...all(rawPrepare, "accounts", "SELECT conversation_id FROM accounts").map(r => r.conversation_id),
    ...all(rawPrepare, "threads", "SELECT conversation_id FROM threads").map(r => r.conversation_id),
    ...all(rawPrepare, "conversations", "SELECT id AS conversation_id FROM conversations").map(r => r.conversation_id),
    ...callOwner.values()]);
  const shotOwners = [...convs].filter(Boolean).map(c => [`${String(c).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40)}-`, c]).sort((a, b) => b[0].length - a[0].length);
  return {
    own,
    /** The owner of one file, or "" for nobody's (skip), or null for not known. */
    of(path) {
      const p = abs(path), name = p.split("/").pop();
      if (own.has(p)) return own.get(p);
      const dir = p.slice(0, p.length - name.length - 1);
      let m;
      if (dir === abs(config.recordingRoot)) {
        if ((m = /^call-(\d+)\./.exec(name))) return callOwner.get(Number(m[1])) ?? null;
        if ((m = /^stranger-(\d+)\./.exec(name))) return `stranger:${m[1]}`;
      }
      if (dir === abs(join(config.dataDir, "event-covers"))) {
        if (name.startsWith("p-")) {
          for (const [pubId, org] of organizerByPub) if (name.startsWith(`p-${pubId}-`)) return org ?? null;
          return null;
        }
        return ""; // Reason's drawn cover of a public event name
      }
      if (dir === abs(join(config.dataDir, "cards"))) {
        if ((m = /^([A-Za-z0-9_-]{8,64}?)-(r\d+-|illustration)/.exec(name)) && pageOwner.has(m[1])) return pageOwner.get(m[1]);
        return "";
      }
      if (dir === abs(config.imagenOutputDir)) {
        if (name.startsWith("m-")) return ""; // a web photo mirrored by URL, shared by everyone
        return byImg.get(name) ?? null;
      }
      if (dir === abs(join(config.dataDir, "web-uploads"))) {
        const id = name.replace(/\.[^.]+$/, "");
        try { return JSON.parse(readPlain(join(dir, `${id}.json`)).toString("utf8")).conversationId ?? null; } catch { return null; }
      }
      if (dir === abs(config.shotRoot)) {
        for (const [pre, c] of shotOwners) if (name.startsWith(pre)) return c;
        return null;
      }
      return null;
    },
  };
}

/**
 * Seal (or, for a rollback, open) every file under the roots. Returns counts. The Web's playable
 * copies (web-audio) are a cache made from recordings and voice notes: sealed like their source when
 * it can be found, else removed (the next play makes them again, sealed).
 */
export async function migrateFiles(rawPrepare, direction = "seal", { log = () => {} } = {}) {
  const out = { sealed: 0, opened: 0, already: 0, skipped: 0, unowned: 0, cache_removed: 0, unowned_files: [] };
  sweepPlainTmp();
  const owners = direction === "seal" ? fileOwners(rawPrepare) : null;
  const webAudio = abs(config.webAudioRoot);
  for (const root of fileRoots()) {
    for (const p of walk(abs(root))) {
      const name = p.split("/").pop();
      if (name.startsWith(".") || /\.rs-\d+-[0-9a-f]+$/.test(name) || /\.tmp(\.\w+)?$/.test(name)) continue; // in-flight temp files
      if (direction === "open") { if (openInPlace(p)) out.opened++; else out.already++; continue; }
      if (keyIdOfFile(p) != null) { out.already++; continue; }
      if (p.startsWith(webAudio + "/")) continue; // below
      const c = owners.of(p);
      if (c === "") { out.skipped++; continue; }
      if (!c) { out.unowned++; if (out.unowned_files.length < 50) out.unowned_files.push(p.slice(abs(config.dataDir).length + 1)); continue; }
      if (sealInPlace(p, c)) out.sealed++;
    }
  }
  if (direction === "seal") {
    const wa = await import("./webaudio.js");
    const made = new Map();
    for (const [p] of owners.own) {
      if (!existsSync(p)) continue;
      try { made.set(wa.playableFor(readPlain(p)), p); } catch { /* unreadable */ }
    }
    for (const p of walk(webAudio)) {
      if (keyIdOfFile(p) != null) { out.already++; continue; }
      const src = made.get(p);
      if (src && sealLike(src, p)) { out.sealed++; continue; }
      rmSync(p, { force: true }); out.cache_removed++;
    }
  }
  log({ encrypt_rest_files: direction, ...out, unowned_files: out.unowned_files.length });
  return out;
}

function* walk(dir, depth = 0, withTemps = false) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith("frames-") && e.name !== ".plain-tmp") yield* walk(p, depth + 1, withTemps); }
    else if (e.isFile() && (withTemps || !rc.TEMP_RE.test(e.name))) yield p;
  }
}

/** Counts for --status: sealed vs plain files under each root. */
export function fileStatus() {
  const out = [];
  for (const root of fileRoots()) {
    let sealed = 0, plain = 0;
    for (const p of walk(abs(root))) { if (keyIdOfFile(p) != null) sealed++; else plain++; }
    if (sealed || plain) out.push({ root: String(root), sealed, plain });
  }
  return out;
}
