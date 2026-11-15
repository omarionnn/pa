# The access list (sign-up ceiling + heyreason.com/access)

What a person sees: when lots of people are joining at once, a brand-new number texting Reason gets one
text, not a reply: *"hey, it's Reason — lots of people are joining right now, so you're on the list and
i'll text you the moment you're in. more here: https://heyreason.com/access"*. The link opens the access
page, where somebody can also leave their number (plus an optional name) and see how many are ahead.

Source:
- The ceiling — `src/access.js:70` (`signupsPerHour`, `REASON_SIGNUPS_PER_HOUR`, default 25 walk-ins per
  rolling hour, `src/config.js:348`; unset on live = 25; 0 = no ceiling). `signupsFull` (`src/access.js:139`)
  counts only a number's first account: invites, event joiners, the operator and a member's number on a new
  channel never count. The text is `src/access.js:127` with `config.accessListUrl` (`REASON_ACCESS_LIST_URL`,
  default https://heyreason.com/access). Past it the number joins the approval queue exactly as with
  auto-admit off (`REASON_AUTO_ADMIT=1` on live).
- Invites skip the list: somebody who comes in on a member's invite is never counted or queued, and is free
  for good when the inviter is (see [paywall.md](paywall.md), "What live runs now").
- The website form — `POST /access/web` (`WEB_ACCESS_PATH`, `src/http.js:1236`, routed at `src/http.js:948`), signed by the Netlify
  function `reason-site-new/netlify/functions/access.mjs` with `REASON_WEB_ACCESS_SECRET` (set on BOTH
  Netlify and live `.env`; Netlify was missing it until 2026-11-10). `REASON_ACCESS_URL` on Netlify =
  https://app.heyreason.com/access/web. Daily cap `REASON_WEB_ACCESS_PER_DAY` (code default 30, live 200
  from 2026-11-10) via `db.webRequestsSince` (`src/access.js:219`). #419 added the optional name and the
  queue length in the reply.
- The page — `reason-site-new/public/access/index.html` (a stopgap until the design agent's version).

Prove:
- `node --test test/free-tier-monthly.test.js test/web-access.test.js test/access.test.js` (all pass
  2026-11-14, `7d5b5f54`: access group 52/52).
- Sign-up text without a model: `bin/free-tier-drive.mjs` (muted) prints it once the hour's ceiling is
  hit (2026-11-14: "25 admitted, the 26th queued with the access-list text"); on a sandbox DB set `REASON_SIGNUPS_PER_HOUR=1` and send two new numbers through `bin/inbound.sh`.
- Live, read-only: `curl -s -o /dev/null -w %{http_code} https://heyreason.com/access/` → 200; an unsigned
  `POST https://app.heyreason.com/access/web` → 401. A signed POST queues a real request on the owner's
  phone — don't.
