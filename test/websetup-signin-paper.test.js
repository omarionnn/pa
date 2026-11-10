// The web setup's Amazon sign-in, drawn on paper (src/pages/setupsignin.js): the intro, the wait while
// Reason's browser opens, the live picture in the paper frame, signed in (back to the setup on its own),
// and every way it can fail (same way back). A sign-in link from a text thread gets the same paper pages,
// with Back to Reason (Messages, the reply typed) as its way on and no auto-return.
// No browser is started: a stand-in records what it is asked.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-websetup-paper-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_WEB_SETUP = "on";
process.env.REASON_TOKEN_KEY = "45".repeat(32);
// Reason's own number, so a text thread's result page can carry Back to Reason.
process.env.SENDBLUE_FROM_NUMBER = "+1 (415) 555-0199";

const ws = await import("../src/websetup.js");
const store = await import("../src/websetupstore.js");
const amazon = await import("../src/amazonconnect.js");
const remote = await import("../src/signin-remote.js");
const sites = await import("../src/sites.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  ws.resetLimits();
  process.env.REASON_WEB_SETUP = "on";
  config.publicUrl = "https://reason.example.test";
  config.siteUrl = "";
  config.remoteSigninSettleMs = 0;
  db.db.exec("DELETE FROM accounts; DELETE FROM timers; DELETE FROM action_ledger; DELETE FROM web_setups;");
});

const cookieOf = (res) => /rs_setup=([^;]+)/.exec(String(res.headers["Set-Cookie"] ?? ""))?.[1];
async function newSetup(headers = {}) {
  const made = await ws.request({ method: "POST", path: "/api/new", headers: { host: "reason.example.test", ...headers }, remoteAddress: "1.2.3.4", readBody: async () => "" });
  const id = JSON.parse(made.body).id;
  return { id, cookie: cookieOf(made), conv: `websetup:${id}` };
}

/** A browser stand-in and a site check that says what it is told. */
function seams({ said = { ok: true, state: "signed_in", why: "orders page" }, fail = false } = {}) {
  const page = {
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0x2a]),
    evaluate: async () => ({ url: "https://www.amazon.com/ap/signin", text: "Sign in or create account", fields: [] }),
    mouse: { click: async () => {}, wheel: async () => {} }, keyboard: { type: async () => {}, press: async () => {} }, goBack: async () => {},
  };
  return {
    launch: async () => { if (fail) throw new Error("no chromium"); return { page, close: async () => {} }; },
    check: async () => said,
  };
}
function link(conv, opts) {
  const s = seams(opts);
  const out = amazon.setupConnectLink(conv, { create: (a) => remote.createRemoteSignin({ ...a, ...s }) });
  assert.equal(out.ok, true);
  return out.url.split("/").pop();
}
const req = (token, action = "", { method = "GET", cookie = "" } = {}) =>
  remote.remoteRequest({ token, action, method, headers: cookie ? { cookie } : {}, readBody: async () => "" });
async function startAs(token, setupCookie) {
  const r = await req(token, "start", { method: "POST", cookie: `rs_setup=${setupCookie}` });
  assert.equal(r.status, 303, "the setup's own browser starts without a code");
  return { r, cookie: String(r.headers["Set-Cookie"]).split(";")[0] };
}

test("setup intro is the paper store sign-in: headline, sealed login, the margin, the practical facts, Connect Amazon card", async () => {
  const s = await newSetup();
  const token = link(s.conv);
  const page = await req(token);
  assert.equal(page.status, 200);
  const html = page.body;
  assert.match(html, /class="pf-hd"/);
  assert.match(html, /AMAZON ACCOUNT/);
  assert.match(html, /Sign in to Amazon\.<br><em>Just this once\.<\/em>/);
  assert.match(html, /never your password/);
  assert.match(html, /SEALED · YOUR AMAZON LOGIN/);
  assert.match(html, /SIGNED IN, I CAN<\/span><p class="pf-p">See your orders and help you reorder\./);
  assert.match(html, /I NEVER<\/span><p class="pf-p">Buy anything without your Face ID\.<\/p><p class="pf-p">Change your password or your address\./);
  assert.match(html, /Sign me out of Amazon anytime\./);
  assert.match(html, /a password or a code by text or email works/);
  assert.match(html, /passkeys and Face ID on Amazon don&#39;t|passkeys and Face ID on Amazon don't/);
  assert.match(html, /works once, on this device, for a few minutes/);
  assert.match(html, new RegExp(`action="/s/${token}/start"`));
  assert.match(html, /id="ss-wait"[^>]*hidden/, "the wait while the browser opens is ready, hidden until Sign in");
  assert.match(html, /Opening my browser, sealed\./);
  assert.match(html, /Connect Amazon/, "the link preview card is still Connect Amazon");
  assert.doesNotMatch(html, /class="sheet"/, "not the plain sign-in page");
});

test("setup live page: the same picture and script, framed in the paper header", async () => {
  const s = await newSetup();
  const token = link(s.conv);
  const { cookie } = await startAs(token, s.cookie);
  const live = await req(token, "", { cookie });
  assert.equal(live.status, 200);
  for (const id of ["stage", "v", "f", "in-u", "in-p", "in-o", "in-g", "veil", "tip", "msg", "done", "back", "stop"]) assert.match(live.body, new RegExp(`id="${id}"`), id);
  assert.match(live.body, /class="pf-hd"/);
  assert.match(live.body, new RegExp(`"/s/${token}"`), "the live script drives this link");
  assert.match(live.body, /I&#39;m signed in|I'm signed in/);
  assert.doesNotMatch(live.body, /class="foot"/);
});

test("signed in: CONNECTED · AMAZON · Signed in., Back to setup to the setup's own site, back on its own after a moment", async () => {
  config.siteUrl = "https://heyreason.example";
  process.env.REASON_SETUP_ORIGINS = "https://start--site.netlify.example";
  try {
    const s = await newSetup({ origin: "https://start--site.netlify.example", host: "files.heyreason.example" });
    const token = link(s.conv);
    const { cookie } = await startAs(token, s.cookie);
    const done = await req(token, "done", { method: "POST", cookie });
    assert.equal(JSON.parse(done.body).state, "signed_in");
    const page = await req(token);
    assert.match(page.body, /class="pf-stamp">CONNECTED</);
    assert.match(page.body, /AMAZON<\/span><p class="pf-big t">Signed in\.<\/p>/);
    assert.match(page.body, /href="https:\/\/start--site\.netlify\.example\/start\/connect\?back=amazon"[^>]*id="ss-back"/);
    assert.match(page.body, /setTimeout\(function\(\)\{location\.href=a\.href\},1500\)/);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(store.get(s.id).amazon_state, "connected", "the setup's /setup state says connected for /start/connect");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE conversation_id = ?").get(s.conv).n, 0);
  } finally { delete process.env.REASON_SETUP_ORIGINS; config.siteUrl = ""; }
});

test("not signed in, cancelled, unreadable, launch failed, expired: paper, Nothing was lost, same way back, no auto-return", async () => {
  const back = "https://reason.example.test/start/connect?back=amazon";
  const cases = [
    ["signed_out", { said: { ok: true, state: "signed_out", why: "sign-in page" } }, "done", /Not signed in to Amazon\./],
    ["cancelled", { said: { ok: true, state: "signed_out", why: "sign-in page" } }, "cancel", /Not signed in to Amazon\./],
    ["unknown", { said: { ok: false, error: "page would not load" } }, "done", /Couldn&#39;t tell with Amazon\.|Couldn't tell with Amazon\./],
  ];
  for (const [name, opts, act, h1] of cases) {
    const s = await newSetup();
    const token = link(s.conv, opts);
    const { cookie } = await startAs(token, s.cookie);
    await req(token, act, { method: "POST", cookie });
    const page = await req(token);
    assert.match(page.body, h1, name);
    assert.match(page.body, /Nothing was lost\./, name);
    assert.match(page.body, new RegExp(`href="${back.replace(/[.?]/g, "\\$&")}"`), name);
    assert.doesNotMatch(page.body, /location\.href=a\.href/, `${name}: waits for the tap`);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(store.get(s.id).amazon_state, "failed", name);
  }
  // The browser would not open: the Start answers with the paper page, not the plain one.
  const s = await newSetup();
  const token = link(s.conv, { fail: true });
  const r = await req(token, "start", { method: "POST", cookie: `rs_setup=${s.cookie}` });
  assert.equal(r.status, 500);
  assert.match(r.body, /Amazon isn&#39;t answering\.|Amazon isn't answering\./);
  assert.match(r.body, /class="pf-hd"/);
  // Never opened, then expired.
  const s2 = await newSetup();
  const t2 = link(s2.conv);
  await remote.endAllRemoteSignins("link_expired");
  assert.match((await req(t2)).body, /This link has ended\./);
});

test("a sign-in link from a text thread: the same paper pages, Back to Reason as the way on, no auto-return", async () => {
  db.upsertAccount({ conversationId: "dm:fake:+14155550001", channel: "fake", address: "+14155550001", name: "Ama" });
  const s = seams();
  const out = remote.createRemoteSignin({ conversationId: "dm:fake:+14155550001", entry: sites.site("amazon"), ...s });
  const token = out.url.split("/").pop();
  const page = (await req(token)).body;
  assert.match(page, /class="pf-hd"/);
  assert.match(page, /Sign in to Amazon\.<br><em>Just this once\.<\/em>/);
  assert.match(page, /SEALED · YOUR AMAZON LOGIN/);
  assert.match(page, /id="ss-wait"[^>]*hidden/);
  assert.match(page, /Connect Amazon/, "the link preview card");
  assert.doesNotMatch(page, /class="sheet"|<h1>Sign in to Amazon<\/h1>/, "the plain page is gone");
  // Signed in: CONNECTED, Back to Reason into Messages, and the page stays put.
  const r = await req(token, "start", { method: "POST", cookie: provedCookie("dm:fake:+14155550001") });
  assert.equal(r.status, 303);
  const cookie = String(r.headers["Set-Cookie"]).split(";")[0];
  const live = await req(token, "", { cookie });
  assert.match(live.body, /class="pf-hd"/);
  assert.match(live.body, /SEALED · NOTHING YOU TYPE IS KEPT/);
  await req(token, "done", { method: "POST", cookie });
  const done = (await req(token)).body;
  assert.match(done, /class="pf-stamp">CONNECTED</);
  assert.match(done, /Reason will text you/);
  assert.match(done, /href="sms:\+14155550199&amp;body=signed%20in%20to%20Amazon%2C%20keep%20going"[^>]*id="ss-back">Back to Reason /);
  assert.doesNotMatch(done, /Back to setup|\/start\/connect|location\.href=a\.href/);
  // Ended without signing in: Nothing was lost, Ask Reason for a fresh link, the reply says so.
  const out2 = remote.createRemoteSignin({ conversationId: "dm:fake:+14155550001", entry: sites.site("amazon"), ...seams({ said: { ok: true, state: "signed_out", why: "sign-in page" } }) });
  const t2 = out2.url.split("/").pop();
  const r2 = await req(t2, "start", { method: "POST", cookie: provedCookie("dm:fake:+14155550001") });
  const c2 = String(r2.headers["Set-Cookie"]).split(";")[0];
  await req(t2, "cancel", { method: "POST", cookie: c2 });
  const ended = (await req(t2)).body;
  assert.match(ended, /Not signed in to Amazon\.<br><em>Nothing was lost\.<\/em>/);
  assert.match(ended, /Ask Reason for a fresh link to try again/);
  assert.match(ended, /body=Amazon%20didn&#39;t%20sign%20in"[^>]*id="ss-back">Back to Reason /);
  assert.doesNotMatch(ended, /from your setup|Back to setup|location\.href=a\.href/);
});

/** A Reason Web sign-in proved for this conversation: the person's own browser, which starts a link with no code. */
function provedCookie(conversationId) {
  const t = `sess-${conversationId}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, t, { conversationId });
  return `reason_page=${t}`;
}

test("the code page and the gone page are paper too, for a text thread and a setup alike", async () => {
  db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts;");
  db.upsertAccount({ conversationId: "dm:fake:+14155550001", channel: "fake", address: "+14155550001", name: "Ama" });
  const out = remote.createRemoteSignin({ conversationId: "dm:fake:+14155550001", entry: sites.site("amazon"), ...seams() });
  const token = out.url.split("/").pop();
  const told = [];
  const asked = await remote.remoteRequest({ token, action: "start", method: "POST", headers: {}, readBody: async () => "", tell: async (c, text) => { told.push(text); } });
  assert.equal(asked.status, 401);
  assert.match(asked.body, /class="pf-hd"/);
  assert.match(asked.body, /Enter the code Reason texted you\./);
  assert.match(asked.body, /data-code="6"/);
  assert.match(asked.body, /autocomplete="one-time-code"/);
  assert.match(asked.body, /name="send" value="1"/);
  assert.match(asked.body, /TEXT ME A NEW CODE/);
  assert.match(asked.body, /Connect Amazon/, "the card stays on every page");
  assert.doesNotMatch(asked.body, /class="sheet"/);
  await new Promise(r => setImmediate(r));
  const wrong = await remote.remoteRequest({ token, action: "start", method: "POST", headers: {}, readBody: async () => "code=000000", tell: async () => {} });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /class="pf-note"[^>]*>That code is not right\. 4 tries left\./, "the error is a note the cells point at");
  assert.match(wrong.body, /aria-invalid="true"/);
  // An empty tap on Sign in costs none of the few tries: the same 4 are still left after it.
  const empty = await remote.remoteRequest({ token, action: "start", method: "POST", headers: {}, readBody: async () => "code=", tell: async () => {} });
  assert.equal(empty.status, 401);
  assert.match(empty.body, /Type the code Reason texted you first\./);
  const wrong2 = await remote.remoteRequest({ token, action: "start", method: "POST", headers: {}, readBody: async () => "code=000001", tell: async () => {} });
  assert.match(wrong2.body, /3 tries left/, "the empty one was not counted");
  // No way to text a code (no runtime): the own-browser notice, on paper.
  const own = await remote.remoteRequest({ token, action: "start", method: "POST", headers: {}, readBody: async () => "", tell: null });
  assert.equal(own.status, 403);
  assert.match(own.body, /Open this on your own browser\.<br><em>Nothing was lost\.<\/em>/);
  assert.match(own.body, /signed in to Reason on/);
  assert.doesNotMatch(own.body, /class="sheet"/);
  // A setup's code page is the same page.
  const s = await newSetup();
  const t2 = link(s.conv);
  const setupAsked = await remote.remoteRequest({ token: t2, action: "start", method: "POST", headers: {}, readBody: async () => "", tell: null });
  assert.equal(setupAsked.status, 403, "a setup has no thread to text a code to");
  // Gone: a token nobody has.
  const gone = await req("A".repeat(32));
  assert.equal(gone.status, 404);
  assert.match(gone.body, /class="pf-hd"/);
  assert.match(gone.body, /This link is no longer good\.<br><em>Nothing was lost\.<\/em>/);
  assert.match(gone.body, /Secured by Reason/);
  assert.doesNotMatch(gone.body, /class="sheet"|STORE ACCOUNT/);
});
