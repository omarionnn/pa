// The walking directions page: /d/<id> (the page), /d/<id>/reroute (a new way, from the phone's position),
// /d/app.js (the page's script), /d/fonts/<name>.woff2 (Reason's own faces). Built from the handoff in
// PROMPT.md; the script is src/pages/directionsclient.js and the look is src/pages/directions.css
// (Reason's design system, copied from the handoff's reason.css).
//
// Off unless REASON_DIRECTIONS is on (config.directionsOn): every /d/ path then answers nothing, so the
// route falls through to the normal not-found page. REASON_DIRECTIONS_SAMPLE serves the sample trip below
// (made-up data, the handoff's Garden Room) so the page runs end to end locally. A real trip is made once
// by Reason (the `directions` tool, src/trips.js), stored, and opened at /d/<id> by its owner only: the
// private pages' code gate (src/pages/access.js) stands in front of it, and its link previews as every
// private page does, never with the place or an address.
//
// The routing key is never in the page: the reroute goes through this server, which calls the routing
// service at REASON_DIRECTIONS_ROUTING_URL (an OSRM-compatible foot router) and returns only the route.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { webFont } from "./webkit.js";
import { fromPx, haversine } from "./directionsclient.js";
import { walkRoute } from "../walk.js";

// A real trip needs the database, the code gate and the pages' look; the sample and the static staging
// build need none of it, so it is loaded on the first real trip's request.
let REAL = null;
const real = () => (REAL ??= Promise.all([import("../db.js"), import("../trips.js"), import("./access.js"), import("./render.js"), import("./madedata.js"), import("./websignin.js")])
  .then(([db, trips, access, render, made, websignin]) => ({ db, ...trips, ...access, renderCodeGate: render.renderCodeGate, privateHead: made.privateHead, PRIVATE_OG_VERSION: made.PRIVATE_OG_VERSION, sameOrigin: websignin.sameOrigin })));

const CSS = readFileSync(new URL("./directions.css", import.meta.url), "utf8");
const SCRIPT = readFileSync(new URL("./directionsclient.js", import.meta.url), "utf8");

// The two libraries the page loads from this server (never a CDN): MapLibre draws the map from the trip's own
// shapes (no tiles, no key), suncalc gives sunset at the person's position. Read on first ask, then kept.
const VENDOR = {
  "maplibre-gl.mjs": ["maplibre-gl/dist/maplibre-gl.mjs", "text/javascript; charset=utf-8"],
  "maplibre-gl-worker.mjs": ["maplibre-gl/dist/maplibre-gl-worker.mjs", "text/javascript; charset=utf-8"],
  "maplibre-gl.css": ["maplibre-gl/dist/maplibre-gl.css", "text/css; charset=utf-8"],
  "suncalc.js": ["suncalc/index.js", "text/javascript; charset=utf-8"],
};
const vendorCache = new Map();
function vendorFile(name) {
  const entry = Object.hasOwn(VENDOR, name) ? VENDOR[name] : null;
  if (!entry) return null;
  if (!vendorCache.has(name)) {
    try {
      vendorCache.set(name, readFileSync(new URL(`../../node_modules/${entry[0]}`, import.meta.url)));
    } catch {
      return null;
    }
  }
  const body = vendorCache.get(name);
  return { status: 200, headers: { "Content-Type": entry[1], "Content-Length": body.length, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }, body };
}

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

// The streets around the sample walk, drawn under the route (the prototype's map, in its own pixels).
const SAMPLE_MINOR_PX = [
  [[-300, 180], [700, 180]], [[-300, 100], [700, 100]], [[60, -300], [60, 700]], [[230, 180], [230, 700]],
  [[150, -300], [150, 700]], [[30, 135], [270, 135]], [[400, -300], [400, 700]], ring(150, 135, 14),
];
const SAMPLE_MAJOR_PX = [[[320, -300], [320, 700]], [[-300, 260], [700, 260]]];
const SAMPLE_PARKS_PX = [rect(252, 28, 132, 82), rect(166, 192, 52, 54), ring(150, 135, 8)];
const SAMPLE_WATER_PX = [[[-300, 330], ...bezier([-300, 330], [-40, 318], [50, 350], [112, 420]), [112, 700], [-300, 700], [-300, 330]]];

function ring(cx, cy, r, n = 24) {
  return Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
}
function rect(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
}
function bezier(a, b, c, d, n = 12) {
  return Array.from({ length: n }, (_, k) => {
    const t = (k + 1) / n, u = 1 - t;
    return [0, 1].map((i) => u * u * u * a[i] + 3 * u * u * t * b[i] + 3 * u * t * t * c[i] + t * t * t * d[i]);
  });
}

/** The sample trip, shaped as the page reads it. Every field is what Reason would fill in for a real trip. */
export function sampleTrip(now = new Date()) {
  const destination = SAMPLE_DEST;
  const route = SAMPLE_ROUTE_PX.map((p) => roundLatLng(fromPx(p, destination)));
  const steps = SAMPLE_STEPS.map(({ px, ...s }) => ({ ...s, ...roundLatLng(fromPx(px, destination)) }));
  // GeoJSON order ([lng, lat]) for the map's shapes: MapLibre draws them as given.
  const ll = (line) => line.map(([x, y]) => { const p = roundLatLng(fromPx({ x, y }, destination)); return [p.lng, p.lat]; });
  const at = (x, y) => roundLatLng(fromPx({ x, y }, destination));
  // The sample event starts at 7 PM in Accra (UTC, no daylight saving) on the day the page is opened.
  const startsAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 19, 0, 0);
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
    look: "Look for the gate.",
    nearby: "CAFÉ ACROSS THE ROAD, 1 MIN · BENCH IN THE PARK, 3 MIN",
    startsLabel: "7",
    startsAt,
    links: { event: { label: "See the event →", url: "https://events.heyreason.com/" } },
    destination: roundLatLng(destination),
    route,
    steps,
    // The map, embedded: no tiles and no map key. Streets, parks and water near the walk, plus the few
    // labels the design keeps (the street and the place). Reason fills these from map data when it makes a trip.
    map: {
      major: SAMPLE_MAJOR_PX.map(ll),
      minor: SAMPLE_MINOR_PX.map(ll),
      parks: SAMPLE_PARKS_PX.map(ll),
      water: SAMPLE_WATER_PX.map(ll),
      pois: [at(179, 243)],
      labels: [{ text: "OXFORD ST", ...at(250, 252) }],
    },
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
<link rel="stylesheet" href="/d/vendor/maplibre-gl.css">
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
/**
 * Asks the routing service for a walk from the phone's position to the trip's destination. Returns the
 * route and steps the page replaces its own with, or an error status. Nothing about the position is
 * kept or logged: the log line has the step count and a rounded distance to the door, never a place.
 */
export async function reroute(trip, from, { routingUrl, fetchImpl = fetch, log = () => {}, streets = [], heading = null } = {}) {
  if (!routingUrl) return { status: 503, body: { error: "no_routing" } };
  const opts = { routingUrl, fetchImpl, placeName: trip.name, streets };
  let out;
  if (Number.isFinite(heading)) {
    // They walked on after "turn around": a way that starts the way they face, unless it is much longer than
    // turning back (a dead end, a river), when turning back is the reasonable way after all.
    const [ahead, any] = await Promise.all([walkRoute(from, trip.destination, { ...opts, heading }), walkRoute(from, trip.destination, opts)]);
    out = ahead.ok && (!any.ok || ahead.metres <= any.metres * FORWARD_SLACK + FORWARD_EXTRA_M) ? ahead : any;
    if (out.ok) log({ directions: "reroute_forward", kept_forward: out === ahead });
    if (out.ok) out = { ...out, forward: out === ahead };
  } else {
    out = await walkRoute(from, trip.destination, opts);
  }
  if (!out.ok) {
    log({ directions: "reroute", ok: false, why: out.why || out.error });
    return { status: out.status || 502, body: { error: "routing_failed" } };
  }
  log({ directions: "reroute", ok: true, steps: out.steps.length, metres: Math.round(haversine(from, trip.destination) / 50) * 50 });
  return { status: 200, body: { route: out.route, steps: out.steps, destination: trip.destination, ...(typeof out.forward === "boolean" ? { forward: out.forward } : {}) } };
}

/** The walker's heading from a reroute's body: a real number of degrees, else none. */
const headingOf = (body) => (typeof body?.heading === "number" && Number.isFinite(body.heading) ? ((body.heading % 360) + 360) % 360 : null);
/** A forward way is taken if it is at most this much longer than one that turns back. */
export const FORWARD_SLACK = 1.4;
export const FORWARD_EXTRA_M = 150;

// ---------- who may open a real trip (the private pages' gate, src/pages/access.js) ----------
function sameKey(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Can this browser open this trip? Only its owner's own browser: a session proved on any of their pages
 * (Web, a page, an event) opens it. Anybody else, the owner's link on a new browser included, gets the
 * code gate, and only a request carrying the owner's key may ask for a code to be texted.
 */
/** A trip's id in page_attempts / page_codes: its own namespace, never a page's. */
const attemptId = (id) => `trip:${id}`;

function tripAccess(R, id, row, cookie, key) {
  const via_key = sameKey(key, row?.owner_key);
  const owner = cookie ? R.db.pageSessionOwner(cookie, R.SESSION_TTL_MS) : null;
  if (row && owner && owner === row.conversation_id) return { allow: true, via_key };
  // Counted on the id, real or not, so a guessed id locks and answers exactly as a real one does.
  // Under `trip:` (audit lead 23): `/d/<id>` takes any 1–40 characters, so a bare id would share
  // its count and its codes with a page of the same name — `/d/ops` was the status page's.
  const failed = R.db.failedPageAttempts(attemptId(id), R.ATTEMPT_WINDOW_MS);
  if (failed >= R.MAX_FAILED_ATTEMPTS) return { allow: false, reason: "rate_limited", via_key };
  return { allow: false, reason: "code_needed", via_key };
}

/** The locked screen. It previews as every private page does: never the place, never an address. */
function tripGate(R, access, row, { status = 401, sent = false, error = "", config }) {
  const canSend = !!(access.via_key && row);
  const og = config.pagesV2 ? R.privateHead(`${R.pageUrl("og/private.png")}?v=${R.PRIVATE_OG_VERSION}`) : "";
  return {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" },
    body: R.renderCodeGate({ title: "Private page", error, ownerName: config.ownerName, canSend, sent: canSend && sent, head: canSend ? og : "" }),
  };
}

const tripTitle = (row) => `Directions to ${row.trip.name}`;

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

/**
 * The page's routes. Returns the response to send, or null when the path is not a directions path.
 * `pathname` may carry the files host's /p prefix (Caddy rewrites files.heyreason.com/* under /p).
 */
export async function directionsRequest({ method, pathname: rawPath, req, config, fetchImpl, key = null, headers = {}, runtime = null, log = () => {} }) {
  if (!config.directionsOn) return null;
  const pathname = String(rawPath ?? "").replace(/^\/p(?=\/d\/)/, "");
  const isGet = method === "GET" || method === "HEAD";

  if (isGet && pathname === "/d/app.js") {
    return { status: 200, headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }, body: SCRIPT };
  }
  const vendor = /^\/d\/vendor\/([a-z.-]+)$/.exec(pathname);
  if (isGet && vendor) return vendorFile(vendor[1]);
  const font = /^\/d\/fonts\/([a-z]+)\.woff2$/.exec(pathname);
  if (isGet && font) {
    const out = webFont(font[1]);
    return out ? { status: out.status, headers: out.headers, body: out.body } : null;
  }

  const m = /^\/d\/([A-Za-z0-9_-]{1,40})(\/reroute|\/end)?$/.exec(pathname);
  if (!m) return null;
  if (m[1] !== "sample") return tripRequest({ id: m[1], reroutePath: m[2] === "/reroute", endPath: m[2] === "/end", method, req, config, fetchImpl, key, headers, runtime, log });
  const trip = config.directionsSample ? sampleTrip() : null;
  if (!trip) return null;

  // The sample is never stored, so its end has nothing to delete.
  if (m[2] === "/end") return method === "POST" ? { status: 204, headers: JSON_HEADERS, body: "" } : null;
  if (m[2]) {
    if (method !== "POST") return null;
    let body;
    try { body = JSON.parse(await readSmallBody(req)); } catch { return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "bad_request" }) }; }
    const lat = Number(body?.lat), lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "bad_request" }) };
    }
    const heading = headingOf(body);
    const out = await reroute(trip, { lat, lng }, { routingUrl: config.directionsRouting, fetchImpl, log, heading });
    return { status: out.status, headers: JSON_HEADERS, body: JSON.stringify(out.body) };
  }

  if (!isGet) return null;
  return { status: 200, headers: HTML_HEADERS, body: directionsPage(trip) };
}

/** A real trip's routes: the page, its code gate, and the reroute, for the trip's owner only. */
async function tripRequest({ id, reroutePath, endPath, method, req, config, fetchImpl, key, headers, runtime, log }) {
  const R = await real();
  const isGet = method === "GET" || method === "HEAD";
  const found = R.db.getTrip(id);
  // "owner": only the owner's trips open; anybody else's id answers exactly as one that never existed.
  const row = found && R.tripsOnFor(found.conversation_id) ? found : null;
  const cookie = R.readCookie(headers?.cookie);
  const access = tripAccess(R, id, row, cookie, key);

  // The walk is over on the page (arrived, or END ESCORT): the row, and where the walk started, go now.
  // Anybody else's id, or one already gone, answers the same 204, so the answer tells nobody anything.
  if (endPath) {
    if (method !== "POST") return null;
    if (row && access.allow) {
      let why = "ended";
      try { why = String(JSON.parse((await readSmallBody(req, 256)) || "{}")?.why ?? "ended"); } catch { /* a bare end is an end */ }
      R.endTrip(row.id, why, { log });
    }
    return { status: 204, headers: JSON_HEADERS, body: "" };
  }

  if (reroutePath) {
    if (method !== "POST") return null;
    if (!row || !access.allow) return { status: 403, headers: JSON_HEADERS, body: JSON.stringify({ error: "not_yours" }) };
    let body;
    try { body = JSON.parse(await readSmallBody(req)); } catch { return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "bad_request" }) }; }
    const lat = Number(body?.lat), lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "bad_request" }) };
    }
    const heading = headingOf(body);
    const out = await reroute(row.trip, { lat, lng }, { routingUrl: config.directionsRouting, fetchImpl, log, streets: R.tripStreets(row), heading });
    return { status: out.status, headers: JSON_HEADERS, body: JSON.stringify(out.body) };
  }

  if (method === "POST") {
    // Only from the gate itself. The cookie it sets is the site-wide `reason_page` session, which a
    // connect callback also reads (src/connectgate.js): a page elsewhere posting the owner's code from
    // someone else's browser would sign that browser in as the owner (login CSRF).
    if (!R.sameOrigin(headers)) return tripGate(R, access, row, { status: 403, config });
    let raw = "";
    try { raw = await readSmallBody(req, 2048); } catch { return tripGate(R, access, row, { status: 400, config }); }
    const form = new URLSearchParams(raw);
    // An id that is no trip is tried as a page with nobody behind it, as pageRequest does: the same
    // attempt counted, the same answer, the same lock.
    const pagelike = row ? { id: attemptId(row.id), conversation_id: row.conversation_id, title: tripTitle(row) } : { id: attemptId(id), conversation_id: null, title: "" };
    if (form.has("send")) {
      // "Text me the code": only the owner's own link, on a real trip, ever makes their phone buzz.
      if (!access.via_key || !row || access.reason === "rate_limited") return tripGate(R, access, row, { config });
      const asked = R.requestCode(pagelike);
      if (!asked.ok) {
        return tripGate(R, access, row, { sent: true, config, error: `Reason has already texted ${config.ownerName} a code. Use that one, or try again in about ${Math.ceil(asked.retry_after_s / 60)} minutes.` });
      }
      if (runtime?._tell) {
        Promise.resolve(runtime._tell(row.conversation_id, asked.line, { idempotencyKey: `pcode:${row.id}:${asked.id}` }))
          .catch((e) => log({ trip_code_text_failed: row.id, why: (e?.message ?? String(e)).split("\n")[0] }));
      }
      log({ trip_code_sent: row.id });
      return tripGate(R, access, row, { sent: true, config });
    }
    const tried = R.trySubmittedCode({ page: pagelike, code: form.get("code") ?? "" });
    if (!tried.ok) {
      const why = tried.reason === "rate_limited"
        ? `Too many wrong codes. Try again in about ${Math.ceil((tried.retry_after_s ?? 900) / 60)} minutes.`
        : `That code is not right.${tried.tries_left ? ` ${tried.tries_left} ${tried.tries_left === 1 ? "try" : "tries"} left.` : ""}`;
      return tripGate(R, access, row, { status: tried.reason === "rate_limited" ? 429 : 401, config, error: why });
    }
    if (!row) return tripGate(R, access, row, { config, error: "That code is not right." });
    log({ trip_opened: row.id });
    // Back to the page itself, now signed in, without the key in the address bar.
    return { status: 303, headers: { Location: row.id, "Cache-Control": "no-store", "Set-Cookie": R.cookieHeader(tried.token, { path: "/", headers }) }, body: "" };
  }

  if (!isGet) return null;
  if (row && access.allow) {
    // A map that never came (Overpass was down when the trip was made) is asked for again, behind the page.
    if (method === "GET") R.refillIfBare(row, { fetchImpl, log });
    return { status: 200, headers: HTML_HEADERS, body: directionsPage(R.pageTrip(row)) };
  }
  return tripGate(R, access, row, { status: access.reason === "rate_limited" ? 429 : 401, config, error: access.reason === "rate_limited" ? "Too many wrong codes. Try again in about 15 minutes." : "" });
}
