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
import { guardedFetch } from "./netguard.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { config, clock } from "./config.js";
import { checkUrl } from "./pictures.js";
import { localUpload } from "./webuploads.js";
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
export function speakingStatus({ apiKey = config.geminiKey, converter = findConverter(), as = null, openaiKey = config.openaiKey } = {}) {
  // Spoken in the call's own voice (`as`, src/identity.js): OpenAI's speech model can make it alone.
  const canSpeak = !!apiKey || (as?.provider === "openai" && !!openaiKey);
  const missing = [...(canSpeak ? [] : ["GEMINI_API_KEY"]), ...(converter ? [] : ["ffmpeg"])];
  return missing.length
    ? { ok: false, missing, why: `speaking needs ${missing.includes("GEMINI_API_KEY") ? "a speech model (GEMINI_API_KEY)" : ""}${missing.length === 2 ? " and " : ""}${missing.includes("ffmpeg") ? "an audio converter (ffmpeg, or afconvert on a Mac)" : ""}, and this machine does not have ${missing.length === 2 ? "them" : "it"}` }
    : { ok: true, missing: [], model: as?.provider === "openai" && openaiKey ? as.model : config.ttsModel, voice: as?.voice ?? config.ttsVoice, converter: converter.kind };
}

/**
 * Words → speech in the voice a live call uses (OpenAI's speech model; the pickup opener in
 * src/calls/opener.js asks the same endpoint for the same voice). Raw 24 kHz PCM back, wrapped as a
 * WAV. `{ ok, wav }` or `{ ok: false, error }`; never throws. The direction rides in `instructions`,
 * which this model follows and does not read out.
 */
export async function openaiSpeech({ text, model, voice, instructions = "", key = config.openaiKey, fetchImpl = globalThis.fetch, base = config.openaiBase ?? "https://api.openai.com", timeoutMs = config.ttsTimeoutMs } = {}) {
  if (!key) return { ok: false, error: "no OPENAI_API_KEY" };
  try {
    const r = await fetchImpl(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, response_format: "pcm", ...(instructions ? { instructions } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, status: r.status, error: `speech ${r.status}` };
    const pcm = Buffer.from(await r.arrayBuffer());
    if (pcm.length < 4800) return { ok: false, error: "the speech model answered with next to no audio" };
    return { ok: true, wav: asWav(pcm) };
  } catch (e) {
    return { ok: false, error: (e?.message ?? String(e)).split("\n")[0].slice(0, 120) };
  }
}

/** Can Reason listen to a voice note right now? A converter is only needed for Apple's own format. */
export function hearingStatus({ apiKey = config.geminiKey, converter = findConverter() } = {}) {
  if (!apiKey) return { ok: false, missing: ["GEMINI_API_KEY"], why: "listening needs a model that takes audio (GEMINI_API_KEY), and there is none" };
  return { ok: true, missing: [], model: config.hearModel, converter: converter?.kind ?? null };
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
 *
 * Not answering in time is the same kind of thing and gets the same one retry, when the caller asks
 * for it (`retryOnTimeout`). On 2026-10-06 a seven-second voice note "timed out" after a full
 * minute; the same audio sent again was transcribed in 1.3 seconds. Nothing was made by the request
 * that hung, so asking again costs a wait and nothing else.
 */
async function gemini(opts) {
  const first = await geminiOnce(opts);
  if (opts.noRetry) return first;
  const again = first.status === 503 || (opts.retryOnTimeout && first.timed_out);
  if (first.ok || !again) return first;
  if (first.status === 503) await new Promise(r => setTimeout(r, opts.retryAfterMs ?? 1_500));
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
    const timedOut = e?.name === "AbortError";
    return {
      ok: false, ...(timedOut ? { timed_out: true } : {}),
      error: timedOut ? `Gemini did not answer within ${Math.round(timeoutMs / 1000)}s` : `could not reach Gemini: ${(e?.message ?? String(e)).split("\n")[0]}`,
    };
  } finally { clearTimeout(t); }
}

/**
 * How long one attempt at listening may take, from how long the note is.
 *
 * The limit used to be the same minute for a three-second "running late" and a ten-minute memo. A
 * short note that has not come back in a quarter of a minute is not going to, and waiting out the
 * whole minute is the person staring at nothing before being asked to type it. So: ten seconds, plus
 * two for every second of audio, never under fifteen and never over the configured ceiling. An
 * unknown length gets twenty seconds: it is almost always a short note, and a minute of nothing
 * before the other model is asked is the wait this exists to stop (2026-11-09).
 */
export const HEAR_UNKNOWN_LENGTH_MS = 20_000;
export function hearAttemptMs(seconds, ceilingMs = config.hearTimeoutMs) {
  if (!(seconds > 0)) return Math.min(ceilingMs, HEAR_UNKNOWN_LENGTH_MS);
  return Math.min(ceilingMs, Math.max(15_000, 10_000 + Math.round(seconds * 2_000)));
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
  // One voice (src/identity.js noteVoiceFor): `{ provider: "openai", model, voice, instructions,
  // fallbackVoice }` speaks the note in the voice their calls use; `{ provider: "gemini", voice }`
  // is the closest Gemini voice. null: the install's default, exactly as before.
  as = null, openaiKey = config.openaiKey, openaiBase = config.openaiBase ?? "https://api.openai.com",
} = {}) {
  const words = String(text ?? "").trim();
  if (!words) return { ok: false, error: "there is nothing to say." };
  if (words.length > MAX_SPOKEN_CHARS) {
    return { ok: false, error: `that is ${words.length} characters, and a voice note is a few sentences (under ${MAX_SPOKEN_CHARS}). Say less, or send it as text.` };
  }
  const st = speakingStatus({ apiKey, converter, as, openaiKey });
  if (!st.ok) return { ok: false, missing: st.missing, error: `${st.why}. Send it as text instead — do not say you sent a voice note.` };

  // The call's own voice first. If it cannot be made, the closest Gemini voice — not the old default.
  let matched = null;
  let fellBack = "";
  if (as?.provider === "openai") {
    const o = await openaiSpeech({ text: words, model: as.model, voice: as.voice, instructions: as.instructions ?? "", key: openaiKey, fetchImpl, base: openaiBase, timeoutMs });
    if (o.ok) matched = o.wav;
    else {
      fellBack = o.error;
      if (!apiKey) return { ok: false, error: `the voice could not be made: ${o.error}. Send it as text instead.` };
    }
  }
  if (as && !matched) voice = (as.provider === "gemini" ? as.voice : as.fallbackVoice) || voice;
  if (matched) return finish(matched, { voice: as.voice, model: as.model, provider: "openai", matched: true });

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

  return finish(asWav(Buffer.from(data, "base64")), { voice, model, provider: "gemini", matched: false, ...(fellBack ? { fell_back: fellBack } : {}) });

  /** The WAV → the voice memo file. */
  async function finish(wav, said) {
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
  return { ok: true, file: out, seconds: Math.round(((wav.length - 44) / 48_000) * 10) / 10, ...said };
  }
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
  apiKey = config.geminiKey, model = config.hearModel, fallbackModel = config.hearFallbackModel,
  fetchImpl = globalThis.fetch, base = config.geminiBase, timeoutMs = config.hearTimeoutMs,
  converter = findConverter(), convert = runConverter, read = readFileSync, retryAfterMs = 1_500,
  conversationId = "",
} = {}) {
  const st = hearingStatus({ apiKey, converter });
  if (!st.ok) return { ok: false, unavailable: true, error: st.why };
  if (!url) return { ok: false, error: "it arrived with no link to the audio" };
  // Same rule as a picture's download (src/pictures.js): https only, never this machine's own
  // network. A media_url is a string from a provider, not from the person who sent the note.
  const where = checkUrl(url);
  if (!where.ok) return { ok: false, error: `it could not be downloaded: ${where.why}` };
  // A voice note recorded on Reason Web is kept on this machine (src/webuploads.js): read from disk.
  const local = localUpload(url, { conversationId });
  if (local) fetchImpl = local.fetch;
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
      // Every hop checked, never this machine's own network (src/netguard.js).
      const got = await guardedFetch(url, { fetchImpl, signal: ac.signal, httpsOnly: true });
      if (!got.ok) return { ok: false, error: `it could not be downloaded: ${got.why}` };
      const res = got.res;
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

  // How long it is, when that can be known for free: the WAV this just wrote is 16 kHz mono
  // 16-bit (WAV_AFCONVERT_ARGS), so the byte count IS the duration. A file handed over in its own
  // format is not decoded here, and the length is simply unknown rather than guessed at.
  const seconds = mime === "audio/wav" && converter ? wavSeconds(audio) : null;
  // Timestamps on a long note only. The spec this came from asks for timing to be kept so a
  // specific claim can be checked, and a twelve-second "running late" has nothing to check — the
  // markers would be noise in the middle of what is meant to read as their message. Past the
  // threshold the note is long enough that "where did they say that" is a real question.
  const wantsTimes = seconds !== null && seconds >= config.voiceTimestampAfterSec;
  const body = {
    contents: [{
      parts: [
        {
          text: wantsTimes
            ? "Transcribe exactly what is said in this voice message, word for word, in the language it is spoken in. Put a timestamp in square brackets as [m:ss] at the start of each sentence, taken from where it really falls in the audio. Output only those lines — no speaker labels, no description, no summary. Write [inaudible] for any stretch you cannot make out rather than guessing. If there is no speech at all, output exactly: [no speech]"
            : "Transcribe exactly what is said in this voice message, word for word, in the language it is spoken in. Output only the words — no timestamps, no speaker labels, no description, no summary. Write [inaudible] for any stretch you cannot make out rather than guessing. If there is no speech at all, output exactly: [no speech]",
        },
        { inline_data: { mime_type: mime, data: audio.toString("base64") } },
      ],
    }],
  };
  let used = model;
  const attemptMs = hearAttemptMs(seconds, timeoutMs);
  const started = clock.now();
  const hasOther = !!fallbackModel && fallbackModel !== model;
  // With another model to ask, the first one gets ONE try: busy, over its limit, broken or silent,
  // the other model is the retry, so nobody waits out the same model twice (2026-11-09: a busy big
  // model meant a minute of nothing before the small one was asked). Alone, it keeps its one retry.
  let r = await gemini({ model, apiKey, fetchImpl, base, timeoutMs: attemptMs, retryAfterMs, ...(hasOther ? { noRetry: true } : { retryOnTimeout: true }), body });
  // Somebody else listens only when the trouble is this model's: busy (503), over its own per-model
  // limit (429), a server fault (500), or no answer in time. A bad request would be the same
  // refusal from any model. The fallback is retried once on a 503 and never on a timeout, so the
  // worst case for a short note is two attempts, not four.
  if (!r.ok && hasOther && (r.status === 503 || r.status === 429 || r.status === 500 || r.timed_out)) {
    used = fallbackModel;
    r = await gemini({ model: fallbackModel, apiKey, fetchImpl, base, timeoutMs: attemptMs, retryAfterMs, body });
  }
  const ms = clock.now() - started;
  if (!r.ok) return { ok: false, error: `the audio could not be transcribed: ${r.error}` };
  const said = (r.json?.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").replace(/\s+/g, " ").trim();
  if (!said) return { ok: false, error: "the model that listens returned nothing for it" };
  if (/^\[no speech\]$/i.test(said)) return { ok: true, text: "", silent: true, model: used, ms, ...(seconds === null ? {} : { seconds }) };
  return {
    ok: true, text: said, model: used, ms,
    ...(seconds === null ? {} : { seconds }),
    // Counted rather than judged: the marker is one this asked the transcriber for, so finding it
    // is reading a literal string and not a reading of what anybody meant.
    ...(unclearCount(said) ? { unclear: unclearCount(said) } : {}),
    ...(wantsTimes && /\[\d+:\d{2}\]/.test(said) ? { timestamped: true } : {}),
  };
}

/** A 16 kHz mono 16-bit WAV's length, from its size. 32,000 bytes a second, past a 44-byte header. */
export function wavSeconds(buf, { bytesPerSecond = 32_000 } = {}) {
  const n = Math.max(0, (buf?.length ?? 0) - 44);
  return Math.round((n / bytesPerSecond) * 10) / 10;
}

/** How many stretches the transcriber could not make out. The marker is the one it was asked for. */
export const unclearCount = (text) => (String(text ?? "").match(/\[inaudible\]/gi) ?? []).length;

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

/** A measured length at or under the short-note line. An unknown length is never called short. */
export const isShort = (seconds, under = config.voiceShortSec) => Number(seconds) > 0 && Number(seconds) <= under;

export function heardLine(a, r) {
  const what = a.kind === "voice" ? "a voice note" : `an audio file (${a.filename})`;
  if (r.silent) return `[they sent ${what} with no speech in it — nothing was said]`;
  // The one thing a transcript can tell you about itself: which bits it could not make out. The
  // marker was asked for by name, so it is here as a fact, with the instruction that goes with it —
  // the failure this exists to stop is a plausible word being invented to fill the gap.
  const gaps = r.unclear
    ? ` ${r.unclear === 1 ? "one stretch" : `${r.unclear} stretches`} could not be made out and ${r.unclear === 1 ? "is" : "are"} marked [inaudible]: NEVER fill that in with a word that would fit. If what is missing changes your answer, ask them about that bit specifically ("couldn't catch the word after X — what was it?"); if it does not, answer around it and leave it.`
    : "";
  const times = r.timestamped ? " the times in square brackets are real, from the audio, so you may quote one against something they said." : "";
  // Its length, measured (wavSeconds), when it is short. Nothing here reads the words: whether the
  // note stands on its own is the model's call. 2026-11-01: a 3.3 s note held only "around like
  // 7:30 p.m." — the phone had missed "remind me to take the chicken out" — and the turn took it as
  // the answer to the last open question and set a timer to call somebody else at 7:30.
  const short = isShort(r.seconds)
    ? ` it is only ${r.seconds}s long, and a phone can start recording after the first words are said, so this may be only the end of what they meant. if it does not say on its own what it is about, or could belong to more than one thing in the conversation, ask them what it is for before doing anything with it — above all before anything that reaches another person.`
    : "";
  return `[they sent ${what}. this is what they said in it, transcribed — treat it as their message. a transcript can mishear a name or a number, so check one back if something hangs on it:${times}${gaps}${short} "${r.text}"]`;
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
export async function hearInto(text, attachments = [], { log = () => {}, listen = hear, status = hearingStatus, cover = () => {}, conversationId = "" } = {}) {
  // Already heard before it got here — a Web voice note, transcribed as it was said (the browser's
  // own speech recognition) or when it was sent (src/webmedia.js): the words ARE the message.
  for (const a of attachments.filter(x => isAudio(x) && x.transcribed && x.transcript)) {
    cover(a.media_id, { coverage: "transcribed", seconds: a.seconds ?? null, transcript: a.transcript, detail: a.transcribed === "browser" ? "transcribed in the browser as it was said" : "" });
  }
  const notes = attachments.filter(x => isAudio(x) && !(x.transcribed && x.transcript));
  if (!notes.length) return text;
  if (!status().ok) {
    // Nothing here can listen at all. The adapter's line is already the truth, and the record says
    // so too rather than leaving the note sitting at `waiting` forever.
    for (const a of notes) cover(a.media_id, { coverage: "failed", detail: status().why });
    return text;
  }
  let out = String(text ?? "");
  for (const a of notes) {
    // Written before the request, so the five states the record can be in are all real states and
    // not four plus a gap: `waiting` is a note nothing has started on, `processing` is one being
    // listened to right now, and a row left in it is a crash rather than a shrug.
    cover(a.media_id, { coverage: "processing" });
    let r;
    try { r = await listen({ url: a.url, filename: a.filename, conversationId }); }
    catch (e) { r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    if (!r.ok && r.unavailable) { cover(a.media_id, { coverage: "failed", detail: r.error }); continue; }
    const line = r.ok ? heardLine(a, r) : couldNotHearLine(a, r.error);
    const was = cannotHearLine(a);
    out = out.includes(was) ? out.replace(was, line) : [out, line].filter(Boolean).join("\n");
    cover(a.media_id, r.ok
      ? {
        coverage: r.silent ? "no_speech" : "transcribed",
        seconds: r.seconds ?? null,
        // Kept on the item so a claim out of a note from three days ago can still be checked: the
        // conversation's own history is trimmed, and the words would be gone from it.
        transcript: r.silent ? null : r.text,
        detail: r.unclear ? `${r.unclear} stretch(es) could not be made out` : "",
      }
      : { coverage: "failed", detail: r.error });
    log(r.ok ? { heard: a.filename, chars: r.text.length, model: r.model, ms: r.ms, ...(r.seconds ? { seconds: r.seconds } : {}), ...(r.unclear ? { unclear: r.unclear } : {}) } : { could_not_hear: a.filename, why: r.error });
  }
  return out;
}
