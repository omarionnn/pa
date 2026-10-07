// The ElevenLabs adapter, driven entirely by an injected fetch.
//
// Nothing in this file touches the network and nothing in it could ring a phone: every request is
// caught by a stub that records what it was handed, and the key is a string that is not a key. What
// can be proven before Omari has an account is that the *request* is right — the exact URL, the
// announcement in `first_message` word for word, the call's identity in `custom_llm_extra_body`, the
// pinned voice — and that what comes back is READ right, which is where Bland's two real lessons
// live: a voicemail is not a conversation, and a recording endpoint's 200 is not audio.
//
// Everything asserted against their docs here is from the pages named in src/calls/elevenlabs.js,
// read 2026-10-05/06. What those docs leave open is in docs/unverified.md rather than guessed at.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-eleven-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
// None of these is a key. Nothing here authenticates against anything; they only prove the shape.
process.env.ELEVENLABS_API_KEY = "eleven-test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ELEVENLABS_LLM_SECRET = "llm-test-secret";
process.env.ELEVENLABS_WEBHOOK_SECRET = "hook-test-secret";
process.env.ELEVENLABS_VOICE_ID = "voice_test";
// Not an undo-window test: anything reaching a third party is normally held for 30 seconds before
// it really goes, which would make every call in here come back 'held' instead of placed.
process.env.REASON_UNDO_SECONDS = "0";

const {
  ElevenLabsCallProvider, mapState, transcriptOf, transcriptTurns, conversationIdOf, EXTRA_BODY_KEYS,
} = await import("../src/calls/elevenlabs.js");
const { chooseCallProvider, CALL_PROVIDERS } = await import("../src/calls/choose.js");
const { announcementFor, callRulesFor } = await import("../src/calls/provider.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const PLACE = "+12125559999";
const ANN = announcementFor({ ownerName: "Omari" });
const RULES = callRulesFor({ ownerName: "Omari" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.publicUrl = "";
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads;");
});

/** A fetch that answers whatever is scripted and keeps every request it was handed. */
function stubFetch(answers) {
  const seen = [];
  const list = Array.isArray(answers) ? [...answers] : [answers];
  const impl = async (url, init = {}) => {
    seen.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const next = list.length > 1 ? list.shift() : list[0];
    if (typeof next === "function") return next({ url: String(url), init });
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? next.contentType ?? "application/json" : null) },
      json: async () => next.json ?? {},
      arrayBuffer: async () => next.bytes ?? new ArrayBuffer(0),
    };
  };
  impl.seen = seen;
  return impl;
}

const placed = { json: { conversation_id: "conv_abc", callSid: "CA123", success: true } };

const place = (provider, over = {}) => provider.place({
  to: PLACE, goal: "a table for four at eight", facts: ["the name is Omari"], maxSeconds: 600,
  announcement: ANN, rules: RULES, onBehalfOf: "Omari",
  callId: 7, conversationId: C, kind: "third_party", ...over,
});

// ---------- what it says about itself ----------

test("the provider is registered, and choosing it by name gets it", () => {
  assert.ok(CALL_PROVIDERS.includes("elevenlabs"));
  assert.equal(chooseCallProvider({ provider: "elevenlabs" }).name, "elevenlabs");
  // The owner's own shorthand, because a typo'd provider name must look like a typo.
  assert.equal(chooseCallProvider({ provider: "11labs" }).name, "elevenlabs");
  assert.equal(chooseCallProvider({ provider: "elevnlabs" }).status().status, "not_connected");
});

test("status names every missing setting, for each direction separately", () => {
  const bare = new ElevenLabsCallProvider({ key: "", agentId: "", phoneNumberId: "", llmSecret: "", webhookSecret: "" });
  const st = bare.status();
  assert.equal(st.status, "not_connected");
  assert.deepEqual(st.missing, ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_LLM_SECRET", "ELEVENLABS_PHONE_NUMBER_ID"]);
  assert.equal(st.records, true);
  assert.equal(st.directions.out, false);
  assert.equal(st.directions.in, false);

  // Outbound set up, inbound not: the two must not collapse into one answer. An install that can
  // ring a phone but cannot answer one has to say exactly that.
  const outOnly = new ElevenLabsCallProvider({ webhookSecret: "" });
  assert.equal(outOnly.status().status, "live");
  assert.equal(outOnly.status().directions.out, true);
  assert.equal(outOnly.status().directions.in, false);
  assert.deepEqual(outOnly.status().directions.missingIn, ["ELEVENLABS_WEBHOOK_SECRET"]);

  // A number to dial from is outbound's alone. Answering a phone does not need one.
  const inOnly = new ElevenLabsCallProvider({ phoneNumberId: "" });
  assert.equal(inOnly.status().status, "not_connected");
  assert.deepEqual(inOnly.status().missing, ["ELEVENLABS_PHONE_NUMBER_ID"]);
  assert.equal(inOnly.status().directions.in, true);

  // A voice id is NOT required for either: the voice is set on the agent, and claiming a call
  // could not be placed over it would be false.
  const noVoice = new ElevenLabsCallProvider({ voiceId: "" });
  assert.equal(noVoice.status().status, "live");
  assert.ok(!noVoice.status().missing.includes("ELEVENLABS_VOICE_ID"));

  // The call's own words come from Reason's endpoint. Without the secret ElevenLabs needs to get
  // into it there is no brain behind the voice, so it is not a call Reason will place.
  assert.deepEqual(new ElevenLabsCallProvider({ llmSecret: "" }).status().missing, ["ELEVENLABS_LLM_SECRET"]);
});

test("capabilities is honest about both directions, with and without the settings", () => {
  const both = capabilitiesNow({ calls: new ElevenLabsCallProvider(), conversationId: C, ownerName: "Omari" });
  const live = both.find(c => c.name === "phone_calls");
  assert.equal(live.status, "live");
  assert.match(live.what, /can also CALL this number/i);

  const outOnly = capabilitiesNow({ calls: new ElevenLabsCallProvider({ webhookSecret: "" }), conversationId: C, ownerName: "Omari" });
  const half = outOnly.find(c => c.name === "phone_calls");
  assert.equal(half.status, "live");
  assert.match(half.what, /CANNOT call this number/);
  assert.match(half.what, /ELEVENLABS_WEBHOOK_SECRET/);
  assert.match(half.what, /Do not tell anybody they can ring you/);

  const none = capabilitiesNow({
    calls: new ElevenLabsCallProvider({ key: "", agentId: "", phoneNumberId: "", llmSecret: "" }),
    conversationId: C, ownerName: "Omari",
  });
  const off = none.find(c => c.name === "phone_calls");
  assert.equal(off.status, "not connected");
  assert.match(off.what, /ELEVENLABS_API_KEY/);
  assert.match(off.what, /Do not offer to/);
});

// ---------- placing one ----------

test("one placed call: the documented endpoint, the announcement verbatim, the voice pinned", async () => {
  const fetchImpl = stubFetch(placed);
  const provider = new ElevenLabsCallProvider({ fetchImpl });
  const r = await place(provider);

  assert.equal(r.ok, true);
  assert.equal(r.externalId, "conv_abc");
  assert.equal(r.state, "placing");

  const [req] = fetchImpl.seen;
  assert.equal(req.url, "https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
  assert.equal(req.init.method, "POST");
  // Their own authentication header, not a bearer token.
  assert.equal(req.init.headers["xi-api-key"], "eleven-test-key");

  assert.equal(req.body.agent_id, "agent_test");
  assert.equal(req.body.agent_phone_number_id, "phnum_test");
  assert.equal(req.body.to_number, PLACE);

  const init = req.body.conversation_initiation_client_data;
  // The disclosure, word for word, as the agent's first message. Not pasted into a prompt.
  assert.equal(init.conversation_config_override.agent.first_message, ANN);
  assert.match(init.conversation_config_override.agent.first_message, /AI assistant/);
  assert.match(init.conversation_config_override.agent.first_message, /Omari/);
  assert.match(init.conversation_config_override.agent.first_message, /recorded/);
  // One pinned voice, every call.
  assert.equal(init.conversation_config_override.tts.voice_id, "voice_test");
  assert.equal(init.conversation_config_override.conversation.max_duration_seconds, 600);

  // Who this call is, so every turn of it finds its way back to the right person's Reason.
  assert.equal(init.custom_llm_extra_body[EXTRA_BODY_KEYS.callId], 7);
  assert.equal(init.custom_llm_extra_body[EXTRA_BODY_KEYS.conversationId], C);
  assert.equal(init.custom_llm_extra_body[EXTRA_BODY_KEYS.kind], "third_party");
});

test("no announcement, no rules, no payment rule: refused before anything is sent", async () => {
  const fetchImpl = stubFetch(placed);
  const provider = new ElevenLabsCallProvider({ fetchImpl });

  for (const over of [
    { announcement: "" },
    { announcement: "hi, quick question about a table" },
    { announcement: "Hi — this is an AI assistant calling. This call is recorded." }, // no owner named
    { announcement: "Hi — this is an AI assistant calling on behalf of Omari." }, // never says recorded
    { rules: [] },
    { rules: ["be nice on the phone"] },
  ]) {
    const r = await place(provider, over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.error, /^refused:/);
  }
  assert.equal(fetchImpl.seen.length, 0, "nothing was sent for any of them");
});

test("with a setting missing, no request is made and the error names the setting", async () => {
  const fetchImpl = stubFetch(placed);
  const r = await place(new ElevenLabsCallProvider({ fetchImpl, agentId: "" }));
  assert.equal(r.ok, false);
  assert.match(r.error, /ELEVENLABS_AGENT_ID/);
  assert.equal(fetchImpl.seen.length, 0);
});

test("a number that is not E.164, a goal that is empty, a kind that is not a kind: all refused unsent", async () => {
  const fetchImpl = stubFetch(placed);
  const provider = new ElevenLabsCallProvider({ fetchImpl });
  assert.match((await place(provider, { to: "212-555-9999" })).error, /E\.164/);
  assert.match((await place(provider, { goal: "   " })).error, /needs a goal/);
  assert.match((await place(provider, { kind: "anything" })).error, /not a kind of call/);
  assert.equal(fetchImpl.seen.length, 0);
});

test("a refusal from their side comes back as words, not as a call to follow", async () => {
  const provider = new ElevenLabsCallProvider({
    fetchImpl: stubFetch({ ok: false, status: 422, json: { detail: { message: "that number is not verified" } } }),
  });
  const r = await place(provider);
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 422/);
  assert.match(r.error, /not verified/);

  // Accepted, but with no conversation id: there is nothing to follow, and saying it worked would
  // leave a call nobody can account for.
  const noId = new ElevenLabsCallProvider({ fetchImpl: stubFetch({ json: { success: true } }) });
  assert.match((await place(noId)).error, /no conversation_id/);
});

// ---------- reading one back ----------

const conversation = (over = {}) => ({
  conversation_id: "conv_abc",
  status: "done",
  metadata: { call_duration_secs: 42, termination_reason: "agent ended the call" },
  analysis: { transcript_summary: "They have eight o'clock on Saturday." },
  transcript: [
    { role: "agent", message: ANN },
    { role: "user", message: "Hola, buenas tardes." },
    { role: "agent", message: "Buenas tardes — quería reservar una mesa." },
  ],
  ...over,
});

test("a finished call reads as one, with the audio fetched as bytes from the documented endpoint", async () => {
  const provider = new ElevenLabsCallProvider({ fetchImpl: stubFetch({ json: conversation() }) });
  const r = await provider.check("conv_abc");

  assert.equal(r.ok, true);
  assert.equal(r.state, "completed");
  assert.equal(r.durationS, 42);
  assert.equal(r.summary, "They have eight o'clock on Saturday.");
  assert.match(r.transcript, /^Reason: Hi — this is an AI assistant/);
  assert.match(r.transcript, /\nThem: Hola, buenas tardes\./);

  assert.equal(r.recording.url, "https://api.elevenlabs.io/v1/convai/conversations/conv_abc/audio");
  assert.equal(r.recording.headers["xi-api-key"], "eleven-test-key");
  // No pointer host is pre-authorised: their docs say this endpoint IS the audio, and the key is not
  // sent to whatever a body we have never seen happens to name.
  assert.equal(r.recording.pointerHosts, undefined);
  assert.equal(r.recordingWhy, "");
});

test("their cost is in credits, so the receipt says nothing rather than something wrong", async () => {
  const provider = new ElevenLabsCallProvider({ fetchImpl: stubFetch({ json: conversation({ metadata: { call_duration_secs: 42, cost: 350 } }) }) });
  const r = await provider.check("conv_abc");
  // 350 credits is not 350 cents and not $3.50. A number on a receipt that means nothing is worse
  // than no number.
  assert.equal(r.costCents, null);

  // A real dollar figure, if one ever arrives, is read. A call that ran is never billed nothing, so
  // a zero against a real length is "not priced yet" rather than free — Bland's lesson.
  const priced = new ElevenLabsCallProvider({ fetchImpl: stubFetch({ json: conversation({ metadata: { call_duration_secs: 42, cost_usd: 0.052 } }) }) });
  assert.equal((await priced.check("conv_abc")).costCents, 5);
  const free = new ElevenLabsCallProvider({ fetchImpl: stubFetch({ json: conversation({ metadata: { call_duration_secs: 42, cost_usd: 0 } }) }) });
  assert.equal((await free.check("conv_abc")).costCents, null);
});

test("voicemail is read off the termination fields, not off the status", () => {
  // Bland's lesson, which cost a real call: a completed call that reached an answering machine is
  // still status 'done'. Reading only the status files every answering machine as a conversation.
  assert.equal(mapState(conversation({ metadata: { call_duration_secs: 12, termination_reason: "voicemail detected" } })), "voicemail");
  assert.equal(mapState(conversation({ metadata: { call_duration_secs: 12, termination_reason: "answering machine" } })), "voicemail");
  assert.equal(mapState(conversation({ metadata: { call_duration_secs: 0, termination_reason: "no_answer" } })), "no_answer");
  assert.equal(mapState(conversation({ metadata: { termination_reason: "busy" } })), "busy");
  assert.equal(mapState(conversation()), "completed");

  // Live states are read before the termination fields, because a call still going has none.
  assert.equal(mapState({ status: "initiated" }), "placing");
  assert.equal(mapState({ status: "in-progress" }), "in_progress");
  // The gap after the audio stops while they work out the transcript. The call is OVER; Reason
  // simply does not have all of it yet, so it must not read as live.
  assert.equal(mapState({ status: "processing", metadata: { call_duration_secs: 30 } }), "completed");
  assert.equal(mapState({ status: "failed" }), "failed");
  // A status their docs do not list, with nothing to show it happened: not claimed either way.
  assert.equal(mapState({ status: "something_new" }), "placing");
});

test("a voicemail gets no recording error, and an answered call with no audio does", async () => {
  const vm = new ElevenLabsCallProvider({
    fetchImpl: stubFetch({ json: conversation({ metadata: { call_duration_secs: 9, termination_reason: "voicemail" } }) }),
  });
  const r = await vm.check("conv_abc");
  assert.equal(r.state, "voicemail");
  // There WAS audio of a voicemail greeting, and the owner gets it: `SPOKE_TO_SOMETHING` includes
  // voicemail, so the audio is still fetched. What must not happen is it being filed as a
  // conversation, which is src/calls/postcall.js's job and is pinned there.
  assert.ok(r.recording);

  const flagged = new ElevenLabsCallProvider({ fetchImpl: stubFetch({ json: conversation({ has_audio: false }) }) });
  const none = await flagged.check("conv_abc");
  assert.equal(none.recording, null);
  assert.match(none.recordingWhy, /no audio/);

  // Nobody picked up: there was nothing to record, and calling that a fault would train the owner
  // to ignore the warning that matters.
  const quiet = new ElevenLabsCallProvider({ fetchImpl: stubFetch({ json: conversation({ metadata: { termination_reason: "no_answer" } }) }) });
  const q = await quiet.check("conv_abc");
  assert.equal(q.recording, null);
  assert.equal(q.recordingWhy, "");
});

test("a transcript comes back as two speakers, and as turns a thread can be written from", () => {
  const body = conversation();
  assert.deepEqual(transcriptTurns(body).map(t => t.who), ["reason", "them", "reason"]);
  assert.equal(transcriptTurns(body)[1].text, "Hola, buenas tardes.");
  // A turn with a newline in it survives the structured list and would not survive the string.
  assert.equal(transcriptTurns({ transcript: [{ role: "user", message: "line one\nline two" }] })[0].text, "line one\nline two");
  assert.equal(transcriptOf({ transcript: "just a string" }), "just a string");
  assert.equal(conversationIdOf({ conversationId: "x" }), "x");
  assert.equal(conversationIdOf({}), null);
});

// ---------- the post-call webhook ----------

const sign = (raw, { secret = "hook-test-secret", t = Math.floor(Date.now() / 1000) } = {}) =>
  `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

test("a post-call delivery is only read when it is really signed", () => {
  const provider = new ElevenLabsCallProvider();
  const raw = JSON.stringify({ type: "post_call_transcription", data: conversation() });

  const good = provider.receiveWebhook({ rawBody: raw, headers: { "ElevenLabs-Signature": sign(raw) } });
  assert.equal(good.ok, true);
  assert.equal(good.type, "post_call_transcription");
  assert.equal(good.live.state, "completed");

  // Nothing at all.
  assert.equal(provider.receiveWebhook({ rawBody: raw, headers: {} }).status, 401);
  // Signed with the wrong secret.
  assert.equal(provider.receiveWebhook({ rawBody: raw, headers: { "elevenlabs-signature": sign(raw, { secret: "nope" }) } }).ok, false);
  // The right signature over a different body.
  assert.equal(provider.receiveWebhook({ rawBody: `${raw} `, headers: { "elevenlabs-signature": sign(raw) } }).ok, false);
  // Not in the documented shape.
  assert.match(provider.receiveWebhook({ rawBody: raw, headers: { "elevenlabs-signature": "deadbeef" } }).error, /documented t=,v0= shape/);

  // A valid delivery replayed tomorrow. Unlike Bland's, these carry a timestamp and it is checked:
  // a captured body must not be usable to settle a call twice and write a transcript again.
  const old = Math.floor(Date.now() / 1000) - 7200;
  const stale = provider.receiveWebhook({ rawBody: raw, headers: { "elevenlabs-signature": sign(raw, { t: old }) } });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /too far from now/);
});

test("no webhook secret on the machine means no delivery is accepted, signed or not", () => {
  // Deliberately unlike Bland, whose secret is optional in their dashboard so it falls back to the
  // per-call token in the URL. A post-call delivery writes into somebody's own conversation.
  const provider = new ElevenLabsCallProvider({ webhookSecret: "" });
  const raw = JSON.stringify({ type: "post_call_transcription", data: conversation() });
  const r = provider.receiveWebhook({ rawBody: raw, headers: { "elevenlabs-signature": sign(raw) } });
  assert.equal(r.ok, false);
  assert.match(r.error, /ELEVENLABS_WEBHOOK_SECRET/);
});

test("their three event types each come back as what they are", () => {
  const provider = new ElevenLabsCallProvider();

  const audioRaw = JSON.stringify({ type: "post_call_audio", data: { conversation_id: "conv_abc", full_audio: "QUJD" } });
  const audio = provider.receiveWebhook({ rawBody: audioRaw, headers: { "elevenlabs-signature": sign(audioRaw) } });
  assert.equal(audio.type, "post_call_audio");
  assert.equal(audio.audioBase64, "QUJD");
  assert.equal(audio.live, null);

  const failRaw = JSON.stringify({ type: "call_initiation_failure", data: { conversation_id: "conv_abc", reason: "the number is unreachable" } });
  const fail = provider.receiveWebhook({ rawBody: failRaw, headers: { "elevenlabs-signature": sign(failRaw) } });
  assert.equal(fail.live.state, "failed");
  assert.match(fail.live.outcome, /never started/);
  assert.match(fail.live.outcome, /unreachable/);
  // Nobody's phone was ever answered, so there was nothing to record. Not an audio fault.
  assert.equal(fail.live.recording, null);
  assert.equal(fail.live.recordingWhy, "");

  assert.equal(provider.receiveWebhook({ rawBody: "{", headers: { "elevenlabs-signature": sign("{") } }).status, 400);
});

// ---------- through the tool ----------

test("call_place through this provider hands it the call's own identity", async () => {
  const fetchImpl = stubFetch(placed);
  const provider = new ElevenLabsCallProvider({ fetchImpl });

  const asked = await runTool("confirm_request", {
    action: "call_place", summary: `ring ${PLACE} and ask for a table for four at eight`, target: PLACE,
  }, { conversationId: C, messages: [{ role: "user", content: "ring them" }] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, {
    conversationId: C,
    messages: [{ role: "user", content: "ring them" }, { role: "user", content: "yeah go" }],
    judge: async () => ({ verdict: "yes" }),
  });

  const out = await runTool("call_place", {
    to: PLACE, goal: "ask for a table for four at eight", facts: ["the name is Omari"],
    confirmation_id: asked.confirmation_id,
  }, { conversationId: C, calls: provider, messages: [] });

  assert.equal(out.ok, true);
  assert.equal(out.state, "placing");
  const row = db.getCall(C, out.call_id);
  assert.equal(row.provider, "elevenlabs");
  assert.equal(row.external_id, "conv_abc");
  assert.equal(row.direction, "out");
  assert.equal(row.is_owner, 0);

  // The row the provider was told about is the row that was really written.
  const sent = fetchImpl.seen[0].body.conversation_initiation_client_data.custom_llm_extra_body;
  assert.equal(sent[EXTRA_BODY_KEYS.callId], out.call_id);
  assert.equal(sent[EXTRA_BODY_KEYS.conversationId], C);
  assert.equal(sent[EXTRA_BODY_KEYS.kind], "third_party");
});

test("a call placed as a step of a job is stamped with the job", async () => {
  const started = await runTool("task_start", { title: "book Saturday", goal: "get a table for four" }, { conversationId: C, messages: [] });
  const taskId = started.task.id;

  const out = await runTool("call_place", { to: "owner", goal: "check which night works", task_id: taskId },
    { conversationId: C, calls: new ElevenLabsCallProvider({ fetchImpl: stubFetch(placed) }), messages: [] });
  assert.equal(out.ok, true);
  assert.equal(db.getCall(C, out.call_id).task_id, taskId);

  // A job it does not name is still an ordinary call that belongs to nothing.
  const loose = await runTool("call_place", { to: "owner", goal: "say hi" },
    { conversationId: C, calls: new ElevenLabsCallProvider({ fetchImpl: stubFetch(placed) }), messages: [] });
  assert.equal(db.getCall(C, loose.call_id).task_id, null);

  // And a job that is not this conversation's is refused rather than quietly ignored.
  const wrong = await runTool("call_place", { to: "owner", goal: "say hi", task_id: 9999 },
    { conversationId: C, calls: new ElevenLabsCallProvider({ fetchImpl: stubFetch(placed) }), messages: [] });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /No task #9999/);
});
