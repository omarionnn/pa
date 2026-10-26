// The invite page's confetti (owner, 2026-10-26): the INVITE pill top-right is a real button, and a
// press pops a burst of confetti drawn by a small inline script. Pinned here: the button and its
// accessible name, the script riding in the page, no host but the page's own anywhere in it, the
// reduced-motion path, and every other page keeping its plain pill.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-invite-confetti-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PAGES_URL = "https://files.example.test";

const { renderInvite } = await import("../src/invites.js");
const { renderNotice } = await import("../src/pages/render.js");
const { CONFETTI_JS, CONFETTI_CSS } = await import("../src/pages/confetti.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const page = renderInvite({
  invite: { token: "a".repeat(32), claim_code: "123456", state: "unused" },
  name: "Omari",
  lineNumber: "+16562167455",
});

test("the invite pill is a keyboard-reachable button with a name", () => {
  const m = /<button type="button" class="pill pill-btn" data-pop aria-label="([^"]+)">Invite<\/button>/.exec(page);
  assert.ok(m, "the pill is a <button>");
  assert.match(m[1], /invite/i, "its accessible name carries the word it shows");
  assert.doesNotMatch(page, /<span class="pill">/);
  assert.match(page, /\.pill-btn\{[^}]*cursor:pointer/);
  assert.match(page, /\.pill-btn:focus-visible\{/);
});

test("the confetti script and its canvas style ride in the page", () => {
  assert.ok(page.includes(`<script>${CONFETTI_JS}`), "the script is inline in the page");
  assert.ok(page.includes(CONFETTI_CSS));
  assert.doesNotThrow(() => new Function(CONFETTI_JS), "the script parses");
  assert.ok(Buffer.byteLength(CONFETTI_JS) < 3000, `small: ${Buffer.byteLength(CONFETTI_JS)} bytes`);
});

test("no host but the page's own: no external script, nothing fetched", () => {
  assert.doesNotMatch(CONFETTI_JS, /https?:|\/\/[a-z]|fetch\(|XMLHttpRequest|import\(/i);
  assert.doesNotMatch(page, /<script[^>]+src=/i, "no script is loaded from anywhere");
  // The only off-site address the invite page names is the heading font it already loaded.
  const hosts = new Set([...page.matchAll(/(?:src|href)="https?:\/\/([^/"]+)/g)].map(m => m[1]));
  for (const h of hosts) assert.ok(["fonts.googleapis.com", "fonts.gstatic.com", "files.example.test"].includes(h), h);
});

test("it removes its canvas, debounces, and honours reduced motion", () => {
  assert.match(CONFETTI_JS, /prefers-reduced-motion:reduce/);
  assert.match(CONFETTI_JS, /calm\?12:90/, "reduced motion is a dozen sparkles, not the burst");
  assert.match(CONFETTI_JS, /c\.remove\(\)/);
  assert.match(CONFETTI_JS, /now-last<400/);
  assert.match(CONFETTI_JS, /aria-hidden/);
  assert.match(CONFETTI_CSS, /pointer-events:none/);
});

test("every other page keeps its plain pill and no confetti", () => {
  const other = renderNotice({ title: "Hello", lines: ["hi"], pill: "Private" });
  assert.match(other, /<span class="pill">Private<\/span>/);
  assert.doesNotMatch(other, /data-pop|confetti/);
});

test("the script runs: a press draws, a fast second press is ignored, the canvas goes", async () => {
  // A just-big-enough fake DOM: one pill, a body, a canvas that counts its draws.
  let listener, appended = 0, removed = 0, draws = 0, frames = [];
  const ctx = new Proxy({}, { get: (_, k) => k === "globalAlpha" ? 1 : (() => { if (k === "fillRect" || k === "fill") draws++; }), set: () => true });
  const canvas = { getContext: () => ctx, setAttribute() {}, remove() { removed++; } };
  const btn = { getBoundingClientRect: () => ({ left: 300, top: 10, width: 60, height: 20 }), addEventListener: (_, f) => { listener = f; } };
  let t = 1000;
  const env = {
    document: {
      querySelector: (s) => s.includes("data-pop") ? btn : null,
      createElement: () => canvas,
      body: { appendChild: () => { appended++; } },
      documentElement: { getAttribute: () => "dark" },
    },
    matchMedia: () => ({ matches: false }),
    performance: { now: () => t },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    cancelAnimationFrame() {},
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
  };
  new Function(...Object.keys(env), CONFETTI_JS)(...Object.values(env));
  listener();
  t += 100; listener(); // debounced
  assert.equal(appended, 1);
  for (let ms = 1000; frames.length && ms <= 3000; ms += 50) frames.shift()(ms);
  assert.ok(draws > 0, "it drew");
  assert.equal(removed, 1, "the canvas removed itself");
  assert.equal(frames.length, 0, "and stopped asking for frames");
});
