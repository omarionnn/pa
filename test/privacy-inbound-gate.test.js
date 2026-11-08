// Privacy (drive 11-08 on OVH, --as spoofed): a call that came IN on the owner's number with caller ID
// only was told "home and work are both in Chelsea". Where they are, or usually are, is behind the
// caller check now: the whereabouts tools are refused like money and sends, the profile is kept out of
// Claude's call turn, a place is kept out of the voice's brief, and the refusal is always said out loud.
// No network: the model, the tools and the voice session are stand-ins.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-privacy-gate-"));
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
const PROFILE = "**Omari**\n- Lives in Chelsea, Manhattan\n- Works at 430 W 17th St";

after(() => rmSync(dir, { recursive: true, force: true }));
let realRunTool;
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages;");
  db.saveConversation(C, []);
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
const placedCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "Omari asked to be called", facts: [],
  announcement: "Hey Omari, it's Reason.", state: "in_progress",
});
const bodyFor = (call) => JSON.stringify({
  model: "reason", messages: [{ role: "user", content: "where am I right now?" }],
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
/** A turn of rounds, each a list of events: strings are text deltas, objects a tool call. */
const rounds = (...batches) => {
  let i = 0;
  return async function* () {
    for (const e of batches[Math.min(i++, batches.length - 1)] ?? []) {
      if (typeof e === "string") yield { type: "text", text: e };
      else { if (e.start) yield { type: "tool_start", name: e.tool }; yield { type: "tool_use", name: e.tool, id: `tu_${Math.random().toString(16).slice(2, 8)}`, input: e.input ?? {} }; }
    }
  };
};
const turn = (call, generate, extra = {}) => voice.llmRequest({ rawBody: bodyFor(call), screen: async () => ({ verdict: "clear" }), generate, ...extra });

test("privacy: on an inbound call with caller ID only, the whereabouts tools are refused for the check, never run", async () => {
  const row = inboundCall();
  assert.equal(verify.isVerified(row), false);
  for (const n of ["get_location", "nearby_places", "set_place", "weather", "call_place"]) assert.equal(verify.isConsequential(n, {}), true, n);
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true, latitude: 40.74, longitude: -74.0, address: "430 W 17th St" }; };
  const lines = [];
  const out = await turn(row, rounds([{ tool: "get_location", start: true }], ["I can't share that on this call."]), { log: (l) => lines.push(l) });
  const said = await drain(out.stream);
  assert.ok(!ran.includes("get_location"), "never ran");
  assert.ok(lines.some(l => l.call_tool_needs_verification === "get_location"));
  assert.doesNotMatch(said, /17th|Chelsea/);
  assert.match(verify.gateRefusal({ call: row, name: "get_location" }).say, /caller ID alone/);
});

test("privacy: a call Reason placed to them, or an inbound one once verified, still gets the location", async () => {
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true, latitude: 40.74, longitude: -74.0 }; };
  for (const row of [placedCall(), db.updateCall(C, inboundCall().id, { verified_at: Date.now(), verified_how: "passphrase" })]) {
    ran.length = 0;
    const lines = [];
    const out = await turn(row, rounds([{ tool: "get_location", start: true }], ["You're in Chelsea."]), { log: (l) => lines.push(l) });
    const said = await drain(out.stream);
    assert.deepEqual(ran, ["get_location"], String(row.direction));
    assert.ok(!lines.some(l => l.call_tool_needs_verification));
    assert.match(said, /Chelsea/);
  }
});

test("privacy: no profile in Claude's call turn and no place in the voice's brief until verified", () => {
  const row = inboundCall();
  assert.doesNotMatch(voice.ownerContext({ call: row }).system, /Chelsea|430 W 17th/);
  assert.doesNotMatch(gl.preCallBrief(row, { place: "Chelsea" }), /Chelsea/);
  const ok = db.updateCall(C, row.id, { verified_at: Date.now(), verified_how: "passphrase" });
  assert.match(voice.ownerContext({ call: ok }).system, /Lives in Chelsea/);
  assert.match(gl.preCallBrief(ok, { place: "Chelsea" }), /Chelsea/);
  // His own call, placed by Reason: unchanged.
  assert.match(voice.ownerContext({ call: placedCall() }).system, /Lives in Chelsea/);
});

test("privacy: refused and nothing said — the code says the refusal itself, then the skip goes out", async () => {
  const out = await turn(inboundCall(), rounds([{ tool: "get_location", start: true }], [{ tool: "skip_turn", input: { reason: "x" } }]));
  assert.equal((await drain(out.stream)).trim(), voice.CHECK_NOT_HERE_LINE);
  const out2 = await turn(inboundCall(), rounds([{ tool: "get_location", start: true }], []));
  assert.equal((await drain(out2.stream)).trim(), voice.CHECK_NOT_HERE_LINE);
});

test("privacy: refused, queued by verify_caller, then a skip — 'I'll pick it up by text' is said", async () => {
  const out = await turn(inboundCall(), rounds(
    [{ tool: "get_location", start: true }],
    [{ tool: "verify_caller", input: { about: "where they are" } }],
    [{ tool: "skip_turn", input: { reason: "waiting" } }],
  ));
  assert.equal((await drain(out.stream)).trim(), voice.CHECK_LATER_LINE);
});

test("privacy: the model's own refusal is said once, with no code line added", async () => {
  const out = await turn(inboundCall(), rounds(
    [{ tool: "get_location", start: true }],
    ["I can't check that on this call, I'll pick it up by text once we hang up. ", { tool: "skip_turn", input: { reason: "waiting" } }],
  ));
  const said = (await drain(out.stream)).trim();
  assert.match(said, /pick it up by text once we hang up/);
  assert.ok(!said.includes(voice.CHECK_NOT_HERE_LINE) && !said.includes(voice.CHECK_LATER_LINE), said);
});

// ---------- cold review 11-08 ----------
test("privacy: the memory tools wait for the check too (they hold the facts the profile is built from)", async () => {
  for (const n of ["recall", "memory_page", "memory_search", "graph_lookup", "uber_link", "uber_options"]) assert.equal(verify.isConsequential(n, {}), true, n);
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true, page: PROFILE }; };
  const out = await turn(inboundCall(), rounds([{ tool: "memory_page", start: true }], [{ tool: "skip_turn" }]));
  const said = await drain(out.stream);
  assert.deepEqual(ran, []);
  assert.doesNotMatch(said, /Chelsea/);
  assert.equal(said.trim(), voice.CHECK_NOT_HERE_LINE);
});

test("privacy: words before the refused tool are not the refusal — it is still said after them", async () => {
  const out = await turn(inboundCall(), rounds(["Let me check where you are. ", { tool: "get_location", start: true }], [{ tool: "skip_turn" }]));
  const said = (await drain(out.stream)).trim();
  assert.match(said, /^Let me check where you are\./);
  assert.ok(said.endsWith(voice.CHECK_NOT_HERE_LINE), said);
  assert.doesNotMatch(said, / {2}/, "one space between the two");
});

test("privacy: out of rounds after a refusal says the refusal, not the generic line", async () => {
  const out = await turn(inboundCall(), rounds([{ tool: "get_location", start: true }]));
  assert.equal((await drain(out.stream)).trim(), voice.CHECK_NOT_HERE_LINE);
});

test("privacy: a refused send then a skip is said too; end_call after a refusal is left to the platform", async () => {
  const out = await turn(inboundCall(), rounds([{ tool: "message_send", start: true, input: { to: "+13105550000", text: "hi" } }], [{ tool: "skip_turn" }]));
  assert.equal((await drain(out.stream)).trim(), voice.CHECK_NOT_HERE_LINE);
  const out2 = await turn(inboundCall(), rounds([{ tool: "get_location", start: true }], [{ tool: "end_call", input: { message: "Bye." } }]));
  assert.equal((await drain(out2.stream)).trim(), "");
});

test("privacy: the voice's brief has none of their chats on an unverified inbound call; the rule names where they are", () => {
  db.saveConversation(C, [{ role: "user", content: "I'm at work on 17th St in Chelsea" }, { role: "assistant", content: "Noted, Chelsea it is." }]);
  const row = inboundCall();
  assert.doesNotMatch(gl.preCallBrief(row), /Chelsea|17th/);
  assert.match(verify.promptNote({ call: row }), /where they are or usually are/);
  const ok = db.updateCall(C, row.id, { verified_at: Date.now(), verified_how: "passphrase" });
  assert.match(gl.preCallBrief(ok), /Chelsea/);
  assert.equal(verify.promptNote({ call: ok }), "");
});
