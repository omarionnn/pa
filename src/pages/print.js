// Pages print beautifully (handoff v4 §4h item 8, reference/sheet-small-details.html "8 · PAGES PRINT
// BEAUTIFULLY"). One print stylesheet for every page Reason makes, whichever frame drew it: the v2
// designed pages (src/pages/made.js: shortlist, the day, call, event, album, receipt, and the edge
// screens) and the ordinary pages and notices (src/pages/render.js shell(), which the older event and
// album pages also use).
//
// On paper the page is just the page: white ground, ink text, stamps kept in pen. The header and its
// wordmark, the theme switch, the margin actions, every form and button that does something, the way
// back to Reason and all shadows go; cards are not split across sheets; and the page's own address
// sits in small type at the foot, so a printout says where it came from. The paper is always the
// Paper tokens, even when the reader is on Night: a dark page printed is pale text on white.
//
// The address is a real element (`printUrl`), hidden on screen, rather than an @page margin box:
// Safari draws no margin boxes. It is the canonical, keyless address (never ?k=), so a printout left
// on a desk opens the sign-in, not the page.
import { BRAND_PEN, PAPER } from "./brand.js";

// The sheet's print card, hex for hex.
const INK = PAPER.ink;      // #2a2520
const MUTED = "#78705f";
const HAIR = PAPER.line;    // #d4c9b5
const PEN = BRAND_PEN;      // #9c3b2e
const WHITE = "#ffffff";
const MONO = `'Courier New',Courier,monospace`;

// Both frames' variable names, set to Paper with !important so neither the phone's dark setting nor
// a chosen Night (which win on screen by specificity) can reach the paper.
const TOKENS = [
  // made.js
  `--g:${WHITE}`, `--deep:${WHITE}`, `--lift:${WHITE}`, `--ink:${INK}`, `--mut:${MUTED}`, `--hair:${HAIR}`, `--pen:${PEN}`,
  `--photo:#e3d9c8`, `--sh:transparent`, `--shb:transparent`, `--shp:transparent`,
  // render.js
  `--dim:${MUTED}`, `--line:${HAIR}`, `--bg:${WHITE}`, `--ground:${WHITE}`, `--card:${WHITE}`, `--soft:${WHITE}`,
  `--accent:${PEN}`, `--accent-ink:#fff`, `--mark:${PEN}`, `--warn:#b4232a`, `--shadow:none`, `--edge:${HAIR}`, `--grain:none`,
  // Web (webkit.js), for a Web page someone prints
  `--lifted:${WHITE}`, `--muted:${MUTED}`, `--sh2:none`,
].map(d => `${d}!important`).join(";");

/** Hidden on screen; the address in small mono at the foot on paper. */
export const PRINT_URL_CSS = `.print-url{display:none}`;

export const PRINT_CSS = `${PRINT_URL_CSS}
@media print{
@page{margin:14mm 14mm 16mm}
:root{${TOKENS};color-scheme:light!important}
html,body,.sheet,.mp{background:${WHITE}!important;background-image:none!important;color:${INK}!important}
html::before,html::after,body::before,body::after,.grain{background-image:none!important;display:none!important}
html{overflow:visible!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
*,*::before,*::after{box-shadow:none!important;text-shadow:none!important;animation:none!important;transition:none!important}
.bar,header.top,.theme,.pill,.rel,.b2r,.acts,.typed,.go:is(a,button,summary),.player,details.join,details.tx:not([open]),form,.skip,.tabs,.tab-bar,.composer,.margin-acts{display:none!important}
.sheet{transform:none!important;border-radius:0!important;min-height:0!important}
.mp{min-height:0!important;padding:0!important}
.wrap{padding-top:0!important;padding-bottom:1rem!important}
.stamp,.paid,.sent,.num,.hand,.err,.kicker{color:${PEN}!important}
.stamp,.paid{border-color:${PEN}!important}
.wordmark{color:${INK}!important}.wm-bubble path,.wm svg path{stroke:${PEN}!important}
.s-working{--sc:#b25f00!important}.s-done{--sc:#17794a!important}.s-failed{--sc:#b4232a!important}.s-waiting{--sc:${PEN}!important}
.k-done{--kc:#17794a!important}.k-now{--kc:#b25f00!important}.k-failed{--kc:#b4232a!important}.k-waiting{--kc:${PEN}!important}
a{color:inherit!important}
.rcpt,.opt,.alt,.o,.day li,.pts li,figure,.card,.scroll,.choice,.co,.status,.step,.evh,.date,.ld>div,.callh,table tr,img{break-inside:avoid;page-break-inside:avoid}
h1,h2,h3,.lbl{break-after:avoid;page-break-after:avoid}
.print-url{display:block!important;margin:28px 0 0;padding-top:10px;border-top:1px dotted ${HAIR};font:400 9.5px/1.4 ${MONO};letter-spacing:.14em;color:${MUTED}!important;overflow-wrap:anywhere;break-inside:avoid}
}`;

/**
 * Reason Web's own pages (webkit.js webPage): not pages Reason makes, so nothing is hidden, but a
 * printed Web page is still Paper on white and never carries the grain.
 */
export const WEB_PRINT_CSS = `@media print{:root{${TOKENS};color-scheme:light!important}`
  + `html,body{background:${WHITE}!important;background-image:none!important}`
  + `html::before,html::after,body::before,body::after,.grain{background-image:none!important;display:none!important}`
  + `*,*::before,*::after{box-shadow:none!important;text-shadow:none!important}}`;

/** The address as printed: no scheme, no query, no fragment. */
export function printableUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  return s.replace(/^https?:\/\//i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/** The foot element: "" when there is no address to print. */
export function printUrl(url, esc) {
  const u = printableUrl(url);
  return u ? `<p class="print-url">${esc(u)}</p>` : "";
}
