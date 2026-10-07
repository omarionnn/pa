// The details a pleasant tone hides a mistake in: said as words, kept as values.
//
// Nothing here touches a model or a network. What is being proven is the pair of requirements that
// pull against each other — a phone call needs "three in the afternoon, Eastern Time" and the record
// needs `2026-10-14T15:00` with its zone — plus the rule with teeth: a detail nobody could make out
// blocks an agreement instead of being guessed through.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NAME = "Omari";

const r = await import("../src/calls/readback.js");

const NOW = Date.parse("2026-10-07T12:00:00-04:00");
const AT = Date.parse("2026-10-14T15:00:00-04:00");

test("a moment is spoken the way a person says it, with the zone", () => {
  const said = r.spokenMoment(AT, { now: NOW });
  assert.equal(said, "Wednesday the fourteenth of October at three in the afternoon, Eastern Time");
  // No digits anywhere in it: a speech model reading "15:00" or "10/14" out loud is the failure.
  assert.ok(!/\d/.test(said), said);
});

test("the written half keeps the exact value and the zone, not an offset", () => {
  assert.deepEqual(r.exactMoment(AT), { local: "2026-10-14T15:00", tz: "America/New_York" });
});

test("times come out as a person says them", () => {
  const at = (s) => r.spokenTime(Date.parse(`${s}-04:00`));
  assert.equal(at("2026-10-14T19:30"), "half past seven in the evening");
  assert.equal(at("2026-10-14T07:45"), "quarter to eight in the morning");
  assert.equal(at("2026-10-14T08:15"), "quarter past eight in the morning");
  assert.equal(at("2026-10-14T11:50"), "ten to twelve in the morning");
  assert.equal(at("2026-10-14T12:00"), "twelve in the afternoon");
  assert.equal(at("2026-10-14T00:00"), "twelve at night");
});

test("a year that is not this one is said; this one is not", () => {
  assert.match(r.spokenDate(Date.parse("2027-01-03T10:00:00-05:00"), { now: NOW }), /two thousand and twenty-seven$/);
  assert.ok(!/two thousand/.test(r.spokenDate(AT, { now: NOW })));
});

test("money is spoken, and singular when it is one", () => {
  assert.equal(r.spokenMoney(18000), "a hundred and eighty dollars");
  assert.equal(r.spokenMoney(21050), "two hundred and ten dollars fifty");
  assert.equal(r.spokenMoney(250), "two dollars fifty");
  assert.equal(r.spokenMoney(100), "one dollar");
  assert.equal(r.exactMoney(18000), 18000);
});

test("a confirmation number is read back AND spelled, because B and D sound alike on a phone", () => {
  const d = r.detail({ kind: "confirmation", value: "XK-2291" });
  assert.match(d.spoken, /^XK-2291 — that's /);
  assert.match(d.spoken, /X as in x-ray, K as in kilo, dash, two, two, nine, one/);
  // Digits in a code are said one at a time: "forty-seven" is ambiguous between 47 and 407 to
  // somebody writing it down.
  assert.ok(!/forty/.test(d.spoken), d.spoken);
  assert.equal(d.exact, "XK-2291");
});

test("a code of digits only is spelled without the 'that's' preamble", () => {
  assert.equal(r.detail({ kind: "confirmation", value: "4417" }).spoken, "four, four, one, seven");
});

test("an address is said as written — nobody says 'a hundred and eighty Lafayette Street'", () => {
  const d = r.detail({ kind: "address", value: "180 Lafayette St" });
  assert.equal(d.spoken, "180 Lafayette St");
  assert.equal(d.exact, "180 Lafayette St");
});

test("'Tuesday at 3' is not settled: a moment is a date AND a time, and the time carries the zone", () => {
  const ds = r.moment({ at: AT, now: NOW });
  assert.equal(ds.length, 2);
  assert.deepEqual(ds.map(d => d.kind), ["date", "time"]);
  assert.match(ds[1].spoken, /Eastern Time$/);
  assert.equal(r.settled(ds, { require: ["date", "time"] }).ok, true);
  // A date with no time does not settle a booking.
  assert.deepEqual(r.settled([ds[0]], { require: ["date", "time"] }).missing, ["time"]);
});

test("a detail nobody heard is unclear, never also missing — one problem, one fix", () => {
  const ds = [...r.moment({ at: AT, now: NOW }), r.detail({ kind: "confirmation", value: "[inaudible]" })];
  const s = r.settled(ds, { require: ["date", "time", "confirmation"] });
  assert.equal(s.ok, false);
  assert.deepEqual(s.unclear, ["confirmation"]);
  // The bug this pins: asking them to repeat it AND asking a question they already answered.
  assert.deepEqual(s.missing, []);
});

test("an unclear detail blocks an agreement and asks for a spelling", () => {
  const ds = [r.detail({ kind: "price", value: "[inaudible]", label: "price" })];
  const line = r.blockingUnclear(ds);
  assert.match(line, /Do not agree to anything yet/);
  assert.match(line, /spell it out/);
  assert.equal(r.blockingUnclear(r.moment({ at: AT, now: NOW })), null);
});

test("the read-back instruction quotes the spoken form verbatim and leaves the model nothing to compute", () => {
  const ds = [...r.moment({ at: AT, now: NOW }), r.detail({ kind: "price", value: 18000 })];
  const text = r.readBackInstruction(ds);
  assert.match(text, /say exactly "Wednesday the fourteenth of October"/);
  assert.match(text, /say exactly "a hundred and eighty dollars"/);
  assert.match(text, /Nothing is settled until they have said yes/);
  // An unclear detail is never offered up to be read back as if it were known.
  const withGap = r.readBackInstruction([...ds, r.detail({ kind: "confirmation", value: "???" })]);
  assert.ok(!/confirmation/.test(withGap), withGap);
});

test("the written record keeps both halves, and marks the gap as a gap", () => {
  const rec = r.recordOf([r.detail({ kind: "price", value: 18000 }), r.detail({ kind: "confirmation", value: "[inaudible]" })]);
  assert.deepEqual(rec.price, { kind: "price", exact: 18000, spoken: "a hundred and eighty dollars" });
  assert.deepEqual(rec.confirmation, { unclear: true });
});
