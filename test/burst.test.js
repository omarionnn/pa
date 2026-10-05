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
  assert.equal(fresh.turns.length, 1);
  assert.equal(said(fresh.turns[0].text), "you around\nneed a favour", "in the order he sent them");
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

// ---------- what a burst costs, and whose turn it is ----------

test("a burst is one turn off the day's allowance, not one per text", async () => {
  const T = heldTimers();
  const { router } = harness({ timers: T.timers });
  const day = new Date(clock.now()).toISOString().slice(0, 10);

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
