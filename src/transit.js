// Live NYC subway status, read with the age of the data checked in code.
//
// The commute check (a series that fires before Omari's shift) used to be a sentence telling the
// model to go and read api.subwaynow.app with web_lookup. Nothing looked at how old what came back
// was, so twice it told him the trains were fine off a feed that had not moved since the day before
// ("the 5 hadn't updated"). The feed carries a `timestamp` (seconds) on every route; here that is
// the gate. A line older than the limit, or one that could not be fetched after a retry, is handed
// back as NOT trustworthy, with the one honest sentence to say instead of a guess.
import { clock } from "./config.js";

export const TRANSIT_BASE = process.env.REASON_TRANSIT_BASE || "https://api.subwaynow.app";
/** How old a line's status may be and still be said as live. The feed updates every minute or so. */
export const MAX_AGE_MIN = Number(process.env.REASON_TRANSIT_MAX_AGE_MIN || 15);
const TIMEOUT_MS = 8_000;
const ATTEMPTS = 2;

const LINE = /^[A-Za-z0-9]{1,3}$/;

async function fetchLine(line, { fetchImpl = fetch } = {}) {
  let last = "no answer";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(`${TRANSIT_BASE}/routes/${encodeURIComponent(line)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { last = `status ${res.status}`; continue; }
      return { ok: true, body: await res.json() };
    } catch (e) {
      last = (e?.message ?? String(e)).split("\n")[0];
    }
  }
  return { ok: false, error: last };
}

const clean = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);

/** One line's status, judged. Never throws. */
export async function lineStatus(line, { fetchImpl, now = clock.now(), maxAgeMin = MAX_AGE_MIN } = {}) {
  const id = String(line ?? "").trim().toUpperCase();
  if (!LINE.test(id)) return { line: id, trust: false, why: "not a subway line" };
  const got = await fetchLine(id, { fetchImpl });
  if (!got.ok) {
    return { line: id, trust: false, why: `could not reach the feed (${got.error}), tried twice` };
  }
  const b = got.body ?? {};
  const ts = Number(b.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { line: id, trust: false, why: "the feed did not say when it was updated" };
  const ageMin = Math.round((now - ts * 1000) / 60_000);
  const base = {
    line: id,
    updated_minutes_ago: ageMin,
    status: b.status ?? null,
    directions: b.direction_statuses ?? null,
    delays: { north: clean(b.delay_summaries?.north), south: clean(b.delay_summaries?.south) },
    slow: { north: clean(b.service_irregularity_summaries?.north), south: clean(b.service_irregularity_summaries?.south) },
    service_changes: {
      both: clean(b.service_change_summaries?.both),
      north: clean(b.service_change_summaries?.north),
      south: clean(b.service_change_summaries?.south),
    },
  };
  if (ageMin > maxAgeMin) {
    return { ...base, trust: false, why: `the feed for the ${id} was last updated ${ageMin} minutes ago, so it is not live` };
  }
  return { ...base, trust: true };
}

/**
 * Several lines at once, with the verdict the model has to say. `say` is set whenever any line is
 * not trustworthy: it is the honest line, and the model is told not to state a status for that line.
 */
export async function transitStatus(lines = [], opts = {}) {
  const ids = [...new Set(lines.map(l => String(l).trim().toUpperCase()).filter(Boolean))].slice(0, 6);
  const out = await Promise.all(ids.map(l => lineStatus(l, opts)));
  const bad = out.filter(r => !r.trust);
  return {
    ok: true,
    lines: out,
    all_live: bad.length === 0,
    ...(bad.length
      ? {
        say: `Say plainly that you could not get live status for the ${bad.map(r => r.line).join(" and ")}`
          + ` (${bad.map(r => r.why).join("; ")}). Give the leave time with normal travel plus a buffer, and`
          + ` tell them to check the MTA app before leaving. Never say a line is running fine when its status is not live.`,
      }
      : {}),
  };
}
