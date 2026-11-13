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
  // A sign-in form of another shape: a phone number and a password, no email box anywhere.
  "/pwonly": () => `<body><h1>Welcome back</h1><p>Enter your mobile number and your password to carry on with your account.</p><input type="tel" name="phone" autocomplete="tel" style="width:240px;height:34px"><input type="password" name="pw" style="width:240px;height:34px"><button>Continue</button></body>`,
  // Words on the page from the start, and the form only once a slow request of the page's own has answered.
  "/shell": (q) => `<body><h1>Example Pay</h1><p>The fastest way to pay, everywhere you shop. Help, terms, privacy and cookies.</p><div id="root"></div><script>window.__pressed=[];fetch('/slow?ms=${Number(q.get("ms")) || 3000}').then(function(){document.getElementById('root').innerHTML=${JSON.stringify(FORM)}});</script></body>`,
};
let server, base, other, browser;
const serve = () => new Promise((done) => {
  const s = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    // An answer that takes its time: what a page that is still fetching is waiting on.
    if (u.pathname === "/slow") { setTimeout(() => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); }, Number(u.searchParams.get("ms")) || 1000); return; }
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
beforeEach(async () => {
  clock.reset();
  em._resetJobs();
  // No session left over from the test before, and nothing remembered about anybody's pages.
  const hostedSessions = await import("../src/signin-remote.js");
  await hostedSessions.endAllRemoteSignins("replaced");
  hostedSessions.forgetAllRemoteSignins();
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

test("a finished page with no email box is said in a couple of seconds, not at the ten-second bound: a home page, and a form of another shape", async () => {
  for (const [path, detail] of [["/none", "no_signin_page"], ["/pwonly", undefined]]) {
    const page = await open(`${base}${path}`);
    try {
      const t0 = Date.now();
      const asked = await em.requestCode(page, entryAt(path), EMAIL, { settleMs: 50, formWaitMs: 10_000 });
      const took = Date.now() - t0;
      assert.equal(asked.ok, false, path);
      assert.equal(asked.state, "none", path);
      assert.equal(asked.detail, detail, path);
      assert.ok(asked.form_ms >= 1500 && asked.form_ms < 7000, `${path}: stopped once the page had stood finished for two seconds, not at the bound: ${asked.form_ms} ms`);
      assert.ok(took < 8500, `${path}: ${took} ms`);
    } finally { await page.close(); }
  }
});

test("a page with words on it that is still fetching is not finished: its form is waited for past the quiet time", async () => {
  const page = await open(`${base}/shell?ms=3200`);
  try {
    assert.equal((await page.evaluate(em.emailPage, "")).email, false, "no box while its own request is out");
    const asked = await em.requestCode(page, entryAt("/shell"), EMAIL, { settleMs: 50, formWaitMs: 10_000 });
    assert.equal(asked.ok, true, JSON.stringify({ ...asked, on: undefined }));
    assert.equal(asked.state, "code");
    assert.ok(asked.form_ms >= 2400 && asked.form_ms < 9000, `found when the page drew it: ${asked.form_ms} ms`);
    assert.deepEqual(await page.evaluate(() => window.__pressed), [`continue:${EMAIL}`]);
  } finally { await page.close(); }
});

test("what 'finished' needs: a real document that is complete, has words, fetches nothing and has stopped changing; a stand-in never is", async () => {
  // A stand-in page (no document to read) is never settled: the wait runs to its bound as before.
  const fake = { evaluate: async () => ({ email: false, text: "x".repeat(200) }), waitForTimeout: async () => {} };
  const w = sp.settleWatch(fake, { quietMs: 0 });
  assert.equal(await w.settled(), false);
  assert.equal(await w.settled(), false);
  w.stop();
  const out = await sp.waitFor(fake, async () => null, { waitMs: 300, pollMs: 50, stop: () => w.settled() });
  assert.equal(out.found, false);
  assert.equal(out.settled, undefined, "it reached the bound; nothing stopped it early");
  // A blank shell (an app that has not drawn yet) is not settled however long it stands.
  const blank = await open(`${base}/late?ms=60000`);
  try {
    const wb = sp.settleWatch(blank, { quietMs: 200 });
    await wb.settled();
    await new Promise(r => setTimeout(r, 900));
    assert.equal(await wb.settled(), false, "no words on it yet");
    wb.stop();
  } finally { await blank.close(); }
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

// ================================================================ fixes 2-6
const remote = await import("../src/signin-remote.js");
const sites = await import("../src/sites.js");
const social = await import("../src/socialsignin.js");
const { runTool } = await import("../src/tools.js");
const { nativeStepPanel, setupNativePage, setupResultPage } = await import("../src/pages/setupsignin.js");

const LINK_LOGIN = "https://app.link.com/login";
const pub = async (url) => ({ ok: true, url });
const timerNotes = (c = CONV) => db.db.prepare("SELECT note FROM timers WHERE conversation_id = ? ORDER BY id").all(c).map(r => r.note);
/** https pages that exist only inside the test's browser: a real origin, no network. */
async function routed(pages, { width = 430 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.route(/^https:\/\/([a-z]+\.)?pay-example\.com\//, (route) => {
    const u = new URL(route.request().url());
    const hit = pages[`${u.hostname}${u.pathname}`];
    if (!hit) return route.fulfill({ status: 404, contentType: "text/html", body: "<html><body>Not found</body></html>" });
    return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html>${hit}</html>` });
  });
  return page;
}
const MARKETING = `<body><nav><a href="/pricing" style="display:inline-block;width:80px;height:30px">Pricing</a></nav><h1>The fastest way to pay</h1><p>${"Check out in one click, everywhere you shop. Notion Plus $12.00 monthly. ".repeat(20)}</p></body>`;
const WITH_DOOR = (href) => MARKETING.replace("</nav>", ` <a href="${href}" style="display:inline-block;width:80px;height:30px">Log in</a></nav>`);
const LOGIN_FORM = `<body><script>window.__pressed=[];</script><h1>Welcome</h1><p>Log in or sign up to get started.</p>${FORM}</body>`;
const PHONE_ONLY = `<body><h1>Welcome back</h1><p>Enter your mobile number to carry on with your account.</p><input type="tel" name="phone" autocomplete="tel" style="width:240px;height:34px"><button>Continue</button></body>`;

// ---------------------------------------------------------------- 2. a hand-off lands on the page the sign-in was on
test("a bare name is the front page; the page an attempt was on is remembered per person and resolves it, with no query string", () => {
  const bare = signin.genericEntry("link.com");
  assert.equal(bare.signin_url, "https://link.com/", "what a bare name gives by itself: the front page");
  assert.equal(signin.entryOnItsPage(CONV, bare).signin_url, "https://link.com/", "nothing known yet");
  const began = signin.genericEntry(`${LINK_LOGIN}?email=me%40example.com&redirect=%2Fwallet`);
  assert.equal(began.signin_url, LINK_LOGIN, "origin + path only");
  assert.equal(sp.rememberSigninPage(CONV, began, `${LINK_LOGIN}?email=me%40example.com#x`), LINK_LOGIN);
  assert.equal(signin.entryOnItsPage(CONV, signin.genericEntry("link.com")).signin_url, LINK_LOGIN, "the bare name now opens THAT page");
  assert.equal(signin.entryOnItsPage(CONV, signin.genericEntry("link.com")).site, "link.com", "the same site, one row");
  assert.equal(signin.entryOnItsPage("dm:fake:+14155559876", signin.genericEntry("link.com")).signin_url, "https://link.com/", "another person's attempt is theirs alone");
  // An address that already names a page, and a registry site, come back untouched.
  assert.equal(signin.entryOnItsPage(CONV, signin.genericEntry("https://link.com/signin")).signin_url, "https://link.com/signin");
  assert.equal(signin.entryOnItsPage(CONV, sites.site("amazon")), sites.site("amazon"));
  // Never a front page, never a page off the site, never anything but https.
  assert.equal(sp.rememberSigninPage(CONV, began, "https://link.com/"), "");
  assert.equal(sp.rememberSigninPage(CONV, began, "https://evil.example/login"), "");
  assert.equal(sp.pageOf("http://app.link.com/login"), "");
  assert.ok(!JSON.stringify(db.db.prepare("SELECT * FROM signin_pages").all()).includes("example.com"), "no email, no query, in what is kept");
});

test("tonight's case: the emailed code finds no email route on app.link.com/login — the instruction names THAT page, and signin_link for bare 'link.com' opens it", async () => {
  const entry = signin.genericEntry("https://app.pay-example.com/login");
  const page = await routed({ "app.pay-example.com/login": PHONE_ONLY });
  const notes = [];
  try {
    await page.goto("https://app.pay-example.com/login", { waitUntil: "domcontentloaded" });
    const out = em.startEmailSignin({ conversationId: CONV, entry, email: EMAIL, settleMs: 30, formWaitMs: 400, launch: async () => ({ page, close: async () => {} }), gmail: async () => ({ connected: false }), note: (_c, t) => notes.push(t) });
    await out.run;
  } finally { await page.close(); }
  assert.match(notes[0], /signin_link with site "https:\/\/app\.pay-example\.com\/login"/, "the exact page, in the instruction");
  assert.doesNotMatch(notes[0], /signin_link with site "pay-example\.com"/, "never the bare name");
  assert.match(notes[0], /Use that site value exactly as written/);
  assert.equal(slog.recentAttempts().at(-1).detail, "no_email_box");
  // And in code, whatever the model types: the bare name resolves to the page the attempt was on.
  const made = [];
  const link = await runTool("signin_link", { site: "pay-example.com" }, {
    conversationId: CONV, messages: [], kind: "event", publicUrl: pub,
    locateSigninPage: async () => { throw new Error("the page is already known: nothing is looked for"); },
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; },
  });
  assert.equal(link.ok, true, JSON.stringify(link));
  assert.equal(made[0].entry.signin_url, "https://app.pay-example.com/login", "the link opens the sign-in page, not the front page");
  assert.equal(made[0].entry.site, "pay-example.com");
});

test("only a bare name is known: the site's own sign-in page is found BEFORE a link is made; none found, no link and a plain line", async () => {
  const made = [];
  const seam = { createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; } };
  const asked = [];
  const found = await runTool("signin_link", { site: "link.com" }, { conversationId: CONV, messages: [], kind: "user", publicUrl: pub, ...seam,
    locateSigninPage: async (e) => { asked.push(e.signin_url); return { found: true, url: LINK_LOGIN, kind: "signin_form", followed: true, ms: 3900 }; } });
  assert.deepEqual(asked, ["https://link.com/"], "looked for from the front page, once");
  assert.equal(found.ok, true);
  assert.equal(made[0].entry.signin_url, LINK_LOGIN);
  assert.equal(sp.signinPageFor(CONV, signin.genericEntry("link.com")), LINK_LOGIN, "remembered for every later link");

  made.length = 0;
  const none = await runTool("signin_link", { site: "nowhere-pay.com" }, { conversationId: CONV, messages: [], kind: "user", publicUrl: pub, ...seam,
    locateSigninPage: async () => ({ found: false, url: "https://nowhere-pay.com/", kind: "not_signin", followed: false, ms: 10_000 }) });
  assert.equal(none.ok, false);
  assert.equal(none.no_signin_page, true);
  assert.equal(made.length, 0, "no link is made");
  assert.match(none.say, /I can't find where to sign in on Nowhere-pay/);
  assert.match(none.say, /Do not send a link/);

  const down = await runTool("signin_link", { site: "nowhere-pay.com" }, { conversationId: CONV, messages: [], kind: "user", publicUrl: pub, ...seam,
    locateSigninPage: async () => { throw new Error("no answer in 40s"); } });
  assert.equal(down.could_not_open, true, "a site that would not open is said as that, not as 'no sign-in page'");
  assert.equal(made.length, 0);
});

test("in a real browser: a home page's own 'Log in' link is followed once, to the form; the page kept has no query string", async () => {
  const page = await routed({
    "pay-example.com/": WITH_DOOR("https://app.pay-example.com/login?from=home&email=someone%40example.com"),
    "app.pay-example.com/login": LOGIN_FORM,
  }, { width: 1280 });
  try {
    await page.goto("https://pay-example.com/", { waitUntil: "domcontentloaded" });
    const at = await sp.arriveAtSignin(page, signin.genericEntry("pay-example.com"), { waitMs: 3000 });
    assert.equal(at.kind, "signin_form");
    assert.equal(at.followed, true);
    assert.equal(at.page, "https://app.pay-example.com/login", "origin + path, nothing after it");
  } finally { await page.close(); }

  // No sign-in link at all, or one that leads off the site: nothing is followed and nothing is found.
  for (const home of [MARKETING, WITH_DOOR("https://accounts.elsewhere-example.com/login")]) {
    const none = await routed({ "pay-example.com/": home }, { width: 1280 });
    try {
      await none.goto("https://pay-example.com/", { waitUntil: "domcontentloaded" });
      const at = await sp.arriveAtSignin(none, signin.genericEntry("pay-example.com"), { waitMs: 1200 });
      assert.equal(at.kind, "not_signin");
      assert.equal(sp.isStep(at.kind), false);
      assert.equal(sp.pageOf(none.url()), "https://pay-example.com/", "still on the site's own page");
    } finally { await none.close(); }
  }

  // With the whole ten seconds to spend, a finished page with no form and no link is said early.
  const quick = await routed({ "pay-example.com/": MARKETING }, { width: 1280 });
  try {
    await quick.goto("https://pay-example.com/", { waitUntil: "domcontentloaded" });
    const at = await sp.arriveAtSignin(quick, signin.genericEntry("pay-example.com"), { waitMs: 10_000 });
    assert.equal(at.kind, "not_signin");
    assert.ok(at.ms < 7000, `stopped on the finished page, not at the bound: ${at.ms} ms`);
  } finally { await quick.close(); }
});

test("which sign-in link may be followed: on the site's own hosts always; on the domain the site itself sent the browser to only where a person will type; never a third site", async () => {
  const notion = signin.genericEntry("notion.so");
  const at = (here, href) => { const gotos = []; return { gotos, page: { url: () => here, evaluate: async () => ({ label: "Log in", href, shown: true }), goto: async (u) => { gotos.push(u); } } }; };
  const own = at("https://www.notion.com/", "https://www.notion.so/login");
  assert.equal((await sp.followSigninDoor(own.page, notion)).followed, true, "the site's own host");
  const sibling = at("https://www.notion.com/", "https://www.notion.com/login");
  assert.equal((await sp.followSigninDoor(sibling.page, notion)).followed, false, "the emailed-code route never follows it off the named site");
  assert.equal((await sp.followSigninDoor(sibling.page, notion, { allowCurrentSite: true })).followed, true, "the link and the look-up do: it is where the site sent the browser");
  assert.deepEqual(sibling.gotos, ["https://www.notion.com/login"]);
  const third = at("https://www.notion.com/", "https://accounts.elsewhere-example.com/login");
  assert.equal((await sp.followSigninDoor(third.page, notion, { allowCurrentSite: true })).followed, false, "never a third site, and never by a press either");
  assert.deepEqual(third.gotos, []);
  const plain = at("https://www.notion.com/", "http://www.notion.so/login");
  assert.equal((await sp.followSigninDoor(plain.page, notion, { allowCurrentSite: true })).followed, false, "https only");
  // Shared hosting: another sub-host is somebody else's site, whatever the last two labels say.
  const teamA = signin.genericEntry("https://team-a.github.io/login");
  const neighbour = at("https://team-a.github.io/", "https://team-b.github.io/login");
  assert.equal((await sp.followSigninDoor(neighbour.page, teamA, { allowCurrentSite: true })).followed, false, "a neighbour on shared hosting is a third site");
  assert.equal((await sp.followSigninDoor(neighbour.page, teamA)).followed, false);
  assert.deepEqual(neighbour.gotos, []);
  const sameHost = at("https://team-a.github.io/", "https://team-a.github.io/login");
  assert.equal((await sp.followSigninDoor(sameHost.page, teamA)).followed, true, "its own host is still its own");
});

test("the emailed code with only a bare name: the site's own Log in link is followed first; with none, no link is offered at all", async () => {
  const bare = signin.genericEntry("pay-example.com");
  const page = await routed({ "pay-example.com/": WITH_DOOR("https://app.pay-example.com/login"), "app.pay-example.com/login": LOGIN_FORM });
  try {
    await page.goto(bare.signin_url, { waitUntil: "domcontentloaded" });
    const asked = await em.requestCode(page, bare, EMAIL, { settleMs: 50, formWaitMs: 2500 });
    assert.equal(asked.ok, true, JSON.stringify({ ...asked, on: undefined }));
    assert.equal(asked.followed, true);
    assert.equal(asked.where, "https://app.pay-example.com/login", "the page the form was found on");
  } finally { await page.close(); }

  const dead = await routed({ "pay-example.com/": MARKETING });
  const notes = [];
  try {
    await dead.goto(bare.signin_url, { waitUntil: "domcontentloaded" });
    const out = em.startEmailSignin({ conversationId: CONV, entry: bare, email: EMAIL, settleMs: 30, formWaitMs: 500, launch: async () => ({ page: dead, close: async () => {} }), gmail: async () => ({ connected: false }), note: (_c, t) => notes.push(t) });
    await out.run;
  } finally { await dead.close(); }
  assert.match(notes[0], /Reason cannot find where to sign in on Pay-example/);
  assert.match(notes[0], /Do NOT send a sign-in link/);
  assert.match(notes[0], /I can't find where to sign in on Pay-example/);
  assert.doesNotMatch(notes[0], /offer the secure sign-in link/);
  assert.equal(slog.recentAttempts().at(-1).detail, "no_signin_page");
});

// ---------------------------------------------------------------- 3. no phantom steps
const HOME_RAW = { url: "https://link.com/", text: `Link The fastest way to pay Check out in one click. ${"Notion Plus $12.00 monthly. Pay faster everywhere you shop online. ".repeat(12)}`, fields: [], buttons: ["Sign in", "Get started"], acct: "" };
const FORM_RAW = { url: LINK_LOGIN, text: "Welcome to Link Log in or sign up to get started. Email Continue Help Terms Privacy Cookies", acct: "", buttons: ["Continue"],
  fields: [{ x: 0.1, y: 0.4, w: 0.8, h: 0.07, tag: "input", type: "email", ac: "email", name: "", id: "", label: "Email", im: "", ml: 0, len: 0, focused: false }] };
const INSIDE_RAW = { url: "https://app.link.com/wallet", text: `Wallet Your payment methods ${"Visa ending 4242. Mastercard ending 4444. Addresses and receipts. ".repeat(4)}`, fields: [], buttons: ["Add a payment method"], acct: "logout" };

test("what kind of page: a marketing or home page is never a step; a form, a challenge and a provider prompt are", () => {
  const box = (over) => ({ x: 0.1, y: 0.3, w: 0.8, h: 0.06, tag: "input", type: "text", ac: "", name: "", id: "", label: "", im: "", ml: 0, len: 0, focused: false, ...over });
  assert.equal(sp.pageKind(HOME_RAW), "not_signin");
  assert.equal(sp.isStep(sp.pageKind(HOME_RAW)), false);
  assert.equal(sp.pageKind(FORM_RAW), "signin_form");
  // A box on a home page that is not a sign-in box: a newsletter, a search.
  assert.equal(sp.pageKind({ ...HOME_RAW, fields: [box({ type: "email", label: "Subscribe to our newsletter" })] }), "not_signin");
  assert.equal(sp.pageKind({ ...HOME_RAW, fields: [box({ type: "search", label: "Search" })] }), "not_signin");
  assert.equal(sp.pageKind({ ...HOME_RAW, fields: [box({ label: "Company name" })] }), "not_signin", "any old box on an opening page is not a sign-in");
  assert.equal(sp.pageKind({ ...HOME_RAW, fields: [box({ label: "Workspace name" })] }, { midFlow: true }), "signin_form", "but in the middle of a sign-in, a box to fill in is a step");
  // A footer line on a long page is not a challenge; a challenge page is.
  assert.equal(sp.pageKind({ ...HOME_RAW, text: `${HOME_RAW.text} ${"More about the product. ".repeat(40)} This site is protected by reCAPTCHA and Cloudflare.` }), "not_signin");
  assert.equal(sp.pageKind({ url: "https://link.com/", text: "Just a moment... Verifying you are human. This may take a few seconds.", fields: [] }), "challenge");
  assert.equal(sp.pageKind({ url: "https://accounts.google.com/v3/signin/accountchooser", text: "Choose an account to continue to Example. Use another account", fields: [] }), "provider_prompt");
  assert.equal(sp.pageKind({ url: "about:blank", text: "", fields: [] }), "loading");
  assert.equal(sp.pageKind({ ...HOME_RAW, text: "Sign in" + " ".repeat(20) + "Password", fields: [box({ type: "password" })] }), "signin_form");
  // A form in the site's own frame counts like the page's.
  assert.equal(sp.pageKind(HOME_RAW, { framed: FORM_RAW.fields }), "signin_form");
});

test("the panels for a page that is not a step never say 'finish this step'; a real step still does", () => {
  const link = signin.genericEntry("link.com");
  for (const step of ["looking", "between", "loading"]) {
    const html = nativeStepPanel({ step, say: "x" }, { entry: link });
    assert.doesNotMatch(html, /finish this step/i, step);
    assert.doesNotMatch(html, /pick back up/i, step);
    assert.doesNotMatch(setupNativePage({ entry: link, step: { step, say: "x" } }), /Finish this step on the page below/, step);
  }
  assert.match(nativeStepPanel({ step: "looking", say: "Looking for Link's sign-in page…" }, { entry: link }), /isn't its sign-in page/);
  for (const step of ["captcha", "unknown"]) assert.match(nativeStepPanel({ step, say: "x" }, { entry: link }), /finish this step on the page below/, step);
  for (const step of ["account", "consent", "captcha", "unknown"]) assert.match(setupNativePage({ entry: link, step: { step, say: "x" } }), /Finish this step on the page below/, step);
});

/** A stand-in browser for a hosted session: shows the frame it is told to, answers the door it is given. */
function hosted({ entry, frames, door = null, said = { ok: true, state: "signed_out", why: "its sign-in page still shows the sign-in form" } }) {
  const b = { i: 0, frames, door, gotos: [], did: [], closed: 0, checks: [] };
  const now = () => b.frames[Math.min(b.i, b.frames.length - 1)];
  const page = {
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, b.i & 0xff]),
    evaluate: async (fn, arg) => {
      if (fn === sp.signinDoor) { b.did.push(["door", arg || "read"]); return b.door; }
      return now();
    },
    url: () => now().url,
    goto: async (u) => { b.gotos.push(u); b.onGoto?.(u); },
    mouse: { click: async (x, y) => { b.did.push(["click", x, y]); }, wheel: async () => {} },
    keyboard: { type: async () => { b.did.push(["type"]); }, press: async (k) => { b.did.push(["press", k]); } },
    goBack: async () => {},
  };
  const logs = [], booked = [];
  const timers = { set: (fn, ms) => { const h = { fn, ms, cleared: false }; booked.push(h); return h; }, clear: (h) => { if (h) h.cleared = true; } };
  const out = remote.createRemoteSignin({
    conversationId: CONV, entry, timers, log: (e) => logs.push(e), closeBrowser: async () => {},
    launch: async () => ({ page, close: async () => { b.closed++; } }),
    check: async (_p, c, site, opts) => { b.checks.push({ site, opts }); return typeof said === "function" ? said() : said; },
  });
  const token = out.url.split("/").pop();
  const req = (action = "", { method = "GET", cookie = "", body = null, query = {}, headers = {} } = {}) =>
    remote.remoteRequest({ token, action, method, headers: { ...headers, ...(cookie ? { cookie } : {}) }, query, readBody: async () => (body === null ? "" : JSON.stringify(body)) });
  const proved = () => { const t = `sess-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${CONV}`, t, { conversationId: CONV }); return `reason_page=${t}`; };
  const start = async () => { const r = await req("start", { method: "POST", cookie: proved() }); return String(r.headers["Set-Cookie"] ?? "").split(";")[0]; };
  const view = async (cookie) => {
    const res = await req("view", { cookie });
    if (!Buffer.isBuffer(res.body)) return { json: JSON.parse(res.body) };
    const n = res.body.readUInt32BE(0);
    return { meta: JSON.parse(res.body.subarray(4, 4 + n).toString("utf8")) };
  };
  return { b, token, req, start, view, logs, booked, out };
}
const stepsOf = () => slog.recentSteps().map(l => [l.step, l.kind ?? l.detail ?? ""].filter(Boolean).join(":"));

test("tonight's link, replayed: Link's home page opens — no 'finish this step', the site's own link is looked for, and the session ends plainly with no second link", async () => {
  const h = hosted({ entry: signin.genericEntry("link.com"), frames: [HOME_RAW] });
  await h.req("", { headers: { "user-agent": "Mozilla/5.0 (iPhone)" } });
  const cookie = await h.start();
  const first = await h.view(cookie);
  assert.equal(first.meta.np.step, "looking", "not a step: Reason is still looking for the sign-in page");
  assert.equal(first.meta.np.page, false, "the picture is not pushed at them");
  assert.doesNotMatch(first.meta.np.html, /finish this step/i);
  assert.match(first.meta.np.say, /Looking for Link's sign-in page/);
  // A few seconds in, the site's own "Log in" link is looked for; this page has none.
  clock.skip(3000);
  assert.equal((await h.view(cookie)).meta.np.step, "looking");
  assert.ok(h.b.did.some(d => d[0] === "door"), "its own sign-in link was looked for");
  // The bound passes with no sign-in page: ended, said plainly.
  clock.skip(8000);
  const over = await h.view(cookie);
  assert.deepEqual(over.json, { over: true, state: "signed_out" });
  assert.equal(h.b.closed, 1, "their saved profile is let go at once, not held for ten minutes");
  const result = (await h.req("", { cookie })).body;
  assert.match(result, /I couldn&#39;t find where to sign in on Link|I couldn't find where to sign in on Link/);
  assert.doesNotMatch(result, /fresh link/i);
  const notes = timerNotes();
  assert.equal(notes.length, 1, "one note, one line");
  assert.match(notes[0], /is not a sign-in page/);
  assert.match(notes[0], /Do NOT make another sign-in link/);
  assert.match(notes[0], /I can't find where to sign in on Link/);
  assert.doesNotMatch(notes[0], /offer a fresh link/);
  assert.deepEqual(stepsOf(), ["link_opened", "start_pressed", "page_kind:not_signin_page", "signin_link_followed:none_found", "ended:no_signin_page"]);
  assert.equal(slog.recentAttempts().at(-1).detail, "no_signin_page");
  // And nothing loops: the model, woken by that note, cannot make the same link again.
  const again = await runTool("signin_link", { site: "link.com" }, { conversationId: CONV, messages: [], kind: "event", publicUrl: pub,
    locateSigninPage: async () => ({ found: true, url: "https://link.com/", kind: "signin_form", followed: false, ms: 10 }),
    createRemoteSignin: () => { throw new Error("no second identical link"); } });
  assert.equal(again.ok, false);
  assert.equal(again.not_sent_again, true);
  assert.match(again.error, /would open the same page/);
});

test("the same link when the home page HAS a 'Log in' link: it is followed once, before they are shown a step, and the form is what they get", async () => {
  const h = hosted({ entry: signin.genericEntry("link.com"), frames: [HOME_RAW, FORM_RAW], door: { label: "Sign in", href: LINK_LOGIN, shown: true } });
  h.b.onGoto = () => { h.b.i = 1; };
  const cookie = await h.start();
  assert.equal((await h.view(cookie)).meta.np.step, "looking");
  clock.skip(3000);
  const v = await h.view(cookie);
  assert.deepEqual(h.b.gotos, [LINK_LOGIN], "its own link, once");
  assert.equal(v.meta.np.step, "email", "a real step: the site's email box, in Reason's own panel");
  assert.equal(sp.signinPageFor(CONV, signin.genericEntry("link.com")), LINK_LOGIN, "the page the form is on is kept for later links");
  clock.skip(20_000);
  assert.equal((await h.view(cookie)).meta.np.step, "email", "a session on a real step is never ended as 'no sign-in page'");
  assert.deepEqual(stepsOf().slice(0, 4), ["start_pressed", "page_kind:not_signin_page", "signin_link_followed:followed", "page_kind:signin_form"]);
});

test("a known site showing a page with nothing to fill in mid-way: shown as that, never as a step to finish", async () => {
  const amazon = sites.site("amazon");
  const between = { url: "https://www.amazon.com/ap/interstitial", text: `Amazon ${"Loading your account details and getting things ready for you. ".repeat(4)}`, fields: [], buttons: ["Continue shopping"], acct: "" };
  const h = hosted({ entry: amazon, frames: [between] });
  const cookie = await h.start();
  const v = await h.view(cookie);
  assert.equal(v.meta.np.step, "between");
  assert.equal(v.meta.np.page, true, "the page is there to answer on, if it is asking");
  assert.equal(v.meta.np.sum, "The page as it is now");
  assert.doesNotMatch(v.meta.np.html, /finish this step/i);
  clock.skip(60_000);
  assert.ok((await h.view(cookie)).meta, "a site with a playbook is never ended as 'no sign-in page'");
});

// ---------------------------------------------------------------- 4. no link loops
test("a session that times out with nothing submitted: ONE plain line, no fresh link offered or made by itself; they can still ask for one", async () => {
  const entry = signin.genericEntry(LINK_LOGIN);
  const h = hosted({ entry, frames: [FORM_RAW] });
  const cookie = await h.start();
  assert.equal((await h.view(cookie)).meta.np.step, "email");
  clock.skip(config.remoteSigninSessionMs);
  // The session clock runs out, exactly as the service's own timer fires it.
  h.booked.find(t => t.ms === config.remoteSigninSessionMs && !t.cleared).fn();
  await new Promise(r => setTimeout(r, 20));
  const notes = timerNotes();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /ended after about 10 minutes \(the link timed out before they finished\) with nothing submitted on it/);
  assert.match(notes[0], /Do NOT make another sign-in link now/);
  assert.match(notes[0], /timed out before anything went through/);
  assert.doesNotMatch(notes[0], /offer a fresh link/, "the line that made the third link on 2026-11-12");
  assert.deepEqual(stepsOf().slice(-1), ["expired:timed_out"]);
  assert.equal(slog.recentAttempts().at(-1).outcome, "abandoned");
  // It is in the database, not in memory: a restart between the ending and the note forgets nothing.
  assert.equal(db.db.prepare("SELECT ended_how, ended_page FROM signin_pages WHERE conversation_id = ? AND site = 'link.com'").get(CONV).ended_how, "timed_out");

  const made = [];
  const seam = { publicUrl: pub, createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/y", good_for_minutes: 10, reachable_from_a_phone: true }; } };
  // The model, woken by that note (an event turn), asks for the same link by the bare name or by the page.
  for (const site of ["link.com", LINK_LOGIN]) {
    const auto = await runTool("signin_link", { site }, { conversationId: CONV, messages: [], kind: "event", ...seam });
    assert.equal(auto.not_sent_again, true, site);
    assert.match(auto.say, /timed out before anything went through/);
  }
  assert.equal(made.length, 0, "no second identical link");
  // Something changed (a different page, the right one): one retry, and only one.
  const other = await runTool("signin_link", { site: "https://app.link.com/signin" }, { conversationId: CONV, messages: [], kind: "event", ...seam });
  assert.equal(other.ok, true);
  assert.equal(made.length, 1);
  const third = await runTool("signin_link", { site: "https://app.link.com/auth" }, { conversationId: CONV, messages: [], kind: "event", ...seam });
  assert.equal(third.not_sent_again, true, "at most one retry");
  // They ask for one themselves: that is theirs to ask.
  const asked = await runTool("signin_link", { site: LINK_LOGIN }, { conversationId: CONV, messages: [], kind: "user", ...seam });
  assert.equal(asked.ok, true);
  assert.equal(made.length, 2);
  assert.equal(sp.lastNoProgress(CONV, entry), null, "their own request starts the count over");
});

test("the one retry is counted per run of endings, and a sign-in they ask for themselves starts over", async () => {
  const a = signin.genericEntry(LINK_LOGIN), b = signin.genericEntry("https://app.link.com/signin");
  sp.noteEnding(CONV, a, { how: "timed_out", state: "signed_out" });
  assert.deepEqual(sp.mayLinkAgain(CONV, b), { ok: true, retry: true }, "a different page: one retry");
  sp.markRetried(CONV, b);
  sp.noteEnding(CONV, b, { how: "timed_out", state: "signed_out" });
  assert.equal(sp.mayLinkAgain(CONV, a).ok, false, "no second retry, back to the first page or anywhere else");
  // More than an hour later a new run of endings has its own retry: the old one is not held against it.
  clock.skip(sp.NO_REPEAT_MS + 60_000);
  sp.noteEnding(CONV, a, { how: "timed_out", state: "signed_out" });
  assert.deepEqual(sp.mayLinkAgain(CONV, b), { ok: true, retry: true });

  // They ask to be signed in again and the emailed code is tried first: the hand-off link that
  // attempt may end in is part of what they asked for, so the older ending no longer refuses it.
  const seam = { publicUrl: pub, startEmailSignin: () => ({ ok: true, started: true }), createRemoteSignin: () => ({ ok: true, url: "https://reason.example/s/z", good_for_minutes: 10, reachable_from_a_phone: true }) };
  assert.equal((await runTool("signin_link", { site: LINK_LOGIN }, { conversationId: CONV, messages: [], kind: "event", ...seam })).not_sent_again, true);
  // A turn they did not start clears nothing.
  await runTool("signin_email", { site: LINK_LOGIN, email: EMAIL }, { conversationId: CONV, messages: [], kind: "event", ...seam });
  assert.ok(sp.lastNoProgress(CONV, a), "an event turn's own attempt is not their request");
  // Their own does.
  const started = await runTool("signin_email", { site: LINK_LOGIN, email: EMAIL }, { conversationId: CONV, messages: [], kind: "user", ...seam });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(sp.lastNoProgress(CONV, a), null);
  assert.equal((await runTool("signin_link", { site: LINK_LOGIN }, { conversationId: CONV, messages: [], kind: "event", ...seam })).ok, true, "the hand-off link of the attempt they asked for");
});

test("what counts as an ending without progress, and what wipes it", () => {
  const entry = signin.genericEntry(LINK_LOGIN);
  assert.deepEqual(sp.mayLinkAgain(CONV, entry), { ok: true });
  for (const how of ["timed_out", "cancelled", "link_expired", "no_signin_page"]) {
    sp.noteEnding(CONV, entry, { how, state: "signed_out" });
    assert.equal(sp.mayLinkAgain(CONV, entry).ok, false, how);
    assert.equal(sp.mayLinkAgain(CONV, entry, { asked: true }).ok, true, `${how}: their own ask`);
    // One person's ending is theirs alone: it stops nobody else's link, and nobody else can read it.
    assert.deepEqual(sp.mayLinkAgain("dm:fake:+14155559876", entry), { ok: true }, how);
    assert.equal(sp.lastNoProgress("dm:fake:+14155559876", entry), null, how);
  }
  // Old news stops nothing.
  clock.skip(sp.NO_REPEAT_MS + 1000);
  assert.deepEqual(sp.mayLinkAgain(CONV, entry), { ok: true });
  // A sign-in that worked, or a link they finished themselves, wipes it.
  sp.noteEnding(CONV, entry, { how: "timed_out", state: "unknown" });
  sp.noteEnding(CONV, entry, { how: "finished", state: "signed_in" });
  assert.deepEqual(sp.mayLinkAgain(CONV, entry), { ok: true });
});

test("a link nobody opened expires silently: no note, and no new one made by itself", async () => {
  const entry = signin.genericEntry(LINK_LOGIN);
  const h = hosted({ entry, frames: [FORM_RAW] });
  h.booked.find(t => t.ms === config.remoteSigninLinkTtlMs).fn();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(timerNotes(), [], "nothing to say about a link nobody opened");
  assert.deepEqual(stepsOf(), ["expired:never_opened"]);
  const auto = await runTool("signin_link", { site: LINK_LOGIN }, { conversationId: CONV, messages: [], kind: "event", publicUrl: pub, createRemoteSignin: () => { throw new Error("none made"); } });
  assert.equal(auto.not_sent_again, true);
});

// ---------------------------------------------------------------- 5. "signed in" needs positive evidence
test("on a site with no playbook, an absent sign-in prompt is 'unknown'; a log-out control or the sign-in page passing through is signed in", () => {
  const link = signin.genericEntry(LINK_LOGIN);
  const long = "Wallet ".repeat(20);
  const read = (over) => sites.readSignedInState(link, { url: "https://app.link.com/wallet", text: long, status: 200, ...over });
  // Its own sign-in form in view.
  assert.equal(read({ url: LINK_LOGIN, form: true }).state, "signed_out");
  assert.match(read({ url: LINK_LOGIN, form: true }).why, /still shows the sign-in form/);
  // A log-out or account control: positive.
  assert.deepEqual([read({ acct: "logout" }).state, read({ acct: "logout" }).evidence], ["signed_in", "logout"]);
  // Its own sign-in page passed the browser on to another page of its own, with nothing to sign in to on it.
  assert.deepEqual([read({}).state, read({}).evidence], ["signed_in", "passed_through"]);
  assert.equal(read({ text: `${long} Log in to continue` }).state, "signed_out", "the page it passed on to still asks");
  assert.equal(read({ url: "https://elsewhere.example/home" }).state, "unknown", "passed on to somebody else's page proves nothing");
  // Still on the sign-in page with no form drawn: nothing either way.
  assert.equal(read({ url: LINK_LOGIN }).state, "unknown");
  assert.equal(read({ url: LINK_LOGIN }).no_evidence, true);
  assert.equal(read({ status: 503 }).state, "unknown");

  // Only a bare name: the front page loading without the words "sign in" proved it before. Not now.
  const bare = signin.genericEntry("link.com");
  const home = sites.readSignedInState(bare, { url: "https://link.com/", text: "The fastest way to pay. ".repeat(10), status: 200 });
  assert.equal(home.state, "unknown", "this is what read as signed in until 2026-11-12");
  assert.equal(home.no_evidence, true);
  assert.match(home.why, /An absent prompt is not proof/);
  assert.equal(home.inferred, undefined);
  assert.equal(sites.readSignedInState(bare, { url: "https://link.com/", text: "Pay faster. Sign in. ".repeat(6), status: 200 }).state, "signed_out");
  // A site with a playbook reads exactly as it did.
  const amazon = sites.readSignedInState(sites.site("amazon"), { url: "https://www.amazon.com/gp/css/order-history", text: "Your Orders ".repeat(10), status: 200 });
  assert.deepEqual([amazon.state, amazon.inferred], ["signed_in", true]);
});

test("in a real browser: the probe asks the sign-in page — a form is signed out, a pass-through with a (hidden) log-out link is signed in, a marketing page is unknown", async () => {
  const INSIDE = `<body><h1>Wallet</h1><p>${"Your payment methods and addresses. ".repeat(6)}</p><div style="display:none"><a href="/logout">Log out</a></div></body>`;
  const entry = signin.genericEntry("https://app.pay-example.com/login");
  const out = await routed({ "app.pay-example.com/login": LOGIN_FORM });
  try {
    const r = await signin.probeSignedIn(out, entry.site, { entry, waitMs: 800 });
    assert.equal(r.state, "signed_out", JSON.stringify(r));
    assert.equal(r.checked_url, "https://app.pay-example.com/login", "asked on the page the sign-in is on");
  } finally { await out.close(); }

  // The way an app sends a signed-in browser on from its sign-in page: its own script, a moment after the page loads.
  const inn = await routed({ "app.pay-example.com/login": `<body><script>setTimeout(function(){location.replace("/wallet")}, 300)</script></body>`, "app.pay-example.com/wallet": INSIDE });
  try {
    const r = await signin.probeSignedIn(inn, entry.site, { entry, waitMs: 800 });
    assert.equal(r.state, "signed_in", JSON.stringify(r));
    assert.equal(r.evidence, "logout");
    assert.match(r.why, /log-out control/);
  } finally { await inn.close(); }

  const bare = signin.genericEntry("pay-example.com");
  const home = await routed({ "pay-example.com/": MARKETING });
  try {
    const r = await signin.probeSignedIn(home, bare.site, { entry: bare, waitMs: 500 });
    assert.equal(r.state, "unknown", JSON.stringify(r));
    assert.equal(r.no_evidence, true);
  } finally { await home.close(); }
});

test("a hosted session on such a site stops itself only on positive evidence: submitted, off the sign-in page, a log-out control there", async () => {
  const entry = signin.genericEntry(LINK_LOGIN);
  // A page with no sign-in words and no boxes, and nothing submitted: this ended sessions as "signed in" before.
  const plain = { ...INSIDE_RAW, acct: "" };
  const h = hosted({ entry, frames: [FORM_RAW, plain], said: { ok: true, state: "unknown", why: "nothing on it shows an account either", no_evidence: true } });
  const cookie = await h.start();
  await h.view(cookie);
  h.b.i = 1;
  clock.skip(9000);
  for (let i = 0; i < 3; i++) assert.ok((await h.view(cookie)).meta, "still running: an absent prompt ends nothing");
  // They tap "I'm signed in": the site is asked, and without evidence the answer is "unknown", said as that.
  await h.req("done", { method: "POST", cookie, body: {} });
  const note = timerNotes().at(-1);
  assert.match(note, /UNKNOWN/);
  assert.match(note, /"I can't tell", not as signed out/);
  assert.match(note, /Do not send another link on your own/);
  assert.equal(h.b.checks[0].opts.entry.signin_url, LINK_LOGIN, "the site is asked on the page the sign-in was on");

  // With evidence: typed, Enter, the page left the sign-in page, a log-out control on it.
  db.db.exec("DELETE FROM timers");
  const g = hosted({ entry, frames: [FORM_RAW, INSIDE_RAW], said: { ok: true, state: "signed_in", why: "the page at app.link.com has a log-out control, which only shows when signed in" } });
  const c2 = await g.start();
  await g.view(c2);
  await g.req("type", { method: "POST", cookie: c2, body: { text: "me@example.com" } });
  await g.req("key", { method: "POST", cookie: c2, body: { key: "Enter" } });
  g.b.i = 1;
  clock.skip(9000);
  await g.view(c2);
  assert.deepEqual((await g.view(c2)).json, { over: true, state: "signed_in" }, "two readings in a row, then the site is asked");
  assert.match(timerNotes().at(-1), /ARE signed in now/);
});

test("the emailed code ending on a page that proves nothing: said as 'I can't tell', and nothing is started again", async () => {
  const st = { step: "login" };
  const page = {
    url: () => LINK_LOGIN, context: () => ({ pages: () => [page] }), waitForTimeout: async () => {}, goto: async () => {},
    evaluate: async (fn, act) => {
      if (fn !== em.emailPage) return "Log in";
      let did = "";
      if (act === "mark_email" && st.step === "login") did = "email";
      if (act === "mark_code" && st.step === "code") did = "code";
      if (act === "submit" && st.step === "login") { st.step = "code"; did = "Continue"; }
      else if (act === "submit" && st.step === "code") { st.step = "done"; did = "Continue"; }
      return { did, email: st.step === "login", code: st.step === "code", split: false, password: false, route: false, instead: false, text: st.step === "code" ? "We sent a code" : "Log in", url: LINK_LOGIN };
    },
    fill: async () => {}, press: async () => {}, click: async () => {}, keyboard: { type: async () => {} },
  };
  const notes = [];
  let asked = null;
  const out = em.startEmailSignin({
    conversationId: CONV, entry: signin.genericEntry(LINK_LOGIN), email: EMAIL, settleMs: 1,
    launch: async () => ({ page, close: async () => {} }),
    gmail: async () => ({ connected: true, found: true, kind: "code", code: "482913" }),
    check: async (_p, _c, _s, opts) => { asked = opts; return { ok: true, state: "unknown", no_evidence: true, why: "nothing on it shows an account either" }; },
    note: (_c, t) => notes.push(t),
  });
  await out.run;
  assert.equal(asked.entry.signin_url, LINK_LOGIN, "asked on the page the attempt was on");
  assert.match(notes[0], /whether they are signed in is UNKNOWN/);
  assert.match(notes[0], /I can't tell whether it signed you in/);
  assert.match(notes[0], /Do not start another sign-in or send a link on your own/);
  assert.doesNotMatch(notes[0], /offer to try again/);
});

// ---------------------------------------------------------------- 6. a step log for texted links
test("one line per step of a hosted session: link opened, Start, the kind of page, submitted, signed in — a host and timings, nothing personal", async () => {
  const entry = signin.genericEntry(`${LINK_LOGIN}?email=me%40example.com`);
  const h = hosted({ entry, frames: [FORM_RAW, INSIDE_RAW], said: { ok: true, state: "signed_in", why: "the page has a log-out control" } });
  // A link preview fetches the page; nobody opened it.
  await h.req("", { headers: { "user-agent": "facebookexternalhit/1.1 Facebot Twitterbot/1.0" } });
  assert.deepEqual(stepsOf(), []);
  await h.req("", { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" } });
  await h.req("", { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" } });
  const cookie = await h.start();
  await h.view(cookie);
  await h.req("type", { method: "POST", cookie, body: { text: "me@example.com", at: { x: 0.5, y: 0.43 } } });
  await h.req("tap", { method: "POST", cookie, body: { x: 0.5, y: 0.43 } });
  await h.req("tap", { method: "POST", cookie, body: { x: 0.5, y: 0.8 } });
  h.b.i = 1;
  h.b.frames[1] = { ...INSIDE_RAW, url: "https://app.link.com/wallet?session=s3cr3t&email=me%40example.com" };
  clock.skip(9000);
  await h.view(cookie);
  await h.view(cookie);
  assert.deepEqual(stepsOf(), ["link_opened", "start_pressed", "page_kind:signin_form", "submitted:tap", "page_kind:not_signin_page", "signed_in"],
    "opened once however often the page is loaded; a tap on the box itself is not a submit");
  const lines = slog.recentSteps();
  const allowed = new Set(["signin_step", "step", "kind", "route", "page_host", "ms", "waited_ms", "at", "s", "detail"]);
  for (const l of lines) {
    for (const k of Object.keys(l)) assert.ok(allowed.has(k), `only the fixed fields: ${k}`);
    assert.equal(l.signin_step, "app.link.com");
    assert.equal(l.route, "password_link");
    assert.ok(Number.isFinite(l.ms) && l.ms >= 0);
    assert.match(l.s, /^[a-f0-9]{8}$/);
  }
  assert.equal(new Set(lines.map(l => l.s)).size, 1, "one tag for one session");
  assert.ok(!h.token.includes(lines[0].s) && lines[0].s !== h.token.slice(0, 8), "the tag is a hash, never a piece of the link");
  assert.deepEqual(lines.filter(l => l.page_host).map(l => l.page_host), ["app.link.com", "app.link.com"], "a host, never a path or a query");
  const all = JSON.stringify(lines);
  for (const never of ["me@example.com", "me%40example.com", "s3cr3t", "wallet", "login", CONV, OWNER, "?"]) assert.ok(!all.includes(never), `never in a step line: ${never}`);
});

test("logStep keeps only its own fields: a caller cannot put an address, a code, a number or a path in", () => {
  const line = slog.logStep(signin.genericEntry(LINK_LOGIN), { step: "page_kind", kind: "signin_form", pageUrl: "https://app.link.com/login/verify?code=482913&email=me@example.com", session: "not a tag", detail: "me@example.com +12025551234", email: EMAIL, code: "482913", startedAt: clock.now() - 5 });
  assert.deepEqual(Object.keys(line).sort(), ["at", "kind", "ms", "page_host", "route", "signin_step", "step"]);
  assert.equal(line.page_host, "app.link.com");
  assert.equal(slog.logStep(signin.genericEntry(LINK_LOGIN), { step: "made up", kind: "anything" }).step, "unknown");
  assert.equal(slog.logStep(signin.genericEntry(LINK_LOGIN), { step: "page_kind", kind: "not_signin" }).kind, "not_signin_page");
});
