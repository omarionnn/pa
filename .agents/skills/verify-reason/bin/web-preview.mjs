#!/usr/bin/env node
// Draw every Reason Web screen with made-up data, as PNGs, beside the owner's design reference pages.
// Nothing leaves this machine: a throwaway database in a temp directory, the pages rendered in process
// from src/pages/websignin.js + webconvo.js (no server, no text sent), screenshotted in Chromium. Each
// page is served on a made-up https origin WITH its real headers (CSP and all) and its /web/fonts, so a
// font or script the CSP would block in production is blocked here too (reported on the console).
//
//   node .agents/skills/verify-reason/bin/web-preview.mjs [outDir] [referenceDir]
//        (defaults ~/Desktop/reason-web-design-previews, ~/Desktop/reason-web-handoff-2026-10-26/reference)
//
// Writes <screen>-<390|1280>-<paper|night>.png for every screen, and compare-<screen>.png: ours beside
// the matching reference page (Paper on top, Night under), each at the same width. The thread is a
// fictional one (Kofi, a weekend away); the number shown is the fake line's, never a real adapter's.
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outDir = process.argv[2] || join(homedir(), "Desktop", "reason-web-design-previews");
const refDir = process.argv[3] || join(homedir(), "Desktop", "Project files", "Reason", "handoffs", "reason-web-handoff-2026-10-26", "reference");
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "reason-web-preview-"));
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: join(dir, "data"), REASON_OWNER_NAME: "Kofi", REASON_TZ: "America/New_York",
  REASON_CONVERSATION: "dm:owner", REASON_MASTER_NUMBER: "+12025551234", REASON_PAGES_URL: "https://files.heyreason.com",
  REASON_EVENTS_URL: "https://events.heyreason.com", REASON_PUBLIC_URL: "https://reason.example.test", REASON_SITE_URL: "https://heyreason.com", REASON_WEB: "on",
});
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) delete process.env[k];

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const ws = await imp("src/pages/websignin.js");
const wc = await imp("src/pages/webconvo.js");
const db = await imp("src/db.js");
const { chromium } = await import("playwright");

const LINE = "+16562167455";
const CONV = "dm:owner";
db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+12025551234", name: "Kofi Mensah", isOperator: true });
db.db.prepare("INSERT INTO pages (id, conversation_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("wknd3up", CONV, "Three weekends upstate", "[]", Date.now(), Date.now());

// A fictional thread: yesterday on iMessage (a photo, a voice note), today continued on Web.
const now = Date.now();
const day = 864e5;
const at = (d, h, m) => { const x = new Date(now - d * day); x.setHours(h, m, 0, 0); return x.getTime(); };
let id = 0;
const row = (role, channel, text, when, media = []) => ({ id: ++id, role, channel, text, media, at: when, external_id: null });
const rows = [
  row("user", "fake", "Something like this, but closer.", at(1, 9, 12), [{ mimeType: "image/jpeg", filename: "IMG_2041.JPG" }]),
  row("user", "fake", "under three hours, and keep it under six hundred", at(1, 9, 14), [{ mimeType: "audio/x-caf", filename: "Audio Message.caf" }]),
  row("assistant", "fake", "Got it. I'll pull a short list and keep it here for when you're ready.", at(1, 9, 15)),
  row("user", "web", "Show me the short list.", at(0, 14, 50)),
  row("assistant", "web", "Three that fit. I put them side by side so you can compare:\n1. Farmhouse inn near Hudson, wood stove — $540\n2. Cabin on Lake Waramaug, dock and canoes — $480\n3. Small hotel in Woodstock, fireplace lounge — $590\nhttps://files.heyreason.com/wknd3up", at(0, 14, 53)),
  row("user", "web", "Yes, check the 14th for all three.", at(0, 14, 55)),
];
const lines = rows.map(r => wc.rowOut(r, { conversationId: CONV, service: "iMessage" }));
const account = db.getAccount(CONV);
const items = [
  { kind: "task", title: "A cabin for Nov 14–16", status: "WORKING", words: "checking the 14th now" },
  { kind: "timer", title: "Call home", status: "REMINDER", when: "Sun 6:00 PM" },
];
const pick = `<a class="pick" href="/web?thread" aria-label="Pick up from iMessage: continue the thread"><span class="pick-h"><span class="hand">pick up from iMessage</span><span class="dash" aria-hidden="true"></span><span class="lbl">LAST TEXT · 1:22 PM</span></span><span class="pick-q"><span class="y">Under 3 hours. Keep it under $600.</span><span class="r">Got it. I'll pull a short list and keep it here for when you're ready.</span></span><span class="pick-go">Continue the thread <span aria-hidden="true">→</span></span><span class="pick-n">Same Reason, same thread. What you send here stays on Web.</span></a>`;

// [name, html, setup(page) | null, reference phone [file, panelIndex|null] | null, reference desktop file | null]
const S = [
  ["signin", ws.renderSignin({ joinNumber: LINE, formToken: "p" }), null, ["sheet-signed-out", 0], "desk-sign-in"],
  ["signed-out", ws.renderSignin({ joinNumber: LINE, formToken: "p", out: true }), null, ["sheet-signed-out", 5], "desk-sign-in"],
  ["code", ws.renderCode({ number: "(415) 555-0142", joinNumber: LINE, formToken: "p" }), async (p) => { await p.fill("#code", "481"); }, ["sheet-signed-out", 1], "desk-code"],
  ["code-wrong", ws.renderCode({ number: "(415) 555-0142", joinNumber: LINE, formToken: "p", error: { kind: "wrong" } }), async (p) => { await p.evaluate(() => { document.querySelector("#code").form.dataset.sent = "1"; }); await p.fill("#code", "481092"); await p.locator("#code").blur(); }, ["sheet-signed-out", 1], "desk-code"],
  ["code-expired", ws.renderCode({ number: "(415) 555-0142", formToken: "p", error: { kind: "expired" } }), null, ["sheet-signed-out", 2], null],
  ["code-tries", ws.renderCode({ number: "(415) 555-0142", formToken: "p", error: { kind: "tries", waitMs: 299_000 } }), null, ["sheet-signed-out", 2], null],
  ["code-resend", ws.renderCode({ number: "(415) 555-0142", formToken: "p", error: { kind: "resend", leftMs: 600_000 } }), null, ["sheet-signed-out", 2], null],
  ["join", ws.renderJoin({ joinNumber: LINE }), null, ["sheet-signed-out", 3], null],
  ["line-not-connected", ws.renderJoin({ joinNumber: null }), null, ["sheet-signed-out", 4], null],
  ["conversation", wc.renderConversation({ account, csrf: "p", lines, more: true, sendId: "00000000-0000-0000-0000-000000000000", items, approvals: [{ title: "Hold the Hudson inn, $540", money: false }] }),
    async (p) => { await p.evaluate(() => { document.querySelector(".onit").hidden = false; }); await p.fill("#c-input", "Book it. And ask if they take dogs."); await p.locator("#c-input").blur(); },
    ["mobile-chat", null], "desk-chat"],
  ["first-visit", wc.renderFirstVisit({ account }), null, ["sheet-states", 2], null],
  ["home-new", wc.renderHome({ account, csrf: "p", sendId: "x", items: [], pick }), null, null, "desk-welcome"],
  ["home-in-hand", wc.renderHome({ account, csrf: "p", sendId: "x", items, pick }), null, null, "arrival"],
  ["ongoing-empty", wc.renderOngoing({ csrf: "p", items: [] }), null, ["ongoing-empty", null], null],
  ["error", wc.renderError(), null, ["sheet-global", 1], null],
  ["offline", wc.renderConversation({ account, csrf: "p", lines: lines.slice(3), more: false, sendId: "x", items: [] }),
    async (p, ctx) => { await ctx.setOffline(true); await p.fill("#c-input", "Remind me to call the vet at 4."); await p.press("#c-input", "Enter"); await p.waitForTimeout(150); },
    ["sheet-global", 2], null],
  ["menu", wc.renderConversation({ account, csrf: "p", lines: lines.slice(3), more: false, sendId: "x", items: [] }), async (p) => { if (await p.locator(".menu-b").isVisible()) await p.click(".menu-b"); }, null, null],
  ["settings-soon", wc.soonPage({ which: "settings", account, headers: {} }), null, null, "desk-settings"],
];
const ORIGIN = "https://heyreason.com";

async function serve(ctx, html) {
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const font = /^\/web\/fonts\/([a-z]+)\.woff2$/.exec(path);
    if (font) {
      const out = ws.webFont(font[1]);
      return out ? route.fulfill({ status: 200, headers: Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, String(v)])), body: out.body }) : route.fulfill({ status: 404, body: "" });
    }
    if (path === "/web") return route.fulfill({ status: 200, headers: { ...ws.SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" }, body: html });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
}

const browser = await chromium.launch({ headless: true });
const shots = {}; // name → { "390-paper": base64, ... }
try {
  for (const [name, html, setup] of S) {
    shots[name] = {};
    for (const width of [390, 1280]) {
      for (const theme of ["paper", "night"]) {
        const mobile = width < 600;
        const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: theme === "night" ? "dark" : "light", isMobile: mobile, hasTouch: mobile });
        await ctx.addInitScript(() => { try { sessionStorage.setItem("reason-web-loaded", "1"); } catch {} });
        await serve(ctx, html);
        const page = await ctx.newPage();
        const blocked = [];
        page.on("console", (m) => { if (/Content Security Policy|Refused/i.test(m.text())) blocked.push(m.text()); });
        page.on("pageerror", (e) => blocked.push(`pageerror: ${e.message}`));
        await page.goto(`${ORIGIN}/web`, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        if (setup) await setup(page, ctx);
        if (!mobile) await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(80);
        if (blocked.length) console.log(`! ${name} ${width} ${theme}: ${[...new Set(blocked)].join(" | ")}`);
        const png = await page.screenshot({ path: join(outDir, `${name}-${width}-${theme}.png`), fullPage: !mobile });
        shots[name][`${width}-${theme}`] = png.toString("base64");
        await ctx.close();
      }
    }
  }
  console.log(`wrote ${S.length * 4} screens to ${outDir}`);

  // The reference beside ours: a phone panel off a sheet (or a whole phone page), and the desktop page.
  const refShot = async (file, panel, width, theme) => {
    const f = join(refDir, `${file}-${theme}.html`);
    if (!existsSync(f)) return null;
    const ctx = await browser.newContext({ viewport: { width: panel == null ? width : 2800, height: panel == null && width < 600 ? 844 : 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(f).href, { waitUntil: "networkidle" }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    let png;
    if (panel != null) png = await page.locator('div[style*="height: 844px"], div[style*="height: 700px"]').nth(panel).screenshot();
    else if (width < 600) png = await page.screenshot();
    else png = await page.screenshot({ fullPage: true });
    await ctx.close();
    return png.toString("base64");
  };
  for (const [name, , , mob, desk] of S) {
    if (!mob && !desk) continue;
    const rowsOut = [];
    for (const theme of ["paper", "night"]) {
      const cols = [];
      if (mob) cols.push({ cap: `ours · 390 · ${theme}`, img: shots[name][`390-${theme}`], w: 390 }, { cap: `reference · ${mob[0]}${mob[1] != null ? ` #${mob[1] + 1}` : ""} · ${theme}`, img: await refShot(mob[0], mob[1], 390, theme), w: 390 });
      if (desk) cols.push({ cap: `ours · 1280 · ${theme}`, img: shots[name][`1280-${theme}`], w: 640 }, { cap: `reference · ${desk} · ${theme}`, img: await refShot(desk, null, 1280, theme), w: 640 });
      rowsOut.push(`<div style="display:flex;gap:20px;align-items:flex-start">${cols.map(c => `<figure style="margin:0;width:${c.w}px"><figcaption style="margin:0 0 8px">${c.cap}</figcaption>${c.img ? `<img src="data:image/png;base64,${c.img}" style="display:block;width:${c.w}px;border:1px solid #9a917f">` : "<p>missing</p>"}</figure>`).join("")}</div>`);
    }
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<body style="margin:0;background:#cfc6b6;font:12px/1 'Courier New',monospace;letter-spacing:.12em;text-transform:uppercase;color:#3b352d;padding:20px;display:inline-flex;flex-direction:column;gap:28px">${rowsOut.join("")}</body>`);
    await page.waitForTimeout(150);
    const box = await page.evaluate(() => ({ w: document.body.scrollWidth }));
    await page.setViewportSize({ width: Math.min(box.w + 40, 6000), height: 900 });
    await page.screenshot({ path: join(outDir, `compare-${name}.png`), fullPage: true });
    await ctx.close();
  }
  console.log("wrote compare-*.png");
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
