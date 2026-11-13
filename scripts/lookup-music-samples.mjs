#!/usr/bin/env node
// Renders the lookup music's variants (src/calls/lookupmusic.js) to WAV files to listen to and pick from.
// No network, nothing sent anywhere.
//
//   node scripts/lookup-music-samples.mjs [out dir]     (default /tmp/cartesia-music/samples)
//
// For each variant: <variant>-phone.wav (8 kHz through μ-law, as the line carries it) and
// <variant>-24k.wav (24 kHz, the music itself), both turned up to listen to (≈ −20 dBFS), two loops
// long. And on-the-call-<variant>.wav: one lookup at the level and with the fades a call has (1 s of
// quiet, the lookup starts, music from 0.7 s, answered at 7 s, faded by 7.6 s).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMusic, musicLoop, LookupMusic, VARIANTS, DEFAULT_VARIANT, RATE } from "../src/calls/lookupmusic.js";
import { ulawToPcm, pcmToUlaw } from "../src/calls/ulaw.js";

const out = process.argv[2] || "/tmp/cartesia-music/samples";
mkdirSync(out, { recursive: true });

function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v))), 44 + i * 2));
  return b;
}
const phone = (s) => Array.from(s, v => ulawToPcm(pcmToUlaw(Math.round(v))));
const twice = (s) => { const o = new Float32Array(s.length * 2); o.set(s); o.set(s, s.length); return o; };
const LISTEN = 3277; // ≈ −20 dBFS RMS

const files = [];
for (const v of VARIANTS) {
  for (const [rate, name] of [[RATE, "phone"], [24000, "24k"]]) {
    const s = twice(renderMusic(v, { rate })).map(x => x * LISTEN);
    const f = join(out, `${v}-${name}.wav`);
    writeFileSync(f, wav(rate === RATE ? phone(s) : s, rate));
    files.push(f);
  }
  // One lookup as the call has it, at the call's level.
  const m = new LookupMusic({ data: musicLoop({ variant: v, file: "", gain: 1 }).s });
  const call = [];
  for (let t = 0; t < 9_000; t += 20) {
    if (t === 1_000) m.start("ask", t);
    if (t === 7_000) m.end("ask");
    call.push(...(m.take(160, t) ?? new Float32Array(160)));
  }
  const f = join(out, `on-the-call-${v}.wav`);
  writeFileSync(f, wav(phone(call), RATE));
  files.push(f);
}
console.log(`default: ${DEFAULT_VARIANT}`);
for (const f of files) console.log(f);
