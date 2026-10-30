// The walking directions page: /d/<id> (the page), /d/<id>/reroute (a new way, from the phone's position),
// /d/app.js (the page's script), /d/fonts/<name>.woff2 (Reason's own faces). Built from the handoff in
// PROMPT.md; the script is src/pages/directionsclient.js and the look is src/pages/directions.css
// (Reason's design system, copied from the handoff's reason.css).
//
// Off unless REASON_DIRECTIONS is on (config.directionsOn): every /d/ path then answers nothing, so the
// route falls through to the normal not-found page. REASON_DIRECTIONS_SAMPLE serves the sample trip below
// (made-up data, the handoff's Garden Room) so the page runs end to end locally. A real trip is made once
// by Reason, with its routing key, and stored; that hookup is not wired here (see the PR).
//
// The routing key is never in the page: the reroute goes through this server, which calls the routing
// service at REASON_DIRECTIONS_ROUTING_URL (an OSRM-compatible foot router) and returns only the route.
import { readFileSync } from "node:fs";
import { webFont } from "./webkit.js";
import { fromPx, haversine } from "./directionsclient.js";

const CSS = readFileSync(new URL("./directions.css", import.meta.url), "utf8");
const SCRIPT = readFileSync(new URL("./directionsclient.js", import.meta.url), "utf8");

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// ---------- the sample trip (made-up data: The Garden Room, Osu) ----------
const SAMPLE_DEST = { lat: 5.5571, lng: -0.1865 };
const SAMPLE_ROUTE_PX = [{ x: 320, y: 365 }, { x: 320, y: 260 }, { x: 150, y: 260 }, { x: 150, y: 72 }, { x: 170, y: 72 }];
const SAMPLE_STEPS = [
  { n: "01", instr: "Walk up Cantonments Rd", turn: "straight", street: "CANTONMENTS RD", fact: "PAST THE PETROL STATION", mark: "Past the petrol station on your right.", d: "200 m", px: { x: 320, y: 312 } },
  { n: "02", instr: "Turn left on Oxford St", turn: "left", street: "OXFORD ST", fact: "AT THE TRAFFIC LIGHTS", mark: "At the traffic lights.", d: "350 m", px: { x: 320, y: 260 }, into: "INTO OXFORD ST" },
  { n: "03", instr: "Take the second right", turn: "right", street: "OXFORD ST", fact: "AFTER THE PHARMACY", mark: "Just after the pharmacy. The lane has no name.", d: "120 m", px: { x: 150, y: 260 }, into: "INTO THE LANE" },
  { n: "04", instr: "Roundabout: second exit", turn: "roundabout", street: "THE ROUNDABOUT", fact: "ACROSS FROM THE PARK", mark: "Straight across, toward the park.", d: "180 m", px: { x: 150, y: 135 } },
  { n: "05", instr: "The Garden Room, on your right", turn: "right", street: "THE GARDEN ROOM", fact: "THE GREEN GATE", mark: "Green gate, next to the tailor’s shop.", d: "60 m", px: { x: 170, y: 72 } },
];

/** The sample trip, shaped as the page reads it. Every field is what Reason would fill in for a real trip. */
export function sampleTrip() {
  const destination = SAMPLE_DEST;
  const route = SAMPLE_ROUTE_PX.map((p) => roundLatLng(fromPx(p, destination)));
  const steps = SAMPLE_STEPS.map(({ px, ...s }) => ({ ...s, ...roundLatLng(fromPx(px, destination)) }));
  return {
    id: "sample",
    demo: true,
    made: "6:20 PM",
    name: "The Garden Room",
    address: "14 Oxford St, Osu, Accra",
    walk: "12 MIN WALK · 910 M",
    walkM: 910,
    far: { walk: "8.4 KM · 1 HR 50 MIN ON FOOT", drive: "ABOUT 20 MIN BY CAR" },
    streetLabel: "OXFORD ST",
    firstStreet: "UP CANTONMENTS RD",
    entrance: "GREEN GATE, NEXT TO THE TAILOR’S",
    nearby: "CAFÉ ACROSS THE ROAD, 1 MIN · BENCH IN THE PARK, 3 MIN",
    startsLabel: "7",
    links: { event: { label: "See the event →", url: "https://events.heyreason.com/" } },
    destination: roundLatLng(destination),
    route,
    steps,
  };
}

function roundLatLng(p) {
  return { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
}

// ---------- the page ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Reason's page for one trip. The trip is embedded as JSON; the script draws every screen from it. */
export function directionsPage(trip) {
  // The trip's own JSON, with the characters that could end the script tag written as escapes.
  const json = JSON.stringify(trip).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<!doctype html>
<html lang="en" class="paper">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f2ebe0">
<title>Directions to ${esc(trip.name)} · Reason</title>
<style>
${CSS}
</style>
</head>
<body>
<main id="app" class="screen paper"><noscript><p class="label" style="padding:24px">Directions need JavaScript. The address is ${esc(trip.address)}.</p></noscript></main>
<script id="trip" type="application/json">${json}</script>
<script type="module" src="/d/app.js"></script>
</body>
</html>
`;
}

// ---------- the reroute (the one call that leaves the phone) ----------
const MANEUVER_WORD = { left: "Turn left", right: "Turn right", "slight left": "Bear left", "slight right": "Bear right", "sharp left": "Turn sharply left", "sharp right": "Turn sharply right", straight: "Keep straight", uturn: "Turn around" };

/** Turns one OSRM step into the page's step. A step with no street is described by what it does, never a blank. */
function stepFromOsrm(s, i) {
  const m = s.maneuver || {};
  const name = (s.name || "").trim();
  const isRound = /roundabout/.test(m.type || "");
  const isArrive = m.type === "arrive";
  const turn = isRound ? "roundabout" : /left/.test(m.modifier || "") ? "left" : /right/.test(m.modifier || "") ? "right" : "straight";
  const isStart = m.type === "depart";
  const verb = isArrive ? "You’ve arrived" : isStart ? "Start walking" : isRound ? "Roundabout: take the exit" : MANEUVER_WORD[m.modifier] || "Keep going";
  const instr = isArrive ? "The Garden Room, on your right" : name ? `${verb} on ${name}` : isStart ? "Start walking" : `${verb}, along the way ahead`;
  const dist = Math.round(s.distance || 0);
  const [lng, lat] = m.location || [0, 0];
  return {
    n: String(i + 1).padStart(2, "0"),
    instr,
    turn,
    street: (name || "THE WAY AHEAD").toUpperCase(),
    fact: name ? name.toUpperCase() : "THE WAY AHEAD",
    mark: name ? "" : "Keep on the way in front of you. The lane has no name.",
    d: `${dist} m`,
    lat,
    lng,
  };
}

/**
 * Asks the routing service for a walk from the phone's position to the trip's destination. Returns the
 * route and steps the page replaces its own with, or an error status. Nothing about the position is
 * kept or logged.
 */
export async function reroute(trip, from, { routingUrl, fetchImpl = fetch, log = () => {} } = {}) {
  if (!routingUrl) return { status: 503, body: { error: "no_routing" } };
  const url = `${routingUrl.replace(/\/+$/, "")}/route/v1/foot/${from.lng},${from.lat};${trip.destination.lng},${trip.destination.lat}?overview=full&geometries=geojson&steps=true`;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`routing ${res.status}`);
    const data = await res.json();
    const r = data && data.routes && data.routes[0];
    if (!r || !r.geometry || r.geometry.coordinates.length < 2) throw new Error("no route");
    const route = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    const steps = (r.legs || []).flatMap((leg) => leg.steps || []).filter((s) => s.maneuver).map(stepFromOsrm);
    if (!steps.length) throw new Error("no steps");
    log({ directions: "reroute", ok: true, steps: steps.length, metres: Math.round(haversine(from, trip.destination)) });
    return { status: 200, body: { route, steps, destination: trip.destination } };
  } catch (e) {
    log({ directions: "reroute", ok: false, why: (e?.message ?? String(e)).split("\n")[0] });
    return { status: 502, body: { error: "routing_failed" } };
  }
}

async function readSmallBody(req, max = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The page's routes. Returns the response to send, or null when the path is not a directions path. */
export async function directionsRequest({ method, pathname, req, config, fetchImpl, log = () => {} }) {
  if (!config.directionsOn) return null;
  const isGet = method === "GET" || method === "HEAD";

  if (isGet && pathname === "/d/app.js") {
    return { status: 200, headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }, body: SCRIPT };
  }
  const font = /^\/d\/fonts\/([a-z]+)\.woff2$/.exec(pathname);
  if (isGet && font) {
    const out = webFont(font[1]);
    return out ? { status: out.status, headers: out.headers, body: out.body } : null;
  }

  const m = /^\/d\/([A-Za-z0-9_-]{1,40})(\/reroute)?$/.exec(pathname);
  if (!m) return null;
  const trip = m[1] === "sample" && config.directionsSample ? sampleTrip() : null;
  if (!trip) return null;

  if (m[2]) {
    if (method !== "POST") return null;
    let body;
    try { body = JSON.parse(await readSmallBody(req)); } catch { return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "bad_request" }) }; }
    const lat = Number(body?.lat), lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "bad_request" }) };
    }
    const out = await reroute(trip, { lat, lng }, { routingUrl: config.directionsRouting, fetchImpl, log });
    return { status: out.status, headers: JSON_HEADERS, body: JSON.stringify(out.body) };
  }

  if (!isGet) return null;
  return { status: 200, headers: HTML_HEADERS, body: directionsPage(trip) };
}

