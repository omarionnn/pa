// Draws assets/reason-contact.jpg, the photo on Reason's contact card (src/contact.js), from
// assets/reason-contact.svg — the Web handoff's contact mark (owner, 2026-10-27): an Instrument Serif
// italic "r" beside the pen-colour speech-bubble outline on paper. The "r" is live text, so it is
// drawn in Chromium with the self-hosted font inlined; no system or Google font is ever used.
// Run again after the mark or the pen changes: `node scripts/draw-contact.mjs`, then bump
// CARD_REVISED and the BRAND sha in test/contact-card-brand.test.js.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const at = (p) => new URL(`../${p}`, import.meta.url);
const font = readFileSync(at("assets/fonts/instrument-serif-italic-latin.woff2")).toString("base64");
const svg = readFileSync(at("assets/reason-contact.svg"), "utf8");
const html = `<!doctype html><style>@font-face{font-family:"Instrument Serif";font-style:italic;font-weight:400;src:url(data:font/woff2;base64,${font}) format("woff2")}html,body{margin:0}svg{display:block}</style>${svg}`;
const out = at("assets/reason-contact.jpg");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  // The "r" must be Instrument Serif, never the Georgia fallback: wait for it, and refuse without it.
  const loaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some(f => f.family.includes("Instrument Serif") && f.status === "loaded"); });
  if (!loaded) throw new Error("Instrument Serif italic did not load; not drawing the photo in a fallback font");
  writeFileSync(out, await page.screenshot({ type: "jpeg", quality: 86, clip: { x: 0, y: 0, width: 1024, height: 1024 } }));
} finally {
  await browser.close();
}
console.log(`drew ${out.pathname}`);
