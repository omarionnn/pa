# Generated images on pages

A page that needs an illustration made for *this* answer — a gift-guide header, a plan cover, a
visual comparison — gets one from an image model (Imagen first, OpenAI's gpt-image-2 as the fallback
that live actually lands on) rather than a stock photo. The picture is written to this machine,
served from `/img/<file>`, and used in an `image` block. **Since #100 (2026-10-24) a picture they
asked for is sent straight into the thread as an attachment** (`image_generate` `send`, default
true; `sendGeneratedImages` in `src/tools.js`); only `send: false` — a picture for a page — hands
back the `/img/` URL.

Source: `src/imagen.js` (`imagenStatus`, `imagenProvider`, `openaiImageProvider`, `imageModelFor`),
the `image_generate` tool in `src/tools.js`, `src/http.js` (`imageRequest`), `src/pages/content.js`
(what an `image` block will accept), `src/pages/pictures.js` (`preparePictures`: pictures put on a
page by code, real ones copied into Reason's store with their source, a generated one labelled and
never a stand-in for an option), `src/pages/card.js` (`generateIllustration`).
Tests: `test/imagen.test.js`, `test/page-pictures.test.js`, and the picture rules in
`test/pages.test.js`. (`src/pictures.js` / `test/pictures.test.js` are the inbound-photo side —
HEIC→JPEG and `checkUrl` — not this feature.)

## Sub-features

- **Status, honestly.** No image model on the machine → Reason says so plainly instead of
  promising a picture. `GEMINI_API_KEY` (Imagen, primary) or `OPENAI_API_KEY` (gpt-image-2,
  fallback) is what turns it on. `imagenStatus()` checks both: Gemini first, then OpenAI. Neither →
  `{ connected: false, provider: "imagen", missing: ["GEMINI_API_KEY", "OPENAI_API_KEY"], why }`
  — there is no `status` string; `image_generate` hands back the same object with `ok: false`.
  **Connected is not working:** on 2026-10-23 the default model `imagen-3.0-generate-002`
  (`src/config.js`, `REASON_IMAGEN_MODEL`) answered Google's `404 … not found for API version
  v1beta`. The cage (this Mac's `.env` has `GEMINI_API_KEY` and no `OPENAI_API_KEY`) therefore
  cannot generate a picture at all; Hetzner has both keys, so it lands on the OpenAI fallback after
  a failed Imagen call. `imagenStatus()` still says `connected: true` either way.
- **Send, or keep for a page.** `send` defaults to true: the tool sends the picture as an image
  attachment and returns `sent:true` with **no URL**. With no texting thread (the cage, a bare
  `runTool`) it answers `ok:false, status:"not_connected"`, "there is no texting thread here to send
  it into" — so every drive below passes `send: false`. #100 also dropped `response_format`, the
  parameter that made every OpenAI fallback a 400 (`src/imagen.js`).
- **Generate.** `image_generate(prompt, aspect_ratio?, count?, send?)` — `1:1`, `3:4`, `4:3`, `16:9`,
  `9:16`; 1–4 (enforced in the provider); ~5–10s. Files land in `REASON_IMAGEN_OUTPUT`. The tool
  appends a fixed house-style suffix to every prompt (minimal editorial illustration, warm cream
  and charcoal with one brick-red accent, the brand red from `src/pages/brand.js`, no text, no people, not photorealistic), so the prompt
  the provider receives is never exactly what the model wrote.
- **Serve.** `GET /img/<name>.(png|jpg|webp|gif)`. Two gates, and the first is the stricter one: the
  route regex in `createServer` (`src/http.js`, re-grep `imgRoute =`) only matches a basename of
  **8–64 characters of `[A-Za-z0-9_-]`** — no dots — plus `.png`, `.jpg`, `.webp` or `.gif`, so
  `/img/ab.png` is a 404 that never reaches the handler. Then `imageRequest` sanitises to
  `[A-Za-z0-9_.-]` and 404s anything that changed. Between them there is no path traversal. Proved
  2026-10-11, 2026-10-12 and 2026-10-13: `/img/ab.png` → 404, `/img/..%2f..%2fetcpasswd.png` → 404,
  the real file → 200.
- **Only on a page, only on this server.** The URL that comes back is valid as a page image here —
  not something to text as a standalone link.
- **A picture has to be real.** A page refuses an image address the model typed from memory. The URL
  must have come back from a tool in this conversation.
- **It is a generated picture, and says so.** Never presented as a photo of a real thing. This is
  the line Omari drew: *"a picture has to be real"* — generated art is fine, a fake photo is not.
- **A `.docx` and a `.pptx` cannot carry a picture** and `document_create` refuses one rather than
  shipping a file with a hole in it. The PDF is the page printed, so it can.

## How to get to it (user POV)

Ask for something that wants a picture — "make me a gift guide for my mum", "a page comparing these
three" — or ask outright: "put a picture on it". Reason generates one, puts it on the page, and the
page renders it from `/img/...`.

## Driving it with the harness

The offline suite covers the tool, the provider seam and the HTTP route, with a fake provider that
writes real bytes to a temp dir — no API key and no network:

```bash
cd ~/Desktop/pa
node --test test/imagen.test.js test/page-pictures.test.js
```

**The free way to drive the whole round trip.** `runTool` reads `ctx.imagenProvider ?? imagenProvider()`
(`case "image_generate"` in `src/tools.js` — re-grep), so handing it a provider that writes real bytes exercises the real tool, the
real URL-minting, the real `seen_urls` bookkeeping, the real route and the real page refusal — with
no key and no paid call. That is a seam production ships, not a stubbed `runTool`:

```js
const PNG = Buffer.from(/* a few real png bytes */);
const fake = { async generate() {
  const path = join(process.env.REASON_IMAGEN_OUTPUT, "verifyimg" + Date.now().toString(36) + ".png");
  writeFileSync(path, PNG);
  return { ok: true, model: "fake-imagen", images: [{ path, bytes: PNG.length }] };
} };
const ctx = { conversationId: "dm:owner", messages: [], imagenProvider: fake };
const r = await runTool("image_generate", { prompt: "…", aspect_ratio: "16:9", send: false }, ctx);
// → ok:true, sent:false, images[0].url …/img/verifyimg….png (2026-10-25). Without send:false: not_connected.
```

Keep the filename at least 8 characters of `[A-Za-z0-9_-]` or the `/img/` route will not match it.

**In a worktree with no `.env`, `REASON_PUBLIC_URL` is unset**, so the URL comes back
`http://127.0.0.1:<port>/img/…` and `page_create` refuses it ("needs an https url"). Export
`REASON_PUBLIC_URL=https://reason.tail3753c7.ts.net` for the in-process drive — only the string is
used; a generated picture is never fetched (`preparePictures` skips `kind: "generated"`). Driven
2026-10-27: fake provider → `/img/` 200 `image/png`, page `<img>` present, no paid call.

**Export `GEMINI_API_KEY= OPENAI_API_KEY=` before using the fake.** If the fake ever answers
`ok: false` and `config.openaiKey` is set, `image_generate` retries on `openaiImageProvider()` — a
real, paid OpenAI generation, from a drive that was meant to be free. Blank keys also stop the
`generateIllustration` that every `page_create` / `page_update` fires, and pass
`pictures: { search: null }` in `ctx` to keep `page_create` off the paid Parallel image search.

`$REASON_IMAGEN_OUTPUT` has to exist before a fake provider writes into it. The real Imagen
providers `mkdirSync` it themselves (`imagenProvider` and `openaiImageProvider` in `src/imagen.js`) so a real generation is fine, but
this recipe bypasses them — it died with `ENOENT` on a clean cage until `caged.sh start` was fixed
to create the directory. It does now; if you drive outside the cage, `mkdir -p` it yourself.

For the real round trip against Google, `GEMINI_API_KEY` has to be set (it comes from `.env`) and
the call costs money and ~10 seconds:

```bash
cd ~/Desktop/pa/.agents/skills/verify-reason
bin/caged.sh start
cd ~/Desktop/pa
eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"

node --env-file-if-exists=.env -e '
  const { runTool } = await import("./src/tools.js");
  const { imagenStatus } = await import("./src/imagen.js");
  console.log("status:", JSON.stringify(imagenStatus()));
  const r = await runTool("image_generate",
    { prompt: "a cozy Italian restaurant interior, warm lighting, exposed brick", aspect_ratio: "16:9", send: false },
    { conversationId: "dm:owner", messages: [] });
  console.log(JSON.stringify(r, null, 2));
'

ls -l "$REASON_IMAGEN_OUTPUT"
P=$(cat "${REASON_VERIFY_RUN:-${TMPDIR:-/tmp}/reason-verify}/port")
curl -si "http://127.0.0.1:$P/img/<file>.png" | head -5
```

**End state that proves it.** Three things together, or it is not proved: the tool result carries a
`/img/...` URL; a real file of non-zero size exists in `$REASON_IMAGEN_OUTPUT`; and
`GET /img/<file>.png` returns 200 with `Content-Type: image/png` and that many bytes. Then put the
URL in an `image` block via `page_create` and fetch the page — the `<img>` has to be in the HTML.

For the refusal half, which matters as much: pass a made-up `https://example.com/x.png` to a page
`image` block and watch `page_create` refuse it.

## Gotchas

- **The URL the tool hands back points at the LIVE instance, so never curl it verbatim.** The URL is
  built from `config.publicUrl` (in `case "image_generate"`, `src/tools.js`) — `https://reason.tail3753c7.ts.net/img/…`
  on 2026-10-13, which is Hetzner — and the caged instance inherits
  `REASON_PUBLIC_URL` from this Mac's `.env`. Swap the host for `127.0.0.1:<caged port>` before
  fetching. Same trap as the page `link`; see [pages.md](pages.md).
- **The `<img src>` on a caged page carries that live host too**, because the absolute URL is stored
  in the page's blocks. So the `<img>` being present in the HTML proves the block was accepted, and
  nothing about the bytes. Fetch `127.0.0.1:<caged port>/img/<file>` separately for those.
- **`imagenStatus()` reads `config.geminiKey` and `config.openaiKey`, so a bare `node -e` without
  `--env-file-if-exists=.env` reports `connected: false` (with `missing: ["GEMINI_API_KEY", "OPENAI_API_KEY"]`) and you will think the feature is broken.**
- `REASON_IMAGEN_OUTPUT` is the only thing keeping generated files out of the live
  `data/` tree. `caged.sh` sets it; if you drive `image_generate` by hand without the
  `caged.sh env` exports, you are writing into the owner's real image directory.
- A generated image is **bytes on disk plus a route**. A tool result with a URL in it proves
  neither. Check all three.
- The `/img/` route reads straight off disk with no auth: anyone who can reach the port can fetch
  any filename in that directory. That is the current design; do not "fix" it in a verification run.
- A real generation is a paid API call. Default to `test/imagen.test.js` and its fake provider;
  spend the call only when the question is specifically about Imagen itself.
- `count` maxes at 4.
- **Page card illustrations are separate from page-body images.** `page_create` and `page_update`
  fire `generateIllustration(page)` (in `src/pages/card.js`) as fire-and-forget background work.
  The illustration is a 16:9 image matching the page's title and section headings, stored at
  `{dataDir}/cards/{pageId}-illustration.png` (`illustrationPath`; `dataDir` is
  `REASON_DATA_DIR`, default `data`). The cage sets `REASON_DATA_DIR` to its own run dir, so caged
  illustrations, cards and previews stay out of the checkout's `data/cards`. `cardHtml` picks it up
  when present; absent means the solid-colour fallback. It is a paid call on every create and on
  every update that changes title or blocks, whenever an image key is set — blank the keys unless
  it is the thing under test. If Imagen fails and an OpenAI key is set it retries there. Privacy:
  dollar amounts, phone numbers, addresses, zip codes, and emails are stripped from the
  illustration prompt before it reaches the image model.
