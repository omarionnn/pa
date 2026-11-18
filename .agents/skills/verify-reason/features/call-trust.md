# Call trust — caller ID for low-risk things, a spoken passphrase only when something needs it

**Live state (switches.txt, 2026-11-14):** `REASON_CALL_TRUST=owner` (the operator's own calls only,
`accounts.featureOwner`). Code default `off` = as before: caller ID is never trusted, anything
consequential waits for a text after the call (`src/calls/verify.js`). `on` = every account's own calls.
Commit 3658a30d (#567).

## Sub-features
- **Levels, decided in code from the tool, never by the model** (`src/calls/calltrust.js` `levelOf`):
  - LOW (caller ID is enough, inbound own call from the account's own number, not forwarded, carrier
    attestation A or none — `REASON_CALL_TRUST_ATTEST=pass` makes "none" not count — one person on the line,
    never a call Reason placed): a calendar event with no invitees, a free booking, a voice note to self.
  - PASSPHRASE (`PASSPHRASE_TOOLS`, `NOW_HELD`, `SENSITIVE_READS`): anything reaching another person
    (message_send, call_place, gmail_send…), changes and deletes (calendar_change/delete,
    call_recording_delete…), fee bookings, reading codes, money, bank or travel-document details aloud.
  - TEXT (`TEXT_ONLY`): money, saved logins, sign-ins, account jobs, todo_approve, permissions, operator
    tools — never by voice, passphrase or not; the usual Face ID / typed yes in the thread after the call.
  - Open: lookups, notes, reminders, a text to themselves (never held).
- **The spoken ask** (fixed lines, `LINES`): "Say your passphrase and I'll do it now, or I'll do it by text
  right after." The next words are checked in code (`src/callpass.js`), replaced by a marker before they are
  kept anywhere (transcript, turn log, judges, logs, the model); a match unlocks that one action for 5 min
  (`GRANT_MS`); a miss gets one more try (`MAX_TRIES_PER_ASK` 2), three tries a call, then the text after.
  With none set, a notice (at most twice ever) says how to set one.
- **Setting it** (3–8 words, hashed with scrypt in logins.db): text "set my call passphrase" → a one-use
  link to Reason's own page `/web/call-passphrase/<token>` (`src/pages/callpassphrase.js`, `src/http.js:451`;
  cross-site POST → 403, second save → 404); or say "set my passphrase" on a call, then a typed yes. The
  read-back says only the word count. "change my call passphrase" → change link; "remove my call
  passphrase" with none → "You don't have a call passphrase set…". Exports say it is set, never a word.

## How to get to it (user POV)
(Operator only while live is `owner`.) Text "set my call passphrase", open the link, type 3+ words. Then on
a call from your own phone, ask Reason to text someone: it asks for the passphrase, you say it, it sends.
Ask for something with money: it says it will do that by text after the call.

## Driving it with the harness
Offline, through the slot gate: `test/call-trust.test.js test/flow-trust.test.js test/trust.test.js`
(in calls-all.log 2026-11-14, all pass).
No-model probe (levels, owner gating, set-by-text link, hashing, export):
`node .agents/skills/verify-reason/bin/call-probe.mjs trust` → `all ok`. With a cage, under
`bin/caged.sh env` and `REASON_VERIFY_RUN` set, add the cage port (`… trust 8843`) to also GET the link page
and POST the save (cross-site 403, same-origin 200, one-use 404) on the cage's own logins.db. The cage
has to be started with `REASON_CALL_TRUST=owner` (or `on`): the page route answers a flat 404 while the
switch is off (`src/http.js:453`), and with no `.env` it is off, so the four page steps FAIL with 404.
2026-11-18 at `18b47891`: off → 5 FAIL; `REASON_CALL_TRUST=owner bin/caged.sh start` → `all ok`.

Live: **paid**. The spoken check needs a real own call (operator's phone, ~2 min ≈ $0.30–0.50 Cartesia +
Twilio). Read-only after: `journalctl -u reason | grep -E 'call_trust_'` on the live server
(OVH, root@15.204.113.250); never read logins.db.

## Gotchas
- Caller ID never counts on a call Reason placed, a contact's number, a withheld or forwarded number, or a
  B/C carrier attestation (how a spoofed call usually arrives).
- Any other account's "set my call passphrase" with the switch at `owner` is an ordinary turn (no link).
- Never say a real passphrase into a test recording: the call audio is filed to the thread.
