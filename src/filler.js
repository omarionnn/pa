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
import {
  savedLoginsAllowedFor, peekForSignin, setState, withLogin, recordLoginEvent, VaultError,
} from "./savedlogins.js";
import {
  profileDirFor, guardContext, launchOptions, holdProfile, releaseProfile, closeBrowser as closeErrandBrowser,
} from "./browser.js";
import { classifySite, refusalFor } from "./sitepolicy.js";
import { recordFinding } from "./sitefindings.js";
import { readPage } from "./signinpage.js";

// The words the tool returns, one per outcome (design B5 step 8). `ok` is only a signed-in session.
export const SIGNIN_RESULTS = [
  "signed_in", "needs_code_sms", "needs_approval", "wrong_password", "blocked",
  "not_signin_page", "origin_mismatch", "paused", "needs_face_id", "no_login", "pick_one", "busy",
];
const OK_RESULT = new Set(["signed_in"]);
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
    needs_code_sms: `I signed in to ${site}; it texted a code to finish. I'll ask you for it rather than guess.`,
    needs_approval: `I signed in to ${site}; it wants you to approve the sign-in in an app.`,
    wrong_password: `I couldn't sign you in to ${site}: the saved password wasn't accepted. I've stopped and won't try again until you save it again.`,
    blocked: `${site} blocked the sign-in. That's their choice, not something you did. I stopped and did not retry.`,
    not_signin_page: `I couldn't sign you in to ${site}: I didn't reach its real sign-in page, so I typed nothing.`,
    origin_mismatch: `I couldn't sign you in to ${site}: the page wasn't on its exact sign-in address, so I typed nothing.`,
    paused: `${site} is paused after an earlier refusal, so I didn't try again.`,
    needs_face_id: `${site} needs your Face ID approval for each sign-in. Approve it and I'll sign you in.`,
    no_login: `You don't have a saved login for ${site}.`,
    pick_one: `You have more than one saved login for ${site}. Tell me which one and I'll use it.`,
    busy: `I'm already using the browser for you right now. I'll sign in to ${site} once that's done.`,
  };
  return { ok: OK_RESULT.has(result), result, say_exactly: lines[result] ?? `I couldn't sign you in to ${site}.`, ...(extra ? { detail: extra } : {}) };
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
  if (hasOtp) return "needs_code_sms";
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
async function findForm(page) {
  const pass = page.locator('input[type="password"]:visible').first();
  if (!(await pass.count())) return { ok: false };
  const user = page.locator(
    'input[type="email"]:visible, input[autocomplete="username"]:visible, input[name*="user" i]:visible, input[name*="email" i]:visible, input[id*="user" i]:visible, input[id*="email" i]:visible, input[type="text"]:visible',
  ).first();
  return { ok: true, user: (await user.count()) ? user : null, pass };
}

/**
 * The sealed step. Called inside withLogin with the fields as Secrets; it types them with
 * locator.fill (no simulated human typing, which Amazon's terms ban), re-checks the origin right
 * before the password keystroke, submits, waits, then empties the boxes it typed into. It reads the
 * page to name the outcome but never returns a secret. A redirect off the pinned origin mid-fill
 * throws, which withLogin turns into the fixed code fill_failed and the caller reads as origin_mismatch.
 */
async function fillAndSubmit(page, pinnedOrigin, form, { username, password }) {
  const here = () => urlParts(page.url()).origin;
  const ensure = () => { if (here() !== pinnedOrigin) { const e = new Error("origin drifted"); e.name = "OriginDrift"; throw e; } };
  ensure();
  if (form.user) await username.use(async (b) => { await form.user.fill(b.toString("utf8")); });
  ensure(); // immediately before the password keystroke (design B5 step 5)
  await password.use(async (b) => { await form.pass.fill(b.toString("utf8")); });
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

/**
 * Sign in to `site` with the person's saved login. Returns { ok, result, say_exactly }. `trigger`
 * carries how this turn started (hard rule 8). `launch` and `now` are injectable for tests.
 */
export async function signIn(conversationId, site, { trigger = null, purpose = "", launch = realLaunch, now = () => clock.now() } = {}) {
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

  // Careful sites and an "each time" permission need a fresh Face ID approval; there is no standing
  // permission for them (hard rule 3, design B8). A standing permission needs a live ask (hard rule 8).
  if (verdict.policy === "careful" || row.permission === "each_time") {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    return say("needs_face_id", host);
  }
  if (!liveAskOk(trigger)) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "needs_face_id", purpose: why });
    return { ...say("needs_face_id", host), say_exactly: `I only sign in to ${host} when you ask me in the moment. Ask me and I'll do it.` };
  }

  // The sealed step. One lock per person covers the browser (hard rule: no stealth, no second browser).
  const holder = Symbol("filler");
  if (!holdProfile(c, holder)) return say("busy", host);
  let session = null;
  try {
    await closeErrandBrowser(c);
    session = await launch({ conversationId: c });
    await guardContext(session.context);
    const page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(20_000);

    // Code goes to the pinned page itself, in its own tab; never a page the model was on, never a
    // link from a page or an email (design B5 step 3).
    const pinned = `${row.signin_origin}${row.signin_path}`;
    await page.goto(pinned, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

    // Hard rule 1: the exact origin after ALL redirects, as strings. Anything else: stop, type
    // nothing, zero KMS calls (the unwrap below never runs).
    const at = urlParts(page.url());
    if (at.origin !== row.signin_origin) {
      recordLoginEvent(c, { site: host, event: "signin", outcome: "origin_mismatch", purpose: why });
      return say("origin_mismatch", host);
    }
    if (at.path !== row.signin_path) {
      recordLoginEvent(c, { site: host, event: "signin", outcome: "not_signin_page", purpose: why });
      return say("not_signin_page", host);
    }
    const read = await readPage(page).catch(() => null);
    if (read?.kind === "challenge") {
      recordFinding({ site: host, label: host, signin_url: pinned }, { kind: "walled", why: "challenge on the sign-in page" });
      setState(c, row.id, { state: "refused" });
      recordLoginEvent(c, { site: host, event: "signin", outcome: "blocked", purpose: why });
      return say("blocked", host);
    }
    const form = await findForm(page);
    if (!form.ok) {
      recordLoginEvent(c, { site: host, event: "signin", outcome: "not_signin_page", purpose: why });
      return say("not_signin_page", host);
    }

    // Unwrap and type, one KMS call, with the origin the browser is on now (design B5 step 5; KMS
    // refuses any other origin through the encryption context).
    let result;
    try {
      result = await withLogin(c, row.id, at.origin, (fields) => fillAndSubmit(page, row.signin_origin, form, fields), { purpose: why });
    } catch (e) {
      // withLogin's fixed codes, never a value. OriginDrift mid-fill comes back as fill_failed.
      const code = e instanceof VaultError ? e.code : "fill_failed";
      result = code === "origin_mismatch" ? "origin_mismatch"
        : code === "stopped" ? "paused"
        : code === "wait" ? "paused"
        : (code === "fill_failed" && /OriginDrift/.test(e?.message ?? "")) ? "origin_mismatch"
        : "not_signin_page";
      recordLoginEvent(c, { site: host, event: "signin", outcome: result, purpose: why });
      return say(result, host);
    }

    // Move the row, and write the person's readable line (hard rule 5). A success flips unverified -> working.
    if (result === "signed_in") setState(c, row.id, { state: "working", failCount: 0, clearNextTry: true });
    else if (result === "wrong_password") setState(c, row.id, { state: "wrong_password", bumpFail: true });
    else if (REFUSED_BY_SITE.has(result)) {
      recordFinding({ site: host, label: host, signin_url: pinned }, { kind: "walled", why: "a wall after the password" });
      setState(c, row.id, { state: "refused" });
    }
    recordLoginEvent(c, { site: host, event: "signin", outcome: result, purpose: why });
    return say(result, host);
  } catch (e) {
    recordLoginEvent(c, { site: host, event: "signin", outcome: "not_signin_page", purpose: why });
    return say("not_signin_page", host, (e?.message ?? "").split("\n")[0].slice(0, 60));
  } finally {
    await session?.close?.();
    releaseProfile(c, holder);
  }
}
