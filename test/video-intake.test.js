// Video intake (REASON_VIDEO_INTAKE = off | owner | on, default off): a texted video link handled end
// to end, built on video_understand. No network, no key, no binary: yt-dlp, the video model, the
// renderer and the texting channel are all fakes, and nothing here reaches Google or any site.
//
// What is proved: each path (captions; no captions -> listen/watch; too long, too big, private,
// age-gated, live, unsupported), the transcript cache (one key for every form of a link, nothing about
// who asked, expiry and size cap), `find`, the PDF (sent only when it arrived), the heads-up and the
// five-minute ceiling, that the money is counted and capped, that Reason is told to say how it knows,
// and that with the switch off (or a person it does not cover) the prompt and the tool list are the
// same bytes as before.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WATCHING, fakeVideoModel, fakeYtDlp, fixture, longCaptions, meta } from "./fixture-video.js";

const dir = mkdtempSync(join(tmpdir(), "reason-video-intake-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DOCUMENT_ROOT = join(dir, "documents");
process.env.REASON_AUDIO_TMP = join(dir, "audio-tmp");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.ts.net";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.GEMINI_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.REASON_TRANSCRIBER = "";
process.env.REASON_YTDLP_BIN = "";
delete process.env.REASON_VIDEO_INTAKE;

const { config, clock } = await import("../src/config.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool, toolsFor, tools, videoIntakeFor } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const accounts = await import("../src/accounts.js");
const db = await import("../src/db.js");
const video = await import("../src/video.js");

const C = config.ownerConversation;
const OTHER = "dm:invited-person";
const OWNER_NUMBER = "+12025551234";

const CREATOR = "https://www.youtube.com/watch?v=aircAruvnKk"; // 18:40, creator captions
const AUTO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";    // 3:33, auto captions
const SPEECH = "https://www.youtube.com/watch?v=Spe3chLong1";  // 1:40:00, captions all the way

const library = () => ({
  [CREATOR]: { meta: meta("creator.meta.json"), captions: { en: fixture("creator.en.vtt") }, audio: true },
  [AUTO]: { meta: meta("auto.meta.json"), captions: { en: fixture("auto.en.vtt") }, audio: true },
  [SPEECH]: {
    meta: { ...meta("long.meta.json"), id: "Spe3chLong1", webpage_url: SPEECH, duration: 6000, title: "A long talk" },
    captions: {
      en: longCaptions({ seconds: 6000, every: 30 }).replace(
        "00:52:30.000 --> 00:53:00.000\nline at 00:52:30.000, and here is some more of what the speaker said.",
        "00:52:30.000 --> 00:53:00.000\nand that is where our pricing changes for next year.",
      ),
    },
    audio: true,
  },
});

/** A caption-less video on a site that is not YouTube: the only way in is listening to it. */
const vimeo = (id, over = {}) => {
  const url = `https://vimeo.com/${id}`;
  const m = { ...meta("nocaptions.meta.json"), extractor_key: "Vimeo", id: String(id), webpage_url: url, subtitles: {}, automatic_captions: {}, ...over };
  return { url, lib: { [url]: { meta: m, captions: {}, audio: true } } };
};
/** A caption-less YouTube video: the video model is handed the link. */
const silentYt = (id, over = {}) => {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const m = { ...meta("nocaptions.meta.json"), id, webpage_url: url, ...over };
  return { url, lib: { [url]: { meta: m, captions: {}, audio: true } } };
};

/** A fake video model that reports usage the way Gemini does, under Gemini's model name. */
const geminiLike = (opts = {}) => {
  const m = fakeVideoModel({ model: "gemini-3.8-flash", ...opts });
  const listen = m.transcribeFile.bind(m), watch = m.watchUrl.bind(m);
  m.transcribeFile = async (...a) => ({ ...(await listen(...a)), usage: { promptTokenCount: 19_200, candidatesTokenCount: 2_000, thoughtsTokenCount: 500 } });
  m.watchUrl = async (...a) => ({ ...(await watch(...a)), usage: { promptTokenCount: 60_000, candidatesTokenCount: 1_000 } });
  return m;
};

function harness({ media = true } = {}) {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  const fake = router.register(new FakeChannel({ media }));
  db.upsertThread({ conversationId: C, channel: fake.name, address: OWNER_NUMBER, chatId: "chat-1", service: "iMessage" });
  return { router, fake };
}
const fakeRender = async ({ kind, title }) => Buffer.from(kind === "pdf" ? `%PDF-1.4 ${title}` : `PK ${title}`);

/** The tool, as the owner, with the fake yt-dlp and (by default) no video model. */
const call = (input, { run = fakeYtDlp(library()), brain = null, conv = C, ...extra } = {}) =>
  runTool("video_understand", input, {
    conversationId: conv, videoRun: run, videoModel: brain, ...(brain ? { videoModelStatus: WATCHING } : {}), videoTranscriber: null,
    videoHeadsUp: async () => ({ ok: true }), ...extra,
  });

const audioLeftOnDisk = () => { const root = join(dir, "audio-tmp"); return existsSync(root) ? readdirSync(root) : []; };
const cacheRows = () => db.db.prepare("SELECT COUNT(*) AS n FROM video_cache").get().n;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.videoIntake = "owner";
  config.undoWindowSeconds = 0;
  db.db.exec("DELETE FROM video_cache; DELETE FROM video_cache_lines; DELETE FROM video_accounts; DELETE FROM model_usage; DELETE FROM documents; DELETE FROM threads;");
  db.upsertAccount({ conversationId: C, channel: "test", address: OWNER_NUMBER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "test", address: "+14155550111", name: "Sam", isOperator: false });
});

// ---------------------------------------------------------------------------
// One video, one key
// ---------------------------------------------------------------------------

test("every form of a link is one video: youtu.be, shorts, m., embed, t=, si=, utm, and the other sites", () => {
  const yt = "youtube:dQw4w9WgXcQ";
  for (const u of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?si=abc123", "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "https://youtube.com/shorts/dQw4w9WgXcQ?feature=share", "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ?utm_source=x",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1",
  ]) assert.equal(video.normalizeVideoUrl(u).key, yt, u);
  assert.equal(video.normalizeVideoUrl("https://vimeo.com/76979871?share=copy").key, "vimeo:76979871");
  assert.equal(video.normalizeVideoUrl("https://www.tiktok.com/@someone/video/7301234567890123456?is_from_webapp=1").key, "tiktok:7301234567890123456");
  assert.equal(video.normalizeVideoUrl("https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=xyz").key, "instagram:C1a2B3c4D5e");
  assert.equal(video.normalizeVideoUrl("https://x.com/someone/status/1790000000000000000?s=20").key, "twitter:1790000000000000000");
  assert.equal(video.normalizeVideoUrl("https://twitter.com/someone/status/1790000000000000000").key, "twitter:1790000000000000000");
  assert.equal(video.normalizeVideoUrl("https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=1").key, "loom:0123456789abcdef0123456789abcdef");
  assert.equal(video.normalizeVideoUrl("https://www.facebook.com/watch/?v=1234567890").key, "facebook:1234567890");
  assert.equal(video.normalizeVideoUrl("https://www.facebook.com/someone/videos/1234567890/").key, "facebook:1234567890");
  assert.equal(video.normalizeVideoUrl("https://example.com/talk/?ref=x#y").key, "url:example.com/talk");
});

// ---------------------------------------------------------------------------
// Captions found
// ---------------------------------------------------------------------------

test("captions found: a bare link reads them, says how, offers the rest in plain words, and caches them", async () => {
  const run = fakeYtDlp(library());
  const r = await call({ url: CREATOR }, { run });
  assert.equal(r.ok, true);
  assert.equal(r.tier, "captions");
  assert.match(r.say_how, /from the creator's captions/);
  assert.match(r.if_just_a_link, /3 to 5 short lines/);
  assert.match(r.if_just_a_link, /full transcript as a PDF, the key quotes, or finding where/);
  assert.match(r.if_just_a_link, /Never give them words to type/);
  assert.ok(cacheRows() === 1, "the transcript is kept");

  // The second question about the same video, in another form of its link: no yt-dlp at all.
  const calls = run.calls.length;
  const again = await call({ url: "https://youtu.be/aircAruvnKk?t=30", question: "what is a neuron?" }, { run });
  assert.equal(run.calls.length, calls, "nothing fetched the second time");
  assert.equal(again.ok, true);
  assert.equal(again.tier, "captions");
  // Worded as a fresh read: the cache is shared, so nothing hints the video was fetched before.
  assert.equal(again.cached, undefined);
  assert.doesNotMatch(again.how, /earlier|already|kept|before|cost nothing/i);
  assert.equal(again.if_just_a_link, undefined, "a question is not a bare link");
});

test("auto captions say so: 'auto-generated', not the creator's", async () => {
  const r = await call({ url: AUTO });
  assert.equal(r.tier, "captions");
  assert.match(r.say_how, /auto-generated captions/);
});

test("the cache holds the video, never who asked: no conversation, number or name column", () => {
  const cols = (t) => db.db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.deepEqual(cols("video_cache"), ["video_id", "url", "title", "channel", "duration_s", "tier", "source", "chars", "fetched_at"]);
  assert.deepEqual(cols("video_cache_lines"), ["video_id", "n", "start_s", "end_s", "text"]);
});

test("the cache refetches after 30 days, and drops the oldest videos past its size cap", async () => {
  const run = fakeYtDlp(library());
  await call({ url: AUTO }, { run });
  const n = run.calls.length;
  clock.skip(31 * 86_400_000);
  await call({ url: AUTO }, { run });
  assert.ok(run.calls.length > n, "an old transcript is fetched again");

  db.saveVideoTranscript({ videoId: "t:a", url: "u", tier: "captions", lines: [{ at: 0, text: "x".repeat(600) }] }, { maxChars: 1000 });
  clock.skip(1000);
  db.saveVideoTranscript({ videoId: "t:b", url: "u", tier: "captions", lines: [{ at: 0, text: "y".repeat(600) }] }, { maxChars: 1000 });
  assert.equal(db.getVideoTranscript("t:a"), null, "the oldest went");
  assert.ok(db.getVideoTranscript("t:b"), "the newest stays");
});

// ---------------------------------------------------------------------------
// No captions: listen (any site) or watch (YouTube)
// ---------------------------------------------------------------------------

test("no captions on another site: the audio only is listened to, deleted, cached as lines, said, and counted", async () => {
  const v = vimeo(900001);
  const brain = geminiLike();
  const r = await call({ url: v.url }, { run: fakeYtDlp(v.lib), brain });
  assert.equal(r.ok, true);
  assert.equal(r.tier, "listen");
  assert.match(r.say_how, /by listening to the audio/);
  assert.match(r.how, /never "watched"/);
  assert.equal(brain.calls[0].kind, "listen");
  assert.equal(brain.calls[0].existed, true, "a real file was handed over");
  assert.deepEqual(audioLeftOnDisk(), [], "and the audio is gone");
  const kept = db.getVideoTranscript("vimeo:900001");
  assert.equal(kept.tier, "listen");
  assert.equal(kept.lines.length, 3);
  assert.equal(kept.lines[1].at, 12);

  const used = db.db.prepare("SELECT feature, via, model, input_tokens AS input, output_tokens AS output, cost_usd FROM model_usage").all();
  assert.equal(used.length, 1, "one paid call, in the ledger every paid call goes in");
  assert.equal(used[0].feature, "video");
  assert.equal(used[0].model, "gemini-3.8-flash");
  assert.equal(used[0].input, 19_200);
  assert.equal(used[0].output, 2_500, "thinking tokens are billed as output, so they are counted as output");
  // 19,200 x $0.75/M + 2,500 x $3.75/M
  assert.ok(Math.abs(used[0].cost_usd - (19_200 * 0.75 + 2_500 * 3.75) / 1e6) < 1e-9, String(used[0].cost_usd));

  // The second ask: from the kept lines, no download, no model, nothing counted.
  const again = await call({ url: v.url, question: "what box?" }, { run: fakeYtDlp(v.lib), brain });
  assert.equal(brain.calls.length, 1);
  assert.match(again.how, /LISTENED to this video's audio and had it transcribed/);
  assert.doesNotMatch(again.how, /earlier|already/i);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM model_usage").get().n, 1);
});

test("no captions on YouTube: watched by the video model, said, and NOT kept as a transcript (it is an account)", async () => {
  const v = silentYt("NoCapsYt001");
  const brain = geminiLike();
  const r = await call({ url: v.url }, { run: fakeYtDlp(v.lib), brain });
  assert.equal(r.tier, "watch");
  assert.match(r.say_how, /by watching it/);
  assert.equal(cacheRows(), 0);
  assert.equal(db.db.prepare("SELECT feature FROM model_usage").get().feature, "video");
});

test("a paid-use cap already reached: nothing paid is tried, and the reason is said", async () => {
  const v = vimeo(900002);
  const brain = geminiLike();
  const r = await video.videoIntake(v.url, {
    run: fakeYtDlp(v.lib), bin: "/fake/yt-dlp", model: brain, modelStatus: WATCHING, transcriber: null,
    spendCap: () => ({ which: "day", spent: 5, cap: 5 }), recordSpend: () => assert.fail("nothing to count"),
  });
  assert.equal(brain.calls.length, 0, "no model call");
  assert.equal(r.tier, "metadata");
  assert.match(r.error, /spending limit on paid AI use is reached for today/);
  // One plain line about the machine: no blame, no phrase to type, no promise.
  assert.match(r.say, /^That video has no captions, and the paid way of listening to it is switched off for now on my side/);
  assert.doesNotMatch(r.say, /type|reply|text me|you've|your limit/i);
  // Captions are free, so they still work under the cap.
  const caps = await video.videoIntake(AUTO, { run: fakeYtDlp(library()), bin: "/fake/yt-dlp", model: null, transcriber: null, spendCap: () => ({ which: "month" }), recordSpend: () => {} });
  assert.equal(caps.tier, "captions");
});

// ---------------------------------------------------------------------------
// One plain line, no retries
// ---------------------------------------------------------------------------

const refused = (r, cannot, re) => {
  assert.equal(r.ok, false);
  assert.equal(r.cannot, cannot);
  assert.match(r.say, re);
  assert.equal(r.retry, false);
  assert.match(r.note, /Do not try again/);
};

test("over two hours: one line with the length and the limit, and nothing fetched past the metadata", async () => {
  const url = "https://www.youtube.com/watch?v=threehours";
  const run = fakeYtDlp({ [url]: { meta: meta("long.meta.json"), captions: { en: longCaptions() }, audio: true } });
  const r = await call({ url }, { run });
  refused(r, "too_long", /3:00:00 long, and I only take videos up to 2 hours/);
  assert.equal(run.calls.length, 1, "only the metadata");
});

test("a live stream, an upcoming one, a private one, an age-gated one, a members-only one", async () => {
  const live = silentYt("LiveNow0001", { is_live: true, live_status: "is_live" });
  refused(await call({ url: live.url }, { run: fakeYtDlp(live.lib) }), "live", /live stream/);
  const soon = silentYt("Upcoming001", { live_status: "is_upcoming" });
  refused(await call({ url: soon.url }, { run: fakeYtDlp(soon.lib) }), "upcoming", /hasn't started/);

  const shut = (id, metaError) => { const url = `https://www.youtube.com/watch?v=${id}`; return { url, run: fakeYtDlp({ [url]: { metaError } }) }; };
  const p = shut("Private0001", "ERROR: [youtube] Private0001: Private video. Sign in if you've been granted access");
  refused(await call({ url: p.url }, { run: p.run }), "private", /private/);
  const a = shut("AgeGate0001", "ERROR: [youtube] AgeGate0001: Sign in to confirm your age. This video may be inappropriate for some users.");
  refused(await call({ url: a.url }, { run: a.run }), "age_gate", /age-restricted.*don't sign in to get around that/);
  const m = shut("Members0001", "ERROR: Join this channel to get access to members-only content");
  refused(await call({ url: m.url }, { run: m.run }), "paywall", /paying channel members/);
});

test("age-gated or private read off the metadata too (availability, age_limit)", async () => {
  const a = silentYt("AgeMeta0001", { age_limit: 18 });
  refused(await call({ url: a.url }, { run: fakeYtDlp(a.lib) }), "age_gate", /age-restricted/);
  const p = silentYt("PrivMeta001", { availability: "private" });
  refused(await call({ url: p.url }, { run: fakeYtDlp(p.lib) }), "private", /private/);
});

test("a YouTube bot check on this address goes to the next tier (the video model), and says what failed", async () => {
  const url = "https://www.youtube.com/watch?v=BotCheck001";
  const brain = geminiLike();
  const r = await call({ url }, { run: fakeYtDlp({ [url]: { metaError: "ERROR: Sign in to confirm you're not a bot" } }), brain });
  assert.equal(r.tier, "watch");
  assert.match(r.details_failed, /not a bot/);
  // With no video model, it is one plain line, not a retry and not a disguise.
  const none = await call({ url }, { run: fakeYtDlp({ [url]: { metaError: "ERROR: Sign in to confirm you're not a bot" } }) });
  refused(none, "login", /wanted me to sign in/);
});

test("an unsupported site is said plainly and pointed at reading the page instead", async () => {
  const r = await call({ url: "https://example.com/not-a-video" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a video page/);
  assert.match(r.error, /web_lookup/);
});

test("listening has its own limit: no captions and over an hour is one line, nothing downloaded", async () => {
  const v = vimeo(900003, { duration: 5400 });
  const brain = geminiLike();
  const run = fakeYtDlp(v.lib);
  const r = await call({ url: v.url }, { run, brain });
  refused(r, "too_long", /1:30:00 long and has no captions I can read, so I'd have to listen to it, and I only listen to up to 60 minutes/);
  assert.equal(brain.calls.length, 0);
  assert.ok(run.calls.every(a => a.includes("-J") || a.includes("--skip-download")), "no audio call");
});

test("too big: the audio call carries the size cap, and a refusal by yt-dlp is one plain line", async () => {
  const v = vimeo(900004);
  const base = fakeYtDlp(v.lib);
  const run = async (args, o) => {
    base.calls.push(args);
    if (!args.includes("-J") && !args.includes("--skip-download")) {
      return { ok: true, code: 0, stdout: "[download] File is larger than max-filesize (300000000 bytes > 150000000 bytes). Aborting.", stderr: "" };
    }
    return base(args, o);
  };
  const r = await call({ url: v.url }, { run, brain: geminiLike() });
  const audioCall = base.calls.find(a => !a.includes("-J") && !a.includes("--skip-download"));
  assert.equal(audioCall[audioCall.indexOf("--max-filesize") + 1], "150000000");
  refused(r, "too_big", /over 150 MB, so I didn't download it/);
  assert.deepEqual(audioLeftOnDisk(), []);
});

// ---------------------------------------------------------------------------
// The heads-up, and the five-minute ceiling
// ---------------------------------------------------------------------------

test("over ten minutes and not kept: one heads-up text first; kept or short: none", async () => {
  const sent = [];
  const headsUp = async (text) => { sent.push(text); return { ok: true }; };
  const r = await call({ url: CREATOR }, { videoHeadsUp: headsUp });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /pulling the transcript now/);
  assert.doesNotMatch(sent[0], /\bsay\b|\btype\b/i);
  assert.match(r.heads_up, /already texted them/);
  await call({ url: CREATOR }, { videoHeadsUp: headsUp });
  assert.equal(sent.length, 1, "a kept transcript is instant: no heads-up");
  await call({ url: AUTO }, { videoHeadsUp: headsUp });
  assert.equal(sent.length, 1, "3:33 is not long");
});

test("the heads-up goes through message_send to their own thread", async () => {
  const { router, fake } = harness();
  await runTool("video_understand", { url: CREATOR }, { conversationId: C, channels: router, videoRun: fakeYtDlp(library()), videoModel: null, videoTranscriber: null });
  assert.ok(fake.sent.some(m => /pulling the transcript now/.test(m.text ?? "")), JSON.stringify(fake.sent).slice(0, 300));
});

test("past the deadline: a plain failure, not a hang", async () => {
  const never = async () => new Promise(() => {});
  const r = await call({ url: "https://www.youtube.com/watch?v=Stuck000001" }, { run: never, videoDeadlineMs: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.timed_out, true);
  assert.match(r.say, /couldn't get what's in that video within/);
  assert.equal(r.retry, false);
  assert.equal(config.videoIntakeDeadlineMs, 300_000, "five minutes unless set");
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

test("find: just the matching moments with h:mm:ss times and a link to each, not the whole transcript", async () => {
  const r = await call({ url: SPEECH, find: "pricing" });
  assert.equal(r.ok, true);
  assert.equal(r.transcript, undefined, "the long transcript is not put in context");
  assert.equal(r.found.length, 1);
  assert.equal(r.found[0].at, "52:30");
  assert.match(r.found[0].text, /pricing changes/);
  assert.equal(r.found[0].link, "https://youtu.be/Spe3chLong1?t=3150");
  assert.match(r.searched, /the whole transcript, 0:00–1:39:30/);
  assert.match(r.note, /Quote with the time/);
  const none = await call({ url: SPEECH, find: "dinosaurs" });
  assert.deepEqual(none.found, []);
  assert.match(none.note, /Nothing in the transcript matches/);
});

test("searchCues: a phrase ranks first, near hits are one moment, and times past an hour read h:mm:ss", () => {
  const cues = [
    { at: 0, text: "hello" }, { at: 5, text: "the price of eggs" }, { at: 10, text: "price again" },
    { at: 3725, text: "we talk about the price of eggs here" },
  ];
  const hits = video.searchCues(cues, "price of eggs");
  assert.deepEqual(hits.map(h => h.at), ["0:05", "1:02:05"]);
});

// ---------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------

test("pdf: the whole transcript as m:ss lines, made by document_create and only 'sent' once it arrived", async () => {
  const { router, fake } = harness();
  const ctx = { conversationId: C, channels: router, renderDocument: fakeRender, videoRun: fakeYtDlp(library()), videoModel: null, videoTranscriber: null, videoHeadsUp: async () => ({ ok: true }) };
  const r = await runTool("video_understand", { url: AUTO, pdf: true }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.pdf.sent, true);
  assert.match(r.note, /arrived/);
  assert.equal(r.transcript, undefined, "the text is in the file, not pasted");
  const doc = db.listDocuments(C)[0];
  assert.equal(doc.kind, "pdf");
  assert.match(doc.title, /Never Gonna Give You Up/);
  assert.match(doc.subtitle, /transcript from the video's auto-generated captions/);
  const blocks = typeof doc.blocks === "string" ? JSON.parse(doc.blocks) : doc.blocks;
  const text = (blocks ?? []).map(b => b.text ?? "").join("\n");
  assert.match(text, /^0:\d\d \S/m, "each line is 'm:ss text'");
  assert.ok(fake.sent.some(m => m.media || m.attachments || m.file), "a file went into the thread");
});

test("pdf that does not arrive is never called sent, and a watched video gets no fake transcript", async () => {
  const { router } = harness({ media: false });
  const ctx = { conversationId: C, channels: router, renderDocument: fakeRender, videoRun: fakeYtDlp(library()), videoModel: null, videoTranscriber: null, videoHeadsUp: async () => ({ ok: true }) };
  const r = await runTool("video_understand", { url: AUTO, pdf: true }, ctx);
  assert.notEqual(r.pdf?.sent, true);
  assert.match(r.note, /did NOT arrive. Do not say it was sent/);

  const v = silentYt("WatchedPdf1");
  const w = await runTool("video_understand", { url: v.url, pdf: true }, { ...ctx, videoRun: fakeYtDlp(v.lib), videoModel: geminiLike(), videoModelStatus: WATCHING });
  assert.equal(w.ok, false);
  assert.match(w.error, /watched by a video model.*not a word-for-word transcript/);
});

test("a transcript too long for one document stops at a line and says where", () => {
  const lines = Array.from({ length: 4000 }, (_, i) => ({ at: i * 3, text: `line ${i} ${"words ".repeat(12)}` }));
  const { blocks, stoppedAt } = video.transcriptBlocks(lines);
  assert.ok(blocks.length <= 60);
  assert.ok(blocks.every(b => b.text.length <= 4000));
  assert.ok(stoppedAt > 0);
  assert.match(blocks.at(-1).text, /goes on past .* This PDF stops there/);
});

// ---------------------------------------------------------------------------
// The wording, and the switch
// ---------------------------------------------------------------------------

test("how it knows is always said, in a few words, never hidden", () => {
  assert.equal(video.howWeGotIt("captions", "creator"), "from the creator's captions");
  assert.equal(video.howWeGotIt("captions", "auto"), "from the video's auto-generated captions");
  assert.equal(video.howWeGotIt("listen"), "by listening to the audio");
  assert.equal(video.howWeGotIt("watch"), "by watching it");
  const t = toolsFor(C).find(x => x.name === "video_understand");
  assert.match(t.description, /Always say in a few words how you know what is in it: from its captions, by listening to the audio, or by watching it/);
  assert.doesNotMatch(t.description, /never (tell|say to|mention to) (them|the user|the person) how/i);
  assert.ok(t.input_schema.properties.find && t.input_schema.properties.pdf);
});

const fingerprint = (conv) => createHash("sha256")
  .update(systemFor(accounts.ownerOf(conv)))
  .update(JSON.stringify(toolsFor(conv)))
  .digest("hex");

test("switch off, or a person 'owner' does not cover: the prompt and tool list are the same bytes, and the old path runs", async () => {
  config.videoIntake = "off";
  const offOther = fingerprint(OTHER), offOwner = fingerprint(C);
  const plain = JSON.stringify(tools.find(t => t.name === "video_understand"));
  assert.equal(JSON.stringify(toolsFor(C).find(t => t.name === "video_understand")), plain, "off: the tool exactly as written");
  config.videoIntake = "owner";
  assert.equal(videoIntakeFor(OTHER), false);
  assert.equal(fingerprint(OTHER), offOther, "'owner' changes nothing for a person it does not cover");
  assert.notEqual(fingerprint(C), offOwner, "and it does reach the owner");
  config.videoIntake = "on";
  assert.equal(videoIntakeFor(OTHER), true, "'on' is everybody, invited people included");

  // The dispatch: off, a bare link is the old result exactly — no cache row, no say_how, no offer.
  config.videoIntake = "off";
  const run = fakeYtDlp(library());
  const r = await call({ url: CREATOR, find: "neuron", pdf: true }, { run });
  assert.equal(r.tier, "captions");
  assert.equal(r.say_how, undefined);
  assert.equal(r.if_just_a_link, undefined);
  assert.equal(r.found, undefined);
  assert.equal(r.pdf, undefined);
  assert.equal(cacheRows(), 0);
  const direct = await video.videoUnderstand(CREATOR, { run: fakeYtDlp(library()), bin: "/fake/yt-dlp", model: null, transcriber: null });
  assert.equal(r.how, direct.how);
  assert.equal(r.transcript, direct.transcript);
  console.log(`# fingerprint off/non-covered ${offOther.slice(0, 16)}`);
});
