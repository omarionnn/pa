# Social sign-in (REASON_SOCIAL_SIGNIN, 2026-11-10)

Owner spec ("Reason Social Sign-In Prompt"): a site that signs in through the person's Google,
Apple, Facebook or Microsoft account. Flag `REASON_SOCIAL_SIGNIN` = off | owner | on (default off;
`owner` = the operator's conversation only). Live: `owner`.

Source: `src/socialsignin.js` (all of it: flag, rules, `normalizeCode`, `providersOffered`,
`PROVIDER_BUTTON_JS` / `clickProviderButton`, `providerOf` / `sitesThrough`, the 30-day
`social_declines`, `signInAgain`), `src/agent.js` (the rules block right after the never-a-password
rule), `src/tools.js` (`signin_provider`; `provider` on `signin_link` / `signin_open`; the
sign-in-again on `signin_status` recheck; `socialToolVisible`), `src/signin-remote.js` (button
pressed on Start, `cleanCodeFor` on typed text, provider to the check, the "unlocks" note),
`src/signin.js` (`checkAndRecord` carries the provider), `src/db.js`
(`connected_accounts.provider`, written only with a signed-in reading; `liveSigninsFor`),
`src/restcrypt.js` (that column in SENSITIVE2), `src/signin-window.js` + `src/signin-cli.js`
(`REASON_SIGNIN_PROVIDER` / `--provider` into the window), `src/serve.js` (startup line).
Tests: `test/social-signin.test.js` (24, offline), `test/social-signin-rest.test.js` (1, sealed at rest).

## Sub-features

- **The rules** (`social.RULES`, one block, flag-gated per person): earned through a real task,
  one line, "your Google login" (never "OAuth"/"social provider" to the person), never during
  onboarding / mid-vent / late at night / when the task needs no sign-in; infer from the sign-in
  page + welcome/receipt mail, then confirm; a no holds 30 days; never a password / code / card in
  the chat — the secure link; two-step order (phone tap > emailed code Reason reads > forwarded
  text), one-line expectation, one more code may come, fails twice → switch once → stop and say;
  finish first, then mention once what it unlocked; sign back in yourself; trust rules (no curiosity
  browsing, never change passwords/security/recovery/connected apps, never grant a new app, money /
  messages-as-them / permanent still need a yes, honest answer + how to revoke, Google ≠ Gmail).
- **The record.** `connected_accounts.provider` (sealed with REASON_ENCRYPT_REST2) is written only by
  a probe that found the site signed in. `signin_status` rows carry `provider` on a live sign-in.
- **The no.** `signin_provider declined` → `social_declines` (per person, per provider);
  `ask_check` says `ask_allowed` / `days_left` and which sites already go through it.
- **The button.** `signin_link` / `signin_open` with `provider`: the page opens with that button
  pressed (`PROVIDER_BUTTON_JS`: visible button/link whose own text names the provider with
  continue/sign/log/use/with/account/via, never a form field, never a long paragraph). No such button:
  the site's own form, as before, and the note says so.
- **Codes.** A typed text that looks like a code, into a focused code box (or the one code box when the
  edit came with a tap): "G-123 456" → "123456"; numeric boxes digits only; maxlength honoured.
- **A lapse.** `signin_status { recheck }` reads the provider BEFORE the probe; signed out + a provider
  → `signInAgain` (sign-in page, button, probe again). Signed in: nothing to tell them. Still out:
  the result says to send a fresh link with that provider and the one-line expectation.

## Prove

- Offline: `node --test test/social-signin.test.js test/social-signin-rest.test.js` → 25/25.
  Flag off: `systemFor` has no "your Google login", `toolsFor` has no `signin_provider`, a `provider`
  on a link is dropped, typed text is untouched.
- Live: `grep REASON_SOCIAL_SIGNIN /opt/reason/.env` → `owner`; startup journal line
  `social sign-in: owner only (REASON_SOCIAL_SIGNIN)`;
  `sqlite3 -readonly data/reason.db "SELECT name FROM pragma_table_info('connected_accounts')"` lists
  `provider`; `social_declines` exists.
- **Unproven (2026-11-10):** no real site has been signed in to through a real Google/Apple/
  Facebook/Microsoft button here. `PROVIDER_BUTTON_JS` has run only against the fakes in the test;
  which real sites' buttons it finds, what Google's own page does inside the link (a Yes tap on the
  phone, a code), and whether a lapsed site session comes back through Google's cookie alone are all
  untested against the network. Treat as built, not working. No real model run either (no API
  credit; claude-cli only).
