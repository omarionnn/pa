// Flight search through Fli (src/fli.js, src/flightsearch.js, scripts/fli_sidecar.py), 2026-10-24.
// Pinned, one per rule:
//
//   - the model's plain fields become exactly what Fli takes: metro lists, windows, the party rules;
//   - a refinement keeps every earlier constraint until one is changed or cleared;
//   - the list says "from $X", carries a Google Flights link per option, and its limits;
//   - an unusually cheap fare says bags/seats weren't checked; an empty family search is not "none";
//   - a sweep compares only against numbers inside that sweep, and runs once per message;
//   - a fare is re-verified before it's recommended, and a moved price is said as moved;
//   - blocked, down and timed-out are "I couldn't check flights right now", never "no flights";
//   - the sidecar starts on demand, restarts after a crash, stops when idle, backs off when refused;
//   - one person's searches can't be refined or verified from another person's conversation;
//   - /ops reads the last real search and never calls Google.
//
// No Python, no Google: a fake sidecar answers from recorded fixtures (test/fixtures/fli/). The one
// test that runs real Python runs only the stdlib response classifier, and only if python3 exists.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-flightsearch-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const offers = await import("../src/offers.js");
const accounts = await import("../src/accounts.js");
const fs = await import("../src/flightsearch.js");
const { FliSidecar, FliError, LEDGER_ID } = await import("../src/fli.js");
const ops = await import("../src/ops.js");
const { clock } = await import("../src/config.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "fli");
const fixture = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const ALICE = "dm:alice";
const BOB = "dm:bob";

after(() => rmSync(dir, { recursive: true, force: true }));

const day = (n) => new Date(Date.parse(`${accounts.today()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A sidecar that answers from fixtures and remembers every request. */
function fakeSidecar(answers = {}) {
  const calls = [];
  const answer = async (op, params) => {
    calls.push({ op, params });
    const a = answers[op];
    const v = typeof a === "function" ? a(params, calls.length) : a;
    if (v instanceof Error) throw v;
    return structuredClone(v);
  };
  return {
    calls,
    searchFlights: (p) => answer("searchFlights", p),
    searchDates: (p) => answer("searchDates", p),
  };
}

beforeEach(() => {
  clock.reset?.();
  db.db.exec("DELETE FROM flight_searches; DELETE FROM provider_state; DELETE FROM provider_calls;");
  for (const [c, name] of [[ALICE, "Alice"], [BOB, "Bob"]]) {
    db.upsertAccount({ conversationId: c, channel: "test", address: c, name, isOperator: c === ALICE });
    offers.beginTurn(c, "find me flights", "user");
  }
});

// ---------- checking what the model passed ----------

test("metro lists pass through as comma lists; a city name instead of codes is sent back to the model", () => {
  assert.deepEqual(fs.airportList("jfk, ewr LGA", "origin").codes, ["JFK", "EWR", "LGA"]);
  assert.match(fs.airportList("NYC,London", "origin").error, /expand a city into its airports/);
  assert.match(fs.airportList("A,B,C,D,E,F,G,H,I".split(",").map(x => x.repeat(3)).join(","), "origin").error, /at most 8/);
});

test("the party rules: 1-9 travellers, never more lap infants than adults", () => {
  assert.equal(fs.partyError({ adults: 2, children: 1, infants_on_lap: 1 }), null);
  assert.match(fs.partyError({ adults: 1, infants_on_lap: 2 }), /each lap infant needs an adult/);
  assert.match(fs.partyError({ adults: 6, children: 4 }), /9 at most/);
  assert.match(fs.partyError({ adults: 0, children: 2 }), /at least one adult/);
});

test("fields map onto Fli's own parameter names and enums", () => {
  const { params } = fs.toSidecarFlights({
    origin: "JFK,EWR,LGA", destination: "LHR", depart_date: day(30), return_date: day(35),
    max_stops: "NON_STOP", depart_after_hour: 17, cabin: "BUSINESS", exclude_airlines: ["nk"], alliances: ["ONEWORLD"],
    min_layover_minutes: 60, adults: 2, infants_on_lap: 1,
  }, { today: day(0) });
  assert.equal(params.origin, "JFK,EWR,LGA");
  assert.equal(params.departure_window, "17-23");
  assert.equal(params.return_window, null, "'leave after work' is about the way out, not the way back");
  assert.equal(params.max_stops, "NON_STOP");
  assert.deepEqual(params.exclude_airlines, ["NK"]);
  assert.equal(params.top_n, fs.DEFAULT_TOP_N, "top_n stays at Fli's default 5 unless they ask for more");
  assert.equal(params.currency, "USD", "always USD: from Hetzner's German IP Google answered in EUR");
  assert.equal(params.infants_on_lap, 1);
  assert.match(fs.toSidecarFlights({ origin: "JFK", destination: "LAX", depart_date: day(-1) }, { today: day(0) }).error, /in the past/);
  assert.match(fs.toSidecarFlights({ origin: "JFK", destination: "JFK", depart_date: day(3) }, { today: day(0) }).error, /share an airport/);
});

test("a window that wraps midnight is refused, never silently flipped by Fli's swap", () => {
  const out = fs.toSidecarFlights({ origin: "JFK", destination: "LAX", depart_date: day(5), depart_after_hour: 22, depart_before_hour: 6 }, { today: day(0) });
  assert.match(out.error, /can't wrap past midnight/);
  assert.equal(fs.toSidecarFlights({ origin: "JFK", destination: "LAX", depart_date: day(5), depart_after_hour: 6, depart_before_hour: 22 }, { today: day(0) }).params.departure_window, "6-22");
});

test("a sweep is capped at 93 days and says how many page fetches it costs", () => {
  const ok = fs.toSidecarDates({ origin: "JFK", destination: "MIA", from_date: day(1), to_date: day(93), trip_days: 5 }, { today: day(0) });
  assert.equal(ok.days, 93);
  assert.equal(ok.pages, 2, "Fli reads the calendar in ≤61-day pages, not one fetch per date");
  assert.match(fs.toSidecarDates({ origin: "JFK", destination: "MIA", from_date: day(1), to_date: day(100) }, { today: day(0) }).error, /93 at most/);
});

// ---------- what comes back ----------

test("the short list: 'from $X' floor, each option with times, stops, layover airports and its own link", () => {
  const result = fixture("one-way.json");
  const params = fs.toSidecarFlights({ origin: "JFK,EWR,LGA", destination: "LHR,LGW,STN", depart_date: "2026-11-24" }, { today: "2026-10-24" }).params;
  const list = fs.shortList(result, params, { show: 5 });
  assert.equal(list.length, 5);
  assert.equal(list[0].price, "$98");
  assert.equal(list[1].price, "$289");
  assert.equal(list[1].flights, "TP212 EWR→OPO, TP1330 OPO→LGW");
  assert.deepEqual(list[1].layovers, ["OPO 6h 5m"]);
  assert.equal(list[1].depart, "Tue, Nov 24, 12:45am", "the airport's own wall clock, never shifted to the server's zone");
  assert.match(list[1].link, /^https:\/\/www\.google\.com\/travel\/flights\?q=Flights%20from%20EWR%20to%20LGW%20on%202026-11-24%20one%20way&curr=USD/);
  assert.equal(list[0].unusually_cheap, true, "$98 against a $340-ish median is flagged");
  const limits = fs.limitsFor({ params, found: result.count, options: list });
  assert.ok(limits.some(l => /never "the cheapest flight"/.test(l)));
  assert.ok(limits.some(l => /baggage, seat selection and whether it's basic economy were NOT checked/.test(l)));
});

test("a round trip lists one pairing per way out, priced on the outbound row", () => {
  const result = fixture("round-trip.json");
  const params = fs.toSidecarFlights({ origin: "JFK", destination: "LAX", depart_date: "2026-11-24", return_date: "2026-11-29" }, { today: "2026-10-24" }).params;
  const list = fs.shortList(result, params, { show: 5 });
  assert.equal(list.length, 3, "six pairings of three outbounds → three options");
  assert.deepEqual(list.map(o => o.price), ["$613", "$640", "$655"]);
  // Every pairing of B6 523 carries the outbound's $613; the return rows differ ($613 B6 524, $640
  // B6 1024). The one Google priced lowest is shown, not the quicker $640 one (review, 2026-10-24).
  assert.equal(list[0].return.flights, "B6524 LAX→JFK", "the return Google priced lowest with that way out");
  assert.match(list[0].link, /through%202026-11-29/);
  assert.ok(fs.limitsFor({ params, found: 6, options: list }).some(l => /6 page fetches/.test(l)));
});

test("a round trip with equal return prices still takes the quicker return", () => {
  const result = fixture("round-trip.json");
  for (const it of result.itineraries) it.return.price = 613;
  const params = fs.toSidecarFlights({ origin: "JFK", destination: "LAX", depart_date: "2026-11-24", return_date: "2026-11-29" }, { today: "2026-10-24" }).params;
  assert.equal(fs.shortList(result, params)[0].return.flights, "B61024 LAX→JFK");
});

test("a partly refused search says the list is partial, and verify never calls a missing flight gone", async () => {
  const s = await runTool("flight_search", { origin: "JFK", destination: "LAX", depart_date: day(30), return_date: day(35) }, { conversationId: ALICE, fli: fakeSidecar({ searchFlights: fixture("round-trip.json") }) });
  assert.equal(s.ok, true);
  const partial = () => { const r = fixture("round-trip.json"); r.itineraries = r.itineraries.filter(it => it.legs[0].flight_number !== "523"); r.count = r.itineraries.length; r.refused_fetches = 2; return r; };
  const v = await runTool("flight_verify", { search_id: s.search_id, option: 1 }, { conversationId: ALICE, fli: fakeSidecar({ searchFlights: partial }) });
  assert.equal(v.couldnt_check, true, JSON.stringify(v));
  assert.equal(v.stale, true);
  assert.notEqual(v.still_there, false, "never 'it may have sold out' off a partial answer");
  const params = fs.toSidecarFlights({ origin: "JFK", destination: "LAX", depart_date: day(30) }, { today: accounts.today() }).params;
  assert.ok(fs.limitsFor({ params, found: 4, refused: 2 }).some(l => /partial list/.test(l)));
});

test("a flight 'today' is checked against THEIR date, not the server's", async () => {
  const CAROL = "dm:carol";
  db.upsertAccount({ conversationId: CAROL, channel: "test", address: "+12025550111", name: "Carol" });
  db.setNoticeWindow(CAROL, { tz: "Pacific/Pago_Pago" });
  const theirs = () => new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: "Pacific/Pago_Pago" });
  try {
    for (let i = 0; i < 24 && theirs() === accounts.today(); i++) clock.skip(3_600_000);
    assert.notEqual(theirs(), accounts.today(), "found an hour where their date is behind the server's");
    const out = await runTool("flight_search", { origin: "SFO", destination: "LAX", depart_date: theirs() }, { conversationId: CAROL, fli: fakeSidecar({ searchFlights: fixture("one-way.json") }) });
    assert.equal(out.ok, true, out.error);
  } finally {
    clock.reset();
  }
});

test("verify refuses a search whose date has passed", async () => {
  const s = await runTool("flight_search", { origin: "JFK", destination: "LAX", depart_date: day(1) }, { conversationId: ALICE, fli: fakeSidecar({ searchFlights: fixture("one-way.json") }) });
  const out = await fs.runVerify(ALICE, { search_id: s.search_id, option: 1 }, { sidecar: fakeSidecar({}), db, today: day(2) });
  assert.equal(out.ok, false);
  assert.match(out.error, /has passed/);
});

test("an empty family search says it is not proof there are no flights", () => {
  const params = fs.toSidecarFlights({ origin: "BOS", destination: "MCO", depart_date: "2026-12-01", adults: 2, children: 1, infants_on_lap: 1 }, { today: "2026-10-24" }).params;
  const limits = fs.limitsFor({ params, found: 0, options: [] });
  assert.ok(limits.some(l => /does NOT mean there are no flights/.test(l)));
});

test("a sweep compares each pick only with dates inside the same sweep", () => {
  const view = fs.sweepView(fixture("date-sweep.json"), { show: 3 });
  assert.equal(view.picks[0].depart, "2026-12-04");
  assert.equal(view.picks[0].price, "$223");
  assert.match(view.picks[0].vs_nearby, /^\$\d+ less than the median of the 6 dates within 3 days$/);
  assert.equal(view.sweep_low, "$223");
  const fridays = fs.sweepView(fixture("date-sweep.json"), { weekdays: ["FRI"], show: 2 });
  assert.ok(fridays.picks.every(p => p.depart_day === "FRI"));
  assert.equal(fridays.matching_weekdays, 4, "Dec 4, 11, 18 and 25");
});

test("couldn't check is never 'no flights'", () => {
  for (const kind of ["blocked", "network", "timeout", "parse", "down", "internal"]) {
    const out = fs.couldntCheck(new FliError(kind, "x"));
    assert.equal(out.ok, false);
    assert.equal(out.couldnt_check, true);
    assert.match(out.say, /^I couldn't check flights right now/);
    assert.match(out.say, /NOT "no flights"/);
  }
});

// ---------- the tools, end to end with a fake sidecar ----------

test("flight_search → list; a refinement keeps every earlier constraint and changes only what was said", async () => {
  const sidecar = fakeSidecar({ searchFlights: fixture("round-trip.json") });
  const first = await runTool("flight_search", {
    origin: "JFK", destination: "LAX", depart_date: day(30), return_date: day(35), exclude_airlines: ["NK"], adults: 2,
  }, { conversationId: ALICE, fli: sidecar });
  assert.equal(first.ok, true);
  assert.equal(first.headline, "round trip from $613");
  assert.ok(first.options.every(o => o.link.startsWith("https://www.google.com/travel/flights?q=")));
  const second = await runTool("flight_search", { refine_of: first.search_id, max_stops: "NON_STOP", return_date: day(34) }, { conversationId: ALICE, fli: sidecar });
  assert.equal(second.ok, true);
  const sent = sidecar.calls[1].params;
  assert.equal(sent.max_stops, "NON_STOP");
  assert.equal(sent.return_date, day(34), "'make it four days' moved the return");
  assert.deepEqual(sent.exclude_airlines, ["NK"], "the airline they ruled out before is still out");
  assert.equal(sent.adults, 2);
  assert.ok(second.applied.includes("nonstop only"));
  const third = await runTool("flight_search", { refine_of: second.search_id, clear: ["exclude_airlines"] }, { conversationId: ALICE, fli: sidecar });
  assert.equal(third.ok, true);
  assert.equal(sidecar.calls[2].params.exclude_airlines, null);
  assert.equal(sidecar.calls[2].params.max_stops, "NON_STOP");
});

test("blocked comes back as couldn't check, is recorded, and never reads as an empty result", async () => {
  const sidecar = fakeSidecar({ searchFlights: new FliError("blocked", "Google returned an RPC error [13] with no data") });
  const out = await runTool("flight_search", { origin: "JFK", destination: "LAX", depart_date: day(30) }, { conversationId: ALICE, fli: sidecar });
  assert.equal(out.couldnt_check, true);
  assert.equal(out.kind, "blocked");
  assert.equal(out.options, undefined);
  assert.equal(db.lastFlightSearch(ALICE).outcome, "blocked");
  assert.ok(out.link.startsWith("https://www.google.com/travel/flights?q="), "a refused search still hands over their route on Google Flights");
  assert.ok(decodeURIComponent(out.link).includes(`Flights from JFK to LAX on ${day(30)}`));
  assert.match(out.say, /send them `link`/);
  const refusedSweep = fakeSidecar({ searchDates: new FliError("blocked", "Google returned an RPC error [13] with no data") });
  const sweep = await runTool("flight_dates", { origin: "JFK", destination: "MIA", from_date: day(20), to_date: day(40) }, { conversationId: ALICE, fli: refusedSweep });
  assert.equal(sweep.couldnt_check, true);
  assert.ok(decodeURIComponent(sweep.link).includes("Flights from JFK to MIA"));
});

test("flight_dates: one sweep per message; a second is refused with 'ask first'", async () => {
  const sidecar = fakeSidecar({ searchDates: fixture("date-sweep.json") });
  const input = { origin: "JFK", destination: "MIA", from_date: day(20), to_date: day(49), trip_days: 5 };
  const one = await runTool("flight_dates", input, { conversationId: ALICE, fli: sidecar });
  assert.equal(one.ok, true);
  assert.equal(one.picks[0].price, "$223");
  const two = await runTool("flight_dates", { ...input, to_date: day(80) }, { conversationId: ALICE, fli: sidecar });
  assert.equal(two.ok, false);
  assert.match(two.error, /ask them first|ask first/);
  assert.equal(sidecar.calls.length, 1, "the second sweep never reached the sidecar");
  offers.beginTurn(ALICE, "ok try april too", "user");
  assert.equal((await runTool("flight_dates", input, { conversationId: ALICE, fli: sidecar })).ok, true, "their next message may sweep again");
});

test("the reply guard reads a flight search or sweep as the comparison: no 'didn't compare sellers' line under it", async () => {
  // Live intent lane 2026-10-24: "early december's the cheapest" came back with "(that's not a
  // checked best price — i didn't compare sellers this time.)" glued under it.
  offers.beginTurn(BOB, "when's the cheapest time to fly jfk to miami in december", "user");
  const before = offers.guardReply(BOB, "early december's the cheapest, $223 round trip.");
  assert.ok(before.flags.some(f => f.rule === "best_unsupported"), "with no search, the shopping rule still fires");
  const sweep = await runTool("flight_dates", { origin: "JFK", destination: "MIA", from_date: day(20), to_date: day(49), trip_days: 5 }, { conversationId: BOB, fli: fakeSidecar({ searchDates: fixture("date-sweep.json") }) });
  assert.equal(sweep.ok, true);
  const after = offers.guardReply(BOB, "early december's the cheapest, $223 round trip.");
  assert.ok(!after.flags.some(f => f.rule === "best_unsupported"), JSON.stringify(after.flags));
  assert.doesNotMatch(after.text, /compare sellers/);

  offers.beginTurn(BOB, "flights jfk to lax?", "user");
  const s = await runTool("flight_search", { origin: "JFK", destination: "LAX", depart_date: day(30) }, { conversationId: BOB, fli: fakeSidecar({ searchFlights: fixture("one-way.json") }) });
  assert.equal(s.ok, true);
  assert.doesNotMatch(offers.guardReply(BOB, `the cheapest nonstop is ${s.options[0].price}.`).text, /compare sellers/);
});

test("flight_verify: a moved price is said as moved; a vanished flight is said gone", async () => {
  let price = 613;
  const sidecar = fakeSidecar({ searchFlights: () => { const r = fixture("round-trip.json"); for (const it of r.itineraries) if (it.legs[0].flight_number === "523") it.price = price; return r; } });
  const s = await runTool("flight_search", { origin: "JFK", destination: "LAX", depart_date: day(30), return_date: day(35) }, { conversationId: ALICE, fli: sidecar });
  price = 658;
  const v = await runTool("flight_verify", { search_id: s.search_id, option: 1 }, { conversationId: ALICE, fli: sidecar });
  assert.equal(v.still_there, true);
  assert.equal(v.moved, true);
  assert.equal(v.price_then, "$613");
  assert.equal(v.price_now, "$658");
  assert.equal(v.change, "up $45");
  const gone = fakeSidecar({ searchFlights: () => { const r = fixture("round-trip.json"); r.itineraries = r.itineraries.filter(it => it.legs[0].flight_number !== "523"); r.count = r.itineraries.length; return r; } });
  const g = await runTool("flight_verify", { search_id: s.search_id, option: 1 }, { conversationId: ALICE, fli: gone });
  assert.equal(g.still_there, false);
  assert.match(g.note, /don't send the old price as current/);
  const down = fakeSidecar({ searchFlights: new FliError("down", "sidecar stopped") });
  const d = await runTool("flight_verify", { search_id: s.search_id, option: 1 }, { conversationId: ALICE, fli: down });
  assert.equal(d.couldnt_check, true);
  assert.equal(d.stale, true);
});

test("isolation: Bob can't refine, verify or read Alice's search", async () => {
  const sidecar = fakeSidecar({ searchFlights: fixture("one-way.json") });
  const s = await runTool("flight_search", { origin: "JFK", destination: "LHR", depart_date: day(30) }, { conversationId: ALICE, fli: sidecar });
  const refine = await runTool("flight_search", { refine_of: s.search_id, max_stops: "NON_STOP" }, { conversationId: BOB, fli: sidecar });
  assert.equal(refine.ok, false);
  assert.match(refine.error, /no flight search/);
  const verify = await runTool("flight_verify", { search_id: s.search_id, option: 1 }, { conversationId: BOB, fli: sidecar });
  assert.equal(verify.ok, false);
  assert.equal(db.getFlightSearch(BOB, s.search_id), null);
  assert.equal(db.lastFlightSearch(BOB), null);
  assert.equal(sidecar.calls.length, 1, "nothing of Bob's reached the sidecar");
});

test("the search tools can't book: no booking, purchase or payment tool appears in what they hand back", async () => {
  const sidecar = fakeSidecar({ searchFlights: fixture("one-way.json") });
  const s = await runTool("flight_search", { origin: "JFK", destination: "LHR", depart_date: day(30) }, { conversationId: ALICE, fli: sidecar });
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /agentcard|purchase_|confirm_request/i);
  assert.match(s.note, /Reason never books/);
});

// ---------- the sidecar's life ----------

function fakeSpawn() {
  const children = [];
  const impl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.written = [];
    child.stdin = {
      write: (line) => { child.written.push(JSON.parse(line)); },
      end: () => { child.ended = true; setImmediate(() => child.emit("exit", 0, null)); },
    };
    child.kill = () => child.emit("exit", null, "SIGKILL");
    child.answer = (id, body) => child.stdout.emit("data", JSON.stringify({ id, ...body }) + "\n");
    children.push(child);
    return child;
  };
  return { impl, children };
}
const tick = () => new Promise(r => setImmediate(r));

function makeSidecar(extra = {}) {
  const sp = fakeSpawn();
  const outcomes = [];
  const s = new FliSidecar({ spawnImpl: sp.impl, onOutcome: (o) => outcomes.push(o), log: () => {}, idleMs: 20, timeoutMs: 200, ...extra });
  s.installed = () => true;
  return { s, sp, outcomes };
}

test("sidecar: starts on the first request, routes answers by id, records the outcome", async () => {
  const { s, sp, outcomes } = makeSidecar();
  assert.equal(sp.children.length, 0, "nothing runs until somebody asks");
  const p = s.searchFlights({ origin: "JFK" });
  await tick();
  assert.equal(sp.children.length, 1);
  const req = sp.children[0].written[0];
  assert.equal(req.op, "search_flights");
  assert.equal(req.params.currency, "USD");
  sp.children[0].answer(req.id, { ok: true, result: { count: 3, itineraries: [] } });
  assert.equal((await p).count, 3);
  assert.equal(outcomes.at(-1).state, "ok");
  assert.equal(s.lastOutcome().state, "ok");
});

test("sidecar: a crash fails what was in flight as 'down' (never empty) and the next request restarts it", async () => {
  const { s, sp, outcomes } = makeSidecar();
  const p = s.searchFlights({});
  await tick();
  sp.children[0].emit("exit", 1, null);
  await assert.rejects(p, (e) => e instanceof FliError && e.kind === "down");
  assert.equal(outcomes.at(-1).state, "down");
  const q = s.searchDates({});
  await tick();
  assert.equal(sp.children.length, 2, "restarted on demand");
  sp.children[1].answer(sp.children[1].written[0].id, { ok: true, result: { count: 0, dates: [] } });
  assert.equal((await q).count, 0);
  assert.equal(outcomes.at(-1).state, "empty", "a real empty answer is recorded as empty, not as a failure");
});

test("sidecar: three crashes in five minutes and it is called down instead of restarted forever", async () => {
  const { s, sp } = makeSidecar();
  for (let i = 0; i < 3; i++) {
    const p = s.searchFlights({});
    await tick();
    sp.children.at(-1).emit("exit", 1, null);
    await assert.rejects(p);
  }
  await assert.rejects(s.searchFlights({}), (e) => e.kind === "down" && /crashed 3 times/.test(e.message));
  assert.equal(sp.children.length, 3);
});

test("sidecar: stops itself when idle, and that stop is not counted as a crash", async () => {
  const { s, sp } = makeSidecar({ idleMs: 5 });
  const p = s.searchFlights({});
  await tick();
  sp.children[0].answer(sp.children[0].written[0].id, { ok: true, result: { count: 1, itineraries: [] } });
  await p;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sp.children[0].ended, true, "stdin closed after the idle window");
  assert.equal(s.child, null);
  assert.equal(s.crashes.length, 0);
});

test("sidecar: a search that arrives while it winds down starts a fresh child, never writes into the closing one", async () => {
  const { s, sp } = makeSidecar({ idleMs: 60_000 });
  const p = s.searchFlights({});
  await tick();
  sp.children[0].answer(sp.children[0].written[0].id, { ok: true, result: { count: 1, itineraries: [] } });
  await p;
  // The real child takes a moment to exit after stdin closes; a write in that window used to throw.
  sp.children[0].stdin.end = () => { sp.children[0].ended = true; sp.children[0].stdin.write = () => { throw new Error("write after end"); }; };
  s.stop();
  const q = s.searchFlights({});
  await tick();
  assert.equal(sp.children.length, 2, "a fresh child for the new search");
  sp.children[1].answer(sp.children[1].written[0].id, { ok: true, result: { count: 2, itineraries: [] } });
  assert.equal((await q).count, 2);
  sp.children[0].emit("exit", 0, null);
  assert.equal(s.crashes.length, 0, "the old child's exit is neither a crash nor the new child's death");
  assert.ok(s.child, "the new child is still the live one");
});

test("sidecar: a search Google partly refused returns what it got, and backs off the next one", async () => {
  let now = 1_000_000;
  const { s, sp } = makeSidecar({ now: () => now, cooldownMs: 60_000 });
  const p = s.searchFlights({});
  await tick();
  sp.children[0].answer(sp.children[0].written[0].id, { ok: true, result: { count: 4, fetches: 6, refused_fetches: 2, itineraries: [] } });
  assert.equal((await p).count, 4);
  await assert.rejects(s.searchFlights({}), (e) => e.kind === "blocked");
  now += 61_000;
  const q = s.searchFlights({});
  await tick();
  sp.children[0].answer(sp.children[0].written.at(-1).id, { ok: true, result: { count: 1, itineraries: [] } });
  assert.equal((await q).count, 1, "asks again once the back-off is over");
});

test("sidecar: refused by Google → backs off; nothing else is sent until the cooldown ends", async () => {
  let now = 1_000_000;
  const { s, sp } = makeSidecar({ now: () => now, cooldownMs: 60_000 });
  const p = s.searchFlights({});
  await tick();
  sp.children[0].answer(sp.children[0].written[0].id, { ok: false, error: { kind: "blocked", type: "Blocked", message: "Google returned an RPC error [13] with no data" } });
  await assert.rejects(p, (e) => e.kind === "blocked");
  await assert.rejects(s.searchFlights({}), (e) => e.kind === "blocked" && e.retryAt === 1_060_000);
  assert.equal(sp.children[0].written.length, 1, "the second search never left Reason");
  now += 60_001;
  const q = s.searchFlights({});
  await tick();
  assert.equal(sp.children[0].written.length, 2, "after the cooldown it may ask once more");
  sp.children[0].answer(sp.children[0].written[1].id, { ok: true, result: { count: 2, itineraries: [] } });
  await q;
});

test("sidecar: a hung search times out as 'timeout'; a missing install is 'down'", async () => {
  const { s } = makeSidecar({ timeoutMs: 10 });
  await assert.rejects(s.searchFlights({}), (e) => e.kind === "timeout");
  const missing = new FliSidecar({ python: "/nonexistent/python", onOutcome: null, log: () => {} });
  await assert.rejects(missing.searchFlights({}), (e) => e.kind === "down" && /isn't installed/.test(e.message));
});

// ---------- the recorded refusal, read by the real classifier ----------

const PY = spawnSync("python3", ["--version"]).status === 0;
test("the recorded [13] refusal is classified as refused; a body with data is not", { skip: !PY && "python3 not on this machine" }, () => {
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(HERE, "..", "scripts"))})
from fli_wire import inspect_body
refused = open(${JSON.stringify(join(FIX, "refused-rpc13.txt"))}).read()
ok = ")]}'\\n\\n" + json.dumps([["wrb.fr", None, json.dumps([[None]]), None, None, None]])
print(json.dumps([inspect_body(refused), inspect_body(ok), inspect_body("", "https://consent.google.com/ml?continue=x"), inspect_body("<html><body>sorry</body></html>")]))
`;
  const r = spawnSync("python3", ["-I", "-B", "-c", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [refused, ok, consent, html] = JSON.parse(r.stdout);
  assert.deepEqual(refused, { refused: true, why: "Google returned an RPC error [13] with no data" });
  assert.deepEqual(ok, { refused: false });
  assert.equal(consent.refused, true);
  assert.equal(html.refused, true);
});

// ---------- /ops ----------

test("/ops: off when not installed; healthy, blocked or down from the LAST REAL search; never a probe", () => {
  const installed = { installed: () => true };
  assert.equal(ops.flightSearchCheck({ sidecar: { installed: () => false } }).state, "off");
  assert.match(ops.flightSearchCheck({ sidecar: installed }).detail, /no searches yet/);
  const now = clock.now();
  db.recordProviderCall({ provider: LEDGER_ID, day: accounts.today(now), ok: true, ms: 900, at: now - 60_000 });
  const ok = ops.flightSearchCheck({ now, sidecar: installed });
  assert.equal(ok.state, "ok");
  assert.match(ok.detail, /^healthy · last search/);
  db.recordProviderCall({ provider: LEDGER_ID, day: accounts.today(now), ok: false, error: "blocked: Google returned an RPC error [13] with no data", at: now - 30_000 });
  const blocked = ops.flightSearchCheck({ now, sidecar: installed });
  assert.equal(blocked.state, "bad");
  assert.match(blocked.detail, /blocked by Google .* no workaround/);
  assert.match(blocked.detail, / searches today, 1 failed$/);
  assert.equal(blocked.quiet, true, "a Google refusal is shown, never texted");
  db.recordProviderCall({ provider: LEDGER_ID, day: accounts.today(now), ok: false, error: "down: sidecar crashed", at: now - 10_000 });
  const down = ops.flightSearchCheck({ now, sidecar: installed });
  assert.match(down.detail, /^sidecar down/);
  assert.equal(down.quiet, undefined, "a sidecar that won't run is the owner's to fix");
  db.recordProviderCall({ provider: LEDGER_ID, day: accounts.today(now), ok: false, error: "timeout: took too long", at: now - 5_000 });
  const slow = ops.flightSearchCheck({ now, sidecar: installed });
  assert.equal(slow.state, "warn");
  assert.equal(slow.quiet, true);
  db.recordProviderCall({ provider: LEDGER_ID, day: accounts.today(now), ok: false, error: "parse: unexpected shape", at: now - 1_000 });
  assert.equal(ops.flightSearchCheck({ now, sidecar: installed }).quiet, undefined, "Fli no longer reading Google is texted");
});

test("/ops: a Google refusal that stays the last search never texts the owner; a dead sidecar does", () => {
  const said = [];
  const runtime = { say: (c, text) => said.push(text) };
  const t0 = clock.now();
  const blocked = { id: "flights", group: "services", label: "Flight search · Fli", state: "bad", detail: "blocked by Google", quiet: true };
  ops.settle({ report: { at: t0, checks: [blocked] }, runtime });
  ops.settle({ report: { at: t0 + ops.ALERT_AFTER_MS + 60_000, checks: [blocked] }, runtime });
  assert.deepEqual(said, []);
  const down = { id: "flights", group: "services", label: "Flight search · Fli", state: "bad", detail: "sidecar down" };
  ops.settle({ report: { at: t0 + ops.ALERT_AFTER_MS + 120_000, checks: [down] }, runtime });
  ops.settle({ report: { at: t0 + 3 * ops.ALERT_AFTER_MS, checks: [down] }, runtime });
  assert.equal(said.length, 1);
  assert.match(said[0], /Flight search/);
});
