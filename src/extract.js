import { config, clock } from "./config.js";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { rememberOnce, distinct } from "./samefact.js";
import { vectorsFor, embed, embedAndStore } from "./embedding.js";
import { runStructured, onCli, sideModelOn } from "./backends/side.js";
import * as background from "./background.js";


/**
 * Where extraction and the profile run: Reason's own subscription, through the background lane, and
 * never the paid API (owner, 2026-10-27; on the API it was what emptied the key 2026-10-25). It is
 * background work and nobody waits on it.
 */
export const onSubscription = () => process.env.REASON_BACKEND === "claude-cli";

const EXTRACT_TOOL = {
  name: "extracted",
  description: "Return the extracted facts, entities and relations from the conversation.",
  input_schema: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            about: { type: "string", description: "The subject (person name or topic)" },
            fact: { type: "string", description: "One atomic fact, preference, or belief" },
            category: { type: "string", enum: ["identity", "relationship", "preference", "work", "health", "location", "routine", "goal", "belief", "other"] },
            group: { type: "string", enum: ["preferences", "people", "places", "routines", "why"], description: "Where this goes on their memory page. people: about another person or a pet, or who someone is to them. places: where they live, work, go or want to go. routines: what they do regularly, schedules, habits, things they pay for on repeat. why: their goals, plans, reasons and beliefs. preferences: what they like, want and how they like things done, and anything else about them." },
            confidence: { type: "number", description: "0.5 to 1.0 — how certain this fact is" },
            replaces: { type: "integer", description: "Only when the new message says an Already-known line is no longer true: that line's # (the number after '#'). This fact is its new state. Leave out otherwise." },
            message: { type: "integer", description: "The [n] of the new message this fact came from." },
          },
          required: ["about", "fact", "category", "confidence"],
        },
      },
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Canonical name of the entity" },
            type: { type: "string", enum: ["person", "place", "business", "event", "account", "order", "reminder", "topic"] },
            aliases: { type: "array", items: { type: "string" }, description: "Other names this entity goes by" },
          },
          required: ["name", "type"],
        },
      },
      relations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            src: { type: "string", description: "Source entity name (must match an entity above)" },
            relation: { type: "string", description: "Verb phrase: works_at, lives_in, sister_of, etc." },
            dst: { type: "string", description: "Destination entity name (must match an entity above)" },
            confidence: { type: "number", description: "0.5 to 1.0" },
          },
          required: ["src", "relation", "dst", "confidence"],
        },
      },
    },
    required: ["facts", "entities", "relations"],
  },
};

const SYSTEM = `You extract durable personal facts from a conversation exchange.

Facts are things worth remembering across sessions: personal details, preferences, relationships, routines, goals, beliefs.
DO NOT extract: transient states ("they are typing"), task instructions ("look up X"), pleasantries, or things the assistant said about itself.
Each fact should be atomic — one piece of information, not a compound sentence.

Never extract somebody's own name as a fact about them. "Her name is <her name>", "The user's name is <their name>" and "<name>'s name is <name>" are not facts: the name is already on record, and restating it is not new information. Put the name in "about" and extract what was said BESIDES the name.

"about" is the person's name whenever you know it. Never "user", "the user" or "me" once a name has been said anywhere in the conversation — those file the same person twice and split what is known about them in half.
"about" is never an email address or a phone number either, and never an account's label with the domain left off ("jdoe20", or a pair of them like "jdoe25 and jdoe16"). An identifier is how you reach somebody, not who they are: a fact filed under "jdoe20@gmail.com" cannot be found by looking up their name. Use the person's name — and if an account rather than a person is really the subject, there is no personal fact here to extract.

DO NOT extract the state of a connected account: that it was connected, disconnected or reconnected, which scopes it was granted, or which subscriptions bill to it. The assistant already holds all of that and keeps it current, so a fact restating it is a copy that goes wrong the next time the account changes. One account being disconnected and reconnected over a morning is not nine things learned about a person; it is nothing learned about a person.

You are shown the last few messages again on the next turn, and "Already known" lists what was saved from them. Everything in that list is on record. Do not return any of it again — not in the same words, not reworded, not shortened, not padded out with a qualifier. "Is a nursing BSN student" when "nursing BSN student" is already known is not a new fact, and neither is "Has not yet started clinicals in their program" when "Has not yet started clinicals" is known. Extract only what the new message adds to that list.

If the new message changes something already known, return it once, as the new state in full, and nothing else about it. Every Already-known line has a number (#123): set "replaces" to that number when the new message itself makes that one line untrue — they moved, the plan changed, the thing finished — and the new fact is about the same person. Do not set it for a fact that merely adds to one, is related to one, or is about somebody else; both stay on record then, which is right. When unsure, leave "replaces" out.

Entities are named things mentioned in the conversation: people, places, businesses, events, accounts, orders, reminders, topics.
Extract each distinct entity with its canonical name and type. Include aliases if the conversation uses more than one name for it.

Relations connect two entities: "my brother" works_at "Google", "my sister" sister_of "my brother", "appointment" at "the dentist's office".
Use lowercase_with_underscores for relation names. Only extract relations you are confident about.

Several new messages may be given at once, numbered [1], [2] … oldest first. Read them together, in order — a later one can answer or correct an earlier one — and set "message" on each fact to the number it came from.

If there is nothing worth extracting, return empty arrays. Err on the side of fewer, higher-quality extractions.`;

export function enqueue(conversationId, eventLogId) {
  db.enqueueExtraction(conversationId, eventLogId);
}

/**
 * One extraction pass: the oldest queued messages of ONE conversation, read in one model call.
 *
 * Batched (2026-10-25): a call per message re-sent the same instructions, the same "already known"
 * list and the same four lines of context for every "ok". Now up to config.extractionBatch messages
 * from one conversation share one read, and messages with nothing a person could remember in them
 * are marked done without any (see `worthReading`). Other conversations' rows wait for the next pass.
 */
export async function processQueue({ limit = config.extractionBatch, log = () => {} } = {}) {
  await backfillEmbeddings({ log });
  const revived = db.reviveOutageExtractions();
  if (revived) log({ extraction_revived: revived });
  const claimed = db.claimExtractions({ limit });
  if (!claimed.length) return 0;
  const conversationId = claimed[0].conversation_id;
  const rows = claimed.filter(r => r.conversation_id === conversationId);
  db.releaseExtractions(claimed.filter(r => r.conversation_id !== conversationId).map(r => r.id));

  let processed = 0;
  const items = [];
  for (const row of rows) {
    const event = db.db.prepare("SELECT * FROM event_log WHERE id = ?").get(row.event_log_id);
    if (!event || !worthReading(event)) {
      db.markExtractionDone(row.id);
      processed++;
      continue;
    }
    items.push({ row, event });
  }
  if (!items.length) {
    if (processed) log({ extraction_skipped: processed, conversation: conversationId, why: "nothing to remember" });
    return processed;
  }

  try {
    const context = buildContext(items[0].event);
    const result = await (reader ?? extractMessages)(conversationId, items.map(i => i.event), context);
    const ids = items.map(i => i.row.event_log_id);
    await validateAndInsert(conversationId, result.facts, result.episodes, result.entities, result.relations, { log, eventLogIds: ids, shown: result.shown });
    for (const { row } of items) db.markExtractionDone(row.id);
    processed += items.length;
    log({ extracted: items.length, skipped: rows.length - items.length, facts: result.facts.length, conversation: conversationId, via: result.via ?? "stub" });
  } catch (e) {
    log(`extraction failed for queue ${items.map(i => i.row.id).join(",")}: ${e.message}`);
    // An outage fails every row the same way, and gives each its try back (db.markExtractionFailed).
    for (const { row } of items) db.markExtractionFailed(row.id, e.message);
  }
  return processed;
}

/** For tests: what reads a batch. `(conversationId, events, context) => result`; `null` puts the real one back. */
let reader = null;
export function setExtractReader(f) { reader = f; }

/**
 * Does this message have anything in it a person could remember? Decided by its shape, never by
 * which words it uses: the person's own words with code's bracketed notes ("[they sent this as an
 * inline reply …]") taken off must hold a letter or a digit — a tapback, a lone emoji or "!!" do
 * not — and a single short word ("ok", "thanks", "Done", "lol") is read only when it answers a
 * question, because "Ama" after "what's your sister's name?" is a fact and after "booked it" is not.
 */
export function worthReading(event, { previous = undefined } = {}) {
  const own = String(event?.content ?? "").split("\n").filter(l => !/^\s*\[[^\]]*\]\s*$/.test(l)).join(" ").trim();
  if (!/[\p{L}\p{N}]/u.test(own)) return false;
  const oneShortWord = !/\s/.test(own) && own.length <= SHORT_WORD_MAX;
  if (!oneShortWord) return true;
  const before = previous !== undefined ? previous : db.db.prepare(
    "SELECT content FROM event_log WHERE conversation_id = ? AND (at < ? OR (at = ? AND id < ?)) AND role != ? ORDER BY at DESC, id DESC LIMIT 1"
  ).get(event.conversation_id, event.at, event.at, event.id, event.role)?.content;
  return String(before ?? "").trim().endsWith("?");
}
const SHORT_WORD_MAX = 12;

/** How many facts one pass embeds. One batched call; a backlog drains over a few passes. */
const BACKFILL_LIMIT = 20;

/**
 * Embed active facts that have none. A fact without an embedding is invisible to `memory_search`
 * and to the restatement check in src/samefact.js, and nothing ever went back for one: the model's
 * own `remember` tool embeds without awaiting (it answers mid-turn) and swallows the error, so one
 * failed call — a timeout, a 429 — left that fact unfindable for good. Run at the top of every
 * extraction pass, which is already periodic, bounded per pass, and a no-op that costs one indexed
 * query when nothing is missing. Never throws: a failure here is retried on the next pass.
 */
export async function backfillEmbeddings({ limit = BACKFILL_LIMIT, embedFn = embed, store = storeVector, log = () => {}, now = Date.now() } = {}) {
  if (embedFn === embed && !config.openaiKey) return 0;
  if (now < backfillPausedUntil) return 0;
  let rows;
  try {
    rows = db.factsMissingEmbedding({ limit });
    if (!rows.length) return 0;
    // The same text every other path embeds a fact with, so a backfilled vector compares like any other.
    const vectors = await embedFn(rows.map(r => `${r.about}: ${r.fact}`));
    let done = 0;
    for (const [i, r] of rows.entries()) {
      if (!vectors[i]) continue;
      await store(r.conversation_id, r.id, vectors[i]);
      done++;
    }
    if (done) log(`embedded ${done} fact(s) that had no embedding`);
    return done;
  } catch (e) {
    // A key or billing refusal (401/403, or a 429 that is "no credits" rather than a rate limit) is
    // not fixed by asking again on the next pass: 2026-11-09 an invalidated key made this loop send
    // 220 refused calls in one hour, the bulk of the 277 OpenAI failures on the status page. Wait.
    const keyRefused = /OpenAI embeddings (401|403)\b/.test(e.message)
      || /OpenAI embeddings 429\b/.test(e.message) && /insufficient_quota|no credits/i.test(e.message);
    if (keyRefused) backfillPausedUntil = now + BACKFILL_KEY_PAUSE_MS;
    log(`embedding backfill failed (${rows?.length ?? 0} waiting)${keyRefused ? `, paused ${BACKFILL_KEY_PAUSE_MS / 60_000} min` : ""}: ${e.message}`);
    return 0;
  }
}

/** How long the backfill waits after OpenAI refused the key or the billing. A new key means a restart, which clears it. */
const BACKFILL_KEY_PAUSE_MS = 30 * 60_000;
let backfillPausedUntil = 0;
/** For tests. */
export function resetBackfillPause() { backfillPausedUntil = 0; }

const storeVector = (conversationId, factId, vector) => embedAndStore(conversationId, factId, "", { vector });

function buildContext(event) {
  const recent = db.db.prepare(
    "SELECT role, content FROM event_log WHERE conversation_id = ? AND at < ? ORDER BY at DESC LIMIT 4"
  ).all(event.conversation_id, event.at);

  return recent.reverse().map(r => `${r.role}: ${String(r.content).slice(0, 500)}`).join("\n");
}

/**
 * Enough of what is already on record to stop the model handing it back. Newest first, because the
 * facts it is about to reword are the ones it saved seconds ago off an overlapping window.
 */
const KNOWN_LIMIT = 40;

/**
 * The newest 40 were all it was ever shown, and that is not enough for anybody who has used Reason
 * for a while: on 2026-10-19 the owner had ~370 active facts, so a fact saved a month ago was not
 * "already known" as far as the extractor could see, and the next time the conversation touched it
 * it was reworded and saved again. So on top of the newest, it is shown what is on record about the
 * people actually in the messages it is reading — at any age — and always about the account holder,
 * who is in every conversation whether or not they name themselves. Each capped, because this goes
 * in front of a small model on every message.
 */
const HOLDER_LIMIT = 60;
const PER_SUBJECT_LIMIT = 20;
const KNOWN_MAX = 150;

/** Lowercase words separated by single spaces, padded, so a name is found only as whole words. */
const words = s => ` ${String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/**
 * Subjects this conversation has on record whose name appears in `text`. Deciding which saved rows
 * to SHOW the model, not what anything means: a name that matches a subject it is not about only
 * costs a few lines of prompt, and the model still reads the messages. The full name, or its first
 * word on its own ("Kofi" for "Kofi Mensah") when that is long enough not to match by accident.
 */
function subjectsIn(conversationId, text) {
  const hay = words(text);
  if (!hay.trim()) return [];
  return db.db.prepare("SELECT id, name FROM people WHERE conversation_id = ?").all(conversationId).filter(p => {
    const full = words(p.name);
    if (!full.trim()) return false;
    if (hay.includes(full)) return true;
    const first = full.trim().split(" ")[0];
    return full.trim().includes(" ") && first.length >= 3 && hay.includes(` ${first} `);
  });
}

/**
 * The rows the extractor is shown as already known, newest first: the newest overall, then the
 * account holder's, then those of everyone named in `text` (the messages it is about to read).
 * Every row carries its id, so the model can say which one a changed fact replaces.
 */
export function knownFacts(conversationId, { text = "" } = {}) {
  const out = new Map();
  const add = rows => { for (const r of rows) if (out.size < KNOWN_MAX && !out.has(r.id)) out.set(r.id, r); };
  add(db.activeFacts(conversationId, { limit: KNOWN_LIMIT }));
  const me = accounts.ownerOf(conversationId);
  const holder = me.name && me.name !== "the person I work for" ? db.findPerson(conversationId, me.name) : null;
  if (holder) add(db.activeFacts(conversationId, { personId: holder.id, limit: HOLDER_LIMIT }));
  for (const p of subjectsIn(conversationId, text)) {
    if (p.id === holder?.id) continue;
    add(db.activeFacts(conversationId, { personId: p.id, limit: PER_SUBJECT_LIMIT }));
  }
  return [...out.values()].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}

/**
 * What is already known about the people in this conversation, grouped by subject.
 *
 * The prompt has always told the model not to extract the same thing twice, but it was never shown
 * what it had already extracted, so the instruction was unfollowable: it re-reads the last four
 * messages every turn and words the same fact differently each time. One nine-message conversation
 * left twelve rows for four things. `samefact.js` catches the pairs that land close enough to be
 * provably the same sentence; this stops the model producing them. Measured on that conversation,
 * most restatements sit between 0.92 and 0.95 — too far apart to delete on safely, since real
 * distinct facts live at 0.974. The cheap fix is upstream: say what is known.
 */
export function knownAlready(conversationId, { text = "", rows = knownFacts(conversationId, { text }) } = {}) {
  const bySubject = new Map();
  for (const row of rows) {
    if (!bySubject.has(row.about)) bySubject.set(row.about, []);
    bySubject.get(row.about).push(row);
  }
  return [...bySubject]
    .map(([about, facts]) => `${about}:\n${facts.map(f => `- #${f.id} ${f.fact}`).join("\n")}`)
    .join("\n\n");
}

/**
 * Who "user" is in this conversation. The context is labelled only "user" and "assistant", so the
 * model had to guess the person's name from what they said — and on 2026-10-17 Kofi's "student at
 * Calvin" left his card and his reminders filed under a person called Calvin, which is his school.
 */
export function whoIsWho(conversationId) {
  const me = accounts.ownerOf(conversationId);
  const known = me.name && me.name !== "the person I work for";
  return known
    ? `"user" is ${me.name}, the person this assistant works for. Everything they say about themselves goes under "${me.name}". A school, employer, city or business they mention is never them, and is "about" only when the fact is about that place.`
    : `"user" is the person this assistant works for; their name is not on record yet. A school, employer, city or business they mention is never them.`;
}

/** The prompt for one batch: who is who, what is known, the context before it, the messages numbered. */
export function batchPrompt(conversationId, events, context) {
  const body = events.map((e, i) => `[${i + 1}] (${e.role}):\n${String(e.content).slice(0, 4000)}`).join("\n\n");
  const rows = knownFacts(conversationId, { text: `${context}\n${body}` });
  const known = knownAlready(conversationId, { rows });
  const prompt = `${whoIsWho(conversationId)}\n\n`
    + `${known ? `Already known (do not return any of these again):\n${known}\n\n` : ""}`
    + `Recent conversation context:\n${context || "(none)"}\n\n`
    + `New message${events.length === 1 ? "" : "s, oldest first"}:\n${body}`;
  return { prompt, shown: new Set(rows.map(r => r.id)) };
}

const empty = (shown, via) => ({ facts: [], episodes: [], entities: [], relations: [], shown, via });
const tidyResult = (v, shown, via) => ({ facts: v?.facts || [], episodes: [], entities: v?.entities || [], relations: v?.relations || [], shown, via });

/** One read of a batch: on the subscription on the claude-cli backend, on the API key otherwise (2026-11-02). */
async function extractMessages(conversationId, events, context) {
  const { prompt, shown } = batchPrompt(conversationId, events, context);
  const r = await runStructured({ prompt, system: SYSTEM, jsonSchema: EXTRACT_TOOL.input_schema, model: onCli() ? config.extractionCliModel : config.extractionModel, timeoutMs: config.extractionCliTimeoutMs, feature: "extraction" });
  if (!r.ok) throw new Error(r.error ?? `the CLI reported an error: ${String(r.envelope?.result ?? "").split("\n")[0] || "no detail"}`);
  const v = r.envelope?.structured_output && typeof r.envelope.structured_output === "object" ? r.envelope.structured_output : JSON.parse(String(r.envelope?.result ?? ""));
  return tidyResult(v, shown, r.envelope?.via ?? "cli");
}

/**
 * Rebuild the profile. With a model to choose it (the subscription, or the API key since 2026-11-02),
 * as a background-lane job (one per conversation waiting, never during a reply); without one, now, by score.
 */
export function scheduleProfile(conversationId, { log = () => {} } = {}) {
  if (!sideModelOn()) return rebuildProfile(conversationId, { log });
  background.enqueue(`profile:${conversationId}`, () => rebuildProfile(conversationId, { log }))
    .catch(e => log(`profile rebuild failed: ${e.message}`));
  return Promise.resolve();
}

export async function validateAndInsert(conversationId, facts, episodes, entities = [], relations = [], { log = () => {}, eventLogId, eventLogIds = eventLogId ? [eventLogId] : [], shown = new Set() } = {}) {
  // Whether anything new was written. The profile is rebuilt only then — rebuilding it is a model
  // call now, and most turns save nothing new.
  let changed = false;
  for (const f of facts) {
    if (!f.about?.trim() || !f.fact?.trim()) continue;
    if (f.confidence < 0.5) continue;

    // Not `db.remember`: this model restates what it already said in new words on every turn, and
    // only a comparison of meaning catches that. See src/samefact.js.
    const saved = await rememberOnce(conversationId, f.about, f.fact, {
      source: "inferred",
      confidence: f.confidence,
      category: f.category || "",
      group: f.group || "",
      // The one message it came from when the reader said which, else every message in the batch.
      sourceMessageIds: Number.isInteger(f.message) && eventLogIds[f.message - 1] ? [eventLogIds[f.message - 1]] : eventLogIds,
      log,
    });
    if (saved?.factId && !saved.already_knew && !saved.restated) changed = true;

    // A changed fact retires the one it replaces. Until 2026-10-19 the new state was saved beside
    // the old and both stayed true ("Gmail being reconnected" next to "Gmail now connected"); only a
    // manual memory_fix ever retired anything. The model names the row, by the number it was shown;
    // code checks it was one of the rows actually shown this turn, and `retireForNewer` refuses
    // anything but an active row about the same subject. Nothing is retired when the new fact was
    // not saved — a refused write must not cost the old one.
    const replaces = Number(f.replaces);
    if (saved?.factId && Number.isInteger(replaces) && replaces > 0) {
      if (!shown.has(replaces)) {
        log(`fact says it replaces #${replaces}, which it was not shown; both kept: ${f.fact}`);
      } else {
        const retired = db.retireForNewer(conversationId, replaces, saved.factId);
        if (retired.ok) {
          changed = true;
          log(`fact #${replaces} retired for #${saved.factId}: "${retired.was}" -> "${retired.now}"`);
        } else {
          log(`fact #${replaces} not retired for #${saved.factId} (${retired.error})`);
        }
      }
    }
  }

  // `episodes` is no longer asked for or kept: nothing ever read the table back (audit 10-18), so
  // every turn paid the extractor to write something no turn would see. What Reason did is in the
  // ledger (ledger_list), which is read. The parameter stays so older callers still line up.
  void episodes;

  if (entities.length || relations.length) {
    try {
      const { processExtractedGraph } = await import("./graph.js");
      await processExtractedGraph(conversationId, entities, relations, { eventLogId: eventLogIds[0], log });
    } catch (e) {
      log(`graph processing failed: ${e.message}`);
    }
  }

  if (changed || !db.getProfile(conversationId)) await scheduleProfile(conversationId, { log });
}

// What a fact is about decides whether it belongs in the few lines Reason is shown on every turn.
// Who someone is, where they live, what they want and how they like things done stay true; "asked
// for a playlist" and "snacking on cashews" were true for an evening. The latter still get saved
// and still turn up when a message is about them (src/memorynote.js) — they just do not get to
// push the lasting things out of the profile.
const LASTING = new Set(["identity", "relationship", "location", "health", "preference", "goal", "work", "routine", "interest"]);

/** "Oct 16", in the owner's time zone — when a fact was saved, so a newer one can win. */
export function savedOn(at) {
  return at ? new Date(at).toLocaleDateString("en-US", { timeZone: config.tz, month: "short", day: "numeric" }) : "";
}

const PROFILE_TOOL = {
  name: "profile",
  description: "The facts to keep in front of the assistant on every conversation.",
  input_schema: {
    type: "object",
    properties: {
      picks: {
        type: "array",
        description: "Best first. Each one a distinct thing — never two that say the same.",
        items: {
          type: "object",
          properties: {
            id: { type: "integer", description: "The # of the fact chosen" },
            same_as: { type: "array", items: { type: "integer" }, description: "Every other # that says the same thing as this one, or an older version of it" },
          },
          required: ["id", "same_as"],
        },
      },
    },
    required: ["picks"],
  },
};

const PROFILE_SYSTEM = `You choose what a personal assistant keeps in front of it about the people in one person's life, out of everything it has saved.

Pick the facts that will still matter next week: who they are, where they live and work, the people around them, what they want, how they like things done, health, routines, plans that are still ahead. Pass over one-off requests ("asked for a playlist"), reminders and alerts they asked for (those are tasks the assistant tracks elsewhere, not facts about them), where they happened to be at the time, passing moments ("snacking on cashews"), anything already over by today's date, and notes about the assistant's own workings (links it made, accounts it connected, how its alerts work).

The saved facts repeat themselves in different words. Several lines often say one thing. For each thing, pick exactly ONE line: the one that says most, and where they disagree, the newest (dates are given). List the others under same_as, including older versions it replaces. Two lines with a different number, email, amount, date or account are different facts, not the same one.

Answer only by calling the profile tool.`;

const profilePrompt = (candidates, max) => `Today is ${savedOn(clock.now())}. Choose at most ${max}.\n\n` + candidates.map(f =>
  `#${f.id} [${f.about}] (${savedOn(f.created_at)}${f.source === "inferred" ? ", inferred" : ", they said it"}${f.category ? `, ${f.category}` : ""}) ${f.fact}`
).join("\n");

/** The model's choice, on the subscription: `[{ id, same_as }]`, best first. Throws when it cannot be asked. */
async function chooseViaCli(candidates, max) {
  const r = await runStructured({ prompt: profilePrompt(candidates, max), system: PROFILE_SYSTEM.replace("Answer only by calling the profile tool.", "Answer with the picks only."), jsonSchema: PROFILE_TOOL.input_schema, model: onCli() ? config.profileCliModel : config.profileModel, timeoutMs: config.extractionCliTimeoutMs, feature: "profile" });
  if (!r.ok) throw new Error(r.error ?? "the CLI reported an error");
  const v = r.envelope?.structured_output && typeof r.envelope.structured_output === "object" ? r.envelope.structured_output : JSON.parse(String(r.envelope?.result ?? ""));
  if (!Array.isArray(v?.picks)) throw new Error("the profile model answered without choosing");
  return v.picks;
}

/** Who chooses the profile: the model (the subscription on claude-cli, the API key on api), else nobody (the score). */
const defaultChoose = () => (sideModelOn() ? chooseViaCli : null);

/**
 * The profile: the facts most worth having in front of Reason on every turn, one line each.
 *
 * Built from what is saved, so it inherits every restatement the extractor ever made: on
 * 2026-10-19 the owner's profile spent six of its fifteen lines on getting into Speedrun, in six
 * wordings, and opened with a late-night snack. Comparing embeddings cannot sort that out — those
 * six wordings score 0.71-0.83 against each other, the same band as genuinely different facts — so
 * a model reads them and chooses (`chooseViaCli`), one line per thing, newest where they differ.
 * It is told nothing is deleted, and nothing is: what is passed over is still saved and searchable,
 * and the ids it calls restatements are recorded so a search does not offer them again.
 *
 * Without a key, or when that call fails, the choice falls back to the score below with
 * restatements that provably say the same passed over (src/samefact.js `distinct`).
 */
export async function rebuildProfile(conversationId, { vectors = vectorsFor, choose = defaultChoose(), log = () => {} } = {}) {
  const facts = db.activeFacts(conversationId, { limit: 200 });
  if (!facts.length) {
    db.invalidateProfile(conversationId);
    return;
  }

  const scored = facts.map(f => {
    const age = (clock.now() - f.created_at) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - age / 90);
    const sourceWeight = f.source === "user_stated" ? 1.0 : 0.7;
    const lasting = LASTING.has(f.category) ? 1.0 : 0.6;
    const score = (f.confidence ?? 1.0) * sourceWeight * lasting * (0.5 + 0.5 * recencyBoost);
    return { ...f, score };
  });
  scored.sort((a, b) => b.score - a.score || b.created_at - a.created_at);
  const max = config.profileMaxFacts;
  const thinned = distinct(scored, vectors(conversationId, scored.map(f => f.id)));

  let top = null;
  let accounted = [];
  if (choose) {
    try {
      const byId = new Map(thinned.map(f => [f.id, f]));
      const picks = await choose(thinned.slice(0, 120), max);
      const seen = new Set();
      top = [];
      for (const p of picks) {
        const f = byId.get(p.id);
        if (!f || seen.has(f.id) || top.length >= max) continue;
        seen.add(f.id);
        top.push(f);
        for (const id of p.same_as ?? []) if (byId.has(id) && !seen.has(id)) { seen.add(id); accounted.push(id); }
      }
      if (!top.length) top = null;
    } catch (e) {
      log(`profile choice failed, scored instead: ${e.message}`);
      top = null;
    }
  }
  if (!top) {
    top = thinned.slice(0, max);
    accounted = [];
  }

  // One heading per subject, subjects in the order their best fact was chosen.
  const subjects = [...new Set(top.map(f => f.about))];
  const lines = [];
  for (const about of subjects) {
    lines.push(`**${about}**`);
    for (const f of top.filter(x => x.about === about)) {
      const tags = [f.source === "inferred" ? "inferred" : "", savedOn(f.created_at)].filter(Boolean).join(", ");
      lines.push(`- ${f.fact}${tags ? ` (${tags})` : ""}`);
    }
  }

  // The ids it stands for as well as the ones it shows, so a search does not spend a slot on a
  // wording of something already in front of the model (src/memorynote.js).
  db.saveProfile(conversationId, lines.join("\n"), [...top.map(f => f.id), ...accounted]);
}
