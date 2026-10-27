# Pages Reason makes, v2 (`REASON_PAGES_V2`, LIVE since 2026-10-27)

The pages Reason makes, redrawn as the 2026-10-27 handoff (§4 "Pages Reason makes", reference
`sheet-pages-*` P1–P6, `sheet-pages-desk-*` PD1–PD6, `sheet-edge-*` E2–E4, `preview-private`,
`preview-event`). **Live**: #196 merged as `dd4299c`, `REASON_PAGES_V2=1` on Hetzner since 2026-10-27
(rollback `.env.bak-pagesv2`). With the flag unset (the cage's default, and this worktree's) every
page, event and album draws exactly as before and the new blocks are refused — start the cage with
`REASON_PAGES_V2=1` to drive v2. Read-only live proof: `/og/private.png` and `/fonts/serif.woff2` on
`files.heyreason.com` answer 200 only when the flag is on (`config.pagesV2` guard in `src/http.js`).

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
  masked number; identical for a ghost id except the echoed id in the sign-out form's `action`
  (driven 2026-10-27). **E4**: owner of an archived page → "Find it in Saved →".
  Strangers get the same gate as before.
- **LP2**: every private page's og = "A page Reason made for you" + `/og/private.png`.
  **LP3**: an event's drawn card carries only public facts. **E2**: cancelled event / closed album.

Drive: `node --test test/pages-v2.test.js` (13 pinned). Pictures: `node scripts/pages-v2-preview.mjs
<dir>` (sample data, throwaway DB, real routes) then `node scripts/pages-v2-compare.mjs
<handoff>/reference <dir> <dir>`.

## Print (§4h item 8, `src/pages/print.js`)
One `@media print` sheet (`PRINT_CSS`), appended LAST in `<style>` by `made.js` `madeDoc`/`edgeDoc`
and `render.js` `shell()` — so every page kind (shortlist, day, call, event, album, receipt, the
ordinary page, older event/album pages) prints the same way: white, Paper ink `#2a2520`, stamps in
pen `#9c3b2e`, Night tokens overridden with `!important`, no header/wordmark bar, theme switch,
`.acts`/`.typed`/forms/player/Back to Reason (`.b2r`), no shadows, no grain, `break-inside:avoid`
on cards. `<p class="print-url">` (hidden on screen) is the canonical KEYLESS address, schemeless,
at the foot (`pageUrl(id)`, `eventUrl(ev)`, `…/album`). Web (`webPage`) gets only `WEB_PRINT_CSS`
(Paper tokens + no grain), placed before the page CSS (Web tests forbid hex after `.mh{`).
Prove: `node --test test/pages-print.test.js`; pictures `node scripts/pages-v2-preview.mjs <dir>
--print` → `4h-print-<kind>-<paper|night>.{png,pdf}` (print-media screenshot + `page.pdf()`).
Live: fetch a real page with a short-lived owner session on Hetzner, `emulateMedia({media:"print"})`
+ `page.pdf()`; the foot must read `files.heyreason.com/<id>` with no `?k=`.

## Gotchas
- **A wrong-SHAPED id is a raw JSON 404**, not a drawn page: `/p/ab`, `/e/<not 16 chars>` miss every
  route regex and fall to `createServer`'s last line, `send(404, { error: "not found" })`
  (`src/http.js`, re-grep). Well-formed ids get the gate / E-pages as above. Cosmetic gap, not a
  privacy one (the shape alone was never secret); a styled 404 there is a product change.
