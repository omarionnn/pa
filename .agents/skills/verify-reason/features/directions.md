# Directions page — Route and Escort

When someone asks how to get somewhere, Reason answers in chat and links a walking directions page.
Route shows the map and the steps at the person's own pace. Escort walks them there turn by turn from
live location. Built to the design hand-off (`~/Downloads/reason-directions-handoff/`: PROMPT.md,
prototype/, screens/ — 24 states × Paper and Night; the screens win on look, PROMPT.md on behaviour).

Held behind `REASON_DIRECTIONS` (off: every `/d/` path answers nothing and falls through to not-found).
`REASON_DIRECTIONS_SAMPLE` also serves the hand-off's made-up trip at `/d/sample` (The Garden Room, Osu).
`REASON_DIRECTIONS_ROUTING_URL` is an OSRM-compatible foot router; reroutes call it from the server, so
no routing key ever reaches the page. Reason making a real trip (the chat tool, storing it) is not wired yet.

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

**Not proven by this drive:** a real iPhone/Android outdoors at walking pace; the compass; the battery and
signal-lost moments live (logic-tested; previews shown); voice and vibration (feature-detected only).

## How to apply

- Escort decisions live in `createEscort` (pure); add a test in `test/directions.test.js` first.
- Location is requested in one place, `startLive()`, reached only from the "Share my location" tap (or a
  resume when the person already granted it on this phone). Never on load; the drive checks it.
- Map colours: `MAP_THEMES` must equal the CSS variables (`--map-*`, `--route`); the test holds them.
- The `#escort/<state>` previews only exist on demo trips (`trip.demo`); a real trip ignores them.
