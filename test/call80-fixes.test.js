// Call 80 (2026-11-08, Omari's own GPT-Live call, 104 s): the fixes, pinned. No network: the voice
// session, the Twilio stream, Reason's model and the weather service are stand-ins.
//   1. no code cut; the spoken answer is the words after the last tool, never the lead-in before it
//   2. which of Reason's tools really ran is known, so a real "sent" stands (18:06:22)
//   3. Claude's call turn sees his rules, the facts closest to his words, his places and his week
//   4. the answer streams to the voice sentence by sentence; a wordless talk-over hold is capped
//   5. the room is half as loud again
//   6. the weather comes by coordinates (Open-Meteo), with its age
//   7. a fade at the end of each line; the voice is told no "uh", "um" or "let me check" of its own
//   fix 2: on his own call the voice is Reason itself, with his brief — anyone else keeps the relay
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call80-"));
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
const prompt = await import("../src/calls/voice-prompt.js");
const amb = await import("../src/calls/ambience.js");
const cm = await import("../src/calls/callmemory.js");
const weather = await import("../src/weather.js");
const tools = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM saved_places; DELETE FROM treat_rules;");
  try { db.db.exec("DELETE FROM call_turns"); } catch { /* fresh db */ }
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callIdentity: false, callVoice: "gptlive", callCacheWarm: false, callHearing: true, openaiKey: "sk-test", twilioSid: "AC_t", twilioToken: "t", twilioFrom: "+16562167455" });
  cm.resetCallMemory();
  await voice.prime();
});

const ownerCall = (conversationId = C) => db.createCall(conversationId, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "Omari asked to be called", facts: [],
  announcement: "Hey Omari, what's up?", state: "in_progress",
});
const bodyFor = (call, messages = [{ role: "user", content: "can you check what the weather is like where I'm at" }]) => JSON.stringify({
  model: "reason", messages, extra_body: { reason_call_id: call.id, reason_conversation_id: call.conversation_id },
});
async function drain(stream) {
  let said = "";
  for await (const s of stream) {
    if (!s.startsWith("data: ") || s.includes("[DONE]")) continue;
    said += JSON.parse(s.slice(6)).choices[0].delta.content ?? "";
  }
  return said;
}
/** A turn of rounds, each a list of events: strings are text deltas, objects a tool call. */
const rounds = (...batches) => {
  let i = 0;
  return async function* () {
    for (const e of batches[Math.min(i++, batches.length - 1)] ?? []) {
      if (typeof e === "string") yield { type: "text", text: e };
      else { if (e.start) yield { type: "tool_start", name: e.tool }; yield { type: "tool_use", name: e.tool, id: `tu_${Math.random().toString(16).slice(2, 8)}`, input: e.input ?? {} }; }
    }
  };
};
const turn = (call, generate, extra = {}) => voice.llmRequest({ rawBody: bodyFor(call), screen: async () => ({ verdict: "clear" }), generate, recallWaitMs: 0, ...extra });

// ---------- 1. the answer is what comes after the tool ----------

test("1. call 80's hand-off 1: the lead-in before the tool is not said; the weather after it is, whole", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true, source: "saved_places" });
  const lines = [];
  const out = await turn(ownerCall(), rounds(
    ["I'll grab your location first. ", { tool: "get_location", start: true }],
    ["You're at work on a Sunday, so that's Chelsea: fifty nine and clear, high of sixty two. ", "Light jacket weather."],
  ), { log: (l) => lines.push(l) });
  const said = await drain(out.stream);
  assert.doesNotMatch(said, /grab your location/, "the lead-in is never said");
  assert.match(said, /fifty nine and clear, high of sixty two\. Light jacket weather\./, "the answer, every sentence of it");
  assert.ok(lines.some(l => l.voice_lead_in_dropped), "and logged");
});

test("1. streamed like the API: a short round before a tool is a lead-in, every sentence of it; a long round streams", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true });
  const out2 = await turn(ownerCall(), rounds(
    ["Got it", ". Work", " at 430 West", " 17th.", { tool: "weather", start: true, input: { place: "work" } }],
    ["Fifty nine", " and clear."],
  ));
  const said = await drain(out2.stream);
  // Cold review: "Got it." said ahead of the tool started the answer and ended the holding lines.
  assert.doesNotMatch(said, /Got it|430 West 17th/, "two short sentences right before a tool: the lead-in, both dropped");
  assert.equal(said.trim(), "Fifty nine and clear.");
  const LONG = "Here's the news from Nigeria today, in short. The central bank held rates at twenty seven and a half percent this week, the third hold in a row, and said prices are finally easing. ";
  assert.ok(LONG.length > voice.LEAD_IN_HOLD_CHARS);
  const out3 = await turn(ownerCall(), rounds([LONG, "Lagos opened the new rail line. ", "That's the top of it."]));
  assert.match((await drain(out3.stream)).trim(), /^Here's the news[^]*That's the top of it\.$/, "a long round is said whole, streaming once past the hold");
});

test("1. a round after the tools that says nothing: the words before them were the answer, and are said", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true });
  const lines = [];
  const out = await turn(ownerCall(), rounds(
    ["That's the seven o'clock at Bo Peep, forty deposit. Want me to book it? ", { tool: "web_search", start: true }],
    [],
  ), { log: (l) => lines.push(l) });
  const said = await drain(out.stream);
  assert.match(said, /Want me to book it\?/);
  assert.ok(lines.some(l => l.voice_lead_in_said));
});

// Drive 11-08 (OVH, gptlive-drive wx): the code's holding line went out while the tools ran, so the
// turn counted as "said something" and the words before the tools were lost — the caller heard only
// "Still working on it. Let me come back to you on that one."
const slowRounds = (delays, ...batches) => {
  let i = 0;
  return async function* () {
    const n = i++;
    const batch = batches[Math.min(n, batches.length - 1)] ?? [];
    await new Promise(r => setTimeout(r, delays[Math.min(n, delays.length - 1)]));
    for (const e of batch) {
      if (typeof e === "string") yield { type: "text", text: e };
      else { yield { type: "tool_start", name: e.tool }; yield { type: "tool_use", name: e.tool, id: `tu_${Math.random().toString(16).slice(2, 8)}`, input: {} }; }
    }
  };
};
const ASK = "I can't see where you are right now. Where are you? ";

test("1. a holding line said mid-turn is not the model's words: a silent last round still says the words before the tools", async () => {
  voice.contextDeps.runTool = async () => ({ ok: false, error: "no location" });
  const lines = [];
  const out = await turn(ownerCall(), slowRounds([0, 60], [ASK, { tool: "get_location" }], []),
    { log: (l) => lines.push(l), firstWordDeadlineMs: 20, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
  const said = await drain(out.stream);
  assert.ok(lines.some(l => l.voice_holding_line), "the holding line went out first (the case under test)");
  assert.match(said, /Where are you\?/, "the question it asked as it called the tool is said");
  assert.doesNotMatch(said, /come back to you/);
});

test("1. a holding line said mid-turn is not the model's words: out of rounds, the last lead-in comes before the come-back line", async () => {
  voice.contextDeps.runTool = async () => ({ ok: false, error: "no location" });
  const lines = [];
  const out = await turn(ownerCall(), slowRounds([0, 60], [ASK, { tool: "get_location" }], [{ tool: "get_location" }], [{ tool: "weather" }]),
    { log: (l) => lines.push(l), firstWordDeadlineMs: 20, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
  const said = await drain(out.stream);
  assert.ok(lines.some(l => l.voice_holding_line), "the holding line went out first (the case under test)");
  assert.match(said, /Where are you\?[^]*Let me come back to you on that one\.$/);
  assert.ok(lines.some(l => l.voice_lead_in_said && l.out_of_rounds));
});

test("1. no code cut: a long answer reaches the voice whole, and code never adds an offer to text the rest", async () => {
  const LONG = "Here's the latest from Nigeria. The central bank held rates at twenty seven and a half percent. Lagos opened the new rail line to Ikeja. The Super Eagles qualified for the Cup of Nations. There's more — want me to text you the rest?";
  const s = startCall({ brain: async (m, hooks) => { for (const p of voice.sentenceSplitter().push(`${LONG} `)) hooks.onContent?.(p.trim()); return { text: LONG, tools: [] }; } });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d1" } });
  await s.timers.advance(10);
  const said = s.live.of("session.commentary.append").filter(e => e.delegation_id === "d1").map(e => e.content).join(" ");
  assert.equal(said, LONG, "every word, the model's own offer included (a naturally long answer)");
  assert.equal(gl.shortForPhone, undefined);
  assert.equal(gl.TEXT_REST_OFFER, undefined);
  assert.ok(!s.lines.some(l => "gptlive_reply_cut" in l));
  const plain = startCall({ brain: async (m, hooks) => { hooks.onContent?.("You've got the dentist at nine thirty."); return { text: "You've got the dentist at nine thirty.", tools: [] }; } });
  plain.live.emit({ type: "session.delegation.created", delegation: { id: "d2" } });
  await plain.timers.advance(10);
  assert.doesNotMatch(plain.live.of("session.commentary.append").map(e => e.content).join(" "), /text you the rest/, "an ordinary answer gets no offer");
});

test("1. the call turn is told: write only what should be heard, offer the rest only when the content is naturally long, send it if they take it", () => {
  const frame = prompt.ownerCallFrame({ name: "Omari" });
  assert.match(frame, /never narrate what you are about to do/);
  assert.match(frame, /Only when the content itself is naturally long — headlines, a list of options, directions/);
  assert.match(frame, /An ordinary answer never ends on that offer/);
  assert.match(frame, /send it with message_send to "owner" in that turn, and say it's sent only after the send/);
});

// ---------- 2. what really ran ----------

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
function startCall({ brain, row = ownerCall() } = {}) {
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const lines = [];
  const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live.socket, brain, now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "live_1" } });
  return { call, timers, twilio, live, lines, row };
}
const LOUD = Buffer.alloc(160, 0x00).toString("base64");
const SILENT = Buffer.alloc(160, 0xff).toString("base64");

test("2. call 80 18:06:22: a send that ran makes its 'sent' true — it is said, not swapped for 'I'll text that to you'", async () => {
  const s = startCall({
    brain: async (m, hooks) => {
      hooks.onTool("message_send", "start");
      hooks.onTool("message_send", "done", { ok: true });
      hooks.onContent("Sent you the weather near work.");
      return { text: "Sent you the weather near work.", tools: [] };
    },
  });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "s1" } });
  await s.timers.advance(10);
  const said = s.live.of("session.commentary.append").filter(e => e.delegation_id === "s1").map(e => e.content).join(" ");
  assert.equal(said, "Sent you the weather near work.");
  assert.ok(!s.lines.some(l => "gptlive_unbacked_send" in l));
  assert.deepEqual(s.lines.find(l => "gptlive_result" in l).tools, ["message_send"], "the result names the tool that ran");
});

test("2. a 'sent' with no send behind it (or one that failed) is still taken out, the honest line said once", async () => {
  const s = startCall({
    brain: async (m, hooks) => {
      hooks.onTool("message_send", "start");
      hooks.onTool("message_send", "done", { ok: false });
      hooks.onContent("I've texted you the lot.");
      hooks.onContent("Just sent it.");
      hooks.onContent("Anything else?");
      return { text: "", tools: [] };
    },
  });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "s2" } });
  await s.timers.advance(10);
  const said = s.live.of("session.commentary.append").filter(e => e.delegation_id === "s2").map(e => e.content);
  assert.deepEqual(said, ["I'll text that to you.", "Anything else?"]);
});

// ---------- 3. the same memory as a text ----------

test("3. Claude's call turn: his rules, his saved places and his week (read by meaning, once per call) — his own only", async () => {
  db.addRule(C, { rule: "on a call, just say the answer out loud" });
  db.addRule(OTHER, { rule: "call me Ama-ji" });
  db.savePlace(C, { name: "work", address: "430 W 17th St, New York", lat: 40.7429, lng: -74.0061 });
  db.savePlace(OTHER, { name: "home", address: "1 Elm St, Springfield", lat: 39.8, lng: -89.6 });
  const fact = db.remember(C, "Omari", "Works Thu to Sun shifts, 8am to 8pm");
  const id = fact?.factId;
  const call = ownerCall();
  let asked = 0;
  const find = async (conv, q) => { asked++; assert.equal(conv, C, "only his own facts are searched"); assert.match(q, /schedule/); return [{ factId: id, score: 0.8 }]; };
  await cm.prepareCallMemory(call, { find, enabled: true });
  await cm.prepareCallMemory(call, { find, enabled: true });
  assert.equal(asked, 1, "read once per call, so every turn sends the same prefix");
  const ctx = voice.contextFor({ call, kind: "owner" });
  assert.match(ctx.system, /HOW THEY WANT YOU TO TREAT THEM[^]*on a call, just say the answer out loud/);
  assert.match(ctx.system, /WHERE THEY USUALLY ARE[^]*work: 430 W 17th St, New York[^]*Works Thu to Sun shifts/);
  assert.doesNotMatch(ctx.system, /Ama-ji|Elm St/, "nobody else's");
  assert.match(ctx.system, /use the saved place their schedule puts them at right now/);
  assert.match(ctx.system, /send the Share My Location card \(get_location action 'request'\) and tell them you've texted it/);
});

test("3. per turn: the facts closest to his words ride in front of them (never as his words); a slow search is skipped, not waited on", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true });
  const seen = [];
  const prev = voice.contextDeps.recall;
  try {
    voice.contextDeps.recall = async (conv, text) => { assert.equal(conv, C); assert.match(text, /weather/); return ["- Omari: Works Thu to Sun shifts (saved Nov 1)"]; };
    const out = await voice.llmRequest({ rawBody: bodyFor(ownerCall()), screen: async () => ({ verdict: "clear" }), recallWaitMs: 500, generate: async function* ({ messages }) { seen.push(messages); yield { type: "text", text: "Fifty nine at work." }; } });
    await drain(out.stream);
    const last = seen[0].at(-1);
    assert.equal(last.role, "user");
    assert.match(last.content[0].text, /What you remember that may bear on this[^]*Works Thu to Sun shifts/);
    assert.equal(last.content.at(-1).text, "can you check what the weather is like where I'm at", "their words stay theirs, last");
    voice.contextDeps.recall = () => new Promise(r => setTimeout(() => r(["- late"]), 300));
    const lines = [];
    const out2 = await voice.llmRequest({ rawBody: bodyFor(ownerCall()), screen: async () => ({ verdict: "clear" }), recallWaitMs: 20, log: (l) => lines.push(l), generate: async function* ({ messages }) { seen.push(messages); yield { type: "text", text: "Ok." }; } });
    await drain(out2.stream);
    assert.ok(lines.some(l => l.call_recall_late));
    assert.doesNotMatch(JSON.stringify(seen[1].at(-1)), /late/);
  } finally { voice.contextDeps.recall = prev; }
});

// ---------- 4. sooner ----------

test("4. streaming: the first sentence reaches the voice while Reason is still writing the rest", async () => {
  let finish;
  const s = startCall({ brain: (m, hooks) => new Promise(r => { hooks.onContent("Fifty nine and clear at work."); finish = () => { hooks.onContent("High of sixty two."); r({ text: "", tools: [] }); }; }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "f1" } });
  await s.timers.advance(5);
  const first = s.live.of("session.commentary.append").filter(e => e.delegation_id === "f1");
  assert.equal(first.length, 1, "said before the turn is over");
  assert.equal(first[0].content, "Fifty nine and clear at work.");
  finish();
  await s.timers.advance(5);
  const all = s.live.of("session.commentary.append").filter(e => e.delegation_id === "f1");
  assert.deepEqual(all.map(e => e.content), ["Fifty nine and clear at work.", "High of sixty two."]);
  assert.equal(new Set(all.map(e => e.event_id)).size, 2, "each piece its own event on the same delegation");
  const r = s.lines.find(l => "gptlive_result" in l);
  assert.equal(r.pieces, 2);
  assert.ok(Number.isFinite(r.first_piece_ms));
  assert.ok(gl.liveInstructions({ name: "Omari", owner: true }).includes(gl.PIECES_LINE), "the voice is told the answer comes in pieces");
});

test("4. a newer hand-off stops the old answer's pieces; the voice's echo of a streamed 'sent' is not a guard trip", async () => {
  let more;
  const s = startCall({ brain: (m, hooks) => new Promise(() => { hooks.onContent("Okay."); more ??= () => hooks.onContent("Still the old answer."); }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "o1" } });
  await s.timers.advance(5);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "o2" } });
  await s.timers.advance(5);
  more();
  assert.ok(!s.live.of("session.commentary.append").some(e => e.content === "Still the old answer."));
  const t = startCall({ brain: (m, hooks) => new Promise(() => { hooks.onTool("message_send", "done", { ok: true }); hooks.onContent("Sent it."); }) });
  t.live.emit({ type: "session.delegation.created", delegation: { id: "g1" } });
  await t.timers.advance(5);
  t.live.emit({ type: "session.output_transcript.delta", delta: "Sent it." });
  assert.ok(!t.lines.some(l => "gptlive_guard" in l), "its own streamed words are Reason's");
});

test("4. talk-over: a held run with no words of theirs coming through goes out at 1 s (call 80: 1.9 s and 1.3 s)", async () => {
  const s = startCall({ brain: () => new Promise(() => {}) });
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD }); // the greeting
  for (let i = 0; i < 75; i++) { s.twilio.say({ event: "media", media: { payload: SILENT } }); await s.timers.advance(20); }
  for (let i = 0; i < 20; i++) { s.twilio.say({ event: "media", media: { payload: LOUD } }); await s.timers.advance(20); }
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD }); // the reply, over the line noise
  for (let i = 0; i < 70; i++) { s.twilio.say({ event: "media", media: { payload: LOUD } }); await s.timers.advance(20); }
  const held = s.lines.find(l => l.gptlive_talkover_held);
  assert.ok(held && held.held_ms >= gl.TALKOVER_WORDLESS_MS && held.held_ms < gl.TALKOVER_WORDLESS_MS + 100, JSON.stringify(held));
  assert.equal(gl.TALKOVER_WORDLESS_MS, 1000, "not less: their transcript trails their voice by 0.5–1.5 s (cold review)");
});

// ---------- 5. the room ----------

test("5. the room is half as loud again: 0.009375 in code, no .env line needed", () => {
  assert.equal(amb.AMBIENCE_GAIN, 0.009375);
  assert.equal(amb.ambienceGain(""), 0.009375);
});

// ---------- 6. weather by coordinates ----------

const OPEN_METEO = {
  utc_offset_seconds: -18000,
  current: { time: "2026-11-08T13:00", temperature_2m: 59.4, apparent_temperature: 57.1, weather_code: 0, wind_speed_10m: 6.2, precipitation: 0 },
  daily: { temperature_2m_max: [62.2], temperature_2m_min: [48.9], precipitation_probability_max: [5], weather_code: [1] },
};
const fakeFetch = (seen) => async (url) => { seen.push(String(url)); return { ok: true, json: async () => OPEN_METEO }; };

test("6. weatherAt: the reading at the point, in words, with its age; °C beside °F", async () => {
  const seen = [];
  const w = await weather.weatherAt(40.7429, -74.0061, { fetchImpl: fakeFetch(seen), now: Date.parse("2026-11-08T18:05:00Z") });
  assert.match(seen[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=40\.7429&longitude=-74\.0061/);
  assert.equal(w.ok, true);
  assert.deepEqual(w.now, { temp_f: 59, temp_c: 15, feels_like_f: 57, conditions: "clear", wind_mph: 6, precipitation_mm: 0 });
  assert.equal(w.today.high_f, 62);
  assert.equal(w.today.rain_chance_pct, 5);
  assert.equal(w.reading_minutes_old, 5, "13:00 New York is 18:00 UTC");
  assert.equal((await weather.weatherAt(NaN, 1)).ok, false);
  const down = await weather.weatherAt(1, 1, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(down.ok, false);
  assert.match(down.error, /could not reach/);
});

test("6. the weather tool: a saved place of his by name, his own only; coordinates; nothing to go on", async () => {
  db.savePlace(C, { name: "work", address: "430 W 17th St, New York", lat: 40.7429, lng: -74.0061 });
  db.savePlace(OTHER, { name: "office", address: "1 Elm St", lat: 39.8, lng: -89.6 });
  const seen = [];
  const ctx = { conversationId: C, kind: "user", fetchImpl: fakeFetch(seen) };
  const byPlace = await tools.runTool("weather", { place: "work" }, ctx);
  assert.equal(byPlace.ok, true, JSON.stringify(byPlace));
  assert.match(byPlace.place, /430 W 17th/);
  assert.match(seen[0], /latitude=40\.7429/);
  const theirs = await tools.runTool("weather", { place: "office" }, ctx);
  assert.equal(theirs.ok, false, "another person's saved place is not his");
  assert.deepEqual(theirs.saved_places, ["work"]);
  assert.equal((await tools.runTool("weather", { latitude: 40.7, longitude: -74 }, ctx)).ok, true);
  assert.equal((await tools.runTool("weather", {}, ctx)).ok, false);
  assert.ok(tools.SAFE_WHILE_SCREENED.has("weather"), "a read that reaches nobody");
  assert.match(tools.toolsFor(C).find(t => t.name === "get_location").description, /weather tool/);
  assert.match(prompt.ownerCallFrame({ name: "Omari" }), /the weather with the weather tool/);
});

// ---------- 7. the end of a line ----------

test("7. fadeOut: the last sound of a piece ramps to silence; what comes before is untouched", () => {
  const loud = Buffer.alloc(400, 0x00).toString("base64");
  const faded = Buffer.from(gl.fadeOut(loud), "base64");
  const { ulawToPcm } = gl;
  assert.equal(ulawToPcm(faded[0]), ulawToPcm(0x00), "the start is as it was");
  assert.ok(Math.abs(ulawToPcm(faded[399])) < 100, "the last sample is silence");
  assert.ok(Math.abs(ulawToPcm(faded[399 - gl.FADE_SAMPLES / 2])) < Math.abs(ulawToPcm(0x00)), "halfway through the ramp it is quieter");
  assert.equal(gl.fadeOut(SILENT), SILENT, "nothing to fade in silence");
});

test("7. on the line: a piece with speech is held until the next; faded when silence follows or nothing comes", async () => {
  const s = startCall({ brain: () => new Promise(() => {}) });
  const media = () => s.twilio.sent.filter(m => m.event === "media").map(m => m.media.payload);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  assert.equal(media().length, 0, "held one piece behind");
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  assert.deepEqual(media(), [LOUD], "more speech after it: sent as it was");
  s.live.emit({ type: "session.output_audio.delta", delta: SILENT });
  assert.deepEqual(media(), [LOUD, gl.fadeOut(LOUD), SILENT], "the line's last sound faded, then the silence");
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  await s.timers.advance(gl.FADE_FLUSH_MS);
  assert.equal(media().at(-1), gl.fadeOut(LOUD), "nothing after it: faded and sent");
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  s.call.clearPlayback("barge_in");
  await s.timers.advance(gl.FADE_FLUSH_MS);
  assert.equal(media().length, 4, "a clear throws the held piece away with the rest");
});

test("7. the voice is told no 'uh', 'um' or 'let me check' of its own — on his call and a stranger's", () => {
  assert.match(gl.NO_FILLER, /no "uh", "um", "er" or "hmm"/);
  assert.match(gl.NO_FILLER, /never say "let me check", "one sec"/);
  assert.ok(gl.liveInstructions({ name: "Omari", owner: true }).includes(gl.NO_FILLER));
  assert.ok(gl.strangerInstructions().includes(gl.NO_FILLER));
});

// ---------- fix 2: the voice is Reason ----------

test("fix 2: on his own call the voice answers what it can itself, from his brief; live facts and actions still go to Reason", () => {
  db.saveProfile(C, "**Omari**\n- Works at 430 W 17th", []);
  db.addRule(C, { rule: "on a call, just say the answer out loud" });
  db.savePlace(C, { name: "work", address: "430 W 17th St, New York", lat: 40.7429, lng: -74.0061 });
  const s = gl.liveInstructions(gl.whoFor(ownerCall()));
  assert.match(s, /^You are Reason, Omari's personal assistant — the same Reason they text with/);
  assert.ok(s.includes(gl.OWN_VOICE_PERSONA));
  for (const l of gl.OWN_VOICE_SPLIT) assert.ok(s.includes(l));
  assert.match(s, /Never state a fact, figure, news item, price, time or the weather from your own knowledge: hand it off/);
  assert.match(s, /Works at 430 W 17th/);
  assert.match(s, /HOW THEY WANT YOU TO TREAT THEM[^]*just say the answer out loud/);
  assert.match(s, /WHERE THEY USUALLY ARE[^]*430 W 17th St/);
  assert.match(s, /Never say anything is done, booked, sent/, "the honesty lines stand");
});

test("fix 2, sealed: a stranger and a business call keep the restricted relay, with nothing of his", () => {
  db.saveProfile(C, "**Omari**\n- Works at 430 W 17th", []);
  db.addRule(C, { rule: "on a call, just say the answer out loud" });
  const stranger = gl.strangerInstructions();
  assert.match(stranger, /You are only the voice/);
  assert.doesNotMatch(stranger, /430 W 17th|answer out loud|Omari/);
  const line = gl.lineInstructions({ name: "Omari", named: true });
  assert.doesNotMatch(line, /430 W 17th|answer out loud|PRE-CALL BRIEF/);
  const errand = gl.whoFor(db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "book", facts: [], announcement: "", state: "placing" }));
  assert.equal(errand.brief, undefined, "a business call gets no brief of his");
  assert.equal(gl.preCallBrief({ is_owner: 0, conversation_id: C }), "");
});

test("the GPT-Live brief is read from the call's own conversation only", () => {
  db.saveProfile(OTHER, "**Ama**\n- Allergic to peanuts", []);
  db.addRule(OTHER, { rule: "call me Ama-ji" });
  const mine = gl.preCallBrief(ownerCall());
  assert.doesNotMatch(mine, /peanuts|Ama-ji/);
  const hers = gl.preCallBrief(ownerCall(OTHER));
  assert.match(hers, /peanuts/);
  assert.match(hers, /Ama-ji/);
});

test("the drive harness reads call 80's lines (verify-reason)", () => {
  const src = readFileSync(new URL("../.agents/skills/verify-reason/bin/call-quality-drive.mjs", import.meta.url), "utf8");
  assert.match(src, /--seed call80/);
});

// ---------- cold review fixes ----------

test("review: a 'sent' needs a real send tool — a read like page_list or undo_send does not back it", () => {
  assert.equal(gl.withoutUnbackedSends("Just texted it to you.", ["page_list"]).dropped, 1);
  assert.equal(gl.withoutUnbackedSends("Just texted it to you.", ["undo_send", "message_effects"]).dropped, 1);
  assert.equal(gl.withoutUnbackedSends("Just texted it to you.", ["message_send"]).dropped, 0);
  assert.equal(gl.withoutUnbackedSends("Emailed it.", ["gmail_send"]).dropped, 0);
});

test("review: a tool that starts after words were said re-arms the late line; overlapping calls of one tool stay running", async () => {
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; h.onContent("Here's the first part of it."); }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "r1" } });
  await s.timers.advance(5);
  hooks.onTool("web_search", "start"); hooks.onTool("web_search", "start"); hooks.onTool("web_search", "done", { ok: true });
  await s.timers.advance(voice.LATE_HOLDING_MS + 50);
  const late = s.lines.find(l => l.gptlive_hold_line && l.kind === "late");
  assert.ok(late, "the late line covers the tool's wait");
  assert.equal(late.tool, "web_search", "the second web_search is still running");
});

test("review: voiceInstructionsFor defaults like the call does — an errand gets the line instructions", () => {
  const errand = db.createCall(config.ownerConversation, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "book a table", facts: [], announcement: "", state: "in_progress" });
  assert.equal(gl.voiceInstructionsFor(errand), startCall({ brain: async () => ({}), row: errand }).call.who.instructions, "the words the call itself starts with");
  assert.equal(gl.whoFor({ ...errand, is_owner: "0" }).owner, false, "a string 0 is not their own call");
  assert.equal(gl.preCallBrief({ ...errand, is_owner: "0" }), "");
});

test("review: a rule saved mid-call reaches the voice on this call, once; the brief's own rules are not re-sent", async () => {
  const s = startCall({ brain: async (m, h) => { db.addRule(C, { rule: "keep the weather to one line" }); h.onTool("remember", "start"); h.onTool("remember", "done", { ok: true }); return { text: "Got it.", tools: [] }; } });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "m1" } });
  await s.timers.advance(10);
  const told = s.live.of("session.instructions.append").filter(e => /keep the weather to one line/.test(e.content));
  assert.equal(told.length, 1);
  assert.match(told[0].content, /^Updated just now — HOW THEY WANT YOU TO TREAT THEM/);
  assert.equal(s.call.freshRules(), false, "unchanged since: nothing more");
});

test("review: their week read after the session started is handed to the voice (a call they rang); not twice", async () => {
  const row = ownerCall();
  db.savePlace(C, { name: "work", address: "430 W 17th St", lat: 40.742, lng: -74.004 });
  const s = startCall({ brain: () => new Promise(() => {}), row });
  await cm.prepareCallMemory(row, { enabled: true, find: async () => [] });
  // The brief already had the place: nothing new to say.
  assert.equal(gl.lateWhereabouts(row), false);
  cm.resetCallMemory();
  const fact = db.remember(C, "Omari", "Works Thu to Sun shifts");
  await cm.prepareCallMemory(row, { enabled: true, find: async () => [{ factId: fact.id ?? fact.factId ?? fact }] });
  // The read itself tells the live call (onScheduleRead), whichever ask it was — the ring's or the retry.
  assert.equal(s.live.of("session.instructions.append").filter(e => /Works Thu to Sun shifts/.test(e.content)).length, 1);
  assert.equal(gl.lateWhereabouts(row), false, "once");
});

test("review drive: out of rounds on his call, the last words before the tools are said, then the come-back line", async () => {
  voice.contextDeps.runTool = async () => ({ ok: false, error: "search down" });
  const r = (lead) => [lead, { tool: "web_search", start: true }];
  const out = await turn(ownerCall(), rounds(r("Searching the news. "), r("Search is down on my end, so I'll try a Nigerian news site directly. "), r("Trying another site. "), r("One more try. ")));
  const said = (await drain(out.stream)).trim();
  assert.match(said, /One more try\.\s+Let me come back to you on that one\.$/, said);
  assert.doesNotMatch(said, /Searching the news/, "only the last lead-in");
});

test("second review: the API's tool_start + tool_use is one start — a finished lookup is not 'running' after", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true });
  const seen = [];
  const out = await turn(ownerCall(), rounds(["", { tool: "web_search", start: true }], ["Done."]), { onTool: (n, phase) => seen.push(`${n}:${phase}`) });
  await drain(out.stream);
  const starts = seen.filter(x => x === "web_search:start").length;
  const dones = seen.filter(x => x === "web_search:done").length;
  assert.equal(starts, 1, JSON.stringify(seen));
  assert.equal(dones, 1);
});

test("second review: a rule dropped mid-call is told to the voice too; every rule gone says so", async () => {
  const made = db.addRule(C, { rule: "no jokes on calls" });
  const s = startCall({ brain: async (m, h) => { db.db.prepare("DELETE FROM treat_rules").run(); h.onTool("memory_drop", "start"); h.onTool("memory_drop", "done", { ok: true }); return { text: "Dropped it.", tools: [] }; } });
  assert.match(String(s.call.who.brief), /no jokes on calls/);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "x1" } });
  await s.timers.advance(10);
  assert.ok(s.live.of("session.instructions.append").some(e => /no rules any more/.test(e.content)), "told they're gone");
  void made;
});

test("second review: voiceInstructionsFor matches a talking business call, and the puppet line when talk is off", () => {
  const prev = config.lineTalk;
  try {
    for (const talk of [true, false]) {
      config.lineTalk = talk;
      const errand = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "book a table", facts: [], announcement: "", state: "in_progress" });
      assert.equal(gl.voiceInstructionsFor(errand), startCall({ brain: async () => ({}), row: errand }).call.who.instructions, `lineTalk ${talk}`);
    }
  } finally { config.lineTalk = prev; }
});
