// A picture somebody sent, fetched and handed to the model as a picture.
//
// Reason used to answer "if it was a pic, i can't open those" to everything with an attachment on
// it, which is most of what people actually send: screenshots, photos of a menu, a picture of the
// thing they want. An assistant that cannot look at a screenshot is not much of an assistant.
//
// Everything here is code's job rather than the model's, and deliberately so:
//
//   - **what Claude can actually read.** JPEG, PNG, GIF and WebP (`image/jpeg`, `image/png`,
//     `image/gif`, `image/webp`) — platform.claude.com/docs/en/build-with-claude/vision, read
//     2026-10-05. An iPhone shoots HEIC by default, which is NOT on that list, so a HEIC is
//     CONVERTED to JPEG on this machine first (src/pictures.js, `sips`) and the model is handed the
//     result. On a machine with no converter the honest refusal is kept, and it names the format.
//   - **what it really is, from the bytes.** An inbound message carries no content type at all, so
//     the extension is somebody else's string: a `.jpg` that is really a HEIC would come back a 400
//     from Anthropic, and a `.png` that is really a PDF would be an image of nothing. The first
//     bytes decide (`sniff`); the name only decides whether the download is worth making.
//   - **how big.** "The maximum size per image is 10 MB (base64-encoded) when using the Claude API
//     directly." Base64 is four bytes per three, so the ceiling on the real bytes is 7.5 MB; 7 MB
//     is used, under it with room for the rest of the request. Enforced three times: on the
//     Content-Length, while the body is still streaming, and on the bytes after a conversion —
//     because a 400 from Anthropic is a worse way to find out, and a 40 MB body should never be
//     held in memory to then be refused.
//   - **where the download may go.** https only, and never at this machine's own network
//     (src/pictures.js `checkUrl`), re-checked at every redirect. A media_url is a string from a
//     provider rather than from the person texting, which is exactly the kind of input to be
//     deterministic about.
//   - **one sentence per failure, and only one.** Whatever goes wrong — the wrong format, too big,
//     the link expired, the CDN would not answer, the conversion failing — the model is told
//     exactly that, in words it can repeat, once. It is never told "blank".
//
// WHAT THE SENDBLUE DOCS DO NOT SETTLE: whether an inbound `media_url` needs credentials. They say
// only that it is "A CDN link to any media attached to the message (expires after 30 days for
// inbound)" — nothing about auth at all.
//
// So the link is asked for plainly, and `auth` exists for the case where that turns out not to be
// enough: headers to try exactly once on a 401 or 403, with the result recording which attempt
// worked. **Nothing passes it today, deliberately.** The media_url host seen in Sendblue's own docs
// is `storage.googleapis.com` — somebody else's CDN, not Sendblue's API — and putting
// `sb-api-secret-key` on a request to a third party would hand over a credential to find out
// whether it was needed. If a real inbound photo ever comes back 403, the fix is to check the host
// first and then wire this, not to send the secret and hope. See docs/unverified.md.
import { config } from "./config.js";
import { CONVERTIBLE, READABLE, checkUrl, findSips, sniff, toJpeg } from "./pictures.js";

/** Extension → the media_type Claude takes. A hint only; the bytes have the last word. */
const MODEL_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Extensions worth downloading even though the model cannot read them, because this machine may be
 * able to convert them. The value is what `sniff` would call the bytes, so the two sides of the
 * decision speak the same language.
 */
const CONVERT_EXTS = {
  ".heic": "heic", ".heif": "heic", ".bmp": "bmp", ".tif": "tiff", ".tiff": "tiff",
};

/**
 * Formats that are obviously pictures and obviously not readable, named so the refusal can say
 * what to do about it. Only reached when there is no converter on this machine; with one, these
 * are converted instead. Anything else unrecognised gets the general line.
 */
const KNOWN_UNREADABLE = {
  ".heic": "an iPhone HEIC",
  ".heif": "an iPhone HEIF",
  ".bmp": "a BMP",
  ".tif": "a TIFF",
  ".tiff": "a TIFF",
};

/** "The maximum size per image is 10 MB (base64-encoded)"; base64 is 4/3 of the bytes. */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
/** A chain longer than this is not a CDN being tidy, it is something to stop following. */
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const extOf = (name) => {
  const m = /(\.[a-z0-9]+)$/.exec(String(name ?? "").toLowerCase());
  return m ? m[1] : "";
};

/** The media_type Claude would take for this filename, or null when it would take none. */
export function modelTypeFor(filename) {
  const lower = String(filename ?? "").toLowerCase();
  for (const [ext, type] of Object.entries(MODEL_TYPES)) if (lower.endsWith(ext)) return type;
  return null;
}

function unreadableLine(filename, what = null) {
  const named = what ?? KNOWN_UNREADABLE[extOf(filename)] ?? null;
  if (named) {
    return `they sent a photo (${filename}) and you cannot open it: it is ${named}, and you can only read jpeg, png, gif and webp. Say that in one line and ask them to send it as a screenshot if it matters.`;
  }
  return `they sent a picture (${filename}) in a format you cannot read — you can only read jpeg, png, gif and webp. Say that in one line and ask them to send it as a screenshot if it matters.`;
}

/** Shared opening, so every one of these sentences says the same thing about what Reason has seen. */
const notSeen = (name, why) =>
  `they sent a photo (${name}) and it could not be downloaded (${why}), so you have not seen it. Say that once and ask what is in it if it matters.`;

/**
 * The body, with the ceiling enforced as it arrives rather than after.
 *
 * A real `fetch` gives a `Response` whose `body` is an async-iterable stream, so a 40 MB photo is
 * abandoned a few chunks in instead of being held in memory to be refused. Anything that does not
 * have one — a test's fake response, an older shape — falls back to `arrayBuffer()`, and the
 * check after this one catches it.
 */
async function readBody(res, maxBytes) {
  const body = res.body;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    return { bytes: Buffer.from(await res.arrayBuffer()) };
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk);
    total += b.length;
    // Leaving the loop cancels the stream, so the rest of the photo is never pulled down.
    if (total > maxBytes) return { over: total };
    chunks.push(b);
  }
  return { bytes: Buffer.concat(chunks) };
}

/**
 * One inbound image → bytes the model can be handed, or one sentence saying why not.
 *
 * `fetchImpl`, `sips` and the timeout are injectable so the whole of this is testable with no
 * network and no binary: the format check, the URL check, every size check, the redirect rules, the
 * auth retry, the conversion and every refusal sentence.
 *
 * Returns `{ ok: true, mediaType, base64, bytes, authed, converted? }` or `{ ok: false, why }`.
 */
export async function fetchImage({
  url,
  filename = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = config.imageFetchTimeoutMs,
  maxBytes = config.imageMaxBytes,
  auth = null,
  sips = findSips(),
  convert = toJpeg,
} = {}) {
  const name = filename || String(url ?? "").split("?")[0].split("/").pop() || "the picture";
  const hinted = modelTypeFor(name);
  const convertible = CONVERT_EXTS[extOf(name)] ?? null;
  // Is it worth fetching at all? The name is the only clue before the download, and a name that is
  // neither something the model reads nor something this machine can convert is refused without
  // spending anybody's bandwidth on it.
  if (!hinted && !(convertible && sips)) return { ok: false, why: unreadableLine(name) };
  if (!url) return { ok: false, why: `they sent a picture (${name}) but it arrived with no link to it, so you cannot look at it` };

  const first = checkUrl(url);
  if (!first.ok) return { ok: false, why: notSeen(name, first.why) };

  const get = async (target, headers) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    t?.unref?.();
    try {
      // Redirects are followed here rather than by fetch, so each hop goes through checkUrl too:
      // a CDN link that redirects to 127.0.0.1 would otherwise walk straight past the first check.
      return { res: await fetchImpl(target, { headers, redirect: "manual", signal: ac.signal }) };
    } catch (e) {
      return { err: (e?.message ?? String(e)).split("\n")[0] };
    } finally {
      clearTimeout(t);
    }
  };

  let target = first.url;
  let res;
  let err;
  let authed = false;
  for (let hop = 0; ; hop++) {
    ({ res, err } = await get(target, {}));
    // Only when a caller has handed over headers it is willing to send to this host. Nothing does;
    // see the note at the top of this file about whose CDN the link actually points at.
    if (!err && !hop && (res.status === 401 || res.status === 403) && auth) {
      ({ res, err } = await get(target, auth));
      authed = true;
    }
    if (err || !REDIRECTS.has(res.status)) break;
    const next = res.headers?.get?.("location");
    if (!next) break;  // a redirect to nowhere; the !res.ok line below reports the status
    if (hop >= MAX_REDIRECTS) return { ok: false, why: notSeen(name, `the link kept redirecting — more than ${MAX_REDIRECTS} hops`) };
    let resolved;
    try { resolved = new URL(next, target).href; } catch { return { ok: false, why: notSeen(name, "it redirected somewhere that is not a real address") }; }
    const onward = checkUrl(resolved);
    if (!onward.ok) return { ok: false, why: notSeen(name, onward.why) };
    target = onward.url;
  }

  if (err) return { ok: false, why: notSeen(name, err) };
  if (!res.ok) {
    // An inbound media_url "expires after 30 days", which is the one 404 worth naming: an old
    // photo in a replayed conversation is gone rather than broken.
    const gone = res.status === 404 || res.status === 410
      ? " — an inbound link expires after 30 days, so if that photo is old it is gone"
      : "";
    return { ok: false, why: notSeen(name, `HTTP ${res.status}${gone}`) };
  }

  const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;
  const tooBig = (n) => `they sent a photo (${name}) that is ${mb(n)}MB, over the ${mb(maxBytes)}MB you can look at, so you have not seen it. Say that once and ask them to send a smaller one if it matters.`;

  // Checked on the header first: it saves starting a 40 MB download to then refuse it. A
  // Content-Length can be absent or wrong, which is what the stream's own cap is for.
  const claimed = Number(res.headers?.get?.("content-length") ?? 0);
  if (claimed && claimed > maxBytes) return { ok: false, why: tooBig(claimed) };

  let read;
  try {
    read = await readBody(res, maxBytes);
  } catch (e) {
    return { ok: false, why: `they sent a photo (${name}) and reading it failed (${(e?.message ?? String(e)).split("\n")[0]}), so you have not seen it` };
  }
  if (read.over) return { ok: false, why: tooBig(read.over) };
  const bytes = read.bytes;
  if (!bytes.length) {
    return { ok: false, why: `they sent a photo (${name}) and the download came back empty, so you have not seen it. Say that once and ask them to send it again if it matters.` };
  }
  if (bytes.length > maxBytes) return { ok: false, why: tooBig(bytes.length) };

  // What it really is. From here the name is only what the sentence calls it.
  const kind = sniff(bytes);
  if (!kind) {
    return { ok: false, why: `they sent something called ${name} and what actually downloaded is not a picture at all, so there is nothing to look at. Say that once and ask what it was meant to be.` };
  }
  if (READABLE.has(kind)) {
    return { ok: true, mediaType: kind, base64: bytes.toString("base64"), bytes: bytes.length, authed };
  }
  if (!sips) return { ok: false, why: unreadableLine(name, CONVERTIBLE[kind]) };

  const made = await convert({ bytes, filename: name, kind, bin: sips });
  if (!made.ok) {
    return { ok: false, why: `they sent a photo (${name}) and turning it from ${CONVERTIBLE[kind]} into something you can read failed (${made.error}), so you have not seen it. Say that once and ask them to send it as a screenshot if it matters.` };
  }
  // A conversion can come out bigger than it went in — sips writes EXIF and JPEG is not always
  // smaller than HEIC — so the ceiling is checked again on what would actually be sent.
  if (made.bytes.length > maxBytes) return { ok: false, why: tooBig(made.bytes.length) };
  return {
    ok: true, mediaType: "image/jpeg", base64: made.bytes.toString("base64"),
    bytes: made.bytes.length, authed, converted: { from: kind, was_bytes: bytes.length },
  };
}

/**
 * Every image on one inbound turn, ready for the model.
 *
 * Returns the content blocks to put in front of the text — "Claude works best when images come
 * before text" (vision docs) — plus one line per picture that could not be looked at, and one line
 * per picture that could, for the history to keep after the blocks are gone.
 */
export async function imagesFor(attachments = [], { fetchImpl, auth = null, log = () => {} } = {}) {
  const blocks = [];
  const notes = [];
  const seen = [];
  for (const a of attachments) {
    if (a?.kind !== "image") continue;
    const got = await fetchImage({ url: a.url, filename: a.filename, auth, ...(fetchImpl ? { fetchImpl } : {}) });
    if (got.ok) {
      blocks.push({ type: "image", source: { type: "base64", media_type: got.mediaType, data: got.base64 } });
      // What the history keeps once the bytes are gone, and it says plainly that the looking has
      // already happened — otherwise the model offers to go back and check, which it cannot.
      seen.push(`they sent a photo (${a.filename}); you looked at it when it arrived and cannot look at it again`);
      log({ image: a.filename, bytes: got.bytes, authed: got.authed, ...(got.converted ? { converted_from: got.converted.from } : {}) });
    } else {
      notes.push(got.why);
      log({ image: a.filename, could_not_look: got.why });
    }
  }
  return { blocks, notes, seen };
}

/**
 * What a backend that cannot take a picture says instead.
 *
 * The `claude` CLI takes its prompt as a string. Its `--file` option downloads *remote* file
 * resources by id, not a local path, and its own Read tool — which could open an image off disk —
 * is in the denied list on purpose, so that a Reason turn cannot succeed by using Claude Code's
 * tools instead of Reason's. So on that backend an inbound photo genuinely cannot reach the model,
 * and the honest thing is one sentence saying so rather than silence or "blank".
 */
export function cannotLookLines(attachments = []) {
  return attachments
    .filter(a => a?.kind === "image")
    .map(a => `they sent a photo (${a.filename}) and you cannot look at it on this backend — say so in one line and ask what is in it if it matters`);
}
