// Light, dark and auto on a page Reason made. Omari asked for it on 2026-10-07: "for the webpages
// that Reason creates, that should be light, dark, and auto."
//
// The contract:
//
//   auto is the default and means the phone decides — no attribute, no storage, the page as before;
//   a choice is applied before the first paint, so a reload never flashes the other way;
//   a choice is one word under one key in this browser, sent nowhere, and auto clears it;
//   the phone's own chrome (theme-color) follows the choice and goes back to the phone's on auto;
//   the dark colours are written once — the same declarations serve the phone's setting and the
//     reader's choice, so the two can never drift apart;
//   a browser with no script sees no switch at all, and the gate and the not-found page stay flat.
//
// No model, no API key; a real server on loopback and Chromium from node_modules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pages-theme-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
delete process.env.REASON_PUBLIC_URL;

const { runTool } = await import("../src/tools.js");
const { createServer } = await import("../src/http.js");
const { issueCode } = await import("../src/pages/access.js");
const { config } = await import("../src/config.js");
const { renderCodeGate, renderNotFound, GROUND } = await import("../src/pages/render.js");
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

// Reduced motion: the opening moment stays out of the way (pages-intro.test.js owns it).
const phone = (extra = {}) => browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  reducedMotion: "reduce", ...extra,
});

const rgb = hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

async function makePage() {
  const out = await runTool("page_create", {
    title: "Build bigger shoulders",
    blocks: [{ type: "text", text: "Two short shoulder days a week." }, { type: "steps", items: ["Press first.", "Then raise."] }],
  }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return out.page_id;
}

/** Open a page; a browser proved on an earlier page of theirs is not asked again, so type a code only when the gate is there. */
async function arrive(page, id) {
  await page.goto(`${base}/p/${id}`);
  const code = page.getByLabel("Six-digit code");
  if (await code.count()) {
    await code.fill(issueCode(id).code);
    await Promise.all([
      page.waitForURL(u => !u.toString().includes("code")),
      page.getByRole("button", { name: "Open" }).click(),
    ]);
  }
  await page.getByRole("heading", { name: "Build bigger shoulders" }).waitFor();
}

/** What the reader sees and what the page keeps, in one read. */
const state = page => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme ?? null,
  ground: getComputedStyle(document.body).backgroundColor,
  scheme: getComputedStyle(document.documentElement).colorScheme,
  pressed: [...document.querySelectorAll(".theme button")].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.textContent),
  stored: localStorage.getItem("reason-theme"),
  tint: [...document.querySelectorAll("meta[name=theme-color]")].map(m => m.getAttribute("content")),
  switchShown: !!document.querySelector(".theme") && !document.querySelector(".theme").hidden,
}));

test("auto is the default: the phone decides, nothing is stored, and the switch says so", async () => {
  const id = await makePage();
  for (const [colorScheme, ground] of [["dark", GROUND.dark], ["light", GROUND.light]]) {
    const ctx = await phone({ colorScheme });
    const page = await ctx.newPage();
    await arrive(page, id);
    const s = await state(page);
    assert.equal(s.theme, null, `${colorScheme}: no attribute on auto`);
    assert.equal(s.ground, rgb(ground), `${colorScheme}: the ground follows the phone`);
    assert.deepEqual(s.pressed, ["Auto"]);
    assert.equal(s.stored, null);
    assert.deepEqual(s.tint, [GROUND.light, GROUND.dark], "the metas keep their media-matched defaults");
    assert.equal(s.switchShown, true);
    await ctx.close();
  }
});

test("a choice beats the phone, is there before the first paint on a reload, and auto hands back", async () => {
  const id = await makePage();
  const ctx = await phone({ colorScheme: "dark" });
  const page = await ctx.newPage();
  await arrive(page, id);

  await page.getByRole("button", { name: "Light" }).click();
  let s = await state(page);
  assert.equal(s.theme, "light");
  assert.equal(s.ground, rgb(GROUND.light), "light on a dark phone");
  assert.equal(s.scheme, "light", "native controls follow the choice too");
  assert.deepEqual(s.pressed, ["Light"]);
  assert.equal(s.stored, "light");
  assert.deepEqual(s.tint, [GROUND.light, GROUND.light], "the phone's chrome is told the chosen ground");

  // The next page this browser opens: the attribute must be on before the stylesheet is applied,
  // never a dark flash. An init script runs ahead of every page script and reads the attribute the
  // instant the document exists. (Another page, not a reload: on loopback over plain http the
  // page cookie does not survive a reload in Chromium, and that is the gate's business, not this.)
  await ctx.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { window.__early = document.documentElement.dataset.theme ?? null; }));
  const other = await makePage();
  await arrive(page, other);
  assert.equal(await page.evaluate(() => window.__early), "light", "set in the head, before the first paint");
  s = await state(page);
  assert.equal(s.ground, rgb(GROUND.light), "the choice is the browser's, not the page's");
  assert.deepEqual(s.pressed, ["Light"], "the switch shows the remembered choice");

  await page.getByRole("button", { name: "Auto" }).click();
  s = await state(page);
  assert.equal(s.theme, null);
  assert.equal(s.ground, rgb(GROUND.dark), "back to the phone's own setting");
  assert.equal(s.stored, null, "auto clears the word rather than storing a third one");
  assert.deepEqual(s.tint, [GROUND.light, GROUND.dark]);
  assert.deepEqual(s.pressed, ["Auto"]);
  await ctx.close();
});

test("dark on a light phone", async () => {
  const id = await makePage();
  const ctx = await phone({ colorScheme: "light" });
  const page = await ctx.newPage();
  await arrive(page, id);
  await page.getByRole("button", { name: "Dark" }).click();
  const s = await state(page);
  assert.equal(s.theme, "dark");
  assert.equal(s.ground, rgb(GROUND.dark));
  assert.equal(s.scheme, "dark");
  assert.deepEqual(s.tint, [GROUND.dark, GROUND.dark]);
  // The status and step colours (open-work pages) switch on the same attribute: one source.
  const kc = await page.evaluate(() => {
    const el = document.createElement("li"); el.className = "step k-done"; document.body.appendChild(el);
    const v = getComputedStyle(el).getPropertyValue("--kc").trim(); el.remove(); return v;
  });
  assert.equal(kc, "#52c793", "the dark step colour, by choice rather than by the phone");
  await ctx.close();
});

test("no script: no switch, the page as before; the flat pages carry none of it", async () => {
  const id = await makePage();
  const ctx = await phone({ javaScriptEnabled: false, colorScheme: "dark" });
  const page = await ctx.newPage();
  await arrive(page, id);
  assert.equal(await page.locator(".theme").isVisible(), false, "hidden until a script shows it");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), rgb(GROUND.dark), "the phone still decides");
  await ctx.close();

  for (const html of [renderCodeGate(), renderNotFound()]) {
    assert.doesNotMatch(html, /class="theme"|reason-theme|<script/, "the gate and the not-found page stay flat");
  }
});

test("the dark colours are written once and served two ways", async () => {
  const id = await makePage();
  // Opened the way the owner opens it: the code once, and the page comes back.
  const body = await (await fetch(`${base}/p/${id}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `code=${issueCode(id).code}`,
  })).text();
  // Every declaration block under the phone's dark setting has a twin under the reader's choice.
  const media = [...body.matchAll(/@media \(prefers-color-scheme:dark\)\{((?::root:not\(\[data-theme=light\]\)[^{]*\{[^}]*\})+)\}/g)]
    .map(m => m[1].replaceAll(":root:not([data-theme=light])", ":root[data-theme=dark]"));
  assert.ok(media.length >= 3, `expected the root, status and step blocks; found ${media.length}`);
  for (const twin of media) assert.ok(body.includes(twin), `missing the chosen-dark twin of: ${twin.slice(0, 80)}…`);
  // And nothing dark is left under the old bare selector, which a light choice could not override.
  assert.doesNotMatch(body, /@media \(prefers-color-scheme:dark\)\{:root\{/);
  assert.doesNotMatch(body, /@media \(prefers-color-scheme:dark\)\{\.[sk]-/);
  // The choice is applied in the head, before the styles.
  assert.match(body, /<\/title>\n<script>[\s\S]*localStorage\.getItem\('reason-theme'\)[\s\S]*<\/script>\n<style>/);
  assert.equal((body.match(/<script/g) ?? []).length, 2, "still the opening moment's two tags; the switch rides inside them");
});
