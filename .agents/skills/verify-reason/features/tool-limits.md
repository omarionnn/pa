# Tool input limits — a long note is shortened, not refused (src/fitlong.js)

Live (week to 2026-11-07): `timer_set` was refused three times for a `note` over 500 characters, and the
model retried or gave up. Since #376 (shop-small) a soft text field — Reason's own note to itself — that is
over its cap is cut at a word with "…" and the call goes through; the result says so. Everything else that is
wrong with an input is refused exactly as before.

- **Where:** `runToolOnTheirClock` in `src/tools.js` (`fitLongText(S[name], rawInput, name)` just before
  `runToolInner`; the result gets `input_shortened: shortenedNote(…)`). `grep -n fitLongText src/tools.js`.
- **Which fields** (`SOFT_TEXT`, `src/fitlong.js:16`): `note`, `notes`, `said`, `summary`, `help`, `why`,
  `why_now`, `urgent_why`, `their_words`, `route_description`, `inference`, `tradeoff`, `turned_down`,
  `source_note`, and only for a zod `too_big` string issue on that field; any other issue still refuses.
- **Never cut:** anything sent out word for word, ids, URLs, `then_call`, a checkout's `what` (the store
  agent buys from it), a card's `detail` (what tells two options apart); and any field of the tools in
  `NEVER_CUT_TOOLS` (`:26`: `calendar_create`, `calendar_change`, `apple_calendar_create`,
  `apple_calendar_change`, `confirm_request` — an event's `summary` is its title, a yes is held to
  `confirm_request`'s).
- **Caps changed:** `timer_set.note` 500 → 2000 (storage is TEXT). The reminders line in each turn shows only
  the first 300 characters of each note.
- **Result text:** `Shortened to fit, not refused: note (2500 → 2000 characters, cut at a word with "…"). The
  rest of the input went through as given. Do not repeat the call just to resend the cut part.`

## Drive (no model, throwaway DB)

```bash
cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/x.db node -e '
  const { runTool } = await import("./src/tools.js");
  const r = await runTool("timer_set", { fire_at: new Date(Date.now() + 864e5).toISOString(), note: "word ".repeat(500) },
    { conversationId: "dm:owner", messages: [{ role: "user", content: "[Sat, Nov 7, 2026, 3:00 PM] Omari: remind me tomorrow" }] });
  console.log(r.ok, r.input_shortened); process.exit(0)'
```

Proves it: `true` and the "Shortened to fit … (2500 → 2000 …)" line. Also `fitLongText` directly with a
small zod schema: an over-cap `note` is cut, an over-cap `then_call` is left for zod to refuse, and
`confirm_request` cuts nothing. Driven 2026-11-07 (rel-1107): all three as stated; `test/fit-long.test.js`
in a 70/70 run with the other #376 test files.
