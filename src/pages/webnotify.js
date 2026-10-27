// Notifications on Reason Web (design handoff v2, HANDOFF §4c item 8, reference sheet-notify-{paper,night}.html)
// and Web's own icons (§4e, assets/web/).
//
//   8A  the browser tab (v4 §4h item 5, sheet-small-details "The tab tells you"): while something needs
//       them the title is exactly "Reason · needs you" and the favicon is the needs-you mark, the
//       night one on Night (the theme they chose on Web, else the phone's); back to the page's own
//       title ("Reason") and the outlined mark the moment nothing does. Never details. No sound.
//   8B  on any other screen: one Caveat line at the top ("the hudson inn needs a yes · See it →"),
//       until they look at it. Never covers anything (it is in the page's flow, not floating).
//   8C  browser notifications, per browser, off by default (Settings, src/pages/websettings.js). When
//       on, one says only "Reason needs your approval."
//
// All three ride one small poll, GET /web/signal, every few seconds from any signed-in Web page
// (the website's proxy buffers a stream, so a poll is what reaches a tab there). The poll never
// counts as using the session: a forgotten background tab still signs out when it goes idle.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as db from "../db.js";
import { webAllowedFor } from "../web.js";
import { readCookie, SESSION_TTL_MS } from "./access.js";

// ---------------------------------------------------------------- icons
// The handoff's files (assets/ in the v2 zip), drawn in Reason's own pen (src/pages/brand.js): the
// outlined mark on a paper tile, the same mark filled while a background tab has something that needs
// them, the night pair (the links pick by prefers-color-scheme; on a signed-in page the script
// follows the theme they chose on Web), and the 180px home-screen icon exported to PNG.
const ICON_FILES = {
  "favicon.svg": "image/svg+xml",
  "favicon-night.svg": "image/svg+xml",
  "favicon-needs-you.svg": "image/svg+xml",
  "favicon-night-needs-you.svg": "image/svg+xml",
  "apple-touch-icon.png": "image/png",
};
const iconBytes = Object.fromEntries(Object.keys(ICON_FILES).map(f => [f, readFileSync(new URL(`../../assets/web/${f}`, import.meta.url))]));
/** A fingerprint of every Web icon, so a changed one is fetched again. */
export const WEB_ICON_VERSION = (() => { const h = createHash("sha256"); for (const f of Object.keys(ICON_FILES)) h.update(iconBytes[f]); return h.digest("hex").slice(0, 10); })();

/** GET /web/icons/<file>: one of Web's icons, cached a day; null for anything else. */
export function webIcon(file) {
  if (!Object.hasOwn(ICON_FILES, file)) return null;
  const body = iconBytes[file];
  return { status: 200, headers: { "Content-Type": ICON_FILES[file], "Content-Length": body.length, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }, body };
}

const iconHref = (f) => `/web/icons/${f}?v=${WEB_ICON_VERSION}`;
/**
 * The head's icons on every Web page. Each favicon carries its filled twin (`data-needs`), which the
 * notify script swaps in while a background tab has something that needs them.
 */
export function webIconLinks() {
  return `<link rel="icon" type="image/svg+xml" href="${iconHref("favicon.svg")}" data-calm="${iconHref("favicon.svg")}" data-needs="${iconHref("favicon-needs-you.svg")}" media="(prefers-color-scheme: light)">\n`
    + `<link rel="icon" type="image/svg+xml" href="${iconHref("favicon-night.svg")}" data-calm="${iconHref("favicon-night.svg")}" data-needs="${iconHref("favicon-night-needs-you.svg")}" media="(prefers-color-scheme: dark)">\n`
    + `<link rel="apple-touch-icon" href="${iconHref("apple-touch-icon.png")}">`;
}

// ---------------------------------------------------------------- the signal
/** What the open tab is told: what needs them (no details beyond the line 8B shows), what just finished, and this browser's setting. */
export const NOTIFY_TEXT = "Reason needs your approval.";
/** The tab's title while something needs them (§4h item 5), exactly. */
export const NEEDS_TITLE = "Reason \u00b7 needs you";
const shortTitle = (t) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s; };

/** The signal for one person and one browser. Read only: nothing here writes. */
export async function signalFor(conversationId, token) {
  const { ongoing } = await import("../ongoing.js");
  const m = ongoing(conversationId);
  const needs = [
    ...m.approvals.map(a => ({ id: `approval-${a.id}`, approval: true, line: a.nudge, href: a.href })),
    ...m.items.filter(x => x.needs && x.kind !== "approval").map(x => ({ id: `${x.kind}-${x.id}`, approval: false, line: "one thing needs an answer", href: x.href })),
  ];
  const done = m.back.filter(x => x.state === "ready" && Number.isFinite(x.due)).slice(0, 3)
    .map(x => ({ id: `${x.kind}-${x.id}`, title: shortTitle(x.title), at: x.due }));
  return { ok: true, needs, done, notify: db.pageSessionNotify(token) };
}

/** GET /web/signal. Signed in only (401 otherwise); never touches the session. */
export async function signalRequest({ method = "GET", headers = {}, idleMs = Infinity, securityHeaders = {} }) {
  const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders, "Content-Length": Buffer.byteLength(body) }, body }; };
  if (method !== "GET" && method !== "HEAD") return json(405, { ok: false, error: "method" });
  const token = readCookie(headers?.cookie);
  const conv = db.pageSessionPeek(token, SESSION_TTL_MS, { idleMs });
  if (!conv || !webAllowedFor(conv)) return json(401, { ok: false, error: "signed_out" });
  return json(200, await signalFor(conv, token));
}

// ---------------------------------------------------------------- the tab's script
// Runs on a signed-in page only (the server marks it with data-c). Every answer is compared with what
// this tab saw while it was in front of them: only what is new since then changes the title or the
// icon, and only while the tab is hidden. 8B's line uses what this browser has looked at (kept in
// localStorage), so it stays until they look, on every screen but the chat, which already shows it.
export const NOTIFY_CSS = `.nt-line{flex:0 0 auto;width:100%;margin:0;padding:14px 0;border-top:1px dashed var(--hair);border-bottom:1px dashed var(--hair);display:flex;justify-content:space-between;align-items:baseline;gap:10px}
@media (min-width:900px){.st>.nt-line{flex-basis:100%}}
.nt-line .hand{font-size:22px;min-width:0}
.nt-line a{flex:none;min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:italic 400 19px/1.2 var(--serif)}
`;
export const NOTIFY_JS = `(function(){var H=document.documentElement;if(!H.hasAttribute('data-c')||!window.fetch)return;
var TITLE=${JSON.stringify(NEEDS_TITLE)},base=document.title,links=[].slice.call(document.querySelectorAll('link[rel=icon][data-needs]')),saw=null,first=true,gone=false,timer=0,busy=false,again=false;
function get(k){try{return JSON.parse(localStorage.getItem(k)||'[]')}catch(e){return[]}}function put(k,v){try{localStorage.setItem(k,JSON.stringify(v.slice(-50)))}catch(e){}}
function night(){var t=H.dataset.theme;return t==='dark'||(t!=='light'&&!!window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)}
var P=links.filter(function(l){return!/dark/.test(l.media||'')})[0],N=links.filter(function(l){return/dark/.test(l.media||'')})[0],needy=false;
function icon(n){needy=n;var s=night()?N:P;if(!s)return;var h=n?s.dataset.needs:s.dataset.calm;links.forEach(function(l){if(l.getAttribute('href')!==h)l.setAttribute('href',h)})}
function calm(){if(document.title!==base)document.title=base;icon(false)}
icon(false);document.addEventListener('reason-theme',function(){icon(needy)});
var chat=location.pathname==='/web'||location.pathname==='/web/';
function line(needs){var seen=get('reason-web-seen'),here=needs.filter(function(n){return chat||location.pathname===n.href});
if(here.length){here.forEach(function(n){if(seen.indexOf(n.id)<0)seen.push(n.id)});put('reason-web-seen',seen)}
var el=document.querySelector('.nt-line'),n=chat?null:needs.filter(function(x){return seen.indexOf(x.id)<0})[0];
if(!n){if(el)el.remove();return}
if(!el){var main=document.querySelector('main');if(!main)return;el=document.createElement('div');el.className='nt-line';el.setAttribute('role','status');el.innerHTML='<span class="hand"></span><a>See it <span aria-hidden="true">\\u2192</span></a>';main.insertBefore(el,main.firstChild);if(!first&&window.reasonInk)reasonInk(el.querySelector('.hand'),'pen-in')}
el.querySelector('.hand').textContent=n.line;var a=el.querySelector('a');a.href=n.href;a.onclick=function(){var s=get('reason-web-seen');s.push(n.id);put('reason-web-seen',s)}}
function tell(j){var ids=j.needs.map(function(n){return n.id});if(saw===null||!document.hidden)saw=ids;
var fresh=j.needs.filter(function(n){return saw.indexOf(n.id)<0});
if(j.needs.length){if(document.title!==TITLE)document.title=TITLE;icon(true)}else calm();
if(j.notify&&document.hidden&&window.Notification&&Notification.permission==='granted'){var told=get('reason-web-notified'),ask=fresh.filter(function(n){return n.approval&&told.indexOf(n.id)<0});
if(ask.length){ask.forEach(function(n){told.push(n.id)});put('reason-web-notified',told);try{new Notification('Reason',{body:${JSON.stringify(NOTIFY_TEXT)},tag:'reason-needs-you',silent:true})}catch(e){}}}
line(j.needs);first=false}
function look(){clearTimeout(timer);if(gone)return;if(busy){again=true;return}busy=true;fetch('/web/signal',{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){gone=true;throw 0}return r.json()}).then(function(j){if(j&&j.ok)tell(j)}).catch(function(){}).then(function(){busy=false;clearTimeout(timer);if(gone)return;if(again){again=false;look()}else timer=setTimeout(look,document.hidden?4000:12000)})}
document.addEventListener('visibilitychange',look);look()})();`;
