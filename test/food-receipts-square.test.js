// Square sends the receipts of any shop, and every one of them was read as a food order: "what did I
// last order" could name a haircut. Proved here, offline, with made-up receipts:
//   1. from Square, a café and a restaurant count; a barber, a clothing store and a gym do not;
//   2. a Square receipt that says nothing food (no dish, no restaurant's kind of name) counts only
//      when the place is already in their food history;
//   3. DoorDash and Uber Eats receipts count as before, whatever they list;
//   4. Square is the only shared sender on the list: the food-only ones are never asked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-foodsquare-"));
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
const SQ = "Square <receipts@messaging.squareup.com>";
const mail = (id, from, subject, date, text = "", snippet = "") => ({ account: "o@example.com", id, from, subject, date, snippet, text });
const INBOX = [
  mail("cafe", SQ, "Receipt from Morning Ritual", "Thu, 12 Nov 2026 13:10:00 +0000", "Morning Ritual\nOat Milk Latte $5.50\nButter Croissant $4.25\nTax $0.86\nTotal $10.61\nVisa 4242"),
  mail("barber", SQ, "Receipt from Fade Factory Barbershop", "Wed, 11 Nov 2026 18:00:00 +0000", "Fade Factory Barbershop\nHaircut $35.00\nBeard Trim $10.00\nTip $9.00\nTotal $54.00\nVisa 4242"),
  mail("clothes", SQ, "Receipt from Thread & Needle", "Tue, 10 Nov 2026 20:00:00 +0000", "Thread & Needle\nGraphic T-Shirt $28.00\nDenim Jacket $85.00\nTax $10.03\nTotal $123.03\nVisa 4242"),
  mail("gym", SQ, "Receipt from Iron Peak", "Mon, 9 Nov 2026 12:00:00 +0000", "Iron Peak\nMonthly Membership $49.00\nTotal $49.00\nVisa 4242"),
  mail("rest", SQ, "Receipt from Golden Lotus Kitchen", "Sun, 8 Nov 2026 23:30:00 +0000", "Golden Lotus Kitchen\nHouse Special $16.00\nTotal $17.42\nVisa 4242"),
  mail("odd", SQ, "Receipt from Blue Door", "Sat, 7 Nov 2026 23:30:00 +0000", "Blue Door\nHouse Special $16.00\nTotal $17.42\nVisa 4242"),
  mail("dd", "DoorDash <no-reply@doordash.com>", "Order Confirmation for Omari from Joe's Pizza", "Fri, 6 Nov 2026 23:41:00 +0000", "Order #12345\n1x Large Cheese $18.00\nTotal: $23.41", "Total: $23.41"),
  mail("ue", "Uber Receipts <noreply@uber.com>", "Your Thursday evening order with Uber Eats", "Thu, 5 Nov 2026 23:20:00 +0000", "Nov 5, 2026\nTotal $18.20\nHere's your receipt for Blue Door.\n1 House Special $16.00", "Total $18.20"),
];
const searchOf = (messages) => async () => ({ ok: true, messages: messages.map(({ text, ...m }) => m) });
const readOf = (messages) => async (m) => { const hit = messages.find((x) => x.id === m.id); return hit?.text ? { ok: true, text: hit.text } : { ok: false }; };
const past = (messages = INBOX, read = readOf(messages)) => runTool("food_order", { action: "past_orders" }, { conversationId: ME, mailSearch: searchOf(messages), mailRead: read });

test("from Square, a café and a restaurant are food orders; a barber, a clothing store and a gym are not", async () => {
  const out = await past();
  assert.equal(out.ok, true);
  assert.deepEqual(out.orders.map((o) => `${o.app} ${o.restaurant}`), ["Square Morning Ritual", "Square Golden Lotus Kitchen", "DoorDash Joe's Pizza", "Uber Eats Blue Door"]);
  assert.equal(out.not_food, 4, "the barber, the clothes, the gym, and the Square place with nothing food about it");
  assert.equal(out.not_orders, 4);
  assert.doesNotMatch(JSON.stringify(out.orders), /Haircut|Barbershop|T-Shirt|Membership/);
});

test("a Square receipt read from its subject and snippet alone is held to the same test", async () => {
  const unread = async () => ({ ok: false });
  const out = await past(INBOX.map((m) => (m.id === "cafe" ? { ...m, snippet: "Oat Milk Latte $5.50 Butter Croissant $4.25 Total $10.61" } : m)), unread);
  // The café's snippet lists a latte; the restaurant's name says what it is; the rest say nothing food.
  assert.deepEqual(out.orders.map((o) => o.restaurant || o.app), ["Morning Ritual", "Golden Lotus Kitchen", "Joe's Pizza", "Uber Eats"]);
});

test("a Square place with nothing food on its receipt counts once it is already one of their restaurants", async () => {
  await runTool("food_order", { action: "place", restaurant: "Blue Door", store_url: "https://bluedoor.square.site/" }, { conversationId: ME });
  const out = await past();
  assert.deepEqual(out.orders.map((o) => `${o.app} ${o.restaurant}`), ["Square Morning Ritual", "Square Golden Lotus Kitchen", "Square Blue Door", "DoorDash Joe's Pizza", "Uber Eats Blue Door"]);
  assert.equal(out.not_food, 3);
});

test("the check itself: dishes, a restaurant's kind of name, or a known place; never a shop's own name", () => {
  assert.equal(food.foodReceipt({ name: "Morning Ritual", text: "Iced Matcha $6.00" }), true);
  assert.equal(food.foodReceipt({ name: "Sal's Pizzeria" }), true);
  assert.equal(food.foodReceipt({ name: "Coffee & Cuts Barbershop" }), false, "a barbershop's name with coffee in it is still a barbershop");
  assert.equal(food.foodReceipt({ name: "Iron Peak", text: "Monthly Membership $49.00\nTotal $49.00" }), false);
  assert.equal(food.foodReceipt({ name: "Blue Door", known: ["blue door"] }), true);
  assert.equal(food.foodReceipt({}), false);
});

test("Square is the one shared sender on the list; the food-only ones are not asked", () => {
  assert.deepEqual(food.RECEIPT_SENDERS.filter((s) => s.shared).map((s) => s.platform), ["square"]);
});

test("a time of day said as a greeting or a when is not a restaurant; one that begins a name is the name", () => {
  const name = (from, subject) => food.readReceipt({ from, subject, date: "Sun, 1 Nov 2026 22:00:00 +0000" })?.restaurant;
  const UE = "Uber Receipts <noreply@uber.com>", DD = "DoorDash <no-reply@doordash.com>";
  for (const s of ["Your Tuesday evening order with Uber Eats", "Your morning order with Uber Eats", "Your Friday late night order with Uber Eats"]) assert.equal(name(UE, s), "", s);
  assert.equal(name(DD, "Good morning! Your order from Joe's Pizza is on its way"), "Joe's Pizza");
  assert.equal(name(DD, "Your order from Sunrise Diner this evening"), "Sunrise Diner");
  assert.equal(name(SQ, "Receipt from Morning Ritual"), "Morning Ritual");
  assert.equal(name(DD, "Your Night Owl Cafe order is confirmed"), "Night Owl Cafe");
  assert.equal(name(SQ, "Receipt from Good Morning Bakery"), "Good Morning Bakery");
});
