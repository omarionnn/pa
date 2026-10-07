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
