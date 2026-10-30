# Directions page — Route and Escort

When someone asks how to get somewhere, Reason answers in chat and links a walking directions page.
Route shows the map and the steps at the person's own pace. Escort walks them there turn by turn from
live location. Built to the design hand-off (`~/Downloads/reason-directions-handoff/`: PROMPT.md,
prototype/, screens/ — 24 states × Paper and Night; the screens win on look, PROMPT.md on behaviour).

Held behind `REASON_DIRECTIONS` (off: every `/d/` path answers nothing and falls through to not-found;
`owner`: only the owner's conversation is told about the `directions` tool and only the owner's trips open).
`REASON_DIRECTIONS_SAMPLE` also serves the hand-off's made-up trip at `/d/sample` (The Garden Room, Osu).
`REASON_DIRECTIONS_ROUTING_URL` is an OSRM-compatible foot router, default FOSSGIS's free keyless foot profile
(`https://routing.openstreetmap.de/routed-foot`); the trip and every reroute call it from the server, so no
routing key ever reaches the page.

**Real trips** (`src/trips.js`, tool `directions` in `src/directionstools.js`): the model reads that somebody
wants to get somewhere on foot and calls the tool with the start (a place they named, or get_location's live
share / recent pin — never guessed: no start, no trip) and the end (an address or place, looked up on
Nominatim near the start first; a saved place by name; or a Reason event, whose released address, start and
link come from the event). The walk comes from the foot router; crossings and kerbs under 35 m fold away.
The row (`trips`: trip JSON + server-only `streets` + OSRM's raw steps) lasts a day past the start. The map's
shapes, the street label, the nearby line and the names of nameless sidewalk steps come from Overpass in the
background (the tool waits up to 8 s); if Overpass is down, steps are named by Nominatim reverse lookups and
opening the page retries the map at most every 10 min. Link: `files.heyreason.com/d/<id>?k=<key>` (the files
host rewrites to `/p/d/…`, which the app accepts). The page opens only on the owner's own signed-in browser;
anyone else, a link preview included, gets the private pages' code gate (Text me the code → six digits →
303 back to the page, cookie at `/`), which never shows the place or an address, and the bare link and an
unknown id are the same bytes. A reroute needs the signed-in browser; the position is answered and dropped
(the row is untouched, the log has no coordinates). Arrival after `startsAt` is "You made it.", more than
10 min before is "You're early. It starts at <startsLabel>."; the last 50 m names the side from the router.

Source: `src/pages/directions.js` (the page, the sample trip with its embedded map shapes, the reroute,
`/d/vendor/*` = MapLibre and suncalc served from node_modules, never a CDN), `src/pages/directionsclient.js`
(served as `/d/app.js`; pure functions at the top — geometry, `lineForDistance`, `isNightAt`, `mapStyle`,
`createEscort` — and the browser part in `boot()`), `src/pages/directions.css` (tokens from the hand-off).
The map is MapLibre with a style built from the tokens and only GeoJSON sources from the trip: no tiles,
no glyphs, no key. Marks (start, destination, POI, labels, focus ring, you + cone) are HTML markers that
scale with the zoom (`--mk`), as the prototype's SVG map draws them.

Tests: `node --test test/directions.test.js` (geometry, the line, suncalc sunset, map colours = stylesheet
colours and no tiles, every escort decision — confirm, soon/here/advance, silent straight-on, 30 m
announce, off route on 3 raw readings past 40 m + accuracy, reroute replaces the line, signal lost, wrong
way, waiting, arrival on 3 readings or one held 3 s, early — the page, CSP, vendor files, no location on
load, flags off, reroute via OSRM, escaping).

Browser drive: `node .agents/skills/verify-reason/bin/directions-drive.mjs [outDir] --reference ~/Downloads/reason-directions-handoff/screens`
(~6 min). Serves `/d/sample` through `directionsRequest` with the flags on and a stand-in OSRM router on the
same loopback port. Checks: all 24 states × 2 themes (screenshots + pixel diff vs the hand-off, reported:
mean ~1–2% of pixels over threshold), no location on load, no console error or CSP violation, the map
canvas draws on Route and MORE; the share tap starts one watch; a fake-GPS walk reads Just start walking →
Yes, this way ✓ → Keep going → Left, soon (N M · AT THE TRAFFIC LIGHTS) → Left here; a wrong turn asks
for one reroute, shows "No worries, here's a new way." and carries on; the gate note, then "You made it."
+ ARRIVED stamp after the event's start, ESCORT ENDED, the watch cleared; arriving 40 min before reads
"You're early. It starts at 7."; END ESCORT; Switch to Route opens on the turn ahead; reduced motion stops
the drift and the pulse.

**The drive never makes a sound.** Chromium launches with `--mute-audio`, and an init script replaces
`window.speechSynthesis` / `SpeechSynthesisUtterance` with a recorder (`window.__said`). The spoken lines
are asserted from that record: the share tap's empty unlock, "Left in about thirty metres." → "Left here.",
and on the real trip "Right in about thirty metres." → "Right here.". Keep both whenever the drive is
changed; an earlier run spoke through the owner's Mac speakers.

Section 7 of the drive is a real trip on a throwaway database with `REASON_DIRECTIONS=owner`: made by the
`directions` tool (stand-in router and Overpass), opened through the code gate in the browser (no place on
the gate; bare == ghost bytes; one code texted to the owner, `pcode:` key), signed in, the Ask line says
NEVER KEPT, a fake-GPS walk along the real route (Just start walking → Yes, this way ✓ → Right, soon → Right
here, the turn naming EAST 17TH STREET), a wrong turn → one reroute through `/d/<id>/reroute` → "No worries,
here's a new way.", nothing stored, no position logged, "It's on your right", "You made it." + ARRIVED after
the start, and the same signed-in browser 40 min early → "You're early. It starts at <start>." + NEARBY.

**Not proven by this drive:** a real iPhone/Android outdoors at walking pace; the compass; the battery and
signal-lost moments live (logic-tested; previews shown); real voice output (only the words are recorded)
and vibration (feature-detected only).

## How to apply

- Escort decisions live in `createEscort` (pure); add a test in `test/directions.test.js` first.
- Location is requested in one place, `startLive()`, reached only from the "Share my location" tap (or a
  resume when the person already granted it on this phone). Never on load; the drive checks it.
- Map colours: `MAP_THEMES` must equal the CSS variables (`--map-*`, `--route`); the test holds them.
- The `#escort/<state>` previews only exist on demo trips (`trip.demo`); a real trip ignores them.
- Trip making, steps, the map fill and the gate are tested in `test/trips.test.js` (no network). A live smoke:
  `makeTrip` against the real FOSSGIS / Nominatim / Overpass (see the PR) — Overpass is often slow or down.
