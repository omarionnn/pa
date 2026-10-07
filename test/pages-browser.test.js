// The copy block, pressed in a real browser at phone width: the text really lands on the
// clipboard, the download really is a .txt with the right name and the exact text, and both
// still work on a shared copy of the page where the choices are read-only. No model, no API key;
// a real server on loopback and Chromium from node_modules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pages-browser-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Plain http on loopback: the cookie must not be marked Secure or the browser will drop it.
delete process.env.REASON_PUBLIC_URL;

const { runTool } = await import("../src/tools.js");
const { createServer } = await import("../src/http.js");
const { issueCode } = await import("../src/pages/access.js");
const { config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const C = config.ownerConversation;
const TEXT = `You are a travel planner.\n\nPlan a 3-day trip to Lisbon for two people who like food & "small" museums.\n  - Day 1: <arrival>\n  - Budget: €150/day`;

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
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  permissions: ["clipboard-read", "clipboard-write"],
  acceptDownloads: true,
  ...extra,
});

async function makeCopyPage() {
  const out = await runTool("page_create", {
    title: "Your Lisbon prompt",
    blocks: [
      { type: "text", text: "Paste this into any AI." },
      { type: "copy", label: "prompt", text: TEXT },
      { type: "choice", key: "ok", question: "Good enough?", options: [{ label: "Yes" }, { label: "No" }] },
    ],
  }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return out;
}

/** Open the page the way the owner does: tap the link, get the gate, type the code. */
async function openAsOwner(page, id) {
  await page.goto(`${base}/p/${id}`);
  await page.getByLabel("Six character code").fill(issueCode(id).code);
  await page.getByRole("button", { name: "Open" }).click();
  await page.getByRole("heading", { name: "Your Lisbon prompt" }).waitFor();
}

async function proveCopyAndDownload(page) {
  // Everything fits a 390px screen without sideways scrolling.
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(wide, false, "no horizontal scroll at phone width");

  const copy = page.getByRole("button", { name: "Copy full prompt" });
  const download = page.getByRole("link", { name: "Download .txt" });
  await copy.waitFor();
  await download.waitFor();
  const status = page.locator(".copied");
  assert.equal((await status.textContent()).trim(), "", "nothing said until something happens");

  await copy.click();
  await assert.doesNotReject(status.getByText("Prompt copied.").waitFor({ timeout: 5000 }));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), TEXT, "the clipboard holds the exact text");

  const [dl] = await Promise.all([page.waitForEvent("download"), download.click()]);
  assert.equal(dl.suggestedFilename(), "prompt.txt");
  assert.equal(readFileSync(await dl.path(), "utf8"), TEXT, "the file is the exact text");
}

test("owner's page at 390px: Copy fills the clipboard and says so, Download saves prompt.txt", async () => {
  const made = await makeCopyPage();
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, made.page_id);
  await proveCopyAndDownload(page);
  // The copy block did not get in the way of the one thing that was already interactive.
  await page.getByRole("button", { name: "Yes" }).click();
  await page.locator(".picked").getByText("you picked: Yes").waitFor();
  await ctx.close();
});

test("the fallback path: no navigator.clipboard, still copied via execCommand", async () => {
  const made = await makeCopyPage();
  const ctx = await phone();
  await ctx.addInitScript(() => {
    // Keep the real one on the side so the test can read the clipboard back afterwards.
    window.__realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });
  const page = await ctx.newPage();
  await openAsOwner(page, made.page_id);
  await page.getByRole("button", { name: "Copy full prompt" }).click();
  await page.locator(".copied").getByText("Prompt copied.").waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__realClipboard.readText()), TEXT);
  await ctx.close();
});

test("a shared copy of the page, opened by a stranger with no code, can still copy and download", async () => {
  const made = await makeCopyPage();
  await runTool("page_share", { page_id: made.page_id }, { conversationId: C });
  const ctx = await phone();
  const page = await ctx.newPage();
  await page.goto(`${base}/p/${made.page_id}`);
  await page.getByRole("heading", { name: "Your Lisbon prompt" }).waitFor();
  await page.getByText("this is a copy").waitFor();
  assert.equal(await page.getByRole("button", { name: "Yes" }).count(), 0, "the choice is read-only");
  await proveCopyAndDownload(page);
  await ctx.close();
});

test("a page with no copy block has no buttons, no script and no copy styles in the browser", async () => {
  const out = await runTool("page_create", { title: "Plain", blocks: [{ type: "text", text: "Just words." }] }, { conversationId: C });
  await runTool("page_share", { page_id: out.page_id }, { conversationId: C });
  const ctx = await phone();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/p/${out.page_id}`);
  await page.getByRole("heading", { name: "Plain" }).waitFor();
  // The opening moment's two script tags are the only ones (pages-intro.test.js covers what they do).
  assert.equal(await page.locator("script").count(), 2);
  // The only buttons are the three of the light/dark/auto switch (pages-theme.test.js).
  assert.equal(await page.locator("button:not(.theme button), a.dl, .copy").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
