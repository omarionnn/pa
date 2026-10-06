// The guards around tapbacks and screen effects: the parts that are code's job rather than the
// model's. No model and no network — what the model decides is proved in test/flow-tapbacks.test.js.
//
// Four questions, and each one is a way this feature could be worse than not having it:
//
//   can a tapback be the whole answer to a question?   (no — it is held, and only rides out with words)
//   does a held tapback outlive its turn?              (no — taken whether or not words went)
//   can a restart hand out a second effect in an hour? (no — the limit is counted off the outbox)
//   is any of it claimable without a record?           (no — reaction and effect both get a receipt)
//
// The last one matters because a tapback leaves no bubble behind: "you never answered me" has no
// answer but the ledger.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-tapbacks-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { effectAllowed, EFFECT_EVERY_MS } = await import("../src/expressive.js");
const outbox = await import("../src/outbox.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const CONV = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM action_ledger; DELETE FROM usage; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A thread as it looks after one inbound message has arrived on it. */
function thread({ service = "iMessage", lastInboundId = "H-last" } = {}) {
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service, lastInboundId });
}

/**
 * A real runtime whose turn is one scripted model: `turn` is handed the tools and returns what
 * Reason said, or null for silence. That is enough to prove the held tapback, which depends on
 * what the turn did AND on whether anything went out afterwards.
 */
function harness({ turn = async () => null, channelOpts = {} } = {}) {
  const runtime = new Runtime({ runTurn: async (ctx) => await turn(ctx) });
  const router = new Router({ runtime });
  const fake = router.register(new FakeChannel({ number: LINE, ...channelOpts }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, sendStyle }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, sendStyle });
  });
  return { runtime, router, fake };
}

const react = (input, router) => runTool("react", input, { conversationId: CONV, channels: router });
const send = (input, router) => runTool("message_send", input, { conversationId: CONV, channels: router });

// ---------- a tapback is never the whole answer to a question ----------

test("they asked something: the tapback is held, nothing is put on their message, and the model is sent to write words", async () => {
  thread();
  const { router, fake } = harness();
  const out = await react({ reaction: "love", they_asked: true }, router);

  assert.equal(out.ok, false, "it did not go out");
  assert.equal(out.held, true);
  assert.equal(out.blocked, "they_asked_something");
  assert.equal(fake.reactCalls.length, 0, "the channel was never asked");
  assert.match(out.error, /answer them in words/i);
  assert.equal(db.getThread(CONV).held_reaction, "love", "parked on the row, not in memory");
});

test("the held tapback goes out with the reply — words win and the tapback rides along", async () => {
  thread();
  const { runtime, fake, router } = harness({
    turn: async () => {
      await react({ reaction: "love", they_asked: true }, router);
      return "yeah they've got 8pm, want me to take it?";
    },
  });
  try {
    await runtime.inbound(CONV, "can u check if they have 8pm", { channel: "fake", to: OWNER, fromOwner: true });
    await outbox.pass({ router, log: () => {} });
    assert.equal(fake.sent.length, 1, "the words went");
    assert.deepEqual(fake.reactCalls, [{ messageHandle: "H-last", reaction: "love", partIndex: null }], "and so did the tapback");
    assert.equal(db.getThread(CONV).held_reaction, null, "taken, so it cannot fire again");
  } finally { await runtime.shutdown(); }
});

test("a turn that held a tapback and then said nothing sends nothing at all", async () => {
  thread();
  const { runtime, fake, router } = harness({
    turn: async () => {
      await react({ reaction: "love", they_asked: true }, router);
      return null;
    },
  });
  try {
    await runtime.inbound(CONV, "which one looks better", { channel: "fake", to: OWNER, fromOwner: true });
    assert.equal(fake.sent.length, 0, "no words");
    assert.equal(fake.reactCalls.length, 0, "and no tapback either — silence with a heart on the question is worse");
    assert.equal(db.getThread(CONV).held_reaction, null, "dropped, not left for a later turn");
  } finally { await runtime.shutdown(); }
});

test("a reading of false sends it straight away, with no text", async () => {
  thread();
  const { router, fake } = harness();
  const out = await react({ reaction: "love", they_asked: false }, router);
  assert.equal(out.ok, true);
  assert.equal(out.reacted_to, "H-last", "the handle came off the thread");
  assert.deepEqual(fake.reactCalls, [{ messageHandle: "H-last", reaction: "love", partIndex: null }]);
  assert.equal(fake.sent.length, 0, "and no bubble was added");
});

test("a bad reaction is still refused for being a bad reaction, even when it would have been held", async () => {
  thread();
  const { router, fake } = harness();
  const out = await react({ reaction: "🔥🔥", they_asked: true }, router);
  assert.equal(out.ok, false);
  assert.match(out.error, /exactly one emoji/);
  assert.equal(db.getThread(CONV).held_reaction, null, "nothing was parked");
  assert.equal(fake.reactCalls.length, 0);
});

test("no reading at all is asked for rather than guessed either way", async () => {
  thread();
  const { router, fake } = harness();
  const out = await react({ reaction: "love" }, router);
  assert.equal(out.ok, false);
  assert.match(out.error, /they_asked/);
  assert.match(out.error, /asking you anything/i);
  assert.equal(fake.reactCalls.length, 0, "nothing was sent on a missing reading");
});

// ---------- the channel that cannot do it says one plain word ----------

test("the console says not_supported and the model is told to use words", async () => {
  db.upsertThread({ conversationId: CONV, channel: "console", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: "H-last" });
  const runtime = new Runtime({ runTurn: async () => null });
  const router = new Router({ runtime });
  router.register(new ConsoleChannel({ write: () => {} }));
  const out = await react({ reaction: "love", they_asked: false }, router);
  assert.equal(out.ok, false);
  assert.equal(out.supported, false);
  assert.equal(out.refused, "not_supported");
  assert.match(out.error, /cannot send tapbacks/);
});

test("a console does not pretend to animate, but it does say an effect was asked for", async () => {
  const lines = [];
  const ch = new ConsoleChannel({ write: (s) => lines.push(s) });
  await ch.send({ to: OWNER, text: "table's booked", sendStyle: "confetti" });
  assert.match(lines.join(""), /confetti/, "readable in the terminal");
  await ch.send({ to: OWNER, text: "ordinary one" });
  assert.ok(!/effect/.test(lines[1]), "and silent when there is no effect");
});

test("capabilities is honest that tapbacks only go one way", async () => {
  thread();
  const { router } = harness();
  const caps = capabilitiesNow({ conversationId: CONV, channels: router });
  const tap = caps.find(c => c.name === "tapbacks");
  assert.equal(tap.status, "live");
  assert.match(tap.what, /outbound only/);
  assert.match(tap.what, /invisible to you/);
});

// ---------- one effect an hour, counted in the database ----------

test("the rule itself: nothing yet is fine, inside the hour is not, an hour later is", () => {
  assert.equal(effectAllowed({ lastAt: null, now: 1_000_000 }).ok, true);
  const inside = effectAllowed({ lastAt: 1_000_000, now: 1_000_000 + 10 * 60_000 });
  assert.equal(inside.ok, false);
  assert.equal(inside.minutes, 50, "and it says how long for");
  assert.equal(effectAllowed({ lastAt: 1_000_000, now: 1_000_000 + EFFECT_EVERY_MS }).ok, true);
});

test("the second effect inside an hour is left off and the message still goes", async () => {
  thread();
  const { router, fake } = harness();
  const first = await send({ to: "owner", text: "table's confirmed for 8", style: "confetti" }, router);
  assert.equal(first.style, "confetti");

  clock.skip(20 * 60_000);
  const second = await send({ to: "owner", text: "and the car's booked", style: "fireworks" }, router);
  assert.equal(second.ok, true, "the text went");
  assert.equal(second.style, undefined, "without the effect");
  assert.match(second.style_dropped, /already had one in the last hour/);
  assert.match(second.style_dropped, /do not mention an effect/);

  await outbox.pass({ router, log: () => {} });
  assert.deepEqual(fake.sent.map(m => m.send_style ?? null), ["confetti", null], "and that is what reached the channel");
});

test("an hour later the next one goes", async () => {
  thread();
  const { router } = harness();
  await send({ to: "owner", text: "table's confirmed", style: "confetti" }, router);
  clock.skip(61 * 60_000);
  const later = await send({ to: "owner", text: "and the flight's changed to the 15th", style: "celebration" }, router);
  assert.equal(later.style, "celebration");
});

test("the limit survives a restart, because it is read off the outbox and not held in memory", async () => {
  thread();
  const first = harness();
  await send({ to: "owner", text: "table's confirmed for 8", style: "confetti" }, first.router);
  assert.ok(db.lastEffectAt(CONV), "the row carrying the effect is the record of it");

  clock.skip(5 * 60_000);
  // A whole new Runtime and Router, the way a redeploy gives you. Nothing is carried over.
  const second = harness();
  const out = await send({ to: "owner", text: "and the car's sorted", style: "balloons" }, second.router);
  assert.equal(out.ok, true);
  assert.equal(out.style, undefined, "the new process counts the old effect");
  assert.match(out.style_dropped, /one in the last hour/);
});

test("an effect dropped for the rail is not counted, so the next real moment still gets one", async () => {
  thread({ service: "SMS" });
  const { router } = harness();
  const sms = await send({ to: "owner", text: "table's confirmed", style: "confetti" }, router);
  assert.match(sms.style_dropped, /iMessage only/);
  assert.equal(db.lastEffectAt(CONV), null, "nothing carried an effect, so nothing was spent");

  thread({ service: "iMessage" });
  const back = await send({ to: "owner", text: "and the table's confirmed", style: "confetti" }, router);
  assert.equal(back.style, "confetti");
});

test("capabilities says when the next effect is available, so nobody is promised confetti", async () => {
  thread();
  const { router } = harness();
  await send({ to: "owner", text: "booked", style: "confetti" }, router);
  clock.skip(15 * 60_000);
  const fx = capabilitiesNow({ conversationId: CONV, channels: router }).find(c => c.name === "message_effects");
  assert.match(fx.what, /about 45 minutes/);
  assert.match(fx.what, /opened, not when it arrives/);
});

// ---------- an effect on the reply itself ----------
//
// Reason's ordinary reply is written by the model and sent by the runtime, not by a tool, so an
// effect that could only ride on message_send could never ride on the reply. mark_moment leaves it
// on the thread and the runtime spends it, the same way reply_to leaves a pin.

test("mark_moment puts the effect on the reply the turn is about to write", async () => {
  thread();
  const { runtime, fake, router } = harness({
    turn: async () => {
      const out = await runTool("mark_moment", { effect: "confetti", moment: "the apartment came through" }, { conversationId: CONV, channels: router });
      assert.equal(out.ok, true);
      assert.match(out.note, /only plays when they open/);
      return "YOOO congrats, three weeks of chasing and it's done";
    },
  });
  try {
    await runtime.inbound(CONV, "they approved it!! i got the apartment 🎉", { channel: "fake", to: OWNER, fromOwner: true });
    await outbox.pass({ router, log: () => {} });
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0].send_style, "confetti", "it reached the channel on the reply itself");
    assert.equal(db.getThread(CONV).pending_style, null, "and was spent, not left armed");
  } finally { await runtime.shutdown(); }
});

test("a marked effect on a turn that says nothing is dropped, not left for the next reply", async () => {
  thread();
  const { runtime, fake, router } = harness({
    turn: async () => {
      await runTool("mark_moment", { effect: "fireworks", moment: "they got the job" }, { conversationId: CONV, channels: router });
      return null;
    },
  });
  try {
    await runtime.inbound(CONV, "i got it", { channel: "fake", to: OWNER, fromOwner: true });
    assert.equal(db.getThread(CONV).pending_style, null, "taken even though nothing was sent");
    assert.equal(fake.sent.length, 0);
  } finally { await runtime.shutdown(); }
});

test("mark_moment is refused inside the hour, and says how long for", async () => {
  thread();
  const { router } = harness();
  await send({ to: "owner", text: "table's confirmed", style: "confetti" }, router);
  clock.skip(10 * 60_000);
  const out = await runTool("mark_moment", { effect: "balloons", moment: "the flight got cheaper" }, { conversationId: CONV, channels: router });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "one_an_hour");
  assert.equal(out.wait_minutes, 50);
  assert.match(out.error, /Your reply still goes out as normal/);
  assert.equal(db.getThread(CONV).pending_style, null, "nothing was armed");
});

test("mark_moment on an SMS thread is a plain not_supported and the reply still goes", async () => {
  thread({ service: "SMS" });
  const { runtime, fake, router } = harness({
    turn: async () => {
      const out = await runTool("mark_moment", { effect: "confetti", moment: "the table came through" }, { conversationId: CONV, channels: router });
      assert.equal(out.refused, "not_supported");
      assert.match(out.error, /iMessage only/);
      return "table's locked in for 8 🎉";
    },
  });
  try {
    await runtime.inbound(CONV, "did they confirm?", { channel: "fake", to: OWNER, fromOwner: true });
    await outbox.pass({ router, log: () => {} });
    assert.equal(fake.sent.length, 1, "the words went");
    assert.equal(fake.sent[0].send_style, undefined, "without an effect");
  } finally { await runtime.shutdown(); }
});

test("a turn that spends the hour on a message of its own does not also put one on the reply", async () => {
  thread();
  const { runtime, fake, router } = harness({
    turn: async () => {
      await runTool("mark_moment", { effect: "confetti", moment: "the apartment came through" }, { conversationId: CONV, channels: router });
      await send({ to: "owner", text: "and the deposit cleared", style: "fireworks" }, router);
      return "congrats man, that's the whole thing done";
    },
  });
  try {
    await runtime.inbound(CONV, "i got the apartment", { channel: "fake", to: OWNER, fromOwner: true });
    await outbox.pass({ router, log: () => {} });
    const styles = fake.sent.map(m => m.send_style ?? null);
    assert.equal(styles.filter(Boolean).length, 1, `exactly one effect went out (got ${JSON.stringify(styles)})`);
  } finally { await runtime.shutdown(); }
});

// ---------- both leave a receipt ----------

test("a tapback that went out has a ledger row saying so, and that no text was sent", async () => {
  thread();
  const { router } = harness();
  await react({ reaction: "love", they_asked: false }, router);
  const row = db.listActions(CONV, { limit: 5 }).find(a => a.action === "react");
  assert.ok(row, "there is a row");
  assert.equal(row.outcome, "ok");
  assert.match(row.receipt, /Put a 'love' tapback on their message \(H-last\)/);
  assert.match(row.receipt, /no text was sent/);
});

test("a held tapback is its own outcome on the ledger, and the one that rides out gets its own row", async () => {
  thread();
  const { runtime, router } = harness({
    turn: async () => {
      await react({ reaction: "love", they_asked: true }, router);
      return "yep, 8pm's free";
    },
  });
  try {
    await runtime.inbound(CONV, "do they have 8pm?", { channel: "fake", to: OWNER, fromOwner: true });
    const rows = db.listActions(CONV, { limit: 10 }).filter(a => a.action === "react");
    assert.equal(rows.length, 2, "the hold and the send are two different things that happened");
    const held = rows.find(r => /Held a/.test(r.receipt));
    const sent = rows.find(r => /Put a 'love' tapback/.test(r.receipt));
    assert.ok(held, "the hold is on the record");
    assert.equal(held.outcome, "blocked", "and reads as a refusal rather than an error");
    assert.ok(sent, "and so is the tapback that actually went");
    assert.equal(sent.outcome, "ok");
  } finally { await runtime.shutdown(); }
});

test("a refused tapback is on the record too, so 'i reacted' is checkable", async () => {
  thread({ service: "SMS" });
  const { router } = harness();
  await react({ reaction: "love", they_asked: false }, router);
  const row = db.listActions(CONV, { limit: 5 }).find(a => a.action === "react");
  assert.equal(row.outcome, "error");
  assert.match(row.receipt, /Did not put a 'love' tapback/);
  assert.match(row.receipt, /iMessage only/);
});

test("a marked moment is on the record with the moment the model thought it had", async () => {
  thread();
  const { router } = harness();
  await runTool("mark_moment", { effect: "confetti", moment: "the apartment application came through" }, { conversationId: CONV, channels: router });
  const row = db.listActions(CONV, { limit: 5 }).find(a => a.action === "mark_moment");
  assert.ok(row);
  assert.equal(row.outcome, "ok");
  assert.match(row.receipt, /the apartment application came through/);
  assert.match(row.receipt, /'confetti'/);
});

test("the effect is on the message's own receipt, and so is one that was left off", async () => {
  thread();
  const { router } = harness();
  await send({ to: "owner", text: "table's confirmed for 8", style: "confetti" }, router);
  clock.skip(60_000);
  await send({ to: "owner", text: "and the car's sorted", style: "fireworks" }, router);

  const rows = db.listActions(CONV, { limit: 10 }).filter(a => a.action === "message_send");
  assert.equal(rows.length, 2);
  assert.ok(rows.some(r => /Sent with the 'confetti' screen effect/.test(r.receipt)), "what the person saw");
  assert.ok(rows.some(r => /No effect:/.test(r.receipt)), "and why the other one had none");
});
