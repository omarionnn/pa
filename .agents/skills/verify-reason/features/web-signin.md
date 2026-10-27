# Reason Web — signing in (phase W1)

The same Reason, reached from a browser at **`https://heyreason.com/web`** (owner's domain rule,
2026-10-26): the website (Netlify) rewrites `/web` and `/web/*` to `files.heyreason.com/web…` on
Hetzner, **signed** (`signed = "REASON_SITE_PROXY_SECRET"`, HS256 JWS in `x-nf-sign`;
`src/pages/siteproxy.js`). Direct hits to `files.heyreason.com/web…` answer **301** to
`heyreason.com/web` + same path and query (`webMovedTo`, only once `REASON_SITE_PROXY_SECRET` is set;
the website's own signed request on that host is served). W1 is sign-in alone: a person
types the number they text Reason from, Reason texts that number a six-digit code through the line it
already uses, they type it, and that browser is theirs. Signed in, `/web` is now the conversation
(W2, [web-conversation.md](web-conversation.md)); W1's "You're in, <name>." landing is gone.
**Behind `REASON_WEB`** (`off` | `owner` | `on`, like `REASON_EVENTS`): off, `/web/*` is the same flat
404 as a made-up path; `owner`, only the owner's number is ever texted a code (anybody else's gets the
identical page and nothing); `on`, anybody with a Reason. **Live with `REASON_WEB=owner`** since
2026-10-26 17:30 UTC.

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
  `eventActor`: with a valid website signature, Netlify's `x-nf-client-connection-ip` (Netlify
  overwrites a browser's own; `siteClientIp`); else Caddy's `X-Forwarded-For` only from loopback with
  `X-Files-Domain: true`; else the socket. A forged Netlify header without a valid signature counts
  for nothing (pinned, `test/domains.test.js`). 10 code requests per browser per hour (`events.signinGate`, shared with event sign-in).
- **Enumeration** — a known and an unknown number get byte-identical pages (only the echoed number
  differs); the join block is on every page; no account is ever created by typing a number.
- **The join block** (owner decisions 1 + 2) — "New to Reason? A text from your phone finishes
  joining…", an `sms:<live line>?&body=Hi` button, a QR of that same link (`qrSvg`, inline SVG,
  level M) and the number written out via `prettyNumber`. The number is `web.joinNumber(router)` →
  the first LIVE channel's — never a string, never the linq adapter (registered, `not_connected` on
  live). No live line → "Reason's texting line isn't connected right now…" and no number, no QR.
- **The session** — on a right code: `startPageSession("wsign:<conv>", token, { conversationId })`,
  cookie `reason_page` with `Path=/`, **`Domain=heyreason.com`** whenever the request is under the
  website's domain or came through it signed (`cookieDomain`; decision 3 — one sign-in for Web, pages
  on files., events on events., /ops; host-only on the Funnel), `HttpOnly; SameSite=Lax; Secure` (https), 90 days
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
  for the shell's theme switch, `img-src 'self' data:`, `font-src 'self' data:`, `form-action
  'self'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: same-origin` (header and the
  shell's `<meta>`; see the browser gotcha), `X-Frame-Options: DENY`, `no-store`. No
  `og:`/`twitter:` tags on any Web page. Logs: `web_signin_code_sent`, `web_signin_failed`,
  `web_signin_ok`, `web_signout` — never a number, code or token.
- **Copy** — intent only (no phrase to type; `test/no-command-phrases.test.js` scans `src/`): the
  sms: body "Hi" is prefilled, never dictated. Page kit: `shell` with pill "Web", wordmark, PAPER,
  brand pen red (#b03030), theme switch.
- **The look** (design handoff 2026-10-26, `~/Desktop/reason-web-handoff-2026-10-26`, kit =
  `src/pages/webkit.js`): Paper / Night tokens hex for hex (`TOKENS`), the four voices (Instrument
  Serif italic = your words + primary actions, Inter = Reason, Courier caps = labels, Caveat in pen =
  the margin voice), the wordmark bubble in pen (#b03030 / #e8765c — Web only; brand.js unchanged),
  dashed rules, hard-offset shadows, text actions with →, focus = 2px ink outline offset 3px, reduced
  motion = none. Theme = Paper · Night · Auto radio group (`themeSwitch`), the same `reason-theme`
  localStorage word every page reads. Fonts self-hosted, Latin subsets in `assets/fonts/*-web.woff2`
  (OFL), served by `webFont` at `GET|HEAD /web/fonts/{serif,roman,hand,handbold,sans}.woff2`
  (`font/woff2`, a week's cache, nosniff, CORP same-origin; other names / off → flat 404).
- **The screens** (sheet 6): 6A `renderSignin` ("What's your number?", PHONE NUMBER underline, Caveat
  "the same line you already text me on.", "Text me a code →"; phones: "NEW TO REASON? START WITH A
  TEXT →" → `/web?join=1`; ≥900px: the join column — QR, "or text <live number>", "then come back here
  to sign in."). 6B `renderCode` ("Check your texts.", "Six digits, sent to ••• ••• 0142." from the
  TYPED number, six cells over one `autocomplete=one-time-code` input, the sixth digit submits).
  Code notes, each about THIS BROWSER only (never the number): wrong "that's not it. try again?";
  expired "that one expired." + "Send a fresh one →" when the page's own hidden `t` is older than a
  code's life; too many tries (5 wrong / 15 min per browser) "let's pause a minute." + `TRY AGAIN IN
  m:ss` (`db.pageAttemptsClearAt`); resend limit (`again=1`, 3 per 15 min per browser, `RESEND`)
  "i've sent a few. give it a moment." + how long the last code still works — nothing is texted.
  The sign-in step's hourly gate shows the same pause line (`db.signinRequestsClearAt`). 6D
  `renderJoin` (live number + QR + "Text Reason →"), 6E with no live line (no number, no QR). 6F:
  `?out=1` after sign-out, or a cookie whose session no longer exists → Caveat "you've been signed
  out. everything's still here." (role=status).

## How to get to it (user POV)

- Open `/web` → "What's your number?" → "Text me a code →" → "Check your texts." → the six digits
  (iPhone offers the code above the keyboard; the sixth digit signs in) → 5C "One Reason. Pick up
  anywhere." once → the arrival. Sign out: SETTINGS (desktop) or the ⋯ menu (phone).
- Never texted Reason? Phone: "NEW TO REASON? START WITH A TEXT →" → "Text Reason →"; desktop: the
  right-hand column's QR / number → your first text joins you → come back and sign in by number.

## Driving it with the harness

```bash
cd ~/Desktop/pa
node --test test/web-design.test.js     # 29: tokens, motion, focus, every screen state's copy + roles, a11y, no-phrase scan, cards/lists/media, /web/live CORS
node --test test/web-signin.test.js      # 20: off=404 identical, owner mode, enumeration, QR, no-live/linq, happy path, wrong/reused/expired/flood/4th request, two users, decision 4, sign-out, idle/old, paused, CSRF/origin, headers, copy, the look + /web/fonts
node --test test/web-join-number.test.js # the live-line rule with the real Linq + Sendblue classes
node --test test/no-command-phrases.test.js test/code-guards.test.js
# in process, cage env, throwaway DB, real Runtime + Router + outbox + FakeChannel (no model):
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-drive.mjs
node .agents/skills/verify-reason/bin/web-preview.mjs [outDir] [referenceDir]   # every Web screen at 390/1280 × Paper/Night + compare-<screen>.png beside the handoff's reference page; real CSP + /web/fonts (default ~/Desktop/reason-web-design-previews)
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
- **The page CSS always carries `.qr`**, and the wordmark is an inline `<svg>`: assert the join
  block's absence on `<figure class="qr"` / `sms:`, never on `qr` or `<svg`.
- **Comparing code pages across numbers**: normalise the masked last four (`••• ••• NNNN`, echoed
  from what was typed), the hidden `t` and the form token — nothing else may differ.
- **The sixth digit submits the code form** (page script): a preview that fills six digits navigates
  away; set `form.dataset.sent` first to hold it.
- **The cookie is shared** (decision 3): signing out of Web signs that browser out of pages and events
  too, and an idle-expired Web session (30 days) deletes the row other pages were using. Intended.
- **Live since 2026-10-26 17:30 UTC with `REASON_WEB=owner`; at `https://heyreason.com/web` since
  the domain move (10-26).** Path: Netlify rewrite (signed) → Caddy `files.heyreason.com` `@web` handle
  (→ 8788, `X-Files-Domain true`) → the app. `files.heyreason.com/web` direct → 301. The Funnel still
  answers /web (one `127.0.0.1` rate bucket; debugging only). Drive it live only with a fictional 555
  number (same page, no text, no `wsign:` outbox row); never request the owner's code.
- **Two `reason_page` cookies.** A browser signed in before the move holds a host-only copy (files.
  or heyreason.com from /ops) beside the shared one; `readCookie` takes the first that is still a
  session, and sign-out clears both copies (`clearCookieHeader` returns two).
- **Test with a real browser, not just curl.** curl lets you send any `Origin`; a browser sends what
  the page's referrer policy allows. Under `no-referrer` Safari and Chrome post `Origin: null`, and
  the owner's own sign-in was refused through Caddy (10-26). The pages now say `same-origin`
  (header and the shell's `<meta>`), and `Origin: null` passes only with `Sec-Fetch-Site:
  same-origin`. Probe: Playwright webkit + chromium, fill a 555 number, submit, expect no
  "didn't come from this page".
- **Through Netlify every request reaches Caddy from Netlify's addresses.** Without the signature
  every visitor would share one `ip:<netlify egress>` bucket (one stranger's 5 wrong codes would lock
  Web sign-in for everybody). If the site's `REASON_SITE_PROXY_SECRET` env var and the server's ever
  differ, nothing verifies and the server 301s the website's own request back to heyreason.com/web.
  Symptom: a redirect loop on heyreason.com/web. Fix: the same value in both (Netlify env +
  /opt/reason/.env), then redeploy the site and restart Reason.
- A browser with a session row that Web no longer allows (paused account, switch back to `owner`)
  sees the sign-in form and has no sign-out; the row stays and reopens when allowed again. The
  browsers list in W2 is where it gets a revoke.
- Deferred to W2+: token hashing and 24h rotation (§4.2), a browsers list with per-row revoke, the
  once-only boundary notice column (`web_notice_seen_at`; W1 shows the notice statically on the
  landing), the `(web)` hint after a Web→text switch (decision 9).
