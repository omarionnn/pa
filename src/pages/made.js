// Pages Reason makes, v2 (handoff 2026-10-27 §4 "Pages Reason makes", reference sheet-pages-{paper,
// night}.html P1–P6 and sheet-pages-desk-{paper,night}.html PD1–PD6), the edge screens E2–E4
// (sheet-edge) and the two link previews (preview-private, preview-event).
//
// HELD (owner's call, SCOPE-v2 Q-v2-3): every page here is one every user sees, so nothing reaches
// them until REASON_PAGES_V2 is set. With it unset the routes keep drawing the pages they drew before.
//
// What this file is: view models in, HTML out. It reads no database and decides nothing about who
// may see what; src/pages/madedata.js builds the view models from real rows, and the routes
// (src/http.js, src/pages/event.js, src/pages/album.js) decide access exactly as before. Every string
// is escaped on the way through, as in render.js.
//
// One document serves the phone and the desk. Under 900px it is the phone sheet (P1–P6): one column,
// 24px in. From 900px it is the desk sheet (PD1–PD6): the same frame, then content on the left and a
// 210px margin on the right behind a dashed rule, where Reason's handwritten notes and the quiet
// actions go. Where the two sheets put the same thing in different places, it is drawn twice and
// one copy is display:none (which also takes it out of the accessibility tree), never moved by script.
import { TOKENS, WEB_FONTS } from "./webkit.js";
import { THEME, iconLinks } from "./render.js";
import { WORDMARK_O as WM_O, homeLink } from "./wordmark.js";
import { PRINT_CSS, printUrl } from "./print.js";

export const PRIVATE_FOOT = "Only you can see this page. Reply to Reason to change anything.";
export const PUBLIC_FOOT = "Anyone with this link can see it. Made with Reason.";

export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------- tokens + type
const P = TOKENS.paper;
const N = TOKENS.night;
const vars = (t) => `--g:${t.ground};--deep:${t.deep};--lift:${t.lifted};--ink:${t.ink};--mut:${t.muted};--hair:${t.hair};--pen:${t.pen};--photo:${t.photo};--sh:${t.shadow};--shb:${t.shadowBig};--shp:${t.shadowPhoto}`;

const FONT_PATH = "/fonts";
const face = (family, file, { style = "normal", weight = "400" } = {}) =>
  `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url(${FONT_PATH}/${file}.woff2) format("woff2")}`;
const FONTS = face("Reason Serif", "serif", { style: "italic" }) + face("Reason Serif", "roman")
  + face("Reason Hand", "hand") + face("Reason Hand", "handbold", { weight: "600" })
  + face("Reason Sans", "sans", { weight: "400 600" });
// Single quotes: these also go into style="" attributes on the link-preview cards.
const SERIF = `'Reason Serif','Instrument Serif',Georgia,serif`;
const MONO = `'Courier New',Courier,monospace`;
const HAND = `'Reason Hand',Caveat,cursive`;
const SANS = `'Reason Sans',Inter,system-ui,sans-serif`;

export const MADE_CSS = `${FONTS}
:root{${vars(P)};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(N)};color-scheme:dark}}
:root[data-theme=dark]{${vars(N)};color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--g);color:var(--ink);font:16px/normal ${SANS};-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
a{color:var(--ink)}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.mp{min-height:100dvh;padding:24px;display:flex;flex-direction:column;gap:28px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.wm{font-family:${SERIF};font-style:italic;font-size:20px;display:inline-flex;white-space:nowrap;flex:none;align-items:center;text-decoration:none;color:var(--ink)}
.wm svg{width:12px;height:12px;transform:skewX(-10deg);margin:3px 1px 0}
.wm-home{display:inline-flex;align-items:center;min-height:44px;color:inherit;text-decoration:none;border-radius:4px}
.wm-home:focus-visible{outline:2px solid var(--pen);outline-offset:3px}
.kick{font-family:${MONO};font-size:10px;letter-spacing:.14em;color:var(--mut);text-align:right}
.cols{display:flex;flex-direction:column;gap:28px;flex:1}
.main{display:flex;flex-direction:column;gap:28px;min-width:0}
.side{display:flex;flex-direction:column;gap:22px}
.side:empty{display:none}
.tg{display:flex;flex-direction:column;gap:8px}
h1{margin:0;font-family:${SERIF};font-style:italic;font-weight:400;font-size:40px;line-height:1.05;letter-spacing:-.02em}
h1.big{font-size:44px}
h1 em{font-style:italic}
.meta{margin:0;font-family:${MONO};font-size:11px;letter-spacing:.12em;color:var(--mut)}
.lbl{margin:0;font-family:${MONO};font-weight:400;font-size:11px;letter-spacing:.14em;color:var(--mut)}
.hand{margin:0;font-family:${HAND};font-size:22px;line-height:1.2;color:var(--pen)}
.tilt{transform:rotate(-1deg)}
.quiet{margin:0;font-size:14px;line-height:1.5;color:var(--mut)}
.go{align-self:flex-start;min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font-family:${SERIF};font-style:italic;font-size:22px;color:var(--ink);background:none;border:0;padding:0;cursor:pointer}
.typed{align-self:flex-start;text-align:left;min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font-family:${MONO};font-size:11px;letter-spacing:.14em;color:var(--ink);background:none;border:0;padding:0;cursor:pointer}
.typed.mut{color:var(--mut)}
.acts{display:flex;gap:28px;align-items:baseline;flex-wrap:wrap}
.dash{padding-top:18px;border-top:1px dashed var(--hair)}
.foot{margin:auto 0 0;font-size:13px;line-height:1.5;color:var(--mut);padding-top:16px;border-top:1px dashed var(--hair)}
.stamp{flex-shrink:0;font-family:${MONO};font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--pen);border:1.5px solid var(--pen);border-radius:3px;padding:2px 5px;white-space:nowrap}
.ld{margin:0;display:flex;flex-direction:column;gap:8px;font-family:${MONO};font-size:12px;letter-spacing:.04em}
.ld>div{display:flex;gap:8px;align-items:baseline}
.ld dt{color:var(--mut)}
.ld .dots{flex-grow:1;border-bottom:1px dotted var(--hair)}
.ld dd{margin:0;text-align:right}
.photo{display:block;width:100%;height:150px;object-fit:cover;background:var(--photo);border:6px solid var(--lift);box-shadow:2px 3px 0 var(--shp)}
.num{font-family:${MONO};font-size:13px;color:var(--pen)}
@media (max-width:899px){.d{display:none!important}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
form.inline{margin:0;display:inline}
/* P1 shortlist */
.opt{display:flex;flex-direction:column;gap:12px}
.opt h2{margin:0;font-family:${SERIF};font-style:italic;font-weight:400;font-size:28px}
.opt .nh{display:flex;align-items:baseline;gap:10px}
.opt .photo{transform:rotate(-1deg)}
.alt{display:flex;flex-direction:column;gap:8px}
.alt .row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.alt .nm{display:flex;align-items:baseline;gap:10px;font-family:${SERIF};font-style:italic;font-size:24px}
.alt .at{font-family:${MONO};font-size:12px}
.sent{font-family:${MONO};font-size:11px;letter-spacing:.14em;color:var(--pen)}
/* P2 the day */
.day{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.day li{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:10px;padding:16px 0;border-top:1px dashed var(--hair);align-items:baseline}
.day li:last-child{border-bottom:1px dashed var(--hair)}
.day .tm{font-family:${MONO};font-size:11px;font-weight:600;color:var(--pen)}
.day .wh{display:flex;flex-direction:column;gap:2px}
.day .wt{font-size:16px;font-weight:600}
.day .wd{font-size:13px;color:var(--mut)}
.day a.wd{color:var(--ink);text-decoration:none}
/* P3 call */
.callh{position:relative;display:flex;flex-direction:column;gap:8px}
.callh .stamp{position:absolute;right:0;top:-6px;font-size:11px;letter-spacing:.12em;padding:3px 8px;transform:rotate(-6deg)}
.player{min-height:56px;border:0;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);background:transparent;padding:8px 0;display:flex;align-items:center;gap:14px;cursor:pointer;color:var(--ink);text-decoration:none;font:inherit;width:100%}
.player .wave{flex:1;height:24px}
.player .dur{font-family:${MONO};font-size:12px}
.player svg{fill:var(--ink);stroke:var(--ink)}
.pts{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;font-size:15px;line-height:1.5}
.pts li{display:grid;grid-template-columns:28px minmax(0,1fr)}
.pts .num{font-size:12px}
.sec{display:flex;flex-direction:column;gap:10px}
details.tx summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-family:${MONO};font-size:11px;letter-spacing:.14em;list-style:none}
details.tx summary::-webkit-details-marker{display:none}
details.tx .lines{display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.55}
details.tx .lines p{margin:0}
details.tx .who{font-family:${MONO};font-size:11px;letter-spacing:.12em;color:var(--mut);margin-right:6px}
/* P4 event */
.evh{display:flex;gap:18px;align-items:stretch}
.date{width:92px;flex-shrink:0;background:var(--lift);border:1px solid var(--hair);box-shadow:2px 3px 0 var(--sh);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:12px 0;transform:rotate(-2deg)}
.date .mo{font-family:${MONO};font-size:12px;letter-spacing:.14em;color:var(--pen)}
.date .dn{font-family:${SERIF};font-style:italic;font-size:48px;line-height:1}
.date .to{font-family:${MONO};font-size:10px;letter-spacing:.1em;color:var(--mut)}
.evt{display:flex;flex-direction:column;justify-content:center;gap:6px}
.evt h1{font-size:34px}
.evt .host{margin:0;font-size:14px;color:var(--mut)}
.evd{display:flex;flex-direction:column;gap:28px}
.evd .ld{gap:10px}
.rsvp{display:flex;flex-direction:column;gap:14px}
.rsvp .row{display:flex;gap:32px;align-items:baseline;flex-wrap:wrap}
.rsvp .go{font-size:28px;min-height:48px}
.coming{margin:0;font-size:14px;line-height:1.5}
.coming .lbl{display:inline;font-size:11px;letter-spacing:.12em}
details.join>summary{list-style:none;cursor:pointer}
details.join>summary::-webkit-details-marker{display:none}
.jf{display:flex;flex-direction:column;gap:14px;margin-top:6px}
.jf label{display:flex;flex-direction:column;gap:6px;font-family:${MONO};font-size:11px;letter-spacing:.14em;color:var(--mut)}
.jf input[type=text],.jf input[type=password]{min-height:44px;border:0;border-bottom:2px solid var(--ink);background:transparent;color:var(--ink);font:16px ${SANS};padding:6px 0;caret-color:var(--pen);border-radius:0}
.jf input:focus{outline:none;border-bottom-color:var(--pen)}
.jf .check{flex-direction:row;align-items:flex-start;gap:10px;font-family:${SANS};font-size:14px;letter-spacing:0;color:var(--ink);min-height:44px}
.jf .check input{width:20px;height:20px;margin:2px 0 0;accent-color:var(--ink)}
.err{margin:0;font-family:${HAND};font-size:22px;color:var(--pen)}
.qs{display:flex;flex-direction:column;gap:14px;padding-top:4px}
.qs .qh{margin:6px 0 -4px}
.jf .qq{display:flex;flex-direction:column;gap:6px;border:0;margin:0;padding:0;min-width:0}
.jf .qq legend,.jf .qq .qp{padding:0;margin:0 0 2px;font-family:${SANS};font-size:15px;line-height:1.4;letter-spacing:0;color:var(--ink)}
.jf .qq .pick{min-height:40px;align-items:center}
.jf .qq .pick input{margin:0}
/* P5 album */
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 14px}
.grid figure{margin:0;display:flex;flex-direction:column;gap:6px}
.grid figcaption{font-family:${HAND};font-size:18px;color:var(--pen)}
.grid a{display:block}
.grid .photo{height:var(--h,150px);border-width:6px}
.grid .rm{align-self:flex-start;min-height:44px;font-size:10px}
@media (max-width:899px){.grid .m2{padding-top:24px}}
/* P6 receipt */
.rcpt{position:relative;background:var(--lift);border:1px solid var(--hair);box-shadow:3px 4px 0 var(--shb);padding:26px 22px 30px}
.rcpt .ld{gap:14px;font-size:13px}
.rcpt .tot{padding-top:12px;border-top:1px dashed var(--hair)}
.rcpt .tot dt{color:var(--ink);font-weight:700}
.rcpt .tot dd{font-weight:700;font-size:16px}
.rcpt .tot .dots{border:0}
.paid{position:absolute;right:18px;bottom:-16px;background:var(--g);font-family:${MONO};font-size:13px;font-weight:700;letter-spacing:.14em;color:var(--pen);border:2px solid var(--pen);border-radius:3px;padding:5px 12px;transform:rotate(-6deg)}
@media (min-width:900px){
  .m{display:none!important}
  .mp{max-width:960px;margin:0 auto;padding:28px 48px 26px;gap:0}
  .top{padding-bottom:28px}
  .wm{font-size:22px}
  .wm svg{width:13px;height:13px}
  .kick{font-size:11px}
  .cols{display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:56px;margin-bottom:28px}
  .main{gap:26px}
  .side{padding-top:6px;border-left:1px dashed var(--hair);padding-left:28px}
  .side:empty{display:flex}
  .side .hand{font-size:24px}
  .side .quiet{font-size:14px;line-height:1.55}
  .side .typed{font-size:11.5px}
  .side .tight{font-size:10px;letter-spacing:.14em;color:var(--mut);font-family:${MONO}}
  h1{font-size:48px;line-height:1.06}
  h1.big,h1.dbig{font-size:52px}
  .meta{letter-spacing:.14em}
  .foot{margin:0}
  /* PD1 */
  .opts3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}
  .opts3 .o{display:flex;flex-direction:column;gap:12px}
  .opts3 .o.dim{opacity:.75}
  .opts3 .photo{height:130px;transform:rotate(-1deg)}
  .opts3 .o.dim .photo{transform:rotate(1deg)}
  .opts3 .nh{display:flex;align-items:baseline;gap:8px}
  .opts3 .nh .num{font-size:12px}
  .opts3 .nh span+span{font-family:${SERIF};font-style:italic;font-size:26px}
  .opts3 .ld{gap:10px;font-size:11.5px}
  .opts3 .go{font-size:20px}
  /* PD2 */
  .day li{grid-template-columns:64px minmax(0,1fr) auto;gap:14px;padding:18px 0}
  .day li:last-child{border-bottom:0}
  .day .tm{font-size:12px}
  .day .wh{gap:3px}
  .day .wt{font-size:17px}
  .day .wd,.day a.wd{font-size:14px;color:var(--mut)}
  .stamp{letter-spacing:.12em;padding:2px 6px}
  .side .big{font-size:30px}
  .side .tmrw{margin:0;font-size:15px;line-height:1.55}
  /* PD3 */
  .callh{flex-direction:row;align-items:center;gap:18px}
  .callh .stamp{position:static;font-size:9.5px;padding:2px 6px}
  .player{gap:16px}
  .pts{gap:12px;font-size:16px;line-height:1.55}
  .pts li{grid-template-columns:32px minmax(0,1fr)}
  .pts .num{padding-top:3px}
  .side .hand.mid{font-size:23px}
  /* PD4 */
  .evh{gap:32px;align-items:center}
  .date{width:130px;padding:16px 0}
  .date .mo{font-size:13px}
  .date .dn{font-size:66px}
  .date .to{font-size:11px;letter-spacing:0}
  .evt h1{font-size:48px;line-height:1.06}
  .evt .host{font-size:16px}
  .evd{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px;align-items:start}
  .evd .ld{font-size:12.5px}
  .rsvp .row{gap:36px;padding-top:6px}
  .rsvp .go{font-size:32px}
  .rsvp .cal{margin-left:auto}
  .side .names{margin:0;font-size:16px;line-height:1.6}
  /* PD5 */
  .grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:22px 18px;align-items:start}
  /* PD6 */
  .rcpt{max-width:460px;padding:30px 28px 34px}
  .rcpt .ld{gap:10px;font-size:13.5px}
  .rcpt .tot{padding-top:14px;margin-top:4px}
  .rcpt .tot dd,.rcpt .tot dt{font-size:17px}
  .paid{right:-18px;bottom:-18px;font-size:16px;padding:6px 14px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// ---------------------------------------------------------------- small parts
const BUBBLE = "M20 5C28.8 5 36 10.9 36 18.2S28.8 31.4 20 31.4c-1.9 0-3.7-.3-5.4-.8L7 35l2.3-6.6C6.3 26.1 4 22.4 4 18.2 4 10.9 11.2 5 20 5z";
export const wordmark = () =>
  `<span class="wm" role="img" aria-label="reason">reas<svg aria-hidden="true" viewBox="0 0 40 40"><path d="${BUBBLE}" fill="none" stroke="var(--pen)" stroke-width="5" stroke-linejoin="round"/></svg>${WM_O}n</span>`;

/** Typed facts with dotted leaders. `rows` is [[label, value], …]; empty values are left out. */
export function leaders(rows, cls = "") {
  const kept = (rows ?? []).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "");
  if (!kept.length) return "";
  return `<dl class="ld${cls ? ` ${cls}` : ""}">${kept.map(([k, v]) =>
    `<div><dt>${esc(String(k).toUpperCase())}</dt><span class="dots" aria-hidden="true"></span><dd>${esc(String(v).toUpperCase())}</dd></div>`).join("")}</dl>`;
}

const TILTS = [-3, 2, -2, 3];
const stampTag = (word, i = 0, cls = "stamp") =>
  word ? `<span class="${cls}" style="transform:rotate(${TILTS[i % TILTS.length]}deg)">${esc(String(word).toUpperCase())}</span>` : "";

/**
 * A headline that turns once (§4: "serif italic that turns once"). On the phone a long title breaks
 * at its last comma; on the desk it stays one line. Short ones ("Con Ed, paid.") never break.
 */
export function turned(title) {
  const t = String(title ?? "").trim();
  const at = t.lastIndexOf(", ");
  if (t.length <= 20 || at < 1) return esc(t);
  return `${esc(t.slice(0, at + 1))}<br class="m"> <em>${esc(t.slice(at + 2))}</em>`;
}

// ---------------------------------------------------------------- the frame
/**
 * The shared frame: wordmark + typed line, then content and margin, then the line saying who can
 * see it. `head` is extra <head> markup (the link preview tags); `script` is the page's own few lines.
 */
export function madeDoc({ title, kicker = "", main, side = "", foot = PRIVATE_FOOT, head = "", script = "", lang = "en", robots = true, url = "", home = "" }) {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
    + `<meta name="referrer" content="no-referrer">`
    + (robots ? `<meta name="robots" content="noindex,nofollow">` : "")
    + `<meta name="color-scheme" content="light dark">`
    + `<meta name="theme-color" content="${P.ground}" media="(prefers-color-scheme: light)" data-auto="${P.ground}">`
    + `<meta name="theme-color" content="${N.ground}" media="(prefers-color-scheme: dark)" data-auto="${N.ground}">`
    + `<title>${esc(title)}</title>${iconLinks()}${head}`
    + `<script>${THEME.head}</script><style>${MADE_CSS}${PRINT_CSS}</style></head>`
    + `<body><div class="mp">`
    + `<header class="top">${home ? homeLink(wordmark(), home) : wordmark()}${kicker ? `<span class="kick">${esc(kicker)}</span>` : ""}</header>`
    + `<div class="cols"><main class="main">${main}</main><aside class="side" aria-label="Notes">${side}</aside></div>`
    + (foot ? `<p class="foot">${esc(foot)}</p>` : "")
    + printUrl(url, esc)
    + `</div>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

// ---------------------------------------------------------------- P1 shortlist
/**
 * vm: { kicker, title, meta, options: [{ n, name, image, facts: [[k,v]], note, at, pick }],
 *       opinion, choice: { action, key } | null, picked: label | null }
 * The pick is option 01 when there is one; the others sit as one line each on the phone and fade
 * to 75% beside it on the desk.
 */
export function renderShortlist(vm) {
  const opts = vm.options;
  const pickBtn = (o, cls = "go") => {
    if (vm.picked === o.name) return `<span class="sent">SENT TO REASON</span>`;
    if (!vm.choice) return "";
    return `<form class="inline" method="POST" action="${esc(vm.choice.action)}" data-pick>`
      + `<input type="hidden" name="key" value="${esc(vm.choice.key)}"><input type="hidden" name="label" value="${esc(o.name)}">`
      + `<button class="${cls}" type="submit" aria-label="Pick ${esc(o.name)}">Pick this one →</button></form>`;
  };
  const photo = (o) => o.image
    ? `<img class="photo" src="${esc(o.image)}" alt="${esc(`Photo of ${o.name}`)}" loading="lazy">`
    : "";
  const [first, ...rest] = opts;
  const mobile = `<section class="opt m"><div class="nh"><span class="num">${esc(first.n)}</span><h2>${esc(first.name)}</h2></div>`
    + photo(first) + leaders(first.facts)
    + (first.pick && vm.opinion ? `<p class="hand tilt">${esc(`${vm.opinion} my pick.`)}</p>` : (first.note ? `<p class="quiet">${esc(first.note)}</p>` : ""))
    + pickBtn(first) + `</section>`
    + rest.map(o => `<section class="alt dash m"><div class="row"><span class="nm"><span class="num">${esc(o.n)}</span><span>${esc(o.name)}</span></span>${o.at ? `<span class="at">${esc(String(o.at).toUpperCase())}</span>` : ""}</div>`
      + (o.note ? `<p class="quiet">${esc(o.note)}</p>` : "")
      + `</section>`).join("");
  const desk = `<div class="opts3 d">${opts.map((o, i) => `<div class="o${i > 0 && first.pick ? " dim" : ""}">${photo(o)}`
    + `<span class="nh"><span class="num">${esc(o.n)}</span><span>${esc(o.name)}</span></span>`
    + leaders(o.facts) + pickBtn(o) + `</div>`).join("")}</div>`;
  const main = `<div class="tg"><h1>${turned(vm.title)}</h1>${vm.meta ? `<p class="meta">${esc(String(vm.meta).toUpperCase())}</p>` : ""}</div>`
    + mobile + desk;
  const side = (first.pick && vm.opinion ? `<p class="hand tilt d">${esc(`${first.n} is my pick. ${vm.opinion}`)}</p>` : "")
    + (vm.choice ? `<p class="quiet d">Picking one sends that reply to Reason. Nothing is booked until you say so.</p>` : "")
    + (vm.choice ? `<span class="tight d">${vm.picked ? "SENT · NOTHING BOOKED YET" : "NOTHING BOOKED YET"}</span>` : "");
  return madeDoc({ title: vm.title, kicker: vm.kicker, main, side, head: vm.head, foot: vm.foot ?? PRIVATE_FOOT, script: PICK_JS, url: vm.url, home: vm.home });
}

// A pick posts without leaving the page when script runs; without it the form posts and the server
// sends the browser back to the page with the pick shown.
const PICK_JS = `document.querySelectorAll('form[data-pick]').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('button');b.disabled=true;var d=new FormData(f);fetch(f.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:d.get('key'),label:d.get('label')}),credentials:'same-origin'}).then(function(r){if(!r.ok)throw 0;location.reload()}).catch(function(){b.disabled=false})})})`;

// ---------------------------------------------------------------- P2 the day
/** vm: { kicker, title, note, items: [{ at, title, detail, link: {label, href}, stamp }], tomorrow } */
export function renderDay(vm) {
  const items = vm.items.map((it, i) => `<li><span class="tm">${esc(it.at ?? "")}</span><span class="wh"><span class="wt">${esc(it.title)}</span>`
    + (it.link ? `<a class="wd" href="${esc(it.link.href)}">${esc(it.link.label)} →</a>` : (it.detail ? `<span class="wd">${esc(it.detail)}</span>` : ""))
    + `</span>${it.stamp ? stampTag(it.stamp, i) : "<span></span>"}</li>`).join("");
  const main = `<div class="tg"><h1 class="big">${turned(vm.title)}</h1>${vm.note ? `<p class="hand tilt m">${esc(vm.note)}</p>` : ""}</div>`
    + `<ol class="day">${items}</ol>`
    + (vm.tomorrow ? `<div class="tg m" style="gap:6px"><p class="lbl">TOMORROW</p><p style="margin:0;font-size:15px;line-height:1.5">${esc(vm.tomorrow)}</p></div>` : "");
  const side = (vm.note ? `<p class="hand tilt big d">${esc(vm.note)}</p>` : "")
    + (vm.tomorrow ? `<div class="tg d"><span class="lbl">TOMORROW</span><p class="tmrw">${esc(vm.tomorrow)}</p></div>` : "");
  return madeDoc({ title: vm.title, kicker: vm.kicker, main, side, head: vm.head, url: vm.url, home: vm.home });
}

// ---------------------------------------------------------------- P3 call
const WAVE = [[2, 10, 4], [10, 6, 12], [18, 3, 18], [26, 8, 8], [34, 4, 16], [42, 7, 10], [50, 10, 4], [58, 5, 14], [66, 8, 8], [74, 2, 20], [82, 7, 10], [90, 10, 4], [98, 6, 12], [106, 9, 6], [114, 4, 16], [122, 8, 8], [130, 10, 4], [138, 6, 12], [146, 3, 18], [154, 8, 8], [162, 10, 4], [170, 5, 14], [178, 9, 6], [186, 7, 10], [194, 10, 4], [202, 6, 12], [210, 9, 6], [218, 10, 4]];
const wave = () => `<svg class="wave" aria-hidden="true" viewBox="0 0 220 24" ><g stroke-width="2" stroke-linecap="round" fill="none">`
  + `<path d="${WAVE.map(([x, y, h]) => `M${x} ${y}v${h}`).join("")}"/></g></svg>`;

/** "1:42" and "1 minute 42 seconds" from seconds. */
export function clockOf(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
const spoken = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0)); const m = Math.floor(n / 60); const r = n % 60;
  return [m ? `${m} minute${m === 1 ? "" : "s"}` : "", r ? `${r} second${r === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ") || "0 seconds";
};

/**
 * vm: { kicker, title, stamp, meta, audio: { href, seconds } | null, points: [..], worth,
 *       transcript: [{ who, text }] }
 */
export function renderCall(vm) {
  const player = vm.audio
    ? `<a class="player" href="${esc(vm.audio.href)}" data-audio aria-label="${esc(`Play the call, ${spoken(vm.audio.seconds)}`)}">`
      + `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" stroke="none"/></svg>${wave()}`
      + `<span class="dur">${esc(clockOf(vm.audio.seconds))}</span></a>`
    : "";
  const points = vm.points.length
    ? `<section class="sec"><h2 class="lbl">WHAT HAPPENED</h2><ol class="pts">${vm.points.map((p, i) => `<li><span class="num">${String(i + 1).padStart(2, "0")}</span><span>${esc(p)}</span></li>`).join("")}</ol></section>`
    : "";
  const tx = vm.transcript.length
    ? `<details class="tx dash" id="transcript"><summary class="m">READ THE TRANSCRIPT ↓</summary><div class="lines">`
      + vm.transcript.map(l => `<p>${l.who ? `<span class="who">${esc(String(l.who).toUpperCase())}</span>` : ""}${esc(l.text)}</p>`).join("") + `</div></details>`
    : "";
  const main = `<div class="callh"><h1>${esc(vm.title)}</h1>${vm.stamp ? `<span class="stamp">${esc(vm.stamp)}</span>` : ""}</div>`
    + (vm.meta ? `<p class="meta" style="margin-top:-20px">${esc(vm.meta)}</p>` : "")
    + player + points
    + (vm.worth ? `<section class="sec dash m"><h2 class="lbl">WORTH KNOWING</h2><p class="hand">${esc(vm.worth)}</p></section>` : "")
    + tx;
  const side = (vm.worth ? `<span class="lbl d">WORTH KNOWING</span><p class="hand tilt mid d">${esc(vm.worth)}</p>` : "")
    + (vm.transcript.length ? `<a class="typed d" href="#transcript" data-open-tx>READ THE TRANSCRIPT ↓</a>` : "");
  return madeDoc({ title: vm.title, kicker: vm.kicker, main, side, head: vm.head, script: CALL_JS, url: vm.url, home: vm.home });
}

// The player plays in place; with script off the link opens the recording itself. The desk's margin
// link opens the transcript where it sits.
const CALL_JS = `(function(){var a=document.querySelector('[data-audio]');if(a){var au=null;a.addEventListener('click',function(e){e.preventDefault();if(!au){au=new Audio(a.getAttribute('href'))}if(au.paused){au.play();a.setAttribute('aria-pressed','true')}else{au.pause();a.setAttribute('aria-pressed','false')}})}
var t=document.querySelector('[data-open-tx]');if(t){t.addEventListener('click',function(){var d=document.getElementById('transcript');if(d)d.open=true})}})()`;

// ---------------------------------------------------------------- P4 event
/**
 * vm: { title, host, date: { mon, day, to } | null, facts: [[k,v]], rsvp: { joinHtml } | { joined: true } | null,
 *       coming: [names] | null, calendarHref, foot, head }
 * `joinHtml` is the join form itself (src/pages/event.js keeps the password and the finish step);
 * "I'm in →" opens it, with no script needed.
 */
export function renderEvent(vm) {
  const date = vm.date
    ? `<div class="date" aria-label="${esc(`${vm.date.mon} ${vm.date.day}`)}"><span class="mo">${esc(vm.date.mon)}</span><span class="dn">${esc(vm.date.day)}</span>${vm.date.to ? `<span class="to">– ${esc(vm.date.to)}</span>` : ""}</div>`
    : "";
  const head = `<div class="evh">${date}<div class="evt"><h1>${esc(vm.title)}</h1>${vm.host ? `<p class="host">Hosted by ${esc(vm.host)}</p>` : ""}</div></div>`;
  const facts = leaders(vm.facts);
  const desc = vm.description ? `<p style="margin:0;font-size:15px;line-height:1.55">${esc(vm.description)}</p>` : "";
  const cal = vm.calendarHref ? `<a class="typed cal" href="${esc(vm.calendarHref)}" download>ADD TO MY CALENDAR →</a>` : "";
  let rsvp = "";
  if (vm.rsvp?.joinHtml) {
    rsvp = `<section class="rsvp dash"><h2 class="lbl">ARE YOU IN?</h2>`
      + `<details class="join"${vm.rsvp.open ? " open" : ""}><summary class="go" style="font-size:inherit">I'm in →</summary>${vm.rsvp.joinHtml}</details>`
      + (vm.coming?.length ? `<p class="coming m"><span class="lbl">COMING · </span>${esc(vm.coming.join(", "))}</p>` : "")
      + `</section>`;
  } else if (vm.rsvp?.joined) {
    rsvp = `<section class="rsvp dash"><h2 class="lbl">ARE YOU IN?</h2><div class="row"><span class="go" style="cursor:default">You're in.</span><span class="d">${cal}</span></div>`
      + (vm.coming?.length ? `<p class="coming m"><span class="lbl">COMING · </span>${esc(vm.coming.join(", "))}</p>` : "")
      + `</section>`;
  }
  const main = head + (desc ? desc : "") + (facts ? `<div class="evd">${facts}</div>` : "") + rsvp + (vm.after ?? "")
    + (cal ? `<span class="m">${cal}</span>` : "");
  const side = vm.coming?.length
    ? `<span class="lbl d">COMING</span><p class="names d">${vm.coming.map(esc).join("<br>")}</p>`
    : "";
  return madeDoc({ title: vm.title, kicker: "EVENTS.HEYREASON.COM", main, side, head: vm.head, foot: vm.foot ?? PUBLIC_FOOT, url: vm.url });
}

// ---------------------------------------------------------------- P5 album
const PHOTO_H = [150, 120, 120, 150, 110, 150, 120, 140];
const PHOTO_T = [-1.5, 1.5, 1, -1, 1, -1, 1.5, -1.5];
/**
 * vm: { title, kicker, deskKicker, meta, deskMeta, photos: [{ src, href, alt, caption, removeHtml }],
 *       shown, total, seeAllHref, downloadHref, addLine, foot, why }
 * The phone shows four, the desk eight; "See all N →" opens the rest.
 */
export function renderAlbum(vm) {
  const fig = (ph, i, cls = "") => `<figure class="${cls.trim()}" style="transform:rotate(${PHOTO_T[i % 8]}deg)">`
    + `<a href="${esc(ph.href)}"><img class="photo" style="--h:${PHOTO_H[i % 8]}px" src="${esc(ph.src)}" alt="${esc(ph.alt)}" loading="lazy"></a>`
    + (ph.caption ? `<figcaption>${esc(ph.caption)}</figcaption>` : "") + (ph.removeHtml ?? "") + `</figure>`;
  const list = vm.photos;
  // Not "See all": the phone shows four and the desk eight; the rest wait behind See all.
  const shown = vm.all ? list : list.slice(0, 8);
  const grid = `<div class="grid">${shown.map((ph, i) => fig(ph, i, vm.all ? "" : `${i >= 4 ? "d" : ""}${i === 1 ? " m2" : ""}`)).join("")}</div>`;
  const seeAll = !vm.all && vm.seeAllHref && vm.total > 4 ? `<a class="go" href="${esc(vm.seeAllHref)}">See all ${esc(vm.total)} →</a>` : "";
  const seeAllDesk = !vm.all && vm.seeAllHref && vm.total > 8 ? seeAll : "";
  const dl = vm.downloadHref ? `<a class="typed" href="${esc(vm.downloadHref)}" download>DOWNLOAD ALL</a>` : "";
  const add = vm.addLine ? `<p class="quiet">${esc(vm.addLine)}</p>` : "";
  const main = `<div class="tg"><h1>${esc(vm.title)}</h1>${vm.meta ? `<p class="meta m">${esc(vm.meta)}</p>` : ""}${vm.deskMeta ? `<p class="meta d">${esc(vm.deskMeta)}</p>` : ""}</div>`
    + (vm.why ? `<p class="quiet">${esc(vm.why)}</p>` : "")
    + (list.length ? grid : "")
    + ((seeAll || dl) ? `<div class="acts m">${seeAll}${dl}</div>` : "")
    + (add ? `<span class="m">${add}</span>` : "");
  const side = (seeAllDesk ? `<span class="d">${seeAllDesk}</span>` : "")
    + (dl ? `<span class="d">${dl}</span>` : "")
    + (add ? `<span class="d">${add}</span>` : "");
  return madeDoc({ title: `${vm.title} — album`, kicker: vm.kicker, main, side, head: vm.head, foot: vm.foot, url: vm.url,
    // the desk's line is "24 PHOTOS · FROM 3 OF YOU", the phone's "24 PHOTOS · 3 OF YOU"
  }).replace(`<span class="kick">${esc(vm.kicker)}</span>`, `<span class="kick"><span class="m">${esc(vm.kicker)}</span><span class="d">${esc(vm.deskKicker ?? vm.kicker)}</span></span>`);
}

// ---------------------------------------------------------------- P6 receipt
/** vm: { kicker, title, rows: [[k,v]], total, stamp, note, pdf, chatHref } */
export function renderReceipt(vm) {
  const card = `<div class="rcpt">${leaders(vm.rows)}`
    + `<dl class="ld" style="margin-top:14px"><div class="tot"><dt>TOTAL</dt><span class="dots" aria-hidden="true"></span><dd>${esc(vm.total)}</dd></div></dl>`
    + (vm.stamp ? `<span class="paid">${esc(vm.stamp)}</span>` : "") + `</div>`;
  const acts = (vm.pdf ? `<button class="typed" type="button" data-print hidden>SAVE AS PDF</button>` : "")
    + (vm.chatHref ? `<a class="typed" href="${esc(vm.chatHref)}">SEE IT IN THE CHAT →</a>` : "");
  const main = `<h1 class="dbig">${turned(vm.title)}</h1>${card}`
    + (vm.note ? `<p class="hand tilt m">${esc(vm.note)}</p>` : "")
    + (acts ? `<div class="acts m">${acts}</div>` : "");
  const side = (vm.note ? `<p class="hand tilt d">${esc(vm.note)}</p>` : "")
    + (acts ? `<div class="d" style="display:flex;flex-direction:column;gap:22px">${acts}</div>` : "");
  return madeDoc({ title: vm.title, kicker: vm.kicker, main, side, head: vm.head, script: PRINT_JS, url: vm.url, home: vm.home });
}
// "Save as PDF" is the browser's own print-to-PDF, so it exists only when script does.
const PRINT_JS = `document.querySelectorAll('[data-print]').forEach(function(b){b.hidden=false;b.addEventListener('click',function(){window.print()})})`;

// ---------------------------------------------------------------- E2–E4
const EDGE_CSS = `.edge{flex:1;display:flex;flex-direction:column;justify-content:center;gap:22px;padding:0 4px;max-width:560px}
.edge h1{font-size:40px;line-height:1.06}
.edge .lead{margin:0;font-size:16px;line-height:1.55;color:var(--mut)}
.edge .go{min-height:48px}
@media (min-width:900px){.edge{margin:0 auto;width:100%}}`;

function edgeDoc({ title, host, h1, lead, hand = "", links = "" }) {
  const body = `<main class="edge"><span class="lbl">${esc(host)}</span><h1>${h1}</h1><p class="lead">${esc(lead)}</p>${hand ? `<p class="hand tilt">${esc(hand)}</p>` : ""}${links}</main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
    + `<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark">`
    + `<title>${esc(title)}</title>${iconLinks()}<script>${THEME.head}</script><style>${MADE_CSS}${EDGE_CSS}${PRINT_CSS}</style></head>`
    + `<body><div class="mp"><header class="top">${wordmark()}</header>${body}</div></body></html>`;
}

/** E2 · a shared link, turned off: the event was stopped or has passed, or the album closed. */
export function renderTurnedOff({ host = "EVENTS.HEYREASON.COM", siteUrl = "" } = {}) {
  return edgeDoc({
    title: "This link's been turned off", host,
    h1: `This link’s been <em>turned off.</em>`,
    lead: "Whoever shared it stopped sharing, or the event has passed. If you need it, ask them for a new one.",
    hand: "nothing on your side went wrong.",
    links: siteUrl ? `<a class="go" href="${esc(siteUrl)}">What’s Reason? →</a>` : "",
  });
}

/**
 * E3 · a private page, not yours. Says only who THIS browser is signed in as — never anything about
 * the page, and it is drawn the same for a page that exists and an id that does not.
 */
export function renderNotYours({ masked, threadHref = "", signInHref = "" }) {
  return edgeDoc({
    title: "This page is for someone else", host: "FILES.HEYREASON.COM",
    h1: `This page is <em>for someone else.</em>`,
    lead: `Pages Reason makes are private to the person they’re for. You’re signed in as ${masked}.`,
    links: (threadHref ? `<a class="go" href="${esc(threadHref)}">Back to my thread →</a>` : "")
      + (signInHref ? `<form method="POST" action="${esc(signInHref)}" style="margin:0"><button class="typed" type="submit">SIGN IN AS SOMEONE ELSE</button></form>` : ""),
  });
}

/** E4 · an old page, archived: its owner opened a page from a finished thing. */
export function renderArchived({ pageTitle, savedHref = "" }) {
  return edgeDoc({
    title: "This one's been put away", host: "FILES.HEYREASON.COM",
    h1: `This one’s <em>been put away.</em>`,
    lead: `Pages from finished things are kept in Saved. This link was for “${/[.!?]$/.test(pageTitle) ? pageTitle : `${pageTitle}.`}”`,
    links: savedHref ? `<a class="go" href="${esc(savedHref)}">Find it in Saved →</a>` : "",
  });
}

// ---------------------------------------------------------------- link previews (1200×630)
const OG_SHELL = (inner) => `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS_INLINE_PLACEHOLDER}
body{margin:0;background:${P.ground}}
.og{width:1200px;height:630px;box-sizing:border-box;background:${P.ground};color:${P.ink};font-family:${SANS};padding:64px 80px;display:flex;flex-direction:column;position:relative;overflow:hidden}
.og .top{display:flex;justify-content:space-between;align-items:center}
.og .wm{font-family:${SERIF};font-style:italic;font-size:40px;display:inline-flex;white-space:nowrap;flex:none;align-items:center;line-height:1}
.og .wm svg{width:22px;height:22px;transform:skewX(-10deg);margin:5px 2px 0}
.og .host{font-family:${MONO};font-size:16px;letter-spacing:.14em;color:${P.muted}}
</style></head><body><div class="og">${inner}</div></body></html>`;
const FONTS_INLINE_PLACEHOLDER = "/*fonts*/";
const ogMark = `<span class="wm" role="img" aria-label="reason">reas<svg aria-hidden="true" viewBox="0 0 40 40"><path d="${BUBBLE}" fill="none" stroke="${P.pen}" stroke-width="5" stroke-linejoin="round"/></svg>${WM_O}n</span>`;

/**
 * The one card every private page shows in a link preview (LP2). Nothing of the page is on it: not
 * its title, not whose it is. `fontCss` is the faces inlined as data URLs (the renderer has no host).
 */
export function privateOgHtml({ fontCss = "" } = {}) {
  return OG_SHELL(`<div class="top">${ogMark}<span class="host">FILES.HEYREASON.COM</span></div>`
    + `<div style="margin-top:auto;display:flex;flex-direction:column;gap:24px"><span style="font-family:${MONO};font-size:18px;letter-spacing:.14em;color:${P.muted}">A PAGE REASON MADE FOR YOU</span>`
    + `<p style="margin:0;font-family:${SERIF};font-style:italic;font-size:104px;line-height:1;letter-spacing:-.02em">Open it to see.<br><em>It’s just for you.</em></p>`
    + `<p style="margin:0;font-family:${HAND};font-size:38px;color:${P.pen};transform:rotate(-1deg)">you’ll sign in first. the details stay private.</p></div>`
    + `<div aria-hidden="true" style="position:absolute;right:90px;top:150px;width:210px;height:150px;background:${P.lifted};border:1px solid ${P.hair};box-shadow:3px 4px 0 ${P.shadowBig};transform:rotate(4deg);padding:22px;box-sizing:border-box;display:flex;flex-direction:column;gap:16px">`
    + `<span style="display:block;width:80%;height:3px;background:${P.hair}"></span><span style="display:block;width:55%;height:3px;background:${P.hair}"></span><span style="display:block;width:70%;height:3px;background:${P.hair}"></span></div>`)
    .replace(FONTS_INLINE_PLACEHOLDER, fontCss);
}

/** The words every private page's preview carries (LP2): one generic title, the same for all. */
export const PRIVATE_OG_TITLE = "A page Reason made for you";
export const PRIVATE_OG_DESCRIPTION = "Open it to see. It’s just for you.";

/**
 * One shared event's card (LP3). Only what the organizer made public goes on it: the date only when
 * the time is public, the place only when the place is.
 */
export function eventOgHtml({ title, host = "", place = "", date = null, line = "are you in?", fontCss = "", hostName = "EVENTS.HEYREASON.COM" }) {
  const sub = [host ? `Hosted by ${host}` : "", place].filter(Boolean).join(" · ");
  const size = title.length > 22 ? (title.length > 34 ? 64 : 76) : 92;
  return OG_SHELL(`<div class="top">${ogMark}<span class="host">${esc(hostName)}</span></div>`
    + `<div style="margin-top:auto;display:flex;gap:56px;align-items:flex-end">`
    + (date ? `<div style="width:220px;flex-shrink:0;background:${P.lifted};border:1px solid ${P.hair};box-shadow:3px 4px 0 ${P.shadowBig};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:30px 0;transform:rotate(-3deg)">`
      + `<span style="font-family:${MONO};font-size:26px;letter-spacing:.14em;color:${P.pen}">${esc(date.mon)}</span><span style="font-family:${SERIF};font-style:italic;font-size:130px;line-height:1">${esc(date.day)}</span>`
      + (date.to ? `<span style="font-family:${MONO};font-size:20px;letter-spacing:.1em;color:${P.muted}">– ${esc(date.to)}</span>` : "") + `</div>` : "")
    + `<div style="display:flex;flex-direction:column;gap:18px;padding-bottom:10px;min-width:0"><p style="margin:0;font-family:${SERIF};font-style:italic;font-size:${size}px;line-height:1">${esc(title)}</p>`
    + (sub ? `<span style="font-size:30px;color:${P.muted}">${esc(sub)}</span>` : "")
    + (line ? `<p style="margin:0;font-family:${HAND};font-size:38px;color:${P.pen};transform:rotate(-1deg)">${esc(line)}</p>` : "")
    + `</div></div>`).replace(FONTS_INLINE_PLACEHOLDER, fontCss);
}

/** The faces as data URLs, for a card drawn by a headless browser that has no host to fetch from. */
export function ogFontCss() {
  const f = (family, name, style = "normal", weight = "400") =>
    `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${WEB_FONTS[name].toString("base64")}) format("woff2")}`;
  return f("Reason Serif", "serif", "italic") + f("Reason Hand", "hand") + f("Reason Sans", "sans", "normal", "400 600");
}
