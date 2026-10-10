# Pages — an answer you can open, keep and come back to

When a reply would be a wall of text on a phone, Reason makes a small web page and texts one link:
a gift shortlist with prices, an itinerary, a gym plan, a comparison. The link is the owner's, it
opens with nothing to type, and it keeps working when the page is edited.

Source: `src/tools.js` (`page_create`, `page_update`, `page_share`, `page_unshare`, `page_list`,
`page_delete`), `src/pages/` (`render.js`, `access.js`, `content.js`, `card.js`, `preview.js`,
`site.js`), `src/http.js` (`pageRequest`, `cardRequest`, `previewRequest`).
Tests: `test/pages.test.js`, `test/pagekit.test.js`, `test/pages-theme.test.js`,
`test/pages-intro.test.js`, `test/pages-phone.test.js`, `test/pages-browser.test.js`,
`test/memory-page.test.js`, `test/flow-pages.test.js` (live model).

## Sub-features

- **Make one.** `page_create(title, blocks, subtitle?, closing?)` → a row in `pages` and back an
  `id` and the owner's `link`. Blocks are structured, never HTML.
- **The link does not change.** `page_update` on the same `page_id` keeps the link, so the bookmark
  and anything already texted still work. A second page about the same thing is the failure.
- **The owner's link just opens.** `/p/<id>?k=<owner_key>` shows the page first time with nothing to
  type, and starts a browser session so the bare link works there afterwards.
- **Private stays private.** The bare `/p/<id>` without the key does not open an unshared page. The
  one-time-code fallback is rate limited from the `page_attempts` table, not from memory.
- **Share, and unshare.** `page_share` returns a separate read-only `share_link`; the owner's own
  link is never the one to pass on. `page_unshare` takes effect on the next request. Choices on a
  shared page are read-only.
- **Nothing the model writes becomes markup.** Every string is escaped; no block takes HTML.
- **A picture has to be real.** An image address the model typed from memory is refused — see
  [page-images.md](page-images.md).
- **A tap reaches Reason once.** `POST /p/<id>/choice`, owner's browser only, recorded in
  `page_choices`.
- **The link looks right in Messages.** `card.png` (og:image) and `preview.mp4` (og:video) per page,
  so iMessage renders a native preview.
- **Theme and the opening moment.** Light · Dark · Auto on every page; the "Reasoning…" hold into
  the wordmark glide.

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

For a page you can actually open, create one against the caged database and fetch it over HTTP:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"

node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const made = await runTool("page_create", {
    title: "Lisbon, 3 days",
    subtitle: "Walkable, one sit-down dinner a day",
    blocks: [{ type: "section", title: "Day 1" }, { type: "text", text: "Alfama on foot." }],
  }, { conversationId: "dm:owner", messages: [] });
  console.log(JSON.stringify(made, null, 2));   // page_id, link (key already in it), revision
'
```

The result's `link` is `ownerUrl(page)` — `/p/<id>?k=<owner_key>`, the exact link Reason texts.
Fetch that, and the bare one:

```bash
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
curl -si "http://127.0.0.1:$P/p/<id>?k=<key>" | head -30     # 200, the title in the HTML
curl -si "http://127.0.0.1:$P/p/<id>"                        # unshared, no key → 401, the code gate
curl -si "http://127.0.0.1:$P/p/<id>?k=wrongkeyxxxx"         # wrong key → 401, same gate
bin/peek.sh pages
```

**End state that proves it.** A `pages` row with the title and `shared = 0`; `GET /p/<id>?k=<key>`
returns **200** with the title escaped into the HTML (`<&>` in a title comes back
`&lt;&amp;&gt;`); the same id with no key or a wrong key returns **401** and the one-time-code page,
never the content; after `page_update` the `id` and `owner_key` are unchanged and `revision` has
gone up.

Three different answers, and telling them apart is the point:

| Request | Status | Why |
|---|---|---|
| right key | 200 | `checkAccess` → `allow`, interactive (`src/pages/access.js:62`) |
| no key / wrong key, unshared | 401 | `reason: "code_needed"` → the code gate (`access.js:76`) |
| id that does not exist | 404 | no row, so `renderNotFound` |
| too many wrong codes | 401 | `reason: "rate_limited"`, counted in `page_attempts` |

## Gotchas

- **A 404 and a 401 mean different things here, whatever the comment in `src/http.js` says.** That
  header comment (`src/http.js:24`) claims a page that does not exist and a page you may not see
  produce the same 404 "so the link space cannot be probed for real ids". Driven on 2026-10-10 they
  do not: a real id with no key or a wrong key answers **401** with the code gate, and only a
  genuinely absent id answers 404. So a 404 really does mean "no such page" — and the id space is
  distinguishable, which is a product question, not a harness one. Do not rewrite this note to match
  the comment without re-driving both cases.
- A page id is 8–64 characters of `[A-Za-z0-9_-]`. `/`, `/privacy` and `/terms` are the public site,
  not pages, and cannot be shadowed.
- The link Reason texts is `/p/<id>?k=<owner_key>`, built by `ownerUrl` off `REASON_PUBLIC_URL`
  when there is one. The caged instance inherits the live `REASON_PUBLIC_URL` from `.env`, so the
  `link` it hands back points at the **Tailscale address of the live instance on 8787**, not at the
  caged port. Swap the host for `127.0.0.1:<caged port>` before curling it.
- `page_update` wants the **full** blocks you want the page to have now, not a patch.
- Reaching the page over HTTP needs the server; `runTool` alone proves the row, not the render.
  Do both.
- `page_share` turns a private page public. Never drive it against the live instance.
