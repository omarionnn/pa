// Pages v2 previews beside the handoff's reference pages: for each screen, the reference artboard
// (Paper and Night) and Reason's own render at the same width, side by side.
//
//   node scripts/pages-v2-compare.mjs <handoff-reference-dir> <mine-dir> <out-dir>
//
// Writes <out-dir>/compare-pages-<screen>-<390|1280>.png. Uses only Playwright (already a dependency).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const [REF, MINE, OUT] = process.argv.slice(2).map(p => resolve(p));
const browser = await chromium.launch();

/** One artboard of a reference sheet: the nth box of that width. */
async function refShot(file, width, nth) {
  const p = await browser.newPage({ viewport: { width: 3000, height: 1400 }, deviceScaleFactor: 2 });
  await p.goto(`file://${file}`, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  const boxes = p.locator(`div[style*="width: ${width}px"]`);
  const buf = await boxes.nth(nth).screenshot();
  await p.close();
  return buf;
}

/** The pictures side by side on one sheet, each under its label. */
async function sheet(items, out) {
  const p = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  const cells = items.map(([label, buf]) => `<figure style="margin:0;display:flex;flex-direction:column;gap:10px"><figcaption style="font:600 22px/1.2 'Courier New',monospace;letter-spacing:.1em;color:#5a5348">${label}</figcaption><img src="data:image/png;base64,${buf.toString("base64")}" style="display:block;border:1px solid #c9bfae;max-width:none"></figure>`).join("");
  await p.setContent(`<body style="margin:0;background:#e2d9ca"><div style="display:inline-flex;gap:40px;padding:40px;align-items:flex-start">${cells}</div></body>`);
  await p.waitForTimeout(150);
  const size = await p.evaluate(() => ({ w: document.body.firstElementChild.scrollWidth, h: document.body.firstElementChild.scrollHeight }));
  await p.setViewportSize({ width: size.w, height: size.h });
  writeFileSync(out, await p.screenshot({ fullPage: true }));
  await p.close();
}

// screen -> [reference index on the phone sheet, on the desk sheet]
const PAGES = { shortlist: 0, day: 1, call: 2, event: 3, album: 4, receipt: 5 };
const EDGE = { "edge-turned-off": 1, "edge-not-yours": 2, "edge-archived": 3 };
const mine = (name, w, t) => { const f = join(MINE, `pages-${name}-${w}-${t}.png`); return existsSync(f) ? readFileSync(f) : null; };

for (const [name, i] of Object.entries(PAGES)) {
  const items390 = [], items1280 = [];
  for (const t of ["paper", "night"]) {
    items390.push([`REFERENCE P${i + 1} · ${t.toUpperCase()}`, await refShot(join(REF, `sheet-pages-${t}.html`), 390, i)]);
    items390.push([`REASON · 390 · ${t.toUpperCase()}`, mine(name, 390, t)]);
    items1280.push([`REFERENCE PD${i + 1} · ${t.toUpperCase()}`, await refShot(join(REF, `sheet-pages-desk-${t}.html`), 960, i)]);
    items1280.push([`REASON · 1280 · ${t.toUpperCase()}`, mine(name, 1280, t)]);
  }
  await sheet(items390.filter(x => x[1]), join(OUT, `compare-pages-${name}-390.png`));
  await sheet(items1280.filter(x => x[1]), join(OUT, `compare-pages-${name}-1280.png`));
}
for (const [name, i] of Object.entries(EDGE)) {
  const items = [];
  for (const t of ["paper", "night"]) {
    items.push([`REFERENCE E${i + 1} · ${t.toUpperCase()}`, await refShot(join(REF, `sheet-edge-${t}.html`), 390, i)]);
    items.push([`REASON · 390 · ${t.toUpperCase()}`, mine(name, 390, t)]);
  }
  items.push(["REASON · 1280 · PAPER", mine(name, 1280, "paper")]);
  await sheet(items.filter(x => x[1]), join(OUT, `compare-pages-${name}.png`));
}
// The two link previews.
for (const [name, ref, file] of [["og-private", "preview-private.html", "og-private.png"], ["og-event", "preview-event.html", "og-event.jpg"]]) {
  const f = join(MINE, file);
  if (!existsSync(f)) continue;
  const p = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await p.goto(`file://${join(REF, ref)}`, { waitUntil: "networkidle" });
  const refBuf = await p.locator(`div[style*="width: 1200px"]`).first().screenshot();
  await p.close();
  const conv = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await conv.setContent(`<body style="margin:0"><img src="data:image/${file.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(f).toString("base64")}"></body>`);
  const mineBuf = await conv.screenshot();
  await conv.close();
  await sheet([["REFERENCE", refBuf], ["REASON (AS A PHONE FETCHES IT)", mineBuf]], join(OUT, `compare-${name}.png`));
}
await browser.close();
