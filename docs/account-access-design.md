# Reason signs itself in: account access design and security review

Status: design and review only. Nothing in this file is built. Written 2026-11-12 against `origin/main` `27cdace0`.
Every statement about today's code carries a `file:line`. Every outside fact carries a source read on 2026-11-12 (list at the end). Lines marked "not verified" are exactly that.
Proposed switch: `REASON_SAVED_LOGINS` = `off | owner | on`, off by default.

## The one question

**May Reason keep people's logins in a vault of its own?**

**Recommendation: yes, with six conditions, and the owner first.**

1. **Owner only** until real sign-ins work end to end on real sites and the first week's numbers are in (section G). Today no site has been signed into end to end, and 20 of 44 sites refuse Reason's browser (19 at the door, Spotify after the email step).
2. **The key leaves the server first.** Today the master key is a file on the same machine as the data. That is the code's default (`src/restcrypt.js:254`) and what the 11-09 encryption note picked to go live; the AWS setup the upgrade needs has not been handed over (the owner's paste file is still blank). Not re-checked on the live server. A saved login must be locked by a key held in a cloud key service that the server can ask to use but can never copy. That needs about 15 minutes of the owner's time in AWS and about $3 a month. No key service, no vault.
3. **The never list is in code from day one:** banks and brokerages, Apple ID, Google password, primary email, government, health, work accounts, phone carriers, password managers (section C).
4. **An honest browser only.** No disguise, no CAPTCHA solving, one refusal means stop. This is already Reason's rule (`src/agent.js:187`) and it is now also what Amazon's and Uber's terms require of any agent.
5. **The promise changes in the open.** Reason tells people today "i never keep or see your password" (`src/amazonconnect.js:31`) and its own code says "No password ever reaches Reason" (`src/signin.js:5-6`, under "The design Omari approved"). Saving logins reverses that. Every such line changes before anyone but the owner can save one, and each person opts in per site.
6. **A lawyer reads sections C and E before the switch goes to `on`.** Most big sites' terms forbid what this does (below).

**Why yes.** On a password site there is no other way to meet the bar "say yes once and Reason finishes it alone": without a saved login, every time the site signs Reason out, a person has to type the password again. And the way this design holds a login is stronger than the way Reason holds Gmail and other connections today (one key in `.env` beside the data, `src/secretbox.js:5-7`).

**The strongest argument against.** It turns a very small company into a store of other companies' passwords, to open a route (a server browser typing a password) that large sites are closing in their terms and with bot walls, and whose reach for Reason has not been measured once. The same weeks spent on official connects, the checkout service and phone calls might finish more jobs.

## A. One page for the owner

### What the person experiences

Reason takes the first route that works. The person never sees a picture of someone else's page.

| # | Route | What Reason texts | What the person does |
|---|---|---|---|
| 1 | Already connected | Nothing first. Then: "Done. Cardboard Starter is cancelled and ends Nov 27. The confirmation is in your email." | Nothing |
| 2 | Official connect exists | "I need your OK on Spotify's own page first. One tap:" then the link | One tap on the provider's real page, in their own browser |
| 3 | Site emails a code or link, and Reason reads their mail | First time only: "Notion signs people in with a code by email. I'll read that one email and sign in. Notion may tell you about a new sign-in from Chrome on Linux near Hillsboro, Oregon: that's me. OK?" Then: "I'm in." | Says yes the first time. Nothing after that |
| 4 | Password site | "Xfinity needs a password. Save your Xfinity login with me once and I'll sign in myself from now on. It stays locked and the AI never sees it:" then the link | Saves the login once on the Reason screen below |
| 5 | Payment or subscription, through the checkout service | "Cancel Cardboard Starter? It ends Nov 27 and you keep it until then." If money moves: "Approve it with Face ID here:" | Yes, and Face ID when money moves |
| 6 | Website route closed | "Their site won't let my browser in, so I'll call them. OK to call now?" | Yes |
| 7 | Nothing works | "I can't do this one. Their site blocks my browser, there's no connect for it, and they don't take it by phone. Nothing was changed." | Nothing. No page is sent |

"Chrome on Linux near Hillsboro, Oregon" is an example. The real words come from a setting the operator keeps true (section D).

Right after a login is saved, while the person is still there, Reason signs in once to check it:
"Saved. Signing in now to check it works. Xfinity may send you a 'new sign-in' notice from Chrome on Linux near Hillsboro, Oregon: that's me." Then "I'm in. Your bill is $84.12, due Nov 20. Pay it?"

If the site wants a second step:

- **Emailed code:** nothing. Reason reads it.
- **Texted code:** "Xfinity just texted you a code. Send it to me here and I'll finish signing in. Their text says not to share it. That's your call: I use it once, right now, on xfinity.com. I only ever ask for a code right after you've asked me to do something."
- **Authenticator app:** nothing, if they saved the setup key with the login. Otherwise: "Open your authenticator app and send me the 6-digit Xfinity code."
- **Approve in their app:** "Your Xfinity app is about to ask you to approve a sign-in from Chrome on Linux near Hillsboro, Oregon. That's me. Approve it only if it says that."
- **Wrong password:** "Xfinity says that password is wrong. I tried once and stopped. Save it again here:" then a fresh link.

### The one Reason screen

It opens from a link in the person's own thread, on heyreason.com, in Reason's own look. It is not a copy of the site's page.

```
Reason

You asked: "pay my xfinity bill"

Save your Xfinity login in Reason
Sign-in page: login.xfinity.com

Email or username   [                    ]
Password            [                    ]
Authenticator setup key (optional)   [            ]   What's this?

What saving means
- Reason signs in to Xfinity for jobs you ask for, and signs back in when Xfinity logs it out.
- Your login is locked with a key kept outside Reason's server. The AI never sees it.
  You can't read it back here either. You can only replace it or remove it.
- The company that runs Reason could technically reach it. Every use is written down for you to read.
- Xfinity's rules may not allow an assistant to sign in for you. Xfinity could lock or close the account.
- Remove it any time: text "forget my Xfinity login".

(o) Sign in whenever a job I ask for needs it
( ) Ask me with Face ID every time

[ Save with Face ID ]

This page is heyreason.com. Reason only sends this link in your own thread, right after you ask for something.
```

### What Reason can then do alone, and for how long

Any job the person asks for, or says yes to on a card, inside that account: read a bill, download a statement, check an order, change a plan, cancel, reorder, book. Anything that spends money still needs the spending approval Reason already has (the daily cap, `src/trust.js:842`, and Face ID, `src/passkey.js`).

| The site's second step | How long Reason stays able to act alone |
|---|---|
| None, an emailed code, or an authenticator key saved with the login | Until they change the password, remove the login, or the site blocks Reason. Being signed out does not matter: Reason signs back in. |
| A texted code or an approval in their app | Until the site signs Reason out (often weeks with "remember this device", sometimes days). Then one relay from the person, asked inside the next job. |
| Passkey only, or "Continue with Google / Apple" only | Never. There is nothing to save. |

A saved login that goes unused for 90 days is deleted after one warning text.

### What Reason will never do

- Show a saved login to the AI, to the person, or to anyone. It can be used, replaced or removed, never read.
- Type it anywhere except that site's own sign-in page, at the exact address saved with it.
- Take a password by text. A password sent in the thread is refused and the save link is sent instead.
- Use "forgot password", change a password, an email, a phone number, a second step or a recovery setting.
- Try a second password, a second address, or the same password on another site.
- Get round a block or a CAPTCHA, or pretend to be a different browser or a person at home.
- Keep going after one refusal.
- Sign in for something the person did not ask for.
- Save a login for a bank or brokerage, an Apple ID, a Google account, their main email, a government or health portal, a work account, a phone carrier or a password manager.
- Spend from inside an account without the same approval any other payment needs.

### The honest downsides

1. **Reason becomes a target.** It would hold real passwords, and people reuse passwords. A break-in could expose logins that open other things. The design limits how much and leaves tracks (section B, "If there is a breach"), but cannot make it zero.
2. **It does not fix the walls.** A saved login for a site that will not load is worth nothing. 20 of 44 sites refused the browser on 11-12 (`docs/site-probe-2026-11-12-signin.json`), and the food probe found the block is the automated browser itself, not the server's address (`docs/site-probe-2026-11-12-food.json`, `finding`).
3. **Most big sites say no in their terms.** Of eleven services' terms read tonight, eight forbid automated access outright or without written permission (Netflix, Spotify, Verizon, DoorDash, Delta; Instagram, LinkedIn and Ticketmaster as reported by a second reader). Amazon and Uber now publish rules for agents: say who you are in every request, never solve a CAPTCHA, stop when told. Uber also forbids giving an unapproved agent the login. Chase forbids AI tools from using the login at all. The realistic results: the site blocks Reason (common), the account gets a security lock or forced reset (sometimes), the account is closed (rare, mostly ticketing, gaming, social, points).
4. **The law is unsettled, and a server browser is the weaker position.** In August 2026 an appeals court sided with Perplexity against Amazon because the assistant ran in a browser on the person's own machine: "It is the user who 'accesses' Amazon's computers." It said it was not deciding the case where the company's own servers do the accessing. An older case went the other way for a company that kept signing in from its servers, with users' consent, after the site told it to stop (Facebook v. Power Ventures).
5. **It teaches habits that phishers use.** Typing a password into a page that is not the site's, texting a code to someone, approving a sign-in prompt. A fake "Reason" could ask for the same things.
6. **Both factors in one place.** A saved authenticator key sits beside the password.
7. **A legal duty.** A stored username and password for an online account is "personal information" under California's breach law, with notice due within 30 days.
8. **Everyone with root is inside the wall.** That is the owner and every builder session that works on the live server today.

### Where the evidence disagrees with the plan

- **The bottleneck is the browser, not the password.** Measure which sign-in forms an honest browser can reach before building the whole vault (section E, the probe), and prove three to five real sign-ins with the owner's accounts before anything opens wider.
- **Routes 4 and 5 do not join up.** The checkout service's protected password box only accepts a reference its own page component makes; Reason's server cannot hand it a saved password (`src/shopconnect.js:888-889`; Crossmint's docs as read by tonight's account-jobs builder). So when a store signs the checkout browser out, the person types the password again there, vault or no vault. Ask Crossmint whether it can keep a login for re-sign-in.
- **A hosted browser that "passes walls" does it by disguise.** That is what Reason's rule forbids and what Amazon's and Uber's terms name as a breach. A signed agent identity is honest, but every vendor read tonight says it only labels the agent: the site still decides. Do not plan on a hosted browser.
- **The WorkOS sentence covers the owner, not a service.** "For individuals automating their own accounts, these techniques are practical and often sufficient. The person accepting the risk is the same person getting the benefit." That describes the owner-only stage. A company holding many people's logins is a different case, and the same article says the proper answer is scoped, revocable tokens.
- **The emailed-code route has a ceiling.** It reads mail with Google's restricted `gmail.modify` scope, capped at 100 Google accounts for the project's lifetime until Google's review and yearly security assessment pass (`docs/google-verification.md`).
- **Weaker spots exist today and matter as much.** Google and other connection tokens sit under one key in `.env` (`src/db.js:7117-7120`). Saved browser sessions sit unsealed on disk in folders named with the person's phone number (`src/browser.js:49-52`; absent from `src/restfiles.js:25-31`). The one typed secret Reason already stores, the Apple calendar app password, arrives through the chat as a tool argument the AI reads (`src/tools.js:7529`). The page snapshot hands the AI the contents of any filled box, password boxes included (`src/browser.js:151`). These are fixed by the first PRs whatever the answer is.

### If the answer is no

| Instead | What the person does | What would NOT be possible |
|---|---|---|
| **Official connects, emailed codes, and the checkout service's own protected box only** | One tap for connects. Types a store password into the protected box each time that store signs the checkout browser out. | Signing back in alone on any password site. Anything on sites the checkout service does not cover (utilities, insurance, schools, memberships, landlords). Reading inside an account: "a Crossmint browser profile gives Reason nothing it can read" (`src/amazonconnect.js:4-6`). |
| **A password manager does the filling (1Password for Agents)** | Connects 1Password once, then approves each site in the 1Password app about once a month. Reason never holds the login. | Anyone who does not pay for 1Password in the US. Approval from a phone today: it works in the desktop app on a test channel, or inside an integrator's own iPhone app; the plain phone app is "In development". It is a partner preview that needs 1Password's security review. Passkey and social sign-ins. |
| **A vendor keeps the logins and runs the browser (for example Kernel Managed Auth)** | Types the login into a Reason-styled box that sends it straight to the vendor. | Keeping the no-disguise rule: these browsers hide automation and solve CAPTCHAs by default. Keeping logins out of a third party. About $30 to $200 a month plus $0.10 to $2.40 per person. The same terms and legal exposure, or more. |
| **Wait for the iPhone app (sign in on the real site inside the app)** | Signs in on the real site, in the app. | Anything until the app ships and passes App Review. Signing back in alone: a lapsed session needs the person again. Google sign-ins (Google refuses embedded browsers). A session made on a phone may not survive being moved to a server (Chrome now binds Google sessions to the device). |

A fifth choice sits between yes and no: **the owner's own logins only, for good.** That is what the WorkOS sentence actually covers. It still needs sections B to F.

---

## B. The vault

### B1. What exists today that this stands on

- **Per-person sealing** (`src/restcrypt.js`): master key, then an install key, then one key per person; AES-256-GCM; a destroyed person key makes every backup copy unreadable (`:605`). The master is a file on the server by default (`:254`); AWS KMS is coded, with a test of its request signing, but not set up (`:185-206`; the owner's AWS paste file is still blank). Reads are automatic for any query on a listed table (`:795-807`) and opened values sit in a 4,000-entry cache (`:492-499`). The associated data is the key id only (`:485`), so a sealed value moved to another row still opens.
- **Token sealing** (`src/secretbox.js`): one key for everyone, `REASON_TOKEN_KEY`, in `.env` (`:5-7`). It holds Google, GitHub, Spotify, Uber and X tokens and the Apple calendar app password (`src/db.js:7117-7120`).
- **Face ID approvals** (`src/passkey.js`): the passkey belongs to heyreason.com (`:65-66`); Face ID or the passcode is required (`:163`, `:278`, `:282`); the signed challenge is a hash of the exact action (`:204-210`); one link, one use, thirty minutes (`:74`, `:284`); a second passkey waits 24 hours and the person is texted (`:75`, `:194`). Two kinds exist, `pay` and `cap` (`:122-125`). No passkey can be removed in code today (`:143`).
- **Standing permissions** (`src/permissions.js`): "a bound, never a hint" (`:16-19`), with the person's own sentence, an action, a target and an expiry. Paying can never be standing (`:161`).
- **Codes typed by code, out of the AI's sight** (`src/signinemail.js`): the emailed code is found by sender domain plus Gmail's own DKIM verdict (`:98-107`), typed with `page.fill` (`:386`) and "never logged, never returned from a tool" (`:25`). A texted code is swapped for a placeholder before the AI's turn (`src/channels/router.js:295-302`).
- **The action record** (`action_ledger`, `src/db.js:139-152`): append-only, read by text with `ledger_list` (`src/tools.js:5254`). No page lists it.
- **The website** is on Netlify, which passes heyreason.com requests through to the server (`src/pages/siteproxy.js:1-9`). Anything typed on a Reason page crosses Netlify.
- **The browser** is one Chromium profile per person at `data/profiles/<conversation id>` (`src/browser.js:49-52`, `:66-70`), plain on disk, with no proxy and no fixed identity.

### B2. Where a saved login lives

A file of its own, `data/logins.db`, not `reason.db`. Copies of `reason.db` made for proofs and debugging (several were made on the live server on 11-12) then never carry a saved login, even sealed. It must be backed up only alongside `keys.db`, in the three-snapshot keystore backup (`deploy/reason-keystore-backup:2-9`), and never in the append-only off-site copy, so that a removed login is gone from every backup in three days.

`saved_logins`, one row per account per site:

| Field | What it is |
|---|---|
| `id` | Random 48-bit number, never a counter (same reason as `src/restcrypt.js:438-440`) |
| `conversation_id` | Whose it is |
| `site`, `label` | The site's registrable domain (`xfinity.com`) and the name shown (`Xfinity`) |
| `signin_origin`, `signin_path` | The exact origin that holds the password box (`https://login.xfinity.com`) and the path, no query string. Found by code at save time, shown on the save screen, pinned from then on |
| `username_ct`, `password_ct`, `totp_ct` | The sealed login. `totp_ct` holds the authenticator settings (key, digits, period, algorithm) or is empty |
| `wrapped_key`, `kms_key` | This login's own 32-byte key, wrapped by the cloud key service, and which cloud key wrapped it |
| `username_hint` | "o…@gmail.com", for lists. Sealed under the person's ordinary key |
| `permission` | `standing` or `each_time` |
| `second_step` | Learned on first sign-in: `none`, `email`, `sms`, `totp`, `push` |
| `state` | `unverified`, `working`, `wrong_password`, `needs_person`, `paused`, `refused` |
| `consent_version`, `consent_at`, `consent_credential` | Which wording they agreed to, when, and which passkey signed it |
| `fail_count`, `next_try_at`, `last_used_at`, `unused_warned_at` | The lockout budget (section D) and the 90-day rule |

`login_log` is the activity record (B10). `login_intake` holds the one-time save links (token hash, person, site, pinned sign-in page, the quoted request, expiry).
The saved browser session is a sealed archive per person (B7).

### B3. Keys

**A cloud key service is required.** With the master in a file on the same disk, one provider snapshot or disk image holds the key and the data together. The owner's 11-09 encryption note already says so and lists moving to KMS as the upgrade.

```
AWS KMS key "reason-vault" (symmetric, never leaves KMS)
  └ one data key per saved login (KMS GenerateDataKey), stored only wrapped, in logins.db
      └ each field: AES-256-GCM, fresh 12-byte nonce

AWS KMS key "reason-vault-intake" (RSA 4096, encrypt/decrypt; the private half never leaves KMS)
  └ its public half is in the save page: a new login is sealed in the person's browser
```

- **One KMS call per sign-in.** The login's key is unwrapped by KMS at the moment of filling and wiped after. It is never held in memory between sign-ins. This is the opposite of the general sealing, where the install key sits in memory all day (`src/restcrypt.js:116`).
- **KMS itself checks the binding.** The wrap carries an encryption context: `{ app: "reason", purpose: "saved-login", person: <keyed hash>, item: <id>, origin: <signin_origin> }`. AWS: "the same encryption context is required to decrypt the data." When the filler asks for the key it sends the origin it reads from the browser at that moment, not the one in the row. So a row copied to another person, a sign-in address edited in the database, or a tab sitting on any other origin fails to unwrap at Amazon, not just in Reason's code. `person` is a keyed hash, never a phone number, because the context "appears in plaintext in AWS CloudTrail Logs".
- **Each field is bound again:** associated data `sl1|<item id>|<field>|<signin_origin>`.
- **An outside record of every use.** "CloudTrail logs all AWS KMS operations, including ... cryptographic operations, such as GenerateDataKey and Decrypt." That log is in AWS, where the server cannot edit it. (AWS lets a trail leave KMS events out; this one must keep them.) The count of unwraps must equal the count of sign-ins in `login_log`; a difference is an alarm.
- **A kill switch.** Disabling the KMS key stops every saved login from opening, everywhere, at once, even on a server someone else controls.
- **Who may unwrap.** A key policy that names one AWS login only, limited to the server's address (the same condition the owner's existing KMS setup note uses). At the owner stage this may be the server's one AWS login. Before `on`, the vault gets its own (PR 10).
- **Cost:** AWS charges "$1/month" per key, plus cents for requests. Three keys with the general master moved too: about $3 a month.
- **No fallback.** With the switch on and no KMS, the vault refuses to start. No file master, no `.env` key. Tests use a local stand-in, as `src/restcrypt.js:195` already allows.
- **Not reused:** `REASON_TOKEN_KEY` (already doing four jobs), the install key, the transparent read path, the opened-value cache.

What KMS does not do: someone who controls the running server can ask KMS exactly as Reason does. KMS then gives a rate, a scope and a trail, not prevention. Section F says what that leaves.

### B4. Saving a login

1. **Code decides a save link may exist.** The site is not on the never list. Reason's browser has reached this site's sign-in form today (a site that will not load is never asked for a login). The pinned sign-in origin comes from that visit (`locateSigninPage`, PR #525), never from the AI and never from a link in an email.
2. **The link** is `heyreason.com/web/save-login/<token>`: 24 random bytes, kept only as a hash, one use, thirty minutes, sent as its own bubble after Reason's words (`src/links.js:73-75`) with the "Secured by Reason" card.
3. **The page** shows the person's own request quoted from the thread (as plain text), the site, the sign-in host, the boxes, the wording and the choice (section A). It is served with no third-party script or frame at all, scripts by nonce only, `frame-ancestors 'none'`, `no-store`, `no-referrer`.
4. **On "Save with Face ID"** the page has already sealed the boxes inside the person's browser to the intake public key (WebCrypto RSA-OAEP wrapping a fresh AES-GCM key), and asks for a passkey signature. The server's part of the challenge is a hash of: `reason-login-v1`, the intake id, the person, the site, the pinned origin, the permission, the consent version and a nonce. The page appends the hash of the sealed blob. Passkey options are drawn into the page because Safari wants the passkey call inside the tap (`src/pages/webapprove.js:17-18`), so the sealing happens as the boxes are typed, not after the tap. This is a third approval kind beside `pay` and `cap`. So Face ID signs this login, for this site, under this wording, and nothing else.
5. **The server** checks the signature, claims the link, and passes the sealed blob to the vault. Netlify and the web server only ever carry ciphertext. The vault opens it through KMS, checks it, makes the login's own key, re-seals, stores, wipes.
6. **Reason signs in at once** to check it, while the person is there (section D).

No passkey yet: the same link first proves the browser with a texted code (the existing gate, `src/connectgate.js:171-185`), then sets up Face ID. The first passkey works at once; a later one waits 24 hours and is announced, as today. New passkeys are named "Reason", not "Reason purchases" (`src/passkey.js:159-160`). Passkey removal has to be built (`removed_at` is never set today).

A password sent by text: refused with fixed words ("Don't text me passwords: texts are kept by your phone company and in my history. Use this instead:" and the link), and the stored copy of that message is replaced by a placeholder, the way a texted code already is (`src/signinemail.js:422-436`).

### B5. Filling a login so that neither the AI nor a picture ever holds it

The AI gets one tool, `account_signin`, whose only input is the site. It returns one word and one fixed sentence. Everything between is code.

1. **Gates, in code.** The switch covers this person. The site is not on the never list or paused. A saved login exists and its state allows a try. Permission: `standing` needs a live ask (this turn was started by the person's own message, a tapped card, or a job they approved; never by an email, a page, a timer or the nightly review). `each_time` needs a fresh Face ID link for this sign-in.
2. **The sealed step begins.** One lock per person covers the browser. While it is held, every browser tool answers "signing in" and takes no snapshot and no screenshot. Today nothing stops a browser tool from opening a profile a sign-in flow holds (no shared check in `src/tools.js`).
3. **Code goes to the pinned page itself,** in a new tab. It never fills on a page the AI was on and never follows a link from a page or an email to get there.
4. **Origin check.** The tab's address after all redirects, read from the browser, must equal the pinned origin exactly: scheme, host and port, compared as strings. No "ends with", no look-alike, no fill after a redirect to another site. The password box must be in that same origin's frame, visible, of type `password`. A challenge page, a different origin, or no form means stop and report. Certificate errors are never ignored.
5. **Unwrap and type.** One KMS call, made with the origin the browser is on (B3). The username, then the password, are typed by code. The origin is checked again immediately before the password is typed. "Remember this device" is ticked when offered.
6. **Second step** if asked (B6).
7. **Clean up before the AI looks.** After submit, wait for the page to move on. Any box the filler typed into that still exists is emptied. Only then does the lock release.
8. **Result.** One of: `signed_in`, `needs_code_sms`, `needs_approval`, `wrong_password`, `blocked`, `not_signin_page`, `origin_mismatch`, `paused`, `needs_face_id`. Never page text, never an address with a query string.

Nets under the first net:

- **The snapshot stops returning field contents** for password, one-time-code and similar boxes, always, for everyone (PR 1). Today it returns the first 80 characters of every box (`src/browser.js:151`) and uses a box's contents as its name when it has no label (`:131`).
- **A scrubber** knows the secret for the length of the sealed step and removes any exact copy from anything a browser tool returns. Playwright's own docs call this kind of scrub "a convenience and not a security feature": it is the second net, not the first.
- **No recording, ever.** Playwright's trace keeps the live value of every input and its accessibility snapshot includes input values, with no exception for password boxes (source lines in the list at the end). Tracing, video and HAR are off today; a test fails the build if any is turned on.
- **Errors do not carry the secret.** The filler catches every browser error and reports a fixed code. Whether Playwright's error text can include what was typed is not verified; the design does not rely on it.
- **A secret type** that prints as `[secret]` in logs, JSON and inspection. None exists today.

"Sign in" buttons are not gated clicks today (`COMMIT_WORDS`, `src/tools.js:2284`), and the AI can type any text into any box (`:19221`). That is acceptable only because the AI never has the secret.

### B6. Second steps

| Step | How it is cleared | Limits |
|---|---|---|
| Emailed code or link | The existing reader (`src/signinemail.js`): only mail from the site's domain that Gmail itself marked as passing DKIM, newer than the ask, typed only while the tab is still on the site (`:512`). Links must be https on the site's own domain (`:398-405`). | Only when Reason asked the site for the code seconds earlier. Reason never acts on a code or link that arrived unasked. |
| Texted code | Asked in the thread with the fixed line in section A. The reply is taken at intake, before the AI's turn (`src/channels/router.js:295-302`). One try. | Only inside a job the person just asked for. Never asked twice running. |
| Authenticator | The code is computed inside the vault from the saved key (RFC 6238) and typed. The key is never returned. | The person usually has to re-enrol two-step on the site to see a setup key. Reason then holds both factors. Backup codes are never saved. |
| Approve in app | Reason texts first, naming the device and place the prompt will show, and any number to match. Then waits two minutes. | Only inside a job the person just asked for. |
| CAPTCHA | Stop. | Never solved, by Reason or by a service. |
| Security question, passkey, "Continue with Google / Apple" | Not supported. | Said plainly. |

### B7. Staying signed in, and signing back in

- **The session is a login too.** Today it sits plain on disk. Chromium's own protection on Linux needs a desktop keyring and otherwise falls back to its plain store (Chromium docs; that page is about saved passwords, and cookie protection uses the same mechanism as far as this review knows). New rule: when the browser closes, the profile is packed (caches left out), sealed with the person's key, and the plain folder is removed. When the browser opens, it is unpacked into memory-backed storage. Folder names use the key id, not the phone number. Whether profiles are in the off-site backup today is not known and must be checked on the server.
- **No visits to keep a session warm.** Reason opens a site when a job needs it.
- **Signing back in.** At the start of a job, signed-in is read from positive evidence (PR #525), not from the absence of "sign in" words (`src/sites.js:379-383`). If signed out: sign in again silently when no human step is needed; otherwise ask, inside the job. At most one automatic sign-in per site per day. A site that signs Reason out three times in a week is paused and the person is told: the site is saying something.

### B8. What Face ID protects

| Action | Needs | Why |
|---|---|---|
| Save a login | Face ID, signing this login for this site under this wording | Proof of who agreed and to what |
| Replace a password or add an authenticator key | Face ID | Otherwise someone in a stolen Reason Web session could swap in their own account, and "pay my Xfinity bill" would pay theirs |
| Change "each time" to "standing" | Face ID | It widens what Reason may do |
| Read a saved password back | Not possible | The person knows their password. Nothing to steal from an unlocked phone |
| Use, standing | No Face ID. A live ask, and a line in the record | Autonomy |
| Use, each time | Face ID per sign-in | Their choice. Forced for careful-list sites |
| Pay or move money inside the account | The existing Face ID payment approval and daily cap, also when the site charges a card it already has on file | The same rule as every other payment |
| Change "standing" to "each time", pause, remove | No Face ID. A text or one tap | The safe direction must be easy |

**Recommendation: a standing per-site permission with an activity record is right, with Face ID on saving, widening and money.** Face ID on every use would make "say yes once" impossible and would train people to approve prompts all day.

### B9. Consent wording

The screen in section A is the consent, versioned (`consent_version`). The row keeps which passkey signed which version and when. Careful-list sites add one site-specific line above the button, for example: "Ticketmaster bans automated sign-in and has closed accounts for it." A change to what Reason does with a login is a new version and a new Face ID.

The privacy policy gains a paragraph in the house form: what is kept, that it is locked by a key outside the server, that Reason and the company "can technically access it", how to remove it, and what a deletion reaches.

### B10. The activity record

Every save, sign-in, re-sign-in, code used, refusal, failure, permission change, sign-out and removal writes one `login_log` row and one `action_ledger` row.

- "Thu 3:02 pm. Signed in to Xfinity with your saved login and an emailed code, to pay your October bill."
- "Fri 9:10 am. Xfinity had signed me out. Signed back in, to check your bill."
- "Fri 9:11 am. Xfinity refused my browser. I stopped and did not retry."

The person reads it by text ("what did you do in my accounts this week?", through `ledger_list`) and on a page, `heyreason.com/web/accounts`, which also lists saved logins with Remove and the permission choice. The purpose text is sealed under the person's key. The record never holds a username, a code or an address with a query string. The first sign-in to each site is also said in the thread.

### B11. Disconnect that really signs out and deletes

"Forget my Xfinity login", or Remove on the page:

1. Sign out on the site with the live session, and check it took.
2. Clear that site's cookies and storage from the profile (`signin.forgetSite`, `src/signin.js:362-417`).
3. Delete the saved login and its wrapped key (`secure_delete` is on).
4. Scrub what was read there from the thread (`src/tools.js:14801-14812`).
5. Tell the person what could not be confirmed: "I deleted your login and my session. I couldn't confirm Xfinity ended it on their side. To be sure: Xfinity, Settings, Devices, sign out 'Chrome on Linux'."

Found while reading, outside this design but part of the same promise: only Google is revoked at the provider on disconnect (`src/google.js:905`); Uber's disconnect has no caller (`src/uber.js:360`); a full delete never reaches Crossmint's profile or saved card (`src/data.js` imports no `shopconnect`).

### B12. Export, delete, retention

- **Export** lists sites, username hints, dates, permission and the activity record. The login itself is replaced by the existing marker, "[not exported: this is a live credential]" (`src/data.js:340`). The coverage test (`src/data.js:186-187`) is extended so the vault cannot be forgotten.
- **Delete my data** and **forget everything**: sign out of each site, delete every saved login, the sealed session and the wrapped keys, then destroy the person key as today (`src/data.js:719-723`).
- **Retention:** unused for 90 days, one warning text, deleted 14 days later.
- **Never read by:** the nightly review (it reads `event_log` text only, `src/dream.js:367-370`), the recall index, the export, the ops page, any tool. The vault has no function that returns a secret.
- Today an ordinary person has no self-serve export or full delete (`src/data.js:1-9`; `admin_delete` is master only). Saved logins must be removable by the person alone from day one.

### B13. If there is a breach

1. **Stop it:** set the switch to `off` and disable the KMS key. Nothing opens after that.
2. **Size it:** the AWS record lists every unwrap in the window, by person hash, login and site. Logins unwrapped in the window are "possibly exposed". Logins not unwrapped stayed ciphertext, provided the attacker had no other path to KMS.
3. **Tell people** in their thread, by site, the same day: change that password and anywhere it was reused, and sign out other devices. Reason signs out its own sessions.
4. **The law:** California counts "a username or email address, in combination with a password ... that would permit access to an online account" as personal information, with notice "within 30 calendar days". Notice also applies to encrypted data when the key was taken too.
5. **Start clean:** a new KMS key. People save again.

What limits the damage: no bulk unwrap without KMS; one key per login; a record outside the server; nothing readable in logs, exports or backups; unused logins removed; and the never list keeps out the accounts from which everything else can be reset.

---

## C. The never list and the careful list

### Never: no saved login, no exceptions

| What | Why | The route instead |
|---|---|---|
| Banks, credit unions, brokerages, retirement, lenders, payment apps, crypto exchanges | Regulation E: a transfer by someone the person "furnished the access device" to is not "unauthorized", and "the consumer is fully liable". Chase's terms (effective 2026-10-27) forbid "External AI, automated tools, or data aggregators" from using the login | Plaid, read-only (PR #520) |
| Apple ID | It unlocks their devices and every password they have saved | None. Reason does not act inside Apple accounts. The Apple calendar app password Reason can already take (never used live, `src/icloud.js:34`) is an Apple credential too, and an app password is not limited to the calendar (Apple's own description, not re-read tonight). It moves onto the save screen under these rules, or the feature goes |
| Google account password | "Google might stop sign-ins from browsers that" ... "Are being controlled through software automation rather than a human" | Google's own permission page |
| Their main email, any provider | It resets everything else | Official connect only |
| Password managers | Obvious | None |
| Government portals (IRS, Social Security, login.gov, ID.me, DMV, immigration, benefits) | Identity and legal exposure | Phone, or walking them through it |
| Health portals and insurers | Health records | Phone |
| Work or school accounts, anything behind an employer's sign-in | Not theirs to share | None |
| Phone carriers | The account controls the number that guards everything else, including Reason | Guest pay or phone |
| Sites whose terms forbid giving an agent the login, or that have told Reason to stop | Uber: "may not share them with any Agent or Agent provider unless Uber has authorized that Agent" | Official connect (Uber has one) |
| Social networks | Their terms ban automated access and allow closing the account (Instagram and LinkedIn, as reported by a second reader) | Official connect (X has one) |
| Ticket buying | The BOTS Act makes getting round a ticket seller's controls unlawful; Ticketmaster bans "bot technology" | None |
| An account that is not their own | Consent must come from the holder | None |

### Careful: allowed, with "ask me with Face ID every time", an extra warning line, and no standing permission

Sites that hold value or punish automation but have no rule against the person's own agent: airlines and hotel points (Delta: a third-party agent is used "at your own risk"), marketplaces, streaming, gaming.
Amazon is its own case. Its terms (2026-08-14) allow an agent that puts `Agent/[agent name]` in every request, does not copy human typing, never touches a CAPTCHA, and stops when asked. Reason signs in to Amazon only as a declared agent, or not at all.

### Everything else

Allowed when the classifier finds no never category and Reason's browser reaches the sign-in form. Unknown sites go into a weekly review list (domain names only).

### How a site gets on and off

The lists are a reviewed data file in the repo (`src/sitepolicy.js`): domain, category, policy, reason, source address, date read, reviewer. The AI never decides, and neither does a person's insistence.

- **On, by rule:** bank domains (Plaid's institution list plus a hand list), `.gov` and `.mil`, known identity and work sign-in hosts, mailbox providers (the list at `src/signinemail.js:62`), carriers, password managers.
- **On, by review:** someone reads the site's terms and records the sentence.
- **Paused automatically, for everyone:** two refusals or lock messages at one site across people in seven days; any "we detected automated access" page; any report of a locked or closed account after Reason signed in. The owner is told.
- **Never, at once:** any notice from a site asking Reason to stop. After that, carrying on is the Power Ventures case.
- **Off:** only by a reviewed change that says what changed: the site opened an official connect, changed its terms, or published agent rules Reason follows. The category rows above have no way off except an official route.
- A person can add their own never entries ("never save a login for X") and remove their own.

### What Reason says when asked for one (fixed words, returned by code as `refuseAPassword` is today)

- **Bank:** "I don't keep bank logins. For your bank I use a read-only connection where you sign in on the bank's own page and I never see the password. Want the link?" Until Plaid is live: "I can't work inside bank accounts yet. I can call the bank with you, or remind you."
- **Apple ID:** "I don't sign in to Apple accounts. That password unlocks your devices and every password you've saved, so it stays with you."
- **Google:** "Google only lets me in through its own permission page, so I never need your Google password. Here's that page:"
- **Main email:** "I don't keep email passwords. Your email can reset everything else you own."
- **Government or health:** "I don't sign in to government or health sites. I can call them for you, or walk you through it."
- **Work:** "That account belongs to your employer, so I can't hold it."
- **Carrier:** "I don't keep your phone carrier's login: that account controls your number. I can pay the bill without signing in, or call them."

---

## D. New-device alarms and lockouts

What sites say they do: Netflix emails "whenever there's a new sign-in ... from a new device" and tells the person to "change your password immediately" if they do not recognise it. Amazon asks for more proof when "signing in from a new browser, device, or location" and may respond to suspicion by "Disabling your Amazon account password" and "Cancelling any pending orders". Microsoft (as reported by a second reader): "Don't make lots of repeated attempts, as this may reset any time lock."

1. **One stable browser per person.** One launch setting used by every flow: same Chrome build, same window size, the person's own language and time zone, the same profile. Today the sign-in flows open the same profile at 430x700 and errands at 1280x900 (`src/signin-remote.js:99-105`, `src/browser.js:66-70`), and the build changes whenever Playwright is upgraded. Browser upgrades happen on a schedule, not with every deploy.
2. **One stable, honest location.** One reserved exit address for the browser, never rotated, never a pool of home addresses. Rotating addresses make every sign-in a new place, and Kernel's own docs say rotating pools are penalised. A change of server address is a planned event with a notice to people first. The heads-up names the place from a setting the operator keeps true.
3. **Tell them before the first sign-in** what the site may send and what it will say (section A), and that tapping "this wasn't me" will lock Reason out and may force a password reset.
4. **The first sign-in happens while they are there,** straight after saving, so any challenge arrives with their phone in their hand.
5. **One wrong password, then stop** until they save again. Never a variant, never another saved password, never another address.
6. **One refusal, then stop.** A wall, a CAPTCHA, "unusual activity", "too many attempts": record it (`src/sitefindings.js`), tell them in the site's words, offer the next route. No retry from another address or browser. A lock message means 24 hours of nothing.
7. **Never** "forgot password", never a security setting, never answering "was this you?" for them.
8. **Many people, one address.** To a site, one address signing in to many accounts looks like a break-in attempt. It cannot show up at the owner stage. Watch refusals per site as people are added; the automatic pause in section C is the brake.
9. **Known side effects go in the wording:** some sites limit devices or sign the person's own device out when a new one signs in.

---

## E. The browser underneath

### When Reason's own browser is enough

When the site's sign-in form loads in it and one real sign-in works. On 11-12, 24 of 44 sign-in pages loaded. The file names only the 20 that did not, and names a wall vendor for two of them (Cloudflare, for DoorDash and Uber). Which 24 loaded was not written down.

Honest improvements to try first. None hides what the browser is:

- One stable launch setting (section D).
- The real Chrome build instead of the cut-down headless one, with a window. Playwright ships "a separate chromium headless shell for headless mode" and says of the newer mode that it "is the real Chrome browser, and is thus more authentic".
- Move the private-network guard out of the page. Today every request is intercepted to check it (`src/browser.js:292-302`). Browserbase says "Blocking images or other resources via request interception (`page.route`) is not recommended on sites with bot protection." Reason's guard blocks almost nothing, so whether it trips a wall is untested; setup A3 below tests it. A firewall rule for the browser's user does the same job from outside.
- Say who it is. Register Reason as a signed agent (an Ed25519 key list at `heyreason.com/.well-known/http-message-signatures-directory`, Cloudflare's submission form). Where a site's terms say how an agent must name itself (Amazon: `Agent/Reason` in the user agent), do exactly that.

What signing does today: it labels. The IETF draft: it "says nothing about ... whether the request is authorized. Those are origin policy." Cloudflare's own signed browser "is always given a bot score of 1", the score for certainly automated. DataDome blocks unauthenticated agents "by default" and lets its customers "decide to authorize them". Browserbase: "A valid signature doesn't grant access or sign your agent into a user account." It costs little and is the right long-term posture, but it will not open the 20 this year.

### When a hosted browser would be needed, and why not to plan on one

A hosted browser opens walls three ways: a patched browser that hides automation, a home or ISP exit address, and CAPTCHA solving. All three are what `src/agent.js:187` forbids ("No pretending to be a different browser, no getting round a CAPTCHA"), what Amazon's and Uber's terms name as breaches, and, after a site has said stop, the Power Ventures case. Other facts from the vendors' own pages:

- Browserbase's "Verified" browser, the one its "bot protection partners recognize", is on the Scale plan only, with no public price. Developer and Startup get "Basic", always on a Linux fingerprint. Fixed exit addresses are Scale-only too.
- Browserbase "logs and records every session by default". Both must be switched off per session for anything that types a password.
- Its Live View: "Mobile keyboards aren't officially supported." Not a human step on a phone.
- Kernel hides automation on every plan, offers fixed ISP exit addresses, and has its own login vault. Its proxies do not carry banking, payments or government sites.
- The home-address pools behind these products are "less reliable" for streaming, ticketing and webmail (Browserbase's own list).
- Google says it may stop automated sign-ins whatever the browser.

If a hosted browser is ever used for a named site, the login should live with that browser's vendor and never touch Reason. A password typed into a vendor's browser is in the vendor's hands anyway. The rule: **a login is kept by whoever runs the browser that uses it.** Reason's vault for Reason's browser; the checkout service's box for its browser.

### The probe: exactly what to test, and how

Load only. No typing, no accounts, no sign-in, no CAPTCHA solving, one page load per site per setup, a signed-out scratch profile, sites on the never list left out.

- **Sites:** the 20 refused sign-in pages in `docs/site-probe-2026-11-12-signin.json`, plus the 24 that loaded as controls. Their names must be recovered or re-collected.
- **Per load, record:** status, final host, page kind (`signin_form`, `challenge`, `provider_prompt`, `not_signin`, from PR #525's `pageKind`), milliseconds to a form, and the wall vendor read from cookie and header names only (`cf-ray` and `cf-mitigated`; `_abck` and `ak_bmsc`; `datadome`; `_px*`; `x-kpsdk-*`; `incap_ses` and `reese84`).
- **Honest setups (no further decision needed, cost $0):**
  - A0: today's browser as it is, from the server. The baseline.
  - A1: the same build with a window and the single stable setting.
  - A2: the real Chrome build with a window.
  - A3: A2 with the request guard moved to a firewall rule.
  - A4: A2 from a home connection, to separate the address from the browser.
  - A5: A2 with the signed identity and declared name, once registered.
- **Disguised setups (only with the owner's explicit OK; this is a measurement, not adoption):**
  - B1: one hosted vendor with its default hiding and a fixed ISP address, CAPTCHA solving off. Leave Uber and Amazon out, since their terms forbid a hidden agent. About $30 for one month of Kernel, or $20 for Browserbase Developer.
- **Result:** `docs/site-probe-<date>-setups.json`, and for each site the least-disguised setup that reached a sign-in form.
- **Reading it:** a site an honest setup opens is eligible for a saved login. A site only B1 opens stays closed to the vault: official connect, checkout service, phone. A load proves nothing about a sign-in: the next test is three to five real sign-ins with the owner's own accounts.

### Cost per person per month

Reason's own browser on the server it already has: no added cost per person. A reserved address is a few dollars a month for everyone.

Hosted or proxied options at three usage levels: light (4 jobs a month, 3 minutes and 30 MB each), typical (15 jobs, 4 minutes, 40 MB), heavy (60 jobs, 5 minutes, 50 MB). The megabytes are an assumption; no measured figure for "one sign-in plus a short task" was found.

| Option | Monthly minimum | Light | Typical | Heavy |
|---|---|---|---|---|
| Browserbase Developer | $20 | $1.46 | $7.32 | $36.60 |
| Browserbase Startup | $99 | $1.22 | $6.10 | $30.50 |
| Kernel, with a window, proxies not metered | $30 ($200 for your own proxy) | $0.10 | $0.48 | $2.40 |
| Steel hosted, Launch / Scale | $0 / $250 | $1.22 / $0.74 | $6.10 / $3.68 | $30.50 / $18.40 |
| Own Chrome plus a home-address proxy at $4 a GB | $0 | $0.48 | $2.40 | $12.00 |
| Own Chrome plus one fixed home address per person | per address | $2.70 to $3.50 | same | same |

Where proxy data is metered it is 95 to 98 percent of the bill. Browserbase Scale (the only tier with Verified and fixed addresses) has no public price.

---

## F. Threat model

| Threat | What it would do | What stops or limits it | What is left |
|---|---|---|---|
| **Stolen database or backup** | Read every login | `logins.db` holds ciphertext and KMS-wrapped keys only. Backed up only in the three-snapshot keystore backup | Nothing opens without KMS |
| **Stolen disk image or provider snapshot** | Key and data together | The key is in KMS. The AWS login on the disk works only from the server's address | Whoever can also act from that address has the server (next row) |
| **Stolen running server** | Ask KMS as Reason does | One unwrap per login, each logged outside the server; the alarm on count; the kill switch; before `on`, the vault is its own process and user | Logins used while the attacker is in, and any they trigger, are exposed. Sessions can be ridden until signed out. No design at rest prevents this |
| **A page tries to get the login typed into the wrong site** | Harvest the password | The filler navigates itself to the pinned address. Exact origin match after redirects. KMS is asked with the origin the browser is on and refuses any other. The AI cannot aim the filler | None found for a different origin |
| **Look-alike domain, open redirect** | Same | Exact string match on the pinned origin; no fill after a redirect off it | None found |
| **A fake form on the real site** (a site that shows user content, or a script flaw there) | Password posted elsewhere from the true origin | Fill only at the pinned path, reached by the filler's own navigation; a password prompt elsewhere on the site is refused at first | A flaw on the real sign-in page itself. Password managers share this |
| **Prompt injection in a page** | Make the AI hand over or misuse a login | The AI has no login to hand over. `account_signin` takes only a site name. A sign-in needs a live ask. While signed in for a job, the browser may only navigate within that site's own hosts, so what it reads cannot be carried to another site in an address. Money and irreversible steps need their own approval | The AI can be steered to read things inside the account and say them in the thread |
| **Prompt injection in an email** | "Your session expired, sign in here" | Reason never reaches a sign-in from a link in mail. A code or link is used only seconds after Reason asked the site for it, from the site's domain with Gmail's DKIM pass | A real site's own mail arriving in the same 90 seconds with a code in it could be picked up (`src/signinemail.js:37-38`); it would only fail to sign in |
| **A fake Reason page asks them to save a login** | Phish the password | The real link comes only in their own thread, only after they ask. The real page quotes their own request, which a stranger cannot know. The passkey sheet names heyreason.com and will not appear for another domain. Reason says in the consent that it never asks out of the blue | An inattentive person can still be fooled. A well-known 2007 study of bank "site key" pictures found most people typed their password when the picture was missing (not re-read tonight). The in-app screen is the strong fix later |
| **A fake Reason asks for a code** | Take over an account | Fixed wording: a code is only asked for right after their own request, in their thread, naming the site | The habit itself is a risk |
| **Someone holding their unlocked phone, or their number (SIM swap)** | Text Reason as them and use standing permissions | Money needs Face ID. Saving, replacing and widening need Face ID. Nothing can be read back. First sign-ins are announced. The record shows every use. "Each time" exists for sites they care about | Within a standing permission that person can have Reason read and change things that need no money |
| **Stolen Reason Web session** | Swap a login, read logins | Replacing needs Face ID. Reading is impossible. A new passkey waits 24 hours and is announced | Removing logins (a nuisance) |
| **Insider: root, the owner, builder sessions on the server** | Use the vault | No screen, tool or command shows a login. Each unwrap is logged in AWS, which the server cannot edit. The vault file is never copied for proofs. Before `on`: its own user, and a rule that builders never run as it | Root can make the vault sign in as a person. It cannot do it silently |
| **Logs and crash dumps** | A password in a log line | The login is sealed in the browser before it is sent. A secret type that will not print. Fixed error codes. Core dumps off for the service. Today logs mask only phone numbers and emails (`src/logmask.js:13-17`) and short strings print whole (`src/privacy.js:395`), so nothing may depend on masking | Memory of the live process during a sign-in |
| **The ledger and recall index** | A login in the plain ledger, then sent out for embedding | Browser tool results never contain field values (PR 1). `account_signin` writes fixed words only | None found |
| **The website host (Netlify)** | See what is typed on a Reason page | Sealed in the browser first | It could serve altered page code for new saves. So could a compromised web server |
| **The model provider** | See a login | It is never in a prompt, a tool result or a picture | A person who texts a password anyway, before the scrub |
| **Lost passkey** | Locked out of managing logins | Removing never needs Face ID. A new passkey waits 24 hours | A day's wait to add or change |

---

## G. Build plan

Small PRs, each with tests, each behind `REASON_SAVED_LOGINS` unless marked. The switch follows the house pair, `savedLoginsMode()` and `savedLoginsAllowedFor(conversationId)` with `accounts.featureOwner` (`src/shopconnect.js:53-63` is the model). Off looks like "does not exist": a flat 404 and no tool.

| PR | What | Tests | Switch |
|---|---|---|---|
| 1 | **Nothing typed into a sign-in box can reach the AI.** The snapshot stops returning contents of secret-type boxes; the scrubber; no query strings in sign-in evidence (`src/sites.js:370`); the Apple calendar password added to `SECRET_TOOLS` (`src/privacy.js:436`); a build check that tracing, video and HAR stay off | A fixture page with a filled password box: no value in the tool result, the ledger, the log or the thread | None. Good for everyone, whatever the answer |
| 2 | **One stable, honest browser, and the probe.** One launch setting for every flow; one per-person lock shared by browser tools and sign-in flows; the probe script and its results file for setups A0 to A4 | Two flows cannot open one profile; the probe types nothing (asserted) | Its own switch for the launch change, owner first |
| 3 | **Vault core.** `data/logins.db`; the KMS client (reuse `kmsCall`, `src/restcrypt.js:185-206`, add GenerateDataKey); sealing with bound data; the secret type; refuses to start without KMS; export and delete hooks | A stolen `logins.db` opens nothing; a row moved to another person or origin fails; delete leaves no key; export shows only the marker; no secret in any captured log line | `REASON_SAVED_LOGINS` |
| 4 | **Site policy.** The never and careful lists as data, the classifier, the fixed refusals | A table of hosts and expected answers: bank, `.gov`, Apple, Google, mail, work sign-in, carrier, unknown | Same |
| 5 | **The save screen.** The intake link and page, sealing in the browser, the `login` approval kind, passkey setup and removal, consent versions, refusing a texted password and scrubbing it | Replay, expiry, wrong origin, changed details, a swapped sealed blob, cross-site posts | Same |
| 6 | **The filler.** `account_signin`, origin binding, the sealed step, clean-up, fixed results, the attempt budget, navigation kept to the site during a signed-in job. Then the owner's first real sign-ins | Fixture sites: look-alike host, redirect to another origin, cross-origin frame, same origin wrong path, challenge page, one wrong password | Same |
| 7 | **Second steps.** Authenticator codes (RFC 6238 test vectors), the emailed-code and texted-code paths joined to the filler, the approval heads-up | Each path; one try only | Same |
| 8 | **Sessions sealed, real disconnect, signing back in.** | A plain profile never rests on disk; forget signs out, clears and deletes | Same |
| 9 | **The accounts page and the record.** List, remove, permission, activity; the 90-day rule | Raising needs Face ID, lowering does not | Same |
| 10 | **The vault as its own process and user, the AWS alarm, the breach runbook.** Required before `on` | The main process cannot unwrap | Same |
| 11 | **The wording sweep.** Every "never keep or see your password" line (`src/amazonconnect.js:31`, `src/signin.js:198`, `src/pages/setupsignin.js:100-101`, `src/agent.js:248-249`, `README.md:1538`, `docs/features.md:458`), the privacy policy and terms | A check that the old lines are gone where the switch reaches | Required before `on` |
| 12 | **The Apple calendar password moves onto the save screen** and out of the chat | The tool no longer takes a password | Same |

PRs 1, 2 and 4 are worth doing whatever the owner answers. PR 3 needs his AWS setup.

### Measured in the first week (owner mode)

- Sign-ins tried and succeeded, by route (already connected, official connect, emailed code or link, saved login, checkout profile, phone) and by site. `src/signinlog.js` gains routes `saved_login` and `saved_login_again`.
- Which second step each site asked for.
- Re-sign-ins: how many, how many silent, and how long each session lasted.
- Refusals: wall at load, wall after submit, wrong password, lock messages. "New sign-in" emails that arrived within ten minutes of a sign-in, counted from his mail.
- Jobs finished alone (one yes, no further human step) out of jobs started, and time from yes to done.
- KMS unwraps against sign-ins in the record. They must be equal.
- Scrubber hits. They must be zero; any hit is a bug in the first net.

### Open questions that need a real test

1. Does any honest setup reach any of the 20 refused sign-in forms? (The probe.)
2. On sites that load: does a sign-in from the server's address complete, and what second step follows? (Three to five of the owner's accounts.)
3. How long does each site keep the server's session?
4. Does Amazon admit a declared agent at sign-in?
5. Can Crossmint keep a store login for re-sign-in, and how does its browser pass walls Reason's does not? If by disguise, Reason directing it shares the exposure. (Ask Crossmint.)
6. Where does Google's review stand (the 100-account ceiling on reading mail)?
7. Are browser profiles in the off-site backup today? Are OVH's automatic snapshots off? (Read-only checks on the server. The second is already an open item in the encryption design note.)
8. Does Playwright's error text ever include typed text? What does Chromium do when a second process opens a profile already in use?
9. Does the passkey sheet on the owner's iPhone show "heyreason.com" clearly enough to be a signal?
10. Could a login marked "each time" be locked so that even the server cannot open it without their Face ID (the WebAuthn PRF extension, in Safari since version 18)? It cannot work for standing logins.
11. Does one address signing in to many people's accounts at one site trip it? Only visible past the owner stage.
12. A lawyer's reading of sections C and E, and of App Store guideline 5.1.1(v) for the later iPhone app ("may not store credentials or tokens to social networks off of the device").

---

## Sources

All read 2026-11-12. Full quotes and more addresses are in the working notes kept with tonight's research.

**This repository, at `27cdace0`:** files cited inline. `docs/site-probe-2026-11-12-signin.json`, `docs/site-probe-2026-11-12-food.json`, `docs/google-verification.md`. The owner's encryption design note of 11-09 and AWS setup note (on his Mac, not in the repo).

**Agents signing in**
- WorkOS, "Logging AI agents into web apps" (2026-03-31): https://workos.com/blog/logging-ai-agents-into-web-apps
- Model Context Protocol 2025-11-25, elicitation: "Servers MUST NOT use form mode elicitation to request sensitive information such as passwords": https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- 1Password for Agents: https://support.1password.com/1password-for-agents/ , https://support.1password.com/1password-for-agents-security/ , https://www.1password.dev/agentic-autofill/partners/approval , https://www.1password.dev/agentic-autofill/partners/fill
- Kernel: https://www.kernel.sh/docs/auth/managed-auth.md , https://www.kernel.sh/docs/browsers/bot-detection/overview.md , https://www.kernel.sh/docs/proxies/isp.md , https://www.kernel.sh/docs/acceptable-use.md , https://www.kernel.sh/docs/info/pricing.md
- Browserbase: https://www.browserbase.com/pricing , https://docs.browserbase.com/platform/identity/overview.md , https://docs.browserbase.com/platform/identity/proxies.md , https://docs.browserbase.com/platform/browser/observability/observability.md , https://docs.browserbase.com/platform/browser/observability/session-live-view.md , https://docs.browserbase.com/platform/browser/core-features/contexts.md , https://docs.browserbase.com/optimizations/cost/cost-optimization.md
- Steel pricing: https://steel.dev/pricing
- Playwright: https://playwright.dev/docs/browsers ; trace snapshots keep input values: https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/trace/recorder/snapshotterInjected.ts ; accessibility snapshot includes input values: https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/ariaSnapshot.ts ; "a convenience and not a security feature": https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md
- Chromium on Linux, password storage: https://chromium.googlesource.com/chromium/src/+/main/docs/linux/password_storage.md

**Signed agent identity**
- IETF draft: https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/
- Cloudflare: https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/ , https://developers.cloudflare.com/bots/concepts/bot/verified-bots/ , https://blog.cloudflare.com/signed-agents/
- DataDome: https://docs.datadome.co/docs/bot-authentication

**Google**
- "Sign in with a supported browser": https://support.google.com/accounts/answer/7675428
- Device-bound sessions: https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/

**Keys and storage**
- AWS KMS: https://aws.amazon.com/kms/pricing/ , https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html , https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html , https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html , https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html
- OWASP: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html , https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- RFC 6238, section 5.1: https://www.rfc-editor.org/rfc/rfc6238.txt
- WebAuthn Level 3, PRF extension: https://www.w3.org/TR/webauthn-3/#prf-extension ; Safari 18 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes
- Passkeys across devices need Bluetooth closeness: https://fidoalliance.org/passkeys/

**Terms** (Instagram, LinkedIn and Ticketmaster as reported by a second reader, not re-checked)
- Amazon Conditions of Use, updated 2026-08-14: https://www.amazon.com/gp/help/customer/display.html?nodeId=GLSBYFE9MGKKQXXM
- Uber General Terms, modified 2026-11-04: https://www.uber.com/legal/en/document/?name=general-terms-of-use&country=united-states&lang=en
- Chase Digital Services Agreement: https://www.chase.com/content/dam/legal-agreements/library/en/dsa_la/versions/dsa_la.pdf
- Delta: https://www.delta.com/us/en/legal/terms-of-use
- Netflix: https://help.netflix.com/legal/termsofuse
- Spotify: https://www.spotify.com/us/legal/user-guidelines/
- Verizon: https://www.verizon.com/support/website-use-legal/
- DoorDash: https://help.doordash.com/legal/document?type=cx-terms-and-conditions&region=US&locale=en-US
- Instagram: https://help.instagram.com/581066165581870 ; LinkedIn: https://www.linkedin.com/legal/user-agreement ; Ticketmaster: https://legal.ticketmaster.com/terms-of-use/

**Law**
- Amazon v. Perplexity, Ninth Circuit No. 26-1444, 2026-08-04: https://cdn.ca9.uscourts.gov/datastore/opinions/2026/08/04/26-1444.pdf . The case continues in the district court; a motion to dismiss is set for 2026-11-20: https://www.courtlistener.com/docket/71874820/amazoncom-services-llc-v-perplexity-ai-inc/
- Facebook v. Power Ventures, Ninth Circuit No. 13-17102, amended 2016-12-09: "Permission from the users alone was not sufficient to constitute authorization after Facebook issued the cease and desist letter." https://cdn.ca9.uscourts.gov/datastore/opinions/2016/12/09/13-17102.pdf
- hiQ v. LinkedIn, Ninth Circuit, 2022-04-18: https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf
- Van Buren v. United States: https://www.law.cornell.edu/supremecourt/text/19-783
- Regulation E, 12 CFR 1005.2(m) and comment 2(m)-2: https://www.consumerfinance.gov/rules-policy/regulations/1005/2/
- BOTS Act, 15 U.S.C. 45c: https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section45c&num=0&edition=prelim
- California Civil Code 1798.82: https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1798.82.&lawCode=CIV
- App Store Review Guidelines 5.1.1: https://developer.apple.com/app-store/review/guidelines/

**New-device notices**
- Netflix: https://help.netflix.com/en/node/100775
- Amazon: https://www.amazon.com/gp/help/customer/display.html?nodeId=G9MX9LXNWXFKMJYU , https://www.amazon.com/gp/help/customer/display.html?nodeId=TE5CIPZDRx2EmX8lzk
- Microsoft: https://support.microsoft.com/en-us/accounts-billing/manage/troubleshoot-microsoft-verification-code-issues

**Not verified, and said so above:** how Crossmint's browser passes walls and whether it can keep a login (its docs were read by another builder tonight, not here); the price of Browserbase's Scale plan; whether any of the 20 walled sites admits any signed agent; megabytes per job; whether cookie storage in Chromium on a server follows the same fallback as password storage; whether Playwright error text can carry typed values; the live server's settings (nothing on the live server was read or touched for this document).
