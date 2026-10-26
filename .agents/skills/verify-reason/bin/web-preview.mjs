#!/usr/bin/env node
// Draw Reason Web's sign-in pages with made-up data, as PNGs, for looking at before shipping. Nothing
// leaves this machine: a throwaway database in a temp directory, the pages rendered in process from
// src/pages/websignin.js (no server, no row, no text), screenshotted at phone width in Chromium.
//
//   node .agents/skills/verify-reason/bin/web-preview.mjs [outDir]     (default ~/Desktop)
//
// Writes reason-web-signin-phone.png (the number form + join block), reason-web-signin-code.png (the
// code step), reason-web-join.png (the join block on a desktop width: QR + number) and
// reason-web-landing.png (signed in). The number shown is the fake line's, never a real adapter's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const outDir = process.argv[2] || join(homedir(), "Desktop");
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
  ["reason-web-signin-phone.png", ws.renderSignin({ joinNumber: LINE, formToken: "preview" }), 390],
  ["reason-web-signin-code.png", ws.renderSignin({ joinNumber: LINE, formToken: "preview", sent: true, number: "+1 (415) 555-9876" }), 390],
  ["reason-web-join.png", ws.renderSignin({ joinNumber: LINE, formToken: "preview", sent: true, number: "+1 (646) 555-0101" }), 1100],
  ["reason-web-landing.png", ws.renderLanding({ account: { name: "Kofi" }, csrf: "preview" }), 390],
];

const browser = await playwright.chromium.launch({ headless: true });
try {
  for (const [name, html, width] of shots) {
    const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, deviceScaleFactor: 2, colorScheme: "light", isMobile: width < 600, hasTouch: width < 600 });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const path = join(outDir, name);
    if (name === "reason-web-join.png") {
      // The join block alone, at desktop width: what somebody with no phone to hand sees.
      await page.locator(".w-join").scrollIntoViewIfNeeded();
      await page.locator(".w-join").screenshot({ path });
    } else {
      await page.screenshot({ path, fullPage: true });
    }
    console.log(`wrote ${path}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
