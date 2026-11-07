// Flight prices from SerpApi (Google Flights engine), then Duffel, then one honest line
// (src/flightproviders.js, src/flightsearch.js), 2026-11-06. Pinned, one per rule:
//
//   - with no key nothing is sent anywhere, and the answer is "flight prices aren't available right
//     now" with a Google Flights link on their route and dates — once, with no retry promised;
//   - a wake that isn't their message (a task, a watch) says NOTHING more after they were told;
//   - SerpApi gets the documented parameters, and its answer reads as the same short list Fli gave;
//   - every SerpApi search is counted before it is sent, and at the monthly limit (240) it is
//     skipped — Duffel takes over, or the honest line;
//   - Duffel gets the documented offer request (search only), and its offers read the same way;
//   - a re-check before booking is never SerpApi's one-hour cache;
//   - /ops says which sources have a key and how much of the month is used, and never probes.
//
// No network: every response is a recorded fixture (test/fixtures/flights/) handed back by a fake
// fetch, which also records exactly what would have been sent.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "reason-flightproviders-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "45".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const offers = await import("../src/offers.js");
const accounts = await import("../src/accounts.js");
const fs = await import("../src/flightsearch.js");
const fp = await import("../src/flightproviders.js");
const ops = await import("../src/ops.js");
const { Runtime } = await import("../src/runtime.js");
const { clock } = await import("../src/config.js");

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "flights");
const fixture = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const C = "dm:alice";

after(() => rmSync(dir, { recursive: true, force: true }));

const day = (n) => new Date(Date.parse(`${accounts.today()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A fetch that answers from fixtures by host and records every request. */
function fakeFetch(answers = {}) {
  const sent = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    sent.push({ host: u.host, url: u, init, body: init.body ? JSON.parse(init.body) : null });
    const a = answers[u.host];
    const v = typeof a === "function" ? a(u, init, sent.length) : a;
    if (v instanceof Error) throw v;
    if (!v) throw new Error(`unexpected request to ${u.host}`);
    return { ok: (v.status ?? 200) < 400, status: v.status ?? 200, json: async () => structuredClone(v.body) };
  };
  return { impl, sent };
}
const SERP = "serpapi.com";
const DUFFEL = "api.duffel.com";

function source(answers) {
  const f = fakeFetch(answers);
  return { f, src: new fp.FlightProviders({ fetchImpl: f.impl, now: () => clock.now(), record: null, log: () => {} }) };
}

beforeEach(() => {
  clock.reset?.();
  delete process.env.SERPAPI_API_KEY;
  delete process.env.DUFFEL_ACCESS_TOKEN;
  delete process.env.SERPAPI_MONTHLY_LIMIT;
  delete process.env.DUFFEL_MONTHLY_LIMIT;
  db.db.exec("DELETE FROM flight_searches; DELETE FROM flight_provider_usage; DELETE FROM provider_state; DELETE FROM provider_calls;");
  db.upsertAccount({ conversationId: C, channel: "test", address: C, name: "Alice" });
  offers.beginTurn(C, "find me flights", "user");
});

const search = (input, src, kind = "user") => {
  offers.beginTurn(C, "flights", kind);
  return runTool("flight_search", input, { conversationId: C, fli: src });
};

// ---------- no key: dormant and honest ----------

test("no keys: nothing is sent anywhere; ONE honest answer with Google Flights on their route and dates", async () => {
  const { f, src } = source({});
  assert.equal(src.installed(), false);
  const out = await search({ origin: "BOS", destination: "ORD", depart_date: day(20), return_date: day(24) }, src);
  assert.equal(f.sent.length, 0, "no request leaves Reason without a key");
  assert.equal(out.ok, false);
  assert.equal(out.couldnt_check, true);
  assert.equal(out.kind, "unavailable");
  assert.match(out.say, /^Flight prices aren't available right now\. Tell them that ONCE, in one message/);
  assert.match(out.say, /don't say you're still trying/);
  assert.match(out.say, /don't start a task, watch or reminder/);
  assert.doesNotMatch(out.say.replace("don't offer to try again later", ""), /try again later|backing off/, "nothing promises a retry");
  assert.match(out.link, /^https:\/\/www\.google\.com\/travel\/flights\?q=Flights%20from%20BOS%20to%20ORD%20on%20/);
  assert.match(out.link, new RegExp(`${day(20)}%20through%20${day(24)}`));
  assert.equal(db.lastFlightSearch(C).outcome, "unavailable");
});

test("a date sweep has no source: unavailable with the link, and nothing sent even with keys", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const { f, src } = source({});
  offers.beginTurn(C, "cheapest time to fly", "user");
  const out = await runTool("flight_dates", { origin: "JFK", destination: "MIA", from_date: day(10), to_date: day(40), trip_days: 5 }, { conversationId: C, fli: src });
  assert.equal(out.kind, "unavailable");
  assert.match(out.link, /JFK%20to%20MIA/);
  assert.equal(f.sent.length, 0);
});

test("told once: a wake that isn't their message stays silent; their own next ask is answered again", async () => {
  const { src } = source({});
  const ask = { origin: "BOS", destination: "ORD", depart_date: day(20) };
  const first = await search(ask, src, "user");
  assert.equal(first.already_told, undefined);
  clock.skip(90 * 60_000);
  const wake = await search(ask, src, "event");
  assert.equal(wake.already_told, true);
  assert.match(wake.say, /send them NOTHING about flights — reply NO_REPLY/);
  assert.match(wake.say, /finish the task/);
  const theirs = await search(ask, src, "user");
  assert.equal(theirs.already_told, undefined, "a person asking again gets an answer");
  clock.skip(fs.ALREADY_TOLD_MS + 60_000);
  const nextDay = await search(ask, src, "event");
  assert.equal(nextDay.already_told, undefined, "a day later it's a new telling");
});

test("end to end through the runtime: one ask, six background wakes over nine hours → exactly ONE message", async () => {
  // The incident (week of 2026-11-02): a task re-ran a refused flight search through the night and
  // texted "still trying" six times. The turn here is a script standing in for the model, doing what
  // the tool result tells it: speak when told to, NO_REPLY when told not to.
  const { src } = source({});
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => {
      offers.beginTurn(conversationId, text, kind);
      const out = await runTool("flight_search", { origin: "BOS", destination: "ORD", depart_date: day(20) }, { conversationId, fli: src });
      if (out.already_told) return null;
      return `flight prices aren't available right now — here's google flights for your dates: ${out.link}`;
    },
  });
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  await rt.inbound(C, "flights bos to chicago dec 3?");
  for (let i = 0; i < 6; i++) {
    clock.skip(90 * 60_000);
    await rt.event(C, "[task wake] find flights BOS → ORD");
  }
  await rt.idle();
  assert.equal(sent.length, 1, `expected one message, got ${sent.length}: ${JSON.stringify(sent.map(m => m.text))}`);
  assert.match(sent[0].text, /aren't available right now/);
  assert.match(sent[0].text, /google\.com\/travel\/flights/);
});

// ---------- SerpApi ----------

test("SerpApi: the documented Google Flights parameters, from the model's plain fields", () => {
  const { params } = fs.toSidecarFlights({
    origin: "JFK,EWR,LGA", destination: "LHR", depart_date: day(30), return_date: day(35), max_stops: "ONE_STOP_OR_FEWER",
    depart_after_hour: 17, cabin: "BUSINESS", airlines: ["ba"], exclude_airlines: ["nk"], min_layover_minutes: 60, adults: 2, infants_on_lap: 1, sort_by: "DURATION",
  }, { today: day(0) });
  const q = fp.serpapiQuery(params, { key: "k" });
  assert.equal(q.engine, "google_flights");
  assert.equal(q.departure_id, "JFK,EWR,LGA", "SerpApi takes the whole metro list");
  assert.equal(q.arrival_id, "LHR");
  assert.equal(q.type, 1);
  assert.equal(q.return_date, day(35));
  assert.equal(q.travel_class, 3);
  assert.equal(q.stops, 2);
  assert.equal(q.sort_by, 5);
  assert.equal(q.outbound_times, "17,23");
  assert.equal(q.include_airlines, "BA");
  assert.equal(q.exclude_airlines, undefined, "include and exclude can't go together; include wins");
  assert.equal(q.layover_duration, "60,1440");
  assert.equal(q.adults, 2);
  assert.equal(q.infants_on_lap, 1);
  assert.equal(q.currency, "USD");
  assert.equal(q.no_cache, undefined);
  const oneWay = fp.serpapiQuery(fs.toSidecarFlights({ origin: "BOS", destination: "ORD", depart_date: day(3) }, { today: day(0) }).params, { key: "k", fresh: true });
  assert.equal(oneWay.type, 2);
  assert.equal(oneWay.return_date, undefined);
  assert.equal(oneWay.sort_by, 2, "cheapest first by default");
  assert.equal(oneWay.no_cache, true);
});

test("SerpApi one way → the same short list: prices, airlines, times, stops, layovers, the Google Flights page", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const body = fixture("serpapi-one-way.json");
  const { f, src } = source({ [SERP]: { body } });
  const out = await search({ origin: "BOS", destination: "ORD", depart_date: "2026-12-03" }, src);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url.pathname, "/search.json");
  assert.equal(f.sent[0].url.searchParams.get("api_key"), "serp-test");
  assert.equal(out.found, 4);
  assert.equal(out.headline, "from $61");
  assert.deepEqual(out.options.map(o => o.price), ["$61", "$129", "$144", "$158"]);
  const delta = out.options[3];
  assert.equal(delta.airline, "Delta");
  assert.equal(delta.flights, "DL5735 BOS→LGA, DL2210 LGA→ORD");
  assert.equal(delta.stops, 1);
  assert.deepEqual(delta.layovers, ["LGA 1h 25m"]);
  assert.equal(delta.depart, "Thu, Dec 3, 7:15am");
  assert.equal(delta.arrive, "Thu, Dec 3, 11:40am");
  assert.equal(delta.duration, "5h 25m");
  assert.equal(delta.link, body.search_metadata.google_flights_url);
  assert.equal(delta.key, "DL5735@2026-12-03+DL2210@2026-12-03");
  assert.ok(out.limits.some(l => /what Google's page showed/.test(l)));
  assert.equal(db.flightProviderSearches("serpapi", fp.monthOf(clock.now())), 1, "counted");
});

test("SerpApi round trip: the whole-trip price on each way out, said as such; the link carries both dates", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const { f, src } = source({ [SERP]: { body: fixture("serpapi-round-trip.json") } });
  const out = await search({ origin: "JFK", destination: "MIA", depart_date: "2026-12-10", return_date: "2026-12-15" }, src);
  assert.equal(out.ok, true);
  assert.equal(f.sent.length, 1, "returns are not fetched one search each");
  assert.equal(out.headline, "round trip from $241");
  assert.ok(out.limits.some(l => /price is the WHOLE trip, but only the way out is listed/.test(l)));
  assert.equal(out.options[0].return, undefined);
});

test("SerpApi with no results is an empty search, not a failure", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const { src } = source({ [SERP]: { body: fixture("serpapi-no-results.json") } });
  const out = await search({ origin: "BOS", destination: "ORD", depart_date: day(9) }, src);
  assert.equal(out.ok, true);
  assert.equal(out.found, 0);
  assert.match(out.note, /not proof no flight exists/);
});

test("verify re-runs the search with no_cache, so a quote is never SerpApi's hour-old copy", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const { f, src } = source({ [SERP]: { body: fixture("serpapi-one-way.json") } });
  const s = await search({ origin: "BOS", destination: "ORD", depart_date: "2026-12-03" }, src);
  const v = await runTool("flight_verify", { search_id: s.search_id, option: 1 }, { conversationId: C, fli: src });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.still_there, true);
  assert.equal(v.price_now, "$61");
  assert.equal(f.sent[0].url.searchParams.get("no_cache"), null);
  assert.equal(f.sent[1].url.searchParams.get("no_cache"), "true");
});

// ---------- the monthly cap ----------

test("the cap: SerpApi is counted before each search and skipped at 240 — never the 251st", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const month = fp.monthOf(clock.now());
  db.db.prepare("INSERT INTO flight_provider_usage (provider, month, searches) VALUES ('serpapi', ?, 239)").run(month);
  const { f, src } = source({ [SERP]: { body: fixture("serpapi-one-way.json") } });
  const ok = await search({ origin: "BOS", destination: "ORD", depart_date: "2026-12-03" }, src);
  assert.equal(ok.ok, true, "the 240th still goes");
  assert.equal(db.flightProviderSearches("serpapi", month), 240);
  const capped = await search({ origin: "BOS", destination: "ORD", depart_date: "2026-12-03" }, src);
  assert.equal(capped.kind, "unavailable", "the 241st is not sent");
  assert.equal(f.sent.length, 1);
  assert.equal(db.flightProviderSearches("serpapi", month), 240, "a skipped search isn't counted");
});

test("the cap: an error still counts (it may have been billed); a limit of 0 sends nothing; a new month starts over", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const { f, src } = source({ [SERP]: { status: 500, body: { error: "Something went wrong" } } });
  const month = fp.monthOf(clock.now());
  await search({ origin: "BOS", destination: "ORD", depart_date: day(5) }, src);
  assert.equal(db.flightProviderSearches("serpapi", month), 1);
  process.env.SERPAPI_MONTHLY_LIMIT = "0";
  await search({ origin: "BOS", destination: "ORD", depart_date: day(5) }, src);
  assert.equal(f.sent.length, 1, "limit 0 is off");
  delete process.env.SERPAPI_MONTHLY_LIMIT;
  db.db.prepare("UPDATE flight_provider_usage SET searches = 240").run();
  assert.equal(db.reserveFlightProviderSearch("serpapi", month, 240), false);
  assert.equal(db.reserveFlightProviderSearch("serpapi", "2099-01", 240), true, "next month has its own allowance");
});

test("past the cap Duffel answers instead, once", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  process.env.DUFFEL_ACCESS_TOKEN = "duffel_test_x";
  process.env.SERPAPI_MONTHLY_LIMIT = "1";
  const { f, src } = source({ [SERP]: { body: fixture("serpapi-one-way.json") }, [DUFFEL]: { status: 201, body: fixture("duffel-round-trip.json") } });
  await search({ origin: "JFK", destination: "MIA", depart_date: "2026-12-10", return_date: "2026-12-15" }, src);
  const out = await search({ origin: "JFK", destination: "MIA", depart_date: "2026-12-10", return_date: "2026-12-15" }, src);
  assert.deepEqual(f.sent.map(s => s.host), [SERP, DUFFEL]);
  assert.equal(out.ok, true);
  assert.equal(out.headline, "round trip from $199");
});

// ---------- Duffel ----------

test("Duffel: the documented offer request, search only, one airport a side", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = "duffel_test_x";
  const { f, src } = source({ [DUFFEL]: { status: 201, body: fixture("duffel-round-trip.json") } });
  const out = await search({ origin: "JFK,EWR", destination: "MIA", depart_date: "2026-12-10", return_date: "2026-12-15", depart_after_hour: 6, depart_before_hour: 12, max_stops: "ONE_STOP_OR_FEWER", adults: 2, children: 1, infants_on_lap: 1, cabin: "PREMIUM_ECONOMY" }, src);
  assert.equal(f.sent.length, 1);
  const req = f.sent[0];
  assert.equal(req.url.pathname, "/air/offer_requests");
  assert.equal(req.url.searchParams.get("return_offers"), "true");
  assert.equal(req.url.searchParams.get("supplier_timeout"), "20000");
  assert.equal(req.init.method, "POST");
  assert.equal(req.init.headers["Duffel-Version"], "v2");
  assert.equal(req.init.headers.Authorization, "Bearer duffel_test_x");
  assert.deepEqual(req.body.data.slices, [
    { origin: "JFK", destination: "MIA", departure_date: "2026-12-10", departure_time: { from: "06:00", to: "12:59" } },
    { origin: "MIA", destination: "JFK", departure_date: "2026-12-15" },
  ]);
  assert.deepEqual(req.body.data.passengers, [{ type: "adult" }, { type: "adult" }, { type: "child" }, { type: "infant_without_seat" }]);
  assert.equal(req.body.data.cabin_class, "premium_economy");
  assert.equal(req.body.data.max_connections, 1);
  assert.ok(out.limits.some(l => /Only JFK → MIA was searched/.test(l)), "the airports it skipped are said");
  assert.ok(out.limits.some(l => /Duffel/.test(l)));
});

test("Duffel offers → the same short list, with the return, layovers worked out, and filters it doesn't take applied here", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = "duffel_test_x";
  const { src } = source({ [DUFFEL]: { status: 201, body: fixture("duffel-round-trip.json") } });
  const out = await search({ origin: "JFK", destination: "MIA", depart_date: "2026-12-10", return_date: "2026-12-15", exclude_airlines: ["NK"] }, src);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.found, 2, "Spirit dropped");
  assert.deepEqual(out.options.map(o => o.price), ["$231", "$286"]);
  const delta = out.options[0];
  assert.equal(delta.airline, "Delta Air Lines");
  assert.equal(delta.flights, "DL1180 JFK→ATL, DL2311 ATL→MIA");
  assert.deepEqual(delta.layovers, ["ATL 2h 10m"]);
  assert.equal(delta.duration, "6h 40m");
  assert.equal(delta.return.flights, "DL1534 MIA→JFK");
  assert.equal(delta.return.depart, "Tue, Dec 15, 9:15am");
  assert.match(delta.link, /JFK%20to%20MIA%20on%202026-12-10%20through%202026-12-15/);
  assert.equal(delta.key, "DL1180@2026-12-10+DL2311@2026-12-10|DL1534@2026-12-15");
});

test("SerpApi refusing (bad key) falls to Duffel; both failing is the one honest answer", async () => {
  process.env.SERPAPI_API_KEY = "serp-bad";
  process.env.DUFFEL_ACCESS_TOKEN = "duffel_test_x";
  const { f, src } = source({ [SERP]: { status: 401, body: { error: "Invalid API key." } }, [DUFFEL]: { status: 503, body: { errors: [{ message: "Service unavailable" }] } } });
  const out = await search({ origin: "JFK", destination: "MIA", depart_date: day(12) }, src);
  assert.deepEqual(f.sent.map(s => s.host), [SERP, DUFFEL], "each tried exactly once — no retry loop");
  assert.equal(out.kind, "unavailable");
  assert.match(src.lastOutcome().detail, /Duffel 503/);
  const network = source({ [SERP]: new TypeError("fetch failed") });
  process.env.DUFFEL_ACCESS_TOKEN = "";
  const out2 = await search({ origin: "JFK", destination: "MIA", depart_date: day(12) }, network.src);
  assert.equal(out2.kind, "unavailable");
});

test("isoMinutes reads Duffel's durations", () => {
  assert.equal(fp.isoMinutes("PT2H26M"), 146);
  assert.equal(fp.isoMinutes("P1DT2H"), 1560);
  assert.equal(fp.isoMinutes("PT45M"), 45);
  assert.equal(fp.isoMinutes("nope"), null);
});

// ---------- /ops ----------

test("/ops: off with no key; usage per source this month; a bad key is texted, a slow API is not", () => {
  const src = new fp.FlightProviders({ record: null });
  const off = ops.flightSearchCheck({ source: src });
  assert.equal(off.state, "off");
  assert.match(off.detail, /no SERPAPI_API_KEY or DUFFEL_ACCESS_TOKEN/);
  process.env.SERPAPI_API_KEY = "serp-test";
  const now = clock.now();
  const month = fp.monthOf(now);
  for (let i = 0; i < 12; i++) db.reserveFlightProviderSearch("serpapi", month, 240);
  const ok = ops.flightSearchCheck({ now, source: src });
  assert.equal(ok.state, "ok");
  assert.match(ok.detail, /^serpapi 12\/240 this month/);
  db.recordProviderCall({ provider: fp.LEDGER.serpapi, day: accounts.today(now), ok: false, error: "timeout: slow", at: now - 1000 });
  const slow = ops.flightSearchCheck({ now, source: src });
  assert.equal(slow.state, "warn");
  assert.equal(slow.quiet, true);
  db.recordProviderCall({ provider: fp.LEDGER.serpapi, day: accounts.today(now), ok: false, error: "auth: SerpApi 401: Invalid API key.", at: now - 500 });
  assert.equal(ops.flightSearchCheck({ now, source: src }).quiet, undefined, "a bad key is the owner's to fix");
  db.db.prepare("UPDATE flight_provider_usage SET searches = 240").run();
  assert.match(ops.flightSearchCheck({ now, source: src }).detail, /month's allowance used/);
});
