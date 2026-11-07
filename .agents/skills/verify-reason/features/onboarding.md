# First-chat onboarding — `REASON_ONBOARDING` off | test | on

Somebody new taps the site's Text Reason button (Messages opens with "hey" typed) and sends it. With
the switch covering them, their first conversation is a short paced run of fixed bubbles instead of a
prompt-led model turn (owner spec, 2026-10-30):

1. "hey" → ONE opener from `OPENERS` (random). A real question first → its one-line answer, then the opener.
2. Their name → saved (`accounts.name`), then four bubbles a beat apart: "nice to meet you, <name>", what
   Reason is, the contact-card line **on the same message as the vCard** (an outbox row with
   `media.mediaUrl` → `Router.sendNow` → `sendMediaUrl`; Sendblue shows the words then the card; the same
   `/reason-<sha8>.vcf` every card uses), then "so what do you do? student, engineer, something else?".
   No card possible (`cardUrl`: no public URL, no line number, already sent, or a failed try inside
   `RETRY_AFTER_MS`) → the line is not said either; a card that fails takes its line with it, never the
   question after it (the card row branches off the chain: the next row waits on the bubble before it).
3. What they do → remembered as a fact; 2–3 model-written ideas for that work (only from a fixed list
   of things Reason really does), then `CLOSING` word for word.
4. Their to-do list (a photo, or typed) → the normal turn, with `TODO_FRAME` in front: do what it can
   now, reminders for the rest, say which is which, never "done" without a tool.

Detours: a question/remark at any step → its one-line answer + one steer back to that step
(`STEERS`); a second detour on the same step moves on instead of pushing. A declined name is never
asked again (the prompt's no-name line changes: `accounts.ownerOf().nameAsked` → `whoLine` in
`src/agent.js`). Something real (a task, a lookup, anything needing care, a picture before step 4) ends
the flow and gets the normal turn. Quiet mid-flow → ONE nudge ever (`NUDGES`), on a timer labelled
`onboarding:nudge` (hidden from `listTimers` / Ongoing / blurbs), moved to 10am if due 9pm–10am.

Who: only a person whose account their own first text just made — auto-admit (live) or a pre-approved
`REASON_TEST_NUMBERS` number — and never the operator, Web, an invite claim, an event join or the
master's yes. State is `accounts.onboarding` (NULL = exempt; `not_started` → `awaiting_name` →
`awaiting_occupation` → `awaiting_todo` → `complete`), added by ALTER: the run that adds the column
marks every existing account `complete`. `test` = only `REASON_ONBOARDING_NUMBERS`. A test number that
already has an account is exempt — delete that account first to re-run it.

A step is ONE transaction (`db.atomically`): its bubbles queued as an ordered outbox chain (`after_id`),
its state, its history. The rows are then tried a beat apart; a failure stops the loop and the sweep
finishes the chain in order — through a retry or a restart, nobody is steered back to a step they never
saw. The harm screen (`Runtime.screen`) runs beside the read (an unscreened read is asked once more): not
clear (or unscreened twice) → the flow ends
and the normal, screened turn answers. A read that fails ends it too (never a second prompt-led
welcome on top). Voice notes, contact cards and links are words by then; a picture or document is
the to-do list on step 4 (`TODO_FRAME`), before that a real thing (no frame); a typed list before step 4
gets `TODO_FRAME_UNASKED`. Both notes live in `src/onboardframes.js` and `harm.ownWords` drops them (exact
lines only), so the screen reads their own words. Idle past `REASON_ONBOARDING_IDLE_DAYS` (7) → `complete` on the next text.
The nudge's waking hour is THEIR zone (`zoneFor`).

Meaning is the model's: one structured side call per text (`readText`, `src/onboarding.js:175`, through
`askStructured` in `src/backends/side.js:110` — the CLI on claude-cli, the API on `REASON_BACKEND=api`,
skipped when `sideAskAllowed()` says no; `REASON_ONBOARDING_CLI_MODEL` haiku, feature `onboarding` in
`model_usage`), never a regex.

Source: `src/onboarding.js`; hooks in `src/channels/router.js` (`deliver`: `arrivedNow` → `begin`, the
first-text card skipped while in it; `#drainHeld`: `onboarding.handle` before requests are opened,
`onboardFrame` into the turn text), `src/runtime.js` (`_runTimer` → `fireNudge`), `src/db.js`
(columns + migration, `setOnboarding`, `cancelOnboardingNudges`, `listTimers` filter), `src/config.js`,
`src/accounts.js` (`nameAsked`), `src/agent.js` (`whoLine`), `src/itemtitle.js`.

## Prove it

- Offline: `node --test test/onboarding.test.js test/onboarding-migration.test.js` (38 + 2; the PR #270
  review added: screen beside the read (crisis, unscreened), failed read ends cleanly, name on the account,
  card tried recently / card failing takes its line, order through a retry, a kill mid-step + sweep, the
  commit is atomic, voice note as words, picture before step 4, list as the first text, 7-day idle,
  nudge in their zone): opener +
  rotation, question-first, name → 4 bubbles + card in order with 1–2 s gaps, decline, occupation →
  ideas + exact closing, a detour at every step, second detour moves on, task ends it, read failure,
  to-do photo/typed list → the frame, existing/finished/operator/flag-off never enter, `test` mode,
  restart mid-flow (new router + runtime, same DB), the one nudge (hidden, waking hours, once, cancelled
  on reply), and the migration on a live-shaped `accounts` table.
- Real read (subscription, ~12 haiku calls): `REASON_LIVE_ONBOARDING=1 ANTHROPIC_API_KEY= node --import
  ./test/paid-key-guard.js --test test/onboarding-live.test.js` (with `REASON_BACKEND=claude-cli`) — 16/16
  on 2026-10-30, incl. three sensitive texts read as `task` and `harm.screen` calling "kofi, honestly been
  wanting to end it" `crisis`.
- Cage, end to end (subscription: 4 haiku reads + ONE full turn; fake Sendblue on loopback):

  ```bash
  REASON_VERIFY_RUN=/tmp/rv-onboarding REASON_VERIFY_PORT=8823 bin/onboarding-drive.sh evidence/<UTC>-onboarding
  REASON_VERIFY_RUN=/tmp/rv-onboarding REASON_VERIFY_PORT=8823 bin/onboarding-drive.sh evidence/<UTC>-before before   # flag off, 3 turns
  ```

  Starts its own `bin/fake-sendblue.mjs` and cage (claude-cli, `REASON_ONBOARDING=test` for one new
  number) and tears both down; refuses unless the log says `model: the claude CLI` and Sendblue is the
  fake. Use your own `REASON_VERIFY_RUN`/port: another session's cage may own the defaults. Writes
  `transcript.txt` (both sides, gaps), `sends.jsonl`, `account.json`, `timers.json`, `serve.log`.
  2026-10-30 (feat/first-chat-onboarding, again after the review fixes): 11/11 "all ok" — opener, the who-made-you detour answered +
  "but wait, I didn't get your name", Kofi → 4 bubbles, the card on its line's own message, then the question
  (gaps 1.1–1.7 s), three nursing-specific ideas + the closing line, the typed list → a drafted email,
  a laundry reminder, the dentist named as still open; account `complete`, card sent once.
  Before (flag off): the card went out with the first "hey", then three model turns.
- Never on live. Turning it on there is the owner's call (`.env`), after the PR merges.

Known and accepted (review of #270): step order across steps while a card retry is pending; a 10:30
nudge in half-hour time zones; a card queued then failing later still reads `contact_card_sent_at`.
