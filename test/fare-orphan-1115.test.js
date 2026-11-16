// Daily review 11-15: a taxi price was guessed with no tool; the last reply check took the figure out
// (right) but left the sentence that only qualified it ("Figure roughly 16 miles…", "The estimate
// assumes…"), so the person got a dangling line and no price. A sentence that only qualifies a dropped
// figure goes with it; one that stands on its own stays. And the `directions` tool description sends
// trip-cost questions to it for the distance first, so there is a worked estimate to give.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-fare-orphan-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:fare-orphan";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const offers = await import("../src/offers.js");
const { DIRECTIONS_TOOL_DEFS } = await import("../src/directionstools.js");

const C = "dm:fare-orphan";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM conversations; DELETE FROM event_log; DELETE FROM media_items; DELETE FROM person_facts;");
});

const TAXI = "How much is a taxi from the train station to 430 Example St";
function lastCheck(rewrite) {
  offers.beginTurn(C, TAXI, "user");
  offers.guardReply(C, "A cab is about $75.", { turnReply: true });
  offers.beginTurn(C, "", "user", { carry: true });
  return offers.guardReply(C, rewrite, { turnReply: true });
}

for (const orphan of [
  "Figure roughly 16 miles and 40 minutes.",
  "The estimate assumes about 16 miles.",
  "It assumes roughly 16 miles of driving.",
  "Give or take a few dollars for traffic over 16 miles.",
]) {
  test(`a dropped fare takes its qualifier with it: "${orphan}"`, () => {
    const g = lastCheck(`A yellow cab would run about $75. ${orphan} Want me to call a car service for a quote?`);
    assert.ok(g.flags.some(f => f.rule === "dollar_dropped"), JSON.stringify(g.flags));
    assert.ok(!g.text.includes(orphan), g.text);
    assert.match(g.text, /Want me to call a car service for a quote\?/);
  });
}

test("a sentence that stands on its own stays after a dropped fare", () => {
  const g = lastCheck("A yellow cab would run about $75. The ride is usually quicker after 7pm. Want me to call?");
  assert.ok(!g.text.includes("$75"));
  assert.match(g.text, /The ride is usually quicker after 7pm\./);
});

test("directions is where a trip-cost question goes first, with the working shown", () => {
  const d = DIRECTIONS_TOOL_DEFS.find(t => t.name === "directions").description;
  assert.match(d, /what a trip would cost[^]*call this first for the distance and time[^]*with its working[^]*uber_link/);
});

// Review 2026-11-16: a leaning sentence that also carries something true of its own is never taken
// with the dropped figure: a link, a clock time, a street address, a figure that stands.
for (const keep of [
  "The fare is live on Uber here: https://m.uber.com/ul/?action=setPickup",
  "That's about 40 minutes, so leave by 6:15pm.",
  "That assumes pickup at 430 Example St.",
]) {
  test(`a leaning sentence with its own true content stays: "${keep}"`, () => {
    const g = lastCheck(`A yellow cab would run about $75. ${keep} Want me to call?`);
    assert.ok(g.flags.some(f => f.rule === "dollar_dropped"), JSON.stringify(g.flags));
    assert.ok(!g.text.includes("$75"), g.text);
    assert.ok(g.text.includes(keep), g.text);
  });
}

test("a leaning sentence with a figure that stands stays; the dropped fare is said to be out", () => {
  offers.beginTurn(C, TAXI, "user");
  offers.guardReply(C, "A cab is about $75.", { turnReply: true });
  offers.beginTurn(C, "", "user", { carry: true });
  const g = offers.guardReply(C, "A yellow cab would run about $75. That's on top of the $12 toll. Want me to call?", { turnReply: true, extraSources: ["Port Authority toll: $12.00"] });
  assert.ok(!g.text.includes("$75"), g.text);
  assert.match(g.text, /That's on top of the \$12 toll\./);
});

test("the dropped fare and its qualifier: the reply says a figure was left out (#588)", () => {
  const g = lastCheck("A yellow cab would run about $75. Figure roughly 16 miles and 40 minutes.");
  assert.ok(!g.text.includes("$75") && !g.text.includes("Figure roughly"), g.text);
  assert.match(g.text, /couldn'?t|can'?t|cannot|not (?:give|confirm)/i);
});
