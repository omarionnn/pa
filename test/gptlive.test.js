// The GPT-Live trial (src/calls/gptlive.js): GPT-Live as the voice, Reason as the brain through client
// delegation, for the operator's own calls only. No network: the voice session, the Twilio stream, the
// Twilio API and Reason's turn are all stand-ins, and every assertion reads what was sent or the database.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-gptlive-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.ELEVENLABS_LLM_SECRET = "llm-test-secret";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";

const gl = await import("../src/calls/gptlive.js");
const ws = await import("../src/calls/wsserver.js");
const db = await import("../src/db.js");
const voice = await import("../src/calls/voice.js");
const { config, clock } = await import("../src/config.js");
const { settleCall } = await import("../src/tools.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts;");
  try { db.db.exec("DELETE FROM call_turns"); } catch { /* fresh db */ }
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callVoice: "", twilioSid: "", twilioToken: "", twilioFrom: "", openaiKey: "", gptliveInboundFallbackUrl: "" });
});

const on = (extra = {}) => Object.assign(config, { callVoice: "gptlive", ...TWILIO, ...extra });

const ownerCall = (over = {}) => db.createCall(over.conversationId ?? C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [],
  announcement: over.announcement ?? "Hey Omari, it's Reason.", state: "placing",
});

// ---------- who gets it ----------

test("unset flag: the provider is handed back untouched and nobody gets GPT-Live", () => {
  const inner = { place: async () => ({ ok: true }), check: async () => ({}), status: () => ({ name: "elevenlabs" }) };
  assert.equal(gl.withGptLive(inner), inner, "not even a wrapper in the path");
  assert.equal(gl.gptliveFor(C), false);
});

test("the flag is the operator's own calls only", () => {
  on();
  assert.equal(gl.gptliveFor(C), true);
  assert.equal(gl.gptliveFor(OTHER), false, "another person's calls stay on ElevenLabs");
  assert.equal(gl.gptliveFor(""), false);
  config.callVoice = "owner";
  assert.equal(gl.gptliveFor(C), false, "only the value gptlive switches it on");
});

test("place: an operator owner call dials through Twilio with the stream as TwiML; everything else is the inner provider", async () => {
  on();
  const innerCalls = [];
  const inner = { place: async (a) => { innerCalls.push(a); return { ok: true, externalId: "conv_x" }; }, check: async (id) => ({ ok: true, state: "x", id }), status: () => ({ name: "elevenlabs", status: "live" }) };
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push({ url, body: String(init.body), auth: init.headers.Authorization }); return { ok: true, status: 201, json: async () => ({ sid: "CA123" }) }; };
  const p = gl.withGptLive(inner, { fetchImpl });
  const row = ownerCall();

  const out = await p.place({ to: "+12025551234", kind: "owner", conversationId: C, callId: row.id });
  assert.equal(out.ok, true);
  assert.equal(out.provider, "gptlive");
  assert.equal(out.externalId, "gptlive:CA123");
  assert.equal(innerCalls.length, 0);
  assert.match(posted[0].url, /Accounts\/AC_test\/Calls\.json$/);
  const form = new URLSearchParams(posted[0].body);
  assert.match(form.get("Twiml"), new RegExp(`wss://reason\\.example\\.test/calls/gptlive/stream/${row.webhook_token}`));
  assert.equal(form.get("From"), "+16562167455");
  assert.match(form.get("StatusCallback"), /\/calls\/gptlive\/status\//);

  await p.place({ to: "+13105559999", kind: "third_party", conversationId: C, callId: row.id });
  await p.place({ to: "+13105550000", kind: "owner", conversationId: OTHER, callId: row.id });
  assert.equal(innerCalls.length, 2, "a business call and another person's own call both stay on ElevenLabs");
  assert.equal(posted.length, 1);

  assert.equal((await p.check("conv_x")).id, "conv_x", "an ElevenLabs id is checked by ElevenLabs");
  assert.equal(p.status().name, "elevenlabs", "everything else is the wrapped provider's");
});

test("place: without the Twilio keys an operator call quietly stays on ElevenLabs", async () => {
  on({ twilioToken: "" });
  let inner = 0;
  const p = gl.withGptLive({ place: async () => { inner++; return { ok: true }; }, check: async () => ({}), status: () => ({}) });
  const row = ownerCall();
  await p.place({ to: "+12025551234", kind: "owner", conversationId: C, callId: row.id });
  assert.equal(inner, 1);
  assert.deepEqual(gl.missingForGptlive(), ["TWILIO_AUTH_TOKEN"]);
});

// ---------- the honesty guard's words ----------

test("claimsDone: spoken completions, not negations or intentions", () => {
  for (const s of ["I've booked it for seven.", "It's been sent.", "That's done!", "You're all set.", "I just texted her.", "Okay, it's confirmed", "I've set up the reminder", "Done."]) {
    assert.equal(gl.claimsDone(s), true, s);
  }
  for (const s of ["It's not booked yet.", "I haven't sent it.", "I'll book it once you say yes.", "Let me check that.", "Do you want me to send it?", "Still working on it."]) {
    assert.equal(gl.claimsDone(s), false, s);
  }
});

// ---------- reading Reason's turn ----------

const sse = (...parts) => (async function* () {
  for (const p of parts) {
    if (typeof p === "string") yield voice.sseChunk({ id: "x", delta: { content: p } });
    else yield voice.sseChunk({ id: "x", delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: p.tool, arguments: JSON.stringify(p.args ?? {}) } }] } });
  }
  yield voice.SSE_DONE;
})();

test("readTurn: the code's fillers and NO_REPLY are dropped; end_call keeps its goodbye", async () => {
  const a = await gl.readTurn(sse(voice.HOLDING_LINE, voice.ONE_SEC, "Your dentist is at 9:30.", " NO_REPLY"));
  assert.match(a.text, /^Your dentist is at 9:30\.?$/);
  assert.doesNotMatch(a.text, /one moment|one sec/i);
  const b = await gl.readTurn(sse({ tool: "end_call", args: { reason: "done", message: "Talk soon!" } }));
  assert.deepEqual(b.endCall, { message: "Talk soon!" });
  const c = await gl.readTurn(sse({ tool: "skip_turn" }));
  assert.equal(c.skip, true);
  assert.equal(c.text, "");
});

test("μ-law: decode and encode agree, so a long call's recording keeps its sound", () => {
  for (const u of [0x00, 0x0f, 0x7f, 0x80, 0xaa, 0xfe, 0xff]) {
    const back = gl.pcmToUlaw(gl.ulawToPcm(u));
    assert.ok(Math.abs(gl.ulawToPcm(back) - gl.ulawToPcm(u)) <= 8, `0x${u.toString(16)}`);
  }
  assert.equal(gl.ulawToPcm(0xff), 0, "μ-law silence is zero");
});

test("the guard: a confirmed 'booked' does not cover a later, unrelated claim once they have asked something new", async () => {
  let n = 0;
  const { timers, live } = await startCall({ brain: async () => (++n === 1 ? { text: "It's booked for 7.", tools: [] } : new Promise(() => {})) });
  live.emit({ type: "session.started", session: { id: "live_1" } });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_a" } });
  await timers.advance(2000);
  live.emit({ type: "session.output_transcript.delta", delta: " You're all set, it's booked." });
  assert.equal(live.of("session.instructions.append").length, 0);
  await timers.advance(2000);
  live.emit({ type: "session.delegation.created", delegation: { id: "item_b" } });
  await timers.advance(2000);
  live.emit({ type: "session.output_transcript.delta", delta: " Done, I've texted her." });
  assert.equal(live.of("session.instructions.append").length, 1);
});

// ---------- the WebSocket server half ----------

test("wsserver: masked client frames are read, server frames are written unmasked", () => {
  const payload = Buffer.from(JSON.stringify({ event: "media", media: { payload: "AAAA" } }));
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  const r = ws.frameReader();
  assert.deepEqual(r.push(frame.subarray(0, 5)), [], "half a frame waits");
  const got = r.push(frame.subarray(5));
  assert.equal(got[0].payload.toString(), payload.toString());
  const out = ws.encodeFrame("x".repeat(300));
  assert.equal(out[0], 0x81);
  assert.equal(out[1], 126);
  assert.equal(out.readUInt16BE(2), 300);
  assert.equal(ws.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "the RFC 6455 example");
});

// ---------- one call, end to end, with stand-ins ----------

function fakeTimers() {
  let t = 1_000_000;
  let q = [];
  let n = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++n; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { q = q.filter(x => x.id !== id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        t = next.at;
        next.fn();
        await new Promise(r => setImmediate(r));
      }
      t = end;
    },
  };
}

function fakeTwilio() {
  const sent = [];
  const handlers = { msg: [], close: [] };
  let open = true;
  return {
    sent,
    open: () => open,
    send: (s) => sent.push(JSON.parse(s)),
    close: () => { open = false; },
    onMessage: (f) => handlers.msg.push(f),
    onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
  };
}

function fakeLive() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  return {
    sent,
    socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()),
    emit: (e) => h.event.forEach(f => f(e)),
    of: (type) => sent.filter(e => e.type === type),
  };
}

const ULAW_FRAME = Buffer.alloc(160, 0xff).toString("base64");

async function startCall({ brain, row = ownerCall() } = {}) {
  on();
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const finished = [];
  const call = new gl.GptLiveCall({
    call: row, twilio, openLive: () => live.socket, brain, now: timers.now, timers,
    finish: async (l) => { finished.push(l); },
  });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  return { call, timers, twilio, live, finished, row };
}

test("a call: μ-law session, greeting, caller audio relayed, delegation answered by Reason", async () => {
  const asked = [];
  const { timers, twilio, live } = await startCall({
    brain: async (messages) => { asked.push(messages); return { text: "Tomorrow you've got the dentist at 9:30.", tools: [], endCall: null }; },
  });
  const start = live.of("session.start")[0];
  assert.deepEqual(start.session.audio.format, { type: "audio/pcmu", rate: 8000 });
  assert.deepEqual(start.session.delegation, { type: "client" });
  assert.equal(start.session.audio.output.voice, "marin");
  assert.match(start.session.instructions, /only the voice/);

  twilio.say({ event: "media", media: { payload: ULAW_FRAME } });
  assert.equal(live.of("session.input_audio.append").length, 0, "nothing goes in before the session has started");
  live.emit({ type: "session.started", session: { id: "live_1" } });
  assert.match(live.of("session.commentary.append")[0].content, /Hey Omari, it's Reason/);
  twilio.say({ event: "media", media: { payload: ULAW_FRAME } });
  assert.equal(live.of("session.input_audio.append").length, 1);

  live.emit({ type: "session.input_transcript.delta", delta: " What's on tomorrow?" });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_1", type: "delegation", target: "client" } });
  await timers.advance(10);
  assert.deepEqual(asked[0].at(-1), { role: "user", content: "What's on tomorrow?" });
  assert.equal(asked[0][0].role, "assistant", "the greeting is the call's first line");
  const result = live.of("session.commentary.append").find(e => e.delegation_id === "item_1");
  assert.equal(result.content, "Tomorrow you've got the dentist at 9:30.");

  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  const media = twilio.sent.filter(m => m.event === "media");
  assert.equal(media.length, 1);
  assert.equal(media[0].streamSid, "MZ1");
});

test("the guard: a 'done' before Reason confirmed it clears the line and makes the voice correct itself", async () => {
  let release;
  const { timers, twilio, live } = await startCall({ brain: () => new Promise(r => { release = r; }) });
  live.emit({ type: "session.started", session: { id: "live_1" } });
  live.emit({ type: "session.input_transcript.delta", delta: " Book the table for seven." });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_9" } });
  await timers.advance(5);

  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  live.emit({ type: "session.output_transcript.delta", delta: " Great, I've booked it" });
  assert.ok(twilio.sent.some(m => m.event === "clear"), "Twilio's unplayed audio is thrown away");
  const fix = live.of("session.instructions.append")[0];
  assert.equal(fix.content, gl.GUARD_CORRECTION);
  assert.equal(fix.delegation_id, null);

  const before = twilio.sent.filter(m => m.event === "media").length;
  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  assert.equal(twilio.sent.filter(m => m.event === "media").length, before, "the rest of the claim is not played");
  live.emit({ type: "session.instructions.appended", client_event_id: fix.event_id });
  await timers.advance(400);
  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  assert.equal(twilio.sent.filter(m => m.event === "media").length, before + 1, "the correction plays");

  // Once Reason itself says it is booked, the voice may say so.
  release({ text: "It's booked for 7 at Luigi's.", tools: [], endCall: null });
  await timers.advance(1600);
  live.emit({ type: "session.output_transcript.delta", delta: " All booked, it's confirmed for seven." });
  assert.equal(live.of("session.instructions.append").length, 1, "no second correction for a confirmed result");
});

test("the guard: a claim with no task behind it at all is stopped too, and NO_REPLY is never played", async () => {
  const { timers, live } = await startCall({ brain: async () => ({ text: "", tools: [] }) });
  live.emit({ type: "session.started", session: { id: "live_1" } });
  live.emit({ type: "session.output_transcript.delta", delta: " Sure, I've sent it." });
  assert.equal(live.of("session.instructions.append").length, 1);
  await timers.advance(5000);
  live.emit({ type: "session.output_transcript.delta", delta: " NO_REPLY" });
  assert.equal(live.of("session.instructions.append").length, 2);
});

test("end_call: the goodbye is said, the line ends, and the call settles with cost, transcript and audio", async () => {
  const { call, timers, twilio, live, finished } = await startCall({
    brain: async () => ({ text: "", tools: ["end_call"], endCall: { message: "Talk soon!" } }),
  });
  live.emit({ type: "session.started", session: { id: "live_1" } });
  for (let i = 0; i < 100; i++) twilio.say({ event: "media", media: { payload: ULAW_FRAME } });
  live.emit({ type: "session.input_transcript.delta", delta: " That's all, bye." });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_bye" } });
  await timers.advance(10);
  assert.equal(live.of("session.commentary.append").find(e => e.delegation_id === "item_bye").content, "Talk soon!");
  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  live.emit({ type: "session.output_transcript.delta", delta: " Talk soon!" });
  live.emit({ type: "session.usage.updated", usage: { seconds: 90 } });
  await timers.advance(3000);
  assert.ok(live.of("session.close").length, "the voice session is closed");
  live.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 96 } });
  await timers.advance(3500);
  assert.equal(call.done, true);
  assert.equal(twilio.open(), false, "the stream is ended, which ends the call");
  const l = finished[0];
  assert.equal(l.state, "completed");
  assert.equal(l.termination, "end_call");
  assert.equal(l.durationS, 96);
  assert.equal(l.costCents, 8, "96 s at 5¢ a minute");
  assert.match(l.transcript, /Them: That's all, bye\./);
  assert.ok(existsSync(l.recording.path));
  assert.equal(readFileSync(l.recording.path).toString("latin1", 0, 4), "RIFF");
});

test("what the caller heard is written onto the turn Reason's own request recorded, tagged gptlive", async () => {
  const row = ownerCall();
  db.recordCallTurn({ callId: row.id, conversationId: C, msgCount: 2, kind: "owner", startedAt: Date.now(), firstContentMs: 900, firstRealMs: 900, totalMs: 2000 });
  const { timers, live } = await startCall({ row, brain: async () => ({ text: "It's 3 pm in Accra.", tools: [] }) });
  live.emit({ type: "session.started", session: { id: "live_1" } });
  live.emit({ type: "session.input_transcript.delta", delta: " What time is it in Accra?" });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_t" } });
  await timers.advance(300);
  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  const t = db.callTurns(row.id)[0];
  assert.equal(t.voice, "gptlive");
  assert.equal(t.first_real_ms, 300);
});

// ---------- Twilio's webhooks ----------

test("status: a signed no-answer settles the call; an unsigned one is refused", async () => {
  on();
  const row = ownerCall();
  const url = `${config.publicUrl}${gl.STATUS_PATH}${row.webhook_token}`;
  const params = { CallSid: "CA9", CallStatus: "no-answer", CallDuration: "0" };
  const rawBody = new URLSearchParams(params).toString();
  const bad = await gl.statusRequest({ token: row.webhook_token, rawBody, headers: { "x-twilio-signature": "nope" }, settle: settleCall });
  assert.equal(bad.status, 403);
  const ok = await gl.statusRequest({ token: row.webhook_token, rawBody, headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, settle: settleCall });
  assert.equal(ok.status, 204);
  const after = db.getCall(C, row.id);
  assert.equal(after.state, "no_answer");
  assert.equal(after.recording_state, "not_applicable");
});

test("inbound: the operator's own number gets the stream; anyone else is redirected to ElevenLabs unchanged", () => {
  on({ gptliveInboundFallbackUrl: "https://api.us.elevenlabs.io/twilio/inbound_call" });
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  const ring = (from) => {
    const params = { CallSid: `CA_${from}`, From: from, To: "+16562167455" };
    return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) } });
  };
  const mine = ring("+12025551234");
  assert.match(mine.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//);
  const row = db.db.prepare("SELECT * FROM calls WHERE provider = 'gptlive'").get();
  assert.equal(row.is_owner, 1);
  assert.equal(row.direction, "in");
  const theirs = ring("+13105550000");
  assert.match(theirs.body, /<Redirect method="POST">https:\/\/api\.us\.elevenlabs\.io\/twilio\/inbound_call<\/Redirect>/);
  const stranger = ring("+14155550199");
  assert.match(stranger.body, /<Redirect/);
});

// ---------- the report ----------

test("the call report splits its numbers by voice", async () => {
  const { buildCallReport, formatCallReport } = await import("../src/calls/report.js");
  const a = db.createCall(C, { provider: "elevenlabs", toNumber: "+12025551234", isOwner: true, goal: "g", facts: [] });
  const b = ownerCall();
  db.recordCallTurn({ callId: a.id, conversationId: C, msgCount: 1, startedAt: 1, firstContentMs: 1200, firstRealMs: 3000 });
  db.recordCallTurn({ callId: b.id, conversationId: C, msgCount: 1, startedAt: 1, firstContentMs: 400, firstRealMs: 2500 });
  const r = buildCallReport(db.db);
  assert.equal(r.voices.elevenlabs.heard_p50_ms, 1200);
  assert.equal(r.voices.gptlive.heard_p50_ms, 400);
  assert.match(formatCallReport(r), /voice gptlive: calls 1 · turns 1/);
});
