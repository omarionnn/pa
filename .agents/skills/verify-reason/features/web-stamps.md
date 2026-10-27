# Reason Web — Stamps and shared stamps

A passport-style book of things Reason did worth remembering (handoff 2026-10-27 "Coming back daily"
§2 + Sharing, `reference/stamps.html`). Behind `REASON_WEB_DAILY` (off | owner | on, `src/dailyflag.js`).
Code: `src/stamps.js` (catalog, tables `stamps` + `stamp_shares`, awarding, backfill, redaction,
`newestStamp`, `stampMarkup`), `src/pages/webstamps.js` (the book, the share API, `/s/` pages, the
1200×630 card), `src/pages/webdailyhead.js` (`dailyHeader`, shared with the daily Home),
`scripts/stamps-backfill.mjs`. Completion hooks: `db.completionBus` emitted by `finishTask` (done),
`updateCall` (outcome_kind written), `markAgentcardPurchase` (placed / ticket issued).

## Sub-features

- **Awarding** where errands finish, only for a conversation the flag allows. `first` (first finished
  errand of any kind), `night_shift` (00:00–06:00 on their clock, nothing from them in the hour before;
  one per night), `three_in_one` (3 done tasks sharing `tasks.origin_handle`), `long_hold` (≥30 min
  `hold_total_s`, a person reached), `human` (`menu_presses` non-empty, a person reached),
  `price_drop` (order's `offer_id` = a price watch's `alert_offer_id`, baseline − price ≥ $1),
  `early` (flight first leg ≥7 days after booking). Never awarded: `abroad`, `whole_trip` (no source).
  Unique (conversation, type, ref): never twice.
- **Told once** in the thread, one line ("That one earned a stamp for your book: …."), ONLY at `on`,
  through `runtime._tell` installed by `createServer`; never at `owner`, never from the backfill.
- **The book** `/web/stamps`: PAGE N · count · SINCE MONTH, 8 spots/page (page 1 oldest, newest page
  default), NEW in pen on the newest, 44px share link `Share {name}` (`?stamp=<id>#share`, no script
  needed), blank dashed spots, ≤2 hints, aside story + keep line + thread link, Caveat count of blanks.
  Empty: hints only, no share panel.
- **Sharing**: `POST /web/api/stamps/<id>/share` (JSON with `x-reason-csrf`, or a form with `c`;
  sameOrigin) → `{url:"https://heyreason.com/s/<12 base62>"}`; one live link per stamp; `…/share/revoke`;
  `GET …/<id>/image.png?name=0|1` = Save image (owner only). Events: log lines `stamp_share_created`,
  `stamp_share_opened` (+ `opens`), `stamp_share_signup` (+ `signups`, from `/access/web` body `ref`;
  the website's form does not send `ref` yet — stub on the site side).
- **Public** `/s/<shareId>` + `/og.png`: no sign-in, `X-Robots-Tag` + meta noindex, og + twitter
  summary_large_image, CTA `heyreason.com/?ref=s_<id>`. Revoked = never existed = malformed `/s/…` → one E1-style 404 page (`webedge.js renderShareNotFound`, noindex, "Get your own Reason"), byte-identical; their og.png a plain JSON 404.
  Share ids are 12 chars; ride-along sign-in tokens are 32–64 (`signin-remote.js` TOKEN), and an id with
  no share falls through to that handler unchanged.
- **Redaction**: public output carries only name, duration/count, optional first name
  (`publicFace`, `publicLine`). Pinned in `test/stamps-web.test.js` "REDACTION".

## How to get to it (user POV)
Signed in on Web with the flag allowing them: header STAMPS (`/web/stamps`). A friend opens the
shared `heyreason.com/s/…` link from iMessage.

## Drive it here
`REASON_DB_PATH=$(mktemp -d)/stamps.db node bin/web-stamps-drive.mjs [outDir]` under `caged.sh env`:
empty → a real `finishTask` earns First errand → many pages → share via the endpoint (cross-site 403)
→ public page + real Chromium og.png (1200×630) → Stop sharing → the 404 page; PNGs at 390/1280 Paper/Night and
`compare-stamps.png`. Tests: `test/stamps.test.js`, `test/stamps-web.test.js`.

## Live proof
From Hetzner: short-lived owner `page_sessions` row → `https://heyreason.com/web/stamps`; share proof
only on a throwaway account (created then deleted with its stamps, shares and sessions).

## End state that proves it
The book draws the owner's real stamps; a share URL opens without sign-in, noindex, with its card;
revoked answers the same 404 page as an unknown id; no public output names a merchant, company, place, price or person.
