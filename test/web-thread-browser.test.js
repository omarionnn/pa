// Reason Web v2, the thread's scrolling, driven in a real browser over real HTTP (Chromium from
// node_modules): handoff v2 §4b Prototype S2 + S3 and the loading sheet's L1 / L2 / L10.
//
//   opens at the bottom, and the "where you are" note names the latest day and device
//   scrolled back a day: the note crossfades to that day, TODAY ↓ shows inside the composer line and the
//     placeholder is "Reply from here"; TODAY ↓ goes back and both reset
//   a DONE line is a real button: aria-expanded, `N ↓` / `FOLD ↑`, the fold, the Caveat line goes once opened
//   L1: while the thread is on its way the composer already takes words; then it opens at the bottom
//   L2: ↑ FINDING EARLIER MESSAGES… while the earlier page comes, and the page doesn't jump
//   L10: "on it." with what it's doing and the honest line
//   reduced motion: no crossfade
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-thread-browser-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_STREAM = "off";
delete process.env.REASON_PAGES_URL;
delete process.env.REASON_SITE_URL;
delete process.env.REASON_PUBLIC_URL;

const { createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const { WebChannel } = await import("../src/channels/web.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const KOFI = "+14155559876", C = `dm:fake:${KOFI}`;
const DAY = 864e5, MIN = 60_000;
let server, base, app, running;

before(async () => {
  config.web = true;
  db.upsertAccount({ conversationId: C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  // Kofi texted before Web history began, so the thread's top says the rest stays in the texts.
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, created_at = 1");
  db.markWebNoticeSeen(C);
  const now = Date.now();
  // Midnight today in New York, so "today" and "yesterday" are those days whatever time the suite runs.
  const ny = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(now).map(p => [p.type, Number(p.value)]));
  const sod = now - ((ny.hour * 60 + ny.minute) * 60 + ny.second) * 1000;
  const today = (minsAgo) => Math.max(sod + (20 - minsAgo) * 1000, now - minsAgo * MIN);
  let ob = 0, n = 0;
  const msg = (role, text, at, channel = "fake") => {
    n++;
    if (role === "user") {
      const ext = channel === "web" ? `${C}:cid-${n}-abcdefgh` : `h-${n}`;
      if (channel === "web") db.db.prepare("INSERT INTO web_devices (conversation_id, client_id, device, at) VALUES (?, ?, ?, ?)").run(C, `cid-${n}-abcdefgh`, "computer", at);
      db.writeMessage({ conversationId: C, role, channel, externalId: ext, text, at });
      return { ext };
    }
    const o = ++ob;
    db.writeMessage({ conversationId: C, role, channel, outboxId: o, text, at });
    return { o };
  };
  const linkAll = (t, rs) => { for (const r of rs) db.db.prepare("INSERT INTO task_messages (conversation_id, task_id, external_id, outbox_id, created_at) VALUES (?, ?, ?, ?, ?)").run(C, t, r.ext ?? null, r.o ?? null, now); };
  // Forty-odd lines three weeks back, so there is an earlier page to find.
  for (let i = 0; i < 44; i++) msg(i % 2 ? "assistant" : "user", `older line ${i}`, now - 21 * DAY + i * MIN);
  // Four days back: a dentist call, done.
  const dentist = db.createTask(C, { title: "Dentist", goal: "Dentist", maxAttempts: 5, label: "Dentist, Thursday 3pm" });
  db.finishTask(C, dentist.id, { state: "done", outcome: "booked" });
  db.db.prepare("UPDATE tasks SET finished_at = ? WHERE id = ?").run(now - 4 * DAY, dentist.id);
  linkAll(dentist.id, [msg("user", "call the dentist and get me in this week", now - 4 * DAY - 20 * MIN), msg("assistant", "calling now.", now - 4 * DAY - 19 * MIN), msg("assistant", "thursday 3pm with dr. patel.", now - 4 * DAY)]);
  // Yesterday, over iMessage: plain lines, enough of them to scroll.
  for (let i = 0; i < 8; i++) msg(i % 2 ? "assistant" : "user", `yesterday line ${i}: somewhere upstate, under three hours, keep it under six hundred.`, sod - 12 * 60 * MIN + i * 10 * MIN);
  // Today on the web: a task that just finished, then the one still being worked.
  const hudson = db.createTask(C, { title: "Hudson", goal: "Hudson", maxAttempts: 5, label: "Hudson inn held" });
  db.finishTask(C, hudson.id, { state: "done", outcome: "held", result: { headline: "Hudson inn held, Nov 14–16", facts: ["$540"] } });
  linkAll(hudson.id, [msg("user", "Book it.", today(10), "web"), msg("assistant", "held. friday to sunday, $540.", today(5), "web")]);
  running = db.createTask(C, { title: "Dog sitter", goal: "Dog sitter", maxAttempts: 5, sheet: { steps: [{ text: "Call three", state: "doing", live: "calling three places" }] } });
  linkAll(running.id, [msg("user", "Can you find a dog sitter for that weekend?", today(2), "web")]);

  const router = new Router({ log: () => {} });
  router.register(new WebChannel());
  server = createServer({ router, runtime: null });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = await chromium.launch();
});
after(async () => {
  await app?.close();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

let k = 0;
async function open({ width = 390, height = 844, reduce = true, hold = null } = {}) {
  const token = `tok-thread-${++k}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${C}`, token, { conversationId: C });
  const ctx = await app.newContext({ viewport: { width, height }, reducedMotion: reduce ? "reduce" : "no-preference", timezoneId: "America/New_York" });
  await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let release = null;
  if (hold) await page.route(hold, async (route) => { await new Promise(r => { release = r; }); await route.continue(); });
  await page.goto(`${base}/web?thread`);
  return { ctx, page, errors, release: () => release?.() };
}
const atBottom = (page) => page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40);
const noteNow = (page) => page.$eval(".where", (w) => ({ label: w.getAttribute("aria-label"), on: w.querySelector(".wn-s.on")?.textContent, hidden: w.hidden }));

test("S2: opens at the bottom; the note names today and the laptop; a day back it says yesterday, TODAY ↓ shows in the line and takes you back", async () => {
  const { ctx, page, errors } = await open();
  await page.locator(".thread .msg").first().waitFor();
  await page.waitForTimeout(200);
  assert.ok(await atBottom(page), "the thread opens at the bottom");
  assert.deepEqual(await noteNow(page), { label: "today, on your laptop", on: "today, on your laptop", hidden: false });
  assert.equal(await page.locator(".today").isVisible(), false);
  assert.equal(await page.getAttribute("#c-input", "placeholder"), "Tell Reason what you need");
  // Scroll yesterday's lines under the top bar.
  await page.evaluate(() => { const d = [...document.querySelectorAll("li.day")].at(-2); window.scrollTo(0, d.getBoundingClientRect().top + window.scrollY - 60); });
  await page.waitForTimeout(250);
  assert.equal((await noteNow(page)).label, "yesterday, on your phone");
  assert.equal((await noteNow(page)).on, "yesterday, on your phone", "the slot showing is the new note");
  assert.equal(await page.locator(".where .wn-s.on").count(), 1, "one slot shows at a time");
  assert.ok(await page.locator(".cform .today").isVisible(), "TODAY ↓ inside the composer line");
  assert.equal(await page.getAttribute("#c-input", "placeholder"), "Reply from here");
  const box = await page.locator(".today").boundingBox(), line = await page.locator(".cform").boundingBox();
  assert.ok(box.y >= line.y && box.y + box.height <= line.y + line.height + 1, "it sits in the line, not over the thread");
  await page.locator(".today").click();
  await page.waitForTimeout(300);
  assert.ok(await atBottom(page));
  assert.equal(await page.locator(".today").isVisible(), false);
  assert.equal(await page.getAttribute("#c-input", "placeholder"), "Tell Reason what you need");
  assert.equal((await noteNow(page)).label, "today, on your laptop");
  // Four days back: the weekday, on the phone.
  await page.evaluate(() => { const d = [...document.querySelectorAll("li.day")].at(-3); window.scrollTo(0, d.getBoundingClientRect().top + window.scrollY - 60); });
  await page.waitForTimeout(250);
  assert.match((await noteNow(page)).label, /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday), on your phone$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("S2: with motion, the two slots crossfade (0.5 s opacity, 0.6 s transform); reduced motion, none", async () => {
  const { ctx, page } = await open({ reduce: false });
  await page.locator(".thread .msg").first().waitFor();
  const t = await page.$eval(".wn-s", (s) => getComputedStyle(s).transition);
  assert.match(t, /opacity 0\.5s( ease)?,/);
  assert.match(t, /transform 0\.6s cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
  await ctx.close();
  const calm = await open({ reduce: true });
  await calm.page.locator(".thread .msg").first().waitFor();
  assert.match(await calm.page.$eval(".wn-s", (s) => getComputedStyle(s).transitionDuration), /^0s/);
  await calm.ctx.close();
});

test("S3: a DONE line opens and folds; the 'just wrapped' line goes once it's been opened, and stays gone", async () => {
  const { ctx, page } = await open({ width: 1280, height: 900 });
  const fresh = page.locator(".done[data-fresh]");
  await fresh.waitFor();
  const b = fresh.locator(".dl");
  assert.equal(await b.getAttribute("aria-expanded"), "false");
  assert.equal(await fresh.locator(".dl-n").textContent(), "2 ↓");
  assert.equal(await fresh.locator(".fold").isVisible(), false);
  assert.ok(await fresh.locator(".dl-fresh").isVisible());
  assert.match(await fresh.locator(".dl-meta").textContent(), /^JUST NOW · \$540 · WEB$/);
  await b.click();
  assert.equal(await b.getAttribute("aria-expanded"), "true");
  assert.equal(await fresh.locator(".dl-n").textContent(), "FOLD ↑");
  assert.ok(await fresh.locator(".fold").isVisible());
  assert.deepEqual(await fresh.locator(".fold p").allTextContents(), ["Book it.", "held. friday to sunday, $540."]);
  assert.equal(await fresh.locator(".dl-fresh").count(), 0);
  await b.click();
  assert.equal(await b.getAttribute("aria-expanded"), "false");
  assert.equal(await fresh.locator(".dl-n").textContent(), "2 ↓");
  // An older DONE line folds the same way and never had the line.
  assert.equal(await page.locator(".done:not([data-fresh]) .dl-fresh").count(), 0);
  await page.reload();
  await page.locator(".done[data-fresh]").waitFor();
  assert.equal(await page.locator(".done[data-fresh] .dl-fresh").count(), 0, "opened once in this browser: it stays gone");
  await ctx.close();
});

test("L1: while the thread is on its way, OPENING YOUR THREAD… holds its place and the composer already takes words", async () => {
  const { ctx, page, release, errors } = await open({ hold: "**/web/history" });
  await page.locator(".l1").waitFor();
  assert.equal(await page.locator(".l1 [role=status]").textContent(), "OPENING YOUR THREAD…");
  assert.equal(await page.locator(".l1 .gh").count(), 3);
  assert.equal(await page.locator(".thread .msg").count(), 0);
  assert.ok(await page.locator(".tabs").isVisible(), "the tabs are live at once");
  await page.locator("#c-input").fill("typing before it loads");
  assert.equal(await page.inputValue("#c-input"), "typing before it loads");
  release();
  await page.locator(".thread .msg").first().waitFor();
  assert.equal(await page.locator(".l1").count(), 0);
  assert.equal(await page.getAttribute(".thread", "aria-busy"), null);
  assert.equal(await page.inputValue("#c-input"), "typing before it loads", "nothing they typed is lost");
  await page.waitForTimeout(150);
  assert.ok(await atBottom(page));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("L2: ↑ FINDING EARLIER MESSAGES… while the earlier page comes; it lands above without moving what you're reading", async () => {
  const { ctx, page } = await open({ width: 1280, height: 900 });
  await page.locator(".start button").waitFor({ state: "attached" });
  let release;
  await page.route("**/web/history?before=*", async (route) => { await new Promise(r => { release = r; }); await route.continue(); });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".start button").click();
  await page.locator(".start [role=status]").waitFor();
  assert.equal(await page.locator(".start [role=status]").textContent(), "↑ FINDING EARLIER MESSAGES…");
  assert.equal(await page.locator(".start .gh").count(), 1);
  const anchor = page.locator(".thread .msg").first();
  const id = await anchor.getAttribute("data-id");
  const before = (await page.locator(`.msg[data-id="${id}"]`).boundingBox()).y;
  release();
  await page.locator(".start [role=status]").waitFor({ state: "detached" });
  const after = (await page.locator(`.msg[data-id="${id}"]`).boundingBox()).y;
  assert.ok(Math.abs(after - before) < 4, `the line being read stays put (${before} → ${after})`);
  assert.ok(await page.locator(".msg", { hasText: "older line 0" }).count(), "the earliest line arrived");
  assert.match(await page.locator(".start").textContent(), /stays in your texts/);
  assert.equal(await page.locator("li.day").evaluateAll(ds => new Set(ds.map(d => d.dataset.day)).size === ds.length), true, "one label per day");
  await ctx.close();
});

test("L10: on it, calling three places, and the honest line, under what they asked", async () => {
  const { ctx, page } = await open();
  await page.locator(".longwork").waitFor();
  assert.equal(await page.locator(".longwork .lw-line").textContent(), "on it. calling three places.");
  assert.equal(await page.locator(".longwork .lw-note").textContent(), "This one takes a few minutes. You can close this; it's in Ongoing, and I'll text you.");
  assert.equal(await page.getAttribute(".longwork .lw-on", "role"), "status");
  await ctx.close();
});
