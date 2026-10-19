import Anthropic from "@anthropic-ai/sdk";
import { config, clock } from "./config.js";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { rememberOnce, distinct } from "./samefact.js";
import { vectorsFor } from "./embedding.js";

let client;
const anthropic = () => (client ??= new Anthropic());

const EXTRACT_TOOL = {
  name: "extracted",
  description: "Return the extracted facts and episodes from the conversation.",
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
            confidence: { type: "number", description: "0.5 to 1.0 — how certain this fact is" },
          },
          required: ["about", "fact", "category", "confidence"],
        },
      },
      episodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            summary: { type: "string", description: "One sentence: what was accomplished" },
            outcome: { type: "string", description: "Result or next step, if any" },
          },
          required: ["summary"],
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
    required: ["facts", "episodes", "entities", "relations"],
  },
};

const SYSTEM = `You extract durable personal facts and completed episodes from a conversation exchange.

Facts are things worth remembering across sessions: personal details, preferences, relationships, routines, goals, beliefs.
DO NOT extract: transient states ("they are typing"), task instructions ("look up X"), pleasantries, or things the assistant said about itself.
Each fact should be atomic — one piece of information, not a compound sentence.

Never extract somebody's own name as a fact about them. "Her name is Irene", "The user's name is Irene" and "Irene's name is Irene" are not facts: the name is already on record, and restating it is not new information. Put the name in "about" and extract what was said BESIDES the name.

"about" is the person's name whenever you know it. Never "user", "the user" or "me" once a name has been said anywhere in the conversation — those file the same person twice and split what is known about them in half.
"about" is never an email address or a phone number either, and never an account's label with the domain left off ("omariij20", or a pair of them like "omariij25 and omariij16"). An identifier is how you reach somebody, not who they are: a fact filed under "omariij20@gmail.com" cannot be found by looking up "Omari". Use the person's name — and if an account rather than a person is really the subject, there is no personal fact here to extract.

DO NOT extract the state of a connected account: that it was connected, disconnected or reconnected, which scopes it was granted, or which subscriptions bill to it. The assistant already holds all of that and keeps it current, so a fact restating it is a copy that goes wrong the next time the account changes. One account being disconnected and reconnected over a morning is not nine things learned about a person; it is nothing learned about a person.

You are shown the last few messages again on the next turn, and "Already known" lists what was saved from them. Everything in that list is on record. Do not return any of it again — not in the same words, not reworded, not shortened, not padded out with a qualifier. "Is a nursing BSN student" when "nursing BSN student" is already known is not a new fact, and neither is "Has not yet started clinicals in their program" when "Has not yet started clinicals" is known. Extract only what the new message adds to that list.

If the new message changes something already known, return it once, as the new state in full, and nothing else about it.

Episodes are completed actions or errands — things that were done, not things being discussed.
Only extract an episode if the assistant actually completed something (sent an email, booked something, made a call, etc.).

Entities are named things mentioned in the conversation: people, places, businesses, events, accounts, orders, reminders, topics.
Extract each distinct entity with its canonical name and type. Include aliases if the conversation uses more than one name for it.

Relations connect two entities: "Kofi" works_at "Google", "Ama" sister_of "Kofi", "appointment" at "Dr. Lee's office".
Use lowercase_with_underscores for relation names. Only extract relations you are confident about.

If there is nothing worth extracting, return empty arrays. Err on the side of fewer, higher-quality extractions.`;

export function enqueue(conversationId, eventLogId) {
  db.enqueueExtraction(conversationId, eventLogId);
}

export async function processQueue({ limit = 5, log = () => {} } = {}) {
  const rows = db.claimExtractions({ limit });
  if (!rows.length) return 0;

  let processed = 0;
  for (const row of rows) {
    try {
      const event = db.db.prepare("SELECT * FROM event_log WHERE id = ?").get(row.event_log_id);
      if (!event || !event.content?.trim()) {
        db.markExtractionDone(row.id);
        processed++;
        continue;
      }

      const context = buildContext(event);
      const result = await extractFromMessage(event.conversation_id, event.content, context, event.role);
      await validateAndInsert(event.conversation_id, result.facts, result.episodes, result.entities, result.relations, { log, eventLogId: row.event_log_id });
      db.markExtractionDone(row.id);
      processed++;
    } catch (e) {
      log(`extraction failed for queue ${row.id}: ${e.message}`);
      db.markExtractionFailed(row.id, e.message);
    }
  }
  return processed;
}

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
export function knownAlready(conversationId) {
  const bySubject = new Map();
  for (const row of db.activeFacts(conversationId, { limit: KNOWN_LIMIT })) {
    if (!bySubject.has(row.about)) bySubject.set(row.about, []);
    bySubject.get(row.about).push(row.fact);
  }
  return [...bySubject]
    .map(([about, facts]) => `${about}:\n${facts.map(f => `- ${f}`).join("\n")}`)
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

async function extractFromMessage(conversationId, content, context, role) {
  const known = knownAlready(conversationId);
  const userMessage = `${whoIsWho(conversationId)}\n\n`
    + `${known ? `Already known (do not return any of these again):\n${known}\n\n` : ""}`
    + `Recent conversation context:\n${context}\n\nNew message (${role}):\n${String(content).slice(0, 4000)}`;

  try {
    const res = await anthropic().messages.create(
      {
        model: config.extractionModel,
        max_tokens: 1000,
        system: SYSTEM,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "extracted" },
        messages: [{ role: "user", content: userMessage }],
      },
      { timeout: config.extractionTimeoutMs, maxRetries: 1 },
    );
    const block = res.content.find(b => b.type === "tool_use" && b.name === "extracted");
    if (!block) return { facts: [], episodes: [], entities: [], relations: [] };
    return { facts: block.input.facts || [], episodes: block.input.episodes || [], entities: block.input.entities || [], relations: block.input.relations || [] };
  } catch (e) {
    if (String(e).includes("timeout") || String(e).includes("abort")) {
      return { facts: [], episodes: [], entities: [], relations: [] };
    }
    throw e;
  }
}

async function validateAndInsert(conversationId, facts, episodes, entities = [], relations = [], { log = () => {}, eventLogId } = {}) {
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
      sourceMessageIds: eventLogId ? [eventLogId] : [],
      log,
    });
    if (saved?.factId && !saved.already_knew && !saved.restated) changed = true;
  }

  for (const ep of episodes) {
    if (!ep.summary?.trim()) continue;
    db.insertEpisode({
      conversationId,
      summary: ep.summary,
      outcome: ep.outcome || "",
      sourceMessageIds: eventLogId ? [eventLogId] : [],
      startedAt: clock.now(),
    });
  }

  if (entities.length || relations.length) {
    try {
      const { processExtractedGraph } = await import("./graph.js");
      await processExtractedGraph(conversationId, entities, relations, { eventLogId, log });
    } catch (e) {
      log(`graph processing failed: ${e.message}`);
    }
  }

  if (changed || !db.getProfile(conversationId)) await rebuildProfile(conversationId, { log });
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

/** The model's choice: `[{ id, same_as }]`, best first. Throws when it cannot be asked. */
async function chooseViaModel(candidates, max) {
  const listing = candidates.map(f =>
    `#${f.id} [${f.about}] (${savedOn(f.created_at)}${f.source === "inferred" ? ", inferred" : ", they said it"}${f.category ? `, ${f.category}` : ""}) ${f.fact}`
  ).join("\n");
  const res = await anthropic().messages.create(
    {
      model: config.profileModel,
      max_tokens: 1500,
      system: PROFILE_SYSTEM,
      tools: [PROFILE_TOOL],
      // Not forced: the profile model refuses a forced tool choice (400, 2026-10-19). The prompt
      // asks for the tool, and no tool call reads as a failure, which falls back to the score.
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: `Today is ${savedOn(clock.now())}. Choose at most ${max}.\n\n${listing}` }],
    },
    { timeout: config.extractionTimeoutMs, maxRetries: 1 },
  );
  const block = res.content.find(b => b.type === "tool_use" && b.name === "profile");
  if (!block) throw new Error("the profile model answered without choosing");
  return block.input?.picks ?? [];
}

/**
 * The profile: the facts most worth having in front of Reason on every turn, one line each.
 *
 * Built from what is saved, so it inherits every restatement the extractor ever made: on
 * 2026-10-19 the owner's profile spent six of its fifteen lines on getting into Speedrun, in six
 * wordings, and opened with a late-night snack. Comparing embeddings cannot sort that out — those
 * six wordings score 0.71-0.83 against each other, the same band as genuinely different facts — so
 * a model reads them and chooses (`chooseViaModel`), one line per thing, newest where they differ.
 * It is told nothing is deleted, and nothing is: what is passed over is still saved and searchable,
 * and the ids it calls restatements are recorded so a search does not offer them again.
 *
 * Without a key, or when that call fails, the choice falls back to the score below with
 * restatements that provably say the same passed over (src/samefact.js `distinct`).
 */
export async function rebuildProfile(conversationId, { vectors = vectorsFor, choose = process.env.ANTHROPIC_API_KEY ? chooseViaModel : null, log = () => {} } = {}) {
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
