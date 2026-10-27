# Reason Web — Memory (`/web/memory`)

Signed in, `https://heyreason.com/web/memory` is "What Reason remembers": every active fact on the
person's Reason, one per line between dashed rules, under PREFERENCES · PEOPLE · PLACES · ROUTINES ·
WHY (an empty heading is not drawn), Reason's unconfirmed guesses under REASON THINKS… in Caveat and
pen (desktop: the right margin), and MANAGE CHAT HISTORY → (view-only v1: the thread, `/web?thread`).
Design: handoff 2026-10-26 §5, reference `desk-memory-*`, `sheet-memory-*` 7A/7B/7C.

Source: `src/pages/webmemory.js` (page, states, `/web/memory/correct|forget|guess`, client script),
`src/pages/websignin.js` (dispatch, signed in only), `src/http.js` (route), `src/factgroups.js` (the
background filer), `src/db.js` (`person_facts.memory_group`, `MEMORY_GROUPS`, `memoryFacts`,
`unfiledFacts`, `fileFact`, `guesses.dismissed_at`, `dismissGuess`, `outOfProfile`),
`src/extract.js` (the extractor's optional `group`), `src/runtime.js` (`extract()` enqueues
`factgroups` on the background lane).

## Sub-features

- **Groups.** `person_facts.memory_group` ∈ preferences/people/places/routines/why, chosen by a
  model: the extractor fills it as it writes (`group` in its schema); anything written without one
  (the `remember` tool, a confirmed guess, every fact from before 10-26) is filed by
  `factgroups.fileFacts` — 60 at a time, one conversation per read, on the claude-cli subscription
  through the background lane, never the API (API backend: nothing filed). Until filed, the page uses
  the extractor's category where it means the same (preference→preferences, location→places, …),
  else people for another subject, preferences for their own. `whys` rows are WHY too.
- **A line.** Their own facts as saved; another subject's as "Juno: is your dog" unless the fact
  already names them. Newest first in each group.
- **Correct (7B).** CORRECT is a link (`?correct=fact-<id>`) to the line as an input; the script
  does it in place. Save → `correctFact` (new row, old one `corrected`, group carried, factKey clash
  refused), old wording scrubbed from memory tool results + Reason's replies, embedding replaced,
  profile rebuilt; "got it." (role=status) beside the line, fading. `why-<id>` rows go through
  `correctWhy`.
- **Forget (7C).** The card ("FORGET THIS?", the line, "I'll stop recalling this. The message where
  you said it stays in your chat history.", Forget it / KEEP IT; dialog, Escape, focus kept).
  `dropFact` (`deleted`, so the extractor cannot revive it) + `outOfProfile` (the saved profile
  block goes now if it carried the fact) + scrub + embedding removed. The `messages` history is
  untouched.
- **Guesses.** `listGuesses({ includePatterns: true })`. Yes → `remember(..., user_stated)` +
  `confirmGuess`; No → `dismissGuess` (row kept with `dismissed_at`, so `noteGuess` of the same words
  returns it and nothing lists or uses it again — patterns included).
- **Refusals.** Every id is looked up in the session's conversation (another account's → 404);
  POSTs need `sameOrigin` + the session's csrf (`c` or `X-Reason-Csrf`); signed out → `/web` (401 JSON).

## Drive

```bash
node --test test/web-memory.test.js                       # 11 pinned
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/mem.db node bin/web-memory-drive.mjs   # 17 steps over real HTTP, no model
```

## End state that proves it

Live: on Hetzner, a throwaway fact on the owner's account, corrected and forgotten through
`https://heyreason.com/web/memory` with a temporary owner `page_sessions` row; the throwaway rows and
the session row hard-deleted after. Never touch the owner's real facts.
