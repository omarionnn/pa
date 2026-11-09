// Duffel's booking API, the small part Reason needs (docs read 2026-11-09). No SDK: plain JSON over
// fetch, and every call takes `fetchImpl` so tests never leave this machine.
//
// Search stays in src/flightproviders.js. Everything here is about orders, and two rules from
// duffel.com/docs/api/overview/response-handling/order-and-booking-creation decide the shape:
//   - Airlines can take 120 s. A create needs a client timeout of at least 130 s.
//   - Duffel has no idempotency key on POST /air/orders. Only a 503 or a 4xx says no booking exists;
//     a timeout, a 500, a 502, a 504, a 200 or a 202 can all hide a real one. Those are never retried.
//
// Env: DUFFEL_ACCESS_TOKEN (shared with search), DUFFEL_WEBHOOK_SECRET, DUFFEL_API_BASE (tests).
// A live token searches as before but can only write when REASON_FLIGHT_DUFFEL_LIVE=1, so turning
// this feature on with the search token can never make a real booking by accident.
import { createHmac, timingSafeEqual } from "node:crypto";

export const env = () => ({
  token: String(process.env.DUFFEL_ACCESS_TOKEN ?? "").trim(),
  webhookSecret: String(process.env.DUFFEL_WEBHOOK_SECRET ?? "").trim(),
  apiBase: String(process.env.DUFFEL_API_BASE ?? "https://api.duffel.com").trim().replace(/\/+$/, ""),
  liveAllowed: ["1", "true", "on", "yes"].includes(String(process.env.REASON_FLIGHT_DUFFEL_LIVE ?? "").trim().toLowerCase()),
});

export const isTestToken = (token = env().token) => token.startsWith("duffel_test_");
export const canBook = () => { const e = env(); return !!e.token && (isTestToken(e.token) || e.liveAllowed); };

/** The answer as data, never a throw: `status: 0` means no answer came back at all. */
export async function api(method, path, body = null, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const e = env();
  if (method !== "GET" && !canBook()) return { status: 0, json: null, error: "writes_not_allowed" };
  try {
    const res = await fetchImpl(`${e.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${e.token}`, Accept: "application/json", "Duffel-Version": "v2",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

export const firstError = (res) => { const e = res?.json?.errors?.[0]; return { code: e?.code ?? "", title: e?.title ?? "", message: e?.message ?? "" }; };

/**
 * What a create-or-confirm answer proves about the money and the seat.
 *   done      Duffel returned the created resource.
 *   rejected  Definitely did not happen (a 4xx other than 408, or a 503).
 *   unknown   Anything else. It may have happened, and it is never sent again.
 */
export function outcomeOf(res) {
  if (res.error === "writes_not_allowed") return { outcome: "rejected", code: "writes_not_allowed" };
  const s = res.status;
  if ((s === 200 || s === 201) && res.json?.data?.id) return { outcome: "done", data: res.json.data };
  if (s === 503 || (s >= 400 && s < 500 && s !== 408)) return { outcome: "rejected", code: firstError(res).code || `http_${s}`, title: firstError(res).title };
  return { outcome: "unknown", why: s ? `http_${s}` : (res.error || "no_answer") };
}

const q = encodeURIComponent;
const LONG = { timeoutMs: 130_000 };

export const searchOffers = (data, opts = {}) => api("POST", `/air/offer_requests?return_offers=true&supplier_timeout=20000`, { data }, { timeoutMs: 45_000, ...opts });
export const getOffer = (id, opts = {}) => api("GET", `/air/offers/${q(id)}?return_available_services=false`, null, opts);
export const createOrder = (data, opts = {}) => api("POST", "/air/orders", { data }, { ...LONG, ...opts });
export const getOrder = (id, opts = {}) => api("GET", `/air/orders/${q(id)}`, null, opts);
export const listOrdersByPassenger = (names, opts = {}) => api("GET", `/air/orders?limit=200&${names.map(n => `passenger_name[]=${q(n)}`).join("&")}`, null, opts);

export const createCancellation = (orderId, opts = {}) => api("POST", "/air/order_cancellations", { data: { order_id: orderId } }, { ...LONG, ...opts });
export const confirmCancellation = (id, opts = {}) => api("POST", `/air/order_cancellations/${q(id)}/actions/confirm`, null, { ...LONG, ...opts });
export const getCancellation = (id, opts = {}) => api("GET", `/air/order_cancellations/${q(id)}`, null, opts);

export const createChangeRequest = (data, opts = {}) => api("POST", "/air/order_change_requests", { data }, { ...LONG, ...opts });
export const getChangeOffer = (id, opts = {}) => api("GET", `/air/order_change_offers/${q(id)}`, null, opts);
export const createChange = (offerId, opts = {}) => api("POST", "/air/order_changes", { data: { selected_order_change_offer: offerId } }, { ...LONG, ...opts });
export const confirmChange = (id, payment, opts = {}) => api("POST", `/air/order_changes/${q(id)}/actions/confirm`, { data: { payment } }, { ...LONG, ...opts });
export const getChange = (id, opts = {}) => api("GET", `/air/order_changes/${q(id)}`, null, opts);

export const acceptAirlineChange = (id, opts = {}) => api("POST", `/air/airline_initiated_changes/${q(id)}/actions/accept`, null, { ...LONG, ...opts });

/**
 * X-Duffel-Signature is `t=<unix>,v1=<hex>`, an HMAC-SHA256 of `<t>.<raw body>` (guide: receiving
 * webhooks). No age limit: Duffel retries for 72 hours, and replays are stopped by the event id.
 */
export function verifyWebhook({ rawBody, headers = {}, secret = env().webhookSecret }) {
  if (!secret) return { ok: false, why: "no_secret" };
  const raw = String(headers["x-duffel-signature"] ?? "");
  const parts = Object.fromEntries(raw.split(",").map(p => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  if (!parts.t || !parts.v1) return { ok: false, why: "no_signature" };
  const want = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
  let got;
  try { got = Buffer.from(parts.v1, "hex"); } catch { return { ok: false, why: "bad_signature" }; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, why: "bad_signature" };
  return { ok: true };
}

export const sign = (rawBody, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
