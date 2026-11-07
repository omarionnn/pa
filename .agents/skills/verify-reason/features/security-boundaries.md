# Security boundaries — your files, your calls, your health line, your delete, your card

Four things a person never sees working and would only notice broken: another person's file
reaching them, a stranger pretending to be their phone ringing in, the public `/health` naming them,
and a delete that leaves something behind. All shipped on main before the 11-07 release (security
audit leads): #345, #350, #352, #353. Their neighbours: the private-network guard (#348,
`src/netguard.js`) and consent in code (#349, [spend-cap.md](spend-cap.md)).

## Sub-features

- **Own files only (#345).** `src/ownfiles.js` `ownFile(conversationId, path)` (`:93`) is the only door
  for a path the model hands a tool: `voice_note_send` (`src/tools.js:11030`) and `drive_upload`
  (`:16575`). A path is theirs only when Reason can show it made or kept it for THIS conversation —
  a file a tool call of theirs wrote during that call (`noteMade` `:39`, an echoed path is never
  adopted), their `documents` row, their own call's recording (by the `calls` table), or an attachment
  already sent to them — and it sits inside Reason's file roots. The database, browser profiles and
  everything else under the data dir are nobody's. Refusal: `status: "not_theirs"`, "… is not a file
  Reason made for this person", never saying whether somebody else's file exists.
  `browser_screenshot` never writes to a model-given path.
- **The inbound-call personalization webhook (#350) is gone with ElevenLabs (#359, 2026-11-07).**
  `/calls/elevenlabs/inbound`, `/llm` and `/post-call` all answer `404` now; every call is GPT-Live
  over Twilio (`test/no-elevenlabs.test.js`). Twilio's own signature check guards the inbound route
  ([gptlive-calls.md](gptlive-calls.md)).
- **`/health` names nobody (#352).** `src/http.js:164` → `health({ full: operatorSignedIn(req.headers) })`
  (`:2019`): without the operator's signed-in `reason_page` session `owner` is null, `holding` rows
  carry no `conversation_id`, contact limits read `scope: "contact"`, `why` loses addresses; every
  key and count stays. Doctor reads it that way (SKILL.md Doctor).
- **Delete takes everything (#353).** [data-delete.md](data-delete.md).
- **Connect links finish only in the asker's browser (lead 1, #358).** Every `*_connect` link
  (GitHub, Google, Spotify, X, Uber) is Reason's own start page `/connect/start?state=…`
  (`src/connectgate.js` `startLink` `:37`, called from each provider's `authorizeUrl`); the provider's
  address sits on the state row (`oauth_states.authorize_url`) and is only handed out with a 302 to a
  browser whose `reason_page` session is the asker's and came from a trusted sign-in: Reason Web
  (`wsign:`) or this gate (`connect:`) only (`TRUSTED_SIGNIN`). An event, album, directions,
  private-page or /ops session, even the asker's own, gets the code step. Any other browser gets "Text me the code"
  (`connectStartRequest` `:91`): a GET never texts, the POST texts a six-digit code to the thread that
  asked for the link, POSTs must be same-origin (`sameOrigin`, else `403`, so a page elsewhere cannot sign a victim's browser in as the asker), the right code sets the session cookie (`Path=/`) and 303s on to the provider.
  Every callback route in `src/http.js` calls `refuseForeignBrowser` (`:58`) first: a browser not
  signed in as the state's conversation → `400`, the state spent, no token exchange, nothing texted.
  A provider `error=` still answers as before. Old links (straight to the provider) are refused.
  The other gates that set the shared session at `Path=/` refuse a cross-site POST too (`403`): the
  walking-directions gate (`src/pages/directions.js`) and the private-page gate on the files domain
  (`src/http.js` `pageRequest`), so no page elsewhere can sign a victim's browser in as the asker.
- **Sign-in links start only on the person's own browser (lead 6).** `/s/<token>` Start uses the
  same proof (`connectgate.browserConversation`, exported); a new browser gets a code texted to the
  person's own thread, counted under connect's `proofPage` id, and the right code leaves the same
  `connect:` session, so that browser is remembered for later sign-in and connect links. A cross-site
  code POST → `403`. [signin-link.md](signin-link.md).
- **No payment details in anything a call is handed (lead 31).** `src/calls/payments.js`
  `checkCallForPaymentDetails` scans goal, facts, `ask`, `approved_terms` and every `requirements`
  key and value; `checkBriefForPaymentDetails` scans the final brief in `call_place` too (a redial
  from `askWhetherItWentThrough` carries the old brief's requirements forward, an errand leg takes
  its questions from the errand row). A hit → `status: "payment_details_refused"`, nothing dialled,
  no call row, the value never echoed. Before this only goal and facts were scanned, and a card in
  `requirements` was dialled and rendered into the voice prompt.
  **Explained calmly (lead 31 follow-up).** One instruction, `calmWhy` in `src/calls/payments.js`,
  rides in three places the model reads — never a script, never a regex verdict: the refusal note
  (`error`) of `call_place` and of `timer_set` `then_call` (the owner asked, by text or on his own
  call — the voice says the backend's result); rule 2 of `callRulesFor` (src/calls/provider.js), so the
  GPT-Live line voice (`lineTalkInstructions`) and Reason's third-party call turn (`thirdPartyFrame`
  via `thirdPartyContext`) get it when THEY ask for a card; and the `say` of a declined proposal in
  `src/calls/commit.js`. It says: tell them, in your own words, Reason doesn't share or ask for card
  or account details on calls, to keep their (or Omari's) money safe; not an error, no blame, not the
  same way twice; then offer another way (call without them, a pay link). The scheduled-call fallback
  text (`unplacedCallLine` in src/runtime.js) is code's own words and is unchanged.
- **Only he instructs a remote builder (lead 34).** `src/tools.js` `remoteRefusal` refuses
  `remote_start`, `remote_say` and `remote_decline` (`BUILDER_INSTRUCTIONS`) on any turn whose
  `ctx.kind` is not `"user"` (a missing kind counts as `"event"`): `blocked: "not_his_turn"`, nothing
  sent, no builder turn. A notice sweep built from mail/calendar can no longer start or steer one.
  `remote_say` also cannot answer a job waiting on a risky yes (`blocked: "risky_ask_pending"`,
  pointing at `remote_approve` / `remote_decline`); left without `job_id` it goes to the newest
  `needs_you` job with no `risky_action` (`db.remoteJobAwaitingAnswer(c, { withoutRisky: true })`).
  `remote_approve` keeps its exact-action confirmation; `remote_list`/`remote_stop`/`remote_page`
  are unchanged.

## How to get to it (user POV)

None directly — "send me that recording as a voice note", "put the report in my Drive" (their own
file works, nobody else's does); ringing Reason's number; asking for everything to be deleted;
"connect my GitHub" and opening the link (signed in to Reason Web → straight to GitHub; a new browser
→ the code page; a link someone else forwarded → their Reason gets nothing).

## Driving it with the harness

Offline (`env -i HOME=$HOME PATH=$PATH node --import ./test/paid-key-guard.js --test …`):
`test/driveorg.test.js` (37, own-files for `drive_upload`), `test/no-elevenlabs.test.js` (4),
`test/health-redact.test.js` (5), `test/data-coverage.test.js` (5) — all pass at `8113bcf` and
`36db733`.

No model: `bin/recall-figures-drive.mjs` ([recall.md](recall.md)) steps "ownFile(database) →
not_theirs" and "voice_note_send of the database → refused, nothing sent".

No model, no phone: `bin/call-payments-drive.mjs` under `caged.sh env` with a fresh temp
`REASON_DB_PATH` (third-party number, a yes recorded with a stand-in judge, fake provider) — a card
in a requirements value/key, cvv in `ask`, a card number in `approved_terms` or facts → refused,
nothing placed; an ordinary ask-only call with requirements and a "do they take card" question still
goes. 8 ok on `sec/lead31` 2026-11-07; on `c55094b` (main before) the requirements card was placed.
Since `sec/lead31-explain` (2026-11-07) each refusal also checks its note carries the calm-why
instruction (no quoted script, no `say` field), and the placed call's rules, the GPT-Live line voice
prompt and the real `thirdPartyContext` system prompt carry it; `--transcript` prints what the model
sees and what a STUB model following it would say (echoes the instruction — not real model speech;
no model runs). The yes now follows the pinned-target flow (`call_place` without a confirmation_id →
`use_target` → `confirm_request`); before that fix the ordinary call step failed on main too.
17 ok on a cage (port 8885).

No model, no builder: `bin/remote-gate-drive.mjs` under `caged.sh env` with a fresh temp
`REASON_DB_PATH` + `REASON_REMOTE_ROOT`, `REASON_REMOTE_BUILD=1`, `REASON_OPENCLAW_BIN=/nonexistent/…`
(recording `spawnImpl`, nothing ever runs) — event-turn `remote_start`/`remote_say`/`remote_decline`
→ `not_his_turn`; `remote_say` on a risky ask (with or without `job_id`) → `risky_ask_pending`, ask
kept; his own decline and his answer to a plain question still go. 12 ok on `sec/lead34`
2026-11-07; 11 FAIL on `ae913c7` (main before: event-turn start went through). Offline:
`test/remote.test.js` (75).

No model, no real provider: `bin/oauth-connect-drive.mjs` on a cage (fake GitHub from
`test/fixture-github.js` + `bin/fake-sendblue.mjs`). Start the fakes first, then the cage with the
same `GITHUB_*` values, then drive with `caged.sh env` exported (`set -a; eval …; set +a` — the env
lines carry no `export`, and without it the drive writes the worktree's own `data/reason.db`):
`node bin/oauth-connect-drive.mjs github $S/gh.url &` · `bin/fake-sendblue.mjs 8882 $S/sb.jsonl &` ·
`REASON_VERIFY_FAKE_SENDBLUE=http://127.0.0.1:8882 GITHUB_BASE=$GH GITHUB_API_BASE=$GH
GITHUB_OAUTH_CLIENT_ID=cage GITHUB_OAUTH_CLIENT_SECRET=cage REASON_PUBLIC_URL= caged.sh start` ·
`node bin/oauth-connect-drive.mjs drive http://127.0.0.1:$P $S/sb.jsonl`. 11 ok on `sec/lead1-oauth-binding`
2026-11-07 (port 8881): no-cookie start `401` + callback `400`, 0 tokens; someone else's session the
same; Text me the code → 1 text to the asker's number; the right code posted cross-site (`Origin` elsewhere) → `403`, no cookie; code from the page → `303` + `Set-Cookie reason_page`;
callback `200`, 1 token; next link same browser → `302` straight to GitHub. Offline:
`test/oauth-binding.test.js` (11; 1 pass / 9 fail of the first 10 on main before the fix).

On the cage (2026-11-07): `curl -s http://127.0.0.1:$P/health` → `owner: null`, `holding: []`, every
monitoring key present; `POST /calls/elevenlabs/inbound` → `404` (the route is gone since #359).

**End state:** a model-chosen path outside their own files → `not_theirs`, nothing sent or uploaded;
the old ElevenLabs routes → 404; a signed-out `/health` → no number, name or
conversation id in it; a connect callback from any browser but the asker's → `400`, no token saved.

## Gotchas

- The drive's asker needs a `threads` row, not just an account: deliver routes by the thread
  (`src/deliver.js` `whereTo`), and without one the code goes to the cage's console, not the fake.
- The fake GitHub only exchanges `code=good-code`; any other code is `token_exchange_failed`.
- `/health` on the cage still shows Reason's own line numbers (`channels[].number`); that is by design.
