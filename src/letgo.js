// Changing their mind, cheaply.
//
// "Forget the trip." "Drop the apartment thing." "Never mind lunch." Saying that should cost one
// sentence, and today it costs a conversation: which of the four things did you mean, is the timer
// still going, did you already pay for anything. The expensive version of this is worse than it
// sounds — somebody who has learned that changing their mind is a negotiation stops saying it, and
// starts letting Reason finish things they no longer want.
//
// So: one tool, and the answer comes back as **two lists**.
//
//   - **Stopped** — the tasks, reminders, watchers and open asks that were running and now are
//     not. Nothing was lost; each gets a receipt on the ledger, because something that quietly
//     disappears is not the same as something that was stopped.
//   - **Already committed** — what really went out and cannot be unsent: the booking, the payment,
//     the message to somebody else. These are **not touched**. They come back with their receipt
//     and, when the job wrote one down, the cancellation cost. That list is the only thing worth
//     asking them about, and the ask is one line: "the hotel is booked, $25 to cancel — want me to?"
//
// Everything here is a lookup. The task id goes onto a timer, a watcher, a confirmation and a
// ledger row at the moment each is made (see src/db.js), so none of this depends on the model
// remembering what it started four hours and sixty trimmed messages ago. What is not tied is not
// claimed: a notice is only swept up when the timer it was scheduled on belongs to one of these
// jobs, and nothing is matched on words.
import * as db from "./db.js";
import { stamp } from "./config.js";
import { parseSheet } from "./sheet.js";

/** Constraint keys that read like the terms for getting out of something. */
const TERMS = /cancel|refund|deposit|penalt|non.?refund|change.?fee|notice/i;

/**
 * What this job wrote down about getting out of it, if anything.
 *
 * Read off the sheet, never guessed. A cancellation cost Reason invented is worse than none: it is
 * the number somebody decides on. When nothing is written down the answer is an honest "not
 * written down", and the note says to find out rather than to estimate.
 */
export function termsOn(sheet) {
  const s = parseSheet(sheet);
  return Object.entries(s.constraints)
    .filter(([k]) => TERMS.test(k))
    .map(([k, v]) => ({ what: k, says: v.value, ...(v.said ? { their_words: v.said } : {}) }));
}

/**
 * Stop everything running for these jobs, and report what could not be stopped.
 *
 * `cancel` is injected so this function is the whole decision and the database work is somebody
 * else's — which is also what makes the ordering testable: everything is read BEFORE anything is
 * cancelled, so a half-finished stop cannot report itself as a clean one.
 */
export function letGo({ conversationId, tasks, verbatim, about, now = Date.now() }) {
  const stopped = [];
  const committed = [];
  const receipts = [];

  for (const task of tasks) {
    const running = db.runningFor(conversationId, task.id);
    const went = db.committedOn(conversationId, task.id);
    const terms = termsOn(task.sheet);

    for (const t of running.timers) {
      const r = db.cancelTimer(conversationId, t.id);
      if (r.ok) stopped.push({ kind: "reminder", what: t.note, when_it_would_have: stamp(t.fire_at) });
      // A notice that was only waiting on this timer goes with it: it was scheduled to ride on a
      // job that no longer exists. Only the ones really tied to the timer — nothing is matched on
      // what a notice happens to be about.
      const notice = db.noticeByTimer(t.id);
      if (notice && !notice.said_at && !notice.dropped_at) {
        db.dropNotice(notice.id);
        stopped.push({ kind: "heads-up", what: notice.what || notice.key });
      }
    }
    for (const w of running.watches) {
      const r = db.cancelWatch(conversationId, w.id);
      if (r.ok) stopped.push({ kind: "watcher", what: `${w.looking_for} (${w.url})` });
    }
    for (const x of running.confirmations) {
      db.refuseConfirmation(x.id);
      stopped.push({ kind: "question you were about to be asked", what: x.summary });
    }
    const closed = db.finishTask(conversationId, task.id, { state: "cancelled", outcome: `called off: ${verbatim}`.slice(0, 600) });
    if (closed.ok) stopped.push({ kind: "job", what: task.title });

    for (const a of went) {
      committed.push({
        what: a.receipt, at: stamp(a.at), job: task.title,
        cancellation: terms.length ? terms : "not written down on this job",
      });
    }
    receipts.push({ task: task.id, title: task.title, stopped: stopped.length, committed: went.length });
  }

  // One ledger row for the whole never-mind, with their words on it. A let-go is a real act on
  // their behalf and leaves a receipt like every other, and quoting them is what makes it
  // answerable later: "you said forget the trip, so I stopped these four things".
  db.recordAction({
    conversationId, action: "let_go", target: String(about ?? "").slice(0, 120),
    attempted: { about, verbatim, tasks: tasks.map(t => t.id) },
    outcome: "ok",
    result: { stopped: stopped.length, committed: committed.length },
    receipt: `called off ${tasks.map(t => `"${t.title}"`).join(", ")} — ${stopped.length} thing(s) stopped, ${committed.length} already gone out`,
  });

  return { stopped, committed, receipts, now };
}
