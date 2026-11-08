// An inbound call on caller ID only (drive 11-08 on OVH, Omari's decision): where they are, their places,
// memories and chats are as open as on any own call; spending, booking, texting other people and changing
// settings still wait for the check. When one of those is asked for, the caller always HEARS that Reason
// will text them to confirm it, never silence or a filler, and the code queues it for after the call.
// No network: the model and the tools are stand-ins.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-refusal-spoken-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_CALL_PASSPHRASE = "";

const gl = await import("../src/calls/gptlive.js");
const voice = await import("../src/calls/voice.js");
const verify = await import("../src/calls/verify.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const PROFILE = "**Omari**\n- Lives in Chelsea, Manhattan";

after(() => rmSync(dir, { recursive: true, force: true }));
let realRunTool;
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages;");
  db.saveConversation(C, [{ role: "user", content: "I'm at work on 17th in Chelsea" }, { role: "assistant", content: "Noted." }]);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.saveProfile(C, PROFILE, []);
  Object.assign(config, { callIdentity: false, callVoice: "gptlive", callCacheWarm: false, callPassphrase: "", openaiKey: "sk-test" });
  await voice.prime();
  realRunTool ??= voice.contextDeps.runTool;
  voice.contextDeps.runTool = realRunTool;
});

const inboundCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, direction: "in", goal: "They rang Reason", facts: [],
  announcement: "Hey Omari, what's up?", state: "in_progress",
});
const bodyFor = (call) => JSON.stringify({
  model: "reason", messages: [{ role: "user", content: "text Ama that I'm running late" }],
  extra_body: { reason_call_id: call.id, reason_conversation_id: call.conversation_id },
});
async function drain(stream) {
  let said = "";
  for await (const s of stream) {
    if (!s.startsWith("data: ") || s.includes("[DONE]")) continue;
    said += JSON.parse(s.slice(6)).choices[0].delta.content ?? "";
  }
  return said;
}
const rounds = (...batches) => {
  let i = 0;
  return async function* () {
    for (const e of batches[Math.min(i++, batches.length - 1)] ?? []) {
      if (typeof e === "string") yield { type: "text", text: e };
      else { if (e.start) yield { type: "tool_start", name: e.tool }; yield { type: "tool_use", name: e.tool, id: `tu_${Math.random().toString(16).slice(2, 8)}`, input: e.input ?? {} }; }
    }
  };
};
const turn = (call, generate, extra = {}) => voice.llmRequest({ rawBody: bodyFor(call), screen: async () => ({ verdict: "clear" }), generate, recallWaitMs: 0, ...extra });
const SEND = { tool: "message_send", start: true, input: { to: "+13105550000", text: "running late" } };

test("caller ID only: where they are, places and memories are allowed, exactly as on main", async () => {
  const row = inboundCall();
  for (const n of ["get_location", "nearby_places", "set_place", "weather", "recall", "memory_page", "memory_search", "graph_lookup", "uber_link"]) {
    assert.equal(verify.isConsequential(n, {}), false, n);
  }
  assert.match(voice.ownerContext({ call: row }).system, /Lives in Chelsea/);
  assert.match(gl.preCallBrief(row, { place: "Chelsea" }), /17th in Chelsea[^]*Chelsea/);
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true, latitude: 40.74, longitude: -74.0 }; };
  await drain((await turn(row, rounds([{ tool: "get_location", start: true }], ["You're in Chelsea."]))).stream);
  assert.deepEqual(ran, ["get_location"]);
});

test("a refused send, then nothing said: the code says it'll text them to confirm, the send never ran, and it is queued", async () => {
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true }; };
  const row = inboundCall();
  const lines = [];
  const out = await turn(row, rounds([SEND], [{ tool: "skip_turn", input: { reason: "x" } }]), { log: (l) => lines.push(l) });
  assert.equal((await drain(out.stream)).trim(), voice.CHECK_LATER_LINE);
  assert.match(voice.CHECK_LATER_LINE, /text you to confirm/);
  assert.deepEqual(ran, []);
  assert.ok(lines.some(l => l.call_tool_needs_verification === "message_send"));
  assert.match(db.getCall(C, row.id).verify_deferred, /^message_send .*running late/);
});

test("no tools and no words after the refusal, or out of rounds: still the text-back line", async () => {
  const out = await turn(inboundCall(), rounds([SEND], []));
  assert.equal((await drain(out.stream)).trim(), voice.CHECK_LATER_LINE);
  const out2 = await turn(inboundCall(), rounds([SEND]));
  assert.equal((await drain(out2.stream)).trim(), voice.CHECK_LATER_LINE);
});

test("words before the refused tool are not the text-back — it is said after them, once", async () => {
  const out = await turn(inboundCall(), rounds(["Let me send that. ", SEND], [{ tool: "skip_turn" }]));
  const said = (await drain(out.stream)).trim();
  assert.equal(said, `Let me send that. ${voice.CHECK_LATER_LINE}`);
});

test("the model's own text-back is said, with no code line added; verify_caller's queue is kept", async () => {
  const row = inboundCall();
  const out = await turn(row, rounds(
    [SEND],
    ["I'll text you to confirm that as soon as we hang up. ", { tool: "verify_caller", input: { about: "text Ama running late" } }],
    [{ tool: "skip_turn" }],
  ));
  const said = (await drain(out.stream)).trim();
  assert.equal(said, "I'll text you to confirm that as soon as we hang up.");
  assert.equal(db.getCall(C, row.id).verify_deferred, "text Ama running late");
});

test("end_call after a refusal is left to the platform; a verified or placed call is never refused", async () => {
  const out = await turn(inboundCall(), rounds([SEND], [{ tool: "end_call", input: { message: "Bye." } }]));
  assert.equal((await drain(out.stream)).trim(), "");
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true }; };
  const ok = db.updateCall(C, inboundCall().id, { verified_at: Date.now(), verified_how: "passphrase" });
  const out2 = await turn(ok, rounds([SEND], ["Sent."]));
  assert.doesNotMatch(await drain(out2.stream), /confirm/);
  assert.deepEqual(ran, ["message_send"]);
});

test("a passphrase set with tries left: the fallback line asks for it, nothing is queued", async () => {
  config.callPassphrase = "blue heron";
  try {
    const row = inboundCall();
    const out = await turn(row, rounds([SEND], [{ tool: "skip_turn" }]));
    assert.equal((await drain(out.stream)).trim(), voice.CHECK_NOT_HERE_LINE);
    assert.ok(!db.getCall(C, row.id).verify_deferred);
  } finally { config.callPassphrase = ""; }
});
