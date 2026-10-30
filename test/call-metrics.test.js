// The numbers a call audit needs (2026-10-30 call quality audit): caller-heard latency per turn, why
// each call ended, what the platform says it cost — and a read-only report over them.
//
// No call is placed and nothing leaves the machine: the custom-LLM endpoint runs on a scripted
// generator, the post-call webhook on a signed fixture payload, the sweep with no provider at all.
// Every assertion reads the database, because the database is what the next audit will read.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-callmetrics-"));
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
const { EXTRA_BODY_KEYS, ElevenLabsCallProvider } = await import("../src/calls/elevenlabs.js");
const { postCallRequest } = await import("../src/calls/postcall.js");
const { settleCall, settleLostCalls, callLostAfterMs } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const { announcementFor } = await import("../src/calls/provider.js");

const C = config.ownerConversation;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger;");
  try { db.db.exec("DELETE FROM call_turns"); } catch { /* the table is what is being tested */ }
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  await voice.prime();
});

const ownerCall = (over = {}) => db.createCall(C, {
  provider: "elevenlabs", toNumber: "+12025551234", isOwner: true,
  goal: "Omari called Reason", facts: [], direction: "in", externalId: over.externalId ?? "conv_in", state: "in_progress",
});

const bodyFor = (call, messages = [{ role: "user", content: "hey" }]) => JSON.stringify({
  model: "reason", stream: true,
  messages: [{ role: "system", content: "dashboard prompt" }, ...messages],
  elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: call.id, [EXTRA_BODY_KEYS.conversationId]: call.conversation_id },
});
const AUTH = { authorization: "Bearer llm-test-secret" };

/** A model that waits `ms`, then says `events` — strings are words, objects are tool uses. */
const after_ = (ms, ...events) => async function* ({ onUsage } = {}) {
  await new Promise(resolve => setTimeout(resolve, ms));
  for (const e of events) {
    if (typeof e === "string") yield { type: "text", text: e };
    else yield { type: "tool_use", name: e.tool, id: "tu_1", input: e.input ?? {} };
  }
  onUsage?.({ input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 });
};

async function drain(stream) { for await (const _ of stream) { /* read it all, as the platform would */ } }

const turnsOf = (callId) => db.db.prepare("SELECT * FROM call_turns WHERE call_id = ? ORDER BY turn_index").all(callId);

// ---------- what the caller waited through, per turn ----------

test("every turn on a call writes a row with its heard latencies, tool names and token use", async () => {
  const call = ownerCall();
  for (let i = 0; i < 2; i++) {
    // Two real turns: the second carries the first one's exchange, so it has more messages.
    const history = i === 0 ? undefined : [{ role: "user", content: "hey" }, { role: "assistant", content: "Sure." }, { role: "user", content: "and?" }];
    const out = await voice.llmRequest({
      rawBody: bodyFor(call, history), headers: AUTH, firstWordDeadlineMs: 5_000,
      screen: async () => ({ verdict: "safe" }),
      generate: after_(60, "Sure, it's done.", { tool: "end_call", input: { reason: "done" } }),
    });
    await drain(out.stream);
  }
  const rows = turnsOf(call.id);
  assert.equal(rows.length, 2, "one row per turn");
  assert.deepEqual(rows.map(r => r.turn_index), [1, 2]);
  const r = rows[0];
  assert.equal(r.conversation_id, C);
  assert.ok(r.first_content_ms >= 50, `first content is measured from the request (${r.first_content_ms} ms)`);
  assert.equal(r.first_content_kind, "real");
  assert.equal(r.first_real_ms, r.first_content_ms, "the first thing said was the model's own words");
  assert.ok(r.total_ms >= r.first_content_ms);
  assert.equal(r.holding_line, 0);
  assert.equal(r.closed_early, 0);
  assert.ok(JSON.parse(r.tools).includes("end_call"), "tool names are kept");
  assert.equal(r.input_tokens, 1200);
  assert.equal(r.output_tokens, 30);
  assert.ok(!JSON.stringify(rows).includes("it's done"), "no words are stored");
});

test("a turn that needed the holding line is marked, with real words timed separately", async () => {
  const call = ownerCall();
  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 80,
    screen: async () => ({ verdict: "safe" }),
    generate: after_(600, "Here it is."),
  });
  await drain(out.stream);
  const [r] = turnsOf(call.id);
  assert.equal(r.holding_line, 1);
  assert.equal(r.first_content_kind, "holding_line");
  assert.ok(r.first_content_ms < 600, `the holding line went first (${r.first_content_ms} ms)`);
  assert.ok(r.first_real_ms >= 550, `real words came after the model (${r.first_real_ms} ms)`);
  assert.ok(r.first_real_ms > r.first_content_ms);
});

test("a turn the platform stops reading is marked closed early", async () => {
  const call = ownerCall();
  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 5_000,
    screen: async () => ({ verdict: "safe" }),
    generate: after_(20, "One. ", "Two. ", "Three."),
  });
  // What http.js does when the socket goes: stop reading and close the turn.
  const it = out.stream[Symbol.asyncIterator]();
  await it.next();
  out.abort();
  await it.return();
  const [r] = turnsOf(call.id);
  assert.equal(r.closed_early, 1);
  assert.ok(Number.isFinite(r.total_ms));
});

// ---------- why each call ended, and what it cost ----------

const provider = () => new ElevenLabsCallProvider();
const sign = (raw, t = Math.floor(clock.now() / 1000)) =>
  `t=${t},v0=${createHmac("sha256", "hook-test-secret").update(`${t}.${raw}`).digest("hex")}`;
const deliver = async (data) => {
  const raw = JSON.stringify({ type: "post_call_transcription", data });
  return await postCallRequest({
    rawBody: raw, headers: { "ElevenLabs-Signature": sign(raw) }, provider: provider(), settle: settleCall,
    runtime: { mayInterrupt: () => false, event: async () => "" },
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}) }),
  });
};
// The shape of a real ElevenLabs conversation (read-only GETs on calls 13, 20, 22, 32 and 35,
// 2026-10-30): numbers and field names only, no transcript. cost_fiat is call 32's real 1.193; the
// usage numbers inside `charging` are illustrative.
const charging = (fiat, credits) => ({
  tier: "creator", call_charge: credits, platform_price: fiat, llm_price: 0,
  tts_usage: { total_audio_output_seconds: 312.4, total_characters: 4810 },
  asr_usage: { total_audio_input_seconds: 540.2 },
});
const conversation = (over = {}) => ({
  conversation_id: "conv_in", status: "done", transcript: [],
  ...over,
  metadata: { call_duration_secs: 9, termination_reason: "end_call tool was called.", error: null, ...(over.metadata ?? {}) },
});

test("the post-call termination reason becomes a normalised end_reason, raw words kept beside it", async () => {
  const call = ownerCall();
  await deliver(conversation({ metadata: { termination_reason: "end_call tool was called." } }));
  const row = db.getCall(C, call.id);
  assert.equal(row.end_reason, "end_call");
  assert.equal(row.end_detail, "end_call tool was called.");

  // Calls 20 and 32: the platform does not say which side hung up, so neither does the row — an
  // inbound call is not turned into "the caller hung up".
  const hungUp = ownerCall({ externalId: "conv_in2" });
  await deliver(conversation({ conversation_id: "conv_in2", metadata: { termination_reason: "Call ended by remote party" } }));
  assert.equal(db.getCall(C, hungUp.id).end_reason, "remote_hung_up");
});

test("a 1002 custom_llm_error ending (calls 13, 22) is a platform error with its code and reason", async () => {
  const call = ownerCall();
  await deliver(conversation({
    status: "failed",
    metadata: {
      termination_reason: "custom_llm generation failed",
      error: { code: 1002, error_type: "llm_error", reason: "custom_llm_error: LLM Cascade Error: TimeoutError" },
      cost: 15, cost_fiat: 0.0150, charging: charging(0.0150, 15),
    },
  }));
  const row = db.getCall(C, call.id);
  assert.equal(row.state, "failed");
  assert.equal(row.end_reason, "platform_error");
  assert.match(row.end_detail, /custom_llm generation failed/);
  assert.match(row.end_detail, /error 1002 llm_error: custom_llm_error: LLM Cascade Error/);
});

test("the platform's cost is stored from the real payload shape: cents from cost_fiat, credits, minimal raw", async () => {
  const call = ownerCall();
  await deliver(conversation({
    metadata: { call_duration_secs: 902, termination_reason: "Call ended by remote party", cost: 5964, cost_fiat: 1.193, charging: charging(1.193, 5964) },
  }));
  const row = db.getCall(C, call.id);
  assert.equal(row.cost_cents, 119, "$1.193 is 119 cents");
  assert.equal(row.cost_credits, 5964);
  assert.deepEqual(JSON.parse(row.cost_raw), {
    cost: 5964, cost_fiat: 1.193, tier: "creator",
    tts_audio_output_seconds: 312.4, tts_characters: 4810, asr_audio_input_seconds: 540.2,
  });

  // Call 35's figure, and call 13's tiny one: rounded on the decimal, never to nothing.
  const b = ownerCall({ externalId: "conv_b" });
  await deliver(conversation({ conversation_id: "conv_b", metadata: { cost: 4500, cost_fiat: 0.901, charging: charging(0.901, 4500) } }));
  assert.equal(db.getCall(C, b.id).cost_cents, 90);
  const c = ownerCall({ externalId: "conv_c" });
  await deliver(conversation({ conversation_id: "conv_c", status: "failed", metadata: { cost: 15, cost_fiat: 0.0150, charging: charging(0.0150, 15) } }));
  assert.equal(db.getCall(C, c.id).cost_cents, 2);
});

test("a call the sweep closes, nobody having said how it ended, is lost", async () => {
  const call = ownerCall();
  clock.skip(callLostAfterMs("in_progress") + 60_000);
  const out = await settleLostCalls({ calls: null });
  assert.equal(out.unknown, 1);
  const row = db.getCall(C, call.id);
  assert.equal(row.end_reason, "lost");
  assert.match(row.end_detail, /nothing ever reported/);
});

// ---------- the report ----------

test("the report prints per-call and total numbers from the database, and no words", async () => {
  const { buildCallReport, formatCallReport } = await import("../src/calls/report.js");
  const call = ownerCall();
  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 80,
    screen: async () => ({ verdict: "safe" }),
    generate: after_(300, "Here it is."),
  });
  await drain(out.stream);
  await deliver(conversation({ metadata: { termination_reason: "end_call tool was called.", cost: 600, cost_fiat: 0.12, charging: charging(0.12, 600) } }));

  const report = buildCallReport(db.db);
  const r = report.calls.find(c => c.id === call.id);
  assert.equal(r.duration_s, 9);
  assert.equal(r.end_reason, "end_call");
  assert.equal(r.cost_credits, 600);
  assert.equal(r.cost_cents, 12);
  assert.equal(r.holding_lines, 1);
  assert.ok(Number.isFinite(r.heard_p50_ms) && Number.isFinite(r.heard_p95_ms));
  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.holding_lines, 1);
  assert.equal(report.totals.end_reasons.end_call, 1);
  const text = formatCallReport(report);
  assert.match(text, /end_call/);
  assert.doesNotMatch(text, /Here it is|Omari called Reason/, "no message content");
});

// ---------- review fixes ----------

test("a retried turn (same call, same messages) replaces its row instead of adding one", async () => {
  const call = ownerCall();
  const first = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 5_000,
    screen: async () => ({ verdict: "safe" }),
    generate: after_(400, "Too late."),
  });
  const it = first.stream[Symbol.asyncIterator]();
  const reading = (async () => { for (let s = await it.next(); !s.done; s = await it.next()) { /* until it is replaced */ } })();
  await new Promise(resolve => setTimeout(resolve, 20));
  // The platform gave up on it and asks the same turn again: the earlier one is aborted.
  const retry = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 5_000,
    screen: async () => ({ verdict: "safe" }),
    generate: after_(30, "Here."),
  });
  await drain(retry.stream);
  await reading;
  const rows = turnsOf(call.id);
  assert.equal(rows.length, 1, "one turn, not two");
  assert.equal(rows[0].attempts, 2);
  assert.equal(rows[0].closed_early, 0, "the retry's numbers, which finished");
  assert.equal(rows[0].first_content_kind, "real");
});

test("nothing is written to the database before the first byte of a turn", async () => {
  const call = ownerCall();
  const out = await voice.llmRequest({
    rawBody: bodyFor(call), headers: AUTH, firstWordDeadlineMs: 5_000,
    screen: async () => ({ verdict: "safe" }),
    generate: after_(10, "Hi."),
  });
  assert.equal(turnsOf(call.id).length, 0, "no row until the stream has ended");
  await drain(out.stream);
  assert.equal(turnsOf(call.id).length, 1);
});

test("the disclosure on a third-party call is not counted as real content", async () => {
  const ANN = announcementFor({ ownerName: "Omari" });
  const row = db.createCall(C, {
    provider: "elevenlabs", toNumber: "+12125559999", isOwner: false,
    goal: "ask for a table for four at eight on Saturday", facts: ["the name is Omari"],
    announcement: ANN, externalId: "conv_out", state: "in_progress",
  });
  db.updateCall(C, row.id, { opening_waits: 1 });
  const call = db.getCall(C, row.id);
  const out = await voice.llmRequest({
    rawBody: bodyFor(call, [{ role: "user", content: "Hello, Luigi's?" }]), headers: AUTH, firstWordDeadlineMs: 5_000,
    generate: after_(30, "Hi, I'd like a table for four."),
  });
  await drain(out.stream);
  const [r] = turnsOf(call.id);
  assert.equal(r.first_content_kind, "opening");
  assert.ok(Number.isFinite(r.first_real_ms), "the model's words after it are the real content");
});

test("a model piece of just '...' is not the code's filler", async () => {
  const { contentKind } = await import("../src/calls/metrics.js");
  assert.equal(contentKind("...", voice.METER_KINDS), "dots");
  assert.equal(contentKind(" ...", voice.METER_KINDS), "dots");
  assert.equal(contentKind("... ", voice.METER_KINDS), "filler", "the code's own filler, trailing space and all");
  assert.equal(contentKind("One sec... ", voice.METER_KINDS), "filler");
});

test("a late post-call delivery replaces the sweep's 'lost' with the real reason", async () => {
  const call = ownerCall();
  clock.skip(callLostAfterMs("in_progress") + 60_000);
  await settleLostCalls({ calls: null });
  assert.equal(db.getCall(C, call.id).end_reason, "lost");
  await deliver(conversation({ metadata: { termination_reason: "Call ended by remote party", cost: 5964, cost_fiat: 1.193, charging: charging(1.193, 5964) } }));
  const row = db.getCall(C, call.id);
  assert.equal(row.end_reason, "remote_hung_up");
  assert.equal(row.cost_cents, 119);
  assert.equal(row.state, "failed", "nothing else is settled twice");
});

test("timeouts, no answer and busy are their own endings, not platform errors", async () => {
  const cases = [
    [{ termination_reason: "Conversation ended due to inactivity timeout" }, "done", "inactivity"],
    [{ termination_reason: "no_answer" }, "done", "no_answer"],
    [{ termination_reason: "busy" }, "done", "no_answer"],
  ];
  let n = 0;
  for (const [metadata, status, want] of cases) {
    const id = `conv_t${n++}`;
    const call = ownerCall({ externalId: id });
    await deliver(conversation({ conversation_id: id, status, metadata }));
    assert.equal(db.getCall(C, call.id).end_reason, want, metadata.termination_reason);
  }
});
