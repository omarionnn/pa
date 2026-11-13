// Only a real order's own mail is a past order (owner, 2026-11-12).
// The receipt reader found 17 "orders" in his mail, 10 of them adverts read as orders (the
// "restaurant" was a marketing line: "Skip the umbrella"), and the adverts filled the search, so
// five real Uber Eats receipts were never seen and "what did I last order" named an advert.
// Proved here, offline, on the real food tool, with made-up mail in each sender's template:
//   1. a confirmation or receipt from Uber Eats, DoorDash, Grubhub, Toast, Slice and Square is an
//      order; each one's advert, cart reminder, rating ask and offer is not;
//   2. the search asks for confirmations' and receipts' subjects, not the bare word "order";
//   3. the restaurant, the dishes and the total come from the receipt's own text where it has them;
//   4. a receipt with no dishes or no total says so, and nothing is guessed;
//   5. mail under a receipt's subject with nothing of an order in it is left out;
//   6. the newest real order is first, and a tip re-sent the next day is the same order;
//   7. a receipt that could not be opened is still an order, marked as not opened.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-foodreal-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_FOOD = "on";

const food = await import("../src/food.js");
const { runTool } = await import("../src/tools.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const ME = "dm:owner";
const mail = (id, from, subject, date, text = "", snippet = "") => ({ account: "o@example.com", id, from, subject, date, snippet, text });
const UE = "Uber Receipts <noreply@uber.com>", UEAD = "Uber Eats <uber@uber.com>";
const DD = "DoorDash <no-reply@doordash.com>", DDAD = "DoorDash <no-reply@doordash.com>";
const GH = "Grubhub <orders@eat.grubhub.com>", GHAD = "Grubhub <email@a.grubhub.com>";
const TOAST = "Nizza <no-reply@toasttab.com>", SLICE = "Slice <orders@slicelife.com>", SQ = "Square <receipts@messaging.squareup.com>";

// The receipts, each in its sender's shape.
const REAL = [
  mail("ue-tip", UE, "Your Wednesday evening order with Uber Eats", "Thu, 23 Jul 2026 14:02:00 +0000",
    "Jul 22, 2026\n9:14 PM\nTip\nThanks for tipping, Omari\nHere's your receipt for Chick-fil-A (840 Eighth Ave at the Plaza).\nTotal $24.37\nPayments\nVisa ••••4242 $24.37\nOrder Details\n9:14 PM - Pickup\n840 Eighth Ave, New York, NY 10019-0000, US"),
  mail("ue1", UE, "Your Wednesday evening order with Uber Eats", "Thu, 23 Jul 2026 01:20:00 +0000",
    "Jul 22, 2026\n9:14 PM\nThanks for ordering, Omari\nHere's your receipt for Chick-fil-A (840 Eighth Ave at the Plaza).\nTotal $21.37\nPayments\nVisa ••••4242 $21.37", "Total $21.37 Thanks for ordering, Omari"),
  mail("dd1", DD, "Order Confirmation for Omari from Popeyes Louisiana Kitchen", "Fri, 6 Mar 2026 23:41:00 +0000",
    "DoorDash Order Confirmation\nThanks for your order, Omari\nThe estimated delivery time for your order is 7:10 PM - 7:20 PM.\nPaid with Apple Pay and/or credits Popeyes Louisiana Kitchen Total: $12.38\nYour receipt 1234 Example Ave, Bronx, NY 10451, USA\nEstimated Total\n$12.38"),
  mail("gh1", GH, "Your order from Francesco's Pizzeria is being prepared", "Mon, 2 Feb 2026 23:20:00 +0000",
    "Order #82917465-1203944\n1x Large Pepperoni Pizza $21.00\n2x Garlic Knots $9.00\nSubtotal $30.00\nDelivery fee $2.99\nTax $2.66\nTip $5.00\nTotal $40.65"),
  mail("gh1b", GH, "Your order from Francesco's Pizzeria has been delivered", "Mon, 2 Feb 2026 23:58:00 +0000", "Your order has been delivered. Order #82917465-1203944"),
  mail("t1", TOAST, "Your Nizza order is confirmed", "Sun, 1 Feb 2026 22:00:00 +0000",
    "Thanks for your order!\nOrder #57\n1 Rigatoni alla Vodka $19.00\n1 Caesar Salad $13.00\nSubtotal $32.00\nTax $2.84\nTip $6.00\nTotal $40.84"),
  mail("s1", SLICE, "Your Slice order from Joe's Pizza", "Sat, 31 Jan 2026 22:00:00 +0000",
    "Thanks for ordering from Joe's Pizza.\nOrder number: 4471920\nCheese Slice x 2 $7.00\nSicilian Slice x 1 $4.50\nSubtotal $11.50\nTotal: $14.02"),
  mail("sq1", SQ, "Receipt from Feel it Healthy Spot", "Fri, 30 Jan 2026 22:00:00 +0000", "Feel it Healthy Spot\nGreen Smoothie $8.50\nAcai Bowl $1.00\nTotal $10.83\nVisa 4242", "Total $10.83"),
  mail("dd0", DD, "Order Confirmation for Omari from Loaded Platters (Grand Concourse)", "Fri, 20 Feb 2026 23:41:00 +0000",
    "DoorDash Order Confirmation\nThanks for your order, Omari\nYour receipt 1234 Example Ave, Bronx, NY 10451, USA\nYour order is on the way."),
];
// The same senders' mail that is not an order: adverts, carts, ratings, offers, codes.
const NOT = [
  mail("p1", UE, "Order McDonald’s for Your Chance to Play Monopoly", "Wed, 7 Oct 2026 15:00:00 +0000"),
  mail("p2", UEAD, "Up to 50% off? That’s your cue to order.", "Tue, 18 Aug 2026 15:00:00 +0000"),
  mail("p3", UE, "Skip the umbrella—just order in.", "Tue, 28 Jul 2026 15:00:00 +0000"),
  mail("p3b", UE, "50% off your order with Uber Eats", "Tue, 28 Jul 2026 16:00:00 +0000"),
  mail("p4", UEAD, "Whatever your plans or budget, order on Uber Eats", "Thu, 21 May 2026 15:00:00 +0000"),
  mail("p5", UEAD, "Next time you order in, give Uber Eats a go", "Mon, 6 Apr 2026 15:00:00 +0000"),
  mail("p6", UEAD, "Need inspiration for another order?", "Tue, 17 Mar 2026 15:00:00 +0000"),
  mail("p7", UEAD, "It's been too long since your last order", "Wed, 11 Mar 2026 15:00:00 +0000"),
  mail("p8", "Uber Eats <ubereats@uber.com>", "Back and ready to order", "Sun, 6 Sep 2026 15:00:00 +0000"),
  mail("p9", UEAD, "Hungry again? Order your faves", "Mon, 31 Aug 2026 15:00:00 +0000"),
  mail("p10", UE, "Score 25% off your next order over $15. Time’s ticking!", "Fri, 6 Feb 2026 15:00:00 +0000"),
  mail("p11", UE, "Your Tuesday evening trip with Uber", "Tue, 3 Nov 2026 20:00:00 +0000"),
  mail("p12", DDAD, "Your cart from Popeyes is waiting", "Sat, 7 Mar 2026 15:00:00 +0000"),
  mail("p13", DDAD, "Complete your order from Popeyes Louisiana Kitchen", "Sat, 7 Mar 2026 16:00:00 +0000"),
  mail("p14", DDAD, "Rate your order from Popeyes Louisiana Kitchen", "Sat, 7 Mar 2026 01:00:00 +0000"),
  mail("p15", DDAD, "How was your order from Popeyes Louisiana Kitchen?", "Sat, 7 Mar 2026 02:00:00 +0000"),
  mail("p16", DDAD, "$0 delivery fee on your first order from Popeyes", "Sun, 8 Mar 2026 15:00:00 +0000"),
  mail("p17", DDAD, "Your order from Popeyes Louisiana Kitchen has been cancelled", "Sun, 8 Mar 2026 16:00:00 +0000"),
  mail("p18", GHAD, "30% off your first grocery order", "Fri, 13 Feb 2026 15:00:00 +0000"),
  mail("p19", GHAD, "Order again from Francesco's Pizzeria tonight", "Sat, 14 Feb 2026 15:00:00 +0000"),
  mail("p21", TOAST, "Nizza: order ahead for the weekend", "Fri, 6 Feb 2026 15:00:00 +0000"),
  mail("p22", TOAST, "Take $5 off your next Nizza order", "Fri, 6 Feb 2026 16:00:00 +0000"),
  mail("p23", SLICE, "Pizza night? Reorder from Joe's Pizza", "Fri, 6 Feb 2026 17:00:00 +0000"),
  mail("p24", SLICE, "Your Slice account: confirm your email", "Fri, 6 Feb 2026 18:00:00 +0000"),
  mail("p25", SQ, "Feel it Healthy Spot sent you an offer", "Fri, 6 Feb 2026 19:00:00 +0000"),
  mail("p26", SQ, "How was your visit? Leave feedback on your receipt", "Fri, 6 Feb 2026 20:00:00 +0000"),
  mail("p27", DDAD, "Your verification code", "Tue, 10 Nov 2026 15:20:00 +0000"),
];
const INBOX = [...NOT, ...REAL];
const searchOf = (messages, seen = []) => async (query, limit) => { seen.push({ query, limit }); return { ok: true, messages: messages.map(({ text, ...m }) => m) }; };
const readOf = (messages, opened = []) => async (m) => { opened.push(m.id); const hit = messages.find((x) => x.id === m.id); return hit?.text ? { ok: true, text: hit.text } : { ok: false }; };
const past = (extra = {}, input = {}) => runTool("food_order", { action: "past_orders", ...input }, { conversationId: ME, mailSearch: searchOf(INBOX), mailRead: readOf(INBOX), ...extra });

test("each app's confirmation or receipt is an order by its subject; each one's advert, cart, rating ask and offer is not", () => {
  for (const m of REAL) assert.ok(food.readReceipt(m), `an order: ${m.subject}`);
  for (const m of NOT) assert.equal(food.readReceipt(m), null, `not an order: ${m.subject}`);
  // A marketing line is never a restaurant.
  assert.deepEqual(REAL.map((m) => food.readReceipt(m).restaurant), ["", "", "Popeyes Louisiana Kitchen", "Francesco's Pizzeria", "Francesco's Pizzeria", "Nizza", "Joe's Pizza", "Feel it Healthy Spot", "Loaded Platters"]);
});

test("the search asks for a confirmation's or a receipt's subject, never the bare word 'order'", () => {
  const q = food.receiptQuery({});
  assert.match(q, /subject:\("order confirmation" OR /);
  assert.match(q, / OR receipt OR /);
  assert.doesNotMatch(q, /subject:\(order OR/);
  assert.doesNotMatch(q, /[( ]order[ )]/, "the word alone would bring every advert back");
  assert.match(q, /newer_than:365d$/);
});

test("past orders are the real ones only, newest first, with the restaurant, dishes and total the receipt has", async () => {
  const out = await past();
  assert.equal(out.ok, true);
  assert.deepEqual(out.orders.map((o) => `${o.when} ${o.app} ${o.restaurant} ${o.total}`), [
    "2026-07-22 Uber Eats Chick-fil-A $24.37",
    "2026-03-06 DoorDash Popeyes Louisiana Kitchen $12.38",
    "2026-02-02 Grubhub Francesco's Pizzeria $40.65",
    "2026-02-01 Toast Nizza $40.84",
    "2026-01-31 Slice Joe's Pizza $14.02",
    "2026-01-30 Square Feel it Healthy Spot $10.83",
  ]);
  const by = Object.fromEntries(out.orders.map((o) => [o.app, o]));
  assert.deepEqual(by.Grubhub.items, ["Large Pepperoni Pizza", "2× Garlic Knots"]);
  assert.deepEqual(by.Toast.items, ["Rigatoni alla Vodka", "Caesar Salad"]);
  assert.deepEqual(by.Slice.items, ["2× Cheese Slice", "Sicilian Slice"]);
  assert.equal(by.Grubhub.receipt_lists_no, undefined);
  assert.equal(out.mail_matched, INBOX.length);
  assert.equal(out.not_orders, NOT.length + 1, "the adverts, and the confirmation with nothing of an order in it");
  assert.match(out.say, /real order receipts, newest first/);
});

test("a receipt with no dishes or no total says so, and nothing is guessed", async () => {
  const out = await past();
  const ue = out.orders[0], dd = out.orders[1], sq = out.orders.at(-1);
  assert.deepEqual(ue.items, []);
  assert.equal(ue.receipt_lists_no, "items");
  assert.deepEqual(dd.items, []);
  assert.equal(dd.receipt_lists_no, "items");
  assert.equal(sq.receipt_lists_no, "items", "lines with no quantity are not read as dishes");
  assert.match(out.say, /receipt does not list that/);
  assert.match(out.say, /rather than guess/);
  // The delivery address in a receipt is never part of the answer.
  assert.doesNotMatch(JSON.stringify(out.orders), /Example Ave|Eighth Ave|10451|4242/);
  // No total anywhere in the text: said, not made up.
  const one = mail("x1", DD, "Order Confirmation for Omari from Thai Nara", "Sun, 1 Mar 2026 23:41:00 +0000", "Order #A1B2C3D4\n1x Pad Thai\n1x Thai Iced Tea");
  const got = await runTool("food_order", { action: "past_orders" }, { conversationId: ME, mailSearch: searchOf([one]), mailRead: readOf([one]) });
  assert.deepEqual(got.orders[0].items, ["Pad Thai", "Thai Iced Tea"]);
  assert.equal(got.orders[0].total, "");
  assert.equal(got.orders[0].receipt_lists_no, "a total");
});

test("a tip re-sent a day later is the same order, with the day it was ordered", async () => {
  const out = await past();
  assert.equal(out.orders.filter((o) => o.app === "Uber Eats").length, 1);
  assert.equal(out.orders[0].when, "2026-07-22");
  assert.equal(out.orders.filter((o) => o.restaurant === "Francesco's Pizzeria").length, 1, "prepared + delivered is one order");
});

test("mail under a receipt's subject with nothing of an order in it is left out", async () => {
  // An advert written to look like an order's mail: only opening it tells.
  const fake = mail("f1", DD, "Order Confirmation for Omari from Free Burritos", "Mon, 9 Nov 2026 12:00:00 +0000", "Big news! Order now and save. Terms apply. Unsubscribe.");
  const fake2 = mail("f2", GHAD, "Your order from Francesco's Pizzeria could be free", "Mon, 9 Nov 2026 11:00:00 +0000", "Enter for a chance to win. Order now. Terms apply.");
  const box = [fake, fake2, ...REAL];
  const out = await runTool("food_order", { action: "past_orders" }, { conversationId: ME, mailSearch: searchOf(box), mailRead: readOf(box) });
  assert.doesNotMatch(JSON.stringify(out.orders), /Free Burritos|could be free/);
  assert.equal(out.orders[0].restaurant, "Chick-fil-A");
});

test("a receipt that could not be opened is still an order, marked as not opened, and the search alone still answers", async () => {
  const out = await past({ mailRead: async () => { throw new Error("mail is down"); } });
  assert.equal(out.orders[0].receipt_not_opened, true);
  assert.equal(out.orders[0].restaurant, "");
  assert.equal(out.orders[0].total, "$21.37", "the total in the search's own snippet");
  assert.equal(out.orders[1].restaurant, "Popeyes Louisiana Kitchen");
  assert.match(out.say, /gmail_read/);
  const none = await runTool("food_order", { action: "past_orders" }, { conversationId: ME, mailSearch: searchOf(INBOX) });
  assert.ok(none.orders.every((o) => o.receipt_not_opened));
});

test("only adverts in their mail: no past order, said with what was searched", async () => {
  const opened = [];
  const out = await runTool("food_order", { action: "past_orders" }, { conversationId: ME, mailSearch: searchOf(NOT), mailRead: readOf(NOT, opened) });
  assert.equal(out.count, 0);
  assert.equal(opened.length, 0, "an advert is never opened");
  assert.match(out.say, /No order receipt/);
});

test("receipts are opened a few at a time, no more than needed, and never past the time allowed", async () => {
  const many = Array.from({ length: 30 }, (_, i) => mail(`m${i}`, DD, `Order Confirmation for Omari from Place ${i}`, new Date(Date.UTC(2026, 5, 30 - i)).toUTCString(), `Total: $${10 + i}.00`));
  const opened = [];
  const out = await runTool("food_order", { action: "past_orders" }, { conversationId: ME, mailSearch: searchOf(many), mailRead: readOf(many, opened) });
  assert.equal(out.orders.length, 8);
  assert.equal(opened.length, 8);
  assert.equal(out.orders[0].restaurant, "Place 0");
  // A slow mailbox: what was not opened in time is still listed, as not opened.
  let t = 0;
  const slow = await food.pastOrders(ME, { search: searchOf(many), read: async (m) => { t += 5000; return { ok: true, text: "Total: $9.00" }; }, now: () => t });
  assert.equal(slow.orders.length, 8);
  assert.equal(slow.orders.filter((o) => o.receipt_not_opened).length, 4);
  // A mailbox that never answers: the answer still comes, with nothing opened.
  const t1 = Date.now();
  const hung = await food.pastOrders(ME, { search: searchOf(many.slice(0, 2)), read: () => new Promise(() => {}), now: (() => { let n = 0; return () => (n++ ? food.RECEIPT_READ_MS - 30 : 0); })() });
  assert.ok(Date.now() - t1 < 2000);
  assert.equal(hung.orders.filter((o) => o.receipt_not_opened).length, 2);
});

test("readReceiptText: the total is the order's total, never the subtotal, a fee or a card number", () => {
  const r = food.readReceiptText("Subtotal $30.00\nDelivery fee $2.99\nTotal $40.65\nVisa ending 4242");
  assert.equal(r.total, "$40.65");
  assert.equal(food.readReceiptText("Subtotal $30.00 Tax $2.00").total, "");
  assert.equal(food.readReceiptText("Estimated Total\n$18.87").total, "$18.87");
  assert.equal(food.readReceiptText("Amount charged: $18.87").total, "$18.87");
  assert.deepEqual(food.readReceiptText("123 Main Street\n10451 Bronx\n1 Delivery fee $2.99\n1x Tip $3.00").items, []);
  assert.deepEqual(food.readReceiptText("Order now. Order number one in pizza!").evidence, []);
  assert.deepEqual(food.readReceiptText("Order #57").evidence, ["order number"]);
});
