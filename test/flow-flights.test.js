// The use-case card, walked by the real model, four messages long.
//
// `test/flights.test.js` proves the machinery: the clock in the flight's own zone, the candidate, the
// gate, the money wall, the three-part verification, the pass. It drives the tools with a scripted
// model, so the one thing it cannot prove is the thing the card on Reason's own site actually
// promises — that the model, left to itself, does this and not something that reads like it:
//
//     Reason: "check-in for your 7:15am to atlanta just opened. want me to do it?"
//     Omari:  "yes pls, aisle if u can"
//     Reason: "done. you kept 14C."
//     Reason: [link] Boarding pass · ATL 7:15 AM
//
// Four things, in the order of what it would cost to get them wrong:
//
//   1. **Nothing is pressed without his yes.** "Asks before it touches anything" is the whole
//      promise. The ground truth is the fixture's own `checkins` array, which must be empty until a
//      yes exists and hold exactly one thing after it.
//   2. **"Done" is never said off anything but the page.** A person told they are checked in stops
//      thinking about it and goes to a gate. So this asserts on wording, which the suite does
//      almost nowhere else, because here the wording IS the feature.
//   3. **The offer names the real flight.** "You have a flight" is not what the card says and is
//      not useful: the line has to carry the time and the place, off the row rather than out of
//      the model's memory of a conversation a day ago.
//   4. **What he said in the same breath is answered.** "aisle if u can" is part of the job, and
//      the seat he got has to come back in the reply.
//
// No real airline is touched: the web rail runs against `test/fixture-airline.js` on 127.0.0.1,
// reached through `ctx.airlines`, which production never sets. Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-flights.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-flights-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = process.env.REASON_PUBLIC_URL || "https://reason.example.test";

const { startAirlineSite } = await import("./fixture-airline.js");
const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const airlines = await import("../src/airlines.js");
const browser = await import("../src/browser.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
const HOUR = 3_600_000;

let site;
let reg;

before(async () => {
  site = await startAirlineSite();
  reg = airlines.withExtra([site.entry()]);
});

after(async () => {
  await browser.closeAllBrowsers();
  await site?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  clock.reset();
  // A tab left on a page by the last test is a tab whose next navigation can be reported as a
  // failure of the next one (see browser.settle).
  if (browser.openConversations().includes(C)) await browser.settle(await browser.pageFor(C));
  db.db.exec("DELETE FROM flights; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations;"
    + " DELETE FROM conversations; DELETE FROM notice_events; DELETE FROM notice_seen; DELETE FROM notice_budget;"
    + " DELETE FROM notice_sweeps; DELETE FROM pages; DELETE FROM seen_urls; DELETE FROM outbox; DELETE FROM tasks;"
    + " DELETE FROM task_log; DELETE FROM preferences; DELETE FROM timers;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  // His zone and his hours, already answered. Otherwise the first sweep spends itself on that one
  // question instead of the check-in, which is the right behaviour and not what this test is about.
  db.setNoticeWindow(C, { tz: "America/New_York", askedAt: clock.now(), answeredAt: clock.now() });
  site.reset();
});

/**
 * A real runtime with the fixture airline on the turn, the way `turnExtras` is meant to be used,
 * and every unprompted message it decides to send collected as it goes.
 */
function runtime() {
  const rt = new Runtime({ log: () => {} });
  rt.turnExtras.airlines = reg;
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  return { rt, sent };
}

test(`the card, end to end: it offers, he says "aisle if u can", it checks him in and hands back the pass (${label})`, { skip }, async () => {
  const { rt, sent } = runtime();
  try {
    // Wednesday evening, his time. The flight is Friday morning, so check-in has not opened.
    clock.skip(Date.parse("2026-10-07T23:00:00Z") - clock.now());

    // ---------- 1. he mentions it in passing ----------
    const told = String(await rt.inbound(C,
      "flying to atlanta friday at 7:15am on fixture air out of jfk, conf ABC123, i'm omari nyarko"));
    const rows = db.listFlights(C);
    assert.equal(rows.length, 1, `it did not write the flight down. it said: ${told}`);
    const flight = rows[0];
    // The two fields the whole feature rests on. The zone has to be the AIRPORT's: his is the same
    // one here, which is on purpose — a test that only passes because they happen to agree is a test
    // that proves nothing, so the assertion is on the value and not on whether an offer arrives.
    assert.equal(flight.departs_local.slice(0, 16), "2026-10-09T07:15", JSON.stringify(flight.departs_local));
    assert.equal(flight.time_zone, "America/New_York", `the zone is not the departure airport's: ${flight.time_zone}`);
    assert.equal(flight.confirmation_code, "ABC123");
    assert.match(flight.passenger_name, /nyarko/i, `no passenger name to check the page against: ${flight.passenger_name}`);
    // 24h before 7:15 in New York, whatever this machine thinks the time is.
    assert.equal(flight.checkin_opens_at, Date.parse("2026-10-08T11:15:00Z"),
      `check-in opens at ${new Date(flight.checkin_opens_at).toISOString()}`);
    assert.equal(flight.status, "booked");
    assert.equal(site.lookups.length, 0, "nothing was opened on the airline: check-in is not open yet");

    // ---------- 2. the offer, from the sweep, not from a timer ----------
    // The middle of his Thursday: check-in has been open some hours and he is awake.
    clock.skip(Date.parse("2026-10-08T17:00:00Z") - clock.now());
    const before = sent.length;
    const sweep = await rt.notice();
    const offer = sent.slice(before).map(m => m.text ?? "").join("\n");
    assert.ok(sweep.told >= 1, `the sweep raised nothing: ${JSON.stringify(sweep)}`);
    assert.ok(offer.length > 0, "nothing went out");
    // The real flight in it. This is the line the card is about, so it is checked as the card has it.
    assert.match(offer, /7:?15\s*(am|a\.m\.)?/i, `the offer does not carry the real time: ${JSON.stringify(offer)}`);
    assert.match(offer, /atlanta|\bATL\b/i, `the offer does not carry the real place: ${JSON.stringify(offer)}`);
    assert.match(offer, /check[\s-]?in/i, `the offer is not about a check-in: ${JSON.stringify(offer)}`);
    // And it asked rather than went ahead.
    assert.equal(site.checkins.length, 0, `it checked him in before asking: ${JSON.stringify(offer)}`);
    assert.ok(/\?|want me|should i|shall i/i.test(offer), `it did not ask: ${JSON.stringify(offer)}`);

    // ---------- 3. "yes pls, aisle if u can" ----------
    let reply = String(await rt.inbound(C, "yes pls, aisle if u can"));
    // Walking a two-step airline may take a turn or two. Nothing may be pressed on any of them.
    let pending = db.pendingConfirmations(C).filter(x => x.action === "flight_checkin_commit");
    for (let i = 0; i < 2 && !pending.length; i++) {
      assert.equal(site.checkins.length, 0, `it pressed Check in before asking: ${reply}`);
      reply = String(await rt.inbound(C, "keep going"));
      pending = db.pendingConfirmations(C).filter(x => x.action === "flight_checkin_commit");
    }
    assert.equal(site.checkins.length, 0, `he was checked in with no yes. it said: ${reply}`);
    assert.ok(pending.length >= 1, `it never asked before the last button. it said: ${reply}`);
    assert.notEqual(db.getFlight(C, flight.id).status, "checked_in", "the row moved before anything was pressed");
    // What it asked about has to be what the final screen says, and pinned to THIS flight.
    const asked = `${pending[0].summary ?? ""} ${pending[0].target ?? ""}`;
    assert.match(asked, new RegExp(`flight #${flight.id}\\b`), `the ask is not pinned to the flight: ${asked}`);
    assert.match(asked, /14C/i, `the ask does not say which seat the screen is offering: ${asked}`);
    // His preference is kept as a preference, so it outlives this flight.
    assert.match(String(db.getFlight(C, flight.id).seat_preference), /aisle/i,
      "what he said in the same breath was not carried onto the flight");

    // ---------- 4. his yes, in his own words, read by the real judge ----------
    const done = String(await rt.inbound(C, "yeah go for it"));

    assert.equal(site.checkins.length, 1, `exactly one press after the yes, got ${site.checkins.length}. it said: ${done}`);
    const after = db.getFlight(C, flight.id);
    assert.equal(after.status, "checked_in", `the page said "You're checked in" and the row says ${after.status}`);
    assert.equal(after.seat, "14C", `the seat on the row is not the seat on the page: ${after.seat}`);
    assert.ok(after.checked_in_at, "no moment on the record for when it happened");
    // The reply. "done. you kept 14C." — the seat is the part he cares about and the part that
    // proves it was read off a page rather than assumed.
    assert.match(done, /14C/i, `it did not say which seat he got: ${JSON.stringify(done)}`);
    // And it must not invent the one thing a Reason page is not.
    assert.ok(!/scan|barcode|qr/i.test(done) || /not|isn'?t|email|app/i.test(done),
      `it implied its own page is the scannable boarding pass: ${JSON.stringify(done)}`);

    // ---------- the pass ----------
    // One more turn is allowed: the page is a second tool call and a long turn may end before it.
    let pass = db.listPages(C).find(p => /boarding pass/i.test(p.title));
    if (!pass) {
      await rt.inbound(C, "send me the boarding pass");
      pass = db.listPages(C).find(p => /boarding pass/i.test(p.title));
    }
    assert.ok(pass, `no boarding pass page was made. it said: ${done}`);
    // Built by code off the row, so the label carries where he is going and the real local time —
    // 7:15 in New York, never this machine's idea of it. Which of the airport's two names it wears
    // is the model's, because the row is the model's here: it writes ATL when it filled the code in
    // and "Atlanta" when it only wrote the city down. `test/flights.test.js` pins the card's exact
    // string, "Boarding pass · ATL 7:15 AM", off a row that definitely has the code — which is where
    // that belongs. What must never happen, and did, is the label losing the destination altogether.
    assert.match(pass.title, /^Boarding pass · (ATL|Atlanta) 7:15 AM$/, pass.title);
    assert.equal(db.getFlight(C, flight.id).page_id, pass.id, "the pass is not tied to the flight");
    const onIt = JSON.stringify(pass.blocks ?? []);
    assert.match(onIt, /14C/, "the seat is not on the pass");
    assert.match(onIt, /ABC123/, "the confirmation code is not on the pass");
    assert.match(onIt, /not the airline'?s boarding pass/i, "the pass does not say what it is not");
  } finally { rt.stop(); }
});

test(`a page that wants paying is handed back, not paid, and he is never told he is checked in (${label})`, { skip }, async () => {
  // The hard scope limit of the whole feature, and the one an airline really will hit: Spirit and
  // Frontier put a bag sale inside check-in. Reason spends nothing, so this is a hand-back — and the
  // thing that must not happen is the hand-back reading like a success.
  site.set({ wantsMoney: true });
  const { rt } = runtime();
  try {
    clock.skip(Date.parse("2026-10-08T17:00:00Z") - clock.now());
    db.recordFlight(C, {
      airline: "Fixture Air", airlineKey: "fixture_air", flightNumber: "DL 1234",
      confirmationCode: "ABC123", passengerName: "Omari Nyarko",
      origin: "JFK", originName: "New York", destination: "ATL", destinationName: "Atlanta",
      departsLocal: "2026-10-09T07:15:00", timeZone: "America/New_York",
      departsAt: Date.parse("2026-10-09T11:15:00Z"), checkinOpensAt: Date.parse("2026-10-08T11:15:00Z"),
      checkinWindowHours: 24, source: "he told me",
    });
    const id = db.listFlights(C)[0].id;

    let reply = String(await rt.inbound(C, "check me in for the atlanta flight"));
    for (let i = 0; i < 2 && db.getFlight(C, id).status !== "needs_them"; i++) {
      assert.equal(site.checkins.length, 0, `it checked him in through a payment wall: ${reply}`);
      reply = String(await rt.inbound(C, "keep going"));
    }

    assert.equal(site.checkins.length, 0, `it got past a payment wall. it said: ${reply}`);
    const row = db.getFlight(C, id);
    assert.notEqual(row.status, "checked_in", `it recorded a check-in that never happened: ${row.status}`);
    // The wording, because the wording is the feature: it must say what stopped it and it must not
    // claim to be done. A person who reads "you're all set" here walks to a gate with no boarding pass.
    //
    // Checked per sentence rather than across the whole reply, and this is the point rather than a
    // loosening. "Pay the bag on that screen and you're checked in" is the most useful sentence in
    // the hand-back — it is the one tap, told to HIM — and a flat ban on the phrase fails it while
    // passing anything that says the same thing in other words. What must never appear is the claim
    // as a fact about now, so a sentence making it has to carry the condition it depends on.
    const conditioned = /\bif\b|\bonce\b|\bafter\b|\bwhen\b|\bthen\b|\bwould\b|\bwill\b|\bneed|\bpay(ing)?\b|\byourself\b|\bcounter\b/i;
    for (const sentence of reply.split(/(?<=[.!?\n])/)) {
      const claim = [/\byou'?re checked in\b/i, /\bchecked you in\b/i, /\ball set\b/i, /\byou'?re all good\b/i]
        .find(c => c.test(sentence));
      if (!claim) continue;
      assert.match(sentence, conditioned,
        `it claimed a check-in that did not happen, flat and with no condition on it (${claim}): ${sentence.trim()}`);
    }
    assert.ok(/pay|paid|\$|card|bag|charge|fee/i.test(reply), `it did not say what stopped it: ${reply}`);
    // And it hands back rather than asking for a card.
    assert.ok(!/what'?s your card|card number|enter your card/i.test(reply), `it asked for a card: ${reply}`);
  } finally { rt.stop(); }
});
