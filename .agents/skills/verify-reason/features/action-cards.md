# Action Cards (src/actioncards.js page + src/actionengine.js engine) — REASON_ACTION_CARDS off | owner | on

Once a day, at 7:30 in the person's zone, a short note in the thread with a link to a page of one-tap
offers ("Replace your Anthropic key before it expires Nov 18"); a tap opens Messages with the request in
their own voice; their text matches the open card by its words and runs as the normal turn. Live since
2026-11-11 for the owner only (flag `owner`); the engine shipped the same day (PR action-cards-engine).

## Offline
- `node --test test/action-cards.test.js test/action-cards-rest.test.js` — the page: switch, token, dismiss,
  done sinks, reply match, picture, sealed columns.
- `node --test test/action-cards-engine.test.js` — the engine: the spec's 20-item eval on a fake Google
  (prints `eval: N/20`; the bar is ≥ 18 with zero false cards from the skip set), Stage 2 re-validation,
  dedupe/rank, the morning run end to end (digest, sealed sources, day row with cost, the approved copy,
  counted `proactive` never `turn`, no cards → no text), the 7:30–9:30 scheduler (once a day, lane parked
  past 9:30 → `lane_unavailable`, never on the API), the urgent single (calendar thing inside 2 h, outside
  quiet hours, ≤ 2 texts/day), the two tools, settleHandled on page open, the sweep limited to
  time-critical calendar things when cards are on.
- Contract tests that know about it: test/rules-everywhere.test.js (`stage2` is a rule reader),
  test/data-coverage.test.js (`action_card_days`, `action_card_sources`, `card_skip_rules` in the delete
  scope), test/db-scope-ratchet.test.js (the one install-wide COUNT in `opsLine` is on the baseline).

## Live (read-only)
- `ssh root@15.204.113.250 'cd /opt/reason && sudo -u reason node --env-file-if-exists=.env scripts/action-cards-run.js --account=dm:owner --dry'`
  — gathers, filters and asks the model ONCE for real, writes and sends nothing; prints counts and the titles
  that would be carded (never a subject, an address or a body). The only safe way to see the engine's output
  for a real account outside the 7:30 run.
- /ops → "Action Cards" row: last 24 h runs, with cards / empty / skipped, texts, API-equivalent $.
- `action_card_days` on the server: one row per person per day (outcome `cards | empty | skipped | urgent`,
  `why` `lane_unavailable | late | cli_unavailable | …`, counts, tokens, cost). Never a title.
- Journal lines `{"action_cards":"<conv>", ...}` carry counts and outcomes only.

## What the cage cannot prove
- The morning text leaving (any outbound send: verified-UNREACHABLE on the cage).
- The real 7:30 run on the owner's own mail: first real one is the morning after deploy; check the day row,
  the outbox row with idempotency key `cards:<conv>:<day>:morning`, and that `usage.turns` did not move.

## Rules of the feature (what a drive should assert)
- Never `countUse(c, "turn")` from the engine; `proactive` once per text sent.
- ≤ 2 texts/day from the engine (`texts_sent + urgent_sent`), inside `notice.budgetFor` and `mayInterrupt`.
- No text when there are no cards; no page row beyond `outcome=empty`.
- Title ≤ 12 words, verb first; prefill first person; why_now never names a sender, subject or source.
- The two tools (`action_card_source`, `action_card_forget`) are absent from `toolsFor` when the flag does not reach the person.
