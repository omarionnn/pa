// Machines on an outbound call: a recorded message, a phone menu, a mailbox — told apart from a person
// before anything is said, and written down as what they were.
//
// Built from live call 45 (2026-10-27) to the Strand, replayed from its real transcript
// (test/fixture-call45.js): the disclosure went out at pick-up over the store's recorded hours message,
// Reason then described the recording OUT LOUD into it, pressed nothing, was routed to a mailbox that
// takes no messages, and the row said "they answered". No model and no network: the generator is a
// script of events, exactly as in test/call-onthephone.test.js.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-machines-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.ELEVENLABS_API_KEY = "eleven-test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ELEVENLABS_LLM_SECRET = "llm-test-secret";
process.env.ELEVENLABS_WEBHOOK_SECRET = "hook-test-secret";
process.env.REASON_CALL_MAX_HOLD_SECONDS = "300";

const voice = await import("../src/calls/voice.js");
const { llmRequest, thirdPartyContext, LINE_OPENED } = voice;
const { EXTRA_BODY_KEYS, ElevenLabsCallProvider } = await import("../src/calls/elevenlabs.js");
const { announcementFor, callRulesFor } = await import("../src/calls/provider.js");
const brief = await import("../src/calls/brief.js");
const outcome = await import("../src/calls/outcome.js");
const { thirdPartyEvent } = await import("../src/calls/postcall.js");
const { settleCall } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const { STRAND_RECORDING, STRAND_MAILBOX, SAID_INTO_IT, STRAND, STRAND_GOAL } = await import("./fixture-call45.js");

const C = config.ownerConversation;
const ANN = announcementFor({ ownerName: "Omari" });
let nth = 0;

/** A call placed the new way: the line opened silent and nobody has heard who is calling. */
const strandCall = (over = {}) => {
  nth += 1;
  const row = db.createCall(C, {
    provider: "elevenlabs", toNumber: STRAND, isOwner: false, goal: STRAND_GOAL,
    facts: ["The hold, if offered, would be under the name Omari"], announcement: ANN, externalId: `conv_m${nth}`,
  });
  db.updateCall(C, row.id, { brief: JSON.stringify(brief.buildBrief({ goal: STRAND_GOAL })), opening_waits: 1, ...over });
  return db.getCall(C, row.id);
};

const scripted = (...events) => async function* () {
  for (const e of events) {
    if (typeof e === "string") yield { type: "text", text: e };
    else yield { type: "tool_use", name: e.tool, id: e.id ?? `tu_${Math.random().toString(36).slice(2, 7)}`, input: e.input ?? {} };
  }
};
const rounds = (...scripts) => {
  let i = 0;
  return () => scripts[Math.min(i++, scripts.length - 1)]();
};

async function drain(stream) {
  const raw = [];
  for await (const s of stream) raw.push(s);
  const chunks = raw.filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6)));
  return {
    said: chunks.map(c => c.choices[0].delta.content ?? "").join(""),
    toolCalls: chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []),
  };
}

const bodyFor = (call, messages) => JSON.stringify({
  model: "reason", stream: true, messages,
  elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: call.id, [EXTRA_BODY_KEYS.conversationId]: C },
});
const AUTH = { authorization: "Bearer llm-test-secret" };
const turn = async (call, generate, messages) => drain(
  (await llmRequest({ rawBody: bodyFor(call, messages), headers: AUTH, generate })).stream,
);
const theyAnswer = (text) => [{ role: "user", content: text }];

beforeEach(() => { clock.reset(); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

// ---------- the line opens silent ----------

test("a third-party call is placed with no spoken opener; the owner's own call keeps his", async () => {
  const bodies = [];
  const p = new ElevenLabsCallProvider({
    fetchImpl: async (_url, opt) => {
      bodies.push(JSON.parse(opt.body));
      return { ok: true, json: async () => ({ conversation_id: "conv_open", callSid: "CA1" }) };
    },
  });
  const rules = callRulesFor({ ownerName: "Omari" });
  const out = await p.place({
    to: STRAND, goal: STRAND_GOAL, maxSeconds: 600, announcement: ANN, rules, onBehalfOf: "Omari",
    kind: "third_party", brief: brief.buildBrief({ goal: STRAND_GOAL }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.openingWaits, true);
  // Their docs: an empty first message means the agent waits for the other side to speak first.
  assert.equal(bodies[0].conversation_initiation_client_data.conversation_config_override.agent.first_message, "");

  const mine = await p.place({
    to: "+12025551234", goal: "ring Omari", maxSeconds: 600, rules, onBehalfOf: "Omari", kind: "owner",
    announcement: announcementFor({ ownerName: "Omari", toOwner: true }), brief: brief.buildBrief({ goal: "ring Omari" }),
  });
  assert.equal(mine.openingWaits, false);
  assert.notEqual(bodies[1].conversation_initiation_client_data.conversation_config_override.agent.first_message, "");
});

test("the prompt says nothing has been said yet, and how to tell a person from a machine", () => {
  const ctx = thirdPartyContext({ call: strandCall(), callMessages: theyAnswer(STRAND_RECORDING) });
  assert.equal(ctx.openingOwed, true);
  assert.match(ctx.system, /Nothing has been said on this call yet/);
  assert.doesNotMatch(ctx.system, /opening line was already spoken/);
  assert.match(ctx.system, /is it a PERSON or a MACHINE/);
  assert.match(ctx.system, /call machine_on_the_line and write NO words/);
  assert.ok(ctx.callTools.some(t => t.name === "machine_on_the_line"));
});

// ---------- call 45, replayed ----------

test("call 45: the Strand's recording says no phone inquiries — Reason says nothing, hangs up, and keeps the email", async () => {
  const call = strandCall();
  const r = await turn(call, scripted({
    tool: "machine_on_the_line",
    input: { what: "phone_menu", dead_end: true, heard: "They are not taking customer phone inquiries; email web@strandbooks.com instead. Flagship store open 10am-9pm daily." },
  }), theyAnswer(STRAND_RECORDING));
  assert.equal(r.said, "", "not one word into the recording — not the disclosure, not a description of it");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "end_call", "a dead end is hung up at once, not after a menu timeout");
  const row = db.getCall(C, call.id);
  assert.equal(row.outcome_kind, "machine_dead_end");
  assert.match(row.machine_heard, /web@strandbooks\.com/);
  assert.equal(row.parties_told, "[]", "nobody was told anything, because nobody was there");
  assert.equal(outcome.redialMode(row.outcome_kind), "no", "ringing again hears the same recording");
});

test("call 45's actual mistake — describing the recording out loud — is never spoken", async () => {
  const call = strandCall();
  const r = await turn(call, scripted(SAID_INTO_IT, { tool: "skip_turn", input: { reason: "recorded message" } }), theyAnswer(STRAND_RECORDING));
  assert.equal(r.said, "");
  assert.equal(r.toolCalls[0].function.name, "skip_turn");
  assert.equal(db.getCall(C, call.id).parties_told, "[]");
});

test("call 45's last minute: a mailbox that takes no messages ends the call and is not a voicemail left", async () => {
  const call = strandCall();
  await turn(call, scripted({ tool: "machine_on_the_line", input: { what: "phone_menu", heard: "email web@strandbooks.com" } }), theyAnswer(STRAND_RECORDING));
  const r = await turn(db.getCall(C, call.id), scripted({ tool: "machine_on_the_line", input: { what: "mailbox_not_taking_messages" } }),
    [...theyAnswer(STRAND_RECORDING), { role: "user", content: STRAND_MAILBOX }]);
  assert.equal(r.said, "");
  assert.equal(r.toolCalls[0].function.name, "end_call");
  const row = db.getCall(C, call.id);
  assert.equal(row.outcome_kind, "voicemail_full");
  assert.equal(row.voicemail_left, 0);
  assert.match(row.machine_heard, /web@strandbooks\.com/, "what the menu said is kept when the mailbox says nothing useful");
  assert.equal(outcome.redialMode("voicemail_full"), "retry");
});

test("the settled row and the owner's recap say a machine answered, with the next step it gave", async () => {
  const call = strandCall();
  await turn(call, scripted({
    tool: "machine_on_the_line", input: { what: "recorded_message", dead_end: true, heard: "Not taking phone inquiries; email web@strandbooks.com." },
  }), theyAnswer(STRAND_RECORDING));
  // What ElevenLabs reported for the real call 45.
  const row = await settleCall(C, db.getCall(C, call.id), {
    state: "completed", outcome: "they answered",
    summary: "The agent initiated a call for Omari. The user's response was an automated message detailing store hours.",
    transcript: `Reason: ...\nThem: ${STRAND_RECORDING}`, durationS: 108,
  });
  assert.equal(row.outcome_kind, "machine_dead_end");
  assert.doesNotMatch(row.outcome, /they answered/);
  assert.match(row.summary, /A recorded message said nobody can be reached by phone this way/);
  assert.match(row.summary, /web@strandbooks\.com/);
  assert.doesNotMatch(row.summary, /The user's response/);
  const told = thirdPartyEvent({ row, live: {} });
  assert.match(told, /No person was reached: only a machine answered/);
  assert.match(told, /web@strandbooks\.com/);
  assert.match(told, /that is the next step: offer it/);
});

// ---------- a menu, then a person ----------

test("a menu gets a key press and silence; the person after it hears the disclosure first, word for word", async () => {
  const call = strandCall();
  const menu = "Thank you for calling the Strand. For store hours, press 1. For book availability, press 2. For all other inquiries, press 0.";
  const r1 = await turn(call, rounds(
    scripted({ tool: "machine_on_the_line", input: { what: "phone_menu" } }),
    scripted({ tool: "play_keypad_touch_tone", input: { dtmf_tones: "2", reason: "book availability" } }),
  ), theyAnswer(menu));
  assert.equal(r1.said, "");
  assert.equal(r1.toolCalls[0].function.name, "play_keypad_touch_tone");
  let row = db.getCall(C, call.id);
  assert.equal(row.menu_presses, JSON.stringify(["2"]));
  assert.equal(row.outcome_kind, "machine_menu");

  const r2 = await turn(row, scripted("I'm calling to ask whether you have Thank God for Cats by Linda Clare in stock."),
    [...theyAnswer(menu), { role: "user", content: "Books department, this is Sam, how can I help?" }]);
  assert.ok(r2.said.startsWith(ANN), `the disclosure is first, verbatim: ${r2.said}`);
  assert.match(r2.said, /Thank God for Cats/);
  row = db.getCall(C, call.id);
  assert.equal(row.parties_told, "[1]");
  assert.equal(row.outcome_kind, "", "a person came on: the row no longer says a machine answered");

  // And never twice.
  const r3 = await turn(row, scripted("Great, could you hold one under Omari?"),
    [{ role: "user", content: "Yes, we have two copies." }]);
  assert.equal(r3.said, "Great, could you hold one under Omari?");
});

test("a person who answers straight away hears the disclosure in front of Reason's first words", async () => {
  const call = strandCall();
  const r = await turn(call, scripted("I'm calling to ask whether you have Thank God for Cats in stock."), theyAnswer("Strand Books, how can I help you?"));
  assert.equal(r.said, `${ANN} I'm calling to ask whether you have Thank God for Cats in stock.`);
});

test("a line that opened and stayed silent: the model is handed the turn, and a hello is not said without the disclosure", async () => {
  const call = strandCall();
  let seen = null;
  const gen = async function* ({ messages }) { seen = messages; yield { type: "text", text: "Hello?" }; };
  const r = await turn(call, gen, []);
  assert.equal(seen.at(-1).content, LINE_OPENED);
  assert.equal(r.said, `${ANN} Hello?`);
});

test("a call placed the old way (opener spoken at pick-up) is not given the disclosure twice", async () => {
  const call = strandCall({ opening_waits: null });
  const r = await turn(call, scripted("Hi there, I'm calling to ask about a book."), theyAnswer("Strand, hello?"));
  assert.equal(r.said, "Hi there, I'm calling to ask about a book.");
});

// ---------- voicemail ----------

test("a voicemail greeting goes down the existing voicemail path, without the disclosure stuck in front", async () => {
  const call = strandCall();
  const r = await turn(call, rounds(
    scripted({ tool: "machine_on_the_line", input: { what: "voicemail_greeting" } }),
    scripted({ tool: "end_call", input: { reason: "left the voicemail", message: "Hi, this is an AI assistant calling for Omari about a book. Please call back on this number. Thanks." } }),
  ), theyAnswer("You've reached the Strand. Please leave a message after the tone."));
  assert.equal(r.said, "");
  assert.equal(r.toolCalls[0].function.name, "end_call");
  const row = db.getCall(C, call.id);
  assert.equal(row.outcome_kind, "voicemail_left");
  assert.equal(row.voicemail_left, 1);
});

test("hold music is a wait inside the hold budget, not a person", async () => {
  const call = strandCall();
  const r = await turn(call, rounds(
    scripted({ tool: "machine_on_the_line", input: { what: "hold_or_queue" } }),
    scripted({ tool: "skip_turn", input: { reason: "hold music" } }),
  ), theyAnswer("Please hold, your call is important to us."));
  assert.equal(r.said, "");
  assert.equal(r.toolCalls[0].function.name, "skip_turn");
  const row = db.getCall(C, call.id);
  assert.equal(row.outcome_kind, "machine_recording");
  assert.ok(Number(row.hold_since) > 0);
});

// ---------- floors under the model ----------

test("a key pressed before anybody has spoken is a menu on the row, even when the model never named it", async () => {
  const call = strandCall();
  const r = await turn(call, scripted({ tool: "play_keypad_touch_tone", input: { dtmf_tones: "2" } }), theyAnswer("For stock enquiries, press 2."));
  assert.equal(r.toolCalls[0].function.name, "play_keypad_touch_tone");
  assert.equal(db.getCall(C, call.id).outcome_kind, "machine_menu");
});

test("if the turn breaks before the first words to a person, the apology still comes after the disclosure", async () => {
  const call = strandCall();
  const broken = async function* () { throw new Error("model fell over"); };
  const r = await turn(call, broken, theyAnswer("Strand, hello?"));
  assert.ok(r.said.startsWith(`${ANN} Sorry`), r.said);
  assert.equal(db.getCall(C, call.id).parties_told, "[1]");
});

// ---------- review findings (PR #232) ----------

test("hanging up on a recording says nothing into it and leaves the row a machine", async () => {
  const call = strandCall();
  await turn(call, scripted({ tool: "machine_on_the_line", input: { what: "recorded_message" } }), theyAnswer(STRAND_RECORDING));
  const r = await turn(db.getCall(C, call.id), scripted("Okay, nobody's there, hanging up.", { tool: "end_call", input: { reason: "only a recording" } }),
    [...theyAnswer(STRAND_RECORDING), { role: "user", content: "Thank you for calling, goodbye." }]);
  assert.equal(r.said, "");
  assert.equal(r.toolCalls[0].function.name, "end_call");
  const row = db.getCall(C, call.id);
  assert.equal(row.outcome_kind, "machine_recording");
  assert.equal(row.parties_told, "[]");
});

test("a menu that ignores a key is not answered by talking to it", async () => {
  const hold = await import("../src/calls/hold.js");
  const call = strandCall({ menu_presses: JSON.stringify(["0", "0"]) });
  const r = hold.notePress(call, { tones: "0" });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /out loud/i);
  assert.match(r.error, /end_call without saying anything/);
});

test("a machine reached after a person answered does not rewrite what the person did", async () => {
  const call = strandCall({ outcome_kind: "answered", parties_told: "[1]" });
  const r = await turn(call, scripted({ tool: "machine_on_the_line", input: { what: "mailbox_not_taking_messages" } }), theyAnswer(STRAND_MAILBOX));
  assert.equal(r.toolCalls[0].function.name, "end_call");
  assert.equal(db.getCall(C, call.id).outcome_kind, "answered");
});
