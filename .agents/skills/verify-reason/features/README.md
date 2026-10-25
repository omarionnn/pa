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
| AgentCard (a card in a vault, buying things with it; the purchase record, `purchases_recent`, cancel reasons, tokens sealed at rest) | [agentcard.md](agentcard.md) | `node --test test/agentcard.test.js test/purchasesnote.test.js`; cage proves `not_configured` and `purchases_recent`; Hetzner read-only, never an AgentCard call |
| Flight booking (DARK behind `REASON_FLIGHT_BOOKING`; `owner` = the owner's conversation only: fresh quote, traveler read-back, the cart's own numbers, a yes pinned to cart + travelers, never "booked" without a ticket) | [flight-booking.md](flight-booking.md) | `node --test test/flight-booking.test.js`; by hand only: `scripts/flight-booking-smoke.mjs` (sandbox) |
| Shopping around it (verified offers, the figures check on replies, the handoff, price watches) | [shopping.md](shopping.md) | `node --test test/shopping-*.test.js test/deal-watch.test.js`; cage: `offer_check` → `shop_handoff` → `deal_watch_set` after `offers.beginTurn` |
| The new number (contact card, once, for people who texted the old 808 line) | [line-change.md](line-change.md) | `node --test test/linechange.test.js`; cage: seeded pre-cutoff inbound + `bin/inbound.sh -` as that number |
| Meal nutrition estimation (snap your plate) | [meal-nutrition.md](meal-nutrition.md) | No `test/meal.test.js` yet; caged inbound + `bin/peek.sh sql` |
| Subscriptions (find recurring charges, cancel on a yes, renewal watch) | [subscriptions.md](subscriptions.md) | `node --test test/subscriptions.test.js` (52); flow test needs a model |
| Uber rides (a web booking link with the pickup filled in; OAuth only when asked) | [uber-rides.md](uber-rides.md) | `node --test test/sites.test.js test/rides.test.js test/ridelinks.test.js test/uber.test.js`; cage: `uber_link` + `uber_connect` → `not_for_rides` |
| Travel time (saved places, commute, leave-by notices) | [travel-time.md](travel-time.md) | `node --test test/commute.test.js test/saved-places.test.js test/notice.test.js` |
| Rhythms (patterns kept only after a yes, move nudge timing) | [rhythms.md](rhythms.md) | `node --test test/rhythms.test.js test/rhythm-timing.test.js test/patterns.test.js` |
| Memory and knowledge graph | [memory-graph.md](memory-graph.md) | `node --test test/memory*.test.js test/graph-*.test.js` + queue tables via `bin/peek.sh` |
| Call completeness (one memory across call and text; lookups remembered; no thinking before the first word) | [call-completeness.md](call-completeness.md) | `node --test test/call-*.test.js`, then `bin/call-turn.sh` on the cage |
| Photo look (photo written down verbatim, `photo_look`) | [photo-look.md](photo-look.md) | `node --test test/looked.test.js`; real model: `test/flow-form.test.js` |
| Claude subscription usage on /ops (Reason's 5-hour/weekly %, one text at 80%; the Mac's coding subscription pushed to `/ops/usage`) | [ops-subscriptions.md](ops-subscriptions.md) | `node --test test/subusage.test.js`; cage: signed `curl` to `/ops/usage` with the cage secret |
| Flight search (live fares via Fli; search only, never books; date sweeps; re-check before recommending; /ops row) | [flight-search.md](flight-search.md) | `node --test test/flight-search.test.js test/flights.test.js`; cage: `FLI_PYTHON=<throwaway venv>` + `runTool("flight_search")` |

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

- Phone calls beyond [call-completeness.md](call-completeness.md) — the opening line, voicemail, language switch, holds, third-party errands (`src/calls/`, `test/call-*.test.js`). `bin/call-turn.sh` can drive any owner-call turn on the cage now.
- Voice notes — `src/voice.js`, `test/voice.test.js`
- Email, calendar and Drive, per Google account — `src/google.js`, `src/drive.js`, `src/driveorg.js`
- Documents: `.docx`, `.pptx`, `.pdf` — `src/documents/`, `test/documents.test.js`
- The browser Reason drives itself, and sign-in windows — `src/browser.js`, `src/signin*.js`
- Timers, tasks, watches and the 15s sweep — `src/runtime.js`, `test/tasks.test.js`
- Tapbacks and iMessage screen effects — `src/tapbacks.js`, `src/expressive.js`
- The harm gate (every message screened before a turn) — `src/harm.js`, `test/harm.test.js`; what it is shown, and the 2026-10-23 outage, are in [inbound-message.md](inbound-message.md)
- Flight records and check-in — `src/flights.js` (`flight_list`, `flight_checkin_start`). Flight *search* is mapped in [flight-search.md](flight-search.md)
- Receipts, the undo window, the furthest point
- **Stopping Reason dead, and starting it again** — `pause_everything` / `resume_everything`
  (`src/pause.js`; `grep -n 'name: "pause_everything"\|case "pause_everything"' src/tools.js`),
  shipped 2026-10-11 in `eeb760d`. Covered by `test/pause.test.js`. A real user-facing control with
  no feature file.
- Finding places near somebody — `nearby_places` (`src/places.js`;
  `grep -n 'name: "nearby_places"\|case "nearby_places"' src/tools.js`), the other half of
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
- **Ops alerts that wait for a second wrong pass** (#85) — `src/ops.js`, `test/ops.test.js`: a check is
  texted to the owner only once it is still wrong on the next pass. Live: `/ops`, `/ops.json`.
- **The /ops status page** (#106) — `src/pages/ops.js`, `src/opspassword.js`, `opsRequest` in
  `src/http.js`; `test/ops-gate.test.js`. Password gate (`REASON_OPS_PASSWORD_HASH`, sign-in 303),
  instant Check again / Clear (202 as JSON), `running` in `/ops.json`; public at
  `reason.omarinyarko.com/ops` via Netlify. On the cage both routes answer 401 (this Mac's `.env`
  sets the hash).
- **Invites, dark** (#104) — `src/invites.js`, `GET /i/{token}`, claim by text in
  `src/channels/router.js`, owner-only tools behind `REASON_INVITES_OPEN` (off on live);
  `test/invites*.test.js`, `test/flow-invites.test.js`.
- **Proactive catches, and a declined one remembered** (#110, #112) — the prompt rule in
  `src/agent.js`, `declinedNote` in `src/said.js` (180 days); `test/declined.test.js`, real model
  `test/flow-proactive-rules.test.js` (`REASON_PROACTIVE_EVAL=1`). #112 adds money/risk/trading
  warnings to "settled for good": a push-back with their reason is not new information. With no API
  credit, run the eval on Reason's own backend: copy the branch to a scratch dir on Hetzner (never
  `/opt/reason`), symlink `/opt/reason/node_modules`, and as `reason` run
  `REASON_PROACTIVE_EVAL=1 REASON_PROACTIVE_EVAL_BACKEND=cli node --test test/flow-proactive-rules.test.js`
  (one case: `--test-name-pattern="push back on a warning"`); delete the scratch dir and
  `/tmp/reason-flow-proactive-rules-*` after. 2026-10-25 on #112: stop-loss 6/6, the other four 1/1
  each, operator prompt 71,894 chars. Since the API-spend diet (#115) the lane runs on the CLI
  wherever it is started (`test/paid-key-guard.js`); the env var still forces it.
- **Voiding a false harm strike** — `scripts/void-strikes.mjs`, `db.voidHarmEvent`.
- **Memory extraction through an outage** (#84) — `src/extract.js`, `test/extraction-queue.test.js`:
  an outage no longer spends a message's three tries; exhausted rows are put back in line. Since
  #115 it runs on the subscription in per-conversation batches — see [memory-graph.md](memory-graph.md).
- **The browser's privacy fixes** (#86) — no stealth flag (`test/no-stealth-flag.test.js`),
  `forgetSite` clears IndexedDB (`test/forget-site.test.js`), in `src/browser.js` / `src/signin.js`.
- **Photo observations persisting across turns** — `src/agent.js` (`describeMedia`,
  `recentPhotosNote`). Shipped `9846115`.
