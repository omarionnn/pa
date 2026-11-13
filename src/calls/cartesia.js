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
import { CallTape, hasSpeech, voiceInstructionsFor } from "./gptlive.js";
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
    reason_call: clip(voiceInstructionsFor(call, { line: false, turnGate: false }), VARIABLE_MAX),
    greeting: clip(greeting || "Hey, it's Reason.", 400),
    their_name: clip(name, 80),
  };
}

/** One of their own calls on the Cartesia agent: Twilio's stream on one side, the agent on the other. */
export class CartesiaAgentCall {
  constructor({ call, twilio, openAgent = openAgentSocket, brain, finish = async () => {}, fallBack = null, deleteCall = deleteAgentCall, log = () => {}, now = () => Date.now(), timers = globalThis, readyMs = READY_MS }) {
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
    this.bed = ambience.bedFor(call);
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
    this.agentSpeechAt = -Infinity;
    this.overSoundAt = null;
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
      this.log({ cartesia_stream_start: this.call.id, ...(this.bed ? { ambience: this.bed.kind } : {}) });
      this.roomTick();
    } else if (m.event === "media" && m.media?.payload) {
      if (m.media.track && m.media.track !== "inbound") return;
      const buf = Buffer.from(m.media.payload, "base64");
      this.tape.them(buf);
      // Talked over: his first sound while the agent's words are still playing.
      if (this.overSoundAt == null && this.now() - this.agentSpeechAt < 300 && hasSpeech(m.media.payload)) this.overSoundAt = this.now();
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
        const over = { sound_to_clear_ms: this.overSoundAt == null ? null : t - this.overSoundAt, clear_to_twilio_ms: this.now() - t };
        this.m.overs.push(over);
        this.log({ cartesia_talked_over: this.call.id, ...over });
        this.overSoundAt = null;
        this.agentSpeechAt = -Infinity;
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
      this.agentSpeechAt = t;
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
    const askedAt = this.now();
    this.replyKind = "ask_reason";
    let reply;
    try {
      reply = await this.brain(this.messages(e.parameters?.request ?? e.parameters?.question ?? ""));
    } catch (err) {
      reply = { text: "", error: (err?.message ?? String(err)).split("\n")[0] };
    }
    const answeredAt = this.now();
    const ask = { asked_to_answered_ms: answeredAt - askedAt, error: !!reply?.error, skip: !!reply?.skip };
    this.m.asks.push(ask);
    this.log({ cartesia_ask_reason: this.call.id, ...ask });
    this.askAnsweredAt = answeredAt;
    if (reply?.error && !reply?.text) return answer("Reason could not answer that just now. Say so briefly and offer to try again.", true);
    if (reply?.skip || !String(reply?.text ?? "").trim()) return answer("Reason has nothing to add. Reply yourself in a few words.");
    if (reply?.endCall) this.endWhy = "goodbye";
    return answer(reply.text);
  }

  // --- falling back, and the end ---

  /** Not ready in time, or broken before it was: the same call carries on with GPT-Live. */
  fallBack(why) {
    if (this.done || this.handedOff) return null;
    this.handedOff = true;
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
      talked_over: this.m.overs.length, laughs_written: this.m.laughs,
    });
    // Their copy goes whatever the settle does; both are waited for, neither stops the other.
    const deleting = this.agentCallId ? this.deleteAndCheck().catch(() => null) : Promise.resolve(null);
    try { await this.finishCall(live); } catch (e) { this.log({ cartesia_settle_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
    await deleting;
  }
}
