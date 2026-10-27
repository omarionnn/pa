// What Reason's model calls cost, by feature — and the one place a paid call goes through.
//
// The incident (2026-10-24/25): $10 went on the API key at 21:08 UTC and was gone by 04:00. Nothing
// in Reason could say what had spent it; it turned out to be builders' real-model tests on the paid
// key, and once it was empty every paid call failed — 162 extraction tries by mid-morning — with
// nobody told. So every API call records its tokens here by feature and model, with an estimated $
// off config.apiPrices; every subscription (CLI) run is counted too, without a $; and the status
// page shows it (src/ops.js "API spend"), turning red when the key is out of credit or a day's spend
// passes config.apiDailyCapUsd — which texts the owner through the sustained-alert path.
//
// Since 2026-10-27 (owner: never bill the API) every text-side model call is on the subscription:
// the harm screen, the said check and the mid-turn read included, with no API fallback. The only
// paid calls left are phone calls (and their screen) on REASON_CALL_BACKEND=api, and the API
// backend (REASON_BACKEND=api), which the live install does not run. The table below is history.
//
// Where each feature runs, and why (2026-10-25):
//   subscription (CLI)  replies, extraction, the profile, the confirm gate's judge, the watcher,
//                       photo notes, the said-ledger's record — background, or part of a turn that
//                       is already on the CLI, so no paid call is needed.
//   API, Haiku          the harm screen, purchase-topic, the one-thought sorter and the said-ledger's
//                       pre-send check: one short read in front of every reply, where a ~3s cold CLI
//                       start would slow every answer. Small max_tokens, the instructions cached, and
//                       the CLI as the fallback when the API cannot answer (no credit, down).
//   API, as configured  phone calls — streamed tokens on a live line; left exactly as they are.
//
// The hard caps (2026-10-25, capReached): the owner would not top the key up again until it could
// not be drained. Past config.apiDailyCapUsd in a day, every paid use but calls goes to the
// subscription — the same fallback a dry key takes — until local midnight; config.apiMonthlyCapUsd
// does the same until the 1st. Phone calls are NEVER stopped or moved (owner, 2026-10-25): they stay
// on the API as configured, and config.apiCallDailyCapUsd only texts the owner once.
import { config, clock } from "./config.js";
import * as db from "./db.js";
import { today } from "./accounts.js";
import { onCliRun } from "./backends/cli.js";

/** $ per million tokens for a model id, or null for one not in the table. Date suffixes ignored. */
export function priceFor(model) {
  const m = String(model ?? "");
  if (config.apiPrices[m]) return config.apiPrices[m];
  const key = Object.keys(config.apiPrices).sort((a, b) => b.length - a.length).find(k => m.startsWith(k));
  return key ? config.apiPrices[key] : null;
}

/** Estimated $ for one response's `usage`. Unknown model: 0, and the tokens still recorded. */
export function costOf(model, usage = {}) {
  const p = priceFor(model);
  if (!p || !usage) return 0;
  const n = (k) => Number(usage[k]) || 0;
  return (n("input_tokens") * p.in + n("output_tokens") * p.out
    + n("cache_creation_input_tokens") * (p.cacheWrite ?? p.in * 1.25) + n("cache_read_input_tokens") * (p.cacheRead ?? p.in * 0.1)) / 1e6;
}

/** The API refused for want of credit (a 400 that says so; a 402). */
export const isLowCredit = (e) => Number(e?.status) === 402 || /credit balance/i.test(String(e?.message ?? e ?? ""));

const firstLine = (e) => String(e?.message ?? e ?? "").split("\n")[0].slice(0, 200);

/** Record one API call. Never throws: counting must never cost a reply. */
export function recordApi({ feature, model = "", usage = null, error = null, at = clock.now() }) {
  try {
    db.recordModelUsage({
      at, day: today(at), feature, via: "api", model, ok: !error,
      input: usage?.input_tokens, output: usage?.output_tokens,
      cacheRead: usage?.cache_read_input_tokens, cacheWrite: usage?.cache_creation_input_tokens,
      costUsd: error ? 0 : costOf(model, usage ?? {}), error: error ? firstLine(error) : "", lowCredit: !!error && isLowCredit(error),
    });
  } catch { /* a counter is never worth an error */ }
  if (error) noteApiError(error, at);
}

/** Count one subscription (CLI) run. Tokens kept when the CLI reported them; never a $. */
export function recordCli({ feature, model = "", ok = true, error = null, usage = null, at = clock.now() }) {
  try {
    db.recordModelUsage({
      at, day: today(at), feature, via: "cli", model, ok: ok && !error,
      input: usage?.input_tokens, output: usage?.output_tokens,
      cacheRead: usage?.cache_read_input_tokens, cacheWrite: usage?.cache_creation_input_tokens,
      costUsd: 0, error: error ? firstLine(error) : "",
    });
  } catch { /* same */ }
}

// Every subscription run is counted where it ends (src/backends/cli.js), whoever started it.
onCliRun(r => recordCli({ feature: r.feature, model: r.model, ok: r.ok, error: r.ok ? null : r.error, usage: r.usage }));

// ---------- the key out of credit ----------

// ---------- the hard caps ----------

/** Features that are phone calls: exempt from every cap; their own daily cap only texts the owner. */
export const CALL_FEATURES = ["call", "call_harm"];
const isCall = (feature) => CALL_FEATURES.includes(feature);

/** Paid $ so far: today without calls, today's calls, and this calendar month (all of it). */
export function apiSpent(now = clock.now()) {
  const day = today(now);
  return { day, ...db.apiSpendTotals({ day, month: day.slice(0, 7), callFeatures: CALL_FEATURES }) };
}

/**
 * Has non-call paid use reached a hard cap? `{ which: "day" | "month", spent, cap }` or null. Read
 * off the usage table on every ask, so it lifts by itself at local midnight (and on the 1st) with
 * nothing to reset. The month counts everything paid, calls included — it is the bill.
 */
export function capReached({ now = clock.now() } = {}) {
  const s = apiSpent(now);
  const month = config.apiMonthlyCapUsd;
  if (month > 0 && s.month >= month) return { which: "month", spent: s.month, cap: month };
  const cap = config.apiDailyCapUsd;
  if (cap > 0 && s.todayOther >= cap) return { which: "day", spent: s.todayOther, cap };
  return null;
}

const capWords = (hit) => `the API ${hit.which === "month" ? "monthly" : "daily"} cap (${usd(hit.cap)}) is reached — on the subscription until ${hit.which === "month" ? "the 1st" : "midnight"}`;

let outUntil = 0;
/** Note a failed API call: out of credit means the side checks skip the API for a while. */
export function noteApiError(e, at = clock.now()) {
  if (isLowCredit(e)) outUntil = at + config.apiOutPauseMs;
}
/**
 * Should `feature` skip the API right now? Then it goes straight to its CLI fallback. Yes while the
 * key is known out of credit (clears within config.apiOutPauseMs, so a topped-up key is back in
 * use) and while its hard cap is reached (clears at midnight / the 1st).
 */
export const apiOut = (feature = "", at = clock.now()) => !!apiSkipWhy(feature, at);
/** Why `feature` skips the API, in words for a log, or null when it may call. */
export function apiSkipWhy(feature = "", at = clock.now()) {
  if (at < outUntil) return "the API account is out of credit (skipped)";
  // A phone call is never held back by a cap: its cap only texts the owner (callCapCheck).
  if (isCall(feature)) return null;
  const hit = capReached({ now: at });
  return hit ? `${capWords(hit)} (skipped)` : null;
}
/** For tests. */
export function resetApiOut() { outUntil = 0; }

/** An error that says the API was skipped, worded the way the outage checks read it. */
export const skippedForCredit = () => new Error("skipped: the API account is out of credit (credit balance too low)");

/**
 * One paid `messages.create`, recorded under `feature`. Throws what the SDK threw, after counting
 * it. Skipped outright (throws) while the key is known to be out of credit.
 */
export async function callApi({ feature, client, params, options = {} }) {
  const why = apiSkipWhy(feature);
  if (why) throw /credit/.test(why) ? skippedForCredit() : new Error(why);
  try {
    const res = await client.messages.create(params, options);
    recordApi({ feature, model: params.model, usage: res?.usage });
    return res;
  } catch (e) {
    recordApi({ feature, model: params.model, error: e });
    throw e;
  }
}

/** A client whose `messages.create` is `callApi` under `feature` — for a caller that holds a client. */
export const tracked = (client, feature) => ({ messages: { create: (params, options = {}) => callApi({ feature, client, params, options }) } });

/**
 * Instructions as a cached system block. The fixed prefix (tools, then this) is read from cache on
 * every call after the first in five minutes. Below the model's minimum (512 tokens on Haiku 5.5)
 * the API simply does not cache, which costs nothing.
 */
export const cachedSystem = (text) => [{ type: "text", text, cache_control: { type: "ephemeral" } }];

// ---------- the status page ----------

const DAY_MS = 24 * 60 * 60 * 1000;
const usd = (x) => { const v = Number(x) || 0; return `$${v.toFixed(v >= 1 ? 2 : v >= 0.01 || v === 0 ? 3 : 4)}`; };

/** Today's and the last 7 days' use, by feature and path. */
export function summary({ now = clock.now() } = {}) {
  const day = today(now);
  const t = db.modelUsageBy({ day });
  const w = db.modelUsageBy({ since: now - 7 * DAY_MS });
  const api = (rows) => rows.filter(r => r.via === "api");
  const total = (rows) => rows.reduce((s, r) => s + (r.usd || 0), 0);
  const calls = (rows) => rows.reduce((s, r) => s + r.calls, 0);
  return {
    day,
    today: { usd: total(api(t)), calls: calls(api(t)), byFeature: api(t), cli: t.filter(r => r.via === "cli") },
    week: { usd: total(api(w)), calls: calls(api(w)), byFeature: api(w), cli: w.filter(r => r.via === "cli") },
  };
}

/**
 * The "API spend" row: `{ state, detail, alert }`. Amber while the daily cap holds the paid key
 * shut, red while the monthly cap does (calls too), which texts the owner ONCE through ops' sustained-alert path; the lift at midnight
 * is silent (`quietRecovery`). Credit refusals are said here and texted by fallbackCheck.
 */
export function spendCheck({ now = clock.now(), cap = config.apiDailyCapUsd } = {}) {
  const s = summary({ now });
  const spent = apiSpent(now);
  const monthCap = config.apiMonthlyCapUsd;
  const of = (x, c) => c > 0 ? `${usd(x)} of ${usd(c)}` : `${usd(x)} (no cap)`;
  const head = `${of(spent.todayOther, cap)} today · calls ${of(spent.todayCalls, config.apiCallDailyCapUsd)} · ${of(spent.month, monthCap)} this month`;
  const credit = db.lowCreditFailures(now - 60 * 60_000);
  const feats = (rows) => rows.slice(0, 4).map(r => `${r.feature} ${usd(r.usd)} (${r.calls})`).join(", ");
  const cli = s.today.cli.reduce((n, r) => n + r.calls, 0);
  const cliFeats = s.today.cli.slice().sort((a, b) => b.calls - a.calls || a.feature.localeCompare(b.feature)).slice(0, 4).map(r => `${r.feature} ${r.calls}`).join(", ");
  const parts = [
    head,
    `today${s.today.calls ? ` — ${feats(s.today.byFeature)}` : ": no paid calls"}`,
    `${usd(s.week.usd)} 7d${s.week.calls ? ` — ${feats(s.week.byFeature)}` : ""}`,
    `subscription: ${cli} run${cli === 1 ? "" : "s"} today${cli ? ` (${cliFeats})` : ""}`,
  ];
  // Out of credit is said by its own row (fallbackCheck), so the owner gets that one text, not two.
  if (credit.n) parts.unshift(`${credit.n} paid call${credit.n === 1 ? "" : "s"} refused for credit in the last hour`);
  const monthHit = monthCap > 0 && spent.month >= monthCap;
  const dayHit = cap > 0 && spent.todayOther >= cap;
  // Red, not amber: a day already texted for the daily cap gets this
  // as a new episode (ops keys one text to state@since), so the owner hears it.
  if (monthHit) return {
    state: "bad", quietRecovery: true, detail: `monthly cap reached — every paid use but calls is off the API until the 1st · ${parts.join(" · ")}`,
    alert: `API monthly cap reached (${usd(monthCap)}), the pre-reply checks are on the subscription until the 1st. Phone calls keep running on the API.`,
  };
  if (dayHit) return {
    state: "warn", quietRecovery: true, detail: `daily cap reached — the pre-reply checks are on the subscription until midnight · ${parts.join(" · ")}`,
    alert: `API daily cap reached (${usd(cap)}), the pre-reply checks are on the subscription until midnight.`,
  };
  return { state: "ok", quietRecovery: true, detail: parts.join(" · ") };
}

/**
 * The "Phone calls on the API" row: amber once calls pass their daily cap, texted ONCE; the reset at
 * midnight is silent. A heads-up only — calls keep running on the API exactly as before.
 */
export function callCapCheck({ now = clock.now() } = {}) {
  const spent = apiSpent(now);
  const cap = config.apiCallDailyCapUsd;
  if (cap > 0 && spent.todayCalls >= cap) return {
    state: "warn", quietRecovery: true, detail: `${usd(spent.todayCalls)} of ${usd(cap)} today — past the call cap; calls keep running on the API`,
    alert: `Phone calls passed the ${usd(cap)} API cap today (${usd(spent.todayCalls)} so far). They keep running on the API; this is a heads-up only.`,
  };
  return { state: "ok", quietRecovery: true, detail: cap > 0 ? `${usd(spent.todayCalls)} of ${usd(cap)} today` : `${usd(spent.todayCalls)} today (no cap)` };
}

// ---------- the pre-reply checks on the subscription ----------

/** The "Pre-reply checks" row on the status page. */
export function fallbackCheck() {
  // Since 2026-10-27 the pre-reply checks (the harm screen, the said check, the mid-turn read) run
  // on the subscription and never on the paid API (owner), so a dry or failing key cannot reach
  // them: there is nothing here to fall back from, and nothing to text about.
  return {
    state: "ok", detail: "on the subscription, never the paid API",
    recovered: "The pre-reply checks are on the subscription now, never the paid API key.",
  };
}

/** Drop usage rows past 35 days. Called from the retention sweep. */
export const prune = (now = clock.now()) => db.pruneModelUsage(now - 35 * DAY_MS);
