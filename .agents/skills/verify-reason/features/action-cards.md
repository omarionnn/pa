# Action Cards (src/actioncards.js page + src/actionengine.js engine) — REASON_ACTION_CARDS off | owner | on

Once a day, at 7:30 in the person's zone, a short note in the thread with a link to a page of one-tap
offers ("Accept Dana's dinner invite for Friday"); a tap opens Messages with the request in
their own voice; their text matches the open card by its words and runs as the normal turn. Live since
2026-11-11 for the owner only (flag `owner`); the engine shipped the same day (PR action-cards-engine).

**A card is an offer to do the whole job (2026-11-12, #526).** The model names, per entry, the job and
the route (`calendar | email | pay | call | site | none`); `src/cardroutes.js` `checkRoute` decides in
code whether that route is open for this person right now (the grant, the card on file and a store the
checkout has reached a total at, the number written in the candidate and the calling hours, a saved
session the site confirms now) and the card is dropped when it is not. A mail is a candidate only when
Gmail's own `Authentication-Results` passes for its From address (`senderCheck`). An authenticated account
notice Reason cannot finish is at most one of two "also worth knowing" lines, said once. A tapped card's
end is read by code (`readOutcome`: the ledger, the payment, the call): done, pending, lapsed or failed;
no sign-in link is ever sent for a card (`HANDOFF_TOOLS`).

## Offline
- `node --test test/action-cards.test.js test/action-cards-rest.test.js` — the page: switch, token, dismiss,
  done sinks, reply match, picture, sealed columns.
- `node --test test/action-cards-engine.test.js` — the engine: the spec's 20-item eval on a fake Google
  (prints `eval: N/20`; the bar is ≥ 18 with zero false cards from the skip set), Stage 2 re-validation,
  dedupe/rank, the morning run end to end (digest, sealed sources, day row with cost, the approved copy,
  counted `proactive` never `turn`, no cards → no text), the 7:30–9:30 scheduler (once a day; a missed morning is caught up once until noon
  their time, a restart never skips it; a run the model or a mailbox did not answer is retried 10 min apart,
  3 tries; account notices from no-reply senders reach the model while uptime checks, job alerts, promos and
  codes do not; lane parked
  past noon → `lane_unavailable`, never on the API), the urgent single (calendar thing inside 2 h, outside
  quiet hours, ≤ 2 texts/day), the two tools, settleHandled on page open, the sweep limited to
  time-critical calendar things when cards are on.
- `node --test test/action-cards-finish.test.js` — the gate: the sender check case by case and a spoofed
  notice that never reaches the model; each route with and without what it needs; worth knowing (cap of
  two, said once, one line on the page, a line the cap kept back stays sayable); nothing to say sends
  nothing; a failed tap (one text, the sign-in link refused in the turn and for the job that wakes up
  later, allowed again once they ask for one themselves); done only on proof, pending while their yes is out.
- Contract tests that know about it: test/rules-everywhere.test.js (`stage2` is a rule reader),
  test/data-coverage.test.js (`action_card_days`, `action_card_sources`, `card_skip_rules` in the delete
  scope), test/db-scope-ratchet.test.js (the one install-wide COUNT in `opsLine` is on the baseline).

## Live (read-only)
- `ssh root@15.204.113.250 'cd /opt/reason && sudo -u reason node --env-file-if-exists=.env scripts/action-cards-run.js --account=dm:owner --dry'`
  — gathers, filters and asks the model ONCE for real, writes and sends nothing; prints counts and the titles
  that would be carded (never a subject, an address or a body). The only safe way to see the engine's output
  for a real account outside the 7:30 run.
  It also prints each card's route and job, what the gate dropped by reason word, and the lines worth knowing.
- /ops → "Action Cards" row: last 24 h runs, with cards / with none (how many of those a line worth
  knowing) / skipped, texts, API-equivalent $.
- `action_card_days` on the server: one row per person per day (outcome `cards | known | empty | skipped |
  urgent`, `why` `lane_unavailable | late | cli_unavailable | known_unsent:… | …`, counts, tokens, cost;
  `dropped` carries the gate's reasons as `route:<word>`). Never a title.
- `action_card_sources`: per card `route`, `route_target` (a blind index), `outcome`
  (`'' | running | pending | done | failed | lapsed`), `outcome_why`, `tapped_at`, `handback_ok_at`.
- Journal lines `{"action_cards":"<conv>", ...}` carry counts and outcomes only.

## What the cage cannot prove
- The morning text leaving (any outbound send: verified-UNREACHABLE on the cage).
- The real 7:30 run on the owner's own mail: first real one is the morning after deploy; check the day row,
  the outbox row with idempotency key `cards:<conv>:<day>:morning`, and that `usage.turns` did not move.

## Rules of the feature (what a drive should assert)
- Never `countUse(c, "turn")` from the engine; `proactive` once per text sent.
- ≤ 2 texts/day from the engine (`texts_sent + urgent_sent`), inside `notice.budgetFor` and `mayInterrupt`.
- No card without a route code has checked; "remind me", "draft it", "take me there", "here is a link"
  are never cards. No candidate from a mail that fails the sender check.
- No finishable card and nothing worth knowing: no text, no page row beyond `outcome=empty`. No card but a
  line worth knowing: ONE text that names it and offers nothing, no link (`outcome=known`).
- A card is `done` only on its route's proof; a failed tap is said once and never followed by a sign-in link.
- Title ≤ 12 words, verb first; prefill first person; why_now never names a sender, subject or source.
- The two tools (`action_card_source`, `action_card_forget`) are absent from `toolsFor` when the flag does not reach the person.
