// The Cartesia voice on the operator's own calls (design 3, "bridged": docs/calls-cartesia.md section 5).
// Twilio's media stream stays ours; its audio goes to one Cartesia Managed Agent over their agent
// WebSocket (mulaw_8000 both ways, continuous input, paced output), and what the agent says comes back
// through the same room-tone mixer and call tape GPT-Live calls use. Reason's brain sits behind the
// agent's `ask_reason` client tool (`reasonTurn`, the same turn a GPT-Live hand-off runs). The call ends
// through the same settle as every GPT-Live call (`settleGptLive`), so the thread, carryover and the
// after-call text are unchanged; then Cartesia's copy of the call is deleted, and the delete is checked.
//
// Imported only inside acceptStream's one branch (./gptlive.js), for a call `cartesiaTrialFor` says yes
// to (./calltrial.js). If the agent is not ready within READY_MS, or fails before it is, the same call
// carries on with GPT-Live (`fallBack`) and that is logged.
import { writeSealed } from "../restfiles.js";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config, clock } from "../config.js";
import { recordingFileFor } from "./recordings.js";
import * as manner from "./manner.js";
import * as ambience from "./ambience.js";
import { lookupMusicFor, MUSIC_DELAY_MS } from "./lookupmusic.js";
import { CallTape, hasSpeech, voiceInstructionsFor } from "./gptlive.js";
import { queueMidCall } from "./voice.js";
import { openingLineFor } from "./inbound.js";
import { todaySoFar } from "./brief.js";

export const API_BASE = "https://api.cartesia.ai";
export const VERSION = "2026-08-14";
/** How long the agent has, from the stream reaching us, to say `session_ready` before GPT-Live takes the call. */
export const READY_MS = 1500;
/** After a fall-back, how long a session still coming up has to say its call id, so it can be deleted. */
export const LATE_READY_MS = 5000;
/** What Cartesia charges for an agent minute (docs.cartesia.ai/pricing, read 2026-11-12); tokens are on top. */
export const CENTS_PER_MINUTE = 3;
/** The client tool Reason's brain sits behind (made by scripts/cartesia-agent-setup.mjs). */
export const ASK_REASON = "ask_reason";
/** A tool result may be 16 KiB (docs.cartesia.ai/agents/client-tools); Reason's words are cut well inside it. */
export const RESULT_MAX = 12_000;
/** Per-call keyterm slots on the agent (scripts/cartesia-agent-setup.mjs `KEYTERM_SLOTS`). */
export const KEYTERM_SLOTS = 8;
/** A dynamic variable's text, kept inside a size their docs do not state (docs/unverified.md). */
export const VARIABLE_MAX = 12_000;

// ---------- how this call sounds (Cartesia calls only) ----------

// The GPT-Live own-call words in `reason_call` were written for a voice that hands nearly everything to
// Reason and stops ("Answer first, then stop", "don't add questions"). On this line that made every
// reply close the topic, and a person thinking out loud got a lookup. These lines are added after them
// on the Cartesia agent only, and win where they differ. No GPT-Live prompt changes.

/** Conversation manner: react, then the substance, and now and then one step further. */
export const MANNER_LINES = [
  "# How this call sounds (these win over any line above that differs)",
  "Talk like a friend on the phone, not an assistant taking questions. React first, the way a person does, with a few genuine words (\"Oh, nice.\", \"Ah, that's annoying.\", \"Ha, fair.\"), then the substance.",
  "After you answer, when there's a real opening (they shared a plan, a feeling, a worry or something unfinished, or invited your reaction), you may add ONE short follow-up question or a thought of your own that moves things on. About one reply in three at most, never two questions in a row: if your last reply ended in a question, this one doesn't.",
  "No follow-up after a lookup, a task, a goodbye, or when they sound busy or rushed: just the answer.",
  "Never repeat their sentence back to them. Keep replies short: no lists, and never \"is there anything else\".",
  "Like this (made-up examples):",
  "- They: \"Repainting the kitchen this weekend, finally.\" Closed: \"Nice, good luck with it.\" Better: \"Oh, finally! What colour are you going for?\"",
  "- They: \"Long day. Glad it's over.\" Closed: \"Glad it's over.\" Better: \"Ah, one of those. Go easy on yourself tonight.\"",
  "- They: \"I keep putting off ringing my landlord.\" Closed: \"Want me to set a reminder?\" Better: \"Ugh, I get it. Is it the call itself, or what you've got to say?\"",
  "- They: \"What's on tomorrow?\" Answer what Reason gives you, and stop.",
];

/** Stay in the moment: talk about them from what is already known; ask_reason is for data and actions. */
export const MOMENT_LINES = [
  "When they talk about themselves (how they feel, what they're thinking, what they want, something they've been putting off), answer from this conversation and what you already know from the brief and earlier calls above. That is a conversation, not a lookup: stay in it.",
  "Call ask_reason only for what needs their data or an action: their calendar, mail or messages, the weather, a booking, a reminder, or \"do this\". If they then ask you to do something about it, that is when it goes to ask_reason.",
];

/** Expression: Sonic reads the feeling from the words, so the words carry it. */
export const EXPRESSION_LINES = [
  "Your voice takes its feeling from your words, so write the way you'd say it: warm and easy on personal things, light on a joke, calmer and slower on something heavy (short sentences, a comma for a beat). Keep it subtle: no exclamation marks on ordinary lines, never gushing.",
  "Say temperatures and measures in the units Reason's answer uses (it picks them from their profile, as their texts do); never convert them, and don't tack the unit's name on the end unless it would be unclear.",
];

/** With REASON_CARTESIA_EMOTION_TAGS=on: Sonic's inline emotion tag (docs.cartesia.ai .../ssml-tags, beta). */
export const EMOTION_TAG_LINE = "You may start a reply with one tag that sets its feel: <emotion value=\"content\"/> for warm, <emotion value=\"happy\"/> for good news or a joke, <emotion value=\"calm\"/> for something heavy or serious, <emotion value=\"sympathetic\"/> for something hard. Most replies need none. Never more than one in a reply, never one at odds with the words.";

/** The lines added to `reason_call` on this line: no names, nothing about anyone. */
export function cartesiaCallLines({ tags = config.cartesiaEmotionTags } = {}) {
  return [...MANNER_LINES, ...MOMENT_LINES, ...EXPRESSION_LINES, ...(tags ? [EMOTION_TAG_LINE] : [])].join("\n");
}

// ---------- a slow ask_reason ----------

// The ask_reason call stays open until Reason answers, so the answer is what the agent speaks (the agent
// says its own short line before calling, and the lookup music covers the wait). Cartesia's client can send
// only a tool result back (docs.cartesia.ai/api-reference/agents/agent-websocket: session_create,
// audio_input, dtmf_input, client_tool_result), so a line said mid-wait would mean answering the call
// early, and the real answer would then have no way back onto the call: there is no holding line.
// The tool is waited for up to 60 s on their side (scripts/cartesia-agent-setup.mjs).

/** Not back by now (from the ask): the agent says it will text it, and the answer goes by text. */
export const TEXT_MS = 25_000;
export const TEXT_RESULT = "Reason is taking too long on this one: say in one short sentence that it's taking a while and Reason will text them the answer, then carry on the conversation (don't say it's still loading, don't ask if they're still there, and don't call ask_reason for it again).";
/** How a late answer's text opens, so it reads as part of the call. */
export const lateText = (text) => `From our call: ${text}`;

// ---------- talked over ----------

/** A gap this long in his speech starts a new run of it (the onset a barge-in is timed from). */
export const RUN_GAP_MS = 500;
/** He counts as talking at a clear when his last speech frame was this recent. */
export const TALKING_MS = 1_000;
/** The agent counts as playing at a clear when its last speech frame was this recent. */
export const PLAYING_MS = 300;

/** Cartesia's agent WebSocket, as `{ send(obj), close(), on(name, fn) }` (the shape `openLiveSocket` has). */
export function openAgentSocket({ agentId = config.cartesiaAgentId, key = config.cartesiaKey, base = API_BASE } = {}) {
  const url = `${base.replace(/^http/, "ws")}/v1/agents/websocket/${encodeURIComponent(agentId)}?cartesia_version=${VERSION}`;
  const ws = new WebSocket(url, { headers: { "X-API-Key": key, "Cartesia-Version": VERSION } });
  const handlers = { open: [], event: [], close: [] };
  const run = (list, ...args) => { for (const f of list) { try { f(...args); } catch { /* one call never takes the process */ } } };
  ws.onopen = () => run(handlers.open);
  ws.onmessage = (m) => { let e; try { e = JSON.parse(String(m.data)); } catch { return; } run(handlers.event, e); };
  ws.onclose = (e) => run(handlers.close, e?.code ?? 1006);
  ws.onerror = () => { /* the close that follows says it */ };
  return {
    send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close: () => { try { ws.close(); } catch { /* already gone */ } },
    on: (name, fn) => handlers[name]?.push(fn),
  };
}

/**
 * Cartesia's copy of one agent call deleted (DELETE /agents/calls/{id}): its transcript, recording and
 * logs. Only a finished call can be deleted, so a 400 is tried again a few times. `{ ok, redacted, status }`;
 * `ok` only when the answer carries `redacted_at`. Never throws.
 */
export async function deleteAgentCall(callId, { key = config.cartesiaKey, base = API_BASE, fetchImpl = globalThis.fetch, tries = 4, waitMs = 1500, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!callId) return { ok: false, redacted: false, status: 0, why: "no call id" };
  let last = { ok: false, redacted: false, status: 0, why: "" };
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(`${base}/agents/calls/${encodeURIComponent(callId)}`, { method: "DELETE", headers: { "X-API-Key": key, "Cartesia-Version": VERSION } });
      let json = null;
      try { json = await res.json(); } catch { /* not JSON */ }
      const redacted = !!json?.redacted_at;
      last = { ok: res.ok && redacted, redacted, status: res.status, why: res.ok ? (redacted ? "" : "no redacted_at in the answer") : String(json?.message ?? json?.error ?? "").slice(0, 120) };
      if (last.ok || (res.status !== 400 && res.status !== 409 && res.status < 500)) return last;
    } catch (e) {
      last = { ok: false, redacted: false, status: 0, why: (e?.message ?? String(e)).split("\n")[0].slice(0, 120) };
    }
    if (i < tries - 1) await sleep(waitMs);
  }
  return last;
}

/**
 * What the agent is told for this call, as dynamic variables its saved instructions use: the same words a
 * GPT-Live own call is given (`voiceInstructionsFor`: the name he gave Reason, the one identity, persona,
 * carryover and his brief), and the same opening line. No second persona is written for Cartesia.
 */
export function sessionVariables(call) {
  const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  let name = "";
  try { const me = accounts.ownerOf(call.conversation_id); name = me?.name ?? ""; } catch { /* unknown */ }
  const greeting = call.direction === "in"
    ? openingLineFor({ person: accounts.ownerOf(call.conversation_id), conversationId: call.conversation_id })
    : String(call.announcement ?? "");
  // Names from his chats today, the ones the brief tells GPT-Live a bad line often garbles: the recognizer
  // favours them. A slot with nothing for it says "Reason" (an empty keyterm is not known to be allowed).
  let names = [];
  try { names = (todaySoFar(call.conversation_id, { until: Number(call.created_at) || clock.now(), call: call.id })?.names ?? []).map(n => clip(n, 60)).filter(Boolean); } catch { /* none */ }
  const keyterms = Object.fromEntries(Array.from({ length: KEYTERM_SLOTS }, (_, i) => [`keyterm_${i + 1}`, names[i] ?? "Reason"]));
  return {
    ...keyterms,
    // No turn gate here: the agent's own turn-taking replaces it (section 3), so its lines are left out.
    // This line's own manner goes last, after the brief, and is never the part cut.
    reason_call: reasonCall(call, clip),
    greeting: clip(greeting || "Hey, it's Reason.", 400),
    their_name: clip(name, 80),
  };
}

/** The GPT-Live own-call words (cut to fit), then this line's manner (`cartesiaCallLines`). */
function reasonCall(call, clip) {
  const lines = cartesiaCallLines();
  return `${clip(voiceInstructionsFor(call, { line: false, turnGate: false }), VARIABLE_MAX - lines.length - 1)}\n${lines}`;
}

const WAITED = Symbol("waited");

/** One of their own calls on the Cartesia agent: Twilio's stream on one side, the agent on the other. */
export class CartesiaAgentCall {
  constructor({ call, twilio, openAgent = openAgentSocket, brain, finish = async () => {}, fallBack = null, deleteCall = deleteAgentCall, log = () => {}, now = () => Date.now(), timers = globalThis, readyMs = READY_MS, textMs = TEXT_MS, textOwner = null }) {
    this.call = call;
    this.twilio = twilio;
    this.openAgent = openAgent;
    this.brain = brain;
    this.finishCall = finish;
    this.fallBackTo = fallBack;
    this.deleteCall = deleteCall;
    this.log = log;
    this.now = now;
    this.timers = timers;
    this.readyMs = readyMs;
    this.textMs = textMs;
    // A slow answer the agent said it would text: the outbox, as any mid-call text of Reason's (./voice.js).
    this.textOwner = textOwner ?? ((text) => queueMidCall({ call, text, kind: "cartesia_late_answer", log }));
    // Asks still waiting on Reason; one still waiting when the call ends goes by text.
    this.asking = new Set();
    // The room under the call, and with REASON_CARTESIA_LOOKUP_MUSIC on, soft music over it while a
    // lookup runs (./lookupmusic.js): `bed` is then the room with the music on top.
    const room = ambience.bedFor(call);
    const lm = lookupMusicFor(call, room, { log });
    this.music = lm?.music ?? null;
    this.musicSource = lm?.source ?? "";
    this.bed = lm?.bed ?? room;
    // Their own call is taped as a GPT-Live own call is (`GptLiveCall`: only a line call asks `callRecorded`).
    this.recorded = true;
    this.tape = new CallTape();
    if (!this.recorded) this.tape.stopAt(0);
    this.turns = [];
    this.streamSid = null;
    this.agentCallId = "";
    this.ready = false;
    this.done = false;
    this.handedOff = false;
    this.endWhy = "";
    this.startedAt = now();
    // The numbers the first call is for (section 5): kept per reply, logged as they happen and at the end.
    this.m = { replies: [], asks: [], overs: [], turnClock: [], laughs: 0, firstVoiceMs: null };
    this.theirTurnEndAt = null;
    this.askAnsweredAt = null;
    this.replyKind = "plain";
    // Talked over (`audio_output_clear`): his current run of speech, and the agent's, each from its onset.
    this.agentSpeechAt = -Infinity;
    this.agentRunAt = null;
    this.lastSpeechAt = -Infinity;
    this.speechRunAt = null;
    twilio.onMessage((text) => { if (!this.handedOff) this.fromTwilio(text); });
    twilio.onClose(() => { if (!this.handedOff) this.end("caller hung up").catch(() => {}); });
  }

  /** Open the agent and start the clock it has to be ready by. */
  begin() {
    this.readyTimer = this.timers.setTimeout(() => { if (!this.ready) this.fallBack(`not ready in ${this.readyMs} ms`); }, this.readyMs);
    try {
      this.agent = this.openAgent();
    } catch (e) {
      return this.fallBack(`could not open: ${(e?.message ?? String(e)).split("\n")[0]}`);
    }
    this.agent.on("open", () => {
      this.openedMs = this.now() - this.startedAt;
      this.agent.send({ type: "session_create", audio: { input_format: "mulaw_8000", output_delivery: "speaking_pace", continuous_input: true }, dynamic_variables: sessionVariables(this.call) });
    });
    this.agent.on("event", (e) => this.fromAgent(e));
    this.agent.on("close", (code) => {
      if (this.done || this.handedOff) return;
      if (!this.ready) return this.fallBack(`closed before ready (${code})`);
      // A clean close is the agent hanging up (its end_call); anything else is a failure, and he is still
      // on the line: GPT-Live takes the rest of the call.
      if (code === 1000 || this.endWhy === "goodbye") return void this.end(this.endWhy || "agent ended").catch(() => {});
      this.fallBack(`closed mid-call (${code})`);
    });
    this.twilio.flush?.();
  }

  // --- Twilio side ---

  fromTwilio(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.event === "start") {
      this.streamSid = m.start?.streamSid ?? m.streamSid ?? null;
      this.callSid = m.start?.callSid ?? "";
      this.streamStartAt = this.now();
      this.log({ cartesia_stream_start: this.call.id, ...(this.bed?.kind ? { ambience: this.bed.kind } : {}), ...(this.music ? { lookup_music: this.musicSource } : {}) });
      this.roomTick();
    } else if (m.event === "media" && m.media?.payload) {
      if (m.media.track && m.media.track !== "inbound") return;
      const buf = Buffer.from(m.media.payload, "base64");
      this.tape.them(buf);
      // His speech, as runs: a gap of RUN_GAP_MS starts a new one (the onset a barge-in is timed from).
      if (hasSpeech(m.media.payload)) {
        const t = this.now();
        if (t - this.lastSpeechAt > RUN_GAP_MS) this.speechRunAt = t;
        this.lastSpeechAt = t;
        this.music?.speech(t);
      }
      if (this.ready) this.agent.send({ type: "audio_input", audio: m.media.payload });
    } else if (m.event === "stop") {
      this.end("caller hung up").catch(() => {});
    }
  }

  toTwilio(obj) {
    if (!this.streamSid || this.done) return;
    if (this.bed && obj.event === "media" && obj.media?.payload) obj = { ...obj, media: { ...obj.media, payload: this.bed.mix(obj.media.payload, this.now()) } };
    this.twilio.send(JSON.stringify({ ...obj, streamSid: this.streamSid }));
  }

  /** The room under the call (./ambience.js), topped up as on a GPT-Live call. */
  roomTick() {
    if (!this.bed || this.done || this.handedOff) return;
    const frames = this.streamSid ? this.bed.fill(this.now(), { talking: false }) : null;
    if (frames) this.twilio.send(JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload: frames } }));
    this.roomTimer = this.timers.setTimeout(() => this.roomTick(), ambience.TICK_MS);
  }

  // --- the agent's side ---

  fromAgent(e) {
    // Fallen back before it was ready: a session that comes up late is a call on their side, so its id is
    // kept, the socket closed and the call deleted (no audio was ever sent to it).
    if (this.handedOff && e?.type === "session_ready" && !this.agentCallId) {
      this.agentCallId = String(e.call_id ?? "");
      if (this.lateTimer) this.timers.clearTimeout(this.lateTimer);
      try { this.agent?.close(); } catch { /* already gone */ }
      this.log({ cartesia_late_ready: this.call.id, ms: this.now() - this.startedAt });
      if (this.agentCallId) void this.deleteAndCheck();
      return;
    }
    if (this.done || this.handedOff || !e?.type) return;
    const t = this.now();
    switch (e.type) {
      case "session_ready": {
        this.agentCallId = String(e.call_id ?? "");
        if (this.ready) return;
        this.ready = true;
        if (this.readyTimer) this.timers.clearTimeout(this.readyTimer);
        this.log({ cartesia_ready: this.call.id, ms: t - this.startedAt, open_ms: this.openedMs ?? null });
        return;
      }
      case "audio_output": return this.audioOut(String(e.audio ?? ""));
      case "audio_output_clear": {
        // Their talk-over, cleared on the phone too: his first sound → their clear → ours.
        this.toTwilio({ event: "clear" });
        this.tape.cut();
        this.bed?.cleared(t);
        // Timed from when the two of them were first talking at once: his run's onset, or the agent's if it
        // started over him. Their clear also comes with nothing playing (their docs: "there is nothing to
        // clear"); that is no barge-in, and `playing` says which. Not talking now: no time.
        const playing = t - this.agentSpeechAt < PLAYING_MS;
        const talking = t - this.lastSpeechAt < TALKING_MS && this.speechRunAt != null;
        const from = talking ? Math.max(this.speechRunAt, playing && this.agentRunAt != null ? this.agentRunAt : -Infinity) : null;
        const over = { sound_to_clear_ms: from == null ? null : t - from, playing, clear_to_twilio_ms: this.now() - t };
        this.m.overs.push(over);
        this.log({ cartesia_talked_over: this.call.id, ...over });
        this.agentSpeechAt = -Infinity;
        this.agentRunAt = null;
        return;
      }
      case "client_tool_call": return void this.tool(e);
      case "turn_ended": return this.turnEnded(e);
      case "error": {
        this.log({ cartesia_error: this.call.id, code: String(e.code ?? "").slice(0, 60), fatal: !!e.fatal });
        if (e.fatal && !this.ready) return this.fallBack(`error before ready: ${String(e.code ?? "")}`);
        if (e.fatal) return this.fallBack(`error mid-call: ${String(e.code ?? "")}`);
        return;
      }
      default: return;
    }
  }

  audioOut(b64) {
    if (!b64) return;
    const t = this.now();
    const speech = hasSpeech(b64);
    if (speech) {
      if (this.m.firstVoiceMs == null && this.streamStartAt != null) {
        this.m.firstVoiceMs = t - this.streamStartAt;
        this.log({ cartesia_first_voice: this.call.id, ms: this.m.firstVoiceMs });
      }
      // He stopped talking → the first audio with speech in it, per reply; an ask_reason reply apart.
      if (this.theirTurnEndAt != null) {
        const reply = { kind: this.replyKind, ms: t - this.theirTurnEndAt, ...(this.askAnsweredAt != null ? { answered_to_speech_ms: t - this.askAnsweredAt } : {}) };
        this.m.replies.push(reply);
        this.log({ cartesia_reply: this.call.id, ...reply });
        this.theirTurnEndAt = null;
        this.askAnsweredAt = null;
        this.replyKind = "plain";
      }
      if (t - this.agentSpeechAt > RUN_GAP_MS) this.agentRunAt = t;
      this.agentSpeechAt = t;
      // The music ducks under this frame (the agent's own line), or is gone within it (the answer).
      this.music?.speech(t);
    }
    this.tape.reason(Buffer.from(b64, "base64"));
    this.toTwilio({ event: "media", media: { payload: b64 } });
  }

  turnEnded(e) {
    const text = String(e.text ?? "").replace(/\s+/g, " ").trim();
    const who = e.role === "user" ? "them" : "reason";
    if (text) this.turns.push({ who, text, at: this.now(), ...(e.interrupted ? { interrupted: true } : {}) });
    if (who === "them") {
      this.theirTurnEndAt = this.now();
      this.replyKind = "plain";
      this.askAnsweredAt = null;
    } else {
      this.m.laughs += (String(e.text ?? "").match(/\[laughter\]/gi) ?? []).length;
    }
    // Their clock beside ours (seconds into their session).
    const clock = { turn: Number(e.turn) || 0, role: who, end_time: Number(e.end_time) || null, eager_end: Number(e.eager_end_timestamp) || null, at_ms: this.now() - this.startedAt };
    this.m.turnClock.push(clock);
    this.log({ cartesia_turn: this.call.id, ...clock });
  }

  /** The conversation so far as Reason's turn reads it (the same shape a GPT-Live hand-off sends). */
  messages(request = "") {
    const out = [];
    for (const t of this.turns) {
      const role = t.who === "them" ? "user" : "assistant";
      if (out.length && out.at(-1).role === role) out.at(-1).content += ` ${t.text}`;
      else out.push({ role, content: t.text });
    }
    const asked = String(request ?? "").replace(/\s+/g, " ").trim();
    if (asked && !(out.at(-1)?.role === "user" && out.at(-1).content.includes(asked))) {
      if (out.at(-1)?.role === "user") out.at(-1).content += ` (${asked})`;
      else out.push({ role: "user", content: asked });
    }
    return out;
  }

  async tool(e) {
    const id = String(e.tool_call_id ?? "");
    const answer = (result, isError = false) => {
      if (e.expects_response === false || this.done) return;
      this.agent.send({ type: "client_tool_result", tool_call_id: id, result: String(result).slice(0, RESULT_MAX), is_error: !!isError });
    };
    if (e.tool_name !== ASK_REASON) return answer(`No tool called ${String(e.tool_name ?? "")}.`, true);
    const request = e.parameters?.request ?? e.parameters?.question ?? "";
    this.replyKind = "ask_reason";
    const askedAt = this.now();
    const p = { askedAt, texting: false, texted: false, reply: undefined, done: null };
    // The lookup has begun: music under it from MUSIC_DELAY_MS, until its answer goes back or to a text.
    this.music?.start(p, askedAt);
    this.asking.add(p);
    p.done = this.ask(request, p);
    // Waited for, up to TEXT_MS: the answer itself is the result, and the agent speaks it.
    const out = await this.within(p.done, this.textMs);
    if (p.texting) return; // the call ended meanwhile: it went by text
    if (out !== WAITED) { this.asking.delete(p); this.music?.end(p); return answer(...this.spoken(out)); }
    // Past TEXT_MS: the agent says once that it will come by text, and the answer is texted when it lands.
    this.toText(p);
    this.log({ cartesia_ask_to_text: this.call.id, ms: this.now() - askedAt });
    return answer(TEXT_RESULT);
  }

  /** This ask goes by text now: its answer as soon as it is back (at once, if it already is). */
  toText(p) {
    if (p.texting) return;
    p.texting = true;
    this.asking.delete(p);
    this.music?.end(p);
    if (p.reply !== undefined) this.textLate(p);
  }

  /** Reason's turn for one ask; logged once it is back. A late one the agent said it would text goes by text. */
  async ask(request, p) {
    let reply;
    try {
      reply = await this.brain(this.messages(request));
    } catch (err) {
      reply = { text: "", error: (err?.message ?? String(err)).split("\n")[0] };
    }
    const answeredAt = this.now();
    const ask = { asked_to_answered_ms: answeredAt - p.askedAt, error: !!reply?.error, skip: !!reply?.skip, to_text: p.texting, ...(this.music ? { music: answeredAt - p.askedAt >= MUSIC_DELAY_MS } : {}) };
    this.m.asks.push(ask);
    this.log({ cartesia_ask_reason: this.call.id, ...ask });
    this.askAnsweredAt = answeredAt;
    p.reply = reply;
    if (p.texting) this.textLate(p);
    return reply;
  }

  /** A late answer by text, once, through the outbox; words only when Reason had some. */
  textLate(p) {
    if (p.texted) return;
    p.texted = true;
    const reply = p.reply;
    const text = String(reply?.text ?? "").trim();
    if (!text || reply?.skip) { this.log({ cartesia_late_answer: this.call.id, texted: false, why: reply?.error ? "error" : "nothing to say" }); return; }
    let r;
    try { r = this.textOwner(lateText(text)); } catch (e) { r = { ok: false, why: (e?.message ?? String(e)).split("\n")[0] }; }
    this.log({ cartesia_late_answer: this.call.id, texted: !!r?.ok });
    // In the call's own record, so the after-call turn sees it went (and the read of the call does too).
    if (r?.ok && !this.done) this.turns.push({ who: "reason", text: `(Texted them: ${text.length > 300 ? `${text.slice(0, 299)}…` : text})`, at: this.now() });
  }

  /** `promise`'s value, or WAITED once `ms` have gone by first. */
  within(promise, ms) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => resolve(WAITED), Math.max(0, ms));
      promise.then((v) => { this.timers.clearTimeout(timer); resolve(v); });
    });
  }

  /** What the agent is answered with for one reply of Reason's: `[result, isError]`. */
  spoken(reply) {
    if (reply?.error && !reply?.text) return ["Reason could not answer that just now. Say so briefly and offer to try again.", true];
    if (reply?.skip || !String(reply?.text ?? "").trim()) return ["Reason has nothing to add. Reply yourself in a few words.", false];
    if (reply?.endCall) this.endWhy = "goodbye";
    return [reply.text, false];
  }

  /** Answering-machine detection is only asked for on third-party calls; their own call has nothing to do with a verdict. */
  amd() {}

  // --- falling back, and the end ---

  /** Not ready in time, or broken before it was: the same call carries on with GPT-Live. */
  fallBack(why) {
    if (this.done || this.handedOff) return null;
    this.handedOff = true;
    this.music?.stop();
    for (const k of ["readyTimer", "roomTimer"]) if (this[k]) this.timers.clearTimeout(this[k]);
    this.log({ cartesia_fell_back: this.call.id, why: String(why).slice(0, 120), ms: this.now() - this.startedAt });
    // A session that did start is a call on their side, kept until deleted. One still coming up is given
    // LATE_READY_MS to say its id (`fromAgent`), then let go.
    if (this.agentCallId) { try { this.agent?.close(); } catch { /* already gone */ } void this.deleteAndCheck(); }
    else if (this.agent && !/closed|could not open/.test(String(why))) this.lateTimer = this.timers.setTimeout(() => { try { this.agent?.close(); } catch { /* already gone */ } }, LATE_READY_MS);
    else { try { this.agent?.close(); } catch { /* already gone */ } }
    // What was said so far goes with the call, so Reason's turns and the thread have all of it.
    return this.fallBackTo ? this.fallBackTo(why, this.turns.map(t => ({ ...t }))) : null;
  }

  async deleteAndCheck() {
    const d = await this.deleteCall(this.agentCallId);
    this.log({ cartesia_recording_deleted: this.call.id, ok: !!d?.ok, redacted: !!d?.redacted, status: d?.status ?? 0 });
    return d;
  }

  async end(why = "") {
    if (this.done || this.handedOff) return;
    this.done = true;
    this.music?.stop();
    // A lookup still running when the call ends: its answer goes by text when it lands.
    for (const p of [...this.asking]) this.toText(p);
    this.endWhy = this.endWhy || why;
    for (const k of ["readyTimer", "roomTimer"]) if (this[k]) this.timers.clearTimeout(this[k]);
    try { this.agent?.close(); } catch { /* already gone */ }
    if (this.twilio.open?.()) this.twilio.close();
    const seconds = Math.round((this.now() - this.startedAt) / 1000);
    const turns = this.turns.map(t => ({ who: t.who, text: t.text })).filter(t => t.text);
    let recording = null;
    let recordingWhy = "";
    try {
      if (!this.recorded) recordingWhy = manner.NOT_RECORDED_WHY;
      else if (this.tape.seconds() >= 1) {
        const file = recordingFileFor(this.call.id, "wav");
        writeSealed(file, this.call.conversation_id, this.tape.wav());
        recording = { path: file, format: "wav", seconds: Math.round(this.tape.seconds()) };
      } else recordingWhy = "the line carried less than a second of audio";
    } catch (e) {
      recordingWhy = `the call audio could not be written: ${(e?.message ?? String(e)).split("\n")[0]}`;
    }
    const live = {
      state: this.ready || turns.some(t => t.who === "them") ? "completed" : "failed",
      outcome: "", summary: "",
      transcript: turns.map(t => `${t.who === "them" ? "Them" : "Reason"}: ${t.text}`).join("\n"),
      turns, durationS: seconds,
      costCents: Math.round((seconds / 60) * CENTS_PER_MINUTE),
      termination: this.endWhy === "caller hung up" ? "hung up" : this.endWhy === "goodbye" ? "end_call (mutual goodbye)" : this.endWhy,
      cutOff: null,
      costRaw: JSON.stringify({ voice: "cartesia", voice_seconds: seconds, cents_per_minute: CENTS_PER_MINUTE, first_voice_ms: this.m.firstVoiceMs }),
      recording, recordingWhy,
      ...(this.recorded ? {} : { notRecorded: true }),
    };
    try { db.updateCall(this.call.conversation_id, this.call.id, { first_audio_ms: this.m.firstVoiceMs ?? null }); } catch { /* a number never breaks a call */ }
    const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    this.log({
      cartesia_call_ended: this.call.id, why: this.endWhy, seconds, cents: live.costCents, first_voice_ms: this.m.firstVoiceMs,
      replies: this.m.replies.length, plain_reply_ms: med(this.m.replies.filter(r => r.kind === "plain").map(r => r.ms)),
      ask_reply_ms: med(this.m.replies.filter(r => r.kind === "ask_reason").map(r => r.ms)),
      asks: this.m.asks.length, ask_answered_ms: med(this.m.asks.map(a => a.asked_to_answered_ms)),
      talked_over: this.m.overs.filter(o => o.playing).length, clears: this.m.overs.length,
      talked_over_ms: med(this.m.overs.filter(o => o.playing).map(o => o.sound_to_clear_ms)),
      asks_texted: this.m.asks.filter(a => a.to_text).length, laughs_written: this.m.laughs,
    });
    // Their copy goes whatever the settle does; both are waited for, neither stops the other.
    const deleting = this.agentCallId ? this.deleteAndCheck().catch(() => null) : Promise.resolve(null);
    try { await this.finishCall(live); } catch (e) { this.log({ cartesia_settle_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
    await deleting;
  }
}
