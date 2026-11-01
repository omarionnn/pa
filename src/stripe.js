// Stripe, the small part Reason needs (2026-10-31, the owner's decision at 23:09 ET): one subscription
// per person at $24.99 a month, started from a Checkout Session or a Payment Link, cancelled at the
// period's end by text, and told about by webhook. No SDK — package.json has none, and the four calls
// below are plain form-encoded POSTs with a bearer key. Every network call takes `fetchImpl` so the
// tests run against a stub on this machine and nothing here ever reaches Stripe from a test.
//
// Env (names only; test mode until the owner says otherwise):
//   STRIPE_SECRET_KEY        sk_test_… — the API key
//   STRIPE_WEBHOOK_SECRET    whsec_… — the signing secret of the endpoint registered for POST /stripe/webhook
//   STRIPE_PRICE_ID          price_… — the $24.99/month recurring price
//   STRIPE_PAYMENT_LINK_URL  optional: a hosted pricing page / payment link; when set it IS the pay link
//   STRIPE_API_BASE          optional: where the API lives (the tests point it at a local stub)
import { createHmac, timingSafeEqual } from "node:crypto";

export const env = () => ({
  secretKey: String(process.env.STRIPE_SECRET_KEY ?? "").trim(),
  webhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim(),
  priceId: String(process.env.STRIPE_PRICE_ID ?? "").trim(),
  paymentLink: String(process.env.STRIPE_PAYMENT_LINK_URL ?? "").trim().replace(/\/+$/, ""),
  apiBase: String(process.env.STRIPE_API_BASE ?? "https://api.stripe.com").trim().replace(/\/+$/, ""),
});

/** Is there enough here to make a Checkout Session? (A payment link needs none of it.) */
export const configured = () => { const e = env(); return !!(e.secretKey && e.priceId); };

/** Nested objects → Stripe's bracketed form encoding: { a: { b: 1 }, c: [x] } → a[b]=1&c[0]=x. */
export function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/**
 * One API call. Returns `{ ok, status, body }`; never throws on an HTTP error — the caller says what
 * it means. A missing key is refused here, before any request, so a half-configured install cannot
 * send a request with an empty bearer.
 */
export async function api(method, path, body = null, { fetchImpl = globalThis.fetch, idempotencyKey = null, timeoutMs = 15_000 } = {}) {
  const e = env();
  if (!e.secretKey) return { ok: false, status: 0, body: { error: { message: "no STRIPE_SECRET_KEY on this machine" } } };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${e.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${e.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body ? form(body).toString() : undefined,
      signal: ctl.signal,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, body: { error: { message: (err?.message ?? String(err)).split("\n")[0] } } };
  } finally { clearTimeout(timer); }
}

/** A subscription-mode Checkout Session for one person. `ref` is what comes back as client_reference_id. */
export function createCheckoutSession({ ref, conversationId, successUrl, cancelUrl, fetchImpl }) {
  const e = env();
  return api("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: e.priceId, quantity: 1 }],
    client_reference_id: ref,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { conversation_id: conversationId },
    subscription_data: { metadata: { conversation_id: conversationId } },
  }, { fetchImpl, idempotencyKey: `checkout:${ref}:${Math.floor(Date.now() / 3_600_000)}` });
}

/** Stop renewing at the end of the paid period. Stripe answers with the subscription, `current_period_end` in it. */
export function cancelAtPeriodEnd(subscriptionId, { fetchImpl } = {}) {
  return api("POST", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: true }, { fetchImpl });
}

/** Read one subscription (status, current_period_end, cancel_at_period_end). */
export function getSubscription(subscriptionId, { fetchImpl } = {}) {
  return api("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, null, { fetchImpl });
}

// ---------------------------------------------------------------- the webhook's signature
//
// Stripe signs `${t}.${rawBody}` with the endpoint's secret, HMAC-SHA256, hex, and sends it as
// `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]` (two v1s while a secret is being rolled).
// The raw body, byte for byte — a re-serialised JSON would not match. Five minutes of tolerance, the
// same as Stripe's own libraries. Compared in constant time.

export const TOLERANCE_S = 300;

export function sign(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verifyWebhook({ rawBody, headers = {}, secret = env().webhookSecret, nowMs = Date.now(), toleranceS = TOLERANCE_S }) {
  if (!secret) return { ok: false, why: "no STRIPE_WEBHOOK_SECRET on this machine" };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const header = String(lower["stripe-signature"] ?? "");
  if (!header) return { ok: false, why: "no Stripe-Signature header" };
  let t = "";
  const sigs = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!/^\d+$/.test(t) || !sigs.length) return { ok: false, why: "the signature header has no t or v1 in it" };
  const ageS = Math.abs(Math.floor(nowMs / 1000) - Number(t));
  if (ageS > toleranceS) return { ok: false, why: `the signature is ${Math.round(ageS / 60)} minutes out of date` };
  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody ?? "").toString("utf8");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  for (const s of sigs) {
    const given = Buffer.from(s);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, why: "the signature does not match" };
}
