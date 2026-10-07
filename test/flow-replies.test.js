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
const replies = await import("../src/replies.js");
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
  /** Several texts sent close together: each on record with its own handle, then ONE turn. */
  async function burst(...texts) {
    clock.skip(90_000);
    let last;
    for (const [handle, text] of texts) {
      clock.skip(1_500);
      db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
      last = handle;
    }
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: last });
    clock.skip(1_000);
    return await rt.inbound(C, [replies.burstLine(texts.length), ...texts.map(t => t[1])].join("\n"), {
      channel: "fake", to: OWNER, fromOwner: true, answering: { handle: last, texts: texts.length },
    });
  }
  return { rt, fake, says, burst };
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

test("two texts about different things: each gets its own answer, under its own text", { skip }, async () => {
  const { rt, fake, says, burst } = harness();
  try {
    await says("H-0", "hey");
    const before = fake.sent.length;
    await burst(["H-check", "whats 15% of 80"], ["H-how", "also how are you doing today"]);
    const mine = fake.sent.slice(before);
    const got = JSON.stringify(mine.map(m => ({ text: m.text, reply_to: m.reply_to ?? null })));
    assert.ok(mine.some(m => m.reply_to === "H-check"), `an answer went out under the first text (got ${got})`);
    assert.ok(mine.some(m => m.reply_to === "H-how"), `and one under the second (got ${got})`);
  } finally { await rt.shutdown(); }
});

test("two texts that are one thought get one ordinary reply", { skip }, async () => {
  const { rt, fake, says, burst } = harness();
  try {
    await says("H-0", "hey");
    const before = fake.sent.length;
    await burst(["H-a", "whats 15% of 80"], ["H-b", "sorry i meant 15% of 90"]);
    const mine = fake.sent.slice(before);
    const got = JSON.stringify(mine.map(m => ({ text: m.text, reply_to: m.reply_to ?? null })));
    assert.equal(mine.filter(m => m.reply_to).length, 0, `nothing was pinned (got ${got})`);
  } finally { await rt.shutdown(); }
});

test("a 'yeah' sent in a thread answers the question asked IN that thread, not the newest one asked elsewhere (2026-10-06)", { skip }, async (t) => {
  const { rt, fake } = harness();
  try {
    // The thread as it stood that night: two texts, two answers each pinned under its own text, and
    // both answers ending on a question. Then a "Yeah" in the first thread, which Sendblue reported
    // with the second answer as its parent.
    const life = "daily life in Ghana is warm, loud and social, with a few headaches you get used to. getting around is trotros or Bolt and Uber. want me to dig into what it'd actually take to live there from NY, like costs, visas and which neighborhoods?";
    const news = "just checked ghanaweb's homepage. the big ones right now: the Black Stars lost to The Gambia, and a guy arrested as a suspected phone thief swallowed five SIM cards. i only read the headlines, not the stories. want me to open one?";
    clock.skip(60_000);
    db.claimInbound({ channel: "fake", externalId: "H-live", conversationId: C, text: "Live there" });
    db.claimInbound({ channel: "fake", externalId: "H-web", conversationId: C, text: "Check Ghana web" });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: "H-web" });
    const router = rt.turnExtras.channels;
    await router.send({ channel: "fake", to: OWNER, text: life, conversationId: C, toOwner: true, replyTo: "H-live" });
    await router.send({ channel: "fake", to: OWNER, text: news, conversationId: C, toOwner: true, replyTo: "H-web" });
    const newsHandle = fake.sent.at(-1).message_id;
    db.saveConversation(C, [
      { role: "user", content: "Omari: Live there\nCheck Ghana web" },
      { role: "assistant", content: life },
      { role: "assistant", content: news },
    ]);
    clock.skip(40_000);
    db.claimInbound({ channel: "fake", externalId: "H-yeah", conversationId: C, text: "Yeah", replyTo: newsHandle, threadRoot: "H-live" });
    const note = replies.inboundReplyLine(C, newsHandle, "H-live", { except: "H-yeah" });
    assert.match(note, /thread under their message: "Live there"/);
    const before = fake.sent.length;
    await rt.inbound(C, `${note}\nYeah`, { channel: "fake", to: OWNER, fromOwner: true, answering: { handle: "H-yeah", texts: 1 } });
    const said = fake.sent.slice(before).map(m => m.text).join("\n");
    t.diagnostic(`reply: ${said.replace(/\s+/g, " ")}`);
    assert.ok(said.length, "it answered");
    assert.doesNotMatch(said, /which one|which story|which headline|sim card|black stars/i, `it did not go back to the news question (got: ${said})`);
    assert.match(said, /visa|cost|neighborhood|accra|rent|move|moving|live|living|dig/i, `it took the yes as a yes to digging in (got: ${said})`);
  } finally { await rt.shutdown(); }
});
