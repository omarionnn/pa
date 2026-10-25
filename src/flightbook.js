// Booking a flight through AgentCard, with the person's approval before any money moves.
//
// Search is Fli's (src/flightsearch.js) and stays search-only. Booking is AgentCard's hosted purchase
// API — the same POST /buy loop, the same cart hash, the same `purchase_confirm`, the same confirm
// gate, the same caps and the same passkey approval as every other purchase (src/agentcard.js,
// src/tools.js). Nothing in this file talks to AgentCard or spends anything: it is the arithmetic and
// the words that sit between a flight cart and the person who has to agree to it.
//
// What the real AgentCard flight flow looks like, read off the sandbox on 2026-10-25 (recorded in
// test/fixtures/agentcard-flights/), because the public docs do not say:
//
//   - The merchant is the direct merchant `flights` ("Agentcard Flights", US/USD). GET /buy/merchants
//     lists its capabilities as checkout, clear_cart, clear_unbooked_cart, cancel_order and
//     vault_payment — and NOT track_order, which classes, hotels and reservations have.
//   - A search comes back `needs_input` with a catalog of offers (`off_…` ids, `ref` `p_…`), each with
//     a `flight` itinerary: legs of origin, destination, departureAt/arrivalAt as wall clock with no
//     zone, and cabinClasses. No flight numbers.
//   - A pick puts ONE line in the cart: the fare, as one number (`priceCents`). Then `serviceFeesCents`
//     ($4.33 on a $173.14 fare) with `merchantFeeLines: null` — one fee figure with no label. No tax
//     line. AgentCard's own reply calls the fee "the service fee for booking through here", not
//     refunded on cancellation, and says it does not know whether the fare includes taxes.
//   - `approvedCeilingCents` equals `totalCents` — the card is held for exactly the total — and the
//     cart has NO `totalIsEstimate` key at all. The SDK reads a missing key as false; here a missing
//     key is "not flagged", and the total is called final only when the ceiling equals it.
//   - `next_action: guest_details` asks for the passenger. Giving them does NOT change the cart hash
//     (7c6c48de6327c043 before and after), so AgentCard's hash does not pin who flies. The yes Reason
//     asks for therefore pins the travelers too (`travelerFingerprint`, in the confirm target).
//   - AgentCard keeps the passenger on ITS side ("Passenger details are saved"). So every booking
//     sends the travelers the person just confirmed, explicitly, and never leaves it to whatever
//     AgentCard kept from last time.
//   - No fare rules anywhere in the cart: asked, AgentCard said it had none for that fare.
//   - Sandbox stops at the confirm: `declined`, `decline_code: sandbox_mode`, `charge_status: none`.
//     So what a placed flight order carries — ticketing status, the airline's record locator, ticket
//     numbers — has never been seen. See TICKETING_FIELDS.
import { createHash } from "node:crypto";
import { config, clock } from "./config.js";

/** Is booking switched on for this install? Off: flights are searched and handed over as a link. */
export function bookingEnabled() {
  return !!config.flightBooking;
}

/** AgentCard's merchant slug for flights, as GET /buy/merchants and every flight cart name it. */
export const FLIGHTS_MERCHANT = "flights";

/** Is this cart (or catalog) a flight? By AgentCard's merchant slug — a field, never the words. */
export function isFlightCart(cart) {
  return String(cart?.merchant ?? "").trim().toLowerCase() === FLIGHTS_MERCHANT;
}

const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

// ---------- the price, exactly as the cart itemizes it ----------

/**
 * Is the cart's total one the person can be asked to approve?
 *
 * Final only when every piece of evidence agrees: AgentCard did not flag it as an estimate, AND it
 * names a hold ceiling equal to the total (the documented flight case: "a flight asks for exactly its
 * total"). A ceiling above the total means the store prices its final at checkout; no ceiling means
 * nothing says what the card can be held for. Either way there is no final number, and no approval
 * is asked for against it.
 */
export function totalFinality(cart) {
  if (!cart) return { final: false, why: "there is no cart" };
  if (cart.total_is_estimate) return { final: false, why: "AgentCard marks the total as an estimate — fees or tax are not priced yet" };
  if (cart.ceiling_cents == null) return { final: false, why: "AgentCard did not say the most the card can be held for, so the total cannot be called final" };
  if (cart.ceiling_cents !== cart.total_cents) {
    return { final: false, why: `AgentCard says the card can be held for up to ${money(cart.ceiling_cents)}, more than the ${money(cart.total_cents)} total, so the total is not final` };
  }
  return { final: true, why: `the card is held for exactly the total (${money(cart.total_cents)})` };
}

/**
 * The cart's own numbers, as the person is told them. Nothing here is Reason's arithmetic: every line
 * is a figure AgentCard sent, labelled the way it labelled it, and every gap is named as a gap.
 *
 * - The fare: each cart line, as one amount. AgentCard does not split a fare into base and tax.
 * - Fees: the store's own labelled lines when it sends them (`merchantFeeLines`); otherwise the one
 *   `serviceFeesCents` figure, said as unlabelled — never given a name it was not given.
 * - Taxes: a tax line only if one of the labelled lines is one; otherwise "not broken out".
 * - Fare rules: never in a cart, so always "not verified".
 */
export function priceView(cart) {
  if (!cart) return null;
  const fare = cart.items.map(i => ({ label: i.name || "fare", amount: money(i.price_cents * Math.max(1, i.qty)), cents: i.price_cents * Math.max(1, i.qty) }));
  const itemizedFees = cart.fee_lines.map(f => ({ label: f.label || "fee (no label)", amount: f.amount, cents: f.amount_cents }));
  const itemizedSum = itemizedFees.reduce((s, f) => s + f.cents, 0);
  const unknown = [];
  let fees;
  if (itemizedFees.length) {
    fees = { itemized: true, lines: itemizedFees };
    // Lines that do not add up to the fee figure leave a remainder nobody labelled. Said as that.
    if (cart.service_fees_cents && cart.service_fees_cents !== itemizedSum) {
      fees.unlabelled = { amount: money(cart.service_fees_cents - itemizedSum), cents: cart.service_fees_cents - itemizedSum };
    }
  } else if (cart.service_fees_cents > 0) {
    fees = { itemized: false, lines: [], unlabelled: { amount: money(cart.service_fees_cents), cents: cart.service_fees_cents } };
  } else {
    fees = { itemized: false, lines: [] };
  }
  // A tax line is one the store called tax. That reads the label AgentCard sent, which is a field and
  // not the person's words; nothing is ever guessed to be tax.
  const taxLines = itemizedFees.filter(f => /\btax(es)?\b/i.test(f.label));
  const taxes = taxLines.length
    ? { itemized: true, lines: taxLines }
    : { itemized: false, words: "not broken out — the cart does not say whether the fare includes taxes" };
  if (!taxLines.length) unknown.push("taxes (not broken out by the cart)");
  if (fees.unlabelled) unknown.push(`what the ${fees.unlabelled.amount} in fees is for (the cart gives it no label)`);
  unknown.push("fare rules — changes, cancellation, refunds, bags (the cart shows none)");
  const finality = totalFinality(cart);
  return {
    fare, fees, taxes,
    tip: cart.tip_cents ? money(cart.tip_cents) : "",
    total: cart.total, total_cents: cart.total_cents,
    final: finality.final, finality: finality.why,
    max_charge: cart.ceiling_cents == null ? "" : money(cart.ceiling_cents),
    currency: cart.currency || "",
    fare_rules: "not verified — AgentCard's cart shows no change, cancellation, refund or bag rules for this fare",
    unknown,
  };
}

/** The price view as the words that go in front of the person, one line per figure. */
export function priceLines(view) {
  if (!view) return [];
  const out = view.fare.map(f => `${f.label}: ${f.amount}`);
  for (const f of view.fees.lines) out.push(`${f.label}: ${f.amount}`);
  if (view.fees.unlabelled) out.push(`fees (AgentCard gives one figure, no breakdown): ${view.fees.unlabelled.amount}`);
  if (!view.taxes.itemized) out.push("taxes: not broken out by the cart");
  out.push(`total: ${view.total}${view.final ? " (final — the card is held for exactly this)" : " (NOT final)"}`);
  out.push(`fare rules: ${view.fare_rules}`);
  return out;
}

// ---------- the itinerary: is the cart the flight they picked? ----------

/** "2026-11-12T08:07:00" or "2026-11-12T08:07" → "2026-11-12T08:07", the wall clock to the minute. */
function minute(v) {
  const s = String(v ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  return m ? `${m[1]}T${m[2]}:${m[3]}` : "";
}

/**
 * Do AgentCard's legs describe the same flights as the option the person picked from the Fli search?
 *
 * Both sides are structured fields: AgentCard's `flight.legs` (origin, destination, wall-clock
 * departure and arrival) against the search option's legs (from, to, depart, arrive). Every leg has
 * to match on all four, in order. AgentCard sends no flight numbers, so two flights from the same
 * airports at the same minute cannot be told apart — that is said, not guessed past.
 */
export function itineraryMatches(acLegs, optionLegs) {
  const a = Array.isArray(acLegs) ? acLegs : [];
  const b = Array.isArray(optionLegs) ? optionLegs : [];
  if (!a.length || !b.length) return { match: false, why: "one side has no legs to compare" };
  if (a.length !== b.length) return { match: false, why: `AgentCard's itinerary has ${a.length} leg(s) and the one they picked has ${b.length}` };
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    const diffs = [];
    if (String(x.origin ?? "").toUpperCase() !== String(y.from ?? "").toUpperCase()) diffs.push(`from ${x.origin} vs ${y.from}`);
    if (String(x.destination ?? "").toUpperCase() !== String(y.to ?? "").toUpperCase()) diffs.push(`to ${x.destination} vs ${y.to}`);
    if (minute(x.departureAt) !== minute(y.depart)) diffs.push(`departs ${minute(x.departureAt) || "?"} vs ${minute(y.depart) || "?"}`);
    if (minute(x.arrivalAt) !== minute(y.arrive)) diffs.push(`arrives ${minute(x.arrivalAt) || "?"} vs ${minute(y.arrive) || "?"}`);
    if (diffs.length) return { match: false, why: `leg ${i + 1}: ${diffs.join(", ")}` };
  }
  return { match: true, why: "same airports and the same departure and arrival times on every leg (AgentCard sends no flight numbers)" };
}

/** The legs of one search option, flattened outbound then return, in the shape itineraryMatches reads. */
export function optionLegs(option) {
  const legsOf = (f) => (f?.legs ?? []).map(l => ({ from: l.from ?? l.origin, to: l.to ?? l.destination, depart: l.depart ?? l.departure, arrive: l.arrive ?? l.arrival }));
  return [...legsOf(option), ...legsOf(option?.return)];
}

/** AgentCard's catalog item for this option, if one of them flies exactly these legs. */
export function catalogMatch(catalogItems, option) {
  const want = optionLegs(option);
  return (catalogItems ?? []).find(i => i.flight && itineraryMatches(i.flight.legs, want).match) ?? null;
}

// ---------- travelers ----------

export const GENDERS = ["m", "f"];

/**
 * Check one traveler's details before they are kept. The fields are AgentCard's own
 * (buy_save_traveler, docs.agentcard.com, read 2026-10-24): legal given and family name as on the
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
 * one set of travelers cannot be spent on another — AgentCard's cart hash does not change when the
 * passenger does, so without this a corrected name would ride the old yes.
 */
export function travelerFingerprint(travelers) {
  const canon = (travelers ?? []).map(t => [t.given_name, t.family_name, t.born_on, t.gender, t.email, t.phone, t.known_traveler_number ?? "", t.redress_number ?? ""]
    .map(v => String(v ?? "").trim()).join("|")).join("\n");
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}

/** The passenger message AgentCard's `guest_details` step reads, built from confirmed details only. */
export function travelerAsk(travelers) {
  const one = (t, i) => `Passenger ${i + 1}: ${t.given_name} ${t.family_name} (legal name exactly as on the government ID), date of birth ${t.born_on},`
    + ` gender ${t.gender === "m" ? "male" : "female"}, email ${t.email}, phone ${t.phone}`
    + (t.known_traveler_number ? `, known traveler number ${t.known_traveler_number}` : "")
    + (t.redress_number ? `, redress number ${t.redress_number}` : "");
  return `${travelers.map(one).join(". ")}. Use exactly these passenger details for this booking — not any saved earlier.`;
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
 *   outcome_unknown     the confirm's answer never came back; nobody knows
 *   cancelled           placed and then cancelled
 */
export const BOOKING_STATES = ["quoted", "approval_pending", "payment_approved", "reserved", "ticketing_pending", "issued", "declined", "outcome_unknown", "cancelled"];

/**
 * Where AgentCard puts a flight order's ticketing evidence. EMPTY ON PURPOSE: no flight order has
 * ever been placed through this install, sandbox stops before payment, AgentCard's docs say nothing
 * about it, and the `flights` merchant does not even list `track_order`. A field name is added here
 * only from a real placed order's record or a real order.confirmed body (both are kept whole on the
 * row as `order_raw_json` for exactly that), with the date it was seen. Until then nothing is ever
 * read as a ticket, so nothing is ever called booked — the honest answer is "ticketing not confirmed".
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
  if (status === "declined" || status === "failed") return { state: "declined", booked: false, words: `it was not booked: AgentCard declined it${row?.decline_code ? ` (${row.decline_code})` : ""}. Nothing was charged.` };
  if (status === "outcome_unknown") return { state: "outcome_unknown", booked: false, words: "nobody knows yet whether it was booked: the confirm went out and no answer came back. It is not being retried." + airline };
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
