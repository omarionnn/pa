// Check-ins that keep coming back. "Check in with me every Monday about the job search."
//
// Reason's timers were all one-offs: a day-of reminder, "how was dinner?", a nudge when something
// had been open too long. Each one fires once and is spent. What somebody actually wants from an
// assistant is the other thing — a standing arrangement that keeps going until they stop it, and
// that tracks from what they say back to it.
//
// The shape, and it is deliberately boring:
//
//   ONE ROW FOR THE ARRANGEMENT.     A `series` row holds what it is about, the rule, the person's
//                                    zone and where the rule has got to. Nothing about any one
//                                    firing lives on it.
//   EVERY FIRING IS A TIMER.         Each occurrence is an ordinary `timers` row with `series_id`
//                                    set. So the fire path, the three tries, the never-twice outbox
//                                    key, the "a reminder was missed" line, the kept note that puts
//                                    pending reminders in front of the model — all of it works on a
//                                    check-in without knowing this file exists.
//   STATE DECIDES, NOT EVENTS.       Nothing schedules "the next one" in response to a firing.
//                                    `schedule()` looks at the rows: an active series with no
//                                    pending timer gets one. A process that dies between the firing
//                                    and the scheduling loses nothing, and two overlapping sweeps
//                                    cannot both make the same occurrence, because `next_at` moves
//                                    when a timer is MADE.
//   ONE LATE, NEVER A BACKLOG.       Three Mondays passed with the laptop shut: they get one
//                                    check-in, for the newest, and the two older ones are gone. A
//                                    person coming back to their phone wants to be asked how the
//                                    search is going, not told three times.
//
// What the check-in SAYS is not here. It is written by the model at fire time, with the series'
// subject and what they said last time in front of it (`frameFor`), exactly like the day-of and
// morning-after nudges: a canned line sent every Monday is a cron job wearing a friend's clothes.
import * as db from "./db.js";
import * as notice from "./notice.js";
import { clock, config, stamp } from "./config.js";

export const KINDS = ["daily", "weekdays", "weekly", "every_n_days", "monthly"];

/**
 * Nothing goes out between these hours, local to the person, unless THEY named the time.
 *
 * "Remind me every day at 7 to work out" is theirs and is honoured at 7 whatever 7 means. A series
 * whose hour Reason picked — "check in with me weekly about the search" — is pulled to 08:00, because
 * a weekly check-in that buzzes at 2am is a thing nobody asked for and would never be asked for.
 */
export const QUIET_START = 23;
export const QUIET_END = 8;

/**
 * How long after a check-in the next thing they say still counts as the answer to it.
 *
 * A day. Short enough that Tuesday's "my car broke down" is not filed as Monday's job-search
 * report; long enough that somebody who reads the question at nine and answers it after work is
 * heard. Past it the wait is dropped and what they said last time is left alone — a stale report is
 * worse than an old one, because the next check-in would reference something they never said.
 */
export const REPORT_WINDOW_MS = 24 * 3600_000;

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_TO_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// ---------- the clock where the person is ----------

/**
 * A zone's real offset at one moment, as "-04:00".
 *
 * Asked at a moment rather than in general, because the answer changes twice a year. `longOffset`
 * is the only way to get it for a named zone without keeping a table that goes stale. Same technique
 * as `rfc3339` in src/google.js; kept here so the maths has no reason to import a mail client.
 */
function zoneOffset(ms, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find(p => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : "+00:00";
}

/** The wall clock and the calendar where this person is, at this instant. */
export function partsIn(ms, timeZone) {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute),
    weekday: SHORT_TO_INDEX[String(p.weekday).toLowerCase()] ?? 0,
  };
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * A wall-clock time in a zone, as a real instant.
 *
 * The offset is looked up twice: once from the time read as though it were UTC, then again from the
 * instant that first guess implies. One pass is wrong for a few hours either side of a
 * daylight-saving change — the offset you need depends on the instant, and the instant depends on
 * the offset — and two settles it everywhere except inside the hour the clocks skip, which is not a
 * real wall-clock time in that zone at all. On the hour that happens twice, this lands on the first.
 */
export function atLocal({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const wall = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
  let offset = zoneOffset(Date.parse(`${wall}Z`), timeZone);
  offset = zoneOffset(Date.parse(`${wall}${offset}`), timeZone);
  return Date.parse(`${wall}${offset}`);
}

/** The local calendar day `ms` falls on, as a plain date with no time attached. */
function dayOf(ms, timeZone) {
  const { year, month, day } = partsIn(ms, timeZone);
  return { year, month, day };
}

/** The next calendar day. Done on a UTC date so month and year ends look after themselves. */
function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Whole days between two calendar days, which is what an "every n days" rule counts in. */
function daysBetween(a, b) {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

const dateKey = ({ year, month, day }) => `${year}-${pad(month)}-${pad(day)}`;
function parseDateKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

// ---------- the rule ----------

function weekdayIndex(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6) return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (/^[0-6]$/.test(s)) return Number(s);
  const i = DAY_NAMES.indexOf(s);
  if (i >= 0) return i;
  return SHORT_TO_INDEX[s.slice(0, 3)] ?? null;
}

/**
 * The `repeat` the model passed, as a rule worth storing, or a refusal saying exactly what is wrong.
 *
 * Every refusal names the fix, because the model is going to read it and try again in the same turn,
 * and "bad input" sends it round the houses. `anchor` is settled later, by `start`, off the first
 * real occurrence — an "every two weeks" rule means nothing until there is a week it counts from.
 */
export function normalizeRule(repeat) {
  const r = repeat ?? {};
  const kind = String(r.kind ?? "").trim().toLowerCase();
  if (!KINDS.includes(kind)) {
    return { ok: false, error: `repeat.kind has to be one of ${KINDS.join(", ")} — got '${r.kind ?? ""}'.` };
  }
  const hour = Number(r.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { ok: false, error: `repeat.hour has to be 0-23 (their local time) — got '${r.hour ?? ""}'. 7 in the evening is 19.` };
  }
  const minute = r.minute === undefined || r.minute === null ? 0 : Number(r.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { ok: false, error: `repeat.minute has to be 0-59 — got '${r.minute}'.` };
  }
  const rule = { kind, hour, minute, their_time: !!r.their_time };

  if (kind === "weekly") {
    const given = Array.isArray(r.weekdays) ? r.weekdays : r.weekdays === undefined ? [] : [r.weekdays];
    const days = [...new Set(given.map(weekdayIndex))];
    if (!days.length || days.some(d => d === null)) {
      return { ok: false, error: `a weekly series needs repeat.weekdays, e.g. ["monday"] or ["monday","thursday"] — got ${JSON.stringify(r.weekdays ?? null)}.` };
    }
    rule.weekdays = days.sort((a, b) => a - b);
  }
  if (kind === "monthly") {
    const day = Number(r.day_of_month);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return { ok: false, error: `a monthly series needs repeat.day_of_month, 1-31 — got '${r.day_of_month ?? ""}'. A month without that day is skipped, not moved.` };
    }
    rule.day_of_month = day;
  }
  if (kind === "every_n_days") {
    const n = Number(r.n);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      return { ok: false, error: `an every_n_days series needs repeat.n, 1-365 — got '${r.n ?? ""}'. Every two weeks is n: 14.` };
    }
    rule.n = n;
  }
  return { ok: true, rule };
}

export function parseRule(json) {
  try {
    const r = JSON.parse(String(json ?? ""));
    return r && KINDS.includes(r.kind) ? r : null;
  } catch { return null; }
}

/** Which day of the week a calendar day is. A date's weekday is the same in every zone. */
function weekdayOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Is this local day one the rule lands on? Nothing about the time of day is asked here. */
function eligible(rule, day) {
  switch (rule.kind) {
    case "daily": return true;
    case "weekdays": {
      const wd = weekdayOf(day);
      return wd >= 1 && wd <= 5;
    }
    case "weekly": return (rule.weekdays ?? []).includes(weekdayOf(day));
    // A month with no 31st is SKIPPED rather than clamped to the 30th. "Every month on the 31st" is
    // nearly always "the last-ish day of the month" said badly, and both readings are defensible —
    // but quietly moving the date is the one that produces a check-in on a day nobody named, so the
    // honest behaviour is to miss February and say so in the schedule line.
    case "monthly": return day.day === rule.day_of_month;
    // Before there is an anchor every day counts, deliberately: "every two weeks" asked on a Tuesday
    // afternoon should start at the next occurrence of that time — tomorrow morning, not a fortnight
    // from now — and the day it really lands on becomes the anchor every later one is counted from.
    // `start` writes the anchor the moment it knows it, and `scheduleOne` backfills any row without
    // one, so this branch is only ever taken while the first occurrence is being found.
    case "every_n_days": {
      const anchor = parseDateKey(rule.anchor);
      if (!anchor) return true;
      const gap = daysBetween(anchor, day);
      return gap >= 0 && gap % rule.n === 0;
    }
    default: return false;
  }
}

/**
 * Pulled out of the hours nothing may fire in, unless they named the time themselves.
 *
 * Late becomes 08:00 the next morning; early becomes 08:00 the same morning. Both keep the local
 * hour rather than adding a fixed number of milliseconds, which is the whole reason this is done in
 * wall-clock terms: on the night the clocks change, "08:00" and "eight hours later" are not the
 * same instant.
 */
export function outOfQuiet(ms, rule, timeZone) {
  if (rule.their_time) return ms;
  const p = partsIn(ms, timeZone);
  if (p.hour >= QUIET_START) return atLocal({ ...addDays(p, 1), hour: QUIET_END, minute: 0 }, timeZone);
  if (p.hour < QUIET_END) return atLocal({ year: p.year, month: p.month, day: p.day, hour: QUIET_END, minute: 0 }, timeZone);
  return ms;
}

/**
 * The first moment this rule lands on strictly after `after`. Null if there is none in two years,
 * which only a rule nothing can satisfy produces.
 *
 * Walks local calendar days rather than adding milliseconds, so "every Monday at 9" is 9 o'clock on
 * both sides of a daylight-saving change — 169 hours apart across the November one, not 168.
 */
export function nextOccurrence(rule, after, timeZone) {
  let day = dayOf(after, timeZone);
  for (let i = 0; i < 800; i++) {
    if (eligible(rule, day)) {
      const at = outOfQuiet(atLocal({ ...day, hour: rule.hour, minute: rule.minute }, timeZone), rule, timeZone);
      if (at > after) return at;
    }
    day = addDays(day, 1);
  }
  return null;
}

// ---------- saying it back ----------

function clockWords(hour, minute) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "am" : "pm";
  return minute ? `${h12}:${pad(minute)}${ampm}` : `${h12}${ampm}`;
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"][n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10];
  return `${n}${s}`;
};

/**
 * The schedule in the words a person would use, for the line Reason says back and for `series_list`.
 *
 * It exists so that the one sentence confirming a standing arrangement comes from the same place
 * the arrangement does. A model paraphrasing its own tool input is how somebody ends up being told
 * "every monday" for a series that really fires on Tuesdays.
 */
export function sayRule(rule) {
  const at = `at ${clockWords(rule.hour, rule.minute)}`;
  switch (rule.kind) {
    case "daily": return `every day ${at}`;
    case "weekdays": return `every weekday ${at}`;
    case "weekly": {
      const names = (rule.weekdays ?? []).map(d => DAY_NAMES[d]);
      const list = names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
      return `every ${list} ${at}`;
    }
    case "monthly": return `on the ${ordinal(rule.day_of_month)} of every month ${at}`;
    case "every_n_days":
      if (rule.n === 1) return `every day ${at}`;
      if (rule.n === 7) return `every week ${at}`;
      if (rule.n % 7 === 0) return `every ${rule.n / 7} weeks ${at}`;
      return `every ${rule.n} days ${at}`;
    default: return `${rule.kind} ${at}`;
  }
}

/**
 * One series as the model and the ledger see it. Their words and real times, never row internals.
 *
 * `next` is the firing that is actually armed, not the row's `next_at`. The two differ by design:
 * `scheduleOne` moves `next_at` PAST the timer it just made, so on a fresh Thu-Sun series `next_at`
 * already says Friday while Thursday's timer sits waiting. Reported raw, that read as "it skipped
 * Thursday" — the model told Omari exactly that on 2026-10-12, and armed two one-offs for a morning
 * that was never missing. So: the pending timer's time when there is one, `next_at` only when there
 * is not (paused, or between a firing and the next sweep).
 */
export function view(s) {
  if (!s) return null;
  const rule = parseRule(s.rule);
  const armed = s.state === "active" ? db.pendingSeriesTimer(s.id) : null;
  const nextAt = armed ? armed.fire_at : s.next_at;
  return {
    series_id: s.id,
    what: s.what,
    schedule: rule ? sayRule(rule) : "(unreadable rule)",
    state: s.state,
    time_zone: s.tz,
    next: nextAt ? stamp(nextAt) : null,
    checked_in: s.fired_count,
    last_fired: s.last_fired_at ? stamp(s.last_fired_at) : null,
    last_report: s.last_report || null,
    last_report_at: s.last_report_at ? stamp(s.last_report_at) : null,
    // A standing CALL rather than a check-in by text: every firing rings their phone with this.
    ...(s.call_goal ? { calls_them: s.call_goal } : {}),
    ...(s.state === "ended" ? { ended: stamp(s.ended_at), ended_why: s.ended_why || null } : {}),
  };
}

// ---------- the person's zone ----------

/**
 * Which clock this series runs on.
 *
 * The same answer everything else in Reason uses — their stated zone, then the one read off their
 * calendar, then the install's — and stored on the row rather than asked again at every firing, so a
 * standing nine o'clock does not quietly move when they travel and their calendar's zone changes.
 */
export function tzFor(conversationId) {
  try { return notice.settingsFor(conversationId).timeZone || config.tz; } catch { return config.tz; }
}

// ---------- making one ----------

/** The note the timer carries: the series' own words, in Reason's voice, like any other reminder. */
function noteFor(s) {
  return s.call_goal ? `standing call: ${s.what}` : `standing check-in: ${s.what}`;
}

/**
 * Start a series, and make its first firing in the same call.
 *
 * The first timer is made here rather than left to the next sweep for one reason worth saying: the
 * kept note puts "reminders you have set and not yet sent" in front of the model on every turn, and
 * somebody who has just been told "every monday 9am, i'll ask how the search is going" should see
 * that reminder exist from that moment, not fifteen seconds later.
 */
export function start({ conversationId, what, repeat, now = clock.now(), tz = null, callGoal = null }) {
  const said = String(what ?? "").trim();
  if (!said) return { ok: false, error: "A series needs `note` saying what it is about, in your own words." };
  const ringing = String(callGoal ?? "").trim() || null;
  const parsed = normalizeRule(repeat);
  if (!parsed.ok) return parsed;

  const cap = Number(config.maxSeries);
  if (cap > 0) {
    const running = db.countActiveSeries(conversationId);
    if (running >= cap) {
      return {
        ok: false,
        error: `They already have ${running} check-ins running, which is the limit (REASON_MAX_SERIES=${cap}).`
          + ` Do not set another quietly: show them what is running (series_list) and ask which one to stop.`,
      };
    }
  }

  const zone = tz || tzFor(conversationId);
  const rule = { ...parsed.rule };
  const first = nextOccurrence(rule, now, zone);
  if (!first) return { ok: false, error: `Nothing ever comes round for that rule (${sayRule(rule)}).` };
  // "Every two weeks" counts from the first one, so the anchor is the day it really lands on rather
  // than today — which matters when today is not an eligible day at all.
  if (rule.kind === "every_n_days") rule.anchor = dateKey(dayOf(first, zone));

  const s = db.createSeries(conversationId, { what: said, rule, tz: zone, nextAt: first, callGoal: ringing });
  const made = scheduleOne(s, { now });
  return { ok: true, series: view(db.getSeries(conversationId, s.id)), first: stamp(first), timer_id: made?.timer?.id ?? null };
}

// ---------- the sweep ----------

/**
 * One series, brought up to date: at most one pending timer, and `next_at` past it.
 *
 * The collapse is here. `next_at` may be hours or weeks old — the laptop was shut — and walking it
 * forward while the occurrence AFTER it is also in the past leaves the newest missed one, which is
 * the only one worth firing. The two older Mondays are not fired late and are not queued; they are
 * simply gone, which is what a person coming back to their phone wants.
 */
export function scheduleOne(s, { now = clock.now() } = {}) {
  if (!s || s.state !== "active") return null;
  if (db.pendingSeriesTimer(s.id)) return null;
  const rule = parseRule(s.rule);
  if (!rule) return null;
  const zone = s.tz || config.tz;

  let at = Number.isFinite(s.next_at) && s.next_at ? s.next_at : nextOccurrence(rule, now, zone);
  if (!at) return null;
  let collapsed = 0;
  if (at <= now) {
    for (let i = 0; i < 800; i++) {
      const after = nextOccurrence(rule, at, zone);
      if (!after || after > now) break;
      at = after;
      collapsed++;
    }
  }
  // An "every n days" row with no anchor cannot count from anywhere. `start` always writes one, so
  // this is for a row that lost it somehow: the occurrence being scheduled becomes the anchor, which
  // is the same thing `start` would have done, rather than every day quietly counting as eligible.
  if (rule.kind === "every_n_days" && !parseDateKey(rule.anchor)) {
    rule.anchor = dateKey(dayOf(at, zone));
    db.setSeriesRule(s.id, rule);
  }
  const next = nextOccurrence(rule, at, zone);
  // A standing call carries its goal onto every firing, so the fire path reads one timer row and
  // never has to know whether the ring was a one-off or the Tuesday of a series.
  const timer = db.createTimer(s.conversation_id, { fireAt: at, note: noteFor(s), seriesId: s.id, callGoal: s.call_goal || null });
  // Moved BEFORE the firing rather than after it: a firing somebody cancels by hand is then skipped
  // instead of being made again on the next sweep, and nothing can schedule the same occasion twice.
  db.setSeriesNext(s.id, next);
  return { series: s.id, timer, at, collapsed };
}

/**
 * Every live series, brought up to date. Called on each sweep, before the timers fire, so an
 * occurrence that is already due goes out on the same pass rather than fifteen seconds later.
 *
 * No model, no network, and nothing is sent from here: all it does is make timer rows.
 */
export function schedule({ now = clock.now() } = {}) {
  const made = [];
  for (const s of db.activeSeries()) {
    const one = scheduleOne(s, { now });
    if (one) made.push({ series: one.series, timer: one.timer.id, at: stamp(one.at), ...(one.collapsed ? { missed: one.collapsed } : {}) });
  }
  return made;
}

// ---------- what they said back ----------

/**
 * The first thing they say after a check-in is the answer to it.
 *
 * Code's job rather than the model's, because this is the part a model cannot be trusted with over
 * weeks: it has to be true on the turn AFTER the one that asked, and the asking turn is forty
 * trimmed messages back by then. Past the window the wait is dropped and the old report stands.
 *
 * Only ever one series: a person answering "two applications out" is answering the thing that just
 * asked, and filing it against two different arrangements would make both of them wrong.
 */
export function noteReport({ conversationId, text, now = clock.now() }) {
  const s = db.awaitingSeries(conversationId);
  if (!s) return null;
  if (now - Number(s.awaiting_since) > REPORT_WINDOW_MS) {
    db.clearSeriesAwaiting(s.id);
    return null;
  }
  const said = String(text ?? "").trim();
  if (!said) return null;
  db.setSeriesReport(s.id, said, { at: now });
  return { series: s.id, report: said.slice(0, 500) };
}

// ---------- what the model is handed when one fires ----------

/**
 * The extra lines a firing carries, on top of the timer's own note.
 *
 * Read off the row at fire time, not copied into the note when the timer was made, and that is the
 * point: the report may have arrived after this occurrence was scheduled, and a note written last
 * Monday would have Reason asking about the week before last.
 */
export function frameFor(s) {
  if (!s) return "";
  const rule = parseRule(s.rule);
  const which = s.fired_count + 1;
  const parts = [
    ` This is a standing check-in they asked for — ${rule ? sayRule(rule) : "on a schedule"}, number ${which}.`,
    ` It is about: ${s.what}.`,
  ];
  if (s.last_report) {
    parts.push(` Last time (${stamp(s.last_report_at)}) they said: "${s.last_report}".`
      + ` Ask about THAT and what has changed since — "last monday you said two applications were out, any replies?" is the shape.`
      + ` Never send the same line twice: a check-in that does not pick up where the last one left off is a cron job, not a friend.`);
  } else {
    parts.push(` This is the first one, so there is nothing they have said back yet: ask about the thing itself, short, in your own words.`);
  }
  parts.push(` One short message, this one thing, nothing else attached. If it genuinely is not worth sending — they are mid-conversation about something else entirely and it would land wrong — reply NO_REPLY; the series carries on and comes round again.`);
  return parts.join("");
}

// ---------- pause, resume, end ----------

/** Pending firings called off, for a pause or an end. The row decides; nothing is left armed. */
function callOffPending(s) {
  const stopped = [];
  for (const t of db.pendingSeriesTimers(s.id)) {
    const r = db.cancelTimer(s.conversation_id, t.id);
    if (r.ok) stopped.push(t.id);
  }
  return stopped;
}

export function pause({ conversationId, seriesId }) {
  const r = db.setSeriesState(conversationId, seriesId, "paused");
  if (!r.ok) return r;
  const stopped = callOffPending(r.series);
  return { ok: true, series: view(db.getSeries(conversationId, seriesId)), stopped_timers: stopped };
}

/**
 * Back on, from now. The next one is the next occurrence after this moment — never the one it would
 * have had while it was paused, which is in the past and was paused precisely so it would not fire.
 */
export function resume({ conversationId, seriesId, now = clock.now() }) {
  const r = db.setSeriesState(conversationId, seriesId, "active");
  if (!r.ok) return r;
  const rule = parseRule(r.series.rule);
  if (!rule) return { ok: false, error: `Series #${seriesId} has an unreadable rule; end it and set a new one.` };
  db.setSeriesNext(seriesId, nextOccurrence(rule, now, r.series.tz || config.tz));
  const made = scheduleOne(db.getSeries(conversationId, seriesId), { now });
  return { ok: true, series: view(db.getSeries(conversationId, seriesId)), timer_id: made?.timer?.id ?? null };
}

export function end({ conversationId, seriesId, why = null }) {
  const r = db.setSeriesState(conversationId, seriesId, "ended", { why });
  if (!r.ok) return r;
  const stopped = callOffPending(r.series);
  return { ok: true, series: view(db.getSeries(conversationId, seriesId)), stopped_timers: stopped };
}
