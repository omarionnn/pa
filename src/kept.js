// What Reason has made and kept for this person, put in front of the model on every ordinary turn.
//
// The failure this exists for (2026-10-06, 7:09 PM): Omari texted "Workout" eight minutes after
// Reason's own 7pm nudge to go train, and Reason said "go get it 💪" — with a back-building guide
// and a bigger-shoulders guide it had written for him the night before sitting on two pages. It
// never offered either, because it could not see them: the thread is trimmed to the last few dozen
// messages and the guides were written forty-odd messages earlier. A person who had made those
// guides would have said "want the back one or the shoulders one? here's back: <link>".
//
// So the pages Reason has made for somebody, and the reminders it has promised to come back with,
// ride on every turn they start. Titles and links only — the content of a page stays on the page.
// Turn-only, like the open-work note: it is true of the state of things now, and a copy of it in the
// thread's history would go on listing pages that have since been deleted. See `userMessageFor` in
// src/agent.js.
//
// It reads rows and nothing else. Which of these fits the moment, if any, is the model's call.
import * as db from "./db.js";
import { stamp } from "./config.js";
import { ownerUrl } from "./pages/access.js";
import { shortenAt } from "./fitlong.js";

// A timer note may be up to 2000 characters (timer_set); this line rides on every turn, so each one is
// shown to its first 300. The whole note is what the firing is handed.
const KEPT_NOTE_CHARS = 300;

/**
 * One line for the turn, or "" when there is nothing kept.
 *
 * `pages` and `reminders` are ceilings: somebody with forty pages does not need all forty in every
 * message's context. Newest pages first, soonest reminders first.
 */
export function keptNote(conversationId, { pages = 8, reminders = 6 } = {}) {
  const made = db.listPages(conversationId).slice(0, pages)
    .map(p => ({ page_id: p.id, title: p.title, made: stamp(p.created_at), link: ownerUrl(p) }));
  const set = db.listTimers(conversationId).slice(0, reminders)
    .map(t => ({ timer_id: t.id, for: stamp(t.fire_at), note: shortenAt(t.note, KEPT_NOTE_CHARS), ...(t.call_goal ? { by_phone: true } : {}) }));
  if (!made.length && !set.length) return "";

  const parts = [];
  if (made.length) parts.push(`pages you have made and kept for them, newest first: ${JSON.stringify(made)}.`);
  if (set.length) parts.push(`reminders you have set and not yet sent: ${JSON.stringify(set)}.`);
  parts.push("These are part of the moment, not a list to read out."
    + " When what they just said touches one — they are heading out to train and you wrote their workout guide,"
    + " they mention the thing you promised to remind them about — bring it in yourself, in one line, with the link"
    + " (\"want the back guide or the shoulders one? here's back: <link>\"), the way a friend who remembers would."
    + " If nothing here touches what they said, ignore this note; never ask whether they would like to see what you have kept.");
  return parts.join(" ");
}
