// The picture of a page: what a phone draws when a link to it becomes a card.
//
// A page's HTML names `/p/{id}/card.png` as its og:image (src/pages/render.js previewTags), so a
// phone that decides to draw a preview has a picture to put on it. The phone fetches it; Reason
// never attaches it to the link — it did for a few minutes on 2026-10-06 and the result was the
// same picture twice, one bubble above the card (src/deliver.js says why it stopped).
//
// When an image model is connected, each page gets its own illustration — a clean, content-matched
// picture generated from the title and blocks, in the same style every time so the cards feel like a
// set. The title is overlaid in large type (readable even at small sizes) and a small Reason mark
// sits in the corner. When no illustration is available the card is a solid warm brand colour with
// the title, never a blank or broken image.
//
// 1200×630 (≈1.91:1), the size every preview system agrees on. Rendered by the Chromium Playwright
// already ships with, and kept on disk by page id and revision.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { esc, madeFor, topLine } from "./render.js";
import { imageModelFor } from "../imagen.js";

export const CARD_W = 1200;
export const CARD_H = 630;
/** How long a render may take before the link goes out without its picture. */
export const RENDER_TIMEOUT_MS = Number(process.env.REASON_CARD_TIMEOUT_MS || 12_000);

function shortDate(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: config.tz, month: "short", day: "numeric" });
}

// ---- illustration: a picture that matches the page's content ----

const ILLUSTRATION_STYLE = "Style: minimal editorial illustration, warm cream and soft charcoal palette with a single red-orange accent (#ff5a3c). Clean, modern, slightly stylized — not photorealistic. Soft ambient lighting, no text, no logos, no words, no lettering, no people's faces. Muted, sophisticated colour palette leaning warm beige and stone grey. Wide composition with breathing room, suitable as a background behind overlaid text.";

const SENSITIVE_PATTERNS = [
  /\$\s*[\d,.]+/g,                    // dollar amounts
  /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/g,  // phone numbers
  /\d+\s+\w+\s+(st|ave|blvd|rd|dr|ln|ct|way|pl)\b/gi, // street addresses
  /\b\d{5}(-\d{4})?\b/g,             // zip codes
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // emails
];

function sanitizeForPrompt(text) {
  let safe = String(text ?? "");
  for (const p of SENSITIVE_PATTERNS) safe = safe.replace(p, "");
  return safe.replace(/\s+/g, " ").trim();
}

function illustrationPrompt(page) {
  const title = sanitizeForPrompt(page.title);
  const sectionTitles = (page.blocks ?? [])
    .filter(b => b.type === "section" && b.title)
    .map(b => sanitizeForPrompt(b.title))
    .slice(0, 3)
    .join(", ");
  const subject = sectionTitles ? `${title} (covering ${sectionTitles})` : title;
  return `A single clean illustration representing: ${subject}. ${ILLUSTRATION_STYLE}`;
}

export function illustrationPath(pageId) {
  return join(config.dataDir, "cards", `${pageId}-illustration.png`);
}

export async function generateIllustration(page) {
  const provider = imageModelFor();
  if (!provider) return null;
  const prompt = illustrationPrompt(page);
  let out = await provider.generate(prompt, { aspectRatio: "16:9", count: 1 });
  if (!out.ok && config.openaiKey) {
    const { openaiImageProvider } = await import("../imagen.js");
    out = await openaiImageProvider().generate(prompt, { aspectRatio: "16:9", count: 1 });
  }
  if (!out.ok || !out.images?.length) return null;
  const src = out.images[0].path;
  const dest = illustrationPath(page.id);
  mkdirSync(join(config.dataDir, "cards"), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, readFileSync(src));
  renameSync(tmp, dest);
  return dest;
}

// ---- card HTML: two designs, one with illustration, one without ----

export function cardHtml({ title, subtitle = "", forName = "", language = "", when = "", illustration = null }) {
  const t = String(title ?? "").trim();
  const size = t.length > 70 ? 56 : t.length > 40 ? 68 : 84;

  if (illustration) {
    const b64 = readFileSync(illustration).toString("base64");
    return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${CARD_W}px;height:${CARD_H}px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.bg{position:absolute;inset:0;background:url(data:image/png;base64,${b64}) center/cover no-repeat}
.grad{position:absolute;inset:0;background:linear-gradient(to top,rgba(22,19,15,.82) 0%,rgba(22,19,15,.45) 42%,rgba(22,19,15,.12) 70%,transparent 100%)}
.brand{position:absolute;top:32px;left:48px;display:flex;align-items:center;gap:10px;color:rgba(255,255,255,.9);font:500 24px/1 ui-serif,"New York","Iowan Old Style",Georgia,serif}
.dot{width:12px;height:12px;border-radius:50%;background:#ff5a3c}
h1{position:absolute;left:56px;right:56px;bottom:${subtitle ? "96" : "56"}px;color:#fff;font:500 ${size}px/1.12 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.02em;text-wrap:balance;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 2px 12px rgba(0,0,0,.35)}
.sub{position:absolute;left:56px;right:56px;bottom:48px;color:rgba(255,255,255,.78);font-size:28px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
</style></head><body>
<div class="bg"></div>
<div class="grad"></div>
<span class="brand"><span class="dot"></span>Reason</span>
<h1>${esc(t)}</h1>
${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ""}
</body></html>`;
  }

  // Fallback: solid brand card when no illustration is available.
  const whose = topLine(forName, language)?.text ?? madeFor(forName);
  const top = [esc(whose), when ? esc(when) : ""].filter(Boolean).join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:${CARD_W}px;height:${CARD_H}px;overflow:hidden}
body{background:#2c2520;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;position:relative;padding:64px 72px}
.bar{display:flex;align-items:center;gap:14px;font-size:28px;color:rgba(255,255,255,.6)}
.brand{display:flex;align-items:center;gap:12px;color:#fff;font:500 30px/1 ui-serif,"New York","Iowan Old Style",Georgia,serif}
.dot{width:14px;height:14px;border-radius:50%;background:#ff5a3c}
h1{position:absolute;left:72px;right:72px;top:150px;font:400 ${t.length > 70 ? 68 : t.length > 40 ? 84 : 104}px/1.08 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.025em;text-wrap:balance;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sub{position:absolute;left:72px;right:72px;bottom:64px;font-size:34px;line-height:1.3;color:rgba(255,255,255,.6);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rule{position:absolute;left:72px;right:72px;top:126px;height:1px;background:rgba(255,255,255,.15)}
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
export async function shootWithChromium(html, { width = CARD_W, height = CARD_H, type = "png" } = {}) {
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
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    // A photo as JPEG stays well under the size a preview fetcher will take; PNG stays for drawn cards.
    return await page.screenshot({ type, ...(type === "jpeg" ? { quality: 86 } : {}), clip: { x: 0, y: 0, width, height } });
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
 * When an illustration exists for the page (pre-generated or just made), the card uses it as a
 * background with the title overlaid in large type. When none is available, the card is a solid
 * warm dark colour with the title — never blank, never broken.
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

  // Use an existing illustration if one has been pre-generated.
  const ilPath = illustrationPath(page.id);
  const illustration = existsSync(ilPath) ? ilPath : null;

  const html = cardHtml({
    title: page.title, subtitle: page.subtitle ?? "", forName, language,
    when: page.created_at ? shortDate(page.created_at) : "",
    illustration,
  });
  const png = await withTimeout(shoot(html), RENDER_TIMEOUT_MS);
  if (!png?.length) throw new Error("the renderer gave back an empty picture");
  mkdirSync(join(config.dataDir, "cards"), { recursive: true });
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
