// The owner's Amazon sign-in through the hosted link, 2026-11-13 (22:54 and 23:10 UTC): the email went
// through, then every password submit "loads and brings me back to the password screen", with nothing
// said. Four passwords went to Amazon; the first session ran out silently.
//
// The cause: Reason's own panel is keyed by the step's name. Amazon answering a password submit with
// its password page again (with its own message, a picture check, an approval request or a code box)
// still read as "password", so the panel was never redrawn, Amazon's message was never read off the
// page, and the box simply came back empty under "Sent. Waiting for the next step…".
//
// What has to hold now, on local fixtures (never anybody's real login):
//   a. the same step back with the site's message: the message is shown, as the site's words, masked;
//   b. a picture check beside the password: the step that opens the page below (the existing one);
//   c. "approve the notification sent to your phone": fixed words, a bounded wait, "I approved it";
//   d. a code box beside the password: its own labelled box, relayed into its own box;
//   e. two identical answers to the same step stop the link; no more than three passwords per link;
//   f. a link that ends without signing in says what the site showed last;
//   and one `signin_link_diag` line per submit with numbers, kinds and the masked alert only.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-link-reprompt-"));
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

const remote = await import("../src/signin-remote.js");
const social = await import("../src/socialsignin.js");
const sp = await import("../src/signinpage.js");
const sites = await import("../src/sites.js");
const slog = await import("../src/signinlog.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const OWNER = "+12025551234";
const CONV = "dm:owner";
const amazon = sites.site("amazon");
const TYPED_EMAIL = "someone@example.com";
const TYPED_PASSWORD = "not-a-real-password-42";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  await remote.endAllRemoteSignins("replaced");
  remote.forgetAllRemoteSignins();
  slog._resetSteps();
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM signin_pages;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.publicUrl = "https://reason.example";
  config.remoteSigninSettleMs = 0;
  remote.APPROVE_WAIT.pollMs = 5;
  remote.APPROVE_WAIT.waitMs = 200;
});

// ---------------------------------------------------------------- Amazon-shaped readings (FRAME_JS's shape)
const PW_BOX = { x: 0.1, y: 0.35, w: 0.8, h: 0.06, tag: "input", type: "password", ac: "current-password", name: "password", id: "ap_password", label: "Password", im: "", ml: 0, len: 0, focused: false };
const EMAIL = { url: "https://www.amazon.com/ap/signin?openid.mode=checkid_setup", doc: 1, title: "Amazon Sign-In", alerts: [], challenge: { img: false, frames: [] }, checks: 0,
  text: "Sign in or create account\nEnter mobile number or email\nContinue",
  fields: [{ x: 0.1, y: 0.3, w: 0.8, h: 0.06, tag: "input", type: "email", ac: "", name: "email", id: "ap_email_login", label: "Enter mobile number or email", im: "", ml: 0, len: 0, focused: false }] };
const PW = { url: "https://www.amazon.com/ap/signin", doc: 2, title: "Amazon Sign-In", alerts: [], challenge: { img: false, frames: [] }, checks: 1,
  text: "Sign in\nPassword\nForgot your password?\nSign in\nKeep me signed in.", fields: [PW_BOX] };
// (a) the password page again, with the site's error box
const PW_ERROR = (doc, words = "There was a problem Your password is incorrect") => ({ ...PW, doc, alerts: [words], text: `${words}\n${PW.text}` });
// (b) the password page again, with a picture check and its own box
const PW_PICTURE = (doc) => ({ ...PW, doc, alerts: ["Important Message! To better protect your account, please re-enter your password and then enter the characters as they are shown in the image below."],
  challenge: { img: true, frames: [] },
  text: `Important Message!\nTo better protect your account, please re-enter your password and then enter the characters as they are shown in the image below.\n${PW.text}\nType characters`,
  fields: [PW_BOX, { x: 0.1, y: 0.6, w: 0.8, h: 0.06, tag: "input", type: "text", ac: "off", name: "guess", id: "auth-captcha-guess", label: "Type characters", im: "", ml: 0, len: 0, focused: false }] });
// (c) the password page again, saying an approval went to the phone
const PW_APPROVE = (doc) => ({ ...PW, doc, alerts: ["We sent a notification to +1 ***-***-1234. Approve the notification to continue."],
  text: `Approve the notification sent to +1 ***-***-1234\nWe sent a notification to your phone. Approve it to continue.\n${PW.text}` });
const APPROVAL_ONLY = (doc) => ({ url: "https://www.amazon.com/ap/cvf/approval", doc, title: "Authentication required", alerts: [], challenge: { img: false, frames: [] }, checks: 0,
  text: "Approve the notification sent to +1 ***-***-1234\nWe've sent a notification to your phone. Approve it to continue.", fields: [] });
// (d) the password page again, with a one-time-code box beside it
const PW_CODE = (doc) => ({ ...PW, doc, alerts: ["Enter the code we sent to s***@example.com"],
  text: `Enter the code we sent to s***@example.com\n${PW.text}\nEnter code`,
  fields: [PW_BOX, { x: 0.1, y: 0.6, w: 0.8, h: 0.06, tag: "input", type: "tel", ac: "one-time-code", name: "otpCode", id: "auth-mfa-otpcode", label: "Enter code", im: "numeric", ml: 6, len: 0, focused: false }] });
const ORDERS = { url: "https://www.amazon.com/your-orders/orders", doc: 99, title: "Your Orders", alerts: [], challenge: { img: false, frames: [] }, checks: 0, text: "Your Orders\nHello, Omari\nSign Out", fields: [], acct: "logout" };

const kinds = (raw) => (raw.fields ?? []).map(f => ({ k: sp.fieldKind(f) }));

// ---------------------------------------------------------------- a browser that moves on Enter
/** `script`: what the page is after each Enter, in order (the last one stays). */
function fakeBrowser(first, script = []) {
  const did = [];
  const b = { did, cur: first, script: [...script], closed: 0 };
  const page = {
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, b.cur.doc & 0xff]),
    evaluate: async () => b.cur,
    mouse: { click: async (x, y) => { did.push(["click", x, y]); }, wheel: async () => {} },
    keyboard: {
      type: async (t) => { did.push(["type", t]); },
      press: async (k) => { did.push(["press", k]); if (k === "Enter" && b.script.length) b.cur = b.script.shift(); },
    },
    goBack: async () => {},
  };
  b.launch = async () => ({ page, close: async () => { b.closed++; } });
  return b;
}
function make(first, script) {
  const b = fakeBrowser(first, script);
  const logs = [];
  const timers = { set: (fn, ms) => ({ fn, ms }), clear: () => {} };
  const out = remote.createRemoteSignin({ conversationId: CONV, entry: amazon, launch: b.launch, timers, log: (e) => logs.push(e),
    check: async () => ({ ok: true, state: "signed_out", why: "the sign-in page is still showing" }) });
  return { b, logs, token: out.url.split("/").pop(), timers };
}
function provedCookie() {
  const t = `sess-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${CONV}`, t, { conversationId: CONV });
  return `reason_page=${t}`;
}
const req = (token, action = "", { method = "GET", cookie = "", body = null, query = {} } = {}) =>
  remote.remoteRequest({ token, action, method, headers: cookie ? { cookie } : {}, query, readBody: async () => (body === null ? "" : JSON.stringify(body)) });
async function start(token) {
  const r = await req(token, "start", { method: "POST", cookie: provedCookie() });
  return String(r.headers["Set-Cookie"] ?? "").split(";")[0];
}
function unpack(res) {
  if (!Buffer.isBuffer(res.body)) return { json: JSON.parse(res.body) };
  const n = res.body.readUInt32BE(0);
  return { meta: JSON.parse(res.body.subarray(4, 4 + n).toString("utf8")) };
}
const view = async (h, cookie) => unpack(await req(h.token, "view", { cookie }));
const relay = async (h, cookie, body) => JSON.parse((await req(h.token, "relay", { method: "POST", cookie, body })).body);
/** One submit and the site's answer to it: relay, then the next settled view. */
async function submit(h, cookie, step, text, extra = {}) {
  const r = await relay(h, cookie, { step, text, ...extra });
  clock.skip(2000);
  return { r, v: await view(h, cookie) };
}
const notes = () => db.db.prepare("SELECT note FROM timers WHERE conversation_id = ? ORDER BY id").all(CONV).map(r => r.note);
const diags = (h) => h.logs.filter(l => l.signin_link_diag);

// ---------------------------------------------------------------- 1. what each answer is read as
test("1a-d: the four answers Amazon can give on its password page are four different steps, read off the page", () => {
  assert.equal(social.stepOf(PW_ERROR(3), { fields: kinds(PW_ERROR(3)) }).step, "password", "a: the same step, with the site's message");
  assert.equal(social.stepOf(PW_PICTURE(3), { fields: kinds(PW_PICTURE(3)) }).step, "captcha", "b: a picture check is the step only the person can do");
  assert.equal(sp.fieldKind(PW_PICTURE(3).fields[1]), "captcha", "b: the box beside the picture is not a sign-in box");
  assert.equal(social.stepOf(PW_APPROVE(3), { fields: kinds(PW_APPROVE(3)) }).step, "approve", "c: an approval Reason can only wait for");
  assert.equal(social.stepOf(APPROVAL_ONLY(3), { fields: [] }).step, "approve");
  assert.equal(sp.fieldKind(PW_CODE(3).fields[1]), "otp", "d: Amazon's otpCode box is a code box");
  assert.equal(social.stepOf(PW_CODE(3), { fields: kinds(PW_CODE(3)) }).step, "password_code", "d: both boxes at once");
  // "Verify it's you" on a page with a code box is the code step, not a picture check.
  assert.equal(social.stepOf({ url: "https://www.amazon.com/ap/cvf/verify", text: "Verify it's you. We've sent a code to s***@example.com", fields: [] }, { fields: [{ k: "otp" }] }).step, "code");
  assert.equal(sp.pageKind(PW_PICTURE(3)), "signin_form");
  assert.equal(sp.pageKind(APPROVAL_ONLY(3)), "provider_prompt", "a step for the person, never 'not a sign-in page'");
});

test("the site's words are masked before they are shown or logged: addresses, numbers and masked numbers", () => {
  assert.equal(remote.siteSaid(PW_ERROR(3)), "There was a problem Your password is incorrect");
  const m = remote.siteSaid({ alerts: ["We sent a code to someone@example.com and +1 (202) 555-0147", "Ref 88231774", "We sent it to s***@gmail.com and +1 ***-***-1234"] });
  assert.doesNotMatch(m, /someone|example\.com|555|0147|88231774|gmail|1234/);
  assert.match(m, /\[email\]/); assert.match(m, /\[number\]/);
  assert.ok(remote.maskSiteWords("x".repeat(400)).length <= 160);
  assert.equal(remote.saidClass("There was a problem Your password is incorrect"), "wrong_password");
  assert.equal(remote.saidClass(remote.siteSaid(PW_PICTURE(3))), "picture_check");
  assert.equal(remote.saidClass("Too many failed attempts. Try again later."), "too_many_attempts");
  assert.equal(remote.saidClass(""), "none");
});

// ---------------------------------------------------------------- the same pages in a real browser
const HTML = {
  a: `<title>Amazon Sign-In</title><div id="auth-error-message-box" class="a-box a-alert a-alert-error" role="alert"><h4 class="a-alert-heading">There was a problem</h4><div class="a-alert-content">Your password is incorrect</div></div>
      <div class="a-alert a-alert-inline" style="display:none">Enter your password</div><form><input type="hidden" name="email" value="someone@example.com"><label for="ap_password">Password</label><input id="ap_password" type="password" name="password" style="width:300px;height:30px"><input type="checkbox" name="rememberMe"> Keep me signed in<button>Sign in</button></form>`,
  b: `<title>Amazon Sign-In</title><div id="auth-warning-message-box" class="a-box a-alert a-alert-warning"><h4 class="a-alert-heading">Important Message!</h4><div class="a-alert-content">To better protect your account, please re-enter your password and then enter the characters as they are shown in the image below.</div></div>
      <form><label for="ap_password">Password</label><input id="ap_password" type="password" name="password" style="width:300px;height:30px"><img id="auth-captcha-image" alt="Visual CAPTCHA image, continue down for an audio option." src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="200" height="70"><input id="auth-captcha-guess" name="guess" type="text" placeholder="Type characters" style="width:300px;height:30px"><button>Sign in</button></form>`,
  c: `<title>Amazon Sign-In</title><div class="a-alert a-alert-info" role="alert"><div class="a-alert-content">We sent a notification to +1 ***-***-1234. Approve the notification to continue.</div></div><form><label for="ap_password">Password</label><input id="ap_password" type="password" name="password" style="width:300px;height:30px"><button>Sign in</button></form>`,
  d: `<title>Amazon Sign-In</title><div class="a-alert a-alert-info" role="alert"><div class="a-alert-content">Enter the code we sent to s***@example.com</div></div><form><label for="ap_password">Password</label><input id="ap_password" type="password" name="password" style="width:300px;height:30px"><input id="auth-mfa-otpcode" name="otpCode" type="tel" maxlength="6" autocomplete="one-time-code" placeholder="Enter code" style="width:300px;height:30px"><button>Sign in</button></form>`,
  frame: `<title>Check</title><p>Sign in</p><input type="password" name="password" style="width:300px;height:30px"><iframe src="about:blank#arkose-funcaptcha" title="arkose challenge" width="300" height="200"></iframe>`,
};
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
async function readFixture(html) {
  const page = await browser.newPage({ viewport: { width: 430, height: 700 } });
  try { await page.setContent(`<!doctype html><html><body>${html}</body></html>`); return await page.evaluate(sp.FRAME_JS); } finally { await page.close(); }
}

test("1a-d in a real browser: the page reading carries the site's own message, the picture check by name, and every box", async () => {
  const a = await readFixture(HTML.a);
  assert.deepEqual(a.alerts, ["There was a problem Your password is incorrect"], "visible message boxes only; the hidden inline one is not read");
  assert.equal(a.checks, 1); assert.equal(a.title, "Amazon Sign-In"); assert.ok(a.doc > 0, "the document's identity, so a new page is told from the old one");
  assert.equal(social.stepOf(a, { fields: kinds(a) }).step, "password");
  assert.doesNotMatch(JSON.stringify(a.fields), /someone@example\.com/, "no box's value is read");
  const b = await readFixture(HTML.b);
  assert.equal(b.challenge.img, true);
  assert.match(b.alerts[0], /^Important Message! To better protect your account/);
  assert.deepEqual(b.fields.map(sp.fieldKind), ["password", "captcha"]);
  assert.equal(social.stepOf(b, { fields: kinds(b) }).step, "captcha");
  const c = await readFixture(HTML.c);
  assert.equal(social.stepOf(c, { fields: kinds(c) }).step, "approve");
  assert.doesNotMatch(remote.siteSaid(c), /1234/);
  const d = await readFixture(HTML.d);
  assert.deepEqual(d.fields.map(sp.fieldKind), ["password", "otp"]);
  assert.equal(social.stepOf(d, { fields: kinds(d) }).step, "password_code");
  const f = await readFixture(HTML.frame);
  assert.deepEqual(f.challenge.frames, ["arkose"], "a challenge frame by name only");
  assert.equal(social.stepOf(f, { fields: kinds(f) }).step, "captcha");
});

// ---------------------------------------------------------------- 4a + 4e: the same answer, shown, then stopped
test("4a/4e: the password page back with Amazon's message shows the message; the same answer twice stops the link, honestly, with no 'try again'", async () => {
  const h = make(EMAIL, [PW, PW_ERROR(3), PW_ERROR(4)]);
  const cookie = await start(h.token);
  assert.equal((await view(h, cookie)).meta.np.step, "email");
  let { v } = await submit(h, cookie, "email", TYPED_EMAIL);
  assert.equal(v.meta.np.step, "password");
  assert.equal(v.meta.said, "", "the step moved on: nothing to say");
  const keyBefore = v.meta.np.key;
  ({ v } = await submit(h, cookie, "password", TYPED_PASSWORD));
  assert.equal(v.meta.np.step, "password");
  assert.equal(v.meta.said, "Amazon showed this step again and said: “There was a problem Your password is incorrect”", "the site's own words, never an empty reset");
  assert.notEqual(v.meta.np.key, keyBefore, "the panel is drawn again: a fresh box, not a box left 'sending'");
  assert.ok(v.meta.np.html, "and its HTML comes with it");
  // The second identical answer: the link ends itself.
  const r2 = await relay(h, cookie, { step: "password", text: TYPED_PASSWORD });
  assert.equal(r2.ok, true);
  clock.skip(2000);
  const over = await view(h, cookie);
  assert.equal(over.json.over, true, "the link stopped itself");
  // What the page says (its words, not the shared loader script every paper page carries).
  const page = String((await req(h.token, "", { cookie })).body).replace(/<script[\s\S]*?<\/script>/g, "");
  assert.match(page, /I stopped here\./);
  assert.match(page, /Amazon showed the same step again and said: “There was a problem Your password is incorrect”/);
  assert.match(page, /so repeated tries don(&#39;|')t lock your account/);
  assert.doesNotMatch(page, /try again|fresh link/i, "no offer to go round again");
  const n = notes().at(-1);
  assert.match(n, /stopped itself/); assert.match(n, /"There was a problem Your password is incorrect"/);
  assert.match(n, /2 passwords went to Amazon/);
  assert.match(n, /Do NOT offer or ask to try again/);
  assert.match(n, /Do NOT say the password was wrong unless/);
  assert.equal(h.b.closed, 1, "the browser is closed");
  assert.equal(slog.recentSteps().at(-1)?.detail, "site_repeated");
});

test("3: one diagnostics line per submit, numbers and classes only, never what was typed", async () => {
  const h = make(EMAIL, [PW_PICTURE(2)]);
  const cookie = await start(h.token);
  await view(h, cookie);
  await submit(h, cookie, "email", TYPED_EMAIL);
  const d = diags(h);
  assert.equal(d.length, 1);
  const line = d[0];
  assert.equal(line.signin_link_diag, "amazon");
  assert.equal(line.host, "www.amazon.com"); assert.equal(line.path, "/ap/signin");
  assert.equal(line.kind_before, "signin_form"); assert.equal(line.kind_after, "signin_form");
  assert.equal(line.step_before, "email"); assert.equal(line.step_after, "captcha");
  assert.equal(line.same_step, false); assert.equal(line.new_document, true);
  assert.equal(line.alert_class, "picture_check");
  assert.match(line.alert, /^Important Message!/);
  assert.deepEqual(line.inputs, { password: 1, text: 0, code: 0, captcha_box: 1, checkbox: 1 });
  assert.deepEqual(line.challenge, ["captcha image"]);
  assert.equal(line.title, "Amazon Sign-In");
  const all = JSON.stringify(h.logs) + JSON.stringify(slog.recentSteps());
  assert.ok(!all.includes(TYPED_EMAIL) && !all.includes("someone") && !all.includes(TYPED_PASSWORD), "nothing typed reaches a log");
});

test("an answer is not judged off the old page: a submit still loading waits for a new document, or a while without one", async () => {
  const h = make(PW, []); // Enter changes nothing: the page never navigates
  const cookie = await start(h.token);
  await view(h, cookie);
  await relay(h, cookie, { step: "password", text: TYPED_PASSWORD });
  clock.skip(2000);
  await view(h, cookie);
  assert.equal(diags(h).length, 0, "two seconds on the same document is not an answer yet");
  clock.skip(5000);
  const v = await view(h, cookie);
  assert.equal(diags(h).length, 1);
  assert.equal(diags(h)[0].same_step, true); assert.equal(diags(h)[0].new_document, false);
  assert.match(v.meta.said, /Amazon showed this step again without a message I can read/, "even with no message: never a silent reset");
});

test("4e: no more than three passwords on one link; a fourth Enter on a password page is refused before the site hears of it", async () => {
  const h = make(PW, [PW_ERROR(3, "There was a problem A"), PW_ERROR(4, "There was a problem B"), PW_ERROR(5, "There was a problem C")]);
  const cookie = await start(h.token);
  await view(h, cookie);
  for (let i = 0; i < 3; i++) assert.equal((await relay(h, cookie, { step: "password", text: TYPED_PASSWORD })).ok, true);
  const fourth = await relay(h, cookie, { step: "password", text: TYPED_PASSWORD });
  assert.equal(fourth.capped, true);
  assert.match(fourth.say, /stopped sending passwords to Amazon on this link so repeated tries don't lock your account/);
  assert.equal(h.b.did.filter(d => d[0] === "press" && d[1] === "Enter").length, 3, "three Enters, no fourth");
  // Through the picture too: Enter after typing is refused the same way.
  await req(h.token, "type", { method: "POST", cookie, body: { text: "x" } });
  const k = await req(h.token, "key", { method: "POST", cookie, body: { key: "Enter" } });
  assert.equal(k.status, 409);
  assert.equal(h.b.did.filter(d => d[0] === "press" && d[1] === "Enter").length, 3);
  // Three different answers, the third back to the password page: the link stops at the cap.
  clock.skip(2000);
  const over = await view(h, cookie);
  assert.equal(over.json.over, true);
});

// ---------------------------------------------------------------- 4b: the picture check
test("4b/4d-challenge: a picture check beside the password opens the page below (the existing step for what Reason can't do), with Amazon's message; Reason types nothing into it", async () => {
  const h = make(PW, [PW_PICTURE(3)]);
  const cookie = await start(h.token);
  await view(h, cookie);
  const { v } = await submit(h, cookie, "password", TYPED_PASSWORD);
  assert.equal(v.meta.np.step, "captcha");
  assert.equal(v.meta.np.page, true, "the page below is opened for it");
  assert.match(v.meta.np.html, /wants to check you(&#39;|')re human/);
  assert.match(v.meta.said, /Important Message! To better protect your account, please re-enter your password and then enter the characters/);
  assert.equal(diags(h)[0].same_step, true, "the password page came back (with a picture check)");
  const typedBefore = h.b.did.filter(d => d[0] === "type").length;
  const r = await relay(h, cookie, { step: "password", text: TYPED_PASSWORD });
  assert.equal(r.moved, true, "the panel's password box never sends into a picture-check step");
  assert.equal(h.b.did.filter(d => d[0] === "type").length, typedBefore, "nothing typed by Reason");
});

// ---------------------------------------------------------------- 4c: approve on the phone
test("4c: 'approve the notification': fixed words, an 'I approved it' button, a bounded wait that presses nothing", async () => {
  const h = make(PW, [APPROVAL_ONLY(3)]);
  const cookie = await start(h.token);
  await view(h, cookie);
  const { v } = await submit(h, cookie, "password", TYPED_PASSWORD);
  assert.equal(v.meta.np.step, "approve");
  assert.match(v.meta.np.html, /I approved it/);
  assert.match(v.meta.np.say, /^Amazon sent an approval request to your phone or its app\. Approve it there/);
  assert.doesNotMatch(v.meta.np.html + v.meta.np.say, /1234/, "no number off the page in Reason's own words");
  const did = h.b.did.length;
  const waiting = JSON.parse((await req(h.token, "approved", { method: "POST", cookie, body: {} })).body);
  assert.equal(waiting.waiting, true, "bounded: it comes back while the page still waits");
  assert.match(waiting.say, /hasn't moved on yet/);
  setTimeout(() => { h.b.cur = ORDERS; }, 30);
  const moved = JSON.parse((await req(h.token, "approved", { method: "POST", cookie, body: {} })).body);
  assert.equal(moved.moved, true);
  assert.equal(h.b.did.length, did, "nothing on the page was clicked, typed or pressed");
});

// ---------------------------------------------------------------- 4d: a code box beside the password
test("4d: a code box beside the password is its own labelled box, typed into its own box before one Enter", async () => {
  const h = make(PW, [PW_CODE(3), ORDERS]);
  const cookie = await start(h.token);
  await view(h, cookie);
  const { v } = await submit(h, cookie, "password", TYPED_PASSWORD);
  assert.equal(v.meta.np.step, "password_code");
  assert.match(v.meta.np.html, /<span>Password<\/span><input id="np-in" type="password"/);
  assert.match(v.meta.np.html, /<span>The code<\/span><input id="np-in2"[^>]*autocomplete="one-time-code"/);
  assert.match(v.meta.said, /Enter the code we sent to \[email\]/);
  assert.equal((await relay(h, cookie, { step: "password_code", text: TYPED_PASSWORD })).error ? "refused" : "", "refused", "both boxes or nothing");
  const before = h.b.did.length;
  const r = await relay(h, cookie, { step: "password_code", text: TYPED_PASSWORD, code: "123 456" });
  assert.equal(r.entered, true);
  const did = h.b.did.slice(before);
  assert.deepEqual(did.filter(d => d[0] === "type").map(d => d[1]), ["123456", TYPED_PASSWORD], "the code cleaned, each in its box");
  assert.equal(did.filter(d => d[0] === "press" && d[1] === "Enter").length, 1);
});

// ---------------------------------------------------------------- 4f: the outcome line
test("4f: a link that runs out after submits says what the site showed last, and never 'before anything went through'", async () => {
  const h = make(EMAIL, [PW, PW_PICTURE(3)]);
  const cookie = await start(h.token);
  await view(h, cookie);
  await submit(h, cookie, "email", TYPED_EMAIL);
  await submit(h, cookie, "password", TYPED_PASSWORD);
  // The session clock runs out (the last timer booked is the session's).
  await remote.endAllRemoteSignins("timed_out");
  const n = notes().at(-1);
  assert.match(n, /after 2 submits on it/);
  assert.match(n, /Amazon last showed a picture check/);
  assert.match(n, /"Important Message! To better protect your account/);
  assert.match(n, /timed out without signing you in/);
  assert.doesNotMatch(n, /before anything went through/);
  assert.ok(!n.includes(TYPED_EMAIL) && !n.includes(TYPED_PASSWORD));
});

test("the live page's scripts (the picture's and the panel's) are valid JavaScript, on both pages", async () => {
  for (const mode of ["owner", "off"]) {
    process.env.REASON_SOCIAL_SIGNIN = mode;
    const h = make(PW, []);
    const cookie = await start(h.token);
    const html = String((await req(h.token, "", { cookie })).body);
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length >= 1);
    for (const js of scripts) assert.doesNotThrow(() => new Function(js), `a script on the ${mode} page parses`);
    if (mode === "owner") assert.match(html, /id="np-site"/, "the line the site's words go in is on the page");
    await remote.endAllRemoteSignins("replaced");
  }
  process.env.REASON_SOCIAL_SIGNIN = "owner";
});
