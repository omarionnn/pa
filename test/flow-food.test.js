// Food ordering with the real model (REASON_FOOD=owner): the judgement code cannot make.
//
//   a bare "order food" with history → ⏳ on their text, ONE text with picks from their history, never
//                                      an open "what are you in the mood for?", nothing bought
//   "my usual from <place>"          → their last order from there proposed back in one line, nothing
//                                      added to a cart or started before they confirm
//   "sign into my DoorDash and tell   → their last order named from the receipt in their mail; never the
//    me what I last ordered"            block as the answer, never a screenshot ask, no sign-in link
//   the allergy check (haiku)        → a sesame allergy flags the tahini dish they picked; plain fries pass
//
// The money rules are code's and proved offline (test/food-order.test.js). Asserts what happened
// (texts, tapbacks, rows), never exact wording. Skipped with no model reachable.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-food-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_FOOD = "owner";
process.env.REASON_SHOP_CONNECT = "owner";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const outbox = await import("../src/outbox.js");
const { clock } = await import("../src/config.js");
const food = await import("../src/food.js");
const { skip } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const q = (sql) => db.db.prepare(sql);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  for (const t of ["outbox", "accounts", "threads", "conversations", "usage", "inbound_messages", "timers", "tasks", "food_orders", "food_notes", "shop_runs"]) { try { db.db.exec(`DELETE FROM ${t}`); } catch { /* later */ } }
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  // Two past orders, placed: Habibi twice, Thai Nara once.
  const placed = (restaurant, items, total, daysAgo) => {
    const at = clock.now() - daysAgo * 86_400_000;
    q(`INSERT INTO food_orders (conversation_id, status, platform, restaurant, store_url, items_json, address, address_label, tip, cart_total, paid_amount, card_label, created_at, updated_at, placed_at)
       VALUES (?, 'placed', 'doordash', ?, ?, ?, '3247 Bruner Ave, Apt 1', 'Home', '$4.00', ?, ?, 'Visa 4821', ?, ?, ?)`).run(C, restaurant, `https://www.doordash.com/store/${restaurant.toLowerCase().replace(/\W+/g, "-")}/`, JSON.stringify(items), total, total, at, at, at);
  };
  placed("Habibi Halal", [{ name: "Chicken over rice", qty: 1, modifiers: ["white sauce"], price: "$14.99" }, { name: "Fries", qty: 1, modifiers: [], price: "$4.50" }], "$31.42", 3);
  placed("Thai Nara", [{ name: "Drunken noodles", qty: 1, modifiers: ["chicken", "medium"], price: "$16.50" }], "$27.10", 6);
  placed("Habibi Halal", [{ name: "Lamb over rice", qty: 1, modifiers: [], price: "$15.99" }], "$26.80", 10);
});

function harness() {
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  food._attach({ say: () => {}, wake: async () => {}, channels: () => router });
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo, sendStyle }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo, sendStyle });
  });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: null });
  async function says(handle, text) {
    clock.skip(60_000);
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    if (process.env.FLOW_DEBUG) console.log("REPLY", handle, JSON.stringify(reply)?.slice(0, 400));
    await outbox.pass({ router, log: () => {} });
    return reply;
  }
  return { rt, fake, says };
}
const texts = (fake, from = 0) => fake.sent.slice(from).map((m) => m.text);

test("a bare 'order food' gets ⏳ on their text and ONE text of picks from their history, never an open question", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-1", "order me some food");
    const out = texts(fake);
    if (process.env.FLOW_DEBUG) console.log("TEXTS", JSON.stringify(out), "REACTS", JSON.stringify(fake.reactCalls));
    assert.equal(out.length, 1, `one text (got ${JSON.stringify(out)})`);
    assert.match(out[0], /habibi/i, "a pick from their history");
    assert.doesNotMatch(out[0], /in the mood|what (are you|do you) (feel|want)/i, "never an open question");
    assert.ok(q("SELECT COUNT(*) AS n FROM food_orders WHERE conversation_id = ? AND status <> 'placed'").get(C).n >= 1, "the request was started");
    assert.ok(fake.reactCalls.some((r) => r.messageHandle === "H-1" && r.reaction === "⏳"), `⏳ on their text (got ${JSON.stringify(fake.reactCalls)})`);
    assert.equal(q("SELECT COUNT(*) AS n FROM shop_runs").get().n, 0, "nothing bought or started");
  } finally { await rt.shutdown(); }
});

test("'my usual from Habibi' is proposed back in one line, nothing started before they confirm", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-2", "get me my usual from habibi");
    const out = texts(fake);
    if (process.env.FLOW_DEBUG) console.log("TEXTS", JSON.stringify(out));
    assert.equal(out.length, 1, `one text (got ${JSON.stringify(out)})`);
    assert.match(out[0], /chicken over rice|lamb over rice/i, "names their past Habibi order");
    assert.match(out[0], /\?/, "asks to confirm");
    assert.equal(q("SELECT COUNT(*) AS n FROM shop_runs").get().n, 0, "no checkout started before the yes");
  } finally { await rt.shutdown(); }
});

test("'sign into my DoorDash and tell me what I last ordered' is answered from their receipts, never with the block or a screenshot ask", { skip }, async () => {
  const { rt, fake, says } = harness();
  // No order was placed through Reason on DoorDash here: the answer can only come from their mail.
  q("DELETE FROM food_orders").run();
  const searched = [];
  rt.turnExtras.mailSearch = async (query) => {
    searched.push(query);
    return { ok: true, messages: [
      { account: "omari@example.com", id: "m-code", from: "DoorDash <no-reply@doordash.com>", subject: "Your verification code", date: "Tue, 10 Nov 2026 15:20:00 +0000", snippet: "" },
      { account: "omari@example.com", id: "m-joes", from: "DoorDash <no-reply@doordash.com>", subject: "Order Confirmation for Omari from Joe's Pizza", date: "Sat, 7 Nov 2026 23:41:00 +0000", snippet: "Thanks for your order. Total: $23.41" },
      { account: "omari@example.com", id: "m-thai", from: "DoorDash <no-reply@doordash.com>", subject: "Order Confirmation for Omari from Thai Nara", date: "Sun, 1 Nov 2026 23:41:00 +0000", snippet: "Total: $27.10" },
    ] };
  };
  try {
    await says("H-9", "Sign into my DoorDash and tell me what I last ordered");
    const out = texts(fake).join("\n");
    if (process.env.FLOW_DEBUG) console.log("TEXTS", JSON.stringify(texts(fake)), "SEARCHED", JSON.stringify(searched));
    assert.ok(searched.length >= 1, "their receipts were searched");
    assert.match(out, /joe'?s pizza/i, `the last order is named (got ${JSON.stringify(out)})`);
    assert.doesNotMatch(out, /screenshot/i, "never a screenshot ask");
    assert.equal(q("SELECT COUNT(*) AS n FROM shop_runs").get().n, 0, "nothing bought or started");
  } finally { delete rt.turnExtras.mailSearch; await rt.shutdown(); }
});

test("the allergy check (real model): a sesame allergy flags the tahini dish they picked, plain fries pass", { skip }, async () => {
  db.remember(C, "me", "Omari is allergic to sesame");
  // The runner keeps side calls off on the CLI (src/backends/side.js sideAskAllowed); this one is the subject.
  const side = await import("../src/backends/side.js");
  food._setAllergyAsk(side.askStructured);
  const flagged = await food.checkAllergies(C, [{ name: "Falafel plate", qty: 1, modifiers: ["extra tahini"] }, { name: "Fries", qty: 1, modifiers: [] }]);
  if (process.env.FLOW_DEBUG) console.log("CHECK", JSON.stringify(flagged));
  assert.equal(flagged.ok, true, JSON.stringify(flagged));
  assert.ok(flagged.conflicts.some((x) => /falafel|tahini/i.test(`${x.item} ${x.why}`)), JSON.stringify(flagged));
  assert.ok(!flagged.conflicts.some((x) => /^fries$/i.test(x.item.trim())), "plain fries are fine");
  assert.match(food.allergyFlag(flagged), /^Heads up: /);
  food._setAllergyAsk(null);
});
