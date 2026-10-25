// The check that does not live inside Reason.
//
// Everything in src/ops.js and src/incidents.js runs in the process it is watching, so it can say
// nothing about the process dying, hanging, or the disk filling under it. This runs beside it, once
// a minute, from a systemd timer on the same server (deploy/reason-watchdog.timer), and asks:
//
//   service   is the `reason` unit active?
//   crash     has systemd restarted it on its own since last time (NRestarts went up)?
//   http      does GET /alive answer within 5s? A hung event loop answers nothing.
//   sweep     is the sweep still finishing passes (src/ops.js `alive`)?
//   disk      is there room left on the data disk?
//
// A problem has to be seen on two runs in a row before it texts (one on a restart mid-deploy is
// normal), except a crash and a full disk, which text at once. Then one text, at most one "still"
// an hour, and one "resolved" after three clean runs in a row. A crash loop is one open crash. It texts the owner straight through Sendblue's API, because the one
// time this speaks is the time Reason's own send path may be gone with the process.
//
// Nothing here imports from src/: a broken build must not take its own watchdog with it. State is
// data/watchdog.json, which the status page reads to show this check is itself still running.
//
// Host down is the one thing this cannot see from here. An external dead-man's switch is pinged at
// the end of every healthy run when REASON_WATCHDOG_PING_URL is set (healthchecks.io), so silence
// from this whole server is caught somewhere else.
//
//   node --env-file-if-exists=.env scripts/watchdog.mjs [--dry]
//   REASON_WATCHDOG_DRY=1          print texts, send nothing
//   REASON_WATCHDOG_SEND_URL       Sendblue send endpoint override (the cage points this at a fake)
//   REASON_WATCHDOG_UNIT           unit to check (default reason)
//   REASON_WATCHDOG_ALIVE_URL      /alive address override
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, statfsSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const DRY = process.argv.includes("--dry") || env.REASON_WATCHDOG_DRY === "1";
const DATA = env.REASON_DATA_DIR || join(process.cwd(), "data");
const STATE = join(DATA, "watchdog.json");
const UNIT = env.REASON_WATCHDOG_UNIT || "reason";
const PORT = Number(env.REASON_PORT || 8787);
const ALIVE_URL = env.REASON_WATCHDOG_ALIVE_URL || `http://127.0.0.1:${PORT}/alive`;
const SEND_URL = env.REASON_WATCHDOG_SEND_URL || `${env.SENDBLUE_API_BASE || "https://api.sendblue.com"}/api/send-message`;
const OWNER = (env.REASON_MASTER_NUMBER || env.REASON_OWNER_NUMBER || "").split(",").map(s => s.trim()).filter(Boolean)[0] || "";
const TZ = env.REASON_TZ || "America/New_York";
const REMIND_MS = 60 * 60_000;
const DISK_BAD_SHARE = 0.05;
const DISK_BAD_BYTES = 1e9;
const LAG_BAD_MS = 5000;
/** A crash is open until this long passes without another. */
const CRASH_QUIET_MS = 10 * 60_000;
/** Clean runs in a row before a texted problem is resolved: a flapping disk or a flaky /alive is one alert, not open/resolved every minute. */
const CLEAR_RUNS = 3;

const now = Date.now();
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
const mins = (ms) => { const m = Math.round(ms / 60_000); return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`; };

function load() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { problems: {} }; }
}
function save(s) {
  const tmp = `${STATE}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(s, null, 1)); renameSync(tmp, STATE); } catch (e) { console.error(`watchdog: could not save state: ${e.message}`); }
}

function systemd() {
  // The suite has no systemd: it hands in what `systemctl show` would have said.
  if (env.REASON_WATCHDOG_FAKE_SYSTEMD) return JSON.parse(env.REASON_WATCHDOG_FAKE_SYSTEMD);
  try {
    const out = execFileSync("systemctl", ["show", UNIT, "-p", "ActiveState", "-p", "SubState", "-p", "NRestarts", "-p", "MainPID"], { encoding: "utf8", timeout: 5000 });
    return Object.fromEntries(out.trim().split("\n").map(l => l.split("=")).map(([k, ...v]) => [k, v.join("=")]));
  } catch (e) { return { error: e.message.split("\n")[0] }; }
}

async function aliveRead() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(ALIVE_URL, { signal: ctl.signal });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { body: await r.json() };
  } catch (e) { return { error: e.name === "AbortError" ? "no answer in 5s" : e.message.split("\n")[0] }; }
  finally { clearTimeout(t); }
}

function disk() {
  try {
    const s = statfsSync(DATA);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { free, share: total ? free / total : 1 };
  } catch (e) { return { error: e.message }; }
}

async function sendText(text) {
  if (DRY || !OWNER || !env.SENDBLUE_FROM_NUMBER) {
    console.log(`watchdog${DRY ? " (dry)" : " (no owner number or line set)"} would text:\n${text}`);
    return DRY;
  }
  try {
    const r = await fetch(SEND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": env.SENDBLUE_API_KEY_ID || env.SENDBLUE_API_KEY || "",
        "sb-api-secret-key": env.SENDBLUE_API_SECRET_KEY || env.SENDBLUE_API_SECRET || "",
      },
      body: JSON.stringify({ number: OWNER, from_number: env.SENDBLUE_FROM_NUMBER, content: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error(`watchdog: text failed HTTP ${r.status}`);
    return r.ok;
  } catch (e) { console.error(`watchdog: text failed: ${e.message}`); return false; }
}

async function ping(failing) {
  const url = env.REASON_WATCHDOG_PING_URL;
  if (!url || DRY) return;
  try { await fetch(failing ? `${url.replace(/\/$/, "")}/fail` : url, { signal: AbortSignal.timeout(5000) }); } catch { /* the external check notices the silence */ }
}

async function main() {
  const state = load();
  state.problems ??= {};
  const seen = [];   // { id, what, next, need }

  const sd = systemd();
  const active = sd.ActiveState === "active";
  if (sd.error) seen.push({ id: "service", what: `could not ask systemd about ${UNIT} (${sd.error})`, next: `systemctl status ${UNIT}`, need: 2 });
  else if (!active) seen.push({ id: "service", what: `Reason is not running (${UNIT} is ${sd.ActiveState}/${sd.SubState})`, next: `journalctl -u ${UNIT} -n 50, then systemctl restart ${UNIT}`, need: 2 });

  // A crash stays "open" for CRASH_QUIET_MS after the last one, so a crash loop (Restart=always,
  // every 5s) is one alert counting up, not a text a minute.
  const restarts = Number(sd.NRestarts);
  if (Number.isFinite(restarts) && state.n_restarts != null && restarts > state.n_restarts) {
    state.crashes = (state.last_crash_at && now - state.last_crash_at < CRASH_QUIET_MS ? state.crashes ?? 0 : 0) + (restarts - state.n_restarts);
    state.last_crash_at = now;
  }
  if (Number.isFinite(restarts)) state.n_restarts = restarts;
  if (state.last_crash_at && now - state.last_crash_at < CRASH_QUIET_MS) {
    seen.push({ id: "crash", what: `Reason crashed and systemd restarted it (${state.crashes} time${state.crashes === 1 ? "" : "s"}, last at ${clock(state.last_crash_at)})`, next: `journalctl -u ${UNIT} -n 100 for the stack before the restart`, need: 1 });
  }

  if (active) {
    const a = await aliveRead();
    if (a.error) seen.push({ id: "http", what: `Reason is running but not answering (/alive: ${a.error}) — the event loop may be hung`, next: `journalctl -u ${UNIT} -n 50; if still hung, systemctl restart ${UNIT}`, need: 2 });
    else {
      if (a.body.sweep_stuck) seen.push({ id: "sweep", what: `the sweep has not finished a pass in ${mins(a.body.sweep_age_ms)} — reminders, tasks and held texts are not moving`, next: `journalctl -u ${UNIT} -n 100 for what the last pass is waiting on; restart if it stays stuck`, need: 2 });
      if (a.body.loop_lag_ms > LAG_BAD_MS) seen.push({ id: "lag", what: `Reason's event loop is running ${Math.round(a.body.loop_lag_ms / 1000)}s late`, next: "top / journalctl for a hot loop or a huge sync job", need: 3 });
    }
  }

  const d = disk();
  if (!d.error && (d.share < DISK_BAD_SHARE || d.free < DISK_BAD_BYTES)) {
    seen.push({ id: "disk", what: `the server disk is nearly full (${(d.free / 1e9).toFixed(1)} GB free)`, next: "du -sh /opt/reason/data/* and journalctl --vacuum-size=200M", need: 1 });
  }

  // Bookkeeping: open, count, text, resolve. A problem is marked texted only once the text has
  // really gone; a failed send leaves it owed, and the next run tries again.
  const lines = { open: [], still: [], resolved: [] };
  const marks = [];   // applied only if the text goes
  const ids = new Set(seen.map(s => s.id));
  for (const s of seen) {
    const p = state.problems[s.id] && state.problems[s.id].resolved_at == null ? state.problems[s.id] : { since: now, count: 0 };
    p.count += 1; p.last = now; p.what = s.what; p.next = s.next; p.clear = 0;
    if (p.texted_at == null && p.count >= s.need) { lines.open.push(`• ${s.what}. Check next: ${s.next}`); marks.push(() => { p.texted_at = now; }); }
    else if (p.texted_at != null && now - (p.reminded_at ?? p.texted_at) >= REMIND_MS) { lines.still.push(`• still: ${s.what} — since ${clock(p.since)} (${p.count} checks)`); marks.push(() => { p.reminded_at = now; }); }
    state.problems[s.id] = p;
  }
  for (const [id, p] of Object.entries(state.problems)) {
    if (p.resolved_at != null || ids.has(id)) continue;
    // Never texted: nobody heard about it, so it closes on the first clean run without a word.
    if (p.texted_at == null) { p.resolved_at = now; continue; }
    p.clear = (p.clear ?? 0) + 1;
    if (p.clear < CLEAR_RUNS) continue;
    lines.resolved.push(`• ${p.what.split(" (")[0]} — fine again at ${clock(now)} after ${mins(now - p.since)}`);
    marks.push(() => { p.resolved_at = now; });
  }
  // Closed ones are kept a day for the page, then dropped.
  for (const [id, p] of Object.entries(state.problems)) if (p.resolved_at != null && now - p.resolved_at > 24 * 60 * 60_000) delete state.problems[id];

  const text = [
    lines.open.length || lines.still.length ? "Reason watchdog — needs you:" : null,
    ...lines.open, ...lines.still,
    lines.resolved.length ? `Reason watchdog — resolved:` : null,
    ...lines.resolved,
  ].filter(Boolean).join("\n");
  if (text) {
    const ok = await sendText(text);
    if (ok) for (const m of marks) m();
    state.last_alert = { at: now, what: text.split("\n")[1] ?? text, sent: ok };
  }
  state.at = now;
  state.ok = !seen.length;
  save(state);
  await ping(!state.ok);
  if (process.argv.includes("--print")) console.log(JSON.stringify({ seen: seen.map(s => s.id), texted: !!text }));
}

main().catch((e) => { console.error(`watchdog: ${e.message}`); process.exit(1); });
