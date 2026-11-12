// Paid events (owner decisions 2026-11-11): an organizer sets a price per person, guests pay on
// Stripe's hosted Checkout page (Apple Pay included) and are on the event only once Stripe's webhook
// says the payment landed. The money goes to the organizer's own Stripe Express account; Reason is the
// platform and never holds funds (destination charges). Everything about tickets lives here: the
// quote, the Connect account, the Checkout Session, the 15-minute hold on a spot, the webhook, the
// refunds and the sweep that lets a hold go.
//
// How the money splits, per person, for a price P:
//   - the guest pays P plus Stripe's processing (2.9% + 30¢ of the total, so that P is what is left
//     once Stripe has been paid) — shown as one "Processing" line on the Checkout page;
//   - the organizer gets P less Reason's 2.5% of P;
//   - Reason's application fee is the total less what the organizer gets: Stripe's processing comes
//     out of it, and the 2.5% of P stays.
// What a refund gives back depends on who asked (owner decision 2026-11-11, refundSplit): the
// organizer's refund or a cancelled event gives the guest the whole total back (the transfer is
// reversed and the application fee refunded, so Reason eats the processing Stripe keeps); a guest's
// own cancel gives the ticket price back — Stripe keeps its processing, the guest is told so first,
// the transfer is reversed by the price and Reason's 2.5% goes back to the organizer, who ends with
// nothing for that ticket either way. Nothing about a payment is ever decided from a page or a text: a spot is held when a
// Checkout Session is made, and the join itself happens in `settlePaid`, from the webhook.
//
// Switch: REASON_PAID_EVENTS (off | owner | on), like REASON_EVENTS — who may put a price on an
// event they organize. An event that already has a price keeps it whatever the switch says, so a
// switch turned off never makes a paid event free.
//
// Env (names only): the same STRIPE_SECRET_KEY as the subscription (src/stripe.js). Connect webhooks
// (account.updated) arrive signed with the endpoint that has "listen to connected accounts" on; when
// that is a second endpoint, its secret is STRIPE_CONNECT_WEBHOOK_SECRET (src/http.js tries both).
import { createHash } from "node:crypto";
import * as db from "./db.js";
import * as stripe from "./stripe.js";
import * as accounts from "./accounts.js";
import * as events from "./events.js";
import * as eventonb from "./eventonboarding.js";
import { config, clock } from "./config.js";

export const APP_FEE_BPS = 250;          // Reason's 2.5% of the ticket price
export const STRIPE_RATE_BPS = 290;      // Stripe's 2.9%…
export const STRIPE_FIXED_CENTS = 30;    // …+ 30¢, paid by the guest
export const MIN_PRICE_CENTS = 500;
export const MAX_PRICE_CENTS = 50000;
/** How long a spot is held while a Checkout page is open. After this the hold is released and the page is expired. */
export const HOLD_MS = 15 * 60_000;
/** Stripe will not take an expires_at under 30 minutes; the sweep expires the session itself at HOLD_MS. */
const STRIPE_MIN_EXPIRES_MS = 31 * 60_000;

db.db.exec(`
  CREATE TABLE IF NOT EXISTS event_payout_accounts (
    conversation_id TEXT PRIMARY KEY,
    stripe_account_id TEXT NOT NULL UNIQUE,
    charges_enabled INTEGER NOT NULL DEFAULT 0,
    details_submitted INTEGER NOT NULL DEFAULT 0,
    payouts_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    instagram TEXT,
    in_directory INTEGER NOT NULL DEFAULT 0,
    via TEXT NOT NULL DEFAULT 'text',
    price_cents INTEGER NOT NULL,
    processing_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    application_fee_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    checkout_session_id TEXT UNIQUE,
    checkout_url TEXT NOT NULL DEFAULT '',
    payment_intent_id TEXT,
    refund_id TEXT,
    refund_error TEXT,
    refund_attempts INTEGER NOT NULL DEFAULT 0,
    -- the join page's / the text's answers to the organizer's questions (src/eventquestions.js), filed on the join
    answers TEXT,
    -- the event's refund policy when this ticket was bought (see refundWindow): a later tightening never reaches it
    refund_policy TEXT,
    refund_hours INTEGER,
    -- open (a spot is held while the Checkout page is open) | expired | paid | refunded | failed
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    paid_at INTEGER,
    refunded_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_payments_event ON event_payments (event_id, status);
  CREATE INDEX IF NOT EXISTS event_payments_person ON event_payments (conversation_id, event_id);
  CREATE INDEX IF NOT EXISTS event_payments_intent ON event_payments (payment_intent_id);
`);
const q = (sql) => db.db.prepare(sql);
// Tables made before refund policies (2026-11-11) get the two columns; before buy-for-friends, the
// quantity (tickets in this one payment; every amount column is PER TICKET) and what of it went back.
// refunded_cents: what went back to the card, all tickets together (a guest's own cancel is the price,
// not the total); fee_back_*: Reason's 2.5% owed back to the organizer after a guest's own cancel, and
// the key's sequence (feeBack).
for (const [col, decl] of [["refund_policy", "TEXT"], ["refund_hours", "INTEGER"], ["quantity", "INTEGER NOT NULL DEFAULT 1"], ["refunded_cents", "INTEGER NOT NULL DEFAULT 0"], ["fee_back_owed_cents", "INTEGER NOT NULL DEFAULT 0"], ["fee_back_seq", "INTEGER NOT NULL DEFAULT 0"], ["fee_back_pending_cents", "INTEGER NOT NULL DEFAULT 0"], ["refund_pending", "TEXT"]]) {
  if (!db.db.prepare("PRAGMA table_info(event_payments)").all().some(c => c.name === col)) db.db.exec(`ALTER TABLE event_payments ADD COLUMN ${col} ${decl}`);
}

// ---------- buy for friends: one seat per ticket (owner decision 2026-11-11) ----------
//
// A buyer may get up to ticketMax(ev) tickets in one Checkout (quantity N, the same per-ticket price
// and processing). Every ticket is a SEAT row once the payment lands: seat 0 is the buyer's own (they
// are on the event with it), seats 1..N-1 are handed to friends. A friend is never a "+1" on the
// buyer: they claim their seat from its link — their own name, their own number (the same proof by
// text as any page join), the organizer's required questions — and are then a guest like any other,
// with their own spot, texts and page. Until claimed a seat holds its place under the cap.
//
// The claim link's secret (`claim_token`, 24 random bytes) works once: claiming spends it (NULL),
// a reassign replaces it and bumps `version` (a claim begun on the old link fails), a refund drops it.
// Somebody already on the event, the organizer, or somebody taken off it can't claim one.
//
// Refunds are per seat: the buyer gives back a seat nobody claimed (under the event's refund policy),
// a friend gives back the seat they claimed (the money goes to the buyer's card: they paid), the
// organizer refunds any seat. Each is a partial refund of the buyer's one payment — the transfer and
// Reason's fee are reversed in proportion, which is exactly one ticket's share. A cancellation
// refunds every payment in full.
// Whether this boot makes the seats table: only then are the payments from before seats given theirs.
const seatsNew = !q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_seats'").get();
db.db.exec(`
  CREATE TABLE IF NOT EXISTS event_seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    seat_no INTEGER NOT NULL,
    -- the buyer: who paid, and whose card any refund of this seat goes back to
    conversation_id TEXT NOT NULL,
    -- who is on the event with this seat: the buyer for seat 0, the friend once claimed
    holder_conversation_id TEXT,
    -- open (paid, nobody has claimed it) | claimed | refunded
    state TEXT NOT NULL DEFAULT 'open',
    claim_token TEXT UNIQUE,
    version INTEGER NOT NULL DEFAULT 1,
    -- the one text Reason may send a friend the buyer named (only somebody Reason can already text)
    invite_conversation_id TEXT,
    invite_state TEXT,
    invite_due_at INTEGER,
    invited_at INTEGER,
    refunding_at INTEGER,
    refund_id TEXT,
    refund_error TEXT,
    refund_attempts INTEGER NOT NULL DEFAULT 0,
    refund_why TEXT,
    refunded_at INTEGER,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (payment_id, seat_no)
  );
  CREATE INDEX IF NOT EXISTS event_seats_event ON event_seats (event_id, state);
  CREATE INDEX IF NOT EXISTS event_seats_holder ON event_seats (holder_conversation_id, event_id);
`);
// Payments from before seats: each is one ticket, the buyer's own (claimed while paid, refunded once refunded).
// Once, when the table is made: after that a payment with no seats is one that never got anybody in (it
// landed with no room, or for somebody already in), and a seat 0 made for it on a later boot would count a
// sale that never happened and turn its whole refund into one ticket's (review 2026-11-11).
if (seatsNew) db.db.exec(`INSERT INTO event_seats (payment_id, event_id, seat_no, conversation_id, holder_conversation_id, state, refund_id, refunded_at, claimed_at, created_at, updated_at)
  SELECT p.id, p.event_id, 0, p.conversation_id, p.conversation_id, CASE p.status WHEN 'paid' THEN 'claimed' ELSE 'refunded' END,
    p.refund_id, p.refunded_at, p.paid_at, COALESCE(p.paid_at, p.created_at), p.updated_at
  FROM event_payments p WHERE p.status IN ('paid', 'refunded') AND NOT EXISTS (SELECT 1 FROM event_seats s WHERE s.payment_id = p.id)`);
// Unclaimed seats hold their places for every join (db.addAttendeeTx).
db.setReservedPlaces((eventId) => unclaimedSeats(eventId));

export const DEFAULT_TICKET_MAX = 4;
export const TICKET_MAX_LIMIT = 10;
/** How many tickets one buyer may get at once on this event: the organizer's number, else 4. 1 = no extra tickets. */
export function ticketMax(ev) {
  const n = Number(ev?.ticket_max);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, TICKET_MAX_LIMIT) : DEFAULT_TICKET_MAX;
}

export function seatById(id) {
  return q("SELECT * FROM event_seats WHERE id = ?").get(Number(id)) ?? null;
}
/** The open seat a claim link opens, or null (claimed, refunded, reassigned, made up). */
export function seatByToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return q("SELECT * FROM event_seats WHERE claim_token = ? AND state = 'open'").get(token) ?? null;
}
export function seatsOfPayment(paymentId) {
  return q("SELECT * FROM event_seats WHERE payment_id = ? ORDER BY seat_no").all(Number(paymentId));
}
/** Places held by tickets bought for friends who haven't claimed them. */
export function unclaimedSeats(eventId) {
  return Number(q("SELECT COUNT(*) AS n FROM event_seats s JOIN event_payments p ON p.id = s.payment_id WHERE s.event_id = ? AND s.state = 'open' AND p.status = 'paid'").get(Number(eventId)).n);
}
/** The tickets a buyer got for friends on this event (seat 1 up), with who holds each. Refunded ones left out. */
export function friendSeats(eventId, buyerConversationId) {
  return q(`SELECT s.* FROM event_seats s JOIN event_payments p ON p.id = s.payment_id
    WHERE s.event_id = ? AND s.conversation_id = ? AND s.seat_no > 0 AND s.state != 'refunded' AND p.status = 'paid' ORDER BY s.payment_id, s.seat_no`).all(Number(eventId), String(buyerConversationId ?? ""));
}
/** Every unclaimed seat on the event, for the organizer. */
export function openSeats(eventId) {
  return q(`SELECT s.* FROM event_seats s JOIN event_payments p ON p.id = s.payment_id
    WHERE s.event_id = ? AND s.state = 'open' AND p.status = 'paid' ORDER BY s.payment_id, s.seat_no`).all(Number(eventId));
}
/** The claim link a buyer forwards. Only while the seat is open. */
export function seatUrl(ev, seat) {
  return seat?.state === "open" && seat.claim_token ? `${events.eventUrl(ev)}/seat/${seat.claim_token}` : null;
}
/** What a buyer's name reads as to the friend they got a ticket for. */
export function buyerName(ev, seat) {
  const att = db.attendeeRow(ev.id, seat.conversation_id);
  const acct = db.getAccount(seat.conversation_id);
  return String(att?.display_name || acct?.name || "A friend").slice(0, 40);
}

// ---------- the switch ----------

/** Can anybody put a price on an event here at all? */
export function paidEventsOn() {
  return config.paidEvents === true || config.paidEvents === "owner";
}

/** May this conversation price the events it organizes? `owner`: the owner alone. */
export function canPrice(conversationId) {
  if (!paidEventsOn() || !stripe.env().secretKey) return false;
  if (config.paidEvents === "owner") return accounts.featureOwner(conversationId, "paidEvents");
  return config.paidEvents === true;
}

/** Does this event cost something to join? Read off the row alone: a switch turned off never makes a paid event free. */
export function priced(ev) {
  return !!ev && Number(ev.price_cents ?? 0) > 0;
}

// ---------- the quote ----------

/** "$25" or "$26.03": whole dollars without the cents. */
export function dollars(cents) {
  const s = (Math.round(Number(cents)) / 100).toFixed(2);
  return `$${s.endsWith(".00") ? s.slice(0, -3) : s}`;
}

/** "25", "$25", "25.50" → cents, or null when it isn't a money amount. */
export function parseDollars(text) {
  const m = /^\s*\$?\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function priceProblem(cents) {
  if (!Number.isInteger(cents)) return "bad_price";
  if (cents < MIN_PRICE_CENTS) return "too_low";
  if (cents > MAX_PRICE_CENTS) return "too_high";
  return null;
}

/**
 * The split for one ticket at `priceCents`. The total is the smallest whole-cent amount that, once
 * Stripe has taken 2.9% + 30¢ of it, leaves at least the price; the organizer gets the price less
 * 2.5%; the application fee is everything else.
 */
export function quote(priceCents) {
  const price = Math.round(Number(priceCents));
  const total = Math.ceil((price + STRIPE_FIXED_CENTS) * 10000 / (10000 - STRIPE_RATE_BPS));
  const processing = total - price;
  const reasonFee = Math.round(price * APP_FEE_BPS / 10000);
  const organizerGets = price - reasonFee;
  return { price, processing, total, reason_fee: reasonFee, organizer_gets: organizerGets, application_fee: total - organizerGets };
}

/** One line for a guest: "$25 per person, plus $1.03 processing at checkout ($26.03)". */
export function guestPriceLine(ev) {
  const qt = quote(ev.price_cents);
  return `${dollars(qt.price)} per person, plus ${dollars(qt.processing)} processing at checkout (${dollars(qt.total)} in all)`;
}

/** One line for the organizer: what guests pay, what they get. */
export function organizerPriceLine(priceCents) {
  const qt = quote(priceCents);
  return `Guests pay ${dollars(qt.total)} (${dollars(qt.price)} + ${dollars(qt.processing)} processing). You get ${dollars(qt.organizer_gets)} per person; Reason keeps 2.5% (${dollars(qt.reason_fee)}).`;
}

// ---------- the refund policy (owner decisions 2026-11-11) ----------
//
// Each priced event has one of three: no refunds; refunds until N hours before it starts (the
// default, 48 hours); or refunds any time until it starts. A guest asks for their own refund (by text
// or on their page) and gets it automatically while the policy allows; otherwise they are told no,
// and that the organizer can still choose to refund them — the organizer's refunds are never held
// to the policy. A ticket keeps the policy it was bought under, unless the event's is looser now:
// loosening reaches tickets already sold, tightening only the ones sold after it.

export const REFUND_POLICIES = ["none", "until", "anytime"];
export const DEFAULT_REFUND_HOURS = 48;
export const MAX_REFUND_HOURS = 60 * 24;

/** The event's policy as it stands: `{ policy, hours }` (hours only for 'until'). */
export function policyOf(ev) {
  const policy = REFUND_POLICIES.includes(ev?.refund_policy) ? ev.refund_policy : "until";
  return policy === "until" ? { policy, hours: Number(ev?.refund_hours) > 0 ? Number(ev.refund_hours) : DEFAULT_REFUND_HOURS } : { policy, hours: null };
}

/** How many hours before the start a refund stops: 0 for anytime, Infinity for none. Smaller is looser. */
const closesBefore = ({ policy, hours }) => policy === "none" ? Infinity : policy === "anytime" ? 0 : hours;

/** The policy one ticket is held to: the one it was bought under, or the event's now if that is looser. */
export function ticketPolicy(ev, row) {
  const now = policyOf(ev);
  if (!row?.refund_policy) return now;
  const then = policyOf({ refund_policy: row.refund_policy, refund_hours: row.refund_hours });
  return closesBefore(now) < closesBefore(then) ? now : then;
}

/** "48 hours" / "2 days" / "1 hour". */
export function hoursWords(h) {
  if (h % 24 === 0 && h > 48) return `${h / 24} day${h === 24 ? "" : "s"}`;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** The policy in one sentence for a guest: "Refunds until 48 hours before it starts." */
export function refundPolicyLine(p) {
  if (p.policy === "none") return "No refunds.";
  if (p.policy === "anytime") return "Refunds anytime until it starts.";
  return `Refunds until ${hoursWords(p.hours)} before it starts.`;
}

/** Always two decimals, for what a refund gives back: "$25.00". */
export function cents2(cents) {
  return `$${(Math.round(Number(cents)) / 100).toFixed(2)}`;
}

// Who asked decides what comes back (owner decision 2026-11-11). A guest's own cancel — by text, on
// their page, a friend giving back their seat, a buyer an unclaimed one — gets the ticket price back:
// Stripe keeps its processing, Reason's 2.5% goes back. The organizer's refund, a cancelled event, a
// payment with no spot left or a refund from Stripe's dashboard gives every cent back.
export const GUEST_CANCELS = new Set(["guest", "buyer"]);
export function guestCancels(why) {
  return GUEST_CANCELS.has(String(why));
}

/**
 * One ticket's refund: `{ back_cents, kept_cents, fee_back_cents }` — what goes to the card, the
 * processing Stripe keeps, and Reason's 2.5% that goes back to the organizer (a guest's own cancel
 * only; on a full refund Stripe sends the whole application fee back by itself).
 */
export function refundSplit(row, why) {
  const total = Number(row.total_cents), price = Number(row.price_cents);
  if (!guestCancels(why) || !(price > 0) || price >= total) return { back_cents: total, kept_cents: 0, fee_back_cents: 0 };
  return { back_cents: price, kept_cents: total - price, fee_back_cents: quote(price).reason_fee };
}

/** "$25.00 back; the $1.06 processing fee isn't refundable." — what a guest's own cancel gives back. */
export function selfRefundWords(row) {
  const s = refundSplit(row, "guest");
  return s.kept_cents ? `${cents2(s.back_cents)} back; the ${cents2(s.kept_cents)} processing fee isn't refundable.` : `${cents2(s.back_cents)} back.`;
}

/** A ticket at the event's price now, for the words before anyone has paid. */
export function ticketAt(ev) {
  return ticketOfQuote(quote(ev.price_cents));
}
function ticketOfQuote(qt) {
  return { price_cents: qt.price, total_cents: qt.total };
}

/** The policy and what cancelling gives back: "Refunds until 48 hours before it starts. If you cancel: $25.00 back; the $1.06 processing fee isn't refundable." */
export function policyWithMoney(p, ticket) {
  if (p.policy === "none") return refundPolicyLine(p);
  return `${refundPolicyLine(p)} If you cancel: ${selfRefundWords(ticket)}`;
}

/** The policy as the organizer picks it, for the page's choice and the text tool's answer. */
export function policyLabel(p) {
  return p.policy === "none" ? "No refunds" : p.policy === "anytime" ? "Refunds anytime until it starts" : `Refunds until ${hoursWords(p.hours)} before it starts`;
}

/**
 * Can this ticket be refunded at the guest's own ask, now? `{ allowed, policy, closes_at, why }` with
 * why one of `no_refunds`, `closed` (past the window), `started`, `not_active`. An event with no start
 * time has nothing to count back from: refunds stay open under 'until' and 'anytime'.
 */
export function refundWindow(ev, row, now = clock.now()) {
  const p = ticketPolicy(ev, row);
  if (!ev || ev.status === "cancelled") return { allowed: false, policy: p, closes_at: null, why: "not_active" };
  if (p.policy === "none") return { allowed: false, policy: p, closes_at: null, why: "no_refunds" };
  if (ev.starts_at == null) return { allowed: true, policy: p, closes_at: null, why: null };
  const closesAt = ev.starts_at - closesBefore(p) * 3_600_000;
  if (now >= ev.starts_at) return { allowed: false, policy: p, closes_at: closesAt, why: "started" };
  if (now >= closesAt) return { allowed: false, policy: p, closes_at: closesAt, why: "closed" };
  return { allowed: true, policy: p, closes_at: closesAt, why: null };
}

/** A policy read off the organizer's words: `{ ok, policy, hours }` or `{ ok: false, problem }`. */
export function readPolicy({ policy, hours = null, days = null }) {
  if (!REFUND_POLICIES.includes(policy)) return { ok: false, problem: "bad_policy" };
  if (policy !== "until") return { ok: true, policy, hours: null };
  const h = days != null && hours == null ? Number(days) * 24 : hours == null ? DEFAULT_REFUND_HOURS : Number(hours);
  if (!Number.isInteger(h) || h < 1 || h > MAX_REFUND_HOURS) return { ok: false, problem: "bad_hours" };
  return { ok: true, policy, hours: h };
}

/**
 * Set the event's policy. `{ ok, changed, tightened, sold }`: `tightened` means tickets already sold
 * keep the looser policy they were bought under (only new sales get the new one).
 */
export function setRefundPolicy(ev, { policy, hours = null }) {
  const was = policyOf(ev);
  const next = policy === "until" ? { policy, hours } : { policy, hours: null };
  const same = was.policy === next.policy && (was.hours ?? null) === (next.hours ?? null) && ev.refund_policy != null;
  const after = same ? ev : db.updateEventRow(ev.id, { refund_policy: next.policy, refund_hours: next.hours });
  return { ok: true, changed: !same, tightened: closesBefore(next) > closesBefore(was), loosened: closesBefore(next) < closesBefore(was), sold: paidRows(ev.id).length, ev: after, policy: policyOf(after) };
}

// ---------- the organizer's Stripe Express account ----------

export function payoutAccount(conversationId) {
  return q("SELECT * FROM event_payout_accounts WHERE conversation_id = ?").get(String(conversationId ?? "")) ?? null;
}
export function payoutAccountByStripeId(id) {
  return q("SELECT * FROM event_payout_accounts WHERE stripe_account_id = ?").get(String(id ?? "")) ?? null;
}
/** Set up enough to be paid: Stripe has turned charges on for the account. */
export function payoutsReady(conversationId) {
  return !!payoutAccount(conversationId)?.charges_enabled;
}

function writeAccount(conversationId, obj, now = clock.now()) {
  const flags = { charges_enabled: obj.charges_enabled ? 1 : 0, details_submitted: obj.details_submitted ? 1 : 0, payouts_enabled: obj.payouts_enabled ? 1 : 0 };
  q(`INSERT INTO event_payout_accounts (conversation_id, stripe_account_id, charges_enabled, details_submitted, payouts_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET stripe_account_id = excluded.stripe_account_id, charges_enabled = excluded.charges_enabled,
      details_submitted = excluded.details_submitted, payouts_enabled = excluded.payouts_enabled, updated_at = excluded.updated_at`)
    .run(conversationId, String(obj.id), flags.charges_enabled, flags.details_submitted, flags.payouts_enabled, now, now);
  return payoutAccount(conversationId);
}

/** The organizer's Express account, made on first use. `{ ok, row }` or `{ ok: false, error }` with what Stripe said. */
export async function ensureAccount(conversationId, { fetchImpl = globalThis.fetch } = {}) {
  const have = payoutAccount(conversationId);
  if (have) return { ok: true, row: have, made: false };
  const r = await stripe.api("POST", "/v1/accounts", {
    type: "express",
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_profile: { product_description: "Tickets to an event organized through Reason" },
    metadata: { reason_kind: "event_organizer", conversation_id: conversationId },
  // The key guards a double tap, not forever: Stripe replays a FAILED answer under the same key for
  // 24 h, so a key that never changes kept one early refusal (platform profile unfinished) coming
  // back long after it was fixed. A 10-minute window keeps the double-tap guard and lets a retry be new.
  }, { fetchImpl, idempotencyKey: `evacct:${createHash("sha256").update(conversationId).digest("hex").slice(0, 24)}:${Math.floor(clock.now() / 600_000)}` });
  if (!r.ok) return { ok: false, error: r.body?.error?.message ?? `Stripe answered ${r.status}`, status: r.status, code: r.body?.error?.code ?? null };
  return { ok: true, row: writeAccount(conversationId, r.body), made: true };
}

/** Where the organizer lands after Stripe's onboarding: their own event page's payouts step. */
export function payoutsUrl(ev, extra = "") {
  return `${events.eventUrl(ev)}/payouts${extra}`;
}

/** The one texted link: Stripe's hosted onboarding for the organizer's Express account. */
export async function onboardingLink(conversationId, ev, { fetchImpl = globalThis.fetch } = {}) {
  const acct = await ensureAccount(conversationId, { fetchImpl });
  if (!acct.ok) return acct;
  const r = await stripe.api("POST", "/v1/account_links", {
    account: acct.row.stripe_account_id, type: "account_onboarding",
    return_url: payoutsUrl(ev, "?back=1"), refresh_url: payoutsUrl(ev, "?refresh=1"),
  }, { fetchImpl });
  if (!r.ok) return { ok: false, error: r.body?.error?.message ?? `Stripe answered ${r.status}`, status: r.status };
  return { ok: true, url: String(r.body.url ?? ""), row: acct.row };
}

/** Ask Stripe how the account stands now (after onboarding, the webhook may be late). */
export async function refreshAccount(conversationId, { fetchImpl = globalThis.fetch } = {}) {
  const row = payoutAccount(conversationId);
  if (!row) return { ok: false, reason: "no_account" };
  const r = await stripe.api("GET", `/v1/accounts/${encodeURIComponent(row.stripe_account_id)}`, null, { fetchImpl });
  if (!r.ok) return { ok: false, error: r.body?.error?.message ?? `Stripe answered ${r.status}`, row };
  return { ok: true, row: writeAccount(conversationId, r.body) };
}

/** A one-time link into the organizer's Stripe Express dashboard (balance, payouts, their own refunds view). */
export async function dashboardLink(conversationId, { fetchImpl = globalThis.fetch } = {}) {
  const row = payoutAccount(conversationId);
  if (!row) return { ok: false, reason: "no_account" };
  const r = await stripe.api("POST", `/v1/accounts/${encodeURIComponent(row.stripe_account_id)}/login_links`, {}, { fetchImpl });
  if (!r.ok) return { ok: false, error: r.body?.error?.message ?? `Stripe answered ${r.status}` };
  return { ok: true, url: String(r.body.url ?? "") };
}

/** Stripe's account.updated: the flags as they stand. Returns the row, and whether charges just turned on. */
export function noteAccountUpdated(obj, now = clock.now()) {
  const row = payoutAccountByStripeId(obj?.id);
  if (!row) return null;
  const turnedOn = !row.charges_enabled && !!obj.charges_enabled;
  return { row: writeAccount(row.conversation_id, obj, now), turnedOn };
}

// ---------- the price ----------

/**
 * Put a price on an event, or take it off (null). Needs the organizer's payouts ready for a price;
 * an event with people in keeps them (a new price is for new joins; nobody is refunded by this).
 */
export function setPrice(ev, cents, conversationId) {
  if (cents == null) {
    const after = ev.price_cents ? db.updateEventRow(ev.id, { price_cents: null }) : ev;
    return { ok: true, changed: after !== ev, price_cents: null, ev: after };
  }
  if (!canPrice(conversationId)) return { ok: false, problem: "not_available" };
  const problem = priceProblem(cents);
  if (problem) return { ok: false, problem };
  if (!payoutsReady(conversationId)) return { ok: false, problem: "payouts_not_ready" };
  const after = (ev.price_cents ?? null) === cents ? ev : db.updateEventRow(ev.id, { price_cents: cents, currency: "usd" });
  return { ok: true, changed: after !== ev, price_cents: cents, quote: quote(cents), ev: after };
}

// ---------- paying for a spot ----------

export function paymentRow(id) {
  return q("SELECT * FROM event_payments WHERE id = ?").get(Number(id)) ?? null;
}
export function rowBySession(sessionId) {
  return sessionId ? q("SELECT * FROM event_payments WHERE checkout_session_id = ?").get(String(sessionId)) ?? null : null;
}
export function rowByIntent(intentId) {
  return intentId ? q("SELECT * FROM event_payments WHERE payment_intent_id = ? ORDER BY id DESC").get(String(intentId)) ?? null : null;
}
/**
 * This person's ticket on this event: the seat they hold (their own, or one a friend bought them) on
 * a payment that stands. The payment's row, PER TICKET amounts, with `seat_id`, `seat_no`,
 * `conversation_id` = the holder and `buyer_conversation_id` = who paid.
 */
export function paidRow(eventId, conversationId) {
  return q(`SELECT p.*, s.id AS seat_id, s.seat_no, s.holder_conversation_id AS conversation_id, p.conversation_id AS buyer_conversation_id
    FROM event_seats s JOIN event_payments p ON p.id = s.payment_id
    WHERE s.event_id = ? AND s.holder_conversation_id = ? AND s.state = 'claimed' AND p.status = 'paid' ORDER BY s.id DESC`).get(Number(eventId), String(conversationId ?? "")) ?? null;
}
export function openRow(eventId, conversationId, now = clock.now()) {
  return q("SELECT * FROM event_payments WHERE event_id = ? AND conversation_id = ? AND status = 'open' AND expires_at > ? ORDER BY id DESC").get(Number(eventId), conversationId, now) ?? null;
}
/** Tickets held by Checkout pages that are still open (a hold for 3 tickets holds 3 places). */
export function openHolds(eventId, now = clock.now()) {
  return Number(q("SELECT COALESCE(SUM(quantity), 0) AS n FROM event_payments WHERE event_id = ? AND status = 'open' AND expires_at > ?").get(Number(eventId), now).n);
}
/** Places left under the cap: people in, tickets bought for friends not claimed yet, and tickets being paid for all count. Infinity with no cap. */
export function spotsLeft(ev, now = clock.now()) {
  if (ev.capacity == null) return Infinity;
  return ev.capacity - db.joinedCount(ev.id) - unclaimedSeats(ev.id) - openHolds(ev.id, now);
}
export function paidRows(eventId) {
  return q("SELECT * FROM event_payments WHERE event_id = ? AND status = 'paid' ORDER BY paid_at, id").all(Number(eventId));
}

/** Does this conversation hold a paid ticket on an event that is still on? (Shows them event_ticket_refund.) */
export function holdsTicket(conversationId) {
  const c = String(conversationId ?? "");
  return !!q(`SELECT 1 FROM event_seats s JOIN event_payments p ON p.id = s.payment_id JOIN events e ON e.id = s.event_id
    WHERE (s.holder_conversation_id = ? OR (s.conversation_id = ? AND s.state = 'open')) AND s.state != 'refunded' AND p.status = 'paid' AND e.status != 'cancelled' LIMIT 1`).get(c, c);
}

/** Where Stripe sends the guest after paying, or after changing their mind — both on the events domain. */
const successUrl = (ev) => `${events.eventUrl(ev)}/paid`;
const cancelUrl = (ev) => `${events.eventUrl(ev)}/pay-back`;

/**
 * Start a payment for `quantity` tickets (theirs, and one for each friend): a hold on the row, a
 * Checkout Session on Stripe. One open link per person per event — asked twice for the same number,
 * they get the same page; for another number the old page is expired and a new one made.
 * `{ ok: true, url, row, quote, reused }` or `{ ok: false, reason }` with reason one of `not_paid`,
 * `paused`, `cancelled`, `organizer`, `already`, `removed`, `full` (with `left` when some are),
 * `too_many` (with `max`), `no_payouts`, `stripe` (with `error`).
 */
export async function startCheckout({ ev, conversationId, displayName, instagram = null, inDirectory = false, via = "text", answers = null, quantity = 1, fetchImpl = globalThis.fetch, now = clock.now(), log = () => {} }) {
  if (!priced(ev)) return { ok: false, reason: "not_paid" };
  if (ev.status !== "active") return { ok: false, reason: ev.status };
  if (ev.organizer_conversation_id === conversationId) return { ok: false, reason: "organizer" };
  const prior = db.attendeeRow(ev.id, conversationId);
  if (prior?.state === "joined") return { ok: false, reason: "already", attendee: prior };
  if (prior?.state === "removed") return { ok: false, reason: "removed" };
  const paid = paidRow(ev.id, conversationId);
  if (paid) return { ok: false, reason: "already", paid };
  const n = Number(quantity ?? 1);
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: "bad_quantity" };
  if (n > ticketMax(ev)) return { ok: false, reason: "too_many", max: ticketMax(ev) };
  const open = openRow(ev.id, conversationId, now);
  if (open?.checkout_url && Number(open.quantity ?? 1) === n) return { ok: true, url: open.checkout_url, row: open, quote: quote(open.price_cents), reused: true };
  // Room for N, counting the page they already have open as theirs to give up; refused, that page stands.
  const mine = open ? Number(open.quantity ?? 1) : 0;
  const left = spotsLeft(ev, now) + mine;
  if (left < n) return { ok: false, reason: "full", left: left > 0 ? left : 0 };
  // Another number of tickets than the page already open: that page goes, its places with it. (One
  // that is paid anyway lands on somebody already in and goes straight back: settlePaid.)
  if (open) await expireRow(open, { fetchImpl, now, log });
  const acct = payoutAccount(ev.organizer_conversation_id);
  if (!acct?.charges_enabled) return { ok: false, reason: "no_payouts" };
  const qt = quote(ev.price_cents);
  // The answers ride on the row (as the claim carries them for a free join) and are filed by settlePaid.
  const answersJson = Array.isArray(answers) ? (answers.length ? JSON.stringify(answers) : null) : (typeof answers === "string" && answers ? answers : null);
  // The policy this ticket is sold under rides on the row: a later tightening never reaches it.
  const pol = policyOf(ev);
  const id = Number(q(`INSERT INTO event_payments (event_id, conversation_id, display_name, instagram, in_directory, via, answers, price_cents, processing_cents, total_cents, application_fee_cents, currency, refund_policy, refund_hours, quantity, status, created_at, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(ev.id, conversationId, String(displayName ?? ""), instagram ?? null, inDirectory ? 1 : 0, via, answersJson, qt.price, qt.processing, qt.total, qt.application_fee, ev.currency || "usd", pol.policy, pol.hours, n, now, now + HOLD_MS, now).lastInsertRowid);
  const currency = ev.currency || "usd";
  // N tickets: the same per-ticket price and processing, quantity N on both lines; Reason's fee is N
  // times one ticket's, so a refund of one ticket (proportional on Stripe's side) is exactly its share.
  const r = await stripe.api("POST", "/v1/checkout/sessions", {
    mode: "payment",
    client_reference_id: `evpay:${id}`,
    line_items: [
      { quantity: n, price_data: { currency, unit_amount: qt.price, product_data: { name: `${String(ev.name).slice(0, 100)} · ${n === 1 ? "1 person" : "ticket"}`, description: policyWithMoney(pol, ticketOfQuote(qt)) } } },
      { quantity: n, price_data: { currency, unit_amount: qt.processing, product_data: { name: "Processing" } } },
    ],
    payment_intent_data: {
      application_fee_amount: qt.application_fee * n,
      transfer_data: { destination: acct.stripe_account_id },
      metadata: { reason_kind: "event_ticket", event_payment_id: String(id), event_id: String(ev.id), tickets: String(n) },
    },
    metadata: { reason_kind: "event_ticket", event_payment_id: String(id), event_id: String(ev.id), conversation_id: conversationId, tickets: String(n) },
    // The refund policy, said on Stripe's page right above the Pay button.
    custom_text: { submit: { message: `${policyWithMoney(pol, ticketOfQuote(qt))}${pol.policy === "none" ? "" : " Ask Reason by text, or use your event page, to cancel."}` } },
    success_url: successUrl(ev),
    cancel_url: cancelUrl(ev),
    expires_at: Math.floor((now + STRIPE_MIN_EXPIRES_MS) / 1000),
  }, { fetchImpl, idempotencyKey: `evpay:${id}` });
  if (!r.ok || !r.body?.url) {
    q("DELETE FROM event_payments WHERE id = ? AND status = 'open'").run(id);
    const error = r.body?.error?.message ?? `Stripe answered ${r.status}`;
    log({ event_checkout_failed: ev.id, why: String(error).slice(0, 160) });
    return { ok: false, reason: "stripe", error };
  }
  q("UPDATE event_payments SET checkout_session_id = ?, checkout_url = ?, updated_at = ? WHERE id = ?").run(String(r.body.id), String(r.body.url), now, id);
  log({ event_checkout: ev.id, payment: id, tickets: n });
  return { ok: true, url: String(r.body.url), row: paymentRow(id), quote: qt, reused: false };
}

/** The words that go with the link, by text: the price, the hold, what happens next. */
export function payLinkText(ev, qt = quote(ev.price_cents), tickets = 1) {
  const n = Number(tickets) || 1;
  const what = n === 1 ? "your spot is held" : `your ${n} tickets (${dollars(qt.total * n)} in all) are held`;
  const pol = policyWithMoney(policyOf(ev), ticketOfQuote(qt)).toLowerCase().replace("if you cancel:", n > 1 ? "if a ticket is cancelled:" : "if you cancel:");
  return `${ev.name} is ${dollars(qt.price)} per person (${dollars(qt.total)} with processing). ${pol} ${what} for 15 minutes while you pay here — you're in once the payment goes through, and i'll text you then${n > 1 ? ", with a link for each friend" : ""}:`;
}

// ---------- the webhook ----------

/** Is this Stripe event about tickets or an organizer's account (ours), rather than the subscription (src/plan.js)? */
export function isOurs(event) {
  const type = String(event?.type ?? "");
  const obj = event?.data?.object ?? {};
  if (type === "account.updated") return obj.object === "account";
  if (type.startsWith("checkout.session.")) return obj.metadata?.reason_kind === "event_ticket" || /^evpay:\d+$/.test(String(obj.client_reference_id ?? ""));
  if (type === "charge.refunded" || type === "charge.refund.updated") return obj.metadata?.reason_kind === "event_ticket" || !!rowByIntent(obj.payment_intent);
  return false;
}

/** One verified event of ours. Idempotent on its id (plan.js's stripe_events table). */
export async function handleStripeEvent(event, { runtime = null, say = null, log = () => {}, now = clock.now(), fetchImpl = globalThis.fetch } = {}) {
  const id = String(event?.id ?? "");
  const type = String(event?.type ?? "");
  if (!id || !type) return { ok: false, why: "no id or type" };
  if (q("INSERT OR IGNORE INTO stripe_events (event_id, type, received_at) VALUES (?, ?, ?)").run(id, type, now).changes !== 1) return { ok: true, duplicate: true };
  try {
    return await actOn(event, { runtime, say, log, now, fetchImpl });
  } catch (e) {
    q("DELETE FROM stripe_events WHERE event_id = ?").run(id);
    log({ stripe_webhook_failed: type, why: (e?.message ?? String(e)).split("\n")[0] });
    return { ok: false, why: (e?.message ?? String(e)).split("\n")[0] };
  }
}

async function actOn(event, ctx) {
  const type = String(event.type);
  const obj = event?.data?.object ?? {};
  const { log } = ctx;
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const row = rowBySession(obj.id) ?? (obj.metadata?.event_payment_id ? paymentRow(obj.metadata.event_payment_id) : null);
      if (!row) { log({ stripe_webhook: type, unmatched: true }); return { ok: true, matched: false }; }
      if (String(obj.payment_status ?? "paid") !== "paid") {
        log({ stripe_webhook: type, payment: row.id, waiting: obj.payment_status });
        return { ok: true, matched: true, waiting: true };
      }
      const out = await settlePaid(row, { intentId: typeof obj.payment_intent === "string" ? obj.payment_intent : null, total: obj.amount_total ?? null }, ctx);
      log({ stripe_webhook: type, payment: row.id, ...out });
      return { ok: true, matched: true, ...out };
    }
    case "checkout.session.async_payment_failed": {
      const row = rowBySession(obj.id);
      if (!row) return { ok: true, matched: false };
      if (row.status === "open") q("UPDATE event_payments SET status = 'failed', answers = NULL, updated_at = ? WHERE id = ?").run(ctx.now, row.id);
      tell(ctx, row.conversation_id, `that payment for ${eventName(row)} didn't go through, so you're not in yet. open the event link again whenever you'd like to try another way to pay.`);
      return { ok: true, matched: true, failed: true };
    }
    case "checkout.session.expired": {
      const row = rowBySession(obj.id);
      if (!row) return { ok: true, matched: false };
      if (row.status === "open") q("UPDATE event_payments SET status = 'expired', answers = NULL, updated_at = ? WHERE id = ?").run(ctx.now, row.id);
      return { ok: true, matched: true, expired: true };
    }
    case "charge.refunded": {
      const row = rowByIntent(obj.payment_intent);
      if (!row) return { ok: true, matched: false };
      // Refunded from Stripe's dashboard rather than by Reason: the guest leaves the event the same way.
      const charged = Number(obj.amount ?? row.total_cents * Math.max(1, Number(row.quantity ?? 1)));
      if (row.status === "paid" && (obj.refunded || Number(obj.amount_refunded ?? 0) >= charged)) {
        // A refund of ours still in flight (its seat is marked) is ours to finish: the last ticket of a payment makes the charge "fully refunded" too.
        const ours = seatsOfPayment(row.id).some(st => st.state !== "refunded" && st.refunding_at != null && ctx.now - st.refunding_at < 10 * 60_000);
        if (ours) return { ok: true, matched: true, ours: true };
        await afterRefund(row, { refundId: obj.refunds?.data?.[0]?.id ?? null, why: "dashboard" }, ctx);
        return { ok: true, matched: true, refunded: true };
      }
      return { ok: true, matched: true };
    }
    case "account.updated": {
      const noted = noteAccountUpdated(obj, ctx.now);
      if (!noted) { log({ stripe_webhook: type, unmatched: true }); return { ok: true, matched: false }; }
      if (noted.turnedOn) tell(ctx, noted.row.conversation_id, "your payouts are set up with Stripe — you can put a price on your event now, on its page or by telling me the price.");
      log({ stripe_webhook: type, conversation: noted.row.conversation_id, charges_enabled: !!noted.row.charges_enabled });
      return { ok: true, matched: true, charges_enabled: !!noted.row.charges_enabled };
    }
    default:
      log({ stripe_webhook: type, ignored: true });
      return { ok: true, ignored: true };
  }
}

function eventName(row) {
  return String(db.getEventRow(row.event_id)?.name ?? "the event").slice(0, 80);
}

/** One line to a person, through the outbox when the runtime has one (`_tell`), else whatever `say` the caller gave. */
function tell(ctx, conversationId, text) {
  const say = typeof ctx.runtime?._tell === "function" ? (c, t) => ctx.runtime._tell(c, t) : ctx.say ?? (ctx.runtime?.say ? (c, t) => ctx.runtime.say(c, t) : null);
  if (!say || !conversationId) return;
  try { Promise.resolve(say(conversationId, text)).catch(() => {}); } catch (e) { ctx.log?.({ event_pay_text_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }); }
}

/**
 * The payment landed: the row goes paid and the person goes on the event, in one transaction, under
 * the same capacity check every join uses. If the event filled up meanwhile (a hold that ran out and
 * a late payment), or closed, the money goes straight back and they are told.
 */
export async function settlePaid(row, { intentId = null, total = null }, ctx) {
  const { runtime, now, log } = ctx;
  if (row.status === "paid") return { paid: true, already: true };
  const ev = db.getEventRow(row.event_id);
  db.db.exec("BEGIN IMMEDIATE");
  let added;
  try {
    const fresh = paymentRow(row.id);
    if (fresh.status === "paid") { db.db.exec("ROLLBACK"); return { paid: true, already: true }; }
    const n = Math.max(1, Number(fresh.quantity ?? 1));
    // Stripe's amount_total is for all N tickets; the row keeps one ticket's.
    const perTicket = total != null ? Math.round(Number(total) / n) : null;
    q("UPDATE event_payments SET status = 'paid', payment_intent_id = COALESCE(?, payment_intent_id), total_cents = COALESCE(?, total_cents), paid_at = ?, updated_at = ? WHERE id = ?")
      .run(intentId, perTicket, now, now, row.id);
    // Every ticket needs its place: the buyer's and each friend's, under the cap with every unclaimed seat counted.
    const room = !ev || ev.capacity == null || db.joinedCount(ev.id) + unclaimedSeats(ev.id) + n <= ev.capacity;
    added = !ev ? { ok: false, reason: "not_found" }
      : ev.status !== "active" ? { ok: false, reason: ev.status }
      : !room ? { ok: false, reason: "full" }
      : db.addAttendeeTx({ eventId: ev.id, conversationId: row.conversation_id, displayName: row.display_name || "Guest", instagram: row.instagram, inDirectory: !!row.in_directory, via: row.via });
    // The seats: the buyer's own (they're on it), and one open seat with its own claim link per friend.
    if (added.ok && !added.already) {
      q(`INSERT INTO event_seats (payment_id, event_id, seat_no, conversation_id, holder_conversation_id, state, claimed_at, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, 'claimed', ?, ?, ?)`).run(row.id, ev.id, row.conversation_id, row.conversation_id, now, now, now);
      for (let i = 1; i < n; i++) {
        q(`INSERT INTO event_seats (payment_id, event_id, seat_no, conversation_id, state, claim_token, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`).run(row.id, ev.id, i, row.conversation_id, db.newEventToken(24), now, now);
      }
    }
    db.db.exec("COMMIT");
  } catch (e) {
    try { db.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
  const paid = paymentRow(row.id);
  // Already in (a second Checkout paid after the first, or a free join before a late payment): this
  // payment bought nothing, so it goes straight back. Their spot stands as it was.
  if (added.ok && added.already) added = { ok: false, reason: "already" };
  if (!added.ok) {
    // Paid for a spot that is no longer there: the whole amount back, and said plainly.
    const r = await refund({ ev, row: paid, why: added.reason, fetchImpl: ctx.fetchImpl, runtime, log, tellGuest: false, leave: false });
    const words = { full: Number(paid.quantity ?? 1) > 1 ? "didn't have room for all your tickets by the time your payment landed" : "filled up before your payment landed", cancelled: "was cancelled", paused: "is paused right now", removed: "isn't open to you", organizer: "is your own", already: "already had you on it" }[added.reason] ?? "couldn't take your join";
    tell(ctx, row.conversation_id, r.ok
      ? `sorry — ${ev?.name ?? "the event"} ${words}, so i've refunded your ${dollars(paid.total_cents * Number(paid.quantity ?? 1))} in full. it shows up on your card in a few days.`
      : `sorry — ${ev?.name ?? "the event"} ${words}. your ${dollars(paid.total_cents * Number(paid.quantity ?? 1))} is being refunded; if it hasn't shown up in a few days, tell me.`);
    return { paid: true, joined: false, refunded: r.ok, reason: added.reason };
  }
  const att = events.afterJoin({ ev, att: added.attendee, typedInstagram: row.instagram });
  // The answers they gave on the page or by text, filed now that they are in (a reworded question drops its answer).
  if (paid.answers) { try { db.fileClaimAnswers(ev.id, att, paid.answers, row.via === "text" ? "text" : "join"); } catch (e) { log({ event_pay_answers_failed: row.id, why: (e?.message ?? String(e)).split("\n")[0] }); } }
  q("UPDATE event_payments SET answers = NULL WHERE id = ?").run(row.id);
  const receipt = db.insertEventMessage(ev.id, "receipt", receiptBody(ev, paid));
  await events.deliver({ runtime, message: receipt, conversationId: row.conversation_id });
  await events.sendWelcome({ runtime, ev, att });
  // The friends' links: one line saying what they are, then each link as its own message (each makes its own card).
  const seats = seatsOfPayment(row.id).filter(st => st.seat_no > 0);
  if (seats.length) await sendSeatLinks({ runtime, ev, seats, log });
  events.scheduleListNote({ runtime, ev, att });
  // A new guest the event onboarding covers (src/eventonboarding.js): its one line, now they are in.
  await eventonb.afterPaid({ runtime, ev, conversationId: row.conversation_id, organizer: events.organizerName(ev), log })
    .catch(e => log({ event_onboarding_paid_failed: row.conversation_id, why: (e?.message ?? String(e)).split("\n")[0] }));
  return { paid: true, joined: true, already: !!added.already, seats: seats.length };
}

/** The words before a buyer's claim links. */
export function seatLinksText(ev, count) {
  return count === 1
    ? `here's the ticket for your friend — send them this link. it works once: they tap it, put in their name, and they're on ${ev.name} as their own guest (their own spot, the event's texts, the album). if plans change, you can refund it or switch who it's for until it's claimed.`
    : `here are your ${count} tickets for friends — send each friend one link. each works once: they tap it, put in their name, and they're on ${ev.name} as their own guest (their own spot, the event's texts, the album). if plans change, you can refund one or switch who it's for until it's claimed.`;
}

/** Text the buyer their open seats' links: the line, then one message per link. */
export async function sendSeatLinks({ runtime, ev, seats, log = () => {} }) {
  const open = seats.filter(st => st.state === "open" && st.claim_token);
  if (!open.length) return 0;
  const buyer = open[0].conversation_id;
  const head = db.insertEventMessage(ev.id, "seat_links", seatLinksText(ev, open.length));
  await events.deliver({ runtime, message: head, conversationId: buyer });
  for (const st of open) {
    const m = db.insertEventMessage(ev.id, "seat_link", seatUrl(ev, st));
    await events.deliver({ runtime, message: m, conversationId: buyer });
  }
  log({ event_seat_links: ev.id, seats: open.length });
  return open.length;
}

/** The paid-join text: what they paid, and the refund policy their ticket is held to. */
export function receiptBody(ev, row) {
  const p = ticketPolicy(ev, row);
  const n = Number(row.quantity ?? 1);
  const tail = p.policy === "none" ? (n > 1 ? "no refunds on these." : "no refunds on this one.")
    : `${refundPolicyLine(p).toLowerCase().replace(/\.$/, "")} — just text me ${n > 1 ? "" : "\"refund my ticket\" "}if plans change (${n > 1 ? "each ticket cancelled: " : ""}${selfRefundWords(row).replace(/\.$/, "")}).`;
  return n > 1
    ? `paid ${dollars(row.total_cents * n)} for ${n} tickets to ${ev.name} — you're in, and the other ${n - 1} ${n === 2 ? "is" : "are"} for your friends (links next). ${tail}`
    : `paid ${dollars(row.total_cents)} for ${ev.name} — you're in. ${tail}`;
}

// ---------- refunds ----------

/** What a refunded guest is told. */
export function refundedBody(ev, totalCents, { cancelled = false, guest = false, row = null } = {}) {
  if (guest && row) return `done — your ticket for ${ev.name} is cancelled and you're off its guest list: ${selfRefundWords(row).replace(/\.$/, "")}. it shows up on your card in a few days.`;
  if (guest) return `done — your ${dollars(totalCents)} for ${ev.name} is refunded, so you're off its guest list. it shows up on your card in a few days.`;
  return cancelled
    ? `${ev.name} is cancelled, so your ${dollars(totalCents)} has been refunded in full. it shows up on your card in a few days.`
    : `the organizer refunded your ${dollars(totalCents)} for ${ev.name}, so you're no longer on its guest list. it shows up on your card in a few days.`;
}

/**
 * Money back. With a seat (`seat`, or `row.seat_id` from paidRow): that one ticket — a partial
 * refund of the buyer's payment. Without one: every ticket on the payment still standing (a
 * cancellation, or a payment that landed with no room). What one ticket gives back is refundSplit's:
 * the whole ticket (Stripe reverses the transfer and Reason's fee in proportion: exactly its share),
 * or on a guest's own cancel the price (the transfer reversed by the price, Reason's 2.5% back by
 * feeBack, Stripe keeps its processing). Then whoever held a refunded seat is off the event and told,
 * and the buyer hears about any ticket of theirs that went back. Idempotent per seat.
 * `{ ok: true, refund_id, amount_cents }` or `{ ok: false, reason, error }`.
 */
export async function refund({ ev, row = null, seat = null, why = "organizer", fetchImpl = globalThis.fetch, runtime = null, log = () => {}, now = clock.now(), tellGuest = true, cancelled = false, leave = true }) {
  const cur = paymentRow(row?.id ?? seat?.payment_id);
  if (!cur) return { ok: false, reason: "not_found" };
  const one = seat ? seatById(seat.id) : row?.seat_id ? seatById(row.seat_id) : null;
  if (one && one.payment_id !== cur.id) return { ok: false, reason: "not_found" };
  if (one?.state === "refunded") return { ok: true, refund_id: one.refund_id, already: true, amount_cents: 0 };
  if (!one && cur.status === "refunded") return { ok: true, refund_id: cur.refund_id, already: true, amount_cents: 0 };
  if (cur.status !== "paid" || !cur.payment_intent_id) return { ok: false, reason: "not_paid" };
  // A refund Stripe may already have done (it timed out, or answered 5xx) is finished before anything
  // else on this payment, by asking exactly the same again under the same key, so Stripe replays it:
  // the same ticket's refund replays (whoever asks now, it keeps the first one's why and amount); any
  // other refund on the payment waits (review 2026-11-11). The sweep finishes it too (refundPending).
  const pending = readPending(cur);
  if (pending && (pending.seat ?? null) !== (one?.id ?? null)) return { ok: false, reason: "busy", error: "another refund on this payment is still being confirmed by Stripe" };
  if (pending) { why = pending.why; cancelled = cancelled || pending.why === "cancelled"; }
  const qty = Math.max(1, Number(cur.quantity ?? 1));
  const seats = seatsOfPayment(cur.id);
  const standing = seats.filter(st => st.state !== "refunded");
  const targets = one ? [one] : standing;
  const count = one ? 1 : (seats.length ? standing.length : qty);
  // One ticket's refund (amount columns are per ticket): whole, or the price on a guest's own cancel.
  const split = refundSplit(cur, why);
  const amount = count * split.back_cents;
  if (amount <= 0) return { ok: false, reason: "not_paid" };
  const full = cur.total_cents * qty;
  const body = {
    payment_intent: cur.payment_intent_id, reverse_transfer: true,
    // A whole refund sends Reason's fee back with it, in proportion. A guest's own cancel doesn't
    // (the proportional share would include the processing Stripe keeps): its 2.5% goes back by feeBack.
    refund_application_fee: !split.kept_cents,
    metadata: { reason_kind: "event_ticket", event_payment_id: String(cur.id), why: String(why).slice(0, 40), ...(one ? { event_seat_id: String(one.id) } : {}) },
  };
  // Anything less than the whole charge names its amount; Stripe reverses the transfer in proportion —
  // a destination charge transfers the whole charge, so that is exactly the amount.
  if (amount !== full) body.amount = amount;
  // A refund of one of these tickets already in flight (another tap, the organizer at the same moment) goes
  // first: a second one now, under a different key, would refund the ticket twice (review 2026-11-11).
  if (targets.some(st => st.refunding_at != null && now - st.refunding_at < 10 * 60_000)) return { ok: false, reason: "busy", error: "a refund of that ticket is already going through" };
  // Marked first, so Stripe's charge.refunded for this very refund (which can beat our own answer) is left to us.
  for (const st of targets) q("UPDATE event_seats SET refunding_at = ?, updated_at = ? WHERE id = ?").run(now, now, st.id);
  // The key carries the attempt, so a retry after Stripe said no is a new request, not the replayed no.
  // A one-ticket payment keeps the payment's own key (as before seats); a ticket out of several, its seat's.
  const bySeat = !!one && qty > 1;
  const key = pending?.key ?? (bySeat ? `evrefund:${cur.id}:s${one.id}:${one.refund_attempts}` : `evrefund:${cur.id}:${cur.refund_attempts}`) + (split.kept_cents ? "p" : "");
  // Pending from before the ask (a crash mid-call leaves it so): only a yes or a definite no settles it.
  q("UPDATE event_payments SET refund_pending = ? WHERE id = ?").run(JSON.stringify({ key, why: String(why), seat: one?.id ?? null, at: now }), cur.id);
  const r = await stripe.api("POST", "/v1/refunds", body, { fetchImpl, idempotencyKey: key });
  if (r.ok || definiteNo(r)) q("UPDATE event_payments SET refund_pending = NULL WHERE id = ?").run(cur.id);
  if (!r.ok) {
    const error = r.body?.error?.message ?? `Stripe answered ${r.status}`;
    for (const st of targets) q("UPDATE event_seats SET refunding_at = NULL, updated_at = ? WHERE id = ?").run(now, st.id);
    // Only a definite no (4xx) moves the key on. No answer (a timeout) or a 5xx may have gone through:
    // the retry keeps the key, so Stripe replays it instead of refunding the seat twice (review 2026-11-11).
    const moved = definiteNo(r) ? 1 : 0;
    if (one) q(`UPDATE event_seats SET refund_error = ?, refund_attempts = refund_attempts + ${moved} WHERE id = ?`).run(String(error).slice(0, 300), one.id);
    q(`UPDATE event_payments SET refund_error = ?, refund_attempts = refund_attempts + ${bySeat ? 0 : moved}, updated_at = ? WHERE id = ?`).run(String(error).slice(0, 300), now, cur.id);
    log({ event_refund_failed: cur.id, seat: one?.id ?? null, why: String(error).slice(0, 160) });
    return { ok: false, reason: "stripe", error };
  }
  const done = await afterRefund(cur, { seats: targets, whole: !one, refundId: r.body?.id ?? null, why, tellGuest, cancelled, leave, back: split.back_cents, feeBackEach: split.fee_back_cents }, { runtime, now, log });
  if (done.fee_owed) await feeBack(cur.id, { fetchImpl, log, now });
  return { ok: true, refund_id: r.body?.id ?? null, amount_cents: done.amount_cents };
}

function readPending(pay) {
  try { const p = pay?.refund_pending ? JSON.parse(pay.refund_pending) : null; return p && typeof p.key === "string" ? p : null; } catch { return null; }
}

/** Refunds left pending (Stripe may have done them) asked again under their own key: Stripe's replay settles them. */
export async function refundPending({ now = clock.now(), log = () => {}, fetchImpl = globalThis.fetch, runtime = null } = {}) {
  let settled = 0;
  for (const { id } of q("SELECT id FROM event_payments WHERE refund_pending IS NOT NULL AND status = 'paid' LIMIT 20").all()) {
    const pay = paymentRow(id); const p = readPending(pay);
    if (!p || now - Number(p.at ?? 0) < 60_000) continue;
    const ev = db.getEventRow(pay.event_id);
    const r = await refund({ ev, row: p.seat ? null : pay, seat: p.seat ? seatById(p.seat) : null, why: p.why, fetchImpl, runtime, log, now });
    if (r.ok) settled++;
  }
  return settled;
}

/** Stripe said no for certain (a 4xx): a retry may be a new request. A timeout or a 5xx may have gone through. */
function definiteNo(r) {
  // 409 (the same key still being worked on) and 429 (not run) are not answers about the refund.
  return r.status >= 400 && r.status < 500 && r.status !== 409 && r.status !== 429;
}

const feeBackBusy = new Set();

/**
 * Reason's 2.5% back to the organizer after a guest's own cancel (Stripe's fee refund on the charge's
 * application fee), so the organizer ends with nothing for the ticket. What is owed stays on the row
 * until Stripe says yes; the sweep tries again. Each definite answer moves the key on, so a retry is
 * never Stripe's replay of the last answer and a second cancel on the same payment is its own refund.
 */
export async function feeBack(paymentId, { fetchImpl = globalThis.fetch, log = () => {}, now = clock.now() } = {}) {
  if (feeBackBusy.has(paymentId)) return { ok: false, busy: true };
  feeBackBusy.add(paymentId);
  try {
    const row = paymentRow(paymentId);
    const owed = Number(row?.fee_back_owed_cents ?? 0);
    if (!row || owed <= 0 || !row.payment_intent_id) return { ok: true, owed: 0 };
    const pi = await stripe.api("GET", `/v1/payment_intents/${encodeURIComponent(row.payment_intent_id)}?expand[]=latest_charge`, null, { fetchImpl });
    const fee = pi.body?.latest_charge?.application_fee;
    const feeId = typeof fee === "string" ? fee : fee?.id;
    if (!pi.ok || !feeId) {
      log({ event_fee_back_failed: row.id, step: "find_fee", status: pi.status });
      return { ok: false, owed };
    }
    // A fee refund Stripe may have done is asked again for exactly its amount under its key; more owed since goes after.
    const amount = Number(row.fee_back_pending_cents) > 0 ? Math.min(Number(row.fee_back_pending_cents), owed) : owed;
    const r = await stripe.api("POST", `/v1/application_fees/${encodeURIComponent(feeId)}/refunds`, {
      amount, metadata: { reason_kind: "event_ticket", event_payment_id: String(row.id), why: "guest_cancel_fee_back" },
    }, { fetchImpl, idempotencyKey: `evfeeback:${row.id}:${row.fee_back_seq}` });
    // A yes or a definite no moves the key on; no answer keeps it, so a retry replays what Stripe did.
    if (r.ok || definiteNo(r)) q("UPDATE event_payments SET fee_back_seq = fee_back_seq + 1, fee_back_pending_cents = 0 WHERE id = ?").run(row.id);
    else q("UPDATE event_payments SET fee_back_pending_cents = ? WHERE id = ?").run(amount, row.id);
    if (!r.ok) {
      log({ event_fee_back_failed: row.id, step: "refund", status: r.status, why: String(r.body?.error?.message ?? "").slice(0, 160) });
      return { ok: false, owed };
    }
    q("UPDATE event_payments SET fee_back_owed_cents = MAX(0, fee_back_owed_cents - ?), updated_at = ? WHERE id = ?").run(amount, now, row.id);
    log({ event_fee_back: row.id, cents: amount });
    return { ok: true, owed: owed - amount, cents: amount };
  } finally { feeBackBusy.delete(paymentId); }
}

/** What a friend whose ticket went back is told: the money is the buyer's, so it goes to their card. */
export function friendRefundedBody(ev, seat, totalCents, why, row = null) {
  const buyer = buyerName(ev, seat);
  if (why === "cancelled") return `${ev.name} is cancelled, so the ticket ${buyer} got you was refunded to their card.`;
  if (why === "guest") return row
    ? `done — the ticket ${buyer} got you for ${ev.name} is given back, so you're off its guest list. ${buyer}'s card gets ${selfRefundWords(row).replace(/\.$/, "")}, since they paid for it.`
    : `done — the ticket ${buyer} got you for ${ev.name} is given back, so you're off its guest list. the ${dollars(totalCents)} goes back to ${buyer}'s card, since they paid for it.`;
  return `the organizer refunded the ticket ${buyer} got you for ${ev.name}, so you're no longer on its guest list. the ${dollars(totalCents)} goes back to ${buyer}'s card.`;
}

/** What the buyer hears when one ticket they got for a friend goes back (their own ticket's words are refundedBody). */
export function buyerSeatRefundedBody(ev, seat, holderName, totalCents, why, row = null) {
  // A guest's own cancel (a friend giving their ticket back, the buyer an unclaimed one) is the price; the processing stays with Stripe.
  const back = row && guestCancels(why)
    ? `${cents2(totalCents)} is on its way back to your card (the ${cents2(refundSplit(row, why).kept_cents)} processing fee isn't refundable) — it shows up in a few days.`
    : `${dollars(totalCents)} is on its way back to your card — it shows up in a few days.`;
  if (why === "buyer") return `done — the unclaimed ticket for ${ev.name} is refunded and its link doesn't work any more. ${back}`;
  if (why === "guest") return `${holderName} gave back the ticket you got them for ${ev.name}, so ${back}`;
  return holderName
    ? `the organizer refunded the ticket you got ${holderName} for ${ev.name}, so ${back}`
    : `the organizer refunded one of the tickets you got for friends to ${ev.name} (nobody had claimed it), so ${back}`;
}

/**
 * Seats go refunded (each once), the payment's refunded amount grows, and the payment is refunded
 * once no ticket on it stands. Whoever held a refunded seat leaves (unless another ticket of theirs
 * stands, or the payment never got them in: `leave` false) and is told; the buyer hears about seats
 * that weren't their own; the organizer hears about a guest's own refund.
 */
async function afterRefund(pay, { seats = null, whole = true, refundId = null, why = "organizer", tellGuest = true, cancelled = false, leave = true, back = null, feeBackEach = 0 }, { runtime = null, now = clock.now(), log = () => {} }) {
  // What one ticket gave back (refundSplit): the whole ticket, or the price on a guest's own cancel.
  const each = back ?? pay.total_cents;
  const selfCancel = guestCancels(why) ? pay : null;
  const list = seats ?? seatsOfPayment(pay.id).filter(st => st.state !== "refunded");
  const changed = [];
  for (const st of list) {
    const r = q(`UPDATE event_seats SET state = 'refunded', claim_token = NULL, refund_id = ?, refund_why = ?, refund_error = NULL, refunding_at = NULL, refunded_at = ?, updated_at = ?,
      invite_state = CASE WHEN invite_state = 'owed' THEN 'dropped' ELSE invite_state END WHERE id = ? AND state != 'refunded'`).run(refundId, String(why).slice(0, 20), now, now, st.id);
    if (r.changes === 1) changed.push(st);
  }
  const noSeats = !seatsOfPayment(pay.id).length;
  const amount = noSeats ? each * Math.max(1, Number(pay.quantity ?? 1)) : changed.length * each;
  // Reason's 2.5% owed back is written with the refund itself, and only for the tickets this call refunded
  // (a double-submitted cancel gets Stripe's replay and changes no seat: it owes nothing more).
  const feeOwed = (noSeats ? Math.max(1, Number(pay.quantity ?? 1)) : changed.length) * (Number(feeBackEach) || 0);
  if (!noSeats && !changed.length) return { amount_cents: 0, seats: 0, fee_owed: 0 };
  q("UPDATE event_payments SET refunded_cents = refunded_cents + ?, fee_back_owed_cents = fee_back_owed_cents + ?, refund_id = COALESCE(?, refund_id), refund_error = NULL, updated_at = ? WHERE id = ? AND status = 'paid'").run(amount, feeOwed, refundId, now, pay.id);
  const left = seatsOfPayment(pay.id).filter(st => st.state !== "refunded").length;
  if (!left) q("UPDATE event_payments SET status = 'refunded', answers = NULL, refunded_at = ?, updated_at = ? WHERE id = ? AND status = 'paid'").run(now, now, pay.id);
  const ev = db.getEventRow(pay.event_id);
  log({ event_refunded: pay.id, seats: changed.map(st => st.id), why });
  if (!ev) return { amount_cents: amount, fee_owed: feeOwed };
  const isCancel = cancelled || why === "cancelled";
  const buyer = pay.conversation_id;
  let buyerTold = false;
  for (const st of changed) {
    const holder = st.state === "claimed" ? st.holder_conversation_id : null;
    const att = holder ? db.attendeeRow(ev.id, holder) : null;
    // They leave only when no ticket of theirs still stands (a refunded duplicate never costs a spot that is paid for).
    if (leave && att?.state === "joined" && att.role === "guest" && !paidRow(ev.id, holder)) {
      db.leaveAttendee(att.id);
      try { const rides = await import("./eventrides.js"); await rides.leftEvent({ runtime, ev, conversationId: holder }); } catch { /* rides are optional */ }
    }
    const holderName = String(att?.display_name || "").slice(0, 60);
    if (holder && holder === buyer) {
      // The buyer's own ticket: on a whole refund their one text says the whole amount (every ticket was theirs).
      if (tellGuest) {
        const message = db.insertEventMessage(ev.id, "refund", refundedBody(ev, whole ? amount : each, { cancelled: isCancel, guest: why === "guest", row: selfCancel }));
        await events.deliver({ runtime, message, conversationId: buyer });
        buyerTold = true;
      }
    } else {
      if (holder && tellGuest) {
        const message = db.insertEventMessage(ev.id, "refund", friendRefundedBody(ev, st, each, why, selfCancel));
        await events.deliver({ runtime, message, conversationId: holder });
      }
      // The buyer hears about each ticket of theirs that went back, unless it was their own doing on a page/text that already says so.
      if (tellGuest && !whole && why !== "buyer") tell({ runtime, log }, buyer, buyerSeatRefundedBody(ev, st, holderName, each, why, selfCancel));
      if (tellGuest && !whole && why === "buyer") {
        const message = db.insertEventMessage(ev.id, "refund", buyerSeatRefundedBody(ev, st, "", each, "buyer", selfCancel));
        await events.deliver({ runtime, message, conversationId: buyer });
      }
    }
    // A guest's own refund (or a buyer's of an unclaimed ticket): the organizer hears it in one line.
    if (why === "guest" || why === "buyer") {
      const name = why === "buyer" ? buyerName(ev, st) : String(holderName || pay.display_name || "A guest").slice(0, 60);
      tell({ runtime, log }, ev.organizer_conversation_id, why === "buyer"
        ? `${name} gave back a ticket they'd bought for a friend to ${ev.name} (nobody had claimed it), and got the ${cents2(each)} ticket price back under your refund policy. That ticket comes out of your sales.`
        : holder && holder !== buyer
          ? `${name} gave back their ticket to ${ev.name} under your refund policy; the ${cents2(each)} ticket price went back to the card of the friend who bought it, so they're off the guest list. That ticket comes out of your sales.`
          : `${name} cancelled their ticket to ${ev.name} under your refund policy and got the ${cents2(each)} ticket price back, so they're off the guest list. That ticket comes out of your sales.`);
    }
  }
  // A whole refund where the buyer's own ticket was already gone (or never made): the buyer still hears where their money went.
  if (whole && tellGuest && !buyerTold && amount > 0 && changed.length) {
    const message = db.insertEventMessage(ev.id, "refund", isCancel
      ? `${ev.name} is cancelled, so the ${dollars(amount)} you paid for tickets has been refunded in full. it shows up on your card in a few days.`
      : `the ${dollars(amount)} you paid for tickets to ${ev.name} has been refunded in full. it shows up on your card in a few days.`);
    await events.deliver({ runtime, message, conversationId: buyer });
  }
  return { amount_cents: amount, seats: changed.length, fee_owed: feeOwed };
}

/**
 * A guest's own ask for their money back — their own ticket, or the one a friend got them (that
 * money goes back to the friend's card). Under the policy the ticket is held to it is refunded (the
 * ticket price; the processing fee isn't refundable — refundSplit), they leave and are told, and so
 * are the buyer and the organizer. Outside it, nothing happens: `{ ok: false, reason, window }`.
 */
export async function guestRefund({ ev, conversationId, runtime = null, log = () => {}, fetchImpl = globalThis.fetch, now = clock.now() }) {
  const row = ev ? paidRow(ev.id, conversationId) : null;
  if (!row) return { ok: false, reason: "not_paid" };
  const window = refundWindow(ev, row, now);
  if (!window.allowed) return { ok: false, reason: window.why, window, row };
  const r = await refund({ ev, row, why: "guest", fetchImpl, runtime, log, now });
  return r.ok ? { ok: true, refund_id: r.refund_id, row, window, back_cents: r.amount_cents ?? refundSplit(row, "guest").back_cents } : { ok: false, reason: "stripe", error: r.error, row, window };
}

/** Why a guest's refund can't happen, in the words to say it in (the organizer can always still choose to). */
export function refusalWords(ev, window) {
  // A start time the organizer hasn't shared is never told by the wording: "started" reads as "closed".
  if (!ev.time_released && window.why === "started") window = { ...window, why: "closed" };
  const lead = { no_refunds: `${ev.name} has a no-refunds policy`, closed: `the refund window for ${ev.name} has closed (${refundPolicyLine(window.policy).toLowerCase().replace(/\.$/, "")})`, started: `${ev.name} has already started`, not_active: `${ev.name} isn't taking refund requests` }[window.why] ?? "that ticket can't be refunded automatically";
  return `${lead}, so I can't refund it myself — but the organizer can still choose to refund you, so it's worth asking them.`;
}

/** The pin on a seat that isn't the buyer's own, so two tickets on one payment are two different yeses. */
const seatPin = (row) => Number(row?.seat_no) > 0 ? `/${row.seat_id}` : "";

/** The guest's yes covers their one ticket on one event, pinned to the payment row (and the seat). */
export function guestRefundTarget(ev, row) {
  return `cancel my ticket for ${String(ev.name).slice(0, 80)} (event #${ev.id}): ${cents2(refundSplit(row, "guest").back_cents)} back [pay ${row.id}${seatPin(row)}]`;
}

/** Every payment refunded in full, for a cancellation. `{ refunded, failed, total_cents }` (refunded counts payments). */
export async function refundAll({ ev, runtime = null, log = () => {}, fetchImpl = globalThis.fetch, now = clock.now() }) {
  const out = { refunded: 0, failed: 0, total_cents: 0 };
  for (const row of paidRows(ev.id)) {
    const r = await refund({ ev, row, why: "cancelled", cancelled: true, fetchImpl, runtime, log, now });
    if (r.ok) { out.refunded++; out.total_cents += r.amount_cents ?? 0; } else out.failed++;
  }
  // Nobody can pay for a cancelled event, but a Checkout page still open would let them try.
  for (const row of q("SELECT * FROM event_payments WHERE event_id = ? AND status = 'open'").all(ev.id)) await expireRow(row, { fetchImpl, now, log });
  return out;
}

// ---------- the tickets a buyer got for friends ----------

/** One of this buyer's seats for friends, on this event, or null. */
export function buyerSeat(ev, buyerConversationId, seatId) {
  const st = seatById(seatId);
  if (!st || st.event_id !== ev.id || st.conversation_id !== buyerConversationId || st.seat_no < 1) return null;
  const pay = paymentRow(st.payment_id);
  return pay?.status === "paid" ? st : null;
}

/** The buyer's tickets for friends, in the shape the page and the text tool show. */
export function seatsView(ev, buyerConversationId) {
  return friendSeats(ev.id, buyerConversationId).map((st, i) => {
    const holder = st.state === "claimed" ? db.attendeeRow(ev.id, st.holder_conversation_id) : null;
    return {
      seat_id: st.id, number: i + 1, state: st.state,
      claimed_by: holder ? String(holder.display_name || "a friend").slice(0, 60) : null,
      on_event: holder ? holder.state === "joined" : null,
      link: seatUrl(ev, st),
      // Asked at all, whatever came of it: whether Reason could reach that number is never shown.
      texted_to_someone: st.invite_state != null,
    };
  });
}

/**
 * A new link for an unclaimed seat (the buyer wants it for somebody else, or forwarded it to the
 * wrong person): the old link stops working at once — a claim begun on it fails. `{ ok, seat, url }`.
 */
export function reassignSeat({ ev, buyerConversationId, seatId, now = clock.now() }) {
  const st = buyerSeat(ev, buyerConversationId, seatId);
  if (!st) return { ok: false, reason: "not_found" };
  if (st.state !== "open") return { ok: false, reason: st.state };
  const won = q(`UPDATE event_seats SET claim_token = ?, version = version + 1, invite_conversation_id = NULL, invite_state = NULL, invite_due_at = NULL, updated_at = ?
    WHERE id = ? AND state = 'open' AND version = ?`).run(db.newEventToken(24), now, st.id, st.version);
  if (won.changes !== 1) return { ok: false, reason: "changed" };
  const after = seatById(st.id);
  return { ok: true, seat: after, url: seatUrl(ev, after) };
}

/**
 * The buyer gives back a ticket nobody has claimed, under the event's refund policy (the one their
 * payment was made under, or looser now). `{ ok, amount_cents }` or `{ ok: false, reason, window }`.
 */
export async function seatRefund({ ev, buyerConversationId, seatId, runtime = null, log = () => {}, fetchImpl = globalThis.fetch, now = clock.now() }) {
  const st = buyerSeat(ev, buyerConversationId, seatId);
  if (!st) return { ok: false, reason: "not_found" };
  if (st.state !== "open") return { ok: false, reason: st.state };
  const pay = paymentRow(st.payment_id);
  const window = refundWindow(ev, pay, now);
  if (!window.allowed) return { ok: false, reason: window.why, window, seat: st, pay };
  const r = await refund({ ev, seat: st, why: "buyer", fetchImpl, runtime, log, now });
  return r.ok ? { ok: true, amount_cents: r.amount_cents, seat: st, pay, window } : { ok: false, reason: "stripe", error: r.error, seat: st, pay, window };
}

/** Did this conversation buy tickets for friends on an event that is still on (shows them event_seats)? */
export function hasFriendSeats(conversationId) {
  return !!q(`SELECT 1 FROM event_seats s JOIN event_payments p ON p.id = s.payment_id JOIN events e ON e.id = s.event_id
    WHERE s.conversation_id = ? AND s.seat_no > 0 AND s.state != 'refunded' AND p.status = 'paid' AND e.status != 'cancelled' LIMIT 1`).get(String(conversationId ?? ""));
}

/** The organizer's yes to refunding one ticket a guest bought for a friend that nobody claimed. */
export function organizerSeatRefundTarget(ev, st, pay = paymentRow(st.payment_id)) {
  return `refund ${dollars(pay?.total_cents ?? 0)} unclaimed ticket bought by ${buyerName(ev, st)} for ${String(ev.name).slice(0, 80)} (event #${ev.id}) [seat ${st.id} v${st.version}]`;
}

/** The buyer's yes to giving back one unclaimed ticket: the seat, the amount, the event. */
export function seatRefundTarget(ev, st, pay = paymentRow(st.payment_id)) {
  return `give back the unclaimed ticket ${st.id} for ${String(ev.name).slice(0, 80)} (event #${ev.id}): ${cents2(pay ? refundSplit(pay, "buyer").back_cents : 0)} back [seat ${st.id} v${st.version}]`;
}

/**
 * A friend takes the seat somebody bought them, all or nothing: the seat is still open at the same
 * link (`version`, or `token` from the page), the event is on, they aren't the organizer, already
 * in, or taken off it. They go on as a guest of their own — the place was already counted as theirs,
 * so no capacity check — the link is spent, and the page's answers are filed. The caller sends the
 * welcome (afterJoin, sendWelcome) as for any join, and tellBuyerClaimed.
 * `{ ok: true, attendee, seat }` or `{ ok: false, reason }`: not_found | used | changed | paused |
 * cancelled | organizer | already | removed.
 */
export function claimSeat({ ev, seatId, version = null, token = null, conversationId, displayName, instagram = null, inDirectory = false, via = "seat", answers = null, now = clock.now() }) {
  db.db.exec("BEGIN IMMEDIATE");
  const fail = (reason) => { db.db.exec("ROLLBACK"); return { ok: false, reason }; };
  try {
    const st = seatById(seatId);
    const pay = st ? paymentRow(st.payment_id) : null;
    if (!st || !ev || st.event_id !== ev.id || pay?.status !== "paid") return fail("not_found");
    if (st.state !== "open" || !st.claim_token) return fail("used");
    if ((version != null && Number(version) !== st.version) || (token != null && token !== st.claim_token)) return fail("changed");
    const fresh = db.getEventRow(ev.id);
    if (fresh.status !== "active") return fail(fresh.status);
    if (fresh.organizer_conversation_id === conversationId) return fail("organizer");
    const prior = db.attendeeRow(ev.id, conversationId);
    if (prior?.state === "joined") return fail("already");
    if (prior?.state === "removed") return fail("removed");
    const added = db.addAttendeeTx({ eventId: ev.id, conversationId, displayName: displayName || "Guest", instagram, inDirectory, via, onSeat: true });
    if (!added.ok) return fail(added.reason);
    if (added.already) return fail("already");
    const won = q(`UPDATE event_seats SET state = 'claimed', holder_conversation_id = ?, claim_token = NULL, claimed_at = ?, updated_at = ?,
      invite_state = CASE WHEN invite_state = 'owed' THEN 'dropped' ELSE invite_state END WHERE id = ? AND state = 'open' AND version = ?`).run(conversationId, now, now, st.id, st.version);
    if (won.changes !== 1) return fail("used");
    if (answers) db.fileClaimAnswers(ev.id, added.attendee, answers, "join");
    db.db.exec("COMMIT");
    return { ok: true, attendee: db.attendeeRow(ev.id, conversationId), seat: seatById(st.id) };
  } catch (e) {
    try { db.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** The buyer hears that their friend is in. */
export function tellBuyerClaimed({ runtime = null, log = () => {} }, ev, seat, att) {
  const name = String(att?.display_name || "your friend").slice(0, 60);
  tell({ runtime, log }, seat.conversation_id, `${name} claimed the ticket you got them for ${ev.name} — they're on the guest list now, with their own texts from the event.`);
}

/** Why a seat couldn't be claimed, in the words to say it to the friend. */
export const SEAT_CLAIM_WHY = {
  not_found: "That ticket link doesn't work any more — it may have been refunded. Ask the friend who sent it.",
  used: "That ticket has already been claimed. Each link works once — ask the friend who sent it for another.",
  changed: "That ticket link was changed by the friend who bought it, so this one doesn't work any more. Ask them for the new one.",
  already: "You're already on this event, so this ticket stays for somebody else. Let the friend who sent it know.",
  organizer: "That's your own event.",
  removed: "The organizer took you off this event, so this ticket can't be used by you.",
  paused: "Joining is paused right now. Try the same link again later — the ticket is still yours to claim.",
  cancelled: "This event was cancelled.",
};

// ---------- the one text to a friend the buyer named (optional) ----------
//
// The buyer can give a friend's number instead of forwarding the link. Reason can only text people
// who have texted it before (the line is inbound-only), so this reaches only somebody already on
// Reason; for anybody else nothing goes and the buyer forwards the link. The buyer is told the same
// either way ("if I can reach them…") so it never says who uses Reason. One text per friend per
// event, ever; never at night in the event's zone (it waits for the morning); dropped if the seat is
// claimed, refunded or reassigned first, or the friend is already on the event.

/** The friend's one text: who got it for them, the event, the link as its own message. */
export function seatInviteText(ev, seat) {
  return `${buyerName(ev, seat)} got you a ticket to ${ev.name} — it's already paid for. tap the link to claim it; you'll be on the guest list as yourself, with the event's texts. no need to answer if you can't make it.`;
}

/** Owe the text to the number the buyer gave, when Reason can reach it. Always `{ ok: true }` to the buyer's side (never says who uses Reason). */
export function oweSeatInvite({ ev, buyerConversationId, seatId, number, now = clock.now() }) {
  const st = buyerSeat(ev, buyerConversationId, seatId);
  if (!st) return { ok: false, reason: "not_found" };
  if (st.state !== "open") return { ok: false, reason: st.state };
  // One ask per link, whatever came of it — a second answer that differed would say whether the first number uses Reason.
  if (st.invite_state != null) return { ok: false, reason: "already_sent" };
  const acct = events.accountForNumber(number);
  const c = acct?.conversation_id ?? null;
  const moot = !c || c === buyerConversationId || c === ev.organizer_conversation_id
    || db.attendeeRow(ev.id, c)?.state === "joined" || db.attendeeRow(ev.id, c)?.state === "removed"
    || !!q("SELECT 1 FROM event_seats WHERE event_id = ? AND invite_conversation_id = ? AND invite_state IN ('owed', 'sent', 'dropped')").get(ev.id, c);
  // Written down either way, so a second number for the same seat is a second ask the buyer makes, not a loop.
  q("UPDATE event_seats SET invite_conversation_id = ?, invite_state = ?, invite_due_at = ?, updated_at = ? WHERE id = ?").run(moot ? null : c, moot ? "unreachable" : "owed", now, now, st.id);
  return { ok: true, queued: !moot };
}

/** Send owed friend texts that may go now: compare-and-set, not at night, dropped once moot. */
async function sweepSeatInvites({ runtime, now, log }) {
  const out = { sent: 0, dropped: 0, later: 0 };
  for (const st of q("SELECT * FROM event_seats WHERE invite_state = 'owed' AND invite_due_at <= ?").all(now)) {
    const ev = db.getEventRow(st.event_id);
    const pay = paymentRow(st.payment_id);
    const c = st.invite_conversation_id;
    const stale = ev?.starts_at != null && now > ev.starts_at;
    if (!ev || ev.status === "cancelled" || st.state !== "open" || pay?.status !== "paid" || !c || stale || db.attendeeRow(ev.id, c)?.state === "joined") {
      q("UPDATE event_seats SET invite_state = 'dropped', updated_at = ? WHERE id = ? AND invite_state = 'owed'").run(now, st.id); out.dropped++; continue;
    }
    if (ev.status === "paused" || events.listNoteQuiet(ev, now) || !runtime?._tell) { out.later++; continue; }
    if (q("UPDATE event_seats SET invite_state = 'sent', invited_at = ?, updated_at = ? WHERE id = ? AND invite_state = 'owed'").run(now, now, st.id).changes !== 1) continue;
    const text = seatInviteText(ev, st);
    for (const body of [text, seatUrl(ev, st)]) {
      const m = db.insertEventMessage(ev.id, "seat_invite", body);
      await events.deliver({ runtime, message: m, conversationId: c });
    }
    events.intoThread({ runtime, conversationId: c, about: `a ticket a friend bought them for ${String(ev.name).slice(0, 80)}`, body: text });
    log({ event_seat_invite_sent: ev.id, seat: st.id });
    out.sent++;
  }
  return out;
}

// ---------- the sweep: holds that ran out ----------

async function expireRow(row, { fetchImpl = globalThis.fetch, now = clock.now(), log = () => {} }) {
  q("UPDATE event_payments SET status = 'expired', answers = NULL, updated_at = ? WHERE id = ? AND status = 'open'").run(now, row.id);
  if (!row.checkout_session_id) return;
  // Best effort: the page stops taking payment. A payment that lands anyway is settled and, with no
  // spot left, refunded (settlePaid).
  const r = await stripe.api("POST", `/v1/checkout/sessions/${encodeURIComponent(row.checkout_session_id)}/expire`, {}, { fetchImpl });
  if (!r.ok) log({ event_checkout_expire_failed: row.id, status: r.status });
}

/** Holds past their 15 minutes: released, and the Checkout page expired on Stripe. `{ expired }`. */
export async function sweep({ now = clock.now(), log = () => {}, fetchImpl = globalThis.fetch, runtime = null } = {}) {
  const rows = q("SELECT * FROM event_payments WHERE status = 'open' AND expires_at <= ?").all(now);
  for (const row of rows) await expireRow(row, { fetchImpl, now, log });
  // And the one text a buyer asked Reason to send a friend, once it may go.
  const invites = await sweepSeatInvites({ runtime, now, log });
  // Refunds Stripe may have done (no answer, 5xx): replayed under their own key until Stripe answers.
  const pendingDone = await refundPending({ now, log, fetchImpl, runtime });
  // Reason's 2.5% still owed back to an organizer after a guest's own cancel (Stripe said no, or didn't answer).
  let feesBack = 0;
  for (const row of q("SELECT id FROM event_payments WHERE fee_back_owed_cents > 0 AND fee_back_seq < 30 LIMIT 20").all()) if ((await feeBack(row.id, { fetchImpl, log, now })).ok) feesBack++;
  return { expired: rows.length, ...(invites.sent || invites.dropped ? { seat_invites: invites } : {}), ...(feesBack ? { fees_back: feesBack } : {}), ...(pendingDone ? { refunds_settled: pendingDone } : {}) };
}

// ---------- what the organizer sees ----------

/**
 * The money on one event, counted in TICKETS (one payment can be several: the buyer's and their
 * friends'). Sold is every ticket a payment landed for (refunded ones included; a payment refunded
 * at once for want of room sold none); gross is the price × sold (the processing guests paid is
 * Stripe's, never in it); refunded is the price of the tickets given back; Reason's 2.5% is on the
 * tickets that stand; coming to the organizer is the rest. gross − refunded − Reason's fee = coming.
 * `paid_count` is the tickets standing, `unclaimed_count` those bought for friends not claimed yet.
 */
export function summary(ev, now = clock.now()) {
  const seats = q(`SELECT s.state, p.price_cents, p.total_cents, p.application_fee_cents, p.refund_error FROM event_seats s JOIN event_payments p ON p.id = s.payment_id
    WHERE s.event_id = ? AND p.status IN ('paid', 'refunded')`).all(ev.id);
  const standing = seats.filter(r => r.state !== "refunded");
  const back = seats.filter(r => r.state === "refunded");
  const standingCents = standing.reduce((t, r) => t + r.price_cents, 0);
  const refundedCents = back.reduce((t, r) => t + r.price_cents, 0);
  const net = standing.reduce((t, r) => t + (r.total_cents - r.application_fee_cents), 0);
  const failedRefunds = Number(q("SELECT COUNT(*) AS n FROM event_payments WHERE event_id = ? AND status = 'paid' AND refund_error IS NOT NULL").get(ev.id).n);
  return {
    price_cents: ev.price_cents ?? null, paid_count: standing.length, sold_count: seats.length,
    gross_cents: standingCents + refundedCents, refunded_count: back.length, refunded_cents: refundedCents,
    reason_fee_cents: standingCents - net, organizer_net_cents: net,
    // What went back to cards: the price on a guest's own cancel, the whole ticket otherwise (a refunded row from before refunded_cents holds 0: all of it).
    returned_cents: Number(q("SELECT COALESCE(SUM(CASE WHEN refunded_cents > 0 THEN refunded_cents WHEN status = 'refunded' THEN total_cents * quantity ELSE 0 END), 0) AS c FROM event_payments WHERE event_id = ? AND status IN ('paid', 'refunded')").get(ev.id).c),
    unclaimed_count: standing.filter(r => r.state === "open").length,
    buyers_count: Number(q("SELECT COUNT(DISTINCT p.conversation_id) AS n FROM event_payments p WHERE p.event_id = ? AND p.status = 'paid'").get(ev.id).n),
    open_holds: openHolds(ev.id, now), failed_refunds: failedRefunds,
  };
}

// ---------- the organizer's payouts, as Stripe has them ----------

const payoutCache = new Map();
const PAYOUT_CACHE_MS = 60_000;

/**
 * The organizer's balance and next payout from Stripe (their connected account: GET /v1/balance and
 * /v1/payouts with Stripe-Account). Account-wide — every event of theirs together. Kept a minute, so a
 * page reload does not ask Stripe again. `{ ok: true, available_cents, pending_cents, next, last }`
 * (next/last `{ amount_cents, arrival_at, status }` or null), or `{ ok: false, why }` with why one of
 * `no_account`, `not_ready`, `stripe`.
 */
export async function payoutInfo(conversationId, { fetchImpl = globalThis.fetch, timeoutMs = 4000, now = clock.now(), fresh = false } = {}) {
  const acct = payoutAccount(conversationId);
  if (!acct) return { ok: false, why: "no_account" };
  if (!acct.charges_enabled) return { ok: false, why: "not_ready" };
  const hit = payoutCache.get(conversationId);
  if (!fresh && hit && now - hit.at < PAYOUT_CACHE_MS && hit.account === acct.stripe_account_id) return hit.info;
  const opts = { fetchImpl, timeoutMs, stripeAccount: acct.stripe_account_id };
  const [bal, pays] = await Promise.all([stripe.api("GET", "/v1/balance", null, opts), stripe.api("GET", "/v1/payouts?limit=10", null, opts)]);
  let info;
  if (!bal.ok || !pays.ok) info = { ok: false, why: "stripe", error: String((bal.ok ? pays : bal).body?.error?.message ?? "no answer").slice(0, 160) };
  else {
    const sum = (list) => (Array.isArray(list) ? list : []).filter(b => (b.currency ?? "usd") === "usd").reduce((t, b) => t + Number(b.amount ?? 0), 0);
    const list = Array.isArray(pays.body?.data) ? pays.body.data : [];
    const shape = (po) => po ? { amount_cents: Number(po.amount ?? 0), arrival_at: po.arrival_date ? Number(po.arrival_date) * 1000 : null, status: String(po.status ?? "") } : null;
    const next = list.filter(po => po.status === "pending" || po.status === "in_transit").sort((a, b) => (a.arrival_date ?? 0) - (b.arrival_date ?? 0))[0];
    const last = list.filter(po => po.status === "paid").sort((a, b) => (b.arrival_date ?? 0) - (a.arrival_date ?? 0))[0];
    info = { ok: true, available_cents: sum(bal.body?.available), pending_cents: sum(bal.body?.pending), next: shape(next), last: shape(last) };
  }
  payoutCache.set(conversationId, { at: now, account: acct.stripe_account_id, info });
  return info;
}

/** What payoutInfo last said for this organizer (a page renders without waiting on Stripe), or null. */
export function cachedPayoutInfo(conversationId) {
  return payoutCache.get(conversationId)?.info ?? null;
}
export function forgetPayoutInfo() { payoutCache.clear(); }

/** A date the organizer reads: "Fri, Nov 13". */
function dayWords(ms, tz) {
  return new Date(ms).toLocaleDateString("en-US", { timeZone: tz || config.installTz || "America/New_York", weekday: "short", month: "short", day: "numeric" });
}

/** The next payout in one plain line, from payoutInfo's answer. */
export function payoutLine(info, tz = null) {
  if (!info) return "Your Stripe dashboard has your payouts.";
  if (!info.ok) return info.why === "stripe" ? "Not available right now — Stripe didn't answer. Your Stripe dashboard has it." : "Not available yet — it shows here once payouts are set up and a payment has come in.";
  if (info.next) return `${dollars(info.next.amount_cents)} ${info.next.status === "in_transit" ? "on its way, arriving" : "arriving"} ${info.next.arrival_at ? dayWords(info.next.arrival_at, tz) : "soon"} (all your events together).`;
  if (info.pending_cents > 0) return `None scheduled yet — ${dollars(info.pending_cents)} is still clearing at Stripe, then it's paid out to your bank on Stripe's schedule.`;
  if (info.available_cents > 0) return `None scheduled yet — ${dollars(info.available_cents)} is ready and goes out on Stripe's next payout.`;
  return "Not available yet — nothing is waiting to be paid out.";
}

/** Ticket sales in plain words, for the organizer by text. */
export function salesWords(ev, s = summary(ev), info = null) {
  if (!s.sold_count) return `No tickets sold yet for ${ev.name}.${s.open_holds ? ` ${s.open_holds} ticket${s.open_holds === 1 ? " is" : "s are"} being paid for right now.` : ""}`;
  const parts = [
    `${s.sold_count} ticket${s.sold_count === 1 ? "" : "s"} sold for ${ev.name} — ${dollars(s.gross_cents)} gross.`,
    ...(s.unclaimed_count ? [`${s.unclaimed_count} of them ${s.unclaimed_count === 1 ? "was" : "were"} bought for friends who haven't claimed ${s.unclaimed_count === 1 ? "it" : "them"} yet (each holds a spot).`] : []),
    s.refunded_count ? `${s.refunded_count} refunded (${dollars(s.refunded_cents)}).` : "No refunds.",
    `Reason's 2.5%: ${dollars(s.reason_fee_cents)}. Coming to you: ${dollars(s.organizer_net_cents)}.`,
    `Next payout: ${payoutLine(info, ev.tz)}`,
  ];
  return parts.join(" ");
}

/**
 * Each ticket that stands, for the manage page and event_guests: who holds it (a guest — the buyer,
 * or a friend who claimed it) or nobody yet (`unclaimed`), and who bought it when that was somebody else.
 */
export function paidGuests(ev) {
  const rows = q(`SELECT s.*, p.total_cents, p.price_cents, p.paid_at, p.refund_error AS pay_refund_error, p.display_name AS buyer_display_name FROM event_seats s JOIN event_payments p ON p.id = s.payment_id
    WHERE s.event_id = ? AND s.state != 'refunded' AND p.status = 'paid' ORDER BY p.paid_at, p.id, s.seat_no`).all(ev.id);
  return rows.map(st => {
    const att = st.state === "claimed" ? db.attendeeRow(ev.id, st.holder_conversation_id) : null;
    const friend = st.seat_no > 0 && st.holder_conversation_id !== st.conversation_id;
    return {
      payment_id: st.payment_id, seat_id: st.id, seat_no: st.seat_no, guest_id: att?.id ?? null,
      display_name: att?.display_name || (st.state === "open" ? null : st.buyer_display_name), unclaimed: st.state === "open",
      bought_by: friend || st.state === "open" ? buyerName(ev, st) : null,
      total_cents: st.total_cents, price_cents: st.price_cents, paid_at: st.paid_at, state: att?.state ?? (st.state === "open" ? "unclaimed" : "unknown"),
      refund_error: st.refund_error ?? st.pay_refund_error ?? null,
    };
  });
}

/** The yes to a refund covers one guest, one amount, one event: pinned to the payment row. */
export function refundTarget(ev, row) {
  const name = String(db.attendeeRow(ev.id, row.conversation_id)?.display_name || row.display_name || "a guest").slice(0, 60);
  return `refund ${dollars(row.total_cents)} to ${name} for ${String(ev.name).slice(0, 80)} (event #${ev.id}) [pay ${row.id}${seatPin(row)}]`;
}
