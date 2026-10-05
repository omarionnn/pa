// Inline replies: one message pinned under another, the way holding a bubble and tapping Reply
// does it in Messages.
//
// Two directions, and they are different problems:
//
//   out   Reason answering something that is no longer the last thing in the thread — the second
//         of three questions, or the table it went off to find an hour and twenty messages ago.
//         Pinned under the message it answers, nobody has to work out what "yes, 8 works" is about.
//   in    somebody replying under an earlier message. The words alone ("that one") mean nothing
//         without knowing which bubble they were put under, so the turn is told.
//
// What is NOT in here is any judgement about when a reply should be pinned. That is the model's,
// in the system prompt. Code's part is naming a message: the model points at one by quoting a few
// of its words, and this file turns that into the provider's handle for it — a lookup of something
// already chosen, scoped to the one conversation, never a reading of what anybody meant.
import * as db from "./db.js";

/** Fewer characters than this matches half the thread, so it is not a pointer to anything. */
export const MIN_QUOTE_CHARS = 3;

/** Curly quotes and runs of whitespace are the same thing typed two ways; a quote should survive both. */
function plain(s) {
  return String(s ?? "").toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, " ").trim();
}

/** A message short enough to say back in one line. */
export function snippet(text, max = 90) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The most recent message in this conversation carrying these words, theirs or Reason's.
 *
 * Most recent wins when several match, because "ok" said twice is still most likely the nearer
 * one, and the result names what was found so a wrong pick is visible before anything is sent.
 * `isLatest` says the match is the newest message in the thread — a reply pinned directly under
 * the message above it is just a reply, and the caller refuses that.
 */
export function findByQuote(conversationId, quote) {
  const q = plain(quote);
  if (q.length < MIN_QUOTE_CHARS) {
    return { ok: false, error: `'${String(quote ?? "").trim()}' is too short to pick out one message. Quote a few exact words from the one you mean.` };
  }
  const recent = db.recentMessages(conversationId);
  const hit = recent.find(m => m.handle && plain(m.text).includes(q));
  if (!hit) {
    return { ok: false, error: `no message in this thread has the words '${snippet(quote, 60)}'. Quote it exactly as it was written — theirs or yours.` };
  }
  return { ok: true, handle: hit.handle, from: hit.from, text: hit.text, isLatest: recent[0]?.handle === hit.handle };
}

/**
 * The line a turn reads when their message arrived as an inline reply.
 *
 * Three cases, and the third matters as much as the other two: a reply under a message there is no
 * record of (sent before this install kept handles, or one Reason never saw) is said to be exactly
 * that, so the model asks rather than guessing which bubble "that one" was under.
 */
export function inboundReplyLine(conversationId, handle) {
  const h = String(handle ?? "").trim();
  if (!h) return "";
  const m = db.messageByHandle(conversationId, h);
  if (m && m.text) {
    return m.from === "reason"
      ? `[they sent this as an inline reply to your message: "${snippet(m.text)}" — so it is about that, whatever came after]`
      : `[they sent this as an inline reply to their own earlier message: "${snippet(m.text)}" — so it is about that, whatever came after]`;
  }
  return "[they sent this as an inline reply to an earlier message, and there is no record of which one. if the words alone do not say what it is about, ask]";
}
