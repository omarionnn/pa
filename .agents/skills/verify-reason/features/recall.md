# Recall — "what was that place you called?", and "forget about them"

Somebody points back at something Reason did ("the spa place you called", "that link you sent") and
gets the thing itself, not Reason's own earlier "I don't have that saved". And when they say
"forget about Yaw", Yaw stops coming back — not only the facts saved about him, but the calls,
messages, actions and reminders that name him.

What recall indexes (calls, `action_ledger`, one-off timers, thread exchanges; `memory_search`
results + `history`, the word fallback) is in [memory-graph.md](memory-graph.md) (#334). This file is
the 11-06/11-07 release on top of it: PR #354 (ranking, the "nothing saved" filter, `busy_timeout`)
and PR #335's forget commit (`01a4e27`).

Source: `src/recallindex.js` (`saidNothing` `:288`, `rankAndCut` `:308`, `searchHistory` `:328`,
`keywordHistory` `:348`, `notForgotten` `:99`, `snippetFor` `:222`, the `recall_reindex` pass `:137`), `src/db.js` (`forgetPerson`
`:2743`, `forgetFromRecall` `:2886`, tables `recall_forgotten` `:10569` and `recall_reindex` `:10579`, `BUSY_TIMEOUT_MS` `:21`),
`src/tools.js` (`case "forget"` `:10315`, `case "memory_search"` `:10399`), `src/data.js:212,215`
(`recall_forgotten` and `recall_reindex` deleted with the person).
Tests: `test/recall-history.test.js`, `test/db-busy-timeout.test.js` (3) — all pass at `36db733` (release head, branch `rel/unverified-fix`).

## Sub-features

- **Done things rank above what Reason said.** Live 11-06: "spa place" put the real spa call 9th and
  Reason's own "I don't have any spa place saved" first — a thread exchange repeats the words they
  use. Now up to `POOL` (60) candidates are read back, then a call / link / lookup / reminder that
  scores within `ACTION_REACH` (0.3) of the best match goes ahead of every thread exchange, and only
  then is the list cut to `limit`. The word fallback (`keywordHistory`, no embeddings) has no reach:
  any done thing that matched a word ranks first. Duplicates (same snippet text) take one slot.
- **"Nothing saved" replies are never handed back.** A thread match whose LAST Reason line opens with
  one of its fixed "nothing on it" phrasings (`NOTHING_SAID`: "nothing saved", "I don't have … saved",
  "don't remember", "couldn't find anything", "no record of" …) is dropped. Only Reason's side and only
  its first sentence are read; a sentence with a digit or a "but/though/however" carried an answer and
  is kept ("couldn't find anything cheaper than $90"). Their words are never matched.
- **Forget clears recall** (`01a4e27`). `forget { about }` → `forgetPerson` → `forgetFromRecall`
  marks every call (goal/label/summary), action receipt (receipt/target/attempted), reminder (note/label/
  call_goal) and thread line of THIS conversation naming them by whole words in `recall_forgotten`,
  deletes their vectors (an exchange's vector goes if any line in its span is marked, and the rest of that run is queued in `recall_reindex` and indexed again without the forgotten lines), and every
  index query, word search and snippet read skips marked rows — the indexer never re-embeds them.
  The rows themselves stay (their messages are theirs; the ledger is append-only). The result
  carries `recall_cleared: { calls, exchanges, actions, reminders }`. With no fact saved about them
  but recall hits, `ok: true, forgot: 0` and "Gone from recall: N …" — only for a specific subject: with nobody saved, a vague one ("that", "it", "work", "money": the `VAGUE` set, `specificSubject`) clears nothing and answers "… too general to clear from recall on its own — nothing was cleared"; two-letter names ("Jo") and non-Latin names count. With neither, still
  `Nothing is on record about '<name>'.` Sealed: one conversation only. `capabilitiesNow`'s
  "your_data" line says forget reaches recall (`src/tools.js:2509`).
- **`busy_timeout` 5000 ms on every connection** (`src/db.js:24`, `scripts/call-report.js:28`,
  `scripts/web-migrate-dry-run.mjs:47`): `scripts/recall-backfill.mjs` writing beside the server
  failed twice on live 11-06 with "database is locked".

## How to get to it (user POV)

"what was that spa place you called for me?", "the link you sent me yesterday", "forget about Yaw",
then later "what do you remember about Yaw?".

## Driving it with the harness

Offline: `env -i HOME=$HOME PATH=$PATH node --import ./test/paid-key-guard.js --test test/recall-history.test.js test/db-busy-timeout.test.js`.

No model, no network, in process (word search — blank `OPENAI_API_KEY` on purpose; the meaning search
uses the same `rankAndCut`). It also drives the figures gate ([shopping.md](shopping.md)), the receipts
wording ([confirm-gate.md](confirm-gate.md)) and own-files-only ([security-boundaries.md](security-boundaries.md)):

```bash
cd <repo> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/rf.db OPENAI_API_KEY= REASON_OWNER_NAME=Omari \
     node .agents/skills/verify-reason/bin/recall-figures-drive.mjs        # 19 steps, "all ok"
```

2026-11-07: 19 ok at `8113bcf` and at the release head `36db733`. The same drive at `8a1fe18` (before the release): "the spa call is
first" FAIL (top hit `you: I don't have any spa place saved.`), "forget Yaw … clears recall" FAIL,
"Yaw gone from recall" FAIL (5 hits left), then `no such table: recall_forgotten` — so it is a real
before/after.

**Real model, once, on the cage** (claude-cli on the test token — Launch B; never the API): seed a
settled `calls` row for `dm:owner` (label `Renew Body Spa`, goal + summary) and a
`do you remember the spa place?` / `I don't have any spa place saved.` exchange into `$RUN/reason.db`
with node:sqlite (`peek.sh` opens read-only), then
`bin/inbound.sh text "hey what was that spa place you called for me last week? the one with saturday openings"`.
2026-11-07: `recall` → no fact → `memory_search` → `history[0]` the call; reply "That was Renew Body
Spa. I called them Wednesday the 4th … Saturday 2pm slot … ask for Mira", no "nothing saved".

**End state:** `memory_search` `history[0].kind === "call"`; no history text matching Reason's
"nothing saved" line; after `forget`, `recall_forgotten` rows for the conversation, no history text
naming them, the `event_log` rows still there, another conversation's matching call still found.

## Gotchas

- In the word fallback a "nothing saved" exchange's **question** row (their line alone, no span) can
  still come back as `them: do you remember the spa place?` — `replyOf` reads Reason's lines inside the
  matched span only, and a single user row has none. Their own words, not Reason's denial; harmless,
  but don't read it as the filter failing.
- `forget` matches whole words (`hasWords`), so "Yaw" never clears "Yawn"; a nickname not in the row's
  text is not reached.
- `peek.sh sql` is read-only — seed the cage DB with a separate node:sqlite connection
  (`PRAGMA busy_timeout` first; the server holds it in WAL).
