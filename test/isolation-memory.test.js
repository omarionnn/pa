import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-iso-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");

const ALICE = "conv-alice";
const BOB = "conv-bob";

test("facts are isolated between conversations", () => {
  db.remember(ALICE, "Mom", "allergic to shellfish");
  db.remember(BOB, "Dad", "plays guitar");

  const aliceFacts = db.listFacts(ALICE);
  const bobFacts = db.listFacts(BOB);

  assert.equal(aliceFacts.length, 1);
  assert.equal(aliceFacts[0].fact, "allergic to shellfish");
  assert.equal(bobFacts.length, 1);
  assert.equal(bobFacts[0].fact, "plays guitar");
});

test("recall is isolated between conversations", () => {
  const aliceRecall = db.recall(ALICE);
  const bobRecall = db.recall(BOB);

  assert.ok(aliceRecall.some(p => p.about === "Mom"));
  assert.ok(!aliceRecall.some(p => p.about === "Dad"));
  assert.ok(bobRecall.some(p => p.about === "Dad"));
  assert.ok(!bobRecall.some(p => p.about === "Mom"));
});

test("activeFacts is isolated between conversations", () => {
  const aliceActive = db.activeFacts(ALICE);
  const bobActive = db.activeFacts(BOB);

  assert.ok(aliceActive.every(f => f.about !== "Dad"));
  assert.ok(bobActive.every(f => f.about !== "Mom"));
});

test("event_log is isolated between conversations", () => {
  db.writeEvent({ conversationId: ALICE, role: "user", content: "alice says hello", at: 100 });
  db.writeEvent({ conversationId: BOB, role: "user", content: "bob says hi", at: 100 });

  const aliceEvents = db.eventsSince(ALICE, 0);
  const bobEvents = db.eventsSince(BOB, 0);

  assert.ok(aliceEvents.every(e => e.content !== "bob says hi"));
  assert.ok(bobEvents.every(e => e.content !== "alice says hello"));
});

test("profile_blocks are isolated between conversations", () => {
  db.saveProfile(ALICE, "alice profile", [1]);
  db.saveProfile(BOB, "bob profile", [2]);

  assert.equal(db.getProfile(ALICE).block, "alice profile");
  assert.equal(db.getProfile(BOB).block, "bob profile");
});

test("episodes are isolated between conversations", () => {
  db.insertEpisode({ conversationId: ALICE, summary: "booked alice's flight", startedAt: 100 });
  db.insertEpisode({ conversationId: BOB, summary: "called bob's doctor", startedAt: 100 });

  const aliceEps = db.listEpisodes(ALICE);
  const bobEps = db.listEpisodes(BOB);

  assert.equal(aliceEps.length, 1);
  assert.equal(aliceEps[0].summary, "booked alice's flight");
  assert.equal(bobEps.length, 1);
  assert.equal(bobEps[0].summary, "called bob's doctor");
});

test("fact_embeddings are isolated between conversations", async () => {
  // Insert embeddings directly (bypassing OpenAI)
  const { float32ToBlob } = await import("../src/embedding.js");
  const vec = float32ToBlob(new Float32Array([0.1, 0.2, 0.3]));

  const af = db.remember(ALICE, "Test", "alice-fact");
  const bf = db.remember(BOB, "Test", "bob-fact");

  db.db.prepare(
    "INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, model, created_at) VALUES (?, ?, 'person_facts', ?, 'test', 1)"
  ).run(ALICE, af.factId, vec);
  db.db.prepare(
    "INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, model, created_at) VALUES (?, ?, 'person_facts', ?, 'test', 1)"
  ).run(BOB, bf.factId, vec);

  const aliceEmb = db.db.prepare("SELECT * FROM fact_embeddings WHERE conversation_id = ?").all(ALICE);
  const bobEmb = db.db.prepare("SELECT * FROM fact_embeddings WHERE conversation_id = ?").all(BOB);

  assert.equal(aliceEmb.length, 1);
  assert.equal(aliceEmb[0].fact_id, af.factId);
  assert.equal(bobEmb.length, 1);
  assert.equal(bobEmb[0].fact_id, bf.factId);
});
