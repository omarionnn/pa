// Reason Web Settings (design handoff 2026-10-26, HANDOFF.md "6 · Settings"; reference
// desk-settings-{paper,night}.html and sheet-settings-{paper,night}.html 8A/8B), with the v2 edit
// states (handoff v2 §4c items 5 and 8, sheet-settings-edit 5A–5D, sheet-notify 8C) and §4d L8.
//
// One calm page, every control real, every one a plain form that posts here and comes back (no
// script needed); the theme also switches in place when script runs. Everything is the SESSION's
// person's: nothing in a form can name another conversation, a browser or an invite that is not theirs.
//
//   How Reason reaches you   accounts.web_reach, one of four (db.WEB_REACH_VALUES), honoured by
//                            src/deliver.js keptOnWeb: everything ('text', the default and how Reason
//                            always worked) · timely decisions ('web': a finished job's result stays on
//                            Web) · only what needs a yes ('yes') · nothing ('none'). Each dashed phrase
//                            opens 5A, the radio list, at ?edit=reach; Save → shows 5B, the new sentence.
//   Signed-in browsers       page_sessions for this person, with the browser each was last used from
//                            (page_sessions.user_agent); SIGN OUT deletes that row, so its cookie
//                            opens nothing anywhere; "Sign out everywhere" asks first (5C, ?confirm=
//                            everywhere, with the real count), then deletes every one, this too.
//   Browser notifications    page_sessions.web_notify, per browser, off by default (8C); turned on
//                            only after the browser's own permission is granted.
//   Connected                read only, from each integration's own store.
//   Invites                  src/invites.js: what is left, every link with its state, make one (5D,
//                            ?invite=<id>: the link to copy or share), cancel an unused one.
//   Shopping                 src/shopconnect.js (REASON_SHOP_CONNECT): the stores they signed into for
//                            checkouts (StoreManage: SIGN OUT), and the card kept for them (CardManage:
//                            last used, Replace card →, Forget it → the confirm, ?confirm=card, drawn
//                            inside this section: CardRemove). Drawn with src/pages/paperkit.js.
//   Theme                    accounts.web_theme, so every browser opens in it (webkit accountThemed).
//                            The only theme switch on Web.
import { createHash, timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import * as invites from "../invites.js";
import * as agentcard from "../agentcard.js";
import * as shop from "../shopconnect.js";
import { invitesOpenFor } from "../tools.js";
import { config, clock } from "../config.js";
import { readCookie, clearCookieHeader, SESSION_TTL_MS } from "./access.js";
import { esc, renderNotFound } from "./render.js";
import { webPage, wordmark, hand, stamp } from "./webkit.js";
import { PAPER_CSS, paper, go, two, forget, actions } from "./paperkit.js";
import { sameOrigin, SECURITY_HEADERS, WEB_IDLE_MS } from "./websignin.js";

/**
 * "Sensitive texts only say 'Reason needs your approval.' The details wait here, behind sign-in."
 * Not true today: an approval is asked in the text itself, with its details (src/tools.js confirm
 * gate). The line is drawn only once it is true (SCOPE.md, question for Omari).
 */
export const PRIVATE_BY_DEFAULT = false;

/**
 * The four ways Reason can reach you, in the order 5A lists them: the phrase the sentence says, the
 * one plain line under it, what the sentence keeps here, and the Caveat line once it is saved.
 */
export const REACH = {
  web: { name: "timely decisions", line: "Approvals and anything with a deadline today.", keep: "routine results", saved: "got it. i'll text when something can't wait." },
  text: { name: "everything", line: "Every update, as it happens.", keep: "a copy", saved: "got it. i'll text you everything, and keep a copy here." },
  yes: { name: "only what needs a yes", line: "Approvals only. Everything else waits here.", keep: "everything else", saved: "got it. i'll only text when i need a yes." },
  none: { name: "nothing", line: "Keep it all on the web.", keep: "it all", saved: "got it. i'll keep it all here." },
};
export const REACH_ORDER = ["web", "text", "yes", "none"];
/** "Text me for timely decisions. Keep routine results here." with each part drawn by `part`. */
const reachSentence = (reach, part = (t) => esc(t)) => `Text me for ${part(REACH[reach].name)}. Keep ${part(REACH[reach].keep)} here.`;

/** "Chrome on Mac", from a browser's user agent. */
export function deviceName(ua) {
  const u = String(ua ?? "");
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android"
    : /CrOS/.test(u) ? "Chromebook" : /Macintosh|Mac OS X/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "";
  const br = /Edg(?:A|iOS)?\//.test(u) ? "Edge" : /OPR\/|Opera/.test(u) ? "Opera" : /SamsungBrowser/.test(u) ? "Samsung Internet"
    : /Firefox\/|FxiOS/.test(u) ? "Firefox" : /Chrome\/|CriOS/.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "";
  if (br && os) return `${br} on ${os}`;
  if (br) return br;
  return os ? `A browser on ${os}` : "Unknown browser";
}

/** NOW · 12 MIN AGO · 2 HOURS AGO · OCT 19, for when a browser was last used. */
export function lastActive(at, now = clock.now()) {
  const ago = Math.max(0, now - at);
  if (ago < 2 * 60_000) return "NOW";
  if (ago < 60 * 60_000) return `${Math.floor(ago / 60_000)} MIN AGO`;
  if (ago < 24 * 60 * 60_000) { const h = Math.floor(ago / 3_600_000); return `${h} HOUR${h === 1 ? "" : "S"} AGO`; }
  return new Date(at).toLocaleString("en-US", { timeZone: config.tz, month: "short", day: "numeric" }).toUpperCase();
}

/** A browser's handle on this page: a hash of its session, never the session itself. */
export const sessionHandle = (token) => createHash("sha256").update(String(token)).digest("base64url").slice(0, 22);

/** The integrations shown, in the handoff's order, each read from its own store for this person only. */
export function connections(conversationId) {
  const card = db.getAgentcardUser(conversationId);
  const has = (provider) => db.listOauthTokens(conversationId, provider).length > 0;
  return [
    { name: "AGENTCARD", phone: "CARD · AGENTCARD", on: !!card?.user_id && agentcard.connectionState(card).state !== "dead" },
    { name: "GOOGLE", on: has("google") },
    { name: "SPOTIFY", on: has("spotify") },
    { name: "UBER", on: has("uber") },
    { name: "GITHUB", on: has("github") },
    { name: "ICLOUD", on: has("apple_calendar") },
  ].filter(c => c.on);
}

const STAMP = { redeemed: ["JOINED", "pen"], unused: ["UNUSED", "ink"], canceled: ["CANCELED", "muted"] };
/** "files.heyreason.com/i/Ab3dE9…": a link as the list shows it. The whole link is the href, while it works. */
const shortLink = (token, n = 6) => invites.inviteUrl(String(token).slice(0, n)).replace(/^https?:\/\//, "") + "…";

// ---------------------------------------------------------------- the page
const CSS = `
.st-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px var(--gut) 0}
.st{flex:1 0 auto;width:100%;max-width:1080px;margin:0 auto;padding:32px var(--gut) 48px;display:flex;flex-direction:column;gap:40px}
.st-side{display:flex;flex-direction:column;gap:4px}
.st-h1{margin:0;font:italic 400 44px/1.05 var(--serif);letter-spacing:-.02em}
.st-nav{display:none}
.st-main{display:flex;flex-direction:column;gap:40px;min-width:0}
.st-sec{display:flex;flex-direction:column;gap:14px;padding-bottom:32px;border-bottom:1px dashed var(--hair);scroll-margin-top:24px}
.st-sec h2{margin:0;font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.st-sec form,.sub form{margin:0}
.reach-p{margin:0;font:400 26px/1.35 var(--serif)}
.ph{position:relative;border-bottom:1px dashed var(--ink);text-decoration:none;font-style:italic;color:var(--ink)}
.ph::after{content:"";position:absolute;left:0;right:0;top:50%;min-height:44px;transform:translateY(-50%);height:100%}
.ph:hover{color:var(--hov);border-bottom-color:var(--hov)}
.st-sec .hand{font-size:21px}
.priv{margin:0;font-size:16px;line-height:1.55}
.priv .q{font:400 14px/1.4 var(--mono)}
#browsers{gap:4px}
#browsers h2{margin-bottom:6px}
.br-row{padding:12px 0;border-bottom:1px dashed var(--hair);display:flex;justify-content:space-between;align-items:center;gap:12px}
.br-row.here{align-items:baseline}
.br-who{display:flex;flex-direction:column;gap:2px;min-width:0}
.br-dev{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.br-when{font:400 11px/1.4 var(--mono);letter-spacing:.08em;color:var(--muted)}
.br-here{font:400 19px/1.2 var(--hand);color:var(--pen);white-space:nowrap}
.br-out{font-size:11px;letter-spacing:.14em}
.every{align-self:flex-start;margin-top:10px;min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:italic 400 21px/1.2 var(--serif);color:var(--pen)}
.every:hover{color:var(--hov)}
.nt-p{margin:0;font:400 26px/1.35 var(--serif)}
.nt-q{margin:0;font-size:15px;line-height:1.55;color:var(--muted)}
.nt-on{align-self:flex-start;min-height:48px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 22px/1.2 var(--serif);color:var(--ink)}
.nt-on[hidden],.st [hidden],.sub [hidden]{display:none}
.st-sec .nt-ask,.sub .nt-ask{font-size:20px}
.nt-ex{padding-top:18px;border-top:1px dashed var(--hair);display:flex;flex-direction:column;gap:8px}
.nt-ex .lbl{font-size:11px;white-space:normal}
.nt-card{padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.nt-card b{font-size:14px;font-weight:600}
.nt-card span{font-size:14px;line-height:1.45}
#connected{gap:4px}
#connected h2{margin-bottom:6px}
.cn{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px 12px;align-items:baseline}
.cn li{display:contents}
.cn-n{font:400 14px/1.4 var(--mono);letter-spacing:.06em}
.cn-s{font:400 19px/1.2 var(--hand);color:var(--pen)}
.shp-h{margin:0;font:italic 400 26px/1.3 var(--serif)}
.shp-h em{color:var(--muted)}
.shp-p{margin:0;font-size:16px;line-height:1.6;color:var(--muted);max-width:34em}
#shopping .pf-rows{margin-top:4px}
#shopping .pf-row{padding:16px 0}
.shp-n{margin:0;font-size:16px;font-weight:600}
.shp-v{margin:6px 0 0;font:400 22px/1.3 var(--mono);letter-spacing:.08em}
.shp-u{margin:6px 0 0;font-size:16px}
.shp-b{display:flex;flex-direction:column;gap:14px}
.shp-b+.shp-b{margin-top:28px}
#shopping .pf-go,#shopping .pf-x{font-size:26px}
#shopping .pf-paper{margin-top:8px;max-width:420px}
#shopping .pf-acts{margin-top:4px}
.st-quiet{margin:10px 0 0;font-size:14px;line-height:1.5;color:var(--muted)}
#invites{gap:4px}
.inv-n{margin:6px 0 10px;font:italic 400 38px/1 var(--serif)}
.inv{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.inv li{padding:10px 0;border-top:1px dashed var(--hair);display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.inv-l{font:400 12px/1.4 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
a.inv-l{min-height:44px;display:inline-flex;align-items:center}
.inv-l.gone{color:var(--muted)}
.inv .stamp{flex:none;align-self:center;font-size:10.5px;padding:3px 7px}
a.inv-l{text-decoration-color:var(--hair);text-underline-offset:3px}
a.iv-link{text-decoration:none}
.inv .stamp-ink{transform:rotate(2deg)}.inv .stamp-muted{transform:rotate(-2deg)}
.inv-x{font-size:11px;color:var(--muted)}
.make{align-self:flex-start;margin-top:8px;min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 21px/1.2 var(--serif);color:var(--ink)}
.make:hover{color:var(--hov)}
#theme{border-bottom:0;padding-bottom:0;gap:40px}
.th-box{display:flex;flex-direction:column;gap:10px;padding-bottom:32px;border-bottom:1px dashed var(--hair)}
.th-g{display:flex;gap:22px;align-items:baseline;flex-wrap:wrap}
.th-g button{min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 26px/1.2 var(--serif);color:var(--muted)}
.th-g button[aria-checked=true]{color:var(--ink)}
.th-g .dot{color:var(--hair)}
.th-g{position:relative}
.th-u{position:absolute;left:0;top:0;width:1px;height:1.5px;background:var(--ink);transform-origin:0 0;pointer-events:none}
.st-arr{display:none}
.out{font-size:12px;letter-spacing:.14em;align-self:flex-start}
.d-only{display:none}
.busy,.busy:hover{color:var(--muted);cursor:default;pointer-events:none}
.sub-head{width:100%;max-width:640px;margin:0 auto;padding:16px var(--gut) 0}
.sub-head .act2{font-size:12px}
.sub{flex:1 0 auto;width:100%;max-width:640px;margin:0 auto;padding:28px var(--gut) 20px;display:flex;flex-direction:column;justify-content:flex-start;gap:22px}
.sub.mid{justify-content:center;gap:24px}
.sub.iv,.sub.nt{gap:20px}.sub.nt{gap:18px}
.sub-l{margin:0;font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.re-f{display:flex;flex-direction:column;gap:22px}
.re-p{margin:0;font:400 26px/1.35 var(--serif)}
.re-p em{border-bottom:1.5px solid var(--ink)}
.ro-g{display:flex;flex-direction:column}
.ro{position:relative;min-height:52px;border-bottom:1px dashed var(--hair);padding:10px 0;display:flex;align-items:baseline;gap:12px;cursor:pointer;color:var(--ink)}
.ro input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.ro:focus-within{outline:2px solid var(--ink);outline-offset:3px}
.ro:has(input:focus:not(:focus-visible)){outline:none}
.ro-d{width:18px;flex:none;font:400 14px/1 var(--mono);color:var(--pen)}
.ro-d::before{content:"\\25CB"}
.ro input:checked~.ro-d::before{content:"\\25CF"}
.ro-t{display:flex;flex-direction:column;gap:2px}
.ro-n{font:italic 400 21px/1.2 var(--serif);color:var(--muted)}
.ro input:checked~.ro-t .ro-n{color:var(--ink)}
.ro-l{font-size:13px;line-height:1.4;color:var(--muted)}
.sub-a{display:flex;gap:28px;align-items:center}
.sub-go{align-self:flex-start;min-height:48px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 24px/1.2 var(--serif);color:var(--ink);text-decoration:none;display:inline-flex;align-items:center}
.sub-go:hover{color:var(--hov)}
.sub-c{font-size:11.5px;color:var(--muted)}
.sub .hand.tilt{font-size:22px}
.so-card{padding:26px 22px;display:flex;flex-direction:column;gap:14px}
.so-card .sub-l{color:var(--pen)}
.so-n{margin:0;font:italic 400 28px/1.15 var(--serif)}
.so-p{margin:0;font-size:15px;line-height:1.55}
.so-card .sub-a{padding-top:4px}
.so-card .sub-go{font-size:22px;color:var(--pen)}
.so-card .sub-c{color:var(--ink)}
.iv-n{margin:0;font:italic 400 38px/1 var(--serif)}
.iv-card{padding:20px;display:flex;flex-direction:column;gap:12px}
.iv-card .lbl{font-size:10px}
.iv-link{font:400 18px/1.35 var(--mono);letter-spacing:.04em;overflow-wrap:anywhere;color:var(--ink)}
.iv-card .sub-go{font-size:22px}
.iv-card .sub-c{color:var(--ink)}
.iv-note{margin:0;font-size:14px;line-height:1.5;color:var(--muted)}
@media (max-width:359px){.reach-p,.re-p,.nt-p{font-size:23px}}
@media (min-width:900px){
.st-head{padding:22px clamp(20px,4vw,48px)}
.st{flex-direction:row;flex-wrap:wrap;gap:80px;align-items:flex-start;padding:48px clamp(20px,4vw,48px) 64px}
.st-side{flex:1 1 200px;max-width:220px;position:sticky;top:24px}
.st-h1{margin:0 0 24px;font-size:48px;line-height:1;letter-spacing:0}
.st-nav{display:flex;flex-direction:column;gap:4px}
.st-nav a{min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:400 12px/1.3 var(--mono);letter-spacing:.14em;color:var(--muted)}
.st-nav a[aria-current]{color:var(--ink)}
.st-nav a[aria-current]::before{content:"\\2192\\00a0"}
.st-nav.sprung{position:relative}
.st-nav.sprung a[aria-current]::before{visibility:hidden}
.st-arr{display:flex;align-items:center;position:absolute;left:0;top:0;height:44px;font:400 12px/1 var(--mono);color:var(--ink);pointer-events:none}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
.st-main{flex:999 1 520px;gap:56px;padding-top:8px}
.st-sec{gap:16px;padding-bottom:48px}
.st-sec h2{font-size:12px}
.reach-p{font-size:34px;line-height:1.3;max-width:18em}
.st-sec .hand{font-size:23px}
.priv{margin-top:12px;max-width:34em}
.priv .q{font:inherit}
#browsers,#connected,#invites{gap:0}
#browsers h2{margin-bottom:8px}
.br-row,.br-row.here{display:grid;grid-template-columns:minmax(0,1fr) 160px 120px;align-items:center;padding:14px 0;gap:16px}
.br-who{display:contents}
.br-dev{font-size:16px}
.br-when{font-size:12px;letter-spacing:0}
.br-here{font-size:20px;text-align:right}
.br-row form{justify-self:end}
.every{margin-top:14px;font-size:22px}
.nt-p{font-size:30px;max-width:20em}
.nt-q{max-width:34em}
.nt-ex{max-width:420px}
#connected{gap:14px}
#connected h2{margin-bottom:0}
.cn{grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 24px}
.cn li{display:flex;flex-direction:column;gap:2px}
.st-quiet{margin-top:6px}
#invites{gap:6px}
.inv-n{margin:8px 0 12px;font-size:44px}
.inv{flex-direction:row;flex-wrap:wrap;gap:28px}
.inv li{border-top:0;padding:0;justify-content:flex-start}
.inv-l{font-size:13px}
.make{margin-top:16px;font-size:22px}
#theme{flex-direction:row;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:24px}
.th-box{padding-bottom:0;border-bottom:0}
.th-g button{font-size:30px}
.m-only{display:none}.d-only{display:inline}
.sub-head{padding-top:28px}
.sub{padding-top:40px}
}
`;

// The theme switches in place (kit window.reasonTheme, which also saves it for every browser), the
// radio group moves by arrow keys, and the index's → follows the section in view (it used to follow only
// the hash, so a page reached at #invites kept → INVITES however far you scrolled), held on a jumped-to
// section until the reader scrolls themselves. The line a section must cross sits 30% down and slides
// to the bottom over the last stretch of the page, so short sections at the end each get their turn. An action's words
// turn present tense, muted, and it can't be pressed twice (§4d L8). 5A's sentence follows the
// choice; 5D copies and shares the link; 8C asks the browser before it saves anything. All of it over
// forms that already work without script, and nothing drawn that can't work (no dead controls).
const JS = `(function(){var g=document.querySelector('.th-g'),H=document.documentElement;
var S=window.reasonSpring,ul=function(){},arTo=function(){};
function mark(){var t=H.dataset.theme,cur=t==='light'?'paper':t==='dark'?'night':'auto';g.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-checked',String(b.value===cur));b.tabIndex=b.value===cur?0:-1})}
if(g&&S){var u=document.createElement('span'),uy=0;u.className='th-u';u.setAttribute('aria-hidden','true');g.appendChild(u);
var ux=S(0,paint),uw=S(0,paint);function paint(){u.style.transform='translate('+ux.value+'px,'+uy+'px) scaleX('+uw.value+')'}
ul=function(jump){var b=g.querySelector('button[aria-checked="true"]');if(!b)return;uy=b.offsetTop+b.offsetHeight-10;if(jump){ux.set(b.offsetLeft);uw.set(b.offsetWidth)}else{ux.to(b.offsetLeft);uw.to(b.offsetWidth)}}}
if(g){mark();ul(true);g.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||!window.reasonTheme)return;e.preventDefault();window.reasonTheme(b.value);mark();ul(false);b.focus()});
g.addEventListener('keydown',function(e){var k=e.key,bs=[].slice.call(g.querySelectorAll('button')),i=bs.indexOf(document.activeElement);if(i<0)return;var n=k==='ArrowRight'||k==='ArrowDown'?(i+1)%bs.length:k==='ArrowLeft'||k==='ArrowUp'?(i+bs.length-1)%bs.length:-1;if(n<0)return;e.preventDefault();bs[n].click()})}
var nv=document.querySelector('.st-nav');
if(nv&&S){var ar=document.createElement('span');ar.className='st-arr';ar.setAttribute('aria-hidden','true');ar.textContent='\\u2192';nv.classList.add('sprung');nv.appendChild(ar);
var ay=S(0,function(v){ar.style.transform='translateY('+v+'px)'});arTo=function(jump){var a=nv.querySelector('a[aria-current]');if(!a)return;var y=a.offsetTop+(a.offsetHeight-44)/2;if(jump)ay.set(y);else ay.to(y)}}
function snap(){ul(true);arTo(true)}window.addEventListener('resize',snap,{passive:true});if(document.fonts&&document.fonts.ready)document.fonts.ready.then(snap);
var nav=[].slice.call(document.querySelectorAll('.st-nav a')),secs=nav.map(function(a){return document.getElementById(a.getAttribute('href').slice(1))}).filter(Boolean),held=null;
function cur(id){nav.forEach(function(a){if(a.getAttribute('href')==='#'+id)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current')});arTo(false)}
function left(){return document.documentElement.scrollHeight-innerHeight-scrollY}
function spy(){if(held||!secs.length)return;var band=innerHeight*.7,line=innerHeight-band*Math.min(1,Math.max(0,left())/band),id=secs[0].id;secs.forEach(function(s){if(s.getBoundingClientRect().top<line+1)id=s.id});cur(id)}
function hold(){var s=secs.filter(function(s){return '#'+s.id===location.hash})[0];if(s){held=s.id;cur(s.id)}}
function free(){if(held){held=null;spy()}}
if(secs.length){hold();arTo(true);window.addEventListener('hashchange',hold);nav.forEach(function(a){a.addEventListener('click',function(){held=a.getAttribute('href').slice(1);cur(held)})});
['wheel','touchstart','keydown','mousedown'].forEach(function(t){window.addEventListener(t,free,{passive:true})});
var io=window.IntersectionObserver&&new IntersectionObserver(spy,{rootMargin:'0px 0px -70% 0px'});if(io)secs.forEach(function(s){io.observe(s)});
window.addEventListener('scroll',function(){if(!io||left()<innerHeight*.7)spy()},{passive:true})}
function busy(b,on){if(!b)return;if(on){b.dataset.was=b.innerHTML;if(b.dataset.busy)b.textContent=b.dataset.busy;b.setAttribute('aria-disabled','true');b.classList.add('busy')}else if(b.dataset.was!=null){b.innerHTML=b.dataset.was;b.removeAttribute('aria-disabled');b.classList.remove('busy')}}
document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){if(f.dataset.sent){e.preventDefault();return}f.dataset.sent='1';busy(e.submitter||f.querySelector('[type=submit]'),true)})});
window.addEventListener('pageshow',function(e){if(!e.persisted)return;document.querySelectorAll('form[data-sent]').forEach(function(f){delete f.dataset.sent;f.querySelectorAll('.busy').forEach(function(b){busy(b,false)})})});
var pick=document.querySelector('.re-pick');if(pick)document.querySelectorAll('.ro input').forEach(function(i){i.addEventListener('change',function(){pick.textContent=i.dataset.name})});
var link=document.querySelector('.iv-link');if(link){var cp=document.querySelector('.iv-copy'),sh=document.querySelector('.iv-share'),said=document.querySelector('.iv-said'),url=link.getAttribute('href');
if(cp&&navigator.clipboard&&window.isSecureContext){cp.hidden=false;cp.addEventListener('click',function(){navigator.clipboard.writeText(url).then(function(){said.textContent=said.dataset.ok;said.hidden=false},function(){said.textContent=said.dataset.no;said.hidden=false})})}
if(sh&&navigator.share){sh.hidden=false;sh.addEventListener('click',function(){navigator.share({url:url}).catch(function(){})})}}
var on=document.querySelector('.nt-on'),no=document.querySelector('.nt-no');
function say(t){if(no){no.textContent=t;no.hidden=false}}
if(on){if(!window.Notification)say(no.dataset.cant);else{on.hidden=false;var ask=document.querySelector('.nt-ask');if(ask)ask.hidden=false;
on.addEventListener('click',function(){if(on.classList.contains('busy'))return;busy(on,true);
new Promise(function(ok){var r=Notification.requestPermission(ok);if(r&&r.then)r.then(ok)}).then(function(p){if(p!=='granted')throw 'no';return fetch('/web/settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:'do=notify&on=1&c='+encodeURIComponent(H.getAttribute('data-c')||'')}).then(function(r){if(!r.ok)throw 'x';location.href=on.dataset.then})})
.catch(function(e){busy(on,false);say(e==='no'?no.dataset.denied:no.dataset.failed)})})}}
var blocked=document.querySelector('.nt-blocked');if(blocked&&(!window.Notification||Notification.permission!=='granted'))blocked.hidden=false;
})();`;

const SECTIONS = [["reach", "HOW I REACH YOU"], ["browsers", "BROWSERS"], ["notify", "NOTIFICATIONS"], ["connected", "CONNECTED"], ["shopping", "SHOPPING"], ["invites", "INVITES"], ["theme", "THEME"]];
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const post = (csrf, what, inner, cls = "") => `<form method="POST" action="/web/settings"${cls ? ` class="${cls}"` : ""}>${hidden("c", csrf)}${hidden("do", what)}${inner}</form>`;
const saved = (on, words = "got it.") => (on ? hand(words, { role: "status" }) : "");
const arrow = `<span aria-hidden="true">→</span>`;

/** "3 browsers, including this one." — the count 5C confirms, every live sign-in of theirs. */
export const browsersLine = (n) => (n <= 1 ? "1 browser: this one." : `${n} browsers, including this one.`);

/**
 * 8C: browser notifications for THIS browser. `on` is this browser's own setting. Off by default;
 * "Turn on in this browser →" is drawn only where script can ask the browser (no dead control), and
 * nothing is saved until the browser says yes. Their reach decides the sentence's "instead".
 */
export function notifyBody({ csrf, reach = "text", on = false, done = "", sub = false }) {
  const instead = reach === "none" ? "Off. Everything waits here instead." : `Off. Reason texts you for <em>${esc(REACH[reach]?.name ?? REACH.text.name)}</em> instead.`;
  const back = sub ? "/web/settings?edit=notify&done=notify" : "/web/settings?done=notify#notify";
  const state = on
    ? `<p class="nt-p">On in this browser.</p><p class="nt-q">While it's open, this browser tells you when something needs a yes. Nothing else, and no sound.</p>`
      + `<p class="hand nt-blocked" role="status" hidden>this browser isn't allowing them right now. allow them in its settings.</p>`
      + post(csrf, "notify", `${hidden("on", "0")}${hidden("back", sub ? "sub" : "")}<button class="act2" type="submit" data-busy="TURNING OFF…">TURN OFF IN THIS BROWSER</button>`)
      + saved(done === "notify")
    : `<p class="nt-p">${instead}</p><p class="nt-q">Turn these on if you'd rather hear from Reason in this browser than by text, while it's open.</p>`
      + `<button class="nt-on" type="button" hidden data-busy="Turning on…" data-then="${esc(back)}">Turn on in this browser ${arrow}</button>`
      + `<p class="hand tilt nt-ask" hidden>your browser will ask first.</p>`
      + `<p class="hand nt-no" role="status" hidden data-cant="this browser can't show them. reason will keep texting you instead." data-denied="your browser said no. you can allow them in its settings, then try again." data-failed="that didn't save. try again in a moment."></p>`
      + saved(done === "notify-off");
  return state
    + `<div class="nt-ex"><span class="lbl">WHEN THEY'RE ON, ONE SAYS ONLY</span><div class="card nt-card"><b>Reason</b><span>Reason needs your approval.</span></div></div>`;
}

/**
 * The whole page for one person. `browsers` are this person's sessions (`current` = this browser's
 * token); `invitesView` is invites.myInvites or null when invites are not open to them; `notify` is
 * this browser's own notifications setting.
 */
/**
 * Shopping (card and store sign-in handoff, StoreManage + CardManage + CardRemove, owner 10-30): each
 * store they signed into, with SIGN OUT; the card on file with where it was last used, Replace card →
 * and Forget it, which asks first (`confirmCard`, ?confirm=card) right here in the section. Never a
 * store logo, never their email, never an expiry, and never Crossmint's name. `shopping` is null when
 * the flag keeps it from this person (the section is not drawn).
 */
export function shoppingSection({ csrf, shopping, done = "", confirmCard = false }) {
  const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: config.tz });
  const lbl = (t, pen = false) => `<span class="pf-l${pen ? " pen" : ""}">${esc(t)}</span>`;
  const stores = shopping.stores.length
    ? `<div class="pf-rows">${shopping.stores.map((s) => `<div class="pf-row"><div><p class="shp-n">${esc(s.name)}</p>${lbl(`SIGNED IN SINCE ${day(s.connectedAt).toUpperCase()}`)}</div>`
      + post(csrf, "store-remove", `${hidden("s", s.store)}<button class="act2 pf-two" type="submit" data-busy="SIGNING OUT…" aria-label="Sign out of ${esc(s.name)}">SIGN OUT</button>`) + `</div>`).join("")}</div>`
    : `<p class="st-quiet">No stores yet. When a store needs you signed in to check out, I'll text you a link.</p>`;
  const storeBlock = `<div class="shp-b"><p class="shp-h">Your stores. <em>Where I can check out.</em></p>`
    + `<p class="shp-p">Signing out stops me buying there. Your account on the store doesn't change.</p>${stores}</div>`;
  const c = shopping.card;
  const cardText = c ? `${(c.brand || "card").toUpperCase()} •••• ${c.last4 || "····"}` : "";
  let cardBlock;
  if (c && confirmCard) {
    cardBlock = `<div class="shp-b" role="group" aria-labelledby="cr-h"><p class="shp-h" id="cr-h">Forget this card? <em>I won't be able to buy anything.</em></p>`
      + `<p class="shp-p">To buy something later, you'd add a card again.</p>${paper({ label: "CARD", big: cardText })}`
      + actions(post(csrf, "card-remove", forget("Forget it", { attrs: ` data-busy="FORGETTING…"` })), two("KEEP IT", { href: "/web/settings#shopping" }))
      + `<p class="shp-p">Anything already bought still arrives. This only stops new checkouts.</p></div>`;
  } else if (c) {
    const used = shopping.lastUsed;
    cardBlock = `<div class="shp-b"><p class="shp-h">Your card. <em>One on file.</em></p>`
      + `<p class="shp-p">The card I pay with at checkout, only after you text yes to the total.</p>`
      + `<div class="pf-rows"><div class="pf-row"><div>${lbl("CARD")}<p class="shp-v">${esc(cardText)}</p></div>${lbl("IN USE")}</div>`
      + (used ? `<div class="pf-row"><div>${lbl("LAST USED")}<p class="shp-u">${esc([used.store, day(used.at)].filter(Boolean).join(" · "))}</p></div></div>` : "")
      + `</div>${actions(go("Replace card", { href: "/web/connect/new-card" }), forget("Forget it", { href: "/web/settings?confirm=card#shopping" }))}`
      + `<p class="shp-p">One card at a time. Replacing it swaps the old card out. Anything already ordered still arrives.</p></div>`;
  } else {
    cardBlock = `<div class="shp-b"><p class="shp-h">Your card. <em>None yet.</em></p>${actions(go("Add a card", { href: "/web/connect/new-card" }))}</div>`;
  }
  return `<section class="st-sec" id="shopping" aria-labelledby="sh-h"><h2 id="sh-h">SHOPPING</h2>${storeBlock}${cardBlock}`
    + `<p class="st-quiet">Store passwords are sealed and go straight to the store. Your card is kept securely; I only see its brand and last four. Signing out of your last store erases every saved sign-in.</p>`
    + saved(done === "store-removed", "signed out. i won't use it again.") + saved(done === "card-removed", "card forgotten.")
    + `</section>`;
}

export function renderSettings({ csrf, reach = "text", browsers = [], current = "", connected = [], invitesView = null, shopping = null, theme = null, notify = false, done = "", confirmCard = false, now = clock.now() }) {
  if (!REACH[reach]) reach = "text";
  const ph = (t) => `<a class="ph" href="/web/settings?edit=reach" aria-describedby="reach-how">${t}</a>`;
  const reachSec = `<section class="st-sec" id="reach" aria-labelledby="reach-h"><h2 id="reach-h">HOW REASON REACHES YOU</h2>`
    + `<p class="reach-p">${reachSentence(reach, ph)}</p>`
    + `<p class="sr" id="reach-how">Opens the four choices for what Reason texts you.</p>`
    + hand("or just ask me to text you for one thing.")
    + (PRIVATE_BY_DEFAULT ? `<p class="priv d-only"><span class="lbl" style="display:inline">PRIVATE BY DEFAULT · </span>Sensitive texts only say "Reason needs your approval." The details wait here, behind sign-in.</p>` : "")
    + `</section>`
    + (PRIVATE_BY_DEFAULT ? `<section class="st-sec m-only" aria-labelledby="priv-h"><h2 id="priv-h">PRIVATE BY DEFAULT</h2><p class="priv">Sensitive texts only say <span class="q">"Reason needs your approval."</span> The details wait here, behind sign-in.</p></section>` : "");

  // A session never used since browsers were noted (a Reason page's code, the status page, before
  // this list existed) has nothing to name it by: those are counted in one quiet line, not listed
  // one "Unknown browser" at a time. Sign out everywhere ends them too.
  const older = browsers.filter(s => !s.user_agent && s.token !== current).length;
  const rows = [...browsers].filter(s => s.user_agent || s.token === current).sort((a, b) => (b.token === current) - (a.token === current)).map(s => {
    const here = s.token === current;
    const dev = deviceName(s.user_agent);
    const when = here ? "NOW" : lastActive(s.last_seen_at, now);
    return `<div class="br-row${here ? " here" : ""}"><span class="br-who"><span class="br-dev">${esc(dev)}</span>`
      + `<span class="br-when">${here ? `<span class="m-only">THIS ONE · </span>` : ""}${esc(when)}</span></span>`
      + (here ? `<span class="br-here">you're here</span>`
        : post(csrf, "browser", `${hidden("b", sessionHandle(s.token))}<button class="act2 br-out" type="submit" data-busy="SIGNING OUT…" aria-label="Sign out ${esc(dev)}, last active ${esc(when.toLowerCase())}">SIGN OUT</button>`))
      + `</div>`;
  }).join("");
  const browsersSec = `<section class="st-sec" id="browsers" aria-labelledby="br-h"><h2 id="br-h">SIGNED-IN BROWSERS</h2>${rows}`
    + (older ? `<p class="st-quiet">And ${older} other sign-in${older === 1 ? "" : "s"} that ${older === 1 ? "hasn't" : "haven't"} opened Reason Web, like Reason's pages. Signing out everywhere ends ${older === 1 ? "it" : "them"} too.</p>` : "")
    + `<a class="every" href="/web/settings?confirm=everywhere">Sign out everywhere</a>`
    + saved(done === "browsers") + `</section>`;

  const notifySec = `<section class="st-sec" id="notify" aria-labelledby="nt-h"><h2 id="nt-h">BROWSER NOTIFICATIONS</h2>${notifyBody({ csrf, reach, on: notify, done })}</section>`;

  const connectedSec = `<section class="st-sec" id="connected" aria-labelledby="cn-h"><h2 id="cn-h">CONNECTED</h2>`
    + (connected.length
      ? `<ul class="cn">${connected.map(c => `<li><span class="cn-n">${c.phone ? `<span class="m-only">${esc(c.phone)}</span><span class="d-only">${esc(c.name)}</span>` : esc(c.name)}</span><span class="cn-s">connected</span></li>`).join("")}</ul>`
        + `<p class="st-quiet">To change one, ask Reason in the chat.</p>`
      : `<p class="st-quiet">Nothing is connected yet. To connect one, ask Reason in the chat.</p>`)
    + `</section>`;

  let invitesSec = "";
  if (invitesView) {
    const left = invitesView.links_you_can_still_make;
    const list = invitesView.links.map(l => {
      const inv = l.invite;
      const [word, tone] = STAMP[inv.state] ?? [String(inv.state).toUpperCase(), "muted"];
      const text = esc(shortLink(inv.token));
      const link = inv.state === "unused"
        ? `<a class="inv-l" href="${esc(invites.inviteUrl(inv.token))}">${text}</a>`
        : `<span class="inv-l${inv.state === "canceled" ? " gone" : ""}">${text}</span>`;
      // An unused link can be canceled here, which gives the invite back (src/invites.js cancelLink).
      const cancel = inv.state === "unused"
        ? post(csrf, "cancel-invite", `${hidden("i", inv.id)}<button class="act2 inv-x" type="submit" data-busy="CANCELING…" aria-label="Cancel the invite link ${text}">CANCEL</button>`) : "";
      return `<li>${link}${stamp(word, tone)}${cancel}</li>`;
    }).join("");
    invitesSec = `<section class="st-sec" id="invites" aria-labelledby="inv-h"><h2 id="inv-h">INVITES</h2><p class="inv-n">${left} left</p>`
      + (list ? `<ul class="inv">${list}</ul>` : "")
      + (left > 0 ? post(csrf, "invite", `<button class="make" type="submit" data-busy="Making a link…">Make an invite link ${arrow}</button>`) : "")
      + saved(done === "invite-canceled", "canceled. that invite is yours again.")
      + (done === "invite-name" ? hand("i need your name for the invite card first. tell me in the chat.", { role: "status" }) : "")
      + `</section>`;
  }

  const cur = theme ?? "auto";
  const opt = (v, t) => `<button type="submit" role="radio" name="theme" value="${v}" aria-checked="${cur === v}">${t}</button>`;
  const themeSec = `<section class="st-sec" id="theme" aria-labelledby="th-h"><div class="th-box"><h2 id="th-h">THEME</h2>`
    + post(csrf, "theme", `<div class="th-g" role="radiogroup" aria-labelledby="th-h">${opt("paper", "Paper")}<span class="dot" aria-hidden="true">·</span>${opt("night", "Night")}<span class="dot" aria-hidden="true">·</span>${opt("auto", "Auto")}</div>`)
    + saved(done === "theme") + `</div>`
    + `<form method="POST" action="/web/signout" class="out-f">${hidden("c", csrf)}<button class="act2 out" type="submit" data-busy="SIGNING OUT…">SIGN OUT OF THIS BROWSER</button></form></section>`;

  const shoppingSec = shopping ? shoppingSection({ csrf, shopping, done, confirmCard }) : "";
  const shown = SECTIONS.filter(([id]) => (id !== "invites" || invitesView) && (id !== "shopping" || shopping));
  const body = `<header class="st-head"><a class="act2" href="/web?thread">← BACK TO THE CHAT</a>${wordmark({ href: "/web?home" })}</header>`
    + `<main class="st"><div class="st-side"><h1 class="st-h1">Settings</h1><nav class="st-nav" aria-label="Settings sections">`
    + shown.map(([id, t], i) => `<a href="#${id}"${i === 0 ? ` aria-current="true"` : ""}>${t}</a>`).join("")
    + `</nav></div><div class="st-main">${reachSec}${browsersSec}${notifySec}${connectedSec}${shoppingSec}${invitesSec}${themeSec}</div></main>`;
  return webPage({ title: "Reason — Settings", body, css: CSS + PAPER_CSS, script: JS });
}

// ---------------------------------------------------------------- the edit states (one screen each)
/** A Settings screen of its own, as 5A–5D and 8C draw them: ← SETTINGS, then one thing. */
function subPage({ title, back, inner, cls = "" }) {
  const body = `<header class="sub-head"><a class="act2" href="/web/settings#${back}">← SETTINGS</a></header><main class="sub${cls ? ` ${cls}` : ""}">${inner}</main>`;
  return webPage({ title: `Reason — ${title}`, body, css: CSS, script: JS });
}

/** 5A: the radio list of four, under the sentence that follows the choice. Save → / CANCEL. */
export function renderReachEdit({ csrf, reach = "text" }) {
  if (!REACH[reach]) reach = "text";
  const opts = REACH_ORDER.map(v => `<label class="ro"><input type="radio" name="reach" value="${v}" data-name="${esc(REACH[v].name)}"${v === reach ? " checked" : ""}>`
    + `<span class="ro-d" aria-hidden="true"></span><span class="ro-t"><span class="ro-n">${esc(REACH[v].name)}</span><span class="ro-l">${esc(REACH[v].line)}</span></span></label>`).join("");
  const inner = `<h1 class="sub-l" id="re-h">HOW REASON REACHES YOU</h1>`
    + post(csrf, "reach", `<p class="re-p" aria-hidden="true">Text me for <em class="re-pick">${esc(REACH[reach].name)}</em>.</p>`
      + `<div class="ro-g" role="radiogroup" aria-label="Text me for">${opts}</div>`
      + `<div class="sub-a"><button class="sub-go" type="submit" data-busy="Saving…">Save ${arrow}</button><a class="act2 sub-c" href="/web/settings#reach">CANCEL</a></div>`, "re-f");
  return subPage({ title: "How Reason reaches you", back: "reach", inner });
}

/** 5B: saved — the new sentence (each phrase opens 5A again) and the Caveat line that says what changed. */
export function renderReachSaved({ reach = "text" }) {
  if (!REACH[reach]) reach = "text";
  const ph = (t) => `<a class="ph" href="/web/settings?edit=reach">${t}</a>`;
  const inner = `<h1 class="sub-l">HOW REASON REACHES YOU</h1><p class="re-p">${reachSentence(reach, ph)}</p>`
    + hand(REACH[reach].saved, { tilt: true, role: "status" });
  return subPage({ title: "How Reason reaches you", back: "reach", inner });
}

/** 5C: sign out everywhere? The real count, what happens, Sign out everywhere (pen) / KEEP ME IN. */
export function renderSignOutAll({ csrf, count = 1 }) {
  const inner = `<div class="card so-card" role="group" aria-labelledby="so-h"><h1 class="sub-l" id="so-h">SIGN OUT EVERYWHERE?</h1>`
    + `<p class="so-n">${esc(browsersLine(count))}</p>`
    + `<p class="so-p">You'll need a new code to sign back in. Reason keeps working, and your texts aren't affected.</p>`
    + `<div class="sub-a">${post(csrf, "everywhere", `<button class="sub-go" type="submit" data-busy="Signing out everywhere…">Sign out everywhere</button>`)}<a class="act2 sub-c" href="/web/settings#browsers">KEEP ME IN</a></div></div>`;
  return subPage({ title: "Sign out everywhere?", back: "browsers", inner, cls: "mid" });
}

/** 5D: an invite link just made — the link, Copy it → / SHARE, "copied.", what's left now. */
export function renderInviteMade({ invite, left }) {
  const url = invites.inviteUrl(invite.token);
  const inner = `<h1 class="sub-l">INVITES</h1><p class="iv-n">${left} left</p>`
    + `<div class="card iv-card"><span class="lbl">NEW LINK · UNUSED</span><a class="iv-link" href="${esc(url)}">${esc(shortLink(invite.token, 4))}</a>`
    + `<div class="sub-a"><button class="sub-go iv-copy" type="button" hidden>Copy it ${arrow}</button><button class="act2 sub-c iv-share" type="button" hidden>SHARE</button></div></div>`
    + `<p class="hand tilt iv-said" role="status" hidden data-ok="copied. send it to someone you like." data-no="couldn't copy it. press and hold the link to copy it yourself."></p>`
    + `<p class="iv-note">It works once. If they never use it, you can cancel it and get the invite back.</p>`;
  return subPage({ title: "Invites", back: "invites", inner, cls: "iv" });
}

/** 8C as a screen of its own. */
export function renderNotifySub({ csrf, reach = "text", on = false, done = "" }) {
  const inner = `<h1 class="sub-l">BROWSER NOTIFICATIONS</h1>${notifyBody({ csrf, reach, on, done, sub: true })}`;
  return subPage({ title: "Browser notifications", back: "notify", inner, cls: "nt" });
}

// ---------------------------------------------------------------- the requests
function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra });
const to = (location) => ({ status: 303, headers: HTML({ Location: location, "Content-Length": 0 }), body: "" });
const back = (done, anchor) => to(`/web/settings${done ? `?done=${done}` : ""}#${anchor}`);
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body }; };
const NOT_HERE = "That didn't come from this page.";
const sessionsOf = (conv) => db.pageSessionsFor(conv, { maxAgeMs: SESSION_TTL_MS, idleMs: WEB_IDLE_MS });
const myInvitesView = (conv) => (invitesOpenFor(conv) ? { ...invites.myInvites(conv), links: db.listInvites(conv).map(invite => ({ invite })) } : null);

/** What the page shows for one person, read fresh. */
export function settingsView(account, token) {
  const conv = account.conversation_id;
  return {
    reach: db.webReach(conv),
    browsers: sessionsOf(conv),
    current: token,
    connected: connections(conv),
    invitesView: myInvitesView(conv),
    shopping: shop.connectAllowedFor(conv) ? { stores: shop.connectedStores(conv), card: shop.cardOf(conv), lastUsed: shop.lastPaid(conv) } : null,
    theme: db.webTheme(conv),
    notify: db.pageSessionNotify(token),
  };
}

/** GET: the page, or one of its edit states (5A ?edit=reach, 5B ?saved=reach, 5C ?confirm=everywhere, 5D ?invite=<id>, 8C ?edit=notify). */
function settingsPage({ account, token, query }) {
  const conv = account.conversation_id;
  const csrf = db.pageSessionCsrf(token);
  const done = String(query.done ?? "");
  if (query.edit === "reach") return renderReachEdit({ csrf, reach: db.webReach(conv) });
  if (query.saved === "reach") return renderReachSaved({ reach: db.webReach(conv) });
  if (query.edit === "notify") return renderNotifySub({ csrf, reach: db.webReach(conv), on: db.pageSessionNotify(token), done });
  if (query.confirm === "everywhere") return renderSignOutAll({ csrf, count: sessionsOf(conv).length });
  if (query.invite != null) {
    // Only a link of theirs that still works; anything else is the list, where its state is shown.
    const id = Number(query.invite);
    const inv = Number.isInteger(id) && id > 0 && invitesOpenFor(conv) ? db.getInvite(conv, id) : null;
    if (!inv || inv.state !== "unused") return null;
    return renderInviteMade({ invite: inv, left: invites.myInvites(conv).links_you_can_still_make });
  }
  return renderSettings({ csrf, ...settingsView(account, token), done, confirmCard: query.confirm === "card" });
}

/**
 * GET /web/settings, and POST /web/settings with `do` = reach | theme | browser | everywhere | notify |
 * invite | cancel-invite. Signed in only (the router sends anybody else to sign in). Every POST carries
 * the session's form secret and comes from Reason's own page, like /web/send.
 */
export async function settingsRequest({ account, method, query = {}, headers = {}, readBody, log = () => {} }) {
  const token = readCookie(headers?.cookie);
  const conv = account.conversation_id;
  if (method === "GET" || method === "HEAD") {
    const body = settingsPage({ account, token, query });
    if (body == null) return back("", "invites");
    return { status: 200, headers: HTML({ "Content-Length": Buffer.byteLength(body) }), body };
  }
  if (method !== "POST") { const body = renderNotFound(); return { status: 405, headers: HTML({ Allow: "GET, HEAD, POST", "Content-Length": Buffer.byteLength(body) }), body }; }
  const wantsJson = String(headers.accept ?? "").includes("application/json");
  const form = new URLSearchParams((await readBody()) ?? "");
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), db.pageSessionCsrf(token))) {
    log({ web_settings_refused: "origin_or_token" });
    return wantsJson ? json(403, { ok: false, error: "not_from_this_page" }) : { status: 403, headers: HTML({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(NOT_HERE) }), body: NOT_HERE };
  }
  const what = form.get("do");

  if (what === "reach") {
    const v = form.get("reach");
    if (!db.WEB_REACH_VALUES.includes(v)) return wantsJson ? json(400, { ok: false, error: "bad_reach" }) : to("/web/settings?edit=reach");
    db.setWebReach(conv, v);
    log({ web_settings: "reach", to: v });
    return wantsJson ? json(200, { ok: true, reach: v }) : to("/web/settings?saved=reach");
  }

  if (what === "theme") {
    const v = form.get("theme");
    if (!["paper", "night", "auto"].includes(v)) return wantsJson ? json(400, { ok: false, error: "bad_theme" }) : back("", "theme");
    db.setWebTheme(conv, v);
    log({ web_settings: "theme", to: v });
    return wantsJson ? json(200, { ok: true, theme: v }) : back("theme", "theme");
  }

  if (what === "notify") {
    // This browser only: the setting is on its own session row.
    const on = form.get("on") === "1";
    db.setPageSessionNotify(conv, token, on);
    log({ web_settings: "notify", on });
    if (wantsJson) return json(200, { ok: true, notify: on });
    return form.get("back") === "sub" ? to(`/web/settings?edit=notify&done=${on ? "notify" : "notify-off"}`) : back(on ? "notify" : "notify-off", "notify");
  }

  if (what === "browser") {
    // Only one of THIS person's browsers, found by its handle among their own sessions: a handle
    // from anybody else's list matches nothing here and changes nothing.
    const h = String(form.get("b") ?? "");
    const row = sessionsOf(conv).find(s => same(sessionHandle(s.token), h));
    if (!row) return back("", "browsers");
    db.endPageSessionOf(conv, row.token);
    log({ web_settings: "browser_signed_out", here: row.token === token });
    if (row.token === token) return signedOut(headers);
    return back("browsers", "browsers");
  }

  if (what === "everywhere") {
    const n = db.endPageSessionsFor(conv);
    log({ web_settings: "signed_out_everywhere", browsers: n });
    return signedOut(headers);
  }

  if (what === "invite") {
    if (!invitesOpenFor(conv)) return back("", "invites");
    const made = invites.makeLink(conv);
    log({ web_settings: "invite", ok: made.ok, ...(made.ok ? { number: made.number } : {}) });
    if (made.ok) return to(`/web/settings?invite=${made.number}`);
    return back(made.needs_name ? "invite-name" : "", "invites");
  }

  if (what === "cancel-invite") {
    if (!invitesOpenFor(conv)) return back("", "invites");
    // One of THIS person's own unused links, by its number in their list; anybody else's is not found.
    const id = Number(form.get("i"));
    const out = Number.isInteger(id) && id > 0 ? invites.cancelLink(conv, id, { replace: false }) : { ok: false };
    log({ web_settings: "invite_canceled", ok: !!out.ok });
    return back(out.ok ? "invite-canceled" : "", "invites");
  }

  if (what === "store-remove" || what === "card-remove") {
    if (!shop.connectAllowedFor(conv)) return back("", "reach");
    const key = String(form.get("s") ?? "");
    // Only one of THIS person's own stores; a key they never connected changes nothing.
    if (what === "store-remove" && !shop.isConnected(conv, key)) return back("", "shopping");
    const out = what === "store-remove" ? await shop.removeStore(conv, key) : await shop.removeCard(conv);
    log({ web_settings: what, ok: !!out.ok });
    return back(out.ok ? (what === "store-remove" ? "store-removed" : "card-removed") : "", "shopping");
  }

  return back("", "reach");
}

/** This browser is signed out: every copy of its cookie cleared, and the sign-in page says so (6F). */
function signedOut(headers) {
  return { status: 303, headers: HTML({ Location: "/web?out=1", "Content-Length": 0, "Set-Cookie": clearCookieHeader({ path: "/", headers }) }), body: "" };
}
