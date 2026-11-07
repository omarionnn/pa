// A Crossmint payment whose outcome is unknown counts against the daily spending limit (security lead 5,
// 2026-11-07). Once the order intent exists and the checkout message to Crossmint throws or answers
// non-2xx, the card may have reached the store: the amount is counted as if it went through, the same as
// AgentCard's purchase_confirm and browser_submit do, so a second, different payment cannot spend the
// same day's allowance again. Fail closed on money: counted until it is known to have failed.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-unknown-spend-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "on";
process.env.REASON_MAX_SPEND_PER_DAY = "100";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const AMA = "dm:test:1";
db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550001", name: "Ama", isOperator: false });
const q = (sql) => db.db.prepare(sql);

// ---------------------------------------------------------------- a fake Crossmint (no network)
let calls, messages, runStatus, intent;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname;
  calls.push({ method: init.method ?? "GET", path: p });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}` });
  const oi = /^\/api\/unstable\/order-intents\/([^/]+)$/.exec(p);
  if (oi) {
    if (intent === "throw") throw new Error("timeout");
    if (typeof intent === "number") return reply(intent, { message: "nope" });
    return reply(200, typeof intent === "function" ? intent(decodeURIComponent(oi[1])) : intent);
  }
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) {
    if (messages === "throw") throw new Error("socket hang up");
    if (messages === "500") return reply(500, { message: "internal" });
    return reply(202, { ok: true });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)$/.exec(p);
  if (m) return reply(200, { runId: m[1], status: runStatus, result: { summary: "Order placed" } });
  if (/order-intent-registration$/.test(p)) return reply(200, { status: "active" });
  return reply(404, {});
}
const orderIntents = () => calls.filter((c) => c.path === "/api/unstable/order-intents").length;
let nextReq = 1;
function asked(value, runId = `run_${nextReq}`) {
  const requestId = `req_${nextReq++}`;
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES (?, ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(runId, AMA);
  return shop.recordPayment({ conversationId: AMA, runId, item: "USB-C cable", request: {
    requestId, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
      interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } },
  } });
}
const spentToday = () => db.spentToday(AMA, trust.spendDay()).cents;

before(() => { shop._setFetch(fakeFetch); shop.attach({ say: () => {} }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; messages = "ok"; runStatus = "running"; intent = 404; clock.reset();
  for (const t of ["shop_runs", "shop_cards", "shop_payments", "spend", "daily_caps"]) db.db.exec(`DELETE FROM ${t}`);
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', 0, 1)").run(AMA);
});

for (const how of ["500", "throw"]) {
  test(`a checkout message that ${how === "500" ? "answers 500" : "throws"} after the order intent counts the amount; a second payment over the limit is refused`, async () => {
    messages = how;
    const first = asked("90.00");
    const out = await shop.payApproved({ conversationId: AMA, paymentId: first.id, confirmationId: 7 });
    assert.equal(out.unknown_outcome, true, JSON.stringify(out));
    assert.equal(shop.paymentRow(first.id).status, "unknown");
    assert.equal(spentToday(), 9000, "the possibly-charged $90 counts against today");
    const line = db.listSpend(AMA, trust.spendDay())[0];
    assert.match(line.what, /\(OUTCOME UNKNOWN\)$/, "marked the way AgentCard's unknown lines are");
    assert.equal(line.confirmation_id, 7);

    messages = "ok";
    const second = asked("90.00");
    const again = await shop.payApproved({ conversationId: AMA, paymentId: second.id, confirmationId: 8 });
    assert.equal(again.error, "over_daily_cap", JSON.stringify(again));
    assert.equal(orderIntents(), 1, "the second payment never reached Crossmint");
    assert.equal(trust.checkSpendCap(AMA, 9000).ok, false);
  });
}

test("the run later succeeding with the unknown payment does not count it twice", async () => {
  messages = "500";
  const row = asked("40.00", "run_ok");
  assert.equal((await shop.payApproved({ conversationId: AMA, paymentId: row.id })).unknown_outcome, true);
  assert.equal(spentToday(), 4000);
  runStatus = "succeeded";
  await shop.step("run_ok");
  assert.equal(spentToday(), 4000);
});

test("at boot an unknown payment the ledger never counted (from before this) is counted once; paid rows still are", async () => {
  const unknown = asked("30.00");
  const paid = asked("20.00");
  const now = clock.now();
  q("UPDATE shop_payments SET status = 'unknown', answered_at = ? WHERE id = ?").run(now, unknown.id);
  q("UPDATE shop_payments SET status = 'paid', answered_at = ? WHERE id = ?").run(now, paid.id);
  assert.equal(await shop.backfillSpend(), 2);
  assert.equal(spentToday(), 5000);
  assert.equal(await shop.backfillSpend(), 0, "never counted twice");
  assert.equal(spentToday(), 5000);
});

// ---------------------------------------------------------------- release on Crossmint's definite "never charged"
// Follow-up to lead 5: an unknown payment counts until Crossmint itself says it never charged — the
// order intent no longer active (cancelled / expired) with nothing spent or reserved on it. Then it
// stops counting, once, and the ledger line stays as a $0 note. Anything less stays counted.
const neverCharged = (status = "expired", spent = "0.00", reserved = "0.00") => (id) => ({
  orderIntentId: id, status, paymentMethodId: "pm_1", description: "x", expiresAt: new Date(0).toISOString(), rails: [],
  amount: { total: "90.00", spent, reserved, available: status === "active" ? "90.00" : "0.00", currency: "USD" },
});
const intentReads = () => calls.filter((c) => /^\/api\/unstable\/order-intents\/./.test(c.path)).length;
async function unknown90() {
  messages = "500";
  const row = asked("90.00");
  assert.equal((await shop.payApproved({ conversationId: AMA, paymentId: row.id, confirmationId: 7 })).unknown_outcome, true);
  assert.equal(spentToday(), 9000);
  messages = "ok";
  return row;
}

for (const status of ["expired", "cancelled"]) {
  test(`an unknown $90 Crossmint confirms never charged (${status}, nothing spent) stops counting: a second $90 under a $100 limit is paid`, async () => {
    const first = await unknown90();
    intent = neverCharged(status);
    const second = asked("90.00");
    const out = await shop.payApproved({ conversationId: AMA, paymentId: second.id, confirmationId: 8 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(orderIntents(), 2, "the second payment reached Crossmint");
    assert.equal(shop.paymentRow(first.id).status, "failed");
    assert.equal(spentToday(), 9000, "only the second $90 counts");
    const lines = db.listSpend(AMA, trust.spendDay());
    const note = lines.find((l) => l.cents === 0);
    assert.ok(note, "the released line stays in the ledger as a note");
    assert.match(note.what, /\(CROSSMINT CONFIRMED NOT CHARGED, not counted\)$/);
    assert.doesNotMatch(note.what, /OUTCOME UNKNOWN/);
    assert.equal(trust.spendToday(AMA).commits, 1, "a $0 note is not a commit");
  });
}

const notDefinite = [
  ["still active, nothing spent yet", neverCharged("active")],
  ["expired but $90 spent", neverCharged("expired", "90.00")],
  ["cancelled but $90 reserved", neverCharged("cancelled", "0.00", "90.00")],
  ["expired, spent not a number", neverCharged("expired", "0.00x")],
  ["expired, no amount at all", (id) => ({ orderIntentId: id, status: "expired" })],
  ["a different order intent", () => neverCharged("expired")("oi_someone_else")],
  ["an unheard-of status", neverCharged("failed")],
  ["HTTP 404", 404],
  ["HTTP 500", 500],
  ["a timeout", "throw"],
];
for (const [what, answer] of notDefinite) {
  test(`not a definite failure (${what}): the unknown $90 stays counted and a second $90 is refused`, async () => {
    const first = await unknown90();
    intent = answer;
    const second = asked("90.00");
    const out = await shop.payApproved({ conversationId: AMA, paymentId: second.id, confirmationId: 8 });
    assert.equal(out.error, "over_daily_cap", JSON.stringify(out));
    assert.equal(intentReads(), 1, "Crossmint was asked");
    assert.equal(orderIntents(), 1, "the second payment never reached Crossmint");
    assert.equal(shop.paymentRow(first.id).status, "unknown");
    assert.equal(spentToday(), 9000);
    assert.match(db.listSpend(AMA, trust.spendDay())[0].what, /\(OUTCOME UNKNOWN\)$/);
  });
}

test("a release happens once: two settles at once, again later, and the boot backfill never count or release it twice", async () => {
  const first = await unknown90();
  // The same item, amount and yes, still unknown at Crossmint: an identical ledger line (counted as payRow would).
  const other = asked("90.00");
  q("UPDATE shop_payments SET status = 'unknown', order_intent_id = 'oi_other', confirmation_id = 7, answered_at = ? WHERE id = ?").run(clock.now(), other.id);
  trust.noteSpend({ conversationId: AMA, cents: 9000, what: shop.spendLineOf(shop.paymentRow(other.id)), site: "Best Buy", confirmationId: 7 });
  const firstIntent = shop.paymentRow(first.id).order_intent_id;
  intent = (id) => (id === firstIntent ? neverCharged("expired")(id) : neverCharged("active")(id));
  assert.equal(spentToday(), 18000);
  const [a, b] = await Promise.all([shop.settleUnknownPayments(), shop.settleUnknownPayments({ conversationId: AMA })]);
  assert.equal(a + b, 1, "released by exactly one caller");
  assert.equal(await shop.settleUnknownPayments(), 0, "nothing left to release");
  assert.equal(await shop.backfillSpend(), 0, "the boot backfill does not count it again");
  assert.equal(spentToday(), 9000, "the other unknown $90 still counts");
  assert.equal(shop.paymentRow(first.id).status, "failed");
  assert.equal(shop.paymentRow(other.id).status, "unknown");
  const lines = db.listSpend(AMA, trust.spendDay());
  assert.equal(lines.filter((l) => l.cents === 0).length, 1, "one note");
  assert.equal(lines.filter((l) => /OUTCOME UNKNOWN/.test(l.what)).length, 1, "the other line untouched");
});

test("a release takes back only its own day's line: an identical older line stays counted", async () => {
  const yesterday = db.recordSpend({ conversationId: AMA, day: "2000-01-01", cents: 9000, what: "Best Buy: USB-C cable ($90.00) (OUTCOME UNKNOWN)", site: "Best Buy", confirmationId: 7 });
  const first = await unknown90();
  intent = neverCharged("expired");
  assert.equal(await shop.settleUnknownPayments({ conversationId: AMA }), 1);
  assert.equal(spentToday(), 0);
  assert.equal(q("SELECT cents FROM spend WHERE id = ?").get(yesterday).cents, 9000, "the other day's line is untouched");
  assert.equal(shop.paymentRow(first.id).status, "failed");
});
