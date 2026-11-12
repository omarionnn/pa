// Buy for friends (owner decision 2026-11-11, src/eventpay.js seats): a buyer gets up to N tickets in
// one Checkout and each friend shows up as THEIR OWN guest — never a "+2" on the buyer. Pinned:
//
//   - quantity: the join page's "How many tickets?" / event_join tickets → one Checkout, quantity N
//     on both lines, Reason's fee N times one ticket's; the 15-minute hold holds N places; the
//     organizer's per-buyer max (default 4, 1 = off);
//   - seats: on payment the buyer is in (seat 0) and each other ticket is an open seat with its own
//     claim link (32-char secret), texted one per message and shown on their page;
//   - claim: the link opens a page (no password) → name + required questions → signed in: on now;
//     otherwise the usual one text proves the phone. Single-use; a new link kills the old one; never
//     claimed by somebody already in, the organizer or somebody taken off;
//   - capacity: unclaimed seats hold their places for every other join; claiming takes its own;
//   - refunds per seat (partial refunds of the buyer's one payment, amount = one ticket, transfer and
//     fee reversed): buyer gives back an unclaimed seat under the policy; a friend gives back theirs
//     (money to the buyer's card); organizer any seat; a cancellation refunds everything;
//   - the sales summary counts tickets; the organizer's pages show friends as guests and unclaimed seats;
//   - the one optional text to a friend's number: only somebody Reason can reach, once, not at night.
//
// Stripe is a fake on this machine (STRIPE_API_BASE); nothing here reaches the network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { withYes } from "./fixture-yes.js";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-buy-friends-"));
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
    DELETE FROM confirmations; DELETE FROM event_seats; DELETE FROM event_questions; DELETE FROM event_answers;`);
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



/** The webhook for a payment of N tickets: Stripe's amount_total is for all of them. */
const paidFor = (h, row, extra = {}) => webhook(h, "checkout.session.completed", { id: row.checkout_session_id, object: "checkout.session", payment_status: "paid", payment_intent: `pi_fake_${row.id}`, amount_total: row.total_cents * (row.quantity ?? 1), client_reference_id: `evpay:${row.id}`, metadata: { reason_kind: "event_ticket", event_payment_id: String(row.id) } }, extra);
/** Ama buys `n` tickets by text and pays; returns her payment row. */
async function amaBuys(h, ev, n = 3, who = C.ama) {
  const out = await tool("event_join", { name: ev.name, password: "truffle", tickets: n }, who, h.runtime);
  assert.equal(out.payment_required, true, JSON.stringify(out));
  const row = db.db.prepare("SELECT * FROM event_payments WHERE event_id = ? AND conversation_id = ? ORDER BY id DESC").get(ev.id, who);
  await paidFor(h, row);
  await settle();
  return eventpay.paymentRow(row.id);
}
const seatSub = (st) => `seat/${st.claim_token}`;
const openSeatsOf = (ev) => eventpay.openSeats(ev.id);

test("quantity: one Checkout for N tickets, quantity N on both lines, Reason's fee N times; the hold holds N places; the per-buyer max", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { capacity: 5 } });
  const out = await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 3 }, C.ama, h.runtime);
  assert.equal(out.payment_required, true, JSON.stringify(out));
  assert.equal(out.tickets, 3);
  assert.equal(out.total_for_all, "$78.18");
  const cs = lastCall("/v1/checkout/sessions");
  assert.equal(cs.form["line_items[0][quantity]"], "3");
  assert.equal(cs.form["line_items[1][quantity]"], "3");
  assert.equal(cs.form["line_items[0][price_data][unit_amount]"], "2500");
  assert.equal(cs.form["payment_intent_data[application_fee_amount]"], String(eventpay.quote(2500).application_fee * 3));
  assert.equal(eventpay.openHolds(ev.id), 3, "the hold is for three places");
  assert.equal(eventpay.spotsLeft(db.getEventRow(ev.id)), 2);
  // Asked again for the same number: the same page. For another number: the old page goes, a new one comes.
  const again = await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 3 }, C.ama, h.runtime);
  assert.equal(again.pay_link, out.pay_link);
  const two = await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 2 }, C.ama, h.runtime);
  assert.notEqual(two.pay_link, out.pay_link);
  assert.equal(eventpay.openHolds(ev.id), 2);
  // Kofi wants 4 with 3 left: told how many are left, nothing made.
  const kofi = await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 4 }, C.kofi, h.runtime);
  assert.equal(kofi.ok, false);
  assert.match(kofi.error, /Only 3 spots are left, not 4/);
  // The organizer's max: 2 per person; 3 is refused; 1 turns tickets for friends off (no picker on the page).
  const set = await tool("event_price", { event_id: ev.id, max_tickets: 2 }, OWNER_C, h.runtime);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(eventpay.ticketMax(db.getEventRow(ev.id)), 2);
  const many = await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 3 }, C.yaw, h.runtime);
  assert.equal(many.reason, "too_many");
  const page2 = await req(h, db.getEventRow(ev.id));
  assert.match(page2.body, /HOW MANY TICKETS\?|How many tickets\?/);
  assert.match(page2.body, /2 — me \+ 1 friend \(\$52\.12\)/);
  await tool("event_price", { event_id: ev.id, max_tickets: 1 }, OWNER_C, h.runtime);
  const page1 = await req(h, db.getEventRow(ev.id));
  assert.doesNotMatch(page1.body, /HOW MANY TICKETS|How many tickets/);
});

test("seats: paid for 3 → the buyer is in, two open seats with their own single-use links, texted one per message; unclaimed seats hold places", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { capacity: 4 } });
  const row = await amaBuys(h, ev, 3);
  assert.equal(row.status, "paid");
  assert.equal(row.quantity, 3);
  assert.equal(row.total_cents, 2606, "per-ticket total kept on the row");
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "joined");
  const seats = eventpay.seatsOfPayment(row.id);
  assert.deepEqual(seats.map(s => [s.seat_no, s.state]), [[0, "claimed"], [1, "open"], [2, "open"]]);
  for (const s of seats.slice(1)) assert.match(s.claim_token, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(seats[1].claim_token, seats[2].claim_token);
  const got = sentTo(h, AMA);
  assert.ok(got.some(t => /^paid \$78\.18 for 3 tickets to Supper Club — you're in, and the other 2 are for your friends/.test(t)), JSON.stringify(got));
  assert.ok(got.some(t => /here are your 2 tickets for friends — send each friend one link/.test(t)));
  for (const s of seats.slice(1)) assert.ok(got.includes(`https://events.example.test/e/${ev.public_id}/seat/${s.claim_token}`), "each link is its own message");
  // Capacity 4: 1 in + 2 unclaimed = 3; one place left for anybody else, by any route.
  assert.equal(eventpay.unclaimedSeats(ev.id), 2);
  assert.equal(eventpay.spotsLeft(db.getEventRow(ev.id)), 1);
  const kofi = await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 2 }, C.kofi, h.runtime);
  assert.match(kofi.error, /Only 1 spot is left/);
  // The free-join path counts unclaimed seats too (an event made free while seats are out).
  await tool("event_price", { event_id: ev.id, free: true }, OWNER_C, h.runtime);
  assert.equal(db.addAttendee({ eventId: ev.id, conversationId: C.kofi, displayName: "Kofi", via: "text" }).ok, true);
  assert.equal(db.addAttendee({ eventId: ev.id, conversationId: C.yaw, displayName: "Yaw", via: "text" }).reason, "full", "the two unclaimed seats are spoken for");
  // Buyer's own view: the links on their page and in event_info.
  const info = events.viewFor(C.ama, ev.id);
  assert.equal(info.you.tickets_for_friends.length, 2);
  assert.match(info.you.tickets_for_friends[0].link, /\/seat\/[A-Za-z0-9_-]{32}$/);
  const mine = await req(h, ev, { cookie: COOKIE.ama });
  assert.match(mine.body, /TICKETS FOR FRIENDS|Tickets for friends/);
  assert.match(mine.body, /Text it to a friend/);
  assert.ok(mine.body.includes(seats[1].claim_token));
  // The sales summary counts tickets, not payments.
  const s = eventpay.summary(db.getEventRow(ev.id));
  assert.equal(s.sold_count, 3);
  assert.equal(s.paid_count, 3);
  assert.equal(s.unclaimed_count, 2);
  assert.equal(s.gross_cents, 7500);
  assert.equal(s.organizer_net_cents, 3 * eventpay.quote(2500).organizer_gets);
});

test("claim by a signed-in friend on the page: own guest, own spot, the link is spent; already-in, buyer, organizer and removed never spend it", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { capacity: 3 } });
  const row = await amaBuys(h, ev, 3);
  const [s1, s2] = eventpay.seatsOfPayment(row.id).slice(1);
  // Nonsense and made-up tokens: the same plain 404.
  assert.equal((await req(h, ev, { sub: "seat/" + "x".repeat(32) })).status, 404);
  assert.equal(eventpay.seatByToken("short"), null);
  // The buyer opening their own link, and the organizer: shown, never spent.
  const own = await req(h, ev, { sub: seatSub(s1), cookie: COOKIE.ama });
  assert.match(unesc(own.body), /a ticket you got for a friend/);
  const org = await req(h, ev, { sub: seatSub(s1), cookie: COOKIE.owner });
  assert.match(unesc(org.body), /for them to claim/);
  assert.equal(eventpay.seatById(s1.id).state, "open");
  // Kofi, signed in: sees who got it for him, no price, no password; claims.
  const look = await req(h, ev, { sub: seatSub(s1), cookie: COOKIE.kofi });
  assert.equal(look.status, 200);
  assert.match(unesc(look.body), /Ama got you a ticket — it's already paid for/);
  assert.doesNotMatch(look.body, /Event password/);
  assert.doesNotMatch(look.body, /<b>Price:<\/b>/);
  assert.match(look.body, /You&#39;ve got a ticket\. Tap to claim it\.|You've got a ticket\. Tap to claim it\./, "the link's card says a ticket is waiting, never a name");
  h.channel.sent.length = 0;
  const claimed = await req(h, ev, { sub: seatSub(s1), method: "POST", body: form({ instagram: "@kofi", in_directory: "1" }), cookie: COOKIE.kofi });
  assert.equal(claimed.status, 303, claimed.body);
  await settle();
  const k = db.attendeeRow(ev.id, C.kofi);
  assert.equal(k.state, "joined");
  assert.equal(k.via, "seat");
  assert.equal(eventpay.seatById(s1.id).state, "claimed");
  assert.equal(eventpay.seatById(s1.id).holder_conversation_id, C.kofi);
  assert.equal(eventpay.seatById(s1.id).claim_token, null, "spent");
  assert.ok(sentTo(h, KOFI).some(t => /you're in for Supper Club/.test(t)), "Kofi gets his own welcome");
  assert.ok(sentTo(h, AMA).some(t => /Kofi claimed the ticket you got them for Supper Club/.test(t)));
  assert.equal(db.joinedCount(ev.id), 2);
  assert.equal(eventpay.unclaimedSeats(ev.id), 1);
  // The spent link: 404 for anybody now.
  assert.equal((await req(h, ev, { sub: seatSub(s1), cookie: COOKIE.kofi })).status, 404);
  // Kofi again on the other seat: already in, so it stays for somebody else.
  const twice = await req(h, ev, { sub: seatSub(s2), method: "POST", body: form({ in_directory: "1" }), cookie: COOKIE.kofi });
  assert.match(unesc(twice.body), /already on this event, so this ticket stays for somebody else/);
  assert.equal(eventpay.seatById(s2.id).state, "open");
  assert.equal(eventpay.claimSeat({ ev, seatId: s2.id, conversationId: C.kofi, displayName: "Kofi" }).reason, "already");
  assert.equal(eventpay.claimSeat({ ev, seatId: s2.id, conversationId: OWNER_C, displayName: "O" }).reason, "organizer");
  // Somebody the organizer took off can't come back on a friend's ticket.
  db.db.prepare("INSERT INTO event_attendees (event_id, conversation_id, display_name, via, token, state, joined_at, updated_at) VALUES (?, ?, 'Yaw', 'text', 'tok-yaw-removed-0001', 'removed', ?, ?)").run(ev.id, C.yaw, clock.now(), clock.now());
  assert.equal(eventpay.claimSeat({ ev, seatId: s2.id, conversationId: C.yaw, displayName: "Yaw" }).reason, "removed");
  // A full event: Kofi's claim took his own seat's place, so the cap (3) is exactly met once the last seat goes.
  assert.equal(eventpay.claimSeat({ ev, seatId: s2.id, conversationId: C.esi, displayName: "Esi" }).ok, true);
  assert.equal(db.joinedCount(ev.id), 3);
  assert.equal(eventpay.spotsLeft(db.getEventRow(ev.id)), 0);
});

test("claim by a new friend: page (required question enforced) → one text proves the phone → on the event, no payment link; a new link kills the old claim", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  // Ama bought before the organizer added a required question: her friends are asked it when they claim.
  const row = await amaBuys(h, ev, 3, C.ama);
  const qq = await tool("event_questions", { event_id: ev.id, action: "add", prompt: "Any allergies?", kind: "text", required: true }, OWNER_C, h.runtime);
  const added = qq.ok ? qq : await withYes(runTool, "event_questions", { event_id: ev.id, action: "add", prompt: "Any allergies?", kind: "text", required: true }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(added.ok, true, JSON.stringify(added));
  const q = db.eventQuestions(ev.id)[0];
  const [s1, s2] = eventpay.seatsOfPayment(row.id).slice(1);
  const page = await req(h, ev, { sub: seatSub(s1) });
  assert.match(page.body, /Any allergies\?/);
  const blank = await req(h, ev, { sub: seatSub(s1), method: "POST", body: form({ display_name: "Esi N", in_directory: "1" }) });
  assert.match(unesc(blank.body), /the host asks everyone this one before they're in/);
  const ok = await req(h, ev, { sub: seatSub(s1), method: "POST", body: form({ display_name: "Esi N", in_directory: "1", [`q_${q.id}`]: "peanuts" }) });
  assert.match(ok.body, /Text Reason to claim it/);
  assert.doesNotMatch(ok.body, /payment link/);
  const codeText = decodeURIComponent(unesc(/href="(sms:[^"]+)"/.exec(ok.body)[1]).split("body=")[1]);
  assert.match(codeText, /I'm claiming my ticket to Supper Club with code/);
  h.channel.sent.length = 0;
  await h.router.deliver(texts(NEW1, codeText));
  await settle();
  const conv = db.accountByAddress("fake", NEW1)?.conversation_id;
  assert.ok(conv);
  const att = db.attendeeRow(ev.id, conv);
  assert.equal(att.state, "joined");
  assert.equal(att.display_name, "Esi N");
  assert.equal(db.answersOf(ev.id, att.id)[0]?.answer, "peanuts", "the required answer is filed");
  assert.equal(eventpay.seatById(s1.id).holder_conversation_id, conv);
  assert.ok(!sentTo(h, NEW1).some(t => /checkout\.stripe/.test(t)), "a friend never gets a payment link");
  assert.equal(calls.filter(c => c.path === "/v1/checkout/sessions").length, 1, "only Ama's Checkout");
  // The same code again: spent.
  await h.router.deliver(texts(NEW1, codeText));
  await settle();
  assert.equal(db.joinedCount(ev.id), 2);
  // Seat 2: a claim begun on the old link, then the buyer makes a new link → the text claims nothing.
  const p2 = await req(h, ev, { sub: seatSub(s2), method: "POST", body: form({ display_name: "Someone", [`q_${q.id}`]: "none" }) });
  const code2 = decodeURIComponent(unesc(/href="(sms:[^"]+)"/.exec(p2.body)[1]).split("body=")[1]);
  const moved = await tool("event_seats", { event_id: ev.id, action: "new_link", seat_id: s2.id }, C.ama, h.runtime);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.notEqual(moved.new_link, `https://events.example.test/e/${ev.public_id}/seat/${s2.claim_token}`);
  assert.equal((await req(h, ev, { sub: seatSub(s2) })).status, 404, "the old link stopped working");
  h.channel.sent.length = 0;
  await h.router.deliver(texts("+16465550102", code2));
  await settle();
  assert.ok(sentTo(h, "+16465550102").some(t => /changed its link/.test(t)), JSON.stringify(h.channel.sent));
  assert.equal(eventpay.seatById(s2.id).state, "open");
  assert.equal(eventpay.seatById(s2.id).version, 2);
});

test("refunds per seat: the buyer gives back an unclaimed seat (partial, one ticket, behind the yes); a friend gives back theirs (money to the buyer's card); the last ticket closes the payment", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaBuys(h, ev, 3);
  const [s1, s2] = eventpay.seatsOfPayment(row.id).slice(1);
  eventpay.claimSeat({ ev, seatId: s1.id, conversationId: C.kofi, displayName: "Kofi" });
  // The buyer: an unclaimed seat, behind the yes, pinned to the seat.
  const unasked = await tool("event_seats", { event_id: ev.id, action: "refund", seat_id: s2.id }, C.ama, h.runtime);
  assert.equal(unasked.blocked, "needs_confirmation", JSON.stringify(unasked));
  assert.match(unasked.use_target, new RegExp(`^give back the unclaimed ticket ${s2.id} for Supper Club \\(event #${ev.id}\\): \\$25\\.00 back \\[seat ${s2.id} v1\\]$`));
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, 0);
  // A claimed seat isn't the buyer's to give back.
  const claimedOne = await tool("event_seats", { event_id: ev.id, action: "refund", seat_id: s1.id }, C.ama, h.runtime);
  assert.match(claimedOne.error, /already claimed that one/);
  h.channel.sent.length = 0;
  const done = await withYes(runTool, "event_seats", { event_id: ev.id, action: "refund", seat_id: s2.id }, { conversationId: C.ama, messages: [], events: h.runtime });
  assert.equal(done.ok, true, JSON.stringify(done));
  await settle();
  // The buyer's own give-back is a guest's cancel (owner decision 2026-11-11): the price, not the processing.
  let rf = lastCall("/v1/refunds");
  assert.equal(rf.form.amount, "2500", "one ticket's price");
  assert.equal(rf.form.reverse_transfer, "true");
  assert.equal(rf.form.refund_application_fee, "false");
  assert.equal(rf.idem, `evrefund:${row.id}:s${s2.id}:0p`);
  assert.equal(lastCall("/v1/application_fees/").form.amount, "63", "Reason's 2.5% of one ticket back to the organizer");
  assert.equal(eventpay.seatById(s2.id).state, "refunded");
  assert.equal(eventpay.seatById(s2.id).claim_token, null);
  assert.equal(eventpay.paymentRow(row.id).status, "paid", "the other tickets stand");
  assert.equal(eventpay.paymentRow(row.id).refunded_cents, 2500);
  assert.equal(eventpay.paymentRow(row.id).fee_back_owed_cents, 0);
  assert.ok(sentTo(h, AMA).some(t => /the unclaimed ticket for Supper Club is refunded.*\$25\.00 is on its way back to your card \(the \$1\.06 processing fee isn't refundable\)/.test(t)), JSON.stringify(sentTo(h, AMA)));
  assert.ok(sentTo(h, OWNER).some(t => /Ama gave back a ticket they'd bought for a friend/.test(t)));
  // The friend: their own ticket, under the policy; the money goes to Ama's card.
  const kofiAsk = await tool("event_ticket_refund", { event_id: ev.id }, C.kofi, h.runtime);
  assert.equal(kofiAsk.blocked, "needs_confirmation", JSON.stringify(kofiAsk));
  assert.match(kofiAsk.use_target, new RegExp(`\\[pay ${row.id}/${s1.id}\\]$`));
  h.channel.sent.length = 0;
  const kofiDone = await withYes(runTool, "event_ticket_refund", { event_id: ev.id }, { conversationId: C.kofi, messages: [], events: h.runtime });
  assert.equal(kofiDone.ok, true, JSON.stringify(kofiDone));
  assert.equal(kofiDone.given_back, "$25.00");
  assert.equal(kofiDone.not_refunded, "$25.00 back; the $1.06 processing fee isn't refundable.");
  await settle();
  rf = lastCall("/v1/refunds");
  assert.equal(rf.form.amount, "2500");
  assert.equal(db.attendeeRow(ev.id, C.kofi).state, "left");
  assert.ok(sentTo(h, KOFI).some(t => /the ticket Ama got you for Supper Club is given back.*Ama's card gets \$25\.00 back; the \$1\.06 processing fee isn't refundable, since they paid for it/.test(t)), JSON.stringify(sentTo(h, KOFI)));
  assert.ok(sentTo(h, AMA).some(t => /Kofi gave back the ticket you got them for Supper Club/.test(t)), JSON.stringify(sentTo(h, AMA)));
  assert.ok(sentTo(h, OWNER).some(t => /Kofi gave back their ticket to Supper Club under your refund policy; the \$25\.00 ticket price went back to the card of the friend who bought it/.test(t)));
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "joined", "the buyer's own ticket stands");
  // Ama's own, the last one standing: still a named amount (two already went back), and the payment closes.
  await withYes(runTool, "event_ticket_refund", { event_id: ev.id }, { conversationId: C.ama, messages: [], events: h.runtime });
  await settle();
  rf = lastCall("/v1/refunds");
  assert.equal(rf.form.amount, "2500");
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  assert.equal(eventpay.paymentRow(row.id).refunded_cents, 3 * 2500);
  assert.equal(calls.filter(c => c.path.startsWith("/v1/application_fees/")).length, 3, "Reason's 2.5% back on each");
  const s = eventpay.summary(db.getEventRow(ev.id));
  assert.deepEqual([s.sold_count, s.paid_count, s.refunded_count, s.gross_cents, s.refunded_cents, s.organizer_net_cents, s.returned_cents], [3, 0, 3, 7500, 7500, 0, 7500]);
  // The organizer, played as Stripe moves it: 3 × $24.37 in, 3 × $25.00 reversed, 3 × $0.63 fee back = $0.
  assert.equal(3 * (7818 / 3 - 169) - 3 * 2500 + 3 * 63, 0);
  // Stripe's charge.refunded for the whole charge now: the payment is already refunded, nothing more happens.
  h.channel.sent.length = 0;
  await webhook(h, "charge.refunded", { id: "ch_1", object: "charge", payment_intent: `pi_fake_${row.id}`, amount: 7818, amount_refunded: 7818, refunded: true });
  await settle();
  assert.equal(h.channel.sent.length, 0);
});

test("refund rules: a seat outside the policy is refused before any yes; the organizer refunds any seat (unclaimed by seat_id); a partial charge.refunded is ignored; a refund in flight is ours", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  await tool("event_price", { event_id: ev.id, refund_policy: "none" }, OWNER_C, h.runtime);
  const row = await amaBuys(h, db.getEventRow(ev.id), 3);
  const [s1, s2] = eventpay.seatsOfPayment(row.id).slice(1);
  const no = await tool("event_seats", { event_id: ev.id, action: "refund", seat_id: s1.id }, C.ama, h.runtime);
  assert.equal(no.reason, "refund_not_allowed");
  assert.equal(no.use_target, undefined);
  // The organizer ignores the policy: an unclaimed seat by seat_id, behind their yes.
  const ask = await tool("event_refund", { event_id: ev.id, seat_id: s1.id }, OWNER_C, h.runtime);
  assert.equal(ask.blocked, "needs_confirmation", JSON.stringify(ask));
  assert.match(ask.use_target, new RegExp(`^refund \\$26\\.06 unclaimed ticket bought by Ama for Supper Club \\(event #${ev.id}\\) \\[seat ${s1.id} v1\\]$`));
  h.channel.sent.length = 0;
  const done = await withYes(runTool, "event_refund", { event_id: ev.id, seat_id: s1.id }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(done.ok, true, JSON.stringify(done));
  await settle();
  assert.equal(eventpay.seatById(s1.id).state, "refunded");
  assert.ok(sentTo(h, AMA).some(t => /the organizer refunded one of the tickets you got for friends/.test(t)), JSON.stringify(sentTo(h, AMA)));
  // A friend's claimed seat by guest_id: the friend leaves; the money is Ama's.
  eventpay.claimSeat({ ev, seatId: s2.id, conversationId: C.kofi, displayName: "Kofi" });
  h.channel.sent.length = 0;
  const kofiOut = await withYes(runTool, "event_refund", { event_id: ev.id, guest_id: db.attendeeRow(ev.id, C.kofi).id }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(kofiOut.ok, true, JSON.stringify(kofiOut));
  await settle();
  assert.equal(db.attendeeRow(ev.id, C.kofi).state, "left");
  assert.ok(sentTo(h, KOFI).some(t => /the organizer refunded the ticket Ama got you for Supper Club.*goes back to Ama's card/.test(t)));
  assert.ok(sentTo(h, AMA).some(t => /the organizer refunded the ticket you got Kofi for Supper Club/.test(t)));
  assert.equal(db.attendeeRow(ev.id, C.ama).state, "joined");
  // Stripe's charge.refunded for part of the charge: ignored (the seats are ours to count).
  await webhook(h, "charge.refunded", { id: "ch_1", object: "charge", payment_intent: `pi_fake_${row.id}`, amount: 7818, amount_refunded: 5212, refunded: false });
  assert.equal(eventpay.paymentRow(row.id).status, "paid");
  // A refund of ours in flight (its seat marked) when the full-charge webhook beats our own answer: left to us.
  const own = eventpay.seatsOfPayment(row.id)[0];
  db.db.prepare("UPDATE event_seats SET refunding_at = ? WHERE id = ?").run(clock.now(), own.id);
  const r = await webhook(h, "charge.refunded", { id: "ch_1", object: "charge", payment_intent: `pi_fake_${row.id}`, amount: 7818, amount_refunded: 7818, refunded: true });
  assert.equal(r.status, 200);
  assert.equal(eventpay.seatById(own.id).state, "claimed", "not taken by the webhook");
});

test("cancelling refunds everything: one refund per payment for what still stands; every holder told, friends told it went to the buyer", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaBuys(h, ev, 3);
  const [s1, s2] = eventpay.seatsOfPayment(row.id).slice(1);
  eventpay.claimSeat({ ev, seatId: s1.id, conversationId: C.kofi, displayName: "Kofi" });
  await withYes(runTool, "event_seats", { event_id: ev.id, action: "refund", seat_id: s2.id }, { conversationId: C.ama, messages: [], events: h.runtime });
  h.channel.sent.length = 0;
  const out = await tool("event_cancel", { event_id: ev.id }, OWNER_C, h.runtime);
  assert.equal(out.ok, true, JSON.stringify(out));
  await settle();
  const rf = lastCall("/v1/refunds");
  assert.equal(rf.form.amount, String(2 * 2606), "what still stood: Ama's and Kofi's");
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  assert.ok(sentTo(h, KOFI).some(t => /Supper Club is cancelled, so the ticket Ama got you was refunded to their card/.test(t)), JSON.stringify(sentTo(h, KOFI)));
  assert.ok(sentTo(h, AMA).some(t => /Supper Club is cancelled, so your \$52\.12 has been refunded in full/.test(t)), JSON.stringify(sentTo(h, AMA)));
  // A whole payment never partly refunded goes back without an amount (the whole charge).
  const h2 = harness();
  const ev2 = await pricedEvent(h2, { over: { name: "Brunch Club", password: "truffle" } });
  const row2 = await amaBuys(h2, ev2, 2, C.yaw);
  await tool("event_cancel", { event_id: ev2.id }, OWNER_C, h2.runtime);
  await settle();
  const rf2 = lastCall("/v1/refunds");
  assert.equal(rf2.form.payment_intent, `pi_fake_${row2.id}`);
  assert.equal(rf2.form.amount, undefined);
});

test("a payment for N that lands with no room for all N goes straight back in full; nobody is half in", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { capacity: 3 } });
  await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 3 }, C.ama, h.runtime);
  const row = db.db.prepare("SELECT * FROM event_payments WHERE conversation_id = ?").get(C.ama);
  // The hold runs out; Kofi takes a place; Ama's late payment lands.
  clock.skip(16 * MIN);
  await eventpay.sweep({ log: () => {} });
  await tool("event_price", { event_id: ev.id, free: true }, OWNER_C, h.runtime);
  db.addAttendee({ eventId: ev.id, conversationId: C.kofi, displayName: "Kofi", via: "text" });
  h.channel.sent.length = 0;
  await paidFor(h, row);
  await settle();
  assert.equal(eventpay.paymentRow(row.id).status, "refunded");
  assert.equal(lastCall("/v1/refunds").form.amount, undefined, "the whole charge");
  assert.equal(db.attendeeRow(ev.id, C.ama), null);
  assert.equal(eventpay.seatsOfPayment(row.id).length, 0);
  assert.ok(sentTo(h, AMA).some(t => /didn't have room for all your tickets.*refunded your \$78\.18 in full/.test(t)), JSON.stringify(sentTo(h, AMA)));
  // A later boot never makes a seat for it: that would count a sale that never happened (review 2026-11-11).
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../src/eventpay.js", import.meta.url).href)}); process.exit(0)`], { env: process.env, stdio: "pipe" });
  assert.equal(eventpay.seatsOfPayment(row.id).length, 0, "no seat 0 on the next boot");
  assert.equal(eventpay.summary(db.getEventRow(ev.id)).sold_count, 0);
});

test("seat refunds Stripe may have done (a 5xx) retry under the same key; a refund of a seat already in flight is refused, not sent twice", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaBuys(h, ev, 3);
  const [, s1, s2] = eventpay.seatsOfPayment(row.id);
  failNext = "/v1/refunds"; failStatus = 500;
  assert.equal((await eventpay.refund({ ev: db.getEventRow(ev.id), seat: s1, why: "organizer", runtime: h.runtime })).ok, false);
  assert.equal((await eventpay.refund({ ev: db.getEventRow(ev.id), seat: s1, why: "organizer", runtime: h.runtime })).ok, true);
  const keys = calls.filter(c => c.path === "/v1/refunds").map(c => c.idem);
  assert.equal(keys[0], keys[1], "the retry replays the first: never two refunds for one seat");
  // Two refunds of one seat at the same moment (the buyer's give-back and the organizer's): one goes to Stripe.
  const before = calls.filter(c => c.path === "/v1/refunds").length;
  const [a, b] = await Promise.all([
    eventpay.seatRefund({ ev: db.getEventRow(ev.id), buyerConversationId: C.ama, seatId: s2.id, runtime: h.runtime }),
    eventpay.refund({ ev: db.getEventRow(ev.id), seat: eventpay.seatById(s2.id), why: "organizer", runtime: h.runtime }),
  ]);
  await settle();
  assert.equal(calls.filter(c => c.path === "/v1/refunds").length, before + 1, JSON.stringify([a, b]));
  assert.equal([a, b].filter(x => x.ok).length, 1);
  assert.equal(eventpay.seatById(s2.id).state, "refunded");
});

test("a guest's cancel Stripe may have done (5xx) stays pending: the organizer's refund of that seat replays it (same key, the guest's amount), another seat waits, the sweep finishes one left alone", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaBuys(h, ev, 3);
  const [, s1, s2] = eventpay.seatsOfPayment(row.id);
  eventpay.claimSeat({ ev, seatId: s1.id, conversationId: C.kofi, displayName: "Kofi" });
  failNext = "/v1/refunds"; failStatus = 500;
  const kofi = await eventpay.guestRefund({ ev: db.getEventRow(ev.id), conversationId: C.kofi, runtime: h.runtime });
  assert.equal(kofi.ok, false);
  assert.ok(eventpay.paymentRow(row.id).refund_pending, "left pending: Stripe may have done it");
  const first = calls.filter(c => c.path === "/v1/refunds").at(-1);
  // Another seat on the payment waits; the organizer's refund of Kofi's seat asks exactly what the guest's did.
  assert.equal((await eventpay.refund({ ev: db.getEventRow(ev.id), seat: eventpay.seatById(s2.id), why: "organizer", runtime: h.runtime })).reason, "busy");
  const org = await eventpay.refund({ ev: db.getEventRow(ev.id), seat: eventpay.seatById(s1.id), why: "organizer", runtime: h.runtime });
  assert.equal(org.ok, true, JSON.stringify(org));
  const replay = calls.filter(c => c.path === "/v1/refunds").at(-1);
  assert.equal(replay.idem, first.idem, "Stripe replays the first refund: never two for one seat");
  assert.equal(replay.form.amount, "2500");
  assert.equal(eventpay.paymentRow(row.id).refund_pending, null);
  assert.equal(eventpay.seatById(s1.id).state, "refunded");
  // One left alone: the sweep asks again after a minute and finishes it (the guest leaves and is told).
  failNext = "/v1/refunds"; failStatus = 500;
  assert.equal((await eventpay.seatRefund({ ev: db.getEventRow(ev.id), buyerConversationId: C.ama, seatId: s2.id, runtime: h.runtime })).ok, false);
  const left = calls.filter(c => c.path === "/v1/refunds").at(-1);
  clock.skip(2 * MIN);
  const swept = await eventpay.sweep({ runtime: h.runtime });
  assert.equal(swept.refunds_settled, 1, JSON.stringify(swept));
  assert.equal(calls.filter(c => c.path === "/v1/refunds").at(-1).idem, left.idem);
  assert.equal(eventpay.seatById(s2.id).state, "refunded");
  assert.equal(eventpay.paymentRow(row.id).fee_back_owed_cents, 0, "Reason's 2.5% went back on both");
});

test("the one text to a friend's number: only somebody Reason can reach, once, not at night, link as its own message; the buyer is told the same either way", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaBuys(h, ev, 3);
  const [s1, s2] = eventpay.seatsOfPayment(row.id).slice(1);
  const ask = await tool("event_seats", { event_id: ev.id, action: "send", seat_id: s1.id, number: YAW }, C.ama, h.runtime);
  assert.equal(ask.blocked, "needs_confirmation", JSON.stringify(ask));
  assert.match(ask.use_target, /^text \+13475550002 the ticket/);
  const yes = await withYes(runTool, "event_seats", { event_id: ev.id, action: "send", seat_id: s1.id, number: YAW }, { conversationId: C.ama, messages: [], events: h.runtime });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  const stranger = await withYes(runTool, "event_seats", { event_id: ev.id, action: "send", seat_id: s2.id, number: "+19175550199" }, { conversationId: C.ama, messages: [], events: h.runtime });
  assert.equal(stranger.ok, true);
  assert.equal(stranger.note, yes.note, "never says whether the number uses Reason");
  assert.equal(eventpay.seatById(s2.id).invite_state, "unreachable");
  // The buyer's view of both asks is the same, and a second ask on either is refused the same way.
  const listed = await tool("event_seats", { event_id: ev.id, action: "list" }, C.ama, h.runtime);
  assert.deepEqual(listed.tickets_for_friends.map(t => t.they_asked_reason_to_text_it_to_a_friend), [true, true]);
  const again1 = await withYes(runTool, "event_seats", { event_id: ev.id, action: "send", seat_id: s1.id, number: ESI }, { conversationId: C.ama, messages: [], events: h.runtime });
  const again2 = await withYes(runTool, "event_seats", { event_id: ev.id, action: "send", seat_id: s2.id, number: ESI }, { conversationId: C.ama, messages: [], events: h.runtime });
  assert.equal(again1.ok, false);
  assert.equal(again2.error, again1.error);
  // At night in the event's zone: it waits.
  const night = new Date(clock.now()); night.setUTCHours(4, 0, 0, 0);
  const atNight = night.getTime() + 24 * 60 * MIN;
  h.channel.sent.length = 0;
  await eventpay.sweep({ now: atNight, log: () => {}, runtime: h.runtime });
  assert.equal(sentTo(h, YAW).length, 0);
  await eventpay.sweep({ log: () => {}, runtime: h.runtime });
  await settle();
  const got = sentTo(h, YAW);
  assert.ok(got.some(t => /^Ama got you a ticket to Supper Club — it's already paid for/.test(t)), JSON.stringify(got));
  assert.ok(got.includes(`https://events.example.test/e/${ev.public_id}/seat/${s1.claim_token}`));
  assert.equal(eventpay.seatById(s1.id).invite_state, "sent");
  // Never twice.
  await eventpay.sweep({ log: () => {}, runtime: h.runtime });
  await settle();
  assert.equal(sentTo(h, YAW).filter(t => /got you a ticket/.test(t)).length, 1);
  const again = await withYes(runTool, "event_seats", { event_id: ev.id, action: "send", seat_id: s1.id, number: YAW }, { conversationId: C.ama, messages: [], events: h.runtime });
  assert.equal(again.ok, false);
});

test("the organizer's pages: friends are guests with 'ticket from', unclaimed seats are listed and refundable per seat; the join page's picker; the manage page's tickets per person", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const row = await amaBuys(h, ev, 3);
  const [s1, s2] = eventpay.seatsOfPayment(row.id).slice(1);
  eventpay.claimSeat({ ev, seatId: s1.id, conversationId: C.kofi, displayName: "Kofi" });
  const m = await req(h, ev, { cookie: COOKIE.owner });
  const body = unesc(m.body);
  assert.match(body, /WHO HAS A TICKET/);
  assert.match(body, /Not claimed yet<\/b><span>bought by Ama for a friend/);
  assert.match(body, /<b>Kofi<\/b><span>ticket from Ama/);
  assert.match(body, /1 ticket bought for friends hasn't been claimed yet \(Ama\)/);
  assert.match(body, /FOR FRIENDS<\/span><span>1 ticket not claimed yet/);
  assert.match(body, /TICKETS PER PERSON/);
  // Guests by text show the same.
  const g = await tool("event_guests", { event_id: ev.id }, OWNER_C, h.runtime);
  assert.equal(g.guests.find(x => x.display_name === "Kofi").ticket_bought_by, "Ama");
  assert.deepEqual(g.unclaimed_tickets.map(u => u.seat_id), [s2.id]);
  assert.equal(g.tickets.sold, 3);
  // Refund the unclaimed seat from the page: review names the buyer, then done.
  const review = await post(h, ev, { action: "refund", step: "review", seat: String(s2.id) });
  assert.match(unesc(review.body), /Refund the unclaimed ticket Ama bought \$26\.06\?/);
  const done = await post(h, ev, { action: "refund", step: "do", seat: String(s2.id) });
  assert.equal(done.status, 303);
  assert.equal(eventpay.seatById(s2.id).state, "refunded");
  // Tickets per person from the page.
  const set = await post(h, ev, { action: "ticket_max", step: "do", ticket_max: "2" });
  assert.equal(set.status, 303);
  assert.equal(eventpay.ticketMax(db.getEventRow(ev.id)), 2);
});

test("the join page: picking 3 tickets → a signed-in buyer goes to one Checkout for 3; a new buyer's finishing text carries the 3", async () => {
  const h = harness();
  const ev = await pricedEvent(h);
  const out = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "truffle", in_directory: "1", tickets: "3" }), cookie: COOKIE.kofi });
  assert.equal(out.status, 303);
  assert.equal(lastCall("/v1/checkout/sessions").form["line_items[0][quantity]"], "3");
  const page = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "truffle", display_name: "Esi N", in_directory: "1", tickets: "2" }) });
  assert.match(page.body, /\$52\.12 with processing, for 2 tickets/);
  const codeText = decodeURIComponent(unesc(/href="(sms:[^"]+)"/.exec(page.body)[1]).split("body=")[1]);
  await h.router.deliver(texts(NEW1, codeText));
  await settle();
  assert.equal(lastCall("/v1/checkout/sessions").form["line_items[0][quantity]"], "2");
  assert.ok(sentTo(h, NEW1).some(t => /your 2 tickets \(\$52\.12 in all\) are held for 15 minutes/.test(t)), JSON.stringify(sentTo(h, NEW1)));
  // Over the limit from a tampered form: capped at the event's max.
  const big = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "truffle", in_directory: "1", tickets: "40" }), cookie: COOKIE.ama });
  assert.equal(big.status, 303);
  assert.equal(lastCall("/v1/checkout/sessions").form["line_items[0][quantity]"], "4");
});

test("two Checkout pages both paid (another ticket count asked meanwhile): the second lands on somebody already in and goes straight back in full; refused for room, the open page stands", async () => {
  const h = harness();
  const ev = await pricedEvent(h, { over: { capacity: 5 } });
  await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 2 }, C.ama, h.runtime);
  const a = db.db.prepare("SELECT * FROM event_payments WHERE conversation_id = ? ORDER BY id DESC").get(C.ama);
  await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 3 }, C.ama, h.runtime);
  const b = db.db.prepare("SELECT * FROM event_payments WHERE conversation_id = ? ORDER BY id DESC").get(C.ama);
  assert.notEqual(a.id, b.id);
  // Page A was expired on our side, but Stripe took the money anyway; then B lands too.
  await paidFor(h, a);
  await settle();
  h.channel.sent.length = 0;
  await paidFor(h, b);
  await settle();
  assert.equal(eventpay.paymentRow(b.id).status, "refunded", "B bought nothing: straight back");
  assert.equal(lastCall("/v1/refunds").form.payment_intent, `pi_fake_${b.id}`);
  assert.equal(lastCall("/v1/refunds").form.amount, undefined, "the whole charge");
  assert.equal(eventpay.seatsOfPayment(b.id).length, 0);
  assert.equal(eventpay.paymentRow(a.id).status, "paid");
  assert.equal(eventpay.seatsOfPayment(a.id).length, 2);
  assert.ok(sentTo(h, AMA).some(t => /already had you on it, so i've refunded your \$78\.18 in full/.test(t)), JSON.stringify(sentTo(h, AMA)));
  // Refused for room: the page Kofi already has stands.
  await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 2 }, C.kofi, h.runtime);
  const k = eventpay.openRow(ev.id, C.kofi);
  const big = await tool("event_join", { name: "Supper Club", password: "truffle", tickets: 4 }, C.kofi, h.runtime);
  assert.equal(big.ok, false);
  assert.match(big.error, /Only 3 spots are left, not 4/);
  assert.equal(eventpay.openRow(ev.id, C.kofi)?.id, k.id, "the hold he had is kept");
  // The event reads full to joins once unclaimed seats are counted (capacityState).
  assert.equal(events.capacityState(db.getEventRow(ev.id)).held_for_friends, 1);
});
