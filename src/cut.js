// Fitting somebody's document into a tool result, and saying how much of it there was.
//
// A file of its own for one small function, and the reason is the import graph rather than taste.
// This lived in src/drive.js, which was right while a Drive file was the only long thing Reason read.
// A PDF attached to an email is read in src/google.js, src/drive.js imports src/google.js, and having
// src/google.js import src/drive.js back for this would be a cycle for six lines. The alternative — a
// second copy of the wording in the mail reader — is worse: the sentence a person is told about how
// much of their document was read would then exist twice and be free to drift.
import { config } from "./config.js";

/**
 * The text, cut to something a text conversation can hold, saying so when it cut.
 *
 * Always says how much there was, not just that there was more: "the first 8,000 of about 40,000
 * characters" is something a person can act on, and "truncated" on its own is not.
 */
export function cut(text, maxChars = config.driveTextChars) {
  const whole = String(text ?? "");
  const max = Math.max(200, Number(maxChars) || config.driveTextChars);
  if (whole.length <= max) return { text: whole, truncated: false, chars: whole.length };
  return { text: whole.slice(0, max), truncated: true, chars: whole.length, kept: max };
}
