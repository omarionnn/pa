// NO_REPLY is how the model says "stay silent". It must never reach a person — not when it is the
// whole reply (readSilence, #43), not on a trailing line (#265), and not when it sits on a MIDDLE
// line or inside a sentence, which every outbound path below used to send as written.
//
//   the ordinary reply to something they texted                       (marker off)
//   a reply pinned under one of their messages (thread reply)         (marker off)
//   a reply that goes out as several bubbles (link split)             (marker off in each)
//   message_send                                                      (marker off)
//   a caption on a file, and on a file by address                     (marker off, file still goes)
//   a reply to someone on Reason Web, and the history row it becomes  (marker off)
//   a reminder firing on a timer                                      (marker off)
//   a reply that is only markers once read                            (nothing goes, nothing retries)
//
// Every assertion is on what the channel was handed. No model, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-noreply-midtext-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const CONV = "dm:owner";
const PICTURE = join(dir, "picture.png");
writeFileSync(PICTURE, Buffer.alloc(2048, 1));

const MIDDLE_LINE = "on it, checking the times now\nNO_REPLY\nback with the list in ten";
const MID_SENTENCE = "on it NO_REPLY, checking the times now";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

/** The server's own wiring: a real Runtime, a router, and the deliver function serve.js uses. */
function harness({ turn = async () => "ok" } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: turn, channels: router, deliver });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  return { runtime, router, fake, deliver, logs };
}

const noMarker = (texts) => {
  assert.ok(texts.length > 0, "something went out");
  for (const t of texts) assert.ok(!String(t).includes("NO_REPLY"), `the marker reached the channel: ${JSON.stringify(t)}`);
};

test("the ordinary reply: a marker on a middle line or mid-sentence never reaches the phone", async () => {
  for (const [reply, want] of [[MIDDLE_LINE, "on it, checking the times now\nback with the list in ten"], [MID_SENTENCE, "on it, checking the times now"]]) {
    const { runtime, fake } = harness({ turn: async () => reply });
    await runtime.inbound(CONV, "what time does the gym close");
    noMarker(fake.sent.map(m => m.text));
    assert.equal(fake.sent.at(-1).text, want);
  }
});

test("a thread reply pinned under their message goes without the marker, still pinned", async () => {
  const { deliver, fake } = harness();
  const r = await deliver({ conversationId: CONV, text: MID_SENTENCE, media: null, fromOwner: true, replyTo: "msg-41" });
  assert.equal(r.ok, true);
  noMarker(fake.sent.map(m => m.text));
  assert.equal(fake.sent[0].reply_to, "msg-41");
});

test("a reply split into several bubbles carries the marker in none of them", async () => {
  const { deliver, fake } = harness();
  const r = await deliver({ conversationId: CONV, text: "here's the menu https://example.com/menu\n\nNO_REPLY\n\nthe soup is the move NO_REPLY", media: null, fromOwner: true });
  assert.equal(r.ok, true);
  assert.ok(fake.sent.length > 1, "it really was several bubbles");
  noMarker(fake.sent.map(m => m.text));
});

test("message_send: a marker in the middle of the text is taken off before it goes", async () => {
  const { router, fake } = harness();
  await router.deliver({ channel: "fake", externalId: "e-mid", from: OWNER, text: "hi", chatId: "chat-1", at: clock.now() });
  const before = fake.sent.length;
  const out = await runTool("message_send", { to: "owner", text: "booked for 7\nNO_REPLY\nsee you there" }, { conversationId: config.ownerConversation, channels: router });
  assert.equal(out.ok, true);
  const mine = fake.sent.slice(before).map(m => m.text);
  noMarker(mine);
  assert.equal(mine.at(-1), "booked for 7\nsee you there");
});

test("a caption on a file, and on a file by address, loses the marker and the file still goes", async () => {
  const { router, fake } = harness();
  const a = await router.sendMedia({ channel: "fake", to: OWNER, text: "the poster NO_REPLY you asked for", file: PICTURE, mimeType: "image/png", conversationId: CONV, toOwner: true });
  assert.equal(a.ok, true);
  const b = await router.sendMediaUrl({ channel: "fake", to: OWNER, text: "**NO_REPLY** the card", mediaUrl: "https://example.com/card.vcf" });
  assert.equal(b.ok, true);
  assert.equal(fake.sent.length, 2, "both files went");
  noMarker(fake.sent.map(m => m.text));
  assert.equal(fake.sent[0].text, "the poster you asked for");
  assert.equal(fake.sent[1].text, "the card");
});

test("a reply on Reason Web: neither the tab nor the history row it becomes carries the marker", async () => {
  const { router, deliver } = harness();
  const web = router.register(new WebChannel());
  const seen = [];
  web.events.on("message", (m) => seen.push(m.text));
  db.upsertThread({ conversationId: CONV, channel: "web", address: OWNER, isOwner: true });
  const r = await deliver({ conversationId: CONV, text: MIDDLE_LINE, media: null, fromOwner: true, channel: "web", to: OWNER });
  assert.equal(r.ok, true);
  noMarker(seen);
  const history = db.messagesFor(CONV).filter(m => m.role === "assistant").map(m => m.text);
  noMarker(history);
});

test("a reminder firing on a timer goes without the marker", async () => {
  const { runtime, fake } = harness({ turn: async () => "gua sha time ✨ NO_REPLY\nNO_REPLY\nten minutes, then bed" });
  db.createTimer(CONV, { fireAt: clock.now() + 1_000, note: "daily gua sha reminder" });
  clock.skip(2_000);
  assert.equal(await runtime.tick(), 1);
  noMarker(fake.sent.map(m => m.text));
  assert.equal(fake.sent[0].text, "gua sha time ✨\nten minutes, then bed");
});

test("a reply that is nothing but markers once read sends nothing, and a reminder is not retried for it", async () => {
  const { runtime, deliver, fake, logs } = harness({ turn: async () => "NO_REPLY NO_REPLY" });
  const r = await deliver({ conversationId: CONV, text: "**NO_REPLY** — NO_REPLY", media: null, fromOwner: true });
  assert.equal(r.ok, false);
  assert.equal(r.silent, true);
  db.createTimer(CONV, { fireAt: clock.now() + 1_000, note: "nothing worth saying" });
  clock.skip(2_000);
  await runtime.tick();
  assert.equal(fake.sent.length, 0, "nothing went out");
  assert.ok(!logs.some(l => JSON.stringify(l).includes("could not be handed over")), "the reminder is not treated as a failed send");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0, "no row was written for it");
});

test("every strip is a log line naming the path, never the message", async () => {
  const { deliver, logs } = harness();
  await deliver({ conversationId: CONV, text: MID_SENTENCE, media: null, fromOwner: true });
  const lines = logs.filter(l => l.no_reply_stripped);
  assert.ok(lines.length >= 1);
  assert.equal(lines[0].no_reply_stripped, "reply");
  for (const l of lines) assert.ok(!JSON.stringify(l).includes("checking the times"), "no message content in the log");
});
