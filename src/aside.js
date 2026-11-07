// One "btw" a day, at most, and only when it belongs.
//
// Three things can ride along on the end of a reply to something they asked: a new feature they have
// not heard about (src/whatsnew.js), a thing they once asked for that is now possible (the same
// file's resolved misses), and a catch Reason noticed and never got to say (src/notice.js heldNote).
// Each had its own budget, so on a busy day a person could get all three, on top of answers about
// something else entirely. The 7-day review (2026-11-06) counted six unrelated "btw" asides; the
// owner's rule is at most ONE per person per day, across all of them, and only when it bears on what
// the conversation is about.
//
// Code keeps the count: which notes the turn is shown, and the day's one spent the moment one is
// really said. Whether it bears on the conversation is the model's reading of the moment, and every
// aside note says so in the same words (RELATED).
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { clock } from "./config.js";

const key = (conversationId) => `aside_day:${conversationId}`;

/** Has this person already had their one aside today? */
export function spentToday(conversationId, now = clock.now()) {
  const today = accounts.today(now);
  if (db.opsGet(key(conversationId)) === today) return true;
  // A new feature they were told about is written down by the runtime once the reply went out.
  const told = db.lastWhatsNewTold(conversationId);
  return !!told && accounts.today(told) === today;
}

/** An aside really went out on a reply of theirs: today's one is spent. */
export function spend(conversationId, now = clock.now()) {
  db.opsSet(key(conversationId), accounts.today(now));
}

/** The relatedness rule every aside note carries, so the model reads them all the same way. */
export const RELATED = `Only if it bears on what they are talking about right now — something they would connect to this`
  + ` conversation without being told why. Unrelated to what they just said? Leave it out: it will keep.`;

/**
 * The aside notes a turn is shown: none once today's is spent, and otherwise only the first that has
 * anything in it, in the order given (most useful first). Returns the list with the rest blanked, so
 * a caller can keep its own variables and logging.
 */
export function onlyOne(conversationId, notes, now = clock.now()) {
  if (spentToday(conversationId, now)) return notes.map(() => "");
  let kept = false;
  return notes.map(n => {
    if (!n || kept) return "";
    kept = true;
    return n;
  });
}
