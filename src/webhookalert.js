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
//
// Only a refusal that looks like a real Sendblue delivery counts (`looksReal`): a JSON body in
// Sendblue's shape AND some auth attempt (a secret header or an X-Sendblue-Signature). A scanner's
// `{}` or a non-JSON unsigned POST is refused just the same but never raises the alert.
import * as incidents from "./incidents.js";
import { clock, config } from "./config.js";

export const WINDOW_MS = 10 * 60_000;
export const REJECTS_TO_ALERT = 2;

/** channel → { last: ms of the latest refusal, streak: refusals in a row } */
const seen = new Map();
const state = (channel) => {
  if (!seen.has(channel)) seen.set(channel, { last: null, streak: 0 });
  return seen.get(channel);
};

/**
 * Does this refused request look like Sendblue really sent it? Reads the shape and which headers are
 * present, never their values. Only the Sendblue channel is checked; other channels count as before.
 */
export function looksReal({ channel, headers = {}, rawBody = "" } = {}) {
  if (channel !== "sendblue") return true;
  const h = {};
  for (const k of Object.keys(headers ?? {})) h[k.toLowerCase()] = headers[k];
  const secretHeader = String(config.sendblueWebhookSecretHeader || "sb-signing-secret").toLowerCase();
  const attempted = [secretHeader, "sb-signing-secret", "x-sendblue-signature"].some(k => h[k] != null && String(h[k]) !== "");
  if (!attempted) return false;
  let e;
  try { e = JSON.parse(String(rawBody ?? "")); } catch { return false; }
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const str = (v) => typeof v === "string" && v !== "";
  const party = str(e.from_number) || str(e.number);
  if (str(e.message_handle) && party) return true;                   // receive / outbound
  if (str(e.status) && party) return true;                           // status callback
  if (str(e.event_type)) return true;                                // call_log, inbound_call, …
  if (typeof e.is_typing === "boolean" && party) return true;        // typing_indicator
  return false;
}

/** The refusal in fixed words; the adapter's own text is never passed on (it could carry anything). */
export function rejectReason(error = "") {
  const e = String(error ?? "");
  if (/signature/i.test(e)) return "the signature did not match (the secret on this machine and the one Sendblue signs with differ)";
  if (/did not match/i.test(e)) return "the shared-secret header did not match (the secret on this machine and the one set on the webhook differ)";
  if (/no [A-Z_]*WEBHOOK_SECRET on this machine/i.test(e)) return "no webhook secret is configured on this machine";
  if (/no \S+ header/i.test(e)) return "the shared-secret header was missing (and the provider could not confirm the message)";
  return "the webhook auth check refused it";
}

/**
 * One webhook answer. `status` is what the provider was told; `error` the refusal text, if any;
 * `request` ({ headers, rawBody }) the refused request, checked with `looksReal` — a refusal that
 * does not look like the provider's own delivery is ignored (not counted, streak untouched).
 */
export function note({ channel, status, error = "", request = null, at = clock.now() }) {
  if (!channel) return null;
  const s = state(channel);
  if (status === 401) {
    if (request && !looksReal({ channel, ...request })) return null;
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
