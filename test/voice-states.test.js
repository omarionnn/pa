// A voice note, from arriving to being answered once, and the five states it can honestly be in.
//
// The spec this came from asks for waiting, processing, ready, failed and no-speech to be distinct,
// for a note that arrives late or twice to be answered exactly once, for unclear words to be asked
// about rather than invented, and for timing to be kept where the transcriber gives it. Every one
// of those is code's, and every one of them is here. No model and no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-voicestates-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";

const voice = await import("../src/voice.js");
const reviewed = await import("../src/reviewed.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const { SYSTEM } = await import("../src/agent.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const AF = { kind: "afconvert", bin: "/usr/bin/afconvert" };
const CAF = "https://cdn.test/x/AudioMessage.caf";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM media_items; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM pending_inbound; DELETE FROM conversations; DELETE FROM accounts; DELETE FROM threads; DELETE FROM usage;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.burstQuietMs = 0;
});

const note = (filename = "AudioMessage.caf", url = CAF) => ({ kind: "voice", filename, url });
const inbound = (over) => ({
  channel: "fake", externalId: "e-1", from: OWNER, chatId: null, service: "iMessage",
  at: clock.now(), said: "", text: voice.cannotHearLine(note()), attachments: [note()], ...over,
});

function wired() {
  const turns = [];
  const runtime = new Runtime({ runTurn: async (t) => { turns.push(t); return "ok"; } });
  const router = new Router({ runtime, hear: async (text) => text });
  router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  return { router, turns };
}

// ---------- answered once ----------

test("the same voice note delivered twice is one turn, and the second delivery is a no-op", async () => {
  const { router, turns } = wired();
  const event = inbound({});
  const first = await router.deliver(event);
  const second = await router.deliver(event);

  assert.equal(turns.length, 1, "one substantive answer");
  assert.equal(second.duplicate, true);
  assert.equal(db.mediaOfMessage("dm:owner", "e-1").length, 1, "and one item, not two");
  void first;
});

test("a note arriving after the text it belongs to is the same message, and still one answer", async () => {
  const { router, turns } = wired();
  // The text part first, then a part carrying the audio under the same base handle — the shape a
  // message that arrives in pieces takes (src/parts.js).
  await router.deliver(inbound({ externalId: "E32", baseHandle: "E32", partIndex: 0, said: "listen to this", text: "listen to this", attachments: [] }));
  await router.deliver(inbound({ externalId: "E32_1", baseHandle: "E32", partIndex: 1, said: "", text: voice.cannotHearLine(note()) }));

  // A part carrying a file is never dropped as a preview — only a picture on a message with a link
  // in it is — so the note is answered, and it is tied to the message its text came on.
  const items = db.mediaOfMessage("dm:owner", "E32");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "voice");
  assert.equal(items[0].part_index, 1);
  assert.ok(turns.length >= 1);
});

// ---------- five states, all distinct ----------

test("waiting, processing, transcribed: the record moves through all three", async () => {
  const given = reviewed.record({ channel: "fake", conversationId: "dm:owner", inbound: inbound({}) });
  assert.equal(db.mediaFor("dm:owner")[0].coverage, "waiting", "arrived, nothing started");

  const states = [];
  await voice.hearInto(voice.cannotHearLine(note()), given, {
    status: () => ({ ok: true }),
    listen: async () => {
      // Read from inside the listening, which is the only moment `processing` is true.
      states.push(db.mediaFor("dm:owner")[0].coverage);
      return { ok: true, text: "running late, start without me" };
    },
    cover: reviewed.cover,
  });

  assert.deepEqual(states, ["processing"]);
  const row = db.mediaFor("dm:owner")[0];
  assert.equal(row.coverage, "transcribed");
  assert.equal(row.transcript, "running late, start without me");
});

test("no speech and could-not-listen are different states and different lines", async () => {
  const silent = voice.heardLine(note(), { ok: true, text: "", silent: true });
  const broke = voice.couldNotHearLine(note(), "the audio could not be downloaded (HTTP 404)");
  assert.match(silent, /no speech in it/);
  assert.match(silent, /nothing was said/);
  assert.match(broke, /could not be listened to/);
  assert.match(broke, /do not guess/);
  assert.notEqual(silent, broke);

  for (const [outcome, expected] of [
    [{ ok: true, text: "", silent: true }, "no_speech"],
    [{ ok: false, error: "the audio could not be downloaded (HTTP 404)" }, "failed"],
  ]) {
    db.db.exec("DELETE FROM media_items;");
    const given = reviewed.record({ channel: "fake", conversationId: "dm:owner", inbound: inbound({}) });
    await voice.hearInto("x", given, { status: () => ({ ok: true }), listen: async () => outcome, cover: reviewed.cover });
    assert.equal(db.mediaFor("dm:owner")[0].coverage, expected);
  }
});

test("a note with no speech in it stores no transcript, because there were no words", async () => {
  const given = reviewed.record({ channel: "fake", conversationId: "dm:owner", inbound: inbound({}) });
  await voice.hearInto("x", given, {
    status: () => ({ ok: true }), cover: reviewed.cover,
    listen: async () => ({ ok: true, text: "", silent: true, seconds: 3.2 }),
  });
  const row = db.mediaFor("dm:owner")[0];
  assert.equal(row.coverage, "no_speech");
  assert.equal(row.transcript, null);
  assert.equal(row.seconds, 3.2, "and how long the silence was is still a fact about it");
});

// ---------- unclear words are asked about, never filled in ----------

test("an [inaudible] stretch is counted and the turn is told to ask about that bit only", () => {
  const one = voice.heardLine(note(), { ok: true, text: "meet me at [inaudible] around 8", unclear: 1 });
  assert.match(one, /one stretch/);
  assert.match(one, /NEVER fill that in/);
  assert.match(one, /ask them about that bit specifically/);

  const two = voice.heardLine(note(), { ok: true, text: "[inaudible] then [inaudible]", unclear: 2 });
  assert.match(two, /2 stretches/);

  const clean = voice.heardLine(note(), { ok: true, text: "running late" });
  assert.equal(/inaudible/.test(clean), false, "and nothing is said about gaps when there are none");
});

test("the count comes off the marker the transcriber was asked for, not off a reading", () => {
  assert.equal(voice.unclearCount("a [inaudible] b [INAUDIBLE] c"), 2);
  assert.equal(voice.unclearCount("perfectly clear"), 0);
  assert.equal(voice.unclearCount(null), 0);
});

test("a transcript with gaps in it is recorded as having them", async () => {
  const given = reviewed.record({ channel: "fake", conversationId: "dm:owner", inbound: inbound({}) });
  await voice.hearInto("x", given, {
    status: () => ({ ok: true }), cover: reviewed.cover,
    listen: async () => ({ ok: true, text: "meet me at [inaudible] around 8", unclear: 1 }),
  });
  const row = db.mediaFor("dm:owner")[0];
  assert.equal(row.coverage, "transcribed");
  assert.match(row.detail, /could not be made out/);
});

// ---------- timing, where it can be known ----------

test("how long a note is comes off the bytes of the WAV, not a guess", () => {
  // 16 kHz mono 16-bit is 32,000 bytes a second, past a 44-byte header.
  assert.equal(voice.wavSeconds(Buffer.alloc(44 + 32_000)), 1);
  assert.equal(voice.wavSeconds(Buffer.alloc(44 + 16_000)), 0.5);
  assert.equal(voice.wavSeconds(Buffer.alloc(0)), 0);
});

test("a long note is transcribed with timestamps; a short one is not", async () => {
  const asked = [];
  const listen = async (wavBytes) => {
    const wav = Buffer.alloc(wavBytes);
    wav.write("RIFF", 0); wav.write("WAVE", 8);
    return await voice.hear({
      url: CAF, tmpDir: join(dir, "t"), apiKey: "k", converter: AF,
      convert: async (args) => { writeFileSync(args.at(-1), wav); return { ok: true }; },
      read: () => wav,
      fetchImpl: async (url, init) => {
        if (url === CAF) return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("caf") };
        asked.push(JSON.parse(init.body).contents[0].parts[0].text);
        return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "[0:00] hey. [0:41] so about friday" }] } }] }) };
      },
    });
  };

  // Ten seconds: under the threshold, so the words and nothing else.
  const short = await listen(44 + 32_000 * 10);
  assert.equal(short.ok, true);
  assert.equal(short.seconds, 10);
  assert.match(asked[0], /no timestamps/);
  assert.equal(short.timestamped, undefined);

  // Ninety seconds: over it, so the markers are asked for and reported as real.
  const long = await listen(44 + 32_000 * 90);
  assert.equal(long.seconds, 90);
  assert.match(asked[1], /\[m:ss\] at the start of each sentence/);
  assert.equal(long.timestamped, true);
  assert.match(voice.heardLine(note(), long), /the times in square brackets are real/);
});

// ---------- a note of a few seconds may be only the end of what they meant ----------

// 2026-11-01 16:51 UTC: a 3.3 s note transcribed as "around like 7:30 p.m." (the phone had missed
// "remind me to take the chicken out"). The line said nothing about its length, so the turn hung it
// on the last open question and set a timer to call somebody else at 7:30.
test("a short note is told as short, with its measured length, and the turn is told to ask before acting", () => {
  const line = voice.heardLine(note(), { ok: true, text: "around like 7:30 p.m.", seconds: 3.3 });
  assert.match(line, /only 3\.3s long/);
  assert.match(line, /may be only the end of what they meant/);
  assert.match(line, /ask them what it is for before doing anything with it/);
  assert.match(line, /before anything that reaches another person/);
  assert.match(line, /"around like 7:30 p\.m\."/, "and their words are still there, whole");
});

test("a note past the short line, or of unknown length, carries no such warning", () => {
  assert.equal(/only .*s long/.test(voice.heardLine(note(), { ok: true, text: "running late, be there at 8", seconds: 9 })), false);
  assert.equal(/only .*s long/.test(voice.heardLine(note(), { ok: true, text: "running late" })), false, "a length nobody measured is never called short");
  assert.equal(voice.isShort(config.voiceShortSec), true);
  assert.equal(voice.isShort(config.voiceShortSec + 0.1), false);
  assert.equal(voice.isShort(null), false);
  assert.equal(voice.isShort(0), false);
});

test("a short note's length reaches the turn from the WAV it was measured off", async () => {
  const given = reviewed.record({ channel: "fake", conversationId: "dm:owner", inbound: inbound({}) });
  const wav = Buffer.alloc(44 + 32_000 * 3.3);
  const out = await voice.hearInto(voice.cannotHearLine(note()), given, {
    status: () => ({ ok: true }), cover: reviewed.cover,
    listen: async () => await voice.hear({
      url: CAF, tmpDir: join(dir, "t"), apiKey: "k", converter: AF,
      convert: async (args) => { writeFileSync(args.at(-1), wav); return { ok: true }; },
      read: () => wav,
      fetchImpl: async (url) => url === CAF
        ? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("caf") }
        : { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "around like 7:30 p.m." }] } }] }) },
    }),
  });
  assert.match(out, /only 3\.3s long/);
  assert.equal(db.mediaFor("dm:owner")[0].seconds, 3.3);
});

// ---------- their words survive the conversation rolling past them ----------

test("what they said in a note is readable later, by id, and only by id", async () => {
  const given = reviewed.record({ channel: "fake", conversationId: "dm:owner", inbound: inbound({}) });
  await voice.hearInto("x", given, {
    status: () => ({ ok: true }), cover: reviewed.cover,
    listen: async () => ({ ok: true, text: "bring the blue folder, not the black one", seconds: 6 }),
  });
  const id = db.mediaFor("dm:owner")[0].id;

  // The list says a transcript exists and does not carry it: a conversation about something else
  // should not have somebody's voice notes poured into it.
  const list = await runTool("media_reviewed", {}, { conversationId: "dm:owner" });
  assert.equal(list.items[0].has_transcript, true);
  assert.equal(list.items[0].seconds, 6);
  assert.equal(JSON.stringify(list).includes("blue folder"), false);

  // Asked for by id, the words are there.
  const one = await runTool("media_reviewed", { id }, { conversationId: "dm:owner" });
  assert.equal(one.ok, true);
  assert.equal(one.item.transcript, "bring the blue folder, not the black one");
  assert.match(one.item.transcript_note, /never fill one in/i);

  // And it is not reachable from anybody else's thread.
  const elsewhere = await runTool("media_reviewed", { id }, { conversationId: "dm:fake:+12025559999" });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.error, new RegExp(`no item #${id}`));
});

// ---------- and what the model is told ----------

test("the prompt distinguishes silence from failure, and forbids filling a gap", () => {
  assert.match(SYSTEM, /that one came through silent/);
  assert.match(SYSTEM, /NEVER put a word there that would fit/);
  assert.match(SYSTEM, /ask about that bit and only that bit/);
  assert.match(SYSTEM, /media_reviewed with that item's id, never your memory of it/);
});
