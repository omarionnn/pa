// "send me my latest resume as a pdf" — the real model, from the sentence to the attachment.
//
// This is the sentence that started it. 2026-10-07, Omari: "I asked Reason to give me my most
// recent résumé on the Drive and give it to me, but it kept saying it can't get it to me as a PDF."
//
// `test/drive-send.test.js` proves the tools: every route, every refusal, the copy that has to come
// back out. It drives them directly, so the three things it cannot prove are the three things that
// actually went wrong in his thread, and all three are the model's judgement rather than the code's:
//
//   1. **It reaches for the file, not for a new one.** `document_create` would produce a real PDF
//      with a real resume-shaped thing in it, written out of the model's own words, and it would
//      look like success. A resume Reason typed again is not his resume. The pass is a document
//      whose bytes came out of Drive and a ledger with no `document_create` row in it at all.
//   2. **"Latest mine" is not "newest".** The newest resume in this Drive belongs to Kofi Mensah.
//      A model that took the top row sends a friend's CV to a recruiter in Omari's name.
//   3. **Nothing is left in his Drive.** The Word route converts by copying his file into a Doc.
//      That copy is a file Reason put in a real person's Drive, and the assertion is the fake's own
//      file list afterwards, not a claim in a result.
//
// One test, one turn: it runs on Omari's Claude subscription and the turn is his money. No real
// Google — the same fake the rest of the Google suite uses — and no real phone; the attachment goes
// to a fake channel that reports what it was handed. Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-drive-send.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-drive-send-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DOCUMENT_ROOT = join(dir, "documents");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_UNDO_SECONDS = "0";

const { startGoogle } = await import("./fixture-google.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { readPlain } = await import("../src/restfiles.js"); // a file sealed with REASON_ENCRYPT_REST2=on reads plain
const google = await import("../src/google.js");
const { config, clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
const OWNER = "+12025551234";
let fake, rt, router, channel;

before(async () => {
  fake = await startGoogle();
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.googleDriveBase = fake.url;
  config.publicUrl = "";

  clock.reset();
  db.upsertAccount({ conversationId: C, channel: "test", address: OWNER, name: "Omari", isOperator: true });
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES, ...google.DRIVE_SCOPES] });
});

after(async () => {
  rt?.stop();
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Google connected through its real handshake, so the tokens are ones this flow produced. */
async function connectGoogle() {
  const link = await runTool("google_connect", { scopes: google.DRIVE_SCOPES }, { conversationId: C, messages: [] });
  const state = new URL(link.url).searchParams.get("state");
  const done = await google.completeConnect({ code: "good-code", state });
  assert.equal(done.ok, true, JSON.stringify(done));
}

test(`"send me my latest resume as a pdf" ends as his own file, as a PDF, in the thread (${label})`, { skip }, async () => {
  await connectGoogle();

  rt = new Runtime({ log: () => {} });
  router = new Router({ runtime: rt });
  channel = router.register(new FakeChannel({ media: true }));
  rt.turnExtras = { ...(rt.turnExtras ?? {}), channels: router };
  db.upsertThread({ conversationId: C, channel: channel.name, address: OWNER, chatId: "chat-1", service: "iMessage" });

  const reply = String(await rt.inbound(C, "can you send me my latest resume as a pdf"));
  assert.ok(reply.length > 0, "it said something back");

  // 1. One document, and it is a PDF. Not a page, not a link, not an apology.
  const docs = db.listDocuments(C);
  assert.equal(docs.length, 1, `exactly one document, got ${docs.length}: ${docs.map(d => `${d.kind} ${d.title}`).join(", ")}. it said: ${reply}`);
  const doc = docs[0];
  assert.equal(doc.kind, "pdf", `it made a ${doc.kind}, not a pdf. it said: ${reply}`);
  assert.match(doc.filename, /\.pdf$/);
  const bytes = readPlain(doc.path);
  assert.equal(bytes.toString("latin1", 0, 5), "%PDF-", "it starts like a PDF");
  assert.equal(statSync(doc.path).size, doc.bytes, "the row's size is the file's size");

  // 2. It came out of Drive, and it was never written from his own words instead.
  const ledger = db.listActions(C);
  assert.ok(!ledger.some(a => a.action === "document_create"),
    `it wrote a NEW document instead of handing back his file. it said: ${reply}`);
  const sendRow = ledger.find(a => a.action === "drive_send");
  assert.ok(sendRow, `it never called drive_send — it did something else. it said: ${reply}`);
  assert.equal(sendRow.outcome, "ok", `drive_send failed: ${sendRow.receipt}`);

  // 3. HIS resume, not the newer one that is Kofi's.
  const from = sendRow.result?.from_file?.name ?? "";
  assert.match(from, /Omari/i, `it sent "${from}", which is not his. it said: ${reply}`);
  assert.ok(!/Kofi/i.test(from), `it sent Kofi's resume. it said: ${reply}`);
  assert.equal(sendRow.result?.theirs, true, "and Drive agrees the file is his");

  // 4. It really went, as ONE message carrying the words and the file.
  assert.ok(doc.sent_at, `sent_at is only written when the channel took it. it said: ${reply}`);
  const withFile = channel.sent.filter(m => m.media?.file === doc.path);
  assert.equal(withFile.length, 1, "one message carried the file");
  assert.equal(withFile[0].media.mimeType, "application/pdf");
  assert.equal(withFile[0].to, OWNER);

  // 5. His Drive is as it was. If the conversion route ran, the copy went in and came out again;
  // either way there is nothing of Reason's left in there, asserted from the fake's own file list.
  const left = await runTool("drive_search", { query: "reason temporary copy" }, { conversationId: C, messages: [] });
  assert.equal(left.count, 0, "a temporary copy was left in his Drive");
  assert.equal(fake.state.driveDeletes.length, fake.state.driveCopies.length,
    `${fake.state.driveCopies.length} copies made and ${fake.state.driveDeletes.length} deleted`);
  assert.equal(fake.state.driveCreated.length, 0, "and nothing new was created in his Drive");

  console.log(`sent: ${doc.filename} (${doc.bytes} bytes) from "${from}" by ${sendRow.result?.how}`);
  console.log(`it said: ${reply}`);
});
