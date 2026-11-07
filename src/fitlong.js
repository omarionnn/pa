// A note that runs over its length cap is kept, shortened, and the model is told — never refused.
//
// The incident, 2026-10-31 to 11-07: timer_set's `note` (then at most 500 characters) was refused
// three times in a week as "Bad input: note: String must contain at most 500 character(s)". Each
// refusal cost a retry, and a retry that still ran long lost the reminder. The cap on timer notes is
// raised (storage is TEXT); this is for the fields whose cap stays: a field that is Reason's own
// words to itself — a note, a summary, why, what they said as evidence — loses its tail at a word
// boundary with an ellipsis, and the tool result says which fields were shortened.
//
// Only those fields. Anything that goes out of this machine word for word (a text, a caption, an
// email body, a query), anything that names a thing (an id, a url, a phone number, an address) or
// quotes something exactly (verbatim, exactly_as_asked) is never cut: there a refusal is the honest
// answer, because a cut one would be a different thing.

/** Field names whose content is Reason's own description, safe to shorten. */
export const SOFT_TEXT = new Set([
  "note", "notes", "said", "summary", "help", "why", "why_now", "urgent_why",
  "their_words", "route_description", "inference", "tradeoff", "turned_down", "source_note",
]);
// Never `what` or `detail`: store_checkout's `what` is the instruction the store's agent buys from, and
// a card's `detail` is what tells two options apart (src/choicecards.js). A cut one is a different order.

/** `text` cut to at most `max` characters, at a word boundary, ending in an ellipsis. */
export function shortenAt(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const room = Math.max(1, max - 1); // one for the ellipsis
  let cut = s.lastIndexOf(" ", room);
  if (cut < room * 0.6) cut = room; // one long word: cut inside it rather than lose most of the note
  return s.slice(0, cut).replace(/[\s,;:.\-–—]+$/, "") + "…";
}

/**
 * Fit `raw` to `schema` by shortening only the soft text fields that are too long.
 *
 * Returns `{ input, shortened }`: `input` is `raw` untouched when nothing needed cutting (or when
 * something other than a too-long soft field is wrong — the normal refusal then says so), and
 * `shortened` lists `{ field, from, to }` for every cut made.
 */
export function fitLongText(schema, raw) {
  if (!schema || !raw || typeof raw !== "object") return { input: raw, shortened: [] };
  const first = schema.safeParse(raw);
  if (first.success) return { input: raw, shortened: [] };
  const issues = first.error.issues;
  const soft = issues.filter(i => i.code === "too_big" && i.type === "string"
    && SOFT_TEXT.has(String(i.path[i.path.length - 1])));
  if (!soft.length) return { input: raw, shortened: [] };
  const input = structuredClone(raw);
  const shortened = [];
  for (const i of soft) {
    let holder = input;
    for (const k of i.path.slice(0, -1)) holder = holder?.[k];
    const key = i.path[i.path.length - 1];
    if (!holder || typeof holder[key] !== "string") continue;
    const from = holder[key].length;
    holder[key] = shortenAt(holder[key], i.maximum);
    shortened.push({ field: i.path.join("."), from, to: holder[key].length });
  }
  return { input, shortened };
}

/** The line put on the tool result when something was shortened. */
export function shortenedNote(shortened) {
  return "Shortened to fit, not refused: "
    + shortened.map(s => `${s.field} (${s.from} → ${s.to} characters, cut at a word with "…")`).join("; ")
    + ". The rest of the input went through as given. Do not repeat the call just to resend the cut part.";
}
