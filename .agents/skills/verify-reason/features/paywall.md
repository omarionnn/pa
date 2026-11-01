# The free trial and the subscription (src/plan.js, src/stripe.js — REASON_PAYWALL)

Shipped 2026-10-31 (PR #323) with the switch OFF on live: sessions are counted into a new `plan` table
and nothing else happens. `owner` reaches only the operator's own thread (his grandfather rules skipped
there, so he can try it); `on` reaches everybody who is not grandfathered — the operator,
`REASON_TEST_NUMBERS`, and every account with `created_at` before `REASON_PAYWALL_SHIP_TS` (unset: the
moment the flag was first seen on, written once to `ops_state` key `paywall_ship_ts`).

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

## Drive — in process, fake Stripe, no model, no phone, no sound

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
REASON_DB_PATH=$(mktemp -d)/paywall.db node bin/paywall-drive.mjs    # 24 steps, "all ok"
```

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

`test/paywall-win.test.js` (9; 8 fail on c67e5c9): what a win is, win → asked at 25, no win → runs on
(label, note, view, 26th and 27th quiet), win at 27 → asked on the next text and the 28th lapses, no win
→ asked at 30 with the softer line and the 31st lapses, a 40-session backlog asked at once, grandfather
untouched at 30 and 31, `owner` mode follows the rule on his thread only, `plan-set.js --last-inbound
none` + `win` in its output. `test/paywall.test.js` (23; everyone who reaches the ask has one done task): the 29-vs-31-minute gap, the 25th trigger exactly once (unit, and down the
real Router with a FakeChannel: the 25th turn ran before the three bubbles), grandfather (operator, test
number, pre-ship account), `owner` and `off` modes, the ship-time rule, lapsed gating (which tools, once
a session), hold/release including a pause of their own left alone, webhook reject (missing / wrong /
stale / tampered) and accept (two `v1`s during a secret roll), idempotency, paid resume + one text,
`subscription.updated` with `cancel_at_period_end`, `subscription.deleted`, cancel by text, the
payment-link override, no-Stripe hold, `scripts/plan-set.js`.

## Live, read-only

- `sqlite3 -readonly /opt/reason/data/reason.db "SELECT conversation_id, sessions_used, status FROM plan"`
  — rows appear as people text, status `trial` for everyone while the switch is off.
- `/ops` shows a plan tag per person only when `REASON_PAYWALL` is not off.
- `grep -c REASON_PAYWALL /opt/reason/.env` → 1 (`REASON_PAYWALL=off`, appended at deploy).
- Journal lines: `paywall_asked`, `paywall_refused`, `paywall_held`, `paywall_released`,
  `stripe_webhook`, `stripe_webhook_rejected`, `paywall_no_link`, `paywall_checkout_failed`.

## What turning it on needs (Omari)

Stripe test mode: a recurring $24.99/month price (`STRIPE_PRICE_ID`), a secret key
(`STRIPE_SECRET_KEY`), a webhook endpoint at `https://<REASON_PUBLIC_URL>/stripe/webhook` for
`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`,
`customer.subscription.deleted` (`STRIPE_WEBHOOK_SECRET`); optionally `STRIPE_PAYMENT_LINK_URL` for the
pricing page. Then `REASON_PAYWALL=owner`, a restart, and 25 of his own sessions (or
`scripts/plan-set.js dm:owner trial --sessions 24 --last-inbound none --apply`, so his very next text is
the 25th; the output's `win` says whether the bubbles go then or the trial runs on) to see the bubbles for real.
