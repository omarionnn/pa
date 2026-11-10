// The status page: one answer to "is Reason all right?" for the person running it, and a text
// the moment the answer changes.
//
// Everything on the page is a CHECK — a thing that is either fine or not, with the one line that
// says why. The page is green only when every check is. A yellow row keeps it from green on
// purpose: "green means perfect" is the whole point of having one word at the top.
//
// Three rules, and each is the reason for a piece of this file:
//
//   - **Nothing here is the model's.** Every verdict is a query against the database or a probe
//     against a provider. The model never writes a line of this page and is never asked whether
//     something is healthy.
//   - **Credit is "working, N calls today, and the link."** Most providers will not tell an
//     ordinary API key its balance, so the honest thing to show is whether the last call
//     succeeded, how many were made today, and where the real number lives. The count comes
//     from watching every outbound `fetch` in ONE place (`watchFetch`) rather than from
//     instrumenting fifty call sites — and a probe that goes out from here uses the raw fetch,
//     so checking never inflates the count it is checking.
//   - **Wrong texts the owner, whatever the hour.** Quiet hours belong to nudges about
//     somebody's life; "your assistant is broken" is not one of those. A change of state texts
//     once, bundled, and the all-clear texts once too. The same state on the next pass says
//     nothing, so a thing that stays broken is one text and not sixty.
//
// Who may see it: the owner's proved browser, exactly as for their pages (src/pages/access.js).
// The page carries their names and numbers, so a stranger who finds /ops gets the same gate as a
// stranger with a page link, and no button that reaches the owner's phone unless the link they
// hold carries the key only Reason hands out.
import { statfsSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import { spendCheck, fallbackCheck, callCapCheck, limitCheck, startAlerts as startSpendAlerts, stopAlerts as stopSpendAlerts, capWarnings } from "./spend.js";
import * as accounts from "./accounts.js";
import { opsLabel as planLabel } from "./plan.js";
import * as agentcard from "./agentcard.js";
import { config, clock, callbackUrl, isOwnLine } from "./config.js";
import { aboutThem } from "./outbox.js";
import { flightProviders, LEDGER as FLIGHT_LEDGER, monthOf } from "./flightproviders.js";
import * as subusage from "./subusage.js";
import * as incidents from "./incidents.js";
import * as digest from "./opsdigest.js";
import { join } from "node:path";

export const EVERY_MS = 5 * 60 * 1000;
/** Past this, the checks themselves are the thing that is wrong: the page says so instead of showing an old green. */
export const STALE_AFTER_MS = 3 * EVERY_MS;
export const PAGE = { id: "ops", title: "Reason status" };
const DAY = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
/** The task states that mean "still owed", from the one list the tasks table is written against. */
const OPEN_TASKS = db.TASK_OPEN.map(s => `'${s}'`).join(",");

/**
 * Rows whose red is a COUNT over a window — texts that failed, reminders given up on — rather
 * than a fault that is still there. "I fixed it" is a thing the owner can say about those, and
 * saying it restarts the window from that moment; a live fault (a key rejected, a sweep stuck)
 * has nothing to clear and clears itself the pass after it is really fixed.
 */
export const CLEARABLE = new Set(["outbox", "timers", "errors", "misses"]);
function clearedAt(id) { return Number(db.opsGet(`cleared:${id}`)) || 0; }
/** The owner pressed Clear on a row. True if that row is one that can be. */
export function clearCheck(id, at = clock.now()) {
  if (!CLEARABLE.has(id)) return false;
  db.opsSet(`cleared:${id}`, at);
  return true;
}
/** Where a windowed count starts: the window's edge, or the owner's clear if that is later. */
function windowFor(id, now, span) {
  const c = clearedAt(id);
  const cleared = c > now - span;
  return { since: cleared ? c : now - span, cleared, words: cleared ? `since you cleared it ${ago(now - c)} ago` : null };
}

const host = (base) => { try { return new URL(base).hostname; } catch { return null; } };

/**
 * Every outside service Reason can be configured to use, what shows it is set up, which hostnames
 * its calls go to (read from config so a `*_API_BASE` override still counts), where its real
 * account page is, and — where the provider offers a cheap authenticated GET — how to ask it
 * whether the key still works without spending anything.
 *
 * Providers with no `probe` are judged from the ledger of their own calls: a key that is wrong
 * shows the first time it is used, and that use texts the owner.
 */
export const PROVIDERS = [
  {
    id: "anthropic", name: "Anthropic", dashboard: "https://console.anthropic.com/settings/usage",
    hosts: () => ["api.anthropic.com"],
    configured: () => !!process.env.ANTHROPIC_API_KEY,
    probe: () => get("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }),
  },
  {
    id: "openai", name: "OpenAI", dashboard: "https://platform.openai.com/usage",
    hosts: () => [host(config.openaiBase)],
    configured: () => !!config.openaiKey,
    // A paid call (one embedding, a fraction of a cent a day), not /v1/models: listing models still
    // answers 200 with the balance at zero, so an out-of-credit key looked "working" while every
    // call, voice and recall failed.
    probe: () => post(`${config.openaiBase}/v1/embeddings`, { authorization: `Bearer ${config.openaiKey}`, "content-type": "application/json" }, { model: "text-embedding-3-small", input: "ok" }),
  },
  {
    // The phone line every call runs on (GPT-Live over Twilio, src/calls/gptlive.js): the account itself.
    id: "twilio", name: "Twilio", dashboard: "https://console.twilio.com/us1/monitor/logs/calls",
    hosts: () => ["api.twilio.com"],
    configured: () => !!(config.twilioSid && config.twilioToken),
    probe: () => get(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioSid)}.json`,
      { authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64")}` }),
  },
  {
    id: "sendblue", name: "Sendblue", dashboard: "https://app.sendblue.com",
    hosts: () => [host(config.sendblueBase)],
    configured: () => !!(config.sendblueKeyId && config.sendblueSecretKey),
    probe: () => get(`${config.sendblueBase}/api/account/webhooks`, { "sb-api-key-id": config.sendblueKeyId, "sb-api-secret-key": config.sendblueSecretKey }),
  },
  { id: "linq", name: "Linq", dashboard: "https://linqapp.com", hosts: () => [host(config.linqBase)], configured: () => !!config.linqKey },
  { id: "bland", name: "Bland", dashboard: "https://app.bland.ai", hosts: () => [host(config.blandBase)], configured: () => !!config.blandKey },
  {
    id: "gemini", name: "Gemini", dashboard: "https://aistudio.google.com/usage",
    hosts: () => [host(config.geminiBase)],
    configured: () => !!config.geminiKey,
    probe: () => get(`${config.geminiBase}/v1beta/models?pageSize=1&key=${encodeURIComponent(config.geminiKey)}`),
  },
  { id: "parallel", name: "Parallel", dashboard: "https://platform.parallel.ai", hosts: () => [host(config.parallelBase)], configured: () => !!config.parallelKey },
  { id: "contextdev", name: "Context.dev", dashboard: "https://context.dev", hosts: () => [host(config.contextDevBase)], configured: () => !!config.contextDevKey },
  { id: "tavily", name: "Tavily", dashboard: "https://app.tavily.com", hosts: () => [host(config.tavilyBase)], configured: () => !!config.tavilyKey },
  { id: "agentcard", name: "AgentCard", dashboard: "https://agentcard.sh", hosts: () => [host(config.agentcardApiBase)], configured: () => !!(config.agentcardClientId && config.agentcardClientSecret) },
  {
    id: "google", name: "Google", dashboard: "https://console.cloud.google.com/apis/dashboard",
    hosts: () => [host(config.googleAccountsBase), host(config.googleOauthBase), host(config.googleGmailBase), host(config.googleCalendarBase), host(config.googleDriveBase), "googleapis.com"],
    configured: () => !!(config.googleClientId && config.googleClientSecret),
  },
  { id: "spotify", name: "Spotify", dashboard: "https://developer.spotify.com/dashboard", hosts: () => [host(config.spotifyApiBase), host(config.spotifyAccountsBase)], configured: () => !!(config.spotifyClientId && config.spotifyClientSecret) },
  { id: "uber", name: "Uber", dashboard: "https://developer.uber.com/dashboard", hosts: () => [host(config.uberAuthBase), host(config.uberApiBase)], configured: () => !!(config.uberClientId && config.uberClientSecret) },
  { id: "github", name: "GitHub", dashboard: "https://github.com/settings/developers", hosts: () => [host(config.githubApiBase), host(config.githubBase)], configured: () => !!(config.githubClientId && config.githubClientSecret) },
  { id: "x", name: "X", dashboard: "https://developer.x.com/en/portal/dashboard", hosts: () => [host(config.xApiBase), host(config.xAuthBase)], configured: () => !!(config.xClientId && config.xClientSecret) },
];

// ---------- the ledger of outbound calls ----------

let rawFetch = globalThis.fetch;
let watching = false;

/** Which provider a URL belongs to, by exact host first and then by suffix (so `generativelanguage.googleapis.com` is Gemini, not Google). */
export function providerOf(input) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  const h = host(url ?? "");
  if (!h) return null;
  for (const p of PROVIDERS) for (const x of p.hosts()) if (x && h === x) return p.id;
  for (const p of PROVIDERS) for (const x of p.hosts()) if (x && h.endsWith(`.${x}`)) return p.id;
  return null;
}

/**
 * Count every call Reason makes to a provider, at the one place they all pass through.
 *
 * Installed once, before any adapter captures `globalThis.fetch`. A call to a host nobody on the
 * list owns is passed straight through. The ledger write can never fail the real call: a status
 * page is not worth a dropped text.
 */
export function watchFetch({ record = db.recordProviderCall, day = accounts.today } = {}) {
  if (watching) return;
  watching = true;
  rawFetch = globalThis.fetch;
  const real = rawFetch;
  globalThis.fetch = async function watchedFetch(input, init) {
    const provider = providerOf(input);
    if (!provider) return real(input, init);
    const t0 = Date.now();
    try {
      const res = await real(input, init);
      try { record({ provider, day: day(), ok: res.ok, status: res.status, ms: Date.now() - t0, error: res.ok ? "" : `HTTP ${res.status}` }); } catch { /* the ledger is not worth the call */ }
      return res;
    } catch (e) {
      try { record({ provider, day: day(), ok: false, status: 0, ms: Date.now() - t0, error: short(e) }); } catch { /* same */ }
      throw e;
    }
  };
  // Only counts, never answers: src/netguard.js reads this as the platform's own fetch.
  globalThis.fetch.passesThrough = true;
}

/** For a test that replaced `globalThis.fetch` after the watcher took it. */
export function unwatchFetch() {
  if (!watching) return;
  globalThis.fetch = rawFetch;
  watching = false;
}

async function get(url, headers = {}) {
  try {
    const res = await rawFetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: short(e) };
  }
}

async function post(url, headers, body) {
  try {
    const res = await rawFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) return { ok: true, status: res.status };
    // The error code says what a bare status cannot: OpenAI answers an empty balance with a 429
    // (`insufficient_quota`), the same status as a real rate limit.
    let code = "";
    try { code = String((await res.json())?.error?.code ?? ""); } catch { /* no JSON body */ }
    return { ok: false, status: res.status, ...(code ? { code } : {}) };
  } catch (e) {
    return { ok: false, status: 0, error: short(e) };
  }
}

/** A real embedding round-trip, one word long. Recall is only "working" if this is. */
const EMBED_PROBE = {
  id: "embeddings",
  probe: () => post(`${config.openaiBase}/v1/embeddings`, { authorization: `Bearer ${config.openaiKey}`, "content-type": "application/json" }, { model: "text-embedding-3-small", input: "ok" }),
};

const defaultProbe = (p) => (p.probe ? p.probe() : null);

// ---------- errors the process saw ----------

const errors = [];
/** A runtime error, kept in memory since restart: the sweep's own failures have nowhere else to be seen from. */
export function noteError(e, at = clock.now()) {
  errors.push({ at, message: short(e) });
  if (errors.length > 50) errors.shift();
  // The same error three times in one spell is a fault, not a blip: alerted then, not in five
  // minutes. Keyed on its words with the numbers taken out, so "row 412" and "row 413" are one.
  try {
    const shape = short(e).replace(/\d+/g, "#").slice(0, 80);
    incidents.raise({
      key: `error:${shape}`, area: "runtime", covers: "errors", threshold: ERROR_ALERT_AFTER, at,
      what: "Reason keeps hitting the same error", error: short(e),
      tried: "the sweep carries on and retries on its next pass",
      next: "journalctl -u reason -n 200 for the stack",
    });
  } catch { /* noting an error never throws one */ }
}
/** Repeats of one runtime error in a spell before it texts. One alone is usually somebody's odd input. */
export const ERROR_ALERT_AFTER = 3;

// ---------- the checks ----------

/** Rate-limited screens in an hour that make the safety screen check red, and unread ones that make it amber. */
const SCREEN_RATE_LIMITED_BAD = 3;
const SCREEN_UNREAD_WARN = 3;

const check = (id, group, label, state, detail, link = null) => ({ id, group, label, state, detail, ...(link ? { link } : {}) });
/** Red: the key is refused or the account is out of money — the owner's to fix, never a blip. */
const hardFail = (s, code = "") => [401, 402, 403].includes(Number(s)) || code === "insufficient_quota";

function failWords({ status, error, code }) {
  const s = Number(status);
  if (code === "insufficient_quota") return `out of credit (HTTP ${s} insufficient_quota)`;
  if (s === 401 || s === 403) return `key rejected (HTTP ${s})`;
  if (s === 402) return "out of credit (HTTP 402)";
  if (s === 429) return "rate limited (HTTP 429)";
  if (s >= 500) return `provider error (HTTP ${s})`;
  if (s) return `HTTP ${s}`;
  return error ? `unreachable (${trim(error, 60)})` : "unreachable";
}

/** The worst state wins. `off` is a thing not set up, which is not a thing wrong. */
export function verdictOf(checks) {
  if (checks.some(c => c.state === "bad")) return "bad";
  if (checks.some(c => c.state === "warn")) return "warn";
  return "ok";
}

/**
 * Run every check and return the report. No side effects: nothing is saved and nobody is texted
 * until `settle`. `probe` is injectable so the suite can run this with the network switched off.
 */
export async function runChecks({ runtime = null, router = null, now = clock.now(), probe = defaultProbe, onCheck = () => {}, usageFetch = (...a) => (rawFetch ?? globalThis.fetch)(...a) } = {}) {
  const day = accounts.today(now);
  // `onCheck` hears each row the moment it is decided, which is what lets the page fill in while a
  // pass is still running (2026-10-24: "Check again" sat blank for the whole pass). The database
  // rows land at once; the probed ones arrive as their providers answer, all asked together.
  const emit = (rows) => { for (const r of rows) { try { onCheck(r); } catch { /* a listener never breaks a pass */ } } return rows; };
  const alive = emit(aliveChecks({ runtime, router, now }));
  const people = emit(peopleChecks({ now, day }));
  const money = emit(moneyChecks({ now, day }));
  const quality = emit(qualityChecks({ now, day }));
  const [services, memory, subs] = await Promise.all([serviceChecks({ now, day, probe, emit }), memoryChecks({ now, probe, emit }), subscriptionChecks({ now, day, usageFetch, emit })]);
  const raised = emit([...incidentChecks(now), watchdogCheck(now), backupCheck(now)].filter(Boolean));
  const checks = [...raised, ...alive, ...people, ...subs, ...services, ...memory, ...money, ...quality];
  // Hourly counts behind the trend lines; a database too old for a column is a page without lines,
  // never a pass that fails.
  let trends = null;
  try { trends = db.opsTrends(now); } catch { /* no lines this pass */ }
  if (trends) {
    try { trends.subscriptions = { reason: subusage.hourlyFive("reason", now), coding: subusage.hourlyFive("coding", now) }; } catch { /* no lines */ }
  }
  return { at: now, checks, people: peopleRows({ now, day }), verdict: verdictOf(checks), trends };
}

/**
 * How full each Claude subscription is (src/subusage.js). Reason's own goes amber at 80% of its
 * five-hour window and texts through `settle` like any other row, because a full window is Reason
 * not replying. The Mac's is `quiet`: shown, never texted, and never red — Reason does not depend
 * on the Mac. Before reading, one backstop GET of the CLI's usage endpoint if Reason's reading is
 * old and the CLI has been used since; it spends nothing from either window.
 */
async function subscriptionChecks({ now, day, usageFetch, emit = (r) => r }) {
  try { await subusage.backstop({ fetchImpl: usageFetch, now }); } catch { /* the rows say how old the reading is */ }
  try { return emit(subusage.checks({ now, day })); } catch { return []; }
}

function aliveChecks({ runtime, router, now }) {
  const out = [];
  out.push(check("process", "alive", "Process", "ok", `up ${dur(process.uptime() * 1000)} · node ${process.version}`));

  if (!runtime) out.push(check("sweep", "alive", "Sweep", "off", "no runtime"));
  else if (!runtime.interval) out.push(check("sweep", "alive", "Sweep", "bad", "not running — reminders, tasks and watchers are not being checked"));
  else {
    // When a pass last FINISHED, not when one last started (2026-10-18). Passes no longer overlap,
    // so a pass hung in an await stops new ones starting and the start stamp just sits at the hung
    // pass's start — readable only as "slow". The completion stamp is the one that says the work is
    // getting done. Before any pass has finished, the start stamp is all there is.
    const last = runtime.lastSweepDoneAt ?? runtime.lastSweepAt ?? null;
    const late = last != null && now - last > Math.max(4 * config.sweepEveryMs, config.sweepStuckMs);
    out.push(check("sweep", "alive", "Sweep", late ? "bad" : "ok",
      late ? `last pass ${ago(now - last)} ago — stuck` : `every ${Math.round(config.sweepEveryMs / 1000)}s${last != null ? ` · last pass ${ago(now - last)} ago` : ""}`));
  }

  for (const s of router?.statuses?.() ?? []) {
    if (s.name === "console") continue;
    const state = s.status === "live" ? "ok" : s.configured ? "bad" : "off";
    out.push(check(`channel:${s.name}`, "alive", `Texting · ${s.name}`, state,
      s.status === "live" ? `live${s.number ? ` · ${s.number}` : ""}` : s.configured ? `not connected: missing ${(s.missing ?? []).join(", ")}` : "not set up"));
  }

  const lastIn = db.db.prepare("SELECT MAX(received_at) AS at, SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS today FROM inbound_messages").get(now - DAY);
  out.push(check("inbound", "alive", "Texts in", "ok", lastIn?.at ? `last ${ago(now - lastIn.at)} ago · ${lastIn.today ?? 0} in the last day` : "none yet"));

  const wo = windowFor("outbox", now, DAY);
  const ob = db.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state = 'sent' AND sent_at >= ? THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN state IN ('queued','unknown') AND attempts > 0 THEN 1 ELSE 0 END), 0) AS retrying,
      COALESCE(SUM(CASE WHEN state IN ('queued','unknown') THEN 1 ELSE 0 END), 0) AS waiting
    FROM outbox`).get(now - DAY);
  // A text to one of Reason's own lines (a test talking to itself) is not counted at all; one the
  // person's own settings refused (opted out, never texted the line) is amber; the rest are Reason's.
  const fails = db.db.prepare("SELECT address, last_error_key AS k, last_error FROM outbox WHERE state = 'failed' AND failed_at >= ? ORDER BY failed_at DESC").all(wo.since);
  const toSelf = fails.filter(f => isOwnLine(f.address)).length;
  const counted = fails.filter(f => !isOwnLine(f.address));
  const ours = counted.filter(f => !aboutThem(f.k)).length;
  const lastFail = counted[0] ?? null;
  const selfNote = toSelf ? ` · ${n(toSelf, "text")} to Reason's own line not counted` : "";
  // Red only for a failure that is Reason's: a person who opted out or never texted the line is on
  // the page as amber — never a live text to the owner about somebody else (review 11-06).
  out.push(check("outbox", "alive", "Texts out", ours ? "bad" : counted.length || ob.retrying ? "warn" : "ok",
    counted.length ? `${n(counted.length, "text")} failed ${wo.words ?? "in the last day"}${lastFail?.last_error ? ` — ${trim(digest.scrub(lastFail.last_error), 90)}` : ""}${selfNote}`
      : ob.retrying ? `${n(ob.retrying, "text")} retrying${selfNote}`
        : `${ob.sent} sent in the last day${ob.waiting ? ` · ${ob.waiting} waiting` : ""}${selfNote}`));

  const held = db.pendingInboundSummary(now);
  const overdue = held.filter(h => h.due && now - h.ready_at > 2 * 60 * 1000);
  out.push(check("holding", "alive", "Held messages", overdue.length ? "bad" : "ok",
    overdue.length ? `${n(overdue.length, "message")} past due and unanswered — the sweep is not picking them up`
      : held.length ? `${held.length} waiting out the quiet window` : "none"));

  const wt = windowFor("timers", now, 7 * DAY);
  const t = db.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN fired_at IS NULL AND cancelled_at IS NULL THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN fired_at IS NULL AND cancelled_at IS NULL AND attempts > 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS retrying,
      COALESCE(SUM(CASE WHEN gave_up_at IS NOT NULL AND gave_up_at >= ? THEN 1 ELSE 0 END), 0) AS missed
    FROM timers`).get(wt.since);
  out.push(check("timers", "alive", "Reminders", t.missed ? "bad" : t.retrying ? "warn" : "ok",
    t.missed ? `${n(t.missed, "reminder")} given up on ${wt.words ?? "this week"}` : t.retrying ? `${n(t.retrying, "reminder")} running late` : `${t.pending} pending`));

  const open = db.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN (${OPEN_TASKS})`).get().n;
  const overdueTasks = db.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN (${OPEN_TASKS}) AND next_wake_at IS NOT NULL AND next_wake_at <= ?`).get(now - 10 * 60 * 1000).n;
  out.push(check("tasks", "alive", "Long tasks", overdueTasks ? "warn" : "ok", overdueTasks ? `${n(overdueTasks, "task")} overdue to wake` : `${open} open`));

  const watches = db.db.prepare("SELECT COUNT(*) AS n FROM watches WHERE met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL").get().n;
  out.push(check("watches", "alive", "Watches", "ok", `${watches} live`));

  out.push(serverCheck());

  const we = windowFor("errors", now, DAY);
  const recent = errors.filter(x => x.at >= we.since);
  out.push(check("errors", "alive", "Errors since restart", recent.length ? "warn" : "ok",
    recent.length ? `${n(recent.length, "error")} ${we.words ?? "in the last day"} — last: ${trim(recent.at(-1).message, 100)}` : "none"));
  return out;
}

/** The alerts raised where they happened (src/incidents.js): shown here, texted from there. */
function incidentChecks(now) {
  try { return incidents.checks(now); } catch { return []; }
}

/**
 * The watchdog outside this process (scripts/watchdog.mjs, a systemd timer on the server). It
 * writes what it last saw to data/watchdog.json; a file that stops changing means the thing that
 * would notice this process dying has itself stopped, which is worth a text like anything else.
 * No file at all is a watchdog not installed — `off`, never red.
 */
export const WATCHDOG_LATE_MS = 5 * 60_000;
export function watchdogCheck(now = clock.now(), file = join(config.dataDir, "watchdog.json")) {
  let w;
  try { w = JSON.parse(readFileSync(file, "utf8")); } catch { return check("watchdog", "alive", "Watchdog", "off", "not installed on this host"); }
  const age = now - Number(w.at || 0);
  if (!(age < WATCHDOG_LATE_MS)) return check("watchdog", "alive", "Watchdog", "warn", `last ran ${ago(age)} ago — the outside check on this process has stopped (systemctl status reason-watchdog.timer)`);
  const openOnes = Object.entries(w.problems ?? {}).filter(([, p]) => p && p.resolved_at == null && p.texted_at != null);
  const said = openOnes.length ? ` · open: ${openOnes.map(([id, p]) => `${id} since ${new Date(p.since).toISOString().slice(11, 16)} UTC`).join(", ")}` : "";
  const lastAlert = w.last_alert ? ` · last alert ${ago(now - w.last_alert.at)} ago: ${trim(w.last_alert.what, 80)}` : "";
  // Quiet: whatever it found, it texted itself; this row is the page's view of it.
  return { ...check("watchdog", "alive", "Watchdog", "ok", `every minute · last ran ${ago(age)} ago${said}${lastAlert}`), quiet: true };
}

/**
 * The two backups (memory: reason-rolling-backup), both made by systemd timers outside this
 * process, and until 2026-11-09 not on this page at all:
 *   - the one rolling copy on the server, data/reason.db.bak-rolling, every 4am/4pm New York;
 *   - the encrypted off-site copy, written by /usr/local/bin/reason-offsite-backup at 4:30am New
 *     York, which leaves its result in data/offsite-backup.json ({ok, at, snapshot, step, message}).
 * A failed off-site run texts the owner itself, so that row is `quiet`; a copy that has simply
 * stopped being made tells nobody, so a late one is amber and goes the normal way.
 * Neither present is a host without backups set up (a laptop, the suite): `off`.
 */
export const ROLLING_LATE_MS = 13 * 60 * 60_000;
export const OFFSITE_LATE_MS = 27 * 60 * 60_000;
export function backupCheck(now = clock.now(), dir = config.dataDir) {
  let rollingAt = null;
  try { rollingAt = statSync(join(dir, "reason.db.bak-rolling")).mtimeMs; } catch { /* none */ }
  let off = null;
  try { off = JSON.parse(readFileSync(join(dir, "offsite-backup.json"), "utf8")); } catch { /* none */ }
  if (rollingAt == null && !off) return check("backup", "alive", "Backups", "off", "no backup set up on this host");
  const parts = [];
  let state = "ok";
  let quiet = false;
  const worse = (s) => { if (s === "bad" || (s === "warn" && state === "ok")) state = s; };
  if (rollingAt == null) { parts.push("no copy on the server"); worse("warn"); }
  else {
    const late = now - rollingAt > ROLLING_LATE_MS;
    parts.push(`server copy ${ago(now - rollingAt)} ago${late ? " — late (systemctl status reason-backup.timer)" : ""}`);
    if (late) worse("warn");
  }
  if (!off) { parts.push("no off-site copy"); worse("warn"); }
  else {
    const at = Date.parse(off.at ?? "") || 0;
    if (off.ok === false) {
      parts.push(`off-site FAILED ${at ? `${ago(now - at)} ago` : ""} at ${trim(off.step ?? "?", 30)}: ${trim(digest.scrub(String(off.message ?? "")), 90)}`);
      worse("bad"); quiet = true;
    } else {
      const late = !at || now - at > OFFSITE_LATE_MS;
      parts.push(`off-site ${at ? `${ago(now - at)} ago` : "time unknown"}${off.snapshot ? ` · snapshot ${trim(off.snapshot, 12)}` : ""}${late ? " — late (systemctl status reason-offsite-backup.timer)" : ""}`);
      if (late) worse("warn");
    }
  }
  const row = check("backup", "alive", "Backups", state, parts.join(" · "));
  return quiet ? { ...row, quiet: true } : row;
}

// ---------- the event loop, for /alive ----------

let lagMs = 0;
let lagTimer = null;
/** How late a one-second tick last fired. A hung loop answers nothing at all; a slow one shows here. */
export function startLoopWatch(everyMs = 1000) {
  if (lagTimer) return;
  let expected = Date.now() + everyMs;
  lagTimer = setInterval(() => { const t = Date.now(); lagMs = Math.max(0, t - expected); expected = t + everyMs; }, everyMs);
  lagTimer.unref?.();
}

/**
 * The lightweight answer the watchdog reads every minute: no probes and no queries beyond one, so
 * it is cheap enough to ask often and only slow when the process itself is.
 */
export function alive({ runtime = null, now = clock.now() } = {}) {
  const last = runtime?.lastSweepDoneAt ?? runtime?.lastSweepAt ?? null;
  const stuckAfter = Math.max(4 * config.sweepEveryMs, config.sweepStuckMs);
  let openAlerts = null;
  try { openAlerts = incidents.open().length; } catch { /* the database answering is not this endpoint's question */ }
  return {
    ok: true, pid: process.pid, up_s: Math.round(process.uptime()),
    loop_lag_ms: lagMs,
    sweeping: !!runtime?.interval,
    sweep_age_ms: last != null ? now - last : null,
    sweep_stuck: !!runtime?.interval && last != null && now - last > stuckAfter,
    sweep_stuck_after_ms: stuckAfter,
    open_alerts: openAlerts,
  };
}

function serverCheck() {
  let disk = null;
  try {
    const s = statfsSync(config.dataDir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    disk = { total, free, usedPct: total ? Math.round(100 * (1 - free / total)) : 0 };
  } catch { /* said as unknown below */ }
  const load = os.loadavg()[0];
  const cpus = os.cpus().length || 1;
  const freeShare = disk && disk.total ? disk.free / disk.total : 1;
  const state = freeShare < 0.10 ? "bad" : freeShare < 0.20 || load > cpus * 2 ? "warn" : "ok";
  return check("server", "alive", "Server", state,
    `${disk ? `disk ${disk.usedPct}% used, ${gb(disk.free)} free` : "disk unknown"} · load ${load.toFixed(2)} on ${n(cpus, "cpu")}`);
}

function peopleRows({ now, day }) {
  const turns = Object.fromEntries(db.db.prepare("SELECT conversation_id, turns FROM usage WHERE day = ?").all(day).map(r => [r.conversation_id, r.turns]));
  const openTasks = Object.fromEntries(db.db.prepare(`SELECT conversation_id, COUNT(*) AS n FROM tasks WHERE state IN (${OPEN_TASKS}) GROUP BY conversation_id`).all().map(r => [r.conversation_id, r.n]));
  const owed = Object.fromEntries(db.db.prepare("SELECT conversation_id, COUNT(*) AS n FROM outbox WHERE state IN ('queued','unknown','failed') AND created_at >= ? GROUP BY conversation_id").all(now - DAY).map(r => [r.conversation_id, r.n]));
  let week = {};
  try { week = db.opsWeekByConversation(now); } catch { /* no bars */ }
  // Most recently active first: the page's people list reads top-down as "who is using it now".
  return db.listAccountsOfPeople().map(a => ({
    conversation: a.conversation_id,
    name: a.name || (a.is_operator ? config.ownerName : ""),
    address: a.address,
    // A database from before the column existed has no `state`; it is read as active everywhere
    // else (accounts.accountState), so it is here too.
    state: a.state ?? "active",
    operator: !!a.is_operator,
    // One of Reason's own phone lines that once texted another (a test): listed, never counted as a person.
    own_line: isOwnLine(a.address),
    last_seen_at: a.last_seen_at ?? null,
    turns_today: turns[a.conversation_id] ?? 0,
    // Where they stand on Reason's own plan (src/plan.js): "trial 3/25", "free", "paid", "lapsed",
    // "cancelled · until …". Null while REASON_PAYWALL is off, and the page shows nothing.
    plan: planLabel(a.conversation_id, now),
    open_tasks: openTasks[a.conversation_id] ?? 0,
    texts_owed: owed[a.conversation_id] ?? 0,
    week: week[a.conversation_id] ?? [0, 0, 0, 0, 0, 0, 0],
  })).sort((x, y) => (y.last_seen_at ?? 0) - (x.last_seen_at ?? 0));
}

function peopleChecks({ now, day }) {
  const people = peopleRows({ now, day }).filter(p => p.state === "active" && !p.own_line);
  const seen24 = people.filter(p => p.last_seen_at && now - p.last_seen_at < DAY).length;
  const seen7 = people.filter(p => p.last_seen_at && now - p.last_seen_at < 7 * DAY).length;
  const turns = people.reduce((s, p) => s + p.turns_today, 0);
  const out = [check("people", "people", "People", "ok",
    `${n(people.length, "person", "people")} on the line · ${seen24} texted in the last day · ${seen7} this week · ${n(turns, "turn")} today`)];
  const pending = db.listAccessRequests({ state: "pending" });
  out.push({ ...check("access", "people", "Waiting for a yes", pending.length ? "warn" : "ok",
    pending.length ? `${n(pending.length, "person", "people")} asked for access and ${pending.length === 1 ? "has" : "have"} no answer: ${pending.slice(0, 4).map(r => r.display_name || r.address).join(", ")}`
      : "nobody waiting"),
    // What reaches his phone says how many, never who: the names are on the page (owner, 2026-11-06).
    ...(pending.length ? { alert: `Waiting for a yes: ${n(pending.length, "person", "people")} asked for access and ${pending.length === 1 ? "has" : "have"} no answer — see the status page.` } : {}) });
  return out;
}

async function serviceChecks({ now, day, probe, emit = (r) => r }) {
  const roles = { [config.searchProvider]: "search", [config.callProvider]: "calls" };
  // Every provider asked at once rather than one after another: a pass is as slow as the slowest
  // provider, not the sum of them. The rows keep PROVIDERS' order whatever order the answers come in.
  const out = await Promise.all(PROVIDERS.map(async (p) => {
    const role = roles[p.id] ?? null;
    const label = role ? `${p.name} · ${role}` : p.name;
    const id = `provider:${p.id}`;
    if (!p.configured()) {
      return emit([check(id, "services", label, role ? "bad" : "off", role ? `chosen for ${role} but not set up` : "not set up", p.dashboard)])[0];
    }
    const calls = db.providerCalls(p.id, day);
    const tail = `${n(calls.calls, "call")} today${calls.failures ? `, ${calls.failures} failed` : ""}`;
    // Only a provider that offers a cheap authenticated read is probed; the rest are judged from
    // the ledger of their own calls, which is also what keeps a test's "everything is fine" probe
    // from pretending a provider was asked.
    const probed = p.probe ? await probe(p) : null;
    let state, detail;
    let quiet = false;
    if (probed) {
      state = probed.ok ? "ok" : hardFail(probed.status, probed.code) ? "bad" : "warn";
      detail = probed.ok ? `working · ${tail}` : `${failWords(probed)} · ${tail}`;
      // The probe proves the key, not the calls Reason really makes (2026-11-09: Gemini's model list
      // answered 200 every pass while every real Gemini call for four days came back 404, and the
      // row stayed green). A real call that failed in the last day, with no good one since, is amber
      // — shown, not texted: the key works, so it is a broken feature to look at, not an outage.
      // Only a refusal that will happen again (a 4xx, not a timeout, a 5xx or a rate limit): a blip
      // on a real call followed by a good probe is still a blip, and stays green.
      const last = probed.ok ? db.providerState(p.id) : null;
      const st = Number(last?.last_status);
      const lasting = st >= 400 && st < 500 && st !== 408 && st !== 429;
      if (lasting && last.last_fail_at && now - last.last_fail_at < DAY && (!last.last_ok_at || last.last_fail_at > last.last_ok_at)) {
        state = "warn"; quiet = true;
        detail = `key works, but the last real call failed ${ago(now - last.last_fail_at)} ago: ${failWords({ status: last.last_status, error: last.last_error })} · ${tail}`;
      } else if (calls.failures && last?.last_fail_at) {
        detail += ` · last failure ${ago(now - last.last_fail_at)} ago`;
      }
    } else {
      const last = db.providerState(p.id);
      if (!last || (!last.last_ok_at && !last.last_fail_at)) { state = "ok"; detail = "ready · no calls yet"; }
      else if (last.last_fail_at && (!last.last_ok_at || last.last_fail_at > last.last_ok_at)) {
        state = hardFail(last.last_status) ? "bad" : "warn";
        detail = `last call failed ${ago(now - last.last_fail_at)} ago: ${failWords({ status: last.last_status, error: last.last_error })} · ${tail}`;
      } else { state = "ok"; detail = `working · last call ${ago(now - last.last_ok_at)} ago · ${tail}`; }
    }
    const row = check(id, "services", label, state, detail, p.dashboard);
    return emit([quiet ? { ...row, quiet: true } : row])[0];
  }));
  const turns = db.db.prepare("SELECT COALESCE(SUM(turns), 0) AS n FROM usage WHERE day = ?").get(day).n;
  out.push(...emit([check("brain", "services", "Brain", "ok",
    config.backend === "claude-cli" ? `Claude CLI on the subscription · ${n(turns, "turn")} today` : `Anthropic API · ${config.model} · ${n(turns, "turn")} today`)]));
  out.push(...emit([flightSearchCheck({ now, day })]));
  return out;
}

/**
 * Flight search (SerpApi, then Duffel — src/flightproviders.js): which sources have a key, how much
 * of this month's free allowance is used, and how the LAST REAL search went, read off the call
 * ledger. Never probed: a probe would spend the free searches it is here to protect. With no key it
 * is "off" — every search then answers with a Google Flights link, which is the designed fallback.
 */
export function flightSearchCheck({ now = clock.now(), day = accounts.today(now), source = flightProviders() } = {}) {
  const label = "Flight search";
  const keys = source.keys();
  if (!keys.serpapi && !keys.duffel) return check("flights", "services", label, "off", "no SERPAPI_API_KEY or DUFFEL_ACCESS_TOKEN — searches answer with a Google Flights link");
  const month = monthOf(now);
  const limits = source.limits();
  const parts = [];
  let worst = "ok";
  let quiet = true;
  for (const name of ["serpapi", "duffel"]) {
    if (!keys[name]) continue;
    const used = db.flightProviderSearches(name, month);
    const id = FLIGHT_LEDGER[name];
    const calls = db.providerCalls(id, day);
    const last = db.providerState(id);
    let words = `${name} ${used}/${limits[name]} this month, ${n(calls.calls, "search", "searches")} today${calls.failures ? ` (${calls.failures} failed)` : ""}`;
    if (used >= limits[name]) {
      words += " · month's allowance used, skipped until the 1st";
      if (worst === "ok") worst = "warn";
    }
    const failedLast = last?.last_fail_at && (!last.last_ok_at || last.last_fail_at > last.last_ok_at);
    if (failedLast) {
      const kind = String(last.last_error || "").split(":")[0];
      words += ` · last failed ${ago(now - last.last_fail_at)} ago: ${trim(last.last_error, 60)}`;
      worst = "warn";
      // A bad key is the owner's to fix; a slow or unreachable API is not.
      if (kind === "auth" || kind === "provider") quiet = false;
    }
    parts.push(words);
  }
  const row = check("flights", "services", label, worst, parts.join(" · "));
  return quiet ? { ...row, quiet: true } : row;
}

async function memoryChecks({ now, probe, emit = (r) => r }) {
  const out = [];
  const facts = db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings").get().n;
  const openai = PROVIDERS.find(p => p.id === "openai");
  if (!config.openaiKey) {
    out.push(check("embeddings", "memory", "Recall (vectors)", "bad",
      `no OPENAI_API_KEY on this install — new facts are not being embedded, so recall falls back to plain matching · ${n(facts, "fact")} embedded so far`, openai.dashboard));
  } else {
    const r = await probe(EMBED_PROBE);
    const ok = !!r?.ok;
    out.push(check("embeddings", "memory", "Recall (vectors)", ok ? "ok" : hardFail(r?.status, r?.code) ? "bad" : "warn",
      ok ? `a real embedding round-trip worked · ${n(facts, "fact")} embedded` : `embedding call failed: ${failWords(r ?? {})} · ${n(facts, "fact")} embedded`, openai.dashboard));
  }
  const q = db.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state = 'pending' AND attempts < 3 THEN 1 ELSE 0 END), 0) AS pending,
      MIN(CASE WHEN state = 'pending' AND attempts < 3 THEN created_at END) AS oldest,
      COALESCE(SUM(CASE WHEN state = 'pending' AND attempts >= 3 THEN 1 ELSE 0 END), 0) AS stuck,
      COALESCE(SUM(CASE WHEN state = 'done' AND processed_at >= ? THEN 1 ELSE 0 END), 0) AS done
    FROM extraction_queue`).get(now - DAY);
  const lastErr = q.stuck ? db.db.prepare("SELECT last_error FROM extraction_queue WHERE state = 'pending' AND attempts >= 3 ORDER BY id DESC LIMIT 1").get() : null;
  const backlog = q.oldest != null && now - q.oldest > 60 * 60 * 1000;
  out.push(check("extraction", "memory", "Memory extraction", q.stuck || backlog ? "warn" : "ok",
    q.stuck ? `${n(q.stuck, "message")} gave up after 3 tries${lastErr?.last_error ? ` — ${trim(lastErr.last_error, 80)}` : ""}`
      : backlog ? `backlog of ${q.pending}, oldest ${ago(now - q.oldest)} old`
        : `${q.done} processed in the last day${q.pending ? ` · ${q.pending} queued` : ""}`));
  return emit(out);
}

function moneyChecks({ now, day }) {
  const out = [];
  const today = db.db.prepare("SELECT COALESCE(SUM(cents), 0) AS c, COUNT(CASE WHEN cents > 0 THEN 1 END) AS k FROM spend WHERE day = ?").get(day);
  const month = db.db.prepare("SELECT COALESCE(SUM(cents), 0) AS c FROM spend WHERE day LIKE ?").get(`${day.slice(0, 7)}-%`);
  const capCents = Math.round((config.maxSpendPerDay || 0) * 100);
  const top = db.db.prepare("SELECT COALESCE(MAX(c), 0) AS c FROM (SELECT SUM(cents) AS c FROM spend WHERE day = ? GROUP BY conversation_id)").get(day).c;
  const reached = capCents > 0 && top >= capCents;
  out.push(check("spend", "money", "Approved spend", reached ? "warn" : "ok",
    `${money(today.c)} today across ${n(today.k, "commit")} · ${money(month.c)} this month`
      + (capCents ? ` · daily cap ${money(capCents)} per person${reached ? " — somebody has reached it" : ""}` : " · no daily cap set")));

  const calls = db.db.prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(call_seconds), 0) AS secs FROM usage WHERE day = ?").get(day);
  const cost = db.db.prepare("SELECT COALESCE(SUM(cost_cents), 0) AS c FROM calls WHERE created_at >= ?").get(now - DAY).c;
  // What the paid API key spent, by feature, and how often the subscription was used instead
  // (src/spend.js). Amber while a hard cap holds the key shut: one text in the owner's words when it
  // starts (sustained-alert path below), none when it lifts at midnight (`quietRecovery`).
  const own = (r) => ({ ...(r.alert ? { alert: r.alert } : {}), ...(r.quietRecovery ? { quietRecovery: true } : {}) });
  try {
    const sp = spendCheck({ now });
    out.push({ ...check("api_spend", "money", "API spend today / 7d by feature", sp.state, sp.detail, PROVIDERS.find(p => p.id === "anthropic").dashboard), ...own(sp) });
  } catch (e) { out.push(check("api_spend", "money", "API spend today / 7d by feature", "warn", `could not be read: ${short(e)}`)); }
  try {
    const cc = callCapCheck({ now });
    out.push({ ...check("api_call_cap", "money", "Phone calls on the API", cc.state, cc.detail), ...own(cc) });
  } catch (e) { out.push(check("api_call_cap", "money", "Phone calls on the API", "warn", `could not be read: ${short(e)}`)); }
  // The provider's own workspace usage limit (2026-11-05: hit with no warning). Texted from
  // src/spend.js the moment the refusal is seen; `quiet` here so this pass never texts it again.
  try {
    const lc = limitCheck();
    out.push({ ...check("api_limit", "money", "API usage limit (provider)", lc.state, lc.detail, PROVIDERS.find(p => p.id === "anthropic").dashboard), quiet: true });
  } catch (e) { out.push({ ...check("api_limit", "money", "API usage limit (provider)", "warn", `could not be read: ${short(e)}`), quiet: true }); }
  // The checks in front of every reply on the subscription because the key is dry or failing: one
  // text in the owner's words when it starts, one when it ends (alertText `alert` / `recovered`).
  try {
    const fb = fallbackCheck();
    out.push({ ...check("api_fallback", "money", "Pre-reply checks", fb.state, fb.detail), ...(fb.alert ? { alert: fb.alert } : {}), ...(fb.recovered ? { recovered: fb.recovered } : {}) });
  } catch (e) { out.push(check("api_fallback", "money", "Pre-reply checks", "warn", `could not be read: ${short(e)}`)); }

  out.push(check("calls", "money", "Phone calls", "ok", `${n(calls.calls, "call")} today · ${Math.round(calls.secs / 60)} min${cost ? ` · ${money(cost)} in the last day` : ""}`));
  try {
    const pk = pickupCheck();
    out.push(check("call_pickup", "money", "Calls: pickup → first word", pk.state, pk.detail));
  } catch (e) { out.push(check("call_pickup", "money", "Calls: pickup → first word", "warn", `could not be read: ${short(e)}`)); }

  // Only what really happened at the till (2026-10-24: "4 purchases in the last day · $50.30" when
  // nothing had been bought — two carts shown, one still shopping). A cart shown or never confirmed
  // is not a purchase; a placed order, a cancelled one, a decline and an outcome nobody knows are.
  const outcome = Object.fromEntries(db.db.prepare(`SELECT status, COUNT(*) AS k, COALESCE(SUM(amount_cents), 0) AS c
    FROM agentcard_purchases WHERE created_at >= ? AND status IN (${PURCHASE_OUTCOMES.map(x => `'${x}'`).join(",")})
    GROUP BY status`).all(now - DAY).map(r => [r.status, r]));
  const k = (...ss) => ss.reduce((t, x) => t + (outcome[x]?.k ?? 0), 0);
  const placed = k("placed", "partially_placed");
  const placedCents = (outcome.placed?.c ?? 0) + (outcome.partially_placed?.c ?? 0);
  const cancelled = k("cancelled"), declined = k("declined", "failed"), unknownBuys = k("outcome_unknown");
  const parts = [
    `${placed} placed${placed ? ` (${money(placedCents)})` : ""}`,
    ...(cancelled ? [`${cancelled} cancelled`] : []),
    ...(declined ? [`${declined} declined`] : []),
    ...(unknownBuys ? [`${unknownBuys} outcome unknown`] : []),
  ];
  out.push(check("purchases", "money", "Card purchases", unknownBuys ? "bad" : declined ? "warn" : "ok",
    placed + cancelled + declined + unknownBuys ? `${parts.join(" · ")} in the last day` : "nothing bought in the last day",
    PROVIDERS.find(p => p.id === "agentcard").dashboard));

  out.push(...cardConnectionChecks({ now }));
  return out;
}

/**
 * How long the person who picked up waited for Reason's first word (the 2026-11-07 review: 4–5 s on
 * business calls, and they hung up). From the call rows' `first_audio_ms` (src/calls/gptlive.js),
 * the last 20 calls that spoke. Amber when the typical wait is over two seconds.
 */
export function pickupCheck({ limit = 20 } = {}) {
  const rows = db.db.prepare("SELECT id, first_audio_ms AS ms, pickup_opener AS opener, is_owner FROM calls WHERE first_audio_ms IS NOT NULL ORDER BY id DESC LIMIT ?").all(limit);
  if (!rows.length) return { state: "ok", detail: "no calls timed yet" };
  const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const slow = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
  const last = rows[0];
  const errands = rows.filter(r => Number(r.is_owner) !== 1);
  const opened = errands.filter(r => r.opener).length;
  const detail = `last ${rows.length}: typical ${s(median)}, slowest ${s(slow.ms)} (call ${slow.id})`
    + ` · latest call ${last.id} ${s(last.ms)}${last.opener ? " (opener clip)" : ""}`
    + (errands.length ? ` · opener clip on ${opened}/${errands.length} errand calls` : "");
  return { state: median > 2000 ? "warn" : "ok", detail, median, slowest: slow.ms };
}

/** Statuses that are something that really happened to money. Not shopping, cart_shown or awaiting_approval. */
export const PURCHASE_OUTCOMES = ["placed", "partially_placed", "cancelled", "declined", "failed", "outcome_unknown"];

/**
 * One row per person who has ever connected a card: is the link between their card and this
 * install still good?
 *
 *   ok        — a live token, rotated by the sweep before it ends
 *   expiring  — the token has run out and the last refresh could not reach AgentCard; the sweep is
 *               retrying, nobody has to do anything yet
 *   dead      — AgentCard refused the refresh token (or there is none): only a new vault link
 *               brings it back
 *
 * Only the owner's row can text: theirs goes `bad` and through the sustained-alert path like any
 * other. Everybody else's is shown on the page and marked `quiet` — ops never texts them, and a
 * tester's lapsed link is not the owner's emergency. Reason sends that person a link itself the
 * next time they try to buy.
 */
export function cardConnectionChecks({ now = clock.now() } = {}) {
  let rows = [];
  try { rows = db.listAgentcardConnections(); } catch { return []; }
  return rows.map(r => {
    const owner = r.conversation_id === config.ownerConversation;
    const acct = db.getAccount(r.conversation_id);
    const name = acct?.name || (owner ? config.ownerName : "") || "someone";
    const st = cardConnectionState(r, now);
    const detail = st.state === "ok" ? `connected · token good for ${dur(st.leftMs)}${r.refreshed_at ? ` · last refreshed ${ago(now - r.refreshed_at)} ago` : ""}`
      : st.state === "expiring" ? `token ran out ${ago(now - st.expiredAt)} ago and the refresh could not reach AgentCard${r.refresh_error ? ` (${trim(r.refresh_error, 60)})` : ""} — retrying`
        : `dead — ${name} needs to reconnect their card (open a new card link)${r.connection_dead_at ? ` · AgentCard refused the refresh ${ago(now - r.connection_dead_at)} ago` : ""}`;
    const state = st.state === "ok" ? "ok" : owner ? (st.state === "dead" ? "bad" : "warn") : "warn";
    return { ...check(owner ? "card_connection" : `card_connection:${r.conversation_id}`, "money", `Card connection — ${name}`, state, detail, PROVIDERS.find(p => p.id === "agentcard").dashboard), ...(owner ? {} : { quiet: true }) };
  });
}

/** ok | expiring | dead for one agentcard_users row — agentcard.connectionState, shared with vault_enroll. */
export function cardConnectionState(r, now = clock.now()) {
  return agentcard.connectionState(r, now);
}

function qualityChecks({ now, day }) {
  const out = [];
  const unknown = db.db.prepare("SELECT COUNT(*) AS n FROM unknown_outcomes WHERE cleared_at IS NULL").get().n;
  out.push(check("unknown", "quality", "Unknown outcomes", unknown ? "bad" : "ok",
    unknown ? `${n(unknown, "action")} whose result is not known — money or a message may or may not have gone` : "none"));

  const wm = windowFor("misses", now, DAY);
  const misses = db.db.prepare("SELECT capability, COUNT(*) AS n FROM capability_misses WHERE created_at >= ? AND resolved_at IS NULL GROUP BY capability ORDER BY n DESC").all(wm.since);
  const missed = misses.reduce((s, m) => s + m.n, 0);
  out.push(check("misses", "quality", "Could not do it", missed ? "warn" : "ok",
    missed ? `${n(missed, "time")} ${wm.words ?? "in the last day"}: ${misses.slice(0, 4).map(m => `${m.capability} ×${m.n}`).join(", ")}` : "nothing asked for that Reason could not do"));

  // Only what was actually stopped. harm_events also counts messages the screen could not read
  // (since #51), and those are the check below, not refusals.
  const harm = db.db.prepare("SELECT COUNT(*) AS n FROM harm_events WHERE at >= ? AND verdict IN ('harm', 'withheld')").get(now - DAY).n;
  out.push(check("harm", "quality", "Hard line", "ok", harm ? `${n(harm, "message")} stopped in the last day` : "nothing stopped in the last day"));

  // The screen in front of every text, when it could not answer. A message nobody screened runs
  // with its outward tools held, so a run of them is Reason working with its hands tied; a run of
  // 429s is the API refusing for capacity, which needs the plan or the key looked at, not the code.
  const hour = now - 3_600_000;
  const unread = db.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(category = 'rate_limited'), 0) AS limited FROM harm_events WHERE at >= ? AND verdict = 'unscreened'").get(hour);
  out.push(check("screen", "quality", "Safety screen",
    unread.limited >= SCREEN_RATE_LIMITED_BAD ? "bad" : unread.n >= SCREEN_UNREAD_WARN ? "warn" : "ok",
    unread.n
      ? `${n(unread.n, "message")} could not be screened in the last hour${unread.limited ? ` · ${unread.limited} rate-limited (429) by Anthropic` : ""}`
      : "every message screened in the last hour",
    PROVIDERS.find(p => p.id === "anthropic").dashboard));

  const asked = db.db.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'asked_back' AND created_at >= ?").get(now - DAY).n;
  const turns = db.db.prepare("SELECT COALESCE(SUM(turns), 0) AS n FROM usage WHERE day = ?").get(day).n;
  out.push(check("asked_back", "quality", "Asked instead of acting", "ok", `${n(asked, "time")} in the last day${turns ? ` · ${n(turns, "turn")} today` : ""}`));
  return out;
}

// ---------- saving, and the text ----------

/**
 * How long a check has to stay wrong before the owner is texted about it. A pass runs every five
 * minutes, so this is "still wrong on the next pass". Most of what went red on 2026-10-22/23 was
 * an OpenAI blip — one timed-out or 500'd embedding call — and every one was green again five
 * minutes later: eighteen "needs you" / "back to normal" pairs in two days, none of which needed
 * him. Everything that was really wrong (memory extraction stuck, texts failing, the safety screen
 * down) stayed wrong for half an hour or more, so it still texts, about five minutes later.
 */
export const ALERT_AFTER_MS = 4 * 60_000;

/**
 * Write the report down and text the owner about what needs him.
 *
 * A check that has gone wrong is texted once it has STAYED wrong for ALERT_AFTER_MS — at any hour.
 * One that clears before that is logged and nothing more. "Back to normal" is said only about a
 * check he was actually told was wrong; a blip he never heard about gets no all-clear either. One
 * text per pass, however many lines, and nothing at all when nothing needs him.
 */
export function settle({ report, runtime = null, log = () => {}, silent = new Set() }) {
  const changes = [];
  // Rows a failure already texted about the moment it happened (src/incidents.js). Their alert and
  // their "resolved" come from there; a second text from this pass would be the same news twice.
  let covered = new Set();
  try { covered = incidents.coveredIds(); } catch { /* none */ }
  for (const c of report.checks) {
    const saved = db.saveOpsCheck({ id: c.id, state: c.state, detail: c.detail, at: report.at });
    c.since = saved.since;
    const told = db.opsGet(`alerted:${c.id}`);
    const wrong = c.state === "bad" || c.state === "warn";
    // `quiet`: shown on the page, never texted — somebody else's card link (cardConnectionChecks).
    if (c.quiet) continue;
    // `silent`: the row the owner just cleared by hand. They know; a "back to normal" would be noise.
    if (silent.has(c.id)) { if (!wrong) db.opsDelete(`alerted:${c.id}`); continue; }
    // Once an alert has spoken for a row, it speaks for the rest of that row's red spell too: a
    // count over a day ("1 text failed") stays red long after the alert itself has resolved.
    if (wrong && (covered.has(c.id) || String(told ?? "").startsWith("incident@"))) {
      // The alert takes the row over, including a row this pass had already texted about: its
      // "resolved" is the one all-clear, so this pass's "back to normal" would be a second.
      if (!String(told ?? "").startsWith("incident@")) db.opsSet(`alerted:${c.id}`, `incident@${saved.since}`);
      continue;
    }
    if (!wrong && String(told ?? "").startsWith("incident@")) { db.opsDelete(`alerted:${c.id}`); continue; }
    if (wrong) {
      // Told about this very episode already (same state, same start): nothing new.
      if (told === `${c.state}@${saved.since}`) continue;
      if (report.at - saved.since >= ALERT_AFTER_MS) {
        changes.push({ kind: "wrong", check: c });
        db.opsSet(`alerted:${c.id}`, `${c.state}@${saved.since}`);
      } else if (saved.previous !== c.state) {
        log({ ops_blip: c.id, state: c.state, detail: c.detail.slice(0, 120) });
      }
    } else if (told) {
      // `quietRecovery`: a cap lifting at midnight is expected, not news worth a late-night text.
      // The all-clear goes the way its alert went: live after a live one, in the digest otherwise.
      if (!c.quietRecovery) changes.push({ kind: "fixed", check: c, live: db.opsGet(`alerted_live:${c.id}`) === "1" });
      db.opsDelete(`alerted:${c.id}`);
      db.opsDelete(`alerted_live:${c.id}`);
    } else if (saved.previous === "bad" || saved.previous === "warn") {
      log({ ops_blip_cleared: c.id });
    }
  }
  db.opsSet("report", JSON.stringify(report));
  // Only an emergency is texted now (an outage, a service down, a spending cap near or at its
  // limit); everything else waits for the one daily digest (src/opsdigest.js, owner 2026-11-06).
  const live = changes.filter(ch => ch.kind === "wrong" ? digest.checkIsUrgent(ch.check) : ch.live);
  const later = changes.filter(ch => !live.includes(ch));
  for (const ch of live) if (ch.kind === "wrong") db.opsSet(`alerted_live:${ch.check.id}`, "1");
  for (const ch of later) {
    const line = ch.kind === "wrong"
      ? (ch.check.alert ?? `${ch.check.label}: ${ch.check.detail}`)
      : (ch.check.recovered ?? `${ch.check.label} is back to normal.`);
    try { digest.hold({ text: line, key: `check:${ch.check.id}` }); } catch (e) { log({ ops_digest_hold_failed: short(e) }); }
  }
  const text = alertText(live, report);
  // Never who or what — the system problem only (owner, 2026-11-06); digest.hold scrubs its own.
  if (text && runtime?.say) {
    // Under an `ops:` key, so its history row is tagged an operator notice (db.OPS_KEY_PREFIXES) and
    // never shows as news on Web's Home.
    try { runtime.say(config.ownerConversation, digest.scrub(text), { toMaster: true, idempotencyKey: `ops:check:${report.at ?? Date.now()}:${randomBytes(4).toString("hex")}` }); } catch (e) { log({ ops_alert_failed: short(e) }); }
  }
  log({ ops: report.verdict, checks: report.checks.length, changed: changes.length, texted: !!text, held: later.length });
  return { changes, text, held: later.length };
}

/** The text, or null when there is nothing new to say. Plain lines, worst first, the page's link last. */
export function alertText(changes, report) {
  if (!changes.length) return null;
  const wrong = changes.filter(c => c.kind === "wrong").sort((a, b) => (a.check.state === "bad" ? 0 : 1) - (b.check.state === "bad" ? 0 : 1));
  const fixed = changes.filter(c => c.kind === "fixed");
  const lines = [];
  if (wrong.length) {
    lines.push(`Reason check — ${n(wrong.length, "thing")} ${wrong.length === 1 ? "needs" : "need"} you:`);
    // `alert`: a check that says itself in the owner's words rather than "label: detail".
    for (const w of wrong.slice(0, 6)) lines.push(`• ${w.check.alert ?? `${w.check.label}: ${w.check.detail}`}`);
    if (wrong.length > 6) lines.push(`• and ${wrong.length - 6} more`);
  }
  // `recovered`: a check that says its own all-clear (the pre-reply checks "back on the API").
  const plain = fixed.filter(f => !f.check.recovered);
  for (const f of fixed.filter(f => f.check.recovered)) lines.push(f.check.recovered);
  if (plain.length) lines.push(`${wrong.length || lines.length ? "Back to normal" : "Reason check — back to normal"}: ${plain.map(f => f.check.label).join(", ")}.`);
  // The link opens with the worst thing named here pinned at the top (?focus=).
  lines.push(report.verdict === "ok" ? "Everything is green." : `Status page: ${opsUrl(wrong[0]?.check.id ?? null)}`);
  return lines.join("\n");
}

/** The last report saved, or null before the first pass. */
export function snapshot() {
  const raw = db.opsGet("report");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------- the owner's link ----------

/** The key in the owner's link. Minted once per install and kept in the database, like a page's owner key. */
export function opsKey() {
  let k = db.opsGet("key");
  if (!k) { k = randomBytes(24).toString("base64url"); db.opsSet("key", k); }
  return k;
}

export function keyMatches(k) {
  if (!k) return false;
  const a = Buffer.from(String(k));
  const b = Buffer.from(opsKey());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The owner's link to the page: REASON_OPS_URL (the website's /ops by default) with the key on. */
export function opsUrl(focus = null) {
  const base = config.opsUrl || callbackUrl("/ops");
  return `${base}?k=${opsKey()}${focus ? `&focus=${encodeURIComponent(focus)}` : ""}`;
}

// ---------- running on a clock ----------

/**
 * Check every five minutes, starting shortly after boot, and text on change. Returns the handle;
 * `run` is exposed so a test or a shutdown can force one pass.
 */
let running = false;
// The pass in progress, for the page to show as it goes: when it started and the rows decided so
// far. Null between passes. Whoever started it — the clock or the owner's button — it is the same
// pass, so pressing "Check again" during a scheduled one just watches that one finish.
let inFlight = null;

/** The pass running right now, or null: `{ started_at, checks }`, the rows in the order decided. */
export function progress() {
  return inFlight ? { started_at: inFlight.started_at, checks: [...inFlight.checks] } : null;
}

/**
 * One pass: check, save, text. Shared by the clock and the page's "Check again", so the two can
 * never overlap — a second caller while one is running gets null and the result of the first.
 */
export async function runOnce({ runtime = null, router = null, log = () => {}, silent = new Set(), probe = defaultProbe } = {}) {
  if (running) return null;
  running = true;
  inFlight = { started_at: clock.now(), checks: [] };
  const seen = inFlight;
  try { incidents.sweep(); } catch (e) { log({ incidents_sweep_failed: short(e) }); }
  try {
    const report = await runChecks({ runtime, router, probe, onCheck: (c) => { seen.checks.push(c); } });
    return settle({ report, runtime, log, silent });
  } catch (e) {
    noteError(e);
    log({ ops_failed: short(e) });
    return null;
  } finally {
    running = false;
    inFlight = null;
  }
}

export function startOps({ runtime = null, router = null, everyMs = EVERY_MS, firstAfterMs = 20_000, log = () => {} } = {}) {
  watchFetch();
  subusage.listen();
  startLoopWatch();
  // Alerts raised at the point of failure go to the owner's thread through the outbox, under a key
  // of their own (src/incidents.js), and link to the page with the alert pinned.
  incidents.start({
    send: runtime?._tell ? (text, idempotencyKey) => runtime._tell(config.ownerConversation, text, { idempotencyKey }) : null,
    link: (focus) => opsUrl(focus), log,
  });
  runtime?.on?.("error", (e) => noteError(e));
  // The day's held notices, as one message, once it is past the digest hour (src/opsdigest.js).
  const sendDigest = runtime?.say ? (text, idempotencyKey) => runtime.say(config.ownerConversation, text, { toMaster: true, idempotencyKey }) : null;
  // The spend warnings (src/spend.js, 2026-11-07): the provider's usage-limit refusal, texted the
  // moment it is seen, and the 80% heads-up on each cap, looked at every pass. Live, never the digest:
  // a cap near its limit is one of the owner's emergencies.
  const sendNow = runtime?.say ? (text, idempotencyKey) => runtime.say(config.ownerConversation, digest.scrub(text), { toMaster: true, idempotencyKey }) : null;
  startSpendAlerts({ send: sendNow });
  const run = () => runOnce({ runtime, router, log })
    .finally(() => { try { capWarnings({ send: sendNow, log }); } catch (e) { log({ api_warn_failed: short(e) }); } })
    .finally(() => digest.flush({ send: sendDigest, link: opsUrl(), log }).catch(e => log({ ops_digest_failed: short(e) })));
  const first = setTimeout(run, firstAfterMs);
  const interval = setInterval(run, everyMs);
  first.unref?.();
  interval.unref?.();
  return { run, stop: () => { clearTimeout(first); clearInterval(interval); stopSpendAlerts(); } };
}

// ---------- words ----------

function n(count, one, many = `${one}s`) { return `${count} ${Number(count) === 1 ? one : many}`; }
function money(cents) { return `$${(Number(cents || 0) / 100).toFixed(2)}`; }
function gb(bytes) { return `${(bytes / 1e9).toFixed(bytes < 10e9 ? 1 : 0)} GB`; }
function trim(s, max) { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; }
function short(e) { return (e?.message ?? String(e)).split("\n")[0].slice(0, 200); }

/** "12s", "4m", "3h", "2d" — the unit a person would use. */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function dur(ms) { return ago(ms); }
