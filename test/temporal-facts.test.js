import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-temporal-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");

const C = "conv-temporal";

test("remember() returns factId and sets temporal columns", () => {
  const result = db.remember(C, "Ama", "likes jazz", { source: "user_stated", confidence: 1.0, category: "preference" });
  assert.ok(result.factId > 0);
  assert.equal(result.already_knew, false);

  const fact = db.getFact(C, result.factId);
  assert.equal(fact.fact, "likes jazz");
  assert.equal(fact.source, "user_stated");
  assert.equal(fact.confidence, 1.0);
  assert.equal(fact.category, "preference");
});

test("remember() with inferred source", () => {
  const result = db.remember(C, "Kofi", "works at Google", { source: "inferred", confidence: 0.7, category: "work" });
  const fact = db.getFact(C, result.factId);
  assert.equal(fact.source, "inferred");
  assert.equal(fact.confidence, 0.7);
});

test("correctFact() supersedes rather than updates", () => {
  const saved = db.remember(C, "Ama", "born in 1995");
  const corrected = db.correctFact(C, saved.factId, { fact: "born in 1994" });
  assert.ok(corrected.ok);
  assert.ok(corrected.newId);
  assert.notEqual(corrected.newId, saved.factId);

  // Old fact is invisible (status = 'corrected')
  const old = db.getFact(C, saved.factId);
  assert.equal(old, null);

  // New fact is active
  const current = db.getFact(C, corrected.newId);
  assert.equal(current.fact, "born in 1994");
});

test("dropFact() soft deletes", () => {
  const saved = db.remember(C, "Kwame", "drives a Toyota");
  assert.ok(saved.factId);

  const dropped = db.dropFact(C, saved.factId);
  assert.ok(dropped.ok);
  assert.equal(dropped.was.fact, "drives a Toyota");

  // Invisible via getFact
  assert.equal(db.getFact(C, saved.factId), null);

  // Still in the table with status = 'deleted'
  const raw = db.db.prepare("SELECT status FROM person_facts WHERE id = ?").get(saved.factId);
  assert.equal(raw.status, "deleted");
});

test("activeFacts() filters by status", () => {
  const c = "conv-active";
  db.remember(c, "Person", "fact one");
  const s2 = db.remember(c, "Person", "fact two");
  db.dropFact(c, s2.factId);

  const active = db.activeFacts(c);
  assert.equal(active.length, 1);
  assert.equal(active[0].fact, "fact one");
});

test("listFacts() only shows active facts", () => {
  const c = "conv-list";
  const s1 = db.remember(c, "X", "alpha");
  const s2 = db.remember(c, "X", "beta");
  db.dropFact(c, s1.factId);

  const facts = db.listFacts(c);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact, "beta");
});

test("supersedeFact() creates a chain", () => {
  const c = "conv-sup";
  const s = db.remember(c, "Y", "old");
  const result = db.supersedeFact(c, s.factId, "new");
  assert.ok(result);
  assert.equal(result.was, "old");
  assert.equal(result.now, "new");

  // Old is gone from active view
  assert.equal(db.getFact(c, s.factId), null);
  // New is visible
  const newFact = db.getFact(c, result.newId);
  assert.equal(newFact.fact, "new");
});

test("remember() dedup respects status — can re-learn a deleted fact", () => {
  const c = "conv-relearn";
  const first = db.remember(c, "Z", "vegan");
  db.dropFact(c, first.factId);

  const second = db.remember(c, "Z", "vegan");
  assert.equal(second.already_knew, false, "should not consider deleted fact as already known");
  // The deleted row is reactivated (same id, same UNIQUE slot)
  const fact = db.getFact(c, second.factId);
  assert.ok(fact, "reactivated fact should be visible");
  assert.equal(fact.fact, "vegan");
});
