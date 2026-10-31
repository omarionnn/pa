// GPT-Live (OpenAI `gpt-live-1`) as a second voice for Reason's phone calls — a trial, beside
// ElevenLabs, so the owner can compare the two on real calls (2026-10-31).
//
// The split is the whole design: GPT-Live is only the VOICE. It listens, speaks and decides when to
// ask for help; every question and every action goes to Reason through CLIENT delegation — the same
// `llmRequest` turn ElevenLabs' custom-LLM requests run (src/calls/voice.js), with the same context,
// tools, memory, harm screen, confirm gate and NO_REPLY / spoken-args filtering. No OpenAI model does
// Reason's thinking.
//
// Who gets it: REASON_CALL_VOICE=gptlive, and then only calls on the OPERATOR's own conversation
// (`gptliveFor`). Anyone else, and every call with the flag unset, is ElevenLabs exactly as before —
// this file is never reached for them.
//
// The phone line: Twilio Media Streams. Twilio carries the call and streams 8 kHz μ-law both ways over
// a WebSocket to /calls/gptlive/stream/{token}; this file relays it to a GPT-Live WebSocket session,
// which takes μ-law natively (audio/pcmu), so audio is forwarded byte for byte. Outbound, Reason asks
// Twilio to dial with that stream as the call's TwiML. Inbound, the number's voice webhook would have
// to point at /calls/gptlive/inbound, which sends the owner here and redirects everyone else to
// ElevenLabs' own Twilio URL unchanged. Both need TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, which only
// the owner can supply: the number lives in ElevenLabs, and its Twilio keys were never on this machine.
//
// Docs read 2026-10-31: developers.openai.com/api/docs/guides/live, live-delegation (client mode),
// voice-websockets (pcmu 8k), voice-server-controls (playback control), live-conversations (greeting,
// usage, close), voice-sip, live-partner-integrations (Twilio Media Streams).
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config, clock, normalizeNumber } from "../config.js";
import { llmRequest, withoutSilenceMarker, METER_KINDS, THINKING_FILLER } from "./voice.js";
import { recordingFileFor } from "./recordings.js";
import { writeCallIntoThread, noteOnTask, tellTheOwner } from "./postcall.js";
import * as fromcall from "./fromcall.js";
import { openingLineFor, recordingNoteFor, whoseCallIsThis } from "./inbound.js";

export const PROVIDER = "gptlive";
export const STREAM_PATH = "/calls/gptlive/stream/";
export const STATUS_PATH = "/calls/gptlive/status/";
export const INBOUND_PATH = "/calls/gptlive/inbound";
const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
/** $0.05 a minute for the voice layer (developers.openai.com/api/docs/models/gpt-live-1, 2026-10-31). */
export const CENTS_PER_MINUTE = 5;
/** The external id prefix, so a check() can tell a GPT-Live call from an ElevenLabs conversation id. */
const EXT = "gptlive:";

// ---------- who gets it ----------

/** Is GPT-Live the voice for calls on this conversation? Only with the flag on, and only the operator. */
export function gptliveFor(conversationId) {
  if (config.callVoice !== "gptlive" || !conversationId) return false;
  try { return accounts.ownerOf(conversationId)?.isOperator === true; } catch { return false; }
}

/** What this machine is missing to place a GPT-Live call. Empty when it can. */
export function missingForGptlive() {
  const need = {
    OPENAI_API_KEY: config.openaiKey, TWILIO_ACCOUNT_SID: config.twilioSid, TWILIO_AUTH_TOKEN: config.twilioToken,
    "TWILIO_FROM_NUMBER (or ELEVENLABS_PHONE_NUMBER)": config.twilioFrom, REASON_PUBLIC_URL: config.publicUrl,
    ELEVENLABS_LLM_SECRET: config.elevenLlmSecret,
  };
  return Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
}

// ---------- what the voice is told ----------

/**
 * The live prompt. Short on purpose (their guidance: keep task rules in the backend). The rules that
 * matter are the delegation rule — everything beyond small talk goes to Reason — and the honesty rule,
 * which code also enforces (`claimsDone` and the guard in `GptLiveCall`).
 */
export function liveInstructions({ name = "them" } = {}) {
  return [
    `You are the voice of Reason, ${name}'s personal assistant, on a phone call with ${name}.`,
    "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.",
    `You are only the voice. Reason, the backend, does all of the thinking and every action: it has ${name}'s messages, calendar, memory, tasks and tools.`,
    "Delegate to the backend for every question, request, instruction or opinion — anything beyond a greeting, a brief listening sound, or asking them to repeat something.",
    "Never answer from your own knowledge, and never invent a fact, time, name, number or price.",
    "While the backend works, a very short acknowledgement is fine. Do not fill the silence with guesses.",
    "Never say anything is done, booked, sent, texted, ordered, paid, scheduled, cancelled or confirmed unless the backend's result says so. If the result says it is not done, only started, or needs their approval, say exactly that.",
    "When a backend result arrives, say it naturally and briefly, keeping every fact, number and name exactly as given. Do not add offers or questions the result did not include.",
    "Never read out links, codes, IDs or anything in square brackets, and never say the words NO_REPLY.",
    "Stop speaking when they talk over you, and listen.",
  ].join("\n");
}

/** The session.start body. μ-law at 8 kHz both ways, so Twilio's frames go straight through. */
export function sessionConfig({ name, greeting = "" } = {}) {
  const session = {
    model: config.gptliveModel,
    instructions: liveInstructions({ name }),
    audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: config.gptliveVoice } },
    delegation: { type: "client" },
  };
  if (greeting) {
    session.input = [{ type: "message", role: "developer", content: [{ type: "input_text", text: greetingInstruction(greeting) }] }];
  }
  return session;
}

export function greetingInstruction(greeting) {
  return `Greet them now in English with this line, in your own voice: "${String(greeting).replace(/"/g, "'")}" Then stop and listen.`;
}

// ---------- the honesty guard ----------

// A spoken claim that something has happened. First person ("I've booked", "I sent"), or about the
// thing ("it's booked", "that's been sent", "you're all set"). A negation in between breaks the match:
// "it's not booked yet" and "I haven't sent it" are not claims.
const DONE_WORDS = "done|booked|sent|texted|emailed|messaged|ordered|paid|cancel+ed|reserved|purchased|bought|scheduled|placed|submitted|confirmed|added|created|set up|sorted|arranged|finished";
const CLAIM = new RegExp([
  `\\b(?:i(?:'|’)ve|i have|i(?:'|’)ve just|it(?:'|’)s|that(?:'|’)s|it has|that has|it is|that is|they(?:'|’)re|those are|all)\\s+(?:all\\s+|now\\s+|just\\s+|already\\s+|been\\s+)*(?:${DONE_WORDS})\\b`,
  `\\bi\\s+(?:just\\s+|already\\s+)?(?:booked|sent|texted|emailed|messaged|ordered|paid|cancel+ed|reserved|purchased|bought|scheduled|placed|submitted|confirmed)\\b`,
  `\\byou(?:'|’)re (?:all )?(?:set|booked|confirmed|sorted)\\b`,
  `\\b(?:all )?done\\s*[.!]`,
].join("|"), "i");

/** Does this say something has been done? Exported for the tests. */
export function claimsDone(text) {
  return CLAIM.test(String(text ?? ""));
}

/** The words the voice is given when it claimed something nobody confirmed. Code's words, never the caller's. */
export const GUARD_CORRECTION = "Stop. Nothing has been confirmed as done yet. In a few words, correct yourself: say it is not done yet"
  + " and you are still waiting on it. Do not say it is done until the backend's result says so.";

// ---------- reading Reason's turn ----------

const SPOKEN_FILLERS = new Set([...METER_KINDS.holdingLines, ...METER_KINDS.fillers, THINKING_FILLER].map(s => s.trim().toLowerCase()));

/**
 * What one Reason turn (the SSE stream `llmRequest` answers with) says, for the voice to say.
 *
 * The code's own holding lines and "one sec" fillers are dropped — they exist to keep ElevenLabs from
 * hanging up on a silent custom LLM, and GPT-Live holds the line itself. The NO_REPLY marker is taken
 * out again here as a second net. Platform tools come back as their names: `end_call` (with its
 * optional spoken message) is honoured; `skip_turn` means nothing to say.
 */
export async function readTurn(stream) {
  const said = [];
  const tools = new Map();
  for await (const chunk of stream) {
    for (const line of String(chunk).split("\n")) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === "[DONE]") continue;
      let j;
      try { j = JSON.parse(m[1]); } catch { continue; }
      const d = j?.choices?.[0]?.delta ?? {};
      if (typeof d.content === "string" && d.content) said.push(d.content);
      for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const k = t.index ?? 0;
        const got = tools.get(k) ?? { name: "", args: "" };
        if (t.function?.name) got.name = t.function.name;
        if (t.function?.arguments) got.args += t.function.arguments;
        tools.set(k, got);
      }
    }
  }
  const kept = said.filter(s => !SPOKEN_FILLERS.has(s.trim().toLowerCase()));
  const text = withoutSilenceMarker(kept.join("").replace(/\s+/g, " ").trim()).text;
  const names = [...tools.values()].map(t => t.name).filter(Boolean);
  let endCall = null;
  const end = [...tools.values()].find(t => t.name === "end_call");
  if (end) {
    let args = {};
    try { args = JSON.parse(end.args || "{}"); } catch { /* no args is a plain hang-up */ }
    endCall = { message: withoutSilenceMarker(String(args.message ?? "")).text.trim() };
  }
  return { text, tools: names, endCall, skip: !text && names.includes("skip_turn") };
}

// ---------- μ-law and the recording ----------

/** One G.711 μ-law byte as a 16-bit sample. */
export function ulawToPcm(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let s = ((mant << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}

/**
 * Both sides of the call on one timeline, as the caller heard it. Their frames arrive in real time
 * (20 ms each) and set the clock; Reason's audio is laid down from where the clock is when it was
 * sent, and a `clear` (barge-in, guard) cuts what Twilio never played.
 */
export class CallTape {
  constructor() { this.caller = []; this.callerBytes = 0; this.segs = []; this.reasonEnd = 0; }
  them(buf) { this.caller.push(buf); this.callerBytes += buf.length; }
  reason(buf) {
    const at = Math.max(this.reasonEnd, this.callerBytes);
    this.segs.push({ at, buf });
    this.reasonEnd = at + buf.length;
  }
  /** Everything of Reason's from now on was never played. */
  cut() {
    const at = this.callerBytes;
    this.segs = this.segs.filter(s => s.at < at).map(s => (s.at + s.buf.length > at ? { at: s.at, buf: s.buf.subarray(0, at - s.at) } : s));
    this.reasonEnd = Math.min(this.reasonEnd, at);
  }
  seconds() { return Math.max(this.callerBytes, this.reasonEnd) / 8000; }
  /** A mono 16-bit 8 kHz WAV of the mix. */
  wav() {
    const n = Math.max(this.callerBytes, this.reasonEnd);
    const mix = new Int32Array(n);
    let i = 0;
    for (const b of this.caller) for (const u of b) mix[i++] += ulawToPcm(u);
    for (const s of this.segs) for (let k = 0; k < s.buf.length; k++) mix[s.at + k] += ulawToPcm(s.buf[k]);
    const data = Buffer.alloc(n * 2);
    for (let k = 0; k < n; k++) data.writeInt16LE(Math.max(-32768, Math.min(32767, mix[k])), k * 2);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  }
}

// ---------- the OpenAI side ----------

/** A GPT-Live WebSocket, as `{ send(obj), close(), on(name, fn) }`. Node's own WebSocket, key in a header. */
export function openLiveSocket({ url = LIVE_URL, key = config.openaiKey } = {}) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
  const handlers = { open: [], event: [], close: [] };
  ws.onopen = () => handlers.open.forEach(f => f());
  ws.onmessage = (m) => { let e; try { e = JSON.parse(String(m.data)); } catch { return; } handlers.event.forEach(f => f(e)); };
  ws.onclose = (e) => handlers.close.forEach(f => f(e?.code ?? 1006));
  ws.onerror = () => { /* the close that follows says it */ };
  return {
    send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close: () => { try { ws.close(); } catch { /* already gone */ } },
    on: (name, fn) => handlers[name]?.push(fn),
  };
}

// ---------- one call ----------

/**
 * One call on the line: Twilio's media stream on one side, a GPT-Live session on the other, Reason
 * behind it through client delegation.
 *
 * `twilio` is the accepted media-stream socket (`send(text)`, `close()`, `onMessage`, `onClose`).
 * `openLive` and `brain` are injected so the suite can run a call with no network: `brain(messages)`
 * resolves `{ text, tools, endCall, skip }` (see `readTurn`).
 */
export class GptLiveCall {
  constructor({ call, twilio, openLive = openLiveSocket, brain = null, log = () => {}, now = () => Date.now(), finish = async () => {}, timers = globalThis }) {
    this.call = call;
    this.twilio = twilio;
    this.openLive = openLive;
    this.brain = brain ?? ((messages) => reasonTurn({ call, messages, log }));
    this.log = log;
    this.now = now;
    this.finishCall = finish;
    this.timers = timers;
    this.name = accounts.ownerOf(call.conversation_id)?.name || "them";
    this.greeting = call.direction === "in"
      ? openingLineFor({ person: accounts.ownerOf(call.conversation_id), conversationId: call.conversation_id })
      : String(call.announcement ?? "");
    this.turns = this.greeting ? [{ who: "reason", text: this.greeting, at: now(), seeded: true }] : [];
    this.tape = new CallTape();
    this.pending = new Map();
    this.delegations = 0;
    this.latest = null;
    this.lastResultClaimed = false;
    this.lastCallerAt = 0;
    this.lastOutAt = 0;
    this.lastOutTextAt = 0;
    this.utter = "";
    this.playheadAt = 0;
    this.mute = null;
    this.guardTrips = 0;
    this.seconds = 0;
    this.endWhy = "";
    this.ending = false;
    this.done = false;
    this.started = false;
    this.streamSid = null;
    this.startedAt = now();
    twilio.onMessage((text) => this.fromTwilio(text));
    twilio.onClose(() => this.end("caller hung up"));
  }

  // --- Twilio side ---

  fromTwilio(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.event === "start") {
      this.streamSid = m.start?.streamSid ?? m.streamSid ?? null;
      this.callSid = m.start?.callSid ?? "";
      this.log({ gptlive_stream_start: this.call.id, sid: this.callSid });
      this.connect();
    } else if (m.event === "media" && m.media?.payload) {
      if (m.media.track && m.media.track !== "inbound") return;
      const buf = Buffer.from(m.media.payload, "base64");
      this.tape.them(buf);
      if (this.started) this.live.send({ type: "session.input_audio.append", audio: m.media.payload });
    } else if (m.event === "stop") {
      this.end("caller hung up");
    }
  }

  toTwilio(obj) {
    if (!this.streamSid) return;
    this.twilio.send(JSON.stringify({ ...obj, streamSid: this.streamSid }));
  }

  queuedMs() { return Math.max(0, this.playheadAt - this.now()); }

  /** Throw away whatever Twilio has buffered and not played. */
  clearPlayback(why) {
    this.toTwilio({ event: "clear" });
    this.tape.cut();
    this.playheadAt = this.now();
    this.log({ gptlive_cleared: this.call.id, why });
  }

  // --- GPT-Live side ---

  connect() {
    this.live = this.openLive();
    this.live.on("open", () => {
      this.live.send({ type: "session.start", event_id: `start_${this.call.id}`, session: sessionConfig({ name: this.name, greeting: this.greeting }) });
    });
    this.live.on("event", (e) => this.fromLive(e));
    this.live.on("close", (code) => {
      this.log({ gptlive_session_socket_closed: this.call.id, code });
      if (!this.done) this.end(this.endWhy || `voice session closed (${code})`);
    });
  }

  fromLive(e) {
    switch (e.type) {
      case "session.started":
        this.started = true;
        this.sessionId = e.session?.id ?? "";
        this.log({ gptlive_session: this.call.id, session: this.sessionId });
        try { db.updateCall(this.call.conversation_id, this.call.id, { tts_model: `${config.gptliveModel}/${config.gptliveVoice}` }); } catch { /* a label never breaks a call */ }
        if (this.greeting) this.live.send({ type: "session.commentary.append", event_id: `greet_${this.call.id}`, delegation_id: null, content: greetingInstruction(this.greeting) });
        return;
      case "session.output_audio.delta":
        return this.audioOut(e.delta);
      case "session.output_transcript.delta":
        return this.textOut(String(e.delta ?? ""));
      case "session.input_transcript.delta":
        return this.textIn(String(e.delta ?? ""));
      case "session.delegation.created":
        return void this.delegate(e.delegation?.id);
      case "session.instructions.appended":
        if (this.mute && e.client_event_id === this.mute.eventId) this.mute.acked = true;
        return;
      case "session.usage.updated":
        if (Number.isFinite(e.usage?.seconds)) this.seconds = e.usage.seconds;
        return;
      case "session.closed":
        if (Number.isFinite(e.usage?.seconds)) this.seconds = e.usage.seconds;
        this.closedReason = e.reason ?? "";
        this.closedResolve?.();
        return;
      case "error":
        this.log({ gptlive_error: this.call.id, code: e.error?.code ?? "", message: String(e.error?.message ?? "").slice(0, 200) });
        return;
      default:
    }
  }

  audioOut(b64) {
    const t = this.now();
    if (this.mute) {
      // The guard is holding the voice. Released once the correction is in and the claim's audio has
      // stopped arriving, or after four seconds whatever happens, so a lost ack never mutes a call.
      const quietFor = t - this.mute.lastDropAt;
      if ((this.mute.acked && quietFor >= 300) || t - this.mute.since > 4000) {
        this.log({ gptlive_guard_released: this.call.id, ms: t - this.mute.since });
        this.mute = null;
      } else {
        this.mute.lastDropAt = t;
        return;
      }
    }
    const buf = Buffer.from(b64, "base64");
    this.lastOutAt = t;
    this.tape.reason(buf);
    this.playheadAt = Math.max(this.playheadAt, t) + buf.length / 8;
    this.toTwilio({ event: "media", media: { payload: b64 } });
    for (const turn of this.pending.values()) if (turn.firstAudioMs == null) turn.firstAudioMs = t - turn.startedAt;
    for (const turn of this.answered ?? []) {
      if (turn.firstRealMs == null && t >= turn.resultAt) {
        turn.firstRealMs = t - turn.startedAt;
        if (turn.firstAudioMs == null) turn.firstAudioMs = turn.firstRealMs;
        this.heard(turn);
      }
    }
  }

  textOut(delta) {
    const t = this.now();
    if (t - this.lastOutTextAt > 1500) this.utter = "";
    this.lastOutTextAt = t;
    this.utter += delta;
    const last = this.turns.at(-1);
    if (last && last.who === "reason" && !last.seeded && t - last.at < 4000) { last.text += delta; last.at = t; }
    else this.turns.push({ who: "reason", text: delta.trimStart(), at: t });
    // Words of the claim already being held back are not a second claim; anything a second on is.
    if (this.mute && t - this.mute.since < 1000) return;
    const said = withoutSilenceMarker(this.utter);
    const unconfirmed = claimsDone(this.utter) && (this.pending.size > 0 || !this.lastResultClaimed);
    if (said.had || unconfirmed) this.guard(said.had ? "said the silence marker" : "claimed done before Reason confirmed it");
  }

  /** The honesty guard: stop the audio the caller has not heard yet and make the voice correct itself. */
  guard(why) {
    const t = this.now();
    this.guardTrips++;
    const eventId = `guard_${this.call.id}_${this.guardTrips}`;
    this.mute = { since: t, lastDropAt: t, acked: false, eventId };
    this.utter = "";
    this.clearPlayback("guard");
    this.live.send({ type: "session.instructions.append", event_id: eventId, delegation_id: null, content: GUARD_CORRECTION });
    this.log({ gptlive_guard: this.call.id, why, pending: this.pending.size });
  }

  textIn(delta) {
    const t = this.now();
    this.lastCallerAt = t;
    const last = this.turns.at(-1);
    if (last && last.who === "them" && t - last.at < 4000) { last.text += delta; last.at = t; }
    else this.turns.push({ who: "them", text: delta.trimStart(), at: t });
    // Barge-in. The voice stops generating when it is talked over, but what Twilio already holds keeps
    // playing; if no new audio has come since they spoke, that buffer is stale and is dropped.
    if (this.queuedMs() > 250) {
      this.timers.setTimeout(() => {
        if (this.lastOutAt < t && this.queuedMs() > 250) this.clearPlayback("barge_in");
      }, 350);
    }
  }

  /** The call so far, as the messages a Reason turn reads: their words as user turns, the voice's as assistant. */
  messages() {
    const out = [];
    for (const t of this.turns) {
      const text = t.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const role = t.who === "them" ? "user" : "assistant";
      if (out.length && out.at(-1).role === role) out.at(-1).content += ` ${text}`;
      else out.push({ role, content: text });
    }
    return out;
  }

  async delegate(id) {
    if (!id) return;
    this.delegations++;
    const turn = { id, startedAt: this.now(), msgCount: 0, firstAudioMs: null, firstRealMs: null, resultAt: null };
    this.pending.set(id, turn);
    this.latest = id;
    const messages = this.messages();
    turn.msgCount = messages.length;
    this.log({ gptlive_delegation: this.call.id, n: this.delegations, messages: messages.length });
    // A slow turn: the voice is told, not asked to speak, that nothing has finished — so if they ask,
    // the honest answer is to hand.
    const late = this.timers.setTimeout(() => {
      if (this.pending.has(id)) this.live.send({ type: "session.thinking.append", event_id: `late_${id}`, delegation_id: id, content: "Reason is still working on this; there is no result yet." });
    }, 8000);
    let reply;
    try {
      reply = await this.brain(messages);
    } catch (e) {
      reply = { text: "Something broke on my end there.", tools: [], endCall: null, skip: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    this.timers.clearTimeout(late);
    this.pending.delete(id);
    if (this.done) return;
    if (this.latest !== id) {
      // They said something new while this ran; Reason has already started on that, and this answer is
      // to a question that has moved on.
      this.log({ gptlive_delegation_superseded: this.call.id });
      return;
    }
    turn.resultAt = this.now();
    turn.totalMs = turn.resultAt - turn.startedAt;
    const spoken = [reply.text, reply.endCall?.message].filter(Boolean).join(" ").trim();
    if (spoken) {
      this.lastResultClaimed = claimsDone(spoken);
      this.live.send({ type: "session.commentary.append", event_id: `result_${id}`, delegation_id: id, content: spoken.slice(0, 1800) });
      (this.answered ??= []).push(turn);
    } else {
      this.live.send({ type: "session.thinking.append", event_id: `result_${id}`, delegation_id: id, content: "Reason has nothing to add right now. Say nothing more about it and listen." });
      this.heard(turn);
    }
    this.log({ gptlive_result: this.call.id, ms: turn.totalMs, chars: spoken.length, tools: reply.tools ?? [], ends: !!reply.endCall, ...(reply.error ? { error: reply.error } : {}) });
    if (reply.endCall) this.hangUpAfterSpeech();
  }

  /** What the caller heard for one turn, onto the call_turns row Reason's own turn wrote. */
  heard(turn) {
    this.answered = (this.answered ?? []).filter(t => t !== turn);
    try {
      db.markCallTurnHeard(this.call.id, turn.msgCount, {
        voice: PROVIDER, firstContentMs: turn.firstAudioMs, firstRealMs: turn.firstRealMs,
        firstContentKind: turn.firstAudioMs == null ? null : turn.firstRealMs != null && turn.firstAudioMs >= turn.firstRealMs ? "real" : "ack",
      });
    } catch (e) {
      this.log({ gptlive_turn_row_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] });
    }
  }

  /** Reason asked to hang up: let the goodbye play out, then end the stream (which ends the call). */
  hangUpAfterSpeech() {
    if (this.ending) return;
    this.ending = true;
    this.endWhy = "end_call";
    const started = this.now();
    const tick = () => {
      if (this.done) return;
      const t = this.now();
      const quiet = t - this.lastOutAt > 1500 && this.queuedMs() === 0;
      if ((quiet && t - started > 2500) || t - started > 15000) return void this.end("end_call");
      this.timers.setTimeout(tick, 250);
    };
    this.timers.setTimeout(tick, 250);
  }

  // --- the end ---

  async end(why) {
    if (this.done) return;
    this.done = true;
    this.endWhy = this.endWhy || why;
    for (const turn of [...this.pending.values(), ...(this.answered ?? [])]) this.heard(turn);
    // Their usage arrives on session.closed; wait for it briefly, then let go either way.
    if (this.live && this.started) {
      await new Promise((resolve) => {
        this.closedResolve = resolve;
        this.live.send({ type: "session.close", event_id: `close_${this.call.id}` });
        this.timers.setTimeout(resolve, 3000);
      });
    }
    this.live?.close();
    if (this.twilio.open?.()) this.twilio.close();
    const seconds = this.seconds || Math.round((this.now() - this.startedAt) / 1000);
    const turns = this.turns.map(t => ({ who: t.who, text: t.text.replace(/\s+/g, " ").trim() })).filter(t => t.text);
    let recording = null;
    let recordingWhy = "";
    try {
      if (this.tape.seconds() >= 1) {
        const path = recordingFileFor(this.call.id, "wav");
        writeFileSync(path, this.tape.wav(), { mode: 0o600 });
        recording = { path, format: "wav", seconds: Math.round(this.tape.seconds()) };
      } else recordingWhy = "the line carried less than a second of audio";
    } catch (e) {
      recordingWhy = `the call audio could not be written: ${(e?.message ?? String(e)).split("\n")[0]}`;
    }
    const live = {
      state: this.started || turns.some(t => t.who === "them") ? "completed" : "failed",
      outcome: "", summary: "",
      transcript: turns.map(t => `${t.who === "them" ? "Them" : "Reason"}: ${t.text}`).join("\n"),
      turns, durationS: seconds,
      costCents: Math.round((seconds / 60) * CENTS_PER_MINUTE),
      termination: this.endWhy === "end_call" ? "end_call" : this.endWhy === "caller hung up" ? "hung up" : this.endWhy,
      costRaw: JSON.stringify({ voice_seconds: seconds, cents_per_minute: CENTS_PER_MINUTE, session: this.sessionId ?? "", guard_trips: this.guardTrips }),
      recording, recordingWhy,
    };
    this.log({ gptlive_call_ended: this.call.id, why: this.endWhy, seconds, delegations: this.delegations, guard_trips: this.guardTrips, closed: this.closedReason ?? "" });
    try { await this.finishCall(live); } catch (e) { this.log({ gptlive_settle_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
  }
}

/** One Reason turn for the call, run exactly as an ElevenLabs custom-LLM request is. */
export async function reasonTurn({ call, messages, log = () => {}, extras = {} }) {
  const out = await llmRequest({
    rawBody: JSON.stringify({
      model: "reason", messages,
      elevenlabs_extra_body: { reason_call_id: call.id, reason_conversation_id: call.conversation_id, reason_kind: call.is_owner ? "owner" : "third_party" },
    }),
    headers: { authorization: `Bearer ${config.elevenLlmSecret}` },
    log, extras,
  });
  if (!out.stream) return { text: "", tools: [], endCall: null, skip: true, error: `turn refused (${out.status})` };
  return readTurn(out.stream);
}

/** The settle path every finished call takes, the same steps as an ElevenLabs post-call delivery. */
export async function settleGptLive({ row, live, settle, runtime = null, log = () => {} }) {
  const fresh = db.getCall(row.conversation_id, row.id) ?? row;
  if (!["placing", "ringing", "in_progress"].includes(fresh.state) && fresh.recording_state !== "pending") return fresh;
  const settled = settle ? await settle(fresh.conversation_id, fresh, live, { log }) : fresh;
  const wrote = writeCallIntoThread({ row: settled, live, log });
  const noted = noteOnTask({ row: settled, live, log });
  fromcall.onCallEnded(settled, { log });
  const told = await tellTheOwner({ row: settled, live, runtime, log });
  log({ post_call: settled.id, provider: PROVIDER, state: settled.state, recording: settled.recording_state, turns_written: wrote.turns, told: told.sent, task: noted.taskId ?? null });
  return settled;
}

// ---------- Twilio ----------

/** Twilio's request signature: HMAC-SHA1 over the full URL plus the sorted POST params, base64. */
export function twilioSignature(url, params = {}, token = config.twilioToken) {
  const data = Object.keys(params).sort().reduce((s, k) => s + k + String(params[k] ?? ""), String(url));
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilio({ url, params, headers, token = config.twilioToken }) {
  if (!token) return false;
  const given = String(headers?.["x-twilio-signature"] ?? "");
  const want = twilioSignature(url, params, token);
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The TwiML that hands a call to the media stream for one call row. */
export function streamTwiml(row, base = config.publicUrl) {
  const wss = String(base).replace(/^http/, "ws").replace(/\/+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(`${wss}${STREAM_PATH}${row.webhook_token}`)}"/></Connect></Response>`;
}

async function twilioPost(path, form, { fetchImpl = globalThis.fetch } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) body.append(k, String(one));
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json };
}

/** Twilio's call states, in Reason's words. */
export function stateFromTwilio(s) {
  return ({
    queued: "placing", initiated: "placing", ringing: "ringing", "in-progress": "in_progress",
    completed: "completed", busy: "busy", "no-answer": "no_answer", failed: "failed", canceled: "failed",
  })[String(s ?? "")] ?? "placing";
}

// ---------- the provider, wrapped ----------

/**
 * The call provider the runtime is handed, with GPT-Live in front of it for the operator's own calls.
 *
 * Everything else — `status()`, webhooks, every third-party call, every call with the flag off — is
 * the wrapped provider (ElevenLabs) untouched. `place` routes an owner call on the operator's
 * conversation here; `check` routes ids this file issued. With the flag unset this returns the inner
 * provider itself, so not even the wrapper is in the path.
 */
export function withGptLive(inner, { fetchImpl = null } = {}) {
  if (config.callVoice !== "gptlive" || !inner) return inner;
  const live = new Map();
  const place = async (args) => {
    if (args?.kind !== "owner" || !gptliveFor(args?.conversationId)) return inner.place(args);
    const missing = missingForGptlive();
    if (missing.length) return inner.place(args);
    const row = db.getCall(args.conversationId, args.callId);
    if (!row?.webhook_token) return inner.place(args);
    const out = await twilioPost("/Calls.json", {
      To: args.to, From: config.twilioFrom, Twiml: streamTwiml(row),
      StatusCallback: `${config.publicUrl}${STATUS_PATH}${row.webhook_token}`,
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"], StatusCallbackMethod: "POST",
      Timeout: 30,
    }, fetchImpl ? { fetchImpl } : {});
    if (!out.ok || !out.json?.sid) return { ok: false, error: `Twilio refused the call (${out.status}${out.json?.message ? `: ${out.json.message}` : ""})` };
    live.set(out.json.sid, "placing");
    return { ok: true, externalId: `${EXT}${out.json.sid}`, state: "placing", provider: PROVIDER, ttsModel: `${config.gptliveModel}/${config.gptliveVoice}` };
  };
  const check = async (externalId) => {
    if (!String(externalId ?? "").startsWith(EXT)) return inner.check(externalId);
    const row = db.callByExternalId(PROVIDER, externalId);
    return { ok: true, state: row?.state ?? "placing" };
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "place") return place;
      if (prop === "check") return check;
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

// ---------- the routes ----------

/** Form-encoded body as an object. */
export function formOf(raw) {
  return Object.fromEntries(new URLSearchParams(String(raw ?? "")));
}

/**
 * Twilio's status callback for one GPT-Live call. A call that never connected (busy, no answer,
 * failed) settles here; one that connected settles when its stream ends.
 */
export async function statusRequest({ token, rawBody, headers, settle, runtime, log = () => {} }) {
  const row = db.callByWebhookToken(token);
  if (!row || row.provider !== PROVIDER) return { status: 404, body: "" };
  const params = formOf(rawBody);
  if (!verifyTwilio({ url: `${config.publicUrl}${STATUS_PATH}${token}`, params, headers })) return { status: 403, body: "" };
  const state = stateFromTwilio(params.CallStatus);
  log({ gptlive_status: row.id, status: params.CallStatus });
  if (["placing", "ringing", "in_progress"].includes(state)) {
    if (["placing", "ringing", "in_progress"].includes(row.state) && row.state !== state) db.updateCall(row.conversation_id, row.id, { state });
    return { status: 204, body: "" };
  }
  if (state === "completed" && streams.has(row.id)) return { status: 204, body: "" };
  await settleGptLive({
    row, settle, runtime, log,
    live: {
      state, outcome: "", summary: "", transcript: "", turns: [],
      durationS: Number(params.CallDuration) || 0, costCents: 0,
      termination: state === "completed" ? "hung up" : String(params.CallStatus ?? ""),
      recording: null, recordingWhy: "the call never connected, so there was nothing to record",
    },
  });
  return { status: 204, body: "" };
}

/**
 * The number's voice webhook, if it is ever pointed here: the operator, calling from their own number,
 * gets GPT-Live; everyone else is redirected to ElevenLabs' own Twilio address, unchanged. With the flag
 * off, or no fallback address configured, everyone is redirected (or, with no fallback, refused).
 */
export function inboundTwiml({ rawBody, headers, log = () => {} }) {
  const params = formOf(rawBody);
  if (!verifyTwilio({ url: `${config.publicUrl}${INBOUND_PATH}`, params, headers })) return { status: 403, body: "" };
  const away = config.gptliveInboundFallbackUrl
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">${xml(config.gptliveInboundFallbackUrl)}</Redirect></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
  const address = normalizeNumber(params.From) || "";
  const who = address ? whoseCallIsThis(address) : { allow: false };
  if (!who.allow || who.callingBack || !gptliveFor(who.conversationId) || missingForGptlive().length) {
    return { status: 200, body: away, type: "text/xml" };
  }
  const row = db.createCall(who.conversationId, {
    provider: PROVIDER, toNumber: address, isOwner: true,
    goal: `${accounts.ownerOf(who.conversationId).name} called Reason`, facts: [],
    direction: "in", externalId: `${EXT}${params.CallSid ?? randomUUID()}`, state: "in_progress", announcement: "",
  });
  accounts.countUse(who.conversationId, "call");
  recordingNoteFor({ conversationId: who.conversationId, row, log });
  log({ gptlive_inbound: who.conversationId, call: row.id });
  return { status: 200, body: streamTwiml(row), type: "text/xml" };
}

/** Calls whose stream is up, by call id. */
const streams = new Map();

/**
 * Twilio's media stream for one call, upgraded. The token in the path is the call row's own; anything
 * else is closed at once.
 */
export function acceptStream({ token, socket, settle, runtime, log = () => {}, openLive = openLiveSocket }) {
  const row = db.callByWebhookToken(token);
  if (!row || row.provider !== PROVIDER || !["placing", "ringing", "in_progress"].includes(row.state) || streams.has(row.id)) {
    log({ gptlive_stream_refused: row?.id ?? null });
    socket.close(1008);
    return null;
  }
  db.updateCall(row.conversation_id, row.id, { state: "in_progress" });
  const call = new GptLiveCall({
    call: db.getCall(row.conversation_id, row.id) ?? row, twilio: socket, openLive, log,
    brain: (messages) => reasonTurn({ call: row, messages, log, extras: runtime?.turnExtras ?? {} }),
    finish: async (live) => {
      try { await settleGptLive({ row, live, settle, runtime, log }); } finally { streams.delete(row.id); }
    },
  });
  streams.set(row.id, call);
  return call;
}
