// The picture an invite link turns into when it is forwarded: "<Name> thinks you should join reason"
// in the homepage's headline face, with "It's free right now." under it in the site's orange
// handwriting, on the site's warm paper (owner, 2026-10-25).
//
// One picture per inviter NAME, not per link: every link Kofi sends shows the same card, so it is
// drawn once and kept under data/invite-cards by a hash of the name and the design's version. The
// fonts ride inline as data URIs (assets/fonts, both SIL Open Font License: Instrument Serif ©
// 2022 The Instrument Serif Project Authors, Caveat © 2014 The Caveat Project Authors), so the
// server's headless Chromium needs no network to draw it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { esc } from "./pages/render.js";
import { PAPER, PAPER_GRAIN, BRAND_ORANGE } from "./pages/brand.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { CARD_W, CARD_H, RENDER_TIMEOUT_MS, shootWithChromium } from "./pages/card.js";

const font = (f) => `data:font/woff2;base64,${readFileSync(new URL(`../assets/fonts/${f}`, import.meta.url)).toString("base64")}`;
const SERIF = font("instrument-serif-italic-latin.woff2");
const HAND = font("caveat-latin.woff2");

/** Bump when the drawing changes, so every cached card is drawn again. */
export const INVITE_CARD_VERSION = 1;

export function inviteCardHtml(name) {
  const who = String(name || "A friend");
  const size = who.length > 18 ? 96 : 124;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Card Serif";font-style:italic;font-weight:400;src:url(${SERIF}) format("woff2")}
@font-face{font-family:"Card Hand";font-weight:400;src:url(${HAND}) format("woff2")}
${WORDMARK_CSS}
*{margin:0;box-sizing:border-box}html,body{width:${CARD_W}px;height:${CARD_H}px}
body{background:${PAPER_GRAIN} ${PAPER.bg};position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.in{position:absolute;left:84px;right:60px;top:50%;transform:translateY(-54%)}
h1{font:italic 400 ${size}px/1.02 "Card Serif","Instrument Serif",Georgia,serif;letter-spacing:-.02em;color:${PAPER.ink};text-wrap:balance}
h1 .wordmark{font-size:1em;color:${PAPER.ink}}h1 .wm-bubble path{stroke:${BRAND_ORANGE}}
.hand{margin-top:34px;font:400 76px/1.1 "Card Hand",Caveat,cursive;color:${BRAND_ORANGE};transform:rotate(-1.5deg);transform-origin:left}
</style></head><body><div class="in"><h1>${esc(who)} thinks you should join ${wordmark()}</h1><p class="hand">It's free right now.</p></div></body></html>`;
}

/** The cache key, and the `?v=` a link carries so a phone never shows a stale card. */
export function inviteCardKey(name) {
  return createHash("sha256").update(`${INVITE_CARD_VERSION}\n${name}`).digest("hex").slice(0, 16);
}

function cardFile(name) {
  return join(config.dataDir, "invite-cards", `${inviteCardKey(name)}.png`);
}

function withTimeout(promise, ms) {
  let t;
  const clock = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`drawing the invite card took longer than ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, clock]).finally(() => clearTimeout(t));
}

/** The card for one inviter name: read from disk when drawn before, drawn and kept when not. */
export async function inviteCard(name, { shoot = shootWithChromium } = {}) {
  const file = cardFile(name);
  if (existsSync(file)) {
    const png = readFileSync(file);
    if (png.length) return png;
  }
  const png = await withTimeout(shoot(inviteCardHtml(name)), RENDER_TIMEOUT_MS);
  if (!png?.length) throw new Error("the renderer gave back an empty picture");
  mkdirSync(join(config.dataDir, "invite-cards"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, png);
  renameSync(tmp, file);
  return png;
}
