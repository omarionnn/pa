#!/usr/bin/env node
// Draw every Reason Web Ongoing state (src/ongoing.js + src/pages/webongoing.js) from a throwaway
// database seeded by test/fixture-ongoing.js, as PNGs beside the design handoff's reference pages.
// Nothing leaves this machine: no server, no text sent, no model.
//
//   node .agents/skills/verify-reason/bin/web-ongoing-preview.mjs [outDir] [referenceDir]
//
// Writes ongoing-<state>-<390|1280>-<paper|night>.png and compare-ongoing-<state>.png (ours | the
// reference, Paper over Night) for: tab, margin, empty, approval, working, waiting, scheduled, ready,
// failed, ninth (9D, signed out mid-task, driven by the page's own script).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const outDir = process.argv[2] || join(homedir(), "Desktop", "reason-web-design-previews");
const refDir = process.argv[3] || join(homedir(), "Desktop", "reason-web-handoff-2026-10-26", "reference");
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "reason-og-preview-"));
Object.assign(process.env, { REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: dir, REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_WEB: "on" });
for (const k of ["REASON_BACKEND", "SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) delete process.env[k];
const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root).href);
const db = await imp("src/db.js");
const { seedOngoing } = await imp("test/fixture-ongoing.js");
const wc = await imp("src/pages/webconvo.js");
const og = await imp("src/pages/webongoing.js");
const m = await imp("src/ongoing.js");
const { webFont } = await imp("src/pages/webkit.js");
const { chromium } = await imp("node_modules/playwright/index.mjs");

const C = "dm:owner";
db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
const ids = seedOngoing(C);
const model = m.ongoing(C);
const pages = {
  tab: wc.renderOngoing({ csrf: "c", ...model }),
  margin: wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines: [], more: false, sendId: "s", ...model }),
  empty: wc.renderOngoing({ csrf: "c", items: [], approvals: [], back: [] }),
  approval: og.renderDetail(m.findItem(C, "approval", ids.approval)),
  working: og.renderDetail(m.findItem(C, "task", ids.working)),
  waiting: og.renderDetail(m.findItem(C, "task", ids.waiting)),
  scheduled: og.renderDetail(m.findItem(C, "series", ids.series)),
  ready: og.renderDetail(m.findItem(C, "task", ids.ready)),
  failed: og.renderDetail(m.findItem(C, "task", ids.failed)),
  ninth: og.renderDetail(m.findItem(C, "task", ids.working)),
};
const REF = { tab: "ongoing-mobile", margin: "sheet-desktop-panel", empty: "ongoing-empty", approval: "ongoing-detail", working: "sheet-details", waiting: "sheet-details", scheduled: "sheet-details", ready: "sheet-details", failed: "sheet-details", ninth: "sheet-global" };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const f = /^\/web\/fonts\/([a-z]+)\.woff2$/.exec(u);
  if (f) { const o = webFont(f[1]); res.writeHead(o ? 200 : 404, o?.headers ?? {}); return res.end(o?.body); }
  if (u.startsWith("/ref/")) { const p = join(refDir, u.slice(5)); if (!existsSync(p)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": "text/html" }); return res.end(readFileSync(p)); }
  const name = u.slice(1);
  if (!pages[name]) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(pages[name]);
}).listen(0);
const port = srv.address().port;
const b = await chromium.launch();
const shot = async (url, w, th, path, { ninth = false, full = true } = {}) => {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, colorScheme: th === "night" ? "dark" : "light" });
  const pg = await ctx.newPage();
  await pg.goto(url); await pg.waitForTimeout(300);
  await pg.evaluate(() => document.documentElement.classList.remove("loading"));
  if (ninth) await pg.evaluate(() => window.reasonMidTask(false));
  if (full) await pg.evaluate(() => { const t = document.querySelector(".tabs"); if (t) t.style.position = "static"; });
  await pg.screenshot({ path, fullPage: full });
  await ctx.close();
};
for (const name of Object.keys(pages)) for (const w of [390, 1280]) for (const th of ["paper", "night"]) {
  await shot(`http://127.0.0.1:${port}/${name}`, w, th, join(outDir, `ongoing-${name}-${w}-${th}.png`), { ninth: name === "ninth", full: name !== "margin" });
}
// Side by side: ours (390, or 1280 for the margin) beside the reference page, Paper over Night.
for (const name of Object.keys(pages)) {
  const w = name === "margin" ? 1280 : 390;
  const tiles = [];
  for (const th of ["paper", "night"]) {
    const refShot = join(dir, `ref-${name}-${th}.png`);
    await shot(`http://127.0.0.1:${port}/ref/${REF[name]}-${th}.html`, w === 1280 ? 1280 : 1400, th, refShot, { full: true });
    tiles.push([join(outDir, `ongoing-${name}-${w}-${th}.png`), refShot]);
  }
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
  const pg = await ctx.newPage();
  const img = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
  await pg.setContent(`<body style="margin:0;background:#888;display:flex;flex-direction:column;gap:12px">${tiles.map(([a, r]) => `<div style="display:flex;gap:12px;align-items:flex-start"><img src="${img(a)}" style="max-width:${w === 1280 ? 1280 : 390}px"><img src="${img(r)}" style="max-height:1500px"></div>`).join("")}</body>`);
  await pg.screenshot({ path: join(outDir, `compare-ongoing-${name}.png`), fullPage: true });
  await ctx.close();
}
await b.close(); srv.close();
rmSync(dir, { recursive: true, force: true });
writeFileSync(join(outDir, "ongoing-preview.txt"), `drawn ${new Date().toISOString()}: ${Object.keys(pages).join(", ")}\n`);
console.log(`ok: ${Object.keys(pages).length} screens → ${outDir}`);
