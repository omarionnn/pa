// Agentic payments, test mode only: Reason asks once for a card, Stripe holds the number, and every
// later charge goes against the saved payment method rather than anything typed into a chat. The
// confirm gate and the person's own spending caps (src/trust.js) are what keep a charge from
// happening on its own — this file only talks to Stripe and to the two tables that remember what it
// was given and what it did with it.
import Stripe from "stripe";
import * as db from "./db.js";
import { config } from "./config.js";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/** Whether this install has a Stripe secret key at all. Nothing below here works without one. */
export function isConfigured() {
  return !!stripe;
}

function requireStripe() {
  if (!stripe) throw new Error("Stripe is not configured on this install (STRIPE_SECRET_KEY is not set).");
  return stripe;
}

/**
 * A Stripe-hosted page where the person adds a card. Reason never sees the card number — Stripe
 * Checkout collects it and hands back only a customer id and a payment method id, which is what
 * gets saved. A real Stripe customer is created up front (rather than left to Checkout) so the
 * session always has somewhere to attach the card, in setup mode or out of it.
 */
export async function createSetupSession(conversationId, ownerName) {
  const s = requireStripe();
  if (!config.publicUrl) {
    return {
      ok: false,
      error: `REASON_PUBLIC_URL is not set, so there is nowhere for Stripe to send them back to after adding a card. Say that it needs setting up on this install.`,
    };
  }
  const customer = await s.customers.create({
    name: ownerName || undefined,
    metadata: { conversationId },
  });
  const session = await s.checkout.sessions.create({
    mode: "setup",
    currency: "usd",
    customer: customer.id,
    client_reference_id: conversationId,
    success_url: `${config.publicUrl}/stripe/callback?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.publicUrl}/stripe/cancel`,
  });
  return { ok: true, url: session.url };
}

/**
 * Called from the /stripe/callback route once the person is back from Stripe's page. Reads the
 * finished Checkout session, pulls the card Stripe actually saved off the SetupIntent, and writes
 * the customer id and payment method id into stripe_customers — the only two ids anything else here
 * ever touches.
 */
export async function completeSetup(sessionId) {
  const s = requireStripe();
  const session = await s.checkout.sessions.retrieve(sessionId, {
    expand: ["setup_intent.payment_method"],
  });
  if (session.status !== "complete") {
    return { ok: false, error: `This checkout session is '${session.status}', not complete.` };
  }
  const conversationId = session.client_reference_id;
  if (!conversationId) return { ok: false, error: "This checkout session has no conversation attached to it." };
  const paymentMethod = session.setup_intent?.payment_method;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!paymentMethod || !customerId) {
    return { ok: false, error: "Stripe did not come back with a saved card for this session." };
  }
  const paymentMethodId = typeof paymentMethod === "string" ? paymentMethod : paymentMethod.id;
  const card = typeof paymentMethod === "object" ? paymentMethod.card : null;
  db.upsertStripeCustomer({
    conversationId, customerId, paymentMethodId,
    brand: card?.brand ?? "", last4: card?.last4 ?? "",
  });
  return { ok: true, conversationId, customerId, paymentMethodId, brand: card?.brand ?? "", last4: card?.last4 ?? "" };
}

/**
 * Charge the card already saved for this conversation. Confirmed immediately and off_session,
 * because there is nobody sitting at a browser to complete a 3-D Secure step — the whole point of
 * saving a card is that a later charge needs nobody present. Throws on a decline or any other
 * Stripe error; the caller (payment_charge's handler, src/tools.js) is what turns that into a
 * receipt and a plain refusal rather than this file guessing at what the caps or the ledger should
 * say about it.
 */
export async function chargeUser(conversationId, { amountCents, currency = "usd", description = "" }) {
  const s = requireStripe();
  const saved = db.getStripeCustomer(conversationId);
  if (!saved) throw new Error("No payment method saved for this conversation.");
  return await s.paymentIntents.create({
    amount: Math.round(amountCents),
    currency,
    customer: saved.customer_id,
    payment_method: saved.payment_method_id,
    off_session: true,
    confirm: true,
    description: description || undefined,
  });
}

/** The card on file, as a person reads it, or null when there is none. */
export function getPaymentMethod(conversationId) {
  const row = db.getStripeCustomer(conversationId);
  if (!row) return null;
  return { brand: row.brand, last4: row.last4, setup_at: row.setup_at };
}

/** Recent charges made through this conversation's saved card, newest first. */
export function listCharges(conversationId, { limit = 20 } = {}) {
  return db.listStripeCharges(conversationId, limit);
}

// ---------- Stripe Issuing: virtual cards for merchant checkout ----------

/**
 * Create (or return the existing) Issuing cardholder for this conversation. A cardholder is the
 * identity behind every virtual card and needs a name + billing address for AVS checks. Created
 * once, reused for every purchase after that.
 */
export async function ensureCardholder(conversationId, { name, billing }) {
  const s = requireStripe();
  const existing = db.getIssuingCardholder(conversationId);
  if (existing) return { ok: true, cardholderId: existing.cardholder_id };

  const names = name.trim().split(/\s+/);
  const first = names[0];
  const last = names.length > 1 ? names.slice(1).join(" ") : first;

  const cardholder = await s.issuing.cardholders.create({
    name,
    type: "individual",
    status: "active",
    individual: {
      first_name: first,
      last_name: last,
      card_issuing: {
        user_terms_acceptance: {
          date: Math.floor(Date.now() / 1000),
          ip: "127.0.0.1",
        },
      },
    },
    billing: { address: billing },
    metadata: { conversationId },
  });

  db.upsertIssuingCardholder({ conversationId, cardholderId: cardholder.id });
  return { ok: true, cardholderId: cardholder.id };
}

/**
 * Create a single-use virtual card for a specific purchase. The card is locked to the exact amount
 * with a per-authorization spending limit. Returns the full card number, expiry and CVC so the
 * browser tools can type them into a checkout form.
 */
export async function createPurchaseCard(conversationId, { amountCents, merchant, description }) {
  const s = requireStripe();
  const holder = db.getIssuingCardholder(conversationId);
  if (!holder) throw new Error("No Issuing cardholder for this conversation. Call ensureCardholder first.");

  const card = await s.issuing.cards.create({
    cardholder: holder.cardholder_id,
    currency: "usd",
    type: "virtual",
    status: "active",
    spending_controls: {
      spending_limits: [{
        amount: Math.round(amountCents),
        interval: "per_authorization",
      }],
    },
    metadata: { conversationId, merchant, description },
  });

  db.recordIssuingCard({
    conversationId, cardId: card.id, amountLimitCents: amountCents,
    merchant, description,
  });

  const full = await s.issuing.cards.retrieve(card.id, {
    expand: ["number", "cvc"],
  });

  return {
    ok: true,
    cardId: card.id,
    number: full.number,
    exp_month: String(full.exp_month).padStart(2, "0"),
    exp_year: String(full.exp_year),
    cvc: full.cvc,
    brand: full.brand,
    last4: full.last4,
  };
}

/** Cancel a virtual card after purchase (good hygiene, though the spending limit already prevents reuse). */
export async function cancelPurchaseCard(cardId) {
  const s = requireStripe();
  await s.issuing.cards.update(cardId, { status: "canceled" });
  db.cancelIssuingCard(cardId);
  return { ok: true };
}

/** Whether the Stripe key has Issuing access. Checked lazily on first purchase_card call. */
export function isIssuingConfigured() {
  return !!stripe;
}
