// 2026-10-26 ~23:45, owner: the pen moves from #b03030 / #e8765c to #9c3b2e (paper) / #d46a5c (night).
// Every page, card, icon and the Web kit read the pen from src/pages/brand.js (Web: webkit.js); this
// keeps the old pair from coming back as a literal anywhere Reason serves from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAND_PEN, BRAND_PEN_DARK, BRAND_ART } from "../src/pages/brand.js";
import { TOKENS } from "../src/pages/webkit.js";
import { INVITE_CARD_VERSION } from "../src/invitecard.js";
import { DRAWN_COVER_VERSION } from "../src/eventcover.js";

const root = new URL("..", import.meta.url).pathname;
const OLD = /b03030|e8765c|176,\s*48,\s*48|232,\s*118,\s*92/i;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(m?js|css|html|svg|json|md)$/.test(name)) yield p;
  }
}

test("the pen is #9c3b2e on paper and #d46a5c at night", () => {
  assert.equal(BRAND_PEN, "#9c3b2e");
  assert.equal(BRAND_PEN_DARK, "#d46a5c");
  assert.equal(TOKENS.paper.pen, BRAND_PEN);
  assert.equal(TOKENS.night.pen, BRAND_PEN_DARK);
});

test("no source, script or asset still carries the old pen #b03030 / #e8765c", () => {
  const hits = [];
  for (const dir of ["src", "scripts", "assets"]) {
    for (const f of files(join(root, dir))) if (OLD.test(readFileSync(f, "utf8"))) hits.push(f.slice(root.length));
  }
  assert.deepEqual(hits, []);
});

test("every kept card is drawn again in the new pen", () => {
  assert.ok(INVITE_CARD_VERSION >= 5, "invite card");
  assert.ok(DRAWN_COVER_VERSION >= 3, "drawn event cover");
  assert.notEqual(BRAND_ART, "pen2", "page card");
});
