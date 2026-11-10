// Uber, the first site for the social sign-in (owner's scope addition, 2026-11-10): most people's
// Uber is a Google sign-in.
//
//   1. **The button is found on an Uber sign-in page.** test/fixtures/uber-login.html is a hand-made
//      stand-in for auth.uber.com/login (the real page bot-walls Reason's browser — docs/unverified.md);
//      the real finder, in real Chromium, presses "Continue with Google" and nothing else: not the
//      phone box, not the hidden copy, not the footer's "Google Privacy Policy" link.
//   2. **The wall is asked live.** `signinWall` reads the sign-in page from here: Cloudflare's "Just a
//      moment" / 403 is a wall (kept 30 s); a page that loads says which buttons it offers (kept 10 min).
//   3. **The Uber connect card is the Uber route (owner, 2026-11-10, reversing "Uber first").**
//      `uber_connect` makes the card whatever the flag, the wall or a saved login says; the rules
//      never ask for a Google login for Uber.
//   4. **signin_link for Uber with provider google** (only if asked for) asks the wall instead of
//      trusting the dated finding: blocked → said plainly with the connect card named instead.
//   5. **The web setup's Uber card** is exactly as before the social sign-in: offered when Uber's
//      app takes a connect, whatever the flag or a saved Google login says.
// No real Uber, Google or network is touched: every page is the fixture or a fake, every fetch a fake.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-social-uber-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_WEB_SETUP = "on";
process.env.REASON_TOKEN_KEY = "55".repeat(32);
process.env.REASON_SHOP_CONNECT = "on";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
process.env.UBER_CLIENT_ID = "uber-client-id";
process.env.UBER_CLIENT_SECRET = "uber-client-secret";
delete process.env.REASON_ONBOARDING;
delete process.env.REASON_SOCIAL_SIGNIN;

const social = await import("../src/socialsignin.js");
const sites = await import("../src/sites.js");
const signin = await import("../src/signin.js");
const ws = await import("../src/websetup.js");
const uber = await import("../src/uber.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;
const entry = signin.entryFor("uber");
const FIXTURE = readFileSync(new URL("./fixtures/uber-login.html", import.meta.url), "utf8");

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  social._resetWalls();
  uber._resetReady();
  ws.resetLimits();
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM threads; DELETE FROM connected_accounts; DELETE FROM action_ledger; DELETE FROM social_declines; DELETE FROM web_setups; DELETE FROM oauth_tokens; DELETE FROM oauth_states;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  config.publicUrl = "https://reason.example.test";
  config.uberClientId = "uber-client-id";
  config.uberClientSecret = "uber-client-secret";
  process.env.REASON_WEB_SETUP = "on";
  process.env.REASON_SOCIAL_SIGNIN = "owner";
});

const call = (name, input, conversationId = CONV, ctx = {}) => runTool(name, input, { conversationId, messages: [], ...ctx });
const html = (body, status = 200) => async () => ({ status, text: async () => body });
const WALLED = html(`<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform">Performing security verification</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>`, 403);
const OPEN = html(FIXTURE, 200);
const wallIn = async () => ({ in: true, status: 200, why: "", providers_offered: ["google", "apple"], checked_at: clock.now() });
const wallUp = async () => ({ in: false, status: 403, why: "Uber's sign-in page answers Reason's browser from here with a bot check (HTTP 403, \"Just a moment\"), so a link would show the wall and nothing else.", providers_offered: [], checked_at: clock.now() });

// ---------- 1. the button, on an Uber sign-in page, in a real browser ----------

test("the finder presses Continue with Google on an Uber sign-in page and nothing else", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(FIXTURE, { waitUntil: "domcontentloaded" });
    const g = await social.clickProviderButton(page, "google", { settleMs: 0 });
    assert.match(g.pressed, /^g? ?continue with google/, "the button's own words (its icon letter and data-provider ride along)");
    assert.equal(await page.evaluate(() => window.__pressed), "google", "the visible button, not the hidden copy");
    await page.evaluate(() => { window.__pressed = ""; });
    const a = await social.clickProviderButton(page, "apple", { settleMs: 0 });
    assert.match(a.pressed, /continue with apple/);
    assert.equal(await page.evaluate(() => window.__pressed), "apple");
    await page.evaluate(() => { window.__pressed = ""; });
    assert.deepEqual(await social.clickProviderButton(page, "facebook", { settleMs: 0 }), { pressed: "" }, "no Facebook on Uber's page");
    assert.equal(await page.evaluate(() => window.__pressed), "", "nothing pressed for a button the page has not got");
    assert.equal(await page.evaluate(() => document.getElementById("PHONE_NUMBER_or_EMAIL_ADDRESS").value), "", "the phone box is never touched");
    // What the page offers, read the way signin_provider infer reads it.
    const text = await page.evaluate(() => document.body.innerText);
    assert.deepEqual(social.providersOffered(text), ["google", "apple"], "the footer's Google privacy line is not a button");
  } finally { await page.close(); }
});

test("Uber's hosts cover the rider site and the sign-in host; the rules send Uber to the connect card, never a Google ask", () => {
  assert.deepEqual(entry.hosts, ["uber.com", "m.uber.com", "riders.uber.com", "auth.uber.com"]);
  assert.deepEqual(social.UBER_SIGNIN_HOSTS, entry.hosts);
  assert.equal(sites.site("uber").social, undefined, "no provider hint for Uber");
  assert.equal(entry.signin_url, "https://auth.uber.com/login");
  assert.doesNotMatch(social.RULES, /UBER FIRST/);
  assert.doesNotMatch(social.RULES, /Uber signs in through your Google account/);
  assert.doesNotMatch(social.RULES, /site "uber" and provider "google"/);
  assert.match(social.RULES, /UBER: never ask for their Google \(or any provider\) login for Uber/);
  assert.match(social.RULES, /Uber connect card \(uber_connect\), only when they ask to connect it; a ride is uber_link/);
  assert.equal(social.uberSocialPath, undefined);
  assert.equal(social.uberRoute, undefined);
  assert.equal(social.UBER_ASK, undefined);
});

// ---------- 2. the wall, asked live ----------

test("signinWall: a bot check is a wall (kept 30 s); a page that loads names its buttons (kept 10 min)", async () => {
  let asked = 0;
  const count = (f) => async (...a) => { asked++; return f(...a); };
  const up = await social.signinWall(entry, { fetchImpl: count(WALLED) });
  assert.equal(up.in, false);
  assert.equal(up.status, 403);
  assert.match(up.why, /bot check \(HTTP 403, "Just a moment"\)/);
  assert.deepEqual(social.wallCached("uber"), up);
  await social.signinWall(entry, { fetchImpl: count(WALLED) });
  assert.equal(asked, 1, "a wall is kept thirty seconds");
  clock.skip(31_000);
  assert.equal(social.wallCached("uber"), null, "and then asked again");
  const open = await social.signinWall(entry, { fetchImpl: count(OPEN) });
  assert.equal(asked, 2);
  assert.equal(open.in, true);
  assert.deepEqual(open.providers_offered, ["google", "apple"]);
  clock.skip(9 * 60_000);
  await social.signinWall(entry, { fetchImpl: count(WALLED) });
  assert.equal(asked, 2, "an open page is kept ten minutes");
  clock.skip(2 * 60_000);
  assert.equal((await social.signinWall(entry, { fetchImpl: count(WALLED) })).in, false);
  social._resetWalls();
  const dead = await social.signinWall(entry, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(dead.in, false);
  assert.match(dead.why, /could not be reached from here: ECONNRESET/);
  assert.equal((await social.signinWall({ site: "x", label: "X" })).why, "the site has no sign-in page on record");
});

// ---------- 3. which way into Uber ----------

// ---------- 4. signin_link for Uber with provider google ----------

test("signin_link uber + google: the wall is asked; up → said plainly with the card named instead, no link; down → the link", async () => {
  const made = [];
  const seam = { createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example.test/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; } };
  const up = await call("signin_link", { site: "uber", provider: "google" }, CONV, { ...seam, signinWall: wallUp });
  assert.equal(up.ok, false);
  assert.equal(up.blocked, true);
  assert.equal(up.checked_live, true);
  assert.equal(up.provider, "google");
  assert.match(up.error, /Google button cannot be pressed for them and no link is made/);
  assert.match(up.say, /bot check before the Google button even loads/);
  assert.match(up.instead, /Uber is the Uber connect card: uber_connect with they_asked_to_connect true/);
  assert.equal(up.fallback, undefined);
  assert.match(up.handoff, /uber_link/);
  assert.deepEqual(made, [], "no link while the wall is up");

  const down = await call("signin_link", { site: "uber", provider: "google" }, CONV, { ...seam, signinWall: wallIn });
  assert.equal(down.ok, true);
  assert.equal(down.provider, "google");
  assert.equal(made[0].provider, "google");
  assert.equal(made[0].entry.site, "uber");
  assert.match(down.expect, /Google will ping your phone\. Tap Yes\./);
  assert.match(down.say, /Google button pressed/);

  // Without a provider, or for someone the flag does not reach, the dated finding answers as before
  // and the wall is not asked.
  let asked = 0;
  const counting = async () => { asked++; return wallIn(); };
  const plain = await call("signin_link", { site: "uber" }, CONV, { ...seam, signinWall: counting });
  assert.equal(plain.ok, false);
  assert.equal(plain.checked_live, undefined);
  assert.match(plain.say, /Uber won't let my browser onto its sign-in page/);
  const theirs = await call("signin_link", { site: "uber", provider: "google" }, THEIRS, { ...seam, signinWall: counting });
  assert.equal(theirs.ok, false);
  assert.equal(theirs.checked_live, undefined);
  assert.equal(asked, 0);
  assert.equal(made.length, 1);

  // signin_open goes the same way.
  const opened = [];
  const w = await call("signin_open", { site: "uber", provider: "google" }, CONV, { signinWall: wallUp, openSigninWindow: async (a) => { opened.push(a); return { ok: true }; } });
  assert.equal(w.ok, false);
  assert.equal(w.checked_live, true);
  assert.deepEqual(opened, []);
});

// ---------- 5. the connect card is the Uber route ----------

test("uber_connect: the card, whatever the flag, the wall or a saved Google-backed Uber login says", async () => {
  let asked = 0;
  const counting = async () => { asked++; return wallIn(); };
  // Flag on for the owner, Uber's page open: still the card, and the wall is never asked.
  let out = await call("uber_connect", { they_asked_to_connect: true }, CONV, { signinWall: counting });
  assert.equal(out.ok, true);
  assert.equal(out.superseded, undefined);
  assert.equal(out.ask, undefined);
  assert.match(out.url, /\/connect\/start\?state=/);
  // A Google-backed Uber login saved: still the card.
  db.recordSiteSignin(CONV, "uber", { state: "signed_in", evidence: "t", provider: "google" });
  out = await call("uber_connect", { they_asked_to_connect: true }, CONV, { signinWall: counting });
  assert.equal(out.ok, true);
  assert.equal(out.superseded, undefined);
  // A ride is still not a connect.
  out = await call("uber_connect", { they_asked_to_connect: false }, CONV);
  assert.equal(out.blocked, "not_for_rides");
  // Flag off: the same card.
  delete process.env.REASON_SOCIAL_SIGNIN;
  out = await call("uber_connect", { they_asked_to_connect: true }, CONV, { signinWall: counting });
  assert.equal(out.ok, true);
  assert.equal(asked, 0);
});

// ---------- 6. the web setup's Uber card ----------

const cookieOf = (res) => /rs_setup=([^;]+)/.exec(String(res.headers["Set-Cookie"] ?? ""))?.[1];
async function api(method, path, { cookie = "", body = null, ip = "1.2.3.4", ...seams } = {}) {
  const headers = { cookie: cookie ? `rs_setup=${cookie}` : "", host: "reason.example.test" };
  const res = await ws.request({ method, path, headers, remoteAddress: ip, readBody: async () => body ? JSON.stringify(body) : "", ...seams });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}
async function newSetup() {
  const made = await api("POST", "/api/new");
  const cookie = cookieOf(made);
  await api("POST", `/api/${made.json.id}`, { cookie, body: { user: "kofi", reasonName: "jarvis" } });
  return { ...made.json, cookie, c: `websetup:${made.json.id}` };
}
const ready = async () => ({ ready: true, why: "" });

test("web setup: Uber is off the page (11-10) whatever the social sign-in flag says: uber:false, the connect refused, and a saved Google-backed Uber login is not a connection", async () => {
  process.env.REASON_SOCIAL_SIGNIN = "on";
  const caps = (await api("GET", "/api/capabilities", { uberReady: ready })).json;
  assert.equal(caps.uber, false);
  assert.equal(caps.uber_via, undefined);
  const s = await newSetup();
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.uber, { state: "none", step: 1, of: 3 });
  const asked = [];
  const uberLink = (c) => { asked.push(c); return { ok: true, url: "https://app.example/connect/start?state=st" }; };
  const no = await api("POST", `/api/${s.id}/connect/uber`, { cookie: s.cookie, uberReady: ready, uberLink });
  assert.equal(no.status, 404);
  assert.deepEqual(no.json, { ok: false, why: "unavailable" });
  assert.deepEqual(asked, [], "nothing made");
  db.recordSiteSignin(s.c, "uber", { state: "signed_in", evidence: "t", provider: "google" });
  const after = (await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.uber;
  assert.notEqual(after.state, "connected");
  assert.equal(after.via, undefined);
});
