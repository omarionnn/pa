// Everything Reason keeps lives under one directory, so a hosted install can mount one volume and
// not lose anything on a restart: the database, call recordings, saved browser profiles and
// screenshots. Each one can still be pointed somewhere else individually, but the default is that
// they are all together — a deployment where half the state is on a volume and half is not is a
// deployment that silently forgets things.
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
  tz: process.env.REASON_TZ || "America/New_York",
  fallbacks: process.env.REASON_FALLBACKS !== "off",
  // How long an explicit yes counts for, in minutes. After this a guarded tool asks again.
  confirmWindowMin: Number(process.env.REASON_CONFIRM_WINDOW_MIN || 10),
  // The gate's reader: a separate narrow call that decides what the owner's reply meant.
  // Defaults to the same model as the conversation, because misreading a yes is the costly mistake.
  judgeModel: process.env.REASON_JUDGE_MODEL || process.env.REASON_MODEL || "claude-opus-5",
  judgeTimeoutMs: Number(process.env.REASON_JUDGE_TIMEOUT_MS || 12_000),
  // The harm screen (src/harm.js): one narrow call in front of every message anybody sends. Its
  // own model because it is asked one short question on every text, and misreading it costs one
  // wrongly refused text, not a booking. On the claude-cli backend the model is REASON_HARM_CLI_MODEL
  // (default sonnet), set in src/backends/cli.js. There is no switch that turns the screen off.
  harmModel: process.env.REASON_HARM_MODEL || process.env.REASON_JUDGE_MODEL || process.env.REASON_MODEL || "claude-opus-5",
  harmTimeoutMs: Number(process.env.REASON_HARM_TIMEOUT_MS || 20_000),
  // Strikes: this many 'harm' refusals inside this many hours pauses that person's Reason and
  // tells the master (count and kind only). 0 strikes = count but never pause. The master's own
  // account is refused the same way and never paused.
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
  // Durable tasks. A task that wakes and does not say when to come back is re-scheduled this far
  // out rather than left for dead; a step that crashes is retried this many times, backing off a
  // step each time; and a task that has woken this often without ever finishing gives up and says
  // so — the same ceiling watchers have, so nothing runs forever unnoticed.
  taskDefaultWakeMin: Number(process.env.REASON_TASK_WAKE_MIN || 15),
  taskMaxAttempts: Number(process.env.REASON_TASK_MAX_ATTEMPTS || 3),
  taskRetryBackoffMin: Number(process.env.REASON_TASK_RETRY_BACKOFF_MIN || 2),
  taskMaxWakes: Number(process.env.REASON_TASK_MAX_WAKES || 200),
  // Timers. A timer counts as fired once its message is in the outbox, so a turn that throws or
  // times out leaves it due. It is tried this many times in all — the first retry on the very next
  // sweep, each one after that a step further off (a minute, then two) — and then Reason stops and
  // says in a line of its own that a reminder was missed. Three, because a reminder is about a
  // moment: a turn killed by the machine going to sleep or a dropped connection clears on the next
  // try, and one that is still failing after three is better admitted now than delivered an hour
  // late with nobody knowing why.
  timerMaxAttempts: Number(process.env.REASON_TIMER_MAX_ATTEMPTS || 3),
  timerRetryBackoffMs: Number(process.env.REASON_TIMER_RETRY_BACKOFF_MS || 60_000),
  // How many standing check-ins one person can have running at once. Ten, because the failure this
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
  // "not available yet" line and no model turn. Ignored on the API backend.
  testNumbers: (process.env.REASON_TEST_NUMBERS || "").split(",").map(s => s.trim()).filter(Boolean),
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
  // The command that reaches the assistant, and which of its agents to hand work to. A path and an
  // id and nothing else: both are checked against a strict pattern before they are written into the
  // runner script, so neither can carry anything a shell would act on.
  openclawBin: process.env.REASON_OPENCLAW_BIN || "openclaw",
  openclawAgent: process.env.REASON_OPENCLAW_AGENT || "main",
  // How long one handed-over turn may run before it is abandoned. An hour, because a build is not a
  // web request; the assistant's own default is ten minutes, which is not enough for real work.
  remoteTurnTimeoutS: Number(process.env.REASON_REMOTE_TURN_TIMEOUT_S || 3600),
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
  burstQuietMs: Number(process.env.REASON_BURST_QUIET_MS ?? 2_500),
  burstMaxMs: Number(process.env.REASON_BURST_MAX_MS ?? 8_000),
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
  // How long a voice note has to be before the transcript keeps timestamps. Under it, a note is a
  // sentence or two and [0:00] markers are noise in the middle of what should read as their own
  // message; over it, "where did they say that" is a real question somebody might want checked.
  voiceTimestampAfterSec: Number(process.env.REASON_VOICE_TIMESTAMP_AFTER_SEC || 30),
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
  signinWindowMaxMs: Number(process.env.REASON_SIGNIN_WINDOW_MAX_MS || 15 * 60_000),
  hearFallbackModel: process.env.REASON_HEAR_FALLBACK_MODEL || "gemini-3.5-flash-lite",
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
  // Phone calls. `fake` dials nothing and is the default; `bland` is the real one
  // (src/calls/bland.js), and it is only live with a BLAND_API_KEY on this machine.
  callProvider: process.env.REASON_CALL_PROVIDER || "fake",
  callMaxMinutes: Number(process.env.REASON_CALL_MAX_MINUTES || 10),
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
  // ElevenLabs Agents, with Reason itself as the custom LLM behind the voice
  // (src/calls/elevenlabs.js, src/calls/voice.js). The provider is only live with every setting a
  // call cannot happen without — see `status()` there, and docs/calls-elevenlabs-setup.md for where
  // each one is found.
  elevenKey: process.env.ELEVENLABS_API_KEY || "",
  elevenBase: (process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io").replace(/\/+$/, ""),
  // The agent that holds the voice, the languages and the Custom LLM URL.
  elevenAgentId: process.env.ELEVENLABS_AGENT_ID || "",
  // The Twilio number imported on ElevenLabs' Phone Numbers page. Inbound AND outbound; a verified
  // caller ID would be outbound-only, which is half of what this is for.
  elevenPhoneNumberId: process.env.ELEVENLABS_PHONE_NUMBER_ID || "",
  // The bearer secret ElevenLabs is configured to send to Reason's own custom-LLM endpoint. Without
  // it that endpoint would be an unauthenticated way to spend the owner's model credit and to have
  // their thread read out loud, so with this empty the endpoint refuses every request rather than
  // answering one for free.
  elevenLlmSecret: process.env.ELEVENLABS_LLM_SECRET || "",
  // The secret post-call webhooks are HMAC-signed with, in `ElevenLabs-Signature`. Unlike Bland's
  // this one is not optional: a post-call delivery writes a transcript into somebody's thread and
  // carries the audio, so an unsigned one is refused.
  elevenWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || "",
  // One pinned voice, picked by the owner by listening. Never varies per call.
  elevenVoiceId: process.env.ELEVENLABS_VOICE_ID || "",
  elevenTimeoutMs: Number(process.env.ELEVENLABS_TIMEOUT_MS || 20_000),
  // Which backend answers a VOICE turn. Empty means the same one every other turn uses, so an
  // install that sets nothing behaves exactly as it does now; REASON_CALL_BACKEND=api pins the API
  // path for calls alone, which is the switch Friday needs — a phone turn cannot wait on a headless
  // CLI start, while the rest of Reason may still be running on the subscription.
  callBackend: process.env.REASON_CALL_BACKEND || "",
  // How many turns of the person's own thread a voice turn is handed. Short on purpose: a phone
  // turn pays for every token in first-word latency, and what the call needs is the recent shape of
  // the conversation rather than the whole of it.
  callHistoryTurns: Number(process.env.REASON_CALL_HISTORY_TURNS || 12),
  // Every call is recorded. There is deliberately no switch: the announcement built in
  // src/calls/provider.js always tells the other person the call is recorded, a provider that
  // cannot record cannot be used to place one, and a call that comes back without audio is an
  // error the owner is told about. This is only where the audio Reason owns is kept.
  recordingRoot: process.env.REASON_RECORDING_ROOT || `${DATA_DIR}/recordings`,
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
  // Web search. One provider interface, one real provider: Tavily, chosen because its free
  // allowance (1,000 API credits a month, a basic search costing 1) needs no credit card, which is
  // the only tier Reason can honestly tell its owner to go and get. Brave Search is the alternative
  // and is wired for nothing: its free allowance is $5 of monthly credit on a billing plan.
  // REASON_SEARCH_PROVIDER names which provider to use; with no key for it, search is
  // `not_connected` and says so rather than guessing at what the web says.
  searchProvider: process.env.REASON_SEARCH_PROVIDER || "tavily",
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
  // How much of each source is kept in the log. Enough to quote from honestly, small enough that
  // eight of them fit in a turn.
  researchSourceChars: Number(process.env.REASON_RESEARCH_SOURCE_CHARS || 2_500),
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
};

// A clock that can be moved forward in tests and in the console (/skip 2h),
// so timers can be exercised without waiting.
let offsetMs = 0;
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

/** Digits with a leading +, so "+1 (415) 555-9876" and "+14155559876" are one address. */
export function normalizeNumber(n) {
  const digits = String(n ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/** Is this number the owner's? Read from config only — never from anything a message says. */
export function isOwnerNumber(n) {
  const x = normalizeNumber(n);
  return !!x && config.ownerNumbers.some(o => normalizeNumber(o) === x);
}

export function stamp(ms = clock.now()) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: config.tz, weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
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
