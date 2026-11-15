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
Tests: `test/signin-remote.test.js`, `test/signin-flow-1112.test.js` (the right page, no
phantom steps, no link loops, positive evidence, the step log), `test/signin-link-reprompt.test.js`
(12: the site's answer, the code box, approve-on-phone, repeated answer, password cap),
`test/signin-route.test.js` (when a saved login goes first, [saved-logins.md](saved-logins.md)).

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
- **The page it opens (2026-11-12, `src/signinpage.js`).** A site named by its bare domain opens on
  the page that person's last attempt was on (`signin_pages`, `signin.entryOnItsPage`); with nothing
  known, `browser.locateSigninPage` follows the site's own "Log in" link once BEFORE a link is made,
  and no link is made when no sign-in page is found (`no_signin_page`). The look-up stops early on
  a finished page (`signinpage.settleWatch`: complete, words on it, nothing being fetched, unchanged
  for 2 s), so "no sign-in page" is said in a few seconds, not at the 10 s bound.
- **No phantom steps.** Each `/view` is classed by `pageKind`; `np.step` is `looking` (a site named
  by its address, no sign-in page yet: picture tucked, never "finish this step") or `between` (a page
  with nothing to fill in, mid-way). A `looking` session follows the site's own link once after
  2.5 s and ends as `no_signin_page` at `REASON_SIGNIN_FORM_WAIT_MS` (10 s).
- **No link loops.** After `timed_out` / `cancelled` / `link_expired` / `no_signin_page` the note
  says one plain line and no new link; `signin_link` in an event turn answers `not_sent_again` for
  the same page (one retry when the page differs), a user turn is theirs to ask and starts the
  count over (`signin_link` or `signin_email` in their own turn). A replaced link that was not
  signed in wakes nobody.
- **"Signed in" on a site with no playbook** needs a log-out/account control (`FRAME_JS` `acct`) or
  the site's own sign-in page passing the browser through (`sites.readSignedInState`); else
  `unknown` with `no_evidence`. The session stops itself only after a submit, off the sign-in page,
  with that control present.
- **The site's answer, shown (#569, on for everyone).** After a submit the page shows what the site
  said, masked (`maskSiteWords`: addresses → `[email]`, numbers and codes → `[number]`): "<Site> says:
  “…”", or "<Site> showed this step again and said: “…”" / "…without a message I can read. Tap “Show
  me the page”…". The same step answered the same way twice (`SAME_ANSWER_STOP` 2) ends the link as
  `site_repeated` with the site's words in the thread note and no "try again". At most 3 passwords per
  link (`MAX_PASSWORD_SUBMITS`): a fourth Enter on a password page is refused before the site hears
  it ("I've stopped sending passwords to <Site> on this link so repeated tries don't lock your
  account."). A code box beside the password is its own labelled box, typed before one Enter. "Approve
  the notification" shows fixed words + an **I approved it** button that watches the page up to 20 s
  and presses nothing. A link that runs out after submits says what the site showed last. One
  `signin_link_diag` log line per submit: kinds, counts, classes, the masked alert, never a value.
- **When the link is not the way (#570).** For the owner with the vault on, a site with a saved login
  goes to `account_signin`, not a link; the link comes back for a step only the person can do, and a
  link that ends signed in brings one save offer ([saved-logins.md](saved-logins.md)).
- **Back to Messages (#551) is not on these pages.** The shared ending (`src/pages/backlink.js`) is on
  the vault pages, purchase approval, bank done and the Google return; `src/signin-remote.js` does not
  use it, so the sign-in link's result page still ends without that button.
- **Step log.** `signinlog.logStep`: `link_opened`, `start_pressed`, `page_kind` (+`kind`),
  `signin_link_followed`, `submitted`, `signed_in`, `expired`, `ended`; host, timing and a session
  tag only. Read on live with `journalctl -u reason | grep signin_step`.

## Live verification

Offline (slot gate): `node --import ./test/paid-key-guard.js --test test/signin-remote.test.js
test/signin-flow-1112.test.js test/signin-link-reprompt.test.js test/signin-route.test.js`.

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
`/s/<32 chars>` → 404. Driven 2026-11-07 on sec/lead6; again 2026-11-14 at 7d5b5f54 (ALL 10 PASS)
after the drive's links were made on a `kind: "user"` turn: as an event turn, the second link after a
cancelled one is `not_sent_again` (no link loops, #525) and the drive died at step 4.
