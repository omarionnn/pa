#!/usr/bin/env node
// Draw Reason Web's sign-in pages with made-up data, as PNGs, for looking at before shipping. Nothing
// leaves this machine: a throwaway database in a temp directory, the pages rendered in process from
// src/pages/websignin.js (no server, no row, no text), screenshotted in Chromium. Each page is served
// on a made-up https origin WITH its real headers (CSP and all) and its /web/fonts, so a font the CSP
// would block in production is blocked here too.
//
//   node .agents/skills/verify-reason/bin/web-preview.mjs [outDir] [prefix] [siteIndexHtml]
//        (defaults ~/Desktop, "reason-web-", no site)
//
// Writes <prefix>signin.png (the number form + join block, phone), <prefix>code.png (the code step),
// <prefix>join.png (the join block on a desktop width: QR + number) and <prefix>landing.png (signed
// in). Given the marketing site's index.html (~/Desktop/reason-site-new/public/index.html), also
// <prefix>vs-site.png: the site's hero and the sign-in page side by side at desktop width. The
// number shown is the fake line's, never a real adapter's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const outDir = process.argv[2] || join(homedir(), "Desktop");
const prefix = process.argv[3] || "reason-web-";
const siteIndex = process.argv[4] || null;
const dir = mkdtempSync(join(tmpdir(), "reason-web-preview-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.example.test";
process.env.REASON_WEB = "on";
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) delete process.env[k];

const root = new URL("../../../../", import.meta.url);
const ws = await import(new URL("src/pages/websignin.js", root));
const playwright = await import("playwright");

const LINE = "+16562167455";
const shots = [
  ["signin", ws.renderSignin({ joinNumber: LINE, formToken: "preview" }), 390],
  ["code", ws.renderSignin({ joinNumber: LINE, formToken: "preview", sent: true, number: "+1 (415) 555-9876" }), 390],
  ["join", ws.renderSignin({ joinNumber: LINE, formToken: "preview", sent: true, number: "+1 (646) 555-0101" }), 1100],
  ["landing", ws.renderLanding({ account: { name: "Kofi" }, csrf: "preview" }), 390],
];
const ORIGIN = "https://files.example.test";
/** Serve `html` at ORIGIN/web with the page's real headers, and /web/fonts from the real handler. */
async function serve(ctx, html) {
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const font = /^\/web\/fonts\/([a-z]+)\.woff2$/.exec(path);
    if (font) {
      const out = ws.webFont(font[1]);
      return out ? route.fulfill({ status: 200, headers: Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, String(v)])), body: out.body }) : route.fulfill({ status: 404, body: "" });
    }
    return route.fulfill({ status: 200, headers: { ...ws.SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" }, body: html });
  });
}

const browser = await playwright.chromium.launch({ headless: true });
try {
  for (const [name, html, width] of shots) {
    const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, deviceScaleFactor: 2, colorScheme: "light", isMobile: width < 600, hasTouch: width < 600 });
    await serve(ctx, html);
    const page = await ctx.newPage();
    const blocked = [];
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) blocked.push(m.text()); });
    await page.goto(`${ORIGIN}/web`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (blocked.length) console.log(`CSP blocked on ${name}: ${blocked.join(" | ")}`);
    const path = join(outDir, `${prefix}${name}.png`);
    if (name === "join") {
      // The join block alone, at desktop width: what somebody with no phone to hand sees.
      await page.locator(".w-join").scrollIntoViewIfNeeded();
      await page.locator(".w-join").screenshot({ path });
    } else {
      await page.screenshot({ path, fullPage: true });
    }
    console.log(`wrote ${path}`);
    await ctx.close();
  }
  if (siteIndex) {
    // The site's hero (its real page, its Google fonts) next to Web's sign-in, same width, same height.
    const W = 720, H = 760;
    const grab = async (load) => {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: "light" });
      const page = await ctx.newPage();
      await load(ctx, page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1200); // the site's opening mark fades out
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      await ctx.close();
      return png.toString("base64");
    };
    const site = await grab(async (_c, page) => { await page.goto(pathToFileURL(siteIndex).href, { waitUntil: "networkidle" }); });
    const web = await grab(async (ctx, page) => { await serve(ctx, shots[0][1]); await page.goto(`${ORIGIN}/web`, { waitUntil: "load" }); });
    const ctx = await browser.newContext({ viewport: { width: W * 2 + 72, height: H + 90 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<body style="margin:0;background:#ddd5c7;font:13px/1 'Courier New',monospace;letter-spacing:.14em;text-transform:uppercase;color:#6a6253;display:flex;gap:24px;padding:24px;box-sizing:border-box">`
      + `<figure style="margin:0"><figcaption style="margin:0 0 12px">heyreason.com</figcaption><img src="data:image/png;base64,${site}" width="${W}" height="${H}" style="display:block;border:1px solid #d4c9b5"></figure>`
      + `<figure style="margin:0"><figcaption style="margin:0 0 12px">files.heyreason.com/web</figcaption><img src="data:image/png;base64,${web}" width="${W}" height="${H}" style="display:block;border:1px solid #d4c9b5"></figure></body>`);
    const path = join(outDir, `${prefix}vs-site.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`wrote ${path}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
