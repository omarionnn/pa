// A taxi fare asked on 2026-11-15: "how much is a taxi from <a station> to <an address>". Nothing
// could read a real fare (Uber not connected), so the draft gave Reason's own estimate; the figures
// check (src/offers.js guardReply) sent it back once, the rewrite looked the rates up and gave the
// estimate again with what it assumed, and the check on the rewrite took out the sentence carrying
// the number. What went out opened "That assumes roughly 16 miles…": a reply about a price with no
// price in it, reading as if the number were still there.
//
// Now: when they asked a price, an estimate that says it is one, with what it assumes, stands. A
// figure that has to come out leaves no sentence leaning on it, and a plain line says the number is
// out. A live fare, a quote or a figure off their records is never let through as an "estimate".
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-fare-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const offers = await import("../src/offers.js");

const C = "dm:fare-test";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM conversations; DELETE FROM event_log; DELETE FROM media_items; DELETE FROM person_facts;");
});

const ASK = "How much is a taxi from the train station to 430 Example St";
// The rates the rewrite's web_search read: no fare total in them.
const RATES = { title: "Taxi Fare - TLC", snippet: "Metered fare: $3.00 initial charge, plus 70 cents per 1/5 mile or 70 cents per minute in slow traffic." };
const REST = "\n\nThat's not a live fare, since your Uber isn't connected to me. Want me to call a car service and get you their real price for the trip?";

/** The draft goes back once (first check), then the rewrite is checked for the last time. */
function rewriteChecked(rewrite, { own = ASK, kind = "user", draft = "A cab is about $75." } = {}) {
  offers.beginTurn(C, own, kind);
  offers.noteSource(C, RATES);
  const first = offers.guardReply(C, draft, { turnReply: true });
  offers.beginTurn(C, "", kind, { carry: true });
  return { first, last: offers.guardReply(C, rewrite, { turnReply: true }) };
}

test("the 11-15 fare: the rewrite's labelled estimate stands, number and all", () => {
  const rewrite = "A yellow cab should run about $64, with $4.75 of that in surcharges. That assumes roughly 16 miles with light traffic, which is my own guess at the distance. Any slow traffic adds 70 cents a minute." + REST;
  const { first, last } = rewriteChecked(rewrite);
  assert.ok(first.recompose, "the first draft's figure is still sent back to be checked");
  assert.match(first.recompose, /your own estimate/);
  assert.match(first.recompose, /what it assumes/);
  assert.match(first.recompose, /leave the figure out/);
  assert.equal(last.text, rewrite);
  assert.match(last.text, /\$64/);
  assert.deepEqual(last.flags.find(f => f.rule === "dollar_estimate_kept")?.figures, ["$64", "$4.75"]);
  assert.equal(last.flags.find(f => f.rule === "dollar_dropped"), undefined);
  assert.equal(last.recompose, null);
});

test("a figure that must come out takes what leans on it, and a plain line says the price is out", () => {
  // No estimate label anywhere: a fare stated as if it were real.
  const rewrite = "A yellow cab runs $64, with $4.75 of that in surcharges. That assumes roughly 16 miles with light traffic. Any slow traffic adds 70 cents a minute." + REST;
  const { last } = rewriteChecked(rewrite);
  assert.deepEqual(last.flags.find(f => f.rule === "dollar_dropped")?.figures, ["$64", "$4.75"]);
  assert.doesNotMatch(last.text, /\$64|\$4\.75/);
  assert.doesNotMatch(last.text, /That assumes/, "nothing left reading as if the number were there");
  assert.ok(last.text.startsWith(offers.PRICE_NOT_GIVEN), last.text);
  assert.match(last.text, /Any slow traffic adds 70 cents a minute\./);
  assert.match(last.text, /Want me to call a car service/);
});

test("an 'estimate' is no cover for a live fare, a quote, or a figure off their records", () => {
  for (const rewrite of [
    "Uber is $64 right now, my estimate assuming 16 miles.",
    "The quoted fare is $64, my estimate based on 16 miles.",
    "Your balance is about $412, my estimate based on last month's statement.",
    "You paid around $64 for it, my estimate assuming the usual 16 miles.",
  ]) {
    const { last } = rewriteChecked(rewrite);
    assert.ok(last.flags.some(f => f.rule === "dollar_dropped"), rewrite);
    assert.doesNotMatch(last.text, /\$64|\$412/, rewrite);
  }
});

test("a labelled estimate needs what it assumes, and a price they asked for", () => {
  // Labelled but nothing it rests on.
  let { last } = rewriteChecked("A cab is about $64, my estimate.");
  assert.ok(last.flags.some(f => f.rule === "dollar_dropped"));
  // They didn't ask a price: an estimate dropped in passing is dropped, with no lead line.
  ({ last } = rewriteChecked("Take a cab. It's about $64 by my estimate, assuming 16 miles. Leave by 9.", { own: "should i take the train or a cab to work" }));
  assert.ok(last.flags.some(f => f.rule === "dollar_dropped"));
  assert.equal(last.text, "Take a cab. Leave by 9.");
  // A turn that isn't theirs (a brief) has no price ask to answer.
  ({ last } = rewriteChecked("Cab to work is about $64 by my estimate, assuming 16 miles.", { own: "", kind: "brief" }));
  assert.ok(last.flags.some(f => f.rule === "dollar_dropped"));
});

test("a negated claim inside a labelled estimate does not count as claiming it is real", () => {
  const rewrite = "My estimate is about $64, assuming 16 miles, but that's not a confirmed fare.";
  const { last } = rewriteChecked(rewrite);
  assert.equal(last.text, rewrite);
});

test("a rewrite that already says the price is out gets no second line saying it", () => {
  const rewrite = "A cab runs $64. I couldn't confirm the fare, though. Want me to check it?";
  const { last } = rewriteChecked(rewrite);
  assert.equal(last.text, "I couldn't confirm the fare, though. Want me to check it?");
});
