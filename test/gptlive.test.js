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
  Object.assign(config, { callIdentity: false, makerName: "Saafi Interactions Lab", callVoice: "", twilioSid: "", twilioToken: "", twilioFrom: "", openaiKey: "", gptliveInboundFallbackUrl: "" });
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

test("mutual goodbye: the voice's own 'bye' is read by the model and the call hangs up once it has played", async () => {
  const { call, timers, twilio, live, finished, asked, voice, them } = await goodbyeCall();
  them(" Okay, that was nice talking to you. Okay, bye.");
  await timers.advance(1200);
  voice(" Bye, Omari, talk soon!");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "goodbye");
  assert.match(asked[0].transcript, /Them: Okay, that was nice talking to you\. Okay, bye\.\nReason: Bye, Omari, talk soon!$/);
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
  assert.equal(asked.length, 1);
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
  await timers.advance(1200);
  voice(" Bye!");
  await timers.advance(gl.BYE_SETTLE_MS + 50);
  assert.equal(call.ending, true);
  them(" Oh wait, one more thing, what time is my train?");
  await timers.advance(100);
  assert.equal(asked.length, 2, "read again with their new words");
  assert.match(asked[1].transcript, /one more thing/);
  await timers.advance(20_000);
  assert.equal(call.done, false, "called off: the call carries on");
  assert.equal(call.ending, false);
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
  assert.equal(lines.at(-1), "Stop speaking when they talk over you, and listen.");
  assert.equal(lines.length, 16, "call 53's ten lines + identity + maker + call 56's four");
  for (const l of gl.CALL56_LINES) assert.ok(lines.includes(l));
  assert.doesNotMatch(s, /2 and 5 trains|How you sound|You rang|New York/, "no profile, no tone section, none of #293's additions");
  assert.equal(config.gptliveVoice, "marin", "the default voice is call 53's");
});

test("identity off (flag unset): call 53's prompt plus the maker line, nothing else", () => {
  on({ callIdentity: false });
  const s = gl.liveInstructions(gl.whoFor(db.getCall(C, ownerCall().id)));
  assert.doesNotMatch(s, /ask who you are/);
  assert.equal(s.split("\n").length, 15);
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

test("ElevenLabs path, isolation: user B's whole call context (system + messages) has none of user A's name or profile", () => {
  for (const flag of [false, "owner", true]) {
    on({ callIdentity: flag });
    profiles();
    db.saveConversation(C, [{ role: "user", content: "remind me about the 2 and 5 trains" }]);
    const ctx = voice.contextFor({ call: db.getCall(OTHER, AMA_CALL().id), kind: "owner" });
    const all = JSON.stringify([ctx.system, ctx.messages]);
    assert.match(all, /peanuts/, `${flag}: her own profile`);
    assert.doesNotMatch(all, /\bOmari\b|2 and 5 trains/, `${flag}: none of user A's`);
    assert.equal(/You are Reason — Ama's own Reason/.test(ctx.system), flag === true, `${flag}: identity only when on for her`);
    const tp = voice.contextFor({ call: db.createCall(OTHER, { provider: "elevenlabs", toNumber: "+13105559999", isOwner: false, goal: "book a table", facts: [], announcement: "", state: "in_progress" }), kind: "third_party" });
    assert.doesNotMatch(JSON.stringify([tp.system, tp.messages]), /peanuts|\bOmari\b|2 and 5/, `${flag}: a business hears none of either`);
  }
});

test("ElevenLabs path, =owner: the operator's call carries the identity lines; unset, the frame is as it always was", () => {
  on({ callIdentity: "owner" });
  const own = voice.contextFor({ call: db.getCall(C, ownerCall().id), kind: "owner" });
  assert.match(own.system, /You are Reason — Omari's own Reason/);
  const tp = voice.contextFor({ call: db.createCall(C, { provider: "elevenlabs", toNumber: "+13105559999", isOwner: false, goal: "book a table", facts: [], announcement: "", state: "in_progress" }), kind: "third_party" });
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
