// A page as it is actually read: on a phone, in one hand, at 390 by 844.
//
// The page renderer was written and judged on a laptop, and three things only go wrong at phone
// width. A guide is mostly paragraphs, and 11px between them at this size reads as one slab. A
// three-column table with real headers pushes a column off the side behind a sideways scroll
// nobody knows is there. And a prompt in a copy block fills the whole screen, so the page it is
// on cannot be navigated. All three are measured here in a real browser rather than eyeballed.
//
//   is the blank line the model wrote between two ideas a visible gap?   (yes — about 16px)
//   does a comparison table fit the screen without a hidden scroll?      (yes — the header wraps)
//   can a long prompt be scrolled past rather than filling the page?     (yes — it is capped)
//   does any of it push the page sideways?                              (no)
//
// No model, no API key; a real server on loopback and Chromium from node_modules.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pages-phone-"));
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
/** An iPhone 14/15/16 in portrait, which is the screen this is for. */
const PHONE = { width: 390, height: 844 };

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

const phone = () => browser.newContext({
  viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  permissions: ["clipboard-read", "clipboard-write"],
});

/** Open it the way the owner does: tap the link, get the gate, type the code. */
async function openAsOwner(page, id, title) {
  await page.goto(`${base}/p/${id}`);
  await page.getByLabel("Six character code").fill(issueCode(id).code);
  await page.getByRole("button", { name: "Open" }).click();
  await page.getByRole("heading", { name: title }).waitFor();
}

async function made(title, blocks) {
  const out = await runTool("page_create", { title, blocks }, { conversationId: C });
  assert.equal(out.ok, true, out.error);
  return out.page_id;
}

/**
 * How dark a thin strip just inside one edge of the table box actually is, read off a real
 * screenshot rather than off a style rule.
 *
 * The edge fade is a conditional thing — four background layers, two of which scroll with the
 * content and cover the other two at rest — so `getComputedStyle` says exactly the same for a
 * table that fades and one that does not. The only honest way to ask whether a reader would SEE
 * the cue is to look at the pixels. Chromium has no decoder exposed to the test, so the shot goes
 * back into the page and a canvas reads it: 255 is the white card, lower is the shadow.
 *
 * The strip is taken low in the box, below the header row, where it is card and not cell tint.
 */
async function edgeDarkness(page, side) {
  // A table further down a guide is off screen, and a screenshot cannot clip to what is not drawn.
  await page.locator(".scroll").first().scrollIntoViewIfNeeded();
  const box = await page.locator(".scroll").first().boundingBox();
  const w = 8;
  const x = side === "right" ? box.x + box.width - w - 2 : box.x + 2;
  const shot = await page.screenshot({ clip: { x, y: box.y + box.height - 22, width: w, height: 14 } });
  return await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  }, `data:image/png;base64,${shot.toString("base64")}`);
}

/** Nothing anywhere on the page pushes it sideways. The single most visible phone failure. */
async function noSidewaysScroll(page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, `the page is ${over}px wider than the screen`);
}

// ---------- a guide, which is what "keep it" produces ----------

const GUIDE = [
  { type: "text", text: "Good coffee at home is four things: fresh beans, the right grind, water that is hot but not boiling, and a ratio you actually measure.\n\nEverything else is refinement. If a cup tastes wrong, it is almost always the grind." },
  { type: "section", title: "Grind" },
  { type: "text", text: "Grind size is the dial you turn. Finer grinds extract faster, coarser grinds extract slower.\n\nSour means under-extracted, so grind finer. Bitter means over-extracted, so grind coarser." },
  {
    type: "table",
    title: "Where to start",
    columns: ["Method", "Grind size", "Water temperature"],
    rows: [
      ["Pour over", "medium-fine, like table salt", "96°C / 205°F"],
      ["French press", "coarse, like breadcrumbs", "93°C / 200°F"],
      ["Espresso", "fine, like powdered sugar", "93°C / 200°F"],
    ],
  },
];

test("a guide at 390px: the blank line between two ideas is a visible gap", async () => {
  const id = await made("Better coffee at home", GUIDE);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Better coffee at home");

  const paras = page.locator(".t").first().locator("p");
  assert.equal(await paras.count(), 2, "the model wrote two paragraphs");
  const gap = await page.evaluate(() => {
    const [a, b] = [...document.querySelector(".t").querySelectorAll("p")];
    return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
  });
  // 1rem at 17px, collapsed between neighbours. Generous bounds: the point is that it is a gap a
  // person sees and not the 11px that read as one slab, and that it is not a chasm either.
  assert.ok(gap >= 13, `paragraphs are ${gap.toFixed(1)}px apart, which reads as one slab`);
  assert.ok(gap <= 28, `paragraphs are ${gap.toFixed(1)}px apart, which is too far`);

  // And the block does not hang extra space off its bottom, which is what made the gap to the
  // next heading look wrong.
  const last = await page.evaluate(() => {
    const ps = document.querySelector(".t").querySelectorAll("p");
    return getComputedStyle(ps[ps.length - 1]).marginBottom;
  });
  assert.equal(last, "0px");
  await noSidewaysScroll(page);
  await ctx.close();
});

test("a three-column table fits the screen, because the header is allowed to wrap", async () => {
  const id = await made("Better coffee at home", GUIDE);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Better coffee at home");

  const box = page.locator(".scroll").first();
  await box.waitFor();
  // The container is allowed to scroll — that is the fallback. The point is that for a table this
  // size it does not have to: no column is behind a sideways swipe nobody knows about.
  const hidden = await box.evaluate(el => el.scrollWidth - el.clientWidth);
  assert.ok(hidden <= 1, `${hidden}px of the table is off the side of the screen`);

  // And it fits because of the wrap, not by luck: with the old nowrap header this same table
  // needs more width than the screen has. Measured rather than asserted about.
  const wrapped = await page.locator("th").first().evaluate(el => getComputedStyle(el).whiteSpace);
  assert.equal(wrapped, "normal");
  const withNowrap = await box.evaluate(el => {
    const ths = [...el.querySelectorAll("th")];
    ths.forEach(th => { th.style.whiteSpace = "nowrap"; });
    const hidden = el.scrollWidth - el.clientWidth;
    ths.forEach(th => { th.style.whiteSpace = ""; });
    return hidden;
  });
  assert.ok(withNowrap > 1, "if this is 0 the wrap is not what is buying the fit and this test proves nothing");
  assert.ok(await page.locator("th").nth(2).evaluate(el => el.getBoundingClientRect().height) > 20,
    "'Water temperature' should be on more than one line");

  // Every cell really is readable, not clipped to nothing.
  for (const text of ["Pour over", "French press", "Espresso", "96°C / 205°F"]) {
    await page.getByRole("cell", { name: text, exact: true }).first().waitFor();
  }
  await noSidewaysScroll(page);
  await ctx.close();
});

test("a four-column table of prose does not fit, and takes the scroll itself rather than the page", async () => {
  // Three columns of real sentences is the width this screen has. A fourth does not fit and no
  // amount of wrapping makes it: 390px minus the margins is 351px of table. What matters is WHERE
  // the overflow goes — into the table's own box, never into the page, so the rest of the guide
  // still reads normally and nothing else is pushed off the side.
  //
  // That it is a sideways swipe with no visual cue is a real limit of this layout and is written
  // down in docs/unverified.md; a cue is a design call, not a bug fix.
  const id = await made("Four columns", [{
    type: "table",
    columns: ["Method", "Grind size", "Water temperature", "Brew time"],
    rows: [
      ["Pour over", "medium-fine, like table salt", "96°C / 205°F", "3 to 4 minutes"],
      ["French press", "coarse, like breadcrumbs", "93°C / 200°F", "4 minutes"],
    ],
  }]);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Four columns");

  const box = page.locator(".scroll").first();
  await box.waitFor();
  assert.ok(await box.evaluate(el => el.scrollWidth > el.clientWidth), "this is the case that overflows");
  assert.equal(await box.evaluate(el => getComputedStyle(el).overflowX), "auto", "so the box has to be the scroller");
  // The whole point: the page itself is not dragged sideways with it.
  await noSidewaysScroll(page);
  // And the last column is reachable by scrolling that box, not lost.
  await box.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.getByRole("cell", { name: "3 to 4 minutes", exact: true }).waitFor();
  await ctx.close();
});

// ---------- the cue that says so ----------

test("the table that overflows says so: a fade on the side there is more table", async () => {
  const id = await made("Four columns", [{
    type: "table",
    columns: ["Method", "Grind size", "Water temperature", "Brew time"],
    rows: [
      ["Pour over", "medium-fine, like table salt", "96°C / 205°F", "3 to 4 minutes"],
      ["French press", "coarse, like breadcrumbs", "93°C / 200°F", "4 minutes"],
    ],
  }]);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Four columns");
  const box = page.locator(".scroll").first();
  await box.waitFor();

  // Sitting at the start: there is more table to the right and none to the left, and that is
  // exactly what the two edges say.
  const start = { left: await edgeDarkness(page, "left"), right: await edgeDarkness(page, "right") };
  assert.ok(start.right < start.left - 20,
    `the right edge should be visibly darker than the left; got left ${start.left.toFixed(1)}, right ${start.right.toFixed(1)}`);
  assert.ok(start.left > 250, `nothing to the left, so that edge should be clean card: ${start.left.toFixed(1)}`);

  // Scrolled to the far end it is the other way round, with no script having run to flip it.
  await box.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(150);
  const end = { left: await edgeDarkness(page, "left"), right: await edgeDarkness(page, "right") };
  assert.ok(end.left < end.right - 20,
    `at the end the left edge should be the dark one; got left ${end.left.toFixed(1)}, right ${end.right.toFixed(1)}`);
  assert.ok(end.right > 250, `nothing further right, so that edge should be clean card: ${end.right.toFixed(1)}`);
  await ctx.close();
});

test("a table that fits has no fade on either side, scrolled or not", async () => {
  // The whole risk of a decorative edge is that it appears on a table with nothing hidden and
  // invites a swipe that does nothing. It must be the truth about that table or it is noise.
  const id = await made("Better coffee at home", GUIDE);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Better coffee at home");
  const box = page.locator(".scroll").first();
  await box.waitFor();

  for (const side of ["left", "right"]) {
    const v = await edgeDarkness(page, side);
    assert.ok(v > 250, `a table that fits must be clean on the ${side}: ${v.toFixed(1)}`);
  }
  // And it stays clean when something tries to scroll it, because there is nowhere to go.
  await box.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(150);
  for (const side of ["left", "right"]) {
    const v = await edgeDarkness(page, side);
    assert.ok(v > 250, `still clean on the ${side} after a scroll that cannot move: ${v.toFixed(1)}`);
  }
  await ctx.close();
});

// ---------- a copy block, which is what "a prompt I can paste" produces ----------

const SHORT = "Plan me 3 days in Lisbon. Food and small museums. Budget [budget].";
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: something the prompt asks the other AI to do, at the sort of length a real prompt runs to.`).join("\n");

test("a short prompt is not in a scroller at all", async () => {
  const id = await made("Your Lisbon prompt", [
    { type: "text", text: "Paste this into any AI." },
    { type: "copy", label: "prompt", text: SHORT },
  ]);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Your Lisbon prompt");

  const pre = page.locator(".copy pre");
  const m = await pre.evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight, font: parseFloat(getComputedStyle(el).fontSize) }));
  assert.ok(m.scroll - m.client <= 1, "a short prompt should be entirely visible, with nothing to scroll");
  // Monospace at .92rem. Under 14px on a phone is a squint, which is what it was.
  assert.ok(m.font >= 14, `the prompt is set at ${m.font}px`);
  await noSidewaysScroll(page);
  await ctx.close();
});

test("a long prompt is capped so the page it is on can still be navigated", async () => {
  const id = await made("Your Lisbon prompt", [
    { type: "text", text: "Paste this into any AI." },
    { type: "copy", label: "prompt", text: LONG },
    { type: "section", title: "After that" },
    { type: "text", text: "Tell it to tighten anything that reads generic." },
  ]);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Your Lisbon prompt");

  const pre = page.locator(".copy pre");
  const h = await pre.evaluate(el => el.getBoundingClientRect().height);
  assert.ok(h < PHONE.height * 0.62, `the prompt takes ${h.toFixed(0)}px of an ${PHONE.height}px screen`);
  assert.ok(await pre.evaluate(el => el.scrollHeight > el.clientHeight), "and the rest of it is scrollable inside");

  // The buttons and what comes after the block are both still reachable, which is the thing a
  // full-screen code block costs you.
  await page.getByRole("button", { name: "Copy full prompt" }).waitFor();
  await page.getByRole("heading", { name: "After that" }).waitFor();
  await noSidewaysScroll(page);
  await ctx.close();
});

test("nothing a model can write pushes the page sideways: a long unbroken string", async () => {
  // A URL, a hash or a German noun with no space in it is the classic way a phone page gets a
  // horizontal scroll, and it is text the model does supply.
  const id = await made("Long thing", [
    { type: "text", text: `the id is ${"a1b2c3d4e5".repeat(12)} and that is the whole thing` },
    { type: "table", title: "One row", columns: ["Key", "Value"], rows: [["token", "x".repeat(90)]] },
  ]);
  const ctx = await phone();
  const page = await ctx.newPage();
  await openAsOwner(page, id, "Long thing");
  await noSidewaysScroll(page);
  await ctx.close();
});
