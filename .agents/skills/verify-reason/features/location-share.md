# Location share handling

Somebody shares where they are from Messages, and Reason uses it — "what's good near me", "how far
is it", "walk or train". Shipped 2026-10-10 in `fcc3437`, and **it has no test of its own**: the
drive below is currently the only proof it works.

Source: `src/channels/sendblue.js` → `describe(event)` (end of file); the prompt line in
`src/agent.js`; `src/places.js` for the address lookup.
Tests: none yet. Writing one into `test/sendblue.test.js` is the obvious next move — `describe` is
nearly pure (one injectable fetch), the fixtures below are already the right shape, and it pins the
thing that is easiest to break.

> **Moving target, as of 2026-10-10.** `fcc3437` is committed, but `src/channels/sendblue.js`,
> `src/tools.js` and a new untracked `src/places.js` had further uncommitted work in the tree when
> this was written: `describe` became `async`, it now reverse-geocodes the coordinates through
> OpenStreetMap Nominatim, and a `nearby_places` tool arrived. Both shapes are described below.
> `bin/evidence.sh new` records the exact `HEAD` and the uncommitted-file list for this reason —
> check `00-provenance.txt` before trusting an old proof.
>
> **Still uncommitted at `6c4cabf` on 2026-10-10** (maintenance re-drive). `nearby_places` is now a
> fully registered live tool in the tree — `src/tools.js:4234` (schema), `:5036` (input), `:11787`
> (implementation), and listed in the capability manifest at `:1305` — but `src/places.js` is still
> untracked and `src/channels/sendblue.js` is still modified, so none of it is in a commit. Every
> drive below was run against the tree, and every one passed.

## Sub-features

- **A real share, parsed.** `message_type === "location"` with a `location` object →
  `[they shared their location: <lat>, <lng>, accuracy ~<n>m (sharing: <duration>) — use this as
  their current position for anything location-related]`. Accuracy is rounded; accuracy and duration
  are each optional and omitted when absent.
- **The address, when it can be had** *(uncommitted work)*. `reverseGeocode` in `src/places.js` asks
  Nominatim (free, keyless, 3s timeout) and on a hit the line becomes
  `[they shared their location: <display_name> (<lat>, <lng>, accuracy ~<n>m)(sharing: …) — … Use
  nearby_places with these coordinates to find places near them]`. On a miss or a timeout it falls
  back to the bare-coordinates line above, so a dead Nominatim degrades rather than breaks.
- **An unreadable app card, handled honestly.** `app_card` with no structured location → a line
  saying it is an iMessage app card, often a location share but possibly a game or a sticker,
  unreadable either way, and that if context suggests they were sharing where they are, ask for the
  address or a cross street. The old line was just "they sent an App Card, which you cannot read",
  which left the model ignoring it.
- **The branch order.** Real coordinates win: the `app_card` line is the `else`, so a payload
  carrying both does not get the apologetic hint.
- **The model connects it up.** The prompt tells it to use shared coordinates for nearby-place and
  direction questions, and to join the dots when an unreadable attachment lands in a conversation
  that was about where somebody is.

## How to get to it (user POV)

In Messages: the contact's name at the top → **Share My Location** (or Find My → Share My Location),
pick a duration. Sendblue delivers it as a `location` webhook. Reason answers in the thread.

The fallback case is the same tap on an iOS version or app that sends an opaque app card instead:
Reason gets a card it cannot read and has to say so without pretending.

## Driving it with the harness

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
bin/caged.sh start
bin/doctor.sh 8796

dir=$(bin/evidence.sh new location-share)
bin/evidence.sh run "$dir" 01-doctor      -- bin/doctor.sh 8796
bin/evidence.sh run "$dir" 02-location    -- bin/inbound.sh file features/payloads/location.json
bin/evidence.sh run "$dir" 03-thread      -- bin/peek.sh thread
bin/evidence.sh run "$dir" 04-app-card    -- bin/inbound.sh file features/payloads/app-card.json
bin/evidence.sh run "$dir" 05-thread      -- bin/peek.sh thread
bin/evidence.sh run "$dir" 06-bare        -- bin/inbound.sh file features/payloads/location-bare.json
bin/evidence.sh run "$dir" 07-both        -- bin/inbound.sh file features/payloads/location-and-app-card.json
bin/evidence.sh run "$dir" 08-thread      -- bin/peek.sh thread
bin/caged.sh stop
ls "$dir"
```

Four payloads, one per branch — all 40.7484, -73.9857, the Empire State Building:

| Payload | The branch it proves |
|---|---|
| `payloads/location.json` | the full share: accuracy 12.5m, one hour |
| `payloads/app-card.json` | the opaque card, no `location` object |
| `payloads/location-bare.json` | `{latitude, longitude}` only — both optional fields drop |
| `payloads/location-and-app-card.json` | both keys present — the branch order |

**End state that proves it.** In `bin/peek.sh thread`, the `user` message for the location payload
carries the parsed coordinates and the `assistant` reply places them. The run on 2026-10-10 against
the geocoding tree gave exactly this:

```
[user] [Sat, Oct 10, 2026, 10:45 AM] Omari: [they shared their location: 350, 5th Avenue, Koreatown,
       Manhattan Community Board 5, Manhattan, New York County, New York, 10118, United States
       (40.7484, -73.9857, accuracy ~13m) (sharing: 1 hour) — use this as their current position for
       anything location-related. Use nearby_places with these coordinates to find places near them]
[assistant] got you, you're at the empire state building. what do you need around there?
```

On committed `fcc3437` the same payload gives the bare-coordinates line and a reply like *"got you,
you're right by the empire state building. what do you need?"* — both are passes.

Then the app card, posted into the same conversation, must be handled *and* joined up:

```
[user] [they sent an iMessage app card — … ask them to type the address or cross street instead]
[assistant] that last one didn't open on my end, but i've still got you at the empire state
            building. what are you looking for around there?
```

That second reply is the whole point of the prompt line: it admits it could not read the card and
connects it to the position it already had, rather than ignoring it or inventing one. Re-driven
2026-10-10 at `6c4cabf` + the geocoding tree, and it still does both:

```
[assistant] that last one didn't open on my end. if it was your location, i've already got you at
            5th ave by the empire state building, so what are you looking for around there?
```

The remaining two branches, from the same run:

```
# location-bare.json — no accuracy, no duration, both simply absent
[user] [they shared their location: 350, 5th Avenue, … United States (40.7484, -73.9857) — use this
       as their current position … Use nearby_places with these coordinates …]

# location-and-app-card.json — the location branch wins, no apologetic card line anywhere
[user] [they shared their location: 350, 5th Avenue, … (40.7484, -73.9857, accuracy ~13m)
       (sharing: 1 hour) — …]
```

Pure-function check, no server, when you only changed `describe`:

```bash
cd ~/Desktop/pa
node --test test/sendblue.test.js        # the adapter's offline suite (no location test in it yet)
```

## Gotchas

- `12.5` renders as `~13m` — `Math.round`. Do not assert the input back.
- **This is the one inbound path that reaches the internet.** With the geocoding work in the tree,
  `describe` calls Nominatim, so the caged instance is not offline for location shares. A slow or
  blocked Nominatim adds up to 3s and silently drops you onto the bare-coordinates line — which
  looks identical to a regression in the address feature. Drive it twice, or inject `fetchImpl`.
- `describe` became `async`, and `receive` now `await`s it. Anything calling `describe` synchronously
  gets a `Promise` stringified into the transcript.
- `accuracy` and `duration` are each dropped when absent, so three different strings are possible
  from one `location` object. `payloads/location-bare.json` is the bare case.
- **`describe` is not exported.** Reaching it means going through `receive`, which means the secret
  header and a unique `message_handle` — i.e. `bin/inbound.sh`, or a `SendblueChannel.receive` call
  in a test.
- The coordinates are only a *line in the transcript*. Whether Reason does anything useful with them
  is the model plus the prompt, and that is not deterministic. Assert that the line is right and
  that the reply is on-topic; never assert the wording.
- A payload with both `location` and `app_card` must take the location branch. That ordering is
  the one thing in this feature a refactor can silently invert, and
  `payloads/location-and-app-card.json` is the payload that catches it: a pass is the geocoded
  location line with **no** app-card sentence anywhere in the same `user` message.
- **The comment in `src/channels/sendblue.js` says "`request_location` is how Reason asks for one".
  There is no such tool** — `grep -c request_location src/tools.js` is 0. Reason can read a share it
  is given; it cannot ask for one. Do not promise that in a reply or build on it.
