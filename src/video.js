// Watching a video, in two tiers — and the result always says which one answered.
//
// Tier 1, the transcript tier, is what runs today: yt-dlp hands back the video's own metadata and
// its captions, and Reason reads those. That is reading, not watching, and the difference matters:
// a transcript cannot tell you what was on screen, who was in the shot, or what the chart showed.
// Every result therefore carries a `tier` and a plain-English `how`, so the model has the honest
// sentence in front of it rather than having to remember which one it used.
//
// Tier 2, the watch tier, is a provider that takes the video itself. The interface is here and the
// request is written from Google's current docs, but with no GEMINI_API_KEY on the machine it does
// not run and says so in words Reason can repeat. Nothing here has ever been answered by a real
// provider — see docs/unverified.md.
//
// No video or audio is ever downloaded: metadata and subtitle tracks only, with --skip-download on
// every invocation. Nothing here works around an age gate, a login, a paywall or a region block
// either; those come back as the reason the video could not be read.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Is the tool even here?
// ---------------------------------------------------------------------------

// yt-dlp is an ordinary program on the PATH, not a library, so it can simply be absent. The
// capabilities tool is asked this every turn, so the answer is found without spawning anything and
// cached: a PATH scan, which is what a shell would do.
let found;
export function findYtDlp({ recheck = false } = {}) {
  if (found !== undefined && !recheck) return found;
  const named = process.env.REASON_YTDLP_BIN;
  if (named) { found = existsSync(named) ? named : null; return found; }
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  found = dirs.map(d => join(d, "yt-dlp")).find(p => existsSync(p)) ?? null;
  return found;
}

/** For the capabilities tool: can the transcript tier run on this machine at all? */
export function transcriptTierStatus({ bin = findYtDlp() } = {}) {
  if (bin) return { ok: true, bin };
  return {
    ok: false,
    missing: ["yt-dlp"],
    error: "yt-dlp is not installed on this machine, and it is what reads a video's captions. "
      + "Reason cannot read any video until it is there. Say that plainly rather than guessing at what a video says.",
  };
}

/** For the capabilities tool and for every result: is the watch tier connected? */
export function watchTierStatus({ apiKey = config.videoWatchKey, model = config.videoWatchModel } = {}) {
  if (apiKey) return { connected: true, provider: "gemini", model };
  return {
    connected: false,
    provider: "gemini",
    missing: ["GEMINI_API_KEY"],
    why: "No video model is connected, so nothing has actually watched the picture. "
      + "Reason read the captions. It cannot tell you what was on screen, who was in shot, or what anything looked like.",
  };
}

/**
 * What the capabilities tool says about video, which is the honest join of two separate things.
 *
 * Reading what a video says and watching what it shows are different capabilities with different
 * requirements, and a model told "video: live" will say "I watched it" after reading a transcript.
 * So the wording never claims the picture was seen unless something can actually see it.
 */
export function videoCapability({ tool = transcriptTierStatus(), eyes = watchTierStatus() } = {}) {
  if (!tool.ok && !eyes.connected) {
    return {
      status: "not connected",
      what: `Reason cannot read or watch any video on this machine: yt-dlp is not installed, and no video model is connected (needs ${eyes.missing.join(", ")}). Do not offer to.`,
    };
  }
  if (!tool.ok) {
    return {
      status: "live",
      what: `watch a video with ${eyes.model} and answer from it. Captions cannot be read on this machine — yt-dlp is not installed — so there are no timestamps off a transcript`,
    };
  }
  if (eyes.connected) {
    return {
      status: "live",
      what: "go to a video (YouTube and many other sites), read its title, channel, length, description, chapters and captions with timestamps, and answer questions about it — "
        + `and when the picture matters, actually watch it with ${eyes.model}. The result says which of the two answered, every time`,
    };
  }
  return {
    status: "live",
    what: "go to a video (YouTube and many other sites) and read what it SAYS: title, channel, length, description, chapters, and its captions with timestamps — creator-written when there are any, auto-generated otherwise. "
      + `That is reading, not watching: nothing looks at the picture, so you cannot say what was on screen, who was in shot or what a chart showed. Watching needs ${eyes.missing.join(", ")}, which this machine does not have. `
      + "A video with no captions at all cannot be read either, and an age gate, a login or a region block is reported rather than worked around",
  };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * One yt-dlp invocation. Injectable: every caller takes `run`, so the tests drive the real parsing
 * and trimming against fixture captions without touching the network.
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

// The flags that keep this honest. --skip-download on every call: Reason never pulls down video or
// audio, only the text a site already publishes about itself.
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
  const dir = mkdtempSync(join(tmpdir(), "reason-video-"));
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

// ---------------------------------------------------------------------------
// Tier 2: a provider that takes the video itself
// ---------------------------------------------------------------------------

/**
 * Google's Gemini API accepts a YouTube URL as a file_data part and looks at the video itself.
 *
 * Written from ai.google.dev/gemini-api/docs/generate-content/video-understanding as of
 * 2026-10-05: POST to models/<model>:generateContent, the key in an `x-goog-api-key` header, the
 * URL as `file_data.file_uri`, and a time range as `video_metadata.start_offset` / `end_offset` in
 * seconds-with-an-s. Public videos only — the API cannot see a private or unlisted one either.
 *
 * NEVER RUN. There is no GEMINI_API_KEY on this machine, so this function has only ever been
 * exercised against an injected fetch. docs/unverified.md says so.
 */
export async function watchWithGemini(url, {
  question, from = null, to = null,
  apiKey = config.videoWatchKey, model = config.videoWatchModel,
  fetchImpl = fetch, timeoutMs = config.videoWatchTimeoutMs,
} = {}) {
  const status = watchTierStatus({ apiKey, model });
  if (!status.connected) return { ok: false, ...status };

  const part = { file_data: { file_uri: url } };
  if (from !== null || to !== null) {
    part.video_metadata = {
      ...(from !== null ? { start_offset: `${Math.floor(from)}s` } : {}),
      ...(to !== null ? { end_offset: `${Math.floor(to)}s` } : {}),
    };
  }
  const ask = question
    ? `${question}\n\nAnswer only from this video. Give a timestamp (M:SS) for anything you point at. Say so if the video does not cover it.`
    : "What does this video cover? Give the gist, then the main points in order with a timestamp (M:SS) for each, and anything it recommends or any steps it gives.";

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${config.videoWatchBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ac.signal,
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: ask }, part] }] }),
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, connected: true, provider: "gemini", model, error: `The video model refused: ${res.status} ${res.statusText}. ${body.slice(0, 300)}` };
    }
    let json;
    try { json = JSON.parse(body); } catch { return { ok: false, connected: true, provider: "gemini", model, error: "The video model answered with something that was not JSON." }; }
    const said = (json?.candidates?.[0]?.content?.parts ?? []).map(p => p?.text).filter(Boolean).join("\n").trim();
    if (!said) {
      const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "it returned no text";
      return { ok: false, connected: true, provider: "gemini", model, error: `The video model watched nothing back: ${why}.` };
    }
    return { ok: true, connected: true, provider: "gemini", model, said, usage: json?.usageMetadata ?? undefined };
  } catch (e) {
    const why = e.name === "AbortError" ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : e.message;
    return { ok: false, connected: true, provider: "gemini", model, error: `Could not reach the video model: ${why}.` };
  } finally {
    clearTimeout(timer);
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
 * Order of business: check the tool exists, read the metadata, pick a caption track, read it, lay
 * it out with timestamps, and tell the model which tier answered. The watch tier is asked when the
 * caller says the picture matters or when there are no captions at all — and when it is not
 * connected, that is said in a sentence Reason can repeat rather than left to be inferred.
 */
export async function videoUnderstand(rawUrl, {
  question = "", from: rawFrom = null, to: rawTo = null, watch = false, lang = "en",
  maxChars = config.videoTranscriptChars,
  run = runYtDlp, watcher = watchWithGemini, bin = findYtDlp(),
  apiKey = config.videoWatchKey, model = config.videoWatchModel,
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

  const tool = transcriptTierStatus({ bin });
  const tier2 = watchTierStatus({ apiKey, model });

  // No yt-dlp: the transcript tier cannot run at all. If a video model were connected it could
  // still answer, so that is tried rather than refusing outright.
  if (!tool.ok) {
    if (!tier2.connected) {
      return { ok: false, tier: "none", url: url.href, missing: [...tool.missing, ...tier2.missing], error: `${tool.error} ${tier2.why}` };
    }
    const w = await watcher(url.href, { question, from, to, apiKey, model });
    return w.ok
      ? { ok: true, tier: "watch", how: `watched the video with ${w.provider} (${w.model}). The captions were not read: ${tool.error}`, url: url.href, watched: w.said, usage: w.usage, watch_tier: tier2 }
      : { ok: false, tier: "none", url: url.href, error: `${tool.error} And the video model did not answer: ${w.error}` };
  }

  const p = await probe(url.href, { run, timeoutMs });
  if (!p.ok) {
    // A gate, a login, a paywall or a region block stops the watch tier too — Gemini only takes
    // public videos. So the answer is "no", not "no, but I could try the other way".
    const eyesWouldNotHelp = ["private", "age_gate", "paywall", "login", "gone"].includes(p.cannot);
    return {
      ok: false, tier: "none", url: url.href, ...p, watch_tier: tier2,
      ...(eyesWouldNotHelp ? { note: "A video model would not get in either — those only take public videos. This is the answer, not a reason to try another way." } : {}),
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
  const needsEyes = watch || !track;

  let watched = null;
  if (needsEyes && tier2.connected) {
    const w = await watcher(url.href, { question, from, to, apiKey, model });
    if (w.ok) watched = w;
  }

  // Nothing written down anywhere. Say what that means instead of guessing at the content.
  if (!track) {
    if (watched) {
      return {
        ok: true, tier: "watch",
        how: `watched the video with ${watched.provider} (${watched.model}). It has no captions at all, so nothing was read.`,
        ...base, captions: null, watched: watched.said, usage: watched.usage, watch_tier: tier2,
      };
    }
    return {
      ok: true, tier: "metadata",
      how: "did NOT read or watch this video. It has no captions — not the creator's and not auto-generated — so all that came back is what the page says about itself: the title, who posted it, how long it is, its description and its chapters.",
      ...base,
      captions: null,
      watch_tier: tier2,
      note: tier2.connected
        ? "There are no captions, and the video model did not come back either. Say that you could not get at what the video actually says."
        : `There are no captions on this video, and no video model is connected, so there is no way to know what is in it. ${tier2.why} Say that straight: you can tell them the title, the channel, the length and what the description claims, and no more. Do not infer the content from the title.`,
    };
  }

  const got = await captions(url.href, { lang: track.lang, auto: track.source !== "creator", run, timeoutMs });
  if (!got.ok) {
    return {
      ok: true, tier: "metadata",
      how: `did NOT read this video. It lists ${track.source === "creator" ? "creator" : "auto-generated"} captions in ${track.lang}, but fetching them failed, so only what the page says about itself came back.`,
      ...base, captions: null, watch_tier: tier2,
      error: got.error,
      note: "Say that you could not get the captions and what the error was. Do not guess at the content from the title or the description.",
    };
  }

  const cues = parseCaptions(got.text);
  if (!cues.length) {
    return {
      ok: true, tier: "metadata",
      how: `did NOT read this video. Its ${track.lang} caption file came back empty, so only what the page says about itself is here.`,
      ...base, captions: { source: track.source, language: track.lang }, watch_tier: tier2,
      note: "The caption file had no readable lines. Say that rather than guessing at the content.",
    };
  }

  const laid = layOutTranscript(cues, { from, to, maxChars });
  const words = SOURCE_WORDS[track.source] ?? SOURCE_WORDS.auto;

  return {
    ok: true,
    tier: watched ? "watch" : "transcript",
    how: watched
      ? `watched the video with ${watched.provider} (${watched.model}), and also read its ${words}.`
      : `read the captions, not the picture. These are ${words}. Nothing watched this video, so you do not know what was on screen, who was in shot, what anything looked like, or what any chart or demo showed. Say "read" or "went through", never "watched" or "saw".`,
    ...base,
    captions: {
      source: track.source,
      language: track.lang,
      ...(track.not_english ? { not_english: `There is no English caption track. This is ${track.lang}.` } : {}),
      ...(track.spoken ? { spoken_language: track.spoken } : {}),
      total_lines: cues.length,
      full_length: cues.length ? `${timecode(cues[0].at)}–${timecode(cues.at(-1).at)}` : null,
    },
    asked_for: laid.window ? `${timecode(laid.window.from)}–${timecode(laid.window.to)}` : undefined,
    covers: laid.covers,
    transcript: laid.transcript,
    ...(laid.trimmed ? { trimmed: laid.trimmed } : {}),
    ...(watched ? { watched: watched.said, usage: watched.usage } : {}),
    watch_tier: tier2,
    ...(question ? { question } : {}),
  };
}
