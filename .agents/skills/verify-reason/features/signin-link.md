# Sign-in link — sign in to a site from your phone, inside Reason's browser

Somebody needs to be signed in to a site (Amazon, a subscription to cancel) for an errand. Reason
sends one link, `<siteUrl>/s/<token>`. Opening it shows a start page; tapping **Start** opens
Reason's own headless browser on that person's saved profile at the site's sign-in page, and the
phone sees it live (a picture a few times a second) and drives it: tap, type (the phone's own
keyboard, saved logins, one-time codes), scroll, back, Done/Cancel. When it ends, the site's own
account page decides whether they are signed in, and Reason is told in the thread.

Source: `src/signin-remote.js` (`createRemoteSignin`, `remoteRequest`, `provedOwner`, `sendCode`,
`tryCode`, `codePage`, `startPage`, `livePage`, `resultPage`), `src/tools.js` (`case "signin_link"`),
`src/http.js` (the `/s/<32–64 chars>` block; passes `runtime._tell` as `tell`), `src/pages/access.js`
(the code rules and the `reason_page` cookie), `src/db.js` (`page_codes`, `page_attempts`,
`pageSessionOwner`).
Tests: `test/signin-remote.test.js` (50).

## Sub-features

- **Who may tap Start (security audit lead 6, 2026-11-07).** The link opens the whole saved profile,
  so holding it is not enough. A browser carrying a `reason_page` session proved for this
  conversation (Web, a page, an event) starts at once, exactly as before. Any other browser —
  none, or one signed in to Reason as somebody else — gets "Enter the code Reason texted you": a
  six-digit code is texted to the person's OWN thread (`@<host> #code` last line, so the iPhone
  offers it), and only that code starts it. Codes and wrong guesses are counted per person under
  `page_id = signin:<conversation>` (3 texts / 5 wrong per 15 minutes; a fresh link resets
  neither). No `tell` available → 403 "only starts on a browser you've signed in to Reason on".
  Proving with a code does NOT sign that browser in to Reason Web; it only starts this one link.
- **First Start wins, nobody after.** Start mints an `rs_<hash>` HttpOnly SameSite=Strict cookie
  scoped to `/s/<token>`; every later request needs it. Anyone else, and a dead or unknown token,
  gets the same 404.
- **Nothing launches before Start**, a new link replaces the old, a link lasts
  `REASON_SIGNIN_LINK_TTL_MS` unopened and `REASON_SIGNIN_SESSION_MS` once started.
- **Nothing typed is kept**; field metadata carries positions/kinds/labels/lengths, never values.
- **The ending is the site's word**: signed_in / signed_out / blocked (bot check) / unknown, then a
  timer note into the thread.

## Live verification

```bash
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node .agents/skills/verify-reason/bin/signin-link-drive.mjs   # → ALL 7 PASS
```

Real `signin_link` tool + real HTTP server on the caged DB; only the browser is a stand-in (no
Playwright, no site). Proves: stranger → 401 code step, no cookie, nothing launched, code to the
owner's thread only; other person's Reason session + wrong code → refused; right code → 303 + `rs_`
cookie → `/view` 200; own proved browser → 303 with no text. Against the running cage, an unknown
`/s/<32 chars>` → 404. Driven 2026-11-07 on sec/lead6.
