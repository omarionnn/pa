# Reason feature map

What a person can actually do with Reason, and how to prove each one still works. Written from the
user's point of view: a feature is something somebody wanted, not a module.

Read `../SKILL.md` first — it has Launch, Doctor, Drive, Evidence and Cleanup, and the test baseline
you need before calling anything a regression. That baseline is **2,615 passing with 4 known
failures** as of `81be6c5` (all 4 in the CLI backend path at `claude-cli.js:167`, not in any mapped
feature). Any *other* failure is real — but check `git status` first, because an uncommitted tree is
not the baseline.

| Feature | File | Primary drive |
|---|---|---|
| Inbound message handling | [inbound-message.md](inbound-message.md) | `bin/inbound.sh` → caged webhook |
| Pages (answers you can open and keep) | [pages.md](pages.md) | `node --test test/pages.test.js`, then `GET /p/<id>` |
| Location share handling | [location-share.md](location-share.md) | `bin/inbound.sh file payloads/location.json` |
| Generated images on pages | [page-images.md](page-images.md) | `node --test test/imagen.test.js`, then `GET /img/<f>` |
| The confirm gate (money / acting on someone else) | [confirm-gate.md](confirm-gate.md) | `node --test test/trust.test.js`, then `runTool` directly |

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
  (`src/pause.js`, `src/tools.js:3298`, `:3315`, `:8705`), shipped 2026-10-11 in `eeb760d`. Covered
  by `test/pause.test.js`. A real user-facing control with no feature file.
- **Asking where somebody is** — `get_location` (`src/tools.js:4282` schema, `:5091` input,
  `:11857` implementation, capability at `:1308`), plus the pre-read that runs *before* the model
  turn (`src/agent.js:419`). Shipped 2026-10-11 across `a19ee32`, `0eb4106`, `e390c63`, `79f7e71`.
  This is the half of location that **asks**; [location-share.md](location-share.md) is the half
  that **reads**. **No test anywhere** — `grep -rl get_location test/` is empty.
- Finding places near somebody — `nearby_places` (`src/places.js`, `src/tools.js:4266` schema,
  `:5083` input, `:11845` implementation, capability at `:1307`), the other half of
  [location-share.md](location-share.md). **No test of its own, and it calls Overpass over the
  network.**
- Sending a real photo off a page — `send_picture`, `browser_images` (`src/tools.js:2647`, `:4345`,
  `src/browser.js`), `test/pictures.test.js`
- What was spent, in and out — `spend_today`, `spending_cap` (`src/tools.js:3524`, `:1316`, rows in
  `src/db.js`); the caps half is already in [confirm-gate.md](confirm-gate.md)
- **Video inbound** — `.mov`, `.mp4` etc. uploaded to Gemini Files API and watched —
  `src/channels/sendblue.js` (`attachmentOf`, `VIDEO_EXTS`), `src/agent.js` (`videosFor`),
  `test/video.test.js` if it exists. Shipped `d84a244`.
- **AgentCard** — buy things with a card kept in a vault, connect people by exchanging vault links
  — `src/agentcard.js`, `src/http.js` (`/agentcard/webhook`). Shipped `e156573`, `3a62fa5`.
- **X (Twitter) integration** — OAuth 2.0 PKCE, posting, reading timeline — `src/x.js`,
  `test/x.test.js`. Shipped `73db165`.
- **GitHub connected account** — OAuth flow, 11 tools — `src/github.js`, `test/github.test.js`.
  Shipped `e22a85b`.
- **Apple Calendar** — CalDAV read/write — `src/caldav.js` or similar. Shipped `437b051`.
- **Photo observations persisting across turns** — `src/agent.js` (`describeMedia`,
  `recentPhotosNote`). Shipped `9846115`.
