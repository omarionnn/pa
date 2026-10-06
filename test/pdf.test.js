// The PDF reader itself, below the tools.
//
// test/drive.test.js and test/google.test.js cover what a person gets told — a resume read, a scan
// refused as a scan, a password named — through drive_read and gmail_attachment. What is left over is
// the reader's own edges, which no tool call can reach on purpose:
//
//   the reader TIMING OUT, for real, by giving it a deadline it cannot meet
//   the reader answering with something that is not the one line of JSON it promised
//   the temp files being gone afterwards, which is somebody's lease not left on a disk
//
// The timeout one is here rather than mocked because a hung osascript is the failure this most
// plausibly has in the wild — a 400-page document, a laptop under load — and "it comes back as a
// refusal rather than a stuck turn" is only worth believing if a real process was really killed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pdf-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;

const { findPdfReader, isPdfBytes, pdfRefusal, pdfNextStep, pdfText, runReader } = await import("../src/pdf.js");
const { textPdf, pagesPdf } = await import("./fixture-pdf.js");

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// A directory of its own for each run's temp files, so "nothing was left behind" is a count of an
// empty directory and not a search through everybody else's.
const tmpFor = (name) => {
  const d = join(dir, name);
  rmSync(d, { recursive: true, force: true });
  return d;
};

test("the words really come out of a real PDF, on this machine", async () => {
  const got = await pdfText({ bytes: textPdf(), tmpDir: tmpFor("ok") });
  assert.equal(got.ok, true, JSON.stringify(got).slice(0, 200));
  assert.match(got.text, /Omari Nyarko/);
  assert.equal(got.pages, 1);
  assert.equal(got.pages_read, 1);
});

test("the pages really are taken one at a time, so 'the first N of M' is a measurement", async () => {
  const got = await pdfText({ bytes: pagesPdf(6), maxPages: 2, tmpDir: tmpFor("pages") });
  assert.equal(got.ok, true);
  assert.equal(got.pages, 6);
  assert.equal(got.pages_read, 2);
  assert.match(got.text, /marker2/);
  assert.ok(!got.text.includes("marker3"), "page three was left, not read and thrown away");
});

test("a reader that cannot finish in time is a refusal, not a stuck turn", async () => {
  // One millisecond is less than starting osascript takes, so execFile's own timeout kills it. This is
  // a real process really signalled — the branch a hung reader on a huge document would take.
  const got = await pdfText({ bytes: pagesPdf(40), timeoutMs: 1, tmpDir: tmpFor("slow") });
  assert.equal(got.ok, false);
  assert.equal(got.why, "reader_failed");
  // And the sentence says the machine failed, claims nothing about the document, and does not pretend
  // to know whether there were words in it.
  const said = pdfRefusal(got, { what: "tenancy agreement.pdf" });
  assert.match(said, /tenancy agreement\.pdf could not be read/);
  assert.match(said, /pdf reader on this machine failed/);
  assert.match(said, /nothing in it was read/);
  assert.ok(!got.text, "and no half-read text came back to be answered from");
});

test("a reader that answers with something that is not its JSON is a failure, not a guess", async () => {
  const got = await pdfText({
    bytes: textPdf(), tmpDir: tmpFor("junk"),
    bin: "/usr/bin/true", run: async () => ({ ok: true, stdout: "execution error: -1743\n" }),
  });
  assert.equal(got.ok, false);
  assert.equal(got.why, "reader_failed");
  assert.match(got.error, /was not json/);
});

test("nothing is left on the disk afterwards — not the PDF, not the script", async () => {
  for (const [name, opts] of [["kept-ok", {}], ["kept-slow", { timeoutMs: 1 }]]) {
    const d = tmpFor(name);
    await pdfText({ bytes: textPdf(), tmpDir: d, ...opts });
    assert.ok(existsSync(d), `${name}: the directory was made`);
    // Somebody's lease left in a temp directory is somebody's lease left on a disk, and the cleanup
    // has to hold on the failing path as much as the passing one.
    assert.deepEqual(readdirSync(d), [], `${name}: and emptied again`);
  }
});

test("a size refusal costs nothing: a huge file is never written anywhere", async () => {
  const d = tmpFor("big");
  const got = await pdfText({ bytes: Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(4096)]), maxBytes: 1024, tmpDir: d });
  assert.equal(got.ok, false);
  assert.equal(got.why, "too_big");
  assert.equal(got.bytes, 4104);
  assert.equal(got.max_bytes, 1024);
  assert.ok(!existsSync(d), "the directory was never even made");
  assert.match(pdfRefusal(got, { what: "book.pdf" }), /book\.pdf is 0\.00 MB, and reason only reads a pdf up to/);
});

test("what a file claims to be is not what it is", () => {
  assert.equal(isPdfBytes(Buffer.from("%PDF-1.7\n...")), true);
  assert.equal(isPdfBytes(Buffer.from("<!doctype html><html>sign in")), false);
  assert.equal(isPdfBytes(Buffer.alloc(0)), false);
  assert.equal(isPdfBytes(null), false);
});

test("every refusal is its own sentence, and none of them invents a thing about the document", () => {
  const cases = [
    [{ why: "too_big", bytes: 40 * 1024 * 1024, max_bytes: 25 * 1024 * 1024 }, /is 40\.0 MB/],
    [{ why: "locked" }, /password-protected/],
    [{ why: "no_text", pages: 1 }, /its page has no text/],
    [{ why: "no_text", pages: 9 }, /its pages have no text/],
    [{ why: "no_reader" }, /no pdf reader on it/],
    [{ why: "not_a_pdf" }, /is not one/],
    [{ why: "reader_failed", error: "boom" }, /failed \(boom\)/],
  ];
  for (const [result, shape] of cases) {
    const said = pdfRefusal(result, { what: "statement.pdf" });
    assert.match(said, shape, result.why);
    assert.match(said, /statement\.pdf/, `${result.why} names the file`);
    assert.match(said, /nothing in it (was|could be) read|there is nothing in it/, `${result.why} claims nothing was read`);
  }
});

test("a screenshot is offered for a scan and for nothing else", () => {
  // A scan is the one case where "screenshot it and send it to me" is the right offer and always was:
  // the model reads a photo, and a person choosing to send one is not Reason uploading their file.
  assert.match(pdfNextStep({ why: "no_text" }), /screenshot the page they care about/);
  assert.match(pdfNextStep({ why: "no_text" }), /Do not offer that for any other kind of pdf/);
  // And the one place it would waste somebody's time: a password is not solved by a photo of a page
  // nobody can open.
  assert.ok(!/screenshot the page/.test(pdfNextStep({ why: "locked" })));
  assert.match(pdfNextStep({ why: "locked" }), /Do not ask them for the password/);
  assert.match(pdfNextStep({ why: "too_big" }), /Offer the link/);
  assert.match(pdfNextStep({ why: "reader_failed" }), /Do not guess at what is in it/);
});

test("on a machine with no reader, nothing here pretends there is one", async () => {
  const was = process.env.REASON_PDF_READER;
  process.env.REASON_PDF_READER = "none";
  try {
    assert.equal(findPdfReader(), null);
    const got = await pdfText({ bytes: textPdf(), tmpDir: tmpFor("none") });
    assert.equal(got.ok, false);
    assert.equal(got.why, "no_reader");
    // Checked before anything is written, so a Linux host does not accumulate temp files either.
    assert.ok(!existsSync(join(dir, "none")));
  } finally {
    if (was === undefined) delete process.env.REASON_PDF_READER; else process.env.REASON_PDF_READER = was;
  }
  // A path that is named and is not there is the same answer as none at all, rather than a crash
  // later on when something tries to run it.
  process.env.REASON_PDF_READER = join(dir, "no-such-binary");
  try {
    assert.equal(findPdfReader(), null);
  } finally {
    if (was === undefined) delete process.env.REASON_PDF_READER; else process.env.REASON_PDF_READER = was;
  }
});

test("with no reader to run, runReader says so instead of throwing", async () => {
  const got = await runReader(["-l", "JavaScript"], { bin: null });
  assert.equal(got.ok, false);
  assert.match(got.error, /no pdf reader on this machine/);
});
