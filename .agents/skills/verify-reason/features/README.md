# Reason feature map

What a person can actually do with Reason, and how to prove each one still works. Written from the
user's point of view: a feature is something somebody wanted, not a module.

Read `../SKILL.md` first — it has Launch, Doctor, Drive, Evidence and Cleanup, and the test baseline
you need before calling anything a regression. Read the Baseline section there for the current
number and commit. Any failure is real — but check `git status` first, because an uncommitted tree is
not the baseline. **The live instance is Hetzner** (`bin/doctor.sh live`), never a port on this Mac.

| Feature | File | Primary drive |
|---|---|---|
| Inbound message handling | [inbound-message.md](inbound-message.md) | `bin/inbound.sh` → caged webhook |
| Pages (answers you can open and keep) | [pages.md](pages.md) | `node --test test/pages.test.js`, then `GET /p/<id>` |
| Location share handling | [location-share.md](location-share.md) | `bin/inbound.sh file payloads/location.json` |
| Generated images on pages | [page-images.md](page-images.md) | `node --test test/imagen.test.js`, then `GET /img/<f>` |
| The confirm gate (money / acting on someone else) | [confirm-gate.md](confirm-gate.md) | `node --test test/trust.test.js`, then `runTool` directly |
| AgentCard (a card in a vault, buying things with it) | [agentcard.md](agentcard.md) | `node --test test/agentcard.test.js`; cage proves `not_configured`; Hetzner read-only |

## Each file has four sections

- **Sub-features** — the separable things inside it, each of which can break alone.
- **How to get to it (user POV)** — what somebody types or taps to reach it.
- **Driving it with the harness** — the exact commands, with the end state they should produce.
- **Gotchas** — what has actually bitten someone here.

## Maintaining this

When you change behaviour, change its feature file in the same commit. When you add a user-facing
feature, add a file and a row above. When a drive recipe stops working, fix the recipe — a feature
map that lies is worse than no map, because the next agent will trust it.

`openclaw-skills:maintain-verification-skill` is the upkeep loop: it reads source per feature,
drives each one live, and ships proven corrections.

## Not yet mapped

Real features with no file here. Add one when you touch them.

- Phone calls (ElevenLabs: Reason's own voice, inbound and outbound) — `src/calls/`, `test/call-*.test.js`
- Voice notes — `src/voice.js`, `test/voice.test.js`
- Email, calendar and Drive, per Google account — `src/google.js`, `src/drive.js`, `src/driveorg.js`
- Documents: `.docx`, `.pptx`, `.pdf` — `src/documents/`, `test/documents.test.js`
- The browser Reason drives itself, and sign-in windows — `src/browser.js`, `src/signin*.js`
- Timers, tasks, watches and the 15s sweep — `src/runtime.js`, `test/tasks.test.js`
- Tapbacks and iMessage screen effects — `src/tapbacks.js`, `src/expressive.js`
- The harm gate (every message screened before a turn) — `src/harm.js`, `test/harm.test.js`
- Flights and check-in — `src/flights.js`
- Subscriptions, receipts, the undo window, the furthest point
- **Stopping Reason dead, and starting it again** — `pause_everything` / `resume_everything`
  (`src/pause.js`, `src/tools.js:3603`, `:3620`, `:9764` as of `20b321a`), shipped 2026-10-11 in
  `eeb760d`. Covered by `test/pause.test.js`. A real user-facing control with no feature file.
- **Asking where somebody is** — `get_location` (`src/tools.js:4983` schema, `:13401`
  implementation, capability at `:1500`), plus the pre-read that runs *before* the model turn
  (`src/agent.js:440`, `locationNote`). Shipped 2026-10-11 across `a19ee32`, `0eb4106`, `e390c63`,
  `79f7e71`. This is the half of location that **asks**; [location-share.md](location-share.md) is
  the half that **reads**. **No test anywhere** — `grep -rl get_location test/` is empty.
- Finding places near somebody — `nearby_places` (`src/places.js`, `src/tools.js:4967` schema,
  `:13389` implementation, capability at `:1499`), the other half of
  [location-share.md](location-share.md). **No test of its own, and it calls Overpass over the
  network.**
- Sending a real photo off a page — `send_picture`, `browser_images` (`src/tools.js:2938`, `:5089`,
  `src/browser.js`), `test/pictures.test.js`
- What was spent, in and out — `spend_today`, `spending_cap` (`src/tools.js:3861`, `:1511`, rows in
  `src/db.js`); the caps half is already in [confirm-gate.md](confirm-gate.md)
- **Phone calls open naturally now** — `announcementFor` (`src/calls/provider.js:110`) says *"Hey,
  hi — this is an AI assistant calling for <owner>…"* since `2908618` (2026-10-12), and an owner
  with no name on file is *"the person I work for"*. Two tests still asserting the old *"Hi — this
  is…"* / *"on behalf of"* wording were red on `main` until `wt/catchup-guard` fixed them
  (`test/accounts.test.js:167`, `test/elevenlabs.test.js:274`).
- **A restart does not eat a text** — the startup catch-up (`3c45286`) and its owner guard
  (`wt/catchup-guard`); mapped in [inbound-message.md](inbound-message.md).
- **The morning brief** — `src/brief.js`, `test/brief.test.js`, `test/flow-brief.test.js`, shipped
  `e42894a` (2026-10-13). Not driven here yet.
- **Video inbound** — `.mov`, `.mp4` etc. uploaded to Gemini Files API and watched —
  `src/channels/sendblue.js` (`attachmentOf`, `VIDEO_EXTS`), `src/agent.js` (`videosFor`),
  `test/video.test.js` if it exists. Shipped `d84a244`.
- **The website's access form** — `POST /access/web` (`src/http.js:330`, `src/access.js`), signed
  by the Netlify function with `REASON_WEB_ACCESS_SECRET`; `REASON_ACCESS_URL` on Netlify points at
  Hetzner since 2026-10-12. An unsigned POST → 401 is the only read-only probe; a signed one queues
  a real access request on the owner's phone.
- **X (Twitter) integration** — OAuth 2.0 PKCE, posting, reading timeline — `src/x.js`,
  `test/x.test.js`. Shipped `73db165`.
- **GitHub connected account** — OAuth flow, 11 tools — `src/github.js`, `test/github.test.js`.
  Shipped `e22a85b`.
- **Apple Calendar** — CalDAV read/write — `src/caldav.js` or similar. Shipped `437b051`.
- **Photo observations persisting across turns** — `src/agent.js` (`describeMedia`,
  `recentPhotosNote`). Shipped `9846115`.
