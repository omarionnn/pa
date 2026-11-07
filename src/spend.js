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
  try { error ? noteLimitError(error, at) : clearLimitHit(at); } catch { /* an alert is never worth a reply */ }
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
  // The 80% heads-up already sent this day / month (capWarnings), so the page says he was told.
  const warned = warnedWords(now);
  if (warned) parts.push(warned);
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

// ---------- warnings before the wall (2026-11-07) ----------
//
// The incident (2026-11-05 22:05 UTC, 17:05 New York): the Anthropic workspace's own usage limit was
// hit with no warning. Every paid call came back "400 … You have reached your specified workspace
// API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.", a taxi request waited 15
// minutes, the harm screen failed open four times, and nobody was told. So:
//
//   - at 80% of the daily cap and of the monthly cap the owner gets one text, once per day / month
//     (capWarnings, from the ops pass);
//   - the provider's usage-limit refusal texts the owner the moment it is first seen, once per
//     episode; the next successful paid call ends the episode (noteLimitError / clearLimitHit).
//
// Both say the system problem only, never who was talking or what about, and both show on /ops
// (limitCheck, and the warning line in the "API spend" row). Neither goes through the five-minute
// pass's texting (`quiet` rows), so each is said exactly once.
//
// No cheaper-model fallback: a workspace usage limit is on the key, so Haiku and Sonnet are refused
// exactly like Opus. The short per-minute 429s are already taken by the API's own server-side
// fallback (agent.js `fallbacks`).

/** The share of a cap that earns the heads-up. */
// A share of the cap between 0 and 1; anything else ("80", "0", garbage) falls back to 80%.
const warnAtEnv = Number(process.env.REASON_API_WARN_AT);
export const WARN_AT = warnAtEnv > 0 && warnAtEnv < 1 ? warnAtEnv : 0.8;

const LIMIT_KEY = "api_limit:hit";
let alertSend = null;

/** Wire the texts: `send(text, idempotencyKey)` to the owner's thread (src/ops.js startOps). */
export function startAlerts({ send = null } = {}) {
  alertSend = send;
  // A refusal seen before the wiring (during boot) is told now rather than lost.
  const hit = limitHit();
  if (send && hit && !hit.told) tellLimit(hit);
}
export function stopAlerts() { alertSend = null; }

/**
 * Is this the provider saying the account's usage limit is spent? The wording the API used on
 * 11-05, and a 429 that names a usage limit. A plain per-minute rate limit (a 429 rate_limit_error
 * that clears in seconds) is not one: that is a blip, not an outage.
 */
export function isUsageLimit(e) {
  const msg = String(e?.message ?? e ?? "");
  if (/reached your (?:specified )?(?:workspace )?(?:API )?usage limits?|workspace (?:API )?usage limits?|regain access on/i.test(msg)) return true;
  return Number(e?.status) === 429 && /usage limit/i.test(msg);
}

/** "2026-12-01 at 00:00 UTC" out of the refusal, or "". */
function regainWords(msg) {
  const m = /regain access on ([0-9]{4}-[0-9]{2}-[0-9]{2}(?: at [0-9]{1,2}:[0-9]{2})?(?: UTC)?)/i.exec(String(msg ?? ""));
  return m ? m[1] : "";
}

/** The open usage-limit episode, or null. */
export function limitHit() {
  const raw = db.opsGet(LIMIT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The owner's text for an episode. The system problem only. */
export function limitText(hit) {
  return `Reason alert: the Anthropic API workspace usage limit is reached, so every paid API call is being refused`
    + `${hit?.regain ? ` until ${hit.regain} (the API's words)` : ""}. Raise the limit in the Anthropic Console, or move replies to the subscription.`;
}

function tellLimit(hit, at = clock.now()) {
  const text = limitText(hit);
  db.opsSet(LIMIT_KEY, JSON.stringify({ ...hit, told: at }));
  try { Promise.resolve(alertSend(text, `ops:api-limit:${hit.at}`)).catch(() => {}); } catch { /* never worth a reply */ }
  return text;
}

/** A failed paid call: the first usage-limit refusal of an episode texts the owner at once. */
export function noteLimitError(e, at = clock.now()) {
  if (!isUsageLimit(e)) return null;
  const open = limitHit();
  const hit = open
    ? { ...open, last: at, count: (open.count ?? 1) + 1 }
    : { at, last: at, count: 1, regain: regainWords(e?.message ?? e), told: 0 };
  db.opsSet(LIMIT_KEY, JSON.stringify(hit));
  // Seen during boot before anybody could be told: told on the next refusal, or by startAlerts.
  return !hit.told && alertSend ? tellLimit(hit, at) : null;
}

/** A paid call went through: the limit is lifted, the episode is over (the next one texts again). */
// A success within this long of the last refusal is most likely a call that started before the limit
// (a long reply, a phone call); it does not end the episode, or the next refusal would text again.
const LIFT_MARGIN_MS = 60_000;
export function clearLimitHit(at = clock.now()) {
  const open = limitHit();
  if (!open) return false;
  if (Number(at) - Number(open.last ?? open.at) < LIFT_MARGIN_MS) return false;
  db.opsDelete(LIMIT_KEY);
  db.opsSet("api_limit:last", JSON.stringify({ ...open, cleared: at }));
  return true;
}

const utc = (ms) => `${new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The "API usage limit" row on /ops. Shown, never texted by the pass: noteLimitError already did. */
export function limitCheck() {
  const open = limitHit();
  if (open) return {
    state: "bad", quiet: true,
    detail: `the provider is refusing paid calls: workspace usage limit reached since ${utc(open.at)}`
      + ` · ${open.count} refused${open.regain ? ` · access back ${open.regain} per the API` : ""}`
      + ` · ${open.told ? `owner texted ${utc(open.told)}` : "owner not texted yet"}`,
  };
  let last = null;
  try { last = JSON.parse(db.opsGet("api_limit:last") ?? "null"); } catch { /* none */ }
  return {
    state: "ok", quiet: true,
    detail: last ? `not hit now · last hit ${utc(last.at)}, over ${utc(last.cleared)} (${last.count} refused)` : "never hit",
  };
}

/** The 80% lines owed right now: `[{ which, key, text }]`, ones already sent this period left out. */
export function capWarningsDue({ now = clock.now() } = {}) {
  const s = apiSpent(now);
  const out = [];
  const one = (which, spent, cap, period, tail) => {
    if (!(cap > 0) || spent < cap * WARN_AT) return;
    // At or past the cap, the cap's own alert speaks (spendCheck); the heads-up would be late news.
    if (spent >= cap) return;
    const key = `api_warn:${which}:${period}`;
    if (db.opsGet(key)) return;
    out.push({ which, key, text: `Reason heads-up: API spend is at ${Math.floor(spent / cap * 100)}% of the ${which} cap, ${usd(spent)} of ${usd(cap)}${tail}.` });
  };
  one("daily", s.todayOther, config.apiDailyCapUsd, s.day, " today (phone calls not counted)");
  one("monthly", s.month, config.apiMonthlyCapUsd, s.day.slice(0, 7), " this month");
  return out;
}

/** Send each 80% line owed, once per day / month. Marked before it is sent: once, never twice. */
export function capWarnings({ now = clock.now(), send = alertSend, log = () => {} } = {}) {
  if (!send) return [];
  const due = capWarningsDue({ now });
  for (const w of due) {
    db.opsSet(w.key, String(now));
    try { Promise.resolve(send(w.text, `ops:${w.key}`)).catch(e => log({ api_warn_failed: firstLine(e) })); } catch (e) { log({ api_warn_failed: firstLine(e) }); }
    log({ api_warn_sent: w.which });
  }
  return due;
}

/** "daily 80% warning sent 2026-11-07 14:05 UTC", for the API spend row; "" when none this period. */
function warnedWords(now) {
  const day = today(now);
  return [["daily", day], ["monthly", day.slice(0, 7)]]
    .map(([which, p]) => [which, db.opsGet(`api_warn:${which}:${p}`)])
    .filter(([, at]) => at)
    .map(([which, at]) => `${which} ${Math.round(WARN_AT * 100)}% warning sent ${utc(at)}`)
    .join(" · ");
}

/** Drop usage rows past 35 days. Called from the retention sweep. */
export const prune = (now = clock.now()) => db.pruneModelUsage(now - 35 * DAY_MS);
