#!/usr/bin/env node
// Draw Reason Web's conversation (W2) with made-up lines, as PNGs, for looking at before shipping.
// Nothing leaves this machine: a throwaway database, the page rendered in process from
// src/pages/webconvo.js, served on a made-up https origin WITH its real headers (CSP and all) and
// /web/fonts, screenshotted in Chromium with the page's own script running. The stream and history
// calls the script makes are answered empty, then the page is put in the "Reason is working on it"
// state the way a live `typing` event would.
//
//   node .agents/skills/verify-reason/bin/web-convo-preview.mjs [outDir] [prefix]
//        (defaults ~/Desktop, "reason-web-convo-") → <prefix>mobile.png (390 wide), <prefix>desktop.png (1280)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const outDir = process.argv[2] || join(homedir(), "Desktop");
const prefix = process.argv[3] || "reason-web-convo-";
const dir = mkdtempSync(join(tmpdir(), "reason-web-convo-preview-"));
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
const convo = await import(new URL("src/pages/webconvo.js", root));
const playwright = await import("playwright");

// Fictional: a weekend away, started by text yesterday, carried on at a laptop this morning.
const now = Date.now(), M = 60_000;
const yesterday = now - 26 * 60 * M;
const today = now - 25 * M;
const sample = [
  ["user", "iMessage", false, yesterday, "Can you find somewhere quiet for a weekend away in November? Somewhere I can drive to."],
  ["assistant", "iMessage", false, yesterday + 1 * M, "Happy to. Roughly how far would you drive, and what's the budget for two nights?"],
  ["user", "iMessage", false, yesterday + 4 * M, "Under 3 hours. Keep it under $600."],
  ["assistant", "iMessage", false, yesterday + 5 * M, "Got it. I'll pull a short list and keep it here for when you're ready."],
  ["user", "Web", true, today, "Looking at this on my laptop now. A fireplace would be a bonus."],
  ["assistant", "Web", true, today + 1 * M, "Three that fit:\n\n• A farmhouse inn near Hudson, $540, wood stove in the room\n• A cabin on Lake Waramaug, $480, dock and canoes\n• A small hotel in Woodstock, $590, fireplace lounge\n\nWant me to check the Nov 14–16 weekend for all three?"],
  ["user", "Web", true, today + 3 * M, "Yes, check the 14th for all three."],
].map(([role, source, web, at, text], i) => ({ id: i + 1, role, source, web, at, text, files: [], cid: null }));
const html = convo.renderConversation({ account: { name: "Ama" }, csrf: "preview", lines: sample, more: true, firstVisit: true, sendId: "00000000-0000-4000-8000-000000000000", now });

const ORIGIN = "https://heyreason.example.test";
async function serve(ctx) {
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const font = /^\/web\/fonts\/([a-z]+)\.woff2$/.exec(path);
    if (font) {
      const out = ws.webFont(font[1]);
      return out ? route.fulfill({ status: 200, headers: Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, String(v)])), body: out.body }) : route.fulfill({ status: 404, body: "" });
    }
    if (path === "/web/stream") return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "retry: 600000\n\n" });
    if (path === "/web/history") return route.fulfill({ status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [], more: true }) });
    return route.fulfill({ status: 200, headers: { ...ws.SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" }, body: html });
  });
}

const browser = await playwright.chromium.launch({ headless: true });
try {
  for (const [name, width, height] of [["mobile", 390, 844], ["desktop", 1280, 900]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: "light", isMobile: width < 600, hasTouch: width < 600 });
    await serve(ctx);
    const page = await ctx.newPage();
    const blocked = [];
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) blocked.push(m.text()); });
    page.on("pageerror", (e) => blocked.push(`script error: ${e.message}`));
    await page.goto(`${ORIGIN}/web`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    // The live state: Reason picked up the last message and is working on it.
    await page.evaluate(() => { document.querySelector(".c-typing").hidden = false; });
    if (blocked.length) console.log(`problems on ${name}: ${blocked.join(" | ")}`);
    const path = join(outDir, `${prefix}${name}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`wrote ${path}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
