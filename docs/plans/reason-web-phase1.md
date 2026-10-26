# Reason Web — phase 1: inspection and plan

Written 2026-10-26 (read-only pass; no code, no commits, no server or .env changes).
Spec: `memory/assets/reason-web-concept/reason-web-build-prompt.md` (11 sections) + four concept screenshots.
Repo state inspected: `~/Desktop/pa` on branch `domain-heyreason` (c880529), `~/Desktop/reason-site-new` on `domain-heyreason` (d14bac3). The public domain is becoming **heyreason.com**; two other builders are mid-flight on that in both repos. Everything below names files as they are today; line numbers are from this pass and will drift.

---

## 0. One-paragraph verdict

Reason already has every primitive Web needs: a phone-proved browser session (`reason_page` cookie → `page_sessions`, 90 days, per person), six-digit texted codes with throttles and tombstone-free enumeration defences, per-conversation serialised turns, an idempotent outbox, durable tasks/timers with a "waiting on you" state, and a memory layer with soft-delete for facts. What it does **not** have: a per-message history table with source channel (history is one JSON blob per conversation), any way to text a number that has never texted Reason (inbound-only line), a stored "where do updates go" preference, session rotation/CSRF, a tombstone that survives re-extraction, or any account recovery. The plan reuses the gate and the outbox, adds a `web` channel that maps onto the person's **existing** conversation id (no second history), introduces a per-message `messages` log with channel labels, and builds memory controls on top of the existing `memory_drop`/`memory_fix` with a new tombstone store. Everything ships dark behind `REASON_WEB` (owner | on | off, same shape as `REASON_EVENTS`).

---

## 1. What exists and is reusable

### 1.1 Browser sessions and the code gate (reuse as-is, extend)

| Thing | Where | Today |
|---|---|---|
| Cookie | `src/pages/access.js:180-191` | `reason_page=<token>; HttpOnly; SameSite=Lax; Secure (when publicUrl is https); Max-Age=90d`. Path `/p/` for pages, `/` on the files domain, `/ops` and event pages. |
| Session row | `src/db.js:574-579`, `conversation_id` added at 1344 | `page_sessions(token PK, page_id, conversation_id, created_at, last_seen_at)`. Token = `randomBytes(32)` base64url, stored **plaintext**. Hard 90-day expiry from `created_at`; `last_seen_at` is written but never used. No rotation. |
| Validation | `db.pageSessionValid` 5309, `db.pageSessionOwner` 5292 | Owner = `page_sessions.conversation_id`. Event pages additionally require `accounts.admit().allow`, so paused/removed/blocked = signed out (`src/pages/event.js:62-69`). |
| Revocation | `POST /e/{id}/signout` (event.js:347) ends the presented cookie; tool `browsers_sign_out` → `db.endPageSessionsFor(conv)` (5329) ends all. | Per-browser and all-browsers both exist. |
| Codes | `src/pages/access.js:19-32, 70-157`; `page_codes` (db 582) stored `sha256:`; `page_attempts` (590) | 6 digits, 15-min TTL, one live code at a time, single use, 3 sends / 15 min, 5 wrong / 15 min per page id. Timing-safe compare. Single failure word `wrong`. Ghost ids answer byte-identically (`http.js:1204-1218`). |
| Sign-in by number | `src/pages/event.js:257-297`, `events.accountForNumber` (416), `SIGNIN_WRONG` (438-466) | Enter number → if an account exists **and** has a role in that event, a code is texted via `runtime._tell(conv, …, {idempotencyKey: "esign:<conv>:<codeId>"})`, fire-and-forget so timing never reveals which numbers exist; otherwise the same "if that number uses Reason, a code is on its way" screen. Ten digits → +1. Per-browser 5 wrong / 15 min, per-person 20 / 15 min + 40 / day silent ceiling, 10 code requests / browser / hour. |
| Code input | `codeInputAttrs` `src/pages/render.js:1073` | `autocomplete=one-time-code inputmode=numeric`; Apple `@host #code` binding via `boundTo`. AutoFill confirmed working over iMessage by the owner (10-25). |
| /ops gate | `http.js:1363-1497`, `src/opspassword.js` | Same session, plus scrypt password with 5/IP + 30 total per 15 min. Operator only. |

**How a code is delivered today, through which channel, to whom.** `runtime.say`/`_tell` → `deliver.whereTo` (`src/deliver.js:36-43`) → the conversation's `threads.channel/address` → Sendblue `POST /api/send-message` from `SENDBLUE_FROM_NUMBER` (+1 656 216 7455). So a code can reach exactly one kind of person: someone whose conversation already has a thread row, i.e. **someone who has texted Reason before.**

**A never-enrolled number.** There is no path. The Sendblue line is `inbound_only` (`src/linechange.js:4-5`, `src/invites.js:18-21`, `src/pages/event.js:16-25`: "If outbound texting ever becomes possible, `finishStep` is the one place to swap"). Every new-user flow today ends in the person tapping an `sms:` link that pre-fills a text **to** Reason (invite claim `"Hi Reason, I'm joining with invite code XXXX-XXXX"`, event claim, and the website's request-access form which sends nothing and queues a request for the owner via `POST /access/web`, HMAC-signed by the Netlify function). The claim text is the proof of phone control and the account is created when that text arrives (`router.#claimInvite` / `#claimEvent`, `db.redeemInvite` 10360, `db.redeemEventClaim` 11113).

**Reusable verbatim:** cookie helpers, `page_sessions`, `page_codes` + `requestCode`/`trySubmittedCode` (with a non-page key, as event sign-in already does with `events.signinKey(conv)`), the sign-in-by-number screen pattern, `SIGNIN_WRONG` ceilings, `codeInputAttrs`, `browsers_sign_out`.

### 1.2 Accounts and the conversation_id scheme

- **An account IS a conversation id** (`src/accounts.js:9-11`). `accounts(conversation_id PK, channel, address, name, is_operator, state, …, UNIQUE(channel,address))` (`db.js:475-488`). No separate account id, no phone column beyond `address`.
- `conversationIdFor({channel,address})` (`accounts.js:31-35`): operator numbers and the console → `config.ownerConversation` (`dm:owner`); everyone else → `dm:<channel>:<E.164>`. Three places build the id by hand without this helper: `access.js:314` (`approve`), `db.js:10361` (`redeemInvite`), `db.js:11129` (`redeemEventClaim`).
- **The same person on two channels gets two accounts today** (`dm:linq:+1…` vs `dm:sendblue:+1…`); only the owner collapses. The only cross-channel lookup is `db.accountByNumber(address)` used for inbound calls (`db.js:2860`, `calls/inbound.js:271`). `normalizeNumber` does not add +1, so `555…` and `+1555…` are different addresses (event sign-in patches this locally).
- **126 tables; 388 `conversation_id = ?` filters in db.js alone.** Isolation is "every query filters by conversation_id"; there is no middleware. Full table→key map is in the accounts explorer report (summarised: everything person-scoped carries `conversation_id` directly except `person_facts` (via people), `task_log`, `research_*`, `remote_events`, `page_codes/attempts` (via page), and the event/ride/album tables keyed by `event_id` + `conversation_id`).
- `threads` (`db.js:142`) is one row per conversation holding `channel, address, chat_id, service, last_inbound_id, reply_target`. **`upsertThread` overwrites channel/address on every inbound** (`db.js:3546`). This is the single most important conflict for Web (§2).
- Admission: `accounts.admit` (`accounts.js:66-92`) → blocked / paused / removed / `no_account_yet`; `REASON_TEST_NUMBERS` = pre-approval; `REASON_AUTO_ADMIT=1` (live) → `access.approve` immediately on first text. Live backend `claude-cli` also runs `servesOnThisBackend` (`backends/guard.js:79-96`), which refuses anyone not a test number / console / auto-admitted.
- Feature-flag pattern to copy (`config.js:344-357`): `(v => v === "owner" ? "owner" : ["1","true","on","yes"].includes(v))(…)` and the `events.js:35-43` on/allowed-for-conversation helpers.

### 1.3 History: where messages live

- `conversations(id, messages JSON, updated_at)` (`db.js:15-19`): **the whole thread as one JSON array of `{role, content}`**, trimmed to 60 (`thread.js:20-43`), model sees 40. User lines are the string `"[stamp] Name: text"` (`claude-cli.js:118`). **No per-message channel, id or timestamp.**
- Per-message rows with a channel exist in three places but none is a history: `event_log(conversation_id, channel, message_id, role, content, at, …)` (9263; content blanked after 30 days by `privacy.js:72-75`), `inbound_messages` (UNIQUE(channel, external_id) — the dedupe), `outbox` (sent rows with `message_id`, `channel`, `body`).
- The claude-cli backend keeps **no** per-conversation session dir (`backends/cli.js:57-76`), but the CLI itself writes `~/.claude/projects/…/*.jsonl` containing full prompts (history + memory notes) — a second on-disk copy, see §1.5.

### 1.4 Replies, routing and delivery

Pipeline (from the message-flow report): Sendblue webhook → `Router.deliver` (admit → claims → backend guard → `claimInbound` dedupe → `upsertThread` → burst hold 4 s quiet / 10 s max in `pending_inbound`) → `runtime.inbound(conv, text, {channel,to,chatId})` → `Runtime._turn` (per-conversation promise chain `enqueue`, one turn at a time) → `deliver()` → `whereTo` → `router.send` → **outbox** (`idem_key UNIQUE`, states queued/sending/sent/failed/unknown, 5 attempts, backoff, `findSent` reconciliation on restart) → Sendblue.

- **Reply routing rule today:** a reply carries the inbound's `channel/to` in `meta` (`router.js:574`), so replies go back the way they came. Anything Reason starts itself (timers, tasks, alerts, codes, `say()`) has no channel and falls to `threads.channel/address` = **the channel of the most recent inbound**.
- Console channel bypasses the outbox (`router.js:1010`, `deliver.js:77`); it is the simplest adapter template (`channels/console.js`), and `channels/fake.js` shows a webhook-driven one.
- Restart safety exists (6376f0c): interrupted turns are handed back (`router.#handBack`), outbox rows stuck `sending` become `unknown` and are reconciled, `catchUp` polls Sendblue for the last 90 s.
- No streaming: the CLI returns the whole reply; tools can send earlier bubbles via `message_send` (outbox).
- `typing.js` is iMessage-only; nothing exposes "a turn is in flight" per conversation to HTTP.

### 1.5 Memory: stores and derived copies

Primary stores (all `conversation_id`-scoped): `person_facts` (status active/deleted/corrected/superseded — **soft delete exists**), `people`, legacy `memories`, `guesses` (incl. rhythms patterns), `preferences`, `whys` (superseded_at/by), `pattern_asks`, `important_people`, `goals`.

Derived copies that can resupply a fact:
1. `profile_blocks.block` — markdown profile injected **every turn** (`memorynote.js:29-31`); rebuilt by `rebuildProfile` (`extract.js:523-582`). After `memory_drop`/`memory_fix` on the CLI backend the rebuild is **queued in the background** (`tools.js:9820, 9853`), lost on restart (`background.js:28`), not retried.
2. `fact_embeddings` — removed asynchronously on drop/fix; reads filter on active.
3. `graph_entities` / `graph_edges` / `graph_mentions` — `forget` cleans only that person's entities; `memory_drop`/`memory_fix` clean **nothing** in the graph. Deleted entity keys block re-insert (`upsertEntity` throws, caught and logged).
4. `event_log` + `extraction_queue` — the extractor reads the last 4 event_log rows as context (`extract.js:212-218`) and **recreates paraphrases**: the tombstone check is exact `factKey` only (`db.js:2291-2298`), `samefact` compares only against active rows, and `forget` hard-deletes so there is no tombstone at all. **No "forgotten" list is consulted by extraction.**
5. `conversations.messages` — `scrubToolResults` only for tools in `MEMORY_TOOLS` (not `memory_search`/`graph_lookup`); `redactFromReplies` is exact substring on assistant text; user text never touched.
6. `pages.content` of the `memory_page` snapshot — never refreshed on drop/fix.
7. `media_items` descriptions/transcripts, `sent_claims`, `open_questions`, `outbox.body`, `inbound_messages.text` — retention-only.
8. Claude CLI session `.jsonl` files on the **Mac** dev checkout (10,958 files, 1.7 GB, 2,842 with Reason prompts). Not touched by anything. (The live box runs the CLI as `reason` and will have the same kind of files under that user's home — unverified this pass.)
9. Manual DB copies in `data/backups/`, `data/*.bak`; the rolling 4am/4pm backup on the box is a systemd timer, **not in the repo** (memory `reason-rolling-backup`; the repo's `src/pages/site.js:141` still says "Reason has no backups").

Existing controls: model tools `forget` (whole person, hard delete), `memory_drop` (fact soft-delete; guess/why/preference hard delete), `memory_fix` (new row + old marked corrected), `memory_page` (read-only page). No HTTP memory route exists. `clearConversation` only from the console `reset`; `npm run data:delete` misses `event_log`, `fact_embeddings`, `extraction_queue`, `profile_blocks`, `graph_*`, `pattern_asks`, `sent_claims`, `open_questions`.

### 1.6 Tasks, timers, long work, approvals

- `timers(id, conversation_id, fire_at, note, fired_at, cancelled_at, attempts, next_try_at, task_id, series_id)`; fired by the 15 s sweep (`runtime.tick` 942, `_fireTimer` 957) with outbox key `timer:<id>:fire` → idempotent. Claim is a SQL compare-and-set.
- `tasks(id, conversation_id, state, sheet JSON, …)` + `task_log`; open states `running | waiting | waiting_on_you | waiting_on_other | blocked`, closed `done | failed | cancelled`. **`waiting_on_you` with `sheet.needs` is the existing "needs your approval/answer" state.** Tools `task_start/update/finish/list`. Correction and cancellation = the model reading chat and calling `task_update`/`task_finish`; `openwork.js` re-injects open sheets every turn. Rescue on boot (`rescueOrphanedTasks`). `runTasks` wakes tasks via `_turn` with `shouldSend` gated on a sheet signature.
- `watches`, `series` (timers with `series_id`), `commitments`, `research`, `held_actions` (undo window, `idem_key UNIQUE`), `remote_jobs`.
- `src/activity.js` + `activity_page` tool already compute a per-conversation "what's moving / waiting on you / stuck / done in 48 h" view from `listTasks`, `tasksFinishedSince`, `recentHolds`, `pendingConfirmations`. **This is the data model for the Ongoing panel.**
- Approvals: `trust.requestConfirmation` → `confirmations` row (action, summary, stakes, normalised `target`, `asked_after_msgs`) → a *new* owner message read by `judge.js` → `authorizeConfirmation` checks same tool, not spent, target equal, within `confirmWindowMin` → single use. Purchases additionally bind `cart_hash`, `agentcard_purchases.buy_conversation_id UNIQUE`, `outcome_unknown` blocks retry, AgentCard passkey on device. **There is no approval token or button today; approval is text.**
- External-effect idempotency already exists for texts (outbox), purchases (hash + status ladder + webhook event_id), calls (`call:<id>:<kind>:<hash>`), flights (same purchase path). Plain `say()` has no key (random `auto:` key) — fine for replies, a hole for anything a web retry could re-trigger.

### 1.7 Notification preferences

`accounts.notice_mode (timely|digest|off)`, `notice_per_day`, `notice_every_min`, `notice_window_start/end` (quiet hours default 22–08), `notice_tz`, `notice_snooze_until`, read via `db.noticePrefs`/`notice.settingsFor`. **No channel preference exists**; `deliver.whereTo` always picks the thread's channel. The events-only 21–09 window is separate.

### 1.8 The site

Static HTML, no generator, Netlify (`publish = "public"`, one function `netlify/functions/access.mjs` for the request-access form). Nav in `public/index.html:95-102`: wordmark, `#day` "A day with it", `#things` "What it does", `#rules` "Its rules". Pages: `/`, `/updates/`, `/updates/calls/`, `/updates/events/`. `netlify.toml` 200-rewrites `/privacy /terms /google/* /p/* /s/* /ops /ops.json` to the Tailscale funnel host `reason.tail3753c7.ts.net` and 301s `reason.omarinyarko.com/*` and `www.heyreason.com/*` → `heyreason.com`. Tokens in `styles.css:5-21` (`--bg #f2ebe0`, `--paper #faf6ee`, `--brand #B8460B`, Instrument Serif / Inter / Caveat). pa mirrors them by copy in `src/pages/brand.js` and `wordmark.js`. Deploy = `npx netlify deploy --prod --dir=public` from the repo. The site repo is private `omarionnn/reason-site`.

---

## 2. Conflicts with the spec, honestly

1. **"Receive a code through that person's Reason" works only for existing users.** New users cannot receive anything first: the line is inbound-only. Web onboarding for a new person must end in the same `sms:` tap the invite/event joins use (they text Reason; that text is the proof). Spec §3 anticipates this ("do not invent SMS support… surface unsupported enrollment cases") — so Web sign-up for a never-enrolled number is: enter number → page says a text from their phone finishes it → `sms:` tap → account created on arrival → return to Web and sign in by number. Desktop users without the phone to hand get an honest "finish this from your phone" state. **Not fakeable.**
2. **History is a JSON blob with no channel labels.** The spec's "You · iMessage / Reason · Web" and "Continued on Web" need per-message `channel` + timestamp. Nothing stores that for the model thread today; `event_log` has channel but is blanked after 30 days by retention. A new per-message table is required (§4.3) and must be fed from the same places that write `event_log`.
3. **`threads` is one row per conversation and web inbound would steal proactive routing.** With a shared id, the first web message makes `upsertThread` set `channel='web'`, and every timer, task result, alert and **code text** would then route to the browser and not the phone. Must pin a separate "phone route" (§4.4).
4. **Same number, two channels = two accounts** today. Not a problem for Web if the web channel never creates its own account (it maps onto the existing one), but it means "map authenticated Web to one stable identity" must be done at sign-in time by address lookup, not by `conversationIdFor`.
5. **Forget is not durable** (§1.5). The spec's "not undone by cache, graph edge, summary, retry or re-extraction" is false today for paraphrases, for `forget` (no tombstone), for guesses/whys/preferences (no tombstone), for the graph after drop/fix, for the queued profile rebuild, and for the memory page snapshot. The spec's wording ("Never claim forgotten while another path supplies it") means the Memory tab must not say "forgotten" until §4.6 is built.
6. **Chat-history deletion does not exist for users** and `data:delete` is incomplete. Spec asks for it as a separate control; it is new work with policy questions (§7 Q7).
7. **No session rotation, no CSRF token, tokens stored plaintext, no CSP, no CORS headers.** Adequate for link-tap pages (SameSite=Lax is the only CSRF defence and it holds for top-level POSTs from forms on the same origin), not for an app with JSON POST endpoints. §4.2 adds them for the web routes only; existing page routes unchanged.
8. **Approval is free text read by a model judge.** The mockup's "Review details" button is fine as a *destination* (opens the conversation / the task card); a one-click "Approve" button would be a new authorisation path that bypasses `recordConfirmation`'s "new message in their own words" rule. Phase 1 ships review-only, no approve button (§7 Q8).
9. **Backend guard on claude-cli**: `servesOnThisBackend` refuses anyone who is not a test number / console / auto-admitted. Web turns go through the same router path so the rule still applies; no widening.
10. **Domain in flight.** Cookie host, `codeHost` binding (`@host #code`), `REASON_PUBLIC_URL`, Netlify rewrites and the site nav all key off the domain. Web must be built on `heyreason.com` from the start, and the rewrite for `/web/*` must be added to `netlify.toml` by (or after) the domain builder — never in parallel with it.
11. **Backups**: the repo thinks there are none; the box has a rolling one. Any identity/schema change needs a verified pre-change copy (the album deploy pattern: migrate a copy first, integrity check).
12. **Mockup copy breaks the no-command-phrases rule** ("Or say 'text me when this is done'", "You can also say 'remember this'…"). All such lines are rewritten as intent in §5.

---

## 3. Proposed reversible mapping: channel-scoped ids → shared account/history

**Principle: do not re-key anything.** The conversation id stays what it is (`dm:owner`, `dm:sendblue:+1…`). Web is a *route to* an existing conversation, never a new one.

- New table `web_links(conversation_id PK → accounts, address, created_at, revoked_at)` is **not** needed: `page_sessions.conversation_id` already is the link from a browser to a person. Web sign-in = find the account by phone, exactly as event sign-in does (`events.accountForNumber`: normalise, 10 digits → +1, `accountByAddress` across channels newest-first, then `admit`), then mint a `page_sessions` row with `page_id = 'web'` and that `conversation_id`.
- If the same number holds two accounts (linq + sendblue), sign-in picks the one with the newest `last_seen_at` (the inbound-call rule already does this) and **says nothing about the other**; merging is out of scope (§7 Q4).
- Web inbound: `Router.deliver({channel:'web', from:<address>, …})` must not call `conversationIdFor` (would yield `dm:web:…`). Add one branch in `Router.conversationFor`/`deliver`: when `channel === 'web'`, the id is the **session's** `conversation_id` (server-side, from the cookie; never from the client). `accounts.admit` still runs against that account's real `channel/address` for state checks. `upsertAccount` must **not** be called with `channel:'web'` (it would overwrite `accounts.channel`, breaking `ownerOf().channel` for calls and cards).
- **Rollback:** delete `page_sessions WHERE page_id='web'`, drop the new tables (`messages`, `web_*`, `memory_tombstones` if unused), unset `REASON_WEB`. No existing row is modified by the mapping; the only writes into existing tables are ordinary history/outbox rows that would exist anyway, labelled `channel='web'`. The flag off = routes 404 and the channel is not registered, so nothing can route to it.
- **Test on a copy first** (same as the albums migration): run the migration against a copy of live `reason.db`, `PRAGMA integrity_check`, then sign in two test accounts and the owner and confirm `SELECT count(*) FROM accounts` and every `conversation_id` are unchanged.

---

## 4. Design

### 4.1 Sign-in (existing users) and onboarding (new users)

Routes (all under `/web/…` on heyreason.com; `netlify.toml` gets one more 200 rewrite `/web/*` → funnel host, added after the domain PR lands):

- `GET /web` — signed out: number form (reuse `renderSignin` pattern). Signed in: the app shell.
- `POST /web/signin` `{number}` — `accountForNumber`-style lookup; if an active account exists, `requestCode({id: 'wsign:'+conv, title: 'Reason Web'})` + `_tell(conv, line, {idempotencyKey: 'wsign:'+conv+':'+codeId})`, fire-and-forget; **always** the same screen: "If that number uses Reason, a code is on its way to it." Throttles: existing 3 sends / 15 min per person, 10 code requests / browser / hour, `SIGNIN_WRONG` 5 per browser / 20 + 40 per person. Code text reuses `codeLine` wording with `@heyreason.com #NNNNNN` binding.
- `POST /web/code` `{number, code}` — `trySubmittedCode` against `wsign:<conv>`; success → `startPageSession('web', token, {conversationId})`, cookie Path `/` on heyreason.com (one cookie already serves pages, events, /ops; this keeps "one code trusts the browser for every page of theirs").
- **New number** (no account): the same "if that number uses Reason…" screen, plus a second block that is always shown regardless of whether the number exists (so it reveals nothing): "New to Reason? A text from your phone finishes joining." with the `sms:` link to the live texting line (`web.joinNumber(router)` → the first `router.list()` channel whose status is `live`, as the event and invite pages already do; never hardcoded, never the Linq adapter) pre-filled with the existing join text (invite code if they arrived from `/i/{token}`, event claim if from an event, otherwise the plain first text). Admission rules unchanged: auto-admit on (live) creates the account on that text; invites-open off means no invite mention for non-owners; the website request-access path stays as the fallback for people with no code. After their first text they return and sign in by number. On desktop the page shows the number to text and a QR of the `sms:` link (QR is optional; see Q2).
- First Web use shows the boundary notice once (`accounts.web_notice_seen_at`): the approved wording from spec §9.

### 4.2 Session model

- Keep `page_sessions`; add columns `kind` (`page|web`), `token_hash`, `rotated_from`, `last_seen_at` already exists. Web rows store `sha256(token)`; page rows untouched until a later PR hashes them too.
- **Expiry**: 90-day hard cap stays; add a **30-day idle** expiry for `kind='web'` using `last_seen_at` (work in flight is unaffected: tasks run server-side under the conversation, not the session; a signed-out tab just has to sign in again to *view*).
- **Rotation**: on every successful code, and every 24 h of active use, mint a new token, write the new row with `rotated_from`, keep the old row valid for 60 s (two tabs), then end it. Sign-out ends the presented token (`endPageSession`) and clears the cookie; "sign out everywhere" = `endPageSessionsFor(conv)` (exists). The web app lists active browsers (created, last seen, rough UA) with per-row revoke.
- **Revocation sources**: owner `pause/remove` (account state) already fails `admit` → treated as signed out on next request; `browsers_sign_out` tool from chat (exists).
- **CSRF**: every state-changing `/web/*` POST requires header `X-Reason-Csrf` equal to a per-session value (`csrf` column, random 16 bytes) that the shell embeds; plus `Origin`/`Sec-Fetch-Site` check (`same-origin` only). `SameSite=Lax` stays.
- **CORS**: none (no `Access-Control-*` headers; same-origin only). **CSP** on `/web/*`: `default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Cache-Control: no-store`.
- **Authz**: every `/web/*` handler resolves `conv` from the session and passes it to the existing `db.*` functions, which already filter by `conversation_id`. Task ids, memory ids, page ids and attachment ids are **never** trusted from the client without a `WHERE conversation_id = ?` on the read. Album/event/page routes keep their own gates. Downloads go through the existing `/p/`, `/e/…/album/photo` paths with the same cookie, not through new shortcuts.
- **Logging**: never the code, token or message text; same event names as the page gate (`web_signin_code_sent ok`, `web_signin_failed why`).

### 4.3 One conversation: history with source labels

- New table `messages(id INTEGER PK, conversation_id, role (user|assistant|system), channel (sendblue|linq|console|web), external_id, outbox_id, text, media JSON, at, deleted_at)` with index `(conversation_id, at)`. Written at the same three points that write `event_log` (router user line 565, runtime assistant line 504, `router.#claimEvent` 807) plus `outbox` on `sent` for code-written lines (timers, task news, codes are **excluded**: a code text is never shown in history). Not subject to the 30-day content blanking unless the owner decides history retention (Q7). Backfill: none (spec: no silent historical import); Web shows history from the day the flag turns on for that account, with one line "Your conversation before <date> stays in your texts."
- The model thread (`conversations.messages`) is unchanged; the user-line prefix gains the channel ("`[stamp] Omari (web): …`") so the model knows where it is being spoken to. Two tabs/refresh/reconnect never start a turn: a turn starts only on `POST /web/send`, which goes through `Router.deliver` with a client-generated `external_id` (UUID) → `claimInbound` UNIQUE dedupes retries.
- Live updates: `GET /web/stream` Server-Sent Events, per session, emitting `{message, task, typing}` for that conversation only (an in-process `EventEmitter` keyed by conversation_id; the SSE handler checks the session on connect and re-checks every 60 s so a revoked session drops). Polling fallback `GET /web/history?after=<id>`.

### 4.4 Reply routing for overlapping web + text

- **Rule 1 (replies):** a reply goes to the channel the triggering message arrived on. Already true via `meta.channel/to`; the web adapter's `send()` writes the `messages` row and pushes to SSE, and returns `{ok, id}`. Nothing is sent to iMessage for a web-triggered turn and vice versa. The `messages` row is the shared history, not a second delivery.
- **Rule 2 (things Reason starts itself):** `threads.channel/address` must stay the **phone route**. Change `upsertThread` so `channel='web'` never overwrites the stored channel/address (store `last_channel='web'` in a new column instead). `whereTo` for channel-less sends then consults the notification preference (§4.5), not "last inbound".
- **Rule 3 (burst folding):** a web message arriving while a text-triggered turn runs joins the same per-conversation queue (`enqueue`) and the existing `onethought` fold; it is one conversation, so order is by `at`. Pending web messages are held in `pending_inbound` like texts and survive restart.
- **Rule 4 (uncertain delivery):** web `send()` is in-process, so it cannot "fail to deliver"; an SSE client that missed it catches up by `after=<id>`. An iMessage send that fails (opted out, line down) already surfaces via the outbox + `undeliveredNotice`; the Web task card shows "Couldn't reach your phone" from the outbox `failed` row for that conversation rather than silently falling back to web. No silent channel fallback.
- Open tab ≠ active use: nothing routes on SSE connection state.

### 4.5 Notifications: default, per-task override, where preferences live

- New `accounts` columns: `updates_channel` (`text|web`, default `text` for existing users = today's behaviour; the onboarding choice on first web use writes it), `updates_timely_text` (boolean, default true: timely decisions/approvals may text even when `updates_channel='web'`), `web_notice_seen_at`.
- Per-task override: `tasks.sheet.notify` (`text|web|null`) set by the model from chat ("tell me by text when this one is done" → `task_update {notify:'text'}`) or by a toggle on the task card. Code-written task news (`runTasks` → `say(…, {fromTask})`) passes `taskId` so `whereTo` can read the override; null → account default.
- Routing matrix in `whereTo` for channel-less sends:
  - task **needs you** (`waiting_on_you`, confirmation ask, approval): phone if `updates_timely_text` else web only; body is the generic "Reason needs your approval" + authenticated link `https://heyreason.com/web?t=<taskId>` (the link is a destination; the session is the authorisation; no details in the body, no og tags on `/web`).
  - task **done / research ready**: per-task override, else `updates_channel`; web = a `messages` row + task card state `ready`, no text.
  - timers/reminders, events, rides, alerts: unchanged (phone), subject to existing `notice_*` quiet hours and caps. No new urgency, no quiet-hours override.
  - a declined channel (`updates_channel='web'` and `updates_timely_text=false`) is respected: nothing texts; the card shows "waiting on you here" and the existing `claimNeedsReminder` re-ask goes to web.
- Web push: not in v1. Browser notifications: none.

### 4.6 Memory: view / correct / forget, with suppression across every derived store

- **View**: `GET /web/memory` renders `memory.remembered(conv)` (facts, guesses, preferences, whys) with the same honesty labels as `memory_page` (guesses stay guesses). Read-only JSON `GET /web/memory.json` for the tab.
- **Correct**: `POST /web/memory/fix {id, kind, text}` → existing `memory_fix` handler body (refactor the tool body into `src/memory.js` so chat and web call one function). **Forget**: `POST /web/memory/drop {id, kind}` → `memory_drop` body, same refactor.
- **New `memory_tombstones(id, conversation_id, kind, subject_key, text_norm, embedding BLOB, created_at, reason (dropped|corrected|forgot))`** written by drop/fix/forget. Suppression points, each with a pinned test:
  1. `rememberOnce` and `validateAndInsert` (extractor): refuse a candidate whose normalised text matches a tombstone **or** whose embedding cosine ≥ 0.80 against a tombstone for the same subject (the measured paraphrase band is 0.70–0.85; 0.80 with same-subject guard, tunable; a refused candidate is logged as `suppressed`).
  2. `rebuildProfile`: run **synchronously** in the web/chat handler (not queued) and on failure mark `profile_blocks.stale=1` so `memoryNotes` skips the block until the next successful rebuild; the sweep retries stale profiles.
  3. `fact_embeddings`: delete synchronously (today async).
  4. Graph: on drop/fix/forget, set `valid_to` on edges whose `source_message_ids` or text reference the fact, and mark entities with no remaining live edge `deleted`; `graph_lookup` and `buildGraphContext` filter `valid_to IS NULL`.
  5. `conversations.messages`: extend `MEMORY_TOOLS` scrub list with `memory_search` and `graph_lookup`; keep `redactFromReplies`.
  6. `pages` with role `memory`: re-render or mark superseded on any change.
  7. `event_log`/`extraction_queue`: **not deleted** (spec: no silent deletion of source history); re-extraction is blocked by (1). Retained originals are stated as such in the UI: "The original message stays in your history."
  8. `forget` (whole person): keep hard delete but write a tombstone per fact first.
  9. Guesses/whys/preferences: tombstones too (same table, `kind`).
  10. Claude CLI session files: on the live box, run the CLI with session persistence disabled if the installed CLI supports it (verify flag; otherwise a cron that trims `~reason/.claude/projects/*` older than N days). Until then the Memory tab must not claim completeness: wording is "removed from what Reason recalls" and the owner decides retention wording (Q6).
- **Chat-history deletion** is a separate control, phase 5, scope to be decided (Q7); until then the "Manage chat history" button is absent, not disabled-but-shown.
- "Stale facts never return after summarization, re-extraction, cache refresh, restart" test: drop → restart process → run sweep with a queued paraphrase event → assert no new row, profile lacks it, `memoryNotes` output lacks it.

### 4.7 Ongoing panel / tab

Read model = `activity.js` inputs: open tasks with state → pill mapping (`waiting_on_you` → "Needs you", `running|waiting|waiting_on_other` → "Working on it", `blocked` → "Stuck", `done` within 48 h → "Ready"), sheet `needs`/`furthest`/steps for the checklist, holds (undo window) as "Sending in 30 s", pending confirmations as "Needs your approval" with **"Review details"** linking to the conversation anchor of the ask — no approve button in v1 (Q8). No percentages. Task ids are the existing integer ids, shown as titles only. Cancel/correct from Web = sending a message (same path as text), not a direct state write, so the model's `task_update` rules and the `furthest` guard stay the only writers.

### 4.8 What stays closed

- Lost phone / changed number / account merge: **no path exists; none is built.** Sign-in by a number that has no account shows the new-user block only. The owner can `pause/remove` and re-admit by text as today.
- Public signup: unchanged (`REASON_AUTO_ADMIT` and invites govern; Web adds no new door).
- "Saved" tab: v1 = pages the person already has (`pages` by conversation, the existing `kept.js` list) — no new retention or sharing; label is a proposal.

---

## 5. User-facing copy (intent only, no command phrases)

- Boundary notice (approved): "One Reason. Pick up anywhere. Start on Web, continue in iMessage, or switch back. Reason keeps the context, so you don't have to explain again. See your full conversation on Web. Messages from Web won't appear in your iMessage thread."
- Supporting: "This is the same Reason you text. Web shows your full history; iMessage shows the messages sent there. Replies go to the place you're chatting, not both."
- Notifications (replaces the mockup's quoted line): "Timely decisions by text. Routine results wait here. For any one piece of work, just tell Reason where you'd like to hear about it."
- Memory tab (replaces "You can also say 'remember this'…"): "You can also ask Reason to remember, update, or forget something right in the conversation."
- Forget confirmation: "Reason will stop recalling this. The original message stays in your history."
- New-user block: "New to Reason? A text from your phone finishes joining. Reason answers there first, then you can sign in here."
- Sensitive text body: "Reason needs your approval." + link, nothing else.

---

## 6. Phased build plan (all dark behind `REASON_WEB`, PR per phase, each with pinned tests mapped to spec §10)

| Phase | PR | Scope | Tests (spec §10) | Size |
|---|---|---|---|---|
| **0** | W0 | `REASON_WEB` flag (owner/on/off) in config; `web` channel adapter (in-process, `send()` → `messages` + emitter; `findSent` by id); `messages` table + writers; `threads.last_channel` + `upsertThread` guard; `conversationFor` web branch. Migration dry-run script against a DB copy. No routes. | Schema migration on a copy; existing suite green; "web inbound never changes `threads.channel`"; dedupe on repeated `external_id`; two conversations never share rows. | M (2–3 days) |
| **1** | W1 | Sign-in: `/web`, `/web/signin`, `/web/code`, `/web/signout`, session `kind/token_hash/csrf/idle`, rotation, CSP/CSRF/Origin, browsers list + revoke. New-user block with `sms:` tap. Boundary notice once. | Two users + unauthenticated visitor; wrong/expired/reused code; resend flood; code guessing; revoked/expired session on every route; enumeration (same bytes for known/unknown number); never-enrolled number sees the text-first block; desktop state. | L (3–4 days) |
| **2** | W2 | Conversation: shell, history (`/web/history`, SSE `/web/stream`), composer → `Router.deliver` web, source labels, "Continued on Web" dividers, safe rendering (escape, no HTML from model, links only). Mobile 320/390 + desktop, keyboard/focus/SR names, empty/error/loading. | Text→Web→text, interleaved, concurrent tabs, refresh, disconnect/reconnect, out-of-order delivery, process restart mid-turn; exactly one reply on the triggering channel; no duplicate turn from retries. | L (4–5 days) |
| **3** | W3 | Ongoing: side panel / tab from `activity.js` inputs, SSE task events, task override toggle writing `sheet.notify`, "Review details" destination links; notification prefs page + `updates_channel`/`updates_timely_text` columns; `whereTo` matrix; generic approval text + link; onboarding choice. | Defaults, every choice, per-task override, declined channel (no fallback), failed phone delivery shown honestly, no duplicate notification, one task → at most one external commitment (use fake purchase provider), retries idempotent, work survives tab close. | L (4–5 days) |
| **4** | W4 | Memory: `/web/memory` view/fix/drop, refactor tool bodies into `src/memory.js`, `memory_tombstones` + the 10 suppression points, synchronous profile rebuild + `stale`, graph `valid_to`, scrub list extension. | View/fix/drop via UI and via chat; stale fact never returns after re-extraction (paraphrase), summarisation/profile rebuild, cache refresh, restart; isolation on every memory op; guesses labelled. | L (4–5 days) |
| **5** | W5 | Site: "Web" nav item + `/web` landing copy (§9 wording) on reason-site-new; `netlify.toml` `/web/*` rewrite; pa `site.js` "no backups" line corrected. Only after the domain PRs merge. | Site build renders; rewrite proves end-to-end on heyreason.com (read-only curl); og tags absent on `/web`. | S (½ day) |
| **6** | W6 | Chat-history deletion (scope per Q7) and `data:delete` completeness; CLI session-file policy on the box. | History deletion tested separately with explicit scope; memory untouched by history delete and vice versa. | M (2 days), **blocked on Q6/Q7** |

Release gate for turning `REASON_WEB=owner` on live: offline suite green, verify-skill feature page `features/web.md` + a `bin/web-drive.mjs` cage run, fresh-subagent review, pre-deploy DB copy + `integrity_check`, rollback = flag off (routes 404, channel unregistered; new tables inert). Then owner-only soak before `on`.

Total rough size: ~4 weeks of builder time, 6 PRs, none touching existing conversation ids.

---

## 7. Decisions for the owner (verbatim questions)

1. **New users on Web:** is it acceptable that a never-enrolled number cannot receive a code and must send Reason one text from their phone to join (the same sms: tap invites and events use), with Web sign-in available after that first text?
2. **Desktop joining:** for someone joining from a desktop browser with no phone to hand, do you want a QR code of the sms: link on the page, or just the number to text?
3. **Session lifetime:** 90-day hard limit plus 30-day idle sign-out for Web, with the cookie shared with your pages, events and /ops — or a separate, shorter Web cookie?
4. **One number, two accounts (linq + sendblue):** sign in to the most recently used one and never mention the other, or block Web sign-in for such numbers until you merge them by hand?
5. **Notification default for existing users:** keep "text for timely decisions, routine results wait on Web" as the default for everyone the moment they first use Web, or keep everything on text until they choose?
6. **Memory wording and retention:** the Memory tab can say a fact is "removed from what Reason recalls" but not "deleted everywhere" while the model's CLI session files on the server and the DB backups keep copies. Is that wording acceptable, and do you want a retention rule for those files (none exists today)?
7. **Chat-history deletion scope:** should a user be able to delete their own Web-visible history, and if so does that also blank the model's thread (what Reason can see), the outbox/inbound copies, and the extraction log — or only the Web view? Nothing is built until you answer.
8. **Approvals on Web:** v1 shows "Review details" only and approval stays a typed reply in the conversation. Do you want a one-tap Approve button in a later phase, knowing it would be a new authorisation path beyond the current "typed in their own words" rule?
9. **Boundary line in texts:** when someone switches from Web to texting mid-task, should Reason's next text carry a one-line hint that the full conversation is on Web, or say nothing unless asked?
10. **Flag rollout:** `REASON_WEB=owner` for you first, then `on` for everyone when you say — same as events?

---

## 7. Decisions — the owner's answers (2026-10-26, final)

1. **New users on Web:** yes. A never-enrolled number must text Reason first (the same `sms:` tap invites and events use); Web sign-in is available after that first text.
2. **Desktop joining:** show a QR code of the `sms:` link **and** the number to text.
3. **Session lifetime:** the shared `reason_page` cookie, 90-day hard limit plus 30-day idle sign-out for Web.
4. **One number, two accounts (Linq + Sendblue):** sign in to the most recently used one and never mention the other.
5. **Notification default for existing users:** everything stays on text until the person chooses otherwise.
6. **Memory wording and retention:** "removed from what Reason recalls" is the wording; add a 30-day retention rule for the model's CLI session files on the server.
7. **Chat-history deletion:** **no** history deletion in v1. The control is absent, not shown-disabled.
8. **Approvals on Web:** **no** one-tap Approve. "Review details" only; approval stays a typed reply in the conversation.
9. **Boundary line in texts:** **yes** — after someone switches from Web to texting mid-task, Reason's next text carries a one-line hint that the full conversation is on Web. Once per switch, intent wording, no command phrases.
10. **Flag rollout:** `REASON_WEB=owner` for the owner first, then `on` for everyone when he says — same as events.

## 8. W0 as built (PR `wt/web-w0`)

What shipped, all dark behind `REASON_WEB` (default off):

- `config.web` (`owner | true | false`) and `src/web.js` (`webOn`, `webAllowedFor`, `historyOn`).
- `src/channels/web.js` — the `web` adapter: in-process `send()` (a `message` event, nothing leaves the machine), `findSent` answered from this process's memory and then from the history table through the outbox row, so it is address-bound. Registered by `serve.js` only while the switch is on.
- `messages` table (`conversation_id, role, channel, external_id, outbox_id, text, media, at, deleted_at`) with `(conversation_id, at, id)` index and two partial unique indexes: one per person's message per `(conversation, channel, handle)`, one per outbox row.
- **Writers.** A person's line: one row per held message in `Router.#drainHeld` (their words as heard, not Reason's framing lines), the folded-in text in `Runtime._turn`, and the event-code text in `Router.#claimEvent`. Reason's line: written in `db.markOutboundSent` the moment the outbox marks a row sent (every channel), and in `deliver.js` for the console, which has no outbox. **This differs from §4.3's "runtime assistant line 504"** on purpose: a reply the outbox never managed to send is not something the person was told, so it is not history. Excluded: sign-in codes (outbox keys `esign:`/`wsign:`) and anything to a third party (`to_owner = 0`). Written only while the flag is not off, for every conversation, so the owner's soak builds everybody's history from that day. No backfill.
- `threads.last_channel`, and `upsertThread` never lets `channel='web'` overwrite the route; a web message from a conversation with no thread creates none.
- `Router.deliver` web branch: the conversation comes from `inbound.conversationId` (server side, from the session in W1), `from` is ignored, admission runs against the account's own channel/address, and the resolved id must equal the session's. Refused before admission with `web_off`, `no_session`, `no_account`, `web_not_for_them`, `conversation_mismatch`.
- The model's user line gains ` (web)` after the name on both backends when the message came from web; a text is labelled exactly as before.
- `web.joinNumber(router)` → `contact.liveLineNumber(router)`: the one place W1's join surface (sms: link, QR, "not on your phone?" line) takes its number from. It is the first LIVE channel's number, never a hardcoded string and never the linq adapter, which on the live install is registered but `not_connected`. Owner rule 2026-10-26: Reason is Sendblue only; no one is ever shown a Linq number. Decision 4 (one number, two accounts) is a code-path guard only; no such accounts exist on live. `http.js`'s event and invite routes now use the same helper. Pinned in `test/web-join-number.test.js`.
- `scripts/web-migrate-dry-run.mjs <copy>` — copies the file it is given, snapshots, loads `src/db.js`, snapshots again, reports; refuses `/opt/reason/*`.
- Tests: `test/web-w0.test.js` (24 cases incl. flag-off zero change, tool lists identical, owner-only, isolation, route never stolen, one reply on the triggering channel, retry dedupe, exclusions, findSent) and `test/web-w0-migration.test.js` (old-shaped DB, script on a copy).

Not in W0 (W1+): routes, sessions/CSRF/CSP, the `(web)` hint text after a switch (decision 9 — `last_channel` is its input), notification columns, memory tombstones, site changes.

## 9. W1 as built (PR `wt/web-w1`, 2026-10-26)

Sign-in only, dark behind `REASON_WEB`; nothing on live changes while the flag is unset. Verify-skill
feature file: `.agents/skills/verify-reason/features/web-signin.md`.

- **Routes** (`src/http.js` `webRoute`, only while `webOn()`; otherwise the same flat 404 as a made-up
  path): `GET /web` (sign-in form, or the signed-in landing), `POST /web/signin` (ask for the code),
  `POST /web/code` (type it), `POST /web/signout`. All in `src/pages/websignin.js`.
- **Who a number opens** (`accountForNumber`): `accountsByAddress`, newest `last_seen_at` first, the
  first account `accounts.admit` allows and `webAllowedFor` permits (decision 4 as code; `owner` mode
  = only the owner's). Null for everybody else, and the page cannot tell them apart.
- **Codes**: `requestCode` under `wsign:<conv>` (3 per 15 min per person, 15-min TTL, hashed, once,
  a new one kills the old); texted via `runtime._tell` keyed `wsign:<conv>:<codeId>` (W0 excluded
  the prefix from history), not awaited; the text ends `@<REASON_SITE_URL host> #code`. Wrong tries
  through `events.tryKeyedCode` (new, extracted from `trySigninCode`, same ceilings) under
  `wsign:`/`wsignb:`; 10 requests per browser per hour via `events.signinGate`.
- **Decision 1 + 2**: the join block on every sign-in page — `sms:<live line>?&body=Hi` button, an
  inline-SVG QR of the same link (`src/pages/qr.js`, no dependency, byte mode, level M, versions
  1–10, decoded end to end with macOS CoreImage during the build) and the number written out. The
  number is `web.joinNumber(router)`; no live line → an honest "isn't connected right now" and no
  number. Pinned with the real `LinqChannel` (not_connected) + `SendblueChannel` (live) in both orders.
- **Decision 3**: the shared `reason_page` cookie, `Path=/`, HttpOnly, SameSite=Lax, Secure; 90 days
  hard, and a **30-day idle** limit for Web (`db.pageSessionOwner(token, max, { idleMs })`, new
  optional argument; pages/events unchanged). A paused/removed account, or a non-owner once the flag
  is back to `owner`, is simply signed out (the sign-in page, not a 404).
- **§8 security**: `Origin`/`Sec-Fetch-Site` check against our hosts on every POST; before sign-in
  a double-submit form token (`reason_web_form` cookie, `Path=/web`, 24h) in hidden `f`; signed in,
  `page_sessions.csrf` (new column, `addColumnIfMissing`, minted on first read) in hidden `c`;
  `timingSafeEqual` throughout. CSP (`default-src 'none'`, inline style/script for the theme switch,
  `img-src 'self' data:`, `form-action 'self'`, `frame-ancestors 'none'`), nosniff, no-referrer,
  DENY, no-store on every answer. No og tags. Logs name an outcome, never a number, code or token.
  Sign-out = `endPageSession` + cleared cookie; refused without the secret or from another site.
- **Landing**: "You're in, <name>." + the approved §9 wording as a static section (the once-only
  `web_notice_seen_at` tracking waits for W2's shell) + "Sign out of this browser".
- **Tests**: `test/web-signin.test.js` (18). Drive: `bin/web-drive.mjs` (cage env, FakeChannel).
  Previews: `bin/web-preview.mjs`.
- **Deferred from §4.2 to W2+**: token hashing (`token_hash`) and 24h rotation, the browsers list
  with per-row revoke (also the only sign-out for a session row Web no longer allows), decision 9's
  `(web)` hint. CSP keeps `'unsafe-inline'` until the shell takes a nonce.
- **W5 must settle first**: the per-browser actor (`eventActor`) reads the client address only
  behind Caddy's `X-Files-Domain` marker; proxied through Netlify, every Web visitor would share one
  bucket and a stranger's wrong codes would lock everybody out. Route `/web` through Caddy or trust
  Netlify's client-address header there — before the rewrite.
