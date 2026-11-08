// Call 79 (2026-11-08, Omari's own GPT-Live call, 187 s): the fixes, pinned. No network: the voice
// session, the Twilio stream and Reason's turn are stand-ins; every assertion reads what was sent.
//   1. holding lines are code's: none for an answer ready within 1.5 s, "check/look" only while a tool runs
//   2. (call 80 replaced the code cut: see test/call80-fixes.test.js)
//   3. today so far: the caller's own thread today, names included, in Reason's prompt and the voice's brief
//   4. talk-over: a reply that starts while they are still talking waits for them; first exchange waits longer
//   5. warm-up: Reason's prompt is cached while it rings, with the exact bytes the first turn sends
//   6. limits: "7 or later" is kept to
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call79-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";

const gl = await import("../src/calls/gptlive.js");
const voice = await import("../src/calls/voice.js");
const brief = await import("../src/calls/brief.js");
const prompt = await import("../src/calls/voice-prompt.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages;");
  try { db.db.exec("DELETE FROM call_turns"); } catch { /* fresh db */ }
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callIdentity: false, callVoice: "gptlive", callCacheWarm: true, callHearing: true, web: true, ...TWILIO });
});

const ownerCall = (over = {}) => db.createCall(over.conversationId ?? C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [],
  announcement: "Hey Omari, what's up?", state: "placing",
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
        await new Promise(r => setImmediate(r));
      }
      t = end;
      await new Promise(r => setImmediate(r));
    },
  };
}
function fakeTwilio() {
  const sent = [];
  const handlers = { msg: [], close: [] };
  return {
    sent, send: (s) => sent.push(JSON.parse(s)), close: () => {},
    onMessage: (f) => handlers.msg.push(f), onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
    media: () => sent.filter(m => m.event === "media").length,
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
const SILENT = Buffer.alloc(160, 0xff).toString("base64");
const LOUD = Buffer.alloc(160, 0x00).toString("base64");

function startCall({ brain, row = ownerCall(), warmTurn = null } = {}) {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const lines = [];
  const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain, now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {}, warmTurn });
  // The voice goes out one piece behind (its fade, call 80): a piece held for that counts as played.
  twilio.media = () => twilio.sent.filter(m => m.event === "media").length + (call.voiceTail ? 1 : 0);
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  return { call, timers, twilio, live, lines, row };
}
const holds = (live) => live.of("session.commentary.append").filter(e => String(e.event_id).startsWith("hold_"));
/** Their side for `ms`, one 20 ms frame at a time, in step with the clock. */
async function theySay(twilio, timers, ms, payload = LOUD) {
  for (let i = 0; i < ms / 20; i++) { twilio.say({ event: "media", media: { payload } }); await timers.advance(20); }
}

// ---------- 1. holding lines are code's ----------

test("holding: the voice's own 'let me check' is cancelled at once, and an answer inside 1.5 s gets no holding line", async () => {
  const { timers, live } = startCall({ brain: () => new Promise(r => timers.setTimeout(() => r({ text: "Tuesday's Bo Peep, from seven.", tools: [] }), 1200)) });
  live.emit({ type: "session.input_transcript.delta", delta: " Where am I going Tuesday?" });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_1" } });
  await timers.advance(5);
  const quiet = live.of("session.thinking.append").find(e => e.delegation_id === "item_1");
  assert.ok(quiet, "the automatic acknowledgement is cancelled the moment the hand-off starts");
  assert.equal(quiet.content, gl.WAIT_NOTE, "a factual quiet update, which cancels it as an empty one does (the docs)");
  assert.equal(live.of("session.start")[0].session.delegation.acknowledgement_delay_ms, gl.ACK_DELAY_MS);
  await timers.advance(2000);
  assert.equal(holds(live).length, 0, "ready at 1.2 s: no holding line at all");
  assert.equal(live.of("session.commentary.append").find(e => e.delegation_id === "item_1").content, "Tuesday's Bo Peep, from seven.");
});

test("holding: a slow answer with no lookup running gets no line at 1.5 s — no 'one sec' stalling (call 80) — only the late one", async () => {
  let release;
  const { timers, live, lines } = startCall({ brain: () => new Promise(r => { release = r; }) });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_2" } });
  await timers.advance(3000);
  assert.equal(holds(live).length, 0, "nothing is being looked up, so nothing is said into the wait");
  await timers.advance(voice.LATE_HOLDING_MS - 3000 + 50);
  const h = holds(live);
  assert.equal(h.length, 1, "the late line, so a long wait is never dead air");
  const said = /"([^"]+)"/.exec(h[0].content)[1];
  assert.ok(voice.LATE_LINES.includes(said) && !/check|look/i.test(said), said);
  assert.equal(lines.filter(l => l.gptlive_hold_line).length, 1);
  release({ text: "You said seven or later.", tools: [] });
  await timers.advance(10);
  assert.equal(holds(live).length, 1, "the answer, not a second line");
});

test("holding: 'let me check' only while one of Reason's tools is really running", async () => {
  let release;
  const { timers, live } = startCall({ brain: (m, hooks) => new Promise(r => { release = r; timers.setTimeout(() => hooks.onTool("web_search"), 400); }) });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_3" } });
  await timers.advance(1600);
  const said = /"([^"]+)"/.exec(holds(live)[0].content)[1];
  assert.ok(gl.CHECK_HOLD_LINES.includes(said), said);
  release({ text: "It's 54 and clear.", tools: ["web_search"] });
  await timers.advance(10);
});

test("holding: a few words of the voice's own don't leave dead air after them — the line waits for it to finish", async () => {
  const { timers, live } = startCall({ brain: (m, hooks) => { hooks.onTool("web_search", "start"); return new Promise(() => {}); } });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_7" } });
  await timers.advance(1000);
  live.emit({ type: "session.output_audio.delta", delta: LOUD }); // "Yeah —"
  await timers.advance(600);
  assert.equal(holds(live).length, 0, "not over the voice");
  await timers.advance(1000);
  assert.equal(holds(live).length, 1, "once it has been quiet 1.2 s");
});

test("holding: a wait on a send is not 'checking', and gets no first line", async () => {
  const { timers, live } = startCall({ brain: (m, hooks) => { hooks.onTool("message_send", "start"); return new Promise(() => {}); } });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_8" } });
  await timers.advance(1600);
  assert.equal(holds(live).length, 0);
  await timers.advance(voice.LATE_HOLDING_MS);
  assert.doesNotMatch(/"([^"]+)"/.exec(holds(live)[0].content)[1], /check|look/i);
  assert.equal(gl.isLookup("web_search"), true);
  assert.equal(gl.isLookup("calendar_events"), true);
  assert.equal(gl.isLookup("timer_set"), false);
});

test("holding: 'check' only WHILE the lookup runs — once it has come back, a later line never says it (call 80)", async () => {
  const { timers, live } = startCall({ brain: (m, hooks) => { hooks.onTool("web_search", "start"); timers.setTimeout(() => hooks.onTool("web_search", "done", { ok: true }), 1000); return new Promise(() => {}); } });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_9" } });
  await timers.advance(voice.LATE_HOLDING_MS + 50);
  const said = holds(live).map(h => /"([^"]+)"/.exec(h.content)[1]);
  assert.equal(said.length, 1, "no first line: the lookup was over by 1.5 s");
  for (const s of said) assert.doesNotMatch(s, /check|look/i);
});

test("holding: still nothing at the late deadline gets a late line (no dead air), never 'Still checking' without a tool", async () => {
  const { timers, live } = startCall({ brain: () => new Promise(() => {}) });
  live.emit({ type: "session.delegation.created", delegation: { id: "item_4" } });
  await timers.advance(voice.LATE_HOLDING_MS + 50);
  const h = holds(live);
  assert.equal(h.length, 1, "the late one");
  const late = /"([^"]+)"/.exec(h[0].content)[1];
  assert.ok(voice.LATE_LINES.includes(late));
  for (let n = 0; n < 12; n++) assert.notEqual(gl.holdLineFor({ kind: "late", tool: false, n }), "Still checking.");
  assert.ok(Array.from({ length: 6 }, (_, n) => gl.holdLineFor({ kind: "late", tool: true, n })).includes("Still checking."), "with a tool it may");
});

test("holding: no line while they are still talking, and none on a business line", async () => {
  const { timers, twilio, live } = startCall({ brain: () => new Promise(() => {}) });
  await theySay(twilio, timers, 1000, SILENT);
  live.emit({ type: "session.delegation.created", delegation: { id: "item_5" } });
  await theySay(twilio, timers, 1300, SILENT);
  await theySay(twilio, timers, 400, LOUD);
  assert.equal(holds(live).length, 0, "they spoke at 1.5 s: nothing said into it");
  const third = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "ask about a table", facts: [], announcement: "", state: "placing" });
  const b = startCall({ row: third, brain: () => new Promise(() => {}) });
  b.live.emit({ type: "session.delegation.created", delegation: { id: "item_6" } });
  await b.timers.advance(3000);
  assert.equal(holds(b.live).length, 0, "a line call never gets a code holding line");
});

test("holding: the voice is told never to hold the line itself; the old 'a very short acknowledgement is fine' is gone", () => {
  const s = gl.liveInstructions({ name: "Omari", named: true, owner: true });
  assert.ok(s.includes(gl.NO_HOLDING_LINE));
  assert.doesNotMatch(s, /very short acknowledgement is fine|Only use a holding phrase/);
  assert.match(gl.NO_HOLDING_LINE, /no "let me check", "looking that up", "hang on" or "one sec"/);
  assert.ok(gl.strangerInstructions().includes(gl.NO_HOLDING_LINE));
});

test("onTool: Reason's own tools are reported as they start, the call's platform tools never", async () => {
  const call = ownerCall();
  const seen = [];
  const out = await voice.llmRequest({
    rawBody: JSON.stringify({ model: "reason", messages: [{ role: "user", content: "what's the weather" }], extra_body: { reason_call_id: call.id, reason_conversation_id: C } }),
    screen: async () => ({ verdict: "clear" }),
    onTool: (n, phase) => seen.push(`${n}:${phase}`),
    generate: async function* ({ messages }) {
      if (messages.some(m => Array.isArray(m.content) && m.content.some(b => b?.type === "tool_result"))) { yield { type: "text", text: "Clear and 54." }; return; }
      yield { type: "tool_start", name: "skip_turn" };
      yield { type: "tool_start", name: "web_search" };
      yield { type: "tool_use", id: "t1", name: "web_search", input: { query: "weather" } };
    },
  });
  for await (const _ of out.stream) { /* drain */ }
  assert.deepEqual([...new Set(seen)], ["web_search:start", "web_search:done"], "started, then ran (call 80: what ran is known)");
});

// ---------- 3. today so far ----------

const at = (iso) => Date.parse(iso);
const clockAt = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };
function seedToday() {
  db.writeMessage({ conversationId: C, role: "user", channel: "sendblue", text: "I want a place in Manhattan with a nice bar that's active on a Tuesday night", at: at("2026-11-08T17:08:20Z") });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "sendblue", text: "My pick is Bo Peep. It's the cocktail bar downstairs from The Ragtrader, at 70 W 36th St in Midtown, and it has a sing-along night.", at: at("2026-11-08T17:08:58Z") });
  db.writeMessage({ conversationId: C, role: "user", channel: "sendblue", text: "Oh yeah. Will head there around like 7 pm or later", at: at("2026-11-08T17:14:48Z") });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "sendblue", text: "Done, I'll text you Tuesday at 6pm.", at: at("2026-11-08T17:15:04Z") });
  // Somebody else's thread, the same afternoon: never in Omari's call.
  db.writeMessage({ conversationId: OTHER, role: "assistant", channel: "sendblue", text: "Your pick is Sunny's Diner on Elm Street.", at: at("2026-11-08T18:00:00Z") });
  // Yesterday, and after the call was made: neither is today-so-far.
  db.writeMessage({ conversationId: C, role: "assistant", channel: "sendblue", text: "Old news about Kweku Market.", at: at("2026-11-07T01:00:00Z") });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "sendblue", text: "Written after the call began at Hertz.", at: at("2026-11-08T20:10:00Z") });
}

test("today so far: the caller's own thread today, with the names in it, up to when the call was made — nobody else's", () => {
  seedToday();
  const until = at("2026-11-08T19:57:00Z");
  const t = brief.todaySoFar(C, { until, tz: "America/New_York" });
  assert.equal(t.lines.length, 4);
  assert.match(t.lines[1], /^12:08 PM you: My pick is Bo Peep/);
  assert.ok(t.names.includes("Bo Peep"), t.names.join(", "));
  assert.ok(t.names.includes("The Ragtrader"), t.names.join(", "));
  assert.ok(!t.names.some(n => /^(My|It's|Done|Oh|Tuesday|I)$/.test(n)), t.names.join(", "));
  const all = JSON.stringify(t);
  for (const x of ["Sunny", "Kweku", "Hertz"]) assert.ok(!all.includes(x), `${x} is not today-so-far`);
  assert.equal(brief.todaySoFar(OTHER, { until: at("2026-11-08T17:30:00Z") }), null, "her thread had nothing by then");
  const note = brief.todaySoFarNote(C, { until });
  assert.match(note, /^TODAY SO FAR/);
  assert.match(note, /Names from today: Bo Peep, The Ragtrader/);
});

test("today so far: in Reason's own-call prompt (the same on every turn) and the voice's brief; another user's call gets only hers", async () => {
  seedToday();
  clockAt(at("2026-11-08T19:57:00Z"));
  const row = ownerCall();
  await voice.prime();
  const a = voice.contextFor({ call: row, kind: "owner", callMessages: [] }).system;
  assert.match(a, /TODAY SO FAR[\s\S]*Bo Peep/);
  db.writeMessage({ conversationId: C, role: "assistant", channel: "sendblue", text: "A text sent during the call about Nobu.", at: at("2026-11-08T19:58:00Z") });
  clockAt(at("2026-11-08T19:59:30Z"));
  const b = voice.contextFor({ call: db.getCall(C, row.id), kind: "owner", callMessages: [{ role: "user", content: "hi" }] }).system;
  assert.equal(a, b, "byte-identical later in the call, so the prompt cache holds");
  assert.match(prompt.ownerCallFrame({ name: "Omari" }), /Before you ever say you have nothing on something they mention, look first/);
  assert.match(prompt.ownerCallFrame({ name: "Omari" }), /match it against the names from today/);
  assert.match(gl.preCallBrief(row), /Names from your chats today[^\n]*Bo Peep/);
  const hers = db.createCall(OTHER, { provider: "gptlive", toNumber: "+13105550000", isOwner: true, goal: "g", facts: [], announcement: "hey Ama", state: "placing" });
  const hs = voice.contextFor({ call: hers, kind: "owner", callMessages: [] }).system + gl.preCallBrief(hers);
  assert.ok(!/Bo Peep|Ragtrader/.test(hs), "nothing of Omari's in Ama's call");
  assert.match(hs, /Sunny's Diner/, "hers is hers");
});

test("today so far: with no message history kept, the thread's own lines stamped today", () => {
  config.web = false;
  db.saveConversation(C, [
    { role: "user", content: "[Sat, Nov 7, 2026, 9:00 PM] Omari: anything for tonight?" },
    { role: "assistant", content: "Try Kweku Market." },
    { role: "user", content: "[Sun, Nov 8, 2026, 12:08 PM] Omari: a bar for Tuesday?" },
    { role: "assistant", content: "My pick is Bo Peep, downstairs from The Ragtrader." },
  ]);
  const t = brief.todaySoFar(C, { until: at("2026-11-08T19:57:00Z") });
  assert.deepEqual(t.lines, ["them: a bar for Tuesday?", "you: My pick is Bo Peep, downstairs from The Ragtrader."]);
  assert.ok(!JSON.stringify(t).includes("Kweku"), "yesterday's is not today's");
});

// ---------- 6. limits ----------

test("limits: a limit they set is said back once and every suggestion fits inside it", () => {
  const frame = prompt.ownerCallFrame({ name: "Omari" });
  assert.match(frame, /When they set a limit — a time \("7 or later"\)/);
  assert.match(frame, /only suggest things inside it, fitted to it/);
});

// ---------- 4. talk-over ----------

async function greeted() {
  const s = startCall({ brain: () => new Promise(() => {}) });
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD }); // the greeting
  await theySay(s.twilio, s.timers, 1500, SILENT);
  return s;
}

test("talk-over: on the first exchange a reply that starts while they are still talking waits for 700 ms of quiet", async () => {
  const { timers, twilio, live, lines } = await greeted();
  const before = twilio.media();
  await theySay(twilio, timers, 600, LOUD); // "Doing pretty well, how are —"
  live.emit({ type: "session.output_audio.delta", delta: LOUD }); // "I'm —"
  live.emit({ type: "session.output_audio.delta", delta: LOUD });
  assert.equal(twilio.media() - before, 0, "nothing goes out over them");
  live.emit({ type: "session.input_transcript.delta", delta: " how are you" }); // their words come through
  await theySay(twilio, timers, 200, LOUD); // "— you"
  await theySay(twilio, timers, 600, SILENT);
  assert.equal(twilio.media() - before, 0, "600 ms of quiet is not enough on the first exchange");
  await theySay(twilio, timers, 200, SILENT);
  assert.equal(twilio.media() - before, 2, "the held reply goes out, whole, once they have stopped");
  const held = lines.find(l => l.gptlive_talkover_held);
  assert.ok(held && held.first === true && held.held_ms >= 850 && held.held_ms < 1200, JSON.stringify(held));
});

test("talk-over: after the first exchange it waits 300 ms; a reply that starts after they stopped is never delayed", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  await theySay(s.twilio, s.timers, 800, SILENT);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD }); // first exchange, after 800 ms quiet: straight out
  let before = s.twilio.media();
  assert.equal(before > 0, true);
  await theySay(s.twilio, s.timers, 1500, SILENT);
  before = s.twilio.media();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  s.live.emit({ type: "session.input_transcript.delta", delta: " so anyway" });
  assert.equal(s.twilio.media() - before, 0, "held while they talk");
  await theySay(s.twilio, s.timers, 320, SILENT);
  assert.equal(s.twilio.media() - before, 1, "out after 300 ms of quiet");
  await theySay(s.twilio, s.timers, 1500, SILENT);
  await theySay(s.twilio, s.timers, 400, LOUD);
  await theySay(s.twilio, s.timers, 500, SILENT);
  before = s.twilio.media();
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  assert.equal(s.twilio.media() - before, 1, "an ordinary turn goes out the moment it arrives");
});

test("talk-over: if they keep talking it was an answer to half a sentence — dropped, the voice told, and asked to answer once they stop", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  s.live.emit({ type: "session.output_transcript.delta", delta: "I'm good" });
  const before = s.twilio.media();
  // They keep talking; the voice keeps sending its reply as it is generated.
  for (let ms = 0; ms < gl.TALKOVER_MAX_MS + 200; ms += 100) {
    await theySay(s.twilio, s.timers, 100, LOUD);
    s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
    // Their words come through inside the wordless cap (TALKOVER_WORDLESS_MS): it is them, not the line.
    if (ms === 300) s.live.emit({ type: "session.input_transcript.delta", delta: " and also I wanted to ask" });
  }
  assert.ok(s.lines.some(l => l.gptlive_talkover_dropped));
  assert.ok(s.live.of("session.thinking.append").some(e => /did not hear what you just started/.test(e.content)));
  assert.equal(s.twilio.media() - before, 0, "none of it was played, before or after the drop");
  assert.ok(!s.call.turns.some(x => x.who === "reason" && /I'm good/.test(x.text)), "and it is off the transcript");
  await theySay(s.twilio, s.timers, 1200, SILENT);
  assert.ok(s.live.of("session.commentary.append").some(e => /didn't hear your last reply/.test(e.content)), "nothing left as dead air");
});

test("talk-over: after a drop, the silence the session streams never keeps it alive — the next reply plays", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  for (let ms = 0; ms < gl.TALKOVER_MAX_MS + 200; ms += 100) {
    await theySay(s.twilio, s.timers, 100, LOUD);
    s.live.emit({ type: "session.output_audio.delta", delta: SILENT }); // the session's own silence, all along
    if (ms === 300) s.live.emit({ type: "session.input_transcript.delta", delta: " and also" });
  }
  assert.ok(s.lines.some(l => l.gptlive_talkover_dropped));
  for (let i = 0; i < 20; i++) { await theySay(s.twilio, s.timers, 100, SILENT); s.live.emit({ type: "session.output_audio.delta", delta: SILENT }); }
  const loud = () => s.twilio.sent.filter(m => m.event === "media" && m.media.payload === LOUD).length + (s.call.voiceTail === LOUD ? 1 : 0);
  const before = loud();
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD }); // its real answer, later
  assert.equal(loud() - before, 1, "heard");
});

test("talk-over: a noisy line with no words through is never dead air — the run goes out by 3.5 s", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  const before = s.twilio.media();
  await theySay(s.twilio, s.timers, gl.TALKOVER_MAX_MS + gl.TALKOVER_NOISE_MS + 100, LOUD);
  assert.ok(s.twilio.media() - before >= 1, "played, not dropped");
  assert.ok(!s.lines.some(l => l.gptlive_talkover_dropped));
});

test("talk-over: a fragment the voice gave up on ('I'm —') is not played late", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  s.live.emit({ type: "session.output_transcript.delta", delta: "I'm" });
  const before = s.twilio.media();
  await theySay(s.twilio, s.timers, 600, LOUD);
  await theySay(s.twilio, s.timers, 800, SILENT);
  assert.equal(s.twilio.media() - before, 0);
  assert.ok(s.lines.some(l => l.gptlive_talkover_dropped && l.why === "a fragment"));
});

test("talk-over: a held claim the guard stops is thrown away with the rest of the unplayed audio", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  s.live.emit({ type: "session.output_transcript.delta", delta: " Great, I've booked it for seven." });
  assert.ok(s.live.of("session.instructions.append").some(e => e.content === gl.GUARD_CORRECTION));
  const before = s.twilio.media();
  await theySay(s.twilio, s.timers, 1000, SILENT);
  assert.equal(s.twilio.media() - before, 0, "the claim never plays");
});

test("talk-over: a barge-in clear leaves a held reply waiting for them, not thrown away", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  s.call.clearPlayback("barge_in");
  const before = s.twilio.media();
  await theySay(s.twilio, s.timers, 800, SILENT);
  assert.ok(s.twilio.media() - before >= 1, "played once they stopped");
});

test("talk-over: a goodbye held while they finish goes out before the hang-up waits on it", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  const before = s.twilio.media();
  s.call.hangUpAfterSpeech("end_call");
  assert.equal(s.twilio.media() - before, 1, "released at once");
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  assert.equal(s.twilio.media() - before, 2, "and nothing more is held while it ends");
});

test("talk-over: the echo of the voice's own words is not them talking", async () => {
  const s = await greeted();
  await theySay(s.twilio, s.timers, 400, LOUD);
  await theySay(s.twilio, s.timers, 1000, SILENT);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD }); // a reply, played
  await theySay(s.twilio, s.timers, 300, LOUD); // their phone's echo of it
  await theySay(s.twilio, s.timers, 100, SILENT);
  const before = s.twilio.media();
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  assert.equal(s.twilio.media() - before, 1, "not held for its own echo");
});

// ---------- 5. warm-up ----------

test("warm-up: an own call's prompt is cached while it rings; an errand's once its opening is settled; off switch", async () => {
  const warmed = [];
  const fakeWarm = (a) => { warmed.push(a.call); return Promise.resolve({ warmed: true }); };
  const row = ownerCall();
  assert.ok(gl.warmTheTurn(row, () => {}, { warm: fakeWarm }));
  assert.equal(warmed[0].id, row.id);
  config.callCacheWarm = false;
  assert.equal(gl.warmTheTurn(row, () => {}, { warm: fakeWarm }), null);
  config.callCacheWarm = true;
  assert.equal(await gl.warmTheTurn(row, () => {}, { warm: () => { throw new Error("boom"); } }), null, "never throws");

  const posted = [];
  const fetchImpl = async (url, init) => { posted.push(String(init.body)); return { ok: true, status: 201, json: async () => ({ sid: "CA77" }) }; };
  const logs = [];
  const p = gl.withGptLive({ place: async () => ({ ok: true }), check: async () => ({}), status: () => ({}) }, { fetchImpl });
  const was = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await p.place({ to: "+12025551234", kind: "owner", conversationId: C, callId: row.id, log: (o) => logs.push(o) });
    await new Promise(r => setTimeout(r, 30));
  } finally { if (was !== undefined) process.env.ANTHROPIC_API_KEY = was; }
  assert.equal(posted.length, 1);

  const seen = [];
  const third = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "ask about a table", facts: [], announcement: "", state: "placing" });
  startCall({ row: third, brain: () => new Promise(() => {}), warmTurn: (r) => seen.push(r) });
  assert.equal(seen.length, 1, "an errand: warmed at the stream's start");
  assert.equal(seen[0].id, third.id);
  const own = startCall({ brain: () => new Promise(() => {}), warmTurn: (r) => seen.push(r) });
  assert.equal(seen.length, 1, "an own call was warmed while it rang, not again at pickup");
  assert.ok(own);
});

test("warm-up: the request sent while it rings carries the exact prefix the first real turn sends", async () => {
  seedToday();
  clockAt(at("2026-11-08T19:57:00Z"));
  const row = ownerCall();
  await voice.prime();
  const sent = [];
  const client = { messages: { create: async (body) => { sent.push(body); return { usage: {} }; } } };
  const was = config.callBackend;
  config.callBackend = "api";
  try { await voice.warmCallCache({ call: row, client }); } finally { config.callBackend = was; }
  // The call picks up, state moves on, a text goes out mid-call — then the first real turn.
  db.updateCall(C, row.id, { state: "in_progress" });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "sendblue", text: "Calling you now.", at: at("2026-11-08T19:57:10Z") });
  clockAt(at("2026-11-08T19:57:20Z"));
  let got = null;
  const out = await voice.llmRequest({
    rawBody: JSON.stringify({ model: "reason", messages: [{ role: "assistant", content: "Hey Omari, what's up?" }, { role: "user", content: "where am I going Tuesday?" }], extra_body: { reason_call_id: row.id, reason_conversation_id: C } }),
    screen: async () => ({ verdict: "clear" }),
    generate: async function* (g) { got = g; yield { type: "text", text: "Bo Peep." }; },
  });
  for await (const _ of out.stream) { /* drain */ }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].system[0].text, got.system, "the same system text, byte for byte");
  assert.deepEqual(sent[0].tools.map(t => t.name), got.tools.map(t => t.name), "the same tools, in the same order");
  assert.deepEqual(sent[0].tools, got.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })));
});
