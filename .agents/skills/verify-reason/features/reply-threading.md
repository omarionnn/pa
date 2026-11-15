# Reply threading (REASON_THREADING, 2026-11-10)

Owner spec: it is never unclear what a reply refers to. Flag `REASON_THREADING` = off | owner | on
(default off; `owner` = the operator's thread only, never a phone call's prompt).

Source: `src/threading.js` (all of it), `src/channels/router.js` (`reacted` at the hold, `sends` /
`numbered` / `jobs` / `textCount` in `#drainHeld`), `src/channels/sendblue.js` (`isReaction` on
receive and catchUp), `src/agent.js` (`threadingRules`, tapback rule swap), `src/calls/voice.js`
(`onCall`). Already there before it: `src/replies.js` (answerTarget, latePin, burstLine,
inboundReplyLine), `src/onethought.js` (mid-turn fold-in).
Tests: `test/threading.test.js` (13, offline), `test/flow-threading.test.js` (4, real model),
`test/longtask.test.js:91` (a late job result lands under the text that started it).

## Sub-features

- **Tapbacks that arrive.** Sendblue documents no inbound reaction; its messages API showed ONE live
  (2026-11-06, 1 of 500 inbound) as `is_reaction: true` + Apple's text `Loved “…”`, no target
  handle. `reactionLine` finds the target by the quoted words (never the tapback's own row, never
  another tapback) and tells the turn: 👍 on a yes/no question = yes, 👎 = no, anything else needs
  no answer (NO_REPLY only if nothing else in the turn needs one). Flag off: no line, unchanged.
- **One send, numbered.** Parts H, H_1, H_2 count as ONE text in the burst line; attachments get
  "photo 1, photo 2, PDF 1 (name)". The reply still answers the last part (no new pin).
- **Jobs with their origin.** Up to 5 newest open jobs, each with the text that started it, no ids.
- **Prompt rules.** Referent order (inline reply → concrete reference + memory_search → most recent
  of the kind → most recent list of Reason's), one question naming both when two fit, later text
  wins and says so, older items named concretely (never "above"/"earlier"), stable list numbers,
  two questions → two pinned replies (quote their words when a pin is impossible).
- **Not possible on Sendblue** (docs + 500 live messages): edits, unsends, a tapback's target handle.

## Prove

- Offline: `node --test test/threading.test.js` → 13/13. Flag-off prompt is byte-identical to the
  pre-change `systemFor` (owner and non-owner).
- Real model: the Mac's CLI login is in the Keychain, so the sealed CLI (src/backends/cli.js) is
  "Not logged in" here. Run on the server in a /tmp copy with only `CLAUDE_CODE_OAUTH_TOKEN` passed
  from `/opt/reason/.env`, `REASON_BACKEND=claude-cli`, `REASON_CLI_HOME` in the copy; delete the
  copy after. 2026-11-10: 4/4 (👍 → "took your 👍 as a yes", reminder moved to 4pm; ❤️ on a recipe
  → nothing sent; "the morning one" → "the TAP at 9:10 or the United at 9:40?"; 7pm then 9pm → one
  9pm reminder, "not 7").
- Live (the live server, OVH, root@15.204.113.250): `grep REASON_THREADING /opt/reason/.env` → `on` for
  everyone (2026-11-14; it was `owner` at launch); a reaction shows in the turn as
  "[this is a tapback, not a typed message".
