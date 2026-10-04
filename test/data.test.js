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
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

const C = config.ownerConversation;
const OTHER = "contact:fake:+14155559876";
const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM plans; DELETE FROM conversations; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM tasks; DELETE FROM people; DELETE FROM person_facts;");
});

/** One finished, recorded call on a conversation. Returns its row. */
async function recordedCall(conversationId = C) {
  const calls = new FakeCallProvider();
  const placed = await runTool("call_place", { to: OWNER, goal: "ask about a table" }, { conversationId, calls });
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
