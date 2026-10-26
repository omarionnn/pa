# Scheduled calls — "call me at 7", "wake me up at 6:30 with a call", "ring me in 20 minutes"

A timer can end in a phone call instead of a text. The person asks to be called, woken or rung at a
time; Reason sets one timer that carries the call; when it fires, code places the call to the
person's own number through the ordinary `call_place` path, and the call opens with why it is
ringing ("hey Omari — you asked me to call at 7 to get you up."). Nothing is texted first. If the
call cannot be placed (no phone line, the day's call cap, the provider failing) one text says it
tried and why, in the person's words, never the model's. If the phone rings and nobody picks up (or
voicemail answers), one text says so when the call settles, whichever path settles it. "Remind me"
alone stays a text. A named wake-up time is rung at that time; quiet hours move a call only when
Reason picked the hour and said so (`their_time: false`). "Call me every weekday at 7" is a series
whose every firing rings.

Source: `src/tools.js` (`timer_set` — `then_call`, `their_time`; the refusals at set time:
`not_connected`, no number on file, `payment_details_refused`; `timerView` → `calls_them`;
`call_place` — `ctx.scheduledTimerId` → `announcementFor({ because })`, the
`requireAnnouncement` fallback to the plain greeting, `createCall({ timerId })`; `settleCall` →
`queueMissedScheduledCall`), `src/runtime.js` (`_fireTimer` — a call timer passes the proactive
ceiling and the never-twice check reads `db.callByTimer`; `_runTimer` → `_placeTimerCall`;
`unplacedCallLine`; `missedTimerLine` for a call), `src/db.js` (`timers.call_goal`,
`series.call_goal`, `calls.timer_id`, `calls.missed_told_at`, `callByTimer`, `markMissedCallTold`),
`src/series.js` (`start({ callGoal })`, `scheduleOne` copies it onto each firing, `view` →
`calls_them`, `outOfQuiet` exported), `src/calls/provider.js` (`announcementFor({ because })`),
`src/calls/voice.js` (`scheduledCallNote` in `ownerContext`), `src/kept.js` (`by_phone`),
`src/agent.js` (the timers line: asked to be called, woken or rung → `then_call`; "remind me" is a
text).
Tests: `test/timer-call.test.js` (16 pass at this PR).

## Sub-features

- **The timer carries the call.** `timer_set` with `then_call` writes `timers.call_goal`. The
  list and the kept note mark it (`calls_them`, `by_phone`) so "never mind the call" finds it and
  the model never reads a call as a text.
- **Firing is the call, not a turn.** `_placeTimerCall` runs `call_place` with `to: "owner"` (this
  conversation's own number, nobody else's — a third party is impossible from a timer) and the
  goal. No model turn, no text. The call row is made with `timer_id` before the dial; a retry
  after a crash finds it and does not ring twice.
- **First words say why.** `announcementFor({ toOwner, because })` → `hey <name> — <goal>.` The
  owner guard still holds (nothing "recorded", no "AI assistant"); a goal that trips the guard
  ("a call for the airport") falls back to the plain greeting and the voice turn is still told
  why (`scheduledCallNote`).
- **Refusals become one text.** Every refusal `call_place` already makes (no provider, cannot
  record, payment details, daily call count, daily call minutes) comes back as one text under the
  timer's own key, worded for the person (`today's call limit is used up`), never the
  model-facing instruction or the env var name. API spend caps never stop a call (owner's rule,
  `src/spend.js`); their heads-up text is the ops row's.
- **Nobody picked up → one text.** `settleCall` queues it (`timer:<id>:call_missed`) once,
  claimed by `markMissedCallTold`, whichever path settled the call: webhook, `call_status`, or
  the lost-calls sweep. Voicemail counts as not reached. An answered call texts nothing.
- **Named times are honoured.** A one-off call rings at `fire_at`; only `their_time: false`
  moves a night hour to 08:00 (reusing the series' `outOfQuiet`). A call timer also passes the
  proactive daily ceiling: they asked for it.
- **Series.** `repeat` + `then_call` → `series.call_goal`; every scheduled firing carries it;
  `say_back` says "i'll ring you".
- **Refused when asked, not at 7am.** With no live provider or no number on file, `timer_set`
  refuses with `not_connected` and tells the model to offer a text at that time instead.

## How to get to it (user POV)

Text "call me at 7 tomorrow to get me up" → "i'll ring you at 7." At 7 the phone rings: "hey Omari
— you asked me to call at 7 to get you up." Text "remind me at 7" → a text at 7. Text "never mind
the call" → nothing rings. Set a wake-up for 6:30 → it rings at 6:30, not 8.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/timer-call.test.js                       # 16 pass
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/timer-call.db node .agents/skills/verify-reason/bin/timer-call-drive.mjs
```

`bin/timer-call-drive.mjs` runs the real `timer_set`, the real Runtime sweep, the real `call_place`
and settle paths against the fake call provider and the fake texting channel, in process, under the
cage's blanked env: 20 steps, `all ok`. It proves the call is placed with the goal and the opening
line, no text first, the cancel, the unanswered call's single text, the cap text, the provider
failure text, the series, and the set-time refusal.

**End state that proves it:** `calls.placed[0].announcement` is `hey Omari — <goal>.` and
`fake.sent` is empty after the firing; after the no-answer settle, one outbox row
`timer:<id>:call_missed` and one text; the cap step places nothing and texts `today's call limit is
used up`.

**The cage's HTTP instance cannot place a call** (every call credential is blanked and the fake
provider is registered switched off), so a model-driven "call me at 7" on the cage is refused at
`timer_set` with `not_connected` — which is itself the set-time refusal above. Never set
`REASON_CALL_PROVIDER=elevenlabs` on the cage to prove this.

**Live, read-only:**

```bash
ssh root@91.98.19.150 "journalctl -u reason --no-pager --since '24 hours ago' | grep -E 'scheduled_call|call_missed' | cut -c1-220 | tail -20"
ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db \"select id, fire_at, call_goal, fired_at from timers where call_goal is not null order by id desc limit 5\""
```

## Gotchas

- The first call ever on a number still queues the once-ever "every call is recorded" text
  (`recordingNoteFor`); that is the existing disclosure rule, not a second text from this feature.
- `their_time` on a one-off is read only with `then_call`; a plain text timer's `fire_at` is used
  as given, as before.
- A scheduled call that fails is still a `calls` row (`state: failed`) — the record is honest.
- The `call_place` cap refusal text names the person in the third person and the env var; it is
  for the model. `unplacedCallLine` maps statuses to plain reasons — add a line there for any new
  refusal status, or the raw error's first sentence is quoted.
- Never run the drive outside `caged.sh env`; it refuses if any sending credential is set.
