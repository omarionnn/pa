#!/usr/bin/env node
// Receptionist lines for gptlive-line-drive.mjs's business scenes, spoken by OpenAI TTS (a few cents),
// written as raw 8 kHz mono μ-law: <out dir>/tts-<name>.ulaw, plus a "-noisy" copy of each with line
// noise mixed in. Run anywhere with OPENAI_API_KEY: node make-tts-line-clips.mjs <out dir>
const { writeFileSync, mkdirSync } = await import("node:fs");
const { join, resolve, dirname } = await import("node:path");
const out = process.argv[2];
if (!out || !process.env.OPENAI_API_KEY) { console.error("usage: OPENAI_API_KEY=… make-tts-line-clips.mjs <out dir>"); process.exit(2); }
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../../../..");
const { pcmToUlaw } = await import(`${REPO}/src/calls/gptlive.js`);
mkdirSync(out, { recursive: true });
const LINES = {
  greet: "Hi, Chelsea Bodywork, can I help you?",
  hello: "Hello?",
  recommend: "Oh, for low back pain I'd recommend our deep tissue massage. It's really good for that.",
  price: "An hour is a hundred and twenty dollars.",
  anything: "Mm-hm. Anything else?",
  bye: "Okay, no problem. Have a good night, bye!",
  yes: "Yes, this is Chelsea Bodywork. How can I help?",
  holdon: "Sorry, can you hold on one second?",
  back: "Okay, sorry about that, I'm back. What did you need?",
  robot: "Wait, sorry, is this a robot?",
  okay: "Oh okay. So, deep tissue is what I'd recommend, an hour is a hundred and twenty.",
};
// Simple line noise: hiss plus a little hum, deterministic.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
for (const [name, text] of Object.entries(LINES)) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "coral", input: text, response_format: "pcm", instructions: "A friendly, slightly busy spa receptionist answering the phone. Natural, casual." }),
  });
  if (!r.ok) { console.error(name, r.status, (await r.text()).slice(0, 200)); process.exit(1); }
  const b = Buffer.from(await r.arrayBuffer());
  const pcm24 = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  const n = Math.floor(pcm24.length / 3);
  const clean = Buffer.alloc(n), noisy = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const s = (pcm24[3 * i] + pcm24[3 * i + 1] + pcm24[3 * i + 2]) / 3;
    clean[i] = pcmToUlaw(Math.round(s));
    const noise = rnd() * 1800 + Math.sin(2 * Math.PI * 60 * i / 8000) * 500;
    noisy[i] = pcmToUlaw(Math.max(-32000, Math.min(32000, Math.round(s * 0.8 + noise))));
  }
  writeFileSync(join(out, `tts-${name}.ulaw`), clean);
  writeFileSync(join(out, `tts-${name}-noisy.ulaw`), noisy);
  console.log(name, (n / 8000).toFixed(1), "s");
}
