// Going to a video and finding out what is in it, in two tiers — and the result always says which
// one answered.
//
// Tier 1, the captions tier: yt-dlp hands back the video's own metadata and whatever captions it
// already has, creator-written when there are any and auto-generated otherwise.
//
// Tier 2, the listen tier: when there are no usable captions, or the owner asks Reason to actually
// listen, Reason downloads the video's AUDIO TRACK ONLY, has it transcribed by a speech-to-text
// model, and returns timestamped lines in exactly the shape tier 1 returns. The audio lives in a
// scratch directory under the data dir and is deleted the moment the transcript is stored; the
// transcript is cached by video, so the same video is never paid for twice. The video stream itself
// is never downloaded.
//
// Both tiers come back with words and only words. Nothing here looks at a picture, so every result
// carries a `tier` and a plain-English `how` that says so — the model is handed the honest sentence
// rather than having to remember which tier it used. Seeing the picture is not built.
//
// Nothing here works around an age gate, a login, a paywall or a region block either; those come
// back as the reason the video could not be read.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { config } from "./config.js";
import * as db from "./db.js";
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
 * Reading captions and listening to the audio have different requirements, and both of them produce
 * words only. The wording never implies the picture was seen, because nothing here can see it.
 */
export function videoCapability({ tool = ytDlpStatus(), listen = transcriberStatus() } = {}) {
  const BLIND = " Either way it is words only: nothing looks at the picture, so you can never say what was on screen, who was in shot or what a chart or a demo showed.";

  if (!tool.ok) {
    return {
      status: "not connected",
      what: "Reason cannot get at any video on this machine: yt-dlp is not installed, and it is what fetches a video's details, its captions and its audio. Do not offer to.",
    };
  }
  if (listen.connected) {
    return {
      status: "live",
      what: "go to a video (YouTube and many other sites) and find out what is in it: its title, channel, length, description, chapters, and what is said in it as timestamped lines. "
        + `It reads the captions when the video has them, and when it does not — or when asked to listen properly — it takes the audio track and has it transcribed by ${listen.what} (${listen.model}), up to ${config.listenMaxMinutes} minutes a video. `
        + "The result says which of the two it did, every time." + BLIND,
    };
  }
  return {
    status: "live",
    what: "go to a video (YouTube and many other sites) and read its captions: title, channel, length, description, chapters, and what is said as timestamped lines, creator-written when there are any and auto-generated otherwise. "
      + `A video with NO captions cannot be read at all, because listening to the audio needs a speech-to-text key this machine does not have (${listen.missing.join(", ")}). `
      + "An age gate, a login or a region block is reported rather than worked around." + BLIND,
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
// Tier 2: listening to the audio
// ---------------------------------------------------------------------------

/** "<site>:<id>", so a transcript is keyed to the video and two sites cannot collide. */
export function videoKeyFor(meta, url) {
  const site = String(meta?.extractor_key || meta?.extractor || "unknown").toLowerCase();
  const id = String(meta?.id || url);
  return `${site}:${id}`;
}

/**
 * Get the audio, have it transcribed, keep the transcript, throw the audio away.
 *
 * The cache is checked first and costs nothing: listening is billed per minute of audio, so the
 * second person to ask about the same video pays nothing. The length cap is checked against the
 * metadata BEFORE anything is downloaded, so an over-long video costs no bandwidth either.
 *
 * The audio file is deleted in a `finally`, whether the transcription worked, failed or threw. A
 * video's soundtrack is not something to leave lying about on disk.
 */
export async function listen(url, {
  meta, run, transcriber, status, maxMinutes = config.listenMaxMinutes, timeoutMs,
} = {}) {
  const key = videoKeyFor(meta, url);

  const cached = db.getTranscript(key);
  if (cached?.cues?.length) {
    return { ok: true, cues: cached.cues, language: cached.language || undefined, model: cached.model || undefined, cached: true };
  }

  if (!status.connected) return { ok: false, ...status };
  if (!transcriber) return { ok: false, connected: false, missing: status.missing ?? [], why: status.why };

  const seconds = Number(meta?.duration) || 0;
  if (seconds && seconds > maxMinutes * 60) {
    return {
      ok: false, too_long: true,
      error: `That video is ${timecode(seconds)} long and Reason will only listen to ${maxMinutes} minutes of audio in one go, so it has not been transcribed. `
        + `Say that plainly — the length and the limit — rather than guessing at what is in it. (The limit is REASON_LISTEN_MAX_MINUTES.)`,
    };
  }

  const dir = mkdtempSync(join(scratchRoot(), "audio-"));
  try {
    const got = await audioOnly(url, { dir, run, timeoutMs });
    if (!got.ok) return { ok: false, error: got.error, cannot: got.cannot };

    const said = await transcriber(got.file, {});
    if (!said.ok) return { ok: false, error: said.error, too_big: said.too_big, missing: said.missing };
    if (!said.cues?.length) return { ok: false, error: "The transcriber came back with no words at all." };

    db.saveTranscript({
      videoKey: key, url, title: meta?.title ?? "",
      language: said.language ?? "", model: said.model ?? status.model ?? "",
      seconds: said.seconds ?? (seconds || null), cues: said.cues,
    });
    return {
      ok: true, cues: said.cues, language: said.language, model: said.model ?? status.model,
      cached: false, audio_bytes: got.bytes, no_timestamps: said.no_timestamps,
    };
  } finally {
    // The audio goes, always. The transcript is what was worth having.
    rmSync(dir, { recursive: true, force: true });
  }
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
 * Order of business: check yt-dlp is there, read the metadata, then either read the captions or
 * listen to the audio, lay the result out with timestamps, and say which of the two happened. When
 * the asked-for tier cannot run, the other one is offered if it can — and when neither can, that is
 * the answer, with the missing piece named.
 */
export async function videoUnderstand(rawUrl, {
  question = "", from: rawFrom = null, to: rawTo = null, listen: wantListen = false, lang = "en",
  maxChars = config.videoTranscriptChars,
  run = runYtDlp, bin = findYtDlp(),
  transcriber = undefined, listenStatus = undefined,
  maxMinutes = config.listenMaxMinutes,
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
  const ears = listenStatus ?? transcriberStatus();
  const ear = transcriber !== undefined ? transcriber : transcriberFor({ status: ears });

  // yt-dlp gets the metadata, the captions AND the audio, so with it gone there is nothing at all.
  if (!tool.ok) {
    return { ok: false, tier: "none", url: url.href, missing: tool.missing, error: tool.error };
  }

  const p = await probe(url.href, { run, timeoutMs });
  if (!p.ok) {
    const shut = ["private", "age_gate", "paywall", "login", "gone"].includes(p.cannot);
    return {
      ok: false, tier: "none", url: url.href, ...p, listen_tier: ears,
      ...(shut ? { note: "Listening to it would not get in either — the audio is behind the same gate. This is the answer, not a reason to try another way." } : {}),
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
  const laidOut = (cues) => layOutTranscript(cues, { from, to, maxChars });

  const result = (tier, how, cues, extra = {}) => {
    const laid = laidOut(cues);
    return {
      ok: true, tier, how: how + BLIND,
      ...base,
      asked_for: laid.window ? `${timecode(laid.window.from)}–${timecode(laid.window.to)}` : undefined,
      covers: laid.covers,
      transcript: laid.transcript,
      ...(laid.trimmed ? { trimmed: laid.trimmed } : {}),
      listen_tier: ears,
      ...extra,
      ...(question ? { question } : {}),
    };
  };

  // --- the listen tier, when it was asked for or when there are nothing but pictures to read ---
  const mustListen = wantListen || !track;
  let listened = null;
  if (mustListen) {
    listened = await listen(url.href, { meta, run, transcriber: ear, status: ears, maxMinutes, timeoutMs });
    if (listened.ok) {
      return result("listen", `listened to this video's audio and had it transcribed${listened.model ? ` by ${listened.model}` : ""}${listened.cached ? ", from a transcript already made for it" : ""}. These are machine-heard words, so names and numbers can be wrong — do not quote them as exact.`, listened.cues, {
        heard: {
          source: "audio",
          language: listened.language || undefined,
          model: listened.model || undefined,
          cached: !!listened.cached,
          total_lines: listened.cues.length,
          full_length: `${timecode(listened.cues[0].at)}–${timecode(listened.cues.at(-1).at)}`,
          ...(listened.no_timestamps ? { no_timestamps: "The transcriber returned no per-line times, so everything is parked at 0:00. Do not quote a timestamp off this." } : {}),
        },
        captions: null,
      });
    }
  }

  // --- the captions tier ---
  if (track) {
    const got = await captions(url.href, { lang: track.lang, auto: track.source !== "creator", run, timeoutMs });
    if (got.ok) {
      const cues = parseCaptions(got.text);
      if (cues.length) {
        const words = SOURCE_WORDS[track.source] ?? SOURCE_WORDS.auto;
        return result("captions", `read the captions. These are ${words}.`, cues, {
          captions: {
            source: track.source,
            language: track.lang,
            ...(track.not_english ? { not_english: `There is no English caption track. This is ${track.lang}.` } : {}),
            ...(track.spoken ? { spoken_language: track.spoken } : {}),
            total_lines: cues.length,
            full_length: `${timecode(cues[0].at)}–${timecode(cues.at(-1).at)}`,
          },
          // Asked to listen, could not, read instead. Said out loud rather than passed off.
          ...(listened && !listened.ok ? { listen_failed: listened.error ?? listened.why } : {}),
        });
      }
    }
    // Captions are listed but unusable. Say which, and what listening said if it was tried.
    return {
      ok: true, tier: "metadata",
      how: `did NOT read or listen to this video. It lists ${track.source === "creator" ? "creator" : "auto-generated"} captions in ${track.lang}, but they could not be used, so all that came back is what the page says about itself.`,
      ...base, captions: null, listen_tier: ears,
      error: got.ok ? `The ${track.lang} caption file came back with no readable lines.` : got.error,
      ...(listened && !listened.ok ? { listen_failed: listened.error ?? listened.why } : {}),
      note: "Say that you could not get at what is actually said, and what stopped you. Do not guess at the content from the title or the description.",
    };
  }

  // --- nothing written down, and listening did not happen ---
  const why = listened?.error ?? ears.why;
  return {
    ok: true, tier: "metadata",
    how: "did NOT read or listen to this video. It has no captions at all — not the creator's and not auto-generated — so all that came back is what the page says about itself: the title, who posted it, how long it is, its description and its chapters.",
    ...base,
    captions: null,
    listen_tier: ears,
    error: why,
    note: `There are no captions on this video, so the only way to know what is said is to listen to the audio, and that did not happen: ${why} `
      + "Say that straight: you can tell them the title, the channel, the length and what the description claims, and no more. Do not infer the content from the title.",
  };
}
