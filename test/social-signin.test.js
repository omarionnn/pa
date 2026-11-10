// Signing in through a Google / Apple / Facebook / Microsoft account (src/socialsignin.js,
// REASON_SOCIAL_SIGNIN), written from Omari's "Reason Social Sign-In Prompt" spec (2026-11-10).
//
// What has to hold:
//   1. **Off by default, owner-only on "owner".** No rule in the prompt, no provider tool, and a
//      `provider` on a sign-in link is dropped, unless the flag reaches that person.
//   2. **The rules are the spec.** Earned through a real task, one line, "your Google login" (never
//      "OAuth" / "social provider" to the person), never during onboarding / venting / late at night,
//      infer-then-confirm, a no holds 30 days, never a password / code / card in the chat, the
//      two-step order (phone tap > emailed code Reason reads > forwarded text), one more code may come,
//      fails twice → switch once → stop and say, finish first then mention once, sign back in
//      yourself, and the trust rules including "Google sign-in is not Gmail".
//   3. **Which button is written on the saved login, only after the site says signed in.** A
//      signed-out or unreadable check never puts a provider on the row.
//   4. **A no is remembered per provider for 30 days**, and the tool says so before any ask.
//   5. **Codes are cleaned for the box**: "G-123 456" → "123456" into a code box, nothing else touched.
//   6. **The provider button is pressed for them** on a link, and pressed again by Reason itself when
//      a session lapses — the person is only involved when that lands on the provider's page.
// No real site, browser or provider is touched: every page here is a fake that writes down what it
// was asked. Sealing at rest is in test/social-signin-rest.test.js (it needs the keystore flags on).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-social-signin-"));
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

/**
 * A profile's browser, as the site sees it. Signed out, every page — the account page included —
 * lands on the sign-in form (with or without a provider button); pressing the right button signs
 * the profile in when the provider's own session is still good (`signedIn`), after which the account
 * page is an account page. `already`: the profile starts signed in.
 */
function fakePage({ button = "Continue with Google", signedIn = true, already = false } = {}) {
  const did = [];
  let signedInNow = already;
  const page = {
    did,
    goto: async (url) => { did.push(["goto", url]); return { status: () => 200 }; },
    waitForTimeout: async () => {},
    url: () => (signedInNow ? amazon.signed_in.url : amazon.signin_url),
    evaluate: async (js, arg) => {
      if (String(js).includes("findProviderButton")) {
        did.push(["press", arg]);
        const t = String(button ?? "").toLowerCase();
        if (t.includes(String(arg))) { if (signedIn) signedInNow = true; return button; }
        return "";
      }
      // The probe reads the body: a signed-in account page, or the sign-in form.
      if (signedInNow) return "Your Orders\nHello, Omari\nOrders Buy Again Not Yet Shipped";
      return "Sign in\nEmail or mobile phone number\nContinue\nContinue with Google\nContinue with Apple";
    },
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x2a]),
    mouse: { click: async (x, y) => { did.push(["click", x, y]); }, wheel: async () => {} },
    keyboard: { type: async (t) => { did.push(["type", t]); }, press: async (k) => { did.push(["press-key", k]); } },
    goBack: async () => {},
  };
  return page;
}

// ---------- 1. the flag ----------

test("off by default; owner reaches only the operator; on reaches everyone", () => {
  delete process.env.REASON_SOCIAL_SIGNIN;
  assert.equal(social.socialMode(), "off");
  assert.equal(social.socialAllowedFor(CONV), false);
  process.env.REASON_SOCIAL_SIGNIN = "owner";
  assert.equal(social.socialAllowedFor(CONV), true);
  assert.equal(social.socialAllowedFor(THEIRS), false);
  process.env.REASON_SOCIAL_SIGNIN = "on";
  assert.equal(social.socialAllowedFor(THEIRS), true);
  process.env.REASON_SOCIAL_SIGNIN = "nonsense";
  assert.equal(social.socialMode(), "off");
});

test("off: no rule in the prompt, no provider tool, a provider on a link is dropped", async () => {
  delete process.env.REASON_SOCIAL_SIGNIN;
  const me = accounts.ownerOf(CONV);
  assert.ok(!systemFor(me).includes("your Google login"), "the rules are not in the prompt");
  assert.ok(!toolsFor(CONV).some(t => t.name === "signin_provider"));
  const out = await call("signin_provider", { action: "ask_check", provider: "google" });
  assert.equal(out.ok, false);
  const made = [];
  await call("signin_link", { site: "amazon", provider: "google" }, CONV, { createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; } });
  assert.equal(made[0].provider, "", "the provider is dropped where the flag does not reach");
});

test("owner: the owner gets the rules and the tool; a friend gets neither", () => {
  assert.ok(systemFor(accounts.ownerOf(CONV)).includes("your Google login"));
  assert.ok(toolsFor(CONV).some(t => t.name === "signin_provider"));
  assert.ok(!systemFor(accounts.ownerOf(THEIRS)).includes("your Google login"));
  assert.ok(!toolsFor(THEIRS).some(t => t.name === "signin_provider"));
  process.env.REASON_SOCIAL_SIGNIN = "on";
  assert.ok(systemFor(accounts.ownerOf(THEIRS)).includes("your Google login"));
  assert.ok(toolsFor(THEIRS).some(t => t.name === "signin_provider"));
});

// ---------- 2. the rules ----------

test("the rules say what the spec says, line by line", () => {
  const r = social.RULES;
  // when to ask
  assert.match(r, /EARN it through a real task/);
  assert.match(r, /first time a real task needs a site/);
  assert.match(r, /DoorDash signs in through your Google account\. Want me to use it\?/);
  assert.match(r, /Never during onboarding chit-chat, never mid-vent, never late at night unless they are actively asking/);
  assert.match(r, /never when the task can be done without signing in/);
  assert.match(r, /Say "your Google login", never "social provider" or "OAuth"/);
  // infer, then confirm
  assert.match(r, /signin_provider with action "infer"/);
  assert.match(r, /gmail_search for that site's welcome or receipt email/);
  assert.match(r, /Then confirm in one line/);
  // a no
  assert.match(r, /do not ask about that provider again for 30 days unless they bring it up/);
  assert.match(r, /Never pressure, never repeat a declined ask/);
  // collecting
  assert.match(r, /never a password, a code or a card number in this chat/);
  assert.match(r, /Send the secure sign-in link \(signin_link/);
  assert.match(r, /saved only once the site says they are signed in, and which provider each site uses is written down/);
  // two-step
  assert.match(r, /a Yes tap on their phone, then a code sent to an email you can read yourself \(gmail_search, gmail_read — never "check your email"\), then a texted code they forward/);
  assert.match(r, /"Google will ping your phone\. Tap Yes\."/);
  assert.match(r, /a "G-", spaces and dashes come off/);
  assert.match(r, /If a code fails twice, switch methods once; if that fails too, stop and say plainly what blocked it/);
  assert.match(r, /warn them one more may come/);
  // after
  assert.match(r, /finish the task first\. Then, once, say what it unlocked/);
  assert.match(r, /Now I can handle your DoorDash and Airbnb too/);
  assert.match(r, /sign back in yourself/);
  assert.match(r, /only involve them for an approval tap or a code/);
  // trust
  assert.match(r, /no curiosity browsing/);
  assert.match(r, /Never change passwords, security settings, recovery emails or connected apps/);
  assert.match(r, /Never grant a new third-party app access without asking/);
  assert.match(r, /Money, a message sent as them, and anything permanent still need their go-ahead/);
  assert.match(r, /answer honestly .* say how to revoke/);
  assert.match(r, /Signing in with Google is not the same as reading their Gmail/);
  // the jargon appears only inside the line that forbids it
  const jargon = r.match(/OAuth|social provider/g) ?? [];
  assert.equal(jargon.length, 2, "OAuth and social provider are named once each, in the never-say line");
  assert.equal(r.split("\n").filter(l => /OAuth|social provider/.test(l)).length, 1);
});

test("the rules sit with the other sign-in rules in the prompt, and nowhere twice", () => {
  const p = systemFor(accounts.ownerOf(CONV));
  const i = p.indexOf("You never take a password");
  const j = p.indexOf(social.RULES);
  assert.ok(i > 0 && j > i, "right after the never-a-password rule");
  assert.equal(p.indexOf(social.RULES, j + 1), -1);
});

test("the one-line expectation and the words, by provider", () => {
  assert.equal(social.expectLine("google"), "Google will ping your phone. Tap Yes.");
  assert.match(social.expectLine("microsoft"), /Authenticator/);
  assert.match(social.expectLine("apple"), /code on your iPhone or Mac/);
  assert.equal(social.loginWords("google"), "your Google login");
  assert.equal(social.loginWords("apple"), "your Apple login");
});

// ---------- 3. the record ----------

test("the provider goes on the saved login only with a signed-in reading", async () => {
  const out = await signin.checkAndRecord(fakePage(), CONV, "amazon", { provider: "google" });
  assert.equal(out.state, "signed_out", "the fake starts on the sign-in page");
  assert.equal(row(CONV, "amazon").provider, "", "signed out: no provider written");
  assert.equal(social.providerOf(CONV, "amazon"), "");

  clock.skip(1); // two checks in the same millisecond have no order; a real pair never do
  const page = fakePage({ already: true });
  const ok = await signin.checkAndRecord(page, CONV, "amazon", { provider: "google" });
  assert.equal(ok.state, "signed_in");
  assert.equal(ok.provider, "google");
  assert.equal(row(CONV, "amazon").provider, "google");
  assert.equal(social.providerOf(CONV, "amazon"), "google");
  assert.ok(signin.savedSignins(CONV).find(s => s.site === "amazon").provider === "google");

  // A later check with no provider keeps it; a bogus one is not written.
  await signin.checkAndRecord(page, CONV, "amazon");
  assert.equal(row(CONV, "amazon").provider, "google");
  await signin.checkAndRecord(page, CONV, "amazon", { provider: "myspace" });
  assert.equal(row(CONV, "amazon").provider, "google");

  // Signed out again: the row is revoked and the provider is no longer "a way in".
  clock.skip(1);
  await signin.checkAndRecord(fakePage(), CONV, "amazon", { provider: "google" });
  assert.equal(social.providerOf(CONV, "amazon"), "");
  assert.equal(signin.savedSignins(CONV).find(s => s.site === "amazon").provider, undefined);
});

test("what else one login unlocks: the sites saved through it", async () => {
  for (const [site, provider] of [["amazon", "google"], ["doordash", "google"], ["fandango", "apple"]]) {
    db.recordSiteSignin(CONV, site, { state: "signed_in", evidence: "t", provider });
  }
  db.recordSiteSignin(CONV, "opentable", { state: "signed_in", evidence: "t" });
  assert.deepEqual(social.sitesThrough(CONV, "google"), ["amazon", "doordash"]);
  assert.deepEqual(social.sitesThrough(CONV, "apple"), ["fandango"]);
  assert.deepEqual(social.sitesThrough(THEIRS, "google"), [], "somebody else's rows are not theirs");
  const out = await call("signin_provider", { action: "unlocks", provider: "google" });
  assert.deepEqual(out.sites_through_it, ["amazon", "doordash"]);
  assert.match(out.say, /Once, after the task is done/);
});

// ---------- 4. a no, for 30 days ----------

test("a no is remembered per provider for 30 days, and the tool says do not ask", async () => {
  let st = await call("signin_provider", { action: "ask_check", provider: "google" });
  assert.equal(st.providers.google.ask_allowed, true);
  assert.equal(st.do_not_ask, undefined);
  assert.match(st.rule, /your Google login/);

  const no = await call("signin_provider", { action: "declined", provider: "google" });
  assert.equal(no.ok, true);
  assert.equal(no.days, 30);
  assert.match(no.say, /Do not ask about your Google login again for 30 days/);
  assert.equal(social.askAllowed(CONV, "google"), false);
  assert.equal(social.askAllowed(CONV, "apple"), true, "a no to Google is not a no to Apple");
  assert.equal(social.askAllowed(THEIRS, "google"), true, "and not somebody else's no");

  st = await call("signin_provider", { action: "ask_check" });
  assert.equal(st.providers.google.ask_allowed, false);
  assert.equal(st.providers.google.days_left, 30);
  assert.equal(st.providers.apple.ask_allowed, true);
  assert.match(st.do_not_ask, /said no to Google inside the last 30 days: do not ask/);

  clock.skip(29 * DAY);
  assert.equal(social.askAllowed(CONV, "google"), false);
  clock.skip(DAY + 1);
  assert.equal(social.askAllowed(CONV, "google"), true);
  st = await call("signin_provider", { action: "ask_check", provider: "google" });
  assert.equal(st.providers.google.ask_allowed, true);

  // A newer no restarts the clock.
  social.recordDecline(CONV, "google");
  assert.equal(social.askAllowed(CONV, "google"), false);
  social.clearDecline(CONV, "google");
  assert.equal(social.askAllowed(CONV, "google"), true);
  assert.equal((await call("signin_provider", { action: "declined" })).ok, false, "declined needs the provider");
});

// ---------- 5. codes ----------

test("a code is cleaned the way the box takes it", () => {
  assert.equal(social.normalizeCode("G-123456"), "123456");
  assert.equal(social.normalizeCode("g- 123 456"), "123456");
  assert.equal(social.normalizeCode("123-456"), "123456");
  assert.equal(social.normalizeCode(" 123 456 "), "123456");
  assert.equal(social.normalizeCode("123–456"), "123456", "an en dash is a dash");
  assert.equal(social.normalizeCode("Your code is 123456"), "123456", "a numeric box keeps the digits");
  assert.equal(social.normalizeCode("ABC-123", { accepts: "any" }), "ABC123", "a text box keeps letters");
  assert.equal(social.normalizeCode("G-ABC 123", { accepts: "any" }), "ABC123");
  assert.equal(social.normalizeCode("1234567890", { max: 6 }), "123456", "the field's maxlength");
  assert.equal(social.normalizeCode(""), "");
  assert.equal(social.normalizeCode(null), "");
  for (const t of ["G-123456", "123 456", "123-456", "1234", "12345678"]) assert.ok(social.looksLikeCode(t), t);
  for (const t of ["hunter2", "kofi@example.com", "12", "+1 415 555 0199 ok"]) assert.ok(!social.looksLikeCode(t), t);
});

const AMAZON_CODE_STEP = {
  url: "https://www.amazon.com/ap/cvf/verify",
  text: "Verification needed\nEnter the code sent to your phone\nSubmit code",
  fields: [{ x: 0.12, y: 0.3, w: 0.76, h: 0.06, tag: "input", type: "tel", ac: "one-time-code", name: "code", id: "cvf-input-code", label: "Enter OTP", im: "numeric", ml: 6, len: 0, focused: true }],
};
const AMAZON_EMAIL_STEP = {
  url: "https://www.amazon.com/ap/signin",
  text: "Sign in\nEnter mobile number or email\nContinue",
  fields: [{ x: 0.12, y: 0.3, w: 0.76, h: 0.06, tag: "input", type: "email", ac: "", name: "email", id: "ap_email_login", label: "Enter mobile number or email", im: "", ml: 0, len: 0, focused: true }],
};

/** A link's browser, as test/signin-remote.test.js builds it, plus what the start pressed. */
function makeLink({ conversationId = CONV, entry = amazon, provider = "", frames = [AMAZON_EMAIL_STEP], button = "Continue with Google", said = { ok: true, state: "signed_in", why: "the order history page loaded" } } = {}) {
  const did = [];
  let i = 0;
  const page = {
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x2a]),
    evaluate: async (js, arg) => {
      if (String(js).includes("findProviderButton")) { did.push(["press", arg]); return String(button).toLowerCase().includes(arg) ? button : ""; }
      return frames[Math.min(i++, frames.length - 1)];
    },
    mouse: { click: async (x, y) => { did.push(["click", x, y]); }, wheel: async () => {} },
    keyboard: { type: async (t) => { did.push(["type", t]); }, press: async (k) => { did.push(["key", k]); } },
    goBack: async () => {},
  };
  const checks = [];
  const timers = { set: (fn, ms) => ({ fn, ms }), clear: () => {} };
  const out = remote.createRemoteSignin({
    conversationId, entry, provider, timers, log: () => {},
    launch: async () => ({ page, close: async () => {} }),
    closeBrowser: async () => {},
    check: async (p, c, site, opts) => { checks.push([c, site, opts]); return said; },
  });
  const token = out.url.split("/").pop();
  return { out, token, did, checks };
}
function provedCookie(conversationId) {
  const t = `sess-${conversationId}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, t, { conversationId });
  return `reason_page=${t}`;
}
const req = (token, action = "", { method = "GET", cookie = "", body = null } = {}) =>
  remote.remoteRequest({ token, action, method, headers: cookie ? { cookie } : {}, query: {}, readBody: async () => (body === null ? "" : JSON.stringify(body)) });
async function start(token, conversationId = CONV) {
  const r = await req(token, "start", { method: "POST", cookie: provedCookie(conversationId) });
  assert.equal(r.status, 303);
  return String(r.headers["Set-Cookie"]).split(",")[0].split(";")[0];
}
const notes = (c = CONV) => db.db.prepare("SELECT note FROM timers WHERE conversation_id = ? ORDER BY id").all(c).map(r => r.note);

test("a forwarded code typed into a code box is cleaned; anything else is typed as it came", async () => {
  const { token, did } = makeLink({ frames: [AMAZON_CODE_STEP] });
  const cookie = await start(token);
  await req(token, "view", { cookie });
  await req(token, "type", { method: "POST", cookie, body: { text: "G-123 456" } });
  assert.deepEqual(did.filter(d => d[0] === "type").pop(), ["type", "123456"]);
  await req(token, "type", { method: "POST", cookie, body: { text: "hunter2-correct-horse" } });
  assert.deepEqual(did.filter(d => d[0] === "type").pop(), ["type", "hunter2-correct-horse"], "not a code: untouched");

  // The same text into the email box stays as typed — a phone number with spaces is not a code.
  const two = makeLink({ frames: [AMAZON_EMAIL_STEP] });
  const c2 = await start(two.token);
  await req(two.token, "view", { cookie: c2 });
  await req(two.token, "type", { method: "POST", cookie: c2, body: { text: "212 555 0199" } });
  assert.deepEqual(two.did.filter(d => d[0] === "type").pop(), ["type", "212 555 0199"]);
});

test("with the flag off the typed text is never touched", async () => {
  delete process.env.REASON_SOCIAL_SIGNIN;
  const { token, did } = makeLink({ frames: [AMAZON_CODE_STEP] });
  const cookie = await start(token);
  await req(token, "view", { cookie });
  await req(token, "type", { method: "POST", cookie, body: { text: "G-123 456" } });
  assert.deepEqual(did.filter(d => d[0] === "type").pop(), ["type", "G-123 456"]);
});

// ---------- 6. the button, on a link and on a lapse ----------

test("a link with a provider presses that button on start, and the finished sign-in records it", async () => {
  const { token, did, checks } = makeLink({ provider: "google" });
  assert.equal(did.length, 0, "nothing pressed before Start");
  const cookie = await start(token);
  assert.deepEqual(did[0], ["press", "google"]);
  const r = await req(token, "done", { method: "POST", cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(checks[0][2], { provider: "google" }, "the check is told which button");
  const note = notes().pop();
  assert.match(note, /saved as a Google sign-in/);
  assert.match(note, /say once what else that unlocks/);
});

test("a link whose page has no such button leaves the site's own form, and says so on the note", async () => {
  const { token, did } = makeLink({ provider: "google", button: "Sign in with Apple" });
  const cookie = await start(token);
  assert.deepEqual(did[0], ["press", "google"]);
  await req(token, "done", { method: "POST", cookie });
  assert.match(notes().pop(), /had no such button/);
});

test("a provider on a link is dropped for someone the flag does not reach", async () => {
  const { did, checks, token } = makeLink({ conversationId: THEIRS, provider: "google" });
  const cookie = await start(token, THEIRS);
  assert.equal(did.filter(d => d[0] === "press").length, 0);
  await req(token, "done", { method: "POST", cookie });
  assert.deepEqual(checks[0][2], { provider: "" });
  assert.ok(!notes(THEIRS).pop().includes("Google sign-in"));
});

test("signin_link and signin_open carry the provider through, and the window's command is told it", async () => {
  const made = [];
  const link = await call("signin_link", { site: "amazon", provider: "google" }, CONV, { createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/x", good_for_minutes: 10, reachable_from_a_phone: true }; } });
  assert.equal(made[0].provider, "google");
  assert.equal(link.provider, "google");
  assert.match(link.expect, /Google will ping your phone\. Tap Yes\./);
  assert.match(link.second_code, /one more may come/);
  assert.match(link.second_code, /fails twice, switch methods once/);
  assert.match(link.say, /Google button pressed/);

  const opened = [];
  const w = await call("signin_open", { site: "amazon", provider: "apple" }, CONV, { openSigninWindow: async (a) => { opened.push(a); return { ok: true, site: "amazon", opened_at: 1 }; } });
  assert.equal(opened[0].provider, "apple");
  assert.match(w.say, /Apple button pressed/);

  // The real window hands the provider to the sign-in command through its environment.
  const spawned = [];
  const spawnImpl = (bin, args, opts) => { const ch = new EventEmitter(); ch.pid = 1; ch.kill = () => true; spawned.push({ args, opts }); return ch; };
  await win.openSigninWindow({ conversationId: CONV, entry: amazon, spawnImpl, provider: "google", timers: { set: () => ({}), clear: () => {} } });
  assert.equal(spawned[0].opts.env.REASON_SIGNIN_PROVIDER, "google");
  assert.ok(!("REASON_SIGNIN_PROVIDER" in process.env), "and not through the parent's environment");
});

test("the button finder presses the provider's control and nothing else", async () => {
  for (const [label, p, want] of [
    ["Continue with Google", "google", true], ["Sign in with Apple", "apple", true], ["Log in with Facebook", "facebook", true],
    ["Use your Microsoft account", "microsoft", true], ["Google", "google", true],
    ["Continue with Google", "apple", false], ["Email or mobile phone number", "google", false],
    ["Read our Google Analytics notice and privacy policy, which covers cookies and how we and Google use them", "google", false],
  ]) assert.equal(social.providerButtonMatches(label, p), want, `${label} / ${p}`);
  const page = fakePage({ button: "Sign in with Apple" });
  assert.deepEqual(await social.clickProviderButton(page, "google", { settleMs: 0 }), { pressed: "" });
  assert.deepEqual(await social.clickProviderButton(page, "apple", { settleMs: 0 }), { pressed: "Sign in with Apple" });
  assert.deepEqual(await social.clickProviderButton(page, "myspace"), { pressed: "" });
  assert.deepEqual(await social.clickProviderButton({ evaluate: async () => { throw new Error("closed"); } }, "google"), { pressed: "" });
});

test("which buttons a sign-in page (or a welcome email) offers", () => {
  assert.deepEqual(social.providersOffered("Sign in\nEmail\nContinue with Google\nContinue with Apple\nSign in with Facebook"), ["google", "apple", "facebook"]);
  assert.deepEqual(social.providersOffered("Welcome to DoorDash! You signed up with Google. Your receipt is attached."), ["google"]);
  assert.deepEqual(social.providersOffered("Log in using your Microsoft account"), ["microsoft"]);
  assert.deepEqual(social.providersOffered("Email or mobile phone number\nPassword\nForgot password?"), []);
  assert.deepEqual(social.providersOffered("We use Google Analytics. Apple Pay accepted."), [], "a mention is not a button");
});

test("infer: reads the site's page, or the text they gave, then says to confirm", async () => {
  const out = await call("signin_provider", { action: "infer", site: "doordash" }, CONV, { readSigninPage: async () => "Sign in or sign up\nContinue with Google\nContinue with Apple\nEmail" });
  assert.deepEqual(out.providers_offered, ["google", "apple"]);
  assert.equal(out.read, doordash.signin_url);
  assert.match(out.say, /gmail_search/);
  assert.match(out.say, /confirm in one line/);
  assert.match(out.say, /your Google login/);
  const own = await call("signin_provider", { action: "infer", site: "doordash" }, CONV, { readSigninPage: async () => "Email\nPassword\nSign in" });
  assert.deepEqual(own.providers_offered, []);
  assert.match(own.say, /the site's own form/);
  const mail = await call("signin_provider", { action: "infer", text: "Thanks for signing up with Google! Your first order…" });
  assert.deepEqual(mail.providers_offered, ["google"]);
  const dead = await call("signin_provider", { action: "infer", site: "doordash" }, CONV, { readSigninPage: async () => { throw new Error("net::ERR_TIMED_OUT"); } });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /could not be read/);
});

test("a lapsed session is signed in again by pressing the saved button, before anyone is asked", async () => {
  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "t", provider: "google" });
  // The recheck finds the session gone; the provider was read before the probe revoked the row.
  const page = fakePage({ button: "Continue with Google" });
  const out = await call("signin_status", { site: "amazon", recheck: true }, CONV, { pageFor: async () => page });
  assert.equal(out.signed_in_again, true);
  assert.equal(out.state, "signed_in");
  assert.match(out.signin_again, /signed back in yourself through the Google button/);
  assert.deepEqual(page.did.filter(d => d[0] === "press"), [["press", "google"]]);
  assert.equal(row(CONV, "amazon").provider, "google", "the row is live again, with the button on it");
  assert.equal(social.providerOf(CONV, "amazon"), "google");
});

test("when the button lands on the provider's page, the person is asked — with the one-line expectation", async () => {
  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "t", provider: "google" });
  const page = fakePage({ button: "Continue with Google", signedIn: false });
  const out = await call("signin_status", { site: "amazon", recheck: true }, CONV, { pageFor: async () => page });
  assert.equal(out.signed_in_again, false);
  assert.equal(out.state, "signed_out");
  assert.match(out.signin_again, /Google wants them/);
  assert.match(out.signin_again, /signin_link with provider 'google'/);
  assert.match(out.signin_again, /Google will ping your phone\. Tap Yes\./);
});

test("no provider on record, or the flag off: a lapse is reported as before, nothing pressed", async () => {
  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "t" });
  let page = fakePage();
  let out = await call("signin_status", { site: "amazon", recheck: true }, CONV, { pageFor: async () => page });
  assert.equal(out.state, "signed_out");
  assert.equal(out.signed_in_again, undefined);
  assert.equal(page.did.filter(d => d[0] === "press").length, 0);

  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "t", provider: "google" });
  delete process.env.REASON_SOCIAL_SIGNIN;
  page = fakePage();
  out = await call("signin_status", { site: "amazon", recheck: true }, CONV, { pageFor: async () => page });
  assert.equal(out.state, "signed_out");
  assert.equal(out.signed_in_again, undefined);
  assert.equal(page.did.filter(d => d[0] === "press").length, 0);
});

test("signInAgain on its own: no provider, no page, or a page that will not load", async () => {
  assert.deepEqual(await social.signInAgain(fakePage(), CONV, amazon), { ok: false, tried: false, why: "no provider is on record for this site" });
  const dead = { goto: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } };
  const out = await social.signInAgain(dead, CONV, amazon, { provider: "google" });
  assert.equal(out.tried, true);
  assert.match(out.why, /did not load/);
  assert.equal(out.ok, false);
});

// ---------- 8. the provider refuses Reason's browser ----------

const GOOGLE_REFUSED = {
  url: "https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fwww.amazon.com",
  text: "Google\nCouldn't sign you in\nThis browser or app may not be secure. Learn more\nTry using a different browser. If you're already using a supported browser, you can try again to sign in.\nTry again",
  fields: [],
};

test("providerRefused: Google's 'may not be secure', Apple's and Microsoft's 'browser not supported' on their own hosts; nothing else", () => {
  assert.equal(social.providerRefused(GOOGLE_REFUSED).provider, "google");
  assert.match(social.providerRefused(GOOGLE_REFUSED).why, /Google refused Reason's browser/);
  // Google's own words carry it even if the url was not read.
  assert.equal(social.providerRefused({ url: "", text: "This browser or app may not be secure." }).provider, "google");
  assert.equal(social.providerRefused({ url: "https://appleid.apple.com/auth/authorize?x", text: "Sign in with Apple\nYour browser is not supported." }).provider, "apple");
  assert.equal(social.providerRefused({ url: "https://login.microsoftonline.com/common/oauth2", text: "Microsoft\nThis browser is not supported" }).provider, "microsoft");
  // A site's own "browser not supported", or Google's ordinary steps, are not a provider refusal.
  assert.equal(social.providerRefused({ url: "https://www.amazon.com/ap/signin", text: "Your browser is not supported" }).refused, false);
  assert.equal(social.providerRefused({ url: "https://accounts.google.com/signin", text: "Sign in\nUse your Google Account\nEmail or phone" }).refused, false);
  assert.equal(social.providerRefused({ url: "https://accounts.google.com/signin", text: "Couldn't find your Google Account" }).refused, false);
  assert.equal(social.providerRefused({}).refused, false);
  // Google's and Microsoft's ordinary failures are not a refusal of the browser.
  assert.equal(social.providerRefused({ url: "https://accounts.google.com/v3/signin/challenge", text: "Couldn't sign you in\nOpen the Gmail app on your phone and approve the request. Too many failed attempts." }).refused, false);
  assert.equal(social.providerRefused({ url: "https://login.microsoftonline.com/common", text: "We couldn't sign you in. Your browser is currently set to block cookies." }).refused, false);
});

test("a link that lands on Google's refusal ends at once: nothing checked or saved, one plain line, the site's own form offered, no retry", async () => {
  const { token, did, checks } = makeLink({ provider: "google", frames: [GOOGLE_REFUSED] });
  const cookie = await start(token);
  const r = await req(token, "view", { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { over: true, state: "refused" });
  assert.equal(checks.length, 0, "the account page is never asked, so nothing can be recorded");
  assert.equal(row(CONV, "amazon"), undefined, "no saved login");
  const note = notes().pop();
  assert.match(note, /Google refused my browser for Amazon/);
  assert.match(note, /sign in with your Amazon email and password instead/);
  assert.match(note, /signin_link with site "amazon" and NO provider/);
  assert.match(note, /will not be tried again/);
  assert.equal(did.filter(d => d[0] === "press").length, 1, "pressed once, on Start, never again");
  // A second ask for the Google route is refused without a link; the site's own form still works.
  const made = [];
  const seam = { createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/y", good_for_minutes: 10, reachable_from_a_phone: true }; } };
  const again = await call("signin_link", { site: "amazon", provider: "google" }, CONV, seam);
  assert.equal(again.ok, false);
  assert.equal(again.refused, "google");
  assert.match(again.say, /Google refused my browser for Amazon/);
  assert.deepEqual(made, []);
  const own = await call("signin_link", { site: "amazon" }, CONV, seam);
  assert.equal(own.ok, true);
  assert.equal(made[0].provider, "");
  // Another provider, or another site, is not held against it.
  assert.equal(social.refusedRecently(CONV, "amazon", "apple"), false);
  assert.equal(social.refusedRecently(CONV, "opentable", "google"), false);
  // Seven days later it may be tried again.
  assert.equal(social.refusedRecently(CONV, "amazon", "google", clock.now() + 8 * 86_400_000), false);
});

test("a lapse whose Google button lands on the refusal: nothing saved, said plainly, not pressed again", async () => {
  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "t", provider: "google" });
  const page = fakePage({ button: "Continue with Google", signedIn: false });
  let pressedOnce = false;
  const inner = page.evaluate;
  page.evaluate = async (js, arg) => { const out = await inner(js, arg); if (String(js).includes("findProviderButton")) pressedOnce = true; return pressedOnce && typeof js === "function" ? GOOGLE_REFUSED.text : out; };
  page.url = () => (pressedOnce ? GOOGLE_REFUSED.url : amazon.signin_url);
  const out = await call("signin_status", { site: "amazon", recheck: true }, CONV, { pageFor: async () => page });
  assert.equal(out.state, "signed_out");
  assert.equal(out.provider_refused, "google");
  assert.match(out.say, /Google refused my browser for Amazon/);
  assert.equal(social.refusedRecently(CONV, "amazon", "google"), true);
  // Asked again: the button is not pressed a second time.
  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "t", provider: "google" });
  const before = page.did.filter(d => d[0] === "press").length;
  await call("signin_status", { site: "amazon", recheck: true }, CONV, { pageFor: async () => page });
  assert.equal(page.did.filter(d => d[0] === "press").length, before);
});

test("the page they land on says the provider said no, and offers the site's own sign-in", async () => {
  const { setupResultPage } = await import("../src/pages/setupsignin.js");
  const html = setupResultPage({ entry: amazon, ended: { how: "refused", state: "refused", provider: "google" }, thread: { reply: (r) => `sms:+14155550199&body=${encodeURIComponent(r)}` } });
  assert.match(html, /body=Google%20refused%20the%20sign-in/);
  assert.match(html, /Google said no to my browser\./);
  assert.match(html, /email and password instead/);
  assert.doesNotMatch(html, /Couldn&#39;t tell|Couldn't tell/);
});

test("the rules say what a refusal means", () => {
  assert.match(social.RULES, /REFUSED: Google \(or Apple\/Microsoft\) sometimes refuses Reason's browser/);
  assert.match(social.RULES, /never retry it, and offer that site's own email\/password sign-in/);
});
