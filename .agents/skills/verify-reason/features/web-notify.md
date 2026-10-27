# Reason Web — notifications (8A–8C) and Web icons (I1)

Handoff v2 §4c item 8 (reference sheet-notify-{paper,night}.html) and §4e. Source:
`src/pages/webnotify.js` (signal, client script `NOTIFY_JS`, icon links + files), `src/pages/webkit.js`
(every `webPage` carries the icons and the script), `src/pages/websignin.js` (`sub === "signal"`
answered before the session is touched; `webSignedIn` gives Ongoing detail pages `data-c`),
`src/pages/websettings.js` (8C section, `do=notify`), `src/db.js` (`pageSessionPeek`,
`page_sessions.web_notify`, `pageSessionNotify`, `setPageSessionNotify`), `assets/web/*`.

## Sub-features and how each is proved

- **GET /web/signal** — signed in only (401 otherwise, JSON, no-store). `{ needs: [{id, approval,
  line, href}], done: [{id, title, at}] (newest 3 finished in 72 h, short title ≤40), notify }`.
  Read with `pageSessionPeek`: never touches `last_seen_at`, so a background tab still idles out.
- **8A tab** (v4 §4h item 5 since PR 4h-motion; replaces the old "(N) Reason needs you" / "Done · …"
  titles) — script runs only when `<html data-c>` (signed in). Polls 4 s hidden / 12 s visible and on
  visibilitychange. While `needs` is non-empty (hidden or visible): title exactly "Reason · needs you"
  (`NEEDS_TITLE`) and every `link[rel=icon]` set to the needs-you mark; empty → the page's own title and
  the outlined mark. The mark is the night one on Night: `<html data-theme>` (the theme chosen on Web)
  first, else `prefers-color-scheme`; a theme switch fires `reason-theme` and the icon follows at once.
  A finished job no longer touches the tab (`done` is still in /web/signal, unused). No sound.
- **8B line** — on any page but /web (the chat shows approvals itself): the first need not yet
  seen (localStorage `reason-web-seen`), as a `role=status` Caveat line + "See it →" inserted at the
  top of `main`. Seen = clicked, opened its page, or opened the chat. Gone when answered.
- **8C browser notifications** — per browser (`page_sessions.web_notify`), off by default. "Turn on
  in this browser →" drawn only with script and `Notification`; it asks `Notification.requestPermission()`
  first and saves only on "granted" (JSON POST `do=notify&on=1`). Turn off = plain form. When on and
  the tab hidden, a new approval shows one notification `Reason` / "Reason needs your approval."
  (tag `reason-needs-you`, silent), once per approval (localStorage `reason-web-notified`). No
  "private by default" line (K2).
- **I1 icons** — `/web/icons/{favicon,favicon-night,favicon-needs-you,favicon-night-needs-you}.svg`
  and `apple-touch-icon.png` (180×180, exported from the handoff svg), the handoff's files as given, in the brand pen
  (#9c3b2e / #d46a5c, src/pages/brand.js since #190), fingerprinted `?v=WEB_ICON_VERSION`. Reason pages (files.) keep `/favicon.svg`.

## Drive

```bash
node --test test/web-notify.test.js        # 14 tests: signal, 8A (§4h 5)/8B/8C in a vm pretend-browser, icons over HTTP
eval "$(bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/s.db node bin/web-settings-drive.mjs
```

Live proof: with a throwaway owner session, GET `https://heyreason.com/web/signal` (200 JSON) and
`/web/icons/favicon-needs-you.svg`; turn 8C on for the throwaway session only, then delete the row.
