// Flights booked end to end through Duffel, behind REASON_FLIGHT_DUFFEL (off | owner | on).
//
// How the money moves (Duffel docs, "Choosing a payment method", read 2026-11-09). Paying the airline
// with the person's card cannot carry a markup or a service fee, and Duffel Payments is closed to new
// customers. So Reason charges the card itself through Stripe and pays the airline from its Duffel
// Balance. The order of steps is what keeps people from paying for nothing:
//
//   Face ID -> count against today's limit -> hold the card -> create the order -> take the money
//   -> read the order back -> say so.
//
//   - A booking Duffel definitely refused releases the hold: nothing was ever charged.
//   - An answer that proves nothing is `unknown`: the order is NEVER sent again, the hold stays and
//     nothing is taken, and the sweep, webhooks and a boot resume find out what really happened.
//   - Nothing is called booked until an order came back. Nothing is called ticketed until the order,
//     read back afterwards, carries an e-ticket for every passenger.
//
// One row per approved trip: a partial unique index means the same people cannot hold two live
// bookings for the same flights, whatever the offer id says. Every step claims its row with a
// compare-and-set, and the Stripe calls carry idempotency keys derived from the row.
import { createHash, randomUUID } from "node:crypto";
import { config, clock } from "./config.js";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as passkey from "./passkey.js";
import * as trust from "./trust.js";
import * as plan from "./plan.js";
import * as stripeapi from "./stripe.js";
import * as duffel from "./duffel.js";
import * as flightbook from "./flightbook.js";
import * as incidents from "./incidents.js";

export const mode = () => {
  const v = String(process.env.REASON_FLIGHT_DUFFEL ?? "").trim().toLowerCase();
  return v === "owner" ? "owner" : ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
};
/**
 * LEGAL GATE. Reason being merchant of record is approved for testing only: no real ticket is sold until
 * a lawyer has answered the seller-of-travel question. Real money needs REASON_FLIGHT_DUFFEL_LIVE, off
 * by default and separate from REASON_FLIGHT_DUFFEL. Without it a live Duffel token cannot write
 * (src/duffel.js) and a live Stripe key cannot hold a card for a sandbox ticket.
 */
export const cardKeyAllowed = () => { const k = stripeapi.env().secretKey; return !!k && (/^(sk|rk)_test_/.test(k) || duffel.env().liveAllowed); };
/** On only when every part a yes depends on is here: the flag, Duffel, Stripe, and Face ID. */
export function enabled(conversationId) {
  const m = mode();
  if (m === "off" || !conversationId) return false;
  if (m === "owner" && !accounts.ownerOf(conversationId).isOperator) return false;
  return duffel.canBook() && cardKeyAllowed() && passkey.passkeyAllowedFor(conversationId);
}

/** Reason's flat fee per booking, in cents. Placeholder until the owner sets it. */
export const reasonFeeCents = () => {
  const n = Number(process.env.REASON_FLIGHT_FEE_CENTS ?? 500);
  return Number.isInteger(n) && n >= 0 ? n : 500;
};
/** Unlimited members (a live paid plan) and grandfathered people pay no Reason fee. */
export const feeFor = (conversationId) => {
  const s = plan.status(conversationId).status;
  return s === "paid" || s === "cancelled" || s === "free" || plan.grandfathered(conversationId) ? 0 : reasonFeeCents();
};
/** Duffel's published price per order, passed through: $3.00 plus 1% of the order (managed content). */
export const serviceFeeCents = (airlineCents) => {
  const fixed = Number(process.env.REASON_FLIGHT_SERVICE_FIXED_CENTS ?? 300), bps = Number(process.env.REASON_FLIGHT_SERVICE_BPS ?? 100);
  return (Number.isInteger(fixed) && fixed >= 0 ? fixed : 300) + Math.ceil(airlineCents * (Number.isInteger(bps) && bps >= 0 ? bps : 100) / 10_000);
};

/**
 * The card line. Stripe's fee is charged on the whole amount, including this line, so it is grossed up:
 * the smallest total that leaves the subtotal after the fee. Rates default to Stripe's standard US card
 * price (2.9% + 30c), and REASON_FLIGHT_CARD_BPS / _FIXED_CENTS match them to the real account.
 */
const cardRate = () => {
  const bps = Number(process.env.REASON_FLIGHT_CARD_BPS ?? 290), fixed = Number(process.env.REASON_FLIGHT_CARD_FIXED_CENTS ?? 30);
  return { bps: Number.isInteger(bps) && bps >= 0 && bps < 5000 ? bps : 290, fixed: Number.isInteger(fixed) && fixed >= 0 ? fixed : 30 };
};
/** What the card company takes from a charge of `total` cents, a fraction of a cent rounded against Reason. */
export const processorCents = (total, { bps, fixed } = cardRate()) => Math.ceil(total * bps / 10_000) + fixed;
export function cardFeeCents(subtotal, rate = cardRate()) {
  if (subtotal <= 0) return 0;
  let total = Math.ceil((subtotal + rate.fixed) * 10_000 / (10_000 - rate.bps));
  while (total - processorCents(total, rate) < subtotal) total++;
  while (total - 1 - processorCents(total - 1, rate) >= subtotal) total--;
  return total - subtotal;
}

const q = (sql) => db.db.prepare(sql);
/** A synchronous body as one write: nothing else runs between its reads and writes. */
const transaction = (fn) => () => {
  db.db.exec("BEGIN IMMEDIATE");
  try { const out = fn(); db.db.exec("COMMIT"); return out; } catch (e) { db.db.exec("ROLLBACK"); throw e; }
};
db.db.exec(`
  CREATE TABLE IF NOT EXISTS flight_bookings (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    trip_fp TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    offer_expires_at INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    offer_json TEXT NOT NULL DEFAULT '{}',
    traveler_ids TEXT NOT NULL,
    traveler_fp TEXT NOT NULL,
    airline_cents INTEGER NOT NULL,
    service_cents INTEGER NOT NULL,
    card_cents INTEGER NOT NULL,
    reason_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    stripe_customer TEXT NOT NULL DEFAULT '',
    stripe_method TEXT NOT NULL DEFAULT '',
    stripe_pi TEXT NOT NULL DEFAULT '',
    capture_state TEXT NOT NULL DEFAULT 'none',
    spend_id INTEGER,
    order_id TEXT NOT NULL DEFAULT '',
    booking_reference TEXT NOT NULL DEFAULT '',
    tickets TEXT NOT NULL DEFAULT '[]',
    told TEXT NOT NULL DEFAULT '',
    cancel_id TEXT NOT NULL DEFAULT '',
    cancel_refund_cents INTEGER,
    cancel_state TEXT NOT NULL DEFAULT '',
    cancel_expires_at INTEGER,
    refund_state TEXT NOT NULL DEFAULT '',
    unknown_since INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flight_bookings_by_conv ON flight_bookings (conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS flight_bookings_by_order ON flight_bookings (order_id);
  CREATE UNIQUE INDEX IF NOT EXISTS flight_bookings_one_live ON flight_bookings (conversation_id, trip_fp)
    WHERE status IN ('asked','authorizing','booking','unknown','booked','verified');

  CREATE TABLE IF NOT EXISTS flight_changes (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    change_offer_id TEXT NOT NULL,
    change_id TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    offer_expires_at INTEGER,
    change_cents INTEGER NOT NULL,
    card_cents INTEGER NOT NULL DEFAULT 0,
    stripe_pi TEXT NOT NULL DEFAULT '',
    spend_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS flight_changes_one_live ON flight_changes (booking_id)
    WHERE status IN ('asked','authorizing','confirming','unknown');

  CREATE TABLE IF NOT EXISTS flight_airline_changes (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    words TEXT NOT NULL,
    actions TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    notified_at INTEGER,
    detected_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS flight_card_customers (conversation_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS duffel_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL, done_at INTEGER);
`);

let sayFn = null;
let logFn = () => {};
let fetchFns = { duffel: undefined, stripe: undefined };
export function attach({ say, log } = {}) { sayFn = say ?? null; logFn = log ?? (() => {}); }
/** Tests replace the network and the waits here. */
export function _setFetch({ duffel: d, stripe: s } = {}) { fetchFns = { duffel: d, stripe: s }; }
let sleep = (ms) => new Promise(r => setTimeout(r, ms));
export function _setSleep(fn) { sleep = fn; }
const dopts = (extra = {}) => ({ ...(fetchFns.duffel ? { fetchImpl: fetchFns.duffel } : {}), ...extra });
const sopts = (extra = {}) => ({ ...(fetchFns.stripe ? { fetchImpl: fetchFns.stripe } : {}), ...extra });

const money = (cents) => `$${(Math.abs(cents) / 100).toFixed(2)}`;
const toCents = (s) => { const n = Math.round(Number(s) * 100); return Number.isFinite(n) ? n : null; };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const siteBase = () => (config.siteUrl || "https://heyreason.com").replace(/\/+$/, "");
const parseTime = (s) => { const t = Date.parse(s ?? ""); return Number.isFinite(t) ? t : null; };

export const get = (id) => q("SELECT * FROM flight_bookings WHERE id = ?").get(id) ?? null;
const getFor = (c, id) => { const r = get(id); return r && r.conversation_id === c ? r : null; };
const getChangeRow = (id) => q("SELECT * FROM flight_changes WHERE id = ?").get(id) ?? null;
const touch = (id, fields) => {
  const keys = Object.keys(fields);
  q(`UPDATE flight_bookings SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), clock.now(), id);
};
/** Move a row only from the state it was read in. False means somebody else already moved it. */
const cas = (id, from, to, extra = {}) => {
  const keys = Object.keys(extra);
  return q(`UPDATE flight_bookings SET status = ?, ${keys.map(k => `${k} = ?, `).join("")}updated_at = ? WHERE id = ? AND status = ?`)
    .run(to, ...keys.map(k => extra[k]), clock.now(), id, from).changes === 1;
};
const casChange = (id, from, to, extra = {}) => {
  const keys = Object.keys(extra);
  return q(`UPDATE flight_changes SET status = ?, ${keys.map(k => `${k} = ?, `).join("")}updated_at = ? WHERE id = ? AND status = ?`)
    .run(to, ...keys.map(k => extra[k]), clock.now(), id, from).changes === 1;
};

/**
 * Text them now. Tries for about 12 seconds, so a channel hiccup still lands inside the 15 seconds
 * promised for bad news. False means it did not go out; the caller keeps the duty and the sweep retries.
 */
export async function tellNow(c, text) {
  if (!sayFn) return false;
  for (const wait of [0, 1500, 4000, 6000]) {
    if (wait) await sleep(wait);
    try { await sayFn(c, text); return true; } catch { /* next try */ }
  }
  logFn({ flight_tell_failed: true });
  return false;
}
/** A line tied to a booking state goes out at most once, however many paths reach it. */
async function tellOnce(row, key, text) {
  const fresh = get(row.id);
  const told = new Set(String(fresh?.told ?? "").split(",").filter(Boolean));
  if (told.has(key)) return false;
  told.add(key);
  // Marked before sending so two paths can't both send; given back if the text could not go out.
  touch(row.id, { told: [...told].join(",") });
  const ok = await tellNow(row.conversation_id, text);
  if (!ok) { told.delete(key); touch(row.id, { told: [...told].join(",") }); }
  return ok;
}

// ---------- reading Duffel's offers ----------
const time = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = Number(m[4]);
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${h % 12 || 12}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
};
const flightNo = (s) => `${s.marketing_carrier?.iata_code ?? ""}${s.marketing_carrier_flight_number ?? ""}`;
const sliceWords = (slice) => (slice.segments ?? [])
  .map(s => `${s.origin?.iata_code}→${s.destination?.iata_code} ${flightNo(s)} ${time(s.departing_at)}–${time(s.arriving_at)}`).join("; ");
export const slicesSummary = (slices) => (slices ?? []).map(sliceWords).join(" · ");
const tripKey = (slices) => (slices ?? []).flatMap(sl => (sl.segments ?? []).map(s => `${s.origin?.iata_code}-${s.destination?.iata_code}-${flightNo(s)}-${String(s.departing_at).slice(0, 16)}`)).join("|");

function conditionWords(c) {
  const line = (x) => !x ? "not stated by the airline" : x.allowed ? (toCents(x.penalty_amount ?? "0") ? `allowed, ${money(toCents(x.penalty_amount))} penalty` : x.penalty_amount == null ? "allowed, penalty not stated" : "allowed, no penalty") : "not allowed";
  return { refund_before_departure: line(c?.refund_before_departure), change_before_departure: line(c?.change_before_departure) };
}
/** One offer as the model shows it. */
export function offerView(o) {
  return {
    offer_id: o.id, airline: o.owner?.name ?? "", flights: slicesSummary(o.slices),
    airline_price: money(toCents(o.total_amount) ?? 0), currency: o.total_currency,
    cabin: o.slices?.[0]?.segments?.[0]?.passengers?.[0]?.cabin_class_marketing_name ?? "",
    conditions: conditionWords(o.conditions),
    expires_at: o.expires_at ?? null,
  };
}

// ---------- the card ----------
/** Their Stripe customer: the one the subscription made, else one made for flights. */
async function customerFor(c) {
  const fromPlan = q("SELECT stripe_customer_id AS id FROM plan WHERE conversation_id = ?").get(c)?.id;
  if (fromPlan) return { ok: true, id: fromPlan };
  const mine = q("SELECT customer_id AS id FROM flight_card_customers WHERE conversation_id = ?").get(c)?.id;
  if (mine) return { ok: true, id: mine };
  const made = await stripeapi.api("POST", "/v1/customers", { metadata: { reason_conversation: sha(c).slice(0, 24) } }, sopts({ idempotencyKey: `flight-customer-${sha(c).slice(0, 32)}` })).catch(() => null);
  if (!made?.ok || !made.body?.id) return { ok: false };
  q("INSERT OR IGNORE INTO flight_card_customers (conversation_id, customer_id, created_at) VALUES (?, ?, ?)").run(c, made.body.id, clock.now());
  return { ok: true, id: made.body.id };
}
/** The card to hold, or a Stripe page to save one. Asked before any yes, so a yes can be kept. */
async function cardFor(c) {
  const cus = await customerFor(c);
  if (!cus.ok) return { ok: false, error: "stripe_unavailable" };
  const list = await stripeapi.api("GET", `/v1/payment_methods?customer=${encodeURIComponent(cus.id)}&type=card&limit=1`, null, sopts()).catch(() => null);
  if (!list?.ok) return { ok: false, error: "stripe_unavailable" };
  const pm = list.body?.data?.[0];
  if (pm?.id) return { ok: true, customer: cus.id, method: pm.id, label: `${pm.card?.brand ?? "card"} ending ${pm.card?.last4 ?? "????"}` };
  const session = await stripeapi.api("POST", "/v1/checkout/sessions", { mode: "setup", customer: cus.id, payment_method_types: ["card"], success_url: `${siteBase()}/web?thread`, cancel_url: `${siteBase()}/web?thread` }, sopts()).catch(() => null);
  if (!session?.ok || !session.body?.url) return { ok: false, error: "stripe_unavailable" };
  return { ok: false, error: "needs_card", url: session.body.url };
}
/** A hold for exactly this booking, off-session. The idempotency key makes a repeat the same hold. */
async function hold({ key, cents, customer, method, description, booking }) {
  if (!cardKeyAllowed()) return { state: "refused", code: "live_card_not_allowed" };
  let r = null;
  for (let i = 0; i < 2; i++) {
    r = await stripeapi.api("POST", "/v1/payment_intents", {
      amount: cents, currency: "usd", customer, payment_method: method, capture_method: "manual", confirm: true, off_session: true,
      description: description.slice(0, 200), metadata: { reason_flight: booking },
    }, sopts({ idempotencyKey: key })).catch(() => null);
    if (r && r.status) break;
  }
  if (!r || !r.status || r.status >= 500) return { state: "no_answer" };
  if (r.ok && r.body?.status === "requires_capture") return { state: "held", id: r.body.id };
  return { state: "refused", code: r.body?.error?.decline_code ?? r.body?.error?.code ?? r.body?.status ?? `http_${r.status}` };
}
async function capture(pi) {
  for (const wait of [0, 1000, 3000]) {
    if (wait) await sleep(wait);
    const r = await stripeapi.api("POST", `/v1/payment_intents/${encodeURIComponent(pi)}/capture`, {}, sopts({ idempotencyKey: `flight-capture-${pi}` })).catch(() => null);
    if (r?.ok) return true;
    if (r?.body?.error?.code === "payment_intent_unexpected_state" && r.body?.error?.payment_intent?.status === "succeeded") return true;
  }
  return false;
}
async function voidHold(pi) {
  if (!pi) return true;
  const r = await stripeapi.api("POST", `/v1/payment_intents/${encodeURIComponent(pi)}/cancel`, {}, sopts({ idempotencyKey: `flight-void-${pi}` })).catch(() => null);
  return !!r?.ok;
}
async function refund({ pi, cents, key }) {
  const r = await stripeapi.api("POST", "/v1/refunds", { payment_intent: pi, amount: cents }, sopts({ idempotencyKey: key })).catch(() => null);
  return !!r?.ok;
}

// ---------- the daily limit ----------
const spendLine = (summary, total, unknown = false) => `Flight: ${summary} (${money(total)})${unknown ? " (OUTCOME UNKNOWN)" : ""}`;
/** Nothing was charged: the day's count gives this amount back. */
const releaseSpend = (spendId, what) => { if (spendId) q("UPDATE spend SET cents = 0, what = ? WHERE id = ?").run(`${what} (released, nothing charged)`, spendId); };

// ---------- fares and the quote ----------
const AGE_MS = 365.25 * 864e5;
const ageOf = (bornOn) => Math.floor((clock.now() - Date.parse(`${bornOn}T00:00:00Z`)) / AGE_MS);

function confirmedTravelers(c, ids) {
  const travelers = ids.map(id => db.getFlightTraveler(c, id));
  if (travelers.some(t => !t)) return { error: "A traveler on that list isn't on record. Nothing was booked." };
  const stale = travelers.filter(t => !t.confirmed_at || clock.now() - t.confirmed_at > flightbook.TRAVELER_CONFIRM_MS);
  if (stale.length) return { blocked: "travelers_unconfirmed", error: `Not confirmed for this trip: ${stale.map(t => t.label).join(", ")}. Read their details back, ask, and use flight_traveler_confirm first. Nothing was booked.` };
  return { travelers };
}
const INFANT = "Lap infants can't be booked through Reason yet, so nothing was searched. Tell them plainly and hand over the Google Flights link.";

/** Bookable fares for a route, from Duffel. Prices here are the airline's alone, with no fees yet. */
export async function fares(c, input) {
  const got = confirmedTravelers(c, input.traveler_ids);
  if (got.error) return { ok: false, ...(got.blocked ? { blocked: got.blocked } : {}), error: got.error };
  if (got.travelers.some(t => ageOf(t.born_on) < 2)) return { ok: false, blocked: "infant", error: INFANT };
  const slices = [{ origin: input.origin, destination: input.destination, departure_date: input.departure_date }];
  if (input.return_date) slices.push({ origin: input.destination, destination: input.origin, departure_date: input.return_date });
  const res = await duffel.searchOffers({ slices, passengers: got.travelers.map(t => ({ age: ageOf(t.born_on) })), cabin_class: input.cabin ?? "economy" }, dopts());
  if (res.status !== 201 && res.status !== 200) return { ok: false, error: "The fares couldn't be read just now. Nothing was booked. Tell them and offer to try again." };
  const offers = (res.json?.data?.offers ?? []).filter(o => o.total_currency === "USD")
    .sort((a, b) => toCents(a.total_amount) - toCents(b.total_amount)).slice(0, 8).map(offerView);
  return { ok: true, offers, note: "Show the few that fit best, with airline, times and what changes or refunds allow. These are the airline's prices before the booking and Reason fees; flight_quote gives the exact total." };
}

/**
 * The exact price, line by line, and the Face ID link: nothing is held or charged here. Everything a
 * yes depends on is checked first (card, Face ID, today's limit, the offer still being good), so
 * Reason only ever asks for a yes it can keep.
 */
export async function quote(c, input) {
  const got = confirmedTravelers(c, input.traveler_ids);
  if (got.error) return { ok: false, ...(got.blocked ? { blocked: got.blocked } : {}), error: got.error };
  if (got.travelers.some(t => ageOf(t.born_on) < 2)) return { ok: false, blocked: "infant", error: INFANT };
  if (!passkey.requiredFor(c)) return { ok: false, blocked: "needs_face_id", url: `${siteBase()}/web/connect/passkey`, error: "Booking needs Face ID set up first, because a flight is only ever approved that way. Nothing was booked. Give them this link, and quote again once it's done." };
  const res = await duffel.getOffer(input.offer_id, dopts());
  if (res.status !== 200 || !res.json?.data) return { ok: false, blocked: "offer_gone", error: "That fare is no longer available. Nothing was booked. Get fresh fares with flight_fares." };
  const offer = res.json.data;
  const expiresAt = parseTime(offer.expires_at);
  if (expiresAt && expiresAt <= clock.now()) return { ok: false, blocked: "offer_gone", error: "That fare has expired. Nothing was booked. Get fresh fares with flight_fares." };
  if (offer.total_currency !== "USD") return { ok: false, blocked: "currency", error: `That fare is priced in ${offer.total_currency}, and Reason only books in US dollars for now. Nothing was booked.` };
  if ((offer.passengers?.length ?? 0) !== got.travelers.length) return { ok: false, blocked: "passenger_count", error: "That fare is for a different number of people. Nothing was booked. Get fares for these travelers." };
  const airline = toCents(offer.total_amount);
  if (airline == null || airline <= 0) return { ok: false, blocked: "bad_price", error: "That fare's price couldn't be read. Nothing was booked." };
  const service = serviceFeeCents(airline);
  const reason = feeFor(c);
  const card = cardFeeCents(airline + service + reason);
  const total = airline + service + card + reason;
  const cap = trust.checkSpendCap(c, total);
  if (!cap.ok) return { ...cap, ok: false };
  const payWith = await cardFor(c);
  if (!payWith.ok) return payWith.error === "needs_card"
    ? { ok: false, blocked: "needs_card", url: payWith.url, error: "They have no card saved for flights, so no yes can be taken yet. Nothing was booked. Give them this link to save one, and quote again when they're back." }
    : { ok: false, blocked: "stripe_unavailable", error: "The card system didn't answer, so no price can be promised. Nothing was booked. Tell them and offer to try again." };

  const fp = sha(`${tripKey(offer.slices)}#${flightbook.travelerFingerprint(got.travelers)}`);
  const id = `fb_${randomUUID()}`;
  const now = clock.now();
  const summary = `${offer.owner?.name ?? "Airline"}: ${slicesSummary(offer.slices)}`;
  // One transaction: an unapproved earlier ask for this trip is replaced, anything further along refuses.
  const live = q("SELECT * FROM flight_bookings WHERE conversation_id = ? AND trip_fp = ? AND status IN ('asked','authorizing','booking','unknown','booked','verified')").get(c, fp);
  if (live && live.status !== "asked") return { ok: false, blocked: "already_booked", booking_id: live.id, status: live.status, error: "These people already have this flight booked or being booked, so a second one was not started. Tell them what's already in place." };
  const insert = transaction(() => {
    if (live) { const a = passkey.openApprovalFor(live.id, "flight"); if (a) passkey.closeApproval(a, "replaced"); q("UPDATE flight_bookings SET status = 'replaced', updated_at = ? WHERE id = ? AND status = 'asked'").run(now, live.id); }
    q(`INSERT INTO flight_bookings (id, conversation_id, status, trip_fp, offer_id, offer_expires_at, summary, offer_json, traveler_ids, traveler_fp, airline_cents, service_cents, card_cents, reason_cents, total_cents, stripe_customer, stripe_method, created_at, updated_at)
       VALUES (?, ?, 'asked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, c, fp, offer.id, expiresAt, summary, JSON.stringify({ passengers: offer.passengers.map(p => ({ id: p.id })) }), JSON.stringify(input.traveler_ids), flightbook.travelerFingerprint(got.travelers), airline, service, card, reason, total, payWith.customer, payWith.method, now, now);
  });
  try { insert(); } catch { return { ok: false, blocked: "already_booked", error: "This flight is already being booked for these people, so a second one was not started." }; }
  const token = passkey.createApproval(rowForApproval(get(id)), { until: expiresAt ?? undefined });
  const lines = lineItems(get(id));
  return {
    ok: true, booking_id: id, flights: summary, lines, total: money(total), charged_to: payWith.label,
    conditions: conditionWords(offer.conditions), url: `${siteBase()}/web/approve/${token}`,
    note: "Send the lines exactly as given, the fare's refund and change rules, and the link. Their Face ID on that page is the yes; a texted yes does not book. Nothing is held or charged until then. Never say it's booked: you'll be told, and so will they.",
  };
}
export const lineItems = (r) => [
  { label: "Airline fare and taxes", amount: money(r.airline_cents) },
  { label: "Booking service fee", amount: money(r.service_cents) },
  { label: "Card processing fee", amount: money(r.card_cents) },
  ...(r.reason_cents ? [{ label: "Reason fee", amount: money(r.reason_cents) }] : []),
];

// ---------- Face ID (src/passkey.js, src/pages/webapprove.js) ----------
/** The row as the approval code reads it. `binding` is what the Face ID signature covers. */
export function rowForApproval(r) {
  return { id: r.id, kind: "flight", conversation_id: r.conversation_id, status: r.status, amount_kind: "exact", amount: (r.total_cents / 100).toFixed(2), currency: "USD",
    merchant_name: "Flight", item: r.summary, binding: sha(`${r.offer_id}|${r.traveler_fp}|${r.airline_cents}|${r.service_cents}|${r.card_cents}|${r.reason_cents}|${r.total_cents}`) };
}
/** What the card is charged for a change: the airline's cost and its card line; nothing for a refund. */
const chargeOf = (ch) => Math.max(ch.change_cents, 0) + ch.card_cents;
function changeForApproval(ch) {
  return { id: ch.id, kind: "flight", conversation_id: ch.conversation_id, status: ch.status, amount_kind: "exact", amount: (chargeOf(ch) / 100).toFixed(2), currency: "USD", merchant_name: "Flight change", item: ch.summary, binding: sha(`${ch.change_offer_id}|${ch.change_cents}|${ch.card_cents}`) };
}
/** What the approval page shows for a flight link; null when the feature does not reach them. */
export function approvalView(a) {
  if (!enabled(a.conversation_id)) return null;
  if (String(a.payment_id).startsWith("fc_")) {
    const ch = getChangeRow(a.payment_id);
    if (!ch || ch.conversation_id !== a.conversation_id) return null;
    const row = changeForApproval(ch);
    const breakdown = ch.change_cents >= 0 ? [["Airline change cost", money(ch.change_cents)], ...(ch.card_cents ? [["Card processing fee", money(ch.card_cents)]] : [])] : [["Refund to your card", money(ch.change_cents)]];
    return { a, row, kind: "flight", flightKind: "change", state: a.state === "open" && ch.status !== "asked" ? "closed" : a.state, amount: ch.change_cents >= 0 ? money(chargeOf(ch)) : money(ch.change_cents), store: "Flight change", item: ch.summary, expiresAt: a.expires_at, breakdown };
  }
  const r = get(a.payment_id);
  if (!r || r.conversation_id !== a.conversation_id) return null;
  const row = rowForApproval(r);
  return { a, row, kind: "flight", flightKind: "book", state: a.state === "open" && r.status !== "asked" ? "closed" : a.state, amount: money(r.total_cents), store: "Flight", item: r.summary, expiresAt: a.expires_at, breakdown: lineItems(r).map(l => [l.label, l.amount]) };
}

const inFlight = new Map();
const track = (id, p) => { const done = p.catch(e => logFn({ flight_run_threw: true, why: String(e?.message ?? e).slice(0, 100) })).finally(() => inFlight.delete(id)); inFlight.set(id, done); return done; };
/** Every booking running in this process has finished (tests, and a clean stop). */
export const idle = async () => { while (inFlight.size) await Promise.all([...inFlight.values()]); };

/**
 * Face ID on the page. Over the limit, the link stays open. Past the assertion the booking runs on
 * its own and this answers at once: the page says it's being booked, the text says how it went.
 */
export async function approve(v, response) {
  const isChange = v.flightKind === "change";
  const cents = isChange ? chargeOf(getChangeRow(v.row.id)) : get(v.row.id).total_cents;
  const cap = cents ? trust.checkSpendCap(v.row.conversation_id, cents) : { ok: true };
  if (!cap.ok) { passkey.logEvent(v.row.conversation_id, v.row, "pay_failed", "over_daily_cap"); return { ok: false, error: "over_daily_cap", say: cap.say }; }
  const ok = await passkey.verifyApproval(v.a, v.row, response);
  if (!ok.ok) return ok;
  const started = isChange ? startChange(v.row.id) : start(v.row.id);
  if (!started.ok) return started;
  return { ok: true, booking_started: true };
}
export async function decline(v) {
  passkey.closeApproval(v.a, "declined");
  passkey.logEvent(v.row.conversation_id, v.row, "declined");
  if (v.flightKind === "change") { casChange(v.row.id, "asked", "declined"); await tellNow(v.row.conversation_id, "Okay, I left your flight as it is."); return { ok: true }; }
  cas(v.row.id, "asked", "declined");
  await tellNow(v.row.conversation_id, "Okay, I didn't book it. Nothing was charged.");
  return { ok: true };
}

/** Claims the row and counts it against today, in one step; the booking then runs in the background. */
export function start(id) {
  const r = get(id);
  if (!r || r.status !== "asked") return { ok: false, error: `payment_${r?.status ?? "gone"}` };
  const claimed = transaction(() => {
    const cap = trust.checkSpendCap(r.conversation_id, r.total_cents);
    if (!cap.ok) return { ok: false, error: "over_daily_cap", say: cap.say };
    if (!cas(id, "asked", "authorizing")) return { ok: false, error: "payment_in_progress" };
    touch(id, { spend_id: trust.noteSpend({ conversationId: r.conversation_id, cents: r.total_cents, what: spendLine(r.summary, r.total_cents), site: "Flight" }) });
    return { ok: true };
  })();
  if (!claimed.ok) return claimed;
  track(id, run(id));
  return { ok: true };
}

// ---------- the booking run ----------
async function run(id) {
  let r = get(id);
  if (r.status === "authorizing") {
    const h = await hold({ key: `flight-hold-${id}`, cents: r.total_cents, customer: r.stripe_customer, method: r.stripe_method, description: `Flight ${r.summary}`, booking: id });
    if (h.state === "no_answer") {
      // Same key next time gives the same hold. Past the window, stop and say what is known.
      if (clock.now() - r.updated_at < 15 * 60_000) { logFn({ flight_hold_no_answer: true }); return; }
      if (!cas(id, "authorizing", "failed")) return;
      releaseSpend(r.spend_id, spendLine(r.summary, r.total_cents));
      await tellOnce(r, "failed", `I couldn't reach the card company, so I stopped before booking. Your flight is not booked and you weren't charged. If a pending hold shows on your card, it will drop off by itself. Want me to try again?`);
      return;
    }
    if (h.state === "refused") {
      if (!cas(id, "authorizing", "failed")) return;
      releaseSpend(r.spend_id, spendLine(r.summary, r.total_cents));
      logFn({ flight_hold_refused: true, code: h.code });
      await tellOnce(r, "failed", `Your card didn't go through, so I didn't book the flight and you weren't charged. Want me to try again, or use a different card?`);
      return;
    }
    if (!cas(id, "authorizing", "booking", { stripe_pi: h.id })) return;
    r = get(id);
  }
  if (r.status !== "booking") return;

  const got = confirmedPassengers(r);
  if (!got.ok) { await refuseBooking(r, got.why); return; }
  // From here the airline may be told. Whatever happens next, this row is never sent again.
  const res = await duffel.createOrder({
    type: "instant", selected_offers: [r.offer_id], passengers: got.passengers,
    payments: [{ type: "balance", currency: "USD", amount: (r.airline_cents / 100).toFixed(2) }],
    metadata: { reason_booking_id: r.id },
  }, dopts());
  const out = duffel.outcomeOf(res);
  if (out.outcome === "done") return await attachOrder(id, "booking", out.data);
  if (out.outcome === "rejected") return await refuseBooking(r, out.code);
  await markUnknown(r, out.why);
}

function confirmedPassengers(r) {
  let ids, slots;
  try { ids = JSON.parse(r.traveler_ids); slots = JSON.parse(r.offer_json).passengers; } catch { return { ok: false, why: "bad_row" }; }
  const travelers = ids.map(id => db.getFlightTraveler(r.conversation_id, id));
  if (travelers.some(t => !t)) return { ok: false, why: "travelers_gone" };
  if (flightbook.travelerFingerprint(travelers) !== r.traveler_fp) return { ok: false, why: "travelers_changed" };
  if (slots.length !== travelers.length) return { ok: false, why: "passenger_count" };
  return { ok: true, passengers: travelers.map((t, i) => ({
    id: slots[i].id, given_name: t.given_name, family_name: t.family_name, born_on: t.born_on,
    gender: t.gender, title: t.gender === "f" ? "ms" : "mr", email: t.email, phone_number: t.phone,
  })) };
}

const REFUSALS = {
  price_changed: "The airline changed the price before it would book, so I stopped.",
  offer_no_longer_available: "The airline says those seats are gone.",
  offer_expired: "That fare ran out before it could be booked.",
  duplicate_booking: "The airline says this flight is already booked for these people, so I did not book it again.",
  insufficient_balance: "The booking service couldn't pay the airline, which is on my side, not yours.",
};
async function refuseBooking(r, code) {
  if (!cas(r.id, "booking", "failed")) return;
  const voided = await voidHold(r.stripe_pi);
  releaseSpend(r.spend_id, spendLine(r.summary, r.total_cents));
  logFn({ flight_order_rejected: true, code, voided });
  await tellOnce(r, "failed", `${REFUSALS[code] ?? "The airline wouldn't book it."} Your flight is not booked and you weren't charged${voided ? "" : ", though a pending hold may show on your card for a few days"}. Want me to find you another fare?`);
}
async function markUnknown(r, why) {
  if (!cas(r.id, "booking", "unknown", { unknown_since: clock.now() })) return;
  q("UPDATE spend SET what = ? WHERE id = ?").run(spendLine(r.summary, r.total_cents, true), r.spend_id);
  logFn({ flight_order_unknown: true, booking: r.id, why });
  incidents.raise({ key: `flight_unknown:${r.id}`, area: "money", what: "A flight booking's outcome is unknown", error: why, next: "Checked by webhook and sweep; never resent." });
  await tellOnce(r, "unknown", `The airline didn't give me a clear answer on your flight, so I can't say it's booked yet. Your card has a hold but hasn't been charged, and I'm not trying again, so you can't end up with two tickets. I'm checking now and I'll text you as soon as I know.`);
}

/** An order exists. The money is taken, then the order is read back before anything is claimed. */
async function attachOrder(id, from, order) {
  if (!cas(id, from, "booked", { order_id: order.id, booking_reference: order.booking_reference ?? "" })) return;
  const r = get(id);
  q("UPDATE spend SET what = ? WHERE id = ?").run(spendLine(r.summary, r.total_cents), r.spend_id);
  touch(id, { capture_state: "pending" });
  if (await capture(r.stripe_pi)) touch(id, { capture_state: "done" });
  else {
    touch(id, { capture_state: "failed" });
    logFn({ flight_capture_failed: true, booking: id });
    incidents.raise({ key: `flight_capture:${id}`, area: "money", what: "A flight was booked but its card capture failed", error: "Stripe capture", next: "The sweep keeps retrying until the hold runs out." });
  }
  await verify(id);
}

/** The order, read back: same order, not cancelled, an e-ticket per passenger. Only that says ticketed. */
export async function verify(id) {
  const r = get(id);
  if (!r || r.status !== "booked") return;
  const res = await duffel.getOrder(r.order_id, dopts());
  const o = res.status === 200 ? res.json?.data : null;
  const ref = o?.booking_reference || r.booking_reference;
  if (o?.cancelled_at) {
    if (cas(id, "booked", "cancelled")) {
      incidents.raise({ key: `flight_airline_cancelled:${id}`, area: "money", what: "An airline cancelled a booking before it was ticketed; the refund needs handling by hand", error: ref });
      await tellOnce(r, "airline_cancelled", `The airline shows booking ${ref} as cancelled. I've flagged it so your money gets sorted out, and I'll text you as soon as it is.`);
    }
    return;
  }
  const passengers = o?.passengers?.length ?? 0;
  const tickets = (o?.documents ?? []).filter(d => d.type === "electronic_ticket" && d.unique_identifier).map(d => d.unique_identifier);
  if (o && o.id === r.order_id && ref && passengers && tickets.length >= passengers) {
    touch(id, { booking_reference: ref, tickets: JSON.stringify(tickets) });
    if (cas(id, "booked", "verified")) await tellOnce(r, "verified", `You're booked. Confirmation ${ref}, ticket ${tickets.join(", ")}. ${r.summary}. ${money(r.total_cents)} total. I checked it with the airline after booking. I'll tell you first if anything about it changes.`);
    return;
  }
  await tellOnce(r, "reserved", `The airline confirmed your booking, ${ref}, and it's waiting to issue the ticket number. ${money(r.total_cents)} total. I'll text you the ticket as soon as it's there.`);
}

// ---------- finding out what really happened ----------
/** Nothing here spends anything: it reads, then settles rows on what it read. Safe to run any time. */
export async function sweep() {
  const now = clock.now();
  for (const r of q("SELECT * FROM flight_bookings WHERE status = 'authorizing' OR status = 'booking'").all()) {
    if (inFlight.has(r.id)) continue;
    // A booking cut off mid-call may have reached the airline, so it is unknown, not resent.
    if (r.status === "booking") { await markUnknown(r, "interrupted"); continue; }
    track(r.id, run(r.id));
  }
  for (const r of q("SELECT * FROM flight_bookings WHERE status = 'unknown'").all()) await reconcileUnknown(r, now);
  for (const r of q("SELECT * FROM flight_bookings WHERE status = 'booked'").all()) {
    if (inFlight.has(r.id)) continue;
    if (r.capture_state !== "done" && await capture(r.stripe_pi)) touch(r.id, { capture_state: "done" });
    await verify(r.id);
  }
  for (const r of q("SELECT * FROM flight_bookings WHERE cancel_state = 'unknown'").all()) await settleCancellation(r);
  for (const r of q("SELECT * FROM flight_bookings WHERE refund_state = 'pending'").all()) await refundCancellation(r);
  for (const ch of q("SELECT * FROM flight_changes WHERE status = 'unknown'").all()) await settleChange(ch);
  for (const ch of q("SELECT * FROM flight_changes WHERE status = 'authorizing'").all()) if (!inFlight.has(ch.id)) track(ch.id, runChange(ch.id));
  for (const a of q("SELECT * FROM flight_airline_changes WHERE notified_at IS NULL").all()) await tellAirlineChange(a);
}
export const UNKNOWN_GIVE_UP_MS = 24 * 3600_000;
async function reconcileUnknown(r, now) {
  const trav = JSON.parse(r.traveler_ids).map(id => db.getFlightTraveler(r.conversation_id, id)).filter(Boolean);
  const res = await duffel.listOrdersByPassenger(trav.map(t => `${t.given_name} ${t.family_name}`), dopts());
  const hit = res.status === 200 ? (res.json?.data ?? []).find(o => o.metadata?.reason_booking_id === r.id) : null;
  if (hit) return await attachOrder(r.id, "unknown", hit);
  if (res.status !== 200 || now - (r.unknown_since ?? now) < UNKNOWN_GIVE_UP_MS) return;
  if (!cas(r.id, "unknown", "failed")) return;
  await voidHold(r.stripe_pi);
  releaseSpend(r.spend_id, r.summary);
  logFn({ flight_unknown_gave_up: true, booking: r.id });
  await tellOnce(r, "failed", `After 24 hours there's still no booking for that flight anywhere the airline or booking service shows, so it did not go through. You weren't charged and I've released the hold. Want me to look for it again?`);
}

// ---------- cancelling ----------
export async function cancelQuote(c, bookingId) {
  const r = getFor(c, bookingId);
  if (!r || !["booked", "verified"].includes(r.status)) return { ok: false, error: "That booking isn't one that can be cancelled. Nothing changed." };
  const res = await duffel.createCancellation(r.order_id, dopts());
  if (res.status !== 201 && res.status !== 200) return { ok: false, error: "The airline wouldn't quote a cancellation just now. Nothing changed, and the flight is still booked. Tell them and offer to try again." };
  const d = res.json.data;
  const refundCents = d.refund_amount == null ? null : toCents(d.refund_amount);
  if (refundCents == null) return { ok: false, blocked: "refund_unknown", error: "The airline won't say what it would refund, so I won't cancel blind. Nothing changed. Tell them this and that the airline can answer it directly, and ask if they want you to keep trying." };
  touch(r.id, { cancel_id: d.id, cancel_refund_cents: refundCents, cancel_state: "quoted", cancel_expires_at: parseTime(d.expires_at) });
  const fees = r.service_cents + r.card_cents + r.reason_cents;
  const refundable = Math.min(refundCents, r.airline_cents);
  return { ok: true, booking_id: r.id, refund: money(refundable), not_refunded: money(r.total_cents - refundable), fees_kept: money(fees), expires_at: d.expires_at ?? null,
    note: `Tell them exactly: cancelling gets ${money(refundable)} back to their card. ${money(fees)} of booking and card fees can't be refunded. Then ask whether to cancel, once. flight_cancel_confirm does it and needs their yes.` };
}
export const cancelTarget = (c, input) => { const r = getFor(c, input.booking_id); return r ? `flight:cancel:${r.id}:refund:${r.cancel_refund_cents}` : `flight:cancel:${input.booking_id}`; };

export async function cancelConfirm(c, bookingId) {
  const r = getFor(c, bookingId);
  if (!r || r.cancel_state !== "quoted" || !["booked", "verified"].includes(r.status)) return { ok: false, error: "There's no cancellation quote open for that booking. Nothing changed. Get one with flight_cancel_quote." };
  if (r.cancel_expires_at && r.cancel_expires_at <= clock.now()) return { ok: false, blocked: "quote_expired", error: "That cancellation quote ran out. Nothing changed. Get a fresh one and ask again." };
  if (q("UPDATE flight_bookings SET cancel_state = 'confirming', updated_at = ? WHERE id = ? AND cancel_state = 'quoted'").run(clock.now(), r.id).changes !== 1) return { ok: false, error: "That cancellation is already under way." };
  const res = await duffel.confirmCancellation(r.cancel_id, dopts());
  const out = duffel.outcomeOf(res);
  if (out.outcome === "rejected") { touch(r.id, { cancel_state: "quoted" }); return { ok: false, error: `The airline refused the cancellation (${out.code}). The flight is still booked. Tell them that.` }; }
  if (out.outcome === "unknown") {
    touch(r.id, { cancel_state: "unknown" });
    return { ok: false, unknown_outcome: true, error: "The airline didn't give a clear answer. Tell them you can't say yet whether it's cancelled, that you won't send it again, and that you'll text as soon as you know." };
  }
  await finishCancellation(get(r.id));
  return { ok: true, cancelled: true, already_told: true, note: "They've been told the result by text. Do not repeat it." };
}
async function finishCancellation(r) {
  if (q("UPDATE flight_bookings SET status = 'cancelled', cancel_state = 'done', refund_state = 'pending', updated_at = ? WHERE id = ? AND cancel_state IN ('confirming','unknown')").run(clock.now(), r.id).changes !== 1) return;
  await refundCancellation(get(r.id));
}
const paidChanges = (bookingId) => q("SELECT id, stripe_pi, change_cents FROM flight_changes WHERE booking_id = ? AND status = 'done' AND change_cents > 0 AND stripe_pi != '' ORDER BY created_at").all(bookingId);
/** A refund can't exceed one payment, so it is split over the ticket's payment and then any paid changes. Same split, same keys, on every retry. */
async function refundAcross(r, cents, key) {
  let left = cents, i = 0;
  for (const p of [{ stripe_pi: r.stripe_pi, change_cents: r.airline_cents }, ...paidChanges(r.id)]) {
    const part = Math.min(left, p.change_cents);
    if (part > 0 && !(await refund({ pi: p.stripe_pi, cents: part, key: `${key}-${i}` }))) return false;
    left -= part; i++;
  }
  return left === 0;
}
async function refundCancellation(r) {
  const cents = Math.min(r.cancel_refund_cents ?? 0, r.airline_cents + paidChanges(r.id).reduce((s, c) => s + c.change_cents, 0));
  if (!cents) {
    touch(r.id, { refund_state: "none" });
    await tellOnce(r, "cancelled", `Cancelled. Booking ${r.booking_reference} is off. This fare doesn't pay anything back, so there's no refund.`);
    return;
  }
  const done = r.capture_state === "done" && await refundAcross(r, cents, `flight-refund-${r.cancel_id}`);
  if (!done) { logFn({ flight_refund_pending: true, booking: r.id }); await tellOnce(r, "cancelled_refund_pending", `Cancelled. Booking ${r.booking_reference} is off. Your ${money(cents)} refund hasn't gone through yet. I'm retrying it and will text you when it does.`); return; }
  touch(r.id, { refund_state: "done" });
  await tellOnce(r, "cancelled", `Cancelled. Booking ${r.booking_reference} is off, and ${money(cents)} is on its way back to your card. Banks usually take 5 to 10 days to show it.`);
}
async function settleCancellation(r) {
  const res = await duffel.getCancellation(r.cancel_id, dopts());
  if (res.status === 200 && res.json?.data?.confirmed_at) await finishCancellation(r);
}

// ---------- changing ----------
export async function changeOptions(c, input) {
  const r = getFor(c, input.booking_id);
  if (!r || !["booked", "verified"].includes(r.status)) return { ok: false, error: "That booking can't be changed. Nothing changed." };
  const res = await duffel.createChangeRequest({ order_id: r.order_id, slices: {
    remove: [{ slice_id: input.slice_id }],
    add: [{ origin: input.origin, destination: input.destination, departure_date: input.departure_date, cabin_class: input.cabin ?? "economy" }],
  } }, dopts());
  if (res.status !== 201 && res.status !== 200) return { ok: false, error: "The airline wouldn't offer changes just now. Nothing changed, and the flight is still booked." };
  const offers = (res.json?.data?.order_change_offers ?? []).slice(0, 8).map(o => ({
    change_offer_id: o.id, new_flights: slicesSummary(o.slices?.add), change_total: `${o.change_total_amount} ${o.change_total_currency}`,
    penalty: o.penalty_total_amount ?? "not stated", expires_at: o.expires_at ?? null,
  }));
  return { ok: true, offers, note: "A positive change_total is what they pay, a negative one comes back to them. flight_change_quote makes the Face ID link." };
}
export async function changeQuote(c, input) {
  const r = getFor(c, input.booking_id);
  if (!r || !["booked", "verified"].includes(r.status)) return { ok: false, error: "That booking can't be changed. Nothing changed." };
  const res = await duffel.getChangeOffer(input.change_offer_id, dopts());
  if (res.status !== 200 || !res.json?.data) return { ok: false, blocked: "offer_gone", error: "That change is no longer on offer. Nothing changed." };
  const o = res.json.data;
  if (o.change_total_currency !== "USD") return { ok: false, blocked: "currency", error: `That change is priced in ${o.change_total_currency}, and Reason only does US dollars for now. Nothing changed.` };
  const cents = toCents(o.change_total_amount);
  if (cents == null) return { ok: false, blocked: "bad_price", error: "That change's price couldn't be read. Nothing changed." };
  const card = cents > 0 ? cardFeeCents(cents) : 0;
  if (cents > 0) { const cap = trust.checkSpendCap(c, cents + card); if (!cap.ok) return { ...cap, ok: false }; }
  const expiresAt = parseTime(o.expires_at);
  const id = `fc_${randomUUID()}`;
  const summary = `Change ${r.booking_reference} to ${slicesSummary(o.slices?.add)}`;
  const now = clock.now();
  try {
    q("UPDATE flight_changes SET status = 'replaced', updated_at = ? WHERE booking_id = ? AND status = 'asked'").run(now, r.id);
    q(`INSERT INTO flight_changes (id, booking_id, conversation_id, status, change_offer_id, summary, offer_expires_at, change_cents, card_cents, created_at, updated_at) VALUES (?, ?, ?, 'asked', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, r.id, c, o.id, summary, expiresAt, cents, card, now, now);
  } catch { return { ok: false, blocked: "change_in_progress", error: "A change is already under way on this booking, so another wasn't started." }; }
  const token = passkey.createApproval(changeForApproval(getChangeRow(id)), { until: expiresAt ?? undefined });
  return { ok: true, change_id: id, summary, amount: cents >= 0 ? `${money(cents + card)} to pay` : `${money(cents)} back`, ...(card ? { lines: [{ label: "Airline change cost", amount: money(cents) }, { label: "Card processing fee", amount: money(card) }] } : {}), url: `${siteBase()}/web/approve/${token}`, note: "Send this and the link. Face ID on the page is the yes. Never say it's changed; they'll be told." };
}
function startChange(id) {
  const ch = getChangeRow(id);
  if (!ch || ch.status !== "asked") return { ok: false, error: `payment_${ch?.status ?? "gone"}` };
  const claimed = transaction(() => {
    if (ch.change_cents > 0) { const cap = trust.checkSpendCap(ch.conversation_id, chargeOf(ch)); if (!cap.ok) return { ok: false, error: "over_daily_cap", say: cap.say }; }
    if (!casChange(id, "asked", "authorizing")) return { ok: false, error: "payment_in_progress" };
    if (ch.change_cents > 0) q("UPDATE flight_changes SET spend_id = ? WHERE id = ?").run(trust.noteSpend({ conversationId: ch.conversation_id, cents: chargeOf(ch), what: `Flight change: ${ch.summary}`, site: "Flight" }), id);
    return { ok: true };
  })();
  if (!claimed.ok) return claimed;
  track(id, runChange(id));
  return { ok: true };
}
async function runChange(id) {
  let ch = getChangeRow(id);
  if (ch.status !== "authorizing") return;
  const b = get(ch.booking_id);
  if (ch.change_cents > 0) {
    const h = await hold({ key: `flight-hold-${id}`, cents: chargeOf(ch), customer: b.stripe_customer, method: b.stripe_method, description: ch.summary, booking: id });
    if (h.state !== "held") {
      if (h.state === "no_answer" && clock.now() - ch.updated_at < 15 * 60_000) return;
      if (casChange(id, "authorizing", "failed")) { releaseSpend(ch.spend_id, ch.summary); await tellNow(ch.conversation_id, "Your card didn't go through, so I left your flight as it is. You weren't charged."); }
      return;
    }
    q("UPDATE flight_changes SET stripe_pi = ? WHERE id = ?").run(h.id, id);
  }
  if (!casChange(id, "authorizing", "confirming")) return;
  ch = getChangeRow(id);
  const created = await duffel.createChange(ch.change_offer_id, dopts());
  const madeOut = duffel.outcomeOf(created);
  if (madeOut.outcome !== "done") return await failChange(ch, madeOut.outcome === "unknown");
  q("UPDATE flight_changes SET change_id = ? WHERE id = ?").run(madeOut.data.id, id);
  const pay = { type: "balance", amount: (Math.max(ch.change_cents, 0) / 100).toFixed(2), currency: "USD" };
  const conf = duffel.outcomeOf(await duffel.confirmChange(madeOut.data.id, pay, dopts()));
  if (conf.outcome === "done") return await finishChange(getChangeRow(id));
  await failChange(getChangeRow(id), conf.outcome === "unknown");
}
async function failChange(ch, unknown) {
  if (unknown) {
    if (casChange(ch.id, "confirming", "unknown")) await tellNow(ch.conversation_id, `The airline didn't give a clear answer on your flight change, so I can't say it's done. Your original flight may still be active. I'm not sending it again, and I'll text you as soon as I know.`);
    return;
  }
  if (!casChange(ch.id, "confirming", "failed")) return;
  if (ch.stripe_pi) await voidHold(ch.stripe_pi);
  releaseSpend(ch.spend_id, ch.summary);
  await tellNow(ch.conversation_id, "The airline wouldn't make that change, so your flight stays as it was. You weren't charged.");
}
async function finishChange(ch) {
  if (!["confirming", "unknown"].some(s => casChange(ch.id, s, "done"))) return;
  const b = get(ch.booking_id);
  let line;
  if (ch.change_cents > 0) { await capture(ch.stripe_pi); line = `${money(chargeOf(ch))} charged to your card.`; }
  else if (ch.change_cents < 0) {
    const ok = b.capture_state === "done" && await refund({ pi: b.stripe_pi, cents: Math.min(-ch.change_cents, b.airline_cents), key: `flight-refund-${ch.id}` });
    if (ok) touch(b.id, { airline_cents: b.airline_cents + ch.change_cents });
    line = ok ? `${money(ch.change_cents)} is on its way back to your card.` : `Your ${money(ch.change_cents)} refund hasn't gone through yet, and I'm following up on it.`;
  } else line = "No extra cost.";
  // The order is read back so the record and the text describe what the airline now holds.
  const res = await duffel.getOrder(b.order_id, dopts());
  const o = res.status === 200 ? res.json?.data : null;
  if (o?.slices) touch(b.id, { summary: `${o.owner?.name ?? "Airline"}: ${slicesSummary(o.slices)}`, booking_reference: o.booking_reference || b.booking_reference });
  await tellNow(ch.conversation_id, `Changed. ${o?.slices ? `You're now on ${slicesSummary(o.slices)}. ` : ""}Confirmation ${o?.booking_reference || b.booking_reference}. ${line}`);
}
async function settleChange(ch) {
  if (!ch.change_id) return;
  const res = await duffel.getChange(ch.change_id, dopts());
  if (res.status === 200 && res.json?.data?.confirmed_at) await finishChange(ch);
}

// ---------- status ----------
export function status(c, bookingId = null) {
  const rows = bookingId ? [getFor(c, bookingId)].filter(Boolean) : q("SELECT * FROM flight_bookings WHERE conversation_id = ? AND status NOT IN ('replaced','declined') ORDER BY created_at DESC LIMIT 10").all(c);
  return { ok: true, bookings: rows.map(row => ({ ...row, status: row.status === "asked" && !passkey.openApprovalFor(row.id, "flight") ? "expired" : row.status })).map(r => ({
    booking_id: r.id, status: r.status, flights: r.summary, confirmation: r.booking_reference || null,
    tickets: JSON.parse(r.tickets || "[]"), total: money(r.total_cents), charged: r.capture_state === "done",
    meaning: STATUS_WORDS[r.status] ?? r.status,
  })) };
}
const STATUS_WORDS = {
  asked: "Waiting for their Face ID. Nothing held or charged.", authorizing: "Holding the card.", booking: "With the airline now. Not confirmed.",
  unknown: "The airline didn't answer clearly. NOT confirmed; do not say booked. Being checked, never resent.",
  booked: "Airline confirmed it, ticket number not issued yet.", verified: "Ticketed and checked with the airline afterwards.",
  failed: "Not booked. Not charged.", cancelled: "Cancelled.", expired: "The approval ran out.",
};

// ---------- airline changes and webhooks ----------
function airlineChangeWords(row, aic) {
  const before = slicesSummary(aic.removed);
  const after = slicesSummary(aic.added);
  const ref = row.booking_reference;
  if (!aic.added?.length) return `Your airline cancelled your flight on booking ${ref} (${before}). I haven't accepted anything. I can rebook you or get your refund, whichever you'd rather.`;
  return `Your airline changed your flight on booking ${ref}. It was ${before}. It's now ${after}. I haven't accepted anything. Do you want to keep the new time, move to another flight, or cancel for a refund?`;
}
async function tellAirlineChange(a) {
  if (await tellNow(a.conversation_id, a.words)) { q("UPDATE flight_airline_changes SET notified_at = ? WHERE id = ?").run(clock.now(), a.id); return true; }
  return false;
}
export async function airlineChangeAccept(c, id) {
  const a = q("SELECT * FROM flight_airline_changes WHERE id = ? AND conversation_id = ?").get(id, c);
  if (!a || a.status !== "open") return { ok: false, error: "That airline change isn't open. Nothing was accepted." };
  if (q("UPDATE flight_airline_changes SET status = 'accepting' WHERE id = ? AND status = 'open'").run(id).changes !== 1) return { ok: false, error: "That change is already being accepted." };
  const out = duffel.outcomeOf(await duffel.acceptAirlineChange(id, dopts()));
  if (out.outcome === "done") { q("UPDATE flight_airline_changes SET status = 'accepted' WHERE id = ?").run(id); return { ok: true, accepted: true }; }
  if (out.outcome === "rejected") { q("UPDATE flight_airline_changes SET status = 'open' WHERE id = ?").run(id); return { ok: false, error: `The airline refused that (${out.code}). Nothing was accepted. Tell them.` }; }
  q("UPDATE flight_airline_changes SET status = 'unknown' WHERE id = ?").run(id);
  return { ok: false, unknown_outcome: true, error: "The airline didn't give a clear answer, so it isn't known whether the new time is accepted. Say that. It won't be sent again." };
}

export const openAirlineChanges = (c) => q("SELECT id, booking_id, words, actions FROM flight_airline_changes WHERE conversation_id = ? AND status = 'open'").all(c).map(a => ({ ...a, actions: JSON.parse(a.actions) }));

/** One verified event. `ok: false` makes Duffel send it again; every path is safe to repeat. */
export async function handleEvent(event) {
  q("INSERT OR IGNORE INTO duffel_events (id, type, received_at) VALUES (?, ?, ?)").run(event.id, event.type, clock.now());
  if (q("SELECT done_at FROM duffel_events WHERE id = ?").get(event.id)?.done_at) return { ok: true, duplicate: true };
  const out = await actOn(event);
  if (out.ok) q("UPDATE duffel_events SET done_at = ? WHERE id = ?").run(clock.now(), event.id);
  return out;
}
async function actOn(event) {
  const o = event.data?.object ?? {};
  switch (event.type) {
    case "order.airline_initiated_change_detected": {
      const row = q("SELECT * FROM flight_bookings WHERE order_id = ?").get(o.order_id ?? "");
      if (!row) { logFn({ duffel_event_unmatched: event.type }); return { ok: true, matched: false }; }
      q("INSERT OR IGNORE INTO flight_airline_changes (id, booking_id, conversation_id, order_id, words, actions, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(o.id, row.id, row.conversation_id, row.order_id, airlineChangeWords(row, o), JSON.stringify(o.available_actions ?? []), clock.now());
      const a = q("SELECT * FROM flight_airline_changes WHERE id = ?").get(o.id);
      if (a.notified_at) return { ok: true };
      return { ok: await tellAirlineChange(a) };
    }
    case "order.created": {
      const r = q("SELECT * FROM flight_bookings WHERE status = 'unknown' AND (id = ? OR offer_id = ?)").get(o.metadata?.reason_booking_id ?? "", o.offer_id ?? o.selected_offers?.[0] ?? "");
      if (r) {
        const res = await duffel.getOrder(o.order_id ?? o.id, dopts());
        if (res.status !== 200) return { ok: false };
        await attachOrder(r.id, "unknown", res.json.data);
      }
      return { ok: true };
    }
    case "order.creation_failed": {
      const r = q("SELECT * FROM flight_bookings WHERE status = 'unknown' AND offer_id = ?").get(o.offer_id ?? "");
      if (r && cas(r.id, "unknown", "failed")) {
        await voidHold(r.stripe_pi);
        releaseSpend(r.spend_id, r.summary);
        await tellOnce(r, "failed", "The airline confirmed that booking didn't go through. Your flight is not booked, and you weren't charged. Want me to look for it again?");
      }
      return { ok: true };
    }
    case "order_cancellation.confirmed": {
      const r = q("SELECT * FROM flight_bookings WHERE order_id = ? AND cancel_state IN ('unknown','confirming')").get(o.order_id ?? "");
      if (r) await finishCancellation(r);
      return { ok: true };
    }
    case "air.order.changed": {
      const r = q("SELECT * FROM flight_bookings WHERE order_id = ? AND status = 'booked'").get(o.id ?? o.order_id ?? "");
      if (r) await verify(r.id);
      return { ok: true };
    }
    default: return { ok: true, ignored: true };
  }
}

/** POST /duffel/webhook. Signature first; off means not found, like any other unknown path. */
export async function webhookRequest({ rawBody, headers = {}, log = () => {} }) {
  if (mode() === "off") return { status: 404, body: { error: "not found" } };
  const v = duffel.verifyWebhook({ rawBody, headers });
  if (!v.ok) { log({ duffel_webhook_rejected: v.why }); return { status: 401, body: { error: "rejected" } }; }
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "bad json" } }; }
  if (!event?.id || !event?.type) return { status: 400, body: { error: "no event" } };
  if (typeof event.live_mode === "boolean" && event.live_mode === duffel.isTestToken()) return { status: 200, body: { ok: true, ignored: "other_mode" } };
  const out = await handleEvent(event);
  return out.ok ? { status: 200, body: { ok: true, ...(out.duplicate ? { duplicate: true } : {}) } } : { status: 500, body: { error: "try again" } };
}

let timer = null;
/** Called once at boot: picks up what a restart cut off, then keeps checking. */
export function resume({ everyMs = 60_000 } = {}) {
  if (timer || mode() === "off") return;
  const go = () => sweep().catch(e => logFn({ flight_sweep_threw: String(e?.message ?? e).slice(0, 100) }));
  go();
  timer = setInterval(go, everyMs);
  timer.unref?.();
}
