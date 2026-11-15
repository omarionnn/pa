# iPhone app API (`/ios/v1`, src/ios/ — REASON_IOS_API)

Switch `REASON_IOS_API` = off (default) | owner | on (`src/config.js:441`). **Live: `owner`**: only the
signed-in owner gets answers; everyone else, on every route, gets exactly what a path nobody issued
answers (`src/http.js:332`). Contract: `docs/ios-api.md`. Code: `src/ios/` (`api.js`, `session.js`,
`messages.js`, `feed.js`, `live.js`, `memory.js`), routed in `src/http.js:325`.

## Sub-features

- **Sign in** (`/auth/code`, `/auth/verify`): a texted code, owner's number only under `owner`.
- **The Page** (`/page`) and receipts: each piece of work as `working` / `waiting` / `ready`, calls,
  purchases (`amount_cents`), checkouts.
- **Talking to Reason** (`POST /messages`): a real turn; replies carry `reply_to` / `turn_done`.
- **Live updates** (`/live`, a stream): the reply events plus progress lines, at most 60 chars, from the
  real step (`src/progress.js` `phraseFor`: `web_search` → "Checking Ulta and Target for CeraVe", `weather` →
  "Checking the weather in Accra", `team_flag` → "Flagging this to the team", `remember` → none).
- **What Reason knows** (`/memories`): list, correct, forget one (cut out of the message it came from),
  answer a guess, forget everything (`{"confirm":"FORGET EVERYTHING"}`).

## How to get to it (user POV)

Only the owner, in the iPhone app (not public). Anybody else probing `https://app.heyreason.com/ios/v1/…`
sees a plain 404 indistinguishable from a made-up path.

## Driving it with the harness

- Offline: `node --test test/ios-api.test.js` (50; all pass 2026-11-14 in the misc group 122/122).
- Flat 404, no model: on a cage, compare `/ios/v1/page`, a bad-code `/auth/verify`, `POST` and `GET` of an
  unissued path; status and body hash must be identical. 2026-11-14 (`7d5b5f54`, cage 8844, switch at the
  default): all four `404` with the same body hash (evidence `*-g4-ios-api`). Probing live is safe the
  same way: a made-up number texts nobody, but never POST the owner's number to `/auth/code` as a probe
  (it texts a real code).
- Progress lines, no model: import `src/progress.js` on a throwaway `REASON_DB_PATH` and print `phraseFor`
  for a few tools (script in `evidence/20261114T232701Z-g4-ios-api/ios-progress.mjs`).
- Messages: `POST /messages` is a real turn (`model`). Drive only on the cage, with the owner's go.
- Forget marking needs the real model (a span reader); the Mac cage's sealed config has no login, so drive
  `setSpanReader` with `claude -p` on a throwaway DB (`model`). Never forget against live data as a test.

## Gotchas

- Under `owner` a non-owner's request falls through to the not-found answer: there is no 401/403 to
  detect. A 404 is not proof the route is broken.
- `DELETE /memories/{id}` may answer `503 try_again` when the forget couldn't be worked out yet; nothing
  changed. Under `owner`, even `POST /auth/code` for a sent code answers the flat 404, so the answer never
  says which number is the owner's.
