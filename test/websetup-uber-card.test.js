// The web setup's Uber and card connects (src/websetup.js, 11-10): both bound to the setup's stand-in,
// both moved to the account on the claim, both let go when the setup expires.
//
//   Uber: the card always shows; a connect is handed out only when Uber's own app takes this server's
//     return address (uber.connectReady reads Uber's authorize answer), else the page is told "not ready"
//     and nothing is made. Uber's return goes back to the connect screen, never a thread.
//   Card: Crossmint's own form on /web/connect/<token> (no card number ever on the setup page); the saved
//     card is the stand-in's at Crossmint, so the claim hands that Crossmint user to the account; the
//     setup never texts anyone; an account that already has Crossmint state keeps its own.
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-websetup-uc-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
delete process.env.REASON_ONBOARDING;
process.env.REASON_WEB_SETUP = "on";
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_SHOP_CONNECT = "on";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
process.env.UBER_CLIENT_ID = "uber-client-id";
process.env.UBER_CLIENT_SECRET = "uber-client-secret";
process.env.REASON_SETUP_ORIGINS = "https://start--staging.example";

const ws = await import("../src/websetup.js");
const store = await import("../src/websetupstore.js");
const shop = await import("../src/shopconnect.js");
const uber = await import("../src/uber.js");
const { connectRequest } = await import("../src/pages/webconnect.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415558${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;
const q = (sql) => db.db.prepare(sql);

// ---------- a fake Crossmint ----------
let calls, said;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeCrossmint(url, init = {}) {
  const p = new URL(url).pathname;
  const method = init.method ?? "GET";
  const auth = String(init.headers?.Authorization ?? "");
  const sub = auth ? JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString()).sub : init.headers?.["x-crossmint-user-id"];
  calls.push({ method, path: p, sub, body: init.body ? JSON.parse(init.body) : undefined });
  if (/order-intent-registration$/.test(p) && method === "PUT") return reply(400, { error: { code: "CONSUMER_EMAIL_REQUIRED" } });
  if (/^\/api\/2026-09-16\/payment-methods\/[^/]+$/.test(p) && method === "DELETE") return reply(204);
  return reply(404, { message: "no route" });
}
before(() => { shop._setFetch(fakeCrossmint); shop.attach({ say: (c, t) => said.push({ c, t }), base: "https://heyreason.example/web/connect" }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  ws.resetLimits();
  uber._resetReady();
  calls = []; said = [];
  process.env.REASON_WEB_SETUP = "on";
  process.env.REASON_SHOP_CONNECT = "on";
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.publicUrl = "https://reason.example.test";
  config.uberClientId = "uber-client-id";
  config.uberClientSecret = "uber-client-secret";
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM web_setups; DELETE FROM oauth_tokens; DELETE FROM connected_accounts; DELETE FROM oauth_states; DELETE FROM shop_cards; DELETE FROM shop_links; DELETE FROM shop_profiles; DELETE FROM shop_crossmint_subjects; DELETE FROM shop_shipping;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function harness() {
  const runtime = new Runtime({ runTurn: async () => "on it" });
  const ask = async () => ({ error: "no stated read" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {}, amazonLink: async () => "https://x.test/s/link" } });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel };
}
const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });

const cookieOf = (res) => /rs_setup=([^;]+)/.exec(String(res.headers["Set-Cookie"] ?? ""))?.[1];
async function api(method, path, { cookie = "", body = null, ip = "1.2.3.4", origin = "", ...seams } = {}) {
  const headers = { cookie: cookie ? `rs_setup=${cookie}` : "", host: "reason.example.test", ...(origin ? { origin } : {}) };
  const res = await ws.request({ method, path, headers, remoteAddress: ip, readBody: async () => body ? JSON.stringify(body) : "", ...seams });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}
async function newSetup({ origin = "" } = {}) {
  const made = await api("POST", "/api/new", { origin });
  const cookie = cookieOf(made);
  await api("POST", `/api/${made.json.id}`, { cookie, body: { user: "kofi", reasonName: "jarvis" }, origin });
  return { ...made.json, cookie, c: `websetup:${made.json.id}` };
}
const ready = async () => ({ ready: true, why: "" });
const notReady = async () => ({ ready: false, why: "redirect_uri_not_registered" });
/** A card saved through the setup's own card link, the way the /web/connect page posts it. */
async function saveSetupCard(s, last4 = "4242") {
  const out = await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie });
  const token = new URL(out.json.url).pathname.split("/").pop();
  const saved = await shop.saveCard(token, { paymentMethodId: `pm_${last4}`, brand: "visa", last4 });
  return { token, saved };
}

// ---------- Uber ----------

test("Uber's readiness is read off Uber's own authorize answer: a bad return address is 'not registered', cached", async () => {
  let asked = 0;
  const to = (location) => async (url, init) => {
    asked++;
    assert.equal(init.redirect, "manual", "the redirect is read, never followed");
    assert.match(url, /\/oauth\/v2\/authorize\?client_id=uber-client-id&response_type=code&redirect_uri=https%3A%2F%2Freason\.example\.test%2Fuber%2Fcallback/);
    return { status: 302, headers: new Headers({ location }) };
  };
  assert.deepEqual(await uber.connectReady({ fetchImpl: to("https://auth.uber.com/oauth/errors?error=invalid_request&error_description=not_a_valid_redirect_uri_for_the_given_client") }),
    { ready: false, why: "redirect_uri_not_registered", redirect_uri: "https://reason.example.test/uber/callback" });
  await uber.connectReady({ fetchImpl: to("https://auth.uber.com/v2/?next_url=x") });
  assert.equal(asked, 1, "a definite answer is kept ten minutes");
  uber._resetReady();
  // Uber's real answer to a good request (11-10, from the live server): its sign-in, whose next_url
  // carries the whole authorize address, redirect_uri and all.
  const real = "https://auth.uber.com/v2/?next_url=https%3A%2F%2Fauth.uber.com%2Foauth%2Fv2%2Fauthorize%3Fanalytics_session_id%3D60c1%26client_id%3Duber-client-id%26redirect_uri%3Dhttps%253A%252F%252Freason.example.test%252Fuber%252Fcallback%26response_type%3Dcode%26scope%3Dprofile%26state%3Dreadiness";
  assert.deepEqual(await uber.connectReady({ fetchImpl: to(real) }), { ready: true, why: "" });
  uber._resetReady();
  let tries = 0;
  const down = async () => { tries++; throw new Error("ECONNRESET"); };
  assert.equal((await uber.connectReady({ fetchImpl: down })).why, "uber_unreachable");
  await uber.connectReady({ fetchImpl: down });
  assert.equal(tries, 1, "an unreachable Uber is kept thirty seconds");
  clock.skip(31_000);
  await uber.connectReady({ fetchImpl: down });
  assert.equal(tries, 2);
  config.uberClientSecret = "";
  uber._resetReady();
  assert.equal((await uber.connectReady({ fetchImpl: to("x") })).why, "no_keys");
});

test("Uber connect: bound to the stand-in when Uber is ready; 'not ready' when it isn't, with nothing made", async () => {
  const s = await newSetup();
  const asked = [];
  const uberLink = (c) => { asked.push(c); return { ok: true, url: "https://app.example/connect/start?state=st" }; };
  const no = await api("POST", `/api/${s.id}/connect/uber`, { cookie: s.cookie, uberReady: notReady, uberLink });
  assert.deepEqual(no.json, { ok: false, why: "not_ready" });
  assert.deepEqual(asked, [], "no link is made while Uber would refuse it");
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.uber, { state: "failed", step: 1, of: 3, why: "not_ready" });
  const yes = await api("POST", `/api/${s.id}/connect/uber`, { cookie: s.cookie, uberReady: ready, uberLink });
  assert.deepEqual(yes.json, { ok: true, url: "https://app.example/connect/start?state=st" });
  assert.deepEqual(asked, [s.c], "the setup's stand-in, never a real conversation");
  assert.equal((await api("POST", `/api/${s.id}/connect/uber`, { uberReady: ready, uberLink })).status, 404, "not without the setup's cookie");
  const caps = (await api("GET", "/api/capabilities", { uberReady: notReady })).json;
  assert.equal(caps.uber, false);
  assert.equal(caps.card, true);
  assert.equal((await api("GET", "/api/capabilities", { uberReady: ready })).json.uber, true);
});

test("the real Uber link for a setup: a state on the stand-in; connecting while it is open; Uber's return goes back to the setup", async () => {
  const s = await newSetup({ origin: "https://start--staging.example" });
  const out = await api("POST", `/api/${s.id}/connect/uber`, { cookie: s.cookie, uberReady: ready, origin: "https://start--staging.example" });
  assert.equal(out.json.ok, true);
  assert.match(out.json.url, /\/connect\/start\?state=/);
  assert.equal(q("SELECT conversation_id FROM oauth_states WHERE provider = 'uber'").get().conversation_id, s.c);
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.uber, { state: "connecting", step: 2, of: 3 });
  // A pending Google state on the same setup does not make Uber "connecting", nor the reverse.
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.email, { state: "none", step: 1, of: 3 });
  const done = ws.uberCallbackDone({ ok: true, conversationId: s.c });
  assert.equal(done.status, 302);
  assert.equal(done.headers.Location, "https://start--staging.example/start/connect?back=uber");
  assert.equal(ws.uberCallbackDone({ ok: false, conversationId: s.c }).headers.Location, "https://start--staging.example/start/connect?back=uber&failed=1");
  assert.equal(ws.uberCallbackDone({ ok: true, conversationId: "dm:fake:+1" }), null, "a thread's own Uber is untouched");
  db.saveOauthTokens(s.c, "uber", { accessToken: "a", refreshToken: "r", scope: "profile request", accountLabel: "Kofi" });
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.uber, { state: "connected", step: 3, of: 3 });
});

// ---------- the card ----------

test("card connect: Crossmint's own form on /web/connect/<token> for the stand-in; a new tap spends the old link", async () => {
  const s = await newSetup();
  const a = await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie });
  assert.equal(a.json.ok, true);
  assert.match(a.json.url, /^https:\/\/heyreason\.example\/web\/connect\/[A-Za-z0-9_-]{20,64}$/, "Reason's secure card page, never the setup page");
  const first = new URL(a.json.url).pathname.split("/").pop();
  assert.equal(shop.linkFor(first).conversation_id, s.c);
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.card, { state: "connecting", step: 2, of: 3 });
  const b = await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie });
  assert.notEqual(b.json.url, a.json.url);
  assert.equal(shop.linkView(shop.linkFor(first)).state, "failed", "one open card link per setup");
  process.env.REASON_SHOP_CONNECT = "owner";
  assert.deepEqual((await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie })).json, { ok: false, why: "unavailable" }, "shopping not open to everyone → no card here");
  assert.equal((await api("GET", "/api/capabilities", { uberReady: ready })).json.card, false);
});

test("a card saved from the setup: shown as connected (last four only), nothing texted, the page goes back to the setup", async () => {
  const s = await newSetup({ origin: "https://start--staging.example" });
  const { token, saved } = await saveSetupCard(s, "4242");
  assert.equal(saved.ok, true);
  assert.deepEqual(said, [], "the stand-in has no thread: nothing is texted to it");
  assert.equal(q("SELECT reg_error FROM shop_cards WHERE conversation_id = ?").get(s.c).reg_error, "CONSUMER_EMAIL_REQUIRED", "no email yet: registered at pay time");
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.card, { state: "connected", step: 3, of: 3, last4: "4242" });
  const page = await connectRequest({ sub: token, method: "GET" });
  assert.equal(page.status, 200);
  assert.match(page.body, /Back to your setup/);
  assert.match(page.body, /href="https:\/\/start--staging\.example\/start\/connect\?back=card"/);
  assert.doesNotMatch(page.body, /Set up Face ID/, "Face ID is set up later, signed in on Web");
  // The card form's Crossmint JWT for a setup is short (its Crossmint user can become an account's).
  const open = await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie });
  const form = await connectRequest({ sub: new URL(open.json.url).pathname.split("/").pop(), method: "GET" });
  const jwt = /"jwt":"([^"]+)"/.exec(form.body)?.[1];
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  assert.equal(claims.exp - claims.iat, shop.SETUP_JWT_SEC);
  assert.equal(claims.sub, shop.crossmintUser(s.c));
});

test("the claim moves Uber and the card: the card keeps its Crossmint user, its links are spent, email is not claimed", async () => {
  const h = harness();
  const num = newNumber();
  const s = await newSetup();
  db.saveOauthTokens(s.c, "uber", { accessToken: "a", refreshToken: "r", scope: "profile request", accountLabel: "Kofi" });
  db.connectAccount(s.c, "uber", ["profile", "request"], { account: "Kofi" });
  await saveSetupCard(s, "1881");
  const open = await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie }); // a second link, left open
  const token = new URL(open.json.url).pathname.split("/").pop();
  const setupSub = shop.crossmintUser(s.c);
  const logged = [];
  const claim = ws.claimFromText({ conversationId: conv(num), text: `hey jarvis, it's kofi · ${s.code}`, log: (e) => logged.push(e) });
  assert.equal(claim.uber, true);
  assert.equal(claim.card, true);
  assert.equal(claim.email, false, "an Uber grant is not an email connect");
  const me = conv(num);
  assert.equal(db.listOauthTokens(me, "uber").length, 1);
  assert.equal(db.listOauthTokens(s.c, "uber").length, 0);
  assert.equal(q("SELECT COUNT(*) AS n FROM connected_accounts WHERE conversation_id = ? AND name = 'uber'").get(me).n, 1);
  assert.equal(shop.cardOf(me).last4, "1881");
  assert.equal(shop.cardOf(s.c), null);
  assert.equal(shop.crossmintUser(me), setupSub, "the card pays as the Crossmint user it was saved under");
  assert.equal(shop.linkView(shop.linkFor(token)).state, "failed", "no card can be added under that Crossmint user afterwards");
  assert.equal(q("SELECT asked_email FROM shop_cards WHERE conversation_id = ?").get(me).asked_email, 0, "the receipts email is asked at pay time, by text");
  assert.ok(logged.some(e => e.websetup_claim === "claimed" && e.uber === true && e.card === true));
  await h.router.deliver(text(newNumber(), "hello")); // the router still runs normally around it
});

test("an account that already has Crossmint state keeps its own; the setup's card is let go at Crossmint", async () => {
  const s = await newSetup();
  await saveSetupCard(s, "4242");
  const me = conv(newNumber());
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_mine', 'mastercard', '1929', ?)").run(me, clock.now());
  const mine = shop.crossmintUser(me);
  assert.equal(shop.adoptSetupCard(s.c, me), false);
  assert.equal(shop.cardOf(me).last4, "1929");
  assert.equal(shop.crossmintUser(me), mine);
  assert.equal(shop.cardOf(s.c), null);
  await new Promise(r => setTimeout(r, 10));
  assert.ok(calls.some(c => c.method === "DELETE" && c.path.endsWith("/pm_4242") && c.sub === shop.crossmintUser(s.c)), "removed at Crossmint as the stand-in");
  assert.equal(shop.adoptSetupCard("dm:fake:+1", me), false, "only a setup's stand-in ever hands a card over");
});

test("Uber and the card move only on a claim within fifteen minutes; Gmail still moves up to the hour", async () => {
  const s = await newSetup();
  db.saveOauthTokens(s.c, "google", { accessToken: "g", refreshToken: "r", scope: "gmail", accountLabel: "kofi@example.com" });
  db.saveOauthTokens(s.c, "uber", { accessToken: "a", refreshToken: "r", scope: "profile", accountLabel: "Kofi" });
  db.connectAccount(s.c, "uber", ["profile"], { account: "Kofi" });
  await saveSetupCard(s, "4242");
  clock.skip(ws.PAY_CLAIM_MS + 60_000);
  const me = conv(newNumber());
  const claim = ws.claimFromText({ conversationId: me, text: `hey jarvis, it's kofi · ${s.code}` });
  assert.deepEqual([claim.email, claim.uber, claim.card], [true, false, false]);
  assert.equal(db.listOauthTokens(me, "uber").length, 0);
  assert.equal(q("SELECT COUNT(*) AS n FROM connected_accounts WHERE conversation_id = ? AND name = 'uber'").get(me).n, 0);
  assert.equal(shop.cardOf(me), null);
  assert.equal(shop.crossmintUser(me), shop.crossmintUser(me + ""), "no Crossmint user handed over");
  assert.equal(q("SELECT COUNT(*) AS n FROM shop_crossmint_subjects").get().n, 0);
});

test("a late claim drops Uber and the card; an expired setup's Uber and card are swept", async () => {
  const late = await newSetup();
  db.saveOauthTokens(late.c, "uber", { accessToken: "a", refreshToken: "r", scope: "profile", accountLabel: "" });
  await saveSetupCard(late, "4242");
  clock.skip(ws.CONNECT_CLAIM_MS + 60_000);
  const me = conv(newNumber());
  const claim = ws.claimFromText({ conversationId: me, text: `hey jarvis, it's kofi · ${late.code}` });
  assert.deepEqual([claim.uber, claim.card], [false, false]);
  assert.equal(shop.cardOf(me), null);
  assert.equal(db.listOauthTokens(me, "uber").length, 0);
  assert.equal(shop.cardOf(late.c), null);

  const s = await newSetup();
  db.saveOauthTokens(s.c, "uber", { accessToken: "a", refreshToken: "r", scope: "profile", accountLabel: "" });
  await saveSetupCard(s, "5151");
  const token = new URL((await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie })).json.url).pathname.split("/").pop();
  calls = [];
  ws.sweep(clock.now() + store.TTL_MS + 1);
  assert.equal(db.listOauthTokens(s.c, "uber").length, 0);
  assert.equal(shop.cardOf(s.c), null);
  assert.equal(shop.linkView(shop.linkFor(token)).state, "failed");
  await new Promise(r => setTimeout(r, 10));
  assert.ok(calls.some(c => c.method === "DELETE" && c.path.endsWith("/pm_5151")), "the card is removed at Crossmint too");
  assert.equal(store.get(s.id, 0), null);
});
