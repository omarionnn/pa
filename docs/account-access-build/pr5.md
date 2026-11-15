# PR 5: the save screen (Reason's own page, Face ID, sealing in the browser)

Self-contained brief. Checked 2026-11-13 against `origin/main` `5c9117f2`; if a line has moved, find the name with `git grep`. Design: `docs/account-access-design.md` A ("The one Reason screen"), B4, B8, B9, F.

**Status: needs PR 3 (vault core) and PR 4 (site policy) merged first; blocked for live use, owner mode included, until the `reason-vault-intake` KMS key exists** (RSA 4096, encrypt and decrypt; see PR 3's status for the AWS steps). Build and test now against the stand-in KMS; merge with `REASON_SAVED_LOGINS` off.

## Goal
When the person asks Reason to do something on a password site, Reason sends a one-use link to its own page, where they type the login once; the page seals it inside their browser to a key whose private half never leaves KMS, and Face ID signs exactly this login, for this site, under this wording. The server, Netlify and the AI only ever carry ciphertext; the saved login waits as `unverified` until PR 6 signs in with it.

## What exists (verified on main)
- Passkeys (`src/passkey.js`): `ORIGIN`, `RP_ID` (`:65-66`), `APPROVAL_TTL_MS` (`:74`), `COOL_MS` (`:75`), tables `pay_passkeys`, `pay_approvals` (`:79`, `:98`), `hasPasskey` (`:144`), `passkeysOf` (`:148`), `registrationOptions` (`:157`), `register` (`:173`), `bindingChallenge` (`:204`), `createApproval` (`:220`), `claimApproval` (`:248`), `verifyApproval` (`:264`). Kinds today: `pay`, `cap`. No passkey can be removed in code.
- Pages: `src/pages/webapprove.js` `renderApprove` (`:146`), `renderSetup` (`:233`), `APPROVE_HEADERS` (`:327`), `approveRequest` (`:343`), `passkeySetupRequest` (`:383`). Routes: `src/http.js` (list at `:39`).
- Proving the browser by a texted code: `src/connectgate.js` `startLink` (`:39`), `refuseForeignBrowser` (`:83`), `proofPage` (`:101`).
- A link as its own bubble: `src/links.js` `linkParts` (`:84`), `splitsForLinks` (`:120`).
- The sign-in page found by code: `locateSigninPage` (`src/browser.js:343`). Walls: `isWall` (`src/sitefindings.js:145`).
- A texted secret swapped for a placeholder before the AI's turn: `src/channels/router.js:293`.
- From PR 3: `src/savedlogins.js` (switch, storage, `recordLoginEvent`), `src/vaultkms.js`. From PR 4: `classifySite`, `refusalFor`.

## Files
- **Add `src/pages/savelogin.js`:** render and handle `GET /web/save-login/<token>` and `POST /web/save-login/<token>/save`.
- **Add to `src/savedlogins.js`:** `offerSaveLink(conversationId, site, quotedRequest)`, `storeFromIntake(token, sealed, assertion)`.
- **Change `src/vaultkms.js`:** `intakePublicKey()` (KMS `GetPublicKey`, cached) and `openIntake(blob)` (KMS `Decrypt`, `RSAES_OAEP_SHA_256`), returning `Secret`s.
- **Change `src/passkey.js`:** a third kind, `login`; passkey removal (set `removed_at`; `passkeysOf` skips removed ones; removing needs no Face ID); new passkeys named "Reason".
- **Change `src/http.js`:** the two routes; a flat 404, the same as an unknown path, when the switch is off for that person or `vaultReady()` is false.
- **Change `src/tools.js`:** the tool `saved_login_offer { site }`, listed in `toolsFor` (`:409`) only when `savedLoginsAllowedFor`. It returns one fixed sentence and puts the link in its own bubble.
- **Change `src/channels/router.js`:** a texted password is refused (below).

## Switch
`REASON_SAVED_LOGINS` = `off | owner | on`, default `off`, through `savedLoginsMode()` / `savedLoginsAllowedFor(conversationId)` from PR 3 (written like `connectMode()` / `connectAllowedFor()`, `src/shopconnect.js:53-63`; `owner` via `accounts.featureOwner`, `src/accounts.js:124`).

## Data model and migration
`reason.db` gains `login_intake(token_hash TEXT PRIMARY KEY, conversation_id, site, label, signin_origin, signin_path, quoted_request, permission_offered, consent_version, nonce, created_at, expires_at, claimed_at)`; `quoted_request` is sealed under the person's key. The token is 24 random bytes, kept only as its hash, one use, 30 minutes. `pay_approvals` accepts kind `login`. Try the SQL on a copy of the live database (and `keys.db`) first, then delete the copy (working rules).

## The flow
1. **Code decides a link may exist:** the switch; `classifySite` is not `never`; Reason's browser reached this site's sign-in form today (`locateSigninPage`); no wall. The pinned origin and path come from that visit, never from the AI and never from a link in mail.
2. **The page** shows their own request quoted as plain text, the site, the sign-in host, two boxes, the wording, and the choice "Reason may sign in when you ask" or "Ask me with Face ID every time" (careful sites: every time only, plus the site's warning line). Headers: no third-party script or frame, scripts by nonce, `frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
3. **Sealing as they type:** WebCrypto makes a fresh AES-GCM key, seals the boxes, and wraps that key with RSA-OAEP to the intake public key. The challenge is the hash of the server's part (`reason-login-v1`, intake id, person, site, pinned origin, permission, consent version, nonce) and the hash of the sealed blob, so the passkey call can run inside the tap (Safari).
4. **The server** recomputes the challenge, verifies the signature, claims the token, opens the blob through KMS, checks it, re-seals under the login's own key (PR 3), stores it as `unverified`, wipes. No passkey yet: the texted-code browser proof (`connectgate`), then passkey setup; a later passkey waits `COOL_MS` and is announced, as today.
5. **A password sent by text** gets fixed words, "Don't text me passwords: texts are kept by your phone company and in my history. Use this instead:" and the link; the stored copy becomes a placeholder before the AI's turn. Trigger: an open intake for this person, then a reply that is one token of 6 to 128 characters with no spaces, or a message saying "password is". Least certain part of this brief: keep the rule narrow and test it on real past messages, never on a guess.

## Hard rules, each with a test
1. **The login is bound to its exact sign-in origin.** The origin is fixed at offer time and is in the signed challenge. Tests: an intake row whose origin is edited fails the signature check; a site whose sign-in page redirects to another registrable domain (not a known identity host for it) gets no link.
2. **The secret is decrypted only inside the vault's re-seal step here (and PR 6's fill step later), never in model context, tool results, logs, crash output, screenshots, exports, memory, the nightly review or a clear-text backup.** Tests: the POST body is ciphertext only; captured logs and a forced error during the POST hold no plaintext; the HTML never contains a typed value; `login_intake` holds no secret; the tool result is the fixed sentence.
3. **The never list refuses and says why.** Test: `saved_login_offer` for a bank, `gmail.com` or `uber.com` makes no link and returns `refusalFor`'s words.
4. **One refusal stops.** A replayed, expired or claimed link is refused once and never retried. Tests: replay, expiry at 30 minutes, a POST from another origin (no `Origin: https://heyreason.com`), changed details after signing, a swapped sealed blob.
5. **Every use writes an activity line the person can read:** `link_sent`, `saved`, `refused_never_list`, `save_failed`, `removed`, as one `login_log` row and one `recordAction` row. Test: `ledger_list` shows them, with no username.
6. **Remove really deletes.** "Forget my <site> login" removes the row and its wrapped key with no Face ID; removing a passkey needs none either. Tests for both.

## Tests
`test/savelogin.test.js` (stand-in KMS on 127.0.0.1 with a local RSA pair; a virtual authenticator through CDP `WebAuthn.addVirtualAuthenticator` for the page test), plus `test/passkey-pay.test.js` and `test/pages-browser.test.js` unchanged. Then the full suite once.

## Done and proven (no sign-in)
- Live files hash-match the merged commit; with the switch off, `/web/save-login/<anything>` is the same 404 as an unknown path, and the tool is absent.
- On a scratch copy of the live code with the stand-in and `REASON_SAVED_LOGINS=owner`: the page for `example.test` renders with the headers above, a virtual-authenticator save stores one `unverified` row, and the server's request log holds ciphertext only. Copy deleted after.
- With the real intake key (separate go): the owner saves one login for his first site; nothing signs in until PR 6.

## Not in this PR
No sign-in or check sign-in (PR 6), no authenticator key box (PR 7), no accounts page (PR 9), no Apple calendar password move (PR 12), no wording sweep (PR 11), no page or script from any third party.

## Working rules (every builder)
- **Where:** a fresh worktree off `origin/main` (`git worktree add /private/tmp/pa-<tag> -b <branch> origin/main`), never `~/Desktop/pa` (stale). Open a draft PR at the first commit.
- **Output:** no command prints more than about 120 lines. Logs, diffs and greps go to files under `/tmp/<tag>/`; read counts and slices. Never cat a whole file. The shell is zsh: put multi-step commands in a script file and run it with `bash`; never name a shell variable `path`.
- **After every step:** append one line to `~/.openclaw/workspace/memory/<YYYY-MM-DD>.md` (`- [HH:MM ET <tag>] step N done: ...`) and rewrite the PR description to the current state (done, left, how proven).
- **Slices:** about 30 minutes each; at a boundary push, write the state down, and stop rather than run long.
- **Tests:** your files first; the full suite ONCE at the end: `ANTHROPIC_API_KEY= node --import ./test/paid-key-guard.js --test --test-concurrency=3 test/*.test.js > /tmp/<tag>/suite.log 2>&1`, counts only. Known failures on clean main: 5 in `test/ops.test.js`, 2 in `test/ops-gate.test.js`, `test/strangercalls.test.js:103` between 00:00 and 01:00 ET. Anything else is yours.
- **No text added to the standing prompt** (`test/playbooks.test.js:32` holds its size); say it in tool descriptions and results.
- **Schema:** before a deploy, run the SQL on a copy of the live `data/reason.db` and `keys.db` in `/root/<tag>-trial/` (`sqlite3 data/reason.db ".backup /root/<tag>-trial/reason.db"`), `PRAGMA integrity_check`, then `rm -rf /root/<tag>-trial` and note that it is gone.
- **Ship only on the main session's go.** Live: `root@15.204.113.250`, `/opt/reason`, service `reason`. Check `/root/.deploy-lock` and that nobody is mid-deploy (wait); take the lock; deploy `origin/main` as one commit; back up replaced files, the database and `.env`; add only the switch line the go names; restart only with `/root/reason-restart.sh` (waits for idle); health `http://127.0.0.1:8788/health` and `https://reason.tail3753c7.ts.net/health`; watch the log 5 minutes (counts); hash-match the deployed files; release the lock; delete your database backup after the watch. Follow `~/.openclaw/agents/main/agent/workshop-skills/prove-the-deploy/SKILL.md`.
