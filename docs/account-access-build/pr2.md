# PR 2: one stable, honest browser, and the load-only probe

Self-contained brief. Checked 2026-11-13 against `origin/main` `5c9117f2`; if a line has moved, find the name with `git grep`. Design: `docs/account-access-design.md` sections D and E. Not blocked: needs no AWS key and no saved login.

## Goal
Every flow that opens a person's browser uses one launch setting and one per-person lock, so a site sees the same honest browser each time and two flows can never open one profile at once. Then a load-only probe measures which refused sign-in pages any honest setup reaches, and writes the 24 that load down by name for the first time.

## What exists (verified on main)
- Launches: `src/browser.js:67` (`launchPersistentContext(profileDir(...))`, errands at 1280x900), `src/signin-remote.js:70` `VIEW = { width: 430, height: 700 }` and `:103`, `src/signin-cli.js:74`, `:96`, `:166`, `scripts/probe-sites.js:80`.
- Profiles: `profileDirFor` (`src/browser.js:36`), `profilePath` (`:50`), `pageFor` (`:60`), `openPage` (`:98`), `closeBrowser` (`:104`), `openConversations` (`:112`). No shared lock between browser tools and sign-in flows today.
- Request guard: `guardContext` (`src/browser.js:293`) intercepts every request. Address check: `publicUrl` (`src/netguard.js:61`).
- Page classes: `pageKind` (`src/signinpage.js:145`); wall memory: `isWall` / `recordWall` (`src/sitefindings.js:145`, `:155`), `PROBE` (`:44`).
- The probe script: `scripts/probe-sites.js` (`npm run probe:sites`), `classify` (`:44`). It never signs in or fills.
- The refused list: `docs/site-probe-2026-11-12-signin.json` (`sites`: 19 `walled`, Spotify `refuses_after_email`), checked by `test/signin-probe-1112.test.js`.
- The rule: `src/agent.js:187` ("No stealth, ever ... No pretending to be a different browser").

## Files
- **Change `src/browser.js`:** add `launchOptions(conversationId)` (one Chrome build, one window size, the person's language and time zone, the same profile; no stealth flags, no user-agent change except a site's declared-agent rule, below) and `holdProfile(conversationId, holder)` / `releaseProfile(conversationId, holder)` / `profileHolder(conversationId)`. `pageFor` and `openPage` answer a fixed `{ busy: "signing_in" }` while another holder has the profile, and take no snapshot or screenshot.
- **Change `src/signin-remote.js`, `src/signin-cli.js`:** launch with `launchOptions`, take and release the lock (release in `finally`).
- **Change `scripts/probe-sites.js`:** a `--setup A0|A1|A2|A3|A4` option and a `--list signin-1112` site list; never-list sites refused by the script itself.
- **Add `docs/site-probe-<date>-setups.json`** (the result) and `test/browser-launch.test.js`, `test/probe-setups.test.js`.

## Switch
`REASON_STABLE_BROWSER` = `off | owner | on`, default `off`, read at call time. Name chosen here; the design says only "its own switch, owner first". Write `stableBrowserMode()` / `stableBrowserAllowedFor(conversationId)` in `src/browser.js` exactly like `connectMode()` / `connectAllowedFor()` (`src/shopconnect.js:53-63`), `owner` through `accounts.featureOwner` (`src/accounts.js:124`). Off: today's launches, byte for byte. The lock is not switched: it is a fix for everyone.

## Data model and migration
None in either database. The probe writes only its JSON file. If you add a column after all, try the SQL on a copy of the live database first (working rules) and delete the copy after.

## The probe
- **Load only.** One page load per site per setup, a signed-out scratch profile deleted after the run, no typing, no clicking, no account, no CAPTCHA solving, nothing done to get round a wall.
- **Sites:** the 20 refused in the JSON, minus the ones section C puts on the never list (Uber / Uber Eats by its terms; LinkedIn, X, Reddit as social networks; Ticketmaster as ticket buying): 15. Controls: the owner's candidates in `first-sites.md` (Amazon, Netflix, Con Edison, Notion, Linear, Railway) plus the non-never entries of `SITES` in `src/sites.js`. Write the full list into the result so the loaded sites are named from now on.
- **Per load, record:** status, final host, `pageKind`, milliseconds to a form, and the wall vendor from cookie and header NAMES only (`cf-ray`, `cf-mitigated`; `_abck`, `ak_bmsc`; `datadome`; `_px*`; `x-kpsdk-*`; `incap_ses`, `reese84`). Never a cookie value, never page text beyond the title.
- **Setups:** A0 today's browser from the server; A1 the same build with a window and the one launch setting; A2 the real Chrome build with a window; A3 A2 without `guardContext`, the probe refusing any URL `publicUrl` rejects; A4 A2 from the Mac (a home connection). A window on the server needs Xvfb, and A2 needs Chrome installed there: check what is installed, and ask the main session before installing anything on the server. A5 (signed agent identity) and B1 (a hosted, disguised browser) are NOT in this PR.
- **Reading:** a site an honest setup opens is eligible for a saved login later; a load proves nothing about a sign-in.

## Hard rules, each with a test
1. **A login only on its exact sign-in origin, never after a cross-site redirect.** Not reachable here: this PR types nothing. Test: the probe's page object has no `fill`, `type`, `press` or `click` reachable (a stub page throws if any is called during a full fixture run).
2. **The secret is never decrypted here.** No vault code is imported. Test: `scripts/probe-sites.js` and the launch code import nothing from a vault module (a static import check).
3. **The never list refuses and says why.** Test: `--list` containing `uber.com` or `x.com` skips it with the reason "never list: <row>" in the result.
4. **One refusal stops.** Test: a fixture wall (403 plus `cf-mitigated`) is recorded once; no second load of that site in that setup, no other address, no retry.
5. **Every use writes a line the person can read.** Not reachable: the probe uses no one's account. The lock writes a fixed log line on busy (`browser busy: signing_in`), with no conversation id.
6. **Remove signs out and deletes.** Not reachable. The scratch profile is deleted after the run (test: the directory is gone).
7. **Two flows cannot open one profile.** Test: `holdProfile` by a sign-in flow, then `pageFor` for the same person answers `busy`; release, then it opens. A crash inside the holder still releases.
8. **One launch setting.** Test: with the switch `owner`, every launch site above passes the same viewport, locale and time zone; with `off`, today's values.

## Tests
`node --import ./test/paid-key-guard.js --test test/browser-launch.test.js test/probe-setups.test.js test/browser.test.js test/signin-remote.test.js test/signin-probe-1112.test.js`, then the full suite once (working rules). Fixtures on 127.0.0.1 only.

## Done and proven (no sign-in)
- The live files hash-match the merged commit; with `REASON_STABLE_BROWSER` unset the launches are unchanged (a log line count of browser opens before and after is equal in shape).
- The probe's result file is in the PR with A0 to A4 for the 15 refused plus the controls, the setup each site first reached a form in, and zero typed characters (the run's own counter, printed in the file).
- A one-paragraph reading in the PR body: which refused sites any honest setup opened, if any.

## Not in this PR
No vault, no saved login, no sign-in, no signed agent registration (A5), no hosted browser (B1), no proxy or home-address pool, no change to the user agent beyond a site's own declared-agent rule, no package installed on the server without the main session's go.

## Working rules (every builder)
- **Where:** a fresh worktree off `origin/main` (`git worktree add /private/tmp/pa-<tag> -b <branch> origin/main`), never `~/Desktop/pa` (stale). Open a draft PR at the first commit.
- **Output:** no command prints more than about 120 lines. Logs, diffs and greps go to files under `/tmp/<tag>/`; read counts and slices. Never cat a whole file. The shell is zsh: put multi-step commands in a script file and run it with `bash`; never name a shell variable `path`.
- **After every step:** append one line to `~/.openclaw/workspace/memory/<YYYY-MM-DD>.md` (`- [HH:MM ET <tag>] step N done: ...`) and rewrite the PR description to the current state (done, left, how proven).
- **Slices:** about 30 minutes each; at a boundary push, write the state down, and stop rather than run long.
- **Tests:** your files first; the full suite ONCE at the end: `ANTHROPIC_API_KEY= node --import ./test/paid-key-guard.js --test --test-concurrency=3 test/*.test.js > /tmp/<tag>/suite.log 2>&1`, counts only. Known failures on clean main: 5 in `test/ops.test.js`, 2 in `test/ops-gate.test.js`, `test/strangercalls.test.js:103` between 00:00 and 01:00 ET. Anything else is yours.
- **No text added to the standing prompt** (`test/playbooks.test.js:32` holds its size); say it in tool descriptions and results.
- **Schema:** before a deploy, run the SQL on a copy of the live `data/reason.db` and `keys.db` in `/root/<tag>-trial/` (`sqlite3 data/reason.db ".backup /root/<tag>-trial/reason.db"`), `PRAGMA integrity_check`, then `rm -rf /root/<tag>-trial` and note that it is gone.
- **Ship only on the main session's go.** Live: `root@15.204.113.250`, `/opt/reason`, service `reason`. Check `/root/.deploy-lock` and that nobody is mid-deploy (wait); take the lock; deploy `origin/main` as one commit; back up replaced files, the database and `.env`; add only the switch line the go names; restart only with `/root/reason-restart.sh` (waits for idle); health `http://127.0.0.1:8788/health` and `https://reason.tail3753c7.ts.net/health`; watch the log 5 minutes (counts); hash-match the deployed files; release the lock; delete your database backup after the watch. Follow `~/.openclaw/agents/main/agent/workshop-skills/prove-the-deploy/SKILL.md`.
