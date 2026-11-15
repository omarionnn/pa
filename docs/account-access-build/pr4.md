# PR 4: site policy (the never and careful lists as data, the classifier, the fixed refusals)

Self-contained brief. Checked 2026-11-13 against `origin/main` `5c9117f2`; if a line has moved, find the name with `git grep`. Design: `docs/account-access-design.md` section C. Not blocked: needs no AWS key and no saved login.

## Goal
Code, never the AI and never a person's insistence, decides whether a site may have a saved login: `never`, `careful` (Face ID every time, an extra warning line, no standing permission) or `allowed`. A never answer comes with fixed words that say why and offer the route instead.

## What exists (verified on main)
- Fixed refusal words returned by code: `refuseAPassword()` (`src/signin.js:219`); the shape to copy.
- Registrable domain: `registrableOf` (`src/signinemail.js:57`). Mailbox providers: `MAILBOX_DOMAINS` (`src/signinemail.js:65`).
- Wall memory per site: `isWall`, `recordWall`, `signinAccess` (`src/sitefindings.js:145`, `:155`, `:173`).
- No `src/sitepolicy.js` yet.

## Files
- **Add `src/sitepolicy.js`:** the reviewed data (`POLICY`, an array) and three functions: `classifySite(hostOrUrl)` returns `{ policy, category, reason, route, entry }`; `refusalFor(category, label)` returns the fixed words; `reviewList()` returns the unknown domains seen this week (domain names only, in memory, cleared on restart, read by the owner).
- **Add `test/sitepolicy.test.js`.**
- Nothing else changes. PR 5 calls `classifySite` before a save link exists; PR 6 calls it again before every sign-in.

## Switch
None in this PR, on purpose: it adds data and pure functions that nothing calls yet, so with `REASON_SAVED_LOGINS` off (or absent) nothing a person can reach changes. Section G says "same switch"; its callers, PR 5 and PR 6, carry that switch (`savedLoginsMode()` / `savedLoginsAllowedFor()`, written like `connectMode()` / `connectAllowedFor()` in `src/shopconnect.js:53-63`, `owner` via `accounts.featureOwner`, `src/accounts.js:124`).

## Data model and migration
No database change. Each `POLICY` entry: `{ match, category, policy, reason, source, read_on, reviewer }`. `match` is a registrable domain (`chase.com`), an exact host (`signin.aws.amazon.com`) or a suffix rule (`.gov`). **Exact host beats domain:** AWS sign-in and Amazon shopping share `amazon.com`. If you add storage after all, try the SQL on a copy of the live database first and delete the copy after (working rules).

## The lists
**Never, by rule:** `.gov`, `.mil`; banks, credit unions, brokerages, retirement, lenders, payment apps, crypto exchanges (a hand list now; Plaid's institution list joins when PR #520 lands); identity and work sign-in hosts (`accounts.google.com`, `appleid.apple.com`, `idmsa.apple.com`, `login.microsoftonline.com`, `*.okta.com`, `*.onelogin.com`, `login.gov`, `id.me`); every domain in `MAILBOX_DOMAINS` plus `icloud.com`, `proton.me`, `aol.com`; phone carriers (Verizon, AT&T, T-Mobile, Total Wireless, Mint, Cricket, Metro, Visible, Boost, Tracfone, Straight Talk, US Cellular); password managers (1Password, Bitwarden, LastPass, Dashlane, Keeper).
**Never, by review** (each with the sentence and its source from section C): Uber (terms forbid an agent holding the login); social networks (X, Instagram, Facebook, LinkedIn, Reddit, TikTok); ticket buying (Ticketmaster, Live Nation, AXS, StubHub, SeatGeek, Fandango); health portals and insurers.
**Never, proposed here (owner to confirm in the PR):** accounts that run Reason itself: AWS (`signin.aws.amazon.com`, `console.aws.amazon.com`: it holds the vault's key and its outside record), Netlify (it serves the save page), the registrar of heyreason.com, OVH, GitHub, and the AI providers' consoles. A login there would let a stolen server reach the controls that are meant to sit outside it.
**Careful:** airlines and hotel points (Delta, United, American, Marriott, Hilton); marketplaces (eBay, Etsy, Amazon); streaming (Netflix, Hulu, Disney+, Max); gaming; anything with payouts or money movement that is not a bank or payment app (seller and payout dashboards). **Amazon** also carries `declared_agent: "Agent/Reason"`: signed in only as a declared agent, or not at all.
**Everything else:** `allowed`, and the domain goes on `reviewList()`.

## Fixed refusals (from section C; new lines marked)
Bank: "I don't keep bank logins. For your bank I use a read-only connection where you sign in on the bank's own page and I never see the password. Want the link?" (until Plaid is live: "I can't work inside bank accounts yet. I can call the bank with you, or remind you."). Apple ID, Google, main email, government or health, work, carrier: the exact words in section C. New, for the owner to read: password manager "I don't keep password manager logins: that one account opens all the others."; social "I don't sign in to social networks with a password. Their rules ban it and they close accounts for it."; tickets "I don't sign in to ticket sites."; terms "<Site>'s rules don't let me hold your login. I'll use its official connection instead."; Reason's own infrastructure "I don't keep logins for the accounts that run me."

## Hard rules, each with a test
1. **Exact sign-in origin only.** PR 6 owns the fill. Here: `classifySite` judges the host it is given, after parsing; `https://chase.com.evil.example` is `evil.example` (unknown), `https://signin.aws.amazon.com/x` is never, `https://www.amazon.com` is careful. Test: a table of 30 or more hosts and URLs with the expected answers, including those three, `irs.gov`, `ny.gov`, `appleid.apple.com`, `accounts.google.com`, `gmail.com`, `login.microsoftonline.com`, `acme.okta.com`, `totalwireless.com`, `1password.com`, `uber.com`, `x.com`, `fandango.com`, `delta.com`, `netflix.com`, `coned.com`, an unknown host, an IP address (never: no saved login for a bare address) and an empty string (never).
2. **The secret never passes through here.** `classifySite` takes a host or URL only; query strings are dropped before anything is kept. Test: the review list holds `example.com`, never a path or query.
3. **The never list refuses and says why.** Test: every never category has fixed words naming the reason and the route; `refusalFor` never returns an empty string; no category falls through to `allowed`.
4. **One refusal stops.** PR 6 owns it. Here: a `never` answer is final for the call; there is no override argument (test: the function takes none).
5. **Every use writes a line.** PR 5 and PR 6 log refusals to the person's record; here a test checks each refusal has a short `category` code those PRs can log.
6. **Remove signs out and deletes.** Not reachable here.
7. **The list is reviewed data.** Test: every entry has `reason`, `source`, `read_on` and `reviewer`; a review-row entry without a `source` fails.

## Tests
`node --import ./test/paid-key-guard.js --test test/sitepolicy.test.js`, then the full suite once (working rules).

## Done and proven (no sign-in)
The live files hash-match the merged commit; on the server, `node -e` importing `src/sitepolicy.js` from the live tree classifies the 30-host table exactly as the test does (counts printed: never N, careful N, allowed N). No other behaviour changes; no new route or tool.

## Not in this PR
No vault, no save page, no filler, no automatic pause (PR 6 records refusals), no person's own never entries (PR 9, the accounts page), no network calls (no reading terms pages live), no change to `refuseAPassword`.

## Working rules (every builder)
- **Where:** a fresh worktree off `origin/main` (`git worktree add /private/tmp/pa-<tag> -b <branch> origin/main`), never `~/Desktop/pa` (stale). Open a draft PR at the first commit.
- **Output:** no command prints more than about 120 lines. Logs, diffs and greps go to files under `/tmp/<tag>/`; read counts and slices. Never cat a whole file. The shell is zsh: put multi-step commands in a script file and run it with `bash`; never name a shell variable `path`.
- **After every step:** append one line to `~/.openclaw/workspace/memory/<YYYY-MM-DD>.md` (`- [HH:MM ET <tag>] step N done: ...`) and rewrite the PR description to the current state (done, left, how proven).
- **Slices:** about 30 minutes each; at a boundary push, write the state down, and stop rather than run long.
- **Tests:** your files first; the full suite ONCE at the end: `ANTHROPIC_API_KEY= node --import ./test/paid-key-guard.js --test --test-concurrency=3 test/*.test.js > /tmp/<tag>/suite.log 2>&1`, counts only. Known failures on clean main: 5 in `test/ops.test.js`, 2 in `test/ops-gate.test.js`, `test/strangercalls.test.js:103` between 00:00 and 01:00 ET. Anything else is yours.
- **No text added to the standing prompt** (`test/playbooks.test.js:32` holds its size); say it in tool descriptions and results.
- **Schema:** before a deploy, run the SQL on a copy of the live `data/reason.db` and `keys.db` in `/root/<tag>-trial/` (`sqlite3 data/reason.db ".backup /root/<tag>-trial/reason.db"`), `PRAGMA integrity_check`, then `rm -rf /root/<tag>-trial` and note that it is gone.
- **Ship only on the main session's go.** Live: `root@15.204.113.250`, `/opt/reason`, service `reason`. Check `/root/.deploy-lock` and that nobody is mid-deploy (wait); take the lock; deploy `origin/main` as one commit; back up replaced files, the database and `.env`; add only the switch line the go names; restart only with `/root/reason-restart.sh` (waits for idle); health `http://127.0.0.1:8788/health` and `https://reason.tail3753c7.ts.net/health`; watch the log 5 minutes (counts); hash-match the deployed files; release the lock; delete your database backup after the watch. Follow `~/.openclaw/agents/main/agent/workshop-skills/prove-the-deploy/SKILL.md`.
