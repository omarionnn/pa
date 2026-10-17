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
import { statfsSync } from "node:fs";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { config, clock, callbackUrl } from "./config.js";

export const EVERY_MS = 5 * 60 * 1000;
/** Past this, the checks themselves are the thing that is wrong: the page says so instead of showing an old green. */
export const STALE_AFTER_MS = 3 * EVERY_MS;
export const PAGE = { id: "ops", title: "Reason status" };
const DAY = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
/** The task states that mean "still owed", from the one list the tasks table is written against. */
const OPEN_TASKS = db.TASK_OPEN.map(s => `'${s}'`).join(",");

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
    probe: () => get(`${config.openaiBase}/v1/models`, { authorization: `Bearer ${config.openaiKey}` }),
  },
  {
    id: "elevenlabs", name: "ElevenLabs", dashboard: "https://elevenlabs.io/app/usage",
    hosts: () => [host(config.elevenBase)],
    configured: () => !!config.elevenKey,
    probe: () => get(`${config.elevenBase}/v1/user`, { "xi-api-key": config.elevenKey }),
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
    return { ok: res.ok, status: res.status };
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
}

// ---------- the checks ----------

const check = (id, group, label, state, detail, link = null) => ({ id, group, label, state, detail, ...(link ? { link } : {}) });
const hardFail = (s) => [401, 402, 403].includes(Number(s));

function failWords({ status, error }) {
  const s = Number(status);
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
export async function runChecks({ runtime = null, router = null, now = clock.now(), probe = defaultProbe } = {}) {
  const day = accounts.today(now);
  const checks = [
    ...aliveChecks({ runtime, router, now }),
    ...peopleChecks({ now, day }),
    ...(await serviceChecks({ now, day, probe })),
    ...(await memoryChecks({ now, probe })),
    ...moneyChecks({ now, day }),
    ...qualityChecks({ now, day }),
  ];
  return { at: now, checks, people: peopleRows({ now, day }), verdict: verdictOf(checks) };
}

function aliveChecks({ runtime, router, now }) {
  const out = [];
  out.push(check("process", "alive", "Process", "ok", `up ${dur(process.uptime() * 1000)} · node ${process.version}`));

  if (!runtime) out.push(check("sweep", "alive", "Sweep", "off", "no runtime"));
  else if (!runtime.interval) out.push(check("sweep", "alive", "Sweep", "bad", "not running — reminders, tasks and watchers are not being checked"));
  else {
    const last = runtime.lastSweepAt ?? null;
    const late = last != null && now - last > 4 * config.sweepEveryMs;
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

  const ob = db.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state = 'sent' AND sent_at >= ? THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN state = 'failed' AND failed_at >= ? THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN state IN ('queued','unknown') AND attempts > 0 THEN 1 ELSE 0 END), 0) AS retrying,
      COALESCE(SUM(CASE WHEN state IN ('queued','unknown') THEN 1 ELSE 0 END), 0) AS waiting
    FROM outbox`).get(now - DAY, now - DAY);
  const lastFail = db.db.prepare("SELECT last_error FROM outbox WHERE state = 'failed' AND failed_at >= ? ORDER BY failed_at DESC LIMIT 1").get(now - DAY);
  out.push(check("outbox", "alive", "Texts out", ob.failed ? "bad" : ob.retrying ? "warn" : "ok",
    ob.failed ? `${n(ob.failed, "text")} failed in the last day${lastFail?.last_error ? ` — ${trim(lastFail.last_error, 90)}` : ""}`
      : ob.retrying ? `${n(ob.retrying, "text")} retrying`
        : `${ob.sent} sent in the last day${ob.waiting ? ` · ${ob.waiting} waiting` : ""}`));

  const held = db.pendingInboundSummary(now);
  const overdue = held.filter(h => h.due && now - h.ready_at > 2 * 60 * 1000);
  out.push(check("holding", "alive", "Held messages", overdue.length ? "bad" : "ok",
    overdue.length ? `${n(overdue.length, "message")} past due and unanswered — the sweep is not picking them up`
      : held.length ? `${held.length} waiting out the quiet window` : "none"));

  const t = db.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN fired_at IS NULL AND cancelled_at IS NULL THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN fired_at IS NULL AND cancelled_at IS NULL AND attempts > 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS retrying,
      COALESCE(SUM(CASE WHEN gave_up_at IS NOT NULL AND gave_up_at >= ? THEN 1 ELSE 0 END), 0) AS missed
    FROM timers`).get(now - 7 * DAY);
  out.push(check("timers", "alive", "Reminders", t.missed ? "bad" : t.retrying ? "warn" : "ok",
    t.missed ? `${n(t.missed, "reminder")} given up on this week` : t.retrying ? `${n(t.retrying, "reminder")} running late` : `${t.pending} pending`));

  const open = db.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN (${OPEN_TASKS})`).get().n;
  const overdueTasks = db.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN (${OPEN_TASKS}) AND next_wake_at IS NOT NULL AND next_wake_at <= ?`).get(now - 10 * 60 * 1000).n;
  out.push(check("tasks", "alive", "Long tasks", overdueTasks ? "warn" : "ok", overdueTasks ? `${n(overdueTasks, "task")} overdue to wake` : `${open} open`));

  const watches = db.db.prepare("SELECT COUNT(*) AS n FROM watches WHERE met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL").get().n;
  out.push(check("watches", "alive", "Watches", "ok", `${watches} live`));

  out.push(serverCheck());

  const recent = errors.filter(x => now - x.at < DAY);
  out.push(check("errors", "alive", "Errors since restart", recent.length ? "warn" : "ok",
    recent.length ? `${n(recent.length, "error")} in the last day — last: ${trim(recent.at(-1).message, 100)}` : "none"));
  return out;
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
  return db.listAccountsOfPeople().map(a => ({
    conversation: a.conversation_id,
    name: a.name || (a.is_operator ? config.ownerName : ""),
    address: a.address,
    // A database from before the column existed has no `state`; it is read as active everywhere
    // else (accounts.accountState), so it is here too.
    state: a.state ?? "active",
    operator: !!a.is_operator,
    last_seen_at: a.last_seen_at ?? null,
    turns_today: turns[a.conversation_id] ?? 0,
    open_tasks: openTasks[a.conversation_id] ?? 0,
    texts_owed: owed[a.conversation_id] ?? 0,
  }));
}

function peopleChecks({ now, day }) {
  const people = peopleRows({ now, day }).filter(p => p.state === "active");
  const seen24 = people.filter(p => p.last_seen_at && now - p.last_seen_at < DAY).length;
  const seen7 = people.filter(p => p.last_seen_at && now - p.last_seen_at < 7 * DAY).length;
  const turns = people.reduce((s, p) => s + p.turns_today, 0);
  const out = [check("people", "people", "People", "ok",
    `${n(people.length, "person", "people")} on the line · ${seen24} texted in the last day · ${seen7} this week · ${n(turns, "turn")} today`)];
  const pending = db.listAccessRequests({ state: "pending" });
  out.push(check("access", "people", "Waiting for a yes", pending.length ? "warn" : "ok",
    pending.length ? `${n(pending.length, "person", "people")} asked for access and ${pending.length === 1 ? "has" : "have"} no answer: ${pending.slice(0, 4).map(r => r.display_name || r.address).join(", ")}`
      : "nobody waiting"));
  return out;
}

async function serviceChecks({ now, day, probe }) {
  const roles = { [config.searchProvider]: "search", [config.callProvider]: "calls" };
  const out = [];
  for (const p of PROVIDERS) {
    const role = roles[p.id] ?? null;
    const label = role ? `${p.name} · ${role}` : p.name;
    const id = `provider:${p.id}`;
    if (!p.configured()) {
      out.push(check(id, "services", label, role ? "bad" : "off", role ? `chosen for ${role} but not set up` : "not set up", p.dashboard));
      continue;
    }
    const calls = db.providerCalls(p.id, day);
    const tail = `${n(calls.calls, "call")} today${calls.failures ? `, ${calls.failures} failed` : ""}`;
    // Only a provider that offers a cheap authenticated read is probed; the rest are judged from
    // the ledger of their own calls, which is also what keeps a test's "everything is fine" probe
    // from pretending a provider was asked.
    const probed = p.probe ? await probe(p) : null;
    let state, detail;
    if (probed) {
      state = probed.ok ? "ok" : hardFail(probed.status) ? "bad" : "warn";
      detail = probed.ok ? `working · ${tail}` : `${failWords(probed)} · ${tail}`;
    } else {
      const last = db.providerState(p.id);
      if (!last || (!last.last_ok_at && !last.last_fail_at)) { state = "ok"; detail = "ready · no calls yet"; }
      else if (last.last_fail_at && (!last.last_ok_at || last.last_fail_at > last.last_ok_at)) {
        state = hardFail(last.last_status) ? "bad" : "warn";
        detail = `last call failed ${ago(now - last.last_fail_at)} ago: ${failWords({ status: last.last_status, error: last.last_error })} · ${tail}`;
      } else { state = "ok"; detail = `working · last call ${ago(now - last.last_ok_at)} ago · ${tail}`; }
    }
    out.push(check(id, "services", label, state, detail, p.dashboard));
  }
  const turns = db.db.prepare("SELECT COALESCE(SUM(turns), 0) AS n FROM usage WHERE day = ?").get(day).n;
  out.push(check("brain", "services", "Brain", "ok",
    config.backend === "claude-cli" ? `Claude CLI on the subscription · ${n(turns, "turn")} today` : `Anthropic API · ${config.model} · ${n(turns, "turn")} today`));
  return out;
}

async function memoryChecks({ now, probe }) {
  const out = [];
  const facts = db.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings").get().n;
  const openai = PROVIDERS.find(p => p.id === "openai");
  if (!config.openaiKey) {
    out.push(check("embeddings", "memory", "Recall (vectors)", "bad",
      `no OPENAI_API_KEY on this install — new facts are not being embedded, so recall falls back to plain matching · ${n(facts, "fact")} embedded so far`, openai.dashboard));
  } else {
    const r = await probe(EMBED_PROBE);
    const ok = !!r?.ok;
    out.push(check("embeddings", "memory", "Recall (vectors)", ok ? "ok" : hardFail(r?.status) ? "bad" : "warn",
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
  return out;
}

function moneyChecks({ now, day }) {
  const out = [];
  const today = db.db.prepare("SELECT COALESCE(SUM(cents), 0) AS c, COUNT(*) AS k FROM spend WHERE day = ?").get(day);
  const month = db.db.prepare("SELECT COALESCE(SUM(cents), 0) AS c FROM spend WHERE day LIKE ?").get(`${day.slice(0, 7)}-%`);
  const capCents = Math.round((config.maxSpendPerDay || 0) * 100);
  const top = db.db.prepare("SELECT COALESCE(MAX(c), 0) AS c FROM (SELECT SUM(cents) AS c FROM spend WHERE day = ? GROUP BY conversation_id)").get(day).c;
  const reached = capCents > 0 && top >= capCents;
  out.push(check("spend", "money", "Approved spend", reached ? "warn" : "ok",
    `${money(today.c)} today across ${n(today.k, "commit")} · ${money(month.c)} this month`
      + (capCents ? ` · daily cap ${money(capCents)} per person${reached ? " — somebody has reached it" : ""}` : " · no daily cap set")));

  const calls = db.db.prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(call_seconds), 0) AS secs FROM usage WHERE day = ?").get(day);
  const cost = db.db.prepare("SELECT COALESCE(SUM(cost_cents), 0) AS c FROM calls WHERE created_at >= ?").get(now - DAY).c;
  out.push(check("calls", "money", "Phone calls", "ok", `${n(calls.calls, "call")} today · ${Math.round(calls.secs / 60)} min${cost ? ` · ${money(cost)} in the last day` : ""}`));

  const buys = db.db.prepare(`SELECT COUNT(*) AS k, COALESCE(SUM(amount_cents), 0) AS c,
      COALESCE(SUM(CASE WHEN decline_code != '' THEN 1 ELSE 0 END), 0) AS declined
    FROM agentcard_purchases WHERE created_at >= ?`).get(now - DAY);
  out.push(check("purchases", "money", "Card purchases", buys.declined ? "warn" : "ok",
    buys.k ? `${n(buys.k, "purchase")} in the last day · ${money(buys.c)}${buys.declined ? ` · ${buys.declined} declined` : ""}` : "none in the last day",
    PROVIDERS.find(p => p.id === "agentcard").dashboard));
  return out;
}

function qualityChecks({ now, day }) {
  const out = [];
  const unknown = db.db.prepare("SELECT COUNT(*) AS n FROM unknown_outcomes WHERE cleared_at IS NULL").get().n;
  out.push(check("unknown", "quality", "Unknown outcomes", unknown ? "bad" : "ok",
    unknown ? `${n(unknown, "action")} whose result is not known — money or a message may or may not have gone` : "none"));

  const misses = db.db.prepare("SELECT capability, COUNT(*) AS n FROM capability_misses WHERE created_at >= ? AND resolved_at IS NULL GROUP BY capability ORDER BY n DESC").all(now - DAY);
  const missed = misses.reduce((s, m) => s + m.n, 0);
  out.push(check("misses", "quality", "Could not do it", missed ? "warn" : "ok",
    missed ? `${n(missed, "time")} in the last day: ${misses.slice(0, 4).map(m => `${m.capability} ×${m.n}`).join(", ")}` : "nothing asked for that Reason could not do"));

  const harm = db.db.prepare("SELECT COUNT(*) AS n FROM harm_events WHERE at >= ?").get(now - DAY).n;
  out.push(check("harm", "quality", "Hard line", "ok", harm ? `${n(harm, "message")} stopped in the last day` : "nothing stopped in the last day"));

  const asked = db.db.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'asked_back' AND created_at >= ?").get(now - DAY).n;
  const turns = db.db.prepare("SELECT COALESCE(SUM(turns), 0) AS n FROM usage WHERE day = ?").get(day).n;
  out.push(check("asked_back", "quality", "Asked instead of acting", "ok", `${n(asked, "time")} in the last day${turns ? ` · ${n(turns, "turn")} today` : ""}`));
  return out;
}

// ---------- saving, and the text ----------

/**
 * Write the report down and text the owner about whatever changed.
 *
 * Each check is compared with its last saved state. Newly wrong (yellow or red) and newly fine
 * again are the two things worth a line; the same state as last time is not. One text per pass,
 * however many lines, and nothing at all when nothing changed.
 */
export function settle({ report, runtime = null, log = () => {} }) {
  const changes = [];
  for (const c of report.checks) {
    const saved = db.saveOpsCheck({ id: c.id, state: c.state, detail: c.detail, at: report.at });
    c.since = saved.since;
    if (saved.previous === c.state) continue;
    if (c.state === "bad" || c.state === "warn") changes.push({ kind: "wrong", check: c });
    else if (c.state === "ok" && (saved.previous === "bad" || saved.previous === "warn")) changes.push({ kind: "fixed", check: c });
  }
  db.opsSet("report", JSON.stringify(report));
  const text = alertText(changes, report);
  if (text && runtime?.say) {
    try { runtime.say(config.ownerConversation, text); } catch (e) { log({ ops_alert_failed: short(e) }); }
  }
  log({ ops: report.verdict, checks: report.checks.length, changed: changes.length, texted: !!text });
  return { changes, text };
}

/** The text, or null when there is nothing new to say. Plain lines, worst first, the page's link last. */
export function alertText(changes, report) {
  if (!changes.length) return null;
  const wrong = changes.filter(c => c.kind === "wrong").sort((a, b) => (a.check.state === "bad" ? 0 : 1) - (b.check.state === "bad" ? 0 : 1));
  const fixed = changes.filter(c => c.kind === "fixed");
  const lines = [];
  if (wrong.length) {
    lines.push(`Reason check — ${n(wrong.length, "thing")} ${wrong.length === 1 ? "needs" : "need"} you:`);
    for (const w of wrong.slice(0, 6)) lines.push(`• ${w.check.label}: ${w.check.detail}`);
    if (wrong.length > 6) lines.push(`• and ${wrong.length - 6} more`);
  }
  if (fixed.length) lines.push(`${wrong.length ? "Back to normal" : "Reason check — back to normal"}: ${fixed.map(f => f.check.label).join(", ")}.`);
  lines.push(report.verdict === "ok" ? "Everything is green." : `Status page: ${opsUrl()}`);
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

export function opsUrl() {
  return callbackUrl(`/ops?k=${opsKey()}`);
}

// ---------- running on a clock ----------

/**
 * Check every five minutes, starting shortly after boot, and text on change. Returns the handle;
 * `run` is exposed so a test or a shutdown can force one pass.
 */
export function startOps({ runtime = null, router = null, everyMs = EVERY_MS, firstAfterMs = 20_000, log = () => {} } = {}) {
  watchFetch();
  runtime?.on?.("error", (e) => noteError(e));
  let running = false;
  const run = async () => {
    if (running) return null;
    running = true;
    try {
      const report = await runChecks({ runtime, router });
      return settle({ report, runtime, log });
    } catch (e) {
      noteError(e);
      log({ ops_failed: short(e) });
      return null;
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, firstAfterMs);
  const interval = setInterval(run, everyMs);
  first.unref?.();
  interval.unref?.();
  return { run, stop: () => { clearTimeout(first); clearInterval(interval); } };
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
