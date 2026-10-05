// Going to a video and finding out what is in it, in two tiers — and the result always says which
// one answered.
//
// Tier 1, the captions tier: yt-dlp hands back the video's own metadata and whatever captions it
// already has, creator-written when there are any and auto-generated otherwise. Free, so it answers
// whenever it can.
//
// Tier 2, the model tier: a model that takes the video itself (src/gemini.js). It splits in two,
// because what Reason may then claim differs:
//
//   - a YOUTUBE link goes straight to Gemini, which fetches and watches the video. Nothing is
//     downloaded here. This is the one case where Reason may honestly say it WATCHED something, and
//     the receipt records which model did the watching.
//   - ANY OTHER SITE: Gemini takes uploaded audio, not an arbitrary page, so Reason gets the AUDIO
//     TRACK ONLY with yt-dlp, uploads that, and has it transcribed. Audio means no picture, so
//     nothing visual may be claimed off it — the result says "listened to the audio".
//
// Tier 2 runs when there are no usable captions, when the owner wants the video actually watched or
// listened to, or when the question is about something only in the picture. It costs money per
// minute, so there is a length cap and every account it produces is cached by video and tier.
//
// The audio file lives in a scratch directory under the data dir and is deleted the moment the
// transcript is stored. The video stream is never downloaded, and `--extract-audio` is never used,
// so ffmpeg is not needed; where it would be needed, the result says so.
//
// Nothing here works around an age gate, a login, a paywall or a region block; those come back as
// the reason the video could not be read.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { config } from "./config.js";
import * as db from "./db.js";
import { audioMimeFor, geminiStatus, videoModelFor } from "./gemini.js";
import { transcriberFor, transcriberStatus } from "./transcribe.js";

// ---------------------------------------------------------------------------
// Is the tool even here?
// ---------------------------------------------------------------------------

// yt-dlp is an ordinary program on the PATH, not a library, so it can simply be absent. It is what
// both tiers rest on — the metadata, the captions and the audio track all come through it — so with
// it missing there is nothing Reason can find out about any video. The capabilities tool asks this
// every turn, so the answer is found without spawning anything and cached: a PATH scan, which is
// what a shell would do.
let found;
export function findYtDlp({ recheck = false } = {}) {
  if (found !== undefined && !recheck) return found;
  const named = process.env.REASON_YTDLP_BIN;
  if (named) { found = existsSync(named) ? named : null; return found; }
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  found = dirs.map(d => join(d, "yt-dlp")).find(p => existsSync(p)) ?? null;
  return found;
}

/** Can anything about a video be found out on this machine at all? */
export function ytDlpStatus({ bin = findYtDlp() } = {}) {
  if (bin) return { ok: true, bin };
  return {
    ok: false,
    missing: ["yt-dlp"],
    error: "yt-dlp is not installed on this machine, and it is what gets at a video — its details, its captions and its audio. "
      + "Reason cannot read or listen to any video until it is there. Say that plainly rather than guessing at what a video says.",
  };
}

/**
 * What the capabilities tool says about video, which is the honest join of two separate things.
 *
 * yt-dlp gets at the video; a video model is what can take it. The wording is careful about which
 * of three things is on offer, because they are different claims: reading captions and transcribing
 * audio give words only, and only a YouTube link handed to the model gets the picture.
 */
export function videoCapability({ tool = ytDlpStatus(), model = geminiStatus() } = {}) {
  if (!tool.ok) {
    return {
      status: "not connected",
      what: "Reason cannot get at any video on this machine: yt-dlp is not installed, and it is what fetches a video's details, its captions and its audio. Do not offer to.",
    };
  }
  if (model.connected) {
    return {
      status: "live",
      what: "go to a video and find out what is in it: title, channel, length, description, chapters, and what is in it as timestamped lines. "
        + "It reads the captions when the video has them, which is free and covers most asks. "
        + `When there are none, or when the picture is the point, ${model.what} takes the video itself: a YouTube link it genuinely WATCHES — picture and sound, so what was on screen can be described — and on any other site Reason pulls the AUDIO TRACK ONLY and has that transcribed, which is words with no picture. `
        + `Up to ${config.videoMaxMinutes} minutes a video, and the result says which of the three it did, every time`,
    };
  }
  return {
    status: "live",
    what: "go to a video (YouTube and many other sites) and read its captions: title, channel, length, description, chapters, and what is said as timestamped lines, creator-written when there are any and auto-generated otherwise. "
      + "That is words only: nothing looks at the picture, so you can never say what was on screen, who was in shot or what a chart or a demo showed. "
      + `A video with NO captions cannot be read at all, and the picture can never be described, because both need a video model this machine is not connected to (${model.missing.join(", ")}). `
      + "An age gate, a login or a region block is reported rather than worked around",
  };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * One yt-dlp invocation. Injectable: every caller takes `run`, so the tests drive the real parsing,
 * trimming and caching against fixture captions and a fixture audio file, with no network.
 *
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string}>}
 */
export function runYtDlp(args, { cwd, timeoutMs = 60_000, bin = findYtDlp() } = {}) {
  if (!bin) return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "yt-dlp is not installed" });
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? (err ? 1 : 0),
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") + (err && err.killed ? `\nyt-dlp was still running after ${timeoutMs / 1000}s and was stopped.` : ""),
      });
    });
  });
}

// The flags for the two read-only calls. --skip-download: these fetch text about the video and
// nothing else. The audio call below deliberately does not use this list.
const BASE = ["--skip-download", "--no-playlist", "--no-warnings", "--socket-timeout", "20"];

/** Metadata only. Cannot fail on a caption track, so what came back about the video survives. */
async function probe(url, { run, timeoutMs }) {
  const r = await run([...BASE, "-J", url], { timeoutMs });
  if (!r.ok) return { ok: false, ...reason(r.stderr, url) };
  let meta;
  try { meta = JSON.parse(r.stdout); } catch { meta = null; }
  if (!meta || typeof meta !== "object") {
    return { ok: false, error: `yt-dlp read ${url} but returned nothing usable about it.` };
  }
  if (meta._type === "playlist") {
    return { ok: false, error: `${url} is a playlist or a channel, not one video. Point at a single video.` };
  }
  return { ok: true, meta };
}

/**
 * One caption track, written to a scratch directory and read back.
 *
 * Fetched in a second invocation, with exactly one language asked for, because `--sub-langs en.*`
 * asks YouTube for every auto-translation of English at once and gets rate-limited — which then
 * fails the whole call, metadata included.
 */
async function captions(url, { lang, auto, run, timeoutMs }) {
  const dir = mkdtempSync(join(scratchRoot(), "caps-"));
  try {
    const r = await run([
      ...BASE, "--no-simulate",
      auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs", lang, "--sub-format", "vtt/best",
      "-o", "cap.%(ext)s", url,
    ], { cwd: dir, timeoutMs });
    const file = readdirSync(dir).find(f => f.endsWith(".vtt")) ?? readdirSync(dir).find(f => /\.(srt|srv\d|json3?)$/.test(f));
    if (!file) return { ok: false, ...reason(r.stderr, url) };
    return { ok: true, text: readFileSync(join(dir, file), "utf8"), file };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The audio track, and nothing else.
 *
 * `-f bestaudio[...]` picks a stream that is already a single audio file — YouTube's format 140 is a
 * 128 kbps .m4a, about a megabyte a minute — so there is no re-encoding and **ffmpeg is not needed**.
 * That matters: `--extract-audio` would need it, and this machine does not have it. The video stream
 * is never asked for, and the file is deleted by the caller as soon as its transcript is stored.
 */
async function audioOnly(url, { dir, run, timeoutMs }) {
  const r = await run([
    "--no-playlist", "--no-warnings", "--socket-timeout", "20",
    "-f", config.audioFormat,
    "-o", "audio.%(ext)s", url,
  ], { cwd: dir, timeoutMs });
  const file = readdirSync(dir).find(f => f.startsWith("audio."));
  if (!file) return { ok: false, ...reason(r.stderr, url) };
  const full = join(dir, file);
  return { ok: true, file: full, bytes: statSync(full).size };
}

/** Where scratch audio and caption files go: under the data dir, so a container mounts one volume. */
function scratchRoot() {
  const dir = resolve(config.audioTmpRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * What yt-dlp's complaint actually means, in words Reason can say.
 *
 * An age gate, a login, a paywall and a region block are reported as the reason the video could not
 * be read. None of them is worked around, and none of them is softened into "I'll try again".
 *
 * The field is `cannot`, not `blocked`: the ledger already uses `blocked` to mean "the confirm gate
 * stopped this", and a video being age-restricted is not that.
 */
function reason(stderr, url) {
  const s = String(stderr || "").replace(/\s+/g, " ").trim();
  const hit = (re) => re.test(s);
  if (hit(/Sign in to confirm your age|age.?restricted|inappropriate for some users/i)) {
    return { error: `${url} is age-restricted, so it will only play to a signed-in account. Reason does not sign in to get round that, so it cannot read this one.`, cannot: "age_gate" };
  }
  if (hit(/Private video|This video is private/i)) {
    return { error: `${url} is a private video. Only its owner can see it, so there is nothing Reason can read.`, cannot: "private" };
  }
  if (hit(/members.?only|join this channel|available to this channel's members/i)) {
    return { error: `${url} is members-only — it is behind a paid channel membership. Reason does not get round that.`, cannot: "paywall" };
  }
  if (hit(/available in your country|available in your location|geo.?restrict|blocked it on copyright/i)) {
    return { error: `${url} is blocked in this country, so Reason cannot reach it from here.`, cannot: "region" };
  }
  if (hit(/Sign in to confirm|not a bot|--cookies/i)) {
    return { error: `${url} asked Reason to sign in and prove it is not a bot, so it could not be read. Reason does not sign in to get round that.`, cannot: "login" };
  }
  if (hit(/Unsupported URL/i)) {
    return { error: `${url} is not a video page — nothing there is a video Reason knows how to read. If it is an ordinary web page, read it with web_lookup instead.`, cannot: "not_a_video" };
  }
  if (hit(/video (is )?unavailable|has been removed|no longer available|does not exist|HTTP Error 404/i)) {
    return { error: `${url} is not there any more — it has been removed or was never public.`, cannot: "gone" };
  }
  return { error: `yt-dlp could not read ${url}${s ? `: ${s.slice(0, 300)}` : "."}` };
}

// ---------------------------------------------------------------------------
// Captions in, timestamped lines out
// ---------------------------------------------------------------------------

const CUE = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

/** "1:02:03.456" → seconds. */
function secs(h, m, s, ms) { return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000; }

/**
 * WebVTT (and SRT) to `[{at, text}]`.
 *
 * YouTube's auto-captions roll: each cue repeats the line before it so the words crawl up the
 * screen, and every word carries its own `<00:00:19.039><c>` timing tag. Pasted into a prompt raw,
 * a three-minute video becomes six pages of the same sentence. So inline tags go, cue settings go,
 * and a line that has just been emitted is not emitted again.
 */
export function parseCaptions(text) {
  const out = [];
  const recent = [];
  for (const block of String(text ?? "").replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const i = lines.findIndex(l => CUE.test(l));
    if (i < 0) continue;
    const m = CUE.exec(lines[i]);
    const at = secs(m[1], m[2], m[3], m[4]);
    for (const raw of lines.slice(i + 1)) {
      const line = raw
        .replace(/<[^>]*>/g, "")                     // <c>, </c>, per-word <00:00:19.039>
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      if (!line) continue;
      if (recent.includes(line)) continue;           // the rolling repeat
      recent.push(line);
      if (recent.length > 4) recent.shift();
      out.push({ at, text: line });
    }
  }
  return out;
}

/** Seconds → "4:31" or "1:04:31", which is how a person reads a video clock. */
export function timecode(s) {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** "12:34", "1:02:03", "90", "90s", "1h2m" → seconds, or null if it is not a time. */
export function parseTime(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, v) : null;
  const s = String(v).trim().toLowerCase();
  const colon = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (colon) {
    return colon[3] !== undefined
      ? Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3])
      : Number(colon[1]) * 60 + Number(colon[2]);
  }
  const units = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(s);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0);
  }
  const plain = /^(\d+(?:\.\d+)?)s?$/.exec(s);
  return plain ? Number(plain[1]) : null;
}

/**
 * Timestamped lines, trimmed to a budget — and never quietly.
 *
 * A three-hour talk is half a million characters of captions. Something has to go, and the one
 * thing that must not happen is the model answering "what does it say at 2:40" out of a transcript
 * that silently stopped at 20 minutes. So what was kept and what was dropped both come back as
 * real numbers, with the follow-up spelled out: ask again with from/to.
 */
export function layOutTranscript(cues, { from = null, to = null, maxChars = config.videoTranscriptChars } = {}) {
  const asked = cues.filter(c => (from === null || c.at >= from) && (to === null || c.at <= to));
  const lines = asked.map(c => `[${timecode(c.at)}] ${c.text}`);
  const window = (from !== null || to !== null)
    ? { from: from ?? 0, to: to ?? (cues.at(-1)?.at ?? 0) }
    : null;

  let used = 0, kept = 0;
  for (const l of lines) {
    if (used + l.length + 1 > maxChars) break;
    used += l.length + 1; kept++;
  }
  if (kept >= lines.length) {
    return {
      transcript: lines.join("\n"),
      lines: lines.length,
      covers: asked.length ? `${timecode(asked[0].at)}–${timecode(asked.at(-1).at)}` : null,
      window, trimmed: null,
    };
  }
  const cutFrom = asked[kept]?.at ?? 0;
  const cutTo = asked.at(-1)?.at ?? 0;
  return {
    transcript: lines.slice(0, kept).join("\n"),
    lines: kept,
    covers: kept ? `${timecode(asked[0].at)}–${timecode(asked[kept - 1].at)}` : null,
    window,
    trimmed: {
      dropped_lines: lines.length - kept,
      missing: `${timecode(cutFrom)}–${timecode(cutTo)}`,
      note: `This transcript is cut short. You have ${timecode(asked[0]?.at ?? 0)}–${timecode(asked[kept - 1]?.at ?? 0)} and NOT ${timecode(cutFrom)}–${timecode(cutTo)}. `
        + `Do not say anything about the part you do not have. To read it, call video_understand again on the same url with from and to set to the stretch you want (e.g. from "${timecode(cutFrom)}", to "${timecode(Math.min(cutTo, cutFrom + 1800))}").`,
    },
  };
}

// ---------------------------------------------------------------------------
// Which caption track
// ---------------------------------------------------------------------------

/**
 * Creator captions first, auto-generated otherwise.
 *
 * A creator wrote theirs, so it has punctuation, names spelled right and no mishearings. An
 * auto-generated track is a machine's guess at the audio, and when it is a machine's guess at a
 * translation of a machine's guess at the audio, that is worth saying out loud rather than passing
 * off as what somebody said.
 */
export function pickTrack(meta, want = "en") {
  const creator = meta?.subtitles ?? {};
  const auto = meta?.automatic_captions ?? {};
  const w = String(want || "en").toLowerCase();
  const inFamily = (map) => Object.keys(map).find(k => k.toLowerCase() === w)
    ?? Object.keys(map).find(k => k.toLowerCase().startsWith(`${w}-`));

  const c = inFamily(creator);
  if (c) return { lang: c, source: "creator" };

  const a = inFamily(auto) ?? (auto[`${w}-orig`] ? `${w}-orig` : undefined);
  if (a) {
    const spoken = String(meta?.language ?? "").toLowerCase();
    const translated = !!spoken && !spoken.startsWith(w) && !a.endsWith("-orig");
    return { lang: a, source: translated ? "auto_translated" : "auto", spoken: spoken || undefined };
  }
  // No English at all. Something in another language beats nothing, as long as it says so.
  const other = Object.keys(creator)[0];
  if (other) return { lang: other, source: "creator", not_english: true };
  const otherAuto = Object.keys(auto)[0];
  if (otherAuto) return { lang: otherAuto, source: "auto", not_english: true };
  return null;
}

const SOURCE_WORDS = {
  creator: "captions the creator wrote",
  auto: "auto-generated captions (a machine's transcription of the audio, so names and numbers can be wrong)",
  auto_translated: "auto-translated captions (a machine translated a machine's transcription, so treat the wording as approximate and never quote it as what somebody said)",
};

// The sentence that is on every successful result, because it is the one thing the model must not
// get wrong. Both tiers produce words; neither has seen anything.
const BLIND = " You have the words and nothing else: nothing watched this video, so you do not know what was on screen, who was in shot, what anything looked like, or what any chart or demo showed. Never say \"watched\" or \"saw\".";

// ---------------------------------------------------------------------------
// Tier 2: a model that takes the video
// ---------------------------------------------------------------------------

/** "<site>:<id>", so an account is keyed to the video and two sites cannot collide. */
export function videoKeyFor(meta, url) {
  const site = String(meta?.extractor_key || meta?.extractor || "unknown").toLowerCase();
  const id = String(meta?.id || url);
  return `${site}:${id}`;
}

/**
 * Is this a YouTube link, i.e. one the model can simply be handed?
 *
 * Read off yt-dlp's own extractor rather than off the URL where possible: it is the thing that
 * actually resolved the page, so a youtu.be short link or a /shorts/ URL is already normalised.
 */
export function isYouTube(meta, url) {
  const ex = String(meta?.extractor_key || meta?.extractor || "").toLowerCase();
  if (ex.startsWith("youtube")) return true;
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be";
  } catch { return false; }
}

/**
 * The model's own account of the video, cached so it is never paid for twice.
 *
 * A YouTube link is handed over whole and watched. Anything else gets its audio track pulled,
 * uploaded and transcribed, and the file is deleted in a `finally` — whether that worked, failed or
 * threw. A borrowed soundtrack is not something to leave lying about on disk.
 *
 * A request for a particular stretch (`from`/`to`) is NOT cached: an account of 14:00–16:00 is not
 * an account of the video, and handing one back for the other would be the quiet lie this whole
 * file exists to avoid.
 */
export async function modelAccount(url, {
  meta, run, model, status, from = null, to = null, question = "",
  maxMinutes = config.videoMaxMinutes, timeoutMs, transcriber = null,
} = {}) {
  const youtube = isYouTube(meta, url);
  const tier = youtube ? "watch" : "listen";
  const key = videoKeyFor(meta, url);
  const ranged = from !== null || to !== null;

  if (!ranged) {
    const had = db.getVideoAccount(key, tier);
    if (had?.text) return { ok: true, tier, text: had.text, model: had.model || undefined, cached: true };
  }

  if (!status.connected) return { ok: false, tier, ...status };
  if (!model && !transcriber) return { ok: false, tier, connected: false, missing: status.missing ?? [], why: status.why };

  // The money limit, checked against the metadata before anything is fetched or uploaded.
  const seconds = Number(meta?.duration) || 0;
  if (seconds && seconds > maxMinutes * 60) {
    return {
      ok: false, tier, too_long: true,
      error: `That video is ${timecode(seconds)} long and Reason will only ${youtube ? "watch" : "listen to"} ${maxMinutes} minutes in one go, so it has not been ${youtube ? "watched" : "transcribed"}. `
        + `Say that plainly — the length and the limit — rather than guessing at what is in it. (The limit is REASON_VIDEO_MAX_MINUTES.) `
        + `If they only want part of it, ask which stretch and pass from and to.`,
    };
  }

  // --- YouTube: hand the link over, download nothing ---
  if (youtube) {
    const out = await model.watchUrl(url, { question, from, to });
    if (!out.ok) return { ok: false, tier, error: out.error ?? out.why, missing: out.missing };
    if (!ranged) db.saveVideoAccount({ videoKey: key, tier, url, title: meta?.title ?? "", model: out.model ?? status.model ?? "", seconds: seconds || null, text: out.text });
    return { ok: true, tier, text: out.text, model: out.model ?? status.model, usage: out.usage, cached: false };
  }

  // --- anywhere else: the audio track only, uploaded ---
  const dir = mkdtempSync(join(scratchRoot(), "audio-"));
  try {
    const got = await audioOnly(url, { dir, run, timeoutMs });
    if (!got.ok) return { ok: false, tier, error: got.error, cannot: got.cannot };

    const mime = audioMimeFor(got.file);
    if (!mime) {
      return {
        ok: false, tier,
        error: `The only audio ${url} would give up is ${got.file.split(".").pop()}, which the video model does not take. Converting it would need ffmpeg, which is not on this machine, so this one cannot be listened to.`,
      };
    }

    // Gemini is the provider; an OpenAI transcriber is used only if one was explicitly configured.
    const said = transcriber
      ? await asAccount(transcriber, got.file)
      : await model.transcribeFile(got.file, { question, mime });
    if (!said.ok) return { ok: false, tier, error: said.error, missing: said.missing };

    if (!ranged) db.saveVideoAccount({ videoKey: key, tier, url, title: meta?.title ?? "", model: said.model ?? status.model ?? "", seconds: seconds || null, text: said.text });
    return { ok: true, tier, text: said.text, model: said.model ?? status.model, usage: said.usage, cached: false, audio_bytes: got.bytes };
  } finally {
    // The audio goes, always. The transcript is what was worth having.
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The optional OpenAI transcriber returns cues; this file wants text. One adapter, so the
 * Transcriber interface stays usable without the rest of the code knowing which provider ran.
 */
async function asAccount(transcriber, file) {
  const r = await transcriber(file, {});
  if (!r.ok) return r;
  return { ok: true, model: r.model, text: (r.cues ?? []).map(c => `[${timecode(c.at)}] ${c.text}`).join("\n") };
}

// ---------------------------------------------------------------------------
// The tool's one entry point
// ---------------------------------------------------------------------------

function trim(s, n) {
  const t = String(s ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function uploaded(meta) {
  const d = String(meta?.upload_date ?? "");
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined;
}

/**
 * Everything Reason can honestly say about one video.
 *
 * Order of business: check yt-dlp is there, read the metadata, then either read the captions or put
 * it to the model, lay the result out, and say which of the three things happened. When the tier
 * that was asked for cannot run, the other is used if it can — and said out loud. When neither can,
 * that is the answer, with the missing piece named.
 */
export async function videoUnderstand(rawUrl, {
  question = "", from: rawFrom = null, to: rawTo = null, watch = false, lang = "en",
  maxChars = config.videoTranscriptChars,
  run = runYtDlp, bin = findYtDlp(),
  model = undefined, modelStatus = undefined, transcriber = undefined,
  maxMinutes = config.videoMaxMinutes,
  timeoutMs = config.videoProbeTimeoutMs,
} = {}) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return { ok: false, tier: "none", error: `'${rawUrl}' is not a URL.` }; }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, tier: "none", error: `Only http and https. Got ${url.protocol}` };
  }
  const from = parseTime(rawFrom);
  const to = parseTime(rawTo);
  if (rawFrom && from === null) return { ok: false, tier: "none", error: `Could not read '${rawFrom}' as a time. Use M:SS, H:MM:SS, or seconds.` };
  if (rawTo && to === null) return { ok: false, tier: "none", error: `Could not read '${rawTo}' as a time. Use M:SS, H:MM:SS, or seconds.` };
  if (from !== null && to !== null && to <= from) return { ok: false, tier: "none", error: `'to' (${timecode(to)}) has to be after 'from' (${timecode(from)}).` };

  const tool = ytDlpStatus({ bin });
  const eyes = modelStatus ?? geminiStatus();
  const brain = model !== undefined ? model : videoModelFor({ status: eyes });
  // Only if somebody explicitly configured one. Gemini does the audio otherwise.
  const extra = transcriber !== undefined ? transcriber : (config.transcriber ? transcriberFor({ status: transcriberStatus() }) : null);

  // yt-dlp gets the metadata, the captions AND the audio, so with it gone there is nothing at all.
  if (!tool.ok) {
    return { ok: false, tier: "none", url: url.href, missing: tool.missing, error: tool.error };
  }

  const p = await probe(url.href, { run, timeoutMs });
  if (!p.ok) {
    const shut = ["private", "age_gate", "paywall", "login", "gone"].includes(p.cannot);
    return {
      ok: false, tier: "none", url: url.href, ...p, model_tier: eyes,
      ...(shut ? { note: "The video model would not get in either — it only takes public videos, and the audio is behind the same gate. This is the answer, not a reason to try another way." } : {}),
    };
  }
  const meta = p.meta;

  const base = {
    url: meta.webpage_url || url.href,
    site: meta.extractor_key || meta.extractor || undefined,
    title: meta.title || undefined,
    channel: meta.channel || meta.uploader || undefined,
    uploaded: uploaded(meta),
    duration: meta.duration ? timecode(meta.duration) : undefined,
    duration_seconds: meta.duration ?? undefined,
    description: meta.description ? trim(meta.description, config.videoDescriptionChars) : undefined,
    chapters: (meta.chapters ?? []).slice(0, 80).map(c => `${timecode(c.start_time)} ${c.title}`),
    // The thumbnail, like any image address a tool returns, is then allowed on a Reason page.
    images: typeof meta.thumbnail === "string" && meta.thumbnail.startsWith("https:") ? [meta.thumbnail] : [],
  };
  if (!base.chapters.length) delete base.chapters;

  const track = pickTrack(meta, lang);

  // --- tier 2, when it was asked for or when there are no captions to read ---
  let got = null;
  if (watch || !track) {
    got = await modelAccount(url.href, { meta, run, model: brain, status: eyes, from, to, question, maxMinutes, timeoutMs, transcriber: extra });
    if (got.ok) {
      const watched = got.tier === "watch";
      return {
        ok: true, tier: got.tier,
        how: (watched
          ? `WATCHED this video — ${got.model ?? "a video model"} was given the link and looked at it, picture and sound. You may say you watched it. Anything visual you describe has to come from the account below, not from the title or the thumbnail.`
          : `LISTENED to this video's audio and had it transcribed by ${got.model ?? "a video model"}. Audio only: nothing looked at the picture, so you do not know what was on screen or what anything looked like. Say "listened", never "watched". Machine-heard words can get names and numbers wrong, so do not quote them as exact.`)
          + (got.cached ? " This came from an account already made for it, so it cost nothing this time." : ""),
        ...base,
        captions: null,
        [watched ? "watched" : "heard"]: {
          by: got.model ?? eyes.model,
          cached: !!got.cached,
          saw: watched ? "the video" : "the audio only",
          ...(from !== null || to !== null ? { asked_for: `${timecode(from ?? 0)}–${timecode(to ?? (meta.duration ?? 0))}`, not_cached: "A stretch is never cached, so this was a fresh request." } : {}),
          ...(got.usage ? { usage: got.usage } : {}),
        },
        account: trim(got.text, maxChars),
        ...(got.text.length > maxChars ? { trimmed: { note: `The model's account was longer than ${maxChars} characters and is cut off at the end. Ask again with from and to for the stretch you still need.` } } : {}),
        model_tier: eyes,
        ...(question ? { question } : {}),
      };
    }
  }

  // --- tier 1, the captions ---
  if (track) {
    const caps = await captions(url.href, { lang: track.lang, auto: track.source !== "creator", run, timeoutMs });
    if (caps.ok) {
      const cues = parseCaptions(caps.text);
      if (cues.length) {
        const laid = layOutTranscript(cues, { from, to, maxChars });
        const words = SOURCE_WORDS[track.source] ?? SOURCE_WORDS.auto;
        return {
          ok: true, tier: "captions",
          how: `read the captions. These are ${words}.${BLIND}`,
          ...base,
          asked_for: laid.window ? `${timecode(laid.window.from)}–${timecode(laid.window.to)}` : undefined,
          covers: laid.covers,
          transcript: laid.transcript,
          ...(laid.trimmed ? { trimmed: laid.trimmed } : {}),
          captions: {
            source: track.source,
            language: track.lang,
            ...(track.not_english ? { not_english: `There is no English caption track. This is ${track.lang}.` } : {}),
            ...(track.spoken ? { spoken_language: track.spoken } : {}),
            total_lines: cues.length,
            full_length: `${timecode(cues[0].at)}–${timecode(cues.at(-1).at)}`,
          },
          model_tier: eyes,
          // Asked for the model and could not have it, read instead. Said out loud, not passed off.
          ...(got && !got.ok ? { model_tier_failed: got.error ?? got.why } : {}),
          ...(question ? { question } : {}),
        };
      }
    }
    // Captions are listed but unusable. Say which, and what the model tier said if it was tried.
    return {
      ok: true, tier: "metadata",
      how: `did NOT read, watch or listen to this video. It lists ${track.source === "creator" ? "creator" : "auto-generated"} captions in ${track.lang}, but they could not be used, so all that came back is what the page says about itself.`,
      ...base, captions: null, model_tier: eyes,
      error: caps.ok ? `The ${track.lang} caption file came back with no readable lines.` : caps.error,
      ...(got && !got.ok ? { model_tier_failed: got.error ?? got.why } : {}),
      note: "Say that you could not get at what is actually in it, and what stopped you. Do not guess at the content from the title or the description.",
    };
  }

  // --- nothing written down, and the model tier did not happen ---
  const why = got?.error ?? got?.why ?? eyes.why;
  return {
    ok: true, tier: "metadata",
    how: "did NOT read, watch or listen to this video. It has no captions at all — not the creator's and not auto-generated — so all that came back is what the page says about itself: the title, who posted it, how long it is, its description and its chapters.",
    ...base,
    captions: null,
    model_tier: eyes,
    error: why,
    note: `There are no captions on this video, so the only way to know what is in it is a model that takes the video itself, and that did not happen: ${why} `
      + "Say that straight: you can tell them the title, the channel, the length and what the description claims, and no more. Do not infer the content from the title.",
  };
}
