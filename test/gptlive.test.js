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
  Object.assign(config, { callIdentity: false, makerName: "Saafi Interactions Lab", callVoice: "", twilioSid: "", twilioToken: "", twilioFrom: "", openaiKey: "" });
});

const on = (extra = {}) => Object.assign(config, { callVoice: "gptlive", ...TWILIO, ...extra });

const ownerCall = (over = {}) => db.createCall(over.conversationId ?? C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [],
  announcement: over.announcement ?? "Hey Omari, it's Reason.", state: "placing",
});

// ---------- who gets it ----------

test("unset flag: the provider is handed back untouched and nobody gets GPT-Live", () => {
  const inner = { place: async () => ({ ok: true }), check: async () => ({}), status: () => ({ name: "bland" }) };
  assert.equal(gl.withGptLive(inner), inner, "not even a wrapper in the path");
  assert.equal(gl.gptliveFor(C), false);
});

test("the flag: gptlive is every account's own calls, owner is the operator's only", () => {
  on();
  assert.equal(gl.gptliveFor(C), true);
  assert.equal(gl.gptliveFor(OTHER), true, "another person's own calls are GPT-Live too");
  assert.equal(gl.gptliveFor("nobody-has-this"), false, "no account, no GPT-Live");
  assert.equal(gl.gptliveFor(""), false);
  config.callVoice = "on";
  assert.equal(gl.gptliveFor(OTHER), true);
  config.callVoice = "owner";
  assert.equal(gl.gptliveFor(C), true, "owner: the operator");
  assert.equal(gl.gptliveFor(OTHER), false, "owner: another person's calls stay on the wrapped provider");
  assert.equal(gl.gptliveOn(), true);
  config.callVoice = "bland";
  assert.equal(gl.gptliveFor(C), false, "any other value is off");
  assert.equal(gl.gptliveOn(), false);
});

test("place: an operator owner call dials through Twilio with the stream as TwiML; everything else is the inner provider", async () => {
  on();
  const innerCalls = [];
  const inner = { place: async (a) => { innerCalls.push(a); return { ok: true, externalId: "conv_x" }; }, check: async (id) => ({ ok: true, state: "x", id }), status: () => ({ name: "bland", status: "live" }) };
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push({ url, body: String(init.body), auth: init.headers.Authorization }); return { ok: true, status: 201, json: async () => ({ sid: "CA123" }) }; };
  const warmLive = fakeLive();
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
  warmLive.open();
  assert.equal(warmLive.of("session.start").length, 0, "no warm-up while it rings: the session opens on the stream, as on call 53");

  await p.place({ to: "+13105559999", kind: "third_party", conversationId: C, callId: row.id });
  assert.equal(innerCalls.length, 1, "a business call stays on the wrapped provider");
  const otherRow = ownerCall({ conversationId: OTHER });
  const theirs = await p.place({ to: "+13105550000", kind: "owner", conversationId: OTHER, callId: otherRow.id });
  assert.equal(theirs.provider, "gptlive", "another person's own call is GPT-Live, on their own row");
  assert.match(new URLSearchParams(posted[1].body).get("Twiml"), new RegExp(otherRow.webhook_token));
  config.callVoice = "owner";
  await p.place({ to: "+13105550000", kind: "owner", conversationId: OTHER, callId: otherRow.id });
  assert.equal(innerCalls.length, 2, "on owner, another person's own call stays on the wrapped provider");
  assert.equal(posted.length, 2);

  assert.equal((await p.check("conv_x")).id, "conv_x", "the wrapped provider's id is checked by it");
  assert.equal(p.status().name, "bland", "everything else is the wrapped provider's");
});

test("place: without the Twilio keys an operator call is refused with the reason, never handed to the wrapped provider", async () => {
  on({ twilioToken: "" });
  let inner = 0;
  const p = gl.withGptLive({ place: async () => { inner++; return { ok: true }; }, check: async () => ({}), status: () => ({}) });
  const row = ownerCall();
  const out = await p.place({ to: "+12025551234", kind: "owner", conversationId: C, callId: row.id });
  assert.equal(inner, 0, "there is no second voice to hand it to");
  assert.equal(out.ok, false);
  assert.match(out.error, /not set up on this machine: no TWILIO_AUTH_TOKEN/);
  assert.deepEqual(gl.missingForGptlive(), ["TWILIO_AUTH_TOKEN"]);
  // No row token either: refused, not handed on.
  on();
  const none = await p.place({ to: "+12025551234", kind: "owner", conversationId: C, callId: 999999 });
  assert.equal(none.ok, false);
  assert.equal(inner, 0);
});

test("missingForGptlive: OpenAI, the Twilio keys and number, and the public URL, named plainly", () => {
  const url = config.publicUrl;
  try {
    Object.assign(config, { publicUrl: "" });
    assert.deepEqual(gl.missingForGptlive(), ["OPENAI_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "REASON_PUBLIC_URL"]);
    on();
    config.publicUrl = url;
    assert.deepEqual(gl.missingForGptlive(), []);
  } finally { config.publicUrl = url; }
});

test("GPT-Live as the provider: chosen by name, never wrapped, and every account's calls are GPT-Live", async () => {
  const { chooseCallProvider } = await import("../src/calls/choose.js");
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push(String(init.body)); return { ok: true, status: 201, json: async () => ({ sid: "CA9" }) }; };
  const p = chooseCallProvider({ provider: "gptlive", fetchImpl });
  assert.ok(p instanceof gl.GptLiveCallProvider);
  assert.equal(p.status().status, "not_connected", "no keys yet");
  const was = config.callProvider;
  try {
    config.callProvider = "gptlive";
    Object.assign(config, TWILIO);
    assert.equal(gl.withGptLive(p), p, "handed back as it is");
    assert.equal(p.status().status, "live");
    assert.equal(gl.gptliveFor(OTHER), true, "everyone, with no REASON_CALL_VOICE");
    assert.equal(gl.thirdPartyVoiceFor(OTHER), true);
    const row = ownerCall({ conversationId: OTHER });
    const out = await p.place({ to: "+13105550000", kind: "owner", conversationId: OTHER, callId: row.id });
    assert.deepEqual([out.ok, out.provider, out.externalId], [true, "gptlive", "gptlive:CA9"]);
    assert.ok(!out.openingWaits);
    assert.equal(posted.length, 1);
  } finally { config.callProvider = was; }
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
  assert.deepEqual(start.session.delegation, { type: "client", acknowledgement_delay_ms: 800 }, "room for code to cancel the voice's own 'let me check' (call 79)");
  assert.equal(start.session.audio.output.voice, "marin");
  assert.match(start.session.instructions, /You are the voice/);

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

// ---- call 56 (2026-10-31): the voice's own goodbye, and words cut off at the end ----

const LOUD = Buffer.alloc(160, 0x00).toString("base64");

async function goodbyeCall({ goodbye = true, cutoff = false } = {}) {
  const asked = [];
  on();
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const finished = [];
  const judge = async (q) => {
    asked.push(q);
    const v = q.kind === "goodbye" ? goodbye : cutoff;
    return typeof v === "function" ? v(q) : v;
  };
  const call = new gl.GptLiveCall({
    call: ownerCall(), twilio, openLive: () => live.socket, brain: async () => ({ text: "", tools: [] }), judge,
    now: timers.now, timers, finish: async (l) => { finished.push(l); },
  });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  const voice = (text) => {
    live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
    live.emit({ type: "session.output_transcript.delta", delta: text });
  };
  const them = (text) => live.emit({ type: "session.input_transcript.delta", delta: text });
  return { call, timers, twilio, live, finished, asked, voice, them };
}

test("mutual goodbye: their 'bye' is read by the model and the call hangs up once the voice's goodbye has played", async () => {
  const { call, timers, twilio, live, finished, asked, voice, them } = await goodbyeCall();
  them(" Okay, that was nice talking to you. Okay, bye.");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1, "their own sign-off is read (call 77)");
  assert.equal(asked[0].kind, "goodbye");
  assert.match(asked[0].transcript, /Them: Okay, that was nice talking to you\. Okay, bye\.$/);
  assert.equal(call.ending, true);
  await timers.advance(600);
  assert.equal(live.of("session.close").length, 0, "not before the voice's own goodbye");
  voice(" Bye, Omari, talk soon!");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1, "the voice's goodbye back is not read again");
  await timers.advance(2000);
  assert.ok(live.of("session.close").length, "it hangs up shortly after the goodbye");
  await timers.advance(3500);
  assert.equal(call.done, true);
  assert.equal(twilio.open(), false);
  assert.equal(finished[0].termination, "end_call (mutual goodbye)");
  const { endReasonOf } = await import("../src/calls/metrics.js");
  assert.equal(endReasonOf({ live: finished[0] }).reason, "end_call");
  assert.equal(finished[0].cutOff, null, "nothing said after the goodbye");
});

test("goodbye hang-up: waits for the voice's speech to finish, not for the silence the session keeps streaming", async () => {
  const { call, timers, live, them } = await goodbyeCall();
  them(" Okay, bye.");
  await timers.advance(1200);
  live.emit({ type: "session.output_transcript.delta", delta: " Bye, take care!" });
  // 1.5 s of the goodbye's speech, then silence frames for as long as the session runs.
  for (let i = 0; i < 75; i++) { live.emit({ type: "session.output_audio.delta", delta: LOUD }); await timers.advance(20); }
  const spokeUntil = timers.now();
  let closedAt = null;
  for (let i = 0; i < 400 && closedAt == null; i++) {
    live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
    await timers.advance(20);
    if (live.of("session.close").length) closedAt = timers.now();
  }
  assert.ok(closedAt != null, "hung up despite the endless silence frames");
  assert.ok(closedAt - spokeUntil < 2000, `hung up ${closedAt - spokeUntil} ms after the goodbye finished`);
  assert.ok(closedAt - spokeUntil >= 500, "not over the end of the goodbye");
  assert.equal(call.ending, true);
});

test("a 'bye' to someone in the room is not the end: the model says so and the call stays up", async () => {
  const { call, timers, live, asked, voice, them } = await goodbyeCall({ goodbye: false });
  them(" Bye Mum, see you later. Anyway, where was I?");
  await timers.advance(1200);
  voice(" Bye to her! You were asking about trains.");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  assert.ok(asked.length >= 1 && asked.every(q => q.kind === "goodbye"));
  await timers.advance(20_000);
  assert.equal(call.done, false);
  assert.equal(live.of("session.close").length, 0);
});

test("a read that cannot be made (no CLI) never hangs up", async () => {
  const { call, timers, voice, them } = await goodbyeCall({ goodbye: null });
  them(" Okay bye.");
  await timers.advance(1200);
  voice(" Bye!");
  await timers.advance(20_000);
  assert.equal(call.done, false);
});

test("'bye — oh wait': words while the goodbye hang-up waits are read again and call it off", async () => {
  let n = 0;
  const { call, timers, asked, voice, them } = await goodbyeCall({ goodbye: () => ++n === 1 });
  them(" Okay, bye.");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(call.ending, true);
  voice(" Bye!");
  await timers.advance(100);
  them(" Oh wait, one more thing, what time is my train?");
  await timers.advance(100);
  assert.equal(call.done, false, "held while their words settle");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS);
  assert.equal(asked.length, 2, "read again with their new words");
  assert.match(asked[1].transcript, /one more thing/);
  await timers.advance(20_000);
  assert.equal(call.done, false, "called off: the call carries on");
  assert.equal(call.ending, false);
});

test("call 77: Reason's 'Bye.' read as no, then their 'Bye' afterwards is read and the call hangs up", async () => {
  const { call, timers, live, finished, asked, voice, them } = await goodbyeCall({ goodbye: (q) => /Them: Bye$/.test(q.transcript) });
  them(" Wait, let me call you later");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  voice(" Sure.");
  them(" , okay");
  await timers.advance(300);
  voice(" All right, talk soon. Bye.");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  const before = asked.length;
  assert.ok(before >= 1);
  assert.equal(call.ending, false, "the model said not yet");
  await timers.advance(2000);
  them(" Bye");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(asked.length, before + 1, "their bye after Reason's goodbye is read (before: never, once a read had said no)");
  assert.match(asked.at(-1).transcript, /Reason: All right, talk soon\. Bye\.\nThem: Bye$/);
  assert.equal(call.ending, true);
  await timers.advance(gl.VOICE_BYE_WAIT_MS + 500);
  assert.ok(live.of("session.close").length, "hung up without waiting for another goodbye from the voice");
  await timers.advance(3500);
  assert.equal(finished[0].termination, "end_call (mutual goodbye)");
});

test("their 'bye-bye' alone is read; the voice's goodbye plays before the hang-up", async () => {
  const { call, timers, live, asked, voice, them } = await goodbyeCall();
  them(" Okay, bye-bye.");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1);
  assert.equal(call.ending, true);
  await timers.advance(500);
  voice(" Bye, Omari!");
  for (let i = 0; i < 50; i++) { live.emit({ type: "session.output_audio.delta", delta: LOUD }); await timers.advance(20); }
  const spokeUntil = timers.now();
  let closedAt = null;
  for (let i = 0; i < 200 && closedAt == null; i++) { await timers.advance(20); if (live.of("session.close").length) closedAt = timers.now(); }
  assert.ok(closedAt != null, "hung up");
  assert.ok(closedAt - spokeUntil >= 500 && closedAt - spokeUntil < 2000, `after the voice's goodbye (${closedAt - spokeUntil} ms)`);
});

test("words while a read is out start a fresh read at once; the older answer is overtaken", async () => {
  const answers = [];
  const { call, timers, asked, voice, them } = await goodbyeCall();
  call.judge = (q) => { asked.push(q); return new Promise(r => answers.push(r)); };
  them(" Okay bye.");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1);
  them(" Oh wait, actually, can you text me the address?");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 2, "not queued behind the first read");
  answers[0](true);
  await new Promise(r => setImmediate(r));
  assert.equal(call.ending, false, "the overtaken 'yes' does not hang up");
  answers[1](false);
  await timers.advance(10_000);
  assert.equal(call.done, false);
  voice(" Sure, sending it now.");
});

test("the voice's goodbye inside their settle never cancels the read their words are due (review)", async () => {
  const answers = [];
  const { call, timers, asked, voice, them } = await goodbyeCall();
  call.judge = (q) => { asked.push(q); return new Promise(r => answers.push(r)); };
  them(" Wait, let me call you later");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1, "read A out");
  them(" okay");
  await timers.advance(100);
  voice(" All right, talk soon. Bye.");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS);
  assert.equal(asked.length, 2, "their 'okay' is still read");
  assert.match(asked[1].transcript, /Them: Wait, let me call you later okay/);
  answers[0](false);
  answers[1](true);
  await new Promise(r => setImmediate(r));
  assert.equal(call.ending, true, "the latest read decides");
});

test("their words while the hang-up waits, then the voice's 'Bye!' inside the settle: read again, then hung up (review)", async () => {
  const { call, timers, live, asked, voice, them } = await goodbyeCall();
  them(" Okay, bye.");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(call.ending, true);
  them(" bye");
  await timers.advance(100);
  voice(" Bye!");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS);
  assert.equal(asked.length, 2, "re-read with their words");
  assert.equal(call.endHeld, false);
  await timers.advance(gl.VOICE_BYE_WAIT_MS + 1000);
  assert.ok(live.of("session.close").length, "hung up, not held forever");
});

test("at most two goodbye reads out at once; one more wanted waits for one to come back", async () => {
  const answers = [];
  const { call, timers, asked, voice, them } = await goodbyeCall();
  call.judge = (q) => { asked.push(q); return new Promise(r => answers.push(r)); };
  voice(" Okay, talk soon!");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1);
  for (const w of [" Okay bye.", " Oh wait.", " Actually, never mind."]) { them(w); await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50); await timers.advance(4000); }
  assert.equal(asked.length, 2, "a third read waits");
  answers[0](false);
  await new Promise(r => setImmediate(r));
  assert.equal(asked.length, 3, "the queued read starts with the latest words");
  assert.match(asked[2].transcript, /never mind/);
});

test("end() puts down the CLI kept for the goodbye read", async () => {
  const { call, timers } = await goodbyeCall();
  let cancelled = 0;
  call.byeReaderWanted = true;
  call.byeReader = { at: timers.now(), ready: Promise.resolve({ cancel: () => { cancelled++; } }) };
  const ended = call.end("caller hung up");
  await timers.advance(3500);
  await ended;
  assert.equal(cancelled, 1);
  assert.equal(call.byeReader, null);
  call.readyByeReader();
  assert.equal(call.byeReader, null, "none started after the call ended");
});

test("a no read made before the voice's own goodbye is read again with it (drive 11-08)", async () => {
  const answers = [];
  const { call, timers, asked, voice, them } = await goodbyeCall();
  call.judge = (q) => { asked.push(q); return new Promise(r => answers.push(r)); };
  them(" That was nice talking to you, bye");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1);
  await timers.advance(300);
  voice(" Bye! Take care, Omari.");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1, "not while the read is out");
  answers[0](false);
  await new Promise(r => setImmediate(r));
  assert.equal(asked.length, 2, "read again");
  assert.match(asked[1].transcript, /Reason: Bye! Take care, Omari\.$/);
  answers[1](true);
  await new Promise(r => setImmediate(r));
  assert.equal(call.ending, true);
});

test("a goodbye hang-up drops the line before waiting for the session's usage (no dead air)", async () => {
  const { call, timers, twilio, live, voice, them } = await goodbyeCall();
  them(" Okay, bye.");
  await timers.advance(gl.CALLER_BYE_SETTLE_MS + 50);
  voice(" Bye!");
  for (let i = 0; i < 200 && !live.of("session.close").length; i++) await timers.advance(20);
  assert.ok(live.of("session.close").length);
  assert.equal(twilio.open(), false, "the phone line is down while the usage is still awaited");
  assert.equal(call.endWhy, "goodbye");
});

test("no cue, no read: ordinary words before any goodbye never ask the model", async () => {
  const { timers, asked, voice, them } = await goodbyeCall();
  them(" What time is my train tomorrow?");
  await timers.advance(1200);
  voice(" Let me check that.");
  await timers.advance(5000);
  assert.equal(asked.length, 0);
});

test("the goodbye question: a sign-off without the word bye counts; 'oh wait', the room and Reason alone do not", () => {
  const p = gl.goodbyePrompt("Them: Wait, let me call you later\nReason: All right, talk soon. Bye.");
  assert.match(p, /^Them: Wait, let me call you later\nReason: All right, talk soon\. Bye\.\n\n/);
  assert.match(p, /any sign-off counts, with or without the word bye/);
  assert.match(p, /bye-bye/);
  assert.match(p, /let me call you later/);
  assert.match(p, /bye — oh wait/);
  assert.match(p, /someone else in the room/);
  assert.match(p, /only Reason has said goodbye and Them has not/);
});

test("soundsLikeFarewell picks their sign-offs too (only which lines to ask about)", () => {
  for (const s of ["Wait, let me call you back later.", "I gotta go.", "I'll let you go.", "Okay, I'll call you later"]) assert.ok(gl.soundsLikeFarewell(s), s);
  for (const s of ["Call the restaurant", "Go to the gym"]) assert.ok(!gl.soundsLikeFarewell(s), s);
});

test("not while Reason is still working on something: no goodbye read with a delegation pending", async () => {
  const { call, timers, asked, voice, them } = await goodbyeCall();
  them(" Can you check my train? Bye for now.");
  call.pending.set("hold", {});
  await timers.advance(1200);
  voice(" Sure, bye for now!");
  await timers.advance(5000);
  assert.equal(asked.length, 0);
  assert.equal(call.done, false);
});

test("cut off: words after Reason's goodbye that start something new are flagged for the after-call text", async () => {
  const { timers, finished, asked, voice, them } = await goodbyeCall({ cutoff: true });
  them(" Okay, bye.");
  await timers.advance(1200);
  voice(" Bye, take care!");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  await timers.advance(1200);
  them(" Oh actually what time does the");
  await timers.advance(30_000);
  const q = asked.find(a => a.kind === "cutoff");
  assert.equal(q.late, "Oh actually what time does the");
  assert.deepEqual(finished[0].cutOff, { words: "Oh actually what time does the" });
});

test("call 56's ', bye' after Reason's 'Bye.' is only the goodbye finishing: no cut-off text", async () => {
  const { call, timers, finished, asked, voice, them } = await goodbyeCall({ goodbye: null, cutoff: false });
  them(" Okay, bye.");
  await timers.advance(1200);
  voice(" Bye.");
  await timers.advance(1500);
  them(" , bye");
  await timers.advance(500);
  const ended = call.end("caller hung up");
  await timers.advance(3500);
  await ended;
  assert.equal(asked.find(a => a.kind === "cutoff").late, "bye");
  assert.equal(finished[0].cutOff, null);
});

test("cut off with no words yet: their speech in the last moments of Reason's hang-up counts", async () => {
  const { timers, twilio, finished, voice, them } = await goodbyeCall();
  them(" Okay, bye.");
  await timers.advance(1200);
  voice(" Bye!");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  // Speech on their side right up to the hang-up, no transcript of it yet.
  for (let i = 0; i < 60 && !finished.length; i++) { twilio.say({ event: "media", media: { payload: LOUD } }); await timers.advance(20); }
  await timers.advance(4000);
  assert.deepEqual(finished[0].cutOff, { words: "" });
});

test("after-call note: a cut-off asks what they were saying; an offered 'later' check gets set up or owned", async () => {
  const { ownerEvent } = await import("../src/calls/postcall.js");
  const row = db.getCall(C, ownerCall().id);
  const plain = ownerEvent({ row });
  assert.match(plain, /said yes to something you offered to do later .* set it up now with your tools/);
  assert.doesNotMatch(plain, /cut off/);
  assert.doesNotMatch(ownerEvent({ row: { ...row, provider: "bland" } }), /offered to do later/, "another provider's calls unchanged");
  const cut = ownerEvent({ row, live: { cutOff: { words: 'Oh "actually" what' } } });
  assert.match(cut, /Something IS owed: they started saying something just as the call ended \(all that came through: "Oh 'actually' what"\)/);
  assert.match(cut, /sounded like they were saying something as you hung up, and ask what it was/);
  assert.match(ownerEvent({ row, live: { cutOff: { words: "" } } }), /just as the call ended and it was cut off/);
});

test("soundsLikeFarewell only picks lines worth asking about", () => {
  for (const s of ["Bye.", "Okay, bye-bye!", "Talk soon!", "Take care, Omari.", "Have a good night"]) assert.ok(gl.soundsLikeFarewell(s), s);
  for (const s of ["Checking.", "It ended in 1865.", "Byelaws are local rules."]) assert.ok(!gl.soundsLikeFarewell(s), s);
});

test("judgeEnding: the model's boolean, or null when it cannot be asked — never a guess", async () => {
  assert.equal(await gl.judgeEnding({ kind: "goodbye", transcript: "x" }, { ask: async () => ({ ended: true }) }), true);
  assert.equal(await gl.judgeEnding({ kind: "cutoff", transcript: "x", late: "y" }, { ask: async () => ({ cut_off: false }) }), false);
  assert.equal(await gl.judgeEnding({ kind: "goodbye", transcript: "x" }, { ask: async () => { throw new Error("down"); } }), null);
  assert.equal(await gl.judgeEnding({ kind: "goodbye", transcript: "x" }, { ask: async () => ({}) }), null);
  assert.equal(await gl.judgeEnding({ kind: "goodbye", transcript: "x" }), null, "no subscription CLI in the suite");
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

// ---------- speaking first: the session warmed up while it rang ----------

const loud = Buffer.alloc(160, gl.pcmToUlaw(9000)).toString("base64");

function warmUp({ row = ownerCall() } = {}) {
  on();
  const timers = fakeTimers();
  const live = fakeLive();
  const lines = [];
  const w = gl.prewarm(row, { openLive: () => live.socket, log: (o) => lines.push(o), now: timers.now, timers });
  live.open();
  return { w, live, timers, row, lines };
}

test("warm: the greeting is asked for at once, said into silence while it rings, then the session is paused", async () => {
  const { live, timers, lines } = warmUp();
  assert.match(live.of("session.start")[0].session.input[0].content[0].text, /Hey Omari, it's Reason/);
  assert.equal(live.of("session.input_audio.append").length, 0, "nothing goes in before the session has started");
  live.emit({ type: "session.started", session: { id: "live_w" } });
  assert.equal(live.of("session.commentary.append").length, 1, "the greeting asked for once more, as the docs say");
  await timers.advance(800);
  assert.ok(live.of("session.input_audio.append").length >= 8, "fed silence so its clock runs");
  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  live.emit({ type: "session.output_audio.delta", delta: loud });
  live.emit({ type: "session.output_transcript.delta", delta: "Hey Omari, it's Reason." });
  await timers.advance(1500);
  const fed = live.of("session.input_audio.append").length;
  await timers.advance(3000);
  assert.equal(live.of("session.input_audio.append").length, fed, "paused once the greeting was said");
  assert.equal(lines.find(l => "gptlive_warm" in l).why, "greeted");
});

test("warm: picked up — the greeting plays at once on the same session, with no second session and no second greeting", async () => {
  const { w, live, timers, row } = warmUp();
  live.emit({ type: "session.started", session: { id: "live_w" } });
  await timers.advance(300);
  live.emit({ type: "session.output_audio.delta", delta: ULAW_FRAME });
  live.emit({ type: "session.output_audio.delta", delta: loud });
  live.emit({ type: "session.output_transcript.delta", delta: "Hey Omari, it's Reason." });
  await timers.advance(2000);
  const twilio = fakeTwilio();
  let opened = 0;
  const lines = [];
  const call = new gl.GptLiveCall({ call: row, twilio, warm: gl.takeWarm(row.id), openLive: () => { opened++; return fakeLive().socket; }, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  assert.equal(gl.takeWarm(row.id), null, "taken once");
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  assert.equal(opened, 0);
  const media = twilio.sent.filter(m => m.event === "media");
  assert.equal(media.length, 1, "the leading silence is not played, the greeting is");
  assert.equal(media[0].media.payload, loud);
  assert.equal(lines.find(l => "gptlive_first_voice" in l).ms, 0, "first word the moment the stream starts");
  assert.equal(live.of("session.commentary.append").length, 1, "no second greeting");
  twilio.say({ event: "media", media: { payload: ULAW_FRAME } });
  assert.equal(live.of("session.input_audio.append").at(-1).audio, ULAW_FRAME, "their audio goes in from here");
  live.emit({ type: "session.output_audio.delta", delta: loud });
  assert.equal(twilio.sent.filter(m => m.event === "media").length, 2, "and the live session carries on into the line");
  assert.equal(call.started, true);
  assert.equal(w.call, call);
});

test("warm: a greeting that does not come is asked for once more; an unanswered call closes the session", async () => {
  const { live, timers, row, lines } = warmUp();
  live.emit({ type: "session.started", session: { id: "live_w" } });
  await timers.advance(gl.WARM_RETRY_MS + 200);
  assert.equal(live.of("session.commentary.append").length, 2);
  await timers.advance(gl.WARM_FEED_MAX_MS);
  const fed = live.of("session.input_audio.append").length;
  assert.ok(fed <= gl.WARM_FEED_MAX_MS / 100 + 1, "stops feeding: an unanswered phone costs seconds");
  const url = `${config.publicUrl}${gl.STATUS_PATH}${row.webhook_token}`;
  const params = { CallSid: "CA9", CallStatus: "no-answer", CallDuration: "0" };
  await gl.statusRequest({ token: row.webhook_token, rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, settle: settleCall });
  assert.equal(live.of("session.close").length, 1);
  assert.equal(gl.takeWarm(row.id), null);
  assert.match(lines.find(l => "gptlive_warm_dropped" in l).why, /no-answer/);
});

test("warm: a call that opens silent never gets a warm session", () => {
  on();
  const row = ownerCall({ announcement: "" });
  let opened = 0;
  assert.equal(gl.prewarm(row, { openLive: () => { opened++; return fakeLive().socket; } }), null);
  assert.equal(opened, 0);
});

// ---------- who it is, and who it is talking to (REASON_CALL_IDENTITY, owner-only rollout) ----------

const AMA_CALL = (over = {}) => db.createCall(OTHER, { provider: "gptlive", toNumber: "+13105550000", isOwner: true, goal: "g", facts: [], announcement: "hey Ama", state: "placing", ...over });
const profiles = () => {
  db.saveProfile(C, "**Omari**\n- Commutes on the 2 and 5 trains", []);
  db.saveProfile(OTHER, "**Ama**\n- Allergic to peanuts", []);
};
const vp = await import("../src/calls/voice-prompt.js");
await voice.prime();

test("the live prompt is call 53's (#290), word for word, plus only the gated identity and maker lines", () => {
  on({ callIdentity: "owner" });
  profiles();
  const s = gl.sessionConfig({ ...gl.whoFor(db.getCall(C, ownerCall().id)), greeting: "hey" }).instructions;
  const lines = s.split("\n");
  assert.equal(lines[0], "You are the voice of Reason, Omari's personal assistant, on a phone call with Omari.");
  assert.match(lines[1], /^Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant, and they're Omari, the person you work for\. Where they are, or any other question, goes to Reason;/);
  assert.match(lines[2], /^You were made by Saafi Interactions Lab;/);
  assert.equal(lines[3], "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.");
  const end = lines.indexOf("Stop speaking when they talk over you, and listen.");
  assert.equal(end, 22, "call 53's ten lines + identity + maker + call 56's four + call 76's three hearing lines + the four own-call lines (2026-11-01 call 68, 2026-11-08 call 76)");
  for (const l of [...gl.CALL56_LINES, ...gl.HEARING_LINES, ...gl.OWN_CALL_LINES]) assert.ok(lines.includes(l));
  assert.match(lines.slice(end + 1).join("\n"), /^PRE-CALL BRIEF/, "only the pre-call brief after call 53's last line");
  assert.doesNotMatch(s, /2 and 5 trains|How you sound|You rang|New York/, "no profile, no tone section, none of #293's additions");
  assert.equal(config.gptliveVoice, "marin", "the default voice is call 53's");
});

test("identity off (flag unset): call 53's prompt plus the maker line, nothing else", () => {
  on({ callIdentity: false });
  const s = gl.liveInstructions(gl.whoFor(db.getCall(C, ownerCall().id)));
  assert.doesNotMatch(s, /ask who you are/);
  assert.equal(s.split("\n").indexOf("Stop speaking when they talk over you, and listen."), 21);
});

test("identity =owner: another user's call has no identity line and nothing of the operator's", () => {
  on({ callIdentity: "owner" });
  profiles();
  const s = gl.liveInstructions(gl.whoFor(AMA_CALL()));
  assert.match(s, /^You are the voice of Reason, Ama's personal assistant/);
  assert.doesNotMatch(s, /ask who you are|\bOmari\b|2 and 5 trains|peanuts/);
  assert.equal(vp.callIdentityFor(OTHER), false);
  assert.equal(vp.callIdentityFor(C), true);
});

test("isolation, identity =on: user B's voice gets B's name only, never user A's (and no profile at all)", () => {
  on({ callIdentity: true });
  profiles();
  const s = gl.liveInstructions(gl.whoFor(AMA_CALL()));
  assert.match(s, /they're Ama, the person you work for/);
  assert.doesNotMatch(s, /\bOmari\b|2 and 5 trains|peanuts/);
  const NEW = "sendblue:+13105550001";
  db.upsertAccount({ conversationId: NEW, channel: "sendblue", address: "+13105550001", name: "the person I work for", isOperator: false });
  const n = gl.liveInstructions(gl.whoFor(db.createCall(NEW, { provider: "gptlive", toNumber: "+13105550001", isOwner: true, goal: "g", facts: [], announcement: "hey", state: "placing" })));
  assert.match(n, /you don't have their name saved yet/);
  assert.doesNotMatch(n, /\bOmari\b|\bAma\b|them's/);
});

test("a third-party call: 'I'm Reason, calling for Omari', and none of his profile", () => {
  on({ callIdentity: "owner" });
  profiles();
  const s = gl.liveInstructions(gl.whoFor(db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "book", facts: [], announcement: "", state: "placing" })));
  assert.match(s, /you're Reason, an AI assistant calling for Omari/);
  assert.doesNotMatch(s, /2 and 5 trains|New York|peanuts/);
});

test("Reason's call turn (contextFor), isolation: user B's whole call context (system + messages) has none of user A's name or profile", () => {
  for (const flag of [false, "owner", true]) {
    on({ callIdentity: flag });
    profiles();
    db.saveConversation(C, [{ role: "user", content: "remind me about the 2 and 5 trains" }]);
    const ctx = voice.contextFor({ call: db.getCall(OTHER, AMA_CALL().id), kind: "owner" });
    const all = JSON.stringify([ctx.system, ctx.messages]);
    assert.match(all, /peanuts/, `${flag}: her own profile`);
    assert.doesNotMatch(all, /\bOmari\b|2 and 5 trains/, `${flag}: none of user A's`);
    assert.equal(/You are Reason — Ama's own Reason/.test(ctx.system), flag === true, `${flag}: identity only when on for her`);
    const tp = voice.contextFor({ call: db.createCall(OTHER, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "book a table", facts: [], announcement: "", state: "in_progress" }), kind: "third_party" });
    assert.doesNotMatch(JSON.stringify([tp.system, tp.messages]), /peanuts|\bOmari\b|2 and 5/, `${flag}: a business hears none of either`);
  }
});

test("Reason's call turn (contextFor), =owner: the operator's call carries the identity lines; unset, the frame is as it always was", () => {
  on({ callIdentity: "owner" });
  const own = voice.contextFor({ call: db.getCall(C, ownerCall().id), kind: "owner" });
  assert.match(own.system, /You are Reason — Omari's own Reason/);
  const tp = voice.contextFor({ call: db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "book a table", facts: [], announcement: "", state: "in_progress" }), kind: "third_party" });
  assert.match(tp.system, /you're Reason, an AI assistant calling for Omari/);
  assert.doesNotMatch(vp.ownerCallFrame({ name: "Ama" }), /own Reason/);
  assert.match(vp.ownerCallFrame({ name: "Ama" }), /^Ama is on the phone with you right now\. .* so do not introduce yourself, do not ask who is calling/);
});

test("who made Reason: Saafi Interactions Lab by default, one value everywhere, and nothing invented", async () => {
  const { systemFor } = await import("../src/agent.js");
  const maker = await import("../src/maker.js");
  config.makerName = "Saafi Interactions Lab";
  for (const me of [{ name: "Omari", isOperator: true }, { name: "Ama", isOperator: false }, { name: "the person I work for" }]) {
    const s = systemFor(me);
    assert.match(s, /You were made by Saafi Interactions Lab\./);
    assert.doesNotMatch(s, /Omarion|Nyarko|smart guy/);
  }
  assert.match(maker.makerLine(), /Saafi Interactions Lab/);
  config.makerName = "Acme Labs";
  try { assert.match(systemFor({ name: "Ama" }), /You were made by Acme Labs\./, "REASON_MAKER overrides"); } finally { config.makerName = "Saafi Interactions Lab"; }
});

test("the maker is exactly 'Saafi Interactions Lab' (Interactions plural, Lab singular) by default, and every prompt says it so", async () => {
  const { config: fresh } = await import("../src/config.js");
  const maker = await import("../src/maker.js");
  const { systemFor } = await import("../src/agent.js");
  const saved = fresh.makerName;
  try {
    // The default as config.js builds it with no REASON_MAKER set.
    const src = (await import("node:fs")).readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
    assert.match(src, /makerName: String\(process\.env\.REASON_MAKER \?\? ""\)\.trim\(\) \|\| "Saafi Interactions Lab",/);
    fresh.makerName = "Saafi Interactions Lab";
    assert.equal(maker.makerName(), "Saafi Interactions Lab");
    for (const s of [systemFor({ name: "Ama" }), maker.makerLine(), maker.makerRule()]) {
      assert.ok(s.includes("Saafi Interactions Lab"), s.slice(0, 80));
      assert.doesNotMatch(s, /Saafi Interaction Labs|Saafi Interactions Labs|Saafi Interaction Lab\b/);
    }
  } finally { fresh.makerName = saved; }
});

test("no model-facing prompt anywhere says Omarion Nyarko (texts, both call voices, onboarding, GPT-Live)", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join: j } = await import("node:path");
  // Every string Reason or a model is ever handed lives under src/ (prompts, pages, cards, vCard, emails);
  // comments may mention people, a string literal may not.
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = j(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(m?js|html|json|txt|css)$/.test(f)) files.push(p); } };
  walk(new URL("../src", import.meta.url).pathname);
  walk(new URL("../assets", import.meta.url).pathname);
  const hits = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // The repo's own address (github.com/omarionnn/pa, the user-agent) is a link, not a credit.
      if (/\bOmarion\b|Nyarko/i.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
  // And the built prompts themselves.
  const { systemFor } = await import("../src/agent.js");
  const vpm = await import("../src/calls/voice-prompt.js");
  on({ callIdentity: true });
  profiles();
  const texts = [
    systemFor({ name: "Ama", isOperator: false }), systemFor({ name: "Omari", isOperator: true }),
    voice.contextFor({ call: db.getCall(C, ownerCall().id), kind: "owner" }).system,
    voice.contextFor({ call: AMA_CALL(), kind: "owner" }).system,
    gl.liveInstructions(gl.whoFor(db.getCall(C, ownerCall().id))),
    vpm.thirdPartyFrame({ identity: true, ownerName: "Ama", goal: "g", rules: ["r"] }),
  ];
  for (const t of texts) assert.doesNotMatch(t, /Omarion|Nyarko/);
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

test("inbound on owner: the operator's own number gets the stream; another user gets their own Reason, a stranger the pitch, nothing is redirected", () => {
  on({ callVoice: "owner" });
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
  assert.match(theirs.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//);
  const amaRow = db.db.prepare("SELECT * FROM calls WHERE provider = 'gptlive' AND conversation_id = ?").get(OTHER);
  assert.ok(amaRow, "her own call, on her own conversation");
  assert.equal(amaRow.is_owner, 1);
  const before = db.db.prepare("SELECT COUNT(*) n FROM calls").get().n;
  const stranger = ring("+14155550177");
  assert.match(stranger.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\/[0-9a-f]{32}"/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, before, "no call row for a stranger");
  for (const out of [mine, theirs, stranger]) assert.doesNotMatch(out.body, /<Redirect|eleven/i);
});

test("inbound with GPT-Live not set up: rejected, never redirected", () => {
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  const ring = (from) => {
    const params = { CallSid: `CA_${from}`, From: from, To: "+16562167455" };
    return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) } });
  };
  // Flag off: no route listened for.
  Object.assign(config, { twilioToken: TWILIO.twilioToken });
  assert.match(ring("+12025551234").body, /^<\?xml[^>]*\?><Response><Reject\/><\/Response>$/);
  // Flag on, a key missing.
  on({ openaiKey: "" });
  for (const from of ["+12025551234", "+13105550000", "+14155550166"]) {
    const out = ring(from);
    assert.equal(out.status, 200);
    assert.match(out.body, /<Reject\/>/);
    assert.doesNotMatch(out.body, /<Redirect|<Stream/);
  }
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 0, "no row for a call nobody can answer");
});

test("inbound everyone: each caller gets their own place — user, operator, blocked, paused, stranger, withheld, capped, ring-back", async () => {
  on();
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  const ring = (from, sid = `CA_${from}`) => {
    const params = { CallSid: sid, From: from, To: "+16562167455" };
    return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) } });
  };
  // Another user calling in: their own Reason, on THEIR conversation.
  const ama = ring("+13105550000");
  assert.match(ama.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//);
  const amaRow = db.db.prepare("SELECT * FROM calls WHERE provider = 'gptlive' AND conversation_id = ?").get(OTHER);
  assert.ok(amaRow, "a row on her own conversation");
  assert.equal(amaRow.is_owner, 1);
  assert.equal(amaRow.direction, "in");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls WHERE conversation_id = ?").get(C).n, 0, "nothing on the operator's");
  assert.match(ring("+12025551234").body, /<Stream/, "the operator too");

  // Blocked / paused / removed: the neutral line, said by Twilio, hung up; no stream, no row, no name.
  db.blockNumber("+14155550111");
  const blocked = ring("+14155550111");
  assert.match(blocked.body, /<Say voice="Polly\.Amy-Neural">Hi, you've reached Reason\. I can't take calls from this number right now\. Thanks, bye\.<\/Say><Hangup\/>/);
  assert.doesNotMatch(blocked.body, /Omari|Stream/);
  db.upsertAccount({ conversationId: "sendblue:+14155550122", channel: "sendblue", address: "+14155550122", name: "Kofi", isOperator: false });
  db.db.prepare("UPDATE accounts SET state = 'paused' WHERE conversation_id = ?").run("sendblue:+14155550122");
  assert.match(ring("+14155550122").body, /I can't take calls from this number right now/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls WHERE conversation_id = ?").get("sendblue:+14155550122").n, 0);

  // A stranger: the pitch stream (no call row), kept against their number.
  const before = db.db.prepare("SELECT COUNT(*) n FROM calls").get().n;
  const stranger = ring("+14155550199", "CA_stranger");
  assert.match(stranger.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\/[0-9a-f]{32}"/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, before, "no call row for a stranger");
  const kept = db.db.prepare("SELECT * FROM stranger_calls WHERE phone = ?").get("+14155550199");
  assert.equal(kept.external_id, "gptlive:CA_stranger");
  // Withheld: a stranger with nothing kept.
  assert.match(ring("anonymous").body, /<Stream/);

  // Over the day's cap: one line, no stream.
  config.maxCallsPerDay = 1;
  try {
    const capped = ring("+13105550000");
    assert.match(capped.body, /<Say[^>]*>hey — that's \d+ calls today.*<\/Say><Hangup\/>/);
  } finally { config.maxCallsPerDay = 10; }

  // owner mode: another user's call is still her own Reason on GPT-Live, never redirected.
  config.callVoice = "owner";
  const owned = ring("+13105550000", "CA_owner_mode");
  assert.match(owned.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\//);
  assert.doesNotMatch(owned.body, /<Redirect/);
  assert.equal(db.db.prepare("SELECT conversation_id FROM calls WHERE external_id = 'gptlive:CA_owner_mode'").get()?.conversation_id, OTHER);
  config.callVoice = "gptlive";
  // Anything failing while it rings is rejected at once (busy to the caller), never left hanging or redirected.
  const sig = (p) => ({ "x-twilio-signature": gl.twilioSignature(url, p) });
  const p2 = { CallSid: "CA_boom", From: "+13105550000", To: "+16562167455" };
  db.db.exec("ALTER TABLE blocked_numbers RENAME TO blocked_numbers_x");
  try {
    const boom = gl.inboundTwiml({ rawBody: new URLSearchParams(p2).toString(), headers: sig(p2) }).body;
    assert.match(boom, /<Reject\/>/);
    assert.doesNotMatch(boom, /<Redirect/);
  } finally { db.db.exec("ALTER TABLE blocked_numbers_x RENAME TO blocked_numbers"); }
  // Missing keys: rejected, not redirected.
  config.openaiKey = "";
  const away = ring("+13105550000").body;
  assert.match(away, /<Reject\/>/);
  assert.doesNotMatch(away, /<Redirect/);
});

test("a stranger's stream: the pitch persona, answers from the no-tools pitch turn, words kept, no row or audio", async () => {
  on();
  const { resetTurns } = await import("../src/calls/stranger.js");
  resetTurns();
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  const params = { CallSid: "CA_s2", From: "+14155550188", To: "+16562167455" };
  const out = gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) } });
  const token = out.body.match(/stream\/([0-9a-f]{32})/)[1];
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const asked = [];
  const generate = async function* ({ system, messages, tools }) {
    asked.push({ system, messages, tools });
    yield { type: "text", text: "It's a personal assistant you text. Have a look at heyreason.com. Bye! END" };
  };
  const call = gl.acceptStream({ token, socket: twilio, openLive: () => live.socket, generate, log: () => {} });
  assert.ok(call, "the stranger token is accepted once");
  call.timers = timers; call.now = timers.now; call.judge = async () => null;
  twilio.say({ event: "start", start: { streamSid: "MZ9", callSid: "CA_s2" } });
  live.open();
  const start = live.of("session.start")[0];
  assert.match(start.session.instructions, /not a Reason user/);
  assert.match(start.session.instructions, /Saafi Interactions Lab/);
  assert.doesNotMatch(start.session.instructions, /Omari/);
  live.emit({ type: "session.started", session: { id: "live_s" } });
  assert.match(live.of("session.commentary.append")[0].content, /Hi, this is Reason, a personal AI assistant/);
  live.emit({ type: "session.output_transcript.delta", delta: "Hi, this is Reason, like a friend who's weirdly good at getting things done." });
  assert.equal(live.of("session.instructions.append").length, 0, "the intro's own words never trip the guard");
  live.emit({ type: "session.input_transcript.delta", delta: " What is this?" });
  live.emit({ type: "session.delegation.created", delegation: { id: "d1" } });
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].tools, [], "no tools");
  assert.match(asked[0].system, /You work for nobody on this call/);
  const result = live.of("session.commentary.append").find(e => e.delegation_id === "d1");
  assert.match(result.content, /hey reason dot com/);
  assert.doesNotMatch(result.content, /END/);
  assert.equal(gl.acceptStream({ token, socket: fakeTwilio(), log: () => {} }), null, "never twice");
  const ended = call.end("caller hung up");
  await timers.advance(3500);
  await ended;
  const kept = db.db.prepare("SELECT * FROM stranger_calls WHERE phone = ?").get("+14155550188");
  assert.match(kept.summary, /What is this/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls WHERE to_number = ?").get("+14155550188").n, 0);
});

// ---------- the report ----------

test("the call report splits its numbers by voice", async () => {
  const { buildCallReport, formatCallReport } = await import("../src/calls/report.js");
  const a = db.createCall(C, { provider: "bland", toNumber: "+12025551234", isOwner: true, goal: "g", facts: [] });
  const b = ownerCall();
  db.recordCallTurn({ callId: a.id, conversationId: C, msgCount: 1, startedAt: 1, firstContentMs: 1200, firstRealMs: 3000 });
  db.recordCallTurn({ callId: b.id, conversationId: C, msgCount: 1, startedAt: 1, firstContentMs: 400, firstRealMs: 2500 });
  const r = buildCallReport(db.db);
  assert.equal(r.voices.bland.heard_p50_ms, 1200);
  assert.equal(r.voices.gptlive.heard_p50_ms, 400);
  assert.match(formatCallReport(r), /voice gptlive: calls 1 · turns 1/);
});
