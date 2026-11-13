// Sign-in with the site's OWN emailed code, read from their Gmail by Reason (src/signinemail.js).
//
// Owner, 2026-11-11: "the person says sign me into notion, then we ask the site for the email code"
// and "remove that whole scary Google thing". What has to hold:
//   1. Google is never shown and never clicked: not on Reason's page, not on the site.
//   2. A provider's "This browser or app may not be secure" page triggers a back-out to the email route.
//   3. A code is taken only from the site's own sender (From + DKIM pass) and only from mail that
//      arrived after the request.
//   4. The code is never logged, never in a note, never in a tool answer, never in the thread.
//   5. With no Gmail connected, the person is asked once, and their reply goes to the site.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-email-"));
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
process.env.REASON_TOKEN_KEY = "ab".repeat(32);

const em = await import("../src/signinemail.js");
const social = await import("../src/socialsignin.js");
const signin = await import("../src/signin.js");
const db = await import("../src/db.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { setupStartPage, nativeStepPanel } = await import("../src/pages/setupsignin.js");
const { clock, config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;
const NOTION = signin.genericEntry("https://www.notion.so/login");
const CODE = "482913";

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  em._resetJobs();
  db.db.exec("DELETE FROM accounts; DELETE FROM connected_accounts; DELETE FROM social_refusals;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  config.publicUrl = "https://reason.example";
  process.env.REASON_SOCIAL_SIGNIN = "owner";
});

// ---------------------------------------------------------------- Gmail fixtures
const b64 = (s) => Buffer.from(s).toString("base64url");
const mail = ({ id, at, from, dkim, subject = "Your Notion login code", text = "", html = "" }) => ({
  id, internalDate: String(at),
  payload: {
    headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, ...(dkim ? [{ name: "Authentication-Results", value: `mx.google.com; dkim=pass header.i=@${dkim} header.s=s1; spf=pass` }] : [])],
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/plain", body: { data: b64(text) } }, ...(html ? [{ mimeType: "text/html", body: { data: b64(html) } }] : [])],
  },
});
const fakeGmail = (messages) => {
  const asked = [];
  return {
    asked,
    tokens: async () => ({ ok: true, accounts: [{ account: "me@gmail.com", token: "t" }] }),
    api: async (_t, _m, path, { query } = {}) => {
      asked.push({ path, query });
      if (path.endsWith("/messages")) return { ok: true, body: { messages: messages().map(m => ({ id: m.id })) } };
      const id = decodeURIComponent(path.split("/").pop());
      const m = messages().find(x => x.id === id);
      return m ? { ok: true, body: m } : { ok: false };
    },
  };
};

// ---------------------------------------------------------------- 3. only the right sender
test("senderMatches: the site's own domain with DKIM passing for it; never a lookalike or a forged From", () => {
  const allowed = em.senderDomainsFor(NOTION);
  assert.deepEqual(allowed, ["notion.so", "notion.com", "makenotion.com"]);
  assert.ok(em.senderMatches({ from: "Notion <notify@updates.notion.so>", auth: ["mx.google.com; dkim=pass header.i=@updates.notion.so"] }, allowed));
  assert.ok(!em.senderMatches({ from: "Notion <notify@updates.notion.so>", auth: [] }, allowed), "no DKIM: a From header alone is forgeable");
  assert.ok(!em.senderMatches({ from: "Notion <notify@updates.notion.so>", auth: ["dkim=pass header.i=@evil.com"] }, allowed), "DKIM for another domain");
  assert.ok(!em.senderMatches({ from: "Notion <notify@updates.notion.so>", auth: ["dkim=fail header.i=@notion.so"] }, allowed), "DKIM failed");
  assert.ok(!em.senderMatches({ from: "Notion <notify@notion.so.evil.com>", auth: ["dkim=pass header.i=@notion.so.evil.com"] }, allowed), "lookalike suffix");
  assert.ok(!em.senderMatches({ from: "Notion <notify@evilnotion.so>", auth: ["dkim=pass header.i=@evilnotion.so"] }, allowed), "lookalike prefix");
  assert.deepEqual(em.senderDomainsFor(signin.genericEntry("https://www.airbnb.com/login")), ["airbnb.com"]);
  // Only Gmail's own verdict, the topmost header: a sender's forged "dkim=pass" below it does not count.
  const good = "mx.google.com; dkim=pass header.i=@updates.notion.so";
  assert.ok(!em.senderMatches({ from: "notify@updates.notion.so", auth: ["mx.google.com; dkim=none", good] }, allowed), "forged header under Gmail's");
  assert.ok(!em.senderMatches({ from: "notify@updates.notion.so", auth: ["dkim=pass header.i=@updates.notion.so"] }, allowed), "not stamped by Gmail");
  // A mail provider is never a site's sender: anybody passes DKIM for gmail.com.
  assert.deepEqual(em.senderDomainsFor(signin.genericEntry("https://mail.google.com/")), []);
  assert.deepEqual(em.senderDomainsFor(signin.genericEntry("https://outlook.com/")), []);
});

test("extractSignin: the code in the mail, a sign-in link only on the site, never an unsubscribe", () => {
  const allowed = em.senderDomainsFor(NOTION);
  assert.deepEqual(em.extractSignin({ subject: "Your temporary Notion login code", text: `Copy and paste this temporary login code:\n\n${CODE}\n\nIf you didn't try to log in, ignore this. © 2026` }, allowed), { kind: "code", code: CODE });
  assert.deepEqual(em.extractSignin({ subject: `${CODE} is your verification code` }, allowed), { kind: "code", code: CODE });
  assert.deepEqual(em.extractSignin({ subject: "Log in to Notion", text: "Your login code: brave-otter-lamp" }, allowed), { kind: "code", code: "brave-otter-lamp" });
  const html = `<a href="https://evil.example/login?t=1">x</a><a href="https://www.notion.so/unsubscribe?u=1">u</a><a href="https://www.notion.so/loginwithemail?token=abc&amp;state=z">Log in</a>`;
  assert.deepEqual(em.extractSignin({ subject: "Log in to Notion", text: "Click the button below to log in.", html }, allowed), { kind: "link", url: "https://www.notion.so/loginwithemail?token=abc&state=z" });
  assert.equal(em.extractSignin({ subject: "Welcome", text: "Thanks for joining in 2026. Unsubscribe: https://www.notion.so/unsubscribe" }, allowed), null);
});

test("codeFromGmail: newest mail from the site AFTER the request; earlier mail and other senders are never taken", async () => {
  const since = 1_800_000_000_000;
  const box = [
    mail({ id: "old", at: since - 60_000, from: "Notion <notify@updates.notion.so>", dkim: "updates.notion.so", text: "Your login code: 111111" }),
    mail({ id: "spoof", at: since + 9_000, from: "Notion <notify@notion-security.com>", dkim: "notion-security.com", text: "Your login code: 222222" }),
    mail({ id: "forged", at: since + 10_000, from: "Notion <notify@updates.notion.so>", dkim: "", text: "Your login code: 444444" }),
    mail({ id: "new", at: since + 8_000, from: "Notion <notify@updates.notion.so>", dkim: "updates.notion.so", text: `Your login code: ${CODE}` }),
  ];
  const g = fakeGmail(() => box);
  const got = await em.codeFromGmail(CONV, NOTION, { since, tokens: g.tokens, api: g.api, sleep: async () => {} });
  assert.deepEqual(got, { connected: true, found: true, kind: "code", code: CODE });
  assert.match(g.asked[0].query.q, /^from:\(notion\.so OR notion\.com OR makenotion\.com\) newer_than:1d after:(\d+)$/);
  const after = Number(g.asked[0].query.q.match(/after:(\d+)$/)[1]);
  assert.ok(after * 1000 <= since && after * 1000 > since - 10_000, "only mail from the moment of the ask on is searched");
  assert.equal(g.asked[0].query.includeSpamTrash, undefined, "spam is never searched: a forged code lands there");

  // Only the old one there: polled until the wait runs out, then nothing — never the earlier code.
  let t = since;
  const g2 = fakeGmail(() => box.slice(0, 1));
  const none = await em.codeFromGmail(CONV, NOTION, { since, waitMs: 20_000, pollMs: 5_000, tokens: g2.tokens, api: g2.api, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.deepEqual(none, { connected: true, found: false });
  assert.ok(g2.asked.filter(a => a.path.endsWith("/messages")).length >= 3, "polled more than once");

  // The code arrives on the third poll.
  let polls = 0; t = since;
  const g3 = fakeGmail(() => (++polls >= 3 ? box : box.slice(0, 1)));
  const late = await em.codeFromGmail(CONV, NOTION, { since, waitMs: 90_000, pollMs: 5_000, tokens: g3.tokens, api: g3.api, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(late.code, CODE);

  const off = await em.codeFromGmail(CONV, NOTION, { since, tokens: async () => ({ ok: false, status: "not_connected" }), api: async () => ({ ok: false }) });
  assert.deepEqual(off, { connected: false });
});

// ---------------------------------------------------------------- 1. never Google, on a real page
const LOGIN = (opts = {}) => `<!doctype html><html><body>
<h1>Log in</h1>
<button id="g" onclick="window.__pressed.push('google')">Google</button>
<button id="a" onclick="window.__pressed.push('apple')">Apple</button>
<button id="m" onclick="window.__pressed.push('microsoft')">Microsoft</button>
${opts.hidden ? `<button id="route" onclick="window.__pressed.push('email-route');document.getElementById('f').style.display='block'">Continue with email</button>` : ""}
<form id="f" style="display:${opts.hidden ? "none" : "block"}" onsubmit="event.preventDefault()">
  <input id="email" type="email" placeholder="Enter your email address">
  <button type="button" id="go" onclick="window.__pressed.push('continue:'+document.getElementById('email').value);document.getElementById('f').innerHTML='<p>We just sent you a temporary login code.</p><input id=code autocomplete=one-time-code placeholder=\\'Enter code\\'><button type=button onclick=&quot;window.__pressed.push(\\'code:\\'+document.getElementById(\\'code\\').value)&quot;>Continue with login code</button>'">Continue</button>
</form>
<script>window.__pressed=[];</script>
</body></html>`;

test("on a Notion-like page: the email typed and Continue pressed — Google (or any provider) never clicked", async () => {
  for (const hidden of [false, true]) {
    const page = await browser.newPage();
    try {
      await page.setContent(LOGIN({ hidden }), { waitUntil: "domcontentloaded" });
      const asked = await em.requestCode(page, NOTION, "me@example.com", { settleMs: 50 });
      assert.equal(asked.ok, true, JSON.stringify(asked));
      assert.equal(asked.state, "code");
      const pressed = await page.evaluate(() => window.__pressed);
      assert.deepEqual(pressed, [...(hidden ? ["email-route"] : []), "continue:me@example.com"], "only the email route and Continue");
      assert.ok(!pressed.includes("google") && !pressed.includes("apple") && !pressed.includes("microsoft"));
      const done = await em.enterCode(page, CODE, { settleMs: 50 });
      assert.equal(done.ok, true);
      assert.deepEqual((await page.evaluate(() => window.__pressed)).slice(-1), [`code:${CODE}`]);
    } finally { await page.close(); }
  }
});

test("Notion's live answer (2026-11-11): its password-manager box is not 'wants a password'; a refused email is said as the site said it", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<body><h1>Log in to your Notion account</h1><button onclick="window.__p.push('google')">Google</button>
      <input id="email" type="email" placeholder="Enter your email address"><input type="password" style="width:200px;height:20px" autocomplete="current-password">
      <button onclick="window.__p.push('continue');document.getElementById('err').textContent='Invalid email domain'">Continue</button><p id="err"></p>
      <script>window.__p=[]</script></body>`, { waitUntil: "domcontentloaded" });
    const asked = await em.requestCode(page, NOTION, "me@throwaway.example", { settleMs: 30 });
    assert.equal(asked.ok, false);
    assert.equal(asked.state, "rejected");
    assert.match(asked.why, /Notion would not take that email: "Invalid email domain"/);
    assert.deepEqual(await page.evaluate(() => window.__p), ["continue"], "Google never pressed");
  } finally { await page.close(); }
});

test("clickProviderButton never presses Google; Apple still works", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(LOGIN(), { waitUntil: "domcontentloaded" });
    assert.deepEqual(await social.clickProviderButton(page, "google", { settleMs: 0 }), { pressed: "" });
    assert.deepEqual(await page.evaluate(() => window.__pressed), []);
    assert.equal((await social.clickProviderButton(page, "apple", { settleMs: 0 })).pressed, "apple");
  } finally { await page.close(); }
  assert.equal(social.usableProvider("google"), "");
  assert.equal(social.usableProvider("Apple"), "apple");
});

test("Reason's own page never shows Continue with Google", () => {
  const start = setupStartPage({ entry: NOTION, action: "/s/x/start", offered: ["google", "apple"] });
  assert.doesNotMatch(start, /Continue with Google/);
  assert.match(start, /Continue with Apple/);
  for (const offered of [[], ["google"], ["google", "microsoft"]]) {
    const panel = nativeStepPanel({ step: "chooser", offered, say: "Pick how you sign in." }, { entry: NOTION });
    assert.doesNotMatch(panel, /Continue with Google/, JSON.stringify(offered));
    assert.match(panel, /Use my .* email/);
  }
  assert.deepEqual(social.offeredFor(CONV, NOTION, { asked: "google", live: ["google", "apple"] }), ["apple"]);
  // Notion's real login: Google + Apple + Microsoft + an email box. Google is not a choice.
  const st = social.stepOf({ url: "https://www.notion.so/login", text: "Log in Google Apple Microsoft Email Continue", buttons: ["Google", "Apple", "Microsoft"] }, { fields: [{ k: "email" }] });
  assert.equal(st.step, "chooser");
  assert.deepEqual(st.offered, ["apple", "microsoft"]);
  const onlyG = social.stepOf({ url: "https://site.example/login", text: "Continue with Google Email", buttons: ["Continue with Google"] }, { fields: [{ k: "email" }] });
  assert.equal(onlyG.step, "email", "Google-only + email box = the email step");
});

test("the rules never offer Google and send 'sign me in' to signin_email", () => {
  assert.match(social.RULES, /NO GOOGLE, EVER: never offer, suggest, ask for or use a Google sign-in/);
  assert.match(social.RULES, /call signin_email/);
  assert.match(social.RULES, /Never say "check your email"/);
  assert.doesNotMatch(social.RULES, /signs in through your Google account/);
  assert.doesNotMatch(social.RULES, /Google will ping your phone/);
  assert.doesNotMatch(social.RULES, /provider "google"/);
});

// ---------------------------------------------------------------- 2. the refusal page triggers the fallback
test("a provider's 'may not be secure' page is backed out of: popup closed, the site's sign-in page opened again", async () => {
  const visits = [];
  let closed = 0;
  const popup = { url: () => "https://accounts.google.com/v3/signin/rejected", evaluate: async () => "Couldn't sign you in. This browser or app may not be secure. Try using a different browser.", close: async () => { closed++; } };
  const main = {
    url: () => "https://www.notion.so/login", evaluate: async () => "Log in",
    context: () => ({ pages: () => [main, popup] }),
    goto: async (u) => { visits.push(u); }, waitForTimeout: async () => {},
  };
  const logs = [];
  assert.equal(await em.backOutOfProvider(main, NOTION, CONV, (l) => logs.push(l)), true);
  assert.equal(closed, 1, "the refusal popup is closed");
  assert.deepEqual(visits, [NOTION.signin_url]);
  assert.ok(social.refusedRecently(CONV, NOTION.site, "google"), "recorded, so it is never tried again");
  assert.deepEqual(logs, [{ signin_email: "backed_out", site: NOTION.site, provider: "google" }]);
  // A normal page is left alone.
  const fine = { url: () => "https://www.notion.so/login", evaluate: async () => "Log in", context: () => ({ pages: () => [fine] }), goto: async () => { throw new Error("must not navigate"); } };
  assert.equal(await em.backOutOfProvider(fine, NOTION, CONV), false);
});

// ---------------------------------------------------------------- the whole job, with a fake browser
/** A page that walks login → code → signed in, the way the in-page reader sees it. */
function fakeSite() {
  const st = { step: "login", typed: [], code: "", gotos: [] };
  const page = {
    url: () => "https://www.notion.so/login",
    context: () => ({ pages: () => [page] }),
    waitForTimeout: async () => {},
    goto: async (u) => { st.gotos.push(u); },
    evaluate: async (fn, act) => {
      if (fn !== em.emailPage) return "Log in";
      let did = "";
      if (act === "mark_email" && st.step === "login") did = "email";
      if (act === "mark_code" && st.step === "code") did = "code";
      if (act === "submit" && st.step === "login") { st.step = "code"; did = "Continue"; }
      else if (act === "submit" && st.step === "code") { st.step = "done"; did = "Continue"; }
      return { did, email: st.step === "login", code: st.step === "code", split: false, password: false, route: false, instead: false, text: st.step === "code" ? "We sent a code" : "Log in", url: "https://www.notion.so/login" };
    },
    fill: async (sel, v) => { if (/code/.test(sel)) st.code = v; else st.typed.push(v); },
    press: async () => {}, click: async () => {}, keyboard: { type: async () => {} },
  };
  return { st, page };
}

test("Gmail connected: Reason asks Notion for a code, reads it, enters it, says signed in — the code never logged or noted", async () => {
  const { st, page } = fakeSite();
  const logs = [], notes = [];
  let since = null;
  const out = em.startEmailSignin({
    conversationId: CONV, entry: NOTION, email: "me@example.com", settleMs: 1,
    launch: async () => ({ page, close: async () => {} }),
    gmail: async (_c, _e, o) => { since = o.since; return { connected: true, found: true, kind: "code", code: CODE }; },
    check: async () => ({ ok: true, state: "signed_in", why: "the workspace loaded" }),
    log: (l) => logs.push(l), note: (_c, t) => notes.push(t),
  });
  assert.equal(out.ok, true);
  await out.run;
  assert.deepEqual(st.typed, ["me@example.com"]);
  assert.equal(st.code, CODE, "the code reached the site's box");
  assert.ok(typeof since === "number" && since > 0, "the mail is searched from the moment of the request");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /signed in to Notion now/);
  assert.doesNotMatch(notes[0], /check your email/i);
  const everything = JSON.stringify({ logs, notes, out: { ...out, run: undefined } });
  assert.ok(!everything.includes(CODE), "the code is in no log line, no note, no answer");
  assert.equal(em.emailSigninFor(CONV), null, "finished");
});

test("no Gmail: asked ONCE in one line; their reply goes to the site, the thread gets a placeholder", async () => {
  const { st, page } = fakeSite();
  const logs = [], notes = [];
  const out = em.startEmailSignin({
    conversationId: CONV, entry: NOTION, email: "me@example.com", settleMs: 1,
    launch: async () => ({ page, close: async () => {} }),
    gmail: async () => ({ connected: false }),
    check: async () => ({ ok: true, state: "signed_in", why: "ok" }),
    log: (l) => logs.push(l), note: (_c, t) => notes.push(t),
  });
  for (let i = 0; i < 50 && em.emailSigninFor(CONV)?.state !== "waiting_reply"; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(em.emailSigninFor(CONV)?.state, "waiting_reply");
  assert.equal(notes.length, 1, "one ask");
  assert.match(notes[0], /What's the code Notion just sent to me@example\.com\?/);
  assert.match(notes[0], /do not ask again/);
  assert.doesNotMatch(notes[0], /check your email/i);
  // Ordinary words are not a code and go to the model as they are.
  assert.equal(em.takeCodeReply(CONV, "hold on, looking"), null);
  assert.equal(em.takeCodeReply(CONV, "thank-you"), null, "a hyphenated word is not a code");
  assert.equal(em.takeCodeReply(CONV, "follow-up"), null);
  assert.equal(em.takeCodeReply(THEIRS, "482 913"), null, "someone else's thread is not this sign-in");
  // Only what they typed: a note alone is never a code, and a note under a typed code never lets it
  // through to the thread.
  assert.equal(em.takeCodeReply(CONV, "[482913]"), null, "a note is not a code");
  const placeholder = em.takeCodeReply(CONV, "482 913\n[they sent that with the 'slam' screen effect on it — that is them being emphatic, so read it that way]");
  assert.ok(placeholder && !placeholder.includes(CODE) && !placeholder.includes("482"), "the thread never sees the code");
  assert.equal(em.takeCodeReply(CONV, "482913"), null, "taken once");
  await out.run;
  assert.equal(st.code, CODE, "cleaned and typed into the site");
  assert.equal(notes.length, 2);
  assert.match(notes[1], /signed in to Notion now/);
  assert.ok(!JSON.stringify({ logs, notes }).includes(CODE));
});

test("the router hands the code over at intake: before the dedupe row, the held queue, a mid-turn read, history, memory and the turn", () => {
  const src = readFileSync(new URL("../src/channels/router.js", import.meta.url), "utf8");
  const hook = src.indexOf("signinEmail.takeCodeReply(conversationId, inbound.text)");
  assert.ok(hook > 0);
  for (const later of ["db.claimInbound({", "db.holdInbound({", "this.#readAccessAnswer(", "db.writeMessage({\n            conversationId, role: \"user\"", "db.enqueueExtraction(conversationId", "this.runtime.inbound(conversationId, userText"]) {
    const at = src.indexOf(later, hook);
    assert.ok(at > hook, `${later} comes after the hook`);
    assert.equal(src.slice(0, hook).includes(later), false, `${later} never runs before it`);
  }
});

test("Gmail connected but no mail came: nothing saved, plain line, never 'check your email'", async () => {
  const { page } = fakeSite();
  const notes = [];
  const out = em.startEmailSignin({
    conversationId: CONV, entry: NOTION, email: "me@example.com", settleMs: 1,
    launch: async () => ({ page, close: async () => {} }),
    gmail: async () => ({ connected: true, found: false }),
    check: async () => { throw new Error("must not check"); }, note: (_c, t) => notes.push(t),
  });
  await out.run;
  assert.equal(notes.length, 1);
  assert.match(notes[0], /no mail from Notion reached their Gmail/);
  assert.match(notes[0], /Never say "check your email"/);
});

// ---------------------------------------------------------------- the tool
test("signin_email: owner only, asks once for an email it does not know, starts in the background", async () => {
  assert.ok(toolsFor(CONV).some(t => t.name === "signin_email"));
  assert.ok(!toolsFor(THEIRS).some(t => t.name === "signin_email"), "hidden where the flag does not reach");
  const pub = async (url) => ({ ok: true, url });
  const started = [];
  const ctx = { publicUrl: pub, startEmailSignin: (a) => { started.push(a); return { ok: true, started: true }; } };
  const call = (input, c = CONV) => runTool("signin_email", input, { conversationId: c, messages: [], ...ctx });
  const ask = await call({ site: "https://www.notion.so/login" });
  assert.equal(ask.needs_email, true);
  assert.match(ask.ask, /ONCE, in one plain line, which email their Notion account uses/);
  assert.equal(started.length, 0);
  const go = await call({ site: "https://www.notion.so/login", email: "me@example.com" });
  assert.equal(go.ok, true, JSON.stringify(go));
  assert.equal(go.started, true);
  assert.match(go.say, /Signing you in to Notion with your email, one sec/);
  assert.doesNotMatch(JSON.stringify(go), /Google/);
  assert.equal(started.length, 1);
  assert.equal(started[0].entry.site, NOTION.site);
  assert.equal(started[0].email, "me@example.com");
  const friend = await call({ site: "https://www.notion.so/login", email: "k@example.com" }, THEIRS);
  assert.equal(friend.ok, false);
  assert.equal(started.length, 1);
});

// ---------------------------------------------------------------- review, 2026-11-12: whose mail, whose tool, which page
test("account A's sign-in never reads account B's mailbox: tokens come only from the asking conversation's own rows", async () => {
  const google = await import("../src/google.js");
  const had = { id: config.googleClientId, secret: config.googleClientSecret, fetch: globalThis.fetch };
  config.googleClientId = "client"; config.googleClientSecret = "secret";
  const net = [];
  globalThis.fetch = async (u) => { net.push(String(u)); throw new Error("offline"); };
  try {
    db.db.exec("DELETE FROM oauth_tokens;");
    // Only Kofi (B) has Gmail connected.
    db.saveOauthTokens(THEIRS, "google", { accessToken: "kofi-token", refreshToken: "kofi-refresh", scope: google.TOOL_SCOPES.gmail_search.join(" "), expiresAt: clock.now() + 3_600_000, accountLabel: "kofi@gmail.com" });
    const since = clock.now();
    const used = [];
    const box = [mail({ id: "k1", at: since + 1_000, from: "Notion <notify@updates.notion.so>", dkim: "updates.notion.so", text: `Your login code: ${CODE}` })];
    const api = async (token, _m, path) => {
      used.push(token);
      if (path.endsWith("/messages")) return { ok: true, body: { messages: box.map(m => ({ id: m.id })) } };
      return { ok: true, body: box[0] };
    };
    // A (the owner) asks: the real token lookup finds no Gmail of A's, so nothing is read at all —
    // not B's token, not B's mail, though B's code mail is sitting right there.
    const a = await em.codeFromGmail(CONV, NOTION, { since, api, waitMs: 1, sleep: async () => {} });
    assert.deepEqual(a, { connected: false });
    assert.deepEqual(used, [], "no Gmail call was made for A with anybody's token");
    // B asks: B's own token, and only B's.
    const b = await em.codeFromGmail(THEIRS, NOTION, { since, api, waitMs: 1, sleep: async () => {} });
    assert.equal(b.found, true);
    assert.ok(used.length > 0 && used.every(t => t === "kofi-token"));
    // A's reply is never taken for B's waiting sign-in, and the job is not visible across accounts.
    const { page } = fakeSite();
    const out = em.startEmailSignin({ conversationId: THEIRS, entry: NOTION, email: "k@example.com", settleMs: 1, launch: async () => ({ page, close: async () => {} }), gmail: async () => ({ connected: false }), check: async () => ({ ok: true, state: "signed_out" }), note: () => {}, replyWaitMs: 60_000 });
    for (let i = 0; i < 200 && em.emailSigninFor(THEIRS)?.state !== "waiting_reply"; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(em.emailSigninFor(THEIRS)?.state, "waiting_reply");
    assert.equal(em.emailSigninFor(CONV), null);
    assert.equal(em.takeCodeReply(CONV, CODE), null, "another account's text is not this sign-in's code");
    assert.ok(em.takeCodeReply(THEIRS, CODE));
    await out.run;
    assert.deepEqual(net, [], "nothing went to the network");
  } finally {
    config.googleClientId = had.id; config.googleClientSecret = had.secret; globalThis.fetch = had.fetch;
    db.db.exec("DELETE FROM oauth_tokens;");
  }
});

test("the gate: REASON_SOCIAL_SIGNIN unset or off reaches nobody; owner reaches the operator only — no tool, no rules, no route, same words as before", async () => {
  const mainText = "Which button their account on this site signs in through, when it is one of these. It is recorded only; nothing is pressed for them, and the link opens the site's own sign-in form. Never promise to press or use their Google login: Google refuses this browser, so a Google-only site cannot be signed in to here. Only when they said so; omit for the site's own form.";
  const provText = (c) => toolsFor(c).find(t => t.name === "signin_link")?.input_schema.properties.provider.description;
  let started = 0;
  const ctx = { publicUrl: async (url) => ({ ok: true, url }), startEmailSignin: () => { started++; return { ok: true, started: true }; } };
  const call = (c) => runTool("signin_email", { site: "https://www.notion.so/login", email: "x@example.com" }, { conversationId: c, messages: [], ...ctx });
  for (const v of [undefined, "", "off", "0", "false", "nonsense"]) {
    if (v === undefined) delete process.env.REASON_SOCIAL_SIGNIN; else process.env.REASON_SOCIAL_SIGNIN = v;
    for (const c of [CONV, THEIRS]) {
      assert.equal(social.socialAllowedFor(c), false, `${v} → nobody`);
      assert.ok(!toolsFor(c).some(t => t.name === "signin_email" || t.name === "signin_provider"));
      assert.equal(social.rulesFor(c), "");
      assert.equal(provText(c), mainText);
      assert.equal((await call(c)).ok, false);
    }
  }
  process.env.REASON_SOCIAL_SIGNIN = "owner";
  assert.ok(toolsFor(CONV).some(t => t.name === "signin_email"));
  assert.match(social.rulesFor(CONV), /signin_email/);
  assert.match(provText(CONV), /signin_email/);
  assert.ok(!toolsFor(THEIRS).some(t => t.name === "signin_email"));
  assert.equal(social.rulesFor(THEIRS), "");
  assert.equal(provText(THEIRS), mainText, "a non-owner's signin_link reads exactly as it did before signin_email");
  assert.doesNotMatch(JSON.stringify(toolsFor(THEIRS)), /signin_email/);
  assert.equal((await call(THEIRS)).ok, false);
  assert.equal(em.takeCodeReply(THEIRS, CODE), null, "no sign-in of theirs can be waiting, so their texts pass untouched");
  assert.equal(started, 0);
  assert.equal((await call(CONV)).ok, true);
  assert.equal(started, 1);
});

test("a code is only typed into the site's own page: a sign-in page that left the site gets nothing", async () => {
  assert.equal(em.onSite({ url: () => "https://www.notion.so/login" }, NOTION), true);
  assert.equal(em.onSite({ url: () => "https://notion.so.evil.example/login" }, NOTION), false);
  assert.equal(em.onSite({ url: () => { throw new Error("closed"); } }, NOTION), false);
  const { st, page } = fakeSite();
  page.url = () => "https://evil.example/login?looks=notion";
  const logs = [], notes = [];
  const out = em.startEmailSignin({
    conversationId: CONV, entry: NOTION, email: "me@example.com", settleMs: 1,
    launch: async () => ({ page, close: async () => {} }),
    gmail: async () => ({ connected: true, found: true, kind: "code", code: CODE }),
    check: async () => { throw new Error("must not be reached"); },
    log: (l) => logs.push(l), note: (_c, t) => notes.push(t),
  });
  await out.run;
  assert.equal(st.code, "", "the code was typed nowhere");
  assert.ok(logs.some(l => l.signin_email === "left_site"));
  assert.match(notes[0], /no longer on Notion's own site/);
  assert.ok(!JSON.stringify({ logs, notes }).includes(CODE));
});
