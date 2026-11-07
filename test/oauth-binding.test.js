// Security lead 1 (run-1 NEEDS-VALIDATION §1): an OAuth connect link must only finish in the browser
// of the person whose thread asked for it.
//
// Before this, the `state` in a connect link was bound to the conversation that minted it and to
// nothing else. Anyone who asked Reason for a GitHub / Google / Spotify / X / Uber link in their own
// thread could forward it, and whoever agreed on the provider's page attached THEIR account to the
// sender's Reason. The callbacks read code/state off the query string and saved the tokens under the
// minting conversation, with no cookie, session or initiator check.
//
// Pinned here, through the real HTTP server and the fake providers:
//   1. a callback from a browser that has not proved it is the minting conversation's connects
//      nothing, for all five providers — including a browser signed in to a DIFFERENT Reason person;
//   2. the texted link opens Reason's own start page first: a browser already signed in as that
//      conversation goes straight on to the provider, any other browser gets the six-digit code gate,
//      and the code is texted to the thread that asked for the link (never on a GET);
//   3. after the code, that browser goes on to the provider and its callback connects.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGitHub } from "./fixture-github.js";
import { startSpotify } from "./fixture-spotify.js";
import { startX } from "./fixture-x.js";
import { startUber } from "./fixture-uber.js";
import { startGoogle } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-oauth-binding-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "45".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";

const { createServer } = await import("../src/http.js");
const github = await import("../src/github.js");
const spotify = await import("../src/spotify.js");
const x = await import("../src/x.js");
const uber = await import("../src/uber.js");
const google = await import("../src/google.js");
const db = await import("../src/db.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { config, clock } = await import("../src/config.js");

// The one who asks Reason for a link and forwards it, and the one they forward it to.
const ASKER = "dm:fake:+13475550001";
const OTHER = "dm:fake:+13475550002";

const fakes = {};
let server, base, runtime;
const texted = [];

before(async () => {
  fakes.github = await startGitHub();
  fakes.spotify = await startSpotify();
  fakes.x = await startX();
  fakes.uber = await startUber();
  fakes.google = await startGoogle();
  Object.assign(config, {
    publicUrl: "",
    githubClientId: "gh-client", githubClientSecret: "gh-secret", githubApiBase: fakes.github.url, githubBase: fakes.github.url,
    spotifyClientId: "sp-client", spotifyClientSecret: "sp-secret", spotifyApiBase: fakes.spotify.url, spotifyAccountsBase: fakes.spotify.url,
    xClientId: "x-client", xClientSecret: "x-secret", xApiBase: fakes.x.url, xAuthBase: fakes.x.url,
    uberClientId: "ub-client", uberClientSecret: "ub-secret", uberAuthBase: fakes.uber.base, uberApiBase: fakes.uber.base,
    googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret",
    googleOauthBase: fakes.google.url, googleAccountsBase: fakes.google.url, googleGmailBase: fakes.google.url, googleCalendarBase: fakes.google.url,
  });
  runtime = new Runtime({ log: () => {}, runTurn: async () => "ok" });
  const router = new Router({ runtime, log: () => {} });
  router.runtime = runtime;
  // Every text Reason sends from these routes, kept here instead of going anywhere.
  runtime._tell = async (conversationId, text) => { texted.push({ conversationId, text }); return { ok: true }; };
  runtime.say = (conversationId, text) => { texted.push({ conversationId, text }); };
  server = createServer({ router, runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  for (const f of Object.values(fakes)) await f.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  texted.length = 0;
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM page_sessions; DELETE FROM page_codes;");
  db.upsertAccount({ conversationId: ASKER, channel: "fake", address: "+13475550001", name: "Asker", isOperator: false });
  db.upsertAccount({ conversationId: OTHER, channel: "fake", address: "+13475550002", name: "Other", isOperator: false });
});

/** One request to the real server; node:http so nothing follows a redirect for us. */
function hit(pathAndQuery, { method = "GET", cookie = "", body = null, extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extra, ...(cookie ? { cookie } : {}), ...(body != null ? { "content-type": "application/x-www-form-urlencoded" } : {}) };
    const r = request(`${base}${pathAndQuery}`, { method, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on("error", reject);
    r.end(body ?? undefined);
  });
}
const pathOf = (u) => { const p = new URL(u); return p.pathname + p.search; };
const stateOf = (u) => new URL(u).searchParams.get("state");
const sessionCookie = (res) => [].concat(res.headers["set-cookie"] ?? []).map(c => /^reason_page=([^;]+)/.exec(c)?.[1]).find(Boolean) ?? null;
/** A browser that is already signed in to Reason as `conversationId` (a page / Web sign-in earlier). */
function signedInAs(conversationId) {
  const token = `tok-${conversationId}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession("web", token, { conversationId });
  return `reason_page=${token}`;
}

const PROVIDERS = [
  ["github", () => github.authorizeUrl(ASKER), github.REDIRECT_PATH],
  ["spotify", () => spotify.authorizeUrl(ASKER), spotify.REDIRECT_PATH],
  ["x", () => x.authorizeUrl(ASKER), x.REDIRECT_PATH],
  ["uber", () => uber.authorizeUrl(ASKER), uber.REDIRECT_PATH],
  ["google", () => google.authorizeUrl(ASKER), google.REDIRECT_PATH],
];

for (const [provider, mint, callbackPath] of PROVIDERS) {
  test(`${provider}: a forwarded link finished in someone else's browser attaches nothing to the asker`, async () => {
    // The person it was forwarded to agrees on the provider's page; the provider sends their browser
    // back. Once with no Reason cookie at all, once signed in to Reason as themselves — a fresh link
    // each time, so the second is not refused merely for being spent.
    for (const cookie of ["", signedInAs(OTHER)]) {
      const link = mint();
      assert.equal(link.ok, true, JSON.stringify(link));
      const state = stateOf(link.url);
      assert.ok(state, "the link carries its state");
      const back = await hit(`${callbackPath}?code=good-code&state=${encodeURIComponent(state)}`, { cookie });
      assert.equal(back.status, 400, `${provider} callback should refuse (cookie: ${cookie ? "other person" : "none"})`);
      assert.match(back.text, /only finishes in the browser of the person/, `${provider}: refused for the browser, not for some other reason`);
      assert.equal(db.listOauthTokens(ASKER, provider).length, 0, `${provider}: no token may land on the asker's thread`);
      assert.equal(db.listOauthTokens(OTHER, provider).length, 0);
      assert.equal(db.liveAccount(ASKER, provider), null);
    }
    assert.equal(texted.filter(t => t.conversationId === ASKER).length, 0, "nothing is texted into the asker's thread about someone else's account");
  });
}

test("github: the asker's own signed-in browser goes straight through the start page, and connects", async () => {
  const link = github.authorizeUrl(ASKER);
  const cookie = signedInAs(ASKER);
  const start = await hit(pathOf(link.url), { cookie });
  assert.equal(start.status, 302, start.text.slice(0, 200));
  const to = start.headers.location;
  assert.ok(to.startsWith(`${fakes.github.url}/login/oauth/authorize?`), to);
  assert.equal(stateOf(to), stateOf(link.url));
  const back = await hit(`${github.REDIRECT_PATH}?code=good-code&state=${encodeURIComponent(stateOf(to))}`, { cookie });
  assert.equal(back.status, 200, back.text.slice(0, 300));
  assert.equal(db.listOauthTokens(ASKER, "github").length, 1);
  assert.equal(texted.length, 0, "a proved browser is never asked for a code");
});

test("github: a new browser gets the code gate; the code goes to the asker's thread; then it connects", async () => {
  const link = github.authorizeUrl(ASKER);
  const path = pathOf(link.url);

  // A GET (or a link preview) shows the gate and texts nothing.
  const gate = await hit(path);
  assert.equal(gate.status, 401);
  assert.match(gate.text, /Text me the code/);
  assert.match(gate.text, /GitHub/);
  assert.equal(texted.length, 0, "a GET never texts");
  assert.doesNotMatch(gate.text, /login\/oauth\/authorize/, "the gate does not hand out the provider's link");

  // A wrong code does not open it.
  const wrong = await hit(path, { method: "POST", body: "code=000000" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.location, undefined);

  // "Text me the code": the code goes to the thread that asked for the link, nowhere else.
  const sent = await hit(path, { method: "POST", body: "send=1" });
  assert.equal(sent.status, 200);
  assert.equal(texted.length, 1);
  assert.equal(texted[0].conversationId, ASKER);
  assert.match(texted[0].text, /GitHub/);
  const code = /\b(\d{6})\b/.exec(texted[0].text)[1];

  const opened = await hit(path, { method: "POST", body: `code=${code}` });
  assert.equal(opened.status, 303, opened.text.slice(0, 200));
  assert.ok(opened.headers.location.startsWith(`${fakes.github.url}/login/oauth/authorize?`));
  const token = sessionCookie(opened);
  assert.ok(token, "the browser is now signed in as the asker");
  assert.equal(db.pageSessionOwner(token, 1e12), ASKER);

  const back = await hit(`${github.REDIRECT_PATH}?code=good-code&state=${encodeURIComponent(stateOf(link.url))}`, { cookie: `reason_page=${token}` });
  assert.equal(back.status, 200, back.text.slice(0, 300));
  assert.equal(db.listOauthTokens(ASKER, "github").length, 1);
});

test("the gate's form only works from the gate itself: a page elsewhere cannot post the asker's code from a victim's browser", async () => {
  // The asker asks for a link, has the code texted to themselves, and plants an auto-submitting
  // form on their own site. The victim's browser posting it must not be signed in as the asker.
  const link = github.authorizeUrl(ASKER);
  const path = pathOf(link.url);
  await hit(path, { method: "POST", body: "send=1" });
  const code = /\b(\d{6})\b/.exec(texted[0].text)[1];
  texted.length = 0;
  for (const extra of [
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const r = await hit(path, { method: "POST", body: `code=${code}`, extra });
    assert.equal(r.status, 403, JSON.stringify(extra));
    assert.equal(r.headers.location, undefined);
    assert.equal(sessionCookie(r), null, "no session handed to a cross-site post");
    const s = await hit(path, { method: "POST", body: "send=1", extra });
    assert.equal(s.status, 403);
  }
  assert.equal(texted.length, 0, "a cross-site post texts nothing either");
  // The same code from the gate's own page still opens it.
  const ok = await hit(path, { method: "POST", body: `code=${code}`, extra: { origin: base, "sec-fetch-site": "same-origin" } });
  assert.equal(ok.status, 303, ok.text.slice(0, 200));
  assert.ok(sessionCookie(ok));
});

test("a browser signed in as someone else is not let through, and gets the gate rather than the provider", async () => {
  const link = spotify.authorizeUrl(ASKER);
  const start = await hit(pathOf(link.url), { cookie: signedInAs(OTHER) });
  assert.equal(start.status, 401);
  assert.equal(start.headers.location, undefined);
  assert.match(start.text, /Text me the code/);
});

test("a start link that was used, replaced or never existed opens nothing and texts nothing", async () => {
  const first = github.authorizeUrl(ASKER);
  github.authorizeUrl(ASKER); // replaces the first one
  for (const path of [pathOf(first.url), "/connect/start?state=nonsense"]) {
    const r = await hit(path);
    assert.equal(r.status, 400, path);
    assert.equal(r.headers.location, undefined);
    const s = await hit(path, { method: "POST", body: "send=1" });
    assert.equal(s.status, 400);
  }
  assert.equal(texted.length, 0);
});

test("the user declining on the provider's page is still reported, without needing the browser proved", async () => {
  const link = github.authorizeUrl(ASKER);
  const back = await hit(`${github.REDIRECT_PATH}?error=access_denied&state=${encodeURIComponent(stateOf(link.url))}`);
  assert.equal(back.status, 400);
  assert.equal(db.listOauthTokens(ASKER, "github").length, 0);
});
