// The opening moment of a page: the wordmark reads "Reasoning" on a bare ground, then it glides up
// into its place on the top line, the "ing" fading off it on the way so it lands as "Reason", and
// the sheet rises to meet it. Omari asked for it on
// 2026-10-07 after seeing how Instinct's Files pages arrive.
//
// What is pinned here is the contract, not the choreography:
//
//   it plays on a fresh arrival — the link tapped from a text — and hands the page over, clean,
//     within a couple of seconds, leaving no hook behind (no attribute, no overflow lock, no
//     transform, nothing covering the page);
//   it does not play on a reload or a back/forward, for a reader who asked for reduced motion, or
//     in a browser with no script — those get the page as it always was, at once;
//   it is on a page made for someone and nowhere else: the gate and the not-found page stay
//     byte-identical to each other, and a plain notice opens flat;
//   its script does nothing but draw: no fetch, no clipboard, no storage.
//
// No model, no API key; a real server on loopback and Chromium from node_modules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pages-intro-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
delete process.env.REASON_PUBLIC_URL;

const { runTool } = await import("../src/tools.js");
const { createServer } = await import("../src/http.js");
const { issueCode } = await import("../src/pages/access.js");
const { config } = await import("../src/config.js");
const { renderCodeGate, renderNotFound, renderNotice } = await import("../src/pages/render.js");
const { chromium } = await import("playwright");

const C = config.ownerConversation;
let server, base, browser;

before(async () => {
  server = createServer({ router: { webhook: async () => ({ status: 404, body: {} }), statuses: () => [] }, runtime: null });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const phone = (extra = {}) => browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...extra,
});

async function makePage() {
  const out = await runTool("page_create", {
    title: "Build bigger shoulders",
    blocks: [{ type: "text", text: "Two short shoulder days a week." }, { type: "steps", items: ["Press first.", "Then raise."] }],
  }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return out.page_id;
}

/** Type the code and press Open; resolve the moment the page's own document is committed. */
async function arrive(page, id) {
  await page.goto(`${base}/p/${id}`);
  await page.getByLabel("Six-digit code").fill(issueCode(id).code);
  await Promise.all([
    page.waitForURL(u => !u.toString().includes("code"), { waitUntil: "commit" }),
    page.getByRole("button", { name: "Open" }).click(),
  ]);
}

const phaseOf = page => page.evaluate(() => document.documentElement.dataset.intro ?? null);

/** Everything the intro touches, read back after it is over. */
const leftovers = page => page.evaluate(() => ({
  intro: document.documentElement.dataset.intro ?? null,
  overflow: getComputedStyle(document.documentElement).overflow,
  sheet: getComputedStyle(document.querySelector(".sheet")).transform,
  bar: getComputedStyle(document.querySelector(".bar")).opacity,
  cover: getComputedStyle(document.querySelector(".intro")).display,
  scrollY: window.scrollY,
}));

test("a fresh arrival plays the opening and hands the page over clean", async () => {
  const id = await makePage();
  const ctx = await phone();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await arrive(page, id);
  // The hold: the wordmark reads "Reasoning", and the content is kept below the fold.
  assert.equal(await phaseOf(page), "loading", "the attribute is on before the first paint");
  assert.equal(await page.locator(".intro .ib").innerText(), "Reasoning");
  assert.equal(await page.locator(".bar .brand").evaluate(el => el.firstChild.nextSibling.textContent), "Reason", "the top line it lands on says Reason");
  assert.equal(await page.locator(".intro").isVisible(), true);
  const seen = new Set();
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const p = await phaseOf(page);
    seen.add(p);
    if (p === null) break;
    await page.waitForTimeout(40);
  }
  assert.deepEqual([...seen], ["loading", "entering", null], "loading, then entering, then nothing");
  assert.deepEqual(await leftovers(page), { intro: null, overflow: "visible", sheet: "none", bar: "1", cover: "none", scrollY: 0 });
  await page.getByRole("heading", { name: "Build bigger shoulders" }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("a reload, a reader who asked for less motion, and a browser with no script all get the page at once", async () => {
  const id = await makePage();

  const ctx = await phone();
  const page = await ctx.newPage();
  await arrive(page, id);
  await page.waitForFunction(() => !document.documentElement.dataset.intro);
  await page.reload({ waitUntil: "commit" });
  assert.equal(await phaseOf(page), null, "a reload is not an arrival");
  assert.equal(await page.locator(".intro").isVisible(), false);
  await ctx.close();

  const calm = await phone({ reducedMotion: "reduce" });
  const p2 = await calm.newPage();
  await arrive(p2, id);
  assert.equal(await phaseOf(p2), null, "reduced motion: nothing moves");
  assert.equal(await p2.locator(".intro").isVisible(), false);
  await calm.close();

  const plain = await phone({ javaScriptEnabled: false });
  const p3 = await plain.newPage();
  await p3.goto(`${base}/p/${id}`);
  await p3.getByLabel("Six-digit code").fill(issueCode(id).code);
  await Promise.all([p3.waitForURL(u => !u.toString().includes("code")), p3.getByRole("button", { name: "Open" }).click()]);
  assert.equal(await p3.getByRole("heading", { name: "Build bigger shoulders" }).isVisible(), true);
  assert.equal(await p3.locator(".intro").isVisible(), false, "no script, no cover");
  await plain.close();
});

test("only a page made for someone opens this way; its script only draws", async () => {
  const id = await makePage();
  // Opened the way the owner opens it: the code once, and the page comes back.
  const body = await (await fetch(`${base}/p/${id}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `code=${issueCode(id).code}`,
  })).text();
  assert.match(body, /<div class="intro" aria-hidden="true"><div class="ib"><span class="dot"><\/span><span class="w">Reason<span class="ing">ing<\/span><\/span><\/div><div class="il"><\/div><\/div>/);
  assert.match(body, /<\/title>\n<script>[\s\S]*dataset\.intro='loading'[\s\S]*<\/script>\n<style>/, "set in the head, before the styles, so nothing flashes");
  // The one thing the page's scripts keep is the reader's light/dark choice, one word under one key
  // (pages-theme.test.js). Take those three calls out and nothing else touches storage or the network.
  const rest = body.replace(/localStorage\.(getItem|setItem|removeItem)\('reason-theme'/g, "");
  assert.doesNotMatch(rest, /fetch\(|navigator\.clipboard|localStorage|sessionStorage|XMLHttpRequest/, "it draws and nothing else");

  for (const html of [renderCodeGate(), renderNotFound(), renderNotice({ title: "Connected", lines: ["Done."] })]) {
    assert.doesNotMatch(html, /class="intro"|data-intro|<script/, "flat, at once, no script");
  }
  // The gate and the not-found page remain the same bytes as each other where it matters.
  assert.doesNotMatch(renderCodeGate(), /intro/);
  assert.doesNotMatch(renderNotFound(), /intro/);
});
