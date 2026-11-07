// A video somebody sent (a screen recording, a camera-roll clip) is watched on the live backend,
// and a watch that never finishes is stopped and told honestly.
//
// Found 2026-11-01 17:50 UTC: two screen recordings texted in over iMessage (media 194, 195) sat at
// `waiting` for 15+ minutes and never moved. The live turns ran on the `claude` CLI backend, which
// never called videosFor at all; and nothing anywhere bounded how long one watch could take. No
// network and no real wait here: the watch is a stub and the clock is a fake.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-video-timeout-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { videosFor, fetchVideo, videoTimedOutLine } = await import("../src/media.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const { config } = await import("../src/config.js");
const db = await import("../src/db.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => db.saveConversation("dm:owner", []));

const clip = (filename = "ScreenRecording_11-01-2026_12-49-09_1.mov", media_id = 7) =>
  ({ kind: "video", filename, url: `https://cdn.test/${filename}`, media_id });

/** A clock that only moves when the test says so. */
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimeout: (h) => { pending.delete(h); },
    fire() { for (const [h, t] of [...pending]) { pending.delete(h); t.fn(); } },
    get armed() { return [...pending.values()].map(t => t.ms); },
  };
}

test("a watch that never answers is stopped at the deadline, told honestly, and recorded as failed", async () => {
  const timers = fakeTimers();
  const covers = [];
  const logs = [];
  let seenSignal = null;
  const pending = videosFor([clip()], {
    timeoutMs: 180_000, timers,
    cover: (id, c) => covers.push({ id, ...c }),
    log: (x) => logs.push(x),
    watch: ({ signal }) => { seenSignal = signal; return new Promise(() => {}); },
  });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(timers.armed, [180_000], "one deadline, of the length asked for");
  assert.deepEqual(covers, [{ id: 7, coverage: "processing" }], "while it runs the record says it is being worked on");
  assert.equal(seenSignal.aborted, false);

  timers.fire();
  const { notes, seen } = await pending;
  assert.equal(seenSignal.aborted, true, "the download and the model's request are told to stop");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /watching it was stopped after 3 minutes/);
  assert.match(notes[0], /nothing in it has been seen/);
  assert.match(notes[0], /never describe or guess at what is in it/);
  assert.match(notes[0], /a screenshot of the part that matters/, "and what can still be done");
  assert.equal(/"/.test(notes[0]), false, "no words handed to them to say back");
  assert.match(seen[0], /nothing in it was seen/);
  assert.equal(covers.at(-1).coverage, "failed");
  assert.match(covers.at(-1).detail, /stopped after 3 minutes/);
  assert.deepEqual(logs, [{ video: clip().filename, timed_out: true, ms: 180_000 }]);
});

test("a watch that answers in time is used, and its deadline is cleared", async () => {
  const timers = fakeTimers();
  const covers = [];
  const { notes, seen } = await videosFor([clip()], {
    timers, cover: (id, c) => covers.push({ id, ...c }),
    watch: async () => ({ ok: true, text: "a woman talking to camera about bills", bytes: 1234 }),
  });
  assert.deepEqual(timers.armed, [], "nothing left ticking");
  assert.match(notes[0], /here is what is in it:\na woman talking to camera/);
  assert.match(seen[0], /you watched it when it arrived/);
  assert.deepEqual(covers.map(c => c.coverage), ["processing", "watched"]);
});

test("two videos each get their own deadline: one stuck does not cost the other", async () => {
  const timers = fakeTimers();
  let n = 0;
  const pending = videosFor([clip("a.mov", 1), clip("b.mov", 2)], {
    timers,
    watch: () => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true, text: "the second one", bytes: 1 })),
  });
  await new Promise(r => setImmediate(r));
  timers.fire();
  const { notes } = await pending;
  assert.match(notes[0], /a\.mov.*stopped after/);
  assert.match(notes[1], /the second one/);
});

test("a watch that throws is a failure in words, not a lost turn", async () => {
  const { notes } = await videosFor([clip()], { timers: fakeTimers(), watch: async () => { throw new Error("socket hang up\nstack"); } });
  assert.match(notes[0], /watching it failed \(socket hang up\)/);
});

test("the deadline is three minutes unless set, and the line says the length it really was", () => {
  assert.equal(config.videoWatchTimeoutMs, 180_000);
  assert.match(videoTimedOutLine(clip(), 90_000), /after 90 seconds/);
  assert.match(videoTimedOutLine(clip(), 600_000), /after 10 minutes/);
  assert.match(videoTimedOutLine(clip(), 30_000), /after 30 seconds/);
});

test("fetchVideo hands the deadline to the download and to the video model", async () => {
  const ac = new AbortController();
  const got = { fetch: null, watch: null };
  const out = await fetchVideo({
    url: "https://cdn.test/clip.mov", filename: "clip.mov", tmpDir: join(dir, "v"), signal: ac.signal,
    fetchImpl: async (_u, init) => {
      got.fetch = init.signal;
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("mov") };
    },
    provider: { watchFile: async (_f, opts) => { got.watch = opts.signal; return { ok: true, text: "seen" }; } },
  });
  assert.equal(out.ok, true);
  assert.equal(got.watch, ac.signal, "the model's request stops at the same deadline");
  ac.abort();
  assert.equal(got.fetch.aborted, true, "and so does the download");
});

test("a deadline already passed by the time the download lands uploads nothing", async () => {
  const ac = new AbortController();
  let watched = false;
  const out = await fetchVideo({
    url: "https://cdn.test/clip.mov", filename: "clip.mov", tmpDir: join(dir, "v"), signal: ac.signal,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => { ac.abort(); return Buffer.from("mov"); } }),
    provider: { watchFile: async () => { watched = true; return { ok: true, text: "x" }; } },
  });
  assert.equal(out.ok, false);
  assert.equal(out.timed_out, true);
  assert.equal(watched, false);
});

// ---------- the live backend watches videos at all ----------

const noMcp = async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} });
const noImages = async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] });

test("on the claude CLI backend a video they send is watched and handed to the turn", async () => {
  const calls = [];
  const asked = [];
  await runTurnViaCli({
    conversationId: "dm:owner", text: "", attachments: [clip()],
    images: noImages, startMcp: noMcp,
    videos: async (attachments) => { asked.push(attachments); return { notes: ["they sent a video (x.mov) — here is what is in it:\na car ad"], seen: ["they sent a video (x.mov); you watched it when it arrived and cannot watch it again"] }; },
    run: async (args) => { calls.push(args); return { ok: true, envelope: { result: "nice, that car one works" } }; },
  });
  assert.equal(asked.length, 1, "videosFor is called on this backend");
  assert.equal(asked[0][0].kind, "video");
  assert.match(calls[0].prompt, /here is what is in it:\na car ad/);
  assert.match(db.loadConversation("dm:owner")[0].content, /you watched it when it arrived/);
});

test("on the claude CLI backend a stuck video still lets the turn answer, with the honest line", async () => {
  const timers = fakeTimers();
  const calls = [];
  const turn = runTurnViaCli({
    conversationId: "dm:owner", text: "", attachments: [clip()],
    images: noImages, startMcp: noMcp,
    videos: (attachments, opts) => videosFor(attachments, { ...opts, timers, watch: () => new Promise(() => {}) }),
    run: async (args) => { calls.push(args); return { ok: true, envelope: { result: "that one didn't come through" } }; },
  });
  for (let i = 0; i < 20 && !timers.armed.length; i++) await new Promise(r => setImmediate(r));
  timers.fire();
  const reply = await turn;
  assert.equal(reply, "that one didn't come through");
  assert.match(calls[0].prompt, /watching it was stopped after 3 minutes/);
});
