// Turning an audio file into timestamped words.
//
// This is the thing behind Reason's listen tier: when a video has no captions, Reason gets its audio
// track and has it transcribed, so what comes back is the same shape as a caption file — lines with a
// real clock time against each one. A transcript made this way is still only words. Nothing here
// looks at a picture, and src/video.js is careful to say so.
//
// One interface, three implementations: a fake for the tests, OpenAI's speech-to-text for real, and
// a local one that is documented and deliberately not installed (see LOCAL_NOTE).
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { config } from "./config.js";

/**
 * @typedef {{at: number, text: string}} Cue
 * @typedef {(file: string, opts?: object) => Promise<{ok: boolean, cues?: Cue[], language?: string, model?: string, seconds?: number, error?: string}>} Transcriber
 */

// What every implementation has to say about itself before it is used, so the tool can report
// "listening is not connected" with the actual missing thing named rather than a shrug.
const PROVIDERS = {
  openai: {
    env: "OPENAI_API_KEY",
    // whisper-1 rather than the newer transcription models: it is the one whose documented
    // response_format returns per-segment start times, and timestamps are the whole point here.
    // $0.006 per minute of audio as of 2026-10-05.
    defaultModel: "whisper-1",
    limitBytes: 25 * 1024 * 1024,
    what: "OpenAI's speech-to-text",
  },
  local: {
    env: null,
    defaultModel: "whisper-large-v3",
    limitBytes: Infinity,
    what: "a local Whisper on this machine",
  },
};

/**
 * Running Whisper locally on this machine, written down rather than installed.
 *
 * It is feasible: this is an Apple-silicon Mac, and `mlx-whisper` runs on the GPU through MLX. It
 * would go in its own virtual environment, the way yt-dlp did, since the system python is managed
 * and refuses installs. Two things stop it being switched on quietly:
 *
 *   - the model is a real download. large-v3 is about 1.5 GB; `tiny` is about 150 MB and noticeably
 *     worse at names and numbers, which is exactly what a transcript gets quoted for.
 *   - it wants plain audio, so turning a downloaded .m4a into 16 kHz PCM needs **ffmpeg**, which is
 *     not on this machine either. The hosted path does not need ffmpeg, because the audio stream is
 *     uploaded exactly as YouTube served it.
 *
 * So this is left as a documented option. Whoever turns it on should expect to install ffmpeg
 * (`pip install imageio-ffmpeg` ships a prebuilt binary, no Homebrew needed) and a model, and should
 * be told that is happening. Until then `transcriberStatus()` reports it as not installed.
 */
export const LOCAL_NOTE =
  "A local Whisper would work on this Mac (Apple silicon, so mlx-whisper in its own virtualenv), but it needs "
  + "a model download of roughly 1.5 GB for large-v3 and it needs ffmpeg to turn the downloaded audio into PCM. "
  + "Neither is installed, and neither should be installed without saying so. See LOCAL_NOTE in src/transcribe.js.";

/**
 * Which transcriber is actually available, and what is missing if none is.
 *
 * `REASON_TRANSCRIBER` picks one explicitly; left alone it is OpenAI when there is a key and nothing
 * otherwise. There is no "it'll probably work" state: either something can transcribe audio right
 * now or the tool says listening is not connected.
 */
export function transcriberStatus({
  choice = config.transcriber,
  openaiKey = config.openaiKey,
  model = config.transcribeModel,
} = {}) {
  const want = choice || (openaiKey ? "openai" : "none");

  if (want === "openai") {
    const p = PROVIDERS.openai;
    if (!openaiKey) {
      return {
        connected: false, provider: "openai", missing: [p.env],
        why: `Reason cannot listen to a video: transcribing its audio needs ${p.env}, which this machine does not have. So a video with no captions cannot be read at all.`,
      };
    }
    return {
      connected: true, provider: "openai", what: p.what,
      model: model || p.defaultModel,
      limitBytes: p.limitBytes,
      limitNote: `${p.what} takes an audio file up to 25 MB. Splitting a bigger one needs ffmpeg, which is not on this machine, so an over-size file is reported rather than part-transcribed.`,
    };
  }

  if (want === "local") {
    return { connected: false, provider: "local", missing: ["a local Whisper model", "ffmpeg"], why: LOCAL_NOTE };
  }

  return {
    connected: false, provider: "none", missing: [PROVIDERS.openai.env],
    why: `No speech-to-text is connected, so Reason cannot listen to a video. A video with no captions cannot be read at all. Connecting it needs ${PROVIDERS.openai.env}. ${LOCAL_NOTE}`,
  };
}

// The content types OpenAI's endpoint accepts, by the extension yt-dlp hands back. m4a is what
// YouTube's audio-only format 140 is, and it is on their list, which is why no conversion is needed.
const MIME = {
  ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".mpga": "audio/mpeg",
  ".webm": "audio/webm", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg",
  ".flac": "audio/flac",
};

/**
 * OpenAI's speech-to-text, from developers.openai.com/api/docs/guides/speech-to-text as of
 * 2026-10-05: multipart POST to /v1/audio/transcriptions with `file` and `model`, the key as a
 * Bearer token, 25 MB per file, and `response_format=verbose_json` on `whisper-1` to get `segments`
 * with `start`, `end` and `text` — which is what makes this interchangeable with a caption file.
 *
 * NEVER RUN. There is no OPENAI_API_KEY on this machine, so this has only ever answered an injected
 * fetch. docs/unverified.md says so.
 */
export function openaiTranscriber({
  apiKey = config.openaiKey,
  model = config.transcribeModel || PROVIDERS.openai.defaultModel,
  base = config.openaiBase,
  fetchImpl = fetch,
  timeoutMs = config.transcribeTimeoutMs,
} = {}) {
  const limitBytes = PROVIDERS.openai.limitBytes;

  return async function transcribe(file, { language = "" } = {}) {
    if (!apiKey) return { ok: false, error: `Transcribing needs OPENAI_API_KEY, which is not set.`, missing: ["OPENAI_API_KEY"] };

    let bytes;
    try { bytes = statSync(file).size; } catch { return { ok: false, error: `The audio file ${file} is not there.` }; }
    if (bytes > limitBytes) {
      return {
        ok: false, too_big: true,
        error: `That audio is ${Math.round(bytes / 1024 / 1024)} MB and the limit is 25 MB. Splitting it into pieces needs ffmpeg, which is not on this machine, so it cannot be transcribed here. Say that rather than transcribing part of it.`,
      };
    }

    const ext = extname(file).toLowerCase();
    const form = new FormData();
    form.append("file", new File([readFileSync(file)], basename(file), { type: MIME[ext] ?? "application/octet-stream" }));
    form.append("model", model);
    // verbose_json is what carries the per-segment start times. Without it this returns one wall of
    // text, which would make the listen tier useless for "what does he say at 14:02".
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (language) form.append("language", language);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
        method: "POST", signal: ac.signal,
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, error: `The transcriber refused: ${res.status} ${res.statusText}. ${body.slice(0, 300)}` };

      let json;
      try { json = JSON.parse(body); } catch { return { ok: false, error: "The transcriber answered with something that was not JSON." }; }

      const cues = (json.segments ?? [])
        .map(s => ({ at: Number(s.start) || 0, text: String(s.text ?? "").trim() }))
        .filter(c => c.text);
      // No segments but some text: still honest, just with no clock to hang it on. One cue at 0 is
      // better than silently dropping the words, and `covers` will show it.
      if (!cues.length && String(json.text ?? "").trim()) {
        return { ok: true, cues: [{ at: 0, text: String(json.text).trim() }], no_timestamps: true, language: json.language, model, seconds: json.duration };
      }
      if (!cues.length) return { ok: false, error: "The transcriber heard nothing in that audio." };

      return { ok: true, cues, language: json.language || language || undefined, model, seconds: json.duration ?? undefined };
    } catch (e) {
      const why = e.name === "AbortError" ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : e.message;
      return { ok: false, error: `Could not reach the transcriber: ${why}.` };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The one that actually runs, or null when nothing can. */
export function transcriberFor({ status = transcriberStatus(), ...rest } = {}) {
  if (!status.connected) return null;
  if (status.provider === "openai") return openaiTranscriber({ model: status.model, ...rest });
  return null;
}
