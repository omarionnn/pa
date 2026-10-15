import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-profile-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");

test("saveProfile and getProfile round-trip", () => {
  const block = "**Kofi**\n- likes basketball\n- works at Google";
  db.saveProfile("conv-p1", block, [1, 2]);

  const got = db.getProfile("conv-p1");
  assert.ok(got);
  assert.equal(got.block, block);
  assert.equal(got.conversation_id, "conv-p1");
  assert.deepEqual(JSON.parse(got.fact_ids), [1, 2]);
});

test("saveProfile upserts on conflict", () => {
  db.saveProfile("conv-p2", "v1", [1]);
  db.saveProfile("conv-p2", "v2", [1, 2, 3]);

  const got = db.getProfile("conv-p2");
  assert.equal(got.block, "v2");
  assert.deepEqual(JSON.parse(got.fact_ids), [1, 2, 3]);
});

test("getProfile returns null when no profile exists", () => {
  assert.equal(db.getProfile("nonexistent"), null);
});

test("invalidateProfile removes the profile", () => {
  db.saveProfile("conv-p3", "temp", []);
  assert.ok(db.getProfile("conv-p3"));

  db.invalidateProfile("conv-p3");
  assert.equal(db.getProfile("conv-p3"), null);
});

test("profiles are scoped by conversation_id", () => {
  db.saveProfile("conv-pa", "profile a", [10]);
  db.saveProfile("conv-pb", "profile b", [20]);

  assert.equal(db.getProfile("conv-pa").block, "profile a");
  assert.equal(db.getProfile("conv-pb").block, "profile b");
});
