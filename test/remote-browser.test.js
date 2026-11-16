// The hosted browser (src/remotebrowser.js, REASON_REMOTE_BROWSER): a FAKE Browserbase API on loopback
// and a real local Chromium behind a CDP endpoint stand in for the service. Nothing reaches the
// internet: every site name resolves to 127.0.0.1 inside that Chromium, the key is made up, and the
// paid-key guard has already taken any real Browserbase key out of this process.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-hosted-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:hosted-owner";
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1"; // the browser guard lets 127.0.0.1 through, tests only
const ENV = ["REASON_REMOTE_BROWSER", "REASON_REMOTE_BROWSER_SITES", "REASON_REMOTE_BROWSER_MONTH_MINUTES", "REASON_REMOTE_BROWSER_SESSION_MINUTES",
  "REASON_REMOTE_BROWSER_START_MS", "REASON_REMOTE_BROWSER_TEST_CAP_MS", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_API_URL"];
for (const k of ENV) delete process.env[k];

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }
const skip = { skip: chromium ? false : "playwright/chromium not installed" };

const db = await import("../src/db.js");
const remote = await import("../src/remotebrowser.js");
const browser = await import("../src/browser.js");
const refusing = await import("../src/refusing.js");
const opsdigest = await import("../src/opsdigest.js");
const { runTool, toolsFor, capabilitiesNow } = await import("../src/tools.js");
const { SYSTEM } = await import("../src/agent.js");

const OWNER = "dm:hosted-owner";
const OTHER = "dm:hosted-other";
db.upsertAccount({ conversationId: OWNER, channel: "test", address: "+12025550171", name: "Owner", isOperator: true });
db.upsertAccount({ conversationId: OTHER, channel: "test", address: "+12025550172", name: "Sam", isOperator: false });
remote.setRemoteSink(() => {});

// ---------------------------------------------------------------- the fake Browserbase
const bb = { calls: [], status: {}, delay: {}, connectUrl: "", n: 0 };
const bbServer = createServer(async (req, res) => {
  let body = "";
  for await (const ch of req) body += ch;
  const call = { method: req.method, path: req.url, body: body ? JSON.parse(body) : null, keyed: req.headers["x-bb-api-key"] === "bb_test_fake" };
  bb.calls.push(call);
  const route = `${req.method} ${req.url.replace(/\/[a-z]+_\d+$/, "/:id")}`;
  if (bb.delay[route]) await new Promise(r => setTimeout(r, bb.delay[route]));
  const st = bb.status[route] ?? bb.status["*"];
  if (st) { res.writeHead(st, { "content-type": "application/json" }); return res.end(JSON.stringify({ message: st === 429 ? "concurrency" : "nope" })); }
  if (route === "POST /v1/contexts") { bb.n += 1; res.writeHead(201, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: `ctx_${bb.n}` })); }
  if (route === "DELETE /v1/contexts/:id") { res.writeHead(204); return res.end(); }
  if (route === "POST /v1/sessions") { bb.n += 1; res.writeHead(201, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: `sess_${bb.n}`, connectUrl: bb.connectUrl, signingKey: "x", seleniumRemoteUrl: "http://x" })); }
  if (route === "POST /v1/sessions/:id") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
  res.writeHead(404); res.end();
});
const calls = (route) => bb.calls.filter(c => `${c.method} ${c.path.replace(/\/[a-z]+_\d+$/, "/:id")}` === route);
const sessionsMade = () => calls("POST /v1/sessions");
const releases = () => calls("POST /v1/sessions/:id").filter(c => c.body?.status === "REQUEST_RELEASE");

// ---------------------------------------------------------------- the site and the CDP browser
const clicked = [];
let SITE_PORT = 0;
const siteServer = createServer((req, res) => {
  const page = (html, status = 200) => { res.writeHead(status, { "content-type": "text/html" }); res.end(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`); };
  if (req.url === "/clicked") { clicked.push(Date.now()); res.writeHead(204); return res.end(); }
  if (req.url === "/challenge") return page("<h1>Verify you are human</h1><p>Press and hold the button to continue.</p><button>Press and hold</button>");
  if (req.url === "/blocked") return page("<h1>Access denied</h1>", 403);
  if (req.url.startsWith("/consumer/login")) return page("<h1>Sign in or sign up</h1><form><label for=e>Email</label><input id=e type=email name=email><button type=submit>Continue</button></form>");
  return page("<h1>Restaurants near you</h1><p>Order delivery from local favourites.</p><button onclick=\"fetch('/clicked')\">Find food</button>");
});
let cdp = null;
let WS = "";
const DD = (path) => `http://www.doordash.com:${SITE_PORT}${path}`;

before(async () => {
  await new Promise(r => bbServer.listen(0, "127.0.0.1", r));
  await new Promise(r => siteServer.listen(0, "127.0.0.1", r));
  SITE_PORT = siteServer.address().port;
  if (!chromium) return;
  cdp = spawn(chromium.executablePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "cdp")}`,
    "--host-resolver-rules=MAP * 127.0.0.1", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  WS = await new Promise((ok, no) => {
    let err = "";
    const t = setTimeout(() => no(new Error("chromium did not open its CDP port")), 30_000);
    cdp.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]); } });
  });
});
after(async () => {
  await remote.closeAllRemote();
  await browser.closeAllBrowsers().catch(() => {});
  if (cdp && cdp.exitCode == null) await new Promise(r => { cdp.once("exit", r); cdp.kill("SIGKILL"); });
  await new Promise(r => bbServer.close(r));
  await new Promise(r => siteServer.close(r));
  for (const k of ENV) delete process.env[k];
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const set = (env) => { for (const k of ENV) delete process.env[k]; Object.assign(process.env, env); };
const ON = () => ({ REASON_REMOTE_BROWSER: "owner", BROWSERBASE_API_KEY: "bb_test_fake", BROWSERBASE_PROJECT_ID: "proj_test", BROWSERBASE_API_URL: `http://127.0.0.1:${bbServer.address().port}` });
const turn = (c, text, kind = "user") => ({ conversationId: c, kind, messages: [{ role: "user", content: text }] });
const consent = (c = OWNER) => {
  db.db.prepare("INSERT INTO remote_browser_consent (conversation_id, site, asked_at, consented_at) VALUES (?, 'doordash.com', ?, ?) ON CONFLICT(conversation_id, site) DO UPDATE SET consented_at = excluded.consented_at").run(c, Date.now(), Date.now());
};
beforeEach(async () => {
  await browser.closeAllBrowsers().catch(() => {});
  set({});
  bb.calls.length = 0; bb.status = {}; bb.delay = {}; bb.connectUrl = WS; bb.n = 0;
  remote._resetRemote(); refusing._resetRefusals();
  db.db.exec("DELETE FROM ops_digest");
  clicked.length = 0;
});

function fakeLauncher() {
  const launches = [];
  return {
    launches, cdp: 0,
    async launchPersistentContext(d, opts) { launches.push({ d, opts }); const ctx = new EventEmitter(); ctx.close = async () => {}; return ctx; },
    async connectOverCDP() { this.cdp += 1; throw new Error("not in this test"); },
  };
}
const TODAY = () => ({ headless: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });

// ---------------------------------------------------------------- the pinned request
test("the session request is exactly the pinned body: CAPTCHA solving, proxies, Verified and stealth off, nothing that changes how the browser looks", () => {
  assert.deepEqual(remote.sessionRequest({ projectId: "p", contextId: "c", site: "doordash.com", timeoutSec: 900 }), {
    projectId: "p",
    browserSettings: {
      context: { id: "c", persist: true },
      solveCaptchas: false,
      verified: false,
      advancedStealth: false,
      recordSession: false,
      logSession: false,
      allowedDomains: ["doordash.com"],
    },
    proxies: false,
    keepAlive: false,
    timeout: 900,
  });
  // Nothing in the module sets a user agent, a fingerprint, the webdriver flag, a header or the OS.
  const src = String(remote.sessionRequest);
  assert.doesNotMatch(src, /userAgent|fingerprint|webdriver|\bos\b|extraHTTPHeaders|viewport|region|userMetadata|liveView|debug/i);
});

// ---------------------------------------------------------------- routing by switch and site
test("switch off: no Browserbase code path is reachable, for anyone, on any site", async () => {
  const realFetch = globalThis.fetch;
  let toBrowserbase = 0;
  globalThis.fetch = async (u, ...rest) => { if (/browserbase|127\.0\.0\.1:\d+\/v1\//.test(String(u))) toBrowserbase += 1; return realFetch(u, ...rest); };
  try {
    for (const env of [{}, { REASON_REMOTE_BROWSER: "off" }, { ...ON(), REASON_REMOTE_BROWSER: "off" }]) {
      set(env);
      for (const who of [OWNER, OTHER]) {
        assert.equal(remote.remoteFor(who, "https://www.doordash.com/"), "");
        const l = fakeLauncher();
        await browser.launchProfile(l, who, TODAY(), { site: "doordash.com" });
        assert.equal(l.launches.length, 1, "the local launch, as today");
        assert.equal(l.cdp, 0);
        assert.equal(remote.gate(who, "doordash.com"), null);
        assert.deepEqual(remote.tagEntry(who, { site: "doordash", signin_url: "https://www.doordash.com/consumer/login" }).browser, undefined);
      }
    }
    assert.equal(toBrowserbase, 0);
    assert.equal(bb.calls.length, 0);
    assert.equal(remote._counters().opens, 0);
    assert.equal(remote._counters().api, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("routing: owner mode covers the owner only, and only the listed site; on covers everyone", async () => {
  set(ON());
  assert.equal(remote.remoteFor(OWNER, "https://www.doordash.com/store/x"), "doordash.com");
  assert.equal(remote.remoteFor(OWNER, "doordash.com"), "doordash.com");
  assert.equal(remote.remoteFor(OWNER, "https://www.ubereats.com/"), "", "not on the list");
  assert.equal(remote.remoteFor(OWNER, "https://doordash.com.evil.example/"), "", "registrable domain, not a prefix");
  assert.equal(remote.remoteFor(OTHER, "https://www.doordash.com/"), "", "owner mode: the owner only");
  // A site not on the list, for a covered person: today's local launch.
  const l = fakeLauncher();
  await browser.launchProfile(l, OWNER, TODAY(), { site: "example.com" });
  assert.equal(l.launches.length, 1);
  // A launch that names no site (every caller before this change): local.
  await browser.launchProfile(l, OWNER, TODAY());
  assert.equal(l.launches.length, 2);
  assert.equal(l.cdp, 0);
  set({ ...ON(), REASON_REMOTE_BROWSER: "on" });
  assert.equal(remote.remoteFor(OTHER, "https://www.doordash.com/"), "doordash.com");
  set({ ...ON(), REASON_REMOTE_BROWSER_SITES: "doordash.com, https://www.godaddy.com/x" });
  assert.deepEqual(remote.remoteSites(), ["doordash.com", "godaddy.com"]);
});

test("switch off: the tool list, the capabilities and the prompt are byte-identical for a person it does not cover", () => {
  const hash = (c) => createHash("sha256").update(JSON.stringify(toolsFor(c))).update(JSON.stringify(capabilitiesNow({ conversationId: c }))).update(SYSTEM).digest("hex");
  set({});
  const offOther = hash(OTHER);
  const offOwner = hash(OWNER);
  set(ON());
  assert.equal(hash(OTHER), offOther, "owner mode: somebody else sees exactly what they saw with it off");
  assert.notEqual(hash(OWNER), offOwner, "the owner, covered, is told about it");
  assert.ok(toolsFor(OWNER).some(t => t.name === "hosted_browser_ok"));
  assert.ok(!toolsFor(OTHER).some(t => t.name === "hosted_browser_ok"));
  assert.match(capabilitiesNow({ conversationId: OWNER }).find(x => x.name === "browser").what, /hosted browser from another company \(Browserbase\)/);
  set({});
  assert.ok(!toolsFor(OWNER).some(t => t.name === "hosted_browser_ok"));
  assert.doesNotMatch(JSON.stringify(capabilitiesNow({ conversationId: OWNER })), /hosted browser|Browserbase/);
});

// ---------------------------------------------------------------- consent
test("consent first: one plain sentence, nothing opened, and only their own yes on their own turn is recorded", async () => {
  set(ON());
  const first = await runTool("browser_open", { url: DD("/") }, turn(OWNER, "order me pad thai from doordash"));
  assert.equal(first.hosted_browser, "consent_needed");
  assert.match(first.say_exactly, /hosted browser from another company \(Browserbase\)/);
  assert.match(first.say_exactly, /your DoorDash sign-in would be kept there/);
  assert.doesNotMatch(first.say_exactly, /\b(say|text|reply|type|send)\s+["“]/i, "never a phrase to type");
  assert.equal(bb.calls.length, 0, "nothing was asked of Browserbase");
  // Not their turn, not their words, a no: none of these is a yes.
  assert.equal((await runTool("hosted_browser_ok", { site: "doordash.com", their_words: "yes" }, turn(OWNER, "yes", "event"))).ok, false);
  assert.equal((await runTool("hosted_browser_ok", { site: "doordash.com", their_words: "sure, go ahead" }, turn(OWNER, "what is browserbase?"))).ok, false);
  assert.equal((await runTool("hosted_browser_ok", { site: "doordash.com", their_words: "no thanks" }, turn(OWNER, "no thanks"))).ok, false);
  assert.equal(remote.consented(OWNER, "doordash.com"), false);
  const yes = await runTool("hosted_browser_ok", { site: "doordash.com", their_words: "yes go ahead" }, turn(OWNER, "yes go ahead"));
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(remote.consented(OWNER, "doordash.com"), true);
  // Somebody the switch does not cover has no such tool.
  assert.equal((await runTool("hosted_browser_ok", { site: "doordash.com", their_words: "yes" }, turn(OTHER, "yes"))).ok, false);
});

// ---------------------------------------------------------------- the job on a hosted session
test("a covered job: the pinned body is sent, the Context is made once and reused, every session is released, and seconds are metered", skip, async () => {
  set(ON());
  consent();
  const open = await runTool("browser_open", { url: DD("/consumer/login") }, turn(OWNER, "sign me into doordash"));
  assert.equal(open.ok, true, JSON.stringify(open).slice(0, 300));
  assert.match(open.text, /Sign in or sign up/);
  assert.equal(calls("POST /v1/contexts").length, 1);
  assert.equal(sessionsMade().length, 1);
  const sent = sessionsMade()[0];
  assert.equal(sent.keyed, true);
  assert.deepEqual(sent.body, remote.sessionRequest({ projectId: "proj_test", contextId: "ctx_1", site: "doordash.com", timeoutSec: 900 }));
  assert.equal(remote.remoteSessionsOpen(), 1);
  // Origin pinning and the guard are the same code on the hosted context.
  browser.pinSite(OWNER, "doordash.com");
  const off = await runTool("browser_open", { url: "https://www.example.com/" }, turn(OWNER, "open example"));
  assert.equal(off.refused, true);
  assert.equal(remote.remoteSessionsOpen(), 1, "the pinned job keeps its hosted browser");
  browser.unpinSite(OWNER);
  await runTool("browser_close", {}, turn(OWNER, "done"));
  assert.equal(remote.remoteSessionsOpen(), 0);
  assert.equal(releases().length, 1);
  // The second job reuses the same Context: signed in once.
  const again = await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"));
  assert.equal(again.ok, true);
  assert.equal(calls("POST /v1/contexts").length, 1);
  assert.equal(sessionsMade()[1].body.browserSettings.context.id, "ctx_1");
  await browser.closeBrowser(OWNER);
  assert.equal(releases().length, 2);
  assert.equal(remote.remoteSessionsOpen(), 0);
  const jobs = remote.jobsFor(OWNER);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(j => j.site === "doordash.com" && j.ended === "closed" && j.seconds >= 0));
  assert.equal(remote.personSeconds(OWNER), jobs.reduce((n, j) => n + j.seconds, 0));
  assert.equal(remote.monthSeconds(), remote.personSeconds(OWNER));
  assert.ok(opsdigest.pending().some(r => /Hosted browser \(Browserbase\): [\d.]+ of 60 browser-minutes used this month/.test(r.text)));
  // The context id is stored, and only that; the row holds no page, no address, no cookie.
  const row = db.db.prepare("SELECT * FROM remote_browser_contexts WHERE conversation_id = ?").get(OWNER);
  assert.deepEqual(Object.keys(row).sort(), ["context_id", "conversation_id", "created_at", "site", "used_at"]);
});

test("the next page off the list, for a covered person, closes the hosted session and opens the local browser", skip, async () => {
  set(ON());
  consent();
  assert.equal((await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"))).ok, true);
  assert.equal(remote.remoteSessionsOpen(), 1);
  // A page off the list: the hosted session goes; this machine's browser opens it (a loopback page).
  const local = await runTool("browser_open", { url: `http://127.0.0.1:${SITE_PORT}/` }, turn(OWNER, "open it"));
  assert.equal(local.ok, true, JSON.stringify(local).slice(0, 200));
  assert.equal(remote.remoteSessionsOpen(), 0);
  assert.equal(releases().length, 1);
  assert.equal(sessionsMade().length, 1);
});

// ---------------------------------------------------------------- one attempt, then stop
test("a challenge page: the job stops at once, the site is paused for the hosted browser only, nothing is clicked, and it is never retried by itself", skip, async () => {
  set(ON());
  consent();
  const stop = await runTool("browser_open", { url: DD("/challenge") }, turn(OWNER, "order from doordash"));
  assert.equal(stop.hosted_browser, "challenge");
  assert.match(stop.say_exactly, /asked me to prove I'm a person, so I stopped there and didn't try to get past it/);
  assert.match(stop.note, /Nothing was retried and nothing will be/);
  assert.equal(remote.remoteSessionsOpen(), 0, "the session is closed");
  assert.equal(releases().length, 1);
  assert.ok(refusing.refusingSite("doordash.com", undefined, { browser: "remote" }), "marked on the first challenge");
  assert.equal(refusing.refusingSite("doordash.com"), null, "Reason's own browser memory is untouched");
  // The next ask is answered up front: no session is even asked for.
  const before = sessionsMade().length;
  const next = await runTool("browser_open", { url: DD("/") }, turn(OWNER, "try doordash again"));
  assert.equal(next.hosted_browser, "refused");
  assert.equal(sessionsMade().length, before);
  assert.ok(opsdigest.pending().some(r => /Hosted browser \(Browserbase\) for doordash\.com: the site showed a challenge/.test(r.text)));
});

test("a page that turns into a challenge: browser_click presses nothing and stops", skip, async () => {
  set(ON());
  consent();
  const open = await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"));
  assert.equal(open.ok, true);
  const ref = open.elements.find(e => /Find food/.test(e.name)).ref;
  const page = browser.openPage(OWNER);
  await page.evaluate(() => { document.body.insertAdjacentHTML("afterbegin", "<h1>Verify you are human</h1>"); document.body.querySelector("p")?.remove(); });
  const out = await runTool("browser_click", { ref }, turn(OWNER, "go on"));
  assert.equal(out.hosted_browser, "challenge");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(clicked.length, 0, "the button under the challenge was never pressed");
  assert.equal(remote.remoteSessionsOpen(), 0);
});

test("a block page (HTTP 403) stops the same way", skip, async () => {
  set(ON());
  consent();
  const out = await runTool("browser_open", { url: DD("/blocked") }, turn(OWNER, "open doordash"));
  assert.equal(out.hosted_browser, "challenge");
  assert.equal(out.stopped, "wall");
  assert.equal(remote.remoteSessionsOpen(), 0);
  assert.equal(refusing.refusingSite("doordash.com", undefined, { browser: "remote" }).evidence, "wall");
});

// ---------------------------------------------------------------- failures, in plain words
test("failure modes: key missing or refused, unreachable, out of minutes, start timeout; each said plainly once, a digest line, no session left", skip, async () => {
  const words = async () => runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"));
  const cases = [
    { name: "key missing", env: { BROWSERBASE_API_KEY: "" }, code: "key_missing", say: /isn't set up right now/, ops: /missing from the environment/ },
    { name: "key refused", status: { "*": 401 }, code: "key_invalid", say: /isn't set up right now/, ops: /refused the API key/ },
    { name: "out of minutes at Browserbase", status: { "POST /v1/sessions": 402 }, code: "out_of_minutes", say: /used up this month's time/, ops: /out of browser minutes/ },
    { name: "busy", status: { "POST /v1/sessions": 429 }, code: "busy", say: /in use for too many jobs/, ops: /concurrency/ },
    { name: "unreachable", env: { BROWSERBASE_API_URL: "http://127.0.0.1:9" }, code: "unreachable", say: /couldn't reach the hosted browser/, ops: /could not be reached/ },
    { name: "start timeout", env: { REASON_REMOTE_BROWSER_START_MS: "200" }, delay: { "POST /v1/sessions": 1500 }, code: "start_timeout", say: /didn't start in time/, ops: /did not start in time/ },
    { name: "connect fails", connect: "ws://127.0.0.1:9/devtools/browser/none", code: "unreachable", say: /couldn't reach/, ops: /could not be reached/ },
  ];
  for (const k of cases) {
    set({ ...ON(), ...(k.env ?? {}) });
    remote._resetRemote(); consent(); db.db.exec("DELETE FROM ops_digest");
    bb.calls.length = 0; bb.status = k.status ?? {}; bb.delay = k.delay ?? {}; bb.connectUrl = k.connect ?? WS;
    const out = await words();
    assert.equal(out.hosted_browser, k.code, `${k.name}: ${JSON.stringify(out).slice(0, 200)}`);
    assert.match(out.say_exactly, k.say, k.name);
    assert.match(out.say_exactly, /DoorDash app/, `${k.name}: the fallback that exists`);
    assert.match(out.note, /do not try the local browser/, k.name);
    assert.ok(opsdigest.pending().some(r => k.ops.test(r.text)), `${k.name}: a digest line for the owner`);
    assert.equal(remote.remoteSessionsOpen(), 0, `${k.name}: nothing left open`);
    // Every session Browserbase was asked for is released (a timed-out create is released by its own timeout).
    const made = sessionsMade().filter(c => c.body).length;
    if (k.code !== "start_timeout" && !k.status?.["POST /v1/sessions"] && !k.status?.["*"] && k.code !== "key_missing" && k.code !== "unreachable") assert.equal(releases().length, made);
    if (k.connect) assert.equal(releases().length, 1, "a session that would not connect is released");
    assert.equal(browser.openConversations().includes(OWNER), false, `${k.name}: no local browser opened instead`);
  }
});

test("the monthly budget: used up means no session is asked for", async () => {
  set({ ...ON(), REASON_REMOTE_BROWSER_MONTH_MINUTES: "2" });
  consent();
  const month = new Date().toISOString().slice(0, 7);
  db.db.prepare("INSERT INTO remote_browser_month (month, seconds) VALUES (?, ?)").run(month, 60);
  assert.equal(remote.gate(OWNER, "doordash.com"), null, "a minute left: it may go");
  db.db.prepare("UPDATE remote_browser_month SET seconds = ? WHERE month = ?").run(119, month);
  const out = await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"));
  assert.equal(out.hosted_browser, "out_of_minutes");
  assert.equal(bb.calls.length, 0);
  assert.equal(remote.monthBudgetMinutes(), 2);
  set(ON());
  assert.equal(remote.monthBudgetMinutes(), 60, "the free plan's hour by default");
  assert.equal(remote.sessionCapMinutes(), 15, "the free plan's longest session by default");
});

test("the hard cap: a session is ended by itself at its cap, released, and the next step is told so", skip, async () => {
  set({ ...ON(), REASON_REMOTE_BROWSER_TEST_CAP_MS: "400" });
  consent();
  assert.equal((await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"))).ok, true);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(remote.remoteSessionsOpen(), 0);
  assert.equal(releases().length, 1);
  assert.equal(remote.jobsFor(OWNER)[0].ended, "cap");
  const next = await runTool("browser_read", {}, turn(OWNER, "what does it say"));
  assert.equal(next.hosted_browser, "session_ended");
  assert.match(next.say_exactly, /ran out of time and closed/);
});

// ---------------------------------------------------------------- deleting
test("forgetting the login and deleting their data delete the Context at Browserbase too", skip, async () => {
  set(ON());
  consent();
  assert.equal((await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"))).ok, true);
  assert.equal(remote.hasContext(OWNER, "doordash.com"), true);
  const out = await runTool("account_revoke", { name: "doordash.com" }, turn(OWNER, "forget my doordash login"));
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 200));
  assert.equal(calls("DELETE /v1/contexts/:id").length, 1);
  assert.equal(calls("DELETE /v1/contexts/:id")[0].path, "/v1/contexts/ctx_1");
  assert.equal(remote.hasContext(OWNER, "doordash.com"), false);
  assert.equal(remote.remoteSessionsOpen(), 0, "an open session is closed before its Context goes");
  // The fallback forget (no filler) takes it too.
  assert.equal((await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"))).ok, true);
  await browser.closeBrowser(OWNER);
  const forgot = await runTool("saved_login_forget", { site: "doordash.com" }, turn(OWNER, "forget my doordash login"));
  assert.match(forgot.say_exactly, /deleted your sign-in for it from the hosted browser/);
  assert.equal(remote.hasContext(OWNER, "doordash.com"), false);
  // Their data deleted: the Context goes at Browserbase before the rows.
  assert.equal((await runTool("browser_open", { url: DD("/") }, turn(OWNER, "open doordash"))).ok, true);
  await browser.closeBrowser(OWNER);
  const { deleteData } = await import("../src/data.js");
  const before = calls("DELETE /v1/contexts/:id").length;
  const gone = await deleteData({ conversation: OWNER });
  assert.deepEqual(gone.hosted_browser, { deleted: 1, failed: 0 });
  assert.equal(calls("DELETE /v1/contexts/:id").length, before + 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM remote_browser_usage WHERE conversation_id = ?").get(OWNER).n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM remote_browser_consent WHERE conversation_id = ?").get(OWNER).n, 0);
  db.upsertAccount({ conversationId: OWNER, channel: "test", address: "+12025550171", name: "Owner", isOperator: true });
});

test("a delete Browserbase will not do: kept as a bare id with no person, said in the digest, and done next time", async () => {
  set(ON());
  db.db.prepare("INSERT INTO remote_browser_contexts (conversation_id, site, context_id, created_at) VALUES (?, 'doordash.com', 'ctx_77', ?)").run(OTHER, Date.now());
  bb.status = { "DELETE /v1/contexts/:id": 500 };
  const r = await remote.deleteContextsFor(OTHER, { orphan: true });
  assert.deepEqual(r, { deleted: 0, failed: 1 });
  assert.equal(remote.hasContext(OTHER, "doordash.com"), false, "their row goes with their data");
  assert.deepEqual(db.db.prepare("SELECT context_id FROM remote_browser_orphans").all().map(r => ({ ...r })), [{ context_id: "ctx_77" }]);
  assert.ok(opsdigest.pending().some(x => /could not be deleted at Browserbase/.test(x.text)));
  bb.status = {};
  assert.equal(await remote.retryOrphans(), 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM remote_browser_orphans").get().n, 0);
  // Not part of a data delete: a failed delete keeps the row, to be tried again.
  db.db.prepare("INSERT INTO remote_browser_contexts (conversation_id, site, context_id, created_at) VALUES (?, 'doordash.com', 'ctx_78', ?)").run(OTHER, Date.now());
  bb.status = { "DELETE /v1/contexts/:id": 500 };
  await remote.deleteContextsFor(OTHER, { site: "doordash.com" });
  assert.equal(remote.hasContext(OTHER, "doordash.com"), true);
});

test("no sign-in link or window for a hosted site; the email sign-in is tagged, gated and opened in the hosted browser", async () => {
  set(ON());
  const entry = remote.tagEntry(OWNER, { site: "doordash", label: "DoorDash", signin_url: "https://www.doordash.com/consumer/login" });
  assert.equal(entry.browser, "remote");
  assert.equal(entry.remote_site, "doordash.com");
  const findings = await import("../src/sitefindings.js");
  // The old finding about Reason's own browser (the 2026-11-12 probe) says nothing about the hosted one.
  assert.equal(findings.signinAccessStored({ ...entry, browser: undefined }).state, "blocked");
  assert.equal(findings.signinAccessStored(entry).state, "unknown");
  // Consent is asked before the background job starts.
  assert.equal(remote.gate(OWNER, "doordash.com").hosted_browser, "consent_needed");
  consent();
  assert.equal(remote.gate(OWNER, "doordash.com"), null);
  // The email sign-in hands the site to its launch, so the launch is the hosted one.
  const sie = await import("../src/signinemail.js");
  let launched = null;
  const out = sie.startEmailSignin({
    conversationId: OWNER, entry, email: "someone@example.com", log: () => {}, note: () => {},
    launch: async (args) => { launched = args; throw new remote.RemoteBrowserError("unreachable", "doordash.com"); },
  });
  await out.run;
  assert.deepEqual(launched, { conversationId: OWNER, url: entry.signin_url, site: "doordash.com" });
  sie._resetJobs();
});
