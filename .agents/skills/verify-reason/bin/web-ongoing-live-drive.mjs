#!/usr/bin/env node
// Drive Ongoing's live update (owner 10-26 D5) in a real browser over REAL HTTP: src/http.js
// createServer on a loopback port, a page_sessions row for a fake account, the fixture's rows, headless
// Chromium. A new row is added to the database while the pages are open; the desktop margin, the
// rail's ONGOING · N, the tab badge and the phone's Ongoing tab must all follow without a reload.
// No model is called and nothing is texted (no texting channel is registered). Run under the cage:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-ongoing-live-drive.mjs
process.env.REASON_WEB = "on";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
delete process.env.REASON_SITE_PROXY_SECRET;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/web.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { WebChannel } = await imp("src/channels/web.js");
const { makeDeliver } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");
const { clock } = await imp("src/config.js");
const { seedOngoing } = await imp("test/fixture-ongoing.js");
const { chromium } = await imp("node_modules/playwright/index.mjs");

const C = "dm:fake:+14155559876";
db.upsertAccount({ conversationId: C, channel: "fake", address: "+14155559876", name: "Kofi" });
db.upsertThread({ conversationId: C, channel: "fake", address: "+14155559876", isOwner: true, service: "iMessage" });
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
seedOngoing(C);

const router = new Router({});
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const runtime = new Runtime({ channels: router, deliver, runTurn: async () => "ok" });
router.runtime = runtime;
router.register(consoleChannel);
router.register(new WebChannel());
const server = createServer({ router, runtime, log: (...a) => { if (process.env.DEBUG) console.error(...a); } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const tok = `drive-live-${Math.random().toString(36).slice(2)}`;
db.startPageSession(`wsign:${C}`, tok, { conversationId: C });
db.markWebNoticeSeen?.(C);

const b = await chromium.launch();
const open = async (path, width) => {
  const ctx = await b.newContext({ viewport: { width, height: 900 } });
  await ctx.addCookies([{ name: "reason_page", value: tok, url: BASE }]);
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", e => errors.push(String(e)));
  await pg.goto(BASE + path);
  return { pg, errors, ctx };
};
const desk = await open("/web?thread", 1280);
const phone = await open("/web?tab=ongoing", 390);
const text = (pg, sel) => pg.evaluate(s => document.querySelector(s)?.textContent ?? "", sel);
const url0 = [desk.pg.url(), phone.pg.url()];
if (process.env.DEBUG) console.log(url0, (await desk.pg.evaluate(() => document.body.innerText.slice(0, 500))));
step("desk: rail before", /ONGOING · 7/.test(await text(desk.pg, ".og-back")), await text(desk.pg, ".og-back"));
step("phone: tab badge before", (await text(phone.pg, '.tabs a[href="/web?tab=ongoing"] .n')) === "7");

db.createTimer(C, { fireAt: clock.now() + 60 * 60_000, note: "n", label: "Call the dentist" });
const until = async (pg, fn, ms = 20000) => { try { await pg.waitForFunction(fn, null, { timeout: ms }); return true; } catch { return false; } };
step("desk: margin gets the new row", await until(desk.pg, () => /Call the dentist/.test(document.getElementById("og")?.textContent ?? "")));
step("desk: rail recounted", /ONGOING · 8/.test(await text(desk.pg, ".og-back")), await text(desk.pg, ".og-back"));
step("desk: tab badge recounted", (await text(desk.pg, '.tabs a[href="/web?tab=ongoing"] .n')) === "8");
step("phone: tab list gets the new row", await until(phone.pg, () => /Call the dentist/.test(document.querySelector("main")?.textContent ?? "")));
step("phone: count line + badge", /8 THINGS/.test(await text(phone.pg, "main")) && (await text(phone.pg, '.tabs a[href="/web?tab=ongoing"] .n')) === "8");
step("no reload", desk.pg.url() === url0[0] && phone.pg.url() === url0[1]);
await desk.pg.evaluate(() => document.querySelector("#og .og-hide")?.click());
step("desk: HIDE still works on the redrawn margin", await until(desk.pg, () => document.documentElement.classList.contains("og-off"), 3000));
step("no page errors", !desk.errors.length && !phone.errors.length, [...desk.errors, ...phone.errors].join(" | "));
const out = process.env.REASON_SHOT_DIR;
if (out) { await phone.pg.screenshot({ path: `${out}/ongoing-live-tab-390.png`, fullPage: true }); }
await b.close();
server.close();
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
