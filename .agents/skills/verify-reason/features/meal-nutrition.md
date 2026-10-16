# Meal nutrition estimation

Somebody sends a photo of food, a photo of a nutrition label, or describes a meal in text or voice,
and Reason replies with an honest calorie and macro estimate — a range, never a single number, with
a confidence level. Logging is opt-in per conversation. A user can say "stop giving me numbers" and
Reason honours it.

Source: `src/tools.js` (`meal_estimate` at `:8119`, `meal_correct` at `:8168`, `meal_log_consent`
at `:8183`, `meal_query` at `:8196`; schemas at `:5500`–`:5533`; tool registration at `:2794`–
`:2860`). Database: `src/db.js` (`meal_entries` table at `:7006`, `saveMealEntry`, `getMealEntries`,
`correctMealEntry`, `deleteMealEntry`). Preferences reuse: `learnPreference` with category
`meal_logging` and `stop_numbers`.
Tests: **no dedicated test file** — the tools were shipped in `3ae6c51` without a test/meal.test.js.
Infrastructure tests (photos, media, looked, harm) cover the paths that feed images to the estimator.

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
  entry. A second angle within a few minutes: asks "same meal?"
- **Logging opt-in.** Default: answer only, nothing stored beyond the reply. `meal_log_consent` asks
  once per conversation. `yes` → future estimates are saved. `no` → answer-only. `stop_numbers` →
  no calorie numbers in replies at all.
- **Querying logged meals.** "What have I eaten today / this week" → exact SQL over the user's own
  `meal_entries`, ranges added up honestly.
- **Deleting meal log.** "Delete my meal log" → deletes for real with confirmation, through the
  existing data-control path.
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

**Offline suite (no meal-specific test file exists yet — this is a gap):**

The meal tools are in `src/tools.js` but no `test/meal.test.js` was shipped. Test coverage relies on
the broader photo/media/harm/memory tests validating the infrastructure. A dedicated test file
covering each sub-feature above is the main gap to close.

**Caged instance — a full inbound with a photo:**

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
| `preferences` | `category = "stop_numbers"` when the user opted out of numbers |

## Gotchas

- **No dedicated test file.** The 127 tests the shipping session cited were from existing test files
  (photos, media, looked, harm, memory), not meal-specific tests. There is no `test/meal.test.js`.
  The meal tools themselves are untested in isolation.
- **Logging is preference-based, not a separate table.** Consent uses `learnPreference` with
  `category: "meal_logging"`. `stop_numbers` is a separate preference. Both are checked at the top
  of `meal_estimate` (`:8128`).
- **`meal_correct` assumes the active entry exists.** If called with a nonexistent or already-
  corrected entry, the behaviour depends on `getMealEntry` returning null — check the guard.
- **Image cost.** One vision call per photo. The image is not carried in later turns — only a text
  summary. Resize before sending: JPEG, long edge ~1568 px.
- **The cage cannot prove the reply text.** The send path is not connected, so the actual iMessage
  reply ("Looks like grilled chicken…") is only visible in `serve.log` if `--log` is on (it is).
  Read the log around the drive.
- **No FoodData Central or Open Food Facts integration yet.** Estimates are Claude-only (stage 1).
  A data.gov key and the grounding stage were deferred.
