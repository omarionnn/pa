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
  ownerCity: process.env.REASON_OWNER_CITY || "New York",
  tz: process.env.REASON_TZ || "America/New_York",
  fallbacks: process.env.REASON_FALLBACKS !== "off",
  // How long an explicit yes counts for, in minutes. After this a guarded tool asks again.
  confirmWindowMin: Number(process.env.REASON_CONFIRM_WINDOW_MIN || 10),
  // The gate's reader: a separate narrow call that decides what the owner's reply meant.
  // Defaults to the same model as the conversation, because misreading a yes is the costly mistake.
  judgeModel: process.env.REASON_JUDGE_MODEL || process.env.REASON_MODEL || "claude-opus-5",
  judgeTimeoutMs: Number(process.env.REASON_JUDGE_TIMEOUT_MS || 12_000),
  // Proactive follow-up. A thread counts as dropped when something is still open and neither the
  // plan nor the conversation has moved for this long. The two limits after it are what stop
  // Reason from nagging: the same plan is not raised again inside the gap, and one conversation
  // gets at most this many nudges a day. Both are counted from the nudges table, not from memory.
  followUpIdleMin: Number(process.env.REASON_FOLLOWUP_IDLE_MIN || 180),
  nudgeGapMin: Number(process.env.REASON_NUDGE_GAP_MIN || 20 * 60),
  nudgeMaxPerDay: Number(process.env.REASON_NUDGE_MAX_PER_DAY || 2),
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
  // Where pages are reachable from the outside. Empty means they still work, but only on this
  // machine — and the capabilities tool says exactly that rather than handing out a link that
  // will not open on a phone.
  publicUrl: (process.env.REASON_PUBLIC_URL || "").replace(/\/+$/, ""),
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
  // Every call is recorded. There is deliberately no switch: the announcement built in
  // src/calls/provider.js always tells the other person the call is recorded, a provider that
  // cannot record cannot be used to place one, and a call that comes back without audio is an
  // error the owner is told about. This is only where the audio Reason owns is kept.
  recordingRoot: process.env.REASON_RECORDING_ROOT || `${DATA_DIR}/recordings`,
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
