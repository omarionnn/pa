// Reading the text out of a PDF, on this machine, with nothing leaving it.
//
// WHY THIS IS NOT A MODEL CALL, which is the whole design decision and is not a preference.
//
// Gemini reads a PDF natively — inline `application/pdf` data, up to 50 MB or 1,000 pages, each page
// counted as 258 tokens (ai.google.dev/gemini-api/docs/document-processing, read 2026-10-06) — and
// Reason already has a GEMINI_API_KEY and already sends it audio and video through src/gemini.js. It
// is the obvious reach, it would also read a scan, and it is the wrong answer here. The key is on the
// free tier, and Google's own API terms (ai.google.dev/gemini-api/terms, read 2026-10-06) say of the
// unpaid services that content is used to "provide, improve, and develop Google products and services
// and machine learning technologies", and that "human reviewers may read, annotate, and process your
// API input and output". The two sentences that would have to be deleted from the privacy page to send
// a PDF there are:
//
//   "never used to train or improve any model"  — src/pages/site.js, Your Google data in particular
//   the whole Limited Use section, which is also what the Google verification case rests on
//
// A person's lease, a statement or an offer letter going somewhere a human reviewer may read it, to
// improve somebody's model, is not a thing to put behind a paragraph of explanation. So: the text
// comes out on this machine, and a PDF that has no text to come out gets told so.
//
// WHY A SYSTEM TOOL AND NOT A DEPENDENCY. The pure-JS option is real — pdfjs-dist, or unpdf which
// wraps it — and it would work on Linux, which this does not. It is also a large install with a
// worker/WASM story, against a repo that has three dependencies and no build step, for a path that is
// not how this install runs. macOS ships PDFKit inside Quartz, reachable from
// `osascript -l JavaScript` through the Objective-C bridge, and that is the same bargain `sips` is in
// src/pictures.js and `afconvert` is in src/expressive.js: already there, nothing to install, no
// password, nothing on the network.
//
// RUN ON THIS MACHINE, 2026-10-06, not taken from memory. A hand-built one-page text PDF, a PDF
// printed through cupsfilter with embedded subset fonts, a vector PDF from the OSAKit framework with
// no text layer at all, a real RC4-encrypted PDF with a user password, and a plain text file renamed:
//
//   text PDF                → pages 1, the lines back in order
//   printed PDF             → the sentence back, fonts and all
//   no text layer           → pages 1, zero characters   → the honest "nothing could read this"
//   user-password encrypted → isLocked true              → the honest "it's password-protected"
//   not a PDF               → PDFDocument is null        → the honest "that is not a readable PDF"
//
// It is FEATURE-DETECTED, not assumed. On a machine without it — any Linux host — nothing here
// pretends: `findPdfReader()` returns null and the caller keeps an honest refusal that names the
// reason. docs/unverified.md says which of these a fake cannot settle.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, clock } from "./config.js";

/** macOS's own script runner, on every Mac. Quartz — and so PDFKit — is reachable from it. */
export const OSASCRIPT_PATH = "/usr/bin/osascript";

/**
 * The PDF reader on this machine, or null.
 *
 * REASON_PDF_READER names another path, or "none" to behave exactly like a machine without one —
 * which is how the Linux refusal is tested on a Mac.
 */
export function findPdfReader() {
  const named = process.env.REASON_PDF_READER;
  if (named === "none") return null;
  if (named) return existsSync(named) ? named : null;
  return process.platform === "darwin" && existsSync(OSASCRIPT_PATH) ? OSASCRIPT_PATH : null;
}

/**
 * The JXA that does the reading. One line of JSON back on stdout and nothing else, so the parse is
 * not a guess about what osascript printed.
 *
 * Page by page rather than `doc.string` in one go, because a page budget has to be a true statement:
 * "the first 4 of 31 pages" is something a person can act on, and it is only sayable if the pages
 * really were taken one at a time and the rest really were left.
 *
 * `isLocked` is the signal for a password, not `isEncrypted` — checked against a real encrypted file
 * rather than reasoned about. A PDF with only an owner password reads as encrypted and opens fine, so
 * refusing on `isEncrypted` would refuse documents nothing was wrong with.
 */
export const READER_JXA = `ObjC.import('Quartz');
function run(argv) {
  var maxPages = parseInt(argv[1], 10) || 1;
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath($(argv[0])));
  if (!doc.js) return JSON.stringify({ ok: false, why: 'not_a_pdf' });
  if (doc.isLocked) return JSON.stringify({ ok: false, why: 'locked', pages: Number(doc.pageCount) });
  var pages = Number(doc.pageCount);
  var take = Math.min(pages, maxPages);
  var out = [];
  for (var i = 0; i < take; i++) {
    var page = doc.pageAtIndex(i);
    out.push(page.js ? (ObjC.unwrap(page.string) || '') : '');
  }
  return JSON.stringify({ ok: true, pages: pages, pages_read: take, text: out.join('\\n\\n') });
}`;

/** `osascript -l JavaScript reader.js file.pdf 40`. Run on this machine 2026-10-06. */
export const READER_ARGS = (script, file, maxPages) => ["-l", "JavaScript", script, file, String(maxPages)];

/** The first bytes of a PDF, which is the one thing about it that is not somebody's claim. */
export function isPdfBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  return b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-";
}

/** One osascript run. Injectable so every path here is testable with no binary and no PDF. */
export function runReader(args, { bin, timeoutMs = config.pdfReadTimeoutMs } = {}) {
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, error: "there is no pdf reader on this machine" });
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || "").split("\n").filter(Boolean).at(-1) ?? "the pdf reader failed" });
      resolve({ ok: true, stdout: String(stdout ?? "") });
    });
  });
}

/**
 * The words in a PDF, or the reason there are none to be had.
 *
 * `{ ok: true, text, pages, pages_read }`, or `{ ok: false, why }` where `why` is one of a short
 * closed list — `too_big`, `not_a_pdf`, `locked`, `no_text`, `no_reader`, `reader_failed` — so the
 * caller writes the sentence and this never invents one. Each of those is a different thing being
 * wrong and a person is owed the difference: "it's password-protected" and "it's a scan with no text
 * in it" are not the same news and neither is "this machine has no reader".
 *
 * The bytes go to a temp file because PDFKit takes a URL, and both files are removed whatever happens
 * — the text is what matters and somebody's lease left in a temp directory is somebody's lease left
 * on a disk.
 */
export async function pdfText({
  bytes, maxBytes = config.pdfMaxBytes, maxPages = config.pdfMaxPages,
  tmpDir = config.imageTmpRoot, bin = findPdfReader(), run = runReader,
  read = readFileSync, write = writeFileSync, timeoutMs = config.pdfReadTimeoutMs,
} = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  // Size first, because it is the one refusal that should cost nothing: a 200 MB file should not be
  // written to a disk to be told it is too big.
  if (buf.length > maxBytes) return { ok: false, why: "too_big", bytes: buf.length, max_bytes: maxBytes };
  if (!buf.length) return { ok: false, why: "not_a_pdf", bytes: 0 };
  // Checked rather than trusted: Drive and Gmail both hand over a mime type somebody else set, and a
  // login page saved as "statement.pdf" would otherwise be handed to the reader as a document.
  if (!isPdfBytes(buf)) return { ok: false, why: "not_a_pdf", bytes: buf.length };
  if (!bin) return { ok: false, why: "no_reader" };

  mkdirSync(tmpDir, { recursive: true });
  const stem = join(tmpDir, `pdf-${clock.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const src = `${stem}.pdf`;
  const script = `${stem}.js`;
  try {
    write(src, buf);
    write(script, READER_JXA);
    const r = await run(READER_ARGS(script, src, Math.max(1, Number(maxPages) || 1)), { bin, timeoutMs });
    if (!r.ok) return { ok: false, why: "reader_failed", error: r.error };
    let said;
    try { said = JSON.parse(String(r.stdout ?? "").trim()); } catch { said = null; }
    if (!said) return { ok: false, why: "reader_failed", error: "the pdf reader answered with something that was not json" };
    if (!said.ok) return { ok: false, why: said.why === "locked" ? "locked" : "not_a_pdf", ...(said.pages ? { pages: Number(said.pages) } : {}) };

    const text = String(said.text ?? "");
    const pages = Number(said.pages) || 0;
    const pagesRead = Number(said.pages_read) || 0;
    // Opened, pages counted, and nothing in them. That is a scan — a picture of a document, with no
    // text layer — and there is no reader anywhere that would get words out of it. Said as what it is
    // rather than as a failure, because the person's next move is different.
    if (!text.trim()) return { ok: false, why: "no_text", pages, pages_read: pagesRead };
    return { ok: true, text, pages, pages_read: pagesRead };
  } finally {
    rmSync(src, { force: true });
    rmSync(script, { force: true });
    // read is only here so a test can stand in for the filesystem; nothing in this path needs it.
    void read;
  }
}

/**
 * The sentence a person gets told, for each reason there is no text.
 *
 * One place, because a PDF in Drive and a PDF attached to an email are the same news and saying it
 * two ways would make one of them wrong eventually. `what` names the thing — "scan 47.pdf" — and the
 * wording never claims anything was read.
 */
export function pdfRefusal(result, { what = "that pdf" } = {}) {
  const mb = (n) => `${(Number(n) / (1024 * 1024)).toFixed(n >= 1024 * 1024 ? 1 : 2)} MB`;
  switch (result?.why) {
    case "too_big":
      return `${what} is ${mb(result.bytes)}, and reason only reads a pdf up to ${mb(result.max_bytes)} — nothing in it was read`;
    case "locked":
      return `${what} is password-protected, so nothing in it could be read — reason has no password for it and will not ask you for one`;
    case "no_text":
      return `${what} is a scan — ${result.pages === 1 ? "its page has" : "its pages have"} no text in them at all, only a picture of one, so there is nothing in it any reader could pull out`;
    case "no_reader":
      return `${what} is a pdf, and the machine reason runs on has no pdf reader on it, so nothing in it was read`;
    case "not_a_pdf":
      return `${what} did not come back as a readable pdf — whatever was downloaded is not one, so nothing in it was read`;
    default:
      return `${what} could not be read: the pdf reader on this machine failed${result?.error ? ` (${result.error})` : ""}, so nothing in it was read`;
  }
}

/**
 * What to offer next, which is not the same for every refusal.
 *
 * A scan is the one case where "screenshot it and send it to me" is the right offer and always was:
 * the model already reads a photo, and a person choosing to send one is a different thing from Reason
 * deciding to upload their file. For a password, a size or a missing reader a screenshot is no use,
 * and offering one would be a sentence that wastes somebody's time.
 */
export function pdfNextStep(result) {
  switch (result?.why) {
    case "no_text":
      return "Offer the one thing that would work: they can screenshot the page they care about and send it, because you can read a photo. Do not offer that for any other kind of pdf.";
    case "locked":
      return "Do not ask them for the password — there is nowhere to put it. Offer the link so they can open it themselves, and offer to read anything they paste or screenshot out of it.";
    case "too_big":
      return "Offer the link, and offer to read a particular part if they can send that part on its own.";
    case "no_reader":
      return "Say it is the machine and not the file, offer the link, and say a screenshot of the part they care about would work.";
    default:
      return "Offer the link so they can open it themselves. Do not guess at what is in it.";
  }
}
