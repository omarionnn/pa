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
every route the real one documents — no key, no network, 52 tests at `587f67a` (2026-10-24), 55 after
the placement-failure pin (2026-10-26).
The rest of the shopping loop (offers, handoff, price watches) is in [shopping.md](shopping.md).

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
node --test test/agentcard.test.js        # 55/55 at 00f3300 (52 at 587f67a, 35 at ef7040a)
node --test test/purchasesnote.test.js test/agentcard-token-seal.test.js test/oauth-token-seal.test.js \
  test/shopping-sandbox-fixes.test.js     # 22 + 5 + 5 + 5 at 587f67a; agentcard + purchasesnote 82 at b04eb74; purchasesnote 30 at f3669e8 (#108)
```

**Placement failure after approval (2026-10-26), pinned offline, then on the cage:**

```bash
cd ~/Desktop/pa
node --test --test-name-pattern="2026-10-26" test/agentcard.test.js   # 3/3: the incident replayed against the fixture; the late-event case; new cart / pre-approval / placed-after-one
# On the cage: the incident's own event shape, unsigned, must bounce (the cage blanks the secret), and
# the four placement columns must exist on the caged database.
P=8813   # any free port; REASON_VERIFY_PORT
REASON_VERIFY_RUN=/tmp/reason-verify-place REASON_VERIFY_PORT=$P .agents/skills/verify-reason/bin/caged.sh start
curl -s -w ' HTTP %{http_code}\n' -X POST "http://127.0.0.1:$P/agentcard/webhook" -H 'content-type: application/json' --data \
  '{"id":"evt_c8b2aa7568ff17d35696038a","type":"order.failed","data":{"order_id":null,"conversation_id":"conv_571c1e34073228ee2696c96b","user_id":"usr_x","code":"place","message":null,"retryable":false,"charge_status":"none"}}'
REASON_VERIFY_RUN=/tmp/reason-verify-place .agents/skills/verify-reason/bin/peek.sh schema agentcard_purchases | grep -o 'placement_[a-z_]*' | sort -u
REASON_VERIFY_RUN=/tmp/reason-verify-place REASON_VERIFY_PORT=$P .agents/skills/verify-reason/bin/caged.sh stop
```

**End state (driven 2026-10-26 on the cage, port 8813):** `{"error":"rejected: no
AGENTCARD_WEBHOOK_SECRET on this machine"} HTTP 401`, `serve.log` has one
`agentcard_webhook_rejected`, and the schema lists `placement_fail_code`, `placement_fail_reason`,
`placement_failed_at`, `placement_failures` (re-driven so 2026-10-27 at `00f3300`, port 8822, with the
`vault_enroll` / `buy_things` / `purchase_track` → `not_configured` drive below). The signed path — match by conversation, the
store-rejected re-ask with the ceiling, the stop on the second failure, the code and reason on
`purchase_track` — is the pinned test above; it needs the fixture's signed deliveries and is never
driven against the live webhook.

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
P=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port")
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$P/agentcard/webhook" \
  -H 'content-type: application/json' -d '{"id":"evt_x","type":"vault.card_stored"}'
  # → 401 {"error":"rejected: no AGENTCARD_WEBHOOK_SECRET on this machine"} — the cage's blank secret
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh stop
```

**The live instance, read-only.** Three things say whether AgentCard is really wired on Hetzner,
none of which writes anything:
(The unsigned POST below writes nothing, but it is still a POST to a live webhook: leave it out of
any pass run under a no-POST-to-live rule — `bin/doctor.sh live` skips it unless
`REASON_DOCTOR_POST_PROBE=1`.)

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


## Tokens at rest and webhook keys (2026-10-23)

- **Tokens are sealed.** `agentcard_users.access_token` / `refresh_token` are stored as
  `enc:v1:…` (AES-256-GCM, `src/secretbox.js`) under `REASON_TOKEN_KEY` from `.env`. Without the
  key the server will not start, and a database holding token rows will not open. Plain rows from
  before are sealed the first time a process with the key opens the database. Count, never print:
  `sqlite3 /opt/reason/data/reason.db "SELECT sum(access_token LIKE 'enc:v1:%'), sum(access_token != '' AND access_token NOT LIKE 'enc:v1:%') FROM agentcard_users"`
  should read `N|0`. The cage gets its own throwaway key (`$RUN/token-key`).
- **Login tokens too (oauth_tokens, same date).** `oauth_tokens.access_token` / `refresh_token`
  — Google, Spotify, Uber, X, GitHub, and the iCloud app-specific password (kept in access_token) —
  are sealed the same way, opened only inside `src/db.js` (`getOauthTokens`, `listOauthTokens`,
  `saveOauthTokens`'s return). `db.oauthTokenAudit()` gives sealed/plain counts per provider. Count,
  never print:
  `sqlite3 /opt/reason/data/reason.db "SELECT provider, count(*), sum(access_token LIKE 'enc:v1:%'), sum(access_token != '' AND access_token NOT LIKE 'enc:v1:%') FROM oauth_tokens GROUP BY provider"`
  should show the plain column all 0.
- **Webhook keys.** `checkout_authorization.*` is matched on `data.authorization_id` (stored on the
  row from the approval link's `?id=`), and `order.*` on `data.order_id` — or, when that order id is
  not on a row yet, on `data.conversation_id` provided AgentCard's record of that conversation lists
  the order. Nothing is matched on amount or time. Neither family moves a purchase to `placed`: they
  write `authorization_state` / `order_state`. Only declined/expired on a row still
  `awaiting_approval` sets `failed` and texts.
- **Order status comes from AgentCard's record, not the event (2026-10-24).** Every matched `order.*`
  re-reads `GET /buy/conversations/{id}` and takes `orders[]` for that order_id
  (`reconcileOrder` → `reconcilePurchase` → `applyOrderRecord` in `src/tools.js`): `order_state` is
  the order's own status, `retailer_order_id` / `delivery_window` are kept once the shop sends them,
  and `cancelled` / `canceled` / `failed` / `refunded` move the row to `cancelled` and send one plain
  text (`cancelledLine`). `cancel_told_at` is claimed once (`db.claimAgentcardCancelNotice`), so a
  redelivery, a second event and a `purchase_track` read never say it twice. `purchase_confirm` reads
  the record again right after it saves the order id, which closes the race where `order.placed`
  lands before the confirm answers (13:00:31 vs 13:00:49 that day). Why: Walmart order `e66d7f2b…`
  was cancelled by AgentCard, `order.updated` only wrote `order_state='updated'`, and Reason later
  called it settled.
- **The purchase record goes in front of the model when buying is in play (2026-10-24).**
  `src/purchasesnote.js` builds a block of this person's AgentCard purchases from the last 14 days
  (window on `MAX(created_at, updated_at)`, newest first, at most 5, cartless `shopping` rows left
  out, no ids). Each line is date · merchant · item · amount · status in plain words
  (`CANCELLED by the shop, not coming`, `declined, not bought`, `pending their approval, not charged
  yet`…), and the header says the block overrides anything said earlier in the chat. It is
  prompt-only on the API path, the CLI path and a phone call. **When it rides (`shoppingMoment`):**
  nothing in Reason judges a turn's topic per message, and topic is never read with regexes on
  their words, so it uses structural signals only. Either a purchase row of theirs was created or
  changed in the last 48h, or a buying tool (`purchase`, `purchase_confirm`, `purchase_track`,
  `offer_check`, `shop_handoff`, `vault_enroll`) is in their ledger, or an offer was read for them,
  in the last 6h. Otherwise there is no block, and none when there are no rows. **`purchases_recent`**
  is the same list as a read-only tool. It reads only their rows and makes no AgentCard call, and
  it is in SAFE_WHILE_SCREENED. Its description tells the model to check it before saying whether
  anything was ordered. Why: Walmart order `e66d7f2b…` was cancelled and its text deliberately
  suppressed (`cancel_told_at`). At 13:45Z Reason then told the owner "the Walmart order already went
  through", going by its own old "the cerave's ordered", with no tool called. The block reads the
  row's `status`, so a cancellation reaches the next turn whether or not `cancelledLine` was sent,
  and the row change itself switches the block on (`test/purchasesnote.test.js`, and the
  suppressed-text pin in `test/agentcard.test.js`).
- **The block rides only on a message about buying, read from its meaning (2026-10-24, after #94).**
  `startPurchasesNote` asks one yes/no of `claude-haiku-5-5` over the API, with the CLI behind it on
  a `claude-cli` backend (`askTopicCli` in `src/purchasesnote.js`, its own
  `REASON_PURCHASE_TOPIC_CLI_TIMEOUT_MS` 12s added to the budget — taken on an API error, a missing
  key or an API skip) (`REASON_PURCHASE_TOPIC_MODEL`; deliberately not `REASON_HARM_MODEL`, which this Mac's `.env` sets
  to opus): is the new message about buying, orders, shopping, deliveries, refunds, returns or a product
  they might buy, shown with a 300-char snippet of Reason's last message so "any update?" after an order
  thread counts. No regexes, no keyword lists. **Only when there is something to show**: no purchase row
  in the 14-day window means no call at all. It starts as context building starts (both backends) and is
  awaited where the notes meet, with a hard `REASON_PURCHASE_TOPIC_TIMEOUT_MS` (1.8s) that aborts the
  request. On a timeout, an error, an answer that is not yes/no, neither an API key nor the CLI backend
  (`structural("no_api_key")`), or an event turn, it falls
  back to the structural signals above, so a failed check never hides the block in the incident case.
  A phone call keeps the structural signals (its context is built once per call). `purchases_recent` is
  sent on every turn either way. Decision log: `{"purchases_topic":"yes"|"no","via":"api"|"cli","ms":…}`,
  `{"purchases_topic_failed":…}`, `{"purchases_topic":"structural","why":…}`. Offline wiring in
  `test/purchasesnote.test.js`; the real model in `test/flow-purchases-topic.test.js` (needs a key:
  `node --env-file=.env --test test/flow-purchases-topic.test.js`; 7/7, p50 563ms, max 890ms on
  2026-10-24 from this Mac).
- **Tracking reads the conversation; `/track` is gone.** `GET /buy/v1/merchants/retail/orders/:id/track`
  answers `410 {"error":"endpoint_retired"}` since 2026-10-24 and the docs name no replacement.
  `agentcard.trackOrder` reads the purchase conversation's `orders[]` (`retailer_order_id` = the
  shop's order number), so `purchase_track` needs the order to be on this person's record. A null
  number or window is said by name: "Walmart hasn't sent an order number yet". The fixture's `/track`
  answers 410 and counts hits (`state.trackHits`); the tests assert it stays empty.
- **Docs vs the live record.** The SDK's documented `BuyOrder` has only order_id, merchant,
  merchant_name, status, total_cents and placed_at; the live record also carries `retailer_order_id`,
  `delivery_window`, `confirmed_at`, `payment_source` and `merchant_total_cents`. The docs say only
  DoorDash sends `order.updated` and spell the status `canceled`; Walmart sent one on 2026-10-24 and
  the record said `cancelled`. Both spellings are handled.
- **The order's own read comes first: `GET /buy/orders/{id}` (`agentcard.readOrder`).** AgentCard support
  named it on 2026-10-24 (`status`, `status_updated_at`, `estimated_arrival`, `tracking`, `placed_at`); it is
  not in the public docs or openapi.json. `agentcard.readOrderRecord` lays it over the conversation's
  `orders[]` entry: its `status` wins, the conversation is the fallback and is still where
  `retailer_order_id` / `delivery_window` come from. `purchase_track`, the confirm's reconcile and the
  `order.*` reconcile all go through it (`read_from` on the tool says which answered). `last_checkout` is a
  stale snapshot of the last checkout attempt and is never read once any order exists — its
  `charge_status` "confirming" cannot outvote an order's "canceled". Fixture: `orderRead` /
  `state.orderReads`.
- **Why it was cancelled is kept and said.** `order.*` events carry `canceled_reason` and `status_detail`;
  they land on the row as `cancel_reason` / `cancel_detail` (`db.noteAgentcardCancelReason`, only while
  empty) before anyone is told, and each event id's first copy is kept in `agentcard_events`. Why:
  AgentCard re-posted order e66d7f2b…'s cancellation 48 ms later under the same id with both fields
  null; the first copy is authoritative and a later null never erases a reason. `cancelledLine`,
  `purchase_track`, `purchase_confirm`, `purchases_recent` and the purchases block say it in plain words
  (`agentcard.cancelReason`: a known code, else the store's line, else "no reason given"). For
  `invalid_shipping_address` Reason offers to fix the address and try again — a NEW purchase, new cart,
  new yes. Row 3 (conv_3137fea…) was backfilled by hand; `cancel_told_at` was already set, so no text.
- **`commerce_billing_required` is Reason's setup, not the person's plan.** AgentCard support, 2026-10-24:
  it means the ORG has not set up how it pays AgentCard's 1% commerce fee (Commerce SDK → Balance).
  `agentcard.DECLINE_REASONS.commerce_billing_required` says so for any user — a setup problem on
  Reason's side, nothing charged; a 4xx with that code is `blocked: "billing_setup"`. #96 had mapped it
  to "your one free order has been used"; that was wrong and is gone. The free plan's one-order
  refusal has no known code yet: `agentcard.FREE_ORDER_QUOTA_CODES = []` waits for AgentCard to confirm
  it, and any unknown code gets the neutral "AgentCard declined it (code)."
- **"Is my card connected?" is answered honestly (#108).** `vault_enroll` reads it from
  `cardConnectionReport` (`src/tools.js`): `connected` (a live token from this session) or
  `needs_reconnecting`, with why and when it was last linked; a re-link over a dead token does the
  exchange again (`src/http.js`). Declined rows in the purchases block carry why and whose fault
  (`refusalWhy`, `src/agentcard.js`) plus one closing line on whether the card was ever the problem
  (`cardVerdict`, `src/purchasesnote.js`) — a commerce-fee setup refusal is never blamed on the card.
- **A store that refuses to place the order AFTER the approval is said as the store's doing, never
  "the approval didn't count" (2026-10-26).** Live, 03:19 ET: Target, CeraVe PM, est. $16.78; Face ID
  approved, 2 s later `order.failed code=place order_id=null`; the approval's timer re-confirmed with
  the same confirmation_id, got `vault_approval_required` with a NEW authorization, and Reason told the
  owner "it looks like the first approval didn't count". It did count — the store rejected the order,
  which consumed the approval. Now: an `order.failed` with no order id is matched to the purchase by
  `data.conversation_id` (the buy conversation), only for the person `data.user_id` names, only while
  the row is `awaiting_approval` with its approval gone through (`authorization_state = 'approved'`;
  before that a confirm that ended without an order is Reason's own, answered directly), and never for
  an approval pause (`order.failed` is also sent for `vault_approval_required`;
  `agentcard.isApprovalPause`). It lands as `placement_failures` (count),
  `placement_failed_at`, `placement_fail_code` (`place`/`prepare`, or a named code) and
  `placement_fail_reason` (AgentCard's `message`, when any) on `agentcard_purchases`
  (`db.noteAgentcardPlacementFailure`); the webhook says nothing itself — the re-confirm is the one
  voice. That re-confirm (`purchase_confirm`, the pause branch) re-reads the row and, when it has a
  placement failure OR the approval was consumed and a new authorization came back (the event can be
  late), answers `store_rejected: true` with the code and reason, "nothing was charged", "that attempt
  used up the approval, so AgentCard needs a fresh one", and the new link. The SECOND failure on one
  cart is the end of it: `blocked: "store_rejected_twice"`, no third link, nothing sent to AgentCard,
  the row `failed` with `decline_code` = the placement code, and the model is told to suggest checking
  the address and the item and that trying later is a NEW purchase, only if they want it. `purchase_track`
  (live and `local_record`) and `refusalWhy` carry the code and reason (`store`, never the card) — only
  while the refusal is the story (`placementHistory`: waiting, failed, declined, unknown), never on an
  order the store then placed. A DIFFERENT cart on the same conversation ("change the address", a 409's
  fresh cart) is a fresh attempt: `recordAgentcardPurchase` zeroes the `placement_*` columns and clears
  `authorization_state` / `authorization_id` when the hash changes, so a cart nobody has tried is never
  said to have been rejected and never refused unsent; the same hash keeps them.
  Event shape from docs.agentcard.com/webhooks/orders/order-failed (read 2026-10-26); the live
  `agentcard_events` rows for the incident are `evt_c8b2aa7568ff17d35696038a` and
  `evt_a1beb939a5892d7e45e91b64` (ids only; the table keeps no payload).
- **Every approval text restates the hold ceiling (2026-10-26).** The approval texts said only the
  estimated total ($16.78) while AgentCard's approval card showed the most the card may be held for
  ($26.14); the cart line had said it once, the approval texts never, and the owner was surprised.
  `holdLineFor(row, cents)` (`src/tools.js`) reads `ceiling_cents` off the row's `cart_json` and every
  pause answer — first ask, re-ask, flight — carries `hold` ("total $X (an estimate…), and the card
  may be held for up to $Y until the store settles — the same figure AgentCard's approval card shows")
  and `hold_ceiling`, and the error text tells the model to put that line before the link. A cart with
  no ceiling gets the total alone, nothing invented. Fixture: `fake.set({ ceilingCents })`.
- **`purchase_track` answers from the local row when the connection is dead.** An expired or
  unreachable AgentCard connection no longer returns `blocked: connection_expired`: the row's status,
  reason and amount come back (`read_from: "local_record"`, `live_check: "needs_reconnect"`), and
  that a live re-check needs the card reconnected is a side note after the answer.
- **A refresh keeps the pair it gets.** `/api/v2/connect/refresh` answers with no `user` and invalidates
  the refresh token it was given. Until 2026-10-24 `readConnection` refused a pair with no user, so every
  refresh spent the stored token and threw the new one away; the connection died an hour after it
  was made. `refreshConnection(token, { userId })` now keeps the pair against the row's user id. The
  fixture's refresh now answers the documented shape (new pair, no user, old token dead).
  Until 2026-10-23 live had only ever received `ping`, `vault.session_linked` and `vault.card_stored`.

## Sandbox proof (step 4, 2026-10-23) — not run live; what it needs

**This install has no sandbox credentials.** The `AGENTCARD_CLIENT_ID`/`AGENTCARD_CLIENT_SECRET`
pair in `~/Desktop/pa/.env` is the same client as Hetzner's, and a token minted from it
introspects (`GET https://api.agentcard.sh/api/v2`, read-only, a one-off on 2026-10-23 — never a routine probe, see "Never probe AgentCard itself") as `test_mode: false`,
`mode: production`. Key prefixes do not tell the modes apart (`acs_…`, `whsec_…` either way),
and the host is the same for both; introspection is the only check. Never run the loop on these.

**What the offline proof covers instead:** `test/shopping-loop.test.js` — the real tool code and
the real HTTP server (`createServer`, `POST /agentcard/webhook`) against the fake AgentCard:
ask → catalog pick by offer_id → cart → yes pinned to the hash → passkey pause → signed
`checkout_authorization.approved` keyed on `data.authorization_id` (a mis-keyed one matches
nothing; bad/stale signatures 401; redelivery deduplicated) → wake → the same confirm with its
answer dropped → reconciled by one `GET /buy/conversations/{id}`, never resent → signed
`order.placed`/`order.confirmed` keyed on `data.order_id`. Plus the dropped confirm with no order
behind it: stays `outcome_unknown`, says "not proof nothing was charged", retry refused.

**To run it live in sandbox, Omari has to provide** (in `~/Desktop/pa/.env`, never Hetzner):
- `AGENTCARD_SANDBOX_CLIENT_ID` and `AGENTCARD_SANDBOX_CLIENT_SECRET` — dashboard → Commerce SDK →
  Start implementing, step 1 (labelled Sandbox); or Settings → Developers → Credentials with the
  mode switch on Sandbox (docs.agentcard.com/commerce-sdk/quickstart,
  /api-reference/access-tokens/overview).
- `AGENTCARD_SANDBOX_WEBHOOK_SECRET` — a webhook endpoint created **in sandbox mode** (dashboard →
  Developers → Webhooks, or the API with a sandbox token). Endpoints are per mode; a production
  endpoint never receives sandbox events. The cage is not public, so the endpoint needs a reachable
  URL (a tunnel to the cage port) or AgentCard's CLI `companies webhooks listen`.
Then the cage is started with those three mapped onto `AGENTCARD_*` **only after** introspection
of the sandbox pair reads `test_mode: true`. In sandbox the vault code is always `111111`, and
the confirm ends `declined` with `sandbox_mode`/`sandbox_unavailable` — both in
`DECLINE_REASONS`. Record which event types actually arrive (`agentcard_events`) and that
`order.*` matched on `data.order_id` and `checkout_authorization.*` on `data.authorization_id`.
Sandbox proves wiring, not that a merchant ships anything.



## Never probe AgentCard itself

Nothing in a verification pass calls AgentCard: not `/api/v2/oauth/token` (minting an org token),
not `/api/v2/connect/refresh`, not introspection, not `/buy/*`. `/api/v2/connect/refresh` invalidates
the refresh token it is given and answers the only pair that works from then on; a probe that
throws the answer away has killed that person's connection. On 2026-10-24 a probe spent the
owner's last refresh token that way. The introspection described under "Sandbox proof" above was a
one-off on 2026-10-23 and is not a check to repeat. Live AgentCard state is read from Hetzner's
own rows and journal; the API's behaviour is pinned in `test/fixture-agentcard.js`.

## Keeping the connection alive (2026-10-24)

The access token lives an hour and every refresh spends the refresh token it is given. Three
things keep a connection from dying, all offline-proved in `test/agentcard-connection.test.js`:

- **One refresh per person at a time** (`refreshAgentcardOnce` in `src/tools.js`). The pair is saved
  in one UPDATE before anything else runs; a turn and the sweep reaching at once share one call.
- **The sweep rotates ahead** (`refreshAgentcardConnections`, every pass): a token with under 10
  minutes left is refreshed in the background. Only rows with a refresh token and no
  `connection_dead_at`; a failure that never reached AgentCard is retried after 2 minutes.
- **Only a refusal is death.** A 4xx on the refresh token (`invalid_grant` and kin) sets
  `connection_dead_at`; a timeout, a dropped connection, a 5xx or a 429 sets only
  `refresh_failed_at`, and the turn says "try again", never "reconnect". A new exchange clears both.

Read on live, never by calling AgentCard: `journalctl -u reason | grep agentcard_refresh` —
`{"agentcard_refresh":"ok","conversation":…,"why":"sweep","expires_in_min":59}` about every 50
minutes per connected person, or `"failed"` with `dead`, `code`, `status`. No token value is ever
in it. The rows: `SELECT conversation_id, datetime(token_expires_at/1000,'unixepoch'),
datetime(refreshed_at/1000,'unixepoch'), refresh_error, connection_dead_at FROM agentcard_users`.
`/ops` has one **Card connection — <name>** row per connected person: ok / expiring (refresh could
not reach AgentCard, retrying) / dead (reconnect). Only the owner's row texts (red, through the
sustained-alert path); everybody else's is `quiet` and shown only.

## Live, read-only (upkeep pass, 2026-10-24, live at `587f67a`)

What the record on Hetzner showed, with no AgentCard call and no POST except the unsigned webhook
probe in `doctor.sh` (counts only; never print tokens, numbers or bodies):

```bash
ssh root@91.98.19.150 "sqlite3 -readonly /opt/reason/data/reason.db \"
  SELECT status, count(*), sum(cancel_reason != ''), sum(cancel_told_at IS NOT NULL) FROM agentcard_purchases GROUP BY status;
  SELECT count(*), sum(access_token LIKE 'enc:v1:%'), sum(access_token != '' AND access_token NOT LIKE 'enc:v1:%') FROM agentcard_users;
  SELECT type, count(*) FROM agentcard_events GROUP BY type;\""
ssh root@91.98.19.150 "journalctl -u reason --no-pager --since today -o cat | grep -o '\"tool\":\"purchase[a-z_]*\"' | sort | uniq -c"
```

- **Cancel reconcile (#92, #96):** the one `cancelled` row has a `cancel_reason` and `cancel_told_at`.
- **Tokens sealed (#86, #89):** `agentcard_users` 2 sealed, 0 plain (the third row has no token);
  `oauth_tokens` google/github/spotify all sealed, 0 plain.
- **Webhooks keyed by id:** `agentcard_events` holds `checkout_authorization.approved`,
  `order.placed`, `order.updated`, `order.failed` ×2 alongside the `vault.*` events.
- **#97 on live:** after the 14:52 UTC restart the journal has
  `{"tool":"purchase_track",…,"out":{"ok":true,"status":"cancelled","read_from":"local_record","live_check":"needs_reconnect",…}}`
  — the dead connection answered from the row. Also one `purchases_recent` call.
- **Purchases block (#94/#95):** the only `purchases_topic` line since that restart was
  `"structural","why":"not_a_message"` (an event turn). A `yes` was driven on the cage instead: the
  owner asking "any update on my walmart order?" over a seeded cancelled row logged
  `{"purchases_topic":"yes","ms":575}` and the reply said it was cancelled and why. A location-only
  message logged `purchases_topic_failed: the check answered ""` and fell back to the structural
  signal, as designed.
- **Not provable from here, by rule:** the refresh-keeps-the-pair fix and `readOrder` (`GET
  /buy/orders/{id}`) both need AgentCard calls; they are covered offline only
  (`test/agentcard.test.js`, `state.orderReads` in the fixture).

**The cage reaches the local-record answer** (since `3262b70`). With `AGENTCARD_*` blanked,
`purchase_track` reads the row first: no row → `not_configured`; a row → `localPurchaseAnswer` with
`read_from: "local_record"` and `live_check: "not_configured"` (`grep -n 'localPurchaseAnswer(prow'
src/tools.js`), as [shopping.md](shopping.md) says. `purchases_recent`
does work on the cage (no AgentCard call): a seeded cancelled row came back as
`CANCELLED by the shop, not coming` with `the store couldn't use the shipping address`. Seed with
`db.recordAgentcardPurchase` / `db.markAgentcardPurchase` — its patch keys are camelCase
(`orderId`, not `order_id`; an unknown key is silently ignored).
