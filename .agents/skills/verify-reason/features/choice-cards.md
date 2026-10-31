# Choice cards (src/choicecards.js) — REASON_CHOICE_CARDS off | owner | on

2–4 real shopping or place options, each a numbered picture card in its own bubble, after one short line.

## Offline
- `node --test test/choicecards.test.js` — flag, draw/send order, text-list fallback, unseen image refused,
  og:image from the page, tapback parsing (a real Sendblue tapback text), inline reply on card N, expiry.
- `node --test --test-name-pattern="choice cards sit" test/web-design.test.js` — Web joins consecutive cards into one row.

## Listing check (products only)
Price and every size on a product card must be what the store listing the PHOTO came from says
(`seen_urls.from_url` of image_url, else the option's url; re-read with webLookup, Extract first). Price:
an amount near the top of that listing. Size: in the listing's TITLE (a page lists all its sizes), and
not contradicted by the photo's file name ("_12oz_"). Anything not backed is left off and named in the
tool's note (log `choice_cards_unbacked`). No listing / photo from elsewhere / different product → no
price, no size. Places are never checked. Offline: the "listing check" tests in test/choicecards.test.js.

## One photo short is not a list (owner's CeraVe, 2026-10-31)
- A product option with no usable picture is LEFT OUT of the set (log `choice_cards_left_out`, named in the
  note as "Not in the set"); only fewer than 2 photos → numbered text list. If drawing fails, the list carries
  every option again.
- Product picture order: image_url → the page's og:image (plain read) → the pictures the listing read
  (webLookup) returned → a picture search (`choice_product_photo`, Parallel; none on the Mac) whose hits are
  each LOOKED at (claude-cli haiku, `feature: "product_photo"`, `_setProductLook` in tests): only a label that
  IS this product/variant is used. No look → no searched photo. A searched photo off the listing → no price,
  no size on that card.
- offer_check marks the page it read as seen (never a /blocked wall), and a price offer_check read off that
  exact page in the last day backs the card's price (`db.offerPricesFor`).
- A pick on a product set where Crossmint buys (`connectAllowedFor`): the read-along line says store_checkout
  with that option's page. Offline: test/choice-cards-fallback-1031.test.js.
- Server live-code check (scratch copy /tmp/rp-* + DB .backup, run as reason, no model turn, nothing sent):
  his three Ulta sizes → 3 cards with $18.99/$16.99/$15.99 and the right bottle each; a Meijer/Ulta/Target
  set → 3 cards (2 by look-checked search). Renders: ~/Desktop/reason-choice-cards-1031/.
- Reply guard (src/offers.js): never a "(compared: …)" tail; a whole bracketed tool-note line is stripped
  (`tool_note_stripped`); "I'll find the cheapest" / "not a proven best deal" are not best-price claims.

## Places: the room, not the cup (2026-10-30)
`rankPlacePhotos`: candidates = the passed image_url + the place page's top 4 pictures (size copies
collapsed; further down a directory page is the neighbours). Up to 6 fetched, then ONE claude-cli call
(haiku, `feature: "place_photo"`, `REASON_PLACE_LOOK_MODEL`) labels each: inside / outside /
product_or_food / logo_or_menu / people_closeup / other, room 0–3, other_business, own_name.
Rules: inside+room≥2 best, then an outside shot ONLY if this place's name is readable on it, then its
own coffee as last resort; another business, a logo, an unsigned front, a photo it didn't answer for:
never. No repeats in a set. Nothing usable → photoFor, which may not draw a rejected or repeated photo →
else the set is a numbered list. Log `choice_place_photo {n, shows}`. Tests stub the look (`_setPlaceLook`).
Moodap's Flatiron pages carry neighbours' Street View frames even at the top (The Qi page → Bluestone's
and Devoción's), which is why fronts need their own name.

Then, only when the place's own pictures have no inside shot: Parallel image search "<name> <area>
interior" (`interiorSearch`; results kept only if their title/page names the place AND the area), looked
at the same way. The chosen photo is kept per place for 14 days (`place_photos`, key = page url or
name|area; log `cached: true`). The Mac cage has no place-photo source (no PARALLEL_API_KEY, OSM times
out): prove places on the server from a scratch copy (/tmp/rp + a DB `.backup`, run as `reason`).
No room in the search either → a second pass "<name> <area> storefront" + "<name> <area>"; a front counts only with its own name readable (own name overrides "other business"). One score for all candidates, so any room or signed front beats a cup. Live 2026-10-30: Joe Flatiron → its signed walk-up window, Devoción → inside, Bluestone → inside.

## Owner-only (until 2026-10-31; `on` for everyone since, appended to live `.env` — see shop-connect.md "Everyone")
`REASON_CHOICE_CARDS=owner`: `toolsFor` hides show_choices from every conversation whose account is
not `is_operator`. Cage 2026-10-30: a tester number (no REASON_MASTER_NUMBER) asked for cleansers to
pick from → 0 show_choices calls (send_picture instead); with `REASON_MASTER_NUMBER` set to that number
the same ask → show_choices, `choice_cards_sent 2 of 2`, then "2" → option 2. The cage needs
`REASON_MASTER_NUMBER` exported (no .env in a worktree) for the owner path.

## Caged drive (subscription turns: a handful, never a suite)
1. `node bin/fake-sendblue.mjs` won't do as-is: card sends upload first, and the fake must answer
   `/api/upload-file` with `{ media_url }`. Use a copy that does (2026-10-30 run: /tmp/cc-scripts/fake-sb.mjs),
   started as a long-lived background job, not `nohup … &` (the runner kills the group).
2. `REASON_VERIFY_BACKEND=claude-cli REASON_TEST_NUMBERS=+12025551234 REASON_VERIFY_FAKE_SENDBLUE=http://127.0.0.1:<port> REASON_CHOICE_CARDS=on bin/caged.sh start`
3. `bin/inbound.sh text "i have dry skin. which cerave cleanser should i get? want to see a couple to pick from"`
   → log `choice_cards_sent … sent N of N`; the capture shows the line, then upload+send per card, in order.
4. A yes/no ("is cerave fragrance free?") → no `show_choices` call.
5. `bin/inbound.sh text "2"` → Reason goes ahead with option 2. `"Loved an image"` → it asks which (the phone
   does not say). An inline reply payload with `reply_to.message_handle` = card 3's handle (`choice_sets.handles`) → option 3.

## Web
`node bin/web-choices-preview.mjs <outDir> card1.jpg card2.jpg card3.jpg` — one row of cards, every picture loads, 390/1280 × paper/night.

## Known limit
A tapback on a picture reaches Sendblue as the words "Loved an image" with no handle, so with several cards up it
cannot say which card; Reason asks. An inline reply on a card is exact.
