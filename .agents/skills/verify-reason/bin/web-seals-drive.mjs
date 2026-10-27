#!/usr/bin/env node
// Drive the wax-seal book end to end over REAL HTTP and draw it (REASON_STAMPS_WAX=on, src/pages/webseals.js):
// src/http.js createServer on a loopback port, a throwaway database, nothing sent anywhere. Real completions
// (db.finishTask, db.updateCall, db.finishResearch, db.markAgentcardPurchase) earn the first-errand patch,
// Held on your behalf and the suite key (logged as one job); the book in its states, Paper + Night at 390
// and 1280; a share link (POST with the session secret), the public /s/<id> page, its og.png and the story
// drawn by the real headless Chromium; Stop sharing → 410.
//
//   cd <worktree> && REASON_DB_PATH=$(mktemp -d)/seals.db node .agents/skills/verify-reason/bin/web-seals-drive.mjs [outDir]
process.env.REASON_WEB = "on";
process.env.REASON_WEB_DAILY = "owner";
process.env.REASON_STAMPS_WAX = "on";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_PAGES_URL ||= "https://files.example.test";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.REASON_BACKEND;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/seals.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR = dirname(db);
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
const { homedir } = await import("node:os");
const { join } = await import("node:path");
const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
const OUT = process.argv[2] || join(homedir(), "Desktop/reason-web-design-previews/stamps-wax");
mkdirSync(OUT, { recursive: true });

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");
const stamps = await imp("src/stamps.js");
const { chromium } = await import(new URL("node_modules/playwright/index.mjs", root));

let fails = 0;
const step = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const C = "dm:owner";
db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
db.upsertThread({ conversationId: C, channel: "fake", address: "+12025551234", isOwner: true, service: "iMessage" });
const token = `drive-${Date.now()}`;
db.startPageSession(`wsign:${C}`, token, { conversationId: C });
const csrf = db.pageSessionCsrf(token);

const server = createServer({ router: { statuses: () => [] }, runtime: null });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

async function shot(name, path, { width, scheme, full = true, cookie = true }) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
  if (cookie) await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
  const page = await ctx.newPage();
  const r = await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const file = join(OUT, `${name}-${width}-${scheme === "dark" ? "night" : "paper"}.png`);
  await page.screenshot({ path: file, fullPage: full });
  await ctx.close();
  return { status: r.status(), file };
}
const all4 = async (name, path) => {
  for (const width of [390, 1280]) for (const scheme of ["light", "dark"]) await shot(name, path, { width, scheme });
};

// 1. Empty: no seals, two not-yet spots, nothing kept outside.
const DAY = 86_400_000, M = 60_000;
let r = await fetch(`${base}/web/stamps`, { headers: { cookie: `reason_page=${token}` } });
let h = await r.text();
step(r.status === 200 && /PAGE 1 · NO SEALS YET/.test(h) && (h.match(/aria-label="Not yet earned: /g) ?? []).length === 2 && /Your book\./.test(h), "empty: NO SEALS YET, two not-yet spots, Your book.");
await all4("seals-empty", "/web/stamps");

// 2. Real completions, two hours apart from everything else: a held call, research, an order, one task.
const t0 = Date.now() - 3 * 60 * M;
const task = (start, end) => {
  const id = Number(db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at) VALUES (?, 't', 'g', 'running', 3, ?, ?)").run(C, start, start).lastInsertRowid);
  db.finishTask(C, id, { state: "done", outcome: "ok" });
  db.db.prepare("UPDATE tasks SET finished_at = ? WHERE id = ?").run(end, id);
};
const callId = Number(db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, created_at, updated_at, brief) VALUES (?, 'fake', '+18005551212', 'g', ?, ?, ?)").run(C, t0, t0, JSON.stringify({ place: "Sample Airline" })).lastInsertRowid);
db.updateCall(C, callId, { state: "completed", outcome_kind: "confirmed", hold_total_s: 52 * 60 });
db.db.prepare("UPDATE calls SET ended_at = ? WHERE id = ?").run(t0 + 58 * M, callId);
const rid = Number(db.db.prepare("INSERT INTO research (conversation_id, question, created_at, updated_at) VALUES (?, 'q', ?, ?)").run(C, t0 + 5 * M, t0 + 5 * M).lastInsertRowid);
db.finishResearch(C, rid);
db.db.prepare("UPDATE research SET finished_at = ? WHERE id = ?").run(t0 + 30 * M, rid);
db.db.prepare("INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, merchant, amount_cents, created_at, updated_at) VALUES (?, 'drive-buy', 'awaiting_approval', 'Sample Shop', 6000, ?, ?)").run(C, t0 + 60 * M, t0 + 60 * M);
db.markAgentcardPurchase("drive-buy", { status: "placed" });
db.db.prepare("UPDATE agentcard_purchases SET updated_at = ? WHERE buy_conversation_id = 'drive-buy'").run(t0 + 70 * M);
db.db.prepare("UPDATE stamp_step_times SET finished_at = ? WHERE kind = 'purchase'").run(t0 + 70 * M);
task(t0 + 75 * M, t0 + 100 * M);
const types = db.db.prepare("SELECT type FROM stamps WHERE conversation_id = ? ORDER BY id").all(C).map(x => x.type);
step(types.includes("first") && types.includes("long_hold"), `completions earned: ${types.join(", ")}`);
// The research/purchase/task finish times were moved back after their events fired: ask once more, as the next completion would.
stamps.awardLive(C, stamps.suiteCandidates(C, { all: true }));
const job = db.db.prepare("SELECT * FROM stamp_jobs WHERE conversation_id = ?").get(C);
step(!!job && job.started_at === t0 && JSON.parse(job.steps_json).length === 4, "suite key: one job, started at the call's start, four steps");
step(db.db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE conversation_id = ? AND type = 'suite_key'").get(C).n === 1, "suite key awarded once");
h = await (await fetch(`${base}/web/stamps`, { headers: { cookie: `reason_page=${token}` } })).text();
step(/PAGE 1 · 1 SEAL SINCE/.test(h) && /role="img" aria-label="Oxblood seal: held on your behalf, fifty-two minutes"/.test(h) && /KEPT OUTSIDE THE BOOK/.test(h) && /Sewn on day one\./.test(h), "first seal + the patch kept outside");
step(/It was no trouble\./.test(h) && !/!/.test(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!doctype html>|<!--[\s\S]*?-->/gi, "")), "the story ends 'It was no trouble.', no exclamation marks");
await all4("seals-first", "/web/stamps");

// 3. Many: sample seals of every earnable kind, back to August.
const kinds = [["night_shift", { time: Date.now() }], ["three_in_one", { count: 3 }], ["early", { days: 12 }], ["human", { place: "x" }], ["price_drop", { savedCents: 4000 }], ["long_hold", { minutes: 41 }]];
for (let i = 0; i < 10; i++) { const [type, detail] = kinds[i % kinds.length]; stamps.award(C, { type, ref: `sample:${i}`, at: Date.now() - (80 - i * 7) * DAY, detail }); }
h = await (await fetch(`${base}/web/stamps`, { headers: { cookie: `reason_page=${token}` } })).text();
step(/PAGE 2 · 11 SEALS SINCE/.test(h) && /aria-current="page">2</.test(h), "many: page 2 of 2, 11 seals");
await all4("seals-many", "/web/stamps");
await all4("seals-page1", "/web/stamps?page=1");

// 4. Share the held call: link, public page, og card, story, revoke.
const held = db.db.prepare("SELECT id FROM stamps WHERE conversation_id = ? AND type = 'long_hold' ORDER BY earned_at DESC LIMIT 1").get(C).id;
r = await fetch(`${base}/web/api/stamps/${held}/share`, { method: "POST", headers: { cookie: `reason_page=${token}`, "content-type": "application/json", accept: "application/json", "x-reason-csrf": csrf, origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ showName: true }) });
const { url } = await r.json();
const sid = url.split("/").pop();
step(/^https:\/\/heyreason\.com\/s\/[0-9A-Za-z]{12}$/.test(url), `share link ${url.replace(/[0-9A-Za-z]{12}$/, "<12>")}`);
r = await fetch(`${base}/s/${sid}`);
h = await r.text();
step(r.status === 200 && r.headers.get("x-robots-tag")?.includes("noindex") && /Reason held for fifty-two minutes on Omari&#39;s behalf\./.test(h) && /Get your own Reason/.test(h) && !/Sample Airline/.test(h), "public page: noindex, the line, CTA, no place");
await shot("seal-public", `/s/${sid}`, { width: 1280, scheme: "light", cookie: false });
await shot("seal-public", `/s/${sid}`, { width: 390, scheme: "dark", cookie: false });
r = await fetch(`${base}/s/${sid}/og.png`);
const og = Buffer.from(await r.arrayBuffer());
step(r.headers.get("content-type") === "image/png" && og.readUInt32BE(16) === 1200 && og.readUInt32BE(20) === 630, "og.png: a real 1200×630 PNG");
writeFileSync(join(OUT, "seal-card-1200x630.png"), og);
r = await fetch(`${base}/web/api/stamps/${held}/story.png?name=1`, { headers: { cookie: `reason_page=${token}` } });
const story = Buffer.from(await r.arrayBuffer());
step(story.readUInt32BE(16) === 1080 && story.readUInt32BE(20) === 1920, "story.png: a real 1080×1920 PNG");
writeFileSync(join(OUT, "seal-story-1080x1920.png"), story);
await all4("seals-shared", `/web/stamps?stamp=${held}`);
r = await fetch(`${base}/web/api/stamps/${held}/share/revoke`, { method: "POST", headers: { cookie: `reason_page=${token}`, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" }, body: `c=${encodeURIComponent(csrf)}`, redirect: "manual" });
step(r.status === 303 && (await fetch(`${base}/s/${sid}`)).status === 410, "Stop sharing → the link answers 410");

await browser.close();
await new Promise(r => server.close(r));
console.log(fails ? `${fails} FAILED` : "all ok", "→", OUT);
process.exit(fails ? 1 : 0);
