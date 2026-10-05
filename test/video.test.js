// Going to a video, without the network and without a key.
//
// The thing under test is not "does yt-dlp work" — it is every promise the tool makes about what it
// did: which tier answered, that neither tier ever claims to have watched anything, that a long
// video says what was left out and can be asked again for it, that listening downloads audio only
// and deletes it, that a transcript is never paid for twice, that an over-long video is refused
// rather than part-heard, that a blocked video reports the block, and that it all leaves a receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTED, WATCHING, fakeTranscriber, fakeVideoModel, fakeYtDlp, fixture, longCaptions, meta } from "./fixture-video.js";

const dir = mkdtempSync(join(tmpdir(), "reason-video-test-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_AUDIO_TMP = join(dir, "audio-tmp");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
// Nothing here may pick up a real key, and nothing here may find a real binary. No test in this
// file ever reaches Google: the video model is injected, always.
process.env.GEMINI_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.REASON_TRANSCRIBER = "";
process.env.REASON_YTDLP_BIN = "";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const video = await import("../src/video.js");
const transcribe = await import("../src/transcribe.js");
const gemini = await import("../src/gemini.js");

const C = "dm:video";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

const CREATOR = "https://www.youtube.com/watch?v=aircAruvnKk";
const AUTO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const LONG = "https://www.youtube.com/watch?v=threehours";

// The videos that have captions. Anything caption-less gets its own id through silent() below.
const library = () => ({
  [CREATOR]: { meta: meta("creator.meta.json"), captions: { en: fixture("creator.en.vtt") }, audio: true },
  [AUTO]: { meta: meta("auto.meta.json"), captions: { en: fixture("auto.en.vtt") }, audio: true },
  [LONG]: { meta: meta("long.meta.json"), captions: { en: longCaptions() }, audio: true },
});

/** The tool, with the fake yt-dlp injected and NO video model connected. */
const call = (input, extra = {}) =>
  runTool("video_understand", input, { conversationId: C, videoRun: fakeYtDlp(library()), videoModel: null, videoTranscriber: null, ...extra });

/** The tool, with a fake video model that really is connected. */
const withModel = (input, { brain = fakeVideoModel(), run = fakeYtDlp(library()), ...extra } = {}) =>
  runTool("video_understand", input, {
    conversationId: C, videoRun: run, videoModel: brain, videoModelStatus: WATCHING, videoTranscriber: null, ...extra,
  });

const audioLeftOnDisk = () => {
  const root = join(dir, "audio-tmp");
  return existsSync(root) ? readdirSync(root) : [];
};

/**
 * A caption-less video of its own, because transcripts are cached by video id on purpose: two tests
 * pointed at one video would have the second one answered off the first one's transcript. Each test
 * that listens gets its own id, which is also how it works in life.
 */
const silent = (id, over = {}) => {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const m = { ...meta("nocaptions.meta.json"), id, webpage_url: url, ...over };
  return { url, lib: { [url]: { meta: m, captions: {}, audio: true } } };
};

// ---------------------------------------------------------------------------
// Tier 1: the captions
// ---------------------------------------------------------------------------

test("creator captions: real timestamped lines, and the tier says the captions were read", async () => {
  const r = await call({ url: CREATOR });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "captions");
  assert.equal(r.captions.source, "creator");
  assert.equal(r.captions.language, "en");
  assert.equal(r.title, "But what is a neural network? | Deep learning chapter 1");
  assert.equal(r.channel, "3Blue1Brown");
  assert.equal(r.duration, "18:40");
  assert.equal(r.uploaded, "2017-10-05");
  assert.deepEqual(r.chapters.slice(0, 2), ["0:00 Introduction example", "1:01 Series preview"]);

  // A line the fixture really contains, with the clock time it really happens at.
  assert.match(r.transcript, /^\[0:04\] This is a 3\.$/m);
  assert.match(r.transcript, /\[0:14\]/);

  assert.match(r.how, /^read the captions/);
  assert.match(r.how, /Never say "watched" or "saw"/);
});

test("auto captions: labelled as auto, and the rolling repeats are gone", async () => {
  const r = await call({ url: AUTO });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "captions");
  assert.equal(r.captions.source, "auto");
  assert.match(r.how, /auto-generated captions/);
  assert.match(r.how, /names and numbers can be wrong/);

  // YouTube's auto track repeats every line as the words crawl up the screen. Each one once.
  const said = r.transcript.split("\n").map(l => l.replace(/^\[[\d:]+\] /, ""));
  assert.equal([...new Set(said)].length, said.length, `repeated lines survived:\n${r.transcript}`);
  // The per-word timing tags are not content.
  assert.doesNotMatch(r.transcript, /<c>|<\/c>|<\d\d:\d\d/);
  assert.match(r.transcript, /We're no strangers to/);
  assert.match(r.transcript, /\[0:00\] \[Music\]/);
});

// ---------------------------------------------------------------------------
// Tier 2: a model that takes the video
// ---------------------------------------------------------------------------

test("a YouTube link with no captions is WATCHED, and the tier says so", async () => {
  const { url, lib } = silent("watched");
  const brain = fakeVideoModel();
  const run = fakeYtDlp(lib);
  const r = await withModel({ url, question: "which junction box does he use" }, { brain, run });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "watch");
  assert.equal(r.captions, null);
  assert.equal(r.watched.by, "fake-vision");
  assert.equal(r.watched.saw, "the video");
  assert.equal(r.watched.cached, false);
  assert.equal(r.heard, undefined);
  assert.match(r.account, /Wide shot of a shed interior/);
  assert.match(r.account, /^\[0:12\]/m);

  // This is the one tier where saying "watched" is true, and the how line says so.
  assert.match(r.how, /^WATCHED this video/);
  assert.match(r.how, /You may say you watched it/);
  assert.doesNotMatch(r.how, /Never say "watched"/);

  // The link was handed over whole. Nothing was downloaded.
  const watchCall = brain.calls.find(c => c.kind === "watch");
  assert.ok(watchCall, "a YouTube link must go to watchUrl, not through the audio path");
  assert.equal(watchCall.url, url);
  assert.equal(watchCall.opts.question, "which junction box does he use");
  assert.equal(brain.calls.some(c => c.kind === "listen"), false);
  assert.ok(run.calls.every(a => a.includes("--skip-download")), "a watched YouTube video needs no download");
  assert.deepEqual(audioLeftOnDisk(), []);
});

test("a video on another site can only be LISTENED to, and the tier says that instead", async () => {
  const url = "https://vimeo.com/987654321";
  const lib = { [url]: { meta: { ...meta("nocaptions.meta.json"), id: "987654321", extractor_key: "Vimeo", webpage_url: url }, captions: {}, audio: true } };
  const brain = fakeVideoModel();
  const r = await withModel({ url }, { brain, run: fakeYtDlp(lib) });

  assert.equal(r.tier, "listen");
  assert.equal(r.heard.saw, "the audio only");
  assert.equal(r.watched, undefined);
  assert.match(r.account, /Right, so the first thing is the junction box/);

  assert.match(r.how, /^LISTENED to this video's audio/);
  assert.match(r.how, /nothing looked at the picture/);
  assert.match(r.how, /Say "listened", never "watched"/);

  assert.equal(brain.calls.filter(c => c.kind === "listen").length, 1);
  assert.equal(brain.calls.some(c => c.kind === "watch"), false, "only YouTube may be handed over as a URL");
});

test("listening downloads the AUDIO ONLY, hands over a real file, and deletes it", async () => {
  const url = "https://vimeo.com/audioonly";
  const lib = { [url]: { meta: { id: "audioonly", extractor_key: "Vimeo", webpage_url: url, duration: 742, title: "Shed" }, captions: {}, audio: true } };
  const brain = fakeVideoModel();
  const run = fakeYtDlp(lib);
  await withModel({ url }, { brain, run });

  // The download call asked for an audio format and never for a video stream.
  const download = run.calls.find(a => !a.includes("--skip-download") && !a.includes("-J"));
  assert.ok(download, "there must be exactly one call that downloads something");
  assert.equal(download[download.indexOf("-f") + 1], "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio");
  assert.ok(!download.includes("--extract-audio"), "--extract-audio needs ffmpeg and must not be used");

  // The model was handed a file that really existed and really had bytes in it.
  const heard = brain.calls.find(c => c.kind === "listen");
  assert.equal(heard.existed, true, "the audio must be on disk when the model is called");
  assert.equal(heard.bytes, 844, "the tiny fixture WAV, byte for byte");
  assert.equal(heard.opts.mime, "audio/wav", "the mime type has to be one Gemini's docs list");

  // And it is gone afterwards.
  assert.equal(existsSync(heard.file), false, "the audio file must be deleted");
  assert.deepEqual(audioLeftOnDisk(), [], "no scratch directory may be left behind");
});

test("the temp audio is deleted even when the model fails", async () => {
  const url = "https://vimeo.com/fallsover";
  const lib = { [url]: { meta: { id: "fallsover", extractor_key: "Vimeo", webpage_url: url }, captions: {}, audio: true } };
  const brain = fakeVideoModel({ error: "Gemini refused: 500 Internal Server Error." });
  const r = await withModel({ url }, { brain, run: fakeYtDlp(lib) });

  assert.equal(r.tier, "metadata");
  assert.match(r.error, /500 Internal Server Error/);
  const heard = brain.calls.find(c => c.kind === "listen");
  assert.equal(heard.existed, true);
  assert.equal(existsSync(heard.file), false, "a failed transcription must still clean up");
  assert.deepEqual(audioLeftOnDisk(), []);
});

test("a provider error on a watched video is readable, not swallowed", async () => {
  const { url, lib } = silent("refused");
  const brain = fakeVideoModel({ error: "Gemini refused: 429 Too Many Requests. {\"error\":\"quota\"}" });
  const r = await withModel({ url }, { brain, run: fakeYtDlp(lib) });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.match(r.error, /429 Too Many Requests/);
  assert.match(r.note, /Do not infer the content from the title/);
  // The metadata it did get is still usable.
  assert.equal(r.title, "Workshop: rewiring the shed lights");
});

test("the second ask for the same video spends nothing: cached account, no call, no download", async () => {
  const { url, lib } = silent("cacheme");

  const firstBrain = fakeVideoModel();
  const firstRun = fakeYtDlp(lib);
  const first = await withModel({ url }, { brain: firstBrain, run: firstRun });
  assert.equal(first.tier, "watch");
  assert.equal(first.watched.cached, false);
  assert.equal(firstBrain.calls.length, 1);

  const secondBrain = fakeVideoModel();
  const secondRun = fakeYtDlp(lib);
  const second = await withModel({ url }, { brain: secondBrain, run: secondRun });

  assert.equal(second.tier, "watch");
  assert.equal(second.watched.cached, true, "the second ask must come off the stored account");
  assert.equal(secondBrain.calls.length, 0, "the video model must not be paid twice for one video");
  assert.ok(secondRun.calls.every(a => a.includes("--skip-download")), "nothing may be downloaded twice");
  assert.equal(second.account, first.account);
  assert.match(second.how, /account already made for it/);
});

test("the cache is per tier, so watching and listening do not answer for each other", () => {
  db.saveVideoAccount({ videoKey: "youtube:tiers", tier: "watch", url: "u", text: "saw the picture" });
  assert.equal(db.getVideoAccount("youtube:tiers", "watch").text, "saw the picture");
  assert.equal(db.getVideoAccount("youtube:tiers", "listen"), null);
  db.saveVideoAccount({ videoKey: "youtube:tiers", tier: "listen", url: "u", text: "only heard it" });
  assert.equal(db.getVideoAccount("youtube:tiers", "watch").text, "saw the picture");
  assert.equal(db.getVideoAccount("youtube:tiers", "listen").text, "only heard it");
});

test("a request for one stretch is never cached, so it cannot answer for the whole video", async () => {
  const { url, lib } = silent("ranged");
  const brain = fakeVideoModel();
  const ranged = await withModel({ url, from: "1:00", to: "2:00" }, { brain, run: fakeYtDlp(lib) });

  assert.equal(ranged.tier, "watch");
  assert.equal(ranged.watched.asked_for, "1:00–2:00");
  assert.match(ranged.watched.not_cached, /never cached/);
  assert.deepEqual(brain.calls[0].opts, { question: "", from: 60, to: 120 });

  // Asking for the whole thing afterwards has to be a fresh call, not the range answer again.
  const whole = await withModel({ url }, { brain, run: fakeYtDlp(lib) });
  assert.equal(whole.watched.cached, false, "a stretch must not have been cached as the whole video");
  assert.equal(brain.calls.length, 2);
});

test("a video over the length cap is refused, says the length and the limit, and spends nothing", async () => {
  const { url, lib } = silent("ninety-minutes", { duration: 5400 });
  const brain = fakeVideoModel();
  const run = fakeYtDlp(lib);
  const r = await withModel({ url }, { brain, run, videoMaxMinutes: 20 });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.match(r.error, /1:30:00 long/);
  assert.match(r.error, /only watch 20 minutes/);
  assert.match(r.error, /REASON_VIDEO_MAX_MINUTES/);
  assert.match(r.error, /ask which stretch and pass from and to/);
  assert.equal(brain.calls.length, 0, "an over-long video must not be sent anywhere");
  assert.ok(run.calls.every(a => a.includes("--skip-download")), "an over-long video must not be downloaded");
  assert.deepEqual(audioLeftOnDisk(), []);
});

test("asked to watch when the captions are fine: it watches anyway, and says so", async () => {
  const url = "https://www.youtube.com/watch?v=watch-anyway";
  const lib = { [url]: { meta: { ...meta("auto.meta.json"), id: "watch-anyway", webpage_url: url }, captions: { en: fixture("auto.en.vtt") }, audio: true } };
  const brain = fakeVideoModel();
  const r = await withModel({ url, watch: true }, { brain, run: fakeYtDlp(lib) });

  assert.equal(r.tier, "watch");
  assert.equal(brain.calls.length, 1, "watch: true means actually put it to the model");
  assert.equal(r.captions, null);
});

test("asked to watch with no key: it reads the captions instead and says watching did not happen", async () => {
  const r = await call({ url: AUTO, watch: true });

  assert.equal(r.tier, "captions");
  assert.match(r.model_tier_failed, /GEMINI_API_KEY/);
  assert.match(r.how, /^read the captions/);
  assert.match(r.how, /Never say "watched" or "saw"/);
});

test("captions are preferred when they are there, so nothing is spent", async () => {
  const brain = fakeVideoModel();
  const run = fakeYtDlp(library());
  const r = await withModel({ url: CREATOR }, { brain, run });

  assert.equal(r.tier, "captions");
  assert.equal(brain.calls.length, 0, "a video with captions must not be sent to a paid model");
  assert.ok(run.calls.every(a => a.includes("--skip-download")));
});

test("no captions and no key: readable reason, and it does not guess from the title", async () => {
  const { url, lib } = silent("nokey");
  const r = await runTool("video_understand", { url }, { conversationId: C, videoRun: fakeYtDlp(lib), videoModel: null, videoTranscriber: null });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.equal(r.captions, null);
  assert.equal(r.transcript, undefined);
  assert.equal(r.account, undefined);
  assert.match(r.how, /did NOT read, watch or listen/);
  assert.match(r.how, /no captions at all/);
  // What it DOES have is the page's own account of itself, and it says that is all.
  assert.equal(r.title, "Workshop: rewiring the shed lights");
  assert.equal(r.duration, "12:22");
  assert.match(r.note, /the only way to know what is in it is a model that takes the video itself/);
  assert.match(r.note, /Do not infer the content from the title/);
  assert.equal(r.model_tier.connected, false);
  assert.deepEqual(r.model_tier.missing, ["GEMINI_API_KEY"]);
  assert.match(r.model_tier.why, /the picture can never be described/);
});

test("the OPTIONAL transcriber, when somebody configures one, does the audio instead of Gemini", async () => {
  const url = "https://vimeo.com/optional-stt";
  const lib = { [url]: { meta: { id: "optional-stt", extractor_key: "Vimeo", webpage_url: url }, captions: {}, audio: true } };
  const brain = fakeVideoModel();
  const ear = fakeTranscriber();
  const r = await runTool("video_understand", { url }, {
    conversationId: C, videoRun: fakeYtDlp(lib),
    videoModel: brain, videoModelStatus: WATCHING, videoTranscriber: ear,
  });

  assert.equal(r.tier, "listen");
  assert.equal(ear.seen.length, 1, "the configured transcriber is what should run");
  assert.equal(brain.calls.length, 0, "Gemini must not also be paid for the same audio");
  // Its cues are laid out the same way captions are, so the shape is interchangeable.
  assert.match(r.account, /^\[0:00\] Right, so the first thing is the junction box\.$/m);
  assert.match(r.account, /^\[0:41\]/m);
  assert.equal(existsSync(ear.seen[0].file), false, "and the audio is still deleted");
});


// ---------------------------------------------------------------------------
// A long video: cut short, loudly, with a way to read the rest
// ---------------------------------------------------------------------------

test("three hours comes back trimmed, says exactly what is missing, and names the follow-up", async () => {
  const r = await call({ url: LONG });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "captions");
  assert.equal(r.duration, "3:00:00");
  assert.ok(r.trimmed, "a three-hour transcript must report that it was cut");
  assert.ok(r.transcript.length <= 20_000, `transcript was ${r.transcript.length} chars`);
  assert.ok(r.trimmed.dropped_lines > 3000, `only ${r.trimmed.dropped_lines} lines reported dropped`);

  assert.match(r.covers, /^0:00–/);
  assert.match(r.trimmed.missing, /–2:59:5\d$/);
  assert.match(r.trimmed.note, /Do not say anything about the part you do not have/);
  assert.match(r.trimmed.note, /call video_understand again on the same url with from and to/);
  assert.match(r.captions.full_length, /^0:00–2:59:5\d$/);
});

test("the time-range follow-up really reads the stretch that was cut off", async () => {
  const r = await call({ url: LONG, from: "2:30:00", to: "2:35:00" });

  assert.equal(r.ok, true);
  assert.equal(r.asked_for, "2:30:00–2:35:00");
  assert.equal(r.trimmed, undefined, "five minutes fits, so nothing should be cut");
  assert.match(r.transcript, /^\[2:30:00\]/m);
  assert.match(r.transcript, /\[2:34:57\]/);
  assert.doesNotMatch(r.transcript, /^\[0:00\]/m);
  assert.doesNotMatch(r.transcript, /\[2:35:03\]/);
});

test("a time range that is not a time, or runs backwards, is refused rather than guessed at", async () => {
  const bad = await call({ url: LONG, from: "halfway through" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Could not read 'halfway through' as a time/);

  const backwards = await call({ url: LONG, from: "10:00", to: "2:00" });
  assert.equal(backwards.ok, false);
  assert.match(backwards.error, /has to be after/);
});

// ---------------------------------------------------------------------------
// The things it cannot get, reported as the reason
// ---------------------------------------------------------------------------

test("a URL that is not a video says so and points at web_lookup", async () => {
  const r = await call({ url: "https://example.com/about-us" });
  assert.equal(r.ok, false);
  assert.equal(r.cannot, "not_a_video");
  assert.match(r.error, /not a video page/);
  assert.match(r.error, /web_lookup/);
});

test("not a URL at all", async () => {
  const r = await call({ url: "that video kofi sent" });
  assert.equal(r.ok, false);
  assert.match(r.error, /is not a URL/);
});

test("private, age-gated, members-only and region-blocked each come back as the reason", async () => {
  // The last column: would listening get in instead? For a private, gated, members-only or deleted
  // video, no — the audio is behind the same gate — so it is not dangled. A country block is
  // different: it stops this machine, not necessarily a transcriber's servers.
  const cases = [
    ["private", "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", /private video/i, false],
    ["age_gate", "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.", /age-restricted/i, false],
    ["paywall", "ERROR: [youtube] abc: Join this channel to get access to members-only content", /members-only/i, false],
    ["region", "ERROR: [youtube] abc: The uploader has not made this video available in your country", /blocked in this country/i, true],
    ["gone", "ERROR: [youtube] abc: This video is unavailable", /not there any more/i, false],
  ];
  for (const [cannot, stderr, says, earsMightHelp] of cases) {
    const url = `https://www.youtube.com/watch?v=${cannot}`;
    const r = await runTool("video_understand", { url }, {
      conversationId: C, videoTranscriber: null, videoRun: fakeYtDlp({ [url]: { metaError: stderr } }),
    });
    assert.equal(r.ok, false, cannot);
    assert.equal(r.cannot, cannot, cannot);
    assert.match(r.error, says);
    // None of these is ever presented as something Reason will get round.
    assert.doesNotMatch(r.error, /try again|work around|bypass/i);
    if (earsMightHelp) assert.equal(r.note, undefined, cannot);
    else assert.match(r.note, /would not get in either/, cannot);
  }
});

test("captions listed but un-fetchable: metadata tier, the error quoted, no guessing", async () => {
  const r = await runTool("video_understand", { url: CREATOR }, {
    conversationId: C, videoTranscriber: null,
    videoRun: fakeYtDlp({ [CREATOR]: { meta: meta("creator.meta.json"), captionError: "ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests" } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.equal(r.captions, null);
  assert.match(r.how, /did NOT read, watch or listen/);
  assert.match(r.error, /429/);
  assert.match(r.note, /Do not guess at the content/);
  // The metadata it did get is still there and still usable.
  assert.equal(r.title, "But what is a neural network? | Deep learning chapter 1");
});

test("the audio download failing is reported, not papered over", async () => {
  const url = "https://vimeo.com/noformat";
  const run = fakeYtDlp({ [url]: { meta: { id: "noformat", extractor_key: "Vimeo", webpage_url: url }, captions: {}, audioError: "ERROR: Requested format is not available" } });
  const brain = fakeVideoModel();
  const r = await withModel({ url }, { brain, run });

  assert.equal(r.tier, "metadata");
  assert.match(r.error, /format is not available/);
  assert.equal(brain.calls.length, 0);
  assert.deepEqual(audioLeftOnDisk(), []);
});

// ---------------------------------------------------------------------------
// yt-dlp missing
// ---------------------------------------------------------------------------

// `bin: null` is the whole of "yt-dlp is not on this machine" — findYtDlp() is a PATH lookup, and
// this machine happens to have it, so the precondition is stated rather than faked.
const NO_BIN = { bin: null, run: async () => { throw new Error("nothing should be run with no binary"); } };

test("yt-dlp missing: nothing about a video can be had, and it says so in plain words", async () => {
  const r = await video.videoUnderstand(CREATOR, { ...NO_BIN, transcriber: null });

  assert.equal(r.ok, false);
  assert.equal(r.tier, "none");
  assert.match(r.error, /yt-dlp is not installed on this machine/);
  assert.match(r.error, /its details, its captions and its audio/);
  assert.deepEqual(r.missing, ["yt-dlp"]);
});

test("capabilities is careful about which of the three it is offering", () => {
  const YES = { ok: true, bin: "/usr/local/bin/yt-dlp" };
  const NO = video.ytDlpStatus({ bin: null });
  const BLIND = gemini.geminiStatus({ apiKey: "" });

  // No yt-dlp: nothing at all, and do not offer it.
  const none = video.videoCapability({ tool: NO, model: BLIND });
  assert.equal(none.status, "not connected");
  assert.match(none.what, /yt-dlp is not installed/);
  assert.match(none.what, /Do not offer to/);

  // Captions only — the state this machine is actually in. Live, but it must never imply it can see.
  const readOnly = video.videoCapability({ tool: YES, model: BLIND });
  assert.equal(readOnly.status, "live");
  assert.match(readOnly.what, /words only: nothing looks at the picture/);
  assert.match(readOnly.what, /NO captions cannot be read at all/);
  assert.match(readOnly.what, /picture can never be described/);
  assert.match(readOnly.what, /GEMINI_API_KEY/);
  assert.doesNotMatch(readOnly.what, /\bwatch/i, "with no model it may not offer watching at all");

  // With a model: watching a YouTube link is real, and the other path is audio only.
  const both = video.videoCapability({ tool: YES, model: WATCHING });
  assert.equal(both.status, "live");
  assert.match(both.what, /a fake video model takes the video itself/);
  assert.match(both.what, /a YouTube link it genuinely WATCHES/);
  assert.match(both.what, /AUDIO TRACK ONLY/);
  assert.match(both.what, /words with no picture/);
  assert.match(both.what, /which of the three it did/);
});

test("the capabilities tool carries the video entry, matching this machine", () => {
  const entry = capabilitiesNow({ conversationId: C }).find(c => c.name === "video");
  assert.ok(entry, "there must be a video capability");
  assert.deepEqual({ status: entry.status, what: entry.what }, video.videoCapability());
  // With no key the entry may never imply anything saw or heard the video.
  assert.match(entry.what, /GEMINI_API_KEY/);
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

test("the receipt names the tier and the model, and says when nothing was spent", async () => {
  // Its own conversation, so the count is this test's calls and nothing else's.
  const L = "dm:video-ledger";
  db.upsertAccount({ conversationId: L, channel: "test", address: "+12025559999", name: "Omari" });
  const yt = silent("receipts-yt");
  const other = {
    url: "https://vimeo.com/receipts-audio",
    lib: { "https://vimeo.com/receipts-audio": { meta: { id: "receipts-audio", extractor_key: "Vimeo", webpage_url: "https://vimeo.com/receipts-audio", title: "On Vimeo" }, captions: {}, audio: true } },
  };
  const seen = (lib, input, extra = {}) => runTool("video_understand", input, {
    conversationId: L, videoRun: fakeYtDlp(lib), videoModel: null, videoTranscriber: null, ...extra,
  });
  const model = () => ({ videoModel: fakeVideoModel(), videoModelStatus: WATCHING });

  await seen(library(), { url: CREATOR });                   // captions
  await seen(yt.lib, { url: yt.url }, model());              // watched
  await seen(yt.lib, { url: yt.url }, model());              // watched, cached
  await seen(other.lib, { url: other.url }, model());        // listened
  await seen(library(), { url: "https://example.com/about-us" });  // nothing

  const rows = db.listActions(L, { limit: 20 }).filter(r => r.action === "video_understand").reverse();
  assert.equal(rows.length, 5, "every call must be on the record");

  assert.equal(rows[0].outcome, "ok");
  assert.match(rows[0].receipt, /Read the creator's captions/);
  assert.match(rows[0].receipt, /Words only; nothing watched it/);

  // The one tier that may say "watched" names the model that did the watching.
  assert.match(rows[1].receipt, /^WATCHED/);
  assert.match(rows[1].receipt, /handed the link to fake-vision/);
  assert.match(rows[1].receipt, /Nothing was downloaded/);

  assert.match(rows[2].receipt, /nothing was spent this time/);

  assert.match(rows[3].receipt, /Downloaded the AUDIO ONLY/);
  assert.match(rows[3].receipt, /transcribed by fake-vision/);
  assert.match(rows[3].receipt, /The audio was deleted/);
  assert.match(rows[3].receipt, /picture was never seen/);

  assert.equal(rows[4].outcome, "error");
  assert.match(rows[4].receipt, /Tried to get at the video/);
  assert.match(rows[4].receipt, /not a video page/);
});

test("a video's thumbnail becomes an address a page may use; nothing else does", async () => {
  const r = await call({ url: CREATOR });
  assert.deepEqual(r.images, ["https://i.ytimg.com/vi/aircAruvnKk/maxresdefault.jpg"]);
  assert.equal(db.hasSeenUrl(C, r.images[0]), true);
  assert.equal(db.hasSeenUrl(C, "https://i.ytimg.com/vi/somethingelse/maxresdefault.jpg"), false);
});

// ---------------------------------------------------------------------------
// The pieces, on their own
// ---------------------------------------------------------------------------

test("an account is keyed to the video, so two sites cannot collide", () => {
  assert.equal(video.videoKeyFor({ extractor_key: "Youtube", id: "abc" }, "u"), "youtube:abc");
  assert.equal(video.videoKeyFor({ extractor_key: "Vimeo", id: "abc" }, "u"), "vimeo:abc");
  assert.notEqual(
    video.videoKeyFor({ extractor_key: "Youtube", id: "abc" }, "u"),
    video.videoKeyFor({ extractor_key: "Vimeo", id: "abc" }, "u"),
  );
});

test("creator captions beat auto captions, and an auto translation says it is one", () => {
  assert.deepEqual(
    video.pickTrack({ subtitles: { en: [] }, automatic_captions: { en: [] } }),
    { lang: "en", source: "creator" },
  );
  assert.deepEqual(
    video.pickTrack({ subtitles: {}, automatic_captions: { en: [] }, language: "en" }),
    { lang: "en", source: "auto", spoken: "en" },
  );
  // English auto-captions on a Japanese video are a machine translating a machine.
  assert.deepEqual(
    video.pickTrack({ subtitles: {}, automatic_captions: { en: [], ja: [] }, language: "ja" }),
    { lang: "en", source: "auto_translated", spoken: "ja" },
  );
  assert.deepEqual(
    video.pickTrack({ subtitles: { "en-GB": [] }, automatic_captions: {} }),
    { lang: "en-GB", source: "creator" },
  );
  // Nothing in English: take what there is and say what it is.
  assert.deepEqual(
    video.pickTrack({ subtitles: { fr: [] }, automatic_captions: {} }),
    { lang: "fr", source: "creator", not_english: true },
  );
  assert.equal(video.pickTrack({ subtitles: {}, automatic_captions: {} }), null);
});

test("timecodes read like a video clock", () => {
  assert.equal(video.timecode(0), "0:00");
  assert.equal(video.timecode(9), "0:09");
  assert.equal(video.timecode(754), "12:34");
  assert.equal(video.timecode(3723), "1:02:03");
});

test("a time range can be written the way a person writes one", () => {
  assert.equal(video.parseTime("12:34"), 754);
  assert.equal(video.parseTime("1:02:03"), 3723);
  assert.equal(video.parseTime("90"), 90);
  assert.equal(video.parseTime("90s"), 90);
  assert.equal(video.parseTime("1h30m"), 5400);
  assert.equal(video.parseTime(0), 0);
  assert.equal(video.parseTime("halfway"), null);
  assert.equal(video.parseTime(""), null);
  assert.equal(video.parseTime(undefined), null);
});

test("an SRT caption file parses too, not only WebVTT", () => {
  const cues = video.parseCaptions([
    "1", "00:00:02,000 --> 00:00:04,000", "First thing.", "",
    "2", "00:01:05,500 --> 00:01:07,000", "Second thing.", "",
  ].join("\n"));
  assert.deepEqual(cues, [{ at: 2, text: "First thing." }, { at: 65.5, text: "Second thing." }]);
});

// ---------------------------------------------------------------------------
// Gemini, on its own
// ---------------------------------------------------------------------------
//
// None of this reaches Google. What it pins is the request shape against what Google's docs
// actually say, because that is the only thing that can be checked without a key — and the thing
// most likely to be silently wrong.

test("with no key there is no video model, and the reason names the variable", () => {
  const s = gemini.geminiStatus({ apiKey: "" });
  assert.equal(s.connected, false);
  assert.deepEqual(s.missing, ["GEMINI_API_KEY"]);
  assert.match(s.why, /nothing can watch a video or listen to its audio/);
  assert.match(s.why, /no captions cannot be read at all/);
  assert.equal(gemini.videoModelFor({ status: s }), null);
});

test("a key turns it on, and the model id is configurable", () => {
  const s = gemini.geminiStatus({ apiKey: "k", model: "gemini-3.6-flash" });
  assert.equal(s.connected, true);
  assert.equal(s.provider, "gemini");
  assert.equal(s.model, "gemini-3.6-flash");
  assert.equal(typeof gemini.videoModelFor({ status: s }).watchUrl, "function");
});

test("with no key, nothing is sent anywhere", async () => {
  let called = false;
  const p = gemini.geminiProvider({ apiKey: "", fetchImpl: async () => { called = true; } });
  const w = await p.watchUrl(CREATOR, {});
  const l = await p.transcribeFile("test/fixtures/video/tiny.wav", {});
  assert.equal(w.ok, false);
  assert.equal(l.ok, false);
  assert.deepEqual(w.missing, ["GEMINI_API_KEY"]);
  assert.equal(called, false);
});

test("a YouTube URL goes over as a file_data part, the shape their docs document", async () => {
  let sent;
  const p = gemini.geminiProvider({
    apiKey: "k", model: "gemini-3.8-flash",
    fetchImpl: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: "[0:00] A shed." }] } }], usageMetadata: { totalTokenCount: 9000 },
      }) };
    },
  });
  const r = await p.watchUrl("https://www.youtube.com/watch?v=abc", { question: "what box does he use" });

  assert.equal(r.ok, true);
  assert.equal(r.text, "[0:00] A shed.");
  assert.equal(r.saw, "video");
  assert.equal(r.usage.totalTokenCount, 9000);

  assert.equal(sent.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(sent.init.headers["x-goog-api-key"], "k");
  const [text, file] = sent.body.contents[0].parts;
  assert.deepEqual(file.file_data, { file_uri: "https://www.youtube.com/watch?v=abc" });
  assert.equal(file.video_metadata, undefined, "no range asked for, so no video_metadata");
  // What it asks for: both halves, and real times.
  assert.match(text.text, /what is SAID and what is SHOWN/);
  assert.match(text.text, /\[M:SS\]/);
  assert.match(text.text, /Never invent a time/);
  assert.match(text.text, /what box does he use/);
});

test("a time range rides on the part as start_offset / end_offset in seconds", async () => {
  let body;
  const p = gemini.geminiProvider({
    apiKey: "k",
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }) };
    },
  });
  await p.watchUrl("https://www.youtube.com/watch?v=abc", { from: 1250, to: 1570 });
  assert.deepEqual(body.contents[0].parts[1].video_metadata, { start_offset: "1250s", end_offset: "1570s" });
});

test("audio goes through the Files API: resumable start, bytes, then a file_data part with its mime", async () => {
  const seen = [];
  const p = gemini.geminiProvider({
    apiKey: "k", model: "gemini-3.8-flash", pollMs: 1, maxPolls: 5,
    fetchImpl: async (url, init = {}) => {
      seen.push({ url, init });
      // 1. start the resumable upload
      if (url.endsWith("/upload/v1beta/files")) {
        return { ok: true, status: 200, statusText: "OK", headers: { get: (h) => h === "x-goog-upload-url" ? "https://upload.example/session-1" : null }, text: async () => "" };
      }
      // 2. the bytes
      if (url === "https://upload.example/session-1") {
        return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ file: { name: "files/abc", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", state: "PROCESSING" } }) };
      }
      // 3. polled until ACTIVE
      if (url.endsWith("/v1beta/files/abc")) {
        return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ state: "ACTIVE" }) };
      }
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "[0:00] Someone talking." }] } }] }) };
    },
  });
  const r = await p.transcribeFile("test/fixtures/video/tiny.wav", { question: "what does he say about the box" });

  assert.equal(r.ok, true);
  assert.equal(r.text, "[0:00] Someone talking.");
  assert.equal(r.saw, "audio");
  assert.equal(r.uploaded_bytes, 844);

  // The start request, header for header.
  const start = seen[0];
  assert.equal(start.init.headers["X-Goog-Upload-Protocol"], "resumable");
  assert.equal(start.init.headers["X-Goog-Upload-Command"], "start");
  assert.equal(start.init.headers["X-Goog-Upload-Header-Content-Length"], "844");
  assert.equal(start.init.headers["X-Goog-Upload-Header-Content-Type"], "audio/wav");
  assert.deepEqual(JSON.parse(start.init.body), { file: { display_name: "tiny.wav" } });

  // The bytes.
  const bytes = seen[1];
  assert.equal(bytes.url, "https://upload.example/session-1");
  assert.equal(bytes.init.headers["X-Goog-Upload-Offset"], "0");
  assert.equal(bytes.init.headers["X-Goog-Upload-Command"], "upload, finalize");
  assert.equal(bytes.init.body.length, 844);

  // A file that is still PROCESSING is waited for, not used.
  assert.ok(seen.some(s => s.url.endsWith("/v1beta/files/abc")), "a PROCESSING file must be polled");

  // And then referenced with its mime type, which is what their audio docs require.
  const gen = seen.at(-1);
  assert.match(gen.url, /:generateContent$/);
  const [text, file] = JSON.parse(gen.init.body).contents[0].parts;
  assert.deepEqual(file.file_data, { mime_type: "audio/wav", file_uri: "https://generativelanguage.googleapis.com/v1beta/files/abc" });
  // The audio prompt must forbid anything visual, because there is no picture in an audio file.
  assert.match(text.text, /AUDIO ONLY/);
  assert.match(text.text, /Do not describe anything visual/);
  assert.match(text.text, /what does he say about the box/);
});

test("a file stuck in PROCESSING is reported rather than used", async () => {
  const p = gemini.geminiProvider({
    apiKey: "k", pollMs: 1, maxPolls: 3,
    fetchImpl: async (url) => {
      if (url.endsWith("/upload/v1beta/files")) return { ok: true, headers: { get: () => "https://upload.example/s" }, text: async () => "" };
      if (url === "https://upload.example/s") return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ file: { name: "files/x", uri: "u", state: "PROCESSING" } }) };
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ state: "PROCESSING" }) };
    },
  });
  const r = await p.transcribeFile("test/fixtures/video/tiny.wav", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /still processing that audio/);
});

test("audio in a format Gemini's docs do not list is refused, with ffmpeg named", async () => {
  let called = false;
  const p = gemini.geminiProvider({ apiKey: "k", fetchImpl: async () => { called = true; } });
  const r = await p.transcribeFile("/tmp/whatever.aiffx", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /does not take/);
  assert.match(r.error, /wav, mp3, aiff, aac, ogg, flac, mpeg, m4a, opus and webm/);
  assert.equal(called, false);
  // The ones yt-dlp actually hands back ARE on the list.
  assert.equal(gemini.audioMimeFor("audio.m4a"), "audio/m4a");
  assert.equal(gemini.audioMimeFor("audio.webm"), "audio/webm");
  assert.equal(gemini.audioMimeFor("audio.opus"), "audio/opus");
  assert.equal(gemini.audioMimeFor("audio.mkv"), null);
});

test("Gemini refusing, timing out, or saying nothing all come back readable", async () => {
  const refused = await gemini.geminiProvider({
    apiKey: "k",
    fetchImpl: async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => '{"error":"quota"}' }),
  }).watchUrl(CREATOR, {});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Gemini refused: 429/);

  const blocked = await gemini.geminiProvider({
    apiKey: "k",
    fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }) }),
  }).watchUrl(CREATOR, {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /came back with nothing: SAFETY/);

  const unreachable = await gemini.geminiProvider({
    apiKey: "k", fetchImpl: async () => { throw new Error("socket hang up"); },
  }).watchUrl(CREATOR, {});
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.error, /Could not reach Gemini: socket hang up/);
});

// ---------------------------------------------------------------------------
// The transcriber, on its own
// ---------------------------------------------------------------------------

test("with no key, no transcriber exists and the reason names the variable", () => {
  const s = transcribe.transcriberStatus({ choice: "", openaiKey: "" });
  assert.equal(s.connected, false);
  assert.deepEqual(s.missing, ["OPENAI_API_KEY"]);
  assert.match(s.why, /cannot listen to a video/);
  assert.match(s.why, /no captions cannot be read at all/);
  assert.equal(transcribe.transcriberFor({ status: s }), null);
});

test("a key turns it on, and it reports the 25 MB limit and that splitting needs ffmpeg", () => {
  const s = transcribe.transcriberStatus({ choice: "", openaiKey: "sk-test" });
  assert.equal(s.connected, true);
  assert.equal(s.provider, "openai");
  assert.equal(s.model, "whisper-1");
  assert.equal(s.limitBytes, 25 * 1024 * 1024);
  assert.match(s.limitNote, /25 MB/);
  assert.match(s.limitNote, /ffmpeg, which is not on this machine/);
  assert.equal(typeof transcribe.transcriberFor({ status: s }), "function");
});

test("the local option is documented as not installed, with what it would take", () => {
  const s = transcribe.transcriberStatus({ choice: "local" });
  assert.equal(s.connected, false);
  assert.deepEqual(s.missing, ["a local Whisper model", "ffmpeg"]);
  assert.match(s.why, /mlx-whisper/);
  assert.match(s.why, /1\.5 GB/);
  assert.match(s.why, /should be installed without saying so/);
});

test("the OpenAI request is the shape their docs document, and verbose_json becomes cues", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return {
      ok: true, status: 200, statusText: "OK",
      text: async () => JSON.stringify({
        task: "transcribe", language: "english", duration: 48.2,
        text: "Right, so the first thing. You want the weatherproof one.",
        segments: [
          { id: 0, start: 0.0, end: 11.9, text: " Right, so the first thing." },
          { id: 1, start: 12.5, end: 20.0, text: " You want the weatherproof one." },
        ],
      }),
    };
  };
  const t = transcribe.openaiTranscriber({ apiKey: "sk-test", model: "whisper-1", fetchImpl });
  const r = await t("test/fixtures/video/tiny.wav");

  assert.equal(r.ok, true);
  assert.deepEqual(r.cues, [
    { at: 0, text: "Right, so the first thing." },
    { at: 12.5, text: "You want the weatherproof one." },
  ]);
  assert.equal(r.language, "english");
  assert.equal(r.seconds, 48.2);

  assert.equal(sent.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(sent.init.headers.authorization, "Bearer sk-test");
  const form = sent.init.body;
  assert.ok(form instanceof FormData, "it has to be multipart");
  assert.equal(form.get("model"), "whisper-1");
  // verbose_json is the only format that carries per-segment start times, which is the whole point.
  assert.equal(form.get("response_format"), "verbose_json");
  assert.equal(form.get("timestamp_granularities[]"), "segment");
  assert.equal(form.get("file").name, "tiny.wav");
  assert.equal(form.get("file").type, "audio/wav");
  assert.equal(form.get("file").size, 844);
});

test("a transcriber that refuses, times out, or hears nothing is reported rather than swallowed", async () => {
  const refused = await transcribe.openaiTranscriber({
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => '{"error":"rate"}' }),
  })("test/fixtures/video/tiny.wav");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /refused: 429/);

  const silent = await transcribe.openaiTranscriber({
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ text: "", segments: [] }) }),
  })("test/fixtures/video/tiny.wav");
  assert.equal(silent.ok, false);
  assert.match(silent.error, /heard nothing/);

  const gone = await transcribe.openaiTranscriber({ apiKey: "sk-test", fetchImpl: async () => { throw new Error("nope"); } })("/no/such/audio.m4a");
  assert.equal(gone.ok, false);
  assert.match(gone.error, /is not there/);
});

test("text with no segments still comes back, flagged as having no usable timestamps", async () => {
  const t = transcribe.openaiTranscriber({
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ text: "All one block.", segments: [] }) }),
  });
  const r = await t("test/fixtures/video/tiny.wav");
  assert.equal(r.ok, true);
  assert.equal(r.no_timestamps, true);
  assert.deepEqual(r.cues, [{ at: 0, text: "All one block." }]);
});

test("audio over the 25 MB limit is refused with ffmpeg named, and nothing is uploaded", async () => {
  let called = false;
  const big = join(dir, "big.m4a");
  // A real file on disk, bigger than the limit, so the check is the real statSync one.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
  const r = await transcribe.openaiTranscriber({ apiKey: "sk-test", fetchImpl: async () => { called = true; } })(big);

  assert.equal(r.ok, false);
  assert.equal(r.too_big, true);
  assert.match(r.error, /26 MB and the limit is 25 MB/);
  assert.match(r.error, /needs ffmpeg, which is not on this machine/);
  assert.match(r.error, /rather than transcribing part of it/);
  assert.equal(called, false, "an over-size file must not be sent anywhere");
  rmSync(big, { force: true });
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
