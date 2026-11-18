# Invites: a link for a friend, made for a named person (#104, #156, #159, #162, #589, #603)

Somebody who has Reason asks for an invite; Reason texts back one link to pass on. The friend opens it,
sees the inviter's card ("free for you, for good"), and gets their own Reason. A link can carry the
friend's first name on its card picture, and nowhere else.

**Live switches (read 2026-11-18):** `REASON_INVITES_OPEN` unset (off): only the operator, and the people
he turned on one by one (`invite_allowances.enabled`, `scripts/grant-invites.js`), see the invite tools;
everybody else's model is never told invites exist (`invitesOpenFor`, `src/tools.js:887`). Under the
monthly free tier, only somebody free for good may invite (`src/tools.js:889-891`).
`REASON_INVITE_START=on` + `REASON_WEB_SETUP=on`: the page's button goes to the site's `/start/?invite=<token>`
web setup instead of a text with the claim code (`startOn`/`startUrl`, `src/invites.js:42-60`); the
texted claim code keeps working for links already handed out.

Source: `src/invites.js` (rules at the top: two invites each by default, `DEFAULT_INVITES` in
`src/db.js`; one link per invite, single use, never expiring; opening spends nothing; spent only in
`db.redeemInvite` in the same transaction that makes the account), `src/invitecard.js` (the card picture,
one per inviter name + invitee name), `src/channels/router.js` `#claimInvite` (the claim text from a new
number), `src/websetup.js` `claimInviteFromText` (the web-setup path), `src/plan.js` `grandfathered`
(an invitee of somebody free for good is free for good), tools `invite_link_create`, `invites_list`,
`invite_link_cancel`, `invite_request_more` (`INVITE_TOOLS`, `src/tools.js:880`).
Routes: `GET /i/{token}` and `/p/i/{token}` (the page, a read), `GET /i/{token}/card.png` (the card).

## What a person sees

- **Ask for an invite, no name said** → `invite_link_create` answers `needs_for`; Reason offers once, in
  its own words, to put the friend's first name on the card. A name in the ask ("an invite for Ama")
  makes the link at once, no question. "No one in particular" (`for_nobody`) → a plain link, no fuss.
- **The link** comes alone on its own line, so forwarding it shows the card picture.
- **Every invite left is already on an unused link** (#603): the same name offer, never `none_left`.
  A name → their oldest unused link made for nobody is cancelled and a fresh one is made for that name
  (an old link may already be in somebody's hands, so it is never renamed in place). No name → that
  oldest link handed back as it is, nothing cancelled. The count never changes.
- **The friend opens the link**: 200 page, the inviter's card; opening, previews and forwards spend
  nothing. With `REASON_INVITE_START` the button leads into the web setup, whose first text spends the
  invite; otherwise the button opens a text to Reason with the claim code written in, and that inbound
  text claims it (the account is made through the ordinary admission path; harm screen and onboarding
  run as for anybody). A second number with the same code is refused (`invite_refused: redeemed`).
- A made-up token → 404.

## Drive

- Offline: `test/invite-for-name.test.js`, `test/invite-for-name-review.test.js`, `test/invite-reuse.test.js`,
  `test/invites.test.js`, `test/invites-dark.test.js` (66/66 at 18b47891); `test/invite-start.test.js`,
  `test/websetup.test.js`, `test/websetup-rest.test.js` (45/45).
- Cage, real HTTP + the real webhook, no model, nothing sent (2026-11-18, evidence `*-invites-live`): own
  cage (`REASON_VERIFY_RUN`, port 8861), then from the repo root under `caged.sh env` with
  `REASON_MASTER_NUMBER=$REASON_VERIFY_OWNER`, a drive that calls `runTool("invite_link_create", …)` as the
  owner and as a granted person, GETs the page and card, and posts the claim text (`invites.joinText(claim_code)`)
  from a new number to `/channels/sendblue/webhook` with the cage secret. 14 checks, all ok: no name →
  `needs_for`, no link; `for_name` → one link; page 200 html, card 200 PNG; three opens leave it `unused`;
  made-up token 404; all-on-unused-links → the offer, not `none_left`; a name → oldest `canceled` + a fresh
  named link, count unchanged; claim → account with `invited_by`, invite `redeemed` (serve.log
  `invite_joined`); the invitee `grandfathered` under `REASON_FREE_TIER=monthly`; the same code from a
  second number → no account (`invite_refused`). The drive never prints a link, token or code.
- Not provable here: the site's `/start` pages (heyreason.com, Netlify) and Messages' card preview of the
  link. Live read (2026-11-18, counts): 26 invites, none made for a name yet; 4 accounts came in by invite.
