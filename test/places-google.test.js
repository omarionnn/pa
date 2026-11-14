// nearby_places with Google Places (New) as the first source when REASON_GOOGLE_PLACES_KEY is set:
// the field mask decides the cost (Pro by default, Enterprise only for hours/phone/ratings), a hard
// monthly cap per tier kept in the database, and the free sources whenever Google is not asked or
// does not answer. With no key, nothing changes.
//
// Every fetch here is a stub, so nothing reaches the internet. The key is a made-up string.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-places-google-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
delete process.env.REASON_GOOGLE_PLACES_KEY;

const places = await import("../src/places.js");
const gp = await import("../src/googleplaces.js");
const planmeter = await import("../src/planmeter.js");
const ops = await import("../src/pages/ops.js");
const db = await import("../src/db.js");
const tools = await import("../src/tools.js");
const { clock } = await import("../src/config.js");
const C = "dm:owner";
const P = { lat: 40.7433, lng: -74.0053 };
const KEY = "test-key-not-real-0123456789";

before(() => {});
after(() => { delete process.env.REASON_GOOGLE_PLACES_KEY; clock.reset(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  places.resetPlacesState(); gp.resetGoogleState(); clock.reset();
  db.db.exec("DELETE FROM google_places_usage");
  process.env.REASON_GOOGLE_PLACES_KEY = KEY;
  delete process.env.REASON_GOOGLE_PLACES_PRO_MAX; delete process.env.REASON_GOOGLE_PLACES_ENT_MAX;
});
afterEach(() => { delete process.env.REASON_GOOGLE_PLACES_KEY; });

const north = (m) => P.lat + m / 111_320;
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const hang = (opts) => new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
const gPlace = (name, m, extra = {}) => ({
  id: `ChIJ${name.replace(/\W/g, "")}`, displayName: { text: name, languageCode: "en" },
  formattedAddress: "38 W 14th St, New York, NY 10011, USA", shortFormattedAddress: "38 W 14th St, New York",
  location: { latitude: north(m), longitude: P.lng }, businessStatus: "OPERATIONAL",
  googleMapsUri: `https://maps.google.com/?cid=${m}`, primaryType: "store", ...extra,
});
/** A stub network: google = body | status | "hang" | fn; the free sources answer with one pharmacy each. */
function net({ google = { places: [] } } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const host = new URL(String(url)).host;
    calls.push({ host, url: String(url), opts });
    if (host === "places.googleapis.com") {
      if (google === "hang") return hang(opts);
      if (typeof google === "number") return reply({ error: { message: "nope" } }, google);
      return reply(typeof google === "function" ? google(opts) : google);
    }
    if (host === "nominatim.openstreetmap.org") return reply([{ osm_type: "node", osm_id: 1, lat: String(north(377)), lon: String(P.lng), name: "Duane Reade", category: "amenity", type: "pharmacy", address: { house_number: "131", road: "8th Avenue" }, extratags: {} }]);
    if (host === "photon.komoot.io") return reply({ features: [] });
    throw new Error("ECONNREFUSED"); // Overpass
  };
  return { fetchImpl, calls, google: () => calls.filter(c => c.host === "places.googleapis.com") };
}
const bodyOf = (c) => JSON.parse(c.opts.body);
const maskOf = (c) => c.opts.headers["x-goog-fieldmask"];

test("no key: Google is never asked, and the tool's words and inputs are exactly as before", async () => {
  delete process.env.REASON_GOOGLE_PLACES_KEY;
  const n = net();
  const out = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl, openNow: true, details: ["hours"] });
  assert.equal(n.google().length, 0);
  assert.equal(out.ok, true);
  assert.equal(out.answered_by, "nominatim");
  assert.equal(out.open_now_checked, undefined, "no new field without a key");
  assert.equal(out.note, undefined);
  places.resetPlacesState();
  const free = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: net().fetchImpl, freeOnly: true });
  assert.deepEqual(out.results, free.results);
  const def = tools.tools.find(t => t.name === "nearby_places");
  assert.match(def.description, /^Find places near specific coordinates — restaurants, cafes, bars, cinemas, shops, parks, etc\. Uses OpenStreetMap data\./);
  assert.deepEqual(Object.keys(def.input_schema.properties), ["latitude", "longitude", "type", "cuisine", "name", "radius"]);
  assert.equal(planmeter.METERS.filter(m => m.id.startsWith("google")).some(m => m.configured()), false, "no meter on /ops");
  // With a key the tool says so and takes the two extra inputs.
  process.env.REASON_GOOGLE_PLACES_KEY = KEY;
  assert.match(def.description, /Google Maps/);
  assert.ok(def.input_schema.properties.open_now && def.input_schema.properties.details);
  assert.match(JSON.stringify(tools.tools.find(t => t.name === "nearby_places")), /open_now/, "the getters survive serialising");
});

test("a named place: Google first, Pro mask, a bias circle, the key in a header to places.googleapis.com only, nearest first inside the radius", async () => {
  const n = net({ google: { places: [gPlace("Party City", 3200, { id: "B" }), gPlace("Party City", 1100, { id: "A" }), gPlace("Party City", 9000, { id: "C" })] } });
  const out = await places.nearbyPlaces(P.lat, P.lng, "shop", { name: "Party City", radius: 4000, fetchImpl: n.fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.answered_by, "google_pro");
  assert.deepEqual(out.results.map(r => r.place_id), ["A", "B"]);
  const [a] = out.results;
  assert.equal(a.name, "Party City");
  assert.equal(a.address, "38 W 14th St");
  assert.equal(a.city, "New York");
  assert.equal(a.google_maps_url, "https://maps.google.com/?cid=1100");
  assert.ok(Math.abs(a.distance_m - 1100) <= 15);
  assert.equal(out.attribution, "Google Maps");
  assert.match(out.note, /google_maps_url/);
  const [g] = n.google();
  assert.equal(g.url, "https://places.googleapis.com/v1/places:searchText");
  assert.equal(g.opts.method, "POST");
  assert.equal(g.opts.headers["x-goog-api-key"], KEY);
  assert.equal(maskOf(g), gp.MASKS.pro);
  const b = bodyOf(g);
  assert.equal(b.textQuery, "Party City");
  assert.deepEqual(b.locationBias.circle, { center: { latitude: P.lat, longitude: P.lng }, radius: 4000 });
  assert.equal(b.includedType, undefined);
  assert.ok(!n.calls.some(c => c.host !== "places.googleapis.com"), "the free sources are not asked when Google answered");
  assert.ok(!JSON.stringify(out).includes(KEY), "the key is never in a result");
  assert.ok(!g.url.includes(KEY), "nor in the URL");
});

test("a category: Table A type, strict, a restriction rectangle, ranked by distance; a cuisine is words, not a type", async () => {
  const n = net({ google: { places: [gPlace("CVS Pharmacy", 433)] } });
  await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { radius: 1500, fetchImpl: n.fetchImpl });
  let b = bodyOf(n.google()[0]);
  assert.equal(b.textQuery, "pharmacy");
  assert.equal(b.includedType, "pharmacy");
  assert.equal(b.strictTypeFiltering, true);
  assert.equal(b.rankPreference, "DISTANCE");
  assert.ok(b.locationRestriction.rectangle.low.latitude < P.lat && b.locationRestriction.rectangle.high.latitude > P.lat);
  assert.equal(b.locationBias, undefined, "one of bias or restriction, never both");
  await places.nearbyPlaces(P.lat, P.lng, "restaurant", { cuisine: "ramen", radius: 2000, fetchImpl: n.fetchImpl });
  b = bodyOf(n.google()[1]);
  assert.equal(b.textQuery, "ramen restaurant");
  assert.equal(b.includedType, undefined);
  assert.equal(gp.requestBody(P.lat, P.lng, "bookstore").includedType, "book_store");
  assert.equal(gp.requestBody(P.lat, P.lng, "cinema").includedType, "movie_theater");
});

test("the mask is the cost: Enterprise only for hours, phone, rating, website or price; open-now is a Pro request parameter", async () => {
  assert.equal(gp.tierFor({}), "pro");
  assert.equal(gp.tierFor({ details: [] }), "pro");
  for (const d of ["hours", "phone", "rating", "website", "price"]) assert.equal(gp.tierFor({ details: [d] }), "enterprise", d);
  for (const f of ["currentOpeningHours", "nationalPhoneNumber", "rating", "userRatingCount", "priceLevel", "websiteUri"]) {
    assert.ok(!gp.MASKS.pro.includes(f), `${f} is never in the Pro mask`);
    assert.ok(gp.MASKS.enterprise.includes(`places.${f}`), f);
  }
  assert.ok(!/reviews|editorialSummary|servesBeer|\*/.test(gp.MASKS.enterprise), "never an Enterprise + Atmosphere field, never *");
  const n = net({ google: { places: [gPlace("Cafe", 100)] } });
  await places.nearbyPlaces(P.lat, P.lng, "cafe", { openNow: true, fetchImpl: n.fetchImpl });
  await places.nearbyPlaces(P.lat, P.lng, "cafe", { details: ["rating"], fetchImpl: n.fetchImpl });
  const [open, rated] = n.google();
  assert.equal(maskOf(open), gp.MASKS.pro);
  assert.equal(bodyOf(open).openNow, true);
  assert.equal(maskOf(rated), gp.MASKS.enterprise);
  assert.equal(gp.used("pro"), 1);
  assert.equal(gp.used("enterprise"), 1);
});

test("nothing invented: a Pro answer has no hours, phone or rating; an Enterprise answer carries only what Google sent", async () => {
  const pro = gp.mapPlaces([gPlace("A", 100)], "pro")[0];
  assert.equal(pro.opening_hours, null);
  assert.equal(pro.phone, null);
  assert.equal(pro.website, null);
  for (const k of ["open_now", "rating", "rating_count", "price_level"]) assert.ok(!(k in pro), k);
  const ent = gp.mapPlaces([
    gPlace("B", 200, { currentOpeningHours: { openNow: false, weekdayDescriptions: ["Monday: 9:00 AM – 9:00 PM", "Tuesday: 9:00 AM – 9:00 PM"] }, internationalPhoneNumber: "+1 212-555-0100", rating: 4.4, userRatingCount: 120, priceLevel: "PRICE_LEVEL_MODERATE", websiteUri: "https://example.com/" }),
    gPlace("C", 300),
    gPlace("Gone", 50, { businessStatus: "CLOSED_PERMANENTLY" }),
    gPlace("Shut", 60, { businessStatus: "CLOSED_TEMPORARILY" }),
  ], "enterprise");
  assert.deepEqual(ent.map(r => r.name), ["B", "C", "Shut"], "a closed-for-good place is dropped");
  const [b, c, shut] = ent;
  assert.equal(b.open_now, false);
  assert.equal(b.opening_hours, "Monday: 9:00 AM – 9:00 PM; Tuesday: 9:00 AM – 9:00 PM");
  assert.equal(b.phone, "+1 212-555-0100");
  assert.equal(b.rating, 4.4);
  assert.equal(b.rating_count, 120);
  assert.equal(b.price_level, "moderate");
  assert.equal(b.website, "https://example.com/");
  assert.equal(c.opening_hours, null);
  for (const k of ["open_now", "rating", "rating_count", "price_level"]) assert.ok(!(k in c), `${k} absent where Google sent none`);
  assert.equal(shut.temporarily_closed, true);
});

test("the cap: once this month's requests are used up, the free sources answer and Google is not asked", async () => {
  process.env.REASON_GOOGLE_PLACES_PRO_MAX = "2";
  const n = net({ google: { places: [gPlace("CVS", 433)] } });
  for (const type of ["pharmacy", "bakery", "bank"]) await places.nearbyPlaces(P.lat, P.lng, type, { fetchImpl: n.fetchImpl });
  assert.equal(n.google().length, 2);
  assert.equal(gp.used("pro"), 2, "never past the cap");
  const out = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { radius: 1500, fetchImpl: n.fetchImpl });
  assert.equal(n.google().length, 2);
  assert.equal(out.ok, true);
  assert.equal(out.answered_by, "nominatim");
  assert.deepEqual(out.results.map(r => r.name), ["Duane Reade"]);
  // Enterprise has its own cap; 0 turns Google off for that tier.
  process.env.REASON_GOOGLE_PLACES_ENT_MAX = "0";
  await places.nearbyPlaces(P.lat, P.lng, "cafe", { details: ["hours"], fetchImpl: n.fetchImpl });
  assert.equal(n.google().length, 2);
  // Two at once can't both take the last one.
  process.env.REASON_GOOGLE_PLACES_ENT_MAX = "1";
  assert.deepEqual([gp.claim("enterprise"), gp.claim("enterprise")], [true, false]);
});

test("counts are per Google billing month (Pacific): a new month starts at 0", async () => {
  assert.equal(gp.monthOf(Date.UTC(2026, 11, 1, 7, 59)), "2026-11", "Dec 1 07:59 UTC is still Nov 30 in Pacific time");
  assert.equal(gp.monthOf(Date.UTC(2026, 11, 1, 8, 1)), "2026-12");
  gp.claim("pro", "2026-11"); gp.claim("pro", "2026-11"); gp.claim("pro", "2026-12");
  assert.equal(gp.used("pro", "2026-11"), 2);
  assert.equal(gp.used("pro", "2026-12"), 1);
  assert.equal(gp.used("enterprise", "2026-11"), 0);
});

test("Google failing (error, refusal, timeout) or finding nothing: the free sources answer, silently, inside the budget", async () => {
  const logs = [];
  for (const google of [500, 403, 429, "hang", { places: [] }, { places: [gPlace("Far away", 9_000)] }]) {
    places.resetPlacesState(); gp.resetGoogleState();
    const n = net({ google });
    const t0 = Date.now();
    const out = await gp.googleSearch(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl, timeoutMs: 300, log: (x) => logs.push(x) });
    if (typeof google === "object") assert.equal(out.ok, true); else assert.equal(out.ok, false, String(google));
    const full = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl, budgetMs: 2_000 });
    assert.equal(full.ok, true, String(google));
    assert.equal(full.answered_by, "nominatim", String(google));
    assert.deepEqual(full.results.map(r => r.name), ["Duane Reade"]);
    assert.equal(full.error, undefined);
    assert.ok(Date.now() - t0 < 3_000, `${google}: ${Date.now() - t0} ms`);
  }
  assert.ok(logs.length >= 4);
  assert.ok(!JSON.stringify(logs).includes(KEY), "the key is never logged");
});

test("after a timeout Google is skipped for a while (the next search does not wait on it again)", async () => {
  const n = net({ google: "hang" });
  await gp.googleSearch(P.lat, P.lng, "cafe", { fetchImpl: n.fetchImpl, timeoutMs: 100, log: () => {} });
  const again = await gp.googleSearch(P.lat, P.lng, "cafe", { fetchImpl: n.fetchImpl, timeoutMs: 100, log: () => {} });
  assert.deepEqual([again.ok, again.why], [false, "skipped"]);
  assert.equal(n.google().length, 1);
  assert.equal(gp.used("pro"), 1, "only the one sent is counted");
  clock.skip(3 * 60_000);
  await gp.googleSearch(P.lat, P.lng, "cafe", { fetchImpl: n.fetchImpl, timeoutMs: 100, log: () => {} });
  assert.equal(n.google().length, 2);
});

test("Google's places are never cached (its terms): the same ask twice asks Google twice", async () => {
  const n = net({ google: { places: [gPlace("CVS", 433)] } });
  const a = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  const b = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  assert.equal(n.google().length, 2);
  assert.equal(b.cached, undefined);
  assert.deepEqual(a.results, b.results);
});

test("open-now asked and only the free sources answered: the result says it was not checked", async () => {
  const n = net({ google: 503 });
  const out = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { openNow: true, fetchImpl: n.fetchImpl });
  assert.equal(out.open_now_checked, false);
  assert.match(out.note, /not checked/);
  const g = net({ google: { places: [gPlace("CVS", 433, { currentOpeningHours: { openNow: true } })] } });
  gp.resetGoogleState();
  const ok = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { openNow: true, fetchImpl: g.fetchImpl });
  assert.equal(ok.open_now_checked, true);
});

test("the tool: open_now and details reach Google; the result says it is Google Maps' and carries the link", async () => {
  const n = net({ google: { places: [gPlace("CVS Pharmacy", 433, { internationalPhoneNumber: "+1 212-555-0101" })] } });
  globalThis.fetch = n.fetchImpl;
  const out = await tools.runTool("nearby_places", { latitude: P.lat, longitude: P.lng, type: "pharmacy", open_now: true, details: ["phone"] }, { conversationId: C, kind: "user", fetchImpl: n.fetchImpl });
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  const [g] = n.google();
  assert.equal(maskOf(g), gp.MASKS.enterprise);
  assert.equal(bodyOf(g).openNow, true);
  assert.equal(out.results[0].google_maps_url, "https://maps.google.com/?cid=433");
  assert.equal(out.results[0].phone, "+1 212-555-0101");
  assert.equal(out.attribution, "Google Maps");
});

test("the ops page: one meter per tier once a key is set, used of cap, $0 inside the free allowance, texts at 80% and 100%", async () => {
  process.env.REASON_GOOGLE_PLACES_PRO_MAX = "10";
  for (let i = 0; i < 8; i++) gp.claim("pro");
  const readings = await planmeter.readAll({ meters: planmeter.METERS.filter(m => m.id.startsWith("google")) });
  assert.deepEqual(readings.map(r => r.id), ["google-places-pro", "google-places-enterprise"]);
  const pro = readings[0];
  assert.deepEqual([pro.used, pro.allowance, pro.pct], [8, 10, 80]);
  const html = ops.metersSection(readings);
  assert.match(html, /Google Places \(Pro searches\)/);
  assert.match(html, /8 of 10 searches this month · 80%/);
  assert.match(html, /\$0 \(inside Google&#39;s free 5,000 a month\)|\$0 \(inside Google's free 5,000 a month\)/);
  assert.match(html, /ck-warn/);
  assert.ok(!html.includes(KEY));
  const sent = [];
  planmeter.warnings({ readings, send: (t) => sent.push(t), meters: planmeter.METERS });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Google: 8 of 10 searches this month used \(80%\)\. At 10 this month, nearby searches switch to the free map sources/);
  assert.equal(gp.estCents("pro", 5_000), 0);
  assert.equal(gp.estCents("pro", 6_000), 3_200);
  assert.equal(gp.estCents("enterprise", 1_100), 350);
  delete process.env.REASON_GOOGLE_PLACES_KEY;
  assert.equal((await planmeter.readAll({ meters: planmeter.METERS.filter(m => m.id.startsWith("google")) })).length, 0);
});

test("a record of the call (tool log, ledger) keeps Google's place IDs and the count, never names or addresses", async () => {
  const { sealTravelers } = await import("../src/privacy.js");
  const n = net({ google: { places: [gPlace("CVS Pharmacy", 433, { id: "ChIJabc" })] } });
  const out = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: n.fetchImpl });
  const kept = sealTravelers("nearby_places", out);
  assert.deepEqual(kept.results, [{ place_id: "ChIJabc" }]);
  assert.equal(kept.count, 1);
  assert.ok(!JSON.stringify(kept).includes("CVS"));
  assert.ok(!JSON.stringify(kept).includes("14th"));
  // The free sources' (OpenStreetMap) records are kept as before.
  delete process.env.REASON_GOOGLE_PLACES_KEY;
  places.resetPlacesState();
  const free = await places.nearbyPlaces(P.lat, P.lng, "pharmacy", { fetchImpl: net().fetchImpl });
  assert.deepEqual(sealTravelers("nearby_places", free), free);
});
