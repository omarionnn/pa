# The welcome gallery: seven picture cards in the first chat (src/welcome.js, REASON_WELCOME_CARDS)

Switch `REASON_WELCOME_CARDS` = off (default) | owner | on (`src/welcome.js:52` `mode()`). **Live: `on`**, so
every new person's first chat carries the cards. `owner` puts them in nobody's first chat; it only lets
`scripts/welcome-to-owner.js` send them once to the owner's own thread. Shipped in #462 to #466 (2026-11-10).

Source: `src/welcome.js` (`CARDS`, `bubbles`, `cardUrls`, `fileForPath`, `WEB_INTRO`, `HELP_FIRST`),
`src/onboarding.js` (`commitStep` queues the set as one ordered outbox chain), `src/http.js:1057`
(`/img/welcome/<version>/NN-key.jpg`, `immutable`, a year), `src/outbox.js` (a card that can't go is sent as its text line),
`src/channels/sendblue.js` (`sendCarousel` → `POST /api/send-carousel`). Art: `assets/welcome/` (JPEGs) and
`assets/welcome/art` (SVG), drawn by `scripts/make-welcome-cards.mjs`.
Tests: `test/welcome-cards.test.js` (26).

## Sub-features

- **The seven, in this order:** Calls, Events, Reminders, Shopping, Food, Booking, Everything else. Each card
  has a title, a short note and one request they could text right now (Calls: "Call my dentist and move my
  cleaning to next week."). As words, a card is `Title: "request"` (`textLine`). There's no card for reading
  their messages or inbox.
- **Texted first:** who Reason is, then the seven, then "what's your name?". A real request as the very
  first text gets the turn first, then "by the way…", the pictures, the name ask. Web setup
  (`REASON_WEB_SETUP`): the line from the page (`WEB_INTRO`: "hey <name>, <their Reason's name> here.
  picking up from your setup, here's what i can do for you"), the seven, then "What would you like help
  with first?". Their first reply gets a normal turn, then the contact card.
- **One swipeable stack.** Sendblue gets ONE carousel message with all seven (the cards' public addresses).
  If the line refuses carousels (a V1 line) or it fails twice on passing errors, the seven go as separate
  pictures in its place. A picture that can't go is sent as its text line in the same place. A channel
  with no files gets the seven lines. The set always arrives whole and in order. A reply sent while the
  gallery is held waits until after the question.
- **Never twice, never to existing people.** Accounts that already had them, or were never in the flow,
  get none. A restart mid-send finishes the chain and never repeats a card.
- **The pictures are public and versioned.** `GET /img/welcome/<8-hex version>/01-calls.jpg` → 200
  `image/jpeg`, cached for a year. Any other version → 404, so a cached old picture is never served at
  today's address.

## How to get to it (user POV)

A brand-new number texts Reason ("hey") and gets the intro, a stack of seven cards to swipe, then the
name question. Somebody who set up on the web gets the stack right after the page hands off to texting.

## Driving it with the harness

- Offline: `node --test test/welcome-cards.test.js` (26; `test/onboarding*.test.js` cover the off/owner paths, through the real router and outbox with a
  FakeChannel and a stated reader; 137/137 with the onboarding files on 2026-11-14).
- Cage, no model: the picture route. The version is `node -e 'const w=await import("./src/welcome.js");
  console.log(w.setVersion())' --input-type=module` from the repo root; then
  `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:$P/img/welcome/<v>/01-calls.jpg`
  → `200 image/jpeg` (01 and 07 both), `/img/welcome/00000000/01-calls.jpg` → 404 (2026-11-14, `7d5b5f54`,
  version `f498b171`).
- The first-chat stack on the cage needs the onboarding read, which is a model call (haiku on the
  subscription, `src/onboarding.js` `readText`). On the API cage with no key, the read returns nothing,
  the flow ends and no gallery goes. So the end-to-end stack is a `model` drive: `bin/onboarding-drive.sh`
  with `REASON_WELCOME_CARDS=on` exported. The fake Sendblue capture should then show one
  `/api/send-carousel` with seven addresses between the intro and the name ask.
- Owner preview on live: `sudo -u reason node --env-file=.env scripts/welcome-to-owner.js --confirm=welcome-1110`
  on the live server (OVH, root@15.204.113.250). Owner-only, once (a marker file in the data dir), and only
  with the owner's go.

## Gotchas

- Carousels need an `https` public base (`REASON_PAGES_URL` or `REASON_PUBLIC_URL`). Without one, `cardUrls`
  is null and the seven go as separate pictures, which is not a failure.
- Changing an image changes the set's version, so every old address returns 404 from then on. That's on
  purpose.
- Choice cards (shopping and places options) use the same one-stack delivery (#553,
  `REASON_PICTURE_STACKS`, default on). That's covered in the choice-cards feature, not here.
