// Inline replies with the real model: does it leave an ordinary reply alone, and when it does pin
// one, does quoting a message actually find it. The plumbing is proved offline in replies.test.js;
// what needs the model is whether the tool is usable by it. Asserts which message a reply went out
// under, never wording. Skipped with no model reachable (no API key, no claude-cli backend).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-replies-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM timers; DELETE FROM plans;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A real runtime on a fake iMessage thread, with replies sent the way serve.js sends them. */
function harness() {
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  /** One text from them, arriving the way the router records it: handle, words, then a turn. */
  async function says(handle, text) {
    clock.skip(90_000);
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    return await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
  }
  return { rt, fake, says };
}

test("an ordinary back-and-forth is never pinned under anything", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-1", "my flight to accra is on the 14th at 9pm, remember that");
    await says("H-2", "whats 15% of 80");
    assert.ok(fake.sent.length >= 2, "both were answered");
    for (const m of fake.sent) assert.equal(m.reply_to, undefined, `"${m.text}" went as a normal message`);
  } finally { await rt.shutdown(); }
});

test("asked to answer under an earlier message, it pins the reply under that one", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-flight", "my flight to accra is on the 14th at 9pm, remember that");
    await says("H-hotel", "and the hotel is the kempinski");
    await says("H-math", "whats 15% of 80");
    const before = fake.sent.length;
    await says("H-ask", "reply under my flight message with the day and time so i can find it later");
    const mine = fake.sent.slice(before);
    assert.ok(mine.length >= 1, "it answered");
    assert.ok(mine.some(m => m.reply_to === "H-flight"), `a reply went out under the flight message (got ${JSON.stringify(mine.map(m => ({ text: m.text, reply_to: m.reply_to ?? null })))})`);
    assert.equal(mine.filter(m => m.reply_to).length, 1, "and only one message was pinned");
  } finally { await rt.shutdown(); }
});
