// ElevenLabs is gone from Reason's calls (Omari, 2026-11-07): every call is GPT-Live over Twilio.
// So the three ElevenLabs routes (the ring-time personalization webhook, the custom-LLM endpoint and
// the post-call delivery) are not there at all, the number's GPT-Live voice webhook never hands a
// call to an ElevenLabs URL, even with the old fallback variable still in the environment, and
// GPT-Live is a provider of its own that still answers and places calls. No network: Twilio is a
// stand-in and every request goes to a listener on 127.0.0.1.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-no-eleven-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
// Everything an ElevenLabs install had, so on the old code its routes are really live.
Object.assign(process.env, {
  ELEVENLABS_API_KEY: "xi-test", ELEVENLABS_AGENT_ID: "agent_test", ELEVENLABS_PHONE_NUMBER_ID: "pn_test",
  ELEVENLABS_PHONE_NUMBER: "+16562167455", ELEVENLABS_LLM_SECRET: "llm-test", ELEVENLABS_WEBHOOK_SECRET: "wh-test",
  ELEVENLABS_INBOUND_SECRET: "in-test", REASON_GPTLIVE_INBOUND_FALLBACK_URL: "https://api.us.elevenlabs.io/twilio/inbound_call",
});

const { createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { chooseCallProvider } = await import("../src/calls/choose.js");
const gl = await import("../src/calls/gptlive.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const C = config.ownerConversation;
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };
const router = new Router({ log: () => {} });
router.register(new ConsoleChannel({ write: () => {} }));

let server;
let base;
let calls;
before(async () => {
  calls = chooseCallProvider({ provider: "elevenlabs" });
  server = createServer({ router, runtime: { turnExtras: { calls } }, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db.db.exec("DELETE FROM calls; DELETE FROM accounts;");
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: "sendblue:+13105550000", channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callVoice: "gptlive", thirdPartyVoice: "gptlive", ...TWILIO });
});

const post = async (path, body = "{}", headers = { "content-type": "application/json" }) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
};

const ring = (from) => {
  const params = { CallSid: `CA_${from}`, From: from, To: "+16562167455" };
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  return post(gl.INBOUND_PATH, new URLSearchParams(params).toString(), {
    "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": gl.twilioSignature(url, params),
  });
};

test("the ElevenLabs routes are gone: inbound, custom LLM, post-call and its call-finished webhook all 404", async () => {
  for (const path of ["/calls/elevenlabs/inbound", "/calls/elevenlabs/llm", "/calls/elevenlabs/llm/chat/completions", "/calls/elevenlabs/post-call", "/calls/elevenlabs/webhook/abcdefghijklmnop1234"]) {
    const out = await post(path);
    assert.equal(out.status, 404, `${path} still answers (${out.status})`);
  }
});

test("there is no ElevenLabs provider to choose any more", () => {
  const st = chooseCallProvider({ provider: "elevenlabs" }).status();
  assert.equal(st.status, "not_connected");
  assert.doesNotMatch(st.what, /through ElevenLabs/);
});

test("GPT-Live inbound never names ElevenLabs, even with the old fallback still in the environment", async () => {
  // A known user, the operator, and a stranger: all on the stream.
  for (const from of ["+12025551234", "+13105550000", "+14155550199"]) {
    const out = await ring(from);
    assert.equal(out.status, 200);
    assert.match(out.text, /<Connect><Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//, `${from} is not streamed`);
  }
  // The operator-only trial mode: nobody is handed to a second voice; GPT-Live takes them too.
  config.callVoice = "owner";
  const other = await ring("+13105550000");
  assert.match(other.text, /<Stream/);
  assert.doesNotMatch(other.text, /eleven/i);
  // GPT-Live cannot take the call (no OpenAI key): Twilio rejects it, no redirect to anybody.
  config.callVoice = "gptlive";
  config.openaiKey = "";
  const away = await ring("+13105550000");
  assert.equal(away.status, 200);
  assert.doesNotMatch(away.text, /eleven|<Redirect/i);
  assert.match(away.text, /<Reject\/>/);
});

test("GPT-Live is its own provider: live with Twilio + OpenAI keys alone, and places a call over Twilio", async () => {
  const p = chooseCallProvider({ provider: "gptlive", fetchImpl: async (url, init) => {
    posted.push({ url, body: String(init.body) });
    return { ok: true, status: 201, json: async () => ({ sid: "CA_out" }) };
  } });
  const posted = [];
  const st = p.status();
  assert.equal(st.name, "gptlive");
  assert.equal(st.status, "live", JSON.stringify(st.missing));
  assert.deepEqual(gl.missingForGptlive(), []);
  config.twilioFrom = "";
  assert.ok(gl.missingForGptlive().includes("TWILIO_FROM_NUMBER"));
  assert.ok(!gl.missingForGptlive().some(k => /ELEVEN/.test(k)), "nothing ElevenLabs is needed");
  config.twilioFrom = TWILIO.twilioFrom;

  const row = db.createCall(C, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey Omari, it's Reason.", state: "placing" });
  const out = await p.place({ to: "+12025551234", kind: "owner", conversationId: C, callId: row.id, announcement: "Hey Omari, it's Reason.", rules: ["r"], goal: "check in", facts: [] });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.provider, "gptlive");
  assert.match(out.externalId, /^gptlive:CA_out$/);
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /api\.twilio\.com\/2010-04-01\/Accounts\/AC_test\/Calls\.json$/);
  assert.match(decodeURIComponent(posted[0].body), /calls\/gptlive\/stream\//);
  // The wrapper is not in the way: GPT-Live as the provider is handed back as it is.
  assert.equal(gl.withGptLive(p), p);
});
