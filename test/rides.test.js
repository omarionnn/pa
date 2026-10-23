// The car services Reason may ring for a pickup (src/rides.js). Every number here was read off the
// company's own website; this file pins them, so swapping in a number nobody checked fails a test
// instead of reaching somebody's phone.
import { test } from "node:test";
import assert from "node:assert/strict";

const { CAR_SERVICES, areaOf, carServicesAt, isKnownCarService } = await import("../src/rides.js");

test("the dispatch numbers are exactly the two read off the companies' own sites", () => {
  assert.deepEqual(
    CAR_SERVICES.map(s => [s.name, s.phone, s.area]),
    [["Dial 7", "+12127777777", "nyc"], ["Carmel Car & Limo", "+12126666666", "nyc"]],
    "a changed or added number must be read off the company's own site and pinned here",
  );
  for (const s of CAR_SERVICES) {
    assert.match(s.verified, /\.com, read \d{4}-\d{2}-\d{2}/, `${s.name} says where and when its number was read`);
    assert.match(s.phone, /^\+1\d{10}$/, `${s.name} is a dialable E.164 number`);
    assert.equal(s.say.replace(/\D/g, ""), s.phone.slice(2), `${s.name}: what is said is the number dialled`);
  }
});

test("a pickup inside New York gets both services", () => {
  for (const [lat, lon, where] of [[40.8569, -73.8312, "Bruner Ave, Bronx"], [40.7432, -74.0062, "Chelsea"], [40.6782, -73.9442, "Brooklyn"], [40.5795, -74.1502, "Staten Island"], [40.5121, -74.2468, "Tottenville"], [40.6437, -74.0736, "St. George"], [40.7769, -73.874, "LaGuardia"], [40.787, -73.975, "Upper West Side"], [40.8677, -73.9212, "Inwood"], [40.7128, -74.006, "City Hall"]]) {
    const got = carServicesAt(lat, lon);
    assert.deepEqual(got.map(s => s.name), ["Dial 7", "Carmel Car & Limo"], where);
    assert.equal(got[0].area, "New York City");
  }
});

test("a pickup outside New York gets none", () => {
  for (const [lat, lon, where] of [[37.7749, -122.4194, "San Francisco"], [42.3601, -71.0589, "Boston"], [41.0, -73.8, "north of the Bronx"], [40.7357, -74.1724, "Newark"], [40.7178, -74.0431, "Jersey City"], [40.5773, -74.2282, "Carteret"], [40.5068, -74.2654, "Perth Amboy"], [40.6687, -74.1143, "Bayonne"], [40.744, -74.032, "Hoboken"], [40.8509, -73.9701, "Fort Lee"], [40.9312, -73.8988, "Yonkers"], [5.6037, -0.187, "Accra"]]) {
    assert.deepEqual(carServicesAt(lat, lon), [], where);
    assert.equal(areaOf(lat, lon), null, where);
  }
});

test("no coordinates, no offer", () => {
  assert.deepEqual(carServicesAt(null, null), []);
  assert.deepEqual(carServicesAt("x", -73.9), []);
  assert.deepEqual(carServicesAt(undefined, undefined), []);
});

test("only the pinned numbers count as known, however they are written", () => {
  assert.equal(isKnownCarService("+12127777777"), true);
  assert.equal(isKnownCarService("+1 (212) 666-6666"), true);
  assert.equal(isKnownCarService("+12125551234"), false);
  assert.equal(isKnownCarService(""), false);
  assert.equal(isKnownCarService(null), false);
});
