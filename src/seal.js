// The wax seal, the first-errand patch, the anniversary ticket and the compliments card (handoff
// 2026-10-27 "S3 · Old money, made real": components/seal-*.svg, patch.svg, ticket.svg,
// reference/stamp-kit.html). Strings of inline SVG/HTML, not React: Reason Web is server-rendered
// template strings, so `seal({ wax, ring, date, postmark, size, paper })` is the component, with the
// handoff's props.
//
// Every layer of components/seal-oxblood.svg is kept, in its order:
//   1 wax body   circle + four drips through feTurbulence/feDisplacementMap, a darker rim offset down
//   2 recess     the pressed centre, the engraved ring text, Reason's italic r + the speech bubble
//   3 relief     the same geometry as a grey height map: feDiffuseLighting in soft-light, and
//                feSpecularLighting in screen at 55%
//   4 gloss      a radial white highlight, top left
//   5 postmark   an inked circle, HEYREASON + the date, three wavy cancels, speckled, 80% opacity
//   blank        no wax and no postmark: only the relief over paper, a blind emboss
//
// Without filters (a browser that can't draw them, where a filtered element is simply not drawn) a
// flat disc under layer 1 and the recess, ring and monogram of layer 2 are plain fills, so the wax still
// reads; the relief, gloss and postmark only light and ink it. Ids carry a
// per-seal suffix so any number of seals share a page.
const BUBBLE = "M20 5C28.8 5 36 10.9 36 18.2S28.8 31.4 20 31.4c-1.9 0-3.7-.3-5.4-.8L7 35l2.3-6.6C6.3 26.1 4 22.4 4 18.2 4 10.9 11.2 5 20 5z";

/** The four wax palettes (HANDOFF.md "The seal"), the only new colours besides the golds. */
export const WAX = {
  oxblood: { base: "#6b1e1e", rim: "#3a0e0e", recess: "#561717", label: "Oxblood" },
  green: { base: "#24483a", rim: "#0f241b", recess: "#1c3a2e", label: "Bottle green" },
  navy: { base: "#1f2f4a", rim: "#0c1424", recess: "#18263d", label: "Navy" },
  black: { base: "#2c2926", rim: "#0b0a09", recess: "#201e1c", label: "Black" },
};
/** The old-money golds and the card's fixed paper colours (reference/stamps.html, stamp-kit.html, ticket.svg). */
export const GOLD = { hair: "#a8823c", deep: "#6e5524" };
export const BOTTLE = "#1f3a2e";
const POSTMARK_INK = "#2a2520", POSTMARK_RUST = "#9c3b2e";
export const SEAL_SHADOW = "drop-shadow(0 1.5px 1px rgba(20,12,8,.45)) drop-shadow(0 8px 10px rgba(30,20,14,.28))";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
let seq = 0;
const uid = () => (seq = (seq + 1) % 1e9).toString(36);

const body = (fill, rim) => `<circle cx="151" cy="153" r="111" fill="${rim}"/><circle cx="150" cy="148" r="108" fill="${fill}"/>`
  + `<ellipse cx="256" cy="178" rx="17" ry="11" fill="${fill}"/><ellipse cx="50" cy="112" rx="11" ry="9" fill="${fill}"/>`
  + `<circle cx="128" cy="262" r="10" fill="${fill}"/><circle cx="216" cy="254" r="6" fill="${fill}"/>`;
// The height map's wax: the rim lowest, the drips a step below the body.
const RELIEF_BODY = `<circle cx="151" cy="153" r="111" fill="#7a7a7a"/><circle cx="150" cy="148" r="108" fill="#8e8e8e"/>`
  + `<ellipse cx="256" cy="178" rx="17" ry="11" fill="#7e7e7e"/><ellipse cx="50" cy="112" rx="11" ry="9" fill="#7e7e7e"/>`
  + `<circle cx="128" cy="262" r="10" fill="#7e7e7e"/><circle cx="216" cy="254" r="6" fill="#7e7e7e"/>`;
const ringText = (id, text, fill) => `<text font-family="Instrument Serif, Georgia, serif" font-size="13.5" letter-spacing="3.1" fill="${fill}"><textPath href="#${id}-ring">${esc(text)}</textPath></text>`;

/**
 * A milestone on an everyday seal (REASON_STAMPS_TIERS), drawn over the wax and under the postmark. `level`
 * is the kind's tier (each kind has its own counts, stamps.js TIERS); `mark` the count stitched on the ribbon:
 *   2     a rust ribbon across the foot (the first-errand patch's ribbon)
 *   3     the ribbon turns gold + a gold hairline ring pressed into the wax
 *   4     gold ribbon, a double gold ring and a gilded edge
 * The seal itself is not redrawn: the same wax, ring and monogram at every tier.
 */
function tierArt(id, level, mark) {
  if (!(level >= 2)) return "";
  const gold = level >= 3;
  const [hi, mid, lo, tail, text, stitch] = gold
    ? ["#e2bc66", "#b98b34", "#8a6524", GOLD.deep, "#2e2108", GOLD.deep]
    : ["#b85445", POSTMARK_RUST, "#7a2c21", "#5e2018", "#fbf4e4", "#efe4cf"];
  const ring = (r, w) => `<circle cx="150" cy="148" r="${r}" fill="none" stroke="${GOLD.hair}" stroke-width="${w}"/><circle cx="150" cy="147.2" r="${r}" fill="none" stroke="#f0d79a" stroke-width="${w * 0.35}" opacity="0.7"/>`;
  return `<g class="tier tier-${level}">`
    + (level >= 4 ? `<g filter="url(#${id}-edge)" opacity="0.9"><circle cx="150" cy="148" r="105" fill="none" stroke="#c9a24a" stroke-width="3"/></g>${ring(99, 1.6)}` : "")
    + (level >= 3 ? ring(94, 2.2) : "")
    + `<linearGradient id="${id}-rib" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></linearGradient>`
    + `<path id="${id}-ribline" d="M66 238 Q150 251 234 238" fill="none"/>`
    // The tails, behind the band, folded under at each end; then a soft shadow on the wax, then the band.
    + `<path d="M70 221 L34 221 L47 237 L34 253 L70 253z M230 221 L266 221 L253 237 L266 253 L230 253z" fill="${tail}"/>`
    + `<path d="M64 247 L72 254 L72 245z M236 247 L228 254 L228 245z" fill="#1a120c" opacity="0.55"/>`
    + `<path d="M62 215 Q150 229 238 215 v32 Q150 261 62 247z" fill="#140c08" opacity="0.32" transform="translate(1.5 3)"/>`
    + `<path d="M62 213 Q150 227 238 213 v32 Q150 259 62 245z" fill="url(#${id}-rib)"/>`
    + `<path d="M70 219 Q150 232.5 230 219 M70 240 Q150 253.5 230 240" fill="none" stroke="${stitch}" stroke-width="1.3" stroke-dasharray="3.5 3" opacity="0.85"/>`
    + `<text font-family="Courier New, monospace" font-weight="700" font-size="21" letter-spacing="2" fill="${text}" text-anchor="middle" dy="0"><textPath href="#${id}-ribline" startOffset="50%">${level >= 4 ? `· ${esc(mark)} ·` : esc(mark)}</textPath></text>`
    + `</g>`;
}

/**
 * One seal as inline SVG.
 * `wax`: oxblood | green | navy | black | blank. `ring`: the engraved text (uppercase, ends " ·").
 * `date`: the postmark's date ("OCT 26 2026"). `postmark`: draw it (never on blank). `size`: px, or
 * "100%" to fill its box. `paper`: the ground a blank is pressed into. `label`: the full aria-label
 * (role="img"); empty → aria-hidden, for a seal whose words are said next to it. `tier`: 2 | 3 | 4 draws
 * that milestone (tierArt) with `mark`, the count it was reached at, on the ribbon; anything else, the plain seal.
 */
export function seal({ wax = "oxblood", ring = "", date = "", postmark = true, size = 160, paper = "#f6efe0", label = "", tier = 1, mark = "" } = {}) {
  const id = `ws${uid()}`;
  const blank = wax === "blank" || !WAX[wax];
  const w = WAX[wax] ?? WAX.oxblood;
  const dim = typeof size === "number" ? `${size}` : esc(size);
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true" focusable="false"`;
  const defs = `<defs>`
    + `<filter id="${id}-edge" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="14" xChannelSelector="R" yChannelSelector="G"/></filter>`
    + `<filter id="${id}-diffuse" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="luminanceToAlpha" result="h"/><feGaussianBlur in="h" stdDeviation="2.4" result="hb"/><feDiffuseLighting in="hb" surfaceScale="7" diffuseConstant="1.25" lighting-color="#ffffff" result="d"><feDistantLight azimuth="235" elevation="38"/></feDiffuseLighting><feComposite in="d" in2="SourceAlpha" operator="in"/></filter>`
    + (blank ? "" : `<filter id="${id}-spec" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="luminanceToAlpha" result="h"/><feGaussianBlur in="h" stdDeviation="2.6" result="hb"/><feSpecularLighting in="hb" surfaceScale="7" specularConstant="1.1" specularExponent="26" lighting-color="#ffffff" result="s"><fePointLight x="70" y="30" z="240"/></feSpecularLighting><feComposite in="s" in2="SourceAlpha" operator="in"/></filter>`
      + `<filter id="${id}-ink" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="4" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="2.4" result="rough"/><feTurbulence type="fractalNoise" baseFrequency="0.05 0.45" numOctaves="1" seed="11" result="spk"/><feColorMatrix in="spk" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -9 5.6" result="holes"/><feComposite in="rough" in2="holes" operator="in"/></filter>`
      + `<radialGradient id="${id}-gloss" cx="0.5" cy="0.5" r="0.5" fx="0.34" fy="0.28"><stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/><stop offset="0.38" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`)
    + (blank ? `<radialGradient id="${id}-paper" cx="0.5" cy="0.5" r="0.5"><stop offset="0.82" stop-color="${esc(paper)}" stop-opacity="1"/><stop offset="1" stop-color="${esc(paper)}" stop-opacity="0"/></radialGradient>` : "")
    + `<path id="${id}-ring" d="M150,79 a69,69 0 1,1 -0.1,0"/>`
    + `<g id="${id}-mono"><text x="102" y="168" font-family="Instrument Serif, Georgia, serif" font-style="italic" font-size="112" fill="currentColor">r</text><path d="${BUBBLE}" transform="translate(146 118) scale(1.375) translate(20 20) skewX(-10) translate(-20 -20)" fill="none" stroke="currentColor" stroke-width="3.8" stroke-linejoin="round"/></g>`
    + `</defs>`;
  let art;
  if (blank) {
    // A blind emboss: the relief alone over paper. Without filters it is two faint grey discs and the ring.
    art = `<circle cx="150" cy="150" r="118" fill="url(#${id}-paper)"/>`
      + `<g style="mix-blend-mode:soft-light"><g filter="url(#${id}-diffuse)"><circle cx="150" cy="150" r="104" fill="#ffffff" opacity="0"/>`
      + `<circle cx="150" cy="148" r="90" fill="#9a9a9a"/><circle cx="150" cy="148" r="83" fill="#8a8a8a"/>${ringText(id, ring, "#b0b0b0")}<use href="#${id}-mono" color="#bdbdbd"/></g></g>`;
  } else {
    const ink = wax === "black" ? POSTMARK_RUST : POSTMARK_INK;
    // The flat disc first, outside every filter: what reads if a browser draws no filters at all
    // (an element whose filter fails is not drawn). Small enough to stay under the displaced edge.
    art = `<g><g class="flat"><circle cx="151" cy="152" r="101" fill="${w.rim}"/><circle cx="150" cy="148" r="99" fill="${w.base}"/></g>`
      + `<g filter="url(#${id}-edge)">${body(w.base, w.rim)}</g>`
      + `<circle cx="150" cy="148" r="83" fill="${w.recess}"/>${ringText(id, ring, w.base)}<use href="#${id}-mono" color="${w.base}"/></g>`
      + `<g style="mix-blend-mode:soft-light"><g filter="url(#${id}-diffuse)"><g filter="url(#${id}-edge)">${RELIEF_BODY}</g>`
      + `<circle cx="150" cy="148" r="83" fill="#585858"/>${ringText(id, ring, "#9a9a9a")}<use href="#${id}-mono" color="#b4b4b4"/></g></g>`
      + `<g style="mix-blend-mode:screen;opacity:.55"><g filter="url(#${id}-spec)"><g filter="url(#${id}-edge)"><circle cx="151" cy="153" r="111" fill="#7a7a7a"/><circle cx="150" cy="148" r="108" fill="#8e8e8e"/></g>`
      + `<circle cx="150" cy="148" r="83" fill="#585858"/><use href="#${id}-mono" color="#b4b4b4"/></g></g>`
      + `<circle cx="150" cy="148" r="106" fill="url(#${id}-gloss)"/>`
      + tierArt(id, tier, mark)
      + (postmark ? `<g filter="url(#${id}-ink)" opacity="0.8" fill="none" stroke="${ink}" transform="rotate(-12 226 84)">`
        + `<circle cx="226" cy="84" r="46" stroke-width="2.8"/><circle cx="226" cy="84" r="39" stroke-width="1"/>`
        + `<text x="226" y="77" text-anchor="middle" fill="${ink}" stroke="none" font-family="Courier New, monospace" font-weight="700" font-size="9.5" letter-spacing="2">HEYREASON</text>`
        + `<text x="226" y="94" text-anchor="middle" fill="${ink}" stroke="none" font-family="Courier New, monospace" font-weight="700" font-size="11.5" letter-spacing="1">${esc(date)}</text>`
        + [66, 80, 94].map(y => `<path d="M40 ${y}c9-7 18 7 27 0s18 7 27 0 18 7 27 0 18 7 27 0" stroke-width="2.8"/>`).join("")
        + `</g>` : "");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" class="seal" ${a11y} width="${dim}" height="${dim}" viewBox="0 0 300 300" style="display:block;overflow:visible;filter:${blank ? "none" : SEAL_SHADOW}">${defs}${art}</svg>`;
}

/** The first-errand patch (components/patch.svg): green twill, satin-stitch gold edge, cream thread, the date on a rust ribbon. */
export function patch({ date = "", size = 96, label = "" } = {}) {
  const id = `pt${uid()}`;
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true" focusable="false"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="patch" ${a11y} width="${size}" height="${size}" viewBox="0 0 300 300" style="display:block;overflow:visible;filter:drop-shadow(0 1.5px 1px rgba(20,14,10,.4)) drop-shadow(0 9px 12px rgba(30,20,14,.28))"><defs>`
    + `<pattern id="${id}-twill" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-38)"><rect width="5" height="5" fill="#2f5d5a"/><rect width="5" height="1.6" fill="#264e4b"/><rect y="2.6" width="5" height="0.6" fill="#3a6c68"/></pattern>`
    + `<pattern id="${id}-gold" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><rect width="3" height="3" fill="#c08a2d"/><rect width="3" height="1.1" fill="#d8a64b"/><rect y="2.4" width="3" height="0.5" fill="#94681e"/></pattern>`
    + `<pattern id="${id}-cream" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-22)"><rect width="3" height="3" fill="#efe4cf"/><rect width="3" height="1.1" fill="#fffaf0"/><rect y="2.4" width="3" height="0.5" fill="#c9bb9e"/></pattern>`
    + `<pattern id="${id}-rust" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(18)"><rect width="3" height="3" fill="#9c3b2e"/><rect width="3" height="1.1" fill="#b85445"/><rect y="2.4" width="3" height="0.5" fill="#6e2419"/></pattern>`
    + `<filter id="${id}-puff" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b"/><feSpecularLighting in="b" surfaceScale="4" specularConstant="0.7" specularExponent="14" lighting-color="#ffffff" result="s"><feDistantLight azimuth="235" elevation="42"/></feSpecularLighting><feComposite in="s" in2="SourceAlpha" operator="in" result="si"/><feComposite in="SourceGraphic" in2="si" operator="arithmetic" k1="0" k2="1" k3="0.35" k4="0"/></filter>`
    + `<filter id="${id}-fuzz"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.6"/></filter>`
    + `<path id="${id}-arc" d="M62,150 a88,88 0 0,1 176,0"/></defs>`
    + `<g filter="url(#${id}-puff)"><circle cx="150" cy="150" r="140" fill="#c08a2d"/><circle cx="150" cy="150" r="140" fill="url(#${id}-gold)"/><g filter="url(#${id}-fuzz)">`
    + `<circle cx="150" cy="150" r="131" fill="none" stroke="#94681e" stroke-width="18" stroke-dasharray="1.1 1.5" opacity="0.55"/>`
    + `<circle cx="150" cy="150" r="121" fill="#2f5d5a"/><circle cx="150" cy="150" r="121" fill="url(#${id}-twill)"/>`
    + `<circle cx="150" cy="150" r="112" fill="none" stroke="url(#${id}-cream)" stroke-width="2.4" stroke-dasharray="5 3.2"/>`
    + `<text font-family="Instrument Serif, Georgia, serif" font-size="25" letter-spacing="5" text-anchor="middle" fill="#efe4cf" stroke="#c9bb9e" stroke-width="0.5"><textPath href="#${id}-arc" startOffset="50%">FIRST ERRAND</textPath></text>`
    + `<text x="113" y="186" font-family="Instrument Serif, Georgia, serif" font-style="italic" font-size="96" fill="#efe4cf" stroke="#c9bb9e" stroke-width="0.8">r</text>`
    + `<path d="${BUBBLE}" transform="translate(150 140) scale(1.2) translate(20 20) skewX(-10) translate(-20 -20)" fill="none" stroke="#9c3b2e" stroke-width="5.2" stroke-linejoin="round"/>`
    + `<path d="M58 206h184l-12 15 12 15H58l12-15z" fill="#9c3b2e"/><path d="M58 206h184l-12 15 12 15H58l12-15z" fill="url(#${id}-rust)"/>`
    + `<path d="M66 210h168M66 232h168" stroke="#efe4cf" stroke-width="1.4" stroke-dasharray="3.5 3"/>`
    + `<text x="150" y="227" text-anchor="middle" font-family="Courier New, monospace" font-weight="700" font-size="13" letter-spacing="3.5" fill="#fbf4e4">${esc(date)}</text>`
    + `</g></g></svg>`;
}

/** The anniversary ticket (components/ticket.svg). `serial`: the place among everyone who reached a year. `span`: "AUG 2026 TO AUG 2027". */
export function ticket({ serial = 1, span = "", width = 240, label = "" } = {}) {
  const id = `tk${uid()}`;
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true" focusable="false"`;
  const no = String(Math.max(1, Math.floor(serial))).padStart(6, "0");
  return `<svg xmlns="http://www.w3.org/2000/svg" class="ticket" ${a11y} width="${width}" height="${Math.round(width * 260 / 480)}" viewBox="0 0 480 260" style="display:block;overflow:visible;filter:drop-shadow(0 1px 1px rgba(30,24,18,.3)) drop-shadow(0 10px 14px rgba(30,24,18,.24))"><defs>`
    + `<clipPath id="${id}-shape"><path d="M18 14H458a12 12 0 0 0 10 10V108a20 20 0 0 0 0 40V232a12 12 0 0 0 -10 10H30 l-10 -4 -6 -10 V148a20 20 0 0 0 0 -40V24a12 12 0 0 0 4 -10z"/></clipPath>`
    + `<filter id="${id}-grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0.45"/></feComponentTransfer></filter>`
    + `<linearGradient id="${id}-fold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2a2520" stop-opacity="0"/><stop offset="0.46" stop-color="#2a2520" stop-opacity="0.12"/><stop offset="0.54" stop-color="#ffffff" stop-opacity="0.65"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>`
    + `<g clip-path="url(#${id}-shape)" transform="rotate(-3 240 130)"><rect x="0" y="0" width="480" height="260" fill="#efe4cf"/><rect x="352" y="0" width="128" height="260" fill="#e6d8bd"/>`
    + `<path d="M352 22V238" stroke="${GOLD.deep}" stroke-width="1.6" stroke-dasharray="3 6"/>`
    + `<g font-family="Courier New, monospace" font-weight="700"><text x="44" y="62" font-size="14" letter-spacing="5" fill="#9c3b2e" opacity="0.35" transform="translate(1.2 0.8)">ADMIT ONE</text><text x="44" y="62" font-size="14" letter-spacing="5" fill="#9c3b2e">ADMIT ONE</text></g>`
    + `<text x="44" y="122" font-family="Instrument Serif, Georgia, serif" font-style="italic" font-size="44" fill="#2a2520">A year of things</text>`
    + `<text x="44" y="164" font-family="Instrument Serif, Georgia, serif" font-style="italic" font-size="44" fill="#2a2520">handled.</text>`
    + `<text x="44" y="206" font-family="Courier New, monospace" font-size="11" letter-spacing="2.4" fill="#4f483d">WITH REASON · ${esc(span)}</text>`
    + `<text transform="translate(418 130) rotate(-90)" text-anchor="middle" font-family="Courier New, monospace" font-weight="700" font-size="15" letter-spacing="3.5" fill="#2a2520">No. ${no}</text>`
    + `<text transform="translate(386 130) rotate(-90)" text-anchor="middle" font-family="Instrument Serif, Georgia, serif" font-size="12" letter-spacing="4" fill="${GOLD.deep}">ONE YEAR</text>`
    + `<rect x="198" y="0" width="34" height="260" fill="url(#${id}-fold)"/><path d="M0 214 L480 120" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2.2"/><path d="M0 216.5 L480 122.5" stroke="#2a2520" stroke-opacity="0.1" stroke-width="2"/>`
    + `<path d="M0 0 L60 0 L0 40 Z" fill="#2a2520" opacity="0.05"/><rect x="0" y="0" width="480" height="260" filter="url(#${id}-grain)" style="mix-blend-mode:multiply" opacity="0.7"/></g></svg>`;
}

const LEFT_TEAR = "polygon(1.2% 0, 100% 0, 100% 100%, 0.8% 100%, 2.2% 96%, 0.4% 92%, 1.8% 88%, 0.2% 84%, 2% 80%, 0.6% 75%, 2.4% 71%, 0.2% 66%, 1.6% 62%, 0.4% 57%, 2.2% 53%, 0.8% 48%, 2.6% 44%, 0.4% 39%, 1.8% 35%, 0.2% 30%, 2% 26%, 0.6% 21%, 2.4% 17%, 0.4% 12%, 1.8% 8%, 0.2% 4%)";
const FACE_TEAR = "polygon(2.6% 0, 100% 0, 100% 97%, 98.6% 100%, 2.2% 100%, 3.4% 96.5%, 1.6% 92%, 3% 88.5%, 1.2% 84%, 3.2% 80%, 1.8% 75.5%, 3.6% 71%, 1.4% 66.5%, 2.8% 62%, 1.6% 57.5%, 3.4% 53%, 2% 48.5%, 3.8% 44%, 1.6% 39.5%, 3% 35%, 1.4% 30.5%, 3.2% 26%, 1.8% 21.5%, 3.6% 17%, 1.6% 12.5%, 3% 8%, 1.4% 3.5%)";

/**
 * The compliments card (reference/stamps.html "SHARE IT", stamp-kit.html "THE SHARE"): torn off a pad
 * on its left edge, folded once across the middle, a gold hairline frame, sealed in the corner with the
 * seal's own wax. `who`: "who held for fifty-two minutes on Ama's behalf". `when`: "MONDAY, THE
 * TWENTY-SIXTH OF OCTOBER". `width`: CSS width of the card (it scales by container units). `whoAttrs`:
 * raw attributes for the who line (already escaped), so a page script can rewrite it.
 */
export function complimentsCard({ wax = "oxblood", ring = "", who = "", when = "", width = "min(300px, 88vw)", label = "", whoAttrs = "" } = {}) {
  const gid = `oc${uid()}`;
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true"`;
  const sans = `'Reason Sans',Inter,system-ui,sans-serif`, serif = `'Reason Serif','Instrument Serif',Georgia,serif`;
  return `<div class="cc" ${a11y} style="width:${width};aspect-ratio:3/2;container-type:inline-size;position:relative;font-family:${sans};color:#2a2520">`
    + `<div style="position:absolute;left:3%;top:5%;width:92%;height:86%;transform:rotate(-2.5deg);filter:drop-shadow(0 1px 1px rgba(30,24,18,.25)) drop-shadow(0 10px 14px rgba(30,24,18,.22)) drop-shadow(0 30px 40px rgba(30,24,18,.18))">`
    + `<div aria-hidden="true" style="position:absolute;inset:0;background:#fffdf7;clip-path:${LEFT_TEAR}"></div>`
    + `<div style="position:absolute;inset:0;background:#f6efe0;clip-path:${FACE_TEAR};padding:3.2cqw 3.2cqw 3.2cqw 5cqw;box-sizing:border-box">`
    + `<div style="width:100%;height:100%;box-sizing:border-box;border:.22cqw solid ${GOLD.hair};outline:.12cqw solid ${GOLD.hair};outline-offset:-1cqw;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.6cqw;text-align:center;padding:0 7cqw">`
    + `<span style="font-family:${serif};font-size:2.2cqw;letter-spacing:.32em;color:${GOLD.deep};text-shadow:0 .15cqw 0 rgba(255,255,255,.8)">WITH THE COMPLIMENTS OF</span>`
    + `<span style="font-family:${serif};font-style:italic;font-size:11cqw;line-height:.95;color:#2a2520;text-shadow:0 .15cqw 0 rgba(255,255,255,.7)">Reason</span>`
    + `<span aria-hidden="true" style="width:10cqw;border-top:.22cqw solid ${GOLD.hair}"></span>`
    + `<span class="cc-who"${whoAttrs ? ` ${whoAttrs}` : ""} style="font-family:${serif};font-style:italic;font-size:4.4cqw;line-height:1.25;color:#2a2520">${esc(who)}</span>`
    + `<span style="font-family:${serif};font-size:1.9cqw;letter-spacing:.28em;color:#5e564a;margin-top:.6cqw">${esc(when)}</span></div>`
    + `<span aria-hidden="true" style="position:absolute;left:0;right:0;top:50%;bottom:0;background:rgba(42,37,32,.035)"></span>`
    + `<span aria-hidden="true" style="position:absolute;left:0;right:0;top:calc(50% - 2cqw);height:4cqw;background:linear-gradient(180deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.7) 46%,rgba(42,37,32,.12) 54%,rgba(42,37,32,0) 100%)"></span>`
    + `<svg aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:multiply;opacity:.55"><filter id="${gid}-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0.35"/></feComponentTransfer></filter><rect width="100%" height="100%" filter="url(#${gid}-grain)"/></svg>`
    + `</div></div>`
    + `<div style="position:absolute;right:-1%;bottom:-3%;width:25cqw;height:25cqw;transform:rotate(14deg)">${seal({ wax, ring, postmark: false, size: "100%" })}</div></div>`;
}

/** Paper grain (reference/stamps.html `ds-grain`): the filter once per page, then a layer per surface. */
export const GRAIN_DEF = `<svg aria-hidden="true" width="0" height="0" style="position:absolute"><filter id="ds-grain"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0.4"/></feComponentTransfer></filter></svg>`;
export const grainLayer = (blend = "multiply", opacity = 0.55) => `<svg aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:${blend};opacity:${opacity}"><rect width="100%" height="100%" filter="url(#ds-grain)"/></svg>`;

// ---------------------------------------------------------------- numbers and dates, in words
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/** 52 → "fifty-two", 140 → "one hundred forty", 2300 → "two thousand three hundred". */
export function words(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ""}`;
  if (n < 1e6) return `${words(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${words(n % 1000)}` : ""}`;
  return String(n);
}
const ORD = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
/** 26 → "twenty-sixth". */
export function ordinal(n) {
  const w = words(n);
  const parts = w.split(/([- ])/);
  const last = parts.pop();
  const o = ORD[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return parts.join("") + o;
}
const part = (ms, tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(ms);
/** "Monday, the twenty-sixth of October", on their clock. */
export function fullDate(ms, tz) {
  return `${part(ms, tz, { weekday: "long" })}, the ${ordinal(Number(part(ms, tz, { day: "numeric" })))} of ${part(ms, tz, { month: "long" })}`;
}
/** "OCT 26 2026", the postmark's date. */
export const postmarkDate = (ms, tz) => `${part(ms, tz, { month: "short" })} ${part(ms, tz, { day: "numeric" })} ${part(ms, tz, { year: "numeric" })}`.toUpperCase();
