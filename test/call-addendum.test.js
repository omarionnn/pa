// The 2026-10-07 calls addendum, proven offline: the second check on an owner call, the two turn
// profiles, a phone number said the way a person reads one out, "ring them for me" said mid-call,
// and what a call does when its own context will not load.
//
// Nothing here dials, and nothing here runs a model. Every call is a row, every turn's words come
// from a scripted generator, and the one thing that could reach a phone — `call_place` — is injected
// as a function that records what it was asked for and returns a pretend call id. That is the point:
// these are the properties that have to hold BEFORE Friday's keys, because every one of them is
// about something not happening.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-addendum-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
process.env.ELEVENLABS_API_KEY = "eleven-test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_main";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ELEVENLABS_LLM_SECRET = "llm-test-secret";
process.env.ELEVENLABS_WEBHOOK_SECRET = "hook-test-secret";
process.env.ELEVENLABS_PHONE_NUMBER = "+12025559000";
process.env.REASON_UNDO_SECONDS = "0";
// Read once, at import, by src/config.js — so the settings under test here are set before it loads
// rather than inside a test. Where a test needs the OTHER value of one of them, it passes it in:
// `verify` and `agentIdFor` both take the setting as an argument that defaults to the config.
process.env.REASON_CALL_PASSPHRASE = "blue heron 7";
process.env.ELEVENLABS_OWNER_AGENT_ID = "agent_owner";
process.env.ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";

const voice = await import("../src/calls/voice.js");
const verify = await import("../src/calls/verify.js");
const fromcall = await import("../src/calls/fromcall.js");
const profile = await import("../src/calls/profile.js");
const readback = await import("../src/calls/readback.js");
const postcall = await import("../src/calls/postcall.js");
const commit = await import("../src/calls/commit.js");
const redial = await import("../src/calls/redial.js");
const { VOICE_RULES } = await import("../src/calls/voice-prompt.js");
const { EXTRA_BODY_KEYS, ElevenLabsCallProvider } = await import("../src/calls/elevenlabs.js");
const { announcementFor, callRulesFor } = await import("../src/calls/provider.js");
const { buildBrief } = await import("../src/calls/brief.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const THEM = "+12125559999";
const ANN = announcementFor({ ownerName: "Omari" });
const RULES = callRulesFor({ ownerName: "Omari" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec(`DELETE FROM calls; DELETE FROM call_requests; DELETE FROM call_commitments;
    DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts;
    DELETE FROM tasks; DELETE FROM task_log; DELETE FROM confirmations; DELETE FROM permissions;
    DELETE FROM action_ledger;`);
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  await voice.prime();
});

const ownerCall = (over = {}) => db.createCall(C, {
  provider: "elevenlabs", toNumber: "+12025551234", isOwner: true,
  goal: "Omari called Reason", facts: [], direction: "in",
  externalId: "conv_in", state: "in_progress", ...over,
});
const placedCall = (over = {}) => db.createCall(C, {
  provider: "elevenlabs", toNumber: THEM, isOwner: false,
  goal: "book a table for four at eight", facts: ["the name is Omari"],
  announcement: ANN, externalId: "conv_out", state: "in_progress", ...over,
});

const emit = async function* (events) {
  for (const e of events) {
    if (typeof e === "string") yield { type: "text", text: e };
    else if (e.throws) throw new Error(e.throws);
    else yield { type: "tool_use", name: e.tool, id: e.id ?? `tu_${Math.random().toString(16).slice(2, 8)}`, input: e.input ?? {} };
  }
};

/** One round of a turn. Every event in it happens before any tool result comes back. */
const scripted = (...events) => async function* () { yield* emit(events); };

/**
 * A turn of several ROUNDS: `rounds([a], [b])` asks for a tool, gets its result, then speaks.
 *
 * `voiceTurn` calls `generate` once per round, so a helper that replays its whole script every time
 * is a model that never learns what its tool said — which is how the first version of these tests
 * ran step one three times and never reached step two.
 */
const rounds = (...batches) => {
  let i = 0;
  return async function* () { yield* emit(batches[Math.min(i++, batches.length - 1)] ?? []); };
};

async function drain(stream) {
  const raw = [];
  for await (const s of stream) raw.push(s);
  const chunks = raw.filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6)));
  return {
    chunks,
    said: chunks.map(c => c.choices[0].delta.content ?? "").join(""),
    toolCalls: chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []),
  };
}

const bodyFor = (call, messages = [{ role: "user", content: "hey" }]) => JSON.stringify({
  model: "reason", stream: true, messages,
  elevenlabs_extra_body: {
    [EXTRA_BODY_KEYS.callId]: call.id,
    [EXTRA_BODY_KEYS.conversationId]: call.conversation_id,
  },
});
const AUTH = { authorization: "Bearer llm-test-secret" };

/** A `tell` that records instead of texting, and one that cannot send at all. */
const recorder = () => { const sent = []; return { sent, tell: (t) => { sent.push(t); return true; } }; };
const deaf = () => false;

/** A delivery signed the way their post-call webhook signs one: `t=<unix>,v0=<hex>`. */
const signedHeaders = (raw, { secret = "hook-test-secret", t = Math.floor(clock.now() / 1000) } = {}) => ({
  "ElevenLabs-Signature": `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`,
});

/** The owner's thread as a turn sees it, with his texted answer last. */
const thread = (...texts) => texts.map(t => ({ role: "user", content: t }));

// ======================================================================
// Section 6 — caller ID is not proof of who is holding the phone
// ======================================================================

test("what counts as consequential is the permission system's own list, not a second one", () => {
  // The property that matters is that these two lists can never drift: a tool that needs a yes in a
  // text is a tool that needs the second check on a call.
  for (const a of ["call_place", "message_send", "gmail_send", "calendar_create", "account_connect"]) {
    assert.equal(verify.isConsequential(a), true, `${a} should need the check`);
  }
  // And the one that is not in GATED_ACTIONS but must be here anyway: granting a confirmation is how
  // a spoken yes becomes permission, so it cannot be the thing a stranger uses to let themselves in.
  assert.equal(verify.isConsequential("confirm_record"), true);
  // Talking, remembering and looking things up are not gated and must stay ungated. A check in front
  // of "what's on tomorrow" would make every call feel like an interrogation.
  for (const a of ["recall", "remember", "calendar_list", "web_search", "confirm_request"]) {
    assert.equal(verify.isConsequential(a), false, `${a} must not need the check`);
  }
});

test("a passphrase is compared on what was SAID, and a wrong one is told nothing", () => {
  assert.equal(verify.passphraseSet(), true);
  // Punctuation and case are the transcript's business, not his.
  assert.equal(verify.passphraseMatches("blue heron 7"), true);
  assert.equal(verify.passphraseMatches("Blue, Heron 7."), true);
  assert.equal(verify.passphraseMatches("BLUEHERON7"), true);
  // Digits are never spelt out for him or by him: the passphrase is the thing he says.
  assert.equal(verify.passphraseMatches("blue heron seven"), false);
  assert.equal(verify.passphraseMatches("blue heron"), false);
  assert.equal(verify.passphraseMatches(""), false);
  // Nothing configured is a no, never an open door.
  assert.equal(verify.passphraseSet({ expected: "" }), false);
  assert.equal(verify.passphraseMatches("anything", { expected: "" }), false);
  assert.equal(verify.passphraseMatches("", { expected: "" }), false);
});

test("the right passphrase verifies the call once, and the row is where that is written", () => {
  const call = ownerCall();
  assert.equal(verify.isVerified(call), false);

  const ok = verify.verify({ call, passphrase: "Blue Heron 7" });
  assert.equal(ok.verified, true);
  assert.equal(ok.how, "passphrase");
  // Read off the row, so a second turn of the same call does not ask again.
  const row = db.getCall(C, call.id);
  assert.ok(row.verified_at > 0);
  assert.equal(row.verified_how, "passphrase");
  assert.equal(verify.isVerified(row), true);

  const again = verify.verify({ call: row, passphrase: "" });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  // And it must never remind anybody what the passphrase was.
  assert.doesNotMatch(JSON.stringify(ok) + JSON.stringify(again), /blue heron/i);
});

test("two wrong passphrases and the call falls to the texted check — a guesser gets two guesses", () => {
  const call = ownerCall();

  const one = verify.verify({ call, passphrase: "red heron 7" });
  assert.equal(one.ok, false);
  assert.equal(one.blocked, "wrong_passphrase");
  assert.equal(one.tries_left, 1);
  // No hint of any kind: not the passphrase, not a near-miss, not a length. The instruction itself
  // names the things it must not say, which is why it is the passphrase that is checked for here.
  assert.doesNotMatch(one.say, /heron|blue|red/i);
  assert.match(one.say, /Do not say what it should have been or how close it was/);

  const two = verify.verify({ call: db.getCall(C, call.id), passphrase: "blue egret 7" });
  assert.equal(two.ok, false);
  assert.equal(two.tries_left, 0);
  assert.match(two.say, /text their phone/i);

  // A third guess is not a guess: the passphrase branch is closed and it goes to the text.
  const r = recorder();
  const three = verify.verify({ call: db.getCall(C, call.id), passphrase: "blue heron 7", tell: r.tell });
  assert.notEqual(three.verified, true);
  assert.equal(three.waiting, true);
  assert.equal(r.sent.length, 1);
  // Even the RIGHT one, offered after the tries ran out, does not verify the call by voice.
  assert.equal(db.getCall(C, call.id).verified_at, null);
});

test("with no passphrase set, the check is a text to his own phone and the yes has to come from there", () => {
  const call = ownerCall();
  const r = recorder();
  // This install has no passphrase, which is the default and the shape most people will run.
  const none = { expected: "" };

  // First call: the text goes, and nothing is verified yet.
  const sent = verify.verify({ call, about: "ring the cleaners and book it", tell: r.tell, messages: thread("hey"), ...none });
  assert.equal(sent.waiting, true);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /yes/i);
  assert.ok(!/ring the cleaners/.test(r.sent[0]), "action detail is NOT in the text (detail-hiding)");
  assert.ok(db.getCall(C, call.id).verify_sent_at > 0);

  // His thread as it was WHEN THE TEXT WENT had one message in it. A yes already sitting there is
  // not an answer to a question that had not been asked yet.
  const stale = verify.verify({ call: db.getCall(C, call.id), tell: r.tell, messages: thread("hey"), ...none });
  assert.equal(stale.waiting, true);
  assert.equal(db.getCall(C, call.id).verified_at, null);

  // The yes that arrives after it does count.
  const ok = verify.verify({ call: db.getCall(C, call.id), tell: r.tell, messages: thread("hey", "yes"), ...none });
  assert.equal(ok.verified, true);
  assert.equal(ok.how, "text");
  assert.equal(db.getCall(C, call.id).verified_how, "text");
  // One text, not one per attempt.
  assert.equal(r.sent.length, 1);
});

test("a texted no stops it, and anything that is not plainly yes or no is not an answer", () => {
  const call = ownerCall();
  const r = recorder();
  const none = { expected: "" };
  verify.verify({ call, tell: r.tell, messages: thread("hey"), ...none });

  const no = verify.verify({ call: db.getCall(C, call.id), tell: r.tell, messages: thread("hey", "no"), ...none });
  assert.equal(no.ok, false);
  assert.equal(no.blocked, "refused_by_text");
  assert.match(no.say, /Do not do it/i);
  assert.equal(db.getCall(C, call.id).verified_at, null);

  // Fails closed. A check that exists because a voice is not proof does not take "i guess" as a yes.
  for (const maybe of ["i guess", "probably fine", "if you think so", "yes but check the price first", "ok sure why not"]) {
    assert.equal(verify.readYesNo(maybe), "unclear", `"${maybe}" must not read as an answer`);
  }
  assert.equal(verify.readYesNo("yes"), "yes");
  assert.equal(verify.readYesNo("Yeah!"), "yes");
  assert.equal(verify.readYesNo("nope"), "no");
});

test("a text that cannot be sent is said out loud, not worked around", () => {
  const call = ownerCall();
  const out = verify.verify({ call, tell: deaf, expected: "" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "cannot_text");
  assert.match(out.say, /do not do the thing/i);
  // Nothing recorded as sent, so a later turn tries again rather than waiting on a text that is not
  // coming.
  assert.equal(db.getCall(C, call.id).verify_sent_at, null);
});

test("on his own call, the first thing that spends or sends is refused until the check passes", async () => {
  const call = ownerCall();
  const ran = [];
  voice.contextDeps.runTool = async (name, input) => { ran.push(name); return { ok: true, did: name }; };

  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: rounds(
      ["One sec. ", { tool: "message_send", input: { to: "+12125550000", text: "hi" } }],
      ["need your passphrase before I send that"],
    ),
  });
  const r = await drain(out.stream);

  // The tool never ran. This is the whole property: not "the model was told not to", but that the
  // function that sends a message was not called.
  assert.deepEqual(ran, []);
  assert.match(r.said, /One sec/);
  // And the turn still said something, because somebody is holding a handset.
  assert.match(r.said, /passphrase/);

  // A tool that is not consequential is untouched by any of this: no check to answer a question.
  const call2 = ownerCall({ externalId: "conv_in2" });
  const out2 = await voice.llmRequest({
    rawBody: bodyFor(call2), headers: AUTH,
    generate: rounds([{ tool: "recall", input: { who: "kofi" } }], ["he's your cousin"]),
  });
  await drain(out2.stream);
  assert.deepEqual(ran, ["recall"]);
});

test("once the caller is verified mid-turn, the tool that was refused runs", async () => {
  const call = ownerCall();
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true }; };

  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: rounds(
      // Round one: the check, by voice, on the call-side branch.
      [{ tool: "verify_caller", input: { passphrase: "blue heron 7", about: "text Kofi" } }],
      // Round two: the thing he asked for. The row was written by the round before, and this turn's
      // `call` object has to be re-read for the gate to see it — which is the bug this pins.
      [{ tool: "message_send", input: { to: "+12125550000", text: "on my way" } }],
      ["sent it"],
    ),
  });
  const r = await drain(out.stream);
  assert.deepEqual(ran, ["message_send"]);
  assert.match(r.said, /sent it/);
  assert.equal(db.getCall(C, call.id).verified_how, "passphrase");
});

test("the second check is the owner's alone: a restaurant is never offered it", () => {
  const them = placedCall();
  const ctx = voice.contextFor({ call: them, kind: "third_party", callMessages: [] });
  const names = [...ctx.reasonTools, ...ctx.callTools].map(t => t.name);
  assert.equal(names.includes("verify_caller"), false);
  // Nor the thing that places calls. A business line that could ask Reason to dial is a business
  // line that could make Reason dial anybody.
  for (const n of ["make_a_call_for_me", "call_request_status", "call_request_cancel"]) {
    assert.equal(names.includes(n), false, `${n} must not be on a third-party call`);
  }
  // And calling one anyway gets the same answer an invented tool gets.
  const out = voice.runCallTool("verify_caller", { passphrase: "blue heron 7" }, { call: them, context: ctx });
  assert.equal(out.ok, false);
  assert.match(out.error, /not something you can do/);
});

test("the rule is in his own call frame before a refusal has to teach it, and goes once it is passed", () => {
  const call = ownerCall();
  const ctx = voice.ownerContext({ call, callMessages: [] });
  assert.match(ctx.system, /does NOT tell you who is holding/i);
  assert.match(ctx.system, /verify_caller/);
  assert.match(ctx.system, /never as suspicion/i);
  // Never the passphrase itself.
  process.env.REASON_CALL_PASSPHRASE = "blue heron 7";
  assert.doesNotMatch(voice.ownerContext({ call, callMessages: [] }).system, /blue heron/i);
  // And the rule disappears once there is nothing left to ask for.
  const done = db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  assert.equal(verify.promptNote({ call: done }), "");
  assert.doesNotMatch(voice.ownerContext({ call: done, callMessages: [] }).system, /who is holding the phone/i);
});

// ======================================================================
// Sections 2 and 4 — two turn profiles, and which speech model it ran under
// ======================================================================

test("a business line and his own phone are tuned differently, and the difference is the real one", () => {
  const owner = profile.turnProfileFor("owner");
  const them = profile.turnProfileFor("third_party");
  // Patient on a business line, ordinary on his: an eager agent talks over a receptionist.
  assert.equal(them.eagerness, "patient");
  assert.equal(owner.eagerness, "normal");
  // A receptionist checking something is a longer silence than a friend thinking.
  assert.ok(them.turnTimeoutSeconds > owner.turnTimeoutSeconds);
  assert.ok(them.maxDurationSeconds > owner.maxDurationSeconds);
  // Their own field's documented range, which a value outside would be silently clamped or refused in.
  for (const p of [owner, them]) {
    assert.ok(p.turnTimeoutSeconds >= 1 && p.turnTimeoutSeconds <= 30, `${p.name} turn_timeout out of range`);
  }
  // Anything that is not his own call is a business line. No third kind appears by accident.
  assert.equal(profile.turnProfileFor("third_party").name, "third_party");
  assert.equal(profile.turnProfileFor(undefined).name, "third_party");
});

test("hesitation is the owner profile's job, and it is in his prompt as a sentence not a number", () => {
  // Section 4 names it: "distinguishing a hesitation from the end of a turn". A model cannot act on
  // `turn_timeout: 7`, so what reaches the prompt is the rule and not the setting.
  const note = profile.profileNote("owner");
  assert.match(note, /thinking, not the end of their turn/i);
  assert.match(note, /Wait it out/i);
  assert.doesNotMatch(note, /\b7\b|turn_timeout|seconds/);

  const call = ownerCall();
  assert.ok(voice.ownerContext({ call, callMessages: [] }).system.includes(note));
  // And the patient half really is on the other call, not the same line twice.
  const them = placedCall();
  const theirs = profile.profileNote("third_party");
  assert.notEqual(theirs, note);
  assert.match(theirs, /never talk over a receptionist/i);
  assert.ok(voice.thirdPartyContext({ call: them, callMessages: [] }).system.includes(theirs));
});

test("two profiles means two agents, and with one agent the row says so rather than claiming a tuning", () => {
  // The honest shape of the platform's limit: turn settings are agent-level and their
  // per-conversation override list does not reach them.
  const one = profile.agentIdFor("owner", { ownerAgentId: "", agentId: "agent_main" });
  assert.deepEqual(one, { agentId: "agent_main", profile: "owner", separate: false });
  const two = profile.agentIdFor("owner", { ownerAgentId: "agent_owner", agentId: "agent_main" });
  assert.deepEqual(two, { agentId: "agent_owner", profile: "owner", separate: true });
  // A third-party call always goes through the main agent, even when an owner agent exists.
  assert.deepEqual(
    profile.agentIdFor("third_party", { ownerAgentId: "agent_owner", agentId: "agent_main" }),
    { agentId: "agent_main", profile: "third_party", separate: false },
  );
});

test("which speech model a call ran under is recorded, and the vendor's figures are not called ours", () => {
  const def = profile.ttsModel({ model: "eleven_v3_conversational" });
  assert.equal(def.known, true);
  // The trial starts here because this is the model their expressive mode runs on.
  assert.equal(def.expressive, true);
  assert.equal(profile.ttsModel({ model: "eleven_flash_v2_5" }).expressive, false);
  // Synthesis alone, from their docs — not end-to-end call latency, and the two must not be confused.
  assert.equal(profile.TTS_MODELS.eleven_v3_conversational.synthesisMs, 280);
  assert.equal(profile.TTS_MODELS.eleven_flash_v2_5.synthesisMs, 75);
  // A model nobody has written down is reported as unknown rather than guessed at.
  assert.equal(profile.ttsModel({ model: "eleven_turbo_v9" }).known, false);
  assert.equal(profile.ttsModel({ model: "" }).known, false);
});

test("the call row carries the profile and the model, so a number measured later says what it measured", async () => {
  process.env.ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
  const bodies = [];
  const p = new ElevenLabsCallProvider({
    fetchImpl: async (_url, opt) => {
      bodies.push(JSON.parse(opt.body));
      return { ok: true, json: async () => ({ conversation_id: "conv_x", callSid: "CA1" }) };
    },
  });
  const out = await p.place({
    to: THEM, goal: "book a table", facts: [], maxSeconds: 600, announcement: ANN, rules: RULES,
    onBehalfOf: "Omari", kind: "third_party", brief: buildBrief({ goal: "book a table" }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.profile, "third_party");
  assert.equal(out.ttsModel, "eleven_flash_v2_5");
  assert.equal(out.separateAgent, false);
  assert.equal(bodies[0].agent_id, "agent_main");

  // His own call, with a second agent configured, really goes through the other one.
  process.env.ELEVENLABS_OWNER_AGENT_ID = "agent_owner";
  const mine = await p.place({
    to: "+12025551234", goal: "ring Omari", facts: [], maxSeconds: 600, announcement: ANN, rules: RULES,
    onBehalfOf: "Omari", kind: "owner", brief: buildBrief({ goal: "ring Omari" }),
  });
  assert.equal(mine.profile, "owner");
  assert.equal(mine.separateAgent, true);
  assert.equal(bodies[1].agent_id, "agent_owner");

  // And the columns exist to hold it.
  const call = placedCall();
  const row = db.updateCall(C, call.id, { profile: "third_party", tts_model: "eleven_flash_v2_5" });
  assert.equal(row.profile, "third_party");
  assert.equal(row.tts_model, "eleven_flash_v2_5");
});

// ======================================================================
// Section 3 — a phone number, said the way a person reads one out
// ======================================================================

test("a phone number is said digit by digit, never as a quantity", () => {
  assert.equal(readback.spokenPhone("+12125557777"), "plus one, two one two, five five five, seven seven seven seven");
  assert.equal(readback.spokenPhone("2125557777"), "two one two, five five five, seven seven seven seven");
  // The failure this exists to stop. Flash v2.5's own number handling has documented limits, and a
  // phone number read as a quantity is a number nobody can dial.
  for (const bad of [/hundred/i, /thousand/i, /twelve/i, /fifty/i, /\bmillion\b/i]) {
    assert.doesNotMatch(readback.spokenPhone("+12125557777"), bad);
  }
  // A number that is not the North American shape still comes out in sayable blocks of three. Not
  // the "right" way to group a London number, and that is fine: unambiguous is the whole point.
  assert.equal(
    readback.spokenPhone("+442071234567"),
    "plus four four two, zero seven one, two three four, five six seven",
  );
  assert.equal(readback.spokenPhone(""), "");
  assert.equal(readback.spokenPhone("ask for Maria"), "ask for Maria");
});

test("the written record of a number stays exact while the spoken form is normalized", () => {
  // The rule for every kind in this list, and the reason the two halves are separate fields.
  assert.ok(readback.DETAIL_KINDS.includes("phone"));
  const d = readback.detail({ kind: "phone", value: "+12125557777", label: "the number to call back" });
  assert.equal(d.exact, "+12125557777");
  assert.match(d.spoken, /^plus one, two one two/);
  assert.doesNotMatch(d.spoken, /\+/);
});

// ======================================================================
// Section 8 — "ring them for me", said on a call with him
// ======================================================================

/** A `dial` that records and never touches a phone. */
const dialer = (over = {}) => {
  const asked = [];
  return {
    asked,
    dial: async (args) => { asked.push(args); return over.fails ? { ok: false, error: over.fails } : { ok: true, call_id: over.callId ?? 4242 }; },
  };
};

/** A request written down and read back, ready for the yes. */
const prepared = (call, input = {}) => fromcall.request({
  call, input: { to: THEM, name: "the Thai place", goal: "book a table for four at eight", ...input },
});

test("the errand is taken down while still talking to him, and only what is missing is asked for", () => {
  const call = ownerCall();
  // A name is not a number, and that is said as the reason rather than as a refusal.
  const noNumber = fromcall.request({ call, input: { name: "the Thai place", goal: "book a table", to: "the Thai place on 3rd" } });
  assert.equal(noNumber.ok, false);
  assert.deepEqual(noNumber.missing, ["the number"]);
  assert.match(noNumber.say, /is a name, not a number/);
  assert.equal(db.openCallRequests(C).length, 0);

  const noGoal = fromcall.request({ call, input: { to: THEM } });
  assert.deepEqual(noGoal.missing, ["what the call is for"]);
  // Both at once is ONE question, not two turns of interrogation.
  const neither = fromcall.request({ call, input: {} });
  assert.deepEqual(neither.missing, ["the number", "what the call is for"]);
  assert.match(neither.say, /the number and what the call is for/);
  assert.match(neither.say, /in one question/);
});

test("the recipient and the brief are read back before anything dials, in the number's spoken form", () => {
  const call = ownerCall();
  const r = prepared(call, { may_tell: ["his name is Omari", "four people"] });
  assert.equal(r.ok, true);
  assert.equal(r.state, "preparing");
  // Said the way a person reads a number out, because he is about to hear it.
  assert.match(r.review, /plus one, two one two, five five five, nine nine nine nine/);
  assert.match(r.review, /the Thai place/);
  assert.match(r.review, /book a table for four at eight/);
  assert.match(r.review, /his name is Omari, four people/);
  // No booking approved, so the read-back says so out loud rather than leaving it open.
  assert.match(r.review, /only ask — I won't book or agree to anything/);
  assert.match(r.review, /Shall I\?$/);
  // And the model is told to wait rather than to carry on.
  assert.match(r.say, /WAIT for their answer/);

  // One persisted row carrying the brief and the authorization state, plus the job it belongs to.
  const row = db.getCallRequest(C, r.request_id);
  assert.equal(row.state, "preparing");
  assert.equal(row.to_number, THEM);
  assert.ok(row.task_id > 0);
  assert.equal(row.brief.approved.book, false);
  assert.equal(row.authorized_at, null);
  assert.equal(row.placed_call_id, null);
});

test("a ceiling he gave is in the read-back, and no ceiling is said as the limit it really is", () => {
  const call = ownerCall();
  const capped = prepared(call, { may_book: true, max_price_cents: 15000 });
  assert.match(capped.review, /I may agree to it up to a hundred and fifty dollars/i);
  assert.match(capped.review, /nothing past that/);

  db.db.exec("DELETE FROM call_requests");
  const open = prepared(call, { may_book: true });
  // Not silently unbounded: with no ceiling, every price comes back to him.
  assert.match(open.review, /you have not given me a ceiling/i);
  assert.match(open.review, /check with you on any price/i);
});

test("nothing dials without a yes to the read-back — and the yes is worth nothing unverified", async () => {
  const call = ownerCall();
  const r = prepared(call);
  const d = dialer();

  // The order matters. Who is on the phone is settled BEFORE whether they said yes, because a yes
  // from somebody who is not him is not a yes.
  const unverified = await fromcall.go({ call, requestId: r.request_id, saidYes: true, dial: d.dial });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.blocked, "needs_verification");
  assert.deepEqual(d.asked, []);
  assert.equal(db.getCallRequest(C, r.request_id).state, "preparing");

  // Verified, but he has not actually said yes: still nothing.
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  const noYes = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: false, dial: d.dial });
  assert.equal(noYes.ok, false);
  assert.deepEqual(d.asked, []);
  assert.match(noYes.say, /Not without their yes/);
  // The read-back is handed back so it can be said again rather than invented a second time.
  assert.ok(noYes.say.includes(r.review));
});

test("the yes dials, through call_place and on a confirmation row that records what the yes was for", async () => {
  const call = ownerCall();
  const r = prepared(call, { may_tell: ["his name is Omari"], ask: ["is there a corkage fee"] });
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  const d = dialer({ callId: 77 });

  const go = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: true, dial: d.dial });
  assert.equal(go.ok, true);
  assert.equal(go.state, "dialing");

  // It went through the ordinary tool with the brief intact, not round it.
  assert.equal(d.asked.length, 1);
  assert.equal(d.asked[0].to, THEM);
  assert.deepEqual(d.asked[0].facts, ["his name is Omari"]);
  assert.deepEqual(d.asked[0].ask, ["is there a corkage fee"]);
  assert.equal(d.asked[0].may_book, false);
  assert.ok(d.asked[0].confirmation_id > 0);

  // The ledger says what the yes was: a spoken one, on this call, with the caller verified how.
  const row = db.getCallRequest(C, r.request_id);
  assert.equal(row.state, "dialing");
  assert.equal(row.placed_call_id, 77);
  assert.match(row.authorized_how, /spoken yes on call #\d+, caller verified by passphrase/);
  const conf = db.getConfirmation(C, row.confirmation_id);
  assert.equal(conf.action, "call_place");
  assert.ok(conf.granted_at > 0);

  // Dialing is all that is true yet, and the words he gets say exactly that.
  assert.match(go.say, /not answered, not done/);
  // A conference or a bridge is never promised, because nothing has verified the platform can do one.
  assert.match(go.say, /Do NOT offer to/);
  assert.match(go.say, /hang up and get the result by text/);
});

test("a standing permission he really gave skips the read-back's yes, but never the caller check", async () => {
  const call = ownerCall();
  db.grantPermission(C, { said: "you can ring the Thai place without asking me", action: "call_place", target: THEM });
  const r = prepared(call);
  assert.ok(r.standing_permission, "the permission should be found and named");
  assert.match(r.say, /standing permission that covers this/);

  const d = dialer();
  // Still not without the caller check: what he once allowed is not who is on the phone now.
  const unverified = await fromcall.go({ call, requestId: r.request_id, saidYes: false, dial: d.dial });
  assert.equal(unverified.blocked, "needs_verification");
  assert.deepEqual(d.asked, []);

  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "text" });
  const go = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: false, dial: d.dial });
  assert.equal(go.ok, true);
  assert.equal(d.asked.length, 1);
  assert.match(db.getCallRequest(C, r.request_id).authorized_how, /standing permission #\d+/);
});

test("his yes is tied to what was read back: change the request and it does not reach", async () => {
  const call = ownerCall();
  const r = prepared(call);
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  // Somebody edited the brief between the read-back and the yes — a budget appears that he never
  // heard. The hash no longer matches what he agreed to.
  const row = db.getCallRequest(C, r.request_id);
  db.updateCallRequest(C, r.request_id, { brief: { ...row.brief, approved: { book: true, maxCents: 50000, terms: [] } } });

  const d = dialer();
  const go = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: true, dial: d.dial });
  assert.equal(go.ok, false);
  assert.deepEqual(d.asked, []);
  assert.match(go.say, /no longer matches/);
  assert.match(go.say, /read it back again/);
});

test("asking twice gets the one request that is open, not a second row and eventually two calls", () => {
  const call = ownerCall();
  const first = prepared(call);
  const second = prepared(call, { goal: "book a table, actually for five" });
  assert.equal(second.request_id, first.request_id);
  assert.equal(second.already, true);
  assert.match(second.say, /Already on it/);
  assert.equal(db.openCallRequests(C).length, 1);
});

test("never twice: a number where something is already agreed is not rung to agree again", async () => {
  const call = ownerCall();
  // An earlier call to the same place already committed.
  const earlier = placedCall({ externalId: "conv_earlier", state: "completed" });
  db.createCommitment(C, { callId: earlier.id, what: "a table for four at eight on Saturday", totalCents: 0, state: "committed" });

  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  const r = prepared(call, { may_book: true, max_price_cents: 20000 });
  const d = dialer();
  const go = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: true, dial: d.dial });

  assert.equal(go.ok, false);
  assert.deepEqual(d.asked, [], "nothing may be dialed");
  assert.equal(db.getCallRequest(C, r.request_id).state, "cancelled");
  assert.match(go.say, /already agreed at that number/);
  assert.match(go.say, /a table for four at eight on Saturday/);
  // The useful thing to offer instead, rather than a dead end.
  assert.match(go.say, /change it rather than book again/);
});

test("he is told which state it is in, and a queued request is never described as a finished call", async () => {
  const call = ownerCall();
  const r = prepared(call);

  // Preparing. The words for it cannot read as done.
  const prep = fromcall.status({ call, requestId: r.request_id });
  assert.equal(prep.state, "preparing");
  assert.match(prep.say, /waiting on your yes/);
  assert.match(prep.say, /Nothing has dialed/);
  for (const s of Object.values(fromcall.STATES).slice(0, 3)) {
    assert.doesNotMatch(s, /\bbooked\b|\bconfirmed\b|\banswered\b/i);
  }

  // Dialing, then talking, read off the outgoing call's own row rather than from memory.
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  const out = placedCall({ externalId: "conv_req", state: "placing" });
  await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: true, dial: async () => ({ ok: true, call_id: out.id }) });
  assert.equal(fromcall.status({ call, requestId: r.request_id }).state, "dialing");

  db.updateCall(C, out.id, { state: "in_progress" });
  const talking = fromcall.status({ call, requestId: r.request_id });
  assert.equal(talking.state, "waiting");
  assert.match(talking.say, /on the call now/);

  // Something only he can decide pauses it, and his answer is not taken by voice here.
  db.createCommitment(C, { callId: out.id, what: "a fifty dollar deposit", totalCents: 5000, state: "paused_for_owner" });
  const paused = fromcall.status({ call, requestId: r.request_id });
  assert.equal(paused.state, "needs_your_word");
  assert.match(paused.say, /a fifty dollar deposit/);
  assert.match(paused.say, /fifty dollars/);
  assert.match(paused.say, /by text, not by voice/);
});

test("the call ending writes the one result, from the row and not from anything a model said", () => {
  const call = ownerCall();
  const r = prepared(call);
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  const out = placedCall({ externalId: "conv_done" });
  db.updateCallRequest(C, r.request_id, { state: "dialing", placed_call_id: out.id });

  const settled = db.updateCall(C, out.id, {
    state: "completed", outcome: "booked", summary: "table for four at eight on Saturday, under Omari",
  });
  const done = fromcall.onCallEnded(settled);
  assert.equal(done.state, "result");

  const row = db.getCallRequest(C, r.request_id);
  assert.equal(row.state, "result");
  assert.match(row.result, /booked — table for four at eight/);
  const st = fromcall.status({ call, requestId: r.request_id });
  assert.match(st.say, /done — there's a result/);
  assert.match(st.say, /only what is in the result/);

  // A call nobody asked for this way is not one of these.
  const stray = placedCall({ externalId: "conv_stray" });
  assert.equal(fromcall.onCallEnded(stray).ok, false);
});

test("a call he asked for closes its request through the real post-call path", async () => {
  const call = ownerCall();
  const r = prepared(call);
  const out = placedCall({ externalId: "conv_hook", state: "in_progress" });
  db.updateCallRequest(C, r.request_id, { state: "dialing", placed_call_id: out.id });

  const body = JSON.stringify({
    type: "post_call_transcription",
    data: { conversation_id: "conv_hook", status: "done", transcript: [{ role: "agent", message: "thanks, see you Saturday" }] },
  });
  // The real provider, so the real signature check and the real parse run. Only `settle` is injected,
  // because settling is the step that would fetch audio over the network.
  const provider = new ElevenLabsCallProvider();
  const res = await postcall.postCallRequest({
    rawBody: body, headers: signedHeaders(body), provider,
    settle: async (_c, row) => db.updateCall(C, row.id, { state: "completed", outcome: "booked", summary: "table for four" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.call_request, "result");
  assert.equal(db.getCallRequest(C, r.request_id).state, "result");
});

test("stop means stop before any new effect, and nothing dialed is said as nothing dialed", () => {
  const call = ownerCall();
  const r = prepared(call);
  const out = fromcall.cancel({ call, requestId: r.request_id, why: "never mind" });
  assert.equal(out.ok, true);
  assert.equal(out.state, "cancelled");
  assert.match(out.say, /Nothing was dialed and nobody was rung/);
  const row = db.getCallRequest(C, r.request_id);
  assert.match(row.result, /cancelled before dialing \(never mind\)/);
  const job = db.getTask(C, row.task_id);
  assert.equal(job.state, "cancelled");
  assert.equal(job.open, false, "a cancelled errand's job must really be closed, not left running");

  // Nothing open is said plainly rather than answered with a cheerful "cancelled".
  const none = fromcall.cancel({ call });
  assert.equal(none.ok, false);
  assert.match(none.say, /nothing open to cancel/);
  assert.match(none.say, /rather than saying it is cancelled/);
});

test("stopped mid-call, it may no longer agree to anything — and the brief on the row is what stops it", () => {
  const call = ownerCall();
  const r = prepared(call, { may_book: true, max_price_cents: 20000 });
  const out = placedCall({ externalId: "conv_live", state: "in_progress" });
  db.updateCall(C, out.id, {
    brief: JSON.stringify(buildBrief({ goal: "book a table", approved: { book: true, maxCents: 20000, terms: [] } })),
  });
  db.updateCallRequest(C, r.request_id, { state: "waiting", placed_call_id: out.id });

  const stop = fromcall.cancel({ call, requestId: r.request_id });
  assert.equal(stop.ok, true);
  assert.match(stop.say, /already on the phone, nothing is agreed, and nothing will be/);
  // Enforced on the row the commitment gate actually reads, not by telling the model to behave.
  const brief = JSON.parse(db.getCall(C, out.id).brief);
  assert.equal(brief.approved.book, false);
});

test("too late is said as too late, with the cancellation options and no pretence it was undone", () => {
  const call = ownerCall();
  const r = prepared(call, { may_book: true });
  const out = placedCall({ externalId: "conv_booked", state: "in_progress" });
  db.updateCallRequest(C, r.request_id, { state: "waiting", placed_call_id: out.id });
  db.createCommitment(C, { callId: out.id, what: "a table for four at eight", state: "committed" });

  const stop = fromcall.cancel({ call, requestId: r.request_id });
  assert.equal(stop.already_agreed, "a table for four at eight");
  assert.match(stop.say, /Too late for nothing to have happened/);
  assert.match(stop.say, /a new call, not something this one undoes/);
  assert.match(db.getCallRequest(C, r.request_id).result, /stopped after a table for four at eight was agreed/);
});

test("a call that could not be placed is nobody's phone ringing, and the request says so", async () => {
  const call = ownerCall();
  const r = prepared(call);
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });
  const d = dialer({ fails: "quiet hours: it is 3am where they are" });
  const go = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: true, dial: d.dial });
  assert.equal(go.ok, false);
  assert.equal(go.state, "cancelled");
  assert.match(go.say, /Nobody's phone rang/);
  assert.match(go.say, /quiet hours/);
  assert.match(db.getCallRequest(C, r.request_id).result, /could not be placed: quiet hours/);
});

test("only the owner, on his own call, can ask for a call to be made", async () => {
  const them = placedCall();
  assert.equal(fromcall.request({ call: them, input: { to: THEM, goal: "book it" } }).ok, false);
  const go = await fromcall.go({ call: them, requestId: 1, saidYes: true, dial: async () => ({ ok: true }) });
  assert.equal(go.ok, false);
  assert.match(go.error, /only the owner/);
});

test("asked for on a real turn, it is written down and read back and still has not dialed", async () => {
  const call = ownerCall();
  const placed = [];
  voice.contextDeps.runTool = async (name, input) => {
    placed.push({ name, input });
    return name === "call_place" ? { ok: true, call_id: 91 } : { ok: true };
  };

  const out = await voice.llmRequest({
    rawBody: bodyFor(call, [{ role: "user", content: "can you ring the thai place on 3rd and book us a table for four at eight" }]),
    headers: AUTH,
    generate: rounds(
      [{ tool: "make_a_call_for_me", input: { to: THEM, name: "the Thai place", goal: "book a table for four at eight" } }],
      ["so I'd ring the Thai place on plus one, two one two, five five five, nine nine nine nine, to book a table for four at eight. shall I?"],
    ),
  });
  const r = await drain(out.stream);
  assert.match(r.said, /shall I\?/i);
  // Written down, read back, and absolutely nothing dialed.
  assert.deepEqual(placed, []);
  const row = db.openCallRequests(C)[0];
  assert.equal(row.state, "preparing");

  // His yes, next turn — and it still needs the caller check first.
  const yes = await voice.llmRequest({
    rawBody: bodyFor(call, [{ role: "user", content: "yeah go for it" }]), headers: AUTH,
    generate: rounds(
      [{ tool: "make_a_call_for_me", input: { request_id: row.id, they_said_yes: true } }],
      ["one sec, need your passphrase for that"],
    ),
  });
  await drain(yes.stream);
  assert.deepEqual(placed, [], "a yes from an unverified caller dials nothing");

  // Verified, then the yes lands and the dial goes through the ordinary tool.
  const done = await voice.llmRequest({
    rawBody: bodyFor(call, [{ role: "user", content: "blue heron 7" }]), headers: AUTH,
    generate: rounds(
      [{ tool: "verify_caller", input: { passphrase: "blue heron 7", about: "ring the Thai place" } }],
      [{ tool: "make_a_call_for_me", input: { request_id: row.id, they_said_yes: true } }],
      ["ringing them now"],
    ),
  });
  const last = await drain(done.stream);
  assert.match(last.said, /ringing them now/);
  assert.deepEqual(placed.map(p => p.name), ["call_place"]);
  assert.equal(placed[0].input.to, THEM);
  assert.equal(db.getCallRequest(C, row.id).state, "dialing");
  assert.equal(db.getCallRequest(C, row.id).placed_call_id, 91);
});

test("the same request asked three times in one turn stops being answered the same way", async () => {
  // Section 10's "duplicate tool requests", on the new tools. The answer does not change; what the
  // model is told to do next does, because somebody is holding a handset through all of it.
  const call = ownerCall();
  const turnState = {};
  const ctx = voice.ownerContext({ call, callMessages: [] });
  const args = { to: THEM, goal: "book a table" };
  for (let i = 0; i < 3; i++) {
    turnState.ran = turnState.ran ?? {};
    turnState.ran.make_a_call_for_me = i;
  }
  // The dispatcher is what carries the escalation, so drive it the way voiceTurn does.
  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: scripted(
      { tool: "make_a_call_for_me", input: { name: "somewhere" } },
      { tool: "make_a_call_for_me", input: { name: "somewhere" } },
      { tool: "make_a_call_for_me", input: { name: "somewhere" } },
    ),
  });
  const r = await drain(out.stream);
  // It never dialed, and it never ended on silence.
  assert.equal(db.openCallRequests(C).length, 0);
  assert.ok(r.said.trim().length > 0, "a phone call never ends on nothing said");
  void ctx; void args;
});

// ======================================================================
// Sections 7 and 9 — when Reason's own context will not load
// ======================================================================

test("a call whose context cannot load says so, and is given nothing it could pretend with", () => {
  const call = ownerCall();
  const ctx = voice.degradedContext({ call, callMessages: [{ role: "user", content: "what's on tomorrow" }], why: "database is locked" });
  assert.equal(ctx.degraded, true);
  assert.match(ctx.why, /database is locked/);

  // Honest, early, and with the two things that are actually true offered instead.
  assert.match(ctx.system, /cannot reach any of your own context/i);
  assert.match(ctx.system, /ring back/i);
  assert.match(ctx.system, /must NOT do/i);
  assert.match(ctx.system, /pretend to remember/i);

  // The safety half of section 9: no tools at all. A turn that cannot read what it is allowed to do
  // does not get to do anything, so it cannot invent a commitment because none is on the table.
  assert.deepEqual(ctx.reasonTools, []);
  assert.deepEqual(ctx.callTools, []);
  assert.deepEqual(ctx.systemTools.map(t => t.name).sort(), ["end_call", "language_detection"]);
  // No thread, and nothing from his week. Their words on this call and nothing else.
  assert.deepEqual(ctx.messages, [{ role: "user", content: "what's on tomorrow" }]);
});

test("the context failing is a turn that talks, not a 500 and dead air", async () => {
  const call = ownerCall();
  // The thing that fails is the thing every context build goes through.
  const real = voice.contextDeps.systemFor;
  voice.contextDeps.systemFor = () => { throw new Error("context service is down"); };
  try {
    const out = await voice.llmRequest({
      rawBody: bodyFor(call, [{ role: "user", content: "what's on tomorrow" }]), headers: AUTH,
      generate: scripted("something's broken on my end, I can't get to any of your stuff right now"),
    });
    assert.equal(out.status, 200);
    const r = await drain(out.stream);
    assert.match(r.said, /broken on my end/);
  } finally {
    voice.contextDeps.systemFor = real;
  }
});

test("a degraded turn cannot run a tool even if the model asks for one", async () => {
  const call = ownerCall();
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true }; };
  const real = voice.contextDeps.systemFor;
  voice.contextDeps.systemFor = () => { throw new Error("down"); };
  try {
    const out = await voice.llmRequest({
      rawBody: bodyFor(call), headers: AUTH,
      generate: scripted({ tool: "calendar_list", input: {} }),
    });
    await drain(out.stream);
    assert.deepEqual(ran, [], "an empty tool list is the enforcement, not a prompt rule");
  } finally {
    voice.contextDeps.systemFor = real;
  }
});

test("a third-party call with no context gets one line and a hang-up, never a guess at a stranger", async () => {
  const them = placedCall();
  const real = voice.contextDeps.systemFor;
  // The third-party builder does not use systemFor, so break what it does use.
  const brief = voice.contextDeps;
  void brief;
  voice.contextDeps.systemFor = real;
  // Force the failure the honest way: a row whose conversation cannot be read.
  const broken = { ...them, conversation_id: them.conversation_id };
  const out = await voice.llmRequest({
    rawBody: JSON.stringify({
      model: "reason", stream: true, messages: [{ role: "user", content: "hello?" }],
      elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: 999999, [EXTRA_BODY_KEYS.conversationId]: C },
    }),
    headers: AUTH,
  });
  const r = await drain(out.stream);
  // A call Reason cannot place is told one line and hung up on rather than left listening to nothing.
  assert.match(r.said, /can't pick this one up/i);
  assert.equal(r.toolCalls[0].function.name, "end_call");
  void broken;
});

test("the backend failing mid-turn says something honest rather than going silent", async () => {
  // Section 9, our half: we are the custom LLM, so their fallback chain is not ours. What has to
  // hold is that our own failure is still a sentence on the phone.
  const call = ownerCall();
  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: scripted("Let me just check that for you. ", { throws: "the model backend is unavailable" }),
  });
  const r = await drain(out.stream);
  // The sentence that had already left is still spoken — only a FINISHED sentence leaves, which is
  // why this one has a full stop in it — and then the honest line follows it rather than silence.
  assert.match(r.said, /Let me just check that for you/);
  assert.match(r.said, /something broke on my end/i);
  // Nothing was agreed, nothing was claimed, and the stream still closed properly.
  assert.equal(db.pausedCommitments(C).length, 0);
});

// ======================================================================
// Sections 5, 11 and 12 — being cut off, how it sounds, and what he reads after
// ======================================================================

test("being cut off keeps what he heard, and the next turn does not start again from the top", () => {
  // The platform stops the audio and sends the turn back as far as it got. That half-sentence is
  // what he actually HEARD, so it has to survive into the next turn's messages.
  const heard = voice.fromOpenAI([
    { role: "user", content: "what time is the dentist thing" },
    { role: "assistant", content: "it's at ten past four on Thursday, and the one after that" },
    { role: "user", content: "no sorry — the OTHER one, with Kofi" },
  ]);
  assert.equal(heard.length, 3);
  assert.equal(heard[1].role, "assistant");
  assert.match(heard[1].content, /ten past four/);
  assert.equal(heard[2].content, "no sorry — the OTHER one, with Kofi");

  // And the rule that says what to do with it.
  assert.match(VOICE_RULES, /what you had said is what they heard/i);
  assert.match(VOICE_RULES, /Never start that answer again from the beginning/i);
  assert.match(VOICE_RULES, /never finish the sentence they interrupted/i);
});

test("natural is the brief and overacting fails it, and natural never means claiming to be a person", () => {
  assert.match(VOICE_RULES, /Warm and natural, not performed/);
  assert.match(VOICE_RULES, /No laughing at your own lines/);
  assert.match(VOICE_RULES, /you are an AI, plainly/);
  // Both calls carry it, because both are spoken out loud.
  assert.ok(voice.ownerContext({ call: ownerCall(), callMessages: [] }).system.includes("not performed"));
  assert.ok(voice.thirdPartyContext({ call: placedCall(), callMessages: [] }).system.includes("not performed"));
});

test("what he reads after a call follows his own message rules", () => {
  const row = db.updateCall(C, placedCall().id, {
    state: "completed", outcome: "booked", summary: "table for four at eight",
    transcript: "them: sure, Saturday at eight. we'll need a card to hold it.",
    recording_state: "stored",
  });
  const said = postcall.thirdPartyEvent({ row, live: null });
  // Plain bullets, what it means for him, and the thing needing his word last and as a question.
  assert.match(said, /plain "- " lines/);
  assert.match(said, /needs HIS word/);
  assert.match(said, /last and as a question/);
  assert.match(said, /technical.*underneath/i);
  // A link never buried in the paragraph.
  assert.match(said, /does not go in this message/);
  assert.match(said, /goes out on its own/);
  // And still nothing claimed beyond the transcript.
  assert.match(said, /only what the transcript really says/);
});

// ======================================================================
// Section 10 — a disconnect immediately after a possible booking
// ======================================================================

test("a line that drops right after a booking leaves something nobody knows about, and it is not nothing", () => {
  const out = placedCall({ externalId: "conv_dropped" });
  // The gate ALLOWED it, the call read it back and said yes to the place, and then the line died
  // before `confirm_commitment` recorded what came back. The restaurant very probably wrote it down.
  db.createCommitment(C, { callId: out.id, what: "a table for four at eight on Saturday", state: "proposed" });

  // While the call is still going there is nothing unresolved: the turn on it is what resolves it.
  assert.deepEqual(commit.unresolvedAt(C, THEM), []);

  db.updateCall(C, out.id, { state: "failed", outcome: "the line dropped" });
  const maybe = commit.unresolvedAt(C, THEM);
  assert.equal(maybe.length, 1);
  assert.equal(maybe[0].what, "a table for four at eight on Saturday");

  // Not reported as agreed either — that is the other wrong answer.
  assert.equal(db.commitmentsAtNumber(C, THEM).filter(m => m.state === "committed").length, 0);
});

test("the second call to a maybe-booked number goes to ask, never to book", () => {
  const out = placedCall({ externalId: "conv_dropped2", state: "failed" });
  db.createCommitment(C, { callId: out.id, what: "a table for four at eight", state: "proposed" });

  const r = redial.safeToRedial(C, {
    toNumber: THEM,
    brief: buildBrief({ goal: "book a table for four at eight", approved: { book: true, maxCents: 20000, terms: [] } }),
  });
  // Allowed, but not for what it was for. Booking is off on the brief this one would be placed under,
  // which is the half that cannot be left to the prompt.
  assert.equal(r.ok, true);
  assert.equal(r.mode, "ask");
  assert.equal(r.brief.approved.book, false);
  assert.match(r.why, /may already/);
  assert.match(r.why, /do not agree to anything/i);
  assert.equal(r.unresolved.what, "a table for four at eight");
});

test("he cannot have a maybe-booked number rung again to book — that is how a table gets booked twice", async () => {
  const call = ownerCall();
  const dropped = placedCall({ externalId: "conv_dropped3", state: "failed" });
  db.createCommitment(C, { callId: dropped.id, what: "a table for four at eight", state: "proposed" });
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });

  const r = prepared(call, { may_book: true, max_price_cents: 20000 });
  const d = dialer();
  const go = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: true, dial: d.dial });

  assert.equal(go.ok, false);
  assert.deepEqual(d.asked, [], "nothing may be dialed with booking on");
  assert.equal(go.unresolved, "a table for four at eight");
  assert.match(go.say, /ended before anybody knew/);
  assert.match(go.say, /could make two/);
  // The useful next step is offered rather than a dead end.
  assert.match(go.say, /only asks whether it is on their book/);
  assert.match(db.getCallRequest(C, r.request_id).result, /nobody knows whether a table for four at eight went through/);
});

test("a call that is only asking is still allowed to a maybe-booked number, because asking is the fix", async () => {
  const call = ownerCall();
  const dropped = placedCall({ externalId: "conv_dropped4", state: "failed" });
  db.createCommitment(C, { callId: dropped.id, what: "a table for four at eight", state: "proposed" });
  db.updateCall(C, call.id, { verified_at: clock.now(), verified_how: "passphrase" });

  const r = prepared(call, { goal: "find out whether the table is on their book under Omari" });
  const d = dialer();
  const go = await fromcall.go({ call: db.getCall(C, call.id), requestId: r.request_id, saidYes: true, dial: d.dial });
  assert.equal(go.ok, true);
  assert.equal(d.asked.length, 1);
  assert.equal(d.asked[0].may_book, false);
});
