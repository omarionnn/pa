// Where a document lives once Reason has written it.
//
// The same bargain the call recordings are in (src/calls/recordings.js), for the same reason: the
// file is Reason's own, under the data directory, named from the row that points at it. That is
// what makes three separate promises mean the same bytes —
//
//   "send me that again"   reads the file off the row and attaches it
//   "export my data"       carries the file inside the export, base64, with its checksum
//   "delete everything"    unlinks the file as well as the row
//
// A document in somebody's temp directory, or named after whatever the model called it, would break
// all three the first time two documents were called the same thing.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.js";
import { renderDocx } from "./docx.js";
import { renderPptx } from "./pptx.js";
import { renderPdf } from "./print.js";

/**
 * The three kinds, and everything that differs between them in one place: what the file is called,
 * what a phone has to be told it is, which writer makes the bytes, and what it starts with.
 *
 * The mime types are the long official ones (the OOXML ones from ECMA-376, and application/pdf),
 * because they are what a phone reads to decide whether it can open an attachment at all.
 */
export const KINDS = {
  docx: {
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    what: "a Word document",
    render: renderDocx,
    // A .docx and a .pptx are both zip files: "PK\x03\x04".
    magic: "PK",
  },
  pptx: {
    ext: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    what: "a slide deck",
    render: renderPptx,
    magic: "PK",
  },
  pdf: {
    ext: "pdf",
    mime: "application/pdf",
    what: "a PDF",
    render: renderPdf,
    magic: "%PDF-",
  },
};

export function mimeForKind(kind) {
  return KINDS[kind]?.mime ?? null;
}

export function documentsDir() {
  const dir = resolve(config.documentRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A filename a person's phone can show them: the title, lower-cased and hyphenated, with the right
 * suffix. The same shape as a page's card filename, and for the same reason — "doc-7.docx" in
 * somebody's downloads folder is a file they will never find again.
 *
 * Anything a path could be smuggled through is replaced rather than refused: the title is the
 * model's, and no title should be able to decide where a file is written.
 */
export function documentFilename(title, kind) {
  const ext = KINDS[kind]?.ext ?? "bin";
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${slug || "document"}.${ext}`;
}

/** The one path a document is ever written to. The id is in it, so two of the same name are two files. */
export function documentPath(id, filename) {
  return join(documentsDir(), `${id}-${filename}`);
}

/**
 * Write one document's bytes.
 *
 * Returns what belongs on the row, with the size and the checksum read back off the file on disk
 * rather than off the buffer that was meant to go there.
 */
export function writeDocument({ id, kind, filename, bytes }) {
  const file = documentPath(id, filename);
  const magic = KINDS[kind]?.magic;
  if (magic && bytes.toString("latin1", 0, magic.length) !== magic) {
    return { ok: false, error: `what the ${kind} writer gave back does not start like a ${kind} file` };
  }
  try {
    writeFileSync(file, bytes);
  } catch (e) {
    return { ok: false, error: `the file could not be written: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }
  const size = statSync(file).size;
  if (!size) return { ok: false, error: "the file was written and is empty" };
  return { ok: true, file, bytes: size, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

/**
 * Make the bytes for one document. Nothing is written and no row exists yet: a renderer that
 * throws here has left nothing behind to tidy up.
 *
 * @param {{kind: string, title: string, subtitle?: string|null, closing?: string|null,
 *          blocks: Array<object>, forName?: string, when?: string, at?: number|null}} doc
 * @param {{render?: Function}} opts  a renderer, for the tests that must not launch a browser
 */
export async function renderDocument({ kind, title, subtitle = null, closing = null, blocks = [], forName = "", when = "", at = null }, { render = null } = {}) {
  const spec = KINDS[kind];
  if (!spec) return { ok: false, error: `'${kind}' is not a kind of document Reason writes.` };
  try {
    const out = await (render ?? spec.render)({ kind, title, subtitle, closing, blocks, forName, when, at });
    const bytes = Buffer.isBuffer(out) ? out : Buffer.from(out ?? []);
    if (!bytes.length) return { ok: false, error: `the ${kind} came out empty` };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, error: `the ${kind} could not be written: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }
}

/** Delete one document file. Missing is success: the point is that it is gone. */
export function deleteDocumentFile(file) {
  if (!file) return { ok: true, existed: false };
  try {
    if (!existsSync(file)) return { ok: true, existed: false };
    unlinkSync(file);
    return { ok: true, existed: true };
  } catch (e) {
    return { ok: false, existed: true, error: (e?.message ?? String(e)).split("\n")[0] };
  }
}

/** Read one document's bytes — for an export that carries the file inside it, and for a resend. */
export function readDocument(file) {
  try {
    if (!file || !existsSync(file)) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}

/** Is the file this row points at really still there, and still the size the row claims? */
export function documentOnDisk(doc) {
  try {
    if (!doc?.path || !existsSync(doc.path)) return { there: false, bytes: 0 };
    return { there: true, bytes: statSync(doc.path).size };
  } catch {
    return { there: false, bytes: 0 };
  }
}

/**
 * The owner-only link to a document.
 *
 * Only ever used when the channel cannot carry a file: a document is meant to arrive as an
 * attachment in the thread, and a link is the honest fallback rather than the normal way. It
 * carries a key for the same reason a page's owner link does — the id alone must not open it.
 */
export function documentUrl(doc) {
  const base = (config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
  return `${base}/f/${doc.id}?k=${doc.owner_key}`;
}
