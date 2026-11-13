// Soft music while Reason looks something up, on the Cartesia relay (src/calls/lookupmusic.js,
// src/calls/cartesia.js). No network: Twilio's stream, the agent socket and Reason's turn are stand-ins,
// on fake time, as in test/call-cartesia.test.js.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cartesia-music-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_CALL_CARTESIA;
delete process.env.CARTESIA_API_KEY;
delete process.env.REASON_CARTESIA_LOOKUP_MUSIC;
delete process.env.REASON_CARTESIA_LOOKUP_MUSIC_FILE;

const cartesia = await import("../src/calls/cartesia.js");
const { ulawToPcm, pcmToUlaw } = await import("../src/calls/ulaw.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const CARTESIA = { callCartesia: "owner", cartesiaKey: "ck-test", cartesiaAgentId: "agent_test", twilioSid: "AC_test", twilioToken: "t", twilioFrom: "+16562167455", openaiKey: "sk-test", callVoice: "gptlive" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  Object.assign(config, { callIdentity: false, callCartesia: "off", callAmbience: "", cartesiaLookupMusic: "", cartesiaLookupMusicFile: "", cartesiaLookupMusicGain: "" });
});

function fakeTimers() {
  let t = 1_000_000;
  let q = [];
  let n = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++n; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { q = q.filter(x => x.id !== id); },
    pending: () => q.length,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
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

const SPEECH = Buffer.alloc(160, 0x10).toString("base64"); // loud μ-law
const QUIET = Buffer.alloc(160, 0xff).toString("base64");

/** One relay on fake time: a brain that answers after `lookupMs`, and every frame sent to Twilio. */
function relay({ music = "", ambience = "", lookupMs = 3_000 } = {}) {
  Object.assign(config, CARTESIA, { callAmbience: ambience, cartesiaLookupMusic: music });
  const timers = fakeTimers();
  const sent = [];
  const tw = { msg: [], close: [] };
  let open = true;
  const twilio = {
    open: () => open, send: (s) => sent.push({ t: timers.now(), ...JSON.parse(s) }),
    close: () => { open = false; tw.close.forEach(f => f(1000)); },
    onMessage: (f) => tw.msg.push(f), onClose: (f) => tw.close.push(f),
  };
  const say = (obj) => tw.msg.forEach(f => f(JSON.stringify(obj)));
  const out = [];
  const h = { open: [], event: [], close: [] };
  const agent = { send: (o) => out.push(o), close: () => {}, on: (k, f) => h[k].push(f) };
  const emit = (e) => h.event.forEach(f => f(e));
  const lines = [];
  const row = db.createCall(C, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey, it's Reason.", state: "placing" });
  const call = new cartesia.CartesiaAgentCall({
    call: row, twilio, openAgent: () => agent, now: timers.now, timers, log: (l) => lines.push(l),
    brain: () => new Promise((r) => timers.setTimeout(() => r({ text: "Overcast, 52 degrees near work." }), lookupMs)),
    deleteCall: async () => ({ ok: true, redacted: true, status: 200 }),
    textOwner: () => ({ ok: true }),
  });
  call.begin();
  say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  h.open.forEach(f => f());
  emit({ type: "session_ready", call_id: "ac_m" });
  emit({ type: "turn_ended", turn: 1, role: "user", text: "What's the weather near work?" });
  const r = {
    call, timers, sent, lines, out, say, emit,
    ask: (id = "tc_1", request = "weather near work") => emit({ type: "client_tool_call", tool_call_id: id, tool_name: "ask_reason", parameters: { request }, expects_response: true }),
    results: () => out.filter(o => o.type === "client_tool_result"),
    /** The agent speaking for `ms`, one 20 ms frame at a time. */
    async speak(ms, payload = SPEECH) { for (let i = 0; i < ms / 20; i++) { emit({ type: "audio_output", audio: payload }); await timers.advance(20); } },
    /** Him talking for `ms`. */
    async him(ms) { for (let i = 0; i < ms / 20; i++) { say({ event: "media", media: { track: "inbound", payload: SPEECH } }); await timers.advance(20); } },
    media: () => sent.filter(s => s.event === "media"),
    hash: () => createHash("sha256").update(JSON.stringify(sent)).digest("hex"),
  };
  return r;
}

/** Decoded samples of a run of μ-law frames, in the order Twilio plays them. */
const pcm = (frames) => Int16Array.from(Buffer.concat(frames.map(f => Buffer.from(f.media.payload, "base64"))), u => ulawToPcm(u));
const end = async (r) => { r.say({ event: "stop" }); await r.timers.advance(100); };

/** One scripted call: speech, a 3 s lookup, his talk, a barge-in, the answer. Used for the switch-off hashes. */
async function script(r) {
  await r.speak(400);
  await r.timers.advance(200);
  await r.him(300);
  r.ask();
  await r.timers.advance(1_500);
  await r.him(200);
  await r.timers.advance(1_400);
  await r.speak(300, QUIET);
  await r.speak(600);
  r.emit({ type: "audio_output_clear" });
  await r.him(300);
  await r.timers.advance(500);
  await end(r);
}

// The same script on the code before this change (feat/cartesia-conversation at 2968c21b) sent exactly these.
const BEFORE = {
  cafe: "c2b99eedb541bcfe84bd331e771f513cc25c6c84bda85dfe48d54fcdd441c931",
  none: "274f246932ca7c551af54d5108e137859aa30f1ca5e88ae396ca0d031013d3c0",
};

test("switch off: what goes to Twilio is byte-identical to before, with the room and without", async () => {
  for (const ambience of ["owner", ""]) {
    const r = relay({ music: "", ambience });
    await script(r);
    assert.equal(r.hash(), BEFORE[ambience ? "cafe" : "none"], `ambience ${ambience || "off"}`);
  }
});

const music = await import("../src/calls/lookupmusic.js");

test("the switch: off unset and for anything unknown; on is the calmest variant; a variant's name picks it", () => {
  assert.equal(music.lookupMusicMode(""), "");
  assert.equal(music.lookupMusicMode("off"), "");
  assert.equal(music.lookupMusicMode("owner"), "");
  assert.equal(music.lookupMusicMode("on"), music.DEFAULT_VARIANT);
  assert.equal(music.DEFAULT_VARIANT, "warm-pad");
  assert.equal(music.lookupMusicMode("Soft-Keys"), "soft-keys");
  assert.equal(music.lookupMusicGain(""), 1);
  assert.equal(music.lookupMusicGain("9"), music.GAIN_MAX);
  assert.equal(music.lookupMusicGain("x"), 1);
  // Not his own call, or a room that is already music: none.
  assert.equal(music.lookupMusicFor({ id: 1, is_owner: 0 }, null, { mode: "warm-pad" }), null);
  assert.equal(music.lookupMusicFor({ id: 1, is_owner: 1 }, { kind: "music-lounge" }, { mode: "warm-pad" }), null);
  assert.ok(music.lookupMusicFor({ id: 1, is_owner: 1 }, { kind: "cafe" }, { mode: "warm-pad" }));
});

test("on, with no lookup or a fast one (under 700 ms): byte-identical to off, room or not", async () => {
  for (const ambience of ["owner", ""]) {
    for (const lookupMs of [null, 500, 690]) {
      const runs = [];
      for (const m of ["", "on"]) {
        const r = relay({ music: m, ambience, lookupMs: lookupMs ?? 1 });
        await r.speak(200);
        if (lookupMs != null) r.ask();
        await r.timers.advance(1_000);
        await r.speak(400);
        await r.timers.advance(2_000);
        await end(r);
        runs.push(r.hash());
      }
      assert.equal(runs[1], runs[0], `ambience ${ambience || "off"}, lookup ${lookupMs ?? "none"}`);
    }
  }
});

/** The music's own samples: the loop's biggest sample-to-sample step (the music's own motion). */
function loopStep(s) {
  let m = 0;
  for (let i = 0; i < s.length; i++) m = Math.max(m, Math.abs(s[i] - s[(i + s.length - 1) % s.length]));
  return m;
}
/** RMS per 20 ms window. */
const windows = (x) => Array.from({ length: Math.floor(x.length / 160) }, (_, w) => Math.sqrt(x.subarray(w * 160, w * 160 + 160).reduce((a, v) => a + v * v, 0) / 160));

test("a long lookup: silence for 700 ms, a 400 ms fade in, a 600 ms fade out once answered, then silence; no clicks", async () => {
  const r = relay({ music: "on", lookupMs: 3_000 });
  r.ask();
  await r.timers.advance(690);
  assert.equal(r.media().length, 0, "nothing at all for the first 700 ms");
  await r.timers.advance(2_310 + 1_000); // answered at 3 s; the agent has not spoken yet
  assert.equal(r.results()[0].result, "Overcast, 52 degrees near work.");
  const frames = r.media();
  assert.ok(frames.length > 0);
  const first = frames[0].t - 1_000_000;
  assert.ok(first >= 700 && first < 720, `music starts at ${first} ms`);
  const lastAt = frames.at(-1).t - 1_000_000;
  assert.ok(lastAt <= 3_000 + 600 + 20, `music over by ${lastAt} ms`);
  const x = pcm(frames);
  const w = windows(x);
  const full = Math.max(...w);
  assert.ok(full > 100 && full < 600, `full level RMS ${full.toFixed(0)}: well under speech`);
  assert.ok(w[0] < full * 0.1, "it starts from nothing");
  assert.ok(w.at(-1) < full * 0.05, "it ends in nothing");
  assert.ok(Math.abs(x[0]) < 20 && Math.abs(x.at(-1)) < 20, "first and last samples near zero");
  // No sample-to-sample step beyond the music's own (plus μ-law rounding).
  const bound = loopStep(r.call.music.s) + 40;
  for (let i = 1; i < x.length; i++) assert.ok(Math.abs(x[i] - x[i - 1]) <= bound, `step at ${i}: ${x[i - 1]} → ${x[i]} (bound ${bound})`);
  // The fade-in takes about 400 ms to reach full, and the fade-out about 600 ms.
  // The level against the loop itself (the music starts at the loop's first sample): 0 → 1 over 400 ms.
  const ref = windows(r.call.music.s.subarray(0, x.length));
  const env = w.map((v, i) => v / ref[i]);
  // The fades are ramps: the level never moves more than 0.1 from one 20 ms window to the next.
  for (let i = 1; i < env.length; i++) assert.ok(Math.abs(env[i] - env[i - 1]) <= 0.1, `window ${i}: ${env[i - 1].toFixed(2)} → ${env[i].toFixed(2)}`);
  const upTo = env.findIndex(v => v > 0.95);
  assert.ok(upTo >= 17 && upTo <= 21, `full at ${upTo * 20} ms`);
  assert.ok(env[10] > 0.4 && env[10] < 0.65, `half way at 200 ms (${env[10].toFixed(2)})`);
  const downFrom = Math.round((3_000 - first) / 20);
  assert.ok(env[downFrom - 2] > 0.9 && env[downFrom + 15] > 0.1 && env[downFrom + 15] < 0.6, "fading out over ~600 ms");
  // Then the answer is spoken over nothing.
  await r.speak(400);
  const after = r.media().slice(frames.length);
  assert.ok(after.length === 20 && after.every(f => f.media.payload === SPEECH), "the answer goes out untouched");
  assert.equal(r.call.music.g, 0);
  await end(r);
});

test("ducks under the agent's holding line and under him, then comes back up; the answer is never under it", async () => {
  const r = relay({ music: "on", lookupMs: 11_000 });
  r.ask();
  await r.timers.advance(5_000);
  assert.equal(r.call.music.g, 1, "full while nobody talks");
  await r.timers.advance(1_100); // the holding line goes to the agent at 6 s
  assert.match(r.results()[0].result, /Still on it/);
  await r.speak(600);
  assert.equal(r.call.music.g, music.DUCK_LEVEL, "ducked under the holding line");
  r.ask("tc_2", cartesia.COLLECT);
  await r.timers.advance(1_000);
  assert.equal(r.call.music.g, 1, "back up once the line is done");
  await r.him(400);
  assert.equal(r.call.music.g, music.DUCK_LEVEL, "ducked under him");
  await r.timers.advance(1_000);
  assert.equal(r.call.music.g, 1);
  // The answer back at 11 s: fading; the agent starts speaking 200 ms later and it is gone within a frame.
  await r.timers.advance(11_000 - (r.timers.now() - 1_000_000));
  await r.timers.advance(10);
  assert.equal(r.results().at(-1).result, "Overcast, 52 degrees near work.");
  await r.timers.advance(200);
  assert.ok(r.call.music.g > 0.4 && r.call.music.g < 1, "fading out");
  const n = r.media().length;
  await r.speak(400);
  const answer = r.media().slice(n).filter(f => f.media.payload !== QUIET);
  const touched = answer.filter(f => f.media.payload !== SPEECH);
  assert.ok(touched.length <= 1, `${touched.length} answer frames carried music (a 20 ms tail at most)`);
  assert.equal(r.call.music.g, 0);
  await end(r);
});

test("talked over during the music: the phone is cleared, the music's fades carry on and it comes back in without a click", async () => {
  const r = relay({ music: "on", lookupMs: 4_000 });
  r.ask();
  await r.timers.advance(2_000);
  await r.him(100);
  const n = r.sent.length;
  r.emit({ type: "audio_output_clear" });
  assert.equal(r.sent[n].event, "clear");
  assert.equal(r.call.music.lookups.size, 1, "the lookup is still running");
  await r.him(300);
  const back = r.media().filter(f => f.t >= r.sent[n].t);
  assert.ok(back.length > 0, "the music carries on after the clear");
  const x = pcm(back);
  assert.ok(Math.abs(x[0]) < 20, `comes back in from nothing (${x[0]})`);
  const bound = loopStep(r.call.music.s) + 40;
  for (let i = 1; i < x.length; i++) assert.ok(Math.abs(x[i] - x[i - 1]) <= bound, `step at ${i}`);
  assert.equal(r.call.music.g, music.DUCK_LEVEL, "ducked while he talks");
  await r.timers.advance(2_000);
  assert.equal(r.results()[0].result, "Overcast, 52 degrees near work.");
  await r.timers.advance(700);
  assert.equal(r.call.music.g, 0, "faded out once answered");
  await end(r);
});

test("the call ends mid-lookup: the music stops, nothing more is sent and nothing is left running", async () => {
  for (const ambience of ["", "owner"]) {
    const r = relay({ music: "on", ambience, lookupMs: 20_000 });
    r.ask();
    await r.timers.advance(2_000);
    assert.ok(r.call.music.g > 0);
    r.say({ event: "stop" });
    const n = r.sent.length;
    await r.timers.advance(30_000);
    assert.equal(r.sent.length, n, "nothing after the end");
    assert.equal(r.call.music.stopped, true);
    assert.equal(r.call.music.audible(r.timers.now()), false);
  }
});

test("handed to text at 15 s: the music fades out then, not when the late answer lands", async () => {
  const r = relay({ music: "on", lookupMs: 25_000 });
  r.ask();
  await r.timers.advance(6_100);
  r.ask("tc_2", cartesia.COLLECT);
  await r.timers.advance(8_950);
  assert.equal(r.results().at(-1).result, cartesia.TEXT_RESULT);
  await r.timers.advance(700);
  assert.equal(r.call.music.g, 0);
  assert.equal(r.call.music.lookups.size, 0);
  const n = r.media().length;
  await r.timers.advance(3_000);
  assert.equal(r.media().length, n, "no music after the hand-off");
  await end(r);
});

test("with the café room on: the music rides on the room's frames and leaves the room as it was after", async () => {
  const r = relay({ music: "on", ambience: "owner", lookupMs: 2_000 });
  const off = relay({ music: "", ambience: "owner", lookupMs: 2_000 });
  for (const s of [r, off]) { s.ask(); await s.timers.advance(4_000); }
  const a = r.media();
  const b = off.media();
  assert.equal(a.length, b.length, "the same frames, at the same times");
  const differ = a.filter((f, i) => f.media.payload !== b[i].media.payload).map(f => f.t - 1_000_000);
  assert.ok(differ.length > 0 && Math.min(...differ) >= 700 && Math.max(...differ) <= 2_000 + 620, `music between ${Math.min(...differ)} and ${Math.max(...differ)} ms`);
  await end(r); await end(off);
});

test("the loop has no seam, for every variant, at phone and 24 kHz", () => {
  for (const v of music.VARIANTS) {
    for (const rate of [8000, 24000]) {
      const s = music.renderMusic(v, { rate });
      assert.equal(s.length, rate * music.LOOP_S);
      let step = 0;
      let curve = 0;
      for (let i = 1; i < s.length; i++) step = Math.max(step, Math.abs(s[i] - s[i - 1]));
      for (let i = 2; i < s.length; i++) { curve = Math.max(curve, Math.abs(s[i] - 2 * s[i - 1] + s[i - 2])); }
      const n = s.length;
      assert.ok(Math.abs(s[0] - s[n - 1]) <= step, `${v} @${rate}: seam step`);
      assert.ok(Math.abs(s[0] - 2 * s[n - 1] + s[n - 2]) <= curve * 1.01, `${v} @${rate}: seam curve`);
      assert.ok(Math.abs(s[1] - 2 * s[0] + s[n - 1]) <= curve * 1.01, `${v} @${rate}: seam curve after`);
      const rms = Math.sqrt(s.reduce((a, x) => a + x * x, 0) / n);
      assert.ok(Math.abs(rms - 1) < 1e-3, "unit RMS");
    }
  }
  assert.deepEqual(music.renderMusic("warm-pad").subarray(0, 50), music.renderMusic("warm-pad").subarray(0, 50), "pure");
});

test("a track of his own replaces it through one setting: resampled, brought to level, seam crossfaded; a bad file falls back", () => {
  const rate = 44_100;
  const n = rate * 3;
  const wav = Buffer.alloc(44 + n * 4);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 4, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(8000 * Math.sin(2 * Math.PI * 330.3 * i / rate)); wav.writeInt16LE(v, 44 + i * 4); wav.writeInt16LE(v, 46 + i * 4); }
  const file = join(dir, "his-track.wav");
  writeFileSync(file, wav);
  const loop = music.musicLoop({ file, gain: 1 });
  assert.equal(loop.source, "file");
  assert.ok(Math.abs(loop.s.length - (3 * 8000 - 1600)) < 4, "8 kHz, less the crossfade");
  const rms = Math.sqrt(loop.s.reduce((a, x) => a + x * x, 0) / loop.s.length);
  assert.ok(Math.abs(rms - music.MUSIC_RMS) < 10, `at the music's level (${rms.toFixed(0)})`);
  assert.ok(Math.abs(loop.s[0] - loop.s.at(-1)) <= loopStep(loop.s.subarray(100, 8000)) * 1.5, "the seam is crossfaded");
  const bad = join(dir, "bad.wav");
  writeFileSync(bad, "RIFF0000WAVEnothing");
  const fb = music.musicLoop({ file: bad, gain: 1 });
  assert.equal(fb.source, music.DEFAULT_VARIANT);
  assert.ok(fb.fileError);
});
