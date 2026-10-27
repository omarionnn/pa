// v4 handoff §4h items 2, 3 and 7 (reference sheet-small-details.html), driven in a real browser over
// real HTTP (Chromium from node_modules):
//
//   2  the pen writes itself in: "on it." after a send, and the "just wrapped" note of a task that
//      finishes while the page is open, reveal left to right (0.5s, clip-path, cubic-bezier(.4,.1,.3,1));
//      nothing drawn at load, from history, or on a reload ever does
//   3  the stamp lands: the DONE stamp of a task that finishes while they watch presses in once (0.45s,
//      scale 1.8 → .92 → 1, cubic-bezier(.3,1.4,.5,1)) and keeps its tilt; stamps on screen at load don't
//   7  paper grain on the ground (never on lifted paper), off for prefers-contrast: more; on Night between
//      23:00 and 05:00 on the browser's own clock the ground is #221a13, fading over 2s when it turns
//   reduced motion: the end state at once
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-4h-motion-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_STREAM = "off";
delete process.env.REASON_PAGES_URL;
delete process.env.REASON_SITE_URL;
delete process.env.REASON_PUBLIC_URL;
delete process.env.GEMINI_API_KEY;

const { createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const KOFI = "+14155559876", C = `dm:fake:${KOFI}`;
let server, base, app, hold = null;

before(async () => {
  config.web = true;
  db.upsertAccount({ conversationId: C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
  db.markWebNoticeSeen(C);
  // One task already done when the page opens: its stamp must never animate.
  const now = Date.now();
  const t = db.createTask(C, { title: "Dentist", goal: "Dentist", maxAttempts: 5, label: "Dentist, Thursday 3pm" });
  db.writeMessage({ conversationId: C, role: "user", channel: "fake", externalId: "h-1", text: "get me into the dentist", at: now - 30 * 60_000 });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "fake", outboxId: 1, text: "thursday 3pm.", at: now - 29 * 60_000 });
  link(t.id, [{ ext: "h-1" }, { o: 1 }]);
  db.finishTask(C, t.id, { state: "done", outcome: "booked" });
  const router = new Router({ log: () => {} });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  const runtime = new Runtime({ log: () => {}, channels: router, deliver, runTurn: async (args) => { if (hold) await hold; return `re: ${args.text}`; } });
  router.runtime = runtime;
  router.register(consoleChannel);
  router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  server = createServer({ router, runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = await chromium.launch();
});
after(async () => {
  await app?.close();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function link(taskId, rows) {
  for (const r of rows) db.db.prepare("INSERT INTO task_messages (conversation_id, task_id, external_id, outbox_id, created_at) VALUES (?, ?, ?, ?, ?)").run(C, taskId, r.ext ?? null, r.o ?? null, Date.now());
}

// Every time an element is given pen-in / stamp-in (once per element per batch: classList.remove of an
// absent class still writes the attribute), what it is and how it is moving at that moment.
const WATCH = `(() => { window.__ink = []; new MutationObserver((ms) => { const once = new Set(); for (const m of ms) { const el = m.target; if (m.attributeName !== 'class' || !el.classList || once.has(el)) continue;
  for (const c of ['pen-in', 'stamp-in']) if (el.classList.contains(c) && !(m.oldValue || '').split(' ').includes(c)) { once.add(el); const s = getComputedStyle(el);
    window.__ink.push({ c, cls: el.className, text: el.textContent, name: s.animationName, dur: s.animationDuration, ease: s.animationTimingFunction, transform: el.style.transform }); } } })
  .observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true }); })();`;

let k = 0;
async function open({ reduce = false, scheme = "light", path = "/web?thread", clock = null, contrast = "no-preference" } = {}) {
  const token = `tok-4h-${++k}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${C}`, token, { conversationId: C });
  const ctx = await app.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: reduce ? "reduce" : "no-preference", colorScheme: scheme, contrast, timezoneId: "America/New_York" });
  await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
  await ctx.addInitScript(WATCH);
  const page = await ctx.newPage();
  if (clock) await page.clock.install({ time: clock });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}${path}`);
  return { ctx, page, errors };
}
const ink = (page) => page.evaluate(() => window.__ink);
const poll = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

test("§4h 2 + 3: nothing on screen at load writes itself in or lands; a reload of a just-finished task doesn't either", async () => {
  const { ctx, page, errors } = await open();
  await page.locator(".done .dl-st").first().waitFor();
  await page.waitForTimeout(600);
  await poll(page);
  await page.waitForTimeout(400);
  assert.deepEqual(await ink(page), []);
  assert.equal(await page.$eval(".done .dl-st", (s) => s.getAnimations().length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("§4h 2: \"on it.\" writes itself in after a send, left to right over 0.5s", async () => {
  let go; hold = new Promise(r => { go = r; });
  const { ctx, page, errors } = await open();
  await page.locator("#c-input").waitFor();
  await page.fill("#c-input", "find me a plumber for saturday");
  await page.press("#c-input", "Enter");
  await page.locator(".onit:not([hidden])").waitFor();
  // §4h 4's "take it back" under the message writes itself in too; this is about "on it.".
  const got = (await ink(page)).filter(x => x.c === "pen-in" && x.text === "on it.");
  assert.equal(got.length, 1);
  assert.match(got[0].cls, /\bhand\b/);
  assert.equal(got[0].text, "on it.");
  assert.equal(got[0].name, "pen-in");
  assert.equal(got[0].dur, "0.5s");
  assert.equal(got[0].ease, "cubic-bezier(0.4, 0.1, 0.3, 1)");
  go(); hold = null;
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  await ctx.close();
});

async function finishWhileWatching({ reduce }) {
  const { ctx, page, errors } = await open({ reduce });
  await page.locator(".done .dl-st").first().waitFor();
  const now = Date.now(), n = ++k;
  db.writeMessage({ conversationId: C, role: "user", channel: "fake", externalId: `h-live-${n}`, text: `book the 7:30 at peaches ${n}`, at: now });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "fake", outboxId: 1000 + n, text: `booked ${n}.`, at: now + 1 });
  await poll(page);
  await page.locator(".msg.re", { hasText: `booked ${n}.` }).waitFor();
  const t = db.createTask(C, { title: `Peaches ${n}`, goal: "Peaches", maxAttempts: 5, label: `Peaches, 7:30 (${n})` });
  link(t.id, [{ ext: `h-live-${n}` }, { o: 1000 + n }]);
  db.finishTask(C, t.id, { state: "done", outcome: "booked" });
  await poll(page);
  await page.locator(`.done[data-task="${t.id}"]`).waitFor();
  return { ctx, page, errors, task: t.id };
}

test("§4h 3 + 2: a task that finishes while they watch: its DONE stamp lands (0.45s, keeps its tilt) and the note writes itself in; once", async () => {
  const { ctx, page, errors, task } = await finishWhileWatching({ reduce: false });
  const got = await ink(page);
  const st = got.filter(x => x.c === "stamp-in");
  assert.equal(st.length, 1, "the one stamp that is new");
  assert.match(st[0].cls, /\bdl-st\b/);
  assert.equal(st[0].text, "DONE");
  assert.equal(st[0].name, "stamp-in");
  assert.equal(st[0].dur, "0.45s");
  assert.equal(st[0].ease, "cubic-bezier(0.3, 1.4, 0.5, 1)");
  assert.match(st[0].transform, /^rotate\(-?\d+deg\)$/, "the tilt stays in transform; the press is scale");
  const pen = got.filter(x => x.c === "pen-in");
  assert.equal(pen.length, 1);
  assert.equal(pen[0].text, "just wrapped this one up. tap to see how.");
  // The keyframes are the sheet's: 1.8 → .92 → 1, opacity 0 → 1.
  const frames = await page.$eval(`.done[data-task="${task}"] .dl-st`, (s) => { for (const sh of document.styleSheets) for (const r of sh.cssRules) if (r.name === "stamp-in") return [...r.cssRules].map(f => `${f.keyText} ${f.style.opacity} ${f.style.scale}`); return null; });
  assert.deepEqual(frames, ["0% 0 1.8", "58% 1 0.92", "100% 1 1"]);
  await page.waitForTimeout(700);
  assert.equal(await page.$eval(`.done[data-task="${task}"] .dl-st`, (s) => s.classList.contains("stamp-in")), false, "played once, then gone");
  await poll(page);
  await page.waitForTimeout(300);
  assert.equal((await ink(page)).length, got.length, "the next poll does not play it again");
  // Reloaded: the same stamp is on screen at load, so it stays still.
  await page.reload();
  await page.locator(`.done[data-task="${task}"] .dl-st`).waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(await ink(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("§4h reduced motion: the stamp and the note are simply there, no movement", async () => {
  const { ctx, page, task } = await finishWhileWatching({ reduce: true });
  const st = (await ink(page)).filter(x => x.c === "stamp-in");
  assert.equal(st.length, 1);
  assert.equal(st[0].name, "none");
  assert.equal(await page.$eval(`.done[data-task="${task}"] .dl-st`, (s) => getComputedStyle(s).opacity), "1");
  await ctx.close();
});

const GROUND = { paper: "rgb(242, 235, 224)", night: "rgb(28, 24, 20)", late: "rgb(34, 26, 19)" };
const look = (page) => page.evaluate(() => ({
  ground: getComputedStyle(document.body).backgroundColor,
  grain: getComputedStyle(document.body).backgroundImage,
  size: getComputedStyle(document.body).backgroundSize,
  attach: getComputedStyle(document.body).backgroundAttachment,
  topAttach: document.querySelector(".top") ? getComputedStyle(document.querySelector(".top")).backgroundAttachment : null,
  top: document.querySelector(".top") ? getComputedStyle(document.querySelector(".top")).backgroundImage : null,
  card: document.querySelector(".card") ? getComputedStyle(document.querySelector(".card")).backgroundImage : null,
  late: document.documentElement.classList.contains("late"),
}));

test("§4h 7: grain on the ground (and the bars drawn in it), never on lifted paper; off for prefers-contrast: more", async () => {
  for (const scheme of ["light", "dark"]) {
    const { ctx, page } = await open({ scheme, path: "/web/settings" });
    const l = await look(page);
    assert.match(l.grain, /^url\("data:image\/svg\+xml,.*feTurbulence.*fractalNoise.*baseFrequency='\.85'.*numOctaves='3'/);
    assert.equal(l.size, "160px 160px");
    assert.equal(l.attach, "fixed", "one tiling anchor for the page and every bar");
    if (l.card !== null) assert.equal(l.card, "none", "lifted paper stays flat");
    await ctx.close();
  }
  const th = await open({});
  await th.page.locator(".top").waitFor();
  assert.match((await look(th.page)).top, /^url\("data:image\/svg/, "the sticky top bar carries the same grain, so it never reads as a flat strip");
  assert.equal((await look(th.page)).topAttach, "fixed", "tiled from the same anchor: no seam at its edge");
  await th.ctx.close();
  const more = await open({ contrast: "more", path: "/web/settings" });
  assert.equal((await look(more.page)).grain, "none");
  await more.ctx.close();
});

test("§4h 7: late night is Night only, 23:00–05:00 on the browser's clock; it fades in over 2s when it turns", async () => {
  // The browser's clock, in its own zone (America/New_York, EDT on Oct 27 2026).
  const at = (h, m) => new Date(`2026-10-27T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`);
  const cases = [[22, 59, false], [23, 0, true], [4, 59, true], [5, 0, false]];
  for (const [h, m, late] of cases) {
    const { ctx, page } = await open({ scheme: "dark", path: "/web/settings", clock: at(h, m) });
    const l = await look(page);
    assert.equal(l.late, late, `${h}:${m}`);
    assert.equal(l.ground, late ? GROUND.late : GROUND.night, `${h}:${m}`);
    await ctx.close();
  }
  // Paper at midnight: nothing changes.
  const paper = await open({ scheme: "light", path: "/web/settings", clock: at(0, 30) });
  assert.equal((await look(paper.page)).ground, GROUND.paper);
  await paper.ctx.close();
  // Open at 22:59, the minute turns: the class arrives with the 2s fade, and the fade ends at #221a13.
  const { ctx, page } = await open({ scheme: "dark", path: "/web/settings", clock: at(22, 59) });
  assert.equal((await look(page)).late, false);
  await page.clock.runFor(61_000);
  const mid = await page.evaluate(() => ({ late: document.documentElement.classList.contains("late"), go: document.documentElement.classList.contains("late-go"), t: getComputedStyle(document.documentElement).transition }));
  assert.equal(mid.late, true);
  assert.equal(mid.go, true);
  assert.match(mid.t, /--ground 2s/);
  await page.clock.runFor(3_000);
  await page.waitForTimeout(2300);
  assert.equal((await look(page)).ground, GROUND.late);
  await ctx.close();
});
