// Paid events, round two (owner decisions 2026-11-11, src/eventpay.js): the refund policy per event
// and the organizer's sales summary. Pinned:
//
//   - the policy: no refunds | until N hours/days before it starts (default 48 hours) | anytime until
//     it starts; shown on the join page next to the price, on Stripe's page (custom_text + the ticket
//     line's description), in the pay-link text and the paid-join receipt;
//   - a guest's own refund (text: event_ticket_refund behind the yes; page: Refund my ticket behind a
//     confirm step) is automatic while the policy allows — the whole amount, Reason's fee refunded —
//     and refused before any yes otherwise, saying the organizer can still choose to refund;
//   - the organizer's refunds ignore the policy; loosening reaches tickets already sold, tightening
//     only new sales (each ticket carries the policy it was bought under);
//   - sales: sold, gross, refunded, Reason's 2.5%, coming to you, and the next payout from Stripe
//     (balance + payouts on the connected account, Stripe-Account header), with "not available yet".
//
// Stripe is a fake on this machine (STRIPE_API_BASE); nothing here reaches the network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { withYes } from "./fixture-yes.js";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-refund-sales-"));
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
let accountsMade = 0, sessionsMade = 0, refundsMade = 0, failNext = null, failStatus = 402;
let balance = { available: [], pending: [] }, payouts = [], payoutFail = false;
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    calls.push({ method: req.method, path: req.url, form, idem: req.headers["idempotency-key"] ?? null, auth: req.headers.authorization, account: req.headers["stripe-account"] ?? null });
    res.setHeader("content-type", "application/json");
    if (failNext && req.url.startsWith(failNext)) { failNext = null; res.statusCode = failStatus; failStatus = 402; return res.end(JSON.stringify({ error: { message: "fake decline", code: "fake" } })); }
    if (req.method === "POST" && req.url === "/v1/accounts") return res.end(JSON.stringify({ id: `acct_fake_${++accountsMade}`, object: "account", type: "express", charges_enabled: false, details_submitted: false, payouts_enabled: false }));
    const acct = /^\/v1\/accounts\/([^/?]+)$/.exec(req.url);
    if (acct && req.method === "GET") return res.end(JSON.stringify({ id: decodeURIComponent(acct[1]), object: "account", charges_enabled: stateOf(acct[1]).charges, details_submitted: stateOf(acct[1]).charges, payouts_enabled: stateOf(acct[1]).charges }));
    if (req.method === "POST" && req.url === "/v1/account_links") return res.end(JSON.stringify({ object: "account_link", url: `https://connect.stripe.test/setup/${form.account}` }));
    const login = /^\/v1\/accounts\/([^/]+)\/login_links$/.exec(req.url);
    if (login && req.method === "POST") return res.end(JSON.stringify({ object: "login_link", url: `https://connect.stripe.test/express/${login[1]}` }));
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") return res.end(JSON.stringify({ id: `cs_test_${++sessionsMade}`, object: "checkout.session", url: `https://checkout.stripe.test/c/pay/cs_test_${sessionsMade}`, payment_intent: null }));
    if (/^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(req.url) && req.method === "POST") return res.end(JSON.stringify({ object: "checkout.session", status: "expired" }));
    if (req.method === "GET" && req.url === "/v1/balance") { if (payoutFail) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: "fake outage" } })); } return res.end(JSON.stringify({ object: "balance", ...balance })); }
    if (req.method === "GET" && req.url.startsWith("/v1/payouts")) return res.end(JSON.stringify({ object: "list", data: payouts }));
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
  balance = { available: [], pending: [] }; payouts = []; payoutFail = false;
  eventpay.forgetPayoutInfo();
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


const HOUR = 60 * MIN;
/** Ama joins by text and pays; returns her payment row. */
async function amaPays(h, ev, who = C.ama) {
  const out = await tool("event_join", { name: ev.name, password: "truffle" }, who, h.runtime);
  assert.equal(out.payment_required, true, JSON.stringify(out));
  const row = [...db.db.prepare("SELECT * FROM event_payments WHERE event_id = ? AND conversation_id = ? ORDER BY id DESC").all(ev.id, who)][0];
  await completed(h, row);
  await settle();
  return eventpay.paymentRow(row.id);
}
const startsIn = (ev, ms) => db.updateEventRow(ev.id, { starts_at: clock.now() + ms });

// ---------- the policy itself ----------

test("the policy: default until 48 hours; the window closes N hours before the start; none never opens; no start time stays open", () => {
  const base = { id: 1, status: "active", starts_at: clock.now() + 72 * HOUR, refund_policy: null, refund_hours: null, tz: "America/New_York", name: "X" };
  assert.deepEqual(eventpay.policyOf(base), { policy: "until", hours: 48 });
  assert.equal(eventpay.refundPolicyLine(eventpay.policyOf(base)), "Refunds until 48 hours before it starts.");
  assert.equal(eventpay.refundPolicyLine({ policy: "until", hours: 72 }), "Refunds until 3 days before it starts.");
  assert.equal(eventpay.refundPolicyLine({ policy: "until", hours: 1 }), "Refunds until 1 hour before it starts.");
  assert.equal(eventpay.refundPolicyLine({ policy: "none" }), "No refunds.");
  assert.equal(eventpay.refundPolicyLine({ policy: "anytime" }), "Refunds anytime until it starts.");
  assert.equal(eventpay.refundWindow(base, null).allowed, true);
  assert.equal(eventpay.refundWindow({ ...base, starts_at: clock.now() + 47 * HOUR }, null).why, "closed");
  assert.equal(eventpay.refundWindow({ ...base, refund_policy: "anytime", starts_at: clock.now() + 1 * HOUR }, null).allowed, true);
  assert.equal(eventpay.refundWindow({ ...base, refund_policy: "anytime", starts_at: clock.now() - 1 }, null).why, "started");
  assert.equal(eventpay.refundWindow({ ...base, refund_policy: "none" }, null).why, "no_refunds");
  assert.equal(eventpay.refundWindow({ ...base, starts_at: null }, null).allowed, true, "nothing to count back from");
  assert.equal(eventpay.refundWindow({ ...base, status: "cancelled" }, null).allowed, false);
  // A ticket keeps the policy it was bought under, unless the event's is looser now.
  const strictNow = { ...base, refund_policy: "none" };
  assert.deepEqual(eventpay.ticketPolicy(strictNow, { refund_policy: "until", refund_hours: 48 }), { policy: "until", hours: 48 }, "tightening never reaches a sold ticket");
  const looseNow = { ...base, refund_policy: "anytime" };
  assert.deepEqual(eventpay.ticketPolicy(looseNow, { refund_policy: "none", refund_hours: null }), { policy: "anytime", hours: null }, "loosening does");
  assert.deepEqual(eventpay.ticketPolicy({ ...base, refund_hours: 24 }, { refund_policy: "until", refund_hours: 72 }), { policy: "until", hours: 24 }, "fewer hours is looser");
  assert.equal(eventpay.readPolicy({ policy: "until", days: 3 }).hours, 72);
  assert.equal(eventpay.readPolicy({ policy: "until", hours: 0 }).ok, false);
  assert.equal(eventpay.readPolicy({ policy: "sometimes" }).ok, false);
});

// ---------- the organizer picks it ----------

test("event_price takes the policy with the price or alone; the default is said; tightening after sales spares the tickets sold", async () => {
  const h = harness();
  readyPayouts();
  const ev = makeEvent();
  const first = await tool("event_price", { event_id: ev.id, price_dollars: 25 }, OWNER_C, h.runtime);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.refund_policy, "Refunds until 48 hours before it starts");
  assert.match(first.note, /\(the default; they can change it\)/);
  const days = await tool("event_price", { event_id: ev.id, refund_policy: "until", refund_days: 3 }, OWNER_C, h.runtime);
  assert.equal(days.ok, true, JSON.stringify(days));
  assert.equal(days.guests_see, "Refunds until 3 days before it starts.");
  assert.equal(db.getEventRow(ev.id).refund_hours, 72);
  const bad = await tool("event_price", { event_id: ev.id, refund_policy: "until", refund_hours: 5000 }, OWNER_C, h.runtime);
  assert.equal(bad.ok, false);
  // A sale under 3 days, then the organizer tightens to none: that ticket keeps 3 days.
  const row = await amaPays(h, db.getEventRow(ev.id));
  assert.equal(row.refund_policy, "until");
  assert.equal(row.refund_hours, 72);
  const tight = await tool("event_price", { event_id: ev.id, refund_policy: "none" }, OWNER_C, h.runtime);
  assert.match(tight.note, /The 1 guest who already paid keep the looser policy they bought under/);
  assert.deepEqual(eventpay.ticketPolicy(db.getEventRow(ev.id), eventpay.paymentRow(row.id)), { policy: "until", hours: 72 });
  const loose = await tool("event_price", { event_id: ev.id, refund_policy: "anytime" }, OWNER_C, h.runtime);
  assert.match(loose.note, /reaches the 1 guest who already paid too/);
  // A non-organizer can't touch it.
  const stranger = await tool("event_price", { event_id: ev.id, refund_policy: "none" }, C.kofi, h.runtime);
  assert.equal(stranger.ok, false);
  assert.equal(db.getEventRow(ev.id).refund_policy, "anytime");
});

// ---------- guests see it everywhere they pay ----------

test("guests see the policy: join page next to the price, Stripe's page, the pay-link text and the paid-join receipt", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await tool("event_price", { event_id: ev.id, refund_policy: "until", refund_hours: 24 }, OWNER_C, h.runtime);
  const pub = await req(h, ev);
  assert.match(unesc(pub.body), /Refunds until 24 hours before/);
  const out = await tool("event_join", { name: "Supper Club", password: "truffle" }, C.ama, h.runtime);
  assert.equal(out.payment_required, true);
  const cs = lastCall("/v1/checkout/sessions");
  // Every place the policy is said, what a guest's own cancel gives back is said with it (owner decision 2026-11-11).
  assert.match(unesc(pub.body), /Refunds until 24 hours before it starts\. If you cancel: \$25\.00 back; the \$1\.06 processing fee isn't refundable\./);
  assert.equal(cs.form["custom_text[submit][message]"], "Refunds until 24 hours before it starts. If you cancel: $25.00 back; the $1.06 processing fee isn't refundable. Ask Reason by text, or use your event page, to cancel.");
  assert.equal(cs.form["line_items[0][price_data][product_data][description]"], "Refunds until 24 hours before it starts. If you cancel: $25.00 back; the $1.06 processing fee isn't refundable.");
  const row = eventpay.rowBySession("cs_test_1");
  assert.equal(row.refund_hours, 24);
  assert.match(eventpay.payLinkText(db.getEventRow(ev.id)), /refunds until 24 hours before it starts\. if you cancel: \$25\.00 back; the \$1\.06 processing fee isn't refundable\. your spot is held/);
  await completed(h, row);
  await settle();
  assert.ok(sentTo(h, AMA).some(t => /^paid \$26\.06 for Supper Club — you're in\. refunds until 24 hours before it starts — just text me "refund my ticket" if plans change \(\$25\.00 back; the \$1\.06 processing fee isn't refundable\)\.$/.test(t)), JSON.stringify(sentTo(h, AMA)));
  // No refunds: said plainly, with no "ask Reason" line on Stripe's page.
  await tool("event_price", { event_id: ev.id, refund_policy: "none" }, OWNER_C, h.runtime);
  await tool("event_join", { name: "Supper Club", password: "truffle" }, C.kofi, h.runtime);
  assert.equal(lastCall("/v1/checkout/sessions").form["custom_text[submit][message]"], "No refunds.");
  const guestInfo = await tool("event_info", { event_id: ev.id }, C.ama, h.runtime);
  assert.equal(guestInfo.you.your_refund_policy, "Refunds until 24 hours before it starts.", "Ama's ticket keeps the policy she bought under");
  assert.equal(guestInfo.you.can_ask_for_refund_now, true);
});

// ---------- a guest's own refund, by text ----------

test("a guest's refund by text: shown only to ticket holders, behind the yes pinned to the ticket; the price back (processing kept, Reason's 2.5% back to the organizer), off the list, both told", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  assert.equal(toolsFor(C.ama).some(t => t.name === "event_ticket_refund"), false, "no ticket, no tool");
  const row = await amaPays(h, ev);
  assert.equal(toolsFor(C.ama).some(t => t.name === "event_ticket_refund"), true);
  assert.equal(toolsFor(C.kofi).some(t => t.name === "event_ticket_refund"), false);
  h.channel.sent.length = 0;
  const unasked = await tool("event_ticket_refund", { event_id: ev.id }, C.ama, h.runtime);
  assert.equal(unasked.blocked, "needs_confirmation", JSON.stringify(unasked));
  assert.match(unasked.use_target, /^cancel my ticket for Supper Club \(event #\d+\): \$25\.00 back \[pay \d+\]$/);
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, 0, "nothing happened before the yes");
  const done = await withYes(runTool, "event_ticket_refund", { event_id: ev.id }, { conversationId: C.ama, messages: [], events: h.runtime });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.refunded, "$25.00");
  assert.equal(done.not_refunded, "$25.00 back; the $1.06 processing fee isn't refundable.");
  await settle();
  const refund = lastCall("/v1/refunds");
  assert.equal(refund.form.amount, "2500", "the ticket price, not the $26.06 total: Stripe keeps its processing");
  assert.equal(refund.form.reverse_transfer, "true", "the transfer is reversed in proportion: exactly $25.00");
  assert.equal(refund.form.refund_application_fee, "false", "no proportional fee refund; Reason's 2.5% goes back on its own");
  assert.equal(refund.form["metadata[why]"], "guest");
  const feeBack = lastCall("/v1/application_fees/");
  assert.ok(feeBack, "Reason's 2.5% went back");
  assert.equal(feeBack.form.amount, "63", "Reason's 2.5% of $25, so the organizer ends with nothing for the ticket");
  assert.equal(eventpay.paymentRow(row.id).fee_back_owed_cents, 0);
  assert.equal(eventpay.paymentRow(row.id).refunded_cents, 2500);
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "left");
  assert.ok(sentTo(h, AMA).some(t => /your ticket for Supper Club is cancelled and you're off its guest list: \$25\.00 back; the \$1\.06 processing fee isn't refundable\. it shows up on your card/.test(t)), JSON.stringify(sentTo(h, AMA)));
  assert.ok(sentTo(h, OWNER).some(t => /^Ama cancelled their ticket to Supper Club under your refund policy and got the \$25\.00 ticket price back/.test(t)), JSON.stringify(sentTo(h, OWNER)));
  // Somebody without a ticket on it, by id: refused before any yes, describing nothing.
  const kofi = await tool("event_ticket_refund", { event_id: ev.id }, C.kofi, h.runtime);
  assert.equal(kofi.use_target, undefined);
  assert.equal(kofi.ok, false);
});

test("outside the policy the guest is refused before any yes, told the organizer can still refund; the organizer's refund ignores the policy", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaPays(h, ev);
  startsIn(ev, 24 * HOUR);
  const closed = await tool("event_ticket_refund", { event_id: ev.id }, C.ama, h.runtime);
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "refund_not_allowed");
  assert.equal(closed.use_target, undefined, "no yes is asked for a refund that would be refused");
  assert.match(closed.error, /refund window for Supper Club has closed .*the organizer can still choose to refund you/);
  db.updateEventRow(ev.id, { refund_policy: "none" });
  db.db.prepare("UPDATE event_payments SET refund_policy = 'none', refund_hours = NULL WHERE id = ?").run(row.id);
  const none = await tool("event_ticket_refund", { event_id: ev.id }, C.ama, h.runtime);
  assert.match(none.error, /no-refunds policy.*organizer can still choose/);
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, 0);
  // The organizer: always.
  const guestId = db.attendeeRow(ev.id, C.ama).id;
  const org = await withYes(runTool, "event_refund", { event_id: ev.id, guest_id: guestId }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(org.ok, true, JSON.stringify(org));
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  // The organizer's refund gives everything back, processing included, and Stripe refunds the whole fee.
  const rf = lastCall("/v1/refunds");
  assert.equal(rf.form.amount, undefined, "the whole charge");
  assert.equal(rf.form.refund_application_fee, "true");
  assert.equal(calls.filter(c => c.path.startsWith("/v1/application_fees/")).length, 0);
  assert.equal(eventpay.paymentRow(row.id).refunded_cents, 2606);
});

// ---------- a guest's own refund, on their page ----------

test("the guest's page: their ticket and policy, Refund my ticket behind a confirm step; a stranger's or cross-site post does nothing", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaPays(h, ev);
  const mine = await req(h, ev, { cookie: COOKIE.ama });
  const body = unesc(mine.body);
  assert.match(body, /YOUR TICKET|Your ticket/);
  assert.match(body, /You paid \$26\.06\. Refunds until 48 hours before it starts\. That's until Thu, Jun 3/);
  assert.match(body, /Refund my ticket/);
  assert.match(body, /Plans changed\? Cancel and you get \$25\.00 back; the \$1\.06 processing fee isn't refundable\./);
  // Somebody else's browser, or another site: nothing.
  const kofi = await req(h, ev, { sub: "refund", method: "POST", body: "step=do", cookie: COOKIE.kofi });
  assert.equal(kofi.status, 404);
  const cross = await eventRequestFor({ publicId: ev.public_id, sub: "refund", method: "POST", query: {}, headers: { cookie: COOKIE.ama, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test", host: "events.example.test", origin: "https://evil.example" }, remoteAddress: "127.0.0.1", readBody: async () => "step=do", runtime: h.runtime, router: h.router });
  assert.equal(cross.status, 403);
  const review = await req(h, ev, { sub: "refund", method: "POST", body: "step=review", cookie: COOKIE.ama });
  assert.equal(review.status, 200);
  assert.match(unesc(review.body), /Refund your ticket\?.*You paid \$26\.06\. Cancel and you get \$25\.00 back; the \$1\.06 processing fee isn't refundable\./s);
  assert.match(unesc(review.body), /Cancel and get \$25\.00 back<\/button>/);
  assert.equal(eventpay.paymentRow(row.id).status, "paid", "the review refunds nothing");
  const done = await req(h, ev, { sub: "refund", method: "POST", body: "step=do", cookie: COOKIE.ama });
  assert.equal(done.status, 200);
  assert.match(unesc(done.body), /Refunded.*\$25\.00 back; the \$1\.06 processing fee isn't refundable\. The money is on its way back/s);
  assert.equal(lastCall("/v1/refunds").form.amount, "2500");
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "left");
});

test("the guest's page outside the policy: no button, the organizer can still refund; a hidden start time is never told by a deadline", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { show_time_on_join: false } });
  await amaPays(h, ev);
  const open = unesc((await req(h, ev, { cookie: COOKIE.ama })).body);
  assert.match(open, /Refunds until 48 hours before it starts\./);
  assert.doesNotMatch(open, /That's until/, "the deadline would give the hidden start time away");
  startsIn(ev, 10 * HOUR);
  const page = unesc((await req(h, ev, { cookie: COOKIE.ama })).body);
  assert.doesNotMatch(page, /Refund my ticket/);
  assert.match(page, /The organizer can still choose to refund you/);
  const post = await req(h, ev, { sub: "refund", method: "POST", body: "step=do", cookie: COOKIE.ama });
  assert.equal(post.status, 303, "back to the page, which says why");
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, 0);
});

// ---------- the organizer's page: picking the policy ----------

test("07 Tickets: the policy picker, behind the price's confirm step; a policy-only change says so; tightening is said", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const home = unesc((await req(h, ev, { cookie: COOKIE.owner })).body);
  assert.match(home, /REFUNDS · GUESTS SEE THIS BEFORE THEY PAY/);
  assert.match(home, /name="refund_policy" value="until" checked/);
  assert.match(home, /id="refund_n" name="refund_n"[^>]*value="48"/);
  await amaPays(h, ev);
  const review = await post(h, ev, { action: "price", step: "review", price: "25", refund_policy: "none", refund_n: "48", refund_unit: "hours" });
  const rb = unesc(review.body);
  assert.match(rb, /Change the refund policy\?/);
  assert.match(rb, /No refunds\. Guests see it next to the price/);
  assert.match(rb, /The 1 guest who already paid keep the looser policy they bought under/);
  assert.equal(db.getEventRow(ev.id).refund_policy, null, "the review saves nothing");
  const done = await post(h, ev, { action: "price", step: "do", price: "25", refund_policy: "until", refund_n: "3", refund_unit: "days" });
  assert.equal(done.status, 303, done.body);
  assert.equal(db.getEventRow(ev.id).refund_policy, "until");
  assert.equal(db.getEventRow(ev.id).refund_hours, 72);
  const bad = await post(h, ev, { action: "price", step: "review", price: "25", refund_policy: "until", refund_n: "0", refund_unit: "hours" });
  assert.match(unesc(bad.body), /Refunds can close from 1 hour to 60 days before the start/);
});

// ---------- sales ----------

test("sales: sold, gross, refunded, Reason's 2.5%, coming to you; the next payout from Stripe on the connected account", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await amaPays(h, ev, C.ama);
  const kofiRow = await amaPays(h, ev, C.kofi);
  await eventpay.refund({ ev: db.getEventRow(ev.id), row: kofiRow, why: "organizer", runtime: h.runtime });
  const s = eventpay.summary(db.getEventRow(ev.id));
  assert.equal(s.sold_count, 2);
  assert.equal(s.gross_cents, 5000);
  assert.equal(s.refunded_cents, 2500);
  assert.equal(s.reason_fee_cents, 63);
  assert.equal(s.organizer_net_cents, 2437);
  assert.equal(s.gross_cents - s.refunded_cents - s.reason_fee_cents, s.organizer_net_cents);
  // Stripe: a payout on its way, asked of the organizer's own account.
  const arrive = Math.floor(Date.UTC(2027, 0, 15, 12) / 1000);
  payouts = [{ id: "po_1", amount: 2437, status: "in_transit", arrival_date: arrive }, { id: "po_0", amount: 900, status: "paid", arrival_date: arrive - 86400 * 7 }];
  balance = { available: [{ amount: 0, currency: "usd" }], pending: [{ amount: 0, currency: "usd" }] };
  const st = await tool("event_payouts", { event_id: ev.id, action: "status" }, OWNER_C, h.runtime);
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.tickets.sold, 2);
  assert.equal(st.tickets.gross, "$50");
  assert.equal(st.tickets.refunded_amount, "$25");
  assert.equal(st.tickets.reason_fee, "$0.63");
  assert.equal(st.tickets.you_get, "$24.37");
  assert.match(st.say, /^2 tickets sold for Supper Club — \$50 gross\. 1 refunded \(\$25\)\. Reason's 2\.5%: \$0\.63\. Coming to you: \$24\.37\. Next payout: \$24\.37 on its way, arriving Fri, Jan 15 \(all your events together\)\.$/);
  const bal = lastCall("/v1/balance");
  assert.equal(bal.account, "acct_ready_dmowner", "asked on the organizer's connected account");
  assert.equal(lastCall("/v1/payouts").account, "acct_ready_dmowner");
  // The page: the same numbers, and the payout (asked when the page opens, kept a minute).
  eventpay.forgetPayoutInfo();
  const page = unesc((await req(h, ev, { cookie: COOKIE.owner })).body);
  assert.match(page, /SOLD<\/span><span>2 tickets/);
  assert.match(page, /GROSS<\/span><span>\$50</);
  assert.match(page, /REFUNDED<\/span><span>\$25 · 1 ticket</);
  assert.match(page, /REASON'S 2\.5%<\/span><span>\$0\.63</);
  assert.match(page, /COMING TO YOU<\/span><span><b>\$24\.37</);
  assert.match(page, /NEXT PAYOUT<\/span><span[^>]*>\$24\.37 on its way, arriving Fri, Jan 15/);
  const asked = calls.filter(c => c.path === "/v1/balance").length;
  await req(h, ev, { cookie: COOKIE.owner });
  assert.equal(calls.filter(c => c.path === "/v1/balance").length, asked, "a reload inside a minute doesn't ask Stripe again");
});

// Owner decision 2026-11-11: a guest's own cancel gets the price back (Stripe keeps its processing,
// Reason's 2.5% goes back to the organizer); the organizer's refund or a cancel gets everything back.
// The ledger below plays Stripe's money moves for a destination charge (the whole charge is
// transferred, the application fee comes back; a refund reverses the transfer in proportion) and
// checks the organizer ends with exactly what the summary says, and the platform with Reason's 2.5%
// on the tickets that stand less the processing it ate on the organizer's refund.
test("sales after a guest's own cancel and an organizer's refund: the summary is what the money did", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const rows = [await amaPays(h, ev, C.ama), await amaPays(h, ev, C.kofi), await amaPays(h, ev, C.yaw)];
  const ama = await eventpay.guestRefund({ ev: db.getEventRow(ev.id), conversationId: C.ama, runtime: h.runtime });
  assert.equal(ama.ok, true, JSON.stringify(ama));
  assert.equal(ama.back_cents, 2500);
  await eventpay.refund({ ev: db.getEventRow(ev.id), row: rows[1], why: "organizer", runtime: h.runtime });
  await settle();
  const s = eventpay.summary(db.getEventRow(ev.id));
  assert.equal(s.sold_count, 3);
  assert.equal(s.gross_cents, 7500);
  assert.equal(s.refunded_count, 2);
  assert.equal(s.refunded_cents, 5000, "the organizer gave back two tickets' price");
  assert.equal(s.returned_cents, 2500 + 2606, "Ama got the price, Kofi everything");
  assert.equal(s.reason_fee_cents, 63);
  assert.equal(s.organizer_net_cents, 2437);
  assert.equal(s.gross_cents - s.refunded_cents - s.reason_fee_cents, s.organizer_net_cents);
  // The ledger, from the calls Reason made.
  const qt = eventpay.quote(2500);
  let organizer = 0, platform = 0;
  for (const r of rows) { organizer += qt.total - qt.application_fee; platform += qt.application_fee - qt.processing; }
  for (const c of calls.filter(c => c.path === "/v1/refunds")) {
    const pay = eventpay.paymentRow(Number(c.form["metadata[event_payment_id]"]));
    const amount = c.form.amount ? Number(c.form.amount) : pay.total_cents;
    const reversed = Math.round(pay.total_cents * amount / pay.total_cents);
    const feeBack = c.form.refund_application_fee === "true" ? Math.round(pay.application_fee_cents * amount / pay.total_cents) : 0;
    organizer += -reversed + feeBack; platform += -amount + reversed - feeBack;
  }
  for (const c of calls.filter(c => /^\/v1\/application_fees\/[^/]+\/refunds$/.test(c.path))) { organizer += Number(c.form.amount); platform -= Number(c.form.amount); }
  assert.equal(organizer, s.organizer_net_cents, "the organizer has exactly what Coming to you says");
  assert.equal(platform, qt.reason_fee - qt.processing, "Reason keeps 2.5% on Yaw's ticket and ate the processing on the organizer's refund only");
});

test("Reason's 2.5% back after a guest's own cancel: Stripe saying no leaves it owed, the sweep pays it once", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaPays(h, ev);
  failNext = "/v1/application_fees/";
  const out = await eventpay.guestRefund({ ev: db.getEventRow(ev.id), conversationId: C.ama, runtime: h.runtime });
  assert.equal(out.ok, true, "the guest's money went back; only the fee refund waits");
  assert.equal(eventpay.paymentRow(row.id).fee_back_owed_cents, 63);
  const swept = await eventpay.sweep();
  assert.equal(swept.fees_back, 1);
  assert.equal(eventpay.paymentRow(row.id).fee_back_owed_cents, 0);
  const tries = calls.filter(c => c.path.startsWith("/v1/application_fees/"));
  assert.equal(tries.length, 2);
  assert.notEqual(tries[0].idem, tries[1].idem, "a retry after Stripe's no is a new request, not the replayed no");
  assert.equal((await eventpay.sweep()).fees_back, 0, "nothing owed, nothing asked");
  assert.equal(calls.filter(c => c.path.startsWith("/v1/application_fees/")).length, 2);
});

test("a refund Stripe may have done (a 5xx, no answer) is retried under the same key; a definite no moves it on; a double cancel owes the fee once", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaPays(h, ev);
  failNext = "/v1/refunds"; failStatus = 500;
  assert.equal((await eventpay.guestRefund({ ev: db.getEventRow(ev.id), conversationId: C.ama, runtime: h.runtime })).ok, false);
  failNext = "/v1/refunds"; failStatus = 402;
  assert.equal((await eventpay.guestRefund({ ev: db.getEventRow(ev.id), conversationId: C.ama, runtime: h.runtime })).ok, false);
  const keys = calls.filter(c => c.path === "/v1/refunds").map(c => c.idem);
  assert.equal(keys[0], keys[1], "after a 5xx the retry replays: Stripe never refunds twice");
  // Now two cancels at once (a double tap): one refund, Reason's 2.5% owed once, one text.
  h.channel.sent.length = 0;
  const [a, b] = await Promise.all([1, 2].map(() => eventpay.guestRefund({ ev: db.getEventRow(ev.id), conversationId: C.ama, runtime: h.runtime })));
  assert.ok(a.ok || b.ok);
  await settle();
  assert.notEqual(calls.filter(c => c.path === "/v1/refunds").at(-1).idem, keys[0], "the definite no moved the key on");
  assert.equal(new Set(calls.filter(c => c.path === "/v1/refunds").slice(2).map(c => c.idem)).size, 1, "both taps carry one key");
  assert.equal(calls.filter(c => c.path.startsWith("/v1/application_fees/")).length, 1);
  assert.equal(calls.filter(c => c.path.startsWith("/v1/application_fees/")).at(-1).form.amount, "63");
  assert.equal(eventpay.paymentRow(row.id).fee_back_owed_cents, 0);
  assert.equal(sentTo(h, AMA).filter(t => /is cancelled and you're off its guest list/.test(t)).length, 1);
});

test("next payout when there isn't one: clearing, ready, nothing, Stripe down, payouts not set up — never a made-up date", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  balance = { available: [], pending: [{ amount: 2437, currency: "usd" }] };
  let info = await eventpay.payoutInfo(OWNER_C, { fresh: true });
  assert.match(eventpay.payoutLine(info), /^None scheduled yet — \$24\.37 is still clearing at Stripe/);
  balance = { available: [{ amount: 500, currency: "usd" }], pending: [] };
  info = await eventpay.payoutInfo(OWNER_C, { fresh: true });
  assert.match(eventpay.payoutLine(info), /\$5 is ready and goes out on Stripe's next payout/);
  balance = { available: [], pending: [] };
  info = await eventpay.payoutInfo(OWNER_C, { fresh: true });
  assert.equal(eventpay.payoutLine(info), "Not available yet — nothing is waiting to be paid out.");
  payoutFail = true;
  info = await eventpay.payoutInfo(OWNER_C, { fresh: true });
  assert.equal(info.ok, false);
  assert.match(eventpay.payoutLine(info), /^Not available right now — Stripe didn't answer/);
  assert.equal((await eventpay.payoutInfo(C.kofi)).why, "no_account");
  assert.match(eventpay.payoutLine({ ok: false, why: "no_account" }), /^Not available yet/);
  const st = await tool("event_payouts", { event_id: ev.id, action: "status" }, OWNER_C, h.runtime);
  assert.match(st.say, /^No tickets sold yet for Supper Club\.$/);
});

// ---------- review notes ----------

test("leaving first keeps the ticket: the leave says it wasn't refunded and offers it; the refund still goes through by text", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaPays(h, ev);
  const left = await tool("event_leave", { event_id: ev.id }, C.ama, h.runtime);
  assert.equal(left.ok, true);
  assert.match(left.note, /They paid \$26\.06, and leaving doesn't refund it\. The refund policy allows a refund right now/);
  assert.equal(toolsFor(C.ama).some(t => t.name === "event_ticket_refund"), true, "still holds a ticket");
  const done = await withYes(runTool, "event_ticket_refund", { event_id: ev.id }, { conversationId: C.ama, messages: [], events: h.runtime });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
});

test("a hidden start time: 'started' is said as 'closed', and whether a refund is open now isn't in the guest's view", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { show_time_on_join: false } });
  await amaPays(h, ev);
  assert.equal(db.getEventRow(ev.id).time_released, 0);
  const info = await tool("event_info", { event_id: ev.id }, C.ama, h.runtime);
  assert.equal(info.you.can_ask_for_refund_now, undefined);
  startsIn(ev, -HOUR);
  const asked = await tool("event_ticket_refund", { event_id: ev.id }, C.ama, h.runtime);
  assert.match(asked.error, /refund window for Supper Club has closed/);
  assert.doesNotMatch(asked.error, /already started/);
});

test("the page's refund is off with the switch: REASON_PAID_EVENTS off → 404", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await amaPays(h, ev);
  config.paidEvents = false;
  const r = await req(h, ev, { sub: "refund", method: "POST", body: "step=do", cookie: COOKIE.ama });
  assert.equal(r.status, 404);
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, 0);
});
