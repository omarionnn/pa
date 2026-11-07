// Organising their Drive, against a fake Google that answers the routes Google's v3 reference
// documents — including the scope split that is the whole shape of this feature.
//
// What these tests are for, in order of what it would cost to get them wrong:
//
//   1. **Nothing of theirs is uploaded.** drive_upload takes a path, which makes it the one tool in
//      Reason that a sentence in a message could try to point at somebody's private files. The rule
//      is code, not wording: only under REASON_DATA_DIR, resolved through realpath so a symlink
//      cannot walk out. A test that only checked the easy case would miss exactly that.
//   2. **A Drive connected before 2026-10-07 cannot move or rename anything, and SAYS so.** Omari's
//      own connection is one of those. The failure to avoid is not a crash — it is a vague error
//      that teaches him organising does not work, when it needs one tap.
//   3. **Binning and sharing stop for a yes, every time, pinned to the exact file and person.** And
//      then wait out the undo window, so one word takes them back.
//   4. **A batch is what it says it is.** Fifty is the ceiling and a refusal, not a silent
//      truncation; a move that fails STOPS; and the ledger has one row per file that really moved,
//      because "it half worked" is the thing nobody re-checks.
//   5. **A file of their own cannot be shared with a third party**, because the permission Reason
//      asks for is per-file — said as that, with the link offered, never as "Google refused it".
//   6. **A move really moves**: the old parent is removed, which only happens if the client read it
//      off Google first. A file in two folders looks exactly like nothing having happened.
//
// No real credentials, no network: the base URLs point at the fixture. Nothing here has ever been
// sent to Google. docs/unverified.md says what a fake cannot settle.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle, fakeFile } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-driveorg-"));
const outside = mkdtempSync(join(tmpdir(), "reason-notmine-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool, runReleasedAction } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const google = await import("../src/google.js");
const driveorg = await import("../src/driveorg.js");
const ownfiles = await import("../src/ownfiles.js");
const drive = await import("../src/drive.js");
const trust = await import("../src/trust.js");
const permissions = await import("../src/permissions.js");
const undo = await import("../src/undo.js");
const db = await import("../src/db.js");
const { exportData, deleteData } = await import("../src/data.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";
const MAIL_AND_CALENDAR = [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES];
/** What everybody who connected Drive before 2026-10-07 has: read and create, no organising. */
const READ_DRIVE = [...MAIL_AND_CALENDAR, ...google.DRIVE_SCOPES];
/** And what one more tap gets them. */
const ORGANISE = [...MAIL_AND_CALENDAR, ...google.DRIVE_ORGANISE_SCOPES];

let fake;
const call = (name, input, conversationId = OMARI, messages = []) => runTool(name, input, { conversationId, messages });
const owner = (text) => ({ role: "user", content: `[Wed, Oct 7 2026, 9:00 AM] Omari: ${text}` });
const readsYes = () => async () => ({ verdict: "yes" });

/** Their Drive: two receipts they made themselves, a folder, and a doc Reason wrote. */
const THEIR_FILES = () => [
  fakeFile({ id: "f-r1", name: "Receipt — plumber", mimeType: "application/pdf", modifiedTime: "2026-09-01T10:00:00.000Z", bytes: Buffer.from("%PDF-1.4 plumber"), parents: ["fol-root"] }),
  fakeFile({ id: "f-r2", name: "Receipt — dentist", mimeType: "application/pdf", modifiedTime: "2026-09-02T10:00:00.000Z", bytes: Buffer.from("%PDF-1.4 dentist"), parents: ["fol-root"] }),
  fakeFile({ id: "f-lease", name: "Scan 47", mimeType: DOC, modifiedTime: "2026-08-01T10:00:00.000Z", text: "RESIDENTIAL LEASE AGREEMENT", parents: ["fol-root"] }),
  fakeFile({ id: "fol-root", name: "Documents", mimeType: FOLDER, modifiedTime: "2026-07-01T10:00:00.000Z" }),
  fakeFile({ id: "fol-taxes", name: "Taxes 2026", mimeType: FOLDER, modifiedTime: "2026-09-20T10:00:00.000Z" }),
  // Reason's own: the only kind of file it can share with another person.
  fakeFile({ id: "f-mine", name: "Moving plan", mimeType: DOC, modifiedTime: "2026-10-06T10:00:00.000Z", text: "1. boxes", createdByApp: true }),
];

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
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM held_actions; DELETE FROM permissions; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: ORGANISE, accessTtlSeconds: 3600, refreshTokenValid: true, giveRefreshToken: true, files: THEIR_FILES() });
  for (const k of ["tokenCalls", "authHeaders", "driveSearches", "driveReads", "driveCreated", "driveFolders", "driveUpdates", "drivePermissions"]) {
    fake.state[k].length = 0;
  }
  fake.state.liveTokens.clear();
});

/** The real handshake. `grants` is what they really tick, which is a different thing from the ask. */
async function connect({ grants = ORGANISE, scopes = null } = {}) {
  fake.set({ grantScopes: grants });
  const link = await call("google_connect", scopes ? { scopes } : {});
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  const done = await google.completeConnect({ code: "good-code", state });
  assert.equal(done.ok, true, JSON.stringify(done));
  return done;
}

/** Ask, let Omari say yes to that sentence, and hand back the confirmation id. */
async function yesFor(action, { summary, target, stakes = "third_party" }) {
  const msgs = [owner("go on then")];
  const asked = await runTool("confirm_request", { action, summary, target, stakes }, { conversationId: OMARI, messages: msgs });
  assert.ok(asked.confirmation_id, JSON.stringify(asked));
  msgs.push({ role: "assistant", content: "asked" }, owner("yes do it"));
  const rec = await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: OMARI, messages: msgs, judge: readsYes() });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  return asked.confirmation_id;
}

const ledger = () => db.listActions(OMARI);

// ---------- the scope, which is the whole shape of this ----------

test("the three organising tools name drive.metadata and the three others do not", () => {
  for (const t of ["drive_rename", "drive_move", "drive_trash"]) {
    assert.deepEqual(google.TOOL_SCOPES[t], [google.DRIVE_METADATA_SCOPE], `${t} must cost exactly the one new scope`);
  }
  // These work on a Drive connected before 2026-10-07, which is the point of checking it: sending
  // somebody back through a consent screen for a folder they could already have had is a bug.
  assert.deepEqual(google.TOOL_SCOPES.drive_folders, [google.DRIVE_READ_SCOPE]);
  for (const t of ["drive_folder_create", "drive_upload", "drive_share"]) {
    assert.deepEqual(google.TOOL_SCOPES[t], [google.DRIVE_FILE_SCOPE], `${t} is inside the Drive permission they already gave`);
  }
  // And the broad scope is never asked for, which is what keeps sharing per-file.
  assert.ok(!google.SCOPE_LIST.includes("https://www.googleapis.com/auth/drive"), "the broad drive scope must never be askable");
});

test("a Drive connected before this was built is NOT reported as able to organise", async () => {
  await connect({ grants: READ_DRIVE, scopes: google.DRIVE_SCOPES });
  const st = trust.accountStatus(OMARI, "google_drive");
  assert.equal(st.status, "connected");
  assert.deepEqual(st.scopes, ["read_files", "write_files"], "organise_files must not appear on a grant that never had it");

  const caps = await call("capabilities", {});
  const row = caps.capabilities.find(c => c.name === "drive");
  assert.match(row.what, /NOT granted on this connection/);
  assert.match(row.what, /one tap/);
});

test("one more tap adds organising and does not cost them mail, calendar or Drive", async () => {
  await connect({ grants: READ_DRIVE, scopes: google.DRIVE_SCOPES });
  // The top-up link: asking for organising pulls the two Drive scopes with it, and
  // include_granted_scopes is what stops the new token being Drive-only.
  const link = await call("google_connect", { scopes: [google.DRIVE_METADATA_SCOPE] });
  const asked = new URL(link.url).searchParams.get("scope").split(" ");
  for (const s of google.DRIVE_ORGANISE_SCOPES) assert.ok(asked.includes(s), `${s} is not on the link`);
  assert.equal(new URL(link.url).searchParams.get("include_granted_scopes"), "true");

  await connect({ grants: ORGANISE, scopes: [google.DRIVE_METADATA_SCOPE] });
  const st = trust.accountStatus(OMARI, "google_drive");
  assert.ok(st.scopes.includes("organise_files"), `organising did not turn on: ${st.scopes}`);
  assert.equal(trust.accountStatus(OMARI, "gmail").status, "connected", "their mail was lost on the way");
  assert.equal(trust.accountStatus(OMARI, "google_calendar").status, "connected", "their calendar was lost on the way");

  const caps = await call("capabilities", {});
  assert.match(caps.capabilities.find(c => c.name === "drive").what, /Renaming \(drive_rename\) and moving \(drive_move\) are live/);
});

test("without it, renaming says reconnect — with the link and the exact scopes, never a vague error", async () => {
  await connect({ grants: READ_DRIVE, scopes: google.DRIVE_SCOPES });
  const out = await call("drive_rename", { file_id: "f-lease", name: "Lease — 240 Ocean Ave" });

  assert.equal(out.ok, false);
  assert.equal(out.status, "scope_missing");
  assert.equal(out.needs_reconnect_for_drive, true);
  assert.deepEqual(out.missing_scope, [google.DRIVE_METADATA_SCOPE]);
  assert.match(out.error, /one more permission/);
  assert.match(out.error, /one tap/);
  assert.match(out.error, /google_connect/);
  assert.match(out.error, /not something they did wrong/);
  assert.match(out.error, /drive\.metadata/);
  // And nothing was touched on the way to saying so.
  assert.equal(fake.state.driveUpdates.length, 0, "it tried the change anyway");
});

test("moving and binning say the same thing, and a folder still works on the old grant", async () => {
  await connect({ grants: READ_DRIVE, scopes: google.DRIVE_SCOPES });
  for (const [name, input] of [["drive_move", { file_ids: ["f-r1"], into: "fol-taxes" }], ["drive_trash", { file_id: "f-r1" }]]) {
    const out = await call(name, input);
    assert.equal(out.needs_reconnect_for_drive, true, `${name} did not offer the reconnect`);
  }
  assert.equal(fake.state.driveUpdates.length, 0);

  // But what they already paid for still works, so nobody is sent through a consent screen for it.
  const made = await call("drive_folder_create", { name: "Taxes 2026" });
  assert.equal(made.ok, true, JSON.stringify(made));
  const folders = await call("drive_folders", {});
  assert.equal(folders.ok, true);
  assert.ok(folders.folders.some(f => f.name === "Taxes 2026"));
});

// ---------- folders ----------

test("folders are listed with Google's own mimeType term, and the bin is left out", async () => {
  await connect();
  const out = await call("drive_folders", { query: "taxes" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.folders.map(f => f.name), ["Taxes 2026"]);
  assert.equal(out.folders[0].account, "me@example.com", "every folder says which Drive it is in");

  const q = fake.state.driveSearches.at(-1).q;
  assert.match(q, /mimeType = 'application\/vnd\.google-apps\.folder'/, "Google's own equality term for a folder");
  assert.match(q, /trashed = false/);
  assert.match(q, /name contains 'taxes'/);
});

test("what is already in a folder is answerable, which is what makes a proposal honest", async () => {
  await connect();
  await call("drive_move", { file_ids: ["f-r1"], into: "fol-taxes" });

  const out = await call("drive_folders", { inside: "fol-taxes" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.files.map(f => f.name), ["Receipt — plumber"]);
  assert.match(fake.state.driveSearches.at(-1).q, /'fol-taxes' in parents/, "Google's own collection operator");
  assert.match(out.note, /does NOT need moving/);
});

test("a folder is files.create with the folder mime type, and needs no yes", async () => {
  await connect();
  const out = await call("drive_folder_create", { name: "Taxes 2026", inside: "fol-root" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.folder.name, "Taxes 2026");

  const made = fake.state.driveFolders.at(-1);
  assert.equal(made.mimeType, FOLDER);
  assert.deepEqual(made.parents, ["fol-root"]);
  // No yes was collected for it, which matters: asking somebody to approve an empty folder is how
  // they learn that saying yes to Reason is free.
  assert.equal(db.listConfirmations?.(OMARI)?.length ?? 0, 0);
  const row = ledger().find(r => r.action === "drive_folder_create");
  assert.ok(row, "no receipt for a thing that appeared in their Drive");
  assert.match(row.receipt, /Made the folder "Taxes 2026"/);
});

// ---------- renaming ----------

test("a rename says both names, needs no yes, and sends only the name field", async () => {
  await connect();
  const out = await call("drive_rename", { file_id: "f-lease", name: "Lease — 240 Ocean Ave" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.was, "Scan 47");
  assert.equal(out.now, "Lease — 240 Ocean Ave");

  const patch = fake.state.driveUpdates.at(-1);
  // Google's own warning on files.update: only populate what you want to modify. A whole File
  // resource sent back would rewrite every field it carried.
  assert.deepEqual(Object.keys(patch.patch), ["name"]);
  assert.deepEqual(patch.addParents, []);
  assert.match(ledger().find(r => r.action === "drive_rename").receipt, /Renamed "Scan 47" to "Lease — 240 Ocean Ave"/);
});

test("a rename pointed at the wrong account is told which account has it", async () => {
  await connect();
  fake.addAccount("work@example.com", { grantScopes: ORGANISE, files: [fakeFile({ id: "w-1", name: "Office lease", mimeType: DOC, modifiedTime: "2026-10-01T00:00:00.000Z", owner: "work@example.com" })] });
  await connect({ grants: ORGANISE });
  fake.set({ email: "work@example.com", grantScopes: ORGANISE });
  await connect({ grants: ORGANISE });

  const out = await call("drive_rename", { file_id: "w-1", name: "Lease", account: "me@example.com" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "wrong_account");
  assert.equal(out.in_account, "work@example.com");
  assert.equal(fake.state.driveUpdates.length, 0, "nothing was renamed in either Drive");
});

// ---------- moving ----------

test("one move needs no yes, removes the old parent, and leaves one receipt", async () => {
  await connect();
  const out = await call("drive_move", { file_ids: ["f-r1"], into: "fol-taxes" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.moved, 1);
  assert.equal(out.into, "Taxes 2026");

  const patch = fake.state.driveUpdates.at(-1);
  assert.deepEqual(patch.addParents, ["fol-taxes"]);
  // The half a client forgets. Without it the file is in BOTH folders, which to a person looks
  // exactly like the move not having happened.
  assert.deepEqual(patch.removeParents, ["fol-root"], "the old parent was not removed");
  assert.deepEqual(fake.files().find(f => f.name === "Receipt — plumber").parents, ["fol-taxes"]);

  const rows = ledger().filter(r => r.action === "drive_move");
  assert.equal(rows.length, 1);
  assert.match(rows[0].receipt, /Moved "Receipt — plumber" into folder fol-taxes/);
  // One line with counts, never a list of ids, is what the model is told to say.
  assert.match(out.note, /ONE line with the counts/);
  assert.match(out.note, /never say a file id/);
});

test("more than one file needs a yes pinned to that exact set, and nothing moves without it", async () => {
  await connect();
  const refused = await call("drive_move", { file_ids: ["f-r1", "f-r2"], into: "fol-taxes" });
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked, "needs_confirmation");
  assert.equal(fake.state.driveUpdates.length, 0, "a batch moved with no yes at all");
  assert.ok(refused.use_target, "the refusal does not hand back the string the yes is checked against");

  // A yes for the two of them.
  const id = await yesFor("drive_move", { summary: "move 2 receipts into Taxes 2026", target: refused.use_target });
  const out = await call("drive_move", { file_ids: ["f-r1", "f-r2"], into: "fol-taxes", confirmation_id: id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.moved, 2);
  // One row per MOVE, not one per call: "what did you do to my drive" has to answer file by file.
  assert.equal(ledger().filter(r => r.action === "drive_move" && r.outcome === "ok").length, 2);
});

test("a yes for two files cannot be spent on a third", async () => {
  await connect();
  const target = driveorg.moveTarget({ file_ids: ["f-r1", "f-r2"], into: "fol-taxes", account: "me@example.com" });
  const id = await yesFor("drive_move", { summary: "move 2 receipts into Taxes 2026", target });

  const out = await call("drive_move", { file_ids: ["f-r1", "f-r2", "f-lease"], into: "fol-taxes", confirmation_id: id });
  assert.equal(out.ok, false, "a yes for two files moved three");
  assert.equal(fake.state.driveUpdates.length, 0);
});

test("over the batch cap it refuses outright rather than moving the first 50", async () => {
  await connect();
  const many = Array.from({ length: config.maxDriveBatch + 1 }, (_, i) => `f-x${i}`);
  const target = driveorg.moveTarget({ file_ids: many, into: "fol-taxes", account: "me@example.com" });
  const id = await yesFor("drive_move", { summary: `move ${many.length} files`, target });

  const out = await call("drive_move", { file_ids: many, into: "fol-taxes", confirmation_id: id });
  assert.equal(out.ok, false);
  assert.equal(out.status, "too_many");
  assert.match(out.error, new RegExp(`${config.maxDriveBatch} one yes may move`));
  assert.match(out.error, /NOTHING was moved/);
  assert.match(out.error, /in batches/);
  assert.equal(fake.state.driveUpdates.length, 0, "it moved some of them anyway");
  // Still a receipt, because "why didn't my drive get tidied" has to be answerable.
  assert.ok(ledger().some(r => r.action === "drive_move" && r.outcome === "error"));
});

test("a move that fails STOPS, says how many had moved, and is not rounded up to done", async () => {
  await connect();
  const files = ["f-r1", "f-gone", "f-r2"];
  const target = driveorg.moveTarget({ file_ids: files, into: "fol-taxes", account: "me@example.com" });
  const id = await yesFor("drive_move", { summary: "move 3 into Taxes 2026", target });

  const out = await call("drive_move", { file_ids: files, into: "fol-taxes", confirmation_id: id });
  assert.equal(out.status, "stopped");
  assert.equal(out.moved, 1, "it carried on past the failure");
  assert.equal(out.stopped_on.file_id, "f-gone");
  assert.match(out.error, /STOPPED after 1 of 3/);
  assert.match(out.error, /do not round it up to done/);
  // The third was never tried, which is the point of stopping.
  assert.deepEqual(fake.files().find(f => f.name === "Receipt — dentist").parents, ["fol-root"]);
  // Rows for exactly what happened: the one that moved, and the one that did not.
  const rows = ledger().filter(r => r.action === "drive_move");
  assert.equal(rows.filter(r => r.outcome === "ok").length, 1);
  assert.equal(rows.filter(r => r.outcome === "error").length, 1);
});

test("a file already in the folder is counted as already there, not moved again", async () => {
  await connect();
  await call("drive_move", { file_ids: ["f-r1"], into: "fol-taxes" });
  fake.state.driveUpdates.length = 0;

  const out = await call("drive_move", { file_ids: ["f-r1"], into: "fol-taxes" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.moved, 0);
  assert.equal(out.already_there, 1);
  assert.equal(fake.state.driveUpdates.length, 0, "it asked Google to move a file that was already there");
});

test("moving into something that is not a folder is refused before anything is touched", async () => {
  await connect();
  const out = await call("drive_move", { file_ids: ["f-r1"], into: "f-lease" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_a_folder");
  assert.match(out.error, /NOTHING was moved/);
  assert.equal(fake.state.driveUpdates.length, 0);
});

// ---------- binning ----------

test("binning always asks, and nothing is touched by the refusal", async () => {
  await connect();
  const out = await call("drive_trash", { file_id: "f-lease" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(fake.state.driveUpdates.length, 0);
  assert.ok(ledger().some(r => r.action === "drive_trash" && r.outcome === "blocked"));
});

test("with a yes it waits out the undo window first, with the file's NAME in the line", async () => {
  await connect();
  const target = driveorg.trashTarget({ file_ids: [], account: "me@example.com" });
  // The real target the tool computes, so the yes is the one it will check against.
  const real = driveorg.trashTarget({ file_id: "f-lease", account: "me@example.com" });
  assert.notEqual(target, real);
  const id = await yesFor("drive_trash", { summary: "bin Scan 47", target: real });

  const held = await call("drive_trash", { file_id: "f-lease", confirmation_id: id });
  assert.equal(held.undo_held, true, JSON.stringify(held));
  assert.match(held.say_exactly, /Scan 47/, "the line reads back an id instead of the name");
  assert.match(held.say_exactly, /drive bin/);
  assert.match(held.say_exactly, /just tell me if you want to stop it/);
  assert.equal(fake.state.driveUpdates.length, 0, "NOTHING may have happened while it is held");
  assert.equal(ledger().filter(r => r.action === "drive_trash" && r.outcome === "ok").length, 0, "a receipt for something that has not happened");

  // The window runs out and it really goes, with the receipt written then.
  const row = db.dueHolds(clock.now() + 60_000)[0];
  assert.ok(row, "nothing was parked");
  const done = await runReleasedAction(row);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(fake.files().find(f => f.id === "f-lease").trashed, true);
  assert.deepEqual(Object.keys(fake.state.driveUpdates.at(-1).patch), ["trashed"]);
  const receipt = ledger().find(r => r.action === "drive_trash" && r.outcome === "ok");
  assert.match(receipt.receipt, /Put "Scan 47" in the bin/);
  assert.match(receipt.receipt, /NOT deleted/);
  assert.match(done.note, /30 days/);
  assert.match(done.note, /never say gone forever/);
});

test("nothing anywhere can delete a file of THEIRS for good", async () => {
  // The guarantee is about THEIR files, and it is not a wording check. Everything of theirs goes to
  // Google's bin, which they can undo for 30 days; `files.delete` is never pointed at one.
  //
  // Exactly one source names a Drive DELETE, and it is not an exception to that promise — it is the
  // promise being kept. The PDF hand-back converts a .docx by copying it into a Doc, and that copy
  // is a file Reason put in somebody's Drive seconds earlier under `drive.file`. Leaving it there
  // would be litter in a real person's Drive. So the test is not "nobody deletes" but "the only
  // thing anybody deletes is a copy this code just made", which is checked two ways: one file names
  // the method, and in that file the call can only ever be handed the id that came back from
  // files.copy — never a file id from a person, a search or a tool argument.
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = readdirSync(new URL("../src/", import.meta.url)).filter(n => n.endsWith(".js"));

  const issue = [];
  for (const f of files) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    if (/"DELETE",\s*`?\$?\{?drive/i.test(src)) issue.push(f);
    // And nothing outside drive.js can reach it through the namespace import either, which is how a
    // future tool would get at it without naming the method.
    if (f !== "drive.js") {
      assert.doesNotMatch(src, /drive\.deleteFile/, `${f} reaches the Drive delete`);
    }
  }
  assert.deepEqual(issue, ["drive.js"], "a new source issues a Drive DELETE");

  const src = readFileSync(new URL("../src/drive.js", import.meta.url), "utf8");
  const args = [...src.matchAll(/await deleteFile\(\s*token\s*,\s*([A-Za-z0-9_]+)\s*\)/g)].map(m => m[1]);
  assert.deepEqual(args, ["copyId"], "deleteFile is only ever called on the copy it just made");

  assert.ok(!undo.HOLDS.drive_delete, "there is no permanent delete to hold");
});

// The behavioural half of that — the conversion deleting the copy and leaving the original where it
// was, asserted from the fake's own file list — is in test/drive-send.test.js, which has a .docx to
// convert and a channel to hand the result to.

// ---------- sharing ----------

test("a link for the owner reaches nobody, asks nothing, and changes nothing at Google", async () => {
  await connect();
  const out = await call("drive_share", { file_id: "f-lease" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, "link");
  assert.ok(out.link);
  assert.equal(fake.state.drivePermissions.length, 0, "nobody was given access");
  assert.match(out.note, /nobody was given access/i);
  const row = ledger().find(r => r.action === "drive_share");
  assert.match(row.receipt, /Nobody else was given access/);
});

test("sharing with a person asks first, waits out the window, and then really grants it", async () => {
  await connect();
  const refused = await call("drive_share", { file_id: "f-mine", with_email: "kofi@example.com" });
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked, "needs_confirmation");
  assert.equal(fake.state.drivePermissions.length, 0);

  const id = await yesFor("drive_share", { summary: "give kofi@example.com view access to Moving plan", target: refused.use_target });
  const held = await call("drive_share", { file_id: "f-mine", with_email: "kofi@example.com", confirmation_id: id });
  assert.equal(held.undo_held, true, JSON.stringify(held));
  assert.match(held.say_exactly, /kofi@example\.com/);
  assert.match(held.say_exactly, /Moving plan/);
  assert.equal(fake.state.drivePermissions.length, 0, "access was granted while it was still held");

  const row = db.dueHolds(clock.now() + 60_000)[0];
  const done = await runReleasedAction(row);
  assert.equal(done.ok, true, JSON.stringify(done));
  const perm = fake.state.drivePermissions.at(-1);
  assert.equal(perm.type, "user", "Reason must never share with type anyone");
  assert.equal(perm.emailAddress, "kofi@example.com");
  assert.equal(perm.role, "reader");
  assert.match(ledger().find(r => r.action === "drive_share" && r.outcome === "ok").receipt, /Gave kofi@example\.com reader access to "Moving plan"/);
});

test("a yes to share with one person cannot be spent on another", async () => {
  await connect();
  const target = driveorg.shareTarget({ file_id: "f-mine", with_email: "kofi@example.com", role: "reader", account: "me@example.com" });
  const id = await yesFor("drive_share", { summary: "share with kofi", target });

  const out = await call("drive_share", { file_id: "f-mine", with_email: "ama@example.com", confirmation_id: id });
  assert.equal(out.ok, false, "a yes for Kofi was spent on Ama");
  assert.equal(fake.state.drivePermissions.length, 0);
});

test("one of THEIR OWN files cannot be shared, and that is said as a permission, with the link", async () => {
  await connect();
  const target = driveorg.shareTarget({ file_id: "f-lease", with_email: "kofi@example.com", role: "reader", account: "me@example.com" });
  const id = await yesFor("drive_share", { summary: "share Scan 47 with kofi", target });

  // Released straight through so the window is not what is under test here.
  const held = await call("drive_share", { file_id: "f-lease", with_email: "kofi@example.com", confirmation_id: id });
  const out = held.undo_held ? await runReleasedAction(db.dueHolds(clock.now() + 60_000)[0]) : held;

  assert.equal(out.ok, false);
  assert.equal(out.status, "cannot_share_their_own_file");
  assert.match(out.error, /NOBODY was given access/);
  assert.match(out.error, /per-file/);
  assert.match(out.error, /do not retry/);
  assert.match(out.error, /do not offer to ask for more access/);
  assert.ok(out.link, "the nearest real thing is not offered");
  assert.equal(fake.state.drivePermissions.length, 0);
});

// ---------- uploading something Reason wrote ----------

test("a file Reason wrote goes up byte for byte, with no yes, and the bytes survive", async () => {
  await connect();
  // Real PDF bytes, including a byte sequence that is not valid UTF-8. A string round trip would
  // turn it into U+FFFD and Drive would store a file that is no longer a PDF.
  const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0xff, 0xfe, 0x00, 0x80]), Buffer.from("\n%%EOF")]);
  // Where Reason writes what it makes, during a tool call of theirs (src/ownfiles.js).
  mkdirSync(config.documentRoot, { recursive: true });
  const path = join(config.documentRoot, "offer-letter.pdf");
  const before = Date.now();
  writeFileSync(path, bytes);
  ownfiles.noteMade(OMARI, { ok: true, path }, before);

  const out = await call("drive_upload", { path, name: "Offer letter.pdf", mime_type: "application/pdf", into: "fol-taxes" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.file.name, "Offer letter.pdf");

  const up = fake.state.driveCreated.at(-1);
  assert.equal(up.uploadType, "multipart");
  assert.deepEqual(up.file.parents, ["fol-taxes"], "it did not land in the folder it was asked for");
  assert.deepEqual([...up.file.bytes], [...bytes], "the file arrived at Google corrupted");
  assert.match(ledger().find(r => r.action === "drive_upload").receipt, /Put "Offer letter\.pdf"/);
});

test("another person's call recording, or the shared database, is refused: inside the data directory is not theirs", async () => {
  await connect();
  // Somebody else's call, kept in the one recordings folder every call shares.
  db.upsertAccount({ conversationId: "dm:fake:+15550000002", channel: "fake", address: "+15550000002", name: "B" });
  const call7 = db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("dm:fake:+15550000002", "fake", "+15550000003", "x", Date.now(), Date.now()).lastInsertRowid;
  db.db.prepare("UPDATE calls SET recording_state = 'stored' WHERE id = ?").run(call7);
  mkdirSync(config.recordingRoot, { recursive: true });
  const rec = join(config.recordingRoot, `call-${call7}.mp3`);
  writeFileSync(rec, "ID3 their call");
  for (const path of [rec, config.dbPath]) {
    const out = await call("drive_upload", { path, name: "notes" });
    assert.equal(out.ok, false, `${path} was uploaded for somebody it is not theirs`);
    assert.match(out.error, /Nothing was uploaded/);
  }
  assert.equal(fake.state.driveCreated.length, 0, "another person's file reached this person's Drive");
  // The person whose call it was can still put it in their own Drive.
  assert.equal(ownfiles.ownFile("dm:fake:+15550000002", rec).ok, true);
  assert.equal(ownfiles.ownFile(OMARI, rec).ok, false);
});

test("a path outside Reason's own data directory is refused, and nothing is read", async () => {
  await connect();
  const theirs = join(outside, "id_rsa");
  writeFileSync(theirs, "PRIVATE KEY");

  const out = await call("drive_upload", { path: theirs, name: "notes.txt" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "outside_data_dir");
  assert.match(out.error, /Nothing was uploaded/);
  assert.match(out.error, /not negotiable/);
  assert.equal(fake.state.driveCreated.length, 0, "it uploaded a file from outside anyway");
});

test("a symlink inside the data directory cannot walk out of it", async () => {
  await connect();
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "PRIVATE KEY");
  const link = join(dir, "looks-innocent.txt");
  symlinkSync(secret, link);

  const out = await call("drive_upload", { path: link });
  assert.equal(out.ok, false, "a symlink out of the data directory was followed and uploaded");
  assert.equal(out.status, "outside_data_dir");
  assert.equal(fake.state.driveCreated.length, 0);
});

test("relative paths and .. cannot climb out either", async () => {
  await connect();
  for (const path of [join(dir, "..", "..", "etc", "hosts"), "../../../etc/hosts", "/etc/hosts"]) {
    const out = await call("drive_upload", { path });
    assert.equal(out.ok, false, `${path} was accepted`);
    assert.ok(["outside_data_dir", "not_found", "not_a_file"].includes(out.status), `${path} → ${out.status}`);
  }
  assert.equal(fake.state.driveCreated.length, 0);
});

test("a directory, a missing file and one over the size cap each say which it was", async () => {
  const sub = join(dir, "a-folder");
  mkdirSync(sub, { recursive: true });
  assert.equal(driveorg.localFileToUpload(sub).status, "not_a_file");
  assert.equal(driveorg.localFileToUpload(join(dir, "nope.txt")).status, "not_found");
  assert.equal(driveorg.localFileToUpload("").status, "no_path");

  const big = join(dir, "big.bin");
  writeFileSync(big, Buffer.alloc(driveorg.UPLOAD_MAX_BYTES + 1));
  const over = driveorg.localFileToUpload(big);
  assert.equal(over.status, "too_big");
  assert.match(over.why, /5MB/);
  rmSync(big);
});

// ---------- the undo window and standing permissions ----------

test("the window covers binning and sharing, and not renaming, moving or folders", () => {
  assert.equal(undo.HOLDS.drive_trash, "drive");
  assert.equal(undo.HOLDS.drive_share, "drive");
  for (const t of ["drive_rename", "drive_move", "drive_folder_create", "drive_upload", "drive_folders"]) {
    assert.ok(!undo.HOLDS[t], `${t} must not be held — it reaches nobody and is undone by saying so`);
  }
  assert.ok(undo.KINDS.includes("drive"), "there is no setting for it");
});

test("switching the window off does not loosen the gate", async () => {
  await connect();
  db.setUndoPrefs(OMARI, { seconds: 0 });
  const refused = await call("drive_trash", { file_id: "f-lease" });
  assert.equal(refused.blocked, "needs_confirmation", "the gate went away with the window");

  const id = await yesFor("drive_trash", { summary: "bin Scan 47", target: driveorg.trashTarget({ file_id: "f-lease", account: "me@example.com" }) });
  const out = await call("drive_trash", { file_id: "f-lease", confirmation_id: id });
  assert.ok(!out.undo_held, "it held something on a conversation that switched the window off");
  assert.equal(out.ok, true, JSON.stringify(out));
  db.setUndoPrefs(OMARI, { seconds: null });
});

test("tidying can be pre-authorized; sharing with somebody cannot be covered by it", () => {
  assert.deepEqual(permissions.actionsFor("drive_tidying"), ["drive_trash", "drive_move"]);
  assert.ok(!permissions.actionsFor("drive_tidying").includes("drive_share"),
    "a sentence about tidying must not grant giving another person access to a document");
  assert.ok(permissions.knownScopeActions().includes("drive_share"), "sharing must still be grantable on its own, by name");
});

// ---------- their data ----------

test("organising adds no table, and a disconnect clears the names it read out", async () => {
  await connect();
  await call("drive_rename", { file_id: "f-lease", name: "Lease — 240 Ocean Ave" });
  await call("drive_move", { file_ids: ["f-r1"], into: "fol-taxes" });

  // Every organising tool is on the list a disconnect scrubs: all of them hand back file names.
  for (const t of ["drive_folders", "drive_folder_create", "drive_rename", "drive_move", "drive_trash", "drive_share", "drive_upload"]) {
    assert.ok(google.READ_TOOLS.includes(t), `${t} leaves file names in the thread and is not scrubbed on a disconnect`);
  }

  const all = exportData({ conversation: OMARI });
  assert.ok(!Object.keys(all.tables).some(t => /drive/i.test(t)), `a Drive table appeared: ${Object.keys(all.tables)}`);
  // The receipts are there, and carry names rather than contents.
  const rows = all.tables.action_ledger.filter(r => String(r.action).startsWith("drive_"));
  assert.ok(rows.length >= 2);
  assert.ok(!rows.some(r => /RESIDENTIAL LEASE/.test(JSON.stringify(r))), "a document's contents reached a receipt");

  await deleteData({ conversation: OMARI });
  assert.equal(exportData({ conversation: OMARI }).tables.action_ledger.length, 0);
});

// ---------- and the model is told how to behave ----------

test("the prompt makes organising propose-then-do, with counts and no file ids", async () => {
  // The prompt keeps one line; the full rule rides on the organising tools (src/playbooks.js),
  // which on the CLI backend is every one of them.
  assert.match(systemFor({ name: "Omari", isOperator: true }), /Their Drive is yours to organise/);
  const { MCP_TOOLS } = await import("../src/backends/mcp-core.js");
  for (const name of ["drive_move", "drive_trash", "drive_share"]) {
    const prompt = MCP_TOOLS.find(t => t.name === name).description;
    assert.match(prompt, /Their Drive is a thing you ORGANISE/);
    assert.match(prompt, /Moving SEVERAL is where you PROPOSE first/);
    assert.match(prompt, /need no yes/, "renames and folders must be stated as free");
    assert.match(prompt, /ALWAYS ask first/, "binning and sharing must be stated as always asking");
    assert.match(prompt, /ONE line with the counts in it/);
    assert.match(prompt, /never a list of names or ids/);
    assert.match(prompt, /one tap/, "the reconnect must not read as an error");
  }
});

test("every organising tool exists, carries an account parameter, and is gated as designed", async () => {
  const { tools, ALWAYS_NEEDS_CONFIRMATION, CONDITIONALLY_GATED } = await import("../src/tools.js");
  const byName = new Map(tools.map(t => [t.name, t]));
  for (const t of ["drive_folders", "drive_folder_create", "drive_rename", "drive_move", "drive_trash", "drive_share", "drive_upload"]) {
    assert.ok(byName.has(t), `${t} is not a tool`);
    assert.ok(byName.get(t).input_schema.properties.account, `${t} must say which Drive it acts on`);
  }
  assert.ok(ALWAYS_NEEDS_CONFIRMATION.has("drive_trash"));
  assert.ok(CONDITIONALLY_GATED.has("drive_move") && CONDITIONALLY_GATED.has("drive_share"));
  for (const t of ["drive_rename", "drive_folder_create", "drive_upload", "drive_folders"]) {
    assert.ok(!ALWAYS_NEEDS_CONFIRMATION.has(t) && !CONDITIONALLY_GATED.has(t), `${t} must not cry wolf`);
  }
  assert.equal(drive.FOLDER_MIME, FOLDER);
});
