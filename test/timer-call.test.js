// A timer that ends in a phone call. "Call me at 7 tomorrow", "wake me up at 6:30 with a call",
// "ring me in 20 minutes so I actually leave" — the firing rings their own phone and opens with why,
// instead of texting. No model, no network, no phone: the fake call provider records what it was
// asked to dial and say, and the fake channel records what was texted.
//
//   "call me at 7 tomorrow" → the timer carries the call, and firing places it   (no text, no turn)
//   "remind me at 7" → a text, as ever                                            (no call)
//   a 6:30 wake-up they named is rung at 6:30, not moved out of the night
//   a call Reason timed itself IS moved, on an explicit their_time: false
//   the call cannot be placed → ONE honest text, and never a second one
//   the day's call cap is used up → a text, not silence
//   "never mind the call" → nothing rings
//   nobody picks up → one text saying it tried, from whichever path settled the call
//   a retry after a crash finds the call row and does not ring twice
//   "call me every weekday at 7" → a standing series of calls
//   no phone line on the install → refused when they ask, not at 7am
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-timer-call-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TIMER_MAX_ATTEMPTS = "3";
process.env.REASON_TIMER_RETRY_BACKOFF_MS = "60000";
process.env.REASON_MAX_CALLS_PER_DAY = "2";
process.env.REASON_UNDO_SECONDS = "0";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const { makeDeliver } = await import("../src/deliver.js");
const { runTool, callLostAfterMs } = await import("../src/tools.js");
const { announcementFor, requireAnnouncement } = await import("../src/calls/provider.js");
const { scheduledCallNote } = await import("../src/calls/voice.js");
const db = await import("../src/db.js");
const accounts = await import("../src/accounts.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const CONV = "dm:owner";
const MIN = 60_000;
const GOAL = "you asked me to call at 7 to get you up";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM timers; DELETE FROM series; DELETE FROM calls; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM notice_seen;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
  // The first call ever on a number queues the once-ever "calls are recorded" text (recordingNoteFor
  // in src/calls/inbound.js). That is the existing rule and not what is pinned here, so the person
  // has already had it — except in the one test that checks it is still the only extra text.
  db.markToldCallsRecorded(CONV);
});

/** The server's own wiring with the model replaced by `turn` and the phone by the fake provider. */
function harness({ turn = async () => "time to get up ☀️", calls = new FakeCallProvider() } = {}) {
  const turns = [];
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (call) => { turns.push(call); return await turn(call, turns.length); },
    channels: router, calls, deliver,
  });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  return { runtime, router, fake, calls, turns, logs };
}

/** ISO 8601 with offset for `ms`, the way the model passes fire_at. */
const iso = (ms) => new Date(ms).toISOString();
/** A one-off timer that rings, set `inMs` from now through the real tool, with the provider the harness holds. */
async function setCall(h, { inMs = 10 * MIN, goal = GOAL, extra = {} } = {}) {
  return await runTool("timer_set", { fire_at: iso(clock.now() + inMs), note: "wake-up call", then_call: goal, ...extra }, { conversationId: CONV, calls: h.calls });
}
const timer = (id) => db.getTimer(CONV, id);
const outboxRows = () => db.db.prepare("SELECT * FROM outbox ORDER BY id").all();

// ---------- the pinned cases ----------

test("\"call me at 7 tomorrow\": the timer carries the call, and firing places it — no text, no model turn", async () => {
  const h = harness();
  const set = await setCall(h);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.timer.calls_them, GOAL, "the timer says it is a call, and what it opens with");
  assert.match(set.say_back, /ring them/);
  assert.equal(timer(set.timer.id).call_goal, GOAL);

  // Not due yet: nothing rings early.
  assert.equal(await h.runtime.tick(), 0);
  assert.equal(h.calls.placed.length, 0);

  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1, "finished with");
  assert.equal(h.turns.length, 0, "no model turn — the firing IS the call");
  assert.equal(h.fake.sent.length, 0, "no text first");
  assert.equal(h.calls.placed.length, 1, "the phone rang");
  const placed = h.calls.placed[0];
  assert.equal(placed.to, OWNER, "their own number");
  assert.equal(placed.goal, GOAL);
  assert.equal(placed.announcement, `hey Omari — ${GOAL}.`, "the first words say why it is ringing");
  assert.doesNotMatch(placed.announcement, /recorded|AI assistant/i, "still an owner greeting: nothing announced at them");

  const row = db.listCalls(CONV)[0];
  assert.equal(row.timer_id, set.timer.id, "the call row points back at the timer");
  assert.equal(row.is_owner, 1);
  assert.ok(timer(set.timer.id).fired_at, "and only now is the timer fired");
  assert.equal(outboxRows().length, 0);

  // Never again.
  clock.skip(10 * MIN);
  assert.equal(await h.runtime.tick(), 0);
  assert.equal(h.calls.placed.length, 1, "exactly once");
});

test("\"remind me at 7\" stays a text: no then_call, no call", async () => {
  const h = harness();
  const set = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "remind Omari it is 7" }, { conversationId: CONV, calls: h.calls });
  assert.equal(set.ok, true);
  assert.equal(set.timer.calls_them, undefined);
  assert.equal(timer(set.timer.id).call_goal, null);
  clock.skip(5 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.turns.length, 1, "the ordinary event turn ran");
  assert.deepEqual(h.fake.sent.map(m => [m.to, m.text]), [[OWNER, "time to get up ☀️"]]);
  assert.equal(h.calls.placed.length, 0, "nobody's phone rang");
});

test("a wake-up they named for 6:30 rings at 6:30: quiet hours do not move it", async () => {
  const h = harness();
  // 06:30 tomorrow, New York.
  const tomorrow = new Date(clock.now() + 24 * 3600_000);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(tomorrow);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(tomorrow).find(p => p.type === "timeZoneName").value.replace("GMT", "");
  const at = `${ymd}T06:30:00${offset || "-05:00"}`;
  const named = await runTool("timer_set", { fire_at: at, note: "wake-up", then_call: "you asked me to wake you at 6:30" }, { conversationId: CONV, calls: h.calls });
  assert.equal(named.ok, true, JSON.stringify(named));
  assert.equal(timer(named.timer.id).fire_at, Date.parse(at), "rings at the minute they said");
  assert.equal(named.moved, undefined);

  // their_time: true says the same thing out loud.
  const theirs = await runTool("timer_set", { fire_at: at, note: "wake-up", then_call: "wake you", their_time: true }, { conversationId: CONV, calls: h.calls });
  assert.equal(timer(theirs.timer.id).fire_at, Date.parse(at));

  // Only a time Reason picked itself (their_time: false) is pulled out of the night, to 8am.
  const mine = await runTool("timer_set", { fire_at: at, note: "check-in call", then_call: "checking in", their_time: false }, { conversationId: CONV, calls: h.calls });
  assert.equal(mine.ok, true);
  assert.ok(mine.moved, "moved, and said so");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: false }).format(timer(mine.timer.id).fire_at);
  assert.equal(parts, "08:00");
  assert.match(mine.note, /moved to/);
});

test("the call cannot be placed: ONE honest text saying it tried and why, never a second", async () => {
  const h = harness({ calls: new FakeCallProvider({ script: [{ placeFails: "the provider is out of credit" }] }) });
  const set = await setCall(h);
  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.turns.length, 0);
  assert.equal(h.fake.sent.length, 1, "one text");
  assert.equal(h.fake.sent[0].to, OWNER);
  assert.match(h.fake.sent[0].text, /tried to call u/);
  assert.match(h.fake.sent[0].text, new RegExp(GOAL), "the thing the call was for still reaches them");
  assert.match(h.fake.sent[0].text, /couldn't be placed/);
  assert.match(h.fake.sent[0].text, /out of credit/, "and why");
  assert.ok(timer(set.timer.id).fired_at);
  assert.deepEqual(outboxRows().map(r => [r.idem_key, r.state]), [[`timer:${set.timer.id}:fire`, "sent"]], "under the timer's own key");
  const row = db.listCalls(CONV)[0];
  assert.equal(row.state, "failed", "the attempt is on the record");

  clock.skip(10 * MIN);
  assert.equal(await h.runtime.tick(), 0);
  assert.equal(h.fake.sent.length, 1, "exactly once");
});

test("the day's call cap is used up: a text, not silence, and no call", async () => {
  const h = harness();
  const set = await setCall(h);
  accounts.countUse(CONV, "call");
  accounts.countUse(CONV, "call");
  assert.equal(accounts.withinCap(CONV, "call").ok, false, "the cap is really reached");
  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.calls.placed.length, 0, "nobody's phone rang");
  assert.equal(h.fake.sent.length, 1);
  assert.match(h.fake.sent[0].text, /tried to call u/);
  assert.match(h.fake.sent[0].text, /today's call limit is used up/, "the cap is named, in their words");
  assert.doesNotMatch(h.fake.sent[0].text, /IMPORTANT|Say that plainly|REASON_MAX|for Omari/, "none of the model-facing instruction leaks");
  assert.ok(timer(set.timer.id).fired_at);
});

test("\"never mind the call\": timer_cancel, and nothing rings", async () => {
  const h = harness();
  const set = await setCall(h);
  const listed = await runTool("timer_list", {}, { conversationId: CONV });
  assert.equal(listed.timers[0].calls_them, GOAL, "the list shows which one is the call");
  const cancelled = await runTool("timer_cancel", { timer_id: set.timer.id }, { conversationId: CONV });
  assert.equal(cancelled.ok, true);
  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 0);
  assert.equal(h.calls.placed.length, 0);
  assert.equal(h.fake.sent.length, 0);
  assert.equal(h.turns.length, 0);
});

test("nobody picks up: the call is placed, and when it settles ONE text says it tried", async () => {
  const h = harness({ calls: new FakeCallProvider({ script: [{ state: "no_answer", outcome: "no answer", transcript: "", durationS: 0, recording: null }] }) });
  const set = await setCall(h);
  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.calls.placed.length, 1);
  assert.equal(h.fake.sent.length, 0, "nothing texted while it rings");

  // The lost-calls sweep is the path that needs no webhook and no model; it settles the row.
  clock.skip(callLostAfterMs() + 1000);
  const settled = await h.runtime.lostCalls();
  assert.equal(settled.settled, 1);
  const row = db.listCalls(CONV)[0];
  assert.equal(row.state, "no_answer");
  assert.ok(row.missed_told_at, "claimed once");
  const queued = outboxRows().find(r => r.idem_key === `timer:${set.timer.id}:call_missed`);
  assert.ok(queued, "the one text is queued under the timer's key");
  assert.match(queued.body, /tried calling u/);
  assert.match(queued.body, /didn't pick up/);
  assert.match(queued.body, new RegExp(GOAL));

  await h.runtime.outbox();
  assert.deepEqual(h.fake.sent.map(m => m.to), [OWNER]);
  assert.equal(h.turns.length, 0, "the owner's own missed call is never an event turn");

  // Settling it again, by any path, says nothing more.
  await h.runtime.lostCalls();
  await h.runtime.outbox();
  assert.equal(h.fake.sent.length, 1, "exactly once");
});

test("a retry after a crash finds the call row and does not ring twice", async () => {
  const h = harness();
  const set = await setCall(h);
  clock.skip(10 * MIN + 1000);
  // The process died between the dial and the mark: the row exists, the timer is still due.
  db.createCall(CONV, { provider: "fake", toNumber: OWNER, isOwner: true, goal: GOAL, facts: [], announcement: "hey Omari", timerId: set.timer.id });
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.calls.placed.length, 0, "the phone does not ring again");
  assert.equal(h.fake.sent.length, 0);
  assert.ok(timer(set.timer.id).fired_at);
});

test("\"call me every weekday at 7\": a standing series of calls, each firing rings", async () => {
  const h = harness();
  const set = await runTool("timer_set", {
    note: "morning wake-up call", then_call: "you asked me to call every weekday at 7 to get you up",
    repeat: { kind: "weekdays", hour: 7, their_time: true },
  }, { conversationId: CONV, calls: h.calls });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.match(set.say_back, /i'll ring you/);
  assert.equal(set.series.calls_them, "you asked me to call every weekday at 7 to get you up");
  const first = timer(set.timer_id);
  assert.equal(first.call_goal, "you asked me to call every weekday at 7 to get you up", "the firing carries the call");
  assert.equal(first.note, "morning wake-up call" === first.note ? first.note : "standing call: morning wake-up call");

  clock.skip(first.fire_at - clock.now() + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.calls.placed.length, 1);
  assert.equal(h.turns.length, 0);
  assert.equal(h.fake.sent.length, 0);
  assert.equal(db.seriesById(set.series.series_id).fired_count, 1, "counted as a firing of the series");

  // The next occurrence is a call too.
  h.runtime.series?.();
  const { schedule } = await import("../src/series.js");
  schedule();
  const next = db.pendingSeriesTimer(set.series.series_id);
  assert.ok(next, "the next one is armed");
  assert.equal(next.call_goal, first.call_goal);
});

test("no phone line on this install: refused when they ask, with a text offered — not at 7am", async () => {
  const off = new FakeCallProvider({ live: false });
  const set = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "wake-up", then_call: GOAL }, { conversationId: CONV, calls: off });
  assert.equal(set.ok, false);
  assert.equal(set.status, "not_connected");
  assert.match(set.error, /offer a text/);
  assert.equal(db.listTimers(CONV).length, 0, "no timer that would fail at 7");

  const none = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "wake-up", then_call: GOAL }, { conversationId: CONV });
  assert.equal(none.ok, false);
});

test("the goal never carries payment details, and a goal the greeting guard refuses still rings with the plain greeting", async () => {
  const h = harness();
  const pay = await setCall(h, { goal: "read them card 4111 1111 1111 1111" });
  assert.equal(pay.ok, false);
  assert.equal(pay.status, "payment_details_refused");

  // "a call for" reads like the stranger line to the provider's guard; the call still goes, opening plainly.
  const set = await setCall(h, { goal: "you wanted a call for the airport run" });
  assert.equal(set.ok, true);
  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.calls.placed.length, 1);
  assert.equal(h.calls.placed[0].announcement, "hey Omari, what's up?");
  assert.equal(h.calls.placed[0].goal, "you wanted a call for the airport run", "the voice turn still knows why");
});

// ---------- the words ----------

test("announcementFor opens an owner call with why, and the owner guard still holds", () => {
  assert.equal(announcementFor({ ownerName: "Omari", toOwner: true, because: "you asked me to call at 7 to get you up." }), "hey Omari — you asked me to call at 7 to get you up.");
  assert.equal(announcementFor({ ownerName: "Omari", toOwner: true }), "hey Omari, what's up?");
  assert.equal(announcementFor({ ownerName: "the person I work for", toOwner: true, because: "wake up" }), "hey — wake up.");
  assert.equal(requireAnnouncement({ announcement: announcementFor({ ownerName: "Omari", toOwner: true, because: "time to get up" }), ownerName: "Omari", toOwner: true }).ok, true);
  assert.equal(requireAnnouncement({ announcement: announcementFor({ ownerName: "Omari", toOwner: true, because: "this call is recorded" }), ownerName: "Omari", toOwner: true }).ok, false);
  // A third-party call is untouched by `because`.
  assert.match(announcementFor({ ownerName: "Omari", toOwner: false, because: "x" }), /AI assistant calling for Omari/);
});

test("the voice turn is told why Reason rang, and only on a call Reason placed at a timer", () => {
  assert.match(scheduledCallNote({ direction: "out", timer_id: 4, goal: GOAL }), /YOU rang THEM/);
  assert.match(scheduledCallNote({ direction: "out", timer_id: 4, goal: GOAL }), new RegExp(GOAL));
  assert.equal(scheduledCallNote({ direction: "in", timer_id: 4, goal: GOAL }), "");
  assert.equal(scheduledCallNote({ direction: "out", timer_id: null, goal: GOAL }), "");
  assert.equal(scheduledCallNote(null), "");
});

test("the kept note marks a pending call as by phone, so the model never reads it as a text", async () => {
  const h = harness();
  await setCall(h);
  const { keptNote } = await import("../src/kept.js");
  assert.match(keptNote(CONV), /"by_phone":true/);
});

test("the very first call on a number still gets the once-ever recording note, and nothing else", async () => {
  db.db.exec("UPDATE accounts SET told_calls_recorded_at = NULL");
  const h = harness();
  await setCall(h);
  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.calls.placed.length, 1);
  assert.deepEqual(outboxRows().map(r => r.idem_key), [`call:${db.listCalls(CONV)[0].id}:recording-note`]);
  await h.runtime.outbox();
  assert.equal(h.fake.sent.length, 1);
  assert.match(h.fake.sent[0].text, /every call is recorded/);
});

test("a call timer is not dropped by the proactive ceiling: they asked for it", async () => {
  const h = harness();
  const set = await setCall(h);
  for (let i = 0; i < config.maxProactivePerDay + 1; i++) accounts.countUse(CONV, "proactive");
  assert.equal(h.runtime.mayInterrupt(CONV), false);
  clock.skip(10 * MIN + 1000);
  assert.equal(await h.runtime.tick(), 1);
  assert.equal(h.calls.placed.length, 1, "it rang anyway");
  assert.ok(timer(set.timer.id).fired_at);
});
