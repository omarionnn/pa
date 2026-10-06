// States, loose ends, and "where were we?".
//
// A task now says WHO the wait is on, and each of those states has to carry the thing that makes it
// actionable — the one question, the next check, what would unblock it. And a task waiting on THEM
// gets asked about exactly twice in its life: once when it happens, once after a long gap. Never a
// third time. That ceiling is a stamp on a row, not the model's sense of tact.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-loose-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_NEEDS_REMINDER_MIN = "1440";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const C = "dm:loose";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM conversations; DELETE FROM usage;");
});

const call = (name, input = {}) => runTool(name, input, { conversationId: C });

function harness(onTurn = async () => null) {
  const sent = [];
  const turns = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind }); return onTurn({ text, n: turns.length }); },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, sent, turns };
}

const start = () => call("task_start", { title: "find a place", goal: "a place under 2k incl fees by nov 1", wake_in_minutes: 0 });

test("waiting_on_you needs the one thing it needs, phrased as a question with the tradeoff", async () => {
  const { id } = (await start()).task;

  const bare = await call("task_update", { task_id: id, state: "waiting_on_you" });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /sheet\.needs/);
  assert.match(bare.error, /word or two/i);
  assert.match(bare.error, /what each answer costs/i);
  assert.equal(db.getTask(C, id).state, "running", "the state did not move");

  const noTradeoff = await call("task_update", {
    task_id: id, state: "waiting_on_you", sheet: { needs: { question: "friday or saturday for the viewing?" } },
  });
  assert.equal(noTradeoff.ok, false);
  assert.match(noTradeoff.error, /tradeoff/i);
  assert.match(noTradeoff.error, /makes them do the thinking/i);

  const good = await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday for the viewing?", tradeoff: "friday it's still listed, saturday there's a second place nearby you could see too" } },
  });
  assert.equal(good.ok, true);
  assert.equal(good.task.state, "waiting_on_you");
  assert.match(good.task.needs_from_you, /friday or saturday/);
  assert.match(good.task.needs_from_you, /second place nearby/);
});

test("waiting_on_other needs who is owed what and when you will look again", async () => {
  const { id } = (await start()).task;

  const bare = await call("task_update", { task_id: id, state: "waiting_on_other" });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /sheet\.waiting/);
  assert.match(bare.error, /when you will check again/i);

  const good = await call("task_update", {
    task_id: id, state: "waiting_on_other",
    sheet: { waiting: [{ on: "the broker at 441 graham", for: "a viewing slot", next_check: "2026-10-07T10:00:00-04:00" }] },
  });
  assert.equal(good.ok, true);
  assert.match(good.task.waiting_on[0], /broker at 441 graham/);
  assert.match(good.task.waiting_on[0], /viewing slot/);
  assert.match(good.task.waiting_on[0], /checking again/);
  assert.equal(good.task.needs_from_you, null, "nothing is on them");
});

test("blocked says what stopped it and what would unblock it", async () => {
  const { id } = (await start()).task;

  const bare = await call("task_update", { task_id: id, state: "blocked" });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /sheet\.blocked/);
  assert.match(bare.error, /other safe route/i, "and it says to try another route before calling it blocked");

  const good = await call("task_update", {
    task_id: id, state: "blocked",
    sheet: { blocked: { what: "streeteasy answers 403 to an automated browser", unblock: "a listing site that does load, or you pasting a link" } },
  });
  assert.equal(good.ok, true);
  assert.match(good.task.blocked_by, /403/);
  assert.match(good.task.blocked_by, /would need: a listing site that does load/);
});

test("the states a closed task uses are not open states", async () => {
  const { id } = (await start()).task;
  for (const state of ["done", "cancelled", "finished", "waiting_on_them"]) {
    const out = await call("task_update", { task_id: id, state });
    assert.equal(out.ok, false, `${state} is not an open state`);
  }
  assert.equal(db.getTask(C, id).state, "running");
});

test("an old 'waiting' row keeps working exactly as it did", async () => {
  const { id } = (await start()).task;
  const out = await call("task_update", { task_id: id, state: "waiting", progress: "left a voicemail" });
  assert.equal(out.ok, true, "the original state is still an open one");
  assert.equal(db.getTask(C, id).open, true);

  clock.skip(HOUR);
  db.scheduleTask(id, clock.now());
  const { rt, turns } = harness(async () => null);
  assert.equal((await rt.runTasks()).woke, 1, "and it still wakes");
  assert.equal(turns.length, 1);
});

test("a task waiting on them rests instead of waking the model, and nags exactly once", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday?", tradeoff: "friday it's still listed, saturday you could see two" } },
  });

  const { rt, sent, turns } = harness(async () => "i should not be running");

  // Straight away: nothing. They were asked a moment ago.
  db.scheduleTask(id, clock.now());
  let out = await rt.runTasks();
  assert.equal(out.woke, 1);
  assert.equal(out.resting, 1);
  assert.equal(out.reminded, 0);
  assert.equal(turns.length, 0, "no model call: there is nothing to do until they answer");
  assert.deepEqual(sent, []);

  // Twelve hours later: still inside the gap.
  clock.skip(12 * HOUR);
  db.scheduleTask(id, clock.now());
  out = await rt.runTasks();
  assert.equal(out.reminded, 0, "half a day is not a day");
  assert.deepEqual(sent, []);

  // Past the gap: one reminder, with the question and the tradeoff in it.
  clock.skip(13 * HOUR);
  db.scheduleTask(id, clock.now());
  out = await rt.runTasks();
  assert.equal(out.reminded, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /find a place/);
  assert.match(sent[0].text, /friday or saturday/);
  assert.match(sent[0].text, /see two/, "the tradeoff goes with it");
  assert.equal(sent[0].fromTask, id);
  assert.equal(turns.length, 0, "written by code, not by the model");

  // And never again, however long it goes on.
  for (let i = 0; i < 5; i++) {
    clock.skip(2 * 24 * HOUR);
    db.scheduleTask(id, clock.now());
    await rt.runTasks();
  }
  assert.equal(sent.length, 1, "asked once, reminded once, and that is the whole of it");
});

test("a different thing they need is a new ask, not a second nag about the old one", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday?", tradeoff: "friday it's still listed" } },
  });
  clock.skip(25 * HOUR);
  db.scheduleTask(id, clock.now());
  const { rt, sent } = harness();
  await rt.runTasks();
  assert.equal(sent.length, 1);

  // They answered, it moved on, and later it needs something else.
  await call("task_update", { task_id: id, state: "running", sheet: { needs: null }, progress: "saw it friday" });
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "put the deposit down on 441 graham?", tradeoff: "it goes to someone else by monday if not" } },
  });
  clock.skip(25 * HOUR);
  db.scheduleTask(id, clock.now());
  await rt.runTasks();
  assert.equal(sent.length, 2, "a new loose end gets its own one reminder");
  assert.match(sent[1].text, /deposit/);
});

test("'where were we' is answered done first, then left, then the one ask", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id,
    progress: "read 3 listing pages near the L; 441 graham is $1,850 + $200 fees",
    sheet: { left: ["book the friday viewing", "check the broker fee on 441"] },
  });
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday for the viewing?", tradeoff: "friday it's still listed, saturday you could see two" } },
  });

  const list = await call("task_list", {});
  const t = list.tasks[0];
  assert.equal(list.open, 1);
  assert.match(t.done_so_far[0], /441 graham/, "what has actually happened");
  assert.deepEqual(t.whats_left, ["book the friday viewing", "check the broker fee on 441"]);
  assert.match(t.needs_from_you, /friday or saturday/);
  assert.equal(t.state, "waiting_on_you");
  assert.deepEqual(list.on_them, [{ task_id: id, title: "find a place", needs_from_you: t.needs_from_you }]);
  assert.match(list.note, /Where were we/);
  assert.match(list.note, /DONE first/);
  assert.match(list.note, /waiting on an answer from them/);
});

test("with nothing on them, task_list says so rather than offering a question", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id, state: "waiting_on_other",
    sheet: { waiting: [{ on: "the broker", for: "a slot", next_check: "2026-10-07T10:00:00-04:00" }] },
  });
  const list = await call("task_list", {});
  assert.deepEqual(list.on_them, []);
  assert.match(list.note, /do not invent something to ask/i);
});

test("several open jobs are told to go on a page", async () => {
  for (const n of [1, 2, 3]) await call("task_start", { title: `job ${n}`, goal: `goal ${n}` });
  const list = await call("task_list", {});
  assert.equal(list.open, 3);
  assert.match(list.note, /activity_page/);
});

test("the needs reminder honours the proactive cap like everything else", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday?", tradeoff: "friday it's still listed" } },
  });
  clock.skip(25 * HOUR);
  db.scheduleTask(id, clock.now());

  const { rt, sent } = harness();
  rt.mayInterrupt = () => false;
  const out = await rt.runTasks();
  assert.equal(out.reminded, 0);
  assert.deepEqual(sent, [], "a capped conversation is not interrupted");
});

// "At most one" has to also mean "at least the one", and the order of two lines is the whole of it.
//
// The claim is permanent: `claimNeedsReminder` stamps the row, and that stamp is what makes "never a
// third time" true. So claiming it and THEN discovering the day's proactive budget is spent burns
// the only nudge this question is ever owed without sending it — the task goes back to resting
// forever having said nothing, and the person is left with a job that quietly stopped asking. The
// ceiling would have become a floor of zero on the most ordinary day there is: a busy one.
test("a nudge the cap stopped is still owed, and lands on the next pass instead of being lost", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday?", tradeoff: "friday it's still listed" } },
  });
  clock.skip(25 * HOUR);
  db.scheduleTask(id, clock.now());

  // A day whose budget is already spent. Nothing goes out — and nothing is spent either.
  const capped = harness();
  capped.rt.mayInterrupt = () => false;
  assert.equal((await capped.rt.runTasks()).reminded, 0);
  assert.deepEqual(capped.sent, []);
  assert.equal(db.getTask(C, id).sheet.needs.reminded_at, null, "the nudge was not claimed, so it is not gone");

  // The next day there is room, and the thing they were owed is said.
  clock.skip(25 * HOUR);
  db.scheduleTask(id, clock.now());
  const open = harness();
  const out = await open.rt.runTasks();
  assert.equal(out.reminded, 1, "the nudge survived the capped day");
  assert.match(open.sent[0].text, /friday or saturday/);
  assert.ok(db.getTask(C, id).sheet.needs.reminded_at, "and now it really is spent");

  // Still exactly one, ever. A cap deferring it did not buy a second.
  clock.skip(25 * HOUR);
  db.scheduleTask(id, clock.now());
  const after = harness();
  assert.equal((await after.rt.runTasks()).reminded, 0, "never a third time");
  assert.deepEqual(after.sent, []);
});

test("claimNeedsReminder is the whole of the rule, and it is a row not a judgement", async () => {
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday?", tradeoff: "friday it's still listed" } },
  });
  const gapMs = config.needsReminderMin * MIN;
  assert.equal(db.claimNeedsReminder(id, { gapMs }), null, "not yet");
  clock.skip(gapMs + MIN);
  assert.ok(db.claimNeedsReminder(id, { gapMs }), "owed");
  assert.equal(db.claimNeedsReminder(id, { gapMs }), null, "and claimed, so a second sweep gets nothing");

  // A task that is not waiting on them has no reminder to claim at all.
  const other = (await call("task_start", { title: "x", goal: "y" })).task;
  clock.skip(gapMs + MIN);
  assert.equal(db.claimNeedsReminder(other.id, { gapMs }), null);
});

// One nudge PER OPEN QUESTION, which is the half the idempotence test above does not pin.
//
// src/notice.js has held this shape for catches since it was written: a thing is raised once, and
// raising it again is a different thing, not the same thing louder. The task sheet has to work the
// same way or the two halves of Reason disagree about what "I already asked" means. The rule lives
// in two places and both are code: `claimNeedsReminder` stamps the question that was re-raised, and
// `applyPatch` treats a DIFFERENT question as a new one with its own single nudge — which is right,
// because a job whose open question has changed has genuinely not asked this one yet.
test("one nudge per open question: the same one never twice, a new one gets its own", async () => {
  const gapMs = config.needsReminderMin * MIN;
  const { id } = (await start()).task;
  await call("task_update", {
    task_id: id, state: "waiting_on_you",
    sheet: { needs: { question: "friday or saturday?", tradeoff: "friday it's still listed" } },
  });

  clock.skip(gapMs + MIN);
  assert.ok(db.claimNeedsReminder(id, { gapMs }), "the one nudge it is owed");
  clock.skip(gapMs * 10);
  assert.equal(db.claimNeedsReminder(id, { gapMs }), null, "and never a third time, however long it waits");

  // They still have not answered, but the job has moved and needs something else now.
  await call("task_update", {
    task_id: id,
    sheet: { needs: { question: "is 2 bed ok or does it have to be 3?", tradeoff: "2 bed opens up another four places" } },
  });
  clock.skip(gapMs + MIN);
  const owed = db.claimNeedsReminder(id, { gapMs });
  assert.ok(owed, "a different question has not been asked twice — it has been asked once");
  assert.match(owed.question, /2 bed/);
  assert.equal(db.claimNeedsReminder(id, { gapMs }), null, "and it gets exactly one too");
});

test("re-writing the SAME question does not buy another nudge", async () => {
  const gapMs = config.needsReminderMin * MIN;
  const { id } = (await start()).task;
  const needs = { question: "friday or saturday?", tradeoff: "friday it's still listed" };
  await call("task_update", { task_id: id, state: "waiting_on_you", sheet: { needs } });

  clock.skip(gapMs + MIN);
  assert.ok(db.claimNeedsReminder(id, { gapMs }), "its one nudge");
  // The same question written down again — a model re-stating what it is waiting on, which happens
  // on every wake. If that reset the stamp, "ask once more and never again" would be a rule the
  // model could switch off by repeating itself.
  await call("task_update", { task_id: id, sheet: { needs: { ...needs } } });
  clock.skip(gapMs + MIN);
  assert.equal(db.claimNeedsReminder(id, { gapMs }), null, "writing it down again is not a new question");
});
