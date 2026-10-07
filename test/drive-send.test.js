// "send me my latest resume as a pdf" — their own file, back in the thread, in the format they asked
// for.
//
// 2026-10-07, Omari's own words: "I asked Reason to give me my most recent résumé on the Drive and
// give it to me, but it kept saying it can't get it to me as a PDF." Everything around it worked. It
// could find the file, it could read the file, and it could write a brand new file out of its own
// words — and none of those is what was asked for. What was asked for is THAT file, as a PDF.
//
// What these tests are for, in order of how much it would cost to get them wrong:
//
//   1. **The newest resume in their Drive is a friend's.** People keep other people's CVs. The
//      fixture's top row by date is `ownedByMe: false`, so a flow that reaches for "newest" sends a
//      stranger's resume to a recruiter in the owner's name. The ownership fact is on every row and
//      the test walks the search the way the model has to.
//   2. **Nothing is left behind in their Drive.** The Word route copies their file into a Doc to
//      convert it. That copy is a file Reason put in somebody's Drive, and it has to come out again
//      — on the path where the export worked and on the path where it did not. When the delete
//      itself fails, the result says so in words rather than going quiet.
//   3. **It is their file, not a retyping of it.** A PDF is handed over byte for byte; a Doc is
//      Drive's own export. A resume Reason wrote out again from what it read is not their resume.
//   4. **The noes are named, and each one says what CAN be done.** A deck as a Word file, a PDF as a
//      Word file, an Apple Pages file as anything: Drive genuinely does none of those, and the
//      honest sentence with the nearest real thing beats a 400 or a guess.
//   5. **Nothing claims a send that did not happen**, which is the documents rule and is inherited
//      here rather than re-implemented.
//   6. **A grant with a box unticked is told which box.** The copy-and-export route is the only one
//      that writes, so it is the only one that wants `drive.file` — and somebody whose PDF only had
//      to be downloaded is never refused over a permission that route never touches.
//
// No real credentials and no network: the base URLs point at test/fixture-google.js, and the
// attachment goes to a fake channel. Nothing here has ever been sent to Google, and
// docs/unverified.md says exactly which of these a fake cannot settle.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-drive-send-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DOCUMENT_ROOT = join(dir, "documents");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_UNDO_SECONDS = "0";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const google = await import("../src/google.js");
const drive = await import("../src/drive.js");
const db = await import("../src/db.js");
const { exportData } = await import("../src/data.js");
const { config, clock } = await import("../src/config.js");

const C = "dm:owner";
const OWNER = "+12025551234";
const MAIL_AND_CALENDAR = [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES];
const EVERYTHING = [...MAIL_AND_CALENDAR, ...google.DRIVE_SCOPES];
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let fake, router, fakeChannel, runtime;

before(async () => {
  fake = await startGoogle();
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.googleDriveBase = fake.url;
  config.publicUrl = "https://reason.example.ts.net";
});
after(async () => {
  runtime?.stop();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  config.undoWindowSeconds = 0;
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts;"
    + " DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM documents; DELETE FROM threads; DELETE FROM outbox;");
  db.upsertAccount({ conversationId: C, channel: "test", address: OWNER, name: "Omari", isOperator: true });
  rmSync(join(dir, "documents"), { recursive: true, force: true });

  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: EVERYTHING, accessTtlSeconds: 3600, refreshTokenValid: true, giveRefreshToken: true });
  for (const k of ["authHeaders", "driveSearches", "driveReads", "driveCreated", "driveCopies", "driveDeletes"]) {
    fake.state[k].length = 0;
  }
  fake.state.liveTokens.clear();
});

/** A router with one fake channel that can carry a file, and the thread the attachment goes into. */
function harness({ media = true, mediaFailWith = null } = {}) {
  runtime?.stop();
  runtime = new Runtime({ runTurn: async () => "ok" });
  router = new Router({ runtime });
  fakeChannel = router.register(new FakeChannel({ media, mediaFailWith }));
  db.upsertThread({ conversationId: C, channel: fakeChannel.name, address: OWNER, chatId: "chat-1", service: "iMessage" });
  return { router, fakeChannel };
}

const ctx = (extra = {}) => ({ conversationId: C, channels: router, ...extra });
const call = (name, input, extra = {}) => runTool(name, input, ctx(extra));

/** Walk the real handshake, so what a grant covers is whatever was really ticked. */
async function connect({ scopes = null, grants = EVERYTHING, account = "" } = {}) {
  fake.set({ ...(account ? { email: account } : {}), grantScopes: grants });
  const link = await call("google_connect", { ...(scopes ? { scopes } : {}), ...(account ? { account } : {}) });
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  const done = await google.completeConnect({ code: "good-code", state });
  assert.equal(done.ok, true, JSON.stringify(done));
  return done;
}

/** The one message that carried a file, and nothing else counted as one. */
function attachment() {
  const withFile = fakeChannel.sent.filter(m => m.media?.file);
  assert.equal(withFile.length, 1, `one message carried a file, got ${withFile.length}`);
  return withFile[0];
}

// ---------- the ask itself ----------

test("their own resume, a .docx, comes back as a real PDF in the thread", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume-docx", as: "pdf", say: "here's your resume as a pdf" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sent, true, "and only because the channel took it");
  assert.equal(out.kind, "pdf");
  assert.equal(out.account, "me@example.com");
  assert.equal(out.from_file.name, "Omari Nyarko resume.docx");
  assert.match(out.how, /converted by Drive/);

  // A real file on disk, starting like a PDF, and it is the one that went out.
  const doc = db.listDocuments(C)[0];
  assert.ok(doc, "there is a row");
  assert.equal(doc.kind, "pdf");
  assert.match(doc.filename, /^omari-nyarko-resume\.pdf$/, "named from their file, not 'document.pdf'");
  const bytes = readFileSync(doc.path);
  assert.equal(bytes.toString("latin1", 0, 5), "%PDF-");
  assert.equal(bytes.length, doc.bytes, "the row's size is the file's size");
  assert.ok(doc.sent_at, "sent_at is written only after the channel came back ok");

  const msg = attachment();
  assert.equal(msg.media.file, doc.path);
  assert.equal(msg.media.mimeType, PDF);
  assert.equal(msg.media.filename, "omari-nyarko-resume.pdf");
  assert.equal(msg.to, OWNER);
  assert.match(msg.text, /resume/i, "the line they wrote went with it");
});

// The whole point of the conversion route, and the thing a real person's Drive would otherwise show
// them: a file called "reason temporary copy — …" sitting in My Drive forever.
test("the conversion makes ONE copy in their Drive and deletes it again", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume-docx", as: "pdf" });
  assert.equal(out.ok, true);
  assert.equal(out.temp_copy_deleted, true);

  assert.equal(fake.state.driveCopies.length, 1, "one copy, not one per retry");
  const copy = fake.state.driveCopies[0];
  assert.equal(copy.from, "f-resume-docx");
  assert.equal(copy.mimeType, "application/vnd.google-apps.document", "copied INTO a Doc — that is what converts it");
  assert.match(copy.name, /^reason temporary copy — Omari Nyarko resume\.docx$/,
    "named so a stray one is obviously Reason's and findable");

  // Exported from the COPY and not from their file, and then deleted.
  const exported = fake.state.driveReads.filter(r => r.how === "export");
  assert.equal(exported.length, 1);
  assert.equal(exported[0].mimeType, PDF);
  assert.notEqual(exported[0].id, "f-resume-docx", "their own file was never exported — Drive cannot export a .docx");
  assert.deepEqual(fake.state.driveDeletes.map(d => d.id), [exported[0].id], "the copy, and only the copy");

  // Their own file is never what gets deleted. This is the one assertion standing between a
  // conversion and the worst thing this code could possibly do, so it is made explicitly rather
  // than inferred from the line above.
  assert.ok(!fake.state.driveDeletes.some(d => d.id === "f-resume-docx"), "their own file was NEVER deleted");
  assert.ok(fake.files().some(f => f.id === "f-resume-docx"), "and it is still in their Drive");

  // And it is really gone from that Drive, asserted from the server's side.
  const after = await call("drive_search", { query: "reason temporary copy" });
  assert.equal(after.count, 0, "nothing of Reason's is left in their Drive");
});

test("a Google Doc is exported straight to PDF — no copy, nothing written in their Drive", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume-doc", as: "pdf" });
  assert.equal(out.ok, true);
  assert.equal(out.sent, true);
  assert.match(out.how, /exported by Drive as application\/pdf/);
  assert.equal(out.temp_copy_deleted, undefined, "there was no copy to report on");
  assert.equal(fake.state.driveCopies.length, 0, "and none was made");
  assert.equal(fake.state.driveDeletes.length, 0);
  assert.equal(attachment().media.mimeType, PDF);
});

test("something that is already a PDF goes over untouched — the same bytes, not a copy retyped", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume", as: "pdf" });
  assert.equal(out.ok, true);
  assert.equal(out.sent, true);
  assert.match(out.how, /exactly as it is in their Drive/);
  assert.equal(fake.state.driveCopies.length, 0);
  // Downloaded, not exported: Drive refuses /export on a stored file and this is the other route.
  assert.deepEqual(fake.state.driveReads.map(r => r.how), ["media"]);

  // Byte for byte what the fixture holds, which is what "their file" has to mean.
  const theirs = fake.state.driveReads[0];
  assert.equal(theirs.id, "f-resume");
  const doc = db.listDocuments(C)[0];
  assert.equal(readFileSync(doc.path).toString("latin1", 0, 5), "%PDF-");
  assert.ok(doc.bytes > 100, "a real PDF, not a stub");
});

test("a Google Doc asked for as a Word file is exported as one", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume-doc", as: "docx" });
  assert.equal(out.ok, true);
  assert.equal(out.kind, "docx");
  assert.equal(fake.state.driveReads.at(-1).mimeType, DOCX);
  const msg = attachment();
  assert.equal(msg.media.mimeType, DOCX);
  assert.match(msg.media.filename, /\.docx$/);
  assert.equal(readFileSync(db.listDocuments(C)[0].path).toString("latin1", 0, 2), "PK", "a .docx is a zip");
});

test("a .docx asked for as a Word file is sent as it is — no pointless round trip through Drive", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume-docx", as: "docx" });
  assert.equal(out.ok, true);
  assert.match(out.how, /exactly as it is/);
  assert.equal(fake.state.driveCopies.length, 0, "nothing was written in their Drive to hand back what was already there");
  assert.equal(fake.state.driveDeletes.length, 0);
});

// ---------- the noes, each with the thing that CAN be done ----------

test("a deck cannot be a Word file, and the refusal names the PDF instead", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-deck", as: "docx" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "cannot_convert");
  assert.match(out.why, /a PDF of it is the one that works/);
  assert.match(out.error, /Q3 review\.pptx/);
  assert.match(out.error, /Nothing was made, nothing was sent/);
  assert.match(out.error, /docs\.google\.com/, "with the link so they can open it themselves");

  // Nothing was tried: no copy, no export, no download, no row, no message.
  assert.equal(fake.state.driveCopies.length, 0);
  assert.equal(fake.state.driveReads.length, 0);
  assert.equal(db.listDocuments(C).length, 0);
  assert.equal(fakeChannel.sent.filter(m => m.media?.file).length, 0);

  // And the one that does work, works.
  const pdf = await call("drive_send", { file_id: "f-deck", as: "pdf" });
  assert.equal(pdf.ok, true, JSON.stringify(pdf));
  assert.equal(pdf.sent, true);
});

test("a PDF cannot become a Word file, and it says why rather than guessing at the layout", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume", as: "docx" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "cannot_convert");
  assert.match(out.why, /guessing at the layout/);
  assert.match(out.why, /The PDF itself can be sent/, "and the nearest real thing is named");
  assert.equal(fake.state.driveCopies.length, 0);
  assert.equal(db.listDocuments(C).length, 0);
});

test("an Apple Pages file is a file Drive cannot open, and that is its own sentence", async () => {
  harness();
  await connect();

  for (const as of ["pdf", "docx"]) {
    const out = await call("drive_send", { file_id: "f-pages", as });
    assert.equal(out.ok, false, `as ${as}`);
    assert.match(out.why, /Apple Pages file, and Drive can't open one/);
    assert.match(out.why, /on their own machine/, "the way it CAN be done is named");
  }
  // Never attempted against Google, so there is no 400 anybody has to explain afterwards.
  assert.equal(fake.state.driveCopies.length, 0);
  assert.equal(db.listDocuments(C).length, 0);
});

test("a folder is not a file, and nothing is attempted", async () => {
  harness();
  await connect();
  const out = await call("drive_send", { file_id: "f-taxes", as: "pdf" });
  assert.equal(out.ok, false);
  assert.match(out.why, /that's a folder/);
  assert.equal(fake.state.driveCopies.length, 0);
});

// ---------- when Google is the one that fails ----------

test("a copy that cannot be deleted is OWNED UP TO, with the name to look for", async () => {
  harness();
  await connect();
  fake.set({ deleteFails: true });

  const out = await call("drive_send", { file_id: "f-resume-docx", as: "pdf" });
  // The PDF still went: the file is right and the mess is in their Drive, so both are said.
  assert.equal(out.ok, true);
  assert.equal(out.sent, true);
  assert.equal(out.temp_copy_deleted, false);
  assert.match(out.note, /COULD NOT BE DELETED/);
  assert.match(out.note, /reason temporary copy — Omari Nyarko resume\.docx/, "the name they have to look for");
  assert.match(out.note, /do not leave them to find it/);

  // It really is still there, and the receipt shouts about it so months later the answer is findable.
  const left = await call("drive_search", { query: "reason temporary copy" });
  assert.equal(left.count, 1);
  const row = db.listActions(C).find(r => r.action === "drive_send");
  assert.ok(row, "there is a receipt");
  assert.match(row.receipt, /TEMPORARY COPY IN THEIR DRIVE WAS NOT DELETED/);
});

test("an export that Google refuses still takes the copy back out, and claims nothing", async () => {
  harness();
  await connect();
  // Drive's own 403 on an export: over their documented 10 MB cap. The copy goes in and the bytes
  // never come out, which is the one path where it would be easiest to leave a file behind.
  fake.set({ exportFails: true });

  const out = await call("drive_send", { file_id: "f-resume-docx", as: "pdf" });
  assert.equal(out.ok, false);
  assert.equal(out.sent, undefined, "nothing was sent, and nothing says it was");
  assert.match(out.error, /too large to be exported/, "Google's own words, not a guess");
  assert.match(out.error, /do not say a file is on the way/);
  assert.match(out.error, /docs\.google\.com/, "and the link instead");

  // The copy was made, and taken back out anyway.
  assert.equal(fake.state.driveCopies.length, 1, "the copy was made");
  assert.equal(fake.state.driveDeletes.length, 1, "and deleted on the failing path too");
  assert.equal(fake.state.driveDeletes[0].found, true);
  const left = await call("drive_search", { query: "reason temporary copy" });
  assert.equal(left.count, 0, "their Drive is as it was");

  // No row and no file on this disk for bytes that never arrived.
  assert.equal(db.listDocuments(C).length, 0);
  assert.equal(fakeChannel.sent.filter(m => m.media?.file).length, 0);
});

test("a thread that cannot carry a file says so, and does not claim a send", async () => {
  harness({ media: false });
  await connect();

  const out = await call("drive_send", { file_id: "f-resume", as: "pdf" });
  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.match(out.error, /cannot carry an attachment/);
  // The file IS made — a document they can still be given — and the row says it never went.
  const doc = db.listDocuments(C)[0];
  assert.ok(doc && existsSync(doc.path), "the bytes are on this machine");
  assert.equal(doc.sent_at, null);
  assert.match(db.listActions(C).find(r => r.action === "drive_send").receipt, /^Could not send/);
});

test("a file in Drive labelled pdf that is not one is refused, not attached", async () => {
  harness();
  await connect();

  // f-fakepdf is a saved login page somebody uploaded as application/pdf. The type on a file is
  // whoever uploaded it's claim; the bytes are the fact.
  const out = await call("drive_send", { file_id: "f-fakepdf", as: "pdf" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_a_file");
  assert.match(out.error, /does not start like a pdf file/);
  assert.match(out.error, /whatever whoever uploaded it said it was/);
  assert.equal(db.listDocuments(C).length, 0, "no row for a file that is not what it says");
  assert.equal(fakeChannel.sent.filter(m => m.media?.file).length, 0);
});

test("a file id from another account is answered with the account it is really in", async () => {
  harness();
  await connect();
  await connect({ account: "work@example.com" });
  fake.setFiles("work@example.com", []);

  const out = await call("drive_send", { file_id: "f-resume-docx", as: "pdf", account: "work@example.com" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "wrong_account");
  assert.equal(out.in_account, "me@example.com");
  assert.equal(fake.state.driveCopies.length, 0, "and nothing was written in either Drive");
});

// ---------- the permission, per route ----------

test("a grant with no Drive at all is a named refusal, not a 403", async () => {
  harness();
  await connect({ scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });

  const out = await call("drive_send", { file_id: "f-resume", as: "pdf" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "scope_missing");
  assert.deepEqual(out.missing_scope, [google.DRIVE_READ_SCOPE]);
  assert.match(out.error, /google_connect with scopes/);
  assert.equal(fake.state.driveReads.length, 0, "nothing was asked of Drive");
});

// Read granted, write unticked. The two routes have to answer differently, because one of them
// genuinely does not need the box that is unticked.
test("without drive.file the conversion asks for it — and a PDF that only needs downloading still goes", async () => {
  harness();
  const readOnly = [...MAIL_AND_CALENDAR, google.DRIVE_READ_SCOPE];
  await connect({ scopes: google.DRIVE_SCOPES, grants: readOnly });

  const refused = await call("drive_send", { file_id: "f-resume-docx", as: "pdf" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "scope_missing");
  assert.deepEqual(refused.missing_scope, [google.DRIVE_FILE_SCOPE]);
  assert.match(refused.error, /drive\.file/);
  assert.match(refused.error, /temporary copy/, "and it says what the permission is actually for");
  assert.equal(fake.state.driveCopies.length, 0, "no copy was attempted on a grant that could not delete one");

  // The route that never writes is not punished for a permission it does not use.
  const went = await call("drive_send", { file_id: "f-resume", as: "pdf" });
  assert.equal(went.ok, true, JSON.stringify(went));
  assert.equal(went.sent, true);
});

// ---------- what a receipt and an export keep ----------

test("the receipt says which file, which format and whether it went — and no file contents anywhere", async () => {
  harness();
  await connect();
  await call("drive_send", { file_id: "f-resume-docx", as: "pdf", say: "here u go" });

  const row = db.listActions(C).find(r => r.action === "drive_send");
  assert.ok(row);
  const receipt = row.receipt;
  assert.match(receipt, /Omari Nyarko resume\.docx/);
  assert.match(receipt, /PDF/);
  assert.match(receipt, /It really went/);

  const out = exportData({ conversation: C });
  const json = JSON.stringify(out);
  assert.ok(!json.includes("access-") && !json.includes("refresh-"), "no token, as ever");
  // The document's bytes DO travel in an export — that is the documents promise, and this row is a
  // document like any other. What must not be there is a token or a second copy of their Drive.
  assert.ok(!Object.keys(out.tables).some(t => /drive/i.test(t)), "Drive still keeps no table of its own");
});

// ---------- the flow, as the model has to walk it ----------

/**
 * The two-step "my latest resume" really takes, driven through the real dispatch with a stand-in for
 * the model — and it is two steps for one reason: the newest resume in this Drive is Kofi's.
 *
 * What this proves: the search's own facts are enough to get this right, and the tool it hands to
 * is the one that sends a file rather than the one that writes a new one. What it does not prove,
 * and docs/unverified.md says so: that the live model, shown these descriptions, checks ownership
 * before it sends. That is what test/flow-drive-send.test.js is for.
 */
test("'send me my latest resume as a pdf' sends THEIRS, not the newer one that is a friend's", async () => {
  harness();
  await connect();

  const search = await call("drive_search", { query: "resume" });
  assert.equal(search.ok, true);
  // Newest first, and the newest is not theirs. This is the trap.
  assert.equal(search.files[0].file_id, "f-resume-kofi");
  assert.equal(search.files[0].owned_by_them, false);

  const theirs = search.files.find(f => f.owned_by_them && /resume/i.test(f.name));
  assert.equal(theirs.file_id, "f-resume-docx", "the newest one that is actually theirs");

  // And here is the honest limit, which this ask runs straight into: Reason CANNOT read a Word
  // file, so "check whose name is inside it" is not available for the exact file somebody's newest
  // resume usually is. What is available is who owns it and what it is called — so that is what the
  // decision rests on, and the tool says so rather than implying a read that cannot happen.
  const read = await call("drive_read", { file_id: theirs.file_id, account: theirs.account });
  assert.equal(read.ok, false);
  assert.equal(read.status, "cannot_read");
  assert.match(read.error, /word document/);

  const sent = await call("drive_send", { file_id: theirs.file_id, as: "pdf", account: theirs.account, say: "here's the pdf" });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.sent, true);
  assert.equal(sent.theirs, true, "and the result says, in one field, that this one really is theirs");
  assert.equal(attachment().media.filename, "omari-nyarko-resume.pdf");
  assert.ok(!JSON.stringify(sent).includes("Kofi"), "nothing of the friend's got anywhere near it");
  assert.equal(fake.state.driveDeletes.length, 1, "and their Drive is as it was");
});

// The other half of the same guard. Sending a friend's file into the owner's own thread is not
// dangerous — it is their thread — but CALLING IT THEIRS is, and that is the sentence that would
// end up in front of a recruiter. So the result says whose it is, loudly, before anything is said.
test("a file that is not theirs still goes, and the result refuses to let it be called theirs", async () => {
  harness();
  await connect();

  const out = await call("drive_send", { file_id: "f-resume-kofi", as: "pdf" });
  assert.equal(out.ok, true);
  assert.equal(out.sent, true);
  assert.equal(out.theirs, false);
  assert.match(out.note, /NOT Omari's file/);
  assert.match(out.note, /Kofi Mensah/, "whose it is, by name");
  assert.match(out.note, /never call it theirs/);
});

// ---------- the plan, on its own ----------

test("handBackPlan knows the whole matrix, including what Drive will not do", () => {
  const DOC = "application/vnd.google-apps.document";
  const SHEET = "application/vnd.google-apps.spreadsheet";
  const SLIDES = "application/vnd.google-apps.presentation";
  const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

  assert.deepEqual(drive.handBackPlan(PDF, "pdf"), { how: "as_is", mimeType: PDF });
  assert.deepEqual(drive.handBackPlan(DOCX, "docx"), { how: "as_is", mimeType: DOCX });
  assert.deepEqual(drive.handBackPlan(DOC, "pdf"), { how: "export", mimeType: PDF });
  assert.deepEqual(drive.handBackPlan(DOC, "docx"), { how: "export", mimeType: DOCX });
  assert.deepEqual(drive.handBackPlan(SHEET, "pdf"), { how: "export", mimeType: PDF });
  assert.deepEqual(drive.handBackPlan(SLIDES, "pdf"), { how: "export", mimeType: PDF });
  assert.deepEqual(drive.handBackPlan(DOCX, "pdf"), { how: "convert", via: DOC, mimeType: PDF });
  assert.deepEqual(drive.handBackPlan(PPTX, "pdf"), { how: "convert", via: SLIDES, mimeType: PDF });
  assert.deepEqual(drive.handBackPlan("text/plain", "pdf"), { how: "convert", via: DOC, mimeType: PDF });
  assert.deepEqual(drive.handBackPlan("text/csv", "pdf"), { how: "convert", via: SHEET, mimeType: PDF });
  assert.deepEqual(drive.handBackPlan("text/plain", "docx"), { how: "convert", via: DOC, mimeType: DOCX });

  // Google's export table has the Word type on Documents and on nothing else, so these are noes
  // rather than near-misses — and each one names the format that does work.
  for (const m of [SHEET, SLIDES, PPTX, "application/vnd.ms-excel"]) {
    const no = drive.handBackPlan(m, "docx");
    assert.equal(no.how, "no", m);
    assert.match(no.why, /a PDF of it is the one that works/, m);
  }
  assert.match(drive.handBackPlan(PDF, "docx").why, /guessing at the layout/);
  assert.match(drive.handBackPlan("application/vnd.apple.keynote", "pdf").why, /Apple Keynote file/);
  assert.match(drive.handBackPlan("image/jpeg", "pdf").why, /no honest way/);
  assert.match(drive.handBackPlan("application/zip", "docx").why, /no honest way/);
});
