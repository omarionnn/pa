# Generated images on pages

A page that needs an illustration made for *this* answer — a gift-guide header, a plan cover, a
visual comparison — gets one from Google's Imagen rather than a stock photo. The picture is written
to this machine, served from `/img/<file>`, and used in an `image` block.

Source: `src/imagen.js` (`imagenStatus`, `imagenProvider`, `imageModelFor`), the `image_generate`
tool in `src/tools.js`, `src/http.js` (`imageRequest`), `src/pages/content.js` (what an `image`
block will accept), `src/pictures.js`.
Tests: `test/imagen.test.js`, `test/pictures.test.js`, and the picture rules in `test/pages.test.js`.

## Sub-features

- **Status, honestly.** No image model on the machine → `not_connected`, and Reason says so plainly
  instead of promising a picture. `GEMINI_API_KEY` (Imagen, primary) or `OPENAI_API_KEY`
  (gpt-image-2, fallback) is what turns it on. `imagenStatus()` checks both: Gemini first, then
  OpenAI. Neither → `not_connected` with `missing: ["GEMINI_API_KEY", "OPENAI_API_KEY"]`.
- **Generate.** `image_generate(prompt, aspect_ratio?, count?)` — `1:1`, `3:4`, `4:3`, `16:9`,
  `9:16`; up to 4; ~5–10s. Files land in `REASON_IMAGEN_OUTPUT`.
- **Serve.** `GET /img/<name>.(png|jpg)`. Two gates, and the first is the stricter one: the route
  regex (`src/http.js:125`) only matches a basename of **8–64 characters of `[A-Za-z0-9_-]`** — no
  dots — plus `.png` or `.jpg`, so `/img/ab.png` is a 404 that never reaches the handler. Then
  `imageRequest` sanitises to `[A-Za-z0-9_.-]` and 404s anything that changed
  (`src/http.js:449`). Between them there is no path traversal. Both proved 2026-10-11 and again 2026-10-12:
  `/img/ab.png` → 404, `/img/..%2f..%2fetcpasswd.png` → 404, the real file → 200.
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
node --test test/imagen.test.js test/pictures.test.js
```

**The free way to drive the whole round trip.** `runTool` reads `ctx.imagenProvider ?? imagenProvider()`
(`src/tools.js:8587`), so handing it a provider that writes real bytes exercises the real tool, the
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
const r = await runTool("image_generate", { prompt: "…", aspect_ratio: "16:9" }, ctx);
```

Keep the filename at least 8 characters of `[A-Za-z0-9_-]` or the `/img/` route will not match it.

`$REASON_IMAGEN_OUTPUT` has to exist before a fake provider writes into it. The real Imagen
provider `mkdirSync`s it itself (`src/imagen.js:94`) so a real generation is fine, but
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
    { prompt: "a cozy Italian restaurant interior, warm lighting, exposed brick", aspect_ratio: "16:9" },
    { conversationId: "dm:owner", messages: [] });
  console.log(JSON.stringify(r, null, 2));
'

ls -l "$REASON_IMAGEN_OUTPUT"
P=$(cat "${TMPDIR:-/tmp}/reason-verify/port")
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
  built from `config.publicUrl` (`src/tools.js:8596`), and the caged instance inherits
  `REASON_PUBLIC_URL` from this Mac's `.env` — on 2026-10-10 a caged generation returned
  `https://reason.tail3753c7.ts.net/img/verifyimgmv2jn6io.png`, the Mac's Tailscale address, which
  since 2026-10-12 has nothing behind it at all. Swap the host for `127.0.0.1:<caged port>` before fetching. Same trap as the
  page `link`; see [pages.md](pages.md).
- **The `<img src>` on a caged page carries that live host too**, because the absolute URL is stored
  in the page's blocks. So the `<img>` being present in the HTML proves the block was accepted, and
  nothing about the bytes. Fetch `127.0.0.1:<caged port>/img/<file>` separately for those.
- **`imagenStatus()` reads `config.geminiKey` and `config.openaiKey`, so a bare `node -e` without
  `--env-file-if-exists=.env` reports `not_connected` and you will think the feature is broken.**
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
