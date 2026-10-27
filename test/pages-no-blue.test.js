// No blue on the pages Reason serves (owner, 2026-10-25): links, buttons, focus rings — the Light ·
// Dark · Auto switch's included — and highlights all take the brand colour from src/pages/brand.js
// (brick red since 2026-10-26), and the favicon is the speech bubble the marketing site uses, in that colour, its links fingerprinted so a
// browser holding the old blue one asks again. The one blue kept on purpose: the iMessage-style chat
// bubbles in the demo preview (src/pages/preview.js), because that is what an iMessage looks like.
// Live check in Chromium: .agents/skills/verify-reason/bin/theme-all.mjs and bin/wordmark.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "no-blue-test-")), "x.db");
const render = await import("../src/pages/render.js");
const ev = await import("../src/pages/event.js");
const { renderOps } = await import("../src/pages/ops.js");
const spotify = await import("../src/spotify.js");
const remote = await import("../src/signin-remote.js");
const { BRAND_PEN } = await import("../src/pages/brand.js");

const root = new URL("../", import.meta.url);

// Blue = hue 190–260° with real saturation; greys, inks and the warm palette never land there.
function isBlue(r, g, b) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return false;
  const l = (max + min) / 2, s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 190 && h <= 260 && s > 0.35;
}
function blues(text) {
  const found = [];
  for (const m of text.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const n = parseInt(m[1], 16);
    if (isBlue(n >> 16, (n >> 8) & 255, n & 255)) found.push(m[0]);
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
    if (isBlue(+m[1], +m[2], +m[3])) found.push(m[0]);
  }
  // Short hex and named colours only where CSS puts a colour, so "#123" in prose or "Sendblue" never count.
  const CSS_COLOUR = /(?:color|background|border|outline|fill|stroke|shadow)[\w-]*\s*:([^;}"`]*)/gi;
  for (const [, value] of text.matchAll(CSS_COLOUR)) {
    for (const m of value.matchAll(/#([0-9a-f]{3})(?![0-9a-f])/gi)) {
      const [r, g, b] = [...m[1]].map(c => parseInt(c + c, 16));
      if (isBlue(r, g, b)) found.push(m[0]);
    }
    for (const m of value.matchAll(/\b(\w*blue|navy|cyan|aqua|teal|azure)\b/gi)) found.push(m[1]);
  }
  for (const m of text.matchAll(/hsla?\(\s*(\d+)/gi)) if (+m[1] >= 190 && +m[1] <= 260) found.push(m[0]);
  return found;
}

// The demo's iMessage bubble and its typing cursor: the only lines allowed a blue.
const DEMO_BUBBLE = (file, line) => file === "src/pages/preview.js" && /^\.(msg|cursor)\{/.test(line.trim());
// The navy wax seal (handoff 2026-10-27 "S3 · Old money, made real": the four wax palettes are the only new
// colours; navy is the travel seal). One line, the palette itself.
const NAVY_WAX = (file, line) => file === "src/seal.js" && /^\s*navy: \{ base: "#1f2f4a", rim: "#0c1424", recess: "#18263d"/.test(line);

test("no blue colour anywhere in src/ or the served icons, except the demo's iMessage bubbles", () => {
  const files = execSync("git ls-files src assets", { cwd: root }).toString().trim().split("\n")
    .filter(f => /\.(js|mjs|svg|css|html)$/.test(f));
  const stray = [];
  for (const f of files) {
    readFileSync(new URL(f, root), "utf8").split("\n").forEach((line, i) => {
      if (DEMO_BUBBLE(f, line) || NAVY_WAX(f, line)) return;
      for (const c of blues(line)) stray.push(`${f}:${i + 1} ${c}`);
    });
  }
  assert.deepEqual(stray, [], "every blue goes to the brand colour (src/pages/brand.js)");
});

// 2026-10-26, owner: the brand pen colour went from orange to brick red. The old orange stays out of
// everything Reason serves; only brand.js's history comment names it. Reason Web's own files
// (websignin.js, webconvo.js) carry their own palette and move on their own branch.
test("the 10-25 orange (#B8460B / #F26F2B) is gone from src/ and the served icons", () => {
  const files = execSync("git ls-files src assets", { cwd: root }).toString().trim().split("\n")
    .filter(f => /\.(js|mjs|svg|css|html)$/.test(f) && f !== "src/pages/brand.js");
  const stray = [];
  for (const f of files) {
    readFileSync(new URL(f, root), "utf8").split("\n").forEach((line, i) => {
      if (/#?(b8460b|f26f2b)\b/i.test(line)) stray.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(stray, []);
});

test("the demo's iMessage bubbles stay blue", () => {
  const demo = readFileSync(new URL("src/pages/preview.js", root), "utf8");
  const lines = demo.split("\n").filter(l => DEMO_BUBBLE("src/pages/preview.js", l));
  assert.ok(lines.some(l => blues(l).length), "the .msg bubble is still iMessage blue");
});

test("the favicon is the brand-red bubble and every page links it fingerprinted", () => {
  const svg = readFileSync(new URL("assets/favicon.svg", root), "utf8");
  assert.ok(svg.includes(BRAND_PEN), "favicon bubble is the brand red");
  assert.deepEqual(blues(svg), []);
  const h = createHash("sha256");
  for (const f of ["favicon.svg", "apple-touch-icon.png"]) h.update(readFileSync(new URL(`assets/${f}`, root)));
  assert.equal(render.ICON_VERSION, h.digest("hex").slice(0, 10), "the fingerprint follows the files");

  const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", description: "", guest_list_visible: 1, status: "active" };
  const pages = {
    files: render.renderPage({ id: 1, title: "T", created_at: Date.now(), blocks: [{ type: "text", text: "a" }] }, { forName: "Omari" }),
    gate: render.renderCodeGate({}),
    notFound: render.renderNotFound(),
    notice: render.renderNotice({ title: "Connected", lines: ["Done."] }),
    eventJoin: ev.renderJoin({ ev: e }),
    eventSignin: ev.renderSignin({ ev: e }),
    ops: renderOps({ report: null }),
    spotify: spotify.joinPage({ token: "t" }),
    remote: remote.shell("Sign in", ""),
  };
  for (const [name, page] of Object.entries(pages)) {
    const html = typeof page === "string" ? page : page.body;
    for (const href of ["favicon.svg", "apple-touch-icon.png"]) {
      assert.ok(html.includes(`/${href}?v=${render.ICON_VERSION}"`), `${name}: ${href} fingerprinted`);
    }
    assert.deepEqual(blues(html), [], `${name}: no blue in the served page`);
    // No browser-default (blue in Safari) focus ring: one brand-red :focus-visible every page loads.
    assert.match(html, /:focus-visible\{outline:2px solid var\(--accent,var\(--mark,#9c3b2e\)\)/, `${name}: brand-red focus ring`);
  }
});
