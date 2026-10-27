#!/usr/bin/env node
// Drive the desktop Settings section index in headless Chromium over REAL HTTP (src/http.js on a
// loopback port, a made-up owner signed in): the → follows the section in view through all six as
// the page scrolls, a click moves it and scrolls there, the index stays pinned, a #hash opens on its
// section, and on a phone there is no index at all. Run under the cage's env (own database, texting
// credentials blanked):
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/index.db node .agents/skills/verify-reason/bin/web-settings-index-drive.mjs [outDir]
//
// Or against a live install with a session token (no database touched here):
//   REASON_INDEX_URL=https://heyreason.com/web/settings REASON_INDEX_COOKIE='reason_page=…' node …/web-settings-index-drive.mjs [outDir]
//
// Prints one line per step, `ok` or `FAIL`, writes index-*.png to outDir, exits non-zero on any FAIL.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const outDir = process.argv[2] || join(homedir(), "Desktop", "reason-settings-index");
mkdirSync(outDir, { recursive: true });
let URL_ = process.env.REASON_INDEX_URL, COOKIE = process.env.REASON_INDEX_COOKIE, server = null;

if (!URL_) {
  process.env.REASON_WEB = "on";
  process.env.REASON_PAGES_URL ||= "https://files.example.test";
  process.env.REASON_SITE_URL = "http://127.0.0.1";
  process.env.REASON_CONVERSATION = "dm:owner";
  process.env.REASON_OWNER_NUMBER = process.env.REASON_MASTER_NUMBER = "+12025551234";
  process.env.REASON_TOKEN_KEY ||= "44".repeat(32);
  process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
  delete process.env.REASON_SITE_PROXY_SECRET;
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dbp = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = dbp && existsSync(dirname(dbp)) ? realpathSync(dirname(dbp)) + "/" : "";
  if (!dbp || existsSync(dbp) || !["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"].some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory"); process.exit(2);
  }
  for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
    if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
  }
  const root = new URL("../../../../", import.meta.url);
  const imp = (p) => import(new URL(p, root));
  const { Runtime } = await imp("src/runtime.js");
  const { Router } = await imp("src/channels/router.js");
  const { ConsoleChannel } = await imp("src/channels/console.js");
  const { WebChannel } = await imp("src/channels/web.js");
  const { makeDeliver } = await imp("src/deliver.js");
  const { createServer } = await imp("src/http.js");
  const db = await imp("src/db.js");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
  const router = new Router({});
  const cc = new ConsoleChannel({ write: () => {} });
  const runtime = new Runtime({ channels: router, deliver: makeDeliver({ router, consoleChannel: cc, log: () => {}, warn: () => {} }), runTurn: async () => "ok" });
  router.runtime = runtime; router.register(cc); router.register(new WebChannel());
  server = createServer({ router, runtime, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const t = `drive-${Math.random().toString(36).slice(2)}`;
  db.startPageSession("wsign:dm:owner", t, { conversationId: "dm:owner" });
  URL_ = `http://127.0.0.1:${server.address().port}/web/settings`; COOKIE = `reason_page=${t}`;
}

const { chromium } = await import("playwright");
let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const u = new URL(URL_);
const [ck, cv] = COOKIE.split(/=(.*)/s);
const browser = await chromium.launch({ headless: true });
const open = async ({ width = 1440, height = 900, hash = "", reduced = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: reduced ? "reduce" : "no-preference", isMobile: width < 600, hasTouch: width < 600 });
  await ctx.addCookies([{ name: ck, value: cv, domain: u.hostname, path: "/", secure: u.protocol === "https:", httpOnly: true }]);
  await ctx.addInitScript(() => { try { sessionStorage.setItem("reason-web-loaded", "1"); } catch {} });
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", e => errs.push(e.message));
  await page.goto(URL_ + hash, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, errs };
};
const current = (page) => page.evaluate(() => [...document.querySelectorAll('.st-nav a[aria-current="true"]')].map(a => a.getAttribute("href").slice(1)));
const settle = async (page) => { let y = -1; for (let i = 0; i < 40; i++) { const n = await page.evaluate(() => scrollY); if (n === y) return; y = n; await page.waitForTimeout(150); } };

try {
  const { ctx, page, errs } = await open();
  const ids = await page.evaluate(() => [...document.querySelectorAll(".st-nav a")].map(a => a.getAttribute("href").slice(1)));
  step("the index: six sections", ids.length === 6, ids.join(" "));
  step("on load (no hash): → HOW I REACH YOU", JSON.stringify(await current(page)) === '["reach"]');
  await page.screenshot({ path: join(outDir, "index-1-top.png") });
  // Scroll with the wheel, as a reader does, and note each section the → lands on.
  const seen = [];
  for (let i = 0; i < 80; i++) {
    const c = (await current(page))[0];
    if (c && seen.at(-1) !== c) { seen.push(c); await page.screenshot({ path: join(outDir, `index-scroll-${seen.length}-${c}.png`) }); }
    const atEnd = await page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 4);
    if (atEnd && seen.at(-1) === ids.at(-1)) break;
    await page.mouse.move(900, 450); await page.mouse.wheel(0, 120); await page.waitForTimeout(60);
  }
  await settle(page);
  step("scrolling down: → moves through all six, in order", JSON.stringify(seen) === JSON.stringify(ids), seen.join(" → "));
  const side = await page.evaluate(() => { const r = document.querySelector(".st-side").getBoundingClientRect(); return { top: Math.round(r.top), pos: getComputedStyle(document.querySelector(".st-side")).position }; });
  step("the index stays pinned at the bottom of the page", side.pos === "sticky" && side.top >= 0 && side.top <= 40, JSON.stringify(side));
  step("exactly one item current", (await current(page)).length === 1);
  const back = [];
  for (let i = 0; i < 80; i++) { const c = (await current(page))[0]; if (seen.length && back.at(-1) !== c) back.push(c); if (await page.evaluate(() => scrollY === 0)) break; await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
  await settle(page);
  step("scrolling back up: → back on HOW I REACH YOU", (await current(page))[0] === "reach", back.join(" → "));

  // Click: scrolls smoothly to the section and → moves there.
  await page.click('.st-nav a[href="#connected"]');
  await page.waitForTimeout(80); const mid = await page.evaluate(() => scrollY);
  await settle(page);
  const [top, bottom] = await page.evaluate(() => [Math.round(document.getElementById("connected").getBoundingClientRect().top), innerHeight + scrollY >= document.documentElement.scrollHeight - 4]);
  step("click CONNECTED: smooth (mid-way 80ms after), lands there (or as far as the page goes), → CONNECTED", (await current(page))[0] === "connected" && top >= 0 && (top < 120 || bottom) && mid > 0 && mid < await page.evaluate(() => scrollY), `80ms after click scrollY ${mid}; section top ${top}${bottom ? " (page bottom)" : ""}`);
  await page.screenshot({ path: join(outDir, "index-2-click-connected.png") });
  await page.click('.st-nav a[href="#invites"]'); await settle(page);
  step("click INVITES: → INVITES even if the page can't bring it to the top", (await current(page))[0] === "invites");
  step("no script errors", errs.length === 0, errs.join(" | "));
  await ctx.close();

  // The owner's case: reached at #invites, then reading the top.
  const h = await open({ hash: "#invites" });
  await settle(h.page);
  step("#invites on load: → INVITES", (await current(h.page))[0] === "invites");
  await h.page.mouse.move(900, 450);
  for (let i = 0; i < 80 && await h.page.evaluate(() => scrollY > 0); i++) { await h.page.mouse.wheel(0, -200); await h.page.waitForTimeout(40); }
  await settle(h.page);
  step("…then scrolled to the top: → HOW I REACH YOU, not stuck on INVITES", (await current(h.page))[0] === "reach", String(await current(h.page)));
  await h.page.screenshot({ path: join(outDir, "index-3-hash-invites-then-top.png") });
  await h.ctx.close();

  const r = await open({ reduced: true });
  await r.page.click('.st-nav a[href="#theme"]');
  const jumped = await r.page.evaluate(() => Math.round(document.getElementById("theme").getBoundingClientRect().top));
  const bh = await r.page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
  step("reduced motion: no smooth scroll, the click jumps at once; → THEME", bh === "auto" && (await current(r.page))[0] === "theme" && jumped < 900, `scroll-behavior ${bh}`);
  await r.ctx.close();

  const m = await open({ width: 390, height: 844 });
  const vis = await m.page.evaluate(() => { const s = document.querySelector(".st-nav"); return s ? getComputedStyle(s).display !== "none" && s.getBoundingClientRect().height > 0 : false; });
  step("phone (390): no side index drawn, as before", !vis);
  await m.page.screenshot({ path: join(outDir, "index-4-phone.png") });
  await m.ctx.close();
} finally {
  await browser.close();
  server?.close();
}
console.log(`screens in ${outDir}`);
process.exit(fails ? 1 : 0);
