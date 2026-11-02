#!/usr/bin/env node
// Drive "Your pages" end to end (owner ask 2026-11-01: the wordmark on a page Reason made goes to a
// list of all their pages, with search). REAL HTTP: src/http.js createServer on a loopback port, the
// store in a throwaway database, headless Chromium clicking the real links and typing the real
// sign-in. No model is called; the sign-in code is caught from a stand-in runtime, nothing is texted.
//
//   cd <checkout> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/pidx.db node .agents/skills/verify-reason/bin/pages-index-drive.mjs [--shots=DIR]
//
// Steps: the owner on their page taps the wordmark → Your pages (all theirs, newest first, type, date,
// ARCHIVED marked, nobody else's) → search by title and by what a page says → a stranger, signed out,
// opens the same link → sign in → lands back on Your pages showing only their own → an account with no
// pages sees the empty list. `--shots` writes index-desktop, index-mobile, search, empty, signin PNGs.
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_PAGES_V2 = "1";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NAME = "Omari";
process.env.TZ = "America/New_York";
delete process.env.REASON_SITE_PROXY_SECRET;
delete process.env.REASON_BACKEND;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/pidx.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
const SHOTS = process.argv.find(a => a.startsWith("--shots="))?.slice(8) || "";

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");
const { config } = await imp("src/config.js");

const OWNER_N = "+13475550000", KOFI_N = "+14155559876", AMA_N = "+12125550111";
const OWNER_C = `dm:fake:${OWNER_N}`, KOFI_C = `dm:fake:${KOFI_N}`, AMA_C = `dm:fake:${AMA_N}`;
for (const [c, a, n] of [[OWNER_C, OWNER_N, "Omari"], [KOFI_C, KOFI_N, "Kofi"], [AMA_C, AMA_N, "Ama"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true });
  db.markWebNoticeSeen(c);
}
const DAY = 86_400_000, now = Date.now();
const mk = (c, title, ago, blocks) => {
  const p = db.createPage(c, { title, blocks });
  db.db.prepare("UPDATE pages SET created_at = ?, updated_at = ? WHERE id = ?").run(now - ago, now - ago, p.id);
  return p.id;
};
const text = (t) => [{ type: "text", text: t }];
const shortlist = mk(OWNER_C, "Dinner, Friday, three that fit", 2 * 3600_000, [
  { type: "cards", items: [{ title: "Peaches", note: "Soul food, Bed-Stuy" }, { title: "Lilia", note: "Pasta, Williamsburg" }, { title: "Via Carota", note: "West Village" }] },
  { type: "choice", key: "c1", options: [{ label: "Peaches" }, { label: "Lilia" }, { label: "Via Carota" }] },
]);
mk(OWNER_C, "Apartment tours, Saturday", 1 * DAY, text("Three viewings in Fort Greene and Clinton Hill, 10am to 1pm."));
mk(OWNER_C, "Dentist options near work", 4 * DAY, text("Two practices take your insurance; the closer one has Tuesday at 10."));
mk(OWNER_C, "Flights to Accra, December", 12 * DAY, text("JFK to ACC nonstop on Delta, or one stop through Lisbon."));
const archived = mk(OWNER_C, "Birthday gift ideas for Ama", 26 * DAY, text("A Polaroid camera, a cookbook, a weekend upstate."));
db.db.prepare("UPDATE pages SET state = 'archived', archived_at = ? WHERE id = ?").run(now, archived);
mk(OWNER_C, "Moving checklist", 45 * DAY, text("Utilities, renter's insurance, change of address, movers booked."));
mk(KOFI_C, "Kofi's gym plan", 3 * DAY, text("Push, pull, legs. West Village climbing gym on Sundays."));

const told = [];
const rt = { async _tell(conv, line) { told.push({ conv, line }); return { ok: true }; }, async say() {} };
const server = createServer({ router: { webhook: async () => ({ status: 404, body: {} }), statuses: () => [], list: () => [] }, runtime: rt, log: (e) => { if (e?.threw) console.error("THREW", e.threw); } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
config.siteUrl = BASE;
const sess = (c) => { const t = `drive-${c.replace(/\W/g, "")}-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${c}`, t, { conversationId: c }); return t; };

let fails = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra ? ` — ${extra}` : ""}`); if (!ok) fails++; };
const { mkdirSync } = await import("node:fs");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: (p.viewportSize()?.width ?? 0) > 800 }); };
const rowTitles = (p) => p.locator(".sv-list .sv-row .sv-t").allInnerTexts();

const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  // ---- the owner, signed in, on their page ----
  const ownerT = sess(OWNER_C);
  let ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
  await ctx.addCookies([{ name: "reason_page", value: ownerT, url: BASE }]);
  let p = await ctx.newPage();
  const res = await p.goto(`${BASE}/p/${shortlist}`, { waitUntil: "networkidle" });
  step("owner's page opens", res.status() === 200, String(res.status()));
  const link = p.locator("header a.wm-home").first();
  step("the wordmark is a link to Your pages", (await link.getAttribute("href")) === `${BASE}/web/saved?kind=pages`, await link.getAttribute("href"));
  await Promise.all([p.waitForURL(/\/web\/saved\?kind=pages$/), link.click()]);
  await p.waitForLoadState("networkidle");
  step("tapping it lands on Your pages", /\/web\/saved\?kind=pages$/.test(p.url()), p.url());
  step("heading says Your pages", (await p.locator("h1.sv-h1").innerText()).trim() === "Your pages");
  const titles = await rowTitles(p);
  const expectOwner = ["Dinner, Friday, three that fit", "Apartment tours, Saturday", "Dentist options near work", "Flights to Accra, December", "Birthday gift ideas for Ama", "Moving checklist"];
  step("all six of theirs, newest first", JSON.stringify(titles) === JSON.stringify(expectOwner), JSON.stringify(titles));
  const html = await p.content();
  step("nothing of Kofi's", !/Kofi/.test(html));
  step("type on the shortlist row (PAGE · SHORTLIST)", /PAGE · SHORTLIST/.test(html));
  step("archived page marked ARCHIVED", /PAGE · ARCHIVED/.test(html));
  await shot(p, "index-desktop");

  // ---- search ----
  await p.fill("#sv-find", "west village");
  await Promise.all([p.waitForURL(/q=west/), p.press("#sv-find", "Enter")]);
  await p.waitForLoadState("networkidle");
  const found = await rowTitles(p);
  step("search reads what a page says (west village → the dinner list), still pages only", JSON.stringify(found) === JSON.stringify(["Dinner, Friday, three that fit"]), JSON.stringify(found));
  step("search kept the pages filter", /kind=pages/.test(p.url()));
  await shot(p, "search");
  await p.goto(`${BASE}/web/saved?kind=pages&q=dentist`, { waitUntil: "networkidle" });
  step("search by title", JSON.stringify(await rowTitles(p)) === JSON.stringify(["Dentist options near work"]));
  await ctx.close();

  // ---- phone ----
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: "light", reducedMotion: "reduce", isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: "reason_page", value: ownerT, url: BASE }]);
  p = await ctx.newPage();
  await p.goto(`${BASE}/web/saved?kind=pages`, { waitUntil: "networkidle" });
  step("phone: the list, all six", (await rowTitles(p)).length === 6);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  step("phone: nothing wider than the screen", !overflow);
  await shot(p, "index-mobile");
  await ctx.close();

  // ---- a stranger, signed out, follows the same link ----
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: "light", reducedMotion: "reduce" });
  p = await ctx.newPage();
  await p.goto(`${BASE}/web/saved?kind=pages`, { waitUntil: "networkidle" });
  step("signed out: sent to sign in", new URL(p.url()).pathname === "/web" && (await p.locator("#number").count()) === 1, p.url());
  step("signed out: nothing of the owner's on the page", !/Dinner|Apartment|Omari/.test(await p.content()));
  await shot(p, "signin");
  await p.fill("#number", KOFI_N);
  await Promise.all([p.waitForURL(/\/web\/signin$/), p.press("#number", "Enter")]);
  for (let i = 0; i < 50 && !told.some(t => t.conv === KOFI_C); i++) await new Promise(r => setTimeout(r, 20));
  const code = /\b(\d{6})\b/.exec(told.filter(t => t.conv === KOFI_C).at(-1)?.line ?? "")?.[1];
  step("a code was made for the stranger's own account", !!code);
  await p.fill("#code", code ?? "000000");
  await p.waitForURL(/\/web\/saved/, { timeout: 4000 }).catch(async () => {
    await Promise.all([p.waitForURL(/\/web\/saved/, { timeout: 4000 }).catch(() => {}), p.evaluate(() => document.querySelector('form[action="/web/code"]').requestSubmit())]);
  });
  await p.waitForLoadState("networkidle");
  step("signing in lands back on Your pages", /\/web\/saved\?kind=pages$/.test(p.url()), p.url());
  const theirs = await rowTitles(p);
  step("the stranger sees only their own page", JSON.stringify(theirs) === JSON.stringify(["Kofi's gym plan"]), JSON.stringify(theirs));
  step("…and none of the owner's", !/Dinner|Apartment|Dentist|Accra|Birthday|Moving/.test(await p.content()));
  await ctx.close();

  // ---- an account with no pages ----
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: "light", reducedMotion: "reduce", isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: "reason_page", value: sess(AMA_C), url: BASE }]);
  p = await ctx.newPage();
  await p.goto(`${BASE}/web/saved?kind=pages`, { waitUntil: "networkidle" });
  step("empty: No pages yet", /No pages\s*yet\./.test(await p.locator("main").innerText()));
  await shot(p, "empty");
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
