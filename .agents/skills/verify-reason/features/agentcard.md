# AgentCard — a card kept in a vault, and buying things with it

Somebody stores a card once, on AgentCard's own page, locked with their own passkey. Reason never
sees the number. After that Reason can shop real shops — show the real cart with the real total,
ask, and only then pay — with two answers between wanting something and paying for it: the
owner's yes in the thread, then the passkey on their own phone.

Source: `src/agentcard.js` (the API client, the webhook signature, the decline map),
`src/tools.js` (`vault_enroll`, `purchase`, `purchase_confirm`, `purchase_track`;
`agentcardConnectionFor` / `agentcardUserFor`; the `buy_things` capability line), `src/http.js`
(`POST /agentcard/webhook` → `agentcardWebhookRequest`), `src/db.js` (`agentcard_users`,
`agentcard_purchases`, `agentcard_events`), `src/trust.js` (the gate `purchase_confirm` sits behind).
Tests: `test/agentcard.test.js` against `test/fixture-agentcard.js`, a fake AgentCard that answers
every route the real one documents — no key, no network, 35 tests.

**Production credentials went live on the Hetzner instance on 2026-10-12 ~03:03 ET.** The org token
answers `"sandbox":false`. The webhook destination was registered at AgentCard as
`https://reason.tail3753c7.ts.net/agentcard/webhook` — Hetzner, never the Mac. **Re-check it at
AgentCard before relying on it: on 2026-10-14 it had never delivered a single event** (the
registered URL carried a trailing dot and the subscribed events were not the `vault.*` ones).
Nothing in source can prove this either way; only AgentCard's dashboard and an `agentcard_events`
row on Hetzner can. (An older destination on `ubuntu-4gb-nbg1-2.tail3753c7.ts.net` is dead: that
hostname no longer resolves.)

## Sub-features

- **One link per person, never a second for somebody who already has a card.** `vault_enroll`
  cashes in a finished link first (reads the session, exchanges it) and only mints a new one for
  somebody with no connection and no card. The result carries `mode: "live" | "sandbox"`, and when
  live it says so and says that a card stored earlier — through an earlier link, under earlier or
  sandbox credentials, or one they can see in their AgentCard app — is NOT reachable until THIS
  link is opened. "Never tell them not to add it" is in the note for a reason (see Gotchas).
- **Two tokens, kept apart by name.** The organization token mints sessions and reads cards; a
  purchase runs as ONE person on a token minted from their own exchanged vault link. `/buy` refuses
  the org token outright.
- **The card is never here.** What comes back is `user_id`, brand, last four, expiry. There is no
  code path that could receive a number.
- **Shopping cannot charge.** `purchase` is the `/buy` loop: `needs_input` / a cart with a `hash`.
  Branches on `status`, never on `reply`.
- **One confirm, behind the gate, pinned to the cart.** `purchase_confirm` needs a spent yes
  (`src/trust.js`) and sends the exact cart hash; a moved price answers 409 with a fresh cart that
  has to be shown and agreed to again. A passkey pause (`vault_approval_required`) charges nothing
  and the same yes finishes it. `sandbox_mode` is a credential setting, not a refused card.
- **Webhooks are the record.** `AgentCard-Signature: t=…,v1=…` is HMAC-SHA256 of `${t}.${rawBody}`
  under the destination's own secret, constant-time compared, refused past the replay window.
  No `AGENTCARD_WEBHOOK_SECRET` → every delivery is 401 `{"error":"rejected: no
  AGENTCARD_WEBHOOK_SECRET on this machine"}` (fails closed). Every refusal is
  `{"error":"rejected: <why>"}` from `verifyWebhook`, logged as `agentcard_webhook_rejected`. Events are deduplicated on
  id. `vault.session_linked` attaches the user to whoever the link was sent to and exchanges it;
  `vault.card_stored` says "card saved — Visa ••••1234" in the thread; an approval moves the row
  and stays quiet; a decline or expiry is said.
- **Several people, several vaults, nobody can spend anybody else's.** Everything is keyed on
  `conversation_id` and the session Reason minted, never on anything the payload claims.
- **The capability line is three honest answers:** not set up on this install / can buy but this
  person has no card yet / live with the card they stored. Where AgentCard is configured, "add my
  card" goes to the vault and Stripe's setup page is never offered (`baa36bd`, `920f562`).

## How to get to it (user POV)

"Help me buy the Walmart 18 pack", "add my card", "order the usual". First time: Reason texts one
vault link on its own line; they tap it, type the card, Face ID. Then: Reason shows the cart and the
total, waits for a yes, and their phone asks for the passkey. Later: "where's my order".

## Driving it with the harness

**The proof is offline, and that is where the money paths live** — the fixture returns real carts,
real hashes, real declines, and the gate, caps, ledger and webhook handler all run for real:

```bash
cd ~/Desktop/pa
node --test test/agentcard.test.js        # 35/35 at ef7040a
```

**The cage cannot buy anything, by design.** `caged.sh start` blanks `AGENTCARD_CLIENT_ID`,
`AGENTCARD_CLIENT_SECRET` and `AGENTCARD_WEBHOOK_SECRET` for the server, and `caged.sh env` prints
the same blanks for an in-process drive — **export every line it prints**, because
`--env-file-if-exists=.env` never overrides a variable already in the environment, and that rule
is the only thing between `runTool` and the real `.env`. On 2026-10-12 an in-process
`vault_enroll` driven with only the database exports minted a REAL production session
(`mode: "live"`, a real `vault.agentcard.sh` link) from inside the cage; the `env` output was fixed
the same night. So on the cage every purchase tool answers `not_configured` and the webhook route
answers 401. That is the cage working: with the live credentials a caged `purchase` would reach
real shops. Prove the cage holds, then prove the tools offline:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
node --env-file-if-exists=.env -e '
  const { runTool, capabilitiesNow } = await import("./src/tools.js");
  console.log(JSON.stringify(await runTool("vault_enroll", {}, { conversationId: "dm:owner", messages: [] })));
  console.log(JSON.stringify(capabilitiesNow({ conversationId: "dm:owner" }).find(c => c.name === "buy_things")));
'   # → {"ok":false,"status":"not_configured",…} and status "not connected"
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$P/agentcard/webhook" \
  -H 'content-type: application/json' -d '{"id":"evt_x","type":"vault.card_stored"}'
  # → 401 {"error":"rejected: no AGENTCARD_WEBHOOK_SECRET on this machine"} — the cage's blank secret
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh stop
```

**The live instance, read-only.** Three things say whether AgentCard is really wired on Hetzner,
none of which writes anything:

```bash
bin/doctor.sh live                                      # service, code checksum, /health
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://reason.tail3753c7.ts.net/agentcard/webhook \
  -H 'content-type: application/json' -d '{}'
  # → 401 {"error":"rejected: no AgentCard-Signature header"}
  #   (if it says "no AGENTCARD_WEBHOOK_SECRET on this machine", the Hetzner .env lost the secret)
ssh root@91.98.19.150 "journalctl -u reason --no-pager --since '24 hours ago' \
  | grep -E 'vault_enroll|agentcard_webhook|\"purchase' | cut -c1-240 | tail -20"
ssh root@91.98.19.150 "sqlite3 /opt/reason/data/reason.db \"select id, state, datetime(created_at/1000,'unixepoch'), substr(body,1,60) \
  from outbox where body like '%vault.agentcard%' order by id desc limit 5\""
```

**End state that proves it, live.** For an enrolment: a `vault_enroll` line in the journal with a
`url` **and** an `outbox` row in state `sent` whose body carries that `vault.agentcard.sh` link —
the tool returning a link is not the person receiving it (see Gotchas). Then
`{"agentcard_webhook":"vault.session_linked","linked":"dm:…","connected":true}` and
`{"agentcard_webhook":"vault.card_stored","stored":"dm:…"}` in the journal, an `agentcard_users`
row with `user_id`, `access_token` and `card_last4`, and the "card saved — …" line in the thread.
For a purchase: an `agentcard_purchases` row that goes `cart` → `approved` → an `order_id`, with
a `confirmations` row `granted_at` + `consumed_at` and an `action_ledger` row behind it.

**Proving the secret matches, once, deliberately.** A correctly signed probe to the live webhook
writes one harmless `agentcard_events` row and nothing else, so it is a choice and not a routine
check. Done 2026-10-12 after the destination was created:

```bash
node -e '
const { createHmac } = require("node:crypto");
const secret = process.env.AGENTCARD_WEBHOOK_SECRET;           # from Hetzner .env, never typed here
const t = Math.floor(Date.now()/1000);
const body = JSON.stringify({ id: "evt_sigcheck_"+t, type: "vault.session_linked", created: t, livemode: true,
  data: { vault_session_id: "vs_sigcheck_does_not_exist", user_id: "usr_sigcheck" } });
const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
fetch("https://reason.tail3753c7.ts.net/agentcard/webhook", { method: "POST",
  headers: { "content-type": "application/json", "AgentCard-Signature": `t=${t},v1=${v1}` }, body })
  .then(async r => console.log(r.status, await r.text()));
'   # → 200 {"ok":true,"linked":false}   (signed, unknown session)
    #   a wrong v1 → 401 {"error":"rejected: the signature did not match"}
```

## Gotchas

- **A tool result with a link in it is not a link the person got.** On 2026-10-12 at 03:05 and
  03:08 the journal shows `vault_enroll` returning a fresh live link both times, and the `outbox`
  shows neither was sent — the model told the person "don't add it again, it's in test mode
  anyway", because the tool note only mentioned mode when it was sandbox and the thread's earlier
  story won. Fixed in `ef7040a` (`mode`, the live sentence, "never tell them not to add it"), pinned
  by two tests. **Always check the `outbox` row, not the tool line.**
- **Re-keying orphans every row.** `agentcard_users` made under one organization (sandbox or an old
  production org) are invisible to the next: `vault_cards` answers 404 `connection_not_found`, the
  refresh is refused, the old session is already exchanged. The honest state is
  `blocked: "connection_expired"` with a link to send. On the night of the switch the rows were
  wiped by hand on Hetzner so the next ask minted a live link. A **4242** card is Stripe's test
  number and never carries into production.
- **Never read a vault link out of the journal to a person.** It is single-use and bound to the
  conversation that minted it; have Reason mint a fresh one.
- **The webhook secret is per destination.** Creating a new destination at AgentCard means a new
  `whsec_…`; the one in `.env` must be the one shown for *this* URL, or every delivery is 401
  `rejected: the signature did not match` and nothing in the thread ever says "card saved".
- **`.env` is never rsync'd.** The Hetzner `.env` is edited in place; a restart is
  `systemctl restart reason` as root (a plain `kill` + `nohup` loses to `Restart=always` with
  EADDRINUSE). The restart does load a freshly edited `.env`.
- **`sandbox_mode` on a confirm is not a refused card.** `DECLINE_REASONS` says so; sending
  somebody to their bank over a credential setting is the failure that map exists to prevent.
- **`purchase_confirm` is money.** Never drive it against the live instance, and never with the
  live credentials on the cage — which is why `caged.sh` blanks them. If a drive ever shows
  `agentcard: live` on the caged startup banner, stop and do not drive it.
- Line numbers in `src/tools.js` move daily: `grep -n 'case "vault_enroll"\|case "purchase' src/tools.js`.
  The first hits are one-line `targetOf` cases (`case "vault_enroll": return "agentcard:vault";`)
  and an earlier `case "purchase_confirm": {` that builds the gate's pinned target from the cart
  hash; the tool handlers are the **last** hit for each name — `vault_enroll`'s starts
  `if (!agentcard.isConfigured()) return agentcard.notConfigured();`.
