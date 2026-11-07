// Repeating checks that stay quiet, stay capped, stay stopped and are never late (2026-11).
//
// The case this is built from, with every name taken out: one person with recurring market scans
// got 10-24 texts a day, about six of them only "no new setup this hour". The model had got round
// the cap on standing check-ins by setting a timer from each timer's firing. After they texted STOP
// and then START, a scan they had stopped came back. Timers whose time had long passed fired 17-26
// hours late. Everything below is code's to guarantee, whatever the model does:
//
//   a repeating firing with nothing new — does anything reach them?            (no)
//   one with something new — does it go, without the mark?                     (yes)
//   can a repeating firing text them through message_send instead?            (no)
//   does a timer set from a timer count toward the cap?                         (yes, with series)
//   does a retry of the same firing start a second chain?                       (no, it replaces)
//   STOP (opt-out), then START: does the scan come back?                        (no)
//   a timer 20 hours past its time: is it sent?                                 (no; theirs gets one "missed" line)
//   a "do this now" event held for hours: does it still run once?               (yes)
//   "stop the hourly one" with two running: does the other keep going?          (yes)
//
// No model and no network. Numbers are fake (555).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-quiet-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Owner";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+15550100000";
process.env.REASON_MASTER_NUMBER = "+15550100000";
process.env.REASON_MAX_SERIES = "3";

const db = await import("../src/db.js");
const series = await import("../src/series.js");
const { clock, config } = await import("../src/config.js");
const { runTool } = await import("../src/tools.js");
const { Runtime, timerTooLate } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { withoutSendMark, takeSendMark } = await import("../src/plain.js");

const C = "dm:+15550101111";
const ADDR = "+15550101111";
const HOUR = 3600_000;
const MIN = 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  clock.skip(Date.parse("2026-11-04T15:00:00Z") - clock.now()); // 10am in New York, a Wednesday
  db.db.exec("DELETE FROM series; DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts;"
    + " DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;"
    + " DELETE FROM action_ledger; DELETE FROM notice_seen; DELETE FROM ops_state;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: ADDR, name: "Test Person", isOperator: false });
  db.upsertThread({ conversationId: C, channel: "fake", address: ADDR, isOwner: true, service: "iMessage" });
});

/** A real Runtime, router, outbox and deliver; the model is `reply` (a string, or a function of the turn). */
function harness({ reply = null } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  const turns = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (call) => { turns.push(call); return typeof reply === "function" ? await reply(call, turns.length) : reply; },
    channels: router, deliver,
  });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15550109999" }));
  return { runtime, turns, logs, fake };
}

const sentTo = (fake) => fake.sent.filter(m => m.to === ADDR).map(m => m.text);
const scanTimer = (over = {}) => db.createTimer(C, { fireAt: clock.now() - MIN, note: "scan BTC and gold for a new setup", ...over });

// ---------- 1. quiet unless new ----------

test("a chained scan with nothing new sends nothing — even when the model writes 'no new setup this hour'", async () => {
  const parent = db.createTimer(C, { fireAt: clock.now() - 2 * HOUR, note: "first scan" });
  db.markTimerFired(parent.id);
  const link = scanTimer({ chainedFrom: parent.id });
  const { runtime, turns, fake, logs } = harness({ reply: "no new setup this hour" });
  await runtime.tick();
  assert.equal(turns.length, 1, "the scan ran");
  assert.match(turns[0].text, /QUIET UNLESS NEW/);
  assert.match(turns[0].text, /\[send\]/);
  assert.deepEqual(sentTo(fake), [], "and nothing reached them");
  assert.ok(db.getTimer(C, link.id).fired_at, "the timer is finished with, not retried");
  assert.ok(logs.some(l => l.quiet_nothing_new), "held back by code, on the record");
});

test("a chained scan that found something new goes out once, without the mark", async () => {
  const parent = db.createTimer(C, { fireAt: clock.now() - 2 * HOUR, note: "first scan" });
  db.markTimerFired(parent.id);
  scanTimer({ chainedFrom: parent.id });
  const { runtime, fake } = harness({ reply: "[send] BTC broke 70k on volume, long setup above 70.2k" });
  await runtime.tick();
  assert.deepEqual(sentTo(fake), ["BTC broke 70k on volume, long setup above 70.2k"]);
});

test("a standing check-in's firing is held to the same rule: no mark, no text; mark, one text", async () => {
  const quiet = harness({ reply: "still nothing on the search" });
  series.start({ conversationId: C, what: "the market scan", repeat: { kind: "daily", hour: 10, minute: 30, their_time: true } });
  clock.skip(31 * MIN);
  await quiet.runtime.sweep();
  assert.equal(quiet.turns.length, 1);
  assert.deepEqual(sentTo(quiet.fake), []);
  assert.equal(db.listSeries(C)[0].fired_count, 0, "a check-in nobody saw is not counted as asked");

  const loud = harness({ reply: "[send] gold gapped up, the 2,400 level you wanted is in play" });
  clock.skip(24 * HOUR);
  await loud.runtime.sweep();
  assert.deepEqual(sentTo(loud.fake), ["gold gapped up, the 2,400 level you wanted is in play"]);
  assert.equal(db.listSeries(C)[0].fired_count, 1);
});

test("an ordinary one-off reminder is untouched: it needs no mark", async () => {
  db.createTimer(C, { fireAt: clock.now() - MIN, note: "remind them to call the bank" });
  const { runtime, fake, turns } = harness({ reply: "don't forget to call the bank" });
  await runtime.tick();
  assert.doesNotMatch(turns[0].text, /QUIET UNLESS NEW/);
  assert.deepEqual(sentTo(fake), ["don't forget to call the bank"]);
});

test("a repeating firing cannot text them through message_send instead of its reply", async () => {
  const out = await runTool("message_send", { to: "owner", text: "no new setup this hour" }, { conversationId: C, repeatingCheck: true, fromTimer: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.status, "repeating_check");
});

test("the mark never reaches a person, and only a leading mark counts", () => {
  assert.equal(takeSendMark("no new setup"), null);
  assert.equal(takeSendMark("[send] new high"), "new high");
  assert.equal(takeSendMark("  [SEND]\nnew high"), "new high");
  assert.equal(withoutSendMark("[send] hi"), "hi");
  assert.equal(withoutSendMark("i said [send] earlier"), "i said [send] earlier");
});

// ---------- 2. a chain counts toward the cap ----------

test("a timer set from a firing is a chain link, and chains count toward the cap with series", async () => {
  const firing = scanTimer();
  const out = await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "scan again", continues_check: true }, { conversationId: C, fromTimer: firing.id });
  assert.equal(out.ok, true);
  assert.equal(out.repeating, true);
  assert.equal(db.getTimer(C, out.timer.id).chained_from, firing.id);
  assert.equal(db.countRecurring(C), 1);

  // Two series take it to the cap of three.
  for (const what of ["a", "b"]) {
    assert.ok(series.start({ conversationId: C, what, repeat: { kind: "daily", hour: 9, their_time: true } }).ok);
  }
  // A different firing trying to start another chain: refused, in code.
  const other = scanTimer({ note: "another scan" });
  const refused = await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "scan more", continues_check: true }, { conversationId: C, fromTimer: other.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "recurring_cap");
  // And a fourth series is refused too, because the chain is counted.
  const fourth = series.start({ conversationId: C, what: "d", repeat: { kind: "daily", hour: 9, their_time: true } });
  assert.equal(fourth.ok, false);
  assert.match(fourth.error, /repeating things/);
  // A reminder they asked for in a normal turn is not a chain and is not capped.
  const theirs = await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "call mum" }, { conversationId: C });
  assert.equal(theirs.ok, true);
  assert.equal(db.getTimer(C, theirs.timer.id).chained_from, null);
});

test("a one-off reminder a firing sets for them is not a chain: not capped, not replaced, not gated (review 11-06)", async () => {
  for (const what of ["a", "b", "c"]) series.start({ conversationId: C, what, repeat: { kind: "daily", hour: 9, their_time: true } });
  const firing = scanTimer({ note: "morning brief" });
  const dentist = await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "dentist at 2pm" }, { conversationId: C, fromTimer: firing.id });
  const leave = await runTool("timer_set", { fire_at: new Date(clock.now() + 2 * HOUR).toISOString(), note: "leave at 5:30" }, { conversationId: C, fromTimer: firing.id });
  assert.equal(dentist.ok, true, JSON.stringify(dentist));
  assert.equal(leave.ok, true, JSON.stringify(leave));
  assert.equal(db.getTimer(C, dentist.timer.id).chained_from, null);
  assert.equal(db.getTimer(C, dentist.timer.id).cancelled_at ?? null, null, "the second reminder did not cancel the first");
  assert.equal(dentist.repeating, undefined);
  // The same note as the firing is the check continuing itself, even unflagged.
  const same = await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "morning brief" }, { conversationId: C, fromTimer: firing.id });
  assert.equal(same.ok, false);
  assert.equal(same.status, "recurring_cap");
});

test("a chain at the cap may still continue itself: the firing's own link is replaced, not added", async () => {
  for (const what of ["a", "b"]) series.start({ conversationId: C, what, repeat: { kind: "daily", hour: 9, their_time: true } });
  const root = scanTimer({ note: "first" });
  db.markTimerFired(root.id);
  const link = scanTimer({ chainedFrom: root.id });
  assert.equal(db.countRecurring(C), 3, "at the cap");
  const next = await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "scan again", continues_check: true }, { conversationId: C, fromTimer: link.id });
  assert.equal(next.ok, true, "the firing being replaced is not counted against its own next link");
  // A retry of the same firing does not start a second chain.
  const again = await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR + 5 * MIN).toISOString(), note: "scan again", continues_check: true }, { conversationId: C, fromTimer: link.id });
  assert.equal(again.ok, true);
  assert.equal(again.replaced_timer, next.timer.id);
  assert.equal(db.pendingChainedTimers(C, { except: link.id }).length, 1);
});

test("end to end: the model setting the next scan from a firing makes a chain link", async () => {
  scanTimer();
  const { runtime } = harness({
    reply: async (call) => {
      await runTool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "scan again", continues_check: true }, { ...call, conversationId: C });
      return "NO_REPLY";
    },
  });
  await runtime.tick();
  const links = db.pendingChainedTimers(C);
  assert.equal(links.length, 1, "the firing's ctx reaches the tool, so the link is known as one");
});

// ---------- 3. stop means stopped ----------

/** A message to them that failed because they opted out, as the outbox records it. */
function optedOut() {
  const row = db.enqueueOutbound({ idemKey: `f-${Math.random()}`, conversationId: C, channel: "fake", address: ADDR, body: "x", toOwner: true });
  db.markOutboundFailed(row.row.id, { error: "they've opted out of messages from this number", errorKey: "OPTED_OUT" });
}

test("STOP then START: the scans they stopped stay stopped", async () => {
  const s = series.start({ conversationId: C, what: "hourly-ish market scan", repeat: { kind: "daily", hour: 11, their_time: true } });
  const root = scanTimer({ fireAt: clock.now() + 30 * MIN, note: "first" });
  const link = db.createTimer(C, { fireAt: clock.now() + 2 * HOUR, note: "scan again", chainedFrom: root.id });
  optedOut();
  const { runtime, turns } = harness({ reply: "[send] x" });
  runtime.turnExtras.channels = null;
  clock.skip(HOUR);
  await runtime.tick();
  assert.equal(turns.length, 0, "nothing runs for somebody who opted out");
  assert.equal(db.getSeries(C, s.series.series_id).state, "ended", "a STOP ends it — it is not a pause");
  assert.ok(db.getTimer(C, link.id).cancelled_at, "the chain is called off");

  // START: they text again. They are reachable, and nothing they stopped is running.
  clock.skip(MIN);
  db.claimInbound({ channel: "fake", externalId: `in-${Math.random()}`, conversationId: C, text: "START" });
  assert.equal(db.unreachable(C), null);
  assert.equal(db.countRecurring(C), 0);
  assert.equal((await runTool("series_resume", { series_id: s.series.series_id }, { conversationId: C })).ok, false, "and an ended one cannot be quietly resumed");
  clock.skip(24 * HOUR);
  await runtime.sweep();
  assert.equal(turns.length, 0, "a day later, still nothing");
});

test("resume_everything with no ask for the check-ins leaves them stopped", async () => {
  series.start({ conversationId: C, what: "the scan", repeat: { kind: "daily", hour: 11, their_time: true } });
  assert.equal((await runTool("pause_everything", { said: "stop" }, { conversationId: C })).ok, true);
  const r = await runTool("resume_everything", {}, { conversationId: C });
  assert.equal(r.ok, true);
  assert.equal(db.listSeries(C)[0].state, "paused");
  assert.equal(db.pendingSeriesTimer(db.listSeries(C)[0].id), null, "and nothing armed for it");
  const back = await runTool("resume_everything", {}, { conversationId: C });
  assert.equal(back.ok, false, "not paused any more");
  const asked = await runTool("series_resume", { series_id: db.listSeries(C)[0].id }, { conversationId: C });
  assert.equal(asked.ok, true, "when they ask for it by name, it comes back");
});

// ---------- 4. never late ----------

test("their own reminder 20 hours past its time is not sent late: one line says it was missed", async () => {
  const t = db.createTimer(C, { fireAt: clock.now() + MIN, note: "move the car" });
  clock.skip(20 * HOUR);
  const { runtime, turns, fake } = harness({ reply: "move the car!" });
  await runtime.tick();
  assert.equal(turns.length, 0, "no turn for a moment that has gone");
  const said = sentTo(fake);
  assert.equal(said.length, 1);
  assert.match(said[0], /missed/);
  assert.match(said[0], /not sending it late/);
  assert.match(db.getTimer(C, t.id).skipped_why, /late by/);
  await runtime.tick();
  assert.equal(sentTo(fake).length, 1, "told once");
});

test("a late scan link or series firing is dropped quietly; the series carries on, the chain is over", async () => {
  const s = series.start({ conversationId: C, what: "the scan", repeat: { kind: "daily", hour: 11, their_time: true } });
  const root = scanTimer({ note: "first" });
  db.markTimerFired(root.id);
  const link = db.createTimer(C, { fireAt: clock.now() + MIN, note: "scan again", chainedFrom: root.id });
  clock.skip(30 * HOUR); // Thursday 4pm: Wednesday's 11am firing and Thursday's are both hours gone
  const { runtime, turns, fake } = harness({ reply: "[send] x" });
  await runtime.tick();
  assert.equal(turns.length, 0);
  assert.deepEqual(sentTo(fake), []);
  assert.ok(db.getTimer(C, link.id).skipped_why);
  // The series makes its next firing for the future, never the late one.
  series.schedule();
  const armed = db.pendingSeriesTimer(s.series.series_id);
  assert.ok(armed && armed.fire_at > clock.now());
});

test("inside the window it still fires; a 'do this now' event held for hours still runs once", async () => {
  const onTime = db.createTimer(C, { fireAt: clock.now() - 30 * MIN, note: "a little late is fine" });
  assert.equal(timerTooLate(db.getTimer(C, onTime.id)), false);
  const now = db.createTimer(C, { fireAt: clock.now(), note: "the approval came through: confirm again" });
  clock.skip(5 * HOUR);
  assert.equal(timerTooLate(db.getTimer(C, now.id)), false, "it was always 'now'");
  assert.equal(timerTooLate(db.getTimer(C, onTime.id)), true);
  assert.ok(config.timerLateMs >= HOUR);
});

test("a time already in the past is refused when it is set, never armed", async () => {
  const out = await runTool("timer_set", { fire_at: new Date(clock.now() - 5 * MIN).toISOString(), note: "x" }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.match(out.error, /already in the past/);
});

// ---------- 5. stop just the one ----------

test("'stop the hourly one': series_list shows the repeating timers, and cancelling one leaves the rest", async () => {
  series.start({ conversationId: C, what: "the morning brief", repeat: { kind: "daily", hour: 8, their_time: true } });
  const root = scanTimer({ note: "first" });
  db.markTimerFired(root.id);
  const hourly = db.createTimer(C, { fireAt: clock.now() + HOUR, note: "hourly BTC scan", chainedFrom: root.id });
  const root2 = scanTimer({ note: "first gold" });
  db.markTimerFired(root2.id);
  const gold = db.createTimer(C, { fireAt: clock.now() + 4 * HOUR, note: "4-hourly gold scan", chainedFrom: root2.id });

  const list = await runTool("series_list", {}, { conversationId: C });
  assert.equal(list.series.length, 1);
  assert.deepEqual(list.repeating_timers.map(x => x.what), ["hourly BTC scan", "4-hourly gold scan"]);
  assert.match(list.note, /stop only that one/);

  const cut = await runTool("timer_cancel", { timer_id: hourly.id }, { conversationId: C });
  assert.equal(cut.ok, true);
  assert.match(cut.note, /stopped for good/);
  assert.equal(db.getTimer(C, gold.id).cancelled_at, null, "the other scan keeps going");
  assert.equal(db.listSeries(C)[0].state, "active", "and so does the series");
});

test("one person's chains are never another's: the count and the list are per conversation", async () => {
  const OTHER = "dm:+15550102222";
  const root = db.createTimer(OTHER, { fireAt: clock.now() - MIN, note: "x" });
  db.createTimer(OTHER, { fireAt: clock.now() + HOUR, note: "their scan", chainedFrom: root.id });
  assert.equal(db.countRecurring(C), 0);
  const list = await runTool("series_list", {}, { conversationId: C });
  assert.equal(list.repeating_timers, undefined);
  const cut = await runTool("timer_cancel", { timer_id: db.pendingChainedTimers(OTHER)[0].id }, { conversationId: C });
  assert.equal(cut.ok, false, "cannot stop somebody else's");
});
