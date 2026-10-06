// Tapbacks and effects with the real model: does it actually use them the way the prompt says.
//
// The plumbing and every guard are proved offline in test/tapbacks.test.js; what needs a model is
// the judgement, because the judgement is the feature. Three things, and they are the three ways
// this can be worse than not having it:
//
//   "thanks 🙏" — a reaction and NO text, because a text there is filler
//   a question  — never a tapback on its own, whatever the mood of the message
//   a real moment — words that stand on their own, with an effect on them
//
// Asserts what went out (a reaction, a text, a send_style), never wording. Skipped with no model
// reachable (no API key, no claude-cli backend).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-tapbacks-"));
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
const outbox = await import("../src/outbox.js");
const { clock } = await import("../src/config.js");
const { skip } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM timers; DELETE FROM plans; DELETE FROM action_ledger; DELETE FROM channel_limits;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A real runtime on a fake iMessage thread, with replies sent the way serve.js sends them. */
function harness() {
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo, sendStyle }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo, sendStyle });
  });
  /** One text from them, arriving the way the router records it: handle, words, then a turn. */
  async function says(handle, text) {
    clock.skip(90_000);
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    await outbox.pass({ router, log: () => {} });
    return reply;
  }
  return { rt, fake, says };
}

/** What actually left, in the one shape these assertions care about. */
const what = (fake) => JSON.stringify({
  texts: fake.sent.map(m => m.text),
  tapbacks: fake.reactCalls.map(r => `${r.reaction} on ${r.messageHandle}`),
});

test("a bare thank-you gets a tapback and no text at all", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-ask", "can u find somewhere for dinner friday");
    await says("H-pick", "carbone works, book it for 8");
    const before = { texts: fake.sent.length, taps: fake.reactCalls.length };
    await says("H-thanks", "thanks 🙏");

    const taps = fake.reactCalls.slice(before.taps);
    const texts = fake.sent.slice(before.texts);
    assert.equal(taps.length, 1, `one tapback went on the thank-you (got ${what(fake)})`);
    assert.equal(taps[0].messageHandle, "H-thanks", "on the message they just sent");
    assert.equal(texts.length, 0, `and nothing was texted (got ${JSON.stringify(texts.map(t => t.text))})`);
  } finally { await rt.shutdown(); }
});

test("a question never gets a tapback on its own — the words go, whatever else happens", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-hi", "yo");
    const before = { texts: fake.sent.length, taps: fake.reactCalls.length };
    await says("H-q", "whats 15% of 80");

    const texts = fake.sent.slice(before.texts);
    assert.ok(texts.length >= 1, `the question was answered in words (got ${what(fake)})`);
    // A tapback alongside the answer is allowed and is not what this is about; a tapback INSTEAD of
    // the answer is the bug, and that is what "texts.length >= 1" pins down. The ledger says which
    // way round it happened when one did go on.
    const held = db.listActions(C, { limit: 20 }).filter(a => a.action === "react" && /^Held a/.test(a.receipt));
    const onQuestion = fake.reactCalls.slice(before.taps);
    if (onQuestion.length) {
      assert.equal(held.length >= 1, true, `a tapback on a question only ever rides out behind words (ledger: ${JSON.stringify(db.listActions(C, { limit: 20 }).map(a => a.receipt))})`);
    }
  } finally { await rt.shutdown(); }
});

test("told something is done, it marks the moment with an effect on a message that stands on its own", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-ctx", "been trying to get this apartment application through for like 3 weeks");
    const before = fake.sent.length;
    await says("H-done", "they approved it!! i got the apartment 🎉");
    const mine = fake.sent.slice(before);
    assert.ok(mine.length >= 1, `it said something (got ${what(fake)})`);
    assert.ok(
      mine.some(m => m.send_style),
      `one of those carried a screen effect (got ${JSON.stringify(mine.map(m => ({ text: m.text, style: m.send_style ?? null })))})`,
    );
    // The effect plays on open, so the words cannot be a pointer at the animation.
    for (const m of mine) assert.ok(!/watch this|hold on for|wait for it/i.test(m.text), `"${m.text}" does not point at the effect`);
  } finally { await rt.shutdown(); }
});

test("an ordinary back-and-forth gets no effects at all", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-1", "whats the weather like for friday");
    await says("H-2", "cool");
    for (const m of fake.sent) {
      assert.equal(m.send_style, undefined, `"${m.text}" went out plain`);
    }
  } finally { await rt.shutdown(); }
});
