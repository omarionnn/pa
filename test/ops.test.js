// The status page: one answer to "is Reason all right", and a text when the answer changes.
//
// What has to stay true:
//
//   - **green means every check is green.** One yellow row and the top is not green.
//   - **a change of state texts the owner once.** The same state on the next pass says nothing;
//     the all-clear says so once too. Whatever the hour — there is no quiet-hours path in here.
//   - **credit is "working, N calls today, and the link".** The count is of calls that really
//     went out, counted at the one fetch everything passes through; the probe's own calls do not
//     inflate it.
//   - **a provider whose key is rejected goes red the first time it is used**, from the ledger,
//     with no probe needed.
//   - **the page is the owner's.** A proved browser sees it; anyone else gets the gate, and only a
//     request carrying the owner's key is offered the code, so a stranger at /ops cannot make the
//     owner's phone buzz.
//
// No API key, no network: every probe is injected.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-ops-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
// A search provider and an embedding key, so a clean install here is a fully green one.
process.env.REASON_SEARCH_PROVIDER = "parallel";
process.env.PARALLEL_API_KEY = "test-parallel";
process.env.OPENAI_API_KEY = "test-openai";
process.env.REASON_CALL_PROVIDER = "fake";

const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const { opsRequest } = await import("../src/http.js");
const { renderOps } = await import("../src/pages/ops.js");
const { clock, config } = await import("../src/config.js");

const OK = async () => ({ ok: true, status: 200 });
const sent = [];
const runtime = { say: (c, text) => { sent.push({ c, text }); return text; }, interval: {}, lastSweepAt: clock.now(), on() {} };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  sent.length = 0;
  db.db.exec(`DELETE FROM ops_checks; DELETE FROM ops_state; DELETE FROM provider_calls; DELETE FROM provider_state;
    DELETE FROM outbox; DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM unknown_outcomes;
    DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM usage;`);
  runtime.lastSweepAt = clock.now();
});

// ---------- the checks ----------

test("a clean install with its keys in place is green, and off rows do not count against it", async () => {
  const report = await ops.runChecks({ runtime, probe: OK });
  assert.equal(report.verdict, "ok");
  const off = report.checks.filter(c => c.state === "off");
  assert.ok(off.length > 0, "providers not set up are shown as off, not hidden");
  assert.ok(report.checks.every(c => ["ok", "off"].includes(c.state)), JSON.stringify(report.checks.filter(c => !["ok", "off"].includes(c.state))));
  const search = report.checks.find(c => c.id === "provider:parallel");
  assert.equal(search.label, "Parallel · search");
  assert.match(search.detail, /ready · no calls yet/);
  assert.equal(search.link, "https://platform.parallel.ai");
});

test("one yellow row keeps the top from green; one red row makes it red", async () => {
  db.createAccessRequest({ channel: "sendblue", address: "+15550001111", displayName: "Nia", firstMessage: "hi" });
  let report = await ops.runChecks({ runtime, probe: OK });
  assert.equal(report.verdict, "warn");
  assert.match(report.checks.find(c => c.id === "access").detail, /Nia/);

  const now = clock.now();
  db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, attempts, last_error, created_at, updated_at, failed_at)
    VALUES ('k1', 'dm:owner', 'sendblue', '+1', 'hello', 'failed', 5, 'they opted out', ?, ?, ?)`).run(now, now, now);
  report = await ops.runChecks({ runtime, probe: OK });
  assert.equal(report.verdict, "bad");
  const outbox = report.checks.find(c => c.id === "outbox");
  assert.equal(outbox.state, "bad");
  assert.match(outbox.detail, /1 text failed in the last day — they opted out/);
});

test("the search provider chosen in config but not set up is red, not off", async () => {
  const was = config.searchProvider;
  config.searchProvider = "tavily";
  try {
    const report = await ops.runChecks({ runtime, probe: OK });
    const row = report.checks.find(c => c.id === "provider:tavily");
    assert.equal(row.state, "bad");
    assert.match(row.detail, /chosen for search but not set up/);
  } finally { config.searchProvider = was; }
});

test("a sweep that has not run in four intervals is red", async () => {
  runtime.lastSweepAt = clock.now() - 10 * config.sweepEveryMs;
  const report = await ops.runChecks({ runtime, probe: OK });
  const sweep = report.checks.find(c => c.id === "sweep");
  assert.equal(sweep.state, "bad");
  assert.match(sweep.detail, /stuck/);
});

test("a probe that is refused is red for a bad key and yellow for a rate limit", async () => {
  let report = await ops.runChecks({ runtime, probe: async (p) => p.id === "openai" ? { ok: false, status: 401 } : { ok: true, status: 200 } });
  const openai = report.checks.find(c => c.id === "provider:openai");
  assert.equal(openai.state, "bad");
  assert.match(openai.detail, /key rejected \(HTTP 401\)/);

  report = await ops.runChecks({ runtime, probe: async (p) => p.id === "openai" ? { ok: false, status: 429 } : { ok: true, status: 200 } });
  assert.equal(report.checks.find(c => c.id === "provider:openai").state, "warn");
});

test("recall is only green when a real embedding round-trip worked", async () => {
  let report = await ops.runChecks({ runtime, probe: async (p) => p.id === "embeddings" ? { ok: false, status: 0, error: "fetch failed" } : { ok: true, status: 200 } });
  const recall = report.checks.find(c => c.id === "embeddings");
  assert.equal(recall.state, "warn");
  assert.match(recall.detail, /embedding call failed: unreachable/);
  report = await ops.runChecks({ runtime, probe: OK });
  assert.equal(report.checks.find(c => c.id === "embeddings").state, "ok");
});

test("an unknown outcome on a money action is red until it is cleared", async () => {
  db.db.prepare("INSERT INTO unknown_outcomes (conversation_id, action, target, why, cents, at) VALUES ('dm:owner', 'pay', 'x', 'timeout', 1200, ?)").run(clock.now());
  const report = await ops.runChecks({ runtime, probe: OK });
  const row = report.checks.find(c => c.id === "unknown");
  assert.equal(row.state, "bad");
  assert.match(row.detail, /1 action whose result is not known/);
});

// ---------- the ledger ----------

test("every outbound call is counted against its provider, and a stranger's host is left alone", async () => {
  const seen = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = String(input);
    if (u.includes("boom")) throw new Error("ECONNRESET boom");
    return new Response("{}", { status: u.includes("tavily") ? 401 : 200 });
  };
  try {
    ops.watchFetch({ record: (r) => seen.push(r), day: () => "2026-10-17" });
    await fetch("https://api.openai.com/v1/embeddings", { method: "POST" });
    await fetch("https://api.tavily.com/search");
    await fetch("https://generativelanguage.googleapis.com/v1beta/models");
    await fetch("https://www.googleapis.com/calendar/v3/x");
    await fetch("https://example.org/nothing-to-do-with-us");
    await assert.rejects(() => fetch("https://api.parallel.ai/v1/boom"));
  } finally {
    ops.unwatchFetch();
    globalThis.fetch = before;
  }
  assert.deepEqual(seen.map(r => [r.provider, r.ok, r.status]), [
    ["openai", true, 200],
    ["tavily", false, 401],
    ["gemini", true, 200],
    ["google", true, 200],
    ["parallel", false, 0],
  ]);
  assert.match(seen.at(-1).error, /ECONNRESET/);
});

test("a provider with no probe goes red from the ledger the first time its key is rejected, and says how many calls it made", async () => {
  const day = (await import("../src/accounts.js")).today();
  db.recordProviderCall({ provider: "parallel", day, ok: true, status: 200 });
  db.recordProviderCall({ provider: "parallel", day, ok: true, status: 200 });
  let report = await ops.runChecks({ runtime, probe: OK });
  let row = report.checks.find(c => c.id === "provider:parallel");
  assert.equal(row.state, "ok");
  assert.match(row.detail, /working · last call \d+s ago · 2 calls today$/);

  clock.skip(1000);
  db.recordProviderCall({ provider: "parallel", day, ok: false, status: 401, error: "HTTP 401" });
  report = await ops.runChecks({ runtime, probe: OK });
  row = report.checks.find(c => c.id === "provider:parallel");
  assert.equal(row.state, "bad");
  assert.match(row.detail, /key rejected \(HTTP 401\) · 3 calls today, 1 failed/);
});

// ---------- the text ----------

test("a change of state texts the owner once, with the link; the same state again says nothing; the all-clear says so once", async () => {
  const now = clock.now();
  db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, attempts, last_error, created_at, updated_at, failed_at)
    VALUES ('k2', 'dm:owner', 'sendblue', '+1', 'hello', 'failed', 5, 'opted out', ?, ?, ?)`).run(now, now, now);

  let r = ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c, "dm:owner");
  assert.match(sent[0].text, /^Reason check — 1 thing needs you:\n• Texts out: 1 text failed in the last day — opted out\nStatus page: https:\/\/reason\.example\.test\/ops\?k=/);
  assert.equal(r.changes.length, 1);

  r = ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 1, "the same red again is not a second text");
  assert.equal(r.text, null);

  db.db.exec("DELETE FROM outbox");
  r = ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, "Reason check — back to normal: Texts out.\nEverything is green.");

  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 2, "green staying green says nothing");
});

test("the first pass after install texts about anything already wrong — there is no prior state to compare, and wrong is wrong", async () => {
  db.createAccessRequest({ channel: "sendblue", address: "+15550002222", displayName: "Kofi", firstMessage: "yo" });
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Waiting for a yes: 1 person asked for access and has no answer: Kofi/);
});

test("a check's 'since' is when it entered its current state, not when it was last checked", async () => {
  db.createAccessRequest({ channel: "sendblue", address: "+15550003333", displayName: "Ama", firstMessage: "hey" });
  const t0 = clock.now();
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  clock.skip(3 * 60 * 60 * 1000);
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  const saved = ops.snapshot();
  assert.equal(saved.checks.find(c => c.id === "access").since, t0);
  const html = renderOps({ report: saved, now: clock.now() });
  assert.match(html, /Waiting for a yes<span class="since">for 3h<\/span>/);
});

// ---------- the page ----------

const GET = (headers = {}, key = null, json = false) => opsRequest({ json, key, method: "GET", headers, readBody: async () => "", runtime });
const POST = (body, headers = {}, key = null) => opsRequest({ key, method: "POST", headers, readBody: async () => body, runtime });

test("a browser nobody has proved gets the gate, and the code button only with the owner's key", async () => {
  let out = await GET();
  assert.equal(out.status, 401);
  assert.match(out.body, /Private page/);
  assert.doesNotMatch(out.body, /Text me the code/);

  out = await GET({}, "not-the-key");
  assert.doesNotMatch(out.body, /Text me the code/);

  out = await GET({}, ops.opsKey());
  assert.equal(out.status, 401);
  assert.match(out.body, /Text me the code/);
});

test("pressing send without the key texts nobody; with it, the owner is texted one code", async () => {
  let out = await POST("send=1");
  assert.equal(out.status, 401);
  assert.equal(sent.length, 0);
  assert.equal(db.pageCodesIssued("ops", 60_000), 0);

  out = await POST("send=1", {}, ops.opsKey());
  assert.equal(out.status, 401);
  assert.match(out.body, /texted Omari a six-character code/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c, "dm:owner");
  assert.match(sent[0].text, /Code to open "Reason status" on that browser: [A-Z2-9]{6}\./);
});

test("the right code opens the page, sets a cookie for the whole site, and that cookie opens it again — and the JSON", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  await POST("send=1", {}, ops.opsKey());
  const code = /: ([A-Z2-9]{6})\./.exec(sent[0].text)[1];

  const wrong = await POST("code=ZZZZZZ");
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /not right/);

  const opened = await POST(`code=${code}`);
  assert.equal(opened.status, 200);
  assert.match(opened.headers["Set-Cookie"], /^reason_page=[A-Za-z0-9_-]+; Path=\/; /);
  assert.match(opened.body, /Reason is healthy\./);

  const cookie = opened.headers["Set-Cookie"].split(";")[0];
  const again = await GET({ cookie });
  assert.equal(again.status, 200);
  assert.match(again.body, /All green/);
  assert.match(again.body, /Parallel · search/);
  assert.match(again.body, /Dashboard ›/);

  const asJson = await GET({ cookie }, null, true);
  assert.equal(asJson.status, 200);
  const parsed = JSON.parse(asJson.body);
  assert.equal(parsed.report.verdict, "ok");
  assert.equal(parsed.stale, false);
});

test("a session that belongs to somebody who is not an operator does not open it", async () => {
  db.startPageSession("ops", "tok-stranger", { conversationId: "dm:somebody-else" });
  const out = await GET({ cookie: "reason_page=tok-stranger" });
  assert.equal(out.status, 401);
});

test("a stale report is shown as red even if its last verdict was green", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  const fresh = renderOps({ report: ops.snapshot(), now: clock.now() });
  assert.match(fresh, /All green/);
  const stale = renderOps({ report: ops.snapshot(), now: clock.now() + ops.STALE_AFTER_MS + 60_000 });
  assert.match(stale, /The checks themselves have stopped/);
  assert.doesNotMatch(stale, /All green/);
});

test("before the first pass the page says it is checking rather than inventing a verdict", () => {
  const html = renderOps({ report: null, now: clock.now() });
  assert.match(html, /First check runs a few seconds after start/);
});

test("nothing the database says becomes markup", async () => {
  db.createAccessRequest({ channel: "sendblue", address: "+15550004444", displayName: "<img src=x onerror=alert(1)>", firstMessage: "hi" });
  const report = await ops.runChecks({ runtime, probe: OK });
  const html = renderOps({ report, now: clock.now() });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
