# Subscriptions — find the recurring charges, cancel one only on a yes

Somebody says "what am I paying for every month?" and Reason reads their mail receipts, writes the
recurring ones down (merchant, amount, cadence, next renewal), and shows the list. Later: "cancel
Hulu". Reason picks the rail for that merchant (web, email, phone, letter, device), walks it up to
the last screen, shows what is about to be pressed, and presses only after a spent yes. A watch runs
daily and texts about renewals coming up and subscriptions gone stale.

Source: `src/tools.js` (`subscriptions_scan`, `subscription_record`, `subscription_list`,
`subscription_update`, `cancel_route` (the per-service rail lookup), `subscription_cancel_start`,
`subscription_cancel_commit`, `subscription_confirmations`; gate keys at the `subscriptions:scan:` / `subscription:` lines),
`src/cancel-routes.js` (the registry: `ROUTES`, `match`, `playbook`, `commitPattern`, `cannotDo`),
`src/subscriptions.js` (parser, `backfillRenewalDates`, `advanceRenewal`), `src/runtime.js`
(`subscriptionWatch`, called from the 15s sweep; cadence `REASON_SUBSCRIPTION_CHECK_EVERY_MS`,
default 24h), `src/db.js` (`subscriptions` table, `subscriptionSweepState`, `setRenewalAt`).
Find lines with `grep -n 'case "subscription' src/tools.js` and `grep -n 'subscriptionWatch' src/runtime.js`
— they move daily.
Tests: `test/subscriptions.test.js` (52 pass at the time of writing: parser, table, registry, gate,
click guard, both rails against `test/fixture-service.js` + `test/fixture-google.js`).
`test/flow-subscriptions.test.js` (3 tests) walks the REAL model against the same fixtures; it is
skipped with no model reachable. Shipped in PRs #11/#12 (scan + discovery), #14 (watch).

## Sub-features

- **Scan.** `subscriptions_scan` searches the mail for receipts and returns candidates. A scan
  decides nothing: the model writes recurring ones down with `subscription_record` and leaves a
  one-off order (the desk lamp) alone. A very large tool result reads as a lazy model, so the scan
  result is bounded.
- **The list.** `subscription_list` and `subscription_update`; renewal dates are backfilled and
  advanced past `now` so the next one is always in the future.
- **Cancel rails.** `subscription_cancel_start` needs the merchant already on the list (else it
  answers "'X' is not on the list"), matches it in `cancel-routes.js` and returns a playbook for one
  kind: web (drives the browser to the last screen), email or letter (a drafted request). Phone and
  device answer `cant_do` with the honest line from `cannotDo` — nothing is dialled, no workaround
  offered. Unknown (not in the registry, no cancel page on record) answers
  `needs: "a cancel page address"` plus a `search_for` hint; called again with `cancel_url` it walks
  the web rail, still gated.
- **Gated press.** `subscription_cancel_commit` needs a spent yes in the thread (`src/trust.js`).
  The click guard refuses to press a button whose words don't match `commitPattern`.
- **`cancelling` is never rounded up to `cancelled`.** Code refuses to store `cancelled` with no
  confirmation; wording is checked only by the flow test.
- **The watch.** `subscriptionWatch` (per active person, once per check interval) backfills
  renewal dates, advances past renewals, then raises renewals-soon and stale ones as a notice turn.

## How to get to it (user POV)

"What subscriptions do I have?", "am I paying for anything I forgot?", "cancel my Netflix".
Reason shows the cancel screen's real text, asks, and after "yes" says it is cancelling and, when the
service confirms, that it is cancelled. Unprompted: a text a few days before a renewal.

## Driving it with the harness

**The proof is offline, and that is where the press lives:**

```bash
cd ~/Desktop/pa
node --test test/subscriptions.test.js        # 52/52
node --test test/flow-subscriptions.test.js   # 3, needs a model (claude-cli backend or API key); else skipped
```

The flow test's ground truth is the fixture service's own `cancellations` array: empty until a yes
exists, exactly one entry after. It touches no real service (127.0.0.1 fixture, reached through
`ctx.cancelRoutes`, which production never sets).

**The cage** has no Google account, so `subscriptions_scan` answers `not_connected`; that is the
cage working. Prove the tool surface and the empty state without touching anything real:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"   # export the WHOLE output
node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const ctx = { conversationId: "dm:owner", messages: [] };
  console.log(JSON.stringify(await runTool("subscription_list", {}, ctx)));
  console.log(JSON.stringify(await runTool("subscription_cancel_start", { merchant: "Hulu" }, ctx)).slice(0,300));
'
.agents/skills/verify-reason/bin/peek.sh sql "SELECT id, merchant, amount_cents, cadence, status, cancel_route, next_renewal_at FROM subscriptions"
cd ~/Desktop/pa/.agents/skills/verify-reason && bin/caged.sh stop
```

On an empty cage `subscription_list` is empty and `subscription_cancel_start` answers "'Hulu' is
not on the list" — that is the expected answer, not a failure. To get past it, record one first with
`subscription_record` (`{ merchant: "Hulu", amount: "$17.99", cadence: "monthly", service: "hulu" }` — the input `amount` is the receipt's own string, which code turns into the `amount_cents` column).

**Registry coverage** (does a merchant have a rail?):
`node -e 'import("./src/cancel-routes.js").then(m=>console.log(m.match("Hulu")))'`.

**Live, read-only:** `bin/doctor.sh live`, then on the live server (OVH, root@15.204.113.250)
`sqlite3 -readonly /opt/reason/data/reason.db "select merchant,status,cancel_route,next_renewal_at from subscriptions"`
(`next_renewal_at` is UTC epoch ms; `next_renewal` is the TEXT the model wrote). The journal is thin
here: `subscriptionWatch` logs nothing and the sweep result is not logged, so
`journalctl -u reason --since '24 hours ago' | grep subscription` only shows tool-call lines
(`{"tool":"subscription_…"}`). Never run `subscription_cancel_commit` against live.

**End state that proves a cancel:** a `confirmations` row `granted_at` + `consumed_at`, an
`action_ledger` row, and the subscription row `cancelling` (then `cancelled` only with the service's
confirmation text stored).

**Driven 2026-11-14 (g2 pass, cage DB, in process, no browser):** `subscription_list` empty → count 0 with the
"Nothing is on this list yet…" block; `subscription_cancel_start {merchant:"Hulu"}` → "'Hulu' is not on the
list…"; `subscription_record` → created, `cancel_route: web`, `cancel_url` the registry's account page; the list
then has it. `test/subscriptions.test.js` 52 green. (`subs-drive.mjs` in the evidence.) Again 2026-11-18 on
`18b47891` (same steps, no external fetch): the row reads `Hulu|1799|monthly|active|web`; `subscriptions.test.js`
(52) green in a 154-pass batch; `flow-subscriptions` 3 skipped (no claude-cli backend). `subscription_cancel_start`
on a recorded merchant was not driven: its web rail opens a real browser at the merchant's sign-in page.

**Two neighbours since 11-13.** Recurring charges straight from their bank: `bank {action:"subscriptions"}`
(Plaid's recurring list, everyone, [plaid.md](plaid.md)) — a different list from this receipts-based one.
Reason cancelling inside their own account through a Crossmint checkout: `account_cancel` (owner only,
[account-jobs.md](account-jobs.md)).

## Gotchas

- A scan result is candidates, not truth. One-off order confirmations show up in it.
- Never assert on the model's wording in the offline suite; the one wording assertion (`cancelling`
  vs `cancelled`) lives in the flow test on purpose.
- `subscriptionWatch` is skipped for a person checked inside the interval; to see it fire in a test,
  set `REASON_SUBSCRIPTION_CHECK_EVERY_MS=0`.
- The watch iterates `listAccountsOfPeople()` and skips non-`active` accounts.
- A cancel on a merchant with no registry entry and no `cancel_url` answers `needs` (a cancel page
  address); it never improvises a click. Phone/device rails answer `cant_do`, never "I'll call them".
