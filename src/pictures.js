// Turning a picture a phone took into a picture the model can read, and refusing to fetch one from
// somewhere it should not.
//
// Two jobs, both code's and neither the model's:
//
//   toJpeg()      a HEIC — what an iPhone shoots by default — converted on this machine before
//                 anything looks at it. Also HEIF, BMP and TIFF, because the same program reads
//                 them and refusing a picture over its container was never the point.
//   checkUrl()    where a media download is allowed to go.
//
// WHY sips AND NOT A LIBRARY. Claude's vision endpoint takes JPEG, PNG, GIF and WebP only
// (platform.claude.com/docs/en/build-with-claude/vision, read 2026-10-05), and an iPhone's default
// is none of them, so until something converts, the common case is a photo Reason can see is a
// photo and still cannot open. The conversion has to happen here rather than in a dependency: this
// machine has no Homebrew and no ffmpeg, a HEIC decoder as an npm package means native builds, and
// adding either to send somebody a sentence about their own holiday photo is the wrong trade.
//
// macOS ships /usr/bin/sips, which is Apple's own image tool and the same bargain afconvert is in
// src/expressive.js: already there, nothing to install, no password. Its formats were read off
// `sips --formats` on this machine on 2026-10-05 — `public.heic`, `public.heif`, `com.microsoft.bmp`
// and `public.tiff` are all listed readable, and `public.jpeg` writable — and the round trip was
// run: a HEIC in, `ffd8ff` out.
//
// It is FEATURE-DETECTED, not assumed. On a machine without it (any Linux host) nothing here
// pretends: the caller keeps the honest refusal it already had, which names the format and asks for
// a screenshot. A conversion that silently did not happen would be worse than the refusal.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, clock } from "./config.js";

/** Apple's own image tool, on every Mac. */
export const SIPS_PATH = "/usr/bin/sips";

/**
 * sips on this machine, or null.
 *
 * REASON_SIPS_BIN names another path, or "none" to behave exactly like a machine without one —
 * which is how the Linux refusal is tested on a Mac.
 */
export function findSips() {
  const named = process.env.REASON_SIPS_BIN;
  if (named === "none") return null;
  if (named) return existsSync(named) ? named : null;
  return process.platform === "darwin" && existsSync(SIPS_PATH) ? SIPS_PATH : null;
}

/** `sips -s format jpeg in.heic --out out.jpg`. Run on this machine 2026-10-05. */
export const JPEG_SIPS_ARGS = (input, output) => ["-s", "format", "jpeg", input, "--out", output];

/**
 * heif-convert on this machine, or null. The Linux equivalent of sips for HEIC: installed by
 * `apt install libheif-examples`, feature-detected the same way.
 *
 * REASON_HEIF_CONVERT_BIN names another path, or "none" to suppress it.
 */
export function findHeifConvert() {
  if (process.platform === "darwin") return null;
  const named = process.env.REASON_HEIF_CONVERT_BIN;
  if (named === "none") return null;
  if (named) return existsSync(named) ? named : null;
  for (const p of ["/usr/bin/heif-convert", "/usr/local/bin/heif-convert"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** `heif-convert -q 90 in.heic out.jpg`. */
export const JPEG_HEIF_CONVERT_ARGS = (input, output) => ["-q", "90", input, output];

/**
 * The converter on this machine — sips on macOS, heif-convert on Linux — or null.
 * Returns `{ bin, argsFor }` so `toJpeg` runs the right command without guessing.
 */
export function findConverter() {
  const sips = findSips();
  if (sips) return { bin: sips, argsFor: JPEG_SIPS_ARGS };
  const heif = findHeifConvert();
  if (heif) return { bin: heif, argsFor: JPEG_HEIF_CONVERT_ARGS };
  return null;
}

/**
 * What a picture really is, read off the first bytes rather than off its name.
 *
 * The extension on an inbound `media_url` is the only thing Sendblue gives (there is no content
 * type on an inbound message at all), and it is somebody else's string: a `.jpg` that is really a
 * HEIC would be handed to the model as a JPEG and come back a 400, and a `.png` that is really a
 * PDF would be handed over as an image of nothing. So the bytes decide, and the name is only a hint
 * about what to call it in a sentence.
 *
 * Returns a media_type the model takes, or one of the convertible names, or null for "this is not
 * a picture at all". Magic numbers from each format's own spec; the HEIC brands are the ones ISO
 * 14496-12 `ftyp` boxes carry for HEIF-family files.
 */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1", "heif"]);
export function sniff(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("hex", 0, 8) === "89504e470d0a1a0a") return "image/png";
  const head6 = b.toString("ascii", 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 4, 8) === "ftyp" && HEIF_BRANDS.has(b.toString("ascii", 8, 12))) return "heic";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  const tiff = b.toString("hex", 0, 4);
  if (tiff === "49492a00" || tiff === "4d4d002a") return "tiff";
  return null;
}

/** The four the model reads as they are. */
export const READABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** What sips can turn into one of those, named the way a sentence about it would be. */
export const CONVERTIBLE = { heic: "an iPhone HEIC", bmp: "a BMP", tiff: "a TIFF" };

/** One sips run. Injectable so every path here is testable with no binary and no picture. */
export function runSips(args, { bin, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, error: "there is no image converter on this machine" });
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || "").split("\n").filter(Boolean).at(-1) ?? "the conversion failed" });
      resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * A picture the model cannot read → the same picture as JPEG bytes.
 *
 * Written to a temp file because sips takes paths, converted, read back, and both files are removed
 * whatever happens — the bytes are what matters and a photo left in a temp directory is somebody's
 * photo left on a disk. `{ ok: true, bytes, from }` or `{ ok: false, error }`, where `error` is a
 * sentence the caller can put in front of the model.
 */
export async function toJpeg({
  bytes, filename = "", kind = null,
  tmpDir = config.imageTmpRoot, bin = undefined, argsFor = undefined, run = runSips,
  read = readFileSync, write = writeFileSync, timeoutMs = config.imageConvertTimeoutMs,
} = {}) {
  // Auto-detect when no explicit bin was passed; explicit null means "pretend there is none".
  if (bin === undefined) {
    const c = findConverter();
    if (!c) return { ok: false, error: "there is no image converter on this machine" };
    bin = c.bin;
    argsFor = argsFor ?? c.argsFor;
  }
  if (!bin) return { ok: false, error: "there is no image converter on this machine" };
  argsFor = argsFor ?? JPEG_SIPS_ARGS;
  const was = kind ?? sniff(bytes);
  if (!CONVERTIBLE[was]) return { ok: false, error: `${was ?? "that"} is not something this can convert` };

  mkdirSync(tmpDir, { recursive: true });
  const stem = join(tmpDir, `pic-${clock.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const src = `${stem}.${was === "heic" ? "heic" : was}`;
  const out = `${stem}.jpg`;
  try {
    write(src, bytes);
    const r = await run(argsFor(src, out), { bin, timeoutMs });
    if (!r.ok) return { ok: false, error: r.error };
    let made;
    try { made = read(out); } catch { return { ok: false, error: "the converter reported success but wrote no file" }; }
    if (!made?.length) return { ok: false, error: "the converter wrote an empty file" };
    if (sniff(made) !== "image/jpeg") return { ok: false, error: "the converter did not produce a JPEG" };
    return { ok: true, bytes: made, from: was, name: `${String(filename || "the picture").replace(/\.[^.]+$/, "")}.jpg` };
  } finally {
    rmSync(src, { force: true });
    rmSync(out, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Where a media download may go
// ---------------------------------------------------------------------------

/**
 * Addresses that are this machine, or something on its network that is not on the internet.
 *
 * A media_url is a string from a provider rather than from the person texting, so the realistic way
 * one points at 169.254.169.254 or at Reason's own port is somebody else's mistake or somebody
 * else's break-in — which is exactly the case to be deterministic about. Every range here is from
 * the RFC that reserves it: 1918 (private v4), 5735 (this-network, loopback, link-local), 6598
 * (carrier NAT), 4193 (v6 unique-local), 4291 (v6 loopback and link-local).
 */
const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export function isPrivateHost(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (LOCAL_NAMES.has(h) || LOCAL_SUFFIXES.some(s => h.endsWith(s))) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (v4.slice(1).some(n => Number(n) > 255)) return true;   // not an address at all
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;             // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;             // fe80::/10 link-local
    // ::ffff:127.0.0.1 and friends: the v4 part is what it really reaches. `new URL` normalises
    // the dotted form into two hex groups (`::ffff:7f00:1`), so both shapes are unpacked.
    const mapped = /^::ffff:(.+)$/.exec(h);
    if (mapped) {
      if (mapped[1].includes(".")) return isPrivateHost(mapped[1]);
      const words = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped[1]);
      if (words) {
        const [hi, lo] = words.slice(1).map(w => parseInt(w, 16));
        return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
    }
    return false;
  }
  return false;
}

/**
 * May this URL be fetched for its bytes? `{ ok: true, url }` or `{ ok: false, why }`, where `why`
 * is a sentence about the download rather than about security — the person who sent the photo did
 * not choose the link and should not be read a lecture about it.
 *
 * https only. The one media_url host in Sendblue's own docs is `storage.googleapis.com`, every
 * provider link in this repo is https, and a photo fetched over http is a photo somebody on the
 * path could swap; there is no case where allowing http buys anything.
 */
export function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { return { ok: false, why: "the link to it was not a real address" }; }
  if (u.protocol !== "https:") return { ok: false, why: `the link to it is ${u.protocol.replace(":", "")} rather than https, and only https is fetched` };
  if (isPrivateHost(u.hostname)) return { ok: false, why: "the link to it points at this machine's own network rather than at the internet" };
  return { ok: true, url: u.href };
}
