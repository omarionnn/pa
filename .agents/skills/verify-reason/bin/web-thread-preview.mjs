#!/usr/bin/env node
// Draw and drive Reason Web's thread scrolling (handoff v2 §4b S2 + S3, §4d L1 / L2 / L10) from a
// throwaway database shaped like Prototype S23: a done task two weeks back, two on a weekday, plain
// iMessage lines yesterday, a task that finished on Web minutes ago, and one still being worked.
// Real HTTP on loopback, real page script in Chromium. Nothing leaves this machine: no text, no model.
//
//   node .agents/skills/verify-reason/bin/web-thread-preview.mjs [outDir] [referenceDir]
//
// Writes thread-<state>-<390|1280>-<paper|night>.png (bottom = today + DONE JUST NOW + L10, yesterday,
// earlier = the weekday's DONE lines, fold = a DONE line opened, l1, l2) and compare-thread-<l1|l2|l10>.png
// (ours | the reference board). Prints one ok/FAIL line per check and exits non-zero on a failure.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const outDir = process.argv[2] || join(homedir(), "Desktop", "reason-web-design-previews", "v2");
const refDir = process.argv[3] || join(homedir(), "Desktop", "Project files", "Reason", "handoffs", "reason-web-handoff-v2-2026-10-26", "reason-web-handoff", "reference");
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "reason-thread-preview-"));
Object.assign(process.env, { REASON_DB_PATH: join(dir, "r.db"), REASON_DATA_DIR: dir, REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_OWNER_NUMBER: "+12025551234", REASON_MASTER_NUMBER: "+12025551234", REASON_WEB: "on", REASON_WEB_STREAM: "off" });
for (const k of ["REASON_PAGES_URL", "REASON_SITE_URL", "REASON_PUBLIC_URL", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "REASON_BACKEND", "SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY"]) delete process.env[k];
const root = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
async function seed(root) {
  const db = await import(`${root}/src/db.js`);
  const { config } = await import(`${root}/src/config.js`);
  config.web = true;
  const C = "dm:fake:+14155559876", ADDR = "+14155559876";
  db.upsertAccount({ conversationId: C, channel: "fake", address: ADDR, name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: C, channel: "fake", address: ADDR, isOwner: true, service: "iMessage" });
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
  db.markWebNoticeSeen(C);
  const DAY = 864e5, now = Date.now();
  const tz = config.tz;
  // a wall-clock time `daysAgo` days back at h:m in the config tz
  const at = (daysAgo, h, m) => {
    const d = new Date(now - daysAgo * DAY);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    const off = local - d.getTime();
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, m) - off;
  };
  let ob = 9000, n = 0;
  const msg = ({ role, channel = "fake", text, t, device = null }) => {
    n++;
    if (role === "user") {
      const ext = channel === "web" ? `${C}:cid-${n}-xxxxxxxx` : `ext-${n}`;
      if (device) db.db.prepare("INSERT INTO web_devices (conversation_id, client_id, device, at) VALUES (?,?,?,?)").run(C, `cid-${n}-xxxxxxxx`, device, t);
      db.writeMessage({ conversationId: C, role, channel, externalId: ext, text, at: t });
      return { ext };
    }
    const o = ++ob;
    db.writeMessage({ conversationId: C, role, channel, externalId: `out-${n}`, outboxId: o, text, at: t });
    return { o };
  };
  const task = (title, label, msgs, { finishedAt, result = null, state = "done", sheet = null }) => {
    const tk = db.createTask(C, { title, goal: title, maxAttempts: 5, label, sheet });
    if (state === "done") {
      db.finishTask(C, tk.id, { state: "done", outcome: title, result });
      db.db.prepare("UPDATE tasks SET finished_at = ? WHERE id = ?").run(finishedAt, tk.id);
    }
    for (const m of msgs) {
      const r = msg(m);
      db.db.prepare("INSERT INTO task_messages (conversation_id, task_id, external_id, outbox_id, created_at) VALUES (?,?,?,?,?)").run(C, tk.id, r.ext ?? null, r.o ?? null, now);
    }
    return tk;
  };
  for (let i = 0; i < 44; i++) msg({ role: i % 2 ? "assistant" : "user", text: i % 2 ? "noted." : `older note ${i}`, t: at(24, 8, 0) + i * 60_000 });
  // ~two weeks ago (Oct 12-ish)
  task("Passport reminder", "Passport reminder, Nov 1", [
    { role: "user", text: "remind me to renew my passport", t: at(15, 9, 2) },
    { role: "assistant", text: "done. i'll nudge you on the 1st.", t: at(15, 9, 3) },
  ], { finishedAt: at(15, 9, 3) });
  // Tuesday-ish (6 days ago)
  task("Dentist", "Dentist, Thursday 3pm", [
    { role: "user", text: "call the dentist and get me in this week", t: at(6, 9, 2) },
    { role: "assistant", text: "calling now. i'll tell them it's recorded.", t: at(6, 9, 3) },
    { role: "assistant", text: "thursday 3pm with dr. patel. here's the call.", t: at(6, 9, 20) },
  ], { finishedAt: at(6, 9, 20) });
  task("Con Ed bill", "Con Ed paid, $87.40", [
    { role: "assistant", text: "your con ed bill is $87.40, due friday. want me to pay it?", t: at(6, 17, 20) },
    { role: "user", text: "yeah", t: at(6, 17, 25) },
    { role: "assistant", text: "done. confirmation coming to your email.", t: at(6, 17, 31) },
  ], { finishedAt: at(6, 17, 31) });
  // yesterday, plain
  msg({ role: "user", text: "Can you find somewhere upstate for the weekend of the 14th?", t: at(1, 13, 15) });
  msg({ role: "assistant", text: "Happy to. Roughly how far would you drive, and what's the budget for two nights?", t: at(1, 13, 18) });
  msg({ role: "user", text: "Under 3 hours. Keep it under $600.", t: at(1, 13, 21) });
  msg({ role: "assistant", text: "Got it. I'll pull a short list and keep it here for when you're ready.", t: at(1, 13, 22) });
  // today on the web: the Hudson task just finished
  const t0 = now - 50 * 60_000;
  task("Hudson inn", "Hudson inn held", [
    { role: "user", channel: "web", device: "computer", text: "Looking at this on my laptop now. A fireplace would be a bonus.", t: t0 },
    { role: "assistant", channel: "web", text: "Three that fit. Want me to check Nov 14–16?", t: t0 + 3 * 60_000 },
    { role: "user", channel: "web", device: "computer", text: "Yes, check the 14th for all three.", t: t0 + 6 * 60_000 },
    { role: "assistant", channel: "web", text: "Hudson is open both nights. Want me to hold it?", t: t0 + 20 * 60_000 },
    { role: "user", channel: "web", device: "computer", text: "Book it.", t: t0 + 25 * 60_000 },
    { role: "assistant", channel: "web", text: "held. friday to sunday, $540. confirmation's in your email.", t: now - 4 * 60_000 },
  ], { finishedAt: now - 4 * 60_000, result: { headline: "Hudson inn held, Nov 14–16", facts: ["$540", "Fri–Sun"] } });
  // the long one, still running
  task("Dog sitter for Nov 14–16", "Dog sitter", [
    { role: "user", channel: "web", device: "computer", text: "Can you find a dog sitter for that weekend?", t: now - 2 * 60_000 },
  ], { state: "running", sheet: { steps: [{ text: "Find sitters nearby", state: "done" }, { text: "Call three sitters", state: "doing", live: "calling three places" }] } });
  return { db, C };
}
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const { db, C } = await seed(root);
const { createServer } = await import(`${root}/src/http.js`);
const { Router } = await import(`${root}/src/channels/router.js`);
const { WebChannel } = await import(`${root}/src/channels/web.js`);
const { chromium } = await import(`${root}/node_modules/playwright/index.mjs`);
const router = new Router({ log: () => {} }); router.register(new WebChannel());
const server = createServer({ router, runtime: null });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
db.startPageSession(`wsign:${C}`, "tok-thread-preview", { conversationId: C });
const b = await chromium.launch();
async function open(width, theme, hold = null) {
  const ctx = await b.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: theme === "night" ? "dark" : "light", timezoneId: "America/New_York" });
  await ctx.addCookies([{ name: "reason_page", value: "tok-thread-preview", url: base }]);
  await ctx.addInitScript(() => { try { sessionStorage.setItem("reason-web-loaded", "1"); } catch {} });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(String(e)));
  let release = null;
  if (hold) await p.route(hold, async (r) => { await new Promise(x => { release = x; }); await r.continue(); });
  await p.goto(`${base}/web?thread`);
  return { ctx, p, errs, release: () => release?.() };
}
const shot = (p, state, w, t) => p.screenshot({ path: join(outDir, `thread-${state}-${w}-${t}.png`) });
const toDay = (p, i) => p.evaluate((i) => { const d = [...document.querySelectorAll("li.day")].at(i); const bar = document.querySelector(".top").getBoundingClientRect().bottom; window.scrollTo(0, d.getBoundingClientRect().top + window.scrollY - bar - 40); }, i);
for (const w of [390, 1280]) for (const t of ["paper", "night"]) {
  const { ctx, p, errs } = await open(w, t);
  await p.waitForSelector(".thread .msg"); await p.waitForTimeout(900);
  const note = () => p.$eval(".where", e => e.getAttribute("aria-label"));
  await shot(p, "bottom", w, t);
  check(/^(today|yesterday), on your laptop$/.test(await note()), `${w} ${t}: opens at the bottom, note = ${await note()}`);
  check(await p.locator(".longwork:not([hidden])").count() === 1, `${w} ${t}: L10 on it. calling three places.`);
  await toDay(p, -2); await p.waitForTimeout(900); await shot(p, "yesterday", w, t);
  check(await p.locator(".today:not([hidden])").count() === 1 && (await p.getAttribute("#c-input", "placeholder")) === "Reply from here", `${w} ${t}: TODAY ↓ + Reply from here, note = ${await note()}`);
  await toDay(p, 1); await p.waitForTimeout(900); await shot(p, "earlier", w, t);
  await p.locator(".today").click(); await p.waitForTimeout(1200);
  check(await p.locator(".today[hidden]").count() === 1, `${w} ${t}: TODAY ↓ goes back`);
  const fresh = p.locator(".done[data-fresh] .dl");
  if (await fresh.count()) { await fresh.click(); await p.waitForTimeout(300); await p.evaluate(() => { const d = document.querySelector(".done.open"); window.scrollTo(0, d.getBoundingClientRect().top + window.scrollY - 160); }); await p.waitForTimeout(800); await shot(p, "fold", w, t); }
  check((await fresh.getAttribute("aria-expanded")) === "true", `${w} ${t}: DONE line opens (aria-expanded, FOLD ↑)`);
  check(!errs.length, `${w} ${t}: no page errors ${errs.join(" | ")}`);
  await ctx.close();
  const L = await open(w, t, "**/web/history"); await L.p.waitForSelector(".l1"); await L.p.waitForTimeout(300); await shot(L.p, "l1", w, t);
  check((await L.p.textContent(".l1 [role=status]")) === "OPENING YOUR THREAD…", `${w} ${t}: L1`); L.release(); await L.ctx.close();
  const M = await open(w, t); await M.p.waitForSelector(".start button"); let rel;
  await M.p.route("**/web/history?before=*", async (r) => { await new Promise(x => { rel = x; }); await r.continue(); });
  await M.p.evaluate(() => window.scrollTo(0, 0)); await M.p.click(".start button"); await M.p.waitForSelector(".start [role=status]"); await M.p.evaluate(() => window.scrollTo(0, 0)); await M.p.waitForTimeout(300);
  await shot(M.p, "l2", w, t); check(true, `${w} ${t}: L2 FINDING EARLIER MESSAGES…`); rel(); await M.ctx.close();
}
// Compare: ours (390) beside the reference board, Paper over Night.
for (const [state, board, ours] of [["l1", "L1 ·", "l1"], ["l2", "L2 ·", "l2"], ["l10", "L10 ·", "bottom"]]) {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage();
  const refs = {};
  for (const t of ["paper", "night"]) {
    const file = `${refDir}/sheet-loading-${state === "l10" ? "actions" : "app"}-${t}.html`;
    await p.goto(`file://${file}`); await p.waitForTimeout(400);
    const el = p.locator(`xpath=//p[starts-with(normalize-space(.), "${board}")]/following-sibling::div[1]`);
    refs[t] = (await el.screenshot()).toString("base64");
  }
  const img = (f) => `data:image/png;base64,${f}`;
  const mine = (t) => `file://${join(outDir, `thread-${ours}-390-${t}.png`)}`;
  await p.setContent(`<body style="margin:0;background:#888;display:grid;grid-template-columns:auto auto;gap:16px;padding:16px;width:max-content">${["paper", "night"].map(t => `<img src="${mine(t)}" width="390"><img src="${img(refs[t])}" width="390">`).join("")}</body>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(outDir, `compare-thread-${state}.png`), fullPage: true });
  await ctx.close();
}
await b.close(); server.close(); rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
