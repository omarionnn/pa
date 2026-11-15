# The free trial and the subscription (src/plan.js, src/stripe.js — REASON_PAYWALL)

**What live runs now (switches 2026-11-14):** `REASON_PAYWALL=on` and `REASON_FREE_TIER` set (the
monthly tier, `src/plan.js:31`). So a walk-in gets **20 conversations + 2 calls of up to 5 minutes a
month**, not the 25/30 trial described next (that trial only runs with `REASON_FREE_TIER` unset; see
"The monthly free tier" below). Free for good: accounts from before the flip, the operator, test numbers,
and somebody whose number first came in through an invite (or a pre-`REASON_EVENT_PAYWALL_TS` event) from
a member who is free for good themselves (`grandfathered` → `viaFree`, `src/plan.js:205-232`). An invite
from somebody on the free tier or paying makes nobody free, and people on the free tier get no invite
tools at all (`invitesOpenFor`, `src/tools.js:697`). `REASON_INVITES_OPEN` is unset on live, so invites
are otherwise the operator's plus whoever was turned on one by one (`scripts/grant-invites.js`).

Shipped 2026-10-31 (PR #323). **ON on live since 2026-11-07 23:37 UTC (`REASON_PAYWALL=on`, owner's
go; `paywall_on_since` = 1794094636519 = the flip is the cut-off).** In one line, what a person gets:
everybody who had an account before the flip (14 on live), anybody who joined through an invite or (before
REASON_EVENT_PAYWALL_TS, see the last section) a member's event, the operator and test numbers = free forever, never counted toward an ask; anybody new
= 25 free sessions, asked at the 25th only with a win on the record, otherwise the trial runs on to the
30th (`trial 25/30 (no win yet)` on /ops), then the pay link (a Stripe Checkout Session, success →
`/pay/done` "You're all set", cancel → `/pay/back` "No charge"). (2026-11-05 to 11-07 the switch was
OFF — Reason free for everyone.) Off = nothing counted (no `plan` row), nothing said, no plan tool or price in the model's tools /
capabilities / note, `/pay/done` + `/pay/back` 302 to the site home, Stripe's webhook acts on nothing. With it on, a Stripe event for
somebody the paywall does not reach (everyone but the operator under `owner`) or somebody grandfathered
changes nothing and texts nothing (e875fbb) — an old test subscription cannot lapse or hold them.
`owner` reaches only the operator's own thread (their grandfather rules skipped there, so they can try it);
`on` reaches everybody who is not grandfathered — the operator, `REASON_TEST_NUMBERS`, anybody who joined
through an invite or a member's event (`accounts.invited_by` / `joined_via_event` on the number's first
account; owner 2026-11-05, whenever they joined), and every account with `created_at` before the FLIP MOMENT (`ops_state` key `paywall_on_since`, written the first time a
process boots with the switch on) — or any account on the same number made before it, so a pre-flip
person whose number shows up on a new channel after the flip stays free (b996019). `REASON_PAYWALL_SHIP_TS` can only move that cut-off later, so the old
Oct 31 value in live .env cannot put anybody who joined while free on a trial. The website's matching
switch is `REASON_PRICING` (reason-site `tools/build-site.mjs`); flip both together.

What a person sees:

- **A session** is a stretch of chat: an inbound 30 minutes or more after the last one starts a new one
  (`plan.noteTurn`, called from `accounts.countUse` on the turn path, so a burst is one visit).
- **At the 25th session** their reply still answers; then three bubbles once, ever (`plan.afterTurn`,
  from `Router.drain` after the turn): what Reason really did for them (from `stamps.completions()` plus
  fired reminders and events, zeros left out), the ask ($24.99 a month, keeps everything, cancel by
  text), the pay link alone on the last line. No bubbles without a link: with no Stripe configured the
  ask stays owed (`ask_due`) and is tried on the next turn.
- **The win rule (2026-11-01, the pricing page's words: "pay once it's done something real for you").**
  The 25th asks only if Reason has a win for them — any finished errand on the record
  (`plan.hasWin` → `stamps.completions`: a done task, a call that got somewhere, an order placed; a
  fired reminder is not one). No win: nothing is said, the trial runs on a session at a time up to the
  30th (`TRIAL_MAX_SESSIONS`, `REASON_PAYWALL_MAX_SESSIONS`), and `noteTurn` checks on EVERY inbound, so
  the bubbles go on the first text after a win lands (same session or not), counting the chats it took
  ("that's 27 chats between us"). The 30th asks whatever the record says, with a softer first line
  ("i haven't pulled off something real for you yet, and i'd like the chance to."). While extended:
  `status().extended`, `/ops` tag `trial 27/30 (no win yet)`, `subscription_show` says 30 and the
  sessions left, and the turn's PLAN note says nothing has been said about paying and nothing should be.
  Grandfather, `owner` mode and lapsing are untouched.
- **The ask always comes before a lapse.** A session at or past the 25th with the ask never sent owes it
  (this is how somebody whose sessions were counted while the switch was off is treated: asked on their
  first session under the paywall, not cut off), and only a NEW session after the ask has gone lapses
  them. No link to pay with (Stripe not configured) → the ask stays owed → nobody lapses.
- **Lapsed** (the session after the ask, unpaid): questions are answered; anything that acts is refused at the tool
  (`tools.lapsedBlocked` → `plan.gate`): the first refusal in a session carries the one line and the
  link for the model to say, later ones only "can't do that part". Their standing things are held
  (`pause.pauseAll`, recorded in `plan.held_at`; a pause they asked for themselves is left alone), timers
  wait unfired (`Runtime._fireTimer`), nothing proactive goes (`Runtime.mayInterrupt`).
- **Paid**: Stripe's webhook (`POST /stripe/webhook`) → status paid, everything released
  (`pause.resumeAll`), one "you're all set" line through `runtime.say`. `subscription_show` says where they
  stand; `subscription_cancel` cancels at the period's end through Stripe and says the date access ends.

- **Who a payment is for (security, 2026-11-07).** The webhook binds an event to a person by
  `client_reference_id` only when the server issued it: `plan.refFor` = base64url(conversation id) +
  a 22-character HMAC under `REASON_TOKEN_KEY`, read back by `plan.conversationOfRef` (null for anything
  unsigned or bent; logged `stripe_ref_unsigned`). This matters in Payment Link mode
  (`STRIPE_PAYMENT_LINK_URL` set), where whoever opens the link types the reference: a plain encoding of
  somebody's number no longer binds a payer's subscription to them. Checkout Sessions also carry
  server-set `metadata.conversation_id`, so an old unsigned session still matches by that. A second
  `checkout.session.completed` while already `paid` on a live subscription keeps the ids on record
  (`stripe_second_subscription` logged). Rotating `REASON_TOKEN_KEY` voids outstanding Payment Link refs.
- **One number, one plan (security, 2026-11-08).** The trial, the ask, lapsed, paid and the hold are the
  phone number's, not the texting line's: `plan.planId` routes every plan read and write to the oldest
  `plan` row on any account with that address, so a second line (Linq next to Sendblue) carries on the
  same count and a lapsed number stays lapsed there; `hold`/`release` pause and resume every line of the
  number (release only the lines paused at or after `held_at`). Invite / event free-for-good counts only
  when the flagged account is the number's EARLIEST account, so a walk-in who redeems an invite or joins
  an event from another line stays on the trial (the redeem itself still goes through — product question).

## Drive — in process, fake Stripe, no model, no phone, no sound

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
REASON_DB_PATH=$(mktemp -d)/paywall.db node bin/paywall-drive.mjs    # 26 "ok" lines, then "all ok"
```

The drive prints 26 step lines (13 for Ama, 6 for Kofi, 3 for Efua, 1 for the operator, 2 for Akua in
Payment Link mode: a forged reference binds nothing, the issued one pays her up — sec/r2-paylink-ref-signed;
1 for Yaa on two lines of one number — sec/r2-paywall-per-number; 2026-11-08) — the "24" below was a miscount. Evidence 2026-11-07
(rel/verify-maint): 23 ok + "all ok"; `test/paywall-win.test.js` 11, `test/paywall.test.js` 23,
`test/pricing-flag.test.js` 7, all pass; cage `GET /pay/done` → 302 `https://heyreason.com/`.

Evidence 2026-11-06 (`c6ce172`): `paywall-drive.mjs` all ok; `test/paywall*.test.js` +
`test/pricing-flag.test.js` green; `GET /pay/done` → 302 `https://heyreason.com/` on the cage and on live
(`REASON_PAYWALL=off` in live `.env`).

Evidence 2026-11-01 (worktree wt/win-rule): 24/24 ok — the 14 above (Ama now has a win on the record),
then Kofi: no win at the 25th → nothing said, `trial 25/30 (no win yet)`, the quiet PLAN note, the 27th
still quiet, a win → the next text in the same session gets the three bubbles ("that's 27 chats"), the
session after lapses; Efua: 29 quiet, the 30th asked with the softer line, the 31st lapses; the operator
30 sessions under `on` never asked, never extended.

Evidence 2026-10-31 (worktree wt/paywall, 3b527ff): 14/14 ok — 24 quiet sessions, the 25th's three
bubbles with the Checkout Session link last, asked once only, the 26th lapsed and held, `timer_set`
refused with the line + link then `research` refused without a repeat, `subscription_show` answering,
a wrong-signature webhook 401 with nothing changed, the signed `checkout.session.completed` paying them
up (released, one line), the redelivery a duplicate, `timer_set` working again, `subscription_cancel`
asking Stripe for `cancel_at_period_end=true` and saying the date, the `/ops` tag `cancelled · until …`.

## Offline

`test/paywall-per-number.test.js` (6, 2026-11-08; 5 fail on fa3f487): a second line carries the count and the lapse, paid and the hold reach every line, an invite or event join from a second line is not free, an invitee's later line still is. `test/paywall-win.test.js` (11 since 0410db9/a93431a, which added a store-checkout order as a win and a
past-the-30th backlog label; 8 of the first 9 fail on c67e5c9): what a win is, win → asked at 25, no win → runs on
(label, note, view, 26th and 27th quiet), win at 27 → asked on the next text and the 28th lapses, no win
→ asked at 30 with the softer line and the 31st lapses, a 40-session backlog asked at once, grandfather
untouched at 30 and 31, `owner` mode follows the rule on the operator's thread only, `plan-set.js --last-inbound
none` + `win` in its output. `test/paywall.test.js` (25 since 2026-11-08: + a forged Payment Link reference binds nobody, a second checkout keeps live ids; everyone who reaches the ask has one done task): the 29-vs-31-minute gap, the 25th trigger exactly once (unit, and down the
real Router with a FakeChannel: the 25th turn ran before the three bubbles), grandfather (operator, test
number, pre-ship account), `owner` and `off` modes, the ship-time rule, lapsed gating (which tools, once
a session), hold/release including a pause of their own left alone, webhook reject (missing / wrong /
stale / tampered) and accept (two `v1`s during a secret roll), idempotency, paid resume + one text,
`subscription.updated` with `cancel_at_period_end`, `subscription.deleted`, cancel by text, the
payment-link override, no-Stripe hold, `scripts/plan-set.js`.

## Live, read-only

- `grep -E '^REASON_PAYWALL=' /opt/reason/.env` → `REASON_PAYWALL=on` (one line; `.env.bak-paywallon-20261107-233644`
  is the copy from before the flip). Never edit .env during a verify pass.
- The cut-off: `sqlite3 -readonly data/reason.db "SELECT v FROM ops_state WHERE k='paywall_on_since'"`
  (the table is `ops_state(k, v)`, not key/value) → 1794094636519. Who is free forever by it:
  `SELECT count(*) FROM accounts WHERE created_at < <that>` (14 on 11-07); invite / event joiners:
  `accounts.invited_by` / `joined_via_event` non-empty.
- `SELECT status, sessions_used, ask_due, asked_at IS NOT NULL FROM plan` — rows appear as people text
  (a `free` row is written on the first grandfather read). The `status` column is not the answer for a
  grandfathered person still showing `trial`; `plan.status()` reads the account too.
- `curl -s <base>/pay/done` → 200, a branded "You're all set" page (`/pay/back` → "No charge"); while
  the switch is off both 302 to `https://heyreason.com/`.
- `/ops` shows a plan tag per person (e.g. `trial 25/30 (no win yet)`) only when `REASON_PAYWALL` is not off.
- Journal lines: `paywall_asked`, `paywall_refused`, `paywall_held`, `paywall_released`, `stripe_ref_unsigned`, `stripe_second_subscription`,
  `stripe_webhook`, `stripe_webhook_rejected`, `paywall_no_link`, `paywall_checkout_failed`.

## What turning it on needs (Omari)

Stripe test mode: a recurring $24.99/month price (`STRIPE_PRICE_ID`), a secret key
(`STRIPE_SECRET_KEY`), a webhook endpoint at `https://<REASON_PUBLIC_URL>/stripe/webhook` for
`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`,
`customer.subscription.deleted` (`STRIPE_WEBHOOK_SECRET`); optionally `STRIPE_PAYMENT_LINK_URL` for the
pricing page. Then `REASON_PAYWALL=owner`, a restart, and 25 of their own sessions (or
`scripts/plan-set.js dm:owner trial --sessions 24 --last-inbound none --apply`, so their very next text is
the 25th; the output's `win` says whether the bubbles go then or the trial runs on) to see the bubbles for real.

## The monthly free tier (REASON_FREE_TIER=monthly; #423 merged 2026-11-10, live with the flag from 2026-11-10)

Replaces the 25 / 30-without-a-win trial when `REASON_FREE_TIER=monthly` (unset = the old trial, untouched).
Walk-ins get 20 conversations (the 30-minute session) + 2 calls of up to 5 minutes a month, from the day
they first texted (`plan.period_start/period_sessions/period_calls`, added in place). The 21st conversation's
first text: no model turn, the owner-approved 3 bubbles (11-09, `plan.overTextBubbles`): (1) "that's 20
conversations between us this month, <Name>. so far i've <recapLine wins>." — or, no wins, "that's 20
conversations between us, <Name>. i haven't pulled off something real for you yet, and i'd like the chance
to." (2) "the free ones come back <Dec 9>. or it's $24.99 a month …" (reset date BEFORE the price) (3) the link
alone (router `#drainHeld` → `plan.answerOverCeiling`); the rest of that conversation silent. Never
"unlock"/"upgrade"/"trial". A call in over the 20 or past 2 calls: one `<Say>` ("hey <Name>, it's Reason.
that's both free calls this month, so i can't stay on. i'm texting you the link right now. talk soon.") +
`<Hangup/>`, then one text ("here's that link. so far i've <wins>. $24.99 a month … otherwise your 2 calls come
back <Dec 9>.") + the link, once a day (`plan.call_link_day`). A call to them on the free tier: wrap-up cue at 4:30, closed at 5:00 (`free_call_limit`); errand calls to businesses are not cut.
`call_place` past 2 calls is refused before the confirm gate. Trial users get no invites (`invitesOpenFor`),
and an invite / event from anybody not free for good makes nobody free. Auto-admit: `REASON_SIGNUPS_PER_HOUR`
(default 25) walk-in accounts a rolling hour; the next gets the access-list text (`REASON_ACCESS_LIST_URL`,
default https://heyreason.com/access) and the approval queue — see [access-list.md](access-list.md). A tool
refused over the 20 tells the model the reset date before the price, and the second ask in a conversation
is only "can't do that part right now".
Prove: `node --test test/free-tier-monthly.test.js` (16) + `bin/free-tier-drive.mjs` (muted, real router +
inbound TwiML, prints the texts; 7 ok + all ok on 11-09 and again 2026-11-14 on `7d5b5f54`: 20
conversations answered, the 21st gets the 3 bubbles with no model turn, a 2nd text there gets nothing,
the 3rd call gets one line + hang-up + the link texted, 4:30 wrap-up / 5:00 close, a free-tier user is
offered no invites, 25 admitted and the 26th queued with the access-list text).
Invites: `node --test test/invites.test.js` (19, in the 2026-11-14 paywall run, all pass);
`test/paywall.test.js` "flip on: invited after the flip → free; joined via a member's event after the flip →
free; uninvited after the flip → trial".

2026-11-14 (`7d5b5f54`): `bin/paywall-drive.mjs` all ok (the 25/30 trial path, fake Stripe); the paywall
suites 130/131 with `test/paywall.test.js` "the cut-off is the flip moment" failing once and 25/25 on a
rerun of that file: flaky (clock-bound), not a product bug.

## Event joiners pay like walk-ins (REASON_EVENT_PAYWALL_TS; pa #491, owner 2026-11-11)

An account that came in through an EVENT (`joined_via_event`, no `invited_by`) and was created at or after
`REASON_EVENT_PAYWALL_TS` (ms; `plan.eventPaywallTs`) is NOT free for good — monthly free tier like a walk-in,
nothing said up front. Before the cut-off: still free for good. Invites untouched. Unset = old rule. The
event's own lines never count and are never held by the ceiling: join-code text (no turn), welcome, join
line, host messages/reminders (`events.deliver` → `_tell`, no paywall check), the morning-after `event:after`
timer (exempt from `plan.blocked` in `_fireTimer` and `mayInterrupt(c, { paywall: false })`). ONE reply to
each Reason onboarding line ("how was X?", the call offer) is uncounted and skips the over-ceiling line
(`eventonb.claimFreeReply`, one-shot ops key `eventonb:free:<conv>:<state>:<at>`). Their own asks count.
Prove: `node --test test/event-paywall.test.js` (8). Live read-only: `grep REASON_EVENT_PAYWALL_TS .env`;
`SELECT conversation_id, created_at FROM accounts WHERE joined_via_event IS NOT NULL AND invited_by IS NULL
AND created_at >= <ts>` = the people now on the free tier through an event.

### Two follow-ups (owner 2026-11-11, same day)

1. **Event business is free.** A guest over the month's 20 who texts about the event itself ("can't make it",
   an RSVP change, leaving, muting, an answer to the host's question, a reply to the host's message) gets a
   normal turn: not counted, never the pay line. Only a real ask of Reason counts. `src/eventbusiness.js`
   `free()` is asked by the router before the count, and only when it can matter (`plan.overNext` + a guest at
   an event that started under 3 days ago; a host is not a guest). It is a side read by meaning (haiku,
   12 s, `REASON_EVENT_BUSINESS_TIMEOUT_MS`); with no read, only a text inside a day of the event's own last
   message to them passes. In that turn `plan.waive` lets a guest's event tools (`eventbusiness.GUEST_TOOLS`)
   past the lapsed gate; everything else that acts is still refused. Log: `{event_business, free, how}`.
2. **The surprise call is on Reason.** Anything but a plain no to the call offer sets one call aside
   (`plan.giftCall`, 2 days like the offer). `call_place` goes ahead with the 2 calls used and with the
   conversations over, and spends it (`plan.useGiftCall`) instead of `plan.noteCall`, so the month's 2 are
   untouched. A guest over the ceiling gets up to 3 uncounted texts to say who and what for
   (`eventonb.claimCallSetup`). The 5-minute cap on a free-tier call still applies.

Prove: `node --test test/event-paywall-tweaks.test.js` (14).
