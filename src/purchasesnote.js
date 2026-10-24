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
// WHEN the block rides (shoppingMoment). Nothing in Reason judges a turn's topic per message — every
// tool is sent on every turn and the other notes are either unconditional or keyed on rows — and the
// repo's rule is that topic is never read with regexes or keyword lists on their words. So it is
// switched on by structural signals that need no reading of the message at all:
//   - a purchase row of theirs was created or changed in the last 48 hours (an order placed,
//     declined, cancelled by a webhook — the incident: row cancelled 13:36, question 13:45), or
//   - a buying tool ran for them in the last 6 hours (the ledger), or a product offer was read for
//     them in that time (the offers table) — i.e. a shopping flow is going on right now.
// The model can always read the same list itself with purchases_recent, whose description tells it to
// check before saying whether anything was ordered.
import * as db from "./db.js";
import { config, clock } from "./config.js";

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

const day = (ms) => new Date(ms).toLocaleDateString("en-US", { timeZone: config.tz, month: "short", day: "numeric" });
const money = (cents) => (Number(cents) > 0 ? `$${(cents / 100).toFixed(2)}` : "");
const short = (s, n = 60) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** Their purchases in the window, newest first, as the block and the tool both show them. */
export function recentPurchases(conversationId, { now = clock.now(), days = PURCHASE_DAYS, max = PURCHASE_MAX } = {}) {
  return db.recentAgentcardPurchases(conversationId, { since: now - days * DAY, limit: max }).map(r => ({
    date: day(r.created_at),
    merchant: r.merchant || "unknown shop",
    item: short(r.what) || "item not recorded",
    amount: money(r.amount_cents),
    status: statusWords(r.status),
  }));
}

/**
 * Is buying in play for this person right now? The signal's name, or "" when it is not. Reads rows
 * only — never the message — see the header.
 */
export function shoppingMoment(conversationId, { now = clock.now() } = {}) {
  const q = (sql, ...args) => db.db.prepare(sql).get(conversationId, ...args);
  if (q("SELECT 1 FROM agentcard_purchases WHERE conversation_id = ? AND MAX(created_at, updated_at) >= ? LIMIT 1", now - ROW_FRESH_MS)) return "purchase_row_changed";
  if (q(`SELECT 1 FROM action_ledger WHERE conversation_id = ? AND created_at >= ? AND action IN (${BUYING_TOOLS.map(() => "?").join(",")}) LIMIT 1`, now - FLOW_FRESH_MS, ...BUYING_TOOLS)) return "buying_tool_ran";
  if (q("SELECT 1 FROM offers WHERE conversation_id = ? AND fetched_at >= ? LIMIT 1", now - FLOW_FRESH_MS)) return "offer_read";
  return "";
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
    const lines = rows.map(r => "- " + [r.date, r.merchant, r.item, r.amount, r.status].filter(Boolean).join(" · "));
    return `PURCHASES ON RECORD (AgentCard, last ${days} days, newest first). ${OVERRIDES}\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
