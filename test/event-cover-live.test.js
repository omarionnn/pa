// Spec §14's flyer guardrail with the real model reading real pictures, on the subscription (the CLI,
// never the paid key). Opt-in, because it starts the CLI:
//   REASON_LIVE_FLYER=1 ANTHROPIC_API_KEY= node --test test/event-cover-live.test.js
// A flyer that prints the hidden time and address is read as showing both; the same flyer without
// them is read as showing neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cover-live-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
const cover = await import("../src/eventcover.js");
const live = process.env.REASON_LIVE_FLYER === "1";
const block = (f) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: readFileSync(new URL(`./fixtures/pictures/${f}`, import.meta.url)).toString("base64") } });
const hidden = [{ detail: "time", actual: "Sat, Oct 31, 9:00 PM" }, { detail: "location", actual: "12 Elm St, Apt 4" }];

test("a flyer printing the hidden time and address is read as showing both", { skip: !live && "set REASON_LIVE_FLYER=1" }, async () => {
  const r = await cover.readFlyerViaCli({ block: block("event-flyer-hidden.png"), hidden });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.shows_time, true);
  assert.equal(r.shows_place, true);
  assert.match(r.place_shown, /Elm/i);
});

test("the same flyer without them is read as showing neither", { skip: !live && "set REASON_LIVE_FLYER=1" }, async () => {
  const r = await cover.readFlyerViaCli({ block: block("event-flyer-clean.png"), hidden });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.shows_time, false);
  assert.equal(r.shows_place, false);
});
