# Getting rid of Google's "unverified app" screen

When somebody taps a Reason connect link, Google shows **"Google hasn't verified this app"** with
*Advanced → Go to Reason (unsafe)* before the real consent screen. This page is what that screen is,
why it is there, what the code already does about it, and the exact steps — most of them in Google's
console, and only the project owner can do them — that make it go away.

Everything below was read from Google's own pages on 2026-10-06 (the verification help centre at
support.google.com/cloud/answer/13463073 and its sub-pages 13464321, 13465431, 13463817; the
production-readiness pages for brand, sensitive and restricted scopes; the API Services User Data
Policy; the Gmail, Calendar and Drive scope tables; appdefensealliance.dev/casa). Where something is an
inference rather than Google's words, it says so.

## Why the screen is there

- Reason asks for **two restricted** scopes (`gmail.modify`, `drive.readonly`), two **sensitive** ones
  (`calendar.events`, `calendar.calendars.readonly`) and one **non-sensitive** one (`drive.file`).
- **Drive, added 2026-10-06, changed the list and not the work.** `drive.readonly` is restricted and the
  app was already in restricted-scope review for Gmail, so the stages below and the security assessment
  are the same ones, taking the same time and costing the same money. What it does add is two more
  scopes to justify and one more feature to show in the demo video. That the review *class* is unchanged
  is read off Google's sensitivity table rather than stated by Google about this app.
- Any app that asks for a sensitive or restricted scope and has **not passed verification** gets the
  unverified-app screen, and a **100-Google-account cap over the project's lifetime**. Publishing the
  consent screen ("In production") does not change that; it only lifts the Testing-mode limits.
- There is **no setting that turns the screen off.** Brand verification alone does not remove it
  either — it only verifies the name and logo. The screen goes when the scopes are approved.

## What it takes, in order

Google lists three verifications. Each one is a prerequisite for the next.

| Stage | What Google checks | Google's own time estimate |
|---|---|---|
| 1. Brand verification | App name, logo, home page, privacy policy, terms, and that **you own the domain** (Search Console). | minutes if automatic, 2–3 business days if manual |
| 2. Sensitive-scope verification | The Calendar scopes: appropriate use case, narrowest scopes with a written justification, Limited Use, a **demo video**. | ~10 business days |
| 3. Restricted-scope verification | The Gmail scope **and `drive.readonly`**: the same, plus an **annual security assessment** by a Google-approved lab (CASA). | ~6 weeks |

The security assessment is the expensive part. Google's CASA page lists only lab-tested assurance
levels (AL1, AL2) in 2026 — there is no self-assessment path on that page any more. One approved lab's
public price list (TAC Security, read 2026-10-06): **AL1 from $675 one-time** (2–3 weeks to the
letter), AL2 $5,400. Google decides which level applies; a small app with few users is the AL1 case.
It has to be repeated **every 12 months**. Other labs on Google's list: Bishop Fox, DEKRA, Leviathan,
NCC Group, NetSentries, Prescient, Valuementor, Eydle. Prices for those were not read.

Google contacts you by email to start the assessment **after** stages 1 and 2 are done — you do not
pick the lab first.

## The one real blocker: the domain

Google's rule, in its words: *"The homepage must be hosted on a verified domain you own."* And the
privacy policy *"should be hosted within the domain that hosts your homepage."* Ownership is proved
in Search Console for the **top private domain** — the part just under a public suffix.

Reason's public address is `https://reason.tail3753c7.ts.net`. `ts.net` is on the Public Suffix List
(checked 2026-10-06), so the top private domain Google would ask you to verify is
**`tail3753c7.ts.net`** — a name that belongs to Tailscale, has no DNS record of its own, and cannot be
verified by anyone outside Tailscale. Brand verification cannot pass on this address as it stands.

Two ways out, both needing a decision from the owner:

1. **A subdomain of a domain already owned** — e.g. `reason.omarinyarko.com`. Free. Search Console
   verifies `omarinyarko.com` once (DNS record at the registrar), and the subdomain is covered.
2. **A new domain for Reason** — e.g. `textreason.com` or similar. Costs money every year; cleanest
   for an open-source product that other people will run.

Either way the address in front has to reach the Mac. The Tailscale Funnel only serves its own
`ts.net` certificate, so a custom name cannot point at it directly; it needs a proxy in front. The
marketing site is already on Netlify (`textreason.netlify.app`), and Netlify can proxy paths to another
host, so the shape is:

- the custom domain is attached to the Netlify site (Netlify issues the certificate);
- Netlify serves `/` itself (the marketing page, which describes the product and links to the policy);
- Netlify **proxies** `/privacy`, `/terms`, `/google/*`, `/p/*` and `/s/*` to
  `https://reason.tail3753c7.ts.net`, so the policy, the terms, the OAuth callback and page links are
  on the same domain;
- `REASON_PUBLIC_URL` becomes the new address, and the OAuth client's redirect URI is updated to
  `https://<domain>/google/callback`.

The Netlify rules for that are in the site's `netlify.toml` (added 2026-10-06, pointing at the current
Tailscale name). Until a domain is attached they are reachable at `textreason.netlify.app/privacy` etc.,
which is useful for checking the proxy works, but `netlify.app` is on the Public Suffix List too, so it
does not solve the ownership problem.

## What the code already does

Done and tested offline (see `docs/unverified.md`, 2026-10-06 section):

- **Public pages.** `GET /` (describes what Reason does, links to policy and terms), `GET /privacy`
  (what is accessed, used, stored and shared, the Limited Use sentence Google asks for word for word,
  how to disconnect, export and delete), `GET /terms`. All public, indexable, cached, HEAD-friendly.
- **Narrowest scopes.** Calendar is `calendar.events` + `calendar.calendars.readonly`, not the broad
  `calendar`. Gmail is `gmail.modify`, the narrowest single scope that covers read + search + draft +
  send + label + archive + bin (every Gmail read scope is restricted, so there is no non-restricted way
  to read mail). Drive is `drive.readonly` + `drive.file`, not the broad `drive`: nothing is deleted,
  shared or renamed, and the code has no tool that could. Existing broad-`calendar` grants keep working;
  the broad scope is never re-asked.
- **Asked for when they are needed.** Drive is not in a plain "connect my Google" at all — the Drive
  scopes go on a link only when a Drive tool is what the person wanted, with `include_granted_scopes` so
  nothing they already granted is lost. Google's own incremental-authorization section calls that the
  best practice and uses Drive as its example.
- **In-product notice.** A connect link comes with a one-line statement of how the data is used and
  the privacy address (`say_with_link` on the `google_connect` result, and the tool description tells
  the model to send it). Google's policy asks for this "where the grant is asked for". Since
  2026-10-06 the sentence goes out the first time a person gives a kind of access (mail, calendar,
  Drive) and the privacy address alone goes with every link after that. Whether a reviewer reads a
  repeat link without the sentence as still meeting the policy is not known; if not, it is one
  condition in `authorizeUrl` to put back.
- **Search Console hook.** `GOOGLE_SITE_VERIFICATION=<token>` puts the meta tag on all three pages.
- **No token leaves the machine**, email content is treated as data never instructions, deletion is
  real (`npm run data:delete`), and the policy says exactly these things.

## The owner's checklist

Do these in order. Google's console pages are at console.cloud.google.com → **Google Auth platform**
(project `reason-510717`).

1. **Pick the domain** (see above) and tell the assistant; the proxy rules and `REASON_PUBLIC_URL`
   change take a few minutes, then the redirect URI on the OAuth client must be updated to the new
   `/google/callback` **before** anybody connects again.
2. **Search Console** (search.google.com/search-console), signed in as the Cloud project owner: add
   the domain as a *Domain* property and add the DNS record it gives you at the registrar. (The
   `GOOGLE_SITE_VERIFICATION` meta tag is the fallback for a *URL-prefix* property if DNS is awkward.)
3. **Branding page**: app name "Reason", a logo (120×120 PNG), support email, developer contact,
   home page `https://<domain>/`, privacy `https://<domain>/privacy`, terms `https://<domain>/terms`,
   and `<domain>` under **Authorized domains**. Click **Verify branding**, then **Publish branding**.
4. **Data Access page**: declare exactly these five scopes and no others —
   `https://www.googleapis.com/auth/gmail.modify`,
   `https://www.googleapis.com/auth/calendar.events`,
   `https://www.googleapis.com/auth/calendar.calendars.readonly`,
   `https://www.googleapis.com/auth/drive.readonly`,
   `https://www.googleapis.com/auth/drive.file`. Remove `…/auth/calendar` if it is
   still listed. Google rejects apps whose code requests a scope not declared here, so this list and
   `SCOPE_LIST` in `src/google.js` must match — **the two Drive ones were added on 2026-10-06 and are
   not on the page yet**, so a Drive connect fails at Google's own screen until they are. Enable the
   **Drive API** on the project at the same time.
5. **Demo video** (unlisted YouTube link). Google's requirements, all of them: shows the **same app
   name and branding** as submitted; shows the **whole OAuth flow** with the **complete consent screen**
   listing **exactly these scopes**, with the consent screen's language set to **English**; shows the
   features that use each scope. A script that covers it:
   - screen-record the phone: text Reason "connect my gmail", show the link bubble **and the privacy
     line** arriving;
   - tap the link, show Google's account chooser and the full consent screen (scroll it), agree;
   - back in the thread: "what's my latest email about?" (read), "reply saying I'll be there" → the
     confirm card → "yes" (send), "what's on Thursday?" (calendar read), "put lunch with Ama on Friday
     at 1" (calendar write);
   - then Drive, which is its own tap and worth showing as one: "can you find my lease in my drive" →
     the second consent screen (scroll it) → agree → the lease comes back and Reason quotes a line out
     of it; then "write that up as a doc" to show `drive_create` and the link it sends back;
   - "disconnect my google" to show revocation.
6. **Scope justifications** — paste these into the verification form:
   - **gmail.modify** — *Reason is a personal assistant used over text. When the user asks, it searches
     their mail, reads a message or thread, lists labels, writes a draft, sends a new email or a reply
     in the right thread, archives, marks read/unread, labels, and moves mail to the bin. Every send
     and bin requires an explicit confirmation from the user in the conversation. A narrower scope
     does not work: `gmail.readonly` cannot send, label or archive; `gmail.send` cannot read or search;
     `gmail.labels` covers labels only; `gmail.compose` cannot read. `gmail.modify` is the one scope
     covering read + write without permanent deletion, which Reason deliberately cannot do.*
   - **calendar.events** — *Reason shows the user what is on their calendar for a day or range, reads
     one event in full, and creates, changes and deletes events when asked, using events.list/get/
     insert/patch/delete. `calendar.events.readonly` cannot create or change events, which users ask
     for in plain language ("put lunch on Friday").*
   - **calendar.calendars.readonly** — *Reason reads a calendar's time zone (calendars.get) so that
     events are read and written in the user's zone rather than the server's. It does not create,
     share or delete calendars, which is why the broad `calendar` scope is not requested.*
   - **drive.readonly** — *When the user asks about one of their own documents ("what does my lease say
     about pets?"), Reason finds it with files.list and reads it with files.export or files.get, and
     answers from the text. No narrower scope can do that: `drive.metadata.readonly` cannot read file
     contents, and `drive.file` only grants access to files the app created or the user selected through
     the Google Picker, which this app does not use — so under `drive.file` alone a user's existing
     documents are invisible to it. Reason never writes to, renames, shares, moves or deletes an
     existing file, which is why the broad `drive` scope is not requested. Nothing is copied or stored:
     the text is read when the question is asked and lives only in that conversation.*
   - **drive.file** — *When the user asks Reason to write something down and keep it ("make me a doc
     with this"), it creates one Google Doc with files.create. This is the narrowest scope files.create
     accepts, and it grants access only to files this app created, which is all Reason needs for it.*
7. **Submit** on the **Verification Center** page. Reply to every email from the Trust & Safety team
   the same day — Google's time estimates assume you do.
8. **Security assessment** when Google's email arrives: pick a lab from Google's list, pay for AL1,
   fix what they find (likely asks, from CASA's requirement list: tokens encrypted at rest, HTTPS
   only, a documented deletion path — Reason has the last two; the first is not built), send Google
   the letter. Then **every 12 months**.

## Until it is done

- The screen stays, and the 100-account cap counts down. Each Google account connected spends one;
  disconnecting does not give it back (inference from Google's "cannot be reset" wording).
- Tell people: tap **Advanced → Go to Reason (unsafe)**. The word is Google's and means "unreviewed",
  not "found unsafe".
- Do **not** switch the consent screen back to Testing to dodge the cap: that brings back the 7-day
  token expiry and the test-user list.
- Do **not** add a scope "for later". Every added sensitive/restricted scope reopens review, and
  Google's rules forbid requesting data the app does not use yet. Drive stopped being an example of this
  on 2026-10-06 — three tools use it and the justifications above describe what they do — but the rule
  is unchanged for anything else (Docs, Contacts, Photos, Tasks): the code ships first, then the scope.

## Decisions waiting on the owner

- Which domain (subdomain of an owned one, or a new one).
- Whether to pay for the annual security assessment at all. Without it, Gmail stays "unverified" for
  good; Calendar-only verification (stages 1–2, free) would remove the screen for a calendar-only
  connection but not for one that includes Gmail — and the consent screen shows all declared scopes at
  once, so splitting the connection into two links would be the way to offer that.
