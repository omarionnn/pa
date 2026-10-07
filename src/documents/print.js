// The PDF: a page, printed.
//
// There is deliberately no third renderer here. A .docx has to be written as Word objects and a
// .pptx as slides, but a PDF is a thing with a layout — and Reason already has a layout, in
// src/pages/render.js, that has been argued over, measured in Chromium at 390×844, and put next to
// a competitor's. Printing that is how a PDF comes out looking like Reason and stays looking like
// Reason when the page look changes, instead of drifting into a second house style nobody maintains.
// It is also the one path that carries a picture: the PDF is rendered by a real browser, so an
// image block on it is the actual image, which is why checkDocument allows one here and refuses it
// for the other two.
//
// Chromium is the one Playwright already ships with — the same import, the same failure, and the
// same honest refusal as the page-picture renderer in src/pages/card.js. On a machine where it was
// never downloaded nothing pretends: NoPrinter comes back and the tool says so in words.
import { renderPage } from "../pages/render.js";

/** How long a print may take before it is given up on. A document is a page, not a site. */
export const PRINT_TIMEOUT_MS = Number(process.env.REASON_PRINT_TIMEOUT_MS || 20_000);

export class NoPrinter extends Error {}

/** The HTML a document is printed from: the page renderer, in printing mode. */
export function printableHtml({ title, subtitle = null, closing = null, blocks = [], forName = "", at = null }) {
  const when = at ?? Date.now();
  return renderPage({
    // A page row's shape, built here rather than stored: `renderPage` reads exactly these fields,
    // and a document has no id, no key and no revision because it has no link to be opened by.
    id: "", title, subtitle, closing, blocks, shared: false, revision: 1, created_at: when, updated_at: when,
  }, { interactive: false, printing: true, forName });
}

/**
 * One PDF of one HTML string, by Chromium. Launched fresh and closed after, exactly as the page
 * picture is: a document is printed once, so a browser kept warm for it would be a browser kept
 * warm for nothing.
 */
export async function printWithChromium(html) {
  let playwright;
  try { playwright = await import("playwright"); }
  catch { throw new NoPrinter("Playwright is not installed on this machine, so nothing can be printed to a PDF."); }
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/i.test(e?.message ?? "")) {
      throw new NoPrinter("Chromium is not downloaded on this machine, so nothing can be printed to a PDF. Run: npx playwright install chromium");
    }
    throw e;
  }
  try {
    // A phone-width viewport, because the page's own layout is phone-first and the measured one;
    // the paper size is what decides how the PDF reads, and A4 is the size that prints everywhere.
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.setContent(html, { waitUntil: "load" });
    // The page follows the phone's light or dark setting. A PDF has no setting, and a dark PDF is
    // a document that empties somebody's printer, so it is printed light on purpose.
    await page.emulateMedia({ colorScheme: "light", media: "print" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "16mm", left: "12mm", right: "12mm" },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`printing took longer than ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/**
 * One document, as PDF bytes.
 *
 * `print` is injectable so everything around it — the content check, the row, the send, the
 * delete — is provable with no browser on the machine at all.
 *
 * @returns {Promise<Buffer>}
 */
export async function renderPdf({ title, subtitle = null, closing = null, blocks = [], forName = "", at = null }, { print = printWithChromium } = {}) {
  const html = printableHtml({ title, subtitle, closing, blocks, forName, at });
  const pdf = await withTimeout(print(html), PRINT_TIMEOUT_MS);
  const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf ?? []);
  if (!bytes.length) throw new Error("the printer gave back an empty PDF");
  // What a PDF starts with. Checked because an empty-ish file that is not a PDF would otherwise be
  // filed, hashed and attached as one — the same lesson as the 111 bytes of JSON filed as a .wav.
  if (bytes.toString("latin1", 0, 5) !== "%PDF-") {
    throw new Error("what came back is not a PDF");
  }
  return bytes;
}
