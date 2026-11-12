// One identity on every surface (src/identity.js, REASON_ONE_IDENTITY): the name they gave their
// Reason, and one voice for calls and texted voice notes.
//
// Found 2026-11-12: the owner renamed his Reason "Huey" and no prompt anywhere knew; a voice note it
// texted him was Gemini's "Puck" (a man's voice) while his calls are OpenAI's "marin".
//
//   (1) the name they gave is saved by the remember tool on their own word
//   (2) it is in the block every surface reads — text turn, Web, Claude's call turn, the live voice's
//       brief, the per-call notes — and only for accounts the switch covers
//   (3) one person's name never reaches another's prompt; "Reason" clears it
//   (4) a texted voice note asks OpenAI's speech model for the SAME voice the live call uses
//   (5) when that cannot be made it falls back to the closest Gemini voice, never the old default
//   (6) switch off: the request is exactly what it was (Gemini, the install's voice)
//   (7) the voice_note_say tool hands the person's voice to the speaker
//   (8) nothing here changes a call: the live session's voice is still config.gptliveVoice
//
// No model, no network: every speech call is an injected fetch.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-identity-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_AUDIO_TMP = join(dir, "audio");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_AFCONVERT_BIN = process.execPath;

const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const identity = await import("../src/identity.js");
const rules = await import("../src/rules.js");
const voice = await import("../src/voice.js");
const { runTool } = await import("../src/tools.js");
const { memoryNotes } = await import("../src/memorynote.js");
const { callNotes } = await import("../src/calls/callmemory.js");
const gptlive = await import("../src/calls/gptlive.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");

const O = "dm:id-omari";   // the operator
const K = "dm:id-kojo";    // somebody invited
const AF = { kind: "afconvert", bin: "/usr/bin/afconvert" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM treat_rules; DELETE FROM threads; DELETE FROM calls; DELETE FROM outbox;");
  db.upsertAccount({ conversationId: O, channel: "fake", address: "+12025550121", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: K, channel: "fake", address: "+12025550122", name: "Kojo", isOperator: false });
  config.oneIdentity = "off";
  config.geminiKey = "gem-key";
  config.openaiKey = "oai-key";
  config.gptliveVoice = "marin";
  config.ttsVoice = "Puck";
  config.ttsCloseVoice = "Aoede";
});

const pcm = Buffer.alloc(48_000 * 2);
const converts = () => async (args) => { writeFileSync(args.at(-1), "caff-ish"); return { ok: true }; };
/** A fetch that answers both speech providers and records what each was asked. */
function speechNet({ openai = 200 } = {}) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes("/v1/audio/speech")) {
      asked.push({ provider: "openai", url: String(url), body, auth: init.headers.authorization });
      return openai === 200 ? { ok: true, status: 200, arrayBuffer: async () => pcm } : { ok: false, status: openai, arrayBuffer: async () => Buffer.alloc(0), text: async () => "no" };
    }
    asked.push({ provider: "gemini", url: String(url), body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16", data: pcm.toString("base64") } }] } }] }) };
  };
  return { asked, fetchImpl };
}

// ---------------------------------------------------------------- the name

test("(1) the name they gave is saved by remember on their own word, tidied, and can be changed", async () => {
  config.oneIdentity = "owner";
  const out = await runTool("remember", { about: "you", fact: "huey", kind: "your_name" }, { conversationId: O });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.name, "Huey");
  assert.match(out.note, /in texts, on the web and on calls/);
  assert.equal(identity.givenName(O), "Huey");
  assert.equal(identity.nameFor(O), "Huey");
  const again = await runTool("remember", { about: "you", fact: "Riley", kind: "your_name" }, { conversationId: O });
  assert.equal(again.was, "Huey");
  assert.equal(identity.nameFor(O), "Riley");
  // A sentence is not a name.
  const no = await runTool("remember", { about: "you", fact: "they want me to go by something a bit warmer", kind: "your_name" }, { conversationId: O });
  assert.equal(no.ok, false);
  assert.equal(identity.givenName(O), "Riley");
  // No fact row was written for it: it is who Reason is, not something about them.
  assert.equal(db.activeFacts(O).length, 0);
});

test("(2) the name is in the block every surface reads, for accounts the switch covers", async () => {
  identity.setGivenName(O, "Huey");
  identity.setGivenName(K, "Sunny");
  db.addRule(O, { rule: "Don't text before 9am", why: "said so", source: "they_said" });

  // Off: nothing changes anywhere.
  assert.equal(identity.identityNote(O), "");
  assert.doesNotMatch(rules.rulesNote(O), /Huey/);
  assert.equal(rules.rulesNote(K), "", "no rules and no name line: exactly the empty block it was");

  config.oneIdentity = "owner";
  const note = rules.rulesNote(O);
  assert.match(note, /^WHO YOU ARE TO THEM: they named you "Huey"\./);
  assert.match(note, /in their texts, on the web and on a phone call/);
  assert.match(note, /To anybody else — a business you ring, somebody you message for them — you are "Reason"/);
  assert.match(note, /HOW THEY WANT YOU TO TREAT THEM[^]*Don't text before 9am/, "their rules still follow it");
  assert.equal(rules.rulesNote(K), "", "'owner' is the operator only");
  assert.equal(identity.nameFor(K), "Reason");

  // A text or Web turn (the notes a turn is handed).
  const turn = (await memoryNotes(O, "what's your name again?", { log: () => {} })).join("\n");
  assert.match(turn, /they named you "Huey"/);
  // Their own phone call: the notes a live session loads, and the live voice's brief.
  const call = db.createCall(O, { provider: "gptlive", toNumber: "+12025550121", isOwner: true, goal: "Omari called Reason", facts: [], direction: "in", state: "in_progress" });
  assert.match(callNotes(call), /they named you "Huey"/);
  assert.match(gptlive.preCallBrief(call), /they named you "Huey"/);

  config.oneIdentity = "on";
  assert.match(rules.rulesNote(K), /^WHO YOU ARE TO THEM: they named you "Sunny"\.[^\n]*$/);
});

test("(3) one person's name never reaches another's prompt; 'Reason' clears it; a call to a business never carries it", () => {
  config.oneIdentity = "on";
  identity.setGivenName(O, "Huey");
  assert.equal(rules.rulesNote(K), "");
  assert.equal(identity.nameFor(K), "Reason");
  identity.setGivenName(O, "Reason");
  assert.equal(identity.givenName(O), "");
  assert.equal(rules.rulesNote(O), "");
  identity.setGivenName(O, "Huey");
  const errand = db.createCall(O, { provider: "gptlive", toNumber: "+12125550100", isOwner: false, goal: "book a table", facts: [], state: "in_progress" });
  assert.equal(callNotes(errand), "", "sealed: the other side's call carries nothing of theirs");
  assert.doesNotMatch(gptlive.voiceInstructionsFor(errand, {}), /Huey/);
});

// ---------------------------------------------------------------- the voice

test("(4) a texted voice note asks for the same voice the live call uses, on the call's provider", async () => {
  config.oneIdentity = "owner";
  const as = identity.noteVoiceFor(O);
  assert.deepEqual({ provider: as.provider, voice: as.voice, model: as.model }, { provider: "openai", voice: config.gptliveVoice, model: config.openerTtsModel });
  const net = speechNet();
  const out = await voice.speak({ text: "on my way, ten minutes", as, converter: AF, convert: converts(), fetchImpl: net.fetchImpl, tmpDir: join(dir, "audio") });
  assert.equal(out.ok, true, out.error);
  assert.equal(net.asked.length, 1);
  assert.equal(net.asked[0].provider, "openai");
  assert.equal(net.asked[0].body.voice, "marin");
  assert.equal(net.asked[0].body.input, "on my way, ten minutes", "the words and nothing else are spoken");
  assert.match(net.asked[0].body.instructions, /young woman with a light, natural British \(London\) accent/, "the live voice's own direction");
  assert.equal(net.asked[0].body.response_format, "pcm");
  assert.equal(net.asked[0].auth, "Bearer oai-key");
  assert.deepEqual({ voice: out.voice, provider: out.provider, matched: out.matched, seconds: out.seconds }, { voice: "marin", provider: "openai", matched: true, seconds: 2 });
  // The voice follows the call's: change the call voice and the note changes with it.
  config.gptliveVoice = "cedar";
  const net2 = speechNet();
  await voice.speak({ text: "hi", as: identity.noteVoiceFor(O), converter: AF, convert: converts(), fetchImpl: net2.fetchImpl, tmpDir: join(dir, "audio") });
  assert.equal(net2.asked[0].body.voice, "cedar");
});

test("(5) when the call's voice cannot be made, the closest Gemini voice — never the old default", async () => {
  config.oneIdentity = "on";
  const net = speechNet({ openai: 500 });
  const out = await voice.speak({ text: "running late", as: identity.noteVoiceFor(K), converter: AF, convert: converts(), fetchImpl: net.fetchImpl, tmpDir: join(dir, "audio") });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(net.asked.map(a => a.provider), ["openai", "gemini"]);
  assert.equal(net.asked[1].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Aoede");
  assert.deepEqual({ voice: out.voice, provider: out.provider, matched: out.matched }, { voice: "Aoede", provider: "gemini", matched: false });
  assert.match(out.fell_back, /speech 500/);
  // No OpenAI key at all: the closest Gemini voice straight away.
  config.openaiKey = "";
  assert.deepEqual(identity.noteVoiceFor(K), { provider: "gemini", voice: "Aoede" });
  const net2 = speechNet();
  await voice.speak({ text: "hi", as: identity.noteVoiceFor(K), converter: AF, convert: converts(), fetchImpl: net2.fetchImpl, tmpDir: join(dir, "audio") });
  assert.deepEqual(net2.asked.map(a => a.provider), ["gemini"]);
  assert.equal(net2.asked[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Aoede");
  // The call's voice with no Gemini key: OpenAI alone can speak, and its failure is said plainly.
  config.openaiKey = "oai-key";
  assert.equal(voice.speakingStatus({ apiKey: "", converter: AF, as: identity.noteVoiceFor(K) }).ok, true);
  const dead = await voice.speak({ text: "hi", apiKey: "", as: identity.noteVoiceFor(K), converter: AF, convert: converts(), fetchImpl: speechNet({ openai: 401 }).fetchImpl, tmpDir: join(dir, "audio") });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /Send it as text instead/);
});

test("(6) switch off: the request is exactly what it was", async () => {
  assert.equal(identity.noteVoiceFor(O), null);
  const net = speechNet();
  const out = await voice.speak({ text: "hello", converter: AF, convert: converts(), fetchImpl: net.fetchImpl, tmpDir: join(dir, "audio") });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(net.asked.map(a => a.provider), ["gemini"]);
  assert.equal(net.asked[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
  assert.equal(out.voice, "Puck");
  assert.equal(voice.speakingStatus({ apiKey: "", converter: AF }).ok, false, "without the switch, no Gemini key still means no voice");
});

test("(7) voice_note_say hands the person's own voice to the speaker, and only when the switch covers them", async () => {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => "ok" });
  const router = new Router({ runtime, log: () => {} });
  router.register(new FakeChannel({ number: "+15122164639" }));
  db.upsertThread({ conversationId: O, channel: "fake", address: "+12025550121", isOwner: true, service: "iMessage", lastInboundId: "H-1" });
  db.upsertThread({ conversationId: K, channel: "fake", address: "+12025550122", isOwner: false, service: "iMessage", lastInboundId: "H-2" });
  const heard = [];
  const speak = async (args) => { heard.push(args); const file = join(dir, `said-${heard.length}.caf`); writeFileSync(file, "caff"); return { ok: true, file, seconds: 1, voice: args.as?.voice ?? "Puck", provider: args.as?.provider ?? "gemini", matched: !!args.as }; };
  config.oneIdentity = "owner";
  await runTool("voice_note_say", { text: "morning" }, { conversationId: O, channels: router, speak });
  await runTool("voice_note_say", { text: "morning" }, { conversationId: K, channels: router, speak });
  assert.equal(heard.length, 2, "both notes were spoken");
  assert.equal(heard.filter(h => h.as).length, 1, "the operator's note only carries the call's voice");
  const mine = heard.find(h => h.as);
  assert.equal(mine.as.voice, "marin");
  assert.equal(mine.text, "morning");
  // Whatever the thread plumbing, the choice itself is per person:
  assert.equal(identity.noteVoiceFor(O).voice, "marin");
  assert.equal(identity.noteVoiceFor(K), null);
});

test("(8) nothing here sets a call's voice: the live session still speaks in config.gptliveVoice", () => {
  config.oneIdentity = "on";
  identity.setGivenName(O, "Huey");
  assert.equal(identity.callVoiceFor(O), config.gptliveVoice);
  assert.equal(identity.callVoiceFor(K), config.gptliveVoice);
});
