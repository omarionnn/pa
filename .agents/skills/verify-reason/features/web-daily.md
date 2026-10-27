# Reason Web — the daily edition Home (`/web?home`, REASON_WEB_DAILY)

Signed in, with `REASON_WEB_DAILY` allowing the session's conversation (`off | owner | on`,
`src/dailyflag.js`; `owner` = the operator only), `https://heyreason.com/web?home` (and the plain
`/web` arrival) is a morning paper instead of today's Home. Design: daily handoff 2026-10-27
(`~/Desktop/reason-daily-handoff-2026-10-27/reason-daily-handoff/`, HANDOFF.md §1, `reference/home.html`).
Off = today's Home exactly (composer and all).

Source: `src/daily.js` (window, facts, question, greeting, `writeEdition`, `sweepDaily`, tables
`daily_editions` / `daily_looks` / `daily_questions`), `src/pages/webdaily.js` (`renderDaily`, `dailyHead`),
`src/pages/webdailyroutes.js` (POST `/web/daily/answer|later`), `src/pages/webconvo.js`
(`conversationPage` → renderDaily; no new-chat entry anywhere: one shared thread, owner 10-27 07:08),
`src/pages/websignin.js` (`/web?newchat` → 303 `/web?thread`), `src/runtime.js` (`daily()` in the sweep),
`src/http.js` (route), `scripts/web-daily-sample.mjs` (staging samples).

## Sub-features

- **Masthead.** `NO. n · THE {WEEKDAY} EDITION` (n = editions written for them, never a streak; a live
  draw before today's is written shows count+1), H1 the full date in their zone, Caveat greeting, double rule.
- **Greeting.** Fixed: first edition (`first edition. it'll fill up as I do things for you.`), away >1 day
  (`welcome back. here's what happened since <Weekday>.`), quiet (`quiet night. nothing needed you.`).
  Otherwise written once overnight by `askStructuredViaCli` (feature `daily_edition`, claude-cli only,
  background lane) and cleaned (lowercase, ≤90 chars, no `!`/emoji/streak words), else the plain
  `morning, Ama. two things moved while you slept[, and one needs you].` Never a model on a request.
- **Window.** since = later of their last thread message and their last look at this page on an earlier day
  (`daily_looks`), floored at 14 days; never looked → the day before.
- **Overnight.** newest first, ≤5 then `N more in the thread`: approvals asked in the window (decision:
  a `/web/send` form, csrf + a fresh id, buttons `Yes, go ahead` / `Not now` as `text`, only when it is the one open
  approval; always the shared thread), tasks done (DONE stamp + result headline) / failed (update), Reason's own shared-thread lines
  not within 15 min of one of theirs (update → `/web?at=<id>`). First day: `Nothing yet. Text me something to start.`
  Never an operator notice (`messages.source = 'ops'`, set from the sender's outbox key `ops:`/`incident:`/`event-created:`)
  nor a row carrying a keyed `/ops` link; a message split round a link is one item headlined by its words, a link
  alone is named by its page/document/task or not listed (#225, `test/ops-key-leak.test.js`). No Web response but `/ops`
  itself ever carries the status page's key (`src/opsredact.js`) — on live, `curl` any /web page and grep for `ops?k=`.
- **Lines out.** open watches, armed timers, active series; status mono right, pen when due within a day;
  hidden when none.
- **One question today.** newest open guess not put off in 7 days; ≤1/day (`daily_questions`). Answer →
  `answerGuess` (fact `user_stated`, guess confirmed_said `Yes, that's right (Reason Web daily edition)`);
  Ask me later → `outcome='later'`. Both 303 → `/web?home`. Hidden when none.
- **New in your book.** `src/stamps.js newestStamp(conv,{days:7})` + `stampMarkup`, loaded when that file
  exists; hidden otherwise. STAMPS in the header only when it exists.
- **Pick up.** last two shared-thread lines; `pick up from iMessage`/`SMS`, or `pick up where you left off`
  when the last was Web; `Continue the thread →` → `/web?thread`.

## Drive

```bash
node --test test/web-daily.test.js     # 15 pinned (flag, states, overnight kinds, two approvals, question, sweep, DST, new chat)
node scripts/web-staging.mjs --out=/tmp/x/web-staging   # daily-full, -first, -quiet, -missed
```

## End state that proves it

Live, from Hetzner, flag `owner`: the journal shows `daily_edition` for the owner's conversation with
`greeting_by` `claude-cli` (or `fixed`/`plain` on a fixed moment) and the spend log `daily_edition`
feature; a temporary owner `page_sessions` row fetches `https://heyreason.com/web?home` → `THE … EDITION`,
no composer; the session row deleted. Never tap decision/question buttons on the owner's live data.
