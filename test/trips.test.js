// Real trips (src/trips.js, the `directions` tool, and /d/<id> in src/pages/directions.js): Reason makes
// a walk from a real start to a real place, stores it, and opens it for its owner only.
//
// What is pinned here is what a real trip gets wrong quietly:
//   - the start is never guessed: no location, no trip, and the tool says to ask get_location;
//   - an event's hidden address is never walked to, and its start is what "You're early" is judged on;
//   - the link opens only on the owner's own browser; anyone else, or a link preview, gets the gate,
//     which never names the place or an address, and the bare link and an unknown id read the same;
//   - REASON_DIRECTIONS=owner: nobody else is told the tool exists, and nobody else's trip opens;
//   - a reroute is answered and dropped: no position is stored, and only the owner's browser may ask.
// No network: the router, Overpass and the geocoder are stand-ins.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-trips-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_DIRECTIONS = "owner";
process.env.REASON_DIRECTIONS_ROUTING_URL = "https://routes.example.test";

const { runTool, toolsFor } = await import("../src/tools.js");
const trips = await import("../src/trips.js");
const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { directionsRequest } = await import("../src/pages/directions.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const GUEST = "dm:+12025550111";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db.db.exec("DELETE FROM trips; DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM saved_places;");
});

// Union Square to a café 600 m north-east, in Manhattan: the router's walk, three real turns and a kerb.
const START = { lat: 40.7359, lng: -73.9911 };
const CAFE = { lat: 40.7402, lng: -73.9868 };
function osrm() {
  return {
    code: "Ok",
    routes: [{
      distance: 640, duration: 512,
      geometry: { coordinates: [[-73.9911, 40.7359], [-73.9905, 40.7368], [-73.9890, 40.7376], [-73.9881, 40.7390], [-73.9868, 40.7402]] },
      legs: [{ steps: [
        { name: "", distance: 110, maneuver: { type: "depart", bearing_after: 30, location: [-73.9911, 40.7359] } },
        { name: "East 17th Street", distance: 150, maneuver: { type: "turn", modifier: "right", location: [-73.9905, 40.7368] } },
        { name: "", distance: 4, maneuver: { type: "turn", modifier: "left", location: [-73.9890, 40.7376] } },
        { name: "", distance: 200, maneuver: { type: "turn", modifier: "left", location: [-73.98898, 40.73762] } },
        { name: "Park Avenue South", distance: 0, maneuver: { type: "new name", modifier: "straight", location: [-73.9881, 40.7390] } },
        { name: "", distance: 176, maneuver: { type: "turn", modifier: "right", location: [-73.9881, 40.7390] } },
        { name: "", distance: 0, maneuver: { type: "arrive", modifier: "left", location: [-73.9868, 40.7402] } },
      ] }],
    }],
  };
}
function overpassData() {
  return {
    elements: [
      { type: "way", tags: { highway: "primary", name: "Broadway" }, geometry: [{ lat: 40.7350, lon: -73.9915 }, { lat: 40.7410, lon: -73.9895 }] },
      { type: "way", tags: { highway: "residential", name: "East 18th Street" }, geometry: [{ lat: 40.73755, lon: -73.98905 }, { lat: 40.73905, lon: -73.98815 }] },
      { type: "way", tags: { highway: "residential", name: "East 20th Street" }, geometry: [{ lat: 40.73905, lon: -73.98805 }, { lat: 40.74025, lon: -73.98675 }] },
      { type: "way", tags: { highway: "footway" }, geometry: [{ lat: 40.7360, lon: -73.9911 }, { lat: 40.7367, lon: -73.9906 }] },
      { type: "way", tags: { leisure: "park", name: "Gramercy Park" }, geometry: [{ lat: 40.7378, lon: -73.9866 }, { lat: 40.7380, lon: -73.9860 }, { lat: 40.7375, lon: -73.9858 }, { lat: 40.7378, lon: -73.9866 }] },
      { type: "node", lat: 40.7404, lon: -73.9866, tags: { amenity: "cafe", name: "Daily Provisions" } },
      { type: "node", lat: 40.7402, lon: -73.9868, tags: { amenity: "cafe", name: "Joe Coffee" } },
    ],
  };
}
function fakeNet({ overpass = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? String(opts.body) : "" });
    if (String(url).startsWith("https://routes.example.test")) return { ok: true, json: async () => osrm() };
    if (/overpass/.test(String(url))) return overpass ? { ok: true, json: async () => overpassData() } : { ok: false, status: 504, json: async () => ({}) };
    if (/project-osrm/.test(String(url))) return { ok: true, json: async () => ({ code: "Ok", routes: [{ duration: 600, distance: 3000 }] }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetchImpl };
}
const geocode = async (q) => (/joe coffee|141 e 21/i.test(q) ? { lat: CAFE.lat, lng: CAFE.lng, display_name: "Joe Coffee, 141, East 21st Street, Manhattan, New York" } : /elm/i.test(q) ? { lat: CAFE.lat, lng: CAFE.lng, display_name: "12 Elm St" } : null);
const tool = (input, c = C, net = fakeNet()) => runTool("directions", input, { conversationId: c, fetchImpl: net.fetchImpl, geocode });
const tripOf = (link) => db.getTrip(/\/d\/([A-Za-z0-9]+)\?k=/.exec(link)[1]);
const pageJson = (html) => JSON.parse(html.match(/<script id="trip" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const signIn = (c = C) => { const token = `tok-${Math.random().toString(36).slice(2)}`; db.startPageSession("web", token, { conversationId: c }); return token; };
const get = (pathname, { cookie = null, key = null, method = "GET" } = {}) => directionsRequest({ method, pathname, config, key, headers: cookie ? { cookie: `reason_page=${cookie}` } : {}, fetchImpl: fakeNet().fetchImpl });

test("steps: a kerb and a straight-on new name fold away; a nameless way takes the street it runs beside; the side comes from the router", () => {
  const raw = osrm().routes[0];
  const route = raw.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  const steps = trips.stepsFromOsrm(raw.legs[0].steps, { placeName: "Joe Coffee", line: null, streets: [] });
  assert.deepEqual(steps.map((s) => s.turn), ["straight", "right", "left", "right", "left"], "the 4 m kerb and the new name are gone");
  assert.equal(steps[0].instr, "Head northeast", "an unnamed start says which way, never a blank");
  assert.match(steps[0].mark, /in front of you/);
  assert.equal(steps[1].instr, "Turn right on East 17th Street");
  assert.equal(steps[1].into, "INTO EAST 17TH STREET");
  assert.equal(steps[1].d, "150 m");
  assert.equal(steps[2].d, "200 m", "the kerb's metres went to the step before");
  assert.equal(steps.at(-1).instr, "Joe Coffee, on your left");
  assert.equal(steps.at(-1).d, "");
});

test("steps: named from the streets the map found, when the router had no name", async () => {
  const { lineOf } = await import("../src/pages/directionsclient.js");
  const raw = osrm().routes[0];
  const line = lineOf(raw.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })));
  const streets = trips.shapesFrom(overpassData(), { dest: CAFE, placeName: "Joe Coffee" }).streets;
  const steps = trips.stepsFromOsrm(raw.legs[0].steps, { placeName: "Joe Coffee", line, streets });
  assert.equal(steps[2].instr, "Turn left on East 18th Street");
  assert.equal(steps[3].instr, "Turn right on East 20th Street");
});

test("the map: streets, parks and nearby from Overpass; footways are not drawn; the place itself is not 'nearby'", () => {
  const { map, streets, nearby } = trips.shapesFrom(overpassData(), { dest: CAFE, placeName: "Joe Coffee" });
  assert.equal(map.major.length, 1);
  assert.equal(map.minor.length, 2);
  assert.equal(map.parks.length, 1);
  assert.deepEqual(streets.map((s) => s.n).sort(), ["Broadway", "East 18th Street", "East 20th Street"]);
  assert.equal(nearby, "DAILY PROVISIONS, 1 MIN");
  assert.ok(map.major[0].every(([lng, lat]) => lng < 0 && lat > 40), "GeoJSON order, [lng, lat]");
});

test("a real trip: made from the live location to a looked-up place, stored, linked on the pages host with the owner's key", async () => {
  const net = fakeNet();
  const out = await tool({ to: "Joe Coffee, 141 E 21st St", place_name: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng, arrive_by: "2026-10-30T19:00" }, C, net);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.link, /^https:\/\/files\.example\.test\/d\/[A-Za-z0-9]{12}\?k=[A-Za-z0-9]{12}$/);
  assert.equal(out.walk, "9 min walk · 640 m");
  assert.equal(out.be_there_by, "7:00 PM");
  assert.equal(out.map, "drawn");
  const row = tripOf(out.link);
  assert.equal(row.conversation_id, C);
  assert.equal(row.trip.name, "Joe Coffee");
  assert.equal(row.trip.startsLabel, "7");
  assert.equal(row.trip.startsAt, Date.parse("2026-10-30T23:00:00Z"), "their wall clock, in their zone");
  assert.equal(row.trip.side, "left");
  assert.equal(row.trip.nearby, "DAILY PROVISIONS, 1 MIN");
  assert.ok(row.trip.map.minor.length && row.trip.map.labels.length === 1, "the map was filled");
  assert.ok(row.streets.length >= 3, "the streets are kept on the row for reroutes");
  assert.ok(row.expires_at >= row.trip.startsAt + trips.TRIP_KEEP_MS, "kept a day past the walk, then gone");
  const routed = net.calls.find((c) => c.url.startsWith("https://routes.example.test"));
  assert.match(routed.url, /\/route\/v1\/foot\/-73\.9911,40\.7359;-73\.9868,40\.7402\?/);
});

test("the start is never guessed: no location, no trip, and the tool says to ask get_location", async () => {
  const out = await tool({ to: "Joe Coffee" });
  assert.equal(out.ok, false);
  assert.equal(out.needs, "origin");
  assert.match(out.error, /get_location/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM trips").get().n, 0);
});

test("a saved place is a start or an end by name, with its own pin", async () => {
  db.db.prepare("INSERT INTO saved_places (conversation_id, name, name_key, address, lat, lng, created_at, updated_at) VALUES (?, 'home', 'home', '5 Secret Ln', ?, ?, 0, 0)").run(C, START.lat, START.lng);
  const out = await tool({ to: "Joe Coffee", from: "home" });
  assert.equal(out.ok, true, JSON.stringify(out));
  const back = await tool({ to: "home", from_latitude: CAFE.lat, from_longitude: CAFE.lng });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(tripOf(back.link).trip.name, "Home");
});

test("not a walk: 40 km away in a straight line says so and offers a ride; nothing is made", async () => {
  const out = await tool({ to: "Joe Coffee", from_latitude: 41.2, from_longitude: -73.99 });
  assert.equal(out.ok, false);
  assert.equal(out.too_far, true);
  assert.match(out.error, /uber_link/);
});

test("an event: its released address, its start and its link; a guest is never walked to an address still hidden", async () => {
  const made = events.create(C, { name: "Halloween Party", description: "costumes", starts_at: "2026-10-31T21:00", location: "12 Elm St", welcome_message: "", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true });
  assert.equal(made.ok, true, JSON.stringify(made));
  const ev = made.event;
  const own = await tool({ event_id: ev.id, from_latitude: START.lat, from_longitude: START.lng });
  assert.equal(own.ok, true, JSON.stringify(own));
  const t = tripOf(own.link).trip;
  assert.equal(t.name, "Halloween Party");
  assert.equal(t.startsLabel, "9");
  assert.equal(t.links.event.url, events.eventUrl(ev));
  // A guest of the same event, before the organizer shares where it is.
  const j = await events.joinExisting({ conversationId: GUEST, name: "Halloween Party", password: "pumpkin", displayName: "Ama" });
  assert.equal(j.ok, true, JSON.stringify(j));
  config.directionsOn = true; // a guest is not the owner: open it to everyone for this one
  try {
    const hidden = await tool({ event_id: ev.id, from_latitude: START.lat, from_longitude: START.lng }, GUEST);
    assert.equal(hidden.ok, false);
    assert.match(hidden.error, /hasn't shared where it is/);
  } finally { config.directionsOn = "owner"; }
});

test("REASON_DIRECTIONS=owner: only the owner is told the tool exists, and anyone else's call is refused", async () => {
  assert.ok(toolsFor(C).some((t) => t.name === "directions"));
  assert.ok(!toolsFor(GUEST).some((t) => t.name === "directions"));
  const out = await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng }, GUEST);
  assert.equal(out.ok, false);
  assert.match(out.error, /not available/);
});

test("the page: the owner's signed-in browser opens it; the trip's own JSON, without what only the server keeps", async () => {
  const out = await tool({ to: "Joe Coffee", place_name: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng });
  const row = tripOf(out.link);
  const res = await get(`/d/${row.id}`, { cookie: signIn() });
  assert.equal(res.status, 200);
  const t = pageJson(res.body);
  assert.equal(t.id, row.id);
  assert.equal(t.demo, undefined, "a real trip is never a demo (no #escort previews)");
  assert.equal(t._raw, undefined);
  assert.equal(t.streets, undefined);
  assert.equal(t.steps.length, 5);
  // Through the files host, which Caddy rewrites under /p.
  assert.equal((await get(`/p/d/${row.id}`, { cookie: signIn() })).status, 200);
});

test("the gate: anyone else gets the code gate, which never names the place; bare link and an unknown id read the same", async () => {
  db.db.prepare("INSERT INTO saved_places (conversation_id, name, name_key, address, lat, lng, created_at, updated_at) VALUES (?, 'home', 'home', '5 Secret Ln', ?, ?, 0, 0)").run(C, START.lat, START.lng);
  const out = await tool({ to: "home", from_latitude: CAFE.lat, from_longitude: CAFE.lng });
  const row = tripOf(out.link);
  const bare = await get(`/d/${row.id}`);
  const ghost = await get(`/d/NoSuchTrip12`);
  assert.equal(bare.status, 401);
  assert.equal(bare.body, ghost.body, "a real id and an imaginary one are the same bytes");
  const keyed = await get(`/d/${row.id}`, { key: row.owner_key });
  assert.equal(keyed.status, 401);
  assert.match(keyed.body, /name="send"|Text me/i, "the owner's link may ask for a code");
  for (const html of [bare.body, keyed.body]) {
    assert.doesNotMatch(html, /Secret Ln|Home|40\.73|-73\.98/, "no place, no address, no coordinates before the code");
  }
  // Somebody else's signed-in browser is not the owner's.
  assert.equal((await get(`/d/${row.id}`, { cookie: signIn(GUEST) })).status, 401);
});

test("the code: texted only from the owner's link, then typed once; the browser lands back on the page signed in", async () => {
  const out = await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng });
  const row = tripOf(out.link);
  const told = [];
  const runtime = { _tell: async (c, text, meta) => { told.push({ c, text, meta }); return { ok: true }; } };
  const post = (body, key) => directionsRequest({ method: "POST", pathname: `/d/${row.id}`, req: Readable.from([Buffer.from(body)]), config, key, headers: {}, runtime });
  await post("send=1", null);
  assert.equal(told.length, 0, "a bare link never makes the owner's phone buzz");
  const sent = await post("send=1", row.owner_key);
  assert.equal(sent.status, 401);
  assert.equal(told.length, 1);
  assert.equal(told[0].c, C);
  assert.match(told[0].meta.idempotencyKey, /^pcode:/, "kept out of the conversation's history like every code");
  const code = told[0].text.match(/\b(\d{6})\b/)[1];
  const wrong = await post("code=000000", row.owner_key);
  assert.equal(wrong.status, 401);
  const right = await post(`code=${code}`, row.owner_key);
  assert.equal(right.status, 303);
  assert.equal(right.headers.Location, row.id, "back to the page, without the key in the address bar");
  const cookie = /reason_page=([^;]+)/.exec(right.headers["Set-Cookie"])[1];
  assert.match(right.headers["Set-Cookie"], /Path=\//);
  assert.equal((await get(`/d/${row.id}`, { cookie })).status, 200);
});

test("reroute: only the owner's browser may ask; the answer names the new way's steps; no position is stored", async () => {
  const out = await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng });
  const row = tripOf(out.link);
  const before = JSON.stringify(db.getTrip(row.id));
  const ask = (cookie) => directionsRequest({ method: "POST", pathname: `/d/${row.id}/reroute`, req: Readable.from([Buffer.from(JSON.stringify({ lat: 40.7365, lng: -73.9920 }))]), config, headers: cookie ? { cookie: `reason_page=${cookie}` } : {}, fetchImpl: fakeNet().fetchImpl });
  assert.equal((await ask(null)).status, 403);
  const logs = [];
  const res = await directionsRequest({ method: "POST", pathname: `/d/${row.id}/reroute`, req: Readable.from([Buffer.from(JSON.stringify({ lat: 40.7365, lng: -73.9920 }))]), config, headers: { cookie: `reason_page=${signIn()}` }, fetchImpl: fakeNet().fetchImpl, log: (l) => logs.push(l) });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.route.length >= 2 && body.steps.length >= 3);
  assert.ok(body.steps.some((s) => s.instr === "Turn left on East 18th Street"), "named from the streets kept on the row");
  assert.equal(JSON.stringify(db.getTrip(row.id)), before, "the row is untouched: the new way lives on the phone");
  assert.doesNotMatch(JSON.stringify(logs), /40\.73|-73\.99/, "the log has no position");
});

test("owner mode: a trip that is not the owner's does not open, and an expired trip is gone", async () => {
  const net = fakeNet();
  config.directionsOn = true;
  let guestTrip;
  try {
    const out = await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng }, GUEST, net);
    assert.equal(out.ok, true, JSON.stringify(out));
    guestTrip = tripOf(out.link);
  } finally { config.directionsOn = "owner"; }
  const res = await get(`/d/${guestTrip.id}`, { cookie: signIn(GUEST) });
  assert.equal(res.status, 401, "with the flag at owner, somebody else's trip is a ghost");
  const mine = tripOf((await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng })).link);
  db.db.prepare("UPDATE trips SET expires_at = ? WHERE id = ?").run(clock.now() - 1, mine.id);
  assert.equal((await get(`/d/${mine.id}`, { cookie: signIn() })).status, 401);
  assert.equal(db.getTrip(mine.id), null);
});

test("the map is filled after the trip when Overpass is slow or down: the link works at once, on plain ground", async () => {
  const out = await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng }, C, fakeNet({ overpass: false }));
  assert.equal(out.ok, true);
  assert.match(out.map, /still filling/);
  const t = tripOf(out.link).trip;
  assert.equal(t.map.minor.length, 0);
  assert.equal(t.steps.length, 5);
});

test("a guessed id is told nothing: a wrong code reads the same on a real trip and an unknown one, and both lock alike", async () => {
  const row = tripOf((await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng })).link);
  const post = (id) => directionsRequest({ method: "POST", pathname: `/d/${id}`, req: Readable.from([Buffer.from("code=123456")]), config, headers: {} });
  for (let n = 0; n < 6; n++) {
    const [a, b] = [await post(row.id), await post("NoSuchTrip12")];
    assert.equal(a.status, b.status, `attempt ${n + 1}`);
    assert.equal(a.body, b.body, `attempt ${n + 1}: the same words`);
  }
  const [ga, gb] = [await get(`/d/${row.id}`), await get("/d/NoSuchTrip12")];
  assert.equal(ga.status, 429);
  assert.equal(ga.body, gb.body, "locked alike");
});

test("the ledger keeps that a walk was made, never where they stood or the key that opens it", async () => {
  await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng });
  const row = db.db.prepare("SELECT * FROM action_ledger WHERE action = 'directions' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, "a ledger row");
  const all = JSON.stringify(row);
  assert.doesNotMatch(all, /40\.7359|-73\.9911/, "no start coordinates");
  assert.doesNotMatch(all, /\?k=/, "no key");
  assert.match(row.receipt, /walking directions to Joe Coffee/);
});

test("a walk is for the next week: further ahead is refused, so a start is never kept for months", async () => {
  const out = await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng, arrive_by: "2027-03-01T19:00" });
  assert.equal(out.ok, false);
  assert.match(out.error, /more than a week/);
});

test("expired trips go on the sweep, read or not", async () => {
  const row = tripOf((await tool({ to: "Joe Coffee", from_latitude: START.lat, from_longitude: START.lng })).link);
  db.db.prepare("UPDATE trips SET expires_at = ? WHERE id = ?").run(clock.now() - 1, row.id);
  assert.equal(db.deleteExpiredTrips(clock.now()), 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM trips").get().n, 0);
});
