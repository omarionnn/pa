// A timer is fired once its message is in the outbox, and not before. No model, no network.
//
// The incident this pins, 2026-10-06: the 10:00 AM reminder came due at 10:36 because the Mac had
// been asleep. The sweep marked it fired and started the turn. The Mac slept again ninety seconds
// later, and on waking the CLI was killed for not finishing "inside 300000ms" — wall time, most of
// it asleep. The turn threw, the timer was already spent, and nothing was ever sent, retried or
// said. The mark came first "so a crash mid-turn can't double-fire", which made every failed turn
// a lost reminder instead.
//
//   does a turn that times out lose the reminder?                 (no — the timer stays due)
//   is it delivered on a later sweep?                             (yes — the very next one)
//   can retrying send it twice?                                   (no — one outbox row per firing)
//   can two overlapping sweeps both run it?                       (no — one turn at a time)
//   does it retry for ever?                                       (no — three tries)
//   and when it gives up?                                         (one line saying so, exactly once)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-timer-claim-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TIMER_MAX_ATTEMPTS = "3";
process.env.REASON_TIMER_RETRY_BACKOFF_MS = "60000";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const CONV = "dm:owner";
const MIN = 60_000;
const TIMEOUT = "the CLI did not finish inside 300000ms";
const NOTE = "daily challenge: remind Omari to work out today";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM notice_seen;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

/**
 * The server's own wiring — a real Runtime, a real router and outbox, the deliver function
 * serve.js uses — with the model replaced by `turn`. `turn` gets the call and how many there have
 * been, so a test can make the first one die the way the real one did.
 */
function harness({ channel = {}, turn = async () => "time to work out 💪" } = {}) {
  const turns = [];
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (call) => { turns.push(call); return await turn(call, turns.length); },
    channels: router, deliver,
  });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639", ...channel }));
  return { runtime, router, fake, turns, logs, deliver };
}

/** A timer that came due a moment ago. */
function dueTimer(note = NOTE) {
  const t = db.createTimer(CONV, { fireAt: clock.now() + MIN, note });
  clock.skip(MIN + 1000);
  return t;
}
const timer = (id) => db.getTimer(CONV, id);
const rows = () => db.db.prepare("SELECT * FROM outbox ORDER BY id").all();

// ---------- the incident ----------

test("a timer whose turn times out is not fired, and is delivered on the next sweep, exactly once", async () => {
  const { runtime, fake, turns } = harness({
    turn: async (_call, n) => { if (n === 1) throw new Error(TIMEOUT); return "time to work out 💪"; },
  });
  const t = dueTimer();

  // The sweep that hit the timeout. It used to leave the timer fired and the reminder gone.
  assert.equal(await runtime.tick(), 0, "nothing was finished with");
  assert.equal(turns.length, 1, "the turn ran and died");
  assert.equal(timer(t.id).fired_at, null, "so the timer is NOT fired: its message never reached the outbox");
  assert.equal(timer(t.id).attempts, 1, "one try spent");
  assert.equal(timer(t.id).last_error, TIMEOUT, "and why is on the row");
  assert.equal(rows().length, 0, "nothing in the outbox");
  assert.equal(fake.sent.length, 0, "nothing sent");

  // The next sweep. No clock skipped: the first retry does not wait.
  assert.equal(await runtime.tick(), 1, "now it is finished with");
  assert.equal(turns.length, 2);
  assert.match(turns[1].text, /try 2 at the same timer/, "the model is told this is the same reminder arriving late");
  assert.match(turns[1].text, /not a second one/);
  assert.deepEqual(fake.sent.map(m => [m.to, m.text]), [[OWNER, "time to work out 💪"]], "the reminder reached the phone");
  assert.ok(timer(t.id).fired_at, "and only now is the timer fired");
  assert.equal(timer(t.id).gave_up_at, null);
  assert.deepEqual(rows().map(r => [r.idem_key, r.state]), [[`timer:${t.id}:fire`, "sent"]], "one outbox row, keyed to this timer's firing");

  // And never again, however many sweeps follow.
  clock.skip(10 * MIN);
  assert.equal(await runtime.tick(), 0);
  assert.equal(await runtime.tick(), 0);
  assert.equal(turns.length, 2, "no third turn");
  assert.equal(fake.sent.length, 1, "exactly once");
});

test("a whole sweep survives a timer turn that throws, and the things after it still run", async () => {
  const { runtime, fake } = harness({
    turn: async ({ text }) => { if (/first/.test(text)) throw new Error(TIMEOUT); return "second one"; },
  });
  db.createTimer(CONV, { fireAt: clock.now() + 1000, note: "the first" });
  db.createTimer(CONV, { fireAt: clock.now() + 2000, note: "the second" });
  clock.skip(MIN);

  // It used to throw out of tick(), which took the rest of the sweep down with it.
  const out = await runtime.sweep();
  assert.equal(out.timers, 1, "the one behind it was not held up");
  assert.deepEqual(fake.sent.map(m => m.text), ["second one"]);
});

// ---------- never twice ----------

test("two sweeps that overlap run one turn for a timer, not two", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { runtime, fake, turns } = harness({ turn: async () => { await gate; return "time to work out 💪"; } });
  const t = dueTimer();

  // The interval does not wait for a turn: the second sweep starts while the first is mid-turn,
  // and the timer is — correctly — still unfired when it looks.
  const first = runtime.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(timer(t.id).fired_at, null, "mid-turn, the timer is still due");
  assert.equal(await runtime.tick(), 0, "the second sweep leaves it alone");
  assert.equal(await runtime.tick(), 0, "and so does a third");
  release();
  assert.equal(await first, 1);

  assert.equal(turns.length, 1, "one turn");
  assert.equal(fake.sent.length, 1, "one message");
  assert.equal(timer(t.id).attempts, 1, "and the sweeps that looked did not spend a try");
});

test("a sweep working from a stale list does not re-fire what another sweep finished", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { runtime, fake, turns } = harness({
    turn: async ({ text }) => { if (/slow/.test(text)) await gate; return /slow/.test(text) ? "slow one" : "quick one"; },
  });
  const slow = db.createTimer(CONV, { fireAt: clock.now() + 1000, note: "slow" });
  const quick = db.createTimer(CONV, { fireAt: clock.now() + 2000, note: "quick" });
  db.upsertAccount({ conversationId: "dm:other", channel: "fake", address: "+14155559876", name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: "dm:other", channel: "fake", address: "+14155559876", isOwner: true, service: "iMessage" });
  // In another conversation, so its turn is not queued behind the slow one.
  db.db.prepare("UPDATE timers SET conversation_id = 'dm:other' WHERE id = ?").run(quick.id);
  clock.skip(MIN);

  // Sweep A reads [slow, quick] and stops on slow. Sweep B fires quick. A then reaches quick from
  // a list that still says it is due.
  const a = runtime.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(await runtime.tick(), 1, "sweep B fires the quick one");
  release();
  assert.equal(await a, 1, "sweep A finishes the slow one, and only that");

  assert.equal(turns.length, 2, "one turn each");
  assert.deepEqual(fake.sent.map(m => m.text).sort(), ["quick one", "slow one"]);
  assert.ok(timer(slow.id).fired_at);
});

test("a process that stopped between the handoff and the mark sends nothing new when it comes back", async () => {
  const { runtime, fake, turns, deliver } = harness();
  const t = dueTimer();
  // What the last process left behind: the reminder in the outbox under this timer's key, and
  // the timer row still saying it has not fired.
  await deliver({ conversationId: CONV, text: "time to work out 💪", media: null, idempotencyKey: `timer:${t.id}:fire` });
  assert.equal(fake.sent.length, 1);
  assert.equal(timer(t.id).fired_at, null);

  assert.equal(await runtime.tick(), 1, "the timer is settled");
  assert.ok(timer(t.id).fired_at);
  assert.equal(turns.length, 0, "with no second turn — the message is already there");
  assert.equal(fake.sent.length, 1, "and no second text");
});

test("the same key through deliver twice is one message, whatever the second one says", async () => {
  const { fake, deliver } = harness();
  const a = await deliver({ conversationId: CONV, text: "time to work out 💪", media: null, idempotencyKey: "timer:9:fire" });
  const b = await deliver({ conversationId: CONV, text: "hey, workout time", media: null, idempotencyKey: "timer:9:fire" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, "the second ask is answered from the first row");
  assert.deepEqual(fake.sent.map(m => m.text), ["time to work out 💪"], "only the first ever left");
  // No key, as every other message has none: two asks are two messages, as they always were.
  await deliver({ conversationId: CONV, text: "one", media: null });
  await deliver({ conversationId: CONV, text: "one", media: null });
  assert.equal(fake.sent.length, 3);
});

test("a reminder with a link in it is still one firing: its parts are found under the timer's key", async () => {
  const { runtime, fake, turns } = harness({ turn: async () => "here's the plan https://example.com/workout have a look" });
  const t = dueTimer();
  assert.equal(await runtime.tick(), 1);
  const keys = rows().map(r => r.idem_key);
  assert.ok(keys.length > 1 && keys.every(k => k.startsWith(`timer:${t.id}:fire#`)), `several rows, all this timer's: ${keys.join(", ")}`);
  const sentSoFar = fake.sent.length;

  // The mark is lost. The rows are what stop a second turn, not the timer's own flag.
  db.db.prepare("UPDATE timers SET fired_at = NULL WHERE id = ?").run(t.id);
  assert.equal(await runtime.tick(), 1);
  assert.equal(turns.length, 1);
  assert.equal(fake.sent.length, sentSoFar);
});

// ---------- what counts as handed over ----------

test("silence is an answer: NO_REPLY fires the timer and is not retried", async () => {
  const { runtime, fake, turns } = harness({ turn: async () => null });
  const t = dueTimer();
  assert.equal(await runtime.tick(), 1);
  assert.ok(timer(t.id).fired_at, "the model chose to say nothing, which is not a failure");
  assert.equal(await runtime.tick(), 0);
  assert.equal(turns.length, 1);
  assert.equal(fake.sent.length, 0);
});

test("a message the outbox is still retrying is the outbox's now: the timer is fired and the turn is not run again", async () => {
  const { runtime, fake, turns } = harness({ channel: { failTimes: 1 } });
  const t = dueTimer();
  assert.equal(await runtime.tick(), 1, "handed over, which is all the timer waits for");
  assert.ok(timer(t.id).fired_at);
  assert.equal(fake.sent.length, 0, "not arrived yet");
  assert.equal(rows()[0].state, "queued");

  clock.skip(config.outboxBackoffMs + 1000);
  await runtime.sweep();
  assert.equal(fake.sent.length, 1, "the outbox got it there");
  assert.equal(turns.length, 1, "on the one turn");
});

test("a message that died inside the outbox is reported by the outbox, not re-run by the timer", async () => {
  const { runtime, fake, turns } = harness({ channel: { failWith: "the line is blocked" } });
  const t = dueTimer();
  assert.equal(await runtime.tick(), 1);
  assert.ok(timer(t.id).fired_at);
  assert.equal(timer(t.id).gave_up_at, null);
  assert.equal(rows()[0].state, "failed", "there is a row, so their next turn opens with the fact that it never arrived");
  assert.equal(db.undeliveredFor(CONV).length, 1);
  await runtime.tick();
  assert.equal(turns.length, 1);
  assert.equal(fake.sent.length, 0);
});

test("written but never handed over — no row at all — leaves the timer due, and it goes out once the channel is back", async () => {
  const { runtime, fake, turns } = harness({ channel: { live: false } });
  const t = dueTimer();
  assert.equal(await runtime.tick(), 0);
  assert.equal(rows().length, 0, "a channel that is not connected is refused before the outbox");
  assert.equal(timer(t.id).fired_at, null, "so nothing would ever retry or report it, and the timer has to");
  assert.match(timer(t.id).last_error, /could not be handed over/);

  fake.live = true;
  assert.equal(await runtime.tick(), 1);
  assert.equal(fake.sent.length, 1);
  assert.equal(turns.length, 2);
});

// ---------- bounded, and out loud ----------

test("a timer whose turn keeps failing is tried three times, then they are told once that a reminder was missed", async () => {
  const { runtime, fake, turns, logs } = harness({ turn: async () => { throw new Error(TIMEOUT); } });
  const t = dueTimer();
  const fireAt = timer(t.id).fire_at;

  assert.equal(await runtime.tick(), 0);
  assert.equal(await runtime.tick(), 0, "the first retry is the next sweep");
  assert.equal(turns.length, 2);

  // The second retry waits a step, so a failure that is not going away does not burn every try
  // inside one minute.
  assert.equal(await runtime.tick(), 0);
  assert.equal(turns.length, 2, "not yet");
  assert.equal(timer(t.id).next_try_at > clock.now(), true);
  clock.skip(config.timerRetryBackoffMs + 1000);

  assert.equal(await runtime.tick(), 1, "the third failure is the last: it is finished with");
  assert.equal(turns.length, 3, "three tries, no more");
  const row = timer(t.id);
  assert.ok(row.fired_at && row.gave_up_at, "spent, and marked as given up rather than delivered");
  assert.equal(row.attempts, 3);
  assert.equal(row.last_error, TIMEOUT);

  assert.equal(fake.sent.length, 1, "one line");
  const line = fake.sent[0].text;
  assert.equal(fake.sent[0].to, OWNER);
  assert.match(line, /missed a reminder/, "it says what happened");
  assert.ok(line.includes(NOTE), "and what the reminder was");
  assert.ok(line.includes(new Date(fireAt).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })), "and when it was for");
  assert.doesNotMatch(line, /300000ms|CLI/, "without the stack trace: the why is on the row and in the log");
  assert.ok(logs.some(l => l.timer === t.id && l.gave_up === TIMEOUT));
  assert.equal(rows().at(-1).idem_key, `timer:${t.id}:missed`);

  // Given up is given up.
  clock.skip(60 * MIN);
  assert.equal(await runtime.tick(), 0);
  assert.equal(await runtime.sweep().then(o => o.timers), 0);
  assert.equal(turns.length, 3);
  assert.equal(fake.sent.length, 1, "told exactly once");
});

test("a turn that takes the process down with it has still spent a try, and the last one is said out loud on restart", async () => {
  const { runtime, fake, turns } = harness();
  const t = dueTimer();
  // What three crashes mid-turn leave: every try claimed, none of them reported, nothing fired.
  for (let i = 0; i < 3; i++) assert.ok(db.claimTimerAttempt(t.id, { nextTryAt: clock.now() }));
  assert.equal(timer(t.id).attempts, 3);

  assert.equal(await runtime.tick(), 1);
  assert.equal(turns.length, 0, "no fourth turn");
  assert.match(fake.sent[0].text, /missed a reminder/);
  assert.ok(timer(t.id).gave_up_at);

  // And if THAT process stopped between the line and the mark, the line is not sent again.
  db.db.prepare("UPDATE timers SET fired_at = NULL, gave_up_at = NULL WHERE id = ?").run(t.id);
  assert.equal(await runtime.tick(), 1);
  assert.ok(timer(t.id).gave_up_at);
  assert.equal(fake.sent.length, 1, "the outbox already had it");
});

test("a failed try is on stderr when the server is listening, and harmless when nothing is", async () => {
  const quiet = harness({ turn: async () => { throw new Error(TIMEOUT); } });
  dueTimer();
  await assert.doesNotReject(quiet.runtime.tick(), "an unlistened 'error' event must not throw out of the sweep");

  db.db.exec("DELETE FROM timers");
  const { runtime } = harness({ turn: async () => { throw new Error(TIMEOUT); } });
  const errors = [];
  runtime.on("error", (e) => errors.push(e.message));
  const t = dueTimer();
  await runtime.tick();
  assert.deepEqual(errors, [`timer #${t.id}: ${TIMEOUT} (try 1 of 3, it stays due)`]);
});

test("a timer cancelled while it waits for another try is never tried again", async () => {
  const { runtime, fake, turns } = harness({ turn: async () => { throw new Error(TIMEOUT); } });
  const t = dueTimer();
  await runtime.tick();
  assert.equal(db.cancelTimer(CONV, t.id).ok, true, "still theirs to call off: it has not fired");
  clock.skip(10 * MIN);
  assert.equal(await runtime.tick(), 0);
  assert.equal(turns.length, 1);
  assert.equal(fake.sent.length, 0, "and no 'missed' line about something they cancelled");
});

test("a timer that is retrying still shows as pending, and one that fired late does not", async () => {
  const { runtime } = harness({ turn: async (_c, n) => { if (n === 1) throw new Error(TIMEOUT); return "ok"; } });
  const t = dueTimer();
  await runtime.tick();
  assert.deepEqual(db.listTimers(CONV).map(x => x.id), [t.id], "'what reminders do i have' still lists it");
  await runtime.tick();
  assert.deepEqual(db.listTimers(CONV), []);
});

// ---------- a catch Reason parked for itself ----------

test("a parked catch whose turn keeps failing goes back to being held, and nobody is told about a 'reminder'", async () => {
  const { runtime, fake, turns } = harness({ turn: async () => { throw new Error(TIMEOUT); } });
  const seen = db.recordNotice(CONV, { kind: "follow_on", key: "follow:1", what: "the flight is booked, the ride is not", momentAt: clock.now() + MIN });
  const t = db.createTimer(CONV, { fireAt: clock.now() + MIN, note: "say the parked catch" });
  db.scheduleNotice(seen.id, t.id, clock.now() + MIN);
  clock.skip(2 * MIN);

  await runtime.tick();
  await runtime.tick();
  clock.skip(config.timerRetryBackoffMs + 1000);
  assert.equal(await runtime.tick(), 1);

  assert.equal(turns.length, 3);
  assert.ok(timer(t.id).gave_up_at);
  assert.equal(fake.sent.length, 0, "nobody asked for it, so there is no reminder to apologise for");
  const row = db.noticeById(seen.id);
  assert.equal(row.timer_id, null, "it is off the dead timer");
  assert.ok(row.held_at, "and held, where a later reply can still pick it up");
  assert.equal(row.said_at, null);
});
