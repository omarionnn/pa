#!/usr/bin/env node
// Draw an item's "… in the chat →" (owner 10-27 01:20): each Ongoing detail beside the thread it opens,
// with Reason's first line about that row (sample words). Throwaway database seeded by test/fixture-ongoing.js;
// no server of Reason's, no text sent, no model.
//
//   node .agents/skills/verify-reason/bin/web-talkdraft-preview.mjs [outDir]
//
// Writes talkdraft-<state>-<390|1280>-<paper|night>.png (the thread the link opens) and
// compare-talkdraft.png (detail | thread, each state, 390 Paper).
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const outDir = process.argv[2] || join(homedir(), "Desktop", "reason-web-design-previews", "v2");
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "reason-talkdraft-preview-"));
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
db.markWebNoticeSeen(C);
const ids = seedOngoing(C);
db.db.prepare("UPDATE tasks SET label = 'Speedrun reply' WHERE id = ?").run(ids.waiting);
// Sample first lines (the live words are the model's, from speakFirstPrompt).
const SAY = {
  waiting: "Still no word from Speedrun. I'm checking again Thursday. Want me to look now, or nudge them?",
  working: "Hudson's open at $540, I'm on the phone with Waramaug now, Woodstock's next. Want me to cap the price or stop at the first yes?",
  scheduled: "Want to change your Monday gym call? I could move it to 5, make it every other week, or stop it.",
  ready: "You're booked at Via Carota, Sat 7:30 for 4. Want me to add it to your calendar or tell the others?",
  failed: "Friday sold out before I got in. I'm watching resale until Thursday night. Keep watching, or try a different night?",
  approval: "The CeraVe PM lotion from Target, $16.78 all-in, shipping to the Bronx. just tell me in the chat when you want it.",
};
const rows = { waiting: ["task", ids.waiting], working: ["task", ids.working], scheduled: ["series", ids.series], ready: ["task", ids.ready], failed: ["task", ids.failed], approval: ["approval", ids.approval] };
const pages = {};
for (const [st, [kind, id]] of Object.entries(rows)) {
  pages[`detail-${st}`] = og.renderDetail(m.findItem(C, kind, id));
  db.db.exec("DELETE FROM messages");
  db.writeMessage({ conversationId: C, role: "assistant", channel: "web", text: SAY[st] });
  const lines = db.messagesFor(C).map(r => wc.rowOut(r, { conversationId: C, service: "iMessage" }));
  pages[`thread-${st}`] = wc.renderConversation({ account: { conversation_id: C, name: "Omari" }, csrf: "c", lines, more: false, sendId: "s", items: [], approvals: [], back: [] });
}
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const f = /^\/web\/fonts\/([a-z]+)\.woff2$/.exec(u);
  if (f) { const o = webFont(f[1]); res.writeHead(o ? 200 : 404, o?.headers ?? {}); return res.end(o?.body); }
  const name = u.slice(1);
  if (!pages[name]) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(pages[name]);
}).listen(0);
const port = srv.address().port;
const b = await chromium.launch();
const shot = async (name, w, th, path) => {
  const ctx = await b.newContext({ viewport: { width: w, height: 844 }, colorScheme: th === "night" ? "dark" : "light" });
  const pg = await ctx.newPage();
  await pg.route("**/web/history**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [], html: "", more: false }) }));
  await pg.goto(`http://127.0.0.1:${port}/${name}`); await pg.waitForTimeout(400);
  await pg.evaluate(() => document.documentElement.classList.remove("loading"));
  await pg.screenshot({ path });
  await ctx.close();
};
for (const st of Object.keys(rows)) for (const w of [390, 1280]) for (const th of ["paper", "night"]) {
  await shot(`thread-${st}`, w, th, join(outDir, `talkdraft-${st}-${w}-${th}.png`));
}
const tiles = [];
for (const st of Object.keys(rows)) {
  const d = join(dir, `d-${st}.png`);
  await shot(`detail-${st}`, 390, "paper", d);
  tiles.push([st, d, join(outDir, `talkdraft-${st}-390-paper.png`)]);
}
const ctx = await b.newContext({ viewport: { width: 860, height: 900 } });
const pg = await ctx.newPage();
const img = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
await pg.setContent(`<body style="margin:0;background:#888;font:14px monospace;display:flex;flex-direction:column;gap:16px;padding:12px">${tiles.map(([st, a, r]) => `<div>${st.toUpperCase()}: detail → tap → thread</div><div style="display:flex;gap:12px"><img src="${img(a)}" width="390"><img src="${img(r)}" width="390"></div>`).join("")}</body>`);
await pg.screenshot({ path: join(outDir, "compare-talkdraft.png"), fullPage: true });
await ctx.close();
await b.close(); srv.close();
rmSync(dir, { recursive: true, force: true });
console.log(`ok: ${Object.keys(rows).length} states → ${outDir}`);
