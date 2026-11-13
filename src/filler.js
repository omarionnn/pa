// The filler: Reason signs itself in with a saved login (design B5, B7; build brief
// docs/account-access-build/pr6.md). The one tool `account_signin { site }` ends here, and
// everything between the call and its one-word result is code: the pinned page, the exact origin,
// one KMS unwrap, typing, clean-up. The model never holds the login and cannot aim the filler at
// another site — it passes only a site name.
//
// This is the ONLY file that may import `withLogin` (test/savedlogins.test.js rule 2 checks it). The
// secret is unwrapped inside `withLogin`'s fill step, goes straight into the page's field and is
// zero-filled after; it never reaches the model, a tool result, a log, an error, a screenshot or the
// thread (the page-secret rules in src/pagesecrets.js read a filled box back as "filled", never its
// value). With REASON_SAVED_LOGINS off, savedLoginsAllowedFor is false and nothing here runs.
import { createHash } from "node:crypto";
import { clock } from "./config.js";
import * as db from "./db.js";
import {
  savedLoginsAllowedFor, peekForSignin, listLogins, setState, withLogin, recordLoginEvent, removeLogin, VaultError, signinRouteFor,
} from "./savedlogins.js";
import { namedByThem, namesOf } from "./namedsite.js";
import {
  launchProfile, guardContext, holdProfile, releaseProfile, closeBrowser as closeErrandBrowser,
  pinSite, pinExact, unpinSite,
} from "./browser.js";
import { dropIntake } from "./loginintake.js";
import { classifySite, refusalFor, registrableOf } from "./sitepolicy.js";
import { recordFinding } from "./sitefindings.js";
import { refusingSite, refusalAnswer, markRefusing } from "./refusing.js";
import { readPage, loginFormOf, waitFor, settleWatch, formWaitMs, signinDoor, followSigninDoor } from "./signinpage.js";
import { logAttempt, logDiag, safeMessage } from "./signinlog.js";
import { codeFromGmail, enterCode, awaitCodeReply } from "./signinemail.js";
import { clearOriginInPage } from "./signin.js";
import { askFaceId, takeApproval, dropAsks, takeResume, spendSaveGrants, faceIdState } from "./loginuse.js";
import { requestOf } from "./resume.js";
import * as federated from "./federated.js";
import { isGoogleProperty } from "./browser.js";
import * as restartGate from "./busy.js";

// The words the tool returns, one per outcome (design B5 step 8). `ok` is only a signed-in session.
export const SIGNIN_RESULTS = [
  "signed_in", "needs_code_sms", "needs_approval", "wrong_password", "blocked",
  "not_signin_page", "origin_mismatch", "paused", "needs_face_id", "no_login", "pick_one", "busy",
  "needs_code_email", "needs_authenticator", "code_not_found", "wrong_code", "not_named",
  "not_accepted", "no_answer", "waiting_face_id", "site_trouble", "refuses_software",
];
const OK_RESULT = new Set(["signed_in"]);
// The form was found visible a moment ago, so a box that is not fillable within this is not the form.
const FILL_MS = 5_000;
// After an attempt that typed the login and did not sign in (a code that failed or never came, an app
// approval, a page that broke after the submit), the login rests a day: a re-call by the model is
// `paused`, with no page load and no unwrap (hard rule 4, and the brief's one sign-in per site per day).
export const RETRY_PAUSE_MS = 24 * 60 * 60_000;
// A refusal by the site stops the attempt for the day: one wall, CAPTCHA, "suspicious sign-in" or
// "too many attempts" and the row is refused; the person is told and it is not retried (hard rule 4).
const REFUSED_BY_SITE = new Set(["blocked"]);
// The site answered with its own generic error ("Something went wrong. Please try again in a few
// minutes.") before it accepted or turned down the login. Not a wrong password, not a format problem:
// one automatic second go in the same job after SITE_TROUBLE_RETRY_MS, and if that gets the same, the
// login rests SITE_TROUBLE_PAUSE_MS (not a day). Never more than one automatic retry.
export const SITE_TROUBLE_RETRY_MS = 3 * 60_000;
export const SITE_TROUBLE_PAUSE_MS = 6 * 60 * 60_000;

/** The exact origin and path a browser reports, or "" (scheme://host[:port], then the path). */
function urlParts(u) {
  try { const x = new URL(String(u)); return { origin: x.origin, path: x.pathname }; }
  catch { return { origin: "", path: "" }; }
}

/** A site name to a bare host, or "" — the model passes a domain, never a URL with a path. */
function normSite(site) {
  const h = String(site ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  return /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(h) ? h : "";
}

/** One result object, with the fixed word and a plain sentence; never page text or a query string. */
function say(result, site, extra = "", { msgClass = "", msg = "", retrying = false, codeInstead = "" } = {}) {
  const quoted = msg ? ` (it said: "${safeMessage(msg)}")` : "";
  // The site's own error before it accepted or turned down the login: the saved login is not the problem.
  const siteTrouble = retrying
    ? `${site} answered with its own error before it accepted or turned down your login${quoted}. That isn't a wrong password, and as far as I can tell your saved login is fine and doesn't need saving again. I'll try once more by myself in a few minutes.`
    : `I couldn't sign you in to ${site}: it answered with its own error again before it accepted or turned down your login${quoted}. That isn't a wrong password, and as far as I can tell your saved login is fine and doesn't need saving again. I've stopped and won't try ${site} again for 6 hours.`;
  const notAccepted = msgClass === "account_not_found"
    ? `I couldn't sign you in to ${site}: it said it couldn't find an account for the saved email or number${quoted}. I've stopped and won't try ${site} again until tomorrow. If that isn't the email or number you use there, the login needs saving again with the right one.`
    : msgClass === "validation"
      ? `I couldn't sign you in to ${site}: it said the saved email, number or password isn't in the form it expects${quoted}. I've stopped and won't try ${site} again until tomorrow; the saved login probably needs saving again.`
      : msgClass === "rate_limited"
        ? `I couldn't sign you in to ${site}: it said there have been too many sign-in tries${quoted}. I've stopped and won't try ${site} again until tomorrow.`
        : `I couldn't sign you in to ${site}: it didn't accept the sign-in${quoted}. I've stopped and won't try ${site} again until tomorrow.`;
  const lines = {
    not_accepted: notAccepted,
    site_trouble: siteTrouble,
    no_answer: `I typed your saved login into ${site} and submitted it, but the page didn't show whether it worked before I gave up waiting, so I stopped. I won't try ${site} again until tomorrow.`,
    signed_in: `Signed you in to ${site}.`,
    needs_code_sms: `${site} texted a code to your phone to finish signing in. Send me that code and I'll type it in, once.`,
    needs_code_email: `${site} emailed a code to finish signing in, and I couldn't read it from your email. Send me that code and I'll type it in, once.`,
    needs_authenticator: `${site} wants a code from an authenticator app. I can't do that yet, so I stopped. You can sign in to ${site} yourself.`,
    code_not_found: `${site} emailed a code, but it didn't arrive in time. I stopped and didn't guess.`,
    wrong_code: `${site} didn't accept the code. I stopped and didn't try another.`,
    needs_approval: `I signed in to ${site}; it wants you to approve the sign-in in an app.`,
    wrong_password: `I couldn't sign you in to ${site}: the saved password wasn't accepted. I've stopped and won't try again until you save it again.`,
    blocked: `${site} blocked the sign-in. That's their choice, not something you did. I stopped and did not retry.`,
    // A wall before anything was typed (result "blocked"): said as it is, and no offer to try again.
    walled: `${site} turned my browser away before its sign-in form showed, so I typed nothing and stopped. That's their choice, not something you did.`,
    not_signin_page: `I couldn't sign you in to ${site}: its sign-in page didn't show the sign-in form I expected (it may have changed, or not loaded in time), so I typed nothing. If it keeps happening, the saved login may need saving again.`,
    // The saved page itself has no sign-in form (a login saved before 2026-11-13 could be pinned to a
    // site's home page). Never re-pinned silently: the person forgets it and saves it again, and the
    // new save link pins the page Reason's own visit finds the form on.
    needs_resave: `I couldn't sign you in to ${site}: the page your saved login points to has no sign-in form, so I typed nothing. It needs saving again on ${site}'s real sign-in page: tell me to forget it and I'll send you a new link to save it there.`,
    origin_mismatch: `I couldn't sign you in to ${site}: the page wasn't on its exact sign-in address, so I typed nothing.`,
    paused: `${site} is paused after an earlier refusal, so I didn't try again.`,
    needs_face_id: `${site} needs your Face ID approval for each sign-in. Approve it here, then tell me to go ahead:`,
    no_login: `You don't have a saved login for ${site}.`,
    pick_one: `You have more than one saved login for ${site}. Tell me which one and I'll use it.`,
    busy: `I'm already using the browser for you right now. I'll sign in to ${site} once that's done.`,
    // The site sent a code INSTEAD of asking for the password (a browser it hasn't seen): relayed once,
    // through the texted-code intake; the code goes into the site's box only, never the thread.
    ...(codeInstead ? { [result]: `${site} ${codeInstead === "email" ? "emailed" : "texted"} you a sign-in code instead of asking for the password. Text me that code and I'll type it into ${site}, once.` } : {}),
  };
  const words = lines[result] ?? `I couldn't sign you in to ${site}.`;
  // `extra` is only ever a link Reason made (the Face ID page), never page text.
  return { ok: OK_RESULT.has(result), result, say_exactly: extra ? `${words}\n${extra}` : words };
}

// ---------------------------------------------------------------- the live-ask gate (hard rule 8)
// A standing permission is used only for something the person asked for in this turn, or a standing
// job they approved. In the code a turn carries `kind`: a person's own inbound message is "user"
// (src/runtime.js inbound); an email, a page, a timer or the nightly review is "event"
// (Runtime.event). There is no finer "a card they tapped" marker on the turn today, so the simplest
// verifiable rule is used and flagged in the PR: a standing login needs this turn's kind to be
// "user". Anything else (every event turn) does not get a standing sign-in and is told to ask.
export function liveAskOk(trigger) {
  return trigger?.kind === "user";
}

/** Launch the person's own saved profile for the sealed step, headless and guarded. Injectable for tests. */
async function realLaunch({ conversationId }) {
  const { chromium } = await import("playwright");
  // The same launch as every flow: the real browser for a person it is on for, else today's (src/browser.js).
  const context = await launchProfile(chromium, conversationId, { headless: true, viewport: { width: 1280, height: 900 } });
  return {
    context,
    close: async () => { await context.close().catch(() => {}); },
  };
}

// Words a page shows when a password was wrong, when it wants a texted code, when it wants an app tap,
// and when it is a wall. Read off the page's own text; never used to carry a value back.
const WRONG_PW = /\b(incorrect|wrong|invalid|not match|didn'?t match|not recognize|try again)\b[^.]{0,40}\bpassword\b|\bpassword\b[^.]{0,40}\b(incorrect|wrong|invalid|not match|didn'?t match|not recognize|is not correct)\b|your (sign.?in|account|email or password) (details|information)? ?(was|were|is|are) (incorrect|wrong|not recognized)/i;
const PUSH = /approve (this|the) (sign.?in|request)|check your (phone|app|device)|we sent a (notification|request|prompt)|tap (yes|approve)|open your authenticator app and approve/i;
const AUTHENTICATOR = /authenticator|authentication app|verification app|code (from|in) your app|google auth|\bauthy\b|\btotp\b/i;
const EMAILED = /\b(e-?mail(ed)?|inbox)\b/i;
// A page saying it sent a sign-in code (not a link) after the email step: "We sent a sign-in code to
// you@…", "Enter the code we sent to your email", "Check your inbox for a code".
const SENT_CODE = /\b(we(?:'?ve| have)?|we just) (just )?(sent|emailed|texted) (you |a |an |the |your )*((sign.?in|verification|one.?time|security|login|\d.?digit) )?code\b|enter the (\d.?digit )?code (we|that we) (just )?(sent|emailed|texted)|check your (email|inbox|messages|phone) for (a|the|your) (\d.?digit )?code/i;
const TEXTED = /\b(text(ed)?|sms|phone|mobile number)\b/i;
const SUSPICIOUS = /suspicious|unusual (activity|sign.?in)|unrecognized|we don'?t recognize|verify it'?s you because|protect your account|something (looks|seems) off/i;

/**
 * Read the page after the secret was typed and submitted, and name what happened. Pure-ish: it only
 * reads the page (never types), and returns one of the result words. `readSignedInState` (src/sites.js,
 * PR #525) is the right positive-evidence check for a real session and is wired in PR 8; here a
 * fixture-grade read is used — no password box left, no challenge, no code step — and that is flagged.
 */
// A message about the form's shape, not about whether the login is right ("Please enter a valid email or
// phone number", "Your password must contain between 4 and 60 characters"): never a wrong password.
const VALIDATION = /please enter (a |your )?valid|enter a valid|must (contain|be|have) (between|at least|at most|from)|\bis required\b|required field|too (short|long)\b|can'?t be (blank|empty)/i;
const NOT_FOUND = /can'?t find (an|that|this|your) account|couldn'?t find (an|that|this|your) account|no account (with|for|found)|account (doesn'?t|does not) exist|isn'?t (linked to|connected to) an account|not (registered|recognized) (as|with) an account/i;
const RATE = /too many (attempts|tries|sign.?in|requests)|try again later|temporarily (locked|blocked|unavailable)/i;
const TOO_MANY = /too many (attempts|tries|sign.?in|requests)|temporarily (locked|blocked)/i;
// The site's own generic trouble, about nothing that was typed: "Something went wrong. Please try again
// in a few minutes.", "We're having trouble", "An unexpected error occurred", "temporarily unavailable".
const SITE_TROUBLE = /something (went|has gone) wrong|something'?s gone wrong|try again (later|shortly|soon|in a (few|couple( of)?) (minutes?|moments?)|in a (minute|moment|bit|little while|while))|we'?re having (some )?trouble|having (some )?technical (trouble|difficulties|issues|problems)|unexpected error|(an|unknown) error (has )?occurred|temporarily unavailable|service (is )?unavailable/i;

/** Which kind of message the page showed, from the page's own words ("" when none of the known ones). */
export function messageClass(msg) {
  const m = String(msg ?? "");
  if (!m.trim()) return "";
  // Generic site trouble first, unless the same words also name the password, the account or too many
  // tries: "validation" is only ever a message about the format of what was typed.
  if (SITE_TROUBLE.test(m) && !WRONG_PW.test(m) && !NOT_FOUND.test(m) && !TOO_MANY.test(m)) return "site_trouble";
  if (VALIDATION.test(m)) return "validation";
  if (WRONG_PW.test(m)) return "wrong_password";
  if (NOT_FOUND.test(m)) return "account_not_found";
  if (RATE.test(m)) return "rate_limited";
  return "other";
}

/**
 * Runs in the page's own frame: the visible text of anything the page marks as a message (an alert, a
 * live region, an element whose class, id or test id says error), joined. Read only to name the ending.
 */
const BANNER_JS = `(() => {
  var sel = '[role=alert],[aria-live=assertive],[aria-live=polite],[data-uia*=error i],[class*=error i],[id*=error i],[class*=alert i],[class*=message--error i]';
  var out = [], seen = 0;
  var els = document.querySelectorAll(sel);
  for (var i = 0; i < els.length && i < 60; i++) {
    var el = els[i], r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    var t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t && t.length < 400 && out.indexOf(t) < 0) { out.push(t); if (++seen >= 4) break; }
  }
  return out.join(' | ');
})()`;
const LINES_JS = `(() => String((document.body && document.body.innerText) || '').split(/\\n+/).map(function (s) { return s.replace(/\\s+/g, ' ').trim(); }).filter(Boolean).slice(0, 400))()`;
async function bannerOf(page) { try { return String(await page.evaluate(BANNER_JS) ?? ""); } catch { return ""; } }
async function linesOf(page) { try { const l = await page.evaluate(LINES_JS); return Array.isArray(l) ? l : []; } catch { return []; } }
/** The page's words that were not on it before the submit (and the banner, which is the page's own message). */
// `bannerBefore`: the page's own messages that were already showing before the submit (a standing
// notice in a live region): never this submit's answer, so they neither end the wait nor name the ending.
async function freshWords(page, before, bannerBefore = "") {
  const had0 = new Set(String(bannerBefore || "").split(" | ").filter(Boolean));
  const banner = (await bannerOf(page)).split(" | ").filter((p) => p && !had0.has(p)).join(" | ");
  if (!before) return { banner, fresh: "" };
  const had = new Set(before);
  const fresh = (await linesOf(page)).filter(l => !had.has(l)).join(" ").slice(0, 1_000);
  return { banner, fresh };
}

/**
 * Read the page after the secret was typed and submitted, and name what happened. It only reads the
 * page (never types). `ctx.before` is the page's lines just before the submit: a message is the words
 * that are NEW since then (or the page's own alert), so help text that was always there ("Forgot your
 * password?") is never read as a verdict. "wrong_password" only when the page's message says so about
 * the password or the credentials; a box still showing with another message is "not_accepted", and
 * with no message at all "no_answer" (2026-11-13: a Netflix attempt was called a wrong password 400 ms
 * after the submit, before the page answered). The message class and words go on `ctx` for the line
 * and the fixed words; the result word is what is returned.
 */
async function classifyAfterSubmit(page, ctx = {}) {
  let read;
  try { read = await readPage(page); } catch { return "not_signin_page"; }
  const challenge = await challengeShown(page);
  ctx.challenge = challenge;
  if (challenge) return "blocked";
  const text = String(read?.raw?.text ?? "");
  const boxes = Array.isArray(read?.raw?.fields) ? read.raw.fields : [];
  const kinds = boxes.map(f => kindOf(f));
  const hasPassword = kinds.includes("password");
  const hasOtp = kinds.includes("otp");
  const { banner, fresh } = await freshWords(page, ctx.before, ctx.bannerBefore);
  // Without a before-reading (a code step), the page's text is all there is.
  const msg = ctx.before ? [banner, fresh].filter(Boolean).join(" ") : banner;
  // The page's own message (its alert) names the ending when it says something known; the other new
  // words only when it does not (a field hint under a box is never louder than the page's alert).
  const bannerCls = messageClass(banner);
  const ownCls = bannerCls && bannerCls !== "other" ? bannerCls : "";
  const cls = ownCls || messageClass(msg) || (!ctx.before && hasPassword && WRONG_PW.test(text) ? "wrong_password" : "");
  ctx.msgClass = cls || "none";
  ctx.msg = cls ? (banner || fresh || "").slice(0, 200) : "";
  if (read.kind === "challenge" || SUSPICIOUS.test(msg) || (!ctx.before && SUSPICIOUS.test(text))) return "blocked";
  if (cls === "wrong_password" && hasPassword) return "wrong_password";
  if (PUSH.test(text)) return "needs_approval";
  if (hasOtp) return AUTHENTICATOR.test(text) ? "needs_authenticator" : EMAILED.test(text) ? "needs_code_email" : "needs_code_sms";
  if (cls === "wrong_password") return "wrong_password"; // the page said so, though it took the box away
  // The site's own generic error, box there or not: it neither accepted nor turned down the login.
  if (cls === "site_trouble") return "site_trouble";
  // No password box and no challenge: the form was accepted. A logout/account control is the
  // positive evidence a real session read uses; its absence on a fixture is still a signed-in page.
  if (!hasPassword && (!cls || cls === "other")) {
    // Signed in needs evidence: it left the sign-in page (the site's own next page), or the form went
    // with no message of the page's own. The form gone in place with a message the page marks as an
    // alert or error that none of the known words name: couldn't tell, never success.
    if (cls === "other" && banner && ctx.startUrl && urlParts(page.url()).path === urlParts(ctx.startUrl).path) return "no_answer";
    return "signed_in";
  }
  // Still on the password box with only new words the page did not mark as its message (a spinner, a
  // late footer): it never answered.
  if (cls === "other" && !banner) return "no_answer";
  // The page said something else (a validation line, no such account, too many tries): it didn't
  // accept the sign-in, and that is not a wrong password.
  if (cls) return "not_accepted";
  // Still on the password box and the page said nothing: it never answered. Not a wrong password.
  return "no_answer";
}

// The field's kind from what the site says about it (mirrors signinpage.fieldKind, kept local so the
// filler never asks the model what a box is). Only the kinds the fill step needs.
function kindOf(f = {}) {
  const hay = `${f.ac ?? ""} ${f.name ?? ""} ${f.id ?? ""} ${f.label ?? ""}`.toLowerCase();
  const type = String(f.type ?? "").toLowerCase();
  if (type === "password" || /password|passwd|\bpwd\b/.test(hay)) return "password";
  if (/one-time-code|onetime|\botp\b|verification code|security code|\bpasscode\b|sms code|email code|\bcode\b/.test(hay)) return "otp";
  if ((type === "tel" || type === "number" || f.im === "numeric") && f.ml > 0 && f.ml <= 8) return "otp";
  if (type === "email" || /\be-?mail\b/.test(hay)) return "email";
  if (/username|user ?name|\buserid\b|\buser id\b|\blogin\b|sign.?in/.test(hay)) return "username";
  return "text";
}

// The locator for the first visible username/email box and the password box, on the page's OWN frame
// (same origin). A password box inside another origin's frame is never reached, so a cross-origin
// frame reads as "no form" and nothing is typed (hard rule 1).
const USER_BOX = 'input[type="email"]:visible, input[autocomplete="username"]:visible, input[name*="user" i]:visible, input[name*="email" i]:visible, input[id*="user" i]:visible, input[id*="email" i]:visible, input[type="text"]:visible';
async function findForm(page) {
  const all = page.locator('input[type="password"]:visible');
  // Exactly one: two password boxes are making or changing one (src/signinpage.js loginFormOf).
  if ((await all.count()) !== 1) return { ok: false };
  const pass = all.first();
  const user = page.locator(USER_BOX).first();
  return { ok: true, user: (await user.count()) ? user : null, pass };
}

// An email-first page (src/signinpage.js loginFormOf "email_first"): its one visible username/email box,
// on the page's own frame. The password box comes after our own submit (fillAndSubmit).
async function findEmailFirst(page) {
  const user = page.locator(USER_BOX).first();
  return (await user.count()) ? { ok: true, emailFirst: true, user, pass: null } : { ok: false };
}

/**
 * The sealed step. Called inside withLogin with the fields as Secrets; it types them with
 * locator.fill (no simulated human typing, which Amazon's terms ban), re-checks the origin right
 * before the password keystroke, submits, waits, then empties the boxes it typed into. It reads the
 * page to name the outcome but never returns a secret. A redirect off the pinned origin mid-fill
 * throws, which withLogin turns into the fixed code fill_failed and the caller reads as origin_mismatch.
 */
async function fillAndSubmit(page, pinnedOrigin, form, { username, password }, { typing = () => {}, relax = () => {}, ours = () => true, atPin = () => true, stepMs = STEP_MS, answerMs = ANSWER_MS, diag = {}, toggled = () => {} } = {}) {
  const here = () => urlParts(page.url()).origin;
  // The safe line's two numbers per box: what the box holds after typing, what the saved field has.
  diag.boxes = [];
  const note = async (loc, b, kind) => { diag.boxes.push({ kind, typed: await lengthIn(loc), saved: b.toString("utf8").length }); };
  const userKind = async () => { try { return kindOf(await form.user.evaluate((el) => ({ type: el.type, name: el.name, id: el.id, ac: el.getAttribute("autocomplete") }))); } catch { return "text"; } };
  const ensure = () => { if (here() !== pinnedOrigin) { const e = new Error("origin drifted"); e.name = "OriginDrift"; throw e; } };
  if (form.emailFirst) {
    // The email-first rule (2026-11-13): type the username, submit it OURSELVES, and type the password
    // only into a real password box that then appears on the EXACT pinned origin (scheme, host, port as
    // strings). The path may change, and only by the page's answer to our own submit: any navigation
    // before that submit (`ours()` false) stops it. The exact-origin lock stays on the whole time, so
    // the browser itself refuses a step on any other origin, port or scheme.
    const notOurs = () => { if (!ours()) { const e = new Error("navigation we did not cause"); e.name = "OriginDrift"; throw e; } };
    ensure(); notOurs();
    typing();
    const uk = await userKind();
    await username.use(async (b) => { await form.user.fill(b.toString("utf8"), { timeout: FILL_MS }); await note(form.user, b, uk); diag.userMarks = marksOf(b); });
    // A moment for anything the typing set off to show itself, then the check: a page that moves on its
    // own once the username is in is not answering our submit, and gets no password.
    await page.waitForTimeout(OWN_STEP_MS).catch(() => {});
    ensure(); notOurs();
    const before = page.url();
    await form.user.press("Enter").catch(() => {});
    // The page's own "use password instead" is pressed only when there is a saved password to type.
    const canToggle = !!password?.live;
    let pass = await passwordStep(page, pinnedOrigin, 1_500, { toggled, canToggle });
    if (!pass && page.url() === before && !(await passwordToggle(page)) && !(await codeSentInstead(page))) {
      // Enter did nothing (a "Continue" button outside any form): press the page's own one, once. Never
      // one that sends a code or a link instead ("Send sign-in code").
      await page.locator('button[type="submit"]:visible, button:has-text("Continue"):visible, button:has-text("Next"):visible')
        .filter({ hasNotText: CODE_BUTTON }).first().click({ timeout: FILL_MS }).catch(() => {});
    }
    if (!pass) pass = await passwordStep(page, pinnedOrigin, stepMs, { toggled, canToggle });
    ensure();
    if (!pass) {
      const r = await readPage(page).catch(() => null);
      if (r?.kind === "challenge" || (await challengeShown(page))) return "blocked";
      // It sent a code instead of asking for the password, and offered no way to the password (or one
      // was pressed and no password box came): an honest code step, relayed once by the caller.
      const sent = await codeSentInstead(page);
      if (sent) { diag.codeInstead = sent; diag.msgClass = "none"; return sent === "email" ? "needs_code_email" : "needs_code_sms"; }
      return "not_signin_page";
    }
    form = { user: form.user, pass }; // the username box too, for the clean-up after the submit (a one-page step keeps it)
    ensure(); // immediately before the password keystroke
    await password.use(async (b) => { await form.pass.fill(b.toString("utf8"), { timeout: FILL_MS }); await note(form.pass, b, "password"); });
    ensure();
    relax();
    return await submitAndRead(page, form, { answerMs, diag });
  }
  // The browser is held to the exact pinned origin until both boxes are typed (the caller pinned it, and
  // the browser refuses every page load anywhere else), so the document the keystroke lands in is
  // this origin's: a script, a meta refresh or a redirect after this check cannot swap in another
  // origin's page under the locator (review 2026-11-13). The check below is the second line.
  // And the page is still the pinned PAGE (its path): a page that moved itself to another path of the
  // origin before anything was typed (a meta refresh, a script) gets nothing (ship review 2026-11-13).
  const onPinnedPage = () => { if (!atPin()) { const e = new Error("left the pinned page"); e.name = "OriginDrift"; throw e; } };
  ensure(); onPinnedPage();
  typing();
  if (form.user) { const uk = await userKind(); await username.use(async (b) => { await form.user.fill(b.toString("utf8"), { timeout: FILL_MS }); await note(form.user, b, uk); diag.userMarks = marksOf(b); }); }
  ensure(); onPinnedPage(); // immediately before the password keystroke (design B5 step 5)
  await password.use(async (b) => { await form.pass.fill(b.toString("utf8"), { timeout: FILL_MS }); await note(form.pass, b, "password"); });
  ensure();
  // Typed. The submit may go to another origin of the same site (a sign-in host posting to the account
  // host); the same-site lock still refuses any other site, and http under an https pin.
  relax();
  return await submitAndRead(page, form, { answerMs, diag });
}

/** How long an email-first page is given to show its password step after our own submit. */
const STEP_MS = 10_000;
/** How long after typing the username a navigation that was not ours is looked for, before our submit. */
const OWN_STEP_MS = 500;
/**
 * After our own email-step submit: the one real password box on the exact pinned origin, or null.
 * Real = the page's own frame, input[type=password], exactly one, not a "new-password" box (src/
 * signinpage.js loginFormOf says "password"). Any other origin ends the wait at once.
 */
/** The page sent a code instead of asking for the password: "email", "sms" or "" (read off its own words). */
async function codeSentInstead(page) {
  const words = (await linesOf(page)).join(" ");
  const m = SENT_CODE.exec(words);
  if (!m) return "";
  const near = words.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
  return EMAILED.test(near) || /@/.test(near) || !TEXTED.test(near) ? "email" : "sms";
}

async function passwordStep(page, pinnedOrigin, ms, { toggled = () => {}, canToggle = true } = {}) {
  const until = Date.now() + ms;
  let clicked = false;
  for (;;) {
    if (urlParts(page.url()).origin !== pinnedOrigin) return null;
    if (await challengeShown(page)) return null; // the caller reads it again and stops as "blocked"
    const r = await readPage(page).catch(() => null);
    const boxes = page.locator('input[type="password"]:visible');
    if (r && loginFormOf(r.raw) === "password" && (await boxes.count().catch(() => 0)) === 1) return boxes.first();
    // The step offers a code first, with the password behind the page's own "Use password instead": press it, once.
    if (canToggle && !clicked && (await boxes.count().catch(() => 0)) === 0) {
      const t = await passwordToggle(page);
      if (t) { clicked = true; toggled(); await t.click({ timeout: FILL_MS }).catch(() => {}); continue; }
    }
    // A code sent instead, with no way to the password left to press: the caller names it at once.
    if (!clicked && (await codeSentInstead(page))) return null;
    if (Date.now() >= until) return null;
    await page.waitForTimeout(250).catch(() => {});
  }
}

/**
 * The page's own "use password instead" control, when it offers a code (or a passkey) first and keeps the
 * password behind it: a visible button or link on the page's own frame whose whole text means "use a
 * password". A link to another origin is never it. "Forgot password?" and "Reset password" are not.
 */
const USE_PASSWORD = /^\s*(use|sign in with|log in with|continue with|enter|type) (a |the |your |my )?password( instead)?\s*[.!]?\s*$/i;
async function passwordToggle(page) {
  const c = page.locator('button:visible, a:visible, [role="button"]:visible, [role="link"]:visible').filter({ hasText: /password/i });
  const n = Math.min(await c.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) {
    const el = c.nth(i);
    const info = await el.evaluate((e) => ({ text: String(e.innerText || e.textContent || "").replace(/\s+/g, " ").trim(), href: e.tagName === "A" ? String(e.getAttribute("href") ?? "") : "" })).catch(() => null);
    if (!info || !USE_PASSWORD.test(info.text)) continue;
    if (info.href && !info.href.startsWith("#")) {
      try { if (new URL(info.href, page.url()).origin !== urlParts(page.url()).origin) continue; } catch { continue; }
    }
    return el;
  }
  return null;
}
export const _testWords = { messageClass, USE_PASSWORD };

/**
 * Runs in the page's own frame: is a human-check showing that wants a person (a visible reCAPTCHA
 * picture grid or tick box, an hCaptcha, a Turnstile, an Arkose puzzle)? An INVISIBLE check (reCAPTCHA's
 * size=invisible anchor, a zero-size frame, the hidden challenge frame parked off-screen) is not: it
 * runs by itself and the site decides. Read off the frames' addresses and boxes only; another
 * origin's frame is never read into, typed into or clicked.
 */
const CHALLENGE_FRAME_JS = `(() => {
  var W = window.innerWidth || 1, H = window.innerHeight || 1;
  var fs = document.querySelectorAll('iframe');
  for (var i = 0; i < fs.length && i < 200; i++) {
    var f = fs[i], src = String(f.src || ''), t = String(f.title || '');
    var r = f.getBoundingClientRect();
    if (r.width < 60 || r.height < 40 || r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) continue;
    var cs = window.getComputedStyle(f);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    if (/\\/recaptcha\\/(api2|enterprise)\\/bframe/i.test(src)) return true;
    if (/\\/recaptcha\\/(api2|enterprise)\\/anchor/i.test(src) && !/[?&]size=invisible/i.test(src)) return true;
    if (/hcaptcha\\.com/i.test(src) && !/[?&#]size=invisible/i.test(src)) return true;
    if (/challenges\\.cloudflare\\.com|arkoselabs\\.com|funcaptcha\\.com|geo\\.captcha-delivery\\.com/i.test(src)) return true;
    if (/recaptcha challenge|hcaptcha|verify you are human|security challenge|captcha/i.test(t) && !/[?&]size=invisible/i.test(src)) return true;
  }
  return false;
})()`;
async function challengeShown(page) {
  try { return (await page.evaluate(CHALLENGE_FRAME_JS)) === true; } catch { return false; }
}
export const _test = { CHALLENGE_FRAME_JS };
/** For tests: the Google step's typist (test/continue-with-google.test.js). */
export const _testGoogle = { googleCredentials: (c) => googleCredentials(c) };

/** A human-check page or a visible challenge frame, read now; never solved, never pressed. */
async function walledNow(page) {
  const r = await readPage(page).catch(() => null);
  return r?.kind === "challenge" || (await challengeShown(page));
}

/**
 * Read the page where it ended up (after ALL redirects), held against the pinned origin + path as
 * strings. On it, the pin is set (`pin`) and the page is given the normal wait to draw its sign-in
 * form; a challenge that is still there at the end of the wait is a wall. Nothing is typed here.
 *   → { verdict: "ok", form } | { verdict: "origin_mismatch" | "not_signin_page" | "wall" | "no_form" }
 */
async function arrive(page, row, { pin = () => {}, onToggle = () => {}, need = "form" } = {}) {
  const at = urlParts(page.url());
  if (at.origin !== row.signin_origin) return { verdict: "origin_mismatch" };
  if (at.path !== row.signin_path) return { verdict: "not_signin_page" };
  pin();
  // A form the page draws with its own script is waited for (bounded; a finished page that stays
  // formless ends the wait early). A wall is given the same wait to clear by itself.
  const watch = settleWatch(page);
  const got = await waitFor(page, async () => { const r = await readPage(page); return loginFormOf(r.raw) ? r : null; },
    { waitMs: formWaitMs(), stop: () => watch.settled() }).finally(() => watch.stop());
  const read = got.found ? got.value : await readPage(page).catch(() => null);
  if (read?.kind === "challenge" || (await challengeShown(page))) return { verdict: "wall" };
  // The Google route (src/federated.js) needs the page itself, not its password form: nothing is
  // pressed or typed here, its own Google button is looked for by the caller.
  if (need === "page") return { verdict: "ok", form: null };
  let form = await findForm(page);
  // The page offers a code first and keeps the password behind its own "Use password instead": press
  // it before anything is typed, so Enter in the email box never sends a code (2026-11-13).
  if (!form.ok) {
    const toggle = await passwordToggle(page);
    if (toggle) {
      await toggle.click({ timeout: FILL_MS }).catch(() => {});
      await page.locator('input[type="password"]:visible').first().waitFor({ timeout: 3_000 }).catch(() => {});
      onToggle();
      form = await findForm(page);
    }
  }
  if (!form.ok && loginFormOf(read?.raw) === "email_first") form = await findEmailFirst(page);
  return form.ok ? { verdict: "ok", form } : { verdict: "no_form" };
}

/**
 * The way a person reaches a sign-in page: the saved site's own home page, then its own Sign In link
 * or button (src/signinpage.js followSigninDoor, the finder the save-time look-up uses: same site
 * only, https only, provider buttons never). The caller holds the browser to the site (the lock) for
 * the walk and reads where it lands. Nothing is typed. A wall that does not clear by itself within the
 * normal wait ends it.
 *   → { how: "followed" | "walled" | "no_door" | "not_loaded" }
 */
async function frontDoor(page, row) {
  const entry = { site: row.site, label: row.site, signin_url: `https://${row.site}/` };
  try { await page.goto(entry.signin_url, { waitUntil: "domcontentloaded", timeout: 30_000 }); } catch { return { how: "not_loaded" }; }
  const watch = settleWatch(page);
  const seen = await waitFor(page, async () => ((await walledNow(page)) ? null : (await page.evaluate(signinDoor, "").catch(() => null))),
    { waitMs: formWaitMs(), stop: () => watch.settled() }).finally(() => watch.stop());
  if (!seen.found) return { how: (await walledNow(page)) ? "walled" : "no_door" };
  const went = await followSigninDoor(page, entry);
  if (!went.followed) return { how: "no_door" };
  // A pressed button navigates by itself, and a link's own redirects may still be running: the page is
  // given the normal wait to reach the pinned page; where it is after that is what the caller reads.
  // Without a pin (the Google route with no sign-in page known), the page it lands on is read by the
  // caller once the browser has moved off the home page, within the same wait.
  const home = page.url();
  await page.waitForURL((u) => {
    if (!row.signin_origin) return String(u) !== home;
    const p = urlParts(u); return p.origin === row.signin_origin && p.path === row.signin_path;
  }, { timeout: Math.max(1, formWaitMs()), waitUntil: "domcontentloaded" }).catch(() => {});
  return { how: "followed" };
}

/**
 * The filler's page-reaching step: the browser onto the pinned sign-in page with its form drawn, held to
 * the exact pinned origin (the lock) once it is there. Nothing is typed here; exported so a load-only
 * proof can run this step alone. `mark` is called whenever the navigations seen so far stop counting
 * against the page (the pin taken; our own click on a "use password" control).
 *   → { verdict: "ok", form, door } | { verdict: "origin_mismatch"|"not_signin_page"|"wall"|"no_form", door }
 *     door: "" (not walked) | "followed" | "walled" | "no_door" | "not_loaded"
 */
export async function reachPinned(page, row, { conversationId, mark = () => {}, need = "form" } = {}) {
  const c = String(conversationId ?? "");
  const pinnedHost = new URL(row.signin_origin).hostname;
  const secure = row.signin_origin.startsWith("https:");
  const hold = () => { pinSite(c, row.site, { hosts: [pinnedHost], exact: row.signin_origin, secure }); mark(); };
  // Code goes to the pinned page itself, in its own tab; never a page the model was on, never a
  // link from a page or an email (design B5 step 3).
  const direct = async () => {
    await page.goto(`${row.signin_origin}${row.signin_path}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    return arrive(page, row, { pin: hold, onToggle: mark, need });
  };
  // The front door (2026-11-13, DoorDash): a pinned page may only work when it is reached the way a
  // person reaches it, from the site's own home page through its own Sign In link, which carries the
  // page's per-visit address parts (an identity page's client and return address; the pin keeps none
  // of them). The walk is held to the site by the lock; the page it lands on must be the pinned
  // origin + path exactly (its query may differ), or nothing is typed there.
  //   → null when the walk did not land on the pinned page (the caller's other way stands)
  const walk = async () => {
    unpinSite(c);
    pinSite(c, row.site, { hosts: [pinnedHost], secure });
    const w = await frontDoor(page, row);
    door = w.how;
    if (w.how === "walled") return { verdict: "wall" };
    if (w.how !== "followed") return null;
    const got = await arrive(page, row, { pin: hold, onToggle: mark, need });
    // The pinned page reached through the site stands, form or wall; landing anywhere else does not.
    return got.verdict === "ok" || got.verdict === "wall" || got.verdict === "no_form" ? got : null;
  };
  let door = "";
  let got;
  if (row.signin_path !== "/" && ownHost(row)) {
    // A sign-in page on a host of its own (identity.example.com, login.example.com) is an identity
    // server's page: opened bare it has no client and return address and cannot draw the form, and on
    // DoorDash the bare load also spoiled the visit (the site's own link after it was walled, where the
    // same link in a fresh visit drew the form). So the front door first, the bare page only if the
    // walk did not land on it. A wall on the walk stops it: no second way round a wall.
    got = (await walk()) ?? (unpinSite(c), await direct());
  } else {
    // A sign-in page on the site's own host (www.netflix.com/login): opened directly, as before. When it
    // shows no form (sent elsewhere, formless) the front door is walked once; never a loop. A wall on the
    // direct load stops it (review 2026-11-13): the site has turned the browser away, and walking round
    // by another way would be a second try against a wall.
    got = await direct();
    if (got.verdict !== "ok" && got.verdict !== "wall" && row.signin_path !== "/") got = (await walk()) ?? got;
  }
  if (got.verdict !== "ok") unpinSite(c);
  return { ...got, door };
}

/**
 * The Google route's way to a site's sign-in page when none is pinned (src/federated.js): the site's own
 * home page, then its own Sign In link, the way the save flow finds one. The caller holds the browser to
 * the site and reads where it lands. Nothing is pressed but that link; nothing is typed.
 *   → { how: "followed" | "walled" | "no_door" | "not_loaded" }
 */
export async function frontDoorOf(page, site) {
  return frontDoor(page, { site: String(site ?? ""), signin_origin: null, signin_path: null });
}

/** Is the pinned page on a host of its own, not the site's front host (the site itself or www.)? */
function ownHost(row) {
  const h = new URL(row.signin_origin).hostname.toLowerCase().replace(/^www\./, "");
  return h !== String(row.site ?? "").toLowerCase().replace(/^www\./, "");
}

/** How long the page is given to answer the submit: a script-driven form (Netflix) answers by XHR, not a page load. */
const ANSWER_MS = 12_000;
/** A control that sends a code or a link instead of signing in with the password: never pressed. */
const CODE_BUTTON = /\b(code|link|text me|email me|send|magic)\b/i;

/**
 * One-way marks of the username and its parts (3+ letters or digits), held in memory for this attempt
 * only, never logged: a page message word whose mark matches is the username echoed back and is dropped.
 */
function marksOf(buf) {
  const s = buf.toString("utf8").toLowerCase();
  const parts = [s, ...s.split(/[^a-z0-9]+/)].filter((p) => p.length >= 3);
  return new Set(parts.map((p) => createHash("sha256").update(p).digest("hex")));
}
export function dropMarked(msg, marks) {
  const m = String(msg ?? "");
  if (!m || !marks?.size) return m;
  return m.split(/(\s+)/).map((w) => {
    const bare = w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    const hit = bare.length >= 3 && (marks.has(createHash("sha256").update(bare).digest("hex"))
      || bare.split(/[^a-z0-9]+/).some((p) => p.length >= 3 && marks.has(createHash("sha256").update(p).digest("hex"))));
    return hit ? "…" : w;
  }).join("");
}

/** How many characters a box holds now: a number only, read in the page; never the value. */
async function lengthIn(loc) {
  try { return Number(await loc.evaluate((el) => String(el.value ?? "").length)); } catch { return null; }
}

/**
 * After the submit: wait for the page's answer, bounded. An answer is the address changing, the
 * password box going away (and staying away), a code box, a human-check, or a message the page shows
 * that wasn't there before the submit (its alert, or words naming the ending). Words that are none of
 * those (a cookie banner, a spinner) don't end the wait.
 */
async function awaitAnswer(page, form, before, ms, bannerBefore = "") {
  const startUrl = page.url();
  const until = Date.now() + ms;
  let goneSince = 0;
  for (;;) {
    await page.waitForTimeout(250).catch(() => {});
    if (page.isClosed()) return;
    if (page.url() !== startUrl) { await page.waitForLoadState("domcontentloaded").catch(() => {}); await page.waitForTimeout(300).catch(() => {}); return; }
    if (await challengeShown(page)) return;
    const showing = await form.pass.isVisible().catch(() => false);
    if (!showing) { goneSince ||= Date.now(); if (Date.now() - goneSince >= 1_000) return; } else goneSince = 0;
    const { banner, fresh } = await freshWords(page, before, bannerBefore);
    const words = `${banner} ${fresh}`;
    if (messageClass(words) && messageClass(words) !== "other") return;
    if (banner && messageClass(banner)) return;
    if (PUSH.test(fresh) || SUSPICIOUS.test(fresh)) return;
    if (await page.locator('input[autocomplete="one-time-code"]:visible').count().catch(() => 0)) return;
    if (Date.now() >= until) return;
  }
}

async function submitAndRead(page, form, { answerMs = ANSWER_MS, diag = {} } = {}) {
  // "Remember this device" when the page offers it (design B5 step 5), so the next job need not sign in.
  const remember = page.locator('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i], input[type="checkbox"][name*="trust" i]').first();
  if (await remember.count().catch(() => 0)) await remember.check().catch(() => {});
  const before = await linesOf(page);
  const bannerBefore = await bannerOf(page);
  const startUrl = page.url();
  const startedAt = Date.now();
  diag.pressed = "enter";
  await form.pass.press("Enter").catch(async () => {
    diag.pressed = "submit_button";
    await page.locator('button[type="submit"]:visible, button:has-text("Sign in"):visible, button:has-text("Log in"):visible, button:has-text("Continue"):visible')
      .filter({ hasNotText: CODE_BUTTON }).first().click({ timeout: FILL_MS }).catch(() => { diag.pressed = "none"; });
  });
  await awaitAnswer(page, form, before, answerMs, bannerBefore);
  diag.waitedMs = Date.now() - startedAt;
  // The page's answer is read BEFORE the clean-up: emptying a box makes a page show its own hint under
  // it ("Please enter a valid email or mobile number."), which is not the site's answer to the login
  // (2026-11-13: Netflix's "Something went wrong" was reported as a format problem that way).
  const ctx = { before, bannerBefore, startUrl };
  const result = await classifyAfterSubmit(page, ctx);
  // Clean up before anyone looks: empty any box the filler typed into that is still on the page
  // (design B5 step 7). Reading the answer above only reads words; no picture is taken before this.
  // After a submit the page has usually navigated and the box is gone; a short timeout keeps that
  // ordinary case from blocking on the default wait.
  for (const loc of [form.user, form.pass]) {
    if (loc) await loc.fill("", { timeout: 800 }).catch(() => {});
  }
  // A page that echoes the username back ("No account for jsmith"): its words go, before the quote or the line.
  const msg = dropMarked(ctx.msg, diag.userMarks);
  delete diag.userMarks;
  Object.assign(diag, { msgClass: ctx.msgClass, msg, challenge: ctx.challenge === true, finalUrl: page.url() });
  return result;
}


// What a sign-in result does to the row, the attempt log and the person's activity line, once it is
// final (hard rules 4 and 5). A success flips unverified -> working; a wall refuses the site; a wrong
// password stops it until they save again; a code that failed or never came stops this attempt only.
function finish(c, row, host, pinned, result, { why = "", again = false, startedAt = null, typed = false, at = null } = {}) {
  if (result === "signed_in") setState(c, row.id, { state: "working", failCount: 0, clearNextTry: true });
  else if (result === "wrong_password") setState(c, row.id, { state: "wrong_password", bumpFail: true });
  else if (REFUSED_BY_SITE.has(result)) {
    recordFinding({ site: host, label: host, signin_url: pinned }, { kind: "walled", why: "a wall after the password" });
    setState(c, row.id, { state: "refused" });
  } else if (typed) setState(c, row.id, { nextTryAt: (at ?? clock.now()) + (result === "site_trouble" ? SITE_TROUBLE_PAUSE_MS : RETRY_PAUSE_MS) });
  if (result !== "signed_in") unpinSite(c);
  const outcome = result === "signed_in" ? "signed_in" : result === "blocked" ? "blocked_by_site"
    : result === "wrong_code" ? "wrong_code" : result === "code_not_found" ? "code_not_found" : "failed";
  logAttempt({ signin_url: pinned }, { route: again ? "saved_login_again" : "saved_login", outcome, startedAt, detail: outcome === "failed" ? result : "" });
  recordLoginEvent(c, { site: host, event: "signin", outcome: result, purpose: why });
}

/** Type one code into the site's own code box, once, and read what happened. Never a second try. */
async function typeCodeOnce(page, pinnedOrigin, code, enter) {
  if (urlParts(page.url()).origin !== pinnedOrigin) return "origin_mismatch";
  const out = await enter(page, code).catch(() => ({ ok: false }));
  if (!out?.ok) return "not_signin_page";
  if (out.wrong) return "wrong_code";
  const after = await classifyAfterSubmit(page);
  return after.startsWith("needs_code") ? "wrong_code" : after;
}

const defaultNote = (c, text) => db.createTimer(c, { fireAt: clock.now(), note: text });

/**
 * Sign in to `site` with the person's saved login. Returns { ok, result, say_exactly }. `trigger`
 * carries how this turn started (hard rule 8). Injectable for tests: `launch`, `now`, `emailCode`
 * (the emailed-code reader, src/signinemail.js codeFromGmail), `enter` (types a code), `awaitReply`
 * (their texted reply, taken at intake), `note` (how the end of a background wait is told), `waitMs`.
 */
let signIns = 0;
export async function signIn(conversationId, site, {
  trigger = null, purpose = "", launch = realLaunch, now = () => clock.now(),
  emailCode = codeFromGmail, enter = enterCode, awaitReply = awaitCodeReply, note = defaultNote, waitMs = undefined,
  answerMs = ANSWER_MS, locate = undefined, tapWaitMs = undefined, stepMs = undefined, retryWaitMs = SITE_TROUBLE_RETRY_MS,
} = {}) {
  const c = String(conversationId ?? "");
  const host = normSite(site);
  // Rule 9: with the switch off (or no KMS) nothing is reachable and nothing is typed.
  if (!savedLoginsAllowedFor(c) || !host) return say("no_login", host || "that site");
  const why = String(purpose ?? "");

  // Hard rule 3: the never list refuses with the fixed words and nothing is even opened.
  const verdict = classifySite(host) ?? {};
  if (verdict.policy === "never") {
    recordLoginEvent(c, { site: host, event: "refused_never_list", outcome: "stopped" });
    return { ok: false, result: "blocked", say_exactly: refusalFor(verdict.category, host), refused: true };
  }
  // A site that turns away software-driven browsers (src/refusing.js): said up front, before any row
  // is read, any Face ID ask or any page opened. The saved login is left exactly as it is.
  const turnsAway = refusingSite(host);
  if (turnsAway) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "refuses_software", purpose: why });
    return refusalAnswer(turnsAway, { words: why });
  }

  // The saved Google login is never used to sign in to Google itself (Gmail, Drive, settings, or
  // accounts.google.com on its own): only as the Continue-with-Google step of a site they named.
  if (isGoogleProperty(host)) {
    recordLoginEvent(c, { site: registrableOf(host), event: "refused_never_list", outcome: "stopped" });
    return { ok: false, result: "blocked", say_exactly: refusalFor("google_property"), refused: true };
  }
  const rows = peekForSignin(c, host);
  // A site they sign in to with Google (src/savedlogins.js signin_routes): the federated route.
  if (!rows.length && signinRouteFor(c, host) === "google") {
    return federated.signInWithGoogle(c, host, { trigger, purpose, launch, now, awaitReply, note, waitMs, credentials: googleCredentials(c),
      ...(locate ? { locate } : {}), ...(tapWaitMs != null ? { tapWaitMs } : {}), ...(stepMs != null ? { stepMs } : {}), liveAskOk });
  }
  if (!rows.length) return say("no_login", host);
  if (rows.length > 1) return say("pick_one", host);
  const row = rows[0];

  // Hard rule 4: one refusal stops. A refused/paused row, or one still inside next_try_at, is not tried.
  if (["refused", "paused", "needs_person"].includes(row.state) || (row.next_try_at && now() < row.next_try_at)) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "paused", purpose: why });
    return say("paused", host);
  }
  if (row.state === "wrong_password") {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "wrong_password", purpose: why });
    return say("wrong_password", host);
  }

  // Hard rule 8, the conservative reading: a saved login is used only on a turn the person started
  // with their own message (a tapped Action Card arrives as one: the tap types its prefill and they
  // send it). Every event turn (an email, a page, a timer, the nightly review) is refused.
  // A job carried on by itself (src/resume.js): the event turn a Face ID yes or a save started holds a
  // grant code issued for that one approval or save, this login and site and their own request. Only
  // the runtime puts it on a turn; a page, an email or the model can't. Anything else is refused below.
  const resumed = !liveAskOk(trigger) && trigger?.resume ? takeResume(c, trigger.resume, { loginId: row.id, site: host, savedSite: row.site }, { now: now() }) : null;
  if (!liveAskOk(trigger) && !resumed) {
    if (trigger?.resume) return { ok: false, result: "resume_spent", say_exactly: "" };
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    return { ...say("needs_face_id", host), say_exactly: `I only sign in to ${host} when you ask me in the moment. Ask me and I'll do it.` };
  }
  // The named-site rule (review 2026-11-13, M3): on their own turn, a page, an email or a tool result
  // can still say "sign in to X". So the site must be named in their own recent words, or be the one
  // saved site Reason's question just before their bare "yes" named (src/namedsite.js). Code reads the
  // stored thread; the model's say-so is not an input. Refused: nothing opens, nothing is unwrapped, and
  // the fixed words ask them, so their answer ("yes", or the name) lets the next call through.
  // A Face ID yes for this exact login is their naming of it (2026-11-13: Netflix approved, then their
  // bare "go ahead" got "Sign in to netflix.com for that?" twice). An approved yes lets the call through
  // to be spent below; a link still waiting, or a yes just spent on this job, ends quietly: Reason
  // carries on by itself when they approve, and the job already going is not started or asked again.
  const face = resumed ? "" : faceIdState(c, row.id, { now: now() });
  const named = resumed || face === "approved" || namedByThem(trigger?.messages ?? [], row, listLogins(c)).ok;
  if (!named && face === "waiting") {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    return { ok: false, result: "waiting_face_id", say_exactly: "" };
  }
  if (!named && face === "just_used") return { ok: false, result: "resume_spent", say_exactly: "" };
  if (!named) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "stopped", purpose: why });
    const name = namesOf(row).names.size && String(row.label ?? "").trim() ? String(row.label).trim() : host;
    return { ok: false, result: "not_named", say_exactly: `Sign in to ${name} for that?` };
  }
  // Careful sites and an "each time" permission: a fresh Face ID before EVERY use (design B8). There
  // is no standing permission for them: one approval is one sign-in, consumed here before anything opens.
  if ((verdict.policy === "careful" || row.permission === "each_time") && resumed?.kind !== "approved" && !takeApproval(c, row.id, { now: now() })) {
    const request = resumed?.request ?? requestOf(trigger?.messages ?? []);
    const ask = askFaceId(c, row.id, host, { now: now(), request, via: trigger?.channel === "web" ? "web" : trigger?.channel ? "phone" : "" });
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    // With their request kept, the approval carries the job on by itself (src/resume.js): no "go ahead".
    const out = say("needs_face_id", host, ask.link);
    return request ? { ...out, say_exactly: `${host} needs your Face ID approval for each sign-in. Approve it here and I'll carry on by myself:\n${ask.link}` } : out;
  }
  // This sign-in is the job: a save grant still waiting for the same site (its resumed turn queued
  // behind this one) is spent now, so the job is not signed in to and done twice (review 2026-11-13).
  spendSaveGrants(c, [host, row.site]);

  // The sealed step. One lock per person covers the browser (hard rule: no stealth, no second browser).
  const holder = Symbol("filler");
  if (!holdProfile(c, holder)) return say("busy", host);
  // The restart gate (src/busy.js; verify-reason/bin/idle.sh): this browser, and the wait for a code
  // below, die with the process. Held as long as the profile is; kind only, no site, no person.
  const gateId = `filler:${++signIns}`;
  restartGate.hold(gateId, { kind: "saved_login" });
  let startedAt = now();
  const again = row.state === "working";
  const pinned = `${row.signin_origin}${row.signin_path}`;
  let session = null;
  let handedOff = false; // a texted code is waited for in the background; that wait closes and releases
  let typed = false; // the login went into the page's boxes (a failure after this rests the login a day)
  let codeHanded = false; // the wait for a texted or emailed code owns the browser and the gate now

  // One go at the pinned page: launch, the exact-origin checks, the form, the sealed typing and the
  // submit. → { out } (an ending already recorded, to say as it is) or { result, diag, page }.
  const attempt = async () => {
    unpinSite(c); // a new sign-in ends any earlier signed-in job
    await closeErrandBrowser(c);
    session = await launch({ conversationId: c });
    await guardContext(session.context, { conversationId: c });
    const page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(20_000);

    // Every main-frame navigation is counted: the email-first step is allowed to change path only
    // after the filler's own submit, so one that happens before it is not ours. Counted when it STARTS
    // (the request): a script's navigation still in flight when the filler checks is seen. A
    // same-document step (pushState, replaceState) is not counted: the path check sees one that changes
    // the path, and a site that tidies its own address on the same path is not refused for it.
    let navs = 0;
    page.on("request", (q) => { try { if (q.isNavigationRequest() && q.frame() === page.mainFrame()) navs += 1; } catch { /* gone */ } });
    const atPin = () => urlParts(page.url()).path === row.signin_path;
    // Navigations before the pinned page was reached, and the ones our own click on the page's "use
    // password" control caused: everything after this mark and before our submit is not ours.
    let navBase = 0;
    const ours = () => navs === navBase && atPin();
    const got = await reachPinned(page, row, { conversationId: c, mark: () => { navBase = navs; } });
    const door = got.door;
    // Hard rule 1: the exact origin after ALL redirects, as strings. Anything else: stop, type
    // nothing, zero KMS calls (the unwrap below never runs).
    if (got.verdict === "origin_mismatch") { finish(c, row, host, pinned, "origin_mismatch", { why, again, startedAt }); return { out: say("origin_mismatch", host) }; }
    if (got.verdict === "not_signin_page") { finish(c, row, host, pinned, "not_signin_page", { why, again, startedAt }); return { out: say("not_signin_page", host) }; }
    // A human-check that wants a person, showing before anything is typed and not clearing by itself
    // within the wait: stop, never solve it, never offer to try again.
    if (got.verdict === "wall") {
      try { markRefusing(row.site || host, "wall", now()); } catch { /* best effort */ }
      recordFinding({ site: host, label: host, signin_url: pinned }, { kind: "walled", why: "challenge on the sign-in page" });
      setState(c, row.id, { state: "refused" });
      unpinSite(c);
      logAttempt({ signin_url: pinned }, { route: again ? "saved_login_again" : "saved_login", outcome: "blocked_by_site", startedAt, detail: door ? "wall_front_door" : "wall_before_form" });
      recordLoginEvent(c, { site: host, event: "signin", outcome: "blocked", purpose: why });
      return { out: { ...say("walled", host), result: "blocked" } };
    }
    if (got.verdict !== "ok") {
      // The saved page itself has no sign-in form: the pin is wrong, not the page's mood. Never re-pinned
      // here; the person is told to save it again (forget, then a new save link pins a page with a form).
      finish(c, row, host, pinned, "not_signin_page", { why, again, startedAt });
      return { out: { ...say("needs_resave", host), result: "not_signin_page", resave: true } };
    }
    // From here the browser is held to the exact pinned origin (the same-site lock, src/browser.js): a
    // redirect or a script sending it elsewhere mid-fill is refused by the browser itself; fillAndSubmit
    // relaxes it to the site for the submit. The path is the pinned one (checked on arrival, and again
    // by `ours` before every keystroke step).
    const { form } = got;
    const at = urlParts(page.url());
    if (at.origin !== row.signin_origin || at.path !== row.signin_path) { finish(c, row, host, pinned, "origin_mismatch", { why, again, startedAt }); return { out: say("origin_mismatch", host) }; }

    // Unwrap and type, one KMS call, with the origin the browser is on now (design B5 step 5; KMS
    // refuses any other origin through the encryption context).
    // The page's own scripts get a moment to finish loading (a sign-in page's invisible bot check loads a
    // few seconds after the form shows; a submit before it may be refused). Bounded, nothing typed yet.
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
    let result;
    const diag = {};
    try {
      result = await withLogin(c, row.id, at.origin, (fields) => fillAndSubmit(page, row.signin_origin, form, fields,
        { typing: () => { typed = true; }, relax: () => pinExact(c, null), ours, atPin, answerMs, diag, toggled: () => { navBase = navs; } }), { purpose: why });
    } catch (e) {
      // withLogin's fixed codes, never a value. OriginDrift mid-fill comes back as fill_failed.
      const code = e instanceof VaultError ? e.code : "fill_failed";
      result = code === "origin_mismatch" ? "origin_mismatch"
        : code === "stopped" ? "paused"
        : code === "wait" ? "paused"
        : (code === "fill_failed" && /OriginDrift/.test(e?.message ?? "")) ? "origin_mismatch"
        : "not_signin_page";
      finish(c, row, host, pinned, result, { why, again, startedAt, typed, at: now() });
      return { out: say(result, host) };
    }
    return { result, diag, page };
  };

  // Everything after the typing: the second step, the record, the words. → the result object.
  const conclude = async ({ result, diag, page }) => {
    // The second step, after the secret is gone (the code is not a saved secret): what the row says
    // the site does wins over what the page's words suggest.
    // A code the site sent INSTEAD of the password (diag.codeInstead) is relayed through their texted
    // reply only: the row's second step does not rename it, and the mailbox is not read for it (reading
    // it automatically is a separate change with its own review).
    const codeInstead = diag.codeInstead || "";
    if (result.startsWith("needs_code") && !codeInstead) {
      if (row.second_step === "totp") result = "needs_authenticator";
      else if (row.second_step === "email") result = "needs_code_email";
      else if (row.second_step === "sms") result = "needs_code_sms";
    }
    const entry = { site: host, label: host, signin_url: pinned };
    if (result === "needs_code_email" && !codeInstead) {
      // The existing emailed-code reader: only mail from the site's own domains, from now on.
      const got = await emailCode(c, entry, { since: startedAt, ...(waitMs != null ? { waitMs } : {}) }).catch(() => ({ connected: false }));
      if (got?.connected && got.found && got.kind === "code" && got.code) result = await typeCodeOnce(page, row.signin_origin, String(got.code), enter);
      else if (got?.connected) result = "code_not_found";
      // No email connected: fall through and ask them once, as a texted code is.
    }
    if (result === "needs_code_sms" || result === "needs_code_email") {
      // Ask them once. Their reply is taken at intake (src/signinemail.js takeCodeReply), typed once,
      // and the end is told in the thread; the browser stays held for the wait and is released after.
      const asked = result;
      codeHanded = true;
      restartGate.hold(`${gateId}:code`, { kind: "saved_login_code" });
      restartGate.release(gateId);
      void (async () => {
        let end = "code_not_found";
        try {
          const code = await awaitReply(c, entry, ...(waitMs != null ? [{ waitMs }] : []));
          // Forgotten while the code was on its way (review 2026-11-13): the login is gone, so the code
          // is not typed and the sign-in is not finished after the person asked to forget it.
          if (!peekForSignin(c, host).some(r => r.id === row.id)) end = null;
          else if (code) end = await typeCodeOnce(page, row.signin_origin, String(code), enter);
        } catch { end = "not_signin_page"; }
        finally {
          await session?.close?.();
          releaseProfile(c, holder);
          restartGate.release(`${gateId}:code`);
        }
        if (end === null) { unpinSite(c); return; }
        try { finish(c, row, host, pinned, end, { why, again, startedAt, typed, at: now() }); } catch { /* a record that cannot be written never breaks the end */ }
        try { note(c, `[saved-login sign-in to ${host} ended: ${end}] ${say(end, host).say_exactly}`); } catch { /* best effort */ }
      })();
      recordLoginEvent(c, { site: host, event: "signin", outcome: asked, purpose: why });
      return say(asked, host, "", { codeInstead });
    }

    finish(c, row, host, pinned, result, { why, again, startedAt, typed, at: now() });
    // A human-check after the submit: the site turned the browser away (written down for the site).
    if (result === "blocked" && diag.challenge === true) { try { markRefusing(row.site || host, "challenge", now()); } catch { /* best effort */ } }
    if (result !== "signed_in") logDiag({ signin_url: pinned }, { ...diag, result });
    return say(result, host, "", { msgClass: diag.msgClass, msg: diag.msg });
  };

  try {
    const first = await attempt();
    if (first.out) return first.out;
    if (first.result === "site_trouble") {
      // The site's own error before it accepted or turned down the login: ONE more go, by itself, in a
      // fresh browser after a few minutes. The first go is logged but rests nothing; the person is told
      // once now, and the second go's ending is told when it comes (the code-wait pattern below). The
      // profile and the restart gate stay held for the whole job.
      handedOff = true;
      unpinSite(c);
      logAttempt({ signin_url: pinned }, { route: again ? "saved_login_again" : "saved_login", outcome: "failed", startedAt, detail: "site_trouble" });
      logDiag({ signin_url: pinned }, { ...first.diag, result: "site_trouble" });
      recordLoginEvent(c, { site: host, event: "signin", outcome: "site_trouble", purpose: why });
      void (async () => {
        let words = null;
        try {
          await session?.close?.();
          session = null;
          await new Promise((r) => setTimeout(r, Math.max(0, Number(retryWaitMs) || 0)));
          // Forgotten during the wait: nothing is opened and nothing is said.
          if (!peekForSignin(c, host).some((r) => r.id === row.id)) return;
          startedAt = now();
          typed = false;
          const second = await attempt();
          if (second.out) words = second.out;
          else if (second.result === "site_trouble") {
            // The same again: stop, and rest the login 6 hours (finish). Never a third go. Twice in a row
            // is the site turning the browser away: written down for the site (src/refusing.js), so the
            // next ask is answered up front.
            finish(c, row, host, pinned, "site_trouble", { why, again, startedAt, typed, at: now() });
            try { markRefusing(row.site || host, "generic_error_twice", now()); } catch { /* best effort */ }
            logDiag({ signin_url: pinned }, { ...second.diag, result: "site_trouble" });
            words = say("site_trouble", host, "", { msg: second.diag.msg });
          } else words = await conclude(second);
        } catch {
          try { finish(c, row, host, pinned, "not_signin_page", { why, again, startedAt, typed, at: now() }); } catch { /* best effort */ }
          words = say("not_signin_page", host);
        } finally {
          if (!codeHanded) {
            await session?.close?.();
            releaseProfile(c, holder);
            restartGate.release(gateId);
          }
        }
        if (words?.say_exactly) {
          try { note(c, `[saved-login sign-in to ${host} ended: ${words.result}] ${words.say_exactly}`); } catch { /* best effort */ }
        }
      })();
      return say("site_trouble", host, "", { msg: first.diag.msg, retrying: true });
    }
    return await conclude(first);
  } catch {
    // Never the error's words: a page's or a browser's text does not go back to the model.
    try { finish(c, row, host, pinned, "not_signin_page", { why, again, startedAt, typed, at: now() }); } catch { /* best effort */ }
    return say("not_signin_page", host);
  } finally {
    if (!handedOff && !codeHanded) {
      await session?.close?.();
      releaseProfile(c, holder);
      restartGate.release(gateId);
    }
  }
}

// ---------------------------------------------------------------- the Google step (src/federated.js)
/**
 * The saved Google login, typed on accounts.google.com (owner decision 2026-11-13), under the same rules
 * as any saved login: one KMS call; the page's own top frame; the exact origin checked right before
 * every keystroke; email first (Google's identifier step), then the one real password box. On Google's
 * account chooser, the row whose identifier is the saved username, else "Use another account". Returns
 * "typed", "drift" (left accounts.google.com: nothing more typed) or "none".
 */
function googleCredentials(conversationId) {
  return async (gp, row, { diag = { boxes: [] }, typing = () => {}, stepMs = 10_000 } = {}) => {
    const G = federated.GOOGLE;
    const here = () => urlParts(gp.url()).origin;
    const drift = () => { if (gp.isClosed() || here() !== G) { const e = new Error("left Google"); e.name = "OriginDrift"; throw e; } };
    const hold = () => pinExact(conversationId, G), release = () => pinExact(conversationId, null);
    const read = async () => federated.googleStep(await gp.evaluate(federated._test.GOOGLE_JS).catch(() => null));
    try {
      return await withLogin(conversationId, row.id, here(), async ({ username, password }) => {
        let pass = null;
        await username.use(async (b) => {
          const want = b.toString("utf8");
          const until = Date.now() + stepMs;
          let chose = false, typedEmail = false;
          while (Date.now() < until) {
            drift();
            const st = (await read()).kind;
            if (st === "chooser" && !chose) {
              chose = true;
              const rows = gp.locator("[data-identifier]:visible");
              const n = Math.min(await rows.count().catch(() => 0), 10);
              let hit = null;
              for (let i = 0; i < n; i++) {
                const id = String(await rows.nth(i).getAttribute("data-identifier").catch(() => "") ?? "");
                if (id.toLowerCase() === want.toLowerCase()) { hit = rows.nth(i); break; }
              }
              drift();
              await (hit ?? gp.getByText(/^\s*Use another account\s*$/i).first()).click({ timeout: FILL_MS }).catch(() => {});
            } else if (st === "email" && !typedEmail) {
              typedEmail = true;
              const box = gp.locator('input[type="email"]:visible').first();
              // Held to exactly accounts.google.com from the last origin check to the keystroke (review
              // 2026-11-13): the opener, a redirect or the site's own pages can't swap the tab in between.
              hold();
              try {
                drift(); typing();
                await box.fill(want, { timeout: FILL_MS });
                diag.boxes.push({ kind: "email", typed: await lengthIn(box), saved: want.length });
                drift();
                await box.press("Enter").catch(() => {});
              } finally { release(); }
            } else if (st !== "chooser" && st !== "email" && st !== "unknown") break;
            await gp.waitForTimeout(300).catch(() => {});
          }
        });
        // The password step: exactly one real password box on accounts.google.com's own frame.
        const until = Date.now() + stepMs;
        while (Date.now() < until) {
          drift();
          const boxes = gp.locator('input[type="password"]:visible');
          const k = (await read()).kind;
          if (k === "password" && (await boxes.count().catch(() => 0)) === 1) { pass = boxes.first(); break; }
          if (!["unknown", "email", "chooser"].includes(k)) break;
          await gp.waitForTimeout(300).catch(() => {});
        }
        if (!pass) { password.wipe?.(); return "none"; }
        hold();
        try {
          drift(); typing(); // immediately before the password keystroke
          await password.use(async (b) => { await pass.fill(b.toString("utf8"), { timeout: FILL_MS }); diag.boxes.push({ kind: "password", typed: await lengthIn(pass), saved: b.toString("utf8").length }); });
          drift();
          diag.pressed = "enter";
          await pass.press("Enter").catch(() => {});
        } finally { release(); }
        await gp.waitForTimeout(600).catch(() => {});
        await pass.fill("", { timeout: 800 }).catch(() => {});
        return "typed";
      }, { purpose: "the Google step of a sign-in they asked for" });
    } catch (e) {
      return /OriginDrift/.test(String(e?.message ?? "")) || e?.code === "origin_mismatch" ? "drift" : "none";
    }
  };
}

// ---------------------------------------------------------------- forgetting (hard rule 6)
const SIGN_OUT = /^\s*(sign|log)\s*-?\s*(out|off)\b/i;

/** The site's own cookies in this browser: its registrable domain and every subdomain. */
async function siteCookies(context, base) {
  const all = await context.cookies().catch(() => []);
  return all.filter(k => { const d = String(k.domain ?? "").replace(/^\./, "").toLowerCase(); return d === base || d.endsWith(`.${base}`); });
}

/**
 * "Forget my <site> login": sign out on the site where a sign-out control can be found on its own
 * pages, check it took, clear the site's cookies and stored data from this person's browser profile,
 * then delete every saved login for the site (row, ciphertext and wrapped key; secure_delete zeroes the
 * pages). Says plainly what could not be confirmed. The row goes even when the browser part cannot run
 * (the safe direction). → { ok, removed, signed_out, cleared, say_exactly }.
 */
export async function forgetLogin(conversationId, site, { launch = realLaunch, purpose = "they asked to forget it" } = {}) {
  const c = String(conversationId ?? "");
  const host = normSite(site);
  if (!savedLoginsAllowedFor(c) || !host) return { ok: false, removed: 0, say_exactly: "You don't have a saved login for that site." };
  // Every save link for the site goes too, open or used (review 2026-11-13): no live link, no quoted request.
  try { dropIntake(c, host); } catch { /* the login itself still goes below */ }
  const rows = peekForSignin(c, host);
  if (!rows.length) return { ok: true, removed: 0, say_exactly: `You don't have a saved login for ${host}.` };
  const base = registrableOf(rows[0].site) || rows[0].site;
  const origin = rows[0].signin_origin;
  let signedOut = false;
  let cleared = false;
  const holder = Symbol("forget");
  if (holdProfile(c, holder)) {
    let session = null;
    try {
      unpinSite(c);
      await closeErrandBrowser(c);
      session = await launch({ conversationId: c });
      await guardContext(session.context, { conversationId: c });
      const page = session.context.pages()[0] ?? await session.context.newPage();
      page.setDefaultTimeout(15_000);
      pinSite(c, base, { hosts: [new URL(origin).hostname] }); // the forget walk itself stays on the site
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
      // Signing out, honestly: only a control on the site's own page whose words say sign out / log
      // out, and only while the browser is still on the site's origin. Checked after: no such control left.
      if (urlParts(page.url()).origin === origin) {
        const control = page.getByRole("link", { name: SIGN_OUT }).or(page.getByRole("button", { name: SIGN_OUT })).first();
        if (await control.count().catch(() => 0)) {
          await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => {}), control.click().catch(() => {})]);
          await page.waitForTimeout(300).catch(() => {});
          const still = await page.getByRole("link", { name: SIGN_OUT }).or(page.getByRole("button", { name: SIGN_OUT })).count().catch(() => 1);
          signedOut = urlParts(page.url()).origin === origin && still === 0;
        }
        // Stored data for the origin (localStorage, sessionStorage, IndexedDB, caches, workers).
        await page.evaluate(clearOriginInPage).catch(() => null);
      }
      // Cookies for the site and every subdomain, then checked gone.
      for (const k of await siteCookies(session.context, base)) {
        await session.context.clearCookies({ name: k.name, domain: k.domain, path: k.path }).catch(() => {});
      }
      cleared = (await siteCookies(session.context, base)).length === 0;
    } catch { /* the row still goes below; the words say what was not confirmed */ }
    finally {
      unpinSite(c);
      await session?.close?.();
      releaseProfile(c, holder);
    }
  }
  let removed = 0;
  for (const r of rows) {
    dropAsks(c, r.id);
    if (removeLogin(c, r.id, { purpose })) removed++;
  }
  recordLoginEvent(c, { site: base, event: "signed_out", outcome: signedOut && cleared ? "ok" : "stopped", purpose });
  const parts = [`Done. I deleted your saved login for ${base}.`];
  if (signedOut && cleared) parts.push(`I signed out on ${base} and cleared its cookies and stored data from my browser.`);
  else if (cleared) parts.push(`I cleared ${base}'s cookies and stored data from my browser, but I couldn't confirm a sign-out on ${base} itself. To be sure, sign out of other sessions in your ${base} account settings.`);
  else parts.push(`I couldn't confirm that ${base}'s session in my browser is gone. To be sure, sign out of other sessions in your ${base} account settings.`);
  return { ok: true, removed, signed_out: signedOut, cleared, say_exactly: parts.join(" ") };
}
