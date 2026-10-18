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

// ---------------------------------------------------------------------------
// An identifier is not a person, and an account's state is not a fact about one. Every case below
// was read off the live server on 2026-10-18: four of 55 subjects were an email address or a phone
// number, and the eleven active facts under them were all account bookkeeping — one Google account
// disconnected and reconnected across a single morning, written nine times, plus two stale lists of
// which subscriptions billed to which inbox.

// A conversation whose owner has connected two of their own Google accounts, which is what makes
// those two addresses provably theirs and anything else provably not.
const OWNED = "dm:identifiers";
db.upsertAccount({ conversationId: OWNED, channel: "test", address: "+17183062726", name: "Omari", isOperator: true });
db.connectAccount(OWNED, "gmail", [], { account: "omariij20@gmail.com" });
db.connectAccount(OWNED, "google_calendar", [], { account: "omariij16@gmail.com" });
const callOwned = (n, i = {}) => runTool(n, i, { conversationId: OWNED });

test("the account holder's own email is them, not a subject of its own", async () => {
  await callOwned("remember", { about: "omariij20@gmail.com", fact: "keeps the LegalZoom paperwork here" });

  const out = await callOwned("recall", { about: "Omari" });
  assert.equal(out.count, 1, "found by his name, which is how recall looks people up");
  assert.deepEqual(out.people[0].facts.map(f => f.fact), ["keeps the LegalZoom paperwork here"]);
  assert.equal((await callOwned("recall", {})).count, 1, "and no inbox-shaped subject beside him");
});

test("their own phone number is them too, however it is punctuated", async () => {
  await callOwned("remember", { about: "+1 (718) 306-2726", fact: "answers texts faster than email" });
  const out = await callOwned("recall", { about: "Omari" });
  assert.equal(out.count, 1, "one subject, not one per spelling of the number");
  assert.ok(out.people[0].facts.some(f => f.fact === "answers texts faster than email"));
});

test("an account written without its domain is still the account, not a person", async () => {
  // The live server's other two identifier subjects, which the task's `name LIKE '%@%'` could not
  // see: "omariij20" and "omariij25 and omariij16", holding four more rows of account bookkeeping.
  // About half the time the extraction model dropped the domain.
  const BARE = "dm:bare-labels";
  db.upsertAccount({ conversationId: BARE, channel: "test", address: "+17183062728", name: "Omari", isOperator: true });
  for (const label of ["omariij20@gmail.com", "omariij25@gmail.com", "omariij16@gmail.com"]) {
    db.connectAccount(BARE, `gmail:${label}`, [], { account: label });
  }
  const callBare = (n, i = {}) => runTool(n, i, { conversationId: BARE });

  await callBare("remember", { about: "omariij20", fact: "keeps the LegalZoom paperwork here" });
  await callBare("remember", { about: "omariij25 and omariij16", fact: "holds the older mail" });

  const out = await callBare("recall", {});
  assert.equal(out.count, 1, "one subject: him, not one per way of writing his accounts");
  assert.deepEqual((await callBare("recall", { about: "Omari" })).people[0].facts.map(f => f.fact),
    ["keeps the LegalZoom paperwork here", "holds the older mail"]);

  // And the state rows that sat under those two bare subjects go, same as under the full addresses.
  for (const fact of [
    "The account omariij20 was disconnected at 10:58.",
    "Google account omariij20 was reconnected with Gmail and Calendar access, but without Drive access",
    "Still connected accounts after omariij20 was disconnected",
    "Email accounts omariij25 and omariij16 are still connected.",
    "User has linked Google accounts omariij25 and omariij16 in addition to omariij20.",
    // The shortest live rows of the lot. They carry no word like "account" to anchor on, so the
    // label itself has to count as naming the account — the dry run found these being refiled onto
    // Omari as facts about him once the bare subjects started resolving.
    "omariij25 is still connected.",
    "omariij16 is still connected.",
  ]) {
    assert.equal((await callBare("remember", { about: "Omari", fact })).redundant, "account_state", fact.slice(0, 44));
  }
  assert.equal((await callBare("recall", { about: "Omari" })).people[0].facts.length, 2, "none of them landed");
});

test("a letters-only local part is a name, and a different person keeps it", async () => {
  // The boundary that makes the rule above safe to have. The digit in "omariij20" is what proves it
  // is an account; "john" proves nothing, and the owner of john@gmail.com has a conversation full of
  // Johns who are not him. Folding them onto him is worse than a stray subject — the same trade #31
  // made when it left third-person pronouns alone.
  const JOHN = "dm:letters-only";
  db.upsertAccount({ conversationId: JOHN, channel: "test", address: "+17183062729", name: "Omari", isOperator: true });
  db.connectAccount(JOHN, "gmail", [], { account: "john@gmail.com" });
  const callJohn = (n, i = {}) => runTool(n, i, { conversationId: JOHN });

  await callJohn("remember", { about: "John", fact: "runs the Tuesday five-a-side" });

  const john = await callJohn("recall", { about: "John" });
  assert.equal(john.count, 1, "John is his own subject");
  assert.deepEqual(john.people[0].facts.map(f => f.fact), ["runs the Tuesday five-a-side"]);
  assert.equal((await callJohn("recall", { about: "Omari" })).count, 0, "and nothing was folded onto the owner");
});

test("an identifier that is not theirs is refused, not filed onto whoever owns the thread", async () => {
  // The live row this pins: "+1 (616) 410-2992" sat as a subject inside the owner's own
  // conversation, and that number is Kwesi's. Resolving identifiers onto the account holder would
  // have put another tester's facts onto Omari — the exact misfiling #31 kept pronouns away from.
  const out = await callOwned("remember", { about: "+1 (616) 410-2992", fact: "prefers mornings" });
  assert.equal(out.ok, false, "refused out loud, not reported as a quiet success");
  assert.equal(out.refused, "identifier", "and says why");
  assert.match(out.error, /under the person's NAME/, "and what to do instead");

  assert.equal((await callOwned("recall", { about: "616" })).count, 0, "no subject named after a number");
  assert.ok(!(await callOwned("recall", { about: "Omari" })).people.some(p =>
    p.facts.some(f => f.fact === "prefers mornings")), "and it did not land on Omari either");

  const stranger = await callOwned("remember", { about: "someone.else@example.com", fact: "prefers mornings" });
  assert.equal(stranger.refused, "identifier", "an email that is not theirs is refused the same way");
});

test("an account being connected or disconnected is not a fact about a person", async () => {
  // All nine wordings the extraction model actually produced for one morning's reconnect.
  for (const f of [
    "Google account was disconnected and its sign-in removed from the assistant's side.",
    "The Google account omariij20@gmail.com was disconnected and its sign-in removed from the assistant's side",
    "Account omariij20@gmail.com was disconnected at the user's request",
    "Email account omariij20@gmail.com was disconnected at 10:58, confirmed by the assistant.",
    "Google account omariij20@gmail.com was being reconnected (OAuth link sent) alongside existing accounts omariij25 and omariij16",
    "Google account omariij20@gmail.com was reconnected through an OAuth link and is now connected alongside omariij25 and omariij16",
    "Google account omariij20@gmail.com was reconnected with mail and calendar access but without Drive access",
    "omariij20@gmail.com is listed alongside omariij25 and omariij16 as connected accounts",
    "Google account omariij20@gmail.com was reconnected with mail and calendar access; it does not have drive access.",
  ]) {
    const out = await callOwned("remember", { about: "omariij20@gmail.com", fact: f });
    assert.equal(out.redundant, "account_state", `"${f.slice(0, 48)}…" is connected_accounts' to say`);
    assert.equal(out.already_knew, true, "nothing new was learned");
  }
  assert.equal((await callOwned("recall", {})).count, 0, "nine wordings, nine nothings, and no stray subject");
});

test("which subscriptions bill to an account is the subscriptions table's to say", async () => {
  for (const f of [
    "Subscriptions Claude Max, Luma, Netlify, and Loom come from this account's emails",
    "Subscriptions Spotify, ElevenLabs, and Total Wireless come from this account's emails",
  ]) {
    assert.equal((await callOwned("remember", { about: "omariij16@gmail.com", fact: f })).redundant, "account_state");
  }
  assert.equal((await callOwned("recall", {})).count, 0, "both were already stale copies of subscriptions.source");
});

test("a real fact is kept, whatever words it happens to use", async () => {
  // The guard is gated on the fact being about an account Reason actually holds, so ordinary
  // sentences are untouched even when they use the same verbs.
  await callOwned("remember", { about: "Ama", fact: "disconnected from her family years ago" });
  await callOwned("remember", { about: "Kofi", fact: "reconnected with an old school friend" });
  await callOwned("remember", { about: "Omari", fact: "wants to cancel the Netflix subscription" });
  await callOwned("remember", { about: "Irene", fact: "got her Google account back last week" });

  assert.equal((await callOwned("recall", {})).count, 4, "none of these is account bookkeeping");
  assert.deepEqual((await callOwned("recall", { about: "Ama" })).people[0].facts.map(f => f.fact),
    ["disconnected from her family years ago"]);
});

test("what they made of a change to their account is theirs, and is kept", async () => {
  // Found by the dry run against the live database, not by any of the tests above: matching the word
  // "disconnected" anywhere dropped the one row in the whole set worth having. The account's state
  // is already held in `connected_accounts`; how Omari felt about it being changed under him is held
  // nowhere else, and it is the reason Reason says something before it disconnects anything.
  const FELT = "dm:account-feelings";
  db.upsertAccount({ conversationId: FELT, channel: "test", address: "+17183062727", name: "Omari", isOperator: true });
  db.connectAccount(FELT, "gmail", [], { account: "omariij20@gmail.com" });
  const callFelt = (n, i = {}) => runTool(n, i, { conversationId: FELT });

  const kept = [
    "User expressed frustration that the assistant disconnected omariij20@gmail.com without telling them",
    "User asked to disconnect the account omariij20@gmail.com; the assistant reported it was already disconnected at 10:58 while the user's texts were off.",
  ];
  for (const fact of kept) {
    const out = await callFelt("remember", { about: "Omari", fact });
    assert.equal(out.redundant, undefined, `"${fact.slice(0, 44)}…" is about him, not about the account`);
  }
  assert.deepEqual((await callFelt("recall", { about: "Omari" })).people[0].facts.map(f => f.fact), kept);

  // The bare state in the same breath still goes, so narrowing it did not open the gate back up.
  assert.equal((await callFelt("remember", {
    about: "Omari", fact: "Has three Gmail accounts connected: omariij20@gmail.com, omariij25@gmail.com, and omariij16@gmail.com",
  })).redundant, "account_state");
  assert.equal((await callFelt("recall", { about: "Omari" })).people[0].facts.length, 2, "nothing new landed");
});

test("an identifier before the owner has a name is left alone rather than guessed at", async () => {
  const FRESH = "dm:no-name-identifier";
  db.upsertAccount({ conversationId: FRESH, channel: "test", address: "+13335559999", isOperator: false });
  db.connectAccount(FRESH, "gmail", [], { account: "nobody@example.com" });
  const callFresh = (n, i = {}) => runTool(n, i, { conversationId: FRESH });

  const out = await callFresh("remember", { about: "nobody@example.com", fact: "likes oat milk" });
  assert.equal(out.refused, "identifier", "theirs, but there is no name to file it under yet");
  assert.equal((await callFresh("recall", {})).count, 0, "and no inbox-shaped subject left behind");
});

test("the identifier backlog gets its own pass, once", () => {
  // Exactly the live shape: three subjects that are the owner's own Google addresses, one that is
  // another tester's phone number, and eleven facts of account bookkeeping underneath them.
  const BACK = "dm:identifier-backlog";
  db.upsertAccount({ conversationId: BACK, channel: "test", address: "+17183061111", name: "Omari", isOperator: true });
  for (const label of ["omariij16@gmail.com", "omariij25@gmail.com", "omariij20@gmail.com"]) {
    db.connectAccount(BACK, `gmail:${label}`, [], { account: label });
  }

  const subject = name => Number(db.db.prepare("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(BACK, name, db.personKey(name), clock.now(), clock.now()).lastInsertRowid);
  const add = (personId, fact, at) => Number(db.db.prepare(
    `INSERT INTO person_facts (person_id, fact, created_at, valid_from, status, confidence, source, source_message_ids, category)
     VALUES (?, ?, ?, ?, 'active', 1.0, 'inferred', '[]', '')`).run(personId, fact, at, at).lastInsertRowid);

  const t = clock.now();
  const omari = db.upsertPerson(BACK, "Omari");
  add(omari.id, "allergic to shellfish", t);

  const p16 = subject("omariij16@gmail.com");
  const p25 = subject("omariij25@gmail.com");
  const p20 = subject("omariij20@gmail.com");
  const phone = subject("+1 (616) 410-2992");

  add(p16, "Subscriptions Claude Max, Luma, Netlify, and Loom come from this account's emails", t + 1);
  add(p25, "Subscriptions Spotify, ElevenLabs, and Total Wireless come from this account's emails", t + 2);
  for (const [i, f] of [
    "Google account was disconnected and its sign-in removed from the assistant's side.",
    "The Google account omariij20@gmail.com was disconnected and its sign-in removed from the assistant's side",
    "Account omariij20@gmail.com was disconnected at the user's request",
    "Email account omariij20@gmail.com was disconnected at 10:58, confirmed by the assistant.",
    "Google account omariij20@gmail.com was being reconnected (OAuth link sent) alongside existing accounts omariij25 and omariij16",
    "Google account omariij20@gmail.com was reconnected through an OAuth link and is now connected alongside omariij25 and omariij16",
    "Google account omariij20@gmail.com was reconnected with mail and calendar access but without Drive access",
    "omariij20@gmail.com is listed alongside omariij25 and omariij16 as connected accounts",
    "Google account omariij20@gmail.com was reconnected with mail and calendar access; it does not have drive access.",
  ].entries()) add(p20, f, t + 10 + i);

  // One genuine personal fact, mis-filed under the owner's own address: this is what resolution is
  // for, and what refusing every identifier subject outright would have thrown away.
  const keeper = add(p20, "keeps the LegalZoom paperwork in this inbox", t + 40);
  db.db.prepare("INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, model, created_at) VALUES (?, ?, 'person_facts', ?, 'test', ?)")
    .run(BACK, keeper, Buffer.alloc(8), t);
  const doomed = add(p20, "omariij20@gmail.com is connected again", t + 41);
  db.db.prepare("INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, model, created_at) VALUES (?, ?, 'person_facts', ?, 'test', ?)")
    .run(BACK, doomed, Buffer.alloc(8), t);

  const out = db.tidyIdentifierSubjects();
  assert.equal(out.already_done, false);
  assert.equal(out.state_facts, 12, "nine reconnect wordings, two subscription lists, one more");
  assert.equal(out.resolved, 3, "three of the owner's own addresses folded onto him");
  assert.equal(out.refiled, 1, "and the one real fact under them came with");
  assert.equal(out.emptied, 1, "the other tester's number was empty, so it went");
  assert.deepEqual(out.left, [], "nothing had to be left behind");

  const facts = db.recall(BACK, "Omari");
  assert.equal(facts.length, 1, "one subject where there were five");
  assert.deepEqual(facts[0].facts.map(f => f.fact),
    ["allergic to shellfish", "keeps the LegalZoom paperwork in this inbox"]);
  assert.equal(db.recall(BACK, "").length, 1, "no identifier-shaped subject survives");

  const vectors = db.db.prepare("SELECT fact_id FROM fact_embeddings WHERE conversation_id = ?").all(BACK).map(r => r.fact_id);
  assert.deepEqual(vectors, [keeper], "a dropped fact's vector went with it");

  const again = db.tidyIdentifierSubjects();
  assert.equal(again.already_done, true, "it does not run twice");
  assert.equal(db.recall(BACK, "Omari")[0].facts.length, 2, "and nothing moved on a second call");
});

test("a non-resolvable identifier that still holds facts is left alone and reported", () => {
  // The safe half of the backlog rule. Whose these are is exactly what is not established, so the
  // pass neither merges them onto the account holder nor deletes them — it says where they are.
  const BACK = "dm:identifier-stranger";
  db.upsertAccount({ conversationId: BACK, channel: "test", address: "+17183069999", name: "Omari", isOperator: true });
  const stray = Number(db.db.prepare("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(BACK, "+1 (616) 410-2992", "+1 (616) 410-2992", clock.now(), clock.now()).lastInsertRowid);
  db.db.prepare(`INSERT INTO person_facts (person_id, fact, created_at, valid_from, status, confidence, source, source_message_ids, category)
     VALUES (?, 'prefers mornings', ?, ?, 'active', 1.0, 'inferred', '[]', '')`).run(stray, clock.now(), clock.now());

  const out = db.tidyIdentifierSubjects();
  assert.equal(out.resolved, 0);
  assert.equal(out.emptied, 0, "it holds something, so it is not deleted");
  assert.deepEqual(out.left, [{ subject: "+1 (616) 410-2992", conversation_id: BACK, facts: 1 }]);
  assert.equal(db.recall(BACK, "Omari").length, 0, "and nothing was guessed onto the account holder");
});
