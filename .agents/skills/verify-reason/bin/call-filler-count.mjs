// Counts what a call's agent side said that was filler rather than an answer: apologies, checks that
// the caller is still there, holding/"one sec" lines, and the same filler said twice on one call.
// Shared by the read-only measurement and bin/call-filler-drive.mjs, so before and after are counted
// by one rule. Counts only: nothing here prints a transcript.

const APOLOGY = /\b(sorry|apologi[sz]e|my apologies|my bad)\b/i;
const PRESENCE = /\b(are you (still )?there|you still there|still there\?|can you hear me|hear me (okay|ok|alright)|you there\?|still with me)\b/i;
// Each filler phrase has a key, so "the same filler twice on a call" is countable.
const FILLERS = [
  ["one_sec", /\bone sec(ond)?\b/i],
  ["one_moment", /\bone moment\b/i],
  ["still_working", /\bstill working on it\b/i],
  ["bear_with_me", /\bbear with me\b/i],
  ["hold_on", /\b(hold on|hang on)\b/i],
  ["just_a_sec", /\b(just|give me) a (sec|second|moment|minute)\b/i],
  ["broke", /\bsomething broke\b/i],
  ["say_again", /\b(say that again|didn'?t catch (that|you))\b/i],
];

export function classifyLine(text = "") {
  const t = String(text);
  const fillers = FILLERS.filter(([, re]) => re.test(t)).map(([k]) => k);
  const apology = APOLOGY.test(t);
  const presence = PRESENCE.test(t);
  return { apology, presence, fillers, any: apology || presence || fillers.length > 0 };
}

/** Totals over a call's agent lines. `lines` is an array of strings. */
export function countCall(lines = []) {
  const out = { lines: lines.length, filler_lines: 0, apologies: 0, presence: 0, filler_phrases: 0, repeats: 0, by: {} };
  const seen = new Map();
  for (const line of lines) {
    const c = classifyLine(line);
    if (c.any) out.filler_lines++;
    if (c.apology) out.apologies++;
    if (c.presence) out.presence++;
    for (const k of c.fillers) {
      out.filler_phrases++;
      out.by[k] = (out.by[k] ?? 0) + 1;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  for (const n of seen.values()) if (n > 1) out.repeats += n - 1;
  return out;
}

export function addCounts(a, b) {
  const by = { ...a.by };
  for (const [k, v] of Object.entries(b.by ?? {})) by[k] = (by[k] ?? 0) + v;
  return {
    lines: a.lines + b.lines, filler_lines: a.filler_lines + b.filler_lines, apologies: a.apologies + b.apologies,
    presence: a.presence + b.presence, filler_phrases: a.filler_phrases + b.filler_phrases, repeats: a.repeats + b.repeats, by,
  };
}

export const ZERO = { lines: 0, filler_lines: 0, apologies: 0, presence: 0, filler_phrases: 0, repeats: 0, by: {} };

export function pct(values = [], p) {
  const v = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

/** Gap stats over a list of silences in ms. */
export function gapStats(ms = []) {
  const v = ms.filter(Number.isFinite);
  return {
    n: v.length, p50: pct(v, 50), p90: pct(v, 90),
    over6: v.filter(x => x > 6_000).length, over10: v.filter(x => x > 10_000).length,
  };
}

/** A transcript's lines, split by speaker. */
export function transcriptLines(transcript = "") {
  const agent = [], them = [];
  for (const raw of String(transcript).split("\n")) {
    const m = raw.match(/^(Reason|Them):\s?(.*)$/);
    if (!m) continue;
    (m[1] === "Reason" ? agent : them).push(m[2]);
  }
  return { agent, them };
}
