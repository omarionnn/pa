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

test("escort: the new-way note shows only once a new way has come back, and a failed ask says nothing", () => {
  const e = engine();
  for (let n = 0; n <= 20; n++) e.feed(read(pos(n, 0)), T0 + n * 1000);
  let asked = false;
  for (let k = 0; k < 8; k++) asked = e.feed(read(pos(25 + k, 60)), T0 + (21 + k) * 1000).reroute || asked;
  assert.ok(asked);
  assert.notEqual(e.view(T0 + 29000).state, "reroute", "no 'here's a new way' while there is none yet");
  e.rerouteFailed();
  assert.notEqual(e.view(T0 + 29500).state, "reroute", "a failed ask: the old line stays, nothing claimed");
  const newLine = lineOf([pos(33, 60), pos(111, 60), C]);
  e.replaceRoute({ ...trip(), destination: C }, newLine, pos(33, 60), T0 + 30000);
  assert.equal(e.view(T0 + 31000).state, "reroute", "the new way: no worries, here's a new way");
  assert.notEqual(e.view(T0 + 37000).state, "reroute", "for a few seconds only");
});

test("escort: signal lost keeps the line; a turn is never hidden behind a note about the phone", () => {
  const e = engine();
  assert.equal(e.view(T0).state, "finding", "no fix yet: no line, no dot");
  e.feed(read(A), T0);
  e.feed({ lat: 0, lng: 0, acc: 80 }, T0 + 1000);
  assert.notEqual(e.view(T0 + 16000).state, "finding", "a still phone that sends nothing for 15 s is not lost");
  assert.equal(e.view(T0 + 61000).state, "finding", "nothing good for a minute: finding you");
  // A longer first leg: 300 m north, then the left.
  const far = pos(300), end = pos(300, -89);
  const f = createEscort({ destination: end, steps: [{ turn: "left", lat: far.lat, lng: far.lng, fact: "AT THE LIGHTS", street: "OXFORD ST" }, { turn: "right", lat: end.lat, lng: end.lng, fact: "THE GATE", street: "OXFORD ST" }] }, lineOf([A, far, end]));
  for (let n = 0; n <= 30; n++) f.feed(read(pos(n, 0)), T0 + n * 1000);
  f.setOffline(true);
  f.feed(read(pos(31)), T0 + 40000);
  assert.equal(f.view(T0 + 40000).state, "lost", "lost signal, the route is still known");
  f.notifyBattery(T0 + 40000);
  for (let n = 32; n <= 240; n += 2) f.feed(read(pos(n, 0)), T0 + 40000 + n * 500);
  assert.equal(f.view(T0 + 160000).state, "soon", "60 m from the left: the turn, not the signal or battery note");
  f.setOffline(false);
});

test("escort: a street one block over never sets off the turn, and END ESCORT claims no arrival", () => {
  const e = engine();
  for (let n = 0; n <= 60; n += 2) e.feed(read(pos(n, 35), 15), T0 + n * 1000);
  const v = e.feed(read(pos(112, 35), 15), T0 + 62000);
  assert.notEqual(v.state, "here");
  assert.equal(v.speak, null, "no 'Left here.' at the wrong corner");
  e.end();
  const w = e.view(T0 + 63000);
  assert.equal(w.state, "ended");
  assert.equal(w.status, "ESCORT ENDED");
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


// ---------- told to turn around, and walking on anyway (Omari's walk, 10-30) ----------
test("escort: 'turn around' is not insisted on: walking on 40 m (or 20 s) gives a calm new way from here, facing their way", () => {
  const e = engine();
  let v, said = [], asked = null;
  for (let n = 0; n >= -120; n--) {
    v = e.feed(read(pos(n, 0)), T0 + -n * 1000);
    if (v.speak) said.push(v.speak);
    if (v.reroute && !asked) asked = { at: n, forward: v.forward, heading: v.heading, state: v.state };
  }
  assert.ok(asked, "a new way was asked for");
  assert.equal(asked.forward, true, "facing the way they walk");
  assert.ok(Math.abs(client.angleDiff(asked.heading, 180)) < 20, `heading south, got ${asked.heading}`);
  assert.equal(asked.state, "fromhere");
  assert.equal(said.filter((x) => /new way from here/.test(x)).length, 1, "said once: " + JSON.stringify(said));
  // Nothing comes back yet: the caption is the calm line, not "turn around".
  assert.equal(v.state, "fromhere");
  // The new way comes back from where they are: "Okay, new way from here.", and no "turn around" for a minute.
  const here = pos(-120, 0);
  const newLine = client.lineOf([here, pos(-120, 60), pos(-180, 60)]);
  e.replaceRoute({ ...trip(), steps: [{ ...here, instr: "Head south", turn: "straight", street: "X", fact: "" }, { ...pos(-180, 60), instr: "There", turn: "straight", street: "P", fact: "" }] }, newLine, here, T0 + 121000);
  const w = e.view(T0 + 121500);
  assert.equal(w.state, "reroute");
  assert.equal(w.fromHere, true);
});

/** Walk south from the start (the route goes north) until the escort gives up and asks; returns the engine. */
function walkedOn() {
  const e = engine();
  let v, n = 0;
  for (; n >= -120; n--) { v = e.feed(read(pos(n, 0)), T0 + -n * 1000); if (v.reroute) break; }
  assert.equal(v.forward, true);
  return { e, n, t: T0 + -n * 1000 };
}
const turnBack = (n) => ({ trip: { ...trip(), steps: [{ ...pos(n, 0), instr: "Head north", turn: "straight", street: "X", fact: "" }, { ...C, instr: "There", turn: "straight", street: "P", fact: "" }] }, line: client.lineOf([pos(n, 0), A, B, C]) });

test("escort: if the only reasonable way turns back, it says so honestly: no 'new way from here', and 'turn around' may show again", () => {
  const { e, n, t } = walkedOn();
  const { trip: tb, line } = turnBack(n);
  e.replaceRoute(tb, line, pos(n, 0), t + 500, { forward: false });
  const w = e.view(t + 1000);
  assert.equal(w.state, "reroute");
  assert.notEqual(w.fromHere, true, "a way back is not called a new way from here");
  let v;
  for (let k = 1; k <= 30; k++) v = e.feed(read(pos(n - k, 0)), t + 7000 + k * 1000);
  assert.equal(v.state, "around", "still walking away from the only way: told plainly, at once");
});

test("escort: a way from here that cannot be had (router down) is asked twice, then the escort goes back to the usual check", () => {
  const { e, n, t } = walkedOn();
  e.rerouteFailed();
  let asks = 1, v;
  for (let k = 1; k <= 40; k++) { v = e.feed(read(pos(n - k, 0)), t + k * 1000); if (v.reroute) e.rerouteFailed(); if (v.reroute && v.forward) asks++; }
  assert.equal(asks, 2, "one retry, after the reroute gap");
  assert.notEqual(v.state, "fromhere", "never 'finding a way' for ever");
});

test("escort: an ordinary reroute already on its way when they give up does not count as the way from here; that is asked next", () => {
  const e = engine();
  let v, n = 0, ordinary = null;
  // Off to the side first (an ordinary off-route reroute, left in flight), then the wrong way.
  for (; n >= -120; n--) {
    v = e.feed(read(pos(n, 0)), T0 + -n * 1000);
    if (v.reroute && !v.forward && ordinary === null) ordinary = n;
    if (v.reroute && v.forward) break;
  }
  if (ordinary !== null) {
    // The ordinary one comes back while giving up: the calm line stays and the forward ask follows.
    const { trip: tb, line } = turnBack(n);
    e.replaceRoute(tb, line, pos(n, 0), T0 + -n * 1000 + 200, {});
    assert.equal(e.view(T0 + -n * 1000 + 300).fromHere, undefined);
  }
  assert.equal(v.forward, true, "the forward ask is made");
});

test("escort: turning back after 'turn around' is just walking on, with no new way asked", () => {
  const e = engine();
  let v, asked = 0;
  for (let n = 0; n >= -30; n--) { v = e.feed(read(pos(n, 0)), T0 + -n * 1000); if (v.reroute) asked++; }
  assert.equal(v.state, "around");
  for (let n = -29; n <= 10; n++) { v = e.feed(read(pos(n, 0)), T0 + 31000 + (n + 29) * 1000); if (v.reroute) asked++; }
  assert.notEqual(v.state, "around");
  assert.notEqual(v.state, "fromhere");
  assert.equal(asked, 0);
});

test("reroute with a heading: OSRM is asked for a way leaving that way (bearings) and one that may turn back; forward wins unless much longer", async () => {
  const urls = [];
  const route = (metres) => ({ ok: true, json: async () => ({ routes: [{ distance: metres, duration: metres / 1.3, geometry: { coordinates: [[-0.186, 5.557], [-0.1865, 5.5571]] }, legs: [{ steps: [
    { name: "", distance: metres, maneuver: { type: "depart", location: [-0.186, 5.557] } },
    { name: "", distance: 0, maneuver: { type: "arrive", location: [-0.1865, 5.5571] } },
  ] }] }] }) });
  const net = (fwd, back) => async (url) => { urls.push(url); return /bearings=/.test(url) ? route(fwd) : route(back); };
  let out = await reroute(sampleTrip(), { lat: 5.557, lng: -0.186 }, { routingUrl: "https://routes.example.test", fetchImpl: net(500, 420), heading: 183 });
  assert.equal(out.status, 200);
  assert.ok(urls.some((u) => /&bearings=183,60;&radiuses=40;$/.test(u)), urls.join(" "));
  const logs = [];
  out = await reroute(sampleTrip(), { lat: 5.557, lng: -0.186 }, { routingUrl: "https://routes.example.test", fetchImpl: net(500, 420), heading: 183, log: (l) => logs.push(l) });
  assert.deepEqual(logs.find((l) => l.directions === "reroute_forward"), { directions: "reroute_forward", kept_forward: true }, "a forward way 80 m longer is the way");
  logs.length = 0;
  await reroute(sampleTrip(), { lat: 5.557, lng: -0.186 }, { routingUrl: "https://routes.example.test", fetchImpl: net(2000, 420), heading: 183, log: (l) => logs.push(l) });
  assert.equal(logs.find((l) => l.directions === "reroute_forward").kept_forward, false, "a dead end ahead: turning back is the reasonable way");
  urls.length = 0;
  await reroute(sampleTrip(), { lat: 5.557, lng: -0.186 }, { routingUrl: "https://routes.example.test", fetchImpl: net(500, 420) });
  assert.equal(urls.length, 1);
  assert.doesNotMatch(urls[0], /bearings/, "an ordinary reroute asks once, with no heading");
});

test("the server takes a heading only as a number of degrees, and says whether the way it kept goes forward", async () => {
  const config = { directionsOn: true, directionsSample: true, directionsRouting: "https://routes.example.test" };
  const ask = async (heading) => {
    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => ({ routes: [{ distance: 300, duration: 240, geometry: { coordinates: [[-0.186, 5.557], [-0.1865, 5.5571]] }, legs: [{ steps: [{ name: "", distance: 300, maneuver: { type: "depart", location: [-0.186, 5.557] } }, { name: "", distance: 0, maneuver: { type: "arrive", location: [-0.1865, 5.5571] } }] }] }] }) }; };
    const res = await directionsRequest({ method: "POST", pathname: "/d/sample/reroute", req: Readable.from([Buffer.from(JSON.stringify({ lat: 5.557, lng: -0.186, heading }))]), config, fetchImpl });
    return { urls, body: JSON.parse(res.body) };
  };
  const a = await ask(-90);
  assert.ok(a.urls.some((u) => /bearings=270,60/.test(u)), a.urls.join(" "));
  assert.equal(a.body.forward, true);
  for (const bad of ["", " ", "90", true, false, null, [], {}]) {
    const b = await ask(bad);
    assert.equal(b.urls.length, 1, `${JSON.stringify(bad)} is no heading: one ordinary ask`);
    assert.doesNotMatch(b.urls[0], /bearings/);
    assert.equal(b.body.forward, undefined);
  }
});

test("layout on a phone: Escort is a column (status, stage, caption, MORE each in its own row); the choose screen flows and scrolls above Safari's bar", () => {
  const css = readFileSync(new URL("../src/pages/directions.css", import.meta.url), "utf8");
  for (const sel of [".caps", ".more-btn", ".esc-foot", ".stage", ".esc-status"]) {
    const rule = css.match(new RegExp(`\\n${sel.replace(".", "\\.")} \\{([^}]*)\\}`));
    assert.ok(rule, sel);
    assert.doesNotMatch(rule[1], /position:\s*absolute/, `${sel} is in the flow, not pinned on top of another row`);
  }
  assert.match(css, /\.esc \{[^}]*flex-direction: column[^}]*safe-area-inset-bottom/);
  assert.match(css, /\.flow \{[^}]*overflow-y: auto[^}]*safe-area-inset-bottom/);
  assert.match(css, /@keyframes pulse \{ 0% \{ transform: translate\(-50%, -50%\)/, "the ring scales about the dot's centre");
  assert.match(css, /\.sheet \{[^}]*safe-area-inset-bottom/);
});
