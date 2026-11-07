// The pickup opener and the call's real outcome (2026-11-07 review: business calls took 4–5 s to say a
// word after pickup and people hung up; mailboxes that aren't set up got no text; every unsettled call
// read "dropped before confirmation"). No network: the voice session, the Twilio stream and the model's
// read are stand-ins; assertions read what was sent and the database.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pickup-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const gl = await import("../src/calls/gptlive.js");
const op = await import("../src/calls/opener.js");
const goal = await import("../src/calls/goalmet.js");
const outcome = await import("../src/calls/outcome.js");
const db = await import("../src/db.js");
const ops = await import("../src/ops.js");
const { tellTheOwner } = await import("../src/calls/postcall.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM outbox; DELETE FROM accounts;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  Object.assign(config, { lineTalk: true, pickupOpener: true, callIdentity: false, callVoice: "gptlive", thirdPartyVoice: "owner", twilioSid: "AC_test", twilioToken: "t", twilioFrom: "+16562167455", openaiKey: "sk-test" });
});

const BRIEF = JSON.stringify({ goal: "Ask which service for low back pain and the hour price. Asking only.", facts: [], questions: [], cannotAgree: [], approved: { book: false, maxCents: null, terms: [], upTo: "" }, readBack: [], requirements: {}, place: "", language: "en" });
const bizRow = (over = {}) => {
  const row = db.createCall(C, { provider: "gptlive", toNumber: over.to ?? "+16468580667", isOwner: false, goal: "ask which service for low back pain and the hour price", facts: [], announcement: "", state: "placing" });
  db.updateCall(C, row.id, { opening_waits: 1, brief: BRIEF, pickup_about: "to ask about a massage for low back pain", ...(over.fields ?? {}) });
  return db.getCall(C, row.id);
};

function fakeTimers() {
  let t = 1_000_000, q = [], n = 0;
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
        q.shift(); t = next.at; next.fn();
        for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
      }
      t = end;
    },
  };
}
function fakeTwilio() {
  const sent = [], h = { msg: [], close: [] };
  let open = true;
  return {
    sent, open: () => open, send: (s) => sent.push(JSON.parse(s)),
    close: () => { open = false; h.close.forEach(f => f()); },
    onMessage: (f) => h.msg.push(f), onClose: (f) => h.close.push(f),
    say: (o) => h.msg.forEach(f => f(JSON.stringify(o))),
    media: () => sent.filter(m => m.event === "media"),
  };
}
function fakeLive() {
  const sent = [], h = { open: [], event: [], close: [] };
  return {
    sent, socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()), emit: (e) => h.event.forEach(f => f(e)),
    of: (type) => sent.filter(e => e.type === type),
  };
}
const SPEECH = Buffer.alloc(160, 0x00).toString("base64");
const QUIET = Buffer.alloc(160, 0xff).toString("base64");
const CLIP = Buffer.alloc(8000 * 2, 0x00); // 2 s of "speech"

/** A business call with a clip ready; the voice session comes up only when `up()` is called. */
function startCall({ row = bizRow(), clip = { text: "Hi there! I'm calling to ask about a massage for low back pain.", kind: "about", audio: CLIP } } = {}) {
  if (clip) op._setReady(row.id, clip);
  const timers = fakeTimers(), twilio = fakeTwilio(), live = fakeLive(), logs = [];
  const call = new gl.GptLiveCall({
    call: row, twilio, openLive: () => live.socket, brain: async () => ({ text: "", tools: [], calls: [], endCall: null }),
    now: timers.now, timers, log: (o) => logs.push(o), judge: async () => null, finish: async () => {},
  });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  const up = () => { live.open(); live.emit({ type: "session.started", session: { id: "live_1" } }); };
  return { call, timers, twilio, live, logs, row, up };
}
/** `ms` of their side, 20 ms frames, in real (fake) time. */
async function line(s, ms, payload) {
  for (let i = 0; i < ms / 20; i++) { s.twilio.say({ event: "media", media: { track: "inbound", payload } }); await s.timers.advance(20); }
}
const pick = (s, k) => s.logs.filter(l => k in l);

test("opener words: purpose first, no AI and no 'calling for', the recording line only where owed", () => {
  assert.deepEqual(op.openerText({ about: "to ask about a massage for low back pain." }), { text: "Hi there! I'm calling to ask about a massage for low back pain.", kind: "about" });
  assert.equal(op.openerText({ about: "I'm calling about the game" }).text, "Hi there! I'm calling about the game.");
  assert.equal(op.openerText({ about: "about the game", notice: true }).text, "Hi there — just so you know, this call's recorded. I'm calling about the game.");
  assert.deepEqual(op.openerText({}), { text: "Hi there!", kind: "hello" });
  assert.equal(op.openerText({ about: "see https://x.y" }).kind, "hello", "a link is never said");
  assert.equal(op.openerFor({ is_owner: 1 }), false, "their own call keeps its greeting");
  assert.equal(op.openerFor({ is_owner: 0, direction: "in" }), false, "a place ringing back hears the disclosure");
  assert.equal(op.openerFor({ is_owner: 0, direction: "out" }), true);
  config.pickupOpener = false;
  assert.equal(op.openerFor({ is_owner: 0, direction: "out" }), false, "REASON_PICKUP_OPENER=off");
});

test("TTS audio to the phone line: 24 kHz → 8 kHz μ-law, the leading silence trimmed", () => {
  const pcm = new Int16Array(24000 * 1);
  for (let i = 12000; i < 24000; i++) pcm[i] = Math.round(Math.sin(i / 5) * 8000);
  const u = op.pcm24ToUlaw(Buffer.from(pcm.buffer));
  assert.ok(u.length < 4000 + 400 && u.length > 4000, `half a second of lead silence cut to 40 ms (${u.length})`);
  assert.equal(op.linearToUlaw(0), 0xff);
});

test("a silent pickup: the opener plays ~0.6 s in, before the voice is even up; the voice is told and never opens again", async () => {
  const s = startCall();
  await line(s, 640, QUIET);
  assert.equal(pick(s, "gptlive_pickup_opener").length, 1);
  const first = pick(s, "gptlive_first_voice")[0];
  assert.ok(first.ms >= 600 && first.ms <= 640, `first word at ${first.ms} ms`);
  assert.equal(first.opener, "about");
  assert.equal(s.twilio.media().length, CLIP.length / 160, "the whole clip went down the line");
  // The session comes up late: told what was said first, then their early audio.
  s.up();
  const told = s.live.sent.findIndex(e => e.type === "session.instructions.append" && /code just said this to them for you/.test(e.content));
  const early = s.live.sent.findIndex(e => e.type === "session.input_audio.append");
  assert.ok(told >= 0 && early > told, "the opener note goes in before their early audio");
  // The voice talks on its own before anybody answers the opener: never reaches the line.
  const before = s.twilio.media().length;
  s.live.emit({ type: "session.output_audio.delta", delta: SPEECH });
  assert.equal(s.twilio.media().length, before);
  // No quiet-line "Hi there, hello?" on top; 3 s of nothing after it gets one "can you hear me?".
  await line(s, 4000, QUIET);
  assert.equal(pick(s, "gptlive_line_opened_quiet").length, 0);
  assert.equal(pick(s, "gptlive_opener_quiet_after").length, 0);
  await line(s, 2000, QUIET);
  assert.equal(pick(s, "gptlive_opener_quiet_after").length, 1);
  // They answer it: the voice's reply goes through.
  await line(s, 600, SPEECH);
  await line(s, 700, QUIET);
  for (let i = 0; i < 30; i++) { s.live.emit({ type: "session.output_audio.delta", delta: SPEECH }); await s.timers.advance(20); }
  assert.ok(s.twilio.media().length > before, "the voice answers them");
  assert.equal(s.call.turns.filter(t => t.who === "reason")[0].text, "Hi there! I'm calling to ask about a massage for low back pain.");
});

test("their hello first: the opener follows ~0.55 s after it ends; its late transcript sits before the opener and starts no line turn", async () => {
  const s = startCall();
  await line(s, 200, QUIET);
  await line(s, 1200, SPEECH);           // "Hi, Chelsea Bodywork, can I help you?"
  await line(s, 600, QUIET);
  const first = pick(s, "gptlive_first_voice")[0];
  assert.ok(first && first.ms >= 1940 && first.ms <= 2000, `first word ${first?.ms} ms (hello ended at 1400)`);
  s.up();
  s.live.emit({ type: "session.input_transcript.delta", delta: "Hi, Chelsea Bodywork, can I help you?" });
  await s.timers.advance(gl.LINE_QUIET_MS + 50);
  assert.equal(pick(s, "gptlive_line_turn").length, 0, "the opener answered the hello");
  assert.deepEqual(s.call.turns.map(t => t.who), ["them", "reason"]);
});

test("a long greeting (a recording or a menu) gets no opener, and the old quiet-line rules stand", async () => {
  const s = startCall();
  s.up();
  await line(s, 4000, SPEECH);
  assert.equal(pick(s, "gptlive_pickup_opener").length, 0);
  assert.equal(pick(s, "gptlive_pickup_opener_skipped")[0].why, "a long greeting (a recording or a menu)");
  assert.equal(s.twilio.media().length, 0);
});

test("talked over for 0.9 s later in the clip: the opener stops, the line is cleared, the voice is told they may have missed it", async () => {
  const s = startCall({ clip: { text: "Hi there! I'm calling to ask about a massage for low back pain.", kind: "about", audio: Buffer.alloc(8000 * 4, 0x00) } });
  s.up();
  await line(s, 620, QUIET);
  await line(s, 1600, QUIET);
  await line(s, 960, SPEECH);
  assert.equal(pick(s, "gptlive_pickup_opener_cut").length, 1);
  assert.ok(s.twilio.sent.some(m => m.event === "clear"));
  assert.ok(s.live.of("session.instructions.append").some(e => /they talked over it/.test(e.content)));
});

test("no clip ready: the call opens the old way, and pickup → first word still lands on the row", async () => {
  const s = startCall({ clip: null });
  s.up();
  await line(s, 640, QUIET);
  assert.equal(pick(s, "gptlive_pickup_opener").length, 0);
  s.twilio.close();
  await s.timers.advance(4000);
  const r = db.getCall(C, s.row.id);
  assert.equal(r.first_audio_ms, null);
  assert.equal(r.pickup_opener, "");
});

test("/ops: pickup → first word across the last calls", async () => {
  const s = startCall();
  await line(s, 640, QUIET);
  s.twilio.close();
  await s.timers.advance(4000);
  const r = db.getCall(C, s.row.id);
  assert.ok(r.first_audio_ms >= 600 && r.first_audio_ms <= 640);
  assert.equal(r.pickup_opener, "about");
  const slow = bizRow();
  db.updateCall(C, slow.id, { first_audio_ms: 4781 });
  const pk = ops.pickupCheck();
  assert.match(pk.detail, /last 2: typical 0\.6 s, slowest 4\.8 s/);
  assert.equal(pk.state, "ok");
});

test("outcomes: the model's read names how it went; a booking call is only ever settled by the gate", () => {
  const row = bizRow();
  db.updateCall(C, row.id, { outcome_kind: "dropped_before_confirmation", state: "completed" });
  const r = db.getCall(C, row.id);
  assert.equal(goal.kindFrom(r, { met: true, how: "talked" }), "goal_met");
  assert.equal(goal.kindFrom(r, { met: false, how: "talked" }), "picked_up");
  assert.equal(goal.kindFrom(r, { met: false, how: "hung_up_early" }), "hung_up_early");
  assert.equal(goal.kindFrom(r, { met: false, how: "voicemail_not_set_up" }), "voicemail_full");
  assert.equal(goal.kindFrom(r, { met: false, how: "voicemail_greeting" }), "voicemail_no_message");
  assert.equal(goal.kindFrom(r, { met: false, how: "unsure" }), "");
  assert.equal(goal.kindFrom({ ...r, is_owner: 1 }, { met: true, how: "talked" }), "talked", "their own call is a chat, never a seal");
  assert.equal(goal.kindFrom({ ...r, is_owner: 1 }, { met: false, how: "hung_up_early" }), "hung_up_early");
  for (const k of ["picked_up", "hung_up_early", "talked"]) assert.ok(outcome.isOutcome(k) && outcome.reachedAPerson(k) && !outcome.isSuccess(k), k);
});

test("calls 62/63: a mailbox that isn't set up → the read says so → one text that it reached nobody", async () => {
  const row = bizRow();
  db.updateCall(C, row.id, { state: "completed", outcome_kind: "dropped_before_confirmation", transcript: "Them: Reach has a voicemail box that has not been set up yet. Please try your call again later. Goodbye" });
  const settled = await goal.settleGoal(C, db.getCall(C, row.id), { ask: async () => ({ value: { met: false, how: "voicemail_not_set_up", why: "a mailbox not set up" } }) });
  assert.equal(settled.outcome_kind, "voicemail_full");
  let recaps = 0;
  const runtime = { event: async () => { recaps++; return "x"; }, mayInterrupt: () => true };
  const a = await tellTheOwner({ row: settled, live: {}, runtime });
  const b = await tellTheOwner({ row: db.getCall(C, row.id), live: {}, runtime });
  assert.equal(a.sent, true);
  assert.equal(b.sent, false, "once");
  assert.equal(recaps, 0, "code's words, not a capped model recap");
  const out = db.db.prepare("SELECT body FROM outbox").all();
  assert.equal(out.length, 1);
  assert.match(out[0].body, /^i rang \(646\) 858-0667 to ask about a massage for low back pain but it went to a voicemail box that isn't set up or is full — so it didn't reach anyone/);
  assert.ok(db.getCall(C, row.id).told_at);
});

test("their hello comes a beat into the silent-line opener: it stops at once and plays again from the top when they finish", async () => {
  const s = startCall();
  s.up();
  await line(s, 620, QUIET);             // the opener starts at ~0.6 s
  await line(s, 1400, SPEECH);           // "Hi, Chelsea Bodywork, can I help you?" over it
  assert.equal(pick(s, "gptlive_pickup_opener_again").length, 1);
  assert.ok(s.twilio.sent.some(m => m.event === "clear"));
  await line(s, 600, QUIET);
  const plays = pick(s, "gptlive_pickup_opener");
  assert.equal(plays.length, 2, "played again after their hello");
  assert.equal(plays[1].why, "after their hello");
  assert.equal(pick(s, "gptlive_pickup_opener_cut").length, 0);
  assert.equal(s.call.turns.filter(t => t.opener).length, 1, "said once in the transcript");
  assert.equal(s.live.of("session.instructions.append").filter(e => /code just said/.test(e.content)).length, 1, "the voice is told once");
});
