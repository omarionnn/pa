# Reason Web — the wax-seal book (Stamps v2)

The Stamps look from handoff 2026-10-27 "S3 · Old money, made real" (`~/Desktop/reason-stamps-handoff-2026-10-27`,
`reference/stamps.html`, `stamp-kit.html`, `home.html`, `components/*.svg`). Behind `REASON_STAMPS_WAX`
(off | on, `src/dailyflag.js waxLook`) on top of `REASON_WEB_DAILY`: off draws the typed book exactly as
before ([web-stamps.md](web-stamps.md)). Same `stamps` rows; stored types unchanged, so every stamp already
earned carries over to its wax.

Code: `src/seal.js` (`seal({ wax, ring, date, postmark, size, paper, label })`, `patch`, `ticket`,
`complimentsCard`, `words`/`ordinal`/`fullDate`/`postmarkDate`), `src/stamps.js` (`SEALS` wax catalog,
`OUTSIDE`, `waxSummary`, `publicSeal`, `suiteCandidates` + table `stamp_jobs`, `anniversaryCandidates`,
`checkAnniversary`), `src/pages/webseals.js` (the book, SHARE IT, kept outside, 1200×630 card, 9:16 story,
public page), `src/pages/webstamps.js` (routes switch on `waxLook()`), `src/pages/webdaily.js` (`sealTile`),
`src/db.js` (`research` completion event).

## Sub-features

- **The seal**: every layer of `seal-oxblood.svg` (displaced edge + 4 drips, rim, recess, ring text, italic
  r + bubble, diffuse soft-light + specular screen .55, gloss, inked postmark + 3 cancels; black = rust ink);
  blank = relief only on paper; per-seal ids; a flat disc outside every filter (reads with no filters).
- **Wax by errand**: long_hold→oxblood "Held on your behalf", night_shift→green "Attended to overnight",
  price_drop→oxblood "A better rate, secured", human→black "Spoke to the manager", early→green "Well ahead
  of the occasion", abroad/whole_trip→navy (never awarded: no source), three_in_one→black "Three in one".
  Ring text spelled out, ends " ·"; stories end "It was no trouble."
- **Kept outside the book**: `first` → the first-errand patch; `anniversary` (a year after `accounts.created_at`,
  serial = place among everyone who reached a year) → the ticket; `suite_key` (call + research + online
  purchase + one more, all finished within 2h of the first step's start; one `stamp_jobs` row with
  `started_at` + 4 steps; a call's/research's own task is not "one more") → awarded, NOT drawn (no visual in
  the handoff).
- **The book** `/web/stamps`: PAGE N · n SEALS SINCE MONTH, "Your book.", paper sheet (paper in Night too),
  8/page, seals 160px tilted by `rotation`, name, date (· NEW in rust), `Share {name}` 44px; ≤2 not-yet
  blind-embossed spots on the last page with the hint engraved + below; aside: THE NEWEST, story, thread
  link, SHARE IT, KEPT OUTSIDE THE BOOK, Caveat "N spots left on this page."
- **Sharing**: the compliments card on bottle green (`#1f3a2e`) sealed in the seal's own wax; Show my first
  name rewrites the card line + its label; Copy link / Send in iMessage (Apple only) / Save image
  (`image.png`, 1200×630); `story.png` 1080×1920 (no button in the references). `/s/<id>`: large seal,
  "Reason held … on {first}'s behalf.", date in full, CTA `?ref=s_<id>`, og.png = the card. Redaction:
  `publicSeal` only (price_drop's public ring drops the dollars).
- **Home**: "New in your book" = newest seal (not a one-off) of 7 days, 104px, no postmark, name + one line.

## Drive

`REASON_DB_PATH=$(mktemp -d)/seals.db node .agents/skills/verify-reason/bin/web-seals-drive.mjs [outDir]` —
real HTTP, real completions (task/call/research/purchase) → patch, Held, suite key job; book states Paper +
Night at 390/1280; share → public page, real og.png 1200×630, story.png 1080×1920; revoke → the same 404 page as `/s/doesnotexist` (Paper/Night 390/1280 shots `seal-404-*`), og.png plain 404. 13 steps. Dates: every postmark/patch/card/story/share date is `tzFor(conversation)` (accounts.notice_tz → notice_sweeps.time_zone → REASON_TZ); the anniversary ticket's months too (was UTC until 10-27). Omari's First errand reads OCT 5 2026: task 1 finished 2026-10-06 03:06:21 UTC = Oct 5 11:06 PM ET — correct.
Tests: `test/stamps-wax.test.js` (18). Staging: `npm run web:staging` sets `REASON_STAMPS_WAX=on`
(rows stamps*, stamp-card*, stamp-story, stamp-share-public).

## Live check (read-only)

`grep REASON_STAMPS_WAX /opt/reason/.env` — absent/off on prod until the owner's go; the typed book is what
prod serves. `sqlite3 data/reason.db "SELECT COUNT(*) FROM stamp_jobs"` exists after deploy.

**Phone widths, two-up (#251, 2026-10-30).** At ≤480px the book is two seals a row (`@media (max-width:480px)` in `src/pages/webseals.js` CSS): seals scale to the cell, the date + share row sits at the foot of each cell so dates line up across a row, the empty page's not-yet spots are two-up too; desktop keeps `auto-fill, minmax(170px,1fr)`. `bin/web-seals-drive.mjs` reads `REASON_STAMPS_EVERYDAY`: with it on, the drive's research earns Looked into, thoroughly, so the counts are one higher (2 / 12). Both runs all ok; checked 360/390/430 light + night: 2 a row, nothing clipped, no overlap, no sideways scroll.

**One seal per kind + milestones (#256, `REASON_STAMPS_TIERS`, 2026-10-30).** Needs EVERYDAY. A kind is in the book once (`foldBook` in `src/stamps.js`; `listStamps` and webstamps `bookOf` both fold). Everyday kinds count up and are upgraded in place at per-kind milestones scaled to how common they are (`TIERS` in `src/stamps.js`): `looked_into` 500 / 1000 / 2000, `rang` 25 / 100 / 250. Rare kinds stay their first one, no count. Drawing (`seal.js` `tierArt`, `tier` = 2–4, `mark` = the real count on the ribbon): 2 rust ribbon, 3 gold ribbon + gold ring, 4 + double ring and gilded edge ("· 2000 ·" is 60px of an 89px ribbon at 390). Research rows are written twice (`research:week:` and `research:q:<day>:<sha16>`); each book hides the other's, so flag off = instant rollback. Owner backfill: `scripts/stamps-backfill.mjs --conversation=dm:owner --run` (tells nobody at owner mode). `bin/web-seals-drive.mjs` reads the flag: with it on the "many" step expects 7 seals on one page (folded), then 25 calls → one Rang with the 25 ribbon. Suite under `env -i`: 4,597 / 4,482 pass / 0 fail / 0 cancelled; drive all ok in off, everyday and tiers modes. Staging `stamps-tiers--reason-web-staging.netlify.app/stamps-tiers-{owner,board}.html`.

**Stamps for everyone (`REASON_STAMPS_ALL`, 2026-10-30).** One flag (`src/dailyflag.js` `stampsOpen` / `stampsAllowedFor`) opens what `REASON_WEB_DAILY=owner` kept to the operator — the book and its share/revoke/image routes (`src/pages/webstamps.js`), public `/s/<id>` shares, live awards and the suite/anniversary check (`src/stamps.js` `awardLive`/`onAny`), share sign-up counting, and `scripts/stamps-backfill.mjs`'s conversation list — to everyone with an account, without the daily edition. Ordinary Home (`src/pages/webconvo.js`) gets STAMPS in the top bar + phone menu and, wax book only, a "New in your book" tile for a seal of the last 7 days (`sealTile` + `SEAL_TILE_CSS` from `src/pages/webdaily.js`). **Nothing is told**: `tellNew` still needs `REASON_WEB_DAILY=on`, so no thread line is sent at `owner`; the backfill never tells. Off: exactly as before (book 404, no link). Test `test/stamps-all.test.js`; `bin/web-seals-drive.mjs` has a last step for someone who isn't the operator (on: book 200 + STAMPS link, shots `other-book-390-*`; off: 404, no link). Before flipping on live: dry run `REASON_STAMPS_ALL=on scripts/stamps-backfill.mjs` on a `.backup` copy (`REASON_DB_PATH=`), then `--run` on live.
