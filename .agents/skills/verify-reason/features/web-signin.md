# Reason Web — signing in (phase W1)

The same Reason, reached from a browser at `/web` (the website will proxy `heyreason.com/web` to it
in phase W5; until then the route exists only on Reason's own address). W1 is sign-in alone: a person
types the number they text Reason from, Reason texts that number a six-digit code through the line it
already uses, they type it, and that browser is theirs. The signed-in landing is a placeholder
("You're in, <name>." + the approved boundary notice) until W2 brings the conversation.
**Behind `REASON_WEB`** (`off` | `owner` | `on`, like `REASON_EVENTS`): off, `/web/*` is the same flat
404 as a made-up path; `owner`, only the owner's number is ever texted a code (anybody else's gets the
identical page and nothing); `on`, anybody with a Reason. **Dark on live** as of 2026-10-26.

Source: `src/pages/websignin.js` (every decision: who a browser is, which account a number opens, the
codes, CSRF/origin, the join block, the pages), `src/pages/qr.js` (the QR encoder, no dependency),
`src/web.js` (`webOn`, `webAllowedFor`, `joinNumber`), `src/http.js` (`webRoute` → `webRequestFor`),
`src/events.js` (`tryKeyedCode`, the shared wrong-try ceilings; `signinGate`/`noteSigninRequest`),
`src/pages/access.js` (`requestCode`, cookies, `SESSION_TTL_MS`), `src/db.js` (`page_sessions.csrf`,
`pageSessionOwner(…, { idleMs })`, `pageSessionCsrf`, `HISTORY_EXCLUDED_KEYS` has `wsign:`).
Plan: `docs/plans/reason-web-phase1.md` §4.1–4.2, §7 decisions 1–4 and 10, §8.

## Sub-features

- **Who a number opens** (`accountForNumber`) — `accountsByAddress`, console rows skipped, newest
  `last_seen_at` first, the first that `accounts.admit` still allows AND `webAllowedFor` permits.
  Ten digits without `+` → `+1`. Owner decision 4: one number with two accounts (Linq + Sendblue)
  signs in to the most recently used; the other is never mentioned. Null = stranger, paused,
  removed, blocked, or (in `owner` mode) anybody but the owner — all indistinguishable from outside.
- **The code** — `requestCode({ id: "wsign:<conv>", title: "Reason" })`: six digits, hashed in
  `page_codes`, 15 minutes, one live at a time (a new one kills the old), single use, **3 per person
  per 15 minutes** (the fourth request answers the same page and logs
  `web_signin_code_refused: too_many_sent`). Texted through `runtime._tell` with outbox key
  `wsign:<conv>:<code row id>`, NOT awaited (timing says nothing about whose number it was). The
  text: `Your Reason code is NNNNNN, to open Reason on the web in that browser. Good for 15 minutes.
  If that wasn't you, ignore this — nothing was shown.` + blank line + `@<web host> #NNNNNN`
  (host from `webUrl()` = `REASON_SITE_URL/web`, i.e. `@heyreason.com` on live). Excluded from the
  per-message history by its key prefix.
- **Wrong tries** — `events.tryKeyedCode` under `wsign:<conv>` (person) and `wsignb:<actor>`
  (browser): 5 wrong per browser per 15 min — the only limit ever said ("Too many wrong codes from
  this browser") — plus the silent 20 per person per 15 min and 40 per person per day. The actor is
  `eventActor` (Caddy's `X-Forwarded-For` only from loopback with `X-Files-Domain: true`; else the
  socket). 10 code requests per browser per hour (`events.signinGate`, shared with event sign-in).
- **Enumeration** — a known and an unknown number get byte-identical pages (only the echoed number
  differs); the join block is on every page; no account is ever created by typing a number.
- **The join block** (owner decisions 1 + 2) — "New to Reason? A text from your phone finishes
  joining…", an `sms:<live line>?&body=Hi` button, a QR of that same link (`qrSvg`, inline SVG,
  level M) and the number written out via `prettyNumber`. The number is `web.joinNumber(router)` →
  the first LIVE channel's — never a string, never the linq adapter (registered, `not_connected` on
  live). No live line → "Reason's texting line isn't connected right now…" and no number, no QR.
- **The session** — on a right code: `startPageSession("wsign:<conv>", token, { conversationId })`,
  cookie `reason_page` with `Path=/`, `HttpOnly; SameSite=Lax; Secure` (https), 90 days
  (`SESSION_TTL_MS`). The same cookie opens their pages, events and /ops (decision 3). Web reads it
  with a **30-day idle** limit (`WEB_IDLE_MS`, via `pageSessionOwner(…, { idleMs })`): idle or old,
  the row is deleted and the cookie opens nothing anywhere. `sessionAccount` also requires
  `accounts.admit` (paused/removed → signed out) and `webAllowedFor` (back to `owner` → everybody
  else signed out, shown the sign-in page, not a 404).
- **CSRF + origin** — every `/web/*` POST must come from one of Reason's hosts (`Origin` must be the
  request host, `REASON_SITE_URL`, `REASON_PAGES_URL` or `REASON_PUBLIC_URL`; `Sec-Fetch-Site`
  `cross-site` refused; no `Origin` allowed through). Before sign-in: a form token in cookie
  `reason_web_form` (`Path=/web`, 24h, HttpOnly) must equal hidden `f` — a mismatch answers 403
  with a fresh form and texts nobody. Signed in: hidden `c` must equal the session's
  `page_sessions.csrf` (minted on first read). Comparisons are `timingSafeEqual`.
- **Sign-out** — `POST /web/signout` with the cookie + `c`: `endPageSession` (the row is gone, so the
  browser is out of every page too), cookie cleared, 303 `/web`. No cookie → 303 and nothing
  touched; wrong/missing `c` or another site → 403, still signed in. GET → 405.
- **Headers** — `SECURITY_HEADERS` on every answer: CSP (`default-src 'none'`, inline style/script
  for the shell's theme switch, `img-src 'self' data:`, `form-action 'self'`, `frame-ancestors
  'none'`), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `no-store`. No
  `og:`/`twitter:` tags on any Web page. Logs: `web_signin_code_sent`, `web_signin_failed`,
  `web_signin_ok`, `web_signout` — never a number, code or token.
- **Copy** — intent only (no phrase to type; `test/no-command-phrases.test.js` scans `src/`): the
  sms: body "Hi" is prefilled, never dictated. Page kit: `shell` with pill "Web", wordmark, PAPER,
  brand orange, theme switch.

## How to get to it (user POV)

- Open `/web` → "Pick up where you left off." → your number → "Text me a code" → the code arrives
  in your Reason texts (iPhone offers it above the keyboard on the Web host) → "Sign in" → "You're
  in, <name>." → "Sign out of this browser" at the bottom.
- Never texted Reason? The same page's "New to Reason?" → "Text Reason" (phone) or scan the QR /
  type the number (desktop) → your first text joins you under the existing admission rules → come
  back and sign in by number.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/web-signin.test.js      # 18: off=404 identical, owner mode, enumeration, QR, no-live/linq, happy path, wrong/reused/expired/flood/4th request, two users, decision 4, sign-out, idle/old, paused, CSRF/origin, headers, copy
node --test test/web-join-number.test.js # the live-line rule with the real Linq + Sendblue classes
node --test test/no-command-phrases.test.js test/code-guards.test.js
# in process, cage env, throwaway DB, real Runtime + Router + outbox + FakeChannel (no model):
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-drive.mjs
node .agents/skills/verify-reason/bin/web-preview.mjs [outDir]   # four PNGs: phone form, code step, desktop join block (QR + number), landing
```

Over HTTP on the cage: `REASON_WEB=on bin/caged.sh start`, then `curl -si 127.0.0.1:<port>/web` → 200,
the form, a `Set-Cookie: reason_web_form=…` and the security headers; without the flag the cage
answers `{"error":"not found"}` exactly as `/no-such-thing`. The cage's texting channels are
`not_connected`, so its join block says the line isn't connected (no `sms:`/QR) — correct there; the
drive covers the button with a FakeChannel. A `POST /web/signin` on the cage with a seeded account's
number mints a `page_codes` row under `wsign:<conv>` and logs `web_signin_code_sent … ok:false` (not
connected); a stranger's number mints nothing and answers the same bytes.

## Gotchas

- **Two form tokens, two pages.** Comparing pages across two browsers must normalise the hidden
  `f` as well as the echoed number, or "identical" fails for the wrong reason.
- **The shell's CSS always carries `.w-qr`**, and the wordmark is an inline `<svg>`: assert the join
  block's absence on `<figure class="w-qr"` / `sms:`, never on `w-qr` or `<svg`.
- **The cookie is shared** (decision 3): signing out of Web signs that browser out of pages and events
  too, and an idle-expired Web session (30 days) deletes the row other pages were using. Intended.
- **Live since 2026-10-26 17:30 UTC with `REASON_WEB=owner`.** `https://files.heyreason.com/web`
  goes through Caddy's `@web` handle (→ 8788, `X-Files-Domain true`) and the funnel answers too;
  `heyreason.com/web` (Netlify) is not proxied yet (W5). Drive it live only with a fictional 555
  number (same page, no text, no `wsign:` outbox row); never request the owner's code.
- **Test with a real browser, not just curl.** curl lets you send any `Origin`; a browser sends what
  the page's referrer policy allows. Under `no-referrer` Safari and Chrome post `Origin: null`, and
  the owner's own sign-in was refused through Caddy (10-26). The pages now say `same-origin`
  (header and the shell's `<meta>`), and `Origin: null` passes only with `Sec-Fetch-Site:
  same-origin`. Probe: Playwright webkit + chromium, fill a 555 number, submit, expect no
  "didn't come from this page".
- **Before W5 proxies `/web/*` through Netlify** (review finding, 2026-10-26): `eventActor` trusts
  `X-Forwarded-For` only behind Caddy's `X-Files-Domain` marker, so through Netlify every visitor
  would share one `ip:<netlify egress>` bucket and one stranger's 5 wrong codes would lock Web
  sign-in for everybody. W5 must either route `/web` through Caddy on `files.heyreason.com` or add
  a trusted Netlify client-address header to `eventActor` — decide before the rewrite, not after.
- A browser with a session row that Web no longer allows (paused account, switch back to `owner`)
  sees the sign-in form and has no sign-out; the row stays and reopens when allowed again. The
  browsers list in W2 is where it gets a revoke.
- Deferred to W2+: token hashing and 24h rotation (§4.2), a browsers list with per-row revoke, the
  once-only boundary notice column (`web_notice_seen_at`; W1 shows the notice statically on the
  landing), the `(web)` hint after a Web→text switch (decision 9).
