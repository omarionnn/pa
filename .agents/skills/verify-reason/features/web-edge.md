# Reason Web — sign-in fixes, loading, edge screens, keyboard focus (v2-edge)

v2 handoff (`~/Desktop/reason-web-handoff-v2-2026-10-26/reason-web-handoff/`) rows SR8, SR9,
desk-sign-in / sheet-signed-out, L3–L7, E1, E5, F1. Code: `src/pages/webkit.js` (focus CSS, skip
link `skipTo`, `textReason` + `TEXT_HINT`, loading kit included on every page),
`src/pages/webloading.js` (L3–L5 client + CSS), `src/pages/websignin.js` (body=hey, join block order,
wrong-code digits, L6/L7), `src/pages/webedge.js` (E1, E5, the maintenance switch),
`scripts/web-maintenance.mjs` (CLI), `src/http.js` (E5 gate before every /web route, E1 fallthrough,
/ops actions `web_maint_on|off`), `src/pages/ops.js` (`webSection`).

## Sub-features

- **SR8 Text Reason →.** Every one on Web is `sms:<live line>&body=hey` (lowercase) with the typed
  hint `OPENS MESSAGES WITH “HEY” READY TO SEND` under it (`textReason`). Desktop sign-in: QR card
  first, then "or Text Reason →" (28px). 6D (`/web?join=1`): Text Reason → + hint, QR, Caveat. E5 too.
  The number is never written on the page; the QR encodes the same link.
- **SR9 code errors.** Wrong or expired: the typed code stays in the six cells (`value=`, digits
  only), every underline pen, `aria-invalid` + `aria-describedby="code-note"` on the Caveat alert;
  focusing selects it so typing replaces it. No ring on the digits (input line rule).
- **L6/L7.** On submit (after the event, so data has gone): "Text me a code →" becomes the muted
  status span "Texting you a code…", the number readOnly/muted, a second submit is swallowed; the code
  form keeps its digits and shows `CHECKING…` (role=status) in place of the note.
- **L3/L4/L5.** Clicking the Ongoing tab, a row's detail (`/web/ongoing/<kind>/<id>`), `/web/saved`,
  or any `a[data-load]` draws the loading screen at once from what the page knows (Ongoing: the
  `#og` group headings + counts → ghost card for approvals, ghost rows; detail: the row's status +
  title), pushes the address, FETCHES the real page, and swaps it in (title, style, body, script).
  >8 s: `STILL LOOKING…` + Caveat + "Try again →" (refetch) / BACK TO CHAT. Fetch fails: 9B drawn in
  place. Redirect (signed out) → the browser follows. Back/forward: the server's page
  (`location.replace`). Ruled lines `var(--hair)`, 1.6 s opacity fade, none under reduced motion.
- **E1.** Any other `/web/...` GET: 404 torn slip, "This page isn’t here. Nothing’s lost.",
  "Back to the thread →" only when the session is good, `OR GO TO HEYREASON.COM` (the host of
  `REASON_SITE_URL`; unset — a cage with no `.env` — the line is not drawn, src/pages/webedge.js:96-101).
  A gone Ongoing row is the same page.
- **E5.** `ops_state` key `web:maintenance` = `{until, by, at}`; lapses at `until` (≤ 24 h ahead).
  While on, every `/web` path answers 503 + Retry-After (JSON `{error:"maintenance"}` for
  `Accept: application/json`), fonts excepted; `BACK BY ABOUT {h:mm AM} ET`, Text Reason → + hint
  when a line is live. Set from /ops (section "Reason Web": time HH:MM Eastern or minutes, "Open Web
  again") or `scripts/web-maintenance.mjs on 15:30|45 / off / status`. Never .env.
- **F1.** `:focus-visible` 2px ink outline 3px out, 3px corners; cards 4px out; `.danger/.fg-go/
  .every/.ff` ring in pen; text inputs no ring, caret pen (the composer's rule goes 1→2px); `.ic` and
  the menu round, send square; skip link first in `<body>` — thread pages `SKIP TO THE THREAD ↓` to a
  mark at the top of the composer (one Tab to the composer), others `SKIP TO CONTENT ↓`.

## Drive it

```bash
node --test test/web-edge.test.js test/web-edge-browser.test.js   # 12 + 9, all ok (Chromium)
node scripts/web-maintenance.mjs status                            # on the box: sudo -u reason node --env-file=.env …
```

On a cage (no model, 2026-11-14): under `caged.sh env`, a throwaway account whose conversation id is
`dm:<channel>:<number>` (any other id makes every signed-in /web GET 500: sign-in re-admits the account
under that id and hits `UNIQUE(channel, address)`), a `startPageSession` row as the cookie; then
`/web/nope` → 404 + Back to the thread (signed out: no back link); `run(["on","20"])` from
`scripts/web-maintenance.mjs` against the cage DB → `/web` 503 + `Retry-After: 1200` + BACK BY ABOUT …
ET, `Accept: application/json` → `{"ok":false,"error":"maintenance",…}`; `run(["off"])` → 200 at once
(the server reads `ops_state` per request). Evidence `*-g7-web-edge-daily`.

Live proof (the live server (OVH, root@15.204.113.250) only, owner session row made and deleted): `GET https://heyreason.com/web/nope`
→ 404 E1 with Back to the thread; `/web?tab=ongoing` click from the thread shows L3 then the real
tab; maintenance on for one fetch (503, BACK BY ABOUT) then off at once.
