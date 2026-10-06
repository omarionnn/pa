// What is already open, put in front of the model on every ordinary turn.
//
// The failure this exists for: they say "including fees" in the middle of an apartment search, and
// it holds for exactly one reply. Four hours later the task wakes, the message has been trimmed out
// of the conversation, and the next three options come back without the fee line. A correction made
// once has to hold for the rest of the job, which means the job's sheet has to be in front of the
// model when the correction lands AND on every turn after it.
//
// This is turn-only, like the "what's new" note: it is a fact about the state of things right now,
// and a copy of it sitting in the thread's history would go on describing a task that has since
// finished. See `userMessageFor` in src/agent.js.
//
// It reads rows and nothing else. It does not read their words, does not decide what they meant,
// and does not tell the model what to do about any of it beyond the standing rule: a short steer
// applies to the thing in front of you.
import * as db from "./db.js";
import { stamp } from "./config.js";
import { sheetView, tasteView } from "./sheet.js";

/**
 * One line for the turn, or "" when nothing is open.
 *
 * `limit` is a ceiling on how many sheets go in: somebody with nine open jobs does not need all
 * nine in every message's context, and the newest are the ones a steer is most likely about.
 */
export function openWorkNote(conversationId, { limit = 4 } = {}) {
  const tasks = db.listTasks(conversationId).slice(0, limit);
  const pending = db.pendingConfirmations(conversationId)
    .filter(x => !x.granted_at)
    .map(x => ({ confirmation_id: x.id, action: x.action, you_said_youd: x.summary, target: x.target || undefined, asked: stamp(x.asked_at) }));
  if (!tasks.length && !pending.length) return "";

  const tastes = tasteView(db.listPreferences(conversationId, { limit: 12 }), { stamp });
  const open = tasks.map(t => ({
    task_id: t.id, title: t.title, state: t.state,
    sheet: sheetView(t.sheet, { progress: t.log.filter(l => l.kind !== "state").map(l => l.note), stamp, tastes }),
  }));

  const parts = [];
  if (open.length) {
    parts.push(`open work, with everything each job is carrying: ${JSON.stringify(open)}.`
      + ` These sheets are as true now as when they were written, so do not ask for anything already on one.`);
  }
  if (pending.length) {
    parts.push(`you are waiting on an answer about: ${JSON.stringify(pending)}.`);
  }
  parts.push("If what they just said is a short steer at one of these — shorter, wrong person, leave that alone, actually friday, including fees —"
    + " it is about THAT thing: apply it with task_update's steer (or, for something waiting on a yes, change the detail and ask once more with the amended line),"
    + " and never make them explain it again. If it is not about any of these, ignore this note.");
  return parts.join(" ");
}
