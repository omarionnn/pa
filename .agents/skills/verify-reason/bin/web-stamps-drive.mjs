#!/usr/bin/env node
// Drive Stamps end to end over REAL HTTP and draw it (REASON_WEB_DAILY, src/pages/webstamps.js):
// src/http.js createServer on a loopback port, a throwaway database, SAMPLE stamps only. A real errand
// completion (db.finishTask) earns the first stamp; the book in its three states (empty, first stamp,
// many pages) at 390 and 1280 in Paper and Night; the share made through the real endpoint with the
// session's secret, the public page and its og.png drawn by real Chromium, then Stop sharing → the 404 page and
// the generic card. Nothing is sent anywhere (no teller is installed). Run under the cage:
//
//   cd <worktree> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/stamps.db node .agents/skills/verify-reason/bin/web-stamps-drive.mjs [outDir]
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL. PNGs go to outDir (default
// ~/Desktop/reason-web-design-previews/daily), with compare-stamps.png beside the reference when the
// handoff is on this machine.
process.env.REASON_WEB = "on";
process.env.REASON_WEB_DAILY = "owner";
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
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/stamps.db");
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
const OUT = process.argv[2] || join(homedir(), "Desktop/reason-web-design-previews/daily");
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

// 1. Empty.
let r = await fetch(`${base}/web/stamps`, { headers: { cookie: `reason_page=${token}` } });
let h = await r.text();
step(r.status === 200 && /PAGE 1 · NO STAMPS YET/.test(h) && (h.match(/Blank spot/g) ?? []).length === 8, "empty: PAGE 1 · NO STAMPS YET, 8 blank spots");
await all4("stamps-empty", "/web/stamps");

// 2. A real errand finishing earns the first stamp (db.finishTask → completionBus → src/stamps.js).
const t = db.createTask(C, { title: "sample errand", goal: "sample", maxAttempts: 3 });
db.finishTask(C, t.id ?? t.task?.id, { state: "done", outcome: "done" });
const first = db.db.prepare("SELECT * FROM stamps WHERE conversation_id = ?").all(C);
step(first.length === 1 && first[0].type === "first", "a finished task earned First errand (live award)");
h = await (await fetch(`${base}/web/stamps`, { headers: { cookie: `reason_page=${token}` } })).text();
step(/1 STAMP SINCE/.test(h) && /· NEW</.test(h) && /aria-label="Share First errand"/.test(h), "first stamp: count, NEW, share button");
await all4("stamps-first", "/web/stamps");

// 3. Many pages: sample stamps of every earnable type, spread back to August.
const DAY = 86_400_000, now = Date.now();
const sample = [
  ["night_shift", { time: now }], ["three_in_one", { count: 3 }], ["early", { days: 9 }], ["human", { place: "a cable company" }],
  ["price_drop", { savedCents: 4000 }], ["night_shift", { time: now }], ["long_hold", { minutes: 41 }], ["early", { days: 12 }],
  ["human", { place: "the airline" }], ["night_shift", { time: now }], ["price_drop", { savedCents: 1800 }], ["long_hold", { minutes: 52 }],
];
sample.forEach(([type, detail], i) => {
  const at = now - (sample.length - i) * 5 * DAY + (i === sample.length - 1 ? 5 * DAY - 3600_000 : 0);
  stamps.award(C, { type, ref: `sample:${i}`, at, detail });
});
db.db.prepare("UPDATE stamps SET earned_at = ? WHERE type = 'first'").run(now - 75 * DAY);
h = await (await fetch(`${base}/web/stamps`, { headers: { cookie: `reason_page=${token}` } })).text();
step(/PAGE 2 · 13 STAMPS SINCE/.test(h) && /aria-current="page">2</.test(h), "many: page 2 of 2, 13 stamps");
await all4("stamps-many", "/web/stamps");
await all4("stamps-page1", "/web/stamps?page=1");

// 4. Share through the real endpoint, with the session's secret.
const newest = db.db.prepare("SELECT id FROM stamps WHERE conversation_id = ? ORDER BY earned_at DESC LIMIT 1").get(C).id;
r = await fetch(`${base}/web/api/stamps/${newest}/share`, { method: "POST", headers: { cookie: `reason_page=${token}`, "content-type": "application/json", accept: "application/json", "x-reason-csrf": csrf, origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ showName: true }) });
const url = r.ok ? (await r.json()).url : "";
const sid = url.split("/").pop();
step(/^https:\/\/heyreason\.com\/s\/[0-9A-Za-z]{12}$/.test(url), `share link made: ${url.replace(/[0-9A-Za-z]{12}$/, "<12 base62>")}`);
r = await fetch(`${base}/web/api/stamps/${newest}/share`, { method: "POST", headers: { cookie: `reason_page=${token}`, "content-type": "application/json", accept: "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "{}" });
step(r.status === 403, "a cross-site share is refused (403)");
await all4("stamps-shared", `/web/stamps?stamp=${newest}`);
r = await fetch(`${base}/s/${sid}`);
h = await r.text();
step(r.status === 200 && r.headers.get("x-robots-tag")?.includes("noindex") && /summary_large_image/.test(h) && /\?ref=s_/.test(h), "public page: 200, noindex, og card tags, CTA ref");
for (const width of [390, 1280]) for (const scheme of ["light", "dark"]) await shot("share-public", `/s/${sid}`, { width, scheme, cookie: false });
r = await fetch(`${base}/s/${sid}/og.png`);
const og = Buffer.from(await r.arrayBuffer());
writeFileSync(join(OUT, "share-og-1200.png"), og);
step(r.status === 200 && og.subarray(1, 4).toString() === "PNG" && og.readUInt32BE(16) === 1200 && og.readUInt32BE(20) === 630, "og.png: a real 1200×630 PNG drawn by Chromium");

// 5. Stop sharing → the 404 page, the same as an id that never existed; og → a plain 404.
r = await fetch(`${base}/web/api/stamps/${newest}/share/revoke`, { method: "POST", headers: { cookie: `reason_page=${token}`, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" }, body: `c=${encodeURIComponent(csrf)}`, redirect: "manual" });
step(r.status === 303, "Stop sharing (no-script form) → 303 back to the book");
r = await fetch(`${base}/s/${sid}`);
h = await r.text();
step(r.status === 404 && /This stamp isn’t here/.test(h) && h === await (await fetch(`${base}/s/doesnotexist`)).text(), "revoked: the 404 page, same as never existed");
for (const width of [390, 1280]) await shot("share-revoked", `/s/${sid}`, { width, scheme: "light", cookie: false });

// 6. Beside the reference.
// The handoffs moved under "Project files/Reason/handoffs"; the old Desktop path is the fallback.
const ref = [join(homedir(), "Desktop/Project files/Reason/handoffs/reason-daily-handoff-2026-10-27/reason-daily-handoff/reference/stamps.html"),
  join(homedir(), "Desktop/reason-daily-handoff-2026-10-27/reason-daily-handoff/reference/stamps.html")].find(existsSync) ?? "";
if (existsSync(ref)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`file://${ref}`, { waitUntil: "networkidle" }).catch(() => {});
  const refFile = join(OUT, "reference-stamps-1280.png");
  await page.screenshot({ path: refFile, fullPage: true });
  const mine = join(OUT, "stamps-many-1280-paper.png");
  const fileUrl = (f) => `file://${f}`;
  await page.setViewportSize({ width: 2600, height: 900 });
  await page.setContent(`<body style="margin:0;display:flex;gap:40px;background:#888;padding:20px;align-items:flex-start;font:16px sans-serif"><div><p>reference/stamps.html</p><img src="${fileUrl(refFile)}" width="1260"></div><div><p>/web/stamps (sample data)</p><img src="${fileUrl(mine)}" width="1260"></div></body>`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "compare-stamps.png"), fullPage: true });
  await ctx.close();
  step(true, `compare-stamps.png written`);
}

await browser.close();
await new Promise(r => server.close(r));
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
