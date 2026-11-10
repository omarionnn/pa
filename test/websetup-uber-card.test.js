// The web setup's Uber and card connects (src/websetup.js, 11-10): both bound to the setup's stand-in,
// both moved to the account on the claim, both let go when the setup expires.
//
//   Uber: OFF the page since 11-10 (with Amazon): capabilities say uber:false and the connect endpoint is
//     refused with nothing made; uber.connectReady (Uber's authorize answer) is still read by the thread's
//     own connect. Uber's return for an older setup's stand-in still goes back to the connect screen, and
//     a grant one somehow holds still moves on the claim.
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
const ob = await import("../src/onboarding.js");
const amazon = await import("../src/amazonconnect.js");
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
// The checkout agent, scripted: one run at a time, its state set by the test between steps.
const crossmint = { run: null, n: 0, reset() { this.run = null; } };
async function fakeCrossmint(url, init = {}) {
  const p = new URL(url).pathname;
  const method = init.method ?? "GET";
  const auth = String(init.headers?.Authorization ?? "");
  const sub = auth ? JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString()).sub : init.headers?.["x-crossmint-user-id"];
  calls.push({ method, path: p, sub, body: init.body ? JSON.parse(init.body) : undefined });
  if (/order-intent-registration$/.test(p) && method === "PUT") return reply(400, { error: { code: "CONSUMER_EMAIL_REQUIRED" } });
  if (/^\/api\/2026-09-16\/payment-methods\/[^/]+$/.test(p) && method === "DELETE") return reply(204);
  if (p === "/api/unstable/agent-checkouts/browser-profiles" && method === "POST") return reply(201, { id: "prof_setup" });
  if (/^\/api\/unstable\/agent-checkouts\/browser-profiles\/[^/]+$/.test(p) && method === "DELETE") return reply(204);
  if (p === "/api/unstable/agent-checkouts" && method === "POST") {
    const id = crossmint.n++ ? `run_setup${crossmint.n}` : "run_setup";
    crossmint.run = { id, status: "running", revision: 1, requiredAction: null };
    return reply(201, { runId: id });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(?:\/(messages|cancel))?$/.exec(p);
  if (m && crossmint.run && m[1] === crossmint.run.id) {
    if (!m[2] && method === "GET") return reply(200, crossmint.run);
    if (m[2] === "messages" && method === "POST") return reply(200, { ok: true });
    if (m[2] === "cancel" && method === "POST") { crossmint.run = { ...crossmint.run, status: "cancelled" }; return reply(200, { ok: true }); }
  }
  return reply(404, { message: "no route" });
}
before(() => { shop._setFetch(fakeCrossmint); shop.attach({ say: (c, t) => said.push({ c, t }), base: "https://heyreason.example/web/connect" }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  ws.resetLimits();
  uber._resetReady();
  calls = []; said = []; crossmint.reset();
  process.env.REASON_WEB_SETUP = "on";
  process.env.REASON_SHOP_CONNECT = "on";
  process.env.REASON_INTRO_AMAZON = "on";
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.publicUrl = "https://reason.example.test";
  config.uberClientId = "uber-client-id";
  config.uberClientSecret = "uber-client-secret";
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM web_setups; DELETE FROM oauth_tokens; DELETE FROM connected_accounts; DELETE FROM oauth_states; DELETE FROM shop_cards; DELETE FROM shop_links; DELETE FROM shop_profiles; DELETE FROM shop_crossmint_subjects; DELETE FROM shop_shipping; DELETE FROM shop_runs; DELETE FROM shop_run_asks; DELETE FROM shop_stores;");
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

test("Uber connect is off the page: refused whether Uber is ready or not, nothing made; capabilities say uber:false", async () => {
  const s = await newSetup();
  for (const uberReady of [notReady, ready]) {
    const no = await api("POST", `/api/${s.id}/connect/uber`, { cookie: s.cookie, uberReady });
    assert.equal(no.status, 404);
    assert.deepEqual(no.json, { ok: false, why: "unavailable" });
  }
  assert.equal(q("SELECT COUNT(*) AS n FROM oauth_states WHERE provider = 'uber'").get().n, 0, "no link, no state");
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.uber, { state: "none", step: 1, of: 3 }, "the setup untouched");
  assert.equal((await api("POST", `/api/${s.id}/connect/uber`, { uberReady: ready })).status, 404, "not without the setup's cookie either");
  for (const uberReady of [notReady, ready]) {
    const caps = (await api("GET", "/api/capabilities", { uberReady })).json;
    assert.equal(caps.uber, false, "false even when Uber's app would take a connect");
    assert.equal(caps.amazon, true, "Amazon rides Crossmint, like the card");
    assert.equal(caps.card, true);
  }
  process.env.REASON_SHOP_CONNECT = "owner";
  const caps = (await api("GET", "/api/capabilities")).json;
  assert.equal(caps.amazon, false, "the same gate as the card");
  assert.equal(caps.card, false);
});

// ---------- Amazon: the store sign-in through Crossmint (11-10) ----------

/** The store asks for the login: an email in the open and the password sealed. */
const LOGIN_ASK = (requestId = "req_login") => ({
  requestId,
  request: { question: "Sign in to your Amazon account", interaction: { kind: "form", fields: [
    { key: "email", label: "Email", handling: "standard", input: { autoComplete: "email" }, required: true },
    { key: "password", label: "Password", handling: "protected", required: true },
  ] } },
});

test("Amazon on the setup: a sign-in-only Crossmint run under the setup's profile, the /web/connect page (checking → login → connected), nothing texted; connected moves on the claim and the thread makes no offer", async () => {
  const s = await newSetup({ origin: "https://start--staging.example" });
  const out = await api("POST", `/api/${s.id}/connect/amazon`, { cookie: s.cookie });
  assert.equal(out.json.ok, true);
  assert.match(out.json.url, /^https:\/\/heyreason\.example\/web\/connect\/[A-Za-z0-9_-]{20,64}$/, "Reason's sign-in page, keyed by its token: no cookie, no code, any browser");
  const token = new URL(out.json.url).pathname.split("/").pop();
  const started = calls.find((c) => c.method === "POST" && c.path === "/api/unstable/agent-checkouts");
  assert.ok(started, "a Crossmint run was started");
  assert.equal(started.sub, shop.crossmintUser(s.c), "as the setup's Crossmint user");
  assert.match(started.body.request.task, /Sign in to my Amazon account first/);
  assert.match(started.body.request.task, /do not buy anything/);
  assert.equal(started.body.request.startUrl, "https://www.amazon.com/");
  assert.equal(started.body.constraints.maxCost.amount, "1.00");
  assert.equal(started.body.browser.profileId, "prof_setup", "the setup's own browser profile, made for it");
  assert.equal(shop.profileOf(s.c), "prof_setup");
  const run = q("SELECT * FROM shop_runs WHERE conversation_id = ?").get(s.c);
  assert.equal(run.mode, "sign_in");
  assert.equal(run.store, "amazon");
  const link = shop.linkFor(token);
  assert.equal(link.kind, "signin");
  assert.equal(link.run_id, run.run_id);
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon, { state: "connecting", step: 1, of: 3 });
  // The page before the store has asked: waiting on Amazon opening, the way back to the setup, no code talk.
  let page = await connectRequest({ sub: token, method: "GET" });
  assert.equal(page.status, 200);
  assert.match(page.body, /Opening Amazon\./);
  assert.doesNotMatch(page.body, /text you|Text me|texted|code Reason/i);
  // Amazon asks for the login: the run is followed (step), the link carries the question, the page is the form.
  crossmint.run = { ...crossmint.run, revision: 2, requiredAction: LOGIN_ASK() };
  await shop.step(run.run_id);
  assert.deepEqual(said, [], "nothing texted to a stand-in");
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon, { state: "connecting", step: 2, of: 3 });
  page = await connectRequest({ sub: token, method: "GET" });
  assert.match(page.body, /Sign in to Amazon\./);
  assert.match(page.body, /data-protected="password"/, "the password is Crossmint's sealed field");
  assert.match(page.body, /name="email" type="email"/, "the email is the only plain field");
  const jwt = /"jwt":"([^"]+)"/.exec(page.body)?.[1];
  assert.ok(jwt, "the page can mount Crossmint's sealed field as the setup's user");
  assert.equal(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).sub, shop.crossmintUser(s.c));
  // The answer: the email in the open, the password as a reference only; it goes to the run.
  const answered = await connectRequest({ sub: `${token}/answer`, method: "POST", readBody: async () => JSON.stringify({ requestId: "req_login", answers: { email: "kofi@example.com", password: { protectedInputId: "pi_1" } } }) });
  assert.equal(answered.status, 200);
  const posted = calls.find((c) => c.method === "POST" && /\/agent-checkouts\/run_setup\/messages$/.test(c.path));
  assert.ok(posted);
  assert.deepEqual(posted.body.parts[0].response.answers, { email: "kofi@example.com", password: { protectedInputId: "pi_1" } });
  assert.equal(JSON.stringify(calls).includes("correcthorse"), false);
  // Amazon let them in and the run ends as asked: connected, the link too, the page says so with the way back.
  crossmint.run = { ...crossmint.run, revision: 3, status: "succeeded", requiredAction: null, result: { code: "ok" } };
  await shop.step(run.run_id);
  assert.equal(shop.isConnected(s.c, "amazon"), true);
  assert.equal(shop.linkView(shop.linkFor(token)).state, "connected");
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon, { state: "connected", step: 3, of: 3 });
  page = await connectRequest({ sub: token, method: "GET" });
  assert.match(page.body, /You&#39;re signed in to Amazon\.|You're signed in to Amazon\./);
  assert.match(page.body, /href="https:\/\/start--staging\.example\/start\/connect\?back=amazon"[^>]*id="cx-back"/);
  assert.match(page.body, /setTimeout\(function\(\)\{location\.href=a\.href\},1500\)/);
  assert.doesNotMatch(page.body, /Back to Reason|SEE IT IN SETTINGS/);
  assert.deepEqual(said, []);
  assert.equal(ws.connectState(store.get(s.id), "amazon").state, "connected");
  // The claim: the store sign-in moves with the Crossmint user and the profile; the thread makes no Amazon offer.
  const h = harness();
  const num = newNumber();
  const setupSub = shop.crossmintUser(s.c);
  await h.router.deliver(text(num, `hey jarvis, it's kofi · ${s.code}`));
  const me = conv(num);
  assert.equal(shop.isConnected(me, "amazon"), true);
  assert.equal(shop.isConnected(s.c, "amazon"), false);
  assert.equal(shop.crossmintUser(me), setupSub);
  assert.equal(shop.profileOf(me), "prof_setup");
  assert.equal(ob.amazonCanOffer(me), false, "connected on the page: not offered again");
  assert.deepEqual(h.channel.sent.filter((m) => m.to === num).map((m) => m.text), [ob.WEB_HELLO("kofi"), ob.WEB_CARD, ob.TRY_LINE]);
  assert.equal(db.getAccount(me).onboarding, "complete");
  assert.equal(q("SELECT COUNT(*) AS n FROM timers WHERE conversation_id = ? AND note = ?").get(me, amazon.followUpNote()).n, 0, "a Crossmint sign-in is for buying: no order read");
});

test("Amazon on the setup, skipped or failed: the thread offers it after the card; a run the store stops, a plain question, or a stale run reads failed; a new tap starts fresh", async () => {
  process.env.REASON_INTRO_AMAZON = "on";
  const s = await newSetup();
  assert.equal((await api("POST", `/api/${s.id}/connect/amazon`, { cookie: s.cookie })).json.ok, true);
  const first = q("SELECT run_id FROM shop_runs WHERE conversation_id = ?").get(s.c).run_id;
  // Amazon asks something only a person could answer: let go quietly, the page says failed, nothing texted.
  crossmint.run = { ...crossmint.run, revision: 2, requiredAction: { requestId: "req_q", request: { question: "Which address?", interaction: { kind: "form", fields: [{ key: "address", label: "Address", handling: "standard", required: true }] } } } };
  await shop.step(first);
  assert.equal(q("SELECT status FROM shop_runs WHERE run_id = ?").get(first).status, "cancelled");
  assert.ok(calls.some((c) => c.method === "POST" && c.path === `/api/unstable/agent-checkouts/${first}/cancel`), "cancelled at Crossmint");
  assert.deepEqual(said, []);
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon, { state: "failed", step: 1, of: 3 });
  // A new tap: a fresh run, connecting again; the old link is spent.
  crossmint.reset();
  const again = await api("POST", `/api/${s.id}/connect/amazon`, { cookie: s.cookie });
  assert.equal(again.json.ok, true);
  const second = q("SELECT run_id FROM shop_runs WHERE conversation_id = ? AND status = 'running'").get(s.c).run_id;
  assert.notEqual(second, first);
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon, { state: "connecting", step: 1, of: 3 });
  // Nothing answers about the run for two minutes: failed, not stuck.
  clock.skip(ws.STALE_CONNECT_MS + 1000);
  assert.deepEqual((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon, { state: "failed", step: 1, of: 3 });
  await shop.step(second); // Crossmint answers again: alive again
  assert.equal((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon.state, "connecting");
  // The store stops the run: failed on the page, with the way back and no "text me".
  crossmint.run = { ...crossmint.run, revision: 3, status: "failed", requiredAction: null, result: { code: "merchant.stopped" } };
  await shop.step(second);
  const token = new URL(again.json.url).pathname.split("/").pop();
  const page = await connectRequest({ sub: token, method: "GET" });
  assert.match(page.body, /didn&#39;t go through|didn't go through/);
  assert.match(page.body, /Back to your setup/);
  assert.doesNotMatch(page.body, /Text me|text you/i);
  assert.equal((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).json.connections.amazon.state, "failed");
  // Not connected on the page: the claim hands off to the thread's own Amazon offer.
  const h = harness();
  const num = newNumber();
  await h.router.deliver(text(num, `hey jarvis, it's kofi · ${s.code}`));
  const me = conv(num);
  assert.equal(shop.isConnected(me, "amazon"), false);
  assert.equal(ob.amazonCanOffer(me), true);
  assert.deepEqual(h.channel.sent.filter((m) => m.to === num).map((m) => m.text), [ob.WEB_HELLO("kofi"), ob.WEB_CARD, amazon.OFFER]);
  assert.equal(db.getAccount(me).onboarding, "awaiting_amazon");
  // Past the window: no sign-in is started (it would not move to them anyway).
  const late = await newSetup();
  clock.skip(ws.PAY_CLAIM_MS);
  assert.deepEqual((await api("POST", `/api/${late.id}/connect/amazon`, { cookie: late.cookie })).json, { ok: false, why: "too_late" });
});

test("a late claim lets the setup's Amazon sign-in go: the store row gone, the Crossmint profile erased; an expired setup's too", async () => {
  const s = await newSetup();
  assert.equal((await api("POST", `/api/${s.id}/connect/amazon`, { cookie: s.cookie })).json.ok, true);
  const run = q("SELECT run_id FROM shop_runs WHERE conversation_id = ?").get(s.c).run_id;
  crossmint.run = { ...crossmint.run, revision: 2, status: "succeeded", requiredAction: null, result: { code: "ok" } };
  await shop.step(run);
  assert.equal(shop.isConnected(s.c, "amazon"), true);
  clock.skip(ws.PAY_CLAIM_MS + 1000);
  const me = conv(newNumber());
  const claim = ws.claimFromText({ conversationId: me, text: `hey jarvis, it's kofi · ${s.code}` });
  assert.equal(claim.amazonStore, false);
  assert.equal(shop.isConnected(me, "amazon"), false, "not after the window");
  assert.equal(shop.isConnected(s.c, "amazon"), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.some((c) => c.method === "DELETE" && /browser-profiles\/prof_setup$/.test(c.path)), "the profile, and the sign-in in it, erased at Crossmint");
  assert.equal(shop.profileOf(s.c), null);
});

test("an older setup's Uber state: connecting while it is open; Uber's return goes back to the setup", async () => {
  const s = await newSetup({ origin: "https://start--staging.example" });
  // A state a stand-in made before Uber left the page (nothing on the page makes one now).
  const out = uber.authorizeUrl(s.c);
  assert.equal(out.ok, true);
  store.setConnectState(s.id, "uber", "pending");
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
  // Near the setup's fifteen-minute mark the token ends at the mark; past it, no card form and no new card link.
  clock.skip(ws.PAY_CLAIM_MS - 5 * 60_000);
  const near = await connectRequest({ sub: new URL(open.json.url).pathname.split("/").pop(), method: "GET" });
  const c2 = JSON.parse(Buffer.from(/"jwt":"([^"]+)"/.exec(near.body)[1].split(".")[1], "base64url").toString());
  assert.ok(c2.exp - c2.iat <= 5 * 60, "never past the mark");
  clock.skip(5 * 60_000);
  assert.doesNotMatch((await connectRequest({ sub: new URL(open.json.url).pathname.split("/").pop(), method: "GET" })).body, /"jwt":/);
  assert.deepEqual((await api("POST", `/api/${s.id}/connect/card`, { cookie: s.cookie })).json, { ok: false, why: "too_late" });
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
