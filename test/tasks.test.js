// Work that outlives a message, without the model. The turn runner is injected, so what is
// tested here is the part code owns: that a task is a row and not a promise, that it comes back
// after a restart, that it wakes once, that a step which moved nothing never interrupts anyone,
// and that a step which keeps crashing gives up out loud instead of quietly.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-tasks-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_TASK_MAX_ATTEMPTS = "3";
process.env.REASON_TASK_RETRY_BACKOFF_MIN = "2";
process.env.REASON_TASK_WAKE_MIN = "15";
process.env.REASON_TASK_MAX_WAKES = "5";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const C = "dm:tasks";

// Every conversation belongs to somebody now, and the router is what creates that account in
// production. A test that drives the tools directly sets one up the same way.
for (const [id, addr] of [[C, "+12025551234"]]) db.upsertAccount({ conversationId: id, channel: "test", address: addr, name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM conversations; DELETE FROM timers; DELETE FROM watches; DELETE FROM nudges;");
});

const call = (name, input = {}) => runTool(name, input, { conversationId: C });

/** The clock really does tick between a tool call and the assertion, so wake times are compared
 * to the second, not the millisecond. A schedule being a few ms off is not a bug. */
function wakesAt(id, expectedMs, label) {
  const actual = db.getTask(C, id).next_wake_at;
  assert.ok(Math.abs(actual - expectedMs) < 2000, `${label}: woke at ${actual}, expected about ${expectedMs}`);
}

/**
 * A runtime whose turns are a script instead of a model. `onTurn` gets the event text and may
 * touch the DB exactly as the real model's tool calls would; what it returns is what Reason
 * "said". Outbound is collected, so "did the owner actually hear about this" is assertable.
 */
function harness(onTurn = async () => null) {
  const sent = [];
  const turns = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind });
      return onTurn({ text, n: turns.length });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, sent, turns };
}

test("task_start writes a real row with a wake time, and claims nothing yet", async () => {
  const out = await call("task_start", {
    title: "chase the handyman", goal: "he calls back and we have a date", wake_in_minutes: 30,
  });
  assert.equal(out.ok, true);
  assert.equal(out.task.state, "running");
  assert.equal(out.task.woken_times, 0);
  assert.match(out.note, /nothing has been done on it yet/i);

  wakesAt(out.task.id, clock.now() + 30 * MIN, "first wake");
  assert.equal(db.getTask(C, out.task.id).open, true);
});

test("task_list is the truth of what is running, and says so when nothing is", async () => {
  const empty = await call("task_list", {});
  assert.equal(empty.open, 0);
  assert.match(empty.note, /you never actually started it/i);

  await call("task_start", { title: "find a table", goal: "a table for 4 saturday" });
  const now = await call("task_list", {});
  assert.equal(now.open, 1);
  assert.equal(now.tasks[0].title, "find a table");
  assert.match(now.note, /jobs really running/i);
});

test("a task survives a brand new Runtime and resumes at the right time", async () => {
  const { id } = (await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 60 })).task;

  // The process dies here. Nothing was in memory; the row is all a fresh runtime gets.
  const first = harness(async () => null);
  assert.equal((await first.rt.runTasks()).woke, 0, "not due yet");

  clock.skip(61 * MIN);
  const second = harness(async () => null);
  const out = await second.rt.runTasks();
  assert.equal(out.woke, 1, "the new runtime picked it up");
  assert.match(second.turns[0].text, /task #\d+: "chase the handyman"/);
  assert.match(second.turns[0].text, /he calls back/, "it is told its own goal");
  assert.equal(second.turns[0].kind, "event");
  assert.equal(db.getTask(C, id).wakes, 1);
});

test("a due task fires once, not on every pass", async () => {
  await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 });
  const { rt, turns } = harness(async () => null);

  await rt.runTasks();
  await rt.runTasks();
  await rt.runTasks();
  assert.equal(turns.length, 1, "the wake is cleared before the turn, so it cannot re-fire");
});

test("a task that says nothing changed does not interrupt anyone", async () => {
  await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 });
  // The model speaks, but touches nothing: no progress, no state change.
  const { rt, sent } = harness(async () => "still on it! nothing yet but im on it");

  const out = await rt.runTasks();
  assert.equal(out.woke, 1);
  assert.equal(out.held, 1);
  assert.equal(out.reported, 0);
  assert.deepEqual(sent, [], "a step that moved nothing sends nothing, whatever the model wrote");
});

test("a task reports once when something really changed", async () => {
  const { id } = (await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 })).task;
  const { rt, sent } = harness(async () => {
    await call("task_update", { task_id: id, progress: "he picked up; coming tuesday 9am", wake_in_minutes: 120 });
    return "handyman's coming tuesday 9am 🙌";
  });

  const out = await rt.runTasks();
  assert.equal(out.reported, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "handyman's coming tuesday 9am 🙌");
  assert.equal(sent[0].fromTask, id);

  // And it is scheduled where the update put it, not where the default would.
  wakesAt(id, clock.now() + 120 * MIN, "the update's own wake time");
});

test("finishing a task is news, and the task stops waking", async () => {
  const { id } = (await call("task_start", { title: "find a table", goal: "a table for 4 saturday", wake_in_minutes: 0 })).task;
  const { rt, sent } = harness(async () => {
    await call("task_finish", { task_id: id, state: "done", outcome: "8pm at Lucia, 4 people" });
    return "got u — 8pm at lucia saturday, table for 4";
  });

  await rt.runTasks();
  assert.equal(sent.length, 1);

  const row = db.getTask(C, id);
  assert.equal(row.state, "done");
  assert.equal(row.open, false);
  assert.equal(row.next_wake_at, null);

  clock.skip(2 * HOUR);
  assert.equal((await harness().rt.runTasks()).woke, 0, "a finished task never wakes again");
});

test("a task left open with no wake time is re-scheduled rather than lost", async () => {
  const { id } = (await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 })).task;
  const { rt } = harness(async () => {
    await call("task_update", { task_id: id, progress: "left a voicemail" });
    return null;
  });

  await rt.runTasks();
  wakesAt(id, clock.now() + config.taskDefaultWakeMin * MIN, "the default wake");
});

test("a crashing step is retried a bounded number of times, then reported honestly", async () => {
  const { id } = (await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 })).task;
  let crashes = 0;
  const { rt, sent } = harness(async () => { crashes++; throw new Error("upstream model fell over"); });

  // First crash: counted, backed off, nothing said.
  let out = await rt.runTasks();
  assert.equal(out.retried, 1);
  assert.equal(out.failed, 0);
  assert.deepEqual(sent, [], "one bad step is not worth a message");
  assert.equal(db.getTask(C, id).attempts, 1);
  wakesAt(id, clock.now() + 2 * MIN, "backed off a step");

  // Nothing happens until the backoff is up.
  assert.equal((await rt.runTasks()).woke, 0);

  clock.skip(3 * MIN);
  out = await rt.runTasks();
  assert.equal(out.retried, 1);
  assert.equal(db.getTask(C, id).attempts, 2);

  clock.skip(10 * MIN);
  out = await rt.runTasks();
  assert.equal(out.failed, 1, "the third crash is the budget");
  assert.equal(crashes, 3, "it is not retried past the budget");

  const row = db.getTask(C, id);
  assert.equal(row.state, "failed");
  assert.match(row.outcome, /upstream model fell over/);
  assert.equal(row.next_wake_at, null);

  assert.equal(sent.length, 1, "the owner is told exactly once");
  assert.match(sent[0].text, /keeps breaking/i);
  assert.match(sent[0].text, /upstream model fell over/, "it names the real reason, not a vague one");

  clock.skip(HOUR);
  assert.equal((await rt.runTasks()).woke, 0, "a failed task is over");
});

test("real progress clears the crash budget", async () => {
  const { id } = (await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 })).task;
  const { rt } = harness(async ({ n }) => {
    if (n === 1) throw new Error("flaky");
    await call("task_update", { task_id: id, progress: "got through, he's checking his calendar", wake_in_minutes: 60 });
    return null;
  });

  await rt.runTasks();
  assert.equal(db.getTask(C, id).attempts, 1);

  clock.skip(3 * MIN);
  await rt.runTasks();
  assert.equal(db.getTask(C, id).attempts, 0, "a long task is not a failing one");
});

test("a task that wakes forever without finishing gives up and says so", async () => {
  const { id } = (await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 })).task;
  const { rt, sent } = harness(async () => {
    await call("task_update", { task_id: id, progress: "still nothing", wake_in_minutes: 1 });
    return null;
  });

  for (let i = 0; i < 10; i++) { await rt.runTasks(); clock.skip(2 * MIN); }

  const row = db.getTask(C, id);
  assert.equal(row.state, "failed");
  assert.match(row.outcome, /gave up/i);
  assert.equal(row.wakes, config.taskMaxWakes + 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /gotten nowhere/i);
});

test("a closed task cannot be updated or finished twice", async () => {
  const { id } = (await call("task_start", { title: "find a table", goal: "a table saturday" })).task;
  await call("task_finish", { task_id: id, state: "done", outcome: "booked" });

  const again = await call("task_finish", { task_id: id, state: "failed", outcome: "actually no" });
  assert.equal(again.ok, false);
  assert.match(again.error, /already done/i);

  const upd = await call("task_update", { task_id: id, progress: "one more thing" });
  assert.equal(upd.ok, false);
  assert.match(upd.error, /it is over/i);
});

test("one conversation's tasks are not another's", async () => {
  await call("task_start", { title: "find a table", goal: "a table saturday" });
  const theirs = await runTool("task_list", {}, { conversationId: "dm:someone-else" });
  assert.equal(theirs.count, 0);
});

test("task_update rejects a state that is not an open one", async () => {
  const { id } = (await call("task_start", { title: "find a table", goal: "a table saturday" })).task;
  const out = await call("task_update", { task_id: id, state: "done" });
  assert.equal(out.ok, false);
  assert.match(out.error, /use task_finish/i);
});

test("one sweep does timers, tasks, watches and dropped threads together", async () => {
  await call("task_start", { title: "chase the handyman", goal: "he calls back", wake_in_minutes: 0 });
  const { rt } = harness(async () => null);
  const out = await rt.sweep();
  assert.equal(out.tasks.woke, 1);
  assert.ok("timers" in out && "watches" in out && "follow" in out);
});
