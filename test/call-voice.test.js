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
const prompts = await import("../src/calls/voice-prompt.js");
const {
  llmRequest, verifyLlmBearer, identifyCall, contextFor, ownerContext, thirdPartyContext,
  sseChunk, SSE_DONE, withoutSpokenLinks, sentenceSplitter, callLanguage, callBackendName,
  SYSTEM_TOOL_NAMES, MAX_VOICE_TOOL_ROUNDS, LLM_PATH, latestSpoken,
  LINE_IS_QUIET, endOnTheirSide, CALL_TOOL_BUDGET_MS,
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
  // The call-side tools ARE offered on a third-party call (2026-10-07), so they get the same scrutiny:
  // none of them may be a route back to the thread, the calendar or a file. Each only writes down
  // something about the call it is already on, and two of the five exist to STOP things happening.
  assert.deepEqual(ctx.callTools.map(t => t.name).sort(), [
    "confirm_commitment", "machine_on_the_line", "new_person_on_the_line", "note_answer", "propose_commitment", "release_commitment",
  ]);
  for (const t of ctx.callTools) {
    assert.ok(!/calendar|memory|email|file|page|thread|photo|drive|contact/i.test(t.name), `${t.name} is not a call-side tool`);
  }
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
    // A turn already past the filler's minimum age (the scripted model answers instantly).
    rawBody: bodyFor(call), headers: AUTH, fillerAfterMs: 0,
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

test("a lookup on one turn is still known on the next, and written into the thread after the call", async () => {
  // Call 41 (2026-10-23): the platform sends each turn back as spoken words only, so the turn after a
  // real gold-price search saw its own number with nothing behind it and told him it had never looked.
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true, results: [{ title: "Gold price | Kitco", text: "4,031.20 USD/oz" }] });
  const first = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "what's the price of gold?" }] }), headers: AUTH,
    generate: (() => {
      let round = 0;
      return async function* () {
        round++;
        if (round === 1) { yield { type: "tool_use", name: "web_search", id: "tu_1", input: { query: "gold price today" } }; return; }
        yield { type: "text", text: "About four thousand thirty-one an ounce, per Kitco." };
      };
    })(),
  });
  await drain(first.stream);

  const seen = [];
  const second = await llmRequest({
    rawBody: bodyFor(call, { messages: [
      { role: "user", content: "what's the price of gold?" },
      { role: "assistant", content: "One sec... About four thousand thirty-one an ounce, per Kitco." },
      { role: "user", content: "ok thanks" },
    ] }),
    headers: AUTH,
    generate: async function* ({ messages }) { seen.push(messages); yield { type: "text", text: "Anytime." }; },
  });
  await drain(second.stream);
  const last = seen[0].at(-1);
  assert.equal(last.role, "user");
  const record = last.content[0].text;
  assert.match(record, /lookup you have really run/);
  assert.match(record, /not something to mention/);
  assert.match(record, /web_search \{"query":"gold price today"\}/);
  assert.match(record, /Kitco/);
  assert.equal(last.content.at(-1).text, "ok thanks", "their own words stay last");

  // After the call, the texts that follow can see the search too.
  const { writeCallIntoThread } = await import("../src/calls/postcall.js");
  const row = { ...db.getCall(C, call.id), state: "completed" };
  writeCallIntoThread({ row, live: { turns: [{ who: "them", text: "what's the price of gold?" }, { who: "agent", text: "About 4,031, per Kitco." }] } });
  const thread = db.loadConversation(C);
  assert.ok(thread.some(m => /lookups you really ran on it — web_search \{"query":"gold price today"\}/.test(String(m.content))));
});

test("a call with no lookups sends their words exactly as they were", () => {
  const msgs = [{ role: "user", content: "hey" }];
  assert.equal(voice.withCallRecord(msgs, []), msgs);
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

// ---------- the text path's silence marker is never speech (call 42, 2026-10-23) ----------

test("a turn that is only NO_REPLY says nothing and does not hang up", async () => {
  // The real end of call 42: "no, don't do anything, leave it", then the line went quiet, and the
  // model's turn was the text path's marker — which the voice read out as "No reply. No reply."
  const call = ownerCall();
  const logs = [];
  for (const turn of [["NO_REPLY"], ["NO_", "REPLY"], ["NO_REPLY."], ["  no_reply  "]]) {
    const out = await llmRequest({ rawBody: bodyFor(call), headers: AUTH, generate: scripted(...turn), log: (e) => logs.push(e) });
    const r = await drain(out.stream);
    assert.equal(r.said, "", `nothing spoken for ${JSON.stringify(turn)}`);
    assert.doesNotMatch(r.said, /no[ _]?reply/i);
    assert.equal(r.toolCalls.length, 0, "and the call is not ended");
    assert.deepEqual(r.finish, ["stop"]);
  }
  assert.ok(logs.some(l => l.voice_no_reply_dropped === call.id));
});

test("a real sentence with the marker after it keeps the sentence and drops the marker", async () => {
  const call = ownerCall();
  const out = await llmRequest({ rawBody: bodyFor(call), headers: AUTH, generate: scripted("Got it, leaving it alone. ", "NO_REPLY") });
  const r = await drain(out.stream);
  assert.equal(r.said, "Got it, leaving it alone.");
});

test("end_call's spoken message never carries the marker: only-marker goes quietly, mixed keeps the words", async () => {
  // The platform speaks end_call's `message` itself, so it never passed the sentence filter.
  const logs = [];
  const only = await drain((await llmRequest({ rawBody: bodyFor(ownerCall()), headers: AUTH, log: (e) => logs.push(e),
    generate: scripted({ tool: "end_call", input: { reason: "done", message: "NO_REPLY" } }) })).stream);
  assert.equal(only.toolCalls[0].function.name, "end_call", "still hangs up");
  assert.deepEqual(JSON.parse(only.toolCalls[0].function.arguments), { reason: "done" });
  assert.ok(logs.some(l => l.voice_no_reply_dropped && l.tool === "end_call"));

  const mixed = await drain((await llmRequest({ rawBody: bodyFor(ownerCall()), headers: AUTH,
    generate: scripted({ tool: "end_call", input: { reason: "done", message: "Okay, talk soon. NO_REPLY" } }) })).stream);
  assert.match(JSON.parse(mixed.toolCalls[0].function.arguments).message, /^Okay, talk soon/, "the words are kept");
  assert.doesNotMatch(mixed.toolCalls[0].function.arguments, /no[ _]?reply/i);
});

test("'no reply' in an ordinary sentence is still said", async () => {
  const call = ownerCall();
  const out = await llmRequest({ rawBody: bodyFor(call), headers: AUTH, generate: scripted("She's sent no reply yet. ", "Want me to nudge her?") });
  const r = await drain(out.stream);
  assert.match(r.said, /She's sent no reply yet\./);
});

test("the call prompt tells the model there is no NO_REPLY on a call, and the quiet-line nudge says skip_turn", () => {
  const sys = ownerContext({ call: ownerCall() }).system;
  assert.match(sys, /There is no NO_REPLY on a call/);
  assert.match(sys, /skip_turn/);
  assert.match(voice.LINE_IS_QUIET, /never write NO_REPLY/);
});

test("the filler is said when a tool call starts, not after the model has finished writing its input", async () => {
  // call 35: a message_send's text is the tool input, and the "one sec" waited for all of it — 8-11s.
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true });
  let release;
  const writing = new Promise(r => { release = r; });
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, fillerAfterMs: 0,
    generate: (() => {
      let round = 0;
      return async function* () {
        round++;
        if (round === 1) {
          yield { type: "tool_start", name: "memory_page" };
          await writing;
          yield { type: "tool_use", name: "memory_page", id: "tu_1", input: {} };
          return;
        }
        yield { type: "text", text: "Done." };
      };
    })(),
  });
  const it = out.stream[Symbol.asyncIterator]();
  let heard = "";
  while (!/One sec/.test(heard)) {
    const { value, done } = await it.next();
    assert.ok(!done, "the stream ended before the filler");
    heard += String(value);
  }
  release();
  while (!(await it.next()).done) { /* drain */ }
});

test("no filler in front of a tool that ends or hands over the turn", async () => {
  const call = ownerCall();
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: async function* () {
      yield { type: "text", text: "Talk soon." };
      yield { type: "tool_start", name: "end_call" };
      yield { type: "tool_use", name: "end_call", id: "tu_e", input: { reason: "done" } };
    },
  });
  const r = await drain(out.stream);
  assert.doesNotMatch(r.said, /One sec|\.\.\. $/);
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

// 2026-10-12, call 19: he asked for the notes to be texted, cleared the mid-call check, and then
// message_send answered "there is no texting channel running" on an install whose texting was
// live — the tool context built for a call carried no `channels`, unlike the one a text builds
// (Runtime spreads `turnExtras` into it). The notes were read out loud instead.
test("a tool run from a call gets the runtime's channels, the same as one run from a text", async () => {
  const call = ownerCall();
  const seen = [];
  voice.contextDeps.runTool = async (name, input, ctx) => { seen.push({ name, ctx }); return { ok: true, memories: [] }; };
  const channels = { name: "the texting router" };
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH,
    generate: scripted("One sec. ", { tool: "memory_page", input: {} }),
    extras: { channels, calls: { name: "the call provider" } },
  });
  await drain(out.stream);
  // `scripted` replays its events every round, so the tool runs once per round until the turn
  // runs out of rounds; every one of those runs has to carry the channels.
  assert.ok(seen.length >= 1);
  for (const { name, ctx } of seen) {
    assert.equal(name, "memory_page");
    assert.equal(ctx.channels, channels, "the texting router reaches the tool");
    assert.equal(ctx.calls?.name, "the call provider");
    assert.equal(ctx.conversationId, call.conversation_id, "the extras never override whose turn it is");
    assert.equal(ctx.onCall, call.id);
  }
});

// ---------- call 30, 2026-10-17: fifty seconds of silence, then "something broke" eight times ----------

// The platform asked for a turn with nothing new from him — the history it sent ended on Reason's own
// "One sec..." — and the call model refuses any request that ends on an assistant message (400, "does
// not support assistant message prefill"). Each refusal was spoken as "sorry, something broke on my end".
test("a history that ends on Reason's own words is handed to the model as its turn, never as a prefill", async () => {
  const call = ownerCall();
  const seen = [];
  const out = await llmRequest({
    rawBody: bodyFor(call, {
      messages: [{ role: "user", content: "do the page for me on a Ghana one" }, { role: "assistant", content: "One sec..." }],
    }),
    headers: AUTH,
    generate: async function* ({ messages }) { seen.push(messages); yield { type: "text", text: "Still here, on it." }; },
  });
  const r = await drain(out.stream);
  assert.equal(seen.length, 1);
  const sent = seen[0];
  assert.equal(sent.at(-1).role, "user", "the request ends on their side");
  assert.equal(sent.at(-1).content, LINE_IS_QUIET);
  assert.deepEqual(sent.at(-2), { role: "assistant", content: "One sec..." }, "what was already said stays in the history");
  assert.match(r.said, /Still here/);
  assert.ok(!/something broke/.test(r.said));
  // A history that already ends on them is left exactly as it was.
  assert.deepEqual(endOnTheirSide([{ role: "user", content: "hey" }]), [{ role: "user", content: "hey" }]);
  assert.deepEqual(endOnTheirSide([]), []);
});

// `research` ran on the line for the best part of a minute. The text path can wait on a tool because
// nobody is listening to it; a phone cannot.
test("a tool slower than a phone call can wait is handed off, not waited for", async () => {
  const call = ownerCall();
  let finished = false;
  voice.contextDeps.runTool = () => new Promise(resolve => setTimeout(() => { finished = true; resolve({ ok: true }); }, 200));
  const fed = [];
  const seen = [];
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l), toolBudgetMs: 20,
    generate: (() => {
      let round = 0;
      return async function* ({ messages }) {
        round++;
        if (round === 1) { yield { type: "tool_use", name: "research", id: "tu_r", input: { question: "a Ghana investing app" } }; return; }
        fed.push(JSON.parse(messages.at(-1).content[0].content));
        yield { type: "text", text: "This one takes a while, so I'll text you the page." };
      };
    })(),
  });
  const r = await drain(out.stream);
  assert.equal(finished, false, "the turn did not wait for it");
  assert.equal(fed.length, 1, "the model was told once, and answered");
  assert.equal(fed[0].ok, false);
  assert.equal(fed[0].slow, true);
  assert.match(fed[0].say, /research/);
  assert.match(fed[0].say, /task_start/);
  assert.match(fed[0].say, /text them/);
  assert.match(r.said, /text you the page/);
  assert.deepEqual(r.finish, ["stop"]);
  assert.ok(seen.some(l => l.call_tool_over_budget === "research" && l.budget_ms === 20));
  assert.ok(CALL_TOOL_BUDGET_MS <= 10_000, "a phone turn stops waiting on a tool inside ten seconds");
  // The abandoned tool finishing later is nobody's problem.
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(finished, true);
});

// Every "hello?" was a new turn, and the one before it kept running: five at once, each re-doing the
// same research, every later word three seconds late for it.
test("a new turn for the same call cancels the one still running, which then says nothing more", async () => {
  const call = ownerCall();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  voice.contextDeps.runTool = async () => { entered(); await gate; return { ok: true, found: "lots" }; };
  const seen = [];

  const first = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "do the page for me" }] }),
    headers: AUTH, log: (l) => seen.push(l),
    generate: (() => {
      let round = 0;
      return async function* () {
        round++;
        if (round === 1) { yield { type: "tool_use", name: "memory_page", id: "tu_1", input: {} }; return; }
        yield { type: "text", text: "Here is what I found." };
      };
    })(),
  });
  const firstDrain = drain(first.stream);
  await started;

  // The platform asks again for the same call while the first turn is still inside its tool.
  const second = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "hello?" }] }),
    headers: AUTH, log: (l) => seen.push(l),
    generate: scripted("Still here."),
  });
  const r2 = await drain(second.stream);
  release();
  const r1 = await firstDrain;
  // The cancelled turn's own last line is written once its tool comes back.
  for (let i = 0; i < 50 && !seen.some(l => l.voice_turn_superseded === call.id && l.at); i++) await new Promise(resolve => setTimeout(resolve, 10));

  assert.match(r2.said, /Still here/);
  assert.deepEqual(r2.finish, ["stop"]);
  assert.ok(seen.some(l => l.voice_turn_replaced === call.id));
  assert.ok(seen.some(l => l.voice_turn_superseded === call.id && l.reason === "new_from_their_side"));
  assert.ok(seen.some(l => l.voice_turn_superseded === call.id && l.at === "memory_page"));
  // And the cancelled stream still ended the way every stream ends.
  assert.deepEqual(r1.finish, ["stop"]);
  assert.equal(r1.raw.at(-1), SSE_DONE);
  assert.ok(!/Here is what I found/.test(r1.said), "the cancelled turn did not speak into a closed stream");
  assert.ok(!/something broke/.test(r1.said), "and being cancelled is not the model falling over");
  // The server gets a handle for the socket closing, which cancels the same way.
  assert.equal(typeof second.abort, "function");
  second.abort();
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

test("the call harm screen runs on the call's own backend and fast model, not the global one", async () => {
  // Before this, a CLI install screened a call with a cold `claude` start (~4.5s) in front of the
  // first spoken word — the caller hears dead air and hangs up. The screen must run on the call's
  // own backend (the API, fast) with the fast call-harm model, while text screening is unchanged.
  const call = ownerCall();
  let seen = null;
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "hey what's going on tonight" }] }),
    headers: AUTH,
    screen: async (args) => { seen = args; return { verdict: "clear" }; },
    generate: scripted("not much, quiet night"),
  });
  const r = await drain(out.stream);
  assert.match(r.said, /quiet night/);
  assert.equal(seen.backend, callBackendName(), "the screen is told to use the call's own backend");
  if (callBackendName() === "api") {
    assert.equal(seen.model, config.callHarmModel, "and the fast call-harm model, not the global one");
  }
});

test("the model request is in flight while the screen is read, not started after it", async () => {
  // The screen and the reply were meant to run in parallel, but an async generator does nothing
  // until it is first read — and it was first read after the screen had been awaited. So the two
  // were paid for one after the other: seconds of dead air before the first word (2026-10-12).
  const call = ownerCall();
  let generatorStarted = false;
  let startedBeforeScreenReturned = false;
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "hey what's going on" }] }),
    headers: AUTH,
    screen: async () => {
      await new Promise(r => setTimeout(r, 30));
      startedBeforeScreenReturned = generatorStarted;
      return { verdict: "clear" };
    },
    generate: async function* () { generatorStarted = true; yield { type: "text", text: "Not much. Quiet night." }; },
  });
  const r = await drain(out.stream);
  assert.match(r.said, /Quiet night/);
  assert.equal(startedBeforeScreenReturned, true, "the model had started before the screen came back");
  assert.deepEqual(r.finish, ["stop"]);
});

test("the cache warm-up sends the turn's exact prefix, one token out, and never throws", async () => {
  // A prompt-cache hit needs byte-identical bytes ahead of the cache mark: the same tools in the same
  // order and the same system text the real turn will send. One token of output, because the answer
  // is not wanted — only the prefix being read into the cache is.
  const call = ownerCall();
  const sent = [];
  const client = { messages: { create: async (body) => { sent.push(body); return { usage: { cache_creation_input_tokens: 1234, cache_read_input_tokens: 0 } }; } } };
  const out = await voice.warmCallCache({ call, client });
  assert.equal(out.warmed, true);
  assert.equal(out.cacheWrite, 1234);
  assert.equal(sent.length, 1);
  const body = sent[0];
  const ctx = contextFor({ call, kind: "owner", callMessages: [] });
  assert.equal(body.max_tokens, 1, "one token out");
  assert.equal(body.system[0].text, ctx.system, "the same system text the turn sends");
  assert.equal(body.system[0].cache_control.type, "ephemeral", "with the cache mark on it");
  assert.equal(body.tools.length, ctx.reasonTools.length + ctx.callTools.length + ctx.systemTools.length, "every tool the turn offers");
  assert.deepEqual(body.tools.map(t => t.name), [...ctx.reasonTools, ...ctx.callTools, ...ctx.systemTools].map(t => t.name), "in the same order");
  assert.equal(body.model, config.callModel || config.model);
  // No thinking pass before the first word: on call 38 it was ~3.5s of silence on every turn.
  assert.deepEqual(body.thinking, { type: "between_tools" });

  // A warm-up that fails is a call exactly as slow as before, and nothing else.
  const broken = { messages: { create: async () => { throw new Error("rate limited"); } } };
  const failed = await voice.warmCallCache({ call, client: broken });
  assert.equal(failed.warmed, false);
  assert.match(failed.why, /rate limited/);

  // No key and no client: nothing to warm with, said plainly rather than attempted.
  const was = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const none = await voice.warmCallCache({ call });
    assert.equal(none.warmed, false);
    assert.match(none.why, /ANTHROPIC_API_KEY/);
  } finally {
    if (was !== undefined) process.env.ANTHROPIC_API_KEY = was;
  }
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

// ---------- two things the 2026-10-07 rehearsal caught, both of them out loud ----------

test("it never says out loud that it is going to be quiet", async () => {
  // Four minutes into a hold, the whole of one spoken turn was: "The call is on hold, so I should
  // stay silent." Said to hold music, on a call he is paying for. The rule it was reciting is the one
  // thing reciting it breaks.
  assert.equal(voice.aNoteToItself("The call is on hold, so I should stay silent."), true);
  assert.equal(voice.aNoteToItself("I'll stay quiet now."), true);
  assert.equal(voice.aNoteToItself("I should call skip_turn here."), true, "and never a tool name");
  // Speech, kept: it is to the person, which is the whole difference.
  assert.equal(voice.aNoteToItself("Of course, I'll hold."), false);
  assert.equal(voice.aNoteToItself("Thanks, I'll wait while you check."), false);
  assert.equal(voice.aNoteToItself("Would you like me to stay quiet while you check?"), false);

  const call = thirdPartyCall({ externalId: "conv_selfnote" });
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "[hold music]" }] }), headers: AUTH,
    generate: scripted("The call is on hold, so I should stay silent.", { tool: "skip_turn", input: { reason: "hold music" } }),
  });
  const r = await drain(out.stream);
  assert.equal(r.said, "", "nothing reaches the line");
  assert.equal(r.toolCalls[0].function.name, "skip_turn", "and waiting still happens");
  assert.ok(r.text.endsWith(SSE_DONE));
});

test("a refusal that arrives after it has already spoken tells it to stop, not to ask again", async () => {
  // Every turn of the rehearsal asked the same question twice in one breath: the model asked about the
  // date, proposed the booking, was told it did not have one, and asked again — to somebody who had
  // not had a chance to answer the first time. The instruction was right; the timing was not.
  const call = thirdPartyCall({ externalId: "conv_twice" });
  const rounds = [];
  const generate = async function* ({ messages }) {
    rounds.push(messages);
    if (rounds.length === 1) {
      yield { type: "text", text: "What time would the team arrive?" };
      yield { type: "tool_use", name: "propose_commitment", id: "tu_p", input: { what: "the clean on Saturday" } };
      return;
    }
    yield { type: "text", text: "Thanks." };
  };

  const r = await drain((await llmRequest({ rawBody: bodyFor(call), headers: AUTH, generate })).stream);
  assert.equal(rounds.length, 2);

  const result = rounds[1].at(-1).content[0];
  assert.equal(result.type, "tool_result");
  const said = JSON.parse(result.content).say;
  assert.match(said, /You have ALREADY spoken this turn/);
  assert.match(said, /stop talking now and wait for their answer/);
  // The refusal itself is untouched: this call was only ever asking.
  assert.match(said, /you are asking/);
  assert.match(r.said, /What time would the team arrive\?/);
});

// ---------- latency measurement ----------

test("voice_turn log includes first_word_ms and turn_ms", async () => {
  const call = ownerCall();
  const logs = [];
  const generate = scripted("Sure, I can help with that.");

  const r = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, generate,
    log: (e) => logs.push(e),
  });
  await drain(r.stream);

  const turnLog = logs.find(e => e.voice_turn === call.id);
  assert.ok(turnLog, "voice_turn log emitted");
  assert.equal(typeof turnLog.first_word_ms, "number", "first_word_ms is a number");
  assert.ok(turnLog.first_word_ms >= 0, "first_word_ms is non-negative");
  assert.equal(typeof turnLog.turn_ms, "number", "turn_ms is a number");
  assert.ok(turnLog.turn_ms >= turnLog.first_word_ms, "turn_ms >= first_word_ms");
});

test("the owner's call does not switch language on one misheard line; a stranger's call still switches", () => {
  // Call 41 (2026-10-23): "How are you?" was transcribed "¿De dónde hablas?" and Reason answered in Spanish.
  const { ownerLanguageRule, LANGUAGE_RULE } = prompts;
  const owner = ownerContext({ call: ownerCall(), callMessages: [{ role: "user", content: "¿De dónde hablas?" }] });
  assert.ok(owner.system.includes(ownerLanguageRule("en")));
  assert.match(ownerLanguageRule("en"), /This call is in English\. Reply in English/);
  assert.match(ownerLanguageRule("es"), /This call is in Spanish/);
  assert.ok(!owner.system.includes(LANGUAGE_RULE), "the just-switch rule is for strangers");
  const stranger = thirdPartyContext({ call: thirdPartyCall(), callMessages: [{ role: "user", content: "¿Bueno?" }] });
  assert.ok(stranger.system.includes(LANGUAGE_RULE));
});

// ---------- nothing said is dead air, and dead air is a dropped call (call 13) ----------
// Call 13 (2026-10-12): ~24 s with no content from the custom LLM, then "custom_llm_error: LLM Cascade
// Error: TimeoutError" and the platform ended the call. Calls 13 and 22 also left no line in the journal.

/** A model that says nothing for `ms`, then `events`, round by round. */
const stalled = (ms, ...rounds) => {
  let round = 0;
  return async function* () {
    const events = rounds[round++] ?? ["Okay."];
    await new Promise(resolve => setTimeout(resolve, ms));
    for (const e of events) {
      if (typeof e === "string") yield { type: "text", text: e };
      else if (e.start) yield { type: "tool_start", name: e.start };
      else yield { type: "tool_use", name: e.tool, id: e.id ?? "tu_1", input: e.input ?? {} };
    }
  };
};

/** Every content delta, with how long after the start it went out. */
async function timed(stream) {
  const t0 = Date.now();
  const out = [];
  for await (const s of stream) {
    if (!s.startsWith("data: ") || s.includes("[DONE]")) continue;
    const c = JSON.parse(s.slice(6)).choices[0].delta.content;
    if (c) out.push({ content: c, ms: Date.now() - t0 });
  }
  return out;
}

test("a model that stalls past the deadline gets one holding line out first, logged, and never twice", async () => {
  const call = ownerCall();
  const seen = [];
  voice.contextDeps.runTool = async () => ({ ok: true, found: "a thing" });
  // Two rounds, each silent for well past the deadline: the line still goes out once for the turn.
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l), firstWordDeadlineMs: 100,
    screen: async () => ({ verdict: "safe" }),
    generate: stalled(1_500, [{ tool: "memory_search", input: { query: "x" } }], ["Here it is."]),
  });
  const said = await timed(out.stream);
  assert.ok(said.length >= 2, "the holding line and then the real reply");
  assert.ok(said[0].ms < 1_500, `content went out before the model's first word (${said[0].ms} ms)`);
  assert.equal(said[0].content, voice.HOLDING_LINE);
  const all = said.map(s => s.content).join("");
  assert.equal(all.split(voice.HOLDING_LINE).length - 1, 1, "exactly once in the turn");
  assert.match(all, /Here it is\.$/);
  assert.match(all, /moment\. /, "the reply follows it as its own sentence");
  const fired = seen.filter(l => l.voice_holding_line != null);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].voice_holding_line, call.id);
  assert.ok(voice.FIRST_WORD_DEADLINE_MS <= 6_000, "the platform hears something inside six seconds");
  assert.doesNotMatch(voice.HOLDING_LINE, /sorry|still there|\?/i, "an acknowledgement, not an apology or a check");
});

test("a turn that answers inside the deadline never hears the holding line", async () => {
  const call = ownerCall();
  const seen = [];
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l), firstWordDeadlineMs: 500,
    screen: async () => ({ verdict: "safe" }),
    generate: stalled(10, ["Sure."]),
  });
  const r = await drain(out.stream);
  assert.equal(r.said, "Sure.");
  assert.ok(!seen.some(l => l.voice_holding_line != null));
});

test("a stranger who has not heard who is calling gets no holding line before the disclosure", async () => {
  // A line that opened silent (`opening_waits`): nobody on it has heard who is calling yet.
  const row = thirdPartyCall({ state: "in_progress" });
  db.updateCall(C, row.id, { opening_waits: 1 });
  const call = db.getCall(C, row.id);
  const seen = [];
  const out = await llmRequest({
    rawBody: bodyFor(call, { messages: [{ role: "user", content: "Hello, Luigi's?" }] }),
    headers: AUTH, log: (l) => seen.push(l), firstWordDeadlineMs: 50,
    generate: stalled(300, ["Hi, I'd like a table for four."]),
  });
  const r = await drain(out.stream);
  assert.ok(r.said.startsWith(ANN.trim().slice(0, 20)), "the disclosure is the first thing said");
  assert.ok(!r.said.includes(voice.HOLDING_LINE));
  assert.ok(!seen.some(l => l.voice_holding_line != null));
});

test("every request is logged on arrival with its call id, and a body that will not parse is logged too", async () => {
  const call = ownerCall();
  const seen = [];
  const out = await llmRequest({ rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l), generate: scripted("Hi.") });
  await drain(out.stream);
  assert.ok(seen.some(l => l.voice_llm_request === call.id && l.kind === "owner"), "arrival is logged with the call id");

  const bad = [];
  const broken = `{"messages":[],"elevenlabs_extra_body":{"${EXTRA_BODY_KEYS.callId}":${call.id},`;
  const r = await llmRequest({ rawBody: broken, headers: AUTH, log: (l) => bad.push(l) });
  assert.equal(r.status, 400);
  assert.ok(bad.some(l => l.voice_llm_bad_json === call.id), "the 400 carries the call id it was for");
});

test("a reply the server ends without a stream still leaves a line", async () => {
  const { createServer } = await import("../src/http.js");
  const seen = [];
  const server = createServer({ router: null, runtime: null, log: (l) => seen.push(l) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${LLM_PATH}`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{",
    });
    assert.equal(res.status, 400);
    await res.text();
  } finally { server.close(); }
  assert.ok(seen.some(l => l.call_llm_not_streamed === 400), "the non-stream end is in the journal");
});

test("the holding line and then nothing from the model: the turn still closes with a sentence", async () => {
  // "One moment" left hanging, with only NO_REPLY behind it, is a promise nobody keeps.
  const call = ownerCall();
  const seen = [];
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l), firstWordDeadlineMs: 50,
    screen: async () => ({ verdict: "safe" }),
    generate: stalled(300, ["NO_REPLY"]),
  });
  const r = await drain(out.stream);
  assert.ok(r.said.startsWith(voice.HOLDING_LINE), r.said);
  assert.ok(r.said.length > voice.HOLDING_LINE.length, `more than the holding line was said: ${JSON.stringify(r.said)}`);
  assert.doesNotMatch(r.said, /no.?reply/i);
  assert.ok(seen.some(l => l.voice_turn_nothing_said === call.id));
  assert.deepEqual(r.finish, ["stop"]);
});

test("no thinking filler straight after the holding line when a tool starts", async () => {
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true, found: "a thing" });
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 50,
    screen: async () => ({ verdict: "safe" }),
    generate: stalled(300, [{ start: "memory_search" }, { tool: "memory_search", input: { query: "x" } }], ["Found it."]),
  });
  const r = await drain(out.stream);
  assert.equal(r.said, `${voice.HOLDING_LINE} Found it.`);
});

test("no holding line on hold, or with a mailbox on the line: only where a spoken reply is expected", async () => {
  // On hold: the model is meant to skip_turn, and a line into hold music is for nobody.
  const held = thirdPartyCall({ state: "in_progress" });
  db.updateCall(C, held.id, { hold_since: clock.now() - 30_000, hold_waits: 1 });
  // A mailbox already reached (a transfer that rang through to voicemail): anything said IS the message.
  const mailbox = thirdPartyCall({ state: "in_progress", externalId: "conv_out2" });
  db.updateCall(C, mailbox.id, { outcome_kind: "voicemail_no_message" });
  for (const row of [held, mailbox]) {
    const call = db.getCall(C, row.id);
    const seen = [];
    const out = await llmRequest({
      rawBody: bodyFor(call, { messages: [{ role: "user", content: "(music)" }] }),
      headers: AUTH, log: (l) => seen.push(l), firstWordDeadlineMs: 50,
      generate: stalled(300, [{ tool: "skip_turn", input: { reason: "hold" } }]),
    });
    const r = await drain(out.stream);
    assert.ok(!r.said.includes(voice.HOLDING_LINE), `call ${call.id}: ${r.said}`);
    assert.ok(!seen.some(l => l.voice_holding_line != null), `call ${call.id} logged a holding line`);
  }
});

// ---------- call filler baseline, 2026-10-30: 40 of 192 owner-call lines were filler ----------
//
// 25 of 26 "One sec..." were the code's, said on every tool start 4–15 s into the turn; the holding
// line at 4 s would have fired on 24% of turns; the prompt quoted an apology for the model to say
// back; and the quiet-line nudge invited "are you still there?".

/** A model that starts a tool at once, then answers once the tool has run. */
const toolThenWords = (...after) => (() => {
  let round = 0;
  return async function* () {
    round++;
    if (round === 1) {
      for (const e of after.length > 1 ? [after[0]] : []) yield { type: "text", text: e };
      yield { type: "tool_start", name: "memory_page" };
      yield { type: "tool_use", name: "memory_page", id: "tu_1", input: {} };
      return;
    }
    yield { type: "text", text: after.at(-1) };
  };
})();

test("filler: no \"One sec...\" on a tool that starts before the turn is ~2.5 s old", async () => {
  assert.equal(voice.FILLER_AFTER_MS, 2_500);
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true, memories: [] });
  const out = await llmRequest({ rawBody: bodyFor(call), headers: AUTH, generate: toolThenWords("Nothing on file.") });
  const r = await drain(out.stream);
  assert.equal(r.said, "Nothing on file.", "a fast tool start says nothing extra");
});

test("filler: nothing extra after words the turn has already said", async () => {
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true, memories: [] });
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, fillerAfterMs: 0,
    generate: toolThenWords("Let me look.", "Nothing on file."),
  });
  const r = await drain(out.stream);
  assert.equal(r.said, "Let me look. Nothing on file.");
  assert.doesNotMatch(r.said, /One sec|\.\.\./);
});

test("filler: \"One sec...\" at most once per call", async () => {
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true, memories: [] });
  const heard = [];
  for (let turn = 0; turn < 3; turn++) {
    const seen = [];
    const out = await llmRequest({
      rawBody: bodyFor(call), headers: AUTH, fillerAfterMs: 0, log: (l) => seen.push(l),
      generate: toolThenWords("Nothing on file."),
    });
    heard.push((await drain(out.stream)).said);
    if (turn === 0) assert.ok(seen.some(l => l.voice_tool_filler === call.id), "the one filler is logged");
  }
  assert.equal(heard[0], `${voice.ONE_SEC}Nothing on file.`);
  assert.equal(heard[1], "Nothing on file.");
  assert.equal(heard[2], "Nothing on file.");
  // Another call has its own one.
  const other = ownerCall();
  const out = await llmRequest({ rawBody: bodyFor(other), headers: AUTH, fillerAfterMs: 0, generate: toolThenWords("Done.") });
  assert.match((await drain(out.stream)).said, /^One sec/);
});

test("holding line: 6 s once per call, then the late line on every turn that reaches ~9.5 s silent", async () => {
  assert.equal(voice.FIRST_WORD_DEADLINE_MS, 6_000);
  assert.equal(voice.LATE_HOLDING_MS, 9_500);
  // The agent's cascade_timeout_seconds is 15 s from the request arriving; the late line has to be
  // out with room for TTS and the network before then.
  assert.ok(voice.LATE_HOLDING_MS <= 15_000 - 5_000, "the late line leaves ≥5 s before the 15 s cascade timeout");
  assert.notEqual(voice.LATE_LINE, voice.HOLDING_LINE, "not the holding line said again");
  assert.doesNotMatch(voice.LATE_LINE, /sorry|still there|hear me|\?/i, "no apology, no presence check");
  const call = ownerCall();
  const turn = async (stallMs) => {
    const seen = [];
    const out = await llmRequest({
      rawBody: bodyFor(call), headers: AUTH, log: (l) => seen.push(l),
      firstWordDeadlineMs: 50, lateHoldingMs: 600,
      screen: async () => ({ verdict: "safe" }),
      generate: stalled(stallMs, ["Here."]),
    });
    return { said: (await drain(out.stream)).said, seen };
  };
  const first = await turn(250);
  assert.equal(first.said, `${voice.HOLDING_LINE} Here.`, "the first slow turn on the call gets the holding line");
  const second = await turn(250);
  assert.equal(second.said, "Here.", "a second slow turn, short of the late deadline, gets nothing");
  assert.ok(!second.seen.some(l => l.voice_holding_line != null));
  const third = await turn(900);
  assert.equal(third.said, `${voice.LATE_LINE} Here.`, "a turn past the late deadline gets the late line");
  assert.equal(third.seen.find(l => l.voice_holding_line != null)?.deadline_ms, 600);
  const fourth = await turn(900);
  assert.equal(fourth.said, `${voice.LATE_LINE} Here.`, "and so does every one after it");
});

test("holding line: deadlines run from when the request arrived (t0), not from when the turn began", async () => {
  // The platform's 15 s starts at arrival; context building and the screen come out of it.
  const call = ownerCall();
  const context = contextFor({ call, kind: "owner", callMessages: [{ role: "user", content: "hey" }] });
  const t0 = Date.now() - 5_900; // 5.9 s already gone before this turn started
  const turn = voice.voiceTurn({
    context, call, t0, screen: async () => ({ verdict: "safe" }),
    generate: stalled(800, ["Here."]),
  });
  const said = await timed(turn);
  assert.equal(said[0].content, voice.HOLDING_LINE, "the 6 s deadline from t0 fell inside this turn");
  assert.ok(said[0].ms < 700, `said before the model's first word (${said[0].ms} ms)`);
});

test("holding line: a slow tool after a fast tool start is not silence (deadlines race the tool run)", async () => {
  // A tool started too early for "One sec..." runs for up to CALL_TOOL_BUDGET_MS, then round 2 starts:
  // unwatched, that was 12–16 s of nothing, past the platform's 15 s cascade timeout.
  const call = ownerCall();
  voice.contextDeps.runTool = async () => { await new Promise(r => setTimeout(r, 1_000)); return { ok: true, found: "a thing" }; };
  const run = async () => {
    const out = await llmRequest({
      rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 200, lateHoldingMs: 400,
      screen: async () => ({ verdict: "safe" }),
      generate: (() => {
        let round = 0;
        return async function* () {
          round++;
          if (round === 1) {
            yield { type: "tool_start", name: "memory_search" };
            yield { type: "tool_use", name: "memory_search", id: "tu_1", input: { query: "x" } };
            return;
          }
          await new Promise(r => setTimeout(r, 600));
          yield { type: "text", text: "Found it." };
        };
      })(),
    });
    return timed(out.stream);
  };
  const first = await run();
  assert.equal(first[0].content, voice.HOLDING_LINE);
  assert.ok(first[0].ms < 900, `spoken while the tool ran (${first[0].ms} ms), not after it`);
  assert.equal(first.map(c => c.content).join(""), `${voice.HOLDING_LINE} Found it.`, "one line, then the answer: never two fillers");
  const second = await run();
  assert.equal(second[0].content, voice.LATE_LINE, "a later tool turn gets the late line");
  assert.ok(second[0].ms < 900, `spoken while the tool ran (${second[0].ms} ms)`);
  assert.equal(second.map(c => c.content).join(""), `${voice.LATE_LINE} Found it.`);
});

test("once-per-call record: no call means a record for this request alone, never a shared one", () => {
  const a = voice.onceSaidFor(undefined);
  a.filler = true; a.holding = true;
  const b = voice.onceSaidFor(undefined);
  assert.deepEqual(b, { filler: false, holding: false });
  assert.deepEqual(voice.onceSaidFor({ conversation_id: "dm:x" }), { filler: false, holding: false });
});

test("holding line and filler share one turn: never both", async () => {
  const call = ownerCall();
  voice.contextDeps.runTool = async () => ({ ok: true, found: "a thing" });
  // The filler goes first (tool start into a silent, old-enough turn); the next round then stalls
  // well past the holding-line deadline, and nothing more is said before the answer.
  const out = await llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 50, fillerAfterMs: 0,
    screen: async () => ({ verdict: "safe" }),
    generate: (() => {
      let round = 0;
      return async function* () {
        round++;
        if (round === 1) {
          yield { type: "tool_start", name: "memory_search" };
          yield { type: "tool_use", name: "memory_search", id: "tu_1", input: { query: "x" } };
          return;
        }
        await new Promise(r => setTimeout(r, 300));
        yield { type: "text", text: "Found it." };
      };
    })(),
  });
  const r = await drain(out.stream);
  assert.equal(r.said, `${voice.ONE_SEC}Found it.`);
});

test("prompt: a mistake or a mishearing is owned plainly, with no apology and no words to say", () => {
  const rules = prompts.VOICE_RULES;
  const lang = prompts.ownerLanguageRule("en");
  for (const text of [rules, lang]) {
    assert.doesNotMatch(text, /sorry|had that wrong|didn't catch/i);
  }
  const mistake = rules.split("\n").find(l => /wrong/i.test(l));
  assert.ok(mistake, "the rule about getting something wrong is still there");
  assert.doesNotMatch(mistake, /["“”]/, "no quoted phrase to say back");
  assert.match(mistake, /correct/i);
  assert.match(mistake, /no apology/i);
  assert.match(lang, /repeat/i);
  assert.match(lang, /without apologi/i);
});

test("quiet line: stay quiet or carry on the task, never ask whether they are there", () => {
  assert.doesNotMatch(LINE_IS_QUIET, /check they are still there/i);
  assert.match(LINE_IS_QUIET, /never ask whether they are there/i);
  assert.match(LINE_IS_QUIET, /skip_turn/);
  assert.match(LINE_IS_QUIET, /never write NO_REPLY/);
});
