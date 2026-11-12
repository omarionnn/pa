// Paid events (owner decisions 2026-11-11, src/eventpay.js). Pinned:
//
//   - the switch: REASON_PAID_EVENTS off hides every ticket tool and the Tickets section; `owner`
//     reaches the owner alone; an event already priced stays priced whatever the switch says;
//   - the split: the guest pays the price plus Stripe's processing as one line; the organizer gets the
//     price less 2.5%; the application fee is the rest; the quote is what the Checkout carries;
//   - payouts first: a price on an event needs the organizer's Express account with charges on, set
//     up from one link that lands back on the events domain; account.updated turns it on;
//   - nobody is in until the webhook: a right password on a priced event (text, page, claim text) is
//     answered with the Checkout link and a 15-minute hold; checkout.session.completed does the join
//     and the welcome; a duplicate does nothing twice; the hold counts against the cap and is released
//     by the sweep; a late payment with no spot left is refunded and said;
//   - refunds: one guest by text behind the yes (pinned to the amount) or from the page behind a
//     confirm step; the guest gets everything back, leaves and is told; cancelling refunds everyone,
//     application fee included;
//   - the page: Tickets section with payouts setup, price with the quote, who paid, refund, dashboard;
//     a guest's or stranger's post is the flat not-found.
//
// Stripe is a fake on this machine (STRIPE_API_BASE); nothing here reaches the network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { withYes } from "./fixture-yes.js";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-paid-"));
process.env.REASON_DB_PATH = pathJoin(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS_URL = "https://events.example.test";
process.env.REASON_CADDY_SECRET = "caddy-test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_PAID_EVENTS = "on";
process.env.REASON_ONBOARDING = "off";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_for_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_main";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_connect";
delete process.env.REASON_AUTO_ADMIT;

// ---------------------------------------------------------------- a fake Stripe on this machine
const calls = [];
let accountsMade = 0, sessionsMade = 0, refundsMade = 0, failNext = null;
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    calls.push({ method: req.method, path: req.url, form, idem: req.headers["idempotency-key"] ?? null, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (failNext && req.url.startsWith(failNext)) { failNext = null; res.statusCode = 402; return res.end(JSON.stringify({ error: { message: "fake decline", code: "fake" } })); }
    if (req.method === "POST" && req.url === "/v1/accounts") return res.end(JSON.stringify({ id: `acct_fake_${++accountsMade}`, object: "account", type: "express", charges_enabled: false, details_submitted: false, payouts_enabled: false }));
    const acct = /^\/v1\/accounts\/([^/?]+)$/.exec(req.url);
    if (acct && req.method === "GET") return res.end(JSON.stringify({ id: decodeURIComponent(acct[1]), object: "account", charges_enabled: stateOf(acct[1]).charges, details_submitted: stateOf(acct[1]).charges, payouts_enabled: stateOf(acct[1]).charges }));
    if (req.method === "POST" && req.url === "/v1/account_links") return res.end(JSON.stringify({ object: "account_link", url: `https://connect.stripe.test/setup/${form.account}` }));
    const login = /^\/v1\/accounts\/([^/]+)\/login_links$/.exec(req.url);
    if (login && req.method === "POST") return res.end(JSON.stringify({ object: "login_link", url: `https://connect.stripe.test/express/${login[1]}` }));
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") return res.end(JSON.stringify({ id: `cs_test_${++sessionsMade}`, object: "checkout.session", url: `https://checkout.stripe.test/c/pay/cs_test_${sessionsMade}`, payment_intent: null }));
    if (/^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(req.url) && req.method === "POST") return res.end(JSON.stringify({ object: "checkout.session", status: "expired" }));
    if (req.method === "POST" && req.url === "/v1/refunds") return res.end(JSON.stringify({ id: `re_fake_${++refundsMade}`, object: "refund", status: "succeeded", payment_intent: form.payment_intent }));
    // A guest's own cancel: the charge's application fee is looked up, then Reason's 2.5% refunded on it.
    const piGet = /^\/v1\/payment_intents\/([^/?]+)\?expand\[\]=latest_charge$/.exec(decodeURIComponent(req.url));
    if (piGet && req.method === "GET") return res.end(JSON.stringify({ id: piGet[1], object: "payment_intent", latest_charge: { id: `ch_${piGet[1]}`, object: "charge", application_fee: `fee_${piGet[1]}` } }));
    if (req.method === "POST" && /^\/v1\/application_fees\/[^/]+\/refunds$/.test(req.url)) return res.end(JSON.stringify({ id: `fr_fake_${++refundsMade}`, object: "fee_refund", amount: Number(form.amount) }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `no such route in the fake: ${req.method} ${req.url}` } }));
  });
});
const accountState = new Map();
const stateOf = (id) => accountState.get(decodeURIComponent(id)) ?? { charges: false };
await new Promise(r => fake.listen(0, "127.0.0.1", r));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${fake.address().port}`;

const events = await import("../src/events.js");
const eventpay = await import("../src/eventpay.js");
const stripe = await import("../src/stripe.js");
const tools = await import("../src/eventtools.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { eventRequestFor, stripeWebhookRequest } = await import("../src/http.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", AMA = "+13475550000", KOFI = "+13475550001", YAW = "+13475550002", ESI = "+13475550003", NEW1 = "+16465550101";
const OWNER_C = config.ownerConversation;
const C = { ama: `dm:fake:${AMA}`, kofi: `dm:fake:${KOFI}`, yaw: `dm:fake:${YAW}`, esi: `dm:fake:${ESI}` };
const LINE = "+16562167455";
const COOKIE = { owner: "reason_page=tok-owner-pay-000001", kofi: "reason_page=tok-kofi-pay-0000001", ama: "reason_page=tok-ama-pay-00000001" };
const MIN = 60_000;
let seq = 0, evt = 0;

after(() => { fake.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  const d = new Date(); d.setUTCHours(17, 0, 0, 0);
  clock.skip(d.getTime() + 24 * 60 * MIN - Date.now());
  config.events = true;
  config.paidEvents = true;
  calls.length = 0;
  failNext = null;
  accountsMade = sessionsMade = refundsMade = 0;
  accountState.clear();
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations;
    DELETE FROM inbound_messages; DELETE FROM page_sessions; DELETE FROM event_payments; DELETE FROM event_payout_accounts; DELETE FROM stripe_events;
    DELETE FROM confirmations;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: OWNER_C, channel: "fake", address: OWNER, isOwner: true });
  for (const [c, a, n] of [[C.ama, AMA, "Ama"], [C.kofi, KOFI, "Kofi"], [C.yaw, YAW, "Yaw"], [C.esi, ESI, "Esi"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
    db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(c);
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: false });
  }
  db.startPageSession("p-owner", "tok-owner-pay-000001", { conversationId: OWNER_C });
  db.startPageSession("p-kofi", "tok-kofi-pay-0000001", { conversationId: C.kofi });
  db.startPageSession("p-ama", "tok-ama-pay-00000001", { conversationId: C.ama });
});

function harness() {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel };
}
const settle = () => new Promise(r => setTimeout(r, 40));
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to).map(m => m.text);
const tool = (name, input, c, rt) => runTool(name, input, { conversationId: c, messages: [], events: rt });
const form = (o) => new URLSearchParams(o).toString();
const texts = (from, body) => ({ channel: "fake", externalId: `m${++seq}`, from, text: body, at: clock.now() });
async function req(h, ev, { sub = null, method = "GET", body = null, query = {}, cookie = "" } = {}) {
  const headers = { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test", host: "events.example.test", origin: "https://events.example.test" };
  return await eventRequestFor({ publicId: ev.public_id, sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router });
}
const post = (h, ev, fields, cookie = COOKIE.owner) => req(h, ev, { sub: "manage", method: "POST", body: form(fields), cookie });
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const sign = (raw, secret = process.env.STRIPE_WEBHOOK_SECRET) => ({ "stripe-signature": stripe.sign(raw, secret, Math.floor(clock.now() / 1000)), "content-type": "application/json" });
const webhook = (h, type, object, { secret, account = null, id = null } = {}) => {
  const raw = JSON.stringify({ id: id ?? `evt_${++evt}`, type, ...(account ? { account } : {}), data: { object } });
  return stripeWebhookRequest({ rawBody: raw, headers: sign(raw, secret), runtime: h.runtime });
};
const completed = (h, row, { intent = `pi_fake_${row.id}`, id = null } = {}) => webhook(h, "checkout.session.completed", { id: row.checkout_session_id, object: "checkout.session", payment_status: "paid", payment_intent: intent, amount_total: row.total_cents, client_reference_id: `evpay:${row.id}`, metadata: { reason_kind: "event_ticket", event_payment_id: String(row.id) } }, { id });

function makeEvent(organizer = OWNER_C, over = {}) {
  const out = events.create(organizer, {
    name: "Supper Club", description: "five courses", starts_at: "2027-06-05T20:00", timezone: "America/New_York", location: "9 Pine St",
    welcome_message: "so glad you're coming!", password: "truffle", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true, ...over,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.event;
}
/** The organizer's payouts, ready: an account row with charges on, as the webhook would leave it. */
function readyPayouts(c = OWNER_C) {
  db.db.prepare("INSERT OR REPLACE INTO event_payout_accounts (conversation_id, stripe_account_id, charges_enabled, details_submitted, payouts_enabled, created_at, updated_at) VALUES (?, ?, 1, 1, 1, ?, ?)")
    .run(c, `acct_ready_${c.replace(/[^a-z0-9]/gi, "")}`, clock.now(), clock.now());
}
async function pricedEvent(h, { cents = 2500, over = {} } = {}) {
  readyPayouts();
  const ev = makeEvent(OWNER_C, over);
  const out = await tool("event_price", { event_id: ev.id, price_dollars: cents / 100 }, OWNER_C, h.runtime);
  assert.equal(out.ok, true, JSON.stringify(out));
  return db.getEventRow(ev.id);
}
const lastCall = (path) => [...calls].reverse().find(c => c.path === path || c.path.startsWith(path));

// ---------- the switch and the quote ----------

test("the quote: the guest pays the price plus processing, the organizer gets the price less 2.5%, the fee is the rest", () => {
  const qt = eventpay.quote(2500);
  assert.deepEqual(qt, { price: 2500, processing: 106, total: 2606, reason_fee: 63, organizer_gets: 2437, application_fee: 169 });
  // Stripe's take on the total leaves at least the price.
  assert.ok(qt.total - Math.ceil(qt.total * 0.029) - 30 >= 2500 - 1);
  assert.equal(qt.application_fee, qt.total - qt.organizer_gets);
  assert.equal(eventpay.dollars(2606), "$26.06");
  assert.equal(eventpay.dollars(2500), "$25");
  assert.equal(eventpay.parseDollars("$12.50"), 1250);
  assert.equal(eventpay.parseDollars("25"), 2500);
  assert.equal(eventpay.parseDollars("twenty"), null);
  assert.equal(eventpay.priceProblem(499), "too_low");
  assert.equal(eventpay.priceProblem(50001), "too_high");
  assert.equal(eventpay.priceProblem(500), null);
  assert.equal(eventpay.priceProblem(50000), null);
  assert.match(eventpay.organizerPriceLine(2500), /Guests pay \$26\.06 \(\$25 \+ \$1\.06 processing\)\. You get \$24\.37 per person; Reason keeps 2\.5% \(\$0\.63\)\./);
});

test("off: no ticket tool is offered, event_price says nothing exists, and the page has no Tickets section", async () => {
  const h = harness();
  config.paidEvents = false;
  const ev = makeEvent();
  const names = toolsFor(OWNER_C).map(t => t.name);
  for (const t of ["event_price", "event_payouts", "event_refund"]) assert.ok(!names.includes(t), t);
  const out = await tool("event_price", { event_id: ev.id, price_dollars: 25 }, OWNER_C, h.runtime);
  assert.equal(out.blocked, "not_available");
  const page = await req(h, ev, { cookie: COOKIE.owner });
  assert.equal(page.status, 200);
  assert.ok(!/TICKETS/.test(page.body));
  assert.ok(!/id="money"/.test(page.body));
  // A price already set stays: joining it is still paid, whatever the switch says.
  db.updateEventRow(ev.id, { price_cents: 2500 });
  readyPayouts();
  const join = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(join.payment_required, true);
  assert.equal(db.joinedCount(ev.id), 0);
});

test("owner: only the owner's events can be priced; a non-owner organizer isn't offered the tools", async () => {
  const h = harness();
  config.paidEvents = "owner";
  const kofiEv = makeEvent(C.kofi);
  assert.ok(!toolsFor(C.kofi).some(t => t.name === "event_price"));
  assert.ok(toolsFor(OWNER_C).some(t => t.name === "event_price"));
  const out = await tool("event_price", { event_id: kofiEv.id, price_dollars: 25 }, C.kofi, h.runtime);
  assert.equal(out.blocked, "not_available");
  const kofiPage = await req(h, kofiEv, { cookie: COOKIE.kofi });
  assert.ok(!/id="money"/.test(kofiPage.body));
  const ownerPage = await req(h, makeEvent(), { cookie: COOKIE.owner });
  assert.match(ownerPage.body, /07<\/span> · TICKETS/);
  assert.match(ownerPage.body, /Set up payouts with Stripe/);
});

// ---------- payouts first ----------

test("a price before payouts: one Express account, one onboarding link back to the events domain, and the event stays free", async () => {
  const h = harness();
  const ev = makeEvent();
  const out = await tool("event_price", { event_id: ev.id, price_dollars: 25 }, OWNER_C, h.runtime);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "payouts_setup");
  assert.match(out.setup_link, /^https:\/\/connect\.stripe\.test\/setup\/acct_fake_1$/);
  assert.match(out.per_person, /You get \$24\.37 per person/);
  assert.equal(db.getEventRow(ev.id).price_cents, null);
  const made = calls.find(c => c.path === "/v1/accounts");
  assert.equal(made.form.type, "express");
  assert.equal(made.form["capabilities[card_payments][requested]"], "true");
  assert.equal(made.form["capabilities[transfers][requested]"], "true");
  assert.equal(made.form["metadata[conversation_id]"], OWNER_C);
  const link = calls.find(c => c.path === "/v1/account_links");
  assert.equal(link.form.type, "account_onboarding");
  assert.equal(link.form.return_url, `https://events.example.test/e/${ev.public_id}/payouts?back=1`);
  assert.equal(link.form.refresh_url, `https://events.example.test/e/${ev.public_id}/payouts?refresh=1`);
  assert.equal(eventpay.payoutAccount(OWNER_C).stripe_account_id, "acct_fake_1");
  assert.equal(eventpay.payoutsReady(OWNER_C), false);
  // Asked again: the same account, a fresh link (no second account).
  const again = await tool("event_payouts", { event_id: ev.id, action: "setup" }, OWNER_C, h.runtime);
  assert.equal(again.ok, true);
  assert.equal(calls.filter(c => c.path === "/v1/accounts").length, 1);
  const status = await tool("event_payouts", { event_id: ev.id, action: "status" }, OWNER_C, h.runtime);
  assert.equal(status.payouts_ready, false);
  assert.equal(status.setup_started, true);
});

test("account.updated with charges on (signed with the Connect secret) readies payouts and tells the organizer; then the price sets", async () => {
  const h = harness();
  const ev = makeEvent();
  await tool("event_price", { event_id: ev.id, price_dollars: 25 }, OWNER_C, h.runtime);
  const r = await webhook(h, "account.updated", { id: "acct_fake_1", object: "account", charges_enabled: true, details_submitted: true, payouts_enabled: true }, { secret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET, account: "acct_fake_1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await settle();
  assert.equal(eventpay.payoutsReady(OWNER_C), true);
  assert.ok(sentTo(h, OWNER).some(t => /payouts are set up with Stripe/.test(t)), JSON.stringify(sentTo(h, OWNER)));
  const set = await tool("event_price", { event_id: ev.id, price_dollars: 25 }, OWNER_C, h.runtime);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(db.getEventRow(ev.id).price_cents, 2500);
  assert.equal(set.event.price_per_person, "$25");
  assert.equal(set.event.tickets.paid, 0);
  assert.equal(set.event.payouts_ready, true);
  // Bounds, in the tool's words.
  assert.match((await tool("event_price", { event_id: ev.id, price_dollars: 4 }, OWNER_C, h.runtime)).error, /lowest price is \$5/);
  assert.match((await tool("event_price", { event_id: ev.id, price_dollars: 501 }, OWNER_C, h.runtime)).error, /highest price is \$500/);
  // An unknown account's update matches nothing and is taken (200) so Stripe stops retrying.
  const other = await webhook(h, "account.updated", { id: "acct_nobody", object: "account", charges_enabled: true }, { account: "acct_nobody" });
  assert.equal(other.status, 200);
  assert.equal(other.body.matched, false);
  // A bad signature on either secret is a 401.
  const raw = JSON.stringify({ id: "evt_bad", type: "account.updated", data: { object: { id: "acct_fake_1", object: "account" } } });
  assert.equal((await stripeWebhookRequest({ rawBody: raw, headers: sign(raw, "whsec_wrong") })).status, 401);
});

test("the organizer back from Stripe's onboarding: the account is read again and they land on Tickets", async () => {
  const h = harness();
  const ev = makeEvent();
  await tool("event_price", { event_id: ev.id, price_dollars: 25 }, OWNER_C, h.runtime);
  // Not finished: a refresh makes a fresh link and sends them straight back to Stripe.
  const refresh = await req(h, ev, { sub: "payouts", query: { refresh: "1" }, cookie: COOKIE.owner });
  assert.equal(refresh.status, 303);
  assert.match(refresh.headers.Location, /^https:\/\/connect\.stripe\.test\/setup\//);
  // Finished on Stripe's side: GET /v1/accounts says so even before the webhook.
  accountState.set("acct_fake_1", { charges: true });
  const back = await req(h, ev, { sub: "payouts", query: { back: "1" }, cookie: COOKIE.owner });
  assert.equal(back.status, 303);
  assert.equal(back.headers.Location, `/e/${ev.public_id}?done=payouts_ready#money`);
  assert.equal(eventpay.payoutsReady(OWNER_C), true);
  const page = await req(h, ev, { query: { done: "payouts_ready" }, cookie: COOKIE.owner });
  assert.match(page.body, /Payouts are set up with Stripe/);
  assert.match(page.body, /PRICE PER PERSON/);
  // A guest, or a stranger, on the payouts step: the flat not-found.
  assert.equal((await req(h, ev, { sub: "payouts", cookie: COOKIE.kofi })).status, 404);
  assert.equal((await req(h, ev, { sub: "payouts" })).status, 404);
});

// ---------- paying for a spot ----------

test("a text join on a priced event: the password opens nothing but the Checkout link; the spot is held; the webhook does the join", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { capacity: 1 } });
  const join = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(join.ok, true, JSON.stringify(join));
  assert.equal(join.joined, false);
  assert.equal(join.payment_required, true);
  assert.match(join.pay_link, /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_1$/);
  assert.match(join.price, /\$25 per person, plus \$1\.06 processing at checkout \(\$26\.06 in all\)/);
  assert.match(join.say, /NEVER say they're in yet/);
  assert.equal(db.joinedCount(ev.id), 0, "nobody is in before the webhook");
  // The Checkout carries the split: two lines, the application fee, the organizer's account, our pages.
  const cs = lastCall("/v1/checkout/sessions");
  assert.equal(cs.form.mode, "payment");
  assert.equal(cs.form["line_items[0][price_data][unit_amount]"], "2500");
  assert.equal(cs.form["line_items[1][price_data][unit_amount]"], "106");
  assert.equal(cs.form["line_items[1][price_data][product_data][name]"], "Processing");
  assert.equal(cs.form["payment_intent_data[application_fee_amount]"], "169");
  assert.match(cs.form["payment_intent_data[transfer_data][destination]"], /^acct_ready_/);
  assert.equal(cs.form.success_url, `https://events.example.test/e/${ev.public_id}/paid`);
  assert.equal(cs.form.cancel_url, `https://events.example.test/e/${ev.public_id}/pay-back`);
  assert.equal(cs.form["metadata[reason_kind]"], "event_ticket");
  assert.ok(Number(cs.form.expires_at) * 1000 >= clock.now() + 30 * MIN, "Stripe's minimum expiry is respected");
  const row = eventpay.rowBySession("cs_test_1");
  assert.equal(row.status, "open");
  assert.ok(Math.abs(row.expires_at - (clock.now() + eventpay.HOLD_MS)) < 2000, "held 15 minutes");
  // The hold counts against the cap: the next person is told it's full, and no second session is made.
  const kofi = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.kofi, h.runtime);
  assert.equal(kofi.reason, "full");
  assert.match(kofi.error, /spots being paid for count/);
  assert.equal(calls.filter(c => c.path === "/v1/checkout/sessions").length, 1);
  // Asked again, Ama gets the same link, not a second hold.
  const again = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(again.pay_link, join.pay_link);
  assert.equal(eventpay.openHolds(ev.id), 1);
  // The payment lands: in, told, welcomed — once.
  h.channel.sent.length = 0;
  const r = await completed(h, row, { id: "evt_same_delivery" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await settle();
  assert.equal(db.joinedCount(ev.id), 1);
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "joined");
  assert.equal(eventpay.paymentRow(row.id).status, "paid");
  assert.equal(eventpay.paymentRow(row.id).payment_intent_id, `pi_fake_${row.id}`);
  const got = sentTo(h, AMA);
  assert.ok(got.some(t => /paid \$26\.06 for Supper Club — you're in\./.test(t)), JSON.stringify(got));
  assert.ok(got.some(t => /so glad you're coming!/.test(t)), "the welcome went");
  // Redelivered: nothing twice.
  const dup = await completed(h, row, { id: "evt_same_delivery" });
  assert.equal(dup.body.duplicate, true);
  const again2 = await completed(h, row);
  assert.equal(again2.status, 200, "a second session.completed for the same row is taken, and joins nobody twice");
  await settle();
  assert.equal(sentTo(h, AMA).filter(t => /^paid \$26\.06 for Supper Club/.test(t)).length, 1, "one receipt");
  assert.equal(sentTo(h, AMA).filter(t => /so glad you're coming!/.test(t)).length, 1, "one welcome");
  // What the organizer and the guest now see.
  const view = await tool("event_guests", { event_id: ev.id }, OWNER_C, h.runtime);
  assert.equal(view.guests[0].paid, "$26.06");
  assert.equal(view.tickets.paid, 1);
  assert.equal(view.tickets.gross, "$25");
  assert.equal(view.tickets.you_get, "$24.37");
  const mine = await tool("event_info", { event_id: ev.id }, C.ama, h.runtime);
  assert.equal(mine.you.paid, "$26.06");
  assert.equal(mine.price_per_person, "$25");
});

test("a hold that runs out is released by the sweep and the page expired; a late payment with no spot left is refunded and said", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { capacity: 1 } });
  const first = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  const row = eventpay.rowBySession("cs_test_1");
  clock.skip(16 * MIN);
  assert.equal(eventpay.openHolds(ev.id), 0, "past 15 minutes the hold no longer counts");
  const swept = await h.runtime.eventPayments();
  assert.equal(swept.expired, 1);
  assert.equal(eventpay.paymentRow(row.id).status, "expired");
  assert.ok(calls.some(c => c.path === "/v1/checkout/sessions/cs_test_1/expire"), "the Checkout page was expired on Stripe");
  // Kofi takes the spot and pays.
  const kofi = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.kofi, h.runtime);
  assert.equal(kofi.payment_required, true);
  await completed(h, eventpay.rowBySession("cs_test_2"));
  await settle();
  assert.equal(db.joinedCount(ev.id), 1);
  // Ama's payment lands anyway (the expire call raced her card): the money goes back, and she is told.
  h.channel.sent.length = 0;
  const late = await completed(h, row);
  assert.equal(late.status, 200);
  assert.equal(late.body.ok, true);
  await settle();
  assert.equal(db.attendeeRow(ev.id, C.ama), null, "not on the event");
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  const refund = lastCall("/v1/refunds");
  assert.equal(refund.form.payment_intent, `pi_fake_${row.id}`);
  assert.equal(refund.form.reverse_transfer, "true");
  assert.equal(refund.form.refund_application_fee, "true");
  assert.ok(sentTo(h, AMA).some(t => /filled up before your payment landed, so i've refunded your \$26\.06 in full/.test(t)), JSON.stringify(sentTo(h, AMA)));
  assert.equal(first.payment_required, true);
});

test("checkout.session.expired marks the row; a failed delayed payment is said; the organizer never pays to join their own event", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  const row = eventpay.rowBySession("cs_test_1");
  const exp = await webhook(h, "checkout.session.expired", { id: row.checkout_session_id, object: "checkout.session", metadata: { reason_kind: "event_ticket" } });
  assert.equal(exp.body.ok, true);
  assert.equal(eventpay.paymentRow(row.id).status, "expired");
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  const row2 = eventpay.rowBySession("cs_test_2");
  await webhook(h, "checkout.session.async_payment_failed", { id: row2.checkout_session_id, object: "checkout.session", metadata: { reason_kind: "event_ticket" } });
  await settle();
  assert.equal(eventpay.paymentRow(row2.id).status, "failed");
  assert.ok(sentTo(h, AMA).some(t => /didn't go through, so you're not in yet/.test(t)));
  const own = await eventpay.startCheckout({ ev, conversationId: OWNER_C, displayName: "Omari", via: "text" });
  assert.equal(own.reason, "organizer");
  // A subscription event is still the paywall's, not ours.
  assert.equal(eventpay.isOurs({ type: "checkout.session.completed", data: { object: { id: "cs_sub", metadata: {} } } }), false);
  assert.equal(eventpay.isOurs({ type: "invoice.paid", data: { object: {} } }), false);
});

test("the join page: the price is public, a signed-in guest goes to Stripe after the password, and the after-pay pages say the right thing", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const cold = await req(h, ev);
  assert.equal(cold.status, 200);
  assert.match(cold.body, /\$25 per person/);
  assert.match(cold.body, /Join and pay/);
  assert.ok(!/9 Pine St/.test(cold.body), "the hidden address stays hidden");
  // A wrong password: no Checkout, no hold.
  const wrong = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "nope", in_directory: "1" }), cookie: COOKIE.kofi });
  assert.equal(wrong.status, 200);
  assert.match(unesc(wrong.body), /isn't right/);
  assert.equal(calls.filter(c => c.path === "/v1/checkout/sessions").length, 0);
  // The right one, signed in: straight to Stripe's page, nobody in yet.
  const go = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "truffle", in_directory: "1" }), cookie: COOKIE.kofi });
  assert.equal(go.status, 303);
  assert.match(go.headers.Location, /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_1$/);
  assert.equal(db.joinedCount(ev.id), 0);
  const row = eventpay.rowBySession("cs_test_1");
  assert.equal(row.conversation_id, C.kofi);
  assert.equal(row.via, "web");
  assert.equal(row.in_directory, 1);
  // Stripe sends them back: plain pages, nothing decided here.
  const paid = await req(h, ev, { sub: "paid", cookie: COOKIE.kofi });
  assert.equal(paid.status, 200);
  assert.match(paid.body, /Payment received/);
  const back = await req(h, ev, { sub: "pay-back" });
  assert.equal(back.status, 200);
  assert.match(back.body, /Nothing was charged/);
  assert.equal(db.joinedCount(ev.id), 0, "the success page joins nobody");
  await completed(h, row);
  await settle();
  assert.equal(db.attendeeRow(ev.id, C.kofi).state, "joined");
  const joined = await req(h, ev, { cookie: COOKIE.kofi });
  assert.match(joined.body, /You're in/);
});

test("a new guest on the page: the finishing text proves the phone and is answered with the payment link; the webhook joins them", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const page = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "truffle", display_name: "Esi N", in_directory: "1" }) });
  assert.equal(page.status, 200);
  assert.match(page.body, /Text Reason to get the payment link/);
  assert.match(page.body, /Nothing is charged until you pay/);
  const sms = unesc(/href="(sms:[^"]+)"/.exec(page.body)[1]);
  const codeText = decodeURIComponent(sms.split("body=")[1]);
  await h.router.deliver(texts(NEW1, codeText));
  await settle();
  const conv = db.accountByAddress("fake", NEW1)?.conversation_id;
  assert.ok(conv, "the account was made by the text");
  assert.equal(db.attendeeRow(ev.id, conv), null, "not on the event yet");
  const got = sentTo(h, NEW1);
  assert.ok(got.some(t => /\$25 per person \(\$26\.06 with processing\)\. refunds until 48 hours before it starts\. if you cancel: \$25\.00 back; the \$1\.06 processing fee isn't refundable\. your spot is held for 15 minutes/.test(t)), JSON.stringify(got));
  assert.ok(got.some(t => /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_1$/.test(t)), "the link went as its own message");
  const claim = db.eventClaimByCode(/code ([A-Z0-9-]+)/i.exec(codeText)[1].replace("-", ""));
  assert.equal(claim.state, "used");
  const row = eventpay.rowBySession("cs_test_1");
  assert.equal(row.conversation_id, conv);
  assert.equal(row.display_name, "Esi N");
  assert.equal(row.via, "web_text");
  h.channel.sent.length = 0;
  await completed(h, row);
  await settle();
  assert.equal(db.attendeeRow(ev.id, conv).state, "joined");
  assert.equal(db.attendeeRow(ev.id, conv).display_name, "Esi N");
  assert.ok(sentTo(h, NEW1).some(t => /you're in/.test(t)));
  // The same code again: spent.
  await h.router.deliver(texts(NEW1, codeText));
  await settle();
  assert.equal(eventpay.paidRows(ev.id).length, 1);
});

// ---------- refunds ----------

test("event_refund by text needs the yes, pinned to the guest and the amount; with it the guest is refunded in full, leaves and is told", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  await completed(h, eventpay.rowBySession("cs_test_1"));
  await settle();
  const guestId = db.attendeeRow(ev.id, C.ama).id;
  // A guest who never paid, somebody else's event: refused before any yes.
  const nobody = await tool("event_refund", { event_id: ev.id, guest_id: 999999 }, OWNER_C, h.runtime);
  assert.match(nobody.error, /No guest #999999/);
  assert.equal(nobody.use_target, undefined);
  const stranger = await tool("event_refund", { event_id: ev.id, guest_id: guestId }, C.kofi, h.runtime);
  assert.match(stranger.error, /no event #\d+ that they organize/);
  assert.equal(stranger.use_target, undefined);
  h.channel.sent.length = 0;
  const unasked = await tool("event_refund", { event_id: ev.id, guest_id: guestId }, OWNER_C, h.runtime);
  assert.equal(unasked.blocked, "needs_confirmation", JSON.stringify(unasked));
  assert.match(unasked.use_target, /^refund \$26\.06 to Ama for Supper Club \(event #\d+\) \[pay \d+\]$/);
  assert.equal(eventpay.paymentRow(eventpay.rowBySession("cs_test_1").id).status, "paid", "nothing happened");
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, 0);
  const done = await withYes(runTool, "event_refund", { event_id: ev.id, guest_id: guestId }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.refunded, "$26.06");
  await settle();
  const refund = lastCall("/v1/refunds");
  assert.equal(refund.form.reverse_transfer, "true");
  assert.equal(refund.form.refund_application_fee, "true");
  assert.equal(refund.idem, `evrefund:${eventpay.rowBySession("cs_test_1").id}:0`);
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "left");
  assert.equal(eventpay.rowBySession("cs_test_1").status, "refunded");
  assert.ok(sentTo(h, AMA).some(t => /the organizer refunded your \$26\.06 for Supper Club, so you're no longer on its guest list/.test(t)), JSON.stringify(sentTo(h, AMA)));
  const view = await tool("event_payouts", { event_id: ev.id, action: "status" }, OWNER_C, h.runtime);
  assert.equal(view.tickets.paid, 0);
  assert.equal(view.tickets.refunded, 1);
  // A second ask for the same guest: nothing to refund.
  const twice = await tool("event_refund", { event_id: ev.id, guest_id: guestId }, OWNER_C, h.runtime);
  assert.match(twice.error, /hasn't paid for Supper Club/);
  // They could come back by paying again.
  const back = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(back.payment_required, true);
});

test("cancelling a paid event refunds everyone, application fee included, and expires any open Checkout", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  for (const c of [C.ama, C.kofi]) await tool("event_join", { name: "Supper Club", password: "truffle" }, c, h.runtime);
  await completed(h, eventpay.rowBySession("cs_test_1"));
  await completed(h, eventpay.rowBySession("cs_test_2"));
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.yaw, h.runtime); // paying, not done
  await settle();
  assert.equal(db.joinedCount(ev.id), 2);
  h.channel.sent.length = 0;
  calls.length = 0;
  const out = await tool("event_cancel", { event_id: ev.id }, OWNER_C, h.runtime);
  assert.equal(out.ok, true);
  assert.deepEqual(out.refunds, { refunded: 2, failed: 0, total_cents: 5212 });
  await settle();
  const refunds = calls.filter(c => c.path === "/v1/refunds");
  assert.equal(refunds.length, 2);
  assert.ok(refunds.every(r => r.form.refund_application_fee === "true" && r.form.reverse_transfer === "true"));
  assert.ok(calls.some(c => c.path === "/v1/checkout/sessions/cs_test_3/expire"), "Yaw's open page was expired");
  assert.equal(eventpay.rowBySession("cs_test_3").status, "expired");
  for (const n of [AMA, KOFI]) {
    assert.ok(sentTo(h, n).some(t => /is cancelled\./.test(t)), `${n} told of the cancel`);
    assert.ok(sentTo(h, n).some(t => /is cancelled, so your \$26\.06 has been refunded in full/.test(t)), `${n} told of the refund`);
  }
  assert.equal(eventpay.summary(ev).refunded_count, 2);
  // A refund Stripe refuses is kept as such and counted, nothing else changes.
  const ev2 = await pricedEvent(h);
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.esi, h.runtime);
  const row = [...eventpay.paidRows(ev2.id), eventpay.rowBySession("cs_test_4")].find(Boolean);
  await completed(h, row);
  await settle();
  failNext = "/v1/refunds";
  const r = await tool("event_cancel", { event_id: ev2.id }, OWNER_C, h.runtime);
  assert.equal(r.refunds.failed, 1);
  assert.match(r.note, /1 refund didn't go through/);
  assert.equal(eventpay.paymentRow(row.id).status, "paid");
  assert.match(eventpay.paymentRow(row.id).refund_error, /fake decline/);
  assert.equal(eventpay.summary(ev2).failed_refunds, 1);
});

test("a refund made from Stripe's dashboard (charge.refunded) takes the guest off the event the same way", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  const row = eventpay.rowBySession("cs_test_1");
  await completed(h, row);
  await settle();
  h.channel.sent.length = 0;
  const r = await webhook(h, "charge.refunded", { id: "ch_fake", object: "charge", payment_intent: `pi_fake_${row.id}`, amount: row.total_cents, amount_refunded: row.total_cents, refunded: true, refunds: { data: [{ id: "re_dash_1" }] }, metadata: { reason_kind: "event_ticket" } });
  assert.equal(r.body.ok, true);
  await settle();
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  assert.equal(eventpay.paymentRow(row.id).refund_id, "re_dash_1");
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "left");
  assert.ok(sentTo(h, AMA).some(t => /refunded your \$26\.06/.test(t)));
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, 0, "Reason did not refund it again");
});

// ---------- the organizer's page ----------

test("the Tickets section: set up payouts (303 to Stripe), the price behind a confirm step with the quote, who paid, refund, dashboard", async () => {
  const h = harness();
  const ev = makeEvent();
  // Before payouts: the setup button, and a post that goes to Stripe's onboarding.
  const before = await req(h, ev, { cookie: COOKIE.owner });
  assert.match(before.body, /07<\/span> · TICKETS/);
  assert.match(before.body, /Set up payouts with Stripe/);
  assert.match(before.body, /08<\/span> · SHARING/);
  assert.match(before.body, /09<\/span> · MORE/);
  const setup = await post(h, ev, { action: "payouts", step: "do" });
  assert.equal(setup.status, 303);
  assert.match(setup.headers.Location, /^https:\/\/connect\.stripe\.test\/setup\/acct_fake_1$/);
  // The price before payouts are ready: refused on the page too.
  const early = await post(h, ev, { action: "price", step: "review", price: "25" });
  assert.match(early.body, /Set up payouts with Stripe first/);
  assert.equal(db.getEventRow(ev.id).price_cents, null);
  // Ready: the price form with its quote, the review, and the save.
  accountState.set("acct_fake_1", { charges: true });
  await req(h, ev, { sub: "payouts", query: { back: "1" }, cookie: COOKIE.owner });
  const ready = await req(h, ev, { cookie: COOKIE.owner });
  assert.match(ready.body, /PRICE PER PERSON · \$5 TO \$500/);
  assert.match(ready.body, /id="price_quote"/);
  const bad = await post(h, ev, { action: "price", step: "review", price: "4" });
  assert.match(bad.body, /lowest price is \$5/);
  const review = await post(h, ev, { action: "price", step: "review", price: "25" });
  assert.equal(review.status, 200);
  assert.match(review.body, /Charge \$25 a person\?/);
  assert.match(review.body, /Guests pay \$26\.06: your \$25 plus \$1\.06 of Stripe/);
  assert.match(review.body, /You get \$24\.37 per person/);
  assert.equal(db.getEventRow(ev.id).price_cents, null, "nothing saved by the review");
  const saved = await post(h, ev, { action: "price", step: "do", price: "25" });
  assert.equal(saved.status, 303);
  assert.match(saved.headers.Location, /done=price_saved#money/);
  assert.equal(db.getEventRow(ev.id).price_cents, 2500);
  const after = await req(h, ev, { query: { done: "price_saved" }, cookie: COOKIE.owner });
  assert.match(after.body, /\$25 PER PERSON/);
  assert.match(after.body, /Set\. Guests pay \$26\.06/);
  assert.match(after.body, /\$25 a person/);
  assert.match(after.body, /Nobody has paid yet/);
  // A guest pays; the page shows who, and offers the refund behind a confirm step.
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  const row = eventpay.rowBySession("cs_test_1");
  await completed(h, row);
  await settle();
  const paidPage = await req(h, ev, { cookie: COOKIE.owner });
  assert.match(paidPage.body, /WHO PAID/);
  assert.match(paidPage.body, /paid \$26\.06/);
  assert.match(paidPage.body, /GROSS<\/span><span>\$25</);
  assert.match(paidPage.body, /COMING TO YOU<\/span><span><b>\$24\.37</);
  assert.match(paidPage.body, new RegExp(`name="payment" value="${row.id}"`));
  const rreview = await post(h, ev, { action: "refund", step: "review", payment: String(row.id) });
  assert.match(rreview.body, /Refund Ama \$26\.06\?/);
  assert.match(rreview.body, /the organizer refunded your \$26\.06 for Supper Club/);
  assert.equal(eventpay.paymentRow(row.id).status, "paid", "the review refunds nothing");
  h.channel.sent.length = 0;
  const rdone = await post(h, ev, { action: "refund", step: "do", payment: String(row.id) });
  assert.equal(rdone.status, 303);
  assert.match(rdone.headers.Location, /done=refunded#money/);
  await settle();
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "left");
  assert.ok(sentTo(h, AMA).some(t => /refunded your \$26\.06/.test(t)));
  // The dashboard: a one-time login link, by post, never shown on the page.
  const dash = await post(h, ev, { action: "dashboard", step: "do" });
  assert.equal(dash.status, 303);
  assert.match(dash.headers.Location, /^https:\/\/connect\.stripe\.test\/express\/acct_fake_1$/);
  assert.ok(!/connect\.stripe\.test\/express/.test(paidPage.body));
  // Free again, behind a confirm step.
  const freeReview = await post(h, ev, { action: "free", step: "review" });
  assert.match(freeReview.body, /Make it free to join\?/);
  assert.equal(db.getEventRow(ev.id).price_cents, 2500);
  const freed = await post(h, ev, { action: "free", step: "do" });
  assert.match(freed.headers.Location, /done=price_free#money/);
  assert.equal(db.getEventRow(ev.id).price_cents, null);
  // A guest or a stranger posting to Tickets: the flat not-found, nothing changed.
  const guest = await post(h, ev, { action: "price", step: "do", price: "99" }, COOKIE.kofi);
  assert.equal(guest.status, 404);
  const nobody = await post(h, ev, { action: "payouts", step: "do" }, "");
  assert.equal(nobody.status, 404);
  assert.equal(db.getEventRow(ev.id).price_cents, null);
});

test("what the organizer and a guest are shown: the view, the public page, and the cancel copy", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  await completed(h, eventpay.rowBySession("cs_test_1"));
  await settle();
  const v = events.organizerView(db.getEventRow(ev.id));
  assert.equal(v.price_per_person, "$25");
  assert.equal(v.tickets.paid, 1);
  assert.equal(v.tickets.gross, "$25");
  assert.equal(v.tickets.you_get, "$24.37");
  assert.equal(v.payouts_ready, true);
  const pub = events.publicView(db.getEventRow(ev.id));
  assert.equal(pub.paid_event, true);
  assert.match(pub.price, /\$25 per person/);
  const look = await tool("event_lookup", { link: events.eventUrl(ev) }, C.kofi, h.runtime);
  assert.equal(look.event.price_per_person, "$25");
  const page = await req(h, ev, { cookie: COOKIE.owner });
  assert.match(unesc(page.body), /Everyone who paid is refunded in full, Reason's fee included/);
  assert.match(page.body, /\$25 a person, 1 guest paid/);
  // A free event shows none of it.
  const free = makeEvent(OWNER_C, { name: "Free Supper", password: "gratis" });
  assert.equal(events.publicView(free).paid_event, undefined);
  assert.equal(events.organizerView(free).tickets, undefined);
});

// ---------- the second review's blockers (2026-11-11) ----------

test("answers to the organizer's questions survive a paid join: by text and from the page they ride on the payment and are filed when it lands", async () => {
  const questions = await import("../src/eventquestions.js");
  const h = harness();
  const ev = await pricedEvent(h);
  const food = questions.addQuestion(ev, { kind: "choice", prompt: "Any dietary needs?", choices: ["Vegetarian", "Vegan", "No restrictions"], required: true }).question;
  const plus = questions.addQuestion(ev, { kind: "text", prompt: "Your plus-one's name" }).question;
  // By text: a required question unanswered holds the join; answered, the Checkout link comes and the answers wait on the row.
  const held = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(held.reason, "needs_answers");
  const join = await tool("event_join", { name: "Supper Club", password: "truffle", answers: [{ question_id: food.question_id, choice: 2 }, { question_id: plus.question_id, text: "Kojo" }] }, C.ama, h.runtime);
  assert.equal(join.payment_required, true, JSON.stringify(join));
  const row = eventpay.openRow(ev.id, C.ama);
  assert.ok(row.answers, "the answers ride on the payment row");
  assert.equal(questions.answersByGuest(ev).size, 0, "nothing filed before the payment");
  await completed(h, row);
  await settle();
  const ama = db.attendeeRow(ev.id, C.ama);
  assert.equal(ama.state, "joined");
  assert.deepEqual(questions.answersByGuest(ev).get(ama.id), [{ question: "Any dietary needs?", answer: "Vegan" }, { question: "Your plus-one's name", answer: "Kojo" }]);
  assert.equal(eventpay.paymentRow(row.id).answers, null, "the row keeps no copy once filed");
  // From the page, signed in: the form's answers go the same way.
  const fields = { display_name: "Kofi", password: "truffle", in_directory: "1", [`q_${food.question_id}`]: "0", [`q_${plus.question_id}`]: "Abena" };
  const page = await req(h, ev, { sub: "join", method: "POST", body: form(fields), cookie: COOKIE.kofi });
  assert.equal(page.status, 303, JSON.stringify(page).slice(0, 300));
  const krow = eventpay.openRow(ev.id, C.kofi);
  assert.ok(krow?.answers, "the page's answers ride on Kofi's payment row");
  await completed(h, krow);
  await settle();
  const kofi = db.attendeeRow(ev.id, C.kofi);
  assert.deepEqual(questions.answersByGuest(ev).get(kofi.id), [{ question: "Any dietary needs?", answer: "Vegetarian" }, { question: "Your plus-one's name", answer: "Abena" }]);
});

test("a payment that lands for somebody already in buys nothing: refunded in full, said, and their spot stands", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const first = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(first.payment_required, true);
  const row1 = eventpay.openRow(ev.id, C.ama);
  // The hold runs out and the page stays open on Stripe's side (the expire call failed); a second page is opened and both get paid.
  clock.skip(16 * MIN);
  failNext = "/v1/checkout/sessions/";
  await eventpay.sweep({ log: () => {} });
  assert.equal(eventpay.paymentRow(row1.id).status, "expired");
  const second = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(second.payment_required, true);
  const row2 = eventpay.openRow(ev.id, C.ama);
  assert.notEqual(row2.id, row1.id);
  await completed(h, row2);
  await settle();
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "joined");
  h.channel.sent.length = 0;
  refundsMade = 0;
  const late = await completed(h, row1, { intent: `pi_fake_${row1.id}` });
  assert.equal(late.status, 200);
  await settle();
  assert.equal(eventpay.paymentRow(row1.id).status, "refunded", "the late payment went straight back");
  assert.equal(refundsMade, 1);
  const rf = lastCall("/v1/refunds");
  assert.equal(rf.form.payment_intent, `pi_fake_${row1.id}`);
  assert.equal(rf.form.reverse_transfer, "true");
  assert.equal(rf.form.refund_application_fee, "true");
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "joined", "their spot stands");
  assert.equal(eventpay.paymentRow(row2.id).status, "paid", "the payment that got them in stands");
  assert.equal(db.joinedCount(ev.id), 1);
  const got = sentTo(h, AMA);
  assert.ok(got.some(t => /already had you on it, so i've refunded your \$26\.06 in full/.test(t)), JSON.stringify(got));
  // A refund retry after Stripe said no is a new request, not the replayed no.
  const refusal = await tool("event_refund", { event_id: ev.id, guest_id: db.attendeeRow(ev.id, C.ama).id }, OWNER_C, h.runtime);
  assert.equal(refusal.blocked, "needs_confirmation");
  failNext = "/v1/refunds";
  const failed = await withYes(runTool, "event_refund", { event_id: ev.id, guest_id: db.attendeeRow(ev.id, C.ama).id }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(failed.ok, false);
  assert.equal(eventpay.paymentRow(row2.id).refund_attempts, 1);
  const keys = calls.filter(c => c.path === "/v1/refunds").map(c => c.idem);
  const retried = await withYes(runTool, "event_refund", { event_id: ev.id, guest_id: db.attendeeRow(ev.id, C.ama).id }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const keysAfter = calls.filter(c => c.path === "/v1/refunds").map(c => c.idem);
  assert.notEqual(keysAfter.at(-1), keys.at(-1), "a fresh idempotency key on the retry");
  assert.equal(eventpay.paymentRow(row2.id).status, "refunded");
});
