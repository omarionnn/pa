// nearby_places from three free sources at once (Overpass, Nominatim, Photon) inside one budget,
// and the weather's second source. The public Overpass servers stopped answering for days, and
// they were nearby_places' only source, so every "find X near me" failed.
//
// Every fetch here is a stub (global fetch included), so nothing reaches the internet.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-places-sources-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const places = await import("../src/places.js");
const weather = await import("../src/weather.js");
const retry = await import("../src/retry.js");
const tools = await import("../src/tools.js");
const { clock } = await import("../src/config.js");
const C = "dm:owner";
const P = { lat: 40.7433, lng: -74.0053 };

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; clock.reset(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { places.resetPlacesState(); weather.resetWeatherState(); });

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const hang = (opts) => new Promise((_, reject) => {
  opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" })));
});
const which = (url) => {
  const h = new URL(String(url)).host;
  if (h === "nominatim.openstreetmap.org") return "nominatim";
  if (h === "photon.komoot.io") return "photon";
  if (h === "api.met.no") return "metno";
  if (h === "api.open-meteo.com") return "openmeteo";
  return "overpass";
};
/** A stub network: per source a body, a function (url, opts) → body, "hang" or "refuse". */
function net(spec) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const src = which(url);
    calls.push({ src, url: String(url), opts, at: Date.now() });
    const s = spec[src] ?? "refuse";
    if (s === "hang") return hang(opts);
    if (s === "refuse") throw new Error("ECONNREFUSED");
    if (s === "fail") throw new TypeError("fetch failed");
    if (typeof s === "number") return reply({}, s);
    return reply(typeof s === "function" ? s(String(url), opts) : s);
  };
  return { fetchImpl, calls };
}

// Nearby points: metres north of P.
const north = (m) => P.lat + m / 111_320;
const nom = (name, m, { cat = "amenity", type = "pharmacy", id, hours, road = "9th Avenue", num = "154" } = {}) => ({
  osm_type: "node", osm_id: id ?? Math.floor(Math.random() * 1e9), lat: String(north(m)), lon: String(P.lng), name, category: cat, type,
  address: { house_number: num, road, city: "New York" }, extratags: hours ? { opening_hours: hours } : {},
});
const pho = (name, m, { key = "amenity", value = "pharmacy", id, street = "8th Avenue", num = "81" } = {}) => ({
  type: "Feature", geometry: { type: "Point", coordinates: [P.lng, north(m)] },
  properties: { osm_type: "N", osm_id: id ?? Math.floor(Math.random() * 1e9), osm_key: key, osm_value: value, name, street, housenumber: num, city: "New York" },
});
const ovp = (name, m, tags = {}) => ({ type: "node", id: Math.floor(Math.random() * 1e9), lat: north(m), lon: P.lng, tags: { name, amenity: "pharmacy", ...tags } });

test("a name search: Nominatim and Photon around the point, one entry per place, nearest first, Overpass not waited for past its slot", async () => {
  const n = net({
    overpass: "hang",
    nominatim: [nom("Party City", 1100, { cat: "shop", type: "party", id: 7, hours: "Mo-Su 10:00-20:00", road: "West 14th Street", num: "38" })],
    photon: { features: [
      pho("Party City", 1100, { key: "shop", value: "party", id: 7 }),
      pho("Party City", 3200, { key: "shop", value: "party", id: 8, street: "Atlantic Avenue", num: "100" }),
      pho("Padron Party & Craft", 900, { key: "shop", value: "craft" }),
      pho("Party City", 9000, { key: "shop", value: "party" }),
    ] },
  });
  const t0 = Date.now();
  const out = await places.nearbyPlaces(P.lat, P.lng, "shop", { name: "Party City", radius: 4000, fetchImpl: n.fetchImpl });
  const took = Date.now() - t0;
  assert.equal(out.ok, true);
  const near = (a, b) => Math.abs(a - b) <= 15;
  assert.equal(out.results.length, 2, "the same store once, the far one dropped, another name dropped");
  assert.ok(near(out.results[0].distance_m, 1100) && near(out.results[1].distance_m, 3200), out.results.map(r => r.distance_m).join(","));
  const [first, second] = out.results;
  assert.equal(first.name, "Party City");
  assert.equal(first.address, "38 West 14th Street");
  assert.equal(first.opening_hours, "Mo-Su 10:00-20:00", "hours from the source that has them");
  assert.equal(second.opening_hours, null, "never invented where the source has none");
  assert.ok(Number.isFinite(first.latitude) && Number.isFinite(first.longitude));
  assert.match(out.answered_by, /nominatim/);
  assert.match(out.answered_by, /photon/);
  assert.ok(took < places.OVERPASS_MS + 700, `took ${took} ms`);
  // Nominatim's search is bounded to a box around the point.
  const q = new URL(n.calls.find(c => c.src === "nominatim").url);
  assert.equal(q.searchParams.get("q"), "Party City");
  assert.equal(q.searchParams.get("bounded"), "1");
  const [w, nn, e, s] = q.searchParams.get("viewbox").split(",").map(Number);
  assert.ok(w < P.lng && e > P.lng && s < P.lat && nn > P.lat);
  // Photon: biased to the point, no tag filter on a name search.
  const ph = new URL(n.calls.find(c => c.src === "photon").url);
  assert.equal(ph.searchParams.get("lat"), P.lat.toFixed(5));
  assert.equal(ph.searchParams.get("osm_tag"), null);
});

test("a category search: Overpass answers, its places come back nearest first and inside the radius", async () => {
  const n = net({
    overpass: { elements: [ovp("Far Pharmacy", 1400), ovp("Near Pharmacy", 200, { opening_hours: "24/7", phone: "+12125550000" }), ovp("Outside", 2500)] },
    nominatim: [], photon: { features: [] },
  });
  const out = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { radius: 1500, fetchImpl: n.fetchImpl });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map(r => r.name), ["Near Pharmacy", "Far Pharmacy"]);
  assert.equal(out.results[0].opening_hours, "24/7");
  assert.equal(out.results[0].phone, "+12125550000");
  assert.equal(out.answered_by, "overpass");
  const ov = n.calls.filter(c => c.src === "overpass");
  assert.equal(new Set(ov.map(c => c.url)).size, 2, "two servers raced, not four in turn");
  const body = decodeURIComponent(ov[0].opts.body);
  assert.match(body, /\["amenity"="pharmacy"\]/);
  assert.match(body, /around:1500,40\.7433,-74\.0053/);
});

test("Overpass down: Photon and Nominatim still give real places, filtered to what was asked", async () => {
  const n = net({
    overpass: "refuse",
    nominatim: [nom("CVS Pharmacy", 433, { hours: "07:00-24:00" }), nom("Pharmacy Lane", 100, { cat: "highway", type: "residential" }), nom("Pharmacy", 50, { cat: "shop", type: "convenience" })],
    photon: { features: [pho("Duane Reade", 377), pho("CVS Pharmacy", 433)] },
  });
  const out = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { radius: 1500, fetchImpl: n.fetchImpl });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map(r => r.name), ["Duane Reade", "CVS Pharmacy"], "a street and a corner shop are not pharmacies; CVS once");
  assert.equal(out.results[1].opening_hours, "07:00-24:00");
  const ph = new URL(n.calls.find(c => c.src === "photon").url);
  assert.equal(ph.searchParams.get("osm_tag"), "amenity:pharmacy");
  assert.ok(ph.searchParams.get("bbox"));
  // The next search skips Overpass (its breaker) and still answers.
  n.calls.length = 0;
  const again = await places.nearbyPlaces(P.lat, P.lng, "cafe", { radius: 800, fetchImpl: n.fetchImpl });
  assert.equal(again.ok, true);
  assert.equal(n.calls.filter(c => c.src === "overpass").length, 0);
});

test("a cuisine: Overpass is asked for the cuisine tag; the text sources keep only food places that fit", async () => {
  const n = net({
    overpass: "refuse",
    nominatim: [nom("Kogame Ramen", 307, { type: "restaurant" }), nom("Ramen Street Parking", 100, { cat: "amenity", type: "parking" }), nom("Totto", 800, { type: "restaurant" })],
    photon: { features: [pho("Ramen Ishida", 434, { value: "restaurant" })] },
  });
  const out = await places.nearbyPlaces(P.lat, P.lng, "restaurant", { cuisine: "ramen", radius: 2000, fetchImpl: n.fetchImpl });
  assert.deepEqual(out.results.map(r => r.name), ["Kogame Ramen", "Ramen Ishida"]);
  assert.match(decodeURIComponent(n.calls.find(c => c.src === "overpass").opts.body), /\["cuisine"~"ramen",i\]/);
  assert.equal(new URL(n.calls.find(c => c.src === "nominatim").url).searchParams.get("q"), "ramen");
});

test("nothing there: ok with no places, not a failure", async () => {
  const n = net({ overpass: { elements: [] }, nominatim: [], photon: { features: [] } });
  const out = await places.nearbyPlaces(P.lat, P.lng, "shop", { name: "Zyxqwv Emporium", radius: 2000, fetchImpl: n.fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.count, 0);
  assert.deepEqual(out.results, []);
});

test("every source down: today's honest answer once, inside the budget, and the retry layer does not run it again", async () => {
  const n = net({ overpass: "hang", nominatim: "hang", photon: "hang" });
  globalThis.fetch = n.fetchImpl;
  const t0 = Date.now();
  const out = await tools.runTool("nearby_places", { latitude: P.lat, longitude: P.lng, type: "pharmacy" }, { conversationId: C, kind: "user", fetchImpl: n.fetchImpl });
  const took = Date.now() - t0;
  assert.equal(out.ok, false);
  assert.equal(out.down, true);
  assert.match(out.error, /couldn't load nearby places/i);
  assert.match(out.next, /web_search/);
  assert.equal(out.tries, 1, "one try: every source was already asked at once");
  assert.ok(took < places.BUDGET_MS + 500, `took ${took} ms`);
  assert.equal(new Set(n.calls.map(c => c.src)).size, 3);
});

test("on a call the whole search stays inside the call budget", async () => {
  const n = net({ overpass: "hang", nominatim: "hang", photon: "hang" });
  globalThis.fetch = n.fetchImpl;
  const t0 = Date.now();
  const out = await tools.runTool("nearby_places", { latitude: P.lat, longitude: P.lng, type: "cafe" }, { conversationId: C, kind: "user", fetchImpl: n.fetchImpl, onCall: 1 });
  const took = Date.now() - t0;
  assert.equal(out.down, true);
  assert.equal(out.tries, 1);
  assert.ok(took < places.CALL_BUDGET_MS + 300, `took ${took} ms`);
});

test("a short budget is kept however slow the sources are", async () => {
  const n = net({ overpass: "hang", nominatim: "hang", photon: "hang" });
  const t0 = Date.now();
  const out = await places.nearbyPlaces(P.lat, P.lng, "bar", { budgetMs: 1_200, fetchImpl: n.fetchImpl });
  const took = Date.now() - t0;
  assert.equal(out.down, true);
  assert.ok(took < 1_600, `took ${took} ms`);
});

test("the same ask a minute later, a few metres away, comes from the cache; after a few minutes it is asked again", async () => {
  const n = net({ overpass: "refuse", nominatim: [nom("Duane Reade", 377)], photon: { features: [] } });
  const a = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  assert.equal(a.count, 1);
  const asked = n.calls.length;
  clock.skip(60_000);
  const b = await places.nearbyPlaces(P.lat + 0.0001, P.lng - 0.0001, "pharmacy", { fetchImpl: n.fetchImpl });
  assert.equal(b.cached, true);
  assert.equal(b.count, 1);
  assert.equal(n.calls.length, asked, "nothing asked");
  b.results[0].name = "changed";
  const c = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  assert.equal(c.results[0].name, "Duane Reade", "a caller's edit does not reach the cache");
  clock.skip(places.CACHE_MS + 1);
  await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  assert.ok(n.calls.length > asked, "asked again once the cache ran out");
});

test("sorted by distance across sources", async () => {
  const n = net({
    overpass: { elements: [ovp("B", 600)] },
    nominatim: [nom("C", 900), nom("A", 100)],
    photon: { features: [pho("D", 1200), pho("E", 300)] },
  });
  const out = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  assert.deepEqual(out.results.map(r => r.name), ["A", "E", "B", "C", "D"]);
  out.results.forEach((r, i) => assert.ok(Math.abs(r.distance_m - [100, 300, 600, 900, 1200][i]) <= 10, `${r.name} ${r.distance_m}`));
});

test("every request says who is asking (an identifying User-Agent)", async () => {
  const n = net({ overpass: { elements: [] }, nominatim: [], photon: { features: [] } });
  await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  await places.geocode("Union Square", { fetchImpl: n.fetchImpl });
  await places.reverseGeocode(P.lat, P.lng, { fetchImpl: n.fetchImpl });
  assert.ok(n.calls.length >= 6);
  for (const c of n.calls) assert.match(c.opts.headers["user-agent"], /^Reason\/1\.0 \(.+\+https:\/\//, c.src);
});

test("Nominatim: at most one request a second across the process", async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  assert.equal(await places.nominatimTurn({ sleep }), true);
  assert.equal(await places.nominatimTurn({ sleep }), true);
  assert.equal(await places.nominatimTurn({ sleep }), true);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] > 900 && waits[0] <= 1000, String(waits[0]));
  assert.ok(waits[1] > 1900 && waits[1] <= 2000, String(waits[1]));
  assert.equal(await places.nominatimTurn({ sleep, maxWaitMs: 500 }), false, "a turn too far off is given up, not waited for");
  // Real time: two different searches back to back reach Nominatim a second apart.
  places.resetPlacesState();
  const n = net({ overpass: { elements: [] }, nominatim: [], photon: { features: [] } });
  await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  await places.nearbyPlaces(P.lat, P.lng, "bakery", { fetchImpl: n.fetchImpl });
  const at = n.calls.filter(c => c.src === "nominatim").map(c => c.at);
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 950, `${at[1] - at[0]} ms apart`);
});

test("retryTransient stops at a result that already tried everything (no_retry), and still reads it as transient", async () => {
  let runs = 0;
  const got = await retry.retryTransient(async () => { runs++; return { ok: false, error: "timed out", no_retry: true }; }, { sleep: async () => {} });
  assert.equal(runs, 1);
  assert.equal(got.tries, 1);
  assert.equal(retry.isTransient(got.out), true, "so the one re-check is still set");
  runs = 0;
  await retry.retryTransient(async () => { runs++; return { ok: false, error: "timed out" }; }, { sleep: async () => {} });
  assert.equal(runs, 3, "everything else is retried as before");
});

// ---------- weather: a second free source ----------

const metBody = (tC = 5, symbol = "lightrain") => ({
  properties: { timeseries: [0, 1, 2, 3].map(h => ({
    time: new Date(Date.UTC(2026, 10, 14, 15 + h)).toISOString().replace(".000", ""),
    data: { instant: { details: { air_temperature: tC + h, wind_speed: 4 } }, next_1_hours: { summary: { symbol_code: `${symbol}_day` }, details: { precipitation_amount: 0.3 } } },
  })) },
});

test("weather: Open-Meteo not answering → MET Norway's reading, said as such, no made-up rain chance", async () => {
  const n = net({ openmeteo: "refuse", metno: metBody(5) });
  const w = await weather.weatherAt(P.lat, P.lng, { fetchImpl: n.fetchImpl, now: Date.UTC(2026, 10, 14, 15, 20) });
  assert.equal(w.ok, true);
  assert.equal(w.source, "MET Norway, by coordinates");
  assert.equal(w.now.temp_f, 41);
  assert.equal(w.now.conditions, "light rain");
  assert.equal(w.now.wind_mph, 9);
  assert.equal(w.now.feels_like_f, null);
  assert.equal(w.today.rain_chance_pct, null);
  assert.equal(w.today.high_f, 46);
  assert.equal(w.reading_minutes_old, 20);
  assert.match(n.calls.find(c => c.src === "metno").opts.headers["user-agent"], /^Reason\/1\.0/);
  // Open-Meteo is skipped for a while after that.
  n.calls.length = 0;
  await weather.weatherAt(P.lat, P.lng, { fetchImpl: n.fetchImpl });
  assert.deepEqual(n.calls.map(c => c.src), ["metno"]);
});

test("weather: a hanging Open-Meteo costs its short timeout, not six seconds, before MET answers", async () => {
  const n = net({ openmeteo: "hang", metno: metBody() });
  const t0 = Date.now();
  const w = await weather.weatherAt(P.lat, P.lng, { fetchImpl: n.fetchImpl });
  const took = Date.now() - t0;
  assert.equal(w.ok, true);
  assert.ok(took < weather.OPEN_METEO_MS + 400, `took ${took} ms`);
});

test("weather: Open-Meteo up is used as before; both down says so; an answer from Open-Meteo (4xx, 5xx) is not sent elsewhere", async () => {
  const up = net({ openmeteo: { current: { temperature_2m: 50, weather_code: 3, time: "2026-11-14T10:00" }, utc_offset_seconds: -18000, daily: { temperature_2m_max: [55], precipitation_probability_max: [10] } } });
  const a = await weather.weatherAt(P.lat, P.lng, { fetchImpl: up.fetchImpl });
  assert.equal(a.source, "Open-Meteo, by coordinates");
  assert.equal(a.now.conditions, "overcast");
  assert.equal(a.today.rain_chance_pct, 10);
  assert.deepEqual(up.calls.map(c => c.src), ["openmeteo"]);
  const down = net({ openmeteo: "fail", metno: "fail" });
  const b = await weather.weatherAt(P.lat, P.lng, { fetchImpl: down.fetchImpl });
  assert.equal(b.ok, false);
  assert.match(b.error, /could not reach the weather service/);
  assert.equal(retry.isTransient(b), true, "retried and re-checked as before");
  for (const status of [400, 503]) {
    weather.resetWeatherState();
    const bad = net({ openmeteo: status, metno: metBody() });
    const c = await weather.weatherAt(P.lat, P.lng, { fetchImpl: bad.fetchImpl });
    assert.equal(c.ok, false);
    assert.equal(c.error, `the weather service answered ${status}`);
    assert.deepEqual(bad.calls.map(x => x.src), ["openmeteo"]);
  }
});
