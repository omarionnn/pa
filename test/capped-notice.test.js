// The "done for today" line is said once a day, not once per text.
//
// Past their day's turns, Reason tells somebody it has hit its limit instead of going quiet. That
// line is a real outbound message on the shared Reason line, paid by the operator. Before this,
// every further text past the cap sent it again — N texts in, N "done for today" lines out —
// because each send minted its own random outbox key, so the outbox's "never twice" never applied.
// Now the line is keyed to the conversation and the day: once per day per person, and a new day
// (or a raised limit) tells them again.
//
// No API key, no network, no model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-capped-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_MAX_TURNS_PER_DAY = "1";

const accounts = await import("../src/accounts.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const KOFI = "+14155559876";
const DAY = 24 * 60 * 60 * 1000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.maxTurnsPerDay = 1;
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM usage; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: accounts.conversationIdFor({ channel: "fake", address: KOFI }), channel: "fake", address: KOFI, name: "Kofi" });
});

function harness() {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return null; } });
  const router = new Router({ runtime, log: () => {} });
  const channel = router.register(new FakeChannel({}));
  runtime.turnExtras.channels = router;
  return { router, channel, turns };
}

const texts = (body, id) => ({ channel: "fake", externalId: id, from: KOFI, text: body, at: clock.now() });
const cappedLines = (channel) => channel.sent.filter(m => m.to === KOFI && /done for today/.test(m.text ?? ""));
const cappedRows = () => db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE address = ? AND body LIKE '%done for today%'").get(KOFI).n;

test("five texts past the cap get one 'done for today' line, not five", async () => {
  const h = harness();
  const conv = accounts.conversationIdFor({ channel: "fake", address: KOFI });
  accounts.countUse(conv, "turn", 1); // their one turn for the day is used
  for (const id of ["a", "b", "c", "d", "e"]) {
    const r = await h.router.deliver(texts(`still there? ${id}`, id));
    assert.equal(r.capped, true, "every one of them is capped");
  }
  assert.equal(h.turns.length, 0, "no turn runs past the cap");
  assert.equal(cappedLines(h.channel).length, 1, "told once");
  assert.equal(cappedRows(), 1, "one outbox row, not one per text");
});

test("a new day, or a raised limit, tells them again", async () => {
  const h = harness();
  const conv = accounts.conversationIdFor({ channel: "fake", address: KOFI });
  accounts.countUse(conv, "turn", 1);
  await h.router.deliver(texts("hi", "a"));
  await h.router.deliver(texts("hi again", "b"));
  assert.equal(cappedLines(h.channel).length, 1);

  // Limit raised and used up again the same day: the line names a new number, so it is said.
  config.maxTurnsPerDay = 2;
  accounts.countUse(conv, "turn", 1);
  await h.router.deliver(texts("hello", "c"));
  await h.router.deliver(texts("hello?", "d"));
  assert.equal(cappedLines(h.channel).length, 2);

  // Tomorrow: the day's turns start over; used up again, they are told again, once.
  clock.skip(DAY);
  accounts.countUse(conv, "turn", 2);
  await h.router.deliver(texts("morning", "e"));
  await h.router.deliver(texts("morning?", "f"));
  assert.equal(cappedLines(h.channel).length, 3);
});
