// A held-back reply is logged by its length, never by its words (src/runtime.js, `heldBack`).
//
// The log line used to carry `said: reply.slice(0, 120)`: the first 120 characters of a reply that
// was never sent, which is somebody's conversation written into a server log. These pin that the
// line still happens (so "why did it go quiet" is answerable) and that nothing of the reply is in it.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-log-no-content-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const CONV = "dm:owner";
// Words that would only be in a log line if the reply itself were copied into it.
const REPLY = "your test results from dr. mensah came back, the biopsy on the 14th was clear";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

function harness() {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async () => REPLY, channels: router, deliver });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  return { runtime, fake, logs };
}

test("a reply held back by shouldSend is logged with its length and no word of it", async () => {
  const { runtime, fake, logs } = harness();
  await runtime._turn({ conversationId: CONV, text: "[sweep] anything new?", kind: "sweep", shouldSend: () => false });
  assert.equal(fake.sent.length, 0, "held back means nothing went out");
  const line = logs.find(l => l && Object.hasOwn(l, "held_back"));
  assert.ok(line, `a held_back line was written: ${logs.map(l => Object.keys(l ?? {})[0]).join(", ")}`);
  const all = JSON.stringify(logs);
  for (const piece of ["biopsy", "mensah", "test results", REPLY.slice(0, 20)]) {
    assert.ok(!all.includes(piece), `the reply's words are in the log: ${piece}`);
  }
  assert.equal(line.chars, REPLY.length, "how long it was is still there to read");
  assert.equal(line.conversation, CONV);
});
