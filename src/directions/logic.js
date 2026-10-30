// The directions page's logic, with no DOM and no network. The browser loads this file as-is
// (/directions/logic.js) and the tests import it under Node, so every decision the escort makes
// (which line to draw, when a step advances, when to reroute, which theme to show) is checked
// without a phone.
//
// Coordinates: points are { lat, lng }. Route coordinates are GeoJSON order, [lng, lat].

/** Every threshold in one place. PROMPT.md names the first few; the rest are ours and say so. */
export const TUNE = Object.freeze({
  accuracyRejectM: 50,      // a reading worse than this is ignored (tall buildings, cold start)
  jumpM: 150,               // a reading this far from the last good one, inside jumpMs, is a glitch
  jumpMs: 2000,
  smoothWindow: 3,          // the dot is the average of the last three good readings
  stepAdvanceM: 20,         // within this of a turn, the turn is reached ("Left here.") and the next one starts
  offRouteM: 40,            // more than this from the route ...
  offRouteReadings: 3,      // ... for this many readings in a row = off route
  directionConfirmM: 10,    // walked this far before we trust which way is forward
  wrongWayDeg: 120,         // moving this far away from the route's direction counts as the wrong way
  soonM: 100,               // the bend starts to draw in at this distance
  arriveM: 50,              // the gate appears at this distance from the destination
  arrivedM: 12,             // "arrived" at this distance
  stopMs: 60000,            // no movement this long = WAITING
  lostMs: 20000,            // no good reading this long = signal lost
  longStretchMs: 240000,    // a straight stretch gets a reassuring note every few minutes
  heldMs: 4000,             // "Left here." stays this long after the turn is passed
  confirmedMs: 3000,        // "Yes, this way" stays this long
  welcomeMs: 6000,          // "Welcome back" stays this long after the page returns
  announceM: 30,            // spoken turns start this far before the turn (PROMPT.md)
  walkMps: 1.3,             // walking pace for "about N minutes" (ours)
  tooFarM: 2000,            // a walk longer than this shows the "ride instead" screen (ours)
  batteryLow: 0.2,          // battery level that prompts the switch to Route
});

const RAD = Math.PI / 180;
const EARTH_M = 6371008.8;
const MANEUVER_TURNS = new Set(["left", "right", "roundabout", "arrive"]);

/** Great-circle distance in metres. */
export function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from north, 0 to 360. */
export function bearingDeg(a, b) {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD)
    - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** The smallest angle between two bearings, 0 to 180. */
export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Projects a point onto the route polyline. Flat local approximation per segment, which is exact
 * enough at walking scale. Returns the distance off the line, how far along the route the nearest
 * point is, and the direction of travel at that point.
 */
export function projectOntoRoute(route, p) {
  let best = null;
  const kx = Math.cos(p.lat * RAD) * 111320; // metres per degree of longitude here
  const ky = 110540;                          // metres per degree of latitude
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const segLen = route.cum[i + 1] - route.cum[i];
    const bx = (b.lng - a.lng) * kx;
    const by = (b.lat - a.lat) * ky;
    const px = (p.lng - a.lng) * kx;
    const py = (p.lat - a.lat) * ky;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / len2)) : 0;
    const d = Math.hypot(px - t * bx, py - t * by);
    if (!best || d < best.distM) {
      best = {
        distM: d,
        alongM: route.cum[i] + t * segLen,
        bearingDeg: (Math.atan2(bx, by) / RAD + 360) % 360,
        segment: i,
      };
    }
  }
  return best;
}

/**
 * Turns the payload's coordinates and steps into what the page computes against: cumulative
 * distance along the route, each step's place along it, and the list of turns the escort counts
 * down to (left, right, roundabout, arrival). "Depart" and "straight on" steps are list entries;
 * they are not corners, so the escort never counts down to them.
 */
export function prepareRoute({ coordinates, steps }) {
  const points = coordinates.map(([lng, lat]) => ({ lat, lng }));
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distanceM(points[i - 1], points[i]));
  const lengthM = cum[cum.length - 1];
  const preparedSteps = steps.map((s, index) => {
    const point = { lat: s.location[1], lng: s.location[0] };
    const hit = projectOntoRoute({ points, cum }, point);
    return { ...s, index, point, alongM: hit.alongM, offM: hit.distM };
  });
  const maneuvers = preparedSteps.filter((s) => MANEUVER_TURNS.has(s.turn)).map((s) => s.index);
  return { points, cum, lengthM, steps: preparedSteps, maneuvers };
}

/** The word a turn is called by in a caption. */
export function turnWord(turn) {
  return { left: "Left", right: "Right", roundabout: "Roundabout", arrive: "Here", straight: "Straight on", depart: "Start" }[turn] ?? "Turn";
}

/** Is a reading good enough to act on? `last` is the last good reading, or null. */
export function acceptReading(reading, last) {
  const finite = reading && [reading.lat, reading.lng, reading.accM, reading.t].every(Number.isFinite);
  if (!finite || Math.abs(reading.lat) > 90 || Math.abs(reading.lng) > 180) return { ok: false, why: "invalid" };
  if (reading.accM > TUNE.accuracyRejectM) return { ok: false, why: "inaccurate" };
  if (last) {
    if (reading.t <= last.t) return { ok: false, why: "stale" };
    if (reading.t - last.t <= TUNE.jumpMs && distanceM(last, reading) > TUNE.jumpM) return { ok: false, why: "jump" };
  }
  return { ok: true, why: "ok" };
}

/**
 * The dot's position: the average of the last few good readings, weighted toward the more accurate
 * ones, so it does not shake. `recent` is an array of accepted readings, oldest first.
 */
export function smoothFix(recent) {
  const window = recent.slice(-TUNE.smoothWindow);
  let w = 0;
  let lat = 0;
  let lng = 0;
  for (const r of window) {
    const wi = 1 / Math.max(r.accM, 5) ** 2;
    w += wi;
    lat += r.lat * wi;
    lng += r.lng * wi;
  }
  const last = window[window.length - 1];
  return {
    lat: lat / w,
    lng: lng / w,
    accM: Math.min(...window.map((r) => r.accM)),
    t: last.t,
  };
}

/**
 * Counts readings in a row that are off the route. Triggers a reroute at the third. Takes the raw
 * reading's distance and accuracy: a reading only counts when its whole accuracy circle is past the
 * line, so a noisy fix near the edge of the band is not taken for a walk off the route.
 */
export function nextOffRoute(count, distM, accM = 0) {
  const n = distM - accM > TUNE.offRouteM ? count + 1 : 0;
  return { count: n, triggered: n >= TUNE.offRouteReadings };
}

/** Metres still to walk before the next turn, from the route's own distance along. */
export function remainingToManeuver(route, along, m) {
  const k = route.maneuvers[m];
  if (k === undefined) return null;
  return route.steps[k].alongM - along;
}

/**
 * Advances past every turn the user has reached (within stepAdvanceM). Returns the new pointer
 * into route.maneuvers and the turns passed on the way, so the caller can show "Left here." for them.
 */
export function advanceManeuver(route, along, m) {
  let next = m;
  const passed = [];
  while (next < route.maneuvers.length) {
    const rem = remainingToManeuver(route, along, next);
    if (rem === null || rem > TUNE.stepAdvanceM) break;
    passed.push(route.maneuvers[next]);
    next += 1;
  }
  return { m: next, passed };
}

/** The street the user is on: the last step whose place is behind them. */
export function currentStreet(route, along) {
  let street = "";
  for (const s of route.steps) {
    if (s.alongM <= along && s.street) street = s.street;
  }
  return street;
}

/**
 * The line for a distance to the next turn, as PROMPT.md and the prototype define it.
 * Over 100 m: straight. From 100 m to 20 m: the bend draws in at the top and slides down toward the
 * dot as you close in; the stem shortens with it. At 20 m or less: the corner is at the dot.
 */
export function lineForDistance(d) {
  if (d > TUNE.soonM) return { state: "straight", stemScale: 1, bendY: 0 };
  const t = Math.min(1, Math.max(0, (TUNE.soonM - d) / 80));
  const corner = 150 + t * 170;
  return {
    state: t >= 1 ? "here" : "soon",
    stemScale: Number(((400 - corner) / 370).toFixed(3)),
    bendY: Math.round(corner - 150),
  };
}

/** Light or Night for the page. `choice` is the saved Reason theme: "light", "dark", or "auto"/null. */
export function resolveTheme({ choice = null, mode, now, lat = null, lng = null, prefersDark = false, sunTimes = null }) {
  if (choice === "light") return "paper";
  if (choice === "dark") return "night";
  if (mode === "escort" && Number.isFinite(lat) && Number.isFinite(lng) && sunTimes) {
    const { sunrise, sunset } = sunTimes(now, lat, lng);
    const ok = sunrise instanceof Date && sunset instanceof Date && !Number.isNaN(sunrise.getTime()) && !Number.isNaN(sunset.getTime());
    if (ok) return now < sunrise || now > sunset ? "night" : "paper";
  }
  return prefersDark ? "night" : "paper";
}

/** The tap-to-open links for "Open in Maps": Apple Maps on iOS, Google Maps elsewhere. Keyless. */
export function mapsLinks({ lat, lng, name }) {
  const q = `${lat},${lng}`;
  return {
    apple: `https://maps.apple.com/?daddr=${encodeURIComponent(q)}&dirflg=w&q=${encodeURIComponent(name)}`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=walking`,
  };
}

/**
 * What the escort shows, decided from everything the page knows. Pure: the caller builds `s` from
 * the GPS pipeline and the clock, and renders the result. Priority runs top down.
 *
 * s fields:
 *   nowMs, route (prepared), m (pointer into route.maneuvers), along (metres along route),
 *   hasFix (a good reading has ever arrived), fixAgeMs (since the last good reading),
 *   movedM (walked since escort started), directionConfirmed (sticky: walked TUNE.directionConfirmM
 *   and heading agrees with the route), wrongWay (bool), offRoute (bool), rerouting (bool),
 *   confirmedAgoMs (since direction was first confirmed), stoppedMs,
 *   returnedAgoMs (page came back to the foreground), turnHold ({turn}|null, the turn just reached),
 *   batteryLow (bool), batteryShown (bool), destM (metres to the destination), event ({startsAt, href, label}|null),
 *   nearby (string[]), sinceNoteMs (ms since the last reassuring note), now (Date for the stamp),
 *   ended (bool), speak (bool)
 */
export function escortView(s) {
  const base = { moment: "straight", status: "ESCORTING", line: { kind: "straight", stemScale: 1, bendY: 0 }, caption: null, voice: false, buzz: false };
  const out = (over) => ({ ...base, ...over });

  if (s.ended) return out({ moment: "ended", status: "ESCORT ENDED", line: { kind: "gone", stemScale: 0 }, caption: null });

  const destM = s.destM;
  if (Number.isFinite(destM) && destM <= TUNE.arrivedM) {
    const startsAt = s.event?.startsAt ? Date.parse(s.event.startsAt) : NaN;
    if (Number.isFinite(startsAt) && s.nowMs < startsAt - 10 * 60000) {
      const start = new Date(startsAt);
      return out({
        moment: "early", status: "ESCORT ENDED", line: { kind: "loop", stemScale: 0 },
        caption: { kind: "hand", text: `You're early. It starts at ${clock(start)}.`, sub: (s.nearby ?? []).join(" · ") || null, fs: "2.9rem", action: s.event ? { label: "See the event →", href: s.event.href } : null },
        voice: true, buzz: true,
      });
    }
    return out({
      moment: "arrived", status: "ESCORT ENDED", line: { kind: "loop", stemScale: 0 },
      caption: { kind: "hand", text: "You made it.", fs: "3.8rem", stamp: `ARRIVED ${clock(s.now ?? new Date(s.nowMs))}`, action: s.event ? { label: "See the event →", href: s.event.href } : null },
      voice: true, buzz: true,
    });
  }

  if (!s.hasFix) {
    return out({ moment: "finding", status: "FINDING YOU", line: { kind: "finding", stemScale: 0 }, caption: { kind: "hand", text: "Still finding you. Try stepping outside." } });
  }
  if (s.fixAgeMs > TUNE.lostMs) {
    return out({ moment: "lost", line: { kind: "straight", stemScale: 1 }, caption: { kind: "hand", text: "Lost signal for a bit, but I still know the way.", sub: "NO SIGNAL · ROUTE SAVED ON THIS PAGE" } });
  }
  if (s.returnedAgoMs !== null && s.returnedAgoMs !== undefined && s.returnedAgoMs < TUNE.welcomeMs) {
    const next = s.route.maneuvers[s.m];
    const remaining = s.route.steps && next !== undefined ? Math.round(remainingToManeuver(s.route, s.along, s.m)) : null;
    return out({ moment: "welcome", line: { kind: "straight", stemScale: 1 }, caption: { kind: "hand", text: "Welcome back, here's where you are.", sub: remaining === null ? "" : `${remaining} M · ${turnWord(s.route.steps[next].turn).toUpperCase()}` } });
  }
  if (s.rerouting || s.offRoute) {
    return out({ moment: "reroute", line: { kind: "reroute", stemScale: 0.676, bendY: 0 }, caption: { kind: "hand", text: "No worries, here's a new way.", sub: s.rerouting ? "NEW WAY" : "" }, voice: false });
  }
  if (s.wrongWay) {
    return out({ moment: "around", line: { kind: "hook", stemScale: 0.405 }, caption: { kind: "hand", text: "Other way, turn around.", sub: "THE WAY IS BEHIND YOU" } });
  }
  if (!s.directionConfirmed) {
    return out({ moment: "unknown", line: { kind: "dashed", stemScale: 1 }, caption: { kind: "hand", text: "Just start walking, I'll tell you if it's the right way." } });
  }
  if (s.confirmedAgoMs !== null && s.confirmedAgoMs !== undefined && s.confirmedAgoMs < TUNE.confirmedMs) {
    return out({ moment: "confirmed", line: { kind: "straight", stemScale: 1 }, caption: { kind: "hand", text: "Yes, this way ✓" } });
  }
  if (s.stoppedMs >= TUNE.stopMs) {
    return out({ moment: "wait", status: "WAITING", line: { kind: "dim", stemScale: 1 }, caption: { kind: "hand", text: "Take your time, I'll wait.", sub: "PAUSED" } });
  }
  if (destM <= TUNE.arriveM) {
    return out({ moment: "arrive", line: { kind: "gate", stemScale: 0.459 }, caption: { kind: "hand", text: "It's on your right. Look for the gate.", sub: `${s.destinationEntry ? s.destinationEntry.toUpperCase() : "GATE"} · ${Math.round(destM)} M` }, voice: s.speak === true, buzz: false });
  }
  if (s.turnHold) {
    return out({ moment: "here", line: { kind: "soon", stemScale: 0.216, bendY: 170 }, caption: { kind: "word", text: `${turnWord(s.turnHold.turn)} here.`, sub: "NOW" }, voice: s.speak === true, buzz: s.speak === true });
  }
  const remaining = s.route.maneuvers[s.m] === undefined ? null : remainingToManeuver(s.route, s.along, s.m);
  if (remaining !== null && remaining <= TUNE.soonM) {
    const turn = s.route.steps[s.route.maneuvers[s.m]];
    const line = lineForDistance(Math.max(0, remaining));
    if (remaining <= TUNE.stepAdvanceM) {
      return out({ moment: "here", line: { kind: "soon", stemScale: line.stemScale, bendY: line.bendY }, caption: { kind: "word", text: `${turnWord(turn.turn)} here.`, sub: "NOW" }, voice: s.speak === true, buzz: s.speak === true });
    }
    const sub = [`${Math.round(remaining)} M`, turn.landmark ? `AFTER ${turn.landmark.toUpperCase()}` : null].filter(Boolean).join(" · ");
    return out({ moment: "soon", line: { kind: "soon", stemScale: line.stemScale, bendY: line.bendY }, caption: { kind: "word", text: `${turnWord(turn.turn)}, soon.`, sub }, voice: remaining <= TUNE.announceM && s.speak === true });
  }
  if (s.batteryLow && !s.batteryShown) {
    return out({ moment: "battery", caption: { kind: "hand", text: "Battery's low. Switch to Route to save it?", action: { label: "Switch to Route →", href: "#route" } } });
  }
  if (s.sinceNoteMs >= TUNE.longStretchMs) {
    return out({ moment: "reassure", caption: { kind: "hand", text: "Keep going, about 4 minutes.", sub: currentStreet(s.route, s.along).toUpperCase() } });
  }
  const minutes = remaining === null ? null : Math.max(1, Math.ceil((remaining ?? 0) / (TUNE.walkMps * 60)));
  return out({
    moment: "straight",
    caption: { kind: "word", text: "Keep going.", sub: [minutes ? `${minutes} MIN` : null, currentStreet(s.route, s.along).toUpperCase() || null].filter(Boolean).join(" · ") },
  });
}

/** "6:34 PM" in the phone's own clock. */
export function clock(date) {
  const h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? "AM" : "PM"}`;
}
