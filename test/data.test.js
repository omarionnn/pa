// Export and delete — the two commands that have to be literally true.
//
// "You can take your data and you can delete it" is only worth saying if the export is complete
// and the delete leaves nothing behind. Call recordings are the awkward part: they are files on
// disk rather than rows, so an export that skipped them would be a partial copy and a delete that
// skipped them would leave somebody's phone call sitting in data/recordings/ after they asked for
// it to be gone. Both are pinned here.
//
// No API key, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-data-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const { exportData, deleteData } = await import("../src/data.js");
const { runTool } = await import("../src/tools.js");
const { FakeCallProvider, FIXTURE_RECORDING } = await import("../src/calls/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { profileDirFor, profilePath } = await import("../src/browser.js");

const C = config.ownerConversation;
const OTHER = "contact:fake:+14155559876";

// Every conversation belongs to somebody now, and the router is what creates that account in
// production. A test that drives the tools directly sets one up the same way.
const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
function seedAccounts() {
  // Re-seeded every test, because deleteData() now wipes the accounts table too — which is the
  // point of it: a delete leaves nothing of that person behind, their account included.
  for (const [id, addr] of [[C, "+12025551234"], [OTHER, "+14155559876"]]) {
    db.upsertAccount({ conversationId: id, channel: "test", address: addr, name: "Omari", isOperator: id === C });
  }
}

beforeEach(() => {
  clock.reset();
  seedAccounts();
  db.db.exec("DELETE FROM calls; DELETE FROM plans; DELETE FROM conversations; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM tasks; DELETE FROM people; DELETE FROM person_facts;");
});

/** One finished, recorded call on a conversation. Returns its row. */
async function recordedCall(conversationId = C) {
  const calls = new FakeCallProvider();
  // "owner" is whoever's Reason this is now, so the same helper works in either account. A
  // hard-coded number would be a third party in somebody else's Reason, and rightly gated.
  const placed = await runTool("call_place", { to: "owner", goal: "ask about a table" }, { conversationId, calls });
  assert.equal(placed.ok, true, placed.error);
  await runTool("call_status", { call_id: placed.call_id }, { conversationId, calls });
  const row = db.getCall(conversationId, placed.call_id);
  assert.equal(row.recording_state, "stored");
  return row;
}

test("the export carries the recording's bytes, not just a path", async () => {
  const row = await recordedCall();
  const out = exportData();

  assert.equal(out.recordings.length, 1);
  const rec = out.recordings[0];
  assert.equal(rec.call_id, row.id);
  assert.equal(rec.file, row.recording_file);
  assert.equal(rec.format, "wav");
  assert.equal(rec.mime, "audio/wav");
  assert.equal(rec.sha256, row.recording_sha256);
  assert.equal(rec.missing, false);
  // The audio really is inside the export: decoding it gives back the file byte for byte.
  assert.ok(rec.audio_base64, "the bytes should be in the export");
  assert.deepEqual(Buffer.from(rec.audio_base64, "base64"), readFileSync(FIXTURE_RECORDING));
});

test("the export includes the calls table itself, with what was announced", async () => {
  await recordedCall();
  const out = exportData();
  assert.equal(out.tables.calls.length, 1);
  assert.match(out.tables.calls[0].announcement, /ai assistant/i);
  assert.match(out.tables.calls[0].announcement, /recorded/i);
  // And the tables that were missing before: a trust feature that quietly skipped your tasks and
  // your watches was not telling the truth either.
  for (const t of ["tasks", "watches", "nudges", "threads", "people", "person_facts", "calls"]) {
    assert.ok(t in out.tables, `${t} should be in the export`);
  }
});

test("--no-audio keeps the list and leaves the bytes out", async () => {
  await recordedCall();
  const out = exportData({ audio: false });
  assert.equal(out.recordings.length, 1);
  assert.equal(out.recordings[0].audio_base64, undefined);
  assert.equal(out.recordings[0].sha256.length, 64, "you still know what you are missing");
});

test("an export says so when a file the database claims is not on disk", async () => {
  const row = await recordedCall();
  rmSync(row.recording_file);
  const rec = exportData().recordings[0];
  assert.equal(rec.missing, true);
  assert.equal(rec.audio_base64, undefined);
});

test("one conversation's export does not carry another's recording", async () => {
  const mine = await recordedCall(C);
  const theirs = await recordedCall(OTHER);

  const ours = exportData({ conversation: C });
  assert.deepEqual(ours.recordings.map(r => r.call_id), [mine.id]);
  assert.equal(ours.tables.calls.length, 1);

  const all = exportData();
  assert.deepEqual(all.recordings.map(r => r.call_id).sort(), [mine.id, theirs.id].sort());
});

test("delete removes the audio from disk, not just the row", async () => {
  const row = await recordedCall();
  assert.ok(existsSync(row.recording_file));

  const out = deleteData();
  assert.equal(out.rows.calls, 1);
  assert.equal(out.recordings.listed, 1);
  assert.equal(out.recordings.files_deleted, 1);
  assert.deepEqual(out.recordings.failed, []);
  assert.equal(existsSync(row.recording_file), false, "the recording must actually be gone");
  assert.equal(db.getCall(C, row.id), null);
});

test("deleting one conversation leaves the other's recording alone", async () => {
  const mine = await recordedCall(C);
  const theirs = await recordedCall(OTHER);

  const out = deleteData({ conversation: C });
  assert.equal(out.recordings.files_deleted, 1);
  assert.equal(existsSync(mine.recording_file), false);
  assert.equal(existsSync(theirs.recording_file), true, "a scoped delete must not reach into another thread");
  assert.ok(db.getCall(OTHER, theirs.id));
});

test("a file already gone is counted, not treated as a failure", async () => {
  const row = await recordedCall();
  rmSync(row.recording_file);
  const out = deleteData();
  assert.equal(out.recordings.already_gone, 1);
  assert.equal(out.recordings.files_deleted, 0);
  assert.deepEqual(out.recordings.failed, []);
});

test("delete really empties every table it names", async () => {
  await runTool("plan_create", { title: "dinner", kind: "dinner" }, { conversationId: C });
  await recordedCall();
  deleteData();
  const after = exportData();
  for (const [name, rows] of Object.entries(after.tables)) {
    assert.deepEqual(rows, [], `${name} should be empty`);
  }
  assert.deepEqual(after.recordings, []);
});

// ---------- the two things an export must not carry out of the machine ----------
//
// Added with saved sign-ins and Spotify, because both introduced a credential where there had only
// ever been content. The promise is narrow and has to be exact: an export says WHICH accounts are
// connected and never the thing that makes them work.

test("an export lists the Spotify connection and redacts the tokens", () => {
  seedAccounts();
  db.saveOauthTokens(C, "spotify", {
    accessToken: "BQD-real-access-token", refreshToken: "AQA-real-refresh-token",
    scope: "user-top-read user-modify-playback-state", expiresAt: clock.now() + 3_600_000,
  });
  db.connectAccount(C, "spotify", ["user-top-read"]);

  const out = exportData();
  const row = out.tables.oauth_tokens.find(r => r.provider === "spotify");
  assert.ok(row, "the connection itself is somebody's own record and belongs in their export");
  assert.equal(row.scope, "user-top-read user-modify-playback-state", "and so do the scopes");
  assert.ok(row.connected_at, "and when it was connected");

  // The part that would be a leak. A refresh token in a file somebody emails themselves is six
  // months of access to their Spotify sitting in an attachment.
  assert.doesNotMatch(JSON.stringify(out), /BQD-real-access-token/);
  assert.doesNotMatch(JSON.stringify(out), /AQA-real-refresh-token/);
  assert.match(row.access_token, /live credential/);
  assert.match(row.refresh_token, /live credential/);
  assert.match(out.redacted, /oauth_tokens/);

  // And a handshake in flight is left out altogether rather than redacted — there is nothing in it
  // worth keeping and a live one is a credential.
  db.newOauthState({ conversationId: C, provider: "spotify", scope: "x", redirectUri: "y" });
  assert.equal(exportData().tables.oauth_states, undefined);
});

test("an export lists which sites are signed in and never a cookie", () => {
  seedAccounts();
  db.recordSiteSignin(C, "amazon", { state: "signed_in", evidence: "order history loaded" });
  const out = exportData();
  const row = out.tables.connected_accounts.find(r => r.name === "amazon");
  assert.equal(row.state, "signed_in");
  assert.ok(row.evidence, "why it thinks so is part of the record");
  // There is no cookie column, and there must never be one: the session lives in a browser profile
  // directory, which this export deliberately does not reach into.
  assert.equal(row.cookies, undefined);
  assert.doesNotMatch(Object.keys(row).join(","), /cookie|token|password/i);
});

test("a delete removes the browser profile, not only the rows that describe it", () => {
  seedAccounts();
  db.recordSiteSignin(C, "amazon", { state: "signed_in", evidence: "order history loaded" });
  const mine = profileDirFor(C);
  const theirs = profileDirFor(OTHER);
  mkdirSync(join(mine, "Default"), { recursive: true });
  writeFileSync(join(mine, "Default", "Cookies"), "pretend-amazon-session");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, "Cookies"), "somebody-else");

  const out = deleteData({ conversation: C });
  assert.equal(out.profiles.deleted, 1);
  assert.deepEqual(out.profiles.failed, []);
  // The cookies are really gone. A delete that left these would leave Reason able to go on acting
  // as that person on every site they had signed in to, while the rows said nothing was connected.
  assert.equal(existsSync(mine), false, "their profile is gone");
  assert.equal(existsSync(theirs), true, "and nobody else's was touched");
});

test("a delete with no scope removes every profile", () => {
  seedAccounts();
  for (const id of [C, OTHER]) {
    mkdirSync(profileDirFor(id), { recursive: true });
    writeFileSync(join(profileDirFor(id), "Cookies"), "x");
  }
  const out = deleteData();
  assert.equal(out.profiles.deleted, 2);
  // profilePath rather than profileDirFor: the latter makes the directory, so asserting with it
  // would recreate exactly what the delete just removed and always pass.
  assert.equal(existsSync(profilePath(C)), false);
  assert.equal(existsSync(profilePath(OTHER)), false);
});

test("a delete that finds no profile reports none, rather than creating one to report", () => {
  seedAccounts();
  rmSync(profilePath(C), { recursive: true, force: true });
  const out = deleteData({ conversation: C });
  assert.deepEqual(out.profiles.failed, []);
  assert.equal(out.profiles.deleted, 0, "nothing was there, so nothing was removed");
  assert.equal(existsSync(profilePath(C)), false, "and nothing was created on the way past");
});
