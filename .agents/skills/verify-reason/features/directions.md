# Directions page — Route and Escort

When someone asks how to get somewhere, Reason answers in chat and links a directions page. Route
shows the map and the steps at the person's own pace. Escort walks them there turn by turn from live
location. The page is built from one embedded payload (src/directions/payload.js) and holds no
routing or map key; reroutes go through Reason's backend.

Source: `src/directions/` — `logic.js` (every decision, pure), `payload.js` (the shape, strict),
`tokens.js` (map colours), `page.js` (HTML, CSP, static files), `app.js` (the browser: screens, GPS,
the line), `demo.js` (the `#escort/<state>` preview hashes, demo payloads only), `directions.css`.
Fixture: `test/fixtures/directions-garden-room.js` (the hand-off's sample trip, demo: true).

Tests: `node --test test/directions-logic.test.js test/directions-page.test.js` (41 at the time of
writing: lineForDistance, step advance within 20 m, off route at 3 × 40 m, accuracy and jumps,
smoothing, sunset theme, every escort moment, payload strictness, CSP, no inline script, no
location on load in the client source, map colours equal the stylesheet's).

Browser drive: `node .agents/skills/verify-reason/bin/directions-drive.mjs [outDir] --reference <handoff screens dir>`.
It serves the sample page over loopback HTTP and checks: all 24 hand-off states in Paper and Night
(screenshots, and a pixel difference against the hand-off's screens/*.png, reported not asserted);
no location requested on load; the share tap starts one watch; no console error or CSP violation;
a fake-GPS walk reads Keep going → Left, soon → Left here in order, reroutes once when off route,
reaches "You made it." and stops; MORE shows the map; END ESCORT ends; Switch to Route keeps the
place; reduced motion stops the drift and the pulse.

**Not proven by this drive:** real iOS Safari or Android Chrome, outdoors, at walking pace; the
battery moment and the signal-lost moment (logic-tested only); the reroute response (the harness
answers 404, so the page keeps its saved route); the basemap (no streets without a payload's roads).

## How to apply

- A change to the escort's decisions goes in `logic.js` with a test in `directions-logic.test.js`
  first. The page only draws what `escortView` returns.
- Location is requested in one place, `startWatch()`, which only a tap reaches (Share my location,
  or Pick up the walk after a reload). Never add a call on load.
- The map style reads `tokens.js`; the CSS variables must match it (`directions-page.test.js` checks).
- The payload is validated on the server and the page refuses anything extra. Do not loosen
  `.strict()` to accept fields the backend invents.
