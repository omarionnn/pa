// The quiet window a message waits in before its turn starts (speed audit 2026-10-27, item 2).
//
// 2.5 s for a text (was 4 s from 10-24 to 10-28), half a second for a Reason Web message, which the
// composer sends whole. A second text inside the window still joins the first one's turn, and a
// bubble that lands after the turn has started still folds in — that path (src/onethought.js) is
// untouched here and proved elsewhere (test/onethought*.test.js); this file pins the window itself.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-burst-window-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_WEB = "on";
// The defaults are what this file is about: nothing here sets REASON_BURST_QUIET_MS.
delete process.env.REASON_BURST_QUIET_MS;
delete process.env.REASON_BURST_QUIET_WEB_MS;

const { Router, quietWindowFor } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { WEB } = await import("../src/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876";
const KOFI_C = `dm:fake:${KOFI}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  config.burstQuietMs = 2_500;
  config.burstQuietWebMs = 500;
  db.db.exec(`DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM requests;`);
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
});

/** serve.js's wiring, with the window's wait on a hand-held timer: nothing runs until `release()`. */
function harness() {
  const logs = [], turns = [], waits = [];
  const timers = { set: (fn) => { waits.push(fn); return { unref() {} }; }, clear: () => {} };
  const router = new Router({ log: (e) => logs.push(e), timers });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => { turns.push(args); return `re: ${args.text}`; } });
  router.runtime = runtime;
  router.register(consoleChannel);
  router.register(new FakeChannel({ number: "+16562167455" }));
  router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  const release = async (ms) => { clock.skip(ms); for (const fn of waits.splice(0)) fn(); await new Promise(r => setTimeout(r, 20)); };
  return { router, runtime, logs, turns, release };
}

const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const text = (h, id, body) => h.router.deliver({ channel: "fake", externalId: id, from: KOFI, text: body, at: clock.now() });

test("the defaults: 2.5 s for a text, half a second for a Web message, never longer than the text window", () => {
  assert.equal(config.burstQuietMs, 2_500);
  assert.equal(config.burstQuietWebMs, 500);
  assert.equal(quietWindowFor("fake"), 2_500);
  assert.equal(quietWindowFor("sendblue"), 2_500);
  assert.equal(quietWindowFor(WEB), 500);
  // Holding switched off is off everywhere.
  config.burstQuietMs = 0;
  assert.equal(quietWindowFor(WEB), 0);
  // A test (or an operator) that widens the text window to hold everything holds Web too, by the Web window.
  config.burstQuietMs = 60_000;
  assert.equal(quietWindowFor(WEB), 500);
  assert.equal(quietWindowFor("fake"), 60_000);
});

test("a text is held 2.5 s from its arrival, and a second text inside the window joins its turn", async () => {
  const h = harness();
  const t0 = clock.now();
  const first = text(h, "b-1", "can you check");
  assert.ok(await until(() => db.countPendingInbound(KOFI_C) === 1));
  // The clock runs real time until it is skipped, so a few ms pass between the send and the hold.
  const near = (actual, expected, what) => assert.ok(actual >= expected && actual < expected + 200, `${what}: ${actual - expected} ms off`);
  near(db.pendingReadyAt(KOFI_C), t0 + 2_500, "ready 2.5 s after the text landed");
  // The second bubble, 1.8 s later: joins, and pushes the window out from ITS arrival.
  clock.skip(1_800);
  const second = await text(h, "b-2", "the 7:30 at peaches");
  assert.equal(second.joined, true, "the second text joined the first one's wait");
  assert.equal(db.countPendingInbound(KOFI_C), 2);
  near(db.pendingReadyAt(KOFI_C), t0 + 1_800 + 2_500, "the window restarts from the second text");
  await h.release(2_600);
  await first;
  assert.ok(await until(() => h.turns.length === 1), "one turn for the burst");
  assert.match(h.turns[0].text, /can you check/);
  assert.match(h.turns[0].text, /the 7:30 at peaches/);
  assert.ok(h.logs.some(e => e.joined_burst === KOFI_C), "logged as a joined burst");
});

test("a Web message is held only half a second", async () => {
  const h = harness();
  const t0 = clock.now();
  const sending = h.router.deliver({ channel: WEB, externalId: "w-1", conversationId: KOFI_C, text: "book the 7:30 at peaches", at: clock.now() });
  assert.ok(await until(() => db.countPendingInbound(KOFI_C) === 1));
  const ready = db.pendingReadyAt(KOFI_C);
  assert.ok(ready >= t0 + 500 && ready < t0 + 700, `a Web message waits 0.5 s, not 2.5 (${ready - t0} ms)`);
  await h.release(600);
  await sending;
  assert.ok(await until(() => h.turns.length === 1));
  assert.equal(h.turns[0].text, "book the 7:30 at peaches");
});
