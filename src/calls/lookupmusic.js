// Soft music under a Cartesia call while Reason is looking something up (the operator's own calls only;
// docs/calls-cartesia.md section 5). On Cartesia's own demo a quiet bed of music came in while the
// assistant went off to look something up and blended out when it came back; this is the same, mixed on
// our side of the line so it sounds the same whichever voice carries the call.
//
// REASON_CARTESIA_LOOKUP_MUSIC: "off" (unset) or "on" (the calmest variant, DEFAULT_VARIANT); a variant's
//   name ("warm-pad", "soft-keys", "light-pulse") picks that one instead.
// REASON_CARTESIA_LOOKUP_MUSIC_FILE: a path to a track the owner has chosen and holds the rights to (a
//   .wav, PCM 16-bit at any rate, mono or stereo, or raw 8 kHz μ-law .ulaw). It replaces the synthesized
//   music: brought to the same level, resampled to 8 kHz and looped with a short crossfade at the seam.
//   A file that cannot be read is logged and the synthesized music is used.
// REASON_CARTESIA_LOOKUP_MUSIC_GAIN: a multiplier on the default level, 0–2 (unset = 1).
//
// The music is synthesized here (`renderMusic`, a pure function): a few sine partials per note, chords
// crossfading slowly, nothing downloaded and nothing anyone else owns. It is rendered once per process
// (`musicLoop`, cached) at 8 kHz, and every frequency and slow movement in it is a whole number of
// cycles per loop, so the loop has no seam.
//
// When it plays (`LookupMusic`): an ask_reason lookup still running MUSIC_DELAY_MS after it began fades
// the music in over FADE_IN_MS (a fast lookup gets none); any speech (his, or the agent's own line)
// ducks it to DUCK_LEVEL; the answer coming back, or the hand-off to a text, fades it out over
// FADE_OUT_MS, so it is gone by the time the answer is spoken. Every change is a ramp: no clicks, no
// jumps. A barge-in clears what Twilio had queued, not the music's fades: the music comes back in from
// nothing over REENTRY_MS at whatever level its fades are at. It is not in the call's recording.
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { ulawToPcm, pcmToUlaw } from "./ulaw.js";
import { LEAD_MS, FILL_BELOW_MS, TICK_MS } from "./ambience.js";

export const RATE = 8000;
/** The loop's length: four chords of LOOP_S / 4 each. */
export const LOOP_S = 16;
export const VARIANTS = Object.freeze(["warm-pad", "soft-keys", "light-pulse"]);
/** The calmest. */
export const DEFAULT_VARIANT = "warm-pad";

/** A lookup this young gets no music: most answers are back before it. */
export const MUSIC_DELAY_MS = 700;
export const FADE_IN_MS = 400;
export const FADE_OUT_MS = 600;
/** Under speech: the music's level, how fast it gets there, and how long after the last speech it stays. */
export const DUCK_LEVEL = 0.25;
export const DUCK_DOWN_MS = 80;
export const DUCK_HOLD_MS = 350;
/** Fading out and the agent starts the answer: what is left of the music goes within one frame. */
export const UNDER_ANSWER_MS = 20;
/** After a barge-in cleared Twilio's queue, the music comes back in from nothing over this. */
export const REENTRY_MS = 30;
/** Full level, as RMS in 16-bit units: ≈ −45 dBFS, about 15 dB under the agent's voice (≈ −30). */
export const MUSIC_RMS = 185;
export const GAIN_MAX = 2;
/** A file's loop seam is crossfaded over this. */
export const SEAM_MS = 200;

/** REASON_CARTESIA_LOOKUP_MUSIC read: a variant's name, or "" (off, and unset). */
export function lookupMusicMode(v = config.cartesiaLookupMusic) {
  const s = String(v ?? "").trim().toLowerCase();
  if (VARIANTS.includes(s)) return s;
  return ["on", "1", "true", "yes"].includes(s) ? DEFAULT_VARIANT : "";
}

/** REASON_CARTESIA_LOOKUP_MUSIC_GAIN read: 0–GAIN_MAX, unset or not a number = 1. */
export function lookupMusicGain(v = config.cartesiaLookupMusicGain) {
  const s = String(v ?? "").trim();
  const n = s === "" ? NaN : Number(s);
  return Number.isFinite(n) ? Math.min(GAIN_MAX, Math.max(0, n)) : 1;
}

// ---------- the music ----------

/** A sine oscillator by rotating a phasor: `f` cycles per sample, starting `phase` cycles in. */
function osc(f, phase = 0) {
  const w = 2 * Math.PI * f;
  return { c: Math.cos(2 * Math.PI * phase), s: Math.sin(2 * Math.PI * phase), cw: Math.cos(w), sw: Math.sin(w) };
}
/** The oscillator's current value, and it moved on one sample. */
function tick(o) {
  const v = o.s;
  const s = o.s * o.cw + o.c * o.sw;
  o.c = o.c * o.cw - o.s * o.sw;
  o.s = s;
  return v;
}
const frac = (x) => x - Math.floor(x);
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// Cmaj9 → Am9 → Fmaj7 → G6/9, voiced between about 220 Hz and 700 Hz, where a phone line carries it.
const CHORDS = [[60, 64, 67, 71, 74], [57, 60, 64, 67, 71], [65, 69, 72, 76], [62, 67, 71, 74, 76]];

/**
 * One variant's loop as samples (RMS 1, peaks about 4–6), `seconds` long at `rate`. Pure: the same
 * arguments give the same samples. Every frequency is a whole number of cycles per loop, and the notes
 * of "soft-keys" are written around the loop's end into its start, so sample N−1 runs into sample 0.
 */
export function renderMusic(variant = DEFAULT_VARIANT, { rate = RATE, seconds = LOOP_S } = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`no music variant called ${variant}`);
  const n = Math.round(rate * seconds);
  const out = new Float64Array(n);
  const q = (f) => Math.max(1, Math.round(f * seconds)) / seconds; // a whole number of cycles per loop
  const seg = seconds / CHORDS.length;
  // The pad: each chord swells in and out over two segments (sin²), overlapping the next by half, so
  // the windows always sum to one. Two voices a hair apart per note give it a slow shimmer.
  const pad = (gain, partials) => {
    const len = Math.round(2 * seg * rate);
    CHORDS.forEach((chord, c) => {
      const i0 = Math.round(c * seg * rate);
      chord.forEach((m, k) => {
        const f = hz(m);
        const amp = gain / chord.length / (1 + (m - 57) / 24); // higher notes a little softer
        // Each partial at its own fixed phase, so they never all line up into a peak.
        const parts = [];
        [q(f * 0.9985), q(f * 1.0015)].forEach((v, j) => {
          for (const [h, a] of partials) parts.push({ a, o: osc((v * h) / rate, frac((v * h * i0) / rate) + ((c * 7 + k * 3 + h * 5 + j * 11) % 17) / 17) });
        });
        const lfoHz = (k + c + 1) / seconds; // slow level movement, 1–8 cycles per loop
        const lfo = osc(lfoHz / rate, frac((lfoHz * i0) / rate) + k / 5);
        const win = osc(1 / len, 0.25); // sin² over the two segments = (1 − cos) / 2
        for (let j = 0; j < len; j++) {
          let i = i0 + j;
          if (i >= n) i -= n;
          let v = 0;
          for (const p of parts) v += p.a * tick(p.o);
          const w = 0.5 - 0.5 * tick(win);
          out[i] += amp * w * (0.85 + 0.15 * tick(lfo)) * v;
        }
      });
    });
  };
  if (variant === "warm-pad") pad(1, [[1, 1], [2, 0.18], [3, 0.05]]);
  else if (variant === "light-pulse") {
    pad(1, [[1, 1], [2, 0.22], [3, 0.06]]);
    // A slow, soft swell at 75 a minute (20 per loop): never silent, never a hard edge.
    const per = Math.round(1.25 * seconds) / seconds;
    for (let i = 0; i < n; i++) { const b = 0.5 - 0.5 * Math.cos(2 * Math.PI * per * (i / rate)); out[i] *= 0.55 + 0.45 * b * b; }
  } else {
    pad(0.35, [[1, 1], [2, 0.12]]);
    // Soft keys: one chord tone every half second, a gentle strike and a long decay.
    const step = 0.5;
    const pattern = [0, 2, 1, 3, 2, 4, 3, 1];
    const total = Math.round(seconds / step);
    const len = Math.round(3 * rate);
    const attack = Math.round(0.012 * rate);
    for (let j = 0; j < total; j++) {
      const chord = CHORDS[Math.floor((j * step) / seg) % CHORDS.length];
      const f = hz(chord[pattern[j % pattern.length] % chord.length] + 12 * (j % 8 === 5 ? 1 : 0));
      const vel = 0.55 + 0.15 * Math.sin(2 * Math.PI * (j / total + 0.25));
      const start = Math.round(j * step * rate);
      const o = [1, 2, 3].map(h => osc((f * h) / rate));
      const d = [0.9, 0.35, 0.2].map(tau => Math.exp(-1 / (tau * rate)));
      const e = [1, 0.25, 0.06];
      for (let i = 0; i < len; i++) {
        const a = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : 1;
        let s = 0;
        for (let h = 0; h < 3; h++) { s += e[h] * tick(o[h]); e[h] *= d[h]; }
        out[(start + i) % n] += vel * a * s;
      }
    }
  }
  let sq = 0;
  for (const v of out) sq += v * v;
  const k = 1 / Math.sqrt(sq / n || 1);
  return Float32Array.from(out, v => v * k);
}

/** A WAV file (PCM 16-bit or μ-law, any rate, any channels) or raw μ-law, as mono samples and its rate. */
export function readTrack(file) {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF") return { rate: RATE, s: Float64Array.from(buf, u => ulawToPcm(u)) };
  let fmt = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === "data" && fmt) {
      const body = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
      const ch = Math.max(1, fmt.channels);
      if (fmt.format === 7 && fmt.bits === 8) {
        const s = new Float64Array(Math.floor(body.length / ch));
        for (let i = 0; i < s.length; i++) { let v = 0; for (let c = 0; c < ch; c++) v += ulawToPcm(body[i * ch + c]); s[i] = v / ch; }
        return { rate: fmt.rate, s };
      }
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error("only PCM 16-bit or μ-law WAV files");
      const s = new Float64Array(Math.floor(body.length / 2 / ch));
      for (let i = 0; i < s.length; i++) { let v = 0; for (let c = 0; c < ch; c++) v += body.readInt16LE((i * ch + c) * 2); s[i] = v / ch; }
      return { rate: fmt.rate, s };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("no audio in the WAV file");
}

/** Samples at `from` Hz brought to 8 kHz (a windowed-sinc low-pass under the phone band first). */
export function toPhoneRate(s, from) {
  if (from === RATE) return Float64Array.from(s);
  const ratio = from / RATE;
  const cut = Math.min(0.5, 3600 / from); // cycles per input sample
  const taps = 32;
  const n = Math.floor(s.length / ratio);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * ratio;
    const lo = Math.ceil(c - taps);
    let v = 0;
    let wsum = 0;
    for (let j = lo; j <= c + taps; j++) {
      const x = j - c;
      const w = (x === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos((Math.PI * x) / (taps + 1)));
      v += w * (s[((j % s.length) + s.length) % s.length]);
      wsum += w;
    }
    out[i] = v / (wsum || 1);
  }
  return out;
}

/** A track looped without a click: its last SEAM_MS crossfaded (equal power) into its first. */
export function seamless(s, rate = RATE, ms = SEAM_MS) {
  const x = Math.min(Math.floor((rate * ms) / 1000), Math.floor(s.length / 3));
  const out = Float64Array.from(s.subarray(0, s.length - x));
  for (let i = 0; i < x; i++) {
    const w = i / x;
    out[i] = s[i] * Math.sin((Math.PI / 2) * w) + s[s.length - x + i] * Math.cos((Math.PI / 2) * w);
  }
  return out;
}

const loops = new Map();

/**
 * The loop the call plays: 8 kHz samples in 16-bit units at MUSIC_RMS × gain. A file when one is set
 * (`file`), else the synthesized variant. Cached per process. `{ s, source }`, never throws for a file:
 * one that cannot be read gives the synthesized music and `fileError`.
 */
export function musicLoop({ variant = DEFAULT_VARIANT, file = config.cartesiaLookupMusicFile, gain = lookupMusicGain() } = {}) {
  const key = `${variant}|${file ?? ""}|${gain}`;
  if (loops.has(key)) return loops.get(key);
  let raw = null;
  let source = variant;
  let fileError = "";
  if (file) {
    try {
      const t = readTrack(file);
      raw = seamless(toPhoneRate(t.s, t.rate));
      if (raw.length < RATE) throw new Error("shorter than a second");
      source = "file";
    } catch (e) { raw = null; fileError = (e?.message ?? String(e)).split("\n")[0].slice(0, 120); }
  }
  raw ??= renderMusic(variant);
  let sq = 0;
  for (const v of raw) sq += v * v;
  const k = (MUSIC_RMS * gain) / Math.sqrt(sq / raw.length || 1);
  const loop = { s: Float32Array.from(raw, v => Math.max(-8000, Math.min(8000, v * k))), source, ...(fileError ? { fileError } : {}) };
  loops.set(key, loop);
  return loop;
}

// ---------- when it plays ----------

const PER_MS = RATE / 1000;

/** The music's state for one call: which lookups are running, its fades, and where in the loop it is. */
export class LookupMusic {
  constructor({ data, delayMs = MUSIC_DELAY_MS } = {}) {
    this.s = data ?? musicLoop().s;
    this.delayMs = delayMs;
    this.pos = 0;
    this.g = 0;
    this.re = 1;
    this.lookups = new Map();
    this.duckUntil = -Infinity;
    this.stopped = false;
  }

  /** A lookup began at `t` (`key` is anything that names it). */
  start(key, t) { if (!this.stopped) this.lookups.set(key, t); }

  /** That lookup's answer is back, or it went to a text: once none is left, the music fades out. */
  end(key) { this.lookups.delete(key); }

  /** Somebody is talking at `t` (him, or the agent): the music ducks under it. */
  speech(t) { this.duckUntil = t + DUCK_HOLD_MS; }

  /** The call is over or handed on: nothing more, at once. */
  stop() { this.stopped = true; this.lookups.clear(); this.g = 0; }

  /** Twilio threw its queue away: the next music comes in from nothing, its fades where they were. */
  cleared() { this.re = 0; }

  /** Where the fades are heading at `now`: 0 (no lookup old enough), DUCK_LEVEL or 1. */
  target(now) {
    if (this.stopped) return 0;
    let on = false;
    for (const at of this.lookups.values()) if (now - at >= this.delayMs) { on = true; break; }
    if (!on) return 0;
    return now < this.duckUntil ? DUCK_LEVEL : 1;
  }

  /** Whether the music would make any sound now (a fade still running counts). */
  audible(now) { return !this.stopped && (this.g > 0 || this.target(now) > 0); }

  /** The next n samples of music with its fades on them, or null when they are all silent. */
  take(n, now) {
    if (this.stopped || !this.audible(now)) return null;
    const target = this.target(now);
    const up = 1 / (FADE_IN_MS * PER_MS);
    const down = target > 0 ? (1 - DUCK_LEVEL) / (DUCK_DOWN_MS * PER_MS) : 1 / ((now < this.duckUntil ? UNDER_ANSWER_MS : FADE_OUT_MS) * PER_MS);
    const reUp = 1 / (REENTRY_MS * PER_MS);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (this.g < target) this.g = Math.min(target, this.g + up);
      else if (this.g > target) this.g = Math.max(target, this.g - down);
      if (this.re < 1) this.re = Math.min(1, this.re + reUp);
      out[i] = this.s[this.pos] * this.g * this.re;
      if (++this.pos >= this.s.length) this.pos = 0;
    }
    return out;
  }

  /** A μ-law frame with the music mixed in, or the same frame untouched when the music is silent. */
  over(b64, now) {
    const buf = Buffer.from(String(b64 ?? ""), "base64");
    const m = this.take(buf.length, now);
    if (!m) return b64;
    for (let i = 0; i < buf.length; i++) {
      const s = ulawToPcm(buf[i]) + m[i];
      buf[i] = pcmToUlaw(Math.round(s > 32635 ? 32635 : s < -32635 ? -32635 : s));
    }
    return buf.toString("base64");
  }
}

/**
 * The call's room (an ambience Bed, or null) with the music on top: the same `mix`/`fill`/`cleared`
 * the relay already uses. With a room, its frames carry the music; with none, music-only frames are
 * kept LEAD_MS ahead only while the music is sounding, so a call without a lookup sends what it did.
 */
export class LookupBed {
  constructor(room, music) {
    this.room = room;
    this.music = music;
    this.kind = room?.kind ?? "";
    this.at = 0;
  }

  mix(b64, now) {
    const out = this.room ? this.room.mix(b64, now) : b64;
    this.at = Math.max(this.at, now) + Buffer.from(String(b64 ?? ""), "base64").length / 8;
    return this.music.over(out, now);
  }

  fill(now, opts = {}) {
    if (this.room) {
      const f = this.room.fill(now, opts);
      if (!f) return null;
      this.at = this.room.at;
      return this.music.over(f, now);
    }
    if (!this.music.audible(now)) return null;
    const lead = this.at - now;
    if (lead >= FILL_BELOW_MS) return null;
    const ms = Math.ceil((LEAD_MS - Math.max(0, lead)) / TICK_MS) * TICK_MS;
    this.at = Math.max(this.at, now) + ms;
    return this.music.over(Buffer.alloc(ms * 8, 0xff).toString("base64"), now);
  }

  cleared(now) {
    this.room?.cleared(now);
    this.at = now;
    this.music.cleared();
  }
}

/**
 * The music for this call, or null: the switch on, his own call, and no room that is already music.
 * `{ music, bed }`, the bed being what the relay mixes through in place of `room`.
 */
export function lookupMusicFor(call, room, { mode = lookupMusicMode(), log = () => {} } = {}) {
  if (!mode || Number(call?.is_owner) !== 1) return null;
  if (/music|radio|song/i.test(String(room?.kind ?? ""))) return null;
  let loop;
  try { loop = musicLoop({ variant: mode }); } catch (e) { log({ cartesia_lookup_music: call.id, ok: false, why: (e?.message ?? String(e)).slice(0, 120) }); return null; }
  if (loop.fileError) log({ cartesia_lookup_music: call.id, file_error: loop.fileError });
  const music = new LookupMusic({ data: loop.s });
  return { music, bed: new LookupBed(room, music), source: loop.source };
}
