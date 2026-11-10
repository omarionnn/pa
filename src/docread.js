// A document handed in on Reason Web: a Word file (.docx) or plain text (.txt, .md, .csv). The
// typed line under a failed upload promises "PHOTOS, PDFS, DOCS · UP TO 20 MB EACH" (sheet-uploads
// 3C), so a doc has to be something Reason can really read, the way a PDF is (src/media.js pdfsFor):
// read on this machine, the words handed to the model as text, nothing sent anywhere.
//
// A .docx is a zip whose words are in word/document.xml. Node has inflate (zlib) but no zip reader,
// and a dependency for forty lines is not worth one, so the central directory is read here: find the
// one entry, inflate it, keep the text of each paragraph. What the bytes are is decided by the bytes
// (src/webuploads.js classify), never the name.
import { inflateRawSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { localUpload, filePath } from "./webuploads.js";
import { readPlain } from "./restfiles.js";

/** What one turn hands the model, at most, from one document. Same order of size as a PDF's read. */
export const MAX_DOC_CHARS = 60_000;

/** The entries of a zip, from its central directory: `{ name, method, size, csize, offset }`. */
export function zipEntries(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length < 22) return null;
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null;
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), size = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), offset = b.readUInt32LE(p + 42);
    out.push({ name: b.toString("utf8", p + 46, p + 46 + nlen), method, size, csize, offset });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** The most a document's words may inflate to. A real 300-page lease is a few MB of XML. */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

/** One entry's bytes (stored or deflated), or null. Capped as it inflates, so a zip bomb is refused, not inflated. */
export function zipRead(buf, entry, { max = MAX_XML_BYTES } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const p = entry.offset;
  if (p + 30 > b.length || b.readUInt32LE(p) !== 0x04034b50) return null;
  const start = p + 30 + b.readUInt16LE(p + 26) + b.readUInt16LE(p + 28);
  const data = b.subarray(start, start + entry.csize);
  if (entry.size > max || entry.csize > b.length) return null;
  try {
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: max });
  } catch { return null; }
  return null;
}

/** Is this a Word document (a zip with word/document.xml in it)? */
export function isDocx(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length < 30 || b.readUInt32LE(0) !== 0x04034b50) return false;
  return !!zipEntries(b)?.some(e => e.name === "word/document.xml");
}

/** Plain text: valid UTF-8, no NULs, almost nothing that isn't a printable character or whitespace. */
export function isPlainText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (!b.length || b.includes(0)) return false;
  let s;
  try { s = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 64 * 1024)); } catch {
    // A cut in the middle of a character at the 64 KB edge is not a reason to refuse it.
    if (b.length <= 64 * 1024) return false;
    try { s = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 64 * 1024 - 4)); } catch { return false; }
  }
  const bad = (s.match(/[\u0000-\u0008\u000e-\u001f\u007f]/g) ?? []).length;
  return bad <= s.length / 1000;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e) => {
  if (e[0] !== "#") return ENT[e] ?? m;
  const hex = e[1] === "x" || e[1] === "X";
  const cp = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
});

/** The words of a .docx, a paragraph a line. `{ ok, text, chars }` or `{ ok: false, why }`. */
export function docxText(buf) {
  const entry = zipEntries(buf)?.find(e => e.name === "word/document.xml");
  if (!entry) return { ok: false, why: "it is not a Word document" };
  const xml = zipRead(buf, entry);
  if (!xml) return { ok: false, why: "the Word file is damaged or too large to open" };
  const text = unxml(xml.toString("utf8")
    .replace(/<w:tab\/>/g, "\t").replace(/<w:(?:br|cr)\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { ok: true, text, chars: text.length };
}

/** The words of a document's bytes, whichever kind it is. */
export function docText(buf) {
  if (isDocx(buf)) return docxText(buf);
  if (isPlainText(buf)) { const text = buf.toString("utf8").replace(/\r\n?/g, "\n").trim(); return { ok: true, text, chars: text.length }; }
  return { ok: false, why: "it is not a document this can read" };
}

/**
 * Every document on one turn, read and handed to the model as text — the same shape as pdfsFor:
 * `notes` the model reads this turn, `seen` what the history keeps. Only a file handed in on Web is a
 * `doc` (src/webuploads.js); it is read from disk, never fetched.
 */
export async function docsFor(attachments = [], { log = () => {}, cover = () => {}, onRead = () => {}, conversationId = "" } = {}) {
  const notes = [];
  const seen = [];
  for (const a of attachments) {
    if (a?.kind !== "doc") continue;
    try { onRead(a); } catch { /* never costs a read */ }
    const name = a.filename || "the document";
    const local = localUpload(a.url, { conversationId });
    const path = local?.meta ? filePath(local.meta) : null;
    if (!path || !existsSync(path)) {
      notes.push(`they sent a document (${name}) but it is no longer on this machine`);
      cover(a.media_id, { coverage: "failed", detail: "gone" });
      continue;
    }
    let got;
    try { got = docText(readPlain(path)); } catch (e) { got = { ok: false, why: "the file is damaged" }; }
    if (!got.ok || !got.text) {
      const why = got.ok ? "there are no words in it" : got.why;
      notes.push(`they sent a document (${name}) and it could not be read: ${why}`);
      cover(a.media_id, { coverage: "failed", detail: why });
      log({ doc: name, could_not_read: why });
      continue;
    }
    const cut = got.text.length > MAX_DOC_CHARS;
    const body = cut ? got.text.slice(0, MAX_DOC_CHARS) : got.text;
    notes.push(`they sent a document (${name})${cut ? ` (the first ${MAX_DOC_CHARS} characters of ${got.chars})` : ""} — here is the text from it:\n${body}`);
    seen.push(`they sent a document (${name}); you read it when it arrived`);
    cover(a.media_id, { coverage: "read", detail: `${got.chars} characters` });
    log({ doc: name, chars: got.chars });
  }
  return { notes, seen };
}
