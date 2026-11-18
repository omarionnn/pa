# Nearby places and the weather fallback

"Any pharmacy near me?", "good ramen around here?", "is it raining where I am?" — the `nearby_places` and
`weather` tools, on a position from `get_location` / a shared pin / a saved place
([location-share.md](location-share.md)). Live today: on for everyone, free sources only.

Source: `src/places.js` (`nearbyPlaces`), `src/googleplaces.js` (dormant without a key), `src/weather.js`
(`weatherAt`); tool cases: `grep -n 'case "nearby_places"\|case "weather"' src/tools.js`.
Tests: `test/places-sources.test.js` (16), `test/places-breaker.test.js` (4), `test/places-google.test.js` (14), `test/location-assumed.test.js` (the where-from note).

## Sub-features

- **Three free OpenStreetMap sources at once, one budget (#576, `723bf3db`).** Overpass (two of four
  public servers raced, a different two each time, 2.5 s), Nominatim (one request a second across the
  process) and Photon (komoot) are asked together inside `BUDGET_MS` 6 s on a text, `CALL_BUDGET_MS` 4 s
  on a phone call. Whatever answered is merged, de-duplicated, filtered to what was asked (no "Pharmacy
  Lane" street, no neighbour on a name search), kept inside the radius and sorted nearest first. A
  result never carries hours/phone/website the source did not have. `answered_by` names the sources.
- **Breakers (#497, `df9d4ac3`, reworked in #576).** Overpass that does not answer is skipped for 5 minutes.
  When no source at all answered, the person gets one honest line ("Couldn't load nearby places: the map
  service isn't answering right now."), `no_retry: true` so the retry layer does not run it again, and the
  next asks for 60 s answer the same at once; the model is told to use `web_search` and say so.
  An empty area is `ok` with no places, not a failure. Free-source answers are cached 5 minutes (same ask from about the same spot: coordinates to 3 decimals).
- **Google Places first, only when a key is set (#577, `7d5b5f54`).** With `REASON_GOOGLE_PLACES_KEY`
  set, Google Text Search goes first (2.5 s, Pro field mask; Enterprise only when the ask needs hours,
  phone, rating, website or price; open-now is a Pro request parameter). Hard monthly caps per tier,
  counted in the database by Google's billing month (Pacific): `REASON_GOOGLE_PLACES_PRO_MAX` default
  4500, `REASON_GOOGLE_PLACES_ENT_MAX` default 900 (inside the free allowances). Over the cap, an error,
  a timeout (then Google skipped 2 min) or nothing in the radius → the free sources, silently. Google's
  places are never cached; a sent place credits Google Maps and carries its link. /ops shows one meter
  per tier once a key is set. **Live: `REASON_GOOGLE_PLACES_KEY` is set** (live switch list, 2026-11-17),
  so on live Google goes first and the free sources are the fallback; a cage and the clone have no key.
- **Where the position came from (#581).** When `nearby_places` or `weather` is given a saved place's
  coordinates (or nothing they shared) and there is no fresh position (no live share running, no pin in
  the last 24 h, `RECENT_PIN_MIN`), the result opens with a `where_from` note (`src/whereabouts.js`
  `whereNote`, `withWhere` in src/tools.js): by text Reason says which place it assumed and sends the
  Share My Location card in the same reply, or asks in one line when the hours they told Reason (a saved
  fact, `shiftOf`) say they are not there (off shift, so not at work); on a call it says the assumption in a few words and the text after the
  call sends the card. A fresh position gets no note. Tests: `test/location-assumed.test.js`.
- **Weather in their unit (#584).** The `weather` result carries one unit only (`inTheirUnit`,
  `temperature_unit` F or C, `say.now/high/low` like `43°F`), picked from their confirmed time zone, else their
  number's, else the install's (`unitForZone`: US zones and the few others → F, everywhere else → C), and
  the note tells the model to name the unit with every number ("43 degrees Fahrenheit" out loud).
- **Weather falls back to MET Norway (#576).** Open-Meteo first (3 s); no answer at all (timeout, no
  connection) → MET Norway's compact forecast (3 s, identifying User-Agent), said as "MET Norway, by
  coordinates", with no rain chance (compact has none, none is made up). For 5 minutes after, MET goes
  first. An Open-Meteo answer that says no (4xx) or failed (5xx) is returned as before, not sent to MET
  (the retry layer takes a 5xx). Both down → retried in
  code (3 tries), then the plain line and one re-check in 10 minutes. Bases: `REASON_WEATHER_BASE`,
  `REASON_WEATHER_MET_BASE`.

## How to get to it (user POV)

Share a location (or have a saved place), then ask for something nearby or the weather. Reason answers
with a short list nearest first; when the map sources are all down it says so once and searches the web
instead, saying the list comes from a search.

## Driving it with the harness

No network drives: every source is a stub fetch. Offline, through the gate:

```bash
bash /tmp/verify-upkeep/slot.sh <log> -- node --import ./test/paid-key-guard.js --test \
  test/places-sources.test.js test/places-breaker.test.js test/places-google.test.js
```

In process, no model (2026-11-14, evidence `*-g5a-places`, script kept in the evidence dir as
`places-drive.mjs`): `nearbyPlaces` and `weatherAt` with an injected fetch — all three up → merged
`overpass+nominatim+photon`, nearest first; Overpass hanging → `nominatim+photon` in 2.5 s; all down →
the honest line in 3.5 s, no re-check, and the next ask in 2 ms; with a fake key → `google_pro`, free
sources not asked; Google failing → free sources; Open-Meteo hanging → MET Norway in 3 s, then MET first;
both down → 3 tries, the plain line, one re-check. Run 5 times, all `ok`.

## Gotchas

- **Load-sensitive timing tests.** `places-breaker` "every server hanging … in under 10 s" and
  `places-sources` "every source down … inside the budget" took ~27.8 s on a loaded Mac (2026-11-14) and
  passed alone on rerun (20/20). Rerun the file alone before calling it a regression.
- `places-sources` "Nominatim: at most one request a second" can take minutes under load; it is the queue.
- The capability manifest lines (`grep -n 'name: "nearby_places", status' src/tools.js`) still say
  "via OpenStreetMap" / "via Open-Meteo" only; the behaviour above is the source of truth.
- Never set a real `REASON_GOOGLE_PLACES_KEY` on a cage: each request is counted and may bill. slot.sh blanks it.
