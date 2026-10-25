// Every page Reason serves carries the same Light · Dark · Auto switch at its foot (owner,
// 2026-10-25), from one place: THEME in src/pages/render.js, used by shell() and by the three pages
// with their own template. Behaviour in Chromium: test/pages-theme.test.js and
// .agents/skills/verify-reason/bin/theme-all.mjs (every page × 390/1280 × four states, contrast).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "theme-all-test-")), "x.db");
const render = await import("../src/pages/render.js");
const { THEME } = render;
const ev = await import("../src/pages/event.js");
const { renderOps } = await import("../src/pages/ops.js");
const spotify = await import("../src/spotify.js");
const remote = await import("../src/signin-remote.js");

const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", description: "", guest_list_visible: 1, status: "active" };
const pages = () => ({
  files: render.renderPage({ id: 1, title: "T", created_at: Date.now(), blocks: [{ type: "text", text: "a" }] }, { forName: "Omari" }),
  gate: render.renderCodeGate({}),
  password: render.renderPasswordGate({}),
  notFound: render.renderNotFound(),
  notice: render.renderNotice({ title: "Connected", lines: ["Done."] }),
  eventJoin: ev.renderJoin({ ev: e }),
  eventSignin: ev.renderSignin({ ev: e }),
  eventGate: ev.renderGate({ ev: e, token: "t" }),
  ops: renderOps({ report: null }),
  spotify: spotify.joinPage({ token: "t" }),
  remote: remote.shell("Sign in", ""),
});

test("every page template carries the one switch, its head script, its styles and its handler", () => {
  for (const [name, page] of Object.entries(pages())) {
    const html = typeof page === "string" ? page : page.body;
    assert.equal(html.split(THEME.markup).length, 2, `${name}: the switch, once`);
    assert.ok(html.indexOf(THEME.head) < html.indexOf("</head>"), `${name}: the choice is applied before paint`);
    assert.ok(html.includes(THEME.css) && html.includes(THEME.js), `${name}: styles and handler`);
    assert.match(html, /:root\[data-theme=dark\]\{/, `${name}: dark colours follow a picked Dark`);
  }
});

test("a printed page still leaves the switch out", () => {
  const html = render.renderPage({ id: 1, title: "T", created_at: Date.now(), blocks: [{ type: "text", text: "a" }] }, { printing: true });
  assert.ok(!html.includes(THEME.markup) && !html.includes(THEME.js));
});

test("a switch a page script draws later works too (the /ops refresh swaps its column)", async () => {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    await p.setContent(render.shell({ title: "x", body: "<p>a</p>" }));
    await p.evaluate(() => { const w = document.querySelector(".wrap"); w.innerHTML = w.innerHTML; });
    await p.waitForFunction(() => !document.querySelector(".theme").hidden);
    await p.click(".theme [data-set=dark]");
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "dark");
    assert.equal(await p.locator(".theme [aria-pressed=true]").innerText(), "Dark");
  } finally { await b.close(); }
});
