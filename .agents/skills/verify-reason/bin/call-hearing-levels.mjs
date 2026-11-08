#!/usr/bin/env node
// How loud a call's speech is, before and after the quiet-speech lift (src/calls/hearing.js).
//
//   node .agents/skills/verify-reason/bin/call-hearing-levels.mjs <call-N.wav> [--repo <checkout>]
//
// Run it ON THE SERVER against a stored recording (data/recordings/call-N.wav); a recording never
// leaves the box. The stored WAV is both sides mixed on one track (src/calls/gptlive.js CallTape), so
// Reason's own lines are in it too; the lift itself only ever runs on their side. Prints each stretch of
// speech with its median level as it came in and as the model would hear it, then a summary.
// Nothing is written anywhere.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--repo");
const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : resolve(new URL("../../../..", import.meta.url).pathname);
if (!file) { console.error("usage: call-hearing-levels.mjs <call.wav> [--repo <checkout>]"); process.exit(2); }
const { Hearing } = await import(pathToFileURL(join(repo, "src/calls/hearing.js")).href);
const { ulawToPcm, pcmToUlaw } = await import(pathToFileURL(join(repo, "src/calls/ulaw.js")).href);

const wav = readFileSync(file);
const fmt = wav.readUInt16LE(20), bits = wav.readUInt16LE(34);
let off = 12, data = null;
while (off < wav.length - 8) {
  const id = wav.toString("ascii", off, off + 4), len = wav.readUInt32LE(off + 4);
  if (id === "data") { data = wav.subarray(off + 8, off + 8 + len); break; }
  off += 8 + len;
}
const ulaw = fmt === 7 ? Uint8Array.from(data) : Uint8Array.from({ length: data.length / 2 }, (_, i) => pcmToUlaw(data.readInt16LE(i * 2)));
if (bits !== 8 && bits !== 16) throw new Error(`unexpected WAV (${fmt}/${bits})`);

const db = (buf) => { let s = 0; for (const u of buf) { const x = ulawToPcm(u); s += x * x; } const r = Math.sqrt(s / buf.length); return r > 0 ? 20 * Math.log10(r / 32768) : -96; };
const h = new Hearing();
const frames = [];
let clipped = 0;
for (let i = 0; i + 160 <= ulaw.length; i += 160) {
  const raw = Buffer.from(ulaw.subarray(i, i + 160));
  const out = Buffer.from(h.frame(raw.toString("base64"), i / 8), "base64");
  for (const u of out) { const x = ulawToPcm(u); if (x >= 32000 || x <= -32000) clipped++; }
  frames.push({ t: i / 8000, before: db(raw), after: db(out) });
}
// Stretches of speech: frames over −60 dBFS, gaps under 300 ms joined, 200 ms or longer kept.
const segs = [];
let cur = null;
for (const f of frames) {
  if (f.before > -60) {
    if (cur && f.t - cur.end <= 0.3) { cur.end = f.t; cur.fs.push(f); } else { cur = { start: f.t, end: f.t, fs: [f] }; segs.push(cur); }
  }
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const kept = segs.filter(s => s.end - s.start >= 0.2);
console.log("start_s  dur_s  before_dBFS  after_dBFS  lift_dB");
for (const s of kept) {
  const b = med(s.fs.map(f => f.before)), a = med(s.fs.map(f => f.after));
  console.log(`${s.start.toFixed(1).padStart(7)}  ${(s.end - s.start).toFixed(1).padStart(5)}  ${b.toFixed(1).padStart(11)}  ${a.toFixed(1).padStart(10)}  ${(a - b).toFixed(1).padStart(7)}`);
}
const gaps = frames.filter(f => f.before <= -60);
console.log(`\nquiet frames (≤ −60 dBFS): ${gaps.length}, median ${med(gaps.map(f => f.before)).toFixed(1)} → ${med(gaps.map(f => f.after)).toFixed(1)} dBFS`);
// Silence a second or more from any speech: what the line sounds like when nobody is talking.
const far = gaps.filter(f => !kept.some(s => f.t >= s.start - 1 && f.t <= s.end + 1));
if (far.length) console.log(`silence ≥ 1 s from speech: ${far.length} frames, median ${med(far.map(f => f.before)).toFixed(1)} → ${med(far.map(f => f.after)).toFixed(1)} dBFS`);
const quiet = kept.filter(s => med(s.fs.map(f => f.before)) <= -40);
if (quiet.length) console.log(`quiet speech (≤ −40 dBFS) stretches: ${quiet.length}, median ${med(quiet.map(s => med(s.fs.map(f => f.before)))).toFixed(1)} → ${med(quiet.map(s => med(s.fs.map(f => f.after)))).toFixed(1)} dBFS`);
const loud = kept.filter(s => med(s.fs.map(f => f.before)) > -30);
if (loud.length) console.log(`loud speech (> −30 dBFS) stretches: ${loud.length}, median ${med(loud.map(s => med(s.fs.map(f => f.before)))).toFixed(1)} → ${med(loud.map(s => med(s.fs.map(f => f.after)))).toFixed(1)} dBFS`);
console.log(`samples at the rail after the lift: ${clipped}`);
