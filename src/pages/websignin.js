// Reason Web, phase W1: signing in (docs/plans/reason-web-phase1.md §4.1–4.2, §7 decisions 1–4, 10).
//
// Web is a route to the Reason a person already has, so signing in is proving the phone that Reason
// is theirs: they type their number, Reason texts that number a six-digit code through the same
// line it always texts them on, they type the code, and this browser becomes theirs. It is the
// event sign-in (src/pages/event.js) with Reason itself as the thing opened, and it reuses every
// piece of that: `page_codes` under a `wsign:<conversation>` key (hashed, once, fifteen minutes,
// three per person per quarter hour), the wrong-try ceilings in src/events.js, the `reason_page`
// cookie and `page_sessions` row every private page already trusts (owner decision 3: one cookie,
// 90 days hard, 30 days idle for Web).
//
// What the page must never do is say which numbers use Reason. A number with an account and a
// number without one get the same words back — "if that number uses Reason, a code is on its way" —
// the code text is not awaited (a slower answer for a real number would be an answer), and the
// join block for somebody new is shown to everybody, every time. Reason cannot text a number that
// has never texted it (the line is inbound-only), so a new person joins the way invites and events
// join: one text FROM their phone, prefilled by an `sms:` link, as a QR for a desktop and as the
// number written out (owner decisions 1 and 2). That number is the LIVE line's, read at request
// time through src/web.js joinNumber — never a string here, never the linq adapter.
//
// `REASON_WEB` (src/web.js): `owner` lets only the owner's conversation sign in — anybody else's
// number gets the same page and no code, exactly like a number with no account; `on` lets anybody
// with a Reason in; off and these routes do not exist (src/http.js answers its flat 404).
import { timingSafeEqual, randomBytes } from "node:crypto";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import * as events from "../events.js";
import { webAllowedFor } from "../web.js";
import { requestCode, readCookie, cookieHeader, clearCookieHeader, codeHost, boundTo, SESSION_TTL_MS, CODE_TTL_MS } from "./access.js";
import { shell, esc, renderNotFound, codeInputAttrs, foot, sentLine } from "./render.js";
import { eventActor } from "./event.js";
import { prettyNumber } from "../invites.js";
import { qrSvg } from "./qr.js";
import { config, normalizeNumber } from "../config.js";

/** A Web session unused for this long is over (owner decision 3), whatever its age. */
export const WEB_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** The cookie that ties a sign-in form to the browser that was shown it (the pre-sign-in CSRF token). */
export const FORM_COOKIE = "reason_web_form";
const FORM_TTL_S = 24 * 60 * 60;

/** The key a person's Web sign-in codes and sessions live under: one per person, like `esign:`. */
export function signinKey(conversationId) {
  return `wsign:${conversationId}`;
}

/** Where Reason Web lives: the website's /web (the site proxies it), else this server's own address. */
export function webUrl() {
  const base = (config.siteUrl || config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
  return `${base}/web`;
}

/** What the person is texted. Names what the code opens and says it can be ignored, bound to the Web host for AutoFill. */
export function codeLine(code) {
  const mins = Math.round(CODE_TTL_MS / 60000);
  return `Your Reason code is ${code}, to open Reason on the web in that browser. Good for ${mins} minutes. If that wasn't you, ignore this — nothing was shown.${boundTo(codeHost(webUrl()), code)}`;
}

/**
 * The Reason a typed number belongs to, if Web may open it: an account Reason still serves, on a
 * texting channel, that the switch allows (owner-only mode admits only the owner's). Ten digits
 * typed without a "+" is a US number. When one number holds two accounts (a person moved from one
 * line to another), the one used most recently wins and the other is never mentioned (owner
 * decision 4). Null for everybody else, who then sees exactly what a real person sees.
 */
export function accountForNumber(number) {
  const raw = String(number ?? "").trim();
  let n = normalizeNumber(raw);
  if (n.length === 11 && !raw.startsWith("+")) n = `+1${n.slice(1)}`;
  if (!n) return null;
  const rows = db.accountsByAddress(n)
    .filter(a => a.channel && a.channel !== "console")
    .sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0));
  for (const acct of rows) {
    if (!accounts.admit({ channel: acct.channel, address: acct.address }).allow) continue;
    if (!webAllowedFor(acct.conversation_id)) continue;
    return acct;
  }
  return null;
}

/**
 * Whose browser this is, for Web: the `reason_page` session's owner — within 90 days of being made
 * and 30 of last use — when that account is one Reason still serves and the switch allows. Null for
 * anybody else, including a person signed in while the switch was `on` once it is back to `owner`.
 */
export function sessionAccount(headers) {
  const token = readCookie(headers?.cookie);
  const owner = token ? db.pageSessionOwner(token, SESSION_TTL_MS, { idleMs: WEB_IDLE_MS }) : null;
  const acct = owner ? db.getAccount(owner) : null;
  if (!acct || !webAllowedFor(acct.conversation_id)) return null;
  return accounts.admit({ channel: acct.channel, address: acct.address }).allow ? acct : null;
}

/**
 * Did this POST come from one of Reason's own pages? A browser that names where the request came
 * from must name this host, the website, the pages host or Reason's own address; one that says it
 * was cross-site is refused. A request naming nothing (an old client, a same-origin form on some
 * browsers) is allowed through and is held by the form token instead.
 */
export function sameOrigin(headers = {}) {
  const site = String(headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site && !["same-origin", "same-site", "none"].includes(site)) return false;
  const origin = String(headers.origin ?? "").trim();
  if (!origin || origin === "null") return !origin;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
  const ours = new Set([String(headers.host ?? ""), hostOf(config.siteUrl), hostOf(config.pagesUrl), hostOf(config.publicUrl)].filter(Boolean));
  return ours.has(host);
}

function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

const secure = () => ((config.publicUrl || "").startsWith("https://") ? "; Secure" : "");
const formCookieHeader = (token) => `${FORM_COOKIE}=${token}; Path=/web; Max-Age=${FORM_TTL_S}; HttpOnly; SameSite=Lax${secure()}`;
const clearFormCookie = () => `${FORM_COOKIE}=; Path=/web; Max-Age=0; HttpOnly; SameSite=Lax${secure()}`;
function readFormCookie(header) {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === FORM_COOKIE) return v.join("=");
  }
  return null;
}

// Every answer here carries these. The pages are built from inline style and script (the shell's
// theme switch), so those stay 'unsafe-inline'; nothing else may load, nothing may frame it, no
// form may post anywhere but here, and no address is kept in any cache.
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};
const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra });
const page = (status, body, extra = {}) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(body), ...extra }), body });
const redirect = (location, extra = {}) => ({ status: 303, headers: HTML({ Location: location, "Content-Length": 0, ...extra }), body: "" });

const CSS = `
.w-form label{display:block;margin:.8rem 0 .3rem;font-weight:600}
.w-form input[type=tel],.w-form input[type=text]{display:block;width:100%;box-sizing:border-box;min-height:3rem;padding:.8rem .95rem;border-radius:.6rem;border:1px solid var(--edge,#ccc);font:inherit;background:var(--card);color:var(--ink)}
.w-form input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}
.w-form input::placeholder{color:var(--dim);opacity:1}
.w-form input[type=tel]{letter-spacing:normal;text-transform:none;text-align:left}
.w-btn{display:block;width:100%;text-align:center;margin:1rem 0;padding:.95rem;font-weight:600;border-radius:.6rem;background:var(--ink);color:var(--bg);text-decoration:none;border:0;font-size:1rem;cursor:pointer}
.w-link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;opacity:.8}
.w-link[data-busy]{min-width:6.5rem;text-align:left}
.w-err{color:var(--warn);font-weight:600}
.w-join{margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--line)}
.w-qr{margin:1.2rem 0 0;display:flex;gap:1.2rem;align-items:center;flex-wrap:wrap}
.w-qr svg{width:9rem;height:9rem;border-radius:.6rem;border:1px solid var(--line);background:#fff;padding:.3rem;box-sizing:border-box}
.w-qr figcaption{flex:1;min-width:12rem;color:var(--dim);font-size:.95rem;margin:0}
.w-num{font-variant-numeric:tabular-nums;white-space:nowrap}
.w-out{margin-top:3rem}
`;
const p = (s) => `<p>${esc(s)}</p>`;
const hero = (h1, sub = "") => `<div class="hero"><p class="kicker">Reason Web</p><h1>${esc(h1)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}</div>`;

/**
 * The block for somebody new, shown to everybody so it says nothing about the number typed. The
 * `sms:` link opens a text TO Reason with a hello in it; the QR is the same link for a phone pointed
 * at a desktop screen; the number is written out for anybody who would rather type it.
 */
export function joinBlock(joinNumber) {
  const lead = `<h2>New to Reason?</h2><div class="t">${p("A text from your phone finishes joining. Reason answers there first, then you can sign in here.")}`;
  if (!joinNumber) {
    return `<section class="w-join">${lead}${p("Reason's texting line isn't connected right now, so joining can't finish at the moment. Nothing was used up — try again later.")}</div></section>`;
  }
  const href = `sms:${normalizeNumber(joinNumber)}?&body=${encodeURIComponent("Hi")}`;
  return `<section class="w-join">${lead}</div>`
    + `<a class="w-btn" href="${esc(href)}">Text Reason</a>`
    + `<figure class="w-qr">${qrSvg(href, { label: `Text Reason at ${prettyNumber(joinNumber)}` })}`
    + `<figcaption>Not on your phone? From your phone, text Reason at <b class="w-num">${esc(prettyNumber(joinNumber))}</b>, or point its camera at this code.</figcaption></figure></section>`;
}

/** The sign-in page: the number form, or — once a number was typed — the code box over the same words for every number. */
export function renderSignin({ number = "", sent = false, error = "", joinNumber = null, formToken = "" }) {
  const hidden = `<input type="hidden" name="f" value="${esc(formToken)}">`;
  const body = hero("Pick up where you left off.", "Sign in with the number you text Reason from.")
    + (error ? `<p class="w-err">${esc(error)}</p>` : "")
    + (sent
      ? (error ? `<div class="t">${p("If that number uses Reason, a code is on its way to it now.")}</div>` : sentLine("Sent. If that number uses Reason, a code is on its way to it now."))
        + `<form class="w-form" method="POST" action="/web/code">${hidden}<input type="hidden" name="number" value="${esc(number)}">`
        + `<label for="code">The code from your texts</label><input id="code" ${codeInputAttrs({ autofocus: true })} required>`
        + `<button class="w-btn" type="submit" data-busy="Checking…">Sign in</button></form>`
        + `<form class="w-form" method="POST" action="/web/signin">${hidden}<input type="hidden" name="number" value="${esc(number)}"><button class="w-link" type="submit" data-busy="Sending…">Text it again</button></form>`
        + `<div class="t">${p("The code works once, for 15 minutes. If none arrives, that number may not have texted Reason yet — see below.")}</div>`
      : `<form class="w-form" method="POST" action="/web/signin">${hidden}<label for="number">Your phone number</label><input id="number" name="number" type="tel" inputmode="tel" autocomplete="tel" placeholder="(555) 123-4567" maxlength="24" required value="${esc(number)}">`
        + `<button class="w-btn" type="submit" data-busy="Sending code…">Text me a code</button></form>`
        + `<div class="t">${p("Reason texts the code to that number through the same line you already text it on. Nothing is shown until the code is in.")}</div>`)
    + joinBlock(joinNumber) + foot();
  return shell({ title: "Reason — sign in", body, pill: "Web", css: CSS });
}

/** Signed in. The conversation itself arrives in the next phase; this says so plainly, and says the one thing about Web worth knowing. */
export function renderLanding({ account, csrf }) {
  const name = String(account?.name ?? "").trim();
  const body = hero(`You're in${name ? `, ${name}` : ""}.`, "This browser is yours now, on every page Reason makes for you.")
    + `<div class="t">${p("Your conversation with Reason will open here. Until then, Reason is the same one you text, and nothing you've told it is lost.")}</div>`
    + `<h2>One Reason. Pick up anywhere.</h2><div class="t">`
    + p("Start on Web, continue in iMessage, or switch back. Reason keeps the context, so you don't have to explain again. See your full conversation on Web. Messages from Web won't appear in your iMessage thread.")
    + `</div>`
    + `<form class="w-form w-out" method="POST" action="/web/signout"><input type="hidden" name="c" value="${esc(csrf)}"><button class="w-link" type="submit" data-busy="Signing out…">Sign out of this browser</button></form>`
    + foot();
  return shell({ title: "Reason", body, pill: "Web", css: CSS });
}

/**
 * Text one person a sign-in code, under the same limits as every Reason page code (3 per 15
 * minutes per person). Not waited on: a page that answered slower for a real number than for a
 * made-up one would say which numbers use Reason. Keyed on the code's own row (`wsign:<conv>:<id>`),
 * which src/db.js keeps out of the per-message history.
 */
function sendCode({ conversationId, runtime, log }) {
  const asked = requestCode({ id: signinKey(conversationId), title: "Reason" }, { host: "" });
  if (!asked.ok) { log({ web_signin_code_refused: asked.reason }); return asked; }
  if (!runtime?._tell) return asked;
  Promise.resolve(runtime._tell(conversationId, codeLine(asked.code), { idempotencyKey: `wsign:${conversationId}:${asked.id}` }))
    .then(r => log({ web_signin_code_sent: true, ok: !!(r?.ok || r?.queued) }))
    .catch(e => log({ web_signin_code_sent: true, ok: false, why: (e?.message ?? String(e)).split("\n")[0] }));
  return asked;
}

/**
 * GET/POST /web[/signin|/code|/signout]. `joinNumber` is the live texting line's number for the join
 * block, or null when no line is live. Every private decision is made here on the server, per
 * request: who this browser is (`sessionAccount`), never what the client claims.
 */
export async function webRequest({ sub = null, method, query = {}, headers = {}, remoteAddress = "", readBody, runtime = null, joinNumber = null, log = () => {} }) {
  const account = sessionAccount(headers);
  const formToken = readFormCookie(headers?.cookie);

  // ---- the landing, or the sign-in form ----
  if (sub === null) {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (account) {
      const csrf = db.pageSessionCsrf(readCookie(headers.cookie));
      return page(200, renderLanding({ account, csrf }), formToken ? { "Set-Cookie": clearFormCookie() } : {});
    }
    // A fresh form token for a browser that has none; the one it has otherwise, so two tabs agree.
    const token = formToken || randomBytes(16).toString("base64url");
    return page(200, renderSignin({ joinNumber, formToken: token }), formToken ? {} : { "Set-Cookie": formCookieHeader(token) });
  }

  if (method !== "POST") {
    if (sub === "signout") return page(405, renderNotFound(), { Allow: "POST" });
    return redirect("/web");
  }
  const form = new URLSearchParams((await readBody()) ?? "");

  // ---- sign this browser out ----
  if (sub === "signout") {
    // Only a browser that sent its session signs itself out, and only from Reason's own page: the
    // form's secret must be the session's. A post from elsewhere carries no cookie (SameSite=Lax)
    // and no secret, and is answered without touching the one this browser holds.
    const presented = readCookie(headers?.cookie);
    if (!presented || !account) return redirect("/web");
    if (!sameOrigin(headers) || !same(form.get("c"), db.pageSessionCsrf(presented))) {
      log({ web_signout_refused: "origin_or_token" });
      return page(403, renderNotFound());
    }
    db.endPageSession(presented);
    log({ web_signout: true });
    return redirect("/web", { "Set-Cookie": clearCookieHeader({ path: "/" }) });
  }

  // A signed-in browser posting a sign-in form: it is already in.
  if (account) return redirect("/web");

  // ---- the two sign-in steps share their guards ----
  // The form must be this browser's own: the secret in it is the one the form cookie carries, and
  // the request names one of Reason's hosts or nothing. Otherwise the page starts over, fresh.
  if (!sameOrigin(headers) || !formToken || !same(form.get("f"), formToken)) {
    log({ web_signin_refused: "origin_or_token" });
    const token = randomBytes(16).toString("base64url");
    return page(403, renderSignin({ joinNumber, formToken: token, error: "That didn't come from this page — here it is again." }), { "Set-Cookie": formCookieHeader(token) });
  }
  const number = String(form.get("number") ?? "").slice(0, 24);
  const actor = eventActor(headers, remoteAddress);
  // Only an account Reason serves and the switch allows gets a text; everybody else gets the same
  // page. `who` is null for a number with no account, a paused one, or — in owner-only mode — anyone
  // but the owner, and nothing below can tell those apart from the outside.
  const who = accountForNumber(number);

  if (sub === "code") {
    // One answer for every miss — no account, not allowed, wrong, expired, used — and the only
    // limit ever said is this browser's own, so codes teach nothing about whose number it was.
    const tried = events.tryKeyedCode({ conversationId: who?.conversation_id ?? null, code: form.get("code"), personKey: who ? signinKey(who.conversation_id) : null, browserKey: `wsignb:${actor}` });
    if (!tried.ok) {
      log({ web_signin_failed: tried.reason });
      return page(tried.reason === "rate_limited" ? 429 : 200, renderSignin({ number, sent: true, joinNumber, formToken, error: tried.reason === "rate_limited" ? "Too many wrong codes from this browser. Try again in about 15 minutes." : "That code isn't right." }));
    }
    log({ web_signin_ok: true });
    // The session cookie on every path, so the browser is theirs on their pages and events too;
    // the form cookie has done its job.
    return { status: 303, headers: HTML({ Location: "/web", "Content-Length": 0, "Set-Cookie": [cookieHeader(tried.token, { path: "/" }), clearFormCookie()] }), body: "" };
  }

  // sub === "signin": ask for a code.
  if (!events.signinGate(actor)) return page(429, renderSignin({ number, joinNumber, formToken, error: "Too many sign-in tries from this browser. Try again in an hour." }));
  events.noteSigninRequest(actor);
  if (who) sendCode({ conversationId: who.conversation_id, runtime, log });
  return page(200, renderSignin({ number, sent: true, joinNumber, formToken }));
}
