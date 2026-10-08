#!/usr/bin/env node
// Proves the Stripe test-mode plumbing end to end without a browser.
//
//   node --env-file-if-exists=.env scripts/stripe-test.mjs
//
// Checkout itself cannot be clicked through from a script, so after printing the real setup link
// this switches to Stripe's own test API: a real test customer, Stripe's special `pm_card_visa`
// test token attached as a payment method (no browser needed for that one — Stripe made it for
// exactly this), saved the same way completeSetup() would save it, then a real $1.00 charge through
// chargeUser() against Reason's actual code path. The blocked case never touches Stripe at all: it
// calls trust.checkCaps() directly, the same guard payment_charge's handler calls before Stripe is
// ever reached, with the person's per-purchase cap set below the attempted amount.
//
// Skips cleanly, with one line and exit 0, when STRIPE_SECRET_KEY is not set. Refuses outright,
// before touching anything, if the key does not look like a Stripe TEST key.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.STRIPE_SECRET_KEY) {
  console.log("STRIPE_SECRET_KEY is not set — skipping. Set a Stripe TEST secret key (sk_test_...) to run this.");
  process.exit(0);
}
if (!process.env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
  console.log("STRIPE_SECRET_KEY does not look like a Stripe TEST key (it should start with sk_test_). Refusing to run against anything that might be live.");
  process.exit(1);
}

// Its own throwaway database, the same way scripts/call-rehearsal.mjs keeps itself off
// data/reason.db — set before anything under src/ is imported, since config.js reads these once.
const dir = mkdtempSync(join(tmpdir(), "reason-stripe-test-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PUBLIC_URL = process.env.REASON_PUBLIC_URL || "http://127.0.0.1:8787";
process.env.REASON_OWNER_NAME = process.env.REASON_OWNER_NAME || "Omari";

const StripeSDK = (await import("stripe")).default;
const stripeClient = new StripeSDK(process.env.STRIPE_SECRET_KEY);

const stripePay = await import("../src/stripe.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { runTool } = await import("../src/tools.js");
const { config } = await import("../src/config.js");

// The owner's own thread, exactly as scripts/call-rehearsal.mjs sets REASON_CONVERSATION — no
// account row is needed for it, since accounts.ownerOf() reads this one id as "the owner" by
// default, and the confirm gate's no-account refusal is skipped for it too.
const C = config.ownerConversation;
let failed = 0;
const say = (...a) => console.log(...a);
const check = (label, cond, detail = "") => {
  say(`  ${cond ? "OK  " : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) failed++;
};

// A stand-in for the real judge (src/judge.js), exactly like the one the test suite uses: it never
// calls a model, it just returns the verdict it was told to.
function fakeJudge(result) {
  const judge = async () => result;
  return judge;
}

try {
  say("1. Checkout session (what a real person would actually be sent)");
  const session = await stripePay.createSetupSession(C, config.ownerName);
  check("createSetupSession returned ok", session.ok === true, session.error ?? "");
  check("the URL is a real Stripe Checkout link", !!session.url && session.url.startsWith("https://checkout.stripe.com/"));
  say(`      ${session.url ?? "(none)"}`);
  say("      Checkout can't be clicked through here, so the rest of this uses Stripe's own test API directly.");

  say("\n2. A test customer, and Stripe's own pm_card_visa test token, saved the way completeSetup() would");
  const customer = await stripeClient.customers.create({ name: config.ownerName, metadata: { conversationId: C } });
  const paymentMethod = await stripeClient.paymentMethods.attach("pm_card_visa", { customer: customer.id });
  db.upsertStripeCustomer({
    conversationId: C, customerId: customer.id, paymentMethodId: paymentMethod.id,
    brand: paymentMethod.card?.brand ?? "", last4: paymentMethod.card?.last4 ?? "",
  });
  const saved = db.getStripeCustomer(C);
  check("saved to stripe_customers", saved?.customer_id === customer.id && saved?.payment_method_id === paymentMethod.id);
  check("brand and last4 came back from Stripe", !!saved?.brand && !!saved?.last4, `${saved?.brand} •••• ${saved?.last4}`);

  say("\n3. Their own caps: $5 per purchase, $50 a month");
  db.setSpendCaps(C, { perPurchaseCents: 500, monthlyCents: 5_000, said: "stripe-test script" });

  say("\n4. A real $1.00 charge, through the confirm gate and payment_charge exactly as the model would call it");
  const merchant = "Test Co";
  const description = "stripe-test script: $1 sanity charge";
  const amountCents = 100;
  const target = `${merchant}: ${description} (${trust.money(amountCents)})`;
  const msgs = [{ role: "user", content: `charge ${trust.money(amountCents)} to ${merchant} for ${description}` }];
  const req = await runTool("confirm_request", {
    action: "payment_charge",
    summary: `Charge ${trust.money(amountCents)} to ${merchant} for ${description}`,
    stakes: "money", target, amount: amountCents / 100,
  }, { conversationId: C, messages: msgs });
  check("confirm_request opened a confirmation", !!req.confirmation_id, JSON.stringify(req));
  msgs.push({ role: "user", content: "yes, go ahead" });
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id },
    { conversationId: C, messages: msgs, judge: fakeJudge({ verdict: "yes" }) });
  check("confirm_record granted it", rec.ok === true && rec.state === "granted", JSON.stringify(rec));

  const charge = await runTool("payment_charge", {
    amount_cents: amountCents, currency: "usd", description, merchant, confirmation_id: req.confirmation_id,
  }, { conversationId: C, messages: msgs });
  check("the $1.00 charge went through", charge.ok === true, charge.error ?? "");
  if (charge.ok) say(`      receipt: ${charge.receipt}, charged ${charge.charged} on ${charge.card}`);
  const history = stripePay.listCharges(C, { limit: 5 });
  check("it is on the record in stripe_charges", history.some(h => h.stripe_payment_intent_id === charge.receipt));

  say("\n5. A $10.00 charge — over the $5 per-purchase cap, and nobody has said yes to THIS one");
  const blocked = trust.checkCaps(C, 1_000, { hasYes: false, ownerName: config.ownerName });
  check("trust.checkCaps refuses it before Stripe is ever touched", blocked.ok === false && blocked.blocked === "over_per_purchase", JSON.stringify(blocked));
  const blockedCall = await runTool("payment_charge", {
    amount_cents: 1_000, currency: "usd", description: "stripe-test script: should never go through", merchant,
  }, { conversationId: C, messages: [] });
  check("payment_charge itself also refuses it (no confirmation_id at all)", blockedCall.ok === false, JSON.stringify(blockedCall));

  say(`\n${failed ? `${failed} check(s) FAILED.` : "All checks passed."}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
