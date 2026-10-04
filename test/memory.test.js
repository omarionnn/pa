// What Reason remembers about people, without the model. Facts hang off a subject, so the thing
// under test is identity (is "Kofi" the same person as "kofi "?), not phrasing — and the honesty
// of the empty answer, which is what stops Reason pretending to remember.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-memory-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");

const C = "dm:memory";
const OTHER = "dm:someone-else";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM person_facts; DELETE FROM people; DELETE FROM memories; DELETE FROM schema_meta;");
});

const call = (name, input = {}) => runTool(name, input, { conversationId: C });

test("one person, however they spell them", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish" });
  await call("remember", { about: "  kofi ", fact: "always late" });
  await call("remember", { about: "KOFI.", fact: "hates the LES" });

  const out = await call("recall", { about: "kofi" });
  assert.equal(out.count, 1, "three spellings are one subject");
  assert.equal(out.people[0].about, "Kofi", "the first spelling is the display name");
  assert.deepEqual(out.people[0].facts.map(f => f.fact),
    ["allergic to shellfish", "always late", "hates the LES"]);
});

test("the same fact twice is one fact, and says so", async () => {
  const first = await call("remember", { about: "Kofi", fact: "allergic to shellfish" });
  assert.equal(first.already_knew, false);

  const again = await call("remember", { about: "kofi", fact: "allergic to shellfish" });
  assert.equal(again.already_knew, true);
  assert.match(again.note, /already knew/i);

  const out = await call("recall", { about: "Kofi" });
  assert.equal(out.people[0].facts.length, 1, "memory did not get noisier");
});

test("remember hands back everything known about them, not just the new line", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish" });
  const out = await call("remember", { about: "Kofi", fact: "lives in Bed-Stuy" });
  assert.deepEqual(out.knows_about_them, ["allergic to shellfish", "lives in Bed-Stuy"]);
});

test("recall with no name is everyone, most recently touched first", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish" });
  clock.skip(60_000);
  await call("remember", { about: "Timi", fact: "vegetarian" });

  const out = await call("recall", {});
  assert.deepEqual(out.people.map(p => p.about), ["Timi", "Kofi"]);
  assert.equal(out.count, 2);
});

test("a partial name finds them, and the exact subject comes first", async () => {
  await call("remember", { about: "Kofi Mensah", fact: "allergic to shellfish" });
  clock.skip(60_000);
  await call("remember", { about: "Kofi", fact: "always late" });

  const out = await call("recall", { about: "Kofi" });
  assert.equal(out.people[0].about, "Kofi", "the exact match wins over the newer partial one");
  assert.ok(out.people.some(p => p.about === "Kofi Mensah"), "the partial match is still offered");
});

test("knowing nothing says so plainly, and tells the model not to pretend", async () => {
  const unknown = await call("recall", { about: "Kofi" });
  assert.equal(unknown.count, 0);
  assert.deepEqual(unknown.people, []);
  assert.match(unknown.note, /nothing is saved/i);
  assert.match(unknown.note, /do not pretend/i);

  const empty = await call("recall", {});
  assert.equal(empty.count, 0);
  assert.match(empty.note, /do not know anything/i);
});

test("one person's memory is not another conversation's", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish" });
  const theirs = await runTool("recall", { about: "Kofi" }, { conversationId: OTHER });
  assert.equal(theirs.count, 0, "a different thread knows nothing about Kofi");
});

test("forget drops the subject and everything under it, and says how much", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish" });
  await call("remember", { about: "Kofi", fact: "always late" });

  const gone = await call("forget", { about: "kofi" });
  assert.equal(gone.ok, true);
  assert.equal(gone.about, "Kofi");
  assert.equal(gone.forgot, 2);

  const after = await call("recall", { about: "Kofi" });
  assert.equal(after.count, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM person_facts").get().n, 0, "no orphan facts left behind");
});

test("forgetting someone there is nothing on fails honestly", async () => {
  const out = await call("forget", { about: "Nobody" });
  assert.equal(out.ok, false);
  assert.match(out.error, /nothing is on record/i);
});

test("forget only reaches into this conversation", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish" });
  const out = await runTool("forget", { about: "Kofi" }, { conversationId: OTHER });
  assert.equal(out.ok, false, "another thread cannot forget what it never knew");
  assert.equal((await call("recall", { about: "Kofi" })).count, 1, "and it is still here");
});

test("an install from before this change keeps what it knew, and the move runs once", () => {
  const now = clock.now();
  db.db.prepare("INSERT INTO memories (conversation_id, about, fact, created_at) VALUES (?, ?, ?, ?)")
    .run(C, "Kofi", "allergic to shellfish", now);
  db.db.prepare("INSERT INTO memories (conversation_id, about, fact, created_at) VALUES (?, ?, ?, ?)")
    .run(C, "kofi", "always late", now + 1);

  const first = db.migrateMemoriesToPeople();
  assert.equal(first.migrated, 2);
  const out = db.recall(C, "kofi");
  assert.equal(out.length, 1, "two spellings became one subject");
  assert.equal(out[0].facts.length, 2);

  const second = db.migrateMemoriesToPeople();
  assert.equal(second.already_done, true);
  assert.equal(second.migrated, 0, "a second run moves nothing");
  assert.equal(db.recall(C, "kofi")[0].facts.length, 2, "and does not duplicate what it moved");
});
