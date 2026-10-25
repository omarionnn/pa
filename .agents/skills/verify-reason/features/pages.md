# Pages — an answer you can open, keep and come back to

When a reply would be a wall of text on a phone, Reason makes a small web page and texts one link:
a gift shortlist with prices, an itinerary, a gym plan, a comparison. The link is the owner's, it
opens with nothing to type on a browser they have proved once, and it keeps working when the page
is edited.

Source: `src/tools.js` (`page_create`, `page_update`, `page_list`,
`page_delete`), `src/pages/` (`render.js`, `access.js`, `content.js`, `card.js`, `preview.js`,
`site.js`, `pictures.js`), `src/http.js` (`pageRequest`, `gateFor`, `cardRequest`; `previewRequest`
lives in `src/pages/preview.js`).
Tests: `test/pages.test.js`, `test/pagekit.test.js`, `test/pages-theme.test.js`,
`test/pages-intro.test.js`, `test/pages-phone.test.js`, `test/pages-browser.test.js`,
`test/memory-page.test.js`, `test/flow-pages.test.js` (live model).

## Sub-features

- **Make one.** `page_create(title, blocks, subtitle?, closing?)` → a row in `pages` and back a
  `page_id` and the owner's `link`. Blocks are structured, never HTML.
- **The link does not change.** `page_update` on the same `page_id` keeps the link, so the bookmark
  and anything already texted still work. A second page about the same thing is the failure.
- **The owner's link opens on a proved browser; a new browser is texted a code first** (PR #17,
  `58d6e66`). `/p/<id>?k=<owner_key>` on a browser that has never proved itself answers **401** and
  the code gate with a "Text me the code" button (`checkAccess` → `codeNeeded` in
  `src/pages/access.js`). Pressing it texts the owner a code; typing it (`POST /p/<id>`,
  `trySubmittedCode`) sets the `reason_page` cookie, and that browser then opens **every** page of
  that owner for 90 days (`db.pageSessionValid` matches on conversation, `SESSION_TTL_MS`). A GET
  never signs a browser in and never texts anything, however often a link preview fetches it.
- **Private stays private, and so does the guest list.** The bare `/p/<id>` without the key does not
  open a page, and an id with nothing behind it answers exactly the same thing, so the id
  space cannot be probed for real links. The one-time-code fallback is rate limited from the
  `page_attempts` table, not from memory, and counts attempts against guessed ids too.
- **No sharing.** A page is only ever its owner's: there is no `page_share`, no share link, no
  Share button and no `POST /p/<id>/share` (all removed 2026-10-23, PR #67, at Omari's ask). The
  bar shows no Private/Shared pill either.
- **Nothing the model writes becomes markup.** Every string is escaped; no block takes HTML.
- **A picture has to be real.** An image address the model typed from memory is refused — see
  [page-images.md](page-images.md).
- **A tap reaches Reason once.** `POST /p/<id>/choice`, owner's browser only, recorded in
  `page_choices`.
- **The link looks right in Messages.** `card.png` (og:image) and `preview.mp4` (og:video) per page,
  so iMessage renders a native preview. When an image model is connected, the card uses a generated
  illustration as a full-bleed background with the title overlaid; when not, a solid dark fallback.
  The illustration is pre-generated at `page_create` / `page_update` time (fire-and-forget).
- **Theme and the opening moment.** Light · Dark · Auto on every page; the "Reasoning…" hold into
  the wordmark glide.
- **Light · Dark · Auto on every page Reason serves** (2026-10-25, owner: "every page"). Not only
  a page made for someone: the gates, not-found, notices, every event page (join, sign-in, code
  gate, joined, who's going, organizer), /ops, invites, the Spotify pages and the remote sign-in page
  carry the same switch at the foot, default Auto, remembered per browser under `reason-theme` —
  one choice for every page on that origin. One component: `THEME` in `src/pages/render.js`
  (`head`/`css`/`markup`/`js`); `shell()` adds it unless `theme: false` (only a printed page), and
  `src/spotify.js`, `src/signin-remote.js`, `src/http.js` brandedPage use the same four with their
  dark colours written by `dark()`. The handler is on the document and redraws on DOM change, so the
  switch /ops swaps in on each refresh still works. Check: `node bin/theme-all.mjs [--shots dir]` —
  17 page states × 390/1280 × auto-light, auto-dark, Dark on a light phone, Light on a dark phone:
  switch visible with Auto pressed on a fresh browser, choice survives a reload, ground follows,
  every visible text ≥4.5:1 (the orange kicker included) and every input edge and the wordmark
  bubble ≥1.3:1.
- **One brand orange.** #B8460B (owner, 2026-10-25: "our trademark orange") on light pages,
  #F26F2B (same hue, lighter) on dark — both in `src/pages/brand.js` and nowhere else: `--mark` in
  the shell and the three own-template pages, the "An event" / "Your event" / "An invite" kicker,
  the Back to Reason button, the event cover's kicker, the illustration prompts. 5.4:1 / 5.1:1 on
  white / the sheet; 5.9:1 on the dark card. Pinned in `test/wordmark.test.js`.
- **The wordmark top left is the marketing site's.** Every page Reason serves — files pages, the
  code/password gates, not-found, notices, event pages (join, sign-in, gate, joined, who's going,
  organizer), /ops, invites, Spotify join/callback, the remote sign-in page — opens with "reas" + the
  brand-orange bubble (#B8460B; #F26F2B on dark pages, cards and covers — the site's is blue #0A84FF) + "n" in Instrument Serif italic 1.35rem, the same mark as the top left of
  reason.omarinyarko.com. One copy: `src/pages/wordmark.js` (font inline as a 1.5 KB data URI — no
  request, nothing from Google); the shell (`src/pages/render.js`) and the three own-template pages
  (`src/spotify.js`, `src/signin-remote.js`, `src/http.js` brandedPage) import it. The opening moment
  reads "reas⌾ning" with it, like the site's loader. Check: `node bin/wordmark.mjs [--site]
  [--shot out.png]` — every page type at 390/1280, dark and light; `--site` also requires the live
  site's .nav-mark width, type size and bubble size to match. Before 2026-10-25 the top line was an
  orange dot + "Reason" in the system serif. The same wordmark signs every page off (`foot()` in
  `src/pages/render.js`: "Made by" / "Written by" + mark, a notice's "— nothing was changed" after
  it) and sits top left on both link-preview card designs (`cardHtml`, `src/pages/card.js`). No
  dot-and-"Reason" mark is left anywhere. The bubble's colour is `WORDMARK_BUBBLE` /
  `WORDMARK_BUBBLE_DARK` in `src/pages/wordmark.js` — the brand orange since 2026-10-25 (owner).

## How to get to it (user POV)

Ask for something long or keepable — "make me a 3-day Lisbon itinerary", "gift ideas for my mum",
"turn that into a page". Reason texts a short message plus one link. Tapping it opens the page.
Asking for a change edits that same page at the same link.

## Driving it with the harness

Pages are almost entirely code, so the offline suite is the real proof and it needs no server:

```bash
cd ~/Desktop/pa
node --test test/pages.test.js test/pagekit.test.js test/pages-theme.test.js
```

For a page you can actually open, create one against the caged database and fetch it over HTTP.
`page_create` is not free by default: it fires `generateIllustration` (a paid Imagen/OpenAI call)
and code's own picture pass runs a paid Parallel image search. Blank the image keys and turn the
search off for an in-process drive:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
export GEMINI_API_KEY= OPENAI_API_KEY=          # no illustration, no paid image call

node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const { issueCode } = await import("./src/pages/access.js");
  const made = await runTool("page_create", {
    title: "Lisbon, 3 days <&>",
    subtitle: "Walkable, one sit-down dinner a day",
    blocks: [{ type: "section", title: "Day 1" }, { type: "text", text: "Alfama on foot." }],
  }, { conversationId: "dm:owner", messages: [], pictures: { search: null } });
  console.log(JSON.stringify(made, null, 2));   // page_id, link (key already in it), revision
  // The code the "Text me the code" button would text, minted straight into the caged db:
  console.log("code:", issueCode(made.page_id).code);
'
```

The result's `link` is `ownerUrl(page)` — `/p/<id>?k=<owner_key>`, the exact link Reason texts.
A fresh curl is a new browser, so the key alone gets the gate; the code gets the page:

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -si "http://127.0.0.1:$P/p/<id>?k=<key>" | head -30     # 401, gate WITH "Text me the code"
curl -si -X POST -d code=<CODE> "http://127.0.0.1:$P/p/<id>" | head -30
                                                             # 200, Set-Cookie: reason_page=<tok>, the page
curl -si -H "Cookie: reason_page=<tok>" "http://127.0.0.1:$P/p/<id>" | head -30   # 200, the page
curl -si "http://127.0.0.1:$P/p/<id>"                        # no key → 401, plain gate
curl -si "http://127.0.0.1:$P/p/<id>?k=wrongkeyxxxx"         # wrong key → 401, same plain gate
bin/peek.sh pages
```

**End state that proves it.** A `pages` row with the title; `GET /p/<id>?k=<key>`
on a fresh browser returns **401** with the "Text me the code" gate and never the content;
`POST /p/<id>` with the code returns **200**, a `reason_page` cookie, and the title escaped into
the HTML (`<&>` comes back `&lt;&amp;&gt;`); a GET carrying that cookie returns **200**; no key or
a wrong key returns **401** and the plain gate; after `page_update` the `id` and `owner_key` are
unchanged and `revision` has gone up.

| Request | Status | Body |
|---|---|---|
| proved browser (`reason_page` cookie) | 200 | the page, interactive (`checkAccess` → `allow`) |
| right key, new browser | 401 | the gate **with** "Text me the code" and the page's preview tags — differs from the plain gate (`gateFor`, `canSend`) |
| right code, `POST /p/<id>` | 200 | the page + `Set-Cookie` |
| no key | 401 | the plain code gate |
| wrong key | 401 | the code gate, byte for byte the same |
| id that does not exist | 401 | the code gate, byte for byte the same |
| too many wrong codes | 429 | the gate with the lockout line, same for a real or fake id |

**Checking that is the privacy test, so check the bodies, not just the statuses.** A real private
page, a wrong key and an imaginary id have to be indistinguishable — a page id is the whole
authentication story, so "this id is real" is itself a secret. Driven 2026-10-10:

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
b() { curl -s "$@" | shasum -a 256 | cut -c1-16; }
b "http://127.0.0.1:$P/p/<id>"                  # real page, no key
b "http://127.0.0.1:$P/p/<id>?k=zzzzzzzzzzzz"   # real page, wrong key
b "http://127.0.0.1:$P/p/ThisIsNotARealPageId"  # nothing behind it
# all three must print the same hash
```

It was not always so: before `pageRequest` was fixed, a missing id answered 404 "Not found" while a
private page answered 401, which sorted guessed links into real and imaginary. `test/pages.test.js`
pins all of it now; the header comment of `src/http.js` explains why. The right key on a new
browser is the one 401 whose body differs — it carries the "Text me the code" button and the
page's preview tags — and that is fine: only someone already holding the key can see it.

## Gotchas

- **A 404 from `/p/<id>` now means the id was the wrong *shape*, not that the page is missing.** A
  well-formed id with nothing behind it answers 401 and the code gate, same as a private page. Only
  something that fails the route regex — fewer than 8 characters, or a character outside
  `[A-Za-z0-9_-]` — falls through to a real 404. So never read a 404 here as "that page is gone":
  check the `pages` row.
- **A 401 says nothing either.** It is the answer for a private page, a wrong key, an id that
  never existed, **and the right key on a browser that has not entered a code yet**. That is
  deliberate (see the table above), which means a 401 cannot be used to confirm you built the link
  right. Compare against `bin/peek.sh pages`, and look for "Text me the code" in the body: present
  means the key matched.
- **A 200 needs a proved browser.** Curl is always a new browser. Get a code with `issueCode(id)`
  (`src/pages/access.js`) in-process, `POST` it as `code=…`, and carry the `reason_page` cookie.
  The code is six digits (since 2026-10-25) and the text ends in a blank line and Apple's
  domain-bound `@<host> #<code>`: the pages host (`REASON_PAGES_URL`, live
  `files.reason.omarinyarko.com`) for a page, the `/ops` host (`opsUrl()`, live
  `reason.omarinyarko.com`) for the status page. `code=` may be the six digits, `012 345`, or the
  whole pasted text (`typedCode`). In the cage the text prints on the console channel in
  `serve.log` as `reason> Your Reason code is …` — the decision-log lines never carry it.
  Pressing "Text me the code" for real (`POST` with `send`) is limited to 3 codes per 15 minutes
  per page (`MAX_CODES_SENT`), and 5 wrong codes lock the page for 15 minutes for everybody
  (`MAX_FAILED_ATTEMPTS`, counted in `page_attempts`).
- **Choices need the cookie too.** `POST /p/<id>/choice` answers 403 to anything but the owner's
  proved browser, key or no key.
- **The sibling routes answer 404 for everything they refuse** — `card.png`, `preview.mp4`, `/img/`
  and `/f/<id>` all return the same flat 404 whether the thing is missing or you may not see it.
  Different status from `/p/`, same property. Do not "fix" one to match the other.
- A page id is 8–64 characters of `[A-Za-z0-9_-]`. `/`, `/privacy` and `/terms` are the public site,
  not pages, and cannot be shadowed.
- The link Reason texts is built by `ownerUrl` → `pageUrl` in `src/pages/access.js` (re-grep
  `export function pageUrl`). When
  `REASON_PAGES_URL` is set the link is `{REASON_PAGES_URL}/{id}?k=<owner_key>`, verbatim — the
  variable carries whatever prefix the host in front needs. On this Mac's `.env` **and** on Hetzner
  it is `https://files.reason.omarinyarko.com` (read 2026-10-24; it was
  `https://reason.omarinyarko.com/p` until then), so a link reads
  `https://files.reason.omarinyarko.com/<id>?k=…` — no `/p` in it; the host in front maps it to
  Hetzner's `/p/<id>`. When only
  `REASON_PUBLIC_URL` is set, the fallback is `{REASON_PUBLIC_URL}/p/{id}?k=<owner_key>`. The caged
  instance inherits both from `.env`, so the `link` it hands back points at the **public site**,
  not at the caged port — driven 2026-10-24, `link: https://files.reason.omarinyarko.com/0yKSptX1JR?k=…`.
  Replace `https://files.reason.omarinyarko.com/` with `http://127.0.0.1:<caged port>/p/` before
  curling it (on 2026-10-24 that answered 401 with the "Text me the code" gate, as the table says).
- `page_update` wants the **full** blocks you want the page to have now, not a patch.
- Reaching the page over HTTP needs the server; `runTool` alone proves the row, not the render.
  Do both.
- **`page_create` / `page_update` spend money unless told not to.** Both fire
  `generateIllustration` (Imagen, else OpenAI) whenever an image key is set, and `page_create` runs
  `preparePictures` → `sourcePictures`, a Parallel image search when a Parallel key is set.
  `caged.sh env` blanks neither. Export `GEMINI_API_KEY= OPENAI_API_KEY=` and pass
  `pictures: { search: null }` in `ctx` unless the illustration or the photos are what you are
  testing. The cage keeps cards, previews and illustrations under its own run dir
  (`REASON_DATA_DIR`), never in the checkout's `data/cards`.
