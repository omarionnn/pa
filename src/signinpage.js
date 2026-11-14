// Where a site's sign-in really is, what kind of page is in front of a person, and how the last
// link ended.
//
// The owner's attempt of 2026-11-12 (22:13-22:27 ET, Stripe Link) went wrong in plain ways, and the
// answer to each is in this file:
//
//   1. The emailed-code route read app.link.com's sign-in page ONCE, 1.1 s after it loaded, and
//      concluded there was no email box. The page draws its box with its own script, 1.3 s in.
//      → `waitFor` polls with a bound and stops as soon as the thing appears; `readPage` looks in the
//        page's same-origin frames too.
//   2. The hand-off link was then made for the bare name "link.com", which is the marketing home
//      page, not the sign-in page the attempt had been on.
//      → `rememberSigninPage` / `signinPageFor` carry the page (origin + path, never a query string)
//        in code, so nothing depends on a model retyping it; `followSigninDoor` goes through the
//        site's own "Log in" link once when only a bare name is known.
//   3. The hosted page said "finish this step on the page below" over that marketing page.
//      → `pageKind` says what a page is. Only a form, a challenge or a provider prompt is a step.
//   4. When that session ran out, another identical link went out.
//      → `noteEnding` / `lastNoProgress` remember an ending without progress, across a restart.
//
// Nothing here types anything, presses a provider button or reads what is in a box.
import { clock, config } from "./config.js";
import * as db from "./db.js";
import * as social from "./socialsignin.js";

// ---------------------------------------------------------------- reading a page
/**
 * What the page needs to know about the site's form, read out of the site's own document.
 *
 * Where each box is, what kind it is, what the site calls it, and how many characters are in it.
 * Never a character OF it: `len` is a count, and there is no field anywhere in this object that
 * carries a value. That is what makes it safe to hand to the phone every second.
 *
 * `acct` is one word from a fixed list ("logout" | "account" | ""): whether the document has a
 * log-out or account control anywhere in it, a closed menu included. It is the positive evidence
 * "signed in" needs on a site nobody has a playbook for; it is never the control's own text.
 * `door` is the site's own way to its sign-in page ("Log in"), when the page has one.
 */
export const FRAME_JS = `(() => {
  var W = window.innerWidth || 1, H = window.innerHeight || 1;
  var skip = ['hidden','submit','button','reset','image','checkbox','radio','file','range','color'];
  var out = [];
  var els = document.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable="true"]');
  for (var i = 0; i < els.length && out.length < 24; i++) {
    var el = els[i], tag = (el.tagName || '').toLowerCase(), type = (el.type || '').toLowerCase();
    if (tag === 'input' && skip.indexOf(type) >= 0) continue;
    if (el.disabled || el.readOnly) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 14) continue;
    if (r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) continue;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    var label = el.getAttribute('aria-label') || el.placeholder || '';
    if (!label && el.id) { try { var l = document.querySelector('label[for="' + el.id.replace(/["\\\\]/g, '') + '"]'); if (l) label = l.innerText; } catch (e) {} }
    if (!label && el.closest) { var w = el.closest('label'); if (w) label = w.innerText; }
    out.push({
      x: r.left / W, y: r.top / H, w: r.width / W, h: r.height / H,
      tag: tag, type: type,
      ac: el.getAttribute('autocomplete') || '', name: el.name || '', id: el.id || '',
      label: String(label || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      im: el.getAttribute('inputmode') || '',
      ml: Number(el.getAttribute('maxlength')) || 0,
      len: String(el.value == null ? (el.textContent || '') : el.value).length,
      focused: el === document.activeElement
    });
  }
  // The labels of the visible buttons (a site's bare "Google" button), for the native chooser. Words
  // the site drew on its buttons, never anything in a box.
  var bl = [], bs = document.querySelectorAll('button,a[href],[role="button"]');
  for (var j = 0; j < bs.length && bl.length < 24; j++) {
    var b = bs[j], br = b.getBoundingClientRect();
    if (br.width < 20 || br.height < 14 || br.bottom <= 0 || br.top >= H) continue;
    var bt = String((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
    if (bt && bt.length <= 60) bl.push(bt);
  }
  // A log-out or account control anywhere in the document, hidden menus included: one word, never its text.
  var acct = '';
  try {
    var OUT = /^(log ?out|sign ?out|log off|sign off)$/i, ACC = /^(my account|your account|account settings|manage (my |your )?account|my profile|profile settings)$/i;
    if (document.querySelector('a[href*="logout" i],a[href*="log-out" i],a[href*="log_out" i],a[href*="signout" i],a[href*="sign-out" i],a[href*="sign_out" i],form[action*="logout" i],form[action*="signout" i],form[action*="sign_out" i],[data-testid*="logout" i],[data-testid*="sign-out" i]')) acct = 'logout';
    var cs2 = document.querySelectorAll('a,button,[role="menuitem"],[role="button"]');
    for (var k = 0; k < cs2.length && k < 1500 && acct !== 'logout'; k++) {
      var ct = String(cs2[k].textContent || cs2[k].getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      if (!ct || ct.length > 24) continue;
      if (OUT.test(ct)) acct = 'logout'; else if (!acct && ACC.test(ct)) acct = 'account';
    }
  } catch (e) {}
  // The site's own message boxes ("There was a problem", "Important Message!"), visible ones only: what
  // the site said back to a submit. Its words, never anything in a box; masked again before use.
  var al = [], seenA = {};
  try {
    var as = document.querySelectorAll('[role="alert"],[aria-live="assertive"],.a-alert,[class*="alert" i],[class*="error-message" i],[id*="error-message" i],[class*="form-error" i]');
    for (var a = 0; a < as.length && al.length < 3; a++) {
      var ae = as[a], ar = ae.getBoundingClientRect();
      if (ar.width < 4 || ar.height < 4) continue;
      var acs = window.getComputedStyle(ae);
      if (acs.visibility === 'hidden' || acs.display === 'none' || Number(acs.opacity) < 0.05) continue;
      var at = String(ae.innerText || '').replace(/\\s+/g, ' ').trim();
      if (at.length < 3 || at.length > 400 || seenA[at]) continue;
      var dup = false; for (var q = 0; q < al.length; q++) if (al[q].indexOf(at) >= 0 || at.indexOf(al[q]) >= 0) { dup = true; if (at.length > al[q].length) al[q] = at; }
      seenA[at] = 1; if (!dup) al.push(at);
    }
  } catch (e) {}
  // A picture or puzzle check on the page: names only (an image the site calls a captcha, a known
  // challenge frame), and a count of visible checkboxes. Nothing is read out of any of them.
  var ch = { img: false, frames: [] }, nchk = 0;
  try {
    var ims = document.querySelectorAll('img,canvas');
    for (var m = 0; m < ims.length; m++) {
      var im = ims[m], hay = String((im.id || '') + ' ' + (im.getAttribute('alt') || '') + ' ' + (im.getAttribute('src') || '').slice(0, 200) + ' ' + (typeof im.className === 'string' ? im.className : '')).toLowerCase();
      var ir = im.getBoundingClientRect();
      if (ir.width >= 40 && ir.height >= 20 && /captcha|characters|puzzle/.test(hay)) { ch.img = true; break; }
    }
    var fs = document.querySelectorAll('iframe');
    for (var n = 0; n < fs.length && ch.frames.length < 4; n++) {
      var fh = String((fs[n].getAttribute('src') || '').slice(0, 300) + ' ' + (fs[n].title || '') + ' ' + (fs[n].id || '')).toLowerCase();
      var nm = /recaptcha/.test(fh) ? 'recaptcha' : /hcaptcha/.test(fh) ? 'hcaptcha' : /arkose|funcaptcha/.test(fh) ? 'arkose' : /turnstile|challenges\\.cloudflare/.test(fh) ? 'turnstile' : /captcha|puzzle|challenge/.test(fh) ? 'puzzle frame' : '';
      if (nm && ch.frames.indexOf(nm) < 0) ch.frames.push(nm);
    }
    var cbs = document.querySelectorAll('input[type="checkbox"]');
    for (var c = 0; c < cbs.length; c++) { var cr = cbs[c].getBoundingClientRect(); if (cr.width > 0 && cr.height > 0 && cr.bottom > 0 && cr.top < H) nchk++; }
  } catch (e) {}
  var doc = 0; try { doc = Math.round(performance.timeOrigin || 0); } catch (e) {}
  return { fields: out, buttons: bl, acct: acct, alerts: al, doc: doc, challenge: ch, checks: nchk, title: String(document.title || '').slice(0, 120), url: String(location.href), text: String(document.body ? document.body.innerText : '').slice(0, 4000) };
})()`;

/**
 * Which kind of box this is, from what the site says about it.
 *
 * Pure, and exported, because the hints the phone is given hang entirely off this answer and a
 * wrong answer is the difference between the keyboard offering a saved login and offering nothing.
 * Order matters: a password is a password whatever else it is called, and a verification code is
 * checked before "email" so that "email code" is read as a code.
 */
export function fieldKind(f = {}) {
  const hay = `${f.ac ?? ""} ${f.name ?? ""} ${f.id ?? ""} ${f.label ?? ""}`.toLowerCase();
  const type = String(f.type ?? "").toLowerCase();
  if (type === "password" || /password|passwd|\bpwd\b/.test(hay)) return "password";
  // The box beside a picture check ("Type characters", Amazon's `guess`): its own kind, never a sign-in box.
  if (/captcha|\bguess\b|characters/.test(hay)) return "captcha";
  if (/one-time-code|onetime|one time code|\botp\b|otpcode|otp-code|otp_code|verification code|security code|\bpasscode\b|\bpin\b|sms code|email code|\bcode\b/.test(hay)) return "otp";
  // A short numbers-only box is a code too, whatever it is called. Amazon's is `maxlength=6`.
  if ((type === "tel" || type === "number" || f.im === "numeric") && f.ml > 0 && f.ml <= 8) return "otp";
  if (type === "email" || /\be-?mail\b/.test(hay)) return "email";
  if (type === "tel" || /\bphone\b|\bmobile\b|\btel\b/.test(hay)) return "tel";
  if (/username|user name|\buserid\b|\buser id\b|\blogin\b|sign.?in/.test(hay)) return "username";
  if (type === "number" || f.im === "numeric") return "number";
  if (type === "search" || f.im === "search") return "search";
  return "text";
}

// ---------------------------------------------------------------- what kind of page this is
/**
 * The four things a page in a sign-in can be, as the step log names them, plus two that are not a
 * verdict yet ("loading": nothing drawn; "signed_in": the page's own words say so).
 */
export const PAGE_KINDS = ["signin_form", "challenge", "provider_prompt", "not_signin"];
/** The kinds that are a real step for the person: something to fill in, pass, or answer. */
export const isStep = (kind) => kind === "signin_form" || kind === "challenge" || kind === "provider_prompt";

const SIGNIN_KINDS = new Set(["email", "username", "tel", "password", "otp"]);
/** A box that takes an address for a mailing list is not a sign-in box, whatever its type. */
const NOT_A_LOGIN_BOX = /newsletter|subscribe|subscription|mailing list|waitlist|wait list|get updates|stay in the loop|stay up to date/i;
const signinBox = (f) => SIGNIN_KINDS.has(fieldKind(f)) && !NOT_A_LOGIN_BOX.test(`${f?.name ?? ""} ${f?.id ?? ""} ${f?.label ?? ""}`);
/** Words that are a challenge wherever they stand; the weaker ones (a footer's "protected by reCAPTCHA") only on a short page. */
const STRONG_CHALLENGE = /performing security verification|verif(y|ies|ying) (that )?you(?:'re| are) (?:not a (?:ro)?bot|(?:a )?human)|i'?m not a robot|are you a (human|robot)|press (?:and|&) hold|select all (?:images|squares)|unusual traffic|attention required|checking your browser|checking if the site connection is secure|request blocked|access denied|the request could not be satisfied|complete the (captcha|security check)/i;
const SHORT_PAGE = 1500;
const STEP_TO_KIND = {
  refused: "provider_prompt", consent: "provider_prompt", number_match: "provider_prompt", phone_tap: "provider_prompt", account: "provider_prompt",
  chooser: "signin_form", email: "signin_form", password: "signin_form", code: "signin_form", password_code: "signin_form", signed_in: "signed_in",
  approve: "provider_prompt",
};

/**
 * What a page is, read off its address, its words and the shape of its form (FRAME_JS's reading).
 * Pure. A marketing or home page is "not_signin": it has no sign-in box, no challenge and no
 * provider prompt, and it is never a step for the person however much is on it.
 *
 * `midFlow`: a sign-in step was already seen in this session. Then any box to type in is a step
 * ("What's your workspace called?"), where on an opening page a search box or a sign-up field is not.
 * `framed`: boxes read out of the page's own same-origin frames; they count like the page's.
 *   → "loading" | "signin_form" | "challenge" | "provider_prompt" | "signed_in" | "not_signin"
 */
export function pageKind(raw = {}, { provider = "", midFlow = false, framed = [] } = {}) {
  const fields = [...(Array.isArray(raw?.fields) ? raw.fields : []), ...(Array.isArray(framed) ? framed : [])];
  const text = String(raw?.text ?? "");
  if (!raw?.url || /^about:blank/.test(String(raw.url)) || (text.trim().length < 10 && !fields.length)) return "loading";
  const boxes = fields.filter(signinBox);
  // Only real sign-in boxes are shown to stepOf: a newsletter box must not read as the email step.
  const st = social.stepOf(raw, { provider, fields: boxes.map(f => ({ k: fieldKind(f) })) });
  if (st.step === "captcha") {
    if (boxes.length) return "signin_form";
    return STRONG_CHALLENGE.test(text) || text.trim().length <= SHORT_PAGE ? "challenge" : "not_signin";
  }
  if (STEP_TO_KIND[st.step]) return STEP_TO_KIND[st.step];
  if (boxes.length) return "signin_form";
  if (STRONG_CHALLENGE.test(text) && text.trim().length <= SHORT_PAGE) return "challenge";
  if (midFlow && fields.some(f => { const k = fieldKind(f); return k === "text" || k === "number"; })) return "signin_form";
  return "not_signin";
}

/** A path that names itself a sign-in page: /login, /us/login, /signin, /account/sign-in, /auth/login. */
export const SIGNIN_PATH = /(^|\/)(log-?in|sign-?in|sign_in|log_in|signin|login)(\/|\.|$)/i;

/**
 * The sign-in form a SAVED login may be typed into, read off one page's own boxes (never a frame's: the
 * filler types only into the page's own frame). Pure. Stricter than pageKind, which counts any email
 * box as a sign-in form: on 2026-11-13 Netflix's home page, whose one box is "enter your email to create
 * or restart your membership", was pinned as its sign-in page and the filler found no password box.
 *   "password"     one real password box (not a "new-password" one: that is making an account), the
 *                  username/email box beside it optional.
 *   "email_first"  exactly one email/username box and no other sign-in box, on a page whose own path
 *                  says it is a sign-in page (never the front page: a sign-up box lives there).
 *   null           anything else, a page with two password boxes included (making or changing one).
 */
const NEW_PASSWORD = /\bnew\b|new_?pass|newpass|confirm|re-?type|re-?enter|repeat|again|verify|choose (a |your )?password|create (a |your )?password|set (a |your )?password/i;
export function loginFormOf(raw = {}) {
  const fields = Array.isArray(raw?.fields) ? raw.fields : [];
  const pw = fields.filter(f => String(f?.type ?? "").toLowerCase() === "password");
  // A lone box the site calls a new, confirm or repeat password is making or changing one: never the sign-in box.
  if (pw.length === 1) return /new-password/i.test(String(pw[0].ac ?? "")) || NEW_PASSWORD.test(`${pw[0].name ?? ""} ${pw[0].id ?? ""} ${pw[0].label ?? ""}`) ? null : "password";
  if (pw.length) return null;
  const boxes = fields.filter(signinBox);
  const ids = boxes.filter(f => { const k = fieldKind(f); return k === "email" || k === "username"; });
  if (ids.length !== 1 || boxes.length !== 1) return null;
  let p = "";
  try { p = new URL(String(raw?.url ?? "")).pathname; } catch { p = ""; }
  return p && p !== "/" && SIGNIN_PATH.test(p) ? "email_first" : null;
}

const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return ""; } };
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ""; } };
const EMPTY = { fields: [], buttons: [], acct: "", url: "", text: "" };

/**
 * One reading of a live page: FRAME_JS on the page, and on each of its SAME-ORIGIN frames (a form
 * the site draws inside its own iframe is still its form; another origin's frame is never read).
 * The frames' boxes go into the kind only: their positions are their own frame's, so they are not
 * handed to the phone as if they were the page's.
 *   → { raw, kind, framed }
 */
export async function readPage(page, { provider = "", midFlow = false } = {}) {
  let raw = EMPTY;
  // A reader that answers with words alone (a page with no document to shape) is those words and nothing else.
  try {
    const r = await page.evaluate(FRAME_JS);
    raw = r && typeof r === "object" ? r : typeof r === "string" ? { ...EMPTY, text: r, url: (() => { try { return String(page.url?.() ?? ""); } catch { return ""; } })() } : EMPTY;
  } catch { raw = EMPTY; }
  const framed = [];
  try {
    const main = page.mainFrame?.();
    const origin = originOf(typeof page.url === "function" ? page.url() : raw.url);
    for (const f of (typeof page.frames === "function" ? page.frames() : [])) {
      if (f === main || !origin || originOf(f.url()) !== origin) continue;
      const r = await f.evaluate(FRAME_JS).catch(() => null);
      for (const x of r?.fields ?? []) framed.push(x);
    }
  } catch { /* a frame that went away mid-read says nothing */ }
  return { raw, framed, kind: pageKind(raw, { provider, midFlow, framed }) };
}

/** How long a page is looked at before its own "Log in" link is tried, when it shows no sign-in form. */
export const FIRST_LOOK_MS = 2_500;
/** How long a page is given to draw its sign-in form before anything concludes it has none. */
export const formWaitMs = () => Math.max(0, Number(config.signinFormWaitMs) || 0);
const sleepOn = (page, ms) => (page?.waitForTimeout ? page.waitForTimeout(ms).catch(() => {}) : new Promise(r => setTimeout(r, ms)));

/**
 * Ask `look()` again and again until it answers something truthy or `waitMs` runs out: for a form
 * the page draws late with its own script. Stops the moment it is found; never longer than the bound
 * (plus one look). The clock is the wall clock, not the service's (which a test may hold still).
 *   → { found, value, ms, looks }
 */
export async function waitFor(page, look, { waitMs = formWaitMs(), pollMs = 250, now = () => Date.now(), stop = null } = {}) {
  const started = now();
  let looks = 0, value = null, slept = 0;
  for (;;) {
    looks += 1;
    try { value = await look(); } catch { value = null; }
    // Time passed is the wall clock's, or the sleeps asked for when those are longer: a page whose
    // sleep is not real (a test's stand-in) still reaches the bound instead of spinning to it.
    const ms = Math.max(0, now() - started, slept);
    if (value) return { found: true, value, ms, looks };
    if (ms >= waitMs) return { found: false, value: null, ms, looks };
    // A clear negative ends the wait before the bound (`stop`, usually settleWatch below): a page
    // that has finished drawing itself and still has no form is not going to grow one.
    if (stop) {
      let over = false;
      try { over = !!(await stop()); } catch { over = false; }
      if (over) return { found: false, value: null, ms: Math.max(0, now() - started, slept), looks, settled: true };
    }
    const nap = Math.max(1, Math.min(pollMs, waitMs - ms));
    await sleepOn(page, nap);
    slept += nap;
  }
}

/** How long a finished page must stand unchanged, with nothing being fetched, before "it has no form" is believed. */
export const QUIET_MS = 2_000;
/** What a page looks like from one moment to the next: its address, how much is in it, and whether it has finished loading. Never its words. */
const SETTLE_JS = `(() => {
  var t = document.body ? String(document.body.innerText || '') : '';
  return { ready: document.readyState, drawn: t.replace(/\\s+/g, ' ').trim().length >= 50, sig: location.href + '|' + document.getElementsByTagName('*').length + '|' + t.length };
})()`;

/**
 * The clear negative a bounded wait may stop early on: has this page FINISHED and stopped changing?
 * `settled()` is true only when all of these hold: the document is complete; it has words on it;
 * nothing is being fetched (the page's network went idle, and no request since has been open in the
 * last half second); and nothing in it or in its same-origin frames has changed for `quietMs`.
 *
 * It errs one way only. An app's blank shell, a page still fetching, a page that keeps changing (a
 * carousel), or a stand-in with no document are never "settled" and get the whole bound, so a form
 * drawn late (Stripe Link's, 1.3 s in) is still waited for. What it saves is the common case: a home
 * page or a password-only page said "no email box" after about ten seconds for no reason.
 *   → { settled(): Promise<boolean>, stop() }
 */
export function settleWatch(page, { quietMs = QUIET_MS, forMs = formWaitMs(), now = () => Date.now() } = {}) {
  let open = 0, lastNet = now(), sig = null, sigAt = now();
  // The page's own "network idle" covers what was already being fetched before this watch began.
  let idle = typeof page?.waitForLoadState !== "function";
  if (!idle) { try { Promise.resolve(page.waitForLoadState("networkidle", { timeout: Math.max(1000, forMs + 2000) })).then(() => { idle = true; }, () => {}); } catch { /* never idle: the whole bound */ } }
  const began = () => { open += 1; lastNet = now(); };
  const ended = () => { open = Math.max(0, open - 1); lastNet = now(); };
  const hear = (how) => { for (const [ev, fn] of [["request", began], ["requestfinished", ended], ["requestfailed", ended]]) { try { page?.[how]?.(ev, fn); } catch { /* a page with no events */ } } };
  hear("on");
  const origin = () => { try { return originOf(page.url()); } catch { return ""; } };
  return {
    async settled() {
      let st = null;
      try { st = await page.evaluate(SETTLE_JS); } catch { st = null; }
      if (!st || typeof st !== "object" || typeof st.sig !== "string") return false;
      let all = st.sig;
      try {
        const main = page.mainFrame?.(), o = origin();
        for (const f of (typeof page.frames === "function" ? page.frames() : [])) {
          if (f === main || !o || originOf(f.url()) !== o) continue;
          const r = await f.evaluate(SETTLE_JS).catch(() => null);
          all += `#${r?.sig ?? "?"}`;
        }
      } catch { /* a frame that went away mid-read is a change */ all += "#?"; }
      const t = now();
      if (all !== sig) { sig = all; sigAt = t; return false; }
      return st.ready === "complete" && st.drawn === true && idle && open === 0 && t - lastNet >= 500 && t - sigAt >= quietMs;
    },
    stop() { hear("off"); },
  };
}

// ---------------------------------------------------------------- the site's own way to its sign-in page
/**
 * Runs in the page: the site's own "Sign in" / "Log in" control. Browser globals only — Playwright
 * serialises the function across. A control by its words first; then a link whose address is a
 * sign-in path. A provider button ("Sign in with Google") is never it. With `act` "click" it is
 * pressed (a button with no address of its own).
 *   → { label, href, shown } | null
 */
export function signinDoor(act) {
  var WORDS = /^(sign ?in|log ?in|login|sign-in|log-in|member (sign|log) ?in|customer (sign|log) ?in|(sign|log) ?in to (my|your) account)$/i;
  var PATH = /(^|\/)(log-?in|sign-?in|sign_in|log_in|signin|login)(\/|\.|$)/i;
  var NEVER = /google|apple|facebook|microsoft|github|twitter|linkedin|sso|passkey/i;
  function vis(el) { var r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; var cs = window.getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; }
  function words(el) { return String(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim(); }
  var els = Array.prototype.slice.call(document.querySelectorAll('a[href],button,[role="button"],[role="link"]'));
  var best = null, rank = 99;
  for (var i = 0; i < els.length && i < 3000; i++) {
    var el = els[i], t = words(el), href = "";
    try { href = el.tagName === "A" ? String(el.href || "") : ""; } catch (e) { href = ""; }
    if (/^(javascript:|mailto:|tel:|#)/i.test(el.getAttribute("href") || "")) href = "";
    if (t.length > 40 || NEVER.test(t)) continue;
    var shown = vis(el), byWords = WORDS.test(t), byPath = false;
    if (href) { try { byPath = PATH.test(new URL(href).pathname); } catch (e) { byPath = false; } }
    if (!byWords && !byPath) continue;
    // A control that cannot be seen and has no address cannot be followed: pressing a hidden button is not what a person does.
    if (!shown && !href) continue;
    var r = byWords ? (shown ? 0 : 2) : (shown ? 1 : 3);
    if (r < rank) { rank = r; best = { el: el, label: t.slice(0, 40), href: href, shown: shown }; }
  }
  if (!best) return null;
  if (act === "click") { try { best.el.click(); } catch (e) { return null; } }
  return { label: best.label, href: best.href, shown: best.shown };
}

/** The hosts that ARE the site: an entry's own list, else its name when that is a domain. */
export function siteHosts(entry) {
  const hosts = Array.isArray(entry?.hosts) && entry.hosts.length ? entry.hosts : [entry?.site];
  return hosts.map(h => String(h ?? "").toLowerCase().replace(/^www\./, "")).filter(h => h.includes("."));
}
export function onSite(url, entry) {
  const h = hostOf(url).replace(/^www\./, "");
  return !!h && siteHosts(entry).some(a => h === a || h.endsWith(`.${a}`));
}

/** The last two labels of a host, or three under a two-letter country's second level (bbc.co.uk). */
function registrableHost(host) {
  const parts = String(host ?? "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return /^(co|com|org|net|ac|gov|edu|ne|or)$/.test(parts.at(-2)) && parts.at(-1).length === 2 ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}
/**
 * Hosts where every sub-host is somebody else's site (shared hosting). The two-label rule above calls
 * the shared part "the site" there, so a "Log in" link is only ever followed on one of these when it
 * stays on the very host the browser is on.
 */
const SHARED_HOSTING = /(?:^|\.)(?:github\.io|gitlab\.io|herokuapp\.com|vercel\.app|netlify\.app|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|appspot\.com|blogspot\.com|azurewebsites\.net|cloudfront\.net|amazonaws\.com|onrender\.com|fly\.dev|glitch\.me|replit\.app|wixsite\.com|webflow\.io)$/;
/** A page's address with nothing personal on it: origin + path. No query string, no fragment; https only. */
export function pageOf(url) {
  let u; try { u = new URL(String(url ?? "")); } catch { return ""; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return "";
  return `${u.origin}${u.pathname || "/"}`.slice(0, 300);
}
/** Is this address only the site's front door (no path)? */
export function isFrontPage(url) {
  try { const p = new URL(String(url)).pathname; return !p || p === "/"; } catch { return true; }
}
/** Has the browser left the page the sign-in was on (another path, or another host of the site)? */
export function leftSigninPage(url, entry) {
  const at = pageOf(url), home = pageOf(entry?.signin_url);
  // A front page is not a sign-in path: being somewhere else than it proves nothing.
  if (!at || !home || isFrontPage(home)) return false;
  if (hostOf(at) !== hostOf(home)) return true;
  const path = (u) => new URL(u).pathname.replace(/\/+$/, "").toLowerCase();
  const a = path(at), h = path(home);
  return a !== h && !a.startsWith(`${h}/`);
}

/**
 * Go through the site's own "Sign in" / "Log in" link, ONCE: by its address when it has one (only
 * ever https, on the site's own hosts), else by pressing it. Nothing else is pressed. The caller
 * reads the page afterwards; this only says whether anything was followed.
 *   → { followed, by: "link"|"button"|"", why }
 */
export async function followSigninDoor(page, entry, { timeoutMs = 30_000, allowCurrentSite = false } = {}) {
  let door = null;
  try { door = await page.evaluate(signinDoor, ""); } catch { door = null; }
  if (!door) return { followed: false, by: "", why: "the page has no sign-in link" };
  if (door.href) {
    const to = pageOf(door.href) ? door.href : "";
    // `allowCurrentSite`: the site sent the browser to a sibling domain of its own (notion.so opens
    // on notion.com), and its sign-in link stays on that domain. Followed only where a person is
    // about to look at the page and type for themselves; never where Reason types an address in.
    const sameAsHere = allowCurrentSite && (() => { try { const here = registrableHost(hostOf(page.url())); return !!here && registrableHost(hostOf(to)) === here; } catch { return false; } })();
    // On shared hosting another sub-host is another site: only the very host the browser is on.
    const sharedAway = SHARED_HOSTING.test(hostOf(to)) && (() => { try { return hostOf(to) !== hostOf(page.url()); } catch { return true; } })();
    if (to && !sharedAway && (onSite(to, entry) || sameAsHere)) {
      let ok = true;
      try { await page.goto(to, { waitUntil: "domcontentloaded", timeout: timeoutMs }); } catch { ok = false; }
      return ok ? { followed: true, by: "link", why: "" } : { followed: false, by: "", why: "its sign-in link did not load" };
    }
    // An address off the site (or not https) is never opened for them, by its address or by a press.
    return { followed: false, by: "", why: "its sign-in link leads off the site" };
  }
  if (!door.shown) return { followed: false, by: "", why: "the page has no sign-in link in view" };
  let pressed = null;
  try { pressed = await page.evaluate(signinDoor, "click"); } catch { pressed = null; }
  return pressed ? { followed: true, by: "button", why: "" } : { followed: false, by: "", why: "its sign-in button could not be pressed" };
}

/**
 * Get a page onto the site's sign-in form: wait (bounded) for a real step to be drawn; when the
 * page that opened is not a sign-in page, go through the site's own sign-in link once and wait
 * again. Used wherever a sign-in opens before a person is shown anything.
 *   → { kind, raw, framed, followed, ms, page: origin+path where it ended up }
 */
export async function arriveAtSignin(page, entry, { provider = "", waitMs = formWaitMs(), pollMs = 250, follow = true, allowCurrentSite = false, now = () => Date.now() } = {}) {
  const started = now();
  const look = async () => { const r = await readPage(page, { provider }); return isStep(r.kind) || r.kind === "signed_in" ? r : null; };
  // Every wait below stops early on a clear negative (settleWatch): a page that has finished and
  // stopped changing without a form is not given the rest of the bound to grow one.
  let watch = settleWatch(page, { forMs: waitMs, now });
  const stop = () => watch.settled();
  // A page with a "Log in" link on it rarely also draws a sign-in form late: the link is looked for
  // after a short first wait, and only a page with no link gets the whole bound to draw a form.
  const first = Math.min(waitMs, FIRST_LOOK_MS);
  let got, followed = false, why = "";
  try {
    got = await waitFor(page, look, { waitMs: first, pollMs, now, stop });
    if (!got.found && follow) {
      let door = await followSigninDoor(page, entry, { allowCurrentSite });
      if (!door.followed && waitMs > first && !got.settled) {
        got = await waitFor(page, look, { waitMs: waitMs - first, pollMs, now, stop });
        if (!got.found) door = await followSigninDoor(page, entry, { allowCurrentSite });
      }
      followed = door.followed; why = door.why;
      if (!got.found && followed) {
        // Another page now: what was learned about the last one says nothing about this one.
        watch.stop();
        watch = settleWatch(page, { forMs: waitMs, now });
        got = await waitFor(page, look, { waitMs, pollMs, now, stop });
      }
    } else if (!got.found && waitMs > first && !got.settled) {
      got = await waitFor(page, look, { waitMs: waitMs - first, pollMs, now, stop });
    }
  } finally { watch.stop(); }
  const last = got.found ? got.value : await readPage(page, { provider });
  let at = "";
  try { at = pageOf(typeof page.url === "function" ? page.url() : last.raw.url); } catch { at = ""; }
  return { kind: last.kind, raw: last.raw, framed: last.framed, followed, why, ms: Math.max(0, now() - started), page: at || pageOf(last.raw.url) };
}

// ---------------------------------------------------------------- what is remembered
// One row per person and site. `page`: the sign-in page their last attempt was on, so every later
// link for it opens that page. `ended_*`: a link that ended without progress, so the next one is not
// sent on its own. In the database, not in memory: on 2026-11-12 a deploy restart fell between the
// session timing out and the note that woke the model, and a map would have forgotten both.
db.db.exec(`
  CREATE TABLE IF NOT EXISTS signin_pages (
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    page TEXT NOT NULL DEFAULT '',
    page_at INTEGER NOT NULL DEFAULT 0,
    ended_how TEXT NOT NULL DEFAULT '',
    ended_page TEXT NOT NULL DEFAULT '',
    ended_at INTEGER NOT NULL DEFAULT 0,
    retried INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, site)
  );
`);
/** How long the page of an attempt is believed. A site moves its sign-in page; a week is long enough for a retry. */
export const PAGE_KEPT_MS = 7 * 86_400_000;
/** How long an ending without progress stops another link going out on its own. */
export const NO_REPEAT_MS = 60 * 60_000;

const rowFor = (c, site) => db.db.prepare("SELECT * FROM signin_pages WHERE conversation_id = ? AND site = ?").get(String(c ?? ""), String(site ?? ""));
const touch = (c, site) => db.db.prepare("INSERT OR IGNORE INTO signin_pages (conversation_id, site) VALUES (?, ?)").run(String(c ?? ""), String(site ?? ""));

/**
 * The sign-in page this person's attempt on this site is on: origin + path only. A front page is
 * never remembered (it is what a bare name already gives), nor a page off the site's own hosts.
 */
export function rememberSigninPage(conversationId, entry, url) {
  const page = pageOf(url);
  if (!conversationId || !entry?.site || !page || isFrontPage(page) || !onSite(page, entry)) return "";
  touch(conversationId, entry.site);
  db.db.prepare("UPDATE signin_pages SET page = ?, page_at = ? WHERE conversation_id = ? AND site = ?").run(page, clock.now(), String(conversationId), String(entry.site));
  return page;
}
/** That page, while it is still fresh; "" when none is known. */
export function signinPageFor(conversationId, entry) {
  const row = rowFor(conversationId, entry?.site);
  if (!row?.page || clock.now() - Number(row.page_at) > PAGE_KEPT_MS) return "";
  return onSite(row.page, entry) ? row.page : "";
}
export function forgetSigninPage(conversationId, entry) {
  db.db.prepare("UPDATE signin_pages SET page = '', page_at = 0 WHERE conversation_id = ? AND site = ?").run(String(conversationId ?? ""), String(entry?.site ?? ""));
}

/** The endings that are "nothing happened": the person never got through, and the link is spent. */
export const NO_PROGRESS = new Set(["timed_out", "cancelled", "link_expired", "no_signin_page", "site_repeated"]);
/**
 * Write down how a link ended. Without progress: remembered, so no second identical link goes out
 * on its own. With progress (signed in): the slate is wiped.
 *
 * `page`: the page the link was made for. `seen`: the page its sign-in form was really shown on,
 * when that is another one (a link that opened a home page and went through the site's own "Log in"
 * link). Both are kept, in one column with a space between (an address never has a bare space): a
 * next link to either of them is the same page again.
 */
export function noteEnding(conversationId, entry, { how = "", state = "", page = "", seen = "" } = {}) {
  if (!conversationId || !entry?.site) return;
  touch(conversationId, entry.site);
  if (state === "signed_in" || !NO_PROGRESS.has(String(how))) {
    db.db.prepare("UPDATE signin_pages SET ended_how = '', ended_page = '', ended_at = 0, retried = 0 WHERE conversation_id = ? AND site = ?").run(String(conversationId), String(entry.site));
    return;
  }
  // The one retry is counted per run of endings: an ending with none before it inside the hour starts
  // the count over, so a retry taken last week does not use up this week's.
  const before = rowFor(conversationId, entry.site);
  const fresh = !before?.ended_how || clock.now() - Number(before.ended_at) > NO_REPEAT_MS;
  db.db.prepare("UPDATE signin_pages SET ended_how = ?, ended_page = ?, ended_at = ?, retried = ? WHERE conversation_id = ? AND site = ?")
    .run(String(how), [...new Set([pageOf(page || entry.signin_url), pageOf(seen)].filter(Boolean))].join(" "), clock.now(), fresh ? 0 : Number(before.retried) ? 1 : 0, String(conversationId), String(entry.site));
}
/** The last link for this site that ended without progress, while that is still recent. */
export function lastNoProgress(conversationId, entry) {
  const row = rowFor(conversationId, entry?.site);
  if (!row?.ended_how || clock.now() - Number(row.ended_at) > NO_REPEAT_MS) return null;
  const pages = String(row.ended_page ?? "").split(" ").filter(Boolean);
  return { how: row.ended_how, page: pages[0] ?? "", pages, at: Number(row.ended_at), retried: !!row.retried, minutes_ago: Math.round((clock.now() - Number(row.ended_at)) / 60_000) };
}
/** A link the person asked for themselves starts the count over; the one retry Reason takes itself is counted. */
export function clearNoProgress(conversationId, entry) {
  db.db.prepare("UPDATE signin_pages SET ended_how = '', ended_page = '', ended_at = 0, retried = 0 WHERE conversation_id = ? AND site = ?").run(String(conversationId ?? ""), String(entry?.site ?? ""));
}
export function markRetried(conversationId, entry) {
  db.db.prepare("UPDATE signin_pages SET retried = 1 WHERE conversation_id = ? AND site = ?").run(String(conversationId ?? ""), String(entry?.site ?? ""));
}

/**
 * May a link for this page go out now WITHOUT the person having just asked for one? After a link
 * ended without progress: never an identical one, and at most one more when something changed (the
 * link would open a different page, the right one). `asked`: this turn is the person's own message.
 *   → { ok: true, retry?: true } | { ok: false, last }
 */
export function mayLinkAgain(conversationId, entry, { asked = false } = {}) {
  const last = lastNoProgress(conversationId, entry);
  if (!last) return { ok: true };
  if (asked) return { ok: true, asked: true };
  // Changed: it would open a page that link neither named nor showed its sign-in on.
  const changed = last.pages.length > 0 && !last.pages.includes(pageOf(entry?.signin_url));
  if (changed && !last.retried) return { ok: true, retry: true };
  return { ok: false, last };
}
