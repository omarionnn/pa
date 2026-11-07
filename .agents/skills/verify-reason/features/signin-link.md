# Sign-in link — sign in to a site from your phone, inside Reason's browser

Somebody needs to be signed in to a site (Amazon, a subscription to cancel) for an errand. Reason
sends one link, `<siteUrl>/s/<token>`. Opening it shows a start page; tapping **Start** opens
Reason's own headless browser on that person's saved profile at the site's sign-in page, and the
phone sees it live (a picture a few times a second) and drives it: tap, type (the phone's own
keyboard, saved logins, one-time codes), scroll, back, Done/Cancel. When it ends, the site's own
account page decides whether they are signed in, and Reason is told in the thread.

Source: `src/signin-remote.js` (`createRemoteSignin`, `remoteRequest`, `provedOwner`, `sendCode`,
`tryCode`, `codePage`, `startPage`, `livePage`, `resultPage`), `src/connectgate.js`
(`browserConversation`, `proofPage`: the browser proof shared with connect links, #358), `src/tools.js` (`case "signin_link"`),
`src/http.js` (the `/s/<32–64 chars>` block; passes `runtime._tell` as `tell`), `src/pages/access.js`
(the code rules and the `reason_page` cookie), `src/db.js` (`page_codes`, `page_attempts`,
`pageSessionOwner`).
Tests: `test/signin-remote.test.js` (53).

## Sub-features

- **Who may tap Start (security audit lead 6, 2026-11-07).** The link opens the whole saved profile,
  so holding it is not enough. The check is #358's (`connectgate.browserConversation`): a
  `reason_page` session for this conversation from Reason Web's sign-in (`wsign:`) or a browser
  code (`connect:`) starts at once. Page/event/trip code sessions do NOT count, same as connect
  links. Any other browser gets "Enter the code Reason texted you": a six-digit code goes to the
  person's OWN thread (`@<host> #code` last line, `scode:` outbox key so it is never history), and
  only that code starts it. The right code also sets `reason_page` (Path=/, 90 days, a `connect:`
  session), so that browser is REMEMBERED: the next sign-in link, or connect link, on it goes
  straight on with nothing texted. A new browser asks once. Codes and wrong guesses are counted per
  person under connect's `proofPage` id (`connect:<sha256(conv)[:24]>`, shared with connect links:
  3 texts / 5 wrong per 15 minutes; a fresh link resets neither). A code POST from another site
  (Origin/Sec-Fetch-Site) is refused 403, so nobody's session can be planted (login CSRF). No `tell`
  available → 403 "only starts on a browser you've signed in to Reason on".
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
node .agents/skills/verify-reason/bin/signin-link-drive.mjs   # → ALL 10 PASS
```

Real `signin_link` tool + real HTTP server on the caged DB; only the browser is a stand-in (no
Playwright, no site). Proves: stranger → 401 code step, no cookie, nothing launched, code to the
owner's thread only; other person's Reason session + wrong code → refused; right code → 303 + `rs_`
cookie + remembered `reason_page` (connect: source) → `/view` 200; next link on that browser → 303
with no text; a different browser with only the link → 401; own Reason Web browser → 303 with no
text. Against the running cage, an unknown
`/s/<32 chars>` → 404. Driven 2026-11-07 on sec/lead6.
