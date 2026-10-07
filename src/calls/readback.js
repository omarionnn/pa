// The details on a call that a pleasant tone hides a mistake in.
//
// The owner's rule, 2026-10-06: "Read back dates, time zones, prices, addresses and confirmation
// numbers. 'Tuesday at 3' is not settled until the actual date and time zone are clear. Numbers and
// times as words when spoken; the written record keeps the exact values."
//
// That last sentence is why this is a module and not two lines in the voice prompt, because it is two
// requirements pulling in opposite directions at the same moment:
//
//   SPOKEN — "Tuesday the fourteenth of October at three in the afternoon, Eastern Time." A person
//   on a phone can hear that and check it. They cannot hear "2026-10-14T15:00-04:00".
//
//   WRITTEN — `2026-10-14T15:00`, the zone as an IANA name, the price in cents, the confirmation
//   string character for character. The summary the owner reads, and anything a later call compares
//   against, uses this side. A spoken form that has been round-tripped back into a value has lost
//   the difference between "three" and "three thirty" to whoever transcribed it.
//
// So every detail carries both, built here from the value, and the model is never asked to do the
// arithmetic or the formatting. What the model does is say the spoken half and listen to the answer.
//
// The other half of this file is the opposite case: a detail Reason could not make out. `[inaudible]`
// in something about to be agreed to is not a detail, and the rule is to ask them to repeat it or
// spell it rather than to guess through it. `blockingUnclear` is what makes that structural — an
// agreement cannot be reached while a required detail is unclear, whatever the model thinks.
import { config } from "../config.js";

/**
 * The kinds of detail that have to be read back. Closed on purpose: this is the owner's list, and a
 * sixth kind appearing means somebody decided something that was not decided here.
 */
export const DETAIL_KINDS = ["date", "time", "price", "address", "confirmation"];

/**
 * A detail that is unclear rather than wrong.
 *
 * `src/voice.js` already writes `[inaudible]` into anything it transcribes and counts them with
 * `unclearCount`, so the marker is the one the rest of the codebase already uses rather than a new
 * one. The two extra shapes are what a speech-to-text layer produces when it is being honest about
 * a gap, and what a person says when they could not hear: both end up meaning the same thing here.
 */
const UNCLEAR = /\[inaudible\]|\[unclear\]|\?\?\?/i;

/** Is this value one Reason did not actually catch? */
export const isUnclear = (v) => UNCLEAR.test(String(v ?? ""));

// ---------- numbers, as a person says them ----------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * A whole number in words, the way it is said rather than the way it is written.
 *
 * "a hundred and eighty", not "one hundred eighty" — the owner is in the US but the places Reason
 * calls are not all, and "a hundred and eighty" is understood everywhere while reading digits is
 * the thing being avoided. Above a million it gives up and returns the digits: a price that large
 * is not a restaurant booking and saying it in words would be worse than saying it plainly.
 */
export function spokenNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n ?? "");
  if (num < 0) return `minus ${spokenNumber(-num)}`;
  const i = Math.floor(num);
  if (i !== num) return spokenNumber(i); // callers split their own decimals; see spokenMoney
  if (i < 20) return ONES[i];
  if (i < 100) {
    const t = TENS[Math.floor(i / 10)];
    return i % 10 ? `${t}-${ONES[i % 10]}` : t;
  }
  if (i < 1000) {
    // "a hundred and eighty", not "one hundred and eighty": the second is how it is written down and
    // the first is how it is said, and this whole file exists for the difference.
    const lead = Math.floor(i / 100);
    const h = lead === 1 ? "a hundred" : `${ONES[lead]} hundred`;
    const rest = i % 100;
    return rest ? `${h} and ${spokenNumber(rest)}` : h;
  }
  if (i < 1_000_000) {
    const th = `${spokenNumber(Math.floor(i / 1000))} thousand`;
    const rest = i % 1000;
    if (!rest) return th;
    // "two thousand and fifty", "two thousand one hundred and fifty" — the "and" only goes in
    // front of a bare tens/ones remainder, which is where a person puts it.
    return rest < 100 ? `${th} and ${spokenNumber(rest)}` : `${th} ${spokenNumber(rest)}`;
  }
  return String(i);
}

/**
 * Money in words. `cents` because that is how it is stored and compared; a float price is how two
 * quotes end up differing by a hundredth of a cent and sorting wrong.
 *
 * "a hundred and eighty dollars"; "two fifty" stays "two dollars fifty" rather than "two point five
 * zero". A whole number of dollars never says "zero cents", which is the giveaway of a machine.
 */
export function spokenMoney(cents, { currency = "dollars", unit = "cents" } = {}) {
  const c = Math.round(Number(cents));
  if (!Number.isFinite(c)) return String(cents ?? "");
  const whole = Math.floor(Math.abs(c) / 100);
  const part = Math.abs(c) % 100;
  const sign = c < 0 ? "minus " : "";
  // "one dollar", not "one dollars". The singular is the sort of thing that makes a voice sound like
  // a template being filled in, on the one line of the call where being believed matters.
  const big = `${spokenNumber(whole)} ${whole === 1 ? currency.replace(/s$/, "") : currency}`;
  if (!part) return `${sign}${big}`;
  if (!whole) return `${sign}${spokenNumber(part)} ${unit}`;
  return `${sign}${big} ${spokenNumber(part)}`;
}

/**
 * The written half: what goes in the record and what another quote is compared against.
 *
 * Strict about absence, and that strictness is the whole point of it being a function. `Number(null)`
 * is `0` and `Number.isFinite(0)` is `true`, so the obvious one-liner turns "they would not give me a
 * price" into "zero dollars" — and a quote of zero sorts to the top of a comparison and gets reported
 * as the cheapest option. That is the exact failure the owner named ("'best deal' must never silently
 * mean the lowest advertised price") arriving through a type coercion. A missing price is `null`, it
 * stays `null`, and the comparison leaves it out instead of winning with it.
 */
export function exactMoney(cents) {
  if (cents === null || cents === undefined || cents === "" || typeof cents === "boolean") return null;
  const n = Number(cents);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Was a price actually given? The question `exactMoney` exists to let callers ask honestly. */
export const hasMoney = (cents) => exactMoney(cents) !== null;

// ---------- dates and times, as a person says them ----------

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth",
  "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second",
  "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh",
  "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first"];

/** The parts of an instant in a given zone, as numbers, without re-parsing a formatted string. */
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: false,
  });
  const out = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

/**
 * The zone, in words somebody can confirm. "Eastern Time", not "America/New_York" and not "-04:00".
 *
 * `longGeneric` is deliberate over `long`: it gives "Eastern Time" rather than "Eastern Daylight
 * Time", so the spoken line does not turn on whether the booking is before or after the clocks
 * change — which is exactly the kind of detail that is right today and wrong in three weeks.
 */
export function spokenZone(tz = config.tz, { at = Date.now() } = {}) {
  for (const timeZoneName of ["longGeneric", "long", "short"]) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName }).formatToParts(new Date(at));
      const name = parts.find(p => p.type === "timeZoneName")?.value;
      if (name) return name;
    } catch { /* this runtime's ICU does not know that style; try the next */ }
  }
  return String(tz ?? "");
}

/** "Tuesday the fourteenth of October" — and the year too, when it is not the current one. */
export function spokenDate(ms, { tz = config.tz, now = Date.now() } = {}) {
  const p = partsIn(ms, tz);
  const thisYear = partsIn(now, tz).year;
  const day = ORDINALS[Number(p.day)] ?? p.day;
  const base = `${p.weekday} the ${day} of ${p.month}`;
  return p.year === thisYear ? base : `${base}, ${spokenNumber(Number(p.year))}`;
}

/**
 * "three in the afternoon", "half past seven in the evening", "twenty to eight in the morning".
 *
 * The same shape the voice prompt already asks for in general, done here so it is not the model's
 * arithmetic on the one value where being out by an hour is the whole failure.
 */
export function spokenTime(ms, { tz = config.tz } = {}) {
  const p = partsIn(ms, tz);
  const h24 = Number(p.hour) % 24;
  const m = Number(p.minute);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const partOfDay = h24 < 12 ? "in the morning" : h24 < 17 ? "in the afternoon" : h24 < 21 ? "in the evening" : "at night";
  if (m === 0) return `${spokenNumber(h12)} ${h24 === 12 ? "in the afternoon" : h24 === 0 ? "at night" : partOfDay}`;
  if (m === 15) return `quarter past ${spokenNumber(h12)} ${partOfDay}`;
  if (m === 30) return `half past ${spokenNumber(h12)} ${partOfDay}`;
  if (m === 45) {
    const next = (h12 % 12) + 1;
    return `quarter to ${spokenNumber(next)} ${h24 + 1 < 12 ? "in the morning" : partOfDay}`;
  }
  if (m > 30) {
    const next = (h12 % 12) + 1;
    return `${spokenNumber(60 - m)} to ${spokenNumber(next)} ${h24 + 1 < 12 ? "in the morning" : partOfDay}`;
  }
  return `${spokenNumber(m)} past ${spokenNumber(h12)} ${partOfDay}`;
}

/** Both halves of a moment: said as a person says it, kept as a value with its zone. */
export function spokenMoment(ms, { tz = config.tz, now = Date.now() } = {}) {
  return `${spokenDate(ms, { tz, now })} at ${spokenTime(ms, { tz })}, ${spokenZone(tz, { at: ms })}`;
}

/** The written half of a moment: an offset-free local stamp plus the zone it belongs to. */
export function exactMoment(ms, { tz = config.tz } = {}) {
  const p = partsIn(ms, tz);
  const pad = (n) => String(n).padStart(2, "0");
  // Asked for separately rather than read off `partsIn`, which formats the month as a name because
  // that is what the spoken half needs.
  const monthNum = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit" }).format(new Date(ms));
  return { local: `${p.year}-${monthNum}-${pad(p.day)}T${pad(Number(p.hour) % 24)}:${pad(Number(p.minute))}`, tz };
}

// ---------- spelling something out ----------

const NATO = {
  a: "alpha", b: "bravo", c: "charlie", d: "delta", e: "echo", f: "foxtrot", g: "golf", h: "hotel",
  i: "india", j: "juliet", k: "kilo", l: "lima", m: "mike", n: "november", o: "oscar", p: "papa",
  q: "quebec", r: "romeo", s: "sierra", t: "tango", u: "uniform", v: "victor", w: "whiskey",
  x: "x-ray", y: "yankee", z: "zulu",
};

/**
 * A confirmation number, said so it can be written down.
 *
 * "B as in bravo, four, seven, K as in kilo." Letters get a word because B/D/E/P/T/V are the same
 * sound down a phone line and a booking reference is useless one character wrong — which is the
 * whole reason the owner asked for spelling as well as reading back.
 *
 * Digits are said as digits in a code, never grouped: "four seven" and not "forty-seven", because
 * "forty-seven" is ambiguous between `47` and `407` to somebody writing it down.
 */
export function spellOut(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const said = [];
  for (const ch of s) {
    const lower = ch.toLowerCase();
    if (NATO[lower]) said.push(`${ch.toUpperCase()} as in ${NATO[lower]}`);
    else if (/[0-9]/.test(ch)) said.push(ONES[Number(ch)]);
    else if (ch === "-") said.push("dash");
    else if (ch === " ") said.push("space");
    else if (ch === "/") said.push("slash");
    else said.push(ch);
  }
  return said.join(", ");
}

/** Does this need spelling as well as saying? Anything with a letter in it does. */
export const needsSpelling = (value) => /[a-z]/i.test(String(value ?? ""));

// ---------- a detail, both halves at once ----------

/**
 * One detail to be read back.
 *
 * @param {{kind: string, value: any, label?: string, tz?: string, now?: number}} _
 * @returns {{kind: string, label: string, spoken: string, exact: any, unclear: boolean}}
 */
export function detail({ kind, value, label = "", tz = config.tz, now = Date.now() }) {
  const k = String(kind ?? "").toLowerCase();
  const unclear = isUnclear(value);
  const base = { kind: k, label: label || k, unclear };
  if (unclear) return { ...base, spoken: "", exact: null };
  switch (k) {
    case "date": return { ...base, spoken: spokenDate(value, { tz, now }), exact: exactMoment(value, { tz }) };
    case "time": return { ...base, spoken: `${spokenTime(value, { tz })}, ${spokenZone(tz, { at: value })}`, exact: exactMoment(value, { tz }) };
    case "price": return { ...base, spoken: spokenMoney(value), exact: exactMoney(value) };
    case "confirmation": {
      const v = String(value);
      const spoken = needsSpelling(v) ? `${v} — that's ${spellOut(v)}` : spellOut(v);
      return { ...base, spoken, exact: v };
    }
    // An address is said as it is: a house number is one of the few numbers a person does read as
    // digits, and "a hundred and eighty Lafayette Street" is not how anybody says it.
    case "address": return { ...base, spoken: String(value).trim(), exact: String(value).trim() };
    default: return { ...base, spoken: String(value ?? "").trim(), exact: value ?? null };
  }
}

/**
 * A moment as two details, which is the thing the owner's "'Tuesday at 3' is not settled" rule is
 * actually about: a date and a time and the zone, all three present, or it is not an agreement.
 */
export function moment({ at, tz = config.tz, now = Date.now(), label = "" }) {
  return [
    detail({ kind: "date", value: at, tz, now, label: label ? `${label} date` : "date" }),
    detail({ kind: "time", value: at, tz, now, label: label ? `${label} time` : "time" }),
  ];
}

// ---------- is this actually settled ----------

/**
 * Whether a set of details is complete enough to agree to, and what is missing if not.
 *
 * Two ways to fail, and they are told apart because the recovery is different. A detail Reason could
 * not hear is `unclear` and the answer is to ask them to repeat or spell it. A detail that was never
 * established at all — a time with no zone, a price nobody named — is `missing` and the answer is to
 * ask the question. Collapsing them would produce "sorry, could you repeat that?" about something
 * nobody has said yet.
 */
export function settled(details = [], { require: required = [] } = {}) {
  const list = details.filter(Boolean);
  const unclear = list.filter(d => d.unclear).map(d => d.label);
  const have = new Set(list.filter(d => !d.unclear).map(d => d.kind));
  // A detail that is present but was not heard is `unclear`, never also `missing`. It is one problem
  // with one fix — ask them to repeat it — and reporting it twice would have the call both asking
  // them to say it again and asking a question they have already answered.
  const attempted = new Set(list.map(d => d.kind));
  const missing = required.filter(k => !have.has(k) && !attempted.has(k));
  return { ok: !unclear.length && !missing.length, unclear, missing };
}

/**
 * The one that has teeth: an agreement cannot be reached while a required detail is unclear.
 *
 * Called by `src/calls/commit.js` before a commitment is allowed, so "they sounded like they said
 * yes and I think the price was a hundred and something" cannot become a booking. Returns the line
 * to say, or null when there is nothing in the way.
 */
export function blockingUnclear(details = []) {
  const bad = details.filter(d => d?.unclear).map(d => d.label);
  if (!bad.length) return null;
  const which = bad.length === 1 ? bad[0] : `${bad.slice(0, -1).join(", ")} and ${bad.at(-1)}`;
  return `Do not agree to anything yet: you did not catch the ${which}.`
    + ` Ask them to say it again, and if it has letters or numbers in it, ask them to spell it out.`
    + ` Only once you have it do you read the whole thing back.`;
}

// ---------- the line itself ----------

/**
 * What Reason is told to say before anything counts as agreed.
 *
 * An instruction rather than a finished sentence, for the same reason `announcementAgainIn` is: the
 * call may be in Spanish by now, and a hand-written English read-back line would be the wrong one.
 * What is not left to the model is *which* values, and in what form — those are the `spoken` halves
 * built above, quoted verbatim so the model has nothing to compute.
 */
export function readBackInstruction(details = []) {
  const list = details.filter(d => d && !d.unclear && d.spoken);
  if (!list.length) return "";
  const items = list.map(d => `- the ${d.label}: say exactly "${d.spoken}"`).join("\n");
  return [
    `Before this is agreed, read these back to them and get their yes on each one.`
    + ` Say them as the words given here, not as digits:`,
    items,
    `If they correct any of it, take the correction and read it back again. If they go quiet or you are`
    + ` not sure they confirmed, ask them directly rather than assuming. Nothing is settled until they`
    + ` have said yes to the whole thing.`,
  ].join("\n");
}

/** The written record of what was read back, for the call row and the owner's summary. */
export function recordOf(details = []) {
  const out = {};
  for (const d of details.filter(Boolean)) {
    if (d.unclear) { out[d.label] = { unclear: true }; continue; }
    out[d.label] = { kind: d.kind, exact: d.exact, spoken: d.spoken };
  }
  return out;
}
