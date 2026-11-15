# PR 6: the filler (Reason signs itself in with a saved login)

Self-contained brief. Checked 2026-11-13 against `origin/main` `5c9117f2`; if a line has moved, find the name with `git grep`. Design: `docs/account-access-design.md` B5, B7, B10, B11, D, F.

**Status: needs PR 1 (#531, not merged yet), PR 2, PR 3, PR 4 and PR 5 merged; blocked for live use, owner mode included, until the owner's KMS keys exist** (PR 3's status). Build and test now on fixture sites with the stand-in KMS; merge with `REASON_SAVED_LOGINS` off. The owner's first real sign-ins come after, on his go, from `first-sites.md`.

## Goal
The AI gets one tool, `account_signin { site }`, and everything between the call and its one-word result is code: the right page, the exact origin, one KMS unwrap, typing, clean-up. The AI never holds the login, never sees the boxes filled, and cannot aim the filler at another site.

## What exists (verified on main, plus what earlier PRs add)
- Page classes: `pageKind` (`src/signinpage.js:145`); signed-in evidence: `readSignedInState` (`src/sites.js:358`); `locateSigninPage` (`src/browser.js:343`); `snapshot` (`:170`), `pageImages` (`:181`).
- Walls and findings: `recordFinding` (`src/sitefindings.js:128`), `isWall` (`:145`), `recordWall` (`:155`), `blockedWords` (`:205`). Attempt log: `ROUTES` (`src/signinlog.js:10`), `logAttempt` (`:32`), `logStep` (`:70`).
- Forget a site's cookies and storage: `forgetSite(context, conversationId, siteName)` (`src/signin.js:434`). Record: `recordAction` (`src/db.js:3298`). Click gating: `COMMIT_WORDS` (`src/tools.js:2324`; "Sign in" is not gated, fine because the AI never has the secret).
- PR 1 (#531): the snapshot withholds secret boxes and a scrubber exists (`src/pagesecrets.js` on branch `fix/typed-secrets-never-read`); re-check its names with `git grep` once merged. PR 2: `holdProfile` / `releaseProfile`, `launchOptions`. PR 3: `withLogin`, `recordLoginEvent`, the switch. PR 4: `classifySite`. PR 5: the `login` approval kind.

## Files
- **Add `src/filler.js`:** `signIn(conversationId, site, { trigger })`, the only importer of `withLogin`.
- **Change `src/tools.js`:** `account_signin { site }` in `toolsFor` (`:409`) only when `savedLoginsAllowedFor`; it returns `{ result, say }` with fixed words. Also "forget my <site> login" (below).
- **Change `src/browser.js`:** while the filler holds the profile, every browser tool answers "signing in" and takes no snapshot or picture (PR 2's `busy`); during a signed-in job, navigation off the site's own hosts is refused.
- **Change `src/signinlog.js`:** `ROUTES` gains `saved_login` and `saved_login_again`.

## Switch
`REASON_SAVED_LOGINS` = `off | owner | on`, default `off`, through `savedLoginsMode()` / `savedLoginsAllowedFor(conversationId)` (PR 3; written like `connectMode()` / `connectAllowedFor()`, `src/shopconnect.js:53-63`; `owner` via `accounts.featureOwner`, `src/accounts.js:124`). Off: no tool, no route, nothing typed.

## Data model and migration
No new table: it uses `saved_logins.state`, `fail_count`, `next_try_at`, `last_used_at`, `second_step` (PR 3) and `login_log`. If you add a column, try the SQL on a copy of the live database (and `keys.db`) first and delete the copy after (working rules).

## The sealed step
1. **Gates, in code:** the switch; `classifySite` not `never`; the site not paused; a saved login whose `state` and `next_try_at` allow a try. `standing` needs a live ask: the turn began with the person's own message, a tapped card, or a job they approved; never an email, a page, a timer or the nightly review. Find how a turn records what started it (`git grep -n` for the trigger in `src/agent.js`); if it cannot tell, refuse. `each_time` and every careful site need a fresh Face ID approval (kind `login`, PR 5).
2. **Lock** the profile (`holdProfile`); release in `finally`.
3. **Code goes to the pinned page itself,** in a new tab; never a page the AI was on, never a link from a page or an email.
4. **Origin check:** `new URL(page.url()).origin === signin_origin` after all redirects, as strings: scheme, host and port. The password box is in a frame of that same origin, visible, `type=password`. Otherwise stop: `origin_mismatch` or `not_signin_page`. Certificate errors are never ignored. A challenge page: `blocked`.
5. **Unwrap and type:** `withLogin(..., liveOrigin)` with the origin read from the browser now. Username, then re-check the origin, then password, with `locator.fill` (no simulated human typing; Amazon's terms ban it). Tick "Remember this device" when offered. Submit.
6. **Clean up before the AI looks:** wait for the page to move on; empty any box the filler typed into that still exists; only then release.
7. **Result:** one of `signed_in`, `needs_code_sms`, `needs_approval`, `wrong_password`, `blocked`, `not_signin_page`, `origin_mismatch`, `paused`, `needs_face_id`, with fixed words. Never page text, never an address with a query string. A second step is reported and stops here (PR 7 handles it).

**Attempt budget (section D):** one wrong password, then `wrong_password` until they save again; one refusal (wall, CAPTCHA, "unusual activity", "too many attempts") and the site is `refused` for this person, recorded with `recordWall`, said in the site's words, never retried from another address or browser; a lock message means 24 hours of nothing; an "automated access" page pauses the site for everyone and the owner is told; at most one automatic sign-in per site per day. Never "forgot password", never a security setting, never "was this you?".

## Hard rules, each with a test (fixture sites on 127.0.0.1 under several names via Chromium `--host-resolver-rules`)
1. **A login only on its exact sign-in origin, never after a cross-site redirect.** Tests: a look-alike host; a redirect to another origin; a password box in a cross-origin frame; same origin but another path; `http` instead of `https`; another port. Each: nothing typed, the right result word, and zero KMS calls.
2. **The secret is decrypted only inside the fill step, never in model context, tool results, logs, crash output, screenshots, exports, memory, the nightly review or a clear-text backup.** Tests: during and after a fixture sign-in the transcript, tool results, `snapshot`, `pageImages`, captured logs, a forced browser error, `exportData` and the ledger hold no plaintext; the scrubber's hit count is zero; KMS calls equal sign-ins in `login_log`.
3. **The never list refuses and says why.** Test: `account_signin` for a never site returns `refusalFor`'s words and calls nothing.
4. **One refusal by a site stops the attempt.** Tests: a challenge page, then a second call the same day: no load, `paused`; one wrong password, then a second call: no typing.
5. **Every use writes an activity line the person can read:** sign-in, refusal, failure, sign-out, removal, as `login_log` plus `recordAction`, in the B10 form ("Thu 3:02 pm. Signed in to Xfinity with your saved login, to pay your October bill."). The first sign-in to each site is also said in the thread. Test: `ledger_list`.
6. **Remove really signs out and deletes.** "Forget my <site> login": sign out with the live session where the site's sign-out address is known and check it took; `forgetSite`; delete the row and its wrapped key; scrub what was read there from the thread, as the existing disconnect does (`git grep -n forgetSite src/tools.js`); say plainly what could not be confirmed and where to sign out on the site. Test: a fixture site's session cookie is gone, the row and key are gone, and the words name the unconfirmed part.

## Tests
`test/filler.test.js` (fixtures, stand-in KMS), plus `test/browser.test.js`, `test/signin-remote.test.js` and PR 1's tests unchanged. Then the full suite once.

## Done and proven (without a real sign-in)
- Live files hash-match the merged commit; with the switch off the tool is absent and nothing calls `withLogin`.
- On a scratch copy of the live code with the stand-in KMS and fixture sites: the six origin cases and the two refusal cases give the expected words, zero scrubber hits, KMS calls equal to sign-ins, and a readable activity line per use. Copy deleted after.
- Then, on the owner's go and with the real keys: his first sites, in `first-sites.md` order.

## Not in this PR
No second steps (PR 7: authenticator codes, emailed and texted codes joined to the filler), no sealed sessions or signing back in (PR 8), no accounts page (PR 9), no paying or cancelling with a saved login (payments and subscriptions stay on the checkout service), no hosted browser, no retry from another address.

## Working rules (every builder)
- **Where:** a fresh worktree off `origin/main` (`git worktree add /private/tmp/pa-<tag> -b <branch> origin/main`), never `~/Desktop/pa` (stale). Open a draft PR at the first commit.
- **Output:** no command prints more than about 120 lines. Logs, diffs and greps go to files under `/tmp/<tag>/`; read counts and slices. Never cat a whole file. The shell is zsh: put multi-step commands in a script file and run it with `bash`; never name a shell variable `path`.
- **After every step:** append one line to `~/.openclaw/workspace/memory/<YYYY-MM-DD>.md` (`- [HH:MM ET <tag>] step N done: ...`) and rewrite the PR description to the current state (done, left, how proven).
- **Slices:** about 30 minutes each; at a boundary push, write the state down, and stop rather than run long.
- **Tests:** your files first; the full suite ONCE at the end: `ANTHROPIC_API_KEY= node --import ./test/paid-key-guard.js --test --test-concurrency=3 test/*.test.js > /tmp/<tag>/suite.log 2>&1`, counts only. Known failures on clean main: 5 in `test/ops.test.js`, 2 in `test/ops-gate.test.js`, `test/strangercalls.test.js:103` between 00:00 and 01:00 ET. Anything else is yours.
- **No text added to the standing prompt** (`test/playbooks.test.js:32` holds its size); say it in tool descriptions and results.
- **Schema:** before a deploy, run the SQL on a copy of the live `data/reason.db` and `keys.db` in `/root/<tag>-trial/` (`sqlite3 data/reason.db ".backup /root/<tag>-trial/reason.db"`), `PRAGMA integrity_check`, then `rm -rf /root/<tag>-trial` and note that it is gone.
- **Ship only on the main session's go.** Live: `root@15.204.113.250`, `/opt/reason`, service `reason`. Check `/root/.deploy-lock` and that nobody is mid-deploy (wait); take the lock; deploy `origin/main` as one commit; back up replaced files, the database and `.env`; add only the switch line the go names; restart only with `/root/reason-restart.sh` (waits for idle); health `http://127.0.0.1:8788/health` and `https://reason.tail3753c7.ts.net/health`; watch the log 5 minutes (counts); hash-match the deployed files; release the lock; delete your database backup after the watch. Follow `~/.openclaw/agents/main/agent/workshop-skills/prove-the-deploy/SKILL.md`.
