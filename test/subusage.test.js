// How full each Claude subscription is, on the status page (src/subusage.js, 2026-10-25).
//
// What has to stay true:
//
//   - **the numbers are the CLI's own.** A stream-json `rate_limit_event` and the usage endpoint's
//     answer are read as they really look (fixtures captured from CLI 2.1.296); nothing invents a
//     percentage, and a reading whose window has since reset reads 0.
//   - **only a signed, fresh, new push from the Mac is kept.** Wrong HMAC, a far-off clock or a
//     replay is refused; with no secret configured the endpoint does not exist.
//   - **a Mac that stops pushing is "last seen X ago", never a red and never a text.**
//   - **Reason's own window at 80% texts the owner once** through the sustained-alert path.
//   - **the backstop never runs a model** and asks the usage endpoint at most once per 15 minutes,
//     only when the CLI has been used since the last reading.
//
// No network, no API key: every fetch is injected and the CLI is a shell script.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-subusage-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SEARCH_PROVIDER = "parallel";
process.env.PARALLEL_API_KEY = "test-parallel";
process.env.OPENAI_API_KEY = "test-openai";
process.env.REASON_CALL_PROVIDER = "fake";
process.env.REASON_CLAUDE_CREDENTIALS = join(dir, "no-credentials.json");
import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];

const subusage = await import("../src/subusage.js");
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const { createServer } = await import("../src/http.js");
const { renderOps } = await import("../src/pages/ops.js");
const { runClaudeCli, cliConfig, cliRuns } = await import("../src/backends/cli.js");
const { clock, config } = await import("../src/config.js");

// Captured from `claude -p --output-format stream-json --verbose` (2.1.296) on 2026-10-25.
const RATE_LIMIT_LINE = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792948200, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.32, resetsAt: 1792948200 }, seven_day: { utilization: 0.44, resetsAt: 1793318400 } } }, uuid: "81da3a29", session_id: "a83923fd" });
// GET /api/oauth/usage, trimmed to the fields read (2026-10-25).
const USAGE_RESPONSE = {
  five_hour: { utilization: 32.0, resets_at: "2026-10-25T17:09:59.912754+00:00" },
  seven_day: { utilization: 45.0, resets_at: "2026-10-29T23:59:59.912772+00:00" },
  seven_day_opus: null,
  limits: [
    { kind: "session", group: "session", percent: 32, resets_at: "2026-10-25T17:09:59.912754+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 45, resets_at: "2026-10-29T23:59:59.912772+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 14, resets_at: "2026-10-29T23:59:59.912772+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};

const sent = [];
const runtime = { say: (c, text) => { sent.push({ c, text }); return text; }, interval: {}, lastSweepAt: clock.now(), on() {} };
const OK = async () => ({ ok: true, status: 200 });
const pass = async () => ops.settle({ report: await ops.runChecks({ runtime, probe: OK, usageFetch: () => { throw new Error("no network in tests"); } }), runtime });
const row = (report, id) => report.checks.find(c => c.id === id);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  sent.length = 0;
  db.db.exec("DELETE FROM subscription_usage; DELETE FROM ops_checks; DELETE FROM ops_state; DELETE FROM provider_calls; DELETE FROM provider_calls_hourly;");
  runtime.lastSweepAt = clock.now();
  delete process.env.REASON_USAGE_INGEST_SECRET;
});

// ---------- parsing ----------

test("pinned: a stream-json rate_limit_event is read as the CLI printed it — fractions to percent, epoch seconds to ms", () => {
  const r = subusage.fromRateLimitEvent(JSON.parse(RATE_LIMIT_LINE));
  assert.deepEqual(r, { five_pct: 32, five_resets_at: 1792948200000, week_pct: 44, week_resets_at: 1793318400000, status: "allowed", via: "cli" });
  const out = ["not json", JSON.stringify({ type: "system" }), RATE_LIMIT_LINE, JSON.stringify({ type: "result", result: "ok" })].join("\n");
  assert.equal(subusage.fromStreamOutput(out).five_pct, 32);
  assert.equal(subusage.fromStreamOutput(JSON.stringify({ type: "result", result: "hi" })), null, "no event, no reading — never a made-up number");
  assert.equal(subusage.fromRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), null);
});

test("pinned: the usage endpoint's answer — percentages as given, scoped limits named by their model", () => {
  const r = subusage.fromUsageResponse(USAGE_RESPONSE);
  assert.equal(r.five_pct, 32);
  assert.equal(r.week_pct, 45);
  assert.equal(r.five_resets_at, Date.parse("2026-10-25T17:09:59.912Z"));
  assert.deepEqual(r.extra, { "week Fable": 14 });
  assert.equal(subusage.fromUsageResponse({ five_hour: null, seven_day: null }), null);
});

test("a reading whose window has reset since reads 0, and the row says it reset", () => {
  const at = clock.now();
  subusage.record("reason", { five_pct: 60, five_resets_at: at + 60_000, week_pct: 20, week_resets_at: at + 3 * 86400_000 }, at);
  clock.skip(2 * 60_000);
  const r = subusage.checks({ now: clock.now(), day: "x" }).find(c => c.id === "subscription:reason");
  assert.match(r.detail, /5-hour 0% · reset/);
  assert.match(r.detail, /week 20% · resets/);
});

// ---------- Reason's own subscription ----------

test("pinned: a CLI run is counted, and a streamed run's rate-limit line becomes Reason's reading", async () => {
  subusage.listen();
  const saved = cliConfig.bin;
  const fake = join(dir, "cli-stream.sh");
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho '${RATE_LIMIT_LINE}'\necho '{"type":"result","result":"a red car","is_error":false}'\n`, { mode: 0o755 });
  cliConfig.bin = fake;
  try {
    const r = await runClaudeCli({ prompt: "what is this", system: "s", images: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] });
    assert.equal(r.envelope.result, "a red car");
  } finally { cliConfig.bin = saved; }
  const last = subusage.latest("reason");
  assert.equal(last.five_pct, 32);
  assert.equal(last.via, "cli");
  assert.equal(db.providerCalls("claude-subscription", new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })).calls, 1);
  // Numbers only: nothing the run said is kept.
  assert.equal(JSON.stringify(db.db.prepare("SELECT * FROM subscription_usage").all()).includes("red car"), false);
  assert.ok(cliRuns.listenerCount("run") >= 1);
});

test("pinned: Reason's window at 80% goes amber and texts the owner once — not on every pass", async () => {
  const at = clock.now();
  subusage.record("reason", { five_pct: 84, five_resets_at: at + 2 * 3600_000, week_pct: 30, week_resets_at: at + 4 * 86400_000, via: "cli" }, at);
  let r = await pass();
  assert.equal(r.text, null, "a first sighting waits out the blip window");
  clock.skip(5 * 60_000); runtime.lastSweepAt = clock.now();
  r = await pass();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Reason's subscription: nearly full — Reason stops replying at 100% · 5-hour 84%/);
  for (let i = 0; i < 3; i++) { clock.skip(5 * 60_000); runtime.lastSweepAt = clock.now(); await pass(); }
  assert.equal(sent.length, 1, "the same episode is one text");
});

test("below 80% the row is green; at 100% it is red and says Reason cannot reply", async () => {
  const at = clock.now();
  subusage.record("reason", { five_pct: 79, five_resets_at: at + 3600_000 }, at);
  let rep = await ops.runChecks({ runtime, probe: OK });
  assert.equal(row(rep, "subscription:reason").state, "ok");
  subusage.record("reason", { five_pct: 100, five_resets_at: at + 3600_000 }, at + 1);
  rep = await ops.runChecks({ runtime, probe: OK });
  assert.equal(row(rep, "subscription:reason").state, "bad");
  assert.match(row(rep, "subscription:reason").detail, /cannot reply until it resets/);
});

test("pinned: the backstop asks the usage endpoint at most once per 15 minutes, only after the CLI ran, and never on the API backend", async () => {
  const token = join(dir, "creds.json");
  writeFileSync(token, JSON.stringify({ claudeAiOauth: { accessToken: "tok-test", expiresAt: clock.now() + 3600_000 } }));
  const asked = [];
  const fetchImpl = async (url, init) => { asked.push({ url, auth: init.headers.authorization }); return { ok: true, status: 200, json: async () => USAGE_RESPONSE }; };
  const tok = () => subusage.readToken({ path: token });
  const was = config.backend;
  try {
    config.backend = "api";
    assert.deepEqual(await subusage.backstop({ fetchImpl, token: tok, ranAt: clock.now() }), { skipped: "not on the CLI backend" });
    config.backend = "claude-cli";
    assert.deepEqual(await subusage.backstop({ fetchImpl, token: tok, ranAt: clock.now() }), { recorded: true });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(asked[0].auth, "Bearer tok-test");
    clock.skip(5 * 60_000);
    assert.deepEqual(await subusage.backstop({ fetchImpl, token: tok, ranAt: clock.now() }), { skipped: "fresh" });
    clock.skip(20 * 60_000);
    assert.deepEqual(await subusage.backstop({ fetchImpl, token: tok, ranAt: 0 }), { skipped: "no use since the last reading" });
    assert.match(String((await subusage.backstop({ fetchImpl, token: tok, ranAt: clock.now() })).recorded), /true/);
    assert.equal(asked.length, 2);
    // An expired login token is left for the CLI to refresh.
    writeFileSync(token, JSON.stringify({ claudeAiOauth: { accessToken: "tok-test", expiresAt: clock.now() - 1 } }));
    assert.equal(subusage.readToken({ path: token }), null);
  } finally { config.backend = was; }
});

// ---------- the Mac's push ----------

const SECRET = "test-secret-not-real";
function push(body, { ts = clock.now(), secret = SECRET, sig = null } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const s = sig ?? createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  return subusage.ingest({ body: raw, headers: { "x-reason-timestamp": String(ts), "x-reason-signature": `sha256=${s}` }, secret: SECRET });
}

test("pinned: only a signed, current, new push is kept", () => {
  const body = { five_pct: 36, five_resets_at: clock.now() + 3600_000, week_pct: 45, week_resets_at: clock.now() + 5 * 86400_000, turns_today: 736, extra: { "week Fable": 14 } };
  assert.equal(subusage.ingest({ body: JSON.stringify(body), headers: {}, secret: "" }).status, 404, "no secret, no endpoint");
  assert.equal(push(body, { secret: "wrong" }).status, 401);
  assert.equal(push(body, { sig: "00" }).status, 401);
  assert.equal(push(body, { ts: clock.now() - 10 * 60_000 }).status, 401, "a clock ten minutes off");
  const ts = clock.now();
  assert.equal(push(body, { ts }).status, 204);
  assert.equal(push(body, { ts }).status, 409, "the same push again is a replay");
  assert.equal(push({ prompt: "hello" }, { ts: ts + 1 }).status, 400, "no numbers, nothing kept");
  const c = subusage.latest("coding");
  assert.equal(c.five_pct, 36);
  assert.equal(c.turns_today, 736);
  assert.equal(JSON.stringify(db.db.prepare("SELECT * FROM subscription_usage").all()).includes("hello"), false);
  // A signed body that is not an object is a 400, not a crash; a limit name of any other shape is dropped.
  for (const [i, b] of ["null", "[1]", "7"].entries()) assert.equal(push(b, { ts: ts + 2 + i }).status, 400, b);
  assert.equal(push({ five_pct: 1, extra: { "<b>x</b>": 5, "week Fable": 9 } }, { ts: ts + 10 }).status, 204);
  assert.deepEqual(JSON.parse(subusage.latest("coding").extra), { "week Fable": 9 });
});

test("pinned: the HTTP endpoint answers 204 to a good push and 401 to a bad one", async () => {
  process.env.REASON_USAGE_INGEST_SECRET = SECRET;
  const server = createServer({ router: null, runtime: null });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/ops/usage`;
  try {
    const raw = JSON.stringify({ five_pct: 12, turns_today: 3 });
    const ts = String(Date.now());
    const good = createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
    let res = await fetch(url, { method: "POST", body: raw, headers: { "x-reason-timestamp": ts, "x-reason-signature": `sha256=${good}` } });
    assert.equal(res.status, 204);
    res = await fetch(url, { method: "POST", body: raw, headers: { "x-reason-timestamp": String(Number(ts) + 1), "x-reason-signature": `sha256=${good}` } });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test("pinned: a Mac that stopped pushing is 'last seen X ago' — green, quiet, never a text", async () => {
  const ts = clock.now();
  assert.equal(push({ five_pct: 97, five_resets_at: ts + 3 * 3600_000, turns_today: 5 }, { ts }).status, 204);
  let rep = await ops.runChecks({ runtime, probe: OK });
  let c = row(rep, "subscription:coding");
  assert.equal(c.state, "ok", "even at 97% the coding row is never amber");
  assert.equal(c.quiet, true);
  assert.match(c.detail, /5-hour 97%.*5 requests today · pushed 0s ago/);
  clock.skip(3 * 3600_000); runtime.lastSweepAt = clock.now();
  await pass(); clock.skip(5 * 60_000); runtime.lastSweepAt = clock.now();
  const r = await pass();
  c = JSON.parse(db.opsGet("report")).checks.find(x => x.id === "subscription:coding");
  assert.equal(c.state, "ok");
  assert.match(c.detail, /^last seen 3h ago \(the Mac is asleep or offline\)/);
  assert.equal(sent.length, 0);
  assert.equal(r.text, null);
});

test("never reported: the coding row is 'not set up', not a problem", async () => {
  const rep = await ops.runChecks({ runtime, probe: OK });
  assert.equal(row(rep, "subscription:coding").state, "off");
  assert.equal(rep.verdict, ops.verdictOf(rep.checks.filter(c => !c.id.startsWith("subscription:"))));
});

test("the page shows both rows under Claude subscriptions, with a 0–100 line for the five-hour window", async () => {
  const at = clock.now();
  subusage.record("reason", { five_pct: 40, five_resets_at: at + 3600_000 }, at - 2 * 3600_000);
  subusage.record("reason", { five_pct: 55, five_resets_at: at + 3600_000 }, at);
  push({ five_pct: 36, turns_today: 9 }, { ts: at });
  const report = await ops.runChecks({ runtime, probe: OK });
  assert.equal(report.trends.subscriptions.reason.at(-1), 55);
  assert.equal(report.trends.subscriptions.reason.at(-2), 40, "an hour with no reading carries the last one");
  const html = renderOps({ report, now: at });
  assert.match(html, /Claude subscriptions/);
  assert.match(html, /Reason&#39;s subscription|Reason's subscription/);
  assert.match(html, /Coding subscription \(Mac\)/);
  assert.match(html, /5-hour window, peak 55% in 24h/);
});
