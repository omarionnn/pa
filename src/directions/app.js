// The directions page in the browser. Screens are drawn from the embedded payload; the escort's
// decisions come from logic.js (escortView), so this file is wiring: GPS in, screen out.
//
// Location is asked for only by the "Share my location" tap (and iOS's compass permission in that
// same tap). Nothing here calls geolocation on load. Everything waits on the user.

import * as L from "./logic.js";
import { mapStyle, THEMES } from "./tokens.js";
import { getTimes } from "/directions/vendor/suncalc.js";

const DATA = document.getElementById("directions-data");
const TRIP = JSON.parse(DATA.textContent);
let ROUTE = L.prepareRoute({ coordinates: TRIP.route.coordinates, steps: TRIP.steps });
const DEST = { lat: TRIP.destination.lat, lng: TRIP.destination.lng };
const app = document.getElementById("app");
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);

// ---------- storage: the Reason theme choice is shared with every Reason page on this host ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: keep going */ } },
};
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const ESCORT_FLAG = `reason-directions-escort:${TRIP.id}`;
const STATE_KEY = `reason-directions-progress:${TRIP.id}`;

// ---------- theme: Paper or Night, a 3 s fade, never a snap ----------
let themeName = "paper";
function chooseTheme(mode) {
  const p = live.smooth ?? DEST;
  return L.resolveTheme({
    choice: store.get("reason-theme"),
    mode,
    now: new Date(),
    lat: p.lat,
    lng: p.lng,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    sunTimes: (now, lat, lng) => getTimes(now, lat, lng),
  });
}
function applyTheme(mode) {
  const next = chooseTheme(mode);
  if (next === themeName) return;
  themeName = next;
  const screen = app.querySelector(".screen");
  if (screen) screen.classList.toggle("night", themeName === "night");
  if (mapHandle) mapHandle.setTheme(themeName);
}

// ---------- the router ----------
const MODE_KEY = "reason-directions-mode";
let liveTimer = null;
let currentScreen = "";

function go() {
  const [head = "", sub = "", extra = ""] = location.hash.replace(/^#/, "").split("/");
  stopLiveUI();
  if (head === "ask") return renderAsk();
  if (head === "toofar") return renderTooFar();
  if (head === "route") { if (sub !== "denied") store.set(MODE_KEY, "route"); return renderRoute({ sub, note: sub === "denied" }); }
  if (head === "escort") return renderEscortEntry(sub, extra);
  return renderChoose();
}

window.addEventListener("hashchange", () => {
  const leavingEscort = currentScreen === "escort" && !location.hash.startsWith("#escort");
  // Leaving the escort for the route saves the battery: the watch pauses until the user comes back.
  if (leavingEscort) {
    pauseWatch();
    const upcoming = live.active && ROUTE.maneuvers[live.m];
    if (location.hash === "#route" && Number.isInteger(upcoming)) {
      // Keeps the user's place: the route opens on the turn the escort is heading for.
      location.replace(`#route/step${upcoming + 1}`);
      return;
    }
  }
  go();
});

function screenWrap(inner, cls = "") {
  return `<main class="screen ${themeName === "night" ? "night" : "paper"} ${cls}">${inner}</main>`;
}

function escapeText(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const COPY_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>';
const SPEAKER_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
const WORDMARK = document.getElementById("wordmark-tpl")?.innerHTML ?? "";

function renderChoose() {
  currentScreen = "choose";
  // The last mode chosen goes first and is tagged; with no choice yet, Escort goes first.
  const last = store.get(MODE_KEY);
  const escortFirst = last !== "route";
  const escort = `<a class="choice rise" href="#ask" style="animation-delay:.9s"><span style="display:flex;justify-content:space-between;align-items:baseline;gap:12px"><span class="serif" style="font-size:34px;line-height:1.1">Escort me there →</span>${last === "escort" ? '<span class="label">LAST TIME</span>' : ""}</span><span style="display:block;margin-top:6px;font-size:18px;line-height:1.45;color:var(--text-2)">Reason walks you there, turn by turn. Uses your location.</span></a>`;
  const route = `<a class="choice rise" href="#route" style="border-bottom:1px dashed var(--border);animation-delay:1s"><span style="display:flex;justify-content:space-between;align-items:baseline;gap:12px"><span class="serif" style="display:block;font-size:34px;line-height:1.1">Show me the route →</span>${last === "route" ? '<span class="label">LAST TIME</span>' : ""}</span><span style="display:block;margin-top:6px;font-size:18px;line-height:1.45;color:var(--text-2)">Read the steps and map at your own pace.</span></a>`;
  app.innerHTML = screenWrap(
    `<p class="label rise" style="position:absolute;top:22px;left:24px;margin:0">DIRECTIONS · MADE ${escapeText(TRIP.madeAt)}</p>` +
    `<section style="position:absolute;top:96px;left:24px;right:24px;text-align:center">` +
      `<h1 class="serif rise" style="margin:0;font-size:52px;line-height:1.02;letter-spacing:-.02em;animation-delay:.1s">${escapeText(TRIP.destination.name)}</h1>` +
      `<p class="label rise" style="margin:14px 0 0;color:var(--text);animation-delay:.2s">${walkLabel()}</p>` +
      `<p class="rise" style="margin:4px 0 0;font-size:18px;color:var(--text-2);animation-delay:.2s">${escapeText(TRIP.destination.address)}</p>` +
    `</section>` +
    `<svg viewBox="0 0 390 200" width="390" height="200" aria-hidden="true" style="position:absolute;top:262px;left:50%;margin-left:-195px;overflow:visible"><path class="ink-line draw-once" d="M195,180 V12" pathLength="100"/><circle class="you" cx="195" cy="180" r="11"/></svg>` +
    `<nav aria-label="Choose how to go" style="position:absolute;left:24px;right:24px;top:500px">${escortFirst ? escort + route : route + escort}</nav>` +
    `<p class="label" style="position:absolute;left:24px;right:24px;bottom:22px;margin:0;text-align:center">ONLY YOU CAN SEE THIS PAGE</p>`,
  );
  applyTheme("route");
}

function renderAsk() {
  currentScreen = "ask";
  app.innerHTML = screenWrap(
    `<a class="textbtn" href="#choose" style="position:absolute;top:8px;left:20px;color:var(--text-2)">← BACK</a>` +
    `<section style="position:absolute;top:210px;left:24px;right:24px">` +
      `<p class="label rise" style="margin:0 0 16px">ESCORT</p>` +
      `<h1 class="serif rise" style="margin:0;font-size:40px;line-height:1.1;letter-spacing:-.015em;animation-delay:.1s">I need your location to guide you turn by turn.</h1>` +
      `<p class="hand ink" style="margin-top:22px;animation-delay:.5s">It stays on your phone.</p>` +
      `<p class="quiet" style="margin:14px 0 0;font-size:15px">Your location is read on this phone. It goes to Reason only if a reroute needs it.</p>` +
    `</section>` +
    `<div style="position:absolute;left:24px;right:24px;bottom:40px;display:flex;flex-direction:column;align-items:flex-start;gap:4px">` +
      `<button type="button" class="action rise" id="share" style="font-size:34px;animation-delay:.8s">Share my location →</button>` +
      `<a class="textbtn rise" href="#route" style="padding-left:0;color:var(--text-2);animation-delay:.9s">NOT NOW · SHOW THE ROUTE</a>` +
    `</div>`,
  );
  applyTheme("escort");
  $("share").onclick = () => shareLocation();
}

function renderTooFar() {
  currentScreen = "toofar";
  const maps = L.mapsLinks({ lat: DEST.lat, lng: DEST.lng, name: TRIP.destination.name });
  const driveLine = TRIP.drive ? `ABOUT ${TRIP.drive.minutes} MIN BY CAR` : "";
  app.innerHTML = screenWrap(
    `<p class="label rise" style="position:absolute;top:22px;left:24px;margin:0">DIRECTIONS · MADE ${escapeText(TRIP.madeAt)}</p>` +
    `<section style="position:absolute;top:96px;left:24px;right:24px;text-align:center"><h1 class="serif rise" style="margin:0;font-size:40px;line-height:1.04;letter-spacing:-.02em;animation-delay:.1s">${escapeText(TRIP.destination.name)}</h1>` +
      `<p class="label rise" style="margin:12px 0 0;color:var(--text);animation-delay:.2s">${escapeText(`${(TRIP.walk.meters / 1000).toFixed(1)} KM · ${TRIP.walk.minutes} MIN ON FOOT`)}</p></section>` +
    `<div style="position:absolute;top:300px;left:24px;right:24px;text-align:center"><p class="hand ink" style="font-size:3rem;line-height:1.05;animation-delay:.4s">That’s a long walk.<br>Want a ride instead?</p></div>` +
    `<div style="position:absolute;left:24px;right:24px;bottom:40px;display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center">` +
      `<a class="action rise" id="open-maps" href="${escapeText(isIOS() ? maps.apple : maps.google)}" style="font-size:34px;animation-delay:1s">Open in Maps →</a>` +
      `<p class="label rise" style="margin:0 0 10px;animation-delay:1s">${escapeText(driveLine)}</p>` +
      `<a class="textbtn rise" href="#ask" style="color:var(--text-2);animation-delay:1.1s">WALK ANYWAY</a></div>`,
  );
  applyTheme("route");
}

function walkLabel() {
  return escapeText(`${TRIP.walk.minutes} MIN WALK · ${Math.round(TRIP.walk.meters)} M`);
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// ---------- the Route: the map is the loud thing ----------
function renderRoute({ sub = "", note = false }) {
  currentScreen = "route";
  const open = sub === "steps";
  const sel = /^step\d$/.test(sub) ? Number(sub.slice(4)) : 0;
  const steps = TRIP.steps.map((s, k) => {
    const dist = `${Math.round(s.distanceM)} m`;
    return `<li class="step-row"><button type="button" data-step="${k + 1}" class="step-btn">` +
      `<span class="step-n">${String(k + 1).padStart(2, "0")}</span>` +
      `<span><span class="step-i">${escapeText(s.instr)}</span><span class="step-m">${escapeText(s.mark)}</span></span>` +
      `<span class="step-d">${escapeText(dist)}</span></button></li>`;
  }).join("");
  const selected = sel > 0 ? TRIP.steps[sel - 1] : null;
  app.innerHTML = screenWrap(
    `<header class="top">${WORDMARK}<a class="textbtn" href="#ask" style="padding-right:0">ESCORT ME →</a></header>` +
    (note ? `<div style="padding:20px 24px 0"><p class="hand ink">No problem, here’s the Route version.</p></div>` : "") +
    `<section style="padding:20px 24px 0"><h1 class="serif" style="margin:0;font-size:40px;line-height:1.04;letter-spacing:-.02em">${escapeText(TRIP.destination.name)}</h1>` +
      `<p class="label" style="margin:8px 0 0;color:var(--text)">${walkLabel()}</p></section>` +
    `<div class="map-frame" id="map-box" role="img" aria-label="Map of the route"><div id="map" class="map-canvas"></div><span class="map-credit">MAP © OPENSTREETMAP CONTRIBUTORS</span></div>` +
    `<div id="r-cta" class="route-cta" ${selected ? 'style="display:none"' : ""}>` +
      `<div style="display:flex;justify-content:space-between;align-items:center"><button type="button" class="action" id="r-open" style="font-size:30px">See the steps ↑</button><span class="label">${TRIP.steps.length} STEPS</span></div>` +
      `<p class="label" style="margin:2px 0 0">ONLY YOU CAN SEE THIS PAGE</p></div>` +
    `<article class="card" id="r-card" style="position:absolute;left:16px;right:16px;bottom:14px;padding:14px 18px 4px;${selected ? "" : "display:none"}" aria-live="polite">` +
      `<p class="label" style="margin:0"><span id="r-n" style="color:var(--stamp);font-weight:700">${selected ? String(sel).padStart(2, "0") : ""}</span> / ${String(TRIP.steps.length).padStart(2, "0")} · <span id="r-d">${selected ? escapeText(`${Math.round(selected.distanceM)} m`).toUpperCase() : ""}</span></p>` +
      `<p class="serif" id="r-i" style="margin:4px 0 0;font-size:28px;line-height:1.1">${selected ? escapeText(selected.instr) : ""}</p>` +
      `<p id="r-m" style="margin:4px 0 0;font-size:15px;line-height:1.45;color:var(--text-2)">${selected ? escapeText(selected.mark) : ""}</p>` +
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">` +
        `<button type="button" class="textbtn" id="r-prev" style="padding-left:0">← PREV</button>` +
        `<button type="button" class="textbtn" id="r-all">ALL STEPS</button>` +
        `<button type="button" class="textbtn" id="r-next" style="padding-right:0">NEXT →</button></div></article>` +
    `<button type="button" class="scrim ${open ? "on" : ""}" id="r-scrim" aria-label="Close the steps"></button>` +
    `<section class="sheet ${open ? "on" : ""}" id="r-sheet" aria-label="All steps"><span class="grip"></span>` +
      `<div style="display:flex;justify-content:space-between;align-items:center"><p class="label" style="margin:0">THE WAY · TAP A STEP TO SEE IT</p><button type="button" class="textbtn" id="r-close" style="padding-right:0">CLOSE ↓</button></div>` +
      `<ol class="step-list">${steps}</ol>` +
      `<div class="address-row"><span style="font-size:15px">${escapeText(TRIP.destination.address)}</span>` +
        `<button type="button" class="textbtn" id="r-copy" aria-label="Copy the address" style="padding-right:0">${COPY_ICON}COPY</button></div>` +
      `<div style="display:flex;gap:20px;flex-wrap:wrap"><a class="textbtn" href="${escapeText(L.mapsLinks({ lat: DEST.lat, lng: DEST.lng, name: TRIP.destination.name }).apple)}" style="padding-left:0">APPLE MAPS ↗</a><a class="textbtn" href="${escapeText(L.mapsLinks({ lat: DEST.lat, lng: DEST.lng, name: TRIP.destination.name }).google)}">GOOGLE MAPS ↗</a></div>` +
    `</section>`,
  );
  applyTheme("route");
  wireRoute(sel, open);
  mountRouteMap(sel);
}

function wireRoute(sel, open) {
  let st = { sel, open };
  const update = () => {
    $("r-sheet").classList.toggle("on", st.open);
    $("r-scrim").classList.toggle("on", st.open);
    $("r-cta").style.display = st.sel ? "none" : "";
    $("r-card").style.display = st.sel ? "" : "none";
    if (st.sel) {
      const s = TRIP.steps[st.sel - 1];
      $("r-n").textContent = String(st.sel).padStart(2, "0");
      $("r-d").textContent = `${Math.round(s.distanceM)} m`.toUpperCase();
      $("r-i").textContent = s.instr;
      $("r-m").textContent = s.mark;
    }
    if (mapHandle) mapHandle.focusStep(st.sel ? TRIP.steps[st.sel - 1] : null);
    history.replaceState(null, "", st.sel ? `#route/step${st.sel}` : st.open ? "#route/steps" : "#route");
  };
  $("r-open").onclick = () => { st.open = true; update(); };
  $("r-all").onclick = () => { st.open = true; update(); };
  $("r-close").onclick = () => { st.open = false; update(); };
  $("r-scrim").onclick = () => { st.open = false; update(); };
  $("r-prev").onclick = () => { st.sel = Math.max(1, st.sel - 1); update(); };
  $("r-next").onclick = () => { st.sel = Math.min(TRIP.steps.length, st.sel + 1); update(); };
  $("r-copy").onclick = () => { try { navigator.clipboard.writeText(TRIP.destination.address); } catch { /* no clipboard: nothing lost */ } };
  for (const b of app.querySelectorAll("[data-step]")) {
    b.onclick = () => { st = { sel: Number(b.getAttribute("data-step")), open: false }; update(); };
  }
}

// ---------- the map: MapLibre with a style built from the tokens, no key, no tiles ----------
let mapHandle = null;
let mapLib = null;

async function loadMapLib() {
  if (!mapLib) mapLib = await import("/directions/vendor/maplibre-gl.mjs");
  return mapLib;
}

/** A map for a container. Roads and route come from the payload. Returns a small handle. */
async function createMap(el, { interactive, center, zoom, bearing = 0, fit = null }) {
  const lib = await loadMapLib();
  const map = new lib.Map({
    container: el,
    style: mapStyle(themeName),
    center,
    zoom,
    bearing,
    interactive,
    attributionControl: false,
    fadeDuration: 0,
    renderWorldCopies: false,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("map did not load")), 8000);
    map.once("load", () => { clearTimeout(timer); resolve(); });
  });
  const roads = (kind) => ({
    type: "FeatureCollection",
    features: (kind === "major" ? TRIP.roads.major : TRIP.roads.minor).map((line) => ({ type: "Feature", properties: { c: kind }, geometry: { type: "LineString", coordinates: line } })),
  });
  map.getSource("roads")?.setData({ type: "FeatureCollection", features: [...roads("minor").features, ...roads("major").features] });
  map.getSource("route")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: TRIP.route.coordinates } });
  map.getSource("dest")?.setData({ type: "Feature", geometry: { type: "Point", coordinates: [DEST.lng, DEST.lat] } });
  if (fit) map.fitBounds(fit, { padding: 48, duration: 0 });
  return map;
}

async function mountRouteMap(sel) {
  const el = $("map");
  if (!el) return;
  try {
    const map = await createMap(el, { interactive: true, center: [DEST.lng, DEST.lat], zoom: 14, fit: bounds(TRIP.route.coordinates) });
    if (!REDUCED) animateRouteDraw(map);
    mapHandle = {
      map,
      setTheme(t) { paintMap(map, t); },
      focusStep(step) {
        if (!step) { map.fitBounds(bounds(TRIP.route.coordinates), { padding: 48, duration: REDUCED ? 0 : 900 }); return; }
        map.easeTo({ center: step.location, zoom: 17.2, duration: REDUCED ? 0 : 900 });
      },
    };
    paintMap(map, themeName);
    if (sel) mapHandle.focusStep(TRIP.steps[sel - 1]);
  } catch {
    el.innerHTML = `<p class="label" style="padding:16px;margin:0">The map did not load. The steps are below.</p>`;
  }
}

function paintMap(map, theme) {
  const t = THEMES[theme] ?? THEMES.paper;
  if (!map.isStyleLoaded()) return;
  map.setPaintProperty("land", "background-color", t.mapLand);
  map.setPaintProperty("roads-minor-case", "line-color", t.mapCasing);
  map.setPaintProperty("roads-minor", "line-color", t.mapRoad);
  map.setPaintProperty("roads-major-case", "line-color", t.mapCasing);
  map.setPaintProperty("roads-major", "line-color", t.mapRoad);
  map.setPaintProperty("route", "line-color", t.route);
  map.setPaintProperty("done", "line-color", t.mapDone);
  map.setPaintProperty("dest-ring", "circle-color", t.dest);
  map.setPaintProperty("dest-ring", "circle-stroke-color", t.route);
  map.setPaintProperty("dot", "circle-color", t.dot);
  map.setPaintProperty("dot", "circle-stroke-color", t.dotRing);
  map.setPaintProperty("dot-halo", "circle-color", t.route);
}

/** The route draws itself in ink, over about 1.8 s, one coordinate at a time. */
function animateRouteDraw(map) {
  const coords = TRIP.route.coordinates;
  const started = performance.now();
  const frame = (now) => {
    const f = Math.min(1, (now - started - 300) / 1800);
    const eased = f < 0 ? 0 : 1 - Math.pow(1 - f, 3);
    const n = Math.max(2, Math.round(eased * coords.length));
    map.getSource("route")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords.slice(0, n) } });
    if (f < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function bounds(coords) {
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

// ---------- location: only on the tap ----------
function shareLocation() {
  beginWatch();
  location.hash = "#escort";
}

/** Everything a tap must start, in the tap: the iOS compass permission (it has to come from a gesture), speech, the watch. */
function beginWatch() {
  unlockSpeech();
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then((state) => { live.compass = state === "granted"; }).catch(() => { live.compass = false; });
  }
  live.active = true;
  live.ended = false;
  session.set(ESCORT_FLAG, "1");
  store.set(MODE_KEY, "escort");
  startWatch();
}

/** A reload mid-escort: nothing is read until the user taps to pick the walk up again. */
function resumeEscort() {
  beginWatch();
  live.returnedAt = Date.now();
  renderEscortEntry("", "");
}

function startWatch() {
  if (!("geolocation" in navigator)) return;
  if (live.watchId !== null) navigator.geolocation.clearWatch(live.watchId);
  live.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  live.watchOn = true;
  if (live.battery === undefined) watchBattery();
}

function pauseWatch() {
  if (live.watchId !== null && "geolocation" in navigator) navigator.geolocation.clearWatch(live.watchId);
  live.watchId = null;
  live.watchOn = false;
  releaseWake();
}

function stopWatch() {
  pauseWatch();
  session.del(ESCORT_FLAG);
  live.active = false;
}

function onPositionError(err) {
  if (err && err.code === 1) {
    // Refused: the Route version, with a note. Never an error screen.
    stopWatch();
    location.hash = "#route/denied";
  }
  // Timeout or unavailable: keep the last good state; the caption shows "finding" once it is old.
}

const live = {
  active: false, ended: false, watchId: null, watchOn: false, compass: false, battery: undefined, batteryLow: false,
  lastGood: null, lastGoodAt: 0, readings: [], smooth: null, hasFix: false,
  along: 0, m: 0, movedM: 0, heading: null, lastMoveAt: 0,
  directionConfirmed: false, confirmedAt: null, wrongStreak: 0, wrongWay: false,
  offCount: 0, rerouting: false, rerouteAt: 0,
  turnHold: null, announcedM: -1, batteryShownAt: null, hiddenAt: 0, returnedAt: null, lastNoteAt: 0,
  rejected: {},
};

function onPosition(pos) {
  const now = Date.now();
  const reading = { lat: pos.coords.latitude, lng: pos.coords.longitude, accM: pos.coords.accuracy, t: pos.timestamp || now };
  const verdict = L.acceptReading(reading, live.lastGood);
  if (!verdict.ok) { live.rejected[verdict.why] = (live.rejected[verdict.why] ?? 0) + 1; return; }
  live.lastGood = reading;
  live.lastGoodAt = now;
  live.hasFix = true;
  live.readings.push(reading);
  live.readings = live.readings.slice(-6);
  const sm = L.smoothFix(live.readings);
  if (live.smooth) {
    const moved = L.distanceM(live.smooth, sm);
    if (moved >= 4) { live.movedM += moved; live.lastMoveAt = now; live.heading = L.bearingDeg(live.smooth, sm); }
  } else {
    live.lastMoveAt = now;
    live.lastNoteAt = now;
  }
  live.smooth = sm;
  advance(now, reading);
  tick();
}

/**
 * Turns one smoothed fix into the escort's state: along the route, off route, heading, next turn.
 * Off route is counted on the raw reading (PROMPT.md: three readings in a row), not the smoothed dot,
 * which lags a few readings behind a real walk off the line.
 */
function advance(now, reading) {
  const sm = live.smooth;
  const proj = L.projectOntoRoute(ROUTE, sm);
  if (proj.distM <= L.TUNE.offRouteM) live.along = Math.max(live.along, proj.alongM);
  const raw = L.projectOntoRoute(ROUTE, reading);
  const off = L.nextOffRoute(live.offCount, raw.distM, reading.accM);
  live.offCount = off.count;
  if (off.triggered && !live.rerouting) requestReroute(sm, now);

  if (live.heading !== null && live.movedM >= L.TUNE.directionConfirmM) {
    const diff = L.angleDiff(live.heading, proj.bearingDeg);
    live.wrongStreak = diff > L.TUNE.wrongWayDeg ? live.wrongStreak + 1 : 0;
    live.wrongWay = live.wrongStreak >= 2;
    if (!live.directionConfirmed && diff <= 60) { live.directionConfirmed = true; live.confirmedAt = now; }
  }

  const adv = L.advanceManeuver(ROUTE, live.along, live.m);
  if (adv.passed.length) {
    live.m = adv.m;
    const turn = ROUTE.steps[adv.passed[adv.passed.length - 1]].turn;
    live.turnHold = { turn, untilMs: now + L.TUNE.heldMs };
  }
  if (live.turnHold && now >= live.turnHold.untilMs) live.turnHold = null;
}

function requestReroute(sm, now) {
  live.rerouting = true;
  live.rerouteAt = now;
  live.offCount = 0;
  if (!TRIP.rerouteUrl) { setTimeout(() => { live.rerouting = false; }, 12000); return; }
  fetch(TRIP.rerouteUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: TRIP.id, lat: sm.lat, lng: sm.lng, accM: sm.accM }),
    credentials: "same-origin",
  }).then(async (res) => {
    if (!res.ok) throw new Error(`reroute ${res.status}`);
    const body = await res.json();
    if (!isRouteShaped(body)) throw new Error("reroute: not a route");
    ROUTE = L.prepareRoute({ coordinates: body.route.coordinates, steps: body.steps });
    live.m = 0;
    live.along = L.projectOntoRoute(ROUTE, live.smooth).alongM;
    live.wrongWay = false;
    live.wrongStreak = 0;
  }).catch(() => { /* keep the saved route; the caption ends below */ }).finally(() => {
    live.rerouting = false;
    tick();
  });
}

/** Shape check for a reroute answer. The backend's own validation is the real guard. */
function isRouteShaped(b) {
  return b && b.route && Array.isArray(b.route.coordinates) && b.route.coordinates.length >= 2
    && Array.isArray(b.steps) && b.steps.length >= 1
    && b.steps.every((s) => Array.isArray(s.location) && s.location.length === 2 && ["depart", "straight", "left", "right", "roundabout", "arrive"].includes(s.turn));
}

function watchBattery() {
  live.battery = null;
  if (!navigator.getBattery) return;
  navigator.getBattery().then((b) => {
    const check = () => { live.batteryLow = b.level < L.TUNE.batteryLow && !b.charging; };
    check();
    b.addEventListener("levelchange", check);
    b.addEventListener("chargingchange", check);
  }).catch(() => { /* no battery API: no battery moment */ });
}

// ---------- the escort screen ----------
function renderEscortEntry(sub, extra) {
  if (TRIP.demo && sub) return renderEscortDemo(sub, extra === "more");
  if (!live.active) {
    // Never read location on a fresh load: a walk in progress asks for one tap to pick up.
    if (session.get(ESCORT_FLAG) === "1") { renderResume(); return; }
    location.hash = "#ask";
    return;
  }
  if (!live.watchOn) startWatch();
  renderEscort({ more: extra === "more" });
  startLiveLoop();
  keepAwake();
}

function renderResume() {
  renderEscort({});
  const status = $("e-status");
  status.className = "esc-status still";
  $("e-status-t").textContent = "WAITING";
  drawLine({ kind: "dim", stemScale: 1 });
  renderCaption({ kind: "hand", text: "Welcome back, tap to pick up where you were." });
  $("e-cap").insertAdjacentHTML("beforeend", `<button type="button" class="action" id="e-resume" style="margin-top:12px">Pick up the walk →</button>`);
  $("e-resume").onclick = () => resumeEscort();
}

let demoMode = null;
async function renderEscortDemo(state, more) {
  currentScreen = "escort";
  const { demoInput, DEMO_STATES } = await import("/directions/demo.js");
  if (!DEMO_STATES.includes(state)) { location.hash = "#escort/straight"; return; }
  demoMode = state;
  renderEscort({ more, demo: true });
  const nowMs = Date.parse("2026-10-29T18:00:00Z");
  const input = demoInput(state, { route: ROUTE, trip: TRIP, nowMs });
  showEscort(L.escortView(input), input);
}

function renderEscort({ more = false, demo = false } = {}) {
  currentScreen = "escort";
  app.innerHTML = screenWrap(
    `<p class="esc-status" id="e-status" style="margin:0"><span class="dot"></span><span id="e-status-t">ESCORTING</span></p>` +
    `<div class="stage"><svg viewBox="0 0 390 440" width="390" height="440" role="img" aria-label="Your path ahead">` +
      `<defs><linearGradient id="esc-fade-g" gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="230"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>` +
      `<mask id="esc-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="390" height="440"><rect x="0" y="0" width="390" height="440" fill="url(#esc-fade-g)"/></mask></defs>` +
      `<circle class="ink-drop" id="e-drop" cx="195" cy="400" r="44"/>` +
      `<path class="ghost" id="e-ghost" d="M195,150 V30"/>` +
      `<g mask="url(#esc-fade)"><g class="stem" id="e-stem"><path class="ink-line" d="M195,400 V30" vector-effect="non-scaling-stroke"/><path class="drift" d="M195,400 V30" vector-effect="non-scaling-stroke"/></g></g>` +
      `<g class="bend-g" id="e-bend-g"><path class="ink-line draw" id="e-bend" d="M195,150 Q195,90 135,90 H55" pathLength="100"/></g>` +
      `<path class="ink-line draw" id="e-hook" d="M195,250 C195,192 115,192 115,250 V318" pathLength="100"/>` +
      `<path class="ink-line draw" id="e-arrive" d="M195,230 Q195,200 225,200 H258" pathLength="100"/>` +
      `<path class="gate" id="e-gate" d="M270,216 V190 Q283,178 296,190 V216 M270,198 H296"/>` +
      `<path class="ink-line draw" id="e-loop" d="M195,350 A50 50 0 1 1 194.9,350" pathLength="100"/>` +
      `<circle class="you" id="e-you" cx="195" cy="400" r="11" style="transition:opacity .4s"/>` +
    `</svg></div>` +
    `<div class="caps" aria-live="polite"><div class="cap" id="e-cap"></div></div>` +
    `<p class="esc-foot quiet" id="e-foot" style="display:none">Escort is over. I’ve stopped using your location.</p>` +
    `<button type="button" class="textbtn more-btn" id="e-more" aria-expanded="false">MORE ↑</button>` +
    `<button type="button" class="scrim" id="e-scrim" aria-label="Close"></button>` +
    `<section class="sheet" id="e-sheet" aria-label="More"><span class="grip"></span>` +
      `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:10px 0 12px"><span class="serif" id="e-left" style="font-size:28px;line-height:1.1"></span><span class="label" id="e-left-sub"></span></div>` +
      `<div class="map-frame" style="margin:0" id="e-map-box"><div id="e-map" class="map-canvas" style="height:250px"></div></div>` +
      `<div style="padding-top:8px"><a class="action" href="#route">Switch to Route →</a></div>` +
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;border-top:1px dashed var(--border)">` +
        `<button type="button" class="textbtn" id="e-voice" aria-pressed="${voiceOn() ? "true" : "false"}" style="padding-left:0">${SPEAKER_ICON}<span>${voiceOn() ? "VOICE ON" : "VOICE OFF"}</span></button>` +
        `<button type="button" class="textbtn" id="e-end">END ESCORT</button>` +
        `<button type="button" class="textbtn" id="e-close" style="padding-right:0">CLOSE ↓</button></div>` +
      `<p class="label" style="margin:10px 0 0">Your location is read on this phone. It goes to Reason only for a reroute.</p>` +
    `</section>`,
  );
  applyTheme("escort");
  setMore(more);
  $("e-more").onclick = () => setMore(true);
  $("e-close").onclick = () => setMore(false);
  $("e-scrim").onclick = () => setMore(false);
  $("e-voice").onclick = () => {
    const on = !voiceOn();
    store.set("reason-directions-voice", on ? "on" : "off");
    $("e-voice").setAttribute("aria-pressed", on ? "true" : "false");
    $("e-voice").querySelector("span").textContent = on ? "VOICE ON" : "VOICE OFF";
  };
  $("e-end").onclick = () => { live.ended = true; stopWatch(); tick(); };
  if (demo) $("e-foot").style.display = "none";
}

function setMore(open) {
  $("e-sheet")?.classList.toggle("on", open);
  $("e-scrim")?.classList.toggle("on", open);
  $("e-more")?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) mountMoreMap(); else disposeMoreMap();
}

let moreMap = null;
async function mountMoreMap() {
  if (moreMap || !$("e-map")) return;
  const p = live.smooth ?? DEST;
  try {
    moreMap = await createMap($("e-map"), { interactive: false, center: [p.lng, p.lat], zoom: 17, bearing: live.heading ?? 0 });
    paintMap(moreMap, themeName);
    drawDot();
  } catch {
    if ($("e-map")) $("e-map").innerHTML = "";
  }
}
function disposeMoreMap() {
  if (moreMap) { moreMap.remove(); moreMap = null; }
}

function voiceOn() {
  return store.get("reason-directions-voice") !== "off";
}

// ---------- the escort's line and caption ----------
let shownMoment = null;
let liveRunning = false;

function startLiveLoop() {
  if (liveRunning) return;
  liveRunning = true;
  live.lastNoteAt = live.lastNoteAt || Date.now();
  liveTimer = setInterval(tick, 1000);
  tick();
}

function stopLiveUI() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  liveRunning = false;
  disposeMoreMap();
  if (mapHandle) { mapHandle.map.remove(); mapHandle = null; }
  releaseWake();
  demoMode = null;
}

function tick() {
  if (currentScreen !== "escort" || !$("e-status")) return;
  const now = Date.now();
  if (live.battery === undefined) watchBattery();
  const remaining = live.smooth ? L.remainingToManeuver(ROUTE, live.along, live.m) : null;
  if (remaining !== null && remaining <= 30 && live.announcedM !== live.m) {
    live.announcedM = live.m;
    speak(`${L.turnWord(ROUTE.steps[ROUTE.maneuvers[live.m]].turn)} in about ${Math.round(remaining / 5) * 5} metres.`);
  }
  const destM = live.smooth ? L.distanceM(live.smooth, DEST) : NaN;
  const view = L.escortView({
    nowMs: now,
    now: new Date(now),
    route: ROUTE,
    m: live.m,
    along: live.along,
    hasFix: live.hasFix,
    fixAgeMs: live.hasFix ? now - live.lastGoodAt : Infinity,
    movedM: live.movedM,
    directionConfirmed: live.directionConfirmed,
    confirmedAgoMs: live.confirmedAt !== null ? now - live.confirmedAt : null,
    wrongWay: live.wrongWay,
    offRoute: false,
    rerouting: live.rerouting,
    stoppedMs: live.lastMoveAt ? now - live.lastMoveAt : 0,
    returnedAgoMs: live.returnedAt !== null ? now - live.returnedAt : null,
    turnHold: live.turnHold,
    batteryLow: live.batteryLow,
    batteryShown: live.batteryShownAt !== null,
    destM,
    event: TRIP.event ?? null,
    destinationEntry: TRIP.destination.entry,
    nearby: TRIP.nearby,
    sinceNoteMs: now - live.lastNoteAt,
    ended: live.ended,
    speak: voiceOn(),
  });
  showEscort(view, null);
  if (view.moment === "arrived" || view.moment === "early") { stopWatch(); clearInterval(liveTimer); liveTimer = null; }
}

/** Draws one view. `input` is set only for the demo states, which have no live state behind them. */
function showEscort(view, input) {
  if (!$("e-status")) return;
  const status = $("e-status");
  status.className = "esc-status" + (view.moment === "wait" ? " still" : "") + (view.status === "ESCORT ENDED" ? " off" : "");
  $("e-status-t").textContent = view.status;
  drawLine(view.line);
  $("e-foot").style.display = view.status === "ESCORT ENDED" ? "" : "none";
  $("e-more").style.display = view.status === "ESCORT ENDED" ? "none" : "";
  $("e-more").style.visibility = view.status === "ESCORT ENDED" ? "hidden" : "visible";
  if (view.moment !== shownMoment) {
    shownMoment = view.moment;
    renderCaption(view.caption);
    if (view.voice) speak(view.caption ? view.caption.text : "");
    if (view.buzz) buzz();
    if (view.moment !== "straight" || view.moment === "reassure") live.lastNoteAt = Date.now();
  } else {
    // Same moment: only the small facts line can change (the metres count down); no re-animation.
    const sub = $("e-cap")?.querySelector(".cap-sub");
    if (sub && view.caption?.sub && sub.textContent !== view.caption.sub) sub.textContent = view.caption.sub;
  }
  renderLeft(input);
}

function renderCaption(c) {
  const el = $("e-cap");
  if (!el) return;
  el.classList.remove("on");
  if (!c) { el.innerHTML = ""; return; }
  const word = c.kind === "word" ? `<p class="cap-word">${escapeText(c.text)}</p>` : "";
  const hand = c.kind === "hand" ? `<p class="cap-hand" style="white-space:pre-line;font-size:${c.fs || "2.35rem"}">${escapeText(c.text)}</p>` : "";
  const stamp = c.stamp ? `<p style="margin:22px 0 0"><span class="rubber stamp-in">${escapeText(c.stamp)}</span></p>` : "";
  const sub = c.sub ? `<p class="cap-sub">${escapeText(c.sub)}</p>` : "";
  const action = c.action ? `<a class="action" href="${escapeText(c.action.href)}">${escapeText(c.action.label)}</a>` : "";
  el.innerHTML = word + hand + stamp + sub + action;
  requestAnimationFrame(() => el.classList.add("on"));
}

const LINE_CLASSES = ["stem", "dashed", "dim"];
function drawLine(line) {
  const stem = $("e-stem");
  if (!stem) return;
  const k = line.kind;
  stem.setAttribute("class", "stem" + (k === "dashed" ? " dashed" : "") + (k === "dim" ? " dim" : ""));
  stem.style.transform = `scaleY(${k === "gone" ? 0 : line.stemScale ?? 1})`;
  $("e-bend-g").style.transform = `translateY(${line.bendY || 0}px)`;
  $("e-bend").classList.toggle("on", k === "soon" || k === "reroute");
  $("e-hook").classList.toggle("on", k === "hook");
  $("e-arrive").classList.toggle("on", k === "gate");
  $("e-gate").classList.toggle("on", k === "gate");
  $("e-loop").classList.toggle("on", k === "loop");
  $("e-ghost").classList.toggle("on", k === "reroute");
  $("e-drop").classList.toggle("on", k === "finding");
  $("e-you").style.opacity = k === "finding" || k === "gone" ? 0 : 1;
  void LINE_CLASSES;
}

function renderLeft(input) {
  const left = $("e-left");
  if (!left) return;
  const along = input ? input.along : live.along;
  const remainingM = Math.max(0, ROUTE.lengthM - along);
  const minutes = Math.max(1, Math.ceil(remainingM / (L.TUNE.walkMps * 60)));
  left.textContent = remainingM > 0 ? `${minutes} min left` : "Arrived";
  $("e-left-sub").textContent = `${Math.round(remainingM)} M · ARRIVE ${L.clock(new Date(Date.now() + minutes * 60000))}`;
  drawDot();
}

function drawDot() {
  if (!moreMap || !live.smooth) return;
  const src = moreMap.getSource("dot");
  src?.setData({ type: "Feature", geometry: { type: "Point", coordinates: [live.smooth.lng, live.smooth.lat] } });
  const done = ROUTE.points.filter((_, i) => ROUTE.cum[i] <= live.along).map((p) => [p.lng, p.lat]);
  moreMap.getSource("done")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: done.length >= 2 ? done : [[live.smooth.lng, live.smooth.lat], [live.smooth.lng, live.smooth.lat]] } });
  moreMap.easeTo({ center: [live.smooth.lng, live.smooth.lat], bearing: live.heading ?? 0, duration: 400 });
}

// ---------- voice, haptics, screen awake, return ----------
/** A short buzz at a turn where the phone allows it (Android, after a tap). Silent everywhere else. */
function buzz() {
  try {
    if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate([120, 80, 120]);
  } catch { /* not allowed here: nothing to do */ }
}

let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  try { speechSynthesis.speak(new SpeechSynthesisUtterance("")); speechUnlocked = true; } catch { /* no speech here */ }
}
function speak(text) {
  if (!text || !voiceOn() || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch { /* silent degrade */ }
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && live.active && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch { /* refused or unsupported: fine */ }
}
function releaseWake() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { live.hiddenAt = Date.now(); return; }
  if (!live.active) return;
  keepAwake();
  if (live.hiddenAt && Date.now() - live.hiddenAt > 10000) {
    live.returnedAt = Date.now();
    startWatch();
    live.lastNoteAt = Date.now();
  }
  tick();
});

// Each route change saves the place the user is at (the step, and the escort's pointer).
window.addEventListener("pagehide", () => {
  session.set(STATE_KEY, JSON.stringify({ m: live.m, along: live.along }));
});

// ---------- start ----------
const CHOICE_CHECK_MS = 60000;
setInterval(() => { if (currentScreen === "escort") applyTheme("escort"); }, CHOICE_CHECK_MS);
window.addEventListener("storage", (e) => { if (e.key === "reason-theme") applyTheme(currentScreen === "escort" ? "escort" : "route"); });

// A walk too long to walk: the ride screen first, once, on a fresh visit with no hash.
if (!location.hash && TRIP.walk.meters > L.TUNE.tooFarM) location.replace("#toofar");
// Resume place: if the page was left mid-escort, the saved pointer carries over.
try {
  const saved = JSON.parse(session.get(STATE_KEY) || "null");
  if (saved && Number.isFinite(saved.m)) { live.m = saved.m; live.along = saved.along; }
} catch { /* ignore */ }
go();
