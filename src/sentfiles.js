// A file Reason sent, as Reason Web serves it back. The outbox keeps the path of what was attached
// (outbox.media = {file, mimeType, filename}); the history row only keeps its name. 2026-10-30: a
// .docx Reason texted showed on Web as a grey box with its name and nothing to open, though the file
// was sitting in data/documents all along.
//
// Only a row of the asking conversation, whose outbox row is the same conversation's, and only a
// file inside one of the roots Reason writes what it sends to: never a path anywhere else.
//
// Audio has two more roots, for audio only: the voice notes Reason speaks (config.audioTmpRoot,
// src/voice.js speak) and its call recordings (config.recordingRoot, src/calls/recordings.js). A
// recording rides an outbox row with its call's id (src/runtime.js _emit); that call must be this
// conversation's too, or nothing is served.

import { realpathSync, statSync } from "node:fs";
import { resolve, sep, extname } from "node:path";
import * as db from "./db.js";
import { config } from "./config.js";

const real = (list) => list.filter(Boolean).map(r => { try { return realpathSync(resolve(r)); } catch { return null; } }).filter(Boolean);
const roots = () => real([config.documentRoot, config.imagenOutputDir, config.imageTmpRoot, config.shotRoot]);
const audioRoots = () => real([config.recordingRoot, config.audioTmpRoot]);

/** The type a file is sent with, by its name, where the record has none (or only octet-stream). */
export const MIME_BY_EXT = {
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".csv": "text/csv", ".txt": "text/plain",
  ".md": "text/markdown", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".heic": "image/heic", ".zip": "application/zip", ".ics": "text/calendar", ".vcf": "text/vcard",
  ".caf": "audio/x-caf", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".opus": "audio/ogg", ".amr": "audio/amr", ".aiff": "audio/aiff",
};
export const mimeOf = (name, given = "") => {
  const g = String(given || "").toLowerCase();
  return g && g !== "application/octet-stream" ? g : (MIME_BY_EXT[extname(String(name ?? "")).toLowerCase()] ?? "application/octet-stream");
};
const AUDIO_EXT = new Set([".caf", ".m4a", ".mp3", ".wav", ".aac", ".ogg", ".opus", ".amr", ".aiff"]);

/**
 * `{ path, mime, name, size, root, audio, callId, seconds }` for the file Reason sent on history row
 * `rowId` of `conversationId`, or null.
 */
export function sentFile(conversationId, rowId) {
  const row = db.db.prepare("SELECT outbox_id FROM messages WHERE id = ? AND conversation_id = ? AND role = 'assistant' AND deleted_at IS NULL").get(Number(rowId), conversationId);
  if (!row?.outbox_id) return null;
  const ob = db.db.prepare("SELECT conversation_id, media FROM outbox WHERE id = ?").get(row.outbox_id);
  if (!ob?.media || ob.conversation_id !== conversationId) return null;
  let m;
  try { m = JSON.parse(ob.media); } catch { return null; }
  if (!m?.file) return null;
  let path;
  try { path = realpathSync(String(m.file)); } catch { return null; }
  const inside = (list) => list.find(r => path.startsWith(r + sep)) ?? null;
  // Audio is told by the real file's own extension, not by anything the record says.
  const audio = AUDIO_EXT.has(extname(path).toLowerCase());
  const root = inside(roots()) ?? (audio ? inside(audioRoots()) : null);
  if (!root) return null;
  let callId = null;
  if (m.call_id != null) {
    // …and only while the recording is kept: one deleted (by hand or by retention) is gone from Web too,
    // even where a converted .caf of it is still on disk.
    const call = db.db.prepare("SELECT conversation_id, recording_state FROM calls WHERE id = ?").get(Number(m.call_id));
    if (!call || call.conversation_id !== conversationId || call.recording_state !== "stored") return null;
    callId = Number(m.call_id);
  }
  let size;
  try { const st = statSync(path); if (!st.isFile()) return null; size = st.size; } catch { return null; }
  const name = String(m.filename || path.split(sep).pop());
  return { path, mime: mimeOf(name, m.mimeType), name, size, root, audio, callId, seconds: Number(m.seconds) || null };
}
