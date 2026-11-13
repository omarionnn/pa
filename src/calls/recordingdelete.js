// "Delete the recording of my last call" / "delete all my call recordings" (call_recording_delete).
//
// The person's own say over their audio, at any time, without deleting everything else of theirs.
// It does what the retention sweep (src/privacy.js deleteOldRecordings) does to an old recording,
// with the person as the reason: the file goes, with the copies made of it (the .caf it was sent as,
// Reason Web's .m4a), and the call's row moves to recording_state 'deleted' with its pointers
// cleared. The call itself stays: who, when, how long, the summary and the transcript. Those are a
// separate thing, and "delete the recording" is not "forget the call".
//
// Two things it cannot reach, said in its result rather than hidden:
// - a copy already sent to them (a voice note on their phone is theirs);
// - the encrypted off-site backups taken before today, which keep every snapshot until the operator
//   prunes them by hand.
import * as db from "../db.js";
import { clock } from "../config.js";
import { LIVE_STATES } from "./provider.js";
import { deleteRecordingFile } from "./recordings.js";

/** A settle that began and has not finished within this long is a crash, not a call still settling. */
const SETTLE_STUCK_MS = 30 * 60_000;

/** The one line the call row carries as recording_why, which callView reads back to the model. */
export const deletedWhy = (at) => `deleted at their request on ${new Date(at).toISOString().slice(0, 10)}`;

/** Still on the line, or its after-call steps (which file the recording) not finished. */
export function stillGoing(row, now = clock.now()) {
  if (LIVE_STATES.includes(row.state)) return true;
  if (row.recording_state === "pending") return true;
  return !!row.settle_started_at && !row.settled_at && now - Number(row.settle_started_at) < SETTLE_STUCK_MS;
}

/** One call's recording. `row` is already this person's (read by conversation_id). */
function deleteOne(conversationId, row, now) {
  if (stillGoing(row, now)) return "still_going";
  if (row.recording_state === "deleted") return "already_deleted";
  if (row.recording_state !== "stored" || !row.recording_file) return "no_recording";
  const d = deleteRecordingFile(row.recording_file);
  if (!d.ok) return "failed";
  db.updateCall(conversationId, row.id, {
    recording_state: "deleted", recording_file: null, recording_bytes: null, recording_sha256: null,
    recording_why: deletedWhy(now), recording_deleted_at: now,
  });
  return "deleted";
}

/**
 * `{ callId }` or `{ all: true }`, for this conversation only. Another account's call id is not
 * found, exactly like one that does not exist.
 */
export function deleteCallRecordings(conversationId, { callId = null, all = false } = {}) {
  const now = clock.now();
  const counts = { deleted: 0, already_deleted: 0, no_recording: 0, still_going: 0, failed: 0 };
  if (!all) {
    const row = callId == null ? null : db.getCall(conversationId, Number(callId));
    if (!row) return { ok: false, not_found: true, counts };
    const what = deleteOne(conversationId, row, now);
    counts[what]++;
    return { ok: what !== "failed" && what !== "still_going", call_id: row.id, what, counts, earlier_sent: !!row.recording_sent_at };
  }
  const rows = db.db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY id ASC").all(conversationId);
  let earlierSent = 0;
  for (const row of rows) {
    const what = deleteOne(conversationId, row, now);
    counts[what]++;
    if (what === "deleted" && row.recording_sent_at) earlierSent++;
  }
  // A call they made to Reason before they had an account, matched to them since (src/strangercalls.js).
  let strangers = 0;
  try {
    const st = db.db.prepare("SELECT id, recording_path FROM stranger_calls WHERE matched_conversation_id = ? AND recording_path IS NOT NULL").all(conversationId);
    for (const s of st) {
      if (!deleteRecordingFile(s.recording_path).ok) { counts.failed++; continue; }
      db.db.prepare("UPDATE stranger_calls SET recording_path = NULL WHERE id = ? AND matched_conversation_id = ?").run(s.id, conversationId);
      strangers++;
    }
  } catch { /* no stranger_calls table in this process */ }
  counts.deleted += strangers;
  return { ok: counts.failed === 0, all: true, calls: rows.length, counts, earlier_sent: earlierSent };
}
