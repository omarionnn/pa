// What Reason is doing right now, in one conversation, in words the open Web tab can show under
// "on it." (HANDOFF §4c item 3: 'then Reason's "on it." with what it's doing ("reading the lease…")').
//
// Only what is really happening is ever said. The runtime opens one of these for the length of a
// turn (src/runtime.js) from the files that turn was handed: a PDF or a document is read in that turn
// (src/media.js pdfsFor, src/docread.js), a photo is looked at (imagesFor). A turn with nothing
// attached says nothing here, and the tab shows plain "on it.". When the turn ends, so does the line.
// In-process, like the typing event it rides beside: nothing is stored, and a restart forgets it.

import { EventEmitter } from "node:events";

/** A turn that has run this long without ending is not "reading the lease" any more. */
export const STALE_MS = 10 * 60_000;

const now = new Map(); // conversationId → { line, at, token }
/** `change` with the conversation id, whenever its line starts or ends (the Web stream listens). */
export const doingEvents = new EventEmitter();
doingEvents.setMaxListeners(0);
let seq = 0;

/** "lease.pdf" → "the lease"; a camera roll's "IMG_2041.pdf" or "document.pdf" → null (say what kind instead). */
export function nameOf(filename = "") {
  const stem = String(filename ?? "").split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!stem || stem.length > 40) return null;
  if (/^(img|dsc|scan|pxl|photo|image|document|file|untitled|download|screenshot)[\s\d.()]*$/.test(stem) || /^[\d\s.()]+$/.test(stem)) return null;
  if (!/[a-z]/.test(stem)) return null;
  return `the ${stem}`;
}

/** The line for what one turn was handed, or null when there is nothing worth saying. */
export function lineFor(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  const reads = list.filter(a => a?.kind === "pdf" || a?.kind === "doc");
  if (reads.length === 1) return `reading ${nameOf(reads[0].filename) ?? (reads[0].kind === "pdf" ? "the PDF" : "the document")}…`;
  if (reads.length > 1) return `reading the ${reads.length} files…`;
  const photos = list.filter(a => a?.kind === "image").length;
  if (photos === 1) return "looking at the photo…";
  if (photos > 1) return `looking at the ${photos} photos…`;
  return null;
}

/**
 * Open the line for one turn. Returns the function that closes it (safe to call twice); a turn that
 * started later in the same conversation keeps its own line when an earlier one closes.
 */
export function begin(conversationId, attachments = [], { at = Date.now() } = {}) {
  const line = conversationId ? lineFor(attachments) : null;
  if (!line) return () => {};
  const token = ++seq;
  now.set(conversationId, { line, at, token });
  doingEvents.emit("change", conversationId);
  return () => { if (now.get(conversationId)?.token === token) { now.delete(conversationId); doingEvents.emit("change", conversationId); } };
}

/** What the open tab says under "on it.", or null. */
export function doingFor(conversationId, { at = Date.now() } = {}) {
  const d = now.get(conversationId);
  if (!d) return null;
  if (at - d.at > STALE_MS) { now.delete(conversationId); return null; }
  return d.line;
}

/** For tests. */
export const resetDoing = () => now.clear();
