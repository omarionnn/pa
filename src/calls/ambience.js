// A very quiet room under Reason's voice on a GPT-Live call (Omari, 2026-11-01: "calls feel alive"):
// a café on a person's own call, an office on an errand to a business or anyone else. The beds are
// synthesized (scripts/make-ambience.mjs) — 20 s of 8 kHz μ-law each, looped without a seam.
//
// REASON_CALL_AMBIENCE: "owner" — the operator's calls only; "on" — everyone's; unset or "off" — none.
// REASON_CALL_AMBIENCE_GAIN: the bed's level, 0–0.2 (unset = AMBIENCE_GAIN); no code change to tune it.
//
// The bed is mixed into every frame of Reason's audio as it goes to Twilio, and between Reason's words
// the call is kept topped up with bed-only frames a few tens of milliseconds ahead of what Twilio is
// playing, so the room never drops out and Reason's next word waits at most LEAD_MS behind it. It is
// tracked on its own clock (`at`), never the call's playhead, so nothing that asks "is Reason still
// talking?" ever hears the room. Not on a voicemail, and not in the call's recording.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import * as accounts from "../accounts.js";
import { ulawToPcm, pcmToUlaw } from "./gptlive.js";

/** Bed level against the files' own (RMS 3000): ≈ −56 dBFS, about 26 dB under Reason's voice (≈ −30).
 *  Was 0.12 (≈ −40) until Omari, 2026-11-02: "reduce the background noise a little" → 0.075 (≈ −44);
 *  11-08 00:30 "too loud" → 0.0375 (≈ −50) by .env; call 77 (11-08): "still loud, reduce it by 50%" → half again, −6 dB. */
export const AMBIENCE_GAIN = 0.01875;
export const AMBIENCE_GAIN_MAX = 0.2;
/** How far ahead of the playout the room is kept, and when it is topped up. */
export const LEAD_MS = 80;
export const FILL_BELOW_MS = 40;
export const TICK_MS = 20;

const FILES = {
  cafe: fileURLToPath(new URL("../../assets/calls/ambience-cafe.ulaw", import.meta.url)),
  office: fileURLToPath(new URL("../../assets/calls/ambience-office.ulaw", import.meta.url)),
};

/** REASON_CALL_AMBIENCE read: "everyone" (on), "owner" (the operator only) or "" (off, and unset). */
export function ambienceMode(v = config.callAmbience) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "owner") return "owner";
  return ["on", "everyone", "1", "true", "yes"].includes(s) ? "everyone" : "";
}

/** REASON_CALL_AMBIENCE_GAIN read: a number clamped to 0–AMBIENCE_GAIN_MAX; unset or not a number = the default. */
export function ambienceGain(v = config.callAmbienceGain) {
  const s = String(v ?? "").trim();
  const n = s === "" ? NaN : Number(s);
  if (!Number.isFinite(n)) return AMBIENCE_GAIN;
  return Math.min(AMBIENCE_GAIN_MAX, Math.max(0, n));
}

/** Café or office for this call, or "" when this call gets no room at all. */
export function ambienceKind(call, { mode = ambienceMode() } = {}) {
  if (!mode || !call?.conversation_id) return "";
  try {
    const me = accounts.ownerOf(call.conversation_id);
    if (!(mode === "everyone" ? me?.known === true : me?.isOperator === true)) return "";
  } catch { return ""; }
  return Number(call.is_owner) === 1 ? "cafe" : "office";
}

let decode = null;
const loaded = new Map();

/** One bed's samples at mix level, read once per process. */
function samples(kind, gain) {
  const key = `${kind}:${gain}`;
  if (!loaded.has(key)) {
    decode ??= Int16Array.from({ length: 256 }, (_, u) => ulawToPcm(u));
    const raw = readFileSync(FILES[kind]);
    loaded.set(key, Float32Array.from(raw, u => decode[u] * gain));
  }
  return loaded.get(key);
}

export class Bed {
  constructor(kind, { gain = ambienceGain(), data = null } = {}) {
    this.kind = kind;
    this.s = data ?? samples(kind, gain);
    this.pos = 0;
    this.at = 0;
    this.off = false;
  }

  /** The next n samples of the room, the loop wrapping where it was made to. */
  #take(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.s[this.pos];
      if (++this.pos >= this.s.length) this.pos = 0;
    }
    return out;
  }

  /** Reason's μ-law frame with the room under it, and the room's clock moved on by its length. */
  mix(b64, now) {
    decode ??= Int16Array.from({ length: 256 }, (_, u) => ulawToPcm(u));
    const buf = Buffer.from(String(b64 ?? ""), "base64");
    this.at = Math.max(this.at, now) + buf.length / 8;
    if (this.off) return b64;
    const room = this.#take(buf.length);
    for (let i = 0; i < buf.length; i++) {
      const s = decode[buf[i]] + room[i];
      buf[i] = pcmToUlaw(Math.round(s > 32635 ? 32635 : s < -32635 ? -32635 : s));
    }
    return buf.toString("base64");
  }

  /** Room-only frames to send now, or null: enough to be LEAD_MS ahead, once less than FILL_BELOW_MS is. */
  fill(now) {
    if (this.off) return null;
    const lead = this.at - now;
    if (lead >= FILL_BELOW_MS) return null;
    const ms = Math.ceil((LEAD_MS - Math.max(0, lead)) / TICK_MS) * TICK_MS;
    const room = this.#take(ms * 8);
    this.at = Math.max(this.at, now) + ms;
    return Buffer.from(Array.from(room, v => pcmToUlaw(Math.round(v)))).toString("base64");
  }

  /** Twilio threw its buffer away (`clear`): the room starts again from now. */
  cleared(now) { this.at = now; }
}

/** The bed for this call, or null when it gets none. */
export function bedFor(call, opts = {}) {
  const kind = ambienceKind(call, opts);
  if (!kind) return null;
  try { return new Bed(kind, opts); } catch { return null; }
}
