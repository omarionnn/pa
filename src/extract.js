import Anthropic from "@anthropic-ai/sdk";
import { config, clock } from "./config.js";
import * as db from "./db.js";
import { embedAndStore, removeEmbedding, search, embed, cosine, blobToFloat32 } from "./embedding.js";

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

async function extractFromMessage(conversationId, content, context, role) {
  const userMessage = `Recent conversation context:\n${context}\n\nNew message (${role}):\n${String(content).slice(0, 4000)}`;

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
  for (const f of facts) {
    if (!f.about?.trim() || !f.fact?.trim()) continue;
    if (f.confidence < 0.5) continue;

    const result = db.remember(conversationId, f.about, f.fact, {
      source: "inferred",
      confidence: f.confidence,
      category: f.category || "",
      sourceMessageIds: eventLogId ? [eventLogId] : [],
    });

    if (!result.already_knew && result.factId) {
      try {
        await embedAndStore(conversationId, result.factId, `${f.about}: ${f.fact}`);
      } catch (e) {
        log(`embed failed for fact ${result.factId}: ${e.message}`);
      }
    } else if (result.already_knew && result.factId) {
      // Check if embedding exists; if not, backfill
      const existing = db.db.prepare(
        "SELECT id FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'"
      ).get(result.factId);
      if (!existing) {
        try {
          await embedAndStore(conversationId, result.factId, `${f.about}: ${f.fact}`);
        } catch (e) {
          log(`embed backfill failed for fact ${result.factId}: ${e.message}`);
        }
      }
    }
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

  await rebuildProfile(conversationId);
}

export async function rebuildProfile(conversationId) {
  const facts = db.activeFacts(conversationId, { limit: 200 });
  if (!facts.length) {
    db.invalidateProfile(conversationId);
    return;
  }

  const scored = facts.map(f => {
    const age = (clock.now() - f.created_at) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - age / 90);
    const sourceWeight = f.source === "user_stated" ? 1.0 : 0.7;
    const score = (f.confidence ?? 1.0) * sourceWeight * (0.5 + 0.5 * recencyBoost);
    return { ...f, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, config.profileMaxFacts);

  const lines = [];
  let current = null;
  for (const f of top) {
    if (f.about !== current) {
      current = f.about;
      lines.push(`**${f.about}**`);
    }
    const tag = f.source === "inferred" ? " (inferred)" : "";
    lines.push(`- ${f.fact}${tag}`);
  }

  const block = lines.join("\n");
  const factIds = top.map(f => f.id);
  db.saveProfile(conversationId, block, factIds);
}
