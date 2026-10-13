// What the sweep found that an open job was waiting for.
//
// The night of 2026-10-12: a task was "tell omari when petra confirms the josh call". It checked
// mail from Petra twice, then slept until 8am. Josh's invite landed on the calendar at 10:53pm; the
// 12:51am sweep saw it, filed it as "new on your calendar", and held it for the morning. The job
// that was waiting on exactly that meeting was never told. Omari asked at 7am.
//
// So: a candidate the sweep writes down is held up against every open job in the conversation,
// in code, before anything is held. A hit is written on the job as a `landed` line and the job is
// woken now — the wake, not the sweep, is what speaks, because the job knows what it was for.
//
// Matching is on words, because that is all a task has: its title, its goal and who it says it is
// waiting on. A candidate matches when one of the job's own name-like words starts a word in the
// candidate's text. Loose on purpose — a wake that finds nothing costs a model call and says
// NO_REPLY; a wake that never came cost a morning.
import * as db from "./db.js";
import { clock, config, stamp } from "./config.js";

/** Words that are in every title and name nobody. Weekdays and months included: "friday" is not a person. */
const NOISE = new Set(`
  tell text ping let know when whether what which where while with without will would could should
  that this they them their there then than from into onto over under about after before again
  also just only once more most some such very like make made find found check checks checking
  confirm confirms confirmed confirming reply replies replied back call calls meeting meet time
  date hour minute today tonight tomorrow morning afternoon evening week month year next last
  monday tuesday wednesday thursday friday saturday sunday january february march april june july
  august september october november december send sent sending email emails mail book booking
  booked look looking wait waiting waits watch watching chase chasing follow following update
  updates done open close closed thing things something anything nothing have having been being
  does doing come comes coming back get gets getting give gives need needs want wants does
`.split(/\s+/).filter(Boolean));

/** The owner's name is in half the titles and names nobody the sweep would find. */
const ownerWords = () => String(config.ownerName ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The name-like words of one task: title, goal, and who the sheet says it is waiting on. */
export function taskWords(task) {
  const sheet = task?.sheet ?? {};
  const bits = [task?.title ?? "", task?.goal ?? "", ...(sheet.waiting ?? []).flatMap(w => [w.on ?? "", w.for ?? ""])];
  const skip = new Set([...NOISE, ...ownerWords()]);
  const out = new Set();
  for (const w of bits.join(" ").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || skip.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

/** Everything a candidate says, as one lowercase string: what it is, who is on it, who sent it. */
export function candidateText(cand) {
  const ev = cand?.event ?? null;
  const parts = [
    cand?.what, cand?.detail, cand?.from, cand?.from_name,
    ev?.summary, ...(ev?.attendees ?? []).map(a => (typeof a === "string" ? a : a?.email) ?? ""),
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** Which of the task's words the candidate carries. Empty means no match. */
export function matchWords(task, cand) {
  const text = candidateText(cand);
  if (!text) return [];
  return taskWords(task).filter(w => new RegExp(`\\b${w}`).test(text));
}

/** The open jobs a candidate could be news for: anything open except one waiting on THEM. */
export function tasksToWake(conversationId) {
  return db.listTasks(conversationId).filter(t => t.open && t.state !== "waiting_on_you");
}

/**
 * Hold a sweep's candidates up against the conversation's open jobs. For every hit: a `landed`
 * line on the job, the job woken now, and the candidate marked resolved as that job's — so the
 * sweep does not also raise it as "new on your calendar" in a separate text.
 *
 * Returns what was bridged, so the sweep can take those candidates out of its own frame.
 */
export function bridge(conversationId, candidates, { now = clock.now(), log = () => {} } = {}) {
  const tasks = tasksToWake(conversationId);
  const bridged = [];
  if (!tasks.length) return bridged;
  for (const cand of candidates) {
    for (const t of tasks) {
      const words = matchWords(t, cand);
      if (!words.length) continue;
      const line = `the sweep found this while you were waiting: ${cand.what}`
        + ` (${cand.kind}${cand.event_id ? `, calendar event ${cand.event_id}` : ""}${cand.thread_id ? `, mail thread ${cand.thread_id}` : ""};`
        + ` matched on "${words.join('", "')}")`;
      db.logTask(t.id, "landed", line);
      db.scheduleTask(t.id, now);
      if (cand.id) db.resolveNotice(cand.id, `task:${t.id}`, now);
      bridged.push({ task: t.id, key: cand.key, kind: cand.kind, words });
      log({ task: t.id, landed: cand.key, kind: cand.kind, words });
    }
  }
  return bridged;
}

/** The `landed` lines written on a job since it last really looked. */
export function landedSince(task, since) {
  return db.taskLog(task.id, 30).filter(l => l.kind === "landed" && l.at > (since ?? 0));
}

/**
 * The code-written paragraph a waiting job's wake opens with: what landed since its last look, or
 * that nothing did. Written by code, because the model's own sheet said "next check 8am" and
 * nothing in front of it said otherwise.
 */
export function landedNote(task, { since }) {
  const rows = landedSince(task, since);
  if (!rows.length) return "";
  return `\nSINCE YOU LAST LOOKED, code found these and woke you for them:\n`
    + rows.map(l => `  - ${stamp(l.at)} ${l.note}`).join("\n")
    + `\nRead them against what this job is actually waiting for. A time confirmed by ANYONE — an invite from somebody`
    + ` else on the meeting, the event landing on the calendar — resolves a wait on that time, whoever you were expecting it from.`
    + ` If one of these resolves it, say so to ${config.ownerName} now, once, in one line, and close or update the job.`
    + ` If it does not, write that down in one line and keep waiting.`;
}
