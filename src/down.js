// When the model is down, a message is kept, not dropped.
//
// The failure (2026-10-17): the Claude CLI hit the subscription's session limit at 11:27am and
// stayed there until 3:10pm. Every text in that window got "ugh — that one broke on my end …
// say it again?" — and the texts themselves were gone. Omari had to repeat them hours later.
//
// So a turn that fails because the model is unavailable — the limit, an overloaded provider, no
// network — is not a stall. The texts go back into the holding table with a ready time at the
// reset the error names (or a short wait when it names none), the person is told ONCE that
// Reason is down and when it is back, and the sweep runs the turn when the time comes. The reply
// then opens by owning the gap and is pinned under the text it answers, so hours later it still
// reads as the answer it is.
//
// A turn that fails for any other reason — a bug, a tool throwing — still gets the stall line.
// Only outages are retried, because only outages end on their own.
import { clock, config } from "./config.js";

const MIN = 60_000;

/** How long to wait when the error says the model is down but not when it is back. */
export const RETRY_UNKNOWN_MS = 15 * MIN;
/** A minute past the named reset, so the first try is not a second too early. */
const CUSHION_MS = MIN;
/** How many times one text is re-held before the stall line goes out after all. */
export const MAX_REHOLDS = 8;

const OUTAGE_SHAPES = [
  /hit your .*limit/i,        // "You've hit your session limit · resets 7:10pm (UTC)"
  /usage limit/i,
  /rate[_ ]limit/i,
  /overloaded/i,
  /\b529\b/,
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed/i,
];

/**
 * What a failed turn's error says about the model being down: `{ until, known, why }` when it
 * is an outage, null when it is anything else.
 *
 *   until   when to try again (ms).
 *   known   whether `until` came from the error (a named reset) or is a guess.
 */
export function readOutage(err, { now = clock.now() } = {}) {
  const msg = String(err?.message ?? err ?? "").split("\n")[0];
  if (!OUTAGE_SHAPES.some(re => re.test(msg))) return null;
  const reset = resetTime(msg, now);
  return reset
    ? { until: reset + CUSHION_MS, resetAt: reset, known: true, why: msg }
    : { until: now + RETRY_UNKNOWN_MS, resetAt: null, known: false, why: msg };
}

/** An error the router catches to hold the texts rather than stall. */
export class OutageError extends Error {
  constructor({ until, resetAt = null, known, why, since }) {
    super(why);
    this.name = "OutageError";
    this.until = until;
    this.resetAt = resetAt;
    this.known = known;
    this.why = why;
    this.since = since;
  }
}

/**
 * The reset the error names, as a time — "resets 7:10pm (UTC)", "resets 3pm", "resets Oct 20 at
 * 9am (America/New_York)". Null when it names none. The next such wall-clock time in that zone;
 * no zone means the zone this process runs in, which is what the CLI prints in.
 */
export function resetTime(msg, now = clock.now()) {
  const m = /resets?\s+(?:on\s+)?(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(msg);
  if (!m) return null;
  const [, monthName, dayStr, yearStr, hStr, mStr, ampm, zone] = m;
  let hour = Number(hStr);
  const minute = Number(mStr ?? 0);
  if (ampm) {
    const pm = /pm/i.test(ampm);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  if (hour > 23 || minute > 59) return null;
  const tz = zoneOf(zone);
  const today = wallParts(now, tz);
  let month = today.month, day = today.day, year = today.year;
  if (monthName) {
    const mi = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    month = mi + 1;
    day = Number(dayStr);
    year = yearStr ? Number(yearStr) : today.year;
  }
  let at = wallToMs({ year, month, day, hour, minute }, tz);
  if (!monthName) {
    // A bare time is the next one: 7:10pm said at 7:20pm means tomorrow.
    if (at <= now) at = wallToMs({ year, month, day: day + 1, hour, minute }, tz);
  } else if (at <= now && !yearStr) {
    at = wallToMs({ year: year + 1, month, day, hour, minute }, tz);
  }
  return Number.isFinite(at) ? at : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function zoneOf(zone) {
  const z = String(zone ?? "").trim();
  if (!z) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (/^(utc|gmt|z)$/i.test(z)) return "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; }
  catch { return "UTC"; }
}

function wallParts(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find(p => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** The instant at which a zone's clocks read this wall time. Two passes, for a DST edge. */
function wallToMs({ year, month, day, hour, minute }, tz) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const w = wallParts(guess, tz);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    const diff = Date.UTC(year, month - 1, day, hour, minute) - asUtc;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

function clockWord(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: config.tz, hour: "numeric", minute: "2-digit" })
    .toLowerCase().replace(/\s+/g, "");
}

/**
 * The one line a person gets when their text arrived while the model was down. Code's words,
 * because the model is what is down; sent once per outage, however many texts land in it.
 */
export function downLine({ until, resetAt = null, known }) {
  const when = known ? ` (should be back around ${clockWord(resetAt ?? until)})` : "";
  return `heads up — my brain's offline for a bit${when}. i've got your message, and i'll answer it as soon as i'm back.`;
}

/**
 * The line the turn reads when the texts it is answering were left during an outage, so the
 * reply opens by owning the gap instead of answering as if no time had passed.
 */
export function leftWhileDownLine({ since, now = clock.now(), count = 1 }) {
  const these = count > 1 ? "these texts were" : "this text was";
  return `[reason was down from ${clockWord(since)} until ${clockWord(now)} and could not answer. ${these} left during that time and ${count > 1 ? "are" : "is"} being answered now: open with a few words owning the gap, then answer properly]`;
}
