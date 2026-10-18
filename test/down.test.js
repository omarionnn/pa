// A text that lands while the model is down is kept, not dropped.
//
// The failure (2026-10-17): the Claude CLI hit the subscription's session limit at 11:27am and
// stayed there until 3:10pm. "Play music for me" and "What do you think about past.dev" each got
// "ugh — that one broke on my end … say it again?", and were gone. When the limit reset, Reason
// had nothing to answer; Omari had to repeat himself hours later.
//
// So: the texts go back into the holding table for the reset the error names, he is told ONCE
// that Reason is down and when it is back, and the sweep runs the turn at the reset. The reply
// reads how long the texts waited and is pinned under the text it answers.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-down-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime, stallLine } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { readOutage, resetTime, downLine, RETRY_UNKNOWN_MS, MAX_REHOLDS } = await import("../src/down.js");

// The morning it happened, on a clock the test owns.
const T0 = Date.UTC(2026, 9, 17, 15, 27);       // 11:27am New York
const RESET = Date.UTC(2026, 9, 17, 19, 10);    // "resets 7:10pm (UTC)" = 3:10pm New York
const LIMIT = "the CLI reported an error: You've hit your session limit · resets 7:10pm (UTC)";

let at = T0;
clock.now = () => at;

const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  at = T0;
  db.db.exec("DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM access_requests; DELETE FROM requests; DELETE FROM event_log; DELETE FROM extraction_queue; DELETE FROM outbox;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  // No burst window: what is being proved is the wait for the model, not the wait for a thought.
  config.burstQuietMs = 0;
  config.burstMaxMs = 0;
});

/** A router whose model is down until the test says otherwise. */
function harness() {
  const turns = [];
  const logs = [];
  const state = { down: true };
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async ({ conversationId, text, kind }) => {
      if (state.down) throw new Error(LIMIT);
      turns.push({ conversationId, text, kind, at: clock.now() });
      return "back now. on music: nothing's playing. on past.dev: worth a test.";
    },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ to, text, chatId, replyTo }) => { await fake.send({ to, text, chatId, replyTo }); });
  return { runtime, router, fake, turns, logs, state };
}

let n = 0;
const inbound = (over = {}) => ({
  channel: "fake", externalId: `e-${++n}`, from: OWNER, text: "hey",
  chatId: null, service: "iMessage", at: clock.now(), ...over,
});

const pending = () => db.db.prepare("SELECT * FROM pending_inbound WHERE conversation_id = 'dm:owner' ORDER BY arrived_at, id").all();

// ---------- reading the error ----------

test("the CLI's session-limit error is an outage with the reset it names", () => {
  const o = readOutage(new Error(LIMIT), { now: T0 });
  assert.ok(o, "it is an outage");
  assert.equal(o.known, true);
  assert.equal(o.resetAt, RESET);
  assert.equal(o.until, RESET + 60_000, "a minute past the reset, so the first try is not early");
  assert.equal(o.why, LIMIT);
});

test("a bare time already past today is tomorrow's", () => {
  assert.equal(resetTime("You've hit your session limit · resets 7:10pm (UTC)", RESET + 10 * 60_000), RESET + 24 * 3_600_000);
});

test("a dated reset, in a named zone", () => {
  assert.equal(resetTime("You've hit your weekly limit · resets Oct 20 at 9am (America/New_York)", T0), Date.UTC(2026, 9, 20, 13, 0));
});

test("an outage that names no reset is tried again in a quarter hour; an ordinary error is not an outage", () => {
  const o = readOutage(new Error("You've hit your usage limit."), { now: T0 });
  assert.equal(o.known, false);
  assert.equal(o.until, T0 + RETRY_UNKNOWN_MS);
  assert.equal(readOutage(new Error("TypeError: Cannot read properties of undefined (reading 'id')")), null);
  assert.equal(readOutage(new Error("the CLI reported an error: no detail")), null);
});

test("the line says when Reason is back, in their time, and only when that is known", () => {
  assert.equal(downLine({ until: RESET + 60_000, resetAt: RESET, known: true }),
    "heads up — my brain's offline for a bit (should be back around 3:10pm). i've got your message, and i'll answer it as soon as i'm back.");
  assert.equal(downLine({ until: T0 + RETRY_UNKNOWN_MS, known: false }),
    "heads up — my brain's offline for a bit. i've got your message, and i'll answer it as soon as i'm back.");
});

// ---------- the morning of 2026-10-17 ----------

test("a text that lands while the model is down is kept for the reset, and he is told once — not stalled", async () => {
  const { router, fake, turns } = harness();

  const r = await router.deliver(inbound({ text: "Play music for me" }));
  assert.equal(r.down, true);
  assert.equal(r.replied, false);
  assert.equal(turns.length, 0, "the model was down: no turn ran");

  // One line, code's, saying when. Not the stall line — nothing broke, and his text is not lost.
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].text, /offline for a bit \(should be back around 3:10pm\)/);
  assert.doesNotMatch(fake.sent[0].text, /broke on my end/);

  // His text is back in the table, waiting for the reset — not for a burst window.
  const rows = pending();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "Play music for me");
  assert.equal(rows[0].ready_at, RESET + 60_000);
  assert.equal(rows[0].held_times, 1);
  assert.equal(rows[0].down_since, T0);

  // What the failed round wrote for the turn it never ran is gone, so the retry writes it once.
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE conversation_id = 'dm:owner'").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE conversation_id = 'dm:owner' AND role = 'user'").get().n, 0);
  // And the turn he never got is not counted against his day.
  assert.equal(db.db.prepare("SELECT COALESCE(SUM(turns), 0) AS n FROM usage WHERE conversation_id = 'dm:owner'").get().n, 0);
});

test("a second text during the outage joins the wait: no turn, no second line, nothing pulled forward", async () => {
  const { router, fake, turns } = harness();
  await router.deliver(inbound({ text: "Play music for me" }));
  assert.equal(fake.sent.length, 1);

  at = T0 + 17 * 60_000;
  const r = await router.deliver(inbound({ text: "What do you think about past.dev for reason?" }));
  assert.equal(r.down, true);
  assert.equal(r.joined, true);
  assert.equal(turns.length, 0);
  assert.equal(fake.sent.length, 1, "told once per outage, however many texts land in it");

  const rows = pending();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(x => x.ready_at === RESET + 60_000), "both wait for the reset");
});

test("when the model is back, the sweep answers everything that waited in one turn, owning the gap, pinned under the text", async () => {
  const { router, fake, turns, state } = harness();
  const first = inbound({ text: "Play music for me" });
  await router.deliver(first);
  at = T0 + 17 * 60_000;
  const second = inbound({ text: "What do you think about past.dev for reason?" });
  await router.deliver(second);

  // Not yet: the sweep before the reset finds nothing due.
  at = RESET - 60_000;
  assert.deepEqual(await router.drainDue(), { conversations: 0, turns: 0 });
  assert.equal(turns.length, 0);

  // The reset. The model is back; the sweep runs the turn.
  state.down = false;
  at = RESET + 2 * 60_000;
  const swept = await router.drainDue();
  assert.equal(swept.turns, 1);
  assert.equal(turns.length, 1, "one turn for everything that waited");
  assert.match(turns[0].text, /^\[reason was down from 11:27am until 3:12pm and could not answer\. these texts were left during that time/);
  assert.match(turns[0].text, /Play music for me\nWhat do you think about past\.dev for reason\?$/);
  assert.equal(pending().length, 0, "nothing is left holding");

  // The reply is pinned under what it answers, hours later: the last text that waited.
  const reply = fake.sent[fake.sent.length - 1];
  assert.match(reply.text, /back now/);
  assert.equal(reply.reply_to, second.externalId);
  // Exactly two things went out all morning: the one line when it went down, and the answer.
  assert.equal(fake.sent.length, 2);
});

test("a text that is still failing after the reset is re-held again, and told nothing new", async () => {
  const { router, fake, turns } = harness();
  await router.deliver(inbound({ text: "Play music for me" }));
  at = RESET + 2 * 60_000;
  // Still down (a weekly limit, say — the error still names 7:10pm, which is now tomorrow's).
  const swept = await router.drainDue();
  assert.equal(swept.turns, 0);
  assert.equal(turns.length, 0);
  const rows = pending();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].held_times, 2);
  assert.equal(rows[0].ready_at, RESET + 24 * 3_600_000 + 60_000, "the next 7:10pm");
  assert.equal(rows[0].down_since, T0, "the outage's start is kept, not reset");
  assert.equal(fake.sent.length, 1, "the same outage, the same one line");
});

test("past the re-hold ceiling the stall line goes out after all, so no text waits forever", async () => {
  const { router, fake, turns } = harness();
  await router.deliver(inbound({ text: "Play music for me" }));
  db.db.prepare("UPDATE pending_inbound SET held_times = ?, ready_at = ? WHERE conversation_id = 'dm:owner'").run(MAX_REHOLDS, clock.now());
  await router.drainDue();
  assert.equal(turns.length, 0);
  assert.equal(pending().length, 0, "not held again");
  assert.equal(fake.sent[fake.sent.length - 1].text, stallLine({ sentAny: false }));
});
