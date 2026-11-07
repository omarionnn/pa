// Whose file is this? Every person's files sit side by side on one disk: the database, every call
// recording (call-<id>.<fmt>, ids in order), every document, voice note, picture, screenshot and
// browser profile. A tool that takes a path from the model (drive_upload, voice_note_send) used to
// check only "inside the data directory", so one person could ask for another's call recording, or
// for the shared database itself, and get it in their own Drive or as a voice note.
//
// A path is this conversation's only when Reason can show it made or kept the file FOR this
// conversation, from its own records, never from anything the model or a message says:
//
//   - a file a tool call of this conversation wrote (noteMade: walked out of the result, kept only
//     when the file appeared during that very call, so a path merely echoed back, such as an error
//     repeating what it was asked for, is never adopted);
//   - a document row of this conversation (documents.path);
//   - a call recording of this conversation (calls.id in call-<id>.*, recording kept);
//   - an attachment Reason already sent in this conversation (outbox.media.file).
//
// And only inside the roots Reason writes such files to. The database, the browser profiles and
// anything else under the data directory are nobody's to upload.

import { realpathSync, statSync } from "node:fs";
import { resolve, sep, basename, isAbsolute } from "node:path";
import * as db from "./db.js";
import { config } from "./config.js";

// The record is db.js's conversation_files table; a delete takes it with the rest (src/data.js).

const realOf = (p) => { try { return realpathSync(resolve(String(p))); } catch { return null; } };
const roots = () => [config.documentRoot, config.imagenOutputDir, config.imageTmpRoot, config.shotRoot, config.audioTmpRoot, config.recordingRoot]
  .filter(Boolean).map(realOf).filter(Boolean);
const insideRoots = (real) => roots().some(r => real.startsWith(r + sep));
/** The prefix a default screenshot of this conversation is named with (browser_screenshot). */
export const shotPrefix = (conversationId) => `${String(conversationId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40)}-`;

/**
 * After a tool call of `conversationId` that started at `since` (ms): every absolute path in its
 * result that is a file inside Reason's roots and appeared during the call is this conversation's.
 * Never throws.
 */
export function noteMade(conversationId, out, since, input = null) {
  if (!conversationId || !out || typeof out !== "object") return;
  try {
    // A path the call was GIVEN is never adopted, even when the file changed meanwhile: a voice
    // note whose text is somebody else's next recording path must not make that recording theirs.
    const asked = (() => { try { return JSON.stringify(input ?? null); } catch { return ""; } })();
    // Recordings are made by the call runtime, never by a tool call: theirs by the calls table only.
    const rec = realOf(config.recordingRoot);
    const seen = new Set();
    const walk = (v, depth) => {
      if (depth > 4 || seen.size > 50) return;
      if (typeof v === "string") {
        if (v.length > 1000 || !isAbsolute(v) || seen.has(v)) return;
        seen.add(v);
        const real = realOf(v);
        if (!real || !insideRoots(real)) return;
        if (rec && real.startsWith(rec + sep)) return;
        if (asked && (asked.includes(JSON.stringify(v).slice(1, -1)) || asked.includes(JSON.stringify(real).slice(1, -1)) || asked.includes(basename(real)))) return;
        const st = statSync(real);
        // A second of slack for filesystems that keep coarse times; a file older than that was not
        // made by this call.
        if (!st.isFile() || st.mtimeMs < since - 1000) return;
        db.db.prepare("INSERT OR IGNORE INTO conversation_files (conversation_id, path, at) VALUES (?, ?, ?)").run(conversationId, real, Date.now());
        return;
      }
      if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, depth + 1); return; }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k !== "_image") walk(x, depth + 1); }
    };
    walk(out, 0);
  } catch { /* best effort: a file not noted is a file refused, never one handed to the wrong person */ }
}

function madeFor(conversationId, real) {
  if (db.db.prepare("SELECT 1 FROM conversation_files WHERE conversation_id = ? AND path = ?").get(conversationId, real)) return true;
  for (const r of db.db.prepare("SELECT path FROM documents WHERE conversation_id = ?").all(conversationId)) {
    if (realOf(r.path) === real) return true;
  }
  const rec = realOf(config.recordingRoot);
  const m = /^call-(\d+)\.[a-z0-9]+$/i.exec(basename(real));
  if (rec && m && real.startsWith(rec + sep)) {
    const call = db.db.prepare("SELECT conversation_id, recording_state FROM calls WHERE id = ?").get(Number(m[1]));
    if (call && call.conversation_id === conversationId && call.recording_state === "stored") return true;
  }
  for (const r of db.db.prepare("SELECT media FROM outbox WHERE conversation_id = ? AND media IS NOT NULL").all(conversationId)) {
    try { if (realOf(JSON.parse(r.media)?.file) === real) return true; } catch {}
  }
  return false;
}

/**
 * `{ ok: true, path }` (the real path) when `path` is a file Reason made or kept for
 * `conversationId`, else `{ ok: false, status, why }`. The why never says whether somebody else's
 * file exists.
 */
export function ownFile(conversationId, path) {
  const asked = String(path ?? "").trim();
  if (!asked) return { ok: false, status: "no_path", why: "no file path was given." };
  const refused = { ok: false, status: "not_theirs", why: `${asked} is not a file Reason made for this person, so it is not going anywhere. Only a file Reason itself made or kept for them can be used: a document it wrote, a picture or screenshot it took, a recording of their own call.` };
  const real = realOf(asked);
  if (!real || !conversationId || !insideRoots(real)) return refused;
  try { if (!statSync(real).isFile()) return refused; } catch { return refused; }
  return madeFor(conversationId, real) ? { ok: true, path: real } : refused;
}
