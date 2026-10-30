// The directions page's contract: the payload shape, the page's markup and CSP, the static files it
// loads, the no-location-on-load rule (checked in the client source), and that the map's colours
// match the stylesheet's tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDirectionsPayload, MAX_PAYLOAD_BYTES } from "../src/directions/payload.js";
import { directionsPage, directionsAsset, DIRECTIONS_CSP, DIRECTIONS_HEADERS, embedJson } from "../src/directions/page.js";
import { mapStyle, THEMES } from "../src/directions/tokens.js";
import { gardenRoomPayload } from "./fixtures/directions-garden-room.js";

const clone = () => structuredClone(gardenRoomPayload());
const app = readFileSync(new URL("../src/directions/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/directions/directions.css", import.meta.url), "utf8");

test("payload: the sample trip parses and keeps its demo flag", () => {
  const p = parseDirectionsPayload(gardenRoomPayload());
  assert.equal(p.demo, true);
  assert.equal(p.steps.length, 5);
  assert.equal(p.steps.at(-1).turn, "arrive");
});

test("payload: a real payload is not a demo unless it says so", () => {
  const p = clone();
  delete p.demo;
  assert.equal(parseDirectionsPayload(p).demo, false);
});

test("payload: unknown keys are refused, not carried into the page", () => {
  const p = clone();
  p.routingKey = "pk.not-allowed";
  assert.throws(() => parseDirectionsPayload(p), /routingKey|unrecognized/i);
});

test("payload: the last step must be the arrival, and there must be exactly one", () => {
  const p = clone();
  p.steps.at(-1).turn = "left";
  assert.throws(() => parseDirectionsPayload(p), /last step must be the arrival|arrival/);
});

test("payload: the reroute address is a same-origin path only, never a URL on another host", () => {
  const p = clone();
  p.rerouteUrl = "https://example.com/reroute";
  assert.throws(() => parseDirectionsPayload(p), /rerouteUrl/);
  const q = clone();
  q.rerouteUrl = "/directions/x/reroute";
  assert.equal(parseDirectionsPayload(q).rerouteUrl, "/directions/x/reroute");
});

test("payload: coordinates out of range are refused", () => {
  const p = clone();
  p.destination.lat = 95;
  assert.throws(() => parseDirectionsPayload(p), /destination\.lat/);
});

test("payload: a payload too big to embed is refused with a readable message", () => {
  const p = clone();
  const line = Array.from({ length: 300 }, (_, i) => [-0.18 + i * 1e-5, 5.55 + i * 1e-6]);
  p.roads.minor = Array.from({ length: 1200 }, () => line);
  assert.ok(JSON.stringify(p).length > MAX_PAYLOAD_BYTES);
  assert.throws(() => parseDirectionsPayload(p), /over the .* limit/);
});

test("page: one module script, one data block, no inline script", () => {
  const html = directionsPage(gardenRoomPayload());
  const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(tags.length, 2);
  assert.ok(tags.some((a) => /type="module" src="\/directions\/app\.js"/.test(a)));
  assert.ok(tags.some((a) => /id="directions-data" type="application\/json"/.test(a)));
  assert.doesNotMatch(html, /<script>/);
});

test("page: the route JSON cannot close its own script tag", () => {
  const p = clone();
  p.destination.name = "</script><img src=x onerror=alert(1)>";
  const html = directionsPage(p);
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /\\u003c\/script/);
});

test("page: the title and the no-JS summary escape the destination", () => {
  const p = clone();
  p.destination.name = `<b>"Garden" & co</b>`;
  const html = directionsPage(p);
  assert.match(html, /<title>&lt;b&gt;&quot;Garden&quot; &amp; co&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<title>[^<]*<b>/);
});

test("page: no routing or map key, and no third-party host, appears in the markup", () => {
  const html = directionsPage(gardenRoomPayload());
  assert.doesNotMatch(html, /\bpk\.eyJ|AIza[0-9A-Za-z_-]{20}|api[_-]?key|access_token/i);
  assert.doesNotMatch(html, /(src|href)="https?:\/\//, "the page links out only through the map apps' own links, added by the client");
});

test("page: the locked-down CSP and the no-referrer header", () => {
  assert.match(DIRECTIONS_CSP, /script-src 'self'(;|$)/);
  assert.doesNotMatch(DIRECTIONS_CSP, /script-src[^;]*unsafe-inline/);
  assert.match(DIRECTIONS_CSP, /frame-ancestors 'none'/);
  assert.equal(DIRECTIONS_HEADERS["Referrer-Policy"], "no-referrer");
  assert.equal(DIRECTIONS_HEADERS["Cache-Control"], "no-store");
});

test("page: embedJson escapes angle brackets and ampersands", () => {
  assert.equal(embedJson({ a: "<&>" }), '{"a":"\\u003c\\u0026\\u003e"}');
});

test("assets: every file the page names is served, and unknown paths fall through", () => {
  const js = directionsAsset("/directions/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers["Content-Type"], /javascript/);
  assert.equal(directionsAsset("/directions/logic.js").status, 200);
  assert.equal(directionsAsset("/directions/vendor/maplibre-gl.mjs").status, 200);
  assert.ok(directionsAsset("/directions/vendor/maplibre-gl.mjs").body.length > 500_000);
  assert.equal(directionsAsset("/directions/vendor/suncalc.js").status, 200);
  assert.equal(directionsAsset("/directions/fonts/inter.woff2").headers["Content-Type"], "font/woff2");
  assert.equal(directionsAsset("/directions/not-a-file.js"), null);
  assert.equal(directionsAsset("/p/anything"), null);
});

test("client: one place asks for location, and it is the watch the Share tap starts", () => {
  const calls = app.match(/watchPosition\(/g) ?? [];
  assert.equal(calls.length, 1, "exactly one watchPosition call in the client");
  const fn = app.slice(app.indexOf("function startWatch()"), app.indexOf("function pauseWatch()"));
  assert.match(fn, /watchPosition\(/);
  // Nothing starts the watch at module load: the last top-level call is the router.
  assert.match(app.trimEnd(), /\ngo\(\);$/);
});

test("client: the compass permission is asked inside the same tap as location", () => {
  const share = app.slice(app.indexOf("function shareLocation()"), app.indexOf("function startWatch()"));
  assert.match(share, /beginWatch\(\)/);
  const begin = app.slice(app.indexOf("function beginWatch()"), app.indexOf("/** A reload mid-escort"));
  assert.ok(begin.indexOf("requestPermission") < begin.indexOf("startWatch()"), "permission asked before the watch starts, both in the tap");
});

test("client: each platform feature is detected and degrades silently", () => {
  for (const feature of ["\"wakeLock\" in navigator", "\"speechSynthesis\" in window", "navigator.vibrate", "\"geolocation\" in navigator"]) {
    assert.ok(app.includes(feature), `feature check present: ${feature}`);
  }
  assert.match(app, /prefers-reduced-motion/);
});

test("client: the reroute goes to the backend's path, and no routing service is named in the client", () => {
  assert.match(app, /fetch\(TRIP\.rerouteUrl/);
  assert.doesNotMatch(app, /mapbox|api\.mapbox|router\.project-osrm|maps\.googleapis/i);
});

test("tokens: the map colours are the stylesheet's colours, both themes", () => {
  const block = (sel) => {
    const start = css.indexOf(sel);
    assert.ok(start >= 0, `block ${sel}`);
    return css.slice(start, css.indexOf("}", start));
  };
  const vars = (text) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const paper = vars(block(":root, .paper {"));
  const night = vars(block(".night {"));
  const pairs = [["bg", "bg"], ["text", "text"], ["stamp", "stamp"], ["border", "border"], ["mapLand", "map-land"], ["mapRoad", "map-road"], ["mapCasing", "map-casing"], ["mapLabel", "map-label"], ["route", "route"], ["dot", "dot"], ["dotRing", "dot-ring"]];
  for (const [key, cssName] of pairs) {
    assert.equal(THEMES.paper[key].toLowerCase(), paper[cssName].toLowerCase(), `paper ${key}`);
    assert.equal(THEMES.night[key].toLowerCase(), night[cssName].toLowerCase(), `night ${key}`);
  }
});

test("tokens: the map style has the layers and sources the client writes to", () => {
  for (const theme of ["paper", "night"]) {
    const style = mapStyle(theme);
    const ids = style.layers.map((l) => l.id);
    for (const id of ["land", "roads-minor", "roads-major", "route", "dot", "dest-ring", "done"]) assert.ok(ids.includes(id), `${theme} layer ${id}`);
    for (const id of ["roads", "route", "done", "dest", "dot"]) assert.ok(style.sources[id], `${theme} source ${id}`);
    assert.ok(!JSON.stringify(style).includes("http"), "no tile or glyph URL in the style");
  }
});
