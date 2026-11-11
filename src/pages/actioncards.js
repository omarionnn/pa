// The Action Cards page and its link card (src/actioncards.js owns the rows, the switch and the match).
//
//   GET  /a/<token>                 the note: open cards first, done ones sunk below, dismissed ones gone
//   POST /a/<token>/tap/<code>      the page says a card was tapped, just before it opens Messages
//   POST /a/<token>/dismiss/<code>  the card is struck out (no confirm; recorded here, remembered)
//   GET  /web/og/a/<token>.png      the link preview's picture, drawn for this digest's state
//
// The look is the approved mockup (~/Desktop/reason-action-cards-1111, 2026-11-11): a note left on a
// desk. Mono date eyebrow, Instrument Serif italic "Three things I can take off your plate.", the
// cards on dashed rules with "01 / 03 · REPLACE" eyebrows, a line drawing on the right, Caveat
// "~> tap one and I'll start", the wordmark. A tap opens Messages with the request typed in the
// person's own voice; press-and-hold lifts the card and shows the why-now as a margin note with
// Reply / Dismiss; dismiss draws a pen line through it and it fades out, the others renumber;
// done is a pen check and "done", and done cards sit below the open ones.
//
// Nothing is drawn without a good token (src/actioncards.js viewByToken): a bad or spent address gets
// the paper "gone" page, in the same frame as a spent sign-in link (src/pages/setupsignin.js).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import * as cards from "../actioncards.js";
import { zoneFor } from "../zone.js";
import { PAPER, PAPER_GRAIN, BRAND_PEN } from "./brand.js";
import { art } from "./actionart.js";
import { webPage, BUBBLE_PATH } from "./webkit.js";
import { PAPER_CSS, header, frame, headline, lede, label, para } from "./paperkit.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const INK = PAPER.ink, DIM = PAPER.dim, PEN = BRAND_PEN, BG = PAPER.bg, LIFT = PAPER.card, RULE = PAPER.line;

/** Bump when the page's or the picture's drawing changes: part of every cached picture's name. */
export const ACTION_CARDS_VERSION = 1;

export const OG_TITLE = "Ready for you";
export const OG_DESCRIPTION = "A few things Reason can take off your plate today.";

// ---------------------------------------------------------------- words

const COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six"];
/** "Three things I can take off your plate." for n cards (one: "One thing"). */
export function headline1(n) {
  if (n <= 0) return "Nothing left on this note.";
  return `${COUNT[n] ?? String(n)} ${n === 1 ? "thing" : "things"} I can take off your plate.`;
}
const two = (n) => String(n).padStart(2, "0");
/** "01 / 03 · REPLACE". */
export const eyebrowOf = (i, n, verb) => `<b>${two(i)}</b> / ${two(n)} · ${esc(verb)}`;
/** "TUESDAY · NOV 11", in the person's zone. */
export function dateEyebrow(ms, tz) {
  const f = (o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(new Date(ms));
  return `${f({ weekday: "long" })} · ${f({ month: "short" })} ${f({ day: "numeric" })}`.toUpperCase();
}
/** A title cut for the picture: whole words, an ellipsis, never past `max`. */
export function shorten(title, max = 56) {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

const BUBBLE = (px, col = PEN) => `<svg aria-hidden="true" width="${px}" height="${px}" viewBox="0 0 40 40" style="transform:skewX(-10deg);overflow:visible"><path d="${BUBBLE_PATH}" fill="none" stroke="${col}" stroke-width="3.2" stroke-linejoin="round"/></svg>`;
const WORDMARK = (px = 22) => `<span class="wm" role="img" aria-label="reason" style="font-size:${px}px">reas<span class="wmb">${BUBBLE(Math.round(px * 0.64))}</span>n</span>`;
const STRIKE = `<svg class="strike" viewBox="0 0 320 60" preserveAspectRatio="none" aria-hidden="true"><path d="M4 34 C 60 26, 120 40, 170 30 S 270 22, 316 32" fill="none" stroke="${PEN}" stroke-width="3.4" stroke-linecap="round"/><path d="M10 40 C 70 46, 140 30, 200 38 S 280 44, 312 36" fill="none" stroke="${PEN}" stroke-width="2.2" stroke-linecap="round" opacity=".7"/></svg>`;
const CHECK = `<svg class="check" viewBox="0 0 64 64" aria-hidden="true"><path d="M10 34 C 18 40, 24 48, 28 54 C 34 36, 44 22, 58 10" fill="none" stroke="${PEN}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------- the link card's tags

export const ogImagePath = (token) => `/web/og/a/${token}.png`;
export const ogImageUrl = (d) => `${cards.siteOrigin()}${ogImagePath(d.token)}?v=${ACTION_CARDS_VERSION}-${cards.stateVersion(d)}`;

/** The head lines: the action's words only, no og:url, so the token is never repeated in the card. */
export function actionCardTags(d) {
  const image = esc(ogImageUrl(d));
  const alt = `Ready for you. ${headline1(d.cards.filter(c => c.status !== "dismissed").length)}`;
  return [
    `<meta name="description" content="${esc(OG_DESCRIPTION)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(OG_TITLE)}">`,
    `<meta property="og:description" content="${esc(OG_DESCRIPTION)}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:secure_url" content="${image}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(alt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(OG_TITLE)}">`,
    `<meta name="twitter:description" content="${esc(OG_DESCRIPTION)}">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join("\n");
}

// ---------------------------------------------------------------- the page

const FONTS = `@font-face{font-family:"Reason Serif";font-style:italic;font-weight:400;font-display:swap;src:url(/web/fonts/serif.woff2) format("woff2")}
@font-face{font-family:"Reason Hand";font-weight:600;font-display:swap;src:url(/web/fonts/handbold.woff2) format("woff2")}
@font-face{font-family:"Reason Sans";font-weight:400 600;font-display:swap;src:url(/web/fonts/sans.woff2) format("woff2")}`;

const CSS = `${FONTS}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;color:${INK};font-family:"Reason Sans",Inter,-apple-system,system-ui,sans-serif;
  background:${PAPER_GRAIN},radial-gradient(520px 360px at 0% 0%, rgba(246,206,160,.42), transparent 65%),${BG};
  -webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
.note{padding:max(26px,env(safe-area-inset-top)) 26px 60px;max-width:600px;margin:0 auto}
@media (min-width:700px){.note{padding-top:64px}}
.eb{font-family:"Courier New",Courier,monospace;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:${DIM};margin:0}
.eb b{color:${PEN};font-weight:700}
h1{margin:12px 0 0;font-family:"Reason Serif",Georgia,serif;font-style:italic;font-weight:400;font-size:40px;line-height:1;letter-spacing:-.02em}
@media (min-width:700px){h1{font-size:56px}}
.rule{border-top:1.5px dashed ${RULE};margin:22px 0 0}
ol{list-style:none;margin:0;padding:0}
.card{position:relative;padding:18px 0 20px;border-bottom:1.5px dashed ${RULE};transition:opacity .45s ease,transform .45s ease,max-height .45s ease,padding .45s ease,margin .45s ease,background .2s ease;max-height:600px;overflow:visible;cursor:pointer;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
@media (min-width:700px){.card{padding:22px 0 24px}}
.card .eb{font-size:10.5px}
.card .body{display:flex;gap:14px;align-items:flex-start;margin-top:8px}
.card h2{margin:0;flex:1;font-family:"Reason Serif",Georgia,serif;font-style:italic;font-weight:400;font-size:25px;line-height:1.08;letter-spacing:-.015em}
@media (min-width:700px){.card h2{font-size:29px}}
.card .art{width:84px;height:66px;flex:none;overflow:visible;margin-top:-6px}
@media (min-width:700px){.card .art{width:100px;height:78px}}
.card .art path{stroke-width:7.5}
.more{display:none}
.card.lift .more{display:block}
.why{font-family:"Reason Hand",Caveat,cursive;font-weight:600;font-size:22px;line-height:1.1;color:${PEN};margin:12px 0 0;padding-left:10px;border-left:2px solid ${PEN}33}
.acts{margin-top:14px;display:flex;gap:22px;font-size:14px}
.acts a{color:${PEN};text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;cursor:pointer}
.acts a.dis{color:${DIM}}
.card.lift{background:${LIFT};margin:0 -14px;padding-left:14px;padding-right:14px;box-shadow:0 1px 0 ${RULE}, 0 10px 26px -14px rgba(42,37,32,.25)}
.strike{display:none;position:absolute;left:-6px;right:60px;top:40px;height:46px;width:auto;pointer-events:none}
.strike path{stroke-dasharray:340;stroke-dashoffset:340}
.card.struck{opacity:.5;transform:translateX(5px)}
.card.struck .strike{display:block}
.card.struck .strike path{animation:ac-pen .55s ease-out forwards}
.card.struck .strike path+path{animation-delay:.12s}
@keyframes ac-pen{to{stroke-dashoffset:0}}
.card.gone{opacity:0;max-height:0;padding-top:0;padding-bottom:0;border-bottom-width:0;overflow:hidden;transform:translateX(24px)}
.card.done{opacity:.72;cursor:default}
.card.done .check{position:absolute;right:-6px;top:10px;width:46px;height:46px}
.card.done h2{color:${DIM}}
.card.done .donew{font-family:"Reason Hand",Caveat,cursive;font-weight:600;font-size:22px;color:${PEN};position:absolute;right:46px;top:16px;transform:rotate(-6deg)}
.sign{margin-top:26px}
.sign .hand{font-family:"Reason Hand",Caveat,cursive;font-weight:600;font-size:25px;color:${PEN};line-height:1.05}
.sign .by{margin-top:10px;display:flex;align-items:center;gap:8px;color:${DIM};font-size:13px}
.wm{font-family:"Reason Serif",Georgia,serif;font-style:italic;letter-spacing:-.01em;color:${INK};display:inline-flex;align-items:baseline}
.wmb{display:inline-flex;align-items:center;margin:0 -1px}
.wmb svg{vertical-align:-2px}
@media (prefers-reduced-motion:reduce){.card,.card.struck .strike path{transition:none;animation-duration:.01s}}`;

// The page's own script: tap → Messages; press-and-hold → the margin note; Dismiss → pen line, fade,
// renumber. Posts ride keepalive so a tap that leaves the page is still counted.
const JS = `(function(){
var B=document.body,T=B.getAttribute('data-token'),L=document.getElementById('cards');
var apple=/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
if(!apple){[].forEach.call(document.querySelectorAll('a[data-sms]'),function(a){a.setAttribute('href',a.getAttribute('href').replace('&body=','?body='))})}
function post(p){try{fetch('/a/'+T+'/'+p,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:'{}'})}catch(e){}}
var W=['No','One','Two','Three','Four','Five','Six'];
function renumber(){var cs=[].filter.call(L.querySelectorAll('.card'),function(c){return !c.classList.contains('gone')});var n=cs.length,open=0;
 cs.forEach(function(c,i){var eb=c.querySelector('.eb');var a=String(i+1),b=String(n);eb.innerHTML='<b>'+(a.length<2?'0'+a:a)+'</b> / '+(b.length<2?'0'+b:b)+' \\u00b7 '+c.getAttribute('data-verb');if(!c.classList.contains('done'))open++});
 document.getElementById('h1').textContent=n<=0?'Nothing left on this note.':(W[n]||n)+' '+(n===1?'thing':'things')+' I can take off your plate.';
 var oc=document.getElementById('openct');oc.innerHTML=(n>0&&open<n)?' \\u00b7 <b>'+open+' OPEN</b>':'';
 var s=document.getElementById('sign');if(s)s.style.visibility=open?'':'hidden'}
function lift(c){[].forEach.call(L.querySelectorAll('.card.lift'),function(o){if(o!==c)o.classList.remove('lift')});c.classList.add('lift')}
function tap(c){var a=c.querySelector('a[data-sms]');if(!a)return;post('tap/'+c.getAttribute('data-code'));location.href=a.getAttribute('href')}
function strike(c){c.classList.remove('lift');c.classList.add('struck');post('dismiss/'+c.getAttribute('data-code'));
 setTimeout(function(){c.classList.add('gone');setTimeout(function(){if(c.parentNode)c.parentNode.removeChild(c);renumber()},460)},720)}
var hold=null,held=false,sx=0,sy=0;
L.addEventListener('pointerdown',function(e){var c=e.target.closest('.card');if(!c||c.classList.contains('done')||e.target.closest('.acts'))return;held=false;sx=e.clientX;sy=e.clientY;
 hold=setTimeout(function(){held=true;lift(c);if(navigator.vibrate)navigator.vibrate(8)},420)});
function drop(){if(hold){clearTimeout(hold);hold=null}}
L.addEventListener('pointermove',function(e){if(hold&&(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10))drop()});
L.addEventListener('pointerup',drop);L.addEventListener('pointercancel',drop);window.addEventListener('scroll',drop,{passive:true});
L.addEventListener('contextmenu',function(e){var c=e.target.closest('.card');if(c&&!c.classList.contains('done')){e.preventDefault();held=true;lift(c)}});
L.addEventListener('click',function(e){var c=e.target.closest('.card');if(!c)return;var a=e.target.closest('a');
 if(a&&a.classList.contains('dis')){e.preventDefault();strike(c);return}
 if(a&&a.hasAttribute('data-sms')){post('tap/'+c.getAttribute('data-code'));return}
 if(c.classList.contains('done'))return;
 if(held){held=false;return}
 e.preventDefault();tap(c)});
L.addEventListener('keydown',function(e){var c=e.target.closest('.card');if(!c)return;if(e.key==='Enter'&&e.target===c)tap(c);if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();strike(c)}});
})();`;

function cardLi(c, i, n, sms) {
  const done = c.status === "done";
  const href = sms(c.prefill);
  return `<li class="card${done ? " done" : ""}" data-code="${esc(c.code)}" data-verb="${esc(c.verb)}" tabindex="0" aria-label="${esc(c.title)}${done ? " (done)" : ""}">
<p class="eb">${eyebrowOf(i, n, c.verb)}</p>
<div class="body"><h2>${esc(c.title)}</h2>${art(c.drawing, c.position)}</div>
${done ? `${CHECK}<span class="donew">done</span>` : `<div class="more">${c.whyNow ? `<p class="why">~&gt; ${esc(c.whyNow)}</p>` : ""}<div class="acts">${href ? `<a href="${esc(href)}" data-sms>Reply</a>` : ""}<a href="#" class="dis" role="button">Dismiss</a></div></div>${STRIKE}`}
</li>`;
}

/** The note for one digest: open cards first, then done ones; dismissed ones are not on it. */
export function actionCardsPage(d, { now = Date.now(), tz = null } = {}) {
  const live = d.cards.filter(c => c.status !== "dismissed");
  const ordered = [...live.filter(c => c.status === "open"), ...live.filter(c => c.status === "done")];
  const n = ordered.length, open = ordered.filter(c => c.status === "open").length;
  const sms = (body) => cards.smsHref(body);
  const zone = tz || zoneFor(d.conversationId);
  const body = `<main class="note" id="main">
<p class="eb">${dateEyebrow(now, zone)}<span id="openct">${n > 0 && open < n ? ` · <b>${open} OPEN</b>` : ""}</span></p>
<h1 id="h1">${esc(headline1(n))}</h1>
<div class="rule"></div>
<ol id="cards">${ordered.map((c, i) => cardLi(c, i + 1, n, sms)).join("\n")}</ol>
<div class="sign" id="sign"${open ? "" : ` style="visibility:hidden"`}><p class="hand">~&gt; tap one and I'll start</p><p class="by">${WORDMARK(22)}</p></div>
</main>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="${BG}">
${actionCardTags(d)}
<title>Ready for you · Reason</title>
<style>${CSS}</style>
</head><body data-token="${esc(d.token)}">${body}<script>${JS}</script></body></html>`;
}

/** A link that is not good any more: unknown, run out, or every card on it handled. */
export function actionCardsGonePage() {
  const main = headline("This note is no longer good.", "Nothing was lost.")
    + lede("A day's note lasts a week, or until everything on it is handled. Reason will leave the next one in your thread.");
  const side = label("WHAT WAS ON IT") + para("Is still yours to ask for. Just text Reason.");
  return webPage({ title: "Reason — a note", body: `${header({ right: "" })}<main class="pf" id="ss-main">${frame({ main, margin: side })}</main>`, css: PAPER_CSS,
    head: `<meta property="og:site_name" content="Reason">\n<meta property="og:title" content="${esc(OG_TITLE)}">\n<meta property="og:description" content="${esc(OG_DESCRIPTION)}">` });
}

// ---------------------------------------------------------------- the picture (1200×630)

let fontCss = null;
const font = (f) => `data:font/woff2;base64,${readFileSync(new URL(`../../assets/fonts/${f}`, import.meta.url)).toString("base64")}`;
function ogFontCss() {
  fontCss ??= `@font-face{font-family:IS;font-style:italic;src:url("${font("instrument-serif-italic-web.woff2")}") format("woff2")}
@font-face{font-family:Caveat;font-weight:600;src:url("${font("caveat-600-web.woff2")}") format("woff2")}
@font-face{font-family:Inter;src:url("${font("inter-web.woff2")}") format("woff2")}`;
  return fontCss;
}

/** The preview: the eyebrow and headline on the left, the open cards (≤4, titles shortened) stacked on the right. */
export function actionCardsOgHtml(d, { now = Date.now(), tz = null } = {}) {
  const live = d.cards.filter(c => c.status !== "dismissed");
  const show = [...live.filter(c => c.status === "open"), ...live.filter(c => c.status === "done")].slice(0, 4);
  const n = live.length, open = live.filter(c => c.status === "open").length;
  const four = show.length >= 4, three = show.length === 3;
  const zone = tz || zoneFor(d.conversationId);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${ogFontCss()}
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{background:${BG};color:${INK};font-family:Inter,sans-serif}
.og{width:1200px;height:630px;position:relative;overflow:hidden;padding:64px 72px;display:flex;gap:56px;
  background:${PAPER_GRAIN},radial-gradient(900px 600px at 0% 0%, rgba(246,206,160,.45), transparent 65%), radial-gradient(800px 600px at 100% 100%, rgba(156,59,46,.10), transparent 60%), ${BG}}
.l{flex:1;display:flex;flex-direction:column;min-width:0}
.eb{font-family:"Courier New",monospace;font-size:22px;letter-spacing:.16em;text-transform:uppercase;color:${DIM}}
.eb b{color:${PEN};font-weight:700}
h1{font-family:IS,Georgia,serif;font-style:italic;font-weight:400;font-size:${n === 1 ? 84 : 92}px;line-height:.98;letter-spacing:-.02em;margin:26px 0 0;max-width:560px}
.foot{margin-top:auto;display:flex;align-items:center;gap:14px}
.hand{font-family:Caveat,cursive;font-weight:600;font-size:38px;color:${PEN}}
.stack{width:470px;display:flex;flex-direction:column;gap:${four ? 10 : 14}px;padding-top:6px}
.mini{background:${LIFT};border:1px solid ${RULE};border-radius:4px;padding:${four ? "12px 18px 14px" : three ? "18px 22px 20px" : "24px 24px 26px"};display:flex;gap:16px;align-items:flex-start;box-shadow:0 2px 0 ${RULE};position:relative}
.mini.done{opacity:.6}
.mini .eb{font-size:${four ? 12 : 14}px;letter-spacing:.14em}
.mini h2{margin:6px 0 0;font-family:IS,Georgia,serif;font-style:italic;font-weight:400;font-size:${four ? 22 : three ? 28 : 32}px;line-height:1.05;letter-spacing:-.015em}
.mini .art{width:${four ? 74 : 96}px;height:${four ? 58 : 76}px;flex:none;overflow:visible}
.mini .art path{stroke-width:7.5}
.mini .check{position:absolute;right:10px;top:6px;width:36px;height:36px}
.bm{position:absolute;right:56px;bottom:46px}
</style></head><body><div class="og">
<div class="l"><div class="eb">${dateEyebrow(now, zone)}${n > 0 && open < n ? ` · <b>${open} OPEN</b>` : ""}</div><h1>${esc(headline1(n))}</h1>
<div class="foot"><div class="hand">~&gt; tap one and I'll start</div></div></div>
<div class="stack">${show.map((c, i) => `<div class="mini${c.status === "done" ? " done" : ""}"><div style="flex:1;min-width:0"><div class="eb"><b>${two(i + 1)}</b> / ${two(n)} · ${esc(c.verb)}</div><h2>${esc(shorten(c.title, four ? 48 : 56))}</h2></div>${art(c.drawing, c.position + 10)}${c.status === "done" ? CHECK : ""}</div>`).join("")}</div>
<div class="bm">${BUBBLE(72)}</div>
</div></body></html>`;
}

let shooter = null;
/** Tests hand in their own drawing; the server draws with card.js's headless Chromium. */
export function setActionCardShooter(fn) { shooter = fn; }
async function shoot(html) {
  if (shooter) return await shooter(html);
  const { shootWithChromium } = await import("./card.js");
  return await shootWithChromium(html);
}
let drawing = Promise.resolve();
let failedAt = 0;
const genericOg = () => readFileSync(new URL("../../assets/og.png", import.meta.url));

/** The picture for a digest's current state, drawn once and kept under data/cards; the generic card when it cannot be drawn. */
export async function actionCardsPng(d, { now = Date.now() } = {}) {
  const key = createHash("sha256").update(`${ACTION_CARDS_VERSION}\n${d.id}\n${cards.stateVersion(d)}`).digest("hex").slice(0, 20);
  const dir = join(config.dataDir, "cards");
  const file = join(dir, `action-${key}.png`);
  if (existsSync(file)) return { bytes: readFileSync(file), fresh: false };
  if (!shooter && Date.now() - failedAt < 60_000) return { bytes: genericOg(), fresh: false, fallback: true };
  const run = drawing.then(async () => {
    if (existsSync(file)) return { bytes: readFileSync(file), fresh: false };
    const png = await shoot(actionCardsOgHtml(d, { now }));
    if (!png?.length) { failedAt = Date.now(); return { bytes: genericOg(), fresh: false, fallback: true }; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, png);
    return { bytes: png, fresh: true };
  }).catch(() => { failedAt = Date.now(); return { bytes: genericOg(), fresh: false, fallback: true }; });
  drawing = run.then(() => {}, () => {});
  return await run;
}

// ---------------------------------------------------------------- the routes

const HTML = (status, body, extra = {}) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra }, body });
const JSON_ = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) }, body }; };
const gone = (status = 404) => HTML(status, actionCardsGonePage());

export const PATH = "/a";
export const PREVIEW_BOT = /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|Applebot|Googlebot|bingbot|preview/i;
const ROUTE =/^\/a\/([A-Za-z0-9_-]{1,64})(?:\/(tap|dismiss)\/([a-z0-9]{1,16}))?\/?$/;

/**
 * Every request under /a. Off: the plain 404 any unknown address gets, so the feature's existence
 * shows nothing. On: a bad or spent token → the gone page; a good one → the note, or its posts.
 */
export async function actionCardsRequest({ method = "GET", path = "", headers = {}, now = Date.now(), log = () => {} } = {}) {
  if (cards.mode() === "off") return JSON_(404, { error: "not found" });
  const m = ROUTE.exec(String(path));
  if (!m) return method === "GET" || method === "HEAD" ? gone(404) : JSON_(404, { error: "not found" });
  const [, token, action = "", code = ""] = m;
  const d = cards.viewByToken(token, { now });
  if (!d) return action ? JSON_(404, { error: "not found" }) : gone(404);
  if (d.gone) return action ? JSON_(410, { error: "gone" }) : gone(410);
  if (!action) {
    if (method !== "GET" && method !== "HEAD") return JSON_(405, { error: "method not allowed" });
    // A view is a person opening the note: not a HEAD, and not the link-preview fetch iMessage makes
    // as the text is sent (Apple's LinkPresentation announces itself as facebookexternalhit).
    if (method === "GET" && !PREVIEW_BOT.test(String(headers["user-agent"] ?? ""))) { cards.viewed(d, now); log({ action_cards_view: d.id }); }
    return HTML(200, actionCardsPage(d, { now }));
  }
  if (method !== "POST") return JSON_(405, { error: "method not allowed" });
  if (action === "tap") {
    const ok = cards.tapped(d.id, code, now);
    if (ok) log({ action_cards_tap: d.id });
    return ok ? JSON_(200, { ok: true }) : JSON_(404, { error: "no such card" });
  }
  const out = cards.dismiss(d.id, code, { now });
  if (!out) return JSON_(404, { error: "no such card" });
  const after = cards.digestById(d.id, { now });
  log({ action_cards_dismiss: d.id, open: after.cards.filter(c => c.status === "open").length });
  return JSON_(200, { ok: true, status: out.status, open: after.cards.filter(c => c.status === "open").length, gone: after.gone });
}

const OG_ROUTE = /^\/web\/og\/a\/([A-Za-z0-9_-]{1,64})\.png$/;
/**
 * GET /web/og/a/<token>.png: the picture for this digest's state, or null when the address is not one of
 * ours. A spent digest keeps answering with the generic card, so an old thread's preview never breaks.
 */
export async function actionCardsOgRequest(pathname, { now = Date.now(), log = () => {} } = {}) {
  if (cards.mode() === "off") return null;
  const m = OG_ROUTE.exec(String(pathname));
  if (!m) return null;
  const d = cards.viewByToken(m[1], { now });
  if (!d) return null;
  const png = d.gone ? { bytes: genericOg(), fallback: true } : await actionCardsPng(d, { now });
  if (png.fallback) log({ action_cards_og_fallback: d.id, gone: d.gone });
  return { status: 200, headers: { "Content-Type": "image/png", "Content-Length": png.bytes.length, "Cache-Control": d.gone ? "public, max-age=86400" : "public, max-age=3600", "X-Content-Type-Options": "nosniff" }, body: png.bytes };
}
