// Draws the "Secured by Reason" link cards (src/pages/securedcard.js) into assets/secured/<kind>.png,
// 1200×630, in the marketing site's look: paper ground with a soft warm wash, mono eyebrow, Instrument
// Serif italic, the brand pen. Fonts come from assets/fonts, so nothing is fetched.
//
//   node scripts/make-secured-cards.mjs [kind …]
//
// After a redraw, bump SECURED_CARD_VERSION in src/pages/securedcard.js so phones fetch the new ones.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { SECURED_CARDS } from "../src/pages/securedcard.js";
import { BRAND_PEN, PAPER } from "../src/pages/brand.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const font = (f) => pathToFileURL(join(root, "assets/fonts", f)).href;
const out = join(root, "assets/secured");
mkdirSync(out, { recursive: true });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const BUBBLE = (px) => `<svg aria-hidden="true" width="${px}" height="${px}" viewBox="0 0 40 40" style="transform:skewX(-10deg);margin:${Math.round(px * 0.2)}px ${Math.round(px * 0.08)}px 0"><path d="M20 5C28.8 5 36 10.9 36 18.2S28.8 31.4 20 31.4c-1.9 0-3.7-.3-5.4-.8L7 35l2.3-6.6C6.3 26.1 4 22.4 4 18.2 4 10.9 11.2 5 20 5z" fill="none" stroke="${BRAND_PEN}" stroke-width="4.5" stroke-linejoin="round"/></svg>`;
const LOCK = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="${BRAND_PEN}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.6v2.2"/></svg>`;

const html = ({ eyebrow }) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:IS;font-style:italic;src:url("${font("instrument-serif-italic-latin.woff2")}") format("woff2")}
@font-face{font-family:Inter;src:url("${font("inter-web.woff2")}") format("woff2")}
html,body{margin:0}
.c{width:1200px;height:630px;box-sizing:border-box;position:relative;overflow:hidden;color:${PAPER.ink};
  background:
    radial-gradient(900px 520px at 12% -10%, rgba(232,150,110,.55), transparent 62%),
    radial-gradient(820px 560px at 100% 110%, rgba(156,59,46,.26), transparent 60%),
    radial-gradient(700px 420px at 85% 0%, rgba(246,206,160,.62), transparent 65%),
    linear-gradient(160deg, #f6efe4 0%, ${PAPER.bg} 55%, #efe2d2 100%);
  display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.eb{display:flex;align-items:center;gap:14px;font-family:"Courier New",monospace;font-size:22px;letter-spacing:.2em;color:${BRAND_PEN};font-weight:700}
.sec{margin-top:34px;display:flex;align-items:baseline;justify-content:center;gap:26px;font-family:IS,Georgia,serif;font-style:italic;line-height:1;letter-spacing:-.02em}
.by{font-size:92px;color:${PAPER.dim}}
.wm{font-size:150px;display:inline-flex;align-items:center}
.rule{margin-top:44px;width:84px;height:2px;background:${BRAND_PEN};opacity:.55;border-radius:2px}
.foot{position:absolute;bottom:46px;left:0;right:0;font-family:"Courier New",monospace;font-size:16px;letter-spacing:.18em;color:${PAPER.dim}}
</style></head><body><div class="c">
<div class="eb">${LOCK}<span>${esc(eyebrow)}</span></div>
<div class="sec"><span class="by">Secured by</span><span class="wm" role="img" aria-label="reason">reas${BUBBLE(82)}n</span></div>
<div class="rule"></div>
<div class="foot">HEYREASON.COM</div>
</div></body></html>`;

const want = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
for (const [kind, card] of Object.entries(SECURED_CARDS)) {
  if (want.length && !want.includes(kind)) continue;
  const tmp = join(mkdtempSync(join(tmpdir(), "secured-")), "card.html");
  writeFileSync(tmp, html(card));
  await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const file = join(out, `${kind}.png`);
  await page.locator(".c").screenshot({ path: file, type: "png" });
  console.log(`wrote ${file}`);
}
await browser.close();
