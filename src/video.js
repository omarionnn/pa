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
import { publicUrl } from "./netguard.js";
import { execFile, spawn } from "node:child_process";
import { setPriority } from "node:os";
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
export function runYtDlp(args, { cwd, timeoutMs = 60_000, bin = findYtDlp(), signal = null, maxDirBytes = 0, nice = 0 } = {}) {
  if (!bin) return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "yt-dlp is not installed" });
  // Intake's runs: their own process group (so the deadline, a timeout or the size watchdog stops
  // yt-dlp AND anything it started, ffmpeg included), lowered priority, a hard cap on what lands in
  // the scratch directory. Every other caller keeps the old path, byte for byte.
  if (signal || maxDirBytes || nice) return runGroup(bin, args, { cwd, timeoutMs, signal, maxDirBytes, nice });
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

/** Bytes under `dir` (one level of subdirectories is plenty for yt-dlp's scratch). */
function dirBytes(dir) {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      try { n += e.isDirectory() ? dirBytes(p) : statSync(p).size; } catch { /* gone between list and stat */ }
    }
  } catch { /* the directory itself is gone */ }
  return n;
}

const MAX_OUT = 16 * 1024 * 1024;
function runGroup(bin, args, { cwd, timeoutMs, signal, maxDirBytes, nice }) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ ok: false, code: null, stdout: "", stderr: "stopped before it started (the deadline had passed)." }); return; }
    const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (nice) { try { setPriority(child.pid, nice); } catch { /* best effort */ } }
    let out = "", err = "", why = "", done = false;
    const kill = (reason) => {
      if (!why) why = reason;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    child.stdout.on("data", d => { out += d; if (out.length > MAX_OUT) kill("its output was too large and it was stopped."); });
    child.stderr.on("data", d => { err += d; if (err.length > MAX_OUT) err = err.slice(-MAX_OUT); });
    const timer = setTimeout(() => kill(`yt-dlp was still running after ${timeoutMs / 1000}s and was stopped.`), timeoutMs);
    const watch = maxDirBytes && cwd
      ? setInterval(() => { if (dirBytes(cwd) > maxDirBytes) kill("ERROR: the file is larger than max-filesize, so the download was stopped."); }, 250)
      : null;
    const onAbort = () => kill("stopped: the deadline passed.");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer); if (watch) clearInterval(watch);
      signal?.removeEventListener("abort", onAbort);
      // Whatever yt-dlp started and left behind goes with it.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is already empty */ }
      resolve({ ok: code === 0 && !why, code: why ? 1 : code, stdout: out, stderr: err + (why ? `\n${why}` : ""), ...(why ? { killed: true } : {}) });
    };
    child.on("error", (e) => { err += String(e?.message ?? e); finish(1); });
    child.on("close", (code) => finish(code));
  });
}

// Intake only: yt-dlp reads no config file, no cookies and no browser profile, the link can never be
// read as an option ("--" before it), and the catch-all "generic" extractor is off — that one follows
// any redirect and fetches whatever a page embeds, which is how a public link could have walked
// yt-dlp onto this machine's own network (src/netguard.js only ever saw the link as typed).
export const INTAKE_YTDLP_FLAGS = Object.freeze(["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--use-extractors", "all,-generic"]);
export function hardenArgs(args) {
  return [...INTAKE_YTDLP_FLAGS, ...args.slice(0, -1), "--", args.at(-1)];
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
async function audioOnly(url, { dir, run, timeoutMs, maxBytes = 0 }) {
  const r = await run([
    "--no-playlist", "--no-warnings", "--socket-timeout", "20",
    // Intake only: yt-dlp refuses before downloading when the size is known, and stops when it is not.
    ...(maxBytes ? ["--max-filesize", String(maxBytes)] : []),
    "-f", config.audioFormat,
    "-o", "audio.%(ext)s", url,
  ], { cwd: dir, timeoutMs, ...(maxBytes ? { maxDirBytes: maxBytes } : {}) });
  const file = readdirSync(dir).find(f => f.startsWith("audio.") && !(maxBytes && f.endsWith(".part")));
  const tooBig = { ok: false, cannot: "too_big", error: `The audio of ${url} is over ${Math.round(maxBytes / 1e6)} MB, so it was not downloaded.` };
  // Stopped part-way (the size watchdog, the deadline, a timeout): whatever is on disk is not the audio.
  if (r.killed) return /larger than max-filesize/i.test(r.stderr ?? "") ? tooBig : { ok: false, ...reason(r.stderr, url) };
  if (!file) {
    if (maxBytes && /larger than max-filesize/i.test(`${r.stdout ?? ""} ${r.stderr ?? ""}`)) return tooBig;
    return { ok: false, ...reason(r.stderr, url) };
  }
  const full = join(dir, file);
  if (maxBytes && statSync(full).size > maxBytes) return tooBig;
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
  maxMinutes = config.videoMaxMinutes, timeoutMs, transcriber = null, maxBytes = 0,
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
    const got = await audioOnly(url, { dir, run, timeoutMs, maxBytes });
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
  // Video intake (REASON_VIDEO_INTAKE). Only `videoIntake` below passes these; with them unset every
  // result is what it always was.
  intake = false, onLongFetch = null, maxBytes = 0, signal = null,
} = {}) {
  if (intake) {
    // Every yt-dlp run under intake: hardened flags, "--" before the link, its own process group that
    // the deadline kills, and a lower CPU priority than the live calls on this machine.
    const inner = run;
    run = (args, o = {}) => inner(hardenArgs(args), { ...o, ...(signal ? { signal } : {}), nice: 10 });
  }
  let url;
  try { url = new URL(String(rawUrl)); } catch { return { ok: false, tier: "none", error: `'${rawUrl}' is not a URL.` }; }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, tier: "none", error: `Only http and https. Got ${url.protocol}` };
  }
  // Never this machine's own network (src/netguard.js). yt-dlp follows its own redirects, so this is
  // the link as given; the downloads it makes are its own.
  const pub = await publicUrl(url.href);
  if (!pub.ok) return { ok: false, tier: "none", refused: true, error: `Not watched: ${pub.why}.` };
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
  if (!p.ok && intake) {
    // A bot check on this server's address is this address's problem, not the video's: a YouTube link
    // handed to the video model does not come from here, so that tier is tried next, and said.
    const ytId = youtubeIdOf(url.href);
    if (p.cannot === "login" && ytId && eyes.connected && brain) {
      // The length could not be read from here, so the money limit cannot be checked against it: the
      // model is given at most `maxMinutes` of it (Gemini's end_offset), and that is said.
      const upTo = to ?? (from ?? 0) + maxMinutes * 60;
      const got = await modelAccount(url.href, { meta: { extractor_key: "Youtube", id: ytId }, run, model: brain, status: eyes, from, to: upTo, question, maxMinutes, timeoutMs, transcriber: extra, maxBytes });
      if (got.ok) {
        return {
          ...modelResult(got, { url: url.href, images: [] }, { eyes, from, to: upTo, meta: {}, maxChars, question }), details_failed: p.error,
          ...(to === null ? { length_unknown: `The video's length could not be read from here, so the model was given at most ${timecode(upTo)} of it. If the account stops around then, say it covers only that much.` } : {}),
        };
      }
    }
    const say = INTAKE_CANNOT_SAY[p.cannot];
    if (say) return { ok: false, tier: "none", url: url.href, ...p, say, retry: false, note: INTAKE_NO_RETRY };
  }
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

  if (intake) {
    const no = intakeRefusal(meta);
    if (no) return { ok: false, tier: "none", ...base, ...no, retry: false, note: INTAKE_NO_RETRY };
    if (onLongFetch && Number(meta.duration) > config.videoHeadsUpSeconds) {
      try { base.heads_up = await onLongFetch({ seconds: Number(meta.duration), title: base.title }); } catch { /* a heads-up that failed is not the video failing */ }
    }
  }

  const track = pickTrack(meta, lang);
  const cacheId = intake ? normalizeVideoUrl(url.href).key : null;

  // --- tier 2, when it was asked for or when there are no captions to read ---
  let got = null;
  if (watch || !track) {
    got = await modelAccount(url.href, { meta, run, model: brain, status: eyes, from, to, question, maxMinutes, timeoutMs, transcriber: extra, maxBytes });
    if (got.ok) {
      if (cacheId) cacheHeard(cacheId, got, base, { ranged: from !== null || to !== null });
      return modelResult(got, base, { eyes, from, to, meta, maxChars, question });
    }
    if (intake) {
      const no = intakeModelRefusal(got, { meta, maxMinutes, maxBytes });
      if (no) return { ok: false, tier: "none", ...base, ...no, retry: false, note: INTAKE_NO_RETRY };
    }
  }
  return captionsOrNothing();

  async function captionsOrNothing() {
  // --- tier 1, the captions ---
  if (track) {
    const caps = await captions(url.href, { lang: track.lang, auto: track.source !== "creator", run, timeoutMs });
    if (caps.ok) {
      const cues = parseCaptions(caps.text);
      if (cues.length) {
        if (cacheId) cacheCues(cacheId, cues, base, { tier: "captions", source: track.source });
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
    // Intake: the captions would not come (a bot check on this address, most often) and the model
    // tier has not been tried. It is the next tier, so it is tried — and named in the result.
    if (intake && !got && brain) {
      got = await modelAccount(url.href, { meta, run, model: brain, status: eyes, from, to, question, maxMinutes, timeoutMs, transcriber: extra, maxBytes });
      if (got.ok) {
        if (cacheId) cacheHeard(cacheId, got, base, { ranged: from !== null || to !== null });
        return { ...modelResult(got, base, { eyes, from, to, meta, maxChars, question }), captions_failed: caps.ok ? "no readable lines" : caps.error };
      }
      const no = intakeModelRefusal(got, { meta, maxMinutes, maxBytes });
      if (no) return { ok: false, tier: "none", ...base, ...no, retry: false, note: INTAKE_NO_RETRY };
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
}

/** A model tier that answered, as the tool reports it. Unchanged from when it was inline. */
function modelResult(got, base, { eyes, from, to, meta, maxChars, question }) {
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


// ---------------------------------------------------------------------------
// Video intake (REASON_VIDEO_INTAKE = off | owner | on, default off)
// ---------------------------------------------------------------------------
//
// Built on everything above, not beside it: the same probe, the same tiers, the same honesty about
// which tier answered. What intake adds is a transcript cache keyed by the video (so a second
// question is free and instant), `find` (search inside a long video instead of reading it all),
// the lines a PDF of the transcript is made from, a heads-up for a long fetch, a five-minute ceiling,
// and one plain line for a video that cannot be had (live, over two hours, private, age-gated).
//
// Nothing here disguises where a request comes from. A site that bot-checks this server fails that
// tier honestly; the next tier is tried (a YouTube link goes to the video model, which does not
// fetch from here); if none works, that is the answer.

/** One plain line per reason a video cannot be had. Said once; nothing is retried. */
export const INTAKE_CANNOT_SAY = {
  private: "That video is private, so only the person who posted it can see it.",
  age_gate: "That video is age-restricted, so it only plays to a signed-in account, and I don't sign in to get around that.",
  paywall: "That one is for paying channel members only, so I can't get at it.",
  gone: "That video isn't there any more. It's been taken down or was never public.",
  region: "That video is blocked from where I'm fetching it, so I can't get at it.",
  login: "That site wanted me to sign in before showing the video, so I couldn't get what's in it.",
  live: "That's a live stream, so there's no finished video to get a transcript of yet.",
  upcoming: "That video hasn't started yet, so there's nothing in it to read.",
  too_long: null, // carries the length, so it is written where the length is known
  too_big: null,  // carries the size, the same way
};

/**
 * Intake: the paid tier would not take this one (too long to listen to, audio too big, or the video
 * itself is shut), so it is one plain line, not the metadata fallback. Null for anything else.
 */
function intakeModelRefusal(got, { meta, maxMinutes, maxBytes }) {
  if (!got || got.ok) return null;
  if (got.too_long) {
    const how = got.tier === "watch" ? "watch" : "listen to";
    return { cannot: "too_long", say: `That video is ${timecode(Number(meta?.duration) || 0)} long and has no captions I can read, so I'd have to ${how} it, and I only ${how} up to ${maxMinutes} minutes of a video.` };
  }
  if (got.cannot === "too_big") return { cannot: "too_big", say: `That video's audio is over ${Math.round(maxBytes / 1e6)} MB, so I didn't download it.` };
  if (got.cannot && INTAKE_CANNOT_SAY[got.cannot]) return { cannot: got.cannot, say: INTAKE_CANNOT_SAY[got.cannot] };
  return null;
}
export const INTAKE_NO_RETRY = "Tell them that in one plain line (the `say` line is the meaning; put it in your own words). Do not try again, do not try another way, and do not guess at what is in it.";

/** The 11-character YouTube id in any of its URL forms, or null. */
export function youtubeIdOf(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const ok = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id ?? "") ? id : null);
  if (host === "youtu.be") return ok(u.pathname.split("/")[1]);
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") return ok(u.searchParams.get("v"));
    const m = /^\/(shorts|live|embed|v|e)\/([^/?#]+)/.exec(u.pathname);
    return m ? ok(m[2]) : null;
  }
  return null;
}

/**
 * The one id a video is cached under, whatever form the link arrived in: youtu.be, /shorts/, m.,
 * a `t=` timestamp, `si=`/`utm_*` tracking — all the same video, so all the same key.
 *
 * @returns {{ key: string, site: string, id: string }}
 */
export function normalizeVideoUrl(raw) {
  const yt = youtubeIdOf(raw);
  if (yt) return { key: `youtube:${yt}`, site: "youtube", id: yt };
  let u;
  try { u = new URL(String(raw)); } catch { return { key: `url:${String(raw).trim()}`, site: "url", id: String(raw).trim() }; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|vm|web)\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  const pick = (site, re, src = path) => { const m = re.exec(src); return m ? { key: `${site}:${m[1]}`, site, id: m[1] } : null; };
  // An unlisted Vimeo link carries its secret as a second path part or as ?h=: it is part of the key,
  // so a cached unlisted video is only ever served to someone holding the same full link.
  const vimeo = () => {
    const m = /(?:^|\/)(\d{5,})(?:\/([0-9a-f]{6,}))?(?:\/|$)/i.exec(path);
    if (!m) return null;
    const secret = m[2] || (/^[0-9a-f]{6,}$/i.test(u.searchParams.get("h") ?? "") ? u.searchParams.get("h") : "");
    const id = secret ? `${m[1]}:${secret.toLowerCase()}` : m[1];
    return { key: `vimeo:${id}`, site: "vimeo", id };
  };
  const found =
    (host.endsWith("vimeo.com") && vimeo())
    || (host.endsWith("tiktok.com") && pick("tiktok", /\/video\/(\d+)/))
    || (host.endsWith("instagram.com") && pick("instagram", /^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/))
    || ((host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com")) && pick("twitter", /\/status(?:es)?\/(\d+)/))
    || (host.endsWith("loom.com") && pick("loom", /\/(?:share|embed)\/([a-f0-9]{16,})/i))
    || ((host.endsWith("facebook.com") || host === "fb.watch") && (
      (u.searchParams.get("v") && /^\d+$/.test(u.searchParams.get("v")) ? { key: `facebook:${u.searchParams.get("v")}`, site: "facebook", id: u.searchParams.get("v") } : null)
      || pick("facebook", /\/(?:videos|reel|watch)\/(?:[^/]+\/)?(\d{6,})/)));
  if (found) return found;
  // Anything else: the address without its fragment, trailing slash or tracking parameters. The rest
  // of the query stays: on an unknown site it may be the very thing that makes a link private, and a
  // cache keyed without it would hand the transcript to anyone who guessed the path.
  const TRACKING = /^(utm_.*|si|t|start|feature|ref|ref_src|fbclid|gclid|igsh|igshid|share_id|is_from_webapp|sender_device|_r|s)$/i;
  const q = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const qs = q.length ? `?${new URLSearchParams(q)}` : "";
  return { key: `url:${host}${path}${qs}`, site: host, id: `${host}${path}${qs}` };
}

/** Why intake will not fetch this video at all, read off its metadata, or null. */
export function intakeRefusal(meta, { maxSeconds = config.videoIntakeMaxSeconds } = {}) {
  const live = String(meta?.live_status ?? "");
  if (meta?.is_live || live === "is_live") return { cannot: "live", say: INTAKE_CANNOT_SAY.live };
  if (live === "is_upcoming") return { cannot: "upcoming", say: INTAKE_CANNOT_SAY.upcoming };
  const avail = String(meta?.availability ?? "");
  if (avail === "private") return { cannot: "private", say: INTAKE_CANNOT_SAY.private };
  if (avail === "subscriber_only" || avail === "premium_only") return { cannot: "paywall", say: INTAKE_CANNOT_SAY.paywall };
  if (avail === "needs_auth" || Number(meta?.age_limit) >= 18) return { cannot: "age_gate", say: INTAKE_CANNOT_SAY.age_gate };
  const s = Number(meta?.duration) || 0;
  if (s > maxSeconds) {
    return { cannot: "too_long", say: `That video is ${timecode(s)} long, and I only take videos up to ${timecode(maxSeconds).replace(/:00:00$/, "")} hours.` };
  }
  return null;
}

/** Cues with an end: each line ends where the next begins (the last one at the video's end). */
function withEnds(cues, durationS) {
  return cues.map((c, i) => ({ at: c.at, end: cues[i + 1]?.at ?? (Number(durationS) || c.at), text: c.text }));
}

function cacheCues(videoId, cues, base, { tier, source }) {
  try {
    db.saveVideoTranscript({
      videoId, url: base.url, title: base.title ?? "", channel: base.channel ?? "",
      durationS: base.duration_seconds ?? null, tier, source, lines: withEnds(cues, base.duration_seconds),
    }, { maxChars: config.videoCacheMaxChars });
  } catch { /* a cache that could not be written costs a re-fetch, nothing else */ }
}

/**
 * The audio transcription, as lines. A model that watched the video wrote an ACCOUNT of it, not a
 * transcript, so that is never cached as one: it already lives in video_accounts.
 */
function cacheHeard(videoId, got, base, { ranged }) {
  if (ranged || got.tier !== "listen") return;
  const cues = parseAccountLines(got.text);
  if (cues.length) cacheCues(videoId, cues, base, { tier: "listen", source: got.model ?? "" });
}

/** "[1:02] words" / "1:02 words" / "(1:02:03) words" lines → cues; untimed lines join the one before. */
export function parseAccountLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^[[(]?(\d{1,2}:\d{2}(?::\d{2})?)(?:[.,]\d+)?[\])]?\s*[-–:]?\s*(.+)$/.exec(line);
    if (m) { out.push({ at: parseTime(m[1]) ?? 0, text: m[2].trim() }); continue; }
    if (out.length) out.at(-1).text += ` ${line}`;
    else out.push({ at: 0, text: line });
  }
  return out;
}

const STOP = new Set("a an and are as at be but by do does did for from has have he her his how i if in is it its me my of on or our she so that the their them they this to was we were what when where which who why will with you your about said say says talk talks talking".split(" "));
const words = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9']+/g) ?? [];

/**
 * Where in the transcript they say something. Each hit is the matching line with the line either
 * side of it, and the time it starts at. A phrase that appears as typed ranks first; otherwise every
 * meaningful word of the query has to be within those three lines. Hits closer than 20 seconds to a
 * better one are the same moment and are dropped.
 */
export function searchCues(cues, query, { max = 12, link = null } = {}) {
  const phrase = words(query).join(" ");
  let want = [...new Set(words(query).filter(w => !STOP.has(w)))];
  if (!want.length) want = [...new Set(words(query))];
  if (!want.length) return [];
  const scored = [];
  cues.forEach((c, i) => {
    const win = cues.slice(Math.max(0, i - 1), i + 2);
    const here = words(c.text).join(" ");
    const around = words(win.map(x => x.text).join(" "));
    const has = want.filter(w => around.some(a => a === w || (w.length > 3 && a.startsWith(w))));
    const exact = phrase && ` ${here} `.includes(` ${phrase} `);
    const inLine = want.filter(w => words(c.text).some(a => a === w || (w.length > 3 && a.startsWith(w)))).length;
    if (!exact && (has.length < want.length || !inLine)) return;
    scored.push({ i, score: (exact ? 100 : 0) + has.length * 2 + inLine });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  for (const s of scored) {
    if (picked.length >= max) break;
    if (picked.some(p => Math.abs(cues[p.i].at - cues[s.i].at) < 20)) continue;
    picked.push(s);
  }
  return picked.sort((a, b) => a.i - b.i).map(({ i }) => {
    const at = cues[i].at;
    return {
      at: timecode(at), seconds: Math.floor(at),
      text: cues.slice(Math.max(0, i - 1), i + 2).map(x => x.text).join(" "),
      ...(link ? { link: link(at) } : {}),
    };
  });
}

// Worded exactly as a fresh read is: the cache is shared by video across everybody, so nothing a
// person is told may hint that the video was fetched before (by them or by anyone else).
const HOW_CACHED = {
  captions: (source) => `read the captions. These are ${SOURCE_WORDS[source] ?? SOURCE_WORDS.auto}.${BLIND}`,
  listen: (by) => `LISTENED to this video's audio and had it transcribed${by ? ` by ${by}` : ""}. Audio only: nothing looked at the picture, so you do not know what was on screen. Say "listened", never "watched". Machine-heard words can get names and numbers wrong, so do not quote them as exact.`,
};

/** A cached transcript, laid out the way a fresh one is. Nothing was fetched. */
function fromCache(hit, { from, to, maxChars }) {
  const laid = layOutTranscript(hit.lines, { from, to, maxChars });
  return {
    ok: true, tier: hit.tier,
    how: (HOW_CACHED[hit.tier] ?? HOW_CACHED.captions)(hit.source),
    url: hit.url, title: hit.title || undefined, channel: hit.channel || undefined,
    duration: hit.durationS ? timecode(hit.durationS) : undefined, duration_seconds: hit.durationS ?? undefined,
    images: [],
    asked_for: laid.window ? `${timecode(laid.window.from)}–${timecode(laid.window.to)}` : undefined,
    covers: laid.covers,
    transcript: laid.transcript,
    ...(laid.trimmed ? { trimmed: laid.trimmed } : {}),
    captions: hit.tier === "captions" ? { source: hit.source, total_lines: hit.lines.length, full_length: hit.lines.length ? `${timecode(hit.lines[0].at)}–${timecode(hit.lines.at(-1).at)}` : null } : null,
  };
}

/** One fresh watch or listen, into the paid-usage ledger. A cached account cost nothing and is not counted. */
function noteVideoSpend(r, record) {
  const used = r?.watched ?? r?.heard;
  if (!r?.ok || !used || used.cached || !used.usage) return;
  const u = used.usage;
  try {
    record({
      feature: "video", model: String(used.by ?? ""),
      usage: {
        input_tokens: Number(u.promptTokenCount ?? u.input_tokens) || 0,
        output_tokens: (Number(u.candidatesTokenCount ?? u.output_tokens) || 0) + (Number(u.thoughtsTokenCount) || 0),
      },
    });
  } catch { /* counting never costs an answer */ }
}

/** How the transcript was got, in the few words Reason says it in. */
export function howWeGotIt(tier, source = "") {
  if (tier === "captions") return source === "creator" ? "from the creator's captions" : "from the video's auto-generated captions";
  if (tier === "listen") return "by listening to the audio";
  if (tier === "watch") return "by watching it";
  return "";
}

/** The cached transcript for a link, or null. What a PDF of the transcript is made from. */
export function cachedTranscriptFor(rawUrl) {
  return db.getVideoTranscript(normalizeVideoUrl(rawUrl).key, { maxAgeMs: config.videoCacheDays * 86_400_000 });
}

/**
 * Document blocks for a whole transcript as a PDF: each line "m:ss text", in text blocks under the
 * document limits (src/pages/content.js: 4,000 characters a block, 60 blocks). A transcript that
 * would not fit stops at a line, and says where, rather than being cut silently.
 */
export function transcriptBlocks(lines, { blockChars = 3_900, maxBlocks = 59 } = {}) {
  const blocks = [];
  let cur = [], size = 0, stoppedAt = null;
  for (const l of lines) {
    const row = `${timecode(l.at)} ${String(l.text).replace(/\s+/g, " ").trim()}`.slice(0, blockChars);
    if (size + row.length + 1 > blockChars) {
      blocks.push({ type: "text", text: cur.join("\n") });
      cur = []; size = 0;
      if (blocks.length >= maxBlocks) { stoppedAt = l.at; break; }
    }
    cur.push(row); size += row.length + 1;
  }
  if (stoppedAt === null && cur.length) blocks.push({ type: "text", text: cur.join("\n") });
  if (stoppedAt !== null) blocks.push({ type: "text", text: `The transcript goes on past ${timecode(stoppedAt)}. This PDF stops there because a document can only hold so much.` });
  return { blocks, stoppedAt };
}

/** Is there a price on file for `model` (src/spend.js priceFor's rule)? Unpriced use would count as $0. */
function priceKnown(model) {
  const m = String(model ?? "");
  return !!config.apiPrices[m] || Object.keys(config.apiPrices).some(k => m.startsWith(k));
}

/** Room for the audio above the free-disk floor (src/webuploads.js, REASON_UPLOAD_DISK_FLOOR_GB). */
async function diskHasRoom(bytes) {
  try { return (await import("./webuploads.js")).diskRoom(bytes).ok; } catch { return true; }
}

/**
 * Scratch left by a run that never reached its `finally` (the process killed mid-fetch, a crash):
 * gone on the next intake. Older than the deadline twice over, so a run in progress is never touched.
 */
function sweepScratch({ olderThanMs = 2 * config.videoIntakeDeadlineMs + 60_000 } = {}) {
  try {
    const root = scratchRoot();
    for (const name of readdirSync(root)) {
      if (!/^(audio|caps)-/.test(name)) continue;
      const p = join(root, name);
      try { if (Date.now() - statSync(p).mtimeMs > olderThanMs) rmSync(p, { recursive: true, force: true }); } catch { /* raced */ }
    }
  } catch { /* nothing to sweep */ }
}

// At most this many videos fetched at once across everybody (REASON_VIDEO_CONCURRENT, 2): yt-dlp and
// any ffmpeg it starts share a small server with live calls. A third waits its turn, inside its own
// deadline; one that is still waiting when the deadline passes never starts.
let running = 0;
const queue = [];
export function videoSlots() { return { running, waiting: queue.length }; }
function slot(signal) {
  const max = Math.max(1, Number(config.videoConcurrent) || 2);
  const release = () => { running--; const next = queue.shift(); if (next) next(); };
  if (running < max) { running++; return Promise.resolve(release); }
  return new Promise((res) => {
    const go = () => { signal?.removeEventListener("abort", drop); running++; res(release); };
    const drop = () => { const i = queue.indexOf(go); if (i >= 0) queue.splice(i, 1); res(null); };
    queue.push(go);
    signal?.addEventListener("abort", drop, { once: true });
  });
}

/**
 * The tool's entry point with intake on. A cached transcript answers with no fetch at all; otherwise
 * the ordinary `videoUnderstand` runs (with intake's refusals, heads-up and caching switched on),
 * inside a deadline. `find` turns the result into the matching moments rather than the whole text.
 */
export async function videoIntake(rawUrl, opts = {}) {
  const { find = "", deadlineMs = config.videoIntakeDeadlineMs, spendCap = null, recordSpend = null, ...rest } = opts;
  const from = parseTime(rest.from), to = parseTime(rest.to);
  const key = normalizeVideoUrl(rawUrl).key;
  const link = key.startsWith("youtube:") ? (s) => `https://youtu.be/${key.slice(8)}?t=${Math.floor(s)}` : null;

  let out = null;
  if (!rest.watch) {
    const hit = db.getVideoTranscript(key, { maxAgeMs: config.videoCacheDays * 86_400_000 });
    if (hit?.lines?.length && (rest.from == null || from !== null) && (rest.to == null || to !== null)) {
      out = fromCache(hit, { from, to, maxChars: rest.maxChars ?? config.videoTranscriptChars });
    }
  }
  if (!out) {
    // The money: watching and listening are paid (Gemini), so they are counted in the same usage
    // ledger every paid model call is (src/spend.js, feature "video") and held to the same daily and
    // monthly caps. A cap already reached means only the free tier (captions) is tried, and said.
    const spend = (spendCap && recordSpend) ? null : await import("./spend.js");
    const capHit = spendCap ? spendCap() : (spend.capReached() ?? spend.videoBudgetReached());
    const record = recordSpend ?? spend.recordApi;
    const maxBytes = rest.maxBytes ?? Math.round(config.videoAudioMaxMB * 1e6);
    // Paid audio goes to the video model only, whose use is counted below. An OpenAI transcriber set
    // for something else would be paid use nothing here counts, so intake never reaches for it.
    const understand = { ...rest, intake: true, maxBytes, transcriber: rest.transcriber !== undefined ? rest.transcriber : null };
    const closed = capHit
      ? `the spending limit on paid AI use is reached for ${capHit.which === "month" ? "this month" : capHit.which === "video" ? "videos today" : "today"}, so nothing that costs money (watching it or listening to it) was tried.`
      : !rest.modelStatus && !priceKnown(config.videoModel)
        ? `no price is on file for the video model (${config.videoModel}), so what it would cost could not be counted and nothing that costs money was tried.`
        : !(await diskHasRoom(maxBytes))
          ? "the server's disk is nearly full, so no audio was downloaded."
          : null;
    if (closed) understand.modelStatus = { connected: false, missing: [], model: null, why: closed };
    sweepScratch();
    const ac = new AbortController();
    understand.signal = ac.signal;
    // Counted when it finishes, even past the deadline: money spent late is still money spent. The
    // deadline kills every yt-dlp run (and what it started); a model call already made runs out and is counted.
    const work = (async () => {
      const release = await slot(ac.signal);
      if (!release) return null;
      try { return await videoUnderstand(rawUrl, understand); } finally { release(); }
    })().then(r => { noteVideoSpend(r, record); return r; });
    let timer;
    const late = new Promise(res => { timer = setTimeout(() => res(null), deadlineMs); });
    try {
      out = await Promise.race([work, late]);
    } finally { clearTimeout(timer); }
    if (!out) {
      ac.abort();
      return {
        ok: false, tier: "none", url: String(rawUrl), timed_out: true, retry: false,
        say: `I couldn't get what's in that video within ${Math.round(deadlineMs / 60_000)} minutes, so I stopped.`,
        note: INTAKE_NO_RETRY,
      };
    }
    // The paid tiers were shut and there were no captions: one plain line, about the machine, not them.
    if (closed && out.ok && out.tier === "metadata" && !out.captions) {
      out.say = capHit
        ? "That video has no captions, and the paid way of listening to it is switched off for now on my side, so all I can tell you is what the page says about it."
        : "That video has no captions, and I can't listen to it right now on my side, so all I can tell you is what the page says about it.";
      out.note = "Tell them that in one plain line, then what the page says (title, who posted it, length). Do not guess at what is in it, do not promise to try later, and do not give them anything to type.";
    }
  }
  if (!out.ok) return out;

  out.say_how = `Say in a few words how you know what is in it: ${howWeGotIt(out.tier, out.captions?.source) || "you only have what the page says about itself"}.`;

  if (find && String(find).trim()) {
    const hit = db.getVideoTranscript(key);
    const cues = hit?.lines?.length ? hit.lines : parseAccountLines(out.transcript ?? out.account ?? "").map(c => ({ ...c, text: c.text }));
    const found = cues.length ? searchCues(cues, find, { link }) : [];
    const { transcript, account, trimmed, ...lean } = out;
    return {
      ...lean,
      find: String(find),
      searched: cues.length ? `the whole transcript, ${timecode(cues[0].at)}–${timecode(cues.at(-1).at)}` : "nothing: there is no transcript of this video to search",
      found,
      note: found.length
        ? "These are the moments that match. Quote with the time against each (m:ss, or h:mm:ss), and give the link when there is one. Say only what these lines say."
        : "Nothing in the transcript matches. Say that plainly; do not guess where in the video it might be.",
    };
  }
  if (!rest.question && !rest.from && !rest.to) {
    out.if_just_a_link = "If their message was only this link, with nothing asked: answer in 3 to 5 short lines (what it is, who it's from, the main points), "
      + "say how you got it in a few words, then one short offer in plain words of what else you can do with it: the full transcript as a PDF, the key quotes, or finding where they talk about something. Never give them words to type.";
  }
  return out;
}
