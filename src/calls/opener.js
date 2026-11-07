// The pickup opener: a short clip in Reason's own voice, made while the phone rings, played the
// moment somebody answers a call Reason placed to a business or another person.
//
// Why (the 2026-11-07 review of the week's calls): business calls reached their goal 2 times in 10.
// After pickup the live voice took 4–5 s to say anything (journal, calls 61/71/72/74: 4.1/4.8/4.7/4.0 s
// from the stream starting): ~1.7 s for the GPT-Live session to open — the caller's "hello?" in that
// time was never even sent to it — then the voice's own turn. People said "hello? can you hear me?"
// and hung up (calls 52, 59, 61, 71, 72). So the first words no longer wait on the session: a clip of
// them is made while it rings (OpenAI TTS, the same voice name, ~1 s, a fraction of a cent) and code
// plays it as soon as their hello ends — or ~0.6 s into a silent line — while the live voice connects.
// The live voice is told what was said, so it never says it again (src/calls/gptlive.js `playOpener`).
//
// The words follow the business-call identity rules (gptlive.js `lineTalkInstructions`, Omari
// 2026-10-31): a normal person calling, no "I'm an AI" and no "calling for <name>" unless asked; the
// recording line only where the law wants it (./consent.js). What it is calling about is the model's
// own few words (call_place `about`), never parsed out of the goal by code.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/** Silence on the line this long after the pickup, nobody speaking: the opener plays. */
export const OPENER_SILENT_MS = 600;
/** Their hello has ended (this long with no speech from them; a greeting's own pauses run ~0.4 s): the opener plays. */
export const OPENER_AFTER_THEM_MS = 550;
/** A greeting still going this long after it started is a recording, a menu or a mailbox: no opener. */
export const OPENER_MAX_THEIRS_MS = 3500;
/** Nothing has fitted by now (a line that never pauses): no opener, the live voice handles it. */
export const OPENER_GIVE_UP_MS = 5000;
/**
 * They start talking this early in the clip (a "hello?" a beat after the silent-line opener began —
 * the 2026-11-07 greet drive: the receptionist started at 0.76 s, the clip at 0.61 s): it stops at once
 * and plays again from the top once their hello ends. Once only.
 */
export const OPENER_OVERLAP_MS = 240;
export const OPENER_REPLAY_WINDOW_MS = 1500;
/** They talk this long (summed) over the clip: it stops (a person cutting in, or a machine that kept going). */
export const OPENER_TALKED_OVER_MS = 900;
/** The line quiet this long after the clip: one short "hello — can you hear me okay?". */
export const OPENER_QUIET_AFTER_MS = 3000;

const VOICE_STYLE = "A young woman with a light, natural British (London) accent — warm, quick, relaxed, like a friend on the phone. A casual phone opener, not a recording.";

/**
 * The opener's words. `about` is the model's own few words finishing "I'm calling …" ("to ask about a
 * massage for low back pain"); without them only the hello, and the live voice says why right after.
 */
export function openerText({ about = "", notice = false } = {}) {
  let a = String(about ?? "").replace(/\s+/g, " ").trim().replace(/[.!?…,;:]+$/, "");
  a = a.replace(/^(?:hi( there)?[,!.]?\s*)?(?:i'?m|i am)\s+calling\s+/i, "");
  if (a.length > 140 || /[[\]{}<>]|https?:|@/.test(a)) a = "";
  const hello = notice ? "Hi there — just so you know, this call's recorded." : "Hi there!";
  if (!a) return { text: hello, kind: "hello" };
  return { text: `${hello} I'm calling ${a}.`, kind: "about" };
}

/** Is a pickup opener wanted for this call? A call Reason placed to somebody else, with talk mode on. */
export function openerFor(row) {
  return !!(config.pickupOpener && config.lineTalk && row && Number(row.is_owner) !== 1 && String(row.direction ?? "out") !== "in");
}

const cacheDir = () => join(config.dataDir, "call-openers");
const keyOf = (text) => createHash("sha256").update(`${config.openerTtsModel}|${config.gptliveVoice}|${VOICE_STYLE}|${text}`).digest("hex").slice(0, 32);

/** A clip already made for these exact words (same model and voice), or null. */
export function cached(text) {
  try {
    const f = join(cacheDir(), `${keyOf(text)}.ulaw`);
    return existsSync(f) ? readFileSync(f) : null;
  } catch { return null; }
}

function keep(text, audio) {
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), `${keyOf(text)}.ulaw`), audio, { mode: 0o600 });
  } catch { /* a clip not kept is made again next time */ }
}

/** 16-bit linear → 8-bit μ-law (G.711). */
export function linearToUlaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

/**
 * OpenAI TTS's raw output (24 kHz 16-bit mono) → 8 kHz μ-law for the phone line: each three samples
 * averaged (a plain low-pass before dropping to a third), leading silence trimmed to 40 ms so the
 * first word is not late, and a short fade-out.
 */
export function pcm24ToUlaw(buf) {
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const n = Math.floor(pcm.length / 3);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (pcm[3 * i] + pcm[3 * i + 1] + pcm[3 * i + 2]) / 3;
  let start = out.findIndex(v => Math.abs(v) > 600);
  start = start < 0 ? 0 : Math.max(0, start - 320);
  const body = out.slice(start);
  const fade = Math.min(400, body.length);
  for (let i = 0; i < fade; i++) body[body.length - 1 - i] *= i / fade;
  return Buffer.from(body.map(linearToUlaw));
}

/** Make the clip (or take it from the cache). `{ audio, cached }`, or `{ error }`. Never throws. */
export async function makeClip(text, { fetchImpl = globalThis.fetch, key = config.openaiKey, timeoutMs = 6000 } = {}) {
  const hit = cached(text);
  if (hit) return { audio: hit, cached: true };
  if (!key) return { error: "no OPENAI_API_KEY" };
  try {
    const r = await fetchImpl(`${config.openaiBase ?? "https://api.openai.com"}/v1/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.openerTtsModel, voice: config.gptliveVoice, input: text, response_format: "pcm", instructions: VOICE_STYLE }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { error: `tts ${r.status}` };
    const audio = pcm24ToUlaw(Buffer.from(await r.arrayBuffer()));
    if (audio.length < 800) return { error: "tts gave next to no audio" };
    keep(text, audio);
    return { audio, cached: false };
  } catch (e) {
    return { error: `tts: ${(e?.message ?? String(e)).split("\n")[0].slice(0, 120)}` };
  }
}

// Clips being made for calls that are ringing now, by call id. Process memory: a restart mid-ring
// loses it and that call opens the old way (the live voice).
const ready = new Map();

/**
 * Start making the opener for a call that is about to be dialled. Never waited on by the dial: a clip
 * that is not ready at pickup is simply not used. The hello-only clip is made too (cached once ever),
 * as the fallback when the "about" words cannot be spoken for any reason.
 */
export function prepare(row, { notice = false, make = makeClip, log = () => {} } = {}) {
  if (!openerFor(row)) return null;
  const want = openerText({ about: row.pickup_about, notice });
  const hello = openerText({ notice });
  const t0 = Date.now();
  const job = (async () => {
    const [main, fallback] = await Promise.all([make(want.text), want.kind === "hello" ? null : make(hello.text)]);
    const pick = main?.audio ? { ...want, audio: main.audio } : fallback?.audio ? { ...hello, audio: fallback.audio } : null;
    log({ call_opener_ready: row.id, kind: pick?.kind ?? "", ms: Date.now() - t0, cached: !!main?.cached, ...(main?.error ? { error: main.error } : {}) });
    return pick;
  })();
  const entry = { job, clip: null };
  job.then(c => { entry.clip = c; }).catch(() => {});
  ready.set(row.id, entry);
  // Never kept past a minute and a half: a call that never connected leaves nothing behind.
  setTimeout(() => { if (ready.get(row.id) === entry) ready.delete(row.id); }, 90_000).unref?.();
  return job;
}

/** The clip for this call if it is ready right now, else null (the call opens the old way). Once. */
export function take(callId) {
  const e = ready.get(callId);
  if (!e) return null;
  ready.delete(callId);
  return e.clip;
}

/** Tests: hand a call a clip as if it had been made while it rang. */
export function _setReady(callId, clip) { ready.set(callId, { job: Promise.resolve(clip), clip }); }
