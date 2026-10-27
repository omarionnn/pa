// Reason Web's design kit (owner's design handoff, 2026-10-26: ~/Desktop/reason-web-handoff-2026-10-26,
// HANDOFF.md §1–§6 and the reference pages beside it). One place for what every Web screen is made of:
//
//   - the two papers, Paper and Night, hex for hex from the handoff's table (§2), switched Paper ·
//     Night · Auto; Auto follows the phone. The choice is the same one word in localStorage every
//     other Reason page reads ("reason-theme": light | dark), so picking Night here is Night there.
//   - the four voices (§1.4): your words in Instrument Serif italic, Reason's in Inter, labels and
//     facts in typed Courier capitals, and the margin voice in Caveat, always in pen colour
//   - the wordmark: "reas◯n" with the o drawn as a speech bubble in pen colour, skewed −10°. Pen is
//     #9c3b2e / #d46a5c, the same pen as every other page (src/pages/brand.js).
//   - dashed hairline rules, hard-offset shadows with no blur, nearly square corners, stamps
//   - text actions: never a box around a control (§1.2); a primary action is serif italic with →
//   - motion: new lines rise 6px and fade in over 0.3s; reduced motion means none at all (§2 Motion)
//   - focus: a 2px ink outline offset 3px on everything you can reach by keyboard (§5)
//
// Fonts are self-hosted (assets/fonts/*-web.woff2, SIL OFL, cut to Latin) and served at
// /web/fonts/<name>.woff2 by src/http.js, never fetched from Google; Courier New is the system's.
import { readFileSync } from "node:fs";
import { esc, iconLinks } from "./render.js";

/** The handoff's colour table (§2), exactly. `deep` = deeper ground, `lifted` = lifted paper, `hair` = hairline. */
export const TOKENS = {
  paper: { ground: "#f2ebe0", deep: "#ede5d8", lifted: "#faf6ee", ink: "#2a2520", muted: "#78705f", hair: "#d4c9b5", pen: "#9c3b2e", photo: "#e3d9c8", hover: "#000", shadow: "rgba(0,0,0,0.05)", shadowBig: "rgba(0,0,0,0.06)", shadowPhoto: "rgba(0,0,0,0.08)" },
  night: { ground: "#1c1814", deep: "#151210", lifted: "#27211b", ink: "#efe6d6", muted: "#a89d88", hair: "#3e362c", pen: "#d46a5c", photo: "#332b23", hover: "#fff", shadow: "rgba(0,0,0,0.35)", shadowBig: "rgba(0,0,0,0.35)", shadowPhoto: "rgba(0,0,0,0.35)" },
};

// ---------------------------------------------------------------- fonts
const fontFile = (f) => readFileSync(new URL(`../../assets/fonts/${f}`, import.meta.url));
/** The faces Web uses, by the name in their address. Nothing else is served from /web/fonts. */
export const WEB_FONTS = {
  serif: fontFile("instrument-serif-italic-web.woff2"),
  roman: fontFile("instrument-serif-regular-web.woff2"),
  hand: fontFile("caveat-400-web.woff2"),
  handbold: fontFile("caveat-600-web.woff2"),
  sans: fontFile("inter-web.woff2"),
};
export function webFont(name) {
  const body = Object.hasOwn(WEB_FONTS, name) ? WEB_FONTS[name] : null;
  if (!body) return null;
  return { status: 200, headers: { "Content-Type": "font/woff2", "Content-Length": body.length, "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" }, body };
}
const face = (family, file, { style = "normal", weight = "400" } = {}) =>
  `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url(/web/fonts/${file}.woff2) format("woff2")}`;
const FONTS = face("Reason Serif", "serif", { style: "italic" }) + face("Reason Serif", "roman")
  + face("Reason Hand", "hand") + face("Reason Hand", "handbold", { weight: "600" })
  + face("Reason Sans", "sans", { weight: "400 600" });

// ---------------------------------------------------------------- marks
/** The speech-bubble o, as drawn on every reference page. */
export const BUBBLE_PATH = "M20 5C28.8 5 36 10.9 36 18.2S28.8 31.4 20 31.4c-1.9 0-3.7-.3-5.4-.8L7 35l2.3-6.6C6.3 26.1 4 22.4 4 18.2 4 10.9 11.2 5 20 5z";
export const bubble = (stroke = 5, cls = "bub") =>
  `<svg class="${cls}" aria-hidden="true" viewBox="0 0 40 40"><path d="${BUBBLE_PATH}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"/></svg>`;
/** "reas◯n", top-left on every screen. A link home when `href` is given. */
export function wordmark({ href = "", ing = "" } = {}) {
  const inner = `reas${bubble(5)}n${ing}`;
  return href
    ? `<a class="wm" href="${esc(href)}" aria-label="Reason, home">${inner}</a>`
    : `<span class="wm" role="img" aria-label="reason">${inner}</span>`;
}

// ---------------------------------------------------------------- small parts
/** A typed label (who · where · when, statuses). Courier capitals, tracked. */
export const label = (text, cls = "") => `<p class="lbl${cls ? ` ${cls}` : ""}">${esc(text)}</p>`;
/** The margin voice: one Caveat line in pen. `tilt` for a note standing on its own. */
export const hand = (text, { tilt = false, role = "", tag = "p", cls = "" } = {}) =>
  `<${tag} class="hand${tilt ? " tilt" : ""}${cls ? ` ${cls}` : ""}"${role ? ` role="${role}"` : ""}>${esc(text)}</${tag}>`;
/** A primary text action: serif italic with a trailing arrow. A link, or a submit button inside a form. */
export const action = (text, { href = "", type = "", cls = "", attrs = "" } = {}) => href
  ? `<a class="act${cls ? ` ${cls}` : ""}" href="${esc(href)}"${attrs}>${esc(text)} <span aria-hidden="true">→</span></a>`
  : `<button class="act${cls ? ` ${cls}` : ""}" type="${type || "submit"}"${attrs}>${esc(text)} <span aria-hidden="true">→</span></button>`;
/** A secondary action: typed capitals. */
export const typed = (text, { href = "", type = "", cls = "", attrs = "" } = {}) => href
  ? `<a class="act2${cls ? ` ${cls}` : ""}" href="${esc(href)}"${attrs}>${esc(text)}</a>`
  : `<button class="act2${cls ? ` ${cls}` : ""}" type="${type || "submit"}"${attrs}>${esc(text)}</button>`;
/** A stamp: typed bold capitals in a 1.5px outline, tilted. `tone` pen (done/joined) | ink | muted. */
export const stamp = (text, tone = "pen") => `<span class="stamp stamp-${tone}">${esc(text)}</span>`;
/** The dashed hairline. */
export const rule = () => `<hr class="rule">`;

/**
 * The approval card (§3): typed NEEDS YOUR APPROVAL in pen, the title in Inter 600, typed
 * NOTHING BOOKED / CHARGED YET, "Review details →" only when there is somewhere to review them,
 * and no approve button — approving is saying so in the chat, which the Caveat line says as intent,
 * never as words to type (owner rule 10-25).
 */
export function approvalCard({ title, money = false, href = "" }) {
  return `<div class="card appr"><p class="lbl pen">NEEDS YOUR APPROVAL</p><p class="appr-t">${esc(title)}</p>`
    + `<p class="lbl">${money ? "NOTHING CHARGED YET" : "NOTHING BOOKED YET"}</p>`
    + (href ? `<a class="appr-go" href="${esc(href)}">Review details <span aria-hidden="true">→</span></a>` : "")
    + `</div>${hand(APPROVAL_NUDGE)}`;
}
export const APPROVAL_NUDGE = "just tell me in the chat when you want it.";

/** The "on it." mark: the bubble in pen inside a 40px hairline ring that breathes. role=status. */
export const onIt = (hidden = false) =>
  `<div class="onit" role="status" aria-label="Reason is working on it"${hidden ? " hidden" : ""}><span class="ring">${bubble(4)}</span><span class="hand">on it.</span></div>`;

// ---------------------------------------------------------------- theme
const THEME_KEY = "reason-theme";
const tint = `function tint(){var t=document.documentElement.dataset.theme,c=t==='dark'?'${TOKENS.night.ground}':t==='light'?'${TOKENS.paper.ground}':null;document.querySelectorAll('meta[name=theme-color]').forEach(function(m){m.setAttribute('content',c||m.getAttribute('data-auto'))})}`;
// In the head, before anything is painted: the chosen paper, and whether this tab sees the loader.
// The Ongoing margin's HIDE → (src/pages/webconvo.js), remembered per device and applied before first paint.
export const OG_KEY = "reason-web-og";
// A signed-in page names the theme the person chose on Web (`data-account-theme`, accountThemed below);
// this browser's own switch is brought in line with it first, so every browser opens in the same one.
const HEAD_JS = `(function(){try{${tint}var h=document.documentElement,a=h.getAttribute('data-account-theme');`
  + `if(a==='paper'||a==='night')localStorage.setItem('${THEME_KEY}',a==='paper'?'light':'dark');else if(a==='auto')localStorage.removeItem('${THEME_KEY}');`
  + `var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark'){h.dataset.theme=t;tint()}h.classList.add('js');if(localStorage.getItem('${OG_KEY}')==='off')h.classList.add('og-off');`
  + `if(h.dataset.loader&&!sessionStorage.getItem('reason-web-loaded')&&!matchMedia('(prefers-reduced-motion: reduce)').matches)h.classList.add('loading')}catch(e){}})();`;
// The Paper · Night · Auto radio group, wherever it is drawn; and the loader's exit.
const THEME_JS = `(function(){${tint}var h=document.documentElement;
function show(){var cur=h.dataset.theme==='light'?'paper':h.dataset.theme==='dark'?'night':'auto';document.querySelectorAll('.themes').forEach(function(f){f.hidden=false;f.querySelectorAll('input').forEach(function(i){i.checked=i.value===cur})})}
function apply(n){var v=n==='paper'?'light':n==='night'?'dark':'';
try{if(v)localStorage.setItem('${THEME_KEY}',v);else localStorage.removeItem('${THEME_KEY}')}catch(x){}if(v)h.dataset.theme=v;else delete h.dataset.theme;tint();show();keep(n)}window.reasonTheme=apply;
document.addEventListener('change',function(e){var i=e.target;if(!i||!i.closest||!i.closest('.themes'))return;apply(i.value)});show();
function keep(n){var c=h.getAttribute('data-c');if(!c||!h.hasAttribute('data-account-theme'))return;h.setAttribute('data-account-theme',n);try{fetch('/web/settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:'do=theme&theme='+encodeURIComponent(n)+'&c='+encodeURIComponent(c)})}catch(x){}}
if(h.classList.contains('loading')){var t0=Date.now();try{sessionStorage.setItem('reason-web-loaded','1')}catch(x){}window.addEventListener('load',function(){setTimeout(function(){h.classList.add('loaded');setTimeout(function(){h.classList.remove('loading','loaded')},420)},Math.max(0,1200-(Date.now()-t0)))})}})();`;
/**
 * Paper · Night · Auto, a real radio group. Hidden until the script can make it work (no dead controls).
 * Each copy on a page (menu, footer, Settings) is its own group, named by its id, so every copy shows its tick.
 */
export function themeSwitch(id = "th") {
  const opt = (v, t) => `<label class="th-o"><input type="radio" name="theme-${id}" value="${v}"${v === "auto" ? " checked" : ""}><span>${t}</span></label>`;
  return `<fieldset class="themes" hidden><legend class="sr">Theme</legend><div class="th-row" id="${id}">${opt("paper", "Paper")}<span class="th-dot" aria-hidden="true">·</span>${opt("night", "Night")}<span class="th-dot" aria-hidden="true">·</span>${opt("auto", "Auto")}</div></fieldset>`;
}

/**
 * A signed-in Web page, told the theme its person chose (paper | night | auto, or null for never) and
 * the session's form secret, so any copy of the switch on it saves the choice for every browser.
 * Paper and Night are drawn server-side too (`data-theme`), so even a page without script opens in it.
 */
export function accountThemed(html, { theme = null, csrf = "" } = {}) {
  const t = ["paper", "night", "auto"].includes(theme) ? theme : "";
  const drawn = t === "paper" ? ` data-theme="light"` : t === "night" ? ` data-theme="dark"` : "";
  return String(html).replace(/^<!doctype html>\n<html lang="en"/, (m) => `${m} data-account-theme="${t}" data-c="${esc(csrf)}"${drawn}`);
}

// ---------------------------------------------------------------- the stylesheet
const vars = (t) => `--ground:${t.ground};--deep:${t.deep};--lifted:${t.lifted};--ink:${t.ink};--muted:${t.muted};--hair:${t.hair};--pen:${t.pen};--photo:${t.photo};--hov:${t.hover};--sh:2px 3px 0 ${t.shadow};--sh2:3px 4px 0 ${t.shadowBig};--shp:2px 3px 0 ${t.shadowPhoto}`;
export const KIT_CSS = `${FONTS}
:root{${vars(TOKENS.paper)};color-scheme:light;--serif:"Reason Serif","Instrument Serif",Georgia,serif;--sans:"Reason Sans",Inter,system-ui,-apple-system,sans-serif;--mono:"Courier New",Courier,monospace;--hand:"Reason Hand",Caveat,cursive;--gut:24px}
:root[data-theme=dark]{${vars(TOKENS.night)};color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(TOKENS.night)};color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:400 16px/1.55 var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
a{color:var(--ink)}a:hover{color:var(--hov)}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
input:focus-visible{outline:none}
button{font:inherit;color:inherit}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;margin:0;padding:0;border:0}
.wm{font:italic 400 22px/1 var(--serif);letter-spacing:-.01em;display:inline-flex;align-items:center;text-decoration:none;color:var(--ink);min-height:44px}
.wm .bub{width:.59em;height:.59em;color:var(--pen);transform:skewX(-10deg);margin:3px 1px 0}
.lbl{margin:0;font:400 10.5px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lbl.pen{color:var(--pen)}
.hand{margin:0;font:400 21px/1.2 var(--hand);color:var(--pen)}
.hand.tilt{transform:rotate(-1deg);transform-origin:left center}
.h1{margin:0;font:italic 400 46px/1.05 var(--serif);letter-spacing:-.02em;overflow-wrap:break-word}
.h1 em{font-style:italic}
.act{align-self:flex-start;min-height:52px;display:inline-flex;align-items:center;gap:.25em;border:0;background:transparent;padding:0;cursor:pointer;text-decoration:none;font:italic 400 30px/1.15 var(--serif);color:var(--ink);text-align:left}
.act2{min-height:44px;display:inline-flex;align-items:center;border:0;background:transparent;padding:0;cursor:pointer;text-decoration:none;font:400 11.5px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink)}
.act:hover,.act2:hover{color:var(--hov)}
.act[aria-busy=true],.act2[aria-busy=true]{opacity:.6;cursor:progress}
.card{background:var(--lifted);border:1px solid var(--hair);border-radius:4px;box-shadow:var(--sh)}
.stamp{display:inline-block;align-self:flex-start;font:700 11px/1.3 var(--mono);letter-spacing:.12em;text-transform:uppercase;border:1.5px solid currentColor;border-radius:3px;padding:3px 8px;transform:rotate(-3deg)}
.stamp-pen{color:var(--pen)}.stamp-ink{color:var(--ink)}.stamp-muted{color:var(--muted)}
.rule{border:0;border-top:1px dashed var(--hair);margin:0;height:0}
.appr{padding:18px;display:flex;flex-direction:column;gap:8px;max-width:420px}
.appr .lbl{font-size:10.5px;letter-spacing:.1em}
.appr-t{margin:0;font-size:16px;font-weight:600}
.appr-go{font-size:14px;font-weight:500;text-decoration:none;min-height:44px;display:inline-flex;align-items:center;align-self:flex-start}
.onit{display:flex;align-items:center;gap:14px}
.onit[hidden]{display:none}
.onit .ring{width:40px;height:40px;border-radius:50%;border:1px solid var(--hair);display:grid;place-items:center;flex:none;animation:breathe 3.2s ease-in-out infinite}
.onit .bub{width:18px;height:18px;color:var(--pen);transform:skewX(-10deg)}
.onit .hand{font-size:24px}
@keyframes breathe{0%,100%{transform:scale(1);border-color:var(--hair)}50%{transform:scale(1.06);border-color:var(--pen)}}
.arrive{animation:arrive .3s ease-out both}
@keyframes arrive{from{opacity:0;transform:translateY(6px)}}
.themes{border:0;margin:0;padding:0;min-width:0}
.themes[hidden]{display:none}
.th-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.th-o{position:relative;min-height:44px;display:inline-flex;align-items:center;cursor:pointer;font:italic 400 20px/1 var(--serif);color:var(--muted)}
.th-o input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.th-o input:checked+span{color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:5px}
.th-o input:focus-visible+span{outline:2px solid var(--ink);outline-offset:3px}
.th-dot{color:var(--muted)}
.foot{padding:28px var(--gut) 32px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.loader{display:none}
html.loading .loader{display:flex;position:fixed;inset:0;z-index:50;background:var(--ground);align-items:center;justify-content:center;transition:opacity .4s ease}
html.loading.loaded .loader{opacity:0}
.loader p{margin:0;font:italic 400 64px/1 var(--serif);letter-spacing:-.01em;display:inline-flex;align-items:center}
.loader .bub{width:34px;height:34px;color:var(--pen);transform:skewX(-10deg);margin:8px 2px 0}
.loader .ing{color:var(--muted);display:inline-block;overflow:hidden;white-space:nowrap;width:0;animation:ing .6s steps(3,end) .15s forwards}
@keyframes ing{to{width:1.55ch}}
@media (min-width:900px){.wm{font-size:26px}.wm .bub{width:.577em;height:.577em}.lbl{font-size:11px}.hand{font-size:22px}.h1{font-size:64px}.act{font-size:32px}.act2{font-size:12px}}
@media (max-width:359px){:root{--gut:20px}.h1{font-size:38px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}html.loading .loader{display:none}}
`;

/**
 * A whole Web page. `head` extras (the conversation's boot data) go in the script; `css` is the
 * screen's own. `loader` marks a page that may open with the reas◯n + ing loader (once per tab, never
 * under reduced motion). `foot` is drawn under the page (the theme switch, by default).
 */
export function webPage({ title = "Reason", header = "", body = "", css = "", script = "", bodyClass = "", loader = false, foot = undefined, connect = "" }) {
  const footer = foot === undefined ? `<footer class="foot">${themeSwitch()}</footer>` : foot;
  return `<!doctype html>
<html lang="en"${loader ? ` data-loader="1"` : ""}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${TOKENS.paper.ground}" data-auto="${TOKENS.paper.ground}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${TOKENS.night.ground}" data-auto="${TOKENS.night.ground}" media="(prefers-color-scheme: dark)">
${iconLinks()}
<title>${esc(title)}</title>
<script>${HEAD_JS}</script>
<style>${KIT_CSS}${css}</style>
</head><body${bodyClass ? ` class="${esc(bodyClass)}"` : ""}>${loader ? `<div class="loader" role="status" aria-label="Loading"><p>reas${bubble(4)}n<span class="ing">ing</span></p></div>` : ""}
${header}${body}${footer}<script>${script}${THEME_JS}</script></body></html>`;
}
