// A link Reason sends goes out as its own message.
//
// On a phone, a URL buried in a paragraph is a URL nobody taps: iMessage will only draw a preview
// card for a message that is a link and nothing else, and a link in the middle of a sentence is
// just underlined blue text in a wall of words. So a reply with a link in it leaves as two
// messages — the bare URL, then the words about it — and that split happens HERE, in code, rather
// than being asked of the model, for the same reason the confirm gate is not asked of the model:
// a rule that only holds when the model remembers it does not hold.
//
// WHAT SENDBLUE'S DOCS SAY ABOUT PREVIEWS, read 2026-10-05. Nothing, almost. The full parameter
// table for POST /api/send-message (getting-started/sending-messages) is `number`, `from_number`,
// `content`, `media_url`, `app_card`, `send_style`, `status_callback`, `seat_id`, `reply_to` and
// `pre_reply_override` — there is no rich-link or link-preview parameter of any kind. The only
// sentence about link previews anywhere in their documentation is in guides/contact-card, about
// getting the recipient to save the sender as a contact: "it allows any links you send to expand
// on the end users phone". So whether a bare URL becomes a card is Apple's doing, on the
// recipient's device, and is conditioned on something Reason does not control.
//
// `app_card` is NOT that path and was checked rather than assumed: api-v2/app-cards requires
// `extensionBundleId`, a ten-character Apple `teamId` and a Messages extension the recipient has
// installed. Reason has no iOS app and no Apple Team ID, so an App Card cannot be sent at all.
//
// Therefore: the URL goes out bare, on its own, and NOTHING here claims a preview card. Whether
// one appears is unproved and only a real iPhone can settle it — see docs/iphone-checklist.md and
// docs/unverified.md. The prompt tells the model the split happens so it writes for it, and never
// to promise a card.
//
// The same regex as src/parts.js finds the links, and that is correct: whether a literal string
// starting with http is present is a fact, not a reading of what anybody meant.

/** Same pattern as parts.urlsIn. `)` and `'` are already excluded, so they cannot end a URL. */
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
/**
 * Punctuation that ended a sentence rather than the address. "have a look at https://x.com/a." is
 * a link and a full stop, and sending the full stop as part of the URL breaks the tap. Trimmed for
 * the bubble only; parts.urlsIn is left exactly as it was, because what it needs is whether a link
 * is present, and a trailing dot does not change that.
 */
const SENTENCE_END = /[.,;:!?\]}"]+$/;
/** What is left of a summary once the link is gone, when it is only joining punctuation. */
const ONLY_PUNCTUATION = /^[\s.,;:!?\-–—()[\]{}"']*$/;

/**
 * Tidy the words around a link WITHOUT flattening them.
 *
 * This used to be `.replace(/\s+/g, " ")`, which collapsed newlines along with spaces — so a reply
 * written as three paragraphs with a link under them arrived as one unbroken slab, and the longest
 * message Reason routinely sends was the worst-looking one. Omari spotted it on his phone on
 * 2026-10-05 ("it feels chunky"). Four attempts to fix it in the prompt failed, because the model
 * had been writing the paragraphs correctly the whole time and this function was eating them.
 *
 * So: runs of spaces and tabs collapse, trailing spaces on a line go, three or more newlines become
 * one blank line — and a blank line the model wrote stays a blank line.
 */
function tidy(s) {
  let t = String(s ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Punctuation stranded at the front once the link it belonged to is gone. Never touched when the
  // text opens a list, because "- eggs" starts with a dash on purpose.
  if (!/^[-*]\s/.test(t)) t = t.replace(/^[.,;:!?\-–—\s]+/, "").trim();
  return ONLY_PUNCTUATION.test(t) ? "" : t;
}

/**
 * How the words before a link join the words after it.
 *
 * A link on a line of its own separates two blocks of prose, and they stay two blocks. A link in
 * the middle of a sentence ("grab it at https://x.com before friday") is one sentence with a hole
 * in it, and closing that hole with a blank line would break the sentence in half.
 */
function seam(before, after) {
  if (!before.trim() || !after.trim()) return " ";
  return /\n[ \t]*$/.test(before) && /^[ \t]*\n/.test(after) ? "\n\n" : " ";
}

/** Words that end on a colon are introducing what follows them. A fact about the characters. */
const POINTS_AHEAD = /[:\uFF1A]$/;

/**
 * One message Reason wrote → the messages it actually goes out as, in order.
 *
 * No link means one element, the text exactly as it was: the overwhelmingly common reply is
 * untouched by this, and that is deliberate.
 *
 * With links, the order is link, its words, link, its words. The words that belong to a link are
 * the ones written between it and the link before it — prose introduces the link that follows it
 * ("here's the table", "option b") — plus, for the last link only, everything written after it.
 * Each pair stays in its own pair, so a summary can never end up under the wrong link.
 *
 * One exception, and it is about punctuation rather than meaning: words that END ON A COLON are
 * pointing at what comes next ("Privacy policy:", "here's the page:"). Lifting the link above them
 * leaves a bubble that ends on a colon with nothing under it, which is what a real thread showed on
 * 2026-10-06. That pair goes out the other way round — the words, then the link — and anything
 * written after the last link follows it as its own message.
 */
export function linkParts(text) {
  const s = String(text ?? "");
  const found = [];
  for (const m of s.matchAll(URL_RE)) {
    const whole = m[0];
    const url = whole.replace(SENTENCE_END, "");
    // Nothing but a scheme once the punctuation is off ("https://."). Not a link; left in the prose.
    if (!/^https?:\/\/[^\s/.]+[^\s]*$/i.test(url)) continue;
    found.push({ url, start: m.index, end: m.index + whole.length });
  }
  if (!found.length) {
    const one = s.trim();
    return one ? [one] : [];
  }

  const out = [];
  let cursor = 0;
  found.forEach((f, i) => {
    const before = s.slice(cursor, f.start);
    const after = i === found.length - 1 ? s.slice(f.end) : "";
    const lead = tidy(before);
    if (POINTS_AHEAD.test(lead)) {
      out.push(lead, f.url);
      const rest = tidy(after);
      if (rest) out.push(rest);
    } else {
      out.push(f.url);
      const summary = tidy(`${before}${seam(before, after)}${after}`);
      if (summary) out.push(summary);
    }
    cursor = f.end;
  });
  return out;
}

/** Is this a message that leaves as more than one? Read by the tests and by the delivery layer. */
export const splitsForLinks = (text) => linkParts(text).length > 1;
