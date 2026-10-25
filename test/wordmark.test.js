// Every page Reason serves carries the marketing site's wordmark top left (2026-10-25, owner ask):
// one copy in src/pages/wordmark.js, used by the page shell and the three pages with their own
// template. Pixel checks: .agents/skills/verify-reason/bin/wordmark.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "wordmark-test-")), "x.db");
const { wordmark, WORDMARK_CSS } = await import("../src/pages/wordmark.js");
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
  assert.ok(m.includes(SITE_PATH) && m.endsWith("</svg>n</span>"));
  assert.match(WORDMARK_CSS, /src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\)/);
  assert.match(WORDMARK_CSS, /font:italic 400 1\.35rem\/1\.2 "Reason Wordmark"/);
  assert.match(WORDMARK_CSS, /letter-spacing:-\.01em/);
  assert.match(WORDMARK_CSS, /stroke:#0A84FF;stroke-width:6/);
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
