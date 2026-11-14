// The call bank for the speaking brain (docs/calls-brain-first.md "Bank"): buckets of what a caller says
// in one turn, each with cues to recognise it fast and lines to say.
//   - kind "instant" (bucket A): a turn that needs no brain at all ("are you with me?", "thanks",
//     "give me a second"). A complete reply from the bank is said at once and no model is called.
//   - kind "opener" (bucket B): only a content-free opener is said; the brain continues from it
//     (./brainopener.js does the picking and the join).
// The bank is data: REASON_CALL_BRAIN_BANK names a JSON file of this shape (the one mined from the
// owner's own calls); without one, PLACEHOLDER_BANK below. Every line is checked as it loads, and any that
// could be a claim is dropped, so a bank file can never put a "done" or a fact in Reason's mouth.
import { readFileSync } from "node:fs";
import { saysDone } from "./cartesia.js";
import { NOT_IN_AN_OPENER } from "./brainopener.js";

/**
 * Shape: { version, buckets: [{ id, kind: "instant" | "opener", cues: [regex source, …] (whole-turn,
 * case-insensitive), max_words, lines: [{ text, continuation: "complete" | "continue" | "standalone",
 * delivery: { speed?, emotion?, pause_after_ms? } }] }] }. A placeholder, small on purpose, until the bank
 * mined from the owner's calls is loaded.
 */
export const PLACEHOLDER_BANK = {
  version: "placeholder-1",
  buckets: [
    { id: "presence_check", kind: "instant", max_words: 6, cues: ["^(?:hello|hey)?[\\s,]*(?:are\\s+you\\s+(?:still\\s+)?(?:there|with\\s+me)|you\\s+there|can\\s+you\\s+hear\\s+me|hello)\\s*[?.!]*$"],
      lines: [{ text: "Yeah, I'm here.", continuation: "complete" }, { text: "Of course, I'm here.", continuation: "complete" }, { text: "I'm with you.", continuation: "complete" }, { text: "Still here.", continuation: "complete" }] },
    { id: "greeting", kind: "instant", max_words: 6, cues: ["^(?:hi|hey|hello|yo)?[\\s,]*(?:reason)?[\\s,]*(?:how\\s+are\\s+you|how(?:'|’)?s\\s+it\\s+going|how\\s+you\\s+doing|what(?:'|’)?s\\s+up)(?:\\s+(?:today|tonight))?\\s*[?.!]*$"],
      lines: [{ text: "Doing well. How about you?", continuation: "complete" }, { text: "I'm good, thanks. You?", continuation: "complete" }, { text: "Good! What's on your mind?", continuation: "complete" }] },
    { id: "thanks", kind: "instant", max_words: 5, cues: ["^(?:ok(?:ay)?[\\s,]*)?(?:thanks|thank\\s+you|thx|appreciate\\s+it|cheers)(?:\\s+(?:so\\s+much|a\\s+lot|reason))?\\s*[.!]*$"],
      lines: [{ text: "Of course.", continuation: "complete" }, { text: "Anytime.", continuation: "complete" }, { text: "You got it.", continuation: "complete" }] },
    { id: "wait_ask", kind: "instant", max_words: 7, cues: ["^(?:um|uh|okay|ok|hold\\s+on)?[\\s,]*(?:give\\s+me\\s+(?:a|one)\\s+(?:sec(?:ond)?|minute|moment)|hold\\s+on|hang\\s+on|one\\s+sec(?:ond)?|just\\s+a\\s+(?:sec(?:ond)?|minute))\\s*[.!]*$"],
      lines: [{ text: "Take your time.", continuation: "complete", delivery: { speed: 0.95 } }, { text: "Sure, whenever you're ready.", continuation: "complete" }, { text: "Mm-hm, I'm here.", continuation: "complete" }] },
    { id: "repair", kind: "opener", cues: [], lines: [{ text: "Sorry,", continuation: "continue" }, { text: "Ah, sorry,", continuation: "continue" }, { text: "Sorry about that.", continuation: "standalone" }] },
    { id: "question", kind: "opener", cues: [], lines: [{ text: "So,", continuation: "continue" }, { text: "Hmm,", continuation: "continue" }, { text: "Okay, so", continuation: "continue" }] },
  ],
};

/** An instant line may be a presence, a greeting or thanks, never a claim, a number or a promise. */
// No number, no done-word, no promise, and never a bare yes or no (an answer to a question it has not checked).
const NOT_IN_AN_INSTANT = /\d|\b(?:done|booked|sent|submitted|scheduled|ordered|paid|confirmed|i(?:'|’)ll|i\s+will|it(?:'|’)s\s+(?:done|in|set))\b/i;
const BARE_YES_NO = /^\s*(?:yes|yeah|yep|yup|no|nope|nah)\s*[.!?]?\s*$/i;
export const lineSafe = (kind, text) => !!String(text ?? "").trim() && !saysDone(text) && (kind === "instant" ? !NOT_IN_AN_INSTANT.test(text) && !BARE_YES_NO.test(text) : !NOT_IN_AN_OPENER.test(text));

/** A bank, checked: bad cues and unsafe lines dropped, each counted. Never throws. */
/** The mined bank's kinds in this file's words: A = instant, B and fallback = opener, none = silent. */
const KIND = { instant: "instant", A: "instant", opener: "opener", B: "opener", fallback: "opener", none: "silent", silent: "silent" };
export function checkBank(raw) {
  const out = { version: String(raw?.version ?? ""), buckets: [], dropped: { lines: 0, cues: 0, buckets: 0 }, classify: null, fallback: null };
  // The mined bank's own recogniser (`classifier_js`: (text, reason's previous line, previous fragment) -> bucket id).
  if (typeof raw?.classifier_js === "string") {
    try { const m = { exports: {} }; new Function("module", "exports", raw.classifier_js)(m, m.exports); if (typeof m.exports.classify === "function") out.classify = m.exports.classify; }
    catch { out.dropped.cues++; }
  }
  for (const b of Array.isArray(raw?.buckets) ? raw.buckets : []) {
    const kind = KIND[b?.kind] ?? null;
    if (!kind || !b.id) { out.dropped.buckets++; continue; }
    if (kind === "silent") {
      const nudge = b.nudge_after_1_5s_silence?.text;
      out.buckets.push({ id: String(b.id), kind, cues: [], maxWords: 0, lines: [], nudge: nudge && lineSafe("instant", nudge) ? String(nudge) : "" });
      continue;
    }
    const cues = [];
    // Regex cues (the placeholder); the mined bank's cues are prose for people, and its classifier does the work.
    if (!out.classify) for (const c of Array.isArray(b.cues) ? b.cues : []) { try { cues.push(new RegExp(String(c), "i")); } catch { out.dropped.cues++; } }
    const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => { const ok = lineSafe(kind, l?.text); if (!ok) out.dropped.lines++; return ok; })
      .map(l => ({ text: String(l.text).trim(), continuation: l.continuation ?? l.cont ?? (kind === "instant" ? "complete" : "continue"), then: l.then ? String(l.then) : "", delivery: l.delivery ?? {} }));
    if (!lines.length) { out.dropped.buckets++; continue; }
    out.buckets.push({ id: String(b.id), kind, cues, maxWords: Number(b.max_words) || 8, lines });
    if (b.kind === "fallback") out.fallback = String(b.id);
  }
  return out;
}

/** The bucket for their turn: the bank's own classifier when it has one, else the regex cues; null when none fits. */
export function bucketFor(words, { history = [], use = bank() } = {}) {
  const t = String(words ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (use.classify) {
    const msgs = (history ?? []).filter(m => String(m?.content ?? "").trim());
    const prevReason = String([...msgs].reverse().find(m => m.role === "assistant")?.content ?? "");
    const lastTwo = msgs.slice(-2);
    const prevFragment = lastTwo.length === 2 && lastTwo[0].role === "user" ? String(lastTwo[0].content) : "";
    let id = null;
    try { id = use.classify(t, prevReason, prevFragment); } catch { id = null; }
    return use.buckets.find(b => b.id === id) ?? use.buckets.find(b => b.id === use.fallback) ?? null;
  }
  const n = t.split(" ").length;
  return use.buckets.find(b => b.kind === "instant" && n <= b.maxWords && b.cues.some(re => re.test(t))) ?? null;
}

/** A line from a bucket, never one of the last three said on the call. */
export function lineFrom(b, recent = [], { random = Math.random } = {}) {
  const fresh = b.lines.filter(l => !recent.slice(-3).includes(l.text));
  const from = fresh.length ? fresh : b.lines;
  const line = from[Math.floor(random() * from.length) % from.length];
  recent.push(line.text);
  return line;
}

/** Bucket B: the bank's opener for their turn, or null (no bank classifier, or not an opener bucket). */
export function bankOpener(words, { history = [], recent = [], use = bank() } = {}) {
  if (!use.classify) return null;
  const b = bucketFor(words, { history, use });
  if (!b || b.kind !== "opener") return null;
  const l = lineFrom(b, recent);
  return { bucket: b.id, text: l.text };
}

let loaded = null;
/** The bank in use: REASON_CALL_BRAIN_BANK's file, else the placeholder. Read once. */
export function bank({ path = process.env.REASON_CALL_BRAIN_BANK, log = () => {} } = {}) {
  if (loaded && loaded.path === (path ?? "")) return loaded.bank;
  let raw = PLACEHOLDER_BANK;
  if (path) { try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { log({ brain_bank_unread: (e?.message ?? String(e)).split("\n")[0] }); } }
  const b = checkBank(raw);
  log({ brain_bank: b.version, buckets: b.buckets.length, dropped: b.dropped });
  loaded = { path: path ?? "", bank: b };
  return b;
}
export function resetBank() { loaded = null; }

/**
 * Bucket A: the complete reply for a turn that needs no brain, or null. Only when the whole turn is the
 * cue (short, nothing else in it), and never when an earlier turn of theirs is still unanswered (they
 * spoke again with no reply between: "Hello?" after dead air is a question still owed, which the brain
 * answers). Never the line said last.
 */
export function instantReply(words, { history = [], recent = [], use = bank(), random = Math.random } = {}) {
  const t = String(words ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const msgs = (history ?? []).filter(m => String(m?.content ?? "").trim());
  if (msgs.length >= 2 && msgs.at(-1).role === "user" && msgs.at(-2).role === "user") return null;
  const b = bucketFor(t, { history, use });
  // He has not finished (the mined bank's SILENT): nothing now, its nudge only after 1.5 s of quiet.
  if (b?.kind === "silent") return { bucket: b.id, silent: true, text: "", nudge: b.nudge };
  if (!b || b.kind !== "instant") return null;
  // Only a whole reply, or one code finishes with Reason's own last sentence (a repeat); a line the brain
  // would have to finish is not an instant reply.
  const lastSaid = String([...msgs].reverse().find(m => m.role === "assistant")?.content ?? "").trim();
  const lastSentence = (lastSaid.match(/[^.!?]+[.!?]*\s*$/)?.[0] ?? lastSaid).trim();
  const pool = { ...b, lines: b.lines.filter(l => l.continuation === "complete" || (/last sentence/i.test(l.then) && lastSentence)) };
  if (!pool.lines.length) return null;
  const line = lineFrom(pool, recent, { random });
  const text = /last sentence/i.test(line.then) ? `${line.text.replace(/\s+$/, "")} ${lastSentence}`.trim() : line.text;
  return { bucket: b.id, text, delivery: line.delivery };
}
