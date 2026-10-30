// Reason Web, Stamps as a wax-seal book (handoff 2026-10-27 "S3 · Old money, made real":
// reference/stamps.html, stamp-kit.html). Drawn instead of the typed book when REASON_STAMPS_WAX is on
// (src/dailyflag.js waxLook); the routes, shares, CSRF and redaction stay in src/pages/webstamps.js.
//
//   the page      a paper sheet of 8 spots, each seal tilted by its own fixed rotation, its name, date,
//                 a share button; not-yet spots are blind-embossed seals, at most 2, the hint engraved
//   the aside     the selected (newest) seal's story, SHARE IT (the compliments card on bottle green,
//                 Show my first name, Copy link / Send in iMessage / Save image), KEPT OUTSIDE THE BOOK
//   the card      1200×630 (link preview, Save image) and 9:16 (story), drawn on the server
//   the public    /s/<id>: the large seal, its one line, the date, "Get your own Reason"
//
// What leaves the book is src/stamps.js publicSeal: the seal's name, a duration or a count, the date,
// and the first name only when the owner leaves it on.
import * as stamps from "../stamps.js";
import { seal, patch, ticket, complimentsCard, GRAIN_DEF, grainLayer, BOTTLE, words } from "../seal.js";
import { webPage, wordmark, label, action, WEB_FONTS } from "./webkit.js";
import { dailyHeader, DAILY_HEAD_CSS } from "./webdailyhead.js";
import { config } from "../config.js";
import { esc } from "./render.js";

export const PER_PAGE = 8;
export const MAX_HINTS = 2;
export const PRIVACY_NOTE = "A shared seal says what kind of thing was done and how long it took. Never who, where, or what it cost.";
export const KEEP_LINE = "Seals land when I do something worth remembering. There's nothing to keep up and nothing to lose.";
/** The sheet is paper in both themes: a page of a book, like the card is a card. */
const SHEET = "#f6efe0";

const CSS = `${DAILY_HEAD_CSS}
.sb{flex-grow:1;width:100%;max-width:1200px;margin:0 auto;box-sizing:border-box;padding:56px clamp(16px,3vw,24px) 64px;display:flex;flex-direction:column;gap:44px}
.sb-top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:20px}
.sb-top>div{display:flex;flex-direction:column;gap:12px}
.sb .lbl{font-size:12px;white-space:normal}
.sb-h1{margin:0;font:italic 400 clamp(44px,6vw,64px)/1.04 var(--serif);letter-spacing:-.02em}
.pages{display:flex;gap:4px;font:400 13px/1 var(--mono)}
.pages a{min-width:44px;height:44px;display:grid;place-items:center;text-decoration:none;color:var(--muted);border:1px solid transparent;border-radius:3px;box-sizing:border-box}
.pages a[aria-current=page]{color:var(--ink);border-color:var(--ink)}
.sb-cols{display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
.sheet{--ink:#2a2520;--muted:#78705f;--pen:#9c3b2e;color:#2a2520;flex:1 1 620px;min-width:0;position:relative;background:${SHEET};border-radius:3px;box-shadow:0 1px 1px rgba(30,24,18,.18),0 10px 18px -6px rgba(30,24,18,.2),0 30px 50px -20px rgba(30,24,18,.25);padding:clamp(24px,4vw,40px);box-sizing:border-box}
.sheet ul{position:relative;margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:24px 16px}
.sheet ul.none{grid-template-columns:repeat(auto-fit,minmax(170px,240px));justify-content:center;padding:24px 0}
.sheet li{display:flex;flex-direction:column;align-items:center;gap:6px}
.sp-n{font:italic 400 18px/1.25 var(--serif);text-align:center}
.sp-f{display:flex;align-items:center;gap:2px}
.sp-d{font:400 11px/1 var(--mono);letter-spacing:.1em;color:#78705f}
.sp-d.new{color:#9c3b2e}
.sh-b{width:44px;height:44px;border:0;background:transparent;color:#2a2520;display:grid;place-items:center;cursor:pointer;border-radius:3px;text-decoration:none}
.sh-b:focus-visible{outline-color:#2a2520}
.sp-h{font-size:14px;line-height:1.4;color:#5e564a;text-align:center;max-width:160px;min-height:44px;display:flex;align-items:center;justify-content:center}
.side{flex:1 1 340px;min-width:0;display:flex;flex-direction:column;gap:24px}
.side h2{margin:0;font:italic 400 40px/1.1 var(--serif)}
.side .story{margin:0;font-size:17px;line-height:1.6}
.in-thread{align-self:flex-start;font-size:15px;padding:4px 0;min-height:44px;display:inline-flex;align-items:center;text-underline-offset:4px}
.sec{display:flex;flex-direction:column;gap:16px;padding-top:24px;border-top:1px dashed var(--hair);scroll-margin-top:24px}
.prev{margin:0;position:relative;background:${BOTTLE};border-radius:3px;aspect-ratio:1200/630;display:grid;place-items:center;overflow:hidden}
.prev>div{position:relative;width:73%}
.nm{display:flex;align-items:center;gap:12px;min-height:44px;font-size:15px;cursor:pointer}
.nm input{width:20px;height:20px;margin:0;accent-color:var(--ink)}
.btns{display:flex;flex-wrap:wrap;gap:8px}
.btns form{margin:0;display:contents}
.b1,.b2{height:44px;padding:0 16px;border-radius:3px;font:400 15px/1 var(--sans);cursor:pointer;display:inline-flex;align-items:center;text-decoration:none;box-sizing:border-box}
.b1{padding:0 18px;border:0;background:var(--ink);color:var(--ground);font-weight:500}
.b1:hover{color:var(--ground);opacity:.92}
.b2{border:1px solid var(--ink);background:transparent;color:var(--ink)}
.b2[hidden]{display:none}
.link-out{margin:0;font:400 12px/1.5 var(--mono);letter-spacing:.04em;overflow-wrap:anywhere}
.link-out:empty{display:none}
.sec .note{margin:0;font-size:14px;line-height:1.55;color:var(--muted)}
.stop{align-self:flex-start}
.kept{display:flex;flex-direction:column;gap:14px;padding-top:24px;border-top:1px dashed var(--hair)}
.kp{display:flex;align-items:center;gap:16px}
.kp>div{transform:rotate(-5deg);flex-shrink:0}
.kp>span{font-size:15px;line-height:1.5}
.kp em{font:italic 400 20px var(--serif)}
.side .hand{margin:4px 0 0;font:400 26px/1.2 var(--hand);color:var(--pen);transform:rotate(-1.5deg);transform-origin:left center}
`;

const SHARE_ICON = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`;

/** "SINCE AUGUST", or "SINCE AUGUST 2025" when it was another year. */
function sinceLine(ms, tz, now) {
  const f = (o, t) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(t);
  const month = f({ month: "long" }, ms).toUpperCase();
  return f({ year: "numeric" }, ms) === f({ year: "numeric" }, now) ? month : `${month} ${f({ year: "numeric" }, ms)}`;
}

/**
 * The book as a view model. `all`: every summary (oldest first, each with `.row`); seals go in the book,
 * one-offs (first errand, anniversary, suite key) are kept outside it. Pages of 8 in the order earned
 * (page 1 the oldest), each drawn newest first; the last page offers at most 2 not-yet spots.
 */
export function sealBookView(all, { page = null, selectedId = null, tz = config.tz, now = Date.now() } = {}) {
  const book = all.filter(s => !s.outside);
  const outside = all.filter(s => s.outside);
  const pages = Math.max(1, Math.ceil(book.length / PER_PAGE));
  const selected = (selectedId != null ? book.find(s => s.id === selectedId) : null) ?? book.at(-1) ?? null;
  const selectedPage = selected ? Math.floor(book.indexOf(selected) / PER_PAGE) + 1 : pages;
  const n = Number.isInteger(page) && page >= 1 && page <= pages ? page : selectedPage;
  const on = book.slice((n - 1) * PER_PAGE, n * PER_PAGE).reverse();
  const earned = new Set(book.map(s => s.type));
  const room = n === pages ? PER_PAGE - on.length : 0;
  const blank = stamps.sealHintOrder().filter(t => !earned.has(t)).slice(0, Math.min(MAX_HINTS, room))
    .map(type => ({ type, hint: stamps.SEALS[type].hint }));
  return {
    page: n, pages, count: book.length, on, blank, selected, room, outside,
    newestId: book.at(-1)?.id ?? null,
    since: book.length ? sinceLine(book[0].earnedAt, tz, now) : "",
  };
}

const headLine = (v) => v.count
  ? `PAGE ${v.page} · ${v.count} SEAL${v.count === 1 ? "" : "S"} SINCE ${v.since}`
  : `PAGE ${v.page} · NO SEALS YET`;

function spot(s, v) {
  const isNew = s.id === v.newestId;
  return `<li><div style="transform:rotate(${s.rotation ?? 0}deg)">${seal({ wax: s.wax, ring: s.ring, date: s.postmarkDate, size: 160, label: s.ariaLabel })}</div>`
    + `<span class="sp-n">${esc(s.name)}</span>`
    + `<span class="sp-f"><span class="sp-d${isNew ? " new" : ""}">${esc(s.date)}${isNew ? " · NEW" : ""}</span>`
    + `<a class="sh-b" href="/web/stamps?page=${v.page}&amp;stamp=${s.id}#share" aria-label="Share ${esc(s.name)}"${v.selected?.id === s.id ? ` aria-current="true"` : ""}>${SHARE_ICON}</a></span></li>`;
}
const blankSpot = (b) => `<li>${seal({ wax: "blank", ring: `NOT YET · ${b.hint.toUpperCase()} ·`, paper: SHEET, size: 160, label: `Not yet earned: ${b.hint}` })}<span class="sp-h">${esc(b.hint)}</span></li>`;

/** The card's words for a seal and a name choice, and its full label. */
function cardWords(pub, first, showName) {
  const who = pub.whoWith(first && showName ? first : "");
  return { who, label: `An engraved card, torn from a pad and folded once: with the compliments of Reason, ${who}. Sealed with wax.` };
}

/** SHARE IT for the selected seal. `share`: its live link or null. */
function sharePanel(s, { share, first, csrf }) {
  const pub = stamps.publicSeal(s.row, first);
  const showName = share ? !!share.show_name : true;
  const on = cardWords(pub, first, showName), withName = pub.whoWith(first), without = pub.whoWith("");
  const url = share ? stamps.shareUrl(share.share_id) : "";
  const act = `/web/api/stamps/${s.id}/share`;
  const card = complimentsCard({ wax: pub.wax, ring: pub.ring, who: on.who, when: pub.when, width: "100%", label: on.label,
    whoAttrs: `data-with="${esc(withName)}" data-without="${esc(without)}"` });
  return `<section class="sec" id="share" aria-labelledby="share-h"><p class="lbl" id="share-h">SHARE IT</p>`
    + `<figure class="prev">${grainLayer("soft-light", 0.6)}<div>${card}</div></figure>`
    + `<form method="POST" action="${act}" class="sh-f" data-stamp="${s.id}">`
    + `<input type="hidden" name="c" value="${esc(csrf)}">`
    + (first ? `<label class="nm"><input type="checkbox" name="showName" value="1"${showName ? " checked" : ""}>Show my first name</label>` : `<input type="hidden" name="showName" value="0">`)
    + `<div class="btns"><button class="b1" type="submit">Copy link</button>`
    + `<a class="b2" href="${url ? `sms:&amp;body=${esc(encodeURIComponent(`${pub.story} ${url}`))}` : "#share"}" data-sms data-line="${esc(pub.story)}" hidden>Send in iMessage</a>`
    + `<a class="b2" href="/web/api/stamps/${s.id}/image.png?name=${first && showName ? 1 : 0}" download="reason-seal-${esc(s.type.replace(/_/g, "-"))}.png" data-save>Save image</a></div></form>`
    + `<p class="link-out" role="status" data-out>${url ? `Link: ${esc(url)}` : ""}</p>`
    + `<p class="note">${esc(PRIVACY_NOTE)}</p>`
    + `<form method="POST" action="${act}/revoke" class="stop-f"${url ? "" : " hidden"}><input type="hidden" name="c" value="${esc(csrf)}"><button class="act2 stop" type="submit">STOP SHARING</button></form>`
    + `</section>`;
}

/** KEPT OUTSIDE THE BOOK: the first-errand patch and, at a year, the ticket. Hidden when neither is earned. */
function keptOutside(outside, tz = config.tz) {
  const first = outside.find(s => s.type === "first");
  const year = outside.find(s => s.type === "anniversary");
  if (!first && !year) return "";
  const rows = [];
  if (first) rows.push(`<div class="kp"><div>${patch({ date: first.postmarkDate, size: 96, label: `An embroidered patch on green twill: first errand, with Reason's r, dated ${first.postmarkDate}` })}</div><span><em>The first errand.</em><br>Sewn on day one.</span></div>`);
  if (year) {
    const serial = Number(year.values?.serial) || 1;
    const from = new Date(year.values?.from ?? year.earnedAt - 365 * 86_400_000), to = new Date(year.earnedAt);
    const my = (d) => d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: tz }).toUpperCase();
    rows.push(`<div class="kp"><div>${ticket({ serial, span: `${my(from)} TO ${my(to)}`, width: 132, label: `A creased paper ticket: admit one, a year of things handled, with Reason, number ${String(serial).padStart(6, "0")}` })}</div><span><em>A year of things handled.</em><br>One year in.</span></div>`);
  }
  return `<div class="kept"><p class="lbl">KEPT OUTSIDE THE BOOK</p>${rows.join("")}</div>`;
}

/** The whole page. `all`: listStamps-style summaries (oldest first, each with `.row`). */
export function renderSealBook({ all = [], page = null, selectedId = null, first = "", csrf = "", tz = config.tz, now = Date.now(), share = null }) {
  const v = sealBookView(all, { page, selectedId, tz, now });
  const sel = v.selected;
  const pager = v.pages > 1
    ? `<nav class="pages" aria-label="Pages of the book">${Array.from({ length: v.pages }, (_, i) => `<a href="/web/stamps?page=${i + 1}"${i + 1 === v.page ? ` aria-current="page"` : ""}>${i + 1}</a>`).join("")}</nav>` : "";
  const sheet = `<section class="sheet" aria-label="Seals on this page">${grainLayer("multiply", 0.55)}<ul${v.on.length ? "" : ` class="none"`}>${v.on.map(s => spot(s, v)).join("")}${v.blank.map(blankSpot).join("")}</ul></section>`;
  const margin = v.room > 0 && v.on.length > 0 ? `<p class="hand">${esc(words(v.room))} spot${v.room === 1 ? "" : "s"} left on this page.</p>` : "";
  const aside = sel
    ? `<aside class="side" aria-labelledby="sel-h">${label(sel.id === v.newestId ? "THE NEWEST" : sel.date)}<h2 id="sel-h">${esc(sel.name)}.</h2>`
      + `<p class="story">${esc(sel.story)}</p><a class="in-thread" href="${esc(sel.href)}">See it in the thread</a>`
      + sharePanel(sel, { share, first, csrf }) + keptOutside(v.outside, tz) + margin + `</aside>`
    : `<aside class="side" aria-labelledby="sel-h">${label("THE FIRST ONE")}<h2 id="sel-h">Nothing here yet.</h2>`
      + `<p class="story">${esc(KEEP_LINE)}</p><a class="in-thread" href="/web?thread">Go to the thread</a>${keptOutside(v.outside, tz)}</aside>`;
  const body = GRAIN_DEF + dailyHeader("stamps")
    + `<main class="sb" id="content"><div class="sb-top"><div>${label(headLine(v))}<h1 class="sb-h1">Your book.</h1></div>${pager}</div>`
    + `<div class="sb-cols">${sheet}${aside}</div></main>`;
  return webPage({ title: "Reason — your book", body, css: CSS, script: SHARE_JS });
}

// The share panel's script: the name toggle rewrites the card's line (and its label) and the save link;
// Copy link asks for the link (POST, the session's secret in x-reason-csrf) and puts it on the clipboard;
// Send in iMessage shows on Apple devices only. Without script, Copy link is a form post that comes back
// with the link written out.
const SHARE_JS = `(function(){var f=document.querySelector('.sh-f');if(!f)return;var id=f.dataset.stamp,c=f.querySelector('[name=c]').value,cb=f.querySelector('[name=showName][type=checkbox]'),who=document.querySelector('.prev .cc-who'),card=document.querySelector('.prev .cc'),out=document.querySelector('[data-out]'),sms=f.querySelector('[data-sms]'),save=f.querySelector('[data-save]'),stop=document.querySelector('.stop-f'),url=(out.textContent.match(/https?:\\S+/)||[''])[0];
var apple=/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
function on(){return cb?cb.checked:false}
function draw(){var w=on()?who.dataset.with:who.dataset.without;who.textContent=w;card.setAttribute('aria-label','An engraved card, torn from a pad and folded once: with the compliments of Reason, '+w+'. Sealed with wax.');save.href='/web/api/stamps/'+id+'/image.png?name='+(on()?1:0);if(url){sms.href='sms:&body='+encodeURIComponent(sms.dataset.line+' '+url)}if(apple)sms.hidden=false}
function ask(){return fetch('/web/api/stamps/'+id+'/share',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json','x-reason-csrf':c},body:JSON.stringify({showName:on()})}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(j){url=j.url;out.textContent='Link: '+url;stop.hidden=false;draw();return url})}
if(cb)cb.addEventListener('change',function(){draw();if(url)ask().catch(function(){})});
f.addEventListener('submit',function(e){e.preventDefault();ask().then(function(u){var done=function(){out.textContent='Link copied: '+u};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(u).then(done,function(){out.textContent='Link: '+u});else out.textContent='Link: '+u}).catch(function(){out.textContent='That didn\\u2019t go through. Try again in a moment.'})});
sms.addEventListener('click',function(e){if(url)return;e.preventDefault();ask().then(function(){location.href=sms.href}).catch(function(){})});
draw()})();`;

// ---------------------------------------------------------------- the pictures (server-drawn)
/** Bump when a picture's drawing changes: it is part of every cached file's name. */
export const SEAL_CARD_VERSION = 1;
/** Every face the card uses, inline (a picture is drawn offline, from a string). */
export function sealFontCss() {
  const f = (family, name, style = "normal", weight = "400") =>
    `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${WEB_FONTS[name].toString("base64")}) format("woff2")}`;
  return f("Reason Serif", "serif", "italic") + f("Reason Serif", "roman") + f("Instrument Serif", "serif", "italic") + f("Instrument Serif", "roman")
    + f("Reason Sans", "sans", "normal", "400 600") + f("Inter", "sans", "normal", "400 600");
}
const frame = (w, h, inner, fontCss) => `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}body{margin:0;background:${BOTTLE}}</style></head><body>`
  + `${GRAIN_DEF}<div style="width:${w}px;height:${h}px;position:relative;overflow:hidden;background:${BOTTLE}">${grainLayer("soft-light", 0.6)}${inner}</div></body></html>`;

/** The 1200×630 card (og:image, Save image): exactly the preview in SHARE IT, at full size. */
export function sealCardHtml({ pub, first = "", fontCss = "" }) {
  const who = pub.whoWith(first);
  return frame(1200, 630, `<div style="position:absolute;inset:0;display:grid;place-items:center"><div style="width:876px">${complimentsCard({ wax: pub.wax, ring: pub.ring, who, when: pub.when, width: "100%" })}</div></div>`, fontCss);
}

/** The 9:16 story (1080×1920): bottle green, the sealed card, the line, HEYREASON.COM. */
export function sealStoryHtml({ pub, first = "", fontCss = "" }) {
  const who = pub.whoWith(first);
  const sans = `'Reason Serif','Instrument Serif',Georgia,serif`;
  return frame(1080, 1920, `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:120px;padding:0 90px;box-sizing:border-box">`
    + `<div style="width:900px">${complimentsCard({ wax: pub.wax, ring: pub.ring, who, when: pub.when, width: "100%" })}</div>`
    + `<p style="margin:0;font-family:${sans};font-style:italic;font-size:68px;line-height:1.15;color:#f2ebe0;text-align:center;max-width:860px">${esc(pub.story)}</p></div>`
    + `<p style="position:absolute;left:0;right:0;bottom:120px;margin:0;text-align:center;font-family:'Courier New',monospace;font-size:28px;letter-spacing:.14em;color:#f2ebe0">HEYREASON.COM</p>`, fontCss);
}

// ---------------------------------------------------------------- the public page
const PUBLIC_CSS = `
.pub-h{padding:22px clamp(20px,4vw,48px)}
.pub{flex:1 0 auto;width:100%;max-width:760px;margin:0 auto;padding:40px 24px 72px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:30px;box-sizing:border-box}
.pub .seal{margin:16px 0 4px}
.pub-l{margin:0;font:italic 400 clamp(30px,5vw,44px)/1.15 var(--serif);letter-spacing:-.01em;max-width:620px}
.pub .lbl{font-size:12px}
.pub .act{align-self:center}
@media (min-width:900px){.pub{padding-top:72px}}
`;

/** /s/<id>: the large seal, the line, the date, HEYREASON.COM, and the way to get a Reason. */
export function renderSealSharePage({ pub, shareId }) {
  const site = (config.siteUrl || "https://heyreason.com").replace(/\/+$/, "");
  const page = stamps.shareUrl(shareId);
  const image = `${page}/og.png?v=w${SEAL_CARD_VERSION}`;
  const title = `${pub.name} · with the compliments of Reason`;
  const tags = [
    `<meta name="description" content="${esc(pub.said)}">`,
    `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="${esc(pub.said)}">`,
    `<meta property="og:url" content="${esc(page)}">`, `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/png">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(`An engraved card: with the compliments of Reason, ${pub.who}. ${pub.when}.`)}">`,
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(pub.said)}">`, `<meta name="twitter:image" content="${esc(image)}">`,
  ].join("\n");
  const body = `<header class="pub-h">${wordmark({ href: site })}</header>`
    + `<main class="pub" id="content">${label("WITH THE COMPLIMENTS OF REASON")}`
    + `<div style="transform:rotate(${pub.rotation}deg)">${seal({ wax: pub.wax, ring: pub.ring, date: pub.postmarkDate, size: 240, label: pub.ariaLabel })}</div>`
    + `<p class="pub-l">${esc(pub.said)}</p>${label(pub.when)}`
    + action("Get your own Reason", { href: `${site}/?ref=s_${shareId}` })
    + `</main>`;
  return webPage({ title, body, css: PUBLIC_CSS, head: tags });
}
