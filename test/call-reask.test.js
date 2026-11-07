// The platform asking again for a turn that is already running (2026-10-30 call audit: 407 re-asks
// against 267 turns over ten calls, in bursts of four to six a second or so apart, each one 1.6–6.7 s
// of silence). A re-ask with nothing new from their side joins the running turn; one with new words
// cancels it. Either way every stream ends with a stop and `[DONE]`.
//
// No call is placed and no model runs: the custom-LLM endpoint is driven with scripted generators,
// and Reason's tools are a counting stub.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-reask-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
process.env.REASON_UNDO_SECONDS = "0";

const voice = await import("../src/calls/voice.js");
const { llmRequest, SSE_DONE, HOLDING_LINE, LATE_LINES } = voice;
const { EXTRA_BODY_KEYS } = await import("../src/calls/voice.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const hold = await import("../src/calls/hold.js");
const { announcementFor } = await import("../src/calls/provider.js");

const C = config.ownerConversation;
const realRunTool = voice.contextDeps.runTool;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  voice.contextDeps.runTool = realRunTool;
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger;");
  try { db.db.exec("DELETE FROM call_turns"); } catch { /* older schema */ }
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  await voice.prime();
});

// Each test its own external id, so no call row (and no turn in flight) is shared between tests.
let n = 0;
const ownerCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true,
  goal: "Omari called Reason", facts: [], direction: "in", externalId: `conv_reask_${++n}`, state: "in_progress",
});

const bodyFor = (call, messages = [{ role: "user", content: "what's on tomorrow?" }]) => JSON.stringify({
  model: "reason", stream: true,
  messages: [{ role: "system", content: "dashboard prompt" }, ...messages],
  extra_body: { [EXTRA_BODY_KEYS.callId]: call.id, [EXTRA_BODY_KEYS.conversationId]: call.conversation_id },
});
const AUTH = {};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const safe = async () => ({ verdict: "safe" });
const base = { headers: AUTH, screen: safe, firstWordDeadlineMs: 5_000, lateHoldingMs: 5_000, fillerAfterMs: 60_000 };

/** Everything a stream yielded, plus what was said and how it finished. */
async function drain(stream) {
  const raw = [];
  for await (const s of stream) raw.push(s);
  const chunks = raw.filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6)));
  return {
    raw,
    said: chunks.map(c => c.choices[0].delta.content ?? "").join(""),
    toolCalls: chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []),
    finish: chunks.map(c => c.choices[0].finish_reason).filter(Boolean),
  };
}

/** A model that counts its runs, waits `ms`, then says `text`. */
function counted(ms, text) {
  const runs = { n: 0 };
  const generate = async function* () {
    runs.n++;
    await sleep(ms);
    yield { type: "text", text };
  };
  return { runs, generate };
}

const turnsOf = (callId) => {
  try { return db.db.prepare("SELECT * FROM call_turns WHERE call_id = ?").all(callId); } catch { return []; }
};

test("the same history asked again joins the running turn: one model run, both streams the same words, both end with [DONE]", async () => {
  const call = ownerCall();
  const seen = [];
  const log = (l) => seen.push(l);
  const first = counted(150, "Tomorrow you have the dentist at ten.");
  const second = counted(10, "SECOND RUN");
  const a = await llmRequest({ ...base, rawBody: bodyFor(call), log, generate: first.generate });
  const ra = drain(a.stream);
  await sleep(40);
  // The platform's re-ask: byte-for-byte the same request.
  const b = await llmRequest({ ...base, rawBody: bodyFor(call), log, generate: second.generate });
  const [r1, r2] = await Promise.all([ra, drain(b.stream)]);

  assert.equal(first.runs.n + second.runs.n, 1, "one model run for the turn");
  assert.equal(r1.said, "Tomorrow you have the dentist at ten.");
  assert.equal(r2.said, r1.said, "the joining stream hears the same words");
  for (const r of [r1, r2]) {
    assert.deepEqual(r.finish, ["stop"]);
    assert.equal(r.raw.at(-1), SSE_DONE);
  }
  assert.ok(seen.some(l => l.voice_turn_attached === call.id), "logged as attached");
  // One turn, one row: the joining request writes nothing of its own.
  const rows = turnsOf(call.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 1);
});

test("new words from their side cancel the running turn, whose stream still ends with a stop and [DONE]", async () => {
  const call = ownerCall();
  const seen = [];
  const log = (l) => seen.push(l);
  const first = counted(400, "OLD ANSWER");
  const second = counted(10, "Sure, Thursday then.");
  const a = await llmRequest({ ...base, rawBody: bodyFor(call), log, generate: first.generate });
  const ra = drain(a.stream);
  await sleep(40);
  const b = await llmRequest({
    ...base, log, generate: second.generate,
    rawBody: bodyFor(call, [{ role: "user", content: "what's on tomorrow?" }, { role: "user", content: "actually, Thursday" }]),
  });
  const r2 = await drain(b.stream);
  const r1 = await ra;

  assert.equal(second.runs.n, 1, "the new turn runs");
  assert.equal(r2.said, "Sure, Thursday then.");
  assert.ok(!r1.said.includes("OLD ANSWER"), "the cancelled turn says nothing more");
  assert.deepEqual(r1.finish, ["stop"], "cancelled, but closed with a stop");
  assert.equal(r1.raw.at(-1), SSE_DONE, "and [DONE]");
  assert.ok(seen.some(l => l.voice_turn_superseded === call.id && l.reason === "new_from_their_side"));
});

test("a re-ask after the first socket closed still joins the turn rather than starting it again", async () => {
  const call = ownerCall();
  const seen = [];
  const log = (l) => seen.push(l);
  const first = counted(200, "You're free all afternoon.");
  const second = counted(10, "SECOND RUN");
  const a = await llmRequest({ ...base, rawBody: bodyFor(call), log, generate: first.generate });
  // What http.js does when the platform closes the socket: stop reading and let go.
  const it = a.stream[Symbol.asyncIterator]();
  await it.next();
  a.abort();
  await it.return();
  await sleep(60);
  const b = await llmRequest({ ...base, rawBody: bodyFor(call), log, generate: second.generate });
  const r2 = await drain(b.stream);

  assert.equal(first.runs.n + second.runs.n, 1, "one model run");
  assert.equal(r2.said, "You're free all afternoon.");
  assert.deepEqual(r2.finish, ["stop"]);
  assert.equal(r2.raw.at(-1), SSE_DONE);
  assert.ok(seen.some(l => l.voice_turn_attached === call.id && l.readers === 1));
});

test("a tool running when the re-ask arrives runs once, and both streams hear its answer", async () => {
  const call = ownerCall();
  let ran = 0;
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  voice.contextDeps.runTool = async () => { ran++; entered(); await gate; return { ok: true, memories: ["dentist Thursday 10am"] }; };
  let modelRuns = 0;
  const generate = async function* ({ messages }) {
    modelRuns++;
    const last = messages.at(-1);
    if (Array.isArray(last?.content) && last.content[0]?.type === "tool_result") { yield { type: "text", text: "Found it: the dentist on Thursday at ten." }; return; }
    yield { type: "tool_use", name: "memory_page", id: "tu_m", input: {} };
  };
  const a = await llmRequest({ ...base, rawBody: bodyFor(call), generate });
  const ra = drain(a.stream);
  await started;
  const b = await llmRequest({ ...base, rawBody: bodyFor(call), generate });
  const rb = drain(b.stream);
  await sleep(20);
  release();
  const [r1, r2] = await Promise.all([ra, rb]);

  assert.equal(ran, 1, "the tool ran once");
  assert.equal(modelRuns, 2, "two rounds of one turn, not a second turn");
  assert.match(r1.said, /dentist on Thursday/);
  assert.match(r2.said, /dentist on Thursday/);
  assert.equal(r1.raw.at(-1), SSE_DONE);
  assert.equal(r2.raw.at(-1), SSE_DONE);
});

test("the holding line is said once across a re-ask, and its deadline runs from the first request", async () => {
  const call = ownerCall();
  const first = counted(300, "Here it is.");
  const second = counted(300, "SECOND RUN");
  const timing = { ...base, firstWordDeadlineMs: 60, lateHoldingMs: 120 };
  const t0 = Date.now();
  const a = await llmRequest({ ...timing, rawBody: bodyFor(call), generate: first.generate });
  const ra = drain(a.stream);
  await sleep(130);
  // The platform re-asks with the holding line it already heard as Reason's own words.
  const b = await llmRequest({
    ...timing, generate: second.generate,
    rawBody: bodyFor(call, [{ role: "user", content: "what's on tomorrow?" }, { role: "assistant", content: HOLDING_LINE }]),
  });
  const [r1, r2] = await Promise.all([ra, drain(b.stream)]);
  const holds = (s) => [HOLDING_LINE, ...LATE_LINES].reduce((k, h) => k + s.split(h).length - 1, 0);

  assert.equal(first.runs.n + second.runs.n, 1, "one model run");
  assert.equal(holds(r1.said), 1, "the first stream had the holding line");
  assert.equal(holds(r2.said), 0, "the joining stream does not say it again, nor the late line");
  assert.match(r2.said, /Here it is\./);
  assert.ok(Date.now() - t0 < 600);
  assert.equal(r2.raw.at(-1), SSE_DONE);
});

test("a holding line written while nobody was reading is still said to the request that joins", async () => {
  const call = ownerCall();
  const first = counted(250, "Here it is.");
  const timing = { ...base, firstWordDeadlineMs: 60, lateHoldingMs: 5_000 };
  const a = await llmRequest({ ...timing, rawBody: bodyFor(call), generate: first.generate });
  const it = a.stream[Symbol.asyncIterator]();
  await it.next();
  // The server is waiting on the next chunk when the platform closes the socket.
  const pending = it.next();
  a.abort();
  await sleep(120);
  const b = await llmRequest({ ...timing, rawBody: bodyFor(call), generate: counted(10, "SECOND RUN").generate });
  const r2 = await drain(b.stream);
  const left = await pending;

  assert.equal(first.runs.n, 1);
  assert.equal(left.done, true, "the closed stream is handed nothing more");
  assert.equal(r2.said.split(HOLDING_LINE).length - 1, 1, "the joining stream hears the holding line once");
  assert.match(r2.said, /Here it is\./);
});

test("a round that ends while nobody reads it writes nothing down: the disclosure is still owed after a barge-in", async () => {
  const row = db.createCall(C, {
    provider: "gptlive", toNumber: "+12125559999", isOwner: false,
    goal: "ask for a table for four at eight on Saturday", facts: ["the name is Omari"],
    announcement: announcementFor({ ownerName: "Omari" }), externalId: `conv_reask_${++n}`, state: "in_progress",
  });
  db.updateCall(C, row.id, { opening_waits: 1 });
  assert.equal(hold.openingOwed(db.getCall(C, row.id)), true, "set up: nobody has heard who is calling");
  // The words are held back until the round ends (the disclosure goes first), so nothing is yielded
  // while the model writes.
  const generate = async function* () { yield { type: "text", text: "Hi there, " }; await sleep(80); yield { type: "text", text: "a table for four?" }; };
  const a = await llmRequest({ ...base, rawBody: bodyFor(row, [{ role: "user", content: "Hello, Carbone." }]), generate });
  const it = a.stream[Symbol.asyncIterator]();
  await it.next();
  const pending = it.next();
  a.abort();
  await sleep(200);
  // They spoke over it: new words, so the unread turn is cancelled.
  const b = await llmRequest({
    ...base, generate: async function* () { yield { type: "text", text: "Sorry, go ahead." }; },
    rawBody: bodyFor(row, [{ role: "user", content: "Hello, Carbone." }, { role: "user", content: "Hello? Anyone there?" }]),
  });
  const r2 = await drain(b.stream);
  await pending;

  assert.ok(r2.said.startsWith("Hey, hi — this is an AI assistant calling for Omari."), `the new turn still says who is calling first: ${r2.said}`);
  assert.equal(hold.openingOwed(db.getCall(C, row.id)), false, "and only now is it marked said");
  assert.match(r2.said, /go ahead/);
});

test("an empty turn while the call is on hold waits with skip_turn rather than ending empty", async () => {
  const call = ownerCall();
  db.updateCall(C, call.id, { hold_since: clock.now(), hold_waits: 1 });
  const a = await llmRequest({ ...base, rawBody: bodyFor(call), generate: async function* () { yield { type: "text", text: "NO_REPLY" }; } });
  const r = await drain(a.stream);

  assert.equal(r.said, "");
  assert.equal(r.toolCalls[0]?.function?.name, "skip_turn");
  assert.deepEqual(r.finish, ["tool_calls"]);
  assert.equal(r.raw.at(-1), SSE_DONE);
  assert.ok(Number(db.getCall(C, call.id).hold_since) > 0, "still on hold");
});
