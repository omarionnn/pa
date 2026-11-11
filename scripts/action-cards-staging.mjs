#!/usr/bin/env node
// Action Cards STAGING: the note in every state (src/pages/actioncards.js), drawn by the real current
// code from a throwaway database with the three sample cards (scripts/action-cards-seed.js), for a look
// before anything ships. Nothing here reads the live database, .env, or any real person.
//
//   node scripts/action-cards-staging.mjs                 → dist/action-cards-staging/ (static copy of every state)
//   node scripts/action-cards-staging.mjs --deploy        → also on https://action-cards--reason-web-staging.netlify.app
//   node scripts/action-cards-staging.mjs --shots=DIR     → real local server + real Chromium at 390 wide: a PNG per state
//                                                            (and the 1200-wide desktop, and the 1200×630 link card) into DIR
//
// The static copy keeps the page's own script, so press-and-hold, dismiss (pen line, fade, renumber) and
// tap all work on it; its posts go nowhere, so a reload shows the first state again. The shots come from
// a real server (the same request functions src/http.js calls), so dismiss persists there.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const outDir = new URL("dist/action-cards-staging/", root).pathname;
const deploy = process.argv.includes("--deploy");
const shotsDir = process.argv.find(a => a.startsWith("--shots="))?.slice(8) || "";
const SITE = process.env.REASON_STAGING_SITE || "c749fa22-03a3-4a51-9b80-1081b789fede";

const dir = mkdtempSync(join(tmpdir(), "reason-action-cards-staging-"));
for (const k of Object.keys(process.env)) if (/^(SENDBLUE|LINQ|ANTHROPIC|AGENTCARD|OPENAI|GEMINI|TWILIO|BLAND|CROSSMINT)_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  TZ: "America/New_York", REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: join(dir, "data"), REASON_OWNER_NAME: "Ama",
  REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:staging", REASON_MASTER_NUMBER: "+15550100100", REASON_SITE_URL: "https://heyreason.com",
  REASON_PUBLIC_URL: "https://reason.example.test", REASON_WEB: "on", REASON_ACTION_CARDS: "on", REASON_TOKEN_KEY: "47".repeat(32),
  SENDBLUE_FROM_NUMBER: "+1 (656) 216-7455",
});
const imp = (p) => import(new URL(p, root));
const cards = await imp("src/actioncards.js");
const page = await imp("src/pages/actioncards.js");
const { webFont } = await imp("src/pages/webkit.js");
const { seed } = await imp("scripts/action-cards-seed.js");
const db = await imp("src/db.js");

const C = "dm:staging";
db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+15550100100", name: "Ama" });
const NOW = Date.parse("2026-11-11T12:30:00-05:00");

// One digest per state, so each page is drawn from real rows in that state.
const fresh = seed(C);
const lifted = seed(C);
const struck = seed(C);
const renumbered = seed(C); cards.dismiss(renumbered.id, renumbered.cards[2].code, { now: NOW });
const done = seed(C); cards.markDone(done.cards[0].id, C, { now: NOW });
const gone = seed(C, { ttlMs: 1 });

const req = (path, method = "GET") => page.actionCardsRequest({ method, path, now: NOW });
/** The page with a state its own script would otherwise reach by hand: a lifted card, a mid-strike card. */
const withClass = (html, n, cls) => { let i = 0; return html.replace(/<li class="card/g, (m) => (++i === n ? `<li class="card ${cls}` : m)); };

const STATES = [
  { id: "B-cards-page", title: "B · the cards page", digest: fresh, html: async () => (await req(`/a/${fresh.token}`)).body },
  { id: "C-long-press", title: "C · press-and-hold · card 2 lifts", digest: lifted, html: async () => withClass((await req(`/a/${lifted.token}`)).body, 2, "lift") },
  { id: "D-dismiss", title: "D · dismiss · card 3 mid-strike", digest: struck, html: async () => withClass((await req(`/a/${struck.token}`)).body, 3, "struck") },
  { id: "D2-renumbered", title: "D2 · after the dismiss · renumbered 01 / 02", digest: renumbered, html: async () => (await req(`/a/${renumbered.token}`)).body },
  { id: "F-done", title: "F · card 1 done · sinks below · 2 OPEN", digest: done, html: async () => (await req(`/a/${done.token}`)).body },
  { id: "H-gone", title: "H · a spent link · the gone page", digest: gone, html: async () => (await req(`/a/${gone.token}`)).body },
];

// ---------------------------------------------------------------- the static copy
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "web/fonts"), { recursive: true });
mkdirSync(join(outDir, "web/og/a"), { recursive: true });
for (const f of ["serif", "roman", "hand", "handbold", "sans"]) writeFileSync(join(outDir, `web/fonts/${f}.woff2`), webFont(f).body);
const pages = [];
for (const s of STATES) {
  const html = (await s.html()).replace(/<meta name="robots"[^>]*>/, `<meta name="robots" content="noindex,nofollow,noarchive"><!-- STAGING · sample data -->`);
  writeFileSync(join(outDir, `${s.id}.html`), html);
  pages.push(s);
}
// The link card, drawn for real (needs Chromium; the generic card stands in without it).
const og = await page.actionCardsPng(fresh, { now: NOW });
writeFileSync(join(outDir, "og-preview.png"), og.bytes);
writeFileSync(join(outDir, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Action Cards · staging</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#ede5d8;color:#2a2520;padding:28px;max-width:720px;margin:0 auto}a{color:#9c3b2e}h1{font-weight:400;font-style:italic;font-family:Georgia,serif;font-size:34px;margin:0 0 6px}.eb{font-family:"Courier New",monospace;font-size:12px;letter-spacing:.14em;color:#6a6253}li{margin:8px 0}img{display:block;width:100%;max-width:600px;border:1px solid #d4c9b5;margin-top:24px}</style>
<p class="eb">ACTION CARDS · STAGING · SAMPLE DATA · ${new Date().toISOString().slice(0, 10)}</p><h1>Once a day, a short note and a page of one-tap offers.</h1>
<p>Every state the page has, drawn by the real code with the three sample cards. Press and hold a card to lift it; Dismiss strikes it out and the rest renumber (the post goes nowhere here, so a reload resets). A tap opens Messages on a phone.</p>
<ol>${pages.map(s => `<li><a href="${s.id}.html">${s.title}</a></li>`).join("")}</ol>
<p class="eb">THE LINK CARD · 1200×630 · og:title “Ready for you”</p><img src="og-preview.png" alt="">`);
console.log(`wrote ${outDir} (${pages.length} pages + og-preview.png${og.fallback ? " — generic, no Chromium" : ""})`);

// ---------------------------------------------------------------- real server + real browser shots
if (shotsDir) {
  mkdirSync(shotsDir, { recursive: true });
  const server = createServer(async (rq, rs) => {
    const url = new URL(rq.url, "http://localhost");
    try {
      const font = /^\/web\/fonts\/([a-z]+)\.woff2$/.exec(url.pathname);
      if (font) { const f = webFont(font[1]); if (f) { rs.writeHead(f.status, f.headers); return rs.end(f.body); } }
      if (url.pathname.startsWith("/web/og/a/")) { const o = await page.actionCardsOgRequest(url.pathname, { now: NOW }); if (o) { rs.writeHead(o.status, o.headers); return rs.end(o.body); } }
      if (url.pathname === "/a" || url.pathname.startsWith("/a/")) { const o = await page.actionCardsRequest({ method: rq.method, path: url.pathname, now: NOW }); rs.writeHead(o.status, o.headers); return rs.end(o.body); }
      rs.writeHead(404); rs.end("not found");
    } catch (e) { rs.writeHead(500); rs.end(String(e?.stack ?? e)); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  const p = await ctx.newPage();
  const ready = async () => { await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(120); };
  const shot = (name) => p.screenshot({ path: join(shotsDir, `${name}.png`) });
  const timings = {};
  const open = async (token) => { const t0 = Date.now(); const r = await p.goto(`${base}/a/${token}`, { waitUntil: "load" }); await ready(); timings[token] = Date.now() - t0; return r; };

  // B: the page as it loads.
  await open(fresh.token); await shot("B-cards-page");
  // C: press and hold card 2, for real.
  await open(lifted.token);
  const second = p.locator("#cards .card").nth(1); const b = await second.boundingBox();
  await p.mouse.move(b.x + 80, b.y + 30); await p.mouse.down(); await p.waitForTimeout(600); await p.mouse.up(); await p.waitForTimeout(150);
  await shot("C-long-press");
  // D: Dismiss card 3 from its lifted state, caught mid-strike; then after it is gone, renumbered.
  await open(struck.token);
  const third = p.locator("#cards .card").nth(2); const b3 = await third.boundingBox();
  await p.mouse.move(b3.x + 80, b3.y + 30); await p.mouse.down(); await p.waitForTimeout(600); await p.mouse.up(); await p.waitForTimeout(150);
  await third.locator("a.dis").click(); await p.waitForTimeout(260); await shot("D-dismiss");
  await p.waitForTimeout(1400); await shot("D2-renumbered-live");
  // The same digest reloaded: the dismiss persisted server-side.
  await open(struck.token); await shot("D3-renumbered-reload");
  // F: done.
  await open(done.token); await shot("F-done");
  // H: gone.
  await open(gone.token); await shot("H-gone");
  // E: what a tap does: the sms: address the first card opens (Messages itself cannot be shown here).
  await open(fresh.token);
  const href = await p.getAttribute("#cards .card a[data-sms]", "href");
  writeFileSync(join(shotsDir, "E-tap-sms-href.txt"), `${href}\n\ndecoded body: ${decodeURIComponent(href.split("body=")[1])}\n`);
  // G: desktop, 1200 wide.
  const desk = await browser.newPage({ viewport: { width: 1200, height: 880 }, deviceScaleFactor: 1 });
  await desk.goto(`${base}/a/${fresh.token}`, { waitUntil: "load" }); await desk.evaluate(() => document.fonts.ready); await desk.waitForTimeout(120);
  await desk.screenshot({ path: join(shotsDir, "G-desktop.png") });
  // The link card from the server route.
  const ogRes = await desk.request.get(`${base}${page.ogImagePath(fresh.token)}`);
  writeFileSync(join(shotsDir, "og-preview.png"), Buffer.from(await ogRes.body()));
  writeFileSync(join(shotsDir, "timings.json"), JSON.stringify({ page_load_ms_by_token: timings, note: "goto → load + fonts ready, real local server, Chromium 390 wide" }, null, 2));
  await browser.close();
  server.close();
  console.log(`shots in ${shotsDir}; page loads (ms): ${Object.values(timings).join(", ")}`);
}

if (deploy) {
  const out = execFileSync("npx", ["-y", "netlify-cli", "deploy", "--dir", outDir, "--site", SITE, "--alias", "action-cards", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const j = JSON.parse(out);
  console.log(`staging: ${j.deploy_url}`);
}
rmSync(dir, { recursive: true, force: true });
