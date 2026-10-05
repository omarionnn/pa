// Reason's voice, and its ears: saying something as a voice note, and listening to one.
//
//   speak()   words → speech (Gemini's text-to-speech) → the .caf Apple plays as a voice memo.
//   hear()    a voice memo somebody sent → plain WAV → the words in it (Gemini, audio in).
//
// Both rest on two things that may not be there, and both say which is missing rather than
// half-working: a model with a GEMINI_API_KEY, and a program that can convert audio (afconvert on a
// Mac, ffmpeg anywhere else — src/expressive.js). Neither direction keeps the sound: the file is
// made, sent or listened to, and deleted. What was said is what is worth keeping, and it is in the
// conversation as text either way.
//
// What is NOT in here is when to speak. That is the model's, in the system prompt. And nothing here
// pretends: a voice note Reason could not listen to is told to the turn as exactly that, with the
// reason, so the answer is "couldn't hear that one, can u type it" and never a guess at what it said.
//
// Request shapes, from Google's docs (ai.google.dev/gemini-api/docs/speech-generation and
// /generate-content/audio), read 2026-10-05:
//   speech  POST /v1beta/models/<tts model>:generateContent, with
//           generationConfig.responseModalities ["AUDIO"] and
//           speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName. The audio comes back base64 in
//           candidates[0].content.parts[0].inlineData — 24 kHz 16-bit mono, as a WAV on this
//           account and documented as raw PCM, so both are handled.
//   audio   the same endpoint on an ordinary model, with the file as
//           {"inline_data": {"mime_type": "audio/wav", "data": <base64>}} — inline is documented
//           for requests under 20 MB, and a voice note is a few hundred KB.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { config, clock } from "./config.js";
import { checkUrl } from "./pictures.js";
import {
  findConverter, runConverter, VOICE_EXT,
  VOICE_AFCONVERT_ARGS, VOICE_FFMPEG_ARGS, WAV_AFCONVERT_ARGS, WAV_FFMPEG_ARGS,
} from "./expressive.js";

/** A voice note is a few sentences. Past this it is a speech, and should have been a text. */
export const MAX_SPOKEN_CHARS = 700;
/** Nobody's voice memo is bigger than this; anything that is, is a file and not a note. */
export const MAX_HEARD_BYTES = 20 * 1024 * 1024;
/** Audio Gemini takes as it is, so a machine with no converter can still listen to these. */
const NATIVE_AUDIO = { ".wav": "audio/wav", ".mp3": "audio/mp3", ".m4a": "audio/m4a", ".aac": "audio/aac", ".aiff": "audio/aiff", ".ogg": "audio/ogg", ".flac": "audio/flac" };

/** Can Reason send its own words as a voice note right now? Names what is missing when not. */
export function speakingStatus({ apiKey = config.geminiKey, converter = findConverter() } = {}) {
  const missing = [...(apiKey ? [] : ["GEMINI_API_KEY"]), ...(converter ? [] : ["ffmpeg"])];
  return missing.length
    ? { ok: false, missing, why: `speaking needs ${missing.includes("GEMINI_API_KEY") ? "a speech model (GEMINI_API_KEY)" : ""}${missing.length === 2 ? " and " : ""}${missing.includes("ffmpeg") ? "an audio converter (ffmpeg, or afconvert on a Mac)" : ""}, and this machine does not have ${missing.length === 2 ? "them" : "it"}` }
    : { ok: true, missing: [], model: config.ttsModel, voice: config.ttsVoice, converter: converter.kind };
}

/** Can Reason listen to a voice note right now? A converter is only needed for Apple's own format. */
export function hearingStatus({ apiKey = config.geminiKey, converter = findConverter() } = {}) {
  if (!apiKey) return { ok: false, missing: ["GEMINI_API_KEY"], why: "listening needs a model that takes audio (GEMINI_API_KEY), and there is none" };
  return { ok: true, missing: [], model: config.videoModel, converter: converter?.kind ?? null };
}

/** A bare 24 kHz 16-bit mono PCM buffer → a WAV file's bytes. Left alone if it already is one. */
export function asWav(buf, { rate = 24_000 } = {}) {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") return buf;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + buf.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(buf.length, 40);
  return Buffer.concat([h, buf]);
}

/**
 * One generateContent call, tried once more when Google says it is busy.
 *
 * A 503 ("experiencing high demand") is the model being momentarily full, and nothing was made, so
 * asking again is free of side effects — these requests generate something, they do not send
 * anything. One retry and no more: a person is waiting on a typing bubble.
 */
async function gemini(opts) {
  const first = await geminiOnce(opts);
  if (first.ok || first.status !== 503) return first;
  await new Promise(r => setTimeout(r, opts.retryAfterMs ?? 1_500));
  return await geminiOnce(opts);
}

async function geminiOnce({ model, body, apiKey, fetchImpl, base, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  t?.unref?.();
  try {
    const res = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ac.signal,
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
    if (!res.ok) return { ok: false, status: res.status, error: `Gemini said ${res.status}: ${String(json?.error?.message ?? text ?? "").slice(0, 200)}` };
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? `Gemini did not answer within ${Math.round(timeoutMs / 1000)}s` : `could not reach Gemini: ${(e?.message ?? String(e)).split("\n")[0]}` };
  } finally { clearTimeout(t); }
}

/**
 * Words → a voice memo file, ready to send.
 *
 * The speech model is given the words and NOTHING else. Google's own examples put a direction in
 * front ("Say cheerfully: ..."), and on this model a direction is read out loud: asked to say a
 * line "the way a friend would in a quick voice note", it spoke that sentence and then the line.
 * Found by transcribing its own output back, twice, on 2026-10-05; the bare text came back word
 * for word both times. So there is no tone parameter — how it sounds is in how it is written.
 * Returns `{ok, file, seconds}`; the caller deletes the file once it has gone.
 */
export async function speak({
  text, tmpDir = config.audioTmpRoot,
  apiKey = config.geminiKey, model = config.ttsModel, voice = config.ttsVoice,
  fetchImpl = globalThis.fetch, base = config.geminiBase, timeoutMs = config.ttsTimeoutMs,
  converter = findConverter(), convert = runConverter, exists = existsSync, retryAfterMs = 1_500,
} = {}) {
  const words = String(text ?? "").trim();
  if (!words) return { ok: false, error: "there is nothing to say." };
  if (words.length > MAX_SPOKEN_CHARS) {
    return { ok: false, error: `that is ${words.length} characters, and a voice note is a few sentences (under ${MAX_SPOKEN_CHARS}). Say less, or send it as text.` };
  }
  const st = speakingStatus({ apiKey, converter });
  if (!st.ok) return { ok: false, missing: st.missing, error: `${st.why}. Send it as text instead — do not say you sent a voice note.` };

  const r = await gemini({
    model, apiKey, fetchImpl, base, timeoutMs, retryAfterMs,
    body: {
      contents: [{ parts: [{ text: words }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    },
  });
  // Over the limit is its own answer, because it is the one failure that fixes itself: a free
  // Gemini key allows a handful of spoken requests a minute.
  if (!r.ok && r.status === 429) return { ok: false, rate_limited: true, error: "the voice is over its limit for the moment (the speech model allows only a few a minute on this key). Send it as text instead, and do not offer another voice note right now." };
  if (!r.ok) return { ok: false, error: `the voice could not be made: ${r.error}. Send it as text instead.` };
  const data = r.json?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)?.inlineData?.data;
  if (!data) return { ok: false, error: "the speech model answered with no audio in it. Send it as text instead." };

  const wav = asWav(Buffer.from(data, "base64"));
  mkdirSync(tmpDir, { recursive: true });
  const stem = join(tmpDir, `voice-${clock.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const wavFile = `${stem}.wav`;
  const out = `${stem}${VOICE_EXT}`;
  writeFileSync(wavFile, wav);
  try {
    const args = converter.kind === "afconvert" ? VOICE_AFCONVERT_ARGS(wavFile, out) : VOICE_FFMPEG_ARGS(wavFile, out);
    const c = await convert(args, { bin: converter.bin });
    if (!c.ok) return { ok: false, error: `the voice was made but turning it into a voice memo failed: ${c.error}. Send it as text instead.` };
    if (!exists(out)) return { ok: false, error: `${converter.kind} reported success but wrote no file, so there is no voice note to send. Send it as text instead.` };
  } finally { rmSync(wavFile, { force: true }); }
  // 44-byte header, 16-bit mono at 24 kHz.
  return { ok: true, file: out, seconds: Math.round(((wav.length - 44) / 48_000) * 10) / 10, voice, model };
}

/**
 * A voice memo somebody sent → the words in it.
 *
 * Fetched from the provider's link, converted to WAV when it is Apple's own format (which no
 * listening model takes), and transcribed. Every way this can fail comes back as a reason in
 * words, because the turn is going to repeat it to the person who sent the note.
 */
export async function hear({
  url, filename = "", tmpDir = config.audioTmpRoot,
  apiKey = config.geminiKey, model = config.videoModel, fallbackModel = config.hearFallbackModel,
  fetchImpl = globalThis.fetch, base = config.geminiBase, timeoutMs = config.hearTimeoutMs,
  converter = findConverter(), convert = runConverter, read = readFileSync, retryAfterMs = 1_500,
} = {}) {
  const st = hearingStatus({ apiKey, converter });
  if (!st.ok) return { ok: false, unavailable: true, error: st.why };
  if (!url) return { ok: false, error: "it arrived with no link to the audio" };
  // Same rule as a picture's download (src/pictures.js): https only, never this machine's own
  // network. A media_url is a string from a provider, not from the person who sent the note.
  const where = checkUrl(url);
  if (!where.ok) return { ok: false, error: `it could not be downloaded: ${where.why}` };
  const name = filename || String(url).split("?")[0].split("/").pop() || "audio";
  const ext = extname(name).toLowerCase();
  if (!converter && !NATIVE_AUDIO[ext]) {
    return { ok: false, unavailable: true, error: `it is a ${ext || "voice memo"} file, and reading that needs an audio converter (ffmpeg, or afconvert on a Mac) this machine does not have` };
  }

  let bytes;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    t?.unref?.();
    try {
      const res = await fetchImpl(url, { signal: ac.signal });
      if (!res.ok) return { ok: false, error: `the audio could not be downloaded (HTTP ${res.status})` };
      bytes = Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(t); }
  } catch (e) {
    return { ok: false, error: `the audio could not be downloaded: ${e?.name === "AbortError" ? "it timed out" : (e?.message ?? String(e)).split("\n")[0]}` };
  }
  if (!bytes.length) return { ok: false, error: "the audio file was empty" };
  if (bytes.length > MAX_HEARD_BYTES) return { ok: false, error: `it is ${Math.round(bytes.length / (1024 * 1024))}MB, which is too long to listen to here` };

  let audio = bytes;
  let mime = NATIVE_AUDIO[ext] ?? "audio/wav";
  if (converter) {
    mkdirSync(tmpDir, { recursive: true });
    const stem = join(tmpDir, `heard-${clock.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const src = `${stem}${ext || ".caf"}`;
    const wav = `${stem}.wav`;
    writeFileSync(src, bytes);
    try {
      const args = converter.kind === "afconvert" ? WAV_AFCONVERT_ARGS(src, wav) : WAV_FFMPEG_ARGS(src, wav);
      const c = await convert(args, { bin: converter.bin });
      if (!c.ok) return { ok: false, error: `the audio could not be read: ${c.error}` };
      try { audio = read(wav); } catch { return { ok: false, error: "the audio could not be read: the converter wrote nothing" }; }
      mime = "audio/wav";
    } finally { rmSync(src, { force: true }); rmSync(wav, { force: true }); }
  }

  const body = {
    contents: [{
      parts: [
        { text: "Transcribe exactly what is said in this voice message, word for word, in the language it is spoken in. Output only the words — no timestamps, no speaker labels, no description, no summary. Write [inaudible] for any stretch you cannot make out rather than guessing. If there is no speech at all, output exactly: [no speech]" },
        { inline_data: { mime_type: mime, data: audio.toString("base64") } },
      ],
    }],
  };
  let used = model;
  let r = await gemini({ model, apiKey, fetchImpl, base, timeoutMs, retryAfterMs, body });
  // Still busy after a second try: somebody else listens. Only for "busy" — a refusal or a bad
  // request would be the same refusal from any model.
  if (!r.ok && r.status === 503 && fallbackModel && fallbackModel !== model) {
    used = fallbackModel;
    r = await gemini({ model: fallbackModel, apiKey, fetchImpl, base, timeoutMs, retryAfterMs, body });
  }
  if (!r.ok) return { ok: false, error: `the audio could not be transcribed: ${r.error}` };
  const said = (r.json?.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").replace(/\s+/g, " ").trim();
  if (!said) return { ok: false, error: "the model that listens returned nothing for it" };
  if (/^\[no speech\]$/i.test(said)) return { ok: true, text: "", silent: true, model: used };
  return { ok: true, text: said, model: used };
}

/** Is this attachment sound — a voice memo, or an audio file? */
export const isAudio = (a) => a?.kind === "voice" || a?.kind === "audio";

/**
 * The line a turn reads when sound arrived and nothing has listened to it. Written here, and used
 * by the adapter, so that the line put in by the adapter is the exact line replaced once the audio
 * HAS been listened to — one string, not two that have to be kept alike.
 */
export function cannotHearLine(a) {
  return a.kind === "voice"
    ? `[they sent a voice note (${a.filename}). you cannot listen to it — say so and ask them to type it if it matters]`
    : `[they sent an audio file (${a.filename}), which you cannot listen to]`;
}

export function heardLine(a, r) {
  const what = a.kind === "voice" ? "a voice note" : `an audio file (${a.filename})`;
  if (r.silent) return `[they sent ${what} with no speech in it — nothing was said]`;
  return `[they sent ${what}. this is what they said in it, transcribed — treat it as their message. a transcript can mishear a name or a number, so check one back if something hangs on it: "${r.text}"]`;
}

export function couldNotHearLine(a, why) {
  const what = a.kind === "voice" ? "a voice note" : `an audio file (${a.filename})`;
  return `[they sent ${what} and it could not be listened to: ${why}. say that in one short line and ask them to type it if it matters — do not guess at what it said]`;
}

/**
 * One held message's text, with every voice note in it listened to.
 *
 * When listening is not possible on this machine at all, the text is returned untouched: the
 * adapter's "you cannot listen to it" line is already the truth. Otherwise each note's line is
 * swapped for what was said, or for exactly why it could not be heard.
 */
export async function hearInto(text, attachments = [], { log = () => {}, listen = hear, status = hearingStatus, cover = () => {} } = {}) {
  const notes = attachments.filter(isAudio);
  if (!notes.length) return text;
  if (!status().ok) {
    // Nothing here can listen at all. The adapter's line is already the truth, and the record says
    // so too rather than leaving the note sitting at `waiting` forever.
    for (const a of notes) cover(a.media_id, { coverage: "failed", detail: status().why });
    return text;
  }
  let out = String(text ?? "");
  for (const a of notes) {
    let r;
    try { r = await listen({ url: a.url, filename: a.filename }); }
    catch (e) { r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    if (!r.ok && r.unavailable) { cover(a.media_id, { coverage: "failed", detail: r.error }); continue; }
    const line = r.ok ? heardLine(a, r) : couldNotHearLine(a, r.error);
    const was = cannotHearLine(a);
    out = out.includes(was) ? out.replace(was, line) : [out, line].filter(Boolean).join("\n");
    cover(a.media_id, r.ok
      ? (r.silent ? { coverage: "no_speech" } : { coverage: "transcribed" })
      : { coverage: "failed", detail: r.error });
    log(r.ok ? { heard: a.filename, chars: r.text.length } : { could_not_hear: a.filename, why: r.error });
  }
  return out;
}
