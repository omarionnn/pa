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

// A saved fact that gives the ASSISTANT a name ("Wants the assistant to answer to the name Hewie"),
// shown under their own name in the profile, read by a model as THEIR name: the text after call 115
// opened with it. The name it gives, in the forms facts are written in.
const NAMES_THE_ASSISTANT = [
  /\b(?:[Tt]he\s+assistant|[Rr]eason|[Yy]ou|(?:[Hh]is|[Hh]er|[Tt]heir)\s+assistant)\b[^.\n]{0,30}?\b(?:answer(?:s|ing)?\s+to|be\s+called|go(?:es)?\s+by|respond(?:s)?\s+to)\s+(?:the\s+name\s+|the\s+nickname\s+)?["“'‘]?([A-Z][\p{L}'’-]{1,30})/u,
  /\b(?:[Cc]alls?|[Cc]alling|[Cc]alled|[Nn]ames?|[Nn]amed|[Nn]aming|[Nn]icknamed?)\s+(?:[Tt]he\s+assistant|[Rr]eason|[Yy]ou|(?:[Hh]is|[Hh]er|[Tt]heir)\s+assistant)\s+(?:by\s+the\s+name\s+|as\s+)?["“'‘]?([A-Z][\p{L}'’-]{1,30})/u,
  /\b(?:[Tt]he\s+assistant(?:'|’)s|[Rr]eason(?:'|’)s|[Yy]our)\s+(?:nick)?name\s+(?:is|should\s+be)\s+["“'‘]?([A-Z][\p{L}'’-]{1,30})/u,
];

/** The name a profile line gives the assistant, or "". Exported for tests. */
export function assistantNameIn(line) {
  for (const re of NAMES_THE_ASSISTANT) { const m = re.exec(String(line ?? "")); if (m) return m[1].replace(/['’]s$/, ""); }
  return "";
}

/**
 * The profile block as a prompt is shown it: a line that names the assistant says outright whose name
 * that is ("they call YOU…, never call them that"), so a nickname for Reason is never read as theirs.
 * Every other line is as stored; the stored block is never changed. `theirName`: the account's own name.
 */
export function profileForPrompt(block, theirName = "") {
  const own = String(theirName ?? "").trim();
  return String(block ?? "").split("\n").map(line => {
    const nick = assistantNameIn(line);
    if (!nick || /^reason$/i.test(nick) || (own && nick.toLowerCase() === own.toLowerCase())) return line;
    const tag = /\(([^()]*)\)\s*$/.exec(line)?.[1];
    return `- They call YOU, their assistant, "${nick}": a nickname for you, not their name.${own ? ` Their own name is ${own}.` : ""} Never call them ${nick}.${tag ? ` (${tag})` : ""}`;
  }).join("\n");
}

/** The profile note a turn or a call is shown ("" with no profile): the heading, then `profileForPrompt`. */
export function profileNote(conversationId) {
  const block = db.getProfile(conversationId)?.block;
  if (!block) return "";
  return `WHAT YOU KNOW ABOUT THEM (from past conversations — some inferred, treat those with less certainty; where two disagree, the later date wins):\n${profileForPrompt(block, ownNameOf(conversationId))}`;
}

/** Their own name as the account has it, or "" (never a stand-in). */
function ownNameOf(conversationId) {
  try {
    const row = db.getAccount(conversationId);
    const name = row?.name || (row?.is_operator || conversationId === config.ownerConversation ? config.ownerName : "");
    return name && name !== "the person I work for" ? name : "";
  } catch { return ""; }
}

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
      notes.push(profileNote(conversationId));
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
      // A fact naming the assistant says whose name it is, as the profile does (`profileForPrompt`).
      return profileForPrompt(`- ${f.about}: ${f.fact} (${tags})`, ownNameOf(conversationId));
    });
    log({ memory_hits: lines.length, conversation: conversationId });
    return lines;
  } catch (e) {
    log({ memory_search_failed: e.message });
    return [];
  }
}
