# Meal nutrition estimation

Somebody sends a photo of food, a photo of a nutrition label, or describes a meal in text or voice,
and Reason replies with an honest calorie and macro estimate — a range, never a single number, with
a confidence level. Logging is opt-in per conversation. A user can say "stop giving me numbers" and
Reason honours it.

Source: `src/tools.js` — the `case "meal_estimate"`, `"meal_query"`, `"meal_correct"` and
`"meal_log_consent"` blocks, their `name: "meal_…"` tool definitions and their zod schemas (line
numbers churn; re-grep `grep -n 'case "meal_\|name: "meal_\|^  meal_' src/tools.js`).
`src/nutrition.js` (`validateEstimate`, `formatReply`, `sumMeals`, rounding). Database: `src/db.js`
(`meal_entries` table, `saveMealEntry`, `mealEntriesSince`, `mealEntryById`, `correctMealEntry`;
there is no delete function). Preferences: `db.setOnlyPreference` writes and `db.latestPreference`
reads one row per setting — category `meal_logging` for consent, category `meal_numbers` for the
numbers opt-out (`stop_numbers` is only the value passed to `meal_log_consent`).
Tests: **partial.** `test/meal-today-zone.test.js` (2, #503): `meal_query` "today" is the person's own day
in their confirmed zone, not the server's UTC day (an evening total keeps lunch, drops last night's dinner).
There is no `test/meal.test.js` (the tools shipped in `3ae6c51` without one),
but `test/memory-quality.test.js` (section "4. meal logging", added in #42) runs
`meal_log_consent` and `meal_estimate` through `runTool`: yes → no → yes switches logging off and
back on, and the numbers opt-out still holds after thirty newer preferences. Estimate
validation, `meal_query`, `meal_correct` and the duplicate check are untested.

## Sub-features

- **Photo of a plate or meal.** Claude lists each visible item, estimates grams from reference
  objects, and gives low / likely / high for kcal, protein, carbs, fat. Wide ranges for soups, mixed
  dishes, sauces, fried food. Medium confidence at best.
- **Photo of a nutrition label.** Reads the printed numbers verbatim, asks how much was eaten (never
  assumes whole package or one serving), then scales. High confidence only when the label is fully
  readable and the amount is stated. Blurry label: asks for a better photo, no invented numbers.
- **Voice or text description of a meal.** Same estimator path — the model receives the transcript
  and treats it as the meal description.
- **Corrections.** "It was half the rice" → recomputes, replaces the active entry, keeps the
  original in history (`original_id` points back). Never double counts.
- **Duplicate photo detection.** Same `media_id` within the same `conversation_id` → no second
  active entry (`saveMealEntry` returns the existing id with `duplicate: true`). *Not built:* a
  second angle of the same plate asking "same meal?" — no code or prompt does it.
- **Logging opt-in.** Default: answer only, nothing stored beyond the reply. `meal_log_consent` asks
  once per conversation. `yes` → future estimates are saved. `no` → answer-only. `stop_numbers` →
  a `meal_numbers` preference, and `meal_estimate` then refuses with "Acknowledge the food without
  numbers". The latest answer wins for each setting.
- **Querying logged meals.** "What have I eaten today / this week" → exact SQL over the user's own
  `meal_entries`, ranges added up honestly.
- **Deleting meal log — not built.** There is no meal-only delete: no delete function in
  `src/db.js` and no meal-delete tool, so "delete my meal log" has no code path; treat any claim
  that it worked as a false success. The only thing that erases `meal_entries` is the whole-person
  data delete (`src/data.js:260` lists it in `TABLES`, `deleteData` at `src/data.js:685`), which
  takes everything else of theirs with it.
- **Allergen safety.** Never states or implies an allergen is absent because it is not visible. For
  allergen questions about a plate photo, points to the package.
- **No diet regimen by default.** No calorie goals, targets, "good/bad" labels, weight advice unless
  the user sets a goal.
- **Gentle about food.** If the user shows signs of struggling, drops numbers, does not moralise.
- **User isolation.** Every `meal_entries` row carries `conversation_id` and every query filters on
  it. One person's meals are never visible to another conversation.

## How to get to it (user POV)

- Send a photo of food in iMessage → get an estimate reply.
- Send a photo of a nutrition label → get label-based numbers + a question about amount.
- Say or text "I had a chicken sandwich for lunch" → get a text-based estimate.
- "What have I eaten today?" → summary from logged entries.
- "Stop giving me numbers" → honoured in all future replies.
- "Log my meals" / "don't log" → consent recorded per conversation.

## Driving it with the harness

**Offline suite (partial — no meal-specific test file yet):**

```bash
cd ~/Desktop/pa
node --test test/memory-quality.test.js   # 10 pass at b2861c2; two are the meal consent / numbers tests
```

Those two pin consent and the numbers opt-out. A `test/meal.test.js` covering estimate validation,
`meal_query` totals, `meal_correct` and the same-`media_id` duplicate is the main gap to close.

**Caged instance, no model (the cage's API key is blanked since #115, so the inbound recipe below
answers nothing).** Driven 2026-10-25 at `f3669e8`, in process under `caged.sh env`:
`runTool("meal_log_consent", {consent: "yes"})` → "Meals will be logged from now on.";
`meal_estimate {type: "plate", items: ["jollof rice"], kcal_low: 400, kcal_likely: 550, kcal_high:
700, protein_g: 12, carbs_g: 80, fat_g: 18, confidence: "medium"}` → `logged: true`, `entry_id: 1`,
reply "Roughly 550 kcal (400 to 700), about 10 g protein, 80 g carbs, 20 g fat" (grams said rounded);
`meal_query {period: "today"}` → `count: 1`. Re-driven 2026-10-27 at `00f3300` on a fresh
`REASON_DB_PATH`, plus the untested paths: the same estimate again with `media_id: 101` (an
**integer** — a string is `Bad input`) → same `entry_id`, `duplicate: true`; `meal_correct
{entry_id: 1, …}` → `new_id: 2`, row 1 `active = 0`, row 2 `original_id = 1`; a second correct of
1 → `entry was already corrected`; `meal_log_consent {consent: "stop_numbers"}` → the next
`meal_estimate` refuses. A `stop_numbers` left in the cage's own `dm:owner` outlives a later
`yes` (separate settings), so use a fresh DB for a clean run.

**Caged instance — a full inbound (needs a model the cage no longer has):**

```bash
bin/caged.sh start
# Send a text message referencing food (model estimates from the description)
bin/inbound.sh text "I just had grilled chicken with rice and a side salad for lunch"
bin/peek.sh thread     # confirm the estimate is in the reply
bin/peek.sh sql "SELECT * FROM meal_entries"   # nothing stored (logging off by default)
```

To test logging consent, drive two turns: one where the model asks, one where the user says yes,
then check `meal_entries` for a row.

**What to check in the database after a drive:**

| Table | What proves it |
|---|---|
| `meal_entries` | A row with `conversation_id`, `type`, `items` JSON, kcal range, macros, `confidence`, `source_note` |
| `meal_entries` (correction) | `original_id` points to the replaced row, replaced row has `active = 0` |
| `meal_entries` (duplicate) | Same `media_id` → only one active row |
| `preferences` | `category = "meal_logging"` with or without `turned_down` |
| `preferences` | `category = "meal_numbers"` when the user opted out of numbers (one row; latest answer wins) |

## Gotchas

- **No dedicated test file.** The 127 tests the shipping session cited were from existing test files
  (photos, media, looked, harm, memory), not meal-specific tests. There is no `test/meal.test.js`;
  only consent and the numbers opt-out are pinned, in `test/memory-quality.test.js`.
- **Logging is preference-based, not a separate table.** Consent is `setOnlyPreference` with
  `category: "meal_logging"`; the numbers opt-out is `category: "meal_numbers"` — **not**
  `stop_numbers`, so a query on that category finds nothing. Both are read with `latestPreference`
  at the top of `case "meal_estimate"`, numbers first. Before #42 a `.some(...)` over the capped
  taste list let an old "yes" outvote a later "no".
- **`meal_correct` is guarded.** `correctMealEntry` returns `entry not found` for an unknown id and
  `entry was already corrected` for an inactive one, and `meal_correct` hands that error back; the
  corrected row's `original_id` points at the first entry in the chain.
- **Image cost.** One vision call per photo. The image is not carried in later turns — only a text
  summary. Resize before sending: JPEG, long edge ~1568 px.
- **The cage cannot prove the reply text.** The send path is not connected, so the actual iMessage
  reply ("Looks like grilled chicken…") is only visible in `serve.log` if `--log` is on (it is).
  Read the log around the drive.
- **No FoodData Central or Open Food Facts integration yet.** Estimates are Claude-only (stage 1).
  A data.gov key and the grounding stage were deferred.
