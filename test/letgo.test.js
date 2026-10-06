// Changing their mind, cheaply.
//
// "Forget the trip" should cost one sentence. The expensive version is worse than it sounds:
// somebody who has learned that changing their mind is a negotiation stops saying it, and starts
// letting Reason finish things they no longer want.
//
// Two lists, and the line between them is the whole feature. Stopped: the job, its reminders, its
// watchers, the questions it was about to ask — gone, with a receipt each, costing nothing.
// Already committed: what really went out, NOT touched, with the cancellation terms the job wrote
// down. Only the second list is worth asking about, and nothing in it moves without a yes.
//
// Everything here is a lookup. Nothing is matched on words.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-letgo-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { termsOn } = await import("../src/letgo.js");

const C = "dm:letgo";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM timers; DELETE FROM watches; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM notice_seen;");
});

const call = (name, input = {}, ctx = {}) => runTool(name, input, { conversationId: C, ...ctx });
const hourFromNow = () => new Date(clock.now() + 3600_000).toISOString();

/** The trip: a job with a reminder, a watcher and a question out, and terms written down. */
async function theTrip() {
  const t = await call("task_start", {
    title: "austin trip", goal: "flights and a hotel for the austin trip",
    sheet: {
      constraints: {
        who: { value: "Kofi (+13475550222)", source: "them", said: "Kofi's coming" },
        cancellation: { value: "hotel is $25 to cancel up to 48h before", source: "found" },
      },
    },
  });
  await call("timer_set", { fire_at: hourFromNow(), note: "check flight prices again", task_id: t.task.id });
  await call("watch_set", { url: "https://example.com/fares", looking_for: "under $180", task_id: t.task.id });
  await call("confirm_request", { action: "message_send", summary: "text Kofi the dates", target: "+13475550222", task_id: t.task.id });
  return t.task.id;
}

// ---------- the full stop ----------

test("everything running for the job stops, each with its own line, and the job is closed", async () => {
  const id = await theTrip();
  const r = await call("let_go", { about: "the trip", verbatim: "forget the trip", task_ids: [id] });
  assert.equal(r.ok, true);
  const kinds = r.stopped.map(x => x.kind);
  assert.ok(kinds.includes("reminder"));
  assert.ok(kinds.includes("watcher"));
  assert.ok(kinds.includes("question you were about to be asked"));
  assert.ok(kinds.includes("job"));
  assert.equal(db.getTask(C, id).state, "cancelled");
  assert.equal(db.listTimers(C).length, 0);
  assert.equal(db.listWatches(C).length, 0);
  assert.equal(db.pendingConfirmations(C).length, 0);
});

test("the never-mind leaves a receipt with their own words on it", async () => {
  const id = await theTrip();
  await call("let_go", { about: "the trip", verbatim: "forget the trip", task_ids: [id] });
  const row = db.listActions(C).find(a => a.action === "let_go");
  assert.ok(row);
  assert.match(row.receipt, /austin trip/);
  assert.match(row.receipt, /stopped/);
  assert.equal(db.getTask(C, id).outcome.includes("forget the trip"), true);
});

// ---------- the two lists ----------

test("what really went out is listed, not touched, and carries the terms the job wrote down", async () => {
  const id = await theTrip();
  db.recordAction({
    conversationId: C, action: "browser_submit", target: "book the hotel",
    attempted: {}, outcome: "ok", result: {}, receipt: "booked the hotel, 2 nights, $340", taskId: id,
  });
  const before = db.listActions(C).length;
  const r = await call("let_go", { about: "the trip", verbatim: "forget the trip", task_ids: [id] });
  assert.equal(r.already_committed.length, 1);
  assert.match(r.already_committed[0].what, /booked the hotel/);
  assert.equal(r.already_committed[0].cancellation[0].says, "hotel is $25 to cancel up to 48h before");
  assert.match(r.note, /NOT touched/);
  assert.match(r.note, /without a yes/);
  // Nothing was undone: the only new ledger row is the let_go receipt itself.
  assert.equal(db.listActions(C).length, before + 1);
  assert.equal(db.listActions(C).filter(a => a.action === "let_go").length, 1);
});

test("an attempt that failed is not a commitment, and is not listed as one", async () => {
  const id = await theTrip();
  db.recordAction({
    conversationId: C, action: "browser_submit", target: "book the hotel",
    attempted: {}, outcome: "failed", result: {}, receipt: "tried to book the hotel and the page errored", taskId: id,
  });
  const r = await call("let_go", { about: "the trip", verbatim: "forget it", task_ids: [id] });
  assert.equal(r.already_committed.length, 0);
  assert.match(r.note, /nothing to undo/);
});

test("with no terms written down it says so, rather than inventing a cancellation cost", async () => {
  const t = await call("task_start", { title: "dinner", goal: "a table saturday" });
  db.recordAction({
    conversationId: C, action: "browser_submit", target: "book the table",
    attempted: {}, outcome: "ok", result: {}, receipt: "booked 8pm saturday under your name", taskId: t.task.id,
  });
  const r = await call("let_go", { about: "dinner", verbatim: "never mind dinner", task_ids: [t.task.id] });
  assert.equal(r.already_committed[0].cancellation, "not written down on this job");
  assert.match(r.note, /find out rather than guessing/);
});

test("termsOn reads what is written down and nothing else", () => {
  assert.deepEqual(termsOn({ constraints: { budget: { value: "$300", source: "them" } } }), []);
  const found = termsOn({ constraints: { cancellation_policy: { value: "free until 48h", source: "found" }, budget: { value: "$300", source: "them" } } });
  assert.equal(found.length, 1);
  assert.equal(found[0].says, "free until 48h");
});

// ---------- the partial ----------

test("forget the hotel, keep the flight: the other job is untouched and comes back so it can be said", async () => {
  const hotel = await call("task_start", { title: "the hotel", goal: "two nights near downtown" });
  await call("timer_set", { fire_at: hourFromNow(), note: "check hotel prices", task_id: hotel.task.id });
  const flight = await call("task_start", { title: "the flight", goal: "out thursday back sunday" });
  await call("timer_set", { fire_at: hourFromNow(), note: "check fares", task_id: flight.task.id });

  const r = await call("let_go", { about: "the hotel", verbatim: "forget the hotel, keep the flight", task_ids: [hotel.task.id] });
  assert.equal(db.getTask(C, hotel.task.id).state, "cancelled");
  assert.equal(db.getTask(C, flight.task.id).state, "running");
  assert.deepEqual(r.still_running, [{ task_id: flight.task.id, title: "the flight" }]);
  assert.match(r.note, /Still going, untouched: "the flight"/);
  // And the flight's own reminder is still set: a stop is scoped to the job it was given.
  assert.equal(db.listTimers(C).length, 1);
  assert.equal(db.listTimers(C)[0].note, "check fares");
});

test("a reminder that belongs to no job at all is never swept up by somebody else's never-mind", async () => {
  const id = await theTrip();
  await call("timer_set", { fire_at: hourFromNow(), note: "take the bins out" });
  await call("let_go", { about: "the trip", verbatim: "forget the trip", task_ids: [id] });
  assert.deepEqual(db.listTimers(C).map(t => t.note), ["take the bins out"]);
});

// ---------- nothing was running ----------

test("a goal with nothing attached is 'all clear', and does not imply anything was undone", async () => {
  const r = await call("let_go", { about: "the trip", verbatim: "forget the trip", task_ids: [] });
  assert.equal(r.ok, true);
  assert.equal(r.nothing_was_running, true);
  assert.deepEqual(r.stopped, []);
  assert.deepEqual(r.already_committed, []);
  assert.match(r.note, /all clear/);
  assert.match(r.note, /do not imply you undid anything/);
});

test("a job that already finished is said plainly, and nothing is stopped", async () => {
  const t = await call("task_start", { title: "dinner", goal: "a table" });
  await call("task_finish", { task_id: t.task.id, state: "done", outcome: "8pm saturday" });
  const r = await call("let_go", { about: "dinner", verbatim: "never mind dinner", task_ids: [t.task.id] });
  assert.equal(r.ok, false);
  assert.match(r.error, /already finished/);
  assert.match(r.error, /8pm saturday/);
});

test("a task id that is not theirs stops nothing at all", async () => {
  const id = await theTrip();
  const r = await call("let_go", { about: "the trip", verbatim: "forget it", task_ids: [id, 9999] });
  assert.equal(r.ok, false);
  assert.match(r.error, /No task #9999/);
  assert.equal(db.getTask(C, id).state, "running", "the real one was not touched either");
  assert.equal(db.listTimers(C).length, 1);
});

// ---------- the heads-up riding on it ----------

test("a heads-up scheduled on the job's own timer goes with it, and is not re-raised later", async () => {
  const id = await theTrip();
  const timer = db.listTimers(C)[0];
  const notice = db.recordNotice(C, { kind: "calendar", key: "trip-checkin", what: "austin check-in opens tomorrow" });
  db.scheduleNotice(notice.id, timer.id, clock.now() + 3600_000);
  const r = await call("let_go", { about: "the trip", verbatim: "forget the trip", task_ids: [id] });
  assert.ok(r.stopped.some(x => x.kind === "heads-up" && x.what.includes("check-in")));
  assert.ok(db.noticeById(notice.id).dropped_at, "dropped, not deleted — it is still recorded as seen");
  assert.equal(db.heldNotices(C).length, 0);
  assert.equal(db.pendingNotice(C), null);
});
