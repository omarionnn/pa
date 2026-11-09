# Tool diet (src/tooldiet.js, REASON_TOOL_DIET = off (default) | owner | on)

A reply call carries core + the person's likely tools whole; the rest are found by search (the API's
`tool_search_tool_bm25` with `defer_loading`, or the CLI's ToolSearch). The set is only replaced when
their cache is cold (no model call for 6 min), and is stored (`tool_sets`), so a restart keeps it.

Offline: `node --test test/tool-diet.test.js test/mcp-always-load.test.js`.

Before/after on the real claude-cli turn (test token, see Launch; ~4 turns a case):

    D=$(mktemp -d) && env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$USER REASON_DB_PATH=$D/td.db \
      node --env-file="$E" bin/tool-diet-drive.mjs [--only c2,r3] [--idle-cold 6] [--out f.jsonl]

`--idle-cold` waits past the cache's life before each cold run; without it "cold" still reads the
tool schemas from the cache. The API path needs a paid drive, and only with the owner's go.
