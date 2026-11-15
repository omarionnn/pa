# First-chat onboarding — `REASON_ONBOARDING` on (default) | test | off

**Live now (switches 2026-11-14):** `REASON_ONBOARDING=on`, `REASON_WEB_SETUP=on`, `REASON_WELCOME_CARDS=on`,
`REASON_INVITE_START=on`, `REASON_EVENT_ONBOARDING=on`. With the welcome cards on, the opener below gains the
gallery: who Reason is, the seven picture cards, then "what's your name?"; a request first gets the turn,
then "by the way", the pictures, the name ask; the web setup's hand-off is the page's line + the seven +
"What would you like help with first?" (`src/onboarding.js:99`, `:479`). That is
[welcome-cards.md](welcome-cards.md); this file describes the beats around it (and the exact flow with
the cards switched off or `owner`).

Somebody new texts Reason for the first time. With the switch covering them, their first chat is a few
beats and nothing more (owner-approved wording, 2026-11-06 — the 7-day review found new people left
during the old 3–5 question interview). One question per message; nothing ever asks what they do.

1. "hey" → `OPENER`, TWO bubbles in this order (owner, 2026-11-07): `INTRO` "hey, i'm Reason. i will help
   you with errands and complete your to do list for you", then `NAME_Q` "what's your name?" alone.
   Both ride one outbox chain (the question's row `after_id` = the intro's), so the question never goes
   first or alone. A real question first → its one-line answer, then the two opener bubbles. A name in
   the first text skips the ask: `INTRO` alone, then step 2.
2. Their name → saved (`accounts.name`, as my_name does), then the model's `name_line` from the same
   read: what the name means / where it comes from, one quality from it as a short warm compliment
   (Omar → long-lived/flourishing, Arabic, leadership). Unsure, awkward or negative meaning → no
   meaning, just something warm; never an invented meaning. A nickname (Bubba, JJ, Lil Mike, Big T,
   Boo, a gamer tag — the model judges it, no list) → no meaning or origin, just a short warm line
   about loving the name ("love that name, bubba"), saved as given; the ask still follows. A short form
   of a given name (Mike, Liz) is a given name (the full name's meaning only if sure); a nickname that
   is also a name (Sunny) may go either way, nothing invented. No line from the model → `MET(name)`
   ("nice to meet you, <name>"). Then exactly `CARD_NAME_ASK`: "what do you want to call me?" — alone.
   No card possible (`cardCanGo`: no public URL, no line number, already sent, a failed try inside
   `RETRY_AFTER_MS`) → nothing to name: `TRY_LINE` instead of the ask, and the flow is done.
3. The name they pick → the contact card under THAT name, `CARD_SENT(name, true)` on the card's own
   message ("Jarvis it is. here's my card, save it so you can always find me" — an invitation, never a
   claim it is saved), then `TRY_LINE`; flow `complete`. Optional hook, off by default
   (`REASON_INTRO_AMAZON=on`): `amazonconnect.OFFER` instead of `TRY_LINE` (state `awaiting_amazon`); the read's
   `amazon` field decides — yes → `LINK_LINE`, the link alone, `TRY_LINE`; anything else → `TRY_LINE`. Never
   nudged or re-asked. The step itself is `src/amazonconnect.js` (test/amazonconnect.test.js). "whatever" / "you pick" / no name → the card as
   Reason (`CARD_SENT("Reason", false)`). The card's address is `/reason-<sha8>-<token>.vcf`: the token is
   random per account (`accounts.contact_card_token`), the name is `accounts.contact_card_name`, and
   `src/http.js assetRequest` draws `FN`/`N` from it (`ORG` stays Reason). An unknown token draws the
   plain Reason card. Reason's own name never changes; the history carries a note (saving is theirs).
4. `TRY_LINE` — ONE nudge, two things to try: a call Reason makes for them (a restaurant, a store, an
   appointment, sorting something out while they get on with their day), or setting up and running an
   event. Never a call to chat with them.

Never in any bubble, read reply or prompt: "i'll save myself in your phone", "i'm in your contacts", or
anything implying Reason controls their phone (pinned in `test/onboarding.test.js`).

A real request (a `task` read, a picture or document) at any step: the normal turn does it first, then
`afterTask` sends the pending step (step 1 → `NAME_ASK`, two bubbles: `BY_THE_WAY` "by the way, i'm Reason…to do list for you", then
`NAME_Q` "what's your name?"; a
name already in the request → `BY_THE_WAY`, the name's line from `nameLine()` — its own side call — and
the ask; a steer on later steps). Detours and requests share the one-steer limit per step; past it the
flow moves on (the name passed on, the card as Reason). The turn's prompt while in the flow
(`accounts.ownerOf().firstChat === "active"` → `whoLine`) says do the request, ask nothing about them;
after a flow that ended without a name (`"done"`) it asks the name once, never an interview. The
placeholder prompt for anybody the flow does not cover follows the same shape (name once, a real
meaning or just warmth, no questions about their job or life, no phone-control wording, one offer of a
call or an event). Quiet mid-flow → ONE timer nudge ever (`NUDGES`), timer `onboarding:nudge`, moved to
10am if due 9pm–10am in their zone.

Who: a person whose account their own first text just made (auto-admit, or a pre-approved
`REASON_TEST_NUMBERS` number); an invite's joiner (their code text, right after the inviter's
"You're in, invited by …" line, is read by the flow → the opener); or an event joiner (`#claimEvent` →
`startAfterEvent`, after the organizer's welcome: the name typed on the page → `INTRO`, its `nameLine`,
the ask; no name → the opener). This REPLACES the old `EVENT_CARD_LINE` + "what do you do" follow-up;
with the switch off an event joiner gets `EVENT_CARD_LINE` + `TRY_LINE`, no question. Never the operator,
Web, or the master's yes. Every account made before the switch (NULL) or before the column (`complete`)
is exempt. States: `not_started` → `awaiting_name` → `awaiting_card_name` → `complete`; the old flow's
`awaiting_occupation`/`awaiting_todo` end on the next text. The startup card pass
(`backfillContactCards`) skips anyone mid-flow.

A step is ONE transaction (`db.atomically`): bubbles as an ordered outbox chain (the card a branch off
it, so a dead card takes nothing with it), state, history. The harm screen runs beside the read; not
clear → flow ends, normal screened turn. A failed read ends it too. Meaning is the model's: one
structured side call per text (`readText` through `askStructured` in `src/backends/side.js` — the CLI on claude-cli, skipped when `sideAskAllowed()` says no; `REASON_ONBOARDING_CLI_MODEL` haiku, feature `onboarding`; fields kind/name/card_name/
reply/name_line), plus `nameLine` only for a name the read did not see (event page, inside a request).

Source: `src/onboarding.js`; `src/channels/router.js` (`begin` on `arrivedNow`, invite claims included;
`#drainHeld`: `handle` then `afterTask` after the turn; `#claimEvent` → `startAfterEvent`),
`src/contact.js` (`cardName`, `contactCardUrl({ name, token })`, `contactPathParts`), `src/http.js` (the
card route), `src/db.js` (`contact_card_name`, `contact_card_token`, `setContactCardName`,
`contactCardNameByToken`), `src/accounts.js` (`firstChat`), `src/agent.js` (`whoLine`), `src/config.js`
(default on).

## Prove it

- Offline: `node --test test/onboarding.test.js test/onboarding-migration.test.js test/event-web.test.js
  test/contact-card-brand.test.js` — 42 flow tests (default on, the owner's opener, name → meaning line, nickname → warm line with no meaning
  + the exact nickname ask, no line → plain hello, pick → card under that name served as FN:Jarvis +
  the try line, skip → Reason, detours, request-first in three shapes, picture, read/screen failures,
  existing/finished/operator/off/test, old states, two people's cards isolated, startup pass, restart,
  nudge, invite joiner; pins: no "what do you do", no phone-control wording, the try line names a call
  and an event, one question per bubble), the event joiner's flow + the switch-off path.
- Cage, end to end (subscription: haiku reads + ONE full turn; fake Sendblue on loopback):

  ```bash
  REASON_VERIFY_RUN=/tmp/rv-onboarding REASON_VERIFY_PORT=8823 bin/onboarding-drive.sh evidence/<UTC>-onboarding
  REASON_VERIFY_RUN=/tmp/rv-onboarding REASON_VERIFY_PORT=8823 bin/onboarding-drive.sh evidence/<UTC>-before before   # flag off
  ```

  Two people: hey → who made you → kofi → jarvis, and a request first → bubba (a nickname: warm line,
  no meaning) → whatever. 14 checks, including the served card's `FN:Jarvis`, the exact nickname ask, the try line after each card, and no
  phone-control wording. Needs `claude` logged in on this Mac (on 2026-11-06 it said "OAuth session
  expired", so the name-card PR was proved in-process: stated reads, real router/outbox/card route).
- On live since 2026-11-06; `REASON_ONBOARDING=off` in `.env` turns it off. The cage drive is a `model`
  drive (subscription haiku reads + one turn); with the cards on, export `REASON_WELCOME_CARDS=on` and expect
  one `/api/send-carousel` between the intro and the name ask.
- 2026-11-14 (`7d5b5f54`): onboarding + web setup + welcome-card suites 137/137 (no model); the cage served
  `/img/welcome/f498b171/01-calls.jpg` and `07-more.jpg` as `200 image/jpeg`, an old version 404
  (evidence `20261114T232034Z-g4-cage-fake-ok`, `20261114T232702Z-g4-onboarding-welcome`). The model drive
  was not run (no model turns this pass).

## Names get a capital on each word (#426, 2026-11-10)

`nameCase` (`src/contact.js:62`) upper-cases the first letter of each word (after a space or a hyphen) and
changes nothing else: "kwame mensah" → "Kwame Mensah", "anne-marie" → "Anne-Marie"; "KWAME" stays "KWAME",
"mcKenzie" stays as typed. Used by the greeting (`MET`, `src/onboarding.js`), the card name (`cardName`) and its line.
Prove: `node --test test/onboarding.test.js` + `bin/onboarding-checks.cjs`.

## Web setup hand-off — `REASON_WEB_SETUP` on | off (default off)

heyreason.com/start (site repo, `public/start/`) asks name → Reason's name → Amazon / Gmail / card connect,
then opens Messages with `hey <reason name>, it's <name> · <code>` typed (`websetup.firstText`, lowercase,
4-char code from `abcdefghjkmnpqrstuvwxyz23456789`). Server: `src/websetup.js` (+ rows in
`src/websetupstore.js`), JSON under `/setup/api/*` via the site's signed `/setup/*` proxy; `rs_setup`
cookie (HttpOnly, 24 h) owns the setup and is accepted by `connectgate.browserConversation` for the
stand-in conversation `websetup:<id>` only. Connects: Gmail = Google's own connect for the stand-in,
callback 302s to `/start/connect?back=email`; Amazon and card, below. No Outlook (capabilities say
`outlook:false`). **Uber is OFF the page (owner, 11-10):** `capabilities.uber:false` whatever the server could
do, `POST /api/<id>/connect/uber` is 404 `{ok:false, why:"unavailable"}` with nothing made (the claim still
moves a grant an older stand-in holds; `uberCallbackDone` still returns such a setup to `?back=uber`).
Claim (router, own first text only): code at the end AND the setup's names in the text → account name +
card name set, Google rows moved, the setup's Crossmint state moved (`shop.adoptSetup`: card + store sign-ins
+ `shop_profiles` + the Crossmint user via `shop_crossmint_subjects`, only onto an account with no Crossmint
state, claim ≤15 min `PAY_CLAIM_MS`; later → dropped: profile erased at Crossmint best effort). Then
`onboarding.handle` (not_started) sends `WEB_HELLO`, the card (`WEB_CARD`), and — with `REASON_INTRO_AMAZON=on`,
`amazon.available` (not blocked, not the operator) and Amazon NOT connected on the page (`amazonCanOffer` reads
`shop.isConnected(id, "amazon")`, per connection) — the same `amazon.OFFER` the text intro makes, state
`awaiting_amazon` (`webHandoff`, AMAZON HOOK); their yes → `LINK_LINE` + the `/s/` link + `TRY_LINE`, no →
`NO_LINE. TRY_LINE` (the existing awaiting_amazon branch). Flag off, or Amazon connected on the page →
`TRY_LINE`, complete (a Crossmint sign-in is for buying: no order-read follow-up timer; only an older setup's
Reason-browser Amazon check sets one). No model read of the first text, no name / call-me question (nothing
the page answered is asked on the phone). No/bad code or switch off → the normal intro. Event/invite joiners
never claim. Proof: `test/websetup.test.js`.
**Amazon on the setup = the Crossmint store sign-in (owner, 11-10), never Reason's own browser.**
`capabilities.amazon` = the card's gate (`REASON_SHOP_CONNECT=on` + both Crossmint keys). `POST
/api/<id>/connect/amazon` → `shop.setupStoreLink(c, "amazon")`: Crossmint only signs in to a store inside a
checkout run, so it starts one whose whole task is the sign-in (`SETUP_SIGNIN_TASK`: no search, no cart, no
buy; `maxCost` $1.00 enforced by Crossmint; `signIn: true` → mode `sign_in`) under the stand-in's own browser
profile (`ensureProfile`), makes a `shop_links` row kind `signin` for it and returns
`heyreason.com/web/connect/<token>` — keyed by the token alone, so it opens on any browser: no setup cookie, no
texted code, no code gate. Past 14 min → `{ok:false, why:"too_late"}` (it would not move to them anyway). The
run is followed like any other (`shop.step` / `follow`), but for a `websetup:` conversation nothing is texted
and nothing is woken: a plain question (address, size) or a payment request ends the run quietly
(`endQuietly`; a payment means the store let them in → `finishSignin` first). Page states (`webconnect.js`,
`setupBack` → `<origin>/start/connect?back=amazon`): "Opening Amazon." (checking, before the login is asked) →
"Sign in to Amazon." (email plain, password = Crossmint's sealed field, JWT `setupJwtSec`) → "You're signed in
to Amazon. Back to your setup." (auto-return 1.5 s) or "That didn't go through / This link has run out" with
"Back to your setup" (never "text me"). `connectState("amazon")`: `shop.isConnected` → connected 3/3;
`shop.setupStorePending` (open link + live run) with Crossmint answering within `STALE_CONNECT_MS` (2 min) →
connecting (step 2 once the login was asked for); else pending/failed → `failed` (try again; a new tap lets the
old run go and spends its link). Card = `shop.setupCardLink` → the same `/web/connect/<token>` (Crossmint's own
fields; JWT ≤10 min and never past created+15 min; no card link after 14 min → `too_late`); saved page shows
"Back to your setup". Proof: `test/websetup-uber-card.test.js` (scripted Crossmint). **Unproven live:** a real
Crossmint sign-in-only run at Amazon ending `succeeded` (the agent may end it otherwise), and what such a run
costs at Crossmint.
**No dead-end code gate for a setup (11-10):** a setup's Google/Uber start link (`connectgate.connectStartRequest`)
or an older Amazon `/s/` link (`signin-remote.remoteRequest`) opened on a browser without the setup's cookie —
another browser, a staging site whose host-only cookie cannot reach app.heyreason.com, or a setup that ran
out — never shows "Enter the code Reason texted you" (there is no thread): paper page
`setupsignin.setupBackPage`, one line + "Back to your setup" → `<setup origin>/start/connect?back=<which>`
(`websetup.backUrlFor`; plain `/start/connect` when the setup is gone), nothing texted, nothing started. The
setup's own browser passes straight through (302 to Google / the sign-in intro). Thread links keep their code
gate. Live check on heyreason.com itself: curl `/connect/start?state=…` with the `rs_setup` cookie → 302 to
Google; without it → 200 back page, no code.
**Never stuck on "connecting" (11-10):** `websetup.connectState` reads a pending email/uber connect as
`connecting` only while an unused `oauth_states` row for the stand-in is younger than `STALE_CONNECT_MS`
(2 min), else `failed` (try again); Amazon as above. A new tap always starts fresh (`google.authorizeUrl` /
`uber.authorizeUrl` clear the old state; a new Amazon tap ends the old run). Card: unchanged (its own link TTL).
Staging gotcha: a setup made on start--…netlify.app has a host-only cookie, so its Gmail start link on
app.heyreason.com shows the back page (by design); Amazon and the card work there (token-keyed).
