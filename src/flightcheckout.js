// Booking a flight through Crossmint's Agent Checkouts — the shopping path, with a flight's rules on it.
//
// Nothing here pays, and nothing here talks to Crossmint. A flight is a checkout on the airline's own
// website: `flight_book` (src/tools.js) starts it with shopconnect.startCheckout, and from there it is
// the shopping path whole — Crossmint's exact total, the confirm gate (shop_pay), the per-person daily
// cap, the Face ID approval, the order intent (src/shopconnect.js, src/passkey.js, src/spendcap.js).
// This file is what a flight adds to that, hooked in where src/food.js is:
//
//   - which airline site a searched flight is booked on, and the instruction that names the exact flights;
//   - which run is a flight, for whom (the confirmed travelers, by id, and their fingerprint);
//   - the passenger form answered from the sealed traveler record, never from the model's memory;
//   - the yes pinned to who flies (payTargetTail), and refused if a traveler changed since (payRefusal);
//   - an order the airline placed kept as a flight order that is NOT yet "booked": the e-ticket check
//     (src/ticketcheck.js) reads the person's own mail, and only a ticket number makes it booked.
//
// What a real run looks like (JetBlue's own site, one way JFK→BOS, 2026-11-11, stopped at the payment
// request and cancelled — recorded in test/fixtures/crossmint-flights/jetblue-pricecheck.json):
// 93 s to a question about which departure; 135 s to ONE passenger form (title, first and last name as
// on the ID, email, gender, date of birth MM/DD/YYYY, address, state, zip, phone); 226 s to a card
// payment request for an EXACT 118.40 USD at merchant "JetBlue". One number: no fare, tax or fee lines.
// What a placed order carries has not been seen (no flight has been bought): Crossmint documents a
// receipt total and, "when available", the merchant's order id — never a ticket number.
import * as db from "./db.js";
import { clock } from "./config.js";
import * as flightbook from "./flightbook.js";
import * as shipping from "./shipping.js";

/**
 * The airlines a flight is booked with, on their own sites, by the IATA code on the searched legs.
 * Only JetBlue has been run (above); the rest are the same kind of site and may answer with a block
 * (merchant.access_blocked, a human check) — the shopping path says so and nothing is charged.
 */
export const AIRLINES = {
  B6: { name: "JetBlue", key: "jetblue", url: "https://www.jetblue.com/" },
  DL: { name: "Delta", key: "delta", url: "https://www.delta.com/" },
  UA: { name: "United", key: "united", url: "https://www.united.com/" },
  AA: { name: "American Airlines", key: "aa", url: "https://www.aa.com/" },
  AS: { name: "Alaska Airlines", key: "alaskaair", url: "https://www.alaskaair.com/" },
  WN: { name: "Southwest", key: "southwest", url: "https://www.southwest.com/" },
  NK: { name: "Spirit", key: "spirit", url: "https://www.spirit.com/" },
  F9: { name: "Frontier", key: "flyfrontier", url: "https://www.flyfrontier.com/" },
  HA: { name: "Hawaiian Airlines", key: "hawaiianairlines", url: "https://www.hawaiianairlines.com/" },
};

const q = (sql) => db.db.prepare(sql);
db.db.exec(`CREATE TABLE IF NOT EXISTS flight_runs (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  search_id INTEGER NOT NULL,
  option INTEGER NOT NULL,
  traveler_ids TEXT NOT NULL DEFAULT '[]',
  traveler_fp TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '',
  what TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS flight_runs_by_conv ON flight_runs (conversation_id, created_at);`);

/** Every leg of a searched option, outbound then return. */
const allLegs = (opt) => [...(opt?.legs ?? []), ...(opt?.return?.legs ?? [])];

/** The one airline that flies every leg of this option, or null (two carriers are two bookings). */
export function airlineFor(opt) {
  const codes = [...new Set(allLegs(opt).map(l => String(l.airline ?? "").toUpperCase()).filter(Boolean))];
  return codes.length === 1 ? (AIRLINES[codes[0]] ? { code: codes[0], ...AIRLINES[codes[0]] } : null) : null;
}

const clockWords = (v) => String(v ?? "").replace("T", " at ").slice(0, 19);

/**
 * The instruction for the checkout: exactly these flights, by number and time, the cheapest standard
 * fare, nothing extra. NO passenger details: those are answered from the sealed record when the
 * airline's form asks (fill), so they are never kept in the run's instruction.
 */
export function taskFor(opt, { seats = 1, cabin = "economy", price = "" } = {}) {
  const legs = allLegs(opt).map(l => `${l.airline}${l.flight_number ?? ""} from ${l.from} to ${l.to}, departing ${clockWords(l.depart)}`).join("; then ");
  return `Book ${opt?.return ? "this round trip" : "this one-way flight"} for ${seats} adult${seats === 1 ? "" : "s"}: ${legs}.`
    + ` Exactly these flights, by flight number and time — if any is not offered, stop and say so; never pick another.`
    + ` The lowest standard ${cabin} fare${price ? ` (it was ${price} when searched)` : ""}. No paid seat, no bags, no insurance, no extras, no upgrade, no loyalty sign-up; continue as a guest. Pay by card.`;
}

/** The short name of the trip, for the payment ask and the record. */
export function itemFor(opt, travelers) {
  const legs = allLegs(opt); const a = legs[0] ?? {}; const z = (opt?.legs ?? []).at(-1) ?? {};
  const flights = String(opt?.flights || `${a.airline ?? ""}${a.flight_number ?? ""}`);
  return `${flights}${flights.includes("→") ? "" : ` ${a.from}→${z.to}`} ${String(a.depart ?? "").slice(0, 10)}${opt?.return ? " round trip" : ""}, for ${travelers.map(t => t.label).join(" & ")}`.slice(0, 120);
}

// ---------- which run is a flight ----------

export function linkRun({ conversationId, runId, searchId, option, travelerIds, travelerFp, carrier = "", what = "" }) {
  q("INSERT OR REPLACE INTO flight_runs (run_id, conversation_id, search_id, option, traveler_ids, traveler_fp, carrier, what, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(runId, conversationId, searchId, option, JSON.stringify(travelerIds), travelerFp, carrier, what, clock.now());
}
/** A checkout the shopping path started again (a sign-in wall, a corrected address) is the same flight. */
export function relinkRun(oldRunId, newRunId, conversationId) {
  const f = flightRun(oldRunId, conversationId);
  if (f && newRunId) q("INSERT OR IGNORE INTO flight_runs (run_id, conversation_id, search_id, option, traveler_ids, traveler_fp, carrier, what, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(newRunId, f.conversation_id, f.search_id, f.option, f.traveler_ids, f.traveler_fp, f.carrier, f.what, clock.now());
}
/** A flight's run, read by the person it belongs to and nobody else. */
export function flightRun(runId, conversationId) { return q("SELECT * FROM flight_runs WHERE run_id = ? AND conversation_id = ?").get(runId, conversationId ?? "") ?? null; }
export const isFlightRun = (runId, conversationId) => !!flightRun(runId, conversationId);

/** The run's travelers as they are on record NOW, in order; null when one is gone. */
function travelersOf(f) {
  let ids = [];
  try { ids = JSON.parse(f?.traveler_ids || "[]"); } catch { ids = []; }
  const rows = ids.map(id => db.getFlightTraveler(f.conversation_id, id));
  return ids.length && rows.every(Boolean) ? rows : null;
}

// ---------- the yes: pinned to who flies ----------

/** Appended to the payment's confirm target (shopconnect.payTarget): a yes for these travelers only. */
export function payTargetTail(row) {
  const f = row ? flightRun(row.run_id, row.conversation_id) : null;
  return f ? ` travelers [${f.traveler_fp || "none"}]` : "";
}

/**
 * Why a flight's payment must not go out — or null. Checked on both approval paths, before the cap,
 * the order intent or anything else (shopconnect.payRow). Booking switched off since the price was
 * built, or a traveler corrected or removed since: the airline's form already holds the old details,
 * so this checkout is not what they are agreeing to.
 */
export function payRefusal(row) {
  const f = row ? flightRun(row.run_id, row.conversation_id) : null;
  if (!f) return null;
  if (!flightbook.bookingEnabled(f.conversation_id)) {
    return { ok: false, error: "not_available", say: "Reason doesn't book flights here, so nothing was paid. Hand over the Google Flights link from the search instead." };
  }
  const now = travelersOf(f);
  if (!now || flightbook.travelerFingerprint(now) !== f.traveler_fp) {
    return { ok: false, error: "travelers_changed", say: "A traveler's details changed after this booking was started, and the airline's form has the old ones. Nothing was paid. Decline this payment, then call flight_book again so the booking is built with the corrected details." };
  }
  return null;
}

// ---------- the passenger form, from the sealed record ----------

const US_DATE = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "")); return m ? `${m[2]}/${m[3]}/${m[1]}` : ""; };

/** One traveler's value for one of the airline's fields, or "" when the field is not about a traveler. */
function travelerValue(f, t) {
  const s = `${f?.key ?? ""} ${f?.label ?? ""}`.toLowerCase();
  const input = f?.input ?? {};
  const choice = (re) => {
    const o = (input.options ?? []).find(o => !o.disabled && re.test(`${o.label ?? ""} ${o.value ?? ""}`.toLowerCase().trim()));
    return o ? o.value : "";
  };
  if (/\btitle\b|salutation|prefix/.test(s)) return input.kind === "choice" ? choice(t.gender === "m" ? /^mr\b/ : /^ms\b/) : (t.gender === "m" ? "Mr" : "Ms");
  if (/gender|\bsex\b/.test(s)) return input.kind === "choice" ? choice(t.gender === "m" ? /^(m|male)\b/ : /^(f|female)\b/) : (t.gender === "m" ? "Male" : "Female");
  if (/birth|\bdob\b/.test(s)) {
    if (input.kind === "choice") return "";
    return /yyyy-mm-dd/i.test(`${f.label ?? ""} ${input.placeholder ?? ""}`) ? t.born_on : US_DATE(t.born_on);
  }
  if (/known.?traveler|\bktn\b|precheck/.test(s)) return t.known_traveler_number ?? "";
  if (/redress/.test(s)) return t.redress_number ?? "";
  if (input.kind === "choice") return "";
  if (/middle/.test(s)) return "";
  // Before the address roles: "Email address (…)" is an email, not a street.
  if (/e-?mail/.test(s)) return t.email;
  if (/phone|mobile|\btel\b/.test(s)) return t.phone;
  const role = shipping.roleOf(f);
  if (role === "first_name") return t.given_name;
  if (role === "last_name") return t.family_name;
  if (role === "full_name") return `${t.given_name} ${t.family_name}`;
  if (role === "email") return t.email;
  if (role === "phone") return t.phone;
  return "";
}

/**
 * The airline's form, answered from the run's confirmed traveler and, for the contact address, their
 * shipping record (`base` is shipping.fill's answer for the same form). One traveler only: a form for
 * several passengers names them in ways code should not guess at, so it goes to the model, which has
 * flight_travelers to read from. `covered` only when every required field has an answer.
 */
export function fill(run, rq, base) {
  const f = flightRun(run?.run_id, run?.conversation_id);
  const travelers = f ? travelersOf(f) : null;
  // Booking switched off since this checkout started: no passenger detail leaves the record.
  if (f && !flightbook.bookingEnabled(f.conversation_id)) return base;
  if (!f || !travelers || travelers.length !== 1) return base;
  const t = travelers[0];
  const fields = Array.isArray(rq?.fields) ? rq.fields : [];
  const answers = {}; const filled = []; const missing = []; let ours = 0;
  for (const fld of fields) {
    if (!fld?.key || fld.handling === "protected") { if (fld?.required) missing.push({ key: fld?.key ?? "", label: fld?.label ?? fld?.key ?? "", ours: false }); continue; }
    const mine = travelerValue(fld, t);
    const v = mine || (base?.answers?.[fld.key] ?? "");
    if (mine) ours++;
    if (v) { answers[fld.key] = v; filled.push(fld.key); }
    else if (fld.required) missing.push({ key: fld.key, label: fld.label || fld.key, ours: false });
  }
  if (!ours) return base;   // not a passenger form (a seat, a fare choice): the shopping path's own answer stands
  return {
    ...base, answers, filled, missing, covered: missing.length === 0 && filled.length > 0,
    say: `Gave ${AIRLINES[f.carrier]?.name ?? "the airline"} ${t.label}'s details as you confirmed them. Say if that's wrong.`,
  };
}

// ---------- after the airline placed the order ----------

/** The flight order's key in the flight order record (the table the AgentCard route left: agentcard_purchases). */
export const orderKey = (runId) => `crossmint:${runId}`;

/**
 * The airline confirmed the purchase. Kept as a flight order in the one flight order record, in the
 * state it is really in — placed, ticket NOT confirmed — so the e-ticket check watches their mail for
 * it and the purchases note says it honestly. Returns the one line to text. Never "booked".
 */
export function placed(run, { orderRef = "", amountCents = 0 } = {}) {
  const f = flightRun(run.run_id, run.conversation_id);
  if (!f) return null;
  const key = orderKey(run.run_id);
  const airline = AIRLINES[f.carrier]?.name ?? "the airline";
  db.recordAgentcardPurchase({ conversationId: f.conversation_id, buyConversationId: key, status: "placed", amountCents, merchant: airline, what: f.what });
  db.markAgentcardPurchase(key, {
    kind: "flight", travelerIds: f.traveler_ids, travelerFp: f.traveler_fp, ticketingState: "ticketing_pending",
    flightJson: JSON.stringify({ search_id: f.search_id, option: f.option, carrier: f.carrier, via: "crossmint", run_id: run.run_id }),
    ...(orderRef ? { retailerOrderId: orderRef } : {}),
  });
  const mail = (() => { try { return db.listOauthTokens(f.conversation_id, "google").length > 0; } catch { return false; } })();
  return `${airline} took the order${orderRef ? ` (confirmation ${orderRef})` : ""} for ${f.what}: that is not a ticket yet. `
    + (mail ? "I'm watching your email for the e-ticket and will send the ticket number when it lands." : `I can't see your email, so check ${airline}'s confirmation email for the ticket number before relying on it.`);
}
