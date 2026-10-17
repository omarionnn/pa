// Two texts sent seconds apart are one thought.
//
// The failure: Omari sent "Can you find me a good deal on this type of doc martens:" and pasted the
// link a second later. Reason answered the first half before the second half arrived — "which ones?
// looks like the rest of your message got cut off… if it was a pic, i can't open those" — and then
// had to answer the link separately.
//
// So an arriving message waits a short quiet window to see whether more of the thought is coming,
// every new message from the same person restarts that window, a hard cap stops somebody who types
// continuously from never being answered, and everything that landed runs as ONE turn.
//
// The window is real seconds in production. Here the router's timers are the test's, and the clock
// moves when they fire, so eight seconds of somebody typing costs no wall-clock at all. The one
// test that uses REAL time is the one whose whole claim is about real time: that a lone message is
// not held longer than the window.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-burst-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
// The day a turn is counted against is the operator's (accounts.today), not UTC's. Between 8pm
// and midnight in New York those are different dates, and a test that asked the usage table for
// the UTC date found nothing there every evening.
const { today } = await import("../src/accounts.js");

// A test that owns the router's timers owns the clock too: while its timers are held, the clock
// moves ONLY when the test moves it. The real one (src/config.js) is Date.now() plus whatever has
// been skipped, so every real millisecond spent between two readings — the database, the flushes,
// another suite hogging the machine — would land in a difference that is supposed to be exactly a
// quiet window: a run alongside another suite once measured 5552ms for 5500. A test on the real
// timers keeps the real clock, because a request sleeping on a real timer only wakes up for good
// once the clock has actually reached its ready time. Each test starts on the real clock
// (`clock.reset()` in beforeEach) and `heldTimers()` is what stops it.
let frozenAt = null;
let skippedMs = 0;
clock.now = () => (frozenAt ?? Date.now()) + skippedMs;
clock.skip = (ms) => { skippedMs += ms; };
clock.reset = () => { frozenAt = null; skippedMs = 0; };

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const LINK = "https://www.drmartens.com/us/en/p/1460-smooth-leather-lace-up-boots";

const QUIET = 2_500;
const CAP = 8_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM access_requests;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.burstQuietMs = QUIET;
  config.burstMaxMs = CAP;
});

/** Let every already-resolved promise run, so a sleeping request reaches its sleep. */
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

/**
 * A virtual event loop: timers the test owns, fired when the clock reaches the time they were
 * booked for rather than whenever the test feels like it.
 *
 * Honouring the booked time is the whole point. A request that is asleep for 2.5 seconds has to
 * wake up 2.5 seconds later even if the test has meanwhile pushed the clock on by twelve — that is
 * exactly the case the hard cap exists for, and a timer that only fires when asked would make the
 * cap look as though it worked while proving nothing.
 *
 *   advance(ms)  move the clock on by ms, waking whatever comes due on the way, in order.
 *   settle()     keep going until nothing is asleep.
 */
function heldTimers() {
  frozenAt = Date.now();
  const booked = [];
  const timers = {
    set: (fn, ms) => {
      const h = { fn, at: clock.now() + Math.max(0, ms), fired: false };
      booked.push(h);
      return h;
    },
    clear: (h) => { if (h) h.fired = true; },
  };
  const pending = () => booked.filter(h => !h.fired);

  async function fireDue() {
    // A woken request often sleeps again straight away (the window moved), so this goes round
    // until nothing more is due at the current instant.
    for (let i = 0; i < 20; i++) {
      const due = pending().filter(h => h.at <= clock.now());
      if (!due.length) return;
      for (const h of due) { h.fired = true; h.fn(); }
      await flush();
    }
  }

  return {
    timers,
    booked,
    async advance(ms) {
      const target = clock.now() + ms;
      for (let i = 0; i < 200 && clock.now() < target; i++) {
        const next = pending().map(h => h.at).filter(at => at > clock.now() && at <= target).sort((a, b) => a - b)[0];
        clock.skip((next ?? target) - clock.now());
        await fireDue();
      }
      await fireDue();
    },
    async settle() {
      for (let i = 0; i < 20; i++) {
        const next = pending().map(h => h.at).sort((a, b) => a - b)[0];
        if (next === undefined) { await flush(); return; }
        clock.skip(Math.max(0, next - clock.now()));
        await fireDue();
      }
    },
  };
}

// A burst on a thread that can carry inline replies starts with a line saying how many texts it
// was (replies.burstLine). These tests are about what they SAID, so that line is taken off.
const said = (t) => String(t).replace(/^\[they sent the following as \d+ separate texts[^\n]*\]\n/, "");

/** A router whose turns are recorded instead of being sent to a model. */
function harness({ timers = undefined, turn = null } = {}) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: turn ?? (async ({ conversationId, text, kind }) => { turns.push({ conversationId, text, kind, at: clock.now() }); return "ok"; }),
  });
  const router = new Router({ runtime, log: (e) => logs.push(e), ...(timers ? { timers } : {}) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ to, text, chatId }) => { await fake.send({ to, text, chatId }); });
  return { runtime, router, fake, turns, logs };
}

let n = 0;
const inbound = (over = {}) => ({
  channel: "fake", externalId: `e-${++n}`, from: OWNER, text: "hey",
  chatId: null, service: "iMessage", at: clock.now(), ...over,
});

// ---------- the 1:35 AM failure ----------

test("a line of text and the link pasted a second later are ONE turn, in order", async () => {
  const T = heldTimers();
  const { router, turns } = harness({ timers: T.timers });

  // His words. The request does not answer yet — it is waiting for the rest of the thought.
  const first = router.deliver(inbound({ text: "Can you find me a good deal on this type of doc martens:" }));
  await flush();
  assert.equal(turns.length, 0, "nothing is answered while he is still typing");
  assert.equal(db.countPendingInbound("dm:owner"), 1);

  // A second later, the link.
  clock.skip(1_000);
  const second = await router.deliver(inbound({ text: LINK }));
  assert.equal(second.joined, true, "the second text joined the first one's turn");
  assert.equal(second.held, 2);
  assert.equal(turns.length, 0, "and still nothing is answered");

  await T.settle();
  const r = await first;

  assert.equal(turns.length, 1, "one thought, one turn");
  assert.equal(r.messages, 2);
  assert.equal(r.replied, true);
  assert.equal(said(turns[0].text), `Can you find me a good deal on this type of doc martens:\n${LINK}`);
  assert.equal(db.countPendingInbound("dm:owner"), 0, "and nothing is left holding");
});

test("the window restarts on each new text, so a long burst is still one turn", async () => {
  const T = heldTimers();
  const { router, turns } = harness({ timers: T.timers });

  const t0 = clock.now();
  const first = router.deliver(inbound({ text: "wait" }));
  await flush();
  // Three more, a second apart — inside the 2.5s quiet window every time, and the last of them
  // still well inside the 8s cap, so what moves the answer is the window and not the ceiling. Real
  // time passes: the sleeping request genuinely wakes, sees the window moved, and sleeps on.
  for (const text of ["no", "actually", "the black ones"]) {
    await T.advance(1_000);
    await router.deliver(inbound({ text }));
    await flush();
    assert.equal(turns.length, 0, `answered too early, at "${text}"`);
  }

  await T.settle();
  await first;
  assert.equal(turns.length, 1);
  assert.equal(said(turns[0].text), "wait\nno\nactually\nthe black ones");
  // 3s is when the last text landed, so the answer comes a quiet window after THAT — 5.5s in, not
  // 2.5s in, and not the 8s ceiling either.
  const ran = turns[0].at - t0;
  assert.ok(Math.abs(ran - (3_000 + QUIET)) <= 50, `the turn ran ${ran}ms in, not a quiet window after the last text`);
  assert.ok(ran < CAP, "and the ceiling was never what decided it");
});

test("the hard cap answers somebody who never stops typing", async () => {
  const T = heldTimers();
  const { router, turns } = harness({ timers: T.timers });

  const t0 = clock.now();
  const first = router.deliver(inbound({ text: "one" }));
  await flush();
  // A text a second for twelve seconds. Every one of them is inside the quiet window, so without
  // the cap the answer would be pushed back forever.
  for (let i = 2; i <= 12; i++) {
    await T.advance(1_000);
    if (turns.length) break;
    await router.deliver(inbound({ text: `m${i}` }));
    await flush();
  }
  await T.settle();
  await first;

  assert.equal(turns.length, 1, "it answered rather than waiting for silence that never came");
  const waited = turns[0].at - t0;
  assert.ok(Math.abs(waited - CAP) <= 50, `the turn ran ${waited}ms after the first text; the cap says ${CAP}ms`);
  assert.match(said(turns[0].text), /^one\nm2\nm3/, "with everything that had landed, in order");
});

test("a lone message is not held longer than the window — in real seconds", async () => {
  // The only test here that spends wall-clock, because the claim is about wall-clock. A 40ms
  // window stands in for the 2.5s one; what is being proved is that the wait is the window and not
  // the sweep interval.
  config.burstQuietMs = 40;
  const { router, turns } = harness();
  const started = Date.now();

  const r = await router.deliver(inbound({ text: "u up" }));
  const took = Date.now() - started;

  assert.equal(turns.length, 1, "it answered on its own, with no sweep");
  assert.equal(r.messages, 1);
  assert.ok(took >= 30, `answered in ${took}ms, which is before the window`);
  assert.ok(took < 2_000, `a lone message waited ${took}ms for a ${config.burstQuietMs}ms window`);
});

test("a quiet window of 0 answers the moment the message lands", async () => {
  config.burstQuietMs = 0;
  const { router, turns } = harness();
  const r = await router.deliver(inbound({ text: "now" }));
  assert.equal(turns.length, 1);
  assert.equal(r.messages, 1);
  assert.equal(r.joined, undefined);
});

// ---------- a process that dies inside the window ----------

test("messages held when the process stopped are rows, and the next sweep answers them", async () => {
  const T = heldTimers();
  const dying = harness({ timers: T.timers });
  void dying.router.deliver(inbound({ text: "you around" }));
  await flush();
  clock.skip(1_000);
  void dying.router.deliver(inbound({ text: "need a favour" }));
  await flush();
  assert.equal(dying.turns.length, 0);
  assert.equal(db.countPendingInbound("dm:owner"), 2, "both are on disk, not in a list in memory");

  // The process stops. Nothing of that router is used again: a new one, as `npm run serve` would
  // build on restart, and the ordinary sweep.
  clock.skip(QUIET);
  const fresh = harness();
  const swept = await fresh.runtime.sweep();

  assert.equal(swept.held.turns, 1, "one turn, for both texts");
  // The held messages' turn, not every turn the sweep ran: a full sweep is entitled to run turns of
  // its own (the stale-receipts pass does, on a fresh database), and this test's claim is about the
  // held messages rather than about the sweep being otherwise silent.
  const answered = fresh.turns.filter(t => t.kind === "user");
  assert.equal(answered.length, 1);
  assert.equal(said(answered[0].text), "you around\nneed a favour", "in the order he sent them");
  assert.equal(db.countPendingInbound("dm:owner"), 0);
});

test("the sweep leaves alone a conversation somebody is already waiting on", async () => {
  const T = heldTimers();
  const { router, runtime, turns } = harness({ timers: T.timers });
  const first = router.deliver(inbound({ text: "hang on" }));
  await flush();
  clock.skip(QUIET + 1);

  // The window has elapsed, so the sweep would see this as due — but the request that took the
  // message is still the one that owns it, and two drains would be two turns.
  const swept = await runtime.sweep();
  assert.equal(swept.held.turns, 0);
  assert.equal(swept.held.conversations, 0);

  await T.settle();
  await first;
  assert.equal(turns.length, 1, "exactly one turn, from the request that was waiting");
});

test("two overlapping drains produce one turn, because taking the messages is the lock", async () => {
  const { router, turns } = harness();
  config.burstQuietMs = QUIET;
  await db.holdInbound({
    conversationId: "dm:owner", channel: "fake", address: OWNER, externalId: "e-x",
    text: "both at once", quietMs: 0, maxMs: CAP,
  });
  const [a, b] = await Promise.all([router.drain("dm:owner"), router.drain("dm:owner")]);
  assert.equal(turns.length, 1);
  assert.equal([a, b].filter(Boolean).length, 1, "the other one found nothing held and did nothing");
});

// ---------- a text that lands while the answer is still being written ----------
//
// The failure, 2026-10-05: "So you checked at 8?" at 11:02:46 and "How are you" at 11:02:56, while
// the first was still being answered. The first answer went out at 11:02:56 and the second not
// until 11:03:15 — the second text had "joined" a wait whose drain had already taken its rows, so
// it sat in the table until the 15-second sweep came round.

/**
 * A harness whose first turn does not finish until the test says so, which is what lets a text
 * land mid-turn. Later turns answer at once, unless `failAfterFirst` makes them throw.
 */
function slowFirstTurn({ timers, failAfterFirst = false } = {}) {
  const turns = [];
  let release;
  const h = harness({
    timers,
    turn: async ({ conversationId, text }) => {
      turns.push({ conversationId, text, at: clock.now() });
      if (turns.length === 1) await new Promise(r => { release = r; });
      else if (failAfterFirst) throw new Error("the model fell over");
      return `re: ${said(text)}`;
    },
  });
  // Nothing in these tests is allowed to lean on the sweep: it is what was too slow.
  const sweeps = [];
  const drainDue = h.router.drainDue.bind(h.router);
  h.router.drainDue = async (...a) => { const r = await drainDue(...a); sweeps.push(r); return r; };
  return { ...h, turns, sweeps, finishFirstTurn: () => release() };
}

test("a text that lands mid-turn gets its own turn the moment that one ends, with no sweep", async () => {
  const T = heldTimers();
  const h = slowFirstTurn({ timers: T.timers });

  const first = h.router.deliver(inbound({ text: "So you checked at 8?" }));
  await flush();
  await T.advance(QUIET);
  assert.equal(h.turns.length, 1, "the first text's turn is running");

  // Ten seconds in, still being answered, they text again.
  clock.skip(7_500);
  const second = await h.router.deliver(inbound({ text: "How are you" }));
  assert.equal(second.joined, true);
  assert.equal(db.countPendingInbound("dm:owner"), 1, "held as a row, not part of the running turn");
  assert.equal(h.turns.length, 1);

  // The first answer lands ten seconds after that. Its quiet window is long past.
  clock.skip(10_000);
  const landedAt = clock.now();
  h.finishFirstTurn();
  const r = await first;

  assert.equal(r.messages, 1, "the request reports its own turn");
  assert.equal(h.turns.length, 2, "and the second text has already had its turn");
  assert.equal(said(h.turns[1].text), "How are you");
  assert.equal(h.turns[1].at, landedAt, "it ran the moment the first answer landed, with no sweep interval in between");
  assert.deepEqual(h.fake.sent.map(m => m.text), ["re: So you checked at 8?", "re: How are you"]);
  assert.equal(db.countPendingInbound("dm:owner"), 0);
  assert.equal(h.router.waiting.has("dm:owner"), false, "and nobody is left waiting on the conversation");
  assert.deepEqual(h.sweeps, [], "the sweep never ran");
  assert.ok(h.logs.some(l => l.drained_again === "dm:owner"), "and the log says why there were two turns");
});

test("a text that lands just before the answer still gets its quiet window, and its bubble", async () => {
  const T = heldTimers();
  const h = slowFirstTurn({ timers: T.timers });

  const first = h.router.deliver(inbound({ text: "what time is the movie" }));
  await flush();
  await T.advance(QUIET);
  clock.skip(5_000);
  await h.router.deliver(inbound({ text: "also" }));

  // The answer lands a second later: 1.5s of the new text's window is still to run.
  clock.skip(1_000);
  h.finishFirstTurn();
  await flush();
  assert.equal(h.fake.sent.length, 1, "the first answer has gone");
  assert.equal(h.turns.length, 1, "and the new text is not answered yet — they may still be typing");
  assert.deepEqual(h.fake.typingCalls.map(c => c.on), [true, false, true], "the bubble came down with the reply and is back up for the wait");

  // They were: the rest of the thought arrives a second on, and restarts the window.
  await T.advance(1_000);
  const restAt = clock.now();
  const rest = await h.router.deliver(inbound({ text: "is kofi coming" }));
  assert.equal(rest.joined, true);
  assert.equal(rest.held, 2);
  await T.advance(1_000);
  assert.equal(h.turns.length, 1, "past the first window, but the window moved");

  await T.settle();
  await first;
  assert.equal(h.turns.length, 2, "one more turn, for both");
  assert.equal(said(h.turns[1].text), "also\nis kofi coming");
  const waited = h.turns[1].at - restAt;
  assert.ok(Math.abs(waited - QUIET) <= 50, `the turn ran ${waited}ms after the last of them; the window is ${QUIET}ms`);
  assert.deepEqual(h.fake.typingCalls.map(c => c.on), [true, false, true, false], "one bubble for that wait and its turn");
  assert.equal(h.fake.sent.length, 2);
  assert.deepEqual(h.sweeps, []);
});

test("the hard cap still answers somebody who keeps typing after a mid-turn text", async () => {
  const T = heldTimers();
  const h = slowFirstTurn({ timers: T.timers });

  const first = h.router.deliver(inbound({ text: "one" }));
  await flush();
  await T.advance(QUIET);
  const t0 = clock.now();
  await h.router.deliver(inbound({ text: "two" }));
  h.finishFirstTurn();
  await flush();
  // A text a second from here on, every one inside the quiet window.
  for (let i = 3; i <= 14 && h.turns.length < 2; i++) {
    await T.advance(1_000);
    if (h.turns.length < 2) await h.router.deliver(inbound({ text: `m${i}` }));
  }
  await T.settle();
  await first;

  const waited = h.turns[1].at - t0;
  assert.ok(Math.abs(waited - CAP) <= 50, `the turn ran ${waited}ms after the first held text; the cap says ${CAP}ms`);
  assert.match(said(h.turns[1].text), /^two\nm3\nm4/);
});

test("a text that lands mid-turn is answered once, whatever the sweep does meanwhile", async () => {
  const T = heldTimers();
  const h = slowFirstTurn({ timers: T.timers });
  const day = today();

  const first = h.router.deliver(inbound({ text: "you there" }));
  await flush();
  await T.advance(QUIET);
  await h.router.deliver(inbound({ text: "hello??" }));
  clock.skip(20_000);

  // Due, and the sweep comes round while the first turn is still running. It is the waiting
  // request's to run, so the sweep must leave it: taking it here would be a second turn at once.
  const during = await h.runtime.sweep();
  assert.equal(during.held.turns, 0);
  assert.equal(db.countPendingInbound("dm:owner"), 1);

  h.finishFirstTurn();
  await first;
  const afterwards = await h.runtime.sweep();
  assert.equal(afterwards.held.turns, 0, "nothing left for the sweep to find");
  await T.settle();

  assert.deepEqual(h.turns.map(t => said(t.text)), ["you there", "hello??"], "each text in exactly one turn");
  assert.equal(h.fake.sent.length, 2, "and two answers, not three");
  assert.equal(db.usageToday("dm:owner", day)?.turns, 2);
});

test("a mid-turn text whose own turn fails does not take the first answer or the conversation with it", async () => {
  const T = heldTimers();
  const h = slowFirstTurn({ timers: T.timers, failAfterFirst: true });

  const first = h.router.deliver(inbound({ text: "first" }));
  await flush();
  await T.advance(QUIET);
  await h.router.deliver(inbound({ text: "second" }));
  clock.skip(5_000);
  h.finishFirstTurn();
  const r = await first;

  assert.equal(r.replied, true, "the request still reports the turn that worked");
  assert.equal(h.fake.sent[0].text, "re: first");
  assert.equal(h.turns.length, 2, "the second turn was tried, once");
  assert.equal(h.router.waiting.has("dm:owner"), false, "and the conversation is not stuck behind it");
});

// ---------- what a burst costs, and whose turn it is ----------

test("a burst is one turn off the day's allowance, not one per text", async () => {
  const T = heldTimers();
  const { router } = harness({ timers: T.timers });
  const day = today();

  const first = router.deliver(inbound({ text: "hey" }));
  await flush();
  clock.skip(500);
  await router.deliver(inbound({ text: "u free tmrw" }));
  await T.settle();
  await first;

  assert.equal(db.usageToday("dm:owner", day)?.turns, 1, "three texts in one breath is one answer");
});

test("two people texting at once are two bursts, not one", async () => {
  const T = heldTimers();
  const { router, turns } = harness({ timers: T.timers });
  db.upsertAccount({ conversationId: `dm:fake:${FRIEND}`, channel: "fake", address: FRIEND, name: "", isOperator: false });

  const mine = router.deliver(inbound({ text: "mine one" }));
  const theirs = router.deliver(inbound({ from: FRIEND, text: "theirs one" }));
  await flush();
  clock.skip(500);
  await router.deliver(inbound({ text: "mine two" }));
  await T.settle();
  await Promise.all([mine, theirs]);

  assert.equal(turns.length, 2);
  const byId = Object.fromEntries(turns.map(t => [t.conversationId, t.text]));
  assert.equal(said(byId["dm:owner"]), "mine one\nmine two");
  assert.equal(byId[`dm:fake:${FRIEND}`], "theirs one");
});

// ---------- the bubble, while they are still typing ----------

test("the '…' bubble is up during the wait, not only during the turn", async () => {
  const T = heldTimers();
  const { router, fake } = harness({ timers: T.timers });

  const first = router.deliver(inbound({ text: "ok so" }));
  await flush();
  assert.deepEqual(fake.typingCalls.map(c => c.on), [true], "it shows before anything is answered");
  assert.equal(fake.sent.length, 0, "and nothing has been sent yet");

  clock.skip(800);
  await router.deliver(inbound({ text: "about friday" }));
  await flush();
  assert.equal(fake.typingCalls.filter(c => c.on).length, 1, "one bubble for the whole burst, not one per text");

  await T.settle();
  await first;

  // And it comes down only at the end, after the reply has actually gone.
  assert.equal(fake.typingCalls.at(-1).on, false);
  assert.equal(fake.sent.length, 1, "one reply for the whole burst");
});

test("a channel that cannot show a bubble still answers the burst", async () => {
  const T = heldTimers();
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ text }) => { turns.push(text); return "ok"; } });
  const router = new Router({ runtime, timers: T.timers });
  // An SMS thread: the typing endpoint is iMessage-only, so no bubble is even attempted.
  const fake = router.register(new FakeChannel({ typingAs: { ok: false, supported: false } }));
  runtime.turnExtras.channels = router;

  const first = router.deliver(inbound({ text: "sms one", service: "SMS" }));
  await flush();
  clock.skip(500);
  await router.deliver(inbound({ text: "sms two", service: "SMS" }));
  await T.settle();
  await first;

  assert.equal(turns.length, 1);
  assert.equal(turns[0], "sms one\nsms two");
  assert.deepEqual(fake.typingCalls, [], "nothing was asked of a channel that cannot do it");
});

// ---------- the guards that were already there still hold ----------

test("a delivery the provider sent twice is still one message in the burst", async () => {
  const T = heldTimers();
  const { router, turns } = harness({ timers: T.timers });
  const one = inbound({ text: "same text" });

  const first = router.deliver(one);
  await flush();
  const retry = await router.deliver(one);
  assert.equal(retry.duplicate, true);

  await T.settle();
  await first;
  assert.equal(turns.length, 1);
  assert.equal(said(turns[0].text), "same text", "not twice");
});

test("a dropped link preview never joins a burst", async () => {
  const T = heldTimers();
  const { router, turns } = harness({ timers: T.timers });

  const first = router.deliver(inbound({
    text: `these ${LINK}`, said: `these ${LINK}`,
    externalId: "STEM", baseHandle: "STEM", partIndex: 0, attachments: [],
  }));
  await flush();
  clock.skip(1_000);
  const preview = await router.deliver(inbound({
    text: "", said: "", externalId: "STEM_1", baseHandle: "STEM", partIndex: 1,
    attachments: [{ url: "https://cdn/x/preview.jpg", filename: "preview.jpg", kind: "image" }],
  }));

  assert.match(preview.dropped, /link preview/);
  assert.equal(db.countPendingInbound("dm:owner"), 1, "the preview was never held at all");

  await T.settle();
  await first;
  assert.equal(turns.length, 1);
  assert.equal(said(turns[0].text), `these ${LINK}`);
});

test("/health can say what is waiting and whether it is due", async () => {
  const T = heldTimers();
  const { router } = harness({ timers: T.timers });
  void router.deliver(inbound({ text: "waiting" }));
  await flush();

  const [row] = db.pendingInboundSummary();
  assert.equal(row.conversation_id, "dm:owner");
  assert.equal(row.messages, 1);
  assert.equal(row.due, false, "not yet — the window has not elapsed");
  assert.equal(row.deadline_at - row.ready_at, CAP - QUIET);

  clock.skip(QUIET);
  assert.equal(db.pendingInboundSummary()[0].due, true);
  await T.settle();
});
