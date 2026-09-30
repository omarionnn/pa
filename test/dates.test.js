import { test } from "node:test";
import assert from "node:assert/strict";
process.env.REASON_TZ = "America/New_York";
const { weekdayMismatch } = await import("../src/config.js");

// Wed Sep 23 2026, 3:00 PM ET
const NOW = Date.parse("2026-09-23T15:00:00-04:00");

test("consistent weekday + date passes", () => {
  assert.equal(weekdayMismatch("Fri Sep 25, 8:00 PM", NOW), null);
  assert.equal(weekdayMismatch("Saturday Sep 26 9pm", NOW), null);
});

test("wrong weekday is flagged with the next real one", () => {
  const w = weekdayMismatch("Fri Sep 26, 8:00 PM", NOW);
  assert.match(w, /Sep 26, 2026 is a Sat/);
  assert.match(w, /next Fri is Fri Sep 25, 2026/);
});

test("no weekday or no date → nothing to check", () => {
  assert.equal(weekdayMismatch("friday 8pm", NOW), null);
  assert.equal(weekdayMismatch("Sep 26 8pm", NOW), null);
  assert.equal(weekdayMismatch("", NOW), null);
});
