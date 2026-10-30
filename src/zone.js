// Whose clock. Until 2026-10-30 every reminder, calendar write, scheduled call and stamp ran on the
// install's zone (Eastern) for everybody, and only the notice sweep had a per-person zone. This is
// the per-person zone: a best guess said out loud with its reason, asked ONCE before the first
// clock-time action, the action held so their answer finishes it, and the answer kept and used
// everywhere (`config.tz` inside their turn and their Web pages — src/zonescope.js).
//
// Rules (owner, 2026-10-30):
// - Nobody is asked until they do something with a clock time in it. Nobody existing is messaged.
// - Until they confirm, behaviour is exactly the old one: the install's zone.
// - "In 10 minutes" needs no zone, so it never waits on the question.
// - A shared location in another zone is asked about once ("switch to Central?"), never applied
//   silently; saying their zone changed works any time.
import { readFileSync } from "node:fs";
import tzlookup from "@photostructure/tz-lookup";
import { config, clock } from "./config.js";
import * as db from "./db.js";
import * as zonescope from "./zonescope.js";

const HOUR = 3_600_000;
/** How long a held action waits for the answer before it is dropped rather than done stale. */
export const PENDING_TTL_MS = 2 * HOUR;

// ---------- names ----------

/** A real IANA zone (has a region, or is UTC). "EST" and "+05:00" are not answers worth keeping. */
export function isIana(name) {
  const s = String(name ?? "").trim();
  if (!s || (!s.includes("/") && s !== "UTC")) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return true; } catch { return false; }
}

/** "Eastern", "Central", "Pacific", "Greenwich Mean", "India Standard" — how a person says it. */
export function zoneLabel(tz, at = clock.now()) {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" })
      .formatToParts(at).find(p => p.type === "timeZoneName")?.value || tz;
    return name.replace(/ Time$/, "");
  } catch { return tz; }
}

/** Minutes east of UTC for this zone at this instant. */
export function offsetMin(tz, at = clock.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const g = (t) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/** Two zones that keep the same clock now and across the year — Detroit and New York, say. */
export function sameClock(a, b, at = clock.now()) {
  if (!a || !b) return false;
  if (a === b) return true;
  const year = new Date(at).getUTCFullYear();
  return [at, Date.UTC(year, 0, 15), Date.UTC(year, 6, 15)].every(t => offsetMin(a, t) === offsetMin(b, t));
}

// ---------- the person's zone ----------

/** What they confirmed, or "". */
export function confirmedZone(conversationId) {
  const z = db.zoneRow(conversationId)?.confirmed || "";
  return isIana(z) ? z : "";
}

/** The zone their clock times are read and shown in: confirmed, else the install's (the old behaviour). */
export function zoneFor(conversationId) {
  return confirmedZone(conversationId) || config.installTz;
}

zonescope.setResolver(confirmedZone);

// ---------- the guess ----------

let PHONE = null;
function phoneMap() {
  if (PHONE) return PHONE;
  PHONE = new Map();
  const text = readFileSync(new URL("./phone-zones.txt", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [prefix, zones] = line.split("|");
    if (prefix && zones) PHONE.set(prefix.trim(), zones.trim().split("&"));
  }
  return PHONE;
}

/**
 * A zone from a phone number alone: the longest libphonenumber prefix that names one clock. A prefix
 * that spans clocks (+1 with no known area code, Russia's +7) is no guess at all.
 */
export function zoneFromPhone(address) {
  const digits = String(address ?? "").replace(/[^\d]/g, "");
  if (!/^\+?\d/.test(String(address ?? "").trim()) || digits.length < 8) return null;
  const map = phoneMap();
  for (let n = Math.min(digits.length, 10); n >= 1; n--) {
    const zones = map.get(digits.slice(0, n));
    if (!zones) continue;
    const valid = zones.filter(isIana);
    if (!valid.length) return null;
    const one = valid.every(z => sameClock(z, valid[0])) ? (valid.includes("Europe/London") ? "Europe/London" : valid[0]) : null;
    if (!one) return null;
    const nanp = digits.startsWith("1") && digits.length >= 4;
    // Calling codes are prefix-free, so the shortest prefix the map knows is the country's.
    let cc = 1;
    while (cc < 3 && !map.has(digits.slice(0, cc))) cc++;
    return { zone: one, areaCode: nanp ? digits.slice(1, 4) : "", countryPrefix: nanp ? "1" : digits.slice(0, cc) };
  }
  return null;
}

/** The zone a coordinate is in (offline), or "". */
export function zoneAt(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return "";
  try { const z = tzlookup(Number(lat), Number(lng)); return isIana(z) ? z : ""; } catch { return ""; }
}

/**
 * Best guess with the reason, strongest first: confirmed > the browser zone from Reason Web > the
 * last shared location > their connected calendar's zone > the phone number > the install's zone.
 * `signal` is a key; `because` is the plain reason the model puts in its own words.
 */
export function guessZone(conversationId) {
  const row = db.zoneRow(conversationId);
  const pick = (zone, signal, because) => ({ zone, label: zoneLabel(zone), signal, because });
  if (row?.confirmed && isIana(row.confirmed)) return pick(row.confirmed, "confirmed", "they told you");
  if (row?.web && isIana(row.web)) return pick(row.web, "web", "the browser they use for Reason Web is set to it");
  if (row?.place && isIana(row.place)) return pick(row.place, "location", "the location they last shared is there");
  let calendar = "";
  try { calendar = db.noticeSweep(conversationId)?.time_zone || ""; } catch { calendar = ""; }
  if (isIana(calendar)) return pick(calendar, "calendar", "their connected calendar is set to it");
  const thread = (() => { try { return db.getThread(conversationId); } catch { return null; } })();
  const phone = zoneFromPhone(row?.address || thread?.address || "");
  if (phone) {
    return pick(phone.zone, "phone", phone.areaCode
      ? `their number is a ${phone.areaCode} area code`
      : `their number starts +${phone.countryPrefix}`);
  }
  return pick(config.installTz, "default", "nothing else to go on, so it is the default");
}

// ---------- the question, before the first clock-time action ----------

/** Tools that write a clock time down, and whether this call really carries one. */
const CLOCK_TOOLS = {
  timer_set: (i) => !!i.repeat || (!!i.fire_at && i.relative !== true),
  commitment_set: () => true,
  calendar_create: (i) => !!i.start,
  calendar_change: (i) => i.start !== undefined || i.end !== undefined,
  apple_calendar_create: (i) => !!i.start,
  apple_calendar_change: (i) => i.start !== undefined || i.end !== undefined,
  // An event with its own zone (one in another city) says where its clock is; only a bare one asks.
  event_create: (i) => !!i.starts_at && !i.timezone,
};

/**
 * Before a clock-time action: null to go ahead, or the refusal that holds the action and hands the
 * model the guess to ask about. Asked once per action; a held action is replaced by the newest.
 */
export function gate(conversationId, name, input, { now = clock.now(), kind = "user" } = {}) {
  if (!config.tzAsk || !conversationId) return null;
  // Only on something THEY asked for. A timer firing or a check-in Reason starts itself never asks
  // (nobody existing is messaged about this unprompted); those keep the old clock until they confirm.
  if (kind && kind !== "user") return null;
  const needs = CLOCK_TOOLS[name];
  if (!needs || !needs(input ?? {})) return null;
  const row = db.zoneRow(conversationId);
  if (!row) return null;
  if (row.confirmed && isIana(row.confirmed)) return null;
  // The operator's zone is known (owner, 2026-10-30) — an account made after boot is confirmed here.
  if (row.isOperator) { db.setZoneFields(conversationId, { confirmed: config.installTz, confirmedAt: now }); return null; }
  const guess = guessZone(conversationId);
  // Every clock-time call of the turn is held ("at 9 and again at 5" is two), each kept until the answer.
  const held = heldList(row.pending).filter(p => now - Number(p.at || 0) <= PENDING_TTL_MS);
  db.setZoneFields(conversationId, { pending: [...held, { tool: name, input, guess: guess.zone, at: now }].slice(-5) });
  return {
    ok: false, status: "confirm_time_zone", held: true,
    guess: { zone: guess.zone, name: `${guess.label} time`, because: guess.because, signal: guess.signal },
    error: `Nothing is set yet: this is the first time they have asked for something at a clock time, and you do not know their time zone for sure.`
      + ` Your best guess is ${guess.label} time (${guess.zone}) because ${guess.because}.`
      + ` Ask them ONCE, in one short natural line before anything else, saying the guess and why you guessed it, and whether that is right.`
      + ` Do not give them words to reply with. When they answer, call time_zone with the zone they confirmed or named — that call also does`
      + ` what they just asked for, so do NOT call ${name} again yourself and do not ask them to repeat it.`,
  };
}

// ---------- the answer ----------

/** Held calls, whether stored as one (before 2026-10-30's review) or a list. */
function heldList(pending) {
  if (!pending) return [];
  return (Array.isArray(pending) ? pending : [pending]).filter(p => p && p.tool);
}

const WALL = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** "2026-11-01T01:30:00" read as a wall clock in `tz`, to an instant. DST gaps roll forward. */
export function wallToInstant(wall, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall);
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  // Two candidates — the offset either side of a DST change. The one that reads back as the same
  // wall clock wins (the earlier, when a fall-back hour happens twice); a spring-forward hour that
  // never happens rolls FORWARD (2:30 that night is 3:30), never back an hour.
  const t1 = asUtc - offsetMin(tz, asUtc - 12 * HOUR) * 60_000;
  const t2 = asUtc - offsetMin(tz, asUtc + 12 * HOUR) * 60_000;
  const reads = (t) => t + offsetMin(tz, t) * 60_000 === asUtc;
  const fits = [t1, t2].filter(reads);
  return fits.length ? Math.min(...fits) : Math.max(t1, t2);
}

/** An ISO string with the zone's offset at that instant. */
export function isoIn(ms, tz) {
  const off = offsetMin(tz, ms);
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/**
 * The held action, re-read in the confirmed zone. The clock time they SAID is kept — "9 tomorrow" is
 * 9 in the zone they confirmed, whatever offset was written while the zone was a guess.
 */
export function rewriteForZone(name, input, tz, { wroteIn = config.installTz } = {}) {
  const out = { ...(input ?? {}) };
  // The clock time as they said it. A written offset ("09:00-04:00") keeps its wall clock; a UTC
  // "Z" was converted from the clock the model was reading (the install's, before they confirmed),
  // so it goes back to that wall clock first — "13:00Z" written for 9am Eastern is 9am, not 1pm.
  const wallOf = (v) => {
    const t = String(v).trim();
    const m = WALL.exec(t);
    if (!m) return null;
    if (/Z$/i.test(t)) { const at = Date.parse(t); return Number.isFinite(at) ? isoIn(at, wroteIn).slice(0, 19) : null; }
    return m[1];
  };
  if (name === "timer_set" && typeof out.fire_at === "string") {
    const w = wallOf(out.fire_at);
    if (w) { const t = wallToInstant(w.length === 16 ? `${w}:00` : w, tz); if (Number.isFinite(t)) out.fire_at = isoIn(t, tz); }
  }
  if (/calendar_(create|change)$/.test(name)) {
    for (const k of ["start", "end"]) {
      if (typeof out[k] !== "string") continue;
      const w = wallOf(out[k]);
      if (w) out[k] = w;
    }
  }
  if (name === "commitment_set") out.time_zone = tz;
  if (name === "event_create" && !out.timezone) out.timezone = tz;
  return out;
}

/**
 * Keep their zone. Returns what was saved and the held action (fresh, rewritten) if there is one —
 * the caller runs it, so their answer finishes what they asked for.
 */
export function confirm(conversationId, tz, { now = clock.now() } = {}) {
  if (!isIana(tz)) return { ok: false, error: `'${tz}' is not a time zone name. Use an IANA name like America/Chicago; if you are not sure which, ask them what city they are in.` };
  const before = db.zoneRow(conversationId);
  if (!before) return { ok: false, error: "No account for this conversation." };
  db.setZoneFields(conversationId, { confirmed: tz, confirmedAt: now, pending: null, travelAsked: "" });
  const fresh = heldList(before.pending).filter(p => now - Number(p.at || 0) <= PENDING_TTL_MS);
  return {
    ok: true, zone: tz, name: `${zoneLabel(tz, now)} time`,
    changed_from: before.confirmed && before.confirmed !== tz ? before.confirmed : "",
    held: fresh.map(p => ({ tool: p.tool, input: rewriteForZone(p.tool, p.input, tz) })),
  };
}

// ---------- travel ----------

/**
 * A shared location seen. Kept as a guess signal; and when it puts them on a different clock from
 * the zone they confirmed, the travel question — once per zone, never applied silently.
 */
export function sawLocation(conversationId, lat, lng, { now = clock.now() } = {}) {
  const here = zoneAt(lat, lng);
  if (!here) return null;
  const row = db.zoneRow(conversationId);
  if (!row) return null;
  db.setZoneFields(conversationId, { place: here, placeAt: now });
  if (!row.confirmed || sameClock(here, row.confirmed, now)) return null;
  if (row.travelAsked && sameClock(row.travelAsked, here, now)) return null;
  db.setZoneFields(conversationId, { travelAsked: here });
  const city = here.split("/").pop().replace(/_/g, " ");
  return {
    now_in: here, name: `${zoneLabel(here, now)} time`, near: city,
    their_zone: row.confirmed, their_zone_name: `${zoneLabel(row.confirmed, now)} time`,
    note: `This location is on ${zoneLabel(here, now)} time (near ${city}), but their reminders run on ${zoneLabel(row.confirmed, now)} time.`
      + ` Ask them ONCE, in a short natural line alongside whatever you were doing, whether to switch to ${zoneLabel(here, now)} time.`
      + ` Change nothing unless they say yes — then call time_zone. If they say no, leave it; you will not be told about this zone again.`,
  };
}

/** The browser's own zone, from a signed-in Reason Web page. A guess signal only. */
export function sawBrowserZone(conversationId, tz) {
  if (!conversationId || !isIana(tz)) return false;
  const row = db.zoneRow(conversationId);
  if (!row || row.web === tz) return false;
  db.setZoneFields(conversationId, { web: tz });
  return true;
}

/** Boot: the operator's own account starts confirmed on the install's zone. */
export function preconfirmOperator() {
  try { return db.preconfirmOperatorZone(config.installTz); } catch { return 0; }
}
