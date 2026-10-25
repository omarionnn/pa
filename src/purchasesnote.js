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
// WHEN the block rides (startPurchasesNote, 2026-10-24 follow-up to #94). Only on a message that is
// about buying — orders, purchases, shopping, deliveries, refunds, returns, a product they might buy —
// and that is read from what the message MEANS, by one tiny side call to the small model
// (claude-haiku-5-5, the harm screen's and memory extractor's default, over the API; its own
// REASON_PURCHASE_TOPIC_MODEL), never by regexes or keyword lists on their words (the repo's rule).
// The side call is shown the new message and a snippet of Reason's last message, so "any update?"
// right after an order thread counts. It is only made when there is something to show — at least one
// purchase row in the 14-day window — so almost every turn costs nothing. It starts as context
// building starts and runs alongside it, never in front of the reply, with a hard timeout
// (REASON_PURCHASE_TOPIC_TIMEOUT_MS, 1.8s). On a timeout, an error, an install with no API key, or a
// turn that is not a person's message (an event), it falls back to the structural signals of #94
// below (shoppingMoment), so a failed check can never hide the block in the incident case.
//
// The structural signals (purchasesNote, and the fallback), which need no reading of the message:
//   - a purchase row of theirs was created or changed in the last 48 hours (an order placed,
//     declined, cancelled by a webhook — the incident: row cancelled 13:36, question 13:45), or
//   - a buying tool ran for them in the last 6 hours (the ledger), or a product offer was read for
//     them in that time (the offers table) — i.e. a shopping flow is going on right now.
// The model can always read the same list itself with purchases_recent, whose description tells it to
// check before saying whether anything was ordered.
import Anthropic from "@anthropic-ai/sdk";
import * as db from "./db.js";
import { refusalWhy, REFUSAL_WHOSE } from "./agentcard.js";
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
    status: statusWords(r.status),
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
    return blockFor(rows, days);
  } catch {
    return "";
  }
}

/** The block itself, from rows recentPurchases gave. */
export function blockFor(rows, days = PURCHASE_DAYS) {
  // A refused row says why and whose it was, from its own codes.
  // A cancelled one already says "by the shop", so whose it was rides only on a decline, where it
  // was missing; "no reason given" is left off to keep it tiny.
  const lines = rows.map(r => "- " + [r.date, r.merchant, r.item, r.amount, r.status,
    r.reason && r.reason !== "no reason given" ? `why: ${r.reason}${r.status.startsWith("CANCELLED") ? "" : ` (${r.whose})`}` : ""].filter(Boolean).join(" · "));
  const verdict = cardVerdict(rows);
  return `PURCHASES ON RECORD (AgentCard, last ${days} days, newest first). ${OVERRIDES}\n${lines.join("\n")}${verdict ? `\n${verdict}` : ""}`;
}

// ---------- is this message about buying? (the meaning gate) ----------

export const TOPIC_INSTRUCTIONS = `You sort ONE text that somebody sent to their personal assistant. The assistant can shop and buy things for them, and they have bought or tried to buy something through it in the last two weeks. Decide one thing: is the new message about buying, an order, a purchase, shopping, a delivery or shipping, a refund, a return, or a product they might buy? A follow-up that only makes sense as part of a conversation about one of those (for example "any update?" or "did it go through?" right after the assistant talked about an order) counts. Judge what the message means, not which words it uses. Anything else — weather, plans, people, questions about other things — is not. Answer with exactly one word: yes or no.`;

/** What the side call is shown: Reason's last words (a snippet) and the new message. */
export function topicPrompt({ text, previous = "" }) {
  return (previous ? `The assistant's last message, for context:\n${previous}\n\n` : "")
    + `The new message, verbatim:\n${String(text ?? "").slice(0, 1_000)}`;
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

let client = null;
const anthropic = () => (client ??= new Anthropic());

/** One yes/no over the API on the small model. Throws on anything that is not a clean yes or no. */
export async function askTopicApi({ text, previous = "", signal, timeoutMs = config.purchaseTopicTimeoutMs, client: sdk = null }) {
  const res = await (sdk ?? anthropic()).messages.create(
    {
      model: config.purchaseTopicModel,
      // Not 3 (#95, 2026-10-24): the answer is one word, but a reply that opens with a newline or
      // markdown spends its few tokens on those and comes back "" — 13 of 16 live answers did.
      max_tokens: TOPIC_MAX_TOKENS,
      system: TOPIC_INSTRUCTIONS,
      messages: [{ role: "user", content: topicPrompt({ text, previous }) }],
    },
    // One ask, no SDK retry: a retry cannot land inside the budget, and the fallback is right there.
    { timeout: timeoutMs, maxRetries: 0, signal },
  );
  // The model's own one-word answer, not the person's words: there is nothing to match in theirs.
  const said = (res.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
  const about = readYesNo(said);
  if (about === null) throw new Error(`the check answered ${JSON.stringify(said.trim().slice(0, 20))} (stop: ${res.stop_reason ?? "?"})`);
  return { about, usage: res.usage };
}

/** Room for "yes"/"no" plus whatever the model wraps it in. Still a few tokens; the cost is the input. */
export const TOPIC_MAX_TOKENS = 16;

/**
 * The model's yes or no out of whatever it wrapped it in — "yes", "Yes.", "\n\n**No**", "Answer: no".
 * The first yes/no word wins; anything with neither is null. Reads the model's reply only.
 */
export function readYesNo(said) {
  const m = String(said ?? "").toLowerCase().match(/\b(yes|no)\b/);
  return m ? m[1] === "yes" : null;
}

/** For tests: what answers the meaning gate. `null` puts the real one back. */
let topicReader = null;
export function setTopicReader(f) { topicReader = f; }
/**
 * Who reads the message: a test's stub, else the API whenever there is a key — on every backend,
 * exactly like the harm screen (src/harm.js screenBackend). With no key there is none: a cold
 * `claude -p` start is ~3s, which can never land inside the budget, so it is not spent at all.
 */
const reader = () => topicReader ?? (process.env.ANTHROPIC_API_KEY ? askTopicApi : null);

/**
 * The block for this turn, as a promise — started as context building starts, awaited where the notes
 * are put together, so the side call runs alongside the rest and never in front of the reply. Never
 * rejects. See the header for when it rides and what it falls back to.
 */
export function startPurchasesNote(conversationId, { text = "", kind = "user", messages = [], now = clock.now(), log = () => {}, timeoutMs = config.purchaseTopicTimeoutMs } = {}) {
  try {
    const rows = recentPurchases(conversationId, { now });
    // Nothing that would show: nothing to decide, and no call made.
    if (!rows.length) return Promise.resolve("");
    const structural = (why) => {
      log({ purchases_topic: "structural", why, conversation: conversationId });
      return purchasesNote(conversationId, { now, log });
    };
    const read = reader();
    if (kind !== "user" || !String(text ?? "").trim()) return Promise.resolve(structural("not_a_message"));
    if (!read) return Promise.resolve(structural("no_api_key"));

    const started = Date.now();
    const ctl = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new Error(`timeout after ${timeoutMs}ms`)); }, timeoutMs);
    });
    const asked = Promise.resolve().then(() => read({ text, previous: previousAssistant(messages), signal: ctl.signal, timeoutMs }));
    return Promise.race([asked, timedOut])
      .then(r => {
        if (typeof r?.about !== "boolean") throw new Error("the check gave no yes or no");
        log({ purchases_topic: r.about ? "yes" : "no", ms: Date.now() - started, conversation: conversationId });
        if (!r.about) return "";
        log({ purchases_note: rows.length, why: "about_buying", conversation: conversationId });
        return blockFor(rows);
      })
      .catch(e => {
        log({ purchases_topic_failed: (e?.message ?? String(e)).split("\n")[0], ms: Date.now() - started, conversation: conversationId });
        return structural("check_failed");
      })
      .finally(() => clearTimeout(timer));
  } catch {
    return Promise.resolve("");
  }
}
