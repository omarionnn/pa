# Reason Web §4h small details — the plumbing three (while you were out, take it back, working line counts)

Handoff v4 (`~/Desktop/reason-web-handoff-v4-2026-10-27/reason-web-handoff/`) HANDOFF.md §4h items 1, 4, 6 +
`reference/sheet-small-details.html` (Paper + Night rows). Pinned in `test/web-4h-plumbing.test.js`.

Source: `src/db.js` (`page_sessions.web_seen_at / web_away_from / web_away_to`, `inbound_messages.cancelled_at`;
`webVisit`, `takeWebAway`, `cancelHeldInbound`, `inboundCancelled`), `src/pages/websignin.js` (`WEB_AWAY_MS`,
`isVisit`, route `send/cancel`), `src/channels/router.js` `takeBack`, `src/pages/webconvo.js` (`awayWords`,
`awayFor`, `withAway`, `cancelRequest`, `TAKE_BACK_MS`, page script `takeBack`/`awayIn`), `src/doing.js`
`counter`, `src/media.js` `pdfsFor({ onRead })`, `src/docread.js` `docsFor({ onRead })`,
`src/backends/claude-cli.js` + `src/agent.js` (wire the counter), `src/pages/webcompose.js` `R.doing` (label throttle).

## What a person sees

- **While you were out (1).** A signed-in page GET (`/web`, memory, settings, saved, Ongoing pages) is a visit by this browser;
  a Web send is presence (moves last-seen, never starts a return); stream/polls are neither. A visit ≥3 h after the last starts a return; the next shared-thread view
  (`/web?thread`, or `/web` opening on the thread) shows ONE Caveat pen line under `TODAY`
  ("while you were out: 2 done, 1 needs you." — zero parts left out; "2 need you" plural), and spends it.
  Counts: Ongoing's BACK TO YOU `ready` tasks finished in [last visit, return], plus needs-you tasks whose
  question was asked in it and approvals asked in it (still open). Nothing changed → no line. A refresh is the
  next visit → gone. Landing on Home first: the line waits for the thread (spent there, dropped if the return
  is >3 h old). A browser's first-ever visit has no line. No TODAY yet → a TODAY label of its own at the end.
- **Take it back (4).** The send is NOT held (owner: instant). For 5 s after a send, and only until Reason's
  own copy of the line arrives (the turn took it), a Caveat "take it back" `<button>` (44 px) under the
  message with a 1 px pen line `scaleX(1→0)`, `transform-origin:left`, 5 s linear. Tap → `POST /web/send/cancel`
  (same-origin + csrf). Won → "taken back. nothing sent." for 2 s, line removed, no turn, no history row.
  Too late → 409 `too_late`, control gone, `SENT · time`. Reduced motion: same window, no line.
  In practice the window is the burst quiet (`REASON_BURST_QUIET_MS`, live default 4 s).
- **Working line counts (6).** Only from a real loop: a turn handed 2+ PDFs/documents shows
  "reading the lease… 2 of 3 files" as each is read (pdfsFor then docsFor), then back to the turn's own line.
  A single PDF has NO page count: pdftotext/PDFKit return all pages in one call (`src/pdf.js`). No
  multi-place call loop exists, so no "2 of 3 places". The `role=status` label = "Reason is reading the lease,
  2 of 3 files", changed at most every 3 s.

## Race-safety (take it back)

The one transition is the `pending_inbound` row's DELETE: the turn starts by deleting held rows
(`takePendingInbound` / `takePendingByHandle`), cancel deletes the same row; synchronous, in one IMMEDIATE
transaction → exactly one wins. `cancelled_at` is written only with a won delete (idempotent second tap).
A cancel that lands before Router.deliver's claim (send still in flight) inserts the claim row as cancelled,
so the claim finds a duplicate; a tap whose send has not reached the server yet waits up to 1.5 s for it
(`CANCEL_WAIT_MS`). Claimed but not yet held (deliver awaiting a read receipt): `Router.preHold` lets the take-back
win and deliver drops it right before `holdInbound` (synchronous check). Keys are `<session conversation>:<browser id>`: another person's id is 404.

## Drive it

- Offline: `env -i PATH=$PATH HOME=$HOME node --test test/web-4h-plumbing.test.js` (19).
- Staging: `npm run web:staging` → `take-it-back.html`, `taken-back.html`, `while-you-were-out.html`, `working-counts.html`.
- Live (Hetzner): throwaway account + short-lived page_session row; set its `web_seen_at` 4 h back and finish a
  throwaway task, then GET `/web?thread` (line once, gone on refresh). Take-back: POST /web/send then
  /web/send/cancel within the burst window → `{cancelled:true}`, no `messages` row; after the turn → 409.
  Counts: a Web send with 2+ uploaded PDFs; `/web/stream` `doing` events carry "… N of M files".
