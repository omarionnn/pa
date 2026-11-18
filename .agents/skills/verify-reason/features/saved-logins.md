# Saved logins — save a site's login once, Reason signs in for you (the vault, REASON_SAVED_LOGINS)

A person saves a site's login once, on Reason's own page, and from then on Reason signs in to that
site for jobs they ask for: the login is typed by code into the site's own sign-in page, never seen
by the model, never in the chat. "Ask me each time" logins need their Face ID for every use. They can
forget a login by text at any time.

**Switch:** `REASON_SAVED_LOGINS` = off | owner | on (default off, read at call time,
`src/savedlogins.js:29`). **Live: `owner`** (the operator's conversation only).
**Prerequisite (`vaultReady`, `src/savedlogins.js:51`):** encryption at rest fully on
(`REASON_ENCRYPT_REST`, `_REST2`, `_REST3` all `on`) AND a key service (`src/vaultkms.js`):
`REASON_VAULT_KMS` = gcp | aws, default gcp when `REASON_GCP_KEY_FILE` is set (Google Cloud KMS key
`reason-vault`, ring `REASON_GCP_KMS_RING`, `src/gcpkms.js`), else aws (`REASON_VAULT_KMS_KEY` + AWS
login). The save page also needs the Google intake key (`reason-vault-intake`, RSA-OAEP 4096,
`vaultkms.intakeConfigured`): under aws there is no save page. A 127.x stand-in is refused outside a
test. Not ready → one startup line, `saved logins: off (encryption at rest not fully on)` or
`saved logins: off (no KMS key)`, and every vault call answers "Not available." Live has
`REASON_GCP_KEY_FILE`, `REASON_GCP_KMS_RING` and all three rest flags set; read the startup journal
for one of those lines before trusting the vault there.

Source: `src/savedlogins.js` (the sealed store in `data/logins.db`, `withLogin` only for
`src/filler.js`), `src/vaultkms.js` + `src/gcpkms.js` (keys), `src/sitepolicy.js` (never / careful
lists), `src/loginintake.js` (the save link, `savedLoginRoute`, `saveOfferFor`, texted-password
catch), `src/pages/savelogin.js` (`/web/save-login/<token>`), `src/filler.js` (types the login:
pin, front door, email-first, codes, endings), `src/loginuse.js` + `src/pages/loginuse.js`
(`/web/login-use/<token>`, Face ID per use), `src/federated.js` (Continue with Google, see
[social-signin.md](social-signin.md)), `src/pages/backlink.js` + `src/resume.js` (Back to Messages,
carry on after Face ID or a save), `src/tools.js` (`saved_login_offer`, `saved_login_forget`,
`account_signin`; `vaultSigninFor` in `signin_status`), `src/browser.js` (one stable browser, the
real browser, `withProfile`).

## Sub-features

- **The routing rule (#570, owner decision 2026-11-13).** For someone the vault is on for,
  `signin_status` answers `account_signin` for a site with a saved login (or a Google route with their
  Google login saved), and the sign-in link otherwise; everyone else gets the old answer byte for byte.
  A refusing site keeps its up-front answer ([refusing-sites.md](refusing-sites.md)); a site walled on
  record gets no `account_signin`. A step only the person can do (picture check, approval, a code
  Reason can't get) → `account_signin` hands them a link for that one attempt, in fixed words, no
  question. **The save offer**: after a link sign-in that ended signed in, ONE line "Want me to save
  this login, so next time I can sign in to <site> for you myself?" — once per person and site ever
  (`save_offers`), never for a never-list or refusing site, a site already saved, or a provider-button
  sign-in.
- **The save page (#540).** `saved_login_offer` only on a turn they started; code checks the site
  (banks, email, payment apps → refused with `refusalFor` words; careful sites → each-time only) and
  pins the sign-in origin + path from Reason's own visit (#550: the page that really has the form, the
  site's own Sign In link followed, email-first pages pinned as such). The tool says one fixed sentence
  + `/web/save-login/<token>` (24 bytes, hash only, one use, 30 min). The page quotes their request,
  seals the login inside the browser to the intake key, and Face ID signs exactly this login/site/
  wording; no passkey yet → a code texted to their thread first, then Face ID named Reason. POSTs need
  `Origin` = the site. A password texted while a save link is open is replaced before it is stored and
  answered with fixed words (`TEXTED_PASSWORD_WORDS`).
- **Their Google login (#592).** "save my Google login" reaches the save page like any site: only google.com
  itself (as saved on accounts.google.com); admin.google.com, Gmail and other Google pages keep the never-list
  answer. When Google turning Reason's browser away is on record (a refusal mark, or a strike from a real
  "this browser may not be secure"), the tool first says that as one question ("I can keep your Google login,
  but Google has been turning my browser away (last on <date>), so Continue with Google may not work for you
  yet. Still want to save it?", `loginintake.googleSaveWarning`), and the link is made only on their yes
  (`still_save: true`). Nothing on record: no claim, the link. No site is said to block Reason without a
  recorded refusal, and Continue with Google is never promised to work. While the vault is on for a person,
  the prompt tells the model saved logins exist for them (`savedLoginRulesFor`).
- **Signing in (#541, #560, #561, #562).** `account_signin { site, with? }`, only for a site they named
  in their own words (`src/namedsite.js`), only on their turn or a Face ID/save grant. The filler
  enters through the site's front door (home page, its own Sign In link), types only on the pinned
  exact origin into the top frame, email-first only after its own submit. Endings are honest: wrong
  password locks the row until saved again; the site's generic error is `site_trouble` (one retry
  after 3 min, then a 6 h pause); a code sent instead of a password is asked once by text and typed
  box-only (or read from their mail, next bullet); the page's own "Use password instead" is pressed when a password is saved; a visible
  picture challenge stops as blocked, never retried.
- **Reason reads the emailed sign-in code itself (#597, `REASON_SIGNIN_CODE_READ` = off | owner | on,
  default off; live `owner`; `src/mailcode.js`, reader `signinemail.codeFromMail`).** Only for someone saved
  logins already cover. When the site says it emailed a code, Reason reads only the one mail from that site's
  own domain (DKIM read from Gmail's own results) that arrived after it asked, types the code into the
  site's box once, and the code is never returned, logged or seen by the model. The result says so, in full
  the first time ("I took the code from the email <site> just sent you. I only look at that one email … If
  you'd rather I didn't, tell me and I'll ask you for codes instead."), then "Got the code from <site>'s
  email." A mail that is a security alert or a password reset is not used (`mail_alert`, `mail_not_signin`,
  fixed words); no mail, or two codes, asks them in plain words; a turned-down code gets one more look at a
  NEW mail only. A mail with only a sign-in link is not used unless `REASON_SIGNIN_CODE_LINKS=on` (default
  off). Audit: `login_log` `code_from_mail` + a `signinlog` line (site, time, sender domain, message-id hash).
  "don't read my mail for codes" → `signin_code_mail { read: false }` from any turn; turning it back on only
  from their own turn. The `signin_email` route uses the same reader for people the switch covers.
- **Face ID per use.** Each-time logins: the result carries a `/web/login-use/<token>` link; one
  approval = one use, bound to that login and site, runs out; the page names only the site.
- **Reason carries on (#551).** After the Face ID yes or a save, Reason resumes the exact job the link
  was made for, once, by itself (`src/resume.js`); a save-only link gets one fixed confirmation. Every
  vault page ends with **Back to Messages** (`backlink.js`): opens their own line (iOS `&body=`,
  Android `?body=`) or `/web?thread` with no number; the link carries a number and a fixed reply only.
- **Forget.** `saved_login_forget { site }`: no Face ID; signs out on the site where it can, clears the
  site's cookies and storage from Reason's browser, deletes the row and its wrapped key.
- **One stable browser per profile (#533, `REASON_STABLE_BROWSER`, live `owner`).** Every launch of
  their profile uses one setting (1280×900, en-US, their zone, full Chromium new-headless, service
  workers blocked, no stealth flag); one holder of a profile at a time (`withProfile`), other browser
  tools get the fixed busy line.
- **Real Chrome (#556, `REASON_BROWSER_CHANNEL=chrome`, live set).** For people the stable switch
  allows: the real Google Chrome, headed, on `REASON_BROWSER_DISPLAY` (Linux, the reason-xvfb unit),
  in its own profile dir (`realProfilePath`); at most `REASON_REAL_BROWSER_MAX` (default 2) at once,
  idle ones closed after 5 min; Chrome/display missing, cap reached or launch failed → that launch is
  today's browser, one numbers-only line.

## How to get to it (user POV)

Owner only. "Sign in to xfinity" with no saved login → the sign-in link; signed in → one save offer
→ "yes" → the save page → type the login, Face ID → Back to Messages. Later "pay my xfinity bill" →
Reason signs in itself (or texts the Face ID link first). "Forget my xfinity login" → done line.

## Driving it with the harness

Offline (slot gate): `test/savedlogins.test.js test/savedlogins-gcp.test.js test/savelogin.test.js
test/savelogin-browser.test.js test/savelogin-texted.test.js test/filler.test.js
test/account-signin.test.js test/namedsite.test.js test/vault-pin.test.js test/signin-ux.test.js
test/signin-route.test.js test/continue-with-google.test.js test/pages-back-and-resume.test.js
test/real-browser.test.js test/browser-launch.test.js test/probe-setups.test.js test/sitepolicy.test.js
test/gcpkms.test.js test/secret.test.js test/encrypt-rest-gcp.test.js test/gcp-kms-check.test.js
test/signin-code-read.test.js test/save-google-login-1115.test.js`.
The KMS is `test/helpers/gcpkms-standin.js`; the browser tests run real Chromium on fixture pages.

Cage (no model, no KMS): `REASON_SAVED_LOGINS=owner REASON_WEB=on caged.sh start` → `serve.log` says
`saved logins: off (encryption at rest not fully on)`; `GET /web/save-login/<32 hex>` and
`/web/login-use/<32 hex>` → 404, the same bytes as any unknown `/web/…` path. In process under
`caged.sh env`: `savedLoginsMode()` = owner, `vaultReady()` false, `savedLoginRoute` → null (the
link), `account_signin` / `saved_login_offer` → "Not available." with the filler never reached;
`browser.realBrowserFor(owner)` true and a stranger's `launchOptions` handed back untouched
(2026-11-14 at 7d5b5f54, 25 ok). A real save or sign-in needs the real key service: owner-run on live.

## Gotchas

- Turning the rest flags on in a cage process without a KEK crashes `src/db.js` at import
  (`restcrypt.init` → `fileKeks`); prove the no-KMS line offline (`test/savedlogins.test.js`).
- `withLogin` may be imported only by `src/filler.js`; a test checks it.
- The tool's `kind` is code's, not the model's: an event turn (mail, page, timer) never saves, signs
  in or makes a save link.
