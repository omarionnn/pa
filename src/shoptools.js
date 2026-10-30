// The model's side of Crossmint checkouts (src/shopconnect.js), behind REASON_SHOP_CONNECT.
//
//   store_checkout — start one: guest wherever the store allows, the person's own signed-in profile
//                    where it doesn't. Nothing can be charged by it: the run pauses at payment.
//   shop_pay       — pay the open payment request. Gated in src/tools.js like purchase_confirm: the yes
//                    is pinned to Crossmint's own amount, store and request (shop.payTarget), it can
//                    never ride a standing permission, and the amount paid is read from the row.
//   shop_decline   — tell Crossmint no. Nothing is charged.
import { z } from "zod";
import * as shop from "./shopconnect.js";

export const SHOP_TOOLS = new Set(["store_checkout", "shop_pay", "shop_decline"]);
export const shopToolVisible = (name, conversationId) => !SHOP_TOOLS.has(name) || shop.connectAllowedFor(conversationId);

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
    name: "shop_decline",
    description: "They said no to an open payment (or changed their mind): Crossmint is told to decline, nothing is charged.",
    input_schema: { type: "object", properties: { payment_id: { type: "integer" } }, required: ["payment_id"] },
  },
];

export const SHOP_SCHEMAS = {
  store_checkout: z.object({ store: z.string().min(1).max(80), start_url: z.string().url().max(1000), what: z.string().min(1).max(400), item: z.string().min(1).max(120), max_usd: z.number().positive().max(2000), sign_in: z.boolean().optional() }),
  shop_pay: z.object({ payment_id: z.number().int().positive(), confirmation_id: z.number().int().optional() }),
  shop_decline: z.object({ payment_id: z.number().int().positive() }),
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
  return { ok: false, error: "unknown" };
}
