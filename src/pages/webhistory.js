// Reason Web, chat history (v2 handoff 2026-10-27, Gap 7; reference sheet-history-{paper,night} 7A/7B).
// MANAGE CHAT HISTORY → on Memory leads here: every message of the person's ONE conversation, from
// iMessage and the web, read from the same store the thread reads (db `messages`: what they sent,
// in from either channel, and what Reason sent them, written as it left the outbox). Read-only.
//
//   GET /web/memory/history              7A: the days of this month (serif date, typed
//                                        `WEB + IMESSAGE · 14 MESSAGES`), older months one row each
//                                        (`58 MESSAGES · 19 DAYS`), FIND A MESSAGE, the Caveat note
//   GET /web/memory/history?month=YYYY-MM   one older month's days
//   GET /web/memory/history?day=YYYY-MM-DD  7B: that day read-only: each line with its label
//                                        (who · where · when), no composer, "Go to chat →"
//   GET /web/memory/history?q=…          messages holding every word typed, matches underlined in pen,
//                                        each opening its day at that line
//
// Days are the person's own (config.tz). Only the session's conversation is ever read; a day or
// month with nothing in it is a 404, never somebody else's. Nothing here changes anything.
import * as db from "../db.js";
import { config, clock } from "../config.js";
import { esc } from "./render.js";
import { webPage, typed, hand, action } from "./webkit.js";
import { rowOut, sourceLabel } from "./webconvo.js";
import { COMPOSE_CSS } from "./webcompose.js";

export const MAX_QUERY = 100;
/** How many search results one page shows (newest first). */
export const MAX_HITS = 50;

const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: config.tz, ...opts });
/** "2026-10-20": the day a moment falls on, where the person is. */
export const dayKey = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: config.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const monthKey = (at) => dayKey(at).slice(0, 7);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const noonOf = (key) => { const [y, m, d] = key.split("-").map(Number); return Date.UTC(y, m - 1, d || 1, 12); };

/** Today · Yesterday · Tuesday, Oct 20 (this week) · Oct 12 · Oct 12, 2025 (another year). */
export function dayName(key, now = clock.now()) {
  // Whole calendar days between the two dates (noon UTC of each), so a clock change never shifts a name.
  const ago = Math.round((noonOf(dayKey(now)) - noonOf(key)) / 864e5);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  const at = noonOf(key);
  const opts = { timeZone: "UTC" };
  if (ago > 1 && ago < 7) return new Intl.DateTimeFormat("en-US", { ...opts, weekday: "long", month: "short", day: "numeric" }).format(at);
  const sameYear = key.slice(0, 4) === dayKey(now).slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { ...opts, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}
/** September, or September 2025 in another year. */
export function monthName(key, now = clock.now()) {
  const sameYear = key.slice(0, 4) === dayKey(now).slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", ...(sameYear ? {} : { year: "numeric" }) }).format(noonOf(key));
}

const serviceOf = (conv) => db.getThread(conv)?.service ?? null;
const where = (channel, service) => sourceLabel(channel, service).toUpperCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Every day with a message, newest first: `{ key, count, places: ["WEB", "IMESSAGE"] }`. One
 * small read of (channel, at) per row; the words are only read for a day opened or a search.
 */
export function historyDays(conv) {
  const service = serviceOf(conv);
  const days = new Map();
  const rows = db.db.prepare("SELECT channel, at FROM messages WHERE conversation_id = ? AND chat_id IS NULL AND deleted_at IS NULL ORDER BY at DESC, id DESC").all(conv);
  for (const r of rows) {
    const k = dayKey(r.at);
    let d = days.get(k);
    if (!d) days.set(k, d = { key: k, count: 0, places: new Set() });
    d.count++;
    d.places.add(where(r.channel, service));
  }
  // Web first, as the design writes it (`WEB + IMESSAGE`).
  return [...days.values()].map(d => ({ ...d, places: [...d.places].sort((a, b) => (a === "WEB" ? -1 : b === "WEB" ? 1 : a.localeCompare(b))) }));
}

/** 7A's rows: this month's days one by one, every earlier month as one row. */
export function historyList(conv, now = clock.now()) {
  const thisMonth = monthKey(now);
  const days = [], months = new Map();
  for (const d of historyDays(conv)) {
    if (d.key.slice(0, 7) >= thisMonth) { days.push(d); continue; }
    const k = d.key.slice(0, 7);
    const m = months.get(k) ?? { key: k, count: 0, days: 0 };
    m.count += d.count; m.days++;
    months.set(k, m);
  }
  return { days, months: [...months.values()] };
}

/** One day's lines, oldest first, as the thread draws them. */
export function dayLines(conv, key) {
  const noon = noonOf(key);
  const rows = db.db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND chat_id IS NULL AND deleted_at IS NULL AND at >= ? AND at < ?
    ORDER BY at ASC, id ASC`).all(conv, noon - 40 * 36e5, noon + 40 * 36e5).filter(r => dayKey(r.at) === key);
  const service = serviceOf(conv);
  return rows.map(r => rowOut({ ...r, media: (() => { try { return JSON.parse(r.media || "[]"); } catch { return []; } })() }, { conversationId: conv, service }));
}

const cleanQuery = (q) => String(q ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
const wordsOf = (q) => cleanQuery(q).toLowerCase().split(" ").filter(Boolean);

/** Messages holding every word of `q` (any case), newest first: `{ total, hits }`. */
export function searchMessages(conv, q, { limit = MAX_HITS } = {}) {
  const words = wordsOf(q);
  if (!words.length) return { total: 0, hits: [] };
  // SQLite's lower() folds A–Z only, so the words are matched here, the way the page marks them
  // ("café" finds "CAFÉ"); one person's history is small enough to read through.
  const all = db.db.prepare(`SELECT id, role, channel, text, at FROM messages WHERE conversation_id = ? AND chat_id IS NULL AND deleted_at IS NULL
    ORDER BY at DESC, id DESC`).all(conv).filter(r => { const t = String(r.text ?? "").toLowerCase(); return words.every(w => t.includes(w)); });
  return { total: all.length, hits: all.slice(0, limit) };
}

/** `text` escaped, every searched word underlined in pen. */
export function markedHtml(text, q) {
  const t = String(text ?? "");
  const words = wordsOf(q);
  const low = t.toLowerCase();
  const on = new Array(t.length).fill(false);
  for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) for (let j = i; j < i + w.length; j++) on[j] = true;
  let out = "", i = 0;
  while (i < t.length) {
    let j = i;
    while (j < t.length && on[j] === on[i]) j++;
    out += on[i] ? `<mark>${esc(t.slice(i, j))}</mark>` : esc(t.slice(i, j));
    i = j;
  }
  return out;
}

/** A long message cut to the part around its first match. */
export function snippet(text, q, max = 220) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const first = Math.max(0, Math.min(...wordsOf(q).map(w => { const i = t.toLowerCase().indexOf(w); return i < 0 ? Infinity : i; })));
  const start = Number.isFinite(first) ? Math.max(0, first - 60) : 0;
  const cut = t.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${cut}${start + max < t.length ? "…" : ""}`;
}

// ---------------------------------------------------------------- drawing

const CSS = `
.hh{padding:16px 24px 0;display:flex;justify-content:space-between;align-items:center;gap:16px}
.hh .act2{font-size:12px}
.ro{font:400 10px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.hist{flex:1 0 auto;width:100%;max-width:760px;margin:0 auto;padding:28px 24px 20px;display:flex;flex-direction:column;gap:24px}
.hist-lead{display:flex;flex-direction:column;gap:8px}
.hist .h1{font-size:40px;line-height:1.06}
.hist-sub{margin:0;font-size:15px;line-height:1.5;color:var(--muted)}
.find{display:flex;flex-direction:column;gap:6px;margin:0}
.find .lbl{font-size:10.5px}
.find-l{height:44px;border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;gap:12px}
.find-l:focus-within{border-bottom-width:2px}
.find-in{flex:1;min-width:0;height:44px;border:0;border-radius:0;background:transparent;padding:0;font:italic 400 20px/1 var(--serif);color:var(--ink);caret-color:var(--pen);-webkit-appearance:none;appearance:none}
.find-in::placeholder{color:var(--muted);opacity:1}
.find-in::-webkit-search-cancel-button,.find-in::-webkit-search-decoration{-webkit-appearance:none;appearance:none;display:none}
.clr{font-size:11.5px}
.clr[hidden]{display:none}
.h-body{display:flex;flex-direction:column}
.days{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.dy{text-decoration:none;color:var(--ink);padding:14px 0;border-bottom:1px dashed var(--hair);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:baseline}
.dy:hover{color:var(--hov)}
.dy-d{font:italic 400 22px/1.15 var(--serif)}
.dy-go{font:400 11px/1 var(--mono);color:var(--muted)}
.dy-m{font:400 10px/1.4 var(--mono);letter-spacing:.12em;color:var(--muted)}
.note{font-size:19px;line-height:1.2;transform:rotate(-1deg);transform-origin:left center}
.cnt{margin:0 0 6px;font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.hits{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.hit{text-decoration:none;color:var(--ink);padding:12px 0;border-bottom:1px dashed var(--hair);display:flex;flex-direction:column;gap:4px}
.hit .lbl{font-size:10px}
.hit-t{font-size:15px;line-height:1.45;overflow-wrap:anywhere}
mark{background:transparent;color:inherit;border-bottom:2px solid var(--pen)}
.nomore{margin:8px 0 0;font-size:14px;line-height:1.5;color:var(--muted)}
.hist.day{gap:26px}
.hist.day .h1{font-size:32px}
.lines{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:26px}
.msg{display:flex;flex-direction:column;gap:4px;min-width:0;scroll-margin-top:24px}
.msg .lbl{font-size:10px}
.msg .lbl time{font:inherit}
.msg:target .lbl{color:var(--pen)}
.you{align-self:flex-end;align-items:flex-end;max-width:85%}
.said{margin:0;text-align:right;font:italic 400 21px/1.25 var(--serif);white-space:pre-wrap;overflow-wrap:anywhere}
.said.hand{font:400 24px/1.15 var(--hand);color:var(--pen)}
.said a,.rsay a{color:inherit;text-decoration-color:var(--pen);text-underline-offset:3px}
.re{align-self:stretch}
.rsay{display:flex;flex-direction:column;gap:12px;max-width:34em}
.rsay p{margin:0;font-size:16px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.rl{margin:2px 0;padding:0;list-style:none}
.rl li{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:0 8px;padding:12px 0;border-top:1px dashed var(--hair);font-size:16px;line-height:1.5;align-items:baseline}
.rl li:last-child{border-bottom:1px dashed var(--hair)}
.rl-n{font:400 13px/1 var(--mono);color:var(--pen)}
.rl-t{overflow-wrap:anywhere}
.rl-p{font:400 14px/1 var(--mono)}
.lcard{text-decoration:none;color:var(--ink);padding:18px;display:flex;flex-direction:column;gap:8px;align-self:flex-start;min-width:min(320px,100%);max-width:100%}
.lc-dom{font:400 10.5px/1.3 var(--mono);letter-spacing:.1em;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lc-t{font:italic 400 24px/1.15 var(--serif);overflow-wrap:anywhere}
.lc-go{font-size:14px;font-weight:500}
.ev{flex-direction:row;padding:0;gap:0;overflow:hidden}
.ev-date{width:92px;flex:none;background:var(--deep);border-right:1px solid var(--hair);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:12px 0}
.ev-mon{font:400 11px/1 var(--mono);letter-spacing:.1em;color:var(--pen)}
.ev-day{font:italic 400 36px/1 var(--serif)}
.ev-txt{padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:0}
.ev-t{font-size:15px;font-weight:600}
.photo{width:220px;max-width:100%;height:160px;background:var(--photo);border:6px solid var(--lifted);box-shadow:var(--shp);transform:rotate(2deg);display:grid;place-items:center}
.re .photo{transform:rotate(-1.5deg)}
.slip{display:inline-flex;align-items:center;background:var(--lifted);border:1px solid var(--hair);border-radius:2px;box-shadow:var(--sh);padding:12px 14px;transform:rotate(-.6deg);font:400 12px/1.2 var(--mono);letter-spacing:.04em;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tochat{width:100%;max-width:760px;margin:0 auto;padding:14px 24px 26px;border-top:1px dashed var(--hair);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.tochat p{margin:0;font-size:13px;color:var(--muted)}
.tochat .act{font-size:20px;min-height:44px}
@media (max-width:359px){.hh,.hist,.tochat{padding-left:20px;padding-right:20px}}
@media (min-width:900px){
.hh{padding:22px clamp(20px,4vw,48px) 0}
.hist{padding:48px 24px 40px;gap:32px}
.hist .h1{font-size:56px}
.hist-sub{font-size:17px}
.find-in{font-size:22px}
.dy-d{font-size:26px}
.dy-m{font-size:11px}
.note{font-size:22px}
.hist.day .h1{font-size:48px}
.msg .lbl{font-size:11px}
.said{font-size:23px}
.rsay p{font-size:17px}
.you{max-width:75%}
.tochat p{font-size:14px}
.tochat .act{font-size:22px}
}
`;

// Search as you type (the form is a plain GET without it), CLEAR, and a voice note's ▶.
const JS = `(function(){var body=document.getElementById('h-body'),fq=document.querySelector('form.find'),q=document.getElementById('h-q'),clr=document.querySelector('.find .clr'),seq=0,timer=0;
function load(url){var n=++seq;fetch(url,{credentials:'same-origin',headers:{'Accept':'text/html'}}).then(function(r){if(!r.ok)throw r;return r.text()}).then(function(t){if(n!==seq)return;var d=new DOMParser().parseFromString(t,'text/html'),nb=d.getElementById('h-body');if(!nb){location.href=url;return}body.innerHTML=nb.innerHTML;history.replaceState(null,'',url)}).catch(function(){if(n===seq)location.href=url})}
function find(){clearTimeout(timer);var v=q.value.replace(/\\s+/g,' ').trim();if(clr)clr.hidden=!v;load(v?'/web/memory/history?q='+encodeURIComponent(v):'/web/memory/history')}
if(fq&&q&&body){fq.addEventListener('submit',function(e){e.preventDefault();find()});q.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(find,250)});q.addEventListener('keydown',function(e){if(e.key==='Escape'&&q.value){q.value='';find()}})}
if(clr&&q)clr.addEventListener('click',function(e){e.preventDefault();q.value='';find();q.focus()});
var playing=null;document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.vplay[data-src]');if(!b)return;if(playing){playing.pause();if(playing.src.indexOf(b.dataset.src)>=0){playing=null;return}}playing=new Audio(b.dataset.src);playing.play().catch(function(){})});
})();`;

function findForm(q) {
  return `<form class="find" role="search" method="GET" action="/web/memory/history">`
    + `<label class="lbl" for="h-q">FIND A MESSAGE</label><div class="find-l">`
    + `<input class="find-in" id="h-q" name="q" type="search" value="${esc(q)}" placeholder="hudson, the dentist…" maxlength="${MAX_QUERY}" autocomplete="off" enterkeyhint="search">`
    + `<a class="act2 clr" href="/web/memory/history"${q ? "" : " hidden"}>CLEAR</a><button class="sr" type="submit">Find</button></div></form>`;
}

/** One day row. The first row of a list names the unit (`· 14 MESSAGES`); the rest give the number, as drawn. */
function dayRow(d, now, first) {
  const n = first ? plural(d.count, "MESSAGE", "MESSAGES") : `${d.count}<span class="sr"> ${d.count === 1 ? "message" : "messages"}</span>`;
  return `<li><a class="dy" href="/web/memory/history?day=${d.key}"><span class="dy-d">${esc(dayName(d.key, now))}</span>`
    + `<span class="dy-go" aria-hidden="true">→</span><span class="dy-m">${esc(d.places.join(" + "))} · ${n}</span></a></li>`;
}
/**
 * One past Web-only chat (Home's composer, owner 10-27), in a day row's own style: what they opened
 * it with, then `WEB CHAT · <day> · N MESSAGES`; it opens the chat itself. PROVISIONAL placement,
 * pending design (SCOPE-v2 Q-v2-51).
 */
function chatRow(c, now) {
  // Its own short title once it has one (src/webchats.js), else what they opened it with.
  const first = String(c.title || c.first || "").replace(/\s+/g, " ").trim();
  const title = first ? (first.length > 48 ? `${first.slice(0, 47).trimEnd()}…` : first) : "A Web chat";
  return `<li><a class="dy" href="/web?chat=${esc(c.id)}"><span class="dy-d">${esc(title)}</span>`
    + `<span class="dy-go" aria-hidden="true">→</span><span class="dy-m">WEB CHAT · ${esc(dayName(dayKey(c.last_at), now).toUpperCase())} · ${plural(c.count, "MESSAGE", "MESSAGES")}</span></a></li>`;
}
/** 7A's list: the days and months of the shared thread, each Web chat just above the day it was last used on. */
function listHtml(conv, days, months, now) {
  const rows = [
    ...days.map((d, i) => ({ key: d.key, html: dayRow(d, now, i === 0) })),
    ...months.map(m => ({ key: m.key, html: monthRow(m, now) })),
    ...db.listWebChats(conv).map(c => ({ key: `${dayKey(c.last_at)}~`, at: c.last_at, html: chatRow(c, now) })),
  ];
  rows.sort((a, b) => (a.key === b.key ? (b.at ?? 0) - (a.at ?? 0) : a.key < b.key ? 1 : -1));
  return rows.map(r => r.html).join("");
}
function monthRow(m, now) {
  return `<li><a class="dy" href="/web/memory/history?month=${m.key}"><span class="dy-d">${esc(monthName(m.key, now))}</span>`
    + `<span class="dy-go" aria-hidden="true">→</span><span class="dy-m">${plural(m.count, "MESSAGE", "MESSAGES")} · ${plural(m.days, "DAY", "DAYS")}</span></a></li>`;
}

function hitsHtml(conv, q, now) {
  const { total, hits } = searchMessages(conv, q);
  const service = serviceOf(conv);
  const time = fmt({ hour: "numeric", minute: "2-digit" });
  const items = hits.map(r => {
    const k = dayKey(r.at);
    const lbl = `${r.role === "user" ? "YOU" : "REASON"} · ${where(r.channel, service)} · ${dayName(k, now).toUpperCase()} · ${time.format(r.at)}`;
    return `<li><a class="hit" href="/web/memory/history?day=${k}#m-${r.id}"><span class="lbl">${esc(lbl)}</span><span class="hit-t">${markedHtml(snippet(r.text, q), q)}</span></a></li>`;
  }).join("");
  const count = total > hits.length ? `${plural(total, "MESSAGE", "MESSAGES")} · THE NEWEST ${hits.length}` : plural(total, "MESSAGE", "MESSAGES");
  return `<p class="cnt" role="status">${count}</p><ul class="hits">${items}</ul>`
    + (total ? "" : `<p class="nomore">Nothing matches.</p>`);
}

/**
 * The page for `query` (`day`, `month`, `q`, or none), or null when the day or month asked for holds
 * nothing of this conversation's (a 404).
 */
export function renderHistory({ account, query = {}, now = clock.now() }) {
  const conv = account.conversation_id;
  const day = DAY.test(String(query.day ?? "")) ? String(query.day) : "";
  const month = MONTH.test(String(query.month ?? "")) ? String(query.month) : "";
  if (query.day != null && query.day !== "") {
    if (!day) return null;
    const lines = dayLines(conv, day);
    if (!lines.length) return null;
    const back = day.slice(0, 7) < monthKey(now) ? `/web/memory/history?month=${day.slice(0, 7)}` : "/web/memory/history";
    const body = `<header class="hh">${typed("← HISTORY", { href: back })}<span class="ro">READ-ONLY</span></header>`
      + `<main class="hist day" aria-labelledby="h-h"><h1 id="h-h" class="h1">${esc(dayName(day, now))}</h1>`
      + `<ol class="lines">${lines.map(m => `<li class="msg ${m.role === "user" ? "you" : "re"}" id="m-${m.id}">${m.html}</li>`).join("")}</ol></main>`
      + `<div class="tochat"><p>To change something, tell Reason.</p>${action("Go to chat", { href: "/web?thread" })}</div>`;
    return webPage({ title: `Reason — ${dayName(day, now)}`, body, css: COMPOSE_CSS + CSS, script: JS, foot: "" });
  }
  if (query.month != null && query.month !== "") {
    if (!month) return null;
    const days = historyDays(conv).filter(d => d.key.startsWith(`${month}-`));
    if (!days.length) return null;
    const body = `<header class="hh">${typed("← HISTORY", { href: "/web/memory/history" })}<span class="ro">READ-ONLY</span></header>`
      + `<main class="hist" aria-labelledby="h-h"><h1 id="h-h" class="h1">${esc(monthName(month, now))}</h1>`
      + `<div class="h-body"><ul class="days">${days.map((d, i) => dayRow(d, now, i === 0)).join("")}</ul></div></main>`;
    return webPage({ title: `Reason — ${monthName(month, now)}`, body, css: CSS, script: JS, foot: "" });
  }
  const q = cleanQuery(query.q);
  let inner;
  if (q) inner = hitsHtml(conv, q, now);
  else {
    const { days, months } = historyList(conv, now);
    const list = listHtml(conv, days, months, now);
    inner = list
      ? `<ul class="days">${list}</ul>`
      : `<p class="nomore">Nothing here yet.</p>`;
  }
  const body = `<header class="hh">${typed("← MEMORY", { href: "/web/memory" })}</header>`
    + `<main class="hist" aria-labelledby="h-h"><div class="hist-lead"><h1 id="h-h" class="h1">Chat history</h1>`
    + `<p class="hist-sub">Every message, from iMessage and the web, in one place. Read-only for now.</p></div>`
    + findForm(q) + `<div class="h-body" id="h-body">${inner}</div>`
    + hand("deleting history isn't here yet. forgetting a fact is, in memory.", { cls: "note" }) + `</main>`;
  return webPage({ title: "Reason — Chat history", body, css: CSS, script: JS, foot: "" });
}
