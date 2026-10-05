// The "…" bubble, without a model, a network or a twenty-second wait.
//
// A turn can take twenty seconds, and without a bubble somebody who texts Reason gets nothing at
// all until the whole answer lands — which reads as being ignored rather than being answered.
//
// Every test here is really one of three questions, because Sendblue calls this best-effort and it
// has several perfectly ordinary ways to fail:
//
//   does it go up before the turn and come down AFTER the reply?   (order is the whole point)
//   does it survive a turn longer than Sendblue's own expiry?      (renewed, in short chunks)
//   can it ever delay, break or swallow a reply?                   (no — not even when it throws)
//
// The timers are injected, so a five-minute turn is tested in a millisecond.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-typing-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not a burst test: the quiet window an arriving message waits in is off, so a webhook runs its
// turn the moment it lands. test/burst.test.js is where the window itself is proven.
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { TypingBubble, bubbleFor, canShowTyping } = await import("../src/typing.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM access_requests;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/**
 * Timers under the test's control, plus a clock that moves when they fire. `unrefs` records that
 * a booked timer was unreffed, because a bubble must never be the reason a process stays alive.
 */
function fakeTimers() {
  const booked = [];
  const t = {
    unrefs: 0,
    set: (fn, ms) => {
      const h = { fn, ms, cancelled: false, unref() { t.unrefs++; return h; } };
      booked.push(h);
      return h;
    },
    clear: (h) => { if (h) h.cancelled = true; },
    /** Fire the latest booked timer, as the event loop would once its delay had passed. */
    async fire() {
      const next = [...booked].reverse().find(h => !h.cancelled && !h.fired);
      if (!next) return false;
      next.fired = true;
      clock.skip(next.ms);
      await next.fn();
      return true;
    },
    booked,
  };
  return t;
}

/** A router whose turn is a function the test supplies, so a slow or broken turn is easy to make. */
function harness({ turn = async () => "sorted", channel = {} } = {}) {
  const logs = [];
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: turn });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel(channel));
  runtime.turnExtras.channels = router;
  // Outbound goes back out over the fake channel, so the trace shows the reply next to the bubble.
  runtime.on("outbound", async ({ to, text, chatId }) => { await fake.send({ to, text, chatId }); });
  return { runtime, router, fake, logs };
}

const inbound = (over = {}) => ({
  channel: "fake", externalId: `e-${Math.random()}`, from: OWNER, text: "dinner friday?",
  chatId: null, service: "iMessage", at: clock.now(), ...over,
});

// ---------- up before the turn, down after the reply ----------

test("the bubble goes up before the turn and comes down after the reply", async () => {
  const { router, fake } = harness();
  await router.deliver(inbound());

  assert.deepEqual(fake.trace, [
    { typing: "start" },
    { sent: "sorted" },
    { typing: "stop" },
  ], "stopping first would leave a gap with no bubble and no message");
});

test("the bubble asks for a chunk, not for as long as the turn might take", async () => {
  // Sendblue's own default is 60s and leaving it out does not mean "until you say stop". A short
  // chunk also means a process that dies mid-turn leaves a bubble that clears itself.
  const { router, fake } = harness();
  await router.deliver(inbound());
  assert.equal(fake.typingCalls[0].on, true);
  assert.equal(fake.typingCalls[0].maxDurationMs, config.typingChunkMs);
  assert.ok(config.typingChunkMs <= 60_000, "never longer than Sendblue's own default");
});

test("a turn that says nothing still takes the bubble down", async () => {
  const { router, fake } = harness({ turn: async () => null });
  await router.deliver(inbound());
  assert.deepEqual(fake.trace, [{ typing: "start" }, { typing: "stop" }]);
});

test("a turn that throws still takes the bubble down", async () => {
  const { router, fake } = harness({ turn: async () => { throw new Error("the model fell over"); } });
  await assert.rejects(() => router.deliver(inbound()), /the model fell over/);
  assert.deepEqual(fake.trace.at(-1), { typing: "stop" }, "a crashed turn must not leave somebody's phone saying Reason is typing");
});

// ---------- a turn longer than the bubble's own expiry ----------

test("a long turn renews the bubble before the chunk lapses", async () => {
  const timers = fakeTimers();
  const fake = new FakeChannel();
  const bubble = new TypingBubble({ channel: fake, to: OWNER, timers });

  await bubble.start();
  assert.equal(timers.booked.length, 1);
  assert.ok(timers.booked[0].ms < config.typingChunkMs, "renewal is booked BEFORE the chunk runs out, so there is no gap");
  assert.equal(timers.unrefs, 1, "never a reason for the process to stay alive");

  await timers.fire();
  await timers.fire();
  const starts = fake.typingCalls.filter(c => c.on);
  assert.equal(starts.length, 3, "one to show it, two to keep it there");
  assert.equal(bubble.renewals, 2);

  await bubble.stop();
  assert.equal(fake.typingCalls.at(-1).on, false);
  assert.ok(timers.booked.every(h => h.cancelled || h.fired), "nothing is still booked after a stop");
});

test("a turn that runs far too long stops claiming to be typing", async () => {
  const timers = fakeTimers();
  const logs = [];
  const fake = new FakeChannel();
  const bubble = new TypingBubble({ channel: fake, to: OWNER, timers, log: (e) => logs.push(e) });

  await bubble.start();
  // Renew past the ceiling. A turn still going after five minutes has something wrong with it, and
  // "still typing" about a turn that will never answer is a lie with a timer on it.
  for (let i = 0; i < 40 && await timers.fire(); i++) { /* keep firing until it refuses to book */ }

  const elapsed = clock.now() - bubble.startedAt;
  assert.ok(elapsed >= config.typingMaxMs, `gave up only after the ceiling (${elapsed}ms)`);
  assert.ok(logs.some(l => l.gave_up_after_ms), "and said so");
  assert.equal(timers.booked.filter(h => !h.fired && !h.cancelled).length, 0, "nothing left ticking");
});

// ---------- it can never cost anybody a reply ----------

test("a channel that cannot show a bubble is asked once, not once per renewal", async () => {
  const timers = fakeTimers();
  const fake = new FakeChannel({ typingAs: "unsupported" });
  const bubble = new TypingBubble({ channel: fake, to: OWNER, timers });

  await bubble.start();
  assert.equal(fake.typingCalls.length, 1);
  assert.equal(bubble.unsupported, true);
  assert.equal(timers.booked.length, 0, "nothing to renew");

  await bubble.stop();
  assert.equal(fake.typingCalls.length, 1, "and no pointless stop for a bubble that never went up");
});

test("a typing call that is refused is logged once and the reply still goes", async () => {
  const { router, fake, logs } = harness({ channel: { typingAs: "fails" } });
  await router.deliver(inbound());

  assert.equal(fake.sent.length, 1, "the answer arrived");
  assert.equal(fake.sent[0].text, "sorted");
  assert.equal(fake.typingCalls.filter(c => c.on).length, 1, "asked once; a thread with no route refuses every time");
  assert.ok(logs.some(l => l.could_not_show), "said once in the log");
});

test("a typing call that throws cannot break or delay the turn", async () => {
  const { router, fake, logs } = harness({ channel: { typingAs: "throws" } });
  // The whole point: this resolves normally and the reply is there.
  const out = await router.deliver(inbound());
  assert.equal(out.ok, true);
  assert.equal(out.replied, true);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].text, "sorted");
  assert.ok(logs.some(l => l.threw), "the failure is recorded rather than swallowed");
});

// ---------- iMessage only ----------

test("an SMS or RCS thread is never asked for a bubble", () => {
  // "Typing indicators are only supported for iMessage conversations, not SMS or RCS."
  assert.equal(canShowTyping("iMessage"), true);
  assert.equal(canShowTyping("imessage"), true);
  assert.equal(canShowTyping("SMS"), false);
  assert.equal(canShowTyping("RCS"), false);
  // Unknown is attempted: only Sendblue reports `service`, and a channel that reports nothing must
  // not be silently opted out — it says supported: false for itself.
  assert.equal(canShowTyping(null), true);
  assert.equal(canShowTyping(""), true);
});

test("an SMS thread skips the request entirely rather than collecting a refusal", async () => {
  const { router, fake } = harness();
  await router.deliver(inbound({ service: "SMS" }));
  assert.equal(fake.typingCalls.length, 0);
  assert.equal(fake.sent.length, 1, "the reply is unaffected");
});

test("a channel with no credentials is not asked, and neither is one with no typing at all", () => {
  const dead = bubbleFor({ channel: new FakeChannel({ live: false }), to: OWNER, service: "iMessage" });
  assert.equal(dead.skipped, true);

  const mute = bubbleFor({ channel: { status: () => ({ status: "live" }) }, to: OWNER, service: "iMessage" });
  assert.equal(mute.skipped, true);

  const none = bubbleFor({ channel: null, to: OWNER, service: "iMessage" });
  assert.equal(none.skipped, true);
});

test("a bubble that was never started is safe to stop, twice", async () => {
  const fake = new FakeChannel();
  const bubble = new TypingBubble({ channel: fake, to: OWNER, timers: fakeTimers() });
  await bubble.stop();
  await bubble.stop();
  assert.equal(fake.typingCalls.length, 0);
  // And a start after a stop does nothing, rather than raising a bubble nobody will take down.
  await bubble.start();
  assert.equal(fake.typingCalls.length, 0);
});
