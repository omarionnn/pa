# Account jobs: a subscription cancelled, a bill paid, inside their own account

`REASON_ACCOUNT_JOBS` (off | owner | on), off by default. `owner` is the owner's conversation only. It
also needs the checkout service for that person (`REASON_SHOP_CONNECT` and the Crossmint keys).
Code: `src/accountjobs.js`, `src/accountjobtools.js`, the hooks in `src/shopconnect.js` (`isJobRun`,
`startJobRun`, `step`). Tests: `test/account-jobs.test.js`.

Why: the owner's bar (2026-11-12) is that a yes to something Reason offered is driven to the end by
Reason. A human step is either the real site in the person's own browser or something native to
Reason, never Reason's browser shown as a picture. So these jobs run in Crossmint's Agent Checkouts,
in the person's own Crossmint browser profile, and nothing here opens Reason's browser.

## The two jobs

**Cancel.** `account_cancel` starts one run with the smallest cap the API takes (`CANCEL_CAP`), told
to stop at the last step and ask a question that begins `CONFIRM CANCELLATION:`. That question reaches
the model as an `[account job]` event; the model asks one plain line; the yes goes through the confirm
gate into `account_cancel_confirm`, pinned to the job, plan, site, run and open question
(`cancelTarget`). The line they are asked is built in code from the page's own words (the plan, its
price where given, the date access ends, or "gave no end date") and handed to the model with the
question. Before their yes, ANY go-ahead question that is not plainly an earlier step (a reason, which
plan, an offer to stay) is treated as the last step and goes to the gate; `account_job_answer`
refuses it. The run's result must end with one fixed line, read by `readResult`:
`RESULT: CANCELLED NOW | ENDS: <date> | PAGE: "<the page's own line>"`, `RESULT: ALREADY CANCELLED | ENDS: … | PAGE: "…"`,
`RESULT: NOT FOUND | PAGE: "…"` or `RESULT: NOT CANCELLED <why>` (the old bare `RESULT: CANCELLED` still reads as
changed now). The page's line is kept as `account_jobs.page_line` and quoted back to them. Changed now: the
merchant's cancellation email is the second proof. A run that cancels without stopping to ask is said as
exactly that.

**Already so** (2026-11-13: the owner's plan was already set to cancel on Nov 27, the run said it worked, and
the job waited for an email that could never come). When the page already shows the plan set to end, the
run changes nothing and asks nothing; the job ends `done` / `already_done` with no mail watch, and the line
says what the page shows, that nothing was changed, and until when they keep access, quoting the page.
It counts only on the page's own words (`lineShowsDone`: ending or not renewing, and no "renews on"), and
only when their yes never went to the site; anything weaker is `not_cancelled`, said as not done. A bill
whose page shows it already paid (`RESULT: ALREADY PAID | PAGE: "Amount due: $0.00"`) ends the same way, with
nothing paid; a zero balance said without the page's line stays `nothing_paid`.

**The manage link first.** A `page` they or their notice gave is where the run starts, and the task says it
is their manage link. With no link, the latest manage page an earlier cancellation of theirs started on at
the same site is used. A `not_found` that started on the front page asks for the link in its line.

**Proof pictures.** Crossmint's API returns no picture of a run: a run has `status`, `result.summary` in
words and `run.browser.embedUrl`, "a read-only live view of the browser in your app" (agents/checkouts/
how-it-works) that is "`null` until a session exists" (agents/checkouts/follow-run); no screenshot,
artifact or recording field is documented (read 2026-11-13). So these jobs keep the page's own line, and
no picture is drawn or faked for them. Where Reason's OWN browser finished the work (signed in with a saved
login, an errand on a page it opened), `browser_proof` sends one picture of the page with the result line
(`src/proofshot.js`): refused on a sign-in page, a page with a secret box, or words holding a full card or
bank number; secret boxes masked; cropped to the section holding the page's line, else the viewport;
JPEG under 1.5 MB; sealed per person; in their export, unlinked on a delete, gone with the content
retention window; nothing of the page comes back to the model. A caller-owned browser (`browser.cdp` on
create) would let a Crossmint run drive a browser Reason can photograph, at the cost of the saved
Crossmint profile and its way past sign-in walls; not done here.

**Bill.** `account_bill_pay` needs the biller, the amount due and the account or invoice number (or,
where the notice prints none, the notice's own pay link on the site named), a saved card, and room
under the day's limit. The approval is asked as a bill ("OK to pay $X (the payment page's total) to
<who the page says> for your <biller> bill?"); when the page names a different payee than the notice
did, that is said first. A payment the page reports that did not go through their approval (a card
saved at the biller) is never "done": it is said as that. The run goes to the biller's own page (guest pay where it
exists). Its card payment is the shopping pay path untouched: Crossmint's exact total, the confirm
gate, the daily cap, Face ID. Done needs the payment page's receipt and, where mail is connected, the
biller's confirmation email.

## Sign-in, in order (`onQuestion`)

1. A saved signed-in profile: no question comes.
2. A code or link the site emailed, in a standard field: read from their Gmail by code
   (`codeFromGmail`: that site's sender domain and Gmail's own DKIM verdict), answered without them,
   and said afterwards in one line, once, by code (before the last step's question or the total; with
   the ending when the job stops first).
3. A code they must read themselves (texted, or mail not connected), in a standard field: asked for
   once in the thread, passed on with `account_job_answer` (sealed out of the tool log and ledger).
4. A protected field (a password; a code Crossmint sealed): ONE Reason page (`/web/connect/<token>`)
   carrying Crossmint's protected input, texted once per run. A later sealed question lands on the
   same page.
5. None of these: one line and stop.

The page is Reason's own (`src/pages/webconnect.js`), with a job's own words: what the sign-in is
for ("Then I can cancel <plan>"), that nothing else on the account is changed, and never a
checkout's lines. Where a billing service runs the account, the texted line names that address
("Cardboard's account page (link.com)").

Never `signin_link` (the one tool that makes the link showing Reason's browser as a picture,
`createRemoteSignin`): where the switch is on it is refused (`signinLinkRefusal`) for a site a job is
working on or worked on in the last day, for ANY site while one of their jobs is open, and, before
a job exists, on a turn where they asked to cancel a subscription or pay a bill or where
`cancel_route` ran. The browser-walking cancel tools are hidden and refused.

## A cancellation cannot charge

Crossmint's cap; a payment request on a cancel run is declined and the run ended (`onPayment`); so is
a form that asks for card or bank details or a way to pay, and a question that states a
cancellation or termination fee (`classify` → "pay", `refuseToPay`): none of these reaches the
model or the person as a question. `recordPayment` returns null for a `job_cancel` run and `payRow`
refuses one, so nothing can approve one. A purchase reported on a cancel run is never "done". On a
bill, card details asked for in a form are never passed on either: the card only ever goes through
the payment approval.

## What counts as the merchant's mail

Really from them (the From domain and Gmail's own DKIM verdict), after the job acted, and saying it
happened: "has been cancelled", "cancellation confirmed", "payment received", "receipt". Mail that
asks for a click to finish, says it failed, is unpaid or refunded, or is about an order or a booking
is not proof. A billing service's mail, or mail for a job on an address that is not the merchant's
own, counts only when it names the plan or the merchant (a bill: the merchant or the amount paid).

## One attempt record per run

`{"account_job": "<site host>", "kind", "route", "outcome", "ms", "at"}`, printed once when the run
ends (`logAttempt`). Fixed lists; never a plan, an amount, a reference, an email, a code or a
conversation id.

## The daily note

`canFinish(conversationId, { kind, site, amount, reference })` is the test a card must pass: the
switch on for the person AND a saved signed-in profile for the site, or a site that already let them
in by an emailed code with mail still connected, or (a bill) amount, reference and a saved card.

## What Crossmint's docs allow, and where they stop (read 2026-11-12)

- **Manage subscriptions** (https://docs.crossmint.com/agents/checkouts/use-cases/manage-subscriptions.md): "An agent checkout can sign in to the user's account at a merchant and change a subscription: subscribe to a plan, change the plan, or cancel it. Write the change in the task." The documented pattern is the one built here: tell the checkout to ask before it confirms, attach `browser.profileId`, set a very low cap. Limits: the subscription must be on the account that profile is signed in to; the result is only `result.summary` in words. There is NO structured "cancelled" field: a cancellation that worked ends `succeeded` with `purchase.kind: "nothing_placed"` (https://docs.crossmint.com/api-reference/agent-checkouts/get-agent-checkout.md). So the task asks for a fixed last line (`RESULT: CANCELLED` / `RESULT: NOT CANCELLED`) and the merchant's own email is the second proof.
- **The cap cannot be zero.** `constraints.maxCost` is required and its amount pattern is `^(?:0\.(?=\d*[1-9])\d{1,6}|[1-9]\d{0,14}(?:\.\d{1,6})?)$` (https://docs.crossmint.com/api-reference/agent-checkouts/create-agent-checkout.md): `0` and `0.00` are refused. Crossmint's own cancel example uses `0.01`. This PR uses the smallest accepted amount, `0.000001` USD, and adds two code locks on top (below).
- **How sign-in is asked for** (https://docs.crossmint.com/agents/checkouts/buyer-inputs.md, https://docs.crossmint.com/agents/checkouts/how-it-works.md, https://docs.crossmint.com/agents/checkouts/merchant-sessions.md): the run stops `awaiting_input` with a form of typed fields. Each field has `handling: "standard" | "protected"`. "Protected fields ... passwords, one-time codes, and government ID numbers. The user must type them in `CrossmintProtectedInput`". A protected answer is `{ protectedInputId }`, minted only by Crossmint's client component with a client key and the user's JWT. No server API mints one (none documented; the scope `protected-inputs.create` exists for client keys only).
- **Can the app answer a code question without the person?** Only when the code field arrives `handling: "standard"`: then a form response with the string is the documented answer. When it arrives `protected` (the docs' stated use for one-time codes, and what every sign-in code Reason has met so far was), neither Reason's server nor a code typed into the thread can answer it: the person types it on the page. This PR does not work around that.
- **How long a browser profile stays signed in, and how to check** (https://docs.crossmint.com/agents/checkouts/merchant-sessions.md, https://docs.crossmint.com/api-reference/agent-checkouts/get-browser-profile.md): one profile per user (a second create is 409). No lifetime is documented: "If the merchant has expired the session or requires the user to sign in again, the checkout asks new questions." There is NO way to check: "The profile does not report what happened during a checkout", the API returns metadata only (`id`, `label`, `createdAt`, `updatedAt`). A run that asks no sign-in question was signed in; Reason keeps that per person and site (`shop_stores`, `account_jobs.route`).
- **Endings that matter** (https://docs.crossmint.com/agents/checkouts/statuses.md): blocked `policy.max_cost_exceeded`, `merchant.access_blocked`, `merchant.human_verification_required`, `merchant.checkout_error`, `merchant.no_safe_path`, `merchant.payment_declined`; failed `input_expired`, `browser_session_lost`, `model_error`, `runtime_error`, `cost_limit`, `accounting_unavailable`, `reconciliation_required` ("the merchant can have the order. Check before you start the same purchase again"), `cancelled`. Each maps to its own line here.
- **Cost** (https://docs.crossmint.com/agents/checkouts/common-questions.md, https://docs.crossmint.com/agents/checkouts/test-agent-checkouts.md): 1,000 checkouts free per project per month, then 0.05 USD each, billed when the checkout starts, also when it ends blocked or failed. A create request that fails costs nothing.
- **Live browser view** (`run.browser.embedUrl`): exists, never used here.

## Limits, said plainly

- The gate depends on the checkout honouring "stop at the last step and ask". Crossmint documents the pattern, not a guarantee. If a run cancels without asking, the result line still reports it, and the plan cancelled is the one the person asked to cancel.
- Their yes has to arrive while the site's page holds the last step (about ten minutes in runs seen). Late: "Not done ... tell me to cancel it again".
- A sealed code or a password always needs the person, once, on the Reason page.
- A code they send in the thread passes through the model on its way (sealed out of the tool log and ledger), not around it.
- A fee is recognised by its words ("cancellation fee", "early termination", "penalty"). A site that charges for cancelling without saying so in the question is caught only by the cap, and a charge the merchant makes on a card it already holds is outside any cap: the task forbids it, the line they are asked carries the page's money words, and nothing more can be promised.
- Starts are limited to 3 per site and 8 across all sites per person per day.
- Before a job exists, the sign-in link is refused by reading the turn (their words, or `cancel_route` having run). A turn that asks for a cancellation in words the check does not know can still reach `signin_link`; the tool descriptions forbid it, code does not.

## Proving it

Offline: `node --test test/account-jobs.test.js` (every run state is built to the documented shapes).
A real cancellation or bill needs the owner: it acts in his account. A harmless real exercise is a
cancel run for a made-up plan under a throwaway Crossmint user, stopped at its first question
(recorded in `test/fixtures/crossmint-account-jobs/` when one has been run).

## Where it goes: found from their mail, or one question

With no link from them, before anything runs, `findPlace` (src/accountplace.js) searches their own connected
mailboxes for the merchant's and its billing service's mail. From that mail it takes the manage/billing
link: only one on the merchant's own site or its biller's (same registrable domain), or a tracking redirect
that lands there when followed through `src/netguard.js`. It never follows a link that reads as
unsubscribe or cancel. It also takes who bills it (the site, or Stripe Link, Paddle, Chargebee, Recurly,
FastSpring, Lemon Squeezy, Gumroad, PayPal) and which of their mailboxes it goes to. That becomes the start
page and the sign-in address. If Apple or Google Play bills it, the job ends `store_billed` with the
store's own steps (src/cancel-routes.js). If the mail gives no answer, or two answers (two mailboxes, two
billers), the job waits in `needs_answer` / `ask_kind: place` with one fixed question, and nothing runs.
Their reply (`account_job_answer`, `{ answer }`) resumes it: a link (checked the same way), an address, or
which mailbox. There are at most two questions; after that it ends `no_place` and says so. A link they
give still wins. A bill never asks when the mail is silent (its reference and the biller's page are
enough).

## Done or not: one table (`OUTCOME_TABLE`)

| Verdict | Outcomes | Evidence it needs |
|---|---|---|
| Done | `done` | the site's page showed the new state (an end date; "payment received" with amount/confirmation) and the site's own confirming email arrived |
| Done | `done_result_only` | the page alone (a receipt, for a bill); their mail isn't connected, so no email can be looked for |
| Done, already so | `already_done` | the page's own line showed it already so; nothing changed or paid; no email is waited for |
| Not confirmed | `waiting_mail` | the page said it worked; the email hasn't come; checked every 10 minutes for a day |
| Not confirmed | `no_mail_came` | the page said it worked (quoted); no email came within the day; closed, not left open |
| Not confirmed | `unconfirmed` | their yes or payment went in, then the run broke before the result |
| Not done: not found | `not_found`, `no_place`, `nothing_paid` | no such subscription / couldn't tell where it's billed / nothing paid |
| Not done: couldn't sign in | `no_signin`, `no_signin_route` | the sign-in wasn't finished / no way to sign in from here |
| Not done: site refused | `blocked_browser`, `human_check`, `site_error`, `no_safe_path`, `payment_declined`, `not_cancelled` | what the site did |
| Not done: money asked | `refused_by_cap`, `payment_asked` | the page wanted money a cancellation can't pay |
| Not done: needs you | `unexpected_purchase`, `paid_unapproved`, `no_answer`, `approval_timeout`, `store_billed` | something to check yourself, a timed-out wait, or a store-billed plan |
| Not done: stopped | `declined`, `stopped` | they said no / stopped |
| Not done: service broke | `service_failed`, `start_failed` | the checkout service failed |

`account_job_status` answers "is it done?" from this table: `line` is the verdict and its evidence, and
`verdict` carries the quoted page line, the email's subject (when one was seen), the end date and the day.
