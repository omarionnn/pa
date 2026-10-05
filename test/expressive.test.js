// Tapbacks, screen effects and voice notes — the three things Reason can do to a message besides
// send one. No model, no network, and no ffmpeg (which is the point of the third one).
//
// All three are iMessage-only extras with limits Sendblue states precisely, so most of what is
// worth testing is the refusals:
//
//   does a bad reaction cost a round trip?            (no — the grammar is published, so it is checked)
//   can a tapback land on the wrong message?          (no — the handle comes from the thread, not the model)
//   does an effect on an SMS thread lose the message? (no — the effect is dropped, the message goes)
//   does a missing ffmpeg fail vaguely?               (no — it names ffmpeg and says what can be sent)
//   does a dead line get asked every time?            (no — remembered, like read receipts)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-expressive-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const expressive = await import("../src/expressive.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const STRANGER = "+14155559876";
const LINE = "+15122164639";
const CONV = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM usage; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A thread as it looks after one inbound message has arrived on it. */
function thread({ service = "iMessage", lastInboundId = "H-last" } = {}) {
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service, lastInboundId });
}

function harness(channelOpts = {}) {
  const runtime = new Runtime({ runTurn: async () => null });
  const router = new Router({ runtime });
  const fake = router.register(new FakeChannel({ number: LINE, ...channelOpts }));
  return { router, fake };
}

const sendblue = (fetchImpl, over = {}) => {
  const saved = { id: config.sendblueKeyId, key: config.sendblueSecretKey, from: config.sendblueFrom, secret: config.sendblueWebhookSecret };
  config.sendblueKeyId = "k"; config.sendblueSecretKey = "s"; config.sendblueFrom = LINE; config.sendblueWebhookSecret = "w";
  const restore = () => {
    config.sendblueKeyId = saved.id; config.sendblueSecretKey = saved.key;
    config.sendblueFrom = saved.from; config.sendblueWebhookSecret = saved.secret;
  };
  return { ch: new SendblueChannel({ fetchImpl, ...over }), restore };
};

// ---------- what Sendblue will accept as a reaction ----------

test("the six classic tapbacks are the six Sendblue names, exactly", () => {
  assert.deepEqual(expressive.CLASSIC_TAPBACKS, ["love", "like", "dislike", "laugh", "emphasize", "question"]);
  for (const t of expressive.CLASSIC_TAPBACKS) assert.equal(expressive.checkReaction(t).ok, true);
});

test("a single emoji is fine, including the composed ones that are several code points", () => {
  // "composed emoji (skin tones, families, flags, keycaps) count as one" — which is why this counts
  // grapheme clusters and not characters. 👍🏽 is two code points and the family is seven.
  for (const e of ["🔥", "👀", "👍🏽", "👨‍👩‍👧‍👦", "1️⃣", "🇬🇭", "❤️"]) {
    assert.equal(expressive.checkReaction(e).ok, true, `${e} is one emoji`);
  }
});

test("text, text with an emoji in it, and two emoji are all refused before any request", () => {
  for (const bad of ["hello", "hello🔥", "🔥🔥", "👍 ", " 👍", "ok!"]) {
    const r = expressive.checkReaction(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} is not a reaction`);
    assert.ok(r.error);
  }
});

test("a miscased name is named as miscased, not thrown in with 'not an emoji'", () => {
  // "names are case-sensitive (Love is rejected)". A near-miss deserves the useful error.
  const r = expressive.checkReaction("Love");
  assert.equal(r.ok, false);
  assert.match(r.error, /case-sensitive/);
  assert.match(r.error, /'love'/);
});

test("the text-style form of a character is refused, because Sendblue wants the picker form", () => {
  // "a text-style character without the emoji variation selector (❤ instead of ❤️) is rejected"
  const bare = expressive.checkReaction("❤");
  assert.equal(bare.ok, false);
  assert.match(bare.error, /variation selector/);
  assert.equal(expressive.checkReaction("❤️").ok, true);
});

test("a leading dash takes a reaction back off, and on its own means nothing", () => {
  const off = expressive.checkReaction("-love");
  assert.equal(off.ok, true);
  assert.equal(off.removing, true);
  assert.equal(off.value, "-love", "the dash goes to Sendblue as part of the value");
  assert.equal(expressive.checkReaction("-🔥").removing, true);
  assert.equal(expressive.checkReaction("-").ok, false);
});

test("a named value resolves before an emoji one, because they are different on the device", () => {
  // "love is always Apple's classic heart tapback, while ❤️ is an emoji reaction with the heart"
  assert.equal(expressive.checkReaction("love").kind, "classic");
  assert.equal(expressive.checkReaction("❤️").kind, "emoji");
});

// ---------- the reaction request ----------

test("Sendblue's send-reaction is the endpoint and body its docs document", async () => {
  const calls = [];
  const { ch, restore } = sendblue(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "OK", message: "Reaction request sent", message_handle: "H-1", reaction: "🔥" }) };
  });
  try {
    const out = await ch.react({ messageHandle: "H-1", reaction: "🔥" });
    assert.equal(out.ok, true);
    assert.equal(out.reaction, "🔥");
    assert.equal(calls[0].url, "https://api.sendblue.com/api/send-reaction");
    assert.deepEqual(JSON.parse(calls[0].init.body), { from_number: LINE, message_handle: "H-1", reaction: "🔥" });
    assert.equal("part_index" in JSON.parse(calls[0].init.body), false, "left out unless asked for");
  } finally { restore(); }
});

test("part_index goes along only for a multi-part message", async () => {
  const calls = [];
  const { ch, restore } = sendblue(async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "OK" }) };
  });
  try {
    await ch.react({ messageHandle: "H-1", reaction: "love", partIndex: 1 });
    assert.equal(calls[0].part_index, 1);
    await ch.react({ messageHandle: "H-1", reaction: "love", partIndex: 0 });
    assert.equal(calls[1].part_index, 0, "0 is a real part, not a missing one");
  } finally { restore(); }
});

test("a bad reaction never reaches Sendblue", async () => {
  let called = 0;
  const { ch, restore } = sendblue(async () => { called++; return { ok: true, status: 200, text: async () => "{}" }; });
  try {
    const out = await ch.react({ messageHandle: "H-1", reaction: "nice one" });
    assert.equal(out.ok, false);
    assert.equal(called, 0);
  } finally { restore(); }
});

test("the two 422s mean different things and only one is remembered", async () => {
  const at = (body) => {
    const { ch, restore } = sendblue(async () => ({ ok: false, status: 422, text: async () => JSON.stringify(body) }));
    return ch.react({ messageHandle: "H-1", reaction: "love" }).finally(restore);
  };

  // About the LINE: true for every contact forever, so it is worth writing down.
  const line = await at({ status: "ERROR", message: "unsupported_on_this_line", detail: "This line cannot deliver reactions." });
  assert.equal(line.ok, false);
  assert.equal(line.remember.scope, "line");
  assert.match(line.error, /cannot send tapbacks/);

  // About the MESSAGE: the next message may be perfectly fine, so nothing is remembered.
  const target = await at({ status: "ERROR", message: "unsupported_target", detail: "Reactions are only supported on iMessage messages." });
  assert.equal(target.ok, false);
  assert.equal("remember" in target, false, "one bad target must not switch tapbacks off for good");
  assert.match(target.error, /that message cannot take a tapback/);
});

test("a handle Sendblue has forgotten says so in terms of the few-days limit", async () => {
  const { ch, restore } = sendblue(async () => ({
    ok: false, status: 404, text: async () => JSON.stringify({ status: "ERROR", message: "The message to react to was not found for this account" }),
  }));
  try {
    const out = await ch.react({ messageHandle: "H-old", reaction: "love" });
    assert.match(out.error, /last few days/);
    assert.equal("remember" in out, false);
  } finally { restore(); }
});

// ---------- the react tool ----------

test("react goes on the last message they sent, read from the thread and not from the model", async () => {
  thread({ lastInboundId: "H-their-last" });
  const { router, fake } = harness();
  const out = await runTool("react", { reaction: "love" }, { conversationId: CONV, channels: router });
  assert.equal(out.ok, true);
  assert.equal(out.reacted_to, "H-their-last");
  assert.deepEqual(fake.reactCalls, [{ messageHandle: "H-their-last", reaction: "love", partIndex: null }]);
  assert.match(out.note, /Do NOT also send a text saying the same thing/);
  assert.equal(fake.sent.length, 0, "a tapback is not a text");
});

test("with nothing of theirs to react to, react says so instead of guessing at a handle", async () => {
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true });
  const { router, fake } = harness();
  const out = await runTool("react", { reaction: "love" }, { conversationId: CONV, channels: router });
  assert.equal(out.ok, false);
  assert.match(out.error, /no message of theirs to react to/);
  assert.equal(fake.reactCalls.length, 0);
});

test("an SMS thread is told to use words, and nothing is sent", async () => {
  thread({ service: "SMS" });
  const { router, fake } = harness();
  const out = await runTool("react", { reaction: "love" }, { conversationId: CONV, channels: router });
  assert.equal(out.ok, false);
  assert.equal(out.supported, false);
  assert.match(out.error, /iMessage only/);
  assert.match(out.error, /do not say you reacted/);
  assert.equal(fake.reactCalls.length, 0, "refused before a request, not after a 422");
});

test("a line that cannot do tapbacks is asked once, then remembered", async () => {
  thread();
  const { router, fake } = harness({ reactAs: "line" });
  const first = await runTool("react", { reaction: "love" }, { conversationId: CONV, channels: router });
  assert.equal(first.ok, false);
  assert.ok(db.blockedFeature({ channel: "fake", feature: "reaction", line: LINE }));

  const second = await runTool("react", { reaction: "🔥" }, { conversationId: CONV, channels: router });
  assert.equal(second.ok, false);
  assert.match(second.error, /Reply in words instead/);
  assert.equal(fake.reactCalls.length, 1, "asked once, ever");
});

test("every refusal tells the model to reply in words and not to claim a reaction", async () => {
  thread();
  const { router } = harness({ reactAs: "target" });
  const out = await runTool("react", { reaction: "love" }, { conversationId: CONV, channels: router });
  assert.equal(out.ok, false);
  assert.match(out.error, /reply in words instead/i);
  assert.match(out.error, /do not say you reacted/i);
});

// ---------- effects ----------

test("the 13 effects are Sendblue's 13", () => {
  assert.deepEqual(expressive.SEND_STYLES, [
    "celebration", "shooting_star", "fireworks", "lasers", "love", "confetti",
    "balloons", "spotlight", "echo", "invisible", "gentle", "loud", "slam",
  ]);
  assert.equal(expressive.checkSendStyle("fireworks").ok, true);
  assert.equal(expressive.checkSendStyle("Fireworks").ok, false);
  assert.match(expressive.checkSendStyle("Fireworks").error, /spelled exactly/);
  assert.match(expressive.checkSendStyle("sparkles").error, /not an iMessage effect/);
});

test("an effect rides along on the send, and survives being retried", async () => {
  thread();
  const calls = [];
  const { ch, restore } = sendblue(async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "QUEUED", message_handle: "m1", send_style: "fireworks" }) };
  });
  try {
    const out = await ch.send({ to: STRANGER, text: "they said yes", sendStyle: "fireworks" });
    assert.equal(out.ok, true);
    assert.equal(calls[0].send_style, "fireworks");
    assert.equal(out.delivered.send_style, "fireworks", "what actually happened, echoed back by Sendblue");
  } finally { restore(); }

  // And stored on the row, so a message retried an hour later still goes out the way it was meant to.
  const { row } = db.enqueueOutbound({
    idemKey: "styled", conversationId: CONV, channel: "fake", address: OWNER, body: "they said yes", sendStyle: "slam",
  });
  assert.equal(db.getOutbound(row.id).send_style, "slam");
});

test("an effect THEY used reaches Reason, because that one really is on the payload", async () => {
  // "send_style — Expressive message style if used (empty string if none)" is on the documented
  // receive payload (getting-started/receiving-messages), so this is readable rather than guessed.
  const { ch, restore } = sendblue(async () => ({ ok: true, status: 200, text: async () => "{}" }));
  const body = (over) => JSON.stringify({
    content: "we got the table", is_outbound: false, status: "RECEIVED",
    message_handle: "H-eff", number: OWNER, from_number: OWNER, to_number: LINE,
    group_id: "", media_url: "", service: "iMessage", send_style: "", ...over,
  });
  try {
    const with_ = await ch.receive({ rawBody: body({ send_style: "fireworks" }), headers: { "sb-signing-secret": "w" } });
    assert.match(with_.inbound[0].text, /we got the table/);
    assert.match(with_.inbound[0].text, /'fireworks' screen effect/);
    assert.match(with_.inbound[0].text, /being emphatic/);

    // The ordinary case is silence: an empty send_style must not produce a line about effects.
    const without = await ch.receive({ rawBody: body({}), headers: { "sb-signing-secret": "w" } });
    assert.equal(without.inbound[0].text, "we got the table");
  } finally { restore(); }
});

test("an unknown effect is refused before the request, so a bad style cannot lose a message", async () => {
  let called = 0;
  const { ch, restore } = sendblue(async () => { called++; return { ok: true, status: 200, text: async () => "{}" }; });
  try {
    const out = await ch.send({ to: STRANGER, text: "hi", sendStyle: "sparkles" });
    assert.equal(out.ok, false);
    assert.equal(out.retryable, false);
    assert.equal(called, 0, "a missing animation is a far better outcome than a lost message");
  } finally { restore(); }
});

test("on an SMS thread the effect is dropped and the message still goes", async () => {
  thread({ service: "SMS" });
  const { router, fake } = harness();
  const out = await runTool("message_send", { to: "owner", text: "they said yes", style: "fireworks" }, { conversationId: CONV, channels: router });
  assert.equal(out.ok, true, "the message is the thing that matters");
  assert.equal(fake.sent.length, 1);
  assert.match(out.style_dropped, /iMessage only/);
  assert.match(out.style_dropped, /do not mention an effect/);
  assert.equal("style" in out, false);
});

// ---------- voice notes, and the ffmpeg that is not here ----------

test("ffmpeg is not on this machine, which is why voice notes mostly cannot be sent", () => {
  // Not an assertion about the world so much as the premise of the next three tests. If this ever
  // fails, somebody installed ffmpeg and the voice-note path became live — which is fine, but the
  // README and docs/unverified.md both say it is absent and would need correcting.
  assert.equal(expressive.findFfmpeg({ recheck: true }), null);
  const st = expressive.voiceNoteStatus({ bin: null });
  assert.equal(st.ok, false);
  assert.deepEqual(st.missing, ["ffmpeg"]);
  assert.match(st.what, /ffmpeg is not installed/);
  assert.match(st.what, /ordinary attachment/);
});

test("a .caf file needs no conversion, so it sends on a machine with no ffmpeg", async () => {
  const picked = await expressive.voiceNoteFile({
    file: "/tmp/note.caf", tmpDir: "/tmp", bin: null, exists: () => true,
    run: async () => { throw new Error("should not convert a file that is already .caf"); },
  });
  assert.deepEqual(picked, { ok: true, file: "/tmp/note.caf", converted: false });
});

test("anything else names ffmpeg and says what can be sent instead", async () => {
  const picked = await expressive.voiceNoteFile({ file: "/tmp/call.wav", tmpDir: "/tmp", bin: null, exists: () => true });
  assert.equal(picked.ok, false);
  assert.deepEqual(picked.missing, ["ffmpeg"]);
  assert.match(picked.error, /\.caf is the only format Apple plays as a voice memo/);
  assert.match(picked.error, /needs ffmpeg, which is not installed/);
  assert.match(picked.error, /ordinary audio attachment instead/);
  assert.equal(/undefined|\[object/.test(picked.error), false, "a sentence, not a shrug");
});

test("with ffmpeg present it runs the exact command the docs give", async () => {
  // Proved offline on a machine with no ffmpeg, by injecting the runner. The conversion itself has
  // therefore never executed — see docs/unverified.md.
  const ran = [];
  const picked = await expressive.voiceNoteFile({
    file: "/tmp/call.wav", tmpDir: "/tmp/out", bin: "/usr/local/bin/ffmpeg", exists: () => true,
    run: async (args) => { ran.push(args); return { ok: true }; },
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.converted, true);
  assert.equal(picked.file, "/tmp/out/call.caf");
  assert.deepEqual(ran[0], ["-i", "/tmp/call.wav", "-acodec", "opus", "-b:a", "24k", "/tmp/out/call.caf"]);
});

test("a conversion that fails, or produces nothing, is reported rather than sent", async () => {
  const broke = await expressive.voiceNoteFile({
    file: "/tmp/call.wav", tmpDir: "/tmp/out", bin: "/x/ffmpeg", exists: () => true,
    run: async () => ({ ok: false, error: "Invalid data found when processing input" }),
  });
  assert.equal(broke.ok, false);
  assert.match(broke.error, /Invalid data found/);

  const silent = await expressive.voiceNoteFile({
    file: "/tmp/call.wav", tmpDir: "/tmp/out", bin: "/x/ffmpeg",
    exists: (p) => p === "/tmp/call.wav",
    run: async () => ({ ok: true }),
  });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /reported success but there is no/);
});

test("a missing file is caught before anything is converted or sent", async () => {
  const gone = await expressive.voiceNoteFile({ file: "/tmp/nope.wav", tmpDir: "/tmp", exists: () => false });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /not there/);
});

test("the voice_note_send tool refuses honestly and sends nothing", async () => {
  thread();
  const { router, fake } = harness();
  // A file that really is on disk, so what the refusal is about is ffmpeg and nothing else. There
  // is no ffmpeg on this machine, which is the whole point of this path.
  const wav = join(dir, "call.wav");
  writeFileSync(wav, Buffer.alloc(64));
  const out = await runTool("voice_note_send", { to: "owner", file: wav }, { conversationId: CONV, channels: router });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing, ["ffmpeg"], "and it names the thing that is missing");
  assert.match(out.error, /ffmpeg/);
  assert.match(out.note, /do not describe a voice note as sent/);
  assert.equal(fake.sent.length, 0);
});

// ---------- what capabilities says ----------

test("capabilities tells the truth about all three, per thread", () => {
  thread();
  const { router } = harness();
  const live = capabilitiesNow({ channels: router, conversationId: CONV });
  assert.equal(live.find(c => c.name === "tapbacks").status, "live");
  assert.equal(live.find(c => c.name === "message_effects").status, "live");
  // Voice notes are honest about the machine, not about the channel.
  const voice = live.find(c => c.name === "voice_notes");
  assert.equal(voice.status, "not connected");
  assert.match(voice.what, /ffmpeg is not installed/);

  // An SMS thread loses two of the three, and says which rail it is on.
  thread({ service: "SMS" });
  const sms = capabilitiesNow({ channels: router, conversationId: CONV });
  assert.equal(sms.find(c => c.name === "tapbacks").status, "not connected");
  assert.match(sms.find(c => c.name === "tapbacks").what, /SMS/);
  assert.equal(sms.find(c => c.name === "message_effects").status, "not connected");

  // And a remembered line refusal shows up as the reason tapbacks are absent.
  thread();
  db.recordChannelLimit({ channel: "fake", feature: "reaction", scope: `line:${LINE}`, why: "this Sendblue line cannot send tapbacks", code: "422" });
  const refused = capabilitiesNow({ channels: router, conversationId: CONV });
  assert.equal(refused.find(c => c.name === "tapbacks").status, "not connected");
  assert.match(refused.find(c => c.name === "tapbacks").what, /cannot send tapbacks/);
});

test("with no channel at all, none of the three pretends to work", () => {
  const runtime = new Runtime({ runTurn: async () => null });
  const router = new Router({ runtime });
  router.register(new FakeChannel({ live: false }));
  const caps = capabilitiesNow({ channels: router, conversationId: CONV });
  for (const name of ["tapbacks", "message_effects", "voice_notes"]) {
    assert.equal(caps.find(c => c.name === name).status, "not connected", name);
  }
});
