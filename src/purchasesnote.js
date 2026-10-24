// What this person has really bought (or tried to) with AgentCard, put in front of the model on every
// turn, read from the database and nothing else.
//
// The incident (2026-10-24): Reason told the owner "the cerave's ordered" (Walmart, $16.76). AgentCard
// cancelled that order a few minutes later; the webhook marked the row cancelled (#92) and, by design,
// that one cancellation was never texted. At 13:45Z the owner asked whether Target had the lotion and
// Reason said "the Walmart order already went through this morning, so this would be a second
// bottle" — false, and no tool was called. The only thing it had about purchases was its own old line
// in the thread, so it believed it. Nothing about purchases was in the turn's context.
//
// So the current record rides on the turn: merchant, item, amount, where it stands now in plain words,
// and the date. It says outright that it overrides the chat. Tiny on purpose: nothing at all when there
// is nothing in the window, a handful of lines when there is, no ids. A `shopping` row that never got a
// cart is somebody browsing, not a purchase, and is left out (db.recentAgentcardPurchases).
import * as db from "./db.js";
import { config, clock } from "./config.js";

const DAY = 86_400_000;
export const PURCHASE_DAYS = 14;
export const PURCHASE_MAX = 5;

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

/**
 * One block for the turn, or "" when there is nothing in the window. Never throws: a turn that dies
 * of its context is worse than one without it.
 */
export function purchasesNote(conversationId, { now = clock.now(), days = PURCHASE_DAYS, max = PURCHASE_MAX } = {}) {
  let rows;
  try { rows = db.recentAgentcardPurchases(conversationId, { since: now - days * DAY, limit: max }); }
  catch { return ""; }
  if (!rows.length) return "";
  const lines = rows.map(r => "- " + [day(r.created_at), r.merchant || "unknown shop", short(r.what) || "item not recorded", money(r.amount_cents), statusWords(r.status)]
    .filter(Boolean).join(" · "));
  return `PURCHASES ON RECORD (AgentCard, last ${days} days, newest first). This is the current state and overrides anything said earlier in the chat, including your own messages; never call an order placed or on its way unless it says placed here or purchase_track says so now:\n${lines.join("\n")}`;
}
