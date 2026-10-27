# Reason Web — Ongoing (tab, margin, details, 9D)

What Reason is holding for the signed-in person, drawn from the rows that ARE the work (design
handoff 2026-10-26, "3 · Ongoing", sheets 2/3, 9D). Model: `src/ongoing.js` (`ongoing`, `findItem`,
`approvals`, `stepsOf`, `resultFor`). Drawing + routes: `src/pages/webongoing.js` (`ogMargin`,
`renderDetail`, `ongoingRequest`, `NINE_D_JS`, `OG_POLL_JS`). Wired into `src/pages/webconvo.js`
(`inHand`/`waitingApprovals` delegate; `ongoingMargin` → `ogMargin`; HIDE → / sticky bar kept;
`renderHome` → `homeRows`) and `src/http.js` (`ongoingRoute`). Behind `REASON_WEB` like the rest.

## At volume (handoff v2 sheet 2A/2B/2C, PR v2-ongoing)

- **Counts.** Every group heading `NEEDS YOU · 2` / `IN HAND · 9` / `BACK TO YOU · 6`; page line
  `17 THINGS · 2 NEED YOU` (`countLine`).
- **Top 3 per group.** IN HAND (soonest due) and BACK TO YOU (newest) show 3, then serif italic
  "See all N →" (`.og-more`) → `/web/ongoing/hand` | `/web/ongoing/back`. NEEDS YOU is never cut:
  the first approval on its card, the rest as `APPROVE` rows (+ `ASKED <when>` on the phone).
- **Volume switch.** A group past 3 → every row is the quiet `vRow` (`.ogv`: title clamps at 2 lines,
  status `white-space:nowrap`), the margin's card is 2C's (`.og-vc.m`, the card is the link), scheduled
  rows say `Mon 9:00` (phone, serif) / `MON` (margin, typed); ≥6 days out the date. Fewer → the
  ongoing-mobile rows (checklists, Caveat lines) as before.
- **Meta lines** (`item.meta`, src/ongoing.js `whenWord`): working `2 OF 3` + `WORKING · STARTED 2:55 PM`
  (no steps: `STARTED YESTERDAY`), `WORKING · CALLING NOW` while `db.taskCallLive` (a calls row with
  this `task_id`, placing/ringing/in_progress, < 2 h old); waiting `ON THE STORE · SINCE TUE`
  (`sheet.waiting[0].since`); stuck `SINCE <blocked.at>`; series `EVERY MONDAY`; timer `ONCE`; done
  `DONE · <when>`, failed `STOPPED · <when>`; approval `ASKED <when>`.
- **See all (2B)** `renderSeeAll`: ← ONGOING, `In hand` / `Back to you`, `9 THINGS · NEWEST FIRST`,
  filter links `ALL 9 · WORKING 4 · WAITING 3 · [STUCK n ·] SCHEDULED 2` (`?f=`; only kinds with rows;
  unknown → ALL), every row with its meta. Newest = `started` (task/series `created_at`, timer
  `created_at` — column added by this PR, NULL for older timers → sorted last). Empty group → 303
  `/web?tab=ongoing`. Async (lazy-imports webconvo for the tab bar), http.js awaits it.
- **Home (SR7).** The approval card stays on paper; ALREADY IN HAND = top 3 `vRow`s in
  `.home-l` (dashed rule above and below, dashed between), then "See all N →" to the tab.

## Live, no reload (owner 10-26 D5) + overdue sort (D6)

- **D6.** `src/ongoing.js` rank: needs-you first, then soonest *upcoming*; a waiting check whose time
  already passed sorts after upcoming rows (pinned: web-ongoing2 1b).
- **D5 desktop.** The thread boots with `REASON_WEB.ogv` (`ogVersion(ogMargin(model))`); `ogLook()` asks
  `/web/ongoing/state?draw=margin&v=<tag>` beside every poll, stream message/typing/state event and every
  15 s; html comes back only when the tag changed; swapped in place (never while focus is inside), the
  rail `ONGOING · N` and the tab badge recounted. HIDE is delegated so a redrawn margin keeps working.
- **D5 phone tab.** `renderOngoing` draws `ogTabMain(model)` + `REASON_OG.v`; `OG_TAB_LIVE_JS` asks
  `?draw=tab&v=` every 15 s / on visibility, swaps `<main>` (never under focus), recounts the badge.
- Without `draw`, `/web/ongoing/state` is the old `{ok,count,needs}` (9D's sign-out check).
- Drive: `bin/web-ongoing-live-drive.mjs` (caged env, temp DB, headless Chromium): adds a timer while
  the thread (1280) and the tab (390) are open; both follow within ~15 s, same URL, HIDE still works,
  0 page errors. Tests: web-ongoing 11 (margin) and 12 (tab).

## Sub-features

- **Groups.** NEEDS YOU = unanswered `confirmations` from the last 24 h (paper card, NOTHING
  CHARGED/BOOKED YET, "Review details →", Caveat "or just reply in the chat" on the tab) +
  `waiting_on_you` tasks. IN HAND = running (WORKING), waiting/waiting_on_other (WAITING, "On X: for.
  Asked <day>, <time>."), blocked (STUCK), one-off timers (time + date), active series (time + EVERY
  MON). BACK TO YOU = tasks `done` (READY) / `failed` (DIDN'T WORK in pen + Caveat why + next) whose
  `finished_at` is within 72 h (`BACK_WINDOW_MS`). Heading line `N THINGS · N NEEDS YOU`.
- **Steps.** `sheet.steps` (src/sheet.js; `task_update` sheet) `[{id,text,state todo|doing|done,live}]`,
  one `doing` max, code stamps `at` when a step is first done. No steps on the sheet → the progress
  log lines (done, with their times) + `sheet.left` (not started); no "N OF M" from that fallback.
- **Results.** `task_finish.result` → `tasks.result_json` via `resultFor`: done `{headline, facts[],
  note}`, failed `{why, next}`. Old rows: done shows `outcome`; failed falls back to
  `furthest.because` / `blocked.what` / `outcome`, next to `furthest.one_action`.
- **Approval detail** `/web/ongoing/approval/<id>`: receipt with ONLY the record's fields — a
  purchase_confirm reads its AgentCard row (`confirmation_id`, else the `[hash] in buy` target pin):
  SHOP, ITEM(S), SHIPS TO (city/state/zip), DELIVERY (offer), HOLD UP TO (ceiling), TOTAL; a flight
  row FLIGHT/DATE/AIRLINE/TRAVELERS; anything else WHAT, TO (calls/texts/emails), TOTAL from
  `confirmations.amount_cents` (new; written from confirm_request's `amount`). ASKED always. No approve button.
- **D2 (owner 10-26): never a Face ID promise.** A money ask (detail `.after p.q` AND the chat's
  `approvalCard` `.appr-q`, under the unchanged nudge) says "Nothing is charged until you say so in the
  chat." (`NOTHING_CHARGED`, webkit.js); a no-money ask says neither. Why: AgentCard decides at the
  confirm (after the yes) whether to pause for the passkey (`vault_approval_required` + `approval_url`;
  docs: a confirm MAY pause, auto-approval exists) and the unlock may be Touch ID/fingerprint/password.
  The real pause is kept on `agentcard_purchases` (awaiting_approval, authorization_id,
  approval_expires_at) once it happens. Pinned: test/web-ongoing.test.js 7 + 13.
- **Details** `/web/ongoing/{task|timer|series}/<id>`: 2A steps with done times + NOTHING BOOKED YET
  (only if no consumed confirmation on the task); 2B ASKED/FOR + "i'll check again <day>." from the
  next check; 2C huge time + AM/PM, EVERY MONDAY, description, NEXT · date (one-off: the date);
  2D result card + DONE stamp; 2E why + WHAT HAPPENS NEXT + NOTHING CHARGED (only if no AgentCard
  order/charge in the task's window).
- **9D.** `window.reasonMidTask` redraws `main` as "Still working on it. Sign back in to see." with the
  first `[data-flight]` row's status + title, faded — read off the page, never fetched. Called by the
  thread's `expired()` (poll 401) and by `OG_POLL_JS` on the tab/detail pages (`/web/ongoing/state`
  every 60 s → 401). Nothing in flight → `/web?out=1` (6F).
- **Mobile nudge.** `needsYes`: Caveat "the <merchant> order needs a yes →" above the composer, to
  the approval detail; hidden ≥900px.

- **"… in the chat →" makes Reason speak first (owner 10-27 01:20; replaced the composer draft).** Every
  detail's foot link is `/web?thread&about=<kind>:<id>&k=<click id>` (`talkHref`; a fresh k per detail
  page; a Web-chat approval, or a detail opened from a Web chat via sessionStorage `reason-web-chat`,
  goes to `/web?chat=<id>&…`). The thread's script POSTs `/web/about` once and drops the params;
  `aboutRequest` (src/pages/webconvo.js) checks origin + CSRF, finds the row in the session's own
  conversation (else 404), claims `<conv>:about:<kind>:<id>:<k>` (db.claimInbound, so a refresh or a
  double tap is one message), then runs ONE `runtime.event` on channel web with
  `speakFirstPrompt(itemRecord(...))` (src/ongoing.js): the row's full record, per-state real moves,
  approval ends on APPROVAL_NUDGE, never words to type. The reply lands in the shared thread or that
  Web chat; never texted. The event runs `fromOwner: true` (#213), so the first line is written to
  `messages` for EVERY account, not only the operator's (before, a non-owner's never reached history).
- **Scheduled description.** `blurb` (tasks/timers/series), written by the same summarise as `label`
  (src/itemtitle.js `line`); else `plainNote` → `tidyLine` (src/ongoing.js): no (asides), no @handles, no shouting caps,
  brand casing (GitHub, iMessage…). A row that already has a `label` but no `blurb` (the model titled it
  through a tool, or it predates #211) asks for its description alone when the detail draws it:
  src/ongoing.js `describe` → `queueBlurb` (src/itemtitle.js) → `db.setItemBlurb`, which writes only `blurb`.
  Backfill: `scripts/backfill-blurbs.js [--write]` (claude-cli only, `blurb` only where empty). Prove it
  on a copy first: on the box, `sqlite3 -readonly …/reason.db ".backup /tmp/blurbs-copy.db"`, then run with
  `REASON_DB_PATH=/tmp/blurbs-copy.db REASON_DATA_DIR=/tmp/blurbs-data` from a scratch copy of the branch.
  The Mac can't open a live copy, because the DB's token migration needs REASON_TOKEN_KEY. Then
  ATTACH the live DB read-only and diff label/note/time: expect 0. Tests: `test/web-blurb-backfill.test.js`.

## How to get to it (user POV)

Phone: the Ongoing tab (`/web?tab=ongoing`), tap a row. Desktop: the right margin; "See all N →".
From the chat: the approval card's "Review details →", or the pen "needs a yes →" line.

## Driving it with the harness

- `node --test test/web-ongoing-volume.test.js` — volume 2A/2B/2C, meta lines, See all routes
  (through the real server), home rows, timers.created_at.
- `node --test test/web-ongoing.test.js test/web-ongoing2.test.js` — every group/state/detail,
  plumbing, cross-account 404s, 9D markup (seed: `test/fixture-ongoing.js`).
- `node --test test/web-speakfirst.test.js` — speak-first: link + click id, one post per click, record
  + rules in the turn, lands in thread/chat, cross-account/forged refused, clean description.
- `node .agents/skills/verify-reason/bin/web-talkdraft-preview.mjs` — detail → thread with Reason's first
  line (sample words; the live words are the model's) into reason-web-design-previews/v2.
- `node .agents/skills/verify-reason/bin/web-ongoing-preview.mjs` — ongoing-<state>-<390|1280>-
  <paper|night>.png + compare-ongoing-<state>.png into ~/Desktop/reason-web-design-previews.
- Live (Hetzner only, read-only): temporary owner `page_sessions` row (conversation `dm:owner`),
  `curl -b reason_page=<tok> https://heyreason.com/web?tab=ongoing` and each
  `/web/ongoing/<kind>/<id>` the owner really has, `/web/ongoing/hand` and `/web/ongoing/back` (?f=…); `/web/ongoing/state` → `{count, needs}`; another
  id → 404. DELETE the session row after. A kind with no real row: make a far-future timer on
  `dm:owner` (fire_at years out), fetch it, then `UPDATE timers SET cancelled_at=…` / delete it.

## Gotchas

- Apostrophes are escaped (`DIDN&#39;T WORK`) — grep for the entity.
- `.st`, `.g`, `.t` are taken by the thread's CSS: Ongoing's own classes are `og-*`.
- A series' pending firing is a timer row with `series_id`; it is drawn once, as the series.
- Approvals older than 24 h drop off (same window as the chat's card) even if still open.
- "2 OF 3" = the step in hand (done + 1 when one is `doing`), matching the reference.
