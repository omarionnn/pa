// What the voice hears: their side of a phone call, evened out before it goes to GPT-Live.
//
// Call 76 (2026-11-08, Omari's own, 55 s): his louder words came in around −18 to −25 dBFS and his
// quieter ones about 20 dB lower, near −45 dBFS. The quiet ones were the ones misheard ("Kibaga" for a
// place, "Right. Tell me." after he had already said "going home"). GPT-Live has no input settings to
// help — its session takes only an audio format and a voice, with no noise reduction, no voice
// activity knobs and no transcript confidence (API reference, read 2026-11-08) — so it is done here.
//
// `Hearing` is a small automatic gain control with a noise gate and a peak limiter, run on each 20 ms
// μ-law frame Twilio sends, in order, on the copy that goes to the model only. The recording and every
// loudness check in ./gptlive.js still read the line as it came.
//
//   - A frame counts as speech only when it is GATE_OVER_FLOOR_DB above the line's own noise floor
//     (the 10th-percentile frame of the last 3 s, per call) and above GATE_MIN_DB, so silence, hiss and
//     a quiet room are never lifted into something that sounds like words. And the lift is capped so
//     the floor itself never comes up past NOISE_CEIL_DB: a noisy line gets less lift, not more noise.
//   - Speech is brought toward TARGET_DB, never cut below how it came in, and lifted at most
//     MAX_GAIN_DB. The level it follows rises at once on a louder frame and falls back over a few
//     hundred ms, so loud speech is never pumped up and a quiet stretch reaches full lift in ~0.3 s.
//   - A short gap inside a phrase keeps the lift (HOLD_FRAMES), so each word does not start from
//     nothing; after a longer silence it eases back to NOISE_GAIN_DB at most, so the gaps stay quiet.
//   - While Reason's own voice is playing down the line, nothing is lifted past ECHO_GAIN_DB: what
//     their phone's echo canceller lets back of Reason must never come up loud enough to sound like
//     them talking over it (a false barge-in). Speaking over Reason at a normal level still works.
//   - Gain moves sample by sample across each frame (no steps, no clicks), and a frame's peak is held
//     under LIMIT, so a loud word after a quiet one is never clipped.

import { ulawToPcm, pcmToUlaw } from "./ulaw.js";

/** Where speech is brought to: an ordinary phone voice. */
export const TARGET_DB = -26;
/** The most it lifts anything. −45 dBFS speech comes up to about −26. */
export const MAX_GAIN_DB = 20;
/** The most it lifts silence once a gap has outlasted the hold (and anything else that is not speech). */
export const NOISE_GAIN_DB = 0;
/** A gap this many 20 ms frames long (400 ms) is still inside a phrase: the lift is held through it. */
export const HOLD_FRAMES = 20;
/** The most it lifts anything while Reason's voice is playing to them (their phone's echo of it). */
export const ECHO_GAIN_DB = 3;
/** Speech is this far over the line's noise floor... */
export const GATE_OVER_FLOOR_DB = 10;
/** ...and over this, whatever the floor. */
export const GATE_MIN_DB = -55;
/** The line's noise floor is never lifted past this, whatever the speech wants: a noisy line gets less lift. */
export const NOISE_CEIL_DB = -55;
/** A frame's peak stays under this (about −2 dBFS). */
export const LIMIT = 26000;
/** How fast the speech level it follows falls back after a louder frame, per 20 ms frame (≈ 75 dB/s). */
const ENV_FALL_DB = 1.5;
/** How fast the lift may change, per frame: up gently, down quicker. */
const GAIN_UP_DB = 3;
const GAIN_DOWN_DB = 2;
/** Samples in the fast ramp (5 ms at 8 kHz). */
const FAST_RAMP = 40;
/** The line's noise floor is the 10th-percentile frame of the last FLOOR_FRAMES (3 s): speech has gaps in that long. */
const FLOOR_FRAMES = 150;
const FLOOR_RANK = 0.1;
/** The quietest a frame is read as (digital silence would be −∞). */
const QUIET_DB = -96;

const dbOf = (rms) => (rms > 0 ? 20 * Math.log10(rms / 32768) : QUIET_DB);
const lin = (db) => 10 ** (db / 20);

export class Hearing {
  constructor() {
    this.floor = 0;
    this.recent = new Float32Array(FLOOR_FRAMES);
    this.seen = 0;
    this.sorted = new Float32Array(FLOOR_FRAMES);
    this.env = TARGET_DB;
    this.gainDb = 0;
    this.quietFrames = 0;
    /** Was the last frame speech (over the line's floor)? */
    this.speech = false;
    // One small entry per frame, for the per-turn log (`levelsBetween`): when, raw level and lift (whole
    // dB), and whether it was speech. Typed arrays, grown as needed: a long call stays a few hundred KB.
    this.n = 0;
    this.at = new Float64Array(1024);
    this.lv = new Int8Array(1024);
    this.gn = new Int8Array(1024);
    this.sp = new Uint8Array(1024);
  }

  note(at, level, gain, speech) {
    if (this.n >= MAX_TRACK) return;
    if (this.n === this.at.length) {
      const grow = (a) => { const b = new a.constructor(a.length * 2); b.set(a); return b; };
      this.at = grow(this.at); this.lv = grow(this.lv); this.gn = grow(this.gn); this.sp = grow(this.sp);
    }
    this.at[this.n] = at; this.lv[this.n] = Math.max(-128, Math.round(level)); this.gn[this.n] = Math.round(gain); this.sp[this.n] = speech ? 1 : 0;
    this.n++;
  }

  /**
   * One frame of their audio (base64 μ-law), as the model should hear it (base64 μ-law). `at` is when
   * it arrived, for the per-turn log; `reasonTalking` is true while Reason's voice is playing to them.
   */
  frame(b64, at = Date.now(), { reasonTalking = false } = {}) {
    const u = Buffer.from(String(b64 ?? ""), "base64");
    if (!u.length) return b64;
    const pcm = new Int16Array(u.length);
    let sum = 0, peak = 0;
    for (let i = 0; i < u.length; i++) {
      const s = ulawToPcm(u[i]);
      pcm[i] = s;
      sum += s * s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    const level = Math.max(QUIET_DB, dbOf(Math.sqrt(sum / u.length)));
    // The line's noise floor: the quietest frame of the last two seconds, this one included. A steady
    // hiss is its own floor, so it never counts as speech however loud it is.
    this.recent[this.seen++ % FLOOR_FRAMES] = level;
    const k = Math.min(this.seen, FLOOR_FRAMES);
    this.sorted.set(this.recent.subarray(0, k));
    const win = this.sorted.subarray(0, k).sort();
    this.floor = win[Math.floor((k - 1) * FLOOR_RANK)];
    const speech = level >= GATE_MIN_DB && level >= this.floor + GATE_OVER_FLOOR_DB;
    // Read by the call (./gptlive.js) to know they are still talking: over the line's own floor, so a
    // steady hiss or a noisy room is never taken for somebody speaking.
    this.speech = speech;
    let want;
    this.quietFrames = speech ? 0 : this.quietFrames + 1;
    // However much the speech wants, the line's own noise is never brought up past NOISE_CEIL_DB.
    const room = Math.max(0, NOISE_CEIL_DB - this.floor);
    if (reasonTalking) {
      want = Math.min(this.gainDb, ECHO_GAIN_DB);
    } else if (speech) {
      this.env = level > this.env ? level : Math.max(level, this.env - ENV_FALL_DB);
      want = Math.min(MAX_GAIN_DB, room, Math.max(0, TARGET_DB - this.env));
    } else if (this.quietFrames <= HOLD_FRAMES) {
      want = Math.min(this.gainDb, room);
    } else {
      want = Math.min(this.gainDb, NOISE_GAIN_DB);
    }
    // Down to the echo cap at once when Reason starts talking (the per-sample ramp keeps it click-free).
    const step = want > this.gainDb ? Math.min(GAIN_UP_DB, want - this.gainDb) : reasonTalking ? want - this.gainDb : Math.max(-GAIN_DOWN_DB, want - this.gainDb);
    const from = lin(this.gainDb);
    let to = lin(this.gainDb + step);
    // The limiter: this frame's loudest sample, at the lift it ends on, stays under LIMIT.
    const ceiling = peak > 0 ? LIMIT / peak : Infinity;
    if (to > ceiling) to = Math.max(1, ceiling);
    const start = Math.min(from, Math.max(1, ceiling));
    this.gainDb = 20 * Math.log10(to);
    this.note(at, level, this.gainDb, speech);
    if (start === 1 && to === 1) return b64;
    const out = Buffer.alloc(u.length);
    const n = u.length;
    // The ramp spans the frame, or 5 ms when the lift falls for Reason's own voice (fast, still click-free).
    const ramp = reasonTalking && to < start ? Math.min(n, FAST_RAMP) : n;
    for (let i = 0; i < n; i++) {
      const g = i < ramp ? start + ((to - start) * (i + 1)) / ramp : to;
      let v = Math.round(pcm[i] * g);
      if (v > LIMIT) v = LIMIT; else if (v < -LIMIT) v = -LIMIT;
      out[i] = pcmToUlaw(v);
    }
    return out.toString("base64");
  }

  /**
   * Their speech between two times, for the per-turn log: its median level as it came in, and the
   * median lift it was given, in whole dB. null when no speech frame fell in the window.
   */
  levelsBetween(from, to) {
    const levels = [], gains = [];
    for (let i = 0; i < this.n; i++) if (this.sp[i] && this.at[i] >= from && this.at[i] <= to) { levels.push(this.lv[i]); gains.push(this.gn[i]); }
    if (!levels.length) return null;
    return { level_db: median(levels), boost_db: median(gains) };
  }
}

/** About 3 hours of frames; a call is capped well under that, and past it the log simply stops. */
const MAX_TRACK = 3 * 60 * 60 * 50;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
