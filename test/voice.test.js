// Reason's voice and its ears: saying something as a voice note, and listening to one. No model and
// no network — every Gemini call is an injected fetch — and the one test that runs a real converter
// only runs on a machine that has afconvert.
//
//   can a voice note be made on a Mac with nothing installed?   (yes — afconvert, which is already there)
//   does a long speech become a voice note?                     (no — refused before any request)
//   is a voice note Reason could not hear guessed at?           (no — the turn is told exactly why)
//   does a failed voice leave Reason saying it sent one?        (no — nothing is sent, and it says so)
//   can it be spoken at anyone but the person it works for?     (no — it goes to the thread's own address)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-voice-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_AUDIO_TMP = join(dir, "audio");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
// "A converter exists" has to be true on any machine these run on, so it is pointed at a file that
// certainly does. Nothing here executes it: every conversion is an injected function.
process.env.REASON_AFCONVERT_BIN = process.execPath;

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const expressive = await import("../src/expressive.js");
const voice = await import("../src/voice.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const CONV = "dm:owner";
const AF = { kind: "afconvert", bin: "/usr/bin/afconvert" };
const CAF_URL = "https://storage.googleapis.com/inbound-file-store/abc_AudioMessage.caf";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pending_inbound; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.burstQuietMs = 0;
  config.burstMaxMs = 0;
  config.geminiKey = "test-key";
});

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const pcm = Buffer.alloc(48_000 * 2); // two seconds of silence at 24 kHz, 16-bit mono
const ttsAnswer = (buf = pcm) => json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: buf.toString("base64") } }] } }] });
/** A converter that "works": writes the output file it was asked for. */
const converts = (calls = []) => async (args, opts) => { calls.push({ args, opts }); writeFileSync(args.at(-1), "caff-ish"); return { ok: true }; };

function thread({ service = "iMessage" } = {}) {
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service, lastInboundId: "H-last" });
}
function harness({ hear = undefined, turn = async () => "ok" } = {}) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async (t) => { turns.push(t); return await turn(t); } });
  const router = new Router({ runtime, log: (e) => logs.push(e), ...(hear ? { hear } : {}) });
  const fake = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ to, text, chatId }) => { await fake.send({ to, text, chatId }); });
  return { router, fake, turns, logs };
}

// ---------- the converter ----------

test("a Mac needs nothing installed: afconvert is found first, and writes Apple's own format", async () => {
  assert.deepEqual(expressive.findConverter(), { kind: "afconvert", bin: process.execPath });
  assert.deepEqual(expressive.VOICE_AFCONVERT_ARGS("in.wav", "out.caf"), ["-f", "caff", "-d", "opus@24000", "-c", "1", "in.wav", "out.caf"]);

  const ran = [];
  const picked = await expressive.voiceNoteFile({
    file: "/tmp/call.wav", tmpDir: "/tmp/out", converter: AF, exists: () => true,
    run: async (args, opts) => { ran.push({ args, opts }); return { ok: true }; },
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.file, "/tmp/out/call.caf");
  assert.deepEqual(ran[0].args, ["-f", "caff", "-d", "opus@24000", "-c", "1", "/tmp/call.wav", "/tmp/out/call.caf"]);
  assert.equal(ran[0].opts.bin, "/usr/bin/afconvert");

  const st = expressive.voiceNoteStatus({ converter: AF });
  assert.equal(st.ok, true);
  assert.match(st.what, /converted with afconvert/);
});

test("afconvert really does produce a CAF file, on a machine that has it", { skip: !existsSync(expressive.AFCONVERT_PATH) }, async () => {
  const wav = join(dir, "real.wav");
  const caf = join(dir, "real.caf");
  writeFileSync(wav, voice.asWav(pcm));
  const r = await expressive.runConverter(expressive.VOICE_AFCONVERT_ARGS(wav, caf), { bin: expressive.AFCONVERT_PATH });
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(caf).toString("ascii", 0, 4), "caff");

  // And back again, which is the half that listening needs.
  const back = join(dir, "back.wav");
  const b = await expressive.runConverter(expressive.WAV_AFCONVERT_ARGS(caf, back), { bin: expressive.AFCONVERT_PATH });
  assert.equal(b.ok, true, b.error);
  assert.equal(readFileSync(back).toString("ascii", 0, 4), "RIFF");
});

test("bare PCM gets a WAV header, and something that is already a WAV is left alone", () => {
  const wav = voice.asWav(pcm);
  assert.equal(wav.length, pcm.length + 44);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(voice.asWav(wav), wav, "not wrapped twice — a header played as sound is a click");
});

// ---------- speaking ----------

test("speak asks the speech model for audio in the documented shape, and hands back a voice memo", async () => {
  const calls = [];
  const conv = [];
  const out = await voice.speak({
    text: "yo, got you the seven thirty at lucali", tmpDir: join(dir, "s1"),
    converter: AF, convert: converts(conv),
    fetchImpl: async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return ttsAnswer(); },
  });
  assert.equal(out.ok, true, out.error);
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-3\.8-flash-tts:generateContent$/);
  assert.equal(calls[0].headers["x-goog-api-key"], "test-key");
  assert.deepEqual(calls[0].body.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(calls[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, config.ttsVoice);
  // Only the words. Any direction in front of them is read out loud by this model — it was.
  assert.equal(calls[0].body.contents[0].parts[0].text, "yo, got you the seven thirty at lucali");
  assert.equal(calls[0].body.contents.length, 1);
  assert.equal("systemInstruction" in calls[0].body, false, "refused by the speech model with a 400");

  assert.match(out.file, /\.caf$/);
  assert.equal(out.seconds, 2);
  assert.deepEqual(conv[0].args.slice(0, 6), ["-f", "caff", "-d", "opus@24000", "-c", "1"]);
  assert.equal(existsSync(conv[0].args[6]), false, "the intermediate WAV is not left lying around");
});

test("a speech is not a voice note: too long is refused before any request", async () => {
  let asked = 0;
  const out = await voice.speak({ text: "x".repeat(voice.MAX_SPOKEN_CHARS + 1), converter: AF, fetchImpl: async () => { asked++; return ttsAnswer(); } });
  assert.equal(out.ok, false);
  assert.match(out.error, /a voice note is a few sentences/);
  assert.equal(asked, 0);
});

test("with no speech model, or no converter, it names what is missing and says to text", async () => {
  const noKey = await voice.speak({ text: "hi", apiKey: "", converter: AF });
  assert.equal(noKey.ok, false);
  assert.deepEqual(noKey.missing, ["GEMINI_API_KEY"]);
  assert.match(noKey.error, /do not say you sent a voice note/);

  const noConv = await voice.speak({ text: "hi", converter: null });
  assert.deepEqual(noConv.missing, ["ffmpeg"]);
  assert.match(noConv.error, /afconvert on a Mac/);
  assert.equal(/undefined|\[object/.test(noKey.error + noConv.error), false);
});

test("every way the voice can fail comes back as a reason, and no file", async () => {
  const limited = await voice.speak({ text: "hi", converter: AF, convert: converts(), fetchImpl: async () => json(429, { error: { message: "quota exceeded" } }) });
  assert.equal(limited.ok, false);
  assert.equal(limited.rate_limited, true);
  assert.match(limited.error, /over its limit for the moment/);
  assert.match(limited.error, /do not offer another voice note right now/);

  const refused = await voice.speak({ text: "hi", converter: AF, convert: converts(), fetchImpl: async () => json(500, { error: { message: "internal" } }) });
  assert.match(refused.error, /could not be made: Gemini said 500: internal/);

  const empty = await voice.speak({ text: "hi", converter: AF, convert: converts(), fetchImpl: async () => json(200, { candidates: [{ content: { parts: [{ text: "sure!" }] } }] }) });
  assert.match(empty.error, /no audio in it/);

  const broke = await voice.speak({ text: "hi", tmpDir: join(dir, "s2"), converter: AF, convert: async () => ({ ok: false, error: "Couldn't open input file" }), fetchImpl: async () => ttsAnswer() });
  assert.match(broke.error, /turning it into a voice memo failed: Couldn't open input file/);

  const silent = await voice.speak({ text: "hi", tmpDir: join(dir, "s3"), converter: AF, convert: async () => ({ ok: true }), fetchImpl: async () => ttsAnswer() });
  assert.match(silent.error, /wrote no file/);

  const down = await voice.speak({ text: "hi", converter: AF, fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.match(down.error, /could not reach Gemini/);
});

// ---------- listening ----------

const transcript = (text) => json(200, { candidates: [{ content: { parts: [{ text }] } }] });
const download = (bytes = Buffer.from("caff....")) => ({ ok: true, status: 200, arrayBuffer: async () => bytes });

test("hear downloads the note, turns Apple's format into WAV, and returns the words", async () => {
  const calls = [];
  const conv = [];
  const out = await voice.hear({
    url: CAF_URL, filename: "abc_AudioMessage.caf", tmpDir: join(dir, "h1"), converter: AF,
    convert: async (args, opts) => { conv.push({ args, opts }); writeFileSync(args.at(-1), "RIFFwav"); return { ok: true }; },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return url === CAF_URL ? download() : transcript("  can you move the table to eight\n and tell kofi  ");
    },
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.text, "can you move the table to eight and tell kofi");
  assert.equal(calls[0].url, CAF_URL);
  assert.deepEqual(conv[0].args.slice(0, 6), ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1"]);
  const sent = calls[1].body.contents[0].parts;
  assert.match(sent[0].text, /word for word/);
  assert.match(sent[0].text, /\[inaudible\]/);
  assert.equal(sent[1].inline_data.mime_type, "audio/wav");
  assert.equal(Buffer.from(sent[1].inline_data.data, "base64").toString(), "RIFFwav", "the converted audio, not the .caf");
  assert.equal(existsSync(conv[0].args[6]), false, "and neither file is kept");
  assert.equal(existsSync(conv[0].args[7]), false);
});

test("a note with nothing said in it is reported as silence, not as words", async () => {
  const out = await voice.hear({
    url: CAF_URL, tmpDir: join(dir, "h2"), converter: AF,
    convert: async (args) => { writeFileSync(args.at(-1), "RIFF"); return { ok: true }; },
    fetchImpl: async (url) => (url === CAF_URL ? download() : transcript("[no speech]")),
  });
  assert.equal(out.ok, true);
  assert.equal(out.silent, true);
  assert.equal(out.text, "");
});

test("every way listening can fail is a reason in words", async () => {
  const base = { url: CAF_URL, tmpDir: join(dir, "h3"), converter: AF, convert: async (args) => { writeFileSync(args.at(-1), "RIFF"); return { ok: true }; } };
  const gone = await voice.hear({ ...base, fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.match(gone.error, /could not be downloaded \(HTTP 404\)/);

  const huge = await voice.hear({ ...base, fetchImpl: async () => download(Buffer.alloc(voice.MAX_HEARD_BYTES + 1)) });
  assert.match(huge.error, /too long to listen to/);

  const unreadable = await voice.hear({ ...base, convert: async () => ({ ok: false, error: "Couldn't open input file" }), fetchImpl: async () => download() });
  assert.match(unreadable.error, /could not be read: Couldn't open input file/);

  const refused = await voice.hear({ ...base, fetchImpl: async (url) => (url === CAF_URL ? download() : json(500, { error: { message: "internal" } })) });
  assert.match(refused.error, /could not be transcribed: Gemini said 500/);

  const blank = await voice.hear({ ...base, fetchImpl: async (url) => (url === CAF_URL ? download() : transcript("")) });
  assert.match(blank.error, /returned nothing/);
});

test("a voice note's link gets the same check a photo's does: https, and not this machine", async () => {
  let asked = 0;
  const fetchImpl = async () => { asked++; return download(); };
  for (const url of [
    "http://cdn/x/AudioMessage.caf",
    "https://127.0.0.1:8787/x/AudioMessage.caf",
    "https://localhost/x/AudioMessage.caf",
  ]) {
    const r = await voice.hear({ url, tmpDir: join(dir, "hurl"), converter: AF, fetchImpl });
    assert.equal(r.ok, false, url);
    assert.match(r.error, /could not be downloaded/);
  }
  assert.equal(asked, 0, "nothing was fetched from any of them");
});

// 2026-11-09, owner's call: the small model listens first and the big one is the fallback, because
// the big one kept answering 503 "high demand" and every voice note waited it out first.
test("a voice note goes to the small model first, the big one only as the fallback, and video keeps its own", async () => {
  if (!process.env.REASON_HEAR_MODEL) assert.equal(config.hearModel, "gemini-3.5-flash-lite");
  if (!process.env.REASON_HEAR_FALLBACK_MODEL) assert.equal(config.hearFallbackModel, "gemini-3.8-flash");
  if (!process.env.REASON_VIDEO_MODEL) assert.equal(config.videoModel, "gemini-3.8-flash", "videos are not moved by the voice-note order");
  assert.equal(voice.hearingStatus({ apiKey: "k", converter: AF }).model, config.hearModel);
  const base = { url: CAF_URL, tmpDir: join(dir, "h3o"), converter: AF, retryAfterMs: 0, convert: async (args) => { writeFileSync(args.at(-1), "RIFF"); return { ok: true }; } };
  const urls = [];
  const r = await voice.hear({ ...base, fetchImpl: async (url) => { if (url === CAF_URL) return download(); urls.push(url); return transcript("running late"); } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.model, "gemini-3.5-flash-lite");
  assert.equal(typeof r.ms, "number", "how long listening took is on the answer");
  assert.equal(urls.length, 1);
  assert.match(urls[0], /gemini-3\.5-flash-lite:generateContent/, "the first request is to the small model");
});

test("a busy first model is not asked twice: the other model is the retry", async () => {
  const base = { url: CAF_URL, tmpDir: join(dir, "h4"), converter: AF, retryAfterMs: 0, convert: async (args) => { writeFileSync(args.at(-1), "RIFF"); return { ok: true }; } };
  for (const status of [503, 429, 500]) {
    const urls = [];
    const other = await voice.hear({ ...base, fetchImpl: async (url) => { if (url === CAF_URL) return download(); urls.push(url); return /flash-lite:/.test(url) ? json(status, { error: { message: "high demand" } }) : transcript("running late"); } });
    assert.equal(other.text, "running late", String(status));
    assert.equal(other.model, config.hearFallbackModel);
    assert.equal(urls.length, 2, `${status}: the first model once, then the fallback once`);
    assert.match(urls[0], /flash-lite:/);
    assert.match(urls[1], /3\.8-flash:/);
  }

  // A bad request is the same refusal from any model: nobody else is asked.
  const urls = [];
  const bad = await voice.hear({ ...base, fetchImpl: async (url) => { if (url === CAF_URL) return download(); urls.push(url); return json(400, { error: { message: "bad audio" } }); } });
  assert.equal(bad.ok, false);
  assert.equal(urls.length, 1);

  // Busy everywhere: the fallback gets its one retry on a 503, and then it stops.
  let asked = 0;
  const still = await voice.hear({ ...base, fetchImpl: async (url) => (url === CAF_URL ? download() : (asked++, json(503, { error: { message: "high demand" } }))) });
  assert.equal(still.ok, false);
  assert.equal(asked, 3, "not a loop — somebody is waiting on a typing bubble");
  assert.match(still.error, /503/);

  // With no other model, the only one keeps its one retry.
  asked = 0;
  const alone = await voice.hear({ ...base, fallbackModel: "", fetchImpl: async (url) => (url === CAF_URL ? download() : (++asked === 1 ? json(503, { error: { message: "high demand" } }) : transcript("running late"))) });
  assert.equal(alone.text, "running late");
  assert.equal(asked, 2);
});

// 2026-10-06: a seven-second note "timed out" after a full minute and he was asked to type it.
// 2026-11-09: the same model was still waited out twice before the other was asked.
test("a model that does not answer in time is not waited on again: somebody else listens", async () => {
  const base = { url: CAF_URL, tmpDir: join(dir, "h5"), converter: AF, retryAfterMs: 0, convert: async (args) => { writeFileSync(args.at(-1), "RIFF"); return { ok: true }; } };
  const hang = () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };

  const urls = [];
  const other = await voice.hear({ ...base, fetchImpl: async (url) => { if (url === CAF_URL) return download(); urls.push(url); return /flash-lite:/.test(url) ? hang() : transcript("check my most recent resume"); } });
  assert.equal(other.text, "check my most recent resume");
  assert.equal(other.model, config.hearFallbackModel);
  assert.equal(urls.length, 2, "the first model once, then the fallback once");

  // Nobody answers at all: two attempts, not four, and it says so in the words it always did.
  let asked = 0;
  const never = await voice.hear({ ...base, fetchImpl: async (url) => (url === CAF_URL ? download() : (asked++, hang())) });
  assert.equal(never.ok, false);
  assert.equal(asked, 2, "two models, one try each, and not a loop");
  assert.match(never.error, /did not answer within/);

  // Alone, a silent model is asked once more, as before.
  asked = 0;
  const alone = await voice.hear({ ...base, fallbackModel: "", fetchImpl: async (url) => (url === CAF_URL ? download() : (++asked === 1 ? hang() : transcript("ok"))) });
  assert.equal(alone.text, "ok");
  assert.equal(asked, 2);
});

test("a short note is not waited on for a minute", () => {
  assert.equal(voice.hearAttemptMs(3.3, 60_000), 16_600, "ten seconds, plus two for every second of audio");
  assert.equal(voice.hearAttemptMs(1, 60_000), 15_000, "never under fifteen");
  assert.equal(voice.hearAttemptMs(600, 60_000), 60_000, "never over the ceiling");
  assert.equal(voice.hearAttemptMs(null, 60_000), 20_000, "an unknown length is twenty seconds, not the minute");
  assert.equal(voice.hearAttemptMs(null, 10_000), 10_000, "and still never over the ceiling");
});

test("what cannot be listened to at all is 'unavailable', which is different from 'failed'", async () => {
  const noKey = await voice.hear({ url: CAF_URL, apiKey: "", converter: AF });
  assert.equal(noKey.unavailable, true);

  // Apple's format with no converter: nothing here can open it.
  const noConv = await voice.hear({ url: CAF_URL, filename: "note.caf", converter: null });
  assert.equal(noConv.unavailable, true);
  assert.match(noConv.error, /needs an audio converter/);

  // But an .m4a needs no converting, so a machine with no converter can still listen to one.
  const calls = [];
  const native = await voice.hear({
    url: "https://cdn/x/memo.m4a", filename: "memo.m4a", converter: null,
    fetchImpl: async (url, init) => { calls.push(init?.body ? JSON.parse(init.body) : null); return url.endsWith(".m4a") ? download(Buffer.from("m4a")) : transcript("call me back"); },
  });
  assert.equal(native.text, "call me back");
  assert.equal(calls[1].contents[0].parts[1].inline_data.mime_type, "audio/m4a");
});

// ---------- what the turn reads ----------

const note = { url: CAF_URL, filename: "abc_AudioMessage.caf", kind: "voice" };

test("the adapter's 'cannot listen' line is swapped for what was actually said", async () => {
  const was = voice.cannotHearLine(note);
  const out = await voice.hearInto(`here\n${was}`, [note], { status: () => ({ ok: true }), listen: async () => ({ ok: true, text: "move it to eight" }) });
  assert.match(out, /^here\n\[they sent a voice note\. this is what they said in it, transcribed/);
  assert.match(out, /"move it to eight"\]$/);
  assert.doesNotMatch(out, /cannot listen/);
  assert.match(out, /can mishear a name or a number/);
});

test("a note that could not be heard says exactly why, and tells the model not to guess", async () => {
  const out = await voice.hearInto(voice.cannotHearLine(note), [note], { status: () => ({ ok: true }), listen: async () => ({ ok: false, error: "the audio could not be downloaded (HTTP 404)" }) });
  assert.match(out, /could not be listened to: the audio could not be downloaded \(HTTP 404\)/);
  assert.match(out, /do not guess at what it said/);
});

test("when nothing here can listen, the message is left exactly as the adapter wrote it", async () => {
  const text = voice.cannotHearLine(note);
  let asked = 0;
  assert.equal(await voice.hearInto(text, [note], { status: () => ({ ok: false }), listen: async () => { asked++; return { ok: true, text: "x" }; } }), text);
  assert.equal(asked, 0);
  // And a listener that finds out late that it cannot is treated the same way.
  assert.equal(await voice.hearInto(text, [note], { status: () => ({ ok: true }), listen: async () => ({ ok: false, unavailable: true, error: "no converter" }) }), text);
  // A picture is not sound, and is nobody's business here.
  assert.equal(await voice.hearInto("look", [{ url: "https://cdn/x.jpg", filename: "x.jpg", kind: "image" }], { status: () => ({ ok: true }), listen: async () => { throw new Error("no"); } }), "look");
});

test("the Sendblue adapter writes the same line the router replaces", async () => {
  const saved = { id: config.sendblueKeyId, key: config.sendblueSecretKey, from: config.sendblueFrom, secret: config.sendblueWebhookSecret };
  config.sendblueKeyId = "k"; config.sendblueSecretKey = "s"; config.sendblueFrom = LINE; config.sendblueWebhookSecret = "w";
  try {
    const ch = new SendblueChannel({ fetchImpl: async () => json(200, {}) });
    const got = await ch.receive({
      rawBody: JSON.stringify({ content: "", is_outbound: false, status: "RECEIVED", message_handle: "H-vn", number: OWNER, from_number: OWNER, to_number: LINE, group_id: "", media_url: CAF_URL, service: "iMessage" }),
      headers: { "sb-signing-secret": "w" },
    });
    assert.equal(got.inbound[0].text, voice.cannotHearLine(got.inbound[0].attachments[0]));
    assert.equal(got.inbound[0].attachments[0].kind, "voice");
  } finally {
    config.sendblueKeyId = saved.id; config.sendblueSecretKey = saved.key; config.sendblueFrom = saved.from; config.sendblueWebhookSecret = saved.secret;
  }
});

test("a voice note they send reaches the turn as the words in it", async () => {
  const heard = [];
  const { router, turns } = harness({
    hear: (text, attachments, opts) => voice.hearInto(text, attachments, { ...opts, status: () => ({ ok: true }), listen: async (a) => { heard.push(a); return { ok: true, text: "can you book lucali for friday" }; } }),
  });
  await router.deliver({ channel: "fake", externalId: "H-vn", from: OWNER, text: voice.cannotHearLine(note), said: "", attachments: [note], chatId: null, service: "iMessage", at: clock.now() });
  assert.equal(heard.length, 1);
  assert.equal(heard[0].url, CAF_URL);
  assert.match(turns[0].text, /"can you book lucali for friday"/);
  assert.doesNotMatch(turns[0].text, /cannot listen/);
});

test("listening that blows up never costs the turn", async () => {
  const { router, turns, logs } = harness({ hear: async () => { throw new Error("boom"); } });
  await router.deliver({ channel: "fake", externalId: "H-vn2", from: OWNER, text: voice.cannotHearLine(note), said: "", attachments: [note], chatId: null, service: "iMessage", at: clock.now() });
  assert.equal(turns.length, 1, "the turn still ran");
  assert.equal(turns[0].text, voice.cannotHearLine(note), "on the honest line it started with");
  assert.ok(logs.some(l => l.hear_failed === "H-vn2"));
});

// ---------- the voice_note_say tool ----------

/** A stand-in voice: writes a real file, because the channel checks the audio is really there. */
const speaks = (made = []) => async ({ text }) => {
  const file = join(dir, `said-${made.length}.caf`);
  writeFileSync(file, "caff-voice");
  made.push({ text, file });
  return { ok: true, file, seconds: 3.2 };
};

test("voice_note_say sends one voice memo, with no text, to the person whose thread it is", async () => {
  thread();
  const { router, fake } = harness();
  const made = [];
  const out = await runTool("voice_note_say", { text: "happy birthday big man" }, { conversationId: CONV, channels: router, speak: speaks(made) });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.seconds, 3.2);
  assert.match(out.note, /Do NOT also text the same words/);
  assert.deepEqual(made.map(m => m.text), ["happy birthday big man"]);

  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].to, OWNER);
  assert.equal(fake.sent[0].text, "", "a voice note, not a caption with audio attached");
  assert.equal(fake.sent[0].media.mimeType, "audio/x-caf");
  assert.match(fake.sent[0].media.filename, /\.caf$/);
  assert.equal(existsSync(made[0].file), false, "the sound is deleted once it has gone");
});

test("on an SMS thread there is no voice note, and nothing is spoken or sent", async () => {
  thread({ service: "SMS" });
  const { router, fake } = harness();
  const made = [];
  const out = await runTool("voice_note_say", { text: "hi" }, { conversationId: CONV, channels: router, speak: speaks(made) });
  assert.equal(out.ok, false);
  assert.match(out.error, /SMS, and a voice note only plays as one on iMessage/);
  assert.match(out.error, /do not say you sent a voice note/);
  assert.equal(made.length, 0, "no speech was paid for");
  assert.equal(fake.sent.length, 0);
});

test("with no voice on this machine it names what is missing and tells the model to text", async () => {
  thread();
  const { router, fake } = harness();
  config.geminiKey = "";
  const out = await runTool("voice_note_say", { text: "hi" }, { conversationId: CONV, channels: router, speak: speaks() });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing, ["GEMINI_API_KEY"]);
  assert.match(out.error, /Send it as a text instead/);
  assert.equal(fake.sent.length, 0);
});

test("a voice that could not be made sends nothing and says so", async () => {
  thread();
  const { router, fake } = harness();
  const out = await runTool("voice_note_say", { text: "hi" }, { conversationId: CONV, channels: router, speak: async () => ({ ok: false, error: "the voice could not be made: Gemini said 429: quota exceeded. Send it as text instead." }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /429/);
  assert.equal(out.note, "Nothing was sent.");
  assert.equal(fake.sent.length, 0);
});

test("with no texting thread there is nowhere to send one", async () => {
  const out = await runTool("voice_note_say", { text: "hi" }, { conversationId: CONV, channels: null, speak: speaks() });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
});

test("more than a few sentences is refused by the tool itself", async () => {
  thread();
  const { router } = harness();
  const out = await runTool("voice_note_say", { text: "x".repeat(voice.MAX_SPOKEN_CHARS + 1) }, { conversationId: CONV, channels: router, speak: speaks() });
  assert.equal(out.ok, false);
  assert.match(out.error, /Bad input/);
});

// ---------- capabilities ----------

test("capabilities says whether there is a voice and ears, and why not when there is not", () => {
  thread();
  const { router } = harness();
  const live = capabilitiesNow({ channels: router, conversationId: CONV });
  assert.equal(live.find(c => c.name === "speak").status, "live");
  assert.match(live.find(c => c.name === "speak").what, /Most replies are still text/);
  assert.equal(live.find(c => c.name === "hear_voice_notes").status, "live");
  assert.equal(live.find(c => c.name === "voice_notes").status, "live", "and a file can be sent as one, now that something can convert it");

  thread({ service: "SMS" });
  const sms = capabilitiesNow({ channels: router, conversationId: CONV });
  assert.equal(sms.find(c => c.name === "speak").status, "not connected");
  assert.match(sms.find(c => c.name === "speak").what, /This thread is SMS/);
  assert.equal(sms.find(c => c.name === "hear_voice_notes").status, "live", "listening does not depend on the rail");

  thread();
  config.geminiKey = "";
  const mute = capabilitiesNow({ channels: router, conversationId: CONV });
  assert.equal(mute.find(c => c.name === "speak").status, "not connected");
  assert.match(mute.find(c => c.name === "speak").what, /never offer a voice note/);
  assert.equal(mute.find(c => c.name === "hear_voice_notes").status, "not connected");
  assert.match(mute.find(c => c.name === "hear_voice_notes").what, /ask them to type it/);
});
