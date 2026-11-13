// Their bank, read-only, through Plaid (src/plaid.js, owner brief 2026-11-12). Everything here runs
// through the real `plaid` SDK against test/fixture-plaid.js, with encryption at rest on and strict,
// so a plaintext write to a sealed column fails the suite. The fixture answers the way Plaid's real
// Sandbox did on 2026-11-13 (recorded in test/fixtures/plaid/ by scripts/plaid-sandbox-proof.mjs),
// and the last tests here hold it to those recordings: the same fields, and the same first answer
// (nothing, NOT_READY) from a bank that was only just connected.
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
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
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
const { makePlaid: makeFixture } = await import("./fixture-plaid.js");
const { clock } = await import("../src/config.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const A = "dm:sendblue:+15550001111";
const B = "dm:sendblue:+15550002222";
const NOW = Date.parse("2026-11-12T15:00:00Z"); // a Thursday; the week began Monday 2026-11-09. 60 days back is 2026-09-13.
// The code's clock is set to that day, so the 60-day rule reads the same whenever this runs.
clock.skip(NOW - Date.now());
const makePlaid = () => makeFixture({ now: () => clock.now() });
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
/** Plaid's SYNC_UPDATES_AVAILABLE webhook for this bank: what brings transactions in when webhooks work. */
async function arrive(b) {
  const res = await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: b.item.item_id, initial_update_complete: true, historical_update_complete: true, environment: "sandbox" }) });
  assert.equal(res.status, 200);
  assert.equal(res.body.handled, true);
}
async function push(b, page) {
  b.item.pages.push(page);
  await arrive(b);
}
const stored = (c) => raw("SELECT COUNT(*) AS n FROM plaid_transactions WHERE conversation_id = ?", c)[0].n;

test("the switch: off by default, owner means the operator only, on means everyone; sandbox unless told production", () => {
  const was = process.env.REASON_PLAID;
  try {
    delete process.env.REASON_PLAID;
    const promptOff = systemFor({ name: "Omari", isOperator: true }).length;
    assert.equal(plaid.plaidMode(), "off");
    assert.equal(toolsFor(A).some(t => t.name === "bank"), false);
    assert.equal(toolsFor("dm:owner").some(t => t.name === "bank"), false);
    process.env.REASON_PLAID = "owner";
    assert.equal(toolsFor(A).some(t => t.name === "bank"), false);
    assert.equal(toolsFor("dm:owner").some(t => t.name === "bank"), true);
    // Nothing is added to the system prompt (it is at its budget): the rules ride on the tool.
    assert.equal(systemFor({ name: "Omari", isOperator: true }).length, promptOff);
    process.env.REASON_PLAID = "on";
    assert.equal(toolsFor(A).some(t => t.name === "bank"), true);
  } finally { process.env.REASON_PLAID = was; }
  assert.equal(plaid.plaidEnv(), "sandbox");
  // The secret may be named for its environment: PLAID_SECRET_SANDBOX is read in sandbox and never in production.
  const sec = process.env.PLAID_SECRET;
  delete process.env.PLAID_SECRET;
  assert.equal(plaid.configured(), false);
  process.env.PLAID_SECRET_SANDBOX = "sandbox_only";
  assert.equal(plaid.configured(), true);
  process.env.PLAID_ENV = "production";
  assert.equal(plaid.configured(), false);
  delete process.env.PLAID_ENV; delete process.env.PLAID_SECRET_SANDBOX; process.env.PLAID_SECRET = sec;
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

test("first sync: the webhook is verified, the token exchanged server-side and sealed, the bank saved with last four, a confirmation texted; the transactions come with Plaid's next webhook", async () => {
  const b = fx.addBank({ mask: "0000" });
  b.item.pages.push({ added: week(b) });
  const out = await bank(A, { action: "connect" });
  const linkToken = [...fx.state.links.keys()].pop();
  Object.assign(fx.state.links.get(linkToken), { finished: true, publicTokens: [b.publicToken] });
  const hook = fx.signed({ webhook_type: "LINK", webhook_code: "SESSION_FINISHED", status: "success", link_session_id: "356dbb28", link_token: linkToken, public_tokens: [b.publicToken], environment: "sandbox" });
  const res = await http.plaidWebhookRequest({ ...hook, log: (e) => logged.push(e) });
  assert.deepEqual(res, { status: 200, body: { ok: true, handled: true } });
  assert.equal(fx.callsTo("/item/public_token/exchange").length, 1);
  assert.deepEqual(said, [{ c: A, text: `First Platypus Bank is connected. i can see balances and transactions, nothing else, and i can't move money. ask me what you spent this week, what your subscriptions are, anything like that` }]);
  // On disk: the token is sealed (twice: the token key, then their own key), and so is what was synced.
  const item = raw("SELECT * FROM plaid_items")[0];
  assert.match(item.access_token, /^enc:u1:/);
  assert.match(d.db.prepare("SELECT access_token FROM plaid_items WHERE conversation_id = ?").get(A).access_token, /^enc:v1:/);
  // The first sync, made the moment the token is exchanged, has nothing: that is how the real Sandbox answers every time.
  assert.deepEqual(fx.callsTo("/transactions/sync").map(c => c.body.cursor ?? null), [null]);
  assert.equal(stored(A), 0);
  assert.deepEqual([item.history, item.cursor], ["NOT_READY", ""]);
  assert.equal((await bank(A, { action: "status" })).banks[0].transactions, "still coming in from the bank");
  // Seconds later Plaid says there is something to fetch.
  await arrive(b);
  assert.equal(stored(A), 9, "the August charge is older than 60 days and was never stored");
  assert.equal(raw("SELECT history FROM plaid_items")[0].history, "HISTORICAL_UPDATE_COMPLETE");
  assert.doesNotMatch(JSON.stringify(raw("SELECT * FROM plaid_items").concat(raw("SELECT * FROM plaid_accounts"), raw("SELECT * FROM plaid_transactions"))), /access-sandbox|Sweetgreen|Platypus|Plaid Checking/);
  assert.equal(d.db.prepare("SELECT mask FROM plaid_accounts WHERE conversation_id = ?").get(A).mask, "0000");
  // The same webhook again, or the done page arriving after it, does nothing twice.
  await http.plaidWebhookRequest({ ...fx.signed(JSON.parse(hook.rawBody)) });
  await http.bankDonePage(new URL(fx.callsTo("/link/token/create")[0].body.hosted_link.completion_redirect_uri).searchParams.get("s"));
  assert.equal(fx.callsTo("/item/public_token/exchange").length, 1);
  assert.equal(said.length, 1);
  const status = await bank(A, { action: "status" });
  assert.deepEqual(status.banks.map(x => [x.bank, x.status, x.accounts, x.transactions]), [["First Platypus Bank", "connected", ["Plaid Checking ••0000"], undefined]]);
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
  assert.deepEqual(list.transactions, [{ date: "2026-11-11", name: "Uber", amount: "$40.00", category: "transport", account: "First Platypus Bank Plaid Checking ••0000" }]);
  // The first answer (NOT_READY) left no cursor, so the second sync started over; after that, always the cursor it was left.
  const cursors = fx.callsTo("/transactions/sync").map(c => c.body.cursor ?? null);
  assert.deepEqual(cursors, [null, null, "cur:1"], "and no question asked Plaid again inside 30 seconds of a sync");
});

test("subscriptions: Plaid's recurring streams when the plan has them, with what each costs and whether it has gone out this month", async () => {
  const b = await connect(A);
  await push(b, { added: week(b) });
  b.item.recurring = [
    fx.stream(b.item, "Spotify", 11.99, "MONTHLY", "2026-10-13", "2026-11-13", "ENTERTAINMENT", "MUSIC_AND_AUDIO", { description: "SPOTIFY USA" }),
    // No merchant: the real answer has "" there, and the bank's own line is the name.
    fx.stream(b.item, "", 1500, "MONTHLY", "2026-11-01", "2026-12-01", "RENT_AND_UTILITIES", "RENT", { description: "PARKSIDE RENT" }),
    fx.stream(b.item, "Netflix", 15.49, "MONTHLY", "2026-03-01", "2026-04-01", "ENTERTAINMENT", "TV_AND_MOVIES", { is_active: false, status: "TOMBSTONED" }),
    // The real Sandbox lists a card's own autopay as a stream, labelled a transfer: not a subscription.
    fx.stream(b.item, "", 2078.5, "MONTHLY", "2026-10-20", "2026-11-20", "TRANSFER_OUT", "ACCOUNT_TRANSFER", { description: "AUTOMATIC PAYMENT - THANK" }),
  ];
  const out = await bank(A, { action: "subscriptions" });
  assert.equal(out.source, "plaid");
  assert.equal(out.per_month, "$1,511.99", "two monthly charges cost exactly their sum a month");
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
  assert.deepEqual(out.accounts, [{ account: "First Platypus Bank Plaid Checking ••0000", available: "$100.00", current: "$110.00" }]);
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
  const row = shop.recordPayment({ conversationId: OMARI, runId: "run_1", item: "electric bill", request: { requestId: "req_1", request: { question: "Approve $84.10", expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
    interaction: { kind: "payment", method: "card", amount: { kind: "exact", value: "84.10", currency: "USD" }, merchant: { name: "Con Edison", url: "https://www.coned.com", countryCode: "US" } } } } });
  const yes = [{ role: "user", content: "pay my con ed bill" }, { role: "user", content: "yes" }];
  let out = await runShopTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: OMARI, confirmationId: 1, messages: yes });
  assert.equal(out.ok, false);
  assert.equal(out.error, "balance_looks_short");
  assert.deepEqual([out.account, out.available, out.needed], ["First Platypus Bank Plaid Checking ••0000", "$20.00", "$84.10"]);
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
  assert.deepEqual(plaid.spending(B, { from: "2026-09-13", to: "2026-11-12" }).count, 0);
  assert.deepEqual(plaid.accountsOf(B), []);
  assert.deepEqual(await plaid.sync(B, a.item.item_id), { ok: false, error: "no_such_bank" });
  assert.deepEqual(await plaid.createLink(B, { itemId: a.item.item_id }), { ok: false, error: "no_such_bank" }, "no update link for somebody else's bank");
  const b = await connect(B, { institution: "Tartan Bank", mask: "4321", available: 5 });
  await push(b, { added: [fx.tx(b.item, "y1", "2026-11-10", 7, "Joe's Pizza", "FOOD_AND_DRINK", "RESTAURANT")] });
  assert.equal((await bank(B, { action: "spending", period: "this_month" })).total, "$7.00");
  assert.equal((await bank(A, { action: "spending", period: "this_week" })).total, "$112.75");
  assert.deepEqual((await bank(B, { action: "balance" })).accounts.map(x => x.account), ["Tartan Bank Plaid Checking ••4321"]);
  assert.doesNotMatch(JSON.stringify(await bank(B, { action: "transactions", period: "last_60_days" })), /Sweetgreen|Uber|Parkside|0000/);
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
  await rejected(fx.signed(event, { iat: Math.floor(clock.now() / 1000) - 6 * 60 }), "stale");
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
  for (const input of [{ action: "status" }, { action: "spending", period: "this_month" }, { action: "transactions", period: "last_60_days" }, { action: "subscriptions" }, { action: "balance" }, { action: "connect" }]) answers.push(await bank(A, input));
  await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: a.item.item_id, error: { error_code: "ITEM_LOGIN_REQUIRED" } }), log: (e) => logged.push(e) });
  const exported = data.exportData({ conversation: A, audio: false, files: false });
  const shown = everythingShown(answers, exported, await http.bankDonePage("x"));
  assert.doesNotMatch(shown, new RegExp(FULL), "the full account number never leaves the fixture");
  assert.doesNotMatch(shown, /access-sandbox|public-sandbox|link-sandbox|secret_fixture/, "no token and no secret");
  assert.match(JSON.stringify(answers), /Plaid Checking ••0000/);
  // The export lists the bank as theirs, with the credential replaced by a marker.
  assert.equal(exported.tables.plaid_items.length, 1);
  assert.equal(exported.tables.plaid_items[0].access_token, "[not exported: this is a live credential]");
  assert.equal(exported.tables.plaid_transactions.length, 9);
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
  const at = clock.now();
  const rows = [{ id: 1, role: "user", at: at - 1000, content: "how much did i spend this week? i'm saving for a trip to lisbon" }, { id: 2, role: "assistant", at: at + 2000, content: "$112.75 so far this week, mostly food" }, { id: 3, role: "assistant", at: at + 20 * 60_000, content: "lisbon in may is lovely" }];
  assert.deepEqual(plaid.withoutFinanceReplies(A, rows).map(r => r.id), [1, 3]);
  assert.deepEqual(plaid.withoutFinanceReplies(B, rows).map(r => r.id), [1, 2, 3]);
  // The model is told the same thing, in the tool and (when on) the prompt.
  assert.match(plaid.PLAID_TOOL_DEFS[0].description, /never save it with remember/);
  assert.match(plaid.PLAID_TOOL_DEFS[0].description, /never investment, tax or insurance advice/);
  assert.match(plaid.PLAID_TOOL_DEFS[0].description, /anything another person can see/);
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

// ---------------------------------------------------------------- owner's additions, 2026-11-12 10:45
/** Checking at one bank, a credit card at another, savings at a third: three Items, each its own token. */
async function three(c) {
  const chk = await connect(c, { institution: "First Platypus Bank", mask: "0000", kind: "checking" });
  const card = await connect(c, { institution: "Tartan Bank", mask: "4321", kind: "credit", current: 365 });
  const sav = await connect(c, { institution: "Harbor Savings", mask: "7777", kind: "savings", available: 900 });
  return { chk, card, sav };
}

test("several connections: each is its own Item with its own sealed token, cursor and webhook; totals, categories and subscriptions combine all of them", async () => {
  const { chk, card, sav } = await three(A);
  const items = d.db.prepare("SELECT item_id, access_token, cursor FROM plaid_items WHERE conversation_id = ? ORDER BY id").all(A);
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map(i => i.access_token)).size, 3, "three different tokens");
  for (const r of raw("SELECT access_token FROM plaid_items WHERE conversation_id = ?", A)) assert.match(r.access_token, /^enc:u1:/);
  await push(chk, { added: [fx.tx(chk.item, "c1", "2026-11-09", 60.25, "Trader Joe's", "FOOD_AND_DRINK", "GROCERIES")] });
  await push(card, { added: [fx.tx(card.item, "k1", "2026-11-11", 40, "Uber", "TRANSPORTATION", "TAXIS_AND_RIDE_SHARES"), fx.tx(card.item, "k2", "2026-11-10", 25, "Netflix", "ENTERTAINMENT", "TV_AND_MOVIES")] });
  // A webhook for one Item syncs that Item only, from its own cursor.
  const cursors = Object.fromEntries(d.db.prepare("SELECT item_id, cursor FROM plaid_items WHERE conversation_id = ?").all(A).map(r => [r.item_id, r.cursor]));
  assert.deepEqual([cursors[chk.item.item_id], cursors[card.item.item_id], cursors[sav.item.item_id]], ["cur:1", "cur:1", ""], "the savings bank has only had its first, empty answer");
  const out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.total, "$125.25");
  // The savings bank has nothing in yet, minutes after connecting: the answer covers the other two and says so.
  assert.deepEqual(out.still_loading, ["Harbor Savings"]);
  assert.match(out.loading_note, /Harbor Savings was only just connected.*never give this as their whole spending/);
  assert.deepEqual(out.by_category, [{ category: "food", amount: "$60.25" }, { category: "transport", amount: "$40.00" }, { category: "entertainment", amount: "$25.00" }]);
  assert.deepEqual(out.by_account, [{ account: "Tartan Bank Plaid Credit Card ••4321", amount: "$65.00" }, { account: "First Platypus Bank Plaid Checking ••0000", amount: "$60.25" }]);
  // Subscriptions come from every Item; a yearly one is named because Plaid's recurring data reports it.
  const stream = fx.stream;
  chk.item.recurring = [stream(chk.item, "Parkside Rent", 1500, "MONTHLY", "2026-11-01", "2026-12-01", "RENT_AND_UTILITIES", "RENT")];
  card.item.recurring = [stream(card.item, "Netflix", 25, "MONTHLY", "2026-11-10", "2026-12-10", "ENTERTAINMENT", "TV_AND_MOVIES"), stream(card.item, "Amazon Prime", 139, "ANNUALLY", "2026-02-02", "2027-02-02", "GENERAL_MERCHANDISE", "ONLINE_MARKETPLACES")];
  sav.item.recurring = [];
  const subs = await bank(A, { action: "subscriptions" });
  assert.equal(subs.source, "plaid");
  assert.deepEqual(subs.subscriptions.map(x => [x.name, x.amount, x.every]), [["Parkside Rent", "$1,500.00", "monthly"], ["Netflix", "$25.00", "monthly"], ["Amazon Prime", "$139.00", "annually"]]);
  assert.equal(subs.per_month, "$1,536.58", "1500 + 25 + a twelfth of the yearly 139");
  // Update mode is per Item: the card's login expiring asks for the card's bank, with the card's token.
  said.length = 0;
  await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: card.item.item_id, error: { error_code: "ITEM_LOGIN_REQUIRED" } }) });
  assert.match(said[0].text, /^Tartan Bank signed me out/);
  assert.equal(fx.callsTo("/link/token/create").pop().body.access_token, card.access);
  assert.deepEqual((await bank(A, { action: "status" })).banks.map(x => x.status), ["connected", "needs_reconnect", "connected"]);
});

test("nothing counted twice: a transfer between their own accounts and a card payment from checking are not spending, even when Plaid mislabels one side", async () => {
  const { chk, card, sav } = await three(A);
  await push(chk, { added: [
    fx.tx(chk.item, "c1", "2026-11-09", 60.25, "Trader Joe's", "FOOD_AND_DRINK", "GROCERIES"),
    fx.tx(chk.item, "c2", "2026-11-10", 300, "Tartan Card Payment", "LOAN_PAYMENTS", "CREDIT_CARD_PAYMENT"),
    fx.tx(chk.item, "c3", "2026-11-10", 200, "Transfer to Harbor", "TRANSFER_OUT", "ACCOUNT_TRANSFER"),
    // Plaid called this one a service; the other side, in their savings, shows what it was.
    fx.tx(chk.item, "c4", "2026-11-11", 150, "Online Transfer 8841", "GENERAL_SERVICES", "OTHER_GENERAL_SERVICES"),
    fx.tx(chk.item, "c5", "2026-11-11", 20, "Bookshop", "GENERAL_MERCHANDISE", "BOOKSTORES_AND_NEWSSTANDS"),
  ] });
  await push(card, { added: [
    fx.tx(card.item, "k1", "2026-11-11", 40, "Uber", "TRANSPORTATION", "TAXIS_AND_RIDE_SHARES"),
    fx.tx(card.item, "k2", "2026-11-10", 25, "Netflix", "ENTERTAINMENT", "TV_AND_MOVIES"),
    fx.tx(card.item, "k3", "2026-11-11", -300, "Payment Thank You", "LOAN_PAYMENTS", "CREDIT_CARD_PAYMENT"),
    // A $20 refund on the card the same week as a $20 purchase from checking: not a transfer, so the purchase still counts.
    fx.tx(card.item, "k4", "2026-11-12", -20, "Zara", "GENERAL_MERCHANDISE", "CLOTHING_AND_ACCESSORIES"),
  ] });
  await push(sav, { added: [
    fx.tx(sav.item, "v1", "2026-11-11", -200, "Transfer from Platypus", "TRANSFER_IN", "ACCOUNT_TRANSFER"),
    fx.tx(sav.item, "v2", "2026-11-12", -150, "Deposit", "TRANSFER_IN", "DEPOSIT"),
  ] });
  const out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.total, "$145.25", "groceries 60.25 + bookshop 20 + uber 40 + netflix 25; not the 300, the 200 or the 150");
  assert.equal(out.count, 4);
  assert.deepEqual(out.by_account, [{ account: "First Platypus Bank Plaid Checking ••0000", amount: "$80.25" }, { account: "Tartan Bank Plaid Credit Card ••4321", amount: "$65.00" }]);
  assert.equal(out.not_counted, undefined, "both sides of every move were visible, so there is nothing to caveat");
});

test("only one side connected: Plaid's category decides; the answer says a card it cannot see was paid and what was transferred out", async () => {
  const chk = await connect(A, { kind: "checking" });
  await push(chk, { added: [
    fx.tx(chk.item, "c1", "2026-11-09", 60.25, "Trader Joe's", "FOOD_AND_DRINK", "GROCERIES"),
    fx.tx(chk.item, "c2", "2026-11-10", 300, "Tartan Card Payment", "LOAN_PAYMENTS", "CREDIT_CARD_PAYMENT"),
    fx.tx(chk.item, "c3", "2026-11-10", 200, "Transfer to Harbor", "TRANSFER_OUT", "ACCOUNT_TRANSFER"),
    fx.tx(chk.item, "c4", "2026-11-11", 150, "Online Transfer 8841", "GENERAL_SERVICES", "OTHER_GENERAL_SERVICES"),
  ] });
  const out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.total, "$210.25", "the mislabelled transfer has no other side to match, so it counts; the two Plaid labelled do not");
  assert.equal(out.by_account, undefined, "one account: no need to say which");
  assert.equal(out.not_counted.paid_to_cards_not_connected, "$300.00");
  assert.equal(out.not_counted.transfers_out, "$200.00");
  assert.match(out.not_counted.note, /what was bought on that card isn't in this total/);
});

test("which account a charge came from: bank, account name and last four, and never a longer run of digits", async () => {
  const chk = await connect(A, { kind: "checking", mask: "0000" });
  const card = await connect(A, { institution: "Tartan Bank", kind: "credit", mask: "4321" });
  // A bank that puts the whole account number in the account's name.
  card.item.accounts[0].name = "Rewards Visa 4111111111114321";
  await push(chk, { added: [fx.tx(chk.item, "c1", "2026-11-09", 60.25, "Trader Joe's", "FOOD_AND_DRINK", "GROCERIES")] });
  await push(card, { added: [fx.tx(card.item, "k1", "2026-11-11", 40, "Uber", "TRANSPORTATION", "TAXIS_AND_RIDE_SHARES")] });
  const list = await bank(A, { action: "transactions", period: "this_week" });
  assert.deepEqual(list.transactions.map(t => [t.name, t.account]), [["Uber", "Tartan Bank Rewards Visa ••4321"], ["Trader Joe's", "First Platypus Bank Plaid Checking ••0000"]]);
  const all = JSON.stringify([list, await bank(A, { action: "status" }), await bank(A, { action: "balance" }), await bank(A, { action: "spending", period: "this_week" }), data.exportData({ conversation: A, audio: false, files: false })]);
  assert.doesNotMatch(all, /4111111111114321|\d{5,}4321/);
  assert.doesNotMatch(all, /1111222233330000/);
});

test("disconnect with more than one: asked which, listed by bank, account name and last four; one goes by its last four; disconnect all removes every Item at Plaid", async () => {
  const one = await connect(A, { institution: "First Platypus Bank", kind: "checking", mask: "0000" });
  const two = await connect(A, { institution: "First Platypus Bank", kind: "credit", mask: "4321" });
  const three_ = await connect(A, { institution: "Harbor Savings", kind: "savings", mask: "7777" });
  for (const b of [one, two, three_]) await push(b, { added: [fx.tx(b.item, `t_${b.item.item_id}`, "2026-11-10", 5, "Blue Bottle", "FOOD_AND_DRINK", "COFFEE")] });
  let out = await bank(A, { action: "disconnect" });
  assert.equal(out.error, "which_bank");
  assert.deepEqual(out.connections, [
    { bank: "First Platypus Bank", accounts: ["Plaid Checking ••0000"] },
    { bank: "First Platypus Bank", accounts: ["Plaid Credit Card ••4321"] },
    { bank: "Harbor Savings", accounts: ["Plaid Saving ••7777"] },
  ]);
  assert.match(out.say, /Nothing was disconnected/);
  // The bank's name alone fits two of them: asked again, nothing removed.
  out = await bank(A, { action: "disconnect", bank: "First Platypus Bank" });
  assert.equal(out.error, "which_bank");
  // A name that fits none: asked, never a guess at which.
  assert.equal((await bank(A, { action: "disconnect", bank: "chase" })).error, "which_bank");
  assert.equal(fx.callsTo("/item/remove").length, 0);
  out = await bank(A, { action: "disconnect", bank: "the platypus card ending 4321" });
  assert.deepEqual(out.removed, ["First Platypus Bank"]);
  assert.deepEqual(fx.callsTo("/item/remove").map(c => c.body.access_token), [two.access]);
  assert.deepEqual(raw("SELECT item_id FROM plaid_transactions WHERE conversation_id = ? ORDER BY item_id", A).map(r => r.item_id), [one.item.item_id, three_.item.item_id].sort());
  assert.equal(raw("SELECT COUNT(*) AS n FROM plaid_items WHERE conversation_id = ? AND item_id = ?", A, two.item.item_id)[0].n, 0, "its token is gone");
  // Disconnect all: one /item/remove per remaining Item, every token and row gone.
  out = await bank(A, { action: "disconnect", all: true });
  assert.deepEqual(out.removed, ["First Platypus Bank", "Harbor Savings"]);
  assert.deepEqual(fx.callsTo("/item/remove").map(c => c.body.access_token), [two.access, one.access, three_.access]);
  for (const t of ["plaid_items", "plaid_accounts", "plaid_transactions"]) assert.equal(raw(`SELECT COUNT(*) AS n FROM ${t} WHERE conversation_id = ?`, A)[0].n, 0, t);
  assert.equal((await bank(A, { action: "disconnect" })).error, "no_bank_connected");
});

test("60 days only: the first sync stores nothing older, and the purge job deletes what ages past it, for everyone", async () => {
  assert.equal(plaid.KEEP_DAYS, 60);
  assert.equal(plaid.cutoffDay(), "2026-09-13");
  const a = fx.addBank();
  // Plaid's first sync brings months of history.
  a.item.pages.push({ added: [
    fx.tx(a.item, "old1", "2026-05-01", 900, "Old Rent", "RENT_AND_UTILITIES", "RENT"),
    fx.tx(a.item, "old2", "2026-09-12", 30, "Day 61", "FOOD_AND_DRINK", "RESTAURANT"),
    fx.tx(a.item, "edge", "2026-09-13", 31, "Day 60", "FOOD_AND_DRINK", "RESTAURANT"),
    fx.tx(a.item, "mid", "2026-09-20", 32, "Later", "FOOD_AND_DRINK", "RESTAURANT"),
    fx.tx(a.item, "new", "2026-11-10", 33, "Recent", "FOOD_AND_DRINK", "RESTAURANT"),
  ] });
  await bank(A, { action: "connect" });
  const linkToken = [...fx.state.links.keys()].pop();
  Object.assign(fx.state.links.get(linkToken), { finished: true, publicTokens: [a.publicToken] });
  await http.plaidWebhookRequest({ ...fx.signed({ webhook_type: "LINK", webhook_code: "SESSION_FINISHED", status: "success", link_token: linkToken, public_tokens: [a.publicToken] }) });
  const kept = () => raw("SELECT transaction_id FROM plaid_transactions WHERE conversation_id = ? ORDER BY date", A).map(r => r.transaction_id);
  assert.deepEqual(kept(), [], "the first answer has nothing");
  await arrive(a);
  assert.deepEqual(kept(), ["edge", "mid", "new"]);
  // Plaid later corrects an old one: still not stored.
  await push(a, { modified: [fx.tx(a.item, "old1", "2026-05-01", 950, "Old Rent", "RENT_AND_UTILITIES", "RENT")] });
  assert.deepEqual(kept(), ["edge", "mid", "new"]);
  const b = await connect(B, { institution: "Tartan Bank", mask: "4321" });
  await push(b, { added: [fx.tx(b.item, "b_edge", "2026-09-14", 9, "Theirs", "FOOD_AND_DRINK", "COFFEE"), fx.tx(b.item, "b_new", "2026-11-11", 9, "Theirs", "FOOD_AND_DRINK", "COFFEE")] });
  assert.equal(plaid.purgeOld(), 0, "nothing is past 60 days today");
  // Eight days on, the daily job runs: what is now older than 60 days goes, for both people.
  clock.skip(8 * 86400_000);
  try {
    assert.equal(plaid.cutoffDay(), "2026-09-21");
    assert.equal(plaid.purgeOld(), 3);
    assert.deepEqual(kept(), ["new"]);
    assert.deepEqual(raw("SELECT transaction_id FROM plaid_transactions WHERE conversation_id = ?", B).map(r => r.transaction_id), ["b_new"]);
  } finally { clock.skip(-8 * 86400_000); }
});

test("asked about more than 60 days: wholly older gets \"i only keep the last 60 days\" and no number; partly older is answered from the cutoff and says so", async () => {
  const a = await connect(A);
  await push(a, { added: week(a) });
  for (const action of ["spending", "transactions"]) {
    const out = await bank(A, { action, from: "2026-01-01", to: "2026-03-31" });
    assert.equal(out.ok, false, action);
    assert.equal(out.error, "beyond_60_days");
    assert.match(out.say, /i only keep the last 60 days/);
    assert.match(out.say, /Never estimate/);
    assert.equal(out.total, undefined);
  }
  const out = await bank(A, { action: "spending", from: "2026-06-01", to: "2026-11-12" });
  assert.equal(out.ok, true);
  assert.deepEqual([out.from, out.to, out.only_last_60_days], ["2026-09-13", "2026-11-12", true]);
  assert.match(out.window_note, /you only keep the last 60 days/);
  // Inside the window: no caveat.
  assert.equal((await bank(A, { action: "spending", period: "last_60_days" })).only_last_60_days, undefined);
  assert.equal(plaid.PLAID_SCHEMAS.bank.safeParse({ action: "spending", period: "last_90_days" }).success, false, "there is no 90-day period to ask for");
  assert.match(plaid.PLAID_TOOL_DEFS[0].description, /only the last 60 days/);
  assert.equal((await bank(A, { action: "status" })).keeps, "the last 60 days of transactions");
  // A monthly subscription is spotted from two charges inside the window; nothing yearly is claimed without Plaid's data.
  const subs = await bank(A, { action: "subscriptions" });
  assert.equal(subs.source, "worked_out_here");
  assert.deepEqual(subs.subscriptions.map(x => [x.name, x.every]), [["Spotify", "monthly"]]);
  assert.match(subs.say, /last 60 days.*may miss yearly ones/);
});

// ---------------------------------------------------------------- what the real Sandbox showed (2026-11-13)

test("just connected, and no webhook ever comes: asked before the transactions arrive it says they are still coming in and gives no number; asked again it reads them", async () => {
  const b = await connect(A);
  // Plaid still has nothing for the next three questions (it took 3 to 8 seconds in Sandbox), and its webhook never reaches us.
  b.item.notReady = 3;
  b.item.pages.push({ added: week(b) });
  for (const action of ["spending", "transactions", "subscriptions"]) {
    const out = await bank(A, { action, period: "this_week" });
    assert.deepEqual([out.ok, out.error, out.still_loading], [false, "still_loading", ["First Platypus Bank"]], action);
    assert.deepEqual([out.total, out.count, out.transactions, out.subscriptions], [undefined, undefined, undefined, undefined], `${action}: no number of any kind`);
    assert.match(out.say, /only just connected.*Do not give a number: \$0 would be wrong/);
  }
  assert.equal(stored(A), 0);
  assert.equal(fx.callsTo("/transactions/recurring/get").length, 0, "Plaid's recurring list is not asked for before there is anything to work from");
  // The next question asks Plaid again, and this time they are there.
  const out = await bank(A, { action: "spending", period: "this_week" });
  assert.deepEqual([out.ok, out.total, out.count, out.still_loading], [true, "$112.75", 3, undefined]);
  assert.equal((await bank(A, { action: "status" })).banks[0].transactions, undefined);
});

test("a webhook is lost: a question more than 30 seconds after the last sync asks Plaid again; one inside 30 seconds does not; Plaid being down still gets the stored answer", async () => {
  const b = await connect(A);
  await push(b, { added: week(b) });
  const calls = () => fx.callsTo("/transactions/sync").length;
  const n = calls();
  assert.equal((await bank(A, { action: "spending", period: "this_week" })).total, "$112.75");
  assert.equal(calls(), n, "synced a moment ago with its history in: read as it stands");
  // A new charge at the bank. The webhook for it never arrives.
  b.item.pages.push({ added: [fx.tx(b.item, "t9", "2026-11-12", 7.25, "Joe Coffee", "FOOD_AND_DRINK", "COFFEE")] });
  assert.equal((await bank(A, { action: "spending", period: "this_week" })).total, "$112.75");
  assert.equal(plaid.SYNC_FRESH_MS, 30_000);
  clock.skip(31_000);
  try {
    assert.equal((await bank(A, { action: "spending", period: "this_week" })).total, "$120.00");
    assert.equal(calls(), n + 1);
    clock.skip(31_000);
    b.item.failWith = "INSTITUTION_DOWN";
    const out = await bank(A, { action: "spending", period: "this_week" });
    assert.deepEqual([out.ok, out.total, out.still_loading], [true, "$120.00", undefined], "what is stored is still the answer");
  } finally { clock.skip(-62_000); }
});

test("Plaid says the history is complete before any of it has arrived (seen once in Sandbox): nothing stored minutes after connecting is 'still coming in', never $0; an account that really is empty answers $0 once it has had ten minutes", async () => {
  const b = await connect(A);
  // The second answer: HISTORICAL_UPDATE_COMPLETE, and nothing.
  let out = await bank(A, { action: "spending", period: "this_week" });
  assert.deepEqual([out.ok, out.error], [false, "still_loading"]);
  assert.equal(raw("SELECT history FROM plaid_items")[0].history, "HISTORICAL_UPDATE_COMPLETE");
  // They land a few seconds later with no webhook: asked again at once, it does not wait out the 30 seconds.
  b.item.pages.push({ added: week(b) });
  out = await bank(A, { action: "spending", period: "this_week" });
  assert.deepEqual([out.ok, out.total], [true, "$112.75"]);
  // Somebody whose account has nothing in it.
  await connect(B, { institution: "Tartan Bank", mask: "4321" });
  assert.equal((await bank(B, { action: "spending", period: "this_week" })).error, "still_loading");
  clock.skip(11 * 60_000);
  try {
    const zero = await bank(B, { action: "spending", period: "this_week" });
    assert.deepEqual([zero.ok, zero.total, zero.still_loading], [true, "$0.00", undefined]);
  } finally { clock.skip(-11 * 60_000); }
});

test("the last month is in and the weeks before it are still arriving: answered, with a note for the model, and Plaid is asked again on every question until the history is in", async () => {
  const b = await connect(A);
  b.item.history = "INITIAL_UPDATE_COMPLETE";
  await push(b, { added: week(b) });
  const n = fx.callsTo("/transactions/sync").length;
  let out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.total, "$112.75");
  assert.deepEqual(out.history_still_arriving, ["First Platypus Bank"]);
  assert.match(out.history_note, /Say so only if they asked about further back than a month/);
  assert.equal((await bank(A, { action: "status" })).banks[0].transactions, "still coming in from the bank");
  b.item.history = "HISTORICAL_UPDATE_COMPLETE";
  out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.history_still_arriving, undefined);
  assert.equal(fx.callsTo("/transactions/sync").length, n + 2);
});

test("a loan account: interest accruing on it is not spending and not a subscription; what they pay toward the loan from checking is spending, connected or not", async () => {
  const chk = await connect(A, { kind: "checking", mask: "0000" });
  const loan = await connect(A, { institution: "Tartan Bank", kind: "mortgage", mask: "3000" });
  await push(chk, { added: [
    fx.tx(chk.item, "c1", "2026-11-09", 60.25, "Trader Joe's", "FOOD_AND_DRINK", "GROCERIES"),
    fx.tx(chk.item, "c2", "2026-11-10", 2100, "Tartan Mortgage", "LOAN_PAYMENTS", "MORTGAGE_PAYMENT"),
  ] });
  // The loan's own lines, as the real Sandbox sends them: the payment arriving, and interest charged.
  await push(loan, { added: [
    fx.tx(loan.item, "l1", "2026-11-11", -2100, "Monthly payment", "LOAN_PAYMENTS", "MORTGAGE_PAYMENT", { merchant_name: null }),
    fx.tx(loan.item, "l2", "2026-11-10", 62, "Interest charged", "BANK_FEES", "INTEREST_CHARGE", { merchant_name: null }),
    fx.tx(loan.item, "l3", "2026-10-10", 62, "Interest charged", "BANK_FEES", "INTEREST_CHARGE", { merchant_name: null }),
  ] });
  const out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.total, "$2,160.25", "groceries and the mortgage payment; not the interest line on the loan, and the payment is not hidden as a move between their accounts");
  assert.deepEqual(out.by_category, [{ category: "bills", amount: "$2,100.00" }, { category: "food", amount: "$60.25" }]);
  assert.equal(out.by_account, undefined, "nothing on the loan account is spending");
  assert.equal((await bank(A, { action: "spending", period: "this_month", category: "fees" })).total, "$0.00");
  // The list still shows the loan's lines for what they are.
  const list = await bank(A, { action: "transactions", period: "this_week", search: "interest" });
  assert.deepEqual(list.transactions.map(t => [t.name, t.amount, t.account]), [["Interest charged", "$62.00", "Tartan Bank Plaid Mortgage ••3000"]]);
  // Worked out here: the monthly interest line is not a subscription.
  let subs = await bank(A, { action: "subscriptions" });
  assert.equal(subs.source, "worked_out_here");
  assert.deepEqual(subs.subscriptions, []);
  // Plaid's own list: a stream on the loan account is left out too.
  chk.item.recurring = [fx.stream(chk.item, "Netflix", 25, "MONTHLY", "2026-11-10", "2026-12-10", "ENTERTAINMENT", "TV_AND_MOVIES")];
  loan.item.recurring = [fx.stream(loan.item, "", 62, "MONTHLY", "2026-11-10", "2026-12-10", "BANK_FEES", "INTEREST_CHARGE", { description: "Interest charged" })];
  subs = await bank(A, { action: "subscriptions" });
  assert.deepEqual([subs.source, subs.subscriptions.map(x => x.name), subs.per_month], ["plaid", ["Netflix"], "$25.00"]);
});

test("a bank's own line with long numbers in it: the numbers are taken out before the name is kept, shown or searched", async () => {
  const b = await connect(A);
  await push(b, { added: [
    fx.tx(b.item, "r1", "2026-11-10", 150, "ONLINE TRANSFER TO SAV 1111222233334444 REF #99887766", "GENERAL_SERVICES", "OTHER_GENERAL_SERVICES", { merchant_name: null }),
    // Word for word from the Sandbox's own data.
    fx.tx(b.item, "r2", "2026-11-11", 9.5, "WITHDRAWAL DEBIT CARD CONSUMER DEBIT PULSZ 252-291-2362 VA DATE 04/12 23978676735612 63546108 CARD 94353", "ENTERTAINMENT", "CASINOS_AND_GAMBLING", { merchant_name: null }),
    fx.tx(b.item, "r3", "2026-11-12", 40, "UBER 588639690 RIDE 05/12 CA 12095 DEBIT CARD PURCHASE 04/04 TIMESTAMP 8102241", "TRANSPORTATION", "TAXIS_AND_RIDE_SHARES", { merchant_name: "Uber" }),
  ] });
  const list = await bank(A, { action: "transactions", period: "this_week" });
  assert.deepEqual(list.transactions.map(t => t.name), ["Uber", "WITHDRAWAL DEBIT CARD CONSUMER DEBIT PULSZ 252-291-2362 VA DATE 04/12 CARD", "ONLINE TRANSFER TO SAV REF"]);
  const spent = await bank(A, { action: "spending", period: "this_week" });
  const kept = d.db.prepare("SELECT data FROM plaid_transactions WHERE conversation_id = ?").all(A).map(r => r.data);
  assert.doesNotMatch(JSON.stringify([list, spent, kept]), /1111222233334444|99887766|23978676735612|63546108|94353|588639690|8102241/, "never shown, and never stored");
  assert.deepEqual((await bank(A, { action: "transactions", period: "this_week", search: "pulsz" })).transactions.map(t => t.amount), ["$9.50"]);
  assert.equal(plaid.txName({ merchant_name: null, name: "ACH Electronic CreditGUSTO PAY 123456" }), "ACH Electronic CreditGUSTO PAY");
  assert.equal(plaid.txName({ merchant_name: "Sweetgreen", name: "SWEETGREEN 000123456" }), "Sweetgreen");
});

test("a card payment the connected card does not show yet: not counted as spending, listed as a card payment, and the note does not claim the card isn't connected", async () => {
  const chk = await connect(A, { kind: "checking" });
  const card = await connect(A, { institution: "Tartan Bank", kind: "credit", mask: "4321" });
  await push(chk, { added: [fx.tx(chk.item, "c2", "2026-11-10", 300, "Tartan Card Payment", "LOAN_PAYMENTS", "CREDIT_CARD_PAYMENT")] });
  await push(card, { added: [fx.tx(card.item, "k1", "2026-11-11", 40, "Uber", "TRANSPORTATION", "TAXIS_AND_RIDE_SHARES")] });
  const out = await bank(A, { action: "spending", period: "this_week" });
  assert.equal(out.total, "$40.00");
  assert.equal(out.not_counted.paid_to_cards_not_connected, "$300.00");
  assert.match(out.not_counted.note, /no connected card shows that payment \(a card that isn't connected, or one that hasn't posted it yet\), so what was bought on that card isn't in this total/);
  const list = await bank(A, { action: "transactions", period: "this_week", search: "payment" });
  assert.deepEqual(list.transactions.map(t => [t.name, t.amount, t.category]), [["Tartan Card Payment", "$300.00", "card payment"]]);
});

test("subscriptions add up: monthly charges cost exactly themselves a month, a yearly one a twelfth, a weekly one 52 twelfths", async () => {
  const b = await connect(A);
  await push(b, { added: week(b) });
  b.item.recurring = [
    fx.stream(b.item, "Gym", 78.5, "MONTHLY", "2026-11-08", "2026-12-08", "PERSONAL_CARE", "GYMS_AND_FITNESS_CENTERS"),
    fx.stream(b.item, "Bikes", 500, "MONTHLY", "2026-10-20", "2026-11-20", "GENERAL_MERCHANDISE", "SPORTING_GOODS"),
    fx.stream(b.item, "Prime", 139, "ANNUALLY", "2026-02-02", "2027-02-02", "GENERAL_MERCHANDISE", "ONLINE_MARKETPLACES"),
    fx.stream(b.item, "Paper", 6, "WEEKLY", "2026-11-09", "2026-11-16", "ENTERTAINMENT", "OTHER_ENTERTAINMENT"),
    // The price went up: what it last cost is what is listed, and what is added.
    fx.stream(b.item, "Stream", 10, "MONTHLY", "2026-11-01", "2026-12-01", "ENTERTAINMENT", "TV_AND_MOVIES", { last_amount: { amount: 12 } }),
  ];
  const out = await bank(A, { action: "subscriptions" });
  assert.deepEqual(out.subscriptions.map(x => [x.name, x.amount, x.every]), [["Bikes", "$500.00", "monthly"], ["Gym", "$78.50", "monthly"], ["Paper", "$6.00", "weekly"], ["Stream", "$12.00", "monthly"], ["Prime", "$139.00", "annually"]]);
  assert.equal(out.per_month, "$628.08", "500 + 78.50 + 6 x 52/12 + 12 + 139/12");
});

test("the fixture is held to the real Sandbox: the fake Plaid answers with the same fields the real one sent, and no recording holds a real identifier", async () => {
  const dir = new URL("./fixtures/plaid/", import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  assert.equal(files.length >= 15, true, "the recordings are there");
  const rec = {};
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(text, /(access|public|link)-sandbox-[0-9a-f]{8}-[0-9a-f]{4}-/, `${f}: a real token`);
    assert.doesNotMatch(text, /secure\.plaid\.com\/hl\/(?!PLACEHOLDER)/, `${f}: a real Hosted Link`);
    assert.doesNotMatch(text, /"(item_id|account_id|transaction_id|request_id|stream_id|link_session_id)": "(?!ITEM_ID_|ACCOUNT_ID_|TRANSACTION_ID_|REQUEST_ID|STREAM_ID_|LINK_SESSION_ID_)/, `${f}: a real id`);
    assert.doesNotMatch(text, /"(next_cursor|cursor)": "(?!CURSOR_|")/, `${f}: a real cursor`);
    assert.doesNotMatch(text, /ts\.net|heyreason|client_id|"secret"/, `${f}: where this runs, or a key`);
    rec[f.replace(/\.json$/, "")] = JSON.parse(text);
  }
  const keys = (o) => Object.keys(o ?? {}).filter(k => !k.startsWith("_")).sort();
  const same = (got, want, what) => assert.deepEqual(keys(got), keys(want), what);
  const call = async (path, body = {}) => { const res = await fx.fetchImpl(`https://sandbox.plaid.com${path}`, { method: "POST", body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const real = (name) => { assert.ok(rec[name], `recording ${name}`); return rec[name]; };

  const b = fx.addBank();
  b.item.pages.push({ added: week(b) });
  b.item.recurring = [fx.stream(b.item, "Netflix", 25, "MONTHLY", "2026-11-10", "2026-12-10", "ENTERTAINMENT", "TV_AND_MOVIES")];
  // Hosted Link, new and update mode: link_token, hosted_link_url, expiration, request_id.
  const made = await call("/link/token/create", { products: ["transactions"], hosted_link: {} });
  same(made.body, real("link-token-create.new").response, "/link/token/create");
  same((await call("/link/token/create", { access_token: b.access, hosted_link: {} })).body, real("link-token-create.update-mode").response, "/link/token/create (update mode)");
  assert.match(real("link-token-create.new").response.hosted_link_url, /^https:\/\/secure\.plaid\.com\/hl\/\w+$/);
  assert.match(made.body.hosted_link_url, /^https:\/\/secure\.plaid\.com\/hl\/\w+$/);
  // A link nobody has opened: no link_sessions at all.
  const unopened = await call("/link/token/get", { link_token: made.body.link_token });
  same(unopened.body, real("link-token-get.ok").response, "/link/token/get, unopened");
  same(unopened.body.metadata, real("link-token-get.ok").response.metadata, "/link/token/get metadata");
  assert.equal("link_sessions" in real("link-token-get.ok").response, false);
  same((await call("/item/public_token/exchange", { public_token: b.publicToken })).body, real("item-public_token-exchange.ok").response, "/item/public_token/exchange");
  // Accounts and balances: the Item names its institution; an account has a name, a type and a mask, never a number.
  for (const [path, name] of [["/accounts/get", "accounts-get.ok"], ["/accounts/balance/get", "accounts-balance-get.ok"]]) {
    const got = (await call(path, { access_token: b.access })).body, want = real(name).response;
    same(got, want, path);
    same(got.item, want.item, `${path} item`);
    const checking = want.accounts.find(a => a.subtype === "checking");
    same(got.accounts[0], checking, `${path} account`);
    same(got.accounts[0].balances, checking.balances, `${path} balances`);
    assert.equal(typeof want.item.institution_name, "string");
    assert.doesNotMatch(JSON.stringify(want), /"(account|routing|wire_routing)":|"numbers"/, "no account or routing number is in what was asked for");
  }
  // The first sync after a connection: nothing, to the letter.
  const first = await call("/transactions/sync", { access_token: b.access, count: 500 });
  const nothing = real("transactions-sync.nothing-yet").response;
  assert.deepEqual({ ...first.body, request_id: "" }, { ...nothing, request_id: "" });
  assert.deepEqual([nothing.transactions_update_status, nothing.next_cursor, nothing.added.length, nothing.accounts.length], ["NOT_READY", "", 0, 0]);
  // Then a page of them.
  const page = await call("/transactions/sync", { access_token: b.access, count: 500 });
  const realPage = real("transactions-sync.page").response;
  same(page.body, realPage, "/transactions/sync");
  same(page.body.added[0], realPage.added[0], "a transaction");
  same(page.body.added[0].personal_finance_category, realPage.added[0].personal_finance_category, "its category");
  same(page.body.added[0].location, realPage.added[0].location, "its location");
  same(page.body.added[0].payment_meta, realPage.added[0].payment_meta, "its payment_meta");
  assert.equal(realPage.added.every(t => t.personal_finance_category.version === "v2"), true);
  // Recurring: answered in Sandbox, with these fields.
  const rc = (await call("/transactions/recurring/get", { access_token: b.access })).body, realRc = real("transactions-recurring-get.ok").response;
  same(rc, realRc, "/transactions/recurring/get");
  same(rc.outflow_streams[0], realRc.outflow_streams[0], "a recurring stream");
  same(rc.outflow_streams[0].average_amount, realRc.outflow_streams[0].average_amount, "its average amount");
  // The login expires.
  b.item.failWith = "ITEM_LOGIN_REQUIRED";
  for (const [path, name] of [["/transactions/sync", "transactions-sync.item_login_required"], ["/accounts/balance/get", "accounts-balance-get.item_login_required"]]) {
    const got = await call(path, { access_token: b.access }), want = real(name);
    same(got.body, want.response, `${path} with an expired login`);
    assert.deepEqual([got.status, got.body.error_type, got.body.error_code], [want.status, want.response.error_type, want.response.error_code]);
  }
  b.item.failWith = null;
  // Removed: the token then fails ITEM_NOT_FOUND.
  same((await call("/item/remove", { access_token: b.access })).body, real("item-remove.ok").response, "/item/remove");
  const after = await call("/accounts/get", { access_token: b.access }), wantAfter = real("accounts-get.item_not_found");
  same(after.body, wantAfter.response, "a removed token");
  assert.deepEqual([after.status, after.body.error_type, after.body.error_code], [wantAfter.status, "ITEM_ERROR", "ITEM_NOT_FOUND"]);
  // A key id Plaid does not know.
  const key = await call("/webhook_verification_key/get", { key_id: "nobody" }), wantKey = real("webhook_verification_key-get.invalid_webhook_verification_key_id");
  same(key.body, wantKey.response, "an unknown key id");
  assert.deepEqual([key.status, key.body.error_type, key.body.error_code], [wantKey.status, wantKey.response.error_type, wantKey.response.error_code]);
  const { SHAPES_FROM, SHAPES_FROM_DOCS } = await import("./fixture-plaid.js");
  assert.match(SHAPES_FROM, /^sandbox \d{4}-\d\d-\d\d$/);
  assert.equal(SHAPES_FROM_DOCS.length, 4, "what is still from the docs alone is named");
});
