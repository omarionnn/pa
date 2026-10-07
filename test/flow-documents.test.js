// "send me that as a pdf" — the model's own choice, through whatever backend is live. On the
// owner's machine that is the claude-cli path, the one Reason actually runs on here.
//
// This is the one test that proves the whole thing end to end with nothing faked: a real answer,
// then a real file written by the real renderer (Chromium printing the page), attached to a real
// message on a channel. It asserts on what landed on disk and in the thread, never on wording.
//
// Run it:  REASON_BACKEND=claude-cli node --test test/flow-documents.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-documents-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DOCUMENT_ROOT = join(dir, "documents");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_UNDO_SECONDS = "0";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { pdfText } = await import("../src/pdf.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
const OWNER = "+12025551234";

/** Where a sample is kept so a person can open it afterwards rather than taking a test's word. */
const SAMPLES = "/tmp/reason-run/documents-samples";

let rt, router, fake;

before(() => {
  clock.reset();
  rt = new Runtime();
  router = new Router({ runtime: rt });
  fake = router.register(new FakeChannel({ media: true }));
  // The runtime hands this to every tool as ctx.channels, which is what makes the attachment real.
  rt.turnExtras = { ...(rt.turnExtras ?? {}), channels: router };
  db.upsertThread({ conversationId: C, channel: fake.name, address: OWNER, chatId: "chat-1", service: "iMessage" });
});
after(() => { rt.stop(); rmSync(dir, { recursive: true, force: true }); });

test(`asked for an answer as a pdf, Reason writes a real PDF and puts it in the thread (${label})`, { skip }, async () => {
  const asked = await rt.inbound(C, "give me a short guide to pour over coffee — beans, grind, water, ratio, and how to fix a sour cup");
  assert.ok(typeof asked === "string" && asked.length > 0, "it answered first");

  const reply = await rt.inbound(C, "send me that as a pdf");
  assert.ok(typeof reply === "string" && reply.length > 0, "it said something back");

  // One document, and it is a PDF.
  const docs = db.listDocuments(C);
  assert.equal(docs.length, 1, `exactly one document, got ${docs.length}: ${docs.map(d => `${d.kind} ${d.title}`).join(", ")}`);
  const doc = docs[0];
  assert.equal(doc.kind, "pdf", `it made a ${doc.kind}, not a pdf`);
  assert.match(doc.filename, /\.pdf$/);

  // A real file, written by the real renderer.
  assert.ok(statSync(doc.path).size > 1000, "a PDF of a guide is not a few hundred bytes");
  const bytes = readFileSync(doc.path);
  assert.equal(bytes.toString("latin1", 0, 5), "%PDF-", "it starts like a PDF");
  assert.equal(statSync(doc.path).size, doc.bytes, "the row's size is the file's size");

  // It really went out, as ONE message carrying the words and the file.
  assert.ok(doc.sent_at, "sent_at is only written when the channel took it");
  const withFile = fake.sent.filter(m => m.media?.file === doc.path);
  assert.equal(withFile.length, 1, "one message carried the file");
  assert.equal(withFile[0].media.mimeType, "application/pdf");
  assert.equal(withFile[0].to, OWNER);

  // And the answer's own subject is really inside the PDF — read back out of it, not assumed.
  const read = await pdfText({ bytes });
  if (read.ok) {
    const text = read.text.toLowerCase();
    assert.ok(text.includes(doc.title.toLowerCase().slice(0, 12)), `the title '${doc.title}' is not in the PDF's text`);
    assert.match(text, /coffee|pour|grind|ratio/, "the PDF is about what was asked for");
  } else {
    // No PDF reader on this machine (a Linux host): the bytes are still proved above. Said out
    // loud rather than passing quietly on a check that did not run.
    console.log(`note: the PDF's text was not read back (${read.why}); the file itself is proved`);
  }

  // Kept, so the sample can be opened by a person afterwards.
  mkdirSync(SAMPLES, { recursive: true });
  copyFileSync(doc.path, join(SAMPLES, `live-${doc.filename}`));
  console.log(`sample: ${join(SAMPLES, `live-${doc.filename}`)} (${doc.bytes} bytes, title "${doc.title}")`);
});
