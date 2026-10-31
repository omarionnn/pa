// The first real order (2026-10-31, 13:55–14:20 ET: Walmart, CeraVe Hydrating Facial Cleanser 16 oz,
// $25.00, order #2000155-05367131) and the nine things the owner wanted fixed about how it read:
//   1. The payment ask is itemized from the words of Walmart's request when it carries no breakdown
//      field; with no breakdown anywhere it says "total incl. shipping and tax".
//   2. A paid payment counts against the day's cap the moment it is paid; spend_today reads it.
//   3. A store turning the checkout away (Amazon: "Password reset required… How should I proceed?")
//      moves the checkout to the next store they were shown, by code, with one line and no question;
//      a question only when there is no other store.
//   4. A new run for the same thing ends the old one quietly (Crossmint cancel), so no "stopped…
//      want me to start it again?" arrives ten minutes later.
//   5. The end text says what the store wanted in plain words ("your word on the password reset",
//      never "your how to proceed"); the record correction reads "Actually, checking my record:" and
//      fires only on a turn about the checkout; a figure from the record is never "(unverified)".
//   6. The words go first, then the link (test/links.test.js).
//   7. Three minutes in one stage: "still working, not stuck"; eight: what it is waiting on.
//   8. An order placed earns the "First order" seal (kind `orders`, tiers at 10 / 50 / 100), told to
//      nobody unless the daily edition is on; the backfill counts the ones already placed.
//   9. The line over picture cards never says the prices couldn't be confirmed; it says, once, that
//      the exact total comes before anything is bought.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-order-flow-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.REASON_CHOICE_CARDS = "owner";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_DAILY = "owner";
process.env.REASON_STAMPS_WAX = "on";
process.env.REASON_STAMPS_EVERYDAY = "on";
process.env.REASON_STAMPS_TIERS = "on";
process.env.REASON_STAMPS_ALL = "on";
process.env.REASON_MAX_SPEND_PER_DAY = "300";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
delete process.env.REASON_BACKEND;

const shop = await import("../src/shopconnect.js");
const offers = await import("../src/offers.js");
const trust = await import("../src/trust.js");
const stamps = await import("../src/stamps.js");
const choice = await import("../src/choicecards.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const T0 = Date.parse("2026-10-31T17:57:00Z"); // 13:57 in New York
const AMAZON = "https://www.amazon.com/dp/B01MSSDEPK";
const WALMART = "https://www.walmart.com/ip/CeraVe-Hydrating-Facial-Cleanser-Daily-Moisturizing-Face-Wash-for-Normal-to-Dry-Skin-16-fl-oz/682616476";

// ---------------------------------------------------------------- a fake Crossmint
let calls, runs, nextRun, profiles;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: u.pathname, body });
  const p = u.pathname;
  const who = (init.headers ?? {})["x-crossmint-user-id"] ?? "me";
  if (p === "/api/unstable/agent-checkouts/browser-profiles" && init.method === "POST") {
    if (profiles[who]) return reply(409, { message: "exists" });
    profiles[who] = { id: `bp_${Object.keys(profiles).length + 1}` };
    return reply(201, profiles[who]);
  }
  if (p === "/api/unstable/agent-checkouts/browser-profiles") return reply(200, profiles[who] ? [profiles[who]] : []);
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1, task: body.request.task, startUrl: body.request.startUrl };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages|\/cancel)?$/.exec(p);
  if (m && m[2] === "/cancel") { if (runs[m[1]] && runs[m[1]].status === "running") { runs[m[1]].cancelAsked = true; return reply(202, { ok: true }); } return reply(409, { message: "over" }); }
  if (m && m[2]) return reply(202, { ok: true });
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { error: true, message: `Checkout '${m[1]}' not found` });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  return reply(404, { message: "no route" });
}
// Walmart's payment request as it came on 2026-10-31 (run ce771938…), sanitised: no breakdown field, the
// breakdown in the words.
const WALMART_PAY = (requestId) => ({
  requestId, request: {
    question: "Please approve a card payment for the Walmart order: 1x CeraVe Hydrating Facial Cleanser 16 fl oz, shipped to 1 Main St, Apt 1, Bronx, NY 10400. Order total $25.00 (item $15.97, shipping $6.99, estimated tax $2.04).",
    expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value: "25.00", currency: "USD" }, merchant: { name: "Walmart", countryCode: "US", url: "https://www.walmart.com/" } },
  },
});
// Amazon's refusal as it came (run 77cb3543…), sanitised: a plain choice form about a password reset.
const AMAZON_REFUSAL = (requestId) => ({
  requestId, request: {
    question: "Amazon didn't ask for a password — it says \"Password reset required\" for the account tied to +1*****2726 and offers to send a one-time code to o**3@example.edu or to that mobile. Resetting would mean setting a new password on your account. How should I proceed?",
    expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "form", fields: [{ key: "path", label: "How to proceed", handling: "standard", required: true, input: { kind: "choice", selection: { kind: "one" }, options: [
      { value: "email_signin", label: "Go back and sign in with my email address instead (I'll give it)" },
      { value: "reset_email", label: "Continue the password reset — send the code to o**3@example.edu" },
      { value: "reset_mobile", label: "Continue the password reset — send the code to my mobile +1*****2726" },
      { value: "stop", label: "Stop here" },
    ] } }] },
  },
});
const PAY = (requestId, { value = "28.24", breakdown = null } = {}) => ({
  requestId, request: {
    question: `Please approve a card payment of $${value} to Ulta.`, expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value, currency: "USD", ...(breakdown ? { breakdown } : {}) }, merchant: { name: "Ulta", countryCode: "US", url: "https://www.ulta.com/" } },
  },
});

const said = [];
const woke = [];
const told = [];
const q = (sql) => db.db.prepare(sql);
const setNow = (t) => { clock.reset(); clock.skip(t - Date.now()); };
before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }), base: "https://heyreason.test/web/connect" });
  stamps.installStamps({ tell: (c, line) => told.push(line), delayMs: 0 });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; profiles = {}; said.length = 0; woke.length = 0; told.length = 0; clock.reset(); shop._setMail(null);
  setNow(T0);
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "spend", "stamps", "choice_sets", "offers", "accounts"]) db.db.exec(`DELETE FROM ${t}`);
  db.upsertAccount({ conversationId: OMARI, channel: "fake", address: "+12025551234", name: "Omari Nyarko", isOperator: true });
  offers.beginTurn(OMARI, "");
});
const start = ({ store = "amazon", url = AMAZON, item = "CeraVe Hydrating Facial Cleanser" } = {}) =>
  shop.startCheckout({ conversationId: OMARI, store, startUrl: url, what: "One CeraVe Hydrating Facial Cleanser, quantity 1, shipped to home.", item, maxUsd: 30 });
const row = (runId) => q("SELECT * FROM shop_runs WHERE run_id = ?").get(runId);
const card = () => q("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());
const cards = (options) => db.openChoiceSet({ conversationId: OMARI, kind: "shopping", options, state: "shown", expiresAt: clock.now() + 3600_000 });

// ---------------------------------------------------------------- 1. the itemized ask
test("pinned 14:10: Walmart's request carries the breakdown in its words only; the ask is itemized from them", async () => {
  card();
  const out = await start({ store: "walmart", url: WALMART, item: "CeraVe Hydrating Facial Cleanser, 16 oz" });
  runs[out.runId].requiredAction = WALMART_PAY("req_pay_w"); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(said.at(-1).t, "Walmart's total for CeraVe Hydrating Facial Cleanser, 16 oz: item $15.97, shipping $6.99, tax $2.04; $25.00 all in.\nOK to pay $25.00 at Walmart for CeraVe Hydrating Facial Cleanser, 16 oz?");
  assert.equal(row(out.runId).stage, "needs_approval");
  // The whole question is on the record the model reads (it was cut at 200 characters and lost the tax).
  const status = shop.statusView(OMARI);
  assert.match(status.runs[0].last_question, /estimated tax \$2\.04\)\.$/);
});

test("the words are read only when they add up to the total; a structured breakdown still wins; none at all says 'total incl. shipping and tax'", () => {
  assert.equal(shop.itemizedFromWords("Order total $25.00 (item $15.97, shipping $6.99, estimated tax $2.04).", { total: "25.00" }), "item $15.97, shipping $6.99, tax $2.04");
  assert.equal(shop.itemizedFromWords("Order total $25.00 (item $15.97, shipping $6.99, estimated tax $2.04).", { total: "26.00" }), "", "a breakdown that is not this total's is not shown");
  assert.equal(shop.itemizedFromWords("Subtotal $40.00, shipping $5.00, discount $10.00, tax $3.00, total $38.00", { total: "38.00" }), "item $40.00, shipping $5.00, tax $3.00, discount $10.00");
  assert.equal(shop.itemizedFromWords("Please approve a card payment of $28.24 to Ulta.", { total: "28.24" }), "", "no breakdown in the words");
  assert.equal(shop.itemizedFromWords("1x item, shipping included, $12.00 total", { total: "12.00" }), "", "one number is not a breakdown");
  assert.equal(shop.itemized({ amount: { currency: "USD", breakdown: { subtotal: { value: "18.99" }, shipping: { value: "6.95" }, tax: { value: "2.30" } } } }, { question: "item $1.00, shipping $2.00", total: "28.24" }), "item $18.99, shipping $6.95, tax $2.30");
  const plain = { id: 1, run_id: "none", amount: "28.24", currency: "USD", amount_kind: "exact", merchant_name: "Ulta", item: "a cleanser", question: "Please approve a card payment of $28.24 to Ulta." };
  assert.equal(shop.paymentAsk(plain, { allIn: true }), "OK to pay $28.24 (total incl. shipping and tax) at Ulta for a cleanser?");
  assert.equal(shop.paymentAsk({ ...plain, amount_kind: "max" }, { allIn: true }), "OK to pay up to $28.24 at Ulta for a cleanser?", "a ceiling is never called a total");
});

// ---------------------------------------------------------------- 2. the ledger
test("pinned 14:11: the paid $25.00 counts against the day the moment it is paid; spend_today reads it", async () => {
  card();
  assert.equal(trust.spendToday(OMARI).spent, "$0.00");
  const out = await start({ store: "walmart", url: WALMART, item: "CeraVe Hydrating Facial Cleanser, 16 oz" });
  runs[out.runId].requiredAction = WALMART_PAY("req_pay_w"); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  const pay = q("SELECT * FROM shop_payments WHERE run_id = ?").get(out.runId);
  const paid = await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const today = trust.spendToday(OMARI);
  assert.equal(today.spent, "$25.00");
  assert.equal(today.commits, 1);
  assert.deepEqual(today.lines.map((l) => [l.amount, l.what, l.site]), [["$25.00", "Walmart: CeraVe Hydrating Facial Cleanser, 16 oz ($25.00)", "Walmart"]]);
  assert.equal(today.left, "$275.00");
  // The month too: the same ledger row.
  assert.equal(db.listSpendMonth(OMARI, trust.spendMonth()).length, 1);
  // Paying it again (a second shop_pay on the same row) is refused, so it is never counted twice.
  const again = await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 });
  assert.equal(again.ok, false);
  assert.equal(trust.spendToday(OMARI).commits, 1);
});

test("the backfill counts a paid row the ledger missed, once, by the day it was paid", async () => {
  q("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage) VALUES ('old', ?, 'walmart', 'CeraVe Hydrating Facial Cleanser, 16 oz', 'sign_in', 'succeeded', ?, ?, 'placed')").run(OMARI, T0, T0);
  const paidAt = T0 + 13 * 60_000;
  q("INSERT INTO shop_payments (conversation_id, run_id, request_id, amount, currency, amount_kind, merchant_name, item, status, created_at, answered_at) VALUES (?, 'old', 'req_old', '25.00', 'USD', 'exact', 'Walmart', 'CeraVe Hydrating Facial Cleanser, 16 oz', 'paid', ?, ?)").run(OMARI, T0, paidAt);
  assert.equal(await shop.backfillSpend(), 1);
  assert.equal(await shop.backfillSpend(), 0, "once");
  const line = db.listSpend(OMARI, trust.spendDay(paidAt))[0];
  assert.equal(line.cents, 2500);
  assert.equal(line.what, "Walmart: CeraVe Hydrating Facial Cleanser, 16 oz ($25.00)");
  assert.equal(trust.spendToday(OMARI).spent, "$25.00");
});

// ---------------------------------------------------------------- 3. the store refuses: the next store, by code
test("pinned 13:58: Amazon wants a password reset; the checkout moves to the Walmart card they were shown, one line, no question", async () => {
  cards([
    { n: 1, name: "CeraVe Foaming Facial Cleanser, for oily skin", price: "", url: AMAZON, brand: "Amazon" },
    { n: 2, name: "CeraVe Foaming Facial Cleanser, same bottle", price: "$17.99", url: "https://www.target.com/p/cerave-foaming/-/A-1", brand: "Target" },
    { n: 3, name: "CeraVe Hydrating Facial Cleanser, 16 oz", price: "", url: WALMART, brand: "Walmart" },
  ]);
  const out = await start();
  runs[out.runId].requiredAction = AMAZON_REFUSAL("req_reset"); runs[out.runId].revision = 2;
  const s = await shop.step(out.runId);
  assert.equal(s.done, true);
  assert.ok(s.moved, "a new run");
  assert.equal(woke.length, 0, "never the model's to answer");
  assert.deepEqual(said.map((x) => x.t), ["Amazon wants a password reset, so I moved it to Walmart for the same CeraVe Hydrating Facial Cleanser. Nothing charged."]);
  // The refusal form was answered with its way out, and the run cancelled at Crossmint; the record reads cancelled.
  const answered = calls.find((c) => c.path === `/api/unstable/agent-checkouts/${out.runId}/messages` && c.method === "POST");
  assert.deepEqual(answered.body.parts[0].response.answers, { path: "stop" });
  assert.ok(calls.some((c) => c.path === `/api/unstable/agent-checkouts/${out.runId}/cancel`));
  assert.equal(row(out.runId).status, "cancelled");
  assert.match(row(out.runId).result, /^wants a password reset; moved to walmart$/);
  // The new run: Walmart's listing, the same instruction and ceiling, signed in where Walmart needs it.
  const next = row(s.moved);
  assert.equal(next.store, "walmart");
  assert.equal(next.status, "running");
  assert.equal(runs[s.moved].startUrl, WALMART);
  assert.equal(q("SELECT max_usd FROM shop_run_asks WHERE run_id = ?").get(s.moved).max_usd, 30);
  // Its end, when Crossmint reports the old one cancelled, says nothing more.
  runs[out.runId] = { status: "cancelled", requiredAction: null, revision: 3 };
  await shop.step(out.runId);
  assert.equal(said.length, 1);
  // The old run reads as moved, never as "waiting for your how to proceed".
  assert.match(shop.stageLine(row(out.runId)), /^cancelled/);
});

test("the same move for a run Crossmint ends blocked or walled off, with an offer on record for the next store", async () => {
  q("INSERT INTO offers (conversation_id, source, url, product, seller, price_cents, fetched_at) VALUES (?, 'page', ?, 'CeraVe Hydrating Facial Cleanser 16 oz', 'Walmart', 1597, ?)").run(OMARI, WALMART, T0);
  const out = await start();
  runs[out.runId] = { status: "failed", requiredAction: null, result: { code: "merchant.no_safe_path", summary: "Amazon blocked the checkout at a robot check." }, revision: 4 };
  const s = await shop.step(out.runId);
  assert.ok(s.moved);
  assert.equal(said.at(-1).t, "Amazon stopped the checkout (Amazon blocked the checkout at a robot check.), so I moved it to Walmart for the same CeraVe Hydrating Facial Cleanser. Nothing charged.");
  assert.equal(row(out.runId).status, "failed");
  assert.equal(row(s.moved).store, "walmart");
});

test("with no other store on record, the one question; a card for the same store is not an alternative", async () => {
  cards([{ n: 1, name: "CeraVe Hydrating Facial Cleanser", price: "", url: AMAZON, brand: "Amazon" }, { n: 2, name: "Neutrogena Hydro Boost", price: "$9.99", url: WALMART, brand: "Walmart" }]);
  const out = await start();
  runs[out.runId].requiredAction = AMAZON_REFUSAL("req_reset"); runs[out.runId].revision = 2;
  const s = await shop.step(out.runId);
  assert.equal(s.done, true);
  assert.equal(s.moved, null);
  assert.deepEqual(said.map((x) => x.t), ["Amazon wants a password reset. Nothing charged, and I have no other store lined up for CeraVe Hydrating Facial Cleanser. Want me to find one?"]);
  assert.equal(row(out.runId).status, "cancelled");
  assert.equal(woke.length, 0);
});

test("what a store asked for, in plain words: never a meta label, a refusal by its topic, else the choices", () => {
  const amazon = { stage: "needs_input", request_json: JSON.stringify({ requestId: "r", kind: "form", question: AMAZON_REFUSAL("r").request.question, fields: AMAZON_REFUSAL("r").request.interaction.fields }) };
  assert.equal(shop.askedFor(amazon), "your word on the password reset");
  const size = { stage: "needs_input", request_json: JSON.stringify({ requestId: "r", kind: "form", question: "Which size?", fields: [{ key: "pick", label: "Your choice", input: { kind: "choice", options: [{ value: "a", label: "12 oz" }, { value: "b", label: "16 oz" }] } }] }) };
  assert.equal(shop.askedFor(size), "a choice (12 oz / 16 oz)");
  const other = { stage: "needs_input", request_json: JSON.stringify({ requestId: "r", kind: "form", question: "Which delivery slot works?", fields: [{ key: "x", label: "Proceed", input: { kind: "text" } }] }) };
  assert.equal(shop.askedFor(other), "an answer to \"Which delivery slot works\"");
  assert.deepEqual(shop.refusalOf("Your account is locked. How to proceed?"), { topic: "the locked account", reason: "has locked the account" });
  assert.equal(shop.refusalOf("What are your shipping details?"), null);
});

// ---------------------------------------------------------------- 4. superseded runs end quietly
test("pinned 14:08: a new run for the same thing ends the old one at once, cancelled at Crossmint, nothing said then or later", async () => {
  const amazon = await start();
  await shop.step(amazon.runId);
  const walmart = await start({ store: "walmart", url: WALMART, item: "CeraVe Hydrating Facial Cleanser, 16 oz" });
  assert.deepEqual(walmart.superseded, [amazon.runId]);
  assert.equal(row(amazon.runId).status, "cancelled");
  assert.equal(row(amazon.runId).stage, "cancelled");
  assert.equal(runs[amazon.runId].cancelAsked, true, "Crossmint was asked to cancel it");
  assert.equal(said.length, 0);
  // Ten minutes on, Crossmint reports the old one expired: nothing is texted about it.
  clock.skip(10 * 60_000);
  runs[amazon.runId] = { status: "failed", requiredAction: null, reason: "input_expired", revision: 3 };
  const s = await shop.step(amazon.runId);
  assert.equal(s.done, true);
  assert.equal(said.length, 0, "no 'stopped… want me to start it again?'");
  // The record says moved on, and shop_status lists the new run first.
  assert.match(row(amazon.runId).result, /^superseded by run_2$/);
  assert.equal(shop.statusView(OMARI).runs[0].run_id, walmart.runId);
  // A different thing to buy is not superseded.
  const serum = await start({ store: "target", url: "https://www.target.com/p/serum/-/A-2", item: "Vitamin C serum" });
  assert.equal(serum.superseded, undefined);
  assert.equal(row(walmart.runId).status, "running");
});

// ---------------------------------------------------------------- 5. the guard's words, and when it speaks
test("pinned 14:18: the record correction fires only on a turn about the checkout, and reads 'Actually, checking my record:'", async () => {
  const out = await start();
  runs[out.runId].requiredAction = AMAZON_REFUSAL("req_reset"); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(said.length, 1, "no other store on record: the one question");
  clock.skip(6 * 60_000);
  const denial = "1:40 pm is before i touched amazon at all. the amazon checkout never started at 1:40; my record shows nothing. it's also marked mobile wallet purchase.";
  // "Look at the time of it" is about a card charge: no correction.
  offers.beginTurn(OMARI, "Look at the time of it");
  assert.equal(offers.guardReply(OMARI, denial).text, denial);
  // Asked about the checkout, the record speaks, in a natural voice.
  offers.beginTurn(OMARI, "did the amazon checkout ever start?");
  const g = offers.guardReply(OMARI, denial);
  assert.match(g.text, /^Actually, checking my record: the Amazon checkout for CeraVe Hydrating Facial Cleanser did start 6 min ago; now: cancelled 6 min ago; nothing charged\./);
  assert.doesNotMatch(g.text, /Correction, from my record|never started|your how to proceed/);
  // A run that did expire waiting on the refusal form (as the real one did at 14:08) reads by its topic.
  const expired = { ...row(out.runId), stage: "failed", status: "failed", result: "input_expired" };
  assert.match(shop.stageLine(expired), /\(Amazon was waiting for your word on the password reset and it expired after 10 minutes\)/);
  // The item's words, or the store's, count as about it; an event turn (no words of theirs) does too.
  offers.beginTurn(OMARI, "what happened with the cerave cleanser");
  assert.match(offers.guardReply(OMARI, denial).text, /^Actually, checking my record/);
  offers.beginTurn(OMARI, "");
  assert.match(offers.guardReply(OMARI, denial).text, /^Actually, checking my record/);
});

test("pinned 14:15: a figure that is on the checkout record is never marked unverified", async () => {
  card();
  const out = await start({ store: "walmart", url: WALMART, item: "CeraVe Hydrating Facial Cleanser, 16 oz" });
  runs[out.runId].requiredAction = WALMART_PAY("req_pay_w"); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  offers.beginTurn(OMARI, "Why didn't you show me the breakdown");
  const reply = "here's what walmart's record shows: cleanser $15.97, shipping $6.99, and the last $2.04 is tax. $25.00 all in.";
  const g = offers.guardReply(OMARI, reply);
  assert.equal(g.text, reply);
  assert.doesNotMatch(g.text, /unverified/);
  // A figure from nowhere is still the guard's business.
  assert.match(offers.guardReply(OMARI, "the amazon one would have been $19.49.").text, /\$19\.49 \(unverified\)/);
});

// ---------------------------------------------------------------- 7. the wait updates
test("three minutes in one stage: 'still working, not stuck'; eight: what it is waiting on; each once per stage", async () => {
  const out = await start({ store: "walmart", url: WALMART, item: "CeraVe Hydrating Facial Cleanser, 16 oz" });
  await shop.step(out.runId);
  assert.equal(row(out.runId).stage, "in_progress");
  clock.skip(2 * 60_000);
  await shop.step(out.runId);
  assert.equal(said.length, 0);
  clock.skip(90_000);
  await shop.step(out.runId);
  assert.equal(said.at(-1).t, "Still working on the Walmart checkout for CeraVe Hydrating Facial Cleanser, 16 oz, not stuck. Nothing's charged.");
  await shop.step(out.runId);
  assert.equal(said.length, 1, "once");
  // The sign-in link goes out: a new stage, so the clock starts again.
  runs[out.runId].requiredAction = { requestId: "req_signin", request: { question: "Sign in to Walmart.", interaction: { kind: "form", fields: [{ key: "password", label: "Password", required: true, handling: "protected", input: { kind: "text" } }] } } };
  runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(said.length, 2);
  assert.match(said.at(-1).t, /^Walmart needs you signed in before it lets anyone check out\./);
  clock.skip(3 * 60_000 + 1000);
  await shop.step(out.runId);
  assert.equal(said.at(-1).t, "Still working on the Walmart checkout for CeraVe Hydrating Facial Cleanser, 16 oz, not stuck. Nothing's charged.");
  clock.skip(5 * 60_000);
  await shop.step(out.runId);
  assert.equal(said.at(-1).t, "Still on the Walmart checkout for CeraVe Hydrating Facial Cleanser, 16 oz: waiting on your Walmart sign-in; the link I sent still works. Not stuck, and nothing's charged.");
  assert.equal(said.length, 4);
  await shop.step(out.runId);
  assert.equal(said.length, 4, "once");
  // A payment waiting on them gets no wait update: the ask said it all.
  card();
  runs[out.runId].requiredAction = WALMART_PAY("req_pay_w"); runs[out.runId].revision = 3;
  await shop.step(out.runId);
  assert.equal(row(out.runId).stage, "needs_approval");
  clock.skip(9 * 60_000);
  await shop.step(out.runId);
  assert.match(said.at(-1).t, /^Walmart's total/);
});

// ---------------------------------------------------------------- 8. the First order seal
test("an order placed earns the First order seal, silently; the backfill finds one already placed; tiers at 10 / 50 / 100", async () => {
  const out = await start({ store: "walmart", url: WALMART, item: "CeraVe Hydrating Facial Cleanser, 16 oz" });
  runs[out.runId] = { status: "succeeded", requiredAction: null, result: { orderNumber: "200015505367131", summary: "Order placed on Walmart." }, revision: 5 };
  await shop.step(out.runId);
  assert.equal(row(out.runId).stage, "placed");
  const seals = q("SELECT * FROM stamps WHERE conversation_id = ? AND type = 'orders'").all(OMARI);
  assert.equal(seals.length, 1);
  assert.equal(seals[0].ref, `order:${out.runId}`);
  assert.deepEqual(JSON.parse(seals[0].detail_json), { place: "Walmart" });
  assert.equal(seals[0].told_at, null, "told to nobody at REASON_WEB_DAILY=owner");
  assert.deepEqual(told, []);
  // The book draws it as one seal, "First order", oxblood, with its count line.
  const book = stamps.listStamps(OMARI);
  const first = book.find((s) => s.type === "orders");
  assert.ok(first, "in the book");
  assert.equal(first.count, 1);
  assert.equal(first.countLine, "Once · next at 10");
  assert.equal(stamps.CATALOG.orders.name, "First order");
  assert.equal(stamps.SEALS.orders.wax, "oxblood");
  assert.deepEqual(stamps.TIERS.orders, [10, 50, 100]);
  assert.equal(stamps.tierOf(10, "orders"), 10);
  assert.equal(stamps.levelOf(50, "orders"), 3);
  assert.ok(stamps.sealHintOrder().includes("orders"));
  // The same order told again never makes a second seal.
  db.completionBus.emit("order", { conversationId: OMARI, runId: out.runId });
  assert.equal(q("SELECT COUNT(*) AS n FROM stamps WHERE type = 'orders'").get().n, 1);
  // The backfill: an order placed before the seal existed (the owner's, 2026-10-31) is counted, told to nobody.
  q("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage, stage_at) VALUES ('ce771938', ?, 'walmart', 'CeraVe Hydrating Facial Cleanser, 16 oz', 'sign_in', 'succeeded', ?, ?, 'placed', ?)").run(OMARI, T0, T0, T0 + 15 * 60_000);
  assert.deepEqual(stamps.backfill(OMARI, { dryRun: true }), { orders: 1 });
  assert.deepEqual(stamps.backfill(OMARI), { orders: 1 });
  assert.deepEqual(stamps.backfill(OMARI), {}, "once");
  assert.equal(q("SELECT COUNT(*) AS n FROM stamps WHERE type = 'orders'").get().n, 2);
  assert.equal(stamps.listStamps(OMARI).find((s) => s.type === "orders").count, 2);
  assert.deepEqual(told, []);
  // A run that failed, or one still running, earns nothing.
  assert.deepEqual(stamps.candidatesForOrder({ run_id: "x", conversation_id: OMARI, store: "amazon", status: "failed", stage: "failed" }), []);
  assert.deepEqual(stamps.candidatesForOrder({ run_id: "x", conversation_id: OMARI, store: "amazon", status: "running", stage: "paid" }), []);
});

// ---------------------------------------------------------------- 9. the line over the cards
test("pinned 13:56: 'i couldn't confirm the prices live' never goes out; a card without a price gets 'the exact total comes before anything is bought', once", () => {
  cards([{ n: 1, name: "CeraVe Foaming Facial Cleanser", price: "", url: AMAZON }, { n: 2, name: "CeraVe Foaming Facial Cleanser", price: "$17.99", url: WALMART }]);
  offers.beginTurn(OMARI, "Wanna get Cerave face wash. Give me options");
  const wrote = "3 cerave cleansers, take your pick. the foaming one's the one made for oily skin, so i'd go with that. i couldn't confirm the prices live, so i'll check the real total before anything gets bought";
  const g = offers.guardReply(OMARI, wrote);
  assert.equal(g.text, "3 cerave cleansers, take your pick. the foaming one's the one made for oily skin, so i'd go with that. The exact total comes to you before anything is bought.");
  assert.ok(g.flags.some((f) => f.rule === "choice_prices_wording"));
  // Said already in the model's own words: not said twice.
  const own = "3 cerave cleansers, take your pick. you'll get the exact total before anything is bought.";
  assert.equal(offers.guardReply(OMARI, own).text, own);
  // Every card priced: nothing to add; only the apology goes.
  cards([{ n: 1, name: "a", price: "$1.00", url: AMAZON }, { n: 2, name: "b", price: "$2.00", url: WALMART }]);
  assert.equal(offers.guardReply(OMARI, "two picks. i wasn't able to verify the prices though.").text, "two picks.");
  assert.equal(offers.guardReply(OMARI, "two picks, both in stock.").text, "two picks, both in stock.");
  // An old set is not this reply's business.
  clock.skip(choice.CHOICE_FRESH_MS + 1000);
  assert.equal(offers.guardReply(OMARI, "i couldn't check the prices on that one.").text, "i couldn't check the prices on that one.");
  // And the tool's note tells the model the same before it writes.
  assert.match(String(choice.TOTAL_FIRST_LINE), /before anything is bought/);
});
