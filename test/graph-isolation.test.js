import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-graph-iso-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");
const { processExtractedGraph, buildGraphContext } = await import("../src/graph.js");

const A = "conv-iso-A";
const B = "conv-iso-B";

test("setup: user A has entities and edges", async () => {
  const evtId = db.writeEvent({ conversationId: A, role: "user", content: "Ama works at Google", at: 1000 });
  await processExtractedGraph(A,
    [{ name: "Ama", type: "person" }, { name: "Google", type: "business" }],
    [{ src: "Ama", relation: "works_at", dst: "Google", confidence: 0.9 }],
    { eventLogId: evtId, log: () => {} });
  const ama = db.findEntity(A, "Ama", { type: "person" });
  assert.ok(ama);
});

test("user B cannot see user A's entities", () => {
  const ama = db.findEntity(B, "Ama", { type: "person" });
  assert.equal(ama, null);
});

test("user B cannot see user A's entities via text match", () => {
  const hits = db.findEntitiesByText(B, "Ama works at Google");
  assert.equal(hits.length, 0);
});

test("user B gets no graph context for A's entities", () => {
  const ctx = buildGraphContext(B, "What does Ama do?");
  assert.equal(ctx, "");
});

test("user B can create own Ama entity independently", async () => {
  const evtId = db.writeEvent({ conversationId: B, role: "user", content: "Ama is my friend", at: 2000 });
  await processExtractedGraph(B,
    [{ name: "Ama", type: "person" }],
    [],
    { eventLogId: evtId, log: () => {} });
  const ama = db.findEntity(B, "Ama", { type: "person" });
  assert.ok(ama);

  const amaA = db.findEntity(A, "Ama", { type: "person" });
  assert.notEqual(ama.id, amaA.id);
});

test("user A's edges are not visible to user B", () => {
  const amaB = db.findEntity(B, "Ama", { type: "person" });
  const edges = db.activeEdgesFrom(B, amaB.id);
  assert.equal(edges.length, 0);
});

test("mentions isolated between users", () => {
  const amaA = db.findEntity(A, "Ama", { type: "person" });
  const amaB = db.findEntity(B, "Ama", { type: "person" });
  const mA = db.mentionsForEntity(A, amaA.id);
  const mB = db.mentionsForEntity(B, amaB.id);
  assert.ok(mA.length >= 1);
  assert.ok(mB.length >= 1);
  const idsA = mA.map(m => m.event_log_id);
  const idsB = mB.map(m => m.event_log_id);
  const overlap = idsA.filter(id => idsB.includes(id));
  assert.equal(overlap.length, 0);
});
