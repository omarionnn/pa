// Over the hourly sign-up ceiling, the owner decides (owner rule, 2026-11-10).
//
// With auto-admit on, the first `signupsPerHour` new numbers in an hour get in on their own. The next
// one must not: it is put to the owner over text, through the same router path a real text takes,
// and only the owner's yes lets them in — with a "you're in" text to them. A no lets nobody in.
// Proven end to end through the Router with a fake channel and a stated judge: no network, no model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-overcap-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_MAX_REQUESTS_PER_HOUR = "100";
process.env.REASON_MAX_REQUESTS_PER_DAY = "100";
delete process.env.REASON_BACKEND;

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
let n = 0;
const newNumber = () => `+1347555${String(1000 + (n++)).slice(-4)}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.backend = "claude-cli";
  config.autoAdmit = true;
  config.signupsPerHour = 2;
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function harness(verdict) {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId }) => { turns.push(conversationId); return "ok"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict }), log: () => {} });
  const channel = router.register(new FakeChannel({}));
  runtime.turnExtras.channels = router;
  return { router, channel, turns };
}
const texts = (h, from, text) => h.router.deliver({ channel: "fake", externalId: String(Math.random()), from, text, at: clock.now() });
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to);

async function fillTheHour(h) {
  for (let i = 0; i < config.signupsPerHour; i++) await texts(h, newNumber(), "hey");
  assert.equal(sentTo(h, MASTER).filter(m => /texted me for the first time/.test(m.text)).length, 0, "under the ceiling the owner is not asked");
}

test("over the hourly ceiling a first text asks the owner; the owner's yes lets them in and texts them they're in", async () => {
  const h = harness("yes");
  await fillTheHour(h);
  const late = newNumber();
  await texts(h, late, "hi is this reason?");

  const asked = sentTo(h, MASTER).filter(m => m.text.includes(late));
  assert.equal(asked.length, 1, "the owner's own Reason texts him about the over-ceiling number");
  assert.match(asked[0].text, /just texted me for the first time/);
  assert.match(asked[0].text, /want me to set them up/);
  assert.match(sentTo(h, late)[0].text, /you're on the list/);
  assert.equal(db.getAccount(`dm:fake:${late}`), null, "no account before the owner answers");

  await texts(h, MASTER, "yes let them in");
  assert.ok(db.getAccount(`dm:fake:${late}`), "the owner's yes made their account");
  assert.ok(sentTo(h, late).some(m => /^you're in\./.test(m.text)), "and they were texted they're in");
});

test("over the ceiling the owner's no lets nobody in", async () => {
  const h = harness("no");
  await fillTheHour(h);
  const late = newNumber();
  await texts(h, late, "hello");
  await texts(h, MASTER, "no");
  assert.equal(db.getAccount(`dm:fake:${late}`), null);
  assert.ok(!sentTo(h, late).some(m => /^you.re in\./.test(m.text)), "no you-are-in text");
});
