// Everything Reason keeps lives under one directory, so a hosted install can mount one volume and
// not lose anything on a restart: the database, call recordings, saved browser profiles and
// screenshots. Each one can still be pointed somewhere else individually, but the default is that
// they are all together — a deployment where half the state is on a volume and half is not is a
// deployment that silently forgets things.
import * as zonescope from "./zonescope.js";

const DATA_DIR = (process.env.REASON_DATA_DIR || "data").replace(/\/+$/, "");

export const config = {
  dataDir: DATA_DIR,
  model: process.env.REASON_MODEL || "claude-opus-5",
  // Which model backend runs a turn. "api" is the only one Reason is deployed on; "claude-cli"
  // is the owner's local test rig on a Claude subscription, and src/backends/guard.js refuses to
  // serve other people on it.
  backend: process.env.REASON_BACKEND === "claude-cli" ? "claude-cli" : "api",
  dbPath: process.env.REASON_DB_PATH || `${DATA_DIR}/reason.db`,
  ownerName: process.env.REASON_OWNER_NAME || "Omari",
  // The language the owner's pages carry their top line in ("twi"); empty is English. Anyone else
  // sets theirs by telling Reason (the my_name tool), which goes on their account row.
  ownerLanguage: process.env.REASON_OWNER_LANGUAGE || "",
  ownerCity: process.env.REASON_OWNER_CITY || "New York",
  // The install's zone, and the fallback for anyone who has not confirmed theirs. Read inside a
  // person's turn or Web request, `config.tz` is THEIR confirmed zone (src/zonescope.js), which is
  // how every reminder, stamp and day boundary follows them without each reader being told.
  installTz: process.env.REASON_TZ || "America/New_York",
  get tz() { return zonescope.current() || this.installTz; },
  set tz(v) { this.installTz = v; },
  // Asking a person their zone before the first clock-time action (src/zone.js). Off: nobody is
  // asked and everyone stays on the install's zone, as before.
  tzAsk: process.env.REASON_TZ_ASK === "on",
  fallbacks: process.env.REASON_FALLBACKS !== "off",
  // How long an explicit yes counts for, in minutes. After this a guarded tool asks again.
  confirmWindowMin: Number(process.env.REASON_CONFIRM_WINDOW_MIN || 10),
  // How long an ask for a yes stays answerable, in hours, by what it is for (src/db.js askTtlMs).
  // Past this the ask is closed as a no, never as a yes, and a late "yes" grants nothing: the model
  // re-checks the details and asks again. Before 2026-10-30 an ask never ran out, so a "yeah" this
  // week could land on a call ask from two weeks ago.
  //   reach (calls, texts, voice notes, DMs to someone else): 12h. Those are about "now" (business
  //     hours, a moment that passes); yesterday's call ask should not still be live this morning.
  //   money (purchases, rides, bookings, submits, anything with an amount): 24h. Prices and stock
  //     move daily, but people need a day to think about spending.
  //   everything else: 24h.
  askTtlReachH: Number(process.env.REASON_ASK_TTL_REACH_H || 12),
  askTtlMoneyH: Number(process.env.REASON_ASK_TTL_MONEY_H || 24),
  askTtlDefaultH: Number(process.env.REASON_ASK_TTL_DEFAULT_H || 24),
  // The gate's reader: a separate narrow call that decides what the owner's reply meant.
  // Defaults to the same model as the conversation, because misreading a yes is the costly mistake.
  judgeModel: process.env.REASON_JUDGE_MODEL || process.env.REASON_MODEL || "claude-opus-5",
  judgeTimeoutMs: Number(process.env.REASON_JUDGE_TIMEOUT_MS || 12_000),
  // The harm screen (src/harm.js): one narrow call on every message anybody sends. On the
  // subscription, never the paid API (owner, 2026-10-27): `claude -p` on haiku, the same model the
  // API screen ran on. It runs alongside the turn rather than in front of it (Runtime._screen), so
  // its cold start costs no wait: every tool and the reply wait for its verdict instead. There is no
  // switch that turns the screen off. `harmModel` is the API model, kept for phone calls only.
  harmModel: process.env.REASON_HARM_MODEL || "claude-haiku-5-5",
  // The harm screen on a CALL runs in the hot path before the first spoken word, so it has to be
  // fast: a cold `claude` CLI start is ~4.5s of dead air on the line, and opus does not support the
  // forced tool_choice the screen uses. A small fast model on the API classifies the same thing in
  // ~1s, so a call screens on this rather than on the global (CLI) backend. Text is unaffected.
  callHarmModel: process.env.REASON_CALL_HARM_MODEL || process.env.REASON_HARM_MODEL || "claude-haiku-5-5",
  // Per attempt, on the API (a call's screen). Two attempts before it says `unscreened`.
  harmTimeoutMs: Number(process.env.REASON_HARM_TIMEOUT_MS || 8_000),
  // A text's screen, on the subscription. Past the timeout it is `unscreened`: the turn's hands stay
  // tied, and the reply never waits longer than this for a verdict.
  harmCliModel: process.env.REASON_HARM_CLI_MODEL || "haiku",
  harmCliTimeoutMs: Number(process.env.REASON_HARM_CLI_TIMEOUT_MS || 20_000),
  // Strikes: this many 'harm' refusals inside this many hours pauses that person's Reason and
  // tells the master (count and kind only). 0 strikes = count but never pause. The master's own
  // account is refused the same way and never paused.
  // How many messages from one person may go unread by the screen in an hour before the replies to
  // them are screened on the way out as well (Runtime._afterScreen). 0 turns that off.
  harmUnscreenedLimit: Number(process.env.REASON_HARM_UNSCREENED_LIMIT ?? 3),
  harmStrikeLimit: Number(process.env.REASON_HARM_STRIKES ?? 3),
  harmStrikeWindowHours: Number(process.env.REASON_HARM_STRIKE_WINDOW_H || 24),
  // Proactive follow-up. A thread counts as dropped when something is still open and neither the
  // plan nor the conversation has moved for this long. The two limits after it are what stop
  // Reason from nagging: the same plan is not raised again inside the gap, and one conversation
  // gets at most this many nudges a day. Both are counted from the nudges table, not from memory.
  followUpIdleMin: Number(process.env.REASON_FOLLOWUP_IDLE_MIN || 180),
  nudgeGapMin: Number(process.env.REASON_NUDGE_GAP_MIN || 20 * 60),
  nudgeMaxPerDay: Number(process.env.REASON_NUDGE_MAX_PER_DAY || 2),
  // ---------- noticing things first (src/notice.js) ----------
  //
  // The watchful sweep: how often it looks at a connected mailbox and calendar for something that
  // slipped, and the hours it will not interrupt anybody in. Every one of these is a decision about
  // WHEN to look and HOW MANY times to speak, which is code's; what is worth saying is the model's.
  //
  // Two hours is chosen against the thing being watched for rather than against cost. A meeting that
  // moves is useful to hear about as long as there is still time to react, and the delivery is timed
  // separately anyway — a catch about something starting later today is scheduled for two hours
  // before it rather than said on whichever sweep happened to find it.
  noticeEveryMs: Number(process.env.REASON_NOTICE_EVERY_MS || 2 * 60 * 60_000),
  // Nothing unprompted between these two hours, in THEIR zone, unless the model marked it urgent
  // and said why. Local hours 0-23; the quiet window wraps midnight.
  noticeQuietStart: Number(process.env.REASON_NOTICE_QUIET_START ?? 22),
  noticeQuietEnd: Number(process.env.REASON_NOTICE_QUIET_END ?? 8),
  // The budget. One great catch a day beats five generic ones, so the default is ONE — and the hard
  // cap is what urgent cannot talk its way past. Per person, counted in the database, reset at their
  // local midnight. A person's own "text me less" overrides the first of these (accounts table).
  noticePerDay: Number(process.env.REASON_NOTICE_PER_DAY ?? 1),
  noticeHardCap: Number(process.env.REASON_NOTICE_HARD_CAP ?? 3),
  // How far ahead a calendar change counts as worth noticing, and how far ahead a bill or an
  // appointment in the mail does. Two days and a week: a meeting that moves next month is not news
  // today, and a bill due in ten days is not either.
  noticeHorizonHours: Number(process.env.REASON_NOTICE_HORIZON_HOURS ?? 48),
  noticeBillDays: Number(process.env.REASON_NOTICE_BILL_DAYS ?? 7),
  // Per-person cadence for checking whether a subscription renewal is approaching.
  subscriptionCheckEveryMs: Number(process.env.REASON_SUBSCRIPTION_CHECK_EVERY_MS ?? 24 * 60 * 60_000),
  // How many days before a renewal the person is told about it.
  subscriptionRenewalLeadDays: Number(process.env.REASON_SUBSCRIPTION_RENEWAL_LEAD_DAYS ?? 3),
  // How many days before a stale scan is flagged for re-scanning.
  subscriptionScanStaleDays: Number(process.env.REASON_SUBSCRIPTION_SCAN_STALE_DAYS ?? 14),
  // From when an unread mail from a person is DESCRIBED to the model as waiting on them. It no
  // longer keeps anything out of the sweep (until 2026-10-06 nothing under a day was shown at all,
  // which is how a six-hour-old interview invite went unmentioned); the model reads the age.
  noticeWaitingHours: Number(process.env.REASON_NOTICE_WAITING_HOURS ?? 24),
  // Momentary delivery. A catch about something on their calendar goes out this long before it, so
  // it lands when it is useful — except when the thing moved and is inside the second window, which
  // is too soon to sit on.
  noticeLeadMin: Number(process.env.REASON_NOTICE_LEAD_MIN ?? 120),
  noticeNowHours: Number(process.env.REASON_NOTICE_NOW_HOURS ?? 6),
  // How many mailbox probes one sweep may spend working out whether a sender is somebody they know.
  // A ceiling rather than a queue: past it the rest of the unread mail is simply not a candidate
  // this time round, which costs a sweep and never a wrong answer.
  noticeContactProbes: Number(process.env.REASON_NOTICE_CONTACT_PROBES ?? 6),
  // Somebody on 'digest' gets ONE batched line, at this hour of their own clock, rather than a text
  // at the moment each thing is found. Their own chosen hour overrides it (accounts table).
  noticeDigestHour: Number(process.env.REASON_NOTICE_DIGEST_HOUR ?? 18),
  // A snooze lasts the rest of their day and then expires on its own: "snooze for today" must never
  // become a setting somebody has to remember to turn back off.
  noticeSnoozeHours: Number(process.env.REASON_NOTICE_SNOOZE_HOURS ?? 24),
  // Home coordinates for the travel-time notice. When a calendar event has a location and these
  // are set, the sweep computes driving time and raises a "leave by" candidate. Per-person
  // overrides live in saved_places (set_place tool); these are the install default.
  noticeHomeLat: process.env.REASON_NOTICE_HOME_LAT ? Number(process.env.REASON_NOTICE_HOME_LAT) : null,
  noticeHomeLng: process.env.REASON_NOTICE_HOME_LNG ? Number(process.env.REASON_NOTICE_HOME_LNG) : null,
  // Buffer added on top of the driving time, in minutes. Accounts for parking, walking, etc.
  noticeTravelBufferMin: Number(process.env.REASON_NOTICE_TRAVEL_BUFFER_MIN ?? 15),
  // ---------- the four catches about something being WRONG (src/alerts.js) ----------
  //
  // How far ahead a meeting has to be for "somebody wrote after the invite was last touched" to be
  // worth looking at. Two days: a meeting next month whose time may have changed is not news today,
  // and the thread will still be there when it is.
  alertStaleHours: Number(process.env.REASON_ALERT_STALE_HOURS ?? 48),
  // A reply they are waiting on: how long before nobody answering is a fact rather than a Tuesday,
  // how far back to look at all, and how many mailbox probes one sweep may spend settling it.
  //
  // Two days, because one is somebody being busy. A fortnight back, because a thread from March is
  // not live. Four probes, because the honest version of this costs one thread read per candidate
  // and an unbounded version would read a person's whole sent mailbox every two hours to find one
  // line — which is a far more invasive read than the catch is worth.
  alertAwaitingHours: Number(process.env.REASON_ALERT_AWAITING_HOURS ?? 48),
  alertAwaitingDays: Number(process.env.REASON_ALERT_AWAITING_DAYS ?? 14),
  alertAwaitingProbes: Number(process.env.REASON_ALERT_AWAITING_PROBES ?? 4),
  // A dated thing on their calendar: how far out it is still worth one line. Three days, so rent on
  // the 1st is mentioned on the 29th and not on the 12th.
  alertDeadlineHours: Number(process.env.REASON_ALERT_DEADLINE_HOURS ?? 72),
  // A meeting with people on it: how far ahead the brief is offered. A day, because a brief is
  // useful the evening before and pointless the week before.
  alertBriefHours: Number(process.env.REASON_ALERT_BRIEF_HOURS ?? 24),
  // How many goals one person may have a standing search running for at once. Five, for the same
  // reason as maxSeries below: the failure guarded against is not somebody wanting six, it is a
  // model that offers a daily search every time a subject comes up. Counted in SQL on every
  // attempt (src/goals.js). 0 means uncapped.
  maxGoals: Number(process.env.REASON_MAX_GOALS ?? 5),
  // A standing commitment they set: how long past the time they named before a missed one is
  // noticed, and how long after that there is still any point saying anything.
  //
  // Ten minutes is the grace. Five would catch somebody walking out of the door and the card this
  // is built from is explicit that the nudge must never read as a reproach.
  //
  // Three hours is the window, and it is the more important of the two: past it the morning has
  // gone, and "you said 7am" at two in the afternoon is not making going easy, it is a verdict on
  // their day. A nudge that misses its window is dropped rather than held — the one thing in Reason
  // that is better lost than late.
  habitGraceMin: Number(process.env.REASON_HABIT_GRACE_MIN ?? 10),
  habitWindowMin: Number(process.env.REASON_HABIT_WINDOW_MIN ?? 180),
  // How many missed ones in a row before Reason stops nudging and asks whether the schedule itself
  // is wrong. Three, because twice is a fortnight of life happening and four is nagging.
  habitRunOfSkips: Number(process.env.REASON_HABIT_RUN_OF_SKIPS ?? 3),
  // Watchers: how often one may re-check, and how many times before it gives up.
  watchMinEveryMin: Number(process.env.REASON_WATCH_MIN_EVERY_MIN || 15),
  watchMaxChecks: Number(process.env.REASON_WATCH_MAX_CHECKS || 200),
  // Price watches (src/deals.js). The floor is what keeps a watch from hammering a shop: one read of
  // one page every few hours, and never two reads of the same shop in one sweep pass.
  dealWatchMinEveryHours: Number(process.env.REASON_DEAL_WATCH_MIN_EVERY_HOURS || 6),
  dealWatchDefaultEveryHours: Number(process.env.REASON_DEAL_WATCH_EVERY_HOURS || 12),
  dealWatchMaxActive: Number(process.env.REASON_DEAL_WATCH_MAX_ACTIVE || 10),
  // Checks in a row that verified no price before the watch stops and says so.
  dealWatchMaxUnverified: Number(process.env.REASON_DEAL_WATCH_MAX_UNVERIFIED || 3),
  // How long a verified drop or a stop stays something the notice sweep may raise.
  dealNewsDays: Number(process.env.REASON_DEAL_NEWS_DAYS || 3),
  // Durable tasks. A task that wakes and does not say when to come back is re-scheduled this far
  // out rather than left for dead; a step that crashes is retried this many times, backing off a
  // step each time; and a task that has woken this often without ever finishing gives up and says
  // so — the same ceiling watchers have, so nothing runs forever unnoticed.
  taskDefaultWakeMin: Number(process.env.REASON_TASK_WAKE_MIN || 15),
  taskMaxAttempts: Number(process.env.REASON_TASK_MAX_ATTEMPTS || 3),
  taskRetryBackoffMin: Number(process.env.REASON_TASK_RETRY_BACKOFF_MIN || 2),
  taskMaxWakes: Number(process.env.REASON_TASK_MAX_WAKES || 200),
  // A job waiting on somebody else cannot sleep past this. The model may ask to come back in ten
  // hours; code comes back this often, looks at what the sweep found since the last look, and
  // only pays for a model turn when something landed or the model's own time has come. The night
  // of 2026-10-12 a watcher slept 9:49pm→8am through the invite it was waiting for. See src/landed.js.
  taskWaitingFloorMin: Number(process.env.REASON_TASK_WAITING_FLOOR_MIN || 120),
  // Timers. A timer counts as fired once its message is in the outbox, so a turn that throws or
  // times out leaves it due. It is tried this many times in all — the first retry on the very next
  // sweep, each one after that a step further off (a minute, then two) — and then Reason stops and
  // says in a line of its own that a reminder was missed. Three, because a reminder is about a
  // moment: a turn killed by the machine going to sleep or a dropped connection clears on the next
  // try, and one that is still failing after three is better admitted now than delivered an hour
  // late with nobody knowing why.
  timerMaxAttempts: Number(process.env.REASON_TIMER_MAX_ATTEMPTS || 3),
  timerRetryBackoffMs: Number(process.env.REASON_TIMER_RETRY_BACKOFF_MS || 60_000),
  // How late a timer may still fire. Past this it is skipped rather than sent: a reminder, a scan or
  // a check-in held by a pause, a lapse or a stopped process and then fired 17-26 hours after its
  // time (seen live, 2026-11) tells them about a moment that has gone. A person's own reminder that
  // is skipped gets one line saying it was missed; a check or a chain Reason set is dropped quietly.
  // A timer set to fire at once (code's own "do this now" events) is exempt: it was always "now".
  timerLateMs: ((m) => (Number.isFinite(m) && m > 0 ? m : 120))(Number(process.env.REASON_TIMER_LATE_MIN)) * 60_000,
  // How many standing check-ins one person can have running at once — counting the repeating checks
  // Reason keeps going itself by setting a timer from a timer (db.countRecurring), so a chain is not
  // a way round it. Ten, because the failure this
  // guards against is not somebody wanting eleven: it is a model that sets a new series every time a
  // subject comes up, and a phone that then buzzes at nine every morning about four things nobody
  // asked about twice. Counted in SQL on every attempt (src/series.js), never held in memory, so a
  // restart cannot lose count. 0 means uncapped, for anybody who really wants that.
  maxSeries: Number(process.env.REASON_MAX_SERIES ?? 10),
  // How long a task that is waiting on THEM sits before Reason mentions it one more time. Once,
  // after this gap, and never again: the stamp is on the row, so two hundred wakes cannot turn
  // "owning the loose end" into nagging. A day is the default because the thing it is waiting on is
  // usually a decision somebody is deliberately not making yet.
  needsReminderMin: Number(process.env.REASON_NEEDS_REMINDER_MIN || 60 * 24),
  // Where pages are reachable from the outside. Empty means they still work, but only on this
  // machine — and the capabilities tool says exactly that rather than handing out a link that
  // will not open on a phone.
  publicUrl: (process.env.REASON_PUBLIC_URL || "").replace(/\/+$/, ""),
  pagesUrl: (process.env.REASON_PAGES_URL || "").replace(/\/+$/, ""),
  // Where event links live (owner's domain rule, 2026-10-26: events.heyreason.com). Every event
  // address Reason builds — the join page, who's going, the album, the cover — starts here. Unset:
  // the pages domain, as before, so an install with one domain keeps working.
  eventsUrl: (process.env.REASON_EVENTS_URL || "").trim().replace(/\/+$/, ""),
  // The secret the website (Netlify) signs every request it proxies here with (`signed =` on the
  // /web rewrites; HS256 `x-nf-sign`, src/pages/siteproxy.js). Only a request carrying a valid
  // signature is believed about the visitor's address or that it came through the website. Unset:
  // nothing is, and /web is served on whatever host asked.
  siteProxySecret: (process.env.REASON_SITE_PROXY_SECRET || "").trim(),
  // The secret Caddy on this machine sends as `X-Reason-Caddy` on the hosts it proxies here
  // (`header_up X-Reason-Caddy <secret>` beside `X-Files-Domain true`). The Tailscale Funnel lands on
  // the same port from the same loopback address and passes a browser's headers through, so the
  // marker alone proves nothing: only with this secret is Caddy's X-Forwarded-For believed about a
  // visitor's address (src/pages/siteproxy.js caddyClientIp). Unset: it never is, and every unsigned
  // browser shares the socket's one count.
  caddySecret: (process.env.REASON_CADDY_SECRET || "").trim(),
  // The website's Netlify site id; when set, a signature for any other site is not ours.
  siteProxyId: (process.env.REASON_SITE_PROXY_ID || "").trim(),
  // Where the owner opens the status page (src/ops.js): every link Reason hands them for it — the
  // alert texts, "back to normal", the status_page tool — is this plus `?k=`. The website proxies
  // /ops to this server (2026-10-24), so it lives on the domain the owner already knows rather
  // than on the Tailscale name. Set it empty to fall back to REASON_PUBLIC_URL/ops.
  opsUrl: (process.env.REASON_OPS_URL ?? "https://heyreason.com/ops").trim().replace(/\/+$/, ""),
  // The status page's password, as `scrypt:<saltHex>:<hashHex>` (src/opspassword.js). Only the hash
  // is ever here, and only in the server's environment. Unset: the page has the texted-code gate alone.
  opsPasswordHash: (process.env.REASON_OPS_PASSWORD_HASH || "").trim(),
  // When Reason's texting line moved from the shared +1 808 number to its own (src/linechange.js).
  // Somebody who texted Reason before this is sent the card for the new number the first time
  // they write to it. Not a date → nobody is.
  lineChangeAt: Date.parse(process.env.REASON_LINE_CHANGE_AT || "2026-10-23T15:50:00Z"),
  // A fuller website about this Reason, if there is one. The plain home page links to it at the
  // bottom; empty means no such link. Only a real web address is taken, so a typo cannot become a
  // link to somewhere strange.
  siteUrl: /^https?:\/\/[^\s"'<>]+$/.test(process.env.REASON_SITE_URL || "") ? process.env.REASON_SITE_URL : "",
  // How long Reason keeps what it has. Two numbers, because there are two different things and
  // they do not deserve the same answer (see src/privacy.js, which is where the policy lives).
  //
  // CONTENT is the stuff itself: the words in a voice note, the text of a page or a video Reason
  // fetched, the running history of a conversation nobody has touched since. A month is long enough
  // that "what did i say in that note last week" still works and short enough that a database
  // somebody walks off with is not years of their life.
  //
  // RECORDS is the much smaller fact that something happened: a row saying a voice note arrived on
  // the 3rd and was transcribed, the provider's message id that stops a retry being answered
  // twice, a sent text's outbox row. These are what make Reason able to say "you sent me two
  // photos and I could only read one", and they hold no content, so they are kept a year. The
  // dedupe keys are in here on purpose: delete those early and a provider redelivering an old
  // message gets a second real answer.
  //
  // 0 on either means keep forever, which is what every install did before this existed.
  keepContentDays: Number(process.env.REASON_KEEP_CONTENT_DAYS ?? 30),
  keepRecordsDays: Number(process.env.REASON_KEEP_RECORDS_DAYS ?? 365),
  // `npm run serve`: how often the sweep runs, and where the webhook listener binds.
  sweepEveryMs: Number(process.env.REASON_SWEEP_EVERY_MS || 15_000),
  // How long since a pass last FINISHED before the status page calls the sweep stuck. Passes no
  // longer overlap, and one with a few model turns in it (each allowed five minutes on the CLI)
  // honestly takes minutes — four 15-second intervals would page Omari over a slow pass. Ten
  // minutes is past any healthy pass and still well inside "a reminder is late".
  sweepStuckMs: Number(process.env.REASON_SWEEP_STUCK_MS || 10 * 60_000),
  port: Number(process.env.REASON_PORT || 8787),
  host: process.env.REASON_HOST || "127.0.0.1",
  // The owner's conversation, and the numbers allowed to be it. Owner identity is config, never
  // anything a message claims: an inbound number that is not on this list gets its own thread and
  // cannot authorize, spend, or act on anyone.
  ownerConversation: process.env.REASON_CONVERSATION || "dm:owner",
  // The MASTER account: a normal account with its own private Reason, plus admin rights. One
  // number here still gives exactly the single-owner install this started as.
  // REASON_MASTER_NUMBER is the name now. REASON_OWNER_NUMBER is still read, because that is what
  // existing installs have in their .env, and silently ignoring it would lock somebody out of
  // their own Reason. `operatorNumbers` and `ownerNumbers` are aliases: one source, three names,
  // because the rest of the code called this the operator when there was only ever one person.
  masterNumbers: (process.env.REASON_MASTER_NUMBER || process.env.REASON_OWNER_NUMBER || "").split(",").map(s => s.trim()).filter(Boolean),
  operatorNumbers: (process.env.REASON_MASTER_NUMBER || process.env.REASON_OWNER_NUMBER || "").split(",").map(s => s.trim()).filter(Boolean),
  ownerNumbers: (process.env.REASON_MASTER_NUMBER || process.env.REASON_OWNER_NUMBER || "").split(",").map(s => s.trim()).filter(Boolean),
  // Anyone may text Reason. A number with no account gets ONE line saying access is being asked
  // for, and the master is asked whether to let them in (src/access.js). Nothing a stranger says
  // reaches the model until the master says yes.
  // How long a declined number is left alone before the master is troubled about it again.
  declineCoolOffDays: Number(process.env.REASON_DECLINE_COOLOFF_DAYS ?? 7),
  // At most this many access requests are put to the master in an hour; the rest are batched into
  // a count, so nobody can turn the master's phone into a queue.
  maxRequestsShownPerHour: Number(process.env.REASON_MAX_REQUESTS_PER_HOUR ?? 5),
  // And at most this many in a day, however they arrived. The hourly ceiling alone still lets a
  // patient bot put a hundred questions on the master's phone by tomorrow.
  maxRequestsShownPerDay: Number(process.env.REASON_MAX_REQUESTS_PER_DAY ?? 10),
  // The website's "request access" form (src/access.js, POST /access/web). The form's own server
  // signs each request with this secret; with it unset the route does not exist. It lives in this
  // install's settings and the website host's settings, and nowhere a browser can read.
  webAccessSecret: process.env.REASON_WEB_ACCESS_SECRET || "",
  // How many new numbers the website may put in the queue in a day. Past it the form is told the
  // list is full for today, so a flood cannot fill the table with rows nobody will ever read.
  webAccessPerDay: Number(process.env.REASON_WEB_ACCESS_PER_DAY ?? 30),
  // How long before a number still waiting is told, once, that it is still waiting.
  waitingGapMin: Number(process.env.REASON_WAITING_GAP_MIN ?? 6 * 60),
  // How long the master has to answer one access request before it goes stale.
  accessWindowMin: Number(process.env.REASON_ACCESS_WINDOW_MIN ?? 7 * 24 * 60),
  // The operator's own numbers, for testing over a real channel on the subscription backend. On
  // REASON_BACKEND=claude-cli these are the ONLY numbers that get answers; everybody else gets one
  // "not available yet" line and no model turn. Ignored on the API backend and when autoAdmit is on.
  testNumbers: (process.env.REASON_TEST_NUMBERS || "").split(",").map(s => s.trim()).filter(Boolean),
  // When true, anyone who texts the number gets their own Reason instantly — no master approval.
  // For when every number that has the line was given it by the owner personally.
  autoAdmit: process.env.REASON_AUTO_ADMIT === "1",
  // Auto-admit's ceiling (owner, 2026-11-09; 30 → 25 on 2026-11-10): at most this many people who came in on their own (not by
  // invite or event) get an account in any rolling hour. Past it a new number gets one text pointing at
  // the access list (`accessListUrl`) and joins the approval queue (src/access.js). 0 = no ceiling.
  signupsPerHour: Number(process.env.REASON_SIGNUPS_PER_HOUR ?? 25),
  accessListUrl: /^https?:\/\/[^\s"'<>]+$/.test(process.env.REASON_ACCESS_LIST_URL || "") ? process.env.REASON_ACCESS_LIST_URL : "https://heyreason.com/access",
  // The first-chat onboarding (src/onboarding.js): on | test | off, ON by default since 2026-11-06
  // (name → what Reason is → what to save it as → the card under that name). Only a person whose
  // account a text of theirs, or an event join, just made ever starts it; every existing account is
  // exempt (src/db.js). "test": only the numbers in REASON_ONBOARDING_NUMBERS (comma list). "off"
  // (or 0/false/no) turns it off. The owner's own number never gets it.
  onboarding: (v => ["0", "false", "off", "no"].includes(v) ? "off" : v === "test" ? "test" : "on")(String(process.env.REASON_ONBOARDING ?? "").trim().toLowerCase()),
  onboardingNumbers: (process.env.REASON_ONBOARDING_NUMBERS || "").split(",").map(s => s.trim()).filter(Boolean),
  // The pause between two of its bubbles (plus up to 600 ms of jitter, so it reads like typing).
  onboardingGapMs: Number(process.env.REASON_ONBOARDING_GAP_MS ?? 1100),
  // Between one welcome card and the next (src/welcome.js): short, so iMessage stacks them.
  onboardingCardGapMs: Number(process.env.REASON_WELCOME_CARD_GAP_MS ?? 250),
  // The one nudge for somebody who went quiet mid-flow, this long after the last step (never at night).
  onboardingNudgeMin: Number(process.env.REASON_ONBOARDING_NUDGE_MIN ?? 240),
  // A flow nobody has answered for this many days is over ('complete'): a late "ok" is not a step's answer.
  onboardingIdleDays: Number(process.env.REASON_ONBOARDING_IDLE_DAYS ?? 7),
  // Per person, per day. 0 means uncapped. These exist so one person cannot run up the bill.
  maxTurnsPerDay: Number(process.env.REASON_MAX_TURNS_PER_DAY ?? 120),
  maxProactivePerDay: Number(process.env.REASON_MAX_PROACTIVE_PER_DAY ?? 8),
  // Phone calls are the expensive one. A turn costs model tokens; a call costs a per-minute rate on
  // somebody's telephony bill for as long as a stranger keeps talking — Bland's own published rate
  // is $0.14 a connected minute (bland.ai/pricing, read 2026-10-05), so 30 minutes is about $4.20
  // of one person's day. Both are counted in the usage table like the other two, so a restart does
  // not reset them, and 0 means uncapped.
  //
  // The minute cap is counted from calls that have FINISHED, because a call's real length is not
  // known until it ends. So the last call of the day may run over the cap by up to
  // REASON_CALL_MAX_MINUTES; the cap stops the next one. Reserving the maximum up front instead
  // would refuse calls that were never going to cost that much, which is the worse of the two.
  maxCallsPerDay: Number(process.env.REASON_MAX_CALLS_PER_DAY ?? 10),
  maxCallMinutesPerDay: Number(process.env.REASON_MAX_CALL_MINUTES_PER_DAY ?? 30),
  // Who the two daily call caps above skip. "operator" (default): the operator's own account has no
  // daily call count or minute limit. "none": everyone, the operator included, is capped.
  callCapsExempt: (process.env.REASON_CALL_CAPS_EXEMPT || "operator").trim().toLowerCase(),
  // How long before a number that is not invited is told again. Once a day, so being turned away
  // does not turn into Reason texting somebody repeatedly.
  turnedAwayGapMin: Number(process.env.REASON_TURNED_AWAY_GAP_MIN ?? 24 * 60),

  // ---------- handing work to the assistant sessions on this machine (src/remote.js) ----------
  //
  // OFF unless REASON_REMOTE_BUILD is explicitly switched on, and that is not a style choice: this
  // is the one feature that lets a text message run a program on the computer Reason is installed
  // on. Somebody who clones this repo and texts their own number must not get a remote control for
  // their laptop because a default was convenient. With it off there is no such tool, the master
  // cannot see one, and src/tools.js still refuses coding outright the way it always has.
  //
  // Even on, it is the MASTER's alone. That is enforced in src/tools.js from the conversation the
  // call arrived on, never from anything the model believes about who is talking.
  remoteBuild: ["1", "true", "on", "yes"].includes(String(process.env.REASON_REMOTE_BUILD ?? "").trim().toLowerCase()),
  // Invites for everybody. OFF by default — a dark launch: with it off only the master is given the
  // invite tools (so he can try it with one real friend), nobody else's model is told invites exist,
  // and the links he mints still open, claim and tell him who joined. Allowances are backfilled
  // either way, invisibly. Switching it on shows the same tools to everybody with no code change.
  invitesOpen: ["1", "true", "on", "yes"].includes(String(process.env.REASON_INVITES_OPEN ?? "").trim().toLowerCase()),
  // Booking flights (src/flightbook.js): off | owner | on, OFF by default and off on live. The route is
  // Crossmint's Agent Checkouts on the airline's own site (src/flightcheckout.js), so it also needs the
  // shopping path on for that person (REASON_SHOP_CONNECT). Off, nobody's model is told booking exists
  // and a flight search hands over the Google Flights link alone. `owner` is the owner's own
  // conversation only (the first real booking is theirs); 1/true/on/yes is everyone.
  flightBooking: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_FLIGHT_BOOKING ?? "").trim().toLowerCase()),
  // Events (src/events.js). `owner`: only the owner may make one; 1/true/on/yes: anybody with a
  // Reason; anything else: off, and nobody's model is told events exist. Joining is open to anybody
  // whenever this is not off — an owner's event link must work for every guest.
  events: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_EVENTS ?? "").trim().toLowerCase()),
  // Carpooling between an event's guests (src/eventrides.js, spec v3 §13). On top of events, and off by
  // default per event besides: the organizer turns it on for theirs. `owner`: only events the owner
  // organizes may turn it on; 1/true/on/yes: any organizer's; anything else: off, and no model is
  // told rides exist.
  eventRides: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_EVENT_RIDES ?? "").trim().toLowerCase()),
  // Paid events (src/eventpay.js): who may put a price on an event they organize. `owner`: the owner's
  // events only; 1/true/on/yes: any organizer's; anything else: off. An event already priced stays priced.
  paidEvents: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_PAID_EVENTS ?? "").trim().toLowerCase()),
  // People who iMessage from an Apple ID email rather than a phone number (normalizeHandle). On by
  // default: such a person is new to Reason, so there is no owner-only form of this. Off (0/false/
  // off/no) drops them at the webhook as before 2026-11-11, with the reason in the journal this time.
  emailHandles: !["0", "false", "off", "no"].includes(String(process.env.REASON_EMAIL_HANDLES ?? "").trim().toLowerCase()),
  // One private photo album per event (src/albums.js). On top of events. `owner`: only events the
  // owner organizes have one; 1/true/on/yes: every event's; anything else: off, and no model is told
  // albums exist. Nothing stored under off is touched: the sweep still closes an album at its expiry.
  eventAlbums: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_EVENT_ALBUMS ?? "").trim().toLowerCase()),
  // Reason Web (src/web.js, docs/plans/reason-web-phase1.md): the same Reason in a browser. `owner`:
  // only the owner's conversation may be reached from the web channel; 1/true/on/yes: anybody with a
  // Reason; anything else: OFF — the web channel is not registered, a web inbound is refused before
  // admission, nothing is written to the per-message history, and no tool list changes. Off is the
  // default and is what live runs until the owner says otherwise (§7 decision 10).
  // Who Reason says it is, and who the person is, said straight away on a call (src/calls/voice-prompt.js
  // ownCallIdentity / thirdPartyIdentity; GPT-Live's owner block). "owner" = the operator's calls only,
  // "on" = everyone; unset = every call's prompt exactly as before 2026-10-31.
  callIdentity: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_CALL_IDENTITY ?? "").trim().toLowerCase()),
  // Who made Reason, as every Reason says it, in texts and on calls (src/maker.js): the company.
  makerName: String(process.env.REASON_MAKER ?? "").trim() || "Saafi Interactions Lab",
  // The iPhone app's JSON API (src/ios/, docs/ios-api.md). off (default) | owner | on.
  iosApi: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_IOS_API ?? "").trim().toLowerCase()),
  web: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_WEB ?? "").trim().toLowerCase()),
  // Pages Reason makes, v2 (handoff 2026-10-27 P1–P6, E2–E4, link previews; src/pages/made.js). HELD
  // for the owner: off, every page, event and album draws exactly as before. "1" turns it on.
  pagesV2: ["1", "true", "on", "yes"].includes(String(process.env.REASON_PAGES_V2 ?? "").trim().toLowerCase()),
  // The walking directions page (src/pages/directions.js; handoff PROMPT.md). OFF: every /d/ path answers
  // nothing. REASON_DIRECTIONS_SAMPLE also serves the made-up sample trip. REASON_DIRECTIONS_ROUTING_URL is an
  // OSRM-compatible foot router; the reroute calls it from the server, so no routing key reaches the page.
  // "owner": only the owner's conversation is told about the `directions` tool and only the owner's trips open.
  // The router defaults to FOSSGIS's free, keyless OSRM foot profile (OpenStreetMap's own website uses it).
  directionsOn: (v => v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v))(String(process.env.REASON_DIRECTIONS ?? "").trim().toLowerCase()),
  directionsSample: ["1", "true", "on", "yes"].includes(String(process.env.REASON_DIRECTIONS_SAMPLE ?? "").trim().toLowerCase()),
  directionsRouting: String(process.env.REASON_DIRECTIONS_ROUTING_URL ?? "https://routing.openstreetmap.de/routed-foot").trim(),
  // Where Reason Web's live stream is heard from (src/web.js webStreamOrigin). The website's proxy
  // holds a stream back until it ends, so the page listens on the pages host instead, which reaches
  // Reason directly. Unset: on, when the pages host sits under the website's domain (the session
  // cookie is already shared there); "off": the page's own /web/stream and the 4 s poll; an https
  // origin: that one.
  webStream: String(process.env.REASON_WEB_STREAM ?? "").trim(),
  // How long an album's photos are kept after the organizer releases it (spec: three days). The ONE
  // retention setting — every expiry, every line that names it, reads this (src/albums.js RETENTION).
  albumRetentionDays: Number(process.env.REASON_ALBUM_RETENTION_DAYS || 3),
  // The small model that reads one e-ticket email for its ticket numbers (src/ticketcheck.js).
  // How old a flight's fresh quote (the Fli re-check plus AgentCard's cart) may be when the yes is
  // turned into a confirm. Past it the quote is taken again and shown again; fares move by the minute.
  flightQuoteMaxAgeMs: Number(process.env.REASON_FLIGHT_QUOTE_MAX_AGE_MS || 15 * 60_000),
  // The command that reaches the assistant, and which of its agents to hand work to. A path and an
  // id and nothing else: both are checked against a strict pattern before they are written into the
  // runner script, so neither can carry anything a shell would act on.
  openclawBin: process.env.REASON_OPENCLAW_BIN || "openclaw",
  openclawAgent: process.env.REASON_OPENCLAW_AGENT || "main",
  // How long one handed-over turn may run before it is abandoned. An hour, because a build is not a
  // web request; the assistant's own default is ten minutes, which is not enough for real work.
  remoteTurnTimeoutS: Number(process.env.REASON_REMOTE_TURN_TIMEOUT_S || 3600),
  turnWallClockS: Number(process.env.REASON_TURN_WALL_CLOCK_S || 300),
  // The quiet window on unprompted texts about a job. Progress chatter inside it updates the page
  // and sends nothing; something finishing, breaking, or needing an answer always goes straight
  // out, because those are the three things that are useless late.
  remoteTextGapMin: Number(process.env.REASON_REMOTE_TEXT_GAP_MIN ?? 5),
  // How many handed-over jobs may be unfinished at once. A ceiling rather than a queue: the honest
  // answer to "start six more things" is that there are already this many in flight.
  remoteMaxLive: Number(process.env.REASON_REMOTE_MAX_LIVE ?? 6),
  // One directory per job: the brief that was handed over, the runner, what came back, and the
  // file the assistant writes its progress into. Under the data dir with everything else, so a
  // deployment that mounts one volume keeps a build across a restart without being told to.
  remoteRoot: process.env.REASON_REMOTE_ROOT || `${DATA_DIR}/remote`,
  // Mark a conversation read the moment Reason really takes the message. On by default, because a
  // text that is being worked on looks exactly like a text that fell into a hole, and this costs
  // one request and no model time. REASON_READ_RECEIPTS=off turns it off for anybody who would
  // rather not tell people when their message was seen.
  readReceipts: process.env.REASON_READ_RECEIPTS !== "off",
  // The "…" bubble while a turn runs. Asked for in 30-second chunks and renewed at 80% of each,
  // rather than once for as long as a turn might take: Sendblue's own default is 60 seconds and its
  // ceiling is five minutes, and a short chunk means a process that dies mid-turn leaves a bubble
  // that clears itself in half a minute instead of one that sits on somebody's phone. The ceiling
  // is when to stop claiming to be typing at all — a turn still going after five minutes has
  // something wrong with it, and saying "still typing" about it would be a lie with a timer on it.
  typingChunkMs: Number(process.env.REASON_TYPING_CHUNK_MS || 30_000),
  typingMaxMs: Number(process.env.REASON_TYPING_MAX_MS || 300_000),
  // Two texts sent seconds apart are one thought, so an arriving message waits a moment to see
  // whether more of it is coming, and everything that landed runs as ONE turn.
  //
  // 2.5 seconds is how long it takes to paste a link after typing a line about it, which is the
  // failure this exists for: Reason answered "which ones? looks like the rest of your message got
  // cut off" to a message whose second half arrived a second later. The hard cap is what stops
  // somebody who types continuously from never getting an answer — past it the turn runs whether
  // or not they have stopped. Set the quiet window to 0 to turn holding off entirely; a message
  // then runs the moment it arrives, which is what every test that is not about bursts does.
  // How long a channel webhook waits for its turn before answering the provider anyway (src/http.js).
  // Past the burst window on purpose is not needed: bad deliveries fail in milliseconds.
  webhookAnswerMs: Number(process.env.REASON_WEBHOOK_ANSWER_MS ?? 5_000),
  //
  // 4 seconds from 2026-10-24 to 2026-10-28 (was 2.5): "No I want to watch when I leave work so
  // somewhere around work" and "And I'd watch it on Tuesday" were one thought sent as two bubbles
  // and got two conflicting answers. Most of that fix is the mid-turn fold-in (src/onethought.js),
  // which catches a bubble however late it lands while the answer is still being worked on; the
  // wider window only catches more of them before any work starts, at 1.5s more on a lone text.
  //
  // Back to 2.5 seconds on 2026-10-28 (owner, after the speed audit of 10-27): in 48 h of live
  // traffic the 4 s window was the single largest fixed cost on every message and caught one
  // two-bubble burst — whose bubbles were 30 s apart, outside any window. Ten texts joined a wait;
  // ~200 paid the 4 s. A bubble that lands after the window still folds into the turn.
  burstQuietMs: Number(process.env.REASON_BURST_QUIET_MS ?? 2_500),
  // Reason Web sends one whole message at a time — the composer posts the words and any files
  // together, and "take it back" (Router.takeBack) works before the hold and mid-turn, not only
  // inside the window — so a Web message waits only half a second for a second one. Never longer
  // than the text window: REASON_BURST_QUIET_MS=0 still turns holding off everywhere.
  burstQuietWebMs: Number(process.env.REASON_BURST_QUIET_WEB_MS ?? 500),
  burstMaxMs: Number(process.env.REASON_BURST_MAX_MS ?? 10_000),
  // A text that lands while a request is being worked on is read — continuation, new request, or
  // chat — by one small side call (src/onethought.js), on the subscription through the CLI, never
  // the paid API. It runs alongside the turn, never in front of a reply.
  midTurnCliModel: process.env.REASON_MIDTURN_CLI_MODEL || "haiku",
  midTurnCliTimeoutMs: Number(process.env.REASON_MIDTURN_CLI_TIMEOUT_MS || 12_000),
  // What a sent reply asserted and asked, written down after it goes (src/said.js). Off with 0.
  saidLedger: process.env.REASON_SAID_LEDGER !== "0",
  // The send-time check of a draft against what was already said, on the subscription. It sits in
  // front of a reply, so its CLI is started when the turn starts (said.warmCheck) and a check that
  // runs past this is skipped, never waited out.
  saidCheckCliModel: process.env.REASON_SAID_CHECK_CLI_MODEL || "haiku",
  saidCheckCliTimeoutMs: Number(process.env.REASON_SAID_CHECK_CLI_TIMEOUT_MS || 8_000),
  // The same check also reads whether the reply says something is done, started, sent or made that no
  // tool did this turn, or names a link it does not carry (src/said.js). "acting" (the default): only a
  // reply of a turn that called a tool which acts on the world or makes something (src/tools.js
  // lapsedBlocked) — a plain chat reply never waits ~2 s for it. "all": every reply. "0": off.
  claimCheck: (v => ["0", "off", "false", "no"].includes(v) ? false : v === "all" ? "all" : "acting")(String(process.env.REASON_CLAIM_CHECK ?? "").trim().toLowerCase()),
  // A picture somebody sends is fetched and handed to the model as a picture (src/media.js).
  //
  // The ceiling is Anthropic's, converted: "the maximum size per image is 10 MB (base64-encoded)"
  // and base64 is four bytes per three, so 7 MB of real bytes is under it with room for the rest
  // of the request. A photo over it is refused in words rather than by a 400 from the API.
  imageMaxBytes: Number(process.env.REASON_IMAGE_MAX_BYTES || 7 * 1024 * 1024),
  // A HEIC — what an iPhone shoots by default, and not a format the model reads — is converted to
  // JPEG on this machine before anything looks at it (src/pictures.js), with /usr/bin/sips, which
  // every Mac already has. The file exists only for the length of the conversion and is removed
  // either way; it is under the data dir for the same reason the audio scratch is.
  imageTmpRoot: process.env.REASON_IMAGE_TMP || `${DATA_DIR}/image-tmp`,
  imageConvertTimeoutMs: Number(process.env.REASON_IMAGE_CONVERT_TIMEOUT_MS || 30_000),
  // Reason's own voice (src/voice.js): which speech model says it, and in which of its voices.
  ttsModel: process.env.REASON_TTS_MODEL || "gemini-3.8-flash-tts",
  ttsVoice: process.env.REASON_TTS_VOICE || "Puck",
  ttsTimeoutMs: Number(process.env.REASON_TTS_TIMEOUT_MS || 60_000),
  // One identity (src/identity.js): the name they gave their Reason is used on every surface, and a
  // texted voice note is spoken in the voice their calls use. off (default) | owner | on.
  oneIdentity: (v => (v === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(v) ? "on" : "off"))(String(process.env.REASON_ONE_IDENTITY ?? "").trim().toLowerCase()),
  // The Gemini voice closest to the call voice, for a voice note when OpenAI's speech cannot make it
  // (one identity only). Chosen by ear against "marin": a light, easy-going woman's voice.
  ttsCloseVoice: process.env.REASON_TTS_CLOSE_VOICE || "Aoede",
  // How long a voice note has to be before the transcript keeps timestamps. Under it, a note is a
  // sentence or two and [0:00] markers are noise in the middle of what should read as their own
  // message; over it, "where did they say that" is a real question somebody might want checked.
  voiceTimestampAfterSec: Number(process.env.REASON_VOICE_TIMESTAMP_AFTER_SEC || 30),
  // A voice note this short (seconds of audio) is told to the model as short: a phone can start
  // recording after the first words, so a 3-second note can be the tail of what was meant
  // (2026-11-01: a 3.3 s note held only "around like 7:30 p.m." and was taken as a call time).
  voiceShortSec: Number(process.env.REASON_VOICE_SHORT_SEC || 5),
  // Listening to a voice note somebody sent: download, convert, transcribe.
  // Who listens when the usual model is busy. A voice note is a few seconds of one person talking,
  // which the small model transcribes as well as the big one — and a busy 503 is common enough on
  // a free key that "couldn't hear that" would otherwise be a regular answer.
  // How long a sign-in window Reason opened may sit there before it is closed. While it is open
  // that person's saved profile belongs to the window, so their errands cannot use the browser.
  // Signing in from a phone (src/signin-remote.js): how long an unopened link is good for, how long
  // a started session may run, and how long the page is given to react to a tap before the next
  // picture. While a session runs, that person's saved profile belongs to it.
  remoteSigninLinkTtlMs: Number(process.env.REASON_SIGNIN_LINK_TTL_MS || 10 * 60_000),
  remoteSigninSessionMs: Number(process.env.REASON_SIGNIN_SESSION_MS || 10 * 60_000),
  remoteSigninSettleMs: Number(process.env.REASON_SIGNIN_SETTLE_MS || 250),
  // How long a site's sign-in page is given to draw its form before anything concludes it has none
  // (src/signinpage.js). Stripe Link's email box appears 1.3 s after the page loads; the one read at
  // 1.1 s on 2026-11-12 called that "no email box". Polled, and it stops the moment the form is there.
  signinFormWaitMs: Number(process.env.REASON_SIGNIN_FORM_WAIT_MS || 10_000),
  signinWindowMaxMs: Number(process.env.REASON_SIGNIN_WINDOW_MAX_MS || 15 * 60_000),
  // Voice notes have their own model order, apart from videos (videoModel): the small model listens
  // first and the big one is the fallback. Owner's call 2026-11-09: gemini-3.8-flash kept answering
  // 503 "high demand" or hanging, and every voice note waited it out before the small one was asked.
  hearModel: process.env.REASON_HEAR_MODEL || "gemini-3.5-flash-lite",
  hearFallbackModel: process.env.REASON_HEAR_FALLBACK_MODEL || "gemini-3.8-flash",
  // The longest one listening attempt may take (a long memo). A short note gets far less: see
  // hearAttemptMs in src/voice.js.
  hearTimeoutMs: Number(process.env.REASON_HEAR_TIMEOUT_MS || 60_000),
  imageFetchTimeoutMs: Number(process.env.REASON_IMAGE_FETCH_TIMEOUT_MS || 20_000),
  // The outbox. Every outbound message on a real channel is a row before it is an attempt, so a
  // reply that fails to send comes back instead of being logged and dropped.
  //
  // Five attempts over roughly ten minutes (5s, 10s, 20s, 40s, 80s) is sized for what is actually
  // worth retrying: a dropped socket, a 5xx, a rate-limit window. Past that the message is dead and
  // somebody is told, which is more use than a row retrying all afternoon. A refusal that cannot
  // succeed later is never retried at all, whatever these say.
  outboxMaxAttempts: Number(process.env.REASON_OUTBOX_MAX_ATTEMPTS || 5),
  outboxBackoffMs: Number(process.env.REASON_OUTBOX_BACKOFF_MS || 5_000),
  outboxBackoffMaxMs: Number(process.env.REASON_OUTBOX_BACKOFF_MAX_MS || 300_000),
  // How many bubbles one message Reason sends is allowed to become (src/plain.js). Four, because a
  // link needs a bubble of its own and so does anything meant to be pasted, so three pieces plus a
  // line about them is the most an answer legitimately comes to; past that it is a thread of
  // fragments and belongs on a page. Overflow is merged, never dropped.
  maxBubbles: Number(process.env.REASON_MAX_BUBBLES || 4),
  // The undo window: how long anything Reason does on somebody's behalf waits before it really
  // happens (src/undo.js). Thirty seconds is long enough to catch "wait, wrong person" and short
  // enough that nobody notices it on the things they meant. A person can set their own, 0 to 300,
  // and 0 really does mean nothing is ever held. Replies to the person themselves are never held
  // at any setting, so the conversation does not get slower.
  undoWindowSeconds: Number(process.env.REASON_UNDO_SECONDS ?? 30),
  undoWindowMaxSeconds: Number(process.env.REASON_UNDO_MAX_SECONDS || 300),
  // Channels. `sendblue` is the iMessage/SMS/RCS adapter Reason texts over; `linq` is the earlier
  // one, kept in the repo and still registered, so an install with a Linq key in .env is not
  // broken by the switch. Each is only live with its own credentials, and an install can run
  // neither, either or both.
  channel: process.env.REASON_CHANNEL || "console",
  // Sendblue. The two key names match the two headers every request needs — sb-api-key-id and
  // sb-api-secret-key (docs.sendblue.com/getting-started/credentials). Sendblue's own Chat SDK
  // adapter calls them SENDBLUE_API_KEY / SENDBLUE_API_SECRET, so those are read as aliases: an
  // account set up by their CLI or their adapter should not need its .env rewritten.
  sendblueKeyId: process.env.SENDBLUE_API_KEY_ID || process.env.SENDBLUE_API_KEY || "",
  sendblueSecretKey: process.env.SENDBLUE_API_SECRET_KEY || process.env.SENDBLUE_API_SECRET || "",
  // Required on every send: "The from_number parameter is required when sending messages."
  sendblueFrom: process.env.SENDBLUE_FROM_NUMBER || "",
  sendblueWebhookSecret: process.env.SENDBLUE_WEBHOOK_SECRET || "",
  // The header Sendblue returns the webhook secret in. Their docs never name it; their Chat SDK
  // adapter defaults to sb-signing-secret and lets you override it, so this does the same.
  sendblueWebhookSecretHeader: process.env.SENDBLUE_WEBHOOK_SECRET_HEADER || "sb-signing-secret",
  sendblueBase: process.env.SENDBLUE_API_BASE || "https://api.sendblue.com",
  linqKey: process.env.LINQ_API_KEY || "",
  linqWebhookSecret: process.env.LINQ_WEBHOOK_SECRET || "",
  linqFrom: process.env.LINQ_FROM_NUMBER || "",
  linqBase: process.env.LINQ_API_BASE || "https://api.linqapp.com/api/partner",
  // Phone calls. `gptlive` is Reason's own voice on a Twilio number (src/calls/gptlive.js), live with
  // the TWILIO_* keys, OPENAI_API_KEY and REASON_PUBLIC_URL; `bland` (src/calls/bland.js) needs a
  // BLAND_API_KEY; `fake` dials nothing and is the default.
  callProvider: process.env.REASON_CALL_PROVIDER || "fake",
  callMaxMinutes: Number(process.env.REASON_CALL_MAX_MINUTES || 10),
  // The longest a call can really run, in seconds: a GPT-Live call is ended at this (`connect` in
  // src/calls/gptlive.js), so `callMaxMinutes` is not a promise about when a call ends, and the
  // lost-call sweep waits on this.
  callPlatformCapSeconds: Number(process.env.REASON_CALL_PLATFORM_CAP_SECONDS || 3600),
  // Bland. One key, sent as `authorization: Bearer <key>` on every request
  // (docs.bland.ai/api-v1/post/calls, read 2026-10-05).
  blandKey: process.env.BLAND_API_KEY || "",
  blandBase: (process.env.BLAND_API_BASE || "https://api.bland.ai").replace(/\/+$/, ""),
  // Optional. "By default, calls are initiated from a separate pool of numbers owned by Bland", so
  // an install with no number of its own still works; a number here must be one the account owns.
  blandFrom: process.env.BLAND_FROM_NUMBER || "",
  // Bland signs its webhooks: HMAC-SHA256 of the body, hex, in the X-Webhook-Signature header
  // (docs.bland.ai/tutorials/webhook-signing). The secret is made by hand in their dashboard, so an
  // account can have none — with this empty the call-finished webhook is accepted on the strength
  // of the unguessable per-call token in its URL alone, and docs/unverified.md says so out loud.
  blandWebhookSecret: process.env.BLAND_WEBHOOK_SECRET || "",
  blandTimeoutMs: Number(process.env.BLAND_TIMEOUT_MS || 20_000),
  // GPT-Live in front of another provider (src/calls/gptlive.js `withGptLive`): REASON_CALL_VOICE=gptlive
  // (or on) for every account's own calls, =owner for the operator's only. With REASON_CALL_PROVIDER=gptlive
  // every call is GPT-Live already and this changes nothing.
  callVoice: String(process.env.REASON_CALL_VOICE ?? "").trim().toLowerCase(),
  // The Cartesia voice on the operator's own calls (src/calls/cartesia.js, docs/calls-cartesia.md section 5):
  // off | owner | on; unset or anything else is off. owner by itself changes nothing: it offers the operator
  // the call_voice_trial tool, and his own choice (accounts.call_trial) turns it on. on: every account's own
  // calls with Reason use it, with no per-person choice (nobody is shown the tool); GPT-Live only as the
  // automatic fall-back. Calls to anyone else never do, in any mode (src/calls/calltrial.js). Before
  // setting on: section 5's list.
  callCartesia: (v => (v === "owner" || v === "on" ? v : "off"))(String(process.env.REASON_CALL_CARTESIA ?? "").trim().toLowerCase()),
  cartesiaKey: process.env.CARTESIA_API_KEY || "",
  // The agent made once by scripts/cartesia-agent-setup.mjs; the voice is set on it (Gemma, en-GB).
  cartesiaAgentId: String(process.env.REASON_CARTESIA_AGENT_ID ?? "").trim(),
  cartesiaVoice: String(process.env.REASON_CARTESIA_VOICE ?? "").trim() || "62ae83ad-4f6a-430b-af41-a9bede9286ca",
  // Inline Sonic emotion tags (<emotion value="calm"/>) in the agent's replies: off until heard on a real
  // call. Cartesia calls them beta and unreliable on voices not tagged Emotive (Gemma is a "stable" voice).
  cartesiaEmotionTags: String(process.env.REASON_CARTESIA_EMOTION_TAGS ?? "").trim().toLowerCase() === "on",
  // Soft music under the call while an ask_reason lookup runs (src/calls/lookupmusic.js): off (unset) or
  // on (or a variant's name); a file of his own choosing replaces the synthesized music; a level multiplier.
  cartesiaLookupMusic: String(process.env.REASON_CARTESIA_LOOKUP_MUSIC ?? "").trim().toLowerCase(),
  cartesiaLookupMusicFile: String(process.env.REASON_CARTESIA_LOOKUP_MUSIC_FILE ?? "").trim(),
  cartesiaLookupMusicGain: String(process.env.REASON_CARTESIA_LOOKUP_MUSIC_GAIN ?? "").trim(),
  // How Reason sounds on calls (Omari's call voice spec 11-11, src/calls/manner.js): owner | on | off (unset = off).
  callManner: (v => (v === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(v) ? "on" : "off"))(String(process.env.REASON_CALL_MANNER ?? "").trim().toLowerCase()),
  // What a call carries into the next call and the text after it (call audit 11-11, src/calls/carryover.js): owner | on | off (unset = off).
  callCarryover: (v => (v === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(v) ? "on" : "off"))(String(process.env.REASON_CALL_CARRYOVER ?? "").trim().toLowerCase()),
  // The nightly memory review (src/dream.js) reads what they said on their own phone calls, cited
  // like their texts: off (default) | owner | on.
  reviewCalls: (v => (v === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(v) ? "on" : "off"))(String(process.env.REASON_REVIEW_CALLS ?? "").trim().toLowerCase()),
  // Things that recur in what they said across days (repeated asks, routines, Reason's repeated
  // mistakes, preferences), kept as guesses with the messages they rest on (src/dream.js
  // noticePatterns): off (default) | owner | on. "on" still needs their own yes to patterns.
  reviewPatterns: (v => (v === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(v) ? "on" : "off"))(String(process.env.REASON_REVIEW_PATTERNS ?? "").trim().toLowerCase()),
  // The turn gate (src/calls/turngate.js, Omari 11-12): on their own call a short acknowledgement in a
  // mid-thought pause and a prompt real answer to a finished thought, told apart by GPT-Live's native
  // Decisions trigger on their transcript: owner | on | off (unset = off).
  callTurnGate: (v => (v === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(v) ? "on" : "off"))(String(process.env.REASON_CALL_TURN_GATE ?? "").trim().toLowerCase()),
  // Calls Reason makes to businesses and other people, and places ringing back about them, on GPT-Live
  // too (phase 3, 2026-10-31): =gptlive (or on) for everyone's errands, =owner for the operator's only.
  // Unset, those calls are the provider's.
  thirdPartyVoice: String(process.env.REASON_THIRD_PARTY_VOICE ?? "").trim().toLowerCase(),
  // A quiet café (own calls) or office (errands) under Reason's GPT-Live voice: owner | on | off (unset = off).
  callAmbience: String(process.env.REASON_CALL_AMBIENCE ?? "").trim().toLowerCase(),
  // That room's level (calls/ambience.js ambienceGain): a number 0–0.2; unset = the default (0.01875 since call 77).
  callAmbienceGain: String(process.env.REASON_CALL_AMBIENCE_GAIN ?? "").trim(),
  // Their side of a GPT-Live call evened out before the voice hears it (src/calls/hearing.js, call 76):
  // quiet speech lifted, silence and line noise left alone, peaks limited. "on" (default) / "off".
  callHearing: String(process.env.REASON_CALL_HEARING ?? "on").trim().toLowerCase() !== "off",
  // How a GPT-Live third-party call talks once a person answers (2026-10-31, call 59): "on" (default)
  // = the voice talks with them itself, like an own call, and hands decisions to Reason; "off" = the
  // older puppet line, where every reply waits on a Reason turn (4–8 s a reply on call 59).
  lineTalk: String(process.env.REASON_LINE_TALK ?? "on").trim().toLowerCase() !== "off",
  // A call Reason places to somebody else opens with a short pre-made clip in its own voice the moment
  // the line is answered (src/calls/opener.js), while the live voice connects: "on" (default) / "off".
  pickupOpener: String(process.env.REASON_PICKUP_OPENER ?? "on").trim().toLowerCase() !== "off",
  // The speech model that makes that clip (OpenAI TTS; the same voice name as the live voice).
  openerTtsModel: process.env.REASON_OPENER_TTS_MODEL || "gpt-4o-mini-tts",
  gptliveModel: process.env.REASON_GPTLIVE_MODEL || "gpt-live-1",
  // The voice (a young adult British woman was the owner's pick): Marin, with the accent
  // asked for in the live prompt. There is no British built-in voice.
  gptliveVoice: process.env.REASON_GPTLIVE_VOICE || "marin",
  // An own call's GPT-Live session opened while the phone rings, with the call's own session.start
  // (instructions, voice, brief, greeting), and HELD — no audio, nothing said — until the stream starts
  // (gptlive.js `WarmSession` hold). Not calls 54–55's warm-up: nothing is spoken before pickup.
  // "on" / "off" (default off).
  // "owner": the operator's own calls only (like the repo's other =owner flags).
  gptlivePrering: (v => v === "owner" ? "owner" : v === "on")(String(process.env.REASON_GPTLIVE_PRERING ?? "off").trim().toLowerCase()),
  // When the held session's greeting is asked for: "stream" (default; at pickup, as a cold call does) or
  // "early" (appended while it rings; the stopped timeline holds it until the first frames after pickup).
  // "ready": the greeting made while it rings and played the moment their hello ends (or into a quiet line).
  gptlivePreringGreet: (() => { const v = String(process.env.REASON_GPTLIVE_PRERING_GREET ?? "stream").trim().toLowerCase(); return ["early", "ready"].includes(v) ? v : "stream"; })(),
  // How long the dial waits for the held session to start before it rings anyway (0 = never waits).
  gptlivePreringWaitMs: Math.max(0, Math.min(5000, Number(process.env.REASON_GPTLIVE_PRERING_WAIT_MS ?? 2000) || 0)),
  // An inbound own call's session opened from the voice webhook (after the caller is routed), held silent
  // until the stream starts. "on" / "off" (default off).
  // "owner": only when the operator rings in.
  gptliveInboundPreopen: (v => v === "owner" ? "owner" : v === "on")(String(process.env.REASON_GPTLIVE_INBOUND_PREOPEN ?? "off").trim().toLowerCase()),
  // How long the inbound answer (the TwiML) waits for the pre-opened session to be ready (0 = never waits).
  // How long a pre-opened session's start may wait for #406's call-memory read (racing the socket handshake).
  gptlivePreringMemoryMs: Math.max(0, Math.min(2000, Number(process.env.REASON_GPTLIVE_PRERING_MEMORY_MS ?? 800) || 0)),
  gptliveInboundWaitMs: Math.max(0, Math.min(4000, Number(process.env.REASON_GPTLIVE_INBOUND_WAIT_MS ?? 0) || 0)),
  twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioToken: process.env.TWILIO_AUTH_TOKEN || "",
  // Reason's own number, E.164: what every GPT-Live call dials from, the number on Reason's contact
  // card, and what a call GIVES OUT when a busy place offers to ring back (the callback path in
  // src/calls/inbound.js matches an unknown caller against the open calls on that number first).
  twilioFrom: process.env.TWILIO_FROM_NUMBER || "",
  // The voice Twilio itself uses for the one-line refusals on /calls/gptlive/inbound (a blocked
  // number, a day's cap): said and hung up on, no model behind it.
  gptliveSayVoice: process.env.REASON_GPTLIVE_SAY_VOICE || "Polly.Amy-Neural",
  // The spoken second check on an owner call (section 6). Caller ID says WHOSE Reason to answer as;
  // it does not prove who is holding the phone, so anything that spends, books, sends or changes
  // state asks for this first — or, with it empty, texts the owner's own number a yes/no instead.
  // Never put in a prompt, never read back; compared and nothing else.
  callPassphrase: process.env.REASON_CALL_PASSPHRASE || "",
  // Which backend answers a VOICE turn. Empty means the same one every other turn uses, so an
  // install that sets nothing behaves exactly as it does now; REASON_CALL_BACKEND=api pins the API
  // path for calls alone, which is the switch Friday needs — a phone turn cannot wait on a headless
  // CLI start, while the rest of Reason may still be running on the subscription.
  callBackend: process.env.REASON_CALL_BACKEND || "",
  callModel: process.env.REASON_CALL_MODEL || "",
  // How the call model thinks. Left to itself, claude-sonnet-5-5 thinks before every reply, ~3.5s of
  // silence on the line before the first word (call 38, 2026-10-23: 4–6s per turn, ~1.2s without).
  // "between_tools" skips that up-front pass and still thinks after a tool result, which is heard
  // as the "one sec" already playing. Empty sends no thinking field at all — the model's default.
  callThinking: process.env.REASON_CALL_THINKING ?? "between_tools",
  // How many turns of the person's own thread a voice turn is handed. Short on purpose: a phone
  // turn pays for every token in first-word latency, and what the call needs is the recent shape of
  // the conversation rather than the whole of it.
  callHistoryTurns: Number(process.env.REASON_CALL_HISTORY_TURNS || 12),
  // Reason's call prompt loaded into the model's cache while the phone rings, so the first answer is
  // warm (call 79: 4.3 s first answer vs ~2.3 s after). REASON_CALL_CACHE_WARM=off stops it.
  callCacheWarm: String(process.env.REASON_CALL_CACHE_WARM ?? "on").trim().toLowerCase() !== "off",

  // ---------- what a real call is like, and the numbers the owner has NOT decided ----------
  //
  // Every value in this block is a DEFAULT, and the owner said so explicitly on 2026-10-06: max hold
  // time, how many inquiry calls may run at once, retry limits, quiet hours, which languages, and
  // budget were all listed as open decisions he has not made. So none of them is presented as a
  // finding, each is one line in .env, and none is presented as more than a default. If one of these numbers turns out to be wrong it is a
  // setting someone changed their mind about, not a bug.

  // How long a call may sit on hold before it rings off politely. Five minutes: long enough for an
  // ordinary queue, short enough that a wrong number does not burn ten minutes of per-minute billing.
  // A brief may override it per call, because a clinic at lunchtime is not a shop at 10am.
  //
  // This is OUR clock, deliberately. A voice has no hold detection, and a silence timer may never
  // fire during hold music at all, because hold music is audio.
  callMaxHoldSeconds: Number(process.env.REASON_CALL_MAX_HOLD_SECONDS || 300),

  // How many calls may be live at once for one errand. Three: concurrency bills per minute on every
  // leg, and six simultaneous calls is also six voices that may all need the owner in the same minute.
  // Bookings are ALWAYS one at a time and that is not configurable — see the lock in ./calls/commit.js,
  // because two places both being told yes is the failure this whole area exists to prevent.
  callMaxParallel: Number(process.env.REASON_CALL_MAX_PARALLEL || 3),

  // How many times one number may be tried again for the same goal. One retry, so two attempts total:
  // more than that stops looking like diligence to whoever keeps picking up the phone.
  callMaxRetries: Number(process.env.REASON_CALL_MAX_RETRIES || 1),

  // When Reason may not ring a third party, in the owner's own zone. `21:00-08:00`; empty turns the
  // window off. Their own phone is never silenced by this — it is their assistant, and a call they
  // asked for at midnight is a call they asked for. A call the window blocks is reported to them
  // rather than silently dropped, so "I didn't call because it's half eleven at night" is a thing
  // they hear.
  callQuietHours: process.env.REASON_CALL_QUIET_HOURS ?? "21:00-08:00",
  // Audio of calls with businesses and other people (placed, and ring-backs). OFF by default (Omari
  // 2026-11-12): those calls open like a normal caller, with no "this call may be recorded" line, so no
  // audio of them is kept. =on brings back the notice at the start, the recording, and stopping it when
  // they object (src/calls/manner.js). A person's own calls with Reason are not touched by this.
  thirdPartyRecording: ["1", "true", "on", "yes"].includes(String(process.env.REASON_THIRDPARTY_RECORDING ?? "").trim().toLowerCase()),

  // The languages a call may switch into. What the owner's spec named, and no more. 
  callLanguages: (process.env.REASON_CALL_LANGUAGES || "en,es").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),

  // A spend ceiling for one errand, in cents. Deliberately UNSET: the owner listed budget as an open
  // decision and I did not invent a money number for him. With it empty the existing daily caps
  // (REASON_MAX_CALLS_PER_DAY, REASON_MAX_CALL_MINUTES_PER_DAY) are the only ceiling, which is the
  // behaviour that already exists rather than a new silent limit.
  callMaxErrandCents: process.env.REASON_CALL_MAX_ERRAND_CENTS ? Number(process.env.REASON_CALL_MAX_ERRAND_CENTS) : null,

  // How long the owner is given to answer a mid-call question before the call ends without agreeing
  // to anything. Ninety seconds: somebody is holding a handset. Not on his open list — it is a
  // consequence of his "otherwise the call ends without committing" rather than a choice.
  callOwnerReplySeconds: Number(process.env.REASON_CALL_OWNER_REPLY_SECONDS || 90),
  // Every call is recorded. There is deliberately no switch: the announcement built in
  // src/calls/provider.js always tells the other person the call is recorded, a provider that
  // cannot record cannot be used to place one, and a call that comes back without audio is an
  // error the owner is told about. This is only where the audio Reason owns is kept.
  recordingRoot: process.env.REASON_RECORDING_ROOT || `${DATA_DIR}/recordings`,
  // Reason Web's playable copies of voice notes and call recordings a browser cannot play as they
  // are (a .caf): AAC in .m4a, made once and kept by the bytes' own hash (src/webaudio.js).
  webAudioRoot: process.env.REASON_WEB_AUDIO_ROOT || `${DATA_DIR}/web-audio`,
  // Real documents Reason wrote: a .docx, a .pptx, a .pdf. Under the data dir with everything else,
  // because a document is a file somebody was sent and "the export carries it" and "a delete
  // removes it" both have to mean the same file on disk — the same bargain the recordings are in.
  documentRoot: process.env.REASON_DOCUMENT_ROOT || `${DATA_DIR}/documents`,
  // Video. Two tiers, and a result that always says which one answered.
  //
  // The transcript tier is yt-dlp reading a video's metadata and captions — no key, and no video or
  // audio ever downloaded. REASON_YTDLP_BIN names the binary when it is not on the PATH; with
  // neither, the tool and the capabilities tool both say it is missing rather than guessing at what
  // a video says.
  //
  // Tier 2 is a model that takes the video itself. GEMINI_API_KEY is all it needs. On a YouTube
  // link the URL goes straight to Gemini and it watches the video — the only case where Reason may
  // honestly say it watched something. On any other site Reason gets the AUDIO TRACK ONLY into
  // audioTmpRoot, uploads that, and the result is a transcript with nothing visual in it. The audio
  // is deleted the moment the transcript is stored, and the video stream is never downloaded.
  // With no key, nothing watches or listens and every result says so in words.
  geminiKey: process.env.GEMINI_API_KEY || "",
  videoModel: process.env.REASON_VIDEO_MODEL || "gemini-3.8-flash",
  geminiBase: (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
  videoModelTimeoutMs: Number(process.env.REASON_VIDEO_MODEL_TIMEOUT_MS || 300_000),
  // A video they sent (src/media.js videosFor): the hard deadline on one whole watch — download,
  // upload, processing and description. The turn waits on it, so past this it answers without the
  // video and says so, rather than sitting silent (2026-11-01: screen recordings, 15+ min, no word).
  videoWatchTimeoutMs: Number(process.env.REASON_VIDEO_WATCH_TIMEOUT_MS || 180_000),
  // An uploaded file carries a state and cannot be used in a prompt until it is ACTIVE.
  geminiFilePollMs: Number(process.env.REASON_GEMINI_FILE_POLL_MS || 2_000),
  geminiFileMaxPolls: Number(process.env.REASON_GEMINI_FILE_MAX_POLLS || 30),
  // How long a video tier 2 will take on in one go. This is a money limit, not a model limit:
  // Gemini's own ceilings are far higher (9.5 hours of audio a prompt), but a YouTube video costs
  // ~100 tokens a second to watch, so an hour is around 27 cents on gemini-3.8-flash and a
  // four-hour stream would be over a dollar before it said anything. Over this, Reason refuses in
  // plain words rather than quietly spending it.
  videoMaxMinutes: Number(process.env.REASON_VIDEO_MAX_MINUTES || 60),
  // OPTIONAL and not configured: an OpenAI speech-to-text transcriber for the audio path, and a
  // local Whisper that is documented rather than installed (src/transcribe.js). Gemini is what the
  // audio path uses; these exist, are offline-tested, and run only if REASON_TRANSCRIBER says so.
  transcriber: process.env.REASON_TRANSCRIBER || "",
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiBase: (process.env.OPENAI_API_BASE || "https://api.openai.com").replace(/\/+$/, ""),
  transcribeModel: process.env.REASON_TRANSCRIBE_MODEL || "",
  transcribeTimeoutMs: Number(process.env.REASON_TRANSCRIBE_TIMEOUT_MS || 300_000),
  // Audio on its way to being transcribed. Under the data dir so a container has one volume, and
  // emptied per video rather than kept: the transcript is what is worth keeping, not the sound.
  audioTmpRoot: process.env.REASON_AUDIO_TMP || `${DATA_DIR}/audio-tmp`,
  // Which stream to pull for listening. Every one of these is already a single audio file, so
  // nothing is re-encoded and ffmpeg is NOT needed — `--extract-audio` would need it, and this
  // machine does not have it. m4a first: it is what YouTube's format 140 is (~1 MB a minute) and it
  // is on the hosted transcriber's accepted list. The video stream is never asked for.
  audioFormat: process.env.REASON_AUDIO_FORMAT || "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
  // How much transcript comes back at once. A three-hour talk is half a million characters of
  // captions, so something has to go — and what went is reported, never dropped quietly.
  // 20k is about 35 minutes of someone talking, so an ordinary video comes back whole and only a
  // long talk gets cut — which is the case the `trimmed` report exists for.
  videoTranscriptChars: Number(process.env.REASON_VIDEO_TRANSCRIPT_CHARS || 20_000),
  videoDescriptionChars: Number(process.env.REASON_VIDEO_DESCRIPTION_CHARS || 1_200),
  videoProbeTimeoutMs: Number(process.env.REASON_VIDEO_PROBE_TIMEOUT_MS || 60_000),
  // Web search. One provider interface, three real providers: Parallel (5,000 searches a month
  // free, long excerpts per result), Context.dev (1,000 credits a month free, shared with page
  // scraping) and Tavily (1,000 credits a month free, no credit card). REASON_SEARCH_PROVIDER names
  // which one to use; with no key for it, search is `not_connected` and says so rather than
  // guessing at what the web says.
  searchProvider: process.env.REASON_SEARCH_PROVIDER || "contextdev",
  parallelKey: process.env.PARALLEL_API_KEY || "",
  parallelBase: (process.env.PARALLEL_API_BASE || "https://api.parallel.ai").replace(/\/+$/, ""),
  // `fast` answers in ~700ms at $1 per 1,000; `advanced` in ~3s at $5 per 1,000 with better
  // multi-hop results. Fast is the default because most searches are one tool turn somebody is
  // waiting on.
  parallelMode: process.env.PARALLEL_SEARCH_MODE || "fast",
  // Upper bound on excerpt characters across one search's results. Enough to quote from, small
  // enough that a tool result stays readable.
  parallelMaxChars: Number(process.env.PARALLEL_SEARCH_MAX_CHARS || 8_000),
  // The rest of Parallel (src/parallel.js), each behind the same key. Page reading: which scraper
  // web_lookup tries first — "parallel" (Extract: JavaScript pages and PDFs, excerpts focused on
  // the question, $1 per 1,000), "contextdev" or "plain". Whatever is named, the chain still falls
  // through to the next one that has a key, and plain fetch last.
  lookupProvider: process.env.REASON_LOOKUP_PROVIDER || "contextdev",
  parallelExtractTimeoutMs: Number(process.env.PARALLEL_EXTRACT_TIMEOUT_MS || 25_000),
  // Deep research: "parallel" hands a `deep: true` question to the Task API as one async run on
  // this processor (pro reads far more than the page cap allows, ~$0.10 a run; ultra ~$0.30) and
  // Reason's own slice still runs now so the first reply has sources. "local" is the old path only.
  researchDeepProvider: process.env.REASON_RESEARCH_DEEP_PROVIDER || "parallel",
  parallelDeepProcessor: process.env.PARALLEL_DEEP_PROCESSOR || "pro",
  // A plain fact: one cited answer from the Responses API (low ~5–10s, medium ~15–20s) before
  // Reason's own searches. "none" turns it off.
  researchAnswerProvider: process.env.REASON_RESEARCH_ANSWER_PROVIDER || "parallel",
  parallelAnswerEffort: process.env.PARALLEL_ANSWER_EFFORT || "low",
  parallelAnswerTimeoutMs: Number(process.env.PARALLEL_ANSWER_TIMEOUT_MS || 30_000),
  // Watching the world rather than a page: a Monitor on "lite" is $3 per 1,000 checks.
  parallelMonitorProcessor: process.env.PARALLEL_MONITOR_PROCESSOR || "lite",
  parallelImageMode: process.env.PARALLEL_IMAGE_MODE || "fast",
  // Verified lists: "base" is $0.25 a run plus $0.03 a match; the limit caps what a run can cost.
  parallelFindAllGenerator: process.env.PARALLEL_FINDALL_GENERATOR || "base",
  parallelFindAllLimit: Number(process.env.PARALLEL_FINDALL_LIMIT || 20),
  // Settings → Webhooks on platform.parallel.ai. Without it nothing Parallel pushes is believed,
  // and Reason polls instead, which works but later.
  parallelWebhookSecret: process.env.PARALLEL_WEBHOOK_SECRET || "",
  contextDevKey: process.env.CONTEXT_DEV_API_KEY || "",
  contextDevBase: (process.env.CONTEXT_DEV_API_BASE || "https://api.context.dev/v1").replace(/\/+$/, ""),
  tavilyKey: process.env.TAVILY_API_KEY || "",
  tavilyBase: (process.env.TAVILY_API_BASE || "https://api.tavily.com").replace(/\/+$/, ""),
  // `basic` costs 1 credit a search and returns snippets pulled from the source; `advanced` costs 2.
  // Basic is the default because the free allowance is counted in credits, not searches.
  tavilyDepth: process.env.TAVILY_SEARCH_DEPTH || "basic",
  searchTimeoutMs: Number(process.env.REASON_SEARCH_TIMEOUT_MS || 20_000),
  searchMaxResults: Number(process.env.REASON_SEARCH_MAX_RESULTS || 8),
  // What stops one question from running away. A research run may make this many searches and read
  // this many pages in total, however many turns it is spread over, and one call to it may spend
  // this many seconds. When a cap is what ended a run, the result says which one, and Reason says so
  // rather than presenting a half-finished answer as a finished one.
  researchMaxSearches: Number(process.env.REASON_RESEARCH_MAX_SEARCHES || 5),
  researchMaxPages: Number(process.env.REASON_RESEARCH_MAX_PAGES || 8),
  researchMaxSeconds: Number(process.env.REASON_RESEARCH_MAX_SECONDS || 90),
  // A big question gets more room. "Big" is read off what the model already said about it, never
  // off the words: kind "choice" (comparing or deciding), three or more planned queries, or three or
  // more named options. Run #78 (2026-10-30, "which service can vault each user's card with a
  // passkey") planned four queries naming six vendors and the small caps could not see past the
  // first one. The cost of the bigger room, so it is a choice and not a default: each page is up to
  // researchSourceChars (≈2.5k chars) in the model's context, so +6 pages ≈ +15k chars ≈ +~4k tokens,
  // and with the extra searches' snippets a full big run lands at roughly +~9k tokens on a ~120k
  // input reply (<10%). The searches themselves are the Parallel provider's, not Anthropic's. The
  // extra 60s is only spent when there is still work to do. Small questions keep the caps above.
  researchBigMaxSearches: Number(process.env.REASON_RESEARCH_BIG_MAX_SEARCHES || 8),
  researchBigMaxPages: Number(process.env.REASON_RESEARCH_BIG_MAX_PAGES || 14),
  researchBigMaxSeconds: Number(process.env.REASON_RESEARCH_BIG_MAX_SECONDS || 150),
  // When a cap still ends a run with planned queries left, the person gets the answer from what was
  // found now and ONE follow-up text later: a task wakes this many minutes on, carries the same run
  // on with a fresh slice of this many searches and pages on top of what it already spent, texts
  // only what is new, and closes. Never chained: the follow-up's own carry-on cannot start another.
  researchContinueWakeMin: Number(process.env.REASON_RESEARCH_CONTINUE_WAKE_MIN || 2),
  researchContinueSearches: Number(process.env.REASON_RESEARCH_CONTINUE_SEARCHES || 5),
  researchContinuePages: Number(process.env.REASON_RESEARCH_CONTINUE_PAGES || 8),
  // How many of those background follow-ups one person gets a day (the install's day, the same one
  // the spend cap counts on — trust.js spendDay). Sized off the subscription, which is what pays for
  // it: one reply ≈120k input tokens, a p50 active person ≈6 turns a day (≈0.8M), p90 ≈1.6M, and a
  // Pro plan carries ~6–11 people with the WEEKLY cap the one that binds. A follow-up is ~1–2 extra
  // turns, so 2 a day is at most a ~4-turn (~0.5M) bump on a heavy research day, and only on days
  // someone asks big questions. The owner gets 5 because the owner tests it and pays for it. Past the
  // cap the answer is what it always was: based on what it got, with an offer to look further.
  researchContinuePerDay: Number(process.env.REASON_RESEARCH_CONTINUE_PER_DAY || 2),
  researchContinuePerDayOwner: Number(process.env.REASON_RESEARCH_CONTINUE_PER_DAY_OWNER || 5),
  researchMaxRetries: Number(process.env.REASON_RESEARCH_MAX_RETRIES || 2),
  // How much of each source is kept in the log. Enough to quote from honestly, small enough that
  // eight of them fit in a turn.
  researchSourceChars: Number(process.env.REASON_RESEARCH_SOURCE_CHARS || 2_500),
  // One question, one run. A run still open in a conversation and touched within this many minutes
  // is shown to the model before a new run may start, so a re-asked question carries that run on
  // instead of paying for the same searches again (2026-10-17: one question on a call became eleven
  // runs in eight minutes). Past it, an open run nobody is working on is closed by the sweep.
  researchJoinWindowMin: Number(process.env.REASON_RESEARCH_JOIN_WINDOW_MIN || 30),
  // A page read for one run in a conversation is not fetched again by another within this window;
  // the text already in the log is used. On 2026-10-17 one SEC filing was fetched fourteen times.
  researchReuseSourcesMin: Number(process.env.REASON_RESEARCH_REUSE_SOURCES_MIN || 360),
  // Niche source discovery (src/niche.js) gets its own small allowance ON TOP of the searches
  // above, counted separately on the run. Deliberately not shared: a run that plans four good
  // queries spends the whole budget before it ever reaches the licensing board or the hiring repo,
  // and a niche search is by definition the one the planned queries were never going to make.
  // Small, because two places nobody else looked is the win and a sixth one is padding.
  researchNicheSearches: Number(process.env.REASON_RESEARCH_NICHE_SEARCHES || 2),
  // Spotify. The authorization code flow, per their current docs (read 2026-10-05): the person is
  // sent to accounts.spotify.com/authorize, Spotify redirects back to a URI that has to be
  // registered on the app EXACTLY, and the code is exchanged at accounts.spotify.com/api/token
  // with the client id and secret in a Basic header. Access tokens last an hour; refresh tokens
  // last six months and then the person has to authorize again.
  //
  // The redirect address: `REASON_PUBLIC_URL` when there is one, otherwise the loopback literal.
  // NOT `localhost` — Spotify's redirect-URI rules forbid it by name and require an explicit
  // 127.0.0.1 or [::1], which is why this builds the IP form rather than reusing config.host.
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || "",
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
  spotifyApiBase: (process.env.SPOTIFY_API_BASE || "https://api.spotify.com").replace(/\/+$/, ""),
  spotifyAccountsBase: (process.env.SPOTIFY_ACCOUNTS_BASE || "https://accounts.spotify.com").replace(/\/+$/, ""),
  spotifyTimeoutMs: Number(process.env.SPOTIFY_TIMEOUT_MS || 15_000),
  // GitHub: repos, issues, pull requests. The web application OAuth flow, per their current docs:
  // the person is sent to github.com/login/oauth/authorize, GitHub redirects back with ?code&state,
  // and the code is exchanged at POST github.com/login/oauth/access_token with client_id and
  // client_secret in a JSON body. Tokens do not expire on OAuth Apps — no refresh flow.
  githubClientId: process.env.GITHUB_OAUTH_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || "",
  githubBase: (process.env.GITHUB_BASE || "https://github.com").replace(/\/+$/, ""),
  githubApiBase: (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, ""),
  githubTimeoutMs: Number(process.env.GITHUB_TIMEOUT_MS || 15_000),
  // X (Twitter): tweets, DMs, likes, bookmarks. OAuth 2.0 Authorization Code Flow with PKCE, per
  // their current docs (docs.x.com, read 2026-10-11). The person is sent to x.com/i/oauth2/authorize
  // with a PKCE code_challenge, X redirects back with ?code&state, and the code is exchanged at
  // POST api.x.com/2/oauth2/token with the code_verifier and client credentials as Basic auth.
  // Access tokens last 2 hours; refresh tokens via offline.access scope. Pay-per-usage pricing.
  xClientId: process.env.X_CLIENT_ID || "",
  xClientSecret: process.env.X_CLIENT_SECRET || "",
  xApiBase: (process.env.X_API_BASE || "https://api.x.com").replace(/\/+$/, ""),
  xAuthBase: (process.env.X_AUTH_BASE || "https://x.com").replace(/\/+$/, ""),
  xTimeoutMs: Number(process.env.X_TIMEOUT_MS || 15_000),
  xStateTtlMs: Number(process.env.X_STATE_TTL_MS || 10 * 60_000),
  // Uber: a ride, through Uber's own Riders API. OAuth 2.0 authorization code, per their current
  // docs (developer.uber.com/docs/riders/guides/authentication/user-access-token, read 2026-10-15):
  // the person is sent to auth.uber.com/oauth/v2/authorize, Uber redirects back with ?code&state,
  // and the code is exchanged at POST auth.uber.com/oauth/v2/token with client_id and client_secret
  // as FORM fields. Access tokens last 30 days (expires_in 2592000); the refresh token lasts a year
  // and comes back only when `offline_access` was asked for.
  //
  // This is the route that cannot be bot-checked. Reason's other way into Uber — the person signing
  // in on auth.uber.com inside Reason's own headless browser — is dead from the server: Cloudflare
  // answers it with a security check (verified from the Hetzner server, 2026-10-15). The same
  // server reaches both hosts below over plain HTTPS and gets JSON, because server-to-server is
  // not what a bot wall is for.
  uberClientId: process.env.UBER_CLIENT_ID || "",
  uberClientSecret: process.env.UBER_CLIENT_SECRET || "",
  uberAuthBase: (process.env.UBER_AUTH_BASE || "https://auth.uber.com").replace(/\/+$/, ""),
  // The sandbox takes the SAME tokens and creates no real trip (developer.uber.com/docs/riders/
  // guides/sandbox). It is a switch rather than a separate credential, which is what makes an
  // end-to-end check against real Uber possible without anybody being driven anywhere.
  uberApiBase: (process.env.UBER_API_BASE
    || (process.env.REASON_UBER_SANDBOX === "1" ? "https://sandbox-api.uber.com" : "https://api.uber.com")).replace(/\/+$/, ""),
  uberSandbox: process.env.REASON_UBER_SANDBOX === "1",
  uberTimeoutMs: Number(process.env.UBER_TIMEOUT_MS || 15_000),
  // Ten minutes, the same as X's. Uber's authorization code expires in 10 minutes by their docs, so
  // a state older than that can authorize nothing anyway and a connect link left in somebody's
  // messages should not be live a week later.
  uberStateTtlMs: Number(process.env.UBER_STATE_TTL_MS || 10 * 60_000),
  // AgentCard: a card the person keeps in AgentCard's vault, and purchases run through their
  // Purchase API. Per their current docs (docs.agentcard.sh, read 2026-10-11): the client id and
  // secret are this organization's and are exchanged for a platform token at
  // POST api.agentcard.sh/api/v2/oauth/token with grant_type=client_credentials. That token mints
  // vault sessions and reads which cards somebody has; buying runs on a per-person buy token
  // instead, because /buy refuses an organization token. Sandbox credentials run the whole loop for
  // real and stop at the confirm by design — see src/agentcard.js.
  //
  // The webhook secret is the endpoint's own, handed back once when the endpoint is registered. It
  // is a separate credential from the two above and the signature check fails closed without it.
  agentcardClientId: process.env.AGENTCARD_CLIENT_ID || "",
  agentcardClientSecret: process.env.AGENTCARD_CLIENT_SECRET || "",
  agentcardApiBase: (process.env.AGENTCARD_API_BASE || "https://api.agentcard.sh").replace(/\/+$/, ""),
  // Two minutes, against the 15 seconds everything else here gets. AgentCard's own docs ask for at
  // least 120s: every turn of a purchase runs against a live shop, so a turn that takes forty
  // seconds is working rather than stuck.
  agentcardTimeoutMs: Number(process.env.AGENTCARD_TIMEOUT_MS || 120_000),
  agentcardWebhookSecret: process.env.AGENTCARD_WEBHOOK_SECRET || "",
  agentcardWebhookSkewMs: Number(process.env.AGENTCARD_WEBHOOK_SKEW_MS || 5 * 60_000),
  // Google: Gmail and Calendar, one connection per person. The authorization code flow for web
  // server apps, per their current docs (read 2026-10-05): the person is sent to
  // accounts.google.com/o/oauth2/v2/auth with access_type=offline, Google redirects back to a URI
  // registered on the client EXACTLY, and the code is exchanged at oauth2.googleapis.com/token with
  // the client id and secret in the form body. Access tokens last about an hour; a refresh token
  // lasts until it is revoked — except that this app's consent screen is in Testing mode, where
  // Google expires it after 7 days, so a reconnect is a weekly event rather than a rare one.
  //
  // The redirect address is built by callbackUrl() from REASON_PUBLIC_URL. Google's redirect rules
  // require https and refuse raw IP addresses, with localhost IPs exempt from both — so the
  // 127.0.0.1 fallback is legal here, unlike Spotify, which forbids `localhost` by name. The one
  // registered on the client is https://reason.tail3753c7.ts.net/google/callback.
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  // Google's brand verification needs the home page's domain proved in Search Console. The meta-tag
  // method is a `<meta name="google-site-verification" content="…">` on the home page; this is the
  // content value, and the public pages carry the tag when it is set. Only the characters Google's
  // tokens use are kept, so a stray value cannot become markup.
  googleSiteVerification: (process.env.GOOGLE_SITE_VERIFICATION || "").trim().replace(/[^A-Za-z0-9_-]/g, ""),
  googleAccountsBase: (process.env.GOOGLE_ACCOUNTS_BASE || "https://accounts.google.com").replace(/\/+$/, ""),
  googleOauthBase: (process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com").replace(/\/+$/, ""),
  googleGmailBase: (process.env.GOOGLE_GMAIL_BASE || "https://gmail.googleapis.com").replace(/\/+$/, ""),
  googleCalendarBase: (process.env.GOOGLE_CALENDAR_BASE || "https://www.googleapis.com").replace(/\/+$/, ""),
  // Drive sits on www.googleapis.com like Calendar, but it gets its own entry rather than borrowing
  // Calendar's: a test has to be able to point all of Drive — including its /upload host — somewhere
  // else without moving the calendar with it.
  googleDriveBase: (process.env.GOOGLE_DRIVE_BASE || "https://www.googleapis.com").replace(/\/+$/, ""),
  googleTimeoutMs: Number(process.env.GOOGLE_TIMEOUT_MS || 15_000),
  // Apple Calendar (CalDAV). The base is caldav.icloud.com unless a test points it at a fake.
  icloudCalDAVBase: (process.env.ICLOUD_CALDAV_BASE || "https://caldav.icloud.com").replace(/\/+$/, ""),
  icloudTimeoutMs: Number(process.env.ICLOUD_TIMEOUT_MS || 15_000),
  // How long a connect link is good for. A `state` is the credential that ties Google's callback to
  // one conversation, so a link that sat in somebody's messages for a week should not still be able
  // to attach an inbox. Short enough to mean something, long enough to sign in to Google first.
  googleStateTtlMs: Number(process.env.GOOGLE_STATE_TTL_MS || 15 * 60_000),
  // How much of one email's text comes back in a tool result. Enough to answer a question about it,
  // small enough that a few of them fit in a turn; the tool says when it cut one short.
  gmailBodyChars: Number(process.env.REASON_GMAIL_BODY_CHARS || 4_000),
  // How much of one Drive file's text comes back in a tool result. Larger than an email's because a
  // lease or a spec is the kind of thing somebody asks a question about, and a cut that lands before
  // the clause they care about is a wasted turn; the tool always says when it cut one and how far in.
  // 20,000 since 2026-10-06: at 8,000 Omari's own two-page resume (about 8,500 characters) came back
  // with its last lines missing and a note saying so. A document is read whole or the cut is said.
  driveTextChars: Number(process.env.REASON_DRIVE_TEXT_CHARS || 20_000),
  // A PDF, read on this machine (src/pdf.js). The size cap is about the bytes crossing the wire and
  // landing in a temp file, not about the model: 25 MB is larger than any resume, lease, statement or
  // ticket and small enough that a mis-click on a scanned book is a refusal rather than a stall.
  pdfMaxBytes: Number(process.env.REASON_PDF_MAX_BYTES || 25 * 1024 * 1024),
  // How many of a long PDF's pages are read. The text is cut to driveTextChars afterwards anyway, so
  // this is only here to stop a 600-page document being walked page by page for text nobody will see —
  // and the tool says how many of how many it read, which is why it is pages and not a guess.
  pdfMaxPages: Number(process.env.REASON_PDF_MAX_PAGES || 40),
  pdfReadTimeoutMs: Number(process.env.REASON_PDF_READ_TIMEOUT_MS || 30_000),
  // How many files one yes may move in their Drive. "Sort my downloads into folders by year" is a
  // real ask and a hundred files is a real answer to it — but a yes is only worth something if the
  // person could still picture what they agreed to, and a move that half-finished across two hundred
  // files leaves a Drive nobody can tidy by hand afterwards. 50 is the line: above it the tool
  // refuses and says to do it in batches, so the second batch gets its own yes instead of riding the
  // first one. Each move is its own ledger row, and a run stops at the first failure.
  maxDriveBatch: Number(process.env.REASON_MAX_DRIVE_BATCH || 50),
  // What a person may commit in one day, in whole dollars. 0 means no cap. Counted in the database
  // from the amounts that were actually approved, so restarting the process does not reset it, and
  // enforced in the gate rather than asked of the model.
  maxSpendPerDay: Number(process.env.REASON_MAX_SPEND_PER_DAY ?? 300),
  // One Chromium profile per conversation, so a login in one thread is not a login in another.
  profileRoot: process.env.REASON_PROFILE_ROOT || `${DATA_DIR}/profiles`,
  shotRoot: process.env.REASON_SHOT_ROOT || `${DATA_DIR}/shots`,
  browserHeaded: process.env.REASON_BROWSER_HEADED === "1",
  browserTimeoutMs: Number(process.env.REASON_BROWSER_TIMEOUT_MS || 20_000),
  // Image generation (src/imagen.js): OpenAI gpt-image-2 only, on OPENAI_API_KEY (owner, 2026-11-09 —
  // Google retired the Imagen model that used to go first). Generated images land under the data dir
  // and are served as page content.
  imagenTimeoutMs: Number(process.env.REASON_IMAGEN_TIMEOUT_MS || 60_000),
  imagenOutputDir: process.env.REASON_IMAGEN_OUTPUT || `${DATA_DIR}/images`,
  extractionModel: process.env.REASON_EXTRACTION_MODEL || "claude-haiku-5-5",
  // Choosing the profile out of everything saved (src/extract.js rebuildProfile). Run only when a new
  // fact lands, and it is judgement — which of six wordings is one thing, what is already over — that
  // the extraction model was measured getting wrong on the live data, 2026-10-19.
  profileModel: process.env.REASON_PROFILE_MODEL || "claude-sonnet-5-5",
  extractionFallbackModel: process.env.REASON_EXTRACTION_FALLBACK_MODEL || "claude-sonnet-4-5",
  extractionTimeoutMs: Number(process.env.REASON_EXTRACTION_TIMEOUT_MS || 30_000),
  // Extraction and the profile run on Reason's own subscription through the CLI (2026-10-25): they
  // are background work, and on the API they were what emptied the key overnight. The API models
  // above are what they run on only on the API backend (no CLI to use).
  extractionCliModel: process.env.REASON_EXTRACTION_CLI_MODEL || "haiku",
  profileCliModel: process.env.REASON_PROFILE_CLI_MODEL || "sonnet",
  extractionCliTimeoutMs: Number(process.env.REASON_EXTRACTION_CLI_TIMEOUT_MS || 120_000),
  // How many queued messages one extraction read takes, from one conversation.
  extractionBatch: Number(process.env.REASON_EXTRACTION_BATCH || 8),
  // The background lane on the subscription (src/background.js): at least this long between two of
  // its CLI runs, so background work can never crowd out a reply.
  backgroundCliGapMs: Number(process.env.REASON_BACKGROUND_CLI_GAP_MS || 15_000),
  // Hard caps on the paid key (src/spend.js capReached), each by the owner's day / calendar month.
  // At the daily cap every paid use except phone calls goes to the subscription until midnight;
  // calls have their own daily cap; the monthly cap covers everything, calls included, until the 1st.
  // 0 turns a cap off.
  apiDailyCapUsd: Number(process.env.REASON_API_DAILY_CAP_USD || 1),
  apiCallDailyCapUsd: Number(process.env.REASON_API_CALL_DAILY_CAP_USD || 2),
  apiMonthlyCapUsd: Number(process.env.REASON_API_MONTHLY_CAP_USD || 10),
  // $ per million tokens, by model — input, output, cache write (5 min), cache read. Estimates for
  // the status page, not a bill. REASON_API_PRICES (JSON, same shape) overrides any row.
  apiPrices: {
    "claude-haiku-5-5": { in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.20 },
    "claude-sonnet-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.20 },
    "claude-opus-5-5": { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.20 },
    "claude-opus-5": { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.50 },
    "claude-sonnet-4-5": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.30 },
    ...(() => { try { return JSON.parse(process.env.REASON_API_PRICES || "{}"); } catch { return {}; } })(),
  },
  // After the API says the account is out of credit, the side checks go straight to their CLI
  // fallback for this long instead of spending a round trip to hear it again.
  apiOutPauseMs: Number(process.env.REASON_API_OUT_PAUSE_MS || 10 * 60_000),
  profileMaxFacts: Number(process.env.REASON_PROFILE_MAX_FACTS || 15),
  graphMaxHops: Number(process.env.REASON_GRAPH_MAX_HOPS || 2),
};

// A clock that can be moved forward in tests and in the console (/skip 2h),
// so timers can be exercised without waiting.
let offsetMs = 0;
/**
 * How recent a call has to be for its recording to ride on a message that is not about it (see
 * Runtime._emit). Here rather than in src/runtime.js so the call_status tool can say the same thing
 * without importing the runtime.
 */
export const RECORDING_RIDES_MS = 60 * 60_000;

zonescope.setEnabled(() => config.tzAsk);

export const clock = {
  now: () => Date.now() + offsetMs,
  skip: (ms) => { offsetMs += ms; },
  reset: () => { offsetMs = 0; },
};

/**
 * Where a provider redirects back to after the person authorizes.
 *
 * `REASON_PUBLIC_URL` when the install has one, otherwise the loopback literal with the port the
 * listener is really on. Spotify's redirect-URI rules (read 2026-10-05) spell out that `localhost`
 * is not allowed and a loopback redirect must use the explicit IP, so this never emits `localhost`
 * however `REASON_HOST` is set — a redirect URI that does not match the one registered on the app
 * fails at the authorize step with nothing useful said about why.
 */
export function callbackUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (config.publicUrl) return `${config.publicUrl}${p}`;
  return `http://127.0.0.1:${config.port}${p}`;
}

/**
 * Digits with a leading +, so "+1 (415) 555-9876" and "+14155559876" are one address.
 *
 * Only for something that IS a phone number. An Apple ID email, a SIP URI or a Twilio client id
 * can carry somebody else's digits ("12025551234@icloud.com", "sip:+1202…@host"), and keeping
 * every digit of it made that handle the same person as the number: the operator, or an admitted
 * user, by writing their digits into an address. Anything with an "@" or a URI scheme other than
 * tel: is not a number and normalizes to nothing; callers keep it as its own literal address.
 */
export function normalizeNumber(n) {
  let s = String(n ?? "").trim();
  if (/[@\uFF20]|%40/i.test(s)) return "";
  if (/^tel:/i.test(s)) s = s.slice(4);
  // "sip:+1…", "client:1202…": a scheme glued to what follows. "Mom: +1 415…" is a label, not one.
  else if (/^[a-z][a-z0-9+.-]*:(?!\s)/i.test(s)) return "";
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * The one form of an address a person can be reached at over iMessage: a phone number in E.164
 * (normalizeNumber), or an Apple ID email, lowercased. Anything else is nothing.
 *
 * An iMessage can come from an Apple ID rather than a phone ("Can receive from iCloud email
 * addresses" — Sendblue faq), and Sendblue sends back to one by passing the email as `number`.
 * Until 2026-11-11 such a person was dropped at the webhook with no line in the journal, because
 * normalizeNumber() is phone-only on purpose (the digits inside "12025551234@icloud.com" are not
 * the person at +1 202 555 1234). This is the identity normalizer: wherever an address decides
 * WHO somebody is — admission, conversation id, invites, sign-in, the access queue — an email
 * handle and its re-capitalised or padded forms are one person. Dialing stays on normalizeNumber:
 * nothing rings an email.
 *
 * Email-shaped means one "@", something on both sides, no whitespace, no scheme, no percent-encoded
 * "@". Case is folded because Apple treats "Jane@iCloud.com" and "jane@icloud.com" as one Apple ID.
 */
export function normalizeHandle(n) {
  const s = String(n ?? "").trim();
  if (!s) return "";
  const phone = normalizeNumber(s);
  if (phone) return phone;
  if (!config.emailHandles) return "";
  if (!/^[^\s@＠%:/]+@[^\s@＠%:/]+\.[^\s@＠%:/]+$/.test(s)) return "";
  return s.toLowerCase();
}

/** True for an address that is an email handle rather than a phone number. */
export function isEmailHandle(n) {
  const h = normalizeHandle(n);
  return !!h && h.includes("@");
}

/**
 * Is this one of Reason's OWN phone lines (the Twilio, Sendblue, Linq or Bland "from" number)? A
 * text to one of these is Reason talking to itself — a test, or a number pasted by mistake — never
 * a person (2026-11-09: the Twilio line texted the Sendblue line once, Sendblue refused to answer
 * it, and the status page called that "texts over sendblue are failing").
 */
export function isOwnLine(n) {
  const x = normalizeNumber(n);
  if (!x) return false;
  return [config.twilioFrom, config.sendblueFrom, config.linqFrom, config.blandFrom].some(f => f && normalizeNumber(f) === x);
}

/** Is this number the owner's? Read from config only — never from anything a message says. */
export function isOwnerNumber(n) {
  const x = normalizeNumber(n);
  return !!x && config.ownerNumbers.some(o => normalizeNumber(o) === x);
}

export function stamp(ms = clock.now()) {
  // Their zone's short name rides along only when it is not the install's, so a person in Chicago
  // reads "… 9:35 AM CDT" and builds times with the right offset, and every Eastern stamp is
  // exactly what it always was.
  const other = config.tz !== config.installTz;
  return new Date(ms).toLocaleString("en-US", {
    timeZone: config.tz, weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", ...(other ? { timeZoneName: "short" } : {}),
  });
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Guard for free-text dates like "Fri Sep 26, 8:00 PM": if it names both a weekday and a month/day,
 * check they agree for the current or next year. Returns a warning string, or null when consistent/unknown.
 */
export function weekdayMismatch(text, nowMs = clock.now()) {
  if (!text) return null;
  const t = text.toLowerCase();
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(t);
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/.exec(t);
  if (!wd || !md) return null;
  const year = /\b(20\d{2})\b/.exec(t)?.[1];
  const nowYear = Number(new Date(nowMs).toLocaleString("en-US", { timeZone: config.tz, year: "numeric" }));
  const y = year ? Number(year) : nowYear;
  const m = MONTHS.indexOf(md[1]);
  const d = Number(md[2]);
  const date = new Date(Date.UTC(y, m, d, 12));
  if (date.getUTCMonth() !== m || date.getUTCDate() !== d) return null;
  // If no year was given and the date is more than 2 months in the past, they probably mean next year.
  if (!year && date.getTime() < nowMs - 60 * 86_400_000) date.setUTCFullYear(y + 1);
  const actual = DAYS[date.getUTCDay()];
  if (actual === wd[1]) return null;
  // Find the nearest date on or after today that falls on the named weekday.
  const today = new Date(nowMs + 0);
  const todayLocal = new Date(new Date(nowMs).toLocaleString("en-US", { timeZone: config.tz }));
  const want = DAYS.indexOf(wd[1]);
  const delta = (want - todayLocal.getDay() + 7) % 7;
  const next = new Date(todayLocal.getTime() + delta * 86_400_000);
  const nextStr = `${wd[1][0].toUpperCase() + wd[1].slice(1)} ${MONTHS[next.getMonth()][0].toUpperCase() + MONTHS[next.getMonth()].slice(1)} ${next.getDate()}, ${next.getFullYear()}`;
  void today;
  return `Date check: ${md[1][0].toUpperCase() + md[1].slice(1)} ${d}, ${date.getUTCFullYear()} is a ${actual[0].toUpperCase() + actual.slice(1)}, not a ${wd[1][0].toUpperCase() + wd[1].slice(1)}. The next ${wd[1][0].toUpperCase() + wd[1].slice(1)} is ${nextStr}. Ask which one they meant or fix 'when'.`;
}
