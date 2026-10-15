import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-graph-ent-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");
const C = "conv-graph-ent";

test("upsertEntity creates and returns entity", () => {
  const e = db.upsertEntity({ conversationId: C, type: "person", name: "Ama", aliases: ["Amacom"], at: 1000 });
  assert.ok(e.id > 0);
  assert.equal(e.canonical_name, "Ama");
});

test("upsertEntity is idempotent for same key", () => {
  const a = db.upsertEntity({ conversationId: C, type: "person", name: "Kofi", at: 2000 });
  const b = db.upsertEntity({ conversationId: C, type: "person", name: "Kofi", at: 3000 });
  assert.equal(a.id, b.id);
});

test("upsertEntity key normalization: case, spacing, trailing punctuation", () => {
  const a = db.upsertEntity({ conversationId: C, type: "place", name: "Accra", at: 4000 });
  const b = db.upsertEntity({ conversationId: C, type: "place", name: "  ACCRA  ", at: 5000 });
  assert.equal(a.id, b.id);
});

test("upsertEntity merges aliases on existing", () => {
  db.upsertEntity({ conversationId: C, type: "person", name: "Mike", aliases: ["Michael"], at: 6000 });
  db.upsertEntity({ conversationId: C, type: "person", name: "Mike", aliases: ["Mikey"], at: 7000 });
  const e = db.findEntity(C, "Mike", { type: "person" });
  const aliases = JSON.parse(e.aliases);
  assert.ok(aliases.includes("Michael"));
  assert.ok(aliases.includes("Mikey"));
});

test("findEntity returns null for nonexistent", () => {
  const e = db.findEntity(C, "Nobody", { type: "person" });
  assert.equal(e, null);
});

test("getEntity follows merged_into chain", () => {
  const a = db.upsertEntity({ conversationId: C, type: "person", name: "Alexander", at: 8000 });
  const b = db.upsertEntity({ conversationId: C, type: "person", name: "Alex", at: 9000 });
  db.mergeEntities(C, a.id, b.id);
  const resolved = db.getEntity(C, b.id);
  assert.equal(resolved.id, a.id);
});

test("mergeEntities re-points edges", () => {
  const c2 = "conv-merge-edges";
  const src = db.upsertEntity({ conversationId: c2, type: "person", name: "Src", at: 1000 });
  const keep = db.upsertEntity({ conversationId: c2, type: "business", name: "Google", at: 2000 });
  const dup = db.upsertEntity({ conversationId: c2, type: "business", name: "Goog", at: 3000 });
  db.addEdge({ conversationId: c2, srcEntity: src.id, relation: "works_at", dstEntity: dup.id, confidence: 0.9, source: "inferred" });

  db.mergeEntities(c2, keep.id, dup.id);
  const edges = db.activeEdgesFrom(c2, src.id);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].dst_entity, keep.id);
});

test("deleteEntity soft-deletes", () => {
  const e = db.upsertEntity({ conversationId: C, type: "topic", name: "Weather", at: 10000 });
  db.deleteEntity(C, e.id);
  const got = db.getEntity(C, e.id);
  assert.equal(got, null);
});

test("listEntities returns only active entities", () => {
  const c3 = "conv-list-active";
  db.upsertEntity({ conversationId: c3, type: "person", name: "Active", at: 1000 });
  const del = db.upsertEntity({ conversationId: c3, type: "person", name: "Gone", at: 2000 });
  db.deleteEntity(c3, del.id);
  const all = db.listEntities(c3, { type: "person" });
  assert.equal(all.length, 1);
  assert.equal(all[0].canonical_name, "Active");
});

test("entitiesForPerson links to people table", () => {
  const c4 = "conv-person-link";
  const person = db.upsertPerson(c4, "Jeff");
  db.upsertEntity({ conversationId: c4, type: "person", name: "Jeff", personId: person.id, at: 1000 });
  const linked = db.entitiesForPerson(c4, person.id);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].canonical_name, "Jeff");
});

test("findEntitiesByText matches names and aliases", () => {
  const c5 = "conv-text-match";
  db.upsertEntity({ conversationId: c5, type: "person", name: "Ama", aliases: ["Amacom"], at: 1000 });
  db.upsertEntity({ conversationId: c5, type: "place", name: "Accra", at: 2000 });
  const hits = db.findEntitiesByText(c5, "Ama lives in Accra and works hard");
  assert.equal(hits.length, 2);
  const names = hits.map(h => h.canonical_name).sort();
  assert.deepEqual(names, ["Accra", "Ama"]);
});
