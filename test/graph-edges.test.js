import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-graph-edge-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");
const { expandHops } = await import("../src/graph.js");
const C = "conv-graph-edge";

const ama = db.upsertEntity({ conversationId: C, type: "person", name: "Ama", at: 1000 });
const google = db.upsertEntity({ conversationId: C, type: "business", name: "Google", at: 1000 });
const accra = db.upsertEntity({ conversationId: C, type: "place", name: "Accra", at: 1000 });

test("addEdge creates edge and returns id", () => {
  const e = db.addEdge({ conversationId: C, srcEntity: ama.id, relation: "works_at", dstEntity: google.id, confidence: 0.9, source: "inferred" });
  assert.ok(e.id > 0);
});

test("addEdge deduplicates identical active edge", () => {
  const a = db.addEdge({ conversationId: C, srcEntity: ama.id, relation: "lives_in", dstEntity: accra.id, confidence: 0.9, source: "inferred" });
  const b = db.addEdge({ conversationId: C, srcEntity: ama.id, relation: "lives_in", dstEntity: accra.id, confidence: 0.9, source: "inferred" });
  assert.equal(a.id, b.id);
});

test("supersedeEdge closes old and creates new", () => {
  const c2 = "conv-supersede";
  const p = db.upsertEntity({ conversationId: c2, type: "person", name: "Bob", at: 1000 });
  const g1 = db.upsertEntity({ conversationId: c2, type: "business", name: "OldCo", at: 1000 });
  const g2 = db.upsertEntity({ conversationId: c2, type: "business", name: "NewCo", at: 2000 });
  const old = db.addEdge({ conversationId: c2, srcEntity: p.id, relation: "works_at", dstEntity: g1.id, confidence: 0.9, source: "inferred" });

  const next = db.supersedeEdge(c2, old.id, { dstEntity: g2.id, confidence: 0.95 });
  assert.ok(next.id !== old.id);

  const from = db.activeEdgesFrom(c2, p.id);
  assert.equal(from.length, 1);
  assert.equal(from[0].dst_entity, g2.id);
});

test("activeEdgesFrom and activeEdgesTo", () => {
  const from = db.activeEdgesFrom(C, ama.id);
  assert.ok(from.length >= 1);
  const to = db.activeEdgesTo(C, google.id);
  assert.ok(to.length >= 1);
});

test("deleteEdgesForEntity closes all edges", () => {
  const c3 = "conv-del-edges";
  const a = db.upsertEntity({ conversationId: c3, type: "person", name: "X", at: 1000 });
  const b = db.upsertEntity({ conversationId: c3, type: "place", name: "Y", at: 1000 });
  db.addEdge({ conversationId: c3, srcEntity: a.id, relation: "visited", dstEntity: b.id, confidence: 0.8, source: "inferred" });
  db.deleteEdgesForEntity(c3, a.id);
  const edges = db.activeEdgesFrom(c3, a.id);
  assert.equal(edges.length, 0);
});

test("expandHops traverses multi-hop", () => {
  const c4 = "conv-hops";
  const a = db.upsertEntity({ conversationId: c4, type: "person", name: "A", at: 1000 });
  const b = db.upsertEntity({ conversationId: c4, type: "business", name: "B", at: 1000 });
  const c = db.upsertEntity({ conversationId: c4, type: "place", name: "C", at: 1000 });
  db.addEdge({ conversationId: c4, srcEntity: a.id, relation: "works_at", dstEntity: b.id, confidence: 0.9, source: "inferred" });
  db.addEdge({ conversationId: c4, srcEntity: b.id, relation: "located_in", dstEntity: c.id, confidence: 0.9, source: "inferred" });

  const result = expandHops(c4, [a.id], { hops: 2, limit: 30 });
  assert.equal(result.edges.length, 2);
  assert.equal(result.entities.length, 3);
});

test("expandHops with 1 hop stops short", () => {
  const c5 = "conv-hops-1";
  const a = db.upsertEntity({ conversationId: c5, type: "person", name: "P", at: 1000 });
  const b = db.upsertEntity({ conversationId: c5, type: "business", name: "Q", at: 1000 });
  const c = db.upsertEntity({ conversationId: c5, type: "place", name: "R", at: 1000 });
  db.addEdge({ conversationId: c5, srcEntity: a.id, relation: "x", dstEntity: b.id, confidence: 0.9, source: "inferred" });
  db.addEdge({ conversationId: c5, srcEntity: b.id, relation: "y", dstEntity: c.id, confidence: 0.9, source: "inferred" });

  const result = expandHops(c5, [a.id], { hops: 1, limit: 30 });
  assert.equal(result.edges.length, 1);
  assert.equal(result.entities.length, 2);
});
