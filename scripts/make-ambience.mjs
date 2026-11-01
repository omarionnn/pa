#!/usr/bin/env node
// The two call ambience beds (src/calls/ambience.js), synthesized — no recording of anybody, nothing
// licensed, so nothing to attribute (Omari, 2026-11-01: café under his own calls, office under errands).
// Deterministic: the same seed writes the same bytes, so the committed files can always be remade.
//
//   node scripts/make-ambience.mjs            → assets/calls/ambience-cafe.ulaw, ambience-office.ulaw
//
// Raw 8 kHz mono μ-law, the format Twilio plays, LOOP_S long, the end crossfaded into the start so the
// loop has no seam. Levels are set in ambience.js at mix time; these are normalized to BED_RMS.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pcmToUlaw } from "../src/calls/gptlive.js";

const RATE = 8000;
const LOOP_S = 20;
const FADE_S = 2;
const N = (LOOP_S + FADE_S) * RATE;
const BED_RMS = 3000;
const KNEE = 9000;

// mulberry32: a small seeded generator, so a rebuild is byte-identical.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A two-pole resonator (constant-peak bandpass) whose centre can move sample by sample. */
function resonator() {
  let y1 = 0, y2 = 0;
  return (x, f, q) => {
    const w = 2 * Math.PI * f / RATE;
    const r = Math.exp(-Math.PI * (f / q) / RATE);
    const y = (1 - r) * x + 2 * r * Math.cos(w) * y1 - r * r * y2;
    y2 = y1; y1 = y;
    return y;
  };
}

const onePoleLow = (fc) => { const a = Math.exp(-2 * Math.PI * fc / RATE); let y = 0; return (x) => (y = (1 - a) * x + a * y); };
const onePoleHigh = (fc) => { const lp = onePoleLow(fc); return (x) => x - lp(x); };

/** One distant talker: voiced pulses + breath through moving formants, in syllables and talk spurts. */
function talker(rand, { level = 1 } = {}) {
  const out = new Float32Array(N);
  const f1 = resonator(), f2 = resonator(), f3 = resonator();
  let pitch = 95 + rand() * 120, phase = 0;
  const F3 = 2200 + rand() * 700;
  let talking = rand() < 0.5, left = (0.5 + rand() * 2) * RATE;
  let syl = 0, sylLen = 1, F1 = 500, F2 = 1500, tF1 = 500, tF2 = 1500;
  for (let i = 0; i < N; i++) {
    if (--left <= 0) { talking = !talking; left = (talking ? 1 + rand() * 3.5 : 0.4 + rand() * 1.8) * RATE; }
    if (--syl <= 0) {
      sylLen = syl = Math.round((0.14 + rand() * 0.16) * RATE);
      tF1 = 300 + rand() * 500; tF2 = 900 + rand() * 1300;
      pitch = Math.max(80, Math.min(240, pitch * (0.92 + rand() * 0.16)));
    }
    F1 += (tF1 - F1) * 0.004; F2 += (tF2 - F2) * 0.004;
    const env = talking ? Math.sin(Math.PI * (1 - syl / sylLen)) ** 2 : 0;
    phase += pitch / RATE;
    let ex = 0;
    if (phase >= 1) { phase -= 1; ex = 1; }
    ex = ex * 6 + (rand() - 0.5) * 0.6;
    out[i] = level * env * (f1(ex, F1, 6) + 0.6 * f2(ex, F2, 9) + 0.12 * f3(ex, F3, 5));
  }
  return out;
}

/** A sum of decaying inharmonic partials: a cup, a spoon, a saucer. */
function clink(out, at, rand, level) {
  const base = 1800 + rand() * 1200;
  const parts = [1, 1.47 + rand() * 0.2, 2.09 + rand() * 0.3].map(m => Math.min(3500, base * m));
  const decay = 0.05 + rand() * 0.12;
  for (let k = 0; k < 0.4 * RATE && at + k < N; k++) {
    const t = k / RATE;
    let s = 0;
    for (const [j, f] of parts.entries()) s += Math.sin(2 * Math.PI * f * t + j) / (j + 1);
    out[at + k] += level * s * Math.exp(-t / decay);
  }
}

/** One key press: a short bandpassed tick, sometimes the deeper space bar. */
function keystroke(out, at, rand, level) {
  const r = resonator();
  const f = rand() < 0.15 ? 700 + rand() * 300 : 1800 + rand() * 1200;
  for (let k = 0; k < 0.04 * RATE && at + k < N; k++) {
    const env = Math.exp(-k / (0.006 * RATE));
    out[at + k] += level * r((rand() - 0.5) * env, f, 4);
  }
}

function noise(rand, fc, level) {
  const lp = onePoleLow(fc), lp2 = onePoleLow(fc);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = level * lp2(lp(rand() - 0.5));
  return out;
}

function mix(...tracks) {
  const out = new Float32Array(N);
  for (const t of tracks) for (let i = 0; i < N; i++) out[i] += t[i];
  return out;
}

function cafe() {
  const rand = rng(20261101);
  const voices = Array.from({ length: 9 }, () => talker(rand, { level: 0.4 + rand() * 0.8 }));
  const babble = mix(...voices);
  // Across the room: the highs go first.
  const lp = onePoleLow(1900), hp = onePoleHigh(180);
  for (let i = 0; i < N; i++) babble[i] = hp(lp(babble[i]));
  const room = noise(rand, 500, 0.6);
  const cups = new Float32Array(N);
  for (let at = Math.round(rand() * RATE); at < N; at += Math.round((1.2 + rand() * 3.5) * RATE)) clink(cups, at, rand, 0.05 + rand() * 0.08);
  return mix(normalized(babble, 1), normalized(room, 0.25), normalized(cups, 0.35, { peak: true }));
}

function office() {
  const rand = rng(1101_2026);
  const air = noise(rand, 350, 1);
  const voices = Array.from({ length: 3 }, () => talker(rand, { level: 0.5 + rand() * 0.5 }));
  const murmur = mix(...voices);
  const lp = onePoleLow(1300), hp = onePoleHigh(200);
  for (let i = 0; i < N; i++) murmur[i] = hp(lp(murmur[i]));
  const keys = new Float32Array(N);
  let at = Math.round(rand() * RATE);
  while (at < N) {
    const strokes = 6 + Math.floor(rand() * 28);
    for (let s = 0; s < strokes && at < N; s++) {
      keystroke(keys, at, rand, 0.6 + rand() * 0.6);
      at += Math.round((0.07 + rand() * 0.12) * RATE);
    }
    at += Math.round((0.8 + rand() * 4) * RATE);
  }
  return mix(normalized(air, 0.55), normalized(murmur, 0.6), normalized(keys, 0.45, { peak: true }));
}

/** Scaled so its RMS (or its peak) is `share` of the bed's. */
function normalized(x, share, { peak = false } = {}) {
  let m = 0;
  if (peak) for (const v of x) m = Math.max(m, Math.abs(v));
  else { for (const v of x) m += v * v; m = Math.sqrt(m / x.length); }
  const k = m ? (share * BED_RMS * (peak ? 4 : 1)) / m : 0;
  return x.map(v => v * k);
}

/** LOOP_S seconds whose last FADE_S fade into its first, equal power: no seam when it wraps. */
function looped(x) {
  const loop = LOOP_S * RATE, fade = FADE_S * RATE;
  const out = new Float32Array(loop);
  for (let i = 0; i < loop; i++) out[i] = x[i];
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] = x[i] * Math.sin(g * Math.PI / 2) + x[loop + i] * Math.cos(g * Math.PI / 2);
  }
  let rms = 0;
  for (const v of out) rms += v * v;
  rms = Math.sqrt(rms / out.length);
  // Soft-limited under KNEE: at the mix level (ambience.js AMBIENCE_GAIN) the room's loudest moment
  // stays under the 1500 peak the call code reads as speech, so the room alone never counts as talk.
  return Buffer.from(Array.from(out, v => pcmToUlaw(Math.round(KNEE * Math.tanh((v * BED_RMS / rms) / KNEE)))));
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "calls");
mkdirSync(dir, { recursive: true });
for (const [name, make] of [["cafe", cafe], ["office", office]]) {
  const file = join(dir, `ambience-${name}.ulaw`);
  writeFileSync(file, looped(make()));
  console.log(file);
}
