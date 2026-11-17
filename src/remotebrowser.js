// A hosted browser for the sites that turn Reason's own browser away (owner decision 2026-11-15).
//
// Why: DoorDash answers Reason's server browser with a wall when its page loads (2026-11-13, 11-15).
// A plain Browserbase session (a browser run by another company, reached over CDP) loaded DoorDash's
// sign-in form and gave an account-level answer to a made-up email. So for the people the switch
// covers, and only for the sites on the list, the job's browser is a Browserbase session instead of
// the local Chrome. Everything above the browser is the same code: the job, its steps, the
// private-network guard and the origin pin (src/browser.js guardContext), the never-list, the
// approvals, the spend confirmation, the refusal memory (src/refusing.js).
//
// REASON_REMOTE_BROWSER = off | owner | on (default off). REASON_REMOTE_BROWSER_SITES: the list, by
// registrable domain, comma separated (default doordash.com only). Off, or for anyone the switch
// does not cover, or for a site not on the list, nothing in this file runs past remoteFor's first
// line: no request to Browserbase, no table read, no wording.
//
// The rules this file holds, in code:
//   - A PLAIN session, as the service provides it. CAPTCHA solving, proxies, Verified and the old
//     "advanced stealth" are sent OFF explicitly (sessionRequest), because on paid plans some are on
//     by default (docs.browserbase.com/platform/identity/captcha-solving: "Browserbase enables CAPTCHA
//     solving by default for all sessions"). Recording and logging of the session are off too: no
//     replay of a person's pages is kept at Browserbase. No code here or above changes the user
//     agent, the webdriver flag, a fingerprint, a header or the timing to look human.
//   - Nothing shows anybody a picture of the hosted page: no link, no window, no mirror of it.
//   - One attempt, then stop. A puzzle, a CAPTCHA, a "verify you are human" page, a block page or a
//     refused sign-in ends the job there: the session is closed, the site is marked for the hosted
//     browser in the refusal memory at once (not on a second strike), the person is told once, and
//     nothing tries again on its own. A challenge is never solved or clicked through.
//   - Signed-in state lives in a Browserbase Context, one per person per site, kept (persist) so they
//     sign in once. Only the context id is kept here, sealed for its owner like the other personal
//     cells (src/restcrypt.js sealFor). Forgetting the login, removing the saved login or deleting
//     their data deletes the context at Browserbase too (deleteContextsFor).
//   - Every session is closed at job end and on every error path, has a hard cap on its length (here
//     and at Browserbase: `timeout`), and is never left running.
//   - Consent first: before the first use for a person, one plain sentence says this site runs in a
//     hosted browser run by another company and that their signed-in session for it is kept there;
//     it goes ahead on their yes, which is recorded.
//   - Metering: browser seconds per job and per person, a monthly minutes budget
//     (REASON_REMOTE_BROWSER_MONTH_MINUTES, default 60: the free plan's hour) and a per-session cap
//     (REASON_REMOTE_BROWSER_SESSION_MINUTES, default 15: the free plan's longest session). The ops
//     digest shows the minutes used, and a line for each kind of failure.
//   - BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID come from the environment only, and are never
//     logged, returned or written anywhere. The session's connect address carries a signing key: it
//     is used once to connect and never kept.
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { clock } from "./config.js";
import { registrableOf } from "./sitepolicy.js";
import { sealFor, openAny } from "./restcrypt.js";
import * as opsdigest from "./opsdigest.js";
import * as refusing from "./refusing.js";
import * as incidents from "./incidents.js";
import { remoteSites, labelOf, keyOf } from "./hostedsites.js";

// ---------------------------------------------------------------- the switch and the list
/** `off` | `owner` | `on`, read at call time like the other REASON_* switches. */
export function remoteBrowserMode() {
  const v = String(process.env.REASON_REMOTE_BROWSER ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
/** A group thread's conversation ("group:…"), never one person's. */
export const isGroupConversation = (c) => /^group:/i.test(String(c ?? ""));
/** Does the switch cover this person? */
export function remoteAllowedFor(conversationId) {
  if (!conversationId) return false;
  // A group thread: nobody in it can consent, sign in or order on another member's account, so the
  // hosted browser (and every job on it) is never for a group, whatever the switch says.
  if (isGroupConversation(conversationId)) return false;
  const mode = remoteBrowserMode();
  if (mode === "off") return false;
  if (mode === "owner") return accounts.featureOwner(conversationId);
  return true;
}
// The list and its names live in src/hostedsites.js (no database), so the privacy page can name it.
export { DEFAULT_SITES, remoteSites, labelOf } from "./hostedsites.js";
/** The registrable domain of a URL, host or site name, when it is on the list. "" otherwise. */
export function remoteSiteOf(urlOrSite) {
  const k = keyOf(urlOrSite);
  return k && remoteSites().includes(k) ? k : "";
}
/**
 * The site this job's browser is hosted for, or "" (the local browser). The switch is read FIRST and
 * off answers before anything else is looked at: with it off nothing below is reachable.
 */
export function remoteFor(conversationId, urlOrSite) {
  if (remoteBrowserMode() === "off") return "";
  if (!remoteAllowedFor(conversationId)) return "";
  return remoteSiteOf(urlOrSite);
}
/** "remote" | "local": which browser a job for this person on this site runs in. */
export function browserKind(conversationId, site) {
  return remoteFor(conversationId, site) ? "remote" : "local";
}
/** A sign-in entry (src/sites.js shape) marked for the hosted browser when it is one. Off: the same object. */
export function tagEntry(conversationId, entry) {
  if (!entry) return entry;
  const site = remoteFor(conversationId, entry.signin_url || entry.site) || remoteFor(conversationId, entry.site);
  return site ? { ...entry, browser: "remote", remote_site: site } : entry;
}

// ---------------------------------------------------------------- settings
const num = (v, d) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n > 0 ? n : d; };
// The key goes to Browserbase's own API host only. BROWSERBASE_API_URL is the tests' fake, read under
// the test runner only, so no setting can send the key anywhere else.
export const apiBase = () => String((process.env.NODE_TEST_CONTEXT && process.env.BROWSERBASE_API_URL) || "https://api.browserbase.com").replace(/\/+$/, "");
/** The free plan's hour a month, unless the owner sets another budget. */
export const monthBudgetMinutes = () => num(process.env.REASON_REMOTE_BROWSER_MONTH_MINUTES, 60);
/** The free plan's longest session (15 minutes), unless set lower or higher. */
/** Never more than 15 minutes (900 s) a session, whatever is set: the free plan's cap, and the most a job may run. */
export const SESSION_CAP_MAX_MINUTES = 15;
export const sessionCapMinutes = () => Math.min(SESSION_CAP_MAX_MINUTES, num(process.env.REASON_REMOTE_BROWSER_SESSION_MINUTES, 15));
/** A setting above the ceiling is clamped, and said once in the ops digest (one line, kept per day). */
function sayCapClamped() {
  const asked = num(process.env.REASON_REMOTE_BROWSER_SESSION_MINUTES, 15);
  if (asked <= SESSION_CAP_MAX_MINUTES) return;
  try { opsdigest.hold({ key: "remote_browser:session_cap", text: `Hosted browser (Browserbase): REASON_REMOTE_BROWSER_SESSION_MINUTES is ${asked}, above the ${SESSION_CAP_MAX_MINUTES}-minute ceiling, so sessions are capped at ${SESSION_CAP_MAX_MINUTES} minutes.` }); } catch { /* best effort */ }
}
/** How long a session may take to start and connect before it is given up. */
export const startTimeoutMs = () => num(process.env.REASON_REMOTE_BROWSER_START_MS, 30_000);
/** How long to wait before the one retry when Browserbase says too many sessions at once (default 5 s). */
export const busyWaitMs = () => num(process.env.REASON_REMOTE_BROWSER_BUSY_WAIT_MS, 5_000);
/** When a busy refusal's job is tried again (a wake on their thread; default 5 minutes). */
export const busyRetryMs = () => num(process.env.REASON_REMOTE_BROWSER_BUSY_RETRY_MS, 5 * 60_000);
const busyWakes = new Map(); // conversationId -> when the last wake was set
/** "I'll try again in a few minutes" made true: one wake on their thread, at most one per 10 minutes. */
function busyRetry(c, site) {
  const at = clock.now();
  if (at - (busyWakes.get(c) ?? 0) < 10 * 60_000) return;
  busyWakes.set(c, at);
  try { db.createTimer(c, { fireAt: at + busyRetryMs(), note: `[hosted browser] ${labelOf(site)} was too busy on Reason's side a few minutes ago. Try the same ${labelOf(site)} step once more now. If it is busy again, say so in one line and offer the restaurant's own site or pickup; do not set another retry.` }); } catch { /* the words still go */ }
}
const credentials = () => ({ key: String(process.env.BROWSERBASE_API_KEY ?? "").trim(), projectId: String(process.env.BROWSERBASE_PROJECT_ID ?? "").trim() });

/**
 * The exact session request. Pinned by test/remote-browser.test.js: a change here is a change to what
 * a site sees, and needs the owner's word.
 *   browserSettings.context      the person's own Context for this site, persisted (signed in once)
 *   browserSettings.solveCaptchas false: never solve a challenge (the service's default is true)
 *   browserSettings.verified     false: no Verified browser (fingerprints bot vendors recognise)
 *   browserSettings.advancedStealth false: the deprecated stealth mode, off
 *   browserSettings.recordSession false / logSession false: no replay or log of their pages kept there
 *   browserSettings.allowedDomains [site]: Browserbase itself refuses a top-level page off the site
 *   proxies false                no proxy: the service's own plain address
 *   keepAlive false              the session ends when Reason disconnects
 *   timeout                      seconds; the hard cap, enforced at Browserbase as well as here
 * No `os`, no fingerprint, no user agent, no viewport, no extension, no region, no metadata.
 */
export function sessionRequest({ projectId, contextId, site, timeoutSec }) {
  return {
    projectId,
    browserSettings: {
      context: { id: contextId, persist: true },
      solveCaptchas: false,
      verified: false,
      advancedStealth: false,
      recordSession: false,
      logSession: false,
      allowedDomains: [site],
    },
    proxies: false,
    keepAlive: false,
    timeout: timeoutSec,
  };
}

/**
 * The longest a hosted sign-in waits for a code the person texts back, with its session open. The
 * session is NOT released while it waits: the code has to go into the same page step the site opened
 * when it sent the code, and a reconnect to the kept Context brings back cookies and storage, not that
 * step, so whether DoorDash's flow resumes on a fresh page is unproven. So the wait is capped instead,
 * and the ask says so (src/signinemail.js, src/filler.js). Never longer than the code relay's own wait.
 */
export const HOSTED_CODE_WAIT_MS = 5 * 60_000;
export const hostedCodeWait = (ms) => Math.min(Number(ms) > 0 ? Number(ms) : HOSTED_CODE_WAIT_MS, HOSTED_CODE_WAIT_MS);
export const CODE_WAIT_WORDS = "I can wait 5 minutes for it.";

// ---------------------------------------------------------------- failures, in plain words
export const FAILURES = ["key_missing", "key_invalid", "unreachable", "out_of_minutes", "start_timeout", "busy", "consent_needed", "refused", "challenge", "session_ended"];

/** What Reason can do right now when the hosted browser is out on its side (minutes, or too busy). */
export const SIDE_INSTEAD = "I can order it from the restaurant's own site, or set it up for pickup, instead.";
const SIDE_INSTEAD_LOWER = "I can order it from the restaurant's own site, or set it up for pickup, right now.";
/** What the person is told, once, for each way it can fail. Fixed words; no page text. */
export function failureWords(code, site, { alt = "" } = {}) {
  const L = labelOf(site);
  const own = alt || `You can do it in the ${L} app or on ${site} yourself.`;
  switch (code) {
    case "key_missing":
    case "key_invalid":
      return `The hosted browser I use for ${L} isn't set up right now, so I couldn't open ${L}. ${own} I've let the team know.`;
    case "unreachable":
      return `I couldn't reach the hosted browser I use for ${L} just now, so I didn't open ${L}. ${own}`;
    case "out_of_minutes":
      // On Reason's side, never a limit on them; what it can do now; never a plan, never "the app" alone.
      return `I can't use ${L} for you right now. That's on my side, not a limit on you or your account. ${SIDE_INSTEAD}`;
    case "start_timeout":
      return `The hosted browser I use for ${L} didn't start in time, so I stopped without opening ${L}. ${own}`;
    case "busy":
      return `${L} is busy on my side right now, with too many orders going through me at once. That's not a limit on you. I'll try again in a few minutes, or ${SIDE_INSTEAD_LOWER}`;
    case "challenge":
      return `${L} asked me to prove I'm a person, so I stopped there and didn't try to get past it. Nothing was ordered and your account wasn't touched. ${own}`;
    case "refused":
      return `${L} turned my browser away the last time I tried, so I'm not trying again for now. It isn't about your account. ${own}`;
    case "session_ended":
      return `My ${L} session ran out of time and closed, so I stopped there. Nothing was ordered.`;
    default:
      return `I couldn't open ${L} in the hosted browser, so I stopped. ${own}`;
  }
}

/** The ONE consent sentence, said before the first use for a person, and the question after it. */
export function consentWords(site) {
  const L = labelOf(site);
  return `${L} doesn't work in my own browser, so I'd run it in a hosted browser from another company (Browserbase), and your ${L} sign-in would be kept there so you only sign in once.\nOkay to go ahead?`;
}

/** Thrown by openRemote (and so by pageFor / launchProfile); the tool runner answers `answer`. */
export class RemoteBrowserError extends Error {
  constructor(code, site, { alt = "" } = {}) {
    super(`hosted browser: ${code}`);
    this.code = code;
    this.site = site;
    const say = code === "consent_needed" ? consentWords(site) : failureWords(code, site, { alt });
    this.answer = {
      ok: false,
      hosted_browser: code,
      say_exactly: say,
      note: code === "consent_needed"
        ? `Send say_exactly as it is and wait for their answer. Nothing was opened. On a yes, call hosted_browser_ok with site "${site}" and their own words, then do what they asked. On a no, or anything else, do not open ${site}.`
        : `Send say_exactly as it is, once. Nothing was retried and nothing will be: do not open ${site} again in this job, do not try the local browser for it (it walls that too), and do not try another way in.`,
    };
  }
}

// ---------------------------------------------------------------- the tables
db.db.exec(`
  CREATE TABLE IF NOT EXISTS remote_browser_contexts (
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    context_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (conversation_id, site)
  );
  CREATE TABLE IF NOT EXISTS remote_browser_consent (
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    asked_at INTEGER,
    consented_at INTEGER,
    PRIMARY KEY (conversation_id, site)
  );
  CREATE TABLE IF NOT EXISTS remote_browser_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    seconds INTEGER NOT NULL,
    ended TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS remote_browser_month (
    month TEXT PRIMARY KEY,
    seconds INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS remote_browser_orphans (
    context_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
`);
/** For tests. */
export function _resetRemote() {
  db.db.exec("DELETE FROM remote_browser_contexts; DELETE FROM remote_browser_consent; DELETE FROM remote_browser_usage; DELETE FROM remote_browser_month; DELETE FROM remote_browser_orphans");
  lastEnded.clear();
  busyWakes.clear();
  inFlight.clear();
  starting.clear();
  counters.opens = 0; counters.api = 0;
}

// ---------------------------------------------------------------- consent
/** Has this person said yes to the hosted browser for this site? */
export function consented(conversationId, site) {
  return !!db.db.prepare("SELECT consented_at FROM remote_browser_consent WHERE conversation_id = ? AND site = ?").get(String(conversationId), site)?.consented_at;
}
export function consentAskedAt(conversationId, site) {
  return Number(db.db.prepare("SELECT asked_at FROM remote_browser_consent WHERE conversation_id = ? AND site = ?").get(String(conversationId), site)?.asked_at ?? 0) || 0;
}
function noteAsked(conversationId, site, now = clock.now()) {
  db.db.prepare("INSERT INTO remote_browser_consent (conversation_id, site, asked_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id, site) DO UPDATE SET asked_at = excluded.asked_at")
    .run(String(conversationId), site, now);
}
/** A yes counts for this long after the question went out. */
export const CONSENT_ASK_MS = 30 * 60_000;
const NO = /^\s*(no|nope|nah|don'?t|do not|stop|cancel|never|not now|wait|hold on)\b/i;
/** Words that say yes. Their words must hold one: a piece of a no or of a question is not a yes. */
const YES = /(^|[^a-z'])(yes|yeah|yep|yup|yea|ok|okay|sure|go ahead|go for it|do it|fine|sounds good|alright|all right|absolutely|of course|please do|works for me)([^a-z']|$)/i;
/** Anything in the message that takes the yes back or makes it a question. */
const HEDGE = /(^|[^a-z'])(no|not|nope|nah|don'?t|do not|never|wait|hold on|stop|cancel|rather not|but)([^a-z']|$)|\?/i;
const wholeWords = (hay, needle) => new RegExp(`(^|[^a-z0-9'])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9']|$)`, "i").test(hay);
/**
 * Record their yes. Only on a turn they started, only for a question Reason asked in the last 30
 * minutes, and only on words that are in the latest message they wrote, as whole words, saying yes,
 * in a message that does not also say no, but or ask a question (their own yes, never the model's
 * reading of it). `theirWords`: their last messages as they wrote them. → { ok, why? }
 */
export function recordConsent(conversationId, site, said, { ownTurn = false, theirWords = [], now = clock.now() } = {}) {
  const s = remoteFor(conversationId, site);
  if (!s) return { ok: false, why: "the hosted browser isn't on for this site" };
  if (!ownTurn) return { ok: false, why: "this is not a turn they started" };
  const asked = consentAskedAt(conversationId, s);
  if (!asked || now - asked > CONSENT_ASK_MS) return { ok: false, why: "the question was not asked (or was asked too long ago): ask it first" };
  const q = String(said ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return { ok: false, why: "their words are missing" };
  // Their latest message only: a yes written before the question was asked is not a yes to it.
  const latest = String(theirWords.at(-1) ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!latest || !wholeWords(latest, q)) return { ok: false, why: "those words are not in what they wrote" };
  if (NO.test(q) || NO.test(latest) || HEDGE.test(latest) || !YES.test(q)) return { ok: false, why: "that does not read as a plain yes: ask them again in your own words, or leave it" };
  db.db.prepare("INSERT INTO remote_browser_consent (conversation_id, site, asked_at, consented_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, site) DO UPDATE SET consented_at = excluded.consented_at")
    .run(String(conversationId), s, asked, now);
  return { ok: true, site: s };
}

// ---------------------------------------------------------------- the Browserbase API
const counters = { opens: 0, api: 0 };
/** For tests: how many sessions were asked for and how many API calls went out. */
export const _counters = () => ({ ...counters });

async function api(method, pathName, body = undefined, { timeoutMs = 20_000, startCall = false } = {}) {
  const { key } = credentials();
  if (!key) throw new RemoteBrowserError("key_missing", "");
  counters.api += 1;
  let res;
  try {
    res = await fetch(`${apiBase()}${pathName}`, {
      method,
      headers: { "X-BB-API-Key": key, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new RemoteBrowserError(timedOut && startCall ? "start_timeout" : "unreachable", "");
  }
  if (res.status === 401 || res.status === 403) throw new RemoteBrowserError("key_invalid", "");
  if (res.status === 402) throw new RemoteBrowserError("out_of_minutes", "");
  if (res.status === 429) {
    const text = await res.text().catch(() => "");
    throw new RemoteBrowserError(/minute|usage|quota|plan|limit exceeded|billing/i.test(text) && !/concurren/i.test(text) ? "out_of_minutes" : "busy", "");
  }
  if (res.status >= 500) throw new RemoteBrowserError("unreachable", "");
  if (!res.ok) {
    if (res.status === 404 && method === "DELETE") return null; // already gone
    throw new RemoteBrowserError("unreachable", "");
  }
  if (res.status === 204) return null;
  return await res.json().catch(() => null);
}
/** The same error with this job's site, so the wording names it. */
const withSite = (e, site, alt) => (e instanceof RemoteBrowserError ? new RemoteBrowserError(e.code, site, { alt }) : new RemoteBrowserError("unreachable", site, { alt }));

// ---------------------------------------------------------------- contexts (signed-in state)
function contextIdFor(conversationId, site) {
  const row = db.db.prepare("SELECT context_id FROM remote_browser_contexts WHERE conversation_id = ? AND site = ?").get(String(conversationId), site);
  if (!row) return "";
  try { return String(openAny(row.context_id) ?? ""); } catch { return ""; }
}
/** Is a hosted sign-in kept for this person and site? */
export function hasContext(conversationId, site) { return !!contextIdFor(conversationId, site); }
async function ensureContext(conversationId, site, projectId) {
  const had = contextIdFor(conversationId, site);
  if (had) return had;
  const made = await api("POST", "/v1/contexts", { projectId });
  const id = String(made?.id ?? "");
  if (!id) throw new RemoteBrowserError("unreachable", site);
  db.db.prepare("INSERT INTO remote_browser_contexts (conversation_id, site, context_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, site) DO UPDATE SET context_id = excluded.context_id, created_at = excluded.created_at")
    .run(String(conversationId), site, sealFor(String(conversationId), id), clock.now());
  return id;
}
/**
 * Delete this person's kept sign-ins at Browserbase and here: one site, or every site (`site` null).
 * Their yes to the hosted browser for those sites goes too, so a later use asks again. A delete
 * Browserbase does not confirm is never left attached to them: their row goes either way (so no later
 * job of theirs signs in with the session they asked to forget), only the bare id is kept, with no
 * person, to be tried again (retryOrphans), and it is said in the ops digest. Any open hosted session
 * of theirs is closed first.
 *   → { deleted, failed }
 */
export async function deleteContextsFor(conversationId, { site = null } = {}) {
  const c = String(conversationId);
  const key = site ? keyOf(site) : null;
  if (key) db.db.prepare("DELETE FROM remote_browser_consent WHERE conversation_id = ? AND site = ?").run(c, key);
  else db.db.prepare("DELETE FROM remote_browser_consent WHERE conversation_id = ?").run(c);
  const rows = key
    ? db.db.prepare("SELECT site, context_id FROM remote_browser_contexts WHERE conversation_id = ? AND site = ?").all(c, key)
    : db.db.prepare("SELECT site, context_id FROM remote_browser_contexts WHERE conversation_id = ?").all(c);
  if (!rows.length) return { deleted: 0, failed: 0 };
  await closeRemoteFor(c);
  if (db.db.prepare("SELECT 1 FROM remote_browser_orphans LIMIT 1").get()) await retryOrphans().catch(() => 0);
  let deleted = 0; let failed = 0;
  for (const r of rows) {
    let id = "";
    try { id = String(openAny(r.context_id) ?? ""); } catch { id = ""; }
    try {
      if (id) await api("DELETE", `/v1/contexts/${encodeURIComponent(id)}`);
      db.db.prepare("DELETE FROM remote_browser_contexts WHERE conversation_id = ? AND site = ?").run(c, r.site);
      deleted += 1;
    } catch {
      failed += 1;
      opsLine("delete_failed", r.site);
      // The row goes, and only the bare id is kept, with no person, until Browserbase confirms the
      // delete (retryOrphans): a sign-in they asked to forget is never used for them again.
      if (id) db.db.prepare("INSERT OR IGNORE INTO remote_browser_orphans (context_id, at) VALUES (?, ?)").run(id, clock.now());
      db.db.prepare("DELETE FROM remote_browser_contexts WHERE conversation_id = ? AND site = ?").run(c, r.site);
    }
  }
  return { deleted, failed };
}
/**
 * The once-a-day retry of deletes Browserbase did not confirm, hung on the ops pass that sends the
 * daily digest (src/ops.js), with no timer of its own: from the digest hour on, once per day (kept in
 * ops_state), just before the digest goes, so a delete still failing is in that same digest. Nothing
 * waiting: no request.
 */
export async function dailyRetry({ now = clock.now() } = {}) {
  if (opsdigest.localHourOf(now) < opsdigest.DIGEST_HOUR) return 0;
  const day = opsdigest.localDayOf(now);
  if (db.opsGet("remote_browser:retry_day") === day) return 0;
  db.opsSet("remote_browser:retry_day", day);
  const left = db.db.prepare("SELECT COUNT(*) AS n FROM remote_browser_orphans").get().n;
  if (!left) return 0;
  const done = await retryOrphans().catch(() => 0);
  if (done < left) opsLine("delete_failed", "a kept sign-in");
  return done;
}
/** Contexts whose delete failed after their owner's data went: tried again (on the next hosted session). */
export async function retryOrphans() {
  const rows = db.db.prepare("SELECT context_id FROM remote_browser_orphans").all();
  let deleted = 0;
  for (const r of rows) {
    try { await api("DELETE", `/v1/contexts/${encodeURIComponent(r.context_id)}`); db.db.prepare("DELETE FROM remote_browser_orphans WHERE context_id = ?").run(r.context_id); deleted += 1; } catch { /* next time */ }
  }
  return deleted;
}
/** Every person's kept sign-ins (a delete of the whole install). */
export async function deleteEveryContext() {
  const people = db.db.prepare("SELECT DISTINCT conversation_id FROM remote_browser_contexts").all().map(r => r.conversation_id);
  let deleted = 0; let failed = 0;
  for (const c of people) { const r = await deleteContextsFor(c); deleted += r.deleted; failed += r.failed; }
  return { deleted, failed };
}
/** Their consent and metering rows, for a scoped delete (data.js takes the tables by conversation id). */
export const PERSONAL_TABLES = ["remote_browser_contexts", "remote_browser_consent", "remote_browser_usage"];

// ---------------------------------------------------------------- metering
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

// What Browserbase itself says has been used (GET /v1/projects/{id}/usage → browserMinutes), the truth
// for the budget: it counts every session on the project, Reason's or not (2026-11-17: Browserbase 13 of
// 60, Reason's own count 0). Read at most hourly and after each hosted session; the last reading is kept
// in ops_state. A read that fails keeps the last good figure, falls back to Reason's own count, and
// says so in the digest.
const USAGE_KEY = "remote_browser:usage";
/** How old Browserbase's figure may be before it is read again. */
export const USAGE_EVERY_MS = 60 * 60_000;
/** The last reading: { minutes, month, at, tried, error } | null. */
export function lastUsage() {
  try { return JSON.parse(db.opsGet(USAGE_KEY) ?? "null"); } catch { return null; }
}
/** Read Browserbase's figure now if the last read is older than an hour (or `force`). Never throws. */
export async function refreshUsage({ force = false, now = clock.now() } = {}) {
  const { key, projectId } = credentials();
  if (!key || !projectId) return lastUsage();
  const old = lastUsage();
  if (!force && old?.tried && now - old.tried < USAGE_EVERY_MS) return old;
  let next;
  try {
    const got = await api("GET", `/v1/projects/${encodeURIComponent(projectId)}/usage`, undefined, { timeoutMs: 8_000 });
    const m = Number(got?.browserMinutes);
    if (!Number.isFinite(m) || m < 0) throw new Error("no browserMinutes in the answer");
    next = { minutes: m, month: monthOf(now), at: now, tried: now, error: null };
  } catch (e) {
    next = { ...(old ?? { minutes: null, month: null, at: null }), tried: now, error: String(e?.code ?? e?.message ?? "unreadable").slice(0, 60) };
  }
  try { db.opsSet(USAGE_KEY, JSON.stringify(next)); } catch { /* the next read tries again */ }
  digestUsage(now);
  return next;
}
/** Sessions under way: each one's whole cap is held against the month until it settles. */
const inFlight = new Set();
/**
 * Seconds used this month for the budget: Browserbase's own figure (when read this month) plus the
 * sessions Reason ran since that reading and the caps of the ones still running; Reason's own count
 * when there is no good reading. Never less than Reason's own count.
 */
export function usedSeconds(now = clock.now()) {
  const own = monthSeconds(now);
  const u = lastUsage();
  if (!u || u.at == null || u.minutes == null || u.month !== monthOf(now)) return own;
  const monthStart = Date.parse(`${monthOf(now)}-01T00:00:00Z`);
  const since = Number(db.db.prepare("SELECT COALESCE(SUM(seconds), 0) AS s FROM remote_browser_usage WHERE started_at >= ? AND started_at + seconds * 1000 > ?").get(monthStart, u.at)?.s ?? 0);
  const held = [...inFlight].reduce((n, h) => n + (h.seconds || 0), 0);
  return Math.max(own, Math.round(u.minutes * 60) + since + held);
}
/** Whole minutes left this month (never below 0). */
export const minutesLeft = (now = clock.now()) => Math.max(0, Math.floor((monthBudgetMinutes() * 60 - usedSeconds(now)) / 60));
/** Whose figure the budget goes by right now: "browserbase", or "own" with why. */
export function usageSource(now = clock.now()) {
  const u = lastUsage();
  if (u?.at != null && u.minutes != null && u.month === monthOf(now)) return { source: "browserbase", at: u.at, error: u.error ?? null };
  return { source: "own", at: null, error: u?.error ?? (u ? null : "not read yet") };
}
/** The digest's line: used, left, and whose figure it is. Kept per month: the latest replaces the earlier. */
function digestUsage(now = clock.now()) {
  try {
    const used = (usedSeconds(now) / 60).toFixed(1);
    const src = usageSource(now);
    const whose = src.source === "browserbase"
      ? (src.error ? `Browserbase's figure from an earlier read; the latest read failed (${src.error})` : "Browserbase's figure")
      : `Reason's own count: Browserbase's usage could not be read${src.error ? ` (${src.error})` : ""}`;
    opsdigest.hold({ key: `remote_browser:minutes:${monthOf(now)}`, text: `Hosted browser (Browserbase): ${used} of ${monthBudgetMinutes()} minutes used this month, ${minutesLeft(now)} left (${whose}).`, at: now });
  } catch { /* the digest is best effort */ }
}

// ---------------------------------------------------------------- the owner's alert
/** Minutes left at which the owner is told, once a month (REASON_REMOTE_BROWSER_ALERT_MINUTES, default 10). */
export const alertMinutes = () => num(process.env.REASON_REMOTE_BROWSER_ALERT_MINUTES, 10);
const orderMinutesPlanned = () => num(process.env.REASON_DOORDASH_ORDER_MINUTES, 10);
/** The two texts, by what is left. */
export function alertText(left, { budget = monthBudgetMinutes() } = {}) {
  if (left <= 0) return `Browserbase: this month's ${budget} hosted-browser minutes are used up, so DoorDash has stopped for everyone until the plan is upgraded or the month turns over.`;
  const orders = Math.floor(left / orderMinutesPlanned());
  return `Browserbase: ${left} of ${budget} hosted-browser minutes left this month, about ${orders} DoorDash order${orders === 1 ? "" : "s"}. At zero DoorDash stops for everyone until the plan is upgraded.`;
}
/**
 * The owner's text through the ops incidents' owner path (src/incidents.js notice): once a month when
 * the minutes left drop below the threshold, and a second time at zero. Marked only once it went (no
 * owner line yet at startup: tried again on the next pass). → the text sent, or null.
 */
export async function minutesAlert({ now = clock.now(), send = null } = {}) {
  const { key, projectId } = credentials();
  if (!key || !projectId || remoteBrowserMode() === "off") return null;
  const left = minutesLeft(now);
  const month = monthOf(now);
  const zeroKey = `remote_browser:alert:${month}:zero`;
  const lowKey = `remote_browser:alert:${month}:low`;
  let which = null;
  if (left <= 0 && !db.opsGet(zeroKey)) which = "zero";
  else if (left < alertMinutes() && !db.opsGet(lowKey) && !db.opsGet(zeroKey)) which = "low";
  if (!which) return null;
  const text = alertText(left);
  const sent = await Promise.resolve((send ?? incidents.notice)(text, `remote_browser:${month}:${which}`)).catch(() => false);
  if (!sent) return null;
  db.opsSet(which === "zero" ? zeroKey : lowKey, String(now));
  if (which === "zero") db.opsSet(lowKey, db.opsGet(lowKey) || String(now));
  return text;
}
/** The ops page's row: used and left, whose figure, and the alert state. null when not set up. */
export function opsRow(now = clock.now()) {
  const { key, projectId } = credentials();
  if (!key || !projectId) return null;
  const left = minutesLeft(now);
  const src = usageSource(now);
  const month = monthOf(now);
  const told = db.opsGet(`remote_browser:alert:${month}:zero`) ? "zero text sent" : db.opsGet(`remote_browser:alert:${month}:low`) ? "low-minutes text sent" : "";
  const detail = [`${(usedSeconds(now) / 60).toFixed(1)} of ${monthBudgetMinutes()} min used`, `${left} min left`,
    src.source === "browserbase" ? `Browserbase's figure${src.error ? " (latest read failed)" : ""}` : "Reason's own count (Browserbase's usage unreadable)", told].filter(Boolean).join(" · ");
  return { state: left <= 0 ? "bad" : left < alertMinutes() ? "warn" : "ok", detail };
}
export function monthSeconds(now = clock.now()) {
  return Number(db.db.prepare("SELECT seconds FROM remote_browser_month WHERE month = ?").get(monthOf(now))?.seconds ?? 0);
}
export function personSeconds(conversationId, now = clock.now()) {
  const start = Date.parse(`${monthOf(now)}-01T00:00:00Z`);
  return Number(db.db.prepare("SELECT COALESCE(SUM(seconds), 0) AS s FROM remote_browser_usage WHERE conversation_id = ? AND started_at >= ?").get(String(conversationId), start)?.s ?? 0);
}
export function jobsFor(conversationId) {
  return db.db.prepare("SELECT site, started_at, seconds, ended FROM remote_browser_usage WHERE conversation_id = ? ORDER BY id").all(String(conversationId));
}
let sink = (line) => { if (!process.env.NODE_TEST_CONTEXT) console.log("   ·", line); };
/** For tests: where the one log line per session goes. Returns the old one. */
export function setRemoteSink(fn) { const old = sink; sink = fn; return old; }
/**
 * A session's whole cap is charged to the month BEFORE it is asked for (in the same tick as the budget
 * check, so two jobs at once cannot both spend the last minutes), and settled to what it really used
 * when it ends. A process killed mid-session never settles: its whole cap stays charged.
 */
function charge(month, seconds) {
  db.db.prepare("INSERT INTO remote_browser_month (month, seconds) VALUES (?, MAX(0, ?)) ON CONFLICT(month) DO UPDATE SET seconds = MAX(0, seconds + excluded.seconds)")
    .run(month, seconds);
}
function chargeDelta(month, delta) {
  if (!delta) return;
  db.db.prepare("INSERT INTO remote_browser_month (month, seconds) VALUES (?, 0) ON CONFLICT(month) DO NOTHING").run(month);
  db.db.prepare("UPDATE remote_browser_month SET seconds = MAX(0, seconds + ?) WHERE month = ?").run(delta, month);
}
function meter(conversationId, site, startedAt, endedAt, ended, held = null) {
  const seconds = Math.max(0, Math.ceil((endedAt - startedAt) / 1000));
  db.db.prepare("INSERT INTO remote_browser_usage (conversation_id, site, started_at, seconds, ended) VALUES (?, ?, ?, ?, ?)").run(String(conversationId), site, startedAt, seconds, ended);
  if (held) { chargeDelta(held.month, -held.seconds); held.seconds = 0; inFlight.delete(held); }
  chargeDelta(monthOf(startedAt), seconds);
  // One line, numbers and the site only: never a person, a page or an address.
  try { sink(`hosted-browser session site=${site} seconds=${seconds} ended=${ended} month_minutes=${(usedSeconds(endedAt) / 60).toFixed(1)}/${monthBudgetMinutes()}`); } catch { /* a log line never breaks a job */ }
  digestUsage(endedAt);
  // Browserbase's figure again after each session, then the owner's alert if the month is running low.
  if (!process.env.NODE_TEST_CONTEXT || process.env.REASON_REMOTE_BROWSER_TEST_USAGE === "1") {
    refreshUsage({ force: true }).then(() => minutesAlert()).catch(() => {});
  }
  return seconds;
}
const OPS_WORDS = {
  key_missing: "the API key or project id is missing from the environment",
  key_invalid: "Browserbase refused the API key",
  unreachable: "Browserbase could not be reached",
  out_of_minutes: "out of browser minutes for the month",
  start_timeout: "a session did not start in time",
  busy: "too many sessions at once (the plan's concurrency)",
  challenge: "the site showed a challenge; the job stopped and the site is paused for the hosted browser",
  delete_failed: "a kept sign-in (Context) could not be deleted at Browserbase; it is no longer used for anyone and is tried again on the next hosted session or delete",
};
function opsLine(code, site) {
  if (!OPS_WORDS[code]) return;
  try { opsdigest.hold({ key: `remote_browser:${code}:${site}`, text: `Hosted browser (Browserbase) for ${site}: ${OPS_WORDS[code]}.` }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- sessions
const open = new Map(); // conversationId -> { context, browser, sessionId, site, startedAt, finish }
const remoteContexts = new WeakMap(); // context -> { site, conversationId }
const lastEnded = new Map(); // conversationId -> { site, why, at }
const starting = new Map(); // sessionId -> release: asked for at Browserbase, not yet connected and in `open`
export function isRemoteContext(context) { return !!context && remoteContexts.has(context); }
export function remoteSiteOfContext(context) { return remoteContexts.get(context)?.site ?? ""; }
export function remoteSessionsOpen() { return open.size; }
/** Close this person's hosted session, if one is open. Never throws. */
export async function closeRemoteFor(conversationId) {
  const s = open.get(String(conversationId));
  if (s) await s.finish("closed");
}
export async function closeAllRemote() {
  // A session still connecting (between Browserbase's answer and the CDP connect) is released too.
  const connecting = [...starting.values()];
  starting.clear();
  await Promise.all([...connecting.map((release) => release()), ...[...open.keys()].map(closeRemoteFor)]);
}
/** A hosted session that ended by itself (its cap) while a job was on it: said once, then forgotten. */
export function takeEnded(conversationId, now = clock.now()) {
  const e = lastEnded.get(String(conversationId));
  lastEnded.delete(String(conversationId));
  return e && now - e.at < 10 * 60_000 ? e : null;
}

/**
 * What stops a hosted job before anything is opened: no key, a site that turned the hosted browser
 * away (not tried again until its mark is old), no consent yet (the question is noted as asked), or
 * the month's minutes used up. → a FAILURES code, or null to go ahead. Makes no request.
 */
function gateCode(c, s) {
  const { key, projectId } = credentials();
  if (!key || !projectId) return "key_missing";
  if (refusing.refusingSite(s, undefined, { browser: "remote" })) return "refused";
  if (!consented(c, s)) { noteAsked(c, s); return "consent_needed"; }
  if (monthBudgetMinutes() * 60 - usedSeconds() < 60) return "out_of_minutes";
  return null;
}
/**
 * For a tool that is about to start a hosted job in the background (the emailed-code sign-in, the
 * saved-login filler): the answer to give now instead, or null. Off, or a site not covered: null.
 */
export function gate(conversationId, site, { alt = "" } = {}) {
  const s = remoteFor(conversationId, site);
  if (!s) return null;
  const code = gateCode(String(conversationId), s);
  if (!code) return null;
  if (OPS_WORDS[code]) opsLine(code, s);
  return { ...new RemoteBrowserError(code, s, { alt }).answer };
}

/**
 * Open a hosted session for this person and site and hand back its browser context, with `close`
 * releasing the session at Browserbase. `launcher` is Playwright's chromium (connectOverCDP).
 * Throws RemoteBrowserError, with the session already released, on every failure.
 */
export async function openRemote(launcher, conversationId, site, { alt = "" } = {}) {
  const c = String(conversationId);
  const s = remoteFor(c, site);
  if (!s) throw new Error("openRemote called for a site the switch does not cover"); // never: the caller checked
  const fail = (code) => { const e = new RemoteBrowserError(code, s, { alt }); if (OPS_WORDS[code]) opsLine(code, s); return e; };
  const { projectId } = credentials();
  // Consent, the key and a refusal first (no request to Browserbase for any of those), then its own
  // usage figure (at most hourly) and the minutes again on that.
  { const code = gateCode(c, s); if (code) throw fail(code); }
  await refreshUsage().catch(() => null);
  { const code = gateCode(c, s); if (code) throw fail(code); }
  const left = monthBudgetMinutes() * 60 - usedSeconds();
  sayCapClamped();
  const timeoutSec = Math.max(60, Math.min(sessionCapMinutes() * 60, left));
  // The cap is held against the month now, before any await: see charge().
  const held = { month: monthOf(clock.now()), seconds: timeoutSec };
  charge(held.month, timeoutSec);
  inFlight.add(held);
  const refund = () => { if (held.seconds) { chargeDelta(held.month, -held.seconds); held.seconds = 0; } inFlight.delete(held); };
  // One hosted session per person at a time: a Context is used by one session at once.
  await closeRemoteFor(c);
  if (db.db.prepare("SELECT 1 FROM remote_browser_orphans LIMIT 1").get()) await retryOrphans().catch(() => 0);
  counters.opens += 1;
  let contextId;
  try { contextId = await ensureContext(c, s, projectId); } catch (e) { refund(); const err = withSite(e, s, alt); if (OPS_WORDS[err.code]) opsLine(err.code, s); throw err; }
  let made;
  try {
    const ask = () => api("POST", "/v1/sessions", sessionRequest({ projectId, contextId, site: s, timeoutSec }), { timeoutMs: startTimeoutMs(), startCall: true });
    try { made = await ask(); } catch (e) {
      // Too many sessions at once: wait a moment and ask once more; a second refusal is said, and a
      // wake is set to try again in a few minutes (busyRetry).
      if (!(e instanceof RemoteBrowserError) || e.code !== "busy") throw e;
      await new Promise((r) => { const t = setTimeout(r, busyWaitMs()); t.unref?.(); });
      try { made = await ask(); } catch (e2) { if (e2 instanceof RemoteBrowserError && e2.code === "busy") busyRetry(c, s); throw e2; }
    }
  } catch (e) {
    const err = withSite(e, s, alt);
    // A create that timed out on our side may still have made a session there, running to its cap
    // unseen: its cap stays charged. Any other refusal made nothing.
    if (err.code !== "start_timeout") refund();
    if (OPS_WORDS[err.code]) opsLine(err.code, s);
    throw err;
  }
  const sessionId = String(made?.id ?? "");
  const connectUrl = String(made?.connectUrl ?? "");
  const startedAt = clock.now();
  const release = async () => {
    if (!sessionId) return;
    try { await api("POST", `/v1/sessions/${encodeURIComponent(sessionId)}`, { projectId, status: "REQUEST_RELEASE" }); } catch { /* the session's own timeout ends it */ }
  };
  if (!sessionId || !connectUrl) { await release(); refund(); throw fail("unreachable"); }
  starting.set(sessionId, release);
  let browser;
  let timer;
  try {
    const cap = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error("connect timeout"), { name: "TimeoutError" })), startTimeoutMs()); timer.unref?.(); });
    browser = await Promise.race([launcher.connectOverCDP(connectUrl, { timeout: startTimeoutMs() }), cap]);
  } catch (e) {
    clearTimeout(timer);
    starting.delete(sessionId);
    await release();
    meter(c, s, startedAt, clock.now(), "start_failed", held);
    throw fail(/timeout/i.test(String(e?.name ?? "") + String(e?.message ?? "")) ? "start_timeout" : "unreachable");
  }
  clearTimeout(timer);
  const context = browser.contexts?.()[0];
  if (!context || !starting.has(sessionId)) {
    // No page to drive, or released while it connected (the process is shutting down).
    starting.delete(sessionId);
    await browser.close().catch(() => {});
    await release();
    meter(c, s, startedAt, clock.now(), "start_failed", held);
    throw fail("unreachable");
  }
  starting.delete(sessionId);
  let done = null;
  let capTimer = null;
  const nativeClose = context.close.bind(context);
  const finish = (why) => {
    if (done) return done;
    done = (async () => {
      clearTimeout(capTimer);
      if (open.get(c)?.context === context) open.delete(c);
      if (why === "cap" || why === "disconnected") lastEnded.set(c, { site: s, why, at: clock.now() });
      await nativeClose().catch(() => {});
      await browser.close().catch(() => {});
      await release();
      db.db.prepare("UPDATE remote_browser_contexts SET used_at = ? WHERE conversation_id = ? AND site = ?").run(clock.now(), c, s);
      meter(c, s, startedAt, clock.now(), why, held);
    })();
    return done;
  };
  // The hard cap, here as well as at Browserbase (`timeout`): never a session left running.
  // Tests only: a shorter cap, so the cap's ending can be proved without waiting a minute.
  const testCap = process.env.NODE_TEST_CONTEXT ? Number(process.env.REASON_REMOTE_BROWSER_TEST_CAP_MS) : NaN;
  capTimer = setTimeout(() => { finish("cap").catch(() => {}); }, Number.isFinite(testCap) && testCap > 0 ? testCap : timeoutSec * 1000);
  capTimer.unref?.();
  browser.on?.("disconnected", () => { finish("disconnected").catch(() => {}); });
  // Every caller closes a context with context.close(): for a hosted one that also releases the session.
  context.close = () => finish("closed");
  remoteContexts.set(context, { site: s, conversationId: c });
  open.set(c, { context, browser, sessionId, site: s, startedAt, finish });
  return context;
}

// ---------------------------------------------------------------- one attempt, then stop
const BLOCK_PAGE = /access denied|you (?:have been|are|were) blocked|request (?:was )?blocked|sorry, you have been blocked|pardon our interruption|unusual traffic from your|automated (?:access|queries|requests)|bot (?:detected|protection)|please verify you are a human|checking (?:if the site connection is secure|your browser)|just a moment\.\.\./i;
const CHALLENGE_FRAME = /recaptcha|hcaptcha|arkose|funcaptcha|challenges\.cloudflare\.com|turnstile|captcha-delivery|px-captcha|perimeterx/i;
/**
 * Is the page a challenge or a block page? Read only: nothing is clicked, typed or solved.
 * `status`: the main navigation's HTTP status when the caller has it. → "" | "challenge" | "wall"
 */
export async function challengeOn(page, { status = null } = {}) {
  if (Number(status) === 403 || Number(status) === 429) return "wall";
  let kind = "";
  try { const sp = await import("./signinpage.js"); kind = (await sp.readPage(page)).kind; } catch { kind = ""; }
  if (kind === "challenge") return "challenge";
  // A page with a usable sign-in form, a signed-in page or a provider's own prompt is not a challenge,
  // whatever it embeds: sites put an invisible reCAPTCHA or Arkose sensor on a normal sign-in form
  // (DoorDash's, live 2026-11-15), and that frame is them watching, not a puzzle for the person.
  if (kind === "signin_form" || kind === "signed_in" || kind === "provider_prompt") return "";
  let text = "";
  try { text = String(await page.evaluate(() => (document.body ? document.body.innerText : "")) ?? ""); } catch { text = ""; }
  if (text.trim().length <= 1500 && BLOCK_PAGE.test(text)) return "wall";
  // A challenge drawn in its own VISIBLE frame of a real size, on a page with little else on it.
  if (text.trim().length <= 1500) {
    try {
      const shown = await page.evaluate((src) => {
        const re = new RegExp(src, "i");
        return [...document.querySelectorAll("iframe")].some((f) => {
          if (!re.test(String(f.src || ""))) return false;
          const r = f.getBoundingClientRect(); const st = getComputedStyle(f);
          return r.width >= 200 && r.height >= 150 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
        });
      }, CHALLENGE_FRAME.source);
      if (shown) return "challenge";
    } catch { /* gone */ }
  }
  return "";
}
/**
 * The stop: the site is marked for the hosted browser at once, the session is closed, the owner gets
 * a digest line, and the answer is the one plain line for the person. → the answer
 */
export async function stopForChallenge(conversationId, site, kind = "challenge", { alt = "" } = {}) {
  const s = keyOf(site);
  try { refusing.markRefusing(s, kind === "wall" ? "wall" : "challenge", undefined, { browser: "remote" }); } catch { /* the stop still happens */ }
  opsLine("challenge", s);
  await closeRemoteFor(conversationId);
  return { ...new RemoteBrowserError("challenge", s, { alt }).answer, stopped: kind };
}
/** If this context is hosted and its page is a challenge or a block page, stop the job. → answer | null */
export async function stopIfChallenged(conversationId, page, { status = null, alt = "" } = {}) {
  let ctx;
  try { ctx = page.context(); } catch { return null; }
  if (!isRemoteContext(ctx)) return null;
  const kind = await challengeOn(page, { status });
  if (!kind) return null;
  return stopForChallenge(conversationId, remoteSiteOfContext(ctx), kind, { alt });
}

/** The capability line a covered person's model is given; empty for everyone else. */
export function capabilityWords(conversationId) {
  if (!remoteAllowedFor(conversationId)) return "";
  const list = remoteSites().map(labelOf).join(", ");
  return `${list} run in a hosted browser from another company (Browserbase) instead of Reason's own, because ${list} turns Reason's own browser away.`
    + " The first time, Reason says that in one plain sentence (the tool answer gives it) and goes ahead on their yes."
    + " Their sign-in for that site is kept there so they sign in once; forgetting the login deletes it there too."
    + " Sign-in is only by the site's own code (texted or emailed) or their saved login; there is no sign-in link for these sites."
    + " If the site shows any check that they are a person, a puzzle or a block page, Reason stops there, says so once, and never tries again on its own."
    + ` The hosted browser has ${monthBudgetMinutes()} minutes a month and ${sessionCapMinutes()} minutes a session.`;
}
