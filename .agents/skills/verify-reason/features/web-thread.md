# Reason Web — the thread's scrolling, labels and loading (v2)

Handoff v2 (`~/Desktop/Project files/Reason/handoffs/reason-web-handoff-v2-2026-10-26/reason-web-handoff/`) §4b Prototype S2 + S3
(`prototypes/ProtoS23*.dc.html`), §4d L1 / L2 / L10 (`reference/sheet-loading-app-*`,
`sheet-loading-actions-*`), staging review SR4. SCOPE-v2 rows SR4, SC1–SC3, L1, L2, L10.

Source: `src/settle.js` (devices, the note's words, which messages belong to a task, the DONE line,
long work), `src/pages/webconvo.js` (`rowOut` day/where, `listHtml`/`pageHtml`/`doneHtml`,
`renderConversation({ deferred })`, `WHERE_NOTE`, `TODAY_SLOT`, `longWorkHtml`/`workOf`,
`historyRequest` html/first/last/work/settled, `settledLately`, the stream's `state` event, the
page script), `src/runtime.js` `_turn` (links the turn's texts + outbox rows to every task it worked
on), `src/tools.js` `runTool` (`ctx.turnTasks` from task_start / task_update / task_finish),
`src/pages/webcompose.js` `composerHtml({ slot })` (the TODAY ↓ hook), tables `task_messages` and
`web_devices` in `src/db.js` (both in `src/data.js` export/delete).

## What a person sees

- **Opens at the bottom.** With script, `/web?thread` paints the top bar, composer and tabs at once
  with **L1** (`OPENING YOUR THREAD…` + three ghost messages in ruled hairlines) and fetches the newest
  page from `/web/history` (drawn server-side: day labels, "Continued on Web", DONE lines). Over 8 s or
  failed: `STILL LOOKING…` + Caveat "taking a little longer than usual. still here." + "Try again →".
  Without script the same thread is in `<noscript>`.
- **Where you are (S2).** Top right of the sticky bar, Caveat pen −2°: "today, on your laptop",
  "yesterday, on your phone", "tuesday, …", "last week", "two/three weeks ago", "in september". The
  message/day nearest 90 px under the bar sets it; the very bottom = the latest. Two slots crossfade
  (0.5 s opacity, 0.6 s transform, cubic-bezier(.2,.8,.2,1), 10 px); `role=status aria-live=polite`
  with the note as label. Device: a text = phone; a Web message = the sending browser's User-Agent
  class kept at send time (`web_devices`; phone / tablet / computer → "laptop"); Reason's Web line =
  the device it answered; unknown = "on the web".
- **TODAY ↓ (SC3).** Scrolled into an earlier day, a typed `TODAY ↓` shows inside the composer line
  (before the mic) and the placeholder becomes "Reply from here"; it scrolls back (instant under
  reduced motion). 40 px between messages, 52 px above each day.
- **Done things settle (S3).** A `done` task's messages fold into one line at its last message:
  `DONE` stamp, title (result headline, else short title), meta (`JUST NOW · $540 · WEB` within 15 min,
  else `TUE · IMESSAGE · 9:20 AM`, past a week `OCT 12 · IMESSAGE`), `N ↓` / `FOLD ↑` on a
  `<button aria-expanded>`; open = the messages quoted, muted, thin left rule. Just finished: Caveat
  "just wrapped this one up. tap to see how." until opened (remembered in localStorage). A message that
  also belongs to an open task never folds. Which messages: written by `_turn` at the end of any turn
  that ran task_start / task_update / task_finish or was the task's wake — its texts by handle and its
  outbox rows; nothing from before this shipped is linked (no backfill), so old threads show no DONE
  lines until new tasks finish. A task finishing while the page is open settles in place via the
  stream's `state` event (poll fallback: `settled` in `/web/history?after=`).
- **L2.** "↑ SHOW EARLIER MESSAGES" → `↑ FINDING EARLIER MESSAGES…` + a ghost + dashed rule; the page
  arrives drawn above without moving what you were reading; one label per day.
- **L10.** While Reason works (`running`) on a task their latest message belongs to: the ring +
  "on it. <the doing step's live words>." (else "on it.") + "This one takes a few minutes. You can close
  this; it's in Ongoing, and I'll text you." (results kept on Web: "…and the result will be here.").
  Hidden while the turn's own "on it." shows.
- **SR4.** Every label is who · where · when; the chat's approval card is `REASON · IMESSAGE · 2:40 PM`
  over the card (never `REASON · WAITING ON YOU`).

## Drive it here

- `node --test test/web-thread.test.js test/web-thread-browser.test.js` (14 unit/HTTP + 6 Chromium).
- `node .agents/skills/verify-reason/bin/web-thread-preview.mjs [outDir] [refDir]` — seeds a throwaway
  DB shaped like ProtoS23, serves it on loopback, drives the page in Chromium (note, TODAY ↓, DONE,
  L1, L2, L10) printing ok/FAIL, and writes `thread-*-<390|1280>-<paper|night>.png` +
  `compare-thread-<l1|l2|l10>.png` beside the reference boards. Nothing sent, no model. The script's
  default `refDir` is now `~/Desktop/Project files/Reason/handoffs/reason-web-handoff-v2-2026-10-26/reason-web-handoff/reference`
  (bin/web-thread-preview.mjs:17), so no `refDir` is needed: run with only `outDir` under `caged.sh env` and a
  temp `REASON_DB_PATH` → 32 ok, "all ok", three compare PNGs (2026-11-07).

## Live proof

From Hetzner with a temporary owner `page_sessions` row (delete it after): GET `/web?thread` shows
`OPENING YOUR THREAD…` + `class="where"`; GET `/web/history` returns `html` with `data-where`, and
`work`; headless Chromium on the box with the cookie screenshots the opened thread.
