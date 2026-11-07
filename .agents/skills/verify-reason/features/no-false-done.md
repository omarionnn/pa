# No false "done" — a reply never says it did what no tool did

Somebody asks for a thing; the tool behind it fails; the reply must not say "I've started the
checkout" or "I made you walking directions". Two real incidents: 10-31 "I've started the Ulta
checkout…" with no checkout running, 11-03 "I made you walking directions…" with no link. Shipped in
#337 (claim check, on main before this release).

Source: `src/said.js` (`checkDraft` `:278`, the claim-check gate `:288`, `unbacked` filtered to quotes
really in the draft `:316`, the rewrite lines `:322-330`, `noteAct` `:197`), `src/config.js:520`
(`REASON_CLAIM_CHECK`: unset = `acting`, `all`, `0/off/false/no` = off), `src/tools.js:9129` (every
`runTool` notes the act; `CLAIM_CHECK_READS` `:400` — searches/lookups such as `web_search`,
`offer_check`, `shop_status`, `flight_search` — never count as acting), `src/runtime.js:586`
(`Runtime._turn` runs the check before the send and recomposes once on a hit).
Tests: `test/no-false-done.test.js` (12) — 12/12 at `8113bcf` (said.js unchanged at `36db733`).

## Sub-features

- **The gate.** With `acting` (default) the check reads a reply only when the turn called a tool that
  acts or makes something (`store_checkout`, `directions`, a send, a call); a chat reply or a
  search-only turn is not held (~2 s saved). `all` reads every reply.
- **What the check is shown.** Their message, every tool this turn in order with DID NOT WORK on a
  refusal, error, block or not-sent message, the jobs on record (checkout runs), and the draft — on
  the subscription (`said_check`, haiku, warm CLI), never the API.
- **Two verdicts.** `not_done`: "It says "<quote>", but nothing you ran this turn did that …" → one
  rewrite saying plainly what did and didn't happen, never repeating a send/call/purchase that went
  through. `no_artifact`: made but the link is missing → the rewrite is handed the links the tools
  returned. A quote the reader invents (not in the draft) is ignored.
- **A real running checkout backs "it's running"** (the record is shown; a clean read sends as written).

## How to get to it (user POV)

"yes get the cerave from ulta" when the checkout can't start; "walk me from Washington Square Park
to Joe's Pizza" when the route fails. They should only ever read what actually happened.

## Driving it with the harness

Offline: `env -i HOME=$HOME PATH=$PATH node --import ./test/paid-key-guard.js --test test/no-false-done.test.js`.

Real claude-cli turn (the real Runtime, MCP tools, harm screen, check and rewrite; a fake Crossmint
that refuses every start; throwaway DB; no API key). Log in with the **test** token only:

```bash
D=$(mktemp -d) && env -i PATH=$PATH HOME=$HOME USER=$USER LOGNAME=$USER REASON_DB_PATH=$D/nfd.db \
  CLAUDE_CONFIG_DIR=$(mktemp -d) CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s reason-test-claude-token -w)" \
  node .agents/skills/verify-reason/bin/no-false-done-drive.mjs ulta      # or directions | chat; --inject; --off
```

2026-11-07 at `8113bcf` (`ulta`, 44 s): tools `offer_check, shop_status, recall, store_checkout`
(did not work ×2), `shop_handoff`; check `{"unbacked":[],"acts":6}` — the draft was already honest;
reply "I couldn't place the order. It's $18.99 and in stock on ulta's page as of just now … Nothing's
been charged." with the product link. `--inject` replaces the draft with the incident's words to see
the check fire and the rewrite land; `--off` is the before.

**End state:** no sent text claims a start/send/make that the tool list shows as DID NOT WORK; on a
hit, `said_check` logs `unbacked: ["not_done"]` and exactly one rewrite goes out.

## Gotchas

- `offer_check` in the `ulta` case really fetches the public Ulta page (a GET, no account).
- The check is a backstop and fails open: a CLI failure logs `said_check_failed` and the draft goes.
- The drive's `REASON_OWNER_NAME` is a throwaway "Omari"; nothing reaches a phone (fake channel).
