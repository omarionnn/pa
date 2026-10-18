// A fact already saved, said again in different words, is not a new fact.
//
// `remember` already refuses the same sentence twice, and since #31 it refuses it across case and a
// trailing full stop. What it cannot see is a paraphrase, and a paraphrase is most of what the
// extraction model produces: it re-reads the last few messages on every turn and words them
// slightly differently each time. One nine-message conversation left "Has not yet started
// clinicals", "has not started clinicals yet" and "Has not yet started clinicals in their program"
// as three separate things known about one person.
//
// Meaning is what has to be compared, so this compares the embeddings. On their own they are not
// safe enough to delete on: measured over all 46,298 same-person pairs in the live data,
//
//     Has Gmail account omariij16@gmail.com
//     Has Gmail account omariij25@gmail.com
//
// score 0.974 — above fifteen pairs that really are the same fact twice. Suppressing on similarity
// alone would have thrown away one of two real email accounts. So similarity decides only that two
// sentences are ABOUT the same thing; a second, exact test decides whether they SAY the same thing:
// the numbers, money, times, emails, handles and domains must match, and so must the negations.
// Those are the places where one character is a different fact, and they are the places an
// embedding is least sensitive.
//
// The rule errs one way on purpose. Where it is unsure it keeps both rows, because a duplicate is
// noise and a bad merge is a fact Reason no longer knows.
import * as db from "./db.js";
import { embed, search, embedAndStore, hasEmbedding } from "./embedding.js";

/**
 * How close two sentences must sit before the exact tests get a say. Chosen from the live data:
 * at 0.95 it catches 41 of the 46,298 same-person pairs, every one of them genuinely the same fact
 * twice, and the three it refuses at that score are all refusals it should make. Lower still looks
 * clean on this corpus but spends the margin that makes the guard worth having.
 */
export const RESTATES_SCORE = 0.95;

/** Enough stored facts to catch a restatement without walking an entire long memory. */
const COMPARE_LIMIT = 25;

/**
 * Words that flip a sentence's meaning while barely moving its embedding. "Luma appears inactive"
 * and the same line plus "and no emails since" are not the same claim, and neither are "is allergic
 * to peanuts" and "is not allergic to peanuts".
 */
const NEGATION = /\b(not|never|no|none|without|cannot|can't|won't|doesn't|didn't|isn't|aren't|hasn't|haven't|don't|stopped|cancelled|canceled|unsubscribed|former|ex)\b/g;

/**
 * The parts of a sentence where one character is a different fact: every number (so $12.99 is not
 * $14, and omariij16 is not omariij25), every email, @handle and domain. Punctuation and thousands
 * separators are dropped so "$6/month" and "$6 per month" agree, and "4 PM" agrees with "4pm".
 */
export function hardTokens(fact) {
  const s = String(fact ?? "").toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) out.add(`e:${m[0]}`);
  for (const m of s.matchAll(/(?<![\w@])@[\w.]+/g)) out.add(`h:${m[0]}`);
  for (const m of s.matchAll(/\b[\w-]+\.(?:com|org|net|io|dev|ai|app|co|gg|me)\b/g)) out.add(`d:${m[0]}`);
  for (const m of s.matchAll(/\d[\d,.:]*/g)) out.add(`n:${m[0].replace(/,/g, "").replace(/[.:]$/, "")}`);
  return out;
}

const negations = fact => (String(fact ?? "").toLowerCase().match(NEGATION) ?? []).length;

/**
 * Does `candidate` say what `stored` already says? `score` is how close their embeddings sit.
 * Pure, so the judgement can be tested without reaching for an embedding.
 */
export function restates(stored, candidate, score, { minScore = RESTATES_SCORE } = {}) {
  if (!(score >= minScore)) return false;
  if (db.factKey(stored) === db.factKey(candidate)) return true;
  const a = hardTokens(stored);
  const b = hardTokens(candidate);
  if (a.size !== b.size || [...a].some(t => !b.has(t))) return false;
  return negations(stored) === negations(candidate);
}

/**
 * The fact already known about this subject that `fact` restates, or null. Reads only: a subject
 * that does not exist yet has nothing to restate, and asking must not bring one into being.
 */
export async function storedRestatement(conversationId, about, fact, { vector } = {}) {
  const person = db.findPerson(conversationId, about);
  if (!person) return null;
  const mine = new Map(
    db.activeFacts(conversationId, { personId: person.id, limit: 200 }).map(f => [f.id, f]),
  );
  if (!mine.size) return null;

  const hits = await search(conversationId, `${about}: ${fact}`, {
    limit: COMPARE_LIMIT,
    minScore: RESTATES_SCORE,
    vector,
  });
  for (const hit of hits) {
    const stored = mine.get(hit.factId);
    if (stored && restates(stored.fact, fact, hit.score)) return { ...stored, score: hit.score };
  }
  return null;
}

/**
 * Save a fact unless it is something already known in other words.
 *
 * The one embedding this needs is the one the fact was going to be stored with anyway, so a
 * suppressed paraphrase costs nothing and a saved fact costs what it always did. If embedding is
 * unavailable — no key, or the call fails — the fact is saved on `remember`'s own exact-text
 * dedupe. A memory write is not worth losing to a network error.
 */
export async function rememberOnce(conversationId, about, fact, { log = () => {}, ...opts } = {}) {
  const text = `${about}: ${fact}`;
  let vector;
  try {
    [vector] = await embed(text);
    const already = await storedRestatement(conversationId, about, fact, { vector });
    if (already) {
      log(`fact restates #${already.id} (${already.score.toFixed(3)}), not saved: ${fact}`);
      return { ...db.remember(conversationId, about, already.fact, opts), restated: already.id };
    }
  } catch (e) {
    log(`restatement check skipped: ${e.message}`);
  }

  const saved = db.remember(conversationId, about, fact, opts);
  if (!saved.factId) return saved;
  // An embedding is what makes the NEXT paraphrase catchable, so a fact without one is a hole in
  // this check as well as in search. Store it for a new row, and backfill one that never got it.
  try {
    if (!saved.already_knew || !hasEmbedding(saved.factId)) {
      await embedAndStore(conversationId, saved.factId, text, { vector });
    }
  } catch (e) {
    log(`embed failed for fact ${saved.factId}: ${e.message}`);
  }
  return saved;
}
