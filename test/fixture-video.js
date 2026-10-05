// A yt-dlp that never leaves the machine.
//
// src/video.js takes its `run` as an argument for exactly this: the real parsing, the real track
// picking, the real trimming and the real error wording all run here, against caption files that
// came off YouTube once and now sit in test/fixtures/video. No network, no binary, no key.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "video");

export const fixture = (name) => readFileSync(join(HERE, name), "utf8");
export const meta = (name) => JSON.parse(fixture(name));

/**
 * Three hours of captions, one line every three seconds — the shape of a conference recording,
 * which is the case where something has to be left out.
 */
export function longCaptions({ seconds = 10_800, every = 3 } = {}) {
  const at = (t) => {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000`;
  };
  const out = ["WEBVTT", "Kind: captions", "Language: en", ""];
  for (let t = 0; t + every <= seconds; t += every) {
    out.push(`${at(t)} --> ${at(t + every)}`, `line at ${at(t)}, and here is some more of what the speaker said.`, "");
  }
  return out.join("\n");
}

/**
 * A fake yt-dlp. `videos` maps a URL to what that video is:
 *   { meta }                  the -J metadata
 *   { captions: { en: "…" } } the caption files it will write, by language
 *   { audio: true }           it will write the tiny fixture audio file when asked for the audio
 *   { metaError: "…" }        stderr from the metadata call (private, age-gated, unsupported…)
 *   { captionError: "…" }     stderr from the caption call
 *   { audioError: "…" }       stderr from the audio call
 * A URL that is not in the map comes back the way yt-dlp reports one it cannot handle.
 *
 * `run.calls` is every argument list, so a test can prove the audio call carried `-f bestaudio…` and
 * never asked for a video stream — and that a cached transcript made no call at all.
 */
export function fakeYtDlp(videos) {
  const calls = [];
  const run = async (args, { cwd } = {}) => {
    calls.push(args);
    const url = args.at(-1);
    const v = videos[url];
    if (!v) return { ok: false, code: 1, stdout: "", stderr: `ERROR: Unsupported URL: ${url}` };

    if (args.includes("-J")) {
      if (v.metaError) return { ok: false, code: 1, stdout: "", stderr: v.metaError };
      return { ok: true, code: 0, stdout: JSON.stringify(v.meta ?? {}), stderr: "" };
    }

    // The audio call is the one without --skip-download. The real one downloads a ready-made audio
    // stream; this one copies the tiny WAV fixture into the same scratch directory.
    if (!args.includes("--skip-download")) {
      if (v.audioError) return { ok: false, code: 1, stdout: "", stderr: v.audioError };
      if (!v.audio) return { ok: false, code: 1, stdout: "", stderr: `ERROR: Requested format is not available` };
      writeFileSync(join(cwd, "audio.wav"), readFileSync(join(HERE, "tiny.wav")));
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }

    if (v.captionError) return { ok: false, code: 1, stdout: "", stderr: v.captionError };
    const lang = args[args.indexOf("--sub-langs") + 1];
    const text = v.captions?.[lang];
    if (text === undefined) return { ok: false, code: 1, stdout: "", stderr: `ERROR: Unable to download video subtitles for '${lang}'` };
    writeFileSync(join(cwd, `cap.${lang}.vtt`), text);
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

/**
 * A Transcriber that never leaves the machine.
 *
 * It records every file it was handed and whether that file still existed when it was called, which
 * is what lets a test prove the audio really was downloaded and really was deleted afterwards.
 */
export function fakeTranscriber({ cues = null, error = "", model = "fake-whisper", language = "en" } = {}) {
  const seen = [];
  const t = async (file) => {
    seen.push({ file, existed: existsSync(file), bytes: existsSync(file) ? statSync(file).size : 0 });
    if (error) return { ok: false, error };
    return {
      ok: true, model, language,
      cues: cues ?? [
        { at: 0, text: "Right, so the first thing is the junction box." },
        { at: 12.5, text: "You want the weatherproof one, not the indoor one." },
        { at: 41, text: "And that is it — tighten it up and you are done." },
      ],
    };
  };
  t.seen = seen;
  return t;
}

/** The status object a connected transcriber would report, for tests that inject one. */
export const CONNECTED = { connected: true, provider: "fake", what: "a fake transcriber", model: "fake-whisper", limitBytes: 25 * 1024 * 1024 };
