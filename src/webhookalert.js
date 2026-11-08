// Inbound webhooks being refused, raised as an alert rather than left to one journal line.
//
// 2026-11-08: a secret rotation left Sendblue sending a header that no longer matched, every real
// text was answered 401 and dropped, and the only trace was `{"webhook":"sendblue","status":401,
// "delivered":0}` in the journal. Nothing on /ops and no text, because nothing failed on OUR side —
// the refusal is the auth check working. This counts those refusals per channel and opens one
// incident (src/incidents.js: /ops red, the owner texted once) when they are clearly not noise:
// REJECTS_TO_ALERT refusals in a row, each within WINDOW_MS of the one before, with no accepted
// delivery in between. Two, not more: a quiet line gets few texts, and two straight refusals there
// is already every text lost.
//
// A single stray 401 (somebody probing the URL) stays a journal line. The next accepted delivery
// (a 2xx) closes the alert at once. The reason names WHICH refusal — no header, a header that did
// not match, no secret configured — and never any header or secret value.
import * as incidents from "./incidents.js";
import { clock } from "./config.js";

export const WINDOW_MS = 10 * 60_000;
export const REJECTS_TO_ALERT = 2;

/** channel → { last: ms of the latest refusal, streak: refusals in a row } */
const seen = new Map();
const state = (channel) => {
  if (!seen.has(channel)) seen.set(channel, { last: null, streak: 0 });
  return seen.get(channel);
};

/** The refusal in fixed words; the adapter's own text is never passed on (it could carry anything). */
export function rejectReason(error = "") {
  const e = String(error ?? "");
  if (/did not match/i.test(e)) return "the shared-secret header did not match (the secret on this machine and the one set on the webhook differ)";
  if (/no [A-Z_]*WEBHOOK_SECRET on this machine/i.test(e)) return "no webhook secret is configured on this machine";
  if (/no \S+ header/i.test(e)) return "the shared-secret header was missing (and the provider could not confirm the message)";
  return "the webhook auth check refused it";
}

/** One webhook answer. `status` is what the provider was told; `error` the refusal text, if any. */
export function note({ channel, status, error = "", at = clock.now() }) {
  if (!channel) return null;
  const s = state(channel);
  if (status === 401) {
    // A streak only holds inside the window: two refusals a day apart are not "every text lost".
    s.streak = s.last != null && at - s.last < WINDOW_MS ? s.streak + 1 : 1;
    s.last = at;
    if (s.streak < REJECTS_TO_ALERT) return null;
    try {
      return incidents.raise({
        key: `webhook:${channel}:rejected`, area: "messaging",
        what: `incoming ${channel} webhooks are being refused (401) — texts to Reason are being dropped`,
        error: rejectReason(error), at,
        tried: `${s.streak} refused in a row, none accepted in between`,
        next: `the webhook secret in ${channel}'s dashboard against the one in .env (was a secret just rotated?); journalctl -u reason | grep '"webhook":"${channel}"'`,
      });
    } catch { return null; /* an alert never breaks a webhook */ }
  }
  if (status >= 200 && status < 300) {
    s.last = null;
    s.streak = 0;
    try { incidents.resolve({ prefix: `webhook:${channel}:`, how: `${channel} deliveries are being accepted again`, at }); } catch { /* never blocks */ }
  }
  return null;
}

/** Tests. */
export function reset() { seen.clear(); }
