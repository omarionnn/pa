// How much of a conversation is kept, and how it is cut, on both model backends.
//
// The API path (src/agent.js) always kept the last 60 messages. The CLI path — the one the live
// Reason runs on — kept everything: every turn loaded the whole thread, appended a line, and wrote
// the whole thread back, twice. By 2026-10-18 the owner's own thread was 1,847 messages and 552 KB
// of JSON, parsed and rewritten several times a turn, of which the model was only ever shown the
// last 40 (renderHistory in src/backends/claude-cli.js). Nothing else reads further back than that:
// a call takes the last 2 × callHistoryTurns (src/calls/voice.js), the harm screen the last 6
// (src/harm.js). So both backends now keep the same 60, cut the same way.
//
// The cut is not free, and this is the one place that pays for it. The confirm gate and a call's
// texted check both decide "has anything arrived since I asked" by counting messages in the thread
// (src/trust.js, src/calls/verify.js). A thread that is held at a fixed size stops growing, so a
// count taken before the cut would never be passed by one taken after it, and a real yes would be
// read as "they have not answered yet" forever. Every cut moves those marks back by exactly what it
// removed (db.shiftThreadMarks).
import * as db from "./db.js";
import { ownerTexts } from "./trust.js";

export const THREAD_KEEP = 60;

/** The newest `max` messages, starting on something they said — a model's first message is theirs. */
export function trimThread(messages, max = THREAD_KEEP) {
  const m = messages.slice(-max);
  while (m.length && !(m[0].role === "user" && typeof m[0].content === "string")) m.shift();
  return m;
}

/**
 * Write a conversation back, cut to size, with every count-based mark moved to match.
 * `messages` must be the whole thread as it stands — what is dropped is measured against it.
 */
export function saveThread(conversationId, messages, { max = THREAD_KEEP } = {}) {
  const kept = trimThread(messages, max);
  if (kept.length < messages.length) {
    db.shiftThreadMarks(conversationId, {
      ownerTexts: ownerTexts(messages).length - ownerTexts(kept).length,
      userLines: messages.filter(m => m?.role === "user").length - kept.filter(m => m?.role === "user").length,
    });
  }
  db.saveConversation(conversationId, kept);
  return kept;
}
