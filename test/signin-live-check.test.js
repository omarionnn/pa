// Review of the sign-in probe fixes (#521): the live ask about a site's sign-in page, and the
// findings table every account shares.
//   - the ask is short, capped, asked once at a time, and goes through the network guard;
//   - a timeout, a name that does not resolve, a redirect loop, an outage (bare 503), a huge body or
//     a page that is not HTML is never written down as the site blocking anybody;
//   - a finding speaks only for the page it was seen on, so a person naming their own 403 page
//     cannot mark the site blocked for everybody; the table is capped and holds nothing personal;
//   - "too many attempts" is that address's limit, not the site's wall: never stored for the others.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-live-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";
process.env.REASON_TOKEN_KEY = "ab".repeat(32);

const em = await import("../src/signinemail.js");
const social = await import("../src/socialsignin.js");
const signin = await import("../src/signin.js");
const findings = await import("../src/sitefindings.js");
const slog = await import("../src/signinlog.js");
const db = await import("../src/db.js");
const tools = await import("../src/tools.js");
const { clock } = await import("../src/config.js");
const { chromium } = await import("playwright");

const DAY = 86_400_000;
const CONV = "dm:owner";
const EMAIL = "omari.private@example.com";
const SHOP = signin.genericEntry("https://shop-example.com/login");
const rows = () => db.db.prepare("SELECT * FROM site_findings").all();
const html = (status, body, headers = { "content-type": "text/html" }) => new Response(body, { status, headers });
const LOGIN = `<html><body><h1>Sign in</h1><form><input type="email" name="email"><button>Continue</button></form></body></html>`;
/** signinWall with a stubbed fetch: no test here touches the network. */
const liveWith = (fetchImpl, timeoutMs = 300) => (entry) => social.signinWall(entry, { fetchImpl, timeoutMs });

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); clock.reset(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  social._resetWalls();
  findings._resetFindings();
  em._resetJobs();
  slog._resetAttempts();
  db.db.exec("DELETE FROM accounts;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
});

test("the live ask for everybody is capped at a couple of seconds", () => {
  assert.ok(tools.SIGNIN_LIVE_CHECK_MS <= 3000);
});

test("no answer in time is 'unknown': the cap holds even when the fetch ignores its abort, and nothing is written down", async () => {
  let calls = 0;
  const hang = () => { calls++; return new Promise(() => {}); };
  const t0 = Date.now();
  const access = await findings.signinAccess(SHOP, { live: liveWith(hang, 80) });
  assert.ok(Date.now() - t0 < 1500, "the tool is not held up");
  assert.equal(access.state, "unknown");
  assert.equal(findings.isWall(access.wall), false);
  assert.match(access.wall.why, /could not be reached/);
  assert.deepEqual(rows(), []);
  // Asked again straight away: the miss is kept in memory for a moment, so a hung site is not hit per message.
  await findings.signinAccess(SHOP, { live: liveWith(hang, 80) });
  assert.equal(calls, 1);
});

test("a network error, a redirect loop, a bare 503, a 404 and a 2xx page with 'just a moment' in it are never a stored block", async () => {
  const cases = {
    "network error": async () => { throw new TypeError("fetch failed"); },
    "redirect loop": async (u) => new Response(null, { status: 302, headers: { location: `${u}x` } }),
    "outage": async () => html(503, "<h1>Service Unavailable</h1>"),
    "not found": async () => html(404, "<h1>Not found</h1>"),
    "loaded oddly": async () => html(200, "<body><p>Just a moment while we load your account…</p></body>"),
  };
  for (const [name, f] of Object.entries(cases)) {
    social._resetWalls();
    const access = await findings.signinAccess(SHOP, { live: liveWith(f) });
    assert.equal(access.state, "unknown", name);
    assert.equal(findings.isWall(access.wall), false, name);
  }
  assert.deepEqual(rows(), [], "nothing was written down");
});

test("a real wall is still a wall: 403, 429, and a challenge page served as an error", async () => {
  const cases = [
    async () => html(403, "<h1>Forbidden</h1>"),
    async () => html(429, "slow down"),
    async () => html(503, "<title>Just a moment...</title><p>Performing security verification</p>"),
  ];
  for (const f of cases) {
    social._resetWalls(); findings._resetFindings();
    const access = await findings.signinAccess(SHOP, { live: liveWith(f) });
    assert.equal(access.state, "blocked");
    assert.equal(access.kind, "walled");
    assert.equal(access.checked_live, true);
  }
  // Believed for a day, then asked again.
  clock.skip(DAY + 60_000);
  social._resetWalls();
  const later = await findings.signinAccess(SHOP, { live: liveWith(async () => html(200, LOGIN)) });
  assert.equal(later.state, "open");
});

test("a sign-in page that loads is 'open', also when it is not HTML; a huge body is cut off, not downloaded", async () => {
  const open = await findings.signinAccess(SHOP, { live: liveWith(async () => html(200, LOGIN)) });
  assert.equal(open.state, "open");

  social._resetWalls(); findings._resetFindings();
  const pdf = await findings.signinAccess(SHOP, { live: liveWith(async () => html(200, "%PDF-1.7 \u0000\u0001", { "content-type": "application/pdf" })) });
  assert.equal(pdf.state, "open");

  social._resetWalls(); findings._resetFindings();
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream({
    pull(c) { pulled++; c.enqueue(new TextEncoder().encode("a".repeat(100_000))); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const big = await social.signinWall(SHOP, { fetchImpl: async () => new Response(endless, { status: 200 }), timeoutMs: 2000 });
  assert.equal(big.in, true);
  assert.ok(pulled <= 6, `read stops at the cap (${pulled} chunks)`);
  assert.equal(cancelled, true, "the rest is not downloaded");
});

test("the guard: this machine's network and a redirect into it are never fetched, and that is not a block", async () => {
  const seen = [];
  const f = async (u) => { seen.push(u); return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } }); };
  const out = await social.signinWall(SHOP, { fetchImpl: f, timeoutMs: 300 });
  assert.equal(out.in, false);
  assert.equal(findings.isWall(out), false);
  assert.deepEqual(seen, ["https://shop-example.com/login"], "the redirect to the metadata address was not followed");
  for (const url of ["https://localhost/login", "https://127.0.0.1/login", "https://10.0.0.5/login", "http://shop-example.com/login"]) {
    const o = await social.signinWall({ site: "x", label: "X", signin_url: url }, { fetchImpl: f, timeoutMs: 300 });
    assert.equal(o.in, false);
    assert.equal(findings.isWall(o), false);
  }
  assert.equal(seen.length, 1);
});

test("asked once at a time: ten people asking about one page make one fetch", async () => {
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 40)); return html(200, LOGIN); };
  const all = await Promise.all(Array.from({ length: 10 }, () => social.signinWall(SHOP, { fetchImpl: slow, timeoutMs: 1000 })));
  assert.equal(calls, 1);
  assert.ok(all.every(o => o.in === true));
  await social.signinWall(SHOP, { fetchImpl: slow, timeoutMs: 1000 });
  assert.equal(calls, 1, "and the answer is kept");
});

test("a finding speaks for the page it was seen on: a person's own 403 page does not block the site for everybody", async () => {
  // Somebody names a page on the site that answers 403 (an admin path, their own page on a shared host).
  const theirs = signin.genericEntry("https://shop-example.com/admin/secret");
  assert.equal(theirs.site, SHOP.site, "the same site key");
  const a = await findings.signinAccess(theirs, { live: liveWith(async () => html(403, "Forbidden")) });
  assert.equal(a.state, "blocked");
  // Everybody else, naming the real sign-in page: not blocked, asked for themselves.
  assert.equal(findings.signinFinding(SHOP), null);
  assert.equal(findings.signinAccessStored(SHOP).state, "unknown");
  let asked = 0;
  const b = await findings.signinAccess(SHOP, { live: liveWith(async () => { asked++; return html(200, LOGIN); }) });
  assert.equal(asked, 1, "the other page's answer in memory is not reused either");
  assert.equal(b.state, "open");
  // A registry site's page is fixed by the registry, so its finding is shared as before.
  const dd = signin.anyEntryFor("doordash");
  assert.equal(findings.pageMark(dd), findings.pageMark(signin.anyEntryFor("doordash")));
});

test("the shared table holds nothing personal and cannot be filled without bound", () => {
  const cols = db.db.prepare("PRAGMA table_info(site_findings)").all().map(c => c.name).sort();
  assert.deepEqual(cols, ["kind", "page", "seen_at", "site", "status", "why"]);
  const e = signin.genericEntry("https://shop-example.com/login?email=omari.private@example.com&token=abc123");
  findings.recordFinding(e, { kind: "walled", status: 403, why: "its sign-in page answered 403" });
  const dump = JSON.stringify(rows());
  assert.ok(!/omari|abc123|login/.test(dump), "no address, no query, not even the page's path");
  assert.match(rows()[0].page, /^[0-9a-f]{16}$/);

  db.db.exec("BEGIN");
  for (let i = 0; i < findings.MAX_ROWS + 40; i++) findings.recordFinding({ site: `site${i}.example`, signin_url: `https://site${i}.example/` }, { kind: "open", status: 200 }, clock.now() + i);
  db.db.exec("COMMIT");
  assert.ok(rows().length <= findings.MAX_ROWS);
  assert.ok(findings.signinFinding({ site: `site${findings.MAX_ROWS + 39}.example`, signin_url: `https://site${findings.MAX_ROWS + 39}.example/` }), "the newest are the ones kept");
  // Old rows go with the next write.
  findings.recordFinding(SHOP, { kind: "open", status: 200 }, clock.now() + 30 * DAY);
  assert.equal(rows().length, 1);
});

test("a refusal after the email, seen on one person's run, shuts the emailed code for a day and not a week", () => {
  findings.recordFinding(SHOP, { kind: "refuses_after_email", why: "x" });
  assert.equal(findings.signinFinding(SHOP).fresh, true);
  assert.equal(findings.signinFinding(SHOP, clock.now() + DAY + 60_000).fresh, false);
});

const FORM = (says) => `<body><h1>Log in</h1>
  <input id="email" type="email" placeholder="Email address">
  <button onclick="document.getElementById('err').textContent=${JSON.stringify(says).replace(/"/g, "&quot;")}">Continue</button>
  <p id="err"></p></body>`;
const runEmail = async (says) => {
  const page = await browser.newPage();
  await page.setContent(FORM(says), { waitUntil: "domcontentloaded" });
  const notes = [];
  try {
    await em.startEmailSignin({
      conversationId: CONV, entry: SHOP, email: EMAIL, settleMs: 20,
      launch: async () => ({ page, close: async () => {} }),
      gmail: async () => { throw new Error("no mail is read"); },
      check: async () => { throw new Error("nothing to check"); },
      log: () => {}, note: (_c, t) => notes.push(t),
    }).run;
  } finally { await page.close(); }
  return notes;
};

test("'too many attempts' is that address's limit: said as a block to this person, never written down for everybody", async () => {
  const notes = await runEmail("Too many attempts. Please wait.");
  assert.match(notes[0], /NOT a wrong email/);
  assert.match(notes[0], /do NOT try another address/);
  assert.deepEqual(rows(), [], "nobody else is shut out by one person's rate limit");
  const line = slog.recentAttempts().at(-1);
  assert.equal(line.outcome, "blocked_by_site");
  assert.equal(line.detail, "rate_limited");
  assert.ok(!JSON.stringify(slog.recentAttempts()).includes(EMAIL));
});

test("a real 'no account with that email' is still a rejected email, and writes no finding", async () => {
  const notes = await runEmail("We couldn't find an account with that email. Try again.");
  assert.match(notes[0], /would not take that email/);
  assert.match(notes[0], /which email their Shop-example account uses/);
  assert.deepEqual(rows(), []);
  assert.equal(slog.recentAttempts().at(-1).outcome, "email_rejected");
});

test("signin_link, for everybody (no flag): a site whose stubbed sign-in page loads is not blocked; DoorDash is, from the record alone", async () => {
  delete process.env.REASON_SOCIAL_SIGNIN;
  let fetched = 0;
  const ctx = { conversationId: CONV, messages: [], signinWall: liveWith(async () => { fetched++; return html(200, LOGIN); }), publicUrl: async () => ({ ok: true }) };
  const ok = await tools.runTool("signin_link", { site: "fandango" }, ctx);
  assert.notEqual(ok.blocked, true);
  assert.equal(fetched, 1, "asked once");
  assert.equal(findings.signinAccessStored(signin.anyEntryFor("fandango")).state, "open");
  const dd = await tools.runTool("signin_link", { site: "doordash" }, { ...ctx, signinWall: async () => { throw new Error("a fresh wall is not asked again"); } });
  assert.equal(dd.ok, false);
  assert.equal(dd.blocked, true);
  assert.match(dd.say, /DoorDash blocks automated sign-in/);
  // A site that times out is not blocked either: the link is still made.
  const slow = await tools.runTool("signin_link", { site: "amazon" }, { ...ctx, signinWall: liveWith(() => new Promise(() => {}), 60) });
  assert.notEqual(slow.blocked, true);
  assert.equal(findings.signinFinding(signin.anyEntryFor("amazon")), null);
});
