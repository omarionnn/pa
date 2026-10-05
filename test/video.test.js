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
import { CONNECTED, fakeTranscriber, fakeYtDlp, fixture, longCaptions, meta } from "./fixture-video.js";

const dir = mkdtempSync(join(tmpdir(), "reason-video-test-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_AUDIO_TMP = join(dir, "audio-tmp");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
// Nothing here may pick up a real key, and nothing here may find a real binary.
process.env.OPENAI_API_KEY = "";
process.env.REASON_TRANSCRIBER = "";
process.env.REASON_YTDLP_BIN = "";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const video = await import("../src/video.js");
const transcribe = await import("../src/transcribe.js");

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

/** The tool, with the fake yt-dlp injected and no transcriber connected. */
const call = (input, extra = {}) =>
  runTool("video_understand", input, { conversationId: C, videoRun: fakeYtDlp(library()), videoTranscriber: null, ...extra });

/** The tool, with a fake transcriber that really is connected. */
const canListen = (input, { ear = fakeTranscriber(), run = fakeYtDlp(library()), ...extra } = {}) =>
  runTool("video_understand", input, {
    conversationId: C, videoRun: run, videoTranscriber: ear, videoListenStatus: CONNECTED, ...extra,
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

test("captions are preferred: with them there, nothing is downloaded and nothing is spent", async () => {
  const ear = fakeTranscriber();
  const run = fakeYtDlp(library());
  const r = await canListen({ url: CREATOR }, { ear, run });

  assert.equal(r.tier, "captions");
  assert.equal(ear.seen.length, 0, "a video with captions must not be sent to a transcriber");
  assert.ok(run.calls.every(a => a.includes("--skip-download")), "no call may download anything");
});

// ---------------------------------------------------------------------------
// Tier 2: listening to the audio
// ---------------------------------------------------------------------------

test("no captions: it listens, and the tier says it listened to the audio", async () => {
  const { url, lib } = silent("listens");
  const ear = fakeTranscriber();
  const run = fakeYtDlp(lib);
  const r = await canListen({ url }, { ear, run });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "listen");
  assert.equal(r.captions, null);
  assert.equal(r.heard.source, "audio");
  assert.equal(r.heard.model, "fake-whisper");
  assert.equal(r.heard.cached, false);
  assert.equal(r.heard.total_lines, 3);

  // The words come back laid out exactly like a caption file.
  assert.match(r.transcript, /^\[0:00\] Right, so the first thing is the junction box\.$/m);
  assert.match(r.transcript, /^\[0:12\] You want the weatherproof one/m);
  assert.match(r.transcript, /^\[0:41\] And that is it/m);

  assert.match(r.how, /^listened to this video's audio and had it transcribed by fake-whisper/);
  assert.match(r.how, /machine-heard words, so names and numbers can be wrong/);
  assert.match(r.how, /Never say "watched" or "saw"/);
});

test("listening downloads the AUDIO ONLY, hands over a real file, and deletes it", async () => {
  const { url, lib } = silent("audioonly");
  const ear = fakeTranscriber();
  const run = fakeYtDlp(lib);
  await canListen({ url }, { ear, run });

  // The download call asked for an audio format and never for a video stream.
  const download = run.calls.find(a => !a.includes("--skip-download") && !a.includes("-J"));
  assert.ok(download, "there must be exactly one call that downloads something");
  assert.equal(download[download.indexOf("-f") + 1], "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio");
  assert.ok(!download.includes("--extract-audio"), "--extract-audio needs ffmpeg and must not be used");

  // The transcriber was handed a file that really existed and really had bytes in it.
  assert.equal(ear.seen.length, 1);
  assert.equal(ear.seen[0].existed, true, "the audio must be on disk when the transcriber is called");
  assert.equal(ear.seen[0].bytes, 844, "the tiny fixture WAV, byte for byte");

  // And it is gone afterwards.
  assert.equal(existsSync(ear.seen[0].file), false, "the audio file must be deleted");
  assert.deepEqual(audioLeftOnDisk(), [], "no scratch directory may be left behind");
});

test("the temp audio is deleted even when the transcriber fails", async () => {
  const { url, lib } = silent("falls-over");
  const ear = fakeTranscriber({ error: "the transcriber fell over" });
  const r = await canListen({ url }, { ear, run: fakeYtDlp(lib) });

  assert.equal(r.tier, "metadata");
  assert.match(r.error, /fell over/);
  assert.equal(ear.seen[0].existed, true);
  assert.equal(existsSync(ear.seen[0].file), false, "a failed transcription must still clean up");
  assert.deepEqual(audioLeftOnDisk(), []);
});

test("the second ask for the same video spends nothing: cached transcript, no download, no transcriber", async () => {
  const url = "https://www.youtube.com/watch?v=cacheme";
  const m = { ...meta("nocaptions.meta.json"), id: "cacheme", webpage_url: url };
  const lib = { [url]: { meta: m, captions: {}, audio: true } };

  const firstEar = fakeTranscriber();
  const firstRun = fakeYtDlp(lib);
  const first = await canListen({ url }, { ear: firstEar, run: firstRun });
  assert.equal(first.tier, "listen");
  assert.equal(first.heard.cached, false);
  assert.equal(firstEar.seen.length, 1);

  const secondEar = fakeTranscriber();
  const secondRun = fakeYtDlp(lib);
  const second = await canListen({ url }, { ear: secondEar, run: secondRun });

  assert.equal(second.tier, "listen");
  assert.equal(second.heard.cached, true, "the second ask must come off the stored transcript");
  assert.equal(secondEar.seen.length, 0, "nothing may be sent to the transcriber twice");
  assert.ok(secondRun.calls.every(a => a.includes("--skip-download")), "nothing may be downloaded twice");
  // And it is the same words.
  assert.equal(second.transcript, first.transcript);
  assert.match(second.how, /from a transcript already made for it/);
});

test("a video over the length cap is refused, says the length and the limit, and downloads nothing", async () => {
  const { url, lib } = silent("ninety-minutes", { duration: 5400 });
  const ear = fakeTranscriber();
  const run = fakeYtDlp(lib);
  const r = await canListen({ url }, { ear, run, videoMaxMinutes: 20 });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.match(r.error, /1:30:00 long/);
  assert.match(r.error, /only listen to 20 minutes/);
  assert.match(r.error, /REASON_LISTEN_MAX_MINUTES/);
  assert.equal(ear.seen.length, 0, "an over-long video must not be transcribed");
  assert.ok(run.calls.every(a => a.includes("--skip-download")), "an over-long video must not be downloaded");
  assert.deepEqual(audioLeftOnDisk(), []);
});

test("asked to listen when the captions are fine: it listens anyway, and says so", async () => {
  // Its own id again: this video ends up with a stored transcript, and the next test must not get it.
  const url = "https://www.youtube.com/watch?v=listen-anyway";
  const lib = { [url]: { meta: { ...meta("auto.meta.json"), id: "listen-anyway", webpage_url: url }, captions: { en: fixture("auto.en.vtt") }, audio: true } };
  const ear = fakeTranscriber();
  const r = await canListen({ url, listen: true }, { ear, run: fakeYtDlp(lib) });

  assert.equal(r.tier, "listen");
  assert.equal(ear.seen.length, 1, "listen: true means actually listen");
  assert.equal(r.captions, null);
});

test("asked to listen with no transcriber: it reads the captions instead and says listening did not happen", async () => {
  const r = await call({ url: AUTO, listen: true });

  assert.equal(r.tier, "captions");
  assert.match(r.listen_failed, /OPENAI_API_KEY/);
  assert.match(r.how, /^read the captions/);
});

test("no captions and no transcriber: readable reason, and it does not guess from the title", async () => {
  const { url, lib } = silent("deaf");
  const r = await runTool("video_understand", { url }, { conversationId: C, videoRun: fakeYtDlp(lib), videoTranscriber: null });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.equal(r.captions, null);
  assert.equal(r.transcript, undefined);
  assert.match(r.how, /did NOT read or listen/);
  assert.match(r.how, /no captions at all/);
  // What it DOES have is the page's own account of itself, and it says that is all.
  assert.equal(r.title, "Workshop: rewiring the shed lights");
  assert.equal(r.duration, "12:22");
  assert.match(r.note, /the only way to know what is said is to listen/);
  assert.match(r.note, /Do not infer the content from the title/);
  assert.equal(r.listen_tier.connected, false);
  assert.deepEqual(r.listen_tier.missing, ["OPENAI_API_KEY"]);
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
  assert.match(r.how, /did NOT read or listen/);
  assert.match(r.error, /429/);
  assert.match(r.note, /Do not guess at the content/);
  // The metadata it did get is still there and still usable.
  assert.equal(r.title, "But what is a neural network? | Deep learning chapter 1");
});

test("the audio download failing is reported, not papered over", async () => {
  const url = "https://www.youtube.com/watch?v=noformat";
  const run = fakeYtDlp({ [url]: { meta: { ...meta("nocaptions.meta.json"), id: "noformat" }, captions: {}, audioError: "ERROR: Requested format is not available" } });
  const ear = fakeTranscriber();
  const r = await canListen({ url }, { ear, run });

  assert.equal(r.tier, "metadata");
  assert.match(r.error, /format is not available/);
  assert.equal(ear.seen.length, 0);
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

test("capabilities never implies a video was watched, in any of its states", () => {
  const YES = { ok: true, bin: "/usr/local/bin/yt-dlp" };
  const NO = video.ytDlpStatus({ bin: null });
  const DEAF = transcribe.transcriberStatus({ choice: "", openaiKey: "" });

  // No yt-dlp: nothing at all, and do not offer it.
  const none = video.videoCapability({ tool: NO, listen: DEAF });
  assert.equal(none.status, "not connected");
  assert.match(none.what, /yt-dlp is not installed/);
  assert.match(none.what, /Do not offer to/);

  // Captions only — the state this machine is actually in. Live, but it must say it cannot listen.
  const readOnly = video.videoCapability({ tool: YES, listen: DEAF });
  assert.equal(readOnly.status, "live");
  assert.match(readOnly.what, /NO captions cannot be read at all/);
  assert.match(readOnly.what, /OPENAI_API_KEY/);

  // Both.
  const both = video.videoCapability({ tool: YES, listen: CONNECTED });
  assert.equal(both.status, "live");
  assert.match(both.what, /has it transcribed by a fake transcriber \(fake-whisper\)/);
  assert.match(both.what, /says which of the two it did/);

  // Whatever the state, it never claims to see.
  for (const c of [none, readOnly, both]) {
    assert.doesNotMatch(c.what, /\bwatch(es|ed)?\b(?! it with)/i, c.what);
  }
  for (const c of [readOnly, both]) {
    assert.match(c.what, /nothing looks at the picture/);
  }
});

test("the capabilities tool carries the video entry, matching this machine", () => {
  const entry = capabilitiesNow({ conversationId: C }).find(c => c.name === "video");
  assert.ok(entry, "there must be a video capability");
  assert.deepEqual({ status: entry.status, what: entry.what }, video.videoCapability());
  // With no key the entry may never imply the audio could be heard.
  assert.match(entry.what, /OPENAI_API_KEY/);
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

test("the receipt names the tier, and says when listening cost nothing", async () => {
  // Its own conversation, so the count is this test's calls and nothing else's.
  const L = "dm:video-ledger";
  db.upsertAccount({ conversationId: L, channel: "test", address: "+12025559999", name: "Omari" });
  const url = "https://www.youtube.com/watch?v=receipts";
  const lib = { [url]: { meta: { ...meta("nocaptions.meta.json"), id: "receipts", webpage_url: url }, captions: {}, audio: true } };
  const here = (input, extra) => runTool("video_understand", input, {
    conversationId: L, videoRun: fakeYtDlp(lib), videoTranscriber: null, ...extra,
  });

  await runTool("video_understand", { url: CREATOR }, { conversationId: L, videoRun: fakeYtDlp(library()), videoTranscriber: null });
  await here({ url }, { videoTranscriber: fakeTranscriber(), videoListenStatus: CONNECTED });
  await here({ url }, { videoTranscriber: fakeTranscriber(), videoListenStatus: CONNECTED });
  await here({ url: "https://example.com/about-us" });

  const rows = db.listActions(L, { limit: 20 }).filter(r => r.action === "video_understand").reverse();
  assert.equal(rows.length, 4, "every call must be on the record");

  assert.equal(rows[0].outcome, "ok");
  assert.match(rows[0].receipt, /Read the creator's captions/);
  assert.match(rows[0].receipt, /Words only; nothing watched it/);

  assert.match(rows[1].receipt, /Downloaded the AUDIO ONLY/);
  assert.match(rows[1].receipt, /transcribed by fake-whisper/);
  assert.match(rows[1].receipt, /The audio was deleted/);

  assert.match(rows[2].receipt, /already transcribed before, so nothing was spent/);

  assert.equal(rows[3].outcome, "error");
  assert.match(rows[3].receipt, /Tried to get at the video/);
  assert.match(rows[3].receipt, /not a video page/);
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

test("a transcript is keyed to the video, so two sites cannot collide", () => {
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
