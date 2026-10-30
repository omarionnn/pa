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

## Owner-only
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
