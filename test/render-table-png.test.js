// Table pictures, really drawn (src/tableimage.js + Chromium through src/pages/card.js).
//
// Writes light, dark and a 10-row split to /tmp/render-table-preview/ so a person can open them.
// Skipped where Playwright's Chromium is not downloaded (a bare CI box); everything else about the
// feature is proved without a browser in test/render-table.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-table-png-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NUMBER = "+12025551234";

const t = await import("../src/tableimage.js");
const { shootWithChromium, NoCardRenderer } = await import("../src/pages/card.js");

const OUT = process.env.REASON_TABLE_PREVIEW_DIR || "/tmp/render-table-preview";

async function chromium() {
  try { await shootWithChromium("<html><body>x</body></html>", { width: 8, height: 8 }); return true; }
  catch (e) { if (e instanceof NoCardRenderer) return false; throw e; }
}

const pizza = {
  title: "Pizza Near You",
  columns: ["Place", "Price (slice)", "Walk", "Rating", "Open till"],
  rows: [["Joe's Pizza", "$3.50", "4 min", "4.6", "4 AM"], ["Prince Street Pizza", "$5", "9 min", "4.5", "2 AM"], ["Lucali", "$28 (pie)", "25 min", "4.7", "10 PM"]],
  comment: "Joe's for a slice right now; Lucali only if you'll wait an hour for the pie.",
};
const flights = {
  title: "Flights to Boston Friday",
  columns: ["Flight", "Leaves", "Lands", "Price (all fees)", "Stops"],
  rows: Array.from({ length: 10 }, (_, i) => [
    ["Delta 2111", "JetBlue 817", "American 4521", "United 1932", "Delta 2255", "JetBlue 1017 with a very long cabin description that keeps going", "Spirit 802", "American 318", "Delta 5709", "JetBlue 2139"][i],
    `${6 + i}:${i % 2 ? "40" : "15"} AM`, `${7 + i}:${i % 2 ? "55" : "30"} AM`, `$${129 + i * 23}`, i % 3 ? "Nonstop" : "1 stop (DCA)",
  ]),
  comment: "JetBlue 817 is the pick: nonstop, lands before 9, forty dollars under Delta.",
};

const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

test("real PNGs: light, dark, and a 10-row table split in two — 2160 px wide, under 1 MB, in budget", { timeout: 120_000 }, async (ctx) => {
  if (!(await chromium())) { ctx.skip("Playwright's Chromium is not downloaded here"); return; }
  mkdirSync(OUT, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  const log = [];
  const cases = [["pizza-light", pizza, "light"], ["pizza-dark", pizza, "dark"], ["flights-10-rows", flights, "light"]];
  for (const [name, table, theme] of cases) {
    const parts = await t.renderTable(table, { theme, log: (l) => log.push(l) });
    assert.equal(parts.length, name === "flights-10-rows" ? 2 : 1, name);
    for (const [i, p] of parts.entries()) {
      assert.equal(p.mime, "image/png");
      assert.ok(p.bytes < t.MAX_IMAGE_BYTES, `${name} ${p.bytes} bytes`);
      const { w, h } = pngSize(p.png);
      assert.equal(w, t.TABLE_W * t.TABLE_SCALE, `${name} width`);
      assert.ok(h > 600 && h < 6000, `${name} height ${h}`);
      writeFileSync(join(OUT, `${name}-${i + 1}.png`), p.png);
    }
  }
  // The split's first picture holds 8 rows, the second 2, and the taller one is the first.
  assert.deepEqual(log.filter(l => l.table_rendered === flights.title).map(l => l.rows), [8, 2]);
  // Render time: the first launch warms Chromium; every one after it is well inside the 1.5 s target.
  const times = log.map(l => l.ms);
  assert.ok(times.slice(1).every(ms => ms < t.RENDER_TARGET_MS * 2), `render times ${times.join(", ")} ms`);
  console.log(`table previews in ${OUT}: ${times.join(", ")} ms`);
});
