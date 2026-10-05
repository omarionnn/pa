// Where a call's audio lives once Reason has it.
//
// A provider hands over either a local path or a URL. Neither is something to keep: a provider's
// URL expires, and a path in somebody's temp directory is gone after a reboot. So the audio is
// copied once into `data/recordings/` under a name derived from the call id, and from then on the
// call row points at a file Reason owns — which is what makes "send it to the owner", "include it
// in the export" and "delete removes it" all mean the same file.
//
// Nothing here decides whether to record — every call is recorded, and there is no switch. This
// module only files what arrived, and reports plainly when nothing did.
import { createHash } from "node:crypto";
import { mkdirSync, copyFileSync, statSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { config } from "../config.js";

// Containers Reason will file. Deliberately short: these are the audio types the channels can
// actually send (Linq's own documented list is M4A, AAC, MP3, WAV, AIFF, CAF, AMR), and refusing
// an unknown extension is better than attaching something nobody can play.
const FORMATS = new Map([
  ["wav", "audio/wav"], ["mp3", "audio/mpeg"], ["m4a", "audio/mp4"], ["aac", "audio/aac"],
  ["aiff", "audio/aiff"], ["caf", "audio/x-caf"], ["amr", "audio/amr"], ["ogg", "audio/ogg"],
]);

export function mimeFor(format) {
  return FORMATS.get(String(format ?? "").toLowerCase().replace(/^\./, "")) ?? null;
}

export function recordingsDir() {
  const dir = resolve(config.recordingRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The one name a call's audio is ever filed under. */
export function recordingFileFor(callId, format) {
  return resolve(recordingsDir(), `call-${callId}.${String(format).toLowerCase()}`);
}

/**
 * What container these bytes really are, read off the first few of them — or null when they are
 * not audio Reason knows.
 *
 * This exists because of the first real call: the provider's recording endpoint answered 200 with
 * 111 bytes of JSON, and it was filed as `call-1.wav` and reported as saved. A status code and a
 * file extension say nothing about what is in the body, so the body is what gets asked.
 */
export function sniffAudio(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (b.length < 12) return null;
  const at = (i, n) => b.toString("latin1", i, i + n);
  if (at(0, 4) === "RIFF" && at(8, 4) === "WAVE") return "wav";
  if (at(0, 3) === "ID3") return "mp3";
  if (at(0, 4) === "FORM" && (at(8, 4) === "AIFF" || at(8, 4) === "AIFC")) return "aiff";
  if (at(0, 4) === "caff") return "caf";
  if (at(0, 4) === "OggS") return "ogg";
  if (at(0, 5) === "#!AMR") return "amr";
  if (at(4, 4) === "ftyp") return "m4a";
  // No tag in front: twelve sync bits. Layer bits 00 is ADTS, which is raw AAC; anything else with
  // the first eleven set is an MPEG audio frame.
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "aac";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return "mp3";
  return null;
}

/**
 * The fewest bytes a second of call audio can be. The thinnest thing on the list above is AMR at
 * 4.75 kbit/s, about 600 bytes a second, so anything under 500 is not a recording of that length
 * whatever its header says — it is a stub, a truncated download, or an error page with a tag on it.
 */
const MIN_BYTES_PER_SECOND = 500;

/**
 * Is this body the audio it is being filed as? Returns the container it really is, or why not.
 *
 * Three independent checks, because each catches something the others miss: what the server said
 * it was sending, what the bytes are, and whether there are enough of them for a call that long.
 */
function looksLikeAudio(bytes, { contentType = "", seconds = null } = {}) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  // No content-type at all is let through to the byte check; a wrong one is not.
  if (type && !type.startsWith("audio/") && type !== "application/octet-stream" && type !== "binary/octet-stream") {
    return { ok: false, error: `what came back is not audio: it was sent as ${type} (${bytes.length} bytes)` };
  }
  const format = sniffAudio(bytes);
  if (!format) {
    return { ok: false, error: `what came back is not audio: ${bytes.length} bytes that do not start like any audio file Reason handles` };
  }
  if (Number.isFinite(seconds) && seconds > 0 && bytes.length < seconds * MIN_BYTES_PER_SECOND) {
    return { ok: false, error: `what came back is too small to be the recording: ${bytes.length} bytes for a ${Math.round(seconds)}-second call` };
  }
  return { ok: true, format };
}

const contentTypeOf = (res) => {
  try { return res?.headers?.get?.("content-type") ?? ""; } catch { return ""; }
};

/**
 * Some providers answer their recording endpoint with a pointer rather than the audio — Bland's
 * returns `{"code":200,"status":"success","url":"https://api.bland.ai/v1/recordings/<id>"}`.
 * Returns that URL when this body is such a pointer, or null when it is anything else.
 */
function pointerIn(bytes, contentType) {
  const type = String(contentType ?? "").toLowerCase();
  if (bytes.length > 64 * 1024) return null;
  if (!type.includes("json") && bytes[0] !== 0x7b /* { */) return null;
  try {
    const json = JSON.parse(bytes.toString("utf8"));
    return typeof json?.url === "string" && json.url.trim() ? json.url.trim() : null;
  } catch {
    return null;
  }
}

function formatFrom(ref) {
  const explicit = String(ref.format ?? "").toLowerCase().replace(/^\./, "");
  if (FORMATS.has(explicit)) return explicit;
  const fromName = extname(basename(String(ref.path ?? ref.url ?? "").split("?")[0])).slice(1).toLowerCase();
  if (FORMATS.has(fromName)) return fromName;
  return null;
}

/**
 * Bring one recording onto this machine.
 *
 * Returns what to write on the call row: a `file` Reason owns plus its real size and checksum, or
 * `ok: false` with a reason in plain words. A failure here is never an exception — "the provider
 * said there was audio and it could not be fetched" is something the owner has to be told, so it
 * has to be a value the caller can read and pass on.
 *
 * @param {number} callId
 * @param {import("./provider.js").Recording} ref
 * @param {{fetchImpl?: Function, maxBytes?: number}} opts
 */
export async function storeRecording(callId, ref, { fetchImpl = globalThis.fetch, maxBytes = 25 * 1024 * 1024 } = {}) {
  if (!ref || (!ref.path && !ref.url)) return { ok: false, error: "the provider returned no audio" };
  const mb = (n) => Math.round(n / (1024 * 1024));

  const declared = formatFrom(ref);
  if (!declared) {
    const described = ref.format || extname(String(ref.path ?? ref.url ?? "")) || "unknown";
    return { ok: false, error: `the recording is in a format Reason does not handle (${described})` };
  }
  // The file is named for what the bytes are, not for what the provider said they would be: an
  // MP3 filed as .wav is a file that will not play for the person it is sent to.
  let format = declared;
  let file;

  try {
    if (ref.path) {
      if (!existsSync(ref.path)) return { ok: false, error: `the provider's file is not there (${ref.path})` };
      const size = statSync(ref.path).size;
      if (size === 0) return { ok: false, error: "the provider's file is empty" };
      if (size > maxBytes) return { ok: false, error: `the recording is ${mb(size)}MB, over the ${mb(maxBytes)}MB limit` };
      const audio = looksLikeAudio(readFileSync(ref.path), { seconds: ref.seconds });
      if (!audio.ok) return { ok: false, error: audio.error };
      format = audio.format;
      file = recordingFileFor(callId, format);
      // Same path in and out means the provider handed us a file we already own: leave it alone.
      if (resolve(ref.path) !== file) copyFileSync(ref.path, file);
    } else {
      let res = await fetchImpl(ref.url, { headers: ref.headers ?? {} });
      if (!res?.ok) return { ok: false, error: `the provider's recording URL answered HTTP ${res?.status ?? "nothing"}` };
      let bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) return { ok: false, error: "the provider's recording URL returned an empty body" };

      // One hop, and only to a host the provider named in advance. The headers carry the provider's
      // key, so "wherever the JSON says" is not somewhere they can be sent.
      const pointed = Array.isArray(ref.pointerHosts) && ref.pointerHosts.length ? pointerIn(bytes, contentTypeOf(res)) : null;
      if (pointed) {
        let to;
        try { to = new URL(pointed); } catch { to = null; }
        if (!to || to.protocol !== "https:" || !ref.pointerHosts.includes(to.host)) {
          return {
            ok: false,
            error: `the provider said the audio is at ${to ? to.host : "an address that is not a URL"}, and its key is only ever sent to ${ref.pointerHosts.join(" or ")}, so it was not fetched`,
          };
        }
        res = await fetchImpl(to.href, { headers: ref.headers ?? {} });
        if (!res?.ok) return { ok: false, error: `the provider's recording URL answered HTTP ${res?.status ?? "nothing"}` };
        bytes = Buffer.from(await res.arrayBuffer());
        if (!bytes.length) return { ok: false, error: "the provider's recording URL returned an empty body" };
      }

      if (bytes.length > maxBytes) return { ok: false, error: `the recording is ${mb(bytes.length)}MB, over the ${mb(maxBytes)}MB limit` };
      const audio = looksLikeAudio(bytes, { contentType: contentTypeOf(res), seconds: ref.seconds });
      if (!audio.ok) return { ok: false, error: audio.error };
      format = audio.format;
      file = recordingFileFor(callId, format);
      writeFileSync(file, bytes);
    }
  } catch (e) {
    return { ok: false, error: `the recording could not be saved: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }

  const bytes = statSync(file).size;
  return {
    ok: true,
    file,
    format,
    mime: mimeFor(format),
    bytes,
    seconds: Number.isFinite(ref.seconds) ? Math.round(ref.seconds) : null,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

/** Delete one recording file. Missing is success: the point is that it is gone. */
export function deleteRecordingFile(file) {
  if (!file) return { ok: true, existed: false };
  try {
    if (!existsSync(file)) return { ok: true, existed: false };
    unlinkSync(file);
    return { ok: true, existed: true };
  } catch (e) {
    return { ok: false, existed: true, error: (e?.message ?? String(e)).split("\n")[0] };
  }
}

/** Read one recording's bytes, for an export that carries the audio inside it. */
export function readRecording(file) {
  try {
    if (!file || !existsSync(file)) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}
