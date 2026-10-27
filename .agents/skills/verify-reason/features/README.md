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
| Contact card photo (italic "r" + #9c3b2e bubble outline from the Web handoff since 10-27, `assets/reason-contact.jpg`) + one-off owner-only resend `scripts/card-to-owner.js --confirm=card-mark-1027` (marker file in data dir; nobody else) | [line-change.md](line-change.md) | `node --test test/contact-card-brand.test.js`; `node --test test/contact-card-url.test.js`; cage: `bin/contact-card.mjs` (sent URL = `/reason-<sha8>.vcf` of the served card, PHOTO = the pinned BRAND photo, NOTE "Your personal concierge", REV:, no long cache); live: `bin/contact-card.mjs --live <base>` |
| The new number (contact card, once, for people who texted the old 808 line) | [line-change.md](line-change.md) | `node --test test/linechange.test.js`; cage: seeded pre-cutoff inbound + `bin/inbound.sh -` as that number |
| Meal nutrition estimation (snap your plate) | [meal-nutrition.md](meal-nutrition.md) | No `test/meal.test.js` yet; caged inbound + `bin/peek.sh sql` |
| Subscriptions (find recurring charges, cancel on a yes, renewal watch) | [subscriptions.md](subscriptions.md) | `node --test test/subscriptions.test.js` (52); flow test needs a model |
| Uber rides (a web booking link with the pickup filled in; OAuth only when asked) | [uber-rides.md](uber-rides.md) | `node --test test/sites.test.js test/rides.test.js test/ridelinks.test.js test/uber.test.js`; cage: `uber_link` + `uber_connect` → `not_for_rides` |
| Travel time (saved places, commute, leave-by notices) | [travel-time.md](travel-time.md) | `node --test test/commute.test.js test/saved-places.test.js test/notice.test.js` |
| Rhythms (patterns kept only after a yes, move nudge timing) | [rhythms.md](rhythms.md) | `node --test test/rhythms.test.js test/rhythm-timing.test.js test/patterns.test.js` |
| Memory and knowledge graph | [memory-graph.md](memory-graph.md) | `node --test test/memory*.test.js test/graph-*.test.js` + queue tables via `bin/peek.sh` |
| Call completeness (one memory across call and text; lookups remembered; no thinking before the first word) | [call-completeness.md](call-completeness.md) | `node --test test/call-*.test.js`, then `bin/call-turn.sh` on the cage |
| Scheduled calls ("call me at 7", a wake-up call; the timer carries the call, firing rings their own number with the goal as the first words; refusals and no-answer become one text; "remind me" stays a text; named times honoured; series) | [scheduled-calls.md](scheduled-calls.md) | `node --test test/timer-call.test.js`; `bin/timer-call-drive.mjs` under `caged.sh env` (fake provider, no model) |
| Photo look (photo written down verbatim, `photo_look`) | [photo-look.md](photo-look.md) | `node --test test/looked.test.js`; real model: `test/flow-form.test.js` |
| Claude subscription usage on /ops (Reason's 5-hour/weekly %, one text at 80%; the Mac's coding subscription pushed to `/ops/usage`) | [ops-subscriptions.md](ops-subscriptions.md) | `node --test test/subusage.test.js`; cage: signed `curl` to `/ops/usage` with the cage secret |
| Paid-API hard caps (daily $1 for everything but calls, $10/month for all but calls; one owner text; calls are never stopped — their $2/day cap only texts) | [api-caps.md](api-caps.md) | `node --test test/api-hard-cap.test.js test/api-spend.test.js`; cage: seed `model_usage` past the caps, `POST /ops.json action=check` twice, `bin/call-turn.sh` |
| Events (organize by text; guests join by text, pasted link or the page, with name + password; a role per event and "which event?"; private pages only on a recognized browser — a texted code; rides between guests behind `REASON_EVENT_RIDES`; the link's preview card + organizer cover with the flyer guardrail; all behind `REASON_EVENTS`) | [events.md](events.md) | `node --test test/event*.test.js`; `bin/events-drive.mjs` under `caged.sh env` (no model); `bin/event-card.mjs` (og tags, JS off); cage: `runTool("event_create")`, then curl `/e/<id>`, `/e/<id>/join`, `/e/<id>/signin` |
| Event albums (one private photo album per event: photos texted "for <event>" after a one-time note; organizer's check-in list, highlights, "End event and release album" = one text per checked-in guest; single-photo save + whole-album ZIP; one shared expiry, files deleted at it; behind `REASON_EVENT_ALBUMS`, dark on live) | [event-albums.md](event-albums.md) | `node --test test/event-album.test.js`; `bin/album-drive.mjs` under `caged.sh env` (no model); `bin/album-preview.mjs` (three PNGs); cage: `REASON_EVENTS=on REASON_EVENT_ALBUMS=on caged.sh start`, then curl `/e/<id>/album/manage` with and without a `reason_page` cookie |
| Flight search (live fares via Fli; search only, never books; date sweeps; re-check before recommending; /ops row) | [flight-search.md](flight-search.md) | `node --test test/flight-search.test.js test/flights.test.js`; cage: `FLI_PYTHON=<throwaway venv>` + `runTool("flight_search")` |
| Ops alerts at the point of failure (one updating alert per failure key, auto-resolve, `incident:<key>` + `watchdog` rows on /ops, `GET /alive`) and the watchdog outside the process (`scripts/watchdog.mjs`, systemd timer) | [ops-alerts.md](ops-alerts.md) | `node --test test/incidents.test.js`; cage: `REASON_VERIFY_FAKE_SENDBLUE` + `bin/fake-sendblue.mjs fail`, `bin/inbound.sh`, read `incidents`; watchdog with `REASON_WATCHDOG_SEND_URL` at a second fake + `kill -STOP` |
| Owner announcements (one text to everyone active in 30 days, dry run by default; opted-out, quiet hours, once per number) | [announce.md](announce.md) | `node --test test/announce.test.js`; cage: seeded DB + `bin/fake-sendblue.mjs`; live: dry run only |
| Reason Web sign-in (W1: `/web` by number + texted code, the shared `reason_page` cookie with a 30-day idle limit, CSRF/origin/CSP, sign-out, the join block with the LIVE line's sms: link (`body=hey`) + QR, no number written; behind `REASON_WEB`, `on` (everyone) on live since 2026-10-27 05:04 UTC) | [web-signin.md](web-signin.md) | `node --test test/web-signin.test.js test/web-join-number.test.js test/web-design.test.js`; `bin/web-drive.mjs` under `caged.sh env` (no model); `bin/web-preview.mjs` (every Web screen × 390/1280 × Paper/Night + compare-*.png vs the design handoff); cage: `REASON_WEB=on caged.sh start`, then curl `/web` |
| Reason Web conversation (W2: signed-in `/web` = the one conversation, iMessage/Web labels, paging, composer → web channel, SSE `/web/stream` + poll fallback, one id = one turn, boundary note once, decision-9 line after a Web→text switch; Ongoing top 3 + See all, HIDE →, sticky bar, short row titles; Web-only chats, their titles and `GET /web/chats/recent`; behind `REASON_WEB`) | [web-conversation.md](web-conversation.md) | `node --test test/web-convo.test.js test/web-design.test.js test/web-ongoing2.test.js`; `bin/web-convo-drive.mjs` under `caged.sh env` (real HTTP, no model); `bin/web-preview.mjs` (all screens) |
| Pages v2 (the 2026-10-27 redraw of pages, events and edge pages; behind `REASON_PAGES_V2`, on live since 10-27) | [pages-v2.md](pages-v2.md) | `node --test test/pages-v2.test.js`; pictures `node scripts/pages-v2-preview.mjs` |
| Reason Web Ongoing (tab + desktop margin: NEEDS YOU / IN HAND / BACK TO YOU, real steps, waiting who/since, EVERY MON, READY / DIDN'T WORK; details 2A–2E + approval receipt at `/web/ongoing/<kind>/<id>`; 9D signed out mid-task; the mobile "needs a yes →" nudge) | [web-ongoing.md](web-ongoing.md) | `node --test test/web-ongoing.test.js test/web-ongoing2.test.js`; `bin/web-ongoing-preview.mjs` (every state × 390/1280 × Paper/Night + compare-ongoing-*.png); live: temporary owner session, curl `/web?tab=ongoing` + details |
| Reason Web Settings (how Reason reaches you, four ways → delivery honours it; edit states 5A–5D; signed-in browsers + sign out / everywhere (confirm); connected; invites make/cancel; theme per account, the only switch on Web; L8 busy words; no-script forms) | [web-settings.md](web-settings.md) | `node --test test/web-settings.test.js test/web-settings-edit.test.js test/web-settings-migration.test.js`; `bin/web-settings-drive.mjs` under `caged.sh env` (real HTTP, no model) |
| Reason Web notifications (8A tab "Reason · needs you" + needs-you favicon (§4h 5), 8B in-app line, 8C per-browser notifications, `/web/signal`) and Web icons (I1) | [web-notify.md](web-notify.md) | `node --test test/web-notify.test.js`; `bin/web-settings-drive.mjs` |
| Reason Web §4h motion + paper (pen writes in, stamp lands, grain, late-night Night) | [web-motion.md](web-motion.md) | `node --test test/web-4h-motion.test.js test/web-4h-motion-browser.test.js` |
| Reason Web composer inputs + media (+ upload, drop anywhere, slips, voice: dictate on the line / Listening; photos, voice notes, file slips in the thread served behind sign-in; same inbound pipeline as texted media) | [web-compose.md](web-compose.md) | `node --test test/web-compose.test.js test/web-compose-browser.test.js`; live: upload + send + history + media GET from Hetzner with a temporary owner session |
| Reason Web memory (`/web/memory`: facts grouped PREFERENCES/PEOPLE/PLACES/ROUTINES/WHY by a model-filed `memory_group`, correct in place → "got it.", forget card → stops being recalled, REASON THINKS… guesses yes/no; at volume: FIND A FACT, filters with counts, 3 per group + Show N more, guesses in one card, search with pen underlines; behind `REASON_WEB`) | [web-memory.md](web-memory.md) | `node --test test/web-memory.test.js test/web-memory-volume.test.js`; `bin/web-memory-drive.mjs` under `caged.sh env` (real HTTP, no model) |
| Reason Web chat history (`/web/memory/history`: days of this month + earlier months grouped, a day read-only with labels and no composer, message search; both channels from `messages`) | [web-history.md](web-history.md) | `node --test test/web-history.test.js`; `bin/web-memory-drive.mjs` under `caged.sh env` (history steps) |
| Reason Web Saved (`/web/saved`: pages, calls placed for them, placed AgentCard receipts, events + albums they organised; kinds with counts, FIND SOMETHING, PINNED, THIS WEEK / EARLIER IN <MONTH>, BOOKED/PAID stamps; opened item = the real page framed, PIN · OPEN THE PAGE ↗ · FIND IT IN THE CHAT →, REMOVE FROM SAVED + PUT IT BACK; phone tab Chat · Ongoing · Saved) | [web-saved.md](web-saved.md) | `node --test test/web-saved.test.js`; `bin/web-saved-drive.mjs` under `caged.sh env` (real HTTP, no model) |
| Reason Web thread scrolling (v2: opens at the bottom with L1 ghost lines; "where you are" note = day + device; TODAY ↓ in the composer line; done tasks settle into DONE lines from `task_messages`; L2 finding earlier; L10 long work; labels who · where · when) | [web-thread.md](web-thread.md) | `node --test test/web-thread.test.js test/web-thread-browser.test.js`; `bin/web-thread-preview.mjs` (drives + draws + compare vs reference); live: temporary owner session, `/web?thread` + `/web/history` |
| Reason Web §4h plumbing (while you were out under TODAY once per return; take it back = cancellable until the turn takes the held row, never a held send; working line counts only from a real multi-file loop, label throttled 3 s) | [web-small-details-plumbing.md](web-small-details-plumbing.md) | `node --test test/web-4h-plumbing.test.js`; staging take-it-back / taken-back / while-you-were-out / working-counts; live: throwaway account + temporary session |
| Reason Web daily edition Home (`/web?home` behind REASON_WEB_DAILY: NO. n masthead, Caveat greeting, Overnight decision/update/done, Lines out, One question → Memory, New in your book, pick up = how they chat; one shared thread, no new-chat entry) | [web-daily.md](web-daily.md) | `node --test test/web-daily.test.js`; staging `daily-*` rows; live: journal `daily_edition` + owner session GET |
| Reason Web Stamps + shared stamps (`REASON_WEB_DAILY`: awarded at task done / call outcome / order placed, told once only at `on`; the book `/web/stamps`; share + revoke; public `/s/<12 base62>` + og.png, revoked 410; redaction) | [web-stamps.md](web-stamps.md) | `node --test test/stamps.test.js test/stamps-web.test.js`; `bin/web-stamps-drive.mjs`; live: owner session → `/web/stamps`; throwaway account share → `/s/<id>`, og.png, revoke → 410 |
| Reason Web shell (the wordmark reads "reason" and never wraps; the logo always goes Home `/web?home`; link cards for signed-out `/web`, `/privacy`, `/terms`, none when signed in) | [web-shell.md](web-shell.md) | `node --test test/wordmark-text.test.js test/wordmark-one-line.test.js test/web-logo-home.test.js`; `bin/wordmark.mjs`; live: GET the three pages with a crawler UA, og tags + `og-*.png` 1200×630 |
| Reason Web v2 edge (every Text Reason → `body=hey` + typed hint; wrong/expired code digits stay in pen; L6 Texting you a code… / L7 CHECKING…; L3–L5 loading drawn at once then the real page fetched, STILL LOOKING… after 8 s, 9B on failure; E1 404 on unknown /web; E5 maintenance switch from /ops or `scripts/web-maintenance.mjs`; keyboard focus ring, skip link) | [web-edge.md](web-edge.md) | `node --test test/web-edge.test.js test/web-edge-browser.test.js`; live: temporary owner session, GET `/web/nope`, maintenance on for one fetch then off |

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
- Sending a real photo off a page — `send_picture`, `browser_images` (`grep -n 'name: "send_picture"\|name: "browser_images"' src/tools.js`,
  `src/browser.js`), `test/pictures.test.js`
- What was spent, in and out — `spend_today`, `spending_cap` (`grep -n 'name: "spend_today"\|"spending_cap"' src/tools.js`, rows in
  `src/db.js`); the caps half is already in [confirm-gate.md](confirm-gate.md)
- **Phone calls open naturally now** — `announcementFor` (`src/calls/provider.js:117`) says *"Hey,
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
- **The website's access form** — `POST /access/web` (`WEB_ACCESS_PATH` in `src/http.js`, `src/access.js`), signed
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
  Failures known when they happen skip that wait — see [ops-alerts.md](ops-alerts.md).
- **The /ops status page** (#106) — `src/pages/ops.js`, `src/opspassword.js`, `opsRequest` in
  `src/http.js`; `test/ops-gate.test.js`. Password gate (`REASON_OPS_PASSWORD_HASH`, sign-in 303),
  instant Check again / Clear (202 as JSON), `running` in `/ops.json`; public at
  `heyreason.com/ops` via Netlify. On the cage both routes answer 401 (this Mac's `.env`
  sets the hash).
- **Invites, dark** (#104) — `src/invites.js`, `GET /i/{token}`, claim by text in
  `src/channels/router.js`, owner-only tools behind `REASON_INVITES_OPEN` (off on live);
  `test/invites*.test.js`, `test/flow-invites.test.js`; tagline "Your personal concierge" on page + og:description → `bin/tagline.mjs`.
  Confetti (#174): the INVITE pill top-right is a `<button>` "Celebrate your invite"
  (`header .pill[data-pop]`, `shell({ pillButton })`); a click appends `canvas.confetti`
  (inline `src/pages/confetti.js`, no network) that removes itself in ~1.7 s; reduced motion =
  12 still sparkles; no other page has the button. `test/invite-confetti.test.js`. Prove live:
  fetch a real `/i/{token}` (read-only, never claim), grep `data-pop` + `canvas.confetti`, then a
  headless WebKit click and a screenshot mid-burst.
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
  **Moment-aware answers** (#120) ride inside the same rule: picture where they'll be when they act
  on it, reminders that land before they leave, short at 2am or before a flight, the next question
  answered, the next step one tap, phone-first links; "use what they told you" names it in passing
  so they can correct it. Guard line: "A line added for the moment must change what they do next" (the first
  draft added a time-zone aside and a "pay now?" push). Offline pin in `test/declined.test.js`
  (every prompt variant under 72,000); real model `test/flow-moment-aware.test.js`, CLI only,
  `REASON_PROACTIVE_EVAL=1` — 4/4 on 2026-10-25, operator prompt 71,877 chars. The cage cannot run
  a model turn (key blanked); drive it in-process under `caged.sh env` and check the line sits
  between "Your job is not to wait for instructions" and "- When what they asked will take".
- **Voiding a false harm strike** — `scripts/void-strikes.mjs`, `db.voidHarmEvent`.
- **Memory extraction through an outage** (#84) — `src/extract.js`, `test/extraction-queue.test.js`:
  an outage no longer spends a message's three tries; exhausted rows are put back in line. Since
  #115 it runs on the subscription in per-conversation batches — see [memory-graph.md](memory-graph.md).
- **The browser's privacy fixes** (#86) — no stealth flag (`test/no-stealth-flag.test.js`),
  `forgetSite` clears IndexedDB (`test/forget-site.test.js`), in `src/browser.js` / `src/signin.js`.
- **Photo observations persisting across turns** — `src/agent.js` (`describeMedia`,
  `recentPhotosNote`). Shipped `9846115`.
