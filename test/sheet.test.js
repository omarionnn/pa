// The outcome sheet: a task carries the whole outcome, and code owns three things about it.
//
//   - a rejected option is never offered again
//   - a constraint they stated cannot be overwritten by something Reason found or assumed
//   - an assumption is marked as one, with the instruction to state it rather than ask
//
// No model anywhere in here. What is tested is the part that has to be true when the model is
// having a bad day: the shape, the merge rules, and who is allowed to change what.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-sheet-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { sheetView, applyPatch, emptySheet, parseSheet, peopleOn } = await import("../src/sheet.js");
const { openWorkNote } = await import("../src/openwork.js");

const C = "dm:sheet";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM conversations;");
});

const call = (name, input = {}) => runTool(name, input, { conversationId: C });

/** The messy hand-off, as a sheet. Everything here is something they actually said. */
const THEIRS = {
  constraints: {
    budget: { value: "under $2000 a month", source: "them", said: "under $2k a month" },
    fees_included: { value: "yes — the number has to include fees", source: "them", said: "including fees" },
    move_in: { value: "2026-11-01", source: "them", said: "move in nov 1" },
    place: { value: "near the L train", source: "them", said: "near the L" },
  },
};

const start = (sheet = THEIRS) => call("task_start", {
  title: "find a place", goal: "a place signed under $2k/mo incl fees, in by nov 1, near the L", sheet,
});

test("a task carries the whole outcome, and it survives being read back off the row", async () => {
  const out = await start();
  assert.equal(out.ok, true);
  const s = out.task.sheet;
  assert.equal(s.constraints.budget.value, "under $2000 a month");
  assert.equal(s.constraints.budget.from, "they said it");
  assert.equal(s.constraints.budget.their_words, "under $2k a month");
  assert.equal(s.constraints.fees_included.from, "they said it");

  // Nothing of this is in memory: a fresh read of the row has all of it.
  const row = db.getTask(C, out.task.id);
  assert.equal(row.sheet.constraints.move_in.value, "2026-11-01");
  assert.equal(row.sheet.constraints.move_in.source, "them");
  assert.match(out.note, /source 'them'/);
});

test("a task from before the sheet existed reads as an empty one and still works", async () => {
  const { id } = (await call("task_start", { title: "chase the handyman", goal: "he calls back" })).task;
  // Exactly what an older row looks like: the column at its default, or missing altogether.
  db.db.prepare("UPDATE tasks SET sheet = '' WHERE id = ?").run(id);
  const row = db.getTask(C, id);
  assert.deepEqual(row.sheet, emptySheet());

  const upd = await call("task_update", { task_id: id, progress: "left a voicemail" });
  assert.equal(upd.ok, true);
  assert.deepEqual(upd.task.sheet.constraints, {});
  assert.deepEqual(upd.task.progress.length, 1);
});

test("a rejected option is never offered again, and cannot be put back on the table", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id,
    sheet: {
      options: [
        { id: "l1", label: "441 Graham Ave, $1,850 + $200 fees", where: "http://127.0.0.1/l1", status: "open" },
        { id: "l2", label: "88 Jefferson St, $2,400", where: "http://127.0.0.1/l2", status: "open" },
      ],
    },
  });

  // "too expensive" — their words, and the model's one-word reading of them.
  const rejected = await call("task_update", {
    task_id: id,
    sheet: { options: [{ id: "l2", status: "rejected", rejected_because: { words: "too expensive", reading: "price" } }] },
  });
  assert.equal(rejected.ok, true);

  // The view the model gets has it OUT of options entirely, by id.
  const view = rejected.task.sheet;
  assert.deepEqual(view.options.map(o => o.id), ["l1"], "a rejected option is not among the candidates");
  assert.deepEqual(view.rejected_options, [{ id: "l2", label: "88 Jefferson St, $2,400", their_words: "too expensive", reading: "price" }]);
  assert.match(view.rejected_note, /off the table for good/i);

  // And it cannot come back.
  const again = await call("task_update", { task_id: id, sheet: { options: [{ id: "l2", status: "open" }] } });
  assert.equal(again.ok, false);
  assert.equal(again.status, "needs_them");
  assert.match(again.error, /already turned down/i);
  assert.match(again.error, /too expensive/);

  // Nothing was written: the refusal is all or nothing.
  assert.equal(db.getTask(C, id).sheet.options.find(o => o.id === "l2").status, "rejected");

  // task_list shows the same filtered view.
  const listed = (await call("task_list", {})).tasks[0];
  assert.deepEqual(listed.sheet.options.map(o => o.id), ["l1"]);
});

test("a rejection needs their own words and a reading, not Reason's paraphrase", async () => {
  const { id } = (await start()).task;
  await call("task_update", { task_id: id, sheet: { options: [{ id: "l2", label: "88 Jefferson St", status: "open" }] } });

  const noWords = await call("task_update", { task_id: id, sheet: { options: [{ id: "l2", status: "rejected" }] } });
  assert.equal(noWords.ok, false);
  assert.match(noWords.error, /their own words for why, verbatim/i);

  const noReading = await call("task_update", {
    task_id: id, sheet: { options: [{ id: "l2", status: "rejected", rejected_because: { words: "too expensive" } }] },
  });
  assert.equal(noReading.ok, false);
  assert.match(noReading.error, /price/);
});

test("a constraint they stated cannot be overwritten by something Reason found or assumed", async () => {
  const { id } = (await start()).task;

  for (const source of ["found", "assumed"]) {
    const out = await call("task_update", {
      task_id: id,
      sheet: { constraints: { budget: { value: "under $2600 a month", source } } },
    });
    assert.equal(out.ok, false, `a ${source} value must not move theirs`);
    assert.equal(out.status, "needs_them");
    assert.equal(out.constraint, "budget");
    assert.equal(out.theirs, "under $2000 a month");
    assert.match(out.error, /theirs to change, not yours/i);
    assert.match(out.error, /waiting_on_you/, "it says what the honest next step is");
    assert.match(out.error, /tradeoff/i);
  }
  assert.equal(db.getTask(C, id).sheet.constraints.budget.value, "under $2000 a month");
});

test("a new thing they said does move it, and it has to be quoted", async () => {
  const { id } = (await start()).task;

  const unquoted = await call("task_update", {
    task_id: id, sheet: { constraints: { budget: { value: "under $2400 a month", source: "them" } } },
  });
  assert.equal(unquoted.ok, false);
  assert.equal(unquoted.status, "needs_them");
  assert.match(unquoted.error, /quote the new thing they said/i);

  const quoted = await call("task_update", {
    task_id: id,
    sheet: { constraints: { budget: { value: "under $2400 a month", source: "them", said: "ok i can stretch to 2400" } } },
  });
  assert.equal(quoted.ok, true);
  assert.equal(quoted.task.sheet.constraints.budget.value, "under $2400 a month");
  assert.equal(quoted.task.sheet.constraints.budget.their_words, "ok i can stretch to 2400");
});

test("something Reason found or assumed can be written and then replaced freely", async () => {
  const { id } = (await start()).task;
  await call("task_update", { task_id: id, sheet: { constraints: { broker_fee: { value: "one month", source: "found" } } } });
  const out = await call("task_update", { task_id: id, sheet: { constraints: { broker_fee: { value: "15% of annual rent", source: "found" } } } });
  assert.equal(out.ok, true);
  assert.equal(out.task.sheet.constraints.broker_fee.value, "15% of annual rent");
});

test("an assumption is marked as one, with the instruction to say it rather than ask", async () => {
  const { id } = (await start()).task;
  const out = await call("task_update", {
    task_id: id,
    sheet: { constraints: { lease_length: { value: "12 months", source: "assumed" } } },
  });
  const s = out.task.sheet;
  assert.equal(s.constraints.lease_length.from, "you assumed it");
  assert.deepEqual(s.assumptions, ["lease_length: 12 months"]);
  assert.match(s.assumptions_note, /ONCE/);
  assert.match(s.assumptions_note, /do not turn one into a question/i);
  // Nothing they said is in there.
  assert.ok(!s.assumptions.some(a => a.startsWith("budget")));
});

test("the sheet goes in front of the model on an ordinary turn, and holds after the message is gone", async () => {
  const { id } = (await start()).task;
  await call("task_update", { task_id: id, sheet: { left: ["see 441 graham friday"] } });

  const note = openWorkNote(C);
  assert.match(note, /open work/);
  assert.match(note, /under \$2000 a month/, "the budget they stated is in the turn");
  assert.match(note, /include fees/, "and so is 'including fees', turns after they said it");
  assert.match(note, /see 441 graham friday/);
  assert.match(note, /do not ask for anything already on one/i);
  assert.ok(note.includes(`"task_id":${id}`));

  // Nothing open: no note at all, so an ordinary chat carries no weight.
  await call("task_finish", { task_id: id, state: "cancelled", outcome: "called off" });
  assert.equal(openWorkNote(C), "");
});

test("waiting needs who and what, and keeps the time it started", async () => {
  const { id } = (await start()).task;
  const bad = await call("task_update", { task_id: id, sheet: { waiting: [{ on: "the broker" }] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /what exactly is owed/i);

  const ok = await call("task_update", {
    task_id: id,
    sheet: { waiting: [{ on: "the broker at 441 graham", for: "a viewing slot friday", next_check: "2026-10-07T10:00:00-04:00" }] },
  });
  assert.equal(ok.ok, true);
  const first = ok.task.sheet.waiting[0];
  assert.equal(first.on, "the broker at 441 graham");
  assert.ok(first.since, "it records when the wait started");
  assert.ok(first.next_check, "and when it will look again");

  clock.skip(60 * 60_000);
  const later = await call("task_update", {
    task_id: id,
    sheet: { waiting: [{ on: "the broker at 441 graham", for: "a viewing slot friday", next_check: "2026-10-07T16:00:00-04:00" }] },
  });
  assert.equal(later.task.sheet.waiting[0].since, first.since, "the same wait does not restart its clock");
});

test("the sheet is checked before anything is written, so a bad patch loses nothing", async () => {
  const { id } = (await start()).task;
  const out = await call("task_update", {
    task_id: id,
    progress: "read three listing pages",
    sheet: { constraints: { size: { value: "1 bed", source: "guessed" } } },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /source/);
  const row = db.getTask(C, id);
  assert.equal(row.sheet.constraints.size, undefined);
  assert.deepEqual(row.log.filter(l => l.kind === "progress"), [], "and the progress line did not land either");
});

test("task_start refuses a bad sheet rather than starting a task with half of one", async () => {
  const out = await call("task_start", {
    title: "find a place", goal: "a place",
    sheet: { options: [{ label: "no id on it" }] },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /stable id/i);
  assert.equal(db.listTasks(C).length, 0, "nothing was started");
});

test("applyPatch and the view are pure: no DB, no clock, no model", () => {
  const made = applyPatch(emptySheet(), THEIRS, { now: 1_700_000_000_000 });
  assert.equal(made.ok, true);
  const round = parseSheet(JSON.stringify(made.sheet));
  assert.deepEqual(round, made.sheet, "a sheet survives a trip through the column unchanged");
  const view = sheetView(made.sheet, { progress: ["read three pages"] });
  assert.deepEqual(view.done_so_far, ["read three pages"]);
  assert.equal(view.needs_from_them, null);
  assert.deepEqual(view.rejected_options, []);
});

test("the people on a sheet are the ones named on it, and nobody else", () => {
  const s = applyPatch(emptySheet(), {
    constraints: { who: { value: "Kofi", source: "them" }, budget: { value: "$2000", source: "them" } },
    waiting: [{ on: "the broker at 441 graham", for: "a slot" }],
  }, { now: 1 }).sheet;
  const people = peopleOn(s);
  assert.ok(people.includes("Kofi"));
  assert.ok(people.includes("the broker at 441 graham"));
  assert.ok(!people.includes("$2000"), "a budget is not a person");
});
