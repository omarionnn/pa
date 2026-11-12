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
  // Weather fix (a): a turn that already knows nothing of where they are asks, never "come back".
  assert.match(said, /Where are you\?\s*$/);
  assert.doesNotMatch(said, /come back to you/);
  assert.ok(lines.some(l => l.voice_where_ask && l.lead_in));
});

// ---------- weather fix (a): nowhere to go → ask where they are, always ----------
test("weather (a): no saved place, no pin — get_location knows nothing, the model loops: code asks where they are at once, no more rounds", async () => {
  voice.contextDeps.runTool = async (name) => name === "get_location"
    ? { ok: true, sharing: false, source: "none", note: "You do not know where they are." }
    : { ok: false, error: "Give coordinates or a saved place." };
  let calls = 0;
  const gen = rounds([{ tool: "get_location" }], [{ tool: "weather" }], [{ tool: "get_location" }], [{ tool: "weather" }]);
  const lines = [];
  const out = await turn(ownerCall(), async function* (...a) { calls++; yield* gen(...a); }, { log: (l) => lines.push(l), firstWordDeadlineMs: 60_000, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
  const said = await drain(out.stream);
  assert.equal(said.trim(), voice.WHERE_ASK);
  assert.equal(calls, 2, "round 2 asked again without a position: the question, not round 3");
  assert.ok(lines.some(l => l.voice_where_ask && l.why === "repeat_without_position"));
  assert.doesNotMatch(said, /come back/);
});

test("weather (a): out of rounds with no position, ×10 — every one ends on the question, never a silent or come-back turn", async () => {
  for (let k = 0; k < 10; k++) {
    voice.contextDeps.runTool = async (name) => name === "get_location" ? { ok: false, error: "no location" } : { ok: true, results: [] };
    // Each round calls something different, so only the out-of-rounds guard can catch it.
    const out = await turn(ownerCall(), rounds([{ tool: "get_location" }], [{ tool: "web_search", input: { query: "weather" } }], [{ tool: "web_search", input: { query: "weather now" } }], [{ tool: "web_search", input: { query: "x" } }]),
      { firstWordDeadlineMs: 60_000, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
    const said = await drain(out.stream);
    assert.match(said, /Where are you right now\?/, `run ${k}`);
    assert.doesNotMatch(said, /come back/);
  }
});

test("weather (a): the model asks itself → said once, not twice; a known position clears it and the weather is said", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true, sharing: false, source: "none" });
  const out = await turn(ownerCall(), rounds([{ tool: "get_location" }], ["I can't see where you are — where are you right now?"]), { firstWordDeadlineMs: 60_000, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
  const said = await drain(out.stream);
  assert.equal((said.match(/where are you/gi) ?? []).length, 1, said);
  voice.contextDeps.runTool = async (name) => name === "get_location" ? { ok: true, source: "live", latitude: 40.74, longitude: -74 } : { ok: true, now: { temp_f: 59 } };
  const ok = await turn(ownerCall(), rounds([{ tool: "get_location" }], [{ tool: "weather", input: { latitude: 40.74, longitude: -74 } }], ["Fifty nine and clear."]), { firstWordDeadlineMs: 60_000, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
  const w = await drain(ok.stream);
  assert.match(w, /Fifty nine and clear\./);
  assert.doesNotMatch(w, /Where are you/);
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

// GPT-Live's real pieces (measured from the live host, 2026-11-12): 800 bytes, 100 ms apart.
const tone = (n, from = 0) => Buffer.from(Array.from({ length: n }, (_, k) => gl.pcmToUlaw(Math.round(8000 * Math.sin(2 * Math.PI * 400 * (from + k) / 8000)))));
const sentBytes = (s) => Buffer.concat(s.twilio.sent.filter(m => m.event === "media").map(m => Buffer.from(m.media.payload, "base64")));

test("7. a sentence in 100 ms pieces, 100 ms apart, reaches the line as it came: no piece of it is faded (the voice breaking up, 2026-11-12)", async () => {
  assert.ok(gl.FADE_FLUSH_MS > 150, "the wait for the next piece is longer than the gap between two pieces");
  const s = startCall({ brain: () => new Promise(() => {}) });
  const pieces = Array.from({ length: 10 }, (_, i) => tone(800, i * 800));
  for (const p of pieces) {
    s.live.emit({ type: "session.output_audio.delta", delta: p.toString("base64") });
    await s.timers.advance(100);
  }
  const out = sentBytes(s);
  const said = Buffer.concat(pieces);
  assert.deepEqual([...out.subarray(0, gl.FADE_SAMPLES)], Array(gl.FADE_SAMPLES).fill(0xff), "30 ms of silence ahead of the first piece, so the line never runs dry behind the held end");
  assert.equal(out.subarray(gl.FADE_SAMPLES).equals(said.subarray(0, said.length - gl.FADE_SAMPLES)), true, "every sample sent is the sample that came, in order");
  assert.equal(Buffer.from(s.call.voiceTail, "base64").equals(said.subarray(said.length - gl.FADE_SAMPLES)), true, "only the last 30 ms wait for what follows");
  // Twilio plays in order as it arrives: after each arrival, what has been sent covers the 100 ms to the next.
  assert.equal(out.length, said.length, "sent keeps pace with what came, piece for piece");
  // The line ends: the held end is faded, and the silence put in ahead comes back out of the quiet after.
  s.live.emit({ type: "session.output_audio.delta", delta: Buffer.alloc(800, 0xff).toString("base64") });
  const all = sentBytes(s);
  assert.equal(all.length, said.length + 800, "nothing added to the call's timeline once the line has ended");
  const end = all.subarray(gl.FADE_SAMPLES + said.length - gl.FADE_SAMPLES, gl.FADE_SAMPLES + said.length);
  assert.ok(Math.abs(gl.ulawToPcm(end.at(-1))) < 100 && !end.equals(said.subarray(said.length - gl.FADE_SAMPLES)), "the end of the line is faded");
  assert.equal(s.call.voiceLead, 0);
  assert.equal(s.call.voiceTail, null);
});

test("7. a sound that stops inside a piece is faded there and nothing waits; a piece that carries the sound on leaves the held end as it came", () => {
  const s = startCall({ brain: () => new Promise(() => {}) });
  const stop = Buffer.concat([tone(400), Buffer.alloc(400, 0xff)]);
  s.live.emit({ type: "session.output_audio.delta", delta: stop.toString("base64") });
  assert.equal(s.call.voiceTail, null, "nothing held: the end is already known");
  assert.equal(sentBytes(s).equals(Buffer.from(gl.fadeOut(stop.toString("base64")), "base64")), true, "faded where its sound stops");
  // A quiet stretch of a word (under the speech peak, over the floor) after a held end: not the end of a line.
  const s2 = startCall({ brain: () => new Promise(() => {}) });
  const loud = tone(800);
  const soft = Buffer.alloc(800, gl.pcmToUlaw(900));
  s2.live.emit({ type: "session.output_audio.delta", delta: loud.toString("base64") });
  s2.live.emit({ type: "session.output_audio.delta", delta: soft.toString("base64") });
  assert.equal(sentBytes(s2).subarray(gl.FADE_SAMPLES).equals(Buffer.concat([loud, soft])), true, "the held end goes out unfaded when the sound carries on");
});

test("7. the voice is told no 'uh', 'um' or 'let me check' of its own — on his call and a stranger's", () => {
  assert.match(gl.NO_FILLER, /no "uh", "um", "er" or "hmm"/);
  assert.match(gl.NO_FILLER, /never say "let me check", "one sec"/);
  // His own call: the same floor, but the one named hand-off line is the voice's (Omari 11-08).
  assert.ok(gl.liveInstructions({ name: "Omari", owner: true }).includes(gl.OWN_NO_FILLER));
  assert.match(gl.OWN_NO_FILLER, /no "uh", "um", "er" or "hmm"/);
  assert.match(gl.OWN_NO_FILLER, /never a bare "let me check", "one sec"/);
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

// ---------- dead air (drive 11-08 on OVH, 21:00Z): 2.8 s → 9.4 s median before any sound ----------
// The code's first line waited on a poll that gave up at 6 s, and the CLI test backend printed its
// whole turn at the end. A real tool starting is the moment a true "let me check" is due.

test("dead air: a lookup that starts after 1.5 s gets its line at its start — not at the 7.5 s late line", async () => {
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d1" } });
  await s.timers.advance(gl.HOLD_LINE_AFTER_MS + 200);
  assert.ok(!s.lines.some(l => l.gptlive_hold_line), "nothing running yet: no 'one sec' into what may be a plain answer");
  await s.timers.advance(1100);
  hooks.onTool("weather", "start");
  const first = s.lines.find(l => l.gptlive_hold_line);
  assert.ok(first, "said as the tool starts");
  assert.equal(first.kind, "first");
  assert.equal(first.tool, "weather");
  assert.equal(first.line, "Getting the weather.", "named, never a stock 'let me check' (Omari 11-08)");
  assert.ok(first.ms < 3000, `at ${first.ms} ms`);
  hooks.onTool("weather", "start");
  assert.equal(s.lines.filter(l => l.gptlive_hold_line && l.kind === "first").length, 1, "never twice");
});

test("dead air: a send running says it is sending, never 'check'; a turn with no tool gets no first line at all", async () => {
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d2" } });
  await s.timers.advance(400);
  hooks.onTool("message_send", "start");
  await s.timers.advance(gl.HOLD_LINE_AFTER_MS);
  const first = s.lines.find(l => l.gptlive_hold_line);
  assert.ok(first && gl.SEND_HOLD_LINES.includes(first.line), JSON.stringify(first));
  const t = startCall({ brain: () => new Promise(() => {}) });
  t.live.emit({ type: "session.delegation.created", delegation: { id: "d3" } });
  await t.timers.advance(voice.LATE_HOLDING_MS - 100);
  assert.ok(!t.lines.some(l => l.gptlive_hold_line), "no tool, no words yet: silence is the model writing, not a stall to cover");
});

test("dead air: the CLI test backend streams — words as written, a TOOL line known at its name", () => {
  const p = voice.cliLineStream();
  const out = [];
  for (const d of ["Sure, let me che", "ck.\nTO", "OL weath", "er {\"place\":\"work\"}\nToday is ", "nice."]) out.push(...p.push(d));
  out.push(...p.end());
  assert.deepEqual(out.map(e => e.type === "text" ? e.text : `${e.type}:${e.name}`),
    ["Sure, let me che", "ck.", "\n", "tool_start:weather", "tool_use:weather", "Today is ", "nice."]);
  assert.deepEqual(out.find(e => e.type === "tool_use").input, { place: "work" });
  const q = voice.cliLineStream();
  assert.deepEqual([...q.push("Today"), ...q.end()].map(e => e.text), ["Today"], "a line that began like TOOL is words");
});

test("should-fix: once the model's own words are said, no lead-in is replayed after them (cold review: 'One more look.' after the answer)", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true });
  const LONG = "It's fifty nine and clear near work on West Seventeenth, high of sixty two, and it drops to the mid forties after dark, so bring a jacket for when your shift ends at eight. ";
  assert.ok(LONG.length > voice.LEAD_IN_HOLD_CHARS);
  const out = await turn(ownerCall(), rounds(
    ["Let me check the weather. ", { tool: "weather", start: true }],
    [LONG, "One more look. ", { tool: "web_search", start: true }],
    [],
  ));
  const said = (await drain(out.stream)).trim();
  assert.match(said, /bring a jacket/);
  assert.doesNotMatch(said, /Let me check the weather|One more look/, said);
});

test("should-fix: after a send that ran, a silent last round says it was sent — not the lead-in as if still to come", async () => {
  voice.contextDeps.runTool = async () => ({ ok: true });
  const out = await turn(ownerCall(), rounds(["I'll text that to you now. ", { tool: "message_send", start: true }], []));
  const said = (await drain(out.stream)).trim();
  assert.equal(said, voice.SENT_LINE);
});

test("cold review: a send that failed says nothing of having sent", async () => {
  voice.contextDeps.runTool = async () => ({ ok: false, error: "no number" });
  const out = await turn(ownerCall(), rounds(["I'll text that to you now. ", { tool: "message_send", start: true }], []));
  assert.doesNotMatch((await drain(out.stream)).trim(), /^Sent\.$/);
});

test("cold review: a tool starting while the voice talks leaves one retry, and no first line once Reason's words are out", async () => {
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "d4" } });
  await s.timers.advance(gl.HOLD_LINE_AFTER_MS + 100);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD }); // the voice's own "mm"
  hooks.onTool("web_search", "start");
  await s.timers.advance(100);
  hooks.onContent("It's fifty nine and clear near work.");
  await s.timers.advance(3000);
  assert.ok(!s.lines.some(l => l.gptlive_hold_line && l.kind === "first"), JSON.stringify(s.lines.filter(l => l.gptlive_hold_line)));
});

test("cold review: the CLI stream — a TOOL line is a tool only once its JSON begins; words that look like one are words", () => {
  const p = voice.cliLineStream();
  const out = [...p.push("Tool up the volume.\r\nTOOL weather "), ...p.push("{\"place\":\"work\"}"), ...p.end()];
  assert.deepEqual(out.map(e => e.type === "text" ? e.text : `${e.type}:${e.name}`), ["Tool up the volume.", "\n", "tool_start:weather", "tool_use:weather"]);
  const q = voice.cliLineStream();
  const never = [...q.push("TOOL weather"), ...q.push(" is what I'd call it."), ...q.end()];
  assert.ok(!never.some(e => e.type === "tool_start"), JSON.stringify(never));
});

test("drive 11-08: the weather with nothing to go on says to ask them where they are — not another round of tools", async () => {
  const none = await tools.runTool("weather", {}, { conversationId: C });
  assert.equal(none.ok, false);
  assert.match(none.next, /ask them out loud where they are/);
  const t = tools.TOOLS?.find?.(x => x.name === "weather") ?? null;
  if (t) assert.match(t.description, /ask them where they are/);
});

// ---------- privacy (PR #407 session's drive 11-08): a spoofed inbound caller asked "where am I" ----------
const inboundCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, direction: "in", goal: "They rang Reason", facts: [],
  announcement: "Hey Omari, what's up?", state: "in_progress",
});

test("caller check: the refusal is said out loud — words before verify_caller, then a skip_turn, are not lost", async () => {
  const row = inboundCall();
  voice.contextDeps.runTool = async () => ({ ok: true, latitude: 40.74, longitude: -74.0 });
  const out = await turn(row, rounds(
    [{ tool: "message_send", start: true, input: { to: "+13105550000", text: "running late" } }],
    ["I can't send that on this call, I'll pick it up by text once we hang up. ", { tool: "verify_caller", start: true, input: { about: "a text to Ama" } }],
    [{ tool: "skip_turn", input: { reason: "waiting" } }],
  ));
  const said = (await drain(out.stream)).trim();
  assert.match(said, /pick it up by text/, said);
});

test("caller check: refused and nothing written — code says the refusal itself", async () => {
  const row = inboundCall();
  voice.contextDeps.runTool = async () => ({ ok: true });
  const out = await turn(row, rounds([{ tool: "message_send", start: true, input: { to: "+13105550000", text: "running late" } }], [{ tool: "skip_turn", input: { reason: "x" } }]));
  const said = (await drain(out.stream)).trim();
  assert.ok([voice.CHECK_LATER_LINE, voice.CHECK_NOT_HERE_LINE].includes(said), said);
});

test("fix 2 (b): his own voice never deflects with filler — every reply an answer or a hand-off; silent while the backend works; strangers keep the relay", () => {
  const own = gl.liveInstructions({ name: "Omari", owner: true });
  assert.ok(own.includes(gl.OWN_VOICE_NO_DEFLECT));
  assert.match(gl.OWN_VOICE_NO_DEFLECT, /what's your take\?[^]*hand it to the backend[^]*say nothing of your own/);
  const relay = gl.liveInstructions({ name: "Ama", owner: false });
  assert.ok(!relay.includes(gl.OWN_VOICE_NO_DEFLECT));
  assert.match(relay, /You are only the voice/);
});

test("weather (a), review: weather's own 'give coordinates' before get_location ran is not 'unknown' — get_location still runs", async () => {
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return name === "get_location" ? { ok: true, source: "live", latitude: 40.74, longitude: -74 } : (ran.length === 1 ? { ok: false, error: "Give coordinates or a saved place." } : { ok: true, now: { temp_f: 59 } }); };
  const out = await turn(ownerCall(), rounds([{ tool: "weather" }], [{ tool: "get_location" }], [{ tool: "weather", input: { latitude: 40.74, longitude: -74 } }], ["Fifty nine."]), { firstWordDeadlineMs: 60_000, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
  const said = await drain(out.stream);
  assert.deepEqual(ran, ["weather", "get_location", "weather"]);
  assert.match(said, /Fifty nine\./);
  assert.doesNotMatch(said, /Where are you right now/);
});


// ---------- Omari 11-08 (final): on his number, caller ID alone is enough for where he is and what Reason knows ----------
test("caller ID only: his places, week, rules and profile reach the call (Omari 11-08); only money, booking, texting others and settings wait", async () => {
  db.savePlace(C, { name: "work", address: "430 W 17th St", lat: 40.742, lng: -74.004 });
  db.addRule(C, { rule: "keep the weather to one line" });
  const row = inboundCall();
  assert.match(cm.callNotes(row), /430 W 17th/);
  assert.match(cm.callNotes(row), /weather to one line/);
  const who = gl.whoFor(row);
  assert.equal(who.restricted, undefined, "no restricted voice");
  assert.ok(gl.voiceInstructionsFor(row).includes(gl.OWN_VOICE_NO_DEFLECT), "his own voice, fix 2");
  assert.match(voice.ownerContext({ call: row, callMessages: [] }).system, /weather to one line/);
});

test("caller check + nowhere to go: a refused send and an unknown position — the refusal is said first, then the where question", async () => {
  voice.contextDeps.runTool = async (name) => name === "get_location" ? { ok: true, sharing: false, source: "none" } : { ok: true };
  const row = inboundCall();
  const out = await turn(row, rounds([{ tool: "message_send", start: true, input: { to: "+13105550000", text: "running late" } }], [{ tool: "get_location" }], [{ tool: "get_location" }], [{ tool: "get_location" }]), { firstWordDeadlineMs: 60_000, lateHoldingMs: 60_000, fillerAfterMs: 60_000 });
  const said = await drain(out.stream);
  const refusal = [voice.CHECK_LATER_LINE, voice.CHECK_NOT_HERE_LINE].find(l => said.startsWith(l));
  assert.ok(refusal, said);
  assert.match(said.slice(refusal.length), /Where are you right now\?/, "the where question after it");
});

// ---------- the named hand-off line (Omari 11-08, after the paid replay) ----------
// Branch 3.4 s median / 4.9 s worst before any sound vs main's 3.0 / 3.5 s (main's = a stock "Mm, one
// sec" in front of a cut answer). Now the voice says one short line naming the lookup as it hands
// over, within ~1 s; code's own first line names the tool and is never said after the voice's.

const holdsOf = (s) => s.live.of("session.commentary.append").filter(e => String(e.event_id).startsWith("hold_"));
const quietOf = (s, id) => s.live.of("session.thinking.append").filter(e => e.delegation_id === id);

test("named ack: his own call's voice is told to name the lookup as it hands over — not a stock line, not before a plain answer or a yes/no, never twice", () => {
  const own = gl.liveInstructions({ name: "Omari", named: true, owner: true });
  assert.ok(own.includes(gl.HANDOFF_ACK));
  assert.match(gl.HANDOFF_ACK, /names exactly what you're getting or doing/);
  assert.match(gl.HANDOFF_ACK, /"Weather near work, one sec\."/);
  assert.match(gl.HANDOFF_ACK, /"Pulling up Nigeria headlines\."/);
  assert.match(gl.HANDOFF_ACK, /Never a bare "one sec", "let me check"/);
  assert.match(gl.HANDOFF_ACK, /Say nothing first when you're only passing on their yes or no/);
  assert.match(gl.HANDOFF_ACK, /never two of these lines in a row/);
  assert.ok(!own.includes(gl.NO_HOLDING_LINE) && !own.includes(gl.NO_FILLER), "no line that forbids the named one");
  // Anyone else's call and a stranger's: the relay waits in silence as before.
  assert.ok(!gl.liveInstructions({ name: "Omari", named: true, owner: false }).includes(gl.HANDOFF_ACK));
  assert.ok(!gl.strangerInstructions().includes(gl.HANDOFF_ACK));
});

test("named ack: the voice said its line as it handed over → code says no first line when the lookup starts; the late line still covers a long wait", async () => {
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " What's the weather like near work?" });
  await s.timers.advance(400);
  s.live.emit({ type: "session.output_transcript.delta", delta: "Weather near work, one sec." });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "a1" } });
  await s.timers.advance(5);
  assert.equal(quietOf(s, "a1").length, 1, "said already: the automatic acknowledgement is cancelled at once");
  await s.timers.advance(2000);
  hooks.onTool("weather", "start");
  await s.timers.advance(2000);
  assert.equal(holdsOf(s).length, 0, "no 'Getting the weather.' after his voice's own line — never two in a row");
  await s.timers.advance(voice.LATE_HOLDING_MS);
  const h = holdsOf(s);
  assert.equal(h.length, 1, "the late line, so a long wait is never dead air");
  assert.ok(voice.LATE_LINES.includes(/"([^"]+)"/.exec(h[0].content)[1]));
});

test("named ack: the platform's automatic acknowledgement never plays — cancelled at once on his call too (drive v4: it came later and stock)", async () => {
  const s = startCall({ brain: () => new Promise(() => {}) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " What's the latest from Nigeria?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "a2" } });
  await s.timers.advance(5);
  const q = quietOf(s, "a2");
  assert.equal(q.length, 1);
  assert.equal(q[0].content, gl.OWN_WAIT_NOTE);
  assert.match(gl.OWN_WAIT_NOTE, /haven't yet said your one short line naming it, say just that line now; otherwise say nothing/);
  const third = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "ask about a table", facts: [], announcement: "", state: "placing" });
  const t = startCall({ row: third, brain: () => new Promise(() => {}) });
  t.live.emit({ type: "session.delegation.created", delegation: { id: "a3" } });
  await t.timers.advance(5);
  assert.equal(quietOf(t, "a3")[0]?.content, "", "a business line: cancelled at once, as before");
});

test("named ack: a bare listening sound before the hand-off is not a line — code still names the lookup", async () => {
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Any news from Nigeria?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.output_transcript.delta", delta: "Mm-hmm." });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "a4" } });
  await s.timers.advance(gl.HOLD_LINE_AFTER_MS + 100);
  hooks.onTool("web_search", "start");
  await s.timers.advance(10);
  assert.equal(holdsOf(s).length, 0, "the voice was asked for its line: code waits for its reply, not over it (cold review)");
  await s.timers.advance(gl.ACK_REPLY_MS);
  const h = holdsOf(s).map(e => /"([^"]+)"/.exec(e.content)[1]);
  assert.deepEqual(h, ["Searching the web for that."], "it said nothing: code names the lookup");
});

test("named ack: code's first line names Reason's tool — never 'one sec' / 'let me check' — and a tool with no name gets none", async () => {
  assert.equal(gl.toolHoldLine("weather"), "Getting the weather.");
  assert.equal(gl.toolHoldLine("get_location"), "Checking where you are.");
  assert.equal(gl.toolHoldLine("calendar_events"), "Checking your calendar.");
  assert.equal(gl.toolHoldLine("message_send"), "Sending it now.");
  assert.equal(gl.toolHoldLine("timer_set"), "");
  assert.equal(gl.holdLineFor({ kind: "first" }), "", "nothing named: no first line");
  for (const name of ["weather", "web_search", "get_location", "nearby_places", "calendar_events", "recall", "message_send"]) {
    assert.doesNotMatch(gl.toolHoldLine(name), /^(?:mm,? )?(?:one sec|let me check|checking now|let me look)/i, name);
  }
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; }) });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "a5" } });
  await s.timers.advance(gl.HOLD_LINE_AFTER_MS + 100);
  hooks.onTool("timer_set", "start");
  await s.timers.advance(3000);
  assert.equal(holdsOf(s).length, 0, "an unnamed tool: no stock 'one sec' into the wait");
});

test("talk-over (paid replay 11-08): naturally long content is the top one or two in two short sentences, then the offer — not 24 s of headlines", () => {
  const frame = prompt.ownerCallFrame({ name: "Omari" });
  assert.match(frame, /say just the top one or two,\s+in two short sentences at most \(about ten seconds out loud\), and then offer the rest/);
});

const asksOf = (s) => s.live.of("session.commentary.append").filter(e => String(e.event_id).startsWith("ack_"));

test("named ack: handed over with nothing said on his own call → the voice is asked for its named line at once (drive v5: 0 of 5 said it unasked); said already → not asked", async () => {
  const s = startCall({ brain: () => new Promise(() => {}) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " What's the latest from Nigeria?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "k1" } });
  await s.timers.advance(5);
  const a = asksOf(s);
  assert.equal(a.length, 1, "asked once, at the hand-off");
  assert.equal(a[0].content, gl.ACK_ASK);
  assert.match(gl.ACK_ASK, /naming exactly what you're getting or doing/);
  assert.match(gl.ACK_ASK, /never just "one sec" or "let me check"/);
  assert.match(gl.ACK_ASK, /they answered yes or no, replied to something Reason asked, or it was unclear or sounded cut off — say nothing at all\./);
  assert.match(gl.ACK_ASK, /Only say you're sending something when they clearly said what to send/);
  assert.doesNotMatch(gl.ACK_ASK, /gets nothing|text me what/i, "drive v8/v9: that example kept the voice from handing over his next 'Text me what'");
  assert.doesNotMatch(gl.ACK_ASK, /wait quietly/, "drive v7: told to wait after it, the voice left his next 'No' unanswered");
  const t = startCall({ brain: () => new Promise(() => {}) });
  t.live.emit({ type: "session.input_transcript.delta", delta: " Weather near work?" });
  await t.timers.advance(300);
  t.live.emit({ type: "session.output_transcript.delta", delta: "Weather near work, one sec." });
  t.live.emit({ type: "session.delegation.created", delegation: { id: "k2" } });
  await t.timers.advance(5);
  assert.equal(asksOf(t).length, 0, "the voice said it as it handed over: never asked for a second");
});

test("named ack: never two in a row — a hand-off right after an unanswered one that had its line is not asked again; a business line is never asked", async () => {
  const s = startCall({ brain: () => new Promise(() => {}) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Any news from Nigeria?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "k3" } });
  await s.timers.advance(800);
  s.live.emit({ type: "session.input_transcript.delta", delta: " like today's" });
  await s.timers.advance(200);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "k4" } });
  await s.timers.advance(5);
  assert.deepEqual(asksOf(s).map(e => e.event_id), ["ack_k3"], "the second hand-off is not asked: its line was just said");
  const third = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "ask about a table", facts: [], announcement: "", state: "placing" });
  const b = startCall({ row: third, brain: () => new Promise(() => {}) });
  b.live.emit({ type: "session.delegation.created", delegation: { id: "k5" } });
  await b.timers.advance(5);
  assert.equal(asksOf(b).length, 0);
});

test("named ack: Reason skips after the voice's named line → it asks plainly what they wanted, not 'what do you reckon?' (drive v6)", async () => {
  const s = startCall({ brain: async () => ({ text: "", tools: ["skip_turn"], skip: true }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Text me what" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "k6" } });
  s.live.emit({ type: "session.output_transcript.delta", delta: "Texting you that now." });
  await s.timers.advance(50);
  const r = s.live.of("session.commentary.append").find(e => e.event_id === "result_k6");
  assert.equal(r?.content, gl.ACK_SKIP_FOLLOW_UP, JSON.stringify(r));
});

test("named ack (cold review): a hand-off on top of one whose line was just said gets no code line either — never two in a row", async () => {
  let hooks;
  const s = startCall({ brain: (m, h) => new Promise(() => { hooks = h; }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Weather near work?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.output_transcript.delta", delta: "Weather near work, one sec." });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "c1" } });
  await s.timers.advance(5000);
  s.live.emit({ type: "session.input_transcript.delta", delta: " and tomorrow too" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "c2" } });
  await s.timers.advance(2000);
  hooks.onTool("weather", "start");
  await s.timers.advance(gl.ACK_REPLY_MS + 500);
  assert.equal(asksOf(s).length, 0, "not asked: the line before is still the last thing said");
  assert.ok(!holdsOf(s).some(e => e.event_id === "hold_first_c2"), "no 'Getting the weather.' after 'Weather near work, one sec.'");
});

test("named ack (cold review): the voice's line said as it handed over, then Reason skips → still closed out loud, never silence", async () => {
  const s = startCall({ brain: async () => ({ text: "", tools: ["skip_turn"], skip: true }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Weather near work?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.output_transcript.delta", delta: "Weather near work, one sec." });
  s.live.emit({ type: "session.delegation.created", delegation: { id: "c3" } });
  await s.timers.advance(50);
  assert.equal(s.live.of("session.commentary.append").find(e => e.event_id === "result_c3")?.content, gl.ACK_SKIP_FOLLOW_UP);
});

// ---------- paid set 3 (11-09): his "No" unanswered; "text me what" asked back ----------

const floorsOf = (s) => s.live.of("session.commentary.append").filter(e => String(e.event_id).startsWith("reply_"));

test("paid set 3: a 'No' with no reply and no hand-off gets the voice asked to answer — once, at REPLY_FLOOR_MS", async () => {
  const s = startCall({ brain: async () => ({ text: "Ok." }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " No" });
  await s.timers.advance(gl.REPLY_FLOOR_MS - 100);
  assert.equal(floorsOf(s).length, 0, "not before the floor");
  await s.timers.advance(200);
  assert.equal(floorsOf(s).length, 1);
  assert.equal(floorsOf(s)[0].content, gl.REPLY_ASK);
  assert.equal(floorsOf(s)[0].delegation_id, null);
  await s.timers.advance(20_000);
  assert.equal(floorsOf(s).length, 1, "once per turn of theirs");
  assert.ok(s.lines.some(l => l.gptlive_reply_floor));
});

test("paid set 3: the voice answered the 'No' itself → no ask", async () => {
  const s = startCall({ brain: async () => ({ text: "Ok." }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " No" });
  await s.timers.advance(800);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  s.live.emit({ type: "session.output_transcript.delta", delta: "Okay, no worries." });
  await s.timers.advance(5000);
  assert.equal(floorsOf(s).length, 0);
});

test("paid set 3: handed to Reason and still running → no ask (its answer is coming)", async () => {
  const s = startCall({ brain: () => new Promise(() => {}) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Weather near work?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "f1" } });
  await s.timers.advance(6000);
  assert.equal(floorsOf(s).length, 0);
});

test("paid set 3: a new turn of theirs after an answered one gets its own floor", async () => {
  const s = startCall({ brain: async () => ({ text: "Ok." }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Hi" });
  await s.timers.advance(800);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  await s.timers.advance(5000);
  s.live.emit({ type: "session.input_transcript.delta", delta: " No" });
  await s.timers.advance(gl.REPLY_FLOOR_MS + 100);
  assert.equal(floorsOf(s).length, 1);
});

test("paid set 3: the voice is told never to leave them in silence — a plain 'no' gets a few words back", () => {
  assert.match(gl.OWN_VOICE_NO_DEFLECT, /Never leave them in silence/);
  assert.match(gl.OWN_VOICE_NO_DEFLECT, /even just "no"/);
  assert.match(gl.REPLY_ASK, /Never leave them in silence/);
  assert.ok(gl.liveInstructions({ name: "Omari", named: true, owner: true }).includes(gl.OWN_VOICE_NO_DEFLECT));
});

test("paid set 3: asked for it by text right after an answer → Reason sends that answer, no 'which bit?'", () => {
  const frame = prompt.ownerCallFrame({ name: "Omari" });
  assert.ok(frame.includes(prompt.TEXT_LAST_ANSWER));
  assert.match(prompt.TEXT_LAST_ANSWER, /that is your last answer: send it with message_send to "owner" in that turn, without asking which part/);
  assert.match(prompt.TEXT_LAST_ANSWER, /"text me what"/);
  // The voice may name that send: "text me that" right after an answer is clear (never a do-nothing example).
  assert.match(gl.ACK_ASK, /"text me that" right after an answer — that is the answer just given/);
  assert.doesNotMatch(gl.ACK_ASK, /text me what/i);
});

test("paid set 3: Reason skips the 'No' and nothing is said → the voice is still asked to answer, after the skip", async () => {
  const s = startCall({ brain: async () => ({ text: "", tools: ["skip_turn"], skip: true }) });
  s.live.emit({ type: "session.output_transcript.delta", delta: "Which bit do you want texted? Tell me and I'll send it." });
  await s.timers.advance(3000);
  s.live.emit({ type: "session.input_transcript.delta", delta: " No" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "f2" } });
  await s.timers.advance(gl.REPLY_FLOOR_MS * 3);
  const r = s.live.of("session.commentary.append").find(e => e.event_id === "result_f2");
  assert.equal(r?.content, gl.SKIP_REPLY, "the skip itself is closed out loud by the voice");
  assert.ok(!s.live.of("session.thinking.append").some(e => e.event_id === "result_f2"), "never 'say nothing more and listen' on his call");
  assert.equal(floorsOf(s).length, 0, "and the floor never asks on top of it (no second hand-off of the same 'No')");
});

test("paid set 3 (cold review): no floor for a bare 'mm-hmm', after a farewell, or once the call is done", async () => {
  const a = startCall({ brain: async () => ({ text: "Ok." }) });
  a.live.emit({ type: "session.input_transcript.delta", delta: " Mm-hmm." });
  await a.timers.advance(gl.REPLY_FLOOR_MS * 2);
  assert.equal(floorsOf(a).length, 0);
  const b = startCall({ brain: async () => ({ text: "Ok." }) });
  b.call.farewellAt = b.timers.now();
  b.live.emit({ type: "session.input_transcript.delta", delta: " No" });
  await b.timers.advance(gl.REPLY_FLOOR_MS * 2);
  assert.equal(floorsOf(b).length, 0);
  const c = startCall({ brain: async () => ({ text: "Ok." }) });
  c.live.emit({ type: "session.input_transcript.delta", delta: " No" });
  c.call.done = true;
  await c.timers.advance(gl.REPLY_FLOOR_MS * 2);
  assert.equal(floorsOf(c).length, 0);
});

test("paid set 3 (cold review): the voice's never-silence line is scoped to when nothing is being worked on; ACK_ASK's send example claims no send", () => {
  assert.match(gl.OWN_VOICE_NO_DEFLECT, /when nothing is being worked on for them and they say something/);
  assert.match(gl.ACK_ASK, /"Getting the weather to you\."/);
  assert.doesNotMatch(gl.ACK_ASK, /Texting you the weather/);
});

test("paid set 3: Reason's answer comes back and is said → no ask", async () => {
  const s = startCall({ brain: async () => ({ text: "Fifty two and clear at work." }) });
  s.live.emit({ type: "session.input_transcript.delta", delta: " Weather near work?" });
  await s.timers.advance(300);
  s.live.emit({ type: "session.delegation.created", delegation: { id: "f3" } });
  await s.timers.advance(600);
  s.live.emit({ type: "session.output_audio.delta", delta: LOUD });
  await s.timers.advance(gl.REPLY_FLOOR_MS * 3);
  assert.equal(floorsOf(s).length, 0);
});
