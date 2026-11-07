# Security boundaries — your files, your calls, your health line, your delete

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

## How to get to it (user POV)

None directly — "send me that recording as a voice note", "put the report in my Drive" (their own
file works, nobody else's does); ringing Reason's number; asking for everything to be deleted.

## Driving it with the harness

Offline (`env -i HOME=$HOME PATH=$PATH node --import ./test/paid-key-guard.js --test …`):
`test/driveorg.test.js` (37, own-files for `drive_upload`), `test/no-elevenlabs.test.js` (4),
`test/health-redact.test.js` (5), `test/data-coverage.test.js` (5) — all pass at `8113bcf` and
`36db733`.

No model: `bin/recall-figures-drive.mjs` ([recall.md](recall.md)) steps "ownFile(database) →
not_theirs" and "voice_note_send of the database → refused, nothing sent".

On the cage (2026-11-07): `curl -s http://127.0.0.1:$P/health` → `owner: null`, `holding: []`, every
monitoring key present; `POST /calls/elevenlabs/inbound` → `404` (the route is gone since #359).

**End state:** a model-chosen path outside their own files → `not_theirs`, nothing sent or uploaded;
the old ElevenLabs routes → 404; a signed-out `/health` → no number, name or
conversation id in it.

## Gotchas

- `/health` on the cage still shows Reason's own line numbers (`channels[].number`); that is by design.
