// The #escort/<state> preview hashes from the design hand-off, for DEMO payloads only (payload.demo).
// Each state is a set of inputs to the same escortView() the live escort uses, so the preview shows
// what the logic really draws rather than a hand-made picture. Real trips never load this file.

import { TUNE } from "./logic.js";

/** Every preview state, in the hand-off's order. */
export const DEMO_STATES = Object.freeze([
  "finding", "unknown", "confirmed", "around", "straight", "reassure", "soon", "here", "reroute",
  "wait", "welcome", "battery", "lost", "arrive", "arrived", "early",
]);

/**
 * The escortView input for a preview state. `route` is the prepared route, `trip` the payload.
 * Positions are chosen on the route: "soon" is 60 m before the first turn, "here" 10 m before it.
 */
export function demoInput(state, { route, trip, nowMs }) {
  const firstTurnAt = route.steps[route.maneuvers[0]].alongM;
  const at = (remainingM) => Math.max(0, firstTurnAt - remainingM);
  const base = {
    nowMs, now: new Date(nowMs), route, m: 0, along: 0,
    hasFix: true, fixAgeMs: 0, movedM: 40, directionConfirmed: true, confirmedAgoMs: null,
    wrongWay: false, offRoute: false, rerouting: false, stoppedMs: 0, returnedAgoMs: null,
    turnHold: null, batteryLow: false, batteryShown: false,
    destM: 200, sinceNoteMs: 0,
    event: null, destinationEntry: trip.destination.entry, nearby: trip.nearby,
    ended: false, speak: false,
  };
  const s = { ...base, along: at(200) };
  switch (state) {
    case "finding": return { ...base, hasFix: false, fixAgeMs: Infinity, destM: NaN };
    case "unknown": return { ...base, directionConfirmed: false, movedM: 2 };
    case "confirmed": return { ...base, confirmedAgoMs: 500, movedM: 12 };
    case "around": return { ...base, wrongWay: true, movedM: 14, directionConfirmed: false };
    case "straight": return s;
    case "reassure": return { ...s, sinceNoteMs: TUNE.longStretchMs + 1 };
    case "soon": return { ...base, along: at(60), speak: true };
    case "here": return { ...base, along: at(10), speak: true };
    case "reroute": return { ...s, rerouting: true, offRoute: true };
    case "wait": return { ...s, stoppedMs: TUNE.stopMs + 10000 };
    case "welcome": return { ...s, returnedAgoMs: 1000 };
    case "battery": return { ...s, batteryLow: true };
    case "lost": return { ...s, fixAgeMs: TUNE.lostMs + 5000 };
    case "arrive": return { ...base, along: route.lengthM - 60, destM: 30 };
    case "arrived": return { ...base, along: route.lengthM - 5, destM: 5, event: trip.event ? { ...trip.event, startsAt: new Date(nowMs - 3600000).toISOString() } : null };
    case "early": return { ...base, along: route.lengthM - 5, destM: 5, event: { ...(trip.event ?? { label: "Event", href: "/" }), startsAt: new Date(nowMs + 45 * 60000).toISOString() } };
    default: return null;
  }
}
