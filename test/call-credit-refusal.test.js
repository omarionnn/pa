// The call model's API refuses mid-call (11-11 00:22–00:24: "Your credit balance is too low to access the
// Anthropic API"). Calls stay on the API on purpose; this is the safety net. The caller hears one short
// line that Reason will text instead, the call ends, and a follow-up text is queued so the conversation
// carries on by text. Never "Something broke on my end", never silence.
// No network: the generator is a stand-in and the text only lands in the outbox (nothing sends it here).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-credit-refusal-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_CALL_PASSPHRASE = "";

const voice = await import("../src/calls/voice.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM outbox;");
  db.saveConversation(C, [{ role: "user", content: "hi" }, { role: "assistant", content: "Hey." }]);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  Object.assign(config, { callIdentity: false, callVoice: "gptlive", callCacheWarm: false, callPassphrase: "", openaiKey: "sk-test" });
  await voice.prime();
});

const CREDIT = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

const ownCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, direction: "in", goal: "They rang Reason", facts: [],
  announcement: "Hey Omari, what's up?", state: "in_progress",
});
const bodyFor = (call, messages) => JSON.stringify({
  model: "reason", messages,
  extra_body: { reason_call_id: call.id, reason_conversation_id: call.conversation_id },
});
async function read(stream) {
  let said = "";
  const tools = [];
  let finish = null;
  for await (const s of stream) {
    if (!s.startsWith("data: ") || s.includes("[DONE]")) continue;
    const c = JSON.parse(s.slice(6)).choices[0];
    said += c.delta.content ?? "";
    for (const t of c.delta.tool_calls ?? []) tools.push(t.function?.name);
    if (c.finish_reason) finish = c.finish_reason;
  }
  return { said, tools, finish };
}

// Turn 1 answers; turn 2 is refused by the API the way the real SDK throws it.
let turnNo = 0;
async function* stubGenerator() {
  turnNo += 1;
  if (turnNo === 2) throw new Error(CREDIT);
  yield { type: "text", text: "Sure, what do you need?" };
}

test("API refuses mid-call (credit too low): graceful line, call ends, follow-up text queued", async () => {
  turnNo = 0;
  const call = ownCall();
  const logs = [];
  const log = (o) => logs.push(o);
  const turn = (messages) => voice.llmRequest({ rawBody: bodyFor(call, messages), screen: async () => ({ verdict: "clear" }), generate: stubGenerator, recallWaitMs: 0, log });

  const first = await read((await turn([{ role: "user", content: "hey" }])).stream);
  assert.match(first.said, /what do you need/);

  const second = await read((await turn([
    { role: "user", content: "hey" }, { role: "assistant", content: first.said },
    { role: "user", content: "can you check my emails?" },
  ])).stream);

  // The graceful line plays: Reason will text instead. No "something broke", no silence.
  assert.doesNotMatch(second.said, /something broke/i, second.said);
  assert.match(second.said, /\btext\b/i, `the caller hears that Reason will text: ${JSON.stringify(second.said)}`);
  // The call ends cleanly.
  assert.ok(second.tools.includes("end_call"), `end_call expected, got ${JSON.stringify(second.tools)}`);
  assert.equal(second.finish, "tool_calls");
  // A follow-up text is queued to the person (outbox only; nothing is sent from a test).
  const queued = logs.find(l => l.call_midcall_text === call.id);
  assert.ok(queued, `a follow-up text is queued: ${JSON.stringify(logs.map(l => Object.keys(l)[0]))}`);
  const row = db.getOutbound(queued.outbox);
  assert.equal(row.address, "+12025551234");
  assert.match(row.body, /text/i);
  assert.match(row.body, /check my emails/i, "the text picks up where the call left off");
});

test("an ordinary model error still says the usual line (the safety net is only for refusals)", async () => {
  const call = ownCall();
  const boom = async function* () { throw new Error("socket hang up"); };
  const out = await voice.llmRequest({ rawBody: bodyFor(call, [{ role: "user", content: "hey" }]), screen: async () => ({ verdict: "clear" }), generate: boom, recallWaitMs: 0 });
  const r = await read(out.stream);
  assert.match(r.said, /something broke/i);
  assert.ok(!r.tools.includes("end_call"));
});
