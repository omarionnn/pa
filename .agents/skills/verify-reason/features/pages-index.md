# Your pages — the wordmark on a page Reason made (2026-11-01)

Owner ask: tapping the top-left wordmark on any page Reason made (files.heyreason.com) goes to a list
of all their pages, with search. The list is Reason Web's Saved, pages only:
`https://heyreason.com/web/saved?kind=pages` (heading "Your pages").

Source: `src/pages/wordmark.js` (`yourPagesHref`, `homeLink`), `src/pages/render.js` (`shell({ home })`,
set by `renderPage` except printed), `src/pages/made.js` + `madedata.js` (v2 pages, `vm.home`),
`src/pages/websignin.js` (`NEXT_COOKIE`, `safeNext`: signed out → `/web`, sign-in lands back on the
remembered Saved path; only `/web/saved…` paths are ever kept or followed), `src/saved.js` (`pageType`:
`PAGE · SHORTLIST|DAY PLAN|CALL NOTES|RECEIPT`; archived pages listed as `PAGE · ARCHIVED`),
`src/pages/websaved.js` ("Your pages" heading/title/empty state when `kind=pages`).

Rules: the link is the same for everybody and names no page or person; the list is the session's own
conversation only; a stranger following it gets a sign-in or their own list. Not on paper / Saved's
read-only frame / gates / not-found / event pages.

Verify: `node --test test/pages-index.test.js` (9) and, under `caged.sh env`,
`REASON_DB_PATH=$(mktemp -d)/pidx.db node bin/pages-index-drive.mjs [--shots=DIR]` (20 steps: real HTTP
+ Chromium — owner taps the wordmark, list/order/type/archived, search by text and title, phone width,
stranger signed out → sign in → own list only, empty state).
