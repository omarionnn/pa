// What Reason's model calls cost, by feature — and the one place a paid call goes through.
//
// The incident (2026-10-24/25): $10 went on the API key at 21:08 UTC and was gone by 04:00. Nothing
// in Reason could say what had spent it; it turned out to be builders' real-model tests on the paid
// key, and once it was empty every paid call failed — 162 extraction tries by mid-morning — with
// nobody told. So every API call records its tokens here by feature and model, with an estimated $
// off config.apiPrices; every subscription (CLI) run is counted too, without a $; and the status
// page shows it (src/ops.js "API spend"), turning red when the key is out of credit or a day's spend
// passes config.apiDailyCapUsd — which texts the owner through the sustained-alert path. When the
// pre-reply checks fall back to the subscription because the key is dry or failing, their own row
// (fallbackCheck) texts the owner once, and once more when they are back on the API.
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
// subscription — the same fallback a dry key takes — until local midnight. Calls are bound only by
// their own config.apiCallDailyCapUsd; config.apiMonthlyCapUsd binds everything until the 1st.
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

/** Features that are phone calls: exempt from the daily cap, bound by their own. */
export const CALL_FEATURES = ["call", "call_harm"];
const isCall = (feature) => CALL_FEATURES.includes(feature);

/** Paid $ so far: today without calls, today's calls, and this calendar month (all of it). */
export function apiSpent(now = clock.now()) {
  const day = today(now);
  return { day, ...db.apiSpendTotals({ day, month: day.slice(0, 7), callFeatures: CALL_FEATURES }) };
}

/**
 * Has paid use reached a hard cap? `{ which: "day" | "month", spent, cap }` or null. Read off the
 * usage table on every ask, so it lifts by itself at local midnight (and on the 1st) with nothing to
 * reset. `calls`: a phone call's cap rather than everyone else's.
 */
export function capReached({ calls = false, now = clock.now() } = {}) {
  const s = apiSpent(now);
  const month = config.apiMonthlyCapUsd;
  if (month > 0 && s.month >= month) return { which: "month", spent: s.month, cap: month };
  const [spent, cap] = calls ? [s.todayCalls, config.apiCallDailyCapUsd] : [s.todayOther, config.apiDailyCapUsd];
  if (cap > 0 && spent >= cap) return { which: "day", spent, cap };
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
  const hit = capReached({ calls: isCall(feature), now: at });
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
  // Red, not amber: calls are off the API too, and a day already texted for the daily cap gets this
  // as a new episode (ops keys one text to state@since), so the owner hears it.
  if (monthHit) return {
    state: "bad", quietRecovery: true, detail: `monthly cap reached — every paid use is off the API until the 1st · ${parts.join(" · ")}`,
    alert: `API monthly cap reached (${usd(monthCap)}), the pre-reply checks are on the subscription until the 1st, and ${callsWhenCapped()}.`,
  };
  if (dayHit) return {
    state: "warn", quietRecovery: true, detail: `daily cap reached — the pre-reply checks are on the subscription until midnight · ${parts.join(" · ")}`,
    alert: `API daily cap reached (${usd(cap)}), the pre-reply checks are on the subscription until midnight.`,
  };
  return { state: "ok", quietRecovery: true, detail: parts.join(" · ") };
}

/** What a phone call does once it may not use the API (src/calls/voice.js callBackendName). */
const callsWhenCapped = () => process.env.REASON_BACKEND === "claude-cli"
  ? "phone calls are on the subscription (slower to answer)"
  : "phone calls cannot run (there is no subscription to fall back to)";

/**
 * The "Phone calls on the API" row: amber once calls reach their own daily cap, texted ONCE; the
 * lift at midnight is silent. The monthly cap is said by the spend row, so it is not said twice.
 */
export function callCapCheck({ now = clock.now() } = {}) {
  const spent = apiSpent(now);
  const cap = config.apiCallDailyCapUsd;
  if (cap > 0 && spent.todayCalls >= cap) return {
    state: "warn", quietRecovery: true, detail: `${usd(spent.todayCalls)} of ${usd(cap)} today — the call cap is reached, so ${callsWhenCapped()} until midnight`,
    alert: `Phone-call API cap reached (${usd(cap)} today), so ${callsWhenCapped()} until midnight.`,
  };
  return { state: "ok", quietRecovery: true, detail: cap > 0 ? `${usd(spent.todayCalls)} of ${usd(cap)} today` : `${usd(spent.todayCalls)} today (no cap)` };
}

// ---------- the pre-reply checks on the subscription ----------

/** The short reads in front of every reply that fall back to the CLI when the API cannot answer. */
export const SIDE_CHECKS = ["harm", "purchase_topic", "onethought", "said_check"];
/**
 * Failures in a row (not credit), over at least FAILING_SPAN_MS, before the key counts as failing
 * rather than blipping: the harm screen asks twice per message, so one slow minute is not it.
 */
const FAILING_RUN = 4;
const FAILING_SPAN_MS = 2 * 60_000;

/**
 * Are the pre-reply checks on the subscription because the API cannot answer? Read off the latest
 * paid side-check calls, not a time window: while the key is known dry no call is made (apiOut), so
 * the last one on record stays the refusal until a call works again — a quiet night is not a
 * recovery. Dry: the latest was refused for credit. Failing: the last FAILING_RUN all failed.
 */
export function sideChecksFallback() {
  const last = db.lastApiCalls(SIDE_CHECKS, FAILING_RUN);
  if (!last.length || last[0].ok) return { down: false };
  if (last[0].low_credit) return { down: true, why: "dry", at: last[0].at };
  if (last.length >= FAILING_RUN && last.every(r => !r.ok) && last[0].at - last.at(-1).at >= FAILING_SPAN_MS) return { down: true, why: "failing", at: last[0].at, error: last[0].error };
  return { down: false };
}

/**
 * The "Pre-reply checks" row. Red while they are on the subscription for want of the API, which
 * texts the owner ONCE through ops' sustained-alert path (with the status page link) and once more,
 * "back on the API", when a paid check works again — never a text per message, never to anybody
 * else (src/ops.js settle texts only config.ownerConversation).
 */
export function fallbackCheck() {
  const f = sideChecksFallback();
  if (!f.down) return {
    state: "ok", detail: "on the API (Haiku), the subscription as the fallback",
    recovered: "Back on the API: the pre-reply checks are using the API key again, so replies are back to full speed.",
  };
  const cause = f.why === "dry" ? "The API key ran dry" : "The API key is failing";
  const fix = f.why === "dry" ? "top up" : "check the key";
  // On the API backend there is no subscription to fall back to: the checks are simply not running.
  if (process.env.REASON_BACKEND !== "claude-cli") return {
    state: "bad",
    detail: `${f.why === "dry" ? "the API key is out of credit" : `the API key is failing (${f.error || "no answer"})`} — no subscription to fall back to, so the pre-reply checks are not running`,
    alert: `${cause}, and with no subscription to fall back to the pre-reply checks are not running until you ${fix}.`,
  };
  return {
    state: "bad",
    detail: `${f.why === "dry" ? "the API key is out of credit" : `the API key is failing (${f.error || "no answer"})`} — the pre-reply checks are on the subscription`,
    alert: `${cause}, so the pre-reply checks switched to the subscription; replies may be a few seconds slower until you ${fix}.`,
  };
}

/** Drop usage rows past 35 days. Called from the retention sweep. */
export const prune = (now = clock.now()) => db.pruneModelUsage(now - 35 * DAY_MS);
