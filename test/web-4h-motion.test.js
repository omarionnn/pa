// v4 handoff §4h items 2, 3, 5 and 7, the pure parts (the browser half is web-4h-motion-browser.test.js):
// the late-night hour test at its edges, the tokens and motion values hex for hex from the reference
// sheet (sheet-small-details.html), the tab's title, and that nothing drawn by the server animates.
import { test } from "node:test";
import assert from "node:assert/strict";

const kit = await import("../src/pages/webkit.js");
const nt = await import("../src/pages/webnotify.js");

test("late night: 23:00 up to 05:00 on the browser's clock, edges exact", () => {
  const at = (h, m) => new Date(2026, 9, 27, h, m);
  assert.equal(kit.isLateNight(at(22, 59)), false);
  assert.equal(kit.isLateNight(at(23, 0)), true);
  assert.equal(kit.isLateNight(at(0, 0)), true);
  assert.equal(kit.isLateNight(at(4, 59)), true);
  assert.equal(kit.isLateNight(at(5, 0)), false);
  assert.equal(kit.isLateNight(at(12, 0)), false);
});

test("the page runs the same hour test in its head (before paint) and re-checks each minute", () => {
  const page = kit.webPage({ body: "<main></main>" });
  const src = "function(d){var h=d.getHours();return h>=23||5>h}";
  assert.ok(page.split(src).length - 1 >= 2, "head + minute tick");
  assert.match(page, /if\(late\(new Date\(\)\)\)h\.classList\.add\('late'\)/);
  assert.match(page, /setInterval\(function\(\)\{var on=late\(new Date\(\)\)[^]*?\},60000\)/);
});

test("tokens: grain is the sheet's URI at 160px on the ground only, off for prefers-contrast: more; late ground #221a13 on Night only, 2s", () => {
  const css = kit.KIT_CSS;
  assert.equal(kit.GRAIN, `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .35 0 0 0 0 .28 0 0 0 0 .2 0 0 0 .55 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E")`);
  assert.ok(css.includes(`:root{--grain:${kit.GRAIN}}`));
  assert.match(css, /@media \(prefers-contrast:more\)\{:root\{--grain:none\}\}/);
  assert.match(css, /html :is\(body,\.top,\.netline,\.composer,\.tabs,\.menu,\.listen,\.fg-wrap,\.loader\)\{background-image:var\(--grain\);background-size:160px 160px;background-attachment:fixed\}/);
  assert.doesNotMatch(css, /\.card\{[^}]*grain/, "lifted paper stays flat");
  assert.equal(kit.LATE_GROUND, "#221a13");
  assert.equal(kit.TOKENS.night.ground, "#1c1814");
  assert.equal(kit.TOKENS.paper.ground, "#f2ebe0", "Paper unchanged");
  assert.match(css, /:root\.late\[data-theme=dark\]\{--ground:#221a13\}/);
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{:root\.late:not\(\[data-theme=light\]\)\{--ground:#221a13\}\}/);
  assert.doesNotMatch(css, /:root\.late(\[data-theme=light\])?\{/, "never on Paper");
  assert.match(css, /:root\.late-go\{transition:--ground 2s ease\}/);
  assert.match(css, /@property --ground\{syntax:"<color>";inherits:true;initial-value:#f2ebe0\}/);
});

test("motion: the pen 0.5s clip-path left→right, the stamp 0.45s 1.8 → .92 → 1 keeping its tilt; reduced motion turns both off", () => {
  const css = kit.KIT_CSS;
  assert.match(css, /\.pen-in\{animation:pen-in \.5s cubic-bezier\(\.4,\.1,\.3,1\) both;/);
  assert.match(css, /@keyframes pen-in\{from\{clip-path:inset\(0 100% 0 0\)\}to\{clip-path:inset\(0\)\}\}/);
  assert.match(css, /\.stamp-in\{animation:stamp-in \.45s cubic-bezier\(\.3,1\.4,\.5,1\) both\}/);
  assert.match(css, /@keyframes stamp-in\{0%\{opacity:0;scale:1\.8\}58%\{opacity:1;scale:\.92\}100%\{opacity:1;scale:1\}\}/);
  assert.doesNotMatch(css.match(/@keyframes stamp-in[^]*?\}\}/)[0], /transform/, "scale, never transform: the tilt stays");
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important\}/);
  assert.ok(kit.webPage({}).includes(kit.INK_JS), "reasonInk is on every page");
});

test("nothing the server draws carries the arrival classes: load, history and reloads never animate", () => {
  const page = kit.webPage({ body: `<main>${kit.stamp("DONE")}${kit.hand("got it.")}${kit.onIt()}</main>` });
  assert.doesNotMatch(page.replace(/<style>[^]*?<\/style>|<script>[^]*?<\/script>/g, ""), /pen-in|stamp-in/);
});

test("§4h 5: the needs-you title, exactly; no count, no Done title", () => {
  assert.equal(nt.NEEDS_TITLE, "Reason · needs you");
  assert.ok(nt.NOTIFY_JS.includes(`var TITLE=${JSON.stringify("Reason · needs you")}`));
  assert.doesNotMatch(nt.NOTIFY_JS, /\) Reason needs you|Done \\u00b7/);
});
