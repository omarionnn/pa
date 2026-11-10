// Reply threading with the real model (REASON_THREADING=owner): does it read what code hands it.
//
// The structure is proved offline in test/threading.test.js, and a late job result landing under
// the text that started it is code's (replies.latePin), proved offline in test/longtask.test.js.
// What needs a model is the judgement:
//
//   👍 on Reason's yes/no question  → acted on as a yes (the reminder is set), not ignored
//   ❤️ on something that asked nothing → nothing sent at all
//   two candidates that fit equally   → ONE short question naming both, nothing done
//   two texts that contradict          → the later one wins, and the reply says which it followed
//
// Asserts what happened (texts, timers), never exact wording. Skipped with no model reachable.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-threading-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_THREADING = "owner";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const outbox = await import("../src/outbox.js");
const { clock } = await import("../src/config.js");
const threading = await import("../src/threading.js");
const { skip } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM timers; DELETE FROM tasks;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function harness() {
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo, sendStyle }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo, sendStyle });
  });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: null });
  /** One text from them, recorded the way the router records it, then a turn. `frame` = code's lines. */
  async function says(handle, text, frame = "") {
    clock.skip(60_000);
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const reply = await rt.inbound(C, [frame, text].filter(Boolean).join("\n"), { channel: "fake", to: OWNER, fromOwner: true });
    if (process.env.FLOW_DEBUG) console.log("REPLY", handle, JSON.stringify(reply)?.slice(0, 300));
    await outbox.pass({ router, log: () => {} });
    return reply;
  }
  /** Something Reason said, on record as sent, as if an earlier turn had sent it. */
  async function reasonSaid(text) {
    clock.skip(60_000);
    await router.send({ channel: "fake", to: OWNER, text, conversationId: C, toOwner: true, idempotencyKey: `seed:${text.slice(0, 20)}` });
    await outbox.pass({ router, log: () => {} });
    // In the thread the model reads, as an earlier turn's reply would be.
    db.saveConversation(C, [...db.loadConversation(C), { role: "assistant", content: text }]);
  }
  return { rt, fake, says, reasonSaid };
}

const texts = (fake, from = 0) => fake.sent.slice(from).map(m => m.text);

test("a 👍 on Reason's yes/no question is a yes: the thing gets done", { skip }, async () => {
  const { rt, fake, says, reasonSaid } = harness();
  try {
    await says("H-1", "i need to call the dentist at some point today");
    await reasonSaid("want me to remind you at 4pm today to call the dentist?");
    const before = fake.sent.length;
    const timersBefore = db.listTimers(C).length;
    const raw = "Liked “want me to remind you at 4pm today to call the dentist?”";
    await says("T-like", raw, threading.reactionLine(C, raw, { self: "T-like" }));
    // A yes moves or sets the 4pm reminder (it may replace one it set a moment ago), and says so.
    const out = texts(fake, before);
    assert.ok(db.listTimers(C).length >= Math.max(1, timersBefore), `a reminder stands (texts: ${JSON.stringify(out)})`);
    assert.ok(out.length >= 1 && /4/.test(out.join(" ")), `it confirmed the 4pm reminder (got ${JSON.stringify(out)})`);
  } finally { await rt.shutdown(); }
});

test("a ❤️ on a message that asked nothing gets no reply at all", { skip }, async () => {
  const { rt, fake, says, reasonSaid } = harness();
  try {
    await says("H-1", "send me that pasta recipe again");
    await reasonSaid("here it is: cacio e pepe — pecorino, black pepper, pasta water, that's it. toast the pepper first.");
    const before = fake.sent.length;
    const raw = "Loved “here it is: cacio e pepe — pecorino, black pepper, pasta water, that's it. toast the pepper first.”";
    await says("T-love", raw, threading.reactionLine(C, raw, { self: "T-love" }));
    assert.deepEqual(texts(fake, before), [], "nothing was texted");
  } finally { await rt.shutdown(); }
});

test("two options that fit equally get one short question naming both, and nothing is done", { skip }, async () => {
  const { rt, fake, says, reasonSaid } = harness();
  try {
    // Seeded, not run: a turn here would go off and search, which is not what this is about.
    db.claimInbound({ channel: "fake", externalId: "H-1", conversationId: C, text: "find me nonstop flights jfk to lisbon on the 14th" });
    db.saveConversation(C, [{ role: "user", content: "find me nonstop flights jfk to lisbon on the 14th" }]);
    await reasonSaid("3 nonstops on the 14th:\n1. TAP 9:10am, $412\n2. United 9:40am, $398\n3. Delta 6:05pm, $371");
    const before = fake.sent.length;
    await says("H-2", "the morning one is good");
    const out = texts(fake, before);
    assert.equal(out.length, 1, `one message (got ${JSON.stringify(out)})`);
    assert.match(out[0], /\?/, "it is a question");
    assert.match(out[0], /tap|9:10/i, "naming the first morning flight");
    assert.match(out[0], /united|9:40/i, "and the second");
  } finally { await rt.shutdown(); }
});

test("two texts that contradict: the later wins and the reply says which it went with", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    const before = fake.sent.length;
    const timersBefore = db.listTimers(C).length;
    await says("H-1", "remind me to take the trash out at 7pm tonight\nactually make it 9pm", "[they sent the following as 2 separate texts in a row. if they are about different things, give each its own answer under its own text: reply_to + message_send for each earlier one, then your reply for the last. if they are one thought, answer once]");
    const made = db.listTimers(C).slice(timersBefore);
    assert.equal(made.length, 1, `one reminder, not two (got ${made.length}; texts ${JSON.stringify(texts(fake, before))})`);
    const out = texts(fake, before).join(" ");
    assert.match(out, /9/, `the reply names the time it went with (got ${JSON.stringify(out)})`);
    assert.doesNotMatch(out, /7 ?pm.*(set|reminder)/i, "and not the overridden one as if it stood");
  } finally { await rt.shutdown(); }
});
