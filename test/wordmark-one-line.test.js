// The wordmark never breaks (owner, iPhone, 10-27): the Web thread's top bar, squeezed by the
// "where" note, split the mark "reas◯ / n" over two lines. The bubble is an atomic inline, so it is a
// place a line may break; the mark's one inline run (.wm-w, from the hidden o in #200) has to say
// nowrap. Pinned at phone widths: the mark is exactly one line tall, squeezed or not.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-wm-line-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;

const site = await import("../src/pages/wordmark.js");
const kit = await import("../src/pages/webkit.js");
const convo = await import("../src/pages/webconvo.js");
const { chromium } = await import("playwright");

const WIDTHS = [320, 375, 390];
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

const height = (pg, sel) => pg.evaluate((s) => document.querySelector(s).getBoundingClientRect().height, sel);

test("the Web thread's top bar, with the where note showing, keeps the mark on one line", async () => {
  const html = convo.renderConversation({ account: { id: 1, name: "Omari" }, csrf: "x", lines: [], more: false, sendId: "s", deferred: true });
  for (const scheme of ["dark", "light"]) for (const width of WIDTHS) {
    const pg = await browser.newPage({ viewport: { width, height: 700 }, colorScheme: scheme });
    await pg.setContent(html);
    await pg.evaluate(() => document.fonts.ready);
    const line = await height(pg, ".top .wm .wm-w");
    await pg.evaluate(() => { const w = document.querySelector(".where"); w.hidden = false; w.querySelector(".wn-s").textContent = "yesterday, on your phone, on the train"; });
    const fs = await pg.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".top .wm")).fontSize));
    const h = await height(pg, ".top .wm .wm-w");
    assert.equal(h, line, `${scheme} @${width}: mark ${h}px tall, one line is ${line}`);
    assert.ok(h < fs * 1.5, `${scheme} @${width}: ${h}px is one line of ${fs}px type`);
    await pg.close();
  }
});

test("every copy of the mark, squeezed in a flex row by a greedy neighbour, stays one line", async () => {
  const css = site.WORDMARK_CSS + kit.webPage({}).match(/<style>([^]*?)<\/style>/)[1];
  const marks = { "Web kit": [kit.wordmark(), ".wm-w"], "Web kit link": [kit.wordmark({ href: "/web" }), ".wm-w"], "pages + cards": [site.wordmark(), ".wordmark"] };
  for (const width of WIDTHS) {
    const pg = await browser.newPage({ viewport: { width, height: 400 } });
    for (const [name, [html, sel]] of Object.entries(marks)) {
      await pg.setContent(`<!doctype html><style>${css}body{margin:0}</style><header id="h" style="display:flex;align-items:center;gap:16px;width:${width}px">${html}<span style="flex:0 1 ${width}px;min-width:0;height:30px"></span></header>`);
      await pg.evaluate(() => document.fonts.ready);
      const squeezed = await height(pg, `#h ${sel}`);
      await pg.evaluate(() => document.querySelector("#h > span:last-child").remove());
      assert.equal(squeezed, await height(pg, `#h ${sel}`), `${name} @${width}: one line`);
    }
    await pg.close();
  }
});

test("the loader's reasoning is one line at phone widths", async () => {
  for (const width of WIDTHS) {
    const pg = await browser.newPage({ viewport: { width, height: 700 } });
    await pg.setContent(kit.webPage({ body: "<main></main>", loader: true }).replace("</head>", "<style>*{animation:none!important;transition:none!important}.loader .ing{width:auto!important}</style></head>"));
    await pg.evaluate(() => { document.documentElement.classList.add("loading"); return document.fonts.ready; });
    assert.ok(await height(pg, ".loader .wm-w") < 64 * 1.5, `@${width}`);
    await pg.close();
  }
});
