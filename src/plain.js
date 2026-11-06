// What a message Reason wrote looks like by the time it reaches a phone.
//
// Three guarantees, all of them enforced here in code rather than asked of the model, for the same
// reason the link split is (src/links.js): a rule that only holds when the model remembers it does
// not hold. The prompt asks for all three as well, because a model writing FOR this layer writes
// better text than one whose output is being repaired — but the prompt is the polish and this is
// the floor.
//
//   1. No markdown markers. A text thread renders none of them, so `**grind finer**` arrives as
//      four asterisks and a `| price | 499 |` table arrives as pipes. They are taken off here, on
//      the way out, for any channel that does not say it renders them — which is every channel
//      Reason has. Conservatively: `report_final_v2.txt`, `2 * 3`, `C#`, a snake_case name and an
//      emoji all come out exactly as they went in. See `plainText`.
//   2. Anything meant to be pasted leaves as its own message, whole. The model marks it with a
//      plain fenced block; the fence comes off, the inside is untouched, and it is the only thing
//      in that bubble. Commentary written around it goes out as its own message either side, so
//      press-and-hold on a phone copies the prompt and not "here you go, just fill in the
//      brackets:" along with it.
//   3. A cap on how many bubbles one message becomes, so an answer does not arrive as a thread of
//      fragments. The overflow is MERGED, never dropped — and the cap yields rather than break
//      guarantee 2 or bury a link, which is the one case it will not fix. See `capped`.
//
// WHAT THIS DOES NOT DO. It does not reformat an answer: no reflowing, no re-wrapping, no bullets
// invented out of sentences, no sentences invented out of bullets. Writing the reply is the model's
// job and the prompt is where that is asked for. This takes off what a phone cannot draw and
// decides which bubble each piece goes in, and nothing else.
import { config } from "./config.js";
import { linkParts } from "./links.js";

/** What a bubble is. `link` is a bare URL, `copy` is something to paste, `text` is everything else. */
export const TEXT = "text";
export const LINK = "link";
export const COPY = "copy";

/**
 * A fenced block: ``` on its own line, the content, ``` on its own line. The info string after the
 * opening fence (```js) is part of the fence and never part of what gets pasted.
 *
 * Deliberately requires both fences at the start of a line. A stray ``` inside a sentence is not a
 * block, and an opener with no closer is left as prose rather than guessed at — taking everything
 * after an unclosed fence as paste-able would put Reason's own commentary inside the thing somebody
 * copies, which is the exact failure this is here to prevent.
 */
const FENCE = /^[ \t]{0,3}`{3,}[^\n]*\n([\s\S]*?)^[ \t]{0,3}`{3,}[ \t]*$/gm;
/** A fence line with no partner, info string and all. Removed; its content stays as prose. */
const LONE_FENCE_LINE = /^[ \t]{0,3}`{3,}[^\n]*$/gm;
/** Same pattern as links.js and parts.js: whether a literal http string is there is a fact. */
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
/** A bubble that is a bare URL and nothing else — the one links.js pulls out for the tap. */
const URL_ONLY = /^https?:\/\/[^\s<>"')]+$/i;

// A markdown table's second line, which is the only thing that makes the first line a header
// rather than a sentence with a pipe in it: |---|:--:|---|. Both the header and the rows have to
// open with a pipe too. Three signals, because the cost of a false positive here is a rewritten
// paragraph.
const DELIMITER_ROW = /^[ \t]*\|[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;
const TABLE_ROW = /^[ \t]*\|.*\|?[ \t]*$/;

/** One markdown table row to its cells. `\|` is an escaped pipe and stays a pipe. */
function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map(c => c.replace(/\\\|/g, "|").trim());
}

/**
 * Markdown tables to something readable held in one hand.
 *
 * A table on a phone is the worst case of all of them: pipes do not line up in a proportional
 * font, so a three-column comparison arrives as noise. Each row becomes its first cell on a line
 * of its own with the rest as "column: value" under it, which is what the same information looks
 * like when a person says it. A table that is genuinely worth being a table belongs on a page, and
 * the prompt says so — this is the backstop for when one is written in a text anyway.
 */
function tables(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const isTable = TABLE_ROW.test(lines[i]) && lines[i].includes("|")
      && i + 2 <= lines.length - 1 && DELIMITER_ROW.test(lines[i + 1]) && TABLE_ROW.test(lines[i + 2]);
    if (!isTable) { out.push(lines[i]); continue; }
    const columns = cells(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && TABLE_ROW.test(lines[j]) && lines[j].includes("|"); j++) rows.push(cells(lines[j]));
    const blocks = rows.map(r => {
      const head = r[0] || "";
      const rest = r.slice(1)
        .map((c, k) => (c ? `${columns[k + 1] ? `${columns[k + 1]}: ` : ""}${c}` : ""))
        .filter(Boolean);
      return [head, ...rest].filter(Boolean).join("\n");
    }).filter(Boolean);
    out.push(blocks.join("\n\n"));
    i = j - 1;
  }
  return out.join("\n");
}

/**
 * Run `fn` over everything that is not a URL, and leave the URLs exactly as they are.
 *
 * Because an address is not prose: https://en.wikipedia.org/wiki/Trip_hop has an underscore in it
 * that is part of the address, and https://x.com/a*b* is still a link. A marker-stripping pass
 * loose on a URL breaks the tap, which is the one thing about a link that matters.
 */
function outsideUrls(text, fn) {
  const out = [];
  let cursor = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    out.push(fn(text.slice(cursor, m.index)), m[0]);
    cursor = m.index + m[0].length;
  }
  out.push(fn(text.slice(cursor)));
  return out.join("");
}

/**
 * Emphasis and code markers off, conservatively.
 *
 * Every rule here needs the marker to be where a marker goes and nowhere else: `**` is only a
 * marker when the character before it is not a word character and the thing inside it does not
 * start or end with a space. That is what keeps `my_file_v2.txt`, `2 * 3 = 6`, `a*b`, `snake_case`
 * and `**` on its own out of it. Emphasis is single-line only (`[^*\n]`), because a `*` opening on
 * one line and another three paragraphs later is two separate asterisks, not italics.
 */
function markers(s) {
  return s
    // Any run of three or more backticks: a stray fence, or one written inline. Never text.
    .replace(/`{3,}/g, "")
    .replace(/(?<![\w*])\*\*(?=\S)([\s\S]*?\S)\*\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, "$1")
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

/** A numbered step at the start of a line: "1. ", "12) ". Never "1999." inside a sentence. */
const NUMBERED_ITEM = /^[ \t]{0,3}\d{1,2}[.)][ \t]+\S/;

/**
 * A blank line between numbered steps.
 *
 * Omari, reading a jollof recipe on his phone on 2026-10-05: eight steps, several of them wrapping
 * onto three lines, with nothing between them. Where one step ends and the next begins stops being
 * obvious and the whole thing reads as a paragraph with digits in it. A line of space fixes it, and
 * it is the kind of thing a model does right four times and forgets on the fifth, so it is done
 * here as well as asked for in the prompt.
 *
 * One rule, and it is the whole function: a step that has a non-blank line above it gets a blank
 * line put in. That covers both gaps that matter — between two steps, and between the lead-in
 * ("here's the order:") and the first one — and it is a no-op on a list already written with
 * spacing, which is most of them. The continuation lines of a step are above their OWN step and
 * below the next one, so they stay where they belong.
 *
 * Bullets are deliberately untouched: a three-item bullet list reads fine tight, and spacing it out
 * makes a short answer look long. Nothing here runs on a fenced block — those never reach this
 * function, so a numbered prompt somebody pastes elsewhere comes out exactly as it was written.
 */
function spacedSteps(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (NUMBERED_ITEM.test(line) && out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(line);
  }
  return out.join("\n");
}

/**
 * A first line that is the model's read of the message rather than its reply to it.
 *
 * Omari texted "You're so smart" on 2026-10-06 and got, as the first line of the answer, "A
 * compliment, so I'll just talk back. Short." — the prompt's own rule about compliments, recited
 * to him, followed by the actual reply. The thinking leaked into the bubble.
 *
 * What is taken off, and only this: a FIRST paragraph that is one line, short, followed by more
 * text, written in the first person about Reason's own next move (talk back, answer, keep it
 * short, not steer) and not addressed to them at all — no "you" or "u" in it. "i'll check and get
 * back to you" is kept (it is to them); a one-paragraph reply is kept whatever it says (there is
 * nothing after it that could be the real answer); "haha stop" is kept. When it fires it is logged
 * by the caller, because the real fix is the prompt and this is the floor under it.
 */
const SELF_NOTE_MOVE = /\b(talk back|just answer|just reply|keep (it|this) short|keep it light|not steer|no pitch|just chat|short reply|one line|brief)\b/i;
const SELF_NOTE_SELF = /\b(i'?ll|i will|i'?m going to|i should|so i just|i just)\b/i;
const SELF_NOTE_READ = /^(a|an|just|this is|that's|that is|they'?re|they are|compliment|small talk|casual|a vent|venting|banter)\b/i;
export function withoutSelfNote(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const cut = s.indexOf("\n");
  if (cut < 0) return { text: s, dropped: null };
  const first = s.slice(0, cut).trim();
  const rest = s.slice(cut).trim();
  if (!rest || first.length > 110) return { text: s, dropped: null };
  if (/\b(you|u|ur|your)\b/i.test(first)) return { text: s, dropped: null };
  // A line that announces a move and then makes it ("i'll keep it short: lisbon wins") carries the
  // answer; a note to self ends with a full stop and nothing follows on the line.
  if (first.includes(":") || !/\.\s*$/.test(first)) return { text: s, dropped: null };
  const aboutMyMove = SELF_NOTE_SELF.test(first) && SELF_NOTE_MOVE.test(first);
  const aRead = SELF_NOTE_READ.test(first) && /\bso\b/i.test(first) && /[.]\s*(short\.|brief\.)?$/i.test(first);
  if (!aboutMyMove && !aRead) return { text: s, dropped: null };
  return { text: rest, dropped: first };
}

/**
 * The model's "say nothing", however it was written.
 *
 * Every event prompt asks for "exactly NO_REPLY", and both backends used to check for exactly
 * that: `reply === "NO_REPLY"` on the CLI path, `reply.trim() === "NO_REPLY"` on the API path. A
 * model does not always write exactly anything. "NO_REPLY." , "**NO_REPLY**" and a real line with
 * NO_REPLY tacked on underneath all failed the check, and the marker itself was texted to them —
 * an internal word, in their thread, from something that had decided to be quiet (audit,
 * 2026-10-18). So:
 *
 *   - a reply that is the marker and nothing but punctuation around it is silence;
 *   - a reply whose FIRST line is the marker is silence: it decided to be quiet and then said why,
 *     and the why is a note to itself, not a text;
 *   - a real reply with the marker on its own last line is the real reply, marker off.
 *
 * A marker anywhere else — a middle line, inside a sentence — is not this function's call: it is
 * taken off at the last step before anything is sent (withoutNoReply, below).
 */
const SILENCE_LINE = /^\W*NO_REPLY\W*$/;
export function readSilence(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!s) return { text: "", silent: true, stripped: false };
  const lines = s.split("\n");
  if (SILENCE_LINE.test(lines[0].trim())) return { text: "", silent: true, stripped: lines.length > 1 };
  let stripped = false;
  while (lines.length && (SILENCE_LINE.test(lines.at(-1).trim()) || !lines.at(-1).trim())) {
    if (lines.at(-1).trim()) stripped = true;
    lines.pop();
  }
  return { text: stripped ? lines.join("\n").trim() : s, silent: false, stripped };
}

/**
 * The silence marker taken off a message at the last step before it goes to a person — the one
 * place that decides it, called by every outbound path (src/deliver.js, src/outbox.js,
 * src/channels/router.js sendNow and sendMediaUrl).
 *
 * readSilence above reads a whole reply: marker first means quiet, marker last is dropped. It used
 * to leave a marker on a middle line or inside a sentence alone as "prose" (#43, 2026-10-18). No
 * case was ever behind that: nothing Reason does has a reason to text the word NO_REPLY to anybody,
 * and when the model writes it mid-reply it is the marker leaking, not a sentence about it. So here
 * it comes off wherever it stands as a word of its own, in capitals, bold or not ("**NO_REPLY**").
 *
 * What is NOT the marker, and stays exactly as written: anything the token is part of — a link, an
 * address, an identifier (it follows `= / ? & @ . _ -`, a letter or a digit, or is followed by `@`,
 * a letter, a digit, `_`, or `.`/`-`/`/` and more of a word) — and anything in a code span or a
 * fenced code block, which is text to copy, not words from Reason. "no reply" in ordinary words stays.
 *
 * Tidied only where the marker was: the spaces round it, and a line it leaves with nothing on it
 * (or only a list marker like "2." or "-") goes, with the blank line it would leave doubled. No
 * other line is trimmed, re-indented or re-spaced. `empty` is true when nothing worth sending is
 * left — the caller then sends nothing. `path` names the caller in the `no_reply_stripped` log
 * line, which never carries the message.
 */
const NO_REPLY_WORD = /([ \t]*)(\**)NO_REPLY(\**)([ \t]*)/g;
const MEANINGFUL = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const PART_OF_SOMETHING_BEFORE = /[=/?&@._\-\p{L}\p{N}]/u;
const LIST_MARKER_ONLY = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]*\r?$/;
const blank = (l) => !l.replace(/\r$/, "").trim();
function codeRanges(s) {
  const ranges = [];
  const fence = /```[\s\S]*?(?:```|$(?![\s\S]))/g;
  for (let m; (m = fence.exec(s));) ranges.push([m.index, m.index + m[0].length]);
  const inFence = (i) => ranges.some(([a, b]) => i >= a && i < b);
  const inline = /`[^`\n]*`/g;
  for (let m; (m = inline.exec(s));) if (!inFence(m.index)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
export function withoutNoReply(text, { path = null, log = null } = {}) {
  const s = String(text ?? "");
  if (!s.includes("NO_REPLY")) return { text: s, stripped: false, empty: false };
  const code = s.includes("`") ? codeRanges(s) : [];
  const inCode = (i) => code.some(([a, b]) => i >= a && i < b);
  let stripped = false;
  const out = [];
  let offset = 0;
  let removedJustNow = false; // the line before this one was taken out
  for (const line of s.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const next = line.replace(NO_REPLY_WORD, (m, lead, open, close, trail, at) => {
      const token = at + lead.length + open.length;
      if (inCode(lineStart + token)) return m;
      // The character just before the marker (or before its bold) and just after it.
      const before = lead ? " " : line[at - 1];
      const afterAt = token + "NO_REPLY".length + close.length;
      const after = trail ? " " : line[afterAt];
      if (before !== undefined && PART_OF_SOMETHING_BEFORE.test(before)) return m;
      if (after !== undefined && !trail) {
        if (/[\w@]/.test(after)) return m;
        if (/[.\-/]/.test(after) && /\w/.test(line[afterAt + 1] ?? "")) return m;
      }
      stripped = true;
      const end = at + m.length;
      const rest = line[end];
      // At the start of the line the indentation stays; at the end, or before punctuation, the
      // marker and its spaces just go; between two words it leaves one space.
      if (at === 0) return lead;
      return rest === undefined || rest === "\r" || /[.,!?;:)\]]/.test(rest) ? "" : " ";
    });
    if (next === line) {
      // A blank line straight after a removed line, with a blank (or nothing) before it, would be a
      // doubled gap that the removal made — that one goes.
      if (removedJustNow && blank(line) && (!out.length || blank(out.at(-1)))) { removedJustNow = false; continue; }
      removedJustNow = false;
      out.push(line);
      continue;
    }
    if (!MEANINGFUL.test(next.replace(/^[ \t]*\d+[.)][ \t]*$/, "")) || LIST_MARKER_ONLY.test(next)) { removedJustNow = true; continue; }
    removedJustNow = false;
    out.push(next);
  }
  if (!stripped) return { text: s, stripped: false, empty: false };
  // A removed line at the very end can leave the blank line that was before it as a trailing gap.
  if (removedJustNow) while (out.length && blank(out.at(-1))) out.pop();
  const rest = out.join("\n");
  const empty = !MEANINGFUL.test(rest);
  try { log?.({ no_reply_stripped: path ?? "unknown", ...(empty ? { dropped: true } : {}) }); } catch { /* a log line never costs a send */ }
  return { text: empty ? "" : rest, stripped: true, empty };
}

/**
 * One piece of prose, as a phone will actually draw it.
 *
 * Bullets and numbered lists are kept as lists on purpose: "- grind finer" and "1. unplug it" read
 * exactly as written in a text thread, and they are what the prompt asks for. A `*` bullet becomes
 * a `-` one, because that is the same list with a marker a phone does not understand. The one thing
 * decided here rather than left to the model is the blank line between numbered steps — spacing,
 * not structure. Nothing is reflowed, re-wrapped, invented or dropped.
 */
export function plainText(text) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(LONE_FENCE_LINE, "");
  // Markdown's two link forms. The address is kept whole and the words around it are kept, so the
  // link split still finds a bare URL and the sentence still reads: "[the 7:40 one](https://…)"
  // becomes "the 7:40 one https://…" and then two bubbles.
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");
  s = s.replace(/\[([^\]\n]*)\]\([ \t]*(https?:\/\/[^\s)]+)[ \t]*\)/g, (_, label, url) => (label.trim() ? `${label.trim()} ${url}` : url));
  s = tables(s);
  // Line-based, so they run before the URL-protected pass: a chunk that starts mid-line must not
  // look like the start of a heading to `^`.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  s = s.replace(/^([ \t]*)\*[ \t]+(?=\S)/gm, "$1- ");
  s = spacedSteps(s);
  s = outsideUrls(s, markers);
  return s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The message split on its fenced blocks, in order, with the fences gone.
 *
 * An empty fence is nothing to paste, so it is not a split: the fence goes and the prose either
 * side of it stays ONE piece of prose. Splitting there would turn one sentence into two bubbles
 * over a pair of backticks the model typed by accident.
 */
function fenceSegments(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  const segments = [];
  let prose = "";
  let cursor = 0;
  for (const m of s.matchAll(FENCE)) {
    prose += s.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const inner = m[1].replace(/\n+$/, "");
    if (!inner.trim()) continue;
    segments.push({ kind: TEXT, text: prose }, { kind: COPY, text: inner });
    prose = "";
  }
  segments.push({ kind: TEXT, text: prose + s.slice(cursor) });
  return segments;
}

/**
 * Keep one message to `max` bubbles by joining neighbours, never by losing any of them.
 *
 * Only two prose bubbles next to each other can be joined. A bare URL is not merged into anything,
 * because the whole point of its own bubble is that a phone may draw it as a card and that a tap
 * lands on it; and something to paste is not merged into anything, because commentary inside it is
 * commentary somebody pastes into ChatGPT.
 *
 * So the cap can be reached and sometimes it cannot — a reply with three things to paste in it is
 * four bubbles whatever this function does. In that case it yields: every part still goes out, in
 * order, and `over` says the cap did not hold so the delivery layer can log it. Shipping five
 * bubbles is a worse message; dropping the fifth is a worse product.
 */
export function capped(parts, max = config.maxBubbles) {
  const out = parts.slice();
  if (!(max > 0)) return { parts: out, over: false };
  while (out.length > max) {
    const i = out.findIndex((p, j) => p.kind === TEXT && out[j + 1]?.kind === TEXT);
    if (i < 0) break;
    out.splice(i, 2, { kind: TEXT, text: `${out[i].text}\n\n${out[i + 1].text}` });
  }
  return { parts: out, over: out.length > max };
}

/**
 * One message Reason wrote → the bubbles it actually leaves as, in order.
 *
 * `plain: false` is for a channel that says it renders markdown. Nothing Reason has does, and the
 * flag exists so that claim has to be made by an adapter rather than assumed here. The bubble
 * structure — fences out, links on their own, the cap — applies either way: it is about how a
 * thread reads, not about what renders.
 *
 * The ordinary reply is one bubble and comes back as one, which is deliberate.
 */
export function outgoingParts(text, { maxBubbles = config.maxBubbles, plain = true } = {}) {
  const parts = [];
  for (const seg of fenceSegments(text)) {
    if (seg.kind === COPY) { parts.push(seg); continue; }
    const cleaned = plain ? plainText(seg.text) : seg.text.trim();
    if (!cleaned) continue;
    // The link split, unchanged and still the thing that decides it: a bare URL, then its words.
    for (const p of linkParts(cleaned)) parts.push({ kind: URL_ONLY.test(p) ? LINK : TEXT, text: p });
  }
  return capped(parts, maxBubbles);
}

/** Just the strings, for a caller that only has to send them. */
export const outgoingTexts = (text, opts) => outgoingParts(text, opts).parts.map(p => p.text);

// ---------- the mark a repeating check's reply carries to be sent (src/series.js) ----------
// Here rather than in series.js so the deliver path can strip it without importing the scheduler.
export const SEND_MARK = "[send]";
const SEND_MARK_LEAD = /^\s*\[send\][ \t]*:?[ \t]*\n?/i;

/** The reply with the mark taken off when it starts with it; null when it does not. */
export function takeSendMark(reply) {
  const s = String(reply ?? "");
  const m = SEND_MARK_LEAD.exec(s);
  return m ? s.slice(m[0].length) : null;
}

/** Any outgoing text, with a stray leading mark taken off. Never changes a text without one. */
export function withoutSendMark(text) {
  const s = String(text ?? "");
  const taken = takeSendMark(s);
  return taken === null ? s : taken;
}
