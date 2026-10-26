// The status page's 2026-10-24 rebuild: its password, its link, its live JSON and its trend lines.
//
// What has to stay true:
//
//   - **the password opens it, and nothing else does.** Right: the same operator session and 90-day
//     cookie the texted code gives. Wrong: refused, counted, nothing typed is logged. Five wrong
//     from one address in fifteen minutes and that address is locked out for the window.
//   - **a browser already signed in is never asked.**
//   - **no hash set, no password**: the page has the code gate alone, exactly as before.
//   - **every link the owner is given is heyreason.com/ops**, and an alert's link names
//     the check it is about (?focus=), which the page pins at the top.
//   - **/ops.json carries the pass in flight** so the page can fill rows in as they are decided.
//   - **the trend lines are hourly counts of what really happened**, people's conversations only.
//
// The hash here is a throwaway made in this file. The real one is only ever in the server's .env.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-opsgate-"));
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
delete process.env.REASON_OPS_URL;
delete process.env.REASON_OPS_PASSWORD_HASH;

// The Server row reads this machine's load average, and the full suite running beside other work
// pushes a laptop past 2× its cores — every "is it green" assertion here then saw yellow (the
// ops flake under full-suite load, 2026-10-24). The load is pinned; the disk is still read.
import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const opspw = await import("../src/opspassword.js");
const { opsRequest } = await import("../src/http.js");
const { renderOps, sparkline } = await import("../src/pages/ops.js");
const { clock, config } = await import("../src/config.js");

const PASSWORD = "correct horse battery staple";
const salt = randomBytes(16);
const HASH = `scrypt:${salt.toString("hex")}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;

const OK = async () => ({ ok: true, status: 200 });
const sent = [];
const runtime = { say: (c, text) => { sent.push({ c, text }); return text; }, interval: {}, lastSweepAt: clock.now(), on() {} };
const logs = [];
const log = (x) => logs.push(x);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  sent.length = 0;
  logs.length = 0;
  config.opsPasswordHash = HASH;
  db.db.exec(`DELETE FROM ops_checks; DELETE FROM ops_state; DELETE FROM provider_calls; DELETE FROM provider_calls_hourly; DELETE FROM provider_state;
    DELETE FROM outbox; DELETE FROM inbound_messages; DELETE FROM accounts; DELETE FROM access_requests;
    DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM usage;`);
  runtime.lastSweepAt = clock.now();
});

const NF = (ip) => ({ "x-nf-client-connection-ip": ip });
const GET = ({ headers = {}, key = null, json = false, focus = null, via = null } = {}) =>
  opsRequest({ json, key, focus, via, method: "GET", headers, readBody: async () => "", runtime, log });
const POST = (body, { headers = {}, key = null, via = null } = {}) =>
  opsRequest({ key, via, method: "POST", headers, readBody: async () => body, runtime, log });
const pw = (p) => `username=Reason+status&password=${encodeURIComponent(p)}`;

// ---------- the password ----------

test("a browser nobody has proved is asked for the password: a plain form a password manager knows", async () => {
  const out = await GET({ headers: NF("1.1.1.1") });
  assert.equal(out.status, 401);
  assert.match(out.body, /<input type="password" name="password" autocomplete="current-password"/);
  assert.match(out.body, /<form method="POST" action="">/);
  assert.doesNotMatch(out.body, /Text me a code instead/, "no key, no code to send — so no link to one");
  const withKey = await GET({ key: ops.opsKey() });
  assert.match(withKey.body, /<a class="alt-link" href="\/ops\?k=[^"]+&amp;via=code">Text me a code instead<\/a>/);
  const codeView = await GET({ key: ops.opsKey(), via: "code" });
  assert.match(codeView.body, /Text me the code/, "the code gate is still there behind the link");
  assert.match(codeView.body, /Use the password instead/);
});

test("the right password signs the browser in as the owner — the same session and cookie as the code — and back to the page", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  const out = await POST(pw(PASSWORD), { headers: NF("2.2.2.2") });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/ops");
  assert.match(out.headers["Set-Cookie"], /^reason_page=[A-Za-z0-9_-]{40,}; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax; Secure$/);
  const token = out.headers["Set-Cookie"].split(";")[0].split("=")[1];
  const row = db.db.prepare("SELECT page_id, conversation_id FROM page_sessions WHERE token = ?").get(token);
  assert.deepEqual({ ...row }, { page_id: "ops", conversation_id: "dm:owner" });
  const page = await GET({ headers: { cookie: `reason_page=${token}` } });
  assert.equal(page.status, 200);
  assert.match(page.body, /All good/);
  assert.ok(!JSON.stringify(logs).includes(PASSWORD), "the password is never logged");
});

test("a wrong password is refused and counted, without what was typed; five from one address locks it out", async () => {
  for (let i = 1; i <= 5; i++) {
    const out = await POST(pw(`guess-${i}`), { headers: { "x-forwarded-for": "3.3.3.3, 10.0.0.1" } });
    assert.equal(out.status, 401);
    assert.equal(out.headers["Set-Cookie"], undefined);
    assert.match(out.body, /That password is not right\./);
  }
  assert.ok(logs.some(l => l.ops_password_failed === "wrong" && l.ip === "3.3.3.3"), "failed attempts are logged with the address");
  assert.ok(!JSON.stringify(logs).includes("guess-"), "never the input");
  // Locked: even the right one is refused, from this address, for the window.
  const locked = await POST(pw(PASSWORD), { headers: { "x-forwarded-for": "3.3.3.3" } });
  assert.equal(locked.status, 429);
  assert.match(locked.body, /Too many wrong passwords/);
  assert.equal(locked.headers["Set-Cookie"], undefined);
  // Another address is not locked out by this one.
  const other = await POST(pw(PASSWORD), { headers: NF("4.4.4.4") });
  assert.equal(other.status, 303);
  // The window passes and the address may try again.
  clock.skip(opspw.WINDOW_MS + 1000);
  assert.equal((await POST(pw(PASSWORD), { headers: { "x-forwarded-for": "3.3.3.3" } })).status, 303);
});

test("Netlify's client address wins over x-forwarded-for, and a cap on all wrong guesses bounds a forged header", async () => {
  assert.equal(opspw.clientIp({ "x-nf-client-connection-ip": "5.5.5.5", "x-forwarded-for": "6.6.6.6" }), "5.5.5.5");
  assert.equal(opspw.clientIp({ "x-forwarded-for": " 6.6.6.6 , 7.7.7.7" }), "6.6.6.6");
  assert.equal(opspw.clientIp({}, "::1"), "::1");
  for (let i = 0; i < opspw.MAX_TOTAL; i++) await POST(pw("nope"), { headers: NF(`9.9.${Math.floor(i / 4)}.${i}`) });
  const fresh = await POST(pw(PASSWORD), { headers: NF("8.8.8.8") });
  assert.equal(fresh.status, 429, "past the total cap nobody may try until the window passes");
});

test("a browser already signed in is never asked for the password", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  db.startPageSession("ops", "tok-known", { conversationId: "dm:owner" });
  const out = await GET({ headers: { cookie: "reason_page=tok-known" } });
  assert.equal(out.status, 200);
  assert.doesNotMatch(out.body, /type="password"/);
  assert.match(out.body, /Check again/);
});

test("with no hash set the page has the code gate alone, as before", async () => {
  config.opsPasswordHash = "";
  assert.equal(opspw.passwordEnabled(), false);
  const out = await GET({ key: ops.opsKey() });
  assert.equal(out.status, 401);
  assert.match(out.body, /Text me the code/);
  assert.doesNotMatch(out.body, /type="password"|Use the password instead/);
  const tried = await POST(pw(PASSWORD));
  assert.equal(tried.headers["Set-Cookie"], undefined, "a password posted with none set opens nothing");
  config.opsPasswordHash = "scrypt:nothex:alsonot";
  assert.equal(opspw.passwordEnabled(), false, "a malformed hash is no password, not a crash");
});

test("passwordMatches is exact", async () => {
  assert.equal(await opspw.passwordMatches(PASSWORD, HASH), true);
  assert.equal(await opspw.passwordMatches(`${PASSWORD} `, HASH), false);
  assert.equal(await opspw.passwordMatches("", HASH), false);
  assert.equal(await opspw.passwordMatches(PASSWORD, ""), false);
});

// ---------- the link ----------

test("the alert's link is heyreason.com/ops and names the check it is about; the page pins that check first", async () => {
  const outbox = { id: "outbox", group: "alive", label: "Texts out", state: "bad", detail: "2 failed" };
  const card = { id: "provider:agentcard", group: "services", label: "AgentCard", state: "warn", detail: "HTTP 404" };
  const text = ops.alertText([{ kind: "wrong", check: card }, { kind: "wrong", check: outbox }], { verdict: "bad", checks: [outbox, card] });
  assert.match(text, new RegExp(`Status page: https://heyreason\\.com/ops\\?k=${ops.opsKey()}&focus=outbox$`), "the worst one, by id");
  assert.equal(ops.opsUrl("provider:agentcard"), `https://heyreason.com/ops?k=${ops.opsKey()}&focus=provider%3Aagentcard`);

  const now = clock.now();
  const report = { at: now, verdict: "bad", checks: [outbox, card, { id: "process", group: "alive", label: "Process", state: "ok", detail: "up" }], people: [] };
  const html = renderOps({ report, now, focus: "agentcard" });
  assert.ok(html.indexOf('id="ck-provider-agentcard"') < html.indexOf('id="ck-outbox"'), "the alerted check is pinned first");
  assert.match(html, /<article class="pc ck-warn focused" id="ck-provider-agentcard"/);
  const fixed = renderOps({ report, now, focus: "process" });
  assert.match(fixed, /You were sent here about <b>Process<\/b>\. It is fine now/);
});

test("signing in from an alert link keeps the focus", async () => {
  const out = await opsRequest({ focus: "outbox", method: "POST", headers: NF("2.3.4.5"), readBody: async () => pw(PASSWORD), runtime, log });
  assert.equal(out.headers.Location, "/ops?focus=outbox");
  const odd = await opsRequest({ focus: "<script>", method: "GET", headers: {}, readBody: async () => "", runtime, log });
  assert.doesNotMatch(odd.body, /<script>(?!\s*\(function)/, "a focus that is not a check id is dropped");
});

// ---------- /ops.json, for the page to follow a pass ----------

test("/ops.json: ok, now, stale, report, and `running` — the pass in flight with the rows decided so far and how many to expect", async () => {
  ops.settle({ report: await ops.runChecks({ runtime, probe: OK }), runtime });
  db.startPageSession("ops", "tok-json", { conversationId: "dm:owner" });
  const cookie = "reason_page=tok-json";
  const idle = JSON.parse((await GET({ headers: { cookie }, json: true })).body);
  assert.deepEqual(Object.keys(idle).sort(), ["now", "ok", "report", "running", "stale"]);
  assert.equal(idle.running, null);
  assert.equal(idle.report.verdict, "ok");
  assert.ok(Array.isArray(idle.report.trends.inbound) && idle.report.trends.inbound.length === 24);

  let release;
  const gate = new Promise(r => { release = r; });
  const pass = ops.runOnce({ runtime, probe: async () => { await gate; return { ok: true, status: 200 }; } });
  await new Promise(r => setImmediate(r));
  const mid = JSON.parse((await GET({ headers: { cookie }, json: true })).body);
  assert.equal(typeof mid.running.started_at, "number");
  assert.equal(mid.running.total, idle.report.checks.length);
  assert.ok(mid.running.checks.length > 0 && mid.running.checks.length < mid.running.total);
  for (const c of mid.running.checks) assert.deepEqual(["detail", "group", "id", "label", "state"].filter(k => k in c), ["detail", "group", "id", "label", "state"]);
  release();
  await pass;
  assert.equal(JSON.parse((await GET({ headers: { cookie }, json: true })).body).running, null);
});

// ---------- trend lines ----------

test("the trend query: 24 hourly counts of texts in, sent, failed and each provider's calls — people's conversations only", () => {
  const H = 3_600_000;
  const now = clock.now();
  const at = (hAgo) => now - hAgo * H;
  let k = 0;
  const inbound = (conv, t) => db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES ('sendblue', ?, ?, ?)").run(`x${k++}`, conv, t);
  inbound("dm:+1555", at(0)); inbound("dm:+1555", at(0)); inbound("dm:+1666", at(5)); inbound("group:abc", at(23));
  inbound("console", at(0)); inbound("dm:+1555", at(30));
  const out = (state, t, conv = "dm:+1555") => db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at, sent_at, failed_at)
    VALUES (?, ?, 'sendblue', '+1', 'hi', ?, ?, ?, ?, ?)`).run(`o${k++}`, conv, state, t, t, state === "sent" ? t : null, state === "failed" ? t : null);
  out("sent", at(1)); out("sent", at(1)); out("failed", at(2)); out("sent", at(1), "console");
  db.recordProviderCall({ provider: "anthropic", day: "d", ok: true, at: at(3) });
  db.recordProviderCall({ provider: "anthropic", day: "d", ok: false, status: 500, at: at(3) });
  db.recordProviderCall({ provider: "anthropic", day: "d", ok: true, at: at(60) });

  const t = db.opsTrends(now);
  assert.equal(t.inbound.length, 24);
  assert.equal(t.inbound[23], 2, "this hour: two from a person, the console not counted");
  assert.equal(t.inbound[18], 1);
  assert.equal(t.inbound[0], 1, "23 hours ago is the first bucket");
  assert.equal(t.inbound.reduce((a, b) => a + b), 4, "30 hours ago is outside");
  assert.equal(t.sent[22], 2);
  assert.equal(t.failed[21], 1);
  assert.equal(t.sent.reduce((a, b) => a + b), 2);
  assert.equal(t.providers.anthropic.calls[20], 2);
  assert.equal(t.providers.anthropic.failures[20], 1);
  assert.equal(t.providers.anthropic.calls.reduce((a, b) => a + b), 2);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM provider_calls_hourly WHERE provider = 'anthropic'").get().n, 1, "past two days is pruned");

  const svg = sparkline(t.sent, t.failed, "texts out");
  assert.match(svg, /^<svg class="spark"[^>]*aria-label="2 texts out in 24h, 1 failed"/);
  assert.match(svg, /<polyline class="fl"/);
  assert.equal(sparkline(new Array(24).fill(0)), "", "nothing drawn for a quiet day");
});

test("people are most recently active first, each with seven days of texts", async () => {
  const D = 24 * 3_600_000;
  const now = clock.now();
  db.db.prepare("INSERT INTO accounts (conversation_id, channel, name, address, is_operator, last_seen_at, created_at) VALUES ('dm:owner', 'sendblue', 'Omari', '+1', 1, ?, ?)").run(now - 5 * D, now - 9 * D);
  db.db.prepare("INSERT INTO accounts (conversation_id, channel, name, address, is_operator, last_seen_at, created_at) VALUES ('dm:ama', 'sendblue', 'Ama', '+2', 0, ?, ?)").run(now - 60_000, now - 9 * D);
  let k = 0;
  const inbound = (conv, t) => db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES ('sendblue', ?, ?, ?)").run(`p${k++}`, conv, t);
  inbound("dm:ama", now - 1000); inbound("dm:ama", now - 2000); inbound("dm:ama", now - 3 * D - 1000); inbound("dm:owner", now - 5 * D - 10);
  const report = await ops.runChecks({ runtime, probe: OK });
  assert.deepEqual(report.people.map(p => p.name), ["Ama", "Omari"]);
  assert.deepEqual(report.people[0].week, [0, 0, 0, 1, 0, 0, 2]);
  assert.deepEqual(report.people[1].week, [0, 1, 0, 0, 0, 0, 0]);
  const html = renderOps({ report, now });
  assert.ok(html.indexOf(">Ama<") < html.indexOf(">Omari<"));
  assert.match(html, /aria-label="3 texts in 7 days"/);
});
