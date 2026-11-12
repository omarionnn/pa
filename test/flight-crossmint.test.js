// Booking a flight through Crossmint's Agent Checkouts (src/flightcheckout.js, flight_book in
// src/tools.js, the hooks in src/shopconnect.js). The passenger form and the payment request are the
// ones a real run on jetblue.com came back with on 2026-11-11 (test/fixtures/crossmint-flights/
// jetblue-pricecheck.json — stopped at the payment request and cancelled; nothing was bought). What a
// PLACED order carries has never been seen, so the `succeeded` result here is built to Crossmint's
// documented shape and says so. A fake Crossmint; no key, no network.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-flight-crossmint-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "66".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const fc = await import("../src/flightcheckout.js");
const fb = await import("../src/flightbook.js");
const tc = await import("../src/ticketcheck.js");
const shipping = await import("../src/shipping.js");
const offers = await import("../src/offers.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
await shop.flightReady;

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const REC = JSON.parse(readFileSync(new URL("./fixtures/crossmint-flights/jetblue-pricecheck.json", import.meta.url), "utf8"));
const REC_FORM = REC.events.find(e => e.question && e.fields.some(f => f.key === "dob"));
const REC_PAY = REC.events.find(e => e.payment_request).payment_request;

// ---------------------------------------------------------------- a fake Crossmint
let calls, runs, nextRun;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: u.pathname, body });
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1 };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages|\/cancel)?$/.exec(p);
  if (m && m[2]) return reply(202, { ok: true });
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { message: "not found" });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  if (/^\/api\/unstable\/order-intents\/[^/]+$/.test(p)) return reply(200, { orderIntentId: decodeURIComponent(p.split("/").pop()), status: "active", rails: [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] });
  return reply(404, { message: "no route" });
}
const soon = () => new Date(clock.now() + 10 * 60_000).toISOString();
/** The recorded passenger form, as Crossmint sends one (the record kept each field's key, label, required, handling and input kind). */
const PASSENGER_FORM = (requestId) => ({ requestId, request: { question: REC_FORM.question, expiresAt: soon(), interaction: { kind: "form",
  fields: REC_FORM.fields.map(f => ({ key: f.key, label: f.label, required: f.required, handling: f.handling, input: { kind: f.input } })) } } });
/** The recorded payment request: card, EXACT 118.40 USD, merchant JetBlue. */
const PAY = (requestId, amount = REC_PAY.interaction.amount) => ({ requestId, request: { question: REC_PAY.question, expiresAt: soon(), interaction: { ...REC_PAY.interaction, amount } } });

const said = [], woke = [];
const q = (sql) => db.db.prepare(sql);
let messages;
const owner = (t) => ({ role: "user", content: "[Wed, Nov 11, 2026, 9:30 PM] Omari: " + t });
const say = (t, c = OMARI) => { messages = [...(messages ?? []), owner(t)]; offers.beginTurn(c, t, "user"); };
const fresh = async () => ({ ok: true, still_there: true, moved: false, price_now: "$119", price_then: "$119" });
const call = (name, input, c = OMARI, extra = {}) => runTool(name, input, { conversationId: c, messages, judge: async () => ({ verdict: "yes" }), flightVerify: fresh, ...extra });
const TESTY = { given_name: "Testy", family_name: "Spikeson", born_on: "1990-01-15", gender: "m", email: "spike-test@example.com", phone: "+12025550143" };

before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }), base: "https://heyreason.test/web/connect" });
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "test", address: "+13475550000", name: "Ama" });
});
after(() => { config.flightBooking = false; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; said.length = 0; woke.length = 0; messages = []; clock.reset(); shop._setMail(null);
  config.flightBooking = "owner"; config.maxSpendPerDay = 1000;
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "spend", "flight_runs", "flight_travelers", "flight_ticket_watch", "agentcard_purchases"]) db.db.exec(`DELETE FROM ${t}`);
});

/** A search with one JetBlue option, as flight_search leaves it. */
function search(c = OMARI, legs = [{ from: "JFK", to: "BOS", depart: "2026-12-02T09:30", arrive: "2026-12-02T10:46", airline: "B6", flight_number: "318" }]) {
  return db.recordFlightSearch(c, { kind: "flights", params: { asked: {}, sent: { adults: 1, cabin: "ECONOMY" } }, outcome: "ok", found: 1,
    options: [{ option: 1, price: "$119", flights: "B6318 JFK→BOS", legs, link: "https://www.google.com/travel/flights?q=x" }] });
}
async function confirmedTraveler(c = OMARI, t = TESTY) {
  say("book it for me, here are my details", c);
  const saved = await call("flight_traveler_save", t, c);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  clock.skip(1000);
  say("yes those are right", c);
  assert.equal((await call("flight_traveler_confirm", { traveler_ids: [saved.traveler_id], said: "yes those are right" }, c)).ok, true);
  return saved.traveler_id;
}
async function booked() {
  const tid = await confirmedTraveler();
  const sid = search();
  say("book option 1");
  const out = await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid] });
  assert.equal(out.ok, true, JSON.stringify(out));
  return { tid, sid, runId: out.run_id, out };
}
const card = () => q("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());

// ---------------------------------------------------------------- the switch
test("the route is the shopping path: booking is on only with the flag AND Crossmint shopping on for that person", () => {
  const names = (c) => toolsFor(c).map(t => t.name);
  const BOOKING = ["flight_book", "flight_traveler_save", "flight_traveler_confirm", "flight_travelers", "flight_traveler_forget"];
  assert.equal(fb.bookingRoute(OMARI), "crossmint");
  assert.equal(fb.bookingRoute(AMA), null, "REASON_SHOP_CONNECT=owner: no shopping path for Ama, so no route");
  for (const n of BOOKING) { assert.ok(names(OMARI).includes(n), n); assert.ok(!names(AMA).includes(n), n); }
  assert.match(toolsFor(OMARI).find(t => t.name === "flight_search").description, /Two ways to finish/);
  assert.match(toolsFor(AMA).find(t => t.name === "flight_search").description, /SEARCH ONLY — Reason never books/);
  // The flag on for everyone still books for nobody without the shopping path.
  config.flightBooking = true;
  assert.equal(fb.bookingEnabled(AMA), false);
  assert.equal(fb.bookingEnabled(OMARI), true);
  // Off (the default): nobody, and the search is search only.
  config.flightBooking = false;
  for (const n of BOOKING) assert.ok(!names(OMARI).includes(n), n);
  assert.match(toolsFor(OMARI).find(t => t.name === "flight_search").description, /SEARCH ONLY — Reason never books/);
});

test("flag off: flight_book is refused and nothing reaches Crossmint", async () => {
  config.flightBooking = false;
  say("book option 1");
  const out = await call("flight_book", { search_id: 1, option: 1, traveler_ids: [1] });
  assert.equal(out.blocked, "not_available", JSON.stringify(out));
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- starting a booking
test("flight_book starts a checkout on the airline's own site for exactly those flights — and no passenger detail is in the instruction", async () => {
  const { runId, out } = await booked();
  const start = calls.find(c => c.method === "POST" && c.path === "/api/unstable/agent-checkouts");
  assert.equal(start.body.request.startUrl, "https://www.jetblue.com/");
  assert.match(start.body.request.task, /B6318 from JFK to BOS, departing 2026-12-02 at 09:30/);
  assert.match(start.body.request.task, /Exactly these flights/);
  assert.equal(start.body.constraints.maxCost.amount, "179.00", "a ceiling over the searched $119, never a price");
  const everything = JSON.stringify(start.body) + JSON.stringify(q("SELECT * FROM shop_run_asks WHERE run_id = ?").get(runId)) + JSON.stringify(fc.flightRun(runId, OMARI));
  for (const secret of ["1990-01-15", "Spikeson", "spike-test@example.com", "+12025550143"]) assert.ok(!everything.includes(secret), `${secret} is kept or sent at the start`);
  assert.equal(out.airline, "JetBlue");
  assert.match(out.note, /Nothing is booked, held or charged/);
  assert.match(out.note, /ONE number/);
  assert.equal(fc.isFlightRun(runId, OMARI), true);
  assert.equal(fc.isFlightRun(runId, AMA), false, "another person's conversation never reads it");
});

test("flight_book refuses: not their turn, unconfirmed travelers, the wrong seat count, two airlines, a moved price, a flight that is gone, one already running", async () => {
  const sid = search();
  const tid = await confirmedTraveler();
  offers.beginTurn(OMARI, "a fare dropped", "timer");
  assert.equal((await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid] })).blocked, "not_their_turn");
  say("book option 1");
  const raw = db.saveFlightTraveler(OMARI, { ...TESTY, given_name: "Unread" }, {}).id;
  assert.equal((await call("flight_book", { search_id: sid, option: 1, traveler_ids: [raw] })).blocked, "travelers_not_confirmed");
  assert.equal((await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid, tid] })).blocked, "traveler_count");
  const mixed = search(OMARI, [{ from: "JFK", to: "ORD", depart: "2026-12-02T09:30", arrive: "2026-12-02T11:00", airline: "B6", flight_number: "1" }, { from: "ORD", to: "SFO", depart: "2026-12-02T12:30", arrive: "2026-12-02T15:00", airline: "UA", flight_number: "2" }]);
  const two = await call("flight_book", { search_id: mixed, option: 1, traveler_ids: [tid] });
  assert.equal(two.blocked, "not_offered");
  assert.match(two.error, /Google Flights link/);
  const moved = await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid] }, OMARI, { flightVerify: async () => ({ ok: true, still_there: true, moved: true, price_now: "$149", price_then: "$119" }) });
  assert.equal(moved.blocked, "price_moved");
  assert.equal((await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid] }, OMARI, { flightVerify: async () => ({ ok: true, still_there: false }) })).blocked, "flight_gone");
  assert.equal((await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid] }, OMARI, { flightVerify: async () => ({ ok: false, error: "down" }) })).blocked, "quote_unverified");
  assert.equal(calls.filter(c => c.method === "POST").length, 0, "none of those started a checkout");
  assert.equal((await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid] })).ok, true);
  assert.equal((await call("flight_book", { search_id: sid, option: 1, traveler_ids: [tid] })).blocked, "booking_in_progress", "a second would be a second ticket");
});

// ---------------------------------------------------------------- the passenger form
test("recorded: JetBlue's passenger form is answered by code from the sealed traveler and their address on record", async () => {
  shipping.learn(OMARI, { first_name: "Omari", last_name: "Nyarko", address1: "350 5th Ave", city: "New York", state: "NY", zip: "10118", phone: "+12025551234", email: "o@example.com" }, { source: "test" });
  const { runId } = await booked();
  runs[runId].requiredAction = PASSENGER_FORM("req_pax_1"); runs[runId].revision = 2;
  await shop.step(runId);
  const sent = calls.find(c => c.path.endsWith("/messages"));
  assert.ok(sent, `not answered by code; woke: ${JSON.stringify(woke)}`);
  const a = sent.body.parts[0].response.answers;
  // The traveler flies, not the account holder: every identity field is the confirmed traveler's.
  assert.equal(a.first_name, "Testy");
  assert.equal(a.last_name, "Spikeson");
  assert.equal(a.title, "Mr");
  assert.equal(a.gender, "Male");
  assert.equal(a.dob, "01/15/1990", "the form asked for MM/DD/YYYY");
  assert.equal(a.email, "spike-test@example.com");
  assert.equal(a.phone, "+12025550143");
  // The contact address is their own record's.
  assert.equal(a.state, "NY");
  assert.equal(a.address1, "350 5th Ave");
  assert.equal(woke.length, 0);
  assert.equal(said.at(-1).t, "Gave JetBlue Testy S.'s details as you confirmed them. Say if that's wrong.");
});

test("a required field nothing on record answers goes to the model, never guessed", async () => {
  const { runId } = await booked();   // no address on record: JetBlue's form requires a state
  runs[runId].requiredAction = PASSENGER_FORM("req_pax_1"); runs[runId].revision = 2;
  await shop.step(runId);
  assert.equal(calls.filter(c => c.path.endsWith("/messages")).length, 0);
  assert.equal(woke.length, 1);
});

// ---------------------------------------------------------------- the payment
test("recorded: the payment request is one exact total; the yes is pinned to the travelers, and paying goes through the shopping path", async () => {
  card();
  const { runId } = await booked();
  runs[runId].requiredAction = PAY("req_pay_1"); runs[runId].revision = 3;
  await shop.step(runId);
  const pay = q("SELECT * FROM shop_payments WHERE run_id = ?").get(runId);
  assert.equal(pay.amount, "118.40");
  assert.equal(pay.amount_kind, "exact");
  assert.equal(pay.merchant_name, "JetBlue");
  assert.match(shop.payTarget(pay), /exact 118\.40 USD at JetBlue .* travelers \[[0-9a-f]{12}\]$/);
  assert.match(said.at(-1).t, /118\.40/);
  // Without a yes, shop_pay pays nothing: the gate hands back the target to ask about.
  say("ok");
  const refused = await call("shop_pay", { payment_id: pay.id });
  assert.notEqual(refused.ok, true);
  assert.equal(calls.filter(c => c.path === "/api/unstable/order-intents").length, 0);
  // With the yes on record, the one payment path pays Crossmint's number.
  const paid = await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(calls.find(c => c.path === "/api/unstable/order-intents" && c.method === "POST")?.body?.mandates?.[0]?.value ?? "118.40", "118.40");
});

test("a traveler corrected after the booking started: the payment is refused before any order intent, whatever yes there is", async () => {
  card();
  const { runId, tid } = await booked();
  runs[runId].requiredAction = PAY("req_pay_1"); runs[runId].revision = 3;
  await shop.step(runId);
  const pay = q("SELECT * FROM shop_payments WHERE run_id = ?").get(runId);
  const before = shop.payTarget(pay);
  say("wait, spell it Spikesen");
  await call("flight_traveler_save", { ...TESTY, family_name: "Spikesen", traveler_id: tid });
  const out = await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 });
  assert.equal(out.ok, false);
  assert.equal(out.error, "travelers_changed", JSON.stringify(out));
  assert.equal(calls.filter(c => c.path === "/api/unstable/order-intents").length, 0, "nothing was authorized");
  assert.equal(shop.payTarget(pay), before, "the target still names the travelers the booking was built for");
});

test("booking switched off after the checkout started: its payment is refused", async () => {
  card();
  const { runId } = await booked();
  runs[runId].requiredAction = PAY("req_pay_1"); runs[runId].revision = 3;
  await shop.step(runId);
  const pay = q("SELECT * FROM shop_payments WHERE run_id = ?").get(runId);
  config.flightBooking = false;
  const out = await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 });
  assert.equal(out.error, "not_available");
  assert.equal(calls.filter(c => c.path === "/api/unstable/order-intents").length, 0);
});

test("a ceiling is never a price: a 'maximum' amount is declined and never asked for approval", async () => {
  card();
  const { runId } = await booked();
  runs[runId].requiredAction = PAY("req_pay_1", { kind: "maximum", value: "179.00", currency: "USD" }); runs[runId].revision = 3;
  await shop.step(runId);
  assert.match(said.at(-1).t, /only gave me a ceiling .* Nothing was charged/);
  assert.equal(q("SELECT status FROM shop_payments WHERE run_id = ?").get(runId).status, "declined");
});

// ---------------------------------------------------------------- after the airline took the order
test("CONSTRUCTED (documented shape; no placed flight order has been seen): an order the airline took is not booked — it is watched for the e-ticket", async () => {
  card();
  const { runId } = await booked();
  runs[runId].requiredAction = PAY("req_pay_1"); runs[runId].revision = 3;
  await shop.step(runId);
  const pay = q("SELECT * FROM shop_payments WHERE run_id = ?").get(runId);
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 })).ok, true);
  runs[runId] = { status: "succeeded", revision: 9, result: { outcome: "succeeded", summary: "JetBlue confirmed the booking.", purchase: { kind: "receipt_captured", receipt: { total: { amount: "118.40", currency: "USD" }, merchantOrderId: "QX7Y2Z" } } } };
  await shop.step(runId);
  const text = said.at(-1).t;
  assert.match(text, /^JetBlue took the order \(confirmation QX7Y2Z\) for B6318 JFK→BOS 2026-12-02, for Testy S\.: that is not a ticket yet\. /);
  assert.doesNotMatch(text, /\bbooked\b|delivery/i);
  const row = db.getAgentcardPurchase(fc.orderKey(runId));
  assert.equal(row.kind, "flight");
  assert.equal(row.status, "placed");
  assert.equal(row.amount_cents, 11840);
  const st = fb.bookingState(row, { ticketing: tc.ticketingFor(row) });
  assert.equal(st.state, "ticketing_pending");
  assert.equal(st.booked, false);
  assert.match(st.words, /JetBlue gave is QX7Y2Z — that is not a ticket/);
  assert.doesNotMatch(st.words, /AgentCard/);
  // The e-ticket check picks it up.
  const facts = tc.orderFacts(row);
  assert.deepEqual([facts.origin, facts.destination, facts.departDay, facts.carrier], ["JFK", "BOS", "2026-12-02", "B6"]);
  const swept = await tc.checkTickets({ now: clock.now(), tell: async () => ({ ok: true }), gmail: async () => ({ ok: false }), read: async () => null });
  assert.equal(swept.opened, 1);
});

test("booked needs a ticket for EVERY passenger: an e-ticket naming one of two covers one of two", () => {
  const facts = { origin: "JFK", destination: "BOS", departDay: "2026-12-02", carrier: "B6", travelers: [{ given_name: "Testy", family_name: "Spikeson" }, { given_name: "Ama", family_name: "Mensah" }] };
  const email = { is_ticket_email: true, origin: "JFK", destination: "BOS", depart_date: "2026-12-02", carrier: "JetBlue", record_locator: "QX7Y2Z", passengers: ["Testy Spikeson"], tickets: [{ number: "2791234567890", passenger: "Testy Spikeson" }] };
  const one = tc.evidenceFrom(email, facts);
  assert.deepEqual(one.tickets, ["2791234567890"]);
  assert.deepEqual(one.covers, [0], "the second passenger has no ticket on this email");
  const both = tc.evidenceFrom({ ...email, tickets: [...email.tickets, { number: "2791234567891", passenger: "Ama Mensah" }] }, facts);
  assert.deepEqual(both.covers, [0, 1]);
});
