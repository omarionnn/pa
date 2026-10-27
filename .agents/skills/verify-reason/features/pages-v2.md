# Pages Reason makes, v2 (HELD behind `REASON_PAGES_V2`)

The pages Reason makes, redrawn as the 2026-10-27 handoff (§4 "Pages Reason makes", reference
`sheet-pages-*` P1–P6, `sheet-pages-desk-*` PD1–PD6, `sheet-edge-*` E2–E4, `preview-private`,
`preview-event`). **Held for the owner**: with `REASON_PAGES_V2` unset (live) every page, event and
album draws exactly as before and the new blocks are refused. Branch `wt/v2-pages`, never merged
without Omari's go.

Source: `src/pages/made.js` (frame + P1–P6 + E2–E4 + the two og cards, view models in, HTML out),
`src/pages/madedata.js` (rows → view models, E3/E4, LP2 tags + PNG), `src/pages/content.js` (blocks
`day`, `call`, `receipt`; cards `facts`/`at`/`pick`/`opinion`), `src/http.js` (`/p/{id}/audio`,
`/p/{id}/signout`, form picks, E3/E4, `/fonts/*`, `/og/private.png`), `src/pages/event.js` (P4,
`calendar.ics`, E2), `src/pages/album.js` (P5, E2), `src/eventcover.js` (LP3 `v2Card`), `src/db.js`
(`pages.state`/`archived_at`, `archivePage`, `restorePage`, `agentcardPurchaseById`).

## Sub-features and how to prove them
- **P1 shortlist**: a page of one cards block (2–3, one `pick` with `opinion`) + the choice of those
  cards. Pick first, facts as leaders, Caveat line, desk margin note; "Pick this one →" posts (form,
  no script) → 303 → "SENT TO REASON". **P2 day**, **P3 call** (only this conversation's call;
  length, "RECORDED, AND THEY KNEW" and point 01 read off `calls.announcement`; audio only to its
  owner), **P6 receipt** (only a `placed` purchase; card last4, approval time from the
  confirmation, confirmation id; never "Face ID").
- **E3**: a browser signed in as somebody else (no key) → 403 "for someone else" with only its own
  masked number; identical for a ghost id. **E4**: owner of an archived page → "Find it in Saved →".
  Strangers get the same gate as before.
- **LP2**: every private page's og = "A page Reason made for you" + `/og/private.png`.
  **LP3**: an event's drawn card carries only public facts. **E2**: cancelled event / closed album.

Drive: `node --test test/pages-v2.test.js` (11 pinned). Pictures: `node scripts/pages-v2-preview.mjs
<dir>` (sample data, throwaway DB, real routes) then `node scripts/pages-v2-compare.mjs
<handoff>/reference <dir> <dir>`.
