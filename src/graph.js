import { config, clock } from "./config.js";
import * as db from "./db.js";

export function resolveEntity(conversationId, name, type, { aliases = [] } = {}) {
  if (!name?.trim()) return null;

  let entity = db.findEntity(conversationId, name, { type });
  if (entity) return entity.id;

  // For person entities, link to the people table.
  let personId = null;
  if (type === "person") {
    const person = db.upsertPerson(conversationId, name);
    personId = person.id;
    const byPerson = db.entitiesForPerson(conversationId, personId);
    if (byPerson.length) return byPerson[0].id;
  }

  // Check aliases across all entities of this type.
  const k = db.personKey(name);
  const all = db.listEntities(conversationId, { type });
  for (const e of all) {
    const ea = JSON.parse(e.aliases);
    for (const a of ea) {
      if (db.personKey(a) === k) return e.id;
    }
  }

  // Create new entity.
  const result = db.upsertEntity({ conversationId, type, name, aliases, personId });
  return result?.id ?? null;
}

export function expandHops(conversationId, entityIds, { hops = 2, limit = 30 } = {}) {
  const seen = new Set(entityIds);
  const allEdges = [];
  let frontier = [...entityIds];

  for (let hop = 0; hop < hops && frontier.length; hop++) {
    const edges = db.activeEdgesForEntities(conversationId, frontier, { limit: limit - allEdges.length });
    if (!edges.length) break;
    const nextFrontier = [];
    for (const e of edges) {
      const dup = allEdges.some(x => x.id === e.id);
      if (!dup) allEdges.push(e);
      if (!seen.has(e.src_entity)) { seen.add(e.src_entity); nextFrontier.push(e.src_entity); }
      if (!seen.has(e.dst_entity)) { seen.add(e.dst_entity); nextFrontier.push(e.dst_entity); }
    }
    frontier = nextFrontier;
    if (allEdges.length >= limit) break;
  }

  const entityMap = new Map();
  for (const id of seen) {
    const e = db.getEntity(conversationId, id);
    if (e) entityMap.set(id, e);
  }
  return { entities: [...entityMap.values()], edges: allEdges.slice(0, limit) };
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function buildGraphContext(conversationId, text) {
  const matched = db.findEntitiesByText(conversationId, text);
  if (!matched.length) return "";

  const ids = matched.map(e => e.id);
  const { edges } = expandHops(conversationId, ids, { hops: config.graphMaxHops, limit: 30 });
  if (!edges.length) return "";

  const lines = edges.map(e => {
    const since = formatDate(e.valid_from);
    return `${e.src_name} → ${e.relation} → ${e.dst_name}${since ? ` (${since})` : ""}`;
  });
  const unique = [...new Set(lines)];
  return `CONNECTIONS (from your knowledge graph — treat as leads, check the source if it matters):\n${unique.join("\n")}`;
}

export async function processExtractedGraph(conversationId, entities, relations, { eventLogId, log = () => {} } = {}) {
  const entityMap = new Map();

  for (const ent of entities) {
    if (!ent.name?.trim() || !ent.type?.trim()) continue;
    try {
      const id = resolveEntity(conversationId, ent.name, ent.type, { aliases: ent.aliases || [] });
      if (id) {
        entityMap.set(ent.name.toLowerCase().trim(), id);
        if (eventLogId) db.addMention({ conversationId, eventLogId, entityId: id });
      }
    } catch (e) {
      log(`entity resolve failed for "${ent.name}": ${e.message}`);
    }
  }

  for (const rel of relations) {
    if (!rel.src?.trim() || !rel.dst?.trim() || !rel.relation?.trim()) continue;
    if ((rel.confidence ?? 1) < 0.5) continue;
    const srcId = entityMap.get(rel.src.toLowerCase().trim());
    const dstId = entityMap.get(rel.dst.toLowerCase().trim());
    if (!srcId || !dstId) continue;
    try {
      db.addEdge({
        conversationId,
        srcEntity: srcId,
        relation: rel.relation.toLowerCase().replace(/\s+/g, "_"),
        dstEntity: dstId,
        confidence: rel.confidence ?? 0.8,
        source: "inferred",
        sourceMessageIds: eventLogId ? [eventLogId] : [],
      });
    } catch (e) {
      log(`edge add failed for "${rel.src} → ${rel.relation} → ${rel.dst}": ${e.message}`);
    }
  }
}

export async function backfillGraph(conversationId, { batchSize = 50, log = () => {}, resumeFrom = 0 } = {}) {
  const { processQueue } = await import("./extract.js");
  const events = db.eventsSince(conversationId, resumeFrom, { limit: batchSize });
  let lastId = resumeFrom;
  for (const ev of events) {
    db.enqueueExtraction(conversationId, ev.id);
    lastId = ev.id;
  }
  if (events.length) {
    const processed = await processQueue({ limit: batchSize, log });
    log(`backfill: ${events.length} events queued, ${processed} processed`);
  }
  return { lastId, count: events.length };
}
