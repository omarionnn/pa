# Context first, then ask (REASON_CONTEXT_FIRST, 2026-11-10)

Owner spec (`~/.openclaw/workspace/specs/reason-context-first-1110.md`): before Reason asks the person
anything it finds the answer itself, and when it does ask, the likely answer is inside the question.
Flag `REASON_CONTEXT_FIRST` = off | owner | on (**live: `on`**, switches 2026-11-14; default off; `owner` = the operator's thread only,
never a phone call's prompt). Prompt text only: no new tool, no new code path.

Source: `src/contextfirst.js` (all of it), `src/agent.js` (`contextFirstRules(me)` appended after
`threadingRules` and `foodRules`).
Tests: `test/contextfirst.test.js` (6, offline).

## Sub-features

- **Self-serve order.** This chat → memory (`memory_search`) → connected mail and calendar
  (`gmail_search`, `calendar_events`) → the web (`web_search`). Delivery address from the last 3 food
  receipts, the usual from the last 2 orders at that place, how they sign in from welcome/receipt
  emails, where a business is by searching it. Ask only what no source answers or what is theirs
  to decide.
- **Ask with the answer inside.** Two or three choices in their words, never a numbered menu; when
  they asked for several things, ask which first by name; one question per text; never more than two
  in a row before doing something.
- **Use it quietly.** Never cite the source ("your usual"), never recite what it knows, specifics
  only when the answer needs them, at most one found thing per reply.
- **Confirm what is inferred.** One confirm the first time, then known; recent beats old; two sources
  disagree → ask naming both; never money, a message sent as them, or anything permanent on an
  inference without a yes.
- **Remember.** Confirmed answers saved with context via `remember`; a "no" saved as a signal, not a
  rule, unless they say never.
- **Answer the word they wrote (#594, 2026-11-15; not behind this switch).** One line of the base
  `SYSTEM` prompt in `src/agent.js`, for everyone: a word that names a real thing ("US bonds", an app)
  is answered as that thing, not a similar one; only a word that names nothing real gets a guess, said
  out loud. It narrows words only: acting on a sensible reading of their situation still stands and is
  never "ask first". Offline: `test/answer-literal-word.test.js`.

## Prove

- Offline: `node --test test/contextfirst.test.js` → 6/6. Flag-off `systemFor` is byte-identical
  to the pre-change prompt (owner and non-owner); owner mode reaches only the operator's thread.
- Live: on the live server (OVH, root@15.204.113.250) `grep REASON_CONTEXT_FIRST /opt/reason/.env` → `on`.
  Under `on` the block is in every non-call prompt: a member's and the owner's, empty on a call.
- No model, in process (2026-11-14, `7d5b5f54`, evidence `*-g4-switches`): with `on`, the block for a
  member and the owner, empty on a call. `test/contextfirst.test.js` 6/6 in the misc group 122/122.
- Real model: not driven (no paid runs, no live drive). What the model does with the rules is unproven
  until people live with it (it is `on` for everyone).
