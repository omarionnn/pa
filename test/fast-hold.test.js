// REASON_FAST_REPLY §7: a text waits 0.3 s for the rest of its thought, not 1 s.
//
// The window exists to catch one thought sent as several bubbles. On live (11-08 → 11-12, ~180
// turns at 1 s) it joined one burst; 14 late texts were folded into the running turn instead, which
// is what really catches them (src/onethought.js). This file pins the shorter window and that a
// second text landing AFTER it is still one turn and one reply.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-fast-hold-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.REASON_BURST_QUIET_FAST_MS;

const { Runtime } = await import("../src/runtime.js");
const { Router, quietWindowFor } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const { WEB } = await import("../src/web.js");
const db = await import("../src/db.js");
const onethought = await import("../src/onethought.js");
const said = await import("../src/said.js");
const { config, clock } = await import("../src/config.js");
const DEFAULT_FAST_MS = config.burstQuietFastMs;

const OWNER = "+12025551234";
const C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";

after(() => { delete process.env.REASON_FAST_REPLY; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  db.db.exec(`DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM outbox; DELETE FROM requests; DELETE FROM request_messages;
    DELETE FROM open_questions; DELETE FROM sent_claims;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  process.env.REASON_FAST_REPLY = "on";
  config.burstQuietMs = 1_000;      // what live runs with
  config.burstQuietWebMs = 500;
  config.burstQuietFastMs = 300;
  config.burstMaxMs = 10_000;
  onethought.setMidTurnReader(null);
  said.setRecorder(null);
  said.setChecker(null);
});

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function until(pred, what, ms = 4_000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await tick(); }
}
function gate() { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open: () => open() }; }

/** The real router and runtime on a fake iMessage thread; `script` is the model (test/onethought.test.js). */
function harness(script) {
  const turns = [], logs = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (args) => {
      turns.push({ ...args, startedAt: Date.now() });
      const reply = await script(args, turns.length);
      db.saveConversation(args.conversationId, [...db.loadConversation(args.conversationId),
        { role: "user", content: `[now] Omari: ${args.keep ?? args.text}` }, { role: "assistant", content: reply ?? "NO_REPLY" }]);
      return reply;
    },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  return { runtime, router, fake, turns, logs };
}
let n = 0;
const text = (t) => ({ channel: "fake", externalId: `FH-${++n}`, from: OWNER, text: t, chatId: null, service: "iMessage" });
const lookUp = (args) => runTool("request_done", { id: -1 }, { conversationId: args.conversationId, foldToken: args.foldToken });

const WORK = "No I want to watch when I leave work so somewhere around work";
const TUESDAY = "And I'd watch it on Tuesday";

test("the shorter hold is its own switch: unset (the default), the window is the configured one even with REASON_FAST_REPLY on", () => {
  config.burstQuietFastMs = DEFAULT_FAST_MS;
  assert.equal(DEFAULT_FAST_MS, null, "unset by default");
  assert.equal(quietWindowFor("fake", { conversationId: C, isOperator: true }), 1_000);
  assert.equal(quietWindowFor("sendblue", { conversationId: KOFI_C }), 1_000);
  assert.equal(quietWindowFor(WEB, { conversationId: C }), 500);
});

test("the window, once a shorter one is set: 0.3 s where the switch reaches, the configured one elsewhere, never longer than it, and off stays off", () => {
  assert.equal(quietWindowFor("fake", { conversationId: C, isOperator: true }), 300);
  assert.equal(quietWindowFor("sendblue", { conversationId: KOFI_C }), 300, "on is everyone");
  assert.equal(quietWindowFor(WEB, { conversationId: C }), 300, "a Web message never waits longer than a text");
  process.env.REASON_FAST_REPLY = "owner";
  assert.equal(quietWindowFor("fake", { conversationId: C, isOperator: true }), 300);
  assert.equal(quietWindowFor("fake", { conversationId: KOFI_C, isOperator: false }), 1_000, "owner: only the operator's thread");
  process.env.REASON_FAST_REPLY = "off";
  assert.equal(quietWindowFor("fake", { conversationId: C, isOperator: true }), 1_000);
  assert.equal(quietWindowFor(WEB, { conversationId: C }), 500);
  process.env.REASON_FAST_REPLY = "on";
  assert.equal(quietWindowFor("fake"), 1_000, "a caller that names nobody gets the configured window");
  config.burstQuietMs = 0;
  assert.equal(quietWindowFor("fake", { conversationId: C }), 0, "REASON_BURST_QUIET_MS=0 still turns holding off");
  config.burstQuietMs = 200;
  assert.equal(quietWindowFor("fake", { conversationId: C }), 200, "never longer than the configured window");
});

test("a text is held 0.3 s from its arrival, and its turn starts then, not a second later", async () => {
  const h = harness(async (args) => `re: ${args.text}`);
  const t0 = Date.now();
  const sending = h.router.deliver(text("what time is the game"));
  await until(() => db.countPendingInbound(C) === 1, "the text to be held");
  const ready = db.pendingReadyAt(C);
  assert.ok(ready >= clock.now() - 50 && ready <= t0 + 300 + 250, `ready 0.3 s after it landed (${ready - t0} ms)`);
  await sending;
  assert.equal(h.turns.length, 1);
  const waited = h.turns[0].startedAt - t0;
  assert.ok(waited >= 250 && waited < 900, `the turn started ${waited} ms after the text, inside the old 1 s window`);
  assert.equal(h.fake.sent.length, 1);
});

test("a second text inside 0.3 s still joins the first before any work starts: one turn with both", async () => {
  const h = harness(async (args) => `showtimes for: ${String(args.text).replace(/^\[they sent the following as \d+ separate texts[^\n]*\]\n/, "").replace(/\n/g, " + ")}`);
  const first = h.router.deliver(text(WORK));
  await tick(60);
  const second = await h.router.deliver(text(TUESDAY));
  assert.equal(second.joined, true);
  await first;
  assert.equal(h.turns.length, 1, "one turn");
  assert.equal(h.fake.sent.length, 1, "one reply");
  assert.match(h.fake.sent[0].text, /around work \+ And I'd watch it on Tuesday/);
});

test("a second text that lands AFTER the 0.3 s hold, while the first is being answered, is folded into the running turn: one reply, never a second one", async () => {
  onethought.setMidTurnReader(({ text: t }) => (t === TUESDAY ? "continuation" : "new"));
  const g = gate();
  const h = harness(async (args) => {
    await g.wait();
    // Still working: the next tool result carries what they just added.
    const r = await lookUp(args);
    const day = r.NEW_FROM_THEM?.includes("Tuesday") ? "Tuesday" : "Monday";
    return `Alamo Lower Manhattan, closest to work: earliest ${day} showing 11:00am`;
  });
  const t0 = Date.now();
  const first = h.router.deliver(text(WORK));
  await until(() => h.turns.length === 1, "the first turn to start");
  // 0.7 s after the first bubble: inside the old 1 s window, outside the new one. The turn is running.
  await tick(Math.max(0, 700 - (Date.now() - t0)));
  assert.ok(Date.now() - t0 >= 600 && h.turns.length === 1);
  const second = await h.router.deliver(text(TUESDAY));
  assert.equal(second.joined, true, "it joins the running request rather than queueing a turn of its own");
  await until(() => h.logs.some(l => l.folded), "the second text to be folded in");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C), "the request to finish");

  assert.equal(h.turns.length, 1, "no second turn for the second bubble");
  assert.equal(h.fake.sent.length, 1, "exactly one reply");
  assert.match(h.fake.sent[0].text, /Tuesday/, "and it answers both bubbles");
  assert.equal(db.countPendingInbound(C), 0, "nothing left to answer separately");
  assert.ok(h.logs.some(l => l.midturn === "continuation"));
  assert.ok(db.loadConversation(C).some(m => m.role === "user" && String(m.content).endsWith(TUESDAY)), "their second line is in the thread");
});

test("a second text after the hold AND after the last tool call: the stale draft is never sent, the turn answers again with both", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  const h = harness(async (args, k) => {
    if (k === 1) { await g.wait(); return "Monday 11:15am at Bay Plaza"; }
    return `Tuesday 11:00am at Alamo (${/Tuesday/.test(args.text) ? "with what they added" : "without"})`;
  });
  const first = h.router.deliver(text(WORK));
  await until(() => h.turns.length === 1, "the first turn to start");
  await tick(400);
  await h.router.deliver(text(TUESDAY));
  await until(() => h.logs.some(l => l.folded), "the fold");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C), "the request to finish");
  assert.equal(h.fake.sent.length, 1, "one reply");
  assert.match(h.fake.sent[0].text, /Tuesday 11:00am at Alamo \(with what they added\)/);
  assert.ok(!h.fake.sent.some(s => /Monday 11:15am/.test(s.text)), "the draft written before the second bubble never went");
});
