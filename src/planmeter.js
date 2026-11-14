// Plan meters: how much of a provider's monthly plan Reason has used this cycle, for the ops page, and
// one text to the owner as it crosses 50%, 80% and 100% (owner 2026-11-13: "know the usage and the
// cost on the ops page, and alert me at like 50%, 80%").
//
// A meter is a few lines (METERS below). Two shapes:
//
//   - a monthly one (Cartesia): an allowance in cents, a rate per minute, the day of the month the
//     plan refreshes; each threshold texts once per cycle, and a new cycle starts over.
//   - a standing one (`standing: true`, Plaid): a count against a cap, with no cycle. Each threshold
//     texts once as the count crosses it going up, and is re-armed when the count drops back below.
//
// And where the usage comes from:
//
//   - `own`: Reason's own count, from its call rows. Always there, and always an estimate.
//   - `remote` (optional): the provider's own figure, read-only, at most every REMOTE_EVERY_MS, from
//     the five-minute ops pass and never from a call. When it is there it is the number the meter
//     and the texts go by, and the page shows both. When it fails the last good one stays, the page
//     says how old it is, and the pass carries on.
//
// Numbers only: no names, numbers or anything said on a call ever reaches a reading.
//
// The cycle is in UTC days, which is how Cartesia buckets its usage (docs.cartesia.ai/api-reference/
// usage/agents: "Rounded down to the start of the UTC day").
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { configured as plaidConfigured, slotsUsed as plaidSlotsUsed } from "./plaid.js";
// Cartesia's API, as in src/calls/cartesia.js (not imported: the relay loads only for a Cartesia call).
const CARTESIA_BASE = "https://api.cartesia.ai";
const CARTESIA_VERSION = "2026-08-14";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How old the provider's figure may be before the next pass asks again. */
export const REMOTE_EVERY_MS = 15 * 60 * 1000;
const REMOTE_TIMEOUT_MS = 8000;

// ---------- the cycle ----------

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** The refresh day in month `m` of year `y`, clamped to a short month (the 30th in February is the 28th or 29th). */
const refreshIn = (y, m, day) => Date.UTC(y, m, Math.min(day, daysIn(y, m)));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The cycle `now` falls in: from the last refresh (inclusive, UTC midnight) to the next one. On the
 * refresh day itself the new cycle has begun.
 */
export function cycleWindow(now, cycleDay) {
  const d = new Date(now);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const day = Math.min(31, Math.max(1, Math.round(Number(cycleDay) || 1)));
  const thisMonth = refreshIn(y, m, day);
  const start = now >= thisMonth ? thisMonth : refreshIn(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, day);
  const s = new Date(start);
  const end = refreshIn(s.getUTCMonth() === 11 ? s.getUTCFullYear() + 1 : s.getUTCFullYear(), (s.getUTCMonth() + 1) % 12, day);
  return { start, end, startDay: isoDay(start), endDay: isoDay(end) };
}

// ---------- the reading ----------

/**
 * Where a meter stands: `used` in cents and minutes (the provider's figure when there is one, else
 * Reason's own), the share of the allowance, minutes left at the rate, and the projection from the
 * pace so far. Pure: the usage is handed in.
 */
export function reading(meter, { now, own, remote = null }) {
  if (meter.standing) return standingReading(meter, own);
  const w = cycleWindow(now, meter.cycleDay);
  const rate = meter.centsPerMinute;
  const source = remote?.cents != null ? "provider" : "own";
  const usedCents = source === "provider" ? Number(remote.cents) : Number(own.cents);
  const usedMin = source === "provider" && remote.minutes != null ? Number(remote.minutes) : rate > 0 ? usedCents / rate : 0;
  const allowance = meter.allowanceCents;
  const pct = allowance > 0 ? (usedCents / allowance) * 100 : 0;
  const elapsed = Math.max(0, Math.min(now, w.end) - w.start);
  const span = w.end - w.start;
  // Pace over at least an hour, so the first call of a cycle does not project the whole plan by noon.
  const pace = usedCents / Math.max(elapsed, 60 * 60 * 1000); // cents per ms
  const projected = Math.round(usedCents + pace * Math.max(0, w.end - now));
  const leftCents = Math.max(0, allowance - usedCents);
  const runsOutAt = usedCents >= allowance ? null : pace > 0 ? now + leftCents / pace : null;
  return {
    id: meter.id, name: meter.name, cycle: w,
    source, allowance_cents: allowance, cents_per_minute: rate,
    used_cents: Math.round(usedCents * 100) / 100, used_minutes: Math.round(usedMin * 10) / 10,
    allowance_minutes: rate > 0 ? Math.round(allowance / rate) : 0,
    left_minutes: rate > 0 ? Math.floor(leftCents / rate) : 0,
    pct: Math.round(pct * 10) / 10,
    projected_cents: projected,
    projected_pct: allowance > 0 ? Math.round((projected / allowance) * 100) : 0,
    // Within this cycle only: running out after the refresh is not running out.
    runs_out_at: runsOutAt != null && runsOutAt < w.end ? Math.round(runsOutAt) : null,
    out: usedCents >= allowance,
    day_of_cycle: Math.floor(elapsed / DAY_MS) + 1, days_in_cycle: Math.round(span / DAY_MS),
    own: { cents: Math.round(Number(own.cents) * 100) / 100, minutes: Math.round((Number(own.seconds) / 60) * 10) / 10, calls: Number(own.calls) || 0, fell_back: own.fellBack ?? null },
    remote: remote ? { cents: remote.cents ?? null, minutes: remote.minutes ?? null, calls: remote.calls ?? null, at: remote.at ?? null, error: remote.error ?? null } : null,
  };
}

/** A standing count against a cap: how many, of how many, and the share. No cycle, no pace. */
export function standingReading(meter, own) {
  const used = Math.max(0, Math.round(Number(own.count) || 0));
  const allowance = Math.max(0, Math.round(Number(meter.allowance) || 0));
  return {
    id: meter.id, name: meter.name, standing: true, unit: meter.unit, source: "own",
    used, allowance, left: Math.max(0, allowance - used),
    pct: allowance > 0 ? Math.round((used / allowance) * 1000) / 10 : 0,
    out: allowance > 0 && used >= allowance,
  };
}

// ---------- the meters ----------

/**
 * Banks connected through Plaid (Plaid calls each an Item), across everyone, EVER: Plaid's Trial counts
 * every Item created and /item/remove does not give one back (src/plaid.js slotsUsed). So a bank they
 * disconnected still counts. A count, never which bank or whose.
 */
function plaidOwn() {
  const live = db.db.prepare("SELECT COUNT(*) AS n FROM plaid_items WHERE status != 'removing'").get().n;
  return { count: Math.max(live, plaidSlotsUsed()) };
}

/** Reason's own count of the Cartesia voice this cycle, from the call rows the relay writes. */
function cartesiaOwn({ start, end }) {
  const r = db.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cartesia_seconds), 0) AS secs,
      COALESCE(SUM(cartesia_fell_back), 0) AS fell FROM calls
    WHERE cartesia_seconds IS NOT NULL AND created_at >= ? AND created_at < ?`).get(start, end);
  const rate = config.cartesiaRateUsdPerMin * 100;
  return { seconds: r.secs, cents: (r.secs / 60) * rate, calls: r.calls, fellBack: r.fell };
}

/** Cartesia's own figure: GET /usage/agents for the cycle, one bucket. Needs an admin key. */
async function cartesiaRemote({ start, now, fetchImpl }) {
  const q = new URLSearchParams({ start_ts: new Date(start).toISOString(), end_ts: new Date(Math.max(now, start + 1000)).toISOString() });
  const res = await fetchImpl(`${CARTESIA_BASE}/usage/agents?${q}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.cartesiaAdminKey}`, "Cartesia-Version": CARTESIA_VERSION },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error("no data in the answer");
  const sum = (k) => body.data.reduce((t, b) => t + (Number(b?.[k]) || 0), 0);
  return { cents: sum("cents"), minutes: Math.round(sum("minutes") * 10) / 10, calls: sum("calls") };
}

/**
 * Every plan Reason meters. Another provider is another entry: `own` reads its calls, `remote` its
 * provider's figure if it has one.
 */
export const METERS = [
  {
    id: "cartesia", name: "Cartesia calls",
    get allowanceCents() { return Math.round(config.cartesiaPlanUsd * 100); },
    get centsPerMinute() { return config.cartesiaRateUsdPerMin * 100; },
    get cycleDay() { return config.cartesiaCycleDay; },
    thresholds: [50, 80, 100],
    configured: () => !!(config.cartesiaKey && config.cartesiaAgentId),
    own: cartesiaOwn,
    remote: () => config.cartesiaAdminKey ? cartesiaRemote : null,
    dashboard: "https://play.cartesia.ai/usage",
    // What happens when it runs out, said in the 100% text and on the page.
    whenOut: "Calls fall back to the old voice when it does.",
    whenOutNow: "Calls are falling back to the old voice until the credits refresh.",
  },
  {
    id: "plaid", name: "Plaid banks", standing: true, unit: "bank connections",
    get allowance() { return config.plaidPlanItems; },
    thresholds: [50, 80, 100],
    configured: () => plaidConfigured(),
    own: plaidOwn,
    dashboard: "https://dashboard.plaid.com/",
    whenOut: (r) => `New connections stop at ${r.allowance} on the trial plan.`,
    whenOutNow: (r) => `New connections stop here on the trial plan: ${r.allowance} is the most it allows.`,
  },
];

// ---------- the provider's figure, cached ----------

const remoteKey = (id) => `plan:${id}:remote`;
function cachedRemote(id) {
  try { return JSON.parse(db.opsGet(remoteKey(id)) ?? "null"); } catch { return null; }
}

/**
 * Ask the provider again if its figure is older than REMOTE_EVERY_MS (or from another cycle). Kept in
 * ops_state so a restart does not ask again at once. Never throws: a failure is kept beside the last
 * good figure, and the page says so.
 */
export async function refreshRemote(meter, { now = clock.now(), fetchImpl = globalThis.fetch } = {}) {
  const ask = meter.remote?.();
  if (!ask) return null;
  const w = cycleWindow(now, meter.cycleDay);
  const old = cachedRemote(meter.id);
  const sameCycle = old?.cycle === w.startDay;
  if (sameCycle && old.tried && now - old.tried < REMOTE_EVERY_MS) return old;
  let next;
  try {
    const got = await ask({ start: w.start, end: w.end, now, fetchImpl });
    next = { ...got, at: now, tried: now, cycle: w.startDay, error: null };
  } catch (e) {
    const why = String(e?.message ?? e).split("\n")[0].slice(0, 120);
    next = sameCycle && old.at ? { ...old, tried: now, error: why } : { cycle: w.startDay, tried: now, at: null, cents: null, minutes: null, calls: null, error: why };
  }
  try { db.opsSet(remoteKey(meter.id), JSON.stringify(next)); } catch { /* the page shows the last one */ }
  return next;
}

/** A meter's reading now, from the cached provider figure (if any) and Reason's own count. */
export function readMeter(meter, { now = clock.now() } = {}) {
  if (meter.standing) return standingReading(meter, meter.own());
  const w = cycleWindow(now, meter.cycleDay);
  const own = meter.own(w);
  const cached = meter.remote?.() ? cachedRemote(meter.id) : null;
  const remote = cached && cached.cycle === w.startDay ? cached : null;
  const r = reading(meter, { now, own, remote: remote?.cents != null ? remote : null });
  // A provider figure that has never come back is still worth saying (the error) on the page.
  if (!r.remote && remote) r.remote = { cents: null, minutes: null, calls: null, at: null, error: remote.error ?? null };
  return r;
}

/** Every configured meter's reading, for the report. One meter that fails to read is left out, never the pass. */
export async function readAll({ now = clock.now(), fetchImpl = globalThis.fetch, meters = METERS } = {}) {
  const out = [];
  for (const m of meters) {
    if (!m.configured()) continue;
    try { await refreshRemote(m, { now, fetchImpl }); } catch { /* the reading says how old the figure is */ }
    try { out.push(readMeter(m, { now })); } catch { /* left out this pass */ }
  }
  return out;
}

// ---------- words ----------

const usd = (cents) => `$${(Number(cents) / 100).toFixed(2).replace(/\.00$/, "")}`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const dayOf = (ms) => ordinal(new Date(ms).getUTCDate());
const shortDay = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const mins = (m) => (Math.round(m) === m ? String(m) : m.toFixed(1)).replace(/\.0$/, "");

/** The ops row's one line. */
export function detailOf(r) {
  if (r.standing) return `${r.used} of ${r.allowance} ${r.unit} · ${Math.round(r.pct)}% · ${r.left} left`;
  const parts = [
    `${Math.round(r.pct)}% of ${usd(r.allowance_cents)} · ${mins(r.used_minutes)} of ${r.allowance_minutes} min`,
    `${r.left_minutes} min left`,
    `cycle ${shortDay(r.cycle.start)}–${shortDay(r.cycle.end)}`,
    r.out ? "credit used up" : r.runs_out_at ? `at this pace runs out around the ${dayOf(r.runs_out_at)}` : `on pace for ${usd(r.projected_cents)}`,
  ];
  if (r.own.fell_back) parts.push(`${r.own.fell_back} fell back to the old voice`);
  parts.push(r.source === "provider" ? "Cartesia's figure" : "Reason's estimate");
  return parts.join(" · ");
}

/** The threshold texts owed right now: the highest crossed and not yet sent this cycle, and the lower ones it covers. */
export function due(meter, r) {
  const crossed = meter.thresholds.filter(t => r.pct >= t);
  if (!crossed.length) return null;
  const keys = crossed.map(t => ({ t, key: warnKey(meter, r, t) }));
  const unsent = keys.filter(k => !db.opsGet(k.key));
  if (!unsent.length) return null;
  const top = Math.max(...unsent.map(k => k.t));
  return { threshold: top, keys: unsent.map(k => k.key), text: textFor(meter, r, top) };
}

/** Where a threshold's text is marked sent: per cycle for a monthly meter, standing for a count. */
const warnKey = (meter, r, t) => meter.standing ? `plan_warn:${meter.id}:${t}` : `plan_warn:${meter.id}:${r.cycle.startDay}:${t}`;

/** "Cartesia: 80% of this month's $5 call credit used (132 of 165 minutes). …" */
export function textFor(meter, r, threshold) {
  if (meter.standing) {
    const head = `${meter.name.split(" ")[0]}: ${r.used} of ${r.allowance} ${r.unit} used (${Math.round(r.pct)}%).`;
    return `${head} ${threshold >= 100 ? meter.whenOutNow(r) : meter.whenOut(r)}`;
  }
  const name = meter.name.split(" ")[0];
  const head = `${name}: ${threshold}% of this month's ${usd(r.allowance_cents)} call credit used (${Math.round(r.used_minutes)} of ${r.allowance_minutes} minutes).`;
  if (threshold >= 100) return `${head} ${meter.whenOutNow} Credits refresh on the ${dayOf(r.cycle.end)}.`;
  const pace = r.runs_out_at ? ` At this pace it runs out around the ${dayOf(r.runs_out_at)}.` : " At this pace it lasts until the refresh.";
  return `${head}${pace} ${meter.whenOut}`;
}

/**
 * Send each meter's text owed, once per threshold per cycle. Marked before it is sent, in ops_state,
 * so a restart never sends it again; a new cycle has new keys. Reads the readings the pass just saved.
 */
export function warnings({ readings, send, log = () => {}, now = clock.now(), meters = METERS }) {
  if (!send) return [];
  const sent = [];
  for (const r of readings ?? []) {
    const meter = meters.find(m => m.id === r.id);
    if (!meter) continue;
    // A reading from a cycle that has ended (an old report after a restart) is old news.
    if (!meter.standing && !(r.cycle?.end > now)) continue;
    // A standing count that has dropped back below a threshold re-arms it: crossing it again texts again.
    if (meter.standing) for (const t of meter.thresholds) if (r.pct < t) db.opsDelete(warnKey(meter, r, t));
    const d = due(meter, r);
    if (!d) continue;
    for (const k of d.keys) db.opsSet(k, String(now));
    const idem = meter.standing ? `ops:plan_warn:${meter.id}:${d.threshold}:${now}` : `ops:plan_warn:${meter.id}:${r.cycle.startDay}:${d.threshold}`;
    try { Promise.resolve(send(d.text, idem)).catch(e => log({ plan_warn_failed: String(e?.message ?? e).split("\n")[0] })); } catch (e) { log({ plan_warn_failed: String(e?.message ?? e).split("\n")[0] }); }
    log({ plan_warn_sent: meter.id, threshold: d.threshold });
    sent.push(d);
  }
  return sent;
}

/** "80% text sent Nov 21" for the row, or "" when none this cycle. */
export function warnedWords(meter, r) {
  const at = [...meter.thresholds].reverse().map(t => [t, db.opsGet(warnKey(meter, r, t))]).find(([, v]) => v);
  return at ? `${at[0]}% text sent ${shortDay(Number(at[1]))}` : "";
}
