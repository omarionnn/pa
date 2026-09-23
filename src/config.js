export const config = {
  model: process.env.PA_MODEL || "claude-opus-5",
  dbPath: process.env.PA_DB_PATH || "data/pa.db",
  ownerName: process.env.PA_OWNER_NAME || "Omari",
  ownerCity: process.env.PA_OWNER_CITY || "New York",
  tz: process.env.PA_TZ || "America/New_York",
  fallbacks: process.env.PA_FALLBACKS !== "off",
};

// A clock that can be moved forward in tests and in the console (/skip 2h),
// so timers can be exercised without waiting.
let offsetMs = 0;
export const clock = {
  now: () => Date.now() + offsetMs,
  skip: (ms) => { offsetMs += ms; },
  reset: () => { offsetMs = 0; },
};

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
