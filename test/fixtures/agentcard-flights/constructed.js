// CONSTRUCTED flight answers — NOT recorded. Each is the recorded sandbox cart (2-pick.json /
// 3-passenger.json, 2026-10-25) with the one field changed that a test needs, because the sandbox
// cannot produce these (it stops before payment) or has not produced them yet. Every field name is
// one the recorded answers or AgentCard's SDK types (@agent-cards/commerce-sdk 0.13.0, BuyCart /
// BuyTurn) carry; nothing here is a guessed name. Where a value is a guess it says so.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const recorded = (name) => JSON.parse(readFileSync(join(here, `${name}.json`), "utf8")).body;

const passenger = () => recorded("3-passenger");

/** The recorded cart, with its fee figure broken into the store's own labelled lines (BuyCartFeeLine). */
export function itemizedTurn() {
  const b = passenger();
  b.cart = { ...b.cart, items: [{ ...b.cart.items[0], priceCents: 14800, lineTotalCents: 14800 }], subtotalCents: 14800, serviceFeesCents: 2947,
    merchantFeeLines: [{ label: "Taxes and carrier-imposed fees", amountCents: 2514 }, { label: "Booking fee", amountCents: 433 }], totalCents: 17747, approvedCeilingCents: 17747, hash: "itemized0000001" };
  b.carts = [b.cart];
  return b;
}

/** The recorded cart flagged as an estimate (BuyCart.totalIsEstimate true): it must never be approved. */
export function estimateTurn() {
  const b = passenger();
  b.cart = { ...b.cart, totalIsEstimate: true, hash: "estimate0000001" };
  b.carts = [b.cart];
  return b;
}

/** A hold ceiling above the total: the store prices its final at checkout, so the total is not final. */
export function ceilingAboveTurn() {
  const b = passenger();
  b.cart = { ...b.cart, approvedCeilingCents: 19500, hash: "ceiling00000001" };
  b.carts = [b.cart];
  return b;
}

/** The confirm pausing for the passkey (BuyTurn: decline_code, approval_url, approval_expires_at). */
export function approvalPause(expiresAtIso) {
  return { body: { status: "declined", decline_code: "vault_approval_required", approval_url: "https://vault.agentcard.sh/authorize?id=cauth_flight1",
    approval_expires_at: expiresAtIso, charge_status: "none", reply: "Approve the payment to book your flight (up to $177.47)." } };
}

/** A card decline at the confirm. `card_declined` is a guessed code — declineLine says any unknown code neutrally. */
export const declinedConfirm = { body: { status: "declined", decline_code: "card_declined", charge_status: "none", reply: "Your card was declined." } };

/** The confirm placing an order (BuyTurn status order_placed). What a real flight order carries beyond this is unknown. */
export const placedConfirm = { placeOrder: true, body: { status: "order_placed", charge_status: "settled", payment_source: { source: "vault", brand: "visa", last4: "4832" }, reply: "Your flight is booked." } };
