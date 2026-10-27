// Light pages are the marketing site's paper (owner, 2026-10-25): ground, page, paper, fill, rule and
// ink copied from reason-site-new/public/styles.css, with its grain, read from one place
// (src/pages/brand.js PAPER). Dark pages are untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.REASON_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "paper-")), "x.db");

const { PAPER, PAPER_GRAIN, BRAND_PEN } = await import("../src/pages/brand.js");
const render = await import("../src/pages/render.js");
const ev = await import("../src/pages/event.js");
const { renderOps } = await import("../src/pages/ops.js");
const spotify = await import("../src/spotify.js");
const remote = await import("../src/signin-remote.js");

const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };

test("the paper is the site's, hex for hex, with its grain", () => {
  assert.deepEqual({ ...PAPER, dim: undefined }, { ground: "#ede5d8", bg: "#f2ebe0", card: "#faf6ee", soft: "#ede5d8", line: "#d4c9b5", ink: "#2a2520", dim: undefined });
  assert.match(PAPER_GRAIN, /feTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='4'.*opacity='0.035'/);
  assert.equal(render.GROUND.light, PAPER.ground);
  assert.equal(render.GROUND.dark, "#0b0a09");
});

test("ink, the quieter text and the brand red stay AA on the paper", () => {
  for (const bg of [PAPER.bg, PAPER.card, PAPER.soft]) {
    assert.ok(ratio(PAPER.ink, bg) >= 4.5, `ink on ${bg}`);
    assert.ok(ratio(PAPER.dim, bg) >= 4.5, `dim on ${bg}`);
    assert.ok(ratio("#b4232a", bg) >= 4.5, `warn on ${bg}`);
  }
  for (const bg of [PAPER.bg, PAPER.card]) assert.ok(ratio(BRAND_PEN, bg) >= 4.5, `brand red on ${bg}`);
});

test("every page template takes the paper and its grain in light, and none in dark", () => {
  const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", description: "", guest_list_visible: 1, status: "active" };
  const pages = {
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
    assert.ok(html.includes(`--bg:${PAPER.bg}`) && html.includes(`--ground:${PAPER.ground}`), `${name}: paper tokens`);
    assert.ok(html.includes(`--grain:${PAPER_GRAIN}`) && html.includes("--grain:none"), `${name}: grain light only`);
    assert.match(html, /body\{[^}]*background:var\(--grain\) var\(--ground\)/, `${name}: body wears the grain`);
    assert.doesNotMatch(html, /#fbf9f5|#f3eee6|#e6e0d7|#1c1915|#6f675d/i, `${name}: old light colours gone`);
  }
});
