// What a flight booking is made of, kept apart from whoever ends up doing the booking.
//
// There is NO booking route today. Search is src/flightsearch.js and stays search-only: a flight is
// handed over as its Google Flights link. AgentCard's flight route (flight_book, built on its hosted
// purchase API) was removed on 2026-11-11 — the owner's decision: Reason does not use AgentCard, and
// Crossmint is the only buy route. Whether Crossmint's Agent Checkouts can book a flight has not been
// proven with a real run (docs/flight-booking.md says what was read and what is still needed), so no
// Crossmint flight route is built on a guess.
//
// What stays is everything a route will reuse, and nothing here talks to a provider or spends money:
//   - the switch (REASON_FLIGHT_BOOKING: off | owner | on) and the route it also needs;
//   - travelers: the checks, the read-back, the fingerprint that pins a yes to exactly who flies;
//   - the booking states, where only an issued ticket is "booked";
//   - the approval window and the age of a quote.
// The e-ticket check in the person's own Gmail is src/ticketcheck.js.
import { createHash } from "node:crypto";
import { config, clock } from "./config.js";
import * as accounts from "./accounts.js";

/**
 * The provider that books a flight, or null. Null today, so booking is off for everyone whatever the
 * flag says. A route that is built and proven names itself here.
 */
let route = null;
export function bookingRoute() { return route; }
/** Tests only: stand a route in, so the parts a route will reuse can be driven. */
export function _setRoute(name) { route = name ? String(name) : null; }

/**
 * Is booking switched on in this conversation? Only with a booking route AND the flag:
 * `REASON_FLIGHT_BOOKING=owner` is the owner's own conversation only (the same operator check the
 * dark invites use) and exactly off for everyone else; 1/true/on/yes is everyone. Off: flights are
 * searched and handed over as a link, no traveler tool is shown or runs, and no mail is read.
 */
export function bookingEnabled(conversationId) {
  if (!route) return false;
  if (config.flightBooking === "owner") return accounts.featureOwner(conversationId);
  return !!config.flightBooking;
}

/**
 * AgentCard's merchant slug for flights. Kept for one reason: AgentCard's general shopping can still
 * hand back a flight cart on its own, and the purchase tools refuse one by this field (src/tools.js).
 */
export const FLIGHTS_MERCHANT = "flights";

/** Is this AgentCard cart (or catalog) a flight? By its merchant slug — a field, never the words. */
export function isFlightCart(cart) {
  return String(cart?.merchant ?? "").trim().toLowerCase() === FLIGHTS_MERCHANT;
}

// ---------- travelers ----------

export const GENDERS = ["m", "f"];

/**
 * Check one traveler's details before they are kept: legal given and family name as on the
 * government ID, date of birth YYYY-MM-DD, gender m/f as on the ID (a Secure Flight requirement),
 * contact email and an E.164 phone. A known-traveler number and a redress number are optional.
 */
export function travelerProblems(t, { today = new Date(clock.now()).toISOString().slice(0, 10) } = {}) {
  const out = [];
  if (!String(t.given_name ?? "").trim()) out.push("given_name (legal first name, as on their ID)");
  if (!String(t.family_name ?? "").trim()) out.push("family_name (legal last name, as on their ID)");
  const dob = String(t.born_on ?? "");
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(`${dob}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob) out.push("born_on (date of birth, YYYY-MM-DD)");
  else if (dob > today) out.push("born_on is in the future");
  if (!GENDERS.includes(String(t.gender ?? ""))) out.push("gender ('m' or 'f', as on the ID)");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(t.email ?? ""))) out.push("email (the booking's contact address)");
  if (!/^\+[1-9]\d{6,14}$/.test(String(t.phone ?? ""))) out.push("phone (E.164, like +14155550100)");
  return out;
}

/** How long "those are right" covers a traveler for: one booking's worth, never a standing yes. */
export const TRAVELER_CONFIRM_MS = 60 * 60_000;

/** The read-back: everything kept for one traveler, in the order a person checks it. */
export function readBack(t) {
  return [
    `${t.given_name} ${t.family_name}`,
    `born ${t.born_on}`,
    `gender on ID: ${t.gender === "m" ? "M" : "F"}`,
    `email ${t.email}`,
    `phone ${t.phone}`,
    ...(t.known_traveler_number ? [`known traveler number ${t.known_traveler_number}`] : []),
    ...(t.redress_number ? [`redress number ${t.redress_number}`] : []),
  ].join(", ");
}

/**
 * A short fingerprint of exactly who is flying, in order. It goes in the confirm target, so a yes for
 * one set of travelers cannot be spent on another — a provider's cart or price reference need not
 * change when the passenger does (AgentCard's did not), so without this a corrected name would ride
 * the old yes.
 */
export function travelerFingerprint(travelers) {
  const canon = (travelers ?? []).map(t => [t.given_name, t.family_name, t.born_on, t.gender, t.email, t.phone, t.known_traveler_number ?? "", t.redress_number ?? ""]
    .map(v => String(v ?? "").trim()).join("|")).join("\n");
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}

// ---------- after the money: where the booking really is ----------

/**
 * The states a flight booking is in, kept apart in the record and in the words. The spec's rule: a
 * payment approval, a charge, an "order placed" and even an airline record locator can each exist
 * with no ticket issued. Only `issued` is "booked".
 *
 *   quoted              a cart exists; nothing is held, nothing approved, nothing charged
 *   approval_pending    the confirm paused for their passkey; nothing charged
 *   payment_approved    they approved on their device; no order reported yet
 *   reserved            the provider reports a hold on the seats (never seen from AgentCard)
 *   ticketing_pending   AgentCard placed the order (and may have charged); no ticket confirmed
 *   issued              a ticketed status WITH ticket numbers, read from the provider
 *   declined            refused before any charge
 *   expired             the approval ran out before it was given; nothing charged
 *   outcome_unknown     the confirm's answer never came back; nobody knows
 *   cancelled           placed and then cancelled
 */
export const BOOKING_STATES = ["quoted", "approval_pending", "payment_approved", "reserved", "ticketing_pending", "issued", "declined", "expired", "outcome_unknown", "cancelled"];

/**
 * Where a provider's order record puts a flight's ticketing evidence. EMPTY ON PURPOSE: no flight
 * order has ever been placed through this install. A field name is added here only from a real
 * placed order's record (kept whole on the row as `order_raw_json` for exactly that), with the date
 * it was seen. Until then nothing in a provider's record is ever read as a ticket, so nothing is
 * called booked on its say-so — only the e-ticket email (src/ticketcheck.js) can.
 *
 *   status:  [{ field, issued: [values that mean ticketed], reserved: [values that mean a hold] }]
 *   tickets: [field]  — an array of e-ticket numbers
 *   locator: [field]  — the airline's record locator (PNR). A locator alone is never a ticket.
 */
export const TICKETING_FIELDS = { status: [], tickets: [], locator: [] };

const pathGet = (obj, path) => String(path).split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

/**
 * The ticketing evidence in one raw order record or webhook body, read only under TICKETING_FIELDS.
 * `fields` is injectable so the mapping can be proved before the real names are known.
 */
export function ticketingFrom(raw, fields = TICKETING_FIELDS) {
  const out = { issued: false, reserved: false, status: "", ticket_numbers: [], locator: "" };
  if (!raw || typeof raw !== "object") return out;
  for (const s of fields.status ?? []) {
    const v = pathGet(raw, s.field);
    if (v == null || v === "") continue;
    const val = String(v).trim().toLowerCase();
    out.status = String(v);
    if ((s.issued ?? []).map(x => String(x).toLowerCase()).includes(val)) out.issued = true;
    if ((s.reserved ?? []).map(x => String(x).toLowerCase()).includes(val)) out.reserved = true;
  }
  for (const f of fields.tickets ?? []) {
    const v = pathGet(raw, f);
    if (Array.isArray(v)) out.ticket_numbers.push(...v.map(x => String(typeof x === "object" && x ? (x.number ?? x.unique_identifier ?? "") : x)).filter(Boolean));
  }
  for (const f of fields.locator ?? []) {
    const v = pathGet(raw, f);
    if (v && !out.locator) out.locator = String(v);
  }
  return out;
}

/**
 * One flight purchase row, as the state it is really in and the words to say it in.
 *
 * `ticketing` is ticketingFrom's read of the provider's own record. `issued` needs a ticketed status
 * AND at least one ticket number: a status alone, a charge, an order id or a locator never makes it.
 */
export function bookingState(row, { ticketing = null } = {}) {
  const t = ticketing ?? { issued: false, reserved: false, status: "", ticket_numbers: [], locator: "" };
  const status = String(row?.status ?? "");
  const code = row?.retailer_order_id ? ` The confirmation code AgentCard passed on is ${row.retailer_order_id} — that is not a ticket.` : "";
  const locatorIs = t.locator ? ` The airline's record locator is ${t.locator}` : "";
  const locator = t.locator ? `${locatorIs} — that is not a ticket on its own.` : "";
  const airline = " Check with the airline directly (its app or website, with the record locator if there is one) before relying on this booking.";
  if (status === "cancelled") return { state: "cancelled", booked: false, words: "the booking was cancelled — there is no flight." };
  if ((status === "declined" || status === "failed") && row?.decline_code === "approval_expired") {
    return { state: "expired", booked: false, words: "it was not booked: the approval ran out before it was given. Nothing was charged, and that cart is not retried." };
  }
  if (status === "declined" || status === "failed") return { state: "declined", booked: false, words: `it was not booked: AgentCard declined it${row?.decline_code ? ` (${row.decline_code})` : ""}. Nothing was charged.` };
  if (status === "outcome_unknown") return { state: "outcome_unknown", booked: false, words: "nobody knows yet whether it was booked: the confirm went out and no answer came back. It is not being retried." + airline };
  // The e-ticket email (src/ticketcheck.js) is evidence on its own: a ticket number printed for one of
  // the order's passengers, on this route and day, means the airline issued it — even when AgentCard
  // has not reported the order placed yet. Never a locator alone.
  const fromEmail = t.from_email && t.issued && t.ticket_numbers.length;
  if (fromEmail && (status === "placed" || status === "partially_placed" || (status === "awaiting_approval" && row?.authorization_state === "approved"))) {
    return { state: "issued", booked: true, ticket_numbers: t.ticket_numbers, locator: t.locator, words: `booked — the ticket is issued: e-ticket${t.ticket_numbers.length > 1 ? "s" : ""} ${t.ticket_numbers.join(", ")}${t.locator ? `, confirmation ${t.locator}` : ""}, read off the airline's e-ticket email in their own mail.` };
  }
  if (status === "placed" || status === "partially_placed") {
    if (t.issued && t.ticket_numbers.length) {
      return { state: "issued", booked: true, ticket_numbers: t.ticket_numbers, locator: t.locator, words: `booked — the ticket is issued (ticket number${t.ticket_numbers.length > 1 ? "s" : ""} ${t.ticket_numbers.join(", ")}).${locatorIs ? `${locatorIs}.` : ""}` };
    }
    if (t.reserved) return { state: "reserved", booked: false, words: `the seats are held, and no ticket has been issued.${locator}${code}${airline}` };
    const charged = row?.charge_status === "settled" ? "the payment went through" : "AgentCard placed the order (the charge may still be settling)";
    return {
      state: "ticketing_pending", booked: false,
      words: `${charged}, and ticketing is not confirmed — AgentCard has not reported an issued ticket.${locator}${code}${airline}`,
    };
  }
  if (status === "awaiting_approval") {
    if (row?.authorization_state === "approved") return { state: "payment_approved", booked: false, words: "they approved the payment on their device; AgentCard has not placed an order yet. Not booked." };
    return { state: "approval_pending", booked: false, words: "waiting for their approval on their own device. Nothing has been charged and nothing is booked." };
  }
  return { state: "quoted", booked: false, words: "a price and a cart, nothing more: nothing is held, approved, charged or booked." };
}

// ---------- the approval window ----------

/** True when the approval link AgentCard handed out has run out (approval_expires_at in the past). */
export function approvalExpired(row, now = clock.now()) {
  const at = Number(row?.approval_expires_at ?? 0);
  return at > 0 && at <= now;
}

/** How old a flight quote may be when the yes is turned into a confirm. Past it: quote again. */
export function quoteFresh(row, now = clock.now()) {
  const at = Number(row?.quote_checked_at ?? 0);
  return at > 0 && now - at <= config.flightQuoteMaxAgeMs;
}
