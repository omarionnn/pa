export const config = {
  model: process.env.REASON_MODEL || "claude-opus-5",
  // Which model backend runs a turn. "api" is the only one Reason is deployed on; "claude-cli"
  // is the owner's local test rig on a Claude subscription, and src/backends/guard.js refuses to
  // serve other people on it.
  backend: process.env.REASON_BACKEND === "claude-cli" ? "claude-cli" : "api",
  dbPath: process.env.REASON_DB_PATH || "data/reason.db",
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
  // `npm run serve`: how often the sweep runs, and where the webhook listener binds.
  sweepEveryMs: Number(process.env.REASON_SWEEP_EVERY_MS || 15_000),
  port: Number(process.env.REASON_PORT || 8787),
  host: process.env.REASON_HOST || "127.0.0.1",
  // The owner's conversation, and the numbers allowed to be it. Owner identity is config, never
  // anything a message claims: an inbound number that is not on this list gets its own thread and
  // cannot authorize, spend, or act on anyone.
  ownerConversation: process.env.REASON_CONVERSATION || "dm:owner",
  ownerNumbers: (process.env.REASON_OWNER_NUMBER || "").split(",").map(s => s.trim()).filter(Boolean),
  // Channels. `linq` is the iMessage/SMS adapter; it is only live with a key.
  channel: process.env.REASON_CHANNEL || "console",
  linqKey: process.env.LINQ_API_KEY || "",
  linqWebhookSecret: process.env.LINQ_WEBHOOK_SECRET || "",
  linqFrom: process.env.LINQ_FROM_NUMBER || "",
  linqBase: process.env.LINQ_API_BASE || "https://api.linqapp.com/api/partner",
  // Phone calls. No paid provider is wired; `fake` is the only one that runs.
  callProvider: process.env.REASON_CALL_PROVIDER || "fake",
  callMaxMinutes: Number(process.env.REASON_CALL_MAX_MINUTES || 10),
  // One Chromium profile per conversation, so a login in one thread is not a login in another.
  profileRoot: process.env.REASON_PROFILE_ROOT || "data/profiles",
  shotRoot: process.env.REASON_SHOT_ROOT || "data/shots",
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
