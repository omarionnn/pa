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
- **Link cards.** Signed-out `/web`, `/privacy` and `/terms` carry og + twitter tags from
  `sitecard.js` `CARDS` (title, description, `og:url` on the site's origin, 1200×630
  `og:image` = `heyreason.com/og-web.png?v=1` / `og-legal.png?v=1`, `summary_large_image`).
  iMessage and facebookexternalhit fetch with no cookie, so they always read the signed-out page;
  **a signed-in `/web` never carries a card**, so nothing private can reach a preview. The pictures
  live on the website (`~/Desktop/reason-site-new`, `tools/make-og-pages.mjs`); bump `v` on a redraw.

## How to get to it (user POV)

- Open heyreason.com/web on a phone: the mark top-left reads "reason" on one line; tap it → Home.
- Paste heyreason.com/web, /privacy or /terms into iMessage: a large card with Reason's picture.

## Driving it with the harness

```bash
cd ~/Desktop/pa   # or your worktree
ANTHROPIC_API_KEY= node --test test/wordmark-text.test.js test/wordmark-one-line.test.js test/web-logo-home.test.js
ANTHROPIC_API_KEY= node --test --test-name-pattern='card' test/web-signin.test.js   # 3: /web card, none signed in, /privacy + /terms
node .agents/skills/verify-reason/bin/wordmark.mjs        # every page kind × 390/1280 × light/dark, headless
```

Live, read-only (GET only, no cookie):

```bash
for h in https://heyreason.com https://reason.tail3753c7.ts.net; do for p in /web /privacy /terms; do
  curl -s -A 'facebookexternalhit/1.1' "$h$p" > /tmp/card.html
  echo "$h$p $(grep -o 'og:title" content="[^"]*' /tmp/card.html | cut -d'"' -f3) | $(grep -o 'og:image" content="[^"]*' /tmp/card.html | cut -d'"' -f3)"
done; done
curl -s -o /tmp/og.png -w '%{http_code} %{content_type}\n' 'https://heyreason.com/og-web.png?v=1'; file /tmp/og.png   # 200 image/png, 1200 x 630
curl -s https://heyreason.com/web | grep -o '<a class="wm" href="[^"]*"'                                     # href="/web?home"
```

End state: three cards on both hosts ("Reason on the web", "Reason · Privacy", "Reason · Terms"),
both pictures 200 at 1200×630, the mark's href `/web?home`.

## Gotchas

- In zsh, `echo` of a line holding `·` inside a `$(…)` loop can print "character not in range" and
  drop that line — read the saved HTML (`grep -c 'og:'`) before calling a card missing (2026-10-27).
- `/web` sets a `reason_web_form` cookie on every signed-out GET; that is the sign-in form's CSRF
  pairing, not a session.
