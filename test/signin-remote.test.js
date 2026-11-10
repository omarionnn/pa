// Signing in from a phone: a link that shows somebody Reason's own browser. No browser is started
// here — the browser is a stand-in that records what it was asked to do — and no site is touched.
//
//   does a link preview, or a second person with the link, get the session?   (no — first Start, one device)
//   is anything that was typed kept anywhere?                                  (no — not the log, the database, or the session)
//   does anything in a field ever travel back to the phone?                    (no — positions, kinds and labels only)
//   is "signed in" ever what the person said rather than what the site said?   (no — the site is asked at every ending)
//   does an unopened link hold the saved profile?                              (no — nothing launches before Start)
//   can a page be driven to arbitrary keys, coordinates or sizes?              (no — a short list, clamped)
//   can the picture fail and leave the person looking at nothing?              (no — every failure has a sentence)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-remote-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
// Reason's own number, so the result page can carry the Back to Reason button.
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";

const remote = await import("../src/signin-remote.js");
const signin = await import("../src/signin.js");
const sites = await import("../src/sites.js");
const { runTool } = await import("../src/tools.js");
const { createServer } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;
const amazon = sites.site("amazon");
const SECRET_TYPED = "hunter2-correct-horse";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM threads; DELETE FROM connected_accounts; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.publicUrl = "https://reason.example";
  config.remoteSigninSettleMs = 0;
});

/** Amazon's real sign-in page, as the reader sees it: one box that takes an email or a number. */
const AMAZON_EMAIL_STEP = {
  url: "https://www.amazon.com/ap/signin?openid.mode=checkid_setup",
  text: "Sign in or create account\nEnter mobile number or email\nContinue\nBy continuing, you agree to Amazon's Conditions of Use and Privacy Notice.\nNeed help?",
  fields: [{ x: 0.12, y: 0.3, w: 0.76, h: 0.06, tag: "input", type: "email", ac: "", name: "email", id: "ap_email_login", label: "Enter mobile number or email", im: "", ml: 0, len: 0, focused: false }],
};
/** What it looks like once they are through: no boxes, an account page. */
const AMAZON_SIGNED_IN = {
  url: "https://www.amazon.com/your-orders/orders",
  text: "Your Orders\nHello, Omari\nOrders Buy Again Not Yet Shipped Cancelled Orders\nOrder placed September 29, 2026 Total $41.18 Ship to Omari\nArriving tomorrow",
  fields: [],
};

/** A browser that does nothing but write down what it was asked, and show what it is told to. */
function fakeBrowser({ frames = [AMAZON_EMAIL_STEP], shot = null } = {}) {
  const did = [];
  let i = 0;
  const b = { did, launched: [], closed: 0, shots: 0, shotFails: 0, frames };
  const page = {
    screenshot: async (o) => {
      did.push(["screenshot", o]);
      b.shots++;
      if (b.shotFails > 0) { b.shotFails--; throw new Error("Target page, context or browser has been closed"); }
      // The same bytes while nothing on the page moves, which is what makes a mark worth keeping.
      return shot ?? Buffer.from([0xff, 0xd8, 0xff, 0xe0, b.vary ? b.shots & 0xff : 0x2a]);
    },
    evaluate: async () => b.frames[Math.min(i++, b.frames.length - 1)],
    mouse: { click: async (x, y) => { did.push(["click", x, y]); }, wheel: async (dx, dy) => { did.push(["wheel", dx, dy]); } },
    keyboard: { type: async (t) => { did.push(["type", t]); }, press: async (k) => { did.push(["press", k]); } },
    goBack: async () => { did.push(["back"]); },
  };
  b.launch = async (a) => { b.launched.push(a); return { page, close: async () => { b.closed++; } }; };
  return b;
}

function make({ conversationId = CONV, entry = amazon, afterSignedIn = "", said = { ok: true, state: "signed_in", why: "the order history page loaded" }, busy = () => null, launch = null, frames } = {}) {
  const b = fakeBrowser(frames ? { frames } : {});
  const logs = [];
  const booked = [];
  const released = [];
  const timers = { set: (fn, ms) => { const h = { fn, ms, cleared: false }; booked.push(h); return h; }, clear: (h) => { if (h) h.cleared = true; } };
  const checks = [];
  const out = remote.createRemoteSignin({
    conversationId, entry, afterSignedIn, launch: launch ?? b.launch, timers, busy, log: (e) => logs.push(e),
    closeBrowser: async (c) => { released.push(c); },
    check: async (page, c, site) => { checks.push([c, site]); return said; },
  });
  const token = out.url.split("/").pop();
  return { out, token, b, logs, booked, released, checks };
}

const req = (token, action = "", { method = "GET", cookie = "", body = null, raw = null, query = {}, tell = null, headers = {} } = {}) =>
  remote.remoteRequest({ token, action, method, headers: { ...headers, ...(cookie ? { cookie } : {}) }, query, tell, readBody: async () => (raw !== null ? raw : body === null ? "" : JSON.stringify(body)) });

/** Tap Start on the person's own proved Reason browser, and come back with the cookie that browser was given. */
async function start(token, conversationId = CONV) {
  const r = await req(token, "start", { method: "POST", cookie: provedCookie(conversationId) });
  const cookie = String(r.headers["Set-Cookie"] ?? "").split(";")[0];
  return { r, cookie };
}
const notes = (c = CONV) => db.db.prepare("SELECT note FROM timers WHERE conversation_id = ? ORDER BY id").all(c).map(r => r.note);

/** Unpack one /view answer the way the page does: a length, the JSON, then the picture. */
function unpack(res) {
  assert.ok(Buffer.isBuffer(res.body), "a view is bytes");
  const n = res.body.readUInt32BE(0);
  const meta = JSON.parse(res.body.subarray(4, 4 + n).toString("utf8"));
  return { meta, jpeg: res.body.subarray(4 + n) };
}
const view = async (token, cookie, h = "") => unpack(await req(token, "view", { cookie, query: { h } }));

// ---------- the link ----------

test("a link is an address under the public URL, and making one launches nothing", () => {
  const { out, token, b, released } = make();
  assert.equal(out.ok, true);
  assert.equal(out.url, `https://reason.example/s/${token}`);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, "24 random bytes: not guessable, not enumerable");
  assert.equal(out.good_for_minutes, 10);
  assert.equal(out.reachable_from_a_phone, true);
  assert.equal(b.launched.length, 0, "an unopened link never holds the saved profile");
  assert.deepEqual(released, []);
  assert.deepEqual(remote.remoteSessionFor(CONV), { site: "amazon", started: false });
});

test("with no public address the link is made, and says it only opens on the machine", () => {
  config.publicUrl = "";
  const { out } = make();
  assert.equal(out.reachable_from_a_phone, false);
  assert.match(out.url, /^http:\/\/127\.0\.0\.1:\d+\/s\//);
  assert.match(out.why, /only opens on the machine/);
});

test("opening the link shows what it is and waits for a tap — a link preview takes nothing", async () => {
  const { token, b } = make();
  // What a preview fetcher, a crawler, or the person themselves sees first.
  for (let i = 0; i < 3; i++) {
    const page = await req(token);
    assert.equal(page.status, 200);
    assert.match(page.body, /Sign in to Amazon/);
    // The paper store sign-in (src/pages/setupsignin.js), the same page a web setup gets.
    assert.match(page.body, /Sign in to Amazon\.<br><em>Just this once\.<\/em>/);
    assert.match(page.body, /never your password/);
    assert.match(page.body, /passkeys and Face ID on Amazon don(&#39;|')t/);
    assert.match(page.body, /class="pf-hd"/);
    assert.doesNotMatch(page.body, /class="sheet"/, "not the plain page any more (owner, 2026-11-10: the paper one everywhere)");
    assert.match(page.body, new RegExp(`action="/s/${token}/start"`));
    assert.equal(page.headers["Cache-Control"], "no-store");
    // The phone's preview of the link: "Secured by Reason", the action only. Amazon's link carries its own card (owner, 2026-11-10); other sites keep "Sign in securely" (test/secured-card.test.js).
    assert.match(page.body, /<meta property="og:title" content="Connect Amazon">/);
    assert.match(page.body, /<meta property="og:image" content="[^"]+\/web\/og\/secured\/amazon\.png\?v=\d+">/);
    assert.doesNotMatch(page.body.slice(0, page.body.indexOf("<title>")), /Omari|12025551234|og:url/, "the card names nobody");
  }
  assert.equal(b.launched.length, 0, "three fetches and still no browser, and nobody owns the session");
  assert.equal((await req(token, "view")).status, 404, "and nothing can be driven before Start");
});

test("the start page says plainly that a saved login will not come up on its own", async () => {
  // The honest version of the thing the owner asked for. A phone files a saved login under the
  // site's own address, and this page is not on it, so the login is two taps away and not none.
  const { token } = make();
  const page = await req(token);
  assert.match(page.body, /your saved Amazon login won(&#39;|')t pop up by itself/);
  assert.match(page.body, /tap Passwords above the keyboard and pick Amazon/);
});

test("Start launches the person's own profile on the site's sign-in page and hands that device the session", async () => {
  const { token, b, released, booked, logs } = make();
  const { r, cookie } = await start(token);
  assert.equal(r.status, 303);
  assert.equal(r.headers.Location, `/s/${token}`);
  assert.deepEqual(released, [CONV], "Reason's own browser let go of the profile first");
  assert.deepEqual(b.launched, [{ conversationId: CONV, url: amazon.signin_url }]);

  const set = r.headers["Set-Cookie"];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /; Secure/, "over https, so it is never sent in the clear");
  assert.match(set, new RegExp(`Path=/s/${token}`), "and to no other address");
  assert.doesNotMatch(set, new RegExp(token.slice(0, 8) + "="), "the cookie's name does not give the link away");

  assert.equal(booked.at(-1).ms, config.remoteSigninSessionMs, "the session clock starts now");
  assert.ok(logs.some(l => l.signin_remote === "started" && l.site === "amazon"));

  const live = await req(token, "", { cookie });
  assert.equal(live.status, 200);
  assert.match(live.body, /id="v"/);
  assert.deepEqual(remote.remoteSessionFor(CONV), { site: "amazon", started: true });
});

test("a second device with the same link gets nothing at all", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  // Forwarded, screenshotted, or lifted from a log: the link without the cookie.
  for (const [action, opts] of [["", {}], ["view", {}], ["start", { method: "POST" }], ["tap", { method: "POST", body: { x: 0.5, y: 0.5 } }], ["type", { method: "POST", body: { text: "x" } }], ["done", { method: "POST" }], ["cancel", { method: "POST" }]]) {
    const r = await req(token, action, opts);
    assert.equal(r.status, 404, `${action || "page"} is a plain 404`);
  }
  for (const wrong of ["rs_x=y", cookie.replace(/=.*/, "=not-the-secret"), cookie.slice(0, -2) + "zz"]) {
    assert.equal((await req(token, "view", { cookie: wrong })).status, 404);
  }
  assert.equal(b.did.length, 0, "and the browser was never touched");
  assert.equal(b.launched.length, 1, "nor started a second time");
  assert.equal((await req(token, "view", { cookie })).status, 200, "while the first device carries on");
});

test("a link that does not exist and one that is malformed are the same 404", async () => {
  for (const t of ["A".repeat(32), "short", "../../etc/passwd", "", "a".repeat(200)]) {
    const r = await req(t);
    assert.equal(r.status, 404);
    assert.match(r.body, /no longer good/);
  }
});

// ---------- the page a phone gets ----------

test("the live page has no typing box of its own and no row of keys to learn", async () => {
  // What the owner said about the first one: "terrible and not intuitive at all". The toolbar is
  // the thing that went. Everything typed now goes into a box sitting on the site's own box.
  const { token } = make();
  const { cookie } = await start(token);
  const body = (await req(token, "", { cookie })).body;
  assert.doesNotMatch(body, /Type here, then Send/);
  assert.doesNotMatch(body, />Send</);
  assert.doesNotMatch(body, />Tab</);
  assert.doesNotMatch(body, /Tap the picture to tap the page/);
  assert.doesNotMatch(body, /autocomplete="off"/, "nothing on this page tells a phone to offer nothing");
  // One line of guidance, one Back, and a way to finish or stop by hand. That is the whole of it.
  assert.match(body, /Tap the page and sign in the way you normally would/);
  assert.match(body, /id="back"/);
  assert.match(body, /id="done"/);
  assert.match(body, /id="stop"/);
});

test("the four native boxes carry the hints that make a phone offer something", async () => {
  const { token } = make();
  const { cookie } = await start(token);
  const body = (await req(token, "", { cookie })).body;
  assert.match(body, /id="in-u"[^>]*autocomplete="username"/, "a name box asks for a saved login");
  assert.match(body, /id="in-p" type="password" autocomplete="current-password"/, "a password box asks for the saved password");
  assert.match(body, /id="in-o"[^>]*autocomplete="one-time-code"[^>]*inputmode="numeric"/, "a code box takes the code out of Messages");
  assert.match(body, /<form id="f" autocomplete="on" onsubmit="return false">/, "they live in one form, and it submits nowhere");
  assert.doesNotMatch(body, /<form[^>]*action="http/, "and it is a window onto the site's form, never one of Reason's own");
});

test("the picture is the shape of the browser behind it, and says so before it has one", async () => {
  const { token } = make();
  const { cookie } = await start(token);
  const body = (await req(token, "", { cookie })).body;
  assert.match(body, new RegExp(`--ss-ar:${remote.VIEW.width}/${remote.VIEW.height}`), "filled to the width, never stretched");
  assert.match(body, /id="veil"/);
  assert.match(body, /Opening Amazon…/, "a loading state, not an empty rectangle");
});

// ---------- which box is which, and what the phone is told about it ----------

test("the kind of a box is read from what the site says about it", () => {
  const k = remote.fieldKind;
  assert.equal(k({ type: "password", name: "password" }), "password");
  assert.equal(k({ type: "text", name: "ap_password", label: "Password" }), "password", "whatever the type attribute says");
  assert.equal(k({ type: "text", name: "code", label: "Enter OTP" }), "otp");
  assert.equal(k({ type: "text", ac: "one-time-code" }), "otp");
  assert.equal(k({ type: "text", label: "Verification code" }), "otp");
  assert.equal(k({ type: "tel", ml: 6, im: "numeric", label: "" }), "otp", "a short numbers-only box is a code whatever it is called");
  assert.equal(k({ type: "email", name: "email", label: "Enter mobile number or email" }), "email");
  assert.equal(k({ type: "tel", name: "phoneNumber", label: "Mobile number" }), "tel");
  assert.equal(k({ type: "text", name: "username", label: "Username" }), "username");
  assert.equal(k({ type: "text", name: "street", label: "Street address" }), "text");
  assert.equal(k({}), "text", "and nothing at all is still an answer");
  // "email code" is a code, not an email. Order matters and this is the case that proves it.
  assert.equal(k({ type: "text", label: "Enter the email code we sent" }), "otp");
});

test("the hints each kind is given are the ones a phone acts on", () => {
  const h = remote.hintsFor;
  assert.deepEqual(h("password"), { slot: "p", type: "password", autocomplete: "current-password", inputmode: "", enterkeyhint: "go", autocapitalize: "off" });
  assert.equal(h("otp").autocomplete, "one-time-code", "iOS offers a code from Messages for this, whatever the address is");
  assert.equal(h("otp").inputmode, "numeric");
  for (const kind of ["email", "tel", "username"]) {
    assert.equal(h(kind).autocomplete, "username", `${kind} asks for a saved login`);
    assert.equal(h(kind).slot, "u");
  }
  assert.equal(h("email").inputmode, "email");
  assert.equal(h("tel").inputmode, "tel");
  // Amazon's one box takes a number OR an email, so a type that would refuse the number is wrong.
  assert.equal(h("email").type, "text", "the keyboard is chosen with inputmode, not with a rule that rejects");
  assert.notEqual(h("text").autocomplete, "off", "the default never tells a phone to offer nothing");
});

test("what the phone is told about a field is where it is and what it is — never what is in it", () => {
  const f = remote.frameFor({
    url: "https://www.amazon.com/ap/signin",
    text: "Sign in",
    fields: [{ x: 0.1, y: 0.2, w: 0.8, h: 0.05, type: "password", name: "password", label: "Password", len: 21, focused: true, value: SECRET_TYPED }],
  });
  const out = JSON.stringify(f);
  assert.doesNotMatch(out, new RegExp(SECRET_TYPED), "no value of any field goes back, password or not");
  assert.doesNotMatch(out, /"value"/);
  assert.equal(f.fields[0].k, "password");
  assert.equal(f.fields[0].ac, "current-password");
  assert.equal(f.fields[0].len, 21, "how many characters, which is all the page needs to know to clear it");
  assert.equal(f.fields[0].on, true);
  assert.equal(f.fields[0].lb, "Password");
});

test("a page with nothing on it is called blank rather than shown as a white rectangle", () => {
  // The whole of what went wrong on the owner's phone was a picture with nothing in it and no
  // sentence anywhere saying so.
  assert.equal(remote.frameFor({ url: "about:blank", text: "", fields: [] }).blank, true);
  assert.equal(remote.frameFor({ url: "", text: "", fields: [] }).blank, true);
  assert.equal(remote.frameFor({ url: "https://amazon.com/x", text: "  ", fields: [] }).blank, true);
  assert.equal(remote.frameFor(AMAZON_EMAIL_STEP).blank, false);
  assert.equal(remote.frameFor({ url: "https://x.com", text: "", fields: AMAZON_EMAIL_STEP.fields }).blank, false, "a form with no text is still something");
});

test("the list of fields is clamped, so a page of a thousand boxes cannot become the answer", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ x: 0, y: i / 300, w: 0.5, h: 0.02, type: "text", name: `f${i}`, len: 0 }));
  const f = remote.frameFor({ url: "https://x.com", text: "lots of boxes here indeed", fields: many });
  assert.equal(f.fields.length, 12);
  assert.ok(JSON.stringify(f).length < 4000, "and stays small enough to send with every picture");
});

// ---------- driving it ----------

test("one answer carries the picture and the shape of the form, and repeats neither", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);

  const res = await req(token, "view", { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/octet-stream");
  assert.equal(res.headers["Cache-Control"], "no-store");
  const { meta, jpeg } = unpack(res);
  assert.ok(jpeg.length > 0, "the picture is in there");
  assert.equal(meta.same, false);
  assert.equal(meta.fields.length, 1);
  assert.equal(meta.fields[0].k, "email", "Amazon's one box, read as a name box");
  assert.equal(meta.fields[0].ac, "username");
  assert.ok(meta.h, "and a mark for the picture the phone now has");

  // The same picture again costs the JSON and nothing else: one round trip on a weak signal is
  // what this whole path lives or dies by.
  const again = await view(token, cookie, meta.h);
  assert.equal(again.meta.same, true);
  assert.equal(again.jpeg.length, 0);
  assert.equal(again.meta.fields.length, 1, "the form still comes, because it can change without the picture's mark changing");
  const stale = await view(token, cookie, "not-the-right-mark");
  assert.equal(stale.meta.same, false);
  assert.ok(stale.jpeg.length > 0);
});

test("a tap lands where they tapped, a drag scrolls, Back goes back", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  await req(token, "tap", { method: "POST", cookie, body: { x: 0.5, y: 0.25 } });
  assert.deepEqual(b.did.at(-1), ["click", Math.round(0.5 * remote.VIEW.width), Math.round(0.25 * remote.VIEW.height)]);
  await req(token, "scroll", { method: "POST", cookie, body: { dy: 420 } });
  assert.deepEqual(b.did.at(-1), ["wheel", 0, 420]);
  await req(token, "back", { method: "POST", cookie });
  assert.deepEqual(b.did.at(-1), ["back"]);
  await req(token, "key", { method: "POST", cookie, body: { key: "Enter" } });
  assert.deepEqual(b.did.at(-1), ["press", "Enter"]);
});

test("what cannot be a tap, a key or a scroll is refused before the browser hears of it", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  const before = b.did.length;
  const post = (action, body) => req(token, action, { method: "POST", cookie, body });
  assert.equal((await post("tap", { x: 1.2, y: 0.5 })).status, 400);
  assert.equal((await post("tap", { x: "left", y: 0.5 })).status, 400);
  assert.equal((await post("tap", {})).status, 400);
  assert.equal((await post("key", { key: "Meta+Q" })).status, 400);
  assert.equal((await post("key", { key: "F12" })).status, 400);
  assert.equal((await post("type", {})).status, 400);
  assert.equal((await post("type", { text: "" })).status, 400);
  assert.equal((await post("type", { text: "x".repeat(501) })).status, 400);
  assert.equal((await post("type", { text: ["a"] })).status, 400);
  assert.equal((await post("type", { at: { x: 5, y: 0.5 }, text: "x" })).status, 400, "and a cursor cannot be put off the picture either");
  assert.equal((await post("navigate", { url: "https://evil.example" })).status, 404, "there is no way to send it somewhere by address");
  assert.equal(b.did.length, before);

  await post("scroll", { dy: 999_999, dx: -999_999 });
  assert.deepEqual(b.did.at(-1), ["wheel", -2000, 2000], "a scroll is clamped, not trusted");
  await post("type", { del: 999_999, text: "a" });
  assert.equal(b.did.filter(d => d[0] === "press" && d[1] === "Backspace").length, 500, "and so is a rubbing-out");
  const bad = await remote.remoteRequest({ token, action: "tap", method: "POST", headers: { cookie }, readBody: async () => "{not json" });
  assert.equal(bad.status, 400);
});

test("typing is carried in as it happens: the cursor goes to the box, then only the difference", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  const post = (body) => req(token, "type", { method: "POST", cookie, body });

  // First keystrokes in a box they just tapped: put the cursor there, clear what was in it, type.
  await post({ at: { x: 0.5, y: 0.33 }, all: true, text: "om" });
  assert.deepEqual(b.did.slice(-4), [
    ["click", Math.round(0.5 * remote.VIEW.width), Math.round(0.33 * remote.VIEW.height)],
    ["press", "ControlOrMeta+a"], ["press", "Backspace"], ["type", "om"],
  ], "in that order, or the clear wipes what was just typed");

  // Carrying on in the same box: no click, no clear, just the new characters.
  b.did.length = 0;
  await post({ del: 0, text: "ari@" });
  assert.deepEqual(b.did, [["type", "ari@"]]);

  // A deletion is a deletion, not a retyping of the whole thing.
  b.did.length = 0;
  await post({ del: 2, text: "" });
  assert.deepEqual(b.did, [["press", "Backspace"], ["press", "Backspace"]]);

  // And the middle of a word: rub out the tail, put the new tail on.
  b.did.length = 0;
  await post({ del: 3, text: "xyz!" });
  assert.deepEqual(b.did, [["press", "Backspace"], ["press", "Backspace"], ["press", "Backspace"], ["type", "xyz!"]]);
});

test("a phone filling in a saved pair puts each half in its own box", async () => {
  // The name box was tapped; the password box never was. It has to say where it goes, or the
  // password is typed into the name box.
  const { token, b } = make();
  const { cookie } = await start(token);
  await req(token, "type", { method: "POST", cookie, body: { at: { x: 0.5, y: 0.3 }, text: "omari@example.com" } });
  await req(token, "type", { method: "POST", cookie, body: { at: { x: 0.5, y: 0.45 }, text: SECRET_TYPED } });
  const clicks = b.did.filter(d => d[0] === "click");
  assert.equal(clicks.length, 2);
  assert.notDeepEqual(clicks[0], clicks[1], "two boxes, two places");
  assert.deepEqual(b.did.at(-1), ["type", SECRET_TYPED]);
});

test("what they type reaches the page and is kept nowhere else", async () => {
  const { token, b, logs } = make();
  const { cookie } = await start(token);
  const typed = await req(token, "type", { method: "POST", cookie, body: { at: { x: 0.5, y: 0.3 }, text: SECRET_TYPED } });
  assert.equal(typed.status, 200);
  assert.deepEqual(b.did.at(-1), ["type", SECRET_TYPED], "the site's own page got it");
  assert.doesNotMatch(typed.body, new RegExp(SECRET_TYPED), "it is not echoed back");

  // And it is not in the picture answer either, which is the one that comes back every second.
  const v = await view(token, cookie);
  assert.doesNotMatch(JSON.stringify(v.meta), new RegExp(SECRET_TYPED));

  const done = await req(token, "done", { method: "POST", cookie });
  assert.equal(JSON.parse(done.body).state, "signed_in");

  // Everything this process keeps: its log lines, every row of every table, the result page.
  const everywhere = [
    JSON.stringify(logs),
    ...db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => JSON.stringify(db.db.prepare(`SELECT * FROM "${t.name}"`).all())),
    (await req(token)).body,
    JSON.stringify(remote.remoteSessionFor(CONV)),
  ].join("\n");
  assert.doesNotMatch(everywhere, new RegExp(SECRET_TYPED), "not in the log, not in the database, not on the page");
  assert.equal(/password|hunter/i.test(JSON.stringify(logs)), false);
});

test("a picture that cannot be taken is said out loud, not left blank", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  b.shotFails = 1;
  const bad = await req(token, "view", { cookie });
  assert.equal(bad.status, 503, "a failure the page can see, rather than an empty answer");
  assert.match(JSON.parse(bad.body).why, /closed/);
  // And it recovers by itself on the next try, which is why the page keeps trying.
  assert.equal((await req(token, "view", { cookie })).status, 200);
});

// ---------- how it ends ----------

test("the site looking signed in finishes the session on its own, and the site is still asked", async () => {
  // So that "Done, I'm signed in" is not a step somebody has to find. What is CLAIMED still comes
  // from asking the site properly at the end; this only decides when to stop.
  const { token, b, checks } = make({ frames: [AMAZON_EMAIL_STEP, AMAZON_SIGNED_IN, AMAZON_SIGNED_IN] });
  const { cookie } = await start(token);
  clock.skip(20_000);

  assert.equal((await req(token, "view", { cookie })).status, 200, "still on the sign-in page");
  const second = await req(token, "view", { cookie });
  assert.equal(second.status, 200, "one signed-in reading is not enough");
  assert.equal(unpack(second).meta.same, false);

  const third = await req(token, "view", { cookie });
  assert.equal(third.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(third.body), { over: true, state: "signed_in" });
  assert.deepEqual(checks, [[CONV, "amazon"]], "the account page was loaded and read, as at every other ending");
  assert.equal(b.closed, 1, "and the profile is free for errands again");
  assert.match(notes()[0], /they finished signing in to Amazon through the link you sent, and Amazon says they ARE signed in now/);
});

test("nothing finishes itself in the first few seconds, or while a box is still asking for something", async () => {
  // Two ways to end somebody's sign-in out from under them, both shut.
  const early = make({ frames: [AMAZON_SIGNED_IN] });
  const c1 = (await start(early.token)).cookie;
  for (let i = 0; i < 4; i++) assert.equal((await req(early.token, "view", { cookie: c1 })).status, 200);
  assert.deepEqual(early.checks, [], "too soon after Start to believe a picture");

  const stillAsking = make({
    frames: [{ ...AMAZON_SIGNED_IN, fields: [{ x: 0.1, y: 0.3, w: 0.8, h: 0.05, type: "password", name: "password", label: "Password", len: 0 }] }],
  });
  const c2 = (await start(stillAsking.token)).cookie;
  clock.skip(20_000);
  for (let i = 0; i < 4; i++) assert.equal((await req(stillAsking.token, "view", { cookie: c2 })).status, 200);
  assert.deepEqual(stillAsking.checks, [], "a page with a password box on it is a page mid-sign-in");
});

test("a link made with its own follow-up (afterSignedIn): signed in → that note; still signed out → the ordinary words", async () => {
  const { token } = make({ afterSignedIn: "READ THEIR ORDERS NOTE" });
  const { cookie } = await start(token);
  await req(token, "done", { method: "POST", cookie });
  assert.match(notes()[0], /Amazon says they ARE signed in now \(the order history page loaded\)\. READ THEIR ORDERS NOTE$/);
  assert.doesNotMatch(notes()[0], /pick up whatever they wanted/);
  remote.forgetAllRemoteSignins();
  db.db.exec("DELETE FROM timers");
  const out = make({ afterSignedIn: "READ THEIR ORDERS NOTE", said: { ok: true, state: "signed_out", why: "the account page redirected to sign-in" } });
  const c2 = (await start(out.token)).cookie;
  await req(out.token, "done", { method: "POST", cookie: c2 });
  assert.match(notes()[0], /still NOT signed in/);
  assert.doesNotMatch(notes()[0], /READ THEIR ORDERS/);
});

test("Done asks the SITE, records what it says, frees the profile and tells Reason", async () => {
  const { token, b, checks } = make();
  const { cookie } = await start(token);
  const done = await req(token, "done", { method: "POST", cookie });
  assert.deepEqual(JSON.parse(done.body), { ok: true, ended: true, state: "signed_in" });
  assert.deepEqual(checks, [[CONV, "amazon"]]);
  assert.equal(b.closed, 1, "the browser is closed, so the profile is free for errands again");
  assert.equal(remote.remoteSessionFor(CONV), null);

  assert.equal(notes().length, 1);
  assert.match(notes()[0], /Amazon says they ARE signed in now \(the order history page loaded\)/);

  const page = await req(token, "", { cookie });
  assert.match(page.body, /You&#39;re signed in to Amazon|You're signed in to Amazon/);
  assert.equal((await req(token, "view", { cookie })).status, 410, "and the session is over");
  assert.equal((await req(token, "start", { method: "POST" })).status, 404, "for good — it cannot be started again");
});

test("Cancel ends it by hand, and the site is asked on the way out like every other ending", async () => {
  const { token, b, checks } = make({ said: { ok: true, state: "signed_out", why: "the account page redirected to sign-in" } });
  const { cookie } = await start(token);
  const r = await req(token, "cancel", { method: "POST", cookie });
  assert.deepEqual(JSON.parse(r.body), { ok: true, ended: true, state: "signed_out" });
  assert.deepEqual(checks, [[CONV, "amazon"]]);
  assert.equal(b.closed, 1);
  assert.match(notes()[0], /closed it without finishing/);
  assert.match(notes()[0], /still NOT signed in/);
});

test("tapping Done without signing in is 'not signed in', whatever the button was called", async () => {
  const { token } = make({ said: { ok: true, state: "signed_out", why: "the account page redirected to sign-in" } });
  const { cookie } = await start(token);
  await req(token, "done", { method: "POST", cookie });
  assert.match(notes()[0], /still NOT signed in \(the account page redirected to sign-in\)/);
  assert.match(notes()[0], /offer a fresh link/);
  assert.match((await req(token, "", { cookie })).body, /Not signed in to Amazon/);
});

test("a page that could not be read is 'could not tell', and nothing is claimed", async () => {
  const { token } = make({ said: { ok: false, error: "the page did not load" } });
  const { cookie } = await start(token);
  await req(token, "done", { method: "POST", cookie });
  assert.match(notes()[0], /could not be read \(the page did not load\)\. Nothing is recorded either way/);
  assert.doesNotMatch(notes()[0], /ARE signed in/);
});

test("a session nobody finishes is ended by the clock — and the site is still asked", async () => {
  const { token, b, booked, checks } = make();
  const { cookie } = await start(token);
  booked.at(-1).fn(); // ten minutes are up
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(checks, [[CONV, "amazon"]], "they may have signed in and put the phone down");
  assert.equal(b.closed, 1);
  assert.match(notes()[0], /timed out before they finished/);
  assert.equal((await req(token, "tap", { method: "POST", cookie, body: { x: 0.5, y: 0.5 } })).status, 410);
});

test("a link nobody opens just lapses: no browser, no message", async () => {
  const { token, b, booked } = make();
  assert.equal(booked[0].ms, config.remoteSigninLinkTtlMs);
  booked[0].fn();
  await new Promise(r => setImmediate(r));
  assert.equal(b.launched.length, 0);
  assert.deepEqual(notes(), [], "not worth a text");
  assert.equal(remote.remoteSessionFor(CONV), null);
  assert.equal((await req(token, "start", { method: "POST" })).status, 404, "and it cannot be started late");
});

test("a new link cancels the old one", async () => {
  const first = make();
  const { cookie } = await start(first.token);
  const second = make();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(first.b.closed, 1, "the old browser is closed");
  assert.equal((await req(first.token, "view", { cookie })).status, 410);
  assert.notEqual(second.token, first.token);
  assert.deepEqual(remote.remoteSessionFor(CONV), { site: "amazon", started: false });
});

test("while the window on the Mac has the profile, Start says so and takes nothing", async () => {
  const { token, b } = make({ busy: () => "A sign-in window is already open on the Mac for this account." });
  const r = await req(token, "start", { method: "POST", cookie: provedCookie(CONV) });
  assert.equal(r.status, 409);
  assert.match(r.body, /already open on the Mac/);
  assert.equal(b.launched.length, 0);
  assert.equal(r.headers["Set-Cookie"], undefined, "and the link is still theirs to start once it is free");
});

test("a browser that will not start ends the link cleanly", async () => {
  const { token, logs } = make({ launch: async () => { throw new Error("Executable doesn't exist"); } });
  const r = await req(token, "start", { method: "POST", cookie: provedCookie(CONV) });
  assert.equal(r.status, 500);
  assert.match(r.body, /Amazon isn(&#39;|')t answering\./);
  assert.match(r.body, /Nothing was lost\./);
  assert.match(r.body, /Ask Reason for a fresh link in a minute/);
  assert.match(r.body, /body=the%20Amazon%20sign-in%20link%20ended"/, "the way back names what happened");
  assert.ok(logs.some(l => l.signin_remote === "launch_failed"));
  assert.equal(remote.remoteSessionFor(CONV), null);
});

test("two people's links are two browsers on two profiles", async () => {
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  const mine = make();
  const theirs = make({ conversationId: THEIRS });
  const a = await start(mine.token);
  const b = await start(theirs.token, THEIRS);
  assert.deepEqual(mine.b.launched[0].conversationId, CONV);
  assert.deepEqual(theirs.b.launched[0].conversationId, THEIRS);
  // One person's cookie does nothing on the other's link.
  assert.equal((await req(theirs.token, "view", { cookie: a.cookie })).status, 404);
  assert.equal((await req(mine.token, "view", { cookie: b.cookie })).status, 404);
  await req(theirs.token, "done", { method: "POST", cookie: b.cookie });
  assert.equal(notes(THEIRS).length, 1);
  assert.equal(notes(CONV).length, 0, "and the news goes to the person who signed in");
});

// ---------- the tool, and the server ----------

test("signin_link hands the model a link and the exact truth about it", async () => {
  const made = [];
  const out = await runTool("signin_link", { site: "amazon" }, {
    conversationId: CONV, channels: null,
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/TOKEN", site: "amazon", good_for_minutes: 10, reachable_from_a_phone: true }; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.link, "https://reason.example/s/TOKEN");
  assert.equal(made[0].conversationId, CONV);
  assert.match(out.what_passes_through, /relayed to the site through you and is never saved, logged or shown to you/);
  assert.match(out.what_passes_through, /not that it never passes through anything/);
  assert.match(out.limits, /Face ID, passkeys and security keys do not/);
  assert.match(out.next, /do not say they are/);
  assert.equal(out.warning, undefined);

  // The receipt says a link was made. It does not hold the link, which is a way in.
  const row = db.db.prepare("SELECT * FROM action_ledger WHERE conversation_id = ?").get(CONV);
  assert.equal(row.action, "signin_link");
  assert.doesNotMatch(JSON.stringify(row), /TOKEN/);
});

test("signin_link works for somebody who is not at the machine, which is the point of it", async () => {
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  const out = await runTool("signin_link", { site: "fandango" }, { conversationId: THEIRS, channels: null });
  assert.equal(out.ok, true);
  assert.match(out.link, /^https:\/\/reason\.example\/s\/[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(remote.remoteSessionFor(THEIRS), { site: "fandango", started: false });

  // And asked for the window instead, they are pointed at the link.
  const win = await runTool("signin_open", { site: "fandango" }, { conversationId: THEIRS, channels: null });
  assert.equal(win.ok, false);
  assert.match(win.use_instead, /signin_link/);
});

test("the honest warnings: no public address, a site that refuses the browser, nobody's conversation", async () => {
  config.publicUrl = "";
  const local = await runTool("signin_link", { site: "doordash" }, { conversationId: CONV, channels: null });
  assert.equal(local.ok, true);
  assert.match(local.warning, /from their phone this link will not open/);
  assert.match(local.site_warning, /DoorDash refuses an automated browser/);
  assert.equal(signin.linkSignin().available, false);

  const nobody = await runTool("signin_link", { site: "amazon" }, { conversationId: "dm:fake:+19990001111", channels: null });
  assert.equal(nobody.ok, false);
  assert.match(nobody.error, /does not belong to anybody/);
  // "netflix" used to be the name nothing knew. It is a real one now: a subscription's web cancel
  // rail signs in exactly the way an errand site does, so signin_link resolves both registries.
  const streaming = await runTool("signin_link", { site: "netflix" }, { conversationId: CONV, channels: null });
  assert.equal(streaming.ok, true, "a service a subscription cancels on gets the same link");
  assert.match((await runTool("signin_link", { site: "blockbuster" }, { conversationId: CONV, channels: null })).error, /No site called/);
});

test("over real HTTP: the page is served, a wrong address is a 404, and nothing answers outside /s/<token>", async () => {
  const { token } = make();
  const server = createServer({ router: { statuses: () => [] }, runtime: null });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/s/${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Sign in to Amazon/);
    assert.equal((await fetch(`${base}/s/${"B".repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${base}/s/`)).status, 404);
    assert.equal((await fetch(`${base}/s/${token}/view`)).status, 404, "no cookie, no picture");
    assert.equal((await fetch(`${base}/s/${token}/../../health`)).status, 200, "and the path cannot be walked out of");
  } finally { await new Promise(r => server.close(r)); }
});

test("over real HTTP: the picture, its mark and the form all survive a real socket", async () => {
  const { token } = make();
  const { cookie } = await start(token);
  const server = createServer({ router: { statuses: () => [] }, runtime: null });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/s/${token}/view`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    const n = buf.readUInt32BE(0);
    const meta = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
    assert.equal(meta.fields[0].ac, "username");
    assert.ok(buf.length > 4 + n, "and the picture came through after it");

    // The mark round-trips through the query string, which is how the phone saves the bytes.
    const same = await fetch(`${base}/s/${token}/view?h=${encodeURIComponent(meta.h)}`, { headers: { cookie } });
    const buf2 = Buffer.from(await same.arrayBuffer());
    const n2 = buf2.readUInt32BE(0);
    assert.equal(JSON.parse(buf2.subarray(4, 4 + n2).toString("utf8")).same, true);
    assert.equal(buf2.length, 4 + n2, "no picture sent twice");
  } finally { await new Promise(r => server.close(r)); }
});

// ---------- a wall where the form should be ----------
//
// 2026-10-15: the owner opened an Uber link from his phone and watched Cloudflare's "Performing
// security verification" spin inside it until the link ended "not signed in". From the server
// Reason runs on, auth.uber.com answers that page with HTTP 403 every time. Spinning is the wrong
// answer and "still shows its sign-in page" is a lie — the sign-in page never loaded.

const UBER_WALL = {
  url: "https://auth.uber.com/v2",
  text: "auth.uber.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.\nRay ID: a4aeccbf3834d11b",
  fields: [],
};

test("a bot check that never clears ends the session as blocked, and nobody is told 'not signed in'", async () => {
  const uber = sites.site("uber");
  const { token, b, checks } = make({ entry: { ...uber, signin_blocked: undefined }, frames: [UBER_WALL, UBER_WALL, UBER_WALL] });
  const { cookie } = await start(token);
  clock.skip(20_000);
  assert.equal((await req(token, "view", { cookie })).status, 200, "one reading of a wall is not enough — a challenge can clear");
  const second = await req(token, "view", { cookie });
  assert.equal(second.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(second.body), { over: true, state: "blocked" });
  assert.deepEqual(checks, [], "the account page is not asked: 'signed out' would be true and beside the point");
  assert.equal(b.closed, 1, "the profile is freed");
  const note = notes()[0];
  assert.match(note, /never got past Uber's bot check/);
  assert.match(note, /a fresh link would hit the same wall/);
  assert.match(note, /uber_link/);
  assert.doesNotMatch(note, /still NOT signed in/);
  const page = await req(token, "", { cookie });
  assert.match(page.body, /Uber is blocking my browser right now\./);
  assert.match(page.body, /Uber(&#39;|')s choice, not something you did, and a fresh link would hit the same wall\. Reason will text you what works instead/);
  assert.doesNotMatch(page.body, /still shows its sign-in page/);
});

test("a wall is only a wall with no box to type in, and never in the first few seconds", () => {
  assert.equal(remote.looksBlocked(UBER_WALL), true);
  assert.equal(remote.looksBlocked({ ...UBER_WALL, fields: [{ type: "text", name: "phone", label: "Phone", len: 0 }] }), false, "a challenge with a form on it is a form");
  assert.equal(remote.looksBlocked({ url: "https://cdn-refusal.example/", text: "403 ERROR The request could not be satisfied. Request blocked.", fields: [] }), true);
  assert.equal(remote.looksBlocked(AMAZON_EMAIL_STEP), false);
  assert.equal(remote.looksBlocked(AMAZON_SIGNED_IN), false);
});

test("a site whose sign-in page refuses this browser gets no link at all — the tool says why and hands over", async () => {
  const link = await runTool("signin_link", { site: "uber" }, { conversationId: CONV, messages: [] });
  assert.equal(link.ok, false);
  assert.equal(link.blocked, true);
  assert.equal(link.link, undefined, "no link is made");
  assert.equal(remote.remoteSessionFor(CONV), null, "and no session is opened");
  assert.match(link.say, /bot check/);
  assert.match(link.say, /not something you did/);
  assert.match(link.handoff, /uber_link/);
  const win = await runTool("signin_open", { site: "uber" }, { conversationId: CONV, messages: [] });
  assert.equal(win.ok, false);
  assert.equal(win.blocked, true);
  assert.match(win.say, /bot check/);
  // Amazon's sign-in page loads from the server, so Amazon still gets a link.
  const fine = await runTool("signin_link", { site: "amazon" }, { conversationId: CONV, messages: [] });
  assert.equal(fine.ok, true);
  assert.ok(fine.link);
});

// ---------- the way back ----------
//
// The result page used to say "you can close this page" and leave them there, which told Reason
// nothing. It ends with a tap that opens Messages with the reply already typed, and it still says
// Reason will text you — both are true, and the tap is the faster of the two.

test("the result page ends with the way back to the thread, not with 'close this page'", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  await req(token, "done", { method: "POST", cookie });
  const page = (await req(token)).body;
  assert.match(page, /href="sms:\+14155550199&amp;body=signed%20in%20to%20Amazon%2C%20keep%20going"[^>]*id="ss-back">Back to Reason </,
    "the reply names the site, so a turn an hour later knows what finished");
  assert.match(page, /Reason will text you/);
  assert.match(page, /opens Messages with your reply typed/);
  assert.doesNotMatch(page, /You can close this page/);
  // On paper, like the setup's (src/pages/setupsignin.js), but the way on is the thread, and nothing moves on its own.
  assert.match(page, /class="pf-stamp">CONNECTED</);
  assert.match(page, /You&#39;re signed in to Amazon\.<br><em>Back to Reason\.<\/em>/);
  assert.doesNotMatch(page, /Back to setup|\/start\/connect/);
  assert.doesNotMatch(page, /location\.href=a\.href/, "no auto-return: there is no setup to return to");
  assert.ok(b);
});

test("a sign-in that did not work says so in the reply, rather than claiming it did", async () => {
  const { token } = make({ said: { ok: true, state: "blocked", why: "a bot check" } });
  const { cookie } = await start(token);
  await req(token, "done", { method: "POST", cookie });
  assert.match((await req(token)).body, /body=Amazon%20blocked%20the%20sign-in"/);
});

// ---------- who may tap Start (security audit lead 6) ----------
//
// The link drives the person's own saved browser profile, which holds every site's session. Holding
// the link is not enough to take it: Start needs the person's own proved Reason browser, or a code
// texted to their own thread, the same rule private pages and trips keep.

/** A Reason Web sign-in (`wsign:`, one of the two #358 trusts) proved for this conversation. */
function provedCookie(conversationId) {
  const t = `sess-${conversationId}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, t, { conversationId });
  return `reason_page=${t}`;
}

test("a stranger's browser with the link cannot take the session, even one signed in to Reason as somebody else", async () => {
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  for (const cookie of ["", provedCookie(THEIRS)]) {
    remote.forgetAllRemoteSignins();
    const told = [];
    const { token, b } = make();
    const r = await remote.remoteRequest({ token, action: "start", method: "POST", headers: cookie ? { cookie } : {}, readBody: async () => "", tell: async (c, text) => { told.push([c, text]); } });
    assert.notEqual(r.status, 303, "Start is not taken on the link alone");
    assert.equal(r.headers?.["Set-Cookie"], undefined, "no browser cookie is handed out");
    assert.equal(b.launched.length, 0, "and the saved profile is never opened");
    for (const [action, body] of [["view", null], ["type", { text: "x" }], ["tap", { x: 0.5, y: 0.5 }]]) {
      const x = await req(token, action, { method: action === "view" ? "GET" : "POST", body });
      assert.equal(x.status, 404, `${action} drives nothing`);
    }
    assert.equal(b.did.length, 0, "the browser was never touched");
  }
});

test("the person's own proved browser starts at once, with no code", async () => {
  const told = [];
  const { token, b } = make();
  const r = await req(token, "start", { method: "POST", cookie: provedCookie(CONV), tell: async (...a) => { told.push(a); } });
  assert.equal(r.status, 303);
  assert.match(r.headers["Set-Cookie"], /^rs_/);
  assert.equal(b.launched.length, 1);
  assert.equal(told.length, 0, "nobody is texted");
});

test("a browser not yet proved gets a code texted to the person's own thread, and only that code starts it", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  const told = [];
  const tell = async (c, text, meta) => { told.push({ c, text, meta }); };
  const { token, b } = make();
  const asked = await req(token, "start", { method: "POST", tell });
  assert.equal(asked.status, 401);
  assert.match(asked.body, /Enter the code Reason texted you/);
  assert.match(asked.body, /autocomplete="one-time-code"/);
  await new Promise(r => setImmediate(r));
  assert.equal(told.length, 1);
  assert.equal(told[0].c, CONV, "the code goes to the person whose profile it is, never to whoever asked");
  assert.ok(db.HISTORY_EXCLUDED_KEYS.some(p => told[0].meta.idempotencyKey.startsWith(p)), "keyed so the code is never a line in their history");
  const code = /code is (\d{6})/.exec(told[0].text)[1];
  assert.match(told[0].text, /Amazon sign-in link/);
  assert.match(told[0].text, /@reason\.example #\d{6}$/, "bound to the site, so the phone offers it above the keyboard");
  assert.doesNotMatch(told[0].text, new RegExp(token), "and the link is not in the text");
  assert.equal(b.launched.length, 0, "nothing opens before the code");

  const wrong = await req(token, "start", { method: "POST", raw: `code=${code === "000000" ? "111111" : "000000"}`, tell });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /That code is not right\. 4 tries left/);
  assert.equal(b.launched.length, 0);

  const right = await req(token, "start", { method: "POST", raw: `code=${code}`, tell });
  assert.equal(right.status, 303);
  assert.match(right.headers["Set-Cookie"][0], /^rs_/);
  assert.equal(b.launched.length, 1);
  const cookie = right.headers["Set-Cookie"][0].split(";")[0];
  assert.equal((await req(token, "view", { cookie })).status, 200, "and that browser is the one that drives it");

  // The code is used up: a second browser with the same code gets nothing.
  assert.equal((await req(token, "start", { method: "POST", raw: `code=${code}`, tell })).status, 404);
});

test("codes are bounded per person: a few texts, a few wrong guesses, and a fresh link resets neither", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  const told = [];
  const tell = async (c, text) => { told.push(text); };
  let { token } = make();
  for (let i = 0; i < 3; i++) assert.equal((await req(token, "start", { method: "POST", raw: "send=1", tell })).status, 401);
  ({ token } = make());
  const fourth = await req(token, "start", { method: "POST", tell });
  assert.equal(fourth.status, 429);
  assert.match(fourth.body, /already texted you a code/);
  await new Promise(r => setImmediate(r));
  assert.equal(told.length, 3, "the phone buzzed three times, not four");

  for (let i = 0; i < 5; i++) await req(token, "start", { method: "POST", raw: "code=999999", tell });
  const locked = await req(token, "start", { method: "POST", raw: "code=999999", tell });
  assert.equal(locked.status, 429);
  assert.match(locked.body, /Too many wrong codes/);
});

test("with no way to text a code, a browser not proved is told to use their own, and nothing opens", async () => {
  const { token, b } = make();
  const r = await req(token, "start", { method: "POST" });
  assert.equal(r.status, 403);
  assert.match(r.body, /signed in to Reason on/);
  assert.equal(b.launched.length, 0);
});

test("over real HTTP: Start on a fresh browser texts the code through the runtime", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  const told = [];
  const { token, b } = make();
  const server = createServer({ router: { statuses: () => [] }, runtime: { _tell: async (c, text) => { told.push([c, text]); } } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/s/${token}/start`, { method: "POST", redirect: "manual" });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("set-cookie"), null);
    await new Promise(res => setTimeout(res, 10));
    assert.equal(told.length, 1);
    assert.equal(told[0][0], CONV);
    const code = /code is (\d{6})/.exec(told[0][1])[1];
    const ok = await fetch(`${base}/s/${token}/start`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `code=${code}` });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get("set-cookie"), /^rs_/);
    assert.equal(b.launched.length, 1);
    // Both cookies arrive over the wire, and the remembered one opens the next link with no code.
    const browser = ok.headers.getSetCookie().find(c => c.startsWith("reason_page="))?.split(";")[0];
    assert.ok(browser, "reason_page set over HTTP");
    const next = make();
    const again = await fetch(`${base}/s/${next.token}/start`, { method: "POST", redirect: "manual", headers: { cookie: browser } });
    assert.equal(again.status, 303);
    assert.equal(next.b.launched.length, 1);
    await new Promise(res => setTimeout(res, 10));
    assert.equal(told.length, 1, "nothing more was texted");
  } finally { await new Promise(r => server.close(r)); }
});

// ---------- a browser proved once is remembered (lead 6, Omari 11-07: the way #358's connect links work) ----------

/** The texted code out of the last thing told. */
const codeOf = (told) => /code is (\d{6})/.exec(told.at(-1).text)[1];
/** The `reason_page` cookie a response set, as a request header value. */
const pageCookieOf = (r) => [].concat(r.headers["Set-Cookie"] ?? []).find(c => c.startsWith("reason_page="))?.split(";")[0] ?? "";

test("first time on a new browser the code is required; after it, the next link on that browser goes straight to Start with nothing texted", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  const told = [];
  const tell = async (c, text, meta) => { told.push({ c, text, meta }); };

  // A new browser: the code step, and nothing opens until the code.
  const first = make();
  const asked = await req(first.token, "start", { method: "POST", tell });
  assert.equal(asked.status, 401);
  assert.match(asked.body, /Enter the code Reason texted you/);
  assert.match(asked.body, /remembers this browser/);
  await new Promise(r => setImmediate(r));
  assert.equal(told.length, 1);
  assert.equal(first.b.launched.length, 0);

  const right = await req(first.token, "start", { method: "POST", raw: `code=${codeOf(told)}`, tell });
  assert.equal(right.status, 303);
  assert.match(right.headers["Set-Cookie"][0], /^rs_/);
  const browser = pageCookieOf(right);
  assert.match(browser, /^reason_page=/, "the right code leaves the browser remembered");
  assert.match(right.headers["Set-Cookie"].find(c => c.startsWith("reason_page=")), /Path=\/; .*Max-Age=\d+; HttpOnly; SameSite=Lax/);
  const { browserConversation } = await import("../src/connectgate.js");
  assert.equal(browserConversation({ cookie: browser }), CONV, "remembered the way #358's connect links prove a browser: one mechanism");

  // The next link (a new link replaces the old one), same browser: straight on, nothing texted.
  const next = make();
  const again = await req(next.token, "start", { method: "POST", cookie: browser, tell });
  assert.equal(again.status, 303);
  assert.equal(typeof again.headers["Set-Cookie"], "string", "only the link's own cookie: nothing new to remember");
  assert.match(again.headers["Set-Cookie"], /^rs_/);
  assert.equal(next.b.launched.length, 1);
  await new Promise(r => setImmediate(r));
  assert.equal(told.length, 1, "no second code was texted");
});

test("a different browser holding only the link is refused, even after the person's own browser was remembered", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  const told = [];
  const tell = async (c, text, meta) => { told.push({ c, text, meta }); };
  const first = make();
  await req(first.token, "start", { method: "POST", tell });
  await new Promise(r => setImmediate(r));
  const mine = pageCookieOf(await req(first.token, "start", { method: "POST", raw: `code=${codeOf(told)}`, tell }));
  assert.ok(mine);

  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  // A page's or an event's code session is not one #358 trusts, so it is not "remembered" either.
  const pageOnly = `pg-${Math.random().toString(36).slice(2)}`;
  db.startPageSession("somepage", pageOnly, { conversationId: CONV });
  for (const cookie of ["", provedCookie(THEIRS), `reason_page=${pageOnly}`, "reason_page=made-up"]) {
    const link = make();
    const r = await req(link.token, "start", { method: "POST", cookie, tell });
    assert.equal(r.status, 401, `refused: ${cookie || "no cookie"}`);
    assert.equal(r.headers["Set-Cookie"], undefined);
    assert.equal(link.b.launched.length, 0, "the saved profile is never opened");
    await new Promise(res => setImmediate(res));
    assert.equal(told.at(-1).c, CONV, "the code goes to the person's own thread, which the link holder does not have");
    // An old code (used up) is no way in either.
    const old = await req(link.token, "start", { method: "POST", cookie, raw: "code=123456", tell });
    assert.notEqual(old.status, 303);
    assert.equal(link.b.launched.length, 0);
    for (const [action, body] of [["view", null], ["type", { text: "x" }]]) {
      assert.equal((await req(link.token, action, { method: action === "view" ? "GET" : "POST", body, cookie })).status, 404);
    }
    db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  }
});

test("a right code posted from another site is refused, so nobody's sign-in can be planted in a victim's browser", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  const told = [];
  const tell = async (c, text) => { told.push({ c, text }); };
  const { token, b } = make();
  await req(token, "start", { method: "POST", tell });
  await new Promise(r => setImmediate(r));
  const r = await req(token, "start", { method: "POST", raw: `code=${codeOf(told)}`, tell, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  assert.equal(r.status, 403);
  assert.equal(r.headers["Set-Cookie"], undefined);
  assert.equal(b.launched.length, 0);
  // The code itself is still good on the link's own page.
  const ok = await req(token, "start", { method: "POST", raw: `code=${codeOf(told)}`, tell });
  assert.equal(ok.status, 303);
});

test("a right code is not used up on a Start the Mac window blocks, and the outbox key carries no link token", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  const told = [];
  const tell = async (c, text, meta) => { told.push({ c, text, meta }); };
  let busy = "A sign-in window is already open on the Mac for this account.";
  const { token, b } = make({ busy: () => busy });
  await req(token, "start", { method: "POST", tell });
  await new Promise(r => setImmediate(r));
  assert.ok(!told[0].meta.idempotencyKey.includes(token.slice(0, 8)), "no part of the link in the outbox key");
  const blocked = await req(token, "start", { method: "POST", raw: `code=${codeOf(told)}`, tell });
  assert.equal(blocked.status, 409);
  assert.equal(b.launched.length, 0);
  busy = null;
  const ok = await req(token, "start", { method: "POST", raw: `code=${codeOf(told)}`, tell });
  assert.equal(ok.status, 303, "the same code still works once the window is closed");
});

// ---------- the restart gate ----------
// A deploy restart at 22:38:55 UTC on 2026-11-10 killed a live Notion sign-in mid-flow. The process
// now says what it holds in data/busy.json, which verify-reason/bin/idle.sh reads before a restart.
test("a sign-in in progress is on the busy file from the link to its end, with no token, number or name on it", async () => {
  const busy = await import("../src/busy.js");
  const { readFileSync } = await import("node:fs");
  const p = join(dir, "busy.json");
  busy.setBusyPath(p);
  busy.resetBusy();
  const read = () => JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(read().items, [], "a fresh process holds nothing");
  assert.equal(read().pid, process.pid, "the file names the pid that wrote it, so a dead process's file says nothing");
  const { token } = make();
  assert.deepEqual(read().items.map(i => [i.kind, i.site]), [["signin_link", "amazon"]], "an unopened link is held: a restart would kill it too");
  const { cookie } = await start(token);
  assert.deepEqual(read().items.map(i => [i.kind, i.site]), [["signin", "amazon"]], "started: its browser is open");
  const raw = readFileSync(p, "utf8");
  assert.ok(!raw.includes(token) && !raw.includes(CONV) && !raw.includes(OWNER), "no token, conversation or number");
  await req(token, "done", { method: "POST", cookie });
  assert.deepEqual(read().items, [], "ended: released");
});

// ---------- Reason's own page (native panel), owner 2026-11-10 ----------
const GOOGLE_EMAIL = { url: "https://accounts.google.com/v3/signin/identifier?client_id=x", text: "Sign in\nto continue to Notion\nEmail or phone\nForgot email?\nNext", fields: [{ x: 0.1, y: 0.4, w: 0.8, h: 0.07, tag: "input", type: "email", ac: "username", name: "identifier", id: "identifierId", label: "Email or phone", im: "", ml: 0, len: 0, focused: true }] };
const NOTION_CHOOSER = { url: "https://www.notion.so/login", text: "Log in to Notion\nContinue with Google\nContinue with Apple\nContinue with Microsoft\nContinue with email", fields: [] };
test("native page: where the flag reaches them the panel follows the real page step by step, the chooser presses the real button, and nothing typed comes back", async () => {
  process.env.REASON_SOCIAL_SIGNIN = "owner";
  try {
    const b = fakeBrowser({ frames: [NOTION_CHOOSER, NOTION_CHOOSER, GOOGLE_EMAIL, GOOGLE_EMAIL] });
    const pressed = [];
    const out = remote.createRemoteSignin({
      conversationId: CONV, entry: sites.site("amazon"), launch: b.launch, log: () => {},
      timers: { set: () => ({}), clear: () => {} }, check: async () => ({ ok: true, state: "signed_in", why: "x" }),
      pressProvider: async (_page, p) => { pressed.push(p); return { pressed: `Continue with ${p}` }; },
    });
    const token = out.url.split("/").pop();
    const { cookie } = await start(token);
    const live = await req(token, "", { cookie });
    assert.match(live.body, /id="np-panel"/, "the native page, not only the picture");
    assert.match(live.body, /Show me the page/, "the streamed page stays as the fallback");
    let v = await view(token, cookie);
    assert.equal(v.meta.np.step, "chooser");
    assert.match(v.meta.np.html, /Continue with Google/);
    assert.doesNotMatch(v.meta.np.html, /Continue with Facebook/, "only the providers the site offers");
    v = await view(token, cookie, v.meta.h);
    assert.equal(v.meta.np.html, undefined, "an unchanged step does not resend the panel");
    const r = await req(token, "provider", { method: "POST", cookie, body: { p: "google" } });
    assert.equal(JSON.parse(r.body).pressed, true);
    assert.deepEqual(pressed, ["google"], "the real page's own button was pressed, nothing else");
    assert.equal((await req(token, "provider", { method: "POST", cookie, body: { p: "evil.com" } })).status, 400, "only the four providers");
    v = await view(token, cookie);
    assert.equal(v.meta.np.step, "email");
    assert.equal(v.meta.np.page, false, "the email step is native; the picture stays tucked away");
    await req(token, "type", { method: "POST", cookie, body: { at: { x: 0.5, y: 0.43 }, all: true, text: SECRET_TYPED } });
    v = await view(token, cookie);
    assert.ok(!JSON.stringify(v.meta).includes(SECRET_TYPED), "what was typed never travels back in the panel");
    assert.ok(b.did.some(d => d[0] === "type" && d[1] === SECRET_TYPED), "it went to the real page");
    await req(token, "cancel", { method: "POST", cookie });
  } finally { delete process.env.REASON_SOCIAL_SIGNIN; }
});
test("native page: without the flag the picture page is unchanged and /view carries no panel", async () => {
  delete process.env.REASON_SOCIAL_SIGNIN;
  const { token } = make();
  const { cookie } = await start(token);
  assert.doesNotMatch((await req(token, "", { cookie })).body, /id="np-panel"/);
  assert.equal((await view(token, cookie)).meta.np, undefined);
  assert.equal((await req(token, "provider", { method: "POST", cookie, body: { p: "google" } })).status, 400);
});
