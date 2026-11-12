// REASON_TYPING_AWARE (src/typingaware.js): a reply waits only while the person is still typing.
//
// The fixed pause (REASON_BURST_QUIET_MS, 1.0 s live) is replaced, behind the switch, by Sendblue's
// typing webhooks: not typing → the turn starts now; typing → hold for the next text and fold it in;
// typing stops with nothing sent → reply; 15 s → reply whatever the events say; no events, or a
// forged one → "not typing". Nothing about typing is stored or logged with who.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-typing-aware-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_BURST_QUIET_MS = "1000";
delete process.env.REASON_TYPING_AWARE;
delete process.env.REASON_TYPING_GRACE_MS;

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const ta = await import("../src/typingaware.js");
const onethought = await import("../src/onethought.js");

const KOFI = "+14155559876";
const KOFI_C = `dm:fake:${KOFI}`;
const LINE = "+15122164639";
const SECRET = "a-shared-webhook-secret";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  delete process.env.REASON_TYPING_AWARE;
  delete process.env.REASON_TYPING_GRACE_MS;
  config.burstQuietMs = 1_000;
  ta.resetTypingAware();
  onethought.setMidTurnReader(() => "continuation");
  db.db.exec(`DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM requests;`);
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
});

/** serve.js's wiring with every wait on a hand-held timer: nothing waits real seconds, and each wait's length is kept. */
function harness({ slow = false } = {}) {
  const logs = [], turns = [], waits = [], asked = [], sent = [], finish = [];
  const timers = { set: (fn, ms) => { waits.push(fn); asked.push(ms); return { unref() {} }; }, clear: () => {} };
  const router = new Router({ log: (e) => logs.push(e), timers });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver0 = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const deliver = async (m) => { sent.push(m.text); return deliver0(m); };
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => {
    turns.push(args);
    // `slow`: the turn is working until the test says it has its answer (`finish.shift()()`).
    if (slow) await new Promise(r => finish.push(r));
    return `re: ${args.text}`;
  } });
  router.runtime = runtime;
  router.register(consoleChannel);
  router.register(new FakeChannel({ number: "+16562167455" }));
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    sent.push(text);
    await deliver0({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  const settle = () => new Promise(r => setTimeout(r, 25));
  /** Let `ms` pass on the clock and fire every wait that was booked. */
  const pass = async (ms) => { clock.skip(ms); for (const fn of waits.splice(0)) fn(); await settle(); };
  return { router, runtime, logs, turns, waits, asked, sent, finish, pass, settle };
}

const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const text = (h, id, body) => h.router.deliver({ channel: "fake", externalId: id, from: KOFI, text: body, at: clock.now() });
const typing = (on, who = KOFI) => ta.noteEvent({ address: who, isTyping: on });
const holds = (h) => h.logs.filter(l => l.typing_hold);
// The clock is the real one plus what a test skips, so a duration is checked to within the few
// hundred real milliseconds a test spends settling, and never below what was skipped.
const near = (actual, expected, slack = 500) => assert.ok(actual >= expected - 5 && actual <= expected + slack, `${actual} is not about ${expected}`);
/** Every wait that was booked, as [at most, at least] pairs matched in order. */
const waitsWere = (asked, expected) => {
  assert.equal(asked.length, expected.length, `waits booked: ${JSON.stringify(asked)}`);
  asked.forEach((ms, i) => assert.ok(ms <= expected[i] && ms > expected[i] - 200, `wait ${i} was ${ms}, expected just under ${expected[i]}`));
};

test("the switch: off by default; owner is the operator's thread only; on is everybody", () => {
  assert.equal(ta.typingAwareMode(), "off");
  assert.equal(ta.typingAwareOn({ isOperator: true }), false);
  process.env.REASON_TYPING_AWARE = "owner";
  assert.equal(ta.typingAwareOn({ isOperator: true }), true);
  assert.equal(ta.typingAwareOn({ conversationId: "dm:owner" }), true);
  assert.equal(ta.typingAwareOn({ conversationId: KOFI_C }), false);
  process.env.REASON_TYPING_AWARE = "on";
  assert.equal(ta.typingAwareOn({ conversationId: KOFI_C }), true);
  process.env.REASON_TYPING_AWARE = "sometimes";
  assert.equal(ta.typingAwareMode(), "off");
});

test("the short window is never more than a second, whatever is set", () => {
  assert.equal(ta.graceMs(), 300);
  process.env.REASON_TYPING_GRACE_MS = "0"; assert.equal(ta.graceMs(), 0);
  process.env.REASON_TYPING_GRACE_MS = "9000"; assert.equal(ta.graceMs(), 1_000);
  process.env.REASON_TYPING_GRACE_MS = "-5"; assert.equal(ta.graceMs(), 0);
  process.env.REASON_TYPING_GRACE_MS = "soon"; assert.equal(ta.graceMs(), 300);
  assert.equal(ta.CAP_MS, 15_000);
  assert.ok(ta.STATE_TTL_MS <= 30_000);
});

test("off is today's behaviour: the fixed pause is waited, typing events change nothing, nothing extra is logged", async () => {
  // The same texts, once with no typing events at all and once with them arriving: with the switch
  // off the two runs must book the same waits, run the same turn and write the same log lines.
  const run = async (withEvents) => {
    clock.reset(); ta.resetTypingAware();
    db.db.exec("DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM outbox; DELETE FROM event_log; DELETE FROM requests; DELETE FROM usage;");
    const h = harness();
    if (withEvents) typing(true);
    const one = text(h, `off-${withEvents}-1`, "book the 7pm");
    await h.settle();
    assert.equal(h.turns.length, 0, "held for the fixed pause");
    waitsWere(h.asked, [1_000]);
    if (withEvents) typing(true);
    await h.pass(400);
    const two = text(h, `off-${withEvents}-2`, "for four");
    await h.settle();
    assert.equal(h.turns.length, 0);
    if (withEvents) typing(false);
    await h.pass(1_000);
    await one; await two;
    assert.ok(await until(() => h.turns.length === 1));
    return { asked: h.asked.map(ms => Math.round(ms / 200) * 200), text: h.turns[0].text, logs: h.logs.map(l => Object.keys(l).join(",")), pending: db.countPendingInbound(KOFI_C) };
  };
  const plain = await run(false);
  const watched = await run(true);
  assert.deepEqual(watched, plain);
  assert.ok(!plain.logs.some(k => /typing_hold|typing_aware/.test(k)));
  assert.match(plain.text, /book the 7pm[\s\S]*for four/);
});

test("on, nothing heard from them (webhook missing, down, or a pasted text): today's fixed pause, exactly", async () => {
  // The replay of real traffic (scripts/typing-replay.mjs) is why: starting at once with no signal
  // sent 3 more replies on the first half of a burst than the pause does.
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  for (let i = 0; i < 3; i++) {
    const p = text(h, `nohook-${i}`, `text ${i}`);
    await h.settle();
    assert.equal(h.turns.length, i, "held for the fixed pause, as with the switch off");
    await h.pass(1_000);
    await p;
    assert.equal(h.turns.length, i + 1);
    clock.skip(60_000);
  }
  waitsWere(h.asked, [1_000, 1_000, 1_000]);
  assert.equal(holds(h).length, 0, "and nothing was held for typing");
  assert.equal(ta.summary(), null, "with no typing events there is no hourly line either");
});

test("on, nothing heard: a second text inside the pause still joins the first, as today", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  const a = text(h, "plain-1", "book the 7pm");
  await h.settle();
  await h.pass(400);
  const b = text(h, "plain-2", "for four");
  await h.settle();
  assert.equal(h.turns.length, 0);
  await h.pass(1_000);
  await Promise.all([a, b]);
  assert.ok(await until(() => h.turns.length === 1));
  assert.match(h.turns[0].text, /book the 7pm[\s\S]*for four/);
});

test("on, they typed this text and then stopped: only the short window is waited, then the reply", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);             // writing the text
  clock.skip(2_000);
  const p = text(h, "typed-1", "is the gym open");
  await h.settle();
  assert.equal(h.turns.length, 0, "the typing before a text is that text: not a reason for a long wait");
  waitsWere(h.asked, [300]);
  await h.pass(300);
  assert.equal(h.turns.length, 1, "the turn started 0.7 s sooner than the fixed pause");
  // This turn answered instantly, long before a 'typing' for a next text could have arrived. So
  // the send gives the head start back: it goes no sooner than it would have today.
  assert.equal(h.sent.length, 0, "written, not sent yet");
  waitsWere(h.asked, [300, 700]);
  await h.pass(700);
  await p;
  assert.equal(h.sent.length, 1);
  assert.deepEqual(holds(h).map(l => [l.typing_hold, l.at ?? "start"]), [["not_typing", "start"], ["not_typing", "send"]]);
  near(holds(h)[0].waited_ms, 300);
});

test("on, a burst: each text sent while they are still typing joins one turn", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  const a = text(h, "burst-1", "can you book dinner");
  await h.settle();
  clock.skip(150); typing(true);          // already on the next bubble
  await h.settle();
  assert.equal(h.turns.length, 0, "held: they are typing");
  clock.skip(2_500);
  const b = text(h, "burst-2", "saturday at 8");
  await h.settle();
  assert.equal(h.turns.length, 0, "asked again after the second text");
  clock.skip(200); typing(true);
  await h.settle();
  clock.skip(3_000);
  const c = text(h, "burst-3", "for six people");
  await h.settle();
  typing(false);                           // done
  await h.pass(300);
  await h.pass(700);                       // an instant turn: the send gives the head start back
  await Promise.all([a, b, c]);
  assert.ok(await until(() => h.turns.length === 1));
  assert.equal(h.turns.length, 1, "one turn for the whole burst");
  assert.match(h.turns[0].text, /can you book dinner[\s\S]*saturday at 8[\s\S]*for six people/);
  assert.equal(db.countPendingInbound(KOFI_C), 0);
  assert.ok(h.logs.some(l => l.burst === KOFI_C && l.messages === 3));
});

test("on, a correction: 'no wait, 7 not 8' typed right after is folded into the same turn", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  const a = text(h, "fix-1", "book the table for 8");
  await h.settle();
  clock.skip(250); typing(true);
  await h.settle();
  assert.equal(h.turns.length, 0);
  clock.skip(4_000);
  const b = text(h, "fix-2", "no wait, 7 not 8");
  await h.settle();
  await h.pass(300);
  await h.pass(700);
  await Promise.all([a, b]);
  assert.ok(await until(() => h.turns.length === 1));
  assert.equal(h.turns.length, 1, "one answer, to the corrected request");
  assert.match(h.turns[0].text, /book the table for 8[\s\S]*no wait, 7 not 8/);
  const hold = holds(h)[0];
  assert.equal(hold.typing_hold, "more");
  assert.ok(hold.waited_ms >= 4_000 && hold.waited_ms < 15_000);
});

test("on, type then delete: typing stops with nothing sent, and the reply goes to what there is", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  const a = text(h, "del-1", "remind me to call mum");
  await h.settle();
  clock.skip(200); typing(true);
  await h.settle();
  assert.equal(h.turns.length, 0, "held while they type");
  clock.skip(5_000);
  typing(false);                            // deleted the draft
  await a;
  assert.equal(h.turns.length, 1, "replied the moment typing stopped, without waiting for a timer");
  assert.equal(h.turns[0].text.includes("remind me to call mum"), true);
  assert.deepEqual(holds(h).map(l => l.typing_hold), ["stopped"]);
  near(holds(h)[0].waited_ms, 5_200);
});

test("on, typing stuck on: the reply goes at 15 s whatever the events say", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  const a = text(h, "stuck-1", "how far is the airport");
  await h.settle();
  clock.skip(100); typing(true);
  await h.settle();
  // Still "typing", repeated every few seconds, and never a text or a stop.
  for (let t = 0; t < 4; t++) { clock.skip(3_000); typing(true); await h.settle(); }
  assert.equal(h.turns.length, 0, "12.1 s in: still held");
  assert.ok(h.asked.every(ms => ms <= 15_000), "no single wait is ever booked past the cap");
  await h.pass(2_900);                       // 15.0 s after the text
  await a;
  assert.equal(h.turns.length, 1);
  assert.deepEqual(holds(h).map(l => l.typing_hold), ["cap"]);
  near(holds(h)[0].waited_ms, 15_000);
});

test("on, texts that keep joining a held turn: 30 s in all and no more", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  const sent = [text(h, "long-0", "part 0")];
  await h.settle();
  for (let i = 1; i <= 3; i++) {
    clock.skip(100); typing(true); await h.settle();
    clock.skip(9_000);
    sent.push(text(h, `long-${i}`, `part ${i}`));
    await h.settle();
  }
  clock.skip(100); typing(true); await h.settle();
  assert.equal(h.turns.length, 0, "27.4 s in, still typing");
  await h.pass(2_600);
  await Promise.all(sent);
  assert.ok(await until(() => h.turns.length === 1));
  assert.equal(h.turns.length, 1);
  assert.ok(holds(h).some(l => l.typing_hold === "cap"));
});

test("on, the webhook goes quiet while a reply is held: the wait ends when the state expires, at the latest the cap", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  const a = text(h, "quiet-1", "any news");
  await h.settle();
  clock.skip(100); typing(true);
  await h.settle();
  assert.equal(h.turns.length, 0);
  await h.pass(14_900);
  await a;
  assert.equal(h.turns.length, 1, "one 'typing' and then silence is 15 s, never forever");
});

test("state expires: 'typing' is believed for 30 s and then forgotten, and nothing is kept about anybody after that", () => {
  typing(true);
  assert.equal(ta.isTyping(KOFI), true);
  clock.skip(29_000);
  assert.equal(ta.isTyping(KOFI), true);
  clock.skip(1_000);
  assert.equal(ta.isTyping(KOFI), false, "30 s on, a 'typing' with no follow-up is not believed");
  assert.equal(ta.remembered(), 0, "and the entry is gone");
  typing(true); typing(false);
  assert.equal(ta.isTyping(KOFI), false);
  clock.skip(30_000);
  assert.equal(ta.remembered(), 0);
});

test("on, a 'typing' older than 30 s is nothing: the next text gets the fixed pause", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  clock.skip(45_000);
  const p = text(h, "stale-1", "hello");
  await h.settle();
  waitsWere(h.asked, [1_000]);
  await h.pass(1_000);
  await p;
  assert.equal(h.turns.length, 1);
  assert.equal(holds(h).length, 0);
});

test("owner mode: everybody else keeps the fixed pause", async () => {
  process.env.REASON_TYPING_AWARE = "owner";
  const h = harness();
  const p = text(h, "owner-1", "hi");
  await h.settle();
  assert.equal(h.turns.length, 0);
  waitsWere(h.asked, [1_000]);
  await h.pass(1_000);
  await p;
  assert.equal(h.turns.length, 1);
});

test("nothing about typing reaches the database or the log with who", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  typing(true);
  const a = text(h, "priv-1", "one");
  await h.settle();
  clock.skip(100); typing(true); await h.settle();
  clock.skip(2_000); typing(false);
  await a;
  assert.equal(h.turns.length, 1);
  // Every table, every text column: no row mentions typing. (The words of the text are sealed.)
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  for (const t of tables) {
    for (const row of db.db.prepare(`SELECT * FROM "${t}"`).all()) {
      assert.ok(!/is_typing|typing_indicator|typing_hold/i.test(JSON.stringify(row)), `${t} holds something about typing`);
    }
  }
  // The log: the hold's line is a code and a duration. No address and no conversation.
  assert.equal(holds(h).length, 1);
  for (const l of holds(h)) {
    assert.deepEqual(Object.keys(l).filter(k => k !== "at").sort(), ["typing_hold", "waited_ms"]);
    assert.ok(!JSON.stringify(l).includes(KOFI.slice(1)) && !JSON.stringify(l).includes("dm:"));
  }
  const line = ta.summary();
  assert.ok(line.events >= 3);
  assert.ok(!JSON.stringify(line).includes(KOFI.slice(1)) && !JSON.stringify(line).includes("dm:"), "the hourly line names nobody");
  for (const v of Object.values(line)) assert.ok(v === null || typeof v === "number" || v === "on", "counts, medians and the mode only");
});

// ---------- the send: a "typing" that arrives while the turn is working ----------

test("on, they start typing while the reply is being written: the send waits, and their text is answered in the same reply", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness({ slow: true });
  typing(true);
  const a = text(h, "gate-1", "book the table for 8");
  await h.settle();
  await h.pass(300);                         // no 'typing' yet: the turn starts
  assert.equal(h.turns.length, 1);
  clock.skip(1_500); typing(true);           // the event for their next bubble arrives mid-turn
  clock.skip(6_000);
  h.finish.shift()();                        // the reply is written
  await h.settle();
  assert.equal(h.sent.length, 0, "not sent: they are typing");
  clock.skip(2_000);
  const b = text(h, "gate-2", "no wait, 7 not 8");
  await h.settle();
  assert.ok(await until(() => h.turns.length === 2), "the stale draft is thrown away and the turn writes one answer to both");
  h.finish.shift()();
  await Promise.all([a, b]);
  assert.ok(await until(() => h.sent.length === 1));
  assert.equal(h.sent.length, 1, "one reply");
  assert.match(h.turns[1].text, /no wait, 7 not 8/);
  assert.ok(!h.sent.some(t => t === "re: book the table for 8"), "the answer to the uncorrected request never went out");
  const gate = holds(h).find(l => l.at === "send");
  assert.equal(gate.typing_hold, "more");
  near(gate.waited_ms, 2_000);
});

test("on, typing at the send and then nothing: the reply goes when they stop, and at 15 s whatever the events say", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  for (const stops of [true, false]) {
    clock.reset(); ta.resetTypingAware();
    db.db.exec("DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM outbox;");
    const h = harness({ slow: true });
    typing(true);
    const a = text(h, `gatecap-${stops}`, "how far is the airport");
    await h.settle();
    await h.pass(300);
    clock.skip(1_500); typing(true);
    clock.skip(5_000);
    h.finish.shift()();
    await h.settle();
    assert.equal(h.sent.length, 0);
    if (stops) { clock.skip(4_000); typing(false); }
    else {
      for (let t = 0; t < 4; t++) { clock.skip(3_000); typing(true); await h.settle(); }
      assert.equal(h.sent.length, 0, "12 s at the send: still held");
      assert.ok(h.asked.every(ms => ms <= 15_000));
      await h.pass(3_000);
    }
    await a;
    assert.equal(h.sent.length, 1);
    const gate = holds(h).find(l => l.at === "send");
    assert.equal(gate.typing_hold, stops ? "stopped" : "cap");
    near(gate.waited_ms, stops ? 4_000 : 15_000);
  }
});

test("on, not typing when the reply is ready: sent at once, the head start kept", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness({ slow: true });
  typing(true);
  const a = text(h, "keep-1", "what's the weather");
  await h.settle();
  await h.pass(300);
  clock.skip(8_000);                         // an ordinary turn: longer than the 3 s a 'typing' is given to arrive
  h.finish.shift()();
  await a;
  assert.equal(h.sent.length, 1);
  assert.ok(!holds(h).some(l => l.at === "send"), "no wait at the send");
});

test("a 'typing' that Sendblue stamped before their newest text is that text, arriving late: it holds nothing", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const h = harness();
  const t0 = clock.now();
  ta.noteEvent({ address: KOFI, isTyping: true, sentAt: t0 - 5_000 });
  const p = h.router.deliver({ channel: "fake", externalId: "late-1", from: KOFI, text: "hello", at: t0 });
  await h.settle();
  clock.skip(100);
  ta.noteEvent({ address: KOFI, isTyping: true, sentAt: t0 - 400 });   // written before the text, delivered after it
  assert.equal(ta.isTyping(KOFI), true, "still the earlier state; the late one changed nothing");
  await h.pass(300);
  assert.equal(h.turns.length, 1, "the turn was not held for it");
  await h.pass(700);
  await p;
  assert.equal(h.sent.length, 1);
  assert.ok(!holds(h).some(l => l.typing_hold === "cap" || l.typing_hold === "more"));
});

// ---------- the webhook: verified, counted, observe-only ----------

const sign = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const typingBody = (on, who = KOFI) => JSON.stringify({ number: who, is_typing: on, from_number: LINE, timestamp: new Date(clock.now() - 120).toISOString() });

function sendblueRouter() {
  config.sendblueKeyId = "test-key-id"; config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE; config.sendblueWebhookSecret = SECRET; config.sendblueWebhookSecretHeader = "sb-signing-secret";
  const logs = [], asked = [];
  const router = new Router({ log: (e) => logs.push(e), timers: { set: (fn) => { fn(); return {}; }, clear: () => {} } });
  router.runtime = new Runtime({ log: () => {}, channels: router, runTurn: async () => "ok" });
  // Any call out to Sendblue is recorded: a typing webhook must never cause one.
  router.register(new SendblueChannel({ fetch: async (url) => { asked.push(String(url)); return { ok: false, status: 500, json: async () => ({}) }; } }));
  return { router, logs, asked };
}

test("a signed typing webhook is accepted, becomes memory-only state, and is not a turn or a log line", async () => {
  const { router, logs, asked } = sendblueRouter();
  const body = typingBody(true);
  const out = await router.webhook({ channel: "sendblue", rawBody: body, rawBytes: Buffer.from(body), headers: { "x-sendblue-signature": sign(body) } });
  assert.equal(out.status, 200);
  assert.equal(out.body.ignored, "typing_indicator");
  assert.equal(out.body.delivered, 0);
  assert.equal(ta.isTyping(KOFI), true);
  assert.equal(JSON.stringify(out).includes(KOFI), false, "the answer does not repeat who");
  assert.deepEqual(logs, [], "nothing is logged for one typing event");
  assert.deepEqual(asked, []);
  // The shared-secret header (what this account's deliveries carried before 2026-11-08) counts too.
  const stop = typingBody(false);
  const out2 = await router.webhook({ channel: "sendblue", rawBody: stop, rawBytes: Buffer.from(stop), headers: { "sb-signing-secret": SECRET } });
  assert.equal(out2.status, 200);
  assert.equal(ta.isTyping(KOFI), false);
});

test("an unsigned or forged typing webhook is refused and ignored: no state, and Sendblue is not asked", async () => {
  const { router, asked } = sendblueRouter();
  const body = typingBody(true);
  const cases = [
    {},                                                         // no header at all
    { "x-sendblue-signature": sign(body, "somebody-elses-secret") }, // signed with the wrong secret
    { "x-sendblue-signature": sign(typingBody(false)) },        // a real signature, for a different body
    { "sb-signing-secret": "a-guess" },
  ];
  for (const headers of cases) {
    const out = await router.webhook({ channel: "sendblue", rawBody: body, rawBytes: Buffer.from(body), headers });
    assert.equal(out.status, 401);
    assert.equal(ta.isTyping(KOFI), false, "a forged 'typing' holds nobody's reply");
  }
  assert.equal(ta.remembered(), 0);
  assert.deepEqual(asked, [], "there is no message to confirm, so no lookup is spent on it");
  assert.equal(ta.summary().refused, 4);
  assert.equal(ta.summary().events, 0);
});

test("on, a forged 'typing' does not delay a real reply", async () => {
  process.env.REASON_TYPING_AWARE = "on";
  const { router } = sendblueRouter();
  const h = harness();
  const body = typingBody(true);
  await router.webhook({ channel: "sendblue", rawBody: body, rawBytes: Buffer.from(body), headers: { "sb-signing-secret": "a-guess" } });
  const p = text(h, "forged-1", "hello");
  await h.settle();
  waitsWere(h.asked, [1_000]);
  await h.pass(1_000);
  await p;
  assert.equal(h.turns.length, 1);
  assert.equal(holds(h).length, 0, "the fixed pause and nothing more");
});

test("observe-only: with the switch off, verified events are counted and one line an hour says so, naming nobody", async () => {
  const { router, logs } = sendblueRouter();
  const post = async (on) => { const body = typingBody(on); return router.webhook({ channel: "sendblue", rawBody: body, rawBytes: Buffer.from(body), headers: { "x-sendblue-signature": sign(body) } }); };
  await post(true);
  clock.skip(4_000);
  ta.noteMessage({ address: KOFI });          // the text they were typing
  clock.skip(800);
  await post(true);                           // already typing the next one
  clock.skip(3_000);
  await post(false);                          // deleted it
  assert.deepEqual(logs, [], "inside the hour: nothing written");
  clock.skip(60 * 60_000);
  await post(true);                           // the first thing after the hour writes the line
  assert.equal(logs.length, 1);
  const line = logs[0];
  assert.equal(line.typing_aware, "off");
  assert.equal(line.events, 3);
  assert.equal(line.starts, 2);
  assert.equal(line.stops, 1);
  assert.equal(line.messages_after_typing, 1);
  assert.equal(line.typing_still_on_at_message, 1);
  near(line.median_typing_to_message_ms, 4_000);
  near(line.median_message_to_typing_ms, 800);
  near(line.median_event_lag_ms, 120);
  assert.equal(line.holds, 0, "observe-only: nothing was held");
  assert.ok(!JSON.stringify(line).includes("4155559876"));
  for (const v of Object.values(line)) assert.ok(v === null || typeof v === "number" || v === "off");
  // And it starts over: the next hour's line counts only that hour.
  assert.equal(ta.summary().events, 1);
});
