// The owner's rule for a checkout snag (2026-10-31, 13:05 ET): Reason says what is happening, what it
// can do and what it already has, and asks only for the decision. Never a bare question, never
// silence. For the email a card's receipts need: two on record → name both, ask which; exactly one →
// say which it will use and proceed; none → ask, saying why. And card setup is complete at save time:
// "Card ••••1929 is set up to pay" is said only once the registration succeeded.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-cardmail-"));
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
const GMAIL = "omari.orders@example.com";
const OTHER = "omari.work@example.net";
const q = (sql) => db.db.prepare(sql);
const REG = /^\/api\/2026-09-16\/payment-methods\/([^/]+)\/order-intent-registration$/;

let calls, said, logged, refuseIntents;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: p, body });
  if (REG.test(p) && init.method === "PUT") return body?.email ? reply(200, { status: "active" }) : reply(400, { error: { code: "CONSUMER_EMAIL_REQUIRED" } });
  if (p === "/api/unstable/order-intents") { const no = refuseIntents.shift(); return no ? reply(no.status, no.body) : reply(201, { orderIntentId: `oi_${calls.length}` }); }
  if (/\/messages$/.test(p)) return reply(202, { ok: true });
  return reply(404, {});
}
before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push(t), log: (e) => logged.push(e), base: "https://heyreason.test/web/connect" }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; said = []; logged = []; refuseIntents = [];
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "person_facts", "people", "oauth_tokens"]) db.db.exec(`DELETE FROM ${t}`);
});
const puts = () => calls.filter((c) => c.method === "PUT" && REG.test(c.path));
const cardRow = () => q("SELECT * FROM shop_cards WHERE conversation_id = ?").get(OMARI);
const save = () => shop.saveCard(shop.cardLink(OMARI), { paymentMethodId: "pm_0214f5ac", brand: "mastercard", last4: "1929" });
function gmail(label, isDefault = 1) {
  q("INSERT INTO oauth_tokens (conversation_id, provider, access_token, refresh_token, account_label, connected_at, is_default) VALUES (?, 'google', 'a', 'r', ?, ?, ?)").run(OMARI, label, clock.now(), isDefault);
}
function fact(text) {
  const now = clock.now();
  if (!q("SELECT id FROM people WHERE conversation_id = ? AND key = 'me'").get(OMARI)) q("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, 'Omari', 'me', ?, ?)").run(OMARI, now, now);
  const pid = q("SELECT id FROM people WHERE conversation_id = ? AND key = 'me'").get(OMARI).id;
  q("INSERT INTO person_facts (person_id, fact, created_at) VALUES (?, ?, ?)").run(pid, text, now);
}
function asked(value = "9.79") {
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES ('run_1', ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(OMARI);
  return shop.recordPayment({ conversationId: OMARI, runId: "run_1", item: "USB-C cable", request: {
    requestId: `req_${calls.length}_${said.length}`, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
      interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } },
  } });
}

test("exactly one email known (the connected Gmail): it is announced and used, the card is set up at save time, one text", async () => {
  gmail(GMAIL);
  const out = await save();
  assert.equal(out.registered, true);
  assert.equal(puts()[0].body.email, GMAIL);
  assert.deepEqual(said, [`Card ••••1929 is set up to pay. Receipts go to ${GMAIL}.`]);
  assert.equal(cardRow().registered, 1);
  assert.equal(shipping.profileRow(OMARI).email, GMAIL, "kept on their record, so it is never asked again");
  assert.ok(!JSON.stringify(logged).includes("example.com"));
});

test("the email they already gave (on their record): used without an announcement; the line says only that the card is set up", async () => {
  shipping.learn(OMARI, { email: GMAIL }, { source: "said" });
  gmail(OTHER); // another one around does not reopen the decision they made
  await save();
  assert.equal(puts()[0].body.email, GMAIL);
  assert.deepEqual(said, ["Card ••••1929 is set up to pay."]);
});

test("two emails on record (Gmail and a fact): both named, asked which, nothing sent; their answer sets the card up and the line says so", async () => {
  gmail(GMAIL);
  fact(`His work email is ${OTHER}.`);
  const out = await save();
  assert.deepEqual(out, { ok: true, registered: false, needs_email: true, emails: [GMAIL, OTHER] });
  assert.equal(puts().length, 0);
  assert.deepEqual(said, [`Card ••••1929 is saved, but it can't pay: I need an email for its receipts, and I have ${GMAIL} and ${OTHER} on record. Which one?`]);
  assert.equal(cardRow().registered, 0);
  // Asked about the card meanwhile: the model is handed both and told to ask only which.
  const card = await runShopTool("shop_card", {}, { conversationId: OMARI });
  assert.deepEqual(card.emails, [GMAIL, OTHER]);
  assert.match(card.say, new RegExp(`${GMAIL} and ${OTHER}`));
  assert.doesNotMatch(card.say, /which email receipts go to\?$/);
  // They choose; the card is registered with that one and only that one.
  const set = await runShopTool("shop_card", { receipt_email: OTHER }, { conversationId: OMARI });
  assert.equal(set.registered, true);
  assert.match(set.say, /Card ••••1929 is set up to pay/);
  assert.equal(puts().length, 1);
  assert.equal(puts()[0].body.email, OTHER);
  assert.equal(said.length, 1, "no second ask: the model speaks for this turn");
});

test("no email anywhere: asked once, with why; a second save-time check does not ask again", async () => {
  const out = await save();
  assert.equal(out.needs_email, true);
  assert.equal(out.emails, undefined);
  assert.deepEqual(said, ["Card ••••1929 is saved, but it can't pay until I have an email for its receipts. Which one should I use?"]);
  await shop.registerCard(OMARI);
  assert.equal(said.length, 1);
  assert.equal(puts().length, 0);
});

test("at pay time with no model (Face ID words): two on record → which one; none → why; the paid line names the email Reason picked", async () => {
  const card = { last4: "1929" };
  assert.equal(shop.emailAsk(card, [GMAIL, OTHER], { atPay: true }), `Face ID worked, but card ••••1929 can't pay yet: I need an email for its receipts, and I have ${GMAIL} and ${OTHER} on record. Which one? Tell me here, then tap the link again.`);
  assert.equal(shop.emailAsk(card, [], { atPay: true }), "Face ID worked, but card ••••1929 can't pay yet until I have an email for its receipts. Which one should I use? Tell me here, then tap the link again.");
  // The pay path with one inferred email: the payment goes through and the result carries the email, so the line can say it.
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_old', 'visa', '4242', 1, NULL)").run(OMARI);
  gmail(GMAIL);
  const row = asked();
  const out = await runShopTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: OMARI, confirmationId: 1 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.receipts_email, GMAIL);
  assert.match(out.say, new RegExp(`receipts go to ${GMAIL}`));
});

test("shop_pay with two on record: nothing charged, the model is told both and to ask only which", async () => {
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_old', 'visa', '4242', 1, NULL)").run(OMARI);
  gmail(GMAIL); gmail(OTHER, 0);
  const row = asked();
  const out = await runShopTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: OMARI, confirmationId: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.needs_email, true);
  assert.deepEqual(out.emails, [GMAIL, OTHER]);
  assert.match(out.say, /Nothing was charged/);
  assert.match(out.say, new RegExp(`${GMAIL} and ${OTHER}`));
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
  assert.equal(shop.paymentRow(row.id).status, "asked");
});

test("Crossmint refuses the registration for another reason at save time: told what happened and what Reason will do, never silence", async () => {
  gmail(GMAIL);
  shop._setFetch(async (url, init) => (REG.test(new URL(url).pathname) ? reply(422, { error: { code: "CARD_NOT_ELIGIBLE" } }) : fakeFetch(url, init)));
  try {
    const out = await save();
    assert.equal(out.registered, false);
    assert.deepEqual(said, ["Card ••••1929 is saved, but it couldn't be set up to pay just now. I'll try again when it's time to pay and tell you if it still won't."]);
    assert.equal(cardRow().reg_error, "CARD_NOT_ELIGIBLE");
  } finally { shop._setFetch(fakeFetch); }
});
