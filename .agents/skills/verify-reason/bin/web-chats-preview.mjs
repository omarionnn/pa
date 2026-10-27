#!/usr/bin/env node
// Draw Web-only chats (owner 10-27): Home (its composer starts a new chat), a new chat, a chat with an
// exchange, and Chat history listing it. Throwaway database; no server of Reason's, no text, no model.
//
//   node .agents/skills/verify-reason/bin/web-chats-preview.mjs [outDir]
//
// Writes chats-<home|newchat|chat|history>-<390|1280>-<paper|night>.png and compare-chats.png.
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const outDir = process.argv[2] || join(homedir(), "Desktop", "reason-web-design-previews", "v2");
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "reason-chats-preview-"));
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
db.upsertThread({ conversationId: C, channel: "fake", address: "+12025551234", isOwner: true, service: "iMessage" });
db.markWebNoticeSeen(C);
seedOngoing(C);
const hist = await imp("src/pages/webhistory.js");
const now = Date.now();
// The shared thread: a text and its answer. Then one Web chat Home's composer started.
db.writeMessage({ conversationId: C, role: "user", channel: "fake", text: "running late, push dinner to 8?", at: now - 3 * 3600e3 });
db.writeMessage({ conversationId: C, role: "assistant", channel: "fake", text: "done, Via Carota has you at 8.", at: now - 3 * 3600e3 + 60e3 });
const CHAT = "PreviewChatAAAAAAAAAAA";
db.claimWebChat(C, CHAT);
db.writeMessage({ conversationId: C, role: "user", channel: "web", text: "Plan a birthday dinner for Ama next Friday", at: now - 20 * 60e3, chatId: db.webChatRoute(CHAT) });
db.writeMessage({ conversationId: C, role: "assistant", channel: "web", text: "on it. any budget, or a place she loves?", at: now - 19 * 60e3, chatId: db.webChatRoute(CHAT) });
db.writeMessage({ conversationId: C, role: "user", channel: "web", text: "under $80 a head, somewhere loud", at: now - 18 * 60e3, chatId: db.webChatRoute(CHAT) });
const model = m.ongoing(C);
const acct = { conversation_id: C, name: "Omari" };
const rows = db.messagesFor(C, { chat: CHAT }).map(r => wc.rowOut(r, { conversationId: C, service: "iMessage" }));
const pages = {
  home: wc.renderHome({ account: acct, csrf: "c", sendId: "s", ...model, pick: "" }),
  chat: wc.renderConversation({ account: acct, csrf: "c", lines: rows, more: false, sendId: "s", ...model, chat: CHAT }),
  newchat: wc.renderConversation({ account: acct, csrf: "c", lines: [], more: false, sendId: "s", ...model, chat: "PreviewChatBBBBBBBBBBB" }),
  history: hist.renderHistory({ account: db.getAccount(C) }),
};
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
for (const name of Object.keys(pages)) for (const w of [390, 1280]) for (const th of ["paper", "night"]) {
  await shot(name, w, th, join(outDir, `chats-${name}-${w}-${th}.png`));
}
const ctx = await b.newContext({ viewport: { width: 1660, height: 900 } });
const pg = await ctx.newPage();
const img = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
await pg.setContent(`<body style="margin:0;background:#888;font:14px monospace;padding:12px"><div>HOME → (type) → THE NEW WEB CHAT · ITS PAGE LATER · CHAT HISTORY (390 Paper)</div><div style="display:flex;gap:12px">${["home", "newchat", "chat", "history"].map(n => `<img src="${img(join(outDir, `chats-${n}-390-paper.png`))}" width="390">`).join("")}</div></body>`);
await pg.screenshot({ path: join(outDir, "compare-chats.png"), fullPage: true });
await ctx.close();
await b.close(); srv.close();
rmSync(dir, { recursive: true, force: true });
console.log(`ok: ${Object.keys(pages).length} screens → ${outDir}`);
