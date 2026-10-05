// Reason's voice with the real model: asked for a voice note it sends one, and an ordinary question
// still gets text. The speech itself is a local stand-in for Gemini, so nothing is paid for and the
// rate limit is not touched; what needs the model is the judgement about WHEN to speak. Asserts
// what went out, never wording. Skipped with no model reachable, or no audio converter.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-voice-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_AUDIO_TMP = join(dir, "audio");
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
const { findConverter } = await import("../src/expressive.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const live = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const skip = live.skip || !findConverter();

// A stand-in speech model: two seconds of silence for anything it is asked to say.
let speech;
const asked = [];
before(async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      asked.push(JSON.parse(body).contents[0].parts[0].text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: Buffer.alloc(96_000).toString("base64") } }] } }] }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  speech = server;
  config.geminiKey = "stand-in";
  config.geminiBase = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => speech.close(r)); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  asked.length = 0;
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: "H-1" });
});

function harness() {
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true });
  });
  return { rt, fake, says: (text) => rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true }) };
}

test("asked for a voice note, it sends one — and does not text the same words as well", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("send me a voice note wishing me luck for my interview today");
    const notes = fake.sent.filter(m => m.media);
    assert.equal(notes.length, 1, `one voice note went out (got ${JSON.stringify(fake.sent.map(m => ({ text: m.text, media: !!m.media })))})`);
    assert.equal(notes[0].media.mimeType, "audio/x-caf");
    assert.equal(notes[0].to, OWNER);
    assert.equal(asked.length, 1, "and it was spoken once");
    assert.ok(asked[0].length > 10, "with real words in it");
    assert.doesNotMatch(asked[0], /https?:\/\//, "no links read aloud");
    for (const t of fake.sent.filter(m => !m.media)) assert.notEqual(t.text.trim(), asked[0].trim(), "the spoken words were not also sent as text");
  } finally { await rt.shutdown(); }
});

test("an ordinary question is still answered in text", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("whats 15% of 80");
    assert.equal(fake.sent.filter(m => m.media).length, 0, "no voice note for an ordinary answer");
    assert.equal(asked.length, 0);
    assert.ok(fake.sent.some(m => m.text), "it answered in words");
  } finally { await rt.shutdown(); }
});
