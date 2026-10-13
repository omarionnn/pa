// What happens on the line, through the real endpoint, with the model scripted.
//
// The modules in test/call-handling.test.js are proven on their own. This proves the WIRING: that a
// `skip_turn` really reaches the platform while there is budget and really becomes a hang-up when there
// is not, that a menu key that has been pressed twice is not forwarded a third time, that a commitment
// the owner has not approved does not become a function call, and that a transfer is refused until he
// has said he is there.
//
// No model and no network. The generator is a script of events, exactly as in test/call-voice.test.js.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-online-"));
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
const { llmRequest, runCallTool, handOver, thirdPartyContext, callBrief, SSE_DONE } = voice;
const { EXTRA_BODY_KEYS } = await import("../src/calls/elevenlabs.js");
const { announcementFor } = await import("../src/calls/provider.js");
const brief = await import("../src/calls/brief.js");
const hold = await import("../src/calls/hold.js");
const redial = await import("../src/calls/redial.js");
const readback = await import("../src/calls/readback.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const ANN = announcementFor({ ownerName: "Omari" });
let nth = 0;
const newNumber = () => `+1212555${String(3000 + (nth += 1)).slice(-4)}`;

const callWith = (b, over = {}) => {
  const row = db.createCall(C, {
    provider: "elevenlabs", toNumber: over.to_number ?? newNumber(), isOwner: false,
    goal: b?.goal ?? "ask about a deep clean", facts: b?.facts ?? [], announcement: ANN,
    externalId: `conv_${nth}`,
  });
  db.updateCall(C, row.id, { brief: JSON.stringify(b ?? {}), ...over });
  return db.getCall(C, row.id);
};

const scripted = (...events) => async function* () {
  for (const e of events) {
    if (typeof e === "string") yield { type: "text", text: e };
    else yield { type: "tool_use", name: e.tool, id: e.id ?? `tu_${Math.random().toString(36).slice(2, 7)}`, input: e.input ?? {} };
  }
};

/** A generator that answers differently on each round, so a tool result can be replied to. */
const rounds = (...scripts) => {
  let i = 0;
  return () => scripts[Math.min(i++, scripts.length - 1)]();
};

async function drain(stream) {
  const raw = [];
  for await (const s of stream) raw.push(s);
  const chunks = raw.filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6)));
  return {
    text: raw.join(""), chunks,
    said: chunks.map(c => c.choices[0].delta.content ?? "").join(""),
    toolCalls: chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []),
  };
}

const bodyFor = (call, messages = [{ role: "user", content: "hello" }]) => JSON.stringify({
  model: "reason", stream: true, messages,
  elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: call.id, [EXTRA_BODY_KEYS.conversationId]: C },
});
const AUTH = { authorization: "Bearer llm-test-secret" };
const turn = (call, generate, messages) => llmRequest({ rawBody: bodyFor(call, messages), headers: AUTH, generate });

beforeEach(() => { clock.reset(); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

// ---------- the brief reaches the prompt ----------

test("an inquiry call is told it is asking, and a booking call is told its ceiling", () => {
  const ask = callWith(brief.buildBrief({ goal: "ask what a deep clean costs", questions: brief.CORE_QUESTIONS }));
  const ctx = thirdPartyContext({ call: ask });
  assert.match(ctx.system, /You are ASKING on this call, not agreeing/);
  assert.match(ctx.system, /how long that price is good for/);
  assert.match(ctx.system, /call propose_commitment first/);
  // The waiting rules are there, named to the tools that are actually enabled.
  assert.match(ctx.system, /call skip_turn and say nothing/);
  assert.match(ctx.system, /new_person_on_the_line FIRST/);

  const book = callWith(brief.buildBrief({
    goal: "book the deep clean", approved: { book: true, maxCents: 20000 }, readBack: ["date", "time", "price"],
  }));
  const ctx2 = thirdPartyContext({ call: book });
  assert.match(ctx2.system, /You MAY agree to this on Omari's behalf up to 200 dollars/);
  assert.match(ctx2.system, /date, time, price/);
  assert.match(ctx2.system, /"Tuesday at three" is not an agreement/);
});

test("a call with no brief on the row gets the cautious one, not none", () => {
  const row = db.createCall(C, { provider: "elevenlabs", toNumber: newNumber(), isOwner: false, goal: "ask a thing", facts: [], announcement: ANN });
  const b = callBrief(db.getCall(C, row.id));
  assert.equal(b.approved.book, false, "a call whose permissions nobody can find may ask and may not agree");
  assert.equal(b.goal, "ask a thing");
});

test("how long it has been holding is in the prompt, because the model cannot count minutes", () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  assert.equal(thirdPartyContext({ call }).system.includes("been waiting"), false);
  hold.noteWaiting(call);
  clock.skip(250_000);
  const ctx = thirdPartyContext({ call: db.getCall(C, call.id) });
  assert.match(ctx.system, /been waiting on this call for about 4 minute/);
  assert.match(ctx.system, /nearly out of time to wait/);
});

// ---------- waiting ----------

test("skip_turn reaches the platform while there is budget left", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  const out = await turn(call, scripted({ tool: "skip_turn", input: { reason: "hold music" } }));
  const r = await drain(out.stream);
  assert.equal(r.toolCalls[0].function.name, "skip_turn");
  assert.equal(r.said, "", "it says nothing: you do not talk to hold music");
  assert.equal(hold.onHold(db.getCall(C, call.id)), true);
});

test("a hold that runs out of budget becomes a polite line and a hang-up, not another wait", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  await drain((await turn(call, scripted({ tool: "skip_turn", input: { reason: "music" } }))).stream);
  clock.skip(301_000);

  const r = await drain((await turn(db.getCall(C, call.id), scripted({ tool: "skip_turn", input: { reason: "still music" } }))).stream);
  assert.match(r.said, /holding a while/i);
  assert.equal(r.toolCalls[0].function.name, "end_call", "not skip_turn: the budget is gone");
  assert.ok(r.text.endsWith(SSE_DONE));

  const row = db.getCall(C, call.id);
  assert.equal(row.outcome_kind, "hold_gave_up");
  assert.equal(row.hold_gave_up, 1);
});

test("speaking instead of waiting ends the hold, which is the whole detector", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  await drain((await turn(call, scripted({ tool: "skip_turn", input: { reason: "music" } }))).stream);
  clock.skip(120_000);
  assert.equal(hold.onHold(db.getCall(C, call.id)), true);

  // A human came back, so the model speaks. Nothing read the transcript for the word "hold".
  await drain((await turn(db.getCall(C, call.id), scripted("Hi, thanks for coming back."))).stream);
  const row = db.getCall(C, call.id);
  assert.equal(hold.onHold(row), false);
  assert.equal(Number(row.hold_total_s), 120);
});

// ---------- menus ----------

test("a menu key is forwarded, and the third identical press is refused instead of sent", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  for (const n of [1, 2]) {
    const r = await drain((await turn(db.getCall(C, call.id), scripted({ tool: "play_keypad_touch_tone", input: { dtmf_tones: "2" } }))).stream);
    assert.equal(r.toolCalls[0].function.name, "play_keypad_touch_tone", `press ${n} goes through`);
    assert.equal(JSON.parse(r.toolCalls[0].function.arguments).dtmf_tones, "2");
  }

  // The third is not forwarded. It comes back as a tool result, and the next round says something out
  // loud instead — which is what actually gets a human on most menus.
  const third = await drain((await turn(
    db.getCall(C, call.id),
    rounds(
      scripted({ tool: "play_keypad_touch_tone", input: { dtmf_tones: "2" } }),
      scripted("Hello? I'm trying to reach someone about a booking."),
    ),
  )).stream);
  assert.equal(third.toolCalls.length, 0, "no third tone reaches the platform");
  assert.match(third.said, /trying to reach someone/);
});

test("prose instead of keys presses nothing — a stripper would have invented a tone", async () => {
  // The bug this pins: stripping everything that is not a tone character turned "press 1w1 now" into
  // "1w1w", because the `w` came out of "now". A pause nobody asked for, pressed into somebody's phone
  // system. So prose is refused and handed back, and the next round says something out loud instead.
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  const r = await drain((await turn(
    call,
    rounds(
      scripted({ tool: "play_keypad_touch_tone", input: { dtmf_tones: "press 1w1 now" } }),
      scripted("Sorry — could I speak to someone about a booking?"),
    ),
  )).stream);
  assert.equal(r.toolCalls.length, 0, "nothing was pressed");
  assert.match(r.said, /speak to someone/);

  // Spaces and commas between keys are fine; they are separators, not prose.
  const ok = await drain((await turn(db.getCall(C, call.id), scripted({ tool: "play_keypad_touch_tone", input: { dtmf_tones: "1w1, 2" } }))).stream);
  assert.equal(JSON.parse(ok.toolCalls[0].function.arguments).dtmf_tones, "1w12");
});

// ---------- voicemail ----------

// The 2026-10-13 call to Jeffrey (live row 23): `voicemail_detection` was forwarded, the platform hung
// up at the beep with nothing said, and the row still said "one message was left" — which locked the
// number out of a retry. Pinned: detection is never forwarded, the message rides in end_call, and
// "voicemail left" is only written when there were words.

test("a machine answered: detection is not forwarded, the message is left through end_call, and only then is it a voicemail left", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask Jeffrey to call Omari back about Thursday" }));
  const r = await drain((await turn(
    call,
    rounds(
      scripted({ tool: "voicemail_detection", input: { reason: "recorded greeting, then a beep" } }),
      scripted({ tool: "end_call", input: { reason: "left the voicemail", message: "Hi Jeffrey, this is an AI assistant calling for Omari. He'd like a call back about Thursday when you get a moment. Thanks." } }),
    ),
  )).stream);
  // One function call leaves, and it is the hang-up with the message in it — not the detection.
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "end_call");
  assert.match(JSON.parse(r.toolCalls[0].function.arguments).message, /call back about Thursday/);
  assert.equal(r.said, "", "nothing is streamed as speech; the platform speaks the message and then hangs up");
  const row = db.getCall(C, call.id);
  assert.equal(row.voicemail_left, 1);
  assert.equal(row.outcome_kind, "voicemail_left");
  assert.match(row.outcome, /one message was left: "Hi Jeffrey/);
});

test("a machine answered and nothing was said: the row says so, and the number is not locked", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  const r = await drain((await turn(
    call,
    rounds(
      scripted({ tool: "voicemail_detection", input: { reason: "mailbox greeting" } }),
      scripted({ tool: "end_call", input: { reason: "voicemail" } }),
    ),
  )).stream);
  assert.equal(r.toolCalls[0].function.name, "end_call");
  const row = db.getCall(C, call.id);
  assert.equal(row.voicemail_left, 0);
  assert.equal(row.outcome_kind, "voicemail_no_message");
  assert.match(row.outcome, /no message was left/);
  // Which is exactly the row that must NOT block a retry: nothing is in their mailbox.
  const again = redial.safeToRedial(C, { toNumber: row.to_number, errandId: row.errand_id });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.mode, "retry");
});

test("a machine answered and the model only spoke: the words are the message, and the call ends on them", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  const r = await drain((await turn(
    call,
    rounds(
      scripted({ tool: "voicemail_detection", input: { reason: "beep" } }),
      scripted("Hi, this is an AI assistant calling for Omari — please give him a call back when you can."),
    ),
  )).stream);
  assert.match(r.said, /calling for Omari/);
  assert.equal(r.toolCalls.at(-1).function.name, "end_call", "a mailbox is not left recording silence");
  const row = db.getCall(C, call.id);
  assert.equal(row.voicemail_left, 1);
  assert.equal(row.outcome_kind, "voicemail_left");
});

test("once a machine is known, a turn that neither speaks nor hangs up is made to hang up with nothing left", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  // The machine was found on an earlier turn, and that turn said nothing after it.
  await drain((await turn(call, rounds(scripted({ tool: "voicemail_detection", input: { reason: "greeting" } }), scripted()))).stream);
  assert.equal(db.getCall(C, call.id).outcome_kind, "voicemail_no_message");
  // This turn the model asks to wait for the beep. Silence never wakes a voicemail turn; waiting is a
  // mailbox recording nothing until it cuts off.
  const r = await drain((await turn(db.getCall(C, call.id), scripted({ tool: "skip_turn", input: { reason: "waiting for the beep" } }))).stream);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "end_call");
  assert.equal(db.getCall(C, call.id).voicemail_left, 0);
});

// ---------- a different person ----------

test("a transfer re-announces, and the announcement is not a function call — it is the next sentence", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask about catering" }));
  hold.markAnnounced(db.getCall(C, call.id), { party: 1 });

  const r = await drain((await turn(
    db.getCall(C, call.id),
    rounds(
      scripted({ tool: "new_person_on_the_line", input: { who: "the catering manager" } }),
      scripted("Hi — I'm an AI assistant calling on behalf of Omari, and this call is recorded. I'm asking about catering for twenty."),
    ),
  )).stream);
  assert.equal(r.toolCalls.length, 0, "nothing goes to the platform: this is Reason's own bookkeeping");
  assert.match(r.said, /AI assistant/);
  assert.match(r.said, /recorded/);
  assert.equal(db.getCall(C, call.id).party_n, 2);
  assert.deepEqual(hold.partiesTold(db.getCall(C, call.id)), [1, 2]);
});

// ---------- commitments, through the endpoint ----------

test("an inquiry call that tries to agree is told no, and nothing reaches the platform", async () => {
  const call = callWith(brief.buildBrief({ goal: "ask what it costs" }));
  const r = await drain((await turn(
    call,
    rounds(
      scripted({ tool: "propose_commitment", input: { what: "a clean on Saturday for $150", total_cents: 15000 } }),
      scripted("That sounds great — let me just confirm it with Omari and I'll come straight back to you."),
    ),
  )).stream);
  assert.equal(r.toolCalls.length, 0);
  assert.match(r.said, /confirm it with Omari/);
  assert.equal(db.callCommitments(C, call.id)[0].state, "declined");
});

test("a fee nobody approved pauses the call and really texts him, mid-call", async () => {
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: 1 });
  const call = callWith(brief.buildBrief({
    goal: "book the clean", approved: { book: true, maxCents: 20000 }, readBack: ["date", "time"],
  }));
  // A date and time already established on the row, so the only thing outside is the deposit.
  const at = Date.parse("2026-10-14T15:00:00-04:00");
  db.updateCall(C, call.id, { readback: JSON.stringify(readback.recordOf(readback.moment({ at }))) });

  const r = await drain((await turn(
    db.getCall(C, call.id),
    rounds(
      scripted({ tool: "propose_commitment", input: { what: "the clean Wednesday at three", total_cents: 18000, terms: ["a fifty dollar deposit"] } }),
      scripted("Let me just check one thing on that — can I hold for a moment?"),
    ),
  )).stream);

  assert.equal(r.toolCalls.length, 0, "nothing is agreed and nothing is ended");
  assert.match(r.said, /check one thing/);
  const m = db.callCommitments(C, call.id).at(-1);
  assert.equal(m.state, "paused_for_owner");

  // The text is really queued, to the owner, during the call.
  const queued = db.dueOutbound().filter(o => /On the phone now/.test(o.body));
  assert.equal(queued.length, 1);
  assert.match(queued[0].body, /fifty dollar deposit/);
  assert.match(queued[0].body, /Yes or no/);
  assert.equal(queued[0].address, "+12025551234");
});

test("a confirmed booking records what the confirmation rests on, and sets the outcome from rows", () => {
  const call = callWith(brief.buildBrief({
    goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: ["date", "time"],
  }));
  const at = Date.parse("2026-10-14T15:00:00-04:00");
  db.updateCall(C, call.id, { readback: JSON.stringify(readback.recordOf(readback.moment({ at }))) });
  const row = db.getCall(C, call.id);
  const ctx = thirdPartyContext({ call: row });

  const proposed = runCallTool("propose_commitment", { what: "the clean", total_cents: 18000 }, { call: row, context: ctx });
  assert.equal(proposed.allowed, true);
  // The exact words to say come with the permission, so the model formats nothing.
  assert.match(proposed.say, /say exactly "Wednesday the fourteenth of October"/);

  const done = runCallTool(
    "confirm_commitment",
    { commitment_id: proposed.commitment_id, they_said_yes: true, reference: "XK-2291" },
    { call: db.getCall(C, row.id), context: ctx },
  );
  assert.equal(done.ok, true);
  assert.equal(done.strength, "documented");
  assert.equal(db.getCall(C, row.id).outcome_kind, "confirmed");
  assert.equal(db.getCall(C, row.id).confirmation_ref, "XK-2291");
});

test("they did not actually say yes, so it is not confirmed and the call is told to ask plainly", () => {
  const call = callWith(brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: ["date"] }));
  const at = Date.parse("2026-10-14T15:00:00-04:00");
  db.updateCall(C, call.id, { readback: JSON.stringify(readback.recordOf(readback.moment({ at }))) });
  const row = db.getCall(C, call.id);
  const ctx = thirdPartyContext({ call: row });
  const proposed = runCallTool("propose_commitment", { what: "the clean", total_cents: 100 }, { call: row, context: ctx });
  const no = runCallTool("confirm_commitment", { commitment_id: proposed.commitment_id, they_said_yes: false }, { call: row, context: ctx });
  assert.equal(no.ok, false);
  assert.match(no.say, /not confirmed/);
  assert.match(no.say, /wait for an actual yes/);
  assert.notEqual(db.getCall(C, row.id).outcome_kind, "confirmed");
});

// ---------- handing the call to him ----------

test("a transfer is refused until he has said he is there, and nothing is promised to the other person", () => {
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: 1 });
  const call = callWith(brief.buildBrief({ goal: "ask about the quote" }));
  const ctx = thirdPartyContext({ call });

  const early = handOver({ call, context: ctx, input: { reason: "they want to speak to him" } });
  assert.equal(early.ok, false);
  assert.match(early.say, /has not said they are free/);
  assert.match(early.say, /Do not promise that Omari is about to come on/);

  // Once something of his has come back on this call, it may go through.
  const m = db.createCommitment(C, { callId: call.id, what: "x", state: "paused_for_owner" });
  db.updateCommitment(C, m.id, { owner_said: "yeah put them through" });
  const ok = handOver({ call, context: ctx, input: { reason: "they asked for him" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.input.transfer_number, "+12025551234");
  // `agent_message` is the ONLY thing that reaches him through the platform, and a conference transfer
  // takes Reason off the call — so it has to carry the state in one breath.
  assert.match(ok.input.agent_message, /this is your assistant handing over a call/);
  assert.match(ok.input.agent_message, /ask about the quote/);
  assert.match(ok.input.client_message, /put you through/);
});

test("a transfer never dials anywhere but his own number, whatever was asked for", () => {
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: 1 });
  const call = callWith(brief.buildBrief({ goal: "x" }));
  const m = db.createCommitment(C, { callId: call.id, what: "x", state: "paused_for_owner" });
  db.updateCommitment(C, m.id, { owner_said: "go ahead" });
  const r = handOver({
    call, context: thirdPartyContext({ call }),
    input: { reason: "x", transfer_number: "+19998887777" },
  });
  assert.equal(r.input.transfer_number, "+12025551234");
});

// ---------- quotes ----------

test("an answer noted on an errand leg lands in the comparison and sets the outcome", () => {
  const e = db.createErrand(C, { goal: "cheapest clean", questions: brief.CORE_QUESTIONS });
  const call = callWith(brief.buildBrief({ goal: "ask the questions" }), { errand_id: e.id });
  const row = db.getCall(C, call.id);
  const out = runCallTool(
    "note_answer",
    { place: "Clean Co", total_cents: 18000, firmness: "firm", holds_until: "until Thursday", earliest: "Thursday" },
    { call: row, context: thirdPartyContext({ call: row }) },
  );
  assert.equal(out.ok, true);
  assert.match(out.say, /whether the price is firm/);
  assert.equal(db.getCall(C, row.id).outcome_kind, "answered");
  assert.equal(db.errandQuotes(C, e.id)[0].place, "Clean Co");
});

test("a single call with no errand behind it still finishes rather than refusing", () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  const out = runCallTool("note_answer", { place: "P", firmness: "firm" }, { call, context: thirdPartyContext({ call }) });
  assert.equal(out.ok, true);
  assert.match(out.say, /Noted/);
});

test("a tool the call was never offered gets nothing", () => {
  const call = callWith(brief.buildBrief({ goal: "ask" }));
  const out = runCallTool("calendar_add", { title: "x" }, { call, context: thirdPartyContext({ call }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /not something you can do on a call/);
});
