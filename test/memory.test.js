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

// Every conversation belongs to somebody now, and the router is what creates that account in
// production. A test that drives the tools directly sets one up the same way.
for (const [id, addr] of [[C, "+12025551234"], [OTHER, "+14445550000"]]) db.upsertAccount({ conversationId: id, channel: "test", address: addr, name: "Omari", isOperator: true });

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

// The three ways one person's memory got noisier than the person, all seen live on 2026-10-18 in
// one nine-message conversation with a new tester: her name saved five times in five wordings, the
// same fact saved twice over a trailing full stop, and half her facts filed under "user" where
// nothing looking her up by name would ever find them.

test("their own name is not a fact about them", async () => {
  const out = await call("remember", { about: "Irene", fact: "Her name is Irene" });
  assert.equal(out.already_knew, true, "nothing new was learned");
  assert.deepEqual((await call("recall", { about: "Irene" })).people, [], "and nothing was written");

  // Every wording the extraction model actually produced, plus the account holder's own name.
  for (const f of ["The user's name is Irene", "Irene's name is Irene", "her name is Irene.", "name is Omari"]) {
    await call("remember", { about: "Irene", fact: f });
  }
  assert.equal((await call("recall", { about: "Irene" })).count, 0, "five wordings, five nothings");
});

test("a name that is somebody else's is the link between them, and is kept", async () => {
  await call("remember", { about: "sister", fact: "her name is Ama" });
  const out = await call("recall", { about: "sister" });
  assert.deepEqual(out.people[0].facts.map(f => f.fact), ["her name is Ama"]);
});

test("a fact that says something besides a name is kept", async () => {
  await call("remember", { about: "Irene", fact: "her middle name is Abena" });
  await call("remember", { about: "Irene", fact: "her mother's name is Ama" });
  assert.equal((await call("recall", { about: "Irene" })).people[0].facts.length, 2);
});

test("the same fact in a different case, or with a full stop, is one fact", async () => {
  const first = await call("remember", { about: "Irene", fact: "Is enrolled in an accelerated nursing program" });
  assert.equal(first.already_knew, false);

  for (const f of ["is enrolled in an accelerated nursing program", "Is enrolled in an accelerated nursing program.", "  IS ENROLLED IN AN ACCELERATED NURSING PROGRAM  "]) {
    assert.equal((await call("remember", { about: "Irene", fact: f })).already_knew, true, `"${f}" is the same fact`);
  }

  const out = await call("recall", { about: "Irene" });
  assert.equal(out.people[0].facts.length, 1, "memory did not get noisier");
  assert.equal(out.people[0].facts[0].fact, "Is enrolled in an accelerated nursing program", "the first wording stands");
});

test('"user" is not a second person', async () => {
  await call("remember", { about: "Omari", fact: "allergic to shellfish" });
  await call("remember", { about: "user", fact: "works in tech" });
  await call("remember", { about: "the user", fact: "runs in the morning" });
  await call("remember", { about: "me", fact: "hates the LES" });

  const out = await call("recall", { about: "Omari" });
  assert.equal(out.count, 1, "one subject, not four");
  assert.deepEqual(out.people[0].facts.map(f => f.fact),
    ["allergic to shellfish", "works in tech", "runs in the morning", "hates the LES"]);
  assert.equal((await call("recall", {})).count, 1, "and no stray subject is left behind");
});

test("a pronoun is left alone, because it may be somebody else", async () => {
  await call("remember", { about: "Omari", fact: "allergic to shellfish" });
  await call("remember", { about: "her", fact: "allergic to peanuts" });
  assert.equal((await call("recall", {})).count, 2, "'her' is not assumed to be the account holder");
});

test("what was saved before they gave their name goes under the name once they do", async () => {
  const FRESH = "dm:no-name-yet";
  db.upsertAccount({ conversationId: FRESH, channel: "test", address: "+13335550000", isOperator: false });
  const callFresh = (n, i = {}) => runTool(n, i, { conversationId: FRESH });

  await callFresh("remember", { about: "user", fact: "nursing BSN student" });
  await callFresh("remember", { about: "user", fact: "has exams every week" });
  assert.equal((await callFresh("recall", {})).people[0].about, "user", "nothing better to file under yet");

  await callFresh("my_name", { name: "Irene" });

  const out = await callFresh("recall", { about: "Irene" });
  assert.equal(out.count, 1, "found by her name now");
  assert.deepEqual(out.people[0].facts.map(f => f.fact), ["nursing BSN student", "has exams every week"]);
  assert.equal((await callFresh("recall", {})).count, 1, "and the label is gone");
});

test("a merge drops what the other subject already knew rather than doubling it", async () => {
  const FRESH = "dm:overlap";
  db.upsertAccount({ conversationId: FRESH, channel: "test", address: "+13335551111", isOperator: false });
  const callFresh = (n, i = {}) => runTool(n, i, { conversationId: FRESH });

  await callFresh("remember", { about: "Kofi", fact: "nursing BSN student" });
  await callFresh("remember", { about: "user", fact: "nursing BSN student." });
  await callFresh("remember", { about: "user", fact: "has exams every week" });

  await callFresh("my_name", { name: "Kofi" });

  const out = await callFresh("recall", { about: "Kofi" });
  assert.deepEqual(out.people[0].facts.map(f => f.fact), ["nursing BSN student", "has exams every week"]);
});

test("the backlog gets the same tidy-up, once", () => {
  // Exactly what was on the live server for one tester: her name in five wordings, one fact twice
  // over a full stop, and the rest filed under "user" instead of her name.
  const named = db.upsertPerson(C, "Irene");
  db.db.prepare("UPDATE accounts SET name = 'Irene' WHERE conversation_id = ?").run(C);
  const label = db.db.prepare("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, 'user', 'user', ?, ?)")
    .run(C, clock.now(), clock.now());
  const labelId = Number(label.lastInsertRowid);

  const add = (personId, fact, at) => Number(db.db.prepare(
    `INSERT INTO person_facts (person_id, fact, created_at, valid_from, status, confidence, source, source_message_ids, category)
     VALUES (?, ?, ?, ?, 'active', 1.0, 'inferred', '[]', '')`).run(personId, fact, at, at).lastInsertRowid);

  const t = clock.now();
  add(named.id, "Her name is Irene", t);
  add(named.id, "The user's name is Irene", t + 1);
  add(named.id, "Irene's name is Irene", t + 2);
  add(named.id, "Irene is a BSN nursing student", t + 3);
  add(named.id, "Irene is a BSN nursing student.", t + 4);
  const keptVector = add(named.id, "hasn't started clinicals yet", t + 5);
  add(labelId, "Is enrolled in an accelerated nursing program", t + 6);
  const droppedVector = add(labelId, "is enrolled in an accelerated nursing program", t + 7);
  for (const id of [keptVector, droppedVector]) {
    db.db.prepare("INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, model, created_at) VALUES (?, ?, 'person_facts', ?, 'test', ?)")
      .run(C, id, Buffer.alloc(8), t);
  }

  const out = db.tidyPersonFacts();
  assert.equal(out.already_done, false);
  assert.equal(out.names, 3, "three wordings of her own name");
  assert.equal(out.duplicates, 2, "the full-stop twin and the lower-case twin");

  const facts = db.recall(C, "Irene");
  assert.equal(facts.length, 1, "one subject, not two");
  assert.deepEqual(facts[0].facts.map(f => f.fact), [
    "Irene is a BSN nursing student",
    "hasn't started clinicals yet",
    "Is enrolled in an accelerated nursing program",
  ]);
  assert.equal(db.recall(C, "").length, 1, "the 'user' subject is gone");

  const vectors = db.db.prepare("SELECT fact_id FROM fact_embeddings WHERE conversation_id = ?").all(C).map(r => r.fact_id);
  assert.deepEqual(vectors, [keptVector], "a dropped fact's vector went with it");

  const again = db.tidyPersonFacts();
  assert.equal(again.already_done, true, "it does not run twice");
  assert.equal(db.recall(C, "Irene")[0].facts.length, 3, "and nothing moved on a second call");
});

test("a merge survives the same words already being on the other subject", async () => {
  // person_facts is UNIQUE(person_id, fact), so a row cannot simply be repointed onto a subject
  // that already holds that exact text. Live data had this: "Got into a16z speedrun" under both
  // "user" and "john" in one conversation.
  const FRESH = "dm:same-words";
  db.upsertAccount({ conversationId: FRESH, channel: "test", address: "+13335552222", isOperator: false });
  const callFresh = (n, i = {}) => runTool(n, i, { conversationId: FRESH });

  await callFresh("remember", { about: "John", fact: "Got into a16z speedrun" });
  await callFresh("remember", { about: "user", fact: "Got into a16z speedrun" });
  await callFresh("remember", { about: "user", fact: "lives in Brooklyn" });

  await callFresh("my_name", { name: "John" });

  const out = await callFresh("recall", { about: "John" });
  assert.equal(out.count, 1);
  assert.deepEqual(out.people[0].facts.map(f => f.fact), ["Got into a16z speedrun", "lives in Brooklyn"]);
});
