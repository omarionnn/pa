// A question sent back to a statement.
//
// On 2026-10-12 Omari texted where he lives, where he works, which days and that he takes the
// train — a brief, not a question — and got "what time do you usually leave the house?" and then
// "which station do you get on at, and which line?" before Reason did any of the work it could
// have done itself. The prompt already said to ask only what changes the result; it asked anyway.
//
// This file does not stop that — the prompt and test/flow-brief.test.js are what push on it. It
// makes it countable: every time a reply that goes out asks something back to a message that asked
// nothing, the ledger gets an `asked_back` row with the question, so "how often does it ask
// instead of act" is a number per week rather than the screenshots that happened to be taken.
//
// It is deliberately blunt. A gate's "want me to hit confirm?" counts too, and so does a question
// that was genuinely the right move; the row says what was asked, and the reader judges. A count
// that tried to tell good questions from bad in code would be guessing, and a guess that is wrong
// hides the ones that matter.

const NO_REPLY = "NO_REPLY";

/** Is this message asking something? A question mark anywhere, outside a fenced block. */
export function asks(text) {
  const s = String(text ?? "");
  if (!s.trim()) return false;
  // Fenced blocks are things they paste on — a prompt, a draft — and a "?" in one is not Reason asking.
  const unfenced = s.replace(/```[\s\S]*?```/g, "");
  return unfenced.includes("?");
}

/** The sentence that asked, for the ledger: the first "?"-terminated sentence, trimmed to a line. */
export function questionIn(text) {
  const s = String(text ?? "").replace(/```[\s\S]*?```/g, "");
  const m = s.match(/[^.!?\n]*\?/);
  return m ? m[0].trim().slice(0, 200) : null;
}

/**
 * The reply asked something, and the message it answers did not — so this is Reason asking
 * instead of acting, or asking before acting. Null when there is nothing to note: a reply that
 * states, a reply to a question, nothing sent.
 */
export function askedBack({ text, reply }) {
  const r = String(reply ?? "").trim();
  if (!r || r === NO_REPLY) return null;
  if (!asks(r)) return null;
  if (asks(text)) return null;
  const question = questionIn(r);
  return question ? { question } : null;
}
