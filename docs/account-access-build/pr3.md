# PR 3: vault core (storage, sealing, the KMS client)

Self-contained brief. Checked 2026-11-13 against `origin/main` `5c9117f2`; if a line has moved, find the name with `git grep`. Design: `docs/account-access-design.md` B1 to B3, B10, B12, F.

**Status: blocked for any live use, owner mode included, until the owner's AWS keys exist.** The design allows no interim key: "No key service, no vault" (condition 2) and "With the switch on and no KMS, the vault refuses to start. No file master, no `.env` key" (B3). So there is no stand-in key outside tests, and no owner-mode exception. **What can be done now:** all the code and tests, against the local stand-in KMS (tests only), merged with the switch `off`. **What unblocks live:** the owner creates, in AWS KMS, `reason-vault` (symmetric, encrypt and decrypt) and `reason-vault-intake` (RSA 4096, encrypt and decrypt; used by PR 5), each with a key policy naming the server's one AWS login and the server's address, and a CloudTrail trail that keeps KMS events. His Desktop note `~/Desktop/reason-kms-setup.md` covers only `reason-rest`; the main session must extend it with these two before he starts. About 15 minutes in all, about $3 a month for the three keys.

## Goal
A file of its own, `data/logins.db`, holds each saved login sealed under its own key, and that key exists in clear only inside KMS and, for one sign-in, in the filler's memory. Nothing in this PR types, shows or returns a login; it is the safe box PR 5 fills and PR 6 opens.

## What exists (verified on main)
- `kmsCall(target, payload)` (`src/restcrypt.js:185`, not exported) and `sigv4` (`:167`, exported). It speaks http to a `127.x` `REASON_REST_KMS_HOST` (`:195`): the test stand-in. It retries 5 times.
- Person sealing for `reason.db` columns: `sealFor` (`:476`), the sealed-column lists `SENSITIVE`, `SENSITIVE2`, `SENSITIVE3` (`:31`, `:47`, `:97`), `destroyKey` (`:606`). `secure_delete` (`src/db.js:24`).
- The record: `recordAction` (`src/db.js:3298`), read by the `ledger_list` tool.
- Export and delete: `exportData` (`src/data.js:504`), `deleteData` (`:610`), `COVERAGE` (`:410`, checked by `test/data-coverage.test.js`), the marker `REDACTED = "[not exported: this is a live credential]"` (`:345`).
- Keystore backup, three snapshots: `deploy/reason-keystore-backup`.

## Files
- **Add `src/savedlogins.js`:** the switch pair, `vaultReady()`, storage, `listLogins`, `removeLogin`, `deleteAllFor`, `exportFor`, `recordLoginEvent`, and `withLogin` (below). No function returns a secret.
- **Add `src/vaultkms.js`:** the key source. `generateDataKey(context)` returns `{ plaintext: Secret, wrapped, keyId }`; `unwrap(wrapped, context)` returns a `Secret`. KMS only, through `kmsCall`. No other implementation.
- **Add `src/secret.js`:** a `Secret` that prints `[secret]` through `String()`, template strings, `JSON.stringify`, `util.inspect` and error messages; `secret.use(fn)` lends the Buffer and zero-fills it after.
- **Change `src/restcrypt.js`:** export `kmsCall` (no behaviour change; its tests pass untouched).
- **Change `src/data.js`:** `exportData` adds `exportFor` (sites, username hints, dates, permission, state; the login is `REDACTED`); `deleteData` calls `deleteAllFor` before the person key is destroyed; `login_log` goes into `COVERAGE`.
- **Change `src/db.js` and the sealed-column lists:** create `login_log`; `login_log.purpose` sealed under the person's key, entered in the same form as the existing entries.
- **Change `deploy/reason-keystore-backup`:** include `data/logins.db`. On the server (read-only), check the off-site backup's include list and make sure `logins.db` is excluded; say what you found.

## Switch
`REASON_SAVED_LOGINS` = `off | owner | on`, default `off`, read at call time. `savedLoginsMode()` and `savedLoginsAllowedFor(conversationId)` in `src/savedlogins.js`, written exactly like `connectMode()` / `connectAllowedFor()` (`src/shopconnect.js:53-63`) and `jobsMode()` / `jobsAllowedFor()` (`src/accountjobs.js:50-61`); `owner` via `accounts.featureOwner` (`src/accounts.js:124`). `savedLoginsAllowedFor` is also false unless `vaultReady()`: `REASON_VAULT_KMS_KEY` set, AWS credentials set, and no `127.x` KMS host outside a test (`NODE_TEST_CONTEXT`). Not ready: one log line, `saved logins: off (no KMS key)`; no tool in `toolsFor` (`src/tools.js:409`); every vault route a flat 404.

## Data model and migration
`data/logins.db`, its own file, `PRAGMA secure_delete = ON`, created with `CREATE TABLE IF NOT EXISTS` at load as `src/passkey.js:79` does:
- `vault_people(conversation_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE)`: a random handle; it, never a phone number, goes into the KMS context (CloudTrail shows the context in plain text).
- `saved_logins`: the B2 columns. `id` a random 48-bit integer; `conversation_id`, `site`, `label`, `signin_origin`, `signin_path`; `username_ct`, `password_ct`, `totp_ct`; `wrapped_key`, `kms_key`; `username_hint` (sealed with `sealFor`); `permission` (`standing` / `each_time`); `second_step`; `state` (`unverified`, `working`, `wrong_password`, `needs_person`, `paused`, `refused`); `consent_version`, `consent_at`, `consent_credential`; `fail_count`, `next_try_at`, `last_used_at`, `unused_warned_at`; `created_at`. Unique `(conversation_id, site, signin_origin)`.
- In `reason.db`, `login_log(id, conversation_id, site, event, outcome, purpose, kms_calls, at)`. Events from a fixed list. Never a username, a code, or an address with a query string.

Sealing: one data key per login from `GenerateDataKey` (`KeySpec: AES_256`) with context `{ app: "reason", purpose: "saved-login", person: <handle>, item: <id>, origin: <signin_origin> }`; each field AES-256-GCM, fresh 12-byte nonce, associated data `sl1|<id>|<field>|<signin_origin>`. Only the wrapped key is stored. Migration: new file and one new table only. Try the `login_log` SQL on a copy of the live database first, then delete the copy (working rules).

## `withLogin(conversationId, id, liveOrigin, fn)`
The only way in. Checks the switch and `vaultReady()`; builds the KMS context from `liveOrigin` (the origin the browser is on, passed by PR 6), never from the row; one `Decrypt`; opens the fields into `Secret`s; calls `fn`; zero-fills in `finally`; writes `kms_calls`. Exported only for `src/filler.js` (PR 6): a test fails if any other file imports it.

## Hard rules, each with a test
1. **Exact origin only.** A row whose origin was edited, or a `liveOrigin` that differs by scheme, host or port, fails to unwrap at the stand-in (which, like AWS, checks the context). Test: three mismatches, three failures, zero plaintext.
2. **Decrypted only inside the fill step; never in model context, tool results, logs, crash output, screenshots, exports, memory, the nightly review or a clear-text backup.** Tests: only `src/filler.js` may import `withLogin` (static check; `src/tools.js`, `src/dream.js` and the recall code import nothing that opens a login); console and log capture during seal and open hold no plaintext; a thrown error inside `fn` carries `[secret]`; `exportData` shows `REDACTED`; a copied `logins.db` with no KMS opens nothing; the file's bytes never contain a plaintext field.
3. **The never list refuses and says why.** PR 4 owns it. Here: storing a login for a site the policy marks `never` throws, if PR 4 is merged; otherwise a test stub.
4. **One refusal stops.** PR 6 owns it. Here: `state = refused` and `next_try_at` exist, and `withLogin` refuses a `refused` or `paused` row.
5. **Every use writes a line the person can read.** `withLogin`, `removeLogin` and `deleteAllFor` each write one `login_log` row and one `recordAction` row. Test: `ledger_list` shows them, with no username in them.
6. **Remove really deletes** (signing out on the site is PR 6). Test: after `removeLogin` the row and its wrapped key are gone from the file's bytes; `deleteData` leaves no row for the person.

## Tests
`test/savedlogins.test.js` with a stand-in KMS on 127.0.0.1 that implements `GenerateDataKey` and `Decrypt` and enforces the context; plus `test/data-coverage.test.js` and the `restcrypt` tests unchanged. Then the full suite once.

## Done and proven (no sign-in)
- Live files hash-match the merged commit; `.env` has no `REASON_SAVED_LOGINS` line or `off`; `data/logins.db` does not exist on the server.
- On a scratch copy of the live code (not data) on the server: with `REASON_SAVED_LOGINS=owner` and no KMS key, the log line and an empty tool list; with the stand-in, a dummy login for `example.test` seals, opens once, fails on a moved row, and is removed. Copy deleted after.
- Once the keys exist (separate go): one real `GenerateDataKey` and one `Decrypt` for a dummy login on a scratch `logins.db`, both seen in CloudTrail, then deleted.

## Not in this PR
No save page, no filler, no tool the model can call, no session sealing, no own process or user for the vault (PR 10), no interim or file key, no use of `REASON_TOKEN_KEY`, the install key, the transparent read path or the opened-value cache.

## Working rules (every builder)
- **Where:** a fresh worktree off `origin/main` (`git worktree add /private/tmp/pa-<tag> -b <branch> origin/main`), never `~/Desktop/pa` (stale). Open a draft PR at the first commit.
- **Output:** no command prints more than about 120 lines. Logs, diffs and greps go to files under `/tmp/<tag>/`; read counts and slices. Never cat a whole file. The shell is zsh: put multi-step commands in a script file and run it with `bash`; never name a shell variable `path`.
- **After every step:** append one line to `~/.openclaw/workspace/memory/<YYYY-MM-DD>.md` (`- [HH:MM ET <tag>] step N done: ...`) and rewrite the PR description to the current state (done, left, how proven).
- **Slices:** about 30 minutes each; at a boundary push, write the state down, and stop rather than run long.
- **Tests:** your files first; the full suite ONCE at the end: `ANTHROPIC_API_KEY= node --import ./test/paid-key-guard.js --test --test-concurrency=3 test/*.test.js > /tmp/<tag>/suite.log 2>&1`, counts only. Known failures on clean main: 5 in `test/ops.test.js`, 2 in `test/ops-gate.test.js`, `test/strangercalls.test.js:103` between 00:00 and 01:00 ET. Anything else is yours.
- **No text added to the standing prompt** (`test/playbooks.test.js:32` holds its size); say it in tool descriptions and results.
- **Schema:** before a deploy, run the SQL on a copy of the live `data/reason.db` and `keys.db` in `/root/<tag>-trial/` (`sqlite3 data/reason.db ".backup /root/<tag>-trial/reason.db"`), `PRAGMA integrity_check`, then `rm -rf /root/<tag>-trial` and note that it is gone.
- **Ship only on the main session's go.** Live: `root@15.204.113.250`, `/opt/reason`, service `reason`. Check `/root/.deploy-lock` and that nobody is mid-deploy (wait); take the lock; deploy `origin/main` as one commit; back up replaced files, the database and `.env`; add only the switch line the go names; restart only with `/root/reason-restart.sh` (waits for idle); health `http://127.0.0.1:8788/health` and `https://reason.tail3753c7.ts.net/health`; watch the log 5 minutes (counts); hash-match the deployed files; release the lock; delete your database backup after the watch. Follow `~/.openclaw/agents/main/agent/workshop-skills/prove-the-deploy/SKILL.md`.
