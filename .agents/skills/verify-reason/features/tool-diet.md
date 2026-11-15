# Tool diet (src/tooldiet.js, REASON_TOOL_DIET = off (default) | owner | on)

A reply call carries core + the person's likely tools whole; the rest are found by search (the API's
`tool_search_tool_bm25` with `defer_loading`, or the CLI's ToolSearch). The set is only replaced when
their cache is cold (no model call for 6 min), and is stored (`tool_sets`), so a restart keeps it.

**Live: `on`** (switches 2026-11-14) for everyone.

Offline: `node --test test/tool-diet.test.js test/mcp-always-load.test.js` (all pass 2026-11-14, misc
group 122/122; incl. "every CORE and PACKS name is a real tool", "the tools array is byte-identical call
after call").

No model, in process (2026-11-14, `7d5b5f54`, evidence `*-g4-switches`, `switches-drive.mjs`): with the
switch on, an API call's tools for a member were 255 visible → 24 loaded whole + the search tool + 231
deferred.

Before/after on the real claude-cli turn (test token, see Launch; ~4 turns a case):

    D=$(mktemp -d) && env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$USER REASON_DB_PATH=$D/td.db \
      node --env-file="$E" bin/tool-diet-drive.mjs [--only c2,r3] [--idle-cold 6] [--out f.jsonl]

`--idle-cold` waits past the cache's life before each cold run; without it "cold" still reads the
tool schemas from the cache. The API path needs a paid drive, and only with the owner's go.
