// A saved card's order-intent registration (2026-10-31). At 16:23 UTC the owner's Face ID approval
// failed with order_intent_failed: his card had never been registered, because the PUT at save time
// was "best effort" without the email Crossmint requires (400 CONSUMER_EMAIL_REQUIRED, swallowed).
// Now: the card is registered with the person's email when it is saved; what Crossmint said is kept
// on the row; a card without a registration is registered before it pays, and once more if Crossmint
// says the registration is missing; the person hears, once and in plain words, when their email is
// what it lacks; cards saved before this are read back at boot.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-cardreg-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const shipping = await import("../src/shipping.js");
const { runShopTool } = await import("../src/shoptools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const EMAIL = "omari.receipts@example.com";
const q = (sql) => db.db.prepare(sql);
const REG = /^\/api\/2026-09-16\/payment-methods\/([^/]+)\/order-intent-registration$/;

// ---------------------------------------------------------------- a fake Crossmint
let calls, said, logged, registrations, refuseIntents, regStatus, nextReq;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : undefined;
  const method = init.method ?? "GET";
  calls.push({ method, path: p, body, origin: init.headers?.Origin });
  const m = REG.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === "PUT") {
      if (regStatus) return reply(regStatus.status, regStatus.body);
      if (!body?.email) return reply(400, { error: { code: "CONSUMER_EMAIL_REQUIRED", message: "email is required" } });
      registrations[id] = { email: body.email };
      return reply(200, { paymentMethodId: id, status: "active", rails: ["agentic-token", "spt"] });
    }
    if (method === "GET") {
      if (regStatus?.getThrows) throw new Error("socket hang up");
      return registrations[id] ? reply(200, { paymentMethodId: id, status: "active" }) : reply(404, { error: { code: "ORDER_INTENT_REGISTRATION_NOT_FOUND" } });
    }
  }
  if (p === "/api/unstable/order-intents") {
    const no = refuseIntents.shift();
    if (no) return reply(no.status, no.body);
    return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  }
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) return reply(202, { ok: true });
  return reply(404, { message: "no route" });
}
before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push({ c, t }), log: (e) => logged.push(e), base: "https://heyreason.test/web/connect" }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; said = []; logged = []; registrations = {}; refuseIntents = []; regStatus = null; nextReq = 1;
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping"]) db.db.exec(`DELETE FROM ${t}`);
});

const puts = () => calls.filter((c) => c.method === "PUT" && REG.test(c.path));
const gets = () => calls.filter((c) => c.method === "GET" && REG.test(c.path));
const intents = () => calls.filter((c) => c.path === "/api/unstable/order-intents");
const cardRow = (c = OMARI) => q("SELECT * FROM shop_cards WHERE conversation_id = ?").get(c);
/** A card saved through the page's link, as webconnect.js calls it. */
async function saveThroughPage({ id = "pm_0214f5ac", brand = "mastercard", last4 = "1929" } = {}) {
  const token = shop.cardLink(OMARI);
  return shop.saveCard(token, { paymentMethodId: id, brand, last4 });
}
/** A card already on file (saved before registration was recorded: `registered` unknown). */
const seedCard = (registered = null, id = "pm_old") => q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, ?, 'visa', '4242', ?, ?)").run(OMARI, id, clock.now(), registered);
/** An asked payment at Best Buy, recorded the way step() records it. */
function asked(value = "9.79") {
  const requestId = `req_${nextReq++}`;
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES ('run_1', ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(OMARI);
  return shop.recordPayment({ conversationId: OMARI, runId: "run_1", item: "USB-C cable", request: {
    requestId, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
      interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } },
  } });
}
const pay = (row) => runShopTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: OMARI, confirmationId: 1 });

// ---------------------------------------------------------------- saving the card
test("saving a card registers it with the person's email; the row says so and nothing is texted", async () => {
  shipping.learn(OMARI, { email: EMAIL }, { source: "said" });
  const out = await saveThroughPage();
  assert.deepEqual(out, { ok: true, registered: true });
  assert.equal(puts().length, 1);
  assert.deepEqual(puts()[0].body, { countryCode: "US", languageCode: "en-US", email: EMAIL });
  assert.equal(puts()[0].origin, "https://heyreason.com", "Crossmint's origin is the JWT issuer, never REASON_PUBLIC_URL");
  assert.equal(cardRow().registered, 1);
  assert.equal(cardRow().reg_error, "");
  assert.equal(said.length, 0);
  assert.ok(logged.some((l) => l.card_registration === "ok" && l.status === 200), JSON.stringify(logged));
  // The email itself is in no log line.
  assert.ok(!JSON.stringify(logged).includes(EMAIL));
});

test("no email on record: the card is kept, marked unregistered with the code, and they are asked once which email receipts go to", async () => {
  const out = await saveThroughPage();
  assert.deepEqual(out, { ok: true, registered: false, needs_email: true });
  assert.equal(puts().length, 0, "nothing is sent that Crossmint would refuse");
  assert.equal(cardRow().registered, 0);
  assert.equal(cardRow().reg_error, "CONSUMER_EMAIL_REQUIRED");
  assert.equal(cardRow().last4, "1929", "the card row stays");
  assert.deepEqual(said.map((s) => s.t), ["Card saved. One more thing before it can pay: which email should receipts go to?"]);
  // Asked again before they answer: the same card, no second text.
  await shop.registerCard(OMARI);
  assert.equal(said.length, 1);
});

test("Crossmint refuses with 400 CONSUMER_EMAIL_REQUIRED even so: registered = 0 with the code, the status and code logged, one plain text", async () => {
  shipping.learn(OMARI, { email: EMAIL }, { source: "said" });
  regStatus = { status: 400, body: { error: { code: "CONSUMER_EMAIL_REQUIRED", message: "email is required" } } };
  const out = await saveThroughPage();
  assert.equal(out.ok, true);
  assert.equal(out.needs_email, true);
  assert.equal(cardRow().registered, 0);
  assert.equal(cardRow().reg_error, "CONSUMER_EMAIL_REQUIRED");
  assert.ok(logged.some((l) => l.card_registration === "refused" && l.status === 400 && l.code === "CONSUMER_EMAIL_REQUIRED"), JSON.stringify(logged));
  assert.equal(said.length, 1);
  assert.match(said[0].t, /which email/);
});

test("another refusal is kept as its code, with no text about email", async () => {
  shipping.learn(OMARI, { email: EMAIL }, { source: "said" });
  regStatus = { status: 422, body: { error: { code: "CARD_NOT_ELIGIBLE" } } };
  const out = await saveThroughPage();
  assert.deepEqual(out, { ok: true, registered: false, needs_email: false });
  assert.equal(cardRow().registered, 0);
  assert.equal(cardRow().reg_error, "CARD_NOT_ELIGIBLE");
  assert.equal(said.length, 0);
});

// ---------------------------------------------------------------- paying
test("a card whose registration is unknown is registered before the order intent; then it pays", async () => {
  shipping.learn(OMARI, { email: EMAIL }, { source: "said" });
  seedCard(null);
  const row = asked();
  const out = await pay(row);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(puts().length, 1);
  assert.equal(puts()[0].body.email, EMAIL);
  assert.equal(intents().length, 1);
  assert.ok(calls.indexOf(puts()[0]) < calls.indexOf(intents()[0]), "registered first");
  assert.equal(cardRow().registered, 1);
  assert.equal(shop.paymentRow(row.id).status, "paid");
});

test("Crossmint says the registration is not there: registered with their email, the intent tried once more, paid; a second refusal is a failure with the code", async () => {
  shipping.learn(OMARI, { email: EMAIL }, { source: "said" });
  seedCard(1, "pm_said_registered");
  refuseIntents.push({ status: 400, body: { error: { code: "ORDER_INTENT_REGISTRATION_NOT_FOUND", message: "no registration" } } });
  const row = asked();
  const out = await pay(row);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(intents().length, 2);
  assert.equal(puts().length, 1);
  assert.equal(shop.paymentRow(row.id).status, "paid");

  // Refused twice: the payment stays open for the same yes, and the code is in the result and the log.
  calls = []; logged = [];
  refuseIntents.push({ status: 400, body: { error: { code: "ORDER_INTENT_REGISTRATION_NOT_FOUND" } } }, { status: 400, body: { error: { code: "ORDER_INTENT_REGISTRATION_NOT_FOUND" } } });
  const row2 = asked("12.49");
  const out2 = await pay(row2);
  assert.equal(out2.ok, false);
  assert.equal(out2.error, "order_intent_failed");
  assert.equal(out2.status, 400);
  assert.equal(out2.detail, "ORDER_INTENT_REGISTRATION_NOT_FOUND");
  assert.equal(intents().length, 2, "retried once, not forever");
  assert.equal(shop.paymentRow(row2.id).status, "asked", "open for the same yes");
  assert.ok(logged.some((l) => l.order_intent_failed && l.status === 400 && l.code === "ORDER_INTENT_REGISTRATION_NOT_FOUND"), JSON.stringify(logged));
});

test("no email anywhere: the payment does not start, stays open, says why to the model; their email through shop_card registers the card and the same yes pays", async () => {
  seedCard(null);
  const row = asked();
  const out = await pay(row);
  assert.equal(out.ok, false);
  assert.equal(out.error, "order_intent_failed");
  assert.equal(out.needs_email, true);
  assert.equal(out.detail, "CONSUMER_EMAIL_REQUIRED");
  assert.match(out.say, /which email/);
  assert.equal(intents().length, 0, "no order intent without a registration");
  assert.equal(shop.paymentRow(row.id).status, "asked");
  assert.equal(said.length, 0, "the model speaks here, not a side text");
  // What the model sees when it asks about the card meanwhile.
  const card = await runShopTool("shop_card", {}, { conversationId: OMARI });
  assert.equal(card.needs_email, true);
  assert.match(card.say, /which email/);
  // They answer; the model hands it over.
  const set = await runShopTool("shop_card", { receipt_email: "  Omari.Receipts@Example.com " }, { conversationId: OMARI });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.registered, true);
  assert.equal(puts()[0].body.email, EMAIL, "normalized, as their record keeps it");
  assert.equal(shipping.profileRow(OMARI).email, EMAIL);
  assert.equal(cardRow().registered, 1);
  const again = await pay(shop.paymentRow(row.id));
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(intents().length, 1);
  // Not an email: refused without touching Crossmint.
  const bad = await runShopTool("shop_card", { receipt_email: "omari at gmail" }, { conversationId: OMARI });
  assert.equal(bad.ok, false);
  assert.equal(puts().length, 1);
});

// ---------------------------------------------------------------- after a restart
test("boot sweep: every card with an unknown registration is read back once; found → 1, missing → 0, unreachable stays unknown; known rows are not touched", async () => {
  registrations.pm_owner = { email: EMAIL };
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES ('dm:owner', 'pm_owner', 'mastercard', '1929', 1, NULL)").run();
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES ('dm:fake:+13475550000', 'pm_ama', 'visa', '4242', 1, NULL)").run();
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES ('dm:fake:+13475550001', 'pm_known', 'visa', '0000', 1, 1)").run();
  const out = await shop.sweepCards();
  assert.deepEqual(out, { checked: 2, registered: 1, missing: 1, unknown: 0 });
  assert.equal(gets().length, 2);
  assert.equal(cardRow("dm:owner").registered, 1);
  assert.equal(cardRow("dm:fake:+13475550000").registered, 0);
  assert.equal(cardRow("dm:fake:+13475550000").reg_error, "ORDER_INTENT_REGISTRATION_NOT_FOUND");
  assert.equal(cardRow("dm:fake:+13475550001").registered, 1);
  assert.ok(logged.some((l) => l.card_registrations_swept), JSON.stringify(logged));
  // Swept once: a second sweep has nothing to read.
  calls = [];
  assert.deepEqual(await shop.sweepCards(), { checked: 0, registered: 0, missing: 0, unknown: 0 });
  assert.equal(gets().length, 0);
  // Crossmint unreachable: unknown stays unknown, to be read next boot.
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES ('dm:fake:+13475550002', 'pm_x', 'visa', '1111', 1, NULL)").run();
  regStatus = { getThrows: true };
  assert.deepEqual(await shop.sweepCards(), { checked: 1, registered: 0, missing: 0, unknown: 1 });
  assert.equal(cardRow("dm:fake:+13475550002").registered, null);
  // resumeFollowing starts the sweep without waiting on it.
  regStatus = null;
  shop.resumeFollowing();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cardRow("dm:fake:+13475550002").registered, 0);
});

test("the sweep and the save never put the email in a log line", async () => {
  shipping.learn(OMARI, { email: EMAIL }, { source: "said" });
  await saveThroughPage();
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES ('dm:fake:+13475550000', 'pm_other', 'visa', '4242', 1, NULL)").run();
  await shop.sweepCards();
  assert.ok(!JSON.stringify(logged).includes("example.com"), JSON.stringify(logged));
});
