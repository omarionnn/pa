// The walking directions page's script, served as /d/app.js (src/pages/directions.js draws the page).
//
// Two kinds of code live here. The functions at the top are pure: numbers in, numbers out. They do the
// geometry (where you are against the route, how far to the next turn, which way you are facing), the
// line's shape, the sunset and the escort's decisions. test/directions.test.js runs them under Node.
// The DOM part at the bottom only runs in a browser, when there is a document.
//
// The route is embedded by the server when the page is made (one routing call, see directions.js). The
// phone only compares its own position to that route. Position never leaves the phone except as a
// reroute request to Reason's own server, which holds the routing key.

// ---------- constants (the design's numbers, PROMPT.md) ----------
export const PX_M = 1.9;                 // one map pixel is this many metres in the map frame
export const DEST_PX = { x: 170, y: 72 }; // the destination sits here in the map frame, north up
export const ACC_MAX = 35;               // readings less accurate than this are ignored
export const JUMP_M = 60;                // a reading this far from the last good one, this fast, is a jump
export const OFF_M = 40;                 // further than this from the route...
export const OFF_COUNT = 3;              // ...on this many good readings in a row, reroute
export const REROUTE_GAP_MS = 15000;     // never ask for a second reroute sooner than this
export const STEP_NEAR_M = 20;           // a maneuver is passed within this many metres
export const SOON_M = 100;               // the bend starts to show this far out
export const SAY_M = 30;                 // spoken about this far out
export const ARRIVE_M = 50;              // the gate shows inside this
export const ARRIVED_M = 15;             // arrival is confirmed inside this, on 3 readings...
export const ARRIVE_HOLD_MS = 3000;      // ...or on one, held this long
export const SHARP_M = 20;               // a reading this accurate counts for arrival on its own
export const WAIT_MS = 45000;            // no movement this long = waiting
export const LOST_FIX_MS = 60000;        // no good reading this long = finding you (a still phone may send nothing new)
export const ADVANCE_OFF_M = 30;         // a turn is only reached from on the route, never from the street one block over
export const LEG_M = 8;                  // direction is judged on legs of this length
export const WALK_MPS = 1.3;             // for "minutes left"
export const LONG_WALK_M = 2000;         // beyond this the page opens on "too far to walk"

const R = 6371000;
const RAD = Math.PI / 180;

// ---------- geometry ----------
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from north, 0 to 360. */
export function bearing(a, b) {
  const dLng = (b.lng - a.lng) * RAD;
  const y = Math.sin(dLng) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLng);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** The smallest difference between two bearings, 0 to 180. */
export function angleDiff(a, b) {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
}

/** Metres east (x) and north (y) of point p, measured from origin o. */
export function toMetres(p, o) {
  return { x: (p.lng - o.lng) * RAD * R * Math.cos(o.lat * RAD), y: (p.lat - o.lat) * RAD * R };
}

export function fromMetres(m, o) {
  return { lat: o.lat + m.y / (RAD * R), lng: o.lng + m.x / (RAD * R * Math.cos(o.lat * RAD)) };
}

/** A point in the map frame: the destination is DEST_PX, north is up, PX_M metres a pixel. */
export function toPx(p, dest) {
  const m = toMetres(p, dest);
  return { x: DEST_PX.x + m.x / PX_M, y: DEST_PX.y - m.y / PX_M };
}

export function fromPx(px, dest) {
  return fromMetres({ x: (px.x - DEST_PX.x) * PX_M, y: (DEST_PX.y - px.y) * PX_M }, dest);
}

/** A route: its points, and the distance along it to each point. */
export function lineOf(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  return { points, cum, total: cum[cum.length - 1] || 0 };
}

/**
 * Where p sits against the route: `off` metres from it, `along` metres from its start, on segment `seg`
 * (heading `bearing`), and the nearest point on it `at`.
 */
export function project(p, line) {
  let best = null;
  const pts = line.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const A = toMetres(pts[i], p);
    const B = toMetres(pts[i + 1], p);
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(A.x * dx + A.y * dy) / len2));
    const cx = A.x + t * dx, cy = A.y + t * dy;
    const off = Math.hypot(cx, cy);
    if (!best || off < best.off) {
      const segLen = line.cum[i + 1] - line.cum[i];
      best = {
        off,
        along: line.cum[i] + t * segLen,
        seg: i,
        bearing: bearing(pts[i], pts[i + 1]),
        at: fromMetres({ x: cx, y: cy }, p),
      };
    }
  }
  return best || { off: Infinity, along: 0, seg: 0, bearing: 0, at: p };
}

/** The route as map pixels, for the SVG stand-in map. */
export function routePx(line, dest) {
  return line.points.map((p) => toPx(p, dest));
}

// ---------- the line ----------
/**
 * The ink line's shape for a distance to the next turn (metres). Over SOON_M the line is straight. From
 * SOON_M to STEP_NEAR_M the corner slides from its start point down to the dot. The stem is the part of
 * the line below the corner; bendY is how far the corner has moved down.
 */
export function lineForDistance(d) {
  if (d > SOON_M) return { state: 'straight', stem: 'scaleY(1)', bendY: 0 };
  const t = Math.min(1, Math.max(0, (SOON_M - d) / 80));
  const corner = 150 + t * 170;
  return { state: t >= 1 ? 'here' : 'soon', stem: 'scaleY(' + ((400 - corner) / 370).toFixed(3) + ')', bendY: Math.round(corner - 150) };
}

// ---------- sunrise and sunset (suncalc, served by Reason as /d/vendor/suncalc.js) ----------
/**
 * True before sunrise and after sunset at the place. Escort goes Night then, unless the person chose.
 * getTimes is suncalc's getTimes(date, lat, lng); with no getTimes, or a polar day it cannot answer, null.
 */
export function isNightAt(lat, lng, date, getTimes) {
  if (typeof getTimes !== 'function') return null;
  const t = getTimes(date, lat, lng);
  const ok = t && t.sunrise instanceof Date && t.sunset instanceof Date && !isNaN(t.sunrise) && !isNaN(t.sunset);
  if (!ok) return null;
  return date < t.sunrise || date > t.sunset;
}

// ---------- the map's look (MapLibre, a style built from the tokens; no tiles, no key) ----------
/** Each theme's map colours. The CSS variables of the same names in directions.css must agree (a test holds them). */
export const MAP_THEMES = Object.freeze({
  paper: Object.freeze({ land: '#ede5d8', road: '#faf6ee', casing: '#d4c9b5', label: '#78705f', water: '#e1d9cc', park: '#ddd5c7', route: '#9c3b2e', text: '#2a2520', paper: '#faf6ee' }),
  night: Object.freeze({ land: '#151210', road: '#27211b', casing: '#3e362c', label: '#a89d88', water: '#1c1916', park: '#1f1c18', route: '#d46a5c', text: '#efe6d6', paper: '#27211b' }),
});

/** One map pixel of the design is this many metres: widths in the design's map are kept in metres, so they scale with zoom. */
const DESIGN_M = PX_M;
/** A line width for `metres` on the ground at latitude `lat`, as a MapLibre zoom expression. */
export function metresWide(metres, lat) {
  const mpp = (z) => (40075016.686 * Math.cos(lat * RAD)) / (512 * Math.pow(2, z));
  return ['interpolate', ['exponential', 2], ['zoom'], 10, metres / mpp(10), 22, metres / mpp(22)];
}

/** Which colour each layer's paint takes, by theme key. The style and the theme switch both read this. */
export const MAP_PAINT = Object.freeze([
  ['land', 'background-color', 'land'],
  ['water', 'fill-color', 'water'],
  ['parks', 'fill-color', 'park'],
  ['minor-case', 'line-color', 'casing'],
  ['major-case', 'line-color', 'casing'],
  ['minor', 'line-color', 'road'],
  ['major', 'line-color', 'road'],
  ['old', 'line-color', 'label'],
  ['done', 'line-color', 'label'],
  ['route', 'line-color', 'route'],
]);

/**
 * The style for a theme. `shapes` is the trip's map ({ major, minor, parks, water } in [lng, lat]) and the
 * route line; the sources hold them from the start, so the map needs nothing from the network.
 */
export function mapStyle(theme, lat, shapes) {
  const t = MAP_THEMES[theme] || MAP_THEMES.paper;
  const lines = (arr) => ({ type: 'geojson', data: { type: 'FeatureCollection', features: (arr || []).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) } });
  const polys = (arr) => ({ type: 'geojson', data: { type: 'FeatureCollection', features: (arr || []).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [c] } })) } });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  const w = (designPx) => metresWide(designPx * DESIGN_M, lat);
  const layers = [
    { id: 'land', type: 'background', paint: {} },
    { id: 'water', type: 'fill', source: 'water', paint: {} },
    { id: 'parks', type: 'fill', source: 'parks', paint: {} },
    { id: 'minor-case', type: 'line', source: 'minor', layout: round, paint: { 'line-width': w(9) } },
    { id: 'major-case', type: 'line', source: 'major', layout: round, paint: { 'line-width': w(15) } },
    { id: 'minor', type: 'line', source: 'minor', layout: round, paint: { 'line-width': w(6.5) } },
    { id: 'major', type: 'line', source: 'major', layout: round, paint: { 'line-width': w(12) } },
    { id: 'old', type: 'line', source: 'old', layout: round, paint: { 'line-width': w(3), 'line-dasharray': [0.7, 2.3], 'line-opacity': 0.7 } },
    { id: 'route', type: 'line', source: 'route', layout: round, paint: { 'line-width': w(3.6) } },
    { id: 'done', type: 'line', source: 'done', layout: round, paint: { 'line-width': w(2.6), 'line-opacity': 0.45 } },
  ];
  for (const [id, prop, key] of MAP_PAINT) layers.find((l) => l.id === id).paint[prop] = t[key];
  return {
    version: 8,
    name: 'reason-directions-' + theme,
    sources: {
      water: polys(shapes.water), parks: polys(shapes.parks), minor: lines(shapes.minor), major: lines(shapes.major),
      route: lines([shapes.route]), done: lines([]), old: lines([]),
    },
    layers,
  };
}

// ---------- turns and words ----------
/** left | right | roundabout | straight, from a step. The page never says a street it does not know. */
export function turnOf(step) {
  if (step.turn) return step.turn;
  const s = (step.instr || '').toLowerCase();
  if (/roundabout/.test(s)) return 'roundabout';
  if (/\bleft\b/.test(s)) return 'left';
  if (/\bright\b/.test(s)) return 'right';
  return 'straight';
}

export function turnWord(step) {
  const t = turnOf(step);
  return t === 'straight' ? 'Straight on' : t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- the escort engine ----------
/**
 * The escort's decisions. Feed it each GPS reading with feed(); ask it for the screen's state with
 * view(now) at any time (a one-second tick does that, so timed states such as "here" end on time).
 *
 * trip: { destination, steps: [{lat,lng,...}], startsAt? }, line: lineOf(route points).
 */
export function createEscort(trip, line) {
  const m = {
    trip,
    dest: trip.destination,
    line,
    steps: [],
    step: 0,
    hereStep: 0,
    hereUntil: 0,
    buf: [],
    pos: null,
    lastRead: null,
    lastRaw: null,
    lastGood: 0,
    start: null,
    path: 0,
    anchor: null,
    anchorT: 0,
    heading: null,
    compass: null,
    dir: 'unknown',
    confirmedAt: 0,
    wrong: 0,
    offCount: 0,
    rerouting: false,
    rerouteShowUntil: 0,
    lastReroute: -Infinity,
    welcomeUntil: 0,
    batteryUntil: 0,
    offline: false,
    straightSince: null,
    reassureUntil: 0,
    reassuredAt: -Infinity,
    arrivedCount: 0,
    insideSince: 0,
    arrived: false,
    ended: false,
    batteryShown: false,
    spoken: {},
    pr: null,
    dd: Infinity,
  };

  function setSteps(steps, ln) {
    m.steps = steps;
    for (const s of steps) s.along = project(s, ln).along;
  }
  setSteps(trip.steps, line);

  function lastStep() { return m.steps.length - 1; }

  function feed(r, now) {
    let reroute = false, buzz = false, speak = null;
    if (r && typeof r.acc === 'number' && r.acc <= ACC_MAX && isFinite(r.lat) && isFinite(r.lng)) {
      const p = { lat: r.lat, lng: r.lng };
      // A jump is judged reading to reading: the smoothed dot trails a walk, so it is never the yardstick.
      const jump = m.lastRaw && now - m.lastRaw.t < 4000 && haversine(m.lastRaw.p, p) > JUMP_M;
      if (!jump) {
        m.buf.push(p);
        if (m.buf.length > 3) m.buf.shift();
        const s = {
          lat: m.buf.reduce((a, q) => a + q.lat, 0) / m.buf.length,
          lng: m.buf.reduce((a, q) => a + q.lng, 0) / m.buf.length,
        };
        if (typeof r.compass === 'number') m.compass = r.compass;
        if (!m.start) { m.start = s; m.anchor = s; m.anchorT = now; }
        if (m.lastRead) m.path += haversine(m.lastRead.p, s);
        m.lastRead = { p: s, t: now };
        m.lastRaw = { p, t: now };
        m.lastGood = now;
        m.pos = s;
        m.pr = project(s, m.line);
        m.dd = haversine(s, m.dest);

        // Direction: judged leg by leg (LEG_M). The route's bearing where we are against the walk's.
        if (haversine(m.anchor, s) >= LEG_M) {
          m.heading = bearing(m.anchor, s);
          const diff = angleDiff(m.heading, m.pr.bearing);
          if (diff <= 70) {
            m.wrong = 0;
            if (m.dir !== 'confirmed') { m.dir = 'confirmed'; m.confirmedAt = now; }
          } else if (diff >= 120 && m.path >= 15) {
            m.wrong++;
            if (m.wrong >= 2) m.dir = 'around';
          }
          m.anchor = s;
          m.anchorT = now;
        }

        // Off the route: three good readings in a row, then one reroute request. Counted on each reading as it
        // came (the smoothed dot trails a real walk off the line by a few readings), and only when the reading is
        // past the band by half its own accuracy, so a noisy fix at the edge is not taken for a wrong turn.
        m.offCount = project(p, m.line).off - r.acc / 2 > OFF_M ? m.offCount + 1 : 0;
        if (m.offCount >= OFF_COUNT && !m.rerouting && now - m.lastReroute > REROUTE_GAP_MS) {
          m.rerouting = true;
          m.lastReroute = now;
          reroute = true;
        }

        // Turns: pass a maneuver within STEP_NEAR_M and the next one becomes current.
        const cur = m.steps[m.step];
        if (cur && m.pr.off <= ADVANCE_OFF_M) {
          const dNext = cur.along - m.pr.along;
          if (m.step < lastStep() && dNext <= STEP_NEAR_M) {
            m.hereStep = m.step;
            m.step++;
            // A turn gets its moment (caption, voice, buzz); passing a straight-on step is silent.
            if (turnOf(cur) !== 'straight') { m.hereUntil = now + 5000; buzz = true; speak = turnWord(cur) + ' here.'; }
          } else if (m.step < lastStep() && turnOf(cur) !== 'straight' && dNext <= SAY_M && !m.spoken[m.step]) {
            m.spoken[m.step] = true;
            speak = turnWord(cur) + ' in about thirty metres.';
          }
        }

        // Arrival: three readings inside ARRIVED_M, or one that stays there ARRIVE_HOLD_MS (a phone standing still
        // at the gate often sends nothing new: the view below finishes it on the clock).
        // Inside the gate: the smoothed dot, or this reading itself when it is sharp (the dot lags a walk that
        // has just stopped, and a phone standing still may send nothing more to pull it in).
        const inside = m.dd <= ARRIVED_M || (r.acc <= SHARP_M && haversine(p, m.dest) <= ARRIVED_M);
        m.arrivedCount = inside ? m.arrivedCount + 1 : 0;
        m.insideSince = inside ? (m.insideSince || now) : 0;
        if (m.arrivedCount >= 3) m.arrived = true;
      }
    }
    const v = view(now);
    v.reroute = reroute;
    v.buzz = buzz;
    v.speak = speak;
    return v;
  }

  function view(now) {
    if (m.straightSince === null) m.straightSince = now;
    const pr = m.pr;
    const cur = m.steps[m.step];
    const hasFix = !!m.pos && now - m.lastGood <= LOST_FIX_MS;
    const base = {
      stepNo: m.step,
      hereStep: m.hereStep,
      dNext: null,
      remainingM: pr ? Math.max(0, m.line.total - pr.along) : null,
      minsLeft: null,
      dd: m.dd,
      user: m.pos,
      heading: m.heading ?? m.compass,
      status: 'ESCORTING',
      reroute: false,
      buzz: false,
      speak: null,
    };
    if (base.remainingM !== null) base.minsLeft = Math.max(1, Math.ceil(base.remainingM / WALK_MPS / 60));
    if (!m.arrived && m.insideSince && hasFix && now - m.insideSince >= ARRIVE_HOLD_MS) m.arrived = true;

    if (m.arrived) {
      const early = typeof trip.startsAt === 'number' && now < trip.startsAt - 10 * 60000;
      return { ...base, state: early ? 'early' : 'arrived', status: 'ESCORT ENDED', ended: true, remainingM: 0, minsLeft: 0 };
    }
    if (m.ended) return { ...base, state: 'ended', status: 'ESCORT ENDED', ended: true };

    const dNext = cur && m.pr && m.step < lastStep() ? cur.along - pr.along : null;
    base.dNext = dNext;
    const stationary = hasFix && now - m.anchorT > WAIT_MS;
    let state;
    // One loud thing, by what matters most on the street: a turn is never hidden behind a note about the
    // phone (battery, signal, coming back). The new-way note shows only once a new way has come back.
    if (!hasFix) state = 'finding';
    else if (m.dd < ARRIVE_M) state = 'arrive';
    else if (now < m.rerouteShowUntil) state = 'reroute';
    else if (now < m.hereUntil) state = 'here';
    else if (m.dir === 'around') state = 'around';
    else if (m.dir === 'unknown') state = 'unknown';
    else if (stationary) state = 'wait';
    else if (dNext !== null && dNext <= SOON_M && turnOf(cur) !== 'straight') state = 'soon';
    else if (now < m.batteryUntil) state = 'battery';
    else if (m.offline) state = 'lost';
    else if (now < m.welcomeUntil) state = 'welcome';
    else if (now - m.confirmedAt < 4000) state = 'confirmed';
    else if (now < m.reassureUntil) state = 'reassure';
    else state = 'straight';

    if (state !== 'straight' && state !== 'reassure') m.straightSince = now;
    if (state === 'straight' && now - m.straightSince > 240000 && now - m.reassuredAt > 240000) {
      m.reassuredAt = now;
      m.reassureUntil = now + 5000;
      state = 'reassure';
    }
    if (state === 'wait') base.status = 'WAITING';
    if (state === 'finding') base.status = 'FINDING YOU';
    return { ...base, state };
  }

  return {
    feed,
    view,
    get step() { return m.step; },
    /** The person is in the middle of a walk: the reroute has come back with a new line. */
    replaceRoute(newTrip, newLine, pos, now) {
      m.line = newLine;
      m.trip = newTrip;
      setSteps(newTrip.steps, newLine);
      const pr = project(pos, newLine);
      const next = m.steps.findIndex((s) => s.along > pr.along - 5);
      m.step = next < 0 ? lastStep() : next;
      m.spoken = {};
      m.hereUntil = 0;
      m.rerouting = false;
      m.rerouteShowUntil = now + 6000;
      m.offCount = 0;
      m.wrong = 0;
      m.dir = 'confirmed';
      m.confirmedAt = now;
    },
    rerouteFailed() { m.rerouting = false; },
    setOffline(v) { m.offline = !!v; },
    /** Low battery: said once an escort, for a few seconds. */
    notifyBattery(now) { if (!m.batteryShown) { m.batteryShown = true; m.batteryUntil = now + 8000; } },
    /** END ESCORT: over, with no arrival claimed. */
    end() { m.ended = true; },
    welcomeBack(now) { m.welcomeUntil = now + 6000; },
    /** Switching back from Route: the direction is unknown again, the step is kept. */
    resumeFromRoute() { m.dir = 'unknown'; m.anchor = null; m.start = null; m.buf = []; m.path = 0; m.pos = null; m.lastRead = null; m.lastRaw = null; m.lastGood = 0; },
  };
}

// ---------- the browser ----------
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

if (IS_BROWSER) boot();

function boot() {
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const T = JSON.parse($('trip').textContent);
  const DEST = T.destination;
  let LINE = null;
  /** The route on screen. Called again after every reroute. */
  function setRoute(line) {
    LINE = line;
  }
  setRoute(lineOf(T.route));
  const ENG = createEscort(T, LINE);
  const SUPPORT = {
    geo: 'geolocation' in navigator,
    wake: 'wakeLock' in navigator,
    speech: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    buzz: 'vibrate' in navigator,
    orient: 'DeviceOrientationEvent' in window,
  };
  let live = null;            // { watchId, wake, orient } while tracking
  let lastFix = null;         // the last good position, for the theme and the map
  let demo = null;            // { timer, idx, more }
  let voiceOn = SUPPORT.speech;
  let escortEl = null;        // the escort screen's element, while it is on screen
  let lastCap = {};           // caption text per state, so only changed text is rewritten
  let lastRoute = null;
  let themeTimer = null;

  // ----- small helpers -----
  const h = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode: keep it for this page */ } };
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

  // ----- theme: Route follows the person or the system; Escort goes Night after sunset -----
  function userPick() {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'night' || q === 'paper') return q;
    // The one theme choice every Reason page on this host shares ('light' or 'dark'; none = follow along).
    const s = lsGet('reason-theme');
    return s === 'dark' ? 'night' : s === 'light' ? 'paper' : null;
  }
  // suncalc, for sunset where the person is. Until it loads (or if it cannot), Escort follows the phone's setting.
  let SUN = null;
  import('/d/vendor/suncalc.js').then((m) => { SUN = m.getTimes; if (location.hash.startsWith('#escort')) applyTheme('escort'); }, () => {});
  function wantedTheme(kind) {
    const pick = userPick();
    if (pick) return pick;
    if (kind === 'escort') {
      const at = lastFix || DEST;
      const night = isNightAt(at.lat, at.lng, new Date(), SUN);
      if (night !== null) return night ? 'night' : 'paper';
    }
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
  }
  function applyTheme(kind) {
    const t = wantedTheme(kind);
    document.documentElement.className = t;
    app.className = 'screen ' + t;
    for (const m of [routeMap, moreMap]) if (m && m.map) paintMap(m, t);
    return t;
  }

  // ----- the map: MapLibre, drawn only from the trip (no tiles, no key), loaded when a map is first shown -----
  let MAPLIB = null;
  function loadMapLib() {
    if (!MAPLIB) MAPLIB = import('/d/vendor/maplibre-gl.mjs');
    return MAPLIB;
  }
  const lngLat = (p) => [p.lng, p.lat];
  const routeCoords = () => LINE.points.map(lngLat);
  function routeBounds() {
    const pts = LINE.points.concat([DEST]);
    return [[Math.min(...pts.map((p) => p.lng)), Math.min(...pts.map((p) => p.lat))], [Math.max(...pts.map((p) => p.lng)), Math.max(...pts.map((p) => p.lat))]];
  }
  /** Design pixels per screen pixel at a zoom: the markers grow and shrink with the map, as the prototype's do. */
  function designScale(zoom) {
    const mpp = (40075016.686 * Math.cos(DEST.lat * Math.PI / 180)) / (512 * Math.pow(2, zoom));
    return PX_M / mpp;
  }
  function markEl(cls, svg, w, hgt) {
    const el = document.createElement('div');
    el.className = 'm-mark ' + cls;
    el.innerHTML = '<svg viewBox="' + (-w / 2) + ' ' + (-hgt / 2) + ' ' + w + ' ' + hgt + '" width="' + w + '" height="' + hgt + '" aria-hidden="true" style="overflow:visible">' + svg + '</svg>';
    return el;
  }
  function labelEl(text) {
    const el = document.createElement('div');
    el.className = 'm-mark m-lbl-h';
    el.textContent = text;
    return el;
  }
  /**
   * A map in `el`. Resolves to a handle, or rejects when the phone cannot draw it (no WebGL): the caller then
   * shows a quiet line instead; the steps never depend on the map.
   */
  async function makeMap(el, opts) {
    const lib = await loadMapLib();
    const theme = document.documentElement.className === 'night' ? 'night' : 'paper';
    const shapes = { ...(T.map || {}), route: routeCoords() };
    const map = new lib.Map({
      container: el, style: mapStyle(theme, DEST.lat, shapes), bounds: routeBounds(), fitBoundsOptions: { padding: opts.pad || 40 },
      interactive: !!opts.interactive, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      attributionControl: false, fadeDuration: 0, renderWorldCopies: false,
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('map did not load')), 8000);
        map.once('load', () => { clearTimeout(timer); resolve(); });
        map.once('error', (e) => { if (!map.loaded()) { clearTimeout(timer); reject(e && e.error ? e.error : new Error('map error')); } });
      });
    } catch (e) {
      try { map.remove(); } catch (x) { /* already gone */ } // give the WebGL context back (iOS caps how many live)
      throw e;
    }
    const add = (node, at, anchor, offset) => new lib.Marker({ element: node, anchor: anchor || 'center', offset: offset || [0, 0] }).setLngLat(at).addTo(map);
    const scaleIt = () => el.style.setProperty('--mk', designScale(map.getZoom()).toFixed(3));
    map.on('zoom', scaleIt);
    scaleIt();
    for (const p of (T.map && T.map.pois) || []) add(markEl('m-sc', '<rect class="m-poi" x="-7" y="-7" width="14" height="14" rx="2"/><path class="m-poi-mark" d="M0,-3.5 V3.5 M-3.5,0 H3.5"/>', 14, 14), lngLat(p));
    const handle = { map, lib, el, add, markers: {}, theme };
    if (opts.labels) {
      for (const l of (T.map && T.map.labels) || []) add(labelEl(l.text), lngLat(l), 'bottom-left');
      add(labelEl(T.name.toUpperCase()), lngLat(DEST), 'bottom-left', [14, -4]);
    }
    handle.markers.start = add(markEl('m-sc', '<circle class="m-start" r="5"/>', 14, 14), routeCoords()[0]);
    add(markEl('m-sc', '<circle class="m-dest" r="6"/><circle class="m-dest-in" r="2"/>', 18, 18), lngLat(DEST));
    return handle;
  }
  /** Recolours a map for the theme, in step with the page's 3 s fade (MapLibre has no CSS: it is set here). */
  function paintMap(handle, theme) {
    if (!handle || handle.theme === theme) return;
    handle.theme = theme;
    const t = MAP_THEMES[theme] || MAP_THEMES.paper;
    try { for (const [id, prop, key] of MAP_PAINT) handle.map.setPaintProperty(id, prop, t[key]); } catch (e) { /* the map went away */ }
  }
  /** The route draws itself in ink on load, about 1.8 s, after a short beat. Reduced motion: drawn at rest. */
  function drawRouteIn(handle) {
    const all = routeCoords();
    const src = handle.map.getSource('route');
    if (!src || REDUCED()) return;
    const total = LINE.total || 1;
    const cut = (f) => {
      const want = f * total;
      const out = [all[0]];
      for (let i = 1; i < all.length; i++) {
        if (LINE.cum[i] <= want) { out.push(all[i]); continue; }
        const seg = LINE.cum[i] - LINE.cum[i - 1] || 1;
        const t = (want - LINE.cum[i - 1]) / seg;
        out.push([all[i - 1][0] + (all[i][0] - all[i - 1][0]) * t, all[i - 1][1] + (all[i][1] - all[i - 1][1]) * t]);
        break;
      }
      return out.length > 1 ? out : [all[0], all[0]];
    };
    const t0 = performance.now() + 300;
    const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
    const frame = (now) => {
      if (!handle.map.getSource('route')) return;
      const f = Math.min(1, Math.max(0, (now - t0) / 1800));
      src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: cut(ease(f)) } }] });
      if (f < 1) requestAnimationFrame(frame);
    };
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [all[0], all[0]] } }] });
    requestAnimationFrame(frame);
  }
  const REDUCED = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  /** The route, the walked part and an old route (after a reroute) set on a map. */
  function setLines(handle, done, old) {
    const lines = (arr) => ({ type: 'FeatureCollection', features: arr.filter((c) => c && c.length > 1).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) });
    try {
      handle.map.getSource('route').setData(lines([routeCoords()]));
      handle.map.getSource('done').setData(lines([done]));
      if (old !== undefined) handle.map.getSource('old').setData(lines([old]));
    } catch (e) { /* the map went away */ }
  }

  let routeMap = null;    // the Route screen's map, while it is on screen
  let moreMap = null;     // the MORE sheet's map, while the sheet has been opened
  let oldRoute = null;    // the way before a reroute, drawn as dashes until the walk moves on

  // ----- screens -----
  const screenWrap = (inner) => { app.innerHTML = inner; };
  const dashes = 'border-top:1px dashed var(--border)';

  function renderChoose() {
    const last = lsGet('reason.dir.last') || 'escort';
    const escort = '<a class="choice rise" href="#ask" style="animation-delay:.9s"><span style="display:flex;justify-content:space-between;align-items:baseline;gap:12px"><span class="serif" style="font-size:34px;line-height:1.1">Escort me there →</span>' + (last === 'escort' ? '<span class="label">LAST TIME</span>' : '') + '</span>' +
      '<span style="display:block;margin-top:6px;font-size:18px;line-height:1.45;color:var(--text-2)">Reason walks you there, turn by turn. Uses your location.</span></a>';
    const route = '<a class="choice rise" href="#route" style="border-bottom:1px dashed var(--border);animation-delay:1s"><span style="display:flex;justify-content:space-between;align-items:baseline;gap:12px"><span class="serif" style="display:block;font-size:34px;line-height:1.1">Show me the route →</span>' + (last === 'route' ? '<span class="label">LAST TIME</span>' : '') + '</span>' +
      '<span style="display:block;margin-top:6px;font-size:18px;line-height:1.45;color:var(--text-2)">Read the steps and map at your own pace.</span></a>';
    screenWrap(
      '<p class="label rise" style="position:absolute;top:22px;left:24px;margin:0">DIRECTIONS · MADE ' + h(T.made) + '</p>' +
      '<section style="position:absolute;top:96px;left:24px;right:24px;text-align:center">' +
        '<h1 class="serif rise" style="margin:0;font-size:52px;line-height:1.02;letter-spacing:-.02em;animation-delay:.1s">' + h(T.name) + '</h1>' +
        '<p class="label rise" style="margin:14px 0 0;color:var(--text);animation-delay:.2s">' + h(T.walk) + '</p>' +
        '<p class="rise" style="margin:4px 0 0;font-size:18px;color:var(--text-2);animation-delay:.2s">' + h(T.address) + '</p>' +
      '</section>' +
      '<svg viewBox="0 0 390 200" width="390" height="200" aria-hidden="true" style="position:absolute;top:262px;left:50%;margin-left:-195px;overflow:visible">' +
        '<path class="ink-line draw-once" d="M195,180 V12" pathLength="100"/><circle class="you" cx="195" cy="180" r="11"/></svg>' +
      '<nav aria-label="Choose how to go" style="position:absolute;left:24px;right:24px;top:500px">' +
        (last === 'route' ? route + escort : escort + route) +
      '</nav>' +
      '<p class="label" style="position:absolute;left:24px;right:24px;bottom:22px;margin:0;text-align:center">ONLY YOU CAN SEE THIS PAGE</p>');
    app.querySelectorAll('a[href="#ask"],a[href="#route"]').forEach((a) => a.addEventListener('click', () => lsSet('reason.dir.last', a.getAttribute('href') === '#ask' ? 'escort' : 'route')));
  }

  function renderAsk() {
    screenWrap(
      '<a class="textbtn" href="#choose" style="position:absolute;top:8px;left:20px;color:var(--text-2)">← BACK</a>' +
      '<section style="position:absolute;top:210px;left:24px;right:24px">' +
        '<p class="label rise" style="margin:0 0 16px">ESCORT</p>' +
        '<h1 class="serif rise" style="margin:0;font-size:40px;line-height:1.1;letter-spacing:-.015em;animation-delay:.1s">I need your location to guide you turn by turn.</h1>' +
        '<p class="hand ink" style="margin-top:22px;animation-delay:.5s">It stays on your phone.</p>' +
      '</section>' +
      '<div style="position:absolute;left:24px;right:24px;bottom:40px;display:flex;flex-direction:column;align-items:flex-start;gap:4px">' +
        '<button type="button" class="action rise" id="a-share" style="font-size:34px;animation-delay:.8s">Share my location →</button>' +
        '<a class="textbtn rise" href="#route" id="a-not" style="padding-left:0;color:var(--text-2);animation-delay:.9s">NOT NOW · SHOW THE ROUTE</a>' +
      '</div>' +
      '<p class="label" style="position:absolute;left:24px;right:24px;bottom:10px;margin:0;font-size:.56rem;opacity:.8">LOCATION IS USED ON THIS PHONE. IT GOES TO REASON ONLY TO FIND A NEW WAY.</p>');
    // Both permissions are asked in this one tap (iOS needs the orientation request inside a gesture).
    $('a-share').addEventListener('click', () => startLive(true));
    $('a-not').addEventListener('click', () => { lsSet('reason.dir.last', 'route'); });
  }

  function renderTooFar() {
    const far = T.far || { walk: T.walk, drive: '' };
    const mapsUrl = (mode) => (/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? 'https://maps.apple.com/?daddr=' : 'https://www.google.com/maps/dir/?api=1&destination=') +
      (/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? DEST.lat + ',' + DEST.lng + '&dirflg=' + mode : DEST.lat + ',' + DEST.lng + '&travelmode=' + (mode === 'd' ? 'driving' : 'walking'));
    screenWrap(
      '<p class="label rise" style="position:absolute;top:22px;left:24px;margin:0">DIRECTIONS · MADE ' + h(T.made) + '</p>' +
      '<section style="position:absolute;top:96px;left:24px;right:24px;text-align:center">' +
        '<h1 class="serif rise" style="margin:0;font-size:40px;line-height:1.04;letter-spacing:-.02em;animation-delay:.1s">' + h(T.name) + '</h1>' +
        '<p class="label rise" style="margin:12px 0 0;color:var(--text);animation-delay:.2s">' + h(far.walk) + '</p></section>' +
      '<div style="position:absolute;top:300px;left:24px;right:24px;text-align:center"><p class="hand ink" style="font-size:3rem;line-height:1.05;animation-delay:.4s">That’s a long walk.<br>Want a ride instead?</p></div>' +
      '<div style="position:absolute;left:24px;right:24px;bottom:40px;display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center">' +
        '<a class="action rise" href="' + h(mapsUrl('d')) + '" style="font-size:34px;animation-delay:1s">Open in Maps →</a>' +
        (far.drive ? '<p class="label rise" style="margin:0 0 10px;animation-delay:1s">' + h(far.drive) + '</p>' : '') +
        '<a class="textbtn rise" href="#ask" style="color:var(--text-2);animation-delay:1.1s">WALK ANYWAY</a></div>');
  }

  function renderRoute(opts) {
    const st = { open: !!opts.open, sel: opts.sel || 0 };
    const mapH = opts.note ? 380 : 430;
    const stepsHtml = T.steps.map((s, k) =>
      '<li style="' + dashes + '"><button type="button" data-step="' + (k + 1) + '" style="all:unset;box-sizing:border-box;display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:2px 10px;width:100%;min-height:48px;padding:11px 0;cursor:pointer">' +
        '<span style="font-family:var(--mono);font-weight:700;font-size:.78rem;color:var(--stamp);padding-top:5px">' + h(s.n) + '</span>' +
        '<span><span style="display:block;font-family:var(--serif);font-style:italic;font-size:22px;line-height:1.12;color:var(--text)">' + h(s.instr) + '</span>' +
        '<span style="display:block;margin-top:2px;font-size:14px;line-height:1.4;color:var(--text-2)">' + h(s.mark) + '</span></span>' +
        '<span style="font-family:var(--mono);font-size:.8rem;color:var(--text);padding-top:5px;white-space:nowrap">' + h(s.d) + '</span></button></li>').join('');
    const mapsApple = 'https://maps.apple.com/?daddr=' + DEST.lat + ',' + DEST.lng + '&dirflg=w';
    const mapsGoogle = 'https://www.google.com/maps/dir/?api=1&destination=' + DEST.lat + ',' + DEST.lng + '&travelmode=walking';
    screenWrap(
      '<header class="top">' + wordmark() + '<a class="textbtn" href="#ask" style="padding-right:0">ESCORT ME →</a></header>' +
      (opts.note ? '<div style="padding:20px 24px 0"><p class="hand ink">No problem, here’s the Route version.</p></div>' : '') +
      '<section style="padding:20px 24px 0"><h1 class="serif" style="margin:0;font-size:40px;line-height:1.04;letter-spacing:-.02em">' + h(T.name) + '</h1>' +
        '<p class="label" style="margin:8px 0 0;color:var(--text)">' + h(T.walk) + '</p></section>' +
      '<div class="mapbox" style="margin-top:18px;height:' + mapH + 'px" role="img" aria-label="Map of the route"><div id="r-map" style="width:100%;height:100%"></div></div>' +
      '<div id="r-cta" style="position:absolute;left:24px;right:24px;bottom:16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><button type="button" class="action" id="r-open" style="font-size:30px">See the steps ↑</button><span class="label">' + T.steps.length + ' STEPS</span></div>' +
        '<p class="label" style="margin:2px 0 0">ONLY YOU CAN SEE THIS PAGE</p></div>' +
      '<article class="card" id="r-card" style="position:absolute;left:16px;right:16px;bottom:14px;padding:14px 18px 4px" aria-live="polite">' +
        '<p class="label" style="margin:0"><span id="r-n" style="color:var(--stamp);font-weight:700"></span> / 0' + T.steps.length + ' · <span id="r-d"></span></p>' +
        '<p class="serif" id="r-i" style="margin:4px 0 0;font-size:28px;line-height:1.1"></p>' +
        '<p id="r-m" style="margin:4px 0 0;font-size:15px;line-height:1.45;color:var(--text-2)"></p>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">' +
          '<button type="button" class="textbtn" id="r-prev" style="padding-left:0">← PREV</button>' +
          '<button type="button" class="textbtn" id="r-all">ALL STEPS</button>' +
          '<button type="button" class="textbtn" id="r-next" style="padding-right:0">NEXT →</button></div></article>' +
      '<button type="button" class="scrim" id="r-scrim" aria-label="Close the steps"></button>' +
      '<section class="sheet" id="r-sheet" aria-label="All steps"><span class="grip"></span>' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><p class="label" style="margin:0">THE WAY · TAP A STEP TO SEE IT</p><button type="button" class="textbtn" id="r-close" style="padding-right:0">CLOSE ↓</button></div>' +
        '<ol style="list-style:none;margin:0;padding:0">' + stepsHtml + '</ol>' +
        '<div style="' + dashes + ';padding-top:8px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:15px">' + h(T.address) + '</span>' +
          '<button type="button" class="textbtn" id="r-copy" aria-label="Copy the address" style="padding-right:0">' + ICON.copy + 'COPY</button></div>' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center"><a class="textbtn" href="' + h(mapsApple) + '" style="padding-left:0">APPLE MAPS ↗</a><a class="textbtn" href="' + h(mapsGoogle) + '">GOOGLE MAPS ↗</a></div>' +
      '</section>');

    const q = (id) => $(id);
    function update() {
      q('r-sheet').classList.toggle('on', st.open);
      q('r-scrim').classList.toggle('on', st.open);
      q('r-cta').style.display = st.sel ? 'none' : '';
      q('r-card').style.display = st.sel ? '' : 'none';
      if (st.sel) {
        const s = T.steps[st.sel - 1];
        q('r-n').textContent = s.n; q('r-d').textContent = String(s.d).toUpperCase(); q('r-i').textContent = s.instr; q('r-m').textContent = s.mark;
        q('r-prev').style.visibility = st.sel > 1 ? '' : 'hidden';
        q('r-next').style.visibility = st.sel < T.steps.length ? '' : 'hidden';
      }
      focusMap(st.sel);
    }
    /** The camera glides (0.9 s) to a step and rings it, or back to the whole route. */
    function focusMap(sel) {
      if (!routeMap) return;
      const dur = REDUCED() ? 0 : 900;
      const ring = routeMap.markers.focus;
      if (!sel) {
        routeMap.map.fitBounds(routeBounds(), { padding: 40, duration: dur });
        ring.getElement().firstChild.style.opacity = 0;
        return;
      }
      const s = T.steps[sel - 1];
      const last = sel === T.steps.length;
      const z = routeMap.fitZoom + Math.log2((last ? 3 : 2.4) / designScale(routeMap.fitZoom));
      routeMap.map.easeTo({ center: [s.lng, s.lat], zoom: z, duration: dur });
      ring.setLngLat([s.lng, s.lat]);
      ring.getElement().firstChild.style.opacity = 1;
    }
    const box = q('r-map');
    makeMap(box, { interactive: true, labels: true }).then((m) => {
      if (!document.body.contains(box)) { m.map.remove(); return; }
      routeMap = m;
      m.fitZoom = m.map.getZoom();
      m.markers.focus = m.add(markEl('m-sc m-ring', '<circle class="m-focus" r="15"/>', 34, 34), [DEST.lng, DEST.lat]);
      m.markers.focus.getElement().firstChild.style.opacity = 0;
      if (st.sel) focusMap(st.sel); else drawRouteIn(m);
    }).catch(() => {
      box.innerHTML = '<p class="label" style="padding:16px;margin:0">The map did not load here. The steps have the whole way.</p>';
    });
    q('r-open').onclick = q('r-all').onclick = () => { st.open = true; update(); };
    q('r-close').onclick = q('r-scrim').onclick = () => { st.open = false; update(); };
    q('r-prev').onclick = () => { st.sel = Math.max(1, st.sel - 1); update(); };
    q('r-next').onclick = () => { st.sel = Math.min(T.steps.length, st.sel + 1); update(); };
    q('r-copy').onclick = () => { try { navigator.clipboard.writeText(T.address); } catch (e) { /* no clipboard: nothing to do */ } };
    Array.prototype.forEach.call(app.querySelectorAll('[data-step]'), (b) => {
      b.onclick = () => { st.sel = +b.getAttribute('data-step'); st.open = false; update(); };
    });
    update();
  }

  // ----- Escort: one ink line and one caption -----
  const ICON = {
    speaker: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    copy: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
  };
  function wordmark() {
    return '<span class="wordmark">reas<span class="sr">o</span><svg class="bubble-o" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c4.7 0 8.5 3.2 8.5 7.2s-3.8 7.2-8.5 7.2c-1 0-1.9-.1-2.8-.4L4.5 20l1.3-3.7C4.4 15 3.5 13 3.5 10.7c0-4 3.8-7.2 8.5-7.2z"/></svg>n</span>';
  }

  // Each state's on-screen shape (the line) and its printed or handwritten words, from the prototype.
  const S = {
    finding:   { stem: 'scaleY(0)', drop: true, noYou: true },
    unknown:   { stem: 'scaleY(1)', dashed: true },
    confirmed: { stem: 'scaleY(1)' },
    around:    { stem: 'scaleY(0.405)', hook: true },
    straight:  { stem: 'scaleY(1)' },
    reassure:  { stem: 'scaleY(1)' },
    soon:      { stem: 'scaleY(0.676)', bend: true, bendY: 0 },
    here:      { stem: 'scaleY(0.216)', bend: true, bendY: 170 },
    reroute:   { stem: 'scaleY(0.676)', bend: true, bendY: 0, ghost: true },
    wait:      { stem: 'scaleY(1)', dim: true, still: true },
    welcome:   { stem: 'scaleY(1)' },
    battery:   { stem: 'scaleY(1)' },
    lost:      { stem: 'scaleY(1)' },
    arrive:    { stem: 'scaleY(0.459)', arrive: true },
    arrived:   { stem: 'scaleY(0)', loop: true, ended: true, status: 'ESCORT ENDED', off: true },
    early:     { stem: 'scaleY(0)', loop: true, ended: true, status: 'ESCORT ENDED', off: true },
    ended:     { stem: 'scaleY(0)', ended: true, status: 'ESCORT ENDED', off: true },
  };
  const CAP_IDS = ['finding', 'unknown', 'confirmed', 'around', 'straight', 'reassure', 'soon', 'here', 'reroute', 'wait', 'welcome', 'battery', 'lost', 'arrive', 'arrived', 'early', 'ended'];

  /** The caption for a view. word = printed (routine), hand = handwritten (a human moment). */
  function capOf(v) {
    const step = T.steps[v.stepNo] || T.steps[T.steps.length - 1];
    const hereStep = T.steps[v.hereStep] || step;
    const d = v.dNext !== null && v.dNext !== undefined ? Math.max(0, Math.round(v.dNext)) : null;
    const mins = v.minsLeft || 1;
    switch (v.state) {
      case 'finding': return { hand: 'Still finding you.\nTry stepping outside.' };
      case 'unknown': return { hand: 'Just start walking, I’ll tell you if it’s the right way.' };
      case 'confirmed': return { hand: 'Yes, this way ✓', sub: T.firstStreet || '' };
      case 'around': return { hand: 'Other way, turn around.', sub: 'THE WAY IS BEHIND YOU' };
      case 'straight': return { word: 'Keep going.', sub: mins + ' MIN · ' + step.street };
      case 'reassure': return { hand: 'Keep going, about ' + mins + ' minutes.', sub: step.street };
      case 'soon': return { word: turnWord(step) + ', soon.', sub: d + ' M · ' + step.fact };
      case 'here': return { word: turnWord(hereStep) + ' here.', sub: hereStep.into || '' };
      case 'reroute': return { hand: 'No worries, here’s a new way.', sub: turnWord(step).toUpperCase() + ' ' + step.fact + (d !== null ? ' · ' + d + ' M' : '') };
      case 'wait': return { hand: 'Take your time, I’ll wait.', sub: 'PAUSED' };
      case 'welcome': return { hand: 'Welcome back, here’s where you are.', sub: 'STRAIGHT ON' + (d !== null ? ' · ' + turnWord(step).toUpperCase() + ' IN ' + d + ' M' : '') };
      case 'battery': return { hand: 'Battery’s low. Switch to Route to save it?', action: 'Switch to Route →', href: '#route' };
      case 'lost': return { hand: 'Lost signal for a bit, but I still know the way.', sub: 'NO SIGNAL · ROUTE SAVED ON THIS PAGE' };
      case 'arrive': return { hand: 'It’s on your ' + (T.side === 'left' ? 'left' : 'right') + '. Look for the gate.', sub: (T.entrance || '') + ' · ' + Math.round(v.dd) + ' M' };
      case 'arrived': return { hand: 'You made it.', fs: '3.8rem', stamp: 'ARRIVED ' + clockNow(), action: T.links && T.links.event ? (T.links.event.label || 'See the event →') : null, href: T.links && T.links.event ? T.links.event.url : null };
      case 'early': return { hand: 'You’re early. It starts at ' + (T.startsLabel || 'the start') + '.', fs: '2.9rem', sub: 'NEARBY · ' + (T.nearby || ''), action: T.links && T.links.event ? (T.links.event.label || 'See the event →') : null, href: T.links && T.links.event ? T.links.event.url : null };
      case 'ended': return {};
      default: return { word: 'Keep going.' };
    }
  }
  function clockNow() {
    return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
  }
  /** The caption, with the sample trip's own facts line where the preview gives one (the prototype's wording). */
  function capFor(v) {
    const c = capOf(v);
    if (typeof v.demoSub === 'string') c.sub = v.demoSub;
    return c;
  }
  function capHTML(c) {
    return (c.word ? '<p class="cap-word">' + h(c.word) + '</p>' : '') +
      (c.hand ? '<p class="cap-hand" style="white-space:pre-line;font-size:' + (c.fs || '2.35rem') + '">' + h(c.hand) + '</p>' : '') +
      (c.stamp ? '<p style="margin:22px 0 0"><span class="rubber stamp-in">' + h(c.stamp) + '</span></p>' : '') +
      (c.sub ? '<p class="cap-sub">' + h(c.sub) + '</p>' : '') +
      (c.action ? '<a class="action" href="' + h(c.href) + '">' + h(c.action) + '</a>' : '');
  }

  function renderEscortShell(more) {
    dropMaps();
    const caps = CAP_IDS.map((id) => '<div class="cap" data-cap="' + id + '"></div>').join('');
    screenWrap(
      '<p class="esc-status" id="e-status" style="margin:0"><span class="dot"></span><span id="e-status-t">ESCORTING</span></p>' +
      '<div class="stage"><svg viewBox="0 0 390 440" width="390" height="440" role="img" aria-label="Your path ahead">' +
        '<defs><linearGradient id="esc-fade-g" gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="230"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>' +
        '<mask id="esc-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="390" height="440"><rect x="0" y="0" width="390" height="440" fill="url(#esc-fade-g)"/></mask></defs>' +
        '<circle class="ink-drop" id="e-drop" cx="195" cy="400" r="44"/>' +
        '<path class="ghost" id="e-ghost" d="M195,150 V30"/>' +
        '<g mask="url(#esc-fade)"><g class="stem" id="e-stem"><path class="ink-line" d="M195,400 V30" vector-effect="non-scaling-stroke"/><path class="drift" d="M195,400 V30" vector-effect="non-scaling-stroke"/></g></g>' +
        '<g class="bend-g" id="e-bend-g"><path class="ink-line draw" id="e-bend" d="M195,150 Q195,90 135,90 H55" pathLength="100"/></g>' +
        '<path class="ink-line draw" id="e-hook" d="M195,250 C195,192 115,192 115,250 V318" pathLength="100"/>' +
        // The gate on the side the place is on: drawn for the right, mirrored about the dot for the left.
        '<g' + (T.side === 'left' ? ' transform="translate(390,0) scale(-1,1)"' : '') + '><path class="ink-line draw" id="e-arrive" d="M195,230 Q195,200 225,200 H258" pathLength="100"/>' +
        '<path class="gate" id="e-gate" d="M270,216 V190 Q283,178 296,190 V216 M270,198 H296"/></g>' +
        '<path class="ink-line draw" id="e-loop" d="M195,350 A50 50 0 1 1 194.9,350" pathLength="100"/>' +
        '<circle class="you" id="e-you" cx="195" cy="400" r="11" style="transition:opacity .4s"/>' +
      '</svg></div>' +
      '<div class="caps" aria-live="polite">' + caps + '</div>' +
      '<p class="esc-foot quiet" id="e-foot" style="display:none">Escort is over. I’ve stopped using your location.</p>' +
      '<button type="button" class="textbtn more-btn" id="e-more" aria-expanded="false">MORE ↑</button>' +
      '<button type="button" class="scrim" id="e-scrim" aria-label="Close"></button>' +
      '<section class="sheet" id="e-sheet" aria-label="More"><span class="grip"></span>' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:10px 0 12px"><span class="serif" id="e-left" style="font-size:28px;line-height:1.1"></span><span class="label" id="e-facts"></span></div>' +
        '<div class="mapbox" style="margin:0;height:250px" role="img" aria-label="Map, the way you are facing"><div id="e-map" style="width:100%;height:100%"></div></div>' +
        '<div style="padding-top:8px"><a class="action" href="#route">Switch to Route →</a></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;' + dashes + '">' +
          (SUPPORT.speech ? '<button type="button" class="textbtn" id="e-voice" aria-pressed="' + voiceOn + '" style="padding-left:0">' + ICON.speaker + '<span>' + (voiceOn ? 'VOICE ON' : 'VOICE OFF') + '</span></button>' : '<span></span>') +
          '<button type="button" class="textbtn" id="e-end">END ESCORT</button>' +
          '<button type="button" class="textbtn" id="e-close" style="padding-right:0">CLOSE ↓</button></div>' +
      '</section>');
    escortEl = app;
    lastCap = {};
    const q = (id) => $(id);
    const setMore = (v) => {
      q('e-sheet').classList.toggle('on', v);
      q('e-scrim').classList.toggle('on', v);
      q('e-more').setAttribute('aria-expanded', v ? 'true' : 'false');
      if (demo) demo.more = v;
    };
    q('e-more').onclick = () => { setMore(true); if (lastView) paintMore(lastView); };
    q('e-close').onclick = q('e-scrim').onclick = () => setMore(false);
    if (q('e-voice')) q('e-voice').onclick = () => {
      voiceOn = !voiceOn;
      q('e-voice').setAttribute('aria-pressed', voiceOn ? 'true' : 'false');
      q('e-voice').querySelector('span').textContent = voiceOn ? 'VOICE ON' : 'VOICE OFF';
      if (!voiceOn && SUPPORT.speech) speechSynthesis.cancel();
    };
    q('e-end').onclick = () => {
      stopLive();
      if (demo) { clearTimeout(demo.timer); demo = null; }
      ENG.end();
      lastView = { ...(lastView || {}), state: 'ended', status: 'ESCORT ENDED', ended: true };
      paintEscort(lastView);
      setMore(false);
    };
    setMore(more);
  }

  let lastView = null;

  /** Paints one view on the escort screen: the status, the line, the caption and the footer. */
  function paintEscort(v) {
    lastView = v;
    if (!escortEl || !$('e-status')) return;
    const st = v.state;
    const s = S[st] || S.straight;
    const status = $('e-status');
    status.className = 'esc-status' + (st === 'wait' ? ' still' : '') + (s.off || v.ended ? ' off' : '');
    $('e-status-t').textContent = v.status || (st === 'wait' ? 'WAITING' : st === 'finding' ? 'FINDING YOU' : 'ESCORTING');
    const stem = $('e-stem');
    stem.setAttribute('class', 'stem' + (s.dashed ? ' dashed' : '') + (s.dim ? ' dim' : ''));
    let stemT = s.stem, bendY = s.bendY || 0;
    if (st === 'soon' || st === 'here') {
      const g = lineForDistance(st === 'here' ? 0 : v.geoD !== undefined ? v.geoD : v.dNext === null || v.dNext === undefined ? SOON_M : v.dNext);
      stemT = g.stem; bendY = g.bendY;
    }
    stem.style.transform = stemT;
    $('e-bend-g').style.transform = 'translateY(' + bendY + 'px)';
    $('e-bend').classList.toggle('on', !!s.bend);
    $('e-hook').classList.toggle('on', !!s.hook);
    $('e-arrive').classList.toggle('on', !!s.arrive);
    $('e-gate').classList.toggle('on', !!s.arrive);
    $('e-loop').classList.toggle('on', !!s.loop);
    $('e-ghost').classList.toggle('on', !!s.ghost);
    $('e-drop').classList.toggle('on', !!s.drop);
    $('e-you').style.opacity = s.noYou ? 0 : 1;
    const c = capFor(v);
    CAP_IDS.forEach((id) => {
      const el = app.querySelector('[data-cap="' + id + '"]');
      if (!el) return;
      if (id === st) {
        const key = JSON.stringify(c);
        if (lastCap[id] !== key) { el.innerHTML = capHTML(c); lastCap[id] = key; }
      }
      el.classList.toggle('on', id === st);
    });
    $('e-foot').style.display = s.ended || v.ended ? '' : 'none';
    $('e-more').style.display = s.ended || v.ended ? 'none' : '';
    if (v.speak && voiceOn) say(v.speak);
    if (v.buzz && SUPPORT.buzz) { try { navigator.vibrate(180); } catch (e) { /* silently skip */ } }
  }

  /** The MORE sheet: time left, the map heading-up, the switch. The map is made once, when the sheet first opens. */
  function paintMore(v) {
    if (!$('e-left')) return;
    const mins = v.minsLeft ?? '';
    const rem = v.remainingM === null || v.remainingM === undefined ? null : Math.round(v.remainingM);
    $('e-left').textContent = mins === '' ? '' : (v.ended ? 'Arrived' : mins + ' min left');
    $('e-facts').textContent = rem === null ? '' : rem + ' M · ARRIVE ' + arriveClock(v.minsLeft);
    if (!$('e-sheet').classList.contains('on')) return;
    if (!moreMap) { mountMoreMap(); return; }
    if (moreMap === 'loading' || moreMap === 'failed') return;
    const u = v.user;
    moreMap.markers.you.getElement().style.display = u ? '' : 'none';
    if (u) {
      moreMap.markers.you.setLngLat(lngLat(u));
      setLines(moreMap, routeTo(u), oldRoute || []);
      moreMap.map.easeTo({ center: lngLat(u), bearing: typeof v.heading === 'number' ? v.heading : 0, duration: REDUCED() ? 0 : 600, offset: [0, 40] });
    }
  }
  function mountMoreMap() {
    const box = $('e-map');
    if (!box || moreMap) return;
    moreMap = 'loading';
    makeMap(box, { interactive: false }).then((m) => {
      if (!document.body.contains(box)) { m.map.remove(); moreMap = null; return; }
      moreMap = m;
      m.markers.start.remove();
      // You: the dot and the cone of the way you face. Heading-up, so the cone always points up the screen.
      m.markers.you = m.add(markEl('m-you', '<path class="m-cone" d="M0,0 L-18,-44 A48 48 0 0 1 18,-44 Z"/><circle class="m-dot" r="8"/>', 100, 100), [DEST.lng, DEST.lat]);
      m.map.jumpTo({ zoom: m.map.getZoom() + Math.log2(2.2 / designScale(m.map.getZoom())) });
      if (lastView) paintMore(lastView);
    }).catch(() => {
      moreMap = 'failed';
      box.innerHTML = '';
    });
  }
  function dropMaps() {
    for (const m of [routeMap, moreMap]) if (m && m.map) { try { m.map.remove(); } catch (e) { /* gone */ } }
    routeMap = null;
    moreMap = null;
  }
  function arriveClock(mins) {
    const t = new Date(Date.now() + (mins || 0) * 60000);
    return t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
  }
  /** The route walked so far, up to where you are (drawn quiet over the route). */
  function routeTo(u) {
    const pr = project(u, LINE);
    return LINE.points.slice(0, pr.seg + 1).map(lngLat).concat([lngLat(pr.at)]);
  }

  function say(text) {
    if (!SUPPORT.speech || !voiceOn) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      speechSynthesis.speak(u);
    } catch (e) { /* no speech here: the caption says it */ }
  }

  function renderEscort(opts) {
    const wasMore = !!(opts && opts.more);
    renderEscortShell(wasMore);
    if (demo) { clearTimeout(demo.timer); demo = null; }
    if (opts && opts.fixed && T.demo) {
      paintEscort({ ...DEMO_BASE, state: opts.fixed, ...(DEMO_STATE[opts.fixed] || {}), demoSub: DEMO_SUB[opts.fixed] });
      paintMore(lastView);
      return;
    }
    if (opts && opts.loop) { runDemo(); return; }
    if (lastView && live) { paintEscort(lastView); paintMore(lastView); }
  }

  // The sample trip's loop (#escort with no location): the states in order, same timings as the prototype.
  const DEMO_BASE = { stepNo: 2, hereStep: 1, dNext: null, remainingM: 610, minsLeft: 8, dd: 600, user: fromPx({ x: 150, y: 222 }, DEST), heading: 0, status: 'ESCORTING' };
  const DEMO_STATE = {
    soon: { dNext: 80, geoD: 100, stepNo: 1 }, here: { dNext: 0, stepNo: 1, hereStep: 1 }, arrive: { dd: 40, remainingM: 40, minsLeft: 1 }, arrived: { ended: true, status: 'ESCORT ENDED', remainingM: 0, minsLeft: 0 },
    early: { ended: true, status: 'ESCORT ENDED', remainingM: 0, minsLeft: 0 }, wait: { status: 'WAITING' }, finding: { status: 'FINDING YOU', user: null },
    reroute: { dNext: 35, reroute: true }, battery: {}, lost: {}, welcome: {},
  };
  // The prototype's facts lines for the sample trip's previews. Its sample walk is not one consistent trip
  // ("Left, soon" after the pharmacy, then "Left here" into the lane), so the previews show its words as drawn.
  const DEMO_SUB = {
    confirmed: 'UP CANTONMENTS RD', straight: '4 MIN · OXFORD ST', reassure: 'OXFORD ST', soon: '80 M · AFTER THE PHARMACY',
    here: 'INTO THE LANE', reroute: 'LEFT AT THE END OF THIS STREET · 35 M', welcome: 'STRAIGHT ON · ROUNDABOUT IN 90 M',
    arrive: 'GREEN GATE, NEXT TO THE TAILOR’S · 40 M',
  };
  const DEMO_LOOP = [
    ['finding', 2600], ['unknown', 3200], ['confirmed', 2600], ['straight', 3200], ['reassure', 3400],
    ['soon', 3000], ['here', 2600], ['straight', 2800], ['arrive', 3400], ['arrived', 4200],
  ];
  function runDemo() {
    demo = { idx: 0, more: false, timer: null };
    const step = () => {
      const [name, ms] = DEMO_LOOP[demo.idx];
      paintEscort({ ...DEMO_BASE, state: name, ...(DEMO_STATE[name] || {}), demoSub: DEMO_SUB[name], status: name === 'finding' ? 'FINDING YOU' : undefined });
      paintMore(lastView);
      demo.timer = setTimeout(() => {
        if (!demo.more) demo.idx = (demo.idx + 1) % DEMO_LOOP.length;
        step();
      }, ms);
    };
    step();
  }

  // ----- Escort, live: tracking, the tick, the wake lock, orientation, reroutes -----
  function startLive(fromTap) {
    if (!SUPPORT.geo) { go('#route'); return; }
    if (live) { if (location.hash !== '#escort') go('#escort'); return; } // a second tap: one watch only
    // The position watch starts first, synchronously, so it stays inside the tap that asked for it.
    const watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    live = { watchId, wake: null, orient: null, tick: null };
    // iOS speaks only after speech has started inside a tap: an empty utterance now unlocks the turns later.
    if (fromTap && SUPPORT.speech) { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* no speech here */ } }
    if (fromTap && SUPPORT.orient && typeof DeviceOrientationEvent.requestPermission === 'function') {
      live.orient = DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') listenCompass(); }).catch(() => {});
    } else if (SUPPORT.orient) {
      listenCompass();
    }
    lsSet('reason.dir.live', '1');
    keepAwake();
    if (!live.tick) live.tick = setInterval(() => {
      if (!live) return;
      const v = ENG.view(Date.now());
      paintEscort(v);
      // Arrival can land on the clock (standing at the gate, no new reading): location stops then too.
      if (v.ended) stopLive();
    }, 1000);
    if (location.hash !== '#escort') go('#escort'); else route();
  }

  // The compass, listened to once per page. iOS gives webkitCompassHeading; Android gives a true north only on
  // deviceorientationabsolute (plain deviceorientation's alpha starts anywhere), so that is the only alpha used.
  let compassOn = false;
  function listenCompass() {
    if (compassOn) return;
    compassOn = true;
    window.addEventListener('deviceorientationabsolute', (e) => {
      if (live && typeof e.alpha === 'number') live.compass = (360 - e.alpha) % 360;
    });
    window.addEventListener('deviceorientation', (e) => {
      if (live && typeof e.webkitCompassHeading === 'number') live.compass = e.webkitCompassHeading;
    });
  }

  function stopLive() {
    if (!live) return;
    try { navigator.geolocation.clearWatch(live.watchId); } catch (e) { /* already stopped */ }
    if (live.wake) { try { live.wake.release(); } catch (e) { /* released already */ } }
    if (live.tick) clearInterval(live.tick);
    live = null;
    lsSet('reason.dir.live', '');
  }

  function pauseLiveForRoute() {
    if (!live) return;
    stopLive();
    ENG.resumeFromRoute();
  }

  async function keepAwake() {
    if (!SUPPORT.wake || !live) return;
    try { const w = await navigator.wakeLock.request('screen'); if (live) { live.wake = w; } } catch (e) { /* screen may sleep: fine */ }
  }

  function onFix(pos) {
    if (!live) return;
    const r = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, compass: live.compass };
    lastFix = { lat: r.lat, lng: r.lng };
    const now = Date.now();
    const v = ENG.feed(r, now);
    if (v.reroute) reroute();
    if (location.hash === '#escort') paintEscort(v);
    lastView = v;
    if (location.hash === '#escort') paintMore(v);
    if (v.ended) stopLive();
  }

  function onGeoError(err) {
    if (err && err.code === 1) {
      // Denied: the Route version, with the note, and nothing else asked again.
      stopLive();
      lsSet('reason.dir.live', '');
      go('#route/denied');
    }
    // Timeouts and no-signal errors just leave the state at "finding you" (the tick shows it).
  }

  async function reroute() {
    try {
      const at = ENG.view(Date.now()).user ? lastFix : null;
      if (!at) { ENG.rerouteFailed(); return; }
      const res = await fetch('/d/' + encodeURIComponent(T.id) + '/reroute', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ lat: at.lat, lng: at.lng }),
      });
      if (!res.ok) throw new Error('reroute ' + res.status);
      const j = await res.json();
      const line = lineOf(j.route);
      T.steps = j.steps;
      T.route = j.route;
      setRoute(line);
      ENG.replaceRoute({ ...T, steps: j.steps, destination: DEST }, line, at, Date.now());
      if (location.hash === '#route') route();
    } catch (e) {
      // Silent: the old route stays on screen and the next off-route reading tries again.
      ENG.rerouteFailed();
      if (!navigator.onLine) ENG.setOffline(true);
    }
  }

  // ----- the rest of the device: signal, battery, coming back to the page -----
  window.addEventListener('offline', () => { ENG.setOffline(true); if (location.hash === '#escort' && live) route(); });
  window.addEventListener('online', () => { ENG.setOffline(false); });
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const check = () => { if (b.level <= 0.15 && !b.charging) { ENG.notifyBattery(Date.now()); } };
      check();
      b.addEventListener('levelchange', check);
    }).catch(() => {});
  }
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (live && hiddenAt && Date.now() - hiddenAt > 30000) { ENG.welcomeBack(Date.now()); }
    if (live) keepAwake();
    hiddenAt = 0;
  });
  // The theme follows sunset while Escort is open, without a reload.
  themeTimer = setInterval(() => { if (location.hash.startsWith('#escort')) applyTheme('escort'); }, 60000);

  // ----- the router -----
  function route() {
    const parts = (location.hash || '').slice(1).split('/');
    const name = parts[0] || '';
    const wasLive = !!live;
    if (name !== 'escort' && live) pauseLiveForRoute();
    if (demo && name !== 'escort') { clearTimeout(demo.timer); demo = null; }
    escortEl = null;
    dropMaps();
    if (name === 'escort') applyTheme('escort'); else applyTheme('route');
    // Switching to Route mid-walk keeps the place: the Route opens on the turn the escort was heading for.
    if (name === 'route' && !parts[1] && wasLive) { location.replace('#route/step' + Math.min(T.steps.length, ENG.step + 1)); return; }
    if (name === 'ask') renderAsk();
    else if (name === 'toofar') renderTooFar();
    else if (name === 'route') renderRoute({ open: parts[1] === 'steps', sel: /^step\d+$/.test(parts[1] || '') ? +parts[1].slice(4) : 0, note: parts[1] === 'denied' });
    else if (name === 'escort') {
      const more = parts[2] === 'more' || parts[1] === 'more';
      const state = parts[1] && parts[1] !== 'more' ? parts[1] : '';
      if (state && T.demo) renderEscort({ fixed: state, more });
      else if (live) renderEscort({ more });
      else if (T.demo) renderEscort({ loop: true, more });
      else resumeOrAsk(more);
    } else {
      if (!location.hash && T.walkM > LONG_WALK_M) { renderTooFar(); return; }
      renderChoose();
    }
  }

  /** Escort opened cold: resume only when the person already said yes on this phone; otherwise ask. */
  function resumeOrAsk(more) {
    const ask = () => go('#ask');
    if (!navigator.permissions || !navigator.permissions.query) { ask(); return; }
    navigator.permissions.query({ name: 'geolocation' }).then((p) => {
      if (p.state === 'granted' && lsGet('reason.dir.live') === '1') { startLive(false); }
      else ask();
    }, ask);
  }

  window.addEventListener('hashchange', route);
  window.ReasonDirections = { lineForDistance, createEscort, project };
  route();
}
