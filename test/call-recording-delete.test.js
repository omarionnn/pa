// "Delete the recording of my last call" / "delete all my call recordings" (call_recording_delete,
// src/calls/recordingdelete.js): the file and its copies go off the disk, the row's pointers clear,
// the state says deleted with when, the call record stays; another account's id is not found; a
// call still going is refused; twice is fine; all needs a yes; everything that points at it behaves.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-rec-delete-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025550142";
process.env.REASON_MASTER_NUMBER = "+12025550142";
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { deleteCallRecordings } = await import("../src/calls/recordingdelete.js");
const { ownFile } = await import("../src/ownfiles.js");
const { exportData } = await import("../src/data.js");
const { sweepRetention } = await import("../src/privacy.js");
const { NEUTRAL } = await import("../src/progress.js");
const { GATED_ACTIONS } = await import("../src/permissions.js");

const A = "dm:owner";
const B = "dm:fake:+14155559876";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db.db.exec("DELETE FROM calls; DELETE FROM confirmations; DELETE FROM action_ledger;");
  mkdirSync(config.recordingRoot, { recursive: true });
});

/** A finished call of `conv` with a stored recording (and the .caf copy it was sent as). */
function callWithRecording(conv, { state = "completed", sent = false } = {}) {
  const c = db.createCall(conv, { provider: "fake", toNumber: "+17185550188", isOwner: true, goal: "check in" });
  const file = join(config.recordingRoot, `call-${c.id}.mp3`);
  writeFileSync(file, Buffer.from("ID3 fake audio"));
  writeFileSync(join(config.recordingRoot, `call-${c.id}.caf`), Buffer.from("caff copy"));
  db.db.prepare(`UPDATE calls SET state = ?, summary = 'They confirmed Tuesday.', transcript = 'Reason: Hi.', duration_s = 60,
    recording_state = 'stored', recording_file = ?, recording_format = 'mp3', recording_bytes = 14, recording_sha256 = 'abc',
    recording_sent_at = ?, ended_at = ? WHERE id = ?`).run(state, file, sent ? Date.now() : null, Date.now(), c.id);
  return { id: c.id, file, caf: join(config.recordingRoot, `call-${c.id}.caf`) };
}
const row = (conv, id) => db.getCall(conv, id);
const ctx = (conv) => ({ conversationId: conv, messages: [] });

test("one call: the file and its copy are gone off disk, pointers and bytes cleared, state deleted with a time, the call kept", async () => {
  const c = callWithRecording(A, { sent: true });
  const out = await runTool("call_recording_delete", { call_id: c.id }, ctx(A));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.result, "deleted");
  assert.equal(out.counts.deleted, 1);
  assert.equal(existsSync(c.file), false, "the recording file is still on disk");
  assert.equal(existsSync(c.caf), false, "the .caf it was sent as is still on disk");
  const r = row(A, c.id);
  assert.equal(r.recording_state, "deleted");
  assert.equal(r.recording_file, null);
  assert.equal(r.recording_bytes, null);
  assert.equal(r.recording_sha256, null);
  assert.ok(r.recording_deleted_at > 0);
  assert.match(r.recording_why, /at their request/);
  assert.equal(r.summary, "They confirmed Tuesday.", "the summary went with it");
  assert.equal(r.transcript, "Reason: Hi.", "the transcript went with it");
  assert.match(out.note, /summary and the transcript/);
  assert.match(out.note, /already been sent/);
  assert.match(out.note, /off-site backups/);
});

test("twice is fine: the second says it was already deleted", async () => {
  const c = callWithRecording(A);
  await runTool("call_recording_delete", { call_id: c.id }, ctx(A));
  const again = await runTool("call_recording_delete", { call_id: c.id }, ctx(A));
  assert.equal(again.ok, true);
  assert.equal(again.result, "already_deleted");
  assert.equal(again.counts.already_deleted, 1);
});

test("another account's call id is not found, and its recording stays", async () => {
  const theirs = callWithRecording(B);
  const out = await runTool("call_recording_delete", { call_id: theirs.id }, ctx(A));
  assert.equal(out.ok, false);
  assert.match(out.error, /No call #/);
  assert.equal(existsSync(theirs.file), true);
  assert.equal(row(B, theirs.id).recording_state, "stored");
  const all = deleteCallRecordings(A, { all: true });
  assert.equal(all.counts.deleted, 0);
  assert.equal(existsSync(theirs.file), true, "all of mine took someone else's");
});

test("a call still going, or still settling, is refused and nothing is touched", async () => {
  for (const state of ["in_progress", "ringing"]) {
    const c = callWithRecording(A, { state });
    const out = await runTool("call_recording_delete", { call_id: c.id }, ctx(A));
    assert.equal(out.ok, false);
    assert.equal(out.result, "still_going");
    assert.equal(existsSync(c.file), true);
  }
  const s = callWithRecording(A);
  db.db.prepare("UPDATE calls SET settle_started_at = ?, settled_at = NULL WHERE id = ?").run(Date.now(), s.id);
  assert.equal((await runTool("call_recording_delete", { call_id: s.id }, ctx(A))).result, "still_going");
  assert.equal(existsSync(s.file), true);
});

test("all: gated by the confirm gate; with the yes, every one goes and the counts say so", async () => {
  const one = callWithRecording(A);
  const two = callWithRecording(A);
  const live = callWithRecording(A, { state: "in_progress" });
  const blocked = await runTool("call_recording_delete", { all: true }, ctx(A));
  assert.equal(blocked.ok, false, "deleting every recording ran without a yes");
  assert.equal(blocked.blocked, "needs_confirmation");
  assert.equal(blocked.use_target, "every call recording");
  assert.equal(existsSync(one.file), true);

  const out = deleteCallRecordings(A, { all: true });
  assert.equal(out.counts.deleted, 2);
  assert.equal(out.counts.still_going, 1);
  assert.equal(existsSync(one.file) || existsSync(two.file), false);
  assert.equal(existsSync(live.file), true, "the live call's recording was taken");
  for (const id of [one.id, two.id]) assert.equal(row(A, id).recording_state, "deleted");
  assert.equal(deleteCallRecordings(A, { all: true }).counts.already_deleted, 2, "twice is not fine");
});

test("the tool is declared, schema'd, gated only for all, with a fixed progress line", async () => {
  assert.ok(toolsFor(A).some(t => t.name === "call_recording_delete"));
  assert.equal(NEUTRAL.call_recording_delete, "Deleting the recording");
  assert.ok(GATED_ACTIONS.has("call_recording_delete"));
  const bad = await runTool("call_recording_delete", {}, ctx(A));
  assert.equal(bad.ok, false, "neither one call nor all was accepted");
});

test("what points at it behaves: send-recording says deleted, the export lists the call without audio, the sweep skips it", async () => {
  const c = callWithRecording(A);
  await runTool("call_recording_delete", { call_id: c.id }, ctx(A));
  const send = ownFile(A, c.file);
  assert.equal(send.ok, false);
  assert.equal(send.status, "recording_deleted");
  assert.match(send.why, /deleted at their request/);
  // Someone else's deleted call does not reveal itself.
  assert.notEqual(ownFile(B, c.file).status, "recording_deleted");

  const status = await runTool("call_status", { call_id: c.id }, ctx(A));
  assert.equal(status.recording ?? status.call?.recording ?? null, null);
  assert.match(JSON.stringify(status), /The audio is gone: deleted at their request/);

  const ex = exportData({ conversation: A, audio: true, files: false });
  const json = JSON.stringify(ex);
  assert.ok(json.includes("They confirmed Tuesday."), "the export dropped the call");
  const recs = ex.recordings ?? ex.call_recordings ?? [];
  assert.equal(recs.filter(r => r.call_id === c.id).length, 0, "the export still lists the deleted recording");

  const before = row(A, c.id);
  const old = config.keepContentDays;
  config.keepContentDays = 1;
  db.db.prepare("UPDATE calls SET ended_at = 1, created_at = 1 WHERE id = ?").run(c.id);
  try { sweepRetention({ now: Date.now(), log: () => {} }); } finally { config.keepContentDays = old; }
  assert.equal(row(A, c.id).recording_why, before.recording_why, "the sweep rewrote a recording they deleted");
  assert.equal(row(A, c.id).recording_state, "deleted");
});
