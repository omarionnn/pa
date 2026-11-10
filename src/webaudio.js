// Reason Web: a voice note or a call recording, in a form the browser can play.
//
// iMessage voice notes are Opus in a CAF container (.caf). iPhone Safari plays some of them and
// desktop Chrome plays none, so on Web the chip drew and nothing happened (2026-10-30). What every
// browser plays: AAC in MP4 (.m4a), MP3, WAV. So:
//   1. already one of those: served as it is;
//   2. a file Reason keeps whose playable sibling sits next to it (call-15.caf beside call-15.mp3,
//      both in data/recordings): the sibling, once it is checked to be in the same root;
//   3. otherwise converted once to .m4a (ffmpeg, or afconvert on a Mac) and kept under
//      config.webAudioRoot by the bytes' own hash, so the second play costs a file read.
// No converter, or a conversion that fails: the original bytes, which still play on an iPhone.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readPlain, sealLike, sealInPlace } from "./restfiles.js";
import { extname, join, resolve, sep } from "node:path";
import { config } from "./config.js";
import { findConverter, runConverter } from "./expressive.js";
import { sniffAudio } from "./calls/recordings.js";

/** Types every browser Reason Web supports plays as they are. */
const PLAYS = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/webm"]);
const SIBLINGS = [[".m4a", "audio/mp4"], [".mp3", "audio/mpeg"], [".aac", "audio/aac"], [".wav", "audio/wav"]];
/** Biggest file converted on a page request: a long call is ~10 MB of MP3; anything far past that is not a voice note. */
const MAX_CONVERT_BYTES = 40 * 1024 * 1024;

export const plays = (mime) => PLAYS.has(String(mime ?? "").split(";")[0].trim().toLowerCase());

/** What the bytes really are (src/calls/recordings.js sniffAudio) → the ffmpeg demuxer that reads it. */
const DEMUX = { caf: "caf", ogg: "ogg", amr: "amr", aiff: "aiff", wav: "wav", mp3: "mp3", m4a: "mov", aac: "aac" };

/**
 * ffmpeg/afconvert arguments: anything → AAC in .m4a, mono, moov first so Safari can start before the end.
 * The input's format is pinned and only plain files may be opened, so bytes from outside (a texted .caf
 * that is really a playlist) can never make ffmpeg reach another file or a URL.
 */
export const M4A_FFMPEG_ARGS = (input, output, demux) => ["-y", "-v", "error", "-protocol_whitelist", "file", "-f", demux, "-i", input, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4", output];
export const M4A_AFCONVERT_ARGS = (input, output) => ["-f", "m4af", "-d", "aac", "-c", "1", input, output];

/** A playable file kept next to `path` (same stem), inside `root`, or null. */
export function playableSibling(path, root) {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (const [e, mime] of SIBLINGS) {
    if (e === ext.toLowerCase()) continue;
    const p = `${stem}${e}`;
    if (!existsSync(p)) continue;
    try {
      const real = realpathSync(p);
      if (!root || !real.startsWith(root + sep)) continue;
      const st = statSync(real);
      if (st.isFile() && st.size > 0) return { path: real, mime };
    } catch { /* not that one */ }
  }
  return null;
}

const inflight = new Map(); // hash → Promise<path|null>, so two plays at once convert once
const failed = new Map();   // hash → when it last failed: not tried again for FAIL_MS (Safari asks in many ranges); pruned past FAIL_MS
const FAIL_MS = 30 * 60_000;
/** Converted copies older than this are swept when a new one is made: they are made again if asked for. */
const KEEP_MS = 30 * 24 * 3600_000;
/** At most this many conversions at once; the rest wait their turn, up to MAX_WAITING (then: not now). */
const MAX_RUNNING = 2;
const MAX_WAITING = 8;
let running = 0;
const waiting = [];
const slot = () => new Promise(r => { if (running < MAX_RUNNING) { running++; r(); } else waiting.push(r); });
const free = () => { const next = waiting.shift(); if (next) next(); else running--; };

const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 40);
const outFor = (hash, root = config.webAudioRoot) => join(resolve(root), `${hash}.m4a`);
/** Where the playable copy of these (plain) bytes would be: the file migration seals it like its source. */
export const playableFor = (bytes) => outFor(hashOf(bytes));

function sweep(dir, now = Date.now(), keepMs = KEEP_MS) {
  let gone = 0;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (now - statSync(p).mtimeMs > keepMs) { rmSync(p, { force: true }); gone++; } } catch { /* gone already */ }
    }
  } catch { /* nothing to sweep */ }
  return gone;
}

/**
 * The retention sweep (src/privacy.js) clears converted copies on its own clock, so a voice note whose
 * message aged out does not live on as .m4a until some later play happens to sweep. Kept no longer than
 * message content is kept, and never past KEEP_MS. The number removed.
 */
export function sweepPlayable({ now = Date.now(), keepDays = config.keepContentDays, root = config.webAudioRoot } = {}) {
  const days = Number(keepDays);
  const keepMs = Number.isFinite(days) && days > 0 ? Math.min(KEEP_MS, days * 24 * 3600_000) : KEEP_MS;
  return sweep(resolve(root), now, keepMs);
}

/** `bytes` as .m4a, from the cache or made now; the cached file's path, or null when it cannot be made. */
export async function toM4a(bytes, { converter = findConverter(), run = runConverter, root = config.webAudioRoot, hash = null } = {}) {
  if (!converter || !bytes?.length || bytes.length > MAX_CONVERT_BYTES) return null;
  const demux = DEMUX[sniffAudio(bytes)];
  if (!demux) return null;
  hash ||= hashOf(bytes);
  const dir = resolve(root);
  const out = outFor(hash, root);
  if (existsSync(out) && statSync(out).size > 0) return out;
  if (Date.now() - (failed.get(hash) ?? -Infinity) < FAIL_MS) return null;
  if (failed.size > 256) for (const [h, t] of failed) if (Date.now() - t >= FAIL_MS) failed.delete(h);
  if (inflight.has(hash)) return inflight.get(hash);
  // Each waiter holds its whole file in memory: a pile of plays at once is turned away, not queued.
  if (running >= MAX_RUNNING && waiting.length >= MAX_WAITING) return null;
  const job = (async () => {
    await slot();
    const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const src = join(dir, `.in-${hash}-${tag}`), tmp = join(dir, `.out-${hash}-${tag}.m4a`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(src, bytes, { mode: 0o600 });
      const args = converter.kind === "afconvert" ? M4A_AFCONVERT_ARGS(src, tmp) : M4A_FFMPEG_ARGS(src, tmp, demux);
      const r = await run(args, { bin: converter.bin, timeoutMs: 60_000 });
      if (!r.ok || !existsSync(tmp) || statSync(tmp).size === 0) { failed.set(hash, Date.now()); return null; }
      renameSync(tmp, out);
      sweep(dir);
      return out;
    } catch { failed.set(hash, Date.now()); return null; } finally {
      rmSync(src, { force: true }); rmSync(tmp, { force: true });
      inflight.delete(hash);
      free();
    }
  })();
  inflight.set(hash, job);
  return job;
}

// A file Reason keeps is hashed once per version of it (path, size, mtime), not on every range request.
const hashes = new Map();
function fileHash(path, bytes) {
  let key = null;
  try { const st = statSync(path); key = `${path}:${st.size}:${st.mtimeMs}`; } catch { /* hash it anyway */ }
  if (key && hashes.has(key)) return hashes.get(key);
  const h = hashOf(bytes ?? readPlain(path));
  if (key) { hashes.set(key, h); if (hashes.size > 500) hashes.delete(hashes.keys().next().value); }
  return h;
}

/**
 * Remove the playable copy of a file Reason keeps, before the file itself goes (a deleted recording
 * must not live on as its .m4a). Called by src/calls/recordings.js deleteRecordingFile and src/privacy.js.
 */
export function forgetPlayable(path) {
  try { if (!existsSync(path)) return; rmSync(outFor(hashOf(readPlain(path))), { force: true }); } catch { /* nothing kept */ }
}

/**
 * Audio to hand the browser: `{ bytes, mime }`. `path` (a file Reason keeps, with the `root` it was
 * checked inside) or `bytes`; `mime` what it is now.
 */
export async function playable({ bytes = null, path = null, root = null, mime, owner = null, ...opts }) {
  if (plays(mime)) return { bytes: bytes ?? readPlain(path), mime };
  if (path) {
    const sib = playableSibling(path, root);
    if (sib) return { bytes: readPlain(sib.path), mime: sib.mime };
  }
  const original = bytes ?? readPlain(path);
  const hash = path ? fileHash(path, original) : null;
  const made = await toM4a(original, { ...opts, ...(hash ? { hash } : {}) });
  if (made) {
    // The playable copy is sealed like what it was made from (REASON_ENCRYPT_REST2).
    try { if (path) sealLike(path, made); else if (owner) sealInPlace(made, owner); } catch { /* served plain-cached */ }
    try {
      const b = readPlain(made);
      if (b.length) return { bytes: b, mime: "audio/mp4" };
      rmSync(made, { force: true }); // sealed by someone whose key is gone: made again next time
    } catch { /* fall through */ }
  }
  return { bytes: original, mime };
}
