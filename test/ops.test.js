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

// The Server row reads this machine's load average, and the full suite running beside other work
// pushes a laptop past 2× its cores — every "is it green" assertion here then saw yellow (the
// ops flake under full-suite load, 2026-10-24). The load is pinned; the disk is still read.
import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
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
  delete runtime.lastSweepDoneAt;
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

test("a sweep that has not finished a pass in ten minutes is red", async () => {
  runtime.lastSweepAt = clock.now() - config.sweepStuckMs - 60_000;
  const report = await ops.runChecks({ runtime, probe: OK });
  const sweep = report.checks.find(c => c.id === "sweep");
  assert.equal(sweep.state, "bad");
  assert.match(sweep.detail, /stuck/);
});

// 2026-10-18: passes no longer overlap, so a pass hung in an await stops new ones from starting.
// The status page read the START stamp, which said nothing about whether the hung pass ever ended.
test("a pass that started but never finished is red, and a slow one that finished is not", async () => {
  runtime.lastSweepAt = clock.now() - 30_000;
  runtime.lastSweepDoneAt = clock.now() - config.sweepStuckMs - 60_000;
  let sweep = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "sweep");
  assert.equal(sweep.state, "bad", "read off when a pass last finished, not when one last began");
  assert.match(sweep.detail, /stuck/);

  // Three minutes of model turns is a slow pass, not a stuck one, and must not page anybody.
  runtime.lastSweepDoneAt = clock.now() - 3 * 60_000;
  sweep = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "sweep");
  assert.equal(sweep.state, "ok");
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

test("the safety screen row: amber when messages go unscreened, red when Anthropic is rate-limiting it, and refusals stay their own row", async () => {
  db.db.exec("DELETE FROM harm_events");
  const row = async () => (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "screen");
  assert.equal((await row()).state, "ok");
  for (let i = 0; i < 3; i++) db.recordHarmEvent({ conversationId: "dm:x", verdict: "unscreened" });
  assert.equal((await row()).state, "warn");
  for (let i = 0; i < 3; i++) db.recordHarmEvent({ conversationId: "dm:x", verdict: "unscreened", category: "rate_limited" });
  const red = await row();
  assert.equal(red.state, "bad");
  assert.match(red.detail, /3 rate-limited \(429\)/);
  const hard = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "harm");
  assert.match(hard.detail, /nothing stopped/, "an unread message is not a refusal");
  db.db.exec("DELETE FROM harm_events");
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

/** One pass, then the next one five minutes on: a check still wrong then is one worth a text. */
async function twoPasses() {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  clock.skip(5 * 60_000);
  runtime.lastSweepAt = clock.now();
  return ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
}

test("a change of state that lasts texts the owner once, with the link; the same state again says nothing; the all-clear says so once", async () => {
  const now = clock.now();
  db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, attempts, last_error, created_at, updated_at, failed_at)
    VALUES ('k2', 'dm:owner', 'sendblue', '+1', 'hello', 'failed', 5, 'opted out', ?, ?, ?)`).run(now, now, now);

  let r = ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 0, "not on the first pass it is seen");
  clock.skip(5 * 60_000);
  runtime.lastSweepAt = clock.now();
  r = ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c, "dm:owner");
  assert.match(sent[0].text, /^Reason check — 1 thing needs you:\n• Texts out: 1 text failed in the last day — opted out\nStatus page: https:\/\/heyreason\.com\/ops\?k=/);
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

test("a blip that is green again on the next pass is logged, never texted — no alert, no all-clear", async () => {
  // The shape of every OpenAI text on 2026-10-22/23: one pass red, the next green.
  const logs = [];
  const day = (await import("../src/accounts.js")).today();
  db.recordProviderCall({ provider: "openai", day, ok: false, status: 0, error: "The operation was aborted due to timeout" });
  const blip = async (p) => ops.settle({ report: await ops.runChecks({ runtime, probe: p }), runtime, log: (e) => logs.push(e) });
  await blip(async (pr) => pr.id === "openai" ? { ok: false, status: 0, error: "The operation was aborted due to timeout" } : { ok: true, status: 200 });
  assert.notEqual(ops.snapshot().checks.find(c => c.id === "provider:openai").state, "ok", "it went wrong");
  clock.skip(5 * 60_000);
  runtime.lastSweepAt = clock.now();
  await blip(OK);
  assert.equal(sent.length, 0, "nothing reached him");
  assert.ok(logs.some(l => l.ops_blip === "provider:openai"), "the red is logged");
  assert.ok(logs.some(l => l.ops_blip_cleared === "provider:openai"), "and so is its clearing");
});

test("a real failure that stays texts on the next pass, any hour, once; its all-clear texts once", async () => {
  const down = async (pr) => pr.id === "openai" ? { ok: false, status: 0, error: "The operation was aborted due to timeout" } : { ok: true, status: 200 };
  const pass = async (p) => { clock.skip(5 * 60_000); runtime.lastSweepAt = clock.now(); return ops.settle({ report: await ops.runChecks({ runtime, probe: p }), runtime }); };
  ops.settle({ report: await ops.runChecks({ runtime, probe: down }), runtime });
  assert.equal(sent.length, 0);
  await pass(down);
  assert.equal(sent.length, 1, "still down five minutes on: he hears");
  assert.match(sent[0].text, /OpenAI/);
  await pass(down); await pass(down);
  assert.equal(sent.length, 1, "and only once while it stays down");
  await pass(OK);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /back to normal: OpenAI/);
});

test("the first pass after install texts about anything already wrong — there is no prior state to compare, and wrong is wrong", async () => {
  db.createAccessRequest({ channel: "sendblue", address: "+15550002222", displayName: "Kofi", firstMessage: "yo" });
  await twoPasses();
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
  assert.match(html, /<div class="rn">Waiting for a yes<\/div><div class="rg">People · for 3h<\/div>/);
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
  assert.match(out.body, /texted Omari a six-digit code/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c, "dm:owner");
  assert.match(sent[0].text, /^Your Reason code is [0-9]{6}, to open "Reason status" on that browser.[^\n]*\n\n@heyreason\.com #[0-9]{6}$/);
});

test("the right code opens the page, sets a cookie for the whole site, and that cookie opens it again — and the JSON", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  await POST("send=1", {}, ops.opsKey());
  const code = /code is ([0-9]{6}),/.exec(sent[0].text)[1];

  const wrong = await POST("code=ZZZZZZ");
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /not right/);

  const opened = await POST(`code=${code}`);
  assert.equal(opened.status, 303, "signed in, then back to the page as a GET");
  assert.equal(opened.headers.Location, "/ops");
  assert.match(opened.headers["Set-Cookie"], /^reason_page=[A-Za-z0-9_-]+; Path=\/; /);

  const cookie = opened.headers["Set-Cookie"].split(";")[0];
  const again = await GET({ cookie });
  assert.equal(again.status, 200);
  assert.match(again.body, /All good/);
  assert.match(again.body, /Parallel · search/);
  assert.match(again.body, /Dashboard ›/);

  const asJson = await GET({ cookie }, null, true);
  assert.equal(asJson.status, 200);
  const parsed = JSON.parse(asJson.body);
  assert.equal(parsed.report.verdict, "ok");
  assert.equal(parsed.stale, false);
});

test("Clear restarts a windowed row's count from that moment, quietly; a new failure after it is red again", async () => {
  const now = clock.now();
  const fail = (k, at) => db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, attempts, last_error, created_at, updated_at, failed_at)
    VALUES (?, 'dm:owner', 'sendblue', '+1', 'hello', 'failed', 5, 'opted out', ?, ?, ?)`).run(k, at, at, at);
  fail("c1", now - 3600e3);
  fail("c2", now - 1800e3);
  await twoPasses();
  assert.equal(sent.length, 1, "the red texted once");
  assert.match(ops.snapshot().checks.find(c => c.id === "outbox").detail, /^2 texts failed in the last day/);

  clock.skip(60_000);
  runtime.lastSweepAt = clock.now(); // the sweep kept running meanwhile; only the clear is under test
  assert.equal(ops.clearCheck("outbox"), true);
  assert.equal(ops.clearCheck("provider:openai"), false, "a live fault has nothing to clear");
  const r = await ops.runOnce({ runtime, silent: new Set(["outbox"]), log() {} });
  const row = ops.snapshot().checks.find(c => c.id === "outbox");
  assert.equal(row.state, "ok");
  assert.equal(sent.length, 1, "clearing it yourself is not a 'back to normal' text");
  assert.equal(r.changes.length, 0);

  clock.skip(60_000);
  runtime.lastSweepAt = clock.now();
  fail("c3", clock.now());
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  let again = ops.snapshot().checks.find(c => c.id === "outbox");
  assert.equal(again.state, "bad");
  assert.match(again.detail, /^1 text failed since you cleared it 1m ago — opted out/);
  clock.skip(5 * 60_000);
  runtime.lastSweepAt = clock.now();
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  assert.equal(sent.length, 2, "a new failure after the clear is news");
});

test("the two buttons work only for a signed-in owner: Check again runs the pass now, Clear needs a clearable row", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  const before = ops.snapshot().at;
  db.startPageSession("ops", "tok-owner", { conversationId: "dm:owner" });
  const headers = { cookie: "reason_page=tok-owner" };

  clock.skip(30_000);
  runtime.lastSweepAt = clock.now();
  let out = await opsRequest({ method: "POST", headers, readBody: async () => "action=check", runtime });
  assert.equal(out.status, 200);
  assert.ok(ops.snapshot().at > before, "a fresh pass was run");
  assert.match(out.body, /Check again/);

  // Not signed in: the same form is just a wrong code at the gate, and nothing is cleared.
  out = await opsRequest({ method: "POST", headers: {}, readBody: async () => "action=clear&id=outbox", runtime });
  assert.equal(out.status, 401);
  assert.equal(db.opsGet("cleared:outbox"), null);

  out = await opsRequest({ method: "POST", headers, readBody: async () => "action=clear&id=outbox", runtime });
  assert.equal(out.status, 200);
  assert.ok(Number(db.opsGet("cleared:outbox")) > 0);
  out = await opsRequest({ method: "POST", headers, readBody: async () => "action=clear&id=provider:openai", runtime });
  assert.equal(out.status, 200);
  assert.equal(db.opsGet("cleared:provider:openai"), null);
});

test("the page pins what is wrong at the top, open, with Clear only on a wrong windowed row; the fine rows fold into one line", async () => {
  const now = clock.now();
  db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, attempts, last_error, created_at, updated_at, failed_at)
    VALUES ('g1', 'dm:owner', 'sendblue', '+1', 'hello', 'failed', 5, 'opted out', ?, ?, ?)`).run(now, now, now);
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  const html = renderOps({ report: ops.snapshot(), now: clock.now() });
  const report = ops.snapshot();
  const fine = report.checks.filter(c => c.state === "ok").length;
  assert.match(html, /<h1><span class="sd"><\/span>1 thing needs you<\/h1>/);
  assert.match(html, /<ul class="issues"><li><a class="ck-bad" href="#ck-outbox">/, "the bar lists it, and the line jumps to its row");
  assert.match(html, /<section class="sec"><h2>Needs you<\/h2><article class="pc ck-bad" id="ck-outbox" data-ck="outbox"/);
  assert.match(html, /name="action" value="clear"><button class="btn sm" name="id" value="outbox">Clear<\/button>/);
  assert.doesNotMatch(html, /value="provider:/, "no Clear on a live row");
  assert.match(html, new RegExp(`<details class="fine"><summary><span class="led"></span>${fine} checks fine`));
  assert.ok(html.indexOf('id="ck-outbox"') < html.indexOf('<details class="fine">'), "the problem sits above the fold");
  assert.match(html, /<h3>Services and credit<\/h3>/);
});

test("a session that belongs to somebody who is not an operator does not open it", async () => {
  db.startPageSession("ops", "tok-stranger", { conversationId: "dm:somebody-else" });
  const out = await GET({ cookie: "reason_page=tok-stranger" });
  assert.equal(out.status, 401);
});

test("a stale report is shown as red even if its last verdict was green", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  const fresh = renderOps({ report: ops.snapshot(), now: clock.now() });
  assert.match(fresh, /All good/);
  assert.match(fresh, /class="sb s-ok"/);
  const stale = renderOps({ report: ops.snapshot(), now: clock.now() + ops.STALE_AFTER_MS + 60_000 });
  assert.match(stale, /The checks have stopped/);
  assert.match(stale, /class="sb s-bad"/);
  assert.doesNotMatch(stale, /All good/);
});

test("before the first pass the page says it is checking rather than inventing a verdict", () => {
  const html = renderOps({ report: null, now: clock.now() });
  assert.match(html, /The first check runs a few seconds after start/);
});

test("nothing the database says becomes markup", async () => {
  db.createAccessRequest({ channel: "sendblue", address: "+15550004444", displayName: "<img src=x onerror=alert(1)>", firstMessage: "hi" });
  const report = await ops.runChecks({ runtime, probe: OK });
  const html = renderOps({ report, now: clock.now() });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// ---------- the owner's link lives on the website (2026-10-24) ----------

test("every link to the page is heyreason.com/ops with the key: the alert, back to normal, and the status_page tool", async () => {
  assert.equal(ops.opsUrl(), `https://heyreason.com/ops?k=${ops.opsKey()}`);
  const outbox = { id: "outbox", group: "alive", label: "Texts out", state: "ok", detail: "fine" };
  const harm = { id: "harm", group: "quality", label: "Harm screen", state: "bad", detail: "down" };
  const text = ops.alertText([{ kind: "fixed", check: outbox }], { verdict: "bad", checks: [harm] });
  assert.equal(text, `Reason check — back to normal: Texts out.\nStatus page: https://heyreason.com/ops?k=${ops.opsKey()}`);
  assert.doesNotMatch(text, /reason\.example\.test|ts\.net/);

  const { runTool } = await import("../src/tools.js");
  const out = await runTool("status_page", {}, { conversationId: "dm:owner" });
  assert.equal(out.ok, true);
  assert.equal(out.url, `https://heyreason.com/ops?k=${ops.opsKey()}`);
});

test("REASON_OPS_URL moves the link; set empty, it falls back to the server's own /ops", () => {
  const was = config.opsUrl;
  try {
    config.opsUrl = "https://status.example.test/ops";
    assert.equal(ops.opsUrl(), `https://status.example.test/ops?k=${ops.opsKey()}`);
    config.opsUrl = "";
    assert.equal(ops.opsUrl(), `https://reason.example.test/ops?k=${ops.opsKey()}`);
  } finally { config.opsUrl = was; }
});

// ---------- "Check again" answers at once (2026-10-24) ----------

test("each row is heard the moment it is decided, the probed ones as their providers answer, and the report keeps its order", async () => {
  const heard = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = async (p) => { await gate; return { ok: true, status: 200 }; };
  const pass = ops.runChecks({ runtime, probe: slow, onCheck: (c) => heard.push(c.id) });
  await new Promise(r => setImmediate(r));
  assert.ok(heard.includes("process") && heard.includes("outbox"), "the database rows are out before any provider answers");
  assert.ok(!heard.includes("embeddings"), "a probed row waits for its probe");
  release();
  const report = await pass;
  assert.deepEqual([...heard].sort(), report.checks.map(c => c.id).sort(), "every row heard exactly once");
  const plain = await ops.runChecks({ runtime, probe: OK });
  assert.deepEqual(report.checks.map(c => c.id), plain.checks.map(c => c.id), "same order as a pass nobody listened to");
});

test("with script, Check again answers 202 at once and /ops.json shows the pass filling in; without, the form waits for the finished page", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  db.startPageSession("ops", "tok-owner", { conversationId: "dm:owner" });
  const cookie = "reason_page=tok-owner";
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = async () => { await gate; return { ok: true, status: 200 }; };
  // The page's own fetch: it asks for JSON.
  const realRunOnce = ops.runOnce;
  const started = await opsRequest({ method: "POST", headers: { cookie, accept: "application/json" }, readBody: async () => "action=check", runtime: { ...runtime },
    router: null, log() {} , probe: slow });
  // opsRequest uses the real probe, so drive the in-flight view through runOnce directly as well.
  assert.ok([200, 202].includes(started.status));
  assert.equal(started.headers["Content-Type"], "application/json");
  const kicked = JSON.parse(started.body);
  assert.equal(kicked.ok, true);
  assert.equal(kicked.action, "check");
  await new Promise(r => setTimeout(r, 0));
  void realRunOnce;

  const own = ops.runOnce({ runtime, probe: slow, log() {} });
  await new Promise(r => setImmediate(r));
  const mid = JSON.parse((await GET({ cookie }, null, true)).body);
  if (mid.running) {
    assert.ok(mid.running.started_at > 0);
    assert.ok(mid.running.checks.some(c => c.id === "process"), "rows decided so far are in the JSON");
    assert.ok(!mid.running.checks.some(c => c.id === "embeddings"));
  }
  release();
  await own;
  // settle whatever the page's pass was doing
  for (let i = 0; i < 50 && ops.progress(); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(JSON.parse((await GET({ cookie }, null, true)).body).running, null, "finished: nothing in flight");

  // No script: a plain form post, answered with the whole finished page.
  const plain = await opsRequest({ method: "POST", headers: { cookie }, readBody: async () => "action=check", runtime });
  assert.equal(plain.status, 200);
  assert.match(plain.headers["Content-Type"], /text\/html/);
  assert.match(plain.body, /Check again/);
});

test("the page works without script: plain POST forms to /ops, a <noscript> refresh; with script, the buttons spin and rows grey", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  const html = renderOps({ report: ops.snapshot(), now: clock.now() });
  assert.match(html, /<form class="act" method="POST" action="\/ops"><button class="btn" name="action" value="check">Check again<\/button><\/form>/);
  assert.match(html, /<noscript><meta http-equiv="refresh" content="30"><\/noscript>/);
  assert.doesNotMatch(html.replace(/<noscript>[\s\S]*?<\/noscript>/, ""), /http-equiv="refresh"/, "with script on, the page never reloads itself");
  assert.match(html, /data-ck="process"/);
  // Two script tags since 2026-10-25: the theme choice in the head, the page's own at the end.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s), "the script parses");
  const js = scripts.join("\n");
  assert.match(js, /e\.preventDefault\(\)/);
  assert.match(js, /accept:'application\/json'/);
  assert.match(js, /'\/ops\.json'/);
  assert.match(js, /Checking…/);
  assert.match(js, /Clearing…/);
  assert.match(js, /classList\.add\('refreshing'\)/);
  assert.doesNotMatch(js, /https?:\/\//, "only this page's own addresses — it works on whichever domain serves it");
});

// ---------- card purchases count what happened (2026-10-24) ----------

test("pinned: Card purchases counts placed, cancelled, declined and unknown — never a cart shown or a conversation still shopping", async () => {
  db.db.exec("DELETE FROM agentcard_purchases;");
  const now = clock.now();
  const row = (status, cents, extra = "") => db.db.prepare(`INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, amount_cents, decline_code, created_at, updated_at)
    VALUES ('dm:owner', ?, ?, ?, ?, ?, ?)`).run(`conv_${status}_${Math.random()}`, status, cents, extra, now - 3_600_000, now);
  // The live day: two carts shown, one still shopping, one declined, one cancelled — nothing bought.
  row("cart_shown", 1678); row("shopping", 0); row("awaiting_approval", 1678); row("declined", 1676, "card_declined"); row("cancelled", 1676);
  let rep = await ops.runChecks({ runtime, probe: OK });
  let c = rep.checks.find(x => x.id === "purchases");
  assert.equal(c.detail, "0 placed · 1 cancelled · 1 declined in the last day");
  assert.equal(c.state, "warn");
  assert.doesNotMatch(c.detail, /\$50|\$16\.78|purchases? in the last day/);

  row("placed", 1678); row("outcome_unknown", 2306);
  rep = await ops.runChecks({ runtime, probe: OK });
  c = rep.checks.find(x => x.id === "purchases");
  assert.equal(c.detail, "1 placed ($16.78) · 1 cancelled · 1 declined · 1 outcome unknown in the last day");
  assert.equal(c.state, "bad", "money whose outcome nobody knows is red");

  db.db.exec("DELETE FROM agentcard_purchases;");
  row("cart_shown", 1678);
  rep = await ops.runChecks({ runtime, probe: OK });
  c = rep.checks.find(x => x.id === "purchases");
  assert.equal(c.detail, "nothing bought in the last day");
  assert.equal(c.state, "ok");
});

test("pinned: the status_page tool tells Reason the page asks for the password, with the texted code as the ?k= fallback", async () => {
  const { runTool, STATUS_PAGE_SAY } = await import("../src/tools.js");
  const out = await runTool("status_page", {}, { conversationId: "dm:owner" });
  assert.equal(out.say, STATUS_PAGE_SAY);
  assert.match(out.url, /\?k=/);
  assert.match(out.say, /password/);
  assert.match(out.say, /text them a code instead/);
  assert.doesNotMatch(out.say, /texts them a code on a new one/);
});
