# Reason Web — Settings

Signed in, `https://heyreason.com/web/settings` (desktop: typed index left, one page right; phone:
one column, 8A then 8B). Every control is a plain form that posts to `POST /web/settings` with
`do=reach|theme|browser|everywhere|invite`, the session's form secret (`c`) and Reason's own origin,
and comes back 303 to `/web/settings?done=<what>#<section>` ("got it.", role=status). Behind
`REASON_WEB` like the rest of Web (`owner` on live).

Source: `src/pages/websettings.js` (page + POSTs), `src/pages/websignin.js` (`sub === "settings"`,
user agent noted in `sessionAccount`, `themedForAccount` on every signed-in page),
`src/pages/webkit.js` (`accountThemed`, head script follows `data-account-theme`, every theme
switch saves back), `src/deliver.js` (`keptOnWeb`), `src/db.js` (`accounts.web_reach`,
`accounts.web_theme`, `page_sessions.user_agent`, `pageSessionsFor`, `endPageSessionOf`).

## Sub-features and how each is proved

- **How Reason reaches you** — `web_reach`: `text` (NULL, default, how Reason always worked: "Text me
  for *everything*. Keep *a copy* here.") or `web` ("Text me for *timely decisions*. Keep *routine
  results* here."). Each dashed phrase is a submit button flipping it. Delivery: a message Reason
  STARTED, words only, from a task turn (`fromTask`) whose task is now `done`, for a person on `web`
  whom Web may reach → written to the web channel (history row `channel=web`), not texted; log
  `kept_on_web`. Waiting-on-you, failed, reminders, approvals, codes, replies: texted either way.
- **Private by default** — NOT drawn (`PRIVATE_BY_DEFAULT = false`): approvals are asked in the
  text with their details today (SCOPE.md question).
- **Signed-in browsers** — every `page_sessions` row of this person still inside 90 d / 30 d idle;
  device from `user_agent` ("Chrome on Mac"); rows never used on Web since then (no user agent: Reason-page code sessions, /ops) are one quiet count ("And N older sign-ins…"), ended by Sign out everywhere; last
  active (NOW / N MIN AGO / N HOURS AGO / OCT 19). SIGN OUT carries a hash of the token
  (`sessionHandle`), matched only among this person's rows. Sign out everywhere deletes all of them
  and clears this cookie (→ `/web?out=1`).
- **Connected** — AgentCard (`agentcard_users.user_id` and `connectionState` not dead), Google,
  Spotify, Uber, GitHub, iCloud (`oauth_tokens` rows: google, spotify, uber, github,
  apple_calendar). Only connected ones are listed.
- **Invites** — shown only where `invitesOpenFor` (owner always; others when REASON_INVITES_OPEN or
  enabled). "N left" = links still makeable (allowance − unused). JOINED / UNUSED / CANCELED stamps.
  Make an invite link = `invites.makeLink`. No cancel on the page (cancel is in the chat).
- **Theme** — `web_theme` paper|night|auto; every signed-in page is drawn with
  `data-account-theme` (+ `data-theme` for paper/night, so no-script pages open in it); the head
  script writes it into localStorage, and any switch on the page posts it back (JSON).

## Drive

```bash
node --test test/web-settings.test.js test/web-settings-migration.test.js
eval "$(bin/caged.sh env | sed 's/^/export /')" \
  && REASON_DB_PATH=$(mktemp -d)/settings.db node bin/web-settings-drive.mjs   # 17 steps, all ok
```

Live proof (Hetzner only): a throwaway owner `page_sessions` row → GET the public page, toggle a
setting and restore it at once, revoke only a second throwaway session, make an invite and cancel it
with `invites.cancelLink(..., { replace: false })`, delete the rows.
