// What Reason is shown, on a turn they started, of what it already knows about them: the profile
// (src/extract.js `rebuildProfile`) and the few saved facts closest in meaning to what they just
// said.
//
// Both backends call this. Until 2026-10-19 only the API path did, and the live Reason runs on the
// CLI path — so every fact was extracted, deduplicated, embedded and searchable, and the model on
// live saw none of it unless it thought to call `memory_search` itself. It rarely did.
import { config } from "./config.js";
import * as db from "./db.js";
import { search, vectorsFor } from "./embedding.js";
import { distinct } from "./samefact.js";
import { savedOn } from "./extract.js";
import { rulesNote } from "./rules.js";

/** How many matches ride on a turn. Enough to catch the thing they mean, few enough to stay cheap. */
const HITS = 3;
/** Below this a match is about something else. The API path used the same floor. */
const MIN_SCORE = 0.4;
/** The one network call on the way to a reply; past this it is skipped, never waited on. */
const EMBED_TIMEOUT_MS = 2500;

/**
 * The notes for this turn, as an array of strings (empty when there is nothing). Never throws:
 * memory is help for the reply, and a reply that waits on it or dies of it is worse than one without.
 */
export async function memoryNotes(conversationId, text, { find = search, vectors = vectorsFor, enabled = !!config.openaiKey, log = () => {} } = {}) {
  const notes = [];
  let inProfile = new Set();
  try {
    const profile = db.getProfile(conversationId);
    if (profile?.block) {
      notes.push(`WHAT YOU KNOW ABOUT THEM (from past conversations — some inferred, treat those with less certainty; where two disagree, the later date wins):\n${profile.block}`);
      inProfile = new Set(JSON.parse(profile.fact_ids || "[]"));
    }
  } catch (e) {
    log({ profile_note_failed: e.message });
  }
  // How they want to be treated (src/rules.js — the one reader every prompt for a person uses).
  const rules = rulesNote(conversationId);
  if (rules) notes.push(rules);

  // No await at all when there is nothing to search: the turn's notes are ready at once, as before.
  const hits = enabled && String(text ?? "").trim() ? await memoryHits(conversationId, text, { find, vectors, enabled, log, inProfile }) : [];
  if (hits.length) notes.push(`RELEVANT MEMORIES (closest in meaning to this message):\n${hits.join("\n")}`);
  return notes;
}

/** The facts in the profile block, by id (they need not be shown twice). */
export function profileFactIds(conversationId) {
  try { return new Set(JSON.parse(db.getProfile(conversationId)?.fact_ids || "[]")); } catch { return new Set(); }
}

/**
 * The few saved facts closest in meaning to what they just said, as "- about: fact (tags)" lines,
 * leaving out what the profile already shows. Shared by a text turn (above) and a turn on their own
 * phone call (src/calls/voice.js), which waits less for it. Never throws.
 */
export async function memoryHits(conversationId, text, { find = search, vectors = vectorsFor, enabled = !!config.openaiKey, log = () => {}, inProfile = profileFactIds(conversationId), timeoutMs = EMBED_TIMEOUT_MS, exclude = new Set() } = {}) {
  if (!enabled || !String(text ?? "").trim()) return [];
  try {
    // More than HITS asked for, because a match may already be in the profile above or no longer
    // active, and the slots should go to something the model has not just been shown.
    const hits = await find(conversationId, text, { limit: HITS * 4, minScore: MIN_SCORE, timeoutMs });
    const found = hits.filter(h => !inProfile.has(h.factId) && !exclude.has(h.factId)).map(h => db.getFact(conversationId, h.factId)).filter(Boolean);
    // The same thing in three wordings would spend all three slots on it — and the profile above
    // may already say it — so restatements are passed over, off the vectors already stored.
    const shown = [...inProfile].map(id => db.getFact(conversationId, id)).filter(Boolean);
    const vec = vectors(conversationId, [...found, ...shown].map(f => f.id));
    const lines = distinct(found, vec, { max: HITS, seen: shown }).map(f => {
      const tags = [f.source === "inferred" ? "inferred" : "", `saved ${savedOn(f.created_at)}`].filter(Boolean).join(", ");
      return `- ${f.about}: ${f.fact} (${tags})`;
    });
    log({ memory_hits: lines.length, conversation: conversationId });
    return lines;
  } catch (e) {
    log({ memory_search_failed: e.message });
    return [];
  }
}
