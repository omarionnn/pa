// The faults the 2026-11-12 probe of 44 sites found in Reason's own sign-in flow, each held shut:
//   1. a bot rejection ("Something went wrong") is the site refusing the browser, never a wrong email;
//   2. every attempt leaves one log line: host, route, outcome class, timing — nothing personal;
//   3. a footer "Facebook" link to the site's social page is not a sign-in button (Marriott);
//   4. whether a SITE can be signed in to comes from a dated finding that expires, or a live ask;
//   5. nothing promises to press or use a Google login;
//   6. the probe's walls are the dated findings the tools read.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-probe-"));
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
const findings = await import("../src/sitefindings.js");
const slog = await import("../src/signinlog.js");
const remote = await import("../src/signin-remote.js");
const db = await import("../src/db.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { clock, config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const OWNER = "+12025551234";
const CONV = "dm:owner";
const EMAIL = "omari.private@example.com";
const DAY = 86_400_000;
// The probe's date as "now", so the findings' ages are the same whenever this runs.
const PROBE_DAY = Date.parse("2026-11-12T15:00:00Z");
const atProbeDay = () => { clock.reset(); clock.skip(PROBE_DAY - Date.now()); };
const SPOTIFY = signin.anyEntryFor("spotify");
const EXAMPLE = signin.genericEntry("https://login.shop-example.com/signin");

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); clock.reset(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  atProbeDay();
  em._resetJobs();
  slog._resetAttempts();
  remote.forgetAllRemoteSignins();
  db.db.exec("DELETE FROM accounts; DELETE FROM connected_accounts; DELETE FROM social_refusals; DELETE FROM site_findings; DELETE FROM timers;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.publicUrl = "https://reason.example";
  process.env.REASON_SOCIAL_SIGNIN = "owner";
});

const pageWith = async (html) => { const page = await browser.newPage(); await page.setContent(html, { waitUntil: "domcontentloaded" }); return page; };
/** The same, served as the example site's own sign-in page (a code is only typed on the site itself). */
const sitePage = async (html) => {
  const page = await browser.newPage();
  await page.route("https://login.shop-example.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto("https://login.shop-example.com/signin");
  return page;
};
const attr = (s) => JSON.stringify(s).replace(/"/g, "&quot;");
/** An email form whose Continue answers with `says` (and keeps the email box, as Spotify does). */
const FORM = (says) => `<body><h1>Log in</h1><p>Having trouble? Try again later or contact us.</p>
  <input id="email" type="email" placeholder="Email address">
  <button onclick="window.__p.push('continue:'+document.getElementById('email').value);document.getElementById('err').textContent=${attr(says)}">Continue</button>
  <p id="err"></p><script>window.__p=[]</script></body>`;

// ---------------------------------------------------------------- 1. a bot rejection is not a wrong email
test("failureKind: generic failure words are the site refusing the browser; only words about the email are a rejected email", () => {
  for (const t of ["Something went wrong", "Oops! Something went wrong, please try again.", "Too many attempts. Try again later.", "Please try again", "An error occurred", "We've detected unusual activity", "Access denied"]) {
    assert.equal(em.failureKind(t), "refused", t);
  }
  for (const t of ["Invalid email domain", "No account found for that address", "Please enter a valid email", "That email is not recognised. Try again."]) {
    assert.equal(em.failureKind(t), "rejected", t);
  }
  assert.equal(em.failureKind("We just sent you a code"), "");
  assert.equal(em.failureKind("Having trouble? Try again later", "Having trouble? Try again later"), "", "copy that was on the page before the press is not news");
});

test("Spotify's answer (2026-11-12): 'Something went wrong' after the email is blocked_by_site — never 'which email do you use', never another address", async () => {
  const page = await pageWith(FORM("Something went wrong. Try again."));
  const logs = [], notes = [];
  let launches = 0;
  try {
    const out = em.startEmailSignin({
      conversationId: CONV, entry: SPOTIFY, email: EMAIL, settleMs: 20,
      launch: async () => { launches++; return { page, close: async () => {} }; },
      gmail: async () => { throw new Error("no mail is read for a refused sign-in"); },
      check: async () => { throw new Error("nothing to check"); },
      log: (l) => logs.push(l), note: (_c, t) => notes.push(t),
    });
    await out.run;
    assert.deepEqual(await page.evaluate(() => window.__p), [`continue:${EMAIL}`], "the email was submitted once and nothing pressed again");
  } finally { await page.close(); }
  assert.equal(notes.length, 1);
  const note = notes[0];
  assert.match(note, /Spotify blocking automated sign-in, NOT a wrong email/);
  assert.match(note, /Do NOT ask which email they use and do NOT try another address/);
  assert.match(note, /can lock their account/);
  assert.match(note, /Spotify blocks automated sign-in, so I can't sign you in there myself/);
  assert.match(note, /gmail_search for Spotify's receipts, confirmations and notices/, "the mail route");
  assert.match(note, /signin_link with site "spotify" \(no provider\) lets them type it themselves/, "their own sign-in where the page loads");
  assert.doesNotMatch(note, /which email their Spotify account uses|signin_email again/);

  // Written down with the day, so the next ask sends nothing to Spotify at all.
  const f = findings.signinFinding(SPOTIFY);
  assert.equal(f.kind, "refuses_after_email");
  assert.equal(f.source, "live");
  let started = 0;
  const again = await runTool("signin_email", { site: "spotify", email: "another.address@example.com" }, { conversationId: CONV, messages: [], startEmailSignin: () => { started++; return { ok: true, started: true }; } });
  assert.equal(again.ok, false);
  assert.equal(again.blocked, true);
  assert.equal(started, 0, "no retry with another address");
  assert.match(again.never, /do NOT try another address/);
  assert.match(again.say, /Spotify blocks automated sign-in/);

  // 2: the one line, and nothing personal in it.
  const lines = slog.recentAttempts();
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], ms: 0, at: "" }, { signin_attempt: "accounts.spotify.com", route: "emailed_code", outcome: "blocked_by_site", ms: 0, at: "", detail: "refused_after_email" });
  assert.ok(Number.isFinite(lines[0].ms) && lines[0].ms >= 0);
  assert.ok(!JSON.stringify([lines, logs]).includes(EMAIL), "no email address in any log line");
});

test("a real wrong email is still a wrong email; a challenge where the form should be is the site's wall", async () => {
  const wrong = await pageWith(FORM("No account found for that email. Try again."));
  try {
    const asked = await em.requestCode(wrong, EXAMPLE, EMAIL, { settleMs: 20 });
    assert.equal(asked.state, "rejected");
  } finally { await wrong.close(); }
  const wall = await pageWith(`<body><h1>Just a moment...</h1><p>Verifying you are human. This may take a few seconds.</p></body>`);
  try {
    const asked = await em.requestCode(wall, EXAMPLE, EMAIL, { settleMs: 20 });
    assert.equal(asked.state, "blocked");
    assert.equal(asked.detail, "wall_before_form");
  } finally { await wall.close(); }
  // A footer's reCAPTCHA line on a page with a working form is not a wall.
  const fine = await pageWith(`<body><input type="email" id="email"><button onclick="document.getElementById('s').textContent='We sent a code. Check your inbox.'">Continue</button><p id="s"></p><footer>This site is protected by reCAPTCHA.</footer></body>`);
  try {
    assert.equal((await em.requestCode(fine, EXAMPLE, EMAIL, { settleMs: 20 })).ok, true);
  } finally { await fine.close(); }
});

test("the site's own 429 to the press, with nothing said on the page, is a refusal of the browser", async () => {
  const page = await browser.newPage();
  try {
    await page.route("https://login.shop-example.com/**", (route) => {
      const url = route.request().url();
      if (url.endsWith("/api/code")) return route.fulfill({ status: 429, contentType: "application/json", body: "{}" });
      return route.fulfill({ status: 200, contentType: "text/html", body: `<body><input type="email" id="email"><button onclick="fetch('/api/code',{method:'POST'}).catch(()=>{})">Continue</button></body>` });
    });
    await page.goto("https://login.shop-example.com/signin");
    const asked = await em.requestCode(page, EXAMPLE, EMAIL, { settleMs: 40 });
    assert.equal(asked.state, "blocked", JSON.stringify(asked));
    assert.equal(asked.detail, "rate_limited");
    assert.match(asked.why, /HTTP 429/);
  } finally { await page.close(); }
});

// ---------------------------------------------------------------- 2. one line per attempt
test("the attempt log: signed in by emailed code, by emailed link, code not found, abandoned, wrong code — host, route, outcome, timing only", async () => {
  const CODE = "482913";
  const site = () => `<body><input type="email" id="email"><button id="go" onclick="ask()">Continue</button><div id="f"></div>
    <script>
      function ask() { document.getElementById("email").remove(); document.getElementById("go").remove(); document.getElementById("f").innerHTML = '<p>We sent you a code.</p><input id="code" autocomplete="one-time-code"><button type="button" onclick="verify()">Verify</button><p id="e"></p>'; }
      function verify() { document.getElementById("e").textContent = window.__wrong ? "Incorrect code. Request a new one." : ""; }
    </script></body>`;
  const run = async ({ gmail, check = async () => ({ ok: true, state: "signed_in", why: "loaded" }), wrong = false, replyWaitMs }) => {
    const page = await sitePage(site());
    if (wrong) await page.evaluate(() => { window.__wrong = true; });
    const notes = [];
    try {
      const out = em.startEmailSignin({ conversationId: CONV, entry: EXAMPLE, email: EMAIL, settleMs: 20, replyWaitMs, launch: async () => ({ page, close: async () => {} }), gmail, check, note: (_c, t) => notes.push(t) });
      await out.run;
    } finally { await page.close(); }
    return notes;
  };
  await run({ gmail: async () => ({ connected: true, found: true, kind: "code", code: CODE }) });
  await run({ gmail: async () => ({ connected: true, found: true, kind: "link", url: "https://login.shop-example.com/magic/verify?token=t0k3n" }) });
  await run({ gmail: async () => ({ connected: true, found: false }) });
  await run({ gmail: async () => ({ connected: false }), replyWaitMs: 30 });
  const wrongNotes = await run({ gmail: async () => ({ connected: true, found: true, kind: "code", code: CODE }), wrong: true, check: async () => { throw new Error("a wrong code is not checked as a sign-in"); } });
  assert.match(wrongNotes.at(-1), /said the code was wrong or expired/);
  const lines = slog.recentAttempts();
  assert.deepEqual(lines.map(l => [l.route, l.outcome]), [["emailed_code", "signed_in"], ["emailed_link", "signed_in"], ["emailed_code", "code_not_found"], ["emailed_code", "abandoned"], ["emailed_code", "wrong_code"]]);
  for (const l of lines) {
    assert.deepEqual(Object.keys(l).filter(k => k !== "detail").sort(), ["at", "ms", "outcome", "route", "signin_attempt"]);
    assert.equal(l.signin_attempt, "login.shop-example.com");
    assert.ok(Number.isFinite(l.ms) && l.ms >= 0);
  }
  const all = JSON.stringify(lines);
  assert.ok(!all.includes(EMAIL) && !all.includes(CODE) && !all.includes(OWNER) && !all.includes(CONV) && !all.includes("t0k3n"), "no email, code, link token, number or conversation");
});

test("logAttempt keeps only its own fields: a caller cannot put an address, a code or a number in", () => {
  const printed = [];
  const old = slog.setSink((l) => printed.push(l));
  try {
    const l = slog.logAttempt({ signin_url: "https://user:pw@accounts.example.com/login?email=me@example.com" }, { route: "emailed_link", outcome: "signed_in", startedAt: clock.now() - 1200, detail: "me@example.com 482913", email: "me@example.com", code: "482913", phone: OWNER });
    assert.deepEqual(Object.keys(l).sort(), ["at", "ms", "outcome", "route", "signin_attempt"]);
    assert.equal(l.signin_attempt, "accounts.example.com");
    assert.equal(l.ms, 1200);
    assert.equal(slog.logAttempt({ signin_url: "nonsense" }, { route: "by magic", outcome: "great" }).outcome, "failed");
    assert.equal(printed.length, 2, "always written, not only with --log");
    assert.doesNotMatch(printed.join("\n"), /me@example|482913|\+1202|pw@/);
  } finally { slog.setSink(old); }
});

test("a sign-in link nobody opened is not an attempt and leaves no line", async () => {
  const mk = (provider, state) => {
    const made = remote.createRemoteSignin({ conversationId: CONV, entry: EXAMPLE, provider, launch: async () => ({ page: { on() {} }, close: async () => {} }), check: async () => ({ ok: true, state, why: "read" }), timers: { set: () => ({}), clear: () => {} } });
    return made.url.split("/").pop();
  };
  mk("", "signed_out");
  mk("apple", "signed_out"); // replaces the first, which nobody opened: no browser, no attempt line
  await remote.endAllRemoteSignins("shutdown");
  assert.deepEqual(slog.recentAttempts(), [], "a link nobody opened is not an attempt");
});

// ---------------------------------------------------------------- 3. a footer link is not a sign-in button
const MARRIOTT = `<body>
  <header><a href="/sign-in">Sign In</a></header>
  <main><form id="signin" onsubmit="return false">
    <input type="email" placeholder="Email or member number"><input type="password" placeholder="Password">
    <button type="submit">Sign In</button>
  </form></main>
  <footer><ul class="social-links">
    <li><a href="https://www.facebook.com/marriottbonvoy" aria-label="Facebook" style="display:inline-block;width:32px;height:32px" onclick="window.__p.push('footer-facebook');return false">Facebook</a></li>
    <li><a href="https://www.instagram.com/marriottbonvoy" aria-label="Instagram" style="display:inline-block;width:32px;height:32px">Instagram</a></li>
    <li><a href="https://apps.apple.com/app/marriott/id455004730" style="display:inline-block;width:120px;height:40px" onclick="window.__p.push('app-store');return false">Download on the Apple App Store</a></li>
  </ul><a href="https://www.facebook.com/sharer/sharer.php?u=x" style="display:inline-block;width:120px;height:20px" onclick="window.__p.push('share');return false">Share with Facebook</a></footer>
  <script>window.__p=[]</script></body>`;

test("Marriott (2026-11-12): the footer's Facebook link to its social page is not a sign-in button — not pressed, not offered", async () => {
  const page = await pageWith(MARRIOTT);
  try {
    assert.equal(await page.evaluate(social.findProviderButton, "facebook"), "");
    assert.equal(await page.evaluate(social.findProviderButton, "apple"), "");
    assert.deepEqual(await page.evaluate(() => window.__p), [], "nothing was pressed");
    const labels = await page.evaluate(social.findProviderButton, { labels: true });
    assert.deepEqual(social.providersOnPage(labels), [], "the page offers no provider sign-in");
    assert.ok(labels.includes("sign in"), "the page's own controls are still read");
    assert.ok(labels.some(l => /instagram/.test(l)), "a control that names no provider is left alone");
  } finally { await page.close(); }
});

test("a real provider button still counts: in the sign-in form, by sign-in words, or by where it goes", async () => {
  const page = await pageWith(`<body>
    <a id="hand" href="/auth/facebook?next=/" style="display:inline-block;width:140px;height:30px" onclick="window.__p.push('handoff');return false">Facebook</a>
    <form onsubmit="return false"><input type="email">
      <button type="button" onclick="window.__p.push('apple')">Apple</button>
      <button type="button" onclick="window.__p.push('microsoft')">Continue with Microsoft</button>
    </form>
    <a href="https://appleid.apple.com/auth/authorize?client_id=x" style="display:inline-block;width:140px;height:30px">Apple</a>
    <footer><a href="https://www.facebook.com/v19.0/dialog/oauth?client_id=1" style="display:inline-block;width:140px;height:30px" onclick="window.__p.push('oauth-in-footer');return false">Facebook</a></footer>
    <script>window.__p=[]</script></body>`);
  try {
    assert.equal(await page.evaluate(social.findProviderButton, "facebook"), "facebook", "the site's own handoff to Facebook");
    assert.equal(await page.evaluate(social.findProviderButton, "apple"), "apple", "a bare name inside the sign-in form");
    assert.match(await page.evaluate(social.findProviderButton, "microsoft"), /continue with microsoft/);
    assert.deepEqual(await page.evaluate(() => window.__p), ["handoff", "apple", "microsoft"]);
    assert.deepEqual(social.providersOnPage(await page.evaluate(social.findProviderButton, { labels: true })).sort(), ["apple", "facebook", "microsoft"]);
    // Even in a footer, a link to the provider's sign-in endpoint is a sign-in button.
    await page.evaluate(() => document.getElementById("hand").remove());
    assert.equal(await page.evaluate(social.findProviderButton, "facebook"), "facebook");
    assert.deepEqual((await page.evaluate(() => window.__p)).slice(-1), ["oauth-in-footer"]);
  } finally { await page.close(); }
  // A bare name with no form and no box near it is a word, not a button.
  const bare = await pageWith(`<body><nav><button style="width:80px;height:30px" onclick="window.__p=1">Facebook</button></nav><p>News</p></body>`);
  try { assert.equal(await bare.evaluate(social.findProviderButton, "facebook"), ""); } finally { await bare.close(); }
});

// ---------------------------------------------------------------- 4. site capability is dated and expires
test("signin_status: DoorDash is 'blocked' as of the probe's date, with no way to sign in offered — not 'can sign in here'", async () => {
  const out = await runTool("signin_status", {}, { conversationId: CONV, messages: [] });
  assert.equal(out.can_sign_in_here, undefined);
  assert.equal(out.window_on_this_mac, true);
  const row = (s) => out.sites.find(x => x.site === s);
  const dd = row("doordash");
  assert.equal(dd.signin_here, "blocked");
  assert.equal(dd.signin_here_seen, "2026-11-12");
  assert.equal(dd.how_to_sign_in, undefined, "no sign-in is offered into a wall");
  assert.match(dd.blocked_say, /DoorDash blocks automated sign-in/);
  assert.match(dd.never, /do NOT try another address/);
  for (const s of ["uber", "uber_eats", "ticketmaster", "opentable"]) assert.equal(row(s).signin_here, "blocked", s);
  assert.equal(row("amazon").signin_here, "unknown", "nobody has asked Amazon lately, and nothing is claimed");
  assert.equal(row("amazon").how_to_sign_in, "npm run signin -- amazon");
  assert.match(out.note, /signin_here.*blocked means do not offer a sign-in there/);
});

test("a stored wall is believed for 14 days, then the site is asked again — and it changes both ways", async () => {
  const dd = signin.anyEntryFor("doordash");
  let asked = 0;
  const wall = (answer) => async () => { asked++; return answer; };
  const fresh = await findings.signinAccess(dd, { live: wall({ in: true, status: 200 }) });
  assert.deepEqual([fresh.state, fresh.seen, fresh.checked_live, asked], ["blocked", "2026-11-12", false, 0], "fresh: not asked");

  clock.skip(15 * DAY);
  assert.equal(findings.signinFinding(dd).fresh, false);
  assert.equal(findings.signinAccessStored(dd).stale, true, "a list says it is old rather than repeating it as today's");
  // The wall is still up: said as seen today.
  const still = await runTool("signin_status", { site: "doordash" }, { conversationId: CONV, messages: [], signinWall: wall({ in: false, status: 403, why: "DoorDash's sign-in page answers Reason's browser from here with a bot check (HTTP 403)." }) });
  assert.equal(asked, 1, "the site was asked");
  assert.equal(still.sites[0].signin_here, "blocked");
  assert.equal(still.sites[0].signin_here_checked_now, true);
  assert.equal(still.sites[0].signin_here_seen, "2026-11-27");
  // A day later that live wall is old too; the wall has come down.
  clock.skip(2 * DAY);
  const lifted = await runTool("signin_status", { site: "doordash" }, { conversationId: CONV, messages: [], signinWall: wall({ in: true, status: 200, providers_offered: [] }) });
  assert.equal(lifted.sites[0].signin_here, "open");
  assert.ok(lifted.sites[0].how_to_sign_in, "a way in is offered again");
  // And up again: a link that meets the wall writes it down.
  findings.recordFinding(dd, { kind: "walled", status: 403, why: "bot check" });
  const link = await runTool("signin_link", { site: "doordash" }, { conversationId: CONV, messages: [], createRemoteSignin: () => { throw new Error("no link into a wall"); } });
  assert.equal(link.blocked, true);
});

test("an old wall that cannot be asked again is said with its date, never as today's news; an outage does not clear it", async () => {
  const dd = signin.anyEntryFor("doordash");
  clock.skip(20 * DAY);
  const out = await findings.signinAccess(dd, { live: async () => ({ in: false, status: 502, why: "HTTP 502" }) });
  assert.deepEqual([out.state, out.stale, out.seen], ["blocked", true, "2026-11-12"]);
  const link = await runTool("signin_link", { site: "doordash" }, { conversationId: CONV, messages: [], signinWall: async () => ({ in: false, status: 502, why: "HTTP 502" }), createRemoteSignin: () => { throw new Error("no link"); } });
  assert.equal(link.blocked, true);
  assert.match(link.stale, /Last seen 2026-11-12/);
});

test("signin_status recheck: an account page that answers 403 is the site's wall — said as a block and written down, not 'try again in a bit'", async () => {
  const out = await runTool("signin_status", { site: "fandango", recheck: true }, {
    conversationId: CONV, messages: [], pageFor: async () => ({}),
    checkAndRecord: async () => ({ ok: true, site: "fandango", state: "unknown", status: 403, why: "https://www.fandango.com/accounts/dashboard answered HTTP 403" }),
  });
  assert.equal(out.blocked, true);
  assert.equal(out.signin_here, "blocked");
  assert.equal(out.could_not_check, undefined);
  assert.match(out.say, /Fandango blocks automated sign-in/);
  assert.equal(findings.signinFinding(signin.anyEntryFor("fandango")).kind, "walled");
});

// ---------------------------------------------------------------- 5. Google, honestly
test("a site that only offers 'Continue with Google': no route, said plainly, no link sent, Google never pressed or promised", async () => {
  const page = await pageWith(`<body><h1>Welcome</h1><button style="width:200px;height:40px" onclick="window.__p.push('google')">Continue with Google</button><script>window.__p=[]</script></body>`);
  const notes = [];
  try {
    const out = em.startEmailSignin({ conversationId: CONV, entry: EXAMPLE, email: EMAIL, settleMs: 20, launch: async () => ({ page, close: async () => {} }), gmail: async () => ({ connected: false }), note: (_c, t) => notes.push(t) });
    await out.run;
    assert.deepEqual(await page.evaluate(() => window.__p), [], "Google was not pressed");
  } finally { await page.close(); }
  assert.match(notes[0], /offers only Google, and Google refuses Reason's browser/);
  assert.match(notes[0], /do not send one/);
  assert.match(notes[0], /Never say you will use or press their Google login/);
  assert.match(notes[0], /only lets you in with Google, and Google won't let my browser sign in/);
  assert.equal(slog.recentAttempts().at(-1).outcome, "no_email_route");
  assert.equal(slog.recentAttempts().at(-1).detail, "google_only");
});

test("no wording anywhere promises to press or use a Google login", () => {
  assert.equal(social.usableProvider("google"), "");
  assert.doesNotMatch(social.expectLine("google"), /ping your phone|Tap Yes/);
  assert.equal(social.loginWords(""), "your Apple login", "the default words are never Google's");
  assert.match(social.RULES, /A site that only offers Google cannot be signed in to here: say that plainly, and never say you will press or use their Google login/);
  assert.match(social.RULES, /is the site refusing your browser, NEVER a wrong email/);
  process.env.REASON_SOCIAL_SIGNIN = "off";
  const plain = toolsFor(CONV).find(t => t.name === "signin_link").input_schema.properties.provider.description;
  assert.doesNotMatch(plain, /already pressed|land on Google/);
  assert.match(plain, /Never promise to press or use their Google login/);
});

// ---------------------------------------------------------------- 6. the probe's findings are what the tools read
test("every site the 2026-11-12 probe found walled answers 'blocked' by its name or address; Spotify refuses after the email", async () => {
  const walled = ["doordash", "uber", "uber_eats", "linkedin.com", "medium.com", "https://dash.cloudflare.com/login", "cloudflare.com", "claude.ai", "godaddy.com", "https://sso.godaddy.com", "amctheatres.com", "ticketmaster", "canva.com", "indeed.com", "x.com", "twitter.com", "walmart.com", "target.com", "eventbrite.com", "reddit.com", "opentable", "hetzner.com", "https://accounts.hetzner.com/login"];
  for (const name of walled) {
    const e = signin.anyEntryFor(name);
    assert.ok(e, name);
    const a = await findings.signinAccess(e);
    assert.deepEqual([name, a.state, a.kind, a.seen], [name, "blocked", "walled", "2026-11-12"]);
  }
  const sp = await findings.signinAccess(SPOTIFY);
  assert.deepEqual([sp.state, sp.kind], ["blocked", "refuses_after_email"]);
  for (const name of ["notion.so", "airbnb.com", "amazon", "fandango"]) assert.equal((await findings.signinAccess(signin.anyEntryFor(name))).state, "unknown", name);

  // OpenAI: the probe's wall was the platform's own address. Its sign-in resolves to the ChatGPT entry
  // (auth.openai.com), which the probe did not name — so it is asked live rather than assumed.
  let live = 0;
  const openai = await findings.signinAccess(signin.anyEntryFor("https://platform.openai.com/login"), { live: async () => { live++; return { in: false, status: 403, why: "bot check (HTTP 403)" }; } });
  assert.deepEqual([live, openai.state, openai.checked_live], [1, "blocked", true]);

  // A walled site by its address: no emailed code asked for, no link made, one honest line.
  let touched = 0;
  const ctx = { conversationId: CONV, messages: [], publicUrl: async (url) => ({ ok: true, url }), startEmailSignin: () => { touched++; return { ok: true }; }, createRemoteSignin: () => { touched++; return { ok: true, url: "x" }; } };
  for (const tool of ["signin_email", "signin_link"]) {
    const out = await runTool(tool, { site: "https://www.linkedin.com/login", email: EMAIL }, ctx);
    assert.equal(out.blocked, true, tool);
    assert.match(out.say, /Linkedin blocks automated sign-in, so I can't sign you in there myself/);
    assert.match(out.instead, /gmail_search for Linkedin's receipts, confirmations and notices/);
    assert.match(out.instead, /No sign-in link or window/);
  }
  // Spotify: no emailed code, but their own sign-in on the link is still theirs to try.
  assert.equal((await runTool("signin_email", { site: "spotify", email: EMAIL }, ctx)).blocked, true);
  assert.equal(touched, 0);
  const link = await runTool("signin_link", { site: "spotify" }, ctx);
  assert.equal(link.ok, true, JSON.stringify(link).slice(0, 300));
  assert.equal(touched, 1);
});

test("the probe's record in docs/ and the findings the product reads say the same thing", () => {
  const doc = JSON.parse(readFileSync(new URL("../docs/site-probe-2026-11-12-signin.json", import.meta.url), "utf8"));
  const mine = findings.PROBE.filter(f => f.seen === doc.probed_at).map(f => [f.label, f.kind, f.hosts.join(",")]);
  assert.deepEqual(doc.sites.map(s => [s.site, s.verdict, s.signin_hosts.join(",")]), mine);
  assert.equal(mine.length, 20);
  for (const f of findings.PROBE) assert.match(f.seen, /^\d{4}-\d\d-\d\d$/, "every finding has its day");
});
