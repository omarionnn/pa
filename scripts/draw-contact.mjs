// Draws assets/reason-contact.jpg, the photo on Reason's contact card (src/contact.js), from
// assets/reason-contact.svg — the Web handoff's contact mark (owner, 2026-10-27): an Instrument Serif
// italic "r" beside the pen-colour speech-bubble outline on paper. The "r" is live text, so it is
// drawn in Chromium with the self-hosted font inlined; no system or Google font is ever used.
// Run again after the mark or the pen changes: `node scripts/draw-contact.mjs`, then bump
// CARD_REVISED and the BRAND sha in test/contact-card-brand.test.js.
import { readFileSync, writeFileSync } from "node:fs";
import { shootWithChromium } from "../src/pages/card.js";

const at = (p) => new URL(`../${p}`, import.meta.url);
const font = readFileSync(at("assets/fonts/instrument-serif-italic-latin.woff2")).toString("base64");
const svg = readFileSync(at("assets/reason-contact.svg"), "utf8");
const html = `<!doctype html><style>@font-face{font-family:"Instrument Serif";font-style:italic;font-weight:400;src:url(data:font/woff2;base64,${font}) format("woff2")}html,body{margin:0}svg{display:block}</style>${svg}`;
const out = at("assets/reason-contact.jpg");
writeFileSync(out, await shootWithChromium(html, { width: 1024, height: 1024, type: "jpeg" }));
console.log(`drew ${out.pathname}`);
