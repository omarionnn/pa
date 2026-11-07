// The personalization webhook answers during the ring with the caller's name, their conversation id,
// and an opening line built from their thread; it also writes a call row, counts a call against the
// day's cap and warms the model cache. So it must only do any of that for ElevenLabs itself.
//
// ElevenLabs authenticates this webhook with request headers set in the Agents settings (the
// "secrets" next to the webhook URL) — there is no signature on it. Reason's side of that is
// ELEVENLABS_INBOUND_SECRET: when it is set, a request without it (as a bearer token or x-api-key)
// is refused with nothing written, nothing counted and nothing warmed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-inbound-auth-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_CALL_CAPS_EXEMPT = "none";
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
process.env.ELEVENLABS_VOICE_ID = "voice_test";
process.env.REASON_UNDO_SECONDS = "0";

const { inboundRequest } = await import("../src/calls/inbound.js");
const { ElevenLabsCallProvider } = await import("../src/calls/elevenlabs.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const SECRET = "ring-test-secret";
const router = { get: () => null, statuses: () => [] };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: OWNER, name: "Omari", isOperator: true });
});

const ring = ({ headers = {}, inboundSecret = SECRET, conv = "forged-1" } = {}) => {
  const warmed = [];
  const out = inboundRequest({
    rawBody: JSON.stringify({ caller_id: OWNER, agent_id: "agent_test", called_number: "+16465550000", call_sid: "CA1", conversation_id: conv }),
    headers,
    provider: new ElevenLabsCallProvider({ inboundSecret }),
    router,
    warm: (...a) => warmed.push(a),
  });
  return { out, warmed };
};
const rows = (conv) => db.db.prepare("SELECT * FROM calls WHERE external_id = ?").all(conv);
const callsCounted = () => db.db.prepare("SELECT COUNT(*) AS n FROM usage").get().n;

test("a forged ring with no secret gets nothing: no name, no row, no count, no warm-up", () => {
  const { out, warmed } = ring({ headers: {} });
  assert.equal(out.status, 401);
  assert.equal(JSON.stringify(out.body).includes("Omari"), false, "the owner's name must not be in the answer");
  assert.equal(JSON.stringify(out.body).includes(C), false, "the conversation id must not be in the answer");
  assert.equal(rows("forged-1").length, 0, "no call row for a forged request");
  assert.equal(callsCounted(), 0, "nothing counted against the day's cap");
  assert.equal(warmed.length, 0, "no model warm-up paid for");
});

test("a wrong secret is refused the same way", () => {
  const { out, warmed } = ring({ headers: { authorization: "Bearer not-the-secret" } });
  assert.equal(out.status, 401);
  assert.equal(rows("forged-1").length, 0);
  assert.equal(warmed.length, 0);
  const again = ring({ headers: { "x-api-key": "ring-test-secreX" } });
  assert.equal(again.out.status, 401);
});

test("ElevenLabs carrying the secret is answered as before", () => {
  const { out, warmed } = ring({ headers: { Authorization: `Bearer ${SECRET}` }, conv: "real-1" });
  assert.equal(out.status, 200);
  assert.equal(out.body.dynamic_variables.owner_name, "Omari");
  assert.equal(rows("real-1").length, 1);
  assert.equal(warmed.length, 1);
  const viaKey = ring({ headers: { "x-api-key": SECRET }, conv: "real-2" });
  assert.equal(viaKey.out.status, 200);
});
