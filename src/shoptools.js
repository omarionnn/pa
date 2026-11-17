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
import * as passkey from "./passkey.js";
import * as spendcap from "./spendcap.js";
import * as trust from "./trust.js";
import { judgeReply } from "./judge.js";
import * as shipping from "./shipping.js";
import { askStructured, sideAskAllowed } from "./backends/side.js";
import { clock } from "./config.js";

export const SHOP_TOOLS = new Set(["store_checkout", "shop_pay", "shop_decline", "shop_card", "shop_status", "shop_answer", "spend_limit_set", "spend_limit_confirm"]);
export const shopToolVisible = (name, conversationId) => !SHOP_TOOLS.has(name) || shop.connectAllowedFor(conversationId);

/** AgentCard's buying and card tools: never shown, never run where Crossmint is on. (Flights book through Crossmint: src/flightcheckout.js.) */
export const AGENTCARD_BUY_TOOLS = new Set(["vault_enroll", "purchase", "purchase_confirm", "purchase_track", "purchases_recent"]);
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
        their_need: { type: "string", description: "What they said it has to be or be for, in their words, when they said it: 'for dry skin', 'fits an iPhone 16', 'unscented', 'the 16 oz'. Empty when they named only the item." },
        variant_confirmed: { type: "boolean", description: "True ONLY after store_checkout refused with variant_mismatch and they then told you they want exactly this one anyway." },
        food_order_id: { type: "integer", description: "A food delivery order: the order_id from food_order start (where food ordering is on)." },
      },
      required: ["store", "start_url", "what", "item", "max_usd"],
    },
  },
  {
    name: "shop_pay",
    description: "PAY the store's checkout. This spends real money. Only after they said yes to the exact ask they were texted (store, item, Crossmint's total). Call it first with just payment_id: it refuses with `use_target`; pass that verbatim as confirm_request's target, then their real answer, then confirm_record, then this again with the confirmation_id. The amount paid is Crossmint's, read from the record; never type an amount. If they approve with Face ID it never pays: it gives a fresh approval link to send.",
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
    input_schema: { type: "object", properties: { send_link: { type: "boolean", description: "True when they want to add or change the card." }, receipt_email: { type: "string", description: "The email they said receipts should go to, when Reason asked for it (the card cannot pay until Crossmint has one). Only an address they gave." } } },
  },
  {
    name: "shop_decline",
    description: "They said no to an open payment (or changed their mind): Crossmint is told to decline, nothing is charged.",
    input_schema: { type: "object", properties: { payment_id: { type: "integer" } }, required: ["payment_id"] },
  },
  {
    name: "shop_status",
    description: "Where their checkouts and orders stand, from the record: stage (started, in progress, waiting on an answer, waiting on their approval, paid, placed, failed, cancelled), what it is waiting on, what was paid. CALL IT before answering anything like 'updates?', 'any news on the order', 'did it go through', 'is it running' — never answer those from memory or from earlier lines in the chat, which can be wrong. A checkout you cannot see here did not start.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "shop_answer",
    description: "Answer a question a running checkout is waiting on (a [checkout] event told you the run_id, the question and its fields: shipping and contact details, a size, a choice). Fill every required field from what you know about them; if something needed is unknown, do not guess: ask them for it instead. Never put a card number, password or code here: payment is approved separately and sign-in goes through their link. Nothing is charged by this.",
    input_schema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run from the [checkout] event or shop_status." },
        answers: { type: "object", description: "field key → value, keys exactly as listed in the event.", additionalProperties: true },
      },
      required: ["run_id", "answers"],
    },
  },
  {
    name: "spend_limit_set",
    description: "Change their DAILY spending limit — the most Reason may spend for them in a day, across every store — when they name a new number ('raise my shopping limit to 250', 'set my daily cap to 50', 'make it $80 a day'). Lowering it, or anything at or under the default, takes effect at once. Raising it above the default is a money control and is confirmed first: the result tells you whether to send a Face ID link (send the url on its own line as the last thing, untouched) or to ask them a plain yes/no question (then spend_limit_confirm with their answer). Nobody can set more than the ceiling the result names. Never suggest a number; never quote words for them to type. For 'what's my limit' or 'how much have I spent', use shop_status.",
    input_schema: {
      type: "object",
      properties: {
        daily: { type: "number", description: "Dollars a day, the number they said." },
        text: { type: "string", description: "Their own words, verbatim, the sentence this came from." },
      },
      required: ["daily"],
    },
  },
  {
    name: "spend_limit_confirm",
    description: "Their answer to the yes/no question about raising the daily limit (spend_limit_set said needs: yes). 'yes' applies the raise that was asked; 'no' leaves the limit as it was. Only when they actually answered; a question that has run out is refused and you say so. Never call it for a Face ID raise: the link does that.",
    input_schema: {
      type: "object",
      properties: {
        change_id: { type: "integer", description: "From spend_limit_set." },
        answer: { type: "string", enum: ["yes", "no"], description: "What they meant." },
      },
      required: ["change_id", "answer"],
    },
  },
];

export const SHOP_SCHEMAS = {
  store_checkout: z.object({ store: z.string().min(1).max(80), start_url: z.string().url().max(1000), what: z.string().min(1).max(1000), item: z.string().min(1).max(120), max_usd: z.number().positive().max(2000), sign_in: z.boolean().optional(), their_need: z.string().max(400).optional(), variant_confirmed: z.boolean().optional(), food_order_id: z.number().int().positive().optional() }),
  shop_pay: z.object({ payment_id: z.number().int().positive(), confirmation_id: z.number().int().optional() }),
  shop_decline: z.object({ payment_id: z.number().int().positive() }),
  shop_card: z.object({ send_link: z.boolean().optional(), receipt_email: z.string().max(200).optional() }),
  shop_status: z.object({}),
  shop_answer: z.object({ run_id: z.string().min(1).max(120), answers: z.record(z.union([z.string().max(500), z.number(), z.boolean()])) }),
  spend_limit_set: z.object({ daily: z.number().positive().max(1_000_000), text: z.string().max(300).optional() }),
  spend_limit_confirm: z.object({ change_id: z.number().int().positive(), answer: z.enum(["yes", "no"]) }),
};

/** The gate's target for shop_pay: built from the payment row, never from the model's input. */
export function shopPayTarget(input, conversationId = null) {
  const row = shop.paymentRow(input.payment_id);
  // Someone else's payment reads as unknown: its amount and store never reach this model.
  return row && row.conversation_id === conversationId ? shop.payTarget(row) : `unknown payment #${input.payment_id}`;
}

/** What to say about the email the card lacks: with the ones on record and why, asking only for the decision. */
function emailSay(emails = []) {
  const why = "Nothing was charged and the payment is still open; the card can't pay until there's an email for its receipts.";
  if (emails.length >= 2) return `${why} Tell them you need an email for the card, that you have ${emails.slice(0, -1).join(", ")} and ${emails[emails.length - 1]} on record, and ask which one — one plain line, no other question.`;
  return `${why} Tell them that in one plain line and ask which email to use.`;
}
// ---------------------------------------------------------------- the right one, before the checkout
// 2026-10-31: he asked for a face wash for his skin, and the run that finally paid was for the Hydrating
// cleanser after three runs for the Foaming one (made for oily skin): the variant was never held up
// against what he had said. Whether this item is the one they need is MEANING, so a model reads it —
// their own recent words and the need the model passed, against the item and the instruction — never a
// keyword list. It runs once per checkout start, fails open (a side call that can't answer never stops a
// purchase; nothing is charged by starting one anyway), and a mismatch goes back to the model to fix
// or to ask them.
const FIT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["fits", "mismatch", "unclear"] },
    need: { type: "string", description: "What they said it has to be, in a few words (empty if nothing)." },
    why: { type: "string", description: "For a mismatch: one short sentence on how the item differs from that." },
  },
  required: ["verdict", "need", "why"],
  additionalProperties: false,
};
const FIT_SYSTEM = `You check one purchase before an assistant starts the checkout. You get what the person said recently (their own words), the need the assistant noted, and the exact item and instruction the checkout will buy.
Answer "mismatch" only when the person stated a requirement — a skin or hair type, a size, a model or device it must fit, a flavour, scent, colour, dietary need, an exact product name — and this item clearly is a different variant than that (for example a cleanser "for oily skin" when they said dry skin, a 12 oz when they asked for 16 oz, a case for a different phone).
Answer "fits" when the item matches what they asked for. Answer "unclear" when they stated no requirement, or the item's name does not say enough to tell. Never call a difference in brand, price or store a mismatch unless they asked for that brand or store. Product names can be read with ordinary knowledge (CeraVe Foaming Facial Cleanser is the one for normal to oily skin; CeraVe Hydrating is for normal to dry).`;
/** Each ask's deadline (a cold CLI start is ~3 s, but a busy one has run past 20 s), and how many asks. */
const FIT_TIMEOUT_MS = Number(process.env.REASON_FIT_TIMEOUT_MS || 30_000);
const FIT_TRIES = 2;
const FIT_RETRY_MS = Number(process.env.REASON_FIT_RETRY_MS ?? 1500);
/** Both asks together never hold the checkout past this; a retry with under 5 s left is not made. */
const FIT_BUDGET_MS = Number(process.env.REASON_FIT_BUDGET_MS || 45_000);
/**
 * Why one ask failed, as a fixed kind only. The raw error can carry the model's own text (the CLI's
 * "not JSON: …", its stdout, an off-schema answer's need/why, which restate what the person said),
 * and this goes to the journal, which never holds message content.
 */
function fitFailure(out, thrown) {
  if (thrown) return /timeout|timed out|abort/i.test(String(thrown?.message ?? thrown)) ? "threw: timeout" : "threw";
  if (out?.refusal) return "refused";
  const e = String(out?.error ?? "");
  if (!e) return out?.value == null ? "no answer" : `off the schema (verdict ${typeof out.value === "object" && typeof out.value.verdict === "string" && /^[a-z ]{1,16}$/i.test(out.value.verdict) ? JSON.stringify(out.value.verdict) : "unreadable"})`;
  if (/did not finish inside|timed? ?out|timeout/i.test(e)) return "timeout";
  if (/side calls skip it/.test(e)) return "side calls paused";
  if (/not JSON|no JSON|no answer on the schema/i.test(e)) return "not JSON";
  if (/could not run/.test(e)) return "CLI would not start";
  if (/^api:/.test(e)) { const s = e.match(/\b(4\d\d|5\d\d)\b/); return s ? `api ${s[1]}` : "api error"; }
  return "CLI error";
}
/** A failure that the same ask a moment later cannot fix. */
const fitFinal = (kind) => kind === "refused" || kind === "side calls paused";
/** The answer, read leniently where the meaning is unambiguous: "Mismatch" or a JSON string still count. */
function readFit(value) {
  let v = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  const verdict = String(v?.verdict ?? "").trim().toLowerCase();
  return ["fits", "mismatch", "unclear"].includes(verdict) ? { ...v, verdict } : null;
}
let fitImpl = null;
/** For tests: what reads the fit (same shape as askStructured). null puts the real one back. */
export function _setFitCheck(fn) { fitImpl = fn; }
export async function checkFit({ texts = [], need = "", item = "", what = "" }, { ask = fitImpl ?? askStructured } = {}) {
  if (ask === askStructured && !sideAskAllowed()) return { verdict: "unclear", skipped: true };
  const said = texts.slice(-12).map((t) => `- ${String(t).slice(0, 400)}`).join("\n");
  if (!said && !String(need).trim()) return { verdict: "unclear" };
  const prompt = `What they said, oldest first:\n${said || "(nothing recent)"}\n\nThe need the assistant noted: ${String(need).trim() || "(none)"}\n\nThe checkout will buy: ${item}\nInstruction: ${what}`;
  // One retry: a side call that fails once (a CLI cold start past its deadline, a busy subscription, an
  // answer off the schema) usually answers on the second ask. Why each failed is kept for the log, as a
  // kind only (fitFailure). Not retried: a refusal, side calls paused, or too little of the budget left.
  const why = [];
  let v = null;
  const t0 = Date.now();
  for (let attempt = 0; attempt < FIT_TRIES && !v; attempt++) {
    if (attempt) {
      if (fitFinal(why.at(-1)) || FIT_BUDGET_MS - (Date.now() - t0) - FIT_RETRY_MS < 5_000) break;
      await new Promise((r) => setTimeout(r, FIT_RETRY_MS));
    }
    const timeoutMs = Math.min(FIT_TIMEOUT_MS, FIT_BUDGET_MS - (Date.now() - t0));
    let out;
    try {
      out = await ask({ prompt, system: FIT_SYSTEM, schema: FIT_SCHEMA, model: process.env.REASON_FIT_MODEL || "haiku", timeoutMs, feature: "shop_fit" });
    } catch (e) { why.push(fitFailure(null, e || new Error("threw"))); continue; }
    const got = readFit(out?.value);
    if (got) v = got;
    else why.push(fitFailure(out));
  }
  if (!v) return { verdict: "unclear", error: true, why: why.join(" | ") };
  const clip = (x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  return { verdict: v.verdict, need: clip(v.need), why: clip(v.why) };
}

export async function runShopTool(name, input, { conversationId: c, confirmationId = null, messages = [], judge = null, log = () => {} } = {}) {
  if (!shop.connectAllowedFor(c)) return { ok: false, error: "Not available." };
  if (name === "store_checkout") {
    // A food order on a host many restaurants share (Toast, Square…) is keyed per restaurant (src/food.js).
    let foodKey = null, foodName = "";
    // Started without food_order_id at the ordering page of their open food order with a recorded cart
    // (the model starting that checkout over: a form answer it could not fill, a retry): it is that
    // order's checkout, so it goes through the same gate: the recorded, checked cart, one run at a time.
    // A changed cart is recorded again first (food_order cart lets the old run go), so the card it
    // brings never shows items or an allergy check from another cart.
    let foodId = input.food_order_id ?? null;
    {
      const f = await import("./food.js");
      if (!foodId) foodId = f.orderAtPlace(c, input.start_url)?.id ?? null;
      if (foodId && f.foodOn(c)) { foodName = f.ownOrder(c, foodId)?.restaurant || ""; foodKey = f.directStoreKey(foodName || input.store, input.start_url); }
    }
    const store = foodKey ?? shop.checkoutStoreKey(input.store, input.start_url);
    if (!store) return { ok: false, error: "Which store? Give its site." };
    if (!input.variant_confirmed) {
      const fit = await checkFit({ texts: trust.ownerTexts(messages), need: input.their_need ?? "", item: input.item, what: input.what });
      log({ shop_fit: fit.verdict, ...(fit.skipped ? { skipped: true } : {}), ...(fit.error ? { error: true, why: fit.why } : {}) });
      if (fit.verdict === "mismatch") {
        return { ok: false, blocked: "variant_mismatch", need: fit.need, why: fit.why,
          say: `Not started: they said ${fit.need || "what they need"}. ${fit.why || `${input.item} is a different variant.`} Find the variant that matches and start that one instead; if you can't tell which they want, ask them in one line. Only if they then say they want this exact one, call store_checkout again with variant_confirmed: true. Nothing was charged.` };
      }
    }
    // A food order's checkout starts only on a recorded, checked cart, one at a time (src/food.js).
    let food = null;
    if (foodId) {
      food = await import("./food.js");
      if (!food.foodOn(c)) food = null;
      else { const no = food.checkoutGate(c, foodId, input.start_url); if (no) return { ...no, food_order_id: foodId }; }
    }
    // The longer instruction is for a food cart's every item and modifier; anything else keeps 400.
    if (!food && input.what.length > 400) return { ok: false, error: "what_too_long", say: "Say what to buy in 400 characters or fewer." };
    shop.noteStore({ store, name: (foodKey && foodName) || input.store, url: input.start_url });
    shop.ensureIcon(store); // for the sign-in page, if it comes to that; never waited on
    const out = await shop.startCheckout({ conversationId: c, store, startUrl: input.start_url, what: input.what, item: input.item, maxUsd: input.max_usd, signIn: !!input.sign_in,
      noAddress: food?.ownOrder(c, foodId)?.fulfillment === "pickup" });
    if (!out.ok) return out;
    if (food) food.linkRun(c, foodId, out.runId);
    shop.follow(out.runId);
    const how = out.plan === "guest" ? "as a guest" : out.plan === "signed" ? `signed in to their ${shop.storeName(store)} account` : `signing in to their ${shop.storeName(store)} account first (they get a link by text if it asks)`;
    return { ok: true, run_id: out.runId, plan: out.plan, say: `Started ${how}. Nothing is charged: when it reaches payment they get a text with Crossmint's exact total to approve. Tell them in one line you're on it; don't promise a time.` };
  }
  if (name === "shop_pay") {
    // A food order's cart is held 15 minutes (src/food.js): past that, no yes pays it, whatever was said.
    { const food = await import("./food.js"); const row = shop.paymentRow(input.payment_id);
      if (row && row.conversation_id === c && row.status === "asked" && food.isFoodRun(row.run_id) && clock.now() > shop.askDeadline(row)) return { ok: false, error: "hold_lapsed", say: "The 15-minute hold on that cart passed, so nothing was placed or charged. Offer in one line to rebuild the same cart for a fresh total." }; }
    // Their bank is connected (src/plaid.js, REASON_PLAID): a FRESH balance before paying. When no linked
    // cash account covers Crossmint's amount they are told once and nothing is paid on the yes they
    // already gave; a text from them after that warning is the go-ahead. Plaid not answering never blocks.
    { const plaid = await import("./plaid.js"); const row = shop.paymentRow(input.payment_id);
      if (row && row.conversation_id === c && row.status === "asked" && row.currency === "USD" && plaid.plaidOn(c)) {
        const texts = trust.ownerTexts(messages).length;
        if (!plaid.payCleared(c, row.id, texts)) {
          const chk = await plaid.balanceCheck(c, Number(row.amount));
          if (chk.short) {
            plaid.payWarned(c, row.id, texts);
            return { ok: false, error: "balance_looks_short", nothing_charged: true, account: chk.account, available: chk.available, needed: chk.needed,
              say: `Nothing was paid. Their linked ${chk.account} has ${chk.available} available and this is ${chk.needed}. Tell them that in one short line (it may be on a different card; you can't tell) and ask if they still want to go ahead. Only if they then say yes, call shop_pay again.` };
          }
        }
      } }
    // Face ID set up (src/passkey.js): no yes typed here pays; the page pays. A link already out and still
    // in its time is the one to use: minting another would close it under them (11-08, link_replaced).
    if (passkey.requiredFor(c)) {
      const row = shop.paymentRow(input.payment_id);
      if (!row || row.conversation_id !== c || row.status !== "asked") return { ok: false, error: "not_open" };
      if (passkey.openApprovalFor(row.id)) return { ok: false, approve_with_face_id: true, link_still_open: true, say: "Their purchases are approved with Face ID, and the Face ID link already sent for this still works. Point them to that link in one line; don't send a new one, and don't say it's paid." };
      return { ok: false, approve_with_face_id: true, url: shop.approvalUrl(row), say: "Their purchases are approved with Face ID, so a yes in the chat doesn't pay. Send this url ON ITS OWN LINE as the last thing, untouched; it works once, for 30 minutes. Don't say it's paid." };
    }
    const out = await shop.payApproved({ conversationId: c, paymentId: input.payment_id, confirmationId });
    if (out.ok) return { ...out, say: `Paid ${out.amount} at ${out.merchant}. The store still has to place it; say it's going through, not that it's done.${out.receipts_email ? ` Mention that receipts go to ${out.receipts_email} (Reason picked it, the only one on record).` : ""}` };
    // Nothing started: the card has no registration at Crossmint and the email is what it lacks. The
    // rule (2026-10-31): say what is happening and what is on record; ask only for the decision.
    if (out.needs_email) return { ...out, say: emailSay(out.emails) + " Then call shop_card with receipt_email, then shop_pay again. Never say the word Crossmint." };
    return out;
  }
  if (name === "shop_decline") return await shop.declinePayment({ conversationId: c, paymentId: input.payment_id });
  if (name === "shop_status") return shop.statusView(c);
  if (name === "spend_limit_set") {
    const cents = spendcap.toCents(input.daily);
    const out = spendcap.requestChange(c, cents, { said: String(input.text ?? "").slice(0, 300), via: "text", askedAfterMsgs: trust.ownerTexts(messages).length });
    const was = spendcap.view(c);
    if (out.ok) return { ...out, say: `Say it back in one line: their daily limit is now ${out.to} a day${out.from !== out.to ? ` (it was ${out.from})` : ""}. Today they have spent ${was.spent}, so ${was.left} is left.` };
    if (out.error === "over_ceiling") return { ...out, say: `The most anyone can set here is ${out.ceiling} a day, so nothing changed; their limit is still ${out.cap}. Say that in one line and offer ${out.ceiling} if they want it. Never say who could go higher or how.` };
    if (out.error === "bad_amount") return { ...out, say: "That didn't read as an amount. Ask once, plainly, what the daily limit should be in dollars." };
    if (out.needs === "face_id") return { ...out, say: `Raising it from ${out.from} to ${out.to} a day needs their Face ID. Say so in one line and send this url ON ITS OWN LINE as the last thing, untouched; it works once, for 30 minutes. Don't say it's done.` };
    return { ...out, say: `Raising it from ${out.from} to ${out.to} a day needs a yes from them. Ask once, in one line, whether to raise it to ${out.to} a day; when they answer, spend_limit_confirm with change_id ${out.change_id}. Don't say it's done.` };
  }
  if (name === "spend_limit_confirm") {
    if (input.answer === "no") {
      const out = spendcap.declineChange(c, input.change_id);
      return out.ok ? { ...out, say: `Left as it was: their daily limit stays ${out.cap}. One line.` } : { ...out, say: "That question isn't open anymore. Say the limit is unchanged; if they still want a change, they name the number again." };
    }
    // Their yes, read off their own messages in code, never the model's `answer` alone (security audit
    // 2026-11-06, lead 7): a message of theirs after the ask, and it has to mean yes to this raise.
    const row = spendcap.changeRow(input.change_id);
    if (row && row.conversation_id === c && row.status === "asked" && !passkey.requiredFor(c)) {
      const texts = trust.ownerTexts(messages);
      if (row.asked_after_msgs == null || texts.length <= row.asked_after_msgs) {
        return { ok: false, error: "waiting_for_yes", say: "They have not answered since you asked, so nothing changed. Wait for their reply; never answer for them." };
      }
      // What they typed, never a note riding under it (a PDF's text, the message a reply was under).
      const latest = trust.typedOnly(texts.at(-1));
      if (!latest) return { ok: false, error: "not_a_yes", say: "Their last message doesn't answer the question, so nothing changed. Ask once, plainly." };
      const verdict = trust.isBareRefusal(latest) ? "no"
        : (await (judge ?? judgeReply)({ summary: `raise their daily spending limit from ${spendcap.money(row.from_cents)} to ${spendcap.money(row.to_cents)}`, reply: latest }))?.verdict;
      if (verdict === "no") {
        const out = spendcap.declineChange(c, row.id);
        return { ...out, say: `That reads as a no: their daily limit stays ${out.cap ?? spendcap.view(c).cap}. One line.` };
      }
      if (verdict !== "yes") return { ok: false, error: "not_a_yes", quote: latest, say: "Their reply doesn't read as a clear yes to that raise, so nothing changed. Ask once, plainly." };
    }
    const out = spendcap.confirmChange(c, input.change_id, { via: "text" });
    if (out.ok) return { ...out, say: `Say it back in one line: their daily limit is now ${out.to} a day (it was ${out.from}).` };
    if (out.error === "needs_face_id") return { ...out, say: `A yes isn't enough here: raising it to ${out.to} needs their Face ID. Say so in one line and send this url ON ITS OWN LINE as the last line, exactly: ${out.url}` };
    if (out.error === "change_expired") return { ...out, say: `That question ran out, so nothing changed; their limit is still ${out.cap}. Say so in one line; if they still want it, they name the number again and you call spend_limit_set.` };
    return { ...out, say: `Nothing changed; their limit is ${out.cap ?? spendcap.view(c).cap}. Say so in one line.` };
  }
  if (name === "shop_answer") return await shop.answerRun(input.run_id, { conversationId: c, answers: input.answers });
  if (name === "shop_card") {
    if (input.receipt_email) {
      const reg = await shop.setReceiptEmail(c, input.receipt_email);
      if (reg.error === "bad_email") return { ok: false, error: "That isn't an email address. Ask again, plainly." };
      if (reg.no_card) return { ok: true, say: "Email kept for receipts. No card is saved yet; offer the link if they want to add one." };
      return reg.ok
        ? { ok: true, registered: true, say: `Say "Card ••••${shop.cardOf(c)?.last4 || "····"} is set up to pay" in one line. If a payment was waiting, call shop_pay again (or send the Face ID link again).` }
        : { ok: false, error: `The card still can't pay (${reg.code || reg.error}). Tell them it didn't take and that you'll look into it; don't ask for the email again.` };
    }
    const card = shop.cardOf(c);
    const label = card ? `${card.brand ? card.brand.replace(/^./, (x) => x.toUpperCase()) : "Card"} ••••${card.last4 || "????"}` : "";
    const needsEmail = card?.registered === 0 && /EMAIL/i.test(card.regError);
    const emails = needsEmail ? shipping.knownEmails(c) : [];
    if (card && !input.send_link) return { ok: true, card: label, ...(needsEmail ? { needs_email: true, emails } : {}), say: needsEmail ? `Their card for buying is ${label}, but it can't pay yet. ${emailSay(emails)} Then call shop_card with receipt_email.` : `Their card for buying is ${label}. Offer a link only if they want to change it.` };
    return { ok: true, card: label || null, url: shop.cardLinkUrl(c), say: `${card ? `Their card now is ${label}. ` : "No card is saved yet. "}Send the url on its own line as the last thing; it works for 30 minutes and the card goes into Crossmint's form, never to you.` };
  }
  return { ok: false, error: "unknown" };
}
