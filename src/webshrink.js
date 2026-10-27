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

/** The resizer on this machine: `{ bin, args(in, out, edge) }`, or null. */
export function findResizer() {
  for (const p of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]) {
    if (existsSync(p)) return { bin: p, args: (i, o, edge) => ["-nostdin", "-y", "-loglevel", "error", "-i", i, "-frames:v", "1", "-vf", `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`, "-q:v", "4", o] };
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
export async function fitPhoto(bytes, { resizer = findResizer(), heicToJpeg = toJpeg, tmpDir = config.imageTmpRoot, timeoutMs = 60_000 } = {}) {
  let buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length <= FIT_BYTES) return { ok: true, bytes: buf, changed: false };
  if (sniff(buf) === "heic") {
    const j = await heicToJpeg({ bytes: buf });
    if (!j.ok) return { ok: false };
    buf = j.bytes;
    if (buf.length <= FIT_BYTES) return { ok: true, bytes: buf, changed: true };
  }
  if (!resizer) return { ok: false };
  mkdirSync(tmpDir, { recursive: true });
  const stem = join(tmpDir, `fit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const src = `${stem}.in`, out = `${stem}.jpg`;
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
