// The walking directions page: the escort's decisions (src/pages/directionsclient.js, pure functions run
// under Node), the sunset rule, and the server side (src/pages/directions.js): the page, the script, the
// font route, the reroute (no routing key in the page), and the flags that keep it off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { getTimes } from "suncalc";
import * as client from "../src/pages/directionsclient.js";
import { directionsRequest, directionsPage, reroute, sampleTrip } from "../src/pages/directions.js";

const { haversine, bearing, project, lineOf, lineForDistance, isNightAt, createEscort, toPx, fromPx, MAP_THEMES, MAP_PAINT, mapStyle, metresWide } = client;

// A walk north 111 m, a left turn, then 89 m west to the door. Metres are offsets from A.
const M_DEG = 111195;
const pos = (north, east = 0) => ({ lat: north / M_DEG, lng: east / M_DEG });
const A = pos(0, 0), B = pos(111, 0), C = pos(111, -89);
function trip() {
  return {
    destination: C,
    startsAt: undefined,
    steps: [
      { instr: "Turn left on Oxford St", turn: "left", lat: B.lat, lng: B.lng, fact: "AT THE LIGHTS", street: "OXFORD ST", into: "INTO OXFORD ST" },
      { instr: "The Garden Room, on your right", turn: "right", lat: C.lat, lng: C.lng, fact: "THE GATE", street: "OXFORD ST" },
    ],
  };
}
function engine() {
  const t = trip();
  return createEscort(t, lineOf([A, B, C]));
}
const T0 = 1_000_000;
const read = (p, acc = 5) => ({ lat: p.lat, lng: p.lng, acc });

test("geometry: distances, bearings and projection", () => {
  const d = haversine(pos(0), pos(1000));
  assert.ok(Math.abs(d - 1000) < 1, `1 km north is ${d} m`);
  assert.ok(Math.abs(bearing(A, B) - 0) < 0.5, "north is 0 degrees");
  assert.ok(Math.abs(bearing(B, C) - 270) < 0.5, "west is 270 degrees");
  const line = lineOf([A, B, C]);
  assert.ok(Math.abs(line.total - 200) < 1.5, `route is ${line.total} m`);
  const p = project(pos(50, 10), line);
  assert.ok(Math.abs(p.off - 10) < 0.5, `10 m east of the walk: ${p.off}`);
  assert.ok(Math.abs(p.along - 50) < 0.5, `50 m along: ${p.along}`);
  const px = toPx(B, C);
  const back = fromPx(px, C);
  assert.ok(haversine(back, B) < 0.01, "map frame round-trips");
});

test("the line: straight beyond 100 m, the bend slides down to the dot", () => {
  assert.equal(lineForDistance(150).state, "straight");
  assert.equal(lineForDistance(150).stem, "scaleY(1)");
  assert.equal(lineForDistance(100).stem, "scaleY(0.676)", "the prototype's soon stem");
  const soon = lineForDistance(60);
  assert.equal(soon.state, "soon");
  assert.ok(soon.bendY > 0 && soon.bendY < 170);
  const here = lineForDistance(10);
  assert.equal(here.state, "here");
  assert.equal(here.bendY, 170);
  assert.equal(here.stem, "scaleY(0.216)", "the prototype's here stem");
});

test("sunset: Accra in late October, from the coordinates (suncalc, the library the page loads)", () => {
  const t = getTimes(new Date("2026-10-29T12:00:00Z"), 5.6, -0.2);
  const sunsetUtc = t.sunset.getUTCHours() + t.sunset.getUTCMinutes() / 60;
  assert.ok(sunsetUtc > 17.4 && sunsetUtc < 18.4, `sunset ${sunsetUtc} UTC`);
  assert.equal(isNightAt(5.6, -0.2, new Date("2026-10-29T12:00:00Z"), getTimes), false, "noon is day");
  assert.equal(isNightAt(5.6, -0.2, new Date("2026-10-29T22:00:00Z"), getTimes), true, "ten at night is night");
  assert.equal(isNightAt(5.6, -0.2, new Date("2026-10-29T05:00:00Z"), getTimes), true, "before sunrise is night");
  assert.equal(isNightAt(5.6, -0.2, new Date(), undefined), null, "no suncalc: no opinion, the phone's setting decides");
  assert.equal(isNightAt(89.9, 0, new Date("2026-06-21T12:00:00Z"), getTimes), null, "a polar day has no sunset: no opinion");
});

test("the map: one colour per token, the same as the stylesheet's, in both themes", () => {
  const css = readFileSync(new URL("../src/pages/directions.css", import.meta.url), "utf8");
  const block = (sel) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (expr) => { // color-mix(in srgb, #a N%, #b)
    const m = /color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)/.exec(expr);
    const a = hex(m[1]), b = hex(m[3]), k = Number(m[2]) / 100;
    return a.map((v, i) => Math.round(v * k + b[i] * (1 - k)));
  };
  const VARS = { land: "--map-land", road: "--map-road", casing: "--map-casing", label: "--map-label", water: "--map-water", park: "--map-park", route: "--route" };
  for (const [theme, sel] of [["paper", ":root, .paper {"], ["night", ".night {"]]) {
    const b = block(sel);
    for (const [key, v] of Object.entries(VARS)) {
      const val = new RegExp(`${v}: ([^;]+);`).exec(b)[1].trim();
      const want = val.startsWith("#") ? hex(val) : mix(val);
      const got = hex(MAP_THEMES[theme][key]);
      assert.ok(got.every((c, i) => Math.abs(c - want[i]) <= 1), `${theme} ${key}: map ${MAP_THEMES[theme][key]} vs css ${val}`);
    }
  }
  const style = mapStyle("night", 5.56, { route: [[0, 0], [0, 0.001]] });
  for (const [id, prop, key] of MAP_PAINT) assert.equal(style.layers.find((l) => l.id === id).paint[prop], MAP_THEMES.night[key], id);
  assert.deepEqual(Object.keys(style).sort(), ["layers", "name", "sources", "version"], "no tiles, no glyphs, no sprite: nothing fetched");
  assert.ok(Object.values(style.sources).every((s) => s.type === "geojson"));
  // Streets keep their width on the ground: twice the zoom-level, twice the pixels.
  const w = metresWide(10, 0);
  assert.ok(Math.abs(w[6] / w[4] - 2 ** 12) < 1e-6);
});

test("escort: direction is unknown, then confirmed after the walk starts", () => {
  const e = engine();
  let v = e.feed(read(A), T0);
  assert.equal(v.state, "unknown", "just started: a faint dotted line, never a bearing");
  for (let n = 1; n <= 10; n++) v = e.feed(read(pos(n, 0)), T0 + n * 1000);
  assert.equal(v.state, "confirmed", "after about 10 m the way is confirmed");
  v = e.view(T0 + 16000);
  assert.equal(v.state, "straight", "the confirmation shows for a few seconds only");
});

test("escort: soon before the turn, here at it, and the step advances", () => {
  let v;
  const e2 = engine();
  for (let n = 0; n <= 60; n++) v = e2.feed(read(pos(n, 0)), T0 + n * 1000);
  assert.equal(v.state, "soon", "51 m from the turn");
  assert.ok(Math.abs(v.dNext - 51) < 3, `dNext ${v.dNext}`);
  assert.equal(v.stepNo, 0);
  const e3 = engine();
  const events = [];
  for (let n = 0; n <= 92; n++) {
    v = e3.feed(read(pos(n, 0)), T0 + n * 1000);
    if (v.buzz || v.speak) events.push({ n, buzz: v.buzz, speak: v.speak });
  }
  assert.equal(v.state, "here", "inside 20 m of the turn");
  assert.equal(v.stepNo, 1, "the next step is current");
  assert.equal(v.hereStep, 0);
  assert.deepEqual(events.filter((x) => x.speak === "Left here.").map((x) => x.n), [92], "spoken at the turn (the smoothed position passes 20 m on reading 92)");
  assert.ok(events.some((x) => x.n === 92 && x.buzz === true), "buzz at the same moment");
  assert.notEqual(e3.view(T0 + 99000).state, "here", "here lasts a few seconds only");
});

test("escort: a straight-on step passes silently (no 'here' caption, no voice, no buzz)", () => {
  const t2 = trip();
  t2.steps[0] = { ...t2.steps[0], turn: "straight", instr: "Walk up Cantonments Rd" };
  const e = createEscort(t2, lineOf([A, B, C]));
  const out = [];
  for (let n = 0; n <= 100; n++) out.push(e.feed(read(pos(n, 0)), T0 + n * 1000));
  assert.equal(out.filter((v) => v.state === "here").length, 0, "no 'here' caption for a straight step");
  assert.equal(out.filter((v) => v.buzz).length, 0, "no buzz");
  assert.equal(out.filter((v) => v.speak).length, 0, "no voice");
  assert.equal(out.at(-1).stepNo, 1, "the walk still moves on to the next step");
});

test("escort: a turn is announced about 30 m out, once", () => {
  const e = engine();
  const said = [];
  for (let n = 0; n <= 85; n++) {
    const v = e.feed(read(pos(n, 0)), T0 + n * 1000);
    if (v.speak) said.push([n, v.speak]);
  }
  assert.equal(said.length, 1, `said ${JSON.stringify(said)}`);
  assert.ok(said[0][0] >= 79 && said[0][0] <= 82, "about 30 m before the turn");
  assert.match(said[0][1], /in about thirty metres/);
});

test("escort: three readings off the route ask for one reroute; noise is ignored", () => {
  const e = engine();
  for (let n = 0; n <= 20; n++) e.feed(read(pos(n, 0)), T0 + n * 1000);
  const flags = [];
  for (let k = 0; k < 8; k++) flags.push(e.feed(read(pos(25 + k, 60)), T0 + (21 + k) * 1000).reroute);
  assert.equal(flags.filter(Boolean).length, 1, "one reroute request, not one per reading");
  assert.ok(flags.indexOf(true) >= 3, "smoothing means the third good off-route reading is the earliest");
  // A poor reading changes nothing.
  const before = e.view(T0 + 26000).state;
  const after = e.feed({ lat: 0, lng: 0, acc: 90 }, T0 + 26500).state;
  assert.equal(after, before);
});

test("escort: a reroute that comes back replaces the line and clears the wait", () => {
  const e = engine();
  for (let n = 0; n <= 20; n++) e.feed(read(pos(n, 0)), T0 + n * 1000);
  for (let k = 0; k < 8; k++) e.feed(read(pos(25 + k, 60)), T0 + (21 + k) * 1000);
  assert.equal(e.view(T0 + 29000).state, "reroute", "the page says: no worries, here's a new way");
  const newLine = lineOf([pos(25, 60), pos(111, 60), C]);
  e.replaceRoute({ ...trip(), destination: C }, newLine, pos(33, 60), T0 + 29000);
  assert.equal(e.view(T0 + 30000).state, "reroute", "the new bend shows for a few seconds");
});

test("escort: signal lost keeps the line, and finding you needs no good reading for 15 s", () => {
  const e = engine();
  assert.equal(e.view(T0).state, "finding", "no fix yet: no line, no dot");
  e.feed(read(A), T0);
  e.feed({ lat: 0, lng: 0, acc: 80 }, T0 + 1000);
  assert.equal(e.view(T0 + 16000).state, "finding", "no good reading for 15 s");
  e.setOffline(true);
  e.feed(read(pos(1)), T0 + 17000);
  assert.equal(e.view(T0 + 17000).state, "lost", "lost signal, the route is still known");
  e.setOffline(false);
});

test("escort: a wrong way is noticed after two legs", () => {
  const e = engine();
  let v;
  for (let n = 0; n >= -30; n--) v = e.feed(read(pos(n, 0)), T0 + -n * 1000);
  assert.equal(v.state, "around", "other way, turn around");
});

test("escort: standing still for 45 s is waiting, then moving resumes", () => {
  const e = engine();
  for (let n = 0; n <= 10; n++) e.feed(read(pos(n, 0)), T0 + n * 1000);
  let v;
  for (let s = 1; s <= 50; s++) v = e.feed(read(pos(10, 0)), T0 + 10000 + s * 1000);
  assert.equal(v.state, "wait");
  assert.equal(v.status, "WAITING");
  for (let k = 0; k < 3; k++) v = e.feed(read(pos(22, 0)), T0 + 61000 + k * 1000);
  assert.notEqual(v.state, "wait", "moving again");
});

test("escort: arriving confirms on three readings inside 15 m and ends the escort", () => {
  const e = engine();
  for (let n = 0; n <= 111; n += 1) e.feed(read(pos(n, 0)), T0 + n * 1000);
  let v;
  for (let k = 0; k <= 89; k += 1) v = e.feed(read(pos(111, -k)), T0 + (112 + k) * 1000);
  for (let k = 0; k < 3; k++) v = e.feed(read(pos(111, -89)), T0 + (202 + k) * 1000);
  assert.equal(v.state, "arrived");
  assert.equal(v.ended, true);
  assert.equal(v.status, "ESCORT ENDED");
});

test("escort: a phone standing at the gate that sends no new reading still arrives, after 3 s", () => {
  const e = engine();
  for (let n = 0; n <= 111; n += 1) e.feed(read(pos(n, 0)), T0 + n * 1000);
  for (let k = 0; k <= 70; k += 1) e.feed(read(pos(111, -k)), T0 + (112 + k) * 1000);
  const t = T0 + 194000;
  e.feed(read(pos(111, -88)), t);
  assert.notEqual(e.view(t + 1500).state, "arrived", "not on one reading at once");
  assert.equal(e.view(t + 3200).state, "arrived");
  // Inside the gate on one reading, then walked back out: no arrival.
  const f = engine();
  for (let n = 0; n <= 111; n += 1) f.feed(read(pos(n, 0)), T0 + n * 1000);
  for (let k = 0; k <= 70; k += 1) f.feed(read(pos(111, -k)), T0 + (112 + k) * 1000);
  f.feed(read(pos(111, -88)), t);
  f.feed(read(pos(111, -60)), t + 1000);
  assert.notEqual(f.view(t + 4000).state, "arrived");
});

test("escort: a brisk walk is not taken for a GPS jump (readings are judged against each other, not the trailing dot)", () => {
  const e = engine();
  let v;
  for (let n = 0; n <= 100; n += 25) v = e.feed(read(pos(n, 0)), T0 + n * 40);
  assert.ok(v.user && haversine(v.user, pos(75)) < 20, "every 25 m reading was taken");
  // A real jump (a tall-building reflection, 150 m in a second) is still held off.
  const before = e.view(T0 + 4100).user;
  e.feed(read(pos(100, 150)), T0 + 4100);
  assert.ok(haversine(e.view(T0 + 4200).user, before) < 1, "the jump is ignored");
});

test("escort: walking up to the gate and stopping arrives, though the smoothed dot is still behind", () => {
  const e = engine();
  for (let n = 0; n <= 111; n += 1) e.feed(read(pos(n, 0)), T0 + n * 1000);
  for (let k = 0; k <= 60; k += 10) e.feed(read(pos(111, -k)), T0 + (112 + k) * 1000);
  const t = T0 + 180000;
  e.feed(read(pos(111, -88)), t);           // the last reading, sharp, at the gate; the dot averages 20 m behind
  assert.equal(e.view(t + 3200).state, "arrived");
  // A blurry reading at the gate is not enough on its own.
  const f = engine();
  for (let n = 0; n <= 111; n += 1) f.feed(read(pos(n, 0)), T0 + n * 1000);
  for (let k = 0; k <= 60; k += 10) f.feed(read(pos(111, -k)), T0 + (112 + k) * 1000);
  f.feed(read(pos(111, -88), 30), t);
  assert.notEqual(f.view(t + 3200).state, "arrived");
});

test("escort: an early arrival says so", () => {
  const t = trip();
  t.startsAt = T0 + 3600 * 1000;
  const e = createEscort(t, lineOf([A, B, C]));
  for (let k = 0; k < 3; k++) e.feed(read(C), T0 + k * 1000);
  assert.equal(e.view(T0 + 3000).state, "early");
});

test("the page: the sample route on a server with Reason's flag on", async () => {
  const config = { directionsOn: true, directionsSample: true, directionsRouting: "" };
  const out = await directionsRequest({ method: "GET", pathname: "/d/sample", config });
  assert.equal(out.status, 200);
  assert.match(out.headers["Content-Security-Policy"], /default-src 'self'/);
  assert.equal(out.headers["X-Robots-Tag"], "noindex, nofollow");
  assert.match(out.body, /<main id="app" class="screen paper">/);
  assert.match(out.body, /<script id="trip" type="application\/json">/);
  assert.match(out.body, /src="\/d\/app\.js"/);
  assert.match(out.headers["Content-Security-Policy"], /worker-src 'self' blob:/, "MapLibre's worker, from this server");
  assert.doesNotMatch(out.headers["Content-Security-Policy"], /https?:/, "nothing from anywhere else");
  assert.match(out.body, /The Garden Room/);
  assert.doesNotMatch(out.body, /AIza|api[_-]?key|access_token|pk\.eyJ|routing\.example/i, "no key in the page");
  const trip = JSON.parse(out.body.match(/<script id="trip" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(trip.steps.length, 5);
  assert.ok(trip.route.length >= 4 && typeof trip.route[0].lat === "number");
  assert.ok(trip.steps.every((s) => typeof s.lat === "number" && typeof s.lng === "number"));
  assert.ok(trip.map.major.length >= 2 && trip.map.minor.length >= 5 && trip.map.parks.length >= 1, "the streets are in the page");
  assert.ok(Number.isFinite(trip.startsAt), "the sample event has a start, for early or on time");
});

test("the libraries: MapLibre and suncalc come from this server, and nothing else under /d/vendor/", async () => {
  const config = { directionsOn: true, directionsSample: true };
  for (const [p, type] of [["/d/vendor/maplibre-gl.mjs", /javascript/], ["/d/vendor/maplibre-gl-worker.mjs", /javascript/], ["/d/vendor/maplibre-gl.css", /css/], ["/d/vendor/suncalc.js", /javascript/]]) {
    const out = await directionsRequest({ method: "GET", pathname: p, config });
    assert.equal(out.status, 200, p);
    assert.match(out.headers["Content-Type"], type, p);
    assert.ok(out.body.length > 1000, p);
  }
  for (const p of ["/d/vendor/../package.json", "/d/vendor/zod", "/d/vendor/constructor"]) {
    assert.equal(await directionsRequest({ method: "GET", pathname: p, config }), null, p);
  }
  const off = await directionsRequest({ method: "GET", pathname: "/d/vendor/suncalc.js", config: { directionsOn: false } });
  assert.equal(off, null, "off with the flag");
});

test("the script: served, and nothing asks for location on load", async () => {
  const config = { directionsOn: true, directionsSample: true };
  const js = await directionsRequest({ method: "GET", pathname: "/d/app.js", config });
  assert.equal(js.status, 200);
  assert.match(js.headers["Content-Type"], /javascript/);
  assert.equal((js.body.match(/watchPosition\(/g) || []).length, 1, "one watch, inside startLive");
  assert.equal((js.body.match(/getCurrentPosition\(/g) || []).length, 0);
  assert.equal((js.body.match(/DeviceOrientationEvent\.requestPermission\(\)/g) || []).length, 1, "orientation asked only in the tap");
});

test("the look: reduced motion is honoured in the stylesheet", async () => {
  const config = { directionsOn: true, directionsSample: true };
  const out = await directionsRequest({ method: "GET", pathname: "/d/sample", config });
  assert.match(out.body, /prefers-reduced-motion: reduce/);
  assert.match(out.body, /--stamp: #9c3b2e/, "brick red from the design tokens");
  assert.match(out.body, /--bg: #1c1814/, "night from the design tokens");
});

test("off by default: no /d/ path answers while the flag is off", async () => {
  const config = { directionsOn: false, directionsSample: true, directionsRouting: "" };
  for (const p of ["/d/sample", "/d/app.js", "/d/sample/reroute", "/d/fonts/serif.woff2"]) {
    assert.equal(await directionsRequest({ method: p.endsWith("reroute") ? "POST" : "GET", pathname: p, config }), null, p);
  }
});

test("the sample is off unless its own flag is on", async () => {
  const config = { directionsOn: true, directionsSample: false };
  assert.equal(await directionsRequest({ method: "GET", pathname: "/d/sample", config }), null);
});

test("reroute: no routing URL, no reroute (503), and the page keeps its route", async () => {
  const out = await reroute(sampleTrip(), { lat: 5.557, lng: -0.186 }, { routingUrl: "" });
  assert.equal(out.status, 503);
});

test("reroute: the routing service's walk becomes the page's route and steps", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        routes: [{
          geometry: { coordinates: [[-0.186, 5.557], [-0.1865, 5.5571]] },
          legs: [{ steps: [
            { name: "", distance: 40, maneuver: { type: "depart", modifier: "straight", location: [-0.186, 5.557] } },
            { name: "Oxford Street", distance: 80, maneuver: { type: "turn", modifier: "left", location: [-0.1862, 5.5566] } },
            { name: "", distance: 0, maneuver: { type: "arrive", location: [-0.1865, 5.5571] } },
          ] }],
        }],
      }),
    };
  };
  const out = await reroute(sampleTrip(), { lat: 5.557, lng: -0.186 }, { routingUrl: "https://routes.example.test/", fetchImpl });
  assert.equal(out.status, 200);
  assert.match(calls[0], /route\/v1\/foot\/-0\.186,5\.557;-0\.1865,5\.5571\?/);
  assert.equal(out.body.route.length, 2);
  assert.equal(out.body.steps[1].turn, "left");
  assert.equal(out.body.steps[1].instr, "Turn left on Oxford Street");
  assert.equal(out.body.steps[0].street, "THE WAY AHEAD", "an unnamed way is described, never blank");
  assert.match(out.body.steps[0].mark, /in front of you/);
});

test("reroute: a bad position is refused before anything is asked of the router", async () => {
  const config = { directionsOn: true, directionsSample: true, directionsRouting: "https://routes.example.test" };
  const out = await directionsRequest({ method: "POST", pathname: "/d/sample/reroute", req: Readable.from([Buffer.from('{"lat":"north","lng":0}')]), config });
  assert.equal(out.status, 400);
});

test("the page builder escapes the trip's own text", () => {
  const t = sampleTrip();
  t.name = "Room </script><b>x</b>";
  const html = directionsPage(t);
  assert.equal((html.match(/<\/script>/g) || []).length, 2, "only the page's own script tags close");
});

