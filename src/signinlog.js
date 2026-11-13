// One log line per sign-in attempt, always printed (the service's ordinary log is only on with --log,
// which is why emailed-code runs left nothing behind before 2026-11-12).
//
// What a line holds, and nothing else: the site's host, the route, the outcome class, how long it
// took, and an optional short detail word. Never an email address, a code, a phone number, a
// conversation id or any page text: the fields are built here from a fixed list, so a caller cannot
// put one in by accident.
import { clock } from "./config.js";

export const ROUTES = ["emailed_code", "emailed_link", "provider", "password_link"];
/** The five the owner asked for, plus three for runs that are none of them. */
export const OUTCOMES = ["signed_in", "blocked_by_site", "code_not_found", "wrong_code", "abandoned", "email_rejected", "no_email_route", "failed"];

const kept = [];
let sink = (line) => { if (!process.env.NODE_TEST_CONTEXT) console.log("   ·", line); };
/** For tests and for serve.js: where the line goes. Returns the old one. */
export function setSink(fn) { const old = sink; sink = fn; return old; }
/** The last lines written (as objects), newest last. */
export function recentAttempts() { return kept.slice(); }
export function _resetAttempts() { kept.length = 0; }

const hostOf = (entry) => {
  let h = "";
  try { h = new URL(String(entry?.signin_url ?? entry?.entry ?? "")).hostname.toLowerCase(); } catch { h = ""; }
  return /^[a-z0-9.-]{1,253}$/.test(h) ? h : "unknown";
};

/**
 * Write the line. `startedAt` (ms) is when the attempt began; `detail` is one lowercase word
 * ("google_only", "wall_before_form"), dropped if it is anything else.
 */
export function logAttempt(entry, { route, outcome, startedAt = null, detail = "" } = {}) {
  const now = clock.now();
  const line = {
    signin_attempt: hostOf(entry),
    route: ROUTES.includes(route) ? route : "unknown",
    outcome: OUTCOMES.includes(outcome) ? outcome : "failed",
    ms: Number.isFinite(Number(startedAt)) && startedAt ? Math.max(0, Math.round(now - Number(startedAt))) : null,
    at: new Date(now).toISOString(),
    ...(/^[a-z_]{1,40}$/.test(String(detail)) ? { detail: String(detail) } : {}),
  };
  kept.push(line);
  if (kept.length > 100) kept.shift();
  try { sink(JSON.stringify(line)); } catch { /* a log that cannot be written never breaks a sign-in */ }
  return line;
}

// ---------------------------------------------------------------- one line per step
// The attempt line above is a summary. On 2026-11-12 the owner's hosted session left only two of
// them (no_email_route, then abandoned after ten minutes), so what he had been looking at had to be
// reconstructed. Each step of a sign-in now leaves its own line: the link opened, Start pressed,
// what kind of page the browser was on each time that changed, a submit, the ending.
//
// The same rule as the attempt line: a fixed list of fields built here. A host is a hostname and
// nothing after it: never a path, a query string, an email, a number, a code or a conversation id.
export const STEPS = ["link_opened", "start_pressed", "page_kind", "signin_link_followed", "submitted", "signed_in", "expired", "ended", "form_found", "form_not_found"];
/** What a page can be, as the line says it. "not_signin_page": a home or marketing page, nothing to sign in to. */
export const STEP_KINDS = ["signin_form", "challenge", "provider_prompt", "not_signin_page"];
const stepsKept = [];
export function recentSteps() { return stepsKept.slice(); }
export function _resetSteps() { stepsKept.length = 0; }
const cleanHost = (h) => { const x = String(h ?? "").toLowerCase(); return /^[a-z0-9.-]{1,253}$/.test(x) ? x : ""; };
const pageHost = (url) => { try { return cleanHost(new URL(String(url)).hostname); } catch { return ""; } };

/**
 * Write one step. `startedAt` (ms): when the link was made or the attempt began. `pageUrl`: where the
 * browser is — only its HOST is kept. `session`: a short tag that tells two sessions' lines apart (a
 * hash, never the link). `detail`: one lowercase word, dropped if it is anything else.
 */
export function logStep(entry, { step, kind = "", route = "password_link", startedAt = null, pageUrl = "", session = "", detail = "", waitedMs = null } = {}) {
  const now = clock.now();
  const k = kind === "not_signin" ? "not_signin_page" : kind;
  const seen = pageHost(pageUrl);
  const line = {
    signin_step: hostOf(entry),
    step: STEPS.includes(step) ? step : "unknown",
    ...(STEP_KINDS.includes(k) ? { kind: k } : {}),
    route: ROUTES.includes(route) ? route : "unknown",
    ...(seen ? { page_host: seen } : {}),
    ms: Number.isFinite(Number(startedAt)) && startedAt ? Math.max(0, Math.round(now - Number(startedAt))) : null,
    ...(waitedMs !== null && Number.isFinite(Number(waitedMs)) ? { waited_ms: Math.max(0, Math.round(Number(waitedMs))) } : {}),
    at: new Date(now).toISOString(),
    ...(/^[a-f0-9]{6,12}$/.test(String(session)) ? { s: String(session) } : {}),
    ...(/^[a-z_]{1,40}$/.test(String(detail)) ? { detail: String(detail) } : {}),
  };
  stepsKept.push(line);
  if (stepsKept.length > 300) stepsKept.shift();
  try { sink(JSON.stringify(line)); } catch { /* a log that cannot be written never breaks a sign-in */ }
  return line;
}
