# The owner's first sites (the owner-mode trial)

Written 2026-11-13. For after PRs 2 to 6 are merged and the AWS keys exist. One site at a time, the first sign-in while he has his phone in hand (section D), each job read-only.

## What the evidence allows
`docs/site-probe-2026-11-12-signin.json` names only the 20 sites that refused on 11-12. The 24 that reached a sign-in page were never written down (`how`; the research notes say the same). The only candidate with a recorded load is **Amazon**: entry page 202, account page 200 "Sign in" (`docs/site-probe-2026-10-05.json`), and it is not among the 20. Every other site below must pass PR 2's load-only probe first. The code rule says so too: no save link until Reason's browser has reached that site's sign-in form that day (B4).

## Recommended, in order
1. **Amazon** (`amazon.com`). Careful list (a marketplace): Face ID every time, and Reason goes in only as a declared agent (`Agent/Reason`, which Amazon's terms ask of agents). It is the closest to proven. **Job that proves it:** "when does my Prime for Young Adults membership end, and what will it charge?" Reason signs in, opens the membership page, reads the date and the price, and signs out. Risk: on suspicion Amazon may ask for more proof, disable the password or cancel pending orders. Keep the first try away from an open order. **The cancel itself is a subscription job,** which his scope keeps on the checkout service (`REASON_ACCOUNT_JOBS`, live in owner mode since 00:21 ET on 11-13) or in his own hands. The Nov 30 deadline must not wait on the vault.
2. **Con Edison** (`coned.com`). Everything else (a utility, not a carrier). **Job:** "what's my Con Ed balance and when is it due?" Low risk: a read of one bill. The worst case is a locked web login, fixed by a call, and no money moves (paying stays on the checkout service with Face ID). Unknown: whether its sign-in page loads for Reason at all. Probe it first.
3. **Netflix** (`netflix.com`). Careful list (streaming): Face ID every time. **Job:** "what plan am I on, when is the next charge, and which devices are signed in?" It tests section D for real: Netflix emails on every new sign-in, so the heads-up and the count of "new sign-in" mails within ten minutes are measured on day one. Risk: device limits, or his own device being signed out. Probe it first.

Trial checks for each site: the second step it asked for, the session's length, KMS unwraps equal to sign-ins, zero scrubber hits, and one readable activity line per use.

## His other sites
- **Linear, Railway, Notion:** normally not password sites (an emailed code or link, Google or GitHub). They need no saved login: the emailed-code route (#525) covers them, and they make good controls for "signed in without a vault". If he has set a Notion password, Notion can join later as an everything-else site.
- **Railway** belongs on the **careful** list in any case: it deploys his apps and bills a card.
- **Total Wireless:** **never** (a phone carrier: that account controls the number that guards everything else, Reason included).
- **Fandango:** **never** as section C is written (ticket buying). A lawyer could narrow that row to event tickets, but not for this trial.
- **The AWS root account:** **never**, not careful (PR 4 proposes the row). It holds the vault's own key and the outside record of every unwrap. A login saved there would let a stolen server rewrite the key policy and the record that are meant to catch it. The same goes for the other accounts that run Reason: Netlify (it serves the save page), the registrar of heyreason.com, OVH and GitHub.
- **Anything with payouts or money movement** that is not a bank or payment app (a seller or payout dashboard): **careful**, and Reason never changes where money is paid out. Banks, payment apps, brokerages and crypto exchanges stay **never** (Plaid, read-only, PR #520).
