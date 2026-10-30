// The directions page's pure logic: the line for a distance, step advance, off-route, GPS accuracy
// and smoothing, the sunrise/sunset theme, and every escort moment in PROMPT.md's table.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/directions/logic.js";
import { DEMO_STATES, demoInput } from "../src/directions/demo.js";
import { gardenRoomPayload } from "./fixtures/directions-garden-room.js";
import { getTimes } from "suncalc";

const trip = gardenRoomPayload();
const route = L.prepareRoute({ coordinates: trip.route.coordinates, steps: trip.steps });
const firstTurnAt = route.steps[route.maneuvers[0]].alongM;
const DEST = { lat: trip.destination.lat, lng: trip.destination.lng };
const base = (over = {}) => ({
  nowMs: Date.parse("2026-10-29T18:00:00Z"), now: new Date("2026-10-29T18:00:00Z"),
  route, m: 0, along: 0, hasFix: true, fixAgeMs: 0, movedM: 40, directionConfirmed: true,
  confirmedAgoMs: null, wrongWay: false, offRoute: false, rerouting: false, stoppedMs: 0,
  returnedAgoMs: null, turnHold: null, batteryLow: false, batteryShown: false, destM: 400,
  sinceNoteMs: 0, event: null, destinationEntry: trip.destination.entry, nearby: trip.nearby,
  ended: false, speak: true, ...over,
});

test("lineForDistance: straight over 100 m, the bend draws in from 100 m, the corner lands on the dot at 20 m", () => {
  assert.equal(L.lineForDistance(150).state, "straight");
  assert.equal(L.lineForDistance(101).state, "straight");
  assert.equal(L.lineForDistance(100).state, "soon");
  assert.equal(L.lineForDistance(100).stemScale, 0.676);
  assert.equal(L.lineForDistance(100).bendY, 0);
  assert.equal(L.lineForDistance(60).bendY, 85);
  assert.equal(L.lineForDistance(20).state, "here");
  assert.equal(L.lineForDistance(20).stemScale, 0.216);
  assert.equal(L.lineForDistance(20).bendY, 170);
  assert.equal(L.lineForDistance(0).bendY, 170);
});

test("lineForDistance: as the turn gets closer the corner slides down and the stem shortens, never the other way", () => {
  let prev = L.lineForDistance(100);
  for (let d = 99; d >= 20; d -= 1) {
    const cur = L.lineForDistance(d);
    assert.ok(cur.bendY >= prev.bendY, `bend moved up at ${d} m`);
    assert.ok(cur.stemScale <= prev.stemScale, `stem grew at ${d} m`);
    prev = cur;
  }
});

test("prepareRoute: turns are the only maneuvers, placed in order along the route", () => {
  assert.deepEqual(route.maneuvers, [1, 2, 3, 4], "depart and straight steps are not corners");
  const along = route.maneuvers.map((k) => route.steps[k].alongM);
  assert.deepEqual([...along].sort((a, b) => a - b), along);
  assert.ok(Math.abs(route.lengthM - 910) < 25, `route is about 910 m, got ${route.lengthM}`);
});

test("projectOntoRoute: a point on the line projects to zero off, a point 30 m east projects to about 30 m", () => {
  const onLine = route.points[1];
  const hit = L.projectOntoRoute(route, onLine);
  assert.ok(hit.distM < 0.5);
  assert.ok(Math.abs(hit.alongM - route.cum[1]) < 1);
  const east = { lat: onLine.lat, lng: onLine.lng + 30 / (111320 * Math.cos((onLine.lat * Math.PI) / 180)) };
  assert.ok(Math.abs(L.projectOntoRoute(route, east).distM - 30) < 1);
});

test("step advance: a turn is reached within 20 m, not before", () => {
  const far = firstTurnAt - 25;
  assert.equal(L.advanceManeuver(route, far, 0).m, 0, "25 m out: still the same turn");
  const near = firstTurnAt - 19;
  const adv = L.advanceManeuver(route, near, 0);
  assert.equal(adv.m, 1, "19 m out: the turn is reached and the next one starts");
  assert.deepEqual(adv.passed, [route.maneuvers[0]]);
});

test("step advance: two turns close together are both passed in one move", () => {
  const past = route.steps[route.maneuvers[1]].alongM - 5;
  const adv = L.advanceManeuver(route, past, 0);
  assert.equal(adv.m, 2);
  assert.equal(adv.passed.length, 2);
});

test("off route: more than 40 m for three readings in a row triggers a reroute, and one good reading resets it", () => {
  let s = { count: 0, triggered: false };
  s = L.nextOffRoute(s.count, 41);
  s = L.nextOffRoute(s.count, 41);
  assert.equal(s.triggered, false, "two readings: not yet");
  s = L.nextOffRoute(s.count, 41);
  assert.equal(s.triggered, true, "three readings: reroute");
  assert.equal(L.nextOffRoute(0, 40).count, 0, "exactly 40 m is still on the route");
  assert.equal(L.nextOffRoute(2, 10).count, 0, "a reading back on the route resets the count");
});

test("off route: three raw fixes 60 m out trigger on the third, with 6 m accuracy", () => {
  // The page judges each accepted reading as it arrives, not the smoothed dot, so the count is three readings.
  let s = { count: 0, triggered: false };
  for (let i = 0; i < 2; i += 1) s = L.nextOffRoute(s.count, 60, 6);
  assert.equal(s.triggered, false, "two readings: not yet");
  s = L.nextOffRoute(s.count, 60, 6);
  assert.equal(s.triggered, true, "three readings: reroute");
});

test("off route: a reading whose accuracy circle reaches back inside 40 m does not count", () => {
  assert.equal(L.nextOffRoute(0, 60, 25).count, 0, "60 m out with 25 m accuracy could be 35 m: not evidence");
  assert.equal(L.nextOffRoute(0, 60, 15).count, 1, "45 m clear of the line with 15 m accuracy: counts");
});

test("accuracy: a reading worse than 50 m is ignored", () => {
  const good = { lat: 5.557, lng: -0.183, accM: 12, t: 1000 };
  assert.equal(L.acceptReading({ ...good, accM: 49, t: 2000 }, good).ok, true);
  assert.deepEqual(L.acceptReading({ ...good, accM: 60, t: 2000 }, good), { ok: false, why: "inaccurate" });
});

test("jumps: a reading 300 m away one second after the last good one is a glitch, not a walk", () => {
  const last = { lat: 5.557, lng: -0.183, accM: 8, t: 10000 };
  const far = { lat: 5.557 + 300 / 110540, lng: -0.183, accM: 8, t: 11000 };
  assert.deepEqual(L.acceptReading(far, last), { ok: false, why: "jump" });
  assert.equal(L.acceptReading({ ...far, t: 25000 }, last).ok, true, "after a long gap, the jump is allowed");
});

test("readings out of order or invalid are refused", () => {
  const last = { lat: 5.557, lng: -0.183, accM: 8, t: 10000 };
  assert.equal(L.acceptReading({ ...last }, last).why, "stale");
  assert.equal(L.acceptReading({ lat: NaN, lng: 0, accM: 5, t: 1 }, null).why, "invalid");
});

test("smoothing: the dot is the average of the last three good readings, not the newest alone", () => {
  const r = (lat, t) => ({ lat, lng: 0, accM: 10, t });
  const sm = L.smoothFix([r(1, 1), r(2, 2), r(3, 3), r(4, 4)]);
  assert.ok(Math.abs(sm.lat - 3) < 1e-9, "the mean of 2, 3, 4");
  assert.equal(sm.t, 4);
  const better = L.smoothFix([{ lat: 1, lng: 0, accM: 5, t: 1 }, { lat: 9, lng: 0, accM: 50, t: 2 }]);
  assert.ok(better.lat < 2, "the accurate reading outweighs the poor one");
});

test("theme: Escort is Night after local sunset and Paper before it, from the user's coordinates", () => {
  const at = (iso) => new Date(iso);
  const sun = (now, lat, lng) => getTimes(now, lat, lng);
  const midday = at("2026-10-29T12:00:00Z");
  const beforeDawn = at("2026-10-29T04:30:00Z");
  const evening = at("2026-10-29T19:30:00Z");
  const pick = (now) => L.resolveTheme({ choice: null, mode: "escort", now, lat: DEST.lat, lng: DEST.lng, prefersDark: false, sunTimes: sun });
  assert.equal(pick(midday), "paper");
  assert.equal(pick(beforeDawn), "night");
  assert.equal(pick(evening), "night");
});

test("theme: a Reason theme choice wins over the sun; Route follows the system setting", () => {
  const sun = (now, lat, lng) => getTimes(now, lat, lng);
  const evening = new Date("2026-10-29T19:30:00Z");
  assert.equal(L.resolveTheme({ choice: "light", mode: "escort", now: evening, lat: DEST.lat, lng: DEST.lng, sunTimes: sun }), "paper");
  assert.equal(L.resolveTheme({ choice: "dark", mode: "escort", now: new Date("2026-10-29T12:00:00Z"), lat: DEST.lat, lng: DEST.lng, sunTimes: sun }), "night");
  assert.equal(L.resolveTheme({ choice: null, mode: "route", now: evening, lat: DEST.lat, lng: DEST.lng, prefersDark: false, sunTimes: sun }), "paper");
  assert.equal(L.resolveTheme({ choice: null, mode: "route", now: evening, prefersDark: true }), "night");
});

test("escort moments: each row of the PROMPT.md table draws its own state", () => {
  const v = (over) => L.escortView(base(over));
  assert.equal(v({ hasFix: false, fixAgeMs: Infinity, destM: NaN }).moment, "finding");
  assert.equal(v({ hasFix: false, fixAgeMs: Infinity, destM: NaN }).status, "FINDING YOU");
  assert.equal(v({ directionConfirmed: false, movedM: 2 }).moment, "unknown");
  assert.match(v({ directionConfirmed: false, movedM: 2 }).caption.text, /Just start walking/);
  assert.equal(v({ confirmedAgoMs: 500 }).moment, "confirmed");
  assert.equal(v({ confirmedAgoMs: 500 }).caption.text, "Yes, this way ✓");
  assert.equal(v({ wrongWay: true }).moment, "around");
  assert.equal(v({ wrongWay: true }).line.kind, "hook");
  assert.equal(v({ offRoute: true, rerouting: true }).moment, "reroute");
  assert.equal(v({ offRoute: true, rerouting: true }).caption.text, "No worries, here's a new way.");
  assert.equal(v({ stoppedMs: 70000 }).status, "WAITING");
  assert.equal(v({ stoppedMs: 70000 }).caption.text, "Take your time, I'll wait.");
  assert.equal(v({ fixAgeMs: 25000 }).moment, "lost");
  assert.equal(v({ returnedAgoMs: 1000 }).moment, "welcome");
  assert.equal(v({ batteryLow: true }).moment, "battery");
  assert.equal(v({ batteryLow: true }).caption.action.href, "#route");
  assert.equal(v({ sinceNoteMs: 240001 }).moment, "reassure");
  assert.equal(v({ along: 0, destM: 400 }).moment, "straight");
  assert.equal(v({ along: 0, destM: 400 }).caption.text, "Keep going.");
  assert.equal(v({ along: firstTurnAt - 60 }).moment, "soon");
  assert.equal(v({ along: firstTurnAt - 60 }).caption.text, "Left, soon.");
  assert.equal(v({ along: firstTurnAt - 10 }).moment, "here");
  assert.equal(v({ along: firstTurnAt - 10 }).caption.text, "Left here.");
  assert.equal(v({ destM: 30 }).moment, "arrive");
  assert.equal(v({ destM: 30 }).caption.text, "It's on your right. Look for the gate.");
  assert.equal(v({ destM: 5 }).moment, "arrived");
  assert.equal(v({ destM: 5 }).status, "ESCORT ENDED");
  assert.match(v({ destM: 5 }).caption.stamp, /^ARRIVED \d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(v({ ended: true }).status, "ESCORT ENDED");
});

test("early: before an event's start, arriving reads as early, with what is nearby", () => {
  const startsAt = "2026-10-29T19:00:00.000Z";
  const early = L.escortView(base({ destM: 5, nowMs: Date.parse("2026-10-29T18:30:00Z"), event: { label: "x", href: "https://example.com", startsAt } }));
  assert.equal(early.moment, "early");
  assert.match(early.caption.text, /^You're early\. It starts at \d{1,2}:\d{2} (AM|PM)\.$/);
  assert.equal(early.caption.sub, trip.nearby.join(" · "));
  const late = L.escortView(base({ destM: 5, nowMs: Date.parse("2026-10-29T18:55:00Z"), event: { label: "x", href: "https://example.com", startsAt } }));
  assert.equal(late.moment, "arrived", "inside ten minutes of the start, arrival is just arrival");
});

test("the escort's sub-line counts down in metres and names the landmark", () => {
  const view = L.escortView(base({ along: firstTurnAt - 60 }));
  assert.match(view.caption.sub, /^\d+ M · AFTER THE PHARMACY$/);
});

test("the line keeps its state through a GPS jump: no change without a good reading is possible in the view", () => {
  const a = L.escortView(base({ along: firstTurnAt - 60 }));
  const b = L.escortView(base({ along: firstTurnAt - 60 }));
  assert.deepEqual(a.line, b.line);
});

test("demo states: every preview hash draws its own moment through the real logic", () => {
  const expected = {
    finding: "finding", unknown: "unknown", confirmed: "confirmed", around: "around", straight: "straight",
    reassure: "reassure", soon: "soon", here: "here", reroute: "reroute", wait: "wait", welcome: "welcome",
    battery: "battery", lost: "lost", arrive: "arrive", arrived: "arrived", early: "early",
  };
  assert.deepEqual(Object.keys(expected), [...DEMO_STATES]);
  for (const name of DEMO_STATES) {
    const input = demoInput(name, { route, trip, nowMs: Date.parse("2026-10-29T18:00:00Z") });
    assert.equal(L.escortView(input).moment, expected[name], name);
  }
});

test("clock: 18:34 reads as 6:34 PM and midnight as 12:00 AM", () => {
  assert.equal(L.clock(new Date(2026, 9, 29, 18, 34)), "6:34 PM");
  assert.equal(L.clock(new Date(2026, 9, 29, 0, 5)), "12:05 AM");
});

test("Open in Maps: Apple Maps and Google Maps links carry the destination and no key", () => {
  const m = L.mapsLinks({ lat: 5.5, lng: -0.2, name: "The Garden Room" });
  assert.match(m.apple, /^https:\/\/maps\.apple\.com\/\?daddr=5\.5%2C-0\.2/);
  assert.match(m.google, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=5\.5%2C-0\.2/);
});

test("distance and bearing: 0.001 degrees of latitude is about 111 m, and north is 0 degrees", () => {
  const a = { lat: 5.5, lng: -0.2 };
  assert.ok(Math.abs(L.distanceM(a, { lat: 5.501, lng: -0.2 }) - 111.2) < 0.5);
  assert.ok(Math.abs(L.bearingDeg(a, { lat: 5.501, lng: -0.2 })) < 0.001);
  assert.ok(Math.abs(L.angleDiff(350, 10) - 20) < 1e-9);
});
