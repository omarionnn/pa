// Reason's own brain on the phone: the custom-LLM endpoint, with an injected generator.
//
// No model runs in here and no network is touched. What is being proven is the part that must be
// right before anybody dials: the SSE framing ElevenLabs documents, that an unauthenticated request
// gets nothing, that the two context builders really are two — one with the thread and the tools and
// one structurally unable to reach either — that a language switch leaves as a function call and
// brings the recording disclosure with it, and that a web address is never spoken.
//
// The generator is a script of events, so every branch is exercisable: words only, a platform tool,
// one of Reason's own tools, a reply with a link in it, a model that throws.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-voice-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
process.env.ELEVENLABS_API_KEY = "eleven-test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ELEVENLABS_LLM_SECRET = "llm-test-secret";
process.env.ELEVENLABS_WEBHOOK_SECRET = "hook-test-secret";
process.env.REASON_UNDO_SECONDS = "0";

const voice = await import("../src/calls/voice.js");
const {
  llmRequest, verifyLlmBearer, identifyCall, contextFor, ownerContext, thirdPartyContext,
  sseChunk, SSE_DONE, withoutSpokenLinks, sentenceSplitter, callLanguage, callBackendName,
  SYSTEM_TOOL_NAMES, MAX_VOICE_TOOL_ROUNDS, LLM_PATH, latestSpoken,
} = voice;
const { EXTRA_BODY_KEYS } = await import("../src/calls/elevenlabs.js");
const harm = await import("../src/harm.js");
const { announcementFor, callRulesFor } = await import("../src/calls/provider.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const PLACE = "+12125559999";
const ANN = announcementFor({ ownerName: "Omari" });
const RULES = callRulesFor({ ownerName: "Omari" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM harm_events; DELETE FROM action_ledger;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  await voice.prime();
});

/** One owner call and one third-party call, as rows the way each is really created. */
const ownerCall = () => db.createCall(C, {
  provider: "elevenlabs", toNumber: "+12025551234", isOwner: true,
  goal: "Omari called Reason", facts: [], direction: "in", externalId: "conv_in", state: "in_progress",
});
const thirdPartyCall = (over = {}) => db.createCall(C, {
  provider: "elevenlabs", toNumber: PLACE, isOwner: false,
  goal: "ask for a table for four at eight on Saturday",
  facts: ["the name is Omari", "four people"],
  announcement: ANN, externalId: "conv_out", ...over,
});

/** A generator of scripted events: `["some words", {tool:"end_call", input:{}}]`. */
const scripted = (...events) => async function* () {
  for (const e of events) {
    if (typeof e === "string") yield { type: "text", text: e };
    else if (e.throws) throw new Error(e.throws);
    else yield { type: "tool_use", name: e.tool, id: e.id ?? "tu_1", input: e.input ?? {} };
  }
};

/** Everything a stream yielded, plus the chunks parsed out of it. */
async function drain(stream) {
  const raw = [];
  for await (const s of stream) raw.push(s);
  const text = raw.join("");
  const chunks = raw.filter(s => s.startsWith("data: ") && !s.includes("[DONE]"))
    .map(s => JSON.parse(s.slice(6)));
  return {
    raw, text, chunks,
    said: chunks.map(c => c.choices[0].delta.content ?? "").join(""),
    toolCalls: chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []),
    finish: chunks.map(c => c.choices[0].finish_reason).filter(Boolean),
  };
}

const bodyFor = (call, { messages = [{ role: "user", content: "hey" }], kind = null } = {}) => JSON.stringify({
  model: "reason", stream: true,
  messages: [{ role: "system", content: "you are a helpful agent configured in our dashboard" }, ...messages],
  elevenlabs_extra_body: {
    [EXTRA_BODY_KEYS.callId]: call.id,
    [EXTRA_BODY_KEYS.conversationId]: call.conversation_id,
    ...(kind ? { [EXTRA_BODY_KEYS.kind]: kind } : {}),
  },
});
const AUTH = { authorization: "Bearer llm-test-secret" };

// ---------- who is allowed in ----------

test("the bearer secret is the door, and there is no way past it", async () => {
  assert.equal(verifyLlmBearer({ headers: AUTH }).ok, true);
  assert.equal(verifyLlmBearer({ headers: { authorization: "Bearer wrong" } }).ok, false);
  assert.equal(verifyLlmBearer({ headers: {} }).ok, false);
  // Case of the header and of the scheme are both the sender's business.
  assert.equal(verifyLlmBearer({ headers: { Authorization: "bearer llm-test-secret" } }).ok, true);
  // No secret configured is a NO. An endpoint that answers anybody is an endpoint that will
  // eventually answer somebody, and this one spends model credit and reads a private thread aloud.
  const none = verifyLlmBearer({ headers: AUTH, secret: "" });
  assert.equal(none.ok, false);
  assert.match(none.why, /ELEVENLABS_LLM_SECRET/);

  const call = ownerCall();
  const out = await llmRequest({ rawBody: bodyFor(call), headers: { authorization: "Bearer nope" }, generate: scripted("should never run") });
  assert.equal(out.status, 401);
  assert.equal(out.stream, undefined);
  assert.match(JSON.parse(out.body).error.message, /does not match/);
});

test("a request Reason cannot place gets one honest line and a hang-up, not silence", async () => {
  // Somebody IS on a phone. Dead air is the worst answer, and pretending is worse than dead air.
  const out = await llmRequest({ rawBody: JSON.stringify({ messages: [], elevenlabs_extra_body: {} }), headers: AUTH });
  assert.equal(out.status, 200);
  const r = await drain(out.stream);
  assert.match(r.said, /can't pick this one up/i);
  assert.equal(r.toolCalls[0].function.name, "end_call");
  assert.ok(r.text.endsWith(SSE_DONE));

  // Bad JSON is not somebody on a phone — it is a broken client, and gets a plain error.
  assert.equal((await llmRequest({ rawBody: "{", headers: AUTH })).status, 400);
});

// ---------- which call is this ----------

test("the call is found by Reason's own ids, and by the conversation id for an inbound one", () => {
  const out = thirdPartyCall();
  const found = identifyCall({ elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: out.id, [EXTRA_BODY_KEYS.conversationId]: C } });
  assert.equal(found.ok, true);
  assert.equal(found.call.id, out.id);
  assert.equal(found.kind, "third_party");

  // Inbound: nothing of Reason's was in the request, because Reason did not start the call. The row
  // the personalization webhook wrote during the ring is found by the platform's own id.
  const inbound = ownerCall();
  const byConv = identifyCall({ conversation_id: "conv_in" });
  assert.equal(byConv.ok, true);
  assert.equal(byConv.call.id, inbound.id);
  assert.equal(byConv.kind, "owner");

  // A call id without its conversation is a number anybody could count up to.
  assert.equal(identifyCall({ elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: out.id } }).ok, false);
  assert.equal(identifyCall({ elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: 99999, [EXTRA_BODY_KEYS.conversationId]: C } }).ok, false);
  assert.equal(identifyCall({ conversation_id: "conv_nobody" }).ok, false);
  assert.match(identifyCall({}).why, /neither Reason's own call ids nor a conversation id/);
});

test("a request that disagrees with the row about what kind of call this is gets nothing", () => {
  // The two readings differ by exactly the thing that matters: a restaurant hearing a goal versus a
  // restaurant hearing somebody's calendar. So a disagreement is refused, not resolved.
  const out = thirdPartyCall();
  const lying = identifyCall({ elevenlabs_extra_body: {
    [EXTRA_BODY_KEYS.callId]: out.id, [EXTRA_BODY_KEYS.conversationId]: C, [EXTRA_BODY_KEYS.kind]: "owner",
  } });
  assert.equal(lying.ok, false);
  assert.match(lying.why, /says this is a owner call and call #\d+ is a third_party call/);

  const mine = ownerCall();
  assert.equal(identifyCall({ elevenlabs_extra_body: {
    [EXTRA_BODY_KEYS.callId]: mine.id, [EXTRA_BODY_KEYS.conversationId]: C, [EXTRA_BODY_KEYS.kind]: "third_party",
  } }).ok, false);

  // Agreeing is fine, and so is saying nothing.
  assert.equal(identifyCall({ elevenlabs_extra_body: {
    [EXTRA_BODY_KEYS.callId]: out.id, [EXTRA_BODY_KEYS.conversationId]: C, [EXTRA_BODY_KEYS.kind]: "third_party",
  } }).ok, true);
});

test("a call that has already ended gets no more turns", () => {
  const out = thirdPartyCall();
  db.updateCall(C, out.id, { state: "completed" });
  const r = identifyCall({ elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: out.id, [EXTRA_BODY_KEYS.conversationId]: C } });
  assert.equal(r.ok, false);
  assert.match(r.why, /already completed/);
});

// ---------- the two contexts ----------

test("a third-party call's context cannot reach a thread, a memory or a tool", () => {
  // The isolation is what is BUILT, not what is asked of the model, so this reads the context.
  // Planted strings nothing in any prompt could coin by accident, so a hit is really a leak.
  db.saveConversation(C, [
    { role: "user", content: "[Wed] Omari: my card number is 4111 1111 1111 1111" },
    { role: "assistant", content: "ZZQ-NEVER-SPEAK-THIS" },
    { role: "user", content: "[Wed] Omari: also I'm seeing Dr Quibblesworth at nine" },
  ]);

  const ctx = thirdPartyContext({ call: thirdPartyCall(), callMessages: [{ role: "user", content: "hello, Carbone" }] });
  assert.equal(ctx.kind, "third_party");
  // Not one tool of Reason's. A call to a restaurant with calendar_add on it is one prompt
  // injection away from a restaurant changing somebody's week.
  assert.deepEqual(ctx.reasonTools, []);
  assert.deepEqual(ctx.systemTools.map(t => t.name), SYSTEM_TOOL_NAMES);
  // The call and nothing but the call.
  assert.deepEqual(ctx.messages, [{ role: "user", content: "hello, Carbone" }]);
  // Nothing of theirs is anywhere in the prompt, and nothing of theirs is in the messages either.
  const everything = `${ctx.system}\n${JSON.stringify(ctx.messages)}`;
  for (const leak of ["Dr Quibblesworth", "4111", "ZZQ-NEVER-SPEAK-THIS"]) {
    assert.ok(!everything.includes(leak), `a third-party call must not carry ${leak}`);
  }
  // What it DOES have: the goal, the approved facts, and the standing rules.
  assert.ok(ctx.system.includes("ask for a table for four at eight on Saturday"));
  assert.ok(ctx.system.includes("the name is Omari"));
  assert.ok(/never give out payment details/i.test(ctx.system));
  assert.ok(ctx.system.includes("check with Omari and come back"));
  assert.ok(ctx.system.includes(ANN), "it is told its opening line was already spoken, verbatim");
});

test("the standing rules are rebuilt rather than read off the row", () => {
  // A row written by an older version must not be a call with weaker rules on it.
  const call = thirdPartyCall();
  const ctx = thirdPartyContext({ call });
  for (const rule of RULES) assert.ok(ctx.system.includes(rule), `missing: ${rule.slice(0, 40)}`);
});

test("an owner call's context has their prompt, their thread, their open jobs and their tools", async () => {
  db.saveConversation(C, [
    { role: "user", content: "[Wed] Omari: book carbone for saturday" },
    { role: "assistant", content: "on it" },
  ]);
  const { runTool } = await import("../src/tools.js");
  await runTool("task_start", { title: "book Carbone", goal: "a table for four Saturday" }, { conversationId: C, messages: [] });

  const ctx = ownerContext({ call: ownerCall() });
  assert.equal(ctx.kind, "owner");
  // Their own thread is in the messages, and the agent-level system prompt from the dashboard is not.
  assert.ok(ctx.messages.some(m => String(m.content).includes("book carbone for saturday")));
  assert.ok(ctx.messages.some(m => m.role === "assistant" && m.content === "on it"));
  // Every tool they have in a text, the confirm gate included: a spoken yes goes through the same
  // judge onto the same row as a typed one.
  const names = ctx.reasonTools.map(t => t.name);
  for (const t of ["confirm_request", "confirm_record", "message_send", "memory_page"]) {
    assert.ok(names.includes(t), `an owner call should have ${t}`);
  }
  // What is open, so it can open with the thing instead of with a question.
  assert.ok(ctx.system.includes("book Carbone"));
  assert.ok(/ON A PHONE CALL/.test(ctx.system));
  // And nothing about recording is recited at the person who set this up.
  assert.ok(/Do NOT recite anything about the call being recorded/.test(ctx.system));
  assert.ok(!ctx.system.includes(ANN));
});

test("contextFor picks the builder off the row, not off anything in the request", () => {
  assert.equal(contextFor({ call: ownerCall(), kind: "owner" }).kind, "owner");
  assert.equal(contextFor({ call: thirdPartyCall(), kind: "third_party" }).reasonTools.length, 0);
});

test("the thread a voice turn is handed is short, and never starts on a reply", () => {
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ role: "user", content: `[Wed] Omari: message ${i}` });
    many.push({ role: "assistant", content: `reply ${i}` });
  }
  db.saveConversation(C, many);
  const ctx = ownerContext({ call: ownerCall() });
  assert.ok(ctx.messages.length <= config.callHistoryTurns + 1, `got ${ctx.messages.length}`);
  // The model's first message has to be a user one; a window that happens to open on a reply would
  // be a request the API refuses.
  assert.equal(ctx.messages[0].role, "user");

  // A thread that starts with a reply is trimmed down to the first real message.
  db.saveConversation(C, [{ role: "assistant", content: "out of nowhere" }, { role: "user", content: "[Wed] Omari: hi" }]);
  assert.equal(ownerContext({ call: ownerCall() }).messages[0].role, "user");
});

// ---------- the stream ----------

test("the SSE is the documented shape, opens with the role, and always ends with [DONE]", async () => {
  const call = ownerCall();
  const out = await llmRequest({ rawBody: bodyFor(call), headers: AUTH, generate: scripted("Hey. ", "All good?") });
  assert.equal(out.status, 200);
  assert.equal(out.headers["Content-Type"], "text/event-stream");

  const r = await drain(out.stream);
  for (const line of r.raw) assert.ok(line.startsWith("data: ") && line.endsWith("\n\n"), JSON.stringify(line));
  assert.equal(r.raw.at(-1), SSE_DONE);
  assert.equal(r.text.endsWith("data: [DONE]\n\n"), true);

  assert.deepEqual(r.chunks[0].choices[0].delta, { role: "assistant" });
  assert.equal(r.chunks[0].object, "chat.completion.chunk");
  assert.equal(r.chunks[0].model, "reason");
  assert.ok(r.chunks.every(c => c.id === r.chunks[0].id), "one id for the whole stream");
  assert.deepEqual(r.finish, ["stop"]);
  assert.match(r.said, /Hey\./);
  assert.match(r.said, /All good\?/);
});

test("words stream at a sentence boundary rather than waiting for the whole reply", async () => {
  const call = ownerCall();
  // Three deltas that together are two sentences: the first sentence must leave before the last
  // delta has been seen, which is what makes a call feel alive rather than laggy.
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: scripted("The table's ", "confirmed for eight. ", "Anything else?"),
  });
  const r = await drain(out.stream);
  const spoken = r.chunks.filter(c => c.choices[0].delta.content);
  assert.equal(spoken.length, 2, "one chunk per sentence");
  assert.match(spoken[0].choices[0].delta.content, /The table's confirmed for eight\./);
  assert.match(spoken[1].choices[0].delta.content, /Anything else\?/);
});

test("the splitter hands back whole sentences and keeps the rest", () => {
  const s = sentenceSplitter();
  assert.deepEqual(s.push("one. tw"), ["one. "]);
  assert.deepEqual(s.push("o! three"), ["two! "]);
  assert.deepEqual(s.push(""), []);
  assert.deepEqual(s.flush(), ["three"]);
  assert.deepEqual(s.flush(), [], "nothing is handed back twice");
});

test("a model that falls over mid-call says so out loud rather than going quiet", async () => {
  const call = ownerCall();
  const out = await llmRequest({ rawBody: bodyFor(call), headers: AUTH, generate: scripted("One sec. ", { throws: "the model died" }) });
  const r = await drain(out.stream);
  assert.match(r.said, /something broke on my end/i);
  assert.equal(r.raw.at(-1), SSE_DONE);
});

// ---------- never say a URL ----------

test("a web address is taken out of the words and texted instead", async () => {
  // Not a rule in the prompt. "h t t p s colon slash slash" is not a link anybody can use, so the
  // address leaves the spoken words in code and arrives as a text during the call.
  const { spoken, links } = withoutSpokenLinks("I put it here: https://reason.example/p/abc123 — have a look.");
  assert.ok(!spoken.includes("https://"));
  assert.match(spoken, /texting it to you now/);
  assert.deepEqual(links, ["https://reason.example/p/abc123"]);

  // A sentence-ending period belongs to the sentence, not to the address.
  assert.deepEqual(withoutSpokenLinks("it's at www.carbone.com.").links, ["www.carbone.com"]);
  assert.deepEqual(withoutSpokenLinks("check reason.example/x now").links, ["reason.example/x"]);
  // Ordinary words are left alone.
  assert.deepEqual(withoutSpokenLinks("eight o'clock on Saturday, four people.").links, []);
  assert.equal(withoutSpokenLinks("eight o'clock on Saturday.").spoken, "eight o'clock on Saturday.");
});

test("on an owner call the link is really in the outbox, during the call", async () => {
  const call = ownerCall();
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: scripted("Made you a page: https://reason.example/p/abc123 — texting it now."),
  });
  const r = await drain(out.stream);
  assert.ok(!r.said.includes("https://"), "no address was spoken");

  const queued = db.db.prepare("SELECT * FROM outbox").all();
  assert.equal(queued.length, 1);
  assert.match(queued[0].body, /https:\/\/reason\.example\/p\/abc123/);
  assert.equal(queued[0].address, "+12025551234");
  assert.equal(queued[0].channel, "sendblue");
});

test("on a third-party call there is nobody to text, so the address is dropped and nothing is queued", async () => {
  const call = thirdPartyCall();
  const seen = [];
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l),
    generate: scripted("You can see it at https://reason.example/p/abc123 if you like."),
  });
  const r = await drain(out.stream);
  assert.ok(!r.said.includes("https://"));
  // The restaurant is not in anybody's conversation, so nothing is sent to anybody.
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);
  assert.ok(seen.some(l => l.call_link_not_spoken === call.id), "and it is logged rather than lost");
});

// ---------- the platform's own tools ----------

test("end_call leaves as an OpenAI function call and ends the turn", async () => {
  const call = thirdPartyCall();
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: scripted("Great, thanks very much. ", { tool: "end_call", input: { reason: "the table is booked" } }),
  });
  const r = await drain(out.stream);
  assert.match(r.said, /thanks very much/);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].type, "function");
  assert.equal(r.toolCalls[0].function.name, "end_call");
  assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { reason: "the table is booked" });
  assert.deepEqual(r.finish, ["tool_calls"]);
});

test("the other side switches to Spanish: the function call goes, and the disclosure is re-spoken", async () => {
  const call = thirdPartyCall();

  // Turn one: they answer in Spanish. The voice half is ElevenLabs' own tool, which it only acts on
  // if the model answers with a standard function call — so both halves have to happen together.
  const first = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "¿Diga?" }] }), headers: AUTH,
    generate: scripted("Buenas tardes. ", { tool: "language_detection", input: { language: "es", reason: "they answered in Spanish" } }),
  });
  const r1 = await drain(first.stream);
  assert.equal(r1.toolCalls[0].function.name, "language_detection");
  assert.equal(JSON.parse(r1.toolCalls[0].function.arguments).language, "es");

  // The call is now in Spanish, and the recording disclosure is OWED in Spanish — not yet given:
  // the only language the person has heard "this call is recorded" in may be one they do not speak,
  // and the first turn that can carry the instruction is the next one.
  const after = db.getCall(C, call.id);
  assert.equal(after.language, "es");
  assert.deepEqual(callLanguage(after).announcedIn, []);

  // Turn two is told to say it again, in that language, before anything else.
  const ctx = thirdPartyContext({ call: after });
  assert.match(ctx.system, /This call has just changed language, to es/);
  assert.match(ctx.system, /say in es that you are an AI assistant/);
  assert.match(ctx.system, /the call is recorded/);
  assert.match(ctx.system, /Say it once; do not repeat it again later in the call/);

  // And once is once: asking for it and writing down that it was asked for are one statement, so
  // two turns arriving together cannot both be told to say it, and a call that drifts back and
  // forth does not recite it every other sentence.
  assert.deepEqual(callLanguage(db.getCall(C, call.id)).announcedIn, ["es"]);
  const third = thirdPartyContext({ call: db.getCall(C, call.id) });
  assert.ok(!/just changed language/.test(third.system));
});

test("a switch to the language the call is already in is dropped, not sent to the platform", async () => {
  // From the first rehearsal (2026-10-06): once the restaurant answered in Spanish the model called
  // language_detection on every turn afterwards. The words were right and the tool call was noise —
  // and noise aimed at the platform re-configures a live call, so it is dropped in code rather than
  // only asked against in the prompt.
  const call = thirdPartyCall({ });
  db.updateCall(C, call.id, { language: "es", language_announced: "es" });
  const seen = [];

  const out = await llmRequest({
    rawBody: bodyFor(db.getCall(C, call.id), { messages: [{ role: "user", content: "Sí, a las nueve y media." }] }),
    headers: AUTH, log: (l) => seen.push(l),
    generate: scripted("Perfecto, se lo comento a Omari. ", { tool: "language_detection", input: { language: "es" } }),
  });
  const r = await drain(out.stream);
  assert.deepEqual(r.toolCalls, [], "nothing was sent to the platform");
  assert.match(r.said, /se lo comento a Omari/);
  assert.deepEqual(r.finish, ["stop"]);
  assert.ok(seen.some(l => l.call_language_already === call.id));
  assert.equal(r.raw.at(-1), SSE_DONE);

  // A real change still goes.
  const moved = await llmRequest({
    rawBody: bodyFor(db.getCall(C, call.id), { messages: [{ role: "user", content: "Actually, in English please." }] }),
    headers: AUTH,
    generate: scripted("Of course. ", { tool: "language_detection", input: { language: "en" } }),
  });
  const m = await drain(moved.stream);
  assert.equal(m.toolCalls[0].function.name, "language_detection");
  assert.equal(db.getCall(C, call.id).language, "en");
});

test("the owner is never recited a recording line, in any language", async () => {
  const call = ownerCall();
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "oye, qué tal" }] }), headers: AUTH,
    generate: scripted("Todo bien. ", { tool: "language_detection", input: { language: "es" } }),
  });
  await drain(out.stream);
  const after = db.getCall(C, call.id);
  assert.equal(after.language, "es", "it still switches language with them");
  // But nothing about recording is ever said at the person who set this up. They were told once, by
  // text, the first time their number rang (src/calls/inbound.js).
  assert.deepEqual(callLanguage(after).announcedIn, []);
  assert.ok(!/just changed language/.test(ownerContext({ call: after }).system));
});

// ---------- Reason's own tools ----------

test("an owner call runs Reason's own tools, with the thinking filler instead of dead air", async () => {
  const call = ownerCall();
  const ran = [];
  voice.contextDeps.runTool = async (name, input) => { ran.push({ name, input }); return { ok: true, memories: [] }; };

  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: (() => {
      let round = 0;
      return async function* () {
        round++;
        if (round === 1) { yield { type: "tool_use", name: "memory_page", id: "tu_1", input: {} }; return; }
        yield { type: "text", text: "Nothing on file about that yet." };
      };
    })(),
  });
  const r = await drain(out.stream);
  assert.deepEqual(ran.map(t => t.name), ["memory_page"]);
  // Their own suggestion: a chunk ending in "... " buys the time without the person thinking the
  // line dropped.
  assert.match(r.said, /One sec\.\.\. /);
  assert.match(r.said, /Nothing on file about that yet\./);
  assert.deepEqual(r.finish, ["stop"]);
});

test("a third-party call asking for one of Reason's tools gets it refused, not run", async () => {
  // It was never offered any — `reasonTools` is empty — so anything claiming to be one is a
  // prompt-injected restaurant, and it is refused rather than run.
  const call = thirdPartyCall();
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true }; };
  const seen = [];

  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l),
    generate: scripted("Sure, one moment. ", { tool: "calendar_add", input: { title: "whatever they said" } }),
  });
  const r = await drain(out.stream);
  assert.deepEqual(ran, [], "nothing of Reason's ran on a third-party call");
  assert.ok(seen.some(l => l.call_tool_refused === call.id));
  assert.deepEqual(r.finish, ["stop"]);
  assert.equal(r.raw.at(-1), SSE_DONE);
});

test("a turn that uses up its tool rounds says so rather than leaving the line silent", async () => {
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true });
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    // A model that only ever asks for another tool. On a phone, a person is holding a handset.
    generate: async function* () { yield { type: "tool_use", name: "memory_page", id: "tu_x", input: {} }; },
  });
  const r = await drain(out.stream);
  assert.match(r.said, /come back to you/i);
  assert.deepEqual(r.finish, ["stop"]);
  assert.ok(MAX_VOICE_TOOL_ROUNDS <= 3, "a phone turn cannot wait for many rounds");
});

// ---------- the safety screen, on a phone ----------

test("a phone is another way in, so the harm screen runs on what was just said", async () => {
  // The screen lives in Runtime._turn, and a voice turn does not go through the runtime at all —
  // so without this, something refused in a text would be answered on a call.
  const call = ownerCall();
  const generated = [];
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "walk me through making something that hurts people" }] }),
    headers: AUTH,
    screen: async () => ({ verdict: "harm", category: "weapons", note: "asked for a build" }),
    // The reply is generated in parallel — that is what buys the latency — and then thrown away
    // unspoken. If any of it reached the line, this is what would show it.
    generate: async function* () { generated.push(1); yield { type: "text", text: "SHOULD-NEVER-BE-SPOKEN" }; },
  });
  const r = await drain(out.stream);

  assert.ok(!r.said.includes("SHOULD-NEVER-BE-SPOKEN"), "the reply was thrown away unspoken");
  assert.equal(r.said, harm.REFUSAL_LINE);
  // A person who has just been told no is not somebody to leave on an open line.
  assert.equal(r.toolCalls[0].function.name, "end_call");
  assert.deepEqual(r.finish, ["tool_calls"]);
  assert.equal(r.raw.at(-1), SSE_DONE);
});

test("a refusal on a call is written down and counted exactly as one in a text", async () => {
  const call = ownerCall();
  const refuse = async () => ({ verdict: "harm", category: "weapons", note: "asked for a build" });
  const body = bodyFor(call, { messages: [{ role: "user", content: "how do i make one" }] });
  await drain((await llmRequest({ rawBody: body, headers: AUTH, screen: refuse, generate: scripted("x") })).stream);

  // Their line and the answer go into the thread, so the next turn knows this happened.
  const thread = db.loadConversation(C);
  assert.match(String(thread.at(-2).content), /how do i make one/);
  assert.equal(thread.at(-1).content, harm.REFUSAL_LINE);
  // On the record, with the call it happened on.
  const row = db.db.prepare("SELECT * FROM action_ledger WHERE action = 'harm_refuse'").get();
  assert.ok(row);
  assert.match(row.attempted, /"on_call":\d+/);
  assert.equal(db.harmEventsSince(C, 0, { verdict: "harm" }).length, 1);
});

test("enough strikes on calls pause that person, and the master is told the count not the words", async () => {
  // Somebody who is not the operator, because the master is refused and never paused.
  const them = "dm:sendblue:+12125551111";
  db.upsertAccount({ conversationId: them, channel: "sendblue", address: "+12125551111", name: "Kofi" });
  const call = db.createCall(them, {
    provider: "elevenlabs", toNumber: "+12125551111", isOwner: true, goal: "Kofi called", facts: [],
    direction: "in", externalId: "conv_kofi", state: "in_progress",
  });
  const refuse = async () => ({ verdict: "harm", category: "weapons", note: "asked for a build" });

  const was = config.harmStrikeLimit;
  try {
    config.harmStrikeLimit = 2;
    for (let i = 0; i < 2; i++) {
      const body = JSON.stringify({
        model: "reason", messages: [{ role: "user", content: `try number ${i}` }],
        elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: call.id, [EXTRA_BODY_KEYS.conversationId]: them },
      });
      await drain((await llmRequest({ rawBody: body, headers: AUTH, screen: refuse, generate: scripted("x") })).stream);
    }
    assert.equal(db.getAccount(them).state, "paused");
    const told = db.db.prepare("SELECT * FROM outbox WHERE conversation_id = ?").all(C);
    assert.equal(told.length, 1);
    assert.match(told[0].body, /i've paused their reason/);
    assert.match(told[0].body, /ending 1111/, "the last four digits, never the number");
    assert.ok(!told[0].body.includes("try number"), "and never their words");
  } finally {
    config.harmStrikeLimit = was;
  }
});

test("a crisis is not a refusal: the help line is said and the call carries on", async () => {
  const call = ownerCall();
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "i don't want to be here anymore" }] }),
    headers: AUTH,
    screen: async () => ({ verdict: "crisis", category: "self_harm", note: "" }),
    generate: scripted("I'm here. Talk to me."),
  });
  const r = await drain(out.stream);

  assert.ok(harm.carriesCrisisHelp(r.said), "the help line really is in what was said");
  assert.match(r.said, /I'm here\. Talk to me\./, "and the reply still goes out after it");
  // Not the end of the call, and never a strike: this person is the one at risk, and cutting them
  // off would be the one wrong thing to do.
  assert.deepEqual(r.finish, ["stop"]);
  assert.equal(db.harmEventsSince(C, 0, { verdict: "harm" }).length, 0);
  assert.equal(db.harmEventsSince(C, 0, { verdict: "crisis" }).length, 1);
  assert.equal(db.getAccount(C).state ?? "active", "active");
});

test("a third-party call is not screened, and a restaurant cannot be struck", async () => {
  // There is no thread, no memory and no tool there, Reason is the one doing the asking, and a
  // restaurant is not a person who can be paused.
  const call = thirdPartyCall();
  let asked = 0;
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "and what's it for, a birthday?" }] }),
    headers: AUTH,
    screen: async () => { asked++; return { verdict: "harm", category: "other" }; },
    generate: scripted("I'll check with Omari and come back to you."),
  });
  const r = await drain(out.stream);
  assert.equal(asked, 0, "the screen was never asked");
  assert.match(r.said, /check with Omari/);
  assert.equal(db.harmEventsSince(C, 0, { verdict: "harm" }).length, 0);
});

test("a screen that breaks or has no model does not take the call down", async () => {
  const call = ownerCall();
  for (const screen of [
    async () => { throw new Error("the screen died"); },
    async () => ({ verdict: "unscreened", error: "timed out" }),
    async () => ({ verdict: "clear", skipped: "no_model" }),
    async () => ({ verdict: "borderline", category: "other" }),
  ]) {
    const out = await llmRequest({
      rawBody: bodyFor(call, { messages: [{ role: "user", content: "what's up" }] }),
      headers: AUTH, screen, generate: scripted("All good."),
    });
    const r = await drain(out.stream);
    assert.match(r.said, /All good\./);
    assert.deepEqual(r.finish, ["stop"]);
  }
  assert.equal(db.harmEventsSince(C, 0, { verdict: "harm" }).length, 0);
});

test("only the newest thing they said is screened, not the whole call again", () => {
  // The earlier turns were screened when they were said; re-reading them every turn would pay for
  // the same verdict five times on a five-turn call.
  assert.equal(latestSpoken([
    { role: "user", content: "first" },
    { role: "assistant", content: "a reply" },
    { role: "user", content: "the newest thing" },
  ]), "the newest thing");
  assert.equal(latestSpoken([{ role: "assistant", content: "only a reply" }]), "");
  assert.equal(latestSpoken([]), "");
});

// ---------- small things that have to be right ----------

test("the chunk helper is exactly the documented framing", () => {
  const s = sseChunk({ id: "x", model: "m", created: 1, delta: { content: "hi" }, finish: null });
  assert.equal(s, `data: ${JSON.stringify({
    id: "x", object: "chat.completion.chunk", created: 1, model: "m",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
  })}\n\n`);
  assert.equal(SSE_DONE, "data: [DONE]\n\n");
  assert.equal(LLM_PATH, "/calls/elevenlabs/llm");
});

test("which backend answers a voice turn is one environment variable", () => {
  const was = config.callBackend;
  const wasBackend = process.env.REASON_BACKEND;
  try {
    // Empty means whatever the rest of Reason runs on, so an install that sets nothing is unchanged.
    config.callBackend = "";
    delete process.env.REASON_BACKEND;
    assert.equal(callBackendName(), "api");
    process.env.REASON_BACKEND = "claude-cli";
    assert.equal(callBackendName(), "claude-cli");
    // And Friday's switch pins the API path for calls alone, leaving the rest where it is.
    config.callBackend = "api";
    assert.equal(callBackendName(), "api");
  } finally {
    config.callBackend = was;
    if (wasBackend === undefined) delete process.env.REASON_BACKEND; else process.env.REASON_BACKEND = wasBackend;
  }
});
