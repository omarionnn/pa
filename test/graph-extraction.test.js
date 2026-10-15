import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-graph-extract-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");
const { processExtractedGraph, buildGraphContext } = await import("../src/graph.js");
const C = "conv-graph-extract";

test("processExtractedGraph resolves entities and adds edges", async () => {
  const evtId = db.writeEvent({ conversationId: C, role: "user", content: "Ama works at Google in Accra", at: 1000 });

  const entities = [
    { name: "Ama", type: "person", aliases: [] },
    { name: "Google", type: "business", aliases: [] },
    { name: "Accra", type: "place", aliases: [] },
  ];
  const relations = [
    { src: "Ama", relation: "works_at", dst: "Google", confidence: 0.9 },
    { src: "Ama", relation: "lives_in", dst: "Accra", confidence: 0.85 },
  ];

  await processExtractedGraph(C, entities, relations, { eventLogId: evtId, log: () => {} });

  const ama = db.findEntity(C, "Ama", { type: "person" });
  assert.ok(ama);
  const edges = db.activeEdgesFrom(C, ama.id);
  assert.equal(edges.length, 2);
  const rels = edges.map(e => e.relation).sort();
  assert.deepEqual(rels, ["lives_in", "works_at"]);
});

test("processExtractedGraph creates mentions for each entity", async () => {
  const c2 = "conv-extract-mentions";
  const evtId = db.writeEvent({ conversationId: c2, role: "user", content: "Kofi visited Kumasi", at: 2000 });

  await processExtractedGraph(c2,
    [{ name: "Kofi", type: "person" }, { name: "Kumasi", type: "place" }],
    [{ src: "Kofi", relation: "visited", dst: "Kumasi", confidence: 0.8 }],
    { eventLogId: evtId, log: () => {} });

  const kofi = db.findEntity(c2, "Kofi", { type: "person" });
  const mentions = db.mentionsForEntity(c2, kofi.id);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].event_log_id, evtId);
});

test("processExtractedGraph skips low-confidence relations", async () => {
  const c3 = "conv-extract-lowconf";
  const evtId = db.writeEvent({ conversationId: c3, role: "user", content: "test", at: 3000 });

  await processExtractedGraph(c3,
    [{ name: "A", type: "person" }, { name: "B", type: "person" }],
    [{ src: "A", relation: "maybe_knows", dst: "B", confidence: 0.3 }],
    { eventLogId: evtId, log: () => {} });

  const a = db.findEntity(c3, "A", { type: "person" });
  const edges = db.activeEdgesFrom(c3, a.id);
  assert.equal(edges.length, 0);
});

test("buildGraphContext returns formatted connections", () => {
  const ctx = buildGraphContext(C, "What does Ama do?");
  assert.ok(ctx.includes("CONNECTIONS"));
  assert.ok(ctx.includes("works_at"));
});

test("buildGraphContext returns empty for unrecognized text", () => {
  const ctx = buildGraphContext(C, "How's the weather?");
  assert.equal(ctx, "");
});
