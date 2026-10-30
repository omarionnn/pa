// The model's side of Crossmint checkouts (src/shopconnect.js), behind REASON_SHOP_CONNECT.
//
//   store_checkout — start one: guest wherever the store allows, the person's own signed-in profile
//                    where it doesn't. Nothing can be charged by it: the run pauses at payment.
//   shop_pay       — pay the open payment request. Gated in src/tools.js like purchase_confirm: the yes
//                    is pinned to Crossmint's own amount, store and request (shop.payTarget), it can
//                    never ride a standing permission, and the amount paid is read from the row.
//   shop_decline   — tell Crossmint no. Nothing is charged.
//   shop_card      — the card saved for these checkouts, and a link to add or change it.
//
// Where these are on (shop.connectAllowedFor), they are the ONLY way to buy (owner, 2026-10-30:
// "we are moving off AgentCard"). The CeraVe order that day went to AgentCard's `purchase` because
// both flows were offered side by side; so for those conversations every AgentCard buying and card
// tool is hidden and refused (AGENTCARD_BUY_TOOLS), and the descriptions that pointed at them are
// reworded (crossmintWords). Everybody else keeps today's tools exactly.
import { z } from "zod";
import * as shop from "./shopconnect.js";

export const SHOP_TOOLS = new Set(["store_checkout", "shop_pay", "shop_decline", "shop_card"]);
export const shopToolVisible = (name, conversationId) => !SHOP_TOOLS.has(name) || shop.connectAllowedFor(conversationId);

/** AgentCard's buying, card and flight-booking tools: never shown, never run where Crossmint is on. */
export const AGENTCARD_BUY_TOOLS = new Set(["vault_enroll", "purchase", "purchase_confirm", "purchase_track", "purchases_recent",
  "flight_book", "flight_traveler_save", "flight_traveler_confirm", "flight_travelers", "flight_traveler_forget"]);
export const agentcardToolVisible = (name, conversationId) => !AGENTCARD_BUY_TOOLS.has(name) || !shop.connectAllowedFor(conversationId);
export const AGENTCARD_REFUSAL = { ok: false, blocked: "not_available", error: "Buying here goes through store_checkout, and a card is added or checked with shop_card. Use those, and do not mention this." };

/**
 * A description as a Crossmint conversation reads it: the sentences that sent buying to AgentCard's
 * tools, or told the model the person always checks out themselves, say store_checkout instead.
 */
const CROSSMINT_WORDS = [
  ["Do NOT walk the checkout, do NOT add to cart, do NOT fill payment forms. Your job right now is the search, comparison and price verification — the person finishes the purchase themselves.",
    "When they want you to buy it, store_checkout does the checkout and nothing is charged until they say yes to the exact total they are texted. Never walk a checkout yourself in the browser: no add to cart, no payment forms."],
  [" To buy a checked offer, pass its offer_id to purchase.", " To buy it for them, store_checkout with that page as start_url."],
  ["buying is not set up, AgentCard failed or refused,", "store_checkout failed or refused,"],
  ["Needs an offer_id from offer_check or a purchase result.", "Needs an offer_id from offer_check."],
  ["(offer_check, or a purchase result)", "(offer_check)"],
  ["buying stays a purchase call and its confirm", "buying stays store_checkout and their yes to its total"],
];
export function crossmintWords(text) {
  let out = String(text ?? "");
  for (const [from, to] of CROSSMINT_WORDS) out = out.split(from).join(to);
  return out;
}

export const SHOP_TOOL_DEFS = [
  {
    name: "store_checkout",
    description: "Buy something at a real store's website through Crossmint's checkout agent. NOTHING IS CHARGED BY THIS TOOL: the checkout stops at payment and I text them Crossmint's exact total to approve. It checks out as a guest wherever the store allows; Any store's site works. At a store that needs an account (known ones like Target, Amazon or Costco, or one where a guest run was already walled off; a walled-off guest run is restarted signed in for you) it uses their own signed-in browser profile, and if they have not signed in there yet they get ONE text with a link to sign in on a Reason page (their password goes to Crossmint, never to you). Do not ask them for passwords or codes yourself, ever. Do not send the link yourself; it is sent for you.",
    input_schema: {
      type: "object",
      properties: {
        store: { type: "string", description: "The store's name or site, any store: e.g. Amazon, sephora.com, Trader Joe's." },
        start_url: { type: "string", description: "Where the checkout starts: the product page, or a search on the store's site." },
        what: { type: "string", description: "What to buy, plainly: the item, size, quantity, pickup or delivery. One or two sentences." },
        item: { type: "string", description: "The item in a few words, as the payment ask will name it: 'a 4-ft USB-C cable'." },
        max_usd: { type: "number", description: "A ceiling Crossmint enforces. Not a price anybody agreed to." },
        sign_in: { type: "boolean", description: "True when a guest checkout at this store was blocked because it needs an account." },
      },
      required: ["store", "start_url", "what", "item", "max_usd"],
    },
  },
  {
    name: "shop_pay",
    description: "PAY the store's checkout. This spends real money. Only after they said yes to the exact ask they were texted (store, item, Crossmint's total). Call it first with just payment_id: it refuses with `use_target`; pass that verbatim as confirm_request's target, then their real answer, then confirm_record, then this again with the confirmation_id. The amount paid is Crossmint's, read from the record; never type an amount.",
    input_schema: {
      type: "object",
      properties: {
        payment_id: { type: "integer", description: "The open payment's id (from the ask)." },
        confirmation_id: { type: "integer", description: "From confirm_record, granted." },
      },
      required: ["payment_id"],
    },
  },
  {
    name: "shop_card",
    description: "The card saved for buying, and a link to add or change it. Call it when they ask to add, save, change or set up a card or payment method, or ask what card they have or whether one is on file; answer from what it says, never from memory. With send_link (or when no card is saved) it gives a link to a Reason page where they type the card into Crossmint's own secure form; you never see the number. Send the url ON ITS OWN LINE as the last thing in the message, untouched. The link works for 30 minutes.",
    input_schema: { type: "object", properties: { send_link: { type: "boolean", description: "True when they want to add or change the card." } } },
  },
  {
    name: "shop_decline",
    description: "They said no to an open payment (or changed their mind): Crossmint is told to decline, nothing is charged.",
    input_schema: { type: "object", properties: { payment_id: { type: "integer" } }, required: ["payment_id"] },
  },
];

export const SHOP_SCHEMAS = {
  store_checkout: z.object({ store: z.string().min(1).max(80), start_url: z.string().url().max(1000), what: z.string().min(1).max(400), item: z.string().min(1).max(120), max_usd: z.number().positive().max(2000), sign_in: z.boolean().optional() }),
  shop_pay: z.object({ payment_id: z.number().int().positive(), confirmation_id: z.number().int().optional() }),
  shop_decline: z.object({ payment_id: z.number().int().positive() }),
  shop_card: z.object({ send_link: z.boolean().optional() }),
};

/** The gate's target for shop_pay: built from the payment row, never from the model's input. */
export function shopPayTarget(input, conversationId = null) {
  const row = shop.paymentRow(input.payment_id);
  // Someone else's payment reads as unknown: its amount and store never reach this model.
  return row && row.conversation_id === conversationId ? shop.payTarget(row) : `unknown payment #${input.payment_id}`;
}

export async function runShopTool(name, input, { conversationId: c, confirmationId = null } = {}) {
  if (!shop.connectAllowedFor(c)) return { ok: false, error: "Not available." };
  if (name === "store_checkout") {
    const store = shop.checkoutStoreKey(input.store, input.start_url);
    if (!store) return { ok: false, error: "Which store? Give its site." };
    shop.noteStore({ store, name: input.store, url: input.start_url });
    shop.ensureIcon(store); // for the sign-in page, if it comes to that; never waited on
    const out = await shop.startCheckout({ conversationId: c, store, startUrl: input.start_url, what: input.what, item: input.item, maxUsd: input.max_usd, signIn: !!input.sign_in });
    if (!out.ok) return out;
    shop.follow(out.runId);
    const how = out.plan === "guest" ? "as a guest" : out.plan === "signed" ? `signed in to their ${shop.storeName(store)} account` : `signing in to their ${shop.storeName(store)} account first (they get a link by text if it asks)`;
    return { ok: true, run_id: out.runId, plan: out.plan, say: `Started ${how}. Nothing is charged: when it reaches payment they get a text with Crossmint's exact total to approve. Tell them in one line you're on it; don't promise a time.` };
  }
  if (name === "shop_pay") {
    const out = await shop.payApproved({ conversationId: c, paymentId: input.payment_id, confirmationId });
    return out.ok ? { ...out, say: `Paid ${out.amount} at ${out.merchant}. The store still has to place it; say it's going through, not that it's done.` } : out;
  }
  if (name === "shop_decline") return await shop.declinePayment({ conversationId: c, paymentId: input.payment_id });
  if (name === "shop_card") {
    const card = shop.cardOf(c);
    const label = card ? `${card.brand ? card.brand.replace(/^./, (x) => x.toUpperCase()) : "Card"} ••••${card.last4 || "????"}` : "";
    if (card && !input.send_link) return { ok: true, card: label, say: `Their card for buying is ${label}. Offer a link only if they want to change it.` };
    return { ok: true, card: label || null, url: shop.cardLinkUrl(c), say: `${card ? `Their card now is ${label}. ` : "No card is saved yet. "}Send the url on its own line as the last thing; it works for 30 minutes and the card goes into Crossmint's form, never to you.` };
  }
  return { ok: false, error: "unknown" };
}
