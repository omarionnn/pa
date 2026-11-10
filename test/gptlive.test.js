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
const { readPlain } = await import("../src/restfiles.js"); // a file sealed with REASON_ENCRYPT_REST2=on reads plain
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
  assert.match(start.session.instructions, /You are Reason, Omari's personal assistant/);

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
  assert.equal(readPlain(l.recording.path).toString("latin1", 0, 4), "RIFF");
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
  // The voice goes out one piece behind, its last sound faded when nothing follows (call 80).
  await timers.advance(gl.FADE_FLUSH_MS);
  const media = twilio.sent.filter(m => m.event === "media");
  assert.equal(media.length, 1, "the leading silence is not played, the greeting is");
  assert.equal(media[0].media.payload, gl.fadeOut(loud));
  assert.equal(lines.find(l => "gptlive_first_voice" in l).ms, 0, "first word the moment the stream starts");
  assert.equal(live.of("session.commentary.append").length, 1, "no second greeting");
  twilio.say({ event: "media", media: { payload: ULAW_FRAME } });
  assert.equal(live.of("session.input_audio.append").at(-1).audio, ULAW_FRAME, "their audio goes in from here");
  live.emit({ type: "session.output_audio.delta", delta: loud });
  await timers.advance(gl.FADE_FLUSH_MS);
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

test("prering (hold): started while it rings, nothing fed and nothing said; greets once on pickup, as a cold call", async () => {
  on();
  const row = ownerCall();
  const timers = fakeTimers();
  const live = fakeLive();
  const lines = [];
  gl.prewarm(row, { hold: true, openLive: () => live.socket, log: (o) => lines.push(o), now: timers.now, timers });
  live.open();
  assert.match(live.of("session.start")[0].session.input[0].content[0].text, /Hey Omari, it's Reason/, "the call's own session.start, at dial");
  live.emit({ type: "session.started", session: { id: "live_h" } });
  await timers.advance(8000);
  assert.equal(live.of("session.input_audio.append").length, 0, "never fed while it rings");
  assert.equal(live.of("session.commentary.append").length, 0, "never asked to greet while it rings");
  assert.ok(lines.some(l => "gptlive_prering_ready" in l));
  const twilio = fakeTwilio();
  let opened = 0;
  new gl.GptLiveCall({ call: row, twilio, warm: gl.takeWarm(row.id), openLive: () => { opened++; return fakeLive().socket; }, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  assert.equal(opened, 0, "no second session");
  assert.equal(live.of("session.commentary.append").length, 1, "the greeting asked for at pickup, once");
  twilio.say({ event: "media", media: { payload: ULAW_FRAME } });
  assert.equal(live.of("session.input_audio.append").at(-1).audio, ULAW_FRAME, "their audio goes in from the first frame");
  live.emit({ type: "session.output_audio.delta", delta: loud });
  live.emit({ type: "session.output_audio.delta", delta: loud });
  // ≥1: a build that holds the newest frame for a fade (call80-fixes) sends it one frame later.
  assert.ok(twilio.sent.filter(m => m.event === "media").length >= 1);
});

test("prering (hold): a session not started by pickup still greets when it starts; no-answer closes it", async () => {
  on();
  const row = ownerCall();
  const timers = fakeTimers();
  const live = fakeLive();
  gl.prewarm(row, { hold: true, openLive: () => live.socket, now: timers.now, timers });
  live.open();
  const twilio = fakeTwilio();
  new gl.GptLiveCall({ call: row, twilio, warm: gl.takeWarm(row.id), openLive: () => fakeLive().socket, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  assert.equal(live.of("session.commentary.append").length, 0);
  live.emit({ type: "session.started", session: { id: "live_h2" } });
  assert.equal(live.of("session.commentary.append").length, 1, "greets once it is up");

  const row2 = ownerCall();
  const live2 = fakeLive();
  const lines = [];
  gl.prewarm(row2, { hold: true, openLive: () => live2.socket, log: (o) => lines.push(o), now: timers.now, timers });
  live2.open();
  live2.emit({ type: "session.started", session: { id: "live_h3" } });
  const url = `${config.publicUrl}${gl.STATUS_PATH}${row2.webhook_token}`;
  const params = { CallSid: "CA9", CallStatus: "no-answer", CallDuration: "0" };
  await gl.statusRequest({ token: row2.webhook_token, rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, settle: settleCall });
  assert.equal(live2.of("session.close").length, 1);
  assert.equal(gl.takeWarm(row2.id), null);
});

test("prering: the dial waits for the held session to start (capped), then rings; slow or failed never blocks it", async () => {
  on({ gptlivePrering: true, gptlivePreringWaitMs: 2000, gptlivePreringMemoryMs: 0 });
  try {
    const row = ownerCall();
    const live = fakeLive();
    const posted = [];
    const fetchImpl = async (url, init) => { posted.push({ url: String(url), at: Date.now(), started: live.of("session.start").length }); return { ok: true, status: 201, json: async () => ({ sid: "CA_dial" }) }; };
    const lines = [];
    const dialing = gl.dialGptLive({ conversationId: C, callId: row.id, to: "+12025551234", kind: "owner", log: (o) => lines.push(o) }, { fetchImpl, openLive: () => live.socket });
    await new Promise(r => setImmediate(r));
    assert.equal(posted.length, 0, "not dialled while the session is starting");
    live.open();
    live.emit({ type: "session.started", session: { id: "live_d" } });
    const out = await dialing;
    assert.equal(out.ok, true);
    assert.equal(posted.length, 1, "then dialled");
    assert.equal(posted[0].started, 1, "with the call's own session.start already sent");
    assert.equal(lines.find(l => "gptlive_prering_dial_wait" in l).up, true);
    gl.dropWarm(row.id, "test over");

    // A session that never starts: the dial goes after the cap, and the call opens the old way on the stream.
    config.gptlivePreringWaitMs = 40;
    const row2 = ownerCall();
    const silent = fakeLive();
    const t0 = Date.now();
    const out2 = await gl.dialGptLive({ conversationId: C, callId: row2.id, to: "+12025551234", kind: "owner", log: (o) => lines.push(o) }, { fetchImpl, openLive: () => silent.socket });
    assert.equal(out2.ok, true);
    assert.ok(Date.now() - t0 < 1000, "the cap holds");
    assert.equal(lines.filter(l => "gptlive_prering_dial_wait" in l).at(-1).up, false);
    gl.dropWarm(row2.id, "test over");
  } finally { Object.assign(config, { gptlivePrering: false, gptlivePreringWaitMs: 2000, gptlivePreringMemoryMs: 800 }); }
});

test("prering: picked up before the session started — their hello is kept from the first frame and goes in after the greeting ask", async () => {
  on();
  const row = ownerCall();
  const timers = fakeTimers();
  const live = fakeLive();
  const lines = [];
  gl.prewarm(row, { hold: true, openLive: () => live.socket, now: timers.now, timers });
  live.open();
  const twilio = fakeTwilio();
  new gl.GptLiveCall({ call: row, twilio, warm: gl.takeWarm(row.id), openLive: () => fakeLive().socket, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  for (let i = 0; i < 5; i++) twilio.say({ event: "media", media: { payload: loud } });
  assert.equal(live.of("session.input_audio.append").length, 0, "nothing sent before session.started");
  live.emit({ type: "session.started", session: { id: "live_e" } });
  const order = live.sent.map(e => e.type).filter(t => t === "session.commentary.append" || t === "session.input_audio.append");
  assert.equal(order[0], "session.commentary.append", "the greeting asked for first");
  assert.equal(live.of("session.input_audio.append").length, 5, "then every frame they said before it was up");
  assert.equal(lines.find(l => "gptlive_early_audio" in l).ms, 100);
});

test("inbound pre-open: only after routing — a known caller's session opens held (same session as the stream's), never for blocked, stranger or capped; the row stays unverified", async () => {
  on({ gptliveInboundPreopen: true, gptlivePreringMemoryMs: 0 });
  try {
    const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
    const opened = [];
    const openLive = () => { const l = fakeLive(); opened.push(l); return l.socket; };
    const ring = (from, sid = `CA_${from}`) => {
      const params = { CallSid: sid, From: from, To: "+16562167455" };
      return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, openLive });
    };
    const ama = ring("+13105550000");
    assert.match(ama.body, /<Connect><Stream/, "TwiML straight back: the webhook never waits on the session");
    assert.equal(opened.length, 1, "her session opened while it rings");
    const row = db.db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY id DESC").get(OTHER);
    assert.equal(row.verified_at, null, "pre-opening verifies nobody");
    const { isVerified } = await import("../src/calls/verify.js");
    assert.equal(isVerified(db.getCall(OTHER, row.id)), false, "consequential tools still wait for the second check");
    opened[0].open();
    const start = opened[0].of("session.start")[0].session;
    assert.match(start.input[0].content[0].text, /what's up\?/, "her inbound greeting");
    // The very session a cold stream would open for this row: same instructions, nothing more.
    const cold = fakeLive();
    const twilio = fakeTwilio();
    const timers = fakeTimers();
    const w = gl.takeWarm(row.id);
    w.drop("compare");
    new gl.GptLiveCall({ call: db.getCall(OTHER, row.id), twilio, openLive: () => cold.socket, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, finish: async () => {} });
    twilio.say({ event: "start", start: { streamSid: "MZc", callSid: "CAc" } });
    cold.open();
    assert.equal(start.instructions, cold.of("session.start")[0].session.instructions);
    assert.doesNotMatch(JSON.stringify(start), /Omari|4471/, "nothing of anybody else's");

    db.blockNumber("+14155550111");
    ring("+14155550111");
    ring("+14155550177", "CA_stranger_p");
    ring("anonymous");
    config.maxCallsPerDay = 1;
    try { ring("+13105550000", "CA_capped"); } finally { config.maxCallsPerDay = 10; }
    assert.equal(opened.length, 1, "no session for blocked, a stranger, withheld or over the cap");
  } finally { Object.assign(config, { gptliveInboundPreopen: false, gptlivePreringMemoryMs: 800 }); }
});

test("inbound pre-open off (default): the webhook opens nothing", () => {
  on();
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  let opened = 0;
  const params = { CallSid: "CA_off", From: "+13105550000", To: "+16562167455" };
  gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, openLive: () => { opened++; return fakeLive().socket; } });
  assert.equal(opened, 0);
  assert.equal(config.gptliveInboundPreopen, false);
  assert.equal(config.gptlivePrering, false);
});

test("pre-open =owner: the operator's own calls only — his outbound dial waits for the held session and his inbound opens one; Ama's do neither", async () => {
  assert.equal(gl.preopenOn(true, OTHER), true);
  assert.equal(gl.preopenOn(false, C), false);
  assert.equal(gl.preopenOn("owner", C), true);
  assert.equal(gl.preopenOn("owner", OTHER), false);
  on({ gptlivePrering: "owner", gptliveInboundPreopen: "owner", gptlivePreringWaitMs: 40, gptlivePreringMemoryMs: 0 });
  try {
    const fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ sid: "CA_dial" }) });
    const lines = [];
    let opens = 0;
    const openLive = () => { opens++; return fakeLive().socket; };
    const mine = ownerCall();
    await gl.dialGptLive({ conversationId: C, callId: mine.id, to: "+12025551234", kind: "owner", log: (o) => lines.push(o) }, { fetchImpl, openLive });
    assert.equal(opens, 1, "his outbound: opened while it rings");
    assert.ok(lines.some(l => "gptlive_prering_dial_wait" in l));
    gl.dropWarm(mine.id, "test over");
    const hers = ownerCall({ conversationId: OTHER });
    await gl.dialGptLive({ conversationId: OTHER, callId: hers.id, to: "+13105550000", kind: "owner", log: (o) => lines.push(o) }, { fetchImpl, openLive });
    assert.equal(opens, 1, "hers: nothing opened before the stream");
    gl.dropWarm(hers.id, "test over");

    const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
    const ring = (from, sid) => {
      const params = { CallSid: sid, From: from, To: "+16562167455" };
      return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, openLive });
    };
    ring("+13105550000", "CA_ama_owner_flag");
    assert.equal(opens, 1, "Ama rings in: no pre-open");
    ring("+12025551234", "CA_omari_owner_flag");
    assert.equal(opens, 2, "he rings in: pre-opened");
    const row = db.db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY id DESC").get(C);
    gl.dropWarm(row.id, "test over");
  } finally { Object.assign(config, { gptlivePrering: false, gptliveInboundPreopen: false, gptlivePreringWaitMs: 2000, gptlivePreringMemoryMs: 800 }); }
});

async function gatedGreeted(row) {
  const timers = fakeTimers();
  const live = fakeLive();
  const lines = [];
  gl.prewarm(row, { gate: true, openLive: () => live.socket, log: (o) => lines.push(o), now: timers.now, timers });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_r" } });
  assert.equal(live.of("session.commentary.append").length, 1, "the greeting asked for while it rings");
  await timers.advance(300);
  for (let i = 0; i < 10; i++) live.emit({ type: "session.output_audio.delta", delta: loud });
  live.emit({ type: "session.output_transcript.delta", delta: "Hey Omari, it's Reason." });
  await timers.advance(900);
  assert.ok(lines.some(l => l.gptlive_warm === row.id && l.why === "greeted"), "made and paused");
  const twilio = fakeTwilio();
  const call = new gl.GptLiveCall({ call: row, twilio, warm: gl.takeWarm(row.id), openLive: () => { throw new Error("no second session"); }, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  const fedBefore = live.of("session.input_audio.append").length;
  twilio.say({ event: "start", start: { streamSid: "MZr", callSid: "CAr" } });
  return { timers, live, lines, twilio, call, fedBefore, media: () => twilio.sent.filter(m => m.event === "media" && gl.hasSpeech(m.media.payload)).length };
}

test("ready: the greeting made while it rang waits for their hello to end, then plays; the hello it answers never reaches the voice", async () => {
  on();
  const g = await gatedGreeted(ownerCall());
  for (let i = 0; i < 15; i++) { g.twilio.say({ event: "media", media: { payload: loud } }); await g.timers.advance(20); }
  assert.equal(g.media(), 0, "not over their hello");
  for (let i = 0; i < 25 && !g.lines.some(l => "gptlive_pregreet" in l); i++) { g.twilio.say({ event: "media", media: { payload: ULAW_FRAME } }); await g.timers.advance(20); }
  const played = g.lines.find(l => "gptlive_pregreet" in l);
  assert.equal(played.why, "after their hello");
  assert.ok(played.ms >= 510 && played.ms <= 610, `250 ms after it ended (${played.ms} ms)`);
  assert.ok(g.media() >= 9 && g.media() <= 10, "the whole greeting, at once (the newest frame may be held for a fade)");
  assert.equal(g.live.of("session.input_audio.append").length, g.fedBefore, "their hello was not sent");
  g.twilio.say({ event: "media", media: { payload: loud } });
  assert.equal(g.live.of("session.input_audio.append").length, g.fedBefore + 1, "what they say to it goes in");
  assert.match(g.call.turns.map(t => t.text).join(" "), /Hey Omari, it's Reason/);
});

test("ready: a quiet line gets the greeting at 600 ms; talking on past 3 s drops it — the voice is told and hears all they said", async () => {
  on();
  const q = await gatedGreeted(ownerCall());
  await q.timers.advance(700);
  const played = q.lines.find(l => "gptlive_pregreet" in l);
  assert.equal(played.why, "a quiet line");
  assert.ok(played.ms >= 600 && played.ms <= 700);
  assert.equal(q.call.firstVoiceMs, played.ms);

  const o = await gatedGreeted(ownerCall());
  for (let i = 0; i < 160; i++) { o.twilio.say({ event: "media", media: { payload: loud } }); await o.timers.advance(20); }
  const skipped = o.lines.find(l => "gptlive_pregreet_skipped" in l);
  assert.ok(skipped, "dropped");
  assert.equal(o.media(), 0, "never played over them");
  assert.match(o.live.of("session.instructions.append").at(-1).content, /greeting was never played/);
  assert.ok(o.live.of("session.input_audio.append").length - o.fedBefore >= 150, "every frame they said, handed over");
});

test("ready, picked up mid-greeting: what is still coming is held with it, the voice hears silence (not their hello), and it plays after the hello; one not started yet is asked to greet when it starts", async () => {
  on();
  const row = ownerCall();
  const timers = fakeTimers();
  const live = fakeLive();
  const lines = [];
  gl.prewarm(row, { gate: true, openLive: () => live.socket, log: (o) => lines.push(o), now: timers.now, timers });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_m" } });
  await timers.advance(300);
  live.emit({ type: "session.output_audio.delta", delta: loud });
  live.emit({ type: "session.output_transcript.delta", delta: "Hey Omari, " });
  const twilio = fakeTwilio();
  new gl.GptLiveCall({ call: row, twilio, warm: gl.takeWarm(row.id), openLive: () => { throw new Error("no second"); }, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZm", callSid: "CAm" } });
  const fed = live.of("session.input_audio.append").length;
  for (let i = 0; i < 10; i++) {
    twilio.say({ event: "media", media: { payload: loud } });
    live.emit({ type: "session.output_audio.delta", delta: loud });
    await timers.advance(20);
  }
  live.emit({ type: "session.output_transcript.delta", delta: "it's Reason." });
  const speech = () => twilio.sent.filter(m => m.event === "media" && gl.hasSpeech(m.media.payload)).length;
  assert.equal(speech(), 0, "nothing over their hello, not even the live rest of the greeting");
  const sentSince = live.of("session.input_audio.append").slice(fed);
  assert.equal(sentSince.length, 10, "the clock kept running");
  assert.ok(sentSince.every(e => !gl.hasSpeech(e.audio)), "on silence, never their hello");
  for (let i = 0; i < 20 && !lines.some(l => "gptlive_pregreet" in l); i++) { twilio.say({ event: "media", media: { payload: ULAW_FRAME } }); await timers.advance(20); }
  const greeted = speech();
  assert.ok(greeted >= 10 && greeted <= 11, "the whole greeting, in order, after their hello");
  live.emit({ type: "session.output_audio.delta", delta: loud });
  assert.equal(speech(), greeted + 1, "then live as normal");

  // Picked up before the gated session started: it is asked to greet the moment it starts.
  const row2 = ownerCall();
  const live2 = fakeLive();
  gl.prewarm(row2, { gate: true, openLive: () => live2.socket, now: timers.now, timers });
  live2.open();
  const twilio2 = fakeTwilio();
  new gl.GptLiveCall({ call: row2, twilio: twilio2, warm: gl.takeWarm(row2.id), openLive: () => { throw new Error("no second"); }, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, finish: async () => {} });
  twilio2.say({ event: "start", start: { streamSid: "MZn", callSid: "CAn" } });
  live2.emit({ type: "session.started", session: { id: "live_n" } });
  assert.equal(live2.of("session.commentary.append").length, 1);
});

test("ready: their hello just as the greeting starts — it is cleared and said once more after them", async () => {
  on();
  const g = await gatedGreeted(ownerCall());
  await g.timers.advance(620);
  assert.ok(g.lines.some(l => l.why === "a quiet line"));
  for (let i = 0; i < 25; i++) { g.twilio.say({ event: "media", media: { payload: loud } }); await g.timers.advance(20); }
  assert.ok(g.lines.some(l => "gptlive_pregreet_again" in l), "replayed");
  assert.ok(g.twilio.sent.some(m => m.event === "clear"));
  const before = g.twilio.sent.filter(m => m.event === "media" && gl.hasSpeech(m.media.payload)).length;
  for (let i = 0; i < 20; i++) { g.twilio.say({ event: "media", media: { payload: ULAW_FRAME } }); await g.timers.advance(20); }
  const again = g.twilio.sent.filter(m => m.event === "media" && gl.hasSpeech(m.media.payload)).length - before;
  assert.ok(again >= 9 && again <= 11, "said once more, whole");
  assert.equal(g.call.turns.filter(t => /Hey Omari, it's Reason/.test(t.text)).length, 1, "one greeting in the transcript");
  for (let i = 0; i < 40; i++) { g.twilio.say({ event: "media", media: { payload: loud } }); await g.timers.advance(20); }
  assert.equal(g.lines.filter(l => "gptlive_pregreet_again" in l).length, 1, "once only");
});

test("prering: a pre-opened session that dies before it started never ends the call — a fresh one opens and greets, their hello kept", async () => {
  on();
  const row = ownerCall();
  const timers = fakeTimers();
  const dead = fakeLive();
  const closers = [];
  dead.socket.on = ((orig) => (k, f) => { if (k === "close") closers.push(f); return orig(k, f); })(dead.socket.on);
  gl.prewarm(row, { hold: true, openLive: () => dead.socket, now: timers.now, timers });
  dead.open();
  const fresh = fakeLive();
  const lines = [];
  const twilio = fakeTwilio();
  const finished = [];
  new gl.GptLiveCall({ call: row, twilio, warm: gl.takeWarm(row.id), openLive: () => fresh.socket, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async (l) => { finished.push(l); } });
  twilio.say({ event: "start", start: { streamSid: "MZx", callSid: "CAx" } });
  for (let i = 0; i < 3; i++) twilio.say({ event: "media", media: { payload: loud } });
  closers.forEach(f => f(1006));
  assert.ok(lines.some(l => "gptlive_prering_fallback" in l));
  assert.equal(finished.length, 0, "the call goes on");
  fresh.open();
  assert.equal(fresh.of("session.start").length, 1);
  fresh.emit({ type: "session.started", session: { id: "live_fresh" } });
  assert.equal(fresh.of("session.commentary.append").length, 1, "greets");
  assert.equal(fresh.of("session.input_audio.append").length, 3, "their hello kept");
});

test("prering: a held session still ringing at 24 s is replaced by a fresh one once it is up (GPT-Live expires a silent one at ~30 s)", async () => {
  on();
  const row = ownerCall();
  const timers = fakeTimers();
  const socks = [];
  const lines = [];
  const openLive = () => { const l = fakeLive(); socks.push(l); return l.socket; };
  gl.prewarm(row, { hold: true, renew: true, openLive, log: (o) => lines.push(o), now: timers.now, timers });
  socks[0].open();
  socks[0].emit({ type: "session.started", session: { id: "live_1" } });
  await timers.advance(gl.HOLD_RENEW_MS + 10);
  assert.equal(socks.length, 2, "a second one opened");
  socks[1].open();
  socks[1].emit({ type: "session.started", session: { id: "live_2" } });
  await new Promise(r => setImmediate(r));
  assert.equal(socks[0].of("session.close").length, 1, "the old one closed");
  assert.ok(lines.some(l => "gptlive_prering_renewed" in l));
  const w = gl.takeWarm(row.id);
  assert.equal(w.sessionId, "live_2", "pickup gets the fresh one");
  await timers.advance(60_000);
  assert.ok(socks.length <= 3, "never renewed past the ring's deadline");
});

test("pre-open instructions: through voiceInstructionsFor when this build has it (#406), else the stream's own default; never throws", async () => {
  on();
  const row = ownerCall();
  const live = fakeLive();
  const timers = fakeTimers();
  gl.prewarm(row, { hold: true, openLive: () => live.socket, now: timers.now, timers });
  live.open();
  const sent = live.of("session.start")[0].session.instructions;
  if (typeof gl.voiceInstructionsFor === "function") {
    assert.equal(sent, gl.voiceInstructionsFor(db.getCall(C, row.id) ?? row), "#406's builder, word for word");
  } else {
    assert.equal(gl.preopenInstructions(row), "");
    assert.equal(sent, gl.sessionConfig({ ...gl.whoFor(row) }).instructions, "main: what the stream would send");
  }
  const mem = await gl.awaitCallMemory(row, 50);
  assert.ok(mem === null || typeof mem === "boolean");
  gl.dropWarm(row.id, "test over");
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

test("the live prompt on their own call (fix 2, call 80): Reason itself, with its persona, the split, call 53's lines and their own brief", () => {
  on({ callIdentity: "owner" });
  profiles();
  const s = gl.sessionConfig({ ...gl.whoFor(db.getCall(C, ownerCall().id)), greeting: "hey" }).instructions;
  const lines = s.split("\n");
  assert.match(lines[0], /^You are Reason, Omari's personal assistant — the same Reason they text with — on a phone call with Omari\./);
  assert.match(lines[1], /^Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant, and they're Omari, the person you work for\./);
  assert.match(lines[2], /^You were made by Saafi Interactions Lab;/);
  assert.equal(lines[3], "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.");
  assert.equal(lines[4], gl.OWN_VOICE_PERSONA);
  for (const l of [...gl.OWN_VOICE_SPLIT, ...gl.OWN_CALL56_LINES, ...gl.HEARING_LINES, ...gl.OWN_CALL_LINES, gl.OWN_NO_FILLER, gl.HANDOFF_ACK, gl.PIECES_LINE]) assert.ok(lines.includes(l), l.slice(0, 60));
  assert.doesNotMatch(s, /You are only the voice|Delegate to the backend for every question/, "no longer a relay on their own call");
  assert.match(s, /Never state a fact, figure, news item, price, time or the weather from your own knowledge: hand it off/);
  const end = lines.indexOf("Stop speaking when they talk over you, and listen.");
  assert.match(lines.slice(end + 1).join("\n"), /^PRE-CALL BRIEF/, "only the pre-call brief after the last fixed line");
  assert.match(s, /2 and 5 trains/, "his own profile is in his own call's brief");
  assert.doesNotMatch(s, /peanuts|\bAma\b/, "nobody else's");
  assert.equal(config.gptliveVoice, "marin", "the default voice is call 53's");
});

test("identity off (flag unset): no identity line; still Reason itself on their own call", () => {
  on({ callIdentity: false });
  const s = gl.liveInstructions(gl.whoFor(db.getCall(C, ownerCall().id)));
  assert.doesNotMatch(s, /ask who you are/);
  assert.match(s, /^You are Reason, Omari's personal assistant/);
});

test("identity =owner: another user's call has no identity line and nothing of the operator's — only her own brief", () => {
  on({ callIdentity: "owner" });
  profiles();
  const s = gl.liveInstructions(gl.whoFor(AMA_CALL()));
  assert.match(s, /^You are Reason, Ama's personal assistant/);
  assert.doesNotMatch(s, /ask who you are|\bOmari\b|2 and 5 trains/);
  assert.match(s, /peanuts/, "her own profile");
  assert.equal(vp.callIdentityFor(OTHER), false);
  assert.equal(vp.callIdentityFor(C), true);
});

test("isolation, identity =on: user B's voice gets B's name and B's profile, never user A's", () => {
  on({ callIdentity: true });
  profiles();
  db.addRule(C, { rule: "call me O, never Omari" });
  const s = gl.liveInstructions(gl.whoFor(AMA_CALL()));
  assert.match(s, /they're Ama, the person you work for/);
  assert.match(s, /peanuts/);
  assert.doesNotMatch(s, /\bOmari\b|2 and 5 trains|call me O/);
  const NEW = "sendblue:+13105550001";
  db.upsertAccount({ conversationId: NEW, channel: "sendblue", address: "+13105550001", name: "the person I work for", isOperator: false });
  const n = gl.liveInstructions(gl.whoFor(db.createCall(NEW, { provider: "gptlive", toNumber: "+13105550001", isOwner: true, goal: "g", facts: [], announcement: "hey", state: "placing" })));
  assert.match(n, /you don't have their name saved yet/);
  assert.doesNotMatch(n, /\bOmari\b|\bAma\b|them's|peanuts|2 and 5|call me O/);
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
      // Pages and the user-agent are held to no handle at all by test/site.test.js (security run-3).
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
  const kept = db.db.prepare("SELECT * FROM stranger_calls WHERE phone IN (SELECT value FROM json_each(?))").get(JSON.stringify(db.restcrypt.blindIndexes("phone", "+14155550199")));
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
  const kept = db.db.prepare("SELECT * FROM stranger_calls WHERE phone IN (SELECT value FROM json_each(?))").get(JSON.stringify(db.restcrypt.blindIndexes("phone", "+14155550188")));
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
