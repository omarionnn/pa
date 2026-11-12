// Their bank, read-only, through Plaid (src/plaid.js, owner brief 2026-11-12). Everything here runs
// through the real `plaid` SDK against test/fixture-plaid.js (documented response shapes), with
// encryption at rest on and strict, so a plaintext write to a sealed column fails the suite.
//
//   connect            a Hosted Link made when it is sent, 30 minutes, with the heads-up to the model
//   first sync         the SESSION_FINISHED webhook exchanges the token, saves the bank, syncs, texts
//   spending           "how much did i spend this week": a number, by category, transfers left out
//   subscriptions      Plaid's recurring streams, or worked out here when the plan lacks them
//   balance            fresh every time; short before a pay step → said, and a new yes is needed
//   reconnect          ITEM_LOGIN_REQUIRED → one text with an update-mode link, then repaired
//   disconnect         /item/remove, the token and that bank's rows gone
//   isolation          somebody else sees none of it and can touch none of it
//   signed-out page    /bank/done says connected or not, and nothing else
//   last four only     no full account number, no token, in any answer, text, page, log or export
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-plaid-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "33".repeat(32);
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_PUBLIC_URL = "https://reason.test";
process.env.REASON_PLAID = "on";
process.env.PLAID_CLIENT_ID = "client_id_fixture";
process.env.PLAID_SECRET = "secret_fixture_never_printed";
delete process.env.PLAID_ENV;
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const d = await import("../src/db.js");
const plaid = await import("../src/plaid.js");
const http = await import("../src/http.js");
const data = await import("../src/data.js");
const { toolsFor } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const { makePlaid } = await import("./fixture-plaid.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const A = "dm:sendblue:+15550001111";
const B = "dm:sendblue:+15550002222";
const NOW = Date.parse("2026-11-12T15:00:00Z"); // a Thursday; the week began Monday 2026-11-09
const raw = (sql, ...a) => d.rawPrepare(sql).all(...a);
const bank = (c, input) => plaid.runPlaidTool("bank", input, { conversationId: c, now: NOW });

let fx, said, logged;
beforeEach(() => {
  for (const t of ["plaid_items", "plaid_accounts", "plaid_transactions", "plaid_links", "plaid_reads", "plaid_pay_checks"]) d.db.exec(`DELETE FROM ${t}`);
  fx = makePlaid(); said = []; logged = [];
  plaid._reset(); plaid._setFetch(fx.fetchImpl);
  plaid.attach({ say: (c, text) => said.push({ c, text }), log: (e) => logged.push(e) });
});

/** Everything a person, a page or a log was given in this test, as one string to search. */
const everythingShown = (...more) => JSON.stringify([said, logged, ...more]);

/** Connect a bank for `c` the way it really happens: the tool makes the link, Plaid's webhook finishes it. */
async function connect(c, opts = {}) {
  const b = fx.addBank(opts);
  const out = await bank(c, { action: "connect" });
  assert.equal(out.ok, true, JSON.stringify(out));
  const linkToken = [...fx.state.links.keys()].pop();
  Object.assign(fx.state.links.get(linkToken), { finished: true, publicTokens: [b.publicToken] });
  const hook = fx.signed({ webhook_type: "LINK", webhook_code: "SESSION_FINISHED", status: "success", link_session_id: "356dbb28", link_token: linkToken, public_tokens: [b.publicToken], environment: "sandbox" });
  const res = await http.plaidWebhookRequest({ ...hook, log: (e) => logged.push(e) });
  assert.equal(res.status, 200, JSON.stringify(res));
  return { ...b, url: out.url, linkToken, tool: out };
}
const week = (b) => [
  fx.tx(b.item, "t1", "2026-11-10", 12.5, "Sweetgreen", "FOOD_AND_DRINK", "RESTAURANT"),
  fx.tx(b.item, "t2", "2026-11-11", 40, "Uber", "TRANSPORTATION", "TAXIS_AND_RIDE_SHARES"),
  fx.tx(b.item, "t3", "2026-11-09", 60.25, "Trader Joe's", "FOOD_AND_DRINK", "GROCERIES"),
  fx.tx(b.item, "t4", "2026-11-03", 100, "Target", "GENERAL_MERCHANDISE", "SUPERSTORES"),
  fx.tx(b.item, "t5", "2026-11-10", 500, "Chase Card Payment", "LOAN_PAYMENTS", "CREDIT_CARD_PAYMENT"),
  fx.tx(b.item, "t6", "2026-11-10", -2000, "Payroll", "INCOME", "SALARY"),
  fx.tx(b.item, "t7", "2026-11-01", 1500, "Parkside Rent", "RENT_AND_UTILITIES", "RENT"),
  fx.tx(b.item, "s1", "2026-08-13", 11.99, "Spotify", "ENTERTAINMENT", "MUSIC_AND_AUDIO"),
  fx.tx(b.item, "s2", "2026-09-13", 11.99, "Spotify", "ENTERTAINMENT", "MUSIC_AND_AUDIO"),
  fx.tx(b.item, "s3", "2026-10-13", 11.99, "Spotify", "ENTERTAINMENT", "MUSIC_AND_AUDIO"),
];
async function push(b, page) {
  b.item.pages.push(page);
  const res = await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: b.item.item_id, initial_update_complete: true, historical_update_complete: true, environment: "sandbox" }) });
  assert.equal(res.status, 200);
  assert.equal(res.body.handled, true);
}

test("the switch: off by default, owner means the operator only, on means everyone; sandbox unless told production", () => {
  const was = process.env.REASON_PLAID;
  try {
    delete process.env.REASON_PLAID;
    assert.equal(plaid.plaidMode(), "off");
    assert.equal(toolsFor(A).some(t => t.name === "bank"), false);
    assert.equal(toolsFor("dm:owner").some(t => t.name === "bank"), false);
    assert.doesNotMatch(systemFor({ name: "Omari", isOperator: true }), /THEIR BANK/);
    process.env.REASON_PLAID = "owner";
    assert.equal(toolsFor(A).some(t => t.name === "bank"), false);
    assert.equal(toolsFor("dm:owner").some(t => t.name === "bank"), true);
    assert.match(systemFor({ name: "Omari", isOperator: true }), /THEIR BANK/);
    assert.doesNotMatch(systemFor({ name: "Ama", isOperator: false }), /THEIR BANK/);
    process.env.REASON_PLAID = "on";
    assert.equal(toolsFor(A).some(t => t.name === "bank"), true);
  } finally { process.env.REASON_PLAID = was; }
  assert.equal(plaid.plaidEnv(), "sandbox");
  process.env.PLAID_ENV = "prodution";
  assert.equal(plaid.plaidEnv(), "sandbox", "a typo never reaches real banks");
  delete process.env.PLAID_ENV;
});

test("no bank connected: a money question gets the offer of a link, never a number", async () => {
  for (const action of ["spending", "transactions", "subscriptions", "balance", "status"]) {
    const out = await bank(A, { action });
    assert.equal(out.ok, false);
    assert.equal(out.error, "no_bank_connected");
    assert.match(out.say, /Don't guess/);
    assert.match(out.say, /link to connect/);
  }
  assert.equal(fx.state.calls.length, 0, "nothing was asked of Plaid");
});

test("connect: a Hosted Link made when it is sent, 30 minutes, read-only products, with the heads-up; nothing about them goes to Plaid", async () => {
  const out = await bank(A, { action: "connect" });
  assert.equal(out.ok, true);
  assert.match(out.url, /^https:\/\/secure\.plaid\.com\/hl\//);
  assert.equal(out.minutes, 30);
  assert.match(out.say, /through Plaid/);
  assert.match(out.say, /only read balances and transactions, never move money/);
  assert.match(out.say, /ON ITS OWN LINE/);
  const [call] = fx.callsTo("/link/token/create");
  assert.equal(fx.state.calls[0].host, "sandbox.plaid.com");
  assert.deepEqual(call.body.products, ["transactions"], "Transactions only; Balance needs no product and nothing that moves money is asked for");
  assert.equal(call.body.transactions.days_requested, 180);
  assert.equal(call.body.hosted_link.url_lifetime_seconds, 1800);
  assert.match(call.body.hosted_link.completion_redirect_uri, /^https:\/\/reason\.test\/bank\/done\?s=[\w-]{20,}$/);
  assert.equal(call.body.webhook, "https://reason.test/plaid/webhook");
  assert.equal(call.body.client_name, "Reason");
  assert.doesNotMatch(JSON.stringify(call.body.user), /5550001111|sendblue/, "Plaid is given a hash, not their number");
  assert.equal(said.length, 0, "the model sends the link; code texts only the confirmation");
  // The link token is sealed where it is kept.
  assert.match(raw("SELECT link_token FROM plaid_links")[0].link_token, /^enc:u1:/);
});

test("first sync: the webhook is verified, the token exchanged server-side and sealed, the bank saved with last four, transactions synced, a confirmation texted", async () => {
  const b = fx.addBank({ mask: "0000" });
  b.item.pages.push({ added: week(b) });
  const out = await bank(A, { action: "connect" });
  const linkToken = [...fx.state.links.keys()].pop();
  Object.assign(fx.state.links.get(linkToken), { finished: true, publicTokens: [b.publicToken] });
  const hook = fx.signed({ webhook_type: "LINK", webhook_code: "SESSION_FINISHED", status: "success", link_session_id: "356dbb28", link_token: linkToken, public_tokens: [b.publicToken], environment: "sandbox" });
  const res = await http.plaidWebhookRequest({ ...hook, log: (e) => logged.push(e) });
  assert.deepEqual(res, { status: 200, body: { ok: true, handled: true } });
  assert.equal(fx.callsTo("/item/public_token/exchange").length, 1);
  assert.deepEqual(said, [{ c: A, text: `First Platypus Bank is connected. i can see balances and transactions, nothing else, and i can't move money. ask me anything, like "how much did i spend this week?"` }]);
  // On disk: the token is sealed (twice: the token key, then their own key), and so is what was synced.
  const item = raw("SELECT * FROM plaid_items")[0];
  assert.match(item.access_token, /^enc:u1:/);
  assert.match(d.db.prepare("SELECT access_token FROM plaid_items WHERE conversation_id = ?").get(A).access_token, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(raw("SELECT * FROM plaid_items").concat(raw("SELECT * FROM plaid_accounts"), raw("SELECT * FROM plaid_transactions"))), /access-sandbox|Sweetgreen|Platypus|Plaid Checking/);
  assert.equal(raw("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ?", A)[0].n, 10);
  assert.equal(d.db.prepare("SELECT mask FROM plaid_accounts WHERE conversation_id = ?").get(A).mask, "0000");
  // The same webhook again, or the done page arriving after it, does nothing twice.
  await http.plaidWebhookRequest({ ...fx.signed(JSON.parse(hook.rawBody)) });
  await http.bankDonePage(new URL(fx.callsTo("/link/token/create")[0].body.hosted_link.completion_redirect_uri).searchParams.get("s"));
  assert.equal(fx.callsTo("/item/public_token/exchange").length, 1);
  assert.equal(said.length, 1);
  const status = await bank(A, { action: "status" });
  assert.deepEqual(status.banks.map(x => [x.bank, x.status, x.accounts]), [["First Platypus Bank", "connected", ["checking ••0000"]]]);
  assert.equal(out.ok, true);
});

test("the webhook is lost: the done page reads the session from Plaid itself and connects them", async () => {
  const b = fx.addBank();
  await bank(A, { action: "connect" });
  const state = new URL(fx.callsTo("/link/token/create")[0].body.hosted_link.completion_redirect_uri).searchParams.get("s");
  // Opened before they finished (Plaid opens it on exit too): not connected, and it says so.
  let page = await http.bankDonePage(state, { waitMs: 200 });
  assert.equal(page.title, "Almost there");
  assert.equal(plaid.hasBank(A), false);
  Object.assign(fx.state.links.get([...fx.state.links.keys()].pop()), { finished: true, publicTokens: [b.publicToken] });
  page = await http.bankDonePage(state);
  assert.equal(page.title, "You're connected");
  assert.equal(plaid.hasBank(A), true);
  assert.equal(said.length, 1);
});

test("how much did i spend this week: the total, by category; card payments, transfers and pay are not spending; updates and removals from Plaid apply", async () => {
  const b = await connect(A);
  await push(b, { added: week(b) });
  let out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.ok, true);
  assert.deepEqual([out.from, out.to, out.total, out.count], ["2026-11-09", "2026-11-12", "$112.75", 3]);
  assert.deepEqual(out.by_category, [{ category: "food", amount: "$72.75" }, { category: "transport", amount: "$40.00" }]);
  assert.match(out.say, /Lead with the total/);
  out = await bank(A, { action: "spending", period: "this_month", category: "food" });
  assert.equal(out.total, "$72.75");
  out = await bank(A, { action: "spending", period: "this_month", category: "groceries" });
  assert.equal(out.total, "$60.25");
  out = await bank(A, { action: "spending", period: "last_week" });
  assert.deepEqual([out.from, out.to, out.total], ["2026-11-02", "2026-11-08", "$100.00"]);
  out = await bank(A, { action: "spending", period: "this_month" });
  assert.equal(out.total, "$1,712.75", "rent, target and the week; not the $500 card payment or the pay cheque");
  // Plaid corrects one and removes another.
  await push(b, { modified: [fx.tx(b.item, "t1", "2026-11-10", 13.5, "Sweetgreen", "FOOD_AND_DRINK", "RESTAURANT")], removed: [{ transaction_id: "t4", account_id: b.item.accounts[0].account_id }] });
  assert.equal((await bank(A, { action: "spending", period: "this_week" })).total, "$113.75");
  assert.equal((await bank(A, { action: "spending", period: "last_week" })).total, "$0.00");
  // The list names an account by its last four and nothing longer.
  const list = await bank(A, { action: "transactions", period: "this_week", search: "uber" });
  assert.deepEqual(list.transactions, [{ date: "2026-11-11", name: "Uber", amount: "$40.00", category: "transport", account: "••0000" }]);
  // Sync asked Plaid with the cursor it was left, never from the start again.
  const cursors = fx.callsTo("/transactions/sync").map(c => c.body.cursor ?? null);
  assert.deepEqual(cursors.slice(0, 3), [null, "cur:0", "cur:1"]);
});

test("subscriptions: Plaid's recurring streams when the plan has them, with what each costs and whether it has gone out this month", async () => {
  const b = await connect(A);
  b.item.recurring = [
    { stream_id: "st1", account_id: b.item.accounts[0].account_id, description: "SPOTIFY USA", merchant_name: "Spotify", frequency: "MONTHLY", is_active: true, status: "MATURE", first_date: "2026-01-13", last_date: "2026-10-13", predicted_next_date: "2026-11-13", average_amount: { amount: 11.99, iso_currency_code: "USD" }, last_amount: { amount: 11.99, iso_currency_code: "USD" }, personal_finance_category: { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_MUSIC_AND_AUDIO" }, transaction_ids: [] },
    { stream_id: "st2", account_id: b.item.accounts[0].account_id, description: "PARKSIDE RENT", merchant_name: "", frequency: "MONTHLY", is_active: true, status: "MATURE", first_date: "2025-12-01", last_date: "2026-11-01", predicted_next_date: "2026-12-01", average_amount: { amount: 1500, iso_currency_code: "USD" }, last_amount: { amount: 1500, iso_currency_code: "USD" }, personal_finance_category: { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT" }, transaction_ids: [] },
    { stream_id: "st3", account_id: b.item.accounts[0].account_id, description: "NETFLIX", merchant_name: "Netflix", frequency: "MONTHLY", is_active: false, status: "TOMBSTONED", last_date: "2026-03-01", average_amount: { amount: 15.49 }, last_amount: { amount: 15.49 }, personal_finance_category: { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_TV_AND_MOVIES" }, transaction_ids: [] },
  ];
  const out = await bank(A, { action: "subscriptions" });
  assert.equal(out.source, "plaid");
  assert.deepEqual(out.subscriptions, [
    { name: "PARKSIDE RENT", amount: "$1,500.00", every: "monthly", category: "bills", last_charged: "2026-11-01", next_expected: "2026-12-01", gone_out_this_month: true },
    { name: "Spotify", amount: "$11.99", every: "monthly", category: "entertainment", last_charged: "2026-10-13", next_expected: "2026-11-13", gone_out_this_month: false },
  ]);
  assert.equal(out.count, 2);
});

test("subscriptions without the add-on: worked out from their own transactions, and the answer says so", async () => {
  const b = await connect(A);
  await push(b, { added: week(b) });
  const out = await bank(A, { action: "subscriptions" });
  assert.equal(out.source, "worked_out_here");
  assert.deepEqual(out.subscriptions.map(s => [s.name, s.amount, s.last_charged, s.gone_out_this_month]), [["Spotify", "$11.99", "2026-10-13", false]]);
  assert.match(out.say, /may miss yearly ones/);
});

test("balance: fetched from the bank every time, never a kept number", async () => {
  const b = await connect(A, { available: 100, current: 110 });
  let out = await bank(A, { action: "balance" });
  assert.deepEqual(out.accounts, [{ account: "First Platypus Bank checking ••0000", available: "$100.00", current: "$110.00" }]);
  b.item.accounts[0].balances.available = 42.1;
  out = await bank(A, { action: "balance" });
  assert.equal(out.accounts[0].available, "$42.10");
  assert.equal(fx.callsTo("/accounts/balance/get").length, 2);
  assert.doesNotMatch(JSON.stringify(raw("SELECT * FROM plaid_accounts")), /balance|available/);
  assert.deepEqual(d.db.prepare("PRAGMA table_info(plaid_accounts)").all().map(c => c.name), ["conversation_id", "item_id", "account_id", "name", "mask", "type", "subtype"], "there is no column a balance could be kept in");
});

test("balance too low before a pay step: nothing is paid on the yes already given; they are told, and a later text is the go-ahead", async () => {
  const shop = await import("../src/shopconnect.js");
  const { runShopTool } = await import("../src/shoptools.js");
  const OMARI = "dm:owner";
  const crossmint = [];
  shop._setFetch(async (url) => { crossmint.push(new URL(url).pathname); return { status: 404, ok: false, text: async () => "{}" }; });
  shop.attach({ say: () => {}, log: () => {}, base: "https://heyreason.test/web/connect" });
  const b = await connect(OMARI, { available: 20 });
  d.db.prepare("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES ('run_1', ?, 'conedison', 'guest', 'electric bill', 'awaiting_input', 0, 0)").run(OMARI);
  const row = shop.recordPayment({ conversationId: OMARI, runId: "run_1", item: "electric bill", request: { requestId: "req_1", request: { question: "Approve $84.10", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    interaction: { kind: "payment", method: "card", amount: { kind: "exact", value: "84.10", currency: "USD" }, merchant: { name: "Con Edison", url: "https://www.coned.com", countryCode: "US" } } } } });
  const yes = [{ role: "user", content: "pay my con ed bill" }, { role: "user", content: "yes" }];
  let out = await runShopTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: OMARI, confirmationId: 1, messages: yes });
  assert.equal(out.ok, false);
  assert.equal(out.error, "balance_looks_short");
  assert.deepEqual([out.account, out.available, out.needed], ["First Platypus Bank checking ••0000", "$20.00", "$84.10"]);
  assert.match(out.say, /Nothing was paid/);
  assert.match(out.say, /ask if they still want to go ahead/);
  assert.equal(crossmint.length, 0, "Crossmint was never asked to pay");
  assert.equal(shop.paymentRow(row.id).status, "asked");
  // The model trying again on the same yes is stopped again, with a fresh balance each time.
  out = await runShopTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: OMARI, confirmationId: 1, messages: yes });
  assert.equal(out.error, "balance_looks_short");
  assert.equal(fx.callsTo("/accounts/balance/get").length, 2);
  // They answer after the warning: the pay step goes on to Crossmint as it always did.
  out = await runShopTool("shop_pay", { payment_id: row.id, confirmation_id: 2 }, { conversationId: OMARI, confirmationId: 2, messages: [...yes, { role: "user", content: "yes go ahead anyway" }] });
  assert.notEqual(out.error, "balance_looks_short");
  // Enough in the account: no warning at all. And Plaid being down never blocks a payment.
  assert.deepEqual(await plaid.balanceCheck(OMARI, 19.99), { checked: true, short: false });
  b.item.failWith = "INSTITUTION_DOWN";
  assert.deepEqual(await plaid.balanceCheck(OMARI, 84.1), { checked: false });
  assert.deepEqual(await plaid.balanceCheck(A, 84.1), { checked: false }, "nobody's balance but their own: A has no bank");
});

test("reconnect after the login expires: one text with a fresh update-mode link, numbers flagged as behind, repaired when they sign in", async () => {
  const b = await connect(A);
  said.length = 0;
  const expired = { webhook_type: "ITEM", webhook_code: "ERROR", item_id: b.item.item_id, error: { display_message: null, error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details of this item have changed", error_type: "ITEM_ERROR", status: 400 }, environment: "sandbox" };
  assert.equal((await http.plaidWebhookRequest({ ...fx.signed(expired) })).status, 200);
  assert.equal(said.length, 1);
  assert.equal(said[0].c, A);
  assert.match(said[0].text, /^First Platypus Bank signed me out, so i can't see your account right now\. tap here to reconnect \(same as before, read-only, good for 30 min\):\nhttps:\/\/secure\.plaid\.com\/hl\/\w+$/);
  const update = fx.callsTo("/link/token/create").pop().body;
  assert.equal(update.access_token, b.access, "update mode: the Item's own token");
  assert.equal(update.products, undefined, "and no products, as Plaid's update mode requires");
  assert.equal(update.hosted_link.url_lifetime_seconds, 1800);
  // Plaid says it again an hour later: no second text.
  await http.plaidWebhookRequest({ ...fx.signed(expired) });
  assert.equal(said.length, 1);
  const out = await bank(A, { action: "spending", period: "this_week" });
  assert.deepEqual(out.needs_reconnect, ["First Platypus Bank"]);
  assert.equal((await bank(A, { action: "status" })).banks[0].status, "needs_reconnect");
  // They ask for the link again: a new one is made then and there for the model to send.
  const again = await bank(A, { action: "connect" });
  assert.equal(again.reconnecting, "First Platypus Bank");
  assert.equal(fx.callsTo("/link/token/create").pop().body.access_token, b.access);
  // They back out of signing in: Plaid opens our page anyway, and it does not claim anything.
  const linkToken = [...fx.state.links.keys()].pop();
  const state = new URL(fx.callsTo("/link/token/create").pop().body.hosted_link.completion_redirect_uri).searchParams.get("s");
  Object.assign(fx.state.links.get(linkToken), { finished: true, exited: true });
  assert.equal((await http.bankDonePage(state, { waitMs: 200 })).title, "Almost there");
  assert.equal((await bank(A, { action: "status" })).banks[0].status, "needs_reconnect");
  // They sign in; Plaid's page sends them to ours, which sees the session succeeded.
  Object.assign(fx.state.links.get(linkToken), { finished: true, exited: false });
  assert.equal((await http.bankDonePage(state)).title, "You're connected");
  assert.equal((await bank(A, { action: "status" })).banks[0].status, "connected");
  assert.equal(said[said.length - 1].text, "First Platypus Bank is reconnected, you're all set");
  // A sync that meets the error itself (no webhook) asks the same way.
  said.length = 0; b.item.failWith = "ITEM_LOGIN_REQUIRED";
  assert.equal((await plaid.sync(A, b.item.item_id)).error, "login_required");
  assert.equal(said.length, 1);
});

test("disconnect my bank: /item/remove, then the token and everything synced from that bank are gone; the other bank and other people are untouched", async () => {
  const b1 = await connect(A, { institution: "First Platypus Bank", mask: "0000" });
  const b2 = await connect(A, { institution: "Tartan Bank", mask: "4321" });
  const bb = await connect(B, { institution: "First Platypus Bank", mask: "9999" });
  await push(b1, { added: week(b1) });
  await push(b2, { added: [fx.tx(b2.item, "x1", "2026-11-10", 5, "Blue Bottle", "FOOD_AND_DRINK", "COFFEE")] });
  await push(bb, { added: [fx.tx(bb.item, "y1", "2026-11-10", 7, "Joe's Pizza", "FOOD_AND_DRINK", "RESTAURANT")] });
  // Two banks and none named: asked which, nothing removed.
  let out = await bank(A, { action: "disconnect" });
  assert.equal(out.error, "which_bank");
  assert.equal(fx.callsTo("/item/remove").length, 0);
  out = await bank(A, { action: "disconnect", bank: "platypus" });
  assert.deepEqual(out.removed, ["First Platypus Bank"]);
  assert.deepEqual(fx.callsTo("/item/remove").map(c => c.body.access_token), [b1.access]);
  const left = (t) => raw(`SELECT item_id FROM ${t} WHERE conversation_id = ?`, A).map(r => r.item_id);
  assert.deepEqual([...new Set(left("plaid_items"))], [b2.item.item_id]);
  assert.deepEqual([...new Set(left("plaid_accounts"))], [b2.item.item_id]);
  assert.deepEqual([...new Set(left("plaid_transactions"))], [b2.item.item_id]);
  assert.equal((await bank(A, { action: "spending", period: "this_week" })).total, "$5.00");
  // Somebody else's bank of the same name is exactly as it was.
  assert.equal((await bank(B, { action: "spending", period: "this_week" })).total, "$7.00");
  assert.equal(bb.item.removed, false);
  // Plaid unreachable for the second: their data still goes at once, and the removal is tried again later.
  const failing = plaid._setFetch(async (input, init) => (String(input?.url ?? input).endsWith("/item/remove") ? new Response("{}", { status: 500 }) : fx.fetchImpl(input, init)));
  out = await bank(A, { action: "disconnect", all: true });
  assert.deepEqual(out.plaid_removal_pending, ["Tartan Bank"]);
  assert.equal(raw("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ?", A)[0].n, 0);
  assert.equal(plaid.hasBank(A), false);
  assert.equal((await bank(A, { action: "spending" })).error, "no_bank_connected");
  plaid._setFetch(fx.fetchImpl);
  assert.equal(await plaid.retryRemovals(), 1);
  assert.equal(b2.item.removed, true);
  assert.equal(raw("SELECT COUNT(*) AS n FROM plaid_items WHERE conversation_id = ?", A)[0].n, 0);
  assert.equal(failing, undefined);
});

test("cross-user isolation: B sees none of A's money, cannot name A's bank, and A's webhooks never touch B", async () => {
  const a = await connect(A, { institution: "First Platypus Bank", mask: "0000", available: 100 });
  await push(a, { added: week(a) });
  for (const action of ["spending", "transactions", "subscriptions", "balance", "status"]) assert.equal((await bank(B, { action })).error, "no_bank_connected", action);
  assert.equal((await bank(B, { action: "disconnect", bank: "First Platypus Bank" })).error, "no_bank_connected");
  assert.equal(a.item.removed, false);
  assert.deepEqual(plaid.spending(B, { from: "2026-01-01", to: "2026-12-31" }).count, 0);
  assert.deepEqual(plaid.accountsOf(B), []);
  assert.deepEqual(await plaid.sync(B, a.item.item_id), { ok: false, error: "no_such_bank" });
  assert.deepEqual(await plaid.createLink(B, { itemId: a.item.item_id }), { ok: false, error: "no_such_bank" }, "no update link for somebody else's bank");
  const b = await connect(B, { institution: "Tartan Bank", mask: "4321", available: 5 });
  await push(b, { added: [fx.tx(b.item, "y1", "2026-11-10", 7, "Joe's Pizza", "FOOD_AND_DRINK", "RESTAURANT")] });
  assert.equal((await bank(B, { action: "spending", period: "this_month" })).total, "$7.00");
  assert.equal((await bank(A, { action: "spending", period: "this_week" })).total, "$112.75");
  assert.deepEqual((await bank(B, { action: "balance" })).accounts.map(x => x.account), ["Tartan Bank checking ••4321"]);
  assert.doesNotMatch(JSON.stringify(await bank(B, { action: "transactions", period: "last_90_days" })), /Sweetgreen|Uber|Parkside|0000/);
  // A's login expiring texts A, with A's link, and nobody else.
  said.length = 0;
  await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: a.item.item_id, error: { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR" } }) });
  assert.deepEqual(said.map(s => s.c), [A]);
  assert.equal((await bank(B, { action: "status" })).banks[0].status, "connected");
  // A webhook for an Item nobody has is acknowledged and changes nothing.
  const res = await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item_nobody" }) });
  assert.deepEqual(res.body, { ok: true, handled: false });
});

test("webhook signatures: unsigned, forged, stale, tampered, wrong algorithm and expired keys are all refused before anything is read", async () => {
  const a = await connect(A);
  a.item.pages.push({ added: week(a) });
  const event = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: a.item.item_id };
  const before = fx.callsTo("/transactions/sync").length;
  const rejected = async (hook, why) => { const r = await http.plaidWebhookRequest({ ...hook, log: (e) => logged.push(e) }); assert.equal(r.status, 401, why); assert.match(r.body.error, new RegExp(why)); };
  await rejected({ rawBody: JSON.stringify(event), headers: {} }, "no signature");
  const other = makePlaid().signed(event);
  await rejected(other, "bad signature");
  await rejected(fx.signed(event, { iat: Math.floor(Date.now() / 1000) - 6 * 60 }), "stale");
  await rejected(fx.signed(event, { tamper: true }), "body does not match");
  await rejected(fx.signed(event, { alg: "HS256" }), "wrong algorithm");
  await rejected(fx.signed(event, { kid: "some-other-key" }), "key lookup failed");
  assert.equal(fx.callsTo("/transactions/sync").length, before, "none of them reached a sync");
  // A key Plaid has expired is refused even though the signature is good.
  plaid._reset(); plaid._setFetch(fx.fetchImpl); fx.state.keyExpired = true;
  await rejected(fx.signed(event), "expired key");
  // The good one: Plaid's 2-space body, case-insensitive header.
  plaid._reset(); plaid._setFetch(fx.fetchImpl); fx.state.keyExpired = false;
  const good = fx.signed(event);
  assert.equal((await http.plaidWebhookRequest({ rawBody: good.rawBody, headers: { "Plaid-Verification": good.headers["plaid-verification"] } })).status, 200);
  assert.equal(fx.callsTo("/transactions/sync").length, before + 1);
});

test("signed-out page: /bank/done shows no bank, balance, transaction or number, whoever opens it and whatever the link's state", async () => {
  const a = await connect(A, { mask: "0000", available: 1234.56 });
  await push(a, { added: week(a) });
  const state = new URL(fx.callsTo("/link/token/create")[0].body.hosted_link.completion_redirect_uri).searchParams.get("s");
  const pages = [await http.bankDonePage(state), await http.bankDonePage("not-a-real-link"), await http.bankDonePage("")];
  assert.deepEqual(pages.map(p => p.title), ["You're connected", "Link closed", "Link closed"]);
  for (const p of pages) {
    assert.doesNotMatch(p.body, /Platypus|0000|1234|\$|Sweetgreen|checking|access-|link-sandbox|5550001111/);
  }
  // And over real HTTP, with no cookie: the same page, never cached, never indexed.
  const server = http.createServer({ router: null, runtime: null, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/bank/done?s=${state}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /You&#39;re connected|You're connected/);
    assert.match(res.headers.get("cache-control"), /no-store/);
    assert.doesNotMatch(html, /Platypus|••|Sweetgreen|1234\.56|access-sandbox/);
    // No page anywhere lists their money: the only other Plaid address is the webhook, which wants a signature.
    assert.equal((await fetch(`${base}/plaid/webhook`, { method: "POST", body: "{}" })).status, 401);
    for (const path of ["/bank", "/bank/transactions", "/bank/balance", "/plaid", "/plaid/items"]) {
      const r = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.doesNotMatch(await r.text(), /Platypus|Sweetgreen|••0000/, path);
    }
  } finally { await new Promise(r => server.close(r)); }
});

test("last four only: no full account number and no token in any answer, text, page, log or export", async () => {
  const FULL = "1111222233330000";
  const a = await connect(A, { mask: "0000", number: FULL });
  await push(a, { added: week(a) });
  a.item.recurring = [];
  const answers = [];
  for (const input of [{ action: "status" }, { action: "spending", period: "this_month" }, { action: "transactions", period: "last_90_days" }, { action: "subscriptions" }, { action: "balance" }, { action: "connect" }]) answers.push(await bank(A, input));
  await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: a.item.item_id, error: { error_code: "ITEM_LOGIN_REQUIRED" } }), log: (e) => logged.push(e) });
  const exported = data.exportData({ conversation: A, audio: false, files: false });
  const shown = everythingShown(answers, exported, await http.bankDonePage("x"));
  assert.doesNotMatch(shown, new RegExp(FULL), "the full account number never leaves the fixture");
  assert.doesNotMatch(shown, /access-sandbox|public-sandbox|link-sandbox|secret_fixture/, "no token and no secret");
  assert.match(JSON.stringify(answers), /••0000/);
  // The export lists the bank as theirs, with the credential replaced by a marker.
  assert.equal(exported.tables.plaid_items.length, 1);
  assert.equal(exported.tables.plaid_items[0].access_token, "[not exported: this is a live credential]");
  assert.equal(exported.tables.plaid_transactions.length, 10);
  // Nothing that could return a full number was ever asked of Plaid.
  const asked = new Set(fx.state.calls.map(c => c.path));
  for (const p of ["/auth/get", "/processor/token/create", "/transfer/create", "/payment_initiation/payment/create", "/identity/get"]) assert.equal(asked.has(p), false, p);
  // The stored account row has the four digits and no column for more.
  assert.equal(d.db.prepare("SELECT mask FROM plaid_accounts WHERE conversation_id = ?").get(A).mask, "0000");
  // Tool results never carry the token either, whatever was asked.
  assert.doesNotMatch(JSON.stringify(answers), new RegExp(a.access));
});

test("memory: a reply that answered from their bank is kept out of the extractor and the nightly review; their own words are not", async () => {
  const a = await connect(A);
  await push(a, { added: week(a) });
  assert.equal(plaid.financeReply(A), false, "connecting is not a read");
  await bank(A, { action: "spending", period: "this_week" });
  assert.equal(plaid.financeReply(A), true);
  assert.equal(plaid.financeReply(B), false);
  const at = Date.now();
  const rows = [{ id: 1, role: "user", at: at - 1000, content: "how much did i spend this week? i'm saving for a trip to lisbon" }, { id: 2, role: "assistant", at: at + 2000, content: "$112.75 so far this week, mostly food" }, { id: 3, role: "assistant", at: at + 20 * 60_000, content: "lisbon in may is lovely" }];
  assert.deepEqual(plaid.withoutFinanceReplies(A, rows).map(r => r.id), [1, 3]);
  assert.deepEqual(plaid.withoutFinanceReplies(B, rows).map(r => r.id), [1, 2, 3]);
  // The model is told the same thing, in the tool and (when on) the prompt.
  assert.match(plaid.PLAID_TOOL_DEFS[0].description, /never save them with remember/);
  assert.match(plaid.PLAID_RULES, /never investment, tax or insurance advice/);
  assert.match(plaid.PLAID_RULES, /anything another person can see/);
});

test("forget me: a full delete lets go at Plaid first, then every row of theirs is gone and the other person's stay", async () => {
  const a = await connect(A);
  const b = await connect(B, { institution: "Tartan Bank", mask: "4321" });
  await push(a, { added: week(a) });
  await bank(A, { action: "spending" });
  const out = await data.deleteData({ conversation: A });
  assert.deepEqual(out.plaid, { removed: 1, failed: 0 });
  assert.equal(a.item.removed, true);
  assert.equal(b.item.removed, false);
  for (const t of ["plaid_items", "plaid_accounts", "plaid_transactions", "plaid_links", "plaid_reads", "plaid_pay_checks"]) assert.equal(raw(`SELECT COUNT(*) AS n FROM ${t} WHERE conversation_id = ?`, A)[0].n, 0, t);
  assert.equal(plaid.hasBank(B), true);
});

test("they turn off access at the bank: Plaid says so, and their data here goes the same as a disconnect", async () => {
  const a = await connect(A);
  await push(a, { added: week(a) });
  said.length = 0;
  await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: a.item.item_id, error: { error_code: "USER_PERMISSION_REVOKED" } }) });
  assert.equal(plaid.hasBank(A), false);
  assert.equal(raw("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ?", A)[0].n, 0);
  assert.deepEqual(said.map(s => s.text), ["First Platypus Bank told me you turned off my access, so i've disconnected it and deleted what i had from it"]);
});

test("keys not set: the tool says bank connections aren't set up, and nothing is guessed", async () => {
  const id = process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_CLIENT_ID;
  try {
    const out = await bank(A, { action: "connect" });
    assert.equal(out.error, "not_set_up");
    assert.equal(fx.state.calls.length, 0);
  } finally { process.env.PLAID_CLIENT_ID = id; }
});
