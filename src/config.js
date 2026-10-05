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
  // How long before a number that is not invited is told again. Once a day, so being turned away
  // does not turn into Reason texting somebody repeatedly.
  turnedAwayGapMin: Number(process.env.REASON_TURNED_AWAY_GAP_MIN ?? 24 * 60),
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
  // Phone calls. No paid provider is wired; `fake` is the only one that runs.
  callProvider: process.env.REASON_CALL_PROVIDER || "fake",
  callMaxMinutes: Number(process.env.REASON_CALL_MAX_MINUTES || 10),
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
  // The watch tier is a model that takes the video itself, for when the picture matters or there
  // are no captions. GEMINI_API_KEY is the only thing it needs; with it empty, nothing watches
  // anything and every result says so in words.
  videoWatchKey: process.env.GEMINI_API_KEY || "",
  videoWatchModel: process.env.GEMINI_VIDEO_MODEL || "gemini-3.8-flash",
  videoWatchBase: (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
  videoWatchTimeoutMs: Number(process.env.REASON_VIDEO_WATCH_TIMEOUT_MS || 120_000),
  // How much transcript comes back at once. A three-hour talk is half a million characters of
  // captions, so something has to go — and what went is reported, never dropped quietly.
  // 20k is about 35 minutes of someone talking, so an ordinary video comes back whole and only a
  // long talk gets cut — which is the case the `trimmed` report exists for.
  videoTranscriptChars: Number(process.env.REASON_VIDEO_TRANSCRIPT_CHARS || 20_000),
  videoDescriptionChars: Number(process.env.REASON_VIDEO_DESCRIPTION_CHARS || 1_200),
  videoProbeTimeoutMs: Number(process.env.REASON_VIDEO_PROBE_TIMEOUT_MS || 60_000),
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
