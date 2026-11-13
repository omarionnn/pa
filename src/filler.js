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
import { clock } from "./config.js";
import * as db from "./db.js";
import {
  savedLoginsAllowedFor, peekForSignin, listLogins, setState, withLogin, recordLoginEvent, removeLogin, VaultError,
} from "./savedlogins.js";
import { namedByThem, namesOf } from "./namedsite.js";
import {
  profileDirFor, guardContext, launchOptions, holdProfile, releaseProfile, closeBrowser as closeErrandBrowser,
  pinSite, pinExact, unpinSite,
} from "./browser.js";
import { dropIntake } from "./loginintake.js";
import { classifySite, refusalFor, registrableOf } from "./sitepolicy.js";
import { recordFinding } from "./sitefindings.js";
import { readPage, loginFormOf, waitFor, settleWatch, formWaitMs } from "./signinpage.js";
import { logAttempt } from "./signinlog.js";
import { codeFromGmail, enterCode, awaitCodeReply } from "./signinemail.js";
import { clearOriginInPage } from "./signin.js";
import { askFaceId, takeApproval, dropAsks } from "./loginuse.js";

// The words the tool returns, one per outcome (design B5 step 8). `ok` is only a signed-in session.
export const SIGNIN_RESULTS = [
  "signed_in", "needs_code_sms", "needs_approval", "wrong_password", "blocked",
  "not_signin_page", "origin_mismatch", "paused", "needs_face_id", "no_login", "pick_one", "busy",
  "needs_code_email", "needs_authenticator", "code_not_found", "wrong_code", "not_named",
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
function say(result, site, extra = "") {
  const lines = {
    signed_in: `Signed you in to ${site}.`,
    needs_code_sms: `${site} texted a code to your phone to finish signing in. Send me that code and I'll type it in, once.`,
    needs_code_email: `${site} emailed a code to finish signing in, and I couldn't read it from your email. Send me that code and I'll type it in, once.`,
    needs_authenticator: `${site} wants a code from an authenticator app. I can't do that yet, so I stopped. You can sign in to ${site} yourself.`,
    code_not_found: `${site} emailed a code, but it didn't arrive in time. I stopped and didn't guess.`,
    wrong_code: `${site} didn't accept the code. I stopped and didn't try another.`,
    needs_approval: `I signed in to ${site}; it wants you to approve the sign-in in an app.`,
    wrong_password: `I couldn't sign you in to ${site}: the saved password wasn't accepted. I've stopped and won't try again until you save it again.`,
    blocked: `${site} blocked the sign-in. That's their choice, not something you did. I stopped and did not retry.`,
    not_signin_page: `I couldn't sign you in to ${site}: its sign-in page didn't show the sign-in form I expected (it may have changed, or not loaded in time), so I typed nothing. Ask me again in a bit; if it keeps happening, the saved login may need saving again.`,
    // The saved page itself has no sign-in form (a login saved before 2026-11-13 could be pinned to a
    // site's home page). Never re-pinned silently: the person forgets it and saves it again, and the
    // new save link pins the page Reason's own visit finds the form on.
    needs_resave: `I couldn't sign you in to ${site}: the page your saved login points to has no sign-in form, so I typed nothing. It needs saving again: I can forget the saved one and send you a new link to save it on ${site}'s real sign-in page.`,
    origin_mismatch: `I couldn't sign you in to ${site}: the page wasn't on its exact sign-in address, so I typed nothing.`,
    paused: `${site} is paused after an earlier refusal, so I didn't try again.`,
    needs_face_id: `${site} needs your Face ID approval for each sign-in. Approve it here, then tell me to go ahead:`,
    no_login: `You don't have a saved login for ${site}.`,
    pick_one: `You have more than one saved login for ${site}. Tell me which one and I'll use it.`,
    busy: `I'm already using the browser for you right now. I'll sign in to ${site} once that's done.`,
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
  const options = launchOptions(conversationId, { headless: true, viewport: { width: 1280, height: 900 } });
  const context = await chromium.launchPersistentContext(profileDirFor(conversationId), options);
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
const SUSPICIOUS = /suspicious|unusual (activity|sign.?in)|unrecognized|we don'?t recognize|verify it'?s you because|protect your account|something (looks|seems) off/i;

/**
 * Read the page after the secret was typed and submitted, and name what happened. Pure-ish: it only
 * reads the page (never types), and returns one of the result words. `readSignedInState` (src/sites.js,
 * PR #525) is the right positive-evidence check for a real session and is wired in PR 8; here a
 * fixture-grade read is used — no password box left, no challenge, no code step — and that is flagged.
 */
async function classifyAfterSubmit(page) {
  let read;
  try { read = await readPage(page); } catch { return "not_signin_page"; }
  const text = String(read?.raw?.text ?? "");
  const boxes = Array.isArray(read?.raw?.fields) ? read.raw.fields : [];
  const kinds = boxes.map(f => kindOf(f));
  const hasPassword = kinds.includes("password");
  const hasOtp = kinds.includes("otp");
  if (read.kind === "challenge" || SUSPICIOUS.test(text)) return "blocked";
  if (hasPassword && WRONG_PW.test(text)) return "wrong_password";
  if (PUSH.test(text)) return "needs_approval";
  if (hasOtp) return AUTHENTICATOR.test(text) ? "needs_authenticator" : EMAILED.test(text) ? "needs_code_email" : "needs_code_sms";
  // No password box and no challenge: the form was accepted. A logout/account control is the
  // positive evidence a real session read uses; its absence on a fixture is still a signed-in page.
  if (!hasPassword) return "signed_in";
  // Still sitting on the password box with no error: treat as not completing rather than claim success.
  return "wrong_password";
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
  const pass = page.locator('input[type="password"]:visible').first();
  if (!(await pass.count())) return { ok: false };
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
async function fillAndSubmit(page, pinnedOrigin, form, { username, password }, { typing = () => {}, relax = () => {}, ours = () => true, stepMs = STEP_MS } = {}) {
  const here = () => urlParts(page.url()).origin;
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
    await username.use(async (b) => { await form.user.fill(b.toString("utf8"), { timeout: FILL_MS }); });
    // A moment for anything the typing set off to show itself, then the check: a page that moves on its
    // own once the username is in is not answering our submit, and gets no password.
    await page.waitForTimeout(OWN_STEP_MS).catch(() => {});
    ensure(); notOurs();
    const before = page.url();
    await form.user.press("Enter").catch(() => {});
    let pass = await passwordStep(page, pinnedOrigin, 1_500);
    if (!pass && page.url() === before) {
      // Enter did nothing (a "Continue" button outside any form): press the page's own one, once.
      await page.locator('button[type="submit"]:visible, button:has-text("Continue"):visible, button:has-text("Next"):visible').first().click({ timeout: FILL_MS }).catch(() => {});
    }
    if (!pass) pass = await passwordStep(page, pinnedOrigin, stepMs);
    ensure();
    if (!pass) {
      const r = await readPage(page).catch(() => null);
      return r?.kind === "challenge" ? "blocked" : "not_signin_page";
    }
    form = { user: form.user, pass }; // the username box too, for the clean-up after the submit (a one-page step keeps it)
    ensure(); // immediately before the password keystroke
    await password.use(async (b) => { await form.pass.fill(b.toString("utf8"), { timeout: FILL_MS }); });
    ensure();
    relax();
    return await submitAndRead(page, form);
  }
  // The browser is held to the exact pinned origin until both boxes are typed (the caller pinned it, and
  // the browser refuses every page load anywhere else), so the document the keystroke lands in is
  // this origin's: a script, a meta refresh or a redirect after this check cannot swap in another
  // origin's page under the locator (review 2026-11-13). The check below is the second line.
  ensure();
  typing();
  if (form.user) await username.use(async (b) => { await form.user.fill(b.toString("utf8"), { timeout: FILL_MS }); });
  ensure(); // immediately before the password keystroke (design B5 step 5)
  await password.use(async (b) => { await form.pass.fill(b.toString("utf8"), { timeout: FILL_MS }); });
  ensure();
  // Typed. The submit may go to another origin of the same site (a sign-in host posting to the account
  // host); the same-site lock still refuses any other site, and http under an https pin.
  relax();
  return await submitAndRead(page, form);
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
async function passwordStep(page, pinnedOrigin, ms) {
  const until = Date.now() + ms;
  for (;;) {
    if (urlParts(page.url()).origin !== pinnedOrigin) return null;
    const r = await readPage(page).catch(() => null);
    const boxes = page.locator('input[type="password"]:visible');
    if (r && loginFormOf(r.raw) === "password" && (await boxes.count().catch(() => 0)) === 1) return boxes.first();
    if (Date.now() >= until) return null;
    await page.waitForTimeout(250).catch(() => {});
  }
}

async function submitAndRead(page, form) {
  // "Remember this device" when the page offers it (design B5 step 5), so the next job need not sign in.
  const remember = page.locator('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i], input[type="checkbox"][name*="trust" i]').first();
  if (await remember.count().catch(() => 0)) await remember.check().catch(() => {});
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    form.pass.press("Enter").catch(async () => { await page.locator('button[type="submit"]:visible, button:has-text("Sign in"):visible, button:has-text("Log in"):visible').first().click().catch(() => {}); }),
  ]);
  await page.waitForTimeout(400).catch(() => {});
  // Clean up before anyone looks: empty any box the filler typed into that is still on the page
  // (design B5 step 7). After a submit the page has usually navigated and the box is gone; a short
  // timeout keeps that ordinary case from blocking on the default wait.
  for (const loc of [form.user, form.pass]) {
    if (loc) await loc.fill("", { timeout: 800 }).catch(() => {});
  }
  return await classifyAfterSubmit(page);
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
  } else if (typed) setState(c, row.id, { nextTryAt: (at ?? clock.now()) + RETRY_PAUSE_MS });
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
export async function signIn(conversationId, site, {
  trigger = null, purpose = "", launch = realLaunch, now = () => clock.now(),
  emailCode = codeFromGmail, enter = enterCode, awaitReply = awaitCodeReply, note = defaultNote, waitMs = undefined,
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

  const rows = peekForSignin(c, host);
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
  if (!liveAskOk(trigger)) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    return { ...say("needs_face_id", host), say_exactly: `I only sign in to ${host} when you ask me in the moment. Ask me and I'll do it.` };
  }
  // The named-site rule (review 2026-11-13, M3): on their own turn, a page, an email or a tool result
  // can still say "sign in to X". So the site must be named in their own recent words, or be the one
  // saved site Reason's question just before their bare "yes" named (src/namedsite.js). Code reads the
  // stored thread; the model's say-so is not an input. Refused: nothing opens, nothing is unwrapped, and
  // the fixed words ask them, so their answer ("yes", or the name) lets the next call through.
  if (!namedByThem(trigger?.messages ?? [], row, listLogins(c)).ok) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "stopped", purpose: why });
    const name = namesOf(row).names.size && String(row.label ?? "").trim() ? String(row.label).trim() : host;
    return { ok: false, result: "not_named", say_exactly: `Sign in to ${name} for that?` };
  }
  // Careful sites and an "each time" permission: a fresh Face ID before EVERY use (design B8). There
  // is no standing permission for them: one approval is one sign-in, consumed here before anything opens.
  if ((verdict.policy === "careful" || row.permission === "each_time") && !takeApproval(c, row.id, { now: now() })) {
    const ask = askFaceId(c, row.id, host, { now: now() });
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    return say("needs_face_id", host, ask.link);
  }

  // The sealed step. One lock per person covers the browser (hard rule: no stealth, no second browser).
  const holder = Symbol("filler");
  if (!holdProfile(c, holder)) return say("busy", host);
  const startedAt = now();
  const again = row.state === "working";
  const pinned = `${row.signin_origin}${row.signin_path}`;
  let session = null;
  let handedOff = false; // a texted code is waited for in the background; that wait closes and releases
  let typed = false; // the login went into the page's boxes (a failure after this rests the login a day)
  try {
    unpinSite(c); // a new sign-in ends any earlier signed-in job
    await closeErrandBrowser(c);
    session = await launch({ conversationId: c });
    await guardContext(session.context, { conversationId: c });
    const page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(20_000);

    // Code goes to the pinned page itself, in its own tab; never a page the model was on, never a
    // link from a page or an email (design B5 step 3).
    await page.goto(pinned, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

    // Hard rule 1: the exact origin after ALL redirects, as strings. Anything else: stop, type
    // nothing, zero KMS calls (the unwrap below never runs).
    const at = urlParts(page.url());
    if (at.origin !== row.signin_origin) { finish(c, row, host, pinned, "origin_mismatch", { why, again, startedAt }); return say("origin_mismatch", host); }
    if (at.path !== row.signin_path) { finish(c, row, host, pinned, "not_signin_page", { why, again, startedAt }); return say("not_signin_page", host); }
    // From here the browser is held to this site (the same-site lock, src/browser.js): a redirect or a
    // script sending it elsewhere mid-fill is refused by the browser itself.
    // Held to the exact origin until the login is typed (fillAndSubmit relaxes it to the site for the submit).
    pinSite(c, row.site, { hosts: [new URL(row.signin_origin).hostname], exact: row.signin_origin, secure: row.signin_origin.startsWith("https:") });
    // Every main-frame navigation from here on is counted: the email-first step is allowed to change
    // path only after the filler's own submit, so one that happens before it is not ours.
    let navs = 0;
    // Counted when it STARTS (the request) as well as when it lands: a script's navigation in flight
    // when the filler checks is still seen.
    page.on("framenavigated", (f) => { try { if (f === page.mainFrame()) navs += 1; } catch { /* gone */ } });
    page.on("request", (q) => { try { if (q.isNavigationRequest() && q.frame() === page.mainFrame()) navs += 1; } catch { /* gone */ } });
    const ours = () => navs === 0 && urlParts(page.url()).path === row.signin_path;
    // A sign-in form the page draws with its own script is waited for (bounded; a finished page that
    // stays formless ends the wait early). A challenge ends it too.
    const watch = settleWatch(page);
    const got = await waitFor(page, async () => { const r = await readPage(page); return r.kind === "challenge" || loginFormOf(r.raw) ? r : null; },
      { waitMs: formWaitMs(), stop: () => watch.settled() }).finally(() => watch.stop());
    const read = got.found ? got.value : await readPage(page).catch(() => null);
    if (read?.kind === "challenge") {
      recordFinding({ site: host, label: host, signin_url: pinned }, { kind: "walled", why: "challenge on the sign-in page" });
      setState(c, row.id, { state: "refused" });
      unpinSite(c);
      logAttempt({ signin_url: pinned }, { route: again ? "saved_login_again" : "saved_login", outcome: "blocked_by_site", startedAt, detail: "wall_before_form" });
      recordLoginEvent(c, { site: host, event: "signin", outcome: "blocked", purpose: why });
      return say("blocked", host);
    }
    let form = await findForm(page);
    if (!form.ok && loginFormOf(read?.raw) === "email_first") form = await findEmailFirst(page);
    if (!form.ok) {
      // The saved page itself has no sign-in form: the pin is wrong, not the page's mood. Never re-pinned
      // here; the person is told to save it again (forget, then a new save link pins a page with a form).
      finish(c, row, host, pinned, "not_signin_page", { why, again, startedAt });
      return { ...say("needs_resave", host), result: "not_signin_page", resave: true };
    }

    // Unwrap and type, one KMS call, with the origin the browser is on now (design B5 step 5; KMS
    // refuses any other origin through the encryption context).
    let result;
    try {
      result = await withLogin(c, row.id, at.origin, (fields) => fillAndSubmit(page, row.signin_origin, form, fields,
        { typing: () => { typed = true; }, relax: () => pinExact(c, null), ours }), { purpose: why });
    } catch (e) {
      // withLogin's fixed codes, never a value. OriginDrift mid-fill comes back as fill_failed.
      const code = e instanceof VaultError ? e.code : "fill_failed";
      result = code === "origin_mismatch" ? "origin_mismatch"
        : code === "stopped" ? "paused"
        : code === "wait" ? "paused"
        : (code === "fill_failed" && /OriginDrift/.test(e?.message ?? "")) ? "origin_mismatch"
        : "not_signin_page";
      finish(c, row, host, pinned, result, { why, again, startedAt, typed, at: now() });
      return say(result, host);
    }

    // The second step, after the secret is gone (the code is not a saved secret): what the row says
    // the site does wins over what the page's words suggest.
    if (result.startsWith("needs_code")) {
      if (row.second_step === "totp") result = "needs_authenticator";
      else if (row.second_step === "email") result = "needs_code_email";
      else if (row.second_step === "sms") result = "needs_code_sms";
    }
    const entry = { site: host, label: host, signin_url: pinned };
    if (result === "needs_code_email") {
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
      handedOff = true;
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
        }
        if (end === null) { unpinSite(c); return; }
        try { finish(c, row, host, pinned, end, { why, again, startedAt, typed, at: now() }); } catch { /* a record that cannot be written never breaks the end */ }
        try { note(c, `[saved-login sign-in to ${host} ended: ${end}] ${say(end, host).say_exactly}`); } catch { /* best effort */ }
      })();
      recordLoginEvent(c, { site: host, event: "signin", outcome: asked, purpose: why });
      return say(asked, host);
    }

    finish(c, row, host, pinned, result, { why, again, startedAt, typed, at: now() });
    return say(result, host);
  } catch {
    // Never the error's words: a page's or a browser's text does not go back to the model.
    try { finish(c, row, host, pinned, "not_signin_page", { why, again, startedAt, typed, at: now() }); } catch { /* best effort */ }
    return say("not_signin_page", host);
  } finally {
    if (!handedOff) {
      await session?.close?.();
      releaseProfile(c, holder);
    }
  }
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
