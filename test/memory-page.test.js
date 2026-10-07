// What Reason remembers about you, on one page, and every line of it yours to change.
//
// `recall` could already answer "what do you know about Kofi". What nobody could see — and therefore
// nobody could correct — was the other three things shaping what Reason says: what it is GUESSING,
// what it has worked out about their taste, and what they have told it to do without asking. So four
// sections, with a number on every row, and the four rules worth a test each:
//
//   1. Each of the four sections renders from rows, and an empty one is not a section.
//   2. A correction changes exactly one row — and the old reading stops existing anywhere it was used:
//      not in the page, not in the text answer, and not in the saved thread, which is the one that
//      matters, because the thread is what the model reads on the very next turn.
//   3. **A guess is never promoted to a fact without the person saying so.** Reading the same thing off
//      a picture a hundred times leaves it a guess. One sentence from them makes it a fact.
//   4. A standing permission is not corrected or dropped here: that is `permission_revoke`, which is
//      the only path the gate reads. A second way to revoke is a second way to get it wrong.
//
// No model anywhere in here. No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-memory-page-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { clock, config } = await import("../src/config.js");
const memory = await import("../src/memory.js");
const { checkContent } = await import("../src/pages/content.js");
const { exportData, deleteData } = await import("../src/data.js");

const C = "dm:page";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM person_facts; DELETE FROM people; DELETE FROM memories; DELETE FROM guesses;
    DELETE FROM preferences; DELETE FROM permissions; DELETE FROM confirmations; DELETE FROM action_ledger;
    DELETE FROM conversations; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM schema_meta;`);
  config.noticePerDay = 1;
  config.noticeHardCap = 3;
});

const call = (name, input = {}, extra = {}) => runTool(name, input, { conversationId: C, messages: [], ...extra });

/** One of each: a fact, a guess, a taste, a permission. */
async function fillAllFour() {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });
  await call("remember", { about: "Omari", fact: "bought a civic", source: "i_saw_it_in_a_photo" });
  await call("taste_note", { category: "price", said: "way too expensive for a tuesday", turned_down: "Carbone, $$$$" });
  db.grantPermission(C, { said: "you can reorder the groceries without asking me", action: "purchases", target: "groceries" });
}

// ---------- 1. four sections, each off rows ----------

test("each of the four sections renders from rows, with a number on every line", async () => {
  await fillAllFour();
  const out = await call("memory_page", {});
  assert.equal(out.ok, true, JSON.stringify(out));

  assert.deepEqual(out.facts.map(f => [f.about, f.fact]), [["Kofi", "allergic to shellfish"]]);
  assert.deepEqual(out.guesses.map(g => g.guess), ["bought a civic"]);
  assert.match(out.guesses[0].how, /read this off a picture/);
  assert.deepEqual(out.preferences.map(p => p.they_said), ["way too expensive for a tuesday"]);
  assert.equal(out.preferences[0].category, "price");
  assert.deepEqual(out.permissions.map(p => p.they_said), ["you can reorder the groceries without asking me"]);
  assert.equal(out.permissions[0].what_it_covers, "buying things", "in words, not the scope's name");
  for (const section of ["facts", "guesses", "preferences", "permissions"]) {
    for (const row of out[section]) assert.ok(Number.isInteger(row.id) && row.id > 0, `${section} row has no id`);
  }

  // Every section is on the page, under its own heading, with the numbers on it.
  const page = checkContent(out.page_blocks);
  assert.equal(page.ok, true, JSON.stringify(page));
  const titles = page.blocks.filter(b => b.type === "section").map(b => b.title);
  assert.deepEqual(titles, [
    "What you told me", "What I'm guessing", "What you've turned down",
    "What I can do without asking", "How much I speak up on my own",
  ]);
  const text = JSON.stringify(page.blocks);
  assert.match(text, /allergic to shellfish/);
  assert.match(text, /bought a civic/);
  assert.match(text, /way too expensive for a tuesday/);
  assert.match(text, /reorder the groceries/);
  assert.match(text, /#\d+/, "the numbers are on the page, because they are how a line gets fixed");
  // And the page says out loud that the guesses are guesses.
  assert.match(text, /Guesses, not facts/);
});

test("the text answer carries all four too, in order, and is told to answer off nothing else", async () => {
  // The page is the easy half: code writes it, so code can be held to it. The answer somebody gets
  // in a text is written by the model, and all code has there is what it hands over. Two rows of one
  // section and a model's own sense of what is interesting is how three sections quietly vanish, so
  // the instruction naming the four and their order is worth a test of its own.
  await fillAllFour();
  const out = await call("memory_page", {});
  for (const section of ["facts", "guesses", "preferences", "permissions"]) {
    assert.equal(out[section].length, 1, `${section} is in the result the answer is written from`);
  }
  const order = ["TOLD you", "GUESSING", "turned down", "may do without asking"];
  let at = -1;
  for (const bit of order) {
    const next = out.note.indexOf(bit);
    assert.ok(next > at, `"${bit}" is named in the answer's instruction, after the one before it`);
    at = next;
  }
  assert.match(out.note, /Answer from this and nothing else/, "no answering off its own recollection");
  assert.match(out.note, /Put the numbers in/, "the numbers go in the text, not only on the page");
  assert.match(out.note, /change or delete any line/);
  assert.match(out.note, /page for the full list/, "and the page is offered rather than the whole wall sent");

  // The standing rule says the same thing, because the answer is written on the turn after this one
  // and the note is gone by the turn after that.
  const { SYSTEM } = await import("../src/agent.js");
  assert.match(SYSTEM, /"What do you remember about me"[^\n]*memory_page, always, never your own recollection/);
  assert.match(SYSTEM, /Say the guesses AS guesses/);
  assert.match(SYSTEM, /permission_revoke, never memory_fix/);
});

test("an empty section is not a section, and nothing known at all says so in one line", async () => {
  const empty = await call("memory_page", {});
  assert.deepEqual(empty.counts, { facts: 0, guesses: 0, preferences: 0, permissions: 0, commitments: 0 });
  assert.match(empty.note, /do not know anything about them yet/);
  assert.match(empty.note, /never invent a single row/);
  const page = checkContent(empty.page_blocks);
  assert.equal(page.ok, true, JSON.stringify(page));
  const titles = page.blocks.filter(b => b.type === "section").map(b => b.title);
  // The two that are honest when empty stay — "nothing, everything asks" is worth saying, and so is
  // how much it speaks up. The three lists of rows do not appear at all.
  assert.deepEqual(titles, ["What I can do without asking", "How much I speak up on my own"]);
  assert.match(JSON.stringify(page.blocks), /Every single thing that spends your money/);

  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });
  const some = await call("memory_page", {});
  const only = checkContent(some.page_blocks).blocks.filter(b => b.type === "section").map(b => b.title);
  assert.ok(!only.includes("What I'm guessing"), "no guesses means no guesses section");
  assert.ok(!only.includes("What you've turned down"));
});

test("the page shows their initiative setting, and timely is the default nobody chose", async () => {
  const out = await call("memory_page", {});
  assert.equal(out.initiative.set_to, "timely");
  assert.equal(out.initiative.is_the_default, true, "nobody has changed it");
  assert.equal(out.initiative.at_most_a_day, 1);
  assert.equal(out.initiative.hard_cap_a_day, 3);
  assert.equal(out.initiative.hours_are, "a default nobody has confirmed with them yet");
  const blocks = JSON.stringify(out.page_blocks);
  assert.match(blocks, /the default — you have not changed it/);
  // The page is addressed to the person, so it says it in the second person rather than about them.
  assert.match(blocks, /a guess until you tell me otherwise/);
  assert.ok(!blocks.includes("confirmed with them"), "the page talks to them, not about them");

  // Once they have said something, it is theirs and the page stops calling it a default.
  await call("notice_mode", { mode: "digest", said: "just text me once in the evening", digest_hour: 18 });
  await call("notice_window", { said: "i'm in london now, don't text me before 9", time_zone: "Europe/London", awake_from: 9, awake_until: 22 });
  const after = await call("memory_page", {});
  assert.equal(after.initiative.set_to, "digest");
  assert.equal(after.initiative.is_the_default, false);
  assert.equal(after.initiative.digest_at, "18:00");
  assert.equal(after.initiative.time_zone, "Europe/London");
  assert.equal(after.initiative.hours_are, "what they told you");
  const afterBlocks = JSON.stringify(after.page_blocks);
  assert.match(afterBlocks, /9:00-22:00 Europe\/London/);
  assert.match(afterBlocks, /what you told me/);
  assert.ok(!afterBlocks.includes("a guess until you tell me otherwise"));
});

// ---------- 2. a correction changes one row, everywhere ----------

test("a correction changes exactly one row, and the old reading is gone from page, answer and thread", async () => {
  await call("remember", { about: "Ama", fact: "is his sister", source: "they_said" });
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });
  const before = await call("memory_page", {});
  const ama = before.facts.find(f => f.fact === "is his sister");
  const kofi = before.facts.find(f => f.about === "Kofi");

  // The wrong reading in the thread, in both the places it really lives: a saved tool result, and
  // something Reason itself said off the back of it.
  db.saveConversation(C, [
    { role: "user", content: "who's ama again" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "ama is his sister, right?" },
        { type: "tool_use", id: "t1", name: "recall", input: { about: "Ama" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ people: [{ about: "Ama", facts: [{ fact: "is his sister" }] }] }) }] },
  ]);

  const fix = await call("memory_fix", { row: "fact", id: ama.id, said: "ama's my cousin not my sister", instead: "is his cousin" });
  assert.equal(fix.ok, true, JSON.stringify(fix));
  assert.equal(fix.was, "is his sister");
  assert.equal(fix.now, "is his cousin");
  assert.equal(fix.their_words, "ama's my cousin not my sister");

  // Exactly one row moved.
  assert.equal(db.getFact(C, ama.id).fact, "is his cousin");
  assert.equal(db.getFact(C, kofi.id).fact, "allergic to shellfish");

  // And the old reading is nowhere a next turn could read it.
  const after = await call("memory_page", {});
  const page = JSON.stringify(after.page_blocks);
  assert.ok(!page.includes("is his sister"), "not on the page");
  assert.match(page, /is his cousin/);
  assert.ok(!JSON.stringify(after.facts).includes("is his sister"), "not in the text answer's data");

  const thread = JSON.stringify(db.loadConversation(C));
  assert.ok(!thread.includes("is his sister"), "not in the saved thread either");
  assert.match(thread, /deleted at their request/, "the line Reason said was rewritten, not removed");
  assert.ok(fix.also_cleared.tool_results >= 1, JSON.stringify(fix.also_cleared));
  assert.ok(fix.also_cleared.things_you_said >= 1, JSON.stringify(fix.also_cleared));
});

test("a correction needs their own words, and a number that exists", async () => {
  await call("remember", { about: "Ama", fact: "is his sister", source: "they_said" });
  const id = (await call("memory_page", {})).facts[0].id;

  const noWords = await call("memory_fix", { row: "fact", id, said: "   ", instead: "is his cousin" });
  assert.equal(noWords.ok, false);
  assert.match(noWords.error, /word for word/);
  assert.equal(db.getFact(C, id).fact, "is his sister", "nothing moved");

  const noNew = await call("memory_fix", { row: "fact", id, said: "she's my cousin" });
  assert.equal(noNew.ok, false);
  assert.match(noNew.error, /instead/);

  const wrongId = await call("memory_fix", { row: "fact", id: id + 999, said: "she's my cousin", instead: "is his cousin" });
  assert.equal(wrongId.ok, false);
  assert.match(wrongId.error, /no saved fact/);
  assert.match(wrongId.error, /memory_page for the real numbers/);
});

test("a correction cannot quietly collapse two facts into one", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });
  await call("remember", { about: "Kofi", fact: "always late", source: "they_said" });
  const rows = (await call("memory_page", {})).facts;
  const late = rows.find(f => f.fact === "always late");

  const out = await call("memory_fix", { row: "fact", id: late.id, said: "he's allergic to shellfish", instead: "allergic to shellfish" });
  assert.equal(out.ok, false);
  assert.match(out.error, /already saved about Kofi/);
  assert.equal(db.getFact(C, late.id).fact, "always late", "both rows survive");
  assert.equal((await call("memory_page", {})).counts.facts, 2);
});

test("a preference and a guess are corrected the same way, by id", async () => {
  await call("taste_note", { category: "price", said: "too pricey", turned_down: "Carbone" });
  await call("remember", { about: "Omari", fact: "bought a civic", source: "i_saw_it_in_a_photo" });
  const got = await call("memory_page", {});

  const pref = await call("memory_fix", {
    row: "preference", id: got.preferences[0].id, said: "it's not the money, it's that it's always rammed",
    instead: "it's always rammed in there", category: "vibe",
  });
  assert.equal(pref.ok, true, JSON.stringify(pref));
  assert.equal(db.getPreference(C, got.preferences[0].id).category, "vibe");
  assert.equal(db.getPreference(C, got.preferences[0].id).words, "it's always rammed in there");

  const guess = await call("memory_fix", {
    row: "guess", id: got.guesses[0].id, said: "that's my mate's car", instead: "a friend of his drives a civic",
  });
  assert.equal(guess.ok, true, JSON.stringify(guess));
  assert.equal(db.getGuess(C, got.guesses[0].id).guess, "a friend of his drives a civic");
  assert.ok(db.getGuess(C, got.guesses[0].id).corrected_at);
});

test("one row dropped is one row gone, and the copies of it go too", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });
  await call("remember", { about: "Kofi", fact: "always late", source: "they_said" });
  const rows = (await call("memory_page", {})).facts;
  const late = rows.find(f => f.fact === "always late");
  db.saveConversation(C, [
    { role: "user", content: "what do you know about kofi" },
    { role: "assistant", content: [{ type: "text", text: "he's always late and allergic to shellfish" }] },
  ]);

  const out = await call("memory_drop", { row: "fact", id: late.id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.dropped, "always late");
  const after = await call("memory_page", {});
  assert.deepEqual(after.facts.map(f => f.fact), ["allergic to shellfish"], "the other one is untouched");
  assert.ok(!JSON.stringify(db.loadConversation(C)).includes("always late"));

  // The subject survives: forgetting one thing about somebody is not forgetting them.
  assert.equal((await call("recall", { about: "Kofi" })).count, 1);
  assert.equal(await call("memory_drop", { row: "fact", id: late.id }).then(r => r.ok), false, "and not twice");
});

// ---------- 3. a guess is never promoted without them saying so ----------

test("a guess stays a guess however many times it is read, and only they can make it a fact", async () => {
  // Four readings of the same thing off two different sources. None of them is a fact.
  for (const how of ["i_saw_it_in_a_photo", "i_worked_it_out", "i_saw_it_in_a_photo", "i_worked_it_out"]) {
    const no = await call("remember", { about: "Omari", fact: "bought a civic", source: how });
    assert.equal(no.ok, false);
    assert.equal(no.refused, "not_something_they_said");
    assert.ok(no.kept_as_a_guess, "the reading is kept rather than thrown away");
    assert.match(no.error, /as a GUESS/);
  }
  const got = await call("memory_page", {});
  assert.equal(got.counts.facts, 0, "four readings made no facts");
  assert.equal(got.counts.guesses, 1, "and one guess, not four");
  assert.equal((await call("recall", { about: "Omari" })).count, 0, "recall does not know it at all");

  // The page never states it as a fact, and the text answer is told not to either.
  assert.match(got.note, /AS guesses/);
  assert.match(JSON.stringify(got.page_blocks), /Nobody told me any of these/);

  // Then they say it. That, and nothing else, makes it a fact.
  const yes = await call("remember", { about: "Omari", fact: "bought a civic", source: "they_said" });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(yes.was_a_guess_until_now, got.guesses[0].id);
  assert.match(yes.note, /it is a fact now/);

  const now = await call("memory_page", {});
  assert.deepEqual(now.facts.map(f => f.fact), ["bought a civic"]);
  assert.equal(now.counts.guesses, 0, "it has come off the guesses list");
});

test("being told something else about the same person does not confirm the guess", async () => {
  await call("remember", { about: "Omari", fact: "bought a civic", source: "i_worked_it_out" });
  await call("remember", { about: "Omari", fact: "lives in Bed-Stuy", source: "they_said" });
  const got = await call("memory_page", {});
  assert.deepEqual(got.facts.map(f => f.fact), ["lives in Bed-Stuy"]);
  assert.deepEqual(got.guesses.map(g => g.guess), ["bought a civic"], "still a guess");
});

test("a guess with a card number in it is not kept at all", async () => {
  const out = await call("remember", { about: "Omari", fact: "his card is 4111 1111 1111 1111", source: "i_saw_it_in_a_photo" });
  assert.equal(out.ok, false);
  assert.equal(out.kept_as_a_guess, undefined, "a credential is refused outright, not kept as a guess");
  assert.equal((await call("memory_page", {})).counts.guesses, 0);
});

test("forgetting a person takes the guesses about them too", async () => {
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });
  await call("remember", { about: "Kofi", fact: "is seeing somebody from work", source: "i_worked_it_out" });
  assert.equal((await call("memory_page", {})).counts.guesses, 1);

  const out = await call("forget", { about: "Kofi" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.guesses_dropped, 1);
  const after = await call("memory_page", {});
  assert.equal(after.counts.facts, 0);
  assert.equal(after.counts.guesses, 0, "a forget that left the guess behind would be the same bug in a new place");
});

// ---------- 4. a permission is revoked through the one path the gate reads ----------

test("a permission is not corrected or dropped from here — it is revoked", async () => {
  db.grantPermission(C, { said: "you can reorder the groceries without asking me", action: "purchases", target: "groceries" });
  const got = await call("memory_page", {});
  const id = got.permissions[0].id;
  assert.match(got.how_to_correct, /permission_revoke/);

  // The schema does not even offer 'permission' as a row, so the attempt is refused before it runs.
  for (const name of ["memory_fix", "memory_drop"]) {
    const out = await call(name, { row: "permission", id, said: "actually ask me about the groceries", instead: "nothing" });
    assert.equal(out.ok, false, `${name} should refuse`);
  }
  assert.equal(db.listPermissions(C).length, 1, "still standing, and still the gate's to read");

  // The real path works and is what writes revoked_at.
  const gone = await call("permission_revoke", { permission_id: id });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.ok(db.getPermission(C, id).revoked_at);
  assert.equal((await call("memory_page", {})).counts.permissions, 0, "and it comes off the page");
});

test("a revoked permission is off the page, but it was their words and the record keeps them", async () => {
  const p = db.grantPermission(C, { said: "you can reorder the groceries", action: "purchases", target: "groceries" });
  db.revokePermission(C, p.id);
  assert.equal((await call("memory_page", {})).counts.permissions, 0);
  assert.equal(db.listPermissions(C, { includeClosed: true }).length, 1);
});

// ---------- theirs, like everything else ----------

test("an export carries the guesses, and a delete takes them", async () => {
  await fillAllFour();
  const out = exportData({ conversation: C, audio: false });
  assert.equal(out.tables.guesses.length, 1);
  assert.equal(out.tables.guesses[0].guess, "bought a civic");
  assert.equal(out.tables.preferences.length, 1);
  assert.equal(out.tables.permissions.length, 1);
  assert.equal(out.tables.person_facts.length, 1);

  const gone = await deleteData({ conversation: C, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });
  assert.equal(gone.rows.guesses, 1);
  assert.equal(gone.rows.preferences, 1);
  assert.deepEqual((await call("memory_page", {})).counts, { facts: 0, guesses: 0, preferences: 0, permissions: 0, commitments: 0 });
});

test("one person's page is not another's", async () => {
  const other = "dm:somebody-else";
  db.upsertAccount({ conversationId: other, channel: "test", address: "+14445550000", name: "Ama", isOperator: false });
  await fillAllFour();
  const theirs = memory.remembered({ conversationId: other });
  assert.deepEqual(theirs.counts, { facts: 0, guesses: 0, preferences: 0, permissions: 0, commitments: 0 });
  // And not reachable by id either, which is what makes a number safe to text back.
  const mine = await call("memory_page", {});
  assert.equal(db.getFact(other, mine.facts[0].id), null);
  assert.equal(db.getGuess(other, mine.guesses[0].id), null);
  assert.equal(db.getPreference(other, mine.preferences[0].id), null);
});
