// The wordmark's text is "reason", not "reasn" (10-27): the bubble is drawn, so its o rides as a
// zero-size inline span. Copy-paste, Reason's own page reader and search snippets all read the
// text; Reason once told the owner its logo says "reasn". Every copy in pa is pinned here, and the
// mark must look exactly the same with the o as without it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const site = await import("../src/pages/wordmark.js");
const kit = await import("../src/pages/webkit.js");
const { chromium } = await import("playwright");

const textOf = (html) => html.replace(/<[^>]+>/g, "");
const MARKS = {
  "pages + cards (wordmark.js)": site.wordmark(),
  "Web kit": kit.wordmark(),
  "Web kit, a link home": kit.wordmark({ href: "/web" }),
};

test("every wordmark's text is reason; the loader's is reasoning", () => {
  for (const [name, html] of Object.entries(MARKS)) assert.equal(textOf(html), "reason", name);
  assert.equal(textOf(site.wordmark({ ing: `<span class="ing">ing</span>` })), "reasoning");
  const page = kit.webPage({ body: "<main></main>", loader: true });
  assert.equal(textOf(/<div class="loader"[^>]*>([^]*?)<\/div>/.exec(page)[1]), "reasoning");
  // No copy left without its o.
  for (const html of [...Object.values(MARKS), page]) assert.ok(!/<\/svg>n/.test(html), "an o after every bubble");
});

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test("in a browser: textContent and a copy read reason, and the mark looks exactly the same", async () => {
  for (const width of [600, 1280]) {
  const pg = await browser.newPage({ viewport: { width, height: 300 } });
  for (const [n, html] of Object.entries(MARKS)) {
    const name = `${n} @${width}`;
    const css = site.WORDMARK_CSS + kit.webPage({}).match(/<style>([^]*?)<\/style>/)[1];
    await pg.setContent(`<!doctype html><style>${css}body{margin:40px;font-size:40px}</style><div id="m">${html}</div>`);
    await pg.evaluate(() => document.fonts.ready);
    assert.equal(await pg.evaluate(() => document.getElementById("m").textContent), "reason", name);
    assert.equal(await pg.evaluate(() => document.getElementById("m").innerText), "reason", `${name}: innerText, one word`);
    const box = () => pg.evaluate(() => { const r = document.getElementById("m").firstElementChild.getBoundingClientRect(); return [r.width, r.height]; });
    const withO = await pg.locator("#m").screenshot();
    const sizeWith = await box();
    // Selecting the mark and copying it gives the word.
    assert.equal(await pg.evaluate(() => { const s = getSelection(); s.selectAllChildren(document.getElementById("m")); return s.toString(); }), "reason", `${name}: a copy`);
    await pg.evaluate(() => { getSelection().removeAllRanges(); document.querySelector("#m .wm-o").remove(); });
    assert.deepEqual(await box(), sizeWith, `${name}: same size`);
    assert.ok(withO.equals(await pg.locator("#m").screenshot()), `${name}: same pixels`);
    // The Web kit's bubble sits where the old flex layout centred it: (44 - (size + 3px margin)) / 2 + 3.
    if (/^Web kit/.test(n)) {
      const [top, h, bubTop, bubH] = await pg.evaluate(() => { const w = document.querySelector("#m .wm").getBoundingClientRect(), b = document.querySelector("#m .bub").getBoundingClientRect(); return [w.top, w.height, b.top, b.height]; });
      assert.ok(Math.abs((bubTop - top) - ((h - bubH - 3) / 2 + 3)) < 0.05, `${name}: bubble offset ${bubTop - top}`);
    }
  }
  await pg.close();
  }
});

test("the loader, while it shows, reads reasoning as one word and its bubble sits where the flex put it", async () => {
  const pg = await browser.newPage({ viewport: { width: 390, height: 600 } });
  await pg.setContent(kit.webPage({ body: "<main></main>", loader: true }).replace("</head>", "<style>*{animation:none!important;transition:none!important}</style></head>"));
  await pg.evaluate(() => { document.documentElement.classList.add("loading"); return document.fonts.ready; });
  assert.equal(await pg.evaluate(() => document.querySelector(".loader p").innerText), "reasoning");
  const [top, h, bubTop] = await pg.evaluate(() => { const p = document.querySelector(".loader p").getBoundingClientRect(), b = document.querySelector(".loader .bub").getBoundingClientRect(); return [p.top, p.height, b.top]; });
  assert.ok(Math.abs((bubTop - top) - ((h - 34 - 8) / 2 + 8)) < 0.05, `bubble offset ${bubTop - top}`);
  await pg.close();
});
