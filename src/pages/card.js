// The picture of a page: what a phone draws when a link to it becomes a card.
//
// A page's HTML names `/p/{id}/card.png` as its og:image (src/pages/render.js previewTags), so a
// phone that decides to draw a preview has a picture to put on it. Until 2026-10-06 the tags had a
// title and no picture, and a card with no picture is a grey box. The phone fetches it; Reason
// never attaches it to the link — it did for a few minutes on 2026-10-06 and the result was the
// same picture twice, one bubble above the card (src/deliver.js says why it stopped).
//
// It is the page's own words — title, subtitle, who it was made for, when — set in the page's own
// palette, 1200×630, which is the size every preview system agrees on. Rendered by the Chromium
// Playwright already ships with (the browser tools use the same one), and kept on disk under the
// data directory by page id and revision, so a page is drawn once per change rather than once per
// text. On a machine with no Chromium nothing here pretends: the caller sends the link bare and the
// HTML simply has no picture, which is exactly what it had before.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { esc, madeFor, topLine } from "./render.js";

export const CARD_W = 1200;
export const CARD_H = 630;
/** How long a render may take before the link goes out without its picture. */
export const RENDER_TIMEOUT_MS = Number(process.env.REASON_CARD_TIMEOUT_MS || 12_000);

function shortDate(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: config.tz, month: "short", day: "numeric" });
}

/**
 * The markup. System serif for the title, the same cream and ink as the page, nothing fetched from
 * anywhere. The title scales down as it gets longer and stops at three lines; a title that long is
 * cut with an ellipsis rather than spilling off the picture.
 */
export function cardHtml({ title, subtitle = "", forName = "", language = "", when = "" }) {
  const t = String(title ?? "").trim();
  const size = t.length > 70 ? 68 : t.length > 40 ? 84 : 104;
  // The picture says what the page says: the line in their language when they have one.
  const whose = topLine(forName, language)?.text ?? madeFor(forName);
  const top = [esc(whose), when ? esc(when) : ""].filter(Boolean).join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${CARD_W}px;height:${CARD_H}px;overflow:hidden}
body{background:#faf7f2;color:#16130f;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;position:relative;padding:64px 72px}
.bar{display:flex;align-items:center;gap:14px;font-size:28px;color:#6f675d}
.brand{display:flex;align-items:center;gap:12px;color:#16130f;font:500 30px/1 ui-serif,"New York","Iowan Old Style",Georgia,serif}
.dot{width:14px;height:14px;border-radius:50%;background:#ff5a3c}
h1{position:absolute;left:72px;right:72px;top:150px;font:400 ${size}px/1.08 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.025em;text-wrap:balance;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sub{position:absolute;left:72px;right:72px;bottom:64px;font-size:34px;line-height:1.3;color:#6f675d;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rule{position:absolute;left:72px;right:72px;top:126px;height:1px;background:#e7e0d6}
</style></head><body>
<div class="bar"><span class="brand"><span class="dot"></span>Reason</span>${top ? `<span>· ${top}</span>` : ""}</div>
<div class="rule"></div>
<h1>${esc(t)}</h1>
${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ""}
</body></html>`;
}

/** Where this page's picture is kept. Revision in the name, so a change is a new picture. */
export function cardPath(page) {
  return join(config.dataDir, "cards", `${page.id}-r${page.revision ?? 1}.png`);
}

export class NoCardRenderer extends Error {}

/**
 * One screenshot of one HTML string, by Chromium. Launched fresh each time and closed after:
 * a page is drawn once per change, so a browser kept warm for it would mostly be a browser kept
 * warm for nothing.
 */
export async function shootWithChromium(html) {
  let playwright;
  try { playwright = await import("playwright"); }
  catch { throw new NoCardRenderer("Playwright is not installed, so no page picture can be drawn."); }
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    if (/Executable doesn't exist|browserType.launch/i.test(e?.message ?? "")) {
      throw new NoCardRenderer("Chromium is not downloaded on this machine, so no page picture can be drawn.");
    }
    throw e;
  }
  try {
    const page = await browser.newPage({ viewport: { width: CARD_W, height: CARD_H }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: CARD_W, height: CARD_H } });
  } finally {
    await browser.close().catch(() => {});
  }
}

function withTimeout(promise, ms) {
  let t;
  const clock = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`drawing the page picture took longer than ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, clock]).finally(() => clearTimeout(t));
}

/**
 * The picture for one page: drawn if it is not on disk yet, read if it is.
 *
 * `shoot` is injectable so the rest of the pipeline is provable without a browser. Throws when it
 * cannot be made; callers decide what "no picture" means for them (a bare link, a page with no
 * og:image), and none of them should ever let it stop the link.
 *
 * @returns {Promise<{file: string, bytes: number, fresh: boolean}>}
 */
export async function pageCard(page, { forName = "", language = "", shoot = shootWithChromium } = {}) {
  const file = cardPath(page);
  if (existsSync(file)) {
    const bytes = readFileSync(file).length;
    if (bytes) return { file, bytes, fresh: false };
  }
  const html = cardHtml({
    title: page.title, subtitle: page.subtitle ?? "", forName, language,
    when: page.created_at ? shortDate(page.created_at) : "",
  });
  const png = await withTimeout(shoot(html), RENDER_TIMEOUT_MS);
  if (!png?.length) throw new Error("the renderer gave back an empty picture");
  mkdirSync(join(config.dataDir, "cards"), { recursive: true });
  // Written beside and renamed over: a reader that arrives mid-write sees the old file or none,
  // never half a PNG.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, png);
  renameSync(tmp, file);
  return { file, bytes: png.length, fresh: true };
}

/** A filename a phone can show: the title, lower-cased and hyphenated, with the picture's suffix. */
export function cardFilename(page) {
  const slug = String(page.title ?? "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
  return `${slug}.png`;
}
