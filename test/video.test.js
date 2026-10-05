// Watching a video, without the network and without a key.
//
// The thing under test is not "does yt-dlp work" — it is every promise the tool makes about what it
// did: which tier answered, that a transcript never claims to have seen anything, that a long video
// says what was left out and can be asked again for it, that a blocked video reports the block
// rather than guessing, and that the whole thing leaves a receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeYtDlp, fixture, longCaptions, meta } from "./fixture-video.js";

const dir = mkdtempSync(join(tmpdir(), "reason-video-test-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
// Nothing here may pick up a real key, and nothing here may find a real binary.
process.env.GEMINI_API_KEY = "";
process.env.REASON_YTDLP_BIN = "";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const video = await import("../src/video.js");

const C = "dm:video";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

const CREATOR = "https://www.youtube.com/watch?v=aircAruvnKk";
const AUTO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SILENT = "https://www.youtube.com/watch?v=silentclip";
const LONG = "https://www.youtube.com/watch?v=threehours";

const library = () => ({
  [CREATOR]: { meta: meta("creator.meta.json"), captions: { en: fixture("creator.en.vtt") } },
  [AUTO]: { meta: meta("auto.meta.json"), captions: { en: fixture("auto.en.vtt") } },
  [SILENT]: { meta: meta("nocaptions.meta.json"), captions: {} },
  [LONG]: { meta: meta("long.meta.json"), captions: { en: longCaptions() } },
});

/** The tool, with the fake yt-dlp injected and no video model connected. */
const call = (input, extra = {}) =>
  runTool("video_understand", input, { conversationId: C, videoRun: fakeYtDlp(library()), videoApiKey: "", ...extra });

// ---------------------------------------------------------------------------
// The two tiers, and never lying about which one answered
// ---------------------------------------------------------------------------

test("creator captions: real timestamped lines, and the tier says captions were read", async () => {
  const r = await call({ url: CREATOR });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "transcript");
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

  // The honest sentence, in words Reason can repeat.
  assert.match(r.how, /read the captions, not the picture/i);
  assert.match(r.how, /never "watched" or "saw"/);
  assert.equal(r.watch_tier.connected, false);
  assert.deepEqual(r.watch_tier.missing, ["GEMINI_API_KEY"]);
});

test("auto captions: labelled as auto, and the rolling repeats are gone", async () => {
  const r = await call({ url: AUTO });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "transcript");
  assert.equal(r.captions.source, "auto");
  assert.match(r.how, /auto-generated captions/);
  assert.match(r.how, /names and numbers can be wrong/);

  // YouTube's auto track repeats every line as the words crawl up the screen. Each one once.
  const lines = r.transcript.split("\n");
  const said = lines.map(l => l.replace(/^\[[\d:]+\] /, ""));
  assert.deepEqual([...new Set(said)].length, said.length, `repeated lines survived:\n${r.transcript}`);
  // The per-word timing tags are not content.
  assert.doesNotMatch(r.transcript, /<c>|<\/c>|<\d\d:\d\d/);
  assert.match(r.transcript, /We're no strangers to/);
  assert.match(r.transcript, /\[0:00\] \[Music\]/);
});

test("a video with no captions at all: honest, and it does not guess from the title", async () => {
  const r = await call({ url: SILENT });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.equal(r.captions, null);
  assert.equal(r.transcript, undefined);
  assert.match(r.how, /did NOT read or watch/);
  assert.match(r.how, /no captions/);
  // What it DOES have is the page's own account of itself, and it says that is all.
  assert.equal(r.title, "Workshop: rewiring the shed lights");
  assert.equal(r.duration, "12:22");
  assert.match(r.note, /no video model is connected/);
  assert.match(r.note, /Do not infer the content from the title/);
});

test("no captions and no key: the watch tier is named as the missing thing, not offered", async () => {
  const r = await call({ url: SILENT });
  assert.equal(r.watch_tier.connected, false);
  assert.deepEqual(r.watch_tier.missing, ["GEMINI_API_KEY"]);
  assert.match(r.watch_tier.why, /nothing has actually watched the picture/i);
});

test("no captions, but a video model IS connected: it watches, and the tier says watch", async () => {
  const watcher = async (url, opts) => {
    assert.equal(url, SILENT);
    assert.equal(opts.question, "what does he do about the junction box");
    return { ok: true, connected: true, provider: "gemini", model: "test-model", said: "He pulls the old junction box at 3:10 and fits a weatherproof one." };
  };
  const r = await call({ url: SILENT, question: "what does he do about the junction box" }, { videoApiKey: "k", videoWatcher: watcher });

  assert.equal(r.tier, "watch");
  assert.match(r.how, /watched the video with gemini/);
  assert.match(r.watched, /weatherproof/);
  assert.equal(r.captions, null);
});

test("watch: true with no key leaves the tier at transcript and says the picture was not seen", async () => {
  const r = await call({ url: CREATOR, watch: true });
  assert.equal(r.tier, "transcript");
  assert.equal(r.watch_tier.connected, false);
  assert.match(r.how, /not the picture/);
});

// ---------------------------------------------------------------------------
// A long video: cut short, loudly, with a way to read the rest
// ---------------------------------------------------------------------------

test("three hours comes back trimmed, says exactly what is missing, and names the follow-up", async () => {
  const r = await call({ url: LONG });

  assert.equal(r.ok, true);
  assert.equal(r.tier, "transcript");
  assert.equal(r.duration, "3:00:00");
  assert.ok(r.trimmed, "a three-hour transcript must report that it was cut");
  assert.ok(r.transcript.length <= 20_000, `transcript was ${r.transcript.length} chars`);
  assert.ok(r.trimmed.dropped_lines > 3000, `only ${r.trimmed.dropped_lines} lines reported dropped`);

  // What is here, and what is not, as real clock times.
  assert.match(r.covers, /^0:00–/);
  assert.match(r.trimmed.missing, /–2:59:5\d$/);
  assert.match(r.trimmed.note, /Do not say anything about the part you do not have/);
  assert.match(r.trimmed.note, /call video_understand again on the same url with from and to/);
  // The full extent of the captions is still reported, so the gap is measurable.
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
  const r = await runTool("video_understand", { url: "https://example.com/about-us" }, {
    conversationId: C, videoApiKey: "", videoRun: fakeYtDlp(library()),
  });
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
  // The last column: would a video model get in instead? For a private, gated, members-only or
  // deleted video the answer is no — those APIs only take public videos — so it is not dangled.
  // A country block is different: it stops this machine, not necessarily a provider's servers.
  const cases = [
    ["private", "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", /private video/i, false],
    ["age_gate", "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.", /age-restricted/i, false],
    ["paywall", "ERROR: [youtube] abc: Join this channel to get access to members-only content", /members-only/i, false],
    ["region", "ERROR: [youtube] abc: The uploader has not made this video available in your country", /blocked in this country/i, true],
    ["gone", "ERROR: [youtube] abc: This video is unavailable", /not there any more/i, false],
  ];
  for (const [cannot, stderr, says, eyesMightHelp] of cases) {
    const url = `https://www.youtube.com/watch?v=${cannot}`;
    const r = await runTool("video_understand", { url }, {
      conversationId: C, videoApiKey: "", videoRun: fakeYtDlp({ [url]: { metaError: stderr } }),
    });
    assert.equal(r.ok, false, cannot);
    assert.equal(r.cannot, cannot, cannot);
    assert.match(r.error, says);
    // None of these is ever presented as something Reason will get round.
    assert.doesNotMatch(r.error, /try again|work around|bypass/i);
    // And a block a video model could not get past either is not dangled as a second chance.
    if (eyesMightHelp) assert.equal(r.note, undefined, cannot);
    else assert.match(r.note, /would not get in either/, cannot);
  }
});

test("captions listed but un-fetchable: metadata tier, the error quoted, no guessing", async () => {
  const r = await runTool("video_understand", { url: CREATOR }, {
    conversationId: C, videoApiKey: "",
    videoRun: fakeYtDlp({ [CREATOR]: { meta: meta("creator.meta.json"), captionError: "ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests" } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.tier, "metadata");
  assert.equal(r.captions, null);
  assert.match(r.how, /did NOT read this video/);
  assert.match(r.error, /429/);
  assert.match(r.note, /Do not guess at the content/);
  // The metadata it did get is still there and still usable.
  assert.equal(r.title, "But what is a neural network? | Deep learning chapter 1");
});

// ---------------------------------------------------------------------------
// yt-dlp missing
// ---------------------------------------------------------------------------

// `bin: null` is the whole of "yt-dlp is not on this machine" — findYtDlp() is a PATH lookup, and
// this machine happens to have it, so the precondition is stated rather than faked.
const NO_BIN = { bin: null, run: async () => { throw new Error("nothing should be run with no binary"); } };

test("yt-dlp missing: the tool says so in plain words and names both missing pieces", async () => {
  const r = await video.videoUnderstand(CREATOR, { ...NO_BIN, apiKey: "" });

  assert.equal(r.ok, false);
  assert.equal(r.tier, "none");
  assert.match(r.error, /yt-dlp is not installed on this machine/);
  assert.match(r.error, /cannot read any video/);
  assert.deepEqual(r.missing, ["yt-dlp", "GEMINI_API_KEY"]);
});

test("yt-dlp missing but a video model connected: it watches instead, and says the captions were not read", async () => {
  const r = await video.videoUnderstand(CREATOR, {
    ...NO_BIN, apiKey: "k",
    watcher: async () => ({ ok: true, connected: true, provider: "gemini", model: "test-model", said: "It explains what a neuron is." }),
  });
  assert.equal(r.tier, "watch");
  assert.match(r.how, /The captions were not read/);
  assert.match(r.how, /yt-dlp is not installed/);
});

test("capabilities never says a transcript was watched, in any of the four states", () => {
  const YES = { ok: true, bin: "/usr/local/bin/yt-dlp" };
  const NO = video.transcriptTierStatus({ bin: null });
  const EYES = { connected: true, provider: "gemini", model: "gemini-3.8-flash" };
  const BLIND = video.watchTierStatus({ apiKey: "" });

  // Neither piece: not connected, and do not offer it.
  const neither = video.videoCapability({ tool: NO, eyes: BLIND });
  assert.equal(neither.status, "not connected");
  assert.match(neither.what, /yt-dlp is not installed/);
  assert.match(neither.what, /GEMINI_API_KEY/);
  assert.match(neither.what, /Do not offer to/);

  // Captions only — the state this machine is actually in. Live, but it must say it cannot see.
  const readOnly = video.videoCapability({ tool: YES, eyes: BLIND });
  assert.equal(readOnly.status, "live");
  assert.match(readOnly.what, /reading, not watching/);
  assert.match(readOnly.what, /cannot say what was on screen/);
  assert.match(readOnly.what, /GEMINI_API_KEY/);

  // Both.
  const both = video.videoCapability({ tool: YES, eyes: EYES });
  assert.equal(both.status, "live");
  assert.match(both.what, /actually watch it with gemini-3\.8-flash/);
  assert.match(both.what, /says which of the two answered/);

  // A key but no yt-dlp: it can watch, and must not promise transcript timestamps.
  const eyesOnly = video.videoCapability({ tool: NO, eyes: EYES });
  assert.equal(eyesOnly.status, "live");
  assert.match(eyesOnly.what, /no timestamps off a transcript/);
});

test("the capabilities tool carries the video entry, matching this machine", () => {
  const entry = capabilitiesNow({ conversationId: C }).find(c => c.name === "video");
  assert.ok(entry, "there must be a video capability");
  assert.deepEqual({ status: entry.status, what: entry.what }, video.videoCapability());
  // Whatever this machine has, with no key the entry may never imply the picture was seen.
  assert.match(entry.what, /GEMINI_API_KEY/);
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

test("every video_understand leaves a receipt saying which tier answered, success or not", async () => {
  // Its own conversation, so the count is this test's two calls and nothing else's.
  const L = "dm:video-ledger";
  db.upsertAccount({ conversationId: L, channel: "test", address: "+12025559999", name: "Omari" });
  const here = (input) => runTool("video_understand", input, { conversationId: L, videoRun: fakeYtDlp(library()), videoApiKey: "" });

  await here({ url: CREATOR });
  await here({ url: "https://example.com/about-us" });

  const rows = db.listActions(L, { limit: 20 }).filter(r => r.action === "video_understand");
  assert.equal(rows.length, 2, "both calls must be on the record");

  const good = rows.find(r => r.target === CREATOR);
  assert.ok(good, "the one that worked is on the record");
  assert.equal(good.outcome, "ok");
  assert.equal(good.result.ok, true);
  // The receipt is the thing "did you actually watch it" is answered from.
  assert.match(good.receipt, /Read the creator's captions/);
  assert.match(good.receipt, /Nothing watched the picture/);

  const bad = rows.find(r => r.target === "https://example.com/about-us");
  assert.ok(bad, "the one that failed is on the record too");
  assert.equal(bad.outcome, "error");
  assert.match(bad.receipt, /Tried to get at the video/);
  assert.match(bad.receipt, /not a video page/);
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
  // en-GB is English.
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

test("the watch tier reports not-connected rather than attempting a call with no key", async () => {
  let called = false;
  const r = await video.watchWithGemini(CREATOR, { apiKey: "", fetchImpl: async () => { called = true; } });
  assert.equal(r.ok, false);
  assert.equal(r.connected, false);
  assert.deepEqual(r.missing, ["GEMINI_API_KEY"]);
  assert.equal(called, false, "with no key, nothing should be sent anywhere");
});

test("the Gemini request is the shape their docs document, and a time range rides on the part", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true, status: 200, statusText: "OK",
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "It is about neurons." }] } }], usageMetadata: { totalTokenCount: 1234 } }),
    };
  };
  const r = await video.watchWithGemini(CREATOR, {
    apiKey: "test-key", model: "gemini-3.8-flash", question: "what does it cover",
    from: 60, to: 120, fetchImpl,
  });

  assert.equal(r.ok, true);
  assert.equal(r.said, "It is about neurons.");
  assert.equal(r.usage.totalTokenCount, 1234);
  assert.equal(sent.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(sent.init.headers["x-goog-api-key"], "test-key");
  const [text, file] = sent.body.contents[0].parts;
  assert.match(text.text, /what does it cover/);
  assert.deepEqual(file.file_data, { file_uri: CREATOR });
  assert.deepEqual(file.video_metadata, { start_offset: "60s", end_offset: "120s" });
});

test("a video model that refuses is reported, not swallowed", async () => {
  const r = await video.watchWithGemini(CREATOR, {
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => '{"error":"quota"}' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.connected, true);
  assert.match(r.error, /refused: 429/);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
