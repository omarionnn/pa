# Research room — every planned query searched, big questions get more room, one follow-up

Before 2026-10-30 one planned query could spend the whole page budget: run #78 ("which service can
vault each user's card with a passkey per agent purchase", kind `choice`, four queries) read all 8
pages off query 1, the loop broke on `pages`, and Stripe / Skyfire / Payman were never searched.

- Fair share (`src/research.js` `step`): each planned query reads at most
  `max(2, floor(pages left / queries still to run within the search cap))`; the page cap no longer
  stops the planned queries (a query with no page room still logs its snippets); what the shares did
  not reach goes in one pile and the leftover pages are spent on it, best first (`pickSources`, one per
  site). `cut_short: "pages"` only when that pile still had more than the room.
- Room (`capsFor`, `isBig`): big = kind `choice`, or ≥3 planned queries, or ≥3 `options` named
  (new `research.options` input). Big caps 8 searches / 14 pages / 150 s
  (`REASON_RESEARCH_BIG_MAX_*`), small keep 5 / 8 / 90. `research.big` is set once at start.
- One follow-up (`tools.js` `researchFollowUp` / `researchFollowUpDelivered`): a non-deep run cut
  with planned queries left gets a task "research, the rest: …" waking in
  `REASON_RESEARCH_CONTINUE_WAKE_MIN` (2); its result carries `follow_up` + `follow_up_note` (answer
  now, say you're still digging and will text the rest). Claimed on `research.continue_task_id`
  (set once, WHERE-guarded → never chained). The carry-on that reaches it (the wake, or them asking
  first) gets a fresh slice (+5 searches, +8 pages, `REASON_RESEARCH_CONTINUE_*`), closes the run and
  the task, and is told to send ONE text with only what is new (nothing new → one short line that the
  rest did not change the pick). `enough: true` cancels the task.
- One-shot in code (`runtime.js` `runTasks` → `closeFollowUp`, `db.researchForFollowUp`): after its
  wake the follow-up task is closed (cancelled if the turn never carried the run on) and so is the
  run, whatever the turn did — no 15-minute re-wakes, no "gave up" text, no run left open blocking
  new questions with `research_open`. A wake that crashes gets one retry only if nothing was sent,
  then closes quietly. A carry-on whose step fails or throws still closes the task (`failed`) and
  gets a note to send one honest line (could not get to the rest).
- Daily cap: `research.continue_day` on the install day (`trust.spendDay`); 2 per person, owner 5
  (`REASON_RESEARCH_CONTINUE_PER_DAY[_OWNER]`). Past it `follow_up: { scheduled: false, why:
  "daily_limit" }` and the note says answer from what it got and offer to look further.

Source: `src/research.js`, `src/tools.js` (`case "research"`, `researchFollowUp*`,
`researchTaskLive`), `src/db.js` (`big`, `continue_task_id`, `continue_day`,
`claimResearchContinuation`, `researchContinuationsOn`), `src/config.js`.
Tests: `test/research-room.test.js` (11), `test/research.test.js`.

## Drive (in process, subscription — 3 model turns, fake search, nothing texted)

```bash
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/research-room.db REASON_BACKEND=claude-cli \
     node .agents/skills/verify-reason/bin/research-room-drive.mjs
```

2026-10-30, fix/research-room-and-continue: turn 1 (run-#78 question) → kind choice, big, 6 queries
planned and 6 searched, 14 pages; turn 2 (e-bike, search cap forced to 1) → one "research, the rest"
task, 3 left; the wake → same run carried on (4 searches), one text, task done, nothing after. The
pages are fixtures, so the model rightly says the sources are placeholders — the drive proves the
machinery, not answer quality. The model may start a deep task of its own; the drive ignores it.
