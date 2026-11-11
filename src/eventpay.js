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
// A refund gives the guest the whole total back (the transfer is reversed and the application fee
// refunded), which means a refund costs Reason the processing Stripe keeps: the price of guests not
// paying twice. Nothing about a payment is ever decided from a page or a text: a spot is held when a
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
// Tables made before refund policies (2026-11-11) get the two columns.
for (const [col, decl] of [["refund_policy", "TEXT"], ["refund_hours", "INTEGER"]]) {
  if (!db.db.prepare("PRAGMA table_info(event_payments)").all().some(c => c.name === col)) db.db.exec(`ALTER TABLE event_payments ADD COLUMN ${col} ${decl}`);
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
/** This person's live payment on this event: paid, or an open hold that has not run out. */
export function paidRow(eventId, conversationId) {
  return q("SELECT * FROM event_payments WHERE event_id = ? AND conversation_id = ? AND status = 'paid' ORDER BY id DESC").get(Number(eventId), conversationId) ?? null;
}
export function openRow(eventId, conversationId, now = clock.now()) {
  return q("SELECT * FROM event_payments WHERE event_id = ? AND conversation_id = ? AND status = 'open' AND expires_at > ? ORDER BY id DESC").get(Number(eventId), conversationId, now) ?? null;
}
/** Spots held by Checkout pages that are still open. */
export function openHolds(eventId, now = clock.now()) {
  return Number(q("SELECT COUNT(*) AS n FROM event_payments WHERE event_id = ? AND status = 'open' AND expires_at > ?").get(Number(eventId), now).n);
}
/** Places left under the cap, counting people in AND spots held for a payment in progress. Infinity with no cap. */
export function spotsLeft(ev, now = clock.now()) {
  if (ev.capacity == null) return Infinity;
  return ev.capacity - db.joinedCount(ev.id) - openHolds(ev.id, now);
}
export function paidRows(eventId) {
  return q("SELECT * FROM event_payments WHERE event_id = ? AND status = 'paid' ORDER BY paid_at, id").all(Number(eventId));
}

/** Does this conversation hold a paid ticket on an event that is still on? (Shows them event_ticket_refund.) */
export function holdsTicket(conversationId) {
  return !!q("SELECT 1 FROM event_payments p JOIN events e ON e.id = p.event_id WHERE p.conversation_id = ? AND p.status = 'paid' AND e.status != 'cancelled' LIMIT 1").get(String(conversationId ?? ""));
}

/** Where Stripe sends the guest after paying, or after changing their mind — both on the events domain. */
const successUrl = (ev) => `${events.eventUrl(ev)}/paid`;
const cancelUrl = (ev) => `${events.eventUrl(ev)}/pay-back`;

/**
 * Start a payment for one spot: a hold on the row, a Checkout Session on Stripe. One open link per
 * person per event — asked twice, they get the same page. `{ ok: true, url, row, quote, reused }` or
 * `{ ok: false, reason }` with reason one of `not_paid`, `paused`, `cancelled`, `organizer`, `already`,
 * `removed`, `full`, `no_payouts`, `stripe` (with `error`).
 */
export async function startCheckout({ ev, conversationId, displayName, instagram = null, inDirectory = false, via = "text", answers = null, fetchImpl = globalThis.fetch, now = clock.now(), log = () => {} }) {
  if (!priced(ev)) return { ok: false, reason: "not_paid" };
  if (ev.status !== "active") return { ok: false, reason: ev.status };
  if (ev.organizer_conversation_id === conversationId) return { ok: false, reason: "organizer" };
  const prior = db.attendeeRow(ev.id, conversationId);
  if (prior?.state === "joined") return { ok: false, reason: "already", attendee: prior };
  if (prior?.state === "removed") return { ok: false, reason: "removed" };
  const paid = paidRow(ev.id, conversationId);
  if (paid) return { ok: false, reason: "already", paid };
  const open = openRow(ev.id, conversationId, now);
  if (open?.checkout_url) return { ok: true, url: open.checkout_url, row: open, quote: quote(open.price_cents), reused: true };
  if (spotsLeft(ev, now) <= 0) return { ok: false, reason: "full" };
  const acct = payoutAccount(ev.organizer_conversation_id);
  if (!acct?.charges_enabled) return { ok: false, reason: "no_payouts" };
  const qt = quote(ev.price_cents);
  // The answers ride on the row (as the claim carries them for a free join) and are filed by settlePaid.
  const answersJson = Array.isArray(answers) ? (answers.length ? JSON.stringify(answers) : null) : (typeof answers === "string" && answers ? answers : null);
  // The policy this ticket is sold under rides on the row: a later tightening never reaches it.
  const pol = policyOf(ev);
  const id = Number(q(`INSERT INTO event_payments (event_id, conversation_id, display_name, instagram, in_directory, via, answers, price_cents, processing_cents, total_cents, application_fee_cents, currency, refund_policy, refund_hours, status, created_at, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(ev.id, conversationId, String(displayName ?? ""), instagram ?? null, inDirectory ? 1 : 0, via, answersJson, qt.price, qt.processing, qt.total, qt.application_fee, ev.currency || "usd", pol.policy, pol.hours, now, now + HOLD_MS, now).lastInsertRowid);
  const currency = ev.currency || "usd";
  const r = await stripe.api("POST", "/v1/checkout/sessions", {
    mode: "payment",
    client_reference_id: `evpay:${id}`,
    line_items: [
      { quantity: 1, price_data: { currency, unit_amount: qt.price, product_data: { name: `${String(ev.name).slice(0, 100)} · 1 person`, description: refundPolicyLine(pol) } } },
      { quantity: 1, price_data: { currency, unit_amount: qt.processing, product_data: { name: "Processing" } } },
    ],
    payment_intent_data: {
      application_fee_amount: qt.application_fee,
      transfer_data: { destination: acct.stripe_account_id },
      metadata: { reason_kind: "event_ticket", event_payment_id: String(id), event_id: String(ev.id) },
    },
    metadata: { reason_kind: "event_ticket", event_payment_id: String(id), event_id: String(ev.id), conversation_id: conversationId },
    // The refund policy, said on Stripe's page right above the Pay button.
    custom_text: { submit: { message: `${refundPolicyLine(pol)}${pol.policy === "none" ? "" : " Ask Reason by text, or use your event page, to get your refund."}` } },
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
  log({ event_checkout: ev.id, payment: id });
  return { ok: true, url: String(r.body.url), row: paymentRow(id), quote: qt, reused: false };
}

/** The words that go with the link, by text: the price, the hold, what happens next. */
export function payLinkText(ev, qt = quote(ev.price_cents)) {
  return `${ev.name} is ${dollars(qt.price)} per person (${dollars(qt.total)} with processing). ${refundPolicyLine(policyOf(ev)).toLowerCase()} your spot is held for 15 minutes while you pay here — you're in once the payment goes through, and i'll text you then:`;
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
      if (row.status === "paid" && (obj.refunded || Number(obj.amount_refunded ?? 0) >= Number(obj.amount ?? row.total_cents))) {
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
    q("UPDATE event_payments SET status = 'paid', payment_intent_id = COALESCE(?, payment_intent_id), total_cents = COALESCE(?, total_cents), paid_at = ?, updated_at = ? WHERE id = ?")
      .run(intentId, total, now, now, row.id);
    added = !ev ? { ok: false, reason: "not_found" }
      : ev.status !== "active" ? { ok: false, reason: ev.status }
      : db.addAttendeeTx({ eventId: ev.id, conversationId: row.conversation_id, displayName: row.display_name || "Guest", instagram: row.instagram, inDirectory: !!row.in_directory, via: row.via });
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
    const words = { full: "filled up before your payment landed", cancelled: "was cancelled", paused: "is paused right now", removed: "isn't open to you", organizer: "is your own", already: "already had you on it" }[added.reason] ?? "couldn't take your join";
    tell(ctx, row.conversation_id, r.ok
      ? `sorry — ${ev?.name ?? "the event"} ${words}, so i've refunded your ${dollars(paid.total_cents)} in full. it shows up on your card in a few days.`
      : `sorry — ${ev?.name ?? "the event"} ${words}. your ${dollars(paid.total_cents)} is being refunded; if it hasn't shown up in a few days, tell me.`);
    return { paid: true, joined: false, refunded: r.ok, reason: added.reason };
  }
  const att = events.afterJoin({ ev, att: added.attendee, typedInstagram: row.instagram });
  // The answers they gave on the page or by text, filed now that they are in (a reworded question drops its answer).
  if (paid.answers) { try { db.fileClaimAnswers(ev.id, att, paid.answers, row.via === "text" ? "text" : "join"); } catch (e) { log({ event_pay_answers_failed: row.id, why: (e?.message ?? String(e)).split("\n")[0] }); } }
  q("UPDATE event_payments SET answers = NULL WHERE id = ?").run(row.id);
  const receipt = db.insertEventMessage(ev.id, "receipt", receiptBody(ev, paid));
  await events.deliver({ runtime, message: receipt, conversationId: row.conversation_id });
  await events.sendWelcome({ runtime, ev, att });
  events.scheduleListNote({ runtime, ev, att });
  // A new guest the event onboarding covers (src/eventonboarding.js): its one line, now they are in.
  await eventonb.afterPaid({ runtime, ev, conversationId: row.conversation_id, organizer: events.organizerName(ev), log })
    .catch(e => log({ event_onboarding_paid_failed: row.conversation_id, why: (e?.message ?? String(e)).split("\n")[0] }));
  return { paid: true, joined: true, already: !!added.already };
}

/** The paid-join text: what they paid, and the refund policy their ticket is held to. */
export function receiptBody(ev, row) {
  const p = ticketPolicy(ev, row);
  const tail = p.policy === "none" ? "no refunds on this one."
    : `${refundPolicyLine(p).toLowerCase().replace(/\.$/, "")} — just text me "refund my ticket" if plans change.`;
  return `paid ${dollars(row.total_cents)} for ${ev.name} — you're in. ${tail}`;
}

// ---------- refunds ----------

/** What a refunded guest is told. */
export function refundedBody(ev, totalCents, { cancelled = false, guest = false } = {}) {
  if (guest) return `done — your ${dollars(totalCents)} for ${ev.name} is refunded in full, so you're off its guest list. it shows up on your card in a few days.`;
  return cancelled
    ? `${ev.name} is cancelled, so your ${dollars(totalCents)} has been refunded in full. it shows up on your card in a few days.`
    : `the organizer refunded your ${dollars(totalCents)} for ${ev.name}, so you're no longer on its guest list. it shows up on your card in a few days.`;
}

/**
 * Give one guest the whole amount back: the transfer to the organizer is reversed and Reason's fee
 * refunded, so the guest sees one full refund. Then they are off the event and told. Idempotent on
 * the row. `{ ok: true, refund_id }` or `{ ok: false, reason, error }`.
 */
export async function refund({ ev, row, why = "organizer", fetchImpl = globalThis.fetch, runtime = null, log = () => {}, now = clock.now(), tellGuest = true, cancelled = false, leave = true }) {
  const cur = paymentRow(row.id);
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.status === "refunded") return { ok: true, refund_id: cur.refund_id, already: true };
  if (cur.status !== "paid" || !cur.payment_intent_id) return { ok: false, reason: "not_paid" };
  // The key carries the attempt, so a retry after Stripe said no is a new request, not the replayed no.
  const r = await stripe.api("POST", "/v1/refunds", {
    payment_intent: cur.payment_intent_id, reverse_transfer: true, refund_application_fee: true,
    metadata: { reason_kind: "event_ticket", event_payment_id: String(cur.id), why: String(why).slice(0, 40) },
  }, { fetchImpl, idempotencyKey: `evrefund:${cur.id}:${cur.refund_attempts}` });
  if (!r.ok) {
    const error = r.body?.error?.message ?? `Stripe answered ${r.status}`;
    q("UPDATE event_payments SET refund_error = ?, refund_attempts = refund_attempts + 1, updated_at = ? WHERE id = ?").run(String(error).slice(0, 300), now, cur.id);
    log({ event_refund_failed: cur.id, why: String(error).slice(0, 160) });
    return { ok: false, reason: "stripe", error };
  }
  await afterRefund(cur, { refundId: r.body?.id ?? null, why, tellGuest, cancelled, leave }, { runtime, now, log });
  return { ok: true, refund_id: r.body?.id ?? null };
}

/** The row goes refunded, the guest leaves the event (unless the payment never got them in: `leave` false), and is told (unless the caller says it). */
async function afterRefund(row, { refundId = null, why = "organizer", tellGuest = true, cancelled = false, leave = true }, { runtime = null, now = clock.now(), log = () => {} }) {
  q("UPDATE event_payments SET status = 'refunded', refund_id = ?, refund_error = NULL, answers = NULL, refunded_at = ?, updated_at = ? WHERE id = ? AND status = 'paid'").run(refundId, now, now, row.id);
  const ev = db.getEventRow(row.event_id);
  const att = ev ? db.attendeeRow(ev.id, row.conversation_id) : null;
  // They leave only when no payment of theirs still stands (a refunded duplicate never costs a spot that is paid for).
  if (leave && att?.state === "joined" && att.role === "guest" && !paidRow(ev.id, row.conversation_id)) {
    db.leaveAttendee(att.id);
    try { const rides = await import("./eventrides.js"); await rides.leftEvent({ runtime, ev, conversationId: row.conversation_id }); } catch { /* rides are optional */ }
  }
  log({ event_refunded: row.id, why });
  if (tellGuest && ev) {
    const message = db.insertEventMessage(ev.id, "refund", refundedBody(ev, row.total_cents, { cancelled: cancelled || why === "cancelled", guest: why === "guest" }));
    await events.deliver({ runtime, message, conversationId: row.conversation_id });
  }
  // A guest's own refund: the organizer hears it in one line (their sale went back, under their policy).
  if (why === "guest" && ev) {
    const name = String(att?.display_name || row.display_name || "A guest").slice(0, 60);
    tell({ runtime, log }, ev.organizer_conversation_id, `${name} asked for a refund on ${ev.name} and got ${dollars(row.total_cents)} back under your refund policy, so they're off the guest list.`);
  }
}

/**
 * A guest's own ask for their money back. Under the policy their ticket is held to it is refunded in
 * full (exactly as an organizer's refund: transfer reversed, Reason's fee refunded), they leave and
 * both they and the organizer are told. Outside it, nothing happens: `{ ok: false, reason, window }`.
 */
export async function guestRefund({ ev, conversationId, runtime = null, log = () => {}, fetchImpl = globalThis.fetch, now = clock.now() }) {
  const row = ev ? paidRow(ev.id, conversationId) : null;
  if (!row) return { ok: false, reason: "not_paid" };
  const window = refundWindow(ev, row, now);
  if (!window.allowed) return { ok: false, reason: window.why, window, row };
  const r = await refund({ ev, row, why: "guest", fetchImpl, runtime, log, now });
  return r.ok ? { ok: true, refund_id: r.refund_id, row, window } : { ok: false, reason: "stripe", error: r.error, row, window };
}

/** Why a guest's refund can't happen, in the words to say it in (the organizer can always still choose to). */
export function refusalWords(ev, window) {
  // A start time the organizer hasn't shared is never told by the wording: "started" reads as "closed".
  if (!ev.time_released && window.why === "started") window = { ...window, why: "closed" };
  const lead = { no_refunds: `${ev.name} has a no-refunds policy`, closed: `the refund window for ${ev.name} has closed (${refundPolicyLine(window.policy).toLowerCase().replace(/\.$/, "")})`, started: `${ev.name} has already started`, not_active: `${ev.name} isn't taking refund requests` }[window.why] ?? "that ticket can't be refunded automatically";
  return `${lead}, so I can't refund it myself — but the organizer can still choose to refund you, so it's worth asking them.`;
}

/** The guest's yes covers their one ticket on one event, pinned to the payment row. */
export function guestRefundTarget(ev, row) {
  return `refund my ${dollars(row.total_cents)} ticket for ${String(ev.name).slice(0, 80)} (event #${ev.id}) [pay ${row.id}]`;
}

/** Every paid guest refunded, for a cancellation. `{ refunded, failed, total_cents }`. */
export async function refundAll({ ev, runtime = null, log = () => {}, fetchImpl = globalThis.fetch, now = clock.now() }) {
  const out = { refunded: 0, failed: 0, total_cents: 0 };
  for (const row of paidRows(ev.id)) {
    const r = await refund({ ev, row, why: "cancelled", cancelled: true, fetchImpl, runtime, log, now });
    if (r.ok) { out.refunded++; out.total_cents += row.total_cents; } else out.failed++;
  }
  // Nobody can pay for a cancelled event, but a Checkout page still open would let them try.
  for (const row of q("SELECT * FROM event_payments WHERE event_id = ? AND status = 'open'").all(ev.id)) await expireRow(row, { fetchImpl, now, log });
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
export async function sweep({ now = clock.now(), log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const rows = q("SELECT * FROM event_payments WHERE status = 'open' AND expires_at <= ?").all(now);
  for (const row of rows) await expireRow(row, { fetchImpl, now, log });
  return { expired: rows.length };
}

// ---------- what the organizer sees ----------

/**
 * The money on one event. Sold counts every ticket that was paid for (refunded ones included); gross
 * is the ticket price × sold (the processing guests paid is Stripe's, never in it); refunded is the
 * price of the tickets given back; Reason's 2.5% is on the tickets that stand (a refunded ticket earns
 * Reason nothing); coming to the organizer is the rest. gross − refunded − Reason's fee = coming.
 */
export function summary(ev, now = clock.now()) {
  const paid = paidRows(ev.id);
  const back = q("SELECT price_cents FROM event_payments WHERE event_id = ? AND status = 'refunded'").all(ev.id);
  const standing = paid.reduce((s, r) => s + r.price_cents, 0);
  const refundedCents = back.reduce((s, r) => s + r.price_cents, 0);
  const net = paid.reduce((s, r) => s + (r.total_cents - r.application_fee_cents), 0);
  const failedRefunds = Number(q("SELECT COUNT(*) AS n FROM event_payments WHERE event_id = ? AND status = 'paid' AND refund_error IS NOT NULL").get(ev.id).n);
  return {
    price_cents: ev.price_cents ?? null, paid_count: paid.length, sold_count: paid.length + back.length,
    gross_cents: standing + refundedCents, refunded_count: back.length, refunded_cents: refundedCents,
    reason_fee_cents: standing - net, organizer_net_cents: net,
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
  if (!s.sold_count) return `No tickets sold yet for ${ev.name}.${s.open_holds ? ` ${s.open_holds} ${s.open_holds === 1 ? "person is" : "people are"} paying right now.` : ""}`;
  const parts = [
    `${s.sold_count} ticket${s.sold_count === 1 ? "" : "s"} sold for ${ev.name} — ${dollars(s.gross_cents)} gross.`,
    s.refunded_count ? `${s.refunded_count} refunded (${dollars(s.refunded_cents)}).` : "No refunds.",
    `Reason's 2.5%: ${dollars(s.reason_fee_cents)}. Coming to you: ${dollars(s.organizer_net_cents)}.`,
    `Next payout: ${payoutLine(info, ev.tz)}`,
  ];
  return parts.join(" ");
}

/** Each paid guest, with their payment, for the manage page and event_guests. */
export function paidGuests(ev) {
  return paidRows(ev.id).map(r => {
    const att = db.attendeeRow(ev.id, r.conversation_id);
    return { payment_id: r.id, guest_id: att?.id ?? null, display_name: att?.display_name || r.display_name, total_cents: r.total_cents, price_cents: r.price_cents, paid_at: r.paid_at, state: att?.state ?? "unknown", refund_error: r.refund_error ?? null };
  });
}

/** The yes to a refund covers one guest, one amount, one event: pinned to the payment row. */
export function refundTarget(ev, row) {
  const name = String(db.attendeeRow(ev.id, row.conversation_id)?.display_name || row.display_name || "a guest").slice(0, 60);
  return `refund ${dollars(row.total_cents)} to ${name} for ${String(ev.name).slice(0, 80)} (event #${ev.id}) [pay ${row.id}]`;
}
