// Noticing a conflict before acting on it.
//
// "Find me the cheapest flight" from somebody who once said "never basic economy" has two
// defensible answers, and neither of them is Reason's. The failure this exists to stop is the
// quiet one: Reason picks a side, honours one instruction, ignores the other, and the person finds
// out at the gate — having never been asked.
//
// So the collision becomes a row on the job's sheet, the row holds anything that would commit, and
// the way out is one line with the tradeoff in it. The resolution is written as a constraint with
// their own words on it, which is what makes it stick and what stops the same question being asked
// twice.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-conflicts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { openConflicts, parseSheet } = await import("../src/sheet.js");

const C = "dm:conflicts";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM confirmations; DELETE FROM people; DELETE FROM person_facts;");
});

const call = (name, input = {}, ctx = {}) => runTool(name, input, { conversationId: C, ...ctx });

/** The flight job: they want cheap, and they have already said never basic economy. */
const flights = () => call("task_start", {
  title: "get me to austin", goal: "a flight out thursday, back sunday",
  sheet: {
    constraints: {
      fare_class: { value: "never basic economy", source: "them", said: "never put me in basic economy" },
      dates: { value: "out thu, back sun", source: "them", said: "out thursday back sunday" },
    },
  },
});

const sheetOf = (id) => parseSheet(db.getTask(C, id).sheet);

// ---------- the collision ----------

test("cheapest against never-basic-economy: written down, held, and the question is one line", async () => {
  const t = await flights();
  const r = await call("conflict_check", {
    task_id: t.task.id,
    ask: "just get me the cheapest one",
    against: "constraint:fare_class",
    tradeoff: "cheapest is $180 but it is basic economy — no seat choice, no bag",
  });
  assert.equal(r.ok, true);
  assert.equal(r.conflict_id, 1);
  assert.equal(r.it_says, "never basic economy");
  assert.equal(r.their_words_before, "never put me in basic economy");
  assert.match(r.note, /do not pick/i);
  assert.match(r.held, /will go through until this is answered/);
  assert.equal(openConflicts(db.getTask(C, t.task.id).sheet).length, 1);
});

test("a conflict against something that is not on the sheet is refused, and nothing is held", async () => {
  const t = await flights();
  const r = await call("conflict_check", {
    task_id: t.task.id, ask: "cheapest", against: "constraint:seat_preference", tradeoff: "cheaper, worse seat",
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no constraint called 'seat_preference'/);
  assert.match(r.error, /write it down first/);
  assert.equal(openConflicts(db.getTask(C, t.task.id).sheet).length, 0);
});

test("a made-up kind of conflict is refused with the three real ones named", async () => {
  const t = await flights();
  const r = await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "vibes", tradeoff: "x or y" });
  assert.equal(r.ok, false);
  assert.match(r.error, /constraint:/);
  assert.match(r.error, /rejected:/);
  assert.match(r.error, /remembered:/);
});

test("a conflict against a saved preference needs the preference to really be saved", async () => {
  const t = await flights();
  const nothing = await call("conflict_check", {
    task_id: t.task.id, ask: "book the steakhouse", against: "remembered:Omari", tradeoff: "steak, or somewhere they can eat",
  });
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /Nothing is saved about 'Omari'/);

  db.remember(C, "Omari", "vegetarian");
  const real = await call("conflict_check", {
    task_id: t.task.id, ask: "book the steakhouse", against: "remembered:Omari", tradeoff: "steak, or somewhere they can eat",
  });
  assert.equal(real.ok, true);
});

test("a conflict against something they turned down carries why they turned it down", async () => {
  const t = await call("task_start", {
    title: "find a place", goal: "a place",
    sheet: { options: [{ id: "graham", label: "441 Graham", status: "rejected", rejected_because: { words: "felt grim", reading: "vibe" } }] },
  });
  const r = await call("conflict_check", {
    task_id: t.task.id, ask: "just take the cheapest of the three", against: "rejected:graham", tradeoff: "cheapest is the one you called grim, or $200 more for the next",
  });
  assert.equal(r.ok, true);
  assert.equal(r.their_words_before, "felt grim");
  assert.match(r.it_says, /turned down on vibe/);
});

// ---------- the hold ----------

test("nothing that commits goes through while the question is out, and nothing is recorded", async () => {
  const t = await flights();
  await call("conflict_check", {
    task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "cheapest is $180 basic, or $240 with a seat",
  });
  const before = db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n;
  const gated = await call("confirm_request", {
    action: "browser_submit", summary: "book the $180 fare to austin", target: "book the $180 fare to austin", task_id: t.task.id,
  });
  assert.equal(gated.ok, false);
  assert.equal(gated.blocked, "conflict_open");
  assert.equal(gated.conflict_id, 1);
  assert.match(gated.error, /that question is still out/i);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n, before, "nothing was asked");
});

test("asking a second time about the same collision does not make a second one", async () => {
  const t = await flights();
  const first = await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "a or b" });
  const again = await call("conflict_check", { task_id: t.task.id, ask: "cheapest please", against: "constraint:fare_class", tradeoff: "a or b" });
  assert.equal(again.already_open, true);
  assert.equal(again.conflict_id, first.conflict_id);
  assert.match(again.note, /do not ask a second time/i);
  assert.equal(openConflicts(db.getTask(C, t.task.id).sheet).length, 1);
});

// ---------- the answer, and it sticking ----------

test("their answer lifts the hold and becomes a constraint in their own words", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "cheapest is $180 basic, or $240 with a seat" });
  const r = await call("conflict_resolve", {
    task_id: t.task.id, conflict_id: 1, keep: "ask",
    said: "yeah basic is fine for this one, it's two hours",
    now_means: "basic economy is fine for this trip only; the standing rule still holds for the rest",
  });
  assert.equal(r.ok, true);
  assert.match(r.note, /no longer held/);
  const sheet = sheetOf(t.task.id);
  assert.equal(openConflicts(sheet).length, 0);
  const settled = sheet.constraints.settled_1;
  assert.equal(settled.source, "them");
  assert.equal(settled.said, "yeah basic is fine for this one, it's two hours");
  assert.match(settled.value, /this trip only/);
  // And the thing they said before is untouched: this was one trip, not a new standing rule.
  assert.equal(sheet.constraints.fare_class.value, "never basic economy");

  const gated = await call("confirm_request", {
    action: "browser_submit", summary: "book the $180 fare to austin", target: "book the $180 fare to austin", task_id: t.task.id,
  });
  assert.equal(gated.ok, true);
});

test("the resolution sticks: the same collision on the next search is not asked again", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "a or b" });
  await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "ask", said: "basic is fine", now_means: "basic economy is fine on this trip" });
  const later = await call("conflict_check", {
    task_id: t.task.id, ask: "find me a cheaper one for the way back", against: "constraint:fare_class", tradeoff: "a or b",
  });
  assert.equal(later.ok, true);
  assert.equal(later.already_settled, true);
  assert.equal(later.they_said, "basic is fine");
  assert.match(later.note, /do NOT ask again/i);
  assert.equal(openConflicts(db.getTask(C, t.task.id).sheet).length, 0, "nothing was held");
});

test("the standing rule can be the side that wins, and then nothing about the job changes", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "a or b" });
  await call("conflict_resolve", {
    task_id: t.task.id, conflict_id: 1, keep: "existing",
    said: "no, not basic, I meant cheapest of the proper ones",
    now_means: "cheapest fare that is not basic economy",
  });
  const sheet = sheetOf(t.task.id);
  assert.equal(sheet.conflicts[0].keep, "existing");
  assert.equal(sheet.constraints.fare_class.value, "never basic economy");
  assert.match(sheet.constraints.settled_1.value, /not basic economy/);
});

test("a resolution without their words is refused: this is them deciding, not Reason reading a tea leaf", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "a or b" });
  const r = await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "ask", said: "   ", now_means: "basic is fine" });
  assert.equal(r.ok, false);
  assert.match(r.error, /verbatim/);
  assert.equal(openConflicts(db.getTask(C, t.task.id).sheet).length, 1, "still held");
});

test("a side that is not one of the two, and settling the same thing twice, are both refused", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "a or b" });
  const bad = await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "both", said: "sure", now_means: "x" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /keep must be one of/);
  await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "ask", said: "basic is fine", now_means: "basic is fine this trip" });
  const twice = await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "existing", said: "actually no", now_means: "y" });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /already settled/i);
});

test("two open collisions hold the job until both are answered", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "a or b" });
  await call("conflict_check", { task_id: t.task.id, ask: "make it wednesday", against: "constraint:dates", tradeoff: "wednesday is $90 more, or keep thursday" });
  const one = await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "ask", said: "basic is fine", now_means: "basic ok this trip" });
  assert.match(one.note, /still held/);
  const gated = await call("confirm_request", { action: "browser_submit", summary: "book it", target: "book it", task_id: t.task.id });
  assert.equal(gated.blocked, "conflict_open");
  await call("conflict_resolve", { task_id: t.task.id, conflict_id: 2, keep: "existing", said: "nah keep thursday", now_means: "thursday stands" });
  assert.equal((await call("confirm_request", { action: "browser_submit", summary: "book it", target: "book it", task_id: t.task.id })).ok, true);
});

test("the model is shown what is open and what is settled, with the instruction not to decide", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "cheapest is $180 basic, or $240 with a seat" });
  const open = (await call("task_list")).tasks[0].sheet;
  assert.equal(open.open_conflicts.length, 1);
  assert.equal(open.open_conflicts[0].tradeoff, "cheapest is $180 basic, or $240 with a seat");
  assert.match(open.open_conflicts_note, /must not pick for them/);

  await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "ask", said: "basic is fine", now_means: "basic ok this trip" });
  const after = (await call("task_list")).tasks[0].sheet;
  assert.equal(after.open_conflicts, undefined);
  assert.equal(after.settled[0].they_said, "basic is fine");
  assert.match(after.settled_note, /never raise one again/);
});

test("the collision and the answer are both in the progress log, so it is answerable later", async () => {
  const t = await flights();
  await call("conflict_check", { task_id: t.task.id, ask: "cheapest", against: "constraint:fare_class", tradeoff: "a or b" });
  await call("conflict_resolve", { task_id: t.task.id, conflict_id: 1, keep: "ask", said: "basic is fine", now_means: "basic ok this trip" });
  const log = db.taskLog(t.task.id).map(l => l.note);
  assert.ok(log.some(x => x.includes("held:") && x.includes("fare_class")));
  assert.ok(log.some(x => x.includes("settled:") && x.includes("basic is fine")));
});
