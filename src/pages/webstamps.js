// Reason Web, Stamps (handoff 2026-10-27 "Coming back daily" §2, reference/stamps.html) and the public
// side of a shared stamp. Behind REASON_WEB_DAILY (src/dailyflag.js): with it off for a conversation,
// every route here answers exactly what it answered before it existed (E1's 404, or the next handler).
//
//   GET  /web/stamps[?page=N][&stamp=<id>]     the book: 8 spots a page, the selected stamp aside
//   POST /web/api/stamps/<id>/share            { showName } → { url } (JSON), or a form post back here
//   POST /web/api/stamps/<id>/share/revoke     stop sharing it
//   GET  /web/api/stamps/<id>/image.png        the share card as a PNG download (owner only, ?name=0|1)
//   GET  /s/<shareId>, /s/<shareId>/og.png     the public page and its link-preview card (src/http.js)
//
// What leaves the book is redacted in src/stamps.js (publicFace, publicLine): the stamp's name, a
// duration or a count, and the first name only when the owner leaves it on. Nothing else, anywhere a
// stranger can read it: the page, its title and meta tags, the card, the card's alt text, the headers.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import * as stamps from "../stamps.js";
import { dailyAllowedFor, waxLook } from "../dailyflag.js";
import { renderSealBook, renderSealSharePage, sealCardHtml, sealStoryHtml, sealFontCss, SEAL_CARD_VERSION } from "./webseals.js";
import { config } from "../config.js";
import { webPage, wordmark, label, hand, action, TOKENS, BUBBLE_PATH } from "./webkit.js";
import { WORDMARK_O } from "./wordmark.js";
import { dailyHeader, DAILY_HEAD_CSS } from "./webdailyhead.js";
import { ogFontCss } from "./made.js";
import { renderShareNotFound } from "./webedge.js";
import { readCookie } from "./access.js";
import { esc } from "./render.js";

export const PER_PAGE = 8;
export const MAX_HINTS = 2;
export const KEEP_LINE = "Stamps land when I do something worth remembering. There's nothing to keep up and nothing to lose.";
export const PRIVACY_NOTE = "A shared stamp shows what kind of thing I did and how long it took. Never who, where, or what it cost.";
const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

// ---------------------------------------------------------------- the book
const CSS = `${DAILY_HEAD_CSS}
.sb{flex-grow:1;width:100%;max-width:1160px;margin:0 auto;padding:56px 24px 64px;display:flex;flex-direction:column;gap:44px}
.sb-top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:20px}
.sb-top>div{display:flex;flex-direction:column;gap:12px}
.sb .lbl{font-size:12px;white-space:normal}
.sb-h1{margin:0;font:italic 400 clamp(44px,6vw,64px)/1.04 var(--serif);letter-spacing:-.02em}
.pages{display:flex;gap:4px;font:400 13px/1 var(--mono)}
.pages a{min-width:44px;height:44px;display:grid;place-items:center;text-decoration:none;color:var(--muted);border:1px solid transparent;border-radius:3px}
.pages a[aria-current=page]{color:var(--ink);border-color:var(--ink)}
.sb-cols{display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
.book{flex:1 1 600px;min-width:0;padding:32px}
.book ul{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:28px 20px}
.book li{display:flex;flex-direction:column;align-items:center;gap:14px;padding-top:8px}
.spot-f{display:flex;align-items:center;gap:2px}
.spot-d{font:400 11px/1 var(--mono);letter-spacing:.1em;color:var(--muted)}
.spot-d.new{color:var(--pen)}
.sh-b{width:44px;height:44px;border:0;background:transparent;color:var(--ink);display:grid;place-items:center;cursor:pointer;border-radius:3px;text-decoration:none}
.sh-b[aria-current=true]{color:var(--pen)}
.hint{font-size:13px;line-height:1.4;color:var(--muted);text-align:center;max-width:150px;margin:0}
.side{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:28px}
.side h2{margin:0;font:italic 400 40px/1.1 var(--serif)}
.side .story{margin:0;font-size:17px;line-height:1.6}
.side .keep{margin:0;font-size:15px;line-height:1.55;color:var(--muted)}
.in-thread{align-self:flex-start;font-size:15px;padding:4px 0;min-height:44px;display:inline-flex;align-items:center;text-underline-offset:4px}
.share{display:flex;flex-direction:column;gap:16px;padding-top:24px;border-top:1px dashed var(--hair);scroll-margin-top:24px}
.prev{margin:0;aspect-ratio:1200/630;padding:22px 24px;display:flex;align-items:center;gap:22px;overflow:hidden}
.prev figcaption{display:flex;flex-direction:column;gap:10px;min-width:0}
.prev .pv-ln{font:italic 400 22px/1.2 var(--serif)}
.prev .pv-host{font:400 10px/1 var(--mono);letter-spacing:.14em;color:var(--muted)}
.nm{display:flex;align-items:center;gap:12px;min-height:44px;font-size:15px;cursor:pointer}
.nm input{width:20px;height:20px;margin:0;accent-color:var(--ink)}
.btns{display:flex;flex-wrap:wrap;gap:8px}
.btns form{margin:0;display:contents}
.b1,.b2{height:44px;padding:0 16px;border-radius:3px;font:400 15px/1 var(--sans);cursor:pointer;display:inline-flex;align-items:center;text-decoration:none;box-sizing:border-box}
.b1{padding:0 18px;border:0;background:var(--ink);color:var(--ground);font-weight:500}
.b1:hover{color:var(--ground);opacity:.92}
.b2{border:1px solid var(--ink);background:transparent;color:var(--ink)}
.b2[hidden]{display:none}
.link-out{margin:0;font:400 12px/1.5 var(--mono);letter-spacing:.04em;color:var(--ink);overflow-wrap:anywhere}
.share .note{margin:0;font-size:14px;line-height:1.55;color:var(--muted)}
.share .stop{align-self:flex-start}
.side .hand{font-size:26px;transform:rotate(-1.5deg);transform-origin:left center;margin-top:4px}
@media (max-width:899px){.sb{padding:32px 20px 48px;gap:32px}.book{padding:20px}.sb-cols{gap:36px}}
`;

const SHARE_ICON = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`;

/** "SINCE AUGUST", or "SINCE AUGUST 2025" when it was another year. */
function sinceLine(ms, tz, now) {
  const f = (o, t) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(t);
  const month = f({ month: "long" }, ms).toUpperCase();
  return f({ year: "numeric" }, ms) === f({ year: "numeric" }, now) ? month : `${month} ${f({ year: "numeric" }, ms)}`;
}

/**
 * The book as a view model: pages of 8 in the order earned (page 1 the oldest), each page drawn newest
 * first; blank spots fill the last page, at most 2 of them with a hint (types not yet earned).
 */
export function bookView(all, { page = null, selectedId = null, tz = config.tz, now = Date.now() } = {}) {
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const selected = (selectedId != null ? all.find(s => s.id === selectedId) : null) ?? all.at(-1) ?? null;
  const selectedPage = selected ? Math.floor(all.indexOf(selected) / PER_PAGE) + 1 : pages;
  const n = Number.isInteger(page) && page >= 1 && page <= pages ? page : selectedPage;
  const on = all.slice((n - 1) * PER_PAGE, n * PER_PAGE).reverse();
  const earned = new Set(all.map(s => s.type));
  const blanks = n === pages ? PER_PAGE - on.length : 0;
  const hintTypes = stamps.HINT_ORDER.filter(t => !earned.has(t)).slice(0, Math.min(MAX_HINTS, blanks));
  const blank = Array.from({ length: blanks }, (_, i) => ({ type: hintTypes[i] ?? stamps.HINT_ORDER[(i + 3) % stamps.HINT_ORDER.length], hint: hintTypes[i] ? stamps.CATALOG[hintTypes[i]].hint : "" }));
  return {
    page: n, pages, count: all.length, on, blank, selected,
    newestId: all.at(-1)?.id ?? null,
    since: all.length ? sinceLine(all[0].earnedAt, tz, now) : "",
  };
}

const headLine = (v) => v.count
  ? `PAGE ${v.page} · ${v.count} STAMP${v.count === 1 ? "" : "S"} SINCE ${v.since}`
  : `PAGE ${v.page} · NO STAMPS YET`;

function spot(s, v) {
  const isNew = s.id === v.newestId;
  const sel = v.selected?.id === s.id;
  return `<li>${stamps.stampMarkup(s)}<span class="spot-f"><span class="spot-d${isNew ? " new" : ""}">${esc(s.date)}${isNew ? " · NEW" : ""}</span>`
    + `<a class="sh-b" href="/web/stamps?page=${v.page}&amp;stamp=${s.id}#share" aria-label="Share ${esc(s.name)}"${sel ? ` aria-current="true"` : ""} data-stamp="${s.id}">${SHARE_ICON}</a></span></li>`;
}
const blankSpot = (b) => `<li>${stamps.blankMarkup(b.type)}${b.hint ? `<p class="hint">${esc(b.hint)}</p>` : ""}</li>`;

/** The share panel for the selected stamp. `share`: its live link or null. */
function sharePanel(s, { share, first, csrf }) {
  const face = stamps.publicFace(s.row);
  const withName = stamps.publicLine(s.row, first);
  const without = stamps.publicLine(s.row, "");
  const showName = share ? !!share.show_name : true;
  const url = share ? stamps.shareUrl(share.share_id) : "";
  const act = `/web/api/stamps/${s.id}/share`;
  return `<section class="share" id="share" aria-labelledby="share-h"><p class="lbl" id="share-h">SHARE THIS STAMP</p>`
    + `<figure class="prev card">${stamps.stampMarkup(face, { size: "sm" })}<figcaption><span class="pv-ln" data-with="${esc(withName)}" data-without="${esc(without)}">${esc(first && showName ? withName : without)}</span><span class="pv-host">HEYREASON.COM</span></figcaption></figure>`
    + `<form method="POST" action="${act}" class="sh-f" data-stamp="${s.id}">`
    + `<input type="hidden" name="c" value="${esc(csrf)}">`
    + (first ? `<label class="nm"><input type="checkbox" name="showName" value="1"${showName ? " checked" : ""}>Show my first name</label>` : `<input type="hidden" name="showName" value="0">`)
    + `<div class="btns"><button class="b1" type="submit" data-copy>Copy link</button>`
    + `<a class="b2" href="${url ? `sms:&amp;body=${esc(encodeURIComponent(`${first && showName ? withName : without} ${url}`))}` : "#share"}" data-sms hidden>Send in iMessage</a>`
    + `<a class="b2" href="/web/api/stamps/${s.id}/image.png?name=${first && showName ? 1 : 0}" download="reason-stamp-${esc(s.type.replace(/_/g, "-"))}.png" data-save>Save image</a></div></form>`
    + `<p class="link-out" role="status" data-out>${url ? `Link: ${esc(url)}` : ""}</p>`
    + `<p class="note">${esc(PRIVACY_NOTE)}</p>`
    + `<form method="POST" action="${act}/revoke" class="stop-f"${url ? "" : " hidden"}><input type="hidden" name="c" value="${esc(csrf)}"><button class="act2 stop" type="submit">STOP SHARING</button></form>`
    + `</section>`;
}

/** The whole page. `all`: listStamps (oldest first, each with `.row`). */
export function renderStamps({ all = [], page = null, selectedId = null, first = "", csrf = "", tz = config.tz, now = Date.now(), share = null }) {
  const v = bookView(all, { page, selectedId, tz, now });
  const sel = v.selected;
  const pager = v.pages > 1
    ? `<nav class="pages" aria-label="Pages of the book">${Array.from({ length: v.pages }, (_, i) => `<a href="/web/stamps?page=${i + 1}"${i + 1 === v.page ? ` aria-current="page"` : ""}>${i + 1}</a>`).join("")}</nav>` : "";
  const book = `<section class="book card" aria-label="Stamps on this page"><ul>${v.on.map(s => spot(s, v)).join("")}${v.blank.map(blankSpot).join("")}</ul></section>`;
  const left = v.blank.length;
  const margin = sel && left > 0 ? hand(`${NUM[left] ?? left} blank spot${left === 1 ? "" : "s"} left on this page.`) : "";
  const aside = sel
    ? `<aside class="side" aria-labelledby="sel-h">${label(sel.id === v.newestId ? "THE NEWEST" : sel.date)}<h2 id="sel-h">${esc(sel.name)}.</h2>`
      + `<p class="story">${esc(sel.story)}</p><p class="keep">${esc(KEEP_LINE)}</p>`
      + `<a class="in-thread" href="${esc(sel.href)}">See it in the thread</a>`
      + sharePanel(sel, { share, first, csrf }) + margin + `</aside>`
    : `<aside class="side" aria-labelledby="sel-h">${label("THE FIRST ONE")}<h2 id="sel-h">Nothing here yet.</h2>`
      + `<p class="story">${esc(KEEP_LINE)}</p><a class="in-thread" href="/web?thread">Go to the thread</a></aside>`;
  const body = dailyHeader("stamps")
    + `<main class="sb" id="content"><div class="sb-top"><div>${label(headLine(v))}<h1 class="sb-h1">Your stamp book.</h1></div>${pager}</div>`
    + `<div class="sb-cols">${book}${aside}</div></main>`;
  return webPage({ title: "Reason — your stamp book", body, css: CSS, script: SHARE_JS });
}

// The share panel's script: the name toggle rewrites the preview line and the save link; Copy link asks
// for the link (POST, the session's secret in x-reason-csrf) and puts it on the clipboard; Send in
// iMessage shows on Apple devices only and opens Messages with the line and the link. Without script,
// Copy link is a form post that comes back with the link written out.
const SHARE_JS = `(function(){var f=document.querySelector('.sh-f');if(!f)return;var id=f.dataset.stamp,c=f.querySelector('[name=c]').value,cb=f.querySelector('[name=showName][type=checkbox]'),ln=document.querySelector('.prev .pv-ln'),out=document.querySelector('[data-out]'),sms=f.querySelector('[data-sms]'),save=f.querySelector('[data-save]'),stop=document.querySelector('.stop-f'),url=(out.textContent.match(/https?:\\S+/)||[''])[0];
var apple=/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
function on(){return cb?cb.checked:false}function line(){return on()?ln.dataset.with:ln.dataset.without}
function draw(){ln.textContent=line();save.href='/web/api/stamps/'+id+'/image.png?name='+(on()?1:0);if(url){sms.href='sms:&body='+encodeURIComponent(line()+' '+url)}if(apple)sms.hidden=false}
function ask(){return fetch('/web/api/stamps/'+id+'/share',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json','x-reason-csrf':c},body:JSON.stringify({showName:on()})}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(j){url=j.url;out.textContent='Link: '+url;stop.hidden=false;draw();return url})}
if(cb)cb.addEventListener('change',function(){draw();if(url)ask().catch(function(){})});
f.addEventListener('submit',function(e){e.preventDefault();ask().then(function(u){var done=function(){out.textContent='Link copied: '+u};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(u).then(done,function(){out.textContent='Link: '+u});else out.textContent='Link: '+u}).catch(function(){out.textContent='That didn\\u2019t go through. Try again in a moment.'})});
sms.addEventListener('click',function(e){if(url)return;e.preventDefault();ask().then(function(){location.href=sms.href}).catch(function(){})});
draw()})();`;

// ---------------------------------------------------------------- the card (1200×630)
const P = TOKENS.paper;
const SERIF = `'Reason Serif','Instrument Serif',Georgia,serif`;
const MONO = `'Courier New',Courier,monospace`;
/** Bump when the card's drawing changes: it is part of every cached file's name. */
export const STAMP_OG_VERSION = 1;

/**
 * The share card, in the link-preview cards' frame (src/pages/made.js: the wordmark and the host on top,
 * the content low): the stamp, its one line, HEYREASON.COM. Drawn from a publicFace and a publicLine only.
 */
export function stampOgHtml({ face, line, fontCss = "" }) {
  const mark = `<span style="font-family:${SERIF};font-style:italic;font-size:40px;display:inline-flex;align-items:center;line-height:1;white-space:nowrap">reas<svg aria-hidden="true" viewBox="0 0 40 40" style="width:22px;height:22px;transform:skewX(-10deg);margin:5px 2px 0"><path d="${BUBBLE_PATH}" fill="none" stroke="${P.pen}" stroke-width="5" stroke-linejoin="round"/></svg>${WORDMARK_O}n</span>`;
  const size = line.length > 70 ? 54 : 62;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}
:root{--pen:${P.pen};--ink:${P.ink};--muted:${P.muted};--mono:${MONO};--serif:${SERIF}}
body{margin:0;background:${P.ground}}</style></head><body>`
    + `<div style="width:1200px;height:630px;box-sizing:border-box;background:${P.ground};color:${P.ink};padding:64px 80px;display:flex;flex-direction:column;overflow:hidden">`
    + `<div style="display:flex;justify-content:space-between;align-items:center">${mark}<span style="font-family:${MONO};font-size:16px;letter-spacing:.14em;color:${P.muted}">HEYREASON.COM</span></div>`
    + `<div style="margin-top:auto;display:flex;align-items:center;gap:64px">`
    + `<div style="flex-shrink:0;width:330px;display:flex;justify-content:center">${stamps.stampMarkup(face, { size: 2.2 })}</div>`
    + `<div style="display:flex;flex-direction:column;gap:22px;min-width:0"><span style="font-family:${MONO};font-size:18px;letter-spacing:.14em;color:${P.muted}">A STAMP FROM REASON</span>`
    + `<p style="margin:0;font-family:${SERIF};font-style:italic;font-size:${size}px;line-height:1.08;letter-spacing:-.01em">${esc(line)}</p></div></div></div></body></html>`;
}

/** The words a link preview carries for a share: the stamp's name, and its one line. */
export const ogTitle = (face) => `${face.name} · a stamp from Reason`;
export const ogAlt = (face, line) => `${face.ariaLabel}. ${line}`;

let shooter = null;
/** Tests hand in their own drawing; the server draws with card.js's headless Chromium. */
export function setStampShooter(fn) { shooter = fn; }
async function shoot(html, size = null) {
  if (shooter) return await shooter(html, size);
  const { shootWithChromium } = await import("./card.js");
  return await shootWithChromium(html, size ?? undefined);
}
// One drawing at a time, and a minute's rest after a failure: the card is fetched without sign-in.
let drawing = Promise.resolve();
let failedAt = 0;
/** The card's PNG for this face and line, drawn once and kept under data/cards (keyed on what is on it). */
export async function stampCardPng(face, line) {
  return await drawnPng({ v: STAMP_OG_VERSION, face, line }, () => stampOgHtml({ face, line, fontCss: ogFontCss() }));
}
/**
 * A wax seal's picture: "card" (1200×630, og:image and Save image) or "story" (1080×1920). Drawn from
 * publicSeal only (src/stamps.js), the first name only when it is passed.
 */
export async function sealPng(pub, first, kind = "card") {
  const { whoWith, ...face } = pub;
  const size = kind === "story" ? { width: 1080, height: 1920 } : { width: 1200, height: 630 };
  const who = whoWith(first);
  return await drawnPng({ v: `w${SEAL_CARD_VERSION}`, kind, face, who }, () => (kind === "story" ? sealStoryHtml : sealCardHtml)({ pub, first, fontCss: sealFontCss() }), size);
}
async function drawnPng(keyOf, html, size = null) {
  const key = createHash("sha256").update(JSON.stringify(keyOf)).digest("hex").slice(0, 20);
  const dir = join(config.dataDir, "cards");
  const file = join(dir, `stamp-${key}.png`);
  if (existsSync(file)) return readFileSync(file);
  if (!shooter && Date.now() - failedAt < 60_000) return null;
  const run = drawing.then(async () => {
    if (existsSync(file)) return readFileSync(file);
    const png = await shoot(html(), size);
    if (!png?.length) { failedAt = Date.now(); return null; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, png);
    return png;
  }).catch(() => { failedAt = Date.now(); return null; });
  drawing = run.then(() => {}, () => {});
  return await run;
}
const genericOg = () => readFileSync(new URL("../../assets/og.png", import.meta.url));

// ---------------------------------------------------------------- the owner's routes
const json = (status, obj, headers) => {
  const body = JSON.stringify(obj);
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers, "Content-Length": Buffer.byteLength(body) }, body };
};
function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** The view models listStamps gives, each carrying its own row (for publicFace/publicLine). */
function bookOf(conversationId) {
  const rows = db.db.prepare("SELECT * FROM stamps WHERE conversation_id = ? ORDER BY earned_at, id").all(conversationId);
  return rows.map(r => { const s = stamps.summarize(r); return s ? { ...s, row: r } : null; }).filter(Boolean);
}

/**
 * Everything under /web/stamps and /web/api/stamps for a signed-in account. `path`: "" (the book) or
 * "<id>/share" | "<id>/share/revoke" | "<id>/image.png". `sec`: the Web pages' security headers.
 * Returns null when REASON_WEB_DAILY does not allow this conversation (the caller answers as before).
 */
export async function stampsRequest({ account, path = "", method = "GET", query = {}, headers = {}, readBody = async () => "", sec = {}, log = () => {} }) {
  const conv = account?.conversation_id;
  if (!conv || !dailyAllowedFor(conv)) return null;
  const first = stamps.firstNameOf(account.name ?? db.getAccount(conv)?.name ?? "");
  const html = (status, body, extra = {}) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...sec, ...extra, "Content-Length": Buffer.byteLength(body) }, body });

  if (path === "") {
    if (method !== "GET" && method !== "HEAD") return html(405, "", { Allow: "GET, HEAD" });
    const all = bookOf(conv);
    const selectedId = /^\d{1,12}$/.test(String(query.stamp ?? "")) ? Number(query.stamp) : null;
    const page = /^\d{1,4}$/.test(String(query.page ?? "")) ? Number(query.page) : null;
    const csrf = db.pageSessionCsrf(readCookie(headers.cookie)) ?? "";
    if (waxLook()) {
      if (stamps.checkAnniversary(conv).length) all.splice(0, all.length, ...bookOf(conv));
      const sel = (selectedId != null ? all.find(s => s.id === selectedId && !s.outside) : null) ?? all.filter(s => !s.outside).at(-1) ?? null;
      const share = sel ? stamps.activeShare(sel.id) : null;
      return html(200, renderSealBook({ all, page, selectedId, first, csrf, tz: stamps.tzFor(conv), share }));
    }
    const v = bookView(all, { page, selectedId });
    const share = v.selected ? stamps.activeShare(v.selected.id) : null;
    return html(200, renderStamps({ all, page, selectedId, first, csrf, tz: stamps.tzFor(conv), share }));
  }

  const m = /^(\d{1,12})\/(share|share\/revoke|image\.png|story\.png)$/.exec(path);
  if (!m) return null;
  const id = Number(m[1]);
  const stamp = stamps.stampFor(conv, id);
  const wantsJson = String(headers.accept ?? "").includes("application/json") || String(headers["content-type"] ?? "").includes("application/json");

  if (m[2] === "image.png" || m[2] === "story.png") {
    if (method !== "GET" && method !== "HEAD") return html(405, "", { Allow: "GET, HEAD" });
    if (!stamp || (m[2] === "story.png" && !waxLook())) return json(404, { ok: false, error: "not_found" }, sec);
    const row = db.db.prepare("SELECT * FROM stamps WHERE id = ?").get(id);
    if (waxLook()) {
      const kind = m[2] === "story.png" ? "story" : "card";
      const png = await sealPng(stamps.publicSeal(row), query.name === "0" ? "" : first, kind);
      if (!png) return json(503, { ok: false, error: "no_picture" }, sec);
      return { status: 200, headers: { ...sec, "Content-Type": "image/png", "Content-Length": png.length, "Content-Disposition": `attachment; filename="reason-seal-${row.type.replace(/_/g, "-")}${kind === "story" ? "-story" : ""}.png"` }, body: png };
    }
    const face = stamps.publicFace(row);
    const line = stamps.publicLine(row, query.name === "0" ? "" : first);
    const png = await stampCardPng(face, line);
    if (!png) return json(503, { ok: false, error: "no_picture" }, sec);
    return { status: 200, headers: { ...sec, "Content-Type": "image/png", "Content-Length": png.length, "Content-Disposition": `attachment; filename="reason-stamp-${row.type.replace(/_/g, "-")}.png"` }, body: png };
  }

  // The two POSTs: signed in, from Reason's own page, with the session's own secret.
  if (method !== "POST") return json(405, { ok: false, error: "method" }, { ...sec, Allow: "POST" });
  const raw = String((await readBody()) ?? "");
  let body = {};
  if (String(headers["content-type"] ?? "").includes("application/json")) { try { body = JSON.parse(raw || "{}") ?? {}; } catch { body = {}; } }
  else body = Object.fromEntries(new URLSearchParams(raw));
  const { sameOrigin } = await import("./websignin.js");
  const secret = db.pageSessionCsrf(readCookie(headers.cookie));
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] ?? body.c, secret)) {
    log({ stamp_share_refused: "origin_or_token" });
    return json(403, { ok: false, error: "not_from_this_page" }, sec);
  }
  if (!stamp) return json(404, { ok: false, error: "not_found" }, sec);
  const back = { status: 303, headers: { ...sec, Location: `/web/stamps?stamp=${id}#share`, "Content-Length": 0 }, body: "" };
  if (m[2] === "share/revoke") {
    const was = stamps.revokeShares(conv, id, { log });
    return wantsJson ? json(200, { ok: true, revoked: was }, sec) : back;
  }
  const showName = body.showName === true || body.showName === "1" || body.showName === "on";
  const out = stamps.shareStamp(conv, id, { showName, log });
  return wantsJson ? json(200, { url: out.url }, sec) : back;
}

// ---------------------------------------------------------------- the public routes
const PUBLIC_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store",
};
const PUBLIC_CSS = `
.pub-h{padding:22px clamp(20px,4vw,48px)}
.pub{flex:1 0 auto;width:100%;max-width:760px;margin:0 auto;padding:40px 24px 72px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:34px}
.pub .stp{margin:24px 0 8px!important}
.pub-l{margin:0;font:italic 400 clamp(30px,5vw,44px)/1.15 var(--serif);letter-spacing:-.01em;max-width:620px}
.pub .lbl{font-size:12px}
.pub .act{align-self:center}
@media (min-width:900px){.pub{padding-top:72px}}
`;

/** The public page of one live share: the large stamp, its line, HEYREASON.COM, and the way to get a Reason. */
export function renderSharePage({ face, line, shareId }) {
  const site = (config.siteUrl || "https://heyreason.com").replace(/\/+$/, "");
  const page = stamps.shareUrl(shareId);
  const image = `${page}/og.png?v=${STAMP_OG_VERSION}`;
  const title = ogTitle(face);
  const tags = [
    `<meta name="description" content="${esc(line)}">`,
    `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="${esc(line)}">`,
    `<meta property="og:url" content="${esc(page)}">`, `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/png">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(ogAlt(face, line))}">`,
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(line)}">`, `<meta name="twitter:image" content="${esc(image)}">`,
  ].join("\n");
  const body = `<header class="pub-h">${wordmark({ href: site })}</header>`
    + `<main class="pub" id="content">${label("A STAMP FROM REASON")}${stamps.stampMarkup(face, { size: "lg" })}`
    + `<p class="pub-l">${esc(line)}</p>${label("HEYREASON.COM")}`
    + action("Get your own Reason", { href: `${site}/?ref=s_${shareId}` })
    + `</main>`;
  return webPage({ title, body, css: PUBLIC_CSS, head: tags });
}

/**
 * The one answer for a /s/ page with no live share behind it: never existed, turned off, its owner's
 * flag no longer on, or not an id at all. A 404 page, the same bytes for each, so nobody learns which.
 */
export function shareNotFound() {
  const body = renderShareNotFound({ thing: waxLook() ? "seal" : "stamp" });
  return { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...PUBLIC_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
}

/**
 * GET /s/<shareId>[/og.png]. No live share by that id (none, turned off, or the flag no longer allows
 * its owner): the 404 page, or for the picture null, so the caller answers it the plain not-found it
 * gives any address. A 12-character id is never a sign-in token (32–64), so nothing is lost there.
 */
export async function shareRequest({ shareId, sub = null, method = "GET", log = () => {} }) {
  const v = stamps.shareView(shareId);
  if (!v || v.revoked || !dailyAllowedFor(v.share.conversation_id)) return sub === "og.png" ? null : shareNotFound();
  if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { ...PUBLIC_HEADERS, Allow: "GET, HEAD", "Content-Length": 0 }, body: "" };
  if (sub === "og.png") {
    const png = await (waxLook() ? sealPng(stamps.publicSeal(v.stamp), v.first) : stampCardPng(stamps.publicFace(v.stamp), stamps.publicLine(v.stamp, v.first))).catch(() => null);
    const bytes = png ?? genericOg();
    return { status: 200, headers: { "Content-Type": "image/png", "Content-Length": bytes.length, "Cache-Control": png ? "public, max-age=300" : "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" }, body: bytes };
  }
  if (method === "GET") stamps.noteShareOpened(shareId, { log });
  const body = waxLook()
    ? renderSealSharePage({ pub: stamps.publicSeal(v.stamp, v.first), shareId })
    : renderSharePage({ face: stamps.publicFace(v.stamp), line: stamps.publicLine(v.stamp, v.first), shareId });
  return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...PUBLIC_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
}
