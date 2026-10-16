# Memory and the knowledge graph — what Reason remembers, and how it links

Everything somebody tells Reason (by text or on a call) lands in an event log. A queue extracts
facts, entities and relations from it into person facts and a per-person knowledge graph. When a new
message mentions Sarah, Reason's context carries what it knows about Sarah and the things linked to
her. The person can see, fix and delete every remembered row from a memory page.

Source: `src/memory.js` (the memory-page model: `ROWS`, `remembered`, `pageBlocks`, `answerNote`,
`initiativeNow`), `src/graph.js` (`resolveEntity`, `expandHops`, `buildGraphContext`,
`processExtractedGraph`, `backfillGraph`), `src/tools.js` (`remember`, `recall`, `forget`,
`memory_page`, `memory_fix`, `memory_drop`, `memory_search`, `graph_lookup`), `src/runtime.js`
(the extraction-queue worker), `src/db.js` (`person_facts`, `event_log`, `extraction_queue`,
`fact_embeddings`, `profile_blocks`, `graph_entities`, `graph_edges`, `graph_mentions`,
`graph_merge_candidates`). Line numbers move: `grep -n 'case "graph_lookup"\|case "memory_' src/tools.js`.
Tests (pass counts at time of writing): `memory.test.js` 11, `memory-page.test.js` 17,
`graph-edges.test.js` 7, `graph-entities.test.js` 11, `graph-extraction.test.js` 5,
`graph-isolation.test.js` 7, `graph-mentions.test.js` 4, `isolation-memory.test.js` 7,
`embedding.test.js` 5, `event-log.test.js` 3, `extraction-queue.test.js` 4,
`temporal-facts.test.js` 8, `profile-block.test.js` 5. Shipped in `432724a`.

## Sub-features

- **Event log + extraction queue.** Every turn is written to `event_log`; `extraction_queue` has one
  row per event (UNIQUE), `pending` → processed, with attempts and `last_error`.
- **Temporal facts.** A newer fact supersedes an older one on the same subject (a text correction
  beats an earlier call fact) instead of piling up.
- **Embeddings.** `fact_embeddings` support `memory_search` by meaning.
- **Graph.** Entities (with aliases), typed edges, mentions, merge candidates; `expandHops` walks
  up to 2 hops; `buildGraphContext` produces the block added to a turn; `backfillGraph` fills in
  history in batches.
- **Profile block.** A short per-person summary built from facts, kept with the fact ids it used.
- **Memory page.** Facts, guesses, preferences, whys, permissions; every row correctable
  (`memory_fix`) or deletable (`memory_drop`) by id, and a correction is scrubbed from the thread
  and replies too, exactly like `forget`. Permissions are revoked only via `permission_revoke`.
- **Isolation.** Nothing crosses conversations: graph, facts, embeddings are all keyed on
  `conversation_id`.

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
bin/peek.sh sql "SELECT id, name, type FROM graph_entities"
bin/caged.sh stop
```

Queue rows may stay `pending` in the cage if no extraction model is reachable; that is expected
there, and `last_error` says why.

**Live, read-only:** `sqlite3 /opt/reason/data/reason.db "select state,count(*) from extraction_queue group by 1"`
(a growing `pending` count or rows with `attempts` ≥ 3 and a `last_error` is the failure to look for).
**End state that proves it:** event_log row → extraction_queue `processed` → `graph_entities` +
`graph_edges` rows for the same `conversation_id`, and `graph_lookup` for the name returns them.

## Gotchas

- Isolation is the property to protect: any query added to the graph or facts without a
  `conversation_id` filter is a cross-user leak. `graph-isolation` and `isolation-memory` pin it.
- A correction must scrub the thread, not just the row, or Reason repeats the old wording.
- Filler turns are not queued for extraction on calls (see `call-completeness.md`).
- Embedding and extraction need a model key; absent one the queue backs up silently.
- Don't read `person_facts` content from the live database into a report; it is the user's data.
