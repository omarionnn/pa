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
import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import * as events from "../events.js";
import { webAllowedFor, webStreamOrigin } from "../web.js";
import { requestCode, readCookie, readCookies, cookieHeader, clearCookieHeader, codeHost, boundTo, SESSION_TTL_MS, CODE_TTL_MS } from "./access.js";
import { esc, renderNotFound, codeInputAttrs } from "./render.js";
import { eventActor } from "./event.js";
import { qrSvg } from "./qr.js";
import { config, clock, normalizeNumber } from "../config.js";
import { webPage, wordmark, label, hand, action, typed, textReason, WEB_FONTS, webFont, accountThemed } from "./webkit.js";
import { linkCardTags } from "./sitecard.js";

export { WEB_FONTS, webFont };

/** "Send a new code" from one browser: this many in this window, like every person's own code limit. */
export const RESEND = { limit: 3, windowMs: 15 * 60_000 };
/** A Web session unused for this long is over (owner decision 3), whatever its age. */
export const WEB_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** §4h "while you were out": a visit this long after the last one is a return (HANDOFF: "after 3+ hours away"). */
export const WEB_AWAY_MS = 3 * 60 * 60 * 1000;
/** Which signed-in GETs are a visit: the pages a person opens, never the stream, polls or JSON reads. */
const isVisit = (sub) => sub === null || sub === "memory" || sub === "memory/history" || sub === "settings" || sub === "saved"
  || /^saved\/(?:page|call|receipt|event|album)\/[A-Za-z0-9_-]{1,40}$/.test(String(sub ?? ""));
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
  if (!accounts.admit({ channel: acct.channel, address: acct.address }).allow) return null;
  // The browser it was used from, for Settings' signed-in browsers list.
  db.notePageSessionAgent(token, headers?.["user-agent"]);
  return acct;
}

/**
 * Did this POST come from one of Reason's own pages? A browser that names where the request came
 * from must name this host, the website, the pages host or Reason's own address; one that says it
 * was cross-site is refused. A request naming nothing (an old client, a same-origin form on some
 * browsers) is allowed through and is held by the form token instead.
 * The pages say `Referrer-Policy: same-origin`, so a browser posting from them names this host.
 */
export function sameOrigin(headers = {}) {
  const site = String(headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site && !["same-origin", "same-site", "none"].includes(site)) return false;
  const origin = String(headers.origin ?? "").trim();
  if (!origin) return true;
  // `Origin: null` is what a browser sends when the page's referrer policy withholds it; it is ours
  // only when the browser itself vouches the post was same-origin (Sec-Fetch-Site, which no page
  // can set). Safari and Chrome both sent it from /web while it was `no-referrer` (10-26).
  if (origin === "null") return site === "same-origin";
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
/**
 * Where a browser that was signed in to nobody wanted to go (only Saved: the wordmark on every page
 * Reason made links to the person's own pages, src/pages/wordmark.js yourPagesHref). Remembered for
 * half an hour on this browser, then signing in lands there instead of the arrival. Only a path on
 * this site that names Saved is ever kept or followed, so it cannot send anyone elsewhere.
 */
export const NEXT_COOKIE = "reason_web_next";
const NEXT_TTL_S = 30 * 60;
const NEXT_OK = /^\/web\/saved(\/(page|call|receipt|event|album)\/[A-Za-z0-9_-]{1,40})?(\?[A-Za-z0-9_.~%+=&-]{0,200})?$/;
export function safeNext(v) {
  const s = String(v ?? "");
  return s.length <= 300 && NEXT_OK.test(s) ? s : null;
}
function nextFor(sub, query) {
  const q = new URLSearchParams(Object.entries(query ?? {}).filter(([k, v]) => /^(kind|q|all)$/.test(k) && typeof v === "string")).toString();
  return safeNext(`/web/${sub}${q ? `?${q}` : ""}`);
}
const nextCookieHeader = (path) => `${NEXT_COOKIE}=${encodeURIComponent(path)}; Path=/web; Max-Age=${NEXT_TTL_S}; HttpOnly; SameSite=Lax${secure()}`;
const clearNextCookie = () => `${NEXT_COOKIE}=; Path=/web; Max-Age=0; HttpOnly; SameSite=Lax${secure()}`;
function readNextCookie(header) {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === NEXT_COOKIE) { try { return safeNext(decodeURIComponent(v.join("="))); } catch { return null; } }
  }
  return null;
}

function readFormCookie(header) {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === FORM_COOKIE) return v.join("=");
  }
  return null;
}

// Every answer here carries these. The pages are built from inline style and script (the theme
// switch, the code cells), so those stay 'unsafe-inline'; nothing else may load, nothing may frame
// it, no form may post anywhere but here, and no address is kept in any cache. Fonts come from
// /web/fonts only. The page may also open its live stream on the pages host (src/web.js
// webStreamOrigin) — that one origin, and only when it qualifies. The referrer goes only to
// Reason's own host (`same-origin`): under `no-referrer` a browser posts `Origin: null` and its own
// sign-in form was refused (10-26).
const STREAM_ORIGIN = webStreamOrigin();
export const SECURITY_HEADERS = {
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'${STREAM_ORIGIN ? ` ${STREAM_ORIGIN}` : ""}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};
const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra });
const page = (status, body, extra = {}) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(body), ...extra }), body });
const redirect = (location, extra = {}) => ({ status: 303, headers: HTML({ Location: location, "Content-Length": 0, ...extra }), body: "" });

// The signed-out screens, sheet 6 of the handoff and its desktop "sign in and join" / "code" boards.
// Mobile is one column, vertically centred, with the way in for somebody new as a typed link at the
// foot; from 900px the join block stands to the right, past a dashed vertical rule.
const SO_CSS = `
.so-head{padding:20px 28px 0;display:flex;align-items:center;justify-content:space-between;gap:16px}
.so{flex:1 0 auto;width:100%;max-width:1080px;margin:0 auto;padding:12px 28px 28px;display:flex;flex-direction:column}
.so-cols{flex:1;display:flex;flex-wrap:wrap;align-items:center;gap:96px}
.so-in{flex:1 1 400px;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:28px}
.so-in form{display:flex;flex-direction:column;gap:28px;margin:0}
.so-field{display:flex;flex-direction:column;gap:8px;max-width:420px}
.so-field label{font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.ul-in{width:100%;height:52px;border:0;border-bottom:1px solid var(--ink);border-radius:0;background:transparent;font:400 22px/1 var(--mono);letter-spacing:.06em;color:var(--ink);padding:0;-webkit-appearance:none;appearance:none}
.ul-in::placeholder{color:var(--muted);opacity:1}
.ul-in:focus{box-shadow:0 1px 0 0 var(--ink)}
.so-field .hand{margin-top:4px}
.so-new{align-self:center;text-align:center}
.so-wm{display:none}
.so-join{display:none;flex:1 1 340px;max-width:400px;flex-direction:column;gap:24px;padding-left:48px;border-left:1px dashed var(--hair)}
.so-join .lbl{font-size:12px}
.so-join .qr{gap:10px}
.tr-or .act{font-size:28px}
.so-6d{gap:30px}
.ul-in[readonly]{color:var(--muted)}
.act.busy{color:var(--muted);cursor:default;pointer-events:none}
.code-f .checking{font-size:11px}
.so-h2{margin:0;font:italic 400 38px/1.1 var(--serif)}
.qr{align-self:flex-start;background:var(--lifted);border:1px solid var(--hair);box-shadow:var(--sh);padding:14px;transform:rotate(-1.5deg);display:flex;flex-direction:column;gap:8px;align-items:center;margin:0}
.qr svg{display:block;width:120px;height:120px}
.qr figcaption{font:400 10px/1.3 var(--mono);letter-spacing:.12em;color:var(--muted);text-transform:uppercase}
.qr .on-desk{display:none}
.so-sub{margin:0;font-size:16px;line-height:1.5;color:var(--muted)}
.so-lead{display:flex;flex-direction:column;gap:10px}
.digits{position:relative;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;max-width:520px}
.digits .cell{height:56px;border-bottom:1.5px solid var(--hair);display:grid;place-items:center;font:400 28px/1 var(--mono);color:var(--ink)}
.digits .cell.on{border-bottom-color:var(--ink)}
.digits .cell.cur{border-bottom-color:var(--pen);color:var(--pen)}
.digits.bad .cell,.digits.bad .cell.on{border-bottom-color:var(--pen)}
.digits.bad input{border-bottom-color:var(--pen)}
html.js .digits:focus-within .cell{border-bottom-width:2px}
.digits input{grid-column:1/-1;grid-row:1;width:100%;height:56px;border:0;border-bottom:1.5px solid var(--ink);border-radius:0;background:transparent;font:400 28px/1 var(--mono);letter-spacing:.5em;color:var(--ink);padding:0}
html.js .digits input{position:absolute;inset:0;height:100%;border:0;color:transparent;caret-color:transparent;letter-spacing:0;font-size:16px;-webkit-text-fill-color:transparent}
html:not(.js) .digits .cell{display:none}
.code-f{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;min-width:0}
.code-f .hand{font-size:23px}
.so-acts{display:flex;gap:16px 40px;align-items:center;flex-wrap:wrap}
.so-acts form{margin:0}
.so-wait{margin:0;font:400 13px/1.4 var(--mono);letter-spacing:.08em}
.so-quiet{margin:0;font-size:15px;line-height:1.5;color:var(--muted)}
.so-center{justify-content:center}
@media (max-width:359px){.so-head,.so{padding-left:20px;padding-right:20px}}
@media (min-width:900px){
.so-head{padding:22px clamp(20px,4vw,48px)}
.so{padding:60px clamp(20px,4vw,48px) 80px}
.so-in{gap:32px}
.so-in form{gap:32px}
.ul-in{height:56px;font-size:26px}
.so-new{display:none}
.so-wm{display:inline-flex}
.so-join{display:flex}
.qr{padding:16px}.qr svg{width:150px;height:150px}.qr .on-phone{display:none}.qr .on-desk{display:inline}.qr figcaption{font-size:10.5px}
.so-sub{font-size:18px}
.code-main{max-width:640px;margin:0 auto;width:100%;padding-top:40px;gap:40px}
.digits{gap:18px}.digits .cell,.digits input{height:72px;font-size:40px}
.so-solo{max-width:640px;margin:0 auto;width:100%}
}
`;

/**
 * The tap that opens Messages with a text TO Reason, "hey" already typed (lowercase, Reason's own
 * voice: v2 handoff §7) — the sign-up. The number itself is never written on the page (owner 10-26):
 * the link and the QR carry it, and the typed hint under the link says what it does.
 */
export const smsHref = (n) => `sms:${normalizeNumber(n)}&body=${encodeURIComponent("hey")}`;
/** The QR for that tap, in the paper's own two inks. Dark on light in both themes, so a phone can read it. */
const qr = (n, cls = "qr") => `<figure class="${cls}">${qrSvg(smsHref(n), { label: "QR code to text Reason", size: 150 }).replace('fill="#fff"', 'fill="#ede5d8"').replace('fill="#000"', 'fill="#2a2520"')}`
  + `<figcaption><span class="on-phone">On a laptop? Scan</span><span class="on-desk">Scan with your phone</span></figcaption></figure>`;
const backHead = (text, href) => `<header class="so-head"><span class="so-wm">${wordmark({ href: "/web?home" })}</span>${typed(text, { href })}</header>`;
const markHead = () => `<header class="so-head">${wordmark({ href: "/web?home" })}</header>`;
/** Mm:ss, for TRY AGAIN IN. */
export const clockLeft = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const waitLine = (ms) => `<p class="so-wait" data-left="${Math.max(0, Math.round(ms))}">TRY AGAIN IN <span class="left">${clockLeft(ms)}</span></p>`;

// The countdown ticks down by itself, the code cells mirror the one real input, and a sixth digit
// sends the code. All of it is decoration over plain forms that work without script.
// L6 / L7 (sheet-loading-actions): once a form is on its way, its own words say so and it can't be
// sent twice. The number turns muted and the action becomes "Texting you a code…" (muted, not a
// button); the six digits stay and CHECKING… takes the note's place. Done after the submit event, so
// the form's own data has already gone.
const SO_JS = `(function(){
document.querySelectorAll('.so-wait[data-left]').forEach(function(w){var until=Date.now()+Number(w.dataset.left),l=w.querySelector('.left');
function tick(){var s=Math.max(0,Math.ceil((until-Date.now())/1000));l.textContent=Math.floor(s/60)+':'+('0'+s%60).slice(-2);if(s>0)return setTimeout(tick,500);var c=document.querySelector('.digits input[disabled]');if(c){c.disabled=false;w.remove();c.focus()}else location.href='/web'}tick()});
var d=document.querySelector('.digits'),i=d&&d.querySelector('input');if(!i)return;var cells=d.querySelectorAll('.cell');
function draw(){var v=i.value,f=document.activeElement===i;cells.forEach(function(c,k){c.textContent=v[k]||(f&&k===v.length?'|':'');c.classList.toggle('on',k<v.length);c.classList.toggle('cur',f&&k===v.length)})}
i.addEventListener('input',function(){d.classList.remove('bad');i.removeAttribute('aria-invalid');draw();if(i.value.length===6&&i.form&&!i.form.dataset.sent){i.form.dataset.sent='1';i.form.requestSubmit?i.form.requestSubmit():i.form.submit()}});
i.addEventListener('paste',function(){setTimeout(function(){i.dispatchEvent(new Event('input'))},0)});
i.addEventListener('focus',function(){if(d.classList.contains('bad'))try{i.select()}catch(x){}draw()});i.addEventListener('blur',draw);if(d.classList.contains('bad')&&document.activeElement===i)try{i.select()}catch(x){}draw();
})();
(function(){document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){if(f.dataset.busy){e.preventDefault();return}f.dataset.busy='1';
setTimeout(function(){var n=f.querySelector('#number'),b=f.querySelector('button[type=submit]'),c=f.querySelector('.digits input');
if(n&&b){n.readOnly=true;var s=document.createElement('span');s.className='act busy';s.setAttribute('role','status');s.textContent='Texting you a code\u2026';b.replaceWith(s)}
else if(c){c.readOnly=true;var g=f.querySelector('.digits');g.classList.remove('bad');var p=document.createElement('p');p.className='lbl checking';p.setAttribute('role','status');p.textContent='CHECKING\u2026';
f.querySelectorAll('.code-f>.hand,.code-f>form,.code-f>.so-wait,.code-f>.so-quiet').forEach(function(x){x.remove()});g.after(p)}
else if(b)b.setAttribute('aria-busy','true')},0)})});
// Back to a page the browser kept: its forms were mid-send. The sign-in again, fresh (a GET: nothing re-posts).
window.addEventListener('pageshow',function(e){if(e.persisted)location.replace(/^\\/web\\/(signin|code)$/.test(location.pathname)?'/web':location.href)});
})();`;

// Signed-out pages carry the /web link card (src/pages/sitecard.js): it is what a crawler, with no
// cookie, gets. Signed-in pages never do, so a preview can never show anything private.
const signedOutPage = (title, body) => webPage({ title, header: "", body, css: SO_CSS, script: SO_JS, head: linkCardTags("web") });

/**
 * The block for somebody new, shown to everybody so it says nothing about the number typed (desktop's
 * right-hand column). With no live line it says joining can't finish right now — no number, no QR.
 */
export function joinBlock(joinNumber) {
  if (!joinNumber) {
    return `<section class="so-join" aria-labelledby="dj-title">${label("NEW TO REASON")}<h2 id="dj-title" class="so-h2">We can't finish joining right now.</h2>`
      + `<p class="so-quiet">Reason's line isn't taking new people for the moment. Nothing on your side went wrong.</p>${hand("i'll be back soon.", { tilt: true })}</section>`;
  }
  // Desktop sign-in (reference desk-sign-in): the QR card first, then "or Text Reason →" and its hint.
  return `<section class="so-join" aria-labelledby="dj-title">${label("NEW TO REASON")}<h2 id="dj-title" class="so-h2">Your first text<br><em>is the sign-up.</em></h2>`
    + qr(joinNumber)
    + textReason(smsHref(joinNumber), { lead: "or Text Reason", cls: "tr-or" })
    + `${hand("then come back here to sign in.")}</section>`;
}

const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;

/**
 * 6A, the sign-in (and 6F above it when this browser was just signed out or its session ran out).
 * `error`: { kind: "origin" } or { kind: "pause", waitMs } for this browser's own hourly limit.
 */
export function renderSignin({ number = "", error = null, joinNumber = null, formToken = "", out = false }) {
  const note = error?.kind === "pause"
    ? `${hand("let's pause a minute.", { role: "alert" })}${waitLine(error.waitMs)}`
    : error?.kind === "origin" ? hand("that didn't come from this page. here it is again.", { role: "alert" })
      : hand("the same line you already text me on.");
  const body = `${markHead()}<main class="so"><div class="so-cols">`
    + `<section class="so-in" aria-labelledby="so-title">`
    + (out ? hand("you've been signed out. everything's still here.", { role: "status", tilt: true }) : "")
    + `<h1 id="so-title" class="h1">What's your number?</h1>`
    + `<form method="POST" action="/web/signin">${hidden("f", formToken)}<div class="so-field"><label for="number">PHONE NUMBER</label>`
    + `<input class="ul-in" id="number" name="number" type="tel" inputmode="tel" autocomplete="tel" placeholder="(555) 000-0000" maxlength="24" required value="${esc(number)}"${error?.kind === "pause" ? " disabled" : ""}>${note}</div>`
    + (error?.kind === "pause" ? "" : action("Text me a code"))
    + `</form></section>${joinBlock(joinNumber)}</div>`
    + typed("NEW TO REASON? START WITH A TEXT →", { href: "/web?join=1", cls: "so-new" })
    + `</main>`;
  return signedOutPage("Reason — sign in", body);
}

/** "••• ••• 0142": the number they typed, all but its last four hidden. Never anything the server knows. */
export function maskedNumber(number) {
  const d = String(number ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `••• ••• ${d.slice(-4)}` : "your number";
}

/**
 * 6B, the code. `error` is one of the handoff's notes, each right under the six digits:
 *   wrong · expired (this browser asked more than a code's life ago) · tries (this browser typed too
 *   many wrong codes; `waitMs` left) · resend (this browser asked for three codes in a quarter hour;
 *   `leftMs` = how long the last one still works).
 * Every one is about this browser, never the number, so none of them says whether it uses Reason.
 */
export function renderCode({ number = "", joinNumber = null, formToken = "", error = null, askedAt = clock.now() }) {
  const kind = error?.kind ?? "";
  // A wrong or expired code stays in the six cells, its underlines in pen (sheet 6B); typing again replaces it.
  const typedCode = (kind === "wrong" || kind === "expired") && /^\d{1,6}$/.test(String(error?.code ?? "")) ? String(error.code) : "";
  const ttlMin = Math.round(CODE_TTL_MS / 60000);
  const again = (inner) => `<form method="POST" action="/web/signin">${hidden("f", formToken)}${hidden("number", number)}${hidden("again", "1")}${inner}</form>`;
  const alert = (t) => `<p class="hand" id="code-note" role="alert">${esc(t)}</p>`;
  let note = hand("it fills in by itself if your browser offers it.");
  if (kind === "wrong") note = alert("that's not it. try again?");
  if (kind === "expired") note = `${alert("that one expired.")}${again(action("Send a fresh one", { cls: "act-sm" }))}`;
  if (kind === "tries") note = `${alert("let's pause a minute.")}${waitLine(error.waitMs)}`;
  if (kind === "resend") {
    const left = Math.ceil((error.leftMs ?? 0) / 60000);
    note = `${hand("i've sent a few. give it a moment.", { role: "alert" })}${left > 0 ? `<p class="so-quiet">The last code still works for ${left} minute${left === 1 ? "" : "s"}.</p>` : ""}`;
  }
  const bad = kind === "wrong" || kind === "expired" || kind === "tries";
  const body = backHead("← USE A DIFFERENT NUMBER", "/web")
    + `<main class="so"><section class="so-in code-main" aria-labelledby="so-title">`
    + `<div class="so-lead"><h1 id="so-title" class="h1">Check your texts.</h1><p class="so-sub">Six digits, sent to ${esc(maskedNumber(number))}.</p></div>`
    + `<form method="POST" action="/web/code">${hidden("f", formToken)}${hidden("number", number)}${hidden("t", String(askedAt))}`
    + `<fieldset class="code-f"><legend class="sr">Six-digit code</legend><label class="sr" for="code">The six-digit code from your texts</label>`
    + `<div class="digits${bad ? " bad" : ""}"><input id="code" ${codeInputAttrs({ autofocus: kind !== "tries" })} required${typedCode ? ` value="${typedCode}"` : ""}${kind === "tries" ? " disabled" : ""}${bad ? ` aria-invalid="true" aria-describedby="code-note"` : ""}>`
    + `${'<span class="cell" aria-hidden="true"></span>'.repeat(6)}</div>${note}</fieldset></form>`
    + `<div class="so-acts">${kind === "resend" || kind === "tries" ? "" : again(typed("SEND A NEW CODE"))}<p class="lbl">CODE GOOD FOR ${ttlMin} MIN</p></div>`
    + `</section>${typed("NEW TO REASON? START WITH A TEXT →", { href: "/web?join=1", cls: "so-new" })}</main>`;
  return signedOutPage("Reason — your code", body);
}

/** 6D, new to Reason (or 6E when no line is live): the sign-up is a text from their phone. */
export function renderJoin({ joinNumber = null }) {
  if (!joinNumber) {
    const body = `<main class="so so-center"><section class="so-in so-solo" aria-labelledby="so-title">`
      + `<h1 id="so-title" class="h1">We can't finish joining right now.</h1>`
      + `<p class="so-sub">Reason's line isn't taking new people for the moment. Nothing on your side went wrong.</p>`
      + hand("i'll be back soon.", { tilt: true })
      + typed("ALREADY A MEMBER? SIGN IN →", { href: "/web" })
      + `</section></main>`;
    return signedOutPage("Reason — joining", body);
  }
  const body = backHead("← SIGN IN", "/web")
    + `<main class="so"><section class="so-in so-solo so-6d" aria-labelledby="so-title">`
    + `<h1 id="so-title" class="h1">Your first text<br><em>is the sign-up.</em></h1>`
    + textReason(smsHref(joinNumber))
    + qr(joinNumber)
    + hand("then come back here to sign in.")
    + `</section></main>`;
  return signedOutPage("Reason — new to Reason", body);
}

/**
 * The signed-in greeting (owner copy, 2026-10-26): "What's good, <first name>?" — the first name
 * only — or "What's good?" when no name is known. One place, used by the conversation page too.
 */
export function greeting(name) {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? `What's good, ${first}?` : "What's good?";
}

/**
 * Text one person a sign-in code, under the same limits as every Reason page code (3 per 15
 * minutes per person). Not waited on: a page that answered slower for a real number than for a
 * made-up one would say which numbers use Reason. Keyed on the code's own row (`wsign:<conv>:<id>`),
 * which src/db.js keeps out of the per-message history.
 */
function sendCode({ conversationId, runtime, log, bound }) {
  const asked = requestCode({ id: signinKey(conversationId), title: "Reason" }, { host: "", bound });
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
export async function webRequest(args) {
  // The open tab's small background check (src/pages/webnotify.js): answered before anything that
  // would count it as using the session.
  if (args?.sub === "signal") {
    const { signalRequest } = await import("./webnotify.js");
    return await signalRequest({ method: args.method, headers: args.headers, idleMs: WEB_IDLE_MS, securityHeaders: SECURITY_HEADERS });
  }
  return themedForAccount(await routeWeb(args), args?.headers);
}

/** A signed-in Web page drawn somewhere else (an Ongoing detail): told its person's theme and form secret, like every other. */
export function webSignedIn(out, headers) {
  // §4h: an Ongoing page drawn is a visit too (it shows the very rows "while you were out" counts).
  if (out?.status === 200 && typeof out.body === "string" && out.body.startsWith("<!doctype html>") && sessionAccount(headers)) {
    try { db.webVisit(readCookie(headers?.cookie), { awayMs: WEB_AWAY_MS }); } catch { /* never costs a page */ }
  }
  return themedForAccount(out, headers);
}

/**
 * Every signed-in page opens in the theme its person chose on Web (Settings), on any browser: the
 * page is told the choice and the session's form secret (webkit accountThemed). Only for a session
 * that is still good; a page for nobody's session (or a lapsed one) is untouched.
 */
function themedForAccount(out, headers) {
  if (out?.status !== 200 || typeof out.body !== "string" || !out.body.startsWith("<!doctype html>")) return out;
  const token = readCookie(headers?.cookie);
  const conv = token ? db.pageSessionOwner(token, SESSION_TTL_MS, { idleMs: WEB_IDLE_MS }) : null;
  if (!conv || !webAllowedFor(conv)) return out;
  const body = accountThemed(out.body, { theme: db.webTheme(conv), csrf: db.pageSessionCsrf(token) });
  return { ...out, body, headers: { ...out.headers, "Content-Length": Buffer.byteLength(body) } };
}

async function routeWeb({ sub = null, method, query = {}, headers = {}, remoteAddress = "", readBody, runtime = null, router = null, joinNumber = null, log = () => {} }) {
  const account = sessionAccount(headers);
  const formToken = readFormCookie(headers?.cookie);
  // §4h "while you were out": a signed-in page drawn is a visit by this browser (the stream, polls
  // and posts are not). A visit 3+ hours after the last starts a return the thread shows once.
  if (account && method === "GET" && isVisit(sub)) {
    try { db.webVisit(readCookie(headers?.cookie), { awayMs: WEB_AWAY_MS }); } catch { /* never costs a page */ }
  }

  // ---- W2: the conversation's own routes (src/pages/webconvo.js). Signed in only. ----
  if (sub === "history" || sub === "stream" || sub === "send" || sub === "live" || sub === "about" || sub === "send/cancel") {
    const convo = await import("./webconvo.js");
    if (!account) {
      // Nobody's conversation: the same short answer whatever was asked, and a form post goes back to sign in.
      if (sub === "send" && !String(headers.accept ?? "").includes("application/json")) return redirect("/web");
      const body = JSON.stringify({ ok: false, error: "signed_out" });
      return { status: 401, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
    }
    if (sub === "send") {
      if (method !== "POST") return page(405, renderNotFound(), { Allow: "POST" });
      return await convo.sendRequest({ account, headers, readBody, router, log });
    }
    if (sub === "send/cancel") {
      if (method !== "POST") return page(405, renderNotFound(), { Allow: "POST" });
      return await convo.cancelRequest({ account, headers, readBody, router, log });
    }
    if (sub === "about") {
      if (method !== "POST") return page(405, renderNotFound(), { Allow: "POST" });
      return await convo.aboutRequest({ account, headers, readBody, runtime, log });
    }
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (sub === "history") return convo.historyRequest({ account, query });
    if (sub === "live") return convo.liveStreamRequest({ account, headers, query, router, log });
    return convo.streamRequest({ account, headers, query, router, log });
  }

  // ---- Memory (src/pages/webmemory.js): the list, correct / forget / a guess answered, and chat history (webhistory.js). Signed in only. ----
  if (sub === "memory" || /^memory\/(correct|forget|guess|history)$/.test(sub ?? "")) {
    if (!account) {
      if (String(headers.accept ?? "").includes("application/json")) {
        const body = JSON.stringify({ ok: false, error: "signed_out" });
        return { status: 401, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
      }
      return redirect("/web");
    }
    const { memoryRequest } = await import("./webmemory.js");
    return await memoryRequest({ account, action: sub === "memory" ? null : sub.slice("memory/".length), method, query, headers, readBody, log });
  }

  // ---- Saved (src/pages/websaved.js): the list, one item opened, the page itself framed, pin / remove / restore ----
  if (sub === "saved" || String(sub ?? "").startsWith("saved/")) {
    if (!account) {
      // Signed in to nobody (a page's wordmark brought them): sign in, then back to exactly this list.
      const next = method === "GET" ? nextFor(sub, query) : null;
      return redirect("/web", next ? { "Set-Cookie": nextCookieHeader(next) } : {});
    }
    const { savedRequest } = await import("./websaved.js");
    return await savedRequest({ account, path: sub === "saved" ? "" : sub.slice("saved/".length), method, query, headers, readBody, log });
  }

  // ---- The daily edition's question (src/pages/webdaily.js): answered → Memory, or put off. REASON_WEB_DAILY only. ----
  if (sub === "daily/answer" || sub === "daily/later") {
    if (!account) return redirect("/web");
    const { dailyRequest } = await import("./webdailyroutes.js");
    return await dailyRequest({ account, action: sub.slice("daily/".length), method, headers, readBody, log });
  }

  // ---- Stamps (src/pages/webstamps.js), behind REASON_WEB_DAILY: the book, a share made / stopped, the card saved ----
  if (sub === "stamps" || String(sub ?? "").startsWith("api/stamps/")) {
    if (account) {
      const { stampsRequest } = await import("./webstamps.js");
      const out = await stampsRequest({ account, path: sub === "stamps" ? "" : sub.slice("api/stamps/".length), method, query, headers, readBody, sec: SECURITY_HEADERS, log });
      if (out) return out;
    }
    // Not for this browser: exactly what these addresses answered before they existed — E1 for a GET,
    // the server's flat JSON 404 for anything else — so with the flag off nothing changed.
    if (method !== "GET" && method !== "HEAD") {
      const body = JSON.stringify({ error: "not found" });
      return { status: 404, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, body };
    }
    const { renderWebNotFound } = await import("./webedge.js");
    return page(404, renderWebNotFound({ signedIn: !!account }));
  }

  // ---- Settings (src/pages/websettings.js): the page, and its one POST for every control ----
  if (sub === "settings") {
    if (!account) return redirect("/web");
    const { settingsRequest } = await import("./websettings.js");
    return await settingsRequest({ account, method, query, headers, readBody, log });
  }

  // ---- the landing, or the sign-in form ----
  if (sub === null) {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (account) {
      // REASON_WEB_DAILY: Home is the daily edition. There is one conversation (owner 10-27 07:08), so
      // nothing here starts another; an old `?newchat` link is simply the thread.
      if (query.newchat != null) return redirect("/web?thread");
      const { dailyAllowedFor } = await import("../dailyflag.js");
      if (dailyAllowedFor(account.conversation_id)) {
        await (await import("../daily.js")).loadStamps();
      }
      // W2: signed in, /web IS the conversation (src/pages/webconvo.js).
      const { conversationPage } = await import("./webconvo.js");
      const drawn = conversationPage({ account, headers, sendId: randomUUID(), method, query });
      // A Web chat that is not theirs (src/pages/webconvo.js chatFrom) comes back as { status, body }.
      if (drawn && typeof drawn === "object") return page(drawn.status, drawn.body);
      return page(200, drawn, formToken ? { "Set-Cookie": clearFormCookie() } : {});
    }
    // A fresh form token for a browser that has none; the one it has otherwise, so two tabs agree.
    const token = formToken || randomBytes(16).toString("base64url");
    const set = formToken ? {} : { "Set-Cookie": formCookieHeader(token) };
    if (query.join != null) return page(200, renderJoin({ joinNumber }), set);
    // 6F: just signed out here, or this browser's Web session ran out (a cookie Reason no longer
    // knows). A live session that Web simply doesn't open (an event guest's) gets no such line.
    const presented = readCookie(headers?.cookie);
    const out = query.out != null || (!!presented && !db.pageSessionOwner(presented, SESSION_TTL_MS, { idleMs: WEB_IDLE_MS }));
    return page(200, renderSignin({ joinNumber, formToken: token, out }), set);
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
    // Every copy this browser sent (an older host-only one beside the shared one), not just the one read.
    for (const t of new Set([presented, ...readCookies(headers?.cookie)])) db.endPageSession(t);
    log({ web_signout: true });
    return redirect("/web?out=1", { "Set-Cookie": clearCookieHeader({ path: "/", headers }) });
  }

  // A signed-in browser posting a sign-in form: it is already in.
  if (account) return redirect("/web");

  // ---- the two sign-in steps share their guards ----
  // The form must be this browser's own: the secret in it is the one the form cookie carries, and
  // the request names one of Reason's hosts or nothing. Otherwise the page starts over, fresh.
  if (!sameOrigin(headers) || !formToken || !same(form.get("f"), formToken)) {
    log({ web_signin_refused: "origin_or_token" });
    const token = randomBytes(16).toString("base64url");
    return page(403, renderSignin({ joinNumber, formToken: token, error: { kind: "origin" } }), { "Set-Cookie": formCookieHeader(token) });
  }
  const number = String(form.get("number") ?? "").slice(0, 24);
  const actor = eventActor(headers, remoteAddress);
  // The code a browser asks for is that browser's: bound to its form secret (checked equal just
  // above), so a stranger typing this number neither kills nor reaches it (events.tryKeyedCode).
  const bound = events.signinBinding(`wform:${formToken}`);
  // Only an account Reason serves and the switch allows gets a text; everybody else gets the same
  // page. `who` is null for a number with no account, a paused one, or — in owner-only mode — anyone
  // but the owner, and nothing below can tell those apart from the outside.
  const who = accountForNumber(number);

  if (sub === "code") {
    // One answer for every miss — no account, not allowed, wrong, expired, used — and the only
    // limit ever said is this browser's own, so codes teach nothing about whose number it was.
    const tried = events.tryKeyedCode({ conversationId: who?.conversation_id ?? null, code: form.get("code"), personKey: who ? signinKey(who.conversation_id) : null, browserKey: `wsignb:${actor}`, bound });
    if (!tried.ok) {
      log({ web_signin_failed: tried.reason });
      const askedAt = /^\d{10,15}$/.test(String(form.get("t") ?? "")) ? Number(form.get("t")) : clock.now();
      if (tried.reason === "rate_limited") {
        const clear = db.pageAttemptsClearAt(`wsignb:${actor}`, { limit: events.SIGNIN_WRONG.perBrowser, windowMs: events.SIGNIN_WRONG.windowMs });
        return page(429, renderCode({ number, joinNumber, formToken, askedAt, error: { kind: "tries", waitMs: (clear ?? clock.now() + 60_000) - clock.now() } }));
      }
      // Expired is this browser's clock, not the code's: it asked longer ago than a code lives. The
      // same words for every number, so they say nothing about whose it is.
      const kind = clock.now() - askedAt > CODE_TTL_MS ? "expired" : "wrong";
      return page(200, renderCode({ number, joinNumber, formToken, askedAt, error: { kind, code: String(form.get("code") ?? "").replace(/\D/g, "").slice(0, 6) } }));
    }
    log({ web_signin_ok: true });
    // The session cookie on every path, so the browser is theirs on their pages and events too;
    // the form cookie has done its job. Signing in always lands on the arrival, never the thread (?home).
    // A list they were on the way to before signing in (NEXT_COOKIE) is where they land instead.
    const next = readNextCookie(headers?.cookie);
    const cookies = [cookieHeader(tried.token, { path: "/", headers }), clearFormCookie()];
    if (next) cookies.push(clearNextCookie());
    return { status: 303, headers: HTML({ Location: next ?? "/web?home", "Content-Length": 0, "Set-Cookie": cookies }), body: "" };
  }

  // sub === "signin": ask for a code.
  if (!events.signinGate(actor)) {
    const clear = db.signinRequestsClearAt(actor, { limit: events.SIGNIN_PER_BROWSER_HOUR, windowMs: 60 * 60_000 });
    return page(429, renderSignin({ number, joinNumber, formToken, error: { kind: "pause", waitMs: (clear ?? clock.now() + 60_000) - clock.now() } }));
  }
  // "Send a new code" from this browser, a fourth time in a quarter hour: the same ceiling every
  // person's codes have (three per fifteen minutes), counted on the browser so it says nothing about
  // the number. Nothing is sent; the last code (if there was one) still works.
  if (form.get("again") && db.signinRequestsSince(actor, clock.now() - RESEND.windowMs) >= RESEND.limit) {
    const last = db.lastSigninRequestAt(actor) ?? clock.now();
    return page(200, renderCode({ number, joinNumber, formToken, askedAt: last, error: { kind: "resend", leftMs: last + CODE_TTL_MS - clock.now() } }));
  }
  events.noteSigninRequest(actor);
  if (who) sendCode({ conversationId: who.conversation_id, runtime, log, bound });
  return page(200, renderCode({ number, joinNumber, formToken, askedAt: clock.now() }));
}
