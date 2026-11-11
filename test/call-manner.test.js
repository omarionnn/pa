// The call manner (Omari's call voice spec, 2026-11-11; src/calls/manner.js), REASON_CALL_MANNER off|owner|on.
// Both directions: their own call (the voice's prompt, Reason's call turn, a soft line by ~3 s of quiet)
// and a call to a business (says it's Reason, an AI, may be recorded; an objection stops the recording and
// nothing after it is kept). No network: voice, Twilio and the judges are stand-ins.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-manner-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";

const gl = await import("../src/calls/gptlive.js");
const manner = await import("../src/calls/manner.js");
const prompt = await import("../src/calls/voice-prompt.js");
const opener = await import("../src/calls/opener.js");
const voice = await import("../src/calls/voice.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const { announcementFor } = await import("../src/calls/provider.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages;");
  db.saveConversation(C, []);
  db.saveConversation(OTHER, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari Test", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callManner: "owner", lineTalk: true, callIdentity: false, callVoice: "gptlive", thirdPartyVoice: "owner", callCacheWarm: false, callHearing: true, pickupOpener: false, ...TWILIO });
});

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
        for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
      }
      t = end;
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    },
  };
}
function fakeTwilio() {
  const handlers = { msg: [], close: [] };
  const sent = [];
  return {
    sent, open: () => true, send: (s) => sent.push(JSON.parse(s)), close: () => {},
    onMessage: (f) => handlers.msg.push(f), onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
  };
}
function fakeLive() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  return {
    sent, socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()), emit: (e) => h.event.forEach(f => f(e)),
    of: (type) => sent.filter(e => e.type === type),
  };
}
const SPEECH = Buffer.alloc(160, 0x00).toString("base64");
const QUIET = Buffer.alloc(160, 0xff).toString("base64");

const ownRow = (conv = C) => db.createCall(conv, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey, what's up?", state: "placing" });
const lineRow = (conv = C) => {
  const row = db.createCall(conv, {
    provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "ask whether they have a table for two at 7 tonight",
    facts: [], announcement: gl.lineAnnouncement(announcementFor({ ownerName: "Omari" })), state: "placing",
  });
  db.updateCall(row.conversation_id, row.id, { opening_waits: 1 });
  return db.getCall(row.conversation_id, row.id);
};
function start({ row, brain = () => new Promise(() => {}), objectionJudge = null }) {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const lines = [];
  const finished = [];
  const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain, judge: async () => null, objectionJudge, now: timers.now, timers, log: (o) => lines.push(o), finish: async (l) => { finished.push(l); }, twilioApi: async () => ({ ok: true, status: 200, json: {} }) });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  return { call, timers, twilio, live, lines, finished };
}
const holds = (live) => live.of("session.commentary.append").filter(e => String(e.event_id).startsWith("hold_"));
const saidIn = (h) => /"([^"]+)"/.exec(h.content)[1];

// ---------- the flag ----------

test("flag: owner = the operator's account only, on = everyone, off = nobody", () => {
  config.callManner = "owner";
  assert.equal(manner.mannerFor(C), true);
  assert.equal(manner.mannerFor(OTHER), false);
  config.callManner = "on";
  assert.equal(manner.mannerFor(OTHER), true);
  config.callManner = "off";
  assert.equal(manner.mannerFor(C), false);
});

// ---------- their own call: the voice ----------

test("own call voice: the manner's lines stand in for the old persona/filler/goodbye lines — merged, not stacked", () => {
  const base = { name: "Omari", named: true, owner: true };
  const off = gl.liveInstructions(base);
  const on = gl.liveInstructions({ ...base, manner: true });
  assert.equal(gl.liveInstructions({ ...base, manner: false }), off, "off is byte-identical to before");
  assert.ok(off.includes(gl.OWN_VOICE_PERSONA) && !on.includes(gl.OWN_VOICE_PERSONA));
  assert.ok(on.includes(manner.MANNER_PERSONA));
  assert.ok(!on.includes(gl.OWN_NO_FILLER) && on.includes(manner.MANNER_FILLER), "one filler rule, the new one");
  assert.ok(on.includes(manner.MANNER_WRAP_UP) && !on.includes("\nWhen you both say goodbye, sign off warmly and briefly.\n"));
  for (const l of manner.OWN_MANNER_LINES) assert.ok(on.includes(l));
  assert.match(on, /eight thirty tonight/);
  assert.match(on, /never pretend to be human/i);
  assert.doesNotMatch(on, /mm-hm/i, "no backchannel (Omari 11-11)");
  // Somebody else's call (a relay voice) never gets it.
  assert.equal(gl.liveInstructions({ name: "Omari", named: true, owner: false, manner: true }), gl.liveInstructions({ name: "Omari", named: true, owner: false }));
});

test("own call voice: the session for the operator's call carries it; another account's does not (flag=owner)", () => {
  const mine = gl.voiceInstructionsFor(ownRow(C));
  const theirs = gl.voiceInstructionsFor(ownRow(OTHER));
  assert.ok(mine.includes(manner.MANNER_PERSONA));
  assert.ok(!theirs.includes(manner.MANNER_PERSONA) && theirs.includes(gl.OWN_VOICE_PERSONA));
});

// ---------- their own call: Reason's turn ----------

test("own call turn: confirm back, clear spoken yes with the exact total, 'I'll text you that' sent; my-bad replaces no-apology", () => {
  const on = prompt.ownerCallFrame({ name: "Omari", manner: true });
  const off = prompt.ownerCallFrame({ name: "Omari" });
  assert.equal(prompt.ownerCallFrame({ name: "Omari", manner: false }), off);
  assert.match(on, /Two people, Friday at eight, Lilia\. Want it\?/);
  assert.match(on, /sure, whatever/);
  assert.match(on, /exact total/);
  assert.match(on, /I'll text you that" and send it with message_send/);
  assert.ok(!/^When you do something that produces a link/m.test(on), "the older texting line is replaced, not doubled");
  const rules = prompt.voiceRules({ manner: true });
  assert.equal(prompt.voiceRules(), prompt.VOICE_RULES);
  assert.match(rules, /my bad/);
  assert.doesNotMatch(rules, /No apology, just the correction/);
  assert.match(rules, /Not sure yet\. I'll check and text you\./);
  assert.equal(rules.split("\n").length, prompt.VOICE_RULES.split("\n").length, "swapped line for line");
});

// ---------- their own call: silence ----------

test("own call silence: a soft 'Give me a sec.' by ~3 s of quiet (was 7.5 s), another after 5 s more, at most 3", async () => {
  const s = start({ row: ownRow(C) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d1" } });
  await s.timers.advance(2900);
  assert.equal(holds(s.live).length, 0);
  await s.timers.advance(200);
  assert.deepEqual(holds(s.live).map(saidIn), ["Give me a sec."]);
  await s.timers.advance(5000);
  assert.equal(holds(s.live).length, 2);
  await s.timers.advance(30_000);
  assert.equal(holds(s.live).length, manner.MANNER_QUIET_MAX);
  for (const h of holds(s.live)) assert.ok(manner.MANNER_LATE_LINES.includes(saidIn(h)));
});

test("own call silence: timed off the last sound — the voice's own line resets the clock", async () => {
  const s = start({ row: ownRow(C) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d2" } });
  await s.timers.advance(1000);
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  await s.timers.advance(2500);
  assert.equal(holds(s.live).length, 0, "only ~2.5 s since its own words");
  await s.timers.advance(1000);
  assert.equal(holds(s.live).length, 1);
});

test("own call silence: flag off keeps the old 7.5 s late line", async () => {
  config.callManner = "off";
  const s = start({ row: ownRow(C) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d3" } });
  await s.timers.advance(4000);
  assert.equal(holds(s.live).length, 0);
  await s.timers.advance(voice.LATE_HOLDING_MS - 4000 + 50);
  assert.equal(holds(s.live).length, 1);
  assert.ok(voice.LATE_LINES.includes(saidIn(holds(s.live)[0])));
});

// ---------- a business call ----------

test("business opener: 'Hi there, this is Reason, an AI assistant calling for <first name>. … may be recorded.' — clip, voice and Reason's turn", () => {
  assert.equal(manner.disclosureLine("Omari Test"), "Hi there, this is Reason, an AI assistant calling for Omari. Just so you know, this call may be recorded.");
  const clip = opener.openerText({ about: "to ask about a table for two", disclose: manner.disclosureLine("Omari") });
  assert.equal(clip.text, "Hi there, this is Reason, an AI assistant calling for Omari. Just so you know, this call may be recorded. I'm calling to ask about a table for two.");
  assert.equal(opener.openerText({ about: "to ask" }).text, "Hi there! I'm calling to ask.", "off: as before");
  const on = gl.lineTalkInstructions({ name: "Omari Test", named: true, goal: "a table", manner: true });
  assert.ok(on.includes(manner.disclosureLine("Omari")));
  assert.doesNotMatch(on, /Don't open by saying you're an AI/);
  assert.match(on, /one notch more polite/);
  assert.match(on, /No jokes unless they joke first/);
  assert.match(on, /never agree to a charge, deposit or commitment Omari hasn't approved/);
  assert.match(on, /rather not be recorded/);
  const off = gl.lineTalkInstructions({ name: "Omari Test", named: true, goal: "a table" });
  assert.match(off, /Don't open by saying you're an AI/);
  const frame = prompt.thirdPartyFrame({ ownerName: "Omari Test", goal: "a table", rules: ["r"], manner: true });
  assert.match(frame, /one notch more polite/);
  assert.doesNotMatch(prompt.thirdPartyFrame({ ownerName: "Omari Test", goal: "a table", rules: ["r"] }), /one notch more polite/);
});

test("business call: the row's opening line is the disclosure, even in a one-party state; another account's isn't (flag=owner)", () => {
  const s = start({ row: lineRow(C) });
  assert.equal(s.call.notice.notice, true);
  assert.equal(s.call.call.announcement, manner.disclosureLine("Omari"));
  assert.equal(db.getCall(C, s.call.call.id).announcement, manner.disclosureLine("Omari"));
  const o = start({ row: lineRow(OTHER) });
  assert.notEqual(o.call.call.announcement, manner.disclosureLine("Ama"));
});

test("business call: an objection to the recording (read by meaning) stops it, cut back to before their words; a plain question doesn't", async () => {
  const reads = [];
  const s = start({ row: lineRow(C), objectionJudge: async (t) => { reads.push(t); return /rather you didn't record/.test(t); } });
  // 4 s of the line before anything.
  for (let i = 0; i < 200; i++) { s.twilio.say({ event: "media", media: { payload: QUIET } }); await s.timers.advance(20); }
  s.live.emit({ type: "session.input_transcript.delta", delta: " Is this recorded?" });
  for (let i = 0; i < 100; i++) { s.twilio.say({ event: "media", media: { payload: QUIET } }); await s.timers.advance(20); }
  assert.equal(reads.length, 1);
  assert.equal(s.call.tape.stopped, false, "a question is not an objection");
  const before = s.call.tape.seconds();
  s.live.emit({ type: "session.input_transcript.delta", delta: " I'd rather you didn't record this, thanks." });
  for (let i = 0; i < 100; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  assert.equal(s.call.tape.stopped, true);
  assert.ok(s.call.tape.seconds() <= before, `kept ${s.call.tape.seconds()} s, before the objection ${before} s`);
  assert.ok(s.lines.some(l => l.gptlive_recording_declined));
  assert.ok(s.live.of("session.instructions.append").some(e => e.content === manner.RECORDING_OFF_NOTE));
  // Nothing after the objection is kept, however long the call goes on.
  const kept = s.call.tape.seconds();
  for (let i = 0; i < 250; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  assert.equal(s.call.tape.seconds(), kept);
  assert.equal(s.call.tape.wav().length, 44 + Math.round(kept * 8000) * 2);
  assert.match(s.call.howItWent(10), /asked not to be recorded/);
});

test("business call: a read that can't be made fails closed (the voice may have said it's off); flag off never reads", async () => {
  const s = start({ row: lineRow(C), objectionJudge: async () => null });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Please don't record." });
  await s.timers.advance(2000);
  assert.equal(s.call.tape.stopped, true);
  assert.equal(s.call.recordingStopWhy, "read failed");
  assert.ok(!s.live.of("session.instructions.append").some(e => e.content === manner.RECORDING_OFF_NOTE), "the voice is not told a thing nobody read");
  config.callManner = "off";
  let asked = 0;
  const o = start({ row: lineRow(C), objectionJudge: async () => { asked++; return true; } });
  o.live.emit({ type: "session.input_transcript.delta", delta: " Please don't record." });
  await o.timers.advance(2000);
  assert.equal(asked, 0);
  assert.equal(o.call.tape.stopped, false);
});

test("business call: a failed read on words not about the recording stops nothing; an objection during a running read at hang-up is still read", async () => {
  const s = start({ row: lineRow(C), objectionJudge: async () => null });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Do you have a table for two?" });
  await s.timers.advance(2000);
  assert.equal(s.call.tape.stopped, false);
  const seen = [];
  let first;
  const o = start({ row: lineRow(C), objectionJudge: (t) => { seen.push(t); if (seen.length === 1) return new Promise(r => { first = r; }); return Promise.resolve(/don't record/.test(t)); } });
  for (let i = 0; i < 150; i++) { o.twilio.say({ event: "media", media: { payload: SPEECH } }); await o.timers.advance(20); }
  o.live.emit({ type: "session.input_transcript.delta", delta: " Hello, who's this?" });
  await o.timers.advance(950); // the first read is running
  await o.timers.advance(5000); // (the 4 s gap starts a new their-turn)
  o.live.emit({ type: "session.input_transcript.delta", delta: " Please don't record this." });
  const ending = o.call.end("caller hung up");
  await o.timers.advance(3100);
  first(false);
  await o.timers.advance(10);
  await ending;
  assert.equal(o.call.tape.stopped, true, "the newest words were read at the end");
});

test("business call: an objection said just before they hang up is read before the tape is written — never kept", async () => {
  let release;
  const s = start({ row: lineRow(C), objectionJudge: () => new Promise(r => { release = r; }) });
  for (let i = 0; i < 150; i++) { s.twilio.say({ event: "media", media: { payload: SPEECH } }); await s.timers.advance(20); }
  s.live.emit({ type: "session.input_transcript.delta", delta: " Actually don't record this. Bye." });
  await s.timers.advance(100); // hang-up inside the settle
  const ending = s.call.end("caller hung up");
  await s.timers.advance(3100);
  assert.equal(typeof release, "function", "the settle-pending read was started at the end");
  release(true);
  await s.timers.advance(10);
  await ending;
  assert.equal(s.call.tape.stopped, true);
  const live = s.finished.at(-1);
  assert.ok(!live.recording || live.recording.seconds <= 1, JSON.stringify(live.recording));
});

test("business call: reads are one at a time; the voice's own 'I'll turn it off' is read too", async () => {
  let inFlight = 0, most = 0, n = 0;
  const s = start({ row: lineRow(C), objectionJudge: async (t) => { n++; inFlight++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return /turn the recording off/.test(t); } });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Hi, Lilia." });
  await s.timers.advance(950);
  s.live.emit({ type: "session.input_transcript.delta", delta: " Hmm okay." });
  await s.timers.advance(950);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(most, 1);
  assert.equal(s.call.tape.stopped, false);
  s.call.talking = true; // a person answered: the voice talks on this line
  s.call.textOut("Of course, I'll turn the recording off.");
  await s.timers.advance(950);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(s.call.tape.stopped, true);
  assert.ok(n >= 2);
});

test("prompts (cold review): no-name opener, business turn keeps the plain rules, codes said in groups, recording line only where code stops it", () => {
  assert.equal(manner.disclosureLine(""), "Hi there, this is Reason, an AI assistant. Just so you know, this call may be recorded.");
  const rules = prompt.voiceRules({ manner: true });
  assert.doesNotMatch(rules, /or a code out loud/);
  assert.match(rules, /small groups/);
  const withOff = prompt.thirdPartyFrame({ ownerName: "Omari", goal: "x", rules: ["r"], manner: true, recordingOff: true });
  const without = prompt.thirdPartyFrame({ ownerName: "Omari", goal: "x", rules: ["r"], manner: true });
  assert.match(withOff, /rather not be recorded/);
  assert.doesNotMatch(without, /rather not be recorded/);
  const own = gl.liveInstructions({ name: "Omari", named: true, owner: true, manner: true });
  assert.doesNotMatch(own, /Never read out links, codes, IDs/);
});

test("own call: never read for an objection — their own calls stay recorded", async () => {
  let asked = 0;
  const s = start({ row: ownRow(C), objectionJudge: async () => { asked++; return true; } });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Don't record this." });
  await s.timers.advance(2000);
  assert.equal(asked, 0);
  assert.equal(s.call.tape.stopped, false);
});

test("CallTape.stop: keeps everything before the cut, nothing after, and Reason's audio stays where it was heard", () => {
  const t = new gl.CallTape();
  t.them(Buffer.alloc(8000, 0xff)); // 1 s
  t.reason(Buffer.alloc(800, 0x00));
  t.them(Buffer.alloc(8000, 0xff)); // 2 s
  t.stop(500);
  assert.equal(t.seconds(), 1.5);
  t.them(Buffer.alloc(8000, 0xff));
  t.reason(Buffer.alloc(800, 0x00));
  assert.equal(t.seconds(), 1.5);
  assert.equal(t.wav().length, 44 + 12000 * 2);
});
