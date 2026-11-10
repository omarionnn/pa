# First-chat onboarding — `REASON_ONBOARDING` on (default) | test | off

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
- Never on live until deployed; `REASON_ONBOARDING=off` in `.env` turns it off.

## Names get a capital on each word (#426, 2026-11-10)

`nameCase` (`src/contact.js:62`) upper-cases the first letter of each word (after a space or a hyphen) and
changes nothing else: "kwame mensah" → "Kwame Mensah", "anne-marie" → "Anne-Marie"; "KWAME" stays "KWAME",
"mcKenzie" stays as typed. Used by the greeting (`MET`, `src/onboarding.js`), the card name (`cardName`) and its line.
Prove: `node --test test/onboarding.test.js` + `bin/onboarding-checks.cjs`.

## Web setup hand-off — `REASON_WEB_SETUP` on | off (default off)

heyreason.com/start (site repo, `public/start/`) asks name → Reason's name → Amazon/Gmail connect, then
opens Messages with `hey <reason name>, it's <name> · <code>` typed (`websetup.firstText`, lowercase,
4-char code from `abcdefghjkmnpqrstuvwxyz23456789`). Server: `src/websetup.js` (+ rows in
`src/websetupstore.js`), JSON under `/setup/api/*` via the site's signed `/setup/*` proxy; `rs_setup`
cookie (HttpOnly, 24 h) owns the setup and is accepted by `connectgate.browserConversation` for the
stand-in conversation `websetup:<id>` only. Connects: Amazon = `amazonconnect.setupConnectLink` (remote
sign-in for the stand-in; its end lands on the setup via `onEnd`, never a timer); Gmail = Google's own
connect for the stand-in, callback 302s to `/start/connect?back=email`. No Outlook (capabilities say
`outlook:false`).
Claim (router, own first text only): code at the end AND the setup's names in the text → account name +
card name set, Google rows + Amazon check + browser profile moved, Amazon follow-up timer at +90 s. Then
`onboarding.handle` (not_started) sends `WEB_HELLO`, the card (`WEB_CARD`), `TRY_LINE`; no model read, no
name / call-me question, no Amazon offer (`amazonCanOffer` false via `handledOnWeb`). No/bad code or switch
off → the normal intro. Event/invite joiners never claim. Proof: `test/websetup.test.js`.

**Uber + Card (PR #440, 11-10).** Screen 3 order: Amazon, Uber, Email, Card. Uber = `uber.authorizeUrl`
for the stand-in, handed out only when `uber.connectReady()` (reads Uber's own authorize 302: `/oauth/errors`
= `redirect_uri_not_registered`; cached 10 min, unreachable 30 s) says ready, else `{ok:false, why:"not_ready"}`
and `capabilities.uber:false`; Uber's callback for a setup 302s to `/start/connect?back=uber`
(`websetup.uberCallbackDone`). Card = `shop.setupCardLink` → `heyreason.com/web/connect/<token>` (Crossmint's
own fields; JWT `setupJwtSec` ≤10 min and never past created+15 min; no card link after 14 min → `too_late`);
nothing texted to the stand-in; saved page shows "Back to your setup". Claim ≤15 min (`PAY_CLAIM_MS`):
Uber token + `connected_accounts` uber + card move; the card keeps its Crossmint user via
`shop_crossmint_subjects` (only onto an account with no Crossmint state). Later claims / sweep drop them
(Crossmint DELETE best effort). Live 11-10: Uber `not_ready` until https://app.heyreason.com/uber/callback is
added in the Uber dashboard. Check: `curl -s https://start--textreason.netlify.app/setup/api/capabilities`.
Proof: `test/websetup-uber-card.test.js`.
