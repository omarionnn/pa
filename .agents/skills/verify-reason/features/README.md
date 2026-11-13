# Reason feature map

What a person can actually do with Reason, and how to prove each one still works. Written from the
user's point of view: a feature is something somebody wanted, not a module.

Read `../SKILL.md` first — it has Launch, Doctor, Drive, Evidence and Cleanup, and the test baseline
you need before calling anything a regression. Read the Baseline section there for the current
number and commit. Any failure is real — but check `git status` first, because an uncommitted tree is
not the baseline. **The live instance is Hetzner** (`bin/doctor.sh live`), never a port on this Mac.

| Feature | File | Primary drive |
|---|---|---|
| Inbound message handling | [inbound-message.md](inbound-message.md) | `bin/inbound.sh` → caged webhook; Linq: `bin/linq-inbound.mjs` (cage with `REASON_VERIFY_LINQ_WEBHOOK=1`) |
| Sealed CLI turns (no operator email, no AGENTS.md / CLAUDE.md, no repo path in any person's turn on the claude-cli backend; the operator's city only in the operator's `capabilities` result) | [cli-sealed.md](cli-sealed.md) | `node --test test/cli-sealed.test.js test/capabilities-city.test.js`; real CLI on the wire, no model: `bin/cli-seal-probe.mjs` (+ `--unsealed` control) on Hetzner as `reason` |
| Pages (answers you can open and keep) | [pages.md](pages.md) | `node --test test/pages.test.js`, then `GET /p/<id>` |
| Location share handling | [location-share.md](location-share.md) | `bin/inbound.sh file payloads/location.json` |
| Generated images on pages | [page-images.md](page-images.md) | `node --test test/imagen.test.js`, then `GET /img/<f>` |
| The confirm gate (money / acting on someone else) | [confirm-gate.md](confirm-gate.md) | `node --test test/trust.test.js`, then `runTool` directly |
| AgentCard (a card in a vault, buying things with it; the purchase record, `purchases_recent`, cancel reasons, tokens sealed at rest) | [agentcard.md](agentcard.md) | `node --test test/agentcard.test.js test/purchasesnote.test.js`; cage proves `not_configured` and `purchases_recent`; Hetzner read-only, never an AgentCard call |
| Flight booking (DARK behind `REASON_FLIGHT_BOOKING` + the shopping path: a Crossmint checkout on the airline's own site, travelers read back, one exact total, a yes pinned to payment + travelers, never "booked" without a ticket for every passenger) | [flight-booking.md](flight-booking.md) | `node --test test/flight-booking.test.js`; by hand only: `scripts/flight-booking-smoke.mjs` (sandbox) |
| Account jobs (DARK behind `REASON_ACCOUNT_JOBS` + the shopping path: a subscription cancelled or a bill paid inside their own account through a Crossmint checkout; the cancel can never pay; done needs the page AND the merchant's mail) | [account-jobs.md](account-jobs.md) | `node --test test/account-jobs.test.js` |
| Shopping around it (verified offers, the figures check on replies, the handoff, price watches) | [shopping.md](shopping.md) | `node --test test/shopping-*.test.js test/deal-watch.test.js`; cage: `offer_check` → `shop_handoff` → `deal_watch_set` after `offers.beginTurn` |
| Contact card photo (the #9c3b2e bubble outline alone on paper since 11-06 — the 10-27 italic "r" removed; `assets/reason-contact.jpg`, also the page apple-touch icon and the link-preview avatar) + one-off owner-only resend `scripts/card-to-owner.js --confirm=card-mark-1027` (marker file in data dir; nobody else) | [line-change.md](line-change.md) | `node --test test/contact-card-brand.test.js`; `node --test test/contact-card-url.test.js`; cage: `bin/contact-card.mjs` (sent URL = `/reason-<sha8>.vcf` of the served card, PHOTO = the pinned BRAND photo, NOTE "Your personal concierge", REV:, no long cache); live: `bin/contact-card.mjs --live <base> --files https://files.heyreason.com` (the files domain serves only `/reason-<sha8>.vcf`, no alias — the URL people actually receive); bubble = sha256 `a703eb17…` jpg, apple-touch icon `94b4a094…` 180×180 (LIVE 11-07, #385) |
| The new number (contact card, once, for people who texted the old 808 line) | [line-change.md](line-change.md) | `node --test test/linechange.test.js`; cage: seeded pre-cutoff inbound + `bin/inbound.sh -` as that number |
| Meal nutrition estimation (snap your plate) | [meal-nutrition.md](meal-nutrition.md) | No `test/meal.test.js` yet; caged inbound + `bin/peek.sh sql` |
| Subscriptions (find recurring charges, cancel on a yes, renewal watch) | [subscriptions.md](subscriptions.md) | `node --test test/subscriptions.test.js` (52); flow test needs a model |
| Sign-in link (`/s/<token>`: sign in to a site from the phone inside Reason's browser; Start only on the person's own proved Reason browser or with a code texted to their thread, after which that browser is remembered the way connect links remember it) | [signin-link.md](signin-link.md) | `node --test test/signin-remote.test.js`; cage env: `node .agents/skills/verify-reason/bin/signin-link-drive.mjs` |
| Uber rides (a web booking link with the pickup filled in; OAuth only when asked) | [uber-rides.md](uber-rides.md) | `node --test test/sites.test.js test/rides.test.js test/ridelinks.test.js test/uber.test.js`; cage: `uber_link` + `uber_connect` → `not_for_rides` |
| Travel time (saved places, commute, leave-by notices) | [travel-time.md](travel-time.md) | `node --test test/commute.test.js test/saved-places.test.js test/notice.test.js` |
| Rhythms (patterns kept only after a yes, move nudge timing) | [rhythms.md](rhythms.md) | `node --test test/rhythms.test.js test/rhythm-timing.test.js test/patterns.test.js` |
| Memory and knowledge graph (+ nightly review and how-to-treat-me rules: every review rule cites their message, never folds or caps out one they set; never reads a forgotten line, forget retires rules naming the subject; a rule taken back mid-pass is never revived or folded) | [memory-graph.md](memory-graph.md) | `node --test test/memory*.test.js test/graph-*.test.js test/dream-forgotten.test.js` + queue tables via `bin/peek.sh`; `bin/dream-rules-drive.mjs`, `bin/dream-forget-drive.mjs`, `bin/dream-stale-rules-drive.mjs` under `caged.sh env` (no model) |
| Call goal met (a message passed on / question answered → `goal_met`, a success; model-read, claude-cli; stamps count it; #379: the read's `how` labels unsettled calls — talked / hung up early / mailbox not set up / voicemail / recording) | [call-goal-met.md](call-goal-met.md) | `node --test test/call-goalmet.test.js`; `REASON_BACKEND=claude-cli node bin/call-goal-drive.mjs calls.json` |
| To-do list (`REASON_TODO` off/owner/on: one plan in three groups, one yes, a grant for the businesses the plan named — never people or money — a self-updating checklist page, one wrap-up) | [todo-list.md](todo-list.md) | `node --test test/todo.test.js`; cage plan step on claude-cli; `bin/todo-drive.mjs` (whole road, fake call provider, claude-cli) |
| Call completeness (one memory across call and text; lookups remembered; no thinking before the first word) | [call-completeness.md](call-completeness.md) | `node --test test/call-*.test.js test/no-elevenlabs.test.js`, then `bin/call-filler-drive.mjs` (no model) |
| Reason Web drafts (replies appear as written, `REASON_WEB_DRAFTS`; only what passed the said check, no tool narration, self-note, NO_REPLY or marked figure; saved reply replaces it) | [web-drafts.md](web-drafts.md) | `node --test test/web-stream.test.js` (14); real CLI turn: `bin/web-drafts-drive.mjs` on a scratch instance |
| Scheduled calls ("call me at 7", a wake-up call; the timer carries the call, firing rings their own number with the goal as the first words; refusals and no-answer become one text; "remind me" stays a text; named times honoured; series) | [scheduled-calls.md](scheduled-calls.md) | `node --test test/timer-call.test.js`; `bin/timer-call-drive.mjs` under `caged.sh env` (fake provider, no model) |
| Per-person time zone (`REASON_TZ_ASK`; best guess + reason asked once before the first clock-time action, held action finished by the answer, "in 10 minutes" never asks, travel asked once per zone, their clock in every stamp/parse/day inside their turn and Web pages) | [time-zone.md](time-zone.md) | `node --test test/time-zone.test.js`; cage over the subscription (3 turns, see the file) |
| First-chat onboarding (`REASON_ONBOARDING` off/test/on; a brand-new number's "hey" → the owner's opener, name → what it means + "what do you want to call me?", the pick → the card under that name + one thing to try (a call or an event); no interview; event + invite joiners too; one steer per detour, one nudge ever, existing accounts exempt) | [onboarding.md](onboarding.md) | `node --test test/onboarding.test.js test/onboarding-migration.test.js test/event-web.test.js`; `bin/onboarding-drive.sh` (own cage + fake Sendblue, subscription) |
| GPT-Live calls (`REASON_CALL_VOICE=gptlive` own calls + `REASON_THIRD_PARTY_VOICE=gptlive` errands, everyone on live since 10-31/11-01: GPT-Live voice, Reason the brain by client delegation, honesty guard, Twilio Media Streams; needs Twilio keys; #379 pickup opener clip `REASON_PICKUP_OPENER` default on, `calls.first_audio_ms` + /ops "Calls: pickup → first word"; call-hearing: quiet inbound speech lifted before the voice hears it `REASON_CALL_HEARING` default on, ask-once on unclear words, no therapist tone on own calls, `calls.turn_log` per turn; call 79: holding lines by code, today so far in own-call prompts, limits kept, Reason's prompt warmed while it rings `REASON_CALL_CACHE_WARM`, talk-over hold; call 80: no code cut (only words after the last tool, streamed), real tool tracking, same memory as texts (rules, recall, places, week), Reason's own voice on own calls, weather by coordinates, fade, ambience 0.009375, rules to every model via src/rules.js) | [gptlive-calls.md](gptlive-calls.md) | `node --test test/gptlive.test.js test/call-pickup.test.js test/call-hearing.test.js test/call79-fixes.test.js test/call80-fixes.test.js test/rules-everywhere.test.js`; `bin/call-quality-drive.mjs` on Hetzner (whole own call, main vs branch); `bin/call-hearing-levels.mjs` on a stored recording (Hetzner only); `bin/gptlive-drive.mjs --expect hearing` / `bin/gptlive-line-drive.mjs` on Hetzner (real GPT-Live + claude-cli, no phone) |
| Call machines (a recording, a menu or a mailbox on a call Reason places is not a person: third-party line opens silent; recording/menu/mailbox named, key pressed, hung up by code; #379: a mailbox not set up or full → one text) | [call-machines.md](call-machines.md) | `node --test test/call-machines.test.js`; `bin/call-machines-drive.mjs` (claude-cli, no phone) |
| Choice cards (`REASON_CHOICE_CARDS` off/owner/on, `on` live since 10-31; 2–4 numbered picture cards after one line; tapback / inline reply on card N; Web joins them in one row; #376 `sameOnCard`: two cards that would look the same are never drawn) | [choice-cards.md](choice-cards.md) | `node --test test/choicecards.test.js` |
| Table pictures (`REASON_TABLE_IMAGES` off/owner/on, NOT live; `render_table`: 3+ options compared on the same facts as one PNG after the line, split at 8 rows, public 30-day address fetched by Sendblue, text fallback on any failure, picks by position or name against the kept rows) | [table-images.md](table-images.md) | `node --test test/render-table.test.js`; real PNGs: `node --test test/render-table-png.test.js` → `/tmp/render-table-preview/` |
| Shop Connect (`REASON_SHOP_CONNECT` off/owner/on, `on` live since 10-31; Crossmint checkouts, store sign-in + card on `/web/connect`; pay only on a yes to the exact amount; daily cap asked first; icon fetch pinned; #376 `checkFit` variant check before a checkout, fails open) | [shop-connect.md](shop-connect.md) | `node --test test/shopconnect.test.js test/shopping-everyone-1031.test.js`; cage per the file |
| Checkout job (a Crossmint checkout is a persistent `shop_runs` job: stages, every stall texted once, a plain form wakes the model, resume on boot; rides on `REASON_SHOP_CONNECT`; #376: an expired store hold inside the half hour is asked again, no stall text while awaiting approval) | [checkout-job.md](checkout-job.md) | `node --test test/checkout-job.test.js` |
| Checkout anticipates the form (`shop_shipping` record; a form Reason can answer is answered by code + one confirm line, only an unknown field asked; dropdown option values; rides on `REASON_SHOP_CONNECT`) | [checkout-anticipate.md](checkout-anticipate.md) | `node --test test/checkout-anticipate.test.js` |
| Purchase approval by passkey (`REASON_PASSKEY_PAY`, `on` live since 10-31; with a passkey saved a texted yes never pays — a Face ID link for that payment's amount and store, once, 30 min from the first ask (#376: store hold renewed up to twice inside it, one reminder 5 min before the end, item/shipping/tax breakdown on the page)) | [passkey-pay.md](passkey-pay.md) | `node --test test/passkey-pay.test.js`; `bin/passkey-drive.mjs [--shots=DIR]` (HTTP + Chromium virtual authenticator, muted) |
| The free trial and the subscription, one per phone number across lines (`REASON_PAYWALL`, ON on live since 2026-11-07 23:37 UTC, cut-off = the flip: everyone before it, invite and event joiners = free forever; new people 25 sessions, run on to 30 with no win, then the Stripe Checkout pay link; off = nothing counted/said/shown, `/pay/*` 302 home, Stripe ignored) | [paywall.md](paywall.md) | `node --test test/paywall.test.js test/paywall-win.test.js test/paywall-per-number.test.js test/pricing-flag.test.js`; `bin/paywall-drive.mjs` (in process, fake Stripe, no model); live (on): GET `/pay/done` → 200 "You're all set", `ops_state.paywall_on_since` set, read-only SQL in the file |
| The access list (sign-up ceiling text, heyreason.com/access form, `REASON_SIGNUPS_PER_HOUR`, `REASON_WEB_ACCESS_PER_DAY`) | [access-list.md](access-list.md) | `node --test test/web-access.test.js test/access.test.js`; `bin/free-tier-drive.mjs` |
| Daily spending limit per person (default `REASON_MAX_SPEND_PER_DAY`=100 on live; own cap by text `spend_limit_set` or Settings → Shopping; raise above default = Face ID / yes that expires; $1,000 ceiling; over-cap line names Settings → Shopping; a Crossmint payment with an unknown outcome counts, old ones backfilled at boot, released once only when Crossmint's order intent is cancelled/expired with $0 spent/reserved) | [spend-cap.md](spend-cap.md) | `node --test test/spend-cap-1031.test.js test/shop-unknown-spend.test.js`; `bin/spend-unknown-drive.mjs` (fake Crossmint, muted) |
| Research room (every planned query searched with a fair page share, bigger caps for big questions, one background follow-up when a cap still cuts it, 2/day per person, owner 5) | [research-room.md](research-room.md) | `node --test test/research-room.test.js test/research.test.js`; `bin/research-room-drive.mjs` over the subscription (3 turns, fake search) |
| Photo look (photo written down verbatim, `photo_look`) | [photo-look.md](photo-look.md) | `node --test test/looked.test.js`; real model: `test/flow-form.test.js` |
| Claude subscription usage on /ops (Reason's 5-hour/weekly %, one text at 80%; the Mac's coding subscription pushed to `/ops/usage`) | [ops-subscriptions.md](ops-subscriptions.md) | `node --test test/subusage.test.js`; cage: signed `curl` to `/ops/usage` with the cage secret |
| Paid-API hard caps (daily $1 for everything but calls, $10/month for all but calls; one owner text; calls are never stopped — their $2/day cap only texts; #374: one heads-up at 80% of the daily / monthly cap (`REASON_API_WARN_AT`), one owner text per provider usage-limit episode, /ops "API usage limit (provider)" row) | [api-caps.md](api-caps.md) | `node --test test/api-hard-cap.test.js test/api-spend.test.js test/spend-alert.test.js`; `bin/spend-alert-drive.mjs` (no model, fake owner thread); cage: seed `model_usage` past the caps, `POST /ops.json action=check` twice |
| Events (organize by text; guests join by text, pasted link or the page, with name + password; a role per event and "which event?"; private pages only on a recognized browser — a texted code; rides between guests behind `REASON_EVENT_RIDES`; the link's preview card + organizer cover with the flyer guardrail; the organizer's manage page on `/e/<id>`; scheduled messages + two automatic reminders; "Message guests" to everyone or only some (picked by name or joined since, first join); guest-list privacy and the cap changeable after creation; paid events (Stripe Connect Express, guest pays processing, 15-min hold, refunds, Tickets section; a refund policy per event with the guest's own refund by text or page, and a sales summary with the next Stripe payout; buy for friends — up to 4 tickets in one Checkout, each friend claims a single-use link as their own guest, per-seat partial refunds; `REASON_PAID_EVENTS`, owner-only on live); up to 3 guest questions on joining (optional or required), answers only for the organizer, one gated text to guests already in; all behind `REASON_EVENTS`) | [events.md](events.md) | `node --test test/event*.test.js`; `bin/events-drive.mjs` under `caged.sh env` (no model); `bin/event-card.mjs` (og tags, JS off); cage: `runTool("event_create")`, then curl `/e/<id>`, `/e/<id>/join`, `/e/<id>/signin` |
| Event albums (one private photo album per event: photos texted "for <event>" after a one-time note; organizer's check-in list, highlights, "End event and release album" = one text per checked-in guest; single-photo save + whole-album ZIP; one shared expiry, files deleted at it; behind `REASON_EVENT_ALBUMS`, dark on live) | [event-albums.md](event-albums.md) | `node --test test/event-album.test.js`; `bin/album-drive.mjs` under `caged.sh env` (no model); `bin/album-preview.mjs` (three PNGs); cage: `REASON_EVENTS=on REASON_EVENT_ALBUMS=on caged.sh start`, then curl `/e/<id>/album/manage` with and without a `reason_page` cookie |
| Flight search (SerpApi, then Duffel, each counted monthly; no source → one honest answer with a Google Flights link; search only, never books; date sweeps unavailable; /ops row) | [flight-search.md](flight-search.md) | `node --test test/flight-search.test.js test/flights.test.js test/flight-providers.test.js`; cage: `SERPAPI_API_KEY= DUFFEL_ACCESS_TOKEN=` + `runTool("flight_search")` → `unavailable` |
| Ops alerts at the point of failure (one updating alert per failure key, auto-resolve, `incident:<key>` + `watchdog` rows on /ops, `GET /alive`; only messaging/calls/purchases incidents are texted live, the rest held for the daily digest since `7a1476d`) and the watchdog outside the process (`scripts/watchdog.mjs`, systemd timer) | [ops-alerts.md](ops-alerts.md) | `node --test test/incidents.test.js`; cage: `REASON_VERIFY_FAKE_SENDBLUE` + `bin/fake-sendblue.mjs fail`, `bin/inbound.sh`, read `incidents`; watchdog with `REASON_WATCHDOG_SEND_URL` at a second fake + `kill -STOP` |
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
| Your pages (wordmark on every page Reason made → `/web/saved?kind=pages`; signed out → sign in → back; own pages only, type, ARCHIVED, search) | [pages-index.md](pages-index.md) | `node --test test/pages-index.test.js`; `bin/pages-index-drive.mjs` under `caged.sh env` (real HTTP + Chromium, no model) |
| Reason Web thread scrolling (v2: opens at the bottom with L1 ghost lines; "where you are" note = day + device; TODAY ↓ in the composer line; done tasks settle into DONE lines from `task_messages`; L2 finding earlier; L10 long work; labels who · where · when) | [web-thread.md](web-thread.md) | `node --test test/web-thread.test.js test/web-thread-browser.test.js`; `bin/web-thread-preview.mjs` (drives + draws + compare vs reference); live: temporary owner session, `/web?thread` + `/web/history` |
| Reason Web §4h plumbing (while you were out under TODAY once per return; take it back = cancellable until the turn takes the held row, never a held send; working line counts only from a real multi-file loop, label throttled 3 s) | [web-small-details-plumbing.md](web-small-details-plumbing.md) | `node --test test/web-4h-plumbing.test.js`; staging take-it-back / taken-back / while-you-were-out / working-counts; live: throwaway account + temporary session |
| Reason Web daily edition Home (`/web?home` behind REASON_WEB_DAILY: NO. n masthead, Caveat greeting, Overnight decision/update/done, Lines out, One question → Memory, New in your book, pick up = how they chat; one shared thread, no new-chat entry) | [web-daily.md](web-daily.md) | `node --test test/web-daily.test.js`; staging `daily-*` rows; live: journal `daily_edition` + owner session GET |
| Reason Web Stamps + shared stamps (`REASON_WEB_DAILY`: awarded at task done / call outcome / order placed, told once only at `on`; the book `/web/stamps`; share + revoke; public `/s/<12 base62>` + og.png, revoked → the same 404 page as an unknown id; redaction) | [web-stamps.md](web-stamps.md) | `node --test test/stamps.test.js test/stamps-web.test.js`; `bin/web-stamps-drive.mjs`; live: owner session → `/web/stamps`; throwaway account share → `/s/<id>`, og.png, revoke → the same 404 as an unknown id |
| Reason Web shell (the wordmark reads "reason" and never wraps; the logo always goes Home `/web?home`; link cards for signed-out `/web`, `/privacy`, `/terms`, none when signed in) | [web-shell.md](web-shell.md) | `node --test test/wordmark-text.test.js test/wordmark-one-line.test.js test/web-logo-home.test.js`; `bin/wordmark.mjs`; live: GET the three pages with a crawler UA, og tags + `og-*.png` 1200×630 |
| Walking directions, Route + Escort, and real trips (`REASON_DIRECTIONS` off/`owner`/on; the `directions` tool makes a stored trip at `/d/<id>` behind the code gate; `/d/sample` with `REASON_DIRECTIONS_SAMPLE`; MapLibre with no tiles or key, shapes from Overpass; Night after local sunset via suncalc; reroute through Reason's server) | [directions.md](directions.md) | `node --test test/directions.test.js test/trips.test.js`; `bin/directions-drive.mjs <out> --reference ~/Downloads/reason-directions-handoff/screens` (48 screens + fake-GPS walk + reroute + arrival + a real trip through the gate; `DIRECTIONS_DRIVE_ONLY=real` for that alone) |
| Reason Web v2 edge (every Text Reason → `body=hey` + typed hint; wrong/expired code digits stay in pen; L6 Texting you a code… / L7 CHECKING…; L3–L5 loading drawn at once then the real page fetched, STILL LOOKING… after 8 s, 9B on failure; E1 404 on unknown /web; E5 maintenance switch from /ops or `scripts/web-maintenance.mjs`; keyboard focus ring, skip link) | [web-edge.md](web-edge.md) | `node --test test/web-edge.test.js test/web-edge-browser.test.js`; live: temporary owner session, GET `/web/nope`, maintenance on for one fetch then off |
| NO_REPLY never reaches a person (marker off on every outbound path, mid-line and mid-sentence too; links/addresses/code untouched; marker-only = nothing sent, queued row `skipped` not `failed`) | [no-reply-marker.md](no-reply-marker.md) | `node --test test/no-reply-midtext.test.js test/no-reply-sanitizer.test.js`; caged over `bin/fake-sendblue.mjs` (real adapter, outbox sweep) |
| Reason Web reply to one message (`REASON_WEB_REPLY` off/`owner`/on: hover → REPLY, composer "replying to" + Esc, sent as an inline reply via Router.deliver `replyTo`/`threadRoot`; quote line over replies from Web, iMessage threads and Reason's pinned answers; Web turns pinned by answerTarget; touch tap/long press) | [web-reply.md](web-reply.md) | `node --test test/web-reply.test.js`; `bin/web-reply-drive.mjs [shots]` under `caged.sh env` (real HTTP + Chromium light/dark + touch, scripted model) |
| Reason Web notes as tags, files as chips (#267: shared location / inline reply / contact card / voice / file / burst shown as tags, Reason-sent files as chips; stored text unchanged) | [web-notes.md](web-notes.md) | `node --test test/web-notes.test.js`; `bin/web-notes-drive.mjs` (in process, no model) |
| Reason Web audio chips (voice notes in/out and call recordings play inline; owner-only route, .caf → .m4a, Range) | [web-audio.md](web-audio.md) | `node --test test/web-audio-chip.test.js`; `bin/web-audio-drive.mjs [--shots=DIR]` (in process, no model; WebKit + Chrome) |
| Deleting a person's data (`src/data.js` `deleteData({ conversation })`, `npm run data:delete`: every table keyed by their conversation, every table in exactly one list — `COVERAGE`; what a scoped delete keeps and why is `KEPT_ON_DELETE`) | [data-delete.md](data-delete.md) | `node --test test/data-coverage.test.js`; `bin/delete-coverage-drive.mjs` under `caged.sh env` (every table seeded, delete, scan; no model) |
| Tool input limits (a soft text field over its cap — Reason's own note, said, summary, why… — is cut at a word with "…" and the call goes through, the result says so; anything sent word for word, ids, URLs never cut; `timer_set` note cap 2,000; #376 `src/fitlong.js`) | [tool-limits.md](tool-limits.md) | `node --test test/fit-long.test.js` |
| Recall ("the spa place you called": done things rank above the thread, Reason's own "nothing saved" replies never handed back; "forget about X" takes the calls, exchanges, actions and reminders naming them out of recall; `busy_timeout` 5 s; #376: acted-on records rank above lookups within 0.3) | [recall.md](recall.md) | `node --test test/recall-history.test.js test/db-busy-timeout.test.js`; `bin/recall-figures-drive.mjs` under `caged.sh env` (19 steps, no model, no network) |
| No false "done" (#337 claim check, `REASON_CLAIM_CHECK` default `acting`: a reply saying started/sent/made that no tool this turn did is rewritten once) | [no-false-done.md](no-false-done.md) | `node --test test/no-false-done.test.js`; `bin/no-false-done-drive.mjs ulta\|directions\|chat [--inject] [--off]` (real claude-cli turn on the test token) |
| Security boundaries (own files only #345, ElevenLabs inbound webhook #350 — removed with ElevenLabs in #359, `/health` names nobody #352; delete #353 is data-delete.md; no payment details in any call field incl. the pickup opener `about`, lead 31 + R2-C; only his own turn instructs a remote builder and remote_say cannot answer a risky ask, lead 34; connect links finish only in the asker's browser, lead 1 #358) | [security-boundaries.md](security-boundaries.md) | `node --test test/driveorg.test.js test/no-elevenlabs.test.js test/health-redact.test.js test/call-payments.test.js test/remote.test.js test/oauth-binding.test.js`; `bin/recall-figures-drive.mjs` own-file steps; `bin/call-payments-drive.mjs` and `bin/remote-gate-drive.mjs` under `caged.sh env`; `bin/oauth-connect-drive.mjs` on a cage; cage `GET /health` |
| Reason Web wax-seal book (`REASON_STAMPS_WAX`/`EVERYDAY`/`TIERS`/`ALL`) | [web-stamps-wax.md](web-stamps-wax.md) | `node --test test/stamps-wax.test.js test/stamps-all.test.js`; `bin/web-seals-drive.mjs` |

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

- Phone calls beyond [call-completeness.md](call-completeness.md) — the opening line, voicemail, language switch, holds, third-party errands (`src/calls/`, `test/call-*.test.js`). Call turns are driven in process (`bin/call-identity-drive.mjs`, claude-cli; `bin/call-filler-drive.mjs`, no model) — there is no HTTP call-turn route.
- Voice notes — `src/voice.js`, `test/voice.test.js`
- Email, calendar and Drive, per Google account — `src/google.js`, `src/drive.js`, `src/driveorg.js`
- Documents: `.docx`, `.pptx`, `.pdf` — `src/documents/`, `test/documents.test.js`
- The browser Reason drives itself, and sign-in windows — `src/browser.js`, `src/signin*.js`
- Timers, tasks, watches and the 15s sweep — `src/runtime.js`, `test/tasks.test.js`
- Tapbacks and iMessage screen effects — `src/tapbacks.js`, `src/expressive.js`
- The harm gate (every message screened beside the turn, #227) — `src/harm.js`, `test/harm.test.js`; what it is shown, and the 2026-10-23 outage, are in [inbound-message.md](inbound-message.md)
- Flight records and check-in — `src/flights.js` (`flight_list`, `flight_checkin_start`; a sign-in probe that cannot read the account page twice is `blocked: "could_not_check_signin"`, never "not signed in" — `test/flights.test.js`, `test/signin.test.js`). Flight *search* is mapped in [flight-search.md](flight-search.md)
- Receipts, the undo window, the furthest point
- **Stopping Reason dead, and starting it again** — `pause_everything` / `resume_everything`
  (`src/pause.js`; `grep -n 'name: "pause_everything"\|case "pause_everything"' src/tools.js`),
  shipped 2026-10-11 in `eeb760d`. Covered by `test/pause.test.js`. A real user-facing control with
  no feature file.
- **The master pausing or removing a person** — `admin_pause` / `admin_resume` / `admin_remove`
  (`case "admin_pause"` in `src/tools.js`). Since #351 (`d0b7f79`, 2026-11-07) a stop belongs to the
  number, not one texting line: `db.stoppedStateOf(address)` ("removed" outranks "paused") is read by
  `accounts.accountState`, inbound calls, invite redemption and every background sweep — the event
  sweeps too (scheduled messages, reminders, ride asks, list notes, the album nudge hold for a stopped
  organizer via `events.organizerStopped`, lead R2-A) — so a number
  stopped on Sendblue is stopped on Linq too. A pause never softens a removal on another line; a
  resume clears pauses on every line but never brings back a removed one — it answers
  `ok: false, state: "removed"` until the master explicitly says to undo it, then
  `admin_resume { number, undo_removal: true }`. Covered by `test/state-per-person.test.js`. No
  feature file.
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
  (`test/accounts.test.js:167` and the old provider's test, since removed).
- **A restart does not eat a text** — the startup catch-up (`3c45286`) and its owner guard
  (`wt/catchup-guard`); mapped in [inbound-message.md](inbound-message.md).
- **The morning brief** — `src/brief.js`, `test/brief.test.js`, `test/flow-brief.test.js`, shipped
  `e42894a` (2026-10-13). Not driven here yet.
- **Video inbound** — `.mov`, `.mp4` etc. uploaded to Gemini Files API and watched —
  `src/channels/sendblue.js` (`attachmentOf`, `VIDEO_EXTS`), `src/media.js` (`videosFor`, used by
  `src/agent.js` and, since #376, `src/backends/claude-cli.js`), `test/video.test.js`,
  `test/video-watch-timeout.test.js`. Shipped `d84a244`; #376 added the 3-min watch deadline
  (`REASON_VIDEO_WATCH_TIMEOUT_MS`) — mapped in [inbound-message.md](inbound-message.md).
- **The website's access form** — `POST /access/web` (`WEB_ACCESS_PATH` in `src/http.js`, `src/access.js`), signed
  by the Netlify function with `REASON_WEB_ACCESS_SECRET`; `REASON_ACCESS_URL` on Netlify points at
  Hetzner since 2026-10-12. An unsigned POST → 401 is the only read-only probe; a signed one queues
  a real access request on the owner's phone.
- **X (Twitter) integration** — OAuth 2.0 PKCE, posting, reading timeline — `src/x.js`,
  `test/x.test.js`. Shipped `73db165`.
- **GitHub connected account** — OAuth flow, 11 tools — `src/github.js`, `test/github.test.js`.
  Shipped `e22a85b`.
- **Apple Calendar** — CalDAV read/write — `src/icloud.js`. Shipped `437b051`. Since #347 the Apple ID
  credential goes only to `caldav.icloud.com` / `pNN-caldav.icloud.com` over https.
- **Private-network guard** (#348) — `src/netguard.js`: a URL somebody else chose never reaches a
  private or loopback host (web_lookup, offers, inbound media, video, browser); inbound media is
  https-only. Only bypass: `REASON_TEST_ALLOW_PRIVATE_FETCH=1` under `node --test`.
- **Ops alerts that wait for a second wrong pass** (#85) — `src/ops.js`, `test/ops.test.js`: a check is
  texted to the owner only once it is still wrong on the next pass. Live: `/ops`, `/ops.json`.
  Failures known when they happen skip that wait — see [ops-alerts.md](ops-alerts.md).
- **The /ops status page** (#106) — `src/pages/ops.js`, `src/opspassword.js`, `opsRequest` in
  `src/http.js`; `test/ops-gate.test.js`. Password gate (`REASON_OPS_PASSWORD_HASH`, sign-in 303),
  instant Check again / Clear (202 as JSON), `running` in `/ops.json`; public at
  `heyreason.com/ops` via Netlify. On the cage both routes answer 401 without a sign-in; this
  Mac's `.env` has no hash (checked 2026-11-07), so the cage shows the code gate unless started
  with a throwaway `REASON_OPS_PASSWORD_HASH=… bin/caged.sh start` (the shell env passes through;
  `start` begins on a fresh database, so read the ops key again after each start). Lockout rules (audit lead 23, `test/ops-gate-lockout.test.js`): a code is only
  sent **and only taken** with the ops key (`?k=`, `ops_state` row `key`); a keyless `code=` POST
  answers the gate (401) and adds nothing to `page_attempts` page `ops`. Keyless wrong passwords
  count under `ops:pw:<ip>` (5) and the shared `ops:pw` (30); keyed ones only under `ops:pw:key`
  (5), so strangers' guesses never 429 the keyed link. Follow-up (`test/ops-gate-per-source.test.js`):
  a keyless request the website **signed** (`x-nf-sign` valid for `REASON_SITE_PROXY_SECRET`,
  `opspw.verifiedSource`; IPv6 as its /64) counts only under `ops:pw:src:<addr>` (5) plus
  `ops:pw:every` (300, every non-keyed wrong try), never the shared 30 — so unsigned/forged
  guesses cannot 429 it. Caddy's `X-Files-Domain` is NOT trusted here (the Funnel lands on the same
  port from loopback). Takes effect live only once the site's `/ops` + `/ops.json` rewrites carry
  `signed = "REASON_SITE_PROXY_SECRET"` (they did not as of 2026-11-07); the cookie stays host-only
  either way. Cage drive (2026-11-07, 8879, throwaway hash + `REASON_SITE_PROXY_SECRET=cage-proxy-secret`
  in the shell): 30 forged unsigned wrong → unsigned right, forged-signature right, forged
  `x-files-domain` right all 429; signed wrong → 401 "4 tries left"; signed right → 303 + host-only
  cookie; signed stranger 5 wrong → 429 for that address, another signed address → 303. Cage drive (2026-11-07, 8863): 7 keyless `code=`
  POSTs → 401 and no `ops` rows; 30 keyless `password=` POSTs with varied `x-forwarded-for`, then
  the right one keyless → 429, keyed wrong → 401 "4 tries left", keyed right → 303 + cookie; key
  = `SELECT v FROM ops_state WHERE k='key'`; `peek.sh sql "SELECT page_id, ok, count(*) FROM page_attempts GROUP BY 1,2"`.
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
