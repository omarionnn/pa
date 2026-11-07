# Memory and the knowledge graph — what Reason remembers, and how it links

Everything somebody tells Reason (by text or on a call) lands in an event log. A queue extracts
facts, entities and relations from it into person facts and a per-person knowledge graph. When a new
message mentions Sarah, Reason's context carries what it knows about Sarah and the things linked to
her. The person can see, fix and delete every remembered row from a memory page.

Source: `src/memory.js` (the memory-page model: `ROWS`, `remembered`, `pageBlocks`, `answerNote`,
`initiativeNow`), `src/graph.js` (`resolveEntity`, `expandHops`, `buildGraphContext`,
`processExtractedGraph`, `backfillGraph`), `src/tools.js` (`remember`, `recall`, `forget`,
`memory_page`, `memory_fix`, `memory_drop`, `memory_search`, `graph_lookup`), `src/extract.js`
(the extraction-queue worker: `processQueue`, `validateAndInsert`, `knownFacts` with `KNOWN_LIMIT`,
`backfillEmbeddings`, `worthReading`, `batchPrompt`, `scheduleProfile`, `rebuildProfile`),
`src/background.js` (the subscription's background lane), `src/runtime.js` (`async extract()`:
on the `claude-cli` backend it queues one `extract` job on the lane and returns 0; on the API
backend it awaits `processQueue`), `src/privacy.js` (ages `event_log` content out), `src/db.js` (`person_facts`, `event_log`, `extraction_queue`,
`fact_embeddings`, `profile_blocks`, `graph_entities`, `graph_edges`, `graph_mentions`,
`graph_merge_candidates`). Line numbers move: `grep -n 'case "graph_lookup"\|case "memory_' src/tools.js`.
Tests (pass counts at time of writing): `memory.test.js` 33, `memory-page.test.js` 17,
`graph-edges.test.js` 7, `graph-entities.test.js` 13, `graph-extraction.test.js` 5,
`graph-isolation.test.js` 7, `graph-mentions.test.js` 4, `isolation-memory.test.js` 6,
`embedding.test.js` 5, `event-log.test.js` 3, `extraction-queue.test.js` 7 (at `f3669e8`),
`temporal-facts.test.js` 8, `profile-block.test.js` 5. Shipped in `432724a`.

## Sub-features

- **Event log + extraction queue.** Every turn is written to `event_log`; `extraction_queue` has one
  row per event (UNIQUE), `pending` → `processing` → `done`, with `attempts` and `last_error`; a row
  is retried until 3 attempts. Old `event_log` rows have `content`, `attachments` and `tool_calls`
  blanked as they age out with other content (`privacy.js`, rows still pending or processing are
  spared), so an empty `content` on an old row is by design (#48).
- **Extraction on the subscription, batched (2026-10-25).** On the `claude-cli` backend (live) the
  reader is `claude -p --json-schema` on `REASON_EXTRACTION_CLI_MODEL` (default `haiku`) and the
  profile choice on `REASON_PROFILE_CLI_MODEL` (default `sonnet`) — never the paid API, with no API
  fallback. One pass claims up to `REASON_EXTRACTION_BATCH` (8) rows, keeps the oldest
  conversation's, hands the rest back with their try returned (`db.releaseExtractions`), and reads
  them in ONE call, numbered `[1]…`; each fact's `message` index picks its `source_message_ids`.
  `worthReading` marks a row done with no call when the person's own words (bracketed code notes
  removed) hold no letter or digit, or are one word ≤12 chars not answering a question. Both run
  as background-lane jobs: one at a time, `REASON_BACKGROUND_CLI_GAP_MS` (15 s) apart, never while a
  reply turn is in flight, parked while a CLI run reports a limit. A CLI limit, timeout or SIGTERM
  is an outage to `db.EXTRACTION_OUTAGE` (try given back, retry in 5 min); rows an old outage
  exhausted are revived each pass. Log lines: `{"extracted":n,"skipped":k,…,"via":"cli"}` and
  `extraction_skipped`. Pinned in `test/api-spend.test.js`.
- **Temporal facts.** A changed fact retires the old one only when the extractor names it: every
  Already-known line it is shown carries an id, and it sets `replaces` to that id when the new message
  makes that line untrue (`db.retireForNewer`, status `superseded`). A `replaces` pointing at an id
  it was not shown is ignored and both are kept; a fact that merely adds to one keeps both (#42).
- **Embeddings.** `fact_embeddings` support `memory_search` by meaning. `backfillEmbeddings` runs at
  the top of every extraction pass and embeds active facts that have none (bounded per pass).
- **Graph.** Entities (with aliases), typed edges, mentions, merge candidates. One name is one node
  across types: `resolveEntity` returns an existing same-name entity of any type before creating one
  (#49). `expandHops` walks
  up to 2 hops; `buildGraphContext` produces the block added to a turn; `backfillGraph` fills in
  history in batches.
- **Profile block.** A short per-person summary built from facts, kept with the fact ids it used.
- **Memory page.** Facts, guesses, preferences, whys, permissions; every row correctable
  (`memory_fix`) or deletable (`memory_drop`) by id, and a correction is scrubbed from the thread
  and replies too, exactly like `forget`. Permissions are revoked only via `permission_revoke`.
- **Row numbers stay on the page (#82).** The text answer to "what do you know about me" says each
  line in plain words and never types a row's number — "#640, you're a student … say forget #640"
  went to a brand-new user on 2026-10-23 and read as a database id. They correct in plain words and
  Reason finds the row in the `memory_page` result. The rule is in `answerNote` (`src/memory.js`)
  and the memory_page line of `SYSTEM` (`src/agent.js`); pinned in `test/memory-page.test.js`.
  Driven on the cage 2026-10-23 at `226ff17`: three asks, no number in any reply (one of the three
  came back as the API-path empty-turn fallback, "something broke on my end" — a separate gap).
- **Recall reaches what Reason DID and SAID (#334, 2026-11-05, "the spa place").** Until then
  `memory_search` searched only `person_facts`, and it had no schema, so the model's every call was
  refused "Unknown tool". `src/recallindex.js` indexes, into `fact_embeddings` under their own
  `source_table`, `action_ledger` actions (bookkeeping kinds and `call_place`/`call_recording`
  skipped), `calls` once settled (3 min), one-off `timers`, and `event_log` exchanges (their message +
  the reply, 10 min wait, 1,200 chars). Only the vector is stored; words are read back from the source
  row, so a deleted row cannot come back. Indexed by the runtime sweep (`indexPending`, never awaited,
  once a minute); history backfill `scripts/recall-backfill.mjs` (dry run by default). `memory_search`
  returns `results` (facts) + `history` (`kind`, `at`, `text`); no OpenAI key or the embeddings API
  down → `keywordHistory` by words, `searched: "by words only — meaning search is down"`, and the note
  says never "nothing saved". `recall` with no fact points at `memory_search`. #334's review: emptied
  exchanges (retention sweep) are skipped past, their vectors dropped with their words and on
  `data:delete`. Offline `node --test test/recall-history.test.js` (12). In process under
  `caged.sh env` with `OPENAI_API_KEY=` (no spend): two `calls` rows on two conversations, a spa goal
  each, `runTool("memory_search", { query: "spa massage" }, { conversationId: "dm:owner", messages: [] })`
  → `count: 1`, the owner's call only, by words (2026-11-06, `c6ce172`). Since #354 / #335
  (11-07): done things rank above the thread, Reason's own "nothing saved" replies are never handed
  back, and `forget` takes the calls, exchanges, actions and reminders naming them out of recall
  (`recall_forgotten`) — all of that, with its drive, is [recall.md](recall.md);
  `test/recall-history.test.js` grew with it.
- **Isolation.** Nothing crosses conversations: graph, facts, embeddings are all keyed on
  `conversation_id`. The recall index filters every store query AND each source-row read on it.

## How to get to it (user POV)

"Remember that my sister's birthday is March 3", "what do you remember about me?" (a page),
"that's wrong, it's March 4", "forget that", "who is Sarah?". Nothing to do for the graph; it fills
in as they talk.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/memory.test.js test/memory-page.test.js test/isolation-memory.test.js \
  test/graph-*.test.js test/embedding.test.js test/event-log.test.js \
  test/extraction-queue.test.js test/temporal-facts.test.js test/profile-block.test.js
```

Real extraction calls a model; the tests use a scripted extractor, so the queue → graph path is
proven offline.

**Caged inbound** (`bin/inbound.sh`, see `inbound-message.md`) then read what landed:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
bin/inbound.sh text "my sister Ama's birthday is March 3"        # per inbound-message.md
bin/peek.sh sql "SELECT id, role, substr(content,1,60) FROM event_log ORDER BY id"
bin/peek.sh sql "SELECT id, event_log_id, state, attempts, last_error FROM extraction_queue"
bin/peek.sh sql "SELECT * FROM person_facts ORDER BY id DESC LIMIT 5"
bin/peek.sh sql "SELECT id, canonical_name, type, aliases FROM graph_entities"
bin/caged.sh stop
```

**The cage's extraction is not model-free.** The reader is always `claude -p` (`extractMessages`
in `src/extract.js` calls `runClaudeCli`, whatever `REASON_BACKEND` is); only the lane differs. So
on the API-backend, no-key cage a memorable text still spends one haiku run of this Mac's
subscription and lands real facts: driven 2026-10-30, the text above → `{"extracted":1,…,"facts":2,
"via":"cli"}`, queue `done`, `model_usage` `extraction|cli`, two `person_facts` rows. Queue rows
stay `pending` (with `last_error`) only when `claude` itself cannot run.

**Live, read-only:** `sqlite3 /opt/reason/data/reason.db "select state,count(*) from extraction_queue group by 1"`
(a growing `pending` count or rows with `attempts` ≥ 3 and a `last_error` is the failure to look for),
then `journalctl -u reason --since -1h | grep -E '"extracted"|extraction failed'` — `"via":"cli"` on
every pass — and `select feature,via,count(*) from model_usage where feature in ('extraction','profile') group by 1,2`
(only `cli` rows).
**End state that proves it:** event_log row → extraction_queue `done` → `graph_entities` +
`graph_edges` rows for the same `conversation_id`, and `graph_lookup` for the name returns them.

## Gotchas

- Isolation is the property to protect: any query added to the graph or facts without a
  `conversation_id` filter is a cross-user leak. `graph-isolation` and `isolation-memory` pin it.
- A correction must scrub the thread, not just the row, or Reason repeats the old wording.
- Filler turns are not queued for extraction on calls (see `call-completeness.md`).
- Extraction needs a working `claude` login, not a key (see the cage note above); embeddings need
  `OPENAI_API_KEY`, and absent one `backfillEmbeddings` returns 0 (`src/extract.js:185`).
- Don't read `person_facts` content from the live database into a report; it is the user's data.
