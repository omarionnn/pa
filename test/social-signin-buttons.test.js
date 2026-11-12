import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-social-buttons-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";
delete process.env.REASON_SOCIAL_SIGNIN;

const social = await import("../src/socialsignin.js");
const signin = await import("../src/signin.js");
const remote = await import("../src/signin-remote.js");
const win = await import("../src/signin-window.js");
const sites = await import("../src/sites.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const accounts = await import("../src/accounts.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;
const amazon = sites.site("amazon");
const doordash = sites.site("doordash");
const DAY = 24 * 60 * 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM threads; DELETE FROM connected_accounts; DELETE FROM action_ledger; DELETE FROM social_declines; DELETE FROM social_refusals;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  config.publicUrl = "https://reason.example";
  config.remoteSigninSettleMs = 0;
  process.env.REASON_SOCIAL_SIGNIN = "owner";
});

const call = (name, input, conversationId = CONV, ctx = {}) => runTool(name, input, { conversationId, messages: [], ...ctx });
const row = (c, site) => db.db.prepare("SELECT * FROM connected_accounts WHERE conversation_id = ? AND name = ? ORDER BY id DESC LIMIT 1").get(c, site);


const { setupStartPage, setupCodePage, setupResultPage, PROVIDER_MARKS } = await import("../src/pages/setupsignin.js");
const STEP = { url: "https://www.airbnb.com/login", text: "Log in or sign up\nContinue with Google\nContinue with Apple\nContinue with email", fields: [] };

function makeLink({ conversationId = CONV, entry = amazon, provider = "", offered = [], button = "Continue with Google Continue with Apple", said = { ok: true, state: "signed_in", why: "the account page loaded" } } = {}) {
  const did = [];
  const page = {
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x2a]),
    evaluate: async (js, arg) => {
      if (String(js).includes("findProviderButton")) { did.push(["press", arg]); return String(button).toLowerCase().includes(arg) ? `continue with ${arg}` : ""; }
      return STEP;
    },
    mouse: { click: async () => {}, wheel: async () => {} },
    keyboard: { type: async () => {}, press: async () => {} },
    goBack: async () => {},
  };
  const checks = [];
  const out = remote.createRemoteSignin({
    conversationId, entry, provider, offered, timers: { set: (fn, ms) => ({ fn, ms }), clear: () => {} }, log: () => {},
    launch: async () => ({ page, close: async () => {} }), closeBrowser: async () => {},
    check: async (p, c, site, opts) => { checks.push([c, site, opts]); return said; },
  });
  return { out, token: out.url.split("/").pop(), did, checks };
}
function provedCookie(conversationId) {
  const t = `sess-${conversationId}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, t, { conversationId });
  return `reason_page=${t}`;
}
const startWith = (token, form, cookie = provedCookie(CONV), extra = {}) =>
  remote.remoteRequest({ token, action: "start", method: "POST", headers: cookie ? { cookie, origin: "https://reason.example", host: "reason.example" } : { origin: "https://reason.example", host: "reason.example" }, query: {}, readBody: async () => form, ...extra });
const cookieOf = (r) => String(r.headers["Set-Cookie"]).split(",")[0].split(";")[0];

// ---------- the intro page ----------

test("the intro offers the site's own Continue-with choices in Reason's look, above the email sign-in", async () => {
  const { token } = makeLink({ offered: ["google", "apple", "microsoft"] });
  const r = await remote.remoteRequest({ token, method: "GET", headers: {}, query: {} });
  assert.equal(r.status, 200);
  assert.match(r.body, /Continue with Apple/);
  assert.match(r.body, /Continue with Microsoft/);
  assert.ok(!/Continue with Facebook/.test(r.body));
  assert.ok(!/Continue with Google/.test(r.body), "Google is never offered, even when the page has it");
  assert.ok(!/name="via" value="google"/.test(r.body));
  assert.ok(!/#4285F4/.test(r.body), "no Google mark");
  assert.match(r.body, /name="via" value="apple"/);
  assert.match(r.body, /Use my Amazon email/);
  assert.ok(r.body.indexOf("Continue with Apple") < r.body.indexOf("Use my Amazon email"), "providers first, the site's own email below");
  assert.match(r.body, /#F25022/, "Microsoft's own mark, its own colours");
  assert.match(r.body, /Amazon lets you sign in with Apple or Microsoft/);
});

test("no choices without the flag, and none offered → the page is the plain one as before", async () => {
  delete process.env.REASON_SOCIAL_SIGNIN;
  const a = makeLink({ offered: ["google", "apple"] });
  const r = await remote.remoteRequest({ token: a.token, method: "GET", headers: {}, query: {} });
  assert.ok(!/Continue with/.test(r.body));
  assert.ok(!/Use my Amazon email/.test(r.body), "the plain Sign in, no email-vs-provider choice");
  process.env.REASON_SOCIAL_SIGNIN = "owner";
  const plain = setupStartPage({ entry: amazon, action: "/s/x/start" });
  assert.ok(!/Continue with/.test(plain));
  assert.match(plain, /a password or a code by text or email works/);
});

test("tapping Continue with Apple presses Apple in Reason's browser and records Apple once signed in", async () => {
  const { token, did, checks } = makeLink({ offered: ["google", "apple"] });
  const r = await startWith(token, "via=apple");
  assert.equal(r.status, 303);
  assert.deepEqual(did[0], ["press", "apple"]);
  const done = await remote.remoteRequest({ token, action: "done", method: "POST", headers: { cookie: cookieOf(r) }, query: {}, readBody: async () => "{}" });
  assert.equal(done.status, 200);
  assert.deepEqual(checks[0][2], { provider: "apple" });
});

test("the email button presses nothing, even on a link made with a provider", async () => {
  const { token, did, checks } = makeLink({ provider: "apple", offered: ["apple"] });
  const r = await startWith(token, "via=");
  assert.equal(r.status, 303);
  assert.equal(did.length, 0, "nothing pressed: they chose the site's own email");
  await remote.remoteRequest({ token, action: "done", method: "POST", headers: { cookie: cookieOf(r) }, query: {}, readBody: async () => "{}" });
  assert.deepEqual(checks[0][2], { provider: "" });
});

test("a provider the page did not offer is not pressed", async () => {
  const { token, did } = makeLink({ offered: ["apple"] });
  await startWith(token, "via=facebook");
  assert.equal(did.length, 0);
  // Google, even when the page shows it and it is posted, is never pressed.
  const g = makeLink({ offered: ["google", "apple"] });
  await startWith(g.token, "via=google");
  assert.equal(g.did.length, 0);
});

test("a post with no choice keeps the provider the link was made with", async () => {
  const { token, did } = makeLink({ provider: "apple", offered: ["google", "apple"] });
  await startWith(token, "");
  assert.deepEqual(did[0], ["press", "apple"]);
  // A link made with Google has no provider to keep: nothing is pressed.
  const g = makeLink({ provider: "google", offered: ["google"] });
  await startWith(g.token, "");
  assert.equal(g.did.length, 0);
});

test("the choice survives the code step on a browser not yet proved", async () => {
  const { token } = makeLink({ offered: ["google", "apple"] });
  const sent = [];
  const r = await startWith(token, "via=apple", "", { tell: async (c, line) => { sent.push(line); } });
  assert.equal(r.status, 401);
  assert.match(r.body, /<input type="hidden" name="via" value="apple">/);
  const page = setupCodePage({ entry: amazon, action: "/s/x/start", via: "nonsense" });
  assert.match(setupCodePage({ entry: amazon, action: "/s/x/start", via: "" }), /name="via" value=""/, "email is carried too");
  assert.ok(!/name="via"/.test(setupCodePage({ entry: amazon, action: "/s/x/start" })), "no choice shown, nothing carried");
  assert.ok(!/name="via"/.test(page), "only a real provider is carried");
});

test("email chosen on a browser not yet proved stays email after the code (no Apple pressed)", async () => {
  const { token } = makeLink({ provider: "apple", offered: ["apple"] });
  const r = await startWith(token, "via=", "", { tell: async () => {} });
  assert.equal(r.status, 401);
  assert.match(r.body, /<input type="hidden" name="via" value="">/);
});

test("signin_link: a 404 or an outage on a walled-listed site is not called blocking", async () => {
  const made = [];
  const out = await call("signin_link", { site: "doordash" }, CONV, {
    signinWall: async () => ({ in: false, status: 502, why: "DoorDash's sign-in page answered HTTP 502 from here.", providers_offered: [] }),
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; },
  });
  assert.equal(out.ok, true);
  assert.equal(made.length, 1);
});

// ---------- the list and the line ----------

test("offeredFor: their saved login's provider first, then the asked one, then the page's; refused ones dropped", () => {
  db.upsertConnectedAccount?.({ conversationId: CONV, name: "amazon", state: "signed_in", provider: "apple" });
  social.recordRefusal(CONV, "amazon", "facebook");
  const got = social.offeredFor(CONV, amazon, { asked: "microsoft", live: ["facebook", "google", "apple"] });
  assert.deepEqual(got, ["microsoft", "apple"], "the asked one, then the page's");
  assert.ok(!got.includes("facebook"), "refused in the last 7 days");
  assert.ok(!got.includes("google"), "Google is never offered");
  assert.deepEqual(social.offeredFor(CONV, amazon, { asked: "google", live: ["google"] }), [], "not even when asked for");
  delete process.env.REASON_SOCIAL_SIGNIN;
  assert.deepEqual(social.offeredFor(CONV, amazon, { live: ["google"] }), []);
});

test("the text names the choice in one plain line, no jargon", () => {
  const two = social.choiceLine(doordash, ["apple", "microsoft"]);
  assert.equal(two, "DoorDash lets you sign in with Apple or Microsoft, or with your DoorDash email. Pick whichever you use on the page.");
  const mine = social.choiceLine(doordash, ["apple"], "apple");
  assert.match(mine, /^DoorDash signs in through your Apple account\. Tap Continue with Apple on the page/);
  // A Google login on record is never named as the way in: the line falls back to the choices.
  const g = social.choiceLine(doordash, ["apple"], "google");
  assert.doesNotMatch(g, /Google/);
  assert.match(g, /^DoorDash lets you sign in with Apple, or with your DoorDash email/);
  for (const l of [two, mine, g]) assert.ok(!/oauth|provider|social/i.test(l));
  assert.equal(social.choiceLine(doordash, []), "");
});

test("signin_link: the page's own buttons are read live and handed to the link, with the line to send", async () => {
  const made = [];
  const out = await call("signin_link", { site: "amazon" }, CONV, {
    signinWall: async () => ({ in: true, status: 200, providers_offered: ["google", "apple"] }),
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(made[0].offered, ["apple"], "the page's Google button is left off");
  assert.deepEqual(out.offered, ["apple"]);
  assert.match(out.choice, /Amazon lets you sign in with Apple, or with your Amazon email/);
  assert.doesNotMatch(out.choice, /Google/);
});

test("signin_link: a site walling Reason's browser right now gets no link, a plain line, and what works (food: the restaurant's own site)", async () => {
  const made = [];
  const out = await call("signin_link", { site: "doordash", provider: "google" }, CONV, {
    signinWall: async () => ({ in: false, status: 403, why: "DoorDash's sign-in page answers Reason's browser from here with a bot check (HTTP 403).", providers_offered: [] }),
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x" }; },
  });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, true);
  assert.equal(made.length, 0, "no link to a wall");
  assert.match(out.say, /DoorDash is blocking my browser from its sign-in page right now/);
  assert.match(out.say, /restaurant's own site/);
  assert.match(out.instead, /food_order/);
});

test("signin_link: a walled site whose wall has lifted gets its link with the choices", async () => {
  const made = [];
  const out = await call("signin_link", { site: "doordash" }, CONV, {
    signinWall: async () => ({ in: true, status: 200, providers_offered: ["google", "apple", "facebook"] }),
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(made[0].offered, ["apple", "facebook"], "Google left off");
});

test("signin_link without the flag: no live check, no choices (as before)", async () => {
  delete process.env.REASON_SOCIAL_SIGNIN;
  let asked = 0;
  const made = [];
  await call("signin_link", { site: "amazon" }, CONV, {
    signinWall: async () => { asked++; return { in: true, status: 200, providers_offered: ["google"] }; },
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; },
  });
  assert.equal(asked, 0);
  assert.deepEqual(made[0].offered, []);
});

test("the blocked page says the site is blocking Reason's browser right now and what still works", () => {
  const page = setupResultPage({ entry: doordash, ended: { state: "blocked" }, thread: { reply: () => "sms:+1" }, instead: social.wallInstead(doordash).say });
  assert.match(page, /DoorDash is blocking my browser right now\./);
  assert.match(page, /I can still order for you, from the restaurant(&#39;|')s own site or through my checkout/);
  assert.ok(Object.keys(PROVIDER_MARKS).length === 4);
});
