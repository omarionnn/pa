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

let outUntil = 0;
/** Note a failed API call: out of credit means the side checks skip the API for a while. */
export function noteApiError(e, at = clock.now()) {
  if (isLowCredit(e)) outUntil = at + config.apiOutPauseMs;
}
/**
 * Is the API known to be out of credit right now? Then a side check goes straight to its CLI
 * fallback rather than spend a round trip on a refusal it heard minutes ago. Clears by itself, so
 * a topped-up key is back in use within config.apiOutPauseMs.
 */
export const apiOut = (at = clock.now()) => at < outUntil;
/** For tests. */
export function resetApiOut() { outUntil = 0; }

/** An error that says the API was skipped, worded the way the outage checks read it. */
export const skippedForCredit = () => new Error("skipped: the API account is out of credit (credit balance too low)");

/**
 * One paid `messages.create`, recorded under `feature`. Throws what the SDK threw, after counting
 * it. Skipped outright (throws) while the key is known to be out of credit.
 */
export async function callApi({ feature, client, params, options = {} }) {
  if (apiOut()) throw skippedForCredit();
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
 * The "API spend" row: `{ state, detail }`. Red when paid calls were refused for want of credit in
 * the last hour (a feature that is not falling back is broken), amber past the daily cap. Both stay
 * wrong long enough to text the owner through ops' sustained-alert path.
 */
export function spendCheck({ now = clock.now(), cap = config.apiDailyCapUsd } = {}) {
  const s = summary({ now });
  const credit = db.lowCreditFailures(now - 60 * 60_000);
  const feats = (rows) => rows.slice(0, 4).map(r => `${r.feature} ${usd(r.usd)} (${r.calls})`).join(", ");
  const cli = s.today.cli.reduce((n, r) => n + r.calls, 0);
  const cliFeats = s.today.cli.slice().sort((a, b) => b.calls - a.calls || a.feature.localeCompare(b.feature)).slice(0, 4).map(r => `${r.feature} ${r.calls}`).join(", ");
  const parts = [
    `${usd(s.today.usd)} today${s.today.calls ? ` — ${feats(s.today.byFeature)}` : ""}`,
    `${usd(s.week.usd)} 7d${s.week.calls ? ` — ${feats(s.week.byFeature)}` : ""}`,
    `subscription: ${cli} run${cli === 1 ? "" : "s"} today${cli ? ` (${cliFeats})` : ""}`,
  ];
  // Out of credit is said by its own row (fallbackCheck), so the owner gets that one text, not two.
  if (credit.n) parts.unshift(`${credit.n} paid call${credit.n === 1 ? "" : "s"} refused for credit in the last hour`);
  if (cap > 0 && s.today.usd > cap) return { state: "warn", detail: `over the ${usd(cap)}/day cap · ${parts.join(" · ")}` };
  return { state: "ok", detail: parts.join(" · ") };
}

// ---------- the pre-reply checks on the subscription ----------

/** The short reads in front of every reply that fall back to the CLI when the API cannot answer. */
export const SIDE_CHECKS = ["harm", "purchase_topic", "onethought", "said_check"];
/** Failures in a row (not credit) before the key counts as failing rather than blipping. */
const FAILING_RUN = 3;

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
  if (last.length >= FAILING_RUN && last.every(r => !r.ok)) return { down: true, why: "failing", at: last[0].at, error: last[0].error };
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
  return {
    state: "bad",
    detail: `${f.why === "dry" ? "the API key is out of credit" : `the API key is failing (${f.error || "no answer"})`} — the pre-reply checks are on the subscription`,
    alert: `${cause}, so the pre-reply checks switched to the subscription; replies may be a few seconds slower until you ${f.why === "dry" ? "top up" : "check the key"}.`,
  };
}

/** Drop usage rows past 35 days. Called from the retention sweep. */
export const prune = (now = clock.now()) => db.pruneModelUsage(now - 35 * DAY_MS);
