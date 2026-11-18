// "Closest X" / "how far to X" / "how much to get to X": the distance, time and price come from the
// directions tool (with its map link), never an unchecked guess. The rule lives in the tool
// descriptions the model reads when it reaches for them (nearby_places, then directions), not in the
// standing prompt, which is at its size budget. Offline: asserts the description text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-closest-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Alex";
process.env.REASON_TZ = "America/New_York";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";

const { tools } = await import("../src/tools.js");
const { DIRECTIONS_TOOL_DEFS } = await import("../src/directionstools.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const nearby = () => tools.find(t => t.name === "nearby_places").description;

for (const [label, key] of [["OpenStreetMap", ""], ["Google", "test-key"]]) {
  test(`nearby_places (${label}): the closest one, or how far/how much, goes on to directions and its link`, () => {
    const was = process.env.REASON_GOOGLE_PLACES_KEY;
    process.env.REASON_GOOGLE_PLACES_KEY = key;
    try {
      const d = nearby();
      assert.match(d, /For the closest one, or how far or how much to get there, call directions to it next and send its link/);
      assert.match(d, /never state a distance, time or price you did not check/);
    } finally {
      if (was === undefined) delete process.env.REASON_GOOGLE_PLACES_KEY; else process.env.REASON_GOOGLE_PLACES_KEY = was;
    }
  });
}

test("directions: how far to the closest of a kind is its job too, with the link, never a guess; the fare rule stays one rule", () => {
  const d = DIRECTIONS_TOOL_DEFS.find(t => t.name === "directions").description;
  assert.match(d, /how far or how long it is to a place, the closest or nearest of a kind included/);
  assert.match(d, /send its link, never guess them or state one you did not check/);
  // The fare rule was sharpened in place, not repeated.
  assert.equal(d.split("what a trip would cost").length - 1, 1);
  assert.match(d, /give the meter estimate as yours with its working/);
});
