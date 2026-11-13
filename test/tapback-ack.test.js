// REASON_TAPBACK_ACK (src/tapbackack.js): a fixed-meaning tapback on their text the moment its turn
// runs a tool, swapped when the state changes, and never doubled by a text saying the same thing.
//
//   is the vocabulary one map with one meaning each?            (yes — ACK, and the test pins it)
//   does a turn that uses no tool get no tapback?               (yes — the reply is the acknowledgement)
//   does a swap take the old one off the SAME message first?    (yes — "-👀" then "✅" on one handle)
//   does a text that arrived in parts get it on the message?    (yes — the thread's base handle)
//   is a bare "on it" after 👀 dropped?                          (yes — the tapback was that reply)
//   does a job's finish land ✅ on the text that started it?     (yes — even after the thread moved on)
//   does the switch being off change nothing?                   (yes — not one channel call)
//
// No model and no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-tapback-ack-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_TAPBACK_ACK = "on";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const ack = await import("../src/tapbackack.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const CONV = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  ack.reset();
  process.env.REASON_TAPBACK_ACK = "on";
  db.db.exec("DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM action_ledger; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM tasks; DELETE FROM timers;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A thread after one of their texts arrived, with the message on record the way the router keeps it. */
function arrived(handle, { text = "can you find me a table" } = {}) {
  db.claimInbound({ channel: "fake", externalId: handle, conversationId: CONV, text });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle.replace(/_\d+$/, "") });
}

function harness({ turn = async () => null, channelOpts = {} } = {}) {
  const logs = [];
  const runtime = new Runtime({ runTurn: async (ctx) => await turn(ctx), log: (e) => logs.push(e) });
  const router = new Router({ runtime });
  const fake = router.register(new FakeChannel({ number: LINE, ...channelOpts }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, sendStyle }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, sendStyle });
  });
  return { runtime, router, fake, logs };
}

const reactions = (fake) => fake.reactCalls.map(r => `${r.messageHandle}:${r.reaction}`);

// ---------- the vocabulary ----------

test("the vocabulary is one map, four meanings, one emoji each", () => {
  assert.deepEqual(ack.ACK, { seen: "👀", looking: "🔍", done: "✅", timer: "⏰" });
  assert.equal(new Set(Object.values(ack.ACK)).size, 4, "no emoji means two things");
  assert.ok(Object.isFrozen(ack.ACK), "and nothing can add a fifth at runtime");
});

test("a bare acknowledgement is recognised; anything that carries something is not", () => {
  for (const t of ["on it", "On it!", "got it", "ok", "looking into it", "one sec", "👀"]) assert.equal(ack.isBareAck(t), true, t);
  for (const t of ["on it — they have 8pm", "got it, want the 7 or the 8?", "ok so the place is closed", "", "   "]) assert.equal(ack.isBareAck(t), false, t);
});

// ---------- seen → done is a swap on one message ----------

test("👀 goes on their text, and done swaps it: the old one off, the new one on, same message", async () => {
  arrived("H-1");
  const { router, fake } = harness();
  const first = await ack.mark(CONV, "seen", { channels: router });
  assert.equal(first.ok, true);
  assert.equal(ack.current(CONV), "seen");
  const then = await ack.mark(CONV, "done", { channels: router });
  assert.equal(then.ok, true);
  assert.deepEqual(reactions(fake), ["H-1:👀", "H-1:-👀", "H-1:✅"]);
  assert.equal(ack.current(CONV), "done");
});

test("the same state twice is one tapback, not two", async () => {
  arrived("H-1");
  const { router, fake } = harness();
  await ack.mark(CONV, "seen", { channels: router });
  const again = await ack.mark(CONV, "seen", { channels: router });
  assert.equal(again.unchanged, true);
  assert.deepEqual(reactions(fake), ["H-1:👀"]);
});

test("calls land in the order they were asked for, even when not awaited", async () => {
  arrived("H-1");
  const { router, fake } = harness();
  void ack.mark(CONV, "seen", { channels: router });
  void ack.mark(CONV, "looking", { channels: router });
  await ack.settled(CONV);
  assert.deepEqual(reactions(fake), ["H-1:👀", "H-1:-👀", "H-1:🔍"]);
});

// ---------- a text that arrived in parts ----------

test("a text that arrived as three parts gets its tapback on the message, never on a part", async () => {
  // What the router leaves behind for `H`, `H_1`, `H_2` (src/channels/router.js): every part on
  // record, and the thread pointing at the BASE handle, because a reaction on `H_2` is a 422.
  arrived("H-base");
  arrived("H-base_1", { text: "" });
  arrived("H-base_2", { text: "" });
  const { router, fake } = harness();
  await ack.mark(CONV, "seen", { channels: router });
  assert.deepEqual(reactions(fake), ["H-base:👀"]);
});

// ---------- the turn ----------

/** A turn that reads something (a tool that neither looks anything up nor acts), then answers. */
const readThenAnswer = (reply) => async (ctx) => {
  ack.noteTool({ ...ctx, conversationId: CONV }, "memory_read", { ok: true, notes: [] });
  return reply;
};

test("a turn that answers from what it knows — no tool — gets no tapback; the reply is the acknowledgement", async () => {
  arrived("H-1");
  const { runtime, fake } = harness({ turn: async () => "they've got 8pm, want it?" });
  try {
    await runtime.inbound(CONV, "can you find me a table", { channel: "fake", to: OWNER, fromOwner: true });
    await ack.settled(CONV);
    assert.deepEqual(reactions(fake), [], "not one tapback");
    assert.equal(ack.current(CONV), null);
    assert.equal(fake.sent.length, 1, "the words went");
    assert.match(fake.sent[0].text, /8pm/);
  } finally { await runtime.shutdown(); }
});

test("the turn's FIRST tool puts 👀 on their text; a second tool adds nothing; the reply still goes", async () => {
  arrived("H-1");
  const { runtime, fake } = harness({
    turn: async (ctx) => {
      ack.noteTool({ ...ctx, conversationId: CONV }, "memory_read", { ok: true });
      ack.noteTool({ ...ctx, conversationId: CONV }, "calendar_list", { ok: true });
      return "they've got 8pm, want it?";
    },
  });
  try {
    await runtime.inbound(CONV, "can you find me a table", { channel: "fake", to: OWNER, fromOwner: true });
    await ack.settled(CONV);
    assert.deepEqual(reactions(fake), ["H-1:👀"], "one 👀, however many tools");
    assert.equal(fake.sent.length, 1, "the words went");
  } finally { await runtime.shutdown(); }
});

test("a no-tool 'on it' goes as words — nothing else acknowledged the text", async () => {
  arrived("H-1");
  const { runtime, fake } = harness({ turn: async () => "on it" });
  try {
    await runtime.inbound(CONV, "book me the usual", { channel: "fake", to: OWNER, fromOwner: true });
    await ack.settled(CONV);
    assert.deepEqual(reactions(fake), []);
    assert.equal(fake.sent.length, 1, "the words are the acknowledgement");
  } finally { await runtime.shutdown(); }
});

test("a reply that is only 'on it' after a tool turn's 👀 is dropped: the tapback was that reply", async () => {
  arrived("H-1");
  const { runtime, fake, logs } = harness({ turn: readThenAnswer("on it") });
  try {
    await runtime.inbound(CONV, "book me the usual", { channel: "fake", to: OWNER, fromOwner: true });
    await ack.settled(CONV);
    assert.deepEqual(reactions(fake), ["H-1:👀"]);
    assert.equal(fake.sent.length, 0, "no second 'on it' in words");
    assert.ok(logs.some(l => l.bare_ack_dropped === CONV), "and the log says why");
  } finally { await runtime.shutdown(); }
});

test("with 👀 refused by the line, 'on it' in words still goes — nothing said it twice", async () => {
  arrived("H-1");
  const { runtime, fake } = harness({ turn: readThenAnswer("on it"), channelOpts: { reactAs: "line" } });
  try {
    await runtime.inbound(CONV, "book me the usual", { channel: "fake", to: OWNER, fromOwner: true });
    await ack.settled(CONV);
    assert.equal(ack.current(CONV), null, "nothing is on their message");
    assert.equal(fake.sent.length, 1, "so the words are the acknowledgement");
  } finally { await runtime.shutdown(); }
});

test("a Web message's turn gets no tapback, tools or not", async () => {
  arrived("H-1");
  const { router } = harness();
  ack.noteTool({ conversationId: CONV, channels: router, channel: "web" }, "memory_read", { ok: true });
  ack.noteTool({ conversationId: CONV, channels: router, kind: "event" }, "memory_read", { ok: true });
  await ack.settled(CONV);
  assert.equal(ack.current(CONV), null);
});

test("a turn whose action worked ends ✅; a turn that only answered leaves 👀", async () => {
  arrived("H-1");
  const { runtime, fake, router } = harness({
    turn: async (ctx) => {
      // A real acting tool of this turn that works: a reminder (timer_set is in LAPSED_EXTRA and acts).
      await runTool("timer_set", { fire_at: new Date(clock.now() + 3_600_000).toISOString(), title: "call mum", note: "call mum" }, { ...ctx, conversationId: CONV, channels: router });
      return "set — i'll remind you at 7";
    },
  });
  try {
    await runtime.inbound(CONV, "remind me to call mum at 7", { channel: "fake", to: OWNER, fromOwner: true });
    await ack.settled(CONV);
    assert.deepEqual(reactions(fake), ["H-1:👀", "H-1:-👀", "H-1:⏰"], "a timer set is ⏰, and stays ⏰ (it is the honest state)");
  } finally { await runtime.shutdown(); }

  ack.reset();
  arrived("H-2");
  const plain = harness({ turn: readThenAnswer("it's at 7 on 5th ave") });
  try {
    await plain.runtime.inbound(CONV, "where is it", { channel: "fake", to: OWNER, fromOwner: true });
    await ack.settled(CONV);
    assert.deepEqual(reactions(plain.fake), ["H-2:👀"], "seen is still true; nothing to swap");
  } finally { await plain.runtime.shutdown(); }
});

test("a lookup during the turn swaps 👀 for 🔍 — even as the turn's first tool, and in that order", async () => {
  arrived("H-1");
  const { router, fake } = harness();
  ack.noteTool({ conversationId: CONV, channels: router }, "web_search", { ok: true, results: [] });
  await ack.settled(CONV);
  assert.deepEqual(reactions(fake), ["H-1:👀", "H-1:-👀", "H-1:🔍"]);
  // A second lookup on the same text: 🔍 is already there.
  ack.noteTool({ conversationId: CONV, channels: router }, "web_read", { ok: true });
  await ack.settled(CONV);
  assert.deepEqual(reactions(fake), ["H-1:👀", "H-1:-👀", "H-1:🔍"]);
});

// ---------- a background job ----------

test("a job started by a text lands ✅ on THAT text when it finishes, after the thread has moved on", async () => {
  arrived("H-1");
  const { router, fake } = harness();
  await ack.mark(CONV, "seen", { channels: router });
  const task = db.createTask(CONV, { title: "find a table", goal: "book", maxAttempts: 3, originHandle: "H-1" });
  ack.noteTool({ conversationId: CONV, channels: router, answering: { handle: "H-1" } }, "task_start", { ok: true, task: { id: task.id } });

  // They text again; the thread now points at a newer message.
  arrived("H-2");
  await ack.mark(CONV, "seen", { channels: router });

  ack.noteTool({ conversationId: CONV, channels: router }, "task_finish", { ok: true, task: { id: task.id, state: "done" } });
  await ack.settled(CONV);
  assert.deepEqual(reactions(fake), ["H-1:👀", "H-2:👀", "H-1:✅"], "✅ on the first text, not the newest one, and no '-' on a message that had nothing of ours");
});

// ---------- the switch ----------

test("off: not one call reaches the channel, and a bare 'on it' goes as words", async () => {
  process.env.REASON_TAPBACK_ACK = "off";
  arrived("H-1");
  const { runtime, fake, router } = harness({ turn: async () => "on it" });
  try {
    const r = await ack.mark(CONV, "seen", { channels: router });
    assert.equal(r.skipped, "off");
    await runtime.inbound(CONV, "book me the usual", { channel: "fake", to: OWNER, fromOwner: true });
    assert.equal(fake.reactCalls.length, 0);
    assert.equal(fake.sent.length, 1);
  } finally { await runtime.shutdown(); }
});

test("owner: the operator's thread only", async () => {
  process.env.REASON_TAPBACK_ACK = "owner";
  const AMA = "dm:fake:+13475550000";
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  db.claimInbound({ channel: "fake", externalId: "A-1", conversationId: AMA, text: "hi" });
  db.upsertThread({ conversationId: AMA, channel: "fake", address: "+13475550000", isOwner: true, service: "iMessage", lastInboundId: "A-1" });
  arrived("H-1");
  const { router, fake } = harness();
  assert.equal((await ack.mark(AMA, "seen", { channels: router })).skipped, "off");
  assert.equal((await ack.mark(CONV, "seen", { channels: router })).ok, true);
  assert.deepEqual(reactions(fake), ["H-1:👀"]);
});
