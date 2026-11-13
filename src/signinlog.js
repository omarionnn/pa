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
