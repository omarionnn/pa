// The owner's sign-in attempt of 2026-11-12, 22:13-22:27 ET (Stripe Link), and the plain faults in it.
//
// What happened, from the live attempt log: the emailed-code route gave up on app.link.com after
// 1.1 s ("no email box": the box is drawn 1.3 s in); the fallback named the bare site "link.com",
// so the hosted link opened Link's marketing home page under "finish this step on the page below";
// the 10-minute session ran out and a third, identical link was sent.
//
// What has to hold now:
//   1. The emailed-code route WAITS for the form (bounded, stops early, same-origin frames too).
//   2. Every later link for an attempt opens the page the attempt was on, carried in code; a bare
//      name goes through the site's own "Log in" link once, and no link is sent when none is found.
//   3. A page that is not a sign-in page is never presented as a step.
//   4. A session that ends without progress does not send another identical link.
//   5. "Signed in" on a site nobody has a playbook for needs positive evidence; else "unknown".
//   6. One log line per step of a hosted session, with nothing personal in it.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-flow-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";
process.env.REASON_SOCIAL_SIGNIN = "owner";
process.env.REASON_TOKEN_KEY = "ab".repeat(32);

const em = await import("../src/signinemail.js");
const sp = await import("../src/signinpage.js");
const signin = await import("../src/signin.js");
const slog = await import("../src/signinlog.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const OWNER = "+12025551234";
const CONV = "dm:owner";
const EMAIL = "me@example.com";

// ---------------------------------------------------------------- a small site to sign in to
// Served over http on this machine, so "same origin" is a real origin and a frame on another port
// is really another origin. Nothing here leaves the machine.
const SUBMIT = `onclick="window.__pressed.push('continue:'+document.getElementById('email').value);document.getElementById('f').innerHTML='<p>We just sent you a temporary login code.</p><input id=code autocomplete=one-time-code placeholder=Code>'"`;
const FORM = `<form id="f" onsubmit="event.preventDefault()"><input id="email" type="email" autocomplete="email"><button type="button" ${SUBMIT}>Continue</button></form>`;
const PAGES = {
  // Link's shape: nothing at all when the page loads, the form drawn by the page's own script later.
  "/late": (q) => `<body><div id="root"></div><script>window.__pressed=[];setTimeout(function(){document.getElementById('root').innerHTML=${JSON.stringify(`<h1>Welcome</h1><p>Log in or sign up to get started.</p>${FORM}`)}}, ${Number(q.get("ms")) || 3000});</script></body>`,
  "/none": () => `<body><h1>Plans for every team</h1><p>${"The fastest way to pay, everywhere you shop. ".repeat(30)}</p><a href="/pricing" style="display:inline-block;width:120px;height:30px">Pricing</a></body>`,
  "/framed": (q) => `<body><h1>Welcome back</h1><p>Sign in to carry on with your account.</p><iframe id="fr" src="${q.get("src")}" width="380" height="300"></iframe></body>`,
  "/form": () => `<body><script>window.__pressed=[];</script><p>Log in to your account</p>${FORM}</body>`,
  "/home": () => `<body><nav><a href="/pricing" style="display:inline-block;width:80px;height:30px">Pricing</a> <a id="door" href="/login?from=home&email=someone%40example.com" style="display:inline-block;width:80px;height:30px">Log in</a></nav><h1>Pay faster everywhere</h1><p>${"A marketing page with a demo checkout: Notion Plus $12.00 monthly. ".repeat(20)}</p></body>`,
  "/login": () => `<body><script>window.__pressed=[];</script><h1>Welcome</h1><p>Log in or sign up to get started.</p>${FORM}</body>`,
  "/pricing": () => `<body><h1>Pricing</h1><p>${"Simple pricing for everybody. ".repeat(30)}</p></body>`,
};
let server, base, other, browser;
const serve = () => new Promise((done) => {
  const s = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const make = PAGES[u.pathname];
    res.writeHead(make ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(make ? `<!doctype html><html>${make(u.searchParams)}</html>` : "<html><body>Not found</body></html>");
  });
  s.listen(0, "127.0.0.1", () => done(s));
});
before(async () => {
  server = await serve();
  const second = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  // The same machine on another port: another origin.
  other = `http://127.0.0.1:${second.address().port}`;
  server.second = second;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); server?.second?.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  em._resetJobs();
  slog._resetAttempts();
  slog._resetSteps();
  db.db.exec("DELETE FROM accounts; DELETE FROM connected_accounts; DELETE FROM timers; DELETE FROM signin_pages;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.publicUrl = "https://reason.example";
  process.env.REASON_SOCIAL_SIGNIN = "owner";
});
/** A site-shaped entry for the local fixture: its hosts are this machine's, as a real entry's are its own. */
const entryAt = (path, extra = {}) => ({ ...signin.genericEntry("https://example-pay.com/login"), label: "Example", hosts: ["127.0.0.1"], signin_url: `${base}${path}`, entry: `${base}/`, ...extra });
const open = async (url) => { const page = await browser.newPage({ viewport: { width: 430, height: 700 } }); await page.goto(url, { waitUntil: "domcontentloaded" }); return page; };

// ---------------------------------------------------------------- 1. the emailed code waits for the form
test("an email box the page draws 3 seconds after it loads is found: the route waits, and stops the moment it is there", async () => {
  const page = await open(`${base}/late?ms=3000`);
  try {
    // What the old code did: one read, straight after the page loaded.
    assert.equal((await page.evaluate(em.emailPage, "")).email, false, "no box yet when the page has just loaded");
    const t0 = Date.now();
    const asked = await em.requestCode(page, entryAt("/late"), EMAIL, { settleMs: 50, formWaitMs: 10_000 });
    const took = Date.now() - t0;
    assert.equal(asked.ok, true, JSON.stringify({ ...asked, on: undefined }));
    assert.equal(asked.state, "code");
    assert.ok(asked.form_ms >= 2000 && asked.form_ms < 6000, `found when it appeared, not at the bound: ${asked.form_ms} ms`);
    assert.ok(took < 8000, `stopped early: ${took} ms`);
    assert.deepEqual(await page.evaluate(() => window.__pressed), [`continue:${EMAIL}`], "the email went into the box that appeared");
  } finally { await page.close(); }
});

test("a page that truly has no email box: said within the bound, never longer", async () => {
  const page = await open(`${base}/none`);
  try {
    const t0 = Date.now();
    const asked = await em.requestCode(page, entryAt("/none"), EMAIL, { settleMs: 50, formWaitMs: 1500 });
    const took = Date.now() - t0;
    assert.equal(asked.ok, false);
    assert.equal(asked.state, "none");
    assert.ok(asked.form_ms >= 1500 && asked.form_ms < 2600, `waited the bound and no more: ${asked.form_ms} ms`);
    assert.ok(took < 4000, `concluded within the bound: ${took} ms`);
    assert.equal(asked.detail, "no_signin_page", "a page with no form, no challenge and no provider prompt is not a sign-in page");
  } finally { await page.close(); }
});

test("the default bound is about ten seconds, set by REASON_SIGNIN_FORM_WAIT_MS, and follows the settle time a caller runs at", async () => {
  assert.equal(config.signinFormWaitMs, 10_000);
  assert.equal(sp.formWaitMs(), 10_000);
  const page = await open(`${base}/none`);
  const was = config.signinFormWaitMs;
  try {
    config.signinFormWaitMs = 800;
    const t0 = Date.now();
    const asked = await em.requestCode(page, entryAt("/none"), EMAIL, {});
    assert.equal(asked.state, "none");
    assert.ok(asked.form_ms >= 800 && Date.now() - t0 < 3000, `the configured bound: ${asked.form_ms} ms`);
  } finally { config.signinFormWaitMs = was; await page.close(); }
});

test("a form in the site's own same-origin frame is found and typed into; another origin's frame is never read", async () => {
  const same = await open(`${base}/framed?src=${encodeURIComponent("/form")}`);
  try {
    const asked = await em.requestCode(same, entryAt("/framed"), EMAIL, { settleMs: 50, formWaitMs: 5000 });
    assert.equal(asked.ok, true, JSON.stringify({ ...asked, on: undefined }));
    const frame = same.frames().find(f => f.url().endsWith("/form"));
    assert.deepEqual(await frame.evaluate(() => window.__pressed), [`continue:${EMAIL}`], "typed into the frame's own box");
    const done = await em.enterCode(same, "482913", { settleMs: 50, on: asked.on });
    assert.equal(done.ok, true, "the code box in that frame is the one the code goes into");
    assert.equal(await frame.evaluate(() => document.getElementById("code").value), "482913");
  } finally { await same.close(); }

  const cross = await open(`${base}/framed?src=${encodeURIComponent(`${other}/form`)}`);
  try {
    const asked = await em.requestCode(cross, entryAt("/framed"), EMAIL, { settleMs: 50, formWaitMs: 1200 });
    assert.equal(asked.ok, false, "a form on another origin is not the site's own form");
    const frame = cross.frames().find(f => f.url().startsWith(other));
    assert.deepEqual(await frame.evaluate(() => window.__pressed), [], "nothing was typed or pressed in it");
  } finally { await cross.close(); }
});

test("a step line says whether the form was found and how long it was given: a number and a host, nothing personal", async () => {
  const page = await open(`${base}/late?ms=600`);
  const notes = [];
  try {
    const out = em.startEmailSignin({
      conversationId: CONV, entry: entryAt("/late"), email: EMAIL, settleMs: 40, formWaitMs: 5000,
      launch: async () => ({ page, close: async () => {} }),
      gmail: async () => ({ connected: true, found: false }),
      note: (_c, t) => notes.push(t),
    });
    await out.run;
  } finally { await page.close(); }
  assert.equal(slog.recentAttempts().at(-1).outcome, "code_not_found", "the code was asked for; no mail came in this fixture");
  const line = slog.recentSteps().at(-1);
  assert.equal(line.step, "form_found");
  assert.equal(line.route, "emailed_code");
  assert.ok(line.waited_ms >= 400 && line.waited_ms < 4000, `waited_ms ${line.waited_ms}`);
  assert.deepEqual(Object.keys(line).sort(), ["at", "ms", "page_host", "route", "signin_step", "step", "waited_ms"]);
  assert.equal(line.page_host, "127.0.0.1", "a host, never a path or a query");
  assert.ok(!JSON.stringify(slog.recentSteps()).includes(EMAIL) && !JSON.stringify(slog.recentSteps()).includes("late"));
});
