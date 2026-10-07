// Standing check-ins: the maths, the rows, and the chain from one firing to the next.
//
// No model and no network anywhere in here. What a check-in SAYS is the model's and is covered by
// test/flow-series.test.js; everything below is what code has to guarantee whatever the model does:
//
//   does "every monday at 9" stay 9 o'clock across the November clock change?   (yes — 169 hours)
//   does a weekday series skip the weekend?                                     (yes)
//   does "every month on the 31st" invent a 31st of February?                   (no — it skips)
//   can a series Reason scheduled itself fire at 2am?                           (no — 8am)
//   can one they asked for at 2am fire at 2am?                                  (yes)
//   three Mondays missed with the laptop shut — how many check-ins?             (one, the newest)
//   is the cap on how many somebody can have counted in the database?           (yes)
//   does a firing schedule the next one, even if the process died in between?   (yes — state, not events)
//   does what they say back get kept, and reach the next check-in?              (yes)
//   can a tool touch a series in another conversation?                          (no)
//   does an export carry them, and a delete take them?                          (both)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-series-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_MAX_SERIES = "3";

const db = await import("../src/db.js");
const series = await import("../src/series.js");
const { clock, config } = await import("../src/config.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { exportData, deleteData } = await import("../src/data.js");
const { sweepRetention } = await import("../src/privacy.js");

const C = "dm:owner";
const OTHER = "dm:+15550001111";
const OWNER = "+12025551234";
const TZ = "America/New_York";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM series; DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts;"
    + " DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;"
    + " DELETE FROM action_ledger; DELETE FROM notice_seen;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

/** Move the fake clock to a real instant, whatever it currently says. */
function at(iso) {
  clock.reset();
  clock.skip(Date.parse(iso) - clock.now());
}

const rule = (r) => {
  const out = series.normalizeRule(r);
  assert.equal(out.ok, true, out.error);
  return out.rule;
};

/** The local wall clock of an instant, as "Mon 09:00". */
function localAt(ms) {
  const p = series.partsIn(ms, TZ);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${names[p.weekday]} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function walk(r, from, n, tz = TZ) {
  const out = [];
  let t = Date.parse(from);
  for (let i = 0; i < n; i++) {
    t = series.nextOccurrence(r, t, tz);
    out.push(t);
  }
  return out;
}

// ---------- the maths ----------

test("a weekly series keeps its 9 o'clock across the November clock change", () => {
  // The November 2026 change is Sunday the 1st. Monday the 26th of October is on summer time and
  // Monday the 2nd of November is not, so the gap between them is 169 hours and not 168 — which is
  // the whole reason this walks local days rather than adding a week of milliseconds.
  const r = rule({ kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true });
  const got = walk(r, "2026-10-20T12:00:00Z", 4);
  assert.deepEqual(got.map(localAt), ["Mon 09:00", "Mon 09:00", "Mon 09:00", "Mon 09:00"]);
  const gaps = got.slice(1).map((t, i) => (t - got[i]) / HOUR);
  assert.deepEqual(gaps, [169, 168, 168], "the one that spans the change is an hour longer in real time");
  assert.equal(new Date(got[0]).toISOString(), "2026-10-26T13:00:00.000Z");
  assert.equal(new Date(got[1]).toISOString(), "2026-11-02T14:00:00.000Z");
});

test("a daily series keeps its hour across the change too", () => {
  const r = rule({ kind: "daily", hour: 19, minute: 30, their_time: true });
  const got = walk(r, "2026-10-30T12:00:00Z", 5);
  assert.deepEqual(got.map(localAt), ["Fri 19:30", "Sat 19:30", "Sun 19:30", "Mon 19:30", "Tue 19:30"]);
});

test("'every weekday morning' skips the weekend", () => {
  const r = rule({ kind: "weekdays", hour: 8, minute: 30, their_time: true });
  // From a Friday afternoon: Monday next, then four more weekdays, then Monday again.
  assert.deepEqual(walk(r, "2026-10-09T20:00:00Z", 6).map(localAt),
    ["Mon 08:30", "Tue 08:30", "Wed 08:30", "Thu 08:30", "Fri 08:30", "Mon 08:30"]);
});

test("two days a week is two days a week, in the order they come", () => {
  const r = rule({ kind: "weekly", hour: 9, weekdays: ["thursday", "monday"], their_time: true });
  assert.deepEqual(r.weekdays, [1, 4], "stored sorted, so saying it back reads naturally");
  assert.deepEqual(walk(r, "2026-10-06T20:00:00Z", 4).map(localAt),
    ["Thu 09:00", "Mon 09:00", "Thu 09:00", "Mon 09:00"]);
  assert.equal(series.sayRule(r), "every monday and thursday at 9am");
});

test("monthly on the 31st skips the months that have no 31st, and never invents one", () => {
  const r = rule({ kind: "monthly", hour: 9, day_of_month: 31, their_time: true });
  const got = walk(r, "2027-01-01T05:00:00Z", 5).map(t => new Date(t).toISOString().slice(0, 10));
  assert.deepEqual(got, ["2027-01-31", "2027-03-31", "2027-05-31", "2027-07-31", "2027-08-31"]);
  // February is missing because February has no 31st. Clamping it to the 28th would be a check-in
  // on a day nobody named, so it is skipped and the schedule line says "the 31st" honestly.
  assert.ok(!got.some(d => d.startsWith("2027-02")), "no 31st of February");
  assert.equal(series.sayRule(r), "on the 31st of every month at 9am");
});

test("every two weeks starts at the next one of that time and then counts fortnights", () => {
  // Asked on a Wednesday afternoon for 10am: the first is Thursday morning, not a fortnight away.
  const first = series.start({ conversationId: C, what: "whether he invoiced", repeat: { kind: "every_n_days", hour: 10, n: 14, their_time: true }, now: Date.parse("2026-10-07T20:00:00Z") });
  assert.equal(first.ok, true, first.error);
  const row = db.getSeries(C, first.series.series_id);
  const r = series.parseRule(row.rule);
  assert.equal(r.anchor, "2026-10-08", "the day it really lands on is what later ones count from");
  const got = walk(r, "2026-10-07T20:00:00Z", 4).map(t => new Date(t).toISOString().slice(0, 10));
  assert.deepEqual(got, ["2026-10-08", "2026-10-22", "2026-11-05", "2026-11-19"]);
  assert.equal(series.sayRule(r), "every 2 weeks at 10am");
});

// ---------- quiet hours ----------

test("a time Reason picked is pulled out of the middle of their night; a time they named is not", () => {
  const mine = rule({ kind: "daily", hour: 2 });
  assert.deepEqual(walk(mine, "2026-10-07T20:00:00Z", 3).map(localAt), ["Thu 08:00", "Fri 08:00", "Sat 08:00"]);

  const theirs = rule({ kind: "daily", hour: 2, their_time: true });
  assert.deepEqual(walk(theirs, "2026-10-07T20:00:00Z", 3).map(localAt), ["Thu 02:00", "Fri 02:00", "Sat 02:00"]);

  // Late is the other end of the same window: 11:30pm becomes eight the next morning.
  const late = rule({ kind: "daily", hour: 23, minute: 30 });
  assert.deepEqual(walk(late, "2026-10-07T20:00:00Z", 2).map(localAt), ["Thu 08:00", "Fri 08:00"]);
  // And 10pm is not in the window at all, so it is left alone.
  assert.deepEqual(walk(rule({ kind: "daily", hour: 22 }), "2026-10-07T20:00:00Z", 1).map(localAt), ["Wed 22:00"]);
});

test("the shift is to eight in THEIR zone, not the install's", () => {
  const r = rule({ kind: "daily", hour: 3 });
  const [la] = walk(r, "2026-10-07T20:00:00Z", 1, "America/Los_Angeles");
  assert.equal(series.partsIn(la, "America/Los_Angeles").hour, 8);
  assert.equal(series.partsIn(la, TZ).hour, 11, "which is eleven in New York, and that is the point");
});

// ---------- the row, the cap, the scoping ----------

test("one row for the arrangement, and its first firing is an ordinary timer pointing at it", () => {
  at("2026-10-07T20:00:00Z");
  const out = series.start({ conversationId: C, what: "how the job search is going", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.series.schedule, "every monday at 9am");
  assert.equal(out.series.state, "active");
  assert.equal(out.series.time_zone, TZ);
  assert.equal(out.series.checked_in, 0);

  const timers = db.listTimers(C);
  assert.equal(timers.length, 1, "exactly one firing is armed, never a queue of them");
  assert.equal(timers[0].series_id, out.series.series_id);
  assert.match(timers[0].note, /how the job search is going/);
  assert.equal(localAt(timers[0].fire_at), "Mon 09:00");

  // next_at is already past the armed one, which is what stops a second sweep arming it again.
  const row = db.getSeries(C, out.series.series_id);
  assert.ok(row.next_at > timers[0].fire_at);
  assert.equal(localAt(row.next_at), "Mon 09:00");
});

test("the cap is counted in the database, and a refusal says to ask which one to stop", async () => {
  at("2026-10-07T20:00:00Z");
  assert.equal(config.maxSeries, 3);
  for (let i = 0; i < 3; i++) {
    const out = await runTool("timer_set", { note: `thing ${i}`, repeat: { kind: "daily", hour: 9, their_time: true } }, { conversationId: C });
    assert.equal(out.ok, true, out.error);
  }
  const over = await runTool("timer_set", { note: "a fourth", repeat: { kind: "daily", hour: 9, their_time: true } }, { conversationId: C });
  assert.equal(over.ok, false);
  assert.match(over.error, /REASON_MAX_SERIES=3/);
  assert.match(over.error, /ask which one to stop/);
  assert.equal(db.countActiveSeries(C), 3, "and nothing was made");

  // Ending one makes room: the count is of what is RUNNING, read off the rows every time.
  const first = db.listSeries(C)[0];
  assert.equal(series.end({ conversationId: C, seriesId: first.id }).ok, true);
  assert.equal(db.countActiveSeries(C), 2);
  const now = await runTool("timer_set", { note: "a fourth", repeat: { kind: "daily", hour: 9, their_time: true } }, { conversationId: C });
  assert.equal(now.ok, true, now.error);
});

test("a series belongs to its conversation: another thread's tools cannot see or stop it", async () => {
  at("2026-10-07T20:00:00Z");
  db.upsertAccount({ conversationId: OTHER, channel: "fake", address: "+15550001111", name: "Kofi" });
  const mine = series.start({ conversationId: C, what: "the job search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  assert.equal(mine.ok, true, mine.error);
  const id = mine.series.series_id;

  const theirList = await runTool("series_list", {}, { conversationId: OTHER });
  assert.deepEqual(theirList.series, [], "not in somebody else's list");
  for (const tool of ["series_pause", "series_resume", "series_end"]) {
    const out = await runTool(tool, { series_id: id }, { conversationId: OTHER });
    assert.equal(out.ok, false, tool);
    assert.match(out.error, new RegExp(`No series #${id}`), tool);
  }
  assert.equal(db.getSeries(C, id).state, "active", "and it is untouched");
});

test("pause stops the armed firing, resume starts from now, end is final", async () => {
  at("2026-10-07T20:00:00Z");
  const made = await runTool("timer_set", { note: "the workout", repeat: { kind: "daily", hour: 19, their_time: true } }, { conversationId: C });
  const id = made.series.series_id;
  assert.equal(db.listTimers(C).length, 1);

  const paused = await runTool("series_pause", { series_id: id }, { conversationId: C });
  assert.equal(paused.ok, true, paused.error);
  assert.equal(paused.series.state, "paused");
  assert.equal(db.listTimers(C).length, 0, "nothing is left armed, so a pause really pauses");
  // And a paused series is not swept back into life.
  assert.deepEqual(series.schedule(), []);
  assert.equal(db.listTimers(C).length, 0);

  // Four days later. Resuming takes the next 7pm from NOW, never the four it missed.
  clock.skip(4 * DAY);
  const back = await runTool("series_resume", { series_id: id }, { conversationId: C });
  assert.equal(back.ok, true, back.error);
  assert.equal(back.series.state, "active");
  const armed = db.listTimers(C);
  assert.equal(armed.length, 1);
  assert.ok(armed[0].fire_at > clock.now(), "in the future, not a backlog of four");
  assert.equal(localAt(armed[0].fire_at), `${localAt(armed[0].fire_at).slice(0, 3)} 19:00`);

  const ended = await runTool("series_end", { series_id: id, why: "he's going to the gym with Kofi now" }, { conversationId: C });
  assert.equal(ended.ok, true, ended.error);
  assert.equal(ended.series.state, "ended");
  assert.equal(ended.series.ended_why, "he's going to the gym with Kofi now");
  assert.equal(db.listTimers(C).length, 0);
  // Final: an ended series is never resumed, because "start it again" deserves saying back as new.
  const again = await runTool("series_resume", { series_id: id }, { conversationId: C });
  assert.equal(again.ok, false);
  assert.match(again.error, /already ended/);
  assert.deepEqual(series.schedule(), [], "and the sweep leaves it alone for good");
});

test("every one of the four leaves a receipt with the schedule in the words they were told", async () => {
  at("2026-10-07T20:00:00Z");
  const made = await runTool("timer_set", { note: "how the job search is going", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } }, { conversationId: C });
  const id = made.series.series_id;
  await runTool("series_pause", { series_id: id }, { conversationId: C });
  await runTool("series_resume", { series_id: id }, { conversationId: C });
  await runTool("series_end", { series_id: id, why: "i got the job" }, { conversationId: C });

  const rows = db.listActions(C);
  const receipt = (action) => rows.find(r => r.action === action)?.receipt ?? "";
  assert.match(receipt("series_set"), /Set a standing check-in: every monday at 9am \(America\/New_York\), about how the job search is going/);
  assert.match(receipt("series_pause"), /Paused the standing check-in about how the job search is going/);
  assert.match(receipt("series_resume"), /Started the check-in about how the job search is going again/);
  assert.match(receipt("series_end"), /Stopped the standing check-in .* for good/);
  assert.match(receipt("series_end"), /they said: "i got the job"/);
  assert.ok(rows.every(r => r.outcome === "ok"));

  // A refusal is on the record too: "why did it not set that" is a question the ledger answers.
  const bad = await runTool("timer_set", { note: "x", repeat: { kind: "weekly", hour: 9 } }, { conversationId: C });
  assert.equal(bad.ok, false);
  const failed = db.listActions(C).find(r => r.action === "series_set" && r.outcome === "error");
  assert.ok(failed, "the refusal has its own row");
  assert.match(failed.receipt, /Did not set a standing check-in/);
});

test("one firing cancelled by hand skips that one only; the series carries on", async () => {
  at("2026-10-07T20:00:00Z");
  const made = await runTool("timer_set", { note: "the workout", repeat: { kind: "daily", hour: 19, their_time: true } }, { conversationId: C });
  const armed = db.listTimers(C)[0];
  const out = await runTool("timer_cancel", { timer_id: armed.id }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.series_id, made.series.series_id);
  assert.match(out.note, /skipped ONE occurrence/);
  assert.match(out.note, /still running/);
  assert.equal(db.getSeries(C, made.series.series_id).state, "active");

  // And the next sweep arms the NEXT one rather than making the cancelled one again — which is what
  // moving next_at at the moment a timer is made, rather than when it fires, buys.
  const scheduled = series.schedule();
  assert.equal(scheduled.length, 1);
  const next = db.listTimers(C);
  assert.equal(next.length, 1);
  assert.ok(next[0].fire_at > armed.fire_at, "tomorrow's, not today's again");
});

// ---------- the sweep: one timer at a time, and no backlog ----------

test("the sweep never arms a second firing for a series that already has one", () => {
  at("2026-10-07T20:00:00Z");
  series.start({ conversationId: C, what: "the search", repeat: { kind: "daily", hour: 9, their_time: true } });
  assert.deepEqual(series.schedule(), []);
  assert.deepEqual(series.schedule(), []);
  assert.equal(db.listTimers(C).length, 1);
});

test("three Mondays passing with the laptop shut produce ONE check-in, for the newest", () => {
  at("2026-10-07T20:00:00Z");
  const out = series.start({ conversationId: C, what: "the job search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  const id = out.series.series_id;
  const armed = db.listTimers(C)[0];
  const firstMonday = armed.fire_at;

  // The 12th fires, then the process dies for four weeks. The 19th, the 26th and the 2nd of
  // November all come and go with nothing running.
  clock.skip(29 * DAY);
  // What the dead process never did: spend that timer. Do it by hand, as the real fire path would
  // once it came back, so what is left is the question this test is about — what the SWEEP does with
  // a series whose next_at is now three weeks stale.
  db.markTimerFired(armed.id);
  db.noteSeriesFired(id);

  const made = series.schedule();
  assert.equal(made.length, 1, "one firing, not three");
  assert.equal(made[0].missed, 2, "and it says out loud that two older ones were dropped");
  const now = db.listTimers(C)[0];
  assert.equal(localAt(now.fire_at), "Mon 09:00");
  assert.ok(now.fire_at <= clock.now(), "the newest missed one, so it goes out immediately");
  assert.ok(now.fire_at > firstMonday + 13 * DAY, "the newest, not the oldest");
  // Nothing else is queued behind it.
  assert.equal(db.listTimers(C).length, 1);
  assert.deepEqual(series.schedule(), []);
});

test("a series whose armed firing is still pending is left alone however late the process is", () => {
  at("2026-10-07T20:00:00Z");
  series.start({ conversationId: C, what: "the search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  clock.skip(22 * DAY);
  assert.deepEqual(series.schedule(), [], "the due timer is the one that fires; the sweep adds nothing");
  assert.equal(db.listTimers(C).length, 1);
});

// ---------- the chain: a firing, then the next one ----------

/** The server's wiring with the model replaced: a real Runtime, router, outbox and deliver. */
function harness({ reply = "how's the search going? 👀" } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  const turns = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (call) => { turns.push(call); return typeof reply === "function" ? reply(call, turns.length) : reply; },
    channels: router, deliver,
  });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  return { runtime, turns, logs, fake, deliver };
}

async function says(runtime, text) {
  const handle = `in-${clock.now()}-${Math.random()}`;
  db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
  return await runtime.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
}

test("a firing goes out, the next one is armed, and what they said back reaches it", async () => {
  at("2026-10-07T20:00:00Z");
  const { runtime, turns, fake } = harness();
  const out = series.start({ conversationId: C, what: "how the job search is going", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  const id = out.series.series_id;

  // Monday mid-morning: the 9 o'clock has come round.
  clock.skip(4 * DAY + 18 * HOUR);
  await runtime.sweep();

  assert.equal(fake.sent.length, 1, "one text, one check-in");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, "event");
  assert.match(turns[0].text, /standing check-in they asked for — every monday at 9am, number 1/);
  assert.match(turns[0].text, /about: how the job search is going/);
  assert.match(turns[0].text, /this is the first one/i);

  const after = db.getSeries(C, id);
  assert.equal(after.fired_count, 1);
  assert.ok(after.awaiting_since, "and it is now waiting on an answer");
  // The next one is armed by the same sweep that fired this one, off the rows rather than off the
  // firing — a process that died in between would arm it on its first sweep back.
  const armed = db.listTimers(C);
  assert.equal(armed.length, 1);
  assert.equal(localAt(armed[0].fire_at), "Mon 09:00");
  assert.ok(armed[0].fire_at > clock.now());

  // He answers. Code files it, not the model.
  clock.skip(3 * HOUR);
  await says(runtime, "two applications out, waiting to hear");
  const reported = db.getSeries(C, id);
  assert.equal(reported.last_report, "two applications out, waiting to hear");
  assert.equal(reported.awaiting_since, null, "the wait is settled");

  // Next Monday: the frame carries what he said, with the instruction to pick it up rather than
  // repeat itself.
  clock.skip(7 * DAY);
  await runtime.sweep();
  const fired = turns.filter(t => t.kind === "event");
  assert.equal(fired.length, 2);
  assert.match(fired[1].text, /number 2/);
  assert.match(fired[1].text, /Last time .* they said: "two applications out, waiting to hear"/);
  assert.match(fired[1].text, /Never send the same line twice/);
  assert.equal(db.getSeries(C, id).fired_count, 2);
});

test("a firing the model says nothing to is not waiting on an answer", async () => {
  at("2026-10-07T20:00:00Z");
  // `null` is what the backends hand back for NO_REPLY: the model read the moment and chose silence.
  const { runtime, fake } = harness({ reply: null });
  const out = series.start({ conversationId: C, what: "the job search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  clock.skip(4 * DAY + 18 * HOUR);
  await runtime.sweep();

  assert.equal(fake.sent.length, 0, "nothing was sent");
  const row = db.getSeries(C, out.series.series_id);
  assert.equal(row.fired_count, 0, "so it was not a check-in");
  assert.equal(row.awaiting_since, null);
  // And the next thing he says is about his own day, not a report on a question he never saw.
  clock.skip(HOUR);
  await says(runtime, "my car broke down");
  assert.equal(db.getSeries(C, out.series.series_id).last_report, null);
  // The series still carries on: the next Monday is armed.
  assert.equal(db.listTimers(C).length, 1);
});

test("an answer more than a day late is not filed as the report", async () => {
  at("2026-10-07T20:00:00Z");
  const { runtime } = harness();
  const out = series.start({ conversationId: C, what: "the job search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  const id = out.series.series_id;
  clock.skip(4 * DAY + 18 * HOUR);
  await runtime.sweep();
  assert.ok(db.getSeries(C, id).awaiting_since);

  clock.skip(series.REPORT_WINDOW_MS + HOUR);
  await says(runtime, "anyway, what's the weather saturday");
  const row = db.getSeries(C, id);
  assert.equal(row.last_report, null, "a stale report would make the next check-in wrong");
  assert.equal(row.awaiting_since, null, "and the wait is dropped rather than left open for ever");
});

test("only the series that just asked takes the answer", async () => {
  at("2026-10-07T20:00:00Z");
  const { runtime } = harness();
  const a = series.start({ conversationId: C, what: "the job search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  const b = series.start({ conversationId: C, what: "the workout", repeat: { kind: "weekly", hour: 9, weekdays: ["tuesday"], their_time: true } });

  clock.skip(4 * DAY + 18 * HOUR);          // Monday 9am
  await runtime.sweep();
  clock.skip(DAY);                          // Tuesday 9am
  await runtime.sweep();
  clock.skip(HOUR);
  await says(runtime, "did legs, felt rough");

  assert.equal(db.getSeries(C, b.series.series_id).last_report, "did legs, felt rough", "the newest firing owns it");
  assert.equal(db.getSeries(C, a.series.series_id).last_report, null, "and the older one does not take it too");
});

test("a check-in is a message of its own, even mid-conversation", async () => {
  at("2026-10-07T20:00:00Z");
  const { runtime, fake } = harness({ reply: (call) => call.kind === "event" ? "how's the search going?" : "yeah the game was good" });
  series.start({ conversationId: C, what: "the job search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  clock.skip(4 * DAY + 18 * HOUR);
  await says(runtime, "did u see the game last night");
  await runtime.sweep();
  assert.equal(fake.sent.length, 2, "the answer and the check-in are two texts, never one");
  assert.deepEqual(fake.sent.map(m => m.text), ["yeah the game was good", "how's the search going?"]);
});

// ---------- their data ----------

test("an export carries their check-ins and a delete takes them", async () => {
  at("2026-10-07T20:00:00Z");
  const out = series.start({ conversationId: C, what: "how the job search is going", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  db.setSeriesReport(out.series.series_id, "two applications out");

  const dump = exportData({ conversation: C, audio: false });
  const rows = dump.tables.series;
  assert.equal(rows.length, 1, "a copy of their data has to include what Reason keeps asking them about");
  assert.equal(rows[0].what, "how the job search is going");
  assert.equal(rows[0].last_report, "two applications out", "their own words, in their own export");
  assert.ok(dump.tables.timers.some(t => t.series_id === out.series.series_id), "and the firing it armed");

  await deleteData({ conversation: C });
  assert.deepEqual(db.listSeries(C, { includeEnded: true }), [], "a delete that left it behind would leave Reason still asking");
  assert.equal(db.listTimers(C).length, 0);
});

test("retention drops the words and leaves the arrangement running", () => {
  at("2026-10-07T20:00:00Z");
  const live = series.start({ conversationId: C, what: "the job search", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  const dead = series.start({ conversationId: C, what: "the gym", repeat: { kind: "daily", hour: 19, their_time: true } });
  db.setSeriesReport(live.series.series_id, "two applications out");
  series.end({ conversationId: C, seriesId: dead.series.series_id, why: "done with it" });

  clock.skip((Number(config.keepRecordsDays) + 1) * DAY);
  sweepRetention();

  const kept = db.getSeries(C, live.series.series_id);
  assert.ok(kept, "an arrangement still in force is never swept away");
  assert.equal(kept.state, "active");
  assert.equal(kept.last_report, null, "but the sentence he said is content, and it goes");
  assert.equal(db.getSeries(C, dead.series.series_id), null, "and one stopped long ago is residue");
});
