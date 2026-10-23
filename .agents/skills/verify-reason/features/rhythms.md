# Rhythms — what Reason has worked out about how you live, kept only once you say yes

After about three weeks of texting, Reason can notice a shape ("you deal with work stuff after nine",
"saturdays are gone"). It asks ONCE, at the first moment the pattern would actually change something,
with the real example in the question. Only after a yes is anything kept. A kept rhythm does one
thing: it moves WHEN a non-urgent nudge lands. It is never stated back as a fact, and it shows on the
memory page as something Reason thinks, with the receipts behind it.

Source: `src/rhythms.js` (`evidenceFor`, `enoughToLookAt`, `check`, `keep`, `expire`, `askFrame`,
`reflectFrame`, `reflectKept`; constants `WINDOW_DAYS` 21, `MIN_POINTS` 3, `MIN_SPAN_DAYS` 14,
`EXPIRE_DAYS` 21), `src/runtime.js` (`async rhythms()`, the daily pass, called from the sweep as
`shapes`; `quietOpts.rhythms` feeds `rhythmMoment`), `src/notice.js` (`rhythmMoment`),
`src/memory.js` (the "what Reason thinks" rows on the memory page), `src/tools.js`
(`patterns_set`, `patterns_ask`, `pattern_note`, `pattern_still`; `grep -n 'case "pattern' src/tools.js`),
`src/db.js` (`listPatterns` — rhythms are `guesses` rows with `how = PATTERN_SOURCE`, evidence JSON;
`pattern_asks` ledger; account setting `patterns` = `on` / `off` / `not_asked`, the default —
`DEFAULT_PATTERNS` in `notice.js`).
Tests: `test/rhythms.test.js` (15 pass), `test/rhythm-timing.test.js` (13 pass),
`test/patterns.test.js` (14 pass). Shipped in PR #10 / `1d85316`.

## Sub-features

- **Evidence is numbers, not messages.** Message times by local hour/weekday, gaps before a reply,
  quiet days; no bodies go to the model.
- **The bar is code, checked after the model speaks.** At least 3 points spanning at least 14 days,
  every point a real row, a non-empty `use`. A one-Tuesday proposal is refused.
- **Consent, three states, asked once.** `patterns` setting `on` / `off` / `not_asked` (a real third
  state, not a soft no: nothing is noticed or kept). A no deletes what was kept; a pending ask is not
  repeated (`pattern_asks`, `patterns_asked_at`).
- **Expiry.** A pattern nothing has borne out for 21 days is deleted rather than left shaping timing.
- **The only effect.** `rhythmMoment` nudges non-urgent notice timing toward evidence hours; urgent
  things and quiet hours are untouched.
- **Visible and correctable.** Memory page lists each pattern with an id; `memory_fix`/`memory_drop`
  work on it. "Why do you think that?" is answerable from the stored evidence.

## How to get to it (user POV)

You never ask for it. After weeks of use Reason says something like "I've noticed you get to the
work stuff after nine — want me to hold non-urgent nudges until then?" A yes keeps it; a no ends it.
"What do you think you know about me?" shows it on the memory page.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/rhythms.test.js test/rhythm-timing.test.js test/patterns.test.js   # 15 + 13 + 14
```

These drive the real `rhythms()` pass in-process with a scripted model, a fake clock and seeded
`event_log`/inbound rows, so the 3-weeks-of-history requirement is met without waiting.

**The cage cannot age itself three weeks**, so the caged proof is the quiet one: the pass runs and
sends nothing for a fresh install.

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
bin/peek.sh sql "SELECT id, how, confirmed_at, substr(evidence,1,80) FROM guesses WHERE how LIKE '%pattern%'"   # empty
bin/peek.sh sql "SELECT * FROM pattern_asks"                                                                      # empty
bin/caged.sh stop
```

**Live, read-only:** `journalctl -u reason --since '48 hours ago' | grep -E '"rhythms"'` shows
`asked`, `expired` and `deleted` lines only — skips (`already today`, `not their night`, …) go into
the pass's return value, and the sweep result is not logged. For "did the pass reach them today",
read `notice_sweeps.last_rhythm_day`. `sqlite3 /opt/reason/data/reason.db
"select conversation_id, id, noted_at from guesses where how like '%pattern%'"`. Don't toggle `patterns`
on a real account to test.
**End state that proves it:** a `guesses` pattern row with ≥3 evidence points, the ask in `outbox`
(`sent`) before it, and `patterns = on` on the account.

## Gotchas

- The pass is once per local day per person (`notice_sweeps.last_rhythm_day`); a second call the
  same day is `skipped: already today`, which is correct, not a bug.
- The pass is gated on the person's night: with `not_asked` it runs only by day ("the question waits
  for their morning"); otherwise only in their night ("not their night"). Re-grep `async rhythms`
  in `runtime.js` for the gate. A daytime run on a consenting account skipping is correct.
- A pattern row lives in `guesses`; anything that lists "guesses" must filter on `how` or it will
  show rhythms as guesses (the memory-page tests pin this).
- Do not state a rhythm to the person as fact; the memory page labels it "I noticed this across a
  few weeks — nobody told me" (the `i_noticed_a_pattern` label in `memory.js`), with the claim as
  `i_think`.
- `rhythm-timing` has historically had clock-sensitive cases (two longtask flakes were pinned
  elsewhere); if one fails in isolation, re-run alone before calling it a regression.
