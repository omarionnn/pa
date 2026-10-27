// Every page Reason serves carries the marketing site's wordmark top left (2026-10-25, owner ask):
// one copy in src/pages/wordmark.js, used by the page shell and the three pages with their own
// template. Pixel checks: .agents/skills/verify-reason/bin/wordmark.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "wordmark-test-")), "x.db");
const { wordmark, WORDMARK_CSS, WORDMARK_BUBBLE, WORDMARK_BUBBLE_DARK, WORDMARK_O } = await import("../src/pages/wordmark.js");
const { BRAND_PEN, BRAND_PEN_DARK } = await import("../src/pages/brand.js");
const card = await import("../src/pages/card.js");
const cover = await import("../src/eventcover.js");
const render = await import("../src/pages/render.js");
const ev = await import("../src/pages/event.js");
const { renderOps } = await import("../src/pages/ops.js");
const spotify = await import("../src/spotify.js");
const remote = await import("../src/signin-remote.js");

// The site's bubble, character for character (reason-site-new/public/index.html .nav-mark).
const SITE_BUBBLE = `<svg class="wm-bubble" viewBox="-4 0 70 66"`;
const SITE_PATH = `<g transform="translate(6 0) skewX(-10)"><path d="M31 6 A25 25 0 1 1 13 49 L4 60 L8 44 A25 25 0 0 1 31 6 Z"/></g>`;

test("the wordmark is the site's: reas, the bubble, n — and its font is inline", () => {
  const m = wordmark();
  assert.ok(m.startsWith(`<span class="wordmark" role="img" aria-label="Reason">reas${SITE_BUBBLE}`));
  assert.ok(m.includes(SITE_PATH) && m.endsWith("</svg>" + WORDMARK_O + "n</span>"));
  assert.match(WORDMARK_CSS, /src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\)/);
  assert.match(WORDMARK_CSS, /font:italic 400 1\.35rem\/1\.2 "Reason Wordmark"/);
  assert.match(WORDMARK_CSS, /letter-spacing:-\.01em/);
  assert.match(WORDMARK_CSS, /stroke:#9c3b2e;stroke-width:6/);
  assert.doesNotMatch(WORDMARK_CSS, /https?:/, "nothing fetched from anywhere");
});

test("every page template opens with the wordmark and no dot-and-Reason top line", () => {
  const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", description: "", guest_list_visible: 1, status: "active" };
  const pages = {
    shell: render.shell({ title: "x", body: "" }),
    files: render.renderPage({ id: 1, title: "T", created_at: Date.now(), blocks: [{ type: "text", text: "a" }] }, { forName: "Omari" }),
    gate: render.renderCodeGate({}),
    notFound: render.renderNotFound(),
    event: ev.renderJoin({ ev: e }),
    ops: renderOps({ report: null }),
    spotify: spotify.joinPage({ token: "t" }),
    remote: remote.shell("Sign in", ""),
  };
  for (const [name, page] of Object.entries(pages)) {
    const html = typeof page === "string" ? page : page.body;
    const top = html.slice(html.indexOf("<body>"));
    assert.ok(top.includes(`<div class="brand">${wordmark()}`) || top.includes(`<div class="bar">${wordmark()}</div>`), `${name}: wordmark in the top line`);
    assert.ok(html.includes(WORDMARK_CSS), `${name}: wordmark styles`);
    assert.doesNotMatch(html, /<span class="dot"><\/span>Reason(<\/div>|<span class="who">|\$)/, `${name}: old top line gone`);
  }
});

test("the opening moment says reasoning with the same mark", () => {
  const html = render.renderPage({ id: 1, title: "T", created_at: Date.now(), blocks: [{ type: "text", text: "a" }] }, { forName: "Omari" });
  assert.ok(html.includes(`<div class="ib">${wordmark({ ing: `<span class="ing">ing</span>` })}</div>`));
});

// 2026-10-25, owner: the brand orange is #B8460B, and the old dot-and-"Reason" mark goes from the
// footers and the link-preview cards too.
// 2026-10-25, owner: the bubble goes brand orange too — the lighter one on every dark ground.
// 2026-10-26, owner: the brand pen colour becomes brick red, #b03030 light / #e8765c dark.
// 2026-10-26 ~23:45, owner: the pen moves to #9c3b2e light / #d46a5c dark.
test("the bubble is the brand colour: light on light pages, the lighter one on dark pages, cards and covers", () => {
  assert.equal(WORDMARK_BUBBLE, BRAND_PEN);
  assert.equal(WORDMARK_BUBBLE_DARK, BRAND_PEN_DARK);
  assert.ok(WORDMARK_CSS.includes(`.wm-bubble path{fill:none;stroke:${BRAND_PEN};`));
  assert.ok(WORDMARK_CSS.includes(`:root[data-theme=dark] .wm-bubble path{stroke:${BRAND_PEN_DARK}}`));
  assert.ok(WORDMARK_CSS.includes(`:root:not([data-theme=light]) .wm-bubble path{stroke:${BRAND_PEN_DARK}}`));
  assert.doesNotMatch(WORDMARK_CSS, /0A84FF/i);
  assert.ok(card.cardHtml({ title: "x", forName: "Omari" }).includes(`.brand .wm-bubble path{stroke:${BRAND_PEN_DARK}}`));
  assert.ok(cover.generatedHtml("x").includes(`.mark .wm-bubble path{stroke:${BRAND_PEN_DARK}}`));
});

test("one brand red: #9c3b2e light, a lighter brick dark, both AA for small text", () => {
  assert.equal(BRAND_PEN, "#9c3b2e");
  assert.equal(BRAND_PEN_DARK, "#d46a5c");
  const lum = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((a, c, i) => a + c * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
  for (const bg of ["#ffffff", "#f2ebe0", "#faf6ee"]) assert.ok(ratio(BRAND_PEN, bg) >= 4.5, `light on ${bg}`);
  for (const bg of ["#1b1916", "#12110f", "#211f1b"]) assert.ok(ratio(BRAND_PEN_DARK, bg) >= 4.5, `dark on ${bg}`);
  const css = render.shell({ title: "x", body: "" });
  assert.ok(css.includes(`--mark:${BRAND_PEN};`) && css.includes(`--mark:${BRAND_PEN_DARK};`));
  for (const page of [spotify.joinPage({ token: "t" }), remote.shell("Sign in", "")]) {
    const html = typeof page === "string" ? page : page.body;
    assert.ok(html.includes(`--mark:${BRAND_PEN}`) && html.includes(`--mark:${BRAND_PEN_DARK}`));
  }
  assert.ok(cover.generatedHtml("Game Night").includes(`color:${BRAND_PEN_DARK}`), "the cover's kicker");
});

test("no page or card carries the old dot-and-Reason mark; footers and cards use the wordmark", () => {
  const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", description: "", guest_list_visible: 1, status: "active" };
  const html = (p) => typeof p === "string" ? p : p.body;
  const pages = {
    files: render.renderPage({ id: 1, title: "T", created_at: Date.now(), blocks: [{ type: "text", text: "a" }] }, { forName: "Omari" }),
    notice: render.renderNotice({ title: "Done" }),
    noticeFailed: render.renderNotice({ title: "No", ok: false }),
    eventJoin: ev.renderJoin({ ev: e }),
    cardPlain: card.cardHtml({ title: "Game Night", forName: "Omari" }),
  };
  for (const [name, p] of Object.entries(pages)) {
    assert.doesNotMatch(html(p), /class="dot"/, `${name}: no dot`);
    assert.doesNotMatch(html(p), /#ff5a3c|#ff6b4f/i, `${name}: no old orange`);
    assert.ok(html(p).includes(wordmark()), `${name}: the wordmark`);
  }
  assert.ok(html(pages.files).includes(`<p class="foot"><span>Made by</span>${wordmark()}</p>`));
  assert.ok(html(pages.notice).includes(`<p class="foot">${wordmark()}</p>`));
  assert.ok(html(pages.noticeFailed).includes(`<p class="foot">${wordmark()}<span>— nothing was changed</span></p>`));
  assert.ok(html(pages.cardPlain).includes(`<span class="brand">${wordmark()}</span>`) && html(pages.cardPlain).includes(WORDMARK_CSS));
  const pic = join(mkdtempSync(join(tmpdir(), "wordmark-card-")), "i.png");
  writeFileSync(pic, "x");
  const drawn = card.cardHtml({ title: "Game Night", illustration: pic });
  assert.ok(drawn.includes(`<span class="brand">${wordmark()}</span>`) && !drawn.includes(`class="dot"`), "illustrated card");
});
