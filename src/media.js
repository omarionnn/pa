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
//     2026-10-05. An iPhone shoots HEIC by default, which is NOT on that list, so the common case
//     is a picture Reason can see is a picture and still cannot open. It gets its own sentence
//     rather than being lumped in with "a file".
//   - **how big.** "The maximum size per image is 10 MB (base64-encoded) when using the Claude API
//     directly." Base64 is four bytes per three, so the ceiling on the real bytes is 7.5 MB; 7 MB
//     is used, under it with room for the rest of the request. Enforced before the request, because
//     a 400 from Anthropic is a worse way to find out.
//   - **one sentence per failure, and only one.** Whatever goes wrong — the wrong format, too big,
//     the link expired, the CDN would not answer — the model is told exactly that, in words it can
//     repeat, once. It is never told "blank".
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

/** Extension → the media_type Claude takes. Anything not in here cannot be looked at. */
const MODEL_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Formats that are obviously pictures and obviously not readable, named so the refusal can say
 * what to do about it. Anything else unrecognised gets the general line.
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

/** The media_type Claude would take for this filename, or null when it would take none. */
export function modelTypeFor(filename) {
  const lower = String(filename ?? "").toLowerCase();
  for (const [ext, type] of Object.entries(MODEL_TYPES)) if (lower.endsWith(ext)) return type;
  return null;
}

function unreadableLine(filename) {
  const lower = String(filename ?? "").toLowerCase();
  for (const [ext, what] of Object.entries(KNOWN_UNREADABLE)) {
    if (lower.endsWith(ext)) {
      return `they sent a photo (${filename}) and you cannot open it: it is ${what}, and you can only read jpeg, png, gif and webp. Say that in one line and ask them to send it as a screenshot if it matters.`;
    }
  }
  return `they sent a picture (${filename}) in a format you cannot read — you can only read jpeg, png, gif and webp. Say that in one line and ask them to send it as a screenshot if it matters.`;
}

/**
 * One inbound image → bytes the model can be handed, or one sentence saying why not.
 *
 * `fetchImpl` and the timeout are injectable so the whole of this is testable with no network: the
 * format check, the two size checks, the auth retry and every refusal sentence.
 *
 * Returns `{ ok: true, mediaType, base64, bytes, authed }` or `{ ok: false, why }`.
 */
export async function fetchImage({
  url,
  filename = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = config.imageFetchTimeoutMs,
  maxBytes = config.imageMaxBytes,
  auth = null,
} = {}) {
  const name = filename || String(url ?? "").split("?")[0].split("/").pop() || "the picture";
  const mediaType = modelTypeFor(name);
  if (!mediaType) return { ok: false, why: unreadableLine(name) };
  if (!url) return { ok: false, why: `they sent a picture (${name}) but it arrived with no link to it, so you cannot look at it` };

  const get = async (headers) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    t?.unref?.();
    try {
      return { res: await fetchImpl(url, { headers, signal: ac.signal }) };
    } catch (e) {
      return { err: (e?.message ?? String(e)).split("\n")[0] };
    } finally {
      clearTimeout(t);
    }
  };

  let { res, err } = await get({});
  let authed = false;
  // Only when a caller has handed over headers it is willing to send to this host. Nothing does;
  // see the note at the top of this file about whose CDN the link actually points at.
  if (!err && (res.status === 401 || res.status === 403) && auth) {
    ({ res, err } = await get(auth));
    authed = true;
  }
  if (err) {
    return { ok: false, why: `they sent a photo (${name}) and it could not be downloaded (${err}), so you have not seen it. Say that once and ask what is in it if it matters.` };
  }
  if (!res.ok) {
    // An inbound media_url "expires after 30 days", which is the one 404 worth naming: an old
    // photo in a replayed conversation is gone rather than broken.
    const gone = res.status === 404 || res.status === 410
      ? " — an inbound link expires after 30 days, so if that photo is old it is gone"
      : "";
    return { ok: false, why: `they sent a photo (${name}) and it could not be downloaded (HTTP ${res.status}${gone}), so you have not seen it. Say that once and ask what is in it if it matters.` };
  }

  // Checked twice on purpose: the header saves downloading 40 MB to then refuse it, and the real
  // length is what actually counts, because a Content-Length can be absent or wrong.
  const claimed = Number(res.headers?.get?.("content-length") ?? 0);
  const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;
  if (claimed && claimed > maxBytes) {
    return { ok: false, why: `they sent a photo (${name}) that is ${mb(claimed)}MB, over the ${mb(maxBytes)}MB you can look at, so you have not seen it. Say that once and ask them to send a smaller one if it matters.` };
  }

  let bytes;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, why: `they sent a photo (${name}) and reading it failed (${(e?.message ?? String(e)).split("\n")[0]}), so you have not seen it` };
  }
  if (!bytes.length) {
    return { ok: false, why: `they sent a photo (${name}) and the download came back empty, so you have not seen it. Say that once and ask them to send it again if it matters.` };
  }
  if (bytes.length > maxBytes) {
    return { ok: false, why: `they sent a photo (${name}) that is ${mb(bytes.length)}MB, over the ${mb(maxBytes)}MB you can look at, so you have not seen it. Say that once and ask them to send a smaller one if it matters.` };
  }

  return { ok: true, mediaType, base64: bytes.toString("base64"), bytes: bytes.length, authed };
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
      log({ image: a.filename, bytes: got.bytes, authed: got.authed });
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
