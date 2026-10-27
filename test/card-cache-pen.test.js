// Cached cards are keyed by a design version, not by the colour. When the pen colour moved to brick
// red (10-26) the drawings changed but the keys did not, so every card drawn before kept being served
// orange. A colour change must bump these versions; this pins the bump that shipped with the red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INVITE_CARD_VERSION } from "../src/invitecard.js";
import { DRAWN_COVER_VERSION } from "../src/eventcover.js";

test("invite cards drawn in orange are drawn again in red", () => {
  assert.ok(INVITE_CARD_VERSION >= 3);
});

test("event covers drawn in orange are drawn again in red", () => {
  assert.ok(DRAWN_COVER_VERSION >= 2);
});

// The picture an invite link shows when its own card cannot be drawn (src/http.js) stayed the old
// blue design after the pen moved to red (10-26). It is now drawn from the invite card itself
// (scripts/draw-og.mjs): brick red pen present, no blue anywhere.
test("the og.png fallback is the red card on paper, never the old blue", async () => {
  const { readFileSync } = await import("node:fs");
  const { inflateSync } = await import("node:zlib");
  const { BRAND_PEN } = await import("../src/pages/brand.js");
  const png = readFileSync(new URL("../assets/og.png", import.meta.url));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20), bpp = { 2: 3, 6: 4 }[png[25]];
  assert.equal(png[24], 8); assert.equal(png[28], 0); assert.ok(bpp, "RGB or RGBA");
  const idat = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp;
  let prev = Buffer.alloc(stride), red = 0, blue = 0;
  const pen = [1, 3, 5].map(i => parseInt(BRAND_PEN.slice(i, i + 2), 16));
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < stride; x += bpp) {
      const [r, g, bl] = [line[x], line[x + 1], line[x + 2]];
      if (Math.abs(r - pen[0]) < 24 && Math.abs(g - pen[1]) < 24 && Math.abs(bl - pen[2]) < 24) red++;
      if (bl > r + 30 && bl > g + 10) blue++;
    }
    prev = line;
  }
  assert.ok(red > 500, `brick red pen drawn (${red} px)`);
  assert.equal(blue, 0, "no blue pixels");
});
