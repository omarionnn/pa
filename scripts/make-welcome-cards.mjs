// Draws the seven welcome cards (src/welcome.js CARDS) into assets/welcome/NN-<key>.jpg, 1080×1350,
// in the marketing site's look: paper ground, spaced mono eyebrow, Instrument Serif italic title, the
// brand pen in Caveat for the one hand-written line, the bubble mark, and one line drawing per card.
// The example request sits in a blue "sent" bubble, the way the site's demos show what you text.
// Fonts come from assets/fonts, so nothing is fetched.
//
//   node scripts/make-welcome-cards.mjs [--out <dir>] [key …]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename } from "node:path";
import { CARDS, eyebrowOf } from "../src/welcome.js";
import { BRAND_PEN, PAPER } from "../src/pages/brand.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const font = (f) => pathToFileURL(join(root, "assets/fonts", f)).href;
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : join(root, "assets/welcome");
const want = args.filter((a, i) => a !== "--out" && i !== outAt + 1);
mkdirSync(out, { recursive: true });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const INK = PAPER.ink ?? "#2a2520";
const P = BRAND_PEN;
// One line drawing per card, on a 240×170 grid: ink for the thing, the pen for its one accent.
const ink = (d, w = null) => `<path d="${d}" stroke="${INK}"${w ? ` style="stroke-width:${w}"` : ""}/>`;
const pen = (d, w = null) => `<path d="${d}" stroke="${P}"${w ? ` style="stroke-width:${w}"` : ""}/>`;
const DRAW = {
  calls: [
    `<g transform="translate(34 30) scale(5.2)">${ink("M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z", 1.25)}${pen("M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94", 1.25)}</g>`,
    ink("M168 156V104h56v52M162 104l34-24 34 24M188 156v-24h16v24M176 116h12M204 116h12"),
    `<path d="M118 150 Q140 176 166 150" stroke="${P}" stroke-dasharray="2 9"/>`,
  ],
  events: [
    ink("M58 154H190M74 152V102q0-6 6-6h88q6 0 6 6v50"),
    pen("M74 114q12 12 25 0t25 0 25 0 25 0"),
    ink("M100 96V72M124 96V68M148 96V72"),
    pen("M100 62q-7-8 0-17 7 9 0 17zM124 58q-7-8 0-17 7 9 0 17zM148 62q-7-8 0-17 7 9 0 17z"),
    ink("M14 22Q124 64 234 22"),
    pen("M40 33l8 16 8-12M86 45l7 16 9-14M134 47l6 16 10-15M182 38l5 16 11-13"),
  ],
  reminders: [
    ink("M120 46a52 52 0 1 0 0.1 0z"),
    ink("M120 98V68M120 98l22 14"),
    ink("M74 54a20 20 0 0 1 28-14M138 40a20 20 0 0 1 28 14M86 142l-12 16M154 142l12 16"),
    pen("M54 40l-14-10M48 66H30M186 40l14-10M192 66h18"),
    `<circle cx="120" cy="98" r="4" fill="${P}" stroke="none"/>`,
  ],
  shopping: [
    ink("M56 74H184L172 160H68Z"),
    ink("M92 74V62a28 28 0 0 1 56 0v12"),
    ink("M106 74V34h26v40M113 34V22h12M119 22v-8h16"),
    pen("M96 118l16 16 34-36"),
  ],
  food: [
    `<g transform="rotate(-16 124 104)">${ink("M58 70h120a34 34 0 0 1 0 68H58")}${ink("M58 70a14 34 0 0 0 0 68a14 34 0 0 0 0-68z")}${ink("M136 70l8 8-8 9 8 8-8 9 8 8-8 9 8 8-8 9")}${ink("M160 78l-6 14M178 84l-8 18M186 106l-10 16")}${ink("M92 72q10 32 0 64")}</g>`,
    pen("M54 92h.1M62 104h.1M52 112h.1M60 120h.1"),
    pen("M92 50q-9-10 0-20t0-20M120 46q-9-10 0-20t0-20M148 50q-9-10 0-20t0-20"),
  ],
  booking: [
    ink("M46 100H194M54 100q2 22-6 32M186 100q-2 22 6 32M72 132v26M168 132v26"),
    ink("M14 158V92M14 126h30v32M226 158V92M226 126h-30v32"),
    ink("M114 100V74h12v26"),
    pen("M120 66q-8-9 0-19 8 10 0 19z"),
    ink("M78 100V86M70 100h16M70 64q8 26 16 0zM162 100V86M154 100h16M154 64q8 26 16 0z"),
  ],
  more: [
    ink("M56 26H146L172 52V156H56Z"),
    ink("M146 26V52H172"),
    ink("M76 76H150M76 98H150M76 120H120"),
    pen("M160 118a28 28 0 1 0 0.1 0zM182 166l22 22"),
    pen("M30 24q4 16 20 20-16 4-20 20-4-16-20-20 16-4 20-20z"),
  ],
};

const BUBBLE = (px) => `<svg aria-hidden="true" width="${px}" height="${px}" viewBox="0 0 40 40" style="transform:skewX(-10deg)"><path d="M20 5C28.8 5 36 10.9 36 18.2S28.8 31.4 20 31.4c-1.9 0-3.7-.3-5.4-.8L7 35l2.3-6.6C6.3 26.1 4 22.4 4 18.2 4 10.9 11.2 5 20 5z" fill="none" stroke="${P}" stroke-width="3.2" stroke-linejoin="round"/></svg>`;

const html = (c) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:IS;font-style:italic;src:url("${font("instrument-serif-italic-latin.woff2")}") format("woff2")}
@font-face{font-family:Inter;src:url("${font("inter-web.woff2")}") format("woff2")}
@font-face{font-family:Caveat;src:url("${font("caveat-600-web.woff2")}") format("woff2")}
html,body{margin:0}
.c{width:1080px;height:1350px;box-sizing:border-box;position:relative;overflow:hidden;color:${INK};
  background:radial-gradient(900px 600px at 0% 0%, rgba(246,206,160,.45), transparent 65%), radial-gradient(800px 600px at 100% 100%, rgba(156,59,46,.10), transparent 60%), ${PAPER.bg};
  padding:76px 84px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between}
.eb{font-family:"Courier New",monospace;font-weight:700;font-size:40px;letter-spacing:.16em;color:${PAPER.dim ?? "#6a6253"}}
.eb b{color:${P};font-weight:700}
.rule{margin-top:34px;border-top:3px dashed ${PAPER.rule ?? "#d4c9b5"}}
.art{flex:1;display:flex;align-items:center;justify-content:center}
.art svg{width:760px;height:540px;overflow:visible}
.art path{fill:none;stroke-width:6.5;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-family:IS,Georgia,serif;font-style:italic;font-weight:400;font-size:${c.title.length > 10 ? 150 : 176}px;line-height:.95;letter-spacing:-.02em}
.note{margin-top:14px;font-family:Caveat,cursive;font-size:62px;line-height:1.05;color:${P}}
.say{margin-top:52px;display:flex;justify-content:flex-end}
.b{position:relative;max-width:820px;background:#0A84FF;color:#fff;font-family:Inter,system-ui,sans-serif;font-size:56px;line-height:1.22;font-weight:500;padding:30px 42px;border-radius:52px;letter-spacing:-.01em}
</style></head><body><div class="c">
<div class="top"><div class="eb">${esc(eyebrowOf(c)).replace(/^(\d\d)/, "<b>$1</b>")}</div>${BUBBLE(84)}</div>
<div class="rule"></div>
<div class="art"><svg viewBox="0 0 240 190"><defs><filter id="w" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${c.n * 7}"/><feDisplacementMap in="SourceGraphic" scale="3.2"/></filter></defs><g filter="url(#w)" transform="translate(0 8)">${DRAW[c.key].join("")}</g></svg></div>
<h1>${esc(c.title)}</h1>
<div class="note">~&gt; ${esc(c.note)}</div>
<div class="say"><div class="b">${esc(c.example)}</div></div>
</div></body></html>`;

// The drawings on their own, as editable SVG (assets/welcome/art/<key>.svg): the same paths, the
// same hand-drawn wobble filter, colours written in, so they open in Figma/Illustrator or drop into
// a web page as-is. Written on every run, so they never drift from the cards.
export const artSvg = (c, { size = 720 } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 190 / 240)}" viewBox="0 0 240 190">
<!-- Reason welcome card ${c.n}: ${c.title}. Ink ${INK}, pen ${P}. Strokes 6.5/240 of the width, round caps and joins, no fills. -->
<defs><filter id="wobble" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${c.n * 7}"/><feDisplacementMap in="SourceGraphic" scale="3.2"/></filter></defs>
<g filter="url(#wobble)" transform="translate(0 8)" fill="none" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">
${DRAW[c.key].join("\n")}
</g>
</svg>
`;
const artDir = join(root, "assets/welcome/art");
mkdirSync(artDir, { recursive: true });
for (const c of CARDS) writeFileSync(join(artDir, `${c.key}.svg`), artSvg(c));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
for (const c of CARDS) {
  if (want.length && !want.includes(c.key)) continue;
  const tmp = join(mkdtempSync(join(tmpdir(), "welcome-")), "card.html");
  writeFileSync(tmp, html(c));
  await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const file = join(out, basename(c.file));
  await page.locator(".c").screenshot({ path: file, type: "jpeg", quality: 82 });
  console.log(`wrote ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
}
await browser.close();
