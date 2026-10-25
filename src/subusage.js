// How close each Claude subscription is to its limits, for the status page (2026-10-25).
//
// Two subscriptions:
//
//   - **Reason's** — the `claude` CLI logged in on this server. Its replies run on it, so when its
//     five-hour window is full Reason stops answering. That is why its row goes amber at 80% and
//     texts the owner through the ordinary sustained-alert path (src/ops.js settle).
//   - **The owner's coding one** — the CLI on his Mac. Reason must never depend on the Mac, so that
//     row is push-only: a small reporter there signs a few numbers and POSTs them to /ops/usage
//     (scripts/usage-reporter.py). When it stops pushing the row says "last seen X ago" and nothing
//     more. It is quiet: shown, never texted.
//
// What the CLI really exposes, checked against 2.1.296 on 2026-10-25:
//
//   - a run with `--output-format stream-json` prints a `rate_limit_event` whose `unifiedWindows`
//     carry `five_hour` and `seven_day` utilization (0–1) and their reset times. Reason's picture
//     turns already run that way, so every one of them is a free reading (`noteCliRun`).
//   - text turns run `--output-format json` (pinned in test/cli-photos.test.js) and that envelope
//     has no rate-limit field at all. For those, the reading comes from GET /api/oauth/usage — the
//     endpoint the CLI's own `/usage` screen reads, with the CLI's own OAuth token. It is not a
//     model call and spends nothing from either window. It is asked at most once per
//     BACKSTOP_EVERY_MS, and only when the CLI has run since the last reading.
//
// Only numbers are kept: percentages, reset times, counts. Never a prompt, never a reply.
import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { cliRuns } from "./backends/cli.js";

export const SOURCES = { reason: "reason", coding: "coding" };
/** The five-hour window at or past this is amber on Reason's row, and texts the owner. */
export const WARN_PCT = 80;
export const BACKSTOP_EVERY_MS = 15 * 60_000;
/** A push older than this is "last seen X ago". The reporter pushes every ten minutes. */
export const CODING_STALE_MS = 25 * 60_000;
/** How far a signed push's clock may be from ours. */
export const INGEST_SKEW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// ---------- reading what the CLI and the endpoint say ----------

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const ms = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const pct = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * One reading out of a stream-json `rate_limit_event`, or null if this is not one. Utilization
 * there is a fraction (0.32), reset times are epoch seconds.
 */
export function fromRateLimitEvent(ev) {
  if (ev?.type !== "rate_limit_event") return null;
  const info = ev.rate_limit_info ?? {};
  const w = info.unifiedWindows ?? {};
  const five = w.five_hour ?? (info.rateLimitType === "five_hour" ? { utilization: info.utilization, resetsAt: info.resetsAt } : null);
  const week = w.seven_day ?? (info.rateLimitType === "seven_day" ? { utilization: info.utilization, resetsAt: info.resetsAt } : null);
  const f = num(five?.utilization), k = num(week?.utilization);
  if (f == null && k == null) return null;
  return {
    five_pct: f == null ? null : pct(f * 100), five_resets_at: ms(five?.resetsAt),
    week_pct: k == null ? null : pct(k * 100), week_resets_at: ms(week?.resetsAt),
    status: String(info.status ?? ""), via: "cli",
  };
}

/** The last reading in a run's stream-json stdout, or null. Lines that are not JSON are skipped. */
export function fromStreamOutput(stdout) {
  let found = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.includes("rate_limit_event")) continue;
    try { found = fromRateLimitEvent(JSON.parse(line)) ?? found; } catch { /* not a line of JSON */ }
  }
  return found;
}

/** A scoped limit by what it is scoped to: "week Fable" rather than "weekly_scoped". */
function limitName(l) {
  const model = l.scope?.model?.display_name;
  return model ? `${l.group === "weekly" ? "week" : l.group || "limit"} ${model}` : l.kind;
}

/**
 * One reading out of GET /api/oauth/usage. Utilization there is already a percentage. Scoped
 * weekly limits (a per-model week) ride along in `extra` as kind → percent.
 */
export function fromUsageResponse(j) {
  if (!j || typeof j !== "object") return null;
  const f = num(j.five_hour?.utilization), k = num(j.seven_day?.utilization);
  if (f == null && k == null) return null;
  const extra = {};
  for (const l of Array.isArray(j.limits) ? j.limits : []) {
    if (!l || l.kind === "session" || l.kind === "weekly_all") continue;
    const p = num(l.percent);
    if (p != null && typeof l.kind === "string") extra[limitName(l).slice(0, 40)] = p;
  }
  return {
    five_pct: pct(f), five_resets_at: ms(j.five_hour?.resets_at),
    week_pct: pct(k), week_resets_at: ms(j.seven_day?.resets_at),
    status: "", via: "usage", ...(Object.keys(extra).length ? { extra } : {}),
  };
}

// ---------- keeping them ----------

/** Save one reading. Only numbers go in; anything else on the object is dropped. */
export function record(source, r, at = clock.now()) {
  if (!r) return;
  const cap = (v) => (v == null ? null : Math.max(0, Math.min(1000, Number(v))));
  db.db.prepare(`INSERT INTO subscription_usage (source, at, five_pct, five_resets_at, week_pct, week_resets_at, status, via, turns_today, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(source, at, cap(r.five_pct), num(r.five_resets_at), cap(r.week_pct), num(r.week_resets_at),
    String(r.status ?? "").slice(0, 20), String(r.via ?? "").slice(0, 20), num(r.turns_today), r.extra ? JSON.stringify(r.extra) : null);
  db.db.prepare("DELETE FROM subscription_usage WHERE at < ?").run(at - 2 * 24 * HOUR_MS);
}

export function latest(source) {
  return db.db.prepare("SELECT * FROM subscription_usage WHERE source = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(source) ?? null;
}

/**
 * A window's percentage as of `now`: a reading whose window has since reset is 0, because nothing
 * has been used in the new one yet (any use would have brought a fresh reading).
 */
export function current(pctValue, resetsAt, now = clock.now()) {
  if (pctValue == null) return null;
  return resetsAt != null && resetsAt <= now ? 0 : pctValue;
}

/** The five-hour percentage by hour for the last 24, oldest first: the row's sparkline. */
export function hourlyFive(source, now = clock.now()) {
  const end = Math.floor(now / HOUR_MS), start = end - 23;
  const rows = db.db.prepare("SELECT at, five_pct, five_resets_at FROM subscription_usage WHERE source = ? AND at >= ? ORDER BY at")
    .all(source, (start - 6) * HOUR_MS);
  const out = new Array(24).fill(0);
  let i = 0, carry = null;
  for (let h = start; h <= end; h++) {
    const hEnd = (h + 1) * HOUR_MS;
    let max = null;
    while (i < rows.length && rows[i].at < hEnd) {
      const r = rows[i++];
      if (r.five_pct == null) continue;
      carry = r;
      if (r.at >= h * HOUR_MS) max = Math.max(max ?? 0, r.five_pct);
    }
    out[h - start] = max ?? (carry ? current(carry.five_pct, carry.five_resets_at, h * HOUR_MS) : 0);
  }
  return out;
}

// ---------- Reason's own subscription ----------

let lastRunAt = 0;

/** Hear one finished CLI run: count it, and keep the reading it printed if it printed one. */
export function noteCliRun({ ok = true, stdout = "", at = clock.now(), day } = {}) {
  lastRunAt = at;
  try { db.recordProviderCall({ provider: "claude-subscription", day: day ?? new Date(at).toLocaleDateString("en-CA", { timeZone: config.tz }), ok, at }); } catch { /* a count is never worth a turn */ }
  try { record(SOURCES.reason, fromStreamOutput(stdout), at); } catch { /* same */ }
}

let listening = false;
export function listen() {
  if (listening) return;
  listening = true;
  cliRuns.on("run", (r) => noteCliRun(r));
}

/** The CLI's OAuth access token on this machine, or null. Never logged, never kept. */
export function readToken({ path = process.env.REASON_CLAUDE_CREDENTIALS || join(homedir(), ".claude", ".credentials.json"), now = clock.now() } = {}) {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"))?.claudeAiOauth;
    if (!o?.accessToken) return null;
    // Expired: the CLI refreshes it on its next run. Refreshing it from here could rotate the
    // refresh token out from under the CLI, so it is left alone.
    if (o.expiresAt && Number(o.expiresAt) <= now + 60_000) return null;
    return o.accessToken;
  } catch { return null; }
}

/**
 * The backstop reading, when the CLI has run since the last one and that one is older than
 * BACKSTOP_EVERY_MS. One GET, no model call. Returns what happened, for the log.
 */
export async function backstop({ fetchImpl = globalThis.fetch, now = clock.now(), token = readToken, ranAt = lastRunAt } = {}) {
  if (config.backend !== "claude-cli") return { skipped: "not on the CLI backend" };
  const last = latest(SOURCES.reason);
  if (last && now - last.at < BACKSTOP_EVERY_MS) return { skipped: "fresh" };
  if (last && ranAt <= last.at) return { skipped: "no use since the last reading" };
  const lastTry = Number(db.opsGet("subusage:backstop_at")) || 0;
  if (now - lastTry < BACKSTOP_EVERY_MS) return { skipped: "asked recently" };
  const t = token();
  if (!t) return { skipped: "no live login token" };
  db.opsSet("subusage:backstop_at", now);
  try {
    const res = await fetchImpl(USAGE_URL, { headers: { authorization: `Bearer ${t}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { failed: res.status };
    const r = fromUsageResponse(await res.json());
    if (!r) return { failed: "no numbers" };
    record(SOURCES.reason, r, now);
    return { recorded: true };
  } catch (e) {
    return { failed: (e?.message ?? String(e)).slice(0, 80) };
  }
}

// ---------- the coding subscription's push ----------

export function ingestSecret() { return process.env.REASON_USAGE_INGEST_SECRET || ""; }

export function sign(secret, ts, body) {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

/**
 * Check and keep one push from the Mac. `body` is the raw text, `headers` the request's. Returns
 * { status, error? }. A push is accepted only if its HMAC matches, its clock is within
 * INGEST_SKEW_MS of ours and it is newer than the last one accepted (no replays).
 */
export function ingest({ body, headers = {}, secret = ingestSecret(), now = clock.now() }) {
  if (!secret) return { status: 404, error: "not set up" };
  const ts = Number(headers["x-reason-timestamp"]);
  const got = String(headers["x-reason-signature"] ?? "").replace(/^sha256=/, "");
  const want = sign(secret, String(headers["x-reason-timestamp"] ?? ""), String(body ?? ""));
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 401, error: "bad signature" };
  if (!Number.isFinite(ts) || Math.abs(now - ts) > INGEST_SKEW_MS) return { status: 401, error: "clock too far off" };
  if (ts <= (Number(db.opsGet("subusage:coding_ts")) || 0)) return { status: 409, error: "already seen" };
  let j;
  try { j = JSON.parse(body); } catch { return { status: 400, error: "not JSON" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { status: 400, error: "not an object" };
  const r = {
    five_pct: num(j.five_pct), five_resets_at: num(j.five_resets_at),
    week_pct: num(j.week_pct), week_resets_at: num(j.week_resets_at),
    turns_today: num(j.turns_today), via: j.five_pct == null && j.week_pct == null ? "counts" : "usage",
    status: "",
  };
  if (j.extra && typeof j.extra === "object") {
    const extra = {};
    // Names only of the shape a limit has ("week Fable"): anything else from the Mac is dropped.
    for (const [k, v] of Object.entries(j.extra).slice(0, 6)) if (num(v) != null && /^[\w .-]{1,40}$/.test(k)) extra[k] = num(v);
    if (Object.keys(extra).length) r.extra = extra;
  }
  if (r.five_pct == null && r.week_pct == null && r.turns_today == null) return { status: 400, error: "no numbers" };
  db.opsSet("subusage:coding_ts", ts);
  record(SOURCES.coding, r, now);
  return { status: 204 };
}

// ---------- the two rows ----------

function ago(d) {
  const s = Math.max(0, Math.round(d / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function resetWords(at, now) {
  if (at == null) return "";
  const d = at - now;
  if (d <= 0) return " · reset";
  const t = new Date(at).toLocaleString("en-US", { timeZone: config.tz, ...(d > 20 * HOUR_MS ? { weekday: "short" } : {}), hour: "numeric", minute: "2-digit" });
  return ` · resets ${t} (in ${ago(d)})`;
}

function windowsLine(r, now) {
  const five = current(r.five_pct, r.five_resets_at, now);
  const week = current(r.week_pct, r.week_resets_at, now);
  const parts = [];
  if (five != null) parts.push(`5-hour ${Math.round(five)}%${resetWords(r.five_resets_at, now)}`);
  if (week != null) parts.push(`week ${Math.round(week)}%${resetWords(r.week_resets_at, now)}`);
  let extra = null;
  try { extra = r.extra ? JSON.parse(r.extra) : null; } catch { /* none */ }
  for (const [k, v] of Object.entries(extra ?? {})) parts.push(`${k.replace(/_/g, " ")} ${Math.round(v)}%`);
  return { five, week, text: parts.join(" · ") };
}

/** The two rows for src/ops.js. `turnsToday` is Reason's CLI runs today (from the provider ledger). */
export function checks({ now = clock.now(), day } = {}) {
  const out = [];
  const turns = db.providerCalls("claude-subscription", day).calls;

  const r = latest(SOURCES.reason);
  if (!r) {
    out.push({ id: "subscription:reason", group: "subscriptions", label: "Reason's subscription",
      state: config.backend === "claude-cli" ? "ok" : "off",
      detail: config.backend === "claude-cli" ? `no reading yet · ${turns} CLI runs today` : "not on the CLI backend" });
  } else {
    const w = windowsLine(r, now);
    const full = (w.five ?? 0) >= 100 || (w.week ?? 0) >= 100 || r.status === "rejected";
    const state = full ? "bad" : (w.five ?? 0) >= WARN_PCT ? "warn" : "ok";
    const lead = full ? "at its limit — Reason cannot reply until it resets · " : state === "warn" ? "nearly full — Reason stops replying at 100% · " : "";
    out.push({ id: "subscription:reason", group: "subscriptions", label: "Reason's subscription", state,
      detail: `${lead}${w.text || "no limits in the last reading"} · ${turns} CLI runs today · read ${ago(now - r.at)} ago` });
  }

  const c = latest(SOURCES.coding);
  if (!c) {
    out.push({ id: "subscription:coding", group: "subscriptions", label: "Coding subscription (Mac)", state: "off", detail: "the Mac has never reported", quiet: true });
  } else {
    const w = windowsLine(c, now);
    const stale = now - c.at > CODING_STALE_MS;
    const turnsC = c.turns_today != null ? ` · ${c.turns_today} requests today` : "";
    out.push({ id: "subscription:coding", group: "subscriptions", label: "Coding subscription (Mac)", state: "ok", quiet: true,
      detail: stale ? `last seen ${ago(now - c.at)} ago (the Mac is asleep or offline)${w.text ? ` · then: ${w.text}` : ""}`
        : `${w.text || "limits not exposed — counts only"}${turnsC} · pushed ${ago(now - c.at)} ago` });
  }
  return out;
}
