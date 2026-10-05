// Gemini, as the thing that actually takes a video.
//
// Two jobs, both on the same `models/<model>:generateContent` endpoint:
//
//   watchUrl(url)        a YouTube link handed over as a file_data part, no download. Gemini sees
//                        the video, so this is the one case where Reason may honestly say it
//                        watched something.
//   transcribeFile(file) an audio file uploaded through the Files API and transcribed. Audio only,
//                        so nothing visual may be claimed off it. This is the path for video sites
//                        that are not YouTube.
//
// Written from Google's own docs, read 2026-10-05:
//   ai.google.dev/gemini-api/docs/generate-content/video-understanding
//     - POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
//     - key in an `x-goog-api-key` header
//     - a YouTube URL as {"file_data": {"file_uri": "https://www.youtube.com/watch?v=…"}}
//     - a time range as video_metadata.start_offset / end_offset, in seconds-with-an-s
//     - "Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, and 3.5 Flash Lite models support YouTube URLs"
//     - public videos only; max 10 videos per request on 2.5+; free tier capped at 8 hours of
//       YouTube a day; ~100 tokens per second of video at default (low) media resolution
//   ai.google.dev/gemini-api/docs/generate-content/audio
//     - an uploaded file as {"file_data": {"mime_type": "audio/m4a", "file_uri": "<uri>"}}
//     - 9.5 hours of audio per prompt; 32 tokens per second (1 minute = 1,920 tokens)
//     - their own worked example of asking for times: "Provide a transcript of the speech from
//       02:30 to 03:29", which is why the prompts below ask for M:SS
//   ai.google.dev/gemini-api/docs/files
//     - resumable upload: POST ${base}/upload/v1beta/files with X-Goog-Upload-Protocol: resumable,
//       X-Goog-Upload-Command: start, X-Goog-Upload-Header-Content-Length,
//       X-Goog-Upload-Header-Content-Type; the upload URL comes back in the x-goog-upload-url
//       response header; the bytes then go to that URL with X-Goog-Upload-Offset: 0 and
//       X-Goog-Upload-Command: "upload, finalize"
//     - 2 GB a file, kept for 48 hours, and the file carries a `state` that has to reach ACTIVE
//
// NOTHING HERE HAS EVER RUN AGAINST GOOGLE. There is no GEMINI_API_KEY in this process's
// environment, so every path below has only ever answered an injected fetch. docs/unverified.md
// says so, test by test.
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { config } from "./config.js";

/** The audio types Gemini's docs list, by the extension yt-dlp hands back. */
const AUDIO_MIME = {
  ".m4a": "audio/m4a", ".mp3": "audio/mp3", ".mpga": "audio/mpeg", ".mpeg": "audio/mpeg",
  ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg", ".opus": "audio/opus",
  ".flac": "audio/flac", ".aac": "audio/aac", ".aiff": "audio/aiff",
};
export const audioMimeFor = (file) => AUDIO_MIME[extname(file).toLowerCase()] ?? null;

/** Is Gemini connected, and what is missing if not? Asked by the capabilities tool every turn. */
export function geminiStatus({ apiKey = config.geminiKey, model = config.videoModel } = {}) {
  if (apiKey) return { connected: true, provider: "gemini", what: "Google's Gemini", model };
  return {
    connected: false,
    provider: "gemini",
    missing: ["GEMINI_API_KEY"],
    why: "No video model is connected, so nothing can watch a video or listen to its audio. "
      + "That means a video with no captions cannot be read at all, and the picture can never be described. Connecting it needs GEMINI_API_KEY.",
  };
}

// What to ask for. Both prompts insist on real times, because a timestamped account is the whole
// point — an answer with no clock against it cannot be checked or quoted.
const TIMES = "Put a timestamp in [M:SS] form (or [H:MM:SS] past an hour) at the start of every line, taken from the video's own clock. Never invent a time; if you are unsure of one, say so rather than guessing.";

function watchPrompt(question) {
  return [
    "Give a faithful account of this video, in order, as timestamped lines.",
    TIMES,
    "Cover what is SAID and what is SHOWN — speech, on-screen text, what is being demonstrated, what appears.",
    "Do not summarise it away: someone who cannot see this video should be able to follow what happens from your lines alone.",
    "Then, if it recommends anything, lists steps, or gives numbers or names, set those out separately with their timestamps.",
    question ? `Finally, answer this in its own paragraph, from the video only: "${question}". If the video does not cover it, say so plainly.` : "",
    "Say plainly if any stretch was unclear or inaudible rather than filling it in.",
  ].filter(Boolean).join(" ");
}

function listenPrompt(question) {
  return [
    "Transcribe this audio faithfully as timestamped lines.",
    TIMES,
    "This is AUDIO ONLY — you have no picture. Do not describe anything visual, do not guess at what is on screen, and do not say what anybody looks like.",
    "Keep what is actually said rather than summarising it, and mark a speaker change when you can hear one.",
    question ? `After the transcript, answer this in its own paragraph, from the audio only: "${question}". If it is not covered, say so plainly.` : "",
    "Say plainly if any stretch was inaudible rather than filling it in.",
  ].filter(Boolean).join(" ");
}

/** Seconds → the "60s" form the docs use for start_offset / end_offset. */
const offset = (s) => `${Math.floor(s)}s`;

function videoMetadata(from, to) {
  if (from === null && to === null) return null;
  return {
    ...(from !== null ? { start_offset: offset(from) } : {}),
    ...(to !== null ? { end_offset: offset(to) } : {}),
  };
}

/**
 * A provider with the two methods src/video.js calls. Everything injectable, so the tests exercise
 * the real request building and response parsing without a key and without the network.
 */
export function geminiProvider({
  apiKey = config.geminiKey,
  model = config.videoModel,
  base = config.geminiBase,
  fetchImpl = fetch,
  timeoutMs = config.videoModelTimeoutMs,
  pollMs = config.geminiFilePollMs,
  maxPolls = config.geminiFileMaxPolls,
} = {}) {
  const headers = { "x-goog-api-key": apiKey };

  async function withTimeout(fn) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try { return await fn(ac.signal); } finally { clearTimeout(timer); }
  }

  /** One generateContent call, and the text it came back with. */
  async function generate(parts, { signal }) {
    const res = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal,
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Gemini refused: ${res.status} ${res.statusText}. ${body.slice(0, 300)}` };
    }
    let json;
    try { json = JSON.parse(body); } catch { return { ok: false, error: "Gemini answered with something that was not JSON." }; }
    const text = (json?.candidates?.[0]?.content?.parts ?? []).map(p => p?.text).filter(Boolean).join("\n").trim();
    if (!text) {
      const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "it returned no text";
      return { ok: false, error: `Gemini came back with nothing: ${why}.` };
    }
    return { ok: true, text, usage: json?.usageMetadata ?? undefined };
  }

  return {
    name: "gemini",
    model,

    /**
     * A YouTube URL, handed straight over. Gemini fetches it itself, so nothing is downloaded here
     * and nothing lands on disk. Public videos only — the docs are explicit that a private or
     * unlisted video is not readable this way either.
     */
    async watchUrl(url, { question = "", from = null, to = null } = {}) {
      if (!apiKey) return { ok: false, ...geminiStatus({ apiKey, model }) };
      const part = { file_data: { file_uri: url } };
      const vm = videoMetadata(from, to);
      if (vm) part.video_metadata = vm;
      try {
        const out = await withTimeout(signal => generate([{ text: watchPrompt(question) }, part], { signal }));
        return out.ok ? { ...out, model, saw: "video" } : out;
      } catch (e) {
        return { ok: false, error: reachError(e, timeoutMs) };
      }
    },

    /**
     * An audio file: uploaded through the Files API, waited for, then transcribed.
     *
     * The upload is the documented two-step resumable one — there is no single-request REST form in
     * their docs, so this does not invent one. The file carries a `state`, and a file that is still
     * PROCESSING cannot be used, so it is polled until ACTIVE rather than hoped at.
     */
    async transcribeFile(file, { question = "", mime = null } = {}) {
      if (!apiKey) return { ok: false, ...geminiStatus({ apiKey, model }) };
      const type = mime ?? audioMimeFor(file);
      if (!type) {
        return { ok: false, error: `Gemini does not take ${extname(file) || "that"} audio. Their list is wav, mp3, aiff, aac, ogg, flac, mpeg, m4a, opus and webm.` };
      }
      let bytes, buf;
      try { bytes = statSync(file).size; buf = readFileSync(file); } catch { return { ok: false, error: `The audio file ${file} is not there.` }; }

      try {
        return await withTimeout(async (signal) => {
          // 1. start a resumable upload and take the URL off the response header
          const start = await fetchImpl(`${base}/upload/v1beta/files`, {
            method: "POST", signal,
            headers: {
              ...headers,
              "X-Goog-Upload-Protocol": "resumable",
              "X-Goog-Upload-Command": "start",
              "X-Goog-Upload-Header-Content-Length": String(bytes),
              "X-Goog-Upload-Header-Content-Type": type,
              "content-type": "application/json",
            },
            body: JSON.stringify({ file: { display_name: basename(file) } }),
          });
          if (!start.ok) return { ok: false, error: `Gemini would not start the upload: ${start.status} ${start.statusText}.` };
          const uploadUrl = start.headers?.get?.("x-goog-upload-url");
          if (!uploadUrl) return { ok: false, error: "Gemini accepted the upload request but gave no upload URL back." };

          // 2. send the bytes and finalize
          const sent = await fetchImpl(uploadUrl, {
            method: "POST", signal,
            headers: { ...headers, "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "content-length": String(bytes) },
            body: buf,
          });
          const sentBody = await sent.text();
          if (!sent.ok) return { ok: false, error: `The audio upload failed: ${sent.status} ${sent.statusText}. ${sentBody.slice(0, 200)}` };
          let uploaded;
          try { uploaded = JSON.parse(sentBody)?.file; } catch { uploaded = null; }
          if (!uploaded?.uri) return { ok: false, error: "The audio uploaded but Gemini returned no file uri for it." };

          // 3. a file that is still PROCESSING cannot be used in a prompt
          let state = uploaded.state;
          for (let i = 0; state === "PROCESSING" && i < maxPolls; i++) {
            await new Promise(r => setTimeout(r, pollMs));
            const look = await fetchImpl(`${base}/v1beta/${uploaded.name}`, { headers, signal });
            if (!look.ok) break;
            try { state = JSON.parse(await look.text())?.state ?? state; } catch { break; }
          }
          if (state === "FAILED") return { ok: false, error: "Gemini could not process that audio file." };
          if (state === "PROCESSING") return { ok: false, error: `Gemini was still processing that audio after ${Math.round(maxPolls * pollMs / 1000)}s, so it has not been transcribed.` };

          const out = await generate([{ text: listenPrompt(question) }, { file_data: { mime_type: type, file_uri: uploaded.uri } }], { signal });
          return out.ok ? { ...out, model, saw: "audio", uploaded_bytes: bytes } : out;
        });
      } catch (e) {
        return { ok: false, error: reachError(e, timeoutMs) };
      }
    },
  };
}

function reachError(e, timeoutMs) {
  const why = e.name === "AbortError" ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : e.message;
  return `Could not reach Gemini: ${why}.`;
}

/** The provider that actually runs, or null when nothing can. */
export function videoModelFor({ status = geminiStatus(), ...rest } = {}) {
  return status.connected ? geminiProvider({ model: status.model, ...rest }) : null;
}
