// Where a call's audio lives once Reason has it.
//
// A provider hands over either a local path or a URL. Neither is something to keep: a provider's
// URL expires, and a path in somebody's temp directory is gone after a reboot. So the audio is
// copied once into `data/recordings/` under a name derived from the call id, and from then on the
// call row points at a file Reason owns — which is what makes "send it to the owner", "include it
// in the export" and "delete removes it" all mean the same file.
//
// Nothing here decides whether to record. That is config (`REASON_CALL_RECORDING`) and the call
// request; this module only files what arrived.
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

  const format = formatFrom(ref);
  if (!format) {
    const described = ref.format || extname(String(ref.path ?? ref.url ?? "")) || "unknown";
    return { ok: false, error: `the recording is in a format Reason does not handle (${described})` };
  }
  const file = recordingFileFor(callId, format);

  try {
    if (ref.path) {
      if (!existsSync(ref.path)) return { ok: false, error: `the provider's file is not there (${ref.path})` };
      const size = statSync(ref.path).size;
      if (size === 0) return { ok: false, error: "the provider's file is empty" };
      if (size > maxBytes) return { ok: false, error: `the recording is ${mb(size)}MB, over the ${mb(maxBytes)}MB limit` };
      // Same path in and out means the provider handed us a file we already own: leave it alone.
      if (resolve(ref.path) !== file) copyFileSync(ref.path, file);
    } else {
      const res = await fetchImpl(ref.url, { headers: ref.headers ?? {} });
      if (!res?.ok) return { ok: false, error: `the provider's recording URL answered HTTP ${res?.status ?? "nothing"}` };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) return { ok: false, error: "the provider's recording URL returned an empty body" };
      if (bytes.length > maxBytes) return { ok: false, error: `the recording is ${mb(bytes.length)}MB, over the ${mb(maxBytes)}MB limit` };
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
