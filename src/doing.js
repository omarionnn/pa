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

const now = new Map(); // conversationId → [{ line, at, token }], oldest first
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
  now.set(conversationId, [...(now.get(conversationId) ?? []), { line, at, token }]);
  doingEvents.emit("change", conversationId);
  return () => {
    const list = now.get(conversationId) ?? [];
    const left = list.filter(d => d.token !== token);
    if (left.length === list.length) return;
    if (left.length) now.set(conversationId, left); else now.delete(conversationId);
    doingEvents.emit("change", conversationId);
  };
}

/** What the open tab says under "on it.", or null: how far along it is while a count is known, else the line. */
export function doingFor(conversationId, { at = Date.now() } = {}) {
  const list = (now.get(conversationId) ?? []).filter(d => at - d.at <= STALE_MS);
  if (list.length) now.set(conversationId, list); else now.delete(conversationId);
  const d = list.at(-1);
  return d ? d.count ?? d.line : null;
}

/** What one turn reads one by one on this machine: its PDFs and documents (src/media.js pdfsFor, src/docread.js docsFor). */
const readable = (a) => a?.kind === "pdf" || a?.kind === "doc";

/**
 * §4h "the working line counts": how far along a turn's reading is, from the real loop that reads its
 * files one at a time. `next(a)` as each file is started ("reading the lease… 2 of 3 files"),
 * `done()` once the loop is over (back to the turn's own line while the model reads). Counted only
 * where there is a real loop over more than one file; a single PDF is read in one go (pdftotext /
 * PDFKit hand back every page at once, src/pdf.js), so it says no page count it never had.
 */
export function counter(conversationId, attachments = []) {
  const total = (Array.isArray(attachments) ? attachments : []).filter(readable).length;
  let n = 0;
  const set = (words) => {
    const d = (now.get(conversationId) ?? []).at(-1);
    if (!d || d.count === words) return;
    d.count = words;
    doingEvents.emit("change", conversationId);
  };
  return {
    total,
    next(a) {
      if (total < 2 || !readable(a) || n >= total) return;
      n += 1;
      set(`reading ${nameOf(a.filename) ?? (a.kind === "pdf" ? "the PDF" : "the document")}… ${n} of ${total} files`);
    },
    done() { if (n) set(null); },
  };
}

/** For tests. */
export const resetDoing = () => now.clear();
