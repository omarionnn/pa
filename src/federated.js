// "Continue with Google" as a way to sign in to a site the person named (owner decision 2026-11-13).
//
// The person keeps their Google login in the vault (src/sitepolicy.js: accounts.google.com is careful,
// every other Google property is never). For a site they sign in to with Google (src/savedlogins.js
// signin_routes), Reason:
//   1. goes to the site's own sign-in page and presses the site's own "Continue with Google" button (a
//      real control on that page, by its accessible name, on the page's own frame; never a link Reason
//      makes);
//   2. lets the browser reach EXACTLY https://accounts.google.com, only after that press (src/browser.js
//      armIdp), in the tab or in the one popup that press opened;
//   3. types the saved Google login there under the filler's rules (exact origin, the page's own frame,
//      one real password box, the secret straight from the vault and zero-filled): src/filler.js
//      googleCredentials, the only place a login is opened;
//   4. relays Google's own check once (a prompt to tap, a code) and stops on anything else (a passkey, a
//      picture check, "This browser or app may not be secure", "Couldn't sign you in", unusual activity);
//   5. allows Google's consent only when the site asks for the basic profile and email address;
//   6. is back on the named site's own registrable domain, or it stops. Any top-level page of another
//      Google property (Gmail, Drive, settings), during the job or after, ends the job and signs this
//      browser out of Google.
// One Face ID approval covers the whole chain for one sign-in to one site. The named-site rule applies
// to the site; the Google step is only reachable inside such a job.
import { clock } from "./config.js";
import { classifySite, registrableOf, refusalFor } from "./sitepolicy.js";
import { peekForSignin, setState, recordLoginEvent, savedLoginsAllowedFor } from "./savedlogins.js";
import {
  closeBrowser as closeErrandBrowser, guardContext, holdProfile, releaseProfile, pinSite, unpinSite, pinExact, armIdp, disarmIdp, watchGoogle,
  isGoogleProperty, locateSigninPage,
} from "./browser.js";
import { namedByThem } from "./namedsite.js";
import { askFaceId, takeApproval, takeResume, spendSaveGrants, faceIdState } from "./loginuse.js";
import { requestOf } from "./resume.js";
import { logAttempt, logDiag } from "./signinlog.js";
import { awaitCodeReply } from "./signinemail.js";
import * as restartGate from "./busy.js";
import { reachPinned, frontDoorOf } from "./filler.js";
import { recordFinding } from "./sitefindings.js";
import { markRefusing, clearRefusal, refusingSite } from "./refusing.js";

export const GOOGLE = "https://accounts.google.com";
/** How long Google's "tap Yes / tap the number" prompt is waited for. */
export const TAP_WAIT_MS = 3 * 60_000;
const RETRY_PAUSE_MS = 24 * 60 * 60_000;
const STEP_MS = 15_000;
const BUTTON_WAIT_MS = 5_000;

const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return ""; } };
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ""; } };

// ---------------------------------------------------------------- the site's own button
/** The site's own "Continue with Google" control: a button or link on the page's own frame, by its accessible name. */
export const GOOGLE_BUTTON = /^\s*(continue|sign in|log in|login|sign up|connect) with google\s*$/i;
async function googleButton(page) {
  for (const role of ["button", "link"]) {
    const c = page.getByRole(role, { name: GOOGLE_BUTTON });
    const n = Math.min(await c.count().catch(() => 0), 4);
    for (let i = 0; i < n; i++) if (await c.nth(i).isVisible().catch(() => false)) return c.nth(i);
  }
  return null;
}

// ---------------------------------------------------------------- reading Google's page
/** Runs in the top frame of accounts.google.com: what is showing. Read only to name the step; never typed into here. */
const GOOGLE_JS = `(() => {
  var vis = function (e) { var r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  var all = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)).filter(vis); };
  var codeBox = all('input').filter(function (i) { var h = (i.name + ' ' + i.id + ' ' + (i.getAttribute('autocomplete') || '') + ' ' + (i.getAttribute('aria-label') || '')).toLowerCase();
    return i.type !== 'hidden' && i.type !== 'password' && i.type !== 'email' && (/one-time-code|totppin|idvpin|\\bpin\\b|code/.test(h) || i.type === 'tel'); }).length;
  var big = null, size = 0;
  all('[data-number], h1, h2, div, span').forEach(function (e) { var t = (e.textContent || '').trim(); if (/^\\d{1,3}$/.test(t) && e.children.length === 0) { var f = parseFloat(getComputedStyle(e).fontSize); if (f > size) { size = f; big = t; } } });
  return {
    text: String((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 4000),
    email: all('input[type=email]').length, pass: all('input[type=password]').length, code: codeBox,
    chooser: all('[data-identifier]').map(function (e) { return String(e.getAttribute('data-identifier') || ''); }),
    another: all('[role=link], a, button, li, div[role=button]').some(function (e) { return /^\\s*use another account\\s*$/i.test(e.textContent || ''); }),
    scopes: all('[data-scope], li').map(function (e) { return (e.textContent || '').replace(/\\s+/g, ' ').trim(); }).filter(Boolean).slice(0, 20),
    hidden: Array.prototype.slice.call(document.querySelectorAll('[data-scope], li')).filter(function (e) { return !vis(e); }).map(function (e) { return (e.textContent || '').replace(/\\s+/g, ' ').trim(); }).filter(Boolean).slice(0, 20),
    checks: all('input[type=checkbox], [role=checkbox]').length,
    number: big,
    frames: Array.prototype.slice.call(document.querySelectorAll('iframe')).filter(vis).map(function (f) { return String(f.src || '').split('?')[0]; }).slice(0, 5)
  };
})()`;

const BLOCKS = [
  ["browser_not_secure", /this browser or app may not be secure/i],
  ["couldnt_sign_in", /couldn['’]t sign you in/i],
  ["captcha", /type the text you hear or see|enter the characters you see|i['’]?m not a robot/i],
  ["passkey", /use your passkey|security key|insert your (security )?key|use your fingerprint, face or screen lock/i],
  ["unusual_activity", /unusual activity|suspicious activity|we noticed something unusual/i],
  ["another_way", /^(?:.{0,80})(choose how you want to sign in|try another way to sign in)/i],
];
/**
 * Google turning the browser itself away at the email step (a control run on 2026-11-15 got exactly this
 * from two sites' own Continue with Google buttons): recorded against google.com as a strike
 * (src/refusing.js "browser_refused"), and said as Google's refusal of the browser with what still works
 * for the site. The other stops (a passkey, a picture check, unusual activity) are about this sign-in.
 */
export const TURNED_AWAY = new Set(["browser_not_secure", "couldnt_sign_in"]);
/** Google answered about the ACCOUNT, so it let the browser in: the google.com refusal record clears. */
const GOOGLE_LET_IN = new Set(["signed_in", "wrong_password", "needs_google_tap", "needs_google_code", "not_accepted", "consent_more"]);
export const BLOCK_WORDS = {
  browser_not_secure: 'it said "This browser or app may not be secure"',
  couldnt_sign_in: `it said "Couldn't sign you in"`,
  captcha: "it showed a picture or sound check, which I don't solve",
  passkey: "it asked for a passkey or security key, which I can't use",
  unusual_activity: "it flagged unusual activity",
  another_way: "it asked to choose another way to sign in",
  challenge_frame: "it showed a human check, which I don't solve",
};
const CONSENT = /wants (additional )?access to your google account|wants to access your google account|will allow google to share|to continue, google will share/i;

/** What Google's page is asking for now. */
export function googleStep(r) {
  if (!r) return { kind: "unknown" };
  const t = String(r.text ?? "");
  for (const [k, re] of BLOCKS) if (re.test(t)) return { kind: "blocked", which: k };
  if ((r.frames ?? []).some((f) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha|arkoselabs|challenges\.cloudflare/.test(f))) return { kind: "blocked", which: "challenge_frame" };
  if (r.pass && /wrong password|incorrect password/i.test(t)) return { kind: "wrong_password" };
  if (r.email && /couldn['’]t find your google account|enter a valid email/i.test(t)) return { kind: "not_accepted", msg: t };
  if (CONSENT.test(t)) return { kind: "consent" };
  if (r.code) {
    const from = /google authenticator|authenticator app/i.test(t) ? "an authenticator app"
      : /text message|\bsms\b|texted|sent to/i.test(t) ? "the text Google just sent you"
        : "the Google app on your phone (g.co/sc)";
    return { kind: "code", from };
  }
  if (/tap yes|check your (phone|device)|tap the number|choose the number|tap \d{1,3}\b|open the google app/i.test(t)) {
    // Fixed words only (review 2026-11-13): the number, never the page's text (a device name is page text).
    return { kind: "tap", number: /^\d{1,3}$/.test(String(r.number ?? "")) ? String(r.number) : "" };
  }
  if (r.chooser?.length || r.another) return { kind: "chooser" };
  if (r.pass === 1) return { kind: "password" };
  if (r.email) return { kind: "email" };
  return { kind: "unknown" };
}

/** Anything beyond the basic profile and email address (named in the stop message by a fixed word). */
export const MORE_THAN_BASIC = /gmail|e-?mail messages|read, compose|send (e-?)?mail|drive|docs|sheets|slides|files|contacts|calendar|photos|youtube|location|phone number|birth|street address|home address|postal address|tasks|fitness|health|delete|manage|\bedit\b/i;
const MORE_WORDS = [[/gmail|e-?mail messages|read, compose|send (e-?)?mail/i, "Gmail"], [/drive|docs|sheets|slides|files/i, "Drive"], [/contacts/i, "contacts"],
  [/calendar/i, "calendar"], [/photos/i, "photos"], [/youtube/i, "YouTube"], [/location|street address|home address|postal address/i, "location or address"],
  [/phone number/i, "phone number"], [/birth/i, "date of birth"]];
// The basic sign-in, positively recognised (review 2026-11-13: fail closed). A scope line is a sentence that
// says what the site may do ("See ...", "Associate ..."); footer links (Help, Privacy, Terms) are not.
const SCOPE_LINE = /\b(see|view|read|edit|create|delete|manage|send|access|know|associate|share|download|upload|make|modify|use|your)\b/i;
const BASIC_SCOPE = [
  /^(see|view) your (primary )?(google account )?email address\.?$/i,
  /^(see|view) your personal info(,? including any personal info you['’]ve made publicly available)?\.?$/i,
  /^(see|view) your basic profile info\.?$/i,
  /^associate you with your personal info on google\.?$/i,
];
const BASIC_SHARED = /^(your )?(name|email|email address|language preference|profile picture)$/i;
const DETAILS = /see details|show details|more details|select all|select what|choose what .{0,40}can access|wants additional access/i;
const SHARE_LIST = /share your (.{1,160}?) with /i;

/**
 * The consent screen asks for the basic profile and email address only: every scope line, shown or hidden,
 * is one of Google's basic ones, Google's "will share your ..." list holds only name, email, language and
 * picture, and at least one of the two was recognised. Anything else, a "See details" or a list of
 * checkboxes, stops. → { ok, more: fixed words for what more it asked }
 */
export function basicConsent(r) {
  const t = String(r?.text ?? "");
  const lines = [...(r?.scopes ?? []), ...(r?.hidden ?? [])].map((x) => String(x).replace(/\s+/g, " ").trim()).filter((x) => SCOPE_LINE.test(x));
  const share = SHARE_LIST.exec(t)?.[1] ?? "";
  const shared = share ? share.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map((x) => x.trim()).filter(Boolean) : [];
  const odd = [...lines.filter((x) => !BASIC_SCOPE.some((re) => re.test(x))), ...shared.filter((x) => !BASIC_SHARED.test(x))];
  const recognised = lines.length > 0 || shared.length > 0;
  const ok = recognised && !odd.length && !DETAILS.test(t) && !(r?.checks > 0);
  const more = [...new Set(odd.map((x) => MORE_WORDS.find(([re]) => re.test(x))?.[1] ?? "other access"))];
  return { ok, more: ok ? [] : (more.length ? more : ["details I couldn't check"]).slice(0, 3) };
}

async function readGoogle(gp) {
  if (!gp || gp.isClosed()) return null;
  if (originOf(gp.url()) !== GOOGLE) return null;
  try { return await gp.evaluate(GOOGLE_JS); } catch { return null; }
}

// ---------------------------------------------------------------- the words
function say(result, site, extra = {}) {
  const lines = {
    signed_in: `Signed you in to ${site} with your Google account.`,
    needs_google_login: `To sign in to ${site} with Google I need your Google login saved first, so I haven't opened anything.`,
    no_google_button: `I couldn't sign you in to ${site}: its sign-in page didn't show a "Continue with Google" button of its own, so I typed nothing.`,
    // The site itself walled the browser before its sign-in page showed (not Google): the Google login is untouched.
    site_walled: `${site} turned my browser away before its sign-in page showed, so I typed nothing and stopped. That's their choice, not something you did.`,
    off_site: `I couldn't sign you in to ${site}: its sign-in link didn't keep me on ${site}, so I pressed nothing and typed nothing.`,
    origin_mismatch: `I couldn't sign you in to ${site}: its Google button didn't lead to Google's own sign-in page (accounts.google.com), so I typed nothing.`,
    blocked: TURNED_AWAY.has(extra.which) ? turnedAway(site, extra.page)
      : `Google stopped the sign-in to ${site}: ${BLOCK_WORDS[extra.which] ?? "it blocked it"}. That's Google's call, not something you did. I stopped and won't retry.`,
    // Google is on record as turning the browser away (src/refusing.js): nothing opened, no Face ID asked.
    google_refused: turnedAway(site, extra.page),
    wrong_password: `I couldn't sign you in to ${site}: Google said the saved Google password is wrong. I've stopped and won't use it again until you save it again.`,
    not_accepted: `I couldn't sign you in to ${site}: Google didn't accept the saved Google login. I've stopped and won't try again until tomorrow.`,
    consent_more: `I stopped signing you in to ${site}: it asked Google for more than your name and email address${extra.more?.length ? ` (${extra.more.join("; ")})` : ""}. I didn't allow it, so you're not signed in. I won't try ${site} with Google again until tomorrow.`,
    google_property: `I stopped the ${site} sign-in: something tried to open another Google page (like Gmail, Drive or your settings), which I never do with your Google login. I signed this browser out of Google.`,
    needs_google_tap: `Google wants you to confirm it's you on your phone: open the Google prompt and ${/^\d{1,3}$/.test(String(extra.number ?? "")) ? `tap ${extra.number}` : "tap Yes"}. I'll carry on by myself when you do; I'll wait 3 minutes.`,
    needs_google_code: `Google wants a code to finish signing you in to ${site}, from ${extra.from ?? "your phone"}. Send it to me and I'll type it in, once.`,
    no_answer: `Google's check wasn't answered in time, so I stopped. You're not signed in to ${site}, and I won't try again until tomorrow.`,
    code_not_found: `The Google code didn't come in time, so I stopped. You're not signed in to ${site}, and I won't try again until tomorrow.`,
    wrong_code: `Google didn't accept the code. I stopped and didn't try another. You're not signed in to ${site}.`,
    paused: `${site} is paused after an earlier refusal, so I didn't try again.`,
    pick_one: `You have more than one Google login saved. Tell me which one to use for ${site}.`,
    busy: `I'm already using the browser for you right now. I'll sign in to ${site} once that's done.`,
    not_signin_page: `I couldn't sign you in to ${site}: its sign-in page didn't load the way I expected, so I stopped.`,
  };
  const away = result === "google_refused" || (result === "blocked" && TURNED_AWAY.has(extra.which));
  return { ok: result === "signed_in", result, route: "google", say_exactly: lines[result] ?? `I couldn't sign you in to ${site}.`,
    ...(away ? { google_refused: true, instead: ["emailed_code", "password", "their_own_signin"], ...(extra.page ? { signin_page: extra.page } : {}) } : {}) };
}
/**
 * Said once, plainly: Google refused the browser, nothing is retried, and what still works for the site.
 * The emailed code is the site's own (read by Reason where it can read their mail); `page` is the site's
 * own sign-in page when the job found it.
 */
export function turnedAway(site, page = "") {
  return `Google turned my browser away, so I can't use Continue with Google for you right now. I stopped and won't retry. `
    + `I can still get you into ${site} with the code ${site} emails you, or with a ${site} password if your account there has one`
    + (page ? `, or you can sign in yourself on ${site}'s own page: ${page}` : `, or you can sign in yourself on ${site}'s own sign-in page`) + ".";
}

// ---------------------------------------------------------------- Google's session, never kept (review 2026-11-13)
// The profile is kept between jobs (src/browser.js launchProfile; the owner's real Chrome since #556), so a
// Google session left in it would sign every later errand in to Gmail and Drive. At the start and at the
// end of every chain, whatever the ending: every cookie of a Google domain, and Google's own storage, go.
// The named site's cookies stay. Cost: Google sees a fresh browser each time and asks to verify more often.
export const GOOGLE_COOKIE_DOMAIN = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|gmail\.com|googlemail\.com|youtube\.com|googleusercontent\.com|googleapis\.com|gstatic\.com|withgoogle\.com)$/i;
const GOOGLE_ORIGINS = ["https://accounts.google.com", "https://www.google.com", "https://myaccount.google.com", "https://mail.google.com",
  "https://drive.google.com", "https://accounts.youtube.com", "https://www.youtube.com"];
export async function signOutOfGoogle(context) {
  if (!context) return;
  try { await context.clearCookies({ domain: GOOGLE_COOKIE_DOMAIN }); } catch { /* closed already */ }
  let cdp = null;
  try {
    const p = context.pages().find((x) => !x.isClosed());
    cdp = p ? await context.newCDPSession(p) : null;
    for (const origin of GOOGLE_ORIGINS) {
      await cdp?.send("Storage.clearDataForOrigin", { origin, storageTypes: "cookies,local_storage,indexeddb,websql,cache_storage,service_workers,file_systems" }).catch(() => {});
    }
  } catch { /* not Chromium, or closed: the cookies above are the session */ }
  finally { await cdp?.detach?.().catch(() => {}); }
}

// ---------------------------------------------------------------- the job
let jobs = 0;
/**
 * Sign in to `site` (a bare host they named) through its own "Continue with Google", with their saved
 * Google login. Called by src/filler.js signIn, which has already checked the switch and the never list.
 * `credentials(gp, row, { email })`: src/filler.js googleCredentials (the only place a login is opened).
 * Injectable for tests: launch, locate, awaitReply, note, tapWaitMs, stepMs.
 */
export async function signInWithGoogle(conversationId, site, {
  trigger = null, purpose = "", launch, credentials, now = () => clock.now(), locate = locateSigninPage,
  awaitReply = awaitCodeReply, note = () => {}, tapWaitMs = TAP_WAIT_MS, stepMs = STEP_MS, waitMs = undefined,
  liveAskOk = (t) => t?.kind === "user",
} = {}) {
  const c = String(conversationId ?? "");
  const host = String(site ?? "").toLowerCase();
  const base = registrableOf(host);
  if (!savedLoginsAllowedFor(c) || !host || isGoogleProperty(host)) return { ok: false, result: "no_login", say_exactly: refusalFor("google_property") };
  const why = String(purpose ?? "");
  const rows = peekForSignin(c, "google.com").filter((r) => r.site === "google.com" && r.signin_origin === GOOGLE);
  if (!rows.length) return { ...say("needs_google_login", host), offer: "google.com" };
  if (rows.length > 1) return say("pick_one", host);
  const g = rows[0];
  // Google on record as turning the browser away (two refusals 10+ minutes apart, believed 7 days; any
  // later account-level answer from Google clears it): said up front, nothing opened, no Face ID ask.
  { let r = null; try { r = refusingSite("google.com", now()); } catch { r = null; } if (r) return say("google_refused", host); }
  if (["refused", "paused", "needs_person"].includes(g.state) || (g.next_try_at && now() < g.next_try_at)) return say("paused", host);
  if (g.state === "wrong_password") return say("wrong_password", host);

  // The live ask, or a job carried on by the runtime with a grant issued for this login and this site.
  const resumed = !liveAskOk(trigger) && trigger?.resume ? takeResume(c, trigger.resume, { loginId: g.id, site: host, savedSite: host }, { now: now() }) : null;
  if (!liveAskOk(trigger) && !resumed) {
    if (trigger?.resume) return { ok: false, result: "resume_spent", say_exactly: "" };
    return { ok: false, result: "needs_face_id", say_exactly: `I only sign in to ${host} when you ask me in the moment. Ask me and I'll do it.` };
  }
  // The named-site rule, on the SITE (the Google step needs no naming of its own).
  const face = resumed ? "" : faceIdState(c, g.id, { now: now(), site: host });
  const named = resumed || face === "approved" || namedByThem(trigger?.messages ?? [], { site: host, label: host }, []).ok;
  if (!named && face === "waiting") return { ok: false, result: "waiting_face_id", say_exactly: "" };
  if (!named && face === "just_used") return { ok: false, result: "resume_spent", say_exactly: "" };
  if (!named) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "stopped", purpose: why });
    return { ok: false, result: "not_named", say_exactly: `Sign in to ${host} for that?` };
  }
  // Face ID before every use (careful), one approval for the whole chain of this one sign-in.
  if (resumed?.kind !== "approved" && !takeApproval(c, g.id, { now: now(), site: host })) {
    const request = resumed?.request ?? requestOf(trigger?.messages ?? []);
    const ask = askFaceId(c, g.id, host, { now: now(), request, google: true, via: trigger?.channel === "web" ? "web" : trigger?.channel ? "phone" : "" });
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    return { ok: false, result: "needs_face_id", route: "google",
      say_exactly: `Approve signing in to ${host} with your Google account here${request ? " and I'll carry on by myself" : ", then tell me to go ahead"}:\n${ask.link}` };
  }
  spendSaveGrants(c, [host]);

  const holder = Symbol("federated");
  if (!holdProfile(c, holder)) return say("busy", host);
  const gateId = `federated:${++jobs}`;
  restartGate.hold(gateId, { kind: "saved_login" });
  const startedAt = now();
  const diag = { boxes: [] };
  let session = null, handedOff = false, typed = false, breached = false, signinPage = "";
  const onGoogle = (context) => { breached = true; unpinSite(c); void signOutOfGoogle(context ?? session?.context); try { recordLoginEvent(c, { site: host, event: "signin", outcome: "google_property", purpose: why }); } catch { /* best effort */ } };

  const walled = () => { try { recordFinding({ site: host, label: host, signin_url: `https://${host}/` }, { kind: "walled", why: "challenge before the sign-in page (Google route)" }); } catch { /* best effort */ } };
  const end = (result, extra = {}) => {
    if (result === "blocked" && TURNED_AWAY.has(extra.which)) {
      try { markRefusing("google.com", "browser_refused", now()); } catch { /* a record that cannot be written never breaks the answer */ }
      if (signinPage && !extra.page) extra = { ...extra, page: signinPage };
    }
    if (GOOGLE_LET_IN.has(result)) { try { clearRefusal("google.com", now()); } catch { /* best effort */ } }
    if (result === "signed_in") setState(c, g.id, { state: "working", failCount: 0, clearNextTry: true });
    else if (result === "wrong_password") setState(c, g.id, { state: "wrong_password", bumpFail: true });
    else if (result === "blocked") setState(c, g.id, { state: "refused" });
    else if (typed) setState(c, g.id, { nextTryAt: now() + RETRY_PAUSE_MS });
    if (result !== "signed_in") unpinSite(c);
    const outcome = result === "signed_in" ? "signed_in" : result === "blocked" || result === "site_walled" ? "blocked_by_site" : result === "wrong_code" ? "wrong_code" : result === "code_not_found" ? "code_not_found" : "failed";
    logAttempt({ signin_url: `https://${host}/` }, { route: "continue_with_google", outcome, startedAt, detail: outcome === "failed" ? result : (extra.which ?? "") });
    if (result !== "signed_in") logDiag({ signin_url: `https://${host}/` }, { ...diag, result, msgClass: extra.which ? "other" : "none", msg: extra.which ?? "" });
    recordLoginEvent(c, { site: host, event: "signin", outcome: result === "blocked" || result === "site_walled" ? "blocked" : result === "off_site" ? "origin_mismatch" : result, purpose: why });
    return say(result, host, extra);
  };

  try {
    unpinSite(c);
    await closeErrandBrowser(c);
    // The site's own sign-in page, found as the save flow finds one (never a link from a page or an email):
    // its address is the pin (origin + path). It is REACHED the way the password route reaches its pinned
    // page (src/filler.js reachPinned, 2026-11-13): a page on a host of its own (identity.doordash.com) from
    // the site's home page through its own Sign In link first, never loaded bare first (a bare identity page
    // is walled and spoils the visit); counted only on the exact pinned origin + path.
    let at = null;
    try { at = await locate({ site: base, label: host, signin_url: `https://${host}/`, generic: true }); } catch { at = null; }
    let pin = null;
    if (at?.found && at?.url) {
      signinPage = /^https:\/\/[^\s?#]+$/.test(String(at.url)) ? String(at.url) : "";
      let u = null;
      try { u = new URL(String(at.url)); } catch { u = null; }
      if (!u || u.protocol !== "https:" || registrableOf(u.hostname.toLowerCase()) !== base) return end("not_signin_page");
      if (u.pathname !== "/") pin = { site: host, signin_origin: u.origin, signin_path: u.pathname };
    }

    session = await launch({ conversationId: c });
    await guardContext(session.context, { conversationId: c });
    // Start from no Google session (one left by a crash, or by anything else in this kept profile).
    await signOutOfGoogle(session.context);
    const page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(20_000);
    watchGoogle(c, onGoogle);
    if (pin) {
      const got = await reachPinned(page, pin, { conversationId: c, need: "page" });
      if (breached) return end("google_property");
      if (got.verdict === "wall") { walled(); return end("site_walled"); }
      if (got.verdict === "origin_mismatch") return end("off_site");
      if (got.verdict !== "ok") return end("not_signin_page");
    } else {
      // No sign-in page known: the site's home page, then its own Sign In link; the page it lands on
      // under the site's own domain is where its Google button is looked for. Nothing is typed there.
      pinSite(c, base, { secure: true });
      const w = await frontDoorOf(page, host);
      if (breached) return end("google_property");
      if (w.how === "walled") { walled(); return end("site_walled"); }
      if (w.how === "not_loaded") return end("not_signin_page");
    }
    // From here the browser is held to the site (its domain, https) until the one Google exception below.
    pinSite(c, base, { secure: true });
    if (!/^https:/.test(page.url()) || registrableOf(hostOf(page.url())) !== base) return end("off_site");
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
    // A sign-in page drawn by its own script shows its buttons late: looked for, bounded, never pressed until found.
    let button = null;
    for (const until = Date.now() + BUTTON_WAIT_MS; !button && Date.now() < until && !breached;) {
      button = await googleButton(page);
      if (!button) await page.waitForTimeout(300).catch(() => {});
    }
    if (breached) return end("google_property");
    if (!button) return end("no_google_button");

    // The one narrow exception, armed for this press only.
    armIdp(c, GOOGLE, { onGoogle });
    const popupP = page.waitForEvent("popup", { timeout: 4_000 }).catch(() => null);
    await button.click({ timeout: 5_000 }).catch(() => {});
    const popup = await popupP;
    let gp = popup ?? page;
    // Only the one popup that press opened, and only to Google or back to the site.
    const until = Date.now() + stepMs;
    while (Date.now() < until && !breached) {
      const o = originOf(gp.url());
      if (o === GOOGLE || (registrableOf(hostOf(gp.url())) === base && gp !== page)) break;
      if (gp === page && o === GOOGLE) break;
      if (popup && popup.isClosed()) { gp = page; break; }
      await page.waitForTimeout(250).catch(() => {});
    }
    if (breached) return end("google_property");
    // The press must lead to Google's own page, exactly https://accounts.google.com. A look-alike (another
    // site's, or one under the site's own domain such as accounts.google.com.<site>) is not Google:
    // nothing is typed and the sign-in is not counted, whatever the page shows next.
    if (originOf(gp.url()) !== GOOGLE) return end("origin_mismatch");

    // The credential steps, typed by the filler (exact origin, own frame, one real password box).
    const drive = async () => {
      const deadline = Date.now() + stepMs * 4;
      let credsDone = false;
      while (Date.now() < deadline) {
        if (breached) return { end: "google_property" };
        if (gp.isClosed() || originOf(gp.url()) !== GOOGLE) return { back: true };
        const r = await readGoogle(gp);
        const step = googleStep(r);
        if (["email", "password", "chooser"].includes(step.kind) && !credsDone) {
          credsDone = true;
          const out = await credentials(gp, g, { step: step.kind, read: r, diag, typing: () => { typed = true; } });
          if (out === "drift") return { end: "origin_mismatch" };
          await gp.waitForTimeout(400).catch(() => {});
          continue;
        }
        if (["blocked", "wrong_password", "not_accepted", "consent", "code", "tap"].includes(step.kind)) return { step, read: r };
        await gp.waitForTimeout(300).catch(() => {});
      }
      return { end: "no_answer" };
    };

    // After Google's own check: the consent (basic only), then back on the named site.
    const finishUp = async () => {
      const deadline = Date.now() + stepMs * 2;
      while (Date.now() < deadline) {
        if (breached) return end("google_property");
        if (gp.isClosed() || originOf(gp.url()) !== GOOGLE) break;
        const r = await readGoogle(gp);
        const step = googleStep(r);
        if (step.kind === "consent") {
          const ok = basicConsent(r);
          if (!ok.ok) return end("consent_more", { more: ok.more });
          const go = gp.getByRole("button", { name: /^\s*(continue|allow)\s*$/i }).first();
          if (originOf(gp.url()) !== GOOGLE) return end("origin_mismatch");
          await go.click({ timeout: 5_000 }).catch(() => {});
          await gp.waitForTimeout(500).catch(() => {});
          continue;
        }
        if (step.kind === "blocked") return end("blocked", { which: step.which });
        if (step.kind === "wrong_password") return end("wrong_password");
        if (step.kind === "not_accepted") return end("not_accepted", { msg: step.msg });
        await gp.waitForTimeout(300).catch(() => {});
      }
      disarmIdp(c);
      // Back on the named site (its own registrable domain): the tab that asked, once the popup is done.
      const there = popup && !popup.isClosed() ? popup : page;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
      if (breached) return end("google_property");
      if (registrableOf(hostOf(there.url())) !== base || registrableOf(hostOf(page.url())) !== base) return end("origin_mismatch");
      if (await googleButton(page)) return end("no_answer");
      watchGoogle(c, onGoogle); // for the rest of the job: any Google page ends it and signs out of Google
      return end("signed_in");
    };

    const first = await drive();
    if (first.end) return end(first.end);
    if (first.back) return await finishUp();
    const step = first.step;
    if (step.kind === "blocked") return end("blocked", { which: step.which });
    if (step.kind === "wrong_password") return end("wrong_password");
    if (step.kind === "not_accepted") return end("not_accepted", { msg: step.msg });
    if (step.kind === "consent") return await finishUp();

    // Google's own check, relayed once; the wait runs in the background and holds the restart gate.
    const entry = { site: "google.com", label: host, signin_url: GOOGLE };
    handedOff = true;
    restartGate.hold(`${gateId}:wait`, { kind: "saved_login_code" });
    restartGate.release(gateId);
    // Google asked about the account: it let the browser in, so the refusal record clears.
    try { clearRefusal("google.com", now()); } catch { /* best effort */ }
    const asked = step.kind === "tap" ? say("needs_google_tap", host, step) : say("needs_google_code", host, step);
    recordLoginEvent(c, { site: host, event: "signin", outcome: step.kind === "tap" ? "needs_google_tap" : "needs_google_code", purpose: why });
    const done = (async () => {
      let out;
      try {
        if (step.kind === "tap") {
          const until2 = Date.now() + tapWaitMs;
          let moved = false;
          while (Date.now() < until2 && !breached) {
            if (gp.isClosed() || originOf(gp.url()) !== GOOGLE) { moved = true; break; }
            const k = googleStep(await readGoogle(gp)).kind;
            if (k !== "tap") { moved = true; break; }
            await gp.waitForTimeout(1_000).catch(() => {});
          }
          out = moved ? await finishUp() : end("no_answer");
        } else {
          const code = await awaitReply(c, entry, ...(waitMs != null ? [{ waitMs }] : []));
          if (!code) out = end("code_not_found");
          else if (originOf(gp.url()) !== GOOGLE) out = end("origin_mismatch");
          else {
            const box = gp.locator('input[autocomplete="one-time-code"]:visible, input[type="tel"]:visible, input[name*="pin" i]:visible, input[id*="pin" i]:visible, input[name*="code" i]:visible').first();
            // Held to exactly accounts.google.com while the code is typed (no page of another origin loads in between).
            pinExact(c, GOOGLE);
            try {
              if (originOf(gp.url()) === GOOGLE) await box.fill(String(code), { timeout: 5_000 }).catch(() => {});
            } finally { pinExact(c, null); }
            await box.press("Enter").catch(() => {});
            await gp.waitForTimeout(800).catch(() => {});
            const k = gp.isClosed() || originOf(gp.url()) !== GOOGLE ? "back" : googleStep(await readGoogle(gp)).kind;
            out = k === "code" ? end("wrong_code") : await finishUp();
          }
        }
      } catch { out = end("not_signin_page"); }
      finally {
        disarmIdp(c);
        await signOutOfGoogle(session?.context);
        await session?.close?.();
        releaseProfile(c, holder);
        restartGate.release(`${gateId}:wait`);
      }
      try { note(c, `[saved-login sign-in to ${host} with Google ended: ${out.result}] ${out.say_exactly}`); } catch { /* best effort */ }
      return out;
    })();
    return { ...asked, ok: false, done };
  } catch {
    try { return end("not_signin_page"); } catch { return say("not_signin_page", host); }
  } finally {
    if (!handedOff) {
      disarmIdp(c);
      await signOutOfGoogle(session?.context);
      await session?.close?.();
      releaseProfile(c, holder);
      restartGate.release(gateId);
    }
  }
}

export const _test = { GOOGLE_JS, googleStep, basicConsent, GOOGLE_BUTTON, say };
