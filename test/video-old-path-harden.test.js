// The old video path (video_understand for a person video intake does not cover): the same fetch
// hardening intake has, through the same code (src/video.js hardenArgs, runYtDlp's process group).
//
// A real process stands in for yt-dlp: it logs every run, and it behaves the way yt-dlp does about
// the catch-all extractor — with `--use-extractors all,-generic` a link to a site it has no extractor
// for is "Unsupported URL" and nothing is fetched; without it the link is fetched and its redirects
// followed (curl -L), which is how a public link reached this machine's own network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeYtDlp, fixture, meta } from "./fixture-video.js";

const dir = mkdtempSync(join(tmpdir(), "reason-video-old-"));
const FAKE = join(dir, "yt-dlp-fake");
const RUNS = join(dir, "runs.log");
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_AUDIO_TMP = join(dir, "audio-tmp");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.GEMINI_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.REASON_TRANSCRIBER = "";
process.env.REASON_YTDLP_BIN = FAKE;
process.env.RUNS_LOG = RUNS;
process.env.REASON_VIDEO_INTAKE = "owner";

// The private host: counts every request that reaches it.
let privateHits = 0;
const secret = createServer((req, res) => { privateHits++; res.end("internal"); });
// The public-looking redirector: every request is sent on to the private host.
const redirector = createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${secret.address().port}/latest/meta-data/` }); res.end(); });

before(async () => {
  await new Promise(r => secret.listen(0, "127.0.0.1", r));
  await new Promise(r => redirector.listen(0, "127.0.0.1", r));
  writeFileSync(FAKE, `#!/bin/bash
echo "$*" >> "$RUNS_LOG"
url="\${@: -1}"
case " $* " in *" all,-generic "*) generic=off;; *) generic=on;; esac
case "$url" in
  https://www.youtube.com/*|https://www.ted.com/*) echo "ERROR: [fake] no network in tests" >&2; exit 1;;
esac
if [ "$generic" = off ]; then echo "ERROR: Unsupported URL: $url" >&2; exit 1; fi
curl -s -L --max-redirs 3 --max-time 5 --resolve "redirector.example:${redirector.address().port}:127.0.0.1" "$url" > /dev/null
echo "ERROR: [generic] Unable to extract video" >&2; exit 1
`);
  chmodSync(FAKE, 0o755);
});
after(() => { secret.close(); redirector.close(); rmSync(dir, { recursive: true, force: true }); });

const { config } = await import("../src/config.js");
const db = await import("../src/db.js");
const video = await import("../src/video.js");
const { runTool, videoIntakeFor } = await import("../src/tools.js");

const C = config.ownerConversation;
const OTHER = "dm:not-covered";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
db.upsertAccount({ conversationId: OTHER, channel: "test", address: "+14155550111", name: "Sam", isOperator: false });
const runs = () => (existsSync(RUNS) ? readFileSync(RUNS, "utf8").trim().split("\n").filter(Boolean) : []);
const ask = (url, extra = {}) => runTool("video_understand", { url }, { conversationId: OTHER, videoModel: null, videoTranscriber: null, ...extra });

test("the person is one video intake does not cover, so this is the old path", () => {
  assert.equal(videoIntakeFor(OTHER), false);
  assert.equal(videoIntakeFor(C), true);
});

test("old path: option-injection, private-address and file: links are refused and yt-dlp never runs", async () => {
  rmSync(RUNS, { force: true });
  for (const bad of ["--exec=touch /tmp/pwned", "-o/etc/x https://www.ted.com/talks/x", "http://127.0.0.1:8080/v.mp4", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/v.mp4", "http://[::1]/v", "file:///etc/passwd"]) {
    const r = await ask(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(typeof r.error === "string" && r.error.length > 0, bad);
  }
  assert.deepEqual(runs(), [], "yt-dlp was never started");
  assert.equal(privateHits, 0);
});

test("old path: a public link that redirects to a private address never reaches it", async () => {
  rmSync(RUNS, { force: true });
  privateHits = 0;
  const r = await ask(`http://redirector.example:${redirector.address().port}/go`);
  assert.equal(privateHits, 0, "the private host was never reached");
  assert.equal(r.ok, false);
  assert.equal(r.cannot, "not_a_video", "said with the existing 'not a video page' line");
  const ran = runs();
  assert.ok(ran.length >= 1, "yt-dlp did run, and refused the link itself");
  for (const line of ran) {
    for (const f of ["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--use-extractors all,-generic"]) assert.ok(line.includes(f), f);
    assert.match(line, / -- http:\/\/redirector\.example:\d+\/go$/, "-- right before the link");
  }
});

test("old path: a supported-site link behaves as before (same result shape, no intake fields, nothing cached)", async () => {
  const URL_A = "https://www.youtube.com/watch?v=aircAruvnKk";
  const run = fakeYtDlp({ [URL_A]: { meta: meta("creator.meta.json"), captions: { en: fixture("creator.en.vtt") }, audio: true } });
  const r = await ask(URL_A, { videoRun: run });
  assert.equal(r.ok, true);
  assert.equal(r.tier, "captions");
  assert.ok(r.transcript && r.captions?.source === "creator");
  for (const k of ["say_how", "if_just_a_link", "found", "pdf", "heads_up", "length_unknown"]) assert.equal(r[k], undefined, k);
  assert.ok(r.untrusted_content, "still marked as outside text, as before");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM video_cache").get().n, 0);
  // Every run hardened, the link last after "--".
  for (const args of run.calls) assert.deepEqual(args.slice(-2), ["--", URL_A]);
});

test("old path: a yt-dlp that outlives its timeout is killed with everything it started", async () => {
  const slow = join(dir, "yt-dlp-slow");
  const pids = join(dir, "pids.log");
  writeFileSync(slow, `#!/bin/bash\nsleep 300 &\necho $! >> "${pids}"\necho $$ >> "${pids}"\nsleep 300\n`);
  chmodSync(slow, 0o755);
  const r = await video.runYtDlp(["-J", "--", "https://www.ted.com/talks/x"], { bin: slow, timeoutMs: 700 });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /was still running after 0\.7s and was stopped/);
  await new Promise(res => setTimeout(res, 300));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const ps = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  assert.equal(ps.length, 2);
  for (const pid of ps) assert.equal(alive(pid), false, `pid ${pid} gone`);
});
