// Where somebody usually is, for their own phone call: their saved places and what they have told
// Reason about their schedule (call 80, 2026-11-08). "Check the weather where I'm at" on a Sunday
// afternoon, with no live pin: the saved work address (430 W 17th) and "works Thu to Sun shifts" were
// both in memory, but the call turn saw neither — the profile block only said "night shift every
// Monday", and calls ran no memory search at all — so it said "I can't tell if you're home or
// elsewhere" and searched the whole city.
//
// Read once per call (`prepareCallMemory`, while it rings and again at the first turn, memoized), so
// every turn of the call — and the cache warm-up — sends the same words and the prompt cache holds.
// The schedule lines come from a search by meaning over their own saved facts (src/embedding.js),
// never a word list. Only this call's own conversation is read: nothing of anyone else's.
import { config } from "../config.js";
import * as db from "../db.js";
import { search } from "../embedding.js";
import { rulesNote } from "../rules.js";

/** What the schedule search asks for, in meaning. */
export const SCHEDULE_QUERY = "their work schedule and routine: which days and hours they work, their shifts, and where they usually are at different times of the week";
/** How many schedule facts ride along, and how close a fact must be. */
const SCHEDULE_HITS = 4;
const SCHEDULE_MIN_SCORE = 0.35;
/** The search's own limit; past it the call goes on without the schedule lines. */
export const SCHEDULE_TIMEOUT_MS = 2500;
/** How long a call's read is kept. */
const KEEP_MS = 3 * 60 * 60_000;

const prepared = new Map();
const retried = new Set();
const keyOf = (call) => `${call?.conversation_id}#${call?.id}`;

/** Their saved places, one line each: name, address, and when they go there if they said. */
export function placeLines(conversationId) {
  let places = [];
  try { places = db.listPlaces(conversationId); } catch { return []; }
  return places.filter(p => p.address).slice(0, 8).map(p => {
    const when = [p.days ? `days: ${p.days}` : "", p.arrive_by ? `arrives by ${p.arrive_by}` : ""].filter(Boolean).join(", ");
    return `- ${p.name}: ${p.address}${when ? ` (${when})` : ""}`;
  });
}

/**
 * Read this call's schedule facts once (memoized per call). Resolves to the lines; never throws, and
 * an empty list when there is no key, no saved facts, or the search is slow.
 */
export function prepareCallMemory(call, { find = search, enabled = !!config.openaiKey, timeoutMs = SCHEDULE_TIMEOUT_MS, log = () => {}, now = Date.now() } = {}) {
  if (!call?.conversation_id || !Number(call.is_owner)) return Promise.resolve([]);
  const key = keyOf(call);
  const had = prepared.get(key);
  if (had) return had.promise;
  for (const [k, v] of prepared) if (now - v.at > KEEP_MS) { prepared.delete(k); retried.delete(k); }
  const entry = { at: now, lines: null, promise: null };
  let failed = false;
  entry.promise = (async () => {
    if (!enabled) return [];
    try {
      const hits = await find(call.conversation_id, SCHEDULE_QUERY, { limit: SCHEDULE_HITS * 2, minScore: SCHEDULE_MIN_SCORE, timeoutMs });
      const facts = hits.map(h => db.getFact(call.conversation_id, h.factId)).filter(Boolean).slice(0, SCHEDULE_HITS);
      return facts.map(f => `- ${String(f.fact).replace(/\s+/g, " ").trim().slice(0, 200)}`);
    } catch (e) {
      failed = true;
      log({ call_schedule_read_failed: call.id, why: (e?.message ?? String(e)).split("\n")[0] });
      return [];
    }
  })().then(lines => {
    entry.lines = lines;
    // A failed read (a timeout throws) is tried once more at the next ask — the first turn — rather
    // than kept for the whole call.
    if (failed && !retried.has(key)) { retried.add(key); if (prepared.get(key) === entry) prepared.delete(key); }
    log({ call_schedule_read: call.id, facts: lines.length });
    if (lines.length) { try { listener?.(call); } catch { /* a watcher never breaks the read */ } }
    return lines;
  });
  prepared.set(key, entry);
  return entry.promise;
}

let listener = null;
/** Told each call whose week was read with something in it — the live voice picks it up (gptlive.js). */
export function onScheduleRead(fn) { listener = typeof fn === "function" ? fn : null; }

/** For tests: forget every call's read. */
export function resetCallMemory() { prepared.clear(); retried.clear(); }

/**
 * Where they usually are, for this call's prompt (Claude's turn and the GPT-Live voice), or "".
 * Sync: the schedule lines are whatever `prepareCallMemory` has read so far for this call.
 */
export function whereaboutsNote(call) {
  if (!call?.conversation_id || Number(call.is_owner) !== 1) return "";
  const places = placeLines(call.conversation_id);
  const schedule = prepared.get(keyOf(call))?.lines ?? [];
  if (!places.length && !schedule.length) return "";
  return [
    "WHERE THEY USUALLY ARE (their own saved places and what they told you about their week — use it for \"where I'm at\" when there is no live location):",
    ...(places.length ? ["Saved places:", ...places] : []),
    ...(schedule.length ? ["Their schedule, as they told you:", ...schedule] : []),
  ].join("\n");
}

/**
 * The per-call notes for a person's own call, as one string, or "" — how they want to be treated
 * (src/rules.js, read fresh) and where they usually are (`whereaboutsNote`). Sync, no model call:
 * DB reads plus whatever `prepareCallMemory` has already read for this call, so it is cheap enough to
 * call before dialing or answering (the time-to-first-word work loads it into a pre-rung session).
 * Only this call's own conversation is read; a call that is not their own gets "".
 */
export function callNotes(call) {
  if (!call?.conversation_id || !Number(call.is_owner)) return "";
  return [rulesNote(call.conversation_id), whereaboutsNote(call)].filter(Boolean).join("\n");
}
