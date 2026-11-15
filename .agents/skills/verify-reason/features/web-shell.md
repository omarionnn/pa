# Reason Web — the shell: wordmark, logo → Home, link cards

The pieces every Web page shares that are not a screen of their own. Shipped 2026-10-27:
#200 (wordmark reads "reason"), #205 (the wordmark never wraps), #206 (the logo always goes Home),
#210 (link cards for `/web`, `/privacy`, `/terms`). Code: `src/pages/wordmark.js` (`wordmark`,
`WORDMARK_O`), `src/pages/webkit.js` (`.wm-w` run, `LOAD_JS` loader mark), `src/pages/made.js`
(pages' `.wm`), `src/pages/sitecard.js` (`CARDS`, `linkCardTags`), `src/pages/websignin.js`
(`signedOutPage` carries the `web` card), `src/pages/site.js` (`/privacy`, `/terms` carry theirs).

## Sub-features

- **The wordmark reads "reason".** The bubble stands in for the o, so a zero-size inline
  `<span class="wm-o">o</span>` (`WORDMARK_O`) rides inside every copy: `document.body.innerText`
  (what Reason's own page reader and screen readers get) says "reason", not "reasn". Pixel-identical
  to before. An absolutely-positioned sr-only span does NOT work: it is blockified and splits the word.
- **It never wraps.** On Web the mark is one inline `.wm-w` run with `white-space:nowrap`
  (`webkit.js`); the svg bubble is an atomic inline, i.e. a break point, and a squeezed thread top bar
  (the "where you are" note) split it `reas◯ / n` on phones before #205. `made.js` `.wm` is
  `nowrap; flex:none`. The loader's "reasoning" is one line too.
- **The logo always goes Home.** Every Web view's mark links `/web?home` (`aria-label="Reason, home"`),
  signed in or out, the loader included. The thread's Chat tab still goes to the thread. Signed in,
  `/web?home` is Home; signed out it is the sign-in page.
- **Link cards.** `/privacy` and `/terms` carry og + twitter tags from `sitecard.js` `CARDS`
  ("Reason · Privacy" / "Reason · Terms", `og:url` on the site's origin, 1200×630
  `og:image` = `heyreason.com/og-legal.png?v=1`, `summary_large_image`). Signed-out `/web` carries the
  Secured-by-Reason card instead (since 4e624cf5, 2026-11-10): og:title "Sign in to Reason",
  `og:image` = `heyreason.com/web/og/secured/web.png?v=1` (`src/pages/securedcard.js` `SECURED_CARDS.web`,
  drawn by this install, 200 image/png 1200×630); "Reason on the web" / `og-web.png` are gone.
  iMessage and facebookexternalhit fetch with no cookie, so they always read the signed-out page;
  **a signed-in `/web` never carries a card**, so nothing private can reach a preview. The pictures
  live on the website (`~/Desktop/reason-site-new`, `tools/make-og-pages.mjs`); bump `v` on a redraw.
- **What `/privacy` and `/terms` say** (`src/pages/site.js` `privacyPage` / `termsPage`, plain notices,
  public, indexable, GET/HEAD only; the date is the `meta` "last changed"). Recent lines a reader sees:
  - Privacy, "What leaves the machine": **Calls with your Reason** — a call with your own Reason may be
    handled by Cartesia (your voice to it, Reason's voice back); Cartesia holds the recording only during
    the call and Reason has it deleted after; calls Reason places to others never use Cartesia. Plus
    "on a phone call … the voice provider for that call (OpenAI or Cartesia)". **Your bank** — through
    Plaid, read-only (balances, transactions, account names with the last four digits), cannot move
    money, last 60 days kept, disconnect by asking deletes it. "What Reason stores" names the bank's 60
    days and that your own calls are always recorded (deleted with your data). (#549, then #552, 4ffe7757.)
    Live: `REASON_CALL_CARTESIA=on`, `REASON_PLAID=on`, so the page describes what is running.
  - Privacy: **Paid events. Stripe processes ticket payments** (card + organizer identity/bank details
    go to Stripe, never Reason; Reason keeps amounts, status, Stripe's reference).
  - Terms: a **Paid events** section — Stripe processes; Connected Account Agreement link
    (`stripe.com/legal/connect-account`, also in the page's links); Reason's fee 2.5% from the organizer;
    the guest's processing fee is not refundable on their own cancel or a give-back, Reason's fee is;
    organizer refunds and a cancelled event are in full; disputes recovered from payouts; taxes/1099-K;
    sales or payouts may be paused for fraud (#472).
  Pinned in `test/site.test.js` ("the policy names Cartesia for calls with your own Reason and Plaid…",
  "/terms has the Paid events section and /privacy the Stripe line…").

## How to get to it (user POV)

- Open heyreason.com/web on a phone: the mark top-left reads "reason" on one line; tap it → Home.
- Paste heyreason.com/web into iMessage: a large "Sign in to Reason" card; /privacy or /terms: the legal card.
- Read heyreason.com/privacy and /terms: what is kept, what leaves the machine (Anthropic, the call voice
  provider, Cartesia for calls with your own Reason, Plaid for a bank, Stripe for paid events), and the
  terms' Paid events section.

## Driving it with the harness

```bash
cd ~/Desktop/pa   # or your worktree
ANTHROPIC_API_KEY= node --test test/wordmark-text.test.js test/wordmark-one-line.test.js test/web-logo-home.test.js
ANTHROPIC_API_KEY= node --test --test-name-pattern='card' test/web-signin.test.js   # 3: /web card, none signed in, /privacy + /terms
ANTHROPIC_API_KEY= node --test test/site.test.js        # 24: what /privacy and /terms say (Cartesia, Plaid, Stripe, Paid events)
node .agents/skills/verify-reason/bin/wordmark.mjs        # every page kind × 390/1280 × light/dark, headless
```

Live, read-only (GET only, no cookie):

```bash
for h in https://heyreason.com https://reason.tail3753c7.ts.net; do for p in /web /privacy /terms; do
  curl -s -A 'facebookexternalhit/1.1' "$h$p" > /tmp/card.html
  echo "$h$p $(grep -o 'og:title" content="[^"]*' /tmp/card.html | cut -d'"' -f3) | $(grep -o 'og:image" content="[^"]*' /tmp/card.html | cut -d'"' -f3)"
done; done
curl -s -o /tmp/og.png -w '%{http_code} %{content_type}\n' 'https://heyreason.com/og-legal.png?v=1'; file /tmp/og.png   # 200 image/png, 1200 x 630
curl -s -o /tmp/og.png -w '%{http_code} %{content_type}\n' 'https://heyreason.com/web/og/secured/web.png?v=1'; file /tmp/og.png   # the /web card, same
curl -s https://heyreason.com/web | grep -o '<a class="wm" href="[^"]*"'                                     # href="/web?home"
```

End state: three cards on both hosts ("Sign in to Reason", "Reason · Privacy", "Reason · Terms"),
both pictures 200 at 1200×630, the mark's href `/web?home`. On a cage the same three are a route drive
(start it with `REASON_WEB=on`, else `/web` and `/web/signal` are 404): `/web` "Sign in to Reason" + the
secured picture 200 1200×630, `/privacy` + `/terms` "Reason · Privacy|Terms" on `og-legal.png?v=1`,
the mark `href="/web?home"` (2026-11-14).

The words the public reads: one plain GET each of `https://heyreason.com/privacy` and `/terms` saved to
files, then render `privacyPage()` / `termsPage()` from this tree under `caged.sh env` with
`REASON_SITE_URL=https://heyreason.com` and diff the visible lines (strip tags; `&#39;` → `'`). Identical
text = what is deployed is what you read (2026-11-14 at 7d5b5f54: privacy 63 lines, terms 42, no
difference; privacy last changed 2026-11-13, terms 2026-11-12).

## Gotchas

- In zsh, `echo` of a line holding `·` inside a `$(…)` loop can print "character not in range" and
  drop that line — read the saved HTML (`grep -c 'og:'`) before calling a card missing (2026-10-27).
- `bin/wordmark.mjs` exits 1 at 7d5b5f54 (2026-11-14): its event fixture has no `tz` (NOT NULL in `events`), so the
  organizer page (`renderManage`, src/pages/eventmanage.js:447) throws; with `tz` added the other 60 checks
  are ok and "event organizer" fails 4× "no .wordmark" (the manage page draws none). Web views pass. Fix the
  fixture in the script and decide whether the manage page should carry the mark (pages.md owns event pages).
- `/web` sets a `reason_web_form` cookie on every signed-out GET; that is the sign-in form's CSRF
  pairing, not a session.
