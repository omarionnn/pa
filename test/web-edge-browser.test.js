// Reason Web's v2 edge work, driven in a real browser over real HTTP (Chromium from node_modules):
//
//   L6   "Text me a code →" becomes "Texting you a code…": muted, a status, not a button; the number muted
//   L7   the six digits stay and CHECKING… takes the note's place
//   6B   a wrong code stays in the cells and every underline is pen (SR9)
//   L3   the Ongoing tab: headings at once from what the page knows, a ghost card for NEEDS YOU, ghost
//        rows for the rest, GATHERING WHAT'S IN HAND… — then the real page, fetched, in its place
//   L4   a row's detail: its status and title at once, ruled lines, PUTTING THE SUMMARY TOGETHER…
//   L5   past 8 s: STILL LOOKING…, the Caveat line, Try again → (fetches again) and BACK TO CHAT
//   9B   the fetch fails: Something went wrong. Nothing was lost.
//   E1   an unknown /web address; E5 the maintenance switch
//   F1   the skip link is the first Tab and lands one Tab before the composer; the ring is 2px ink 3px out
//
// The server is never slowed: the browser's own network is held (Playwright route) to see each
// loading screen for as long as the test wants, exactly as a slow connection would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-edge-browser-"));
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
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const edge = await import("../src/pages/webedge.js");
const { seedOngoing } = await import("./fixture-ongoing.js");
const { chromium } = await import("playwright");

const KOFI = "+14155559876", KOFI_C = `dm:fake:${KOFI}`;
let server, base, browserApp, fake, ids;

before(async () => {
  config.web = true;
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
  db.markWebNoticeSeen(KOFI_C);
  ids = seedOngoing(KOFI_C);
  const router = new Router({ log: () => {} });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  const runtime = new Runtime({ log: () => {}, channels: router, deliver, runTurn: async () => "ok" });
  router.runtime = runtime;
  router.register(consoleChannel);
  fake = router.register(new FakeChannel({ number: "+16562167455" }));
  router.register(new WebChannel());
  server = createServer({ router, runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browserApp = await chromium.launch();
});
after(async () => {
  await browserApp?.close();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function open(path, { width = 390, height = 844, signedIn = true, reduced = true } = {}) {
  const ctx = await browserApp.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference" });
  if (signedIn) {
    const token = `tok-edge-${++n}-${Math.random().toString(36).slice(2)}`;
    db.startPageSession(`wsign:${KOFI_C}`, token, { conversationId: KOFI_C });
    await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}${path}`);
  return { ctx, page, errors };
}
/** Hold the browser's next request to `match` until the returned release() is called. */
async function hold(page, match) {
  let release, seen;
  const gate = new Promise(r => { release = r; });
  const asked = new Promise(r => { seen = r; });
  await page.route(match, async (route) => { seen(route.request()); await gate; await route.continue(); }, { times: 1 });
  return { release, asked };
}

test("L6 + L7 + 6B: the code is on its way, then being checked; a wrong one stays in the cells, every underline in pen", async () => {
  const { ctx, page, errors } = await open("/web", { signedIn: false });
  try {
    await page.fill("#number", "(415) 555-9876");
    // Hold each form where the browser would be waiting on the server: the page's own submit handler
    // runs first (it was added first); this one, added after, keeps the browser from leaving, so what
    // the person sees while it waits can be read. Then the form is sent for real.
    const holdForms = () => page.evaluate(() => document.querySelectorAll("form").forEach(f => f.addEventListener("submit", (e) => { e.preventDefault(); window.__held = f; })));
    await holdForms();
    await page.click("button.act[type=submit]");
    // L6: the action's own words, muted, a status, nothing left to press.
    const busy = page.locator(".so-in span.act.busy[role=status]");
    await busy.waitFor();
    assert.equal((await busy.textContent()).trim(), "Texting you a code…");
    assert.equal(await page.locator(".so-in button.act").count(), 0, "not pressable twice");
    assert.equal(await page.locator("#number").evaluate(i => i.readOnly), true);
    assert.equal(await busy.evaluate(e => getComputedStyle(e).color), "rgb(120, 112, 95)", "muted ink");
    await Promise.all([page.waitForURL("**/web/signin"), page.evaluate(() => window.__held.submit())]);
    await page.locator("#code").waitFor();
    assert.equal(fake.sent.length, 1, "the account's own number got its one code");
    // L7: six digits in, the form goes by itself; the digits stay, CHECKING… under them.
    await holdForms();
    await page.locator("#code").pressSequentially("000000");
    const checking = page.locator(".code-f p.lbl.checking[role=status]");
    await checking.waitFor();
    assert.equal((await checking.textContent()).trim(), "CHECKING…");
    assert.deepEqual(await page.locator(".digits .cell").allTextContents(), ["0", "0", "0", "0", "0", "0"]);
    assert.equal(await page.locator(".code-f .hand").count(), 0, "the note gave way to CHECKING…");
    assert.equal(await page.locator("#code").evaluate(i => i.readOnly), true);
    await Promise.all([page.waitForNavigation(), page.evaluate(() => window.__held.submit())]);
    // 6B: wrong. The digits stay; all six underlines and the input's own rule are pen; the Caveat line is the alert.
    await page.locator("#code-note[role=alert]").waitFor();
    assert.equal((await page.locator("#code-note").textContent()).trim(), "that's not it. try again?");
    assert.deepEqual(await page.locator(".digits .cell").allTextContents(), ["0", "0", "0", "0", "0", "0"]);
    const lines = await page.locator(".digits .cell").evaluateAll(cs => cs.map(c => getComputedStyle(c).borderBottomColor));
    assert.deepEqual([...new Set(lines)], ["rgb(156, 59, 46)"], "every underline in pen");
    // Typing again replaces the wrong code (it was selected on focus), and the pen goes.
    await page.locator("#code").press("1");
    assert.equal(await page.locator("#code").inputValue(), "1");
    assert.equal(await page.locator(".digits.bad").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("L3: the Ongoing tab draws its headings at once, a ghost card and ghost rows, then the real page fetched in its place", async () => {
  const { ctx, page, errors } = await open("/web?thread");
  try {
    // Something of the thread page's own running, as its script would: a timer and a live stream.
    await page.evaluate(() => { window.__ticks = 0; setInterval(() => { window.__ticks++; }, 50); window.__es = new EventSource("/web/stream"); });
    const h = await hold(page, (u) => u.search === "?tab=ongoing");
    await page.click('.tabs a[href="/web?tab=ongoing"]');
    await h.asked;
    const main = page.locator("main.ld");
    await main.waitFor();
    assert.equal(await page.evaluate(() => location.pathname + location.search), "/web?tab=ongoing", "the address is the screen's at once");
    assert.equal((await main.locator("h1").textContent()), "Ongoing");
    assert.equal((await main.locator("[role=status]").textContent()), "GATHERING WHAT’S IN HAND…");
    // The headings the page already knew, in order, NEEDS YOU in pen with a ghost card; the rest ghost rows.
    const heads = await main.locator(".ld-sec > h2").evaluateAll(hs => hs.map(h => [h.textContent, h.classList.contains("pen")]));
    assert.deepEqual(heads.map(x => x[0].replace(/ · \d+$/, "")), ["NEEDS YOU", "IN HAND", "BACK TO YOU"]);
    assert.equal(heads[0][1], true);
    assert.ok(await main.locator(".ld-sec").first().locator(".ld-card").count() >= 1, "NEEDS YOU: a ghost card");
    assert.ok(await main.locator(".ld-sec").nth(1).locator(".ld-row").count() >= 1, "IN HAND: ghost rows");
    // Ruled lines in the border colour; no spinner, no shimmer.
    assert.equal(await main.locator(".ln").first().evaluate(e => getComputedStyle(e).backgroundColor), "rgb(212, 201, 181)");
    assert.equal(await page.locator(".tabs a[aria-current=page]").textContent().then(t => t.replace(/\d+$/, "")), "Ongoing");
    h.release();
    await page.locator("main.og-list").waitFor();
    assert.equal(await page.title(), "Reason — Ongoing");
    assert.equal(await page.locator("main.ld").count(), 0);
    // Whatever the thread page left running (its timers, its live stream) stopped with it.
    const t1 = await page.evaluate(() => window.__ticks);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__ticks), t1, "the old page's interval is stopped");
    assert.equal(await page.evaluate(() => window.__es.readyState), 2, "its stream is closed");
    // The real page's own script ran: its menu opens.
    await page.click(".menu-b");
    assert.equal(await page.locator("#menu").isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("L3 motion: without reduced motion the ruled lines fade gently (1.6 s), never a spinner", async () => {
  const { ctx, page } = await open("/web?thread", { reduced: false });
  try {
    const h = await hold(page, (u) => u.search === "?tab=ongoing");
    await page.click('.tabs a[href="/web?tab=ongoing"]');
    await h.asked;
    const a = await page.locator("main.ld .ld-row").first().evaluate(e => [getComputedStyle(e).animationName, getComputedStyle(e).animationDuration]);
    assert.deepEqual(a, ["ld-fade", "1.6s"]);
    h.release();
  } finally { await ctx.close(); }
});

test("L4: a row's detail shows what's known (status, title) at once, then ruled lines and the typed status; then the real detail", async () => {
  const { ctx, page, errors } = await open("/web?tab=ongoing&all=1");
  try {
    const href = `/web/ongoing/task/${ids.waiting}`;
    const h = await hold(page, `**${href}`);
    await page.click(`a.ogv[href="${href}"]`);
    await h.asked;
    const main = page.locator("main.ld.ld-d");
    await main.waitFor();
    assert.equal(await page.locator(".ld-h a.act2").textContent(), "← ONGOING");
    assert.match(await main.locator("p.lbl").first().textContent(), /^WAITING/);
    assert.equal(await main.locator("h1").textContent(), "Refund for the boots");
    assert.equal(await main.locator("[role=status]").textContent(), "PUTTING THE SUMMARY TOGETHER…");
    assert.equal(await main.locator(".ld-rule").count(), 1);
    assert.equal(await main.locator(".ld-lines.wide .ln").count(), 5);
    h.release();
    await page.locator("main.ogd").waitFor();
    assert.equal(await page.locator("main.ogd h1").textContent(), "Refund for the boots");
    assert.equal(new URL(page.url()).pathname, href);
    // Back: the Ongoing tab again, drawn by the server.
    await page.goBack();
    await page.locator("main.og-list").waitFor();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("L5: past eight seconds STILL LOOKING…, the Caveat line, Try again → fetches again; BACK TO CHAT leaves", async () => {
  const { ctx, page, errors } = await open("/web?thread");
  try {
    await page.clock.install();
    await page.reload();
    const h = await hold(page, (u) => u.search === "?tab=ongoing");
    await page.click('.tabs a[href="/web?tab=ongoing"]');
    await h.asked;
    await page.clock.fastForward(8100);
    await page.locator("main.ld .ld-slow").waitFor();
    assert.equal(await page.locator("main.ld [role=status]").textContent(), "STILL LOOKING…");
    assert.equal(await page.locator("main.ld .ld-slow .hand").textContent(), "taking a little longer than usual. still here.");
    assert.equal(await page.locator("main.ld .ld-slow a.act2").getAttribute("href"), "/web?thread");
    assert.equal((await page.locator("main.ld .ld-slow a.act2").textContent()), "BACK TO CHAT");
    // Try again → asks again; the first, still held, is dropped.
    const again = await hold(page, (u) => u.search === "?tab=ongoing");
    await page.click("main.ld .ld-slow button.act");
    await again.asked;
    assert.equal(await page.locator("main.ld .ld-slow").count(), 0);
    assert.equal(await page.locator("main.ld [role=status]").textContent(), "GATHERING WHAT’S IN HAND…");
    again.release();
    h.release();
    await page.locator("main.og-list").waitFor();
    assert.deepEqual(errors.filter(e => !/abort/i.test(e)), []);
  } finally { await ctx.close(); }
});

test("9B: when the fetch fails, the global error takes the page", async () => {
  const { ctx, page } = await open("/web?thread");
  try {
    await page.route((u) => u.search === "?tab=ongoing", (route) => route.abort("failed"), { times: 1 });
    await page.click('.tabs a[href="/web?tab=ongoing"]');
    await page.locator("main.ld-err").waitFor();
    assert.match(await page.locator("main.ld-err h1").textContent(), /^Something went wrong\.Nothing was lost\.$/);
    assert.equal(await page.locator("main.ld-err a.act").getAttribute("href"), `${base}/web?tab=ongoing`);
  } finally { await ctx.close(); }
});

test("E1: an unknown /web address is the calm 404; the way back to the thread only when signed in", async () => {
  for (const signedIn of [true, false]) {
    const { ctx, page } = await open("/web/nothing-here", { signedIn });
    try {
      assert.equal(await page.locator("main.eg h1").textContent(), "This page isn’t here.Nothing’s lost.");
      assert.equal(await page.locator('a.act[href="/web?thread"]').count(), signedIn ? 1 : 0);
    } finally { await ctx.close(); }
  }
});

test("E5: the maintenance switch shows BACK BY ABOUT {time} ET and Text Reason → with its hint, then lifts", async () => {
  const until = Date.now() + 45 * 60_000;
  edge.startMaintenance({ until, by: "test" });
  try {
    const { ctx, page } = await open("/web?thread");
    try {
      assert.equal(await page.locator("main.eg-m .lbl").first().textContent(), `BACK BY ABOUT ${edge.etTime(until)} ET`);
      assert.equal(await page.locator("main.eg-m .tr a.act").getAttribute("href"), "sms:+16562167455&body=hey");
      assert.equal(await page.locator("main.eg-m .tr-h").textContent(), "OPENS MESSAGES WITH “HEY” READY TO SEND");
    } finally { await ctx.close(); }
  } finally { edge.endMaintenance(); }
  const { ctx, page } = await open("/web?thread");
  try {
    await page.locator("ol.thread").waitFor({ state: "attached" });
    assert.equal(await page.locator("main.eg-m").count(), 0, "lifted: the thread again");
  } finally { await ctx.close(); }
});

test("F1: the first Tab is the skip link on a paper slip; it lands one Tab before the composer; one 2px ink ring 3px out", async () => {
  const { ctx, page } = await open("/web?thread", { width: 1280, height: 900 });
  try {
    await page.keyboard.press("Tab");
    const skip = page.locator("a.skip");
    assert.equal(await page.evaluate(() => document.activeElement.className), "skip");
    assert.equal(await skip.textContent(), "SKIP TO THE THREAD ↓");
    const s = await skip.evaluate(e => { const c = getComputedStyle(e); return [c.position, c.backgroundColor, c.outlineStyle, c.outlineWidth, c.outlineOffset, c.outlineColor, c.borderRadius]; });
    assert.deepEqual(s, ["fixed", "rgb(250, 246, 238)", "solid", "2px", "3px", "rgb(42, 37, 32)", "3px"]);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "thread");
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => !!document.activeElement.closest(".composer")), "the composer is one Tab after the skip");
    // The input line: no ring; its rule thickens to 2px ink; the caret is pen.
    await page.focus("#c-input");
    const line = await page.evaluate(() => { const i = document.getElementById("c-input"), f = i.closest(".cform"); return [getComputedStyle(i).outlineStyle, getComputedStyle(f).borderTopWidth, getComputedStyle(i).caretColor]; });
    assert.deepEqual(line, ["none", "2px", "rgb(156, 59, 46)"]);
  } finally { await ctx.close(); }
});
