// Checked in before you remember. Offline: a fixture airline on 127.0.0.1 and a real Chromium.
//
// What these tests are for, in the order of what it would cost to get it wrong:
//
//   1. **Nobody is ever told they are checked in unless the airline's page said so.** This is the
//      whole feature. A person told they are checked in stops thinking about it and turns up at a
//      gate, so the claim is read off the screen — the checked-in words, a seat or a boarding
//      position, and THEIR name — and any one of those missing leaves the row at `checking_in` and
//      the words honest. Checked from both ends: the happy path, and a fixture that takes the press
//      and says nothing useful.
//   2. **Nothing is pressed without their own yes, for those exact details.** The seat only appears
//      on the last screen, so a yes collected earlier is a yes to something nobody had seen. The
//      gate is checked on the obvious case and on the one that matters more: the yes is pinned to
//      the flight as well as the details, so a yes for one flight cannot be spent on another.
//   3. **No money is ever spent.** Not a seat, not a bag, not an upgrade. A page asking to be paid
//      stops the commit BEFORE the press, which also means their yes is still sitting there unspent.
//   4. **The clock is the flight's, not the server's.** A 07:15 departure in Accra opens 24 hours
//      before 07:15 in Accra, whatever this machine's zone is. Tested by running the same flight
//      through three zones and in a process whose own clock is a fourth.
//   5. **The offer comes through the sweep.** One nudge per flight, never a bare timer, and the line
//      carries the real flight — "your 7:15am to atlanta" and not "you have a flight".
//   6. **An airline Reason cannot do says so**, with the honest line and the nearest real thing, and
//      never a guess at a URL.
//
// No real airline is touched anywhere in here. The web rail runs against test/fixture-airline.js on
// 127.0.0.1. `docs/unverified.md` says what a real airline would settle and this cannot.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flights-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
// Deliberately NOT the zone of any flight below. Every time assertion in here is wrong if the
// server's clock leaks into the answer, which is the bug this feature is most likely to have.
process.env.REASON_TZ = "America/Los_Angeles";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_UNDO_SECONDS = "0";

const { startAirlineSite } = await import("./fixture-airline.js");
const { runTool, capabilitiesNow, clickCommits, tools } = await import("../src/tools.js");
const db = await import("../src/db.js");
const flights = await import("../src/flights.js");
const airlines = await import("../src/airlines.js");
const notice = await import("../src/notice.js");
const signin = await import("../src/signin.js");
const permissions = await import("../src/permissions.js");
const browser = await import("../src/browser.js");
const { openWorkNote } = await import("../src/openwork.js");
const { exportData, deleteData } = await import("../src/data.js");
const { config, clock, stamp } = await import("../src/config.js");

const C = "dm:owner";
const HOUR = 60 * 60 * 1000;

let site;
let reg;

/** A judge that reads any reply as a plain yes: the gate's bookkeeping is what is under test here. */
const readsYes = async () => ({ verdict: "yes" });
const owner = (text) => ({ role: "user", content: `[Tue, Oct 6, 2026, 9:00 AM] Omari: ${text}` });

const call = (name, input, { conversationId = C, messages = [], ...extra } = {}) =>
  runTool(name, input, { conversationId, messages, judge: readsYes, airlines: reg, ...extra });

const ref = (snap, pred) => (snap.elements ?? []).find(pred)?.ref;

/** The clock only moves forward by an offset, so "be at this moment" is a skip of the difference. */
const at = (ms) => clock.skip(ms - clock.now());

async function withYes(name, input, { conversationId = C, summary = "the thing" } = {}) {
  const blocked = await call(name, input, { conversationId });
  assert.equal(blocked.blocked, "needs_confirmation", JSON.stringify(blocked));
  const messages = [owner("do it")];
  const req = await runTool("confirm_request", { action: name, summary, target: blocked.use_target }, { conversationId, messages });
  messages.push(owner("yes pls"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId, messages, judge: readsYes });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  const out = await call(name, { ...input, confirmation_id: req.confirmation_id }, { conversationId, messages });
  return { out, confirmation_id: req.confirmation_id, messages };
}

/**
 * A Friday at 07:15 New York time whose 24-hour check-in window is still shut when the file starts:
 * at least two NEW YORK calendar days out, so the next Friday from Saturday to Wednesday, and the
 * one after when today is Thursday or Friday. Counted on the flight's own calendar. It used to be
 * counted in UTC with only "not today": from 07:15 ET on a Thursday (11:15 UTC) to 20:00 ET (UTC
 * midnight) the flight was tomorrow morning, check-in was already open, and every test that
 * expects `too_early` failed — the same file passing that evening once UTC had rolled to Friday.
 */
const _today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
const [_y, _m, _dd] = _today.split("-").map(Number);
const _weekday = new Date(Date.UTC(_y, _m - 1, _dd)).getUTCDay();
let _daysToFri = (5 - _weekday + 7) % 7;
if (_daysToFri < 2) _daysToFri += 7;
const _ymd = (days) => new Date(Date.UTC(_y, _m - 1, _dd + days)).toISOString().slice(0, 10);
const FLIGHT_DEPARTS = `${_ymd(_daysToFri)}T07:15:00`;

// The day after the Friday, for a second flight that needs a different departure.
const FLIGHT_OTHER_DEPARTS = `${_ymd(_daysToFri + 1)}T06:00:00`;

// Pre-compute the expected UTC instants so assertions stay in sync with the dynamic date.
const _dep = flights.departureInstant(FLIGHT_DEPARTS, "America/New_York");
const FLIGHT_DEPARTS_UTC = new Date(_dep.at).toISOString();
const FLIGHT_CHECKIN_OPENS_UTC = new Date(flights.opensAt(_dep.at, 24)).toISOString();

/** His flight, as the card has it: the 7:15am to Atlanta on a Friday, on the fixture airline. */
const FLIGHT = {
  airline: "Fixture Air",
  flight_number: "DL 1234",
  confirmation_code: "ABC123",
  passenger_name: "Omari Nyarko",
  origin: "JFK",
  origin_name: "New York",
  destination: "ATL",
  destination_name: "Atlanta",
  departs_local: FLIGHT_DEPARTS,
  time_zone: "America/New_York",
};

/** Save the flight and wind the clock to a moment inside its check-in window. */
async function savedAndOpen(extra = {}) {
  const saved = await call("flight_save", { ...FLIGHT, ...extra });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const row = db.getFlight(C, saved.flight.id);
  at(row.checkin_opens_at + 30 * 60 * 1000);
  return row;
}

before(async () => {
  clock.reset();
  site = await startAirlineSite();
  reg = airlines.withExtra([site.entry()]);
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

beforeEach(async () => {
  clock.reset();
  site.reset();
  // A tab the last test left on a fixture page is a tab whose next navigation can be reported as a
  // failure of this one — the same guard test/flow-flights.test.js carries, and the reason the
  // signed-in sign-in test failed about one run in three with nothing wrong in the code it covers.
  if (browser.openConversations().includes(C)) await browser.settle(await browser.pageFor(C));
  for (const f of db.listFlights(C, { includeClosed: true })) db.deleteFlight(C, f.id);
  // The receipts and the yeses go too. The clock is wound forward inside each test, and it is wound
  // to a different moment in each — so a test that walks past a departure leaves rows stamped later
  // than the rows of the test after it, and "the newest receipt" would be somebody else's. Each test
  // reads its own record, which is the same thing the browser and call tests do.
  db.db.exec("DELETE FROM action_ledger; DELETE FROM confirmations;");
});

after(async () => {
  await browser.closeAllBrowsers();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------- the clock is the flight's, never the server's ----------

test("a departure instant comes from the flight's own zone, and check-in opens 24h before it there", () => {
  // 07:15 in New York on 2026-10-09 is 11:15 UTC (EDT, -04:00). This process is on Los Angeles time
  // and that must not come into it anywhere.
  const ny = flights.departureInstant("2026-10-09T07:15:00", "America/New_York");
  assert.equal(ny.ok, true);
  assert.equal(new Date(ny.at).toISOString(), "2026-10-09T11:15:00.000Z");
  assert.equal(new Date(flights.opensAt(ny.at, 24)).toISOString(), "2026-10-08T11:15:00.000Z");

  // The same wall clock in two other zones is three different instants, which is the whole point.
  const accra = flights.departureInstant("2026-10-09T07:15:00", "Africa/Accra");
  assert.equal(new Date(accra.at).toISOString(), "2026-10-09T07:15:00.000Z");
  const london = flights.departureInstant("2026-10-09T07:15:00", "Europe/London");
  assert.equal(new Date(london.at).toISOString(), "2026-10-09T06:15:00.000Z");
  assert.notEqual(ny.at, accra.at);
  assert.notEqual(accra.at, london.at);
});

test("the departure time is said back off the stored wall clock, not formatted in this machine's zone", () => {
  assert.equal(flights.saidTime("2026-10-09T07:15:00"), "7:15am");
  assert.equal(flights.saidTime("2026-10-09T19:40:00"), "7:40pm");
  assert.equal(flights.saidTime("2026-10-09T00:05:00"), "12:05am");
  assert.equal(flights.saidTime("2026-10-09T12:00:00"), "12:00pm");
  assert.equal(flights.saidDay("2026-10-09T07:15:00", "America/New_York"), "Friday");
  // Los Angeles is this process's zone and 7:15am New York is 4:15am there. If that ever shows up
  // in what gets said, this is the test that catches it.
  assert.doesNotMatch(flights.saidTime("2026-10-09T07:15:00"), /4:15/);
});

test("a zone nobody knows, and a time that is not a time, are both refused rather than read as UTC", () => {
  assert.equal(flights.departureInstant("2026-10-09T07:15:00", "America/Atlantis").ok, false);
  assert.match(flights.departureInstant("2026-10-09T07:15:00", "America/Atlantis").error, /IANA/);
  assert.equal(flights.departureInstant("friday morning", "America/New_York").ok, false);
  assert.equal(flights.departureInstant("", "America/New_York").ok, false);
  // A time that carries its own offset has already answered the question.
  assert.equal(flights.departureInstant("2026-10-09T07:15:00-04:00", "").ok, true);
});

test("the window is the airline's own, with 24h as the default for one nobody has read", () => {
  assert.equal(flights.windowHoursFor("delta"), 24);
  assert.equal(flights.windowHoursFor("nobody_has_heard_of_this"), airlines.DEFAULT_WINDOW_HOURS);
  for (const a of airlines.AIRLINES) {
    assert.ok(a.checkin_opens_hours > 0, `${a.airline} has a check-in window`);
  }
});

// ---------- writing a flight down ----------

test("flight_save stamps the zone, works out both instants, and says when the offer will come", async () => {
  const out = await call("flight_save", FLIGHT);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.created, true);
  const row = db.getFlight(C, out.flight.id);
  assert.equal(row.time_zone, "America/New_York");
  assert.equal(row.departs_local, FLIGHT_DEPARTS);
  assert.equal(new Date(row.departs_at).toISOString(), FLIGHT_DEPARTS_UTC);
  assert.equal(new Date(row.checkin_opens_at).toISOString(), FLIGHT_CHECKIN_OPENS_UTC);
  assert.equal(row.checkin_window_hours, 24);
  assert.equal(row.status, "booked");
  assert.equal(out.flight.check_in.state, "too_early");
  assert.match(out.note, /check-in opens/);
  assert.match(out.note, /their own clock does not come into it/);
  assert.match(out.note, /do NOT set a timer/i);
});

test("saving the same flight twice is one row, and the second call adds rather than wipes", async () => {
  const first = await call("flight_save", { ...FLIGHT, passenger_name: "" });
  const second = await call("flight_save", { ...FLIGHT, passenger_name: "Omari Nyarko", seat_preference: "aisle if u can" });
  assert.equal(second.created, false);
  assert.equal(first.flight.id, second.flight.id);
  assert.equal(db.listFlights(C, { includeClosed: true }).length, 1);
  const row = db.getFlight(C, second.flight.id);
  assert.equal(row.passenger_name, "Omari Nyarko");
  assert.equal(row.confirmation_code, "ABC123", "the code the first call knew survived the second");
  assert.equal(row.seat_preference, "aisle if u can");
});

test("a seat preference is kept where every other taste is kept, so it outlives this flight", async () => {
  await call("flight_save", { ...FLIGHT, seat_preference: "aisle if u can" });
  const kept = db.listPreferences(C, { limit: 5 });
  assert.ok(kept.some(p => /aisle if u can/.test(p.words)), `it is on the preferences list: ${JSON.stringify(kept)}`);
});

test("the seat he asks for in the same breath as the yes arrives by the check-in door too", async () => {
  // The card's actual shape: Reason asks "want me to do it?" and the answer is "yes pls, aisle if u
  // can". So the preference comes in on flight_checkin_start, not on flight_save — the flight was
  // written down a day earlier, when nobody had said anything about a seat. This went unpinned once
  // and the field was missing from that tool's validator, which strips an unknown key rather than
  // refusing it: the description advertised it, the handler read it, and in between it was dropped
  // in silence. Asserted here on the one call, with the clock still outside the window, because the
  // handler takes what he said BEFORE it looks at the time — a too-early try still keeps it.
  const saved = await call("flight_save", FLIGHT);
  const id = saved.flight.id;
  const out = await call("flight_checkin_start", { flight_id: id, seat_preference: "aisle if u can" });

  assert.equal(out.blocked, "too_early", JSON.stringify(out).slice(0, 300));
  assert.match(String(db.getFlight(C, id).seat_preference), /aisle if u can/,
    "what he said in the same breath is not on the flight");
  assert.ok(db.listPreferences(C, { limit: 5 }).some(p => /aisle if u can/.test(p.words)),
    "and not kept as a lasting taste either, so the next flight starts out knowing nothing");
});

test("anything Reason worked out rather than was told is kept AS a guess", async () => {
  const out = await call("flight_save", { ...FLIGHT, guessed: ["departs_local", "destination"] });
  assert.deepEqual(db.getFlight(C, out.flight.id).guessed, ["departs_local", "destination"]);
  assert.match(out.flight.guessed_warning, /never as a fact/);
  assert.match(out.note, /as a guess, not as a fact/);
});

test("a departure already in the past is refused as a date read wrong, and nothing is written", async () => {
  const out = await call("flight_save", { ...FLIGHT, departs_local: "2025-10-09T07:15:00" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "already_gone");
  assert.match(out.error, /in the past/);
  assert.match(out.error, /Nothing was written down/);
  assert.equal(db.listFlights(C, { includeClosed: true }).length, 0);
});

test("a bad zone is refused with the question named, and nothing is written", async () => {
  const out = await call("flight_save", { ...FLIGHT, time_zone: "EST5EDT-ish" });
  assert.equal(out.ok, false);
  assert.match(out.error, /IANA/);
  assert.equal(db.listFlights(C, { includeClosed: true }).length, 0);
});

test("a card number in with the booking is refused, with nothing written and nothing read back", async () => {
  const out = await call("flight_save", { ...FLIGHT, notes: "paid on 4111 1111 1111 1111" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "looks_like_a_credential");
  assert.doesNotMatch(out.error, /4111/);
  assert.equal(db.listFlights(C, { includeClosed: true }).length, 0);
});

test("an airline nobody has written down is saved anyway, and said so now rather than at the gate", async () => {
  const out = await call("flight_save", { ...FLIGHT, airline: "Air Nobody" });
  assert.equal(out.ok, true);
  assert.equal(out.airline_known, false);
  assert.match(out.note, /no check-in page written down/);
  assert.match(out.note, /rather than guessing at a URL/);
});

// ---------- the offer ----------

test("there is no candidate before the window and exactly one inside it", async () => {
  const saved = await call("flight_save", FLIGHT);
  const row = db.getFlight(C, saved.flight.id);

  at(row.checkin_opens_at - HOUR);
  assert.equal(flights.candidates({ rows: db.flightsDueForCheckIn(clock.now()), now: clock.now() }).length, 0);

  at(row.checkin_opens_at + 60_000);
  const open = flights.candidates({ rows: db.flightsDueForCheckIn(clock.now()), now: clock.now() });
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "flight_checkin");
  assert.equal(open[0].thing, `flight:${row.id}`);
});

test("the offer's material names the real flight — the time and the place, never \"a flight\"", async () => {
  const row = await savedAndOpen();
  const [cand] = flights.candidates({ rows: db.flightsDueForCheckIn(clock.now()), now: clock.now() });
  assert.match(cand.what, /7:15am/);
  assert.match(cand.what, /atlanta/i);
  assert.match(cand.detail, /never "a flight"/);
  assert.equal(flights.inWords(row), "7:15am to atlanta");
});

test("a check-in candidate carries no start time, so the sweep does not park it until the gate", async () => {
  await savedAndOpen();
  // One `now`, read once. The clock here is the real one with an offset on it, so calling it twice
  // in the same assertion is a millisecond of drift and a test that fails for no reason.
  const now = clock.now();
  const [cand] = flights.candidates({ rows: db.flightsDueForCheckIn(now), now });
  assert.equal(cand.starts, undefined, "a `starts` here would delay the offer to two hours before departure");
  assert.equal(notice.momentFor(cand, now), now, "so its moment is now");
});

test("the sweep raises it with no Google connected at all", async () => {
  await savedAndOpen();
  const bundle = await notice.gather({ conversationId: C, now: clock.now() });
  assert.equal(bundle.ok, true, "a flight is reason enough for a bundle, with or without a mailbox");
  assert.equal(bundle.candidates.filter(x => x.kind === "flight_checkin").length, 1);
  assert.ok(bundle.context.some(l => /Google is not connected/.test(l)), "and it says why nothing of their mail is in it");
});

test("somebody with no flight and no Google is still 'not connected', so nothing is swept for nothing", async () => {
  const bundle = await notice.gather({ conversationId: C, now: clock.now() });
  assert.equal(bundle.ok, false);
  assert.equal(bundle.status, "not_connected");
});

test("a flight already checked in is handled rather than raised, and needs no mailbox to settle", async () => {
  const row = await savedAndOpen();
  const [cand] = flights.candidates({ rows: db.flightsDueForCheckIn(clock.now()), now: clock.now() });
  const written = db.recordNotice(C, { kind: cand.kind, key: cand.key, what: cand.what, momentAt: clock.now(), at: clock.now(), thing: cand.thing });

  let still = await notice.recheck({ conversationId: C, row: db.noticeById(written.id), now: clock.now() });
  assert.deepEqual(still, { ok: true }, "still worth raising while it has not happened");

  db.recordFlight(C, { airline: row.airline, airlineKey: row.airline_key, flightNumber: row.flight_number, confirmationCode: row.confirmation_code, departsLocal: row.departs_local, status: "checked_in", seat: "14C" });
  still = await notice.recheck({ conversationId: C, row: db.noticeById(written.id), now: clock.now() });
  assert.match(still.handled, /already checked in/);
  assert.equal(still.unclear, undefined, "and never hedged — an offer is live or it is gone");
});

test("one nudge per flight: a second day's candidate is refused while they have said nothing", async () => {
  const row = await savedAndOpen();
  // A chosen moment rather than whichever one the window opens on. Check-in for a 7:15am out of New
  // York opens at 4:15 in the morning where THIS person is, and notice.js holds anything unprompted
  // until their waking hours — which is the feature working and not what this test is about. So the
  // clock goes to the middle of their day, and the second moment is picked to be in their day too.
  at(row.checkin_opens_at + 5 * HOUR);
  const day1 = flights.candidates({ rows: [db.getFlight(C, row.id)], now: clock.now() })[0];
  const first = db.recordNotice(C, { kind: day1.kind, key: day1.key, what: day1.what, momentAt: clock.now(), at: clock.now(), thing: day1.thing });
  const sent = notice.send({ conversationId: C, input: { key: day1.key, specific_to_them: true, one_word_answerable: true, what: day1.what }, kind: "event", now: clock.now() });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  db.markNoticeSaid(C, { day: notice.localDay(clock.now(), config.tz), free: false });
  assert.ok(db.noticeById(first.id).said_at, "it really went out");

  // A later day inside the same window is a new candidate with a new key and the same `thing`.
  at(row.checkin_opens_at + 14 * HOUR);
  const day2 = flights.candidates({ rows: [db.getFlight(C, row.id)], now: clock.now() })[0];
  assert.ok(day2, "check-in is still open, so there is still something to raise");
  assert.notEqual(day2.key, day1.key);
  assert.equal(day2.thing, day1.thing);
  db.recordNotice(C, { kind: day2.kind, key: day2.key, what: day2.what, momentAt: clock.now(), at: clock.now(), thing: day2.thing });
  const again = notice.send({ conversationId: C, input: { key: day2.key, specific_to_them: true, one_word_answerable: true, what: day2.what }, kind: "event", now: clock.now() });
  assert.equal(again.ok, false);
  assert.equal(again.status, "already_nudged");
  assert.match(again.error, /One nudge per thing/);
});

test("an open check-in is in front of the model on an ordinary turn, so \"yes\" does not get \"which flight?\"", async () => {
  await savedAndOpen({ seat_preference: "aisle if u can" });
  const note = openWorkNote(C);
  assert.match(note, /check-in is open/);
  assert.match(note, /7:15am to atlanta/);
  assert.match(note, /aisle if u can/);
  assert.match(note, /do not ask them which flight/);
});

// ---------- the clock refusals, before any browser starts ----------

test("too early is refused with the real time on it, and nothing is touched", async () => {
  const saved = await call("flight_save", FLIGHT);
  const out = await call("flight_checkin_start", { flight_id: saved.flight.id });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "too_early");
  assert.ok(out.opens_in_hours >= 1);
  assert.match(out.error, /does not open/);
  assert.match(out.error, /do not set a timer/i);
  assert.equal(site.lookups.length, 0, "no page was opened");
  assert.equal(db.getFlight(C, saved.flight.id).status, "booked");
});

test("a flight that has already gone is recorded as missed rather than attempted", async () => {
  const saved = await call("flight_save", FLIGHT);
  const row = db.getFlight(C, saved.flight.id);
  at(row.departs_at + HOUR);
  const out = await call("flight_checkin_start", { flight_id: saved.flight.id });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "departed");
  assert.equal(db.getFlight(C, saved.flight.id).status, "missed");
  assert.equal(site.checkins.length, 0);
});

test("an airline nobody has written down is cant_do with the honest line, never a guessed URL", async () => {
  const saved = await call("flight_save", { ...FLIGHT, airline: "Air Nobody" });
  const row = db.getFlight(C, saved.flight.id);
  at(row.checkin_opens_at + HOUR);
  const out = await call("flight_checkin_start", { flight_id: saved.flight.id });
  assert.equal(out.ok, false);
  assert.equal(out.cant_do, "unknown");
  assert.match(out.say, /send me the check-in link/i);
  assert.match(out.note, /do not guess at a check-in URL/i);
  assert.equal(db.getFlight(C, saved.flight.id).status, "needs_them");
  assert.equal(site.lookups.length, 0);
});

test("an app-only or desk-only airline each says its own honest thing", () => {
  const app = airlines.cannotDo("app", "Air Nobody");
  assert.equal(app.kind, "app");
  assert.match(app.say, /can't tap your phone/);
  const desk = airlines.cannotDo("desk", "Air Nobody");
  assert.match(desk.say, /airport desk/);
  const fare = airlines.cannotDo("fare_class", "Air Nobody", { detail: "basic fare" });
  assert.match(fare.say, /airline's rule, not mine/);
  const money = airlines.cannotDo("costs_money", "Air Nobody", { detail: "a $35 bag" });
  assert.match(money.say, /don't spend your money/);
});

// ---------- the web rail ----------

test("the check-in page opens, the row says checking_in, and the code and last name are handed over", async () => {
  const row = await savedAndOpen();
  const out = await call("flight_checkin_start", { flight_id: row.id });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  assert.equal(out.rail, "web");
  assert.match(out.opened_url, /\/checkin$/);
  assert.equal(out.open_it_with.confirmation_code, "ABC123");
  assert.equal(out.open_it_with.last_name, "Omari Nyarko");
  assert.equal(db.getFlight(C, row.id).status, "checking_in");
  assert.equal(site.logins.length, 0, "no sign-in was needed and none was attempted");
  assert.match(out.address_not_verified, /Nobody has read/);
  assert.match(out.money_rule, /NOTHING is bought here/);
  assert.match(out.watch_for, /MORE THAN ONE passenger/);
});

test("a check-in page that will not load is the site's choice, said as such, with the steps", async () => {
  const row = await savedAndOpen();
  const dead = airlines.withExtra([{ ...site.entry(), checkin_url: "http://127.0.0.1:1/checkin" }]);
  const out = await runTool("flight_checkin_start", { flight_id: row.id }, { conversationId: C, messages: [], judge: readsYes, airlines: dead });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "page_would_not_load");
  assert.match(out.error, /site refusing rather than something being wrong with you/);
  assert.match(out.error, /no pretending to be another browser/);
  assert.ok(out.steps_they_take.length);
  assert.equal(db.getFlight(C, row.id).status, "needs_them");
  assert.equal(site.checkins.length, 0);
});

test("no code and not signed in: the shorter road is offered first, and never a password", async () => {
  const saved = await call("flight_save", { ...FLIGHT, confirmation_code: "" });
  const row = db.getFlight(C, saved.flight.id);
  at(row.checkin_opens_at + HOUR);
  site.signOut();
  const out = await call("flight_checkin_start", { flight_id: row.id });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "not_signed_in");
  assert.match(out.the_cheaper_way, /confirmation code/);
  assert.equal(out.never_a_password.rule, "no_passwords_in_chat");
  assert.match(out.never_a_password.say, /don't take passwords/i);
  assert.match(out.error, /Never ask for a password/);
  assert.equal(db.getFlight(C, row.id).status, "needs_them");
  assert.equal(site.checkins.length, 0);
});

test("no code but signed in: the account page is the door, not the lookup form", async () => {
  const saved = await call("flight_save", { ...FLIGHT, confirmation_code: "" });
  const row = db.getFlight(C, saved.flight.id);
  at(row.checkin_opens_at + HOUR);
  site.signIn();
  const out = await call("flight_checkin_start", { flight_id: row.id });
  // What the probe read is the first thing in the message: this failed about once in a hundred runs
  // under a loaded suite, in ~13 ms (so the probe's page load threw), and the old 300-character cut
  // ended before `site_says`, which is the one field that would say why.
  assert.equal(out.ok, true, JSON.stringify({ site_says: out.site_says, blocked: out.blocked, error: out.error }));
  assert.match(out.opened_url, /\/account$/);
  assert.equal(out.signed_in, "signed_in");
});

// ---------- the gate ----------

test("the press needs a yes, and it is pinned to the flight as well as the details", async () => {
  const row = await savedAndOpen();
  const start = await call("flight_checkin_start", { flight_id: row.id });
  const page = await browser.pageFor(C);
  // Walk it the way the model would: fill the lookup form, continue, land on the trip.
  await browser.locate(page, ref(start.page, e => /confirmation code/i.test(e.name ?? ""))).fill("ABC123");
  await browser.locate(page, ref(start.page, e => /last name/i.test(e.name ?? ""))).fill("Nyarko");
  const cont = ref(start.page, e => /continue/i.test(e.name ?? ""));
  await browser.locate(page, cont).click();
  await page.waitForLoadState("domcontentloaded");
  const trip = await browser.snapshot(page);
  const commit = ref(trip, e => /^check in$/i.test(e.name ?? ""));
  assert.ok(commit, `the page has a Check in button: ${JSON.stringify(trip.elements)}`);

  // An ordinary click on it is refused by the guard, which is the system working.
  const refused = await call("browser_click", { ref: commit, expect: "check in" });
  assert.equal(refused.blocked, "commit_needs_gate", JSON.stringify(refused).slice(0, 300));
  assert.equal(site.checkins.length, 0);

  // And so is the commit with no yes — handing back the exact string the yes has to be pinned to.
  const noYes = await call("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, Fri 7:15am JFK to ATL, Omari Nyarko, seat 14C, nothing to pay" });
  assert.equal(noYes.blocked, "needs_confirmation");
  assert.match(noYes.use_target, new RegExp(`^flight #${row.id}: `));
  assert.equal(site.checkins.length, 0);
});

test("a yes for one flight cannot be spent on another", async () => {
  const row = await savedAndOpen();
  const other = await call("flight_save", { ...FLIGHT, flight_number: "DL 9999", confirmation_code: "ZZZ999", departs_local: FLIGHT_OTHER_DEPARTS });
  const start = await call("flight_checkin_start", { flight_id: row.id });
  const page = await browser.pageFor(C);
  await browser.locate(page, ref(start.page, e => /confirmation code/i.test(e.name ?? ""))).fill("ABC123");
  await browser.locate(page, ref(start.page, e => /last name/i.test(e.name ?? ""))).fill("Nyarko");
  await browser.locate(page, ref(start.page, e => /continue/i.test(e.name ?? ""))).click();
  await page.waitForLoadState("domcontentloaded");
  const trip = await browser.snapshot(page);
  const commit = ref(trip, e => /^check in$/i.test(e.name ?? ""));

  const what = "Fixture Air DL 1234, seat 14C";
  const blocked = await call("flight_checkin_commit", { flight_id: row.id, ref: commit, what });
  const messages = [owner("do it")];
  const req = await runTool("confirm_request", { action: "flight_checkin_commit", summary: what, target: blocked.use_target }, { conversationId: C, messages });
  messages.push(owner("yes pls"));
  await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId: C, messages, judge: readsYes });

  const wrong = await call("flight_checkin_commit", { flight_id: other.flight.id, ref: commit, what, confirmation_id: req.confirmation_id }, { messages });
  assert.equal(wrong.ok, false, JSON.stringify(wrong).slice(0, 300));
  assert.equal(wrong.blocked, "wrong_target", JSON.stringify(wrong).slice(0, 300));
  assert.equal(site.checkins.length, 0, "and nobody was checked in");
});

// ---------- the press, and what it is allowed to claim ----------

/** Walk the fixture to the trip screen and give back the ref of its Check in button. */
async function toTheLastButton(row) {
  const start = await call("flight_checkin_start", { flight_id: row.id });
  assert.equal(start.ok, true, JSON.stringify(start).slice(0, 300));
  const page = await browser.pageFor(C);
  await browser.locate(page, ref(start.page, e => /confirmation code/i.test(e.name ?? ""))).fill("ABC123");
  await browser.locate(page, ref(start.page, e => /last name/i.test(e.name ?? ""))).fill("Nyarko");
  await browser.locate(page, ref(start.page, e => /continue/i.test(e.name ?? ""))).click();
  await page.waitForLoadState("domcontentloaded");
  const trip = await browser.snapshot(page);
  return { start, trip, commit: ref(trip, e => /^check in$/i.test(e.name ?? "")) };
}

test("checked in, verified off the page, with the seat they asked for named", async () => {
  const row = await savedAndOpen({ seat_preference: "aisle if u can" });
  const { commit } = await toTheLastButton(row);
  const { out } = await withYes("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, Omari Nyarko, seat 14C" });

  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  assert.equal(out.status, "checked_in");
  assert.equal(site.checkins.length, 1, "the airline really was told");
  assert.equal(out.verified.seat, "14C");
  assert.equal(out.verified.seat_read, "labelled");
  assert.equal(out.verified.seat_kind, "aisle");
  assert.match(out.verified.checked_in_because, /checked in/);
  assert.match(out.verified.name_on_it, /omari nyarko/i);
  assert.equal(out.preference_matched, true, "they asked for an aisle and 14C is one");
  assert.match(out.note, /you may say done/);

  const saved = db.getFlight(C, row.id);
  assert.equal(saved.status, "checked_in");
  assert.equal(saved.seat, "14C");
  assert.ok(saved.checked_in_at);
  assert.ok(saved.shot_path && existsSync(saved.shot_path), "and a picture of the screen the claim came off");

  // The receipt somebody would come back and read.
  const receipt = db.listActions(C, { limit: 5 }).find(r => r.action === "flight_checkin_commit");
  assert.ok(receipt, "there is a ledger row");
  assert.equal(receipt.outcome, "ok");
  assert.match(receipt.receipt, /CHECKED IN/);
  assert.match(receipt.receipt, /seat 14C/);
});

test("a page that takes the press and does not confirm it leaves the row at checking_in", async () => {
  site.set({ confirms: false, showsSeat: false });
  const row = await savedAndOpen();
  const { commit } = await toTheLastButton(row);
  const { out } = await withYes("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, seat 14C" });

  assert.equal(out.status, "checking_in");
  assert.ok(out.not_verified.length >= 2, JSON.stringify(out.not_verified));
  assert.match(out.note, /did NOT confirm/);
  assert.match(out.note, /Never say "done"/);
  assert.equal(db.getFlight(C, row.id).status, "checking_in");
  assert.equal(db.getFlight(C, row.id).checked_in_at, null);
  assert.ok(out.furthest, "and the furthest point is handed back rather than a bare failure");
});

test("a page that confirms somebody ELSE's booking is not a check-in", async () => {
  site.set({ passenger: "MENSAH/AKUA" });
  const row = await savedAndOpen();
  const { commit } = await toTheLastButton(row);
  const { out } = await withYes("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, seat 14C" });
  assert.equal(out.status, "checking_in");
  assert.ok(out.not_verified.some(m => /does not say/.test(m)), JSON.stringify(out.not_verified));
  assert.equal(db.getFlight(C, row.id).status, "checking_in");
});

test("two people on one booking stops and asks, and never says you're both in", async () => {
  site.set({ secondPassenger: "MENSAH/AKUA" });
  const row = await savedAndOpen();
  const { commit } = await toTheLastButton(row);
  const { out } = await withYes("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, seat 14C" });
  assert.equal(out.status, "checking_in");
  assert.deepEqual(out.passengers.others, ["MENSAH/AKUA"]);
  assert.match(out.say, /check you both in, or just you/);
  assert.match(out.note, /does not check somebody else in/);
  assert.equal(db.getFlight(C, row.id).status, "needs_them");
});

test("a page that wants paying stops BEFORE the press, and their yes is still unspent", async () => {
  site.set({ wantsMoney: true });
  const row = await savedAndOpen();
  const { commit } = await toTheLastButton(row);
  const { out, confirmation_id } = await withYes("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, seat 14C, $35 bag" });

  assert.equal(out.ok, false);
  assert.equal(out.blocked, "would_spend_money");
  assert.equal(out.cant_do, "costs_money");
  assert.equal(site.checkins.length, 0, "NOBODY was checked in");
  assert.match(out.error, /does not spend/);
  assert.match(out.error, /do not ask for a card/i);
  assert.equal(db.getConfirmation(C, confirmation_id).consumed_at, null, "the yes survives a press that never happened");
  assert.equal(db.getFlight(C, row.id).status, "needs_them");
  assert.ok(out.furthest, "and the page is handed back with the one tap on it");
  assert.match(out.furthest.one_action, /it wants paying/);
});

test("an airline that refuses self check-in on this fare is reported in its own words, unpressed", async () => {
  site.set({ refusesFare: true });
  const row = await savedAndOpen();
  const start = await call("flight_checkin_start", { flight_id: row.id });
  const page = await browser.pageFor(C);
  await browser.locate(page, ref(start.page, e => /confirmation code/i.test(e.name ?? ""))).fill("ABC123");
  await browser.locate(page, ref(start.page, e => /last name/i.test(e.name ?? ""))).fill("Nyarko");
  await browser.locate(page, ref(start.page, e => /continue/i.test(e.name ?? ""))).click();
  await page.waitForLoadState("domcontentloaded");
  const snap = await browser.snapshot(page);
  // A refusal page has nothing to check in with — only the way back. So the commit is asked about
  // that, WITH a yes in hand, and what matters is that it reads the page's own words and stops
  // before pressing anything: the refusal has to beat the press, not follow it.
  const anyRef = ref(snap, e => /back/i.test(e.name ?? ""));
  assert.ok(anyRef, `the refusal page has something on it: ${JSON.stringify(snap.elements)}`);
  const { out } = await withYes("flight_checkin_commit", { flight_id: row.id, ref: anyRef, what: "Fixture Air DL 1234" });
  assert.equal(out.ok, false, JSON.stringify(out).slice(0, 300));
  assert.equal(out.blocked, "airline_refused");
  assert.equal(out.cant_do, "fare_class");
  assert.match(out.page_says, /cannot check in online|see an agent/i);
  assert.equal(site.checkins.length, 0);
  assert.equal(db.getFlight(C, row.id).status, "needs_them", "and the row says it is theirs to do now");
});

test("a flight already checked in refuses a second go and points at the pass", async () => {
  const row = await savedAndOpen();
  const { commit } = await toTheLastButton(row);
  await withYes("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, seat 14C" });
  const again = await call("flight_checkin_start", { flight_id: row.id });
  assert.equal(again.ok, false);
  assert.equal(again.already, "checked_in");
  assert.match(again.error, /boarding_pass/);
  assert.equal(site.checkins.length, 1, "and the airline was told exactly once");
});

// ---------- the boarding pass ----------

test("a boarding pass is refused on a flight that is not checked in", async () => {
  const row = await savedAndOpen();
  const out = await call("boarding_pass", { flight_id: row.id });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "not_checked_in");
  assert.match(out.error, /worst possible thing/);
});

test("the pass carries the real airport code and the real local time, and keeps its link", async () => {
  const row = await savedAndOpen({ seat_preference: "aisle if u can" });
  const { commit } = await toTheLastButton(row);
  await withYes("flight_checkin_commit", { flight_id: row.id, ref: commit, what: "Fixture Air DL 1234, seat 14C" });

  const pass = await call("boarding_pass", { flight_id: row.id });
  assert.equal(pass.ok, true, JSON.stringify(pass).slice(0, 300));
  // Verbatim from the use-case card on the site, which is this feature's acceptance spec.
  assert.equal(pass.label, "Boarding pass · ATL 7:15 AM");
  assert.equal(pass.title, "Boarding pass · ATL 7:15 AM");
  assert.ok(pass.link, "and a link to send");
  assert.match(pass.note, /not the airline's scannable pass/);
  const saved = db.getPageIn(C, pass.page_id);
  const text = JSON.stringify(saved.blocks);
  assert.match(text, /14C/);
  assert.match(text, /ATL/);
  assert.match(text, /7:15am/);
  assert.match(text, /America\/New_York/, "the zone is on it, because the time on it is local to the airport");

  // Again, and it is the same page at the same link — a link already sent still works.
  const second = await call("boarding_pass", { flight_id: row.id });
  assert.equal(second.page_id, pass.page_id);
  assert.equal(second.link, pass.link);
  assert.equal(db.listPages(C).length, 1);
});

test("a flight with no airport code still says where he is going on the label", async () => {
  // "flying to atlanta friday at 7:15am" is how this really arrives, and a row written from that
  // sentence does not always carry an IATA code. It read "Boarding pass · 7:15 AM" once — a label
  // that has lost the one thing it was for. The city's own name is the fallback, never nothing.
  assert.equal(
    flights.boardingPassTitle({ destination: "", destination_name: "Atlanta", departs_local: "2026-10-09T07:15:00" }),
    "Boarding pass · Atlanta 7:15 AM");
  // The code still wins when the row has one, so the card's own string is unchanged.
  assert.equal(
    flights.boardingPassTitle({ destination: "atl", destination_name: "Atlanta", departs_local: "2026-10-09T07:15:00" }),
    "Boarding pass · ATL 7:15 AM");
});

// ---------- reading a page, in the small ----------

test("a seat is read from a label first, and a bare row-letter pair only when there is no label", () => {
  assert.deepEqual(flights.seatIn("Seat 14C"), { seat: "14C", how: "labelled" });
  assert.deepEqual(flights.seatIn("Your seat: 3A"), { seat: "3A", how: "labelled" });
  // A flight number is not a seat, and nothing labelled means the reading is marked as weaker.
  assert.equal(flights.seatIn("DL 1234 to ATL").how, "none");
  assert.deepEqual(flights.seatIn("you are in 14C"), { seat: "14C", how: "unlabelled" });
});

test("an aisle is an aisle and a middle is a middle, and nothing else is guessed", () => {
  assert.equal(flights.seatKind("14C"), "aisle");
  assert.equal(flights.seatKind("14D"), "aisle");
  assert.equal(flights.seatKind("14A"), "window");
  assert.equal(flights.seatKind("14B"), "middle");
  assert.equal(flights.seatKind(""), "");
  assert.equal(flights.seatKind("14C", { layout: "2-4-2" }), "", "a widebody is not something a seat number can tell you");
});

test("a middle seat after they asked for an aisle is said plainly, and never bought out of", () => {
  const worse = flights.againstPreference("14B", "aisle if u can");
  assert.equal(worse.matched, false);
  assert.match(worse.say, /worse outcome than they wanted/);
  assert.match(worse.say, /does not buy a different seat/);
  assert.equal(flights.againstPreference("14C", "aisle if u can").matched, true);
  assert.equal(flights.againstPreference("14C", "").say, "");
});

test("a payment wall is a card field, the page's own words, or a pay button — and nothing looser", () => {
  assert.equal(flights.moneyWall({ text: "Checked bags are $35 each." }).wall, false,
    "a check-in page that merely mentions what a bag costs is an ordinary check-in page");
  assert.equal(flights.moneyWall({ text: "Payment required to continue." }).wall, true);
  assert.equal(flights.moneyWall({ text: "", elements: [{ tag: "input", name: "Card number" }] }).wall, true);
  assert.equal(flights.moneyWall({ text: "", pressing: "Pay $35" }).wall, true);
  assert.equal(flights.moneyWall({ text: "", pressing: "Check in" }).wall, false);
});

test("a page footer is not a second passenger", () => {
  const footer = "Terms/Privacy · AND/OR · NYARKO/OMARI · Seat 14C";
  const read = flights.otherPassengers(footer, "Omari Nyarko");
  assert.deepEqual(read.others, []);
  assert.equal(read.more_than_one, false);
  const real = flights.otherPassengers(`${footer} MENSAH/AKUA`, "Omari Nyarko");
  assert.deepEqual(real.others, ["MENSAH/AKUA"]);
  assert.equal(real.more_than_one, true);
  // And the page saying so in a number is believed on its own.
  assert.equal(flights.otherPassengers("2 passengers on this booking", "Omari Nyarko").more_than_one, true);
});

// ---------- the registry, and the guard it feeds ----------

test("every check-in commit label is in the browser's click guard, and 'Continue' is not", () => {
  for (const word of airlines.commitWords()) {
    const el = { tag: "button", type: "submit", name: word, href: "", inForm: true, isSubmit: true };
    assert.equal(clickCommits(el).commits, true, `'${word}' has to need a yes`);
  }
  for (const word of ["Continue", "Next", "Done"]) {
    const el = { tag: "button", type: "submit", name: word, href: "", inForm: true, isSubmit: true };
    assert.equal(clickCommits(el).commits, false, `'${word}' commits nothing on almost every page`);
  }
  // A link still navigates. Gating one would spend his yes on opening a page.
  assert.equal(clickCommits({ tag: "a", type: "", name: "Check in", href: "/checkin", inForm: false, isSubmit: false }).commits, false);
});

test("the registry is honest about never having been read", () => {
  for (const a of airlines.AIRLINES) {
    assert.equal(a.source.how, "not_read", `${a.airline} must not claim a source it does not have`);
    assert.equal(a.url_verified, false, `${a.airline}'s address was never verified`);
    assert.ok(airlines.ROUTE_KINDS.includes(a.route));
  }
  const play = airlines.playbook("delta");
  assert.match(play.read_from, /NOBODY READ THIS AIRLINE'S OWN PAGE/);
  // And the two whose refusal of this browser was actually observed say so.
  assert.match(airlines.airline("delta").refuses_this_browser, /Access Denied/);
  assert.match(airlines.airline("united").refuses_this_browser, /dropped the connection/);
});

test("delta and united stay the errand-site sign-ins, because that is where their refusal is written down", () => {
  // src/sites.js got there first and its entries came from a real probe. An airline entry quietly
  // replacing one would hide the most useful fact anybody has about those two sites.
  assert.equal(signin.entryFor("delta").from_airlines, undefined);
  assert.equal(signin.entryFor("southwest").from_airlines, true, "an airline with no errand entry resolves to the airline one");
  assert.ok(signin.signinNames().includes("southwest"));
  assert.equal(new Set(signin.signinNames()).size, signin.signinNames().length, "and the list has no duplicates");
});

test("a two-letter code only matches a whole string or a flight number, never a word it sits inside", () => {
  assert.equal(airlines.match("DL 1234")?.airline, "delta");
  assert.equal(airlines.match("AA")?.airline, "american");
  assert.equal(airlines.match("alaska")?.airline, "alaska");
  assert.equal(airlines.match("has a seat"), null, "'as' inside a sentence is not Alaska Airlines");
  assert.equal(airlines.match(""), null);
});

// ---------- what Reason says about itself ----------

test("the capability says what it does and that no real airline has ever been checked in to", async () => {
  await call("flight_save", FLIGHT);
  const cap = capabilitiesNow({ conversationId: C }).find(x => x.name === "flight_check_in");
  assert.equal(cap.status, "live");
  assert.match(cap.what, /NEVER spends money/);
  assert.match(cap.what, /No real airline has ever been checked in to/);
  assert.match(cap.what, /1 flight\(s\) written down/);
});

test("flight_list is the truth, and an empty one says nothing is being watched", async () => {
  const empty = await call("flight_list", {});
  assert.deepEqual(empty.flights, []);
  assert.match(empty.note, /nothing is being watched/);

  const saved = await call("flight_save", FLIGHT);
  db.recordFlight(C, { airline: FLIGHT.airline, airlineKey: "fixture_air", flightNumber: FLIGHT.flight_number, confirmationCode: FLIGHT.confirmation_code, departsLocal: FLIGHT.departs_local, status: "checking_in" });
  const listed = await call("flight_list", {});
  assert.equal(listed.flights.length, 1);
  assert.equal(listed.flights[0].id, saved.flight.id);
  assert.match(listed.flights[0].says, /NOT checked in/);
  assert.match(listed.note, /'checking_in' is NOT checked in/);
});

test("forgetting a flight stops the offer, and says so if they were really checked in", async () => {
  const row = await savedAndOpen();
  db.recordFlight(C, { airline: row.airline, airlineKey: row.airline_key, flightNumber: row.flight_number, confirmationCode: row.confirmation_code, departsLocal: row.departs_local, status: "checked_in", seat: "14C" });
  const out = await call("flight_forget", { flight_id: row.id });
  assert.equal(out.ok, true);
  assert.match(out.note, /does not undo/);
  assert.equal(db.getFlight(C, row.id), null);
  assert.equal(flights.candidates({ rows: db.flightsDueForCheckIn(clock.now()), now: clock.now() }).length, 0);
});

test("every flight tool is on the list the model is shown, and the commit is gated everywhere", () => {
  const names = tools.map(t => t.name);
  for (const n of ["flight_save", "flight_list", "flight_forget", "flight_checkin_start", "flight_checkin_commit", "boarding_pass"]) {
    assert.ok(names.includes(n), `${n} is a tool the model can see`);
  }
});

test("\"just check me in, stop asking\" cannot be granted, and the refusal says why", async () => {
  // The card on Reason's own site promises four words — asks before it touches anything — and a
  // standing permission would make that copy false. The reason it is the right call rather than
  // merely the careful one is that the yes covers what the LAST screen says, and nobody granting a
  // permission has seen that screen: there would be nothing left for the permission to bound.
  assert.ok(permissions.NEVER_STANDING.has("flight_checkin_commit"));
  assert.ok(!permissions.knownScopeActions().includes("flight_checkin_commit"),
    "so it is never offered as something a sentence could name");
  const out = await call("permission_grant", {
    text: "just check me in for flights, stop asking me",
    scope: { action: "flight_checkin_commit" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "never_standing");
  assert.match(out.error, /the seat it is offering/, "and the refusal carries the real reason, not just the refusal");
  assert.match(out.error, /the offer arrives by itself/, "plus the thing they actually wanted, which already works");
  assert.equal(db.listPermissions(C).length, 0, "and nothing was saved");
});

// ---------- their data ----------

test("a flight is in an export and gone after a delete", async () => {
  await call("flight_save", FLIGHT);
  const out = exportData({ conversation: C, audio: false });
  assert.equal(out.tables.flights.length, 1, "their flights are part of a copy of their data");
  assert.equal(out.tables.flights[0].confirmation_code, FLIGHT.confirmation_code,
    "and the code is in the copy, because it is theirs");

  await deleteData({ conversation: C });
  assert.equal(db.listFlights(C, { includeClosed: true }).length, 0, "and a delete takes them");
});
