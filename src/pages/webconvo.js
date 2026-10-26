// Reason Web, phase W2: the conversation (docs/plans/reason-web-phase1.md §4.3–4.4, §6 W2; spec §4, §9).
//
// Signed in, /web is the person's ONE conversation with Reason: their lines and Reason's from the
// per-message history W0 writes (db `messages`), each labelled with where it was said (iMessage or
// Web) and when, newest at the bottom, older pages fetched as they scroll up. Under it a composer
// that posts into the SAME conversation through the web channel (Router.deliver, `channel: "web"`):
// the conversation id is the session's, never anything the browser names.
//
// The rules this file keeps, each pinned in test/web-convo.test.js:
//   - one conversation per session: history, the stream and the send all resolve the conversation
//     from the cookie; an id in a query or a body is never read as one
//   - a reply goes where the person is chatting: a Web message is answered in the browser (the web
//     adapter's send is an in-process event and a history row), never texted too — that is W0's
//     router; this file only shows it
//   - one message, one turn: every message carries a browser-made id, and Router.deliver's claim on
//     `<conversation>:<id>` swallows a retry, a refresh resending, a second tab, a lost answer
//   - the work is the server's: a send is acknowledged as soon as Reason has the message, the turn
//     runs on without the tab, and the answer is in history whenever they come back
//   - the history boundary is explained once, on the first visit (`accounts.web_notice_seen_at`),
//     never as a recurring popup (spec §9)
//   - safe rendering: every word is escaped; the only markup made from a message is a link, and only
//     for http(s) addresses; nothing the model writes is ever HTML here
//
// Live updates are Server-Sent Events (`/web/stream`), per session, with the session re-checked on a
// timer so a signed-out browser stops hearing. A stream is closed after a short while and the browser
// reconnects with the last id it has (Last-Event-ID), so a proxy that limits how long one response may
// run (the site's Netlify rewrite) costs a reconnect, not a message; while an answer is awaited the
// page also asks `/web/history?after=` every few seconds, so a proxy that buffers the stream costs
// seconds, not the reply.
import { timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import { WEB } from "../web.js";
import { config, clock } from "../config.js";
import { shell, esc, foot } from "./render.js";
import { readCookie } from "./access.js";
import { WEB_CSS, SECURITY_HEADERS, note, sameOrigin, sessionAccount, greeting } from "./websignin.js";

/** How many lines a page of history holds, first load and each scroll back. */
export const PAGE = 40;
/** The longest message the composer takes; the same cap is held on the server. */
export const MAX_TEXT = 4000;
/** Sends per conversation per minute: generous for a person, a wall for a runaway script. */
export const SEND_LIMIT = 20;
/** How long one stream response runs before the browser is asked to reconnect (under Netlify's proxy limit). */
export const STREAM_MS = 20_000;
/** How often an open stream re-checks that the browser is still signed in. */
export const STREAM_RECHECK_MS = 10_000;

// The approved wording (spec §9, plan §5): the boundary, once, on first Web use.
export const BOUNDARY = {
  title: "One Reason. Pick up anywhere.",
  body: "Start on Web, continue in iMessage, or switch back. Reason keeps the context, so you don't have to explain again. See your full conversation on Web. Messages from Web won't appear in your iMessage thread.",
  support: "This is the same Reason you text. Web shows your full history; iMessage shows the messages sent there. Replies go to the place you're chatting, not both.",
};

const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

/** Where a line was said, as a person would name it. A text is iMessage unless the thread knows it was SMS. */
export function sourceLabel(channel, service = null) {
  if (channel === WEB) return "Web";
  if (channel === "console") return "Console";
  return String(service ?? "").toUpperCase() === "SMS" ? "SMS" : "iMessage";
}

/**
 * One history row as the browser gets it. `cid` is the browser's own id for a line sent from Web
 * (the part after the conversation prefix Router.deliver put on it), so the page can swap its
 * "sending" bubble for the real one; nothing else about the row's bookkeeping leaves the server.
 */
export function rowOut(row, { conversationId, service = null }) {
  const prefix = `${conversationId}:`;
  const ext = String(row.external_id ?? "");
  return {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    source: sourceLabel(row.channel, service),
    web: row.channel === WEB,
    text: String(row.text ?? ""),
    files: (row.media ?? []).map(m => String(m?.filename ?? "")).filter(Boolean).slice(0, 6),
    at: row.at,
    cid: row.role === "user" && row.channel === WEB && ext.startsWith(prefix) ? ext.slice(prefix.length) : null,
  };
}

const serviceOf = (conversationId) => db.getThread(conversationId)?.service ?? null;

/** Text with its links made tappable, everything else escaped. http(s) only; trailing punctuation stays text. */
export function linkify(text) {
  const s = String(text ?? "");
  let out = "", last = 0;
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    let url = m[0];
    const trail = /[.,!?;:)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    out += esc(s.slice(last, m.index));
    out += `<a href="${esc(url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  return out + esc(s.slice(last));
}

const timeFmt = () => new Intl.DateTimeFormat("en-US", { timeZone: config.tz, hour: "numeric", minute: "2-digit" });
const dayFmt = () => new Intl.DateTimeFormat("en-US", { timeZone: config.tz, weekday: "short", month: "short", day: "numeric" });
const dayKey = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: config.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** One line of the conversation, server-drawn. The page's script draws new ones with the same markup. */
function lineHtml(m) {
  const who = m.role === "user" ? "You" : "Reason";
  const files = m.files.length ? `<p class="c-files">${m.files.map(f => `<span>${esc(f)}</span>`).join("")}</p>` : "";
  return `<li class="c-msg ${m.role === "user" ? "c-you" : "c-re"}" data-id="${m.id}" data-at="${m.at}" data-web="${m.web ? 1 : 0}"${m.cid ? ` data-cid="${esc(m.cid)}"` : ""}>`
    + `<p class="c-meta">${who} · ${esc(m.source)} · <time datetime="${new Date(m.at).toISOString()}">${esc(timeFmt().format(m.at))}</time></p>`
    + `<div class="c-text">${linkify(m.text)}</div>${files}</li>`;
}

/** The lines with a day marker where the day changes and a "continued" marker where the place does. */
export function listHtml(lines, { now = clock.now() } = {}) {
  let out = "", day = null, web = null;
  const today = dayKey(now), yesterday = dayKey(now - 864e5);
  for (const m of lines) {
    const d = dayKey(m.at);
    if (d !== day) {
      out += `<li class="c-day" role="separator"><span>${d === today ? "Today" : d === yesterday ? "Yesterday" : esc(dayFmt().format(m.at))}</span></li>`;
      day = d;
    }
    if (web !== null && m.web !== web && m.role === "user") {
      out += `<li class="c-div" role="separator"><span>Continued ${m.web ? "on Web" : `in ${esc(m.source)}`}</span></li>`;
    }
    if (m.role === "user") web = m.web;
    out += lineHtml(m);
  }
  return out;
}

/** The line at the very top once there is nothing older: history starts the day Web was switched on (no backfill). */
function startLine(lines, more) {
  if (more) return `<button class="w-link c-older" type="button">Show earlier messages</button>`;
  if (!lines.length) return "";
  return `<p>Your conversation before ${esc(dayFmt().format(lines[0].at))} stays in your texts.</p>`;
}

const SEND_SVG = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M4.5 9.5 10 4l5.5 5.5"/></svg>`;

const CSS = `
.wrap{padding-bottom:1rem}
.c-app{display:grid;grid-template-columns:minmax(0,1fr);gap:2rem}
.c-head{margin:.2rem 0 1.4rem}
.c-head .kicker{font:400 .72rem/1.4 var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:0 0 .5rem}
.c-head h1{font:italic 400 clamp(2.1rem,8vw,2.8rem)/1.08 var(--serif);letter-spacing:-.02em;margin:0}
.c-head .w-note{margin:.6rem 0 0;font-size:1.3rem}
.c-note{margin:0 0 1.6rem;padding:1.1rem 1.15rem 1rem;border:1px dashed var(--rule);border-radius:6px;background:color-mix(in srgb,var(--card) 70%,transparent)}
.c-note h2{font-size:1.55rem;margin:0 0 .45rem}
.c-note p{margin:.35rem 0;color:var(--dim);font-size:.97rem}
.c-note .w-link{margin-top:.45rem;font-size:.92rem}
.c-start{text-align:center;color:var(--dim);font-size:.88rem;min-height:1.2rem;margin:0 0 .6rem}
.c-start p{margin:0}
.c-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1.05rem}
.c-msg{max-width:100%}
.c-meta{font:400 .68rem/1.3 var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--dim);margin:0 0 .3rem}
.c-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:1.02rem;line-height:1.55}
.c-text a{color:inherit;text-decoration-color:var(--accent);text-underline-offset:3px}
.c-you{align-self:flex-end;max-width:min(86%,32rem);background:color-mix(in srgb,var(--ink) 6%,var(--card));border:1px solid var(--line);border-radius:14px 14px 4px 14px;padding:.7rem .95rem .8rem}
.c-re{align-self:flex-start;max-width:min(94%,36rem);padding:0 .1rem}
.c-you[data-state] .c-meta{color:var(--dim)}
.c-you[data-state="failed"]{border-color:var(--warn)}
.c-you[data-state="failed"] .c-meta{color:var(--warn)}
.c-retry{font:inherit;font-size:.9rem;margin-top:.35rem}
.c-files{margin:.4rem 0 0;display:flex;flex-wrap:wrap;gap:.35rem}
.c-files span{font:400 .72rem/1.3 var(--mono);padding:.2rem .45rem;border:1px solid var(--line);border-radius:3px;color:var(--dim)}
.c-day,.c-div{display:flex;align-items:center;gap:.8rem;color:var(--dim);font:400 .68rem/1.3 var(--mono);text-transform:uppercase;letter-spacing:.14em;margin:.4rem 0}
.c-day::before,.c-day::after,.c-div::before,.c-div::after{content:"";flex:1;border-top:1px dashed var(--rule)}
.c-div{font:400 1.15rem/1 var(--hand);text-transform:none;letter-spacing:0;color:var(--accent)}
.c-empty{color:var(--dim);text-align:center;margin:2.5rem 0}
.c-typing{display:flex;align-items:center;gap:.55rem;margin:1rem 0 0;color:var(--dim);font:400 .68rem/1.3 var(--mono);text-transform:uppercase;letter-spacing:.12em}
.c-typing[hidden]{display:none}
.c-dots{display:inline-flex;gap:4px}
.c-dots i{width:6px;height:6px;border-radius:50%;background:var(--accent);opacity:.35;animation:c-b 1.2s infinite ease-in-out}
.c-dots i:nth-child(2){animation-delay:.15s}.c-dots i:nth-child(3){animation-delay:.3s}
@keyframes c-b{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.c-dots i{animation:none;opacity:.7}}
.c-compose{position:sticky;bottom:0;margin:1.4rem -1.15rem 0;padding:.75rem 1.15rem calc(.75rem + env(safe-area-inset-bottom));background:var(--bg);border-top:1px dashed var(--rule);z-index:2}
.c-box{display:flex;align-items:flex-end;gap:.55rem;border:1px solid var(--edge,#ccc);border-radius:14px;background:var(--card);padding:.45rem .45rem .45rem .9rem}
.c-box:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}
.c-box textarea{flex:1;border:0;outline:0;resize:none;background:transparent;color:var(--ink);font:inherit;font-size:1.02rem;line-height:1.45;padding:.45rem 0;max-height:12rem;min-height:1.5rem}
.c-box textarea::placeholder{color:var(--dim);opacity:1}
.c-send{flex:none;width:2.6rem;height:2.6rem;border-radius:10px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);display:grid;place-items:center;cursor:pointer}
.c-send svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.c-send:focus-visible,.w-link:focus-visible,.c-text a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.c-under{margin:.45rem 0 0;text-align:center;color:var(--dim);font-size:.82rem}
.c-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.c-out{margin:2rem 0 0;text-align:center;font-size:.9rem}
@media (min-width:900px){.wrap{max-width:46rem}.c-head h1{font-size:3rem}}
`;
// Room for W3: the Ongoing panel becomes a second column of .c-app at desktop widths. Not built here.

/**
 * The signed-in page: the conversation, the composer, and — on the first visit only — the boundary.
 * `sendId` is a fresh id for the no-script form, so even a plain form post is one turn however
 * often the browser resends it.
 */
export function renderConversation({ account, csrf, lines, more, firstVisit, sendId, now = clock.now() }) {
  const name = String(account?.name ?? "").trim();
  const notice = firstVisit
    ? `<aside class="c-note" aria-labelledby="c-note-h"><h2 id="c-note-h">${esc(BOUNDARY.title)}</h2><p>${esc(BOUNDARY.body)}</p><p>${esc(BOUNDARY.support)}</p><button class="w-link" type="button" data-close>Got it</button></aside>`
    : "";
  const body = `<div class="c-app"><div class="c-main">`
    + `<div class="c-head"><p class="kicker">Your personal concierge</p><h1>${esc(greeting(name))}</h1>${note("same conversation, wherever you are.")}</div>`
    + notice
    + `<section class="c-log" aria-label="Your conversation with Reason">`
    + `<div class="c-start">${startLine(lines, more)}</div>`
    + `<ol class="c-list" role="log" aria-live="polite" aria-relevant="additions">${listHtml(lines, { now })}</ol>`
    + (lines.length ? "" : `<p class="c-empty">Nothing here yet. Whatever you tell Reason here or by text shows up in this conversation.</p>`)
    + `<p class="c-typing" hidden role="status"><span class="c-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Reason is working on it</span></p>`
    + `</section>`
    + `<form class="c-compose" method="POST" action="/web/send"><input type="hidden" name="c" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(sendId)}">`
    + `<div class="c-box"><label class="c-sr" for="c-input">Message Reason</label><textarea id="c-input" name="text" rows="1" maxlength="${MAX_TEXT}" placeholder="Tell Reason what you need" required></textarea>`
    + `<button class="c-send" type="submit" aria-label="Send">${SEND_SVG}</button></div>`
    + `<p class="c-under">Replies come here, not to your phone as well.</p></form>`
    + `<form class="w-form c-out" method="POST" action="/web/signout"><input type="hidden" name="c" value="${esc(csrf)}"><button class="w-link" type="submit">Sign out of this browser</button></form>`
    + `</div></div>`
    + foot();
  const first = lines[0]?.id ?? 0, last = lines.reduce((n, m) => Math.max(n, m.id), 0);
  const boot = `window.REASON_WEB={c:${JSON.stringify(String(csrf ?? ""))},first:${Number(first)},last:${Number(last)},more:${more ? "true" : "false"}};`;
  return shell({ title: "Reason", body, pill: "Web", css: WEB_CSS + CSS, referrer: "same-origin", script: boot + CLIENT_JS });
}

// The page's script. DOM only (textContent, createElement): no message ever becomes HTML in the
// browser either. Same markup as lineHtml/listHtml above.
const CLIENT_JS = `(function(){
var R=window.REASON_WEB,list=document.querySelector(".c-list"),typing=document.querySelector(".c-typing"),form=document.querySelector(".c-compose"),box=document.getElementById("c-input"),start=document.querySelector(".c-start"),empty=document.querySelector(".c-empty");
if(!list||!form)return;
var KEY="reason-web-pending",waiting=0,typingUntil=0,live=false,es=null;
var tf=new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"});
function fmt(at){try{return tf.format(new Date(at))}catch(e){return""}}
document.querySelectorAll(".c-msg time").forEach(function(t){var li=t.closest(".c-msg");t.textContent=fmt(Number(li.dataset.at))});
var close=document.querySelector(".c-note [data-close]");if(close)close.onclick=function(){close.closest(".c-note").remove();box.focus()};
function near(){return window.innerHeight+window.scrollY>=document.body.scrollHeight-160}
function bottom(){window.scrollTo(0,document.body.scrollHeight)}
function linkify(el,s){var re=/https?:\\/\\/[^\\s<>"'\`]+/g,last=0,m;while((m=re.exec(s))){var u=m[0],t=/[.,!?;:)\\]]+$/.exec(u);if(t)u=u.slice(0,-t[0].length);el.appendChild(document.createTextNode(s.slice(last,m.index)));var a=document.createElement("a");a.href=u;a.rel="noopener noreferrer nofollow";a.target="_blank";a.textContent=u;el.appendChild(a);last=m.index+u.length;re.lastIndex=last}el.appendChild(document.createTextNode(s.slice(last)))}
function line(m){var li=document.createElement("li");li.className="c-msg "+(m.role==="user"?"c-you":"c-re");li.dataset.id=m.id;li.dataset.at=m.at;li.dataset.web=m.web?1:0;if(m.cid)li.dataset.cid=m.cid;
var meta=document.createElement("p");meta.className="c-meta";meta.textContent=(m.role==="user"?"You":"Reason")+" \\u00b7 "+m.source+" \\u00b7 ";var t=document.createElement("time");t.dateTime=new Date(m.at).toISOString();t.textContent=fmt(m.at);meta.appendChild(t);li.appendChild(meta);
var tx=document.createElement("div");tx.className="c-text";linkify(tx,m.text);li.appendChild(tx);
if(m.files&&m.files.length){var f=document.createElement("p");f.className="c-files";m.files.forEach(function(n){var s=document.createElement("span");s.textContent=n;f.appendChild(s)});li.appendChild(f)}return li}
function add(m){if(list.querySelector('.c-msg[data-id="'+m.id+'"]'))return;if(empty){empty.remove();empty=null}
var stick=near(),li=line(m);
if(m.cid){var p=list.querySelector('.c-msg[data-pending="'+m.cid+'"]');if(p){p.replaceWith(li);forget(m.cid);if(stick)bottom();return}}
var after=null;list.querySelectorAll(".c-msg[data-id]").forEach(function(o){var a=Number(o.dataset.at),i=Number(o.dataset.id);if(a<m.at||(a===m.at&&i<m.id))after=o});
var firstPending=list.querySelector(".c-msg[data-pending]");
if(after&&after.nextSibling&&!(firstPending&&after.nextSibling===firstPending))list.insertBefore(li,after.nextSibling);else if(firstPending&&(!after||after.nextSibling===firstPending))list.insertBefore(li,firstPending);else if(after)list.appendChild(li);else list.insertBefore(li,list.firstChild);
if(m.id>R.last)R.last=m.id;
if(m.role==="assistant"){waiting=Math.max(0,waiting-1);setTyping(false)}
if(stick)bottom()}
function setTyping(on,until){typingUntil=on?(until||Date.now()+120000):0;typing.hidden=!on}
setInterval(function(){if(typingUntil&&Date.now()>typingUntil)setTyping(false)},1000);
function pend(){try{return JSON.parse(sessionStorage.getItem(KEY)||"[]")}catch(e){return[]}}
function keep(a){try{sessionStorage.setItem(KEY,JSON.stringify(a))}catch(e){}}
function forget(cid){keep(pend().filter(function(p){return p.id!==cid}))}
function uid(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
function pendingLine(p){var li=line({id:"",role:"user",source:"Web",web:true,text:p.text,at:Date.now()});li.removeAttribute("data-id");li.dataset.pending=p.id;li.dataset.state="sending";li.querySelector(".c-meta").textContent="You \\u00b7 Web \\u00b7 Sending\\u2026";list.appendChild(li);if(empty){empty.remove();empty=null}bottom();return li}
function state(li,s){if(!li)return;li.dataset.state=s;var meta=li.querySelector(".c-meta");var r=li.querySelector(".c-retry");if(r)r.remove();
if(s==="sent")meta.textContent="You \\u00b7 Web \\u00b7 Sent";else if(s==="sending")meta.textContent="You \\u00b7 Web \\u00b7 Sending\\u2026";
else{meta.textContent="You \\u00b7 Web \\u00b7 Not sent yet";var b=document.createElement("button");b.type="button";b.className="w-link c-retry";b.textContent="Try again";b.onclick=function(){send({id:li.dataset.pending,text:li.querySelector(".c-text").textContent},li)};li.appendChild(b)}}
function send(p,li,tries){tries=tries||0;state(li,"sending");
fetch("/web/send",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json","X-Reason-Csrf":R.c},body:new URLSearchParams({id:p.id,text:p.text,c:R.c})})
.then(function(r){return r.json().catch(function(){return{ok:false}}).then(function(j){j.status=r.status;return j})})
.then(function(j){if(j.status===401){location.reload();return}if(j.ok){if(li.isConnected&&!j.duplicate){state(li,"sent");waiting++;setTyping(true)}poll()}else if(j.status>=500&&tries<2){setTimeout(function(){send(p,li,tries+1)},1500*(tries+1))}else state(li,"failed")})
.catch(function(){if(tries<3)setTimeout(function(){send(p,li,tries+1)},1500*(tries+1));else state(li,"failed")})}
form.addEventListener("submit",function(e){e.preventDefault();var text=box.value.replace(/\\s+$/,"");if(!text.trim())return;var p={id:uid(),text:text};keep(pend().concat([p]));box.value="";grow();send(p,pendingLine(p))});
box.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&!matchMedia("(pointer:coarse)").matches){e.preventDefault();form.requestSubmit()}});
function grow(){box.style.height="auto";box.style.height=Math.min(box.scrollHeight,192)+"px"}box.addEventListener("input",grow);
// A tab reloaded mid-send: whatever it had not yet seen in history is shown again and sent again
// under the SAME id, which the server's claim turns into nothing if it already arrived.
pend().forEach(function(p){if(list.querySelector('.c-msg[data-cid="'+p.id+'"]')){forget(p.id);return}send(p,pendingLine(p))});
var polling=false;function poll(){if(polling)return;polling=true;fetch("/web/history?after="+R.last,{credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){if(r.status===401){location.reload();throw 0}return r.json()}).then(function(j){(j.messages||[]).forEach(add)}).catch(function(){}).then(function(){polling=false})}
setInterval(function(){if(waiting>0||typingUntil||!live)poll()},4000);
function stream(){if(!window.EventSource)return;es=new EventSource("/web/stream?after="+R.last);es.onopen=function(){live=true};
es.addEventListener("message",function(e){try{add(JSON.parse(e.data))}catch(x){}});
es.addEventListener("typing",function(e){try{var t=JSON.parse(e.data);setTyping(t.on,t.until)}catch(x){}});
es.addEventListener("signedout",function(){es.close();location.reload()});
es.onerror=function(){live=false}}
stream();
document.addEventListener("visibilitychange",function(){if(!document.hidden)poll()});
var loading=false;function older(){if(loading||!R.more)return;loading=true;var h=document.body.scrollHeight;
fetch("/web/history?before="+R.first,{credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){return r.json()}).then(function(j){var ms=j.messages||[];var anchor=list.firstChild;
ms.forEach(function(m){if(!list.querySelector('.c-msg[data-id="'+m.id+'"]'))list.insertBefore(line(m),anchor)});
if(ms.length)R.first=ms[0].id;R.more=!!j.more;start.textContent="";if(!R.more&&j.start){var s=document.createElement("p");s.textContent=j.start;start.appendChild(s)}
window.scrollBy(0,document.body.scrollHeight-h)}).catch(function(){}).then(function(){loading=false;if(R.more)hook()})}
function hook(){start.textContent="";var b=document.createElement("button");b.type="button";b.className="w-link c-older";b.textContent="Show earlier messages";b.onclick=older;start.appendChild(b)}
if(R.more){hook();if(window.IntersectionObserver)new IntersectionObserver(function(es){if(es[0].isIntersecting)older()},{rootMargin:"200px 0px 0px 0px"}).observe(start)}
bottom();
})();`;

const json = (status, obj, extra = {}) => {
  const body = JSON.stringify(obj);
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body), ...extra }, body };
};

/** GET /web signed in: the latest page of the conversation, and the boundary if this is the first visit. */
export function conversationPage({ account, headers, sendId, method = "GET" }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  const rows = db.messagesBefore(conv, { limit: PAGE + 1 });
  const more = rows.length > PAGE;
  const lines = (more ? rows.slice(1) : rows).map(r => rowOut(r, { conversationId: conv, service }));
  // Spent only by a real view (GET); a HEAD carries no body to show it in.
  const firstVisit = method === "GET" ? db.markWebNoticeSeen(conv) : false;
  const csrf = db.pageSessionCsrf(readCookie(headers.cookie));
  return renderConversation({ account, csrf, lines, more, firstVisit, sendId });
}

/**
 * GET /web/history?before=<id> (older page) or ?after=<id> (catch-up). Only the session's own
 * conversation is ever read; an id from somebody else's history simply finds nothing.
 */
export function historyRequest({ account, query = {} }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  const num = (v) => (/^\d{1,15}$/.test(String(v ?? "")) ? Number(v) : null);
  if (query.after != null) {
    const after = num(query.after) ?? 0;
    const rows = db.messagesFor(conv, { after, limit: 200 });
    return json(200, { messages: rows.map(r => rowOut(r, { conversationId: conv, service })) });
  }
  const before = num(query.before);
  const rows = db.messagesBefore(conv, { before, limit: PAGE + 1 });
  const more = rows.length > PAGE;
  const lines = (more ? rows.slice(1) : rows).map(r => rowOut(r, { conversationId: conv, service }));
  const start = !more && lines.length ? `Your conversation before ${dayFmt().format(lines[0].at)} stays in your texts.` : null;
  return json(200, { messages: lines, more, start });
}

const sends = new Map(); // conversation → recent send times, for SEND_LIMIT
function underLimit(conv, now = clock.now()) {
  const recent = (sends.get(conv) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= SEND_LIMIT) { sends.set(conv, recent); return false; }
  recent.push(now);
  sends.set(conv, recent);
  return true;
}
/** For tests. */
export function resetSendLimits() { sends.clear(); }

/** How long a send waits to hear "refused" or "already had it" before saying "got it" and letting the turn run on. */
export const ACK_WAIT_MS = 1500;

/**
 * POST /web/send: one message into the person's conversation. Same-origin and the session's own
 * secret (header or form field), a browser-made id, words within the cap. Handed to Router.deliver
 * as a web inbound under the SESSION's conversation; nothing in the body can name another. The
 * answer comes back once Reason has the message (or has refused it); the turn runs on server-side
 * whatever happens to the tab.
 */
export async function sendRequest({ account, headers = {}, readBody, router, log = () => {}, ackWaitMs = ACK_WAIT_MS }) {
  const wantsJson = String(headers.accept ?? "").includes("application/json");
  const fail = (status, error) => (wantsJson ? json(status, { ok: false, error }) : { status: 303, headers: { ...SECURITY_HEADERS, Location: "/web", "Content-Length": 0 }, body: "" });
  const form = new URLSearchParams((await readBody()) ?? "");
  const token = readCookie(headers.cookie);
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), db.pageSessionCsrf(token))) {
    log({ web_send_refused: "origin_or_token" });
    return wantsJson ? json(403, { ok: false, error: "not_from_this_page" }) : { status: 403, headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" }, body: "That didn't come from this page." };
  }
  const id = String(form.get("id") ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail(400, "bad_id");
  const text = String(form.get("text") ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!text.trim()) return fail(400, "empty");
  if (text.length > MAX_TEXT) return fail(413, "too_long");
  if (!router) return fail(503, "unavailable");
  const conv = account.conversation_id;
  if (!underLimit(conv)) { log({ web_send_refused: "rate_limited" }); return fail(429, "slow_down"); }

  const delivering = Promise.resolve()
    .then(() => router.deliver({ channel: WEB, externalId: id, conversationId: conv, text, at: clock.now() }))
    .catch((e) => { log({ web_send_failed: (e?.message ?? String(e)).split("\n")[0] }); return { ok: false, error: "failed" }; });
  const quick = await Promise.race([delivering, new Promise(r => setTimeout(() => r(null), ackWaitMs).unref?.())]);
  log({ web_send: quick ? (quick.duplicate ? "duplicate" : quick.refused ?? (quick.ok === false ? "failed" : "done")) : "accepted" });
  if (quick && quick.refused) return fail(403, quick.refused);
  if (quick && quick.ok === false && quick.error === "failed") return fail(500, "failed");
  if (!wantsJson) return { status: 303, headers: { ...SECURITY_HEADERS, Location: "/web", "Content-Length": 0 }, body: "" };
  return json(200, { ok: true, id, duplicate: !!quick?.duplicate });
}

/**
 * GET /web/stream: Server-Sent Events for the session's own conversation. `message` for every new
 * history row (theirs, from any channel, and Reason's), `typing` while Reason works on a Web turn,
 * `signedout` when the session stops being good. Resumes after `Last-Event-ID` (or `?after=`). The
 * session is re-read every STREAM_RECHECK_MS and before every push, so a sign-out elsewhere ends it.
 */
export function streamRequest({ account, headers = {}, query = {}, router = null, log = () => {}, streamMs = STREAM_MS, recheckMs = STREAM_RECHECK_MS }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  const startAfter = Number(/^\d{1,15}$/.test(String(headers["last-event-id"] ?? "")) ? headers["last-event-id"] : (/^\d{1,15}$/.test(String(query.after ?? "")) ? query.after : 0));
  return {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" },
    stream(res, req) {
      let last = startAfter, closed = false;
      const webCh = router?.get?.(WEB) ?? null;
      const write = (s) => { if (!closed) res.write(s); };
      const stillHers = () => sessionAccount(headers)?.conversation_id === conv;
      const end = (why) => {
        if (closed) return;
        closed = true;
        db.historyBus.off("row", onRow);
        webCh?.events?.off?.("typing", onTyping);
        clearInterval(beat); clearInterval(check); clearTimeout(stop);
        log({ web_stream_end: why });
        try { res.end(); } catch { /* already gone */ }
      };
      const flush = () => {
        if (!stillHers()) { write("event: signedout\ndata: {}\n\n"); return end("signed_out"); }
        for (const r of db.messagesFor(conv, { after: last, limit: 200 })) {
          last = Math.max(last, r.id);
          write(`id: ${r.id}\nevent: message\ndata: ${JSON.stringify(rowOut(r, { conversationId: conv, service }))}\n\n`);
        }
      };
      const onRow = (e) => { if (e?.conversationId !== conv) return; try { flush(); } catch { end("failed"); } };
      const onTyping = (e) => {
        if (e?.to !== account.address || !stillHers()) return;
        write(`event: typing\ndata: ${JSON.stringify({ on: !!e.on, until: e.until || 0 })}\n\n`);
      };
      // Timers first: `end` clears them, and the first flush may already end the stream.
      const beat = setInterval(() => write(": ping\n\n"), 15_000);
      const check = setInterval(() => { if (!stillHers()) { write("event: signedout\ndata: {}\n\n"); end("signed_out"); } }, recheckMs);
      const stop = setTimeout(() => end("cycle"), streamMs);
      for (const t of [beat, check, stop]) t.unref?.();
      req?.on?.("close", () => end("closed"));
      res.on?.("close", () => end("closed"));
      write("retry: 1500\n\n");
      db.historyBus.on("row", onRow);
      webCh?.events?.on?.("typing", onTyping);
      try { flush(); } catch (e) { log({ web_stream_failed: (e?.message ?? String(e)).split("\n")[0] }); end("failed"); }
    },
  };
}
