// Reply threading: it is never unclear what a reply is about (owner spec, 2026-11-10).
//
// Most of this was already built before this file: a burst of texts is one turn (the quiet window,
// config.burstQuietMs, plus the mid-turn fold-in in src/onethought.js), an inline reply is read
// against its thread (replies.inboundReplyLine), a reply to a text the thread has moved past is
// pinned under it (replies.answerTarget), a job's late result is pinned under the text that started
// it (replies.latePin), and several unrelated texts get an answer each (replies.burstLine).
//
// What this adds, behind REASON_THREADING (off | owner | on; default off):
//
//   1. Tapbacks that DO arrive. Sendblue documents no inbound reaction, and almost none arrive —
//      but its messages API showed one live (2026-11-06) as an ordinary message with
//      `is_reaction: true` and Apple's own text for it: `Loved “<the words of the message>”`. No
//      handle of the target. So the target is found by those quoted words, the way a pin is
//      (replies.findByQuote), and the turn is told what it is. Whether the target was a yes/no
//      question, and so whether the tapback answers it, is the model's to read — never code's.
//   2. One send, numbered. A message with two photos arrives as parts H, H_1, H_2 (src/parts.js),
//      held as separate rows. They are one message: counted as one in the burst line, and their
//      attachments are numbered in the order sent (photo 1, photo 2) so "the second photo" means
//      one thing.
//   3. Jobs still running, each with the text that started it, so "is it done?" or "the lisbon
//      one" points at one job and its origin.
//   4. Rules in the system prompt (threadingRules): the order referents are resolved in, one
//      question when two candidates fit equally, the later text wins a conflict and says so, older
//      items named concretely rather than "above", list numbers kept stable.
//
// What Sendblue cannot carry, checked against its docs and 500 real inbound messages: edits,
// unsends, and the target handle of a tapback. Nothing here pretends otherwise.
import * as db from "./db.js";
import { snippet } from "./replies.js";

/** off | owner | on. Read on every call so a restart is the only thing a flip needs. */
export function threadingMode() {
  const v = String(process.env.REASON_THREADING ?? "off").trim().toLowerCase();
  return v === "on" || v === "owner" ? v : "off";
}

/** Is it on for this conversation? `isOperator` is the owner's thread. */
export function threadingOn({ isOperator = false } = {}) {
  const m = threadingMode();
  return m === "on" || (m === "owner" && !!isOperator);
}

// Apple's fixed wording for a tapback, as it reaches a phone that cannot draw one. A grammar of a
// machine format, like a phone number — not a reading of what anybody meant.
const VERBS = [
  ["Loved", "love", "❤️"], ["Liked", "like", "👍"], ["Disliked", "dislike", "👎"],
  ["Laughed at", "laugh", "😂"], ["Emphasized", "emphasize", "‼️"], ["Questioned", "question", "❓"],
];
const QUOTED = /^[“"](.*)[”"]\s*$/s;

/**
 * `Loved “see you at 8?”` → { kind: "love", emoji: "❤️", quoted: "see you at 8?", removed: false }.
 * Also `Reacted 🔥 to “…”` and the `Removed a heart from “…”` family. Null when it is not that shape.
 */
export function parseReaction(content) {
  const s = String(content ?? "").trim();
  for (const [verb, kind, emoji] of VERBS) {
    if (s.startsWith(`${verb} `)) {
      const q = QUOTED.exec(s.slice(verb.length + 1));
      if (q) return { kind, emoji, quoted: q[1].trim(), removed: false };
    }
  }
  let m = /^Reacted (\S+) to (.*)$/s.exec(s);
  if (m) { const q = QUOTED.exec(m[2]); if (q) return { kind: "emoji", emoji: m[1], quoted: q[1].trim(), removed: false }; }
  m = /^Removed an? (\S+(?: \S+)?) from (.*)$/s.exec(s);
  if (m) { const q = QUOTED.exec(m[2]); if (q) return { kind: "removed", emoji: m[1], quoted: q[1].trim(), removed: true }; }
  return null;
}

/** Apple shortens a long target with "…"; the words before it are the pointer. */
function pointerOf(quoted) {
  return String(quoted ?? "").replace(/(\.\.\.|…)\s*$/, "").trim().slice(0, 80);
}

/**
 * The line a turn reads when what arrived is a tapback rather than words.
 *
 * Code says what it is and which message it is on; the model reads whether that message asked a
 * yes/no question. A tapback on anything else is acknowledged silently (NO_REPLY), which is what
 * a person does with a heart on "here's the link".
 */
/** Curly quotes and runs of whitespace are the same thing typed two ways (as replies.js reads them). */
function plain(s) {
  return String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

/**
 * The message a tapback is on: the most recent one in this thread, theirs or Reason's, whose words
 * start with (or contain) what Apple quoted — never the tapback's own row, which quotes it too.
 */
export function targetOf(conversationId, quoted, { self = null } = {}) {
  const q = plain(pointerOf(quoted));
  if (q.length < 3) return null;
  const recent = db.recentMessages(conversationId).filter(m => m.handle && m.handle !== self);
  return recent.find(m => plain(m.text).startsWith(q)) ?? recent.find(m => plain(m.text).includes(q)) ?? null;
}

export function reactionLine(conversationId, content, { self = null } = {}) {
  const r = parseReaction(content);
  if (!r) return "[this arrived as a tapback, not a typed message, and its wording could not be read. a tapback needs no answer unless it plainly answers a yes/no question you just asked: otherwise reply exactly NO_REPLY]";
  if (r.removed) return `[this is them taking a tapback back off a message, not a typed message. it needs no answer: reply exactly NO_REPLY]`;
  const hit = targetOf(conversationId, r.quoted, { self });
  const on = hit
    ? `${hit.from === "reason" ? "your" : "their own"} message "${snippet(hit.text)}"`
    : `a message starting "${snippet(r.quoted, 60)}" (not found in this thread's record)`;
  return `[this is a tapback, not a typed message: they put a ${r.emoji} (${r.kind}) on ${on}.`
    + " if that message of yours asked them a yes/no question and nothing since has answered it, a 👍 like means yes and a 👎 dislike means no:"
    + " act on that answer exactly as if they had typed it, and say in a few words what you took it as. a ❤️ or ‼️ on such a question also reads as yes; a ❓ means they are unsure, so ask one short question."
    + " a tapback on anything else needs no answer at all: reply exactly NO_REPLY]";
}

/** The base of a multi-part handle (H_1 → H). Sendblue only; see sendblue.js splitHandle. */
export function baseOf(channel, handle) {
  const h = String(handle ?? "");
  if (channel !== "sendblue") return h;
  const m = /^(.+)_(\d+)$/.exec(h);
  return m ? m[1] : h;
}

/** Held rows → one entry per thing they sent, in order: { base, rows }. */
export function sendsOf(held) {
  const out = [];
  for (const h of held) {
    const base = baseOf(h.channel, h.external_id);
    const last = out.at(-1);
    if (last && last.base === base) last.rows.push(h);
    else out.push({ base, rows: [h] });
  }
  return out;
}

const NOUN = { image: "photo", video: "video", voice: "voice note", audio: "audio file", pdf: "PDF", contact: "contact card", file: "file" };

/**
 * One send with two or more attachments → the numbering the model and they will both use.
 * "photo 1, photo 2, PDF 1 (lease.pdf)". Empty for a send with fewer than two.
 */
export function attachmentLine(rows) {
  const all = rows.flatMap(r => r.attachments ?? []);
  if (all.length < 2) return "";
  const n = {};
  const names = all.map(a => {
    const noun = NOUN[a?.kind] ?? "file";
    n[noun] = (n[noun] ?? 0) + 1;
    const file = a?.kind === "pdf" || a?.kind === "file" ? (a?.filename ? ` (${snippet(a.filename, 40)})` : "") : "";
    return `${noun} ${n[noun]}${file}`;
  });
  return `[one message from them with ${all.length} attachments, numbered in the order they sent them: ${names.join(", ")}. it is ONE message, not several. use these numbers when you refer to them, and read "the second one" against this order]`;
}

/** Jobs still running, each with the text that started it. Empty with none open. */
export function jobsLine(conversationId, { limit = 5 } = {}) {
  let tasks = [];
  try { tasks = db.listTasks(conversationId).filter(t => t.open !== false).slice(0, limit); } catch { return ""; }
  if (!tasks.length) return "";
  const items = tasks.map(t => {
    const origin = t.origin_handle ? db.messageByHandle(conversationId, t.origin_handle) : null;
    const from = origin?.text ? ` — started by their "${snippet(origin.text, 70)}"` : "";
    return `#${t.id} ${snippet(t.label || t.title || "job", 50)}${from}`;
  });
  return `[jobs still running, each with the text that started it: ${items.join(" / ")}. a result for one goes under the text that started it]`;
}

/** The prompt block, for the owner's thread (or everyone) when the flag says so. */
export function threadingRules(me) {
  if (!threadingOn({ isOperator: typeof me === "object" ? me?.isOperator : false })) return "";
  return `
- Which message a reply is about is never left for them to work out. The rules for that follow.
- Texts they sent in a row before you answered are one turn: read all of them before you act. If two of them contradict each other, the later one wins, and you say which you went with in one short clause ("going with friday, from your second text").
- Work out what each thing they point at is, in this order. 1) a bracketed note that it was an inline reply: that message, however old. 2) a concrete reference — a name, a number, a date, a quote ("the lisbon flight", "#2", "the PDF from monday"): find that exact thing, and when it is not in view, search the whole history for it with memory_search before you say anything. 3) "this", "that one", "it": the most recent thing of the matching kind (the last photo for "this photo", the last link for "that link"). 4) a pick like "the second one": the most recent list YOU sent, in its original numbering.
- When two things fit equally well, ask ONE short question that names both ("the 7pm lisbon one or the 9am porto one?"). Never guess between them.
- A voice note is what was said in it. When you refer back to one, name it by its first few words ("your voice note that starts 'so about friday'").
- When you mention an older item, name it concretely: "the blue jacket photo you sent sunday", "the lease PDF from monday". Never "above", "earlier", "the previous message", "what you sent before".
- Number every list you send. Keep the numbers stable: item 2 is item 2 for as long as that list is being talked about, even if you show it again or one drops out.
- Two separate questions from them get two separate replies, each pinned under its own text (reply_to + message_send for the earlier one). When the thread cannot carry a pin, open each answer with a few of their words in quotes so it is plain which one it answers.`;
}

/** The tapback rule in the base prompt, as it reads with this on: a tapback that arrives is real. */
export const TAPBACK_RULE_ON = "- Tapbacks mostly do not reach you. When one does, it arrives with a bracketed note that says so and which message it is on: read it by that note. Without such a note you have not seen one, so never say you noticed a tapback, and never ask somebody to react instead of replying.";
