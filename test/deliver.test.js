// Where a message Reason wrote actually goes. No model, no network.
//
// The incident this pins, 2026-10-05: a 5:30 AM reminder and a 10:00 AM reminder both fired, both
// were written, and neither reached a phone. A reply goes back the way the text came in; a message
// Reason STARTS had no channel, and "no channel" meant the console — so every reminder was printed
// into the server's log and recorded in the conversation as said.
//
//   does a reminder reach the phone the conversation lives on?       (yes — the thread's channel)
//   does anything Reason starts still end up in the server's log?    (no — only with no thread at all)
//   can one person's reminder go to another person's number?         (no — each to its own thread)
//   is a reminder that could not be sent lost quietly?               (no — logged, and in the outbox)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-deliver-"));
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
const { makeDeliver, whereTo } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** The server's own wiring: a real Runtime, a router, and the same deliver function serve.js uses. */
function harness({ channel = {}, turn = async () => "gua sha time ✨" } = {}) {
  const printed = [];
  const logs = [];
  const warned = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: (s) => printed.push(s) });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: (l) => warned.push(l) });
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: turn, channels: router, deliver });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639", ...channel }));
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { runtime, router, fake, printed, logs, warned, deliver };
}

const texted = (conversationId = CONV, address = OWNER) => db.upsertThread({ conversationId, channel: "fake", address, isOwner: true, service: "iMessage" });

// ---------- the incident ----------

test("a reminder that fires is texted to the phone the conversation lives on", async () => {
  const { runtime, fake, printed, logs } = harness();
  texted();
  db.createTimer(CONV, { fireAt: clock.now() + 60_000, note: "daily gua sha reminder" });
  clock.skip(61_000);

  assert.equal(await runtime.tick(), 1, "the timer fired");
  assert.equal(fake.sent.length, 1, "and its message went out over the texting channel");
  assert.equal(fake.sent[0].to, OWNER);
  assert.equal(fake.sent[0].text, "gua sha time ✨");
  assert.deepEqual(printed, [], "not into the server's log, which is where both reminders went on 2026-10-05");
  assert.ok(logs.some(l => l.started_message === CONV && l.over === "fake"));

  // And it is a real outbox row, so one that fails comes back or gets reported.
  const row = db.db.prepare("SELECT * FROM outbox WHERE conversation_id = ?").get(CONV);
  assert.equal(row.state, "sent");
  assert.equal(row.address, OWNER);
  assert.equal(row.to_owner, 1);
});

test("everything Reason starts itself takes the same road: an event turn and a code-written line", async () => {
  const { runtime, fake, printed } = harness({ turn: async () => "found a table for friday" });
  texted();
  await runtime.event(CONV, "watcher #3 found something", { fromWatch: 3 });
  runtime.say(CONV, "heads up, that reminder is set");
  await new Promise(r => setImmediate(r));
  assert.deepEqual(fake.sent.map(m => m.text), ["found a table for friday", "heads up, that reminder is set"]);
  assert.deepEqual(printed, []);
});

test("each person's reminder goes to their own number and nobody else's", async () => {
  const { runtime, fake } = harness({ turn: async ({ conversationId }) => `for ${conversationId}` });
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  texted();
  texted(THEIRS, FRIEND);
  db.createTimer(CONV, { fireAt: clock.now() + 1_000, note: "mine" });
  db.createTimer(THEIRS, { fireAt: clock.now() + 1_000, note: "theirs" });
  clock.skip(2_000);
  await runtime.tick();

  assert.deepEqual(fake.sent.map(m => [m.to, m.text]).sort(), [[OWNER, `for ${CONV}`], [FRIEND, `for ${THEIRS}`]].sort());
  // Their own reminder failing is news for them, not for the master.
  assert.equal(db.db.prepare("SELECT to_owner FROM outbox WHERE conversation_id = ?").get(THEIRS).to_owner, 1);
});

test("a reply still goes back exactly the way it came in", async () => {
  const { deliver, fake, printed, logs } = harness();
  texted(CONV, "+19995550000"); // the thread row says one thing; the turn was handed another
  await deliver({ conversationId: CONV, text: "on it", channel: "fake", to: OWNER, chatId: null, fromOwner: true });
  assert.equal(fake.sent[0].to, OWNER, "the address the turn was handed wins");
  assert.deepEqual(printed, []);
  assert.equal(logs.some(l => l.started_message), false, "and it is not counted as something Reason started");
});

test("with no texting thread at all, the console is still where it goes", async () => {
  const { runtime, fake, printed } = harness();
  db.createTimer(CONV, { fireAt: clock.now() + 1_000, note: "console reminder" });
  clock.skip(2_000);
  await runtime.tick();
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(printed, ["reason> gua sha time ✨\n\n"], "the terminal, for an install nobody texts");
});

test("a reminder that could not be sent is said so out loud, not dropped", async () => {
  const { runtime, fake, logs, warned, printed } = harness({ channel: { failWith: "the line is blocked" } });
  texted();
  db.createTimer(CONV, { fireAt: clock.now() + 1_000, note: "daily gua sha reminder" });
  clock.skip(2_000);
  await runtime.tick();

  assert.equal(fake.sent.length, 0);
  assert.deepEqual(printed, [], "it does not fall back to the log and call that delivered");
  assert.ok(warned.some(l => /could not send over fake: the line is blocked/.test(l)));
  assert.ok(logs.some(l => l.started_message_failed === CONV && /blocked/.test(l.why)));
  assert.equal(db.db.prepare("SELECT state FROM outbox WHERE conversation_id = ?").get(CONV).state, "failed", "and the outbox knows, so the next turn is told");
});

test("NO_REPLY from a timer sends nothing anywhere", async () => {
  const { runtime, fake, printed } = harness({ turn: async () => null });
  texted();
  db.createTimer(CONV, { fireAt: clock.now() + 1_000, note: "nothing worth saying" });
  clock.skip(2_000);
  await runtime.tick();
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(printed, []);
});

test("whereTo, in the three cases it has", () => {
  assert.deepEqual(whereTo({ conversationId: CONV }), { channel: "console", to: null, chatId: null, started: false });
  texted();
  assert.deepEqual(whereTo({ conversationId: CONV }), { channel: "fake", to: OWNER, chatId: null, started: true });
  assert.deepEqual(whereTo({ conversationId: CONV, channel: "sendblue", to: FRIEND }), { channel: "sendblue", to: FRIEND, chatId: null, started: false });
  // A thread row for the console itself is still the console.
  db.upsertThread({ conversationId: "dm:term", channel: "console", address: "console", isOwner: true });
  assert.equal(whereTo({ conversationId: "dm:term" }).channel, "console");
});
