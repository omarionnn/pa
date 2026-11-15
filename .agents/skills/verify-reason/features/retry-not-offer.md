# Retry, don't offer: a failed read-only lookup is tried again in code (src/retry.js, 09ec2e23, #555)

What a person sees: when a lookup (weather, a web search, their mail or calendar) fails for a passing
reason, Reason does not say "if you want, I can try again". It has already retried. If every try failed,
the reply says what happened and that Reason will check again and text them, and it does, once, about
10 minutes later. On a call, the spoken answer drops the offer and says the answer will come by text.

Live state: no switch (no `REASON_*` flag in `src/retry.js`): on for everyone since it merged.

Source: `src/retry.js` (`RETRY_TOOLS`, `isTransient`, `retryTransient`, `scheduleRecheck`,
`exhaustedNote`, `offerNote`), `src/tools.js:9782` (the wrap around `runToolInner`), `src/runtime.js:650`
(the reply check rides the existing one rewrite, no extra model call), `src/calls/cartesia.js:925` (spoken).
Test: `test/retry-dont-offer.test.js` (15).

## Sub-features

- **Only read-only lookups are wrapped** (`RETRY_TOOLS`, `src/retry.js:25`): `web_search`, `web_lookup`,
  `image_search`, `find_all`, `weather`, `nearby_places`, `transit_status`, the Gmail, Google/Apple calendar
  and Drive reads. Nothing that buys, sends, books, calls or signs in is ever retried here.
- **Bounded:** 3 tries, pauses 0.4 s and 1.5 s, inside a 25 s cap (6 s on a call); a try that would not
  fit the cap is not started (`src/retry.js:56-61`). The result carries a numbers-only `tries` field.
- **Never retried:** a refusal, a wrong password, a bot wall, a limit, a declined payment, a not-found.
- **Every try failed:** one re-check timer (`recheck:lookup`, 10 min, set once); the tool note states it.
  A later success in the same conversation calls the re-check off.
- **The reply check is code's:** a draft offering to try again after a failed lookup is sent back through
  the one rewrite to run it now (tries left) or to state the outcome and the re-check. A declined payment
  stays a plain statement. Real questions (their choice, the call passphrase ask, a team flag offer, a
  save-login question) are never rewritten.

## How to get to it (user POV)

Ask for something that needs a lookup while its provider is failing ("what's the weather in Accra?"
with the weather service down). The reply states the outcome and the re-check; a text with the answer
follows when the re-check runs.

## Driving it with the harness

- Offline: `node --import ./test/paid-key-guard.js --test test/retry-dont-offer.test.js`
  → 15/15 on 2026-11-14 (`7d5b5f54`, evidence `*-g4-retry-not-offer`). The tests drive the real Runtime with
  a scripted backend and injected fetch: weather 503 then a reading, weather down on every try (re-check
  set, no second turn), the call's spoken answer.
- Live drive: `model`. Seeing the rewrite needs a real reply turn whose draft offers a retry, plus a
  failing provider. On a cage that means a claude-cli turn with weather pointed at a refusing fetch. Not
  run in this pass (no model turns).

## Gotchas

- A lookup that failed once for a non-passing reason is not retried in code, but the reply check can still
  ask the one rewrite to run it again.
- The re-check is a real timer: on a cage it texts the fake channel about 10 minutes later. Stop the cage
  or clear `timers` if a drive should leave nothing behind.
- The team-flag offer (`team_flag`, see [ops-alerts.md](ops-alerts.md)) is deliberately not a retry offer
  and is left alone.
