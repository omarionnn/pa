// Draws assets/reason-contact.jpg, the photo on Reason's contact card (src/contact.js), from
// assets/reason-contact.svg — the pen-colour speech-bubble outline alone on paper (owner, 2026-11-06:
// the italic "r" that stood beside it is gone; the card's name is whatever the person chose, so the
// picture carries no letter). Drawn in Chromium so the stroke matches what the browser shows.
// Run again after the mark or the pen changes: `node scripts/draw-contact.mjs`, then bump
// CARD_REVISED and the BRAND sha in test/contact-card-brand.test.js.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const at = (p) => new URL(`../${p}`, import.meta.url);
const svg = readFileSync(at("assets/reason-contact.svg"), "utf8");
const html = `<!doctype html><style>html,body{margin:0}svg{display:block}</style>${svg}`;
const out = at("assets/reason-contact.jpg");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  writeFileSync(out, await page.screenshot({ type: "jpeg", quality: 86, clip: { x: 0, y: 0, width: 1024, height: 1024 } }));
} finally {
  await browser.close();
}
console.log(`drew ${out.pathname}`);
