# The new number — a contact card for people who texted the old one

Reason's texting line moved on 2026-10-23 (~15:50 UTC) from the shared Sendblue +1 808 number,
which is gone, to the dedicated +1 656 216 7455, which is inbound-only: nobody can be told in
advance. So the first time somebody who texted Reason before the switch texts the new number, they
get Reason's contact card, one line ("heads up — this is my new number, the old one's gone. tap my
contact card and choose Add to Existing Contact → Reason…"), and then their message answered as
usual — in front of the turn, never instead of it. Once per person, ever. Shipped in #93.

Source: `src/linechange.js` (`isReturning`, `tellNewLine`, `LINE_CHANGE_LINE`),
`src/channels/router.js` (`#tellNewLine`, called in `deliver` right after the inbound row is
claimed, so a retried webhook never gets there), `src/db.js` (`line_change_cards`,
`lineChangeDue`, `claimLineChangeCard`, `recordLineChangeCard`; the owner is seeded as done),
`src/config.js` (`REASON_LINE_CHANGE_AT`, default `2026-10-23T15:50:00Z`), `src/contact.js`
(the card is `GET /reason-<sha8>.vcf` by address — content-addressed since 10-25, `/reason.vcf` still an alias). Tests: `test/linechange.test.js` (5/5 at `587f67a`).

## Sub-features

- **Who is returning is a database fact:** a `sendblue` conversation with at least one inbound
  received before `REASON_LINE_CHANGE_AT`, and no `line_change_cards` row. Somebody new never sees it.
- **Once is a row, claimed before anything is sent** (`INSERT OR IGNORE`). A duplicate webhook, a
  retry or a second text in the same burst finds the row and goes straight to its turn.
- **A failed card is not retried.** The row records `card_ok = 0` and `card_why`; the line still
  goes; the message is still answered.

## How to get to it (user POV)

Somebody who used to text the 808 number texts the 656 number for the first time.

## Driving it with the harness

Offline: `node --test test/linechange.test.js`.

On the cage (2026-10-24): seed one pre-cutoff inbound for a made-up number, then post as that
number. `REASON_AUTO_ADMIT=1` in `.env` lets the stranger in (a worktree with no `.env`: start the
cage with `REASON_AUTO_ADMIT=1 REASON_MASTER_NUMBER=+12025551234 bin/caged.sh start`, or the
stranger lands in the approval queue and no `line_change_told` is logged).

```bash
cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node --env-file-if-exists=.env -e '
  const accounts = await import("./src/accounts.js");
  const { DatabaseSync } = await import("node:sqlite");
  const conv = accounts.conversationIdFor({ channel: "sendblue", address: "+12025550123" });  // dm:sendblue:+12025550123
  new DatabaseSync(process.env.REASON_DB_PATH).prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, text) VALUES (?,?,?,?,?)")
    .run("sendblue", "verify-old-808-1", conv, Date.parse("2026-10-20T15:00:00Z"), "hey (to the old number)");
'
cd .agents/skills/verify-reason
node -e 'console.log(JSON.stringify({content:"hey is this still reason?",number:"+12025550123",from_number:"+12025550123",is_outbound:false,status:"RECEIVED",message_type:"message",message_handle:"verify-lc-"+Date.now(),date_sent:new Date().toISOString()}))' | bin/inbound.sh -
# wait for the turn, then a second message from the same number (new handle), then:
bin/peek.sh sql "SELECT * FROM line_change_cards"
```

**End state.** `serve.log`: `{"inbound":…,"auto_admitted":"+12025550123"}` then
`{"line_change_told":"dm:sendblue:+12025550123","card":"failed","card_why":"sendblue is not connected…","line":"failed"}`
(the cage cannot send — that is the cage holding; with no `.env` the why is `REASON_PUBLIC_URL is
not set, so there is no address to serve the card from` — same pass, 2026-10-27), then the turn. `line_change_cards` has one row
for that conversation with `card_ok = 0` and the why; the second message adds no row and no
`line_change_told` line.

**Live, read-only.** `journalctl -u reason | grep line_change_told` and
`SELECT count(*), sum(card_ok=1), sum(card_ok=0) FROM line_change_cards`. On 2026-10-24 (live at
`587f67a`) the only row was the owner's seed, there was no `line_change_told` yet, and 5 sendblue
conversations with pre-cutoff inbound were still due — the first of them to text the new number is
the first real proof that the card is delivered.

- 2026-11-14 (`7d5b5f54`, cage 8844, evidence `*-g4-line-change` + `*-g4-cage-fake-ok`): `contact-card.mjs --live`
  all ok (`/reason.vcf` and the hashed path 200, brand PHOTO, NOTE, REV, `no-cache`) once the cage was
  restarted with fakes (the first try against the earlier cage returned 404s); seeded pre-cutoff inbound →
  `line_change_cards` row `card_ok=1`, a hand-moved one `card_why` "moved over by hand before this existed".
  `test/linechange.test.js` (5) passes.

## Gotchas

- **The card send is real on live.** Never drive this on the live server (OVH, root@15.204.113.250); a POST there texts a real person.
- **Only `sendblue` conversations count.** A Linq or console conversation never gets the card.
- **Moving the cutoff** (`REASON_LINE_CHANGE_AT`) changes who is "returning" for everyone at once.
