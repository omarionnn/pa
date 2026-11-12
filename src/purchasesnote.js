// What this person has really bought (or tried to) with AgentCard, read from the database and nothing
// else: as a block on the turns where buying is in play, and as a tool (`purchases_recent`) the model
// can call on any turn.
//
// The incident (2026-10-24): Reason told the owner "the cerave's ordered" (Walmart, $16.76). AgentCard
// cancelled that order a few minutes later; the webhook marked the row cancelled (#92) and, by design,
// that one cancellation was never texted. At 13:45Z the owner asked "can you check to see if target
// has it and if they ship to my address" and Reason said "the Walmart order already went through this
// morning, so this would be a second bottle" — false, and no tool was called. The only thing it had
// about purchases was its own old line in the thread, so it believed it.
//
// So the current record goes in front of the model: date, merchant, item, amount, and where it stands
// now in plain words, under a line saying it overrides the chat. Tiny on purpose: at most a handful of
// lines, no ids, and a `shopping` row that never got a cart is somebody browsing, not a purchase.
//
// WHEN the block rides (startPurchasesNote, 2026-10-27, replacing the meaning gate of #95). On every
// message of theirs while they have a purchase in the 14-day window, under a line telling the model to
// use it only when the message is about buying — so the main model, which is reading the message
// anyway, is the one that judges what it means (the repo's rule: AI reads meaning, never regex).
// There used to be a side call in front of that ("is this about buying?", yes/no on the small model):
// in the 24h to 2026-10-27 21:00Z it ran 48 times live: 31 over the paid Anthropic API (which Reason
// must never bill), 6 over claude-cli at ~5s each, and 11 that failed after ~5s ("the CLI reported
// an error: no detail") — all of it in front of the reply. Showing the block on a superset of the turns it used
// to ride on keeps the incident case covered with no call at all: nothing waits, nothing can fail,
// nothing is billed. Turns that are not a person's message (events, sweeps) still go by the
// structural signals below, so a timer never raises a purchase of its own accord.
//
// The structural signals (purchasesNote, and the fallback), which need no reading of the message:
//   - a purchase row of theirs was created or changed in the last 48 hours (an order placed,
//     declined, cancelled by a webhook — the incident: row cancelled 13:36, question 13:45), or
//   - a buying tool ran for them in the last 6 hours (the ledger), or a product offer was read for
//     them in that time (the offers table) — i.e. a shopping flow is going on right now.
// The model can always read the same list itself with purchases_recent, whose description tells it to
// check before saying whether anything was ordered.
import * as db from "./db.js";
import { refusalWhy, REFUSAL_WHOSE } from "./agentcard.js";
import { config, clock } from "./config.js";
import { connectAllowedFor } from "./shopconnect.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const PURCHASE_DAYS = 14;
export const PURCHASE_MAX = 5;
/** A purchase row this fresh means buying is in play. */
export const ROW_FRESH_MS = 48 * HOUR;
/** A buying tool or offer read this recent means a shopping flow is going on. */
export const FLOW_FRESH_MS = 6 * HOUR;
/** The tools that are a shopping flow. Ledgered ones (OUTSIDE_WORLD) leave the row this reads. */
export const BUYING_TOOLS = ["purchase", "purchase_confirm", "purchase_track", "offer_check", "shop_handoff", "vault_enroll"];

/** Where a row stands, in the words the model should use. Unknown statuses pass through as-is. */
const STATUS_WORDS = {
  placed: "placed",
  partially_placed: "partly placed (only some items went through)",
  cancelled: "CANCELLED by the shop, not coming",
  declined: "declined, not bought",
  failed: "failed, not bought",
  awaiting_approval: "pending their approval, not charged yet",
  outcome_unknown: "pending, outcome unknown",
  cart_shown: "cart shown only, not bought",
  shopping: "cart shown only, not bought",
};

export function statusWords(status) {
  return STATUS_WORDS[status] ?? String(status || "unknown");
}

/**
 * A flight row's status. A placed flight order is NOT "placed" in the sense a parcel is: approval,
 * payment, ticketing pending and ticket issued are four different things (src/flightbook.js), and
 * only an issued ticket — which needs evidence nobody has seen yet — is "booked".
 */
const FLIGHT_WORDS = {
  quoted: "flight priced only, not booked",
  approval_pending: "flight waiting for their approval, not charged, not booked",
  payment_approved: "flight payment approved, no order yet, not booked",
  reserved: "flight seats held, no ticket issued",
  ticketing_pending: "flight paid or being paid, TICKETING NOT CONFIRMED — not booked",
  issued: "flight booked, ticket issued",
  declined: "flight declined, not booked",
  outcome_unknown: "flight outcome unknown — not known whether it was booked",
  cancelled: "flight CANCELLED, not flying",
  expired: "flight approval ran out, not charged, not booked",
};
export function flightStatusWords(row) {
  if (row.status === "cancelled") return FLIGHT_WORDS.cancelled;
  if ((row.status === "declined" || row.status === "failed") && row.decline_code === "approval_expired") return FLIGHT_WORDS.expired;
  if (row.status === "declined" || row.status === "failed") return FLIGHT_WORDS.declined;
  if (row.status === "outcome_unknown") return FLIGHT_WORDS.outcome_unknown;
  if (row.status === "placed" || row.status === "partially_placed") return row.ticketing_state === "issued" ? FLIGHT_WORDS.issued : row.ticketing_state === "reserved" ? FLIGHT_WORDS.reserved : FLIGHT_WORDS.ticketing_pending;
  if (row.status === "awaiting_approval") return row.authorization_state === "approved" ? FLIGHT_WORDS.payment_approved : FLIGHT_WORDS.approval_pending;
  return FLIGHT_WORDS.quoted;
}

const day = (ms) => new Date(ms).toLocaleDateString("en-US", { timeZone: config.tz, month: "short", day: "numeric" });
const money = (cents) => (Number(cents) > 0 ? `$${(cents / 100).toFixed(2)}` : "");
const short = (s, n = 60) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/**
 * Their purchases in the window, newest first, as the block and the tool both show them. A cancelled
 * one carries why, in plain words — the reason AgentCard's webhook gave, kept on the row
 * (agentcard.cancelReason), or "no reason given" — so "why was it cancelled" is answered from the
 * record and never guessed.
 */
export function recentPurchases(conversationId, { now = clock.now(), days = PURCHASE_DAYS, max = PURCHASE_MAX } = {}) {
  return db.recentAgentcardPurchases(conversationId, { since: now - days * DAY, limit: max }).map(r => ({
    date: day(r.created_at),
    merchant: r.merchant || "unknown shop",
    item: short(r.what) || "item not recorded",
    amount: money(r.amount_cents),
    status: r.kind === "flight" ? flightStatusWords(r) : statusWords(r.status),
    ...whyOf(r),
  }));
}

/**
 * A refused row's reason and whose it was (agentcard.refusalWhy), from the row's own codes. A
 * declined row carries one too since 2026-10-25: "declined, not bought" with no reason let Reason
 * call `commerce_billing_required` — its own fee setup — the card "getting declined all week".
 */
function whyOf(r) {
  const w = refusalWhy(r);
  if (!w) return {};
  return { reason: w.words, whose: REFUSAL_WHOSE[w.whose] ?? w.whose, card_refused: w.card };
}

/**
 * The line that goes under any list of refusals: whether the card was ever the problem. "" when
 * nothing on the list was refused.
 */
export function cardVerdict(rows) {
  const refused = rows.filter(r => r.reason);
  if (!refused.length) return "";
  if (refused.some(r => r.card_refused)) return "Only a row marked as the card itself was their card being declined; never say another one was.";
  return "NONE of these was their card being declined; never say it was, whatever the chat or memory says.";
}

/**
 * Is buying in play for this person right now? The signal's name, or "" when it is not. Reads rows
 * only — never the message — see the header.
 */
export function shoppingMoment(conversationId, { now = clock.now() } = {}) {
  const q = (sql, ...args) => db.db.prepare(sql).get(conversationId, ...args);
  if (q("SELECT 1 FROM agentcard_purchases WHERE conversation_id = ? AND MAX(created_at, updated_at) >= ? LIMIT 1", now - ROW_FRESH_MS)) return "purchase_row_changed";
  // A buying tool that did nothing — AgentCard not set up on this install — is not a shopping flow:
  // a bare vault_enroll answering not_configured used to switch this block on for six hours. Such
  // calls are no longer ledgered (src/tools.js); rows from before that are skipped here.
  if (q(`SELECT 1 FROM action_ledger WHERE conversation_id = ? AND created_at >= ? AND action IN (${BUYING_TOOLS.map(() => "?").join(",")}) AND result NOT LIKE '%"status":"not_configured"%' LIMIT 1`, now - FLOW_FRESH_MS, ...BUYING_TOOLS)) return "buying_tool_ran";
  if (q("SELECT 1 FROM offers WHERE conversation_id = ? AND fetched_at >= ? LIMIT 1", now - FLOW_FRESH_MS)) return "offer_read";
  return "";
}

/**
 * Every amount on this person's own purchase record, as text the reply check (src/offers.js
 * guardReply) counts as a source: the row's amount, and the cart it was built from — each item's
 * price, each fee line, the total. Code wrote all of these from AgentCard's own cart; a figure the
 * model only typed is in none of them. The spending ceiling is left out: it was never a price.
 *
 * Why (2026-10-24): "I'll set it up again for $16.76 (unverified) all-in" — $16.76 was the total on
 * the owner's own Walmart rows, said from the purchases block on a turn where no tool re-read it, and
 * the check had only this turn's tool results to go on. Reads this person's rows only. Never throws.
 */
export function purchaseRecordSource(conversationId, { limit = 50 } = {}) {
  try {
    if (!conversationId) return "";
    const rows = db.db.prepare("SELECT amount_cents, cart_json FROM agentcard_purchases WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(conversationId, limit);
    const cents = new Set();
    const add = (v) => { const n = Number(v); if (Number.isInteger(n) && n > 0) cents.add(n); };
    for (const r of rows) {
      add(r.amount_cents);
      let cart = null;
      try { cart = r.cart_json ? JSON.parse(r.cart_json) : null; } catch {}
      if (!cart || typeof cart !== "object") continue;
      add(cart.total_cents); add(cart.subtotal_cents); add(cart.tax_cents); add(cart.shipping_cents);
      add(cart.service_fees_cents); add(cart.tip_cents);
      for (const it of Array.isArray(cart.items) ? cart.items : []) { add(it?.price_cents); add(it?.total_cents); }
      for (const f of Array.isArray(cart.fee_lines) ? cart.fee_lines : []) add(f?.amount_cents);
    }
    return [...cents].map(c => money(c)).filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

export const OVERRIDES = "This is the current state and overrides anything said earlier in the chat, including your own messages; never say an order was placed or is on its way unless it says placed here or purchase_track says so now.";

/**
 * One block for the turn, or "" when buying is not in play or there is nothing in the window. Never
 * throws: a turn that dies of its context is worse than one without it.
 */
export function purchasesNote(conversationId, { now = clock.now(), days = PURCHASE_DAYS, max = PURCHASE_MAX, log = () => {} } = {}) {
  try {
    const why = shoppingMoment(conversationId, { now });
    if (!why) return "";
    const rows = recentPurchases(conversationId, { now, days, max });
    if (!rows.length) return "";
    log({ purchases_note: rows.length, why, conversation: conversationId });
    return forConversation(conversationId, blockFor(rows, days));
  } catch {
    return "";
  }
}

/** Under the block on a person's message: the main model judges whether it is about buying. */
export const ONLY_IF_BUYING = "Background only: use this when their message is about buying, an order, a purchase, shopping, a delivery, a refund, a return or a product they might buy (a follow-up like \"any update?\" after an order counts); otherwise do not bring it up.";

/** The block itself, from rows recentPurchases gave. `background` adds the line above. */
export function blockFor(rows, days = PURCHASE_DAYS, { background = false } = {}) {
  // A refused row says why and whose it was, from its own codes.
  // A cancelled one already says "by the shop", so whose it was rides only on a decline, where it
  // was missing; "no reason given" is left off to keep it tiny.
  const lines = rows.map(r => "- " + [r.date, r.merchant, r.item, r.amount, r.status,
    r.reason && r.reason !== "no reason given" ? `why: ${r.reason}${r.status.startsWith("CANCELLED") ? "" : ` (${r.whose})`}` : ""].filter(Boolean).join(" · "));
  const verdict = cardVerdict(rows);
  return `PURCHASES ON RECORD (AgentCard, last ${days} days, newest first). ${OVERRIDES}\n${lines.join("\n")}${verdict ? `\n${verdict}` : ""}${background ? `\n${ONLY_IF_BUYING}` : ""}`;
}

/**
 * Where Crossmint is the only way to buy (src/shoptools.js), these rows are the old checkout's: said
 * as that, with no tool name that is not there, and never something to pick up again.
 */
export function forConversation(conversationId, block) {
  if (!block || !connectAllowedFor(conversationId)) return block;
  return block.split("AgentCard").join("the old checkout").split(" or purchase_track says so now").join("")
    + "\nThese went through the old checkout, which is retired: none of them is confirmed, retried or tracked again. Anything new to buy goes through store_checkout.";
}

/** A snippet of Reason's last message in the thread, newest last. "" when there is none. */
export function previousAssistant(messages = [], width = 300) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const t = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ") : "";
    const one = t.replace(/\s+/g, " ").trim();
    if (!one || one === "NO_REPLY") continue;
    return one.length > width ? `${one.slice(0, width - 1).trimEnd()}…` : one;
  }
  return "";
}

/**
 * The block for this turn, as a promise (the turn awaits it where the notes are put together; it is
 * already settled, so nothing waits). No model is asked: on their message it rides whenever there is
 * a purchase in the window, and on any other turn by the structural signals. Never rejects.
 */
export function startPurchasesNote(conversationId, { text = "", kind = "user", now = clock.now(), log = () => {} } = {}) {
  try {
    const rows = recentPurchases(conversationId, { now });
    if (!rows.length) return Promise.resolve("");
    if (kind !== "user" || !String(text ?? "").trim()) return Promise.resolve(purchasesNote(conversationId, { now, log }));
    log({ purchases_note: rows.length, why: "their_message", conversation: conversationId });
    return Promise.resolve(forConversation(conversationId, blockFor(rows, PURCHASE_DAYS, { background: true })));
  } catch {
    return Promise.resolve("");
  }
}
