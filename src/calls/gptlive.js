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
import { thirdPartyIdentity, callIdentityFor, NO_NAME } from "./voice-prompt.js";
import { makerLine } from "../maker.js";
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
 * Who is on the line, for the voice's instructions, from the account whose conversation this call is.
 */
export function whoFor(call) {
  let me = null;
  try { me = accounts.ownerOf(call.conversation_id); } catch { /* unknown conversation */ }
  const raw = me?.name || "";
  const named = !!raw && raw !== NO_NAME;
  // Only this call's own account, by the call row's conversation — never anyone else's. No profile:
  // the voice gets the name and nothing more (the backend has the rest, per turn, for this person).
  return { name: named ? raw : "them", named, owner: !!call.is_owner, identity: callIdentityFor(call.conversation_id) };
}

/** Call 56: "do you know where I am?" was answered "you're Omari" (2026-10-31). Where/what goes to Reason. */
const NOT_WHO = "Where they are, or any other question, goes to Reason; if you're not sure whether they said who or where, ask.";

/**
 * Call 56's tone fixes (2026-10-31), the only lines added to call 53's: "Checking" before nearly every
 * reply, "how are you?" not returned, a "yeah" to Reason's offer answered "Okay." and never passed on,
 * flat goodbyes.
 */
export const CALL56_LINES = [
  "Only use a holding phrase when you've handed Reason something that takes a moment, vary it, and never put one before a quick answer or a simple yes.",
  "Small talk is yours: if they ask how you are, answer warmly and ask them back.",
  "If they say yes or no to something Reason offered, pass that answer to Reason; never just say okay.",
  "When you both say goodbye, sign off warmly and briefly.",
];

/**
 * The live prompt: call 53's (#290), the one Omari called "a big upgrade, really felt like a
 * conversation", word for word, plus only the minimal identity lines — it is Reason, who they are, who
 * made it — behind REASON_CALL_IDENTITY, and call 56's four short lines (`CALL56_LINES`). #293's longer prompt (tone section, profile block, who-rang-
 * whom) went out with calls 54–55, which he called confused and worse; it is not here (2026-10-31).
 */
export function liveInstructions({ name = "them", named = name !== "them", owner = false, identity = false } = {}) {
  const them = named ? name : "them";
  const theirs = named ? `${name}'s` : "their";
  const who = !identity
    ? []
    : owner
      ? [named
        ? `Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant, and they're ${name}, the person you work for. ${NOT_WHO}`
        : `Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant; you don't have their name saved yet. ${NOT_WHO}`]
      : [thirdPartyIdentity({ ownerName: them })];
  return [
    `You are the voice of Reason, ${theirs} personal assistant, on a phone call with ${them}.`,
    ...who,
    makerLine(),
    "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.",
    `You are only the voice. Reason, the backend, does all of the thinking and every action: it has ${theirs} messages, calendar, memory, tasks and tools.`,
    "Delegate to the backend for every question, request, instruction or opinion — anything beyond a greeting, a brief listening sound, or asking them to repeat something.",
    "Never answer from your own knowledge, and never invent a fact, time, name, number or price.",
    "While the backend works, a very short acknowledgement is fine. Do not fill the silence with guesses.",
    ...CALL56_LINES,
    "Never say anything is done, booked, sent, texted, ordered, paid, scheduled, cancelled or confirmed unless the backend's result says so. If the result says it is not done, only started, or needs their approval, say exactly that.",
    "When a backend result arrives, say it naturally and briefly, keeping every fact, number and name exactly as given. Do not add offers or questions the result did not include.",
    "Never read out links, codes, IDs or anything in square brackets, and never say the words NO_REPLY.",
    "Stop speaking when they talk over you, and listen.",
  ].join("\n");
}

/** The session.start body. μ-law at 8 kHz both ways, so Twilio's frames go straight through. */
export function sessionConfig({ name, named, owner = false, identity = false, greeting = "" } = {}) {
  const session = {
    model: config.gptliveModel,
    instructions: liveInstructions({ name, named, owner, identity }),
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

// ---------- reading the end of a call ----------

// Call 56 (2026-10-31): "Okay, bye" / "Bye." / ", bye" and the line stayed open until Omari hung up.
// The voice says its goodbyes itself, without delegating, so Reason's end_call never came. Now a
// goodbye-sounding line of the voice's is the cue to ASK the small model whether the call is over —
// this list only picks which lines are worth asking about; it never decides anything itself.
const FAREWELL_HINT = /\b(?:bye|goodbye|take care|talk (?:to you )?(?:soon|later)|see (?:you|ya)|catch you|good ?night|have a (?:good|great|nice|lovely))\b/i;
/** Does this line of the voice's sound like a goodbye, so the call's end is worth reading? */
export const soundsLikeFarewell = (text) => FAREWELL_HINT.test(String(text ?? ""));
/** The voice's goodbye has settled for this long before the end is read. */
export const BYE_SETTLE_MS = 900;

const ENDING_SYSTEM = "You read the last lines of a phone call between a person (Them) and their AI assistant (Reason)."
  + " Answer only from what was said. Reply with the JSON asked for, nothing else.";
const GOODBYE_SCHEMA = { type: "object", properties: { ended: { type: "boolean" } }, required: ["ended"], additionalProperties: false };
const CUTOFF_SCHEMA = { type: "object", properties: { cut_off: { type: "boolean" } }, required: ["cut_off"], additionalProperties: false };

export function goodbyePrompt(transcript) {
  return `${transcript}\n\nHave Them and Reason both said goodbye TO EACH OTHER, so the call is over and Reason should hang up now?`
    + " ended=false if Them is still asking or saying anything, if the goodbye was to someone else in the room,"
    + " or if only one side said goodbye. ended=true only for a mutual goodbye.";
}

export function cutOffPrompt(transcript, late) {
  return `${transcript}\n\nAs the call ended, right after Reason's goodbye, Them said: "${late}"`
    + "\nWas Them starting to say something new (a question, a request, more to tell) that got cut off? cut_off=false if it was"
    + " only them finishing the goodbye (bye, thanks, you too, okay) or just noise.";
}

/**
 * The small model's read of the end of a call: `{ kind: "goodbye" }` → is it a mutual goodbye;
 * `{ kind: "cutoff", late }` → were their last words cut off. true/false, or null when it could not be
 * asked (no subscription CLI, a timeout) — and null never hangs up or texts anyone. Subscription only.
 */
export async function judgeEnding({ kind, transcript, late = "" }, { ask = null } = {}) {
  try {
    const goodbye = kind === "goodbye";
    const q = {
      system: ENDING_SYSTEM, feature: goodbye ? "gptlive_goodbye" : "gptlive_cutoff",
      prompt: goodbye ? goodbyePrompt(transcript) : cutOffPrompt(transcript, late),
      schema: goodbye ? GOODBYE_SCHEMA : CUTOFF_SCHEMA,
    };
    const { value } = ask ? { value: await ask(q) } : await (await import("../onethought.js")).askJson(q);
    const v = goodbye ? value?.ended : value?.cut_off;
    return typeof v === "boolean" ? v : null;
  } catch { return null; }
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
  /**
   * The mix as a mono 8 kHz WAV: 16-bit PCM, or G.711 μ-law (half the size) once PCM would pass the
   * 25 MB a recording may be (~26 minutes). Mixed straight into the output, one pass per side.
   */
  wav() {
    const n = Math.max(this.callerBytes, this.reasonEnd);
    const pcm = new Int16Array(n);
    let i = 0;
    for (const b of this.caller) for (const u of b) pcm[i++] = ulawToPcm(u);
    for (const s of this.segs) {
      for (let k = 0; k < s.buf.length; k++) {
        const v = pcm[s.at + k] + ulawToPcm(s.buf[k]);
        pcm[s.at + k] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }
    const ulaw = n * 2 + 44 > WAV_PCM_LIMIT;
    const body = ulaw ? Buffer.from(Uint8Array.from(pcm, pcmToUlaw)) : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + body.length, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(ulaw ? 7 : 1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(8000, 24); h.writeUInt32LE(ulaw ? 8000 : 16000, 28); h.writeUInt16LE(ulaw ? 1 : 2, 32); h.writeUInt16LE(ulaw ? 8 : 16, 34);
    h.write("data", 36); h.writeUInt32LE(body.length, 40);
    return Buffer.concat([h, body]);
  }
}

/** Under the 25 MB storeRecording takes, with room. */
const WAV_PCM_LIMIT = 24 * 1024 * 1024;

/** A 16-bit sample as one G.711 μ-law byte. */
export function pcmToUlaw(sample) {
  const BIAS = 0x84;
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > 32635) s = 32635;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

// ---------- the OpenAI side ----------

/** A GPT-Live WebSocket, as `{ send(obj), close(), on(name, fn) }`. Node's own WebSocket, key in a header. */
export function openLiveSocket({ url = LIVE_URL, key = config.openaiKey } = {}) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
  const handlers = { open: [], event: [], close: [] };
  // A throw inside a WebSocket listener is an uncaught exception, which would take the whole server
  // down with one call; every handler is run inside a catch.
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

// ---------- warming the voice up while it rings ----------

/** A μ-law sample this loud or louder is speech, not the silence the session streams between words. */
const SPEECH_PEAK = 1500;

/** Does this chunk of μ-law audio carry speech? */
export function hasSpeech(b64) {
  for (const u of Buffer.from(String(b64 ?? ""), "base64")) {
    const s = ulawToPcm(u);
    if (s >= SPEECH_PEAK || s <= -SPEECH_PEAK) return true;
  }
  return false;
}

/** 100 ms of μ-law silence: what the warm session is fed so its clock runs before anyone is on the line. */
const SILENCE_100MS = Buffer.alloc(800, 0xff).toString("base64");
/** The greeting is over once the voice has been quiet this long after speaking; the session is then paused. */
export const WARM_QUIET_MS = 700;
/** Fed this long and still no greeting: say it again once (the docs: the greeting is never guaranteed). */
export const WARM_RETRY_MS = 4000;
/** And this long: stop feeding it, so an unanswered phone costs seconds, not minutes. */
export const WARM_FEED_MAX_MS = 9000;
/** Nobody picked up within this: the session is closed. Twilio gives up ringing at 30 s. */
export const WARM_MAX_MS = 60_000;

/** Warm sessions waiting for their call to be answered, by call id. */
const warm = new Map();

/**
 * A GPT-Live session opened while the phone is still ringing, so Reason speaks the moment it is picked up.
 *
 * Call 53 (2026-10-31): Omari answered, said "hello, hello", and heard nothing for 3.1 s — the session
 * was only opened once Twilio's stream started, then took ~1 s to start and ~0.8 s more to greet. Now
 * the session starts when the call is placed, with the greeting asked for; a GPT-Live session's clock
 * only runs on input audio (measured: no input, no greeting), so it is fed silence until the greeting
 * has been said, then paused. Its audio is kept, and played into the line the moment the stream starts.
 *
 * Only for a call that opens with a greeting — an owner call Reason placed. A call that opens silent (a
 * third-party call, #232) never reaches GPT-Live and never gets one of these.
 */
export class WarmSession {
  constructor({ row, openLive = openLiveSocket, log = () => {}, now = () => Date.now(), timers = globalThis }) {
    this.row = row;
    this.log = log;
    this.now = now;
    this.timers = timers;
    this.who = whoFor(row);
    this.greeting = String(row.announcement ?? "");
    this.openedAt = now();
    this.audio = [];
    this.text = "";
    this.spoke = false;
    this.lastSpeechAt = 0;
    this.feeding = false;
    this.fedMs = 0;
    this.retried = false;
    this.started = false;
    this.closed = false;
    this.call = null;
    this.live = openLive();
    this.live.on("open", () => {
      this.live.send({ type: "session.start", event_id: `start_${row.id}`, session: sessionConfig({ ...this.who, greeting: this.greeting }) });
    });
    this.live.on("event", (e) => (this.call ? this.call.fromLive(e) : this.take(e)));
    this.live.on("close", (code) => (this.call ? this.call.liveClosed(code) : this.drop(`closed (${code})`)));
    this.expiry = timers.setTimeout(() => this.drop("never answered"), WARM_MAX_MS);
  }

  take(e) {
    if (e.type === "session.started") {
      this.started = true;
      this.sessionId = e.session?.id ?? "";
      this.startedAt = this.now();
      this.live.send({ type: "session.commentary.append", event_id: `greet_${this.row.id}`, delegation_id: null, content: greetingInstruction(this.greeting) });
      this.feeding = true;
      this.feed();
    } else if (e.type === "session.output_audio.delta") {
      const speech = hasSpeech(e.delta);
      if (speech) { this.spoke = true; this.lastSpeechAt = this.now(); }
      if (this.spoke) this.audio.push(e.delta);
    } else if (e.type === "session.output_transcript.delta") {
      this.text += String(e.delta ?? "");
    } else if (e.type === "session.usage.updated" && Number.isFinite(e.usage?.seconds)) {
      this.seconds = e.usage.seconds;
    } else if (e.type === "error") {
      this.log({ gptlive_error: this.row.id, warm: true, code: e.error?.code ?? "", message: String(e.error?.message ?? "").slice(0, 200) });
    }
  }

  /** 100 ms of silence in, every 100 ms, until the greeting is said (or it is plainly not coming). */
  feed() {
    if (!this.feeding || this.closed || this.call) return;
    const t = this.now();
    if (this.spoke && t - this.lastSpeechAt >= WARM_QUIET_MS) return this.pause("greeted");
    if (this.fedMs >= WARM_FEED_MAX_MS) return this.pause("no greeting");
    if (!this.spoke && !this.retried && this.fedMs >= WARM_RETRY_MS) {
      this.retried = true;
      this.live.send({ type: "session.commentary.append", event_id: `greet2_${this.row.id}`, delegation_id: null, content: greetingInstruction(this.greeting) });
    }
    this.live.send({ type: "session.input_audio.append", audio: SILENCE_100MS });
    this.fedMs += 100;
    this.feedTimer = this.timers.setTimeout(() => this.feed(), 100);
  }

  pause(why) {
    this.feeding = false;
    this.log({ gptlive_warm: this.row.id, why, ready_ms: this.now() - this.openedAt, spoke: this.spoke, said: this.text.trim().slice(0, 120) });
  }

  /** The call picked up: everything from here is the call's. */
  handOver(call) {
    this.timers.clearTimeout(this.expiry);
    if (this.feedTimer) this.timers.clearTimeout(this.feedTimer);
    this.feeding = false;
    this.call = call;
  }

  /** Nobody is coming: close it. */
  drop(why) {
    if (this.closed || this.call) return;
    this.closed = true;
    this.feeding = false;
    this.timers.clearTimeout(this.expiry);
    if (this.feedTimer) this.timers.clearTimeout(this.feedTimer);
    if (warm.get(this.row.id) === this) warm.delete(this.row.id);
    try { if (this.started) this.live.send({ type: "session.close", event_id: `close_${this.row.id}` }); } catch { /* going anyway */ }
    this.timers.setTimeout(() => this.live.close(), 1000);
    this.log({ gptlive_warm_dropped: this.row.id, why });
  }
}

/** Start the voice for a call about to be placed, if it opens with a greeting. Never throws. */
export function prewarm(row, { openLive = openLiveSocket, log = () => {}, now, timers } = {}) {
  try {
    if (!row?.id || !String(row.announcement ?? "").trim() || warm.has(row.id)) return null;
    const w = new WarmSession({ row, openLive, log, ...(now ? { now } : {}), ...(timers ? { timers } : {}) });
    warm.set(row.id, w);
    return w;
  } catch (e) {
    log({ gptlive_warm_failed: row?.id ?? null, why: (e?.message ?? String(e)).split("\n")[0] });
    return null;
  }
}

/** The warm session for a call, taken (it is the call's from now on), or null. */
export function takeWarm(callId) {
  const w = warm.get(callId);
  warm.delete(callId);
  return w && !w.closed ? w : null;
}

/** The call is over before it was answered (busy, no answer, failed). */
export function dropWarm(callId, why) {
  warm.get(callId)?.drop(why);
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
  constructor({ call, twilio, openLive = openLiveSocket, warm = null, brain = null, judge = null, log = () => {}, now = () => Date.now(), finish = async () => {}, timers = globalThis }) {
    this.call = call;
    this.twilio = twilio;
    this.openLive = openLive;
    this.warm = warm;
    this.brain = brain ?? ((messages) => reasonTurn({ call, messages, log }));
    this.judge = judge ?? ((q) => judgeEnding(q));
    this.farewellAt = 0;
    this.goodbyeAt = 0;
    this.byeTimer = null;
    this.byeAsking = false;
    this.endHeld = false;
    this.callerSpeechAt = 0;
    this.callerSpeechFrom = 0;
    this.log = log;
    this.now = now;
    this.finishCall = finish;
    this.timers = timers;
    this.who = whoFor(call);
    this.name = this.who.name;
    this.greeting = call.direction === "in"
      ? openingLineFor({ person: accounts.ownerOf(call.conversation_id), conversationId: call.conversation_id })
      : String(call.announcement ?? "");
    this.turns = this.greeting ? [{ who: "reason", text: this.greeting, at: now(), seeded: true }] : [];
    this.tape = new CallTape();
    this.pending = new Map();
    this.delegations = 0;
    this.latest = null;
    this.lastResultClaimed = false;
    this.lastResultAt = 0;
    this.lastCallerAt = 0;
    this.lastOutAt = 0;
    this.lastVoiceAt = 0;
    this.voiceEndsAt = 0;
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
    twilio.onClose(() => { this.end("caller hung up").catch(() => {}); });
  }

  // --- Twilio side ---

  fromTwilio(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.event === "start") {
      this.streamSid = m.start?.streamSid ?? m.streamSid ?? null;
      this.callSid = m.start?.callSid ?? "";
      this.streamStartAt = this.now();
      this.log({ gptlive_stream_start: this.call.id, sid: this.callSid });
      this.connect();
    } else if (m.event === "media" && m.media?.payload) {
      if (m.media.track && m.media.track !== "inbound") return;
      const buf = Buffer.from(m.media.payload, "base64");
      this.tape.them(buf);
      if (hasSpeech(m.media.payload)) {
        const t = this.now();
        if (t - this.callerSpeechAt > 200) this.callerSpeechFrom = t;
        this.callerSpeechAt = t;
      }
      if (this.started) this.live.send({ type: "session.input_audio.append", audio: m.media.payload });
    } else if (m.event === "stop") {
      this.end("caller hung up").catch(() => {});
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
    // The same ceiling an ElevenLabs call has (the agent's own, `callPlatformCapSeconds`), so a call
    // never outlives the lost-call sweep's window and is written off while it is still going.
    this.capTimer = this.timers.setTimeout(() => { this.endWhy = "duration_cap"; this.end("duration_cap").catch(() => {}); }, config.callPlatformCapSeconds * 1000);
    const w = this.warm;
    if (w && !w.closed && !w.call) return this.adopt(w);
    this.live = this.openLive();
    this.live.on("open", () => {
      this.live.send({ type: "session.start", event_id: `start_${this.call.id}`, session: sessionConfig({ ...this.who, greeting: this.greeting }) });
    });
    this.live.on("event", (e) => this.fromLive(e));
    this.live.on("close", (code) => this.liveClosed(code));
  }

  /**
   * Take over the session warmed up while it rang (`WarmSession`): the greeting it has already said goes
   * straight down the line, and from here on the session is this call's. A session that has not started
   * yet, or has not finished greeting, carries on live — the rest of the greeting follows as it comes.
   */
  adopt(w) {
    w.handOver(this);
    this.live = w.live;
    this.adopted = true;
    if (w.started) this.onStarted(w.sessionId, { greet: false });
    if (Number.isFinite(w.seconds)) this.seconds = w.seconds;
    for (const delta of w.audio) this.audioOut(delta);
    if (w.text) this.textOut(w.text);
    this.log({ gptlive_warm_used: this.call.id, ready: !w.feeding && w.spoke, audio_ms: w.audio.reduce((n, d) => n + Buffer.from(d, "base64").length, 0) / 8, waited_ms: this.now() - w.openedAt });
  }

  liveClosed(code) {
    this.log({ gptlive_session_socket_closed: this.call.id, code });
    if (!this.done) this.end(this.endWhy || `voice session closed (${code})`).catch(() => {});
  }

  onStarted(sessionId, { greet = true } = {}) {
    this.started = true;
    this.sessionId = sessionId ?? "";
    this.log({ gptlive_session: this.call.id, session: this.sessionId, warm: !!this.adopted });
    try { db.updateCall(this.call.conversation_id, this.call.id, { tts_model: `${config.gptliveModel}/${config.gptliveVoice}` }); } catch { /* a label never breaks a call */ }
    if (greet && this.greeting) this.live.send({ type: "session.commentary.append", event_id: `greet_${this.call.id}`, delegation_id: null, content: greetingInstruction(this.greeting) });
  }

  fromLive(e) {
    switch (e.type) {
      case "session.started":
        // An adopted session started before the call picked up; this is only ever a fresh one's.
        return this.onStarted(e.session?.id, { greet: !this.adopted });
      case "session.output_audio.delta":
        return this.audioOut(e.delta);
      case "session.output_transcript.delta":
        return this.textOut(String(e.delta ?? ""));
      case "session.input_transcript.delta":
        return this.textIn(String(e.delta ?? ""));
      case "session.delegation.created":
        return void this.delegate(e.delegation?.id).catch((err) => this.log({ gptlive_delegation_failed: this.call.id, why: (err?.message ?? String(err)).split("\n")[0] }));
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
    if (this.firstVoiceMs == null && this.streamStartAt != null && hasSpeech(b64)) {
      // How long the person who picked up waited for Reason's first word (call 53: 3.1 s).
      this.firstVoiceMs = t - this.streamStartAt;
      this.log({ gptlive_first_voice: this.call.id, ms: this.firstVoiceMs, warm: !!this.adopted });
    }
    this.lastOutAt = t;
    this.tape.reason(buf);
    this.playheadAt = Math.max(this.playheadAt, t) + buf.length / 8;
    // The session streams silence between words, so "quiet" for a hang-up is no SPEECH arriving.
    if (hasSpeech(b64)) { this.lastVoiceAt = t; this.voiceEndsAt = this.playheadAt; }
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
    else this.turns.push({ who: "reason", text: delta.trimStart(), at: t, from: t });
    const line = this.turns.at(-1);
    if (soundsLikeFarewell(line.text)) {
      this.farewellAt = line.from ?? t;
      if (this.byeTimer) this.timers.clearTimeout(this.byeTimer);
      if (!this.ending) this.byeTimer = this.timers.setTimeout(() => void this.readGoodbye(), BYE_SETTLE_MS);
    }
    // Words of the claim already being held back are not a second claim; anything a second on is.
    if (this.mute && t - this.mute.since < 1000) return;
    const said = withoutSilenceMarker(this.utter);
    // A claim is only ever the echo of Reason's own: nothing pending, and Reason's latest answer said
    // so within the last minute. A request since then starts the clock again (see `delegate`).
    const confirmed = this.pending.size === 0 && this.lastResultClaimed && t - this.lastResultAt < 60_000;
    const unconfirmed = claimsDone(this.utter) && !confirmed;
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
    if (delta.trim()) this.lastCallerAt = t;
    const last = this.turns.at(-1);
    if (last && last.who === "them" && t - last.at < 4000) { last.text += delta; last.at = t; }
    else this.turns.push({ who: "them", text: delta.trimStart(), at: t, from: t });
    // Words while a goodbye hang-up waits: hold it, and read the end again with them in it.
    if (this.ending && this.endWhy === "goodbye" && !this.done && delta.trim()) {
      this.endHeld = true;
      void this.readGoodbye();
    }
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
    this.lastResultClaimed = false;
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
      this.lastResultAt = turn.resultAt;
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

  /** The last lines of the call, as the end readers are shown them. */
  tail(n = 8) {
    return this.turns.slice(-n).map(x => ({ who: x.who === "them" ? "Them" : "Reason", text: x.text.replace(/\s+/g, " ").trim() }))
      .filter(x => x.text).map(x => `${x.who}: ${x.text}`).join("\n");
  }

  /**
   * The voice just said something goodbye-ish: ask whether the call is over (a mutual goodbye) and, if
   * so, hang up once it has finished speaking. Run again while that hang-up waits and they speak, so
   * "bye — oh wait, one more thing" calls it off. A "bye" to someone in the room is not mutual, and an
   * unanswerable read (null) never hangs up: they can always hang up themselves, as before.
   */
  async readGoodbye() {
    this.byeTimer = null;
    if (this.done || !this.farewellAt) return;
    if (this.ending ? this.endWhy !== "goodbye" : this.pending.size > 0) return;
    if (this.byeAsking) { this.byeAgain = true; return; }
    this.byeAsking = true;
    const heardTo = this.lastCallerAt;
    const askedAt = this.now();
    const ended = await this.judge({ kind: "goodbye", transcript: this.tail() }).catch(() => null);
    this.byeAsking = false;
    this.log({ gptlive_goodbye_read: this.call.id, ended, waiting: this.ending, ms: this.now() - askedAt });
    if (this.done) return;
    if (this.byeAgain || this.lastCallerAt !== heardTo) { this.byeAgain = false; return void this.readGoodbye(); }
    if (this.ending) {
      if (ended === true) this.endHeld = false;
      else { this.ending = false; this.endWhy = ""; this.endHeld = false; this.goodbyeAt = 0; this.log({ gptlive_goodbye_called_off: this.call.id }); }
      return;
    }
    if (ended === true && this.pending.size === 0) { this.goodbyeAt = this.farewellAt; this.hangUpAfterSpeech("goodbye"); }
  }

  /**
   * Hang up once the goodbye has played out, by ending the stream (which ends the call): `end_call`
   * when Reason asked, `goodbye` when the voice and the caller said it to each other. A goodbye
   * hang-up also waits while they are talking, or while their words are being read.
   */
  hangUpAfterSpeech(why = "end_call") {
    if (this.ending) return;
    this.ending = true;
    this.endWhy = why;
    const started = this.now();
    const tick = () => {
      if (this.done || !this.ending) return;
      const t = this.now();
      const quiet = why === "goodbye"
        ? t - this.lastVoiceAt > 1000 && t >= this.voiceEndsAt + 500
        : t - this.lastOutAt > 1500 && this.queuedMs() === 0;
      const held = why === "goodbye" && (this.endHeld || t - this.lastCallerAt < 1000);
      const minMs = why === "goodbye" ? 0 : 2500;
      if (!held && ((quiet && t - started >= minMs) || t - started > 15000)) return void this.end(why).catch(() => {});
      this.timers.setTimeout(tick, 250);
    };
    this.timers.setTimeout(tick, 250);
  }

  /**
   * Were they saying something as the call ended, right after Reason's goodbye? Their words after it
   * are read by the small model ("bye" / "you too" is only the goodbye finishing); with no words yet,
   * speech on their side in the last moments of a hang-up Reason made counts. `{ words }`, or null.
   */
  async cutOff() {
    const at = this.endedAt ?? this.now();
    if (!this.farewellAt || at - this.farewellAt > 20_000) return null;
    const late = this.turns.filter(x => x.who === "them" && (x.from ?? x.at) >= this.farewellAt)
      .map(x => x.text.replace(/\s+/g, " ").trim()).join(" ").replace(/^[\s,.;:—-]+/, "").trim();
    let cut;
    if (late) cut = (await this.judge({ kind: "cutoff", transcript: this.tail(), late }).catch(() => null)) === true;
    else {
      cut = ["goodbye", "end_call"].includes(this.endWhy) && this.callerSpeechFrom >= this.farewellAt
        && at - this.callerSpeechAt < 1500 && this.callerSpeechAt - this.callerSpeechFrom >= 300;
    }
    this.log({ gptlive_cut_off: this.call.id, cut, words: late.length });
    return cut ? { words: late.slice(0, 200) } : null;
  }

  // --- the end ---

  async end(why) {
    if (this.done) return;
    this.done = true;
    this.endedAt = this.now();
    this.endWhy = this.endWhy || why;
    if (this.capTimer) this.timers.clearTimeout(this.capTimer);
    if (this.byeTimer) this.timers.clearTimeout(this.byeTimer);
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
    // After the line is down, so reading their last words never keeps anyone on the phone.
    const cutOff = await this.cutOff();
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
      termination: this.endWhy === "caller hung up" ? "hung up" : this.endWhy === "goodbye" ? "end_call (mutual goodbye)" : this.endWhy,
      cutOff,
      costRaw: JSON.stringify({ voice_seconds: seconds, cents_per_minute: CENTS_PER_MINUTE, session: this.sessionId ?? "", guard_trips: this.guardTrips, first_voice_ms: this.firstVoiceMs ?? null, warm: !!this.adopted }),
      recording, recordingWhy,
    };
    this.log({ gptlive_call_ended: this.call.id, why: this.endWhy, seconds, delegations: this.delegations, guard_trips: this.guardTrips, first_voice_ms: this.firstVoiceMs ?? null, warm: !!this.adopted, closed: this.closedReason ?? "" });
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
  // The same marks as the ElevenLabs path: begun with the thread, finished once the owner was told.
  db.updateCall(settled.conversation_id, settled.id, { settle_started_at: clock.now() });
  const wrote = writeCallIntoThread({ row: settled, live, log });
  const noted = noteOnTask({ row: settled, live, log });
  fromcall.onCallEnded(settled, { log });
  const told = await tellTheOwner({ row: settled, live, runtime, log });
  db.updateCall(settled.conversation_id, settled.id, { settled_at: clock.now() });
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
    // No warm-up while it rings (2026-10-31): calls 54–55 with it were "confused and incoherent".
    // The session opens when Twilio's stream starts, as on call 53. `prewarm` stays for a proven rework.
    const out = await twilioPost("/Calls.json", {
      To: args.to, From: config.twilioFrom, Twiml: streamTwiml(row),
      StatusCallback: `${config.publicUrl}${STATUS_PATH}${row.webhook_token}`,
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"], StatusCallbackMethod: "POST",
      Timeout: 30,
    }, fetchImpl ? { fetchImpl } : {});
    if (!out.ok || !out.json?.sid) dropWarm(row.id, "Twilio refused the call");
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
  dropWarm(row.id, `call ${params.CallStatus ?? "ended"} before it was answered`);
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
    call: db.getCall(row.conversation_id, row.id) ?? row, twilio: socket, openLive, log, warm: takeWarm(row.id),
    brain: (messages) => reasonTurn({ call: row, messages, log, extras: runtime?.turnExtras ?? {} }),
    finish: async (live) => {
      try { await settleGptLive({ row, live, settle, runtime, log }); } finally { streams.delete(row.id); }
    },
  });
  streams.set(row.id, call);
  return call;
}
