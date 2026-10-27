// Pictures Reason draws once and keeps carry the brand pen in their pixels. #175 moved the pen from
// orange to brick red, but those files were keyed by revision / name only, so every link already drawn
// kept serving its orange card live (2026-10-26). #177 bumped the invite card and drawn cover; a page's
// card now names the pen (BRAND_ART) in its file and `?v=`, so a pen change draws it again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-brand-art-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
const { BRAND_ART } = await import("../src/pages/brand.js");
const { cardPath } = await import("../src/pages/card.js");
const { cardUrl } = await import("../src/pages/render.js");
after(() => rmSync(dir, { recursive: true, force: true }));

test("a page's card file and address name the pen, so the orange ones are never served again", () => {
  assert.equal(BRAND_ART, "pen2");
  const page = { id: "abc123", revision: 4, owner_key: "k" };
  assert.ok(cardPath(page).endsWith(`abc123-r4-${BRAND_ART}.png`));
  assert.ok(!cardPath(page).endsWith("abc123-r4.png"), "not the orange card's file");
  assert.match(cardUrl(page), new RegExp(`/card\\.png\\?v=4-${BRAND_ART}&k=k$`));
});
