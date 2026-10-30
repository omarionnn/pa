# Reason Web — Settings

Signed in, `https://heyreason.com/web/settings` (desktop: typed index left, one page right; phone:
one column, 8A then 8B). Every control is a plain form that posts to `POST /web/settings` with
`do=reach|theme|browser|everywhere|notify|invite|cancel-invite|store-remove|card-remove`, the session's form secret (`c`) and
Reason's own origin, and comes back 303 to `/web/settings?done=<what>#<section>` ("got it.",
role=status) or to an edit state. v2 edit states (handoff v2 §4c item 5, sheet-settings-edit 5A–5D),
each its own `← SETTINGS` screen: `?edit=reach` (5A), `?saved=reach` (5B), `?confirm=everywhere`
(5C), `?invite=<id>` (5D), `?edit=notify` (8C, see [web-notify.md](web-notify.md)). L8: every
action button has `data-busy` ("Saving…", "Signing out everywhere…", "Making a link…"), goes muted
and can't be pressed twice. The theme switch exists ONLY here (no footer/menu switch on /web). Behind
`REASON_WEB` like the rest of Web (`owner` on live).

Source: `src/pages/websettings.js` (page + POSTs), `src/pages/websignin.js` (`sub === "settings"`,
user agent noted in `sessionAccount`, `themedForAccount` on every signed-in page),
`src/pages/webkit.js` (`accountThemed`, head script follows `data-account-theme`, every theme
switch saves back), `src/deliver.js` (`keptOnWeb`), `src/db.js` (`accounts.web_reach`,
`accounts.web_theme`, `page_sessions.user_agent`, `pageSessionsFor`, `endPageSessionOf`).

## Sub-features and how each is proved

- **How Reason reaches you** — `web_reach`, four values (`db.WEB_REACH_VALUES`), shown as
  "Text me for *X*. Keep *Y* here.": `text` (NULL/unknown, default: *everything* / *a copy*), `web`
  (*timely decisions* / *routine results*), `yes` (*only what needs a yes* / *everything else*),
  `none` (*nothing* / *it all*). The two pre-v2 values kept their meaning (no migration). Each dashed
  phrase links to 5A (radio list of four, each with its line, Save → / CANCEL); Save → 5B (the new
  sentence + Caveat "got it…"). Delivery (`src/deliver.js keptOnWeb`): only a message Reason STARTED,
  words only, no `idempotencyKey` except a timer's (`timer:`), not `toMaster`, for a person Web may
  reach → `text` nothing kept · `web` a `done` task's result kept · `yes` all kept except while an
  approval asked in the last 15 min is unanswered (`asksForAYes`) · `none` all kept. Codes (wsign/
  pcode/esign), ops alerts, event messages, line change, replies, recordings: always texted. Log
  `kept_on_web` with `reach`.
- **Private by default** — NOT drawn (`PRIVATE_BY_DEFAULT = false`): approvals are asked in the
  text with their details today (SCOPE.md question).
- **Signed-in browsers** — every `page_sessions` row of this person still inside 90 d / 30 d idle;
  device from `user_agent` ("Chrome on Mac"); rows never used on Web since then (no user agent: Reason-page code sessions, /ops) are one quiet count ("And N other sign-ins that haven't opened Reason Web…"), ended by Sign out everywhere; last
  active (NOW / N MIN AGO / N HOURS AGO / OCT 19). SIGN OUT carries a hash of the token
  (`sessionHandle`), matched only among this person's rows. "Sign out everywhere" is a link to 5C
  (the real count: "3 browsers, including this one." / "1 browser: this one.", KEEP ME IN); its
  form deletes all of them and clears this cookie (→ `/web?out=1`).
- **Connected** — AgentCard (`agentcard_users.user_id` and `connectionState` not dead), Google,
  Spotify, Uber, GitHub, iCloud (`oauth_tokens` rows: google, spotify, uber, github,
  apple_calendar). Only connected ones are listed.
- **Shopping** — drawn only where `shop.connectAllowedFor` (`REASON_SHOP_CONNECT`, see
  [shop-connect.md](shop-connect.md)): each store they signed into + the card, each with REMOVE
  (`do=store-remove` with `s=<store>`, theirs only / `do=card-remove`) → "removed. i won't use it
  again." / "card removed." (`#shopping`). With it the index has seven sections, not six.
- **Invites** — shown only where `invitesOpenFor` (owner always; others when REASON_INVITES_OPEN or
  enabled). "N left" = links still makeable (allowance − unused). JOINED / UNUSED / CANCELED stamps.
  Make an invite link = `invites.makeLink` → 5D (`?invite=<id>`, only an unused link of theirs):
  the link (files.<host>/i/<token>, shown short, K3), Copy it → (clipboard, drawn only with script)
  / SHARE (only where `navigator.share` exists), Caveat "copied.", the count dropped. Each UNUSED row
  has CANCEL (`do=cancel-invite`, `invites.cancelLink(..., { replace: false })`, theirs only) → "canceled. that invite is yours again.", count back up.
- **Theme** — `web_theme` paper|night|auto; every signed-in page is drawn with
  `data-account-theme` (+ `data-theme` for paper/night, so no-script pages open in it); the head
  script writes it into localStorage, and any switch on the page posts it back (JSON).

## Drive

```bash
node --test test/web-settings.test.js test/web-settings-edit.test.js test/web-settings-migration.test.js   # 22 + 12 + 2
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/settings.db node bin/web-settings-drive.mjs   # 29 steps, all ok
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/index.db node bin/web-settings-index-drive.mjs [outDir]   # 13 steps, Chromium
```

**Desktop section index (10-27).** The → is a scroll-spy (IntersectionObserver, `aria-current="true"`),
not the hash: it used to read only `location.hash`, so a page reached at `#invites` (← SETTINGS from an
invite, or the 303 after making one) kept → INVITES while the owner read the top. A hash or a click
holds its section until the reader wheels/touches/keys; the crossing line slides from 30% to the
bottom over the last 70% of a viewport so short end sections each get the →. Smooth scroll only
under `prefers-reduced-motion: no-preference`; phones draw no index. `bin/web-settings-index-drive.mjs`
wheels through all six in Chromium (Shopping off there); live: `REASON_INDEX_URL=… REASON_INDEX_COOKIE='reason_page=…'`.

Live proof (Hetzner only): a throwaway owner `page_sessions` row → GET the public page and every
edit state, save a reach value and restore the original at once, revoke only a second throwaway session, make an invite and cancel it
with `invites.cancelLink(..., { replace: false })`, delete the rows.
