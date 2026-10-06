// Real PDFs, built here, so the reader is really exercised.
//
// Everything else in this repo's Google tests is answered by a fake. The PDF reader must not be: a
// stand-in that returns "Omari Nyarko" when asked proves the plumbing and proves nothing about whether
// macOS PDFKit can get words out of a document. So these are PDFs — a correct xref table, a real
// content stream, and for the locked one the actual RC4 standard security handler — and the tests put
// them through `/usr/bin/osascript` for real.
//
// Written from the PDF 1.7 specification's own structure (ISO 32000-1): a header, numbered objects,
// a cross-reference table of their byte offsets, and a trailer naming the catalogue and pointing at
// the table. The security handler is §7.6.3: Algorithm 2 for the file key, Algorithm 3 for /O,
// Algorithm 4 for /U at revision 2, and each string or stream encrypted under a key derived from the
// file key plus the object and generation numbers.
//
// Kept deliberately small. Four shapes, one per thing a reader has to be honest about:
//
//   textPdf      words in it, which is the ordinary case and nearly every resume
//   pagesPdf     more pages than the page budget, so "the first N of M pages" can be checked
//   scanPdf      a page with a drawn rectangle and no text at all — what a scan really is
//   lockedPdf    a real user password, so "it's password-protected" is a measurement
import { createHash } from "node:crypto";

/** A PDF out of its numbered objects: offsets counted, xref written, trailer pointed at it. */
function assemble(objects, trailerExtra = "") {
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xrefAt = at;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

const stream = (body, extra = "") => Buffer.concat([
  Buffer.from(`<< /Length ${body.length }${extra} >>\nstream\n`, "latin1"),
  Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"),
  Buffer.from("\nendstream", "latin1"),
]);

/** A PDF string literal: the three characters that would otherwise end it early. */
const pdfStr = (s) => String(s).replace(/([\\()])/g, "\\$1");

/** One page's content stream: the lines, down the page, in Helvetica. */
function pageContent(lines) {
  const drawn = lines.map((l, i) => `${i === 0 ? "" : "0 -16 Td "}(${pdfStr(l)}) Tj `).join("");
  return `BT /F1 12 Tf 72 720 Td ${drawn}ET`;
}

/**
 * A real one-page PDF with these lines of text in it.
 *
 * The default is Omari's own case from 2026-10-06 — the resume that got "it's a PDF, though, and I
 * can't open PDFs" — so the test that proves this works reads the document that proved it did not.
 */
export function textPdf(lines = [
  "Omari Nyarko",
  "Software engineering internship resume - October 2025",
  "Built Reason, a personal assistant you text. Node, no framework.",
  "Shipped a group-planning assistant used by real people.",
]) {
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(pageContent(lines)),
  ]);
}

/** A real PDF of `count` pages, each one saying which page it is, so a page budget is checkable. */
export function pagesPdf(count = 6) {
  const first = 4;                                        // objects 1-3 are the catalogue, pages node, font
  const kids = Array.from({ length: count }, (_, i) => `${first + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < count; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${first + i * 2 + 1} 0 R >>`);
    objects.push(stream(pageContent([`page ${i + 1} of ${count}`, `the word on page ${i + 1} is marker${i + 1}`])));
  }
  return assemble(objects);
}

/**
 * A real PDF with a page and no text on it: a grey rectangle and nothing else.
 *
 * This is what a scan is. Not a broken file, not an empty one — a picture of a document, with a page
 * count and no text layer, which is the one case no reader anywhere can help with.
 */
export function scanPdf() {
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    stream("0.6 g 72 72 468 648 re f"),
  ]);
}

// ---------- a genuinely encrypted PDF ----------

const PAD = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

/** RC4, which is what revision 2 of the standard security handler uses. */
function rc4(key, data) {
  const S = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xFF;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xFF;
    j = (j + S[i]) & 0xFF;
    [S[i], S[j]] = [S[j], S[i]];
    out[n] = data[n] ^ S[(S[i] + S[j]) & 0xFF];
  }
  return out;
}

const md5 = (...bufs) => createHash("md5").update(Buffer.concat(bufs)).digest();
const padPassword = (pw) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

/**
 * A real PDF that needs a password to open — 40-bit RC4, revision 2, the oldest and simplest of
 * Google's and Apple's supported handlers.
 *
 * Why go to the trouble: `isLocked` is the signal the reader refuses on, and a forged `/Encrypt`
 * entry that nothing resolves does NOT set it (tried, 2026-10-06 — PDFKit opened it and read the text
 * out). So the only way "password-protected is refused" is a fact rather than a hope is to encrypt a
 * document properly and watch it be refused.
 */
export function lockedPdf({ password = "letmein", lines = ["locked resume", "rent is $2,400"] } = {}) {
  const fileId = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
  const P = -1;                                           // every permission bit set
  const O = rc4(md5(padPassword(password)).subarray(0, 5), padPassword(password));
  const pbuf = Buffer.alloc(4);
  pbuf.writeInt32LE(P);
  const fileKey = md5(padPassword(password), O, pbuf, fileId).subarray(0, 5);
  const U = rc4(fileKey, PAD);
  // Algorithm 1: the file key plus the object's own number and generation, low bytes first.
  const objectKey = (num, gen = 0) => {
    const n = Buffer.alloc(4); n.writeInt32LE(num);
    const g = Buffer.alloc(4); g.writeInt32LE(gen);
    return md5(fileKey, n.subarray(0, 3), g.subarray(0, 2)).subarray(0, 10);
  };
  const content = Buffer.from(pageContent(lines), "latin1");
  const hex = (b) => b.toString("hex");
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(rc4(objectKey(5), content)),
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(O)}> /U <${hex(U)}> /P ${P} >>`,
  ], ` /Encrypt 6 0 R /ID [<${hex(fileId)}> <${hex(fileId)}>]`);
}
