// Taste: what they turned down, and why — and the line it is never allowed to cross.
//
// A rejection was already the best-recorded thing on a task sheet: the model has to read WHY, give
// it one of five categories, and keep their own sentence. What it was not was durable. The apartment
// hunt knew the two places turned down; the dinner three weeks later knew nothing, and asked them
// about a price bracket they had already said no to.
//
// So four things are under test here, and the last one is the one that matters most:
//
//   1. A rejection on a sheet becomes a preference, once, with its category and their verbatim words.
//   2. It reaches the NEXT pick — a different task, a later turn — through the sheet the model is
//      handed, not through anything it has to remember to look up.
//   3. It is theirs: correctable and droppable by id, and in the export and the delete.
//   4. **A preference is never a permission.** A stored taste cannot open a gated action. The gate
//      reads the permissions table and has never read this one, and this file is what keeps that
//      true the day somebody is tempted to wire them together.
//
// No model anywhere in here. No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-taste-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");
const { READINGS } = await import("../src/sheet.js");
const { openWorkNote } = await import("../src/openwork.js");
const { exportData, deleteData } = await import("../src/data.js");

const C = "dm:taste";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM preferences; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM permissions;
    DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM conversations; DELETE FROM threads;`);
});

const call = (name, input = {}, extra = {}) => runTool(name, input, { conversationId: C, messages: [], ...extra });

/** A task with two options on it, one of which is about to be turned down. */
function dinnerTask() {
  const t = db.createTask(C, { title: "find somewhere for dinner thursday", goal: "book a table for 4", wakeAt: clock.now() + 60_000, maxAttempts: 3 });
  db.updateTask(C, t.id, {
    sheet: { options: [{ id: "carbone", label: "Carbone, $$$$" }, { id: "lilia", label: "Lilia, $$$" }] },
  });
  return t;
}

// ---------- 1. a rejection becomes a preference ----------

test("a rejected option on the sheet becomes a preference, with its category and their own words", () => {
  const t = dinnerTask();
  const out = db.updateTask(C, t.id, {
    sheet: {
      options: [{
        id: "carbone", status: "rejected",
        rejected_because: { words: "way too expensive for a tuesday", reading: "price" },
      }],
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out));

  const kept = db.listPreferences(C);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].category, "price");
  assert.equal(kept[0].words, "way too expensive for a tuesday", "their sentence, not a tidied version of it");
  assert.equal(kept[0].turned_down, "Carbone, $$$$");
  assert.equal(kept[0].task_id, t.id, "and where it was learned");
  assert.equal(kept[0].note, "", "nothing is invented about what it means");
});

test("the same rejection written twice is one preference", () => {
  const t = dinnerTask();
  const reject = {
    options: [{ id: "carbone", status: "rejected", rejected_because: { words: "too pricey", reading: "price" } }],
  };
  db.updateTask(C, t.id, { sheet: reject });
  // The sheet refuses to re-reject an option, so the second write is the same patch on a second task:
  // the same words about the same thing, which is one preference however many times it is read.
  const t2 = db.createTask(C, { title: "dinner again", goal: "a table", wakeAt: clock.now() + 60_000, maxAttempts: 3 });
  db.updateTask(C, t2.id, { sheet: { options: [{ id: "carbone", label: "Carbone, $$$$" }] } });
  db.updateTask(C, t2.id, { sheet: reject });
  assert.equal(db.listPreferences(C).length, 1, "the list did not get noisier");
});

test("an option rejected without words is refused outright, so no preference is invented", () => {
  const t = dinnerTask();
  const out = db.updateTask(C, t.id, { sheet: { options: [{ id: "carbone", status: "rejected" }] } });
  assert.equal(out.ok, false);
  assert.match(out.error, /verbatim/);
  assert.equal(db.listPreferences(C).length, 0);
});

test("every category the sheet allows is a category a preference can hold", () => {
  for (const [i, reading] of READINGS.entries()) {
    const t = db.createTask(C, { title: `job ${i}`, goal: "x", wakeAt: clock.now() + 60_000, maxAttempts: 3 });
    db.updateTask(C, t.id, { sheet: { options: [{ id: `o${i}`, label: `option ${i}` }] } });
    db.updateTask(C, t.id, {
      sheet: { options: [{ id: `o${i}`, status: "rejected", rejected_because: { words: `no because ${reading}`, reading } }] },
    });
  }
  assert.deepEqual(db.listPreferences(C).map(p => p.category).sort(), [...READINGS].sort());
});

// ---------- 2. it reaches the next pick ----------

test("a rejection on one task reaches the next task's pick", async () => {
  const t = dinnerTask();
  db.updateTask(C, t.id, {
    sheet: { options: [{ id: "carbone", status: "rejected", rejected_because: { words: "way too expensive for a tuesday", reading: "price" } }] },
  });
  db.finishTask(C, t.id, { state: "done", outcome: "booked Lilia" });

  // A brand new job, three weeks later, with nothing of its own on the sheet.
  clock.skip(21 * 24 * 60 * 60 * 1000);
  const later = db.createTask(C, { title: "find a lunch spot for saturday", goal: "somewhere for 2", wakeAt: clock.now() + 60_000, maxAttempts: 3 });
  const view = await call("task_list", {});
  const job = view.tasks.find(x => x.id === later.id);
  assert.ok(job, JSON.stringify(view));
  assert.deepEqual(job.sheet.their_taste.map(x => x.they_said), ["way too expensive for a tuesday"]);
  assert.equal(job.sheet.their_taste[0].category, "price");
  assert.match(job.sheet.taste_note, /turned down before/);
  assert.match(job.sheet.taste_note, /NOT permission/);
  // And it is not a rule: a better option that breaks it is offered with the break said out loud.
  assert.match(job.sheet.taste_note, /say so in the line that offers it/);
});

test("the taste travels in the open-work note, so a turn they started knows it too", () => {
  const t = dinnerTask();
  db.updateTask(C, t.id, {
    sheet: { options: [{ id: "carbone", status: "rejected", rejected_because: { words: "too loud in there", reading: "vibe" } }] },
  });
  const note = openWorkNote(C);
  assert.match(note, /too loud in there/);
});

test("nothing turned down means nothing is said about taste at all", async () => {
  db.createTask(C, { title: "find a plumber", goal: "someone who can come friday", wakeAt: clock.now() + 60_000, maxAttempts: 3 });
  const view = await call("task_list", {});
  assert.equal(view.tasks[0].sheet.their_taste, undefined, "an empty list is not a section");
  assert.equal(view.tasks[0].sheet.taste_note, undefined);
});

// ---------- the tool, for a no with no task behind it ----------

test("taste_note writes a no that happened in conversation, and refuses one with no words", async () => {
  const bad = await call("taste_note", { category: "price", said: "   ", turned_down: "Carbone" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /word for word/);
  assert.equal(db.listPreferences(C).length, 0);

  const out = await call("taste_note", {
    category: "location", said: "not going all the way to brooklyn on a weeknight",
    turned_down: "the place in Bushwick", means: "weeknights stay in manhattan",
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.category, "location");
  assert.equal(out.their_words, "not going all the way to brooklyn on a weeknight");
  assert.equal(out.means, "weeknights stay in manhattan");
  assert.equal(out.already_knew, false);
  assert.match(out.note, /NOT permission/);

  const again = await call("taste_note", {
    category: "location", said: "not going all the way to brooklyn on a weeknight", turned_down: "the place in Bushwick",
  });
  assert.equal(again.already_knew, true);
  assert.equal(db.listPreferences(C).length, 1);
});

// ---------- 4. a preference is never a permission ----------

test("a stored preference cannot open a gated action", async () => {
  // Three tastes, including one that reads exactly like a licence if anybody ever treated it as one.
  await call("taste_note", { category: "price", said: "anything under $40 is fine, just get it", turned_down: "the $90 one" });
  await call("taste_note", { category: "vibe", said: "i always want the aisle seat", turned_down: "the middle seat" });
  await call("taste_note", { category: "timing", said: "mornings are always good", turned_down: "the 8pm slot" });
  assert.equal(db.listPreferences(C).length, 3);

  // Texting somebody else is gated. With three preferences on file and no yes, it is refused exactly
  // as it would be with none — and the refusal does not mention a preference, because a preference is
  // not a near miss on a permission, it is a different kind of thing entirely.
  const send = await call("message_send", { to: "+14155559876", text: "table for 4 at 8?" }, { channels: fakeChannels() });
  assert.equal(send.ok, false, JSON.stringify(send));
  assert.equal(send.blocked, "needs_confirmation");
  assert.equal(send.nearly_covered_by, undefined, "a taste is not a near miss on a permission");

  // And nothing in the permissions table came from any of it.
  assert.deepEqual(db.listPermissions(C, { includeClosed: true }), []);
});

test("a real permission still works, which is what makes the test above mean something", async () => {
  await call("taste_note", { category: "price", said: "anything under $40 is fine", turned_down: "the $90 one" });
  db.grantPermission(C, { said: "you can text the restaurant without asking me", action: "message_send", target: "+14155559876" });

  // The text names who is writing, because a separate guard insists on that — nothing to do with
  // preferences, and the gate is still the thing under test.
  const send = await call("message_send", { to: "+14155559876", text: "hi, this is Reason, Omari's assistant — table for 4 at 8?" }, { channels: fakeChannels() });
  assert.equal(send.ok, true, JSON.stringify(send));
});

/** A texting channel that goes nowhere, so the gate is the only thing under test. */
function fakeChannels() {
  const out = [];
  return { out, list: () => [{ name: "fake" }], send: async (m) => { out.push(m); return { ok: true, delivered: true }; } };
}

// ---------- 3. theirs: correctable, droppable, exported, deleted ----------

test("a preference is corrected by id, and only that row moves", () => {
  const a = db.learnPreference(C, { category: "price", words: "too pricey", turnedDown: "Carbone" });
  const b = db.learnPreference(C, { category: "vibe", words: "too loud", turnedDown: "Lucali" });

  const out = db.correctPreference(C, a.id, { category: "timing", words: "too pricey for a tuesday — fine on a saturday" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.was.words, "too pricey", "the old reading comes back, so it can be taken out of the thread");
  assert.equal(out.preference.category, "timing");
  assert.ok(out.preference.corrected_at);
  assert.equal(db.getPreference(C, b.id).words, "too loud", "the other row did not move");
  assert.equal(db.getPreference(C, b.id).corrected_at, null);
});

test("a dropped preference is really gone, because the row quotes them", () => {
  const a = db.learnPreference(C, { category: "price", words: "too pricey", turnedDown: "Carbone" });
  const out = db.dropPreference(C, a.id);
  assert.equal(out.ok, true);
  assert.equal(out.was.words, "too pricey");
  assert.equal(db.getPreference(C, a.id), null);
  assert.equal(db.listPreferences(C).length, 0);
  assert.equal(db.dropPreference(C, a.id).ok, false, "and it cannot be dropped twice");
});

test("one person's taste is not another's", () => {
  const other = "dm:somebody-else";
  db.upsertAccount({ conversationId: other, channel: "test", address: "+14445550000", name: "Ama", isOperator: false });
  db.learnPreference(C, { category: "price", words: "too pricey", turnedDown: "Carbone" });
  assert.equal(db.listPreferences(other).length, 0);
  assert.equal(db.getPreference(other, db.listPreferences(C)[0].id), null, "and not reachable by id either");
});

test("an export carries their taste, and a delete takes it", async () => {
  db.learnPreference(C, { category: "price", words: "way too expensive for a tuesday", turnedDown: "Carbone" });
  const out = exportData({ conversation: C, audio: false });
  assert.equal(out.tables.preferences.length, 1);
  assert.equal(out.tables.preferences[0].words, "way too expensive for a tuesday");

  const gone = await deleteData({ conversation: C, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });
  assert.equal(gone.rows.preferences, 1);
  assert.equal(db.listPreferences(C).length, 0);
});
