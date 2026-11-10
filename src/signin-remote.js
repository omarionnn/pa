// Signing in from a phone: a link that shows the person Reason's browser, live, so they can sign in
// to a site themselves from wherever they are.
//
// The sign-in has to happen inside the browser Reason will later use, because that is where the
// site puts the session. That browser is on the machine Reason runs on. So instead of bringing the
// person to the machine (`signin_open`, a window on its screen), this brings the browser to the
// person: a page that shows a picture of it a few times a second, and sends back where they
// tapped and what they typed. The site sees one browser throughout, and the session it grants
// lands in that person's own saved profile.
//
// **How it is meant to feel (rebuilt 2026-10-05, after the first version was tried on a phone).**
// Open the link, see the site's sign-in page, tap the box, the phone's own keyboard comes up right
// there, type, tap the site's own button. There is no toolbar to learn and no "type here then
// send": every tap on a text box puts a REAL native input over that exact spot, so the keyboard
// opens inside the same tap and the phone can offer what it has saved. What is typed is forwarded
// into the site's field as it is typed, so the picture shows it landing where they tapped.
//
// **What this costs, said plainly, because the owner decided it with this in front of him
// (2026-10-05).** What the person types — a password included — travels from their phone to this
// process and from this process into the site's own page. Reason relays it. So "Reason never sees
// a password" is no longer strictly true of this path, and nothing here pretends otherwise. What
// stays true, and is enforced below rather than promised:
//
//   - nothing typed is ever logged, stored, written to the database, or put in a conversation —
//     the only things kept are that a session started, that it ended, and what the SITE said;
//   - no picture of the browser is kept either: each one is sent and dropped;
//   - the model never sees any of it. No tool returns a keystroke or a screenshot, so there is
//     nothing for a prompt to ask for;
//   - no field's CONTENTS ever travel back. What the page is told about the site's fields is where
//     they are, what kind they are, their own label, and how many characters are in them — never a
//     character of what is in them. A password field is no different from any other in this: the
//     direction is one way;
//   - a password offered in a MESSAGE is still refused. That one is in the messaging app and the
//     transcript for good, which is a different thing from a relay that forgets.
//
// **Who can use a link.** The person themselves, first to tap Start, and nobody after: Start hands
// that browser a cookie and every later request needs it. Holding the link is not enough to tap
// Start (security audit lead 6, 2026-11-07): the browser must be one already signed in to Reason as
// this person (Web, or a connect/sign-in link's code, src/connectgate.js), or prove itself once with
// a code texted to their own thread, after which it is remembered — so a forwarded or misdirected
// link cannot open their saved profile. A link preview fetches the page but does not
// tap anything, so previews cannot take the session. A link is good for a few minutes, a session
// for a few more, and making a new link kills the old one.
//
// **What it cannot do.** Face ID, a passkey or a security key belong to the device doing the
// signing in, and that device is the machine, not the phone — so those will not work here and the
// page says so. A password, a code by text or email, and "is this you" taps all do.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import * as db from "./db.js";
import * as signin from "./signin.js";
import { readSignedInState } from "./sites.js";
import { profileDirFor } from "./browser.js";
import { issueCode, trySubmittedCode, cookieHeader, codeHost, boundTo, CODE_TTL_MS, ATTEMPT_WINDOW_MS, MAX_CODES_SENT } from "./pages/access.js";
import { browserConversation, proofPage } from "./connectgate.js";
import { config, clock } from "./config.js";
import { backToReason, dark, THEME, iconLinks } from "./pages/render.js";
import { securedCardTags } from "./pages/securedcard.js";
import * as setupPages from "./pages/setupsignin.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { BRAND_PEN, BRAND_PEN_DARK, PAPER, PAPER_GRAIN } from "./pages/brand.js";

/** The picture the person sees. A phone held upright, at a size a desktop sign-in form fits in. */
export const VIEW = { width: 430, height: 700 };
export const PATH = "/s";
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const MAX_TYPED = 500;
const MAX_DEL = 500;
/** How many of the site's fields the page is told about. A sign-in form has one or two. */
const MAX_FIELDS = 12;
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
/** Two readings in a row before the session finishes itself, so one odd frame cannot end it. */
const SIGNED_IN_RUN = 2;
/** Nothing finishes itself in the first few seconds, when the site's own page is still settling. */
const EARLIEST_AUTO_FINISH_MS = 8_000;

/** token → session. In memory on purpose: a restart ends every session, which is the safe way to fail. */
const sessions = new Map();
/** conversationId → token, so one person has one link and a new one replaces the old. */
const byConversation = new Map();

const newToken = () => randomBytes(24).toString("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** The real browser: the person's own saved profile, headless, at the size the page shows. */
async function realLaunch({ conversationId, url }) {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(profileDirFor(conversationId), {
    headless: true, viewport: VIEW, deviceScaleFactor: 2,
    // No launch flag that hides automation from the site (removed 2026-10-23): see src/browser.js.
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.browserTimeoutMs);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  return { page, close: () => context.close().catch(() => {}) };
}

export function remoteSigninStatus() {
  // The link a person taps lives on the website (heyreason.com/s/* is proxied to this server), else
  // the files domain, never the server's own address when either is set (owner rule, 2026-11-01).
  const base = (config.siteUrl || config.pagesUrl || config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
  return {
    reachable_from_a_phone: !!config.publicUrl,
    base,
    ...(config.publicUrl ? {} : { why: `REASON_PUBLIC_URL is not set, so the link is ${base}/… and only opens on the machine Reason runs on.` }),
  };
}

/** Is a remote sign-in in progress for this person? Their saved profile is busy while one is. */
export function remoteSessionFor(conversationId) {
  const s = sessions.get(byConversation.get(conversationId));
  return s && !s.ended ? { site: s.entry.site, started: !!s.browser } : null;
}

/**
 * Make a link. Nothing is launched yet: the browser starts when somebody taps Start, so a link
 * nobody opens never holds the saved profile.
 */
export function createRemoteSignin({ conversationId, entry, afterSignedIn = "", onEnd = null, setupBack = "", launch = realLaunch, check = signin.checkAndRecord, closeBrowser = async () => {}, busy = () => null, timers = { set: setTimeout, clear: clearTimeout }, log = () => {} }) {
  const old = sessions.get(byConversation.get(conversationId));
  if (old) end(old, "replaced").catch(() => {});

  const token = newToken();
  const s = {
    // setupBack: a web setup's sign-in (src/websetup.js) is drawn in the paper store sign-in look and ends back on the setup.
    setupBack: String(conversationId ?? "").startsWith("websetup:") ? String(setupBack ?? "") : "",
    token, conversationId, entry, afterSignedIn, onEnd, launch, check, closeBrowser, busy, timers, log,
    createdAt: clock.now(), secret: null, browser: null, queue: Promise.resolve(),
    ended: null, startedAt: null, timer: null, signedInRun: 0,
  };
  sessions.set(token, s);
  byConversation.set(conversationId, token);
  // Unopened, it is good for linkTtl. Once started, the session clock replaces this one.
  s.timer = timers.set(() => { end(s, "link_expired").catch(() => {}); }, config.remoteSigninLinkTtlMs);
  s.timer?.unref?.();
  const st = remoteSigninStatus();
  log({ signin_remote: "link", site: entry.site, conversation: conversationId });
  return {
    ok: true, url: `${st.base}${PATH}/${token}`, site: entry.site,
    good_for_minutes: Math.round(config.remoteSigninLinkTtlMs / 60_000),
    reachable_from_a_phone: st.reachable_from_a_phone, ...(st.why ? { why: st.why } : {}),
  };
}

/** One thing at a time per browser: a tap and a screenshot racing each other is how a click lands on the wrong page. */
function inTurn(s, fn) {
  const run = s.queue.then(fn, fn);
  s.queue = run.catch(() => {});
  return run;
}

/**
 * End a session, whichever way it ends, and say what the SITE says.
 *
 * The check runs on every ending that had a browser — done, the site looking signed in, time
 * running out, a replacement — because a person who signed in and then put their phone down did
 * sign in, and the truth about that is on the site's account page, not in which button they
 * pressed or in what a screenshot looked like.
 */
async function end(s, how) {
  if (s.ended) return s.ended;
  s.ended = { how, state: null, why: "", at: clock.now() };
  s.timers.clear(s.timer);
  const { conversationId: c, entry } = s;
  let note;
  if (s.browser && how === "blocked") {
    // The site never showed its sign-in page: a bot check or a CDN refusal sat where the form
    // should have been. Asking the account page now would only say "signed out", which is true and
    // beside the point — the news is that this route does not reach this site from here.
    s.ended.state = "blocked";
    s.ended.why = `${entry.label} stopped Reason's browser with a bot check before its sign-in page loaded`;
    await s.browser.close();
    s.browser = null;
    note = `the ${entry.label} sign-in link you sent never got past ${entry.label}'s bot check: ${entry.label} blocks Reason's browser from its sign-in page, so nothing could be typed and nothing was saved, and a fresh link would hit the same wall. Say that plainly in one short line — it is ${entry.label}'s choice, not something they did — and offer what works instead${entry.deep_link ? ` (for a ride, uber_link opens Uber on their phone with the destination filled in)` : ""}.`;
  } else if (s.browser) {
    try {
      const out = await inTurn(s, () => s.check(s.browser.page, c, entry.site));
      s.ended.state = out?.ok === false ? "unknown" : out.state;
      s.ended.why = out?.why ?? out?.error ?? "";
    } catch (e) {
      s.ended.state = "unknown";
      s.ended.why = (e?.message ?? String(e)).split("\n")[0];
    }
    await s.browser.close();
    s.browser = null;
    const tail = how === "done" || how === "finished" ? ""
      : how === "cancelled" ? " (they closed it without finishing)"
        : how === "replaced" ? " (a newer link replaced that one)"
          : " (the link timed out before they finished)";
    note = s.ended.state === "signed_in"
      ? `they finished signing in to ${entry.label} through the link you sent${tail}, and ${entry.label} says they ARE signed in now (${s.ended.why}). ${s.afterSignedIn ? s.afterSignedIn : `Tell them in one short line that it worked, and pick up whatever they wanted ${entry.label} for.`}`
      : s.ended.state === "signed_out"
        ? `the ${entry.label} sign-in through the link you sent has ended${tail}, and ${entry.label} says they are still NOT signed in (${s.ended.why}). Say that plainly in one short line and offer a fresh link.`
        : `the ${entry.label} sign-in through the link you sent has ended${tail}, but whether they are signed in could not be read (${s.ended.why}). Nothing is recorded either way. Say that in one short line; signin_status with recheck asks the site again.`;
  } else if (how === "link_expired") {
    note = `the ${entry.label} sign-in link you sent was never opened and has expired. Do not chase them about it; if they bring it up, offer a fresh one.`;
  }
  s.log({ signin_remote: "ended", how, site: entry.site, conversation: c, state: s.ended.state });
  // Only news is worth a message. A link that was replaced unopened, or that simply lapsed, is not.
  // A web setup's sign-in (src/websetup.js) has no thread to wake: how it ended goes on the setup.
  if (s.onEnd) { try { s.onEnd(s.ended); } catch { /* the page reads the site's own check anyway */ } }
  else if (note && how !== "link_expired") db.createTimer(c, { fireAt: clock.now(), note });
  if (byConversation.get(c) === s.token) byConversation.delete(c);
  // Kept a little while so the page can show the result, then forgotten.
  const t = s.timers.set(() => sessions.delete(s.token), 10 * 60_000);
  t?.unref?.();
  return s.ended;
}

// ---------- reading the site's own page ----------

/**
 * What the page needs to know about the site's form, read out of the site's own document.
 *
 * Where each box is, what kind it is, what the site calls it, and how many characters are in it.
 * Never a character OF it: `len` is a count, and there is no field anywhere in this object that
 * carries a value. That is what makes it safe to hand to the phone every second.
 */
const FRAME_JS = `(() => {
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
  return { fields: out, url: String(location.href), text: String(document.body ? document.body.innerText : '').slice(0, 4000) };
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
  if (/one-time-code|onetime|one time code|\botp\b|verification code|security code|\bpasscode\b|\bpin\b|sms code|email code|\bcode\b/.test(hay)) return "otp";
  // A short numbers-only box is a code too, whatever it is called. Amazon's is `maxlength=6`.
  if ((type === "tel" || type === "number" || f.im === "numeric") && f.ml > 0 && f.ml <= 8) return "otp";
  if (type === "email" || /\be-?mail\b/.test(hay)) return "email";
  if (type === "tel" || /\bphone\b|\bmobile\b|\btel\b/.test(hay)) return "tel";
  if (/username|user name|\buserid\b|\buser id\b|\blogin\b|sign.?in/.test(hay)) return "username";
  if (type === "number" || f.im === "numeric") return "number";
  if (type === "search" || f.im === "search") return "search";
  return "text";
}

/**
 * The hints the native box over that field is given.
 *
 * This is the whole reason the rebuild exists. A phone offers a saved login, or a code out of
 * Messages, only when the box it is looking at asks for one by name; the first version put
 * `autocomplete="off"` on a single password box, which told the phone to offer nothing at all.
 *
 * `type` is "text" rather than "email" or "tel" for the name boxes on purpose: Amazon's one box
 * takes a mobile number OR an email, and a `type="email"` box would refuse the number. The
 * keyboard is chosen with `inputmode`, which changes the keys without adding a rule.
 */
export function hintsFor(kind) {
  switch (kind) {
    case "password": return { slot: "p", type: "password", autocomplete: "current-password", inputmode: "", enterkeyhint: "go", autocapitalize: "off" };
    case "otp": return { slot: "o", type: "text", autocomplete: "one-time-code", inputmode: "numeric", enterkeyhint: "go", autocapitalize: "off" };
    case "email": return { slot: "u", type: "text", autocomplete: "username", inputmode: "email", enterkeyhint: "next", autocapitalize: "off" };
    case "tel": return { slot: "u", type: "text", autocomplete: "username", inputmode: "tel", enterkeyhint: "next", autocapitalize: "off" };
    case "username": return { slot: "u", type: "text", autocomplete: "username", inputmode: "text", enterkeyhint: "next", autocapitalize: "off" };
    case "number": return { slot: "g", type: "text", autocomplete: "off", inputmode: "numeric", enterkeyhint: "next", autocapitalize: "off" };
    case "search": return { slot: "g", type: "text", autocomplete: "off", inputmode: "search", enterkeyhint: "search", autocapitalize: "off" };
    default: return { slot: "g", type: "text", autocomplete: "on", inputmode: "text", enterkeyhint: "next", autocapitalize: "sentences" };
  }
}

/** Raw reading → what the phone is sent. Clamped, and carrying no content of any field. */
export function frameFor(raw = {}, { state = "working" } = {}) {
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, MAX_FIELDS).map(f => {
    const kind = fieldKind(f);
    const h = hintsFor(kind);
    return {
      x: round3(f.x), y: round3(f.y), w: round3(f.w), h: round3(f.h),
      k: kind, slot: h.slot, ty: h.type, ac: h.autocomplete, im: h.inputmode,
      ek: h.enterkeyhint, cap: h.autocapitalize,
      lb: String(f.label ?? "").slice(0, 60), len: Number(f.len) || 0,
      on: !!f.focused,
    };
  });
  const text = String(raw.text ?? "");
  // "There is nothing to show" is a state the page has to be able to say out loud, because the
  // first version could not and a person was left looking at a white rectangle.
  const blank = !raw.url || /^about:blank/.test(String(raw.url)) || (text.trim().length < 10 && fields.length === 0);
  return { fields, state, blank };
}
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Picture and page reading together, in one turn of the browser, so they always match. */
async function readView(s) {
  const page = s.browser.page;
  return inTurn(s, async () => {
    const shot = await page.screenshot({ type: "jpeg", quality: 58 });
    const raw = await page.evaluate(FRAME_JS).catch(() => ({ fields: [], url: "", text: "" }));
    return { shot, raw };
  });
}

/**
 * Does the site's CURRENT page look like a signed-in one? Read off what is already on screen —
 * the same rules the real check uses, but without navigating, because navigating mid-sign-in would
 * throw away the form the person is standing in.
 *
 * This only ever decides when to STOP. The claim that somebody is signed in still comes from
 * `end()` asking the site properly, on its own account page, after the browser stops being theirs.
 */
function looksSignedIn(s, raw) {
  const read = readSignedInState(s.entry, { url: raw.url, text: raw.text, status: null, error: null });
  if (read.state !== "signed_in") return false;
  // A page still showing somewhere to put a password or a name is a page mid-sign-in, whatever
  // else is written on it.
  const kinds = (raw.fields ?? []).map(fieldKind);
  return !kinds.some(k => k === "password" || k === "username" || k === "email" || k === "otp");
}

/**
 * Does the site's CURRENT page look like a wall rather than a form? Cloudflare's interstitial
 * ("Performing security verification … verifies you are not a bot"), CloudFront's refusal
 * ("Request blocked"), and the plain "Access Denied" page all read like this: a page with those
 * words on it and no box to type in. Seen for real on 2026-10-15, when the owner opened an Uber
 * link and watched the spinner. Like `looksSignedIn`, this only decides when to STOP — and it
 * waits for two readings in a row, because a challenge that clears in a second is not a wall.
 */
const WALL = [
  "performing security verification", "verify you are not a bot", "verifies you are not a bot",
  "checking your browser", "checking if the site connection is secure", "request blocked",
  "access denied", "the request could not be satisfied",
];
export function looksBlocked(raw) {
  const text = String(raw?.text ?? "").toLowerCase();
  if ((raw?.fields ?? []).length) return false;
  return WALL.some(w => text.includes(w));
}

const cookieName = (token) => `rs_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
function readCookie(headers, name) {
  for (const part of String(headers?.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// ---------- who may tap Start ----------
//
// The same proof connect links use (#358, src/connectgate.js): a browser signed in to Reason as this
// person through Web's own sign-in or a texted browser code. A right code here leaves that same
// `connect:` session on the browser (90 days, like pages), so the next sign-in link, or connect link,
// on it goes straight on. A new browser asks once; a browser that only holds the link never gets in.

/** Is this the person's own browser, proved the way connect links are? */
function provedOwner(s, headers) {
  return browserConversation(headers) === s.conversationId;
}

/** Codes and wrong guesses are counted per person, not per link, in the one table connect links use too. */
const gateFor = (s) => proofPage(s.conversationId, `${s.entry.label} sign-in`);

/** Text the person a code to their own thread, at most MAX_CODES_SENT in the window, and ask for it. */
function sendCode(s, tell) {
  if (typeof tell !== "function") {
    return { status: 403, headers: HTML(), body: shell("Open this on your own browser", `<p class="lead">This link only starts on a browser you've signed in to Reason on. Ask Reason for a fresh one.</p>`, { card: cardKind(s.entry) }) };
  }
  const page = gateFor(s);
  if (db.pageCodesIssued(page.id, ATTEMPT_WINDOW_MS) >= MAX_CODES_SENT) {
    return codePage(s, { status: 429, error: `Reason has already texted you a code. Use that one, or try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60_000)} minutes.` });
  }
  const { id, code } = issueCode(page.id);
  const mins = Math.round(CODE_TTL_MS / 60_000);
  const line = `Your Reason code is ${code}, to start the ${s.entry.label} sign-in link on that browser. Good for ${mins} minutes. If that wasn't you, ignore this — nothing was opened.${boundTo(codeHost(remoteSigninStatus().base), code)}`;
  Promise.resolve()
    .then(() => tell(s.conversationId, line, { idempotencyKey: `scode:${cookieName(s.token)}:${id}` }))
    .catch((e) => s.log({ signin_remote: "code_text_failed", site: s.entry.site, why: (e?.message ?? String(e)).split("\n")[0] }));
  s.log({ signin_remote: "code_sent", site: s.entry.site, conversation: s.conversationId });
  return codePage(s, { status: 401 });
}

/** Check a typed code. A right one proves this browser as the person's: `{ ok, cookie }` to remember it. */
function tryCode(s, typed, headers) {
  const tried = trySubmittedCode({ page: gateFor(s), code: typed });
  if (tried.ok) {
    s.log({ signin_remote: "browser_proved", site: s.entry.site, conversation: s.conversationId });
    return { ok: true, cookie: cookieHeader(tried.token, { path: "/", headers }) };
  }
  if (tried.reason === "rate_limited") {
    return { ok: false, status: 429, error: `Too many wrong codes. Try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60_000)} minutes.` };
  }
  const left = tried.tries_left;
  return { ok: false, status: 401, error: `That code is not right.${left ? ` ${left} ${left === 1 ? "try" : "tries"} left.` : ""}` };
}

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", ...extra });
const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (status, body) => ({ status, headers: JSONH, body: JSON.stringify(body) });
const gone = () => ({ status: 404, headers: HTML(), body: shell("This link is no longer good", `<p class="lead">Sign-in links work once and only for a few minutes. Ask Reason for a fresh one.</p>`) });

/**
 * One request to a sign-in link. Pulled out of the server like `pageRequest`, so the whole thing
 * is drivable without a socket and without a browser.
 *
 * A token that does not exist and a session somebody else already owns answer the same 404, so
 * the link space cannot be probed and a forwarded link tells its second reader nothing.
 */
export async function remoteRequest({ token, action = "", method = "GET", headers = {}, query = {}, readBody = async () => "", tell = null }) {
  const s = TOKEN.test(String(token ?? "")) ? sessions.get(token) : null;
  if (!s) return gone();
  const name = cookieName(s.token);
  const mine = s.secret && same(readCookie(headers, name), s.secret);

  // ---------- the page ----------
  if (method === "GET" && action === "") {
    if (s.ended) return { status: 200, headers: HTML(), body: resultPage(s) };
    if (!s.secret) return { status: 200, headers: HTML(), body: startPage(s) };
    if (!mine) return gone();
    return { status: 200, headers: HTML(), body: livePage(s) };
  }

  // ---------- Start: this browser becomes the only one that can use the link ----------
  if (method === "POST" && action === "start") {
    if (s.ended) return gone();
    if (s.secret && !mine) return gone();
    let remember = null;
    if (!s.secret) {
      // Holding the link is not enough (security audit lead 6, 2026-11-07): it opens the person's
      // whole saved profile, every site's session in it. The browser tapping Start must be the
      // person's own — a Reason session proved for this conversation — or prove the phone with a
      // code texted to their own thread, the same rule private pages and trips keep.
      if (!provedOwner(s, headers)) {
        // Only from this link's own page: a right code signs the browser in to Reason as this
        // person, and a page elsewhere posting someone's own code from a victim's browser would
        // plant that sign-in there (login CSRF), the hole #358 closed on connect links.
        // Loaded here, not at the top, for the same import-cycle reason as connectgate.js.
        const { sameOrigin } = await import("./pages/websignin.js");
        if (!sameOrigin(headers)) {
          s.log({ signin_remote: "cross_site_start", site: s.entry.site });
          return codePage(s, { status: 403, error: "This page has to be used directly. Open the link Reason texted again." });
        }
        const form = new URLSearchParams(String((await readBody()) ?? ""));
        // Another tap may have claimed or ended it while the body was read.
        if (s.secret || s.ended) return gone();
        const typed = form.get("code");
        if (typed === null || form.has("send")) return sendCode(s, tell);
        // Busy first, so a right code is not used up on a Start that cannot open anything.
        const busyNow = s.busy(s.conversationId);
        if (busyNow) return { status: 409, headers: HTML(), body: shell("Not right now", `<p class="lead">${esc(busyNow)}</p>`, { card: cardKind(s.entry) }) };
        const tried = tryCode(s, typed, headers);
        if (!tried.ok) return codePage(s, { status: tried.status, error: tried.error });
        remember = tried.cookie;
      }
      const blocked = s.busy(s.conversationId);
      if (blocked) return { status: 409, headers: HTML(), body: shell("Not right now", `<p class="lead">${esc(blocked)}</p>`, { card: cardKind(s.entry) }) };
      s.secret = newToken();
      s.startedAt = clock.now();
      s.timers.clear(s.timer);
      s.timer = s.timers.set(() => { end(s, "timed_out").catch(() => {}); }, config.remoteSigninSessionMs);
      s.timer?.unref?.();
      try {
        // The saved profile can be in one browser at a time, and this one needs it.
        await s.closeBrowser(s.conversationId);
        s.browser = await s.launch({ conversationId: s.conversationId, url: s.entry.signin_url });
      } catch (e) {
        s.log({ signin_remote: "launch_failed", site: s.entry.site, why: (e?.message ?? String(e)).split("\n")[0] });
        await end(s, "launch_failed");
        return { status: 500, headers: HTML(), body: shell("That did not start", `<p class="lead">The browser would not open. Nothing was changed. Ask Reason for a fresh link in a minute.</p>`, { card: cardKind(s.entry) }) };
      }
      s.log({ signin_remote: "started", site: s.entry.site, conversation: s.conversationId });
    }
    const secure = /^https:/i.test(config.publicUrl || "") ? "; Secure" : "";
    const session = `${name}=${s.secret}; Path=${PATH}/${s.token}; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(config.remoteSigninSessionMs / 1000)}${secure}`;
    return {
      status: 303,
      headers: {
        Location: `${PATH}/${s.token}`, "Cache-Control": "no-store",
        // A browser that just proved itself with the code is remembered too, so the next link skips it.
        "Set-Cookie": remember ? [session, remember] : session,
      },
      body: "",
    };
  }

  // Everything below drives the browser, so it is this session's own browser or nothing.
  if (!mine) return gone();
  if (s.ended) return json(410, { ended: true, state: s.ended.state });
  if (!s.browser) return json(409, { error: "not started" });
  const page = s.browser.page;

  /**
   * The picture and the shape of the site's form, in one answer.
   *
   * One request rather than two, because the thing that broke the first version was a weak
   * connection and every extra round trip on a phone is another chance to stall. The body is
   * `[4 bytes: how long the JSON is][the JSON][the JPEG]`; when the picture has not changed since
   * the one the phone already has, the JPEG part is empty and only the JSON travels.
   */
  if (method === "GET" && action === "view") {
    let got;
    try { got = await readView(s); } catch (e) {
      return json(503, { why: (e?.message ?? String(e)).split("\n")[0].slice(0, 120) });
    }
    const settled = clock.now() - (s.startedAt ?? 0) > EARLIEST_AUTO_FINISH_MS;
    // A wall is read first, because a wall also reads as "no sign-in prompt on the page" — which
    // is exactly what `looksSignedIn` infers signed-in from. Uber's bot-check page has none of
    // Uber's sign-in words on it and no box, and the first version of this called that signed in.
    const walled = looksBlocked(got.raw);
    if (!walled && looksSignedIn(s, got.raw) && settled) s.signedInRun += 1;
    else s.signedInRun = 0;
    if (s.signedInRun >= SIGNED_IN_RUN) {
      const ended = await end(s, "finished");
      return json(200, { over: true, state: ended.state });
    }
    // A wall where the form should be. Ended rather than left to spin, so the person is told the
    // truth instead of waiting on a page that will not change.
    if (walled && settled) s.blockedRun = (s.blockedRun ?? 0) + 1;
    else s.blockedRun = 0;
    if (s.blockedRun >= SIGNED_IN_RUN) {
      const ended = await end(s, "blocked");
      return json(200, { over: true, state: ended.state });
    }
    const hash = createHash("sha1").update(got.shot).digest("hex").slice(0, 16);
    const unchanged = String(query?.h ?? "") === hash;
    const meta = { ...frameFor(got.raw), h: hash, same: unchanged };
    const head = Buffer.alloc(4);
    const body = Buffer.from(JSON.stringify(meta), "utf8");
    head.writeUInt32BE(body.length, 0);
    return {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
      body: Buffer.concat(unchanged ? [head, body] : [head, body, got.shot]),
    };
  }

  if (method === "POST") {
    let input = {};
    try { input = JSON.parse((await readBody()) || "{}"); } catch { return json(400, { error: "bad json" }); }
    const settle = () => new Promise(r => setTimeout(r, config.remoteSigninSettleMs));
    /** A point on the picture is only ever a fraction of it, so there is nowhere else it can land. */
    const point = (p) => {
      const x = Number(p?.x), y = Number(p?.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
      return [Math.round(x * VIEW.width), Math.round(y * VIEW.height)];
    };

    if (action === "tap") {
      const at = point(input);
      if (!at) return json(400, { error: "tap needs x and y between 0 and 1" });
      await inTurn(s, async () => { await page.mouse.click(at[0], at[1]); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "type") {
      // The one place a password passes through. It goes to the page and nowhere else: not to the
      // log, not to the database, not onto the session object, and not back in the response.
      //
      // Three things, in this order, so that one request is one edit as the person makes it:
      //   at   — put the cursor in this box first (the same clamped fraction a tap is)
      //   all  — clear what is in the box
      //   del  — rub out this many characters
      //   text — then type this
      const at = input.at === undefined ? null : point(input.at);
      if (input.at !== undefined && !at) return json(400, { error: "at needs x and y between 0 and 1" });
      const all = input.all === true;
      const del = Math.max(0, Math.min(MAX_DEL, Math.trunc(Number(input.del) || 0)));
      const text = typeof input.text === "string" ? input.text : "";
      if (text.length > MAX_TYPED) return json(400, { error: `type needs 1 to ${MAX_TYPED} characters` });
      if (!text && !del && !all && !at) return json(400, { error: `type needs 1 to ${MAX_TYPED} characters` });
      await inTurn(s, async () => {
        if (at) await page.mouse.click(at[0], at[1]);
        if (all) { await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace"); }
        for (let i = 0; i < del; i++) await page.keyboard.press("Backspace");
        if (text) await page.keyboard.type(text);
        await settle();
      });
      return json(200, { ok: true });
    }
    if (action === "key") {
      if (!KEYS.has(input.key)) return json(400, { error: "that key is not one of the few this sends" });
      await inTurn(s, async () => { await page.keyboard.press(input.key); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "scroll") {
      const dy = Math.max(-2000, Math.min(2000, Number(input.dy) || 0));
      const dx = Math.max(-2000, Math.min(2000, Number(input.dx) || 0));
      await inTurn(s, async () => { await page.mouse.wheel(dx, dy); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "back") {
      await inTurn(s, async () => { await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "done" || action === "cancel") {
      const ended = await end(s, action === "done" ? "done" : "cancelled");
      return json(200, { ok: true, ended: true, state: ended.state });
    }
  }
  return json(404, { error: "not found" });
}

/** For tests, and for a shutdown that should not leave a browser holding somebody's profile. */
export async function endAllRemoteSignins(how = "shutdown") {
  await Promise.all([...sessions.values()].filter(s => !s.ended).map(s => end(s, how).catch(() => {})));
}
export function forgetAllRemoteSignins() { sessions.clear(); byConversation.clear(); }

// ---------- the pages ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The link card a session's pages carry: a site with its own card (Amazon: "Connect Amazon"), else the plain sign-in one. */
export const cardKind = (entry) => (entry?.site && SITE_CARDS.has(entry.site) ? entry.site : "signin");
const SITE_CARDS = new Set(["amazon"]);

export function shell(title, inner, { script = "", card = "signin" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${iconLinks()}
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="robots" content="noindex">
${securedCardTags(card)}
<title>${esc(title)}</title>
<script>${THEME.head}</script>
<style>
:root{color-scheme:light dark;--ground:${PAPER.ground};--bg:${PAPER.bg};--fg:${PAPER.ink};--mute:${PAPER.dim};--grain:${PAPER_GRAIN};--card:${PAPER.card};--line:${PAPER.line};--soft:${PAPER.soft};--go:${PAPER.ink};--gofg:${PAPER.bg};--mark:${BRAND_PEN}}
${dark([["", `--grain:none;--ground:#0b0a09;--bg:#12110f;--fg:#f3efe8;--mute:#a39c91;--card:#1b1916;--line:#2c2924;--soft:#211f1b;--go:#f3efe8;--gofg:#12110f;--mark:${BRAND_PEN_DARK}`]])}
*{box-sizing:border-box}body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:var(--grain) var(--ground);color:var(--fg)}
.bar{display:flex;align-items:center;gap:.45rem;padding:14px 16px 10px;color:var(--fg);font:500 1rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif}
${WORDMARK_CSS}
${THEME.css}
.sheet{background:var(--grain) var(--bg);border-radius:1.5rem 1.5rem 0 0;min-height:100dvh}
main{max-width:460px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:8px 0 6px}.lead{color:var(--mute);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
ul{margin:0;padding-left:18px}li{margin:6px 0}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:10px;padding:10px 12px;min-height:44px}
button.go{background:var(--go);color:var(--gofg);border-color:var(--go);width:100%;font-weight:600}
.row{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}.row>*{flex:1}
input[type=text],input[type=password]{font:inherit;width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);min-height:44px}
.small{font-size:13px;color:var(--mute)}
/* The picture. Width of the phone, the shape of the browser behind it, so nothing is stretched. */
#stage{position:relative;width:100%;aspect-ratio:${VIEW.width}/${VIEW.height};border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}
#v{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:var(--card);color:var(--mute);font-size:15px;transition:opacity .2s}
#veil.off{opacity:0;pointer-events:none}
.spin{display:inline-block;width:18px;height:18px;margin-right:9px;border:2px solid var(--line);border-top-color:var(--mute);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-4px}
@keyframes sp{to{transform:rotate(360deg)}}
/* The real native boxes that sit on top of the site's own. Made to look like the box underneath. */
#f{position:absolute;inset:0;pointer-events:none;margin:0}
#f input{position:absolute;left:-9999px;top:0;width:10px;height:10px;min-height:0;padding:0 6px;margin:0;border:0;border-radius:3px;font:inherit;background:#fff;color:#000;pointer-events:auto;opacity:0;-webkit-appearance:none;appearance:none}
#f input.at{opacity:1;outline:2px solid ${BRAND_PEN};outline-offset:-2px}
header{display:flex;align-items:center;gap:10px;margin:2px 0 8px}
header h1{flex:1;margin:0;font-size:18px}
header button{min-height:38px;padding:7px 12px;font-size:14px;flex:none}
.foot{display:flex;gap:8px;margin:10px 0 4px}.foot button{flex:1;font-size:14px;min-height:42px}
</style></head><body>
<div class="bar">${wordmark()}</div>
<div class="sheet"><main>${inner}${THEME.markup}</main></div><script>${THEME.js}</script>${script}</body></html>`;
}

function startPage(s) {
  if (s.setupBack) return setupPages.startPage({ name: s.entry.label, action: `${PATH}/${s.token}/start`, kind: cardKind(s.entry) });
  const label = esc(s.entry.label);
  return shell(`Sign in to ${s.entry.label}`, `
<h1>Sign in to ${label}</h1>
<p class="lead">This shows you Reason's own browser so you can sign in to ${label} yourself. Reason keeps the signed-in session, not your password.</p>
<div class="card"><ul>
<li>You will see ${label}'s real sign-in page. Tap a box and your keyboard comes up, the same as any site.</li>
<li>Your saved ${label} login is filed under ${label}'s own address, not this one, so it will not come up by itself — tap <b>Passwords</b> above the keyboard and pick ${label}.</li>
<li>What you type is passed straight to ${label}. It is not saved, logged, or shown to the assistant.</li>
<li>A password or a code by text works. Face ID and passkeys do not, because the browser is not on this phone.</li>
<li>This link works once, on this device, for a few minutes.</li>
</ul></div>
<form method="post" action="${PATH}/${s.token}/start"><button class="go" type="submit" data-busy="Starting…">Start</button></form>
<p class="small">Did not ask Reason for this? Close the page. Nothing happens unless you tap Start.</p>`, { card: cardKind(s.entry) });
}

/** The code step, for a browser that is not the person's own proved one. The code went to their own thread. */
function codePage(s, { status = 401, error = "" } = {}) {
  const label = esc(s.entry.label);
  return {
    status, headers: HTML(),
    body: shell(`Sign in to ${s.entry.label}`, `
<h1>Enter the code Reason texted you</h1>
<p class="lead">This browser isn't signed in to Reason yet, so Reason texted you a code first. That keeps a forwarded link from opening your ${label} sign-in. After this once, Reason remembers this browser and its links open straight away.</p>
${error ? `<p class="lead"><b>${esc(error)}</b></p>` : ""}
<form method="post" action="${PATH}/${s.token}/start">
<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="6-digit code" aria-label="Code" required>
<div class="row"><button class="go" type="submit" data-busy="Starting…">Start</button></div>
</form>
<form method="post" action="${PATH}/${s.token}/start"><input type="hidden" name="send" value="1"><button type="submit">Text me a new code</button></form>
<p class="small">Didn't ask Reason for this? Close the page. Nothing happens without the code.</p>`, { card: cardKind(s.entry) }),
  };
}

/**
 * How it ended, and the way back to the thread.
 *
 * `backToReason` rather than "you can close this page": closing a tab tells Reason nothing, and
 * the person who just signed in is the one whose task is waiting on it. "Reason will text you"
 * stays — both are true, and the tap is the faster of the two.
 */
function resultPage(s) {
  if (s.setupBack) return setupPages.resultPage({ name: s.entry.label, state: s.ended?.state ?? "", back: s.setupBack, kind: cardKind(s.entry) });
  const label = esc(s.entry.label);
  const name = s.entry.label;
  const [body, back] = s.ended.state === "signed_in"
    ? [`<h1>You're signed in to ${label}</h1><p class="lead">${label} confirmed it. Reason will text you.</p>`,
      `signed in to ${name}, keep going`]
    : s.ended.state === "signed_out"
      ? [`<h1>Not signed in to ${label}</h1><p class="lead">${label} still shows its sign-in page, so nothing was saved. Ask Reason for a fresh link to try again.</p>`,
        `${name} didn't sign in`]
      : s.ended.state === "blocked"
        ? [`<h1>${label} wouldn't let Reason's browser in</h1><p class="lead">${label} stopped the page with a bot check before you could sign in. That isn't something you did, and a fresh link would hit the same wall. Nothing was typed and nothing was saved. Reason will text you what works instead.</p>`,
          `${name} blocked the sign-in`]
      : s.ended.state
        ? [`<h1>Could not tell</h1><p class="lead">The sign-in ended, but ${label}'s page could not be read to confirm it. Ask Reason to check.</p>`,
          `${name} sign-in ended, not sure if it worked`]
        : [`<h1>This link has ended</h1><p class="lead">Ask Reason for a fresh one.</p>`,
          `the ${name} sign-in link ended`];
  return shell(`${s.entry.label} sign-in`, `${body}${backToReason({ text: back })}`, { card: cardKind(s.entry) });
}

/**
 * The live page.
 *
 * Four things it must do that the first version did not:
 *
 *   1. Never sit blank and silent. Every request has a deadline, a failure is retried with a
 *      growing gap, and the covering panel says what is going on in a sentence. The thing that
 *      actually broke on the owner's phone was a single `/shot` that never came back: the old
 *      page had a `busy` flag it set before the fetch and cleared after, no timeout, and no
 *      message — so one stalled request on a weak signal left a white rectangle for good.
 *   2. Open the phone's own keyboard. A tap that lands on one of the site's boxes focuses a real
 *      native input, positioned over that box, INSIDE the same tap — never after a round trip,
 *      because iOS only opens the keyboard for a focus that happens inside the gesture. That is
 *      why the shape of the form is sent down with every picture: by the time a finger lands,
 *      the page already knows what is under it and does not have to go and ask.
 *   3. Let the phone offer what it has saved. Four real inputs live in one form, each with fixed
 *      hints — a name, a password, a one-time code, and a plain one. Whichever matches is moved
 *      over the box that was tapped. They are four rather than one because changing `type` on an
 *      input that already has the keyboard open is how you lose the keyboard.
 *   4. Carry what is typed into the site's box as it is typed. Each input remembers what the box
 *      behind it already has and sends only the difference, so a deletion is a deletion and not a
 *      retyping of the whole thing.
 *
 * These inputs are a window onto the site's form, never a form of Reason's own: they only ever
 * appear on top of a box the site itself drew, they have no action, and they submit nowhere.
 */
function livePage(s) {
  const base = `${PATH}/${s.token}`;
  const label = esc(s.entry.label);
  const stage = `<div id="stage" style="aspect-ratio:${VIEW.width}/${VIEW.height}">
  <img id="v" alt="">
  <form id="f" autocomplete="on" onsubmit="return false">
    <input id="in-u" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false">
    <input id="in-p" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false">
    <input id="in-o" type="text" autocomplete="one-time-code" inputmode="numeric" autocapitalize="off" autocorrect="off" spellcheck="false">
    <input id="in-g" type="text" autocomplete="on">
  </form>
  <div id="veil"><span><span class="spin"></span>Opening ${label}…</span></div>
</div>`;
  const script = `<script>
(function(){
var B=${JSON.stringify(base)},V=${JSON.stringify(VIEW)};
var v=document.getElementById('v'),stage=document.getElementById('stage'),veil=document.getElementById('veil'),
    msg=document.getElementById('msg'),tip=document.getElementById('tip'),dead=false;
var slots={u:document.getElementById('in-u'),p:document.getElementById('in-p'),o:document.getElementById('in-o'),g:document.getElementById('in-g')};
var SITE=${JSON.stringify(s.entry.label)},TIP='Tap the page and sign in the way you normally would.';
var fields=[],hash='',shown=false,misses=0,blank=false,lastTyped=null;

function say(t,spin){veil.innerHTML=(spin?'<span class="spin"></span>':'')+t;veil.className=t?'':'off'}
function over(){if(dead)return;dead=true;location.reload()}

// Every request has a deadline. A phone on a weak signal is the normal case, not the odd one, and
// a fetch with no deadline is how the picture died the first time.
function ask(path,opts,ms){
  var c=new AbortController(),t=setTimeout(function(){c.abort()},ms||12000);
  var o=opts||{};o.signal=c.signal;o.credentials='same-origin';
  return fetch(B+path,o).then(function(r){clearTimeout(t);if(r.status===404||r.status===410){over();throw new Error('over')}return r},
                              function(e){clearTimeout(t);throw e});
}
function post(a,b){return ask('/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})},12000)
  .then(function(){kick()},function(){})}

// ---------- the picture ----------
var timer=null,running=false,quickUntil=0;
function kick(){quickUntil=Date.now()+2500;schedule(0)}
function schedule(ms){if(dead)return;clearTimeout(timer);timer=setTimeout(pull,ms)}
function pull(){
  if(dead||running)return;
  running=true;
  // Nine seconds is longer than a picture takes over a bad connection and short enough that a
  // request which is never coming back is given up on while somebody is still watching.
  ask('/view?h='+encodeURIComponent(hash),{},9000).then(function(r){
    if(r.status===503)throw new Error('no picture');
    var ct=r.headers.get('Content-Type')||'';
    if(ct.indexOf('application/json')===0)return r.json().then(function(j){if(j&&j.over){over()}throw new Error('ended')});
    return r.arrayBuffer().then(draw);
  }).then(function(){
    misses=0;
    // The panel comes off only once there is a real picture under it AND the site has drawn
    // something. Blank is a state the person is told about, not one they are shown.
    if(blank){say(SITE+" hasn't drawn anything on the page yet. Give it a moment, or tap Back.",true);shown=false}
    else if(v.src){shown=true;say('')}
    else {say('Opening '+SITE+'…',true)}
    schedule(Date.now()<quickUntil?120:1100);
  },function(){
    if(dead)return;
    misses++;
    if(misses>=2){
      say(shown?'Lost the connection to '+SITE+"'s page. Still trying…":'Still loading '+SITE+"'s page. This can be slow on a weak signal.",true);
      shown=false;
    }
    schedule(Math.min(600*misses,5000));
  }).then(function(){running=false},function(){running=false});
}
function draw(buf){
  var d=new DataView(buf),n=d.getUint32(0),meta=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,4,n)));
  hash=meta.h||hash;fields=meta.fields||[];blank=!!meta.blank;
  if(buf.byteLength>4+n){
    var old=v.src,u=URL.createObjectURL(new Blob([new Uint8Array(buf,4+n)],{type:'image/jpeg'}));
    v.src=u;if(old&&old.indexOf('blob:')===0)setTimeout(function(){URL.revokeObjectURL(old)},600);
  }
  place();
}

// ---------- the real boxes, over the site's own ----------
// Measured off the picture itself, never off the frame around it: a field's position is a
// fraction OF the picture, and the frame's own border would shift every one of them.
function box(){return v.getBoundingClientRect()}
/** Put each native input over the site's box it matches, so an autofill of a pair lands in both. */
function place(){
  var r=box(),sr=stage.getBoundingClientRect(),ox=r.left-sr.left,oy=r.top-sr.top,used={};
  for(var k in slots){slots[k]._f=null}
  for(var i=0;i<fields.length;i++){
    var f=fields[i],el=slots[f.slot];
    if(!el||used[f.slot])continue;
    used[f.slot]=1;
    // A slot that has moved to a different box of the site's starts over, or the difference it
    // sends would be measured against a box that is no longer there.
    var key=f.slot+':'+f.k+':'+Math.round(f.y*1000);
    if(el._key!==key&&document.activeElement!==el){el._key=key;el._sent='';el.value='';el._fresh=true}
    el._f=f;
    el.style.left=(ox+f.x*r.width)+'px';el.style.top=(oy+f.y*r.height)+'px';
    el.style.width=(f.w*r.width)+'px';el.style.height=(f.h*r.height)+'px';
    el.style.fontSize=Math.max(16,Math.min(20,f.h*r.height*0.5))+'px';
    if(f.im)el.setAttribute('inputmode',f.im);else el.removeAttribute('inputmode');
    el.setAttribute('enterkeyhint',f.ek||'next');
    el.setAttribute('autocapitalize',f.cap||'off');
    if(f.lb)el.setAttribute('aria-label',f.lb);
  }
  // A box the site no longer shows is parked off screen so a stray tap cannot reach it.
  for(var k2 in slots){var e2=slots[k2];if(!e2._f&&document.activeElement!==e2){e2.style.left='-9999px';e2.classList.remove('at')}}
}
function at(nx,ny){for(var i=0;i<fields.length;i++){var f=fields[i];if(nx>=f.x-0.01&&nx<=f.x+f.w+0.01&&ny>=f.y-0.01&&ny<=f.y+f.h+0.01)return f}return null}

// ---------- taps ----------
var sx=0,sy=0,moved=false;
stage.addEventListener('pointerdown',function(e){if(e.target!==v)return;sx=e.clientX;sy=e.clientY;moved=false},{passive:true});
stage.addEventListener('pointermove',function(e){if(Math.abs(e.clientX-sx)>12||Math.abs(e.clientY-sy)>12)moved=true},{passive:true});
stage.addEventListener('pointerup',function(e){
  if(e.target!==v)return;
  var r=box();
  if(moved){post('scroll',{dx:Math.round((sx-e.clientX)*V.width/r.width),dy:Math.round((sy-e.clientY)*V.height/r.height)});blurAll();return}
  var nx=(e.clientX-r.left)/r.width,ny=(e.clientY-r.top)/r.height,f=at(nx,ny);
  // Focus happens HERE, in the tap itself. Anything after an await is too late for iOS.
  if(f&&slots[f.slot]){
    var el=slots[f.slot];
    for(var k in slots)slots[k].classList.remove('at');
    el.classList.add('at');el.value='';el._sent='';el._at={x:nx,y:ny};el._fresh=true;
    el.focus();
    try{el.setSelectionRange(0,0)}catch(err){}
  } else { blurAll(); }
  post('tap',{x:nx,y:ny});
},{passive:true});
function blurAll(){for(var k in slots){slots[k].classList.remove('at');if(document.activeElement===slots[k])slots[k].blur()}}

// ---------- what they type, carried into the site's box as they type ----------
// Only the difference travels: the common start of old and new is left alone, what was rubbed out
// becomes a count of backspaces, and what is new becomes the characters. Nothing comes back.
function flush(el){
  if(!el._f)return;
  var val=el.value,was=el._sent||'',i=0;
  while(i<val.length&&i<was.length&&val[i]===was[i])i++;
  var body={del:was.length-i,text:val.slice(i)};
  // Put the cursor in the right box first whenever this is not the box last typed into. The phone
  // filling a saved login drops a name AND a password in at once, and the password one was never
  // tapped, so it has to say where it goes.
  if(lastTyped!==el||el._fresh){
    body.at=el._at||{x:el._f.x+el._f.w/2,y:el._f.y+el._f.h/2};
    if(el._fresh&&el._f.len>0)body.all=true;
    el._fresh=false;el._at=null;
  }
  if(!body.del&&!body.text&&!body.all&&!body.at)return;
  el._sent=val;lastTyped=el;
  post('type',body);
}
for(var k in slots){(function(el){
  el._sent='';el._f=null;
  var t=null;
  // A tap on a box that is already placed lands on the native input, not on the picture, so the
  // things that must happen when a box is entered hang off focus and not off the tap.
  el.addEventListener('focus',function(){
    for(var q in slots)if(slots[q]!==el)slots[q].classList.remove('at');
    el.classList.add('at');el._sent='';el._fresh=true;
    var f=el._f;
    tip.textContent=!f?TIP
      :f.k==='password'?'Tap Passwords above the keyboard to use your saved '+SITE+' login.'
      :f.k==='otp'?'Your code should appear above the keyboard.'
      :(f.lb||TIP);
  });
  el.addEventListener('input',function(){clearTimeout(t);t=setTimeout(function(){flush(el)},120)});
  el.addEventListener('blur',function(){clearTimeout(t);flush(el);el.classList.remove('at');tip.textContent=TIP});
  el.addEventListener('keydown',function(e){
    if(e.key!=='Enter')return;
    e.preventDefault();clearTimeout(t);flush(el);
    setTimeout(function(){post('key',{key:'Enter'})},200);
  });
})(slots[k])}
window.addEventListener('resize',place);
window.addEventListener('orientationchange',function(){setTimeout(place,300)});

// ---------- the few controls there are ----------
document.getElementById('back').onclick=function(){blurAll();post('back')};
document.getElementById('done').onclick=function(){blurAll();msg.textContent='Checking with ${label}…';dead=true;ask('/done',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},20000).then(function(){location.reload()},function(){location.reload()})};
document.getElementById('stop').onclick=function(){blurAll();msg.textContent='Closing…';dead=true;ask('/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},20000).then(function(){location.reload()},function(){location.reload()})};
say('<span class="spin"></span>Opening ${label}…');pull();
})();
</script>`;
  if (s.setupBack) return setupPages.livePage({ name: s.entry.label, stage, script, kind: cardKind(s.entry) });
  return shell(`Sign in to ${s.entry.label}`, `
<header><h1>${label}</h1><button id="back">Back</button></header>
<p class="small" id="tip">Tap the page and sign in the way you normally would.</p>
${stage}
<p class="small" id="msg"></p>
<div class="foot"><button id="done">I'm signed in</button><button id="stop">Cancel</button></div>`, { card: cardKind(s.entry), script });
}
