// A photo handed in on Reason Web that is bigger than the model will look at (src/media.js
// MAX_IMAGE_BYTES), made smaller on this machine so "PHOTOS … UP TO 20 MB EACH" (sheet-uploads 3C)
// is true: a 15 MB photo straight off a camera is taken and seen, not refused later.
//
// The browser already shrinks what it can draw (src/pages/webcompose.js); this is for what it
// can't (a HEIC, a huge PNG, a browser with no canvas). ffmpeg on Linux (the server has it), sips on
// macOS, both run on temp files that are removed whatever happens. A HEIC goes through toJpeg first.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { sniff, toJpeg, findSips } from "./pictures.js";

/** What the model looks at, at most (src/media.js MAX_IMAGE_BYTES). */
export const FIT_BYTES = 7 * 1024 * 1024;

/** The most pixels a photo may claim before anything decodes it (a "pixel bomb" is refused, not decoded). */
export const MAX_PIXELS = 50_000_000;

/** Width × height from a PNG, JPEG, GIF or WebP header, or null when the header doesn't say. */
export function pixelsOf(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return b.readUInt32BE(16) * b.readUInt32BE(20);
    if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return b.readUInt16LE(6) * b.readUInt16LE(8);
    if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const kind = b.toString("ascii", 12, 16);
      if (kind === "VP8X") return (1 + b.readUIntLE(24, 3)) * (1 + b.readUIntLE(27, 3));
      if (kind === "VP8L") { const v = b.readUInt32LE(21); return ((v & 0x3fff) + 1) * (((v >> 14) & 0x3fff) + 1); }
      if (kind === "VP8 ") return (b.readUInt16LE(26) & 0x3fff) * (b.readUInt16LE(28) & 0x3fff);
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) { p++; continue; }
        const m = b[p + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b.readUInt16BE(p + 5) * b.readUInt16BE(p + 7);
        p += 2 + b.readUInt16BE(p + 2);
      }
    }
  } catch { /* a short or odd header says nothing */ }
  return null;
}

/** The resizer on this machine: `{ bin, args(in, out, edge) }`, or null. */
export function findResizer() {
  for (const p of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]) {
    if (existsSync(p)) return { bin: p, args: (i, o, edge) => ["-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file", "-f", "image2", "-i", i, "-frames:v", "1", "-vf", `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`, "-q:v", "4", o] };
  }
  const sips = findSips();
  if (sips) return { bin: sips, args: (i, o, edge) => ["-Z", String(edge), "-s", "format", "jpeg", "-s", "formatOptions", "80", i, "--out", o] };
  return null;
}

const run = (bin, args, timeoutMs) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err) => resolve(!err));
});

/**
 * Bytes of a photo → `{ ok: true, bytes }` no bigger than FIT_BYTES (a JPEG when it had to change), or
 * `{ ok: false }` when this machine can't make it fit. A photo that already fits comes back as it was.
 */
let busy = Promise.resolve();
/** One resize at a time on this machine: a burst of big photos queues rather than running ffmpeg side by side. */
export function fitPhoto(bytes, opts = {}) {
  const run = busy.then(() => fitOne(bytes, opts));
  busy = run.catch(() => {});
  return run;
}

async function fitOne(bytes, { resizer = findResizer(), heicToJpeg = toJpeg, tmpDir = config.imageTmpRoot, timeoutMs = 15_000 } = {}) {
  let buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length <= FIT_BYTES) return { ok: true, bytes: buf, changed: false };
  const px = pixelsOf(buf);
  if (px != null && px > MAX_PIXELS) return { ok: false };
  if (sniff(buf) === "heic") {
    const j = await heicToJpeg({ bytes: buf });
    if (!j.ok) return { ok: false };
    buf = j.bytes;
    if (buf.length <= FIT_BYTES) return { ok: true, bytes: buf, changed: true };
  }
  if (!resizer) return { ok: false };
  mkdirSync(tmpDir, { recursive: true });
  const stem = join(tmpDir, `fit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  // The input's real kind as its extension: ffmpeg's image2 reader goes by it, and is told to read nothing else.
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[sniff(buf)];
  if (!ext) return { ok: false };
  const src = `${stem}-in.${ext}`, out = `${stem}.jpg`;
  try {
    writeFileSync(src, buf, { mode: 0o600 });
    for (const edge of [2560, 1600]) {
      rmSync(out, { force: true });
      if (!(await run(resizer.bin, resizer.args(src, out, edge), timeoutMs))) continue;
      let made;
      try { made = readFileSync(out); } catch { continue; }
      if (made.length && made.length <= FIT_BYTES && sniff(made) === "image/jpeg") return { ok: true, bytes: made, changed: true };
    }
    return { ok: false };
  } finally {
    rmSync(src, { force: true });
    rmSync(out, { force: true });
  }
}
