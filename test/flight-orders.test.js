// Flights booked end to end through Duffel (src/flightorders.js), against a fake Duffel and a fake
// Stripe built from their documented shapes (test/fixtures/duffel/), and a software authenticator that
// signs what a phone would. No network, no key. What these hold:
//   the total is shown line by line; only Face ID books; today's limit holds; a hold comes before the
//   order and the money after it; no double charge or booking on any repeat; an unclear answer is
//   never resent and never called booked; a schedule change reaches the person within 15 seconds.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createHash, createSign, randomBytes } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const dir = mkdtempSync(join(tmpdir(), "reason-flight-orders-"));
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: dir, REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York",
  REASON_CONVERSATION: "dm:owner", REASON_PASSKEY_PAY: "owner", REASON_SITE_URL: "https://heyreason.com",
  REASON_FLIGHT_DUFFEL: "owner", DUFFEL_ACCESS_TOKEN: "duffel_test_abc", DUFFEL_WEBHOOK_SECRET: "whsec_duffel",
  DUFFEL_API_BASE: "https://duffel.test", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_API_BASE: "https://stripe.test",
  REASON_TOKEN_KEY: randomBytes(32).toString("hex"), REASON_FLIGHT_FEE_CENTS: "500", REASON_MAX_SPEND_PER_DAY: "1000", REASON_PAYWALL: "owner",
});

const orders = await import("../src/flightorders.js");
const duffel = await import("../src/duffel.js");
const passkey = await import("../src/passkey.js");
const plan = await import("../src/plan.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { approveRequest } = await import("../src/pages/webapprove.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const ORIGIN = "https://heyreason.com";
const SAME = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const q = (sql) => db.db.prepare(sql);
const sha = (b) => createHash("sha256").update(b).digest();
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(here, "fixtures/duffel", n), "utf8"));

class Authenticator {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.key = privateKey; this.rawId = randomBytes(16); this.id = this.rawId.toString("base64url");
    this.cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])));
    this.counter = 0;
  }
  authData({ attested = false } = {}) {
    const c = Buffer.alloc(4); c.writeUInt32BE(this.counter);
    const parts = [sha("heyreason.com"), Buffer.from([0x05 | (attested ? 0x40 : 0)]), c];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.rawId.length); parts.push(Buffer.alloc(16), len, this.rawId, this.cose); }
    return Buffer.concat(parts);
  }
  create(options) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
    const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData({ attested: true })]])));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
  }
  get(challenge) {
    this.counter++;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }));
    const authenticatorData = this.authData();
    const sig = createSign("SHA256").update(Buffer.concat([authenticatorData, sha(clientDataJSON)])).sign(this.key);
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: sig.toString("base64url") }, clientExtensionResults: {} };
  }
}

// ---------------------------------------------------------------- the fakes
let calls, duffelOrders, createAnswers, confirmCancelAnswer, holdAnswer, offerPrice, ticketsIssued, cards, confirmChangeAnswer;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)), json: async () => body });
const named = (p) => calls.filter(c => c.path === p || c.match === p);
function orderBody(data, id = `ord_${duffelOrders.length + 1}`) {
  const base = fixture("order.json").data;
  return { ...base, id, metadata: data.metadata, passengers: data.passengers.map(p => ({ id: p.id, given_name: p.given_name, family_name: p.family_name })),
    documents: ticketsIssued ? data.passengers.map((_, i) => ({ type: "electronic_ticket", unique_identifier: `125000000${i}` })) : [] };
}
async function fakeDuffel(url, init = {}) {
  const u = new URL(url); const p = u.pathname; const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ svc: "duffel", method: init.method, path: p, body });
  if (p === "/air/offer_requests") return reply(201, { data: { offers: [fixture("offer.json").data] } });
  if (p.startsWith("/air/offers/")) return reply(200, { data: { ...fixture("offer.json").data, total_amount: offerPrice } });
  if (p === "/air/orders" && init.method === "POST") {
    const a = createAnswers.shift() ?? { status: 201 };
    if (a.throwIt) throw Object.assign(new Error("slow"), { name: "TimeoutError" });
    if (a.status !== 201 && !a.placeAnyway) return reply(a.status, a.body ?? { errors: [{ code: a.code ?? "x", title: "no" }] });
    const o = orderBody(body.data); duffelOrders.push(o);
    return a.placeAnyway ? reply(a.status, {}) : reply(201, { data: o });
  }
  if (p === "/air/orders" && init.method === "GET") return reply(200, { data: duffelOrders });
  if (p.startsWith("/air/orders/")) {
    const o = duffelOrders.find(x => x.id === p.split("/").pop());
    return o ? reply(200, { data: { ...o, documents: ticketsIssued ? o.passengers.map((_, i) => ({ type: "electronic_ticket", unique_identifier: `125000000${i}` })) : [] } }) : reply(404, {});
  }
  if (p === "/air/order_cancellations") return reply(201, { data: fixture("cancellation.json").data });
  if (/^\/air\/order_cancellations\/[^/]+\/actions\/confirm$/.test(p)) {
    if (confirmCancelAnswer) { const a = confirmCancelAnswer; confirmCancelAnswer = null; if (a.placeAnyway) duffelOrders[0].cancelled_at = "x"; return reply(a.status, {}); }
    return reply(200, { data: { ...fixture("cancellation.json").data, confirmed_at: "2026-11-09T00:00:00Z" } });
  }
  if (p.startsWith("/air/order_cancellations/")) return reply(200, { data: { ...fixture("cancellation.json").data, confirmed_at: "2026-11-09T00:00:00Z" } });
  if (p === "/air/order_change_requests") return reply(201, { data: { order_change_offers: [fixture("change_offer.json").data] } });
  if (p.startsWith("/air/order_change_offers/")) return reply(200, { data: { ...fixture("change_offer.json").data, change_total_amount: changeTotal } });
  if (p === "/air/order_changes") return reply(201, { data: { id: "oce_1" } });
  if (/^\/air\/order_changes\/[^/]+\/actions\/confirm$/.test(p)) { const a = confirmChangeAnswer ?? { status: 200 }; return reply(a.status, a.status === 200 ? { data: { id: "oce_1", confirmed_at: "x" } } : {}); }
  if (p.startsWith("/air/order_changes/")) return reply(200, { data: { id: "oce_1", confirmed_at: "x" } });
  if (/actions\/accept$/.test(p)) return reply(200, { data: { id: p.split("/")[3], action_taken: "accepted" } });
  return reply(404, {});
}
let changeTotal = "45.00";
async function fakeStripe(url, init = {}) {
  const u = new URL(url); const p = u.pathname; const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
  calls.push({ svc: "stripe", method: init.method, path: p, body, key: init.headers?.["idempotency-key"] ?? null });
  if (p === "/v1/customers") return reply(200, { id: "cus_1" });
  if (p === "/v1/payment_methods") return reply(200, { data: cards ? [{ id: "pm_1", card: { brand: "visa", last4: "4242" } }] : [] });
  if (p === "/v1/checkout/sessions") return reply(200, { url: "https://checkout.test/setup" });
  if (p === "/v1/payment_intents" && holdAnswer === "network") throw new Error("connection reset");
  if (p === "/v1/payment_intents") return holdAnswer ?? reply(200, { id: `pi_${calls.filter(c => c.path === "/v1/payment_intents").length}`, status: "requires_capture" });
  if (/\/capture$/.test(p)) return reply(200, { status: "succeeded" });
  if (/\/cancel$/.test(p)) return reply(200, { status: "canceled" });
  if (p === "/v1/refunds") return reply(200, { status: "succeeded" });
  return reply(404, {});
}
const said = [];
const orderPosts = () => calls.filter(c => c.path === "/air/orders" && c.method === "POST");
const captures = () => calls.filter(c => /\/capture$/.test(c.path));
const voids = () => calls.filter(c => /payment_intents\/.*\/cancel$/.test(c.path));
const holds = () => calls.filter(c => c.path === "/v1/payment_intents");
const refunds = () => calls.filter(c => c.path === "/v1/refunds");
const allSaid = () => said.map(s => s.t).join("\n");

const page = (token, verb = "", body) => approveRequest({ sub: verb ? `${token}/${verb}` : token, method: verb ? "POST" : "GET", headers: SAME, readBody: async () => (body === undefined ? "" : JSON.stringify(body)) });
const optionsOf = (html) => JSON.parse(/var B=(\{.*?\});\n/s.exec(html)[1]).options;
let auth, tid;
async function faceId() {
  auth = new Authenticator();
  const o = await passkey.registrationOptions(C);
  assert.equal((await passkey.register(C, auth.create(o.options))).ok, true);
}
const quoted = async (offer = "off_1", ids = [tid]) => runTool("flight_quote", { offer_id: offer, traveler_ids: ids }, { conversationId: C });
const tokenOf = (url) => url.split("/web/approve/")[1];
async function approveVia(url) {
  const token = tokenOf(url);
  const html = (await page(token)).body;
  return await page(token, "verify", auth.get(optionsOf(html).challenge));
}
async function book() {
  const q0 = await quoted();
  assert.equal(q0.ok, true, JSON.stringify(q0));
  const res = await approveVia(q0.url);
  assert.equal(res.status, 200, res.body);
  await orders.idle();
  return q0;
}
function event(type, object, id = `wev_${randomBytes(4).toString("hex")}`) {
  const rawBody = JSON.stringify({ id, type, data: { object }, live_mode: false, api_version: "v2" });
  return { rawBody, headers: { "x-duffel-signature": duffel.sign(rawBody, "whsec_duffel") } };
}

before(() => { orders._setFetch({ duffel: fakeDuffel, stripe: fakeStripe }); orders._setSleep(async () => {}); orders.attach({ say: (c, t) => { said.push({ c, t }); } }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  calls = []; duffelOrders = []; createAnswers = []; confirmCancelAnswer = null; confirmChangeAnswer = null; holdAnswer = null; offerPrice = "200.00"; ticketsIssued = true; cards = true; changeTotal = "45.00"; said.length = 0; clock.reset();
  for (const t of ["flight_bookings", "flight_changes", "flight_airline_changes", "flight_card_customers", "duffel_events", "pay_passkeys", "pay_passkey_regs", "pay_approvals", "pay_approval_log", "spend", "flight_travelers", "plan"]) db.db.exec(`DELETE FROM ${t}`);
  tid = db.saveFlightTraveler(C, { given_name: "Ada", family_name: "Mensah", born_on: "1990-02-03", gender: "f", email: "a@example.com", phone: "+15551112222" }, { said: "yes that's right" }).id;
  await faceId();
});

// ---------------------------------------------------------------- the switch
test("off by default: no tools, the webhook is a 404, and a live token cannot write without its own flag", async () => {
  process.env.REASON_FLIGHT_DUFFEL = "off";
  try {
    assert.equal(orders.enabled(C), false);
    assert.equal(toolsFor(C).some(t => t.name === "flight_quote"), false);
    const e = event("order.created", {});
    assert.equal((await orders.webhookRequest(e)).status, 404);
  } finally { process.env.REASON_FLIGHT_DUFFEL = "owner"; }
  process.env.DUFFEL_ACCESS_TOKEN = "duffel_live_real";
  try {
    assert.equal(duffel.canBook(), false);
    assert.equal(orders.enabled(C), false);
    const out = await duffel.createOrder({}, { fetchImpl: async () => { throw new Error("must not be called"); } });
    assert.equal(out.error, "writes_not_allowed");
  } finally { process.env.DUFFEL_ACCESS_TOKEN = "duffel_test_abc"; }
  assert.equal(orders.enabled(C), true);
  assert.equal(toolsFor(C).some(t => t.name === "flight_quote"), true);
  assert.equal(toolsFor(C).some(t => t.name === "flight_traveler_save"), true, "travelers can be collected");
  assert.equal(toolsFor(C).some(t => t.name === "flight_book"), false, "the old path stays hidden");
});

test("what a Duffel answer proves: only a 4xx or a 503 is a definite no", () => {
  const o = (status, json = null, error) => duffel.outcomeOf({ status, json, error }).outcome;
  assert.equal(o(201, { data: { id: "ord_1" } }), "done");
  assert.equal(o(422, { errors: [{ code: "offer_expired" }] }), "rejected");
  assert.equal(o(503), "rejected");
  for (const s of [500, 502, 504, 200, 202, 408]) assert.equal(o(s), "unknown", `${s} proves nothing`);
  assert.equal(o(0, null, "timeout"), "unknown");
});

// ---------------------------------------------------------------- the price
test("fares come from Duffel, and carry the airline's refund and change rules", async () => {
  const out = await runTool("flight_fares", { origin: "jfk", destination: "lax", departure_date: "2026-12-12", traveler_ids: [tid] }, { conversationId: C });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.offers[0].offer_id, "off_1");
  assert.match(out.offers[0].flights, /JFK→LAX DL123/);
  assert.equal(out.offers[0].conditions.change_before_departure, "allowed, $75.00 penalty");
  assert.equal(out.offers[0].conditions.refund_before_departure, "not allowed");
  assert.deepEqual(calls.find(c => c.path === "/air/offer_requests").body.data.passengers.length, 1);
});

test("the quote is line by line and adds up; nothing is held or charged yet", async () => {
  const out = await quoted();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.lines, [
    { label: "Airline fare and taxes", amount: "$200.00" },
    { label: "Booking service fee", amount: "$5.00" },
    { label: "Reason fee", amount: "$5.00" },
  ]);
  assert.equal(out.total, "$210.00");
  assert.equal(holds().length, 0); assert.equal(orderPosts().length, 0);
});

test("an unlimited member pays no Reason fee", async () => {
  await plan.markPaid(C, { customerId: "cus_paid", subscriptionId: "sub_1", paidUntil: clock.now() + 864e5 });
  const out = await quoted();
  assert.equal(out.lines[2].amount, "$0.00");
  assert.match(out.lines[2].label, /none for members/);
  assert.equal(out.total, "$205.00");
});

test("no yes is taken when it couldn't be kept: unconfirmed traveler, no card, no Face ID, an infant, foreign currency", async () => {
  const unconfirmed = db.saveFlightTraveler(C, { given_name: "Kofi", family_name: "Mensah", born_on: "1988-01-01", gender: "m", email: "k@example.com", phone: "+15551113333" });
  assert.equal((await quoted("off_1", [unconfirmed.id])).blocked, "travelers_unconfirmed");
  cards = false;
  const noCard = await quoted();
  assert.equal(noCard.blocked, "needs_card"); assert.match(noCard.url, /checkout\.test/);
  cards = true;
  const baby = db.saveFlightTraveler(C, { given_name: "Ama", family_name: "Mensah", born_on: new Date(clock.now() - 200 * 864e5).toISOString().slice(0, 10), gender: "f", email: "a@example.com", phone: "+15551112222" }, { said: "yes" });
  assert.equal((await quoted("off_1", [baby.id])).blocked, "infant");
  db.db.exec("DELETE FROM pay_passkeys");
  const noFace = await quoted();
  assert.equal(noFace.blocked, "needs_face_id"); assert.match(noFace.url, /connect\/passkey/);
  assert.equal(q("SELECT COUNT(*) AS n FROM flight_bookings").get().n, 0);
});

test("over today's limit: no ask at the quote, and at Face ID the link stays open and nothing moves", async () => {
  q("INSERT INTO spend (conversation_id, day, cents, what, site, confirmation_id, at) VALUES (?, ?, 90000, 'x', 'x', NULL, 0)").run(C, trust.spendToday(C).day);
  assert.equal((await quoted()).blocked, "over_daily_cap");
  db.db.exec("DELETE FROM spend");
  const out = await quoted();
  q("INSERT INTO spend (conversation_id, day, cents, what, site, confirmation_id, at) VALUES (?, ?, 90000, 'x', 'x', NULL, 0)").run(C, trust.spendToday(C).day);
  const res = await approveVia(out.url);
  assert.equal(res.status, 400); assert.match(res.body, /over_daily_cap/);
  assert.equal(holds().length, 0);
  assert.equal(orders.get(out.booking_id).status, "asked");
  assert.equal(passkey.openApprovalFor(out.booking_id, "flight")?.state, "open", "the link was not spent");
});

// ---------------------------------------------------------------- booking
test("Face ID books: hold, order, capture, read back; the only claim comes after the airline's record", async () => {
  const out = await book();
  const r = orders.get(out.booking_id);
  assert.equal(r.status, "verified");
  assert.equal(holds()[0].body.capture_method, "manual");
  assert.equal(holds()[0].body.amount, "21000");
  assert.deepEqual(calls.filter(c => ["/v1/payment_intents", "/air/orders"].includes(c.path) || /\/capture$/.test(c.path)).map(c => c.path.replace(/pi_\d+/, "pi")), ["/v1/payment_intents", "/air/orders", "/v1/payment_intents/pi/capture"]);
  const sent = orderPosts()[0].body.data;
  assert.equal(sent.payments[0].amount, "200.00", "the airline is paid its own price, not the total");
  assert.equal(sent.passengers[0].given_name, "Ada");
  assert.equal(sent.metadata.reason_booking_id, r.id);
  assert.equal(said.length, 1);
  assert.match(said[0].t, /You're booked\. Confirmation ABC123, ticket 1250000000/);
  assert.match(said[0].t, /\$210\.00/);
  assert.equal(trust.spendToday(C).spent_cents, 21000, "counted once");
});

test("the approve page shows every line and never says booked", async () => {
  const out = await quoted();
  const html = (await page(tokenOf(out.url))).body;
  for (const line of ["Airline fare and taxes", "Booking service fee", "Reason fee", "$210.00", "JFK→LAX"]) assert.ok(html.includes(line), line);
  assert.ok(!/You're booked/.test(html));
  assert.match(html, /It isn&#39;t confirmed yet|It isn't confirmed yet/);
});

test("a texted yes cannot book: without the assertion nothing moves", async () => {
  const out = await quoted();
  const res = await page(tokenOf(out.url), "verify", { id: "nope", response: {} });
  assert.equal(res.status, 400);
  assert.equal(holds().length, 0); assert.equal(orderPosts().length, 0);
});

test("decline: nothing is charged and they hear it", async () => {
  const out = await quoted();
  await page(tokenOf(out.url), "decline");
  assert.equal(orders.get(out.booking_id).status, "declined");
  assert.equal(holds().length, 0);
  assert.match(allSaid(), /didn't book it\. Nothing was charged/);
});

test("the price in the fare changes under the approval: the airline refuses, the hold is released, they hear why", async () => {
  createAnswers.push({ status: 422, code: "price_changed" });
  const out = await book();
  assert.equal(orders.get(out.booking_id).status, "failed");
  assert.equal(captures().length, 0); assert.equal(voids().length, 1);
  assert.match(allSaid(), /changed the price/); assert.match(allSaid(), /not booked and you weren't charged/);
  assert.equal(trust.spendToday(C).spent_cents, 0, "given back");
});

test("a refused card never reaches the airline", async () => {
  holdAnswer = reply(402, { error: { code: "card_declined", decline_code: "insufficient_funds" } });
  const out = await book();
  assert.equal(orders.get(out.booking_id).status, "failed");
  assert.equal(orderPosts().length, 0);
  assert.match(allSaid(), /card didn't go through/);
  assert.equal(trust.spendToday(C).spent_cents, 0);
});

test("a row is claimed once: two starts at once make one hold and one order", async () => {
  const out = await quoted();
  const a = orders.start(out.booking_id), b = orders.start(out.booking_id);
  assert.equal(a.ok, true); assert.equal(b.ok, false);
  await orders.idle();
  assert.equal(holds().length, 1); assert.equal(orderPosts().length, 1); assert.equal(captures().length, 1);
  assert.equal(trust.spendToday(C).spent_cents, 21000);
});

test("a reused Face ID link pays nothing a second time", async () => {
  const out = await quoted();
  const token = tokenOf(out.url);
  const html = (await page(token)).body;
  const challenge = optionsOf(html).challenge;
  const first = await page(token, "verify", auth.get(challenge));
  assert.equal(first.status, 200);
  await orders.idle();
  const second = await page(token, "verify", auth.get(challenge));
  assert.equal(second.status, 400);
  await orders.idle();
  assert.equal(orderPosts().length, 1); assert.equal(captures().length, 1);
});

test("no double booking: the same trip for the same people, under a new offer id, is refused while live", async () => {
  await book();
  const again = await quoted("off_2");
  assert.equal(again.blocked, "already_booked");
  assert.equal(orderPosts().length, 1);
});

test("asking again before approving replaces the old ask and closes its link", async () => {
  const first = await quoted();
  const second = await quoted("off_2");
  assert.equal(second.ok, true);
  assert.equal(orders.get(first.booking_id).status, "replaced");
  const v = await page(tokenOf(first.url));
  assert.ok(v === null || !/Approve with Face ID/.test(v.body), "the old link no longer offers an approval");
});

test("the card hold repeats safely: same idempotency key each try, and stable per booking", async () => {
  holdAnswer = "network";
  const out = await quoted();
  orders.start(out.booking_id);
  await orders.idle();
  assert.equal(holds().length, 2);
  assert.equal(holds()[0].key, `flight-hold-${out.booking_id}`);
  assert.equal(holds()[1].key, holds()[0].key);
  assert.equal(orderPosts().length, 0);
  assert.equal(orders.get(out.booking_id).status, "authorizing");
  // Then the card company answers: the sweep carries on with the same key, and books once.
  holdAnswer = null;
  await orders.sweep(); await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "verified");
  assert.equal(orderPosts().length, 1);
  assert.ok(holds().every(h => h.key === holds()[0].key));
});

test("the card company never answers: after the window they hear exactly what happened", async () => {
  holdAnswer = reply(500, {});
  const out = await quoted();
  orders.start(out.booking_id); await orders.idle();
  clock.skip(16 * 60_000);
  await orders.sweep(); await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "failed");
  assert.equal(orderPosts().length, 0);
  assert.match(allSaid(), /couldn't reach the card company/);
  assert.equal(trust.spendToday(C).spent_cents, 0);
});

// ---------------------------------------------------------------- unclear answers
for (const [label, answer] of [["a 500", { status: 500, placeAnyway: true }], ["a 504", { status: 504, placeAnyway: true }], ["a timeout", { throwIt: true }]]) {
  test(`${label} from Duffel: never resent, never called booked, money not taken`, async () => {
    createAnswers.push(answer);
    const out = await book();
    const r = orders.get(out.booking_id);
    assert.equal(r.status, "unknown");
    assert.equal(orderPosts().length, 1);
    assert.equal(captures().length, 0); assert.equal(voids().length, 0);
    assert.match(allSaid(), /can't say it's booked yet/);
    assert.match(allSaid(), /not trying again/);
    assert.ok(!/You're booked/.test(allSaid()));
    assert.equal(trust.spendToday(C).spent_cents, 21000, "still counted: it may have gone through");
    assert.match(q("SELECT what FROM spend").get().what, /OUTCOME UNKNOWN/);
  });
}

test("unclear, then the order turns up: the sweep finishes it, charges once, tells them once", async () => {
  createAnswers.push({ status: 500, placeAnyway: true });
  const out = await book();
  for (let i = 0; i < 3; i++) { await orders.sweep(); await orders.idle(); }
  assert.equal(orders.get(out.booking_id).status, "verified");
  assert.equal(orderPosts().length, 1);
  assert.equal(captures().length, 1);
  assert.equal(said.filter(s => /You're booked/.test(s.t)).length, 1);
  assert.equal(trust.spendToday(C).spent_cents, 21000);
  assert.ok(!/OUTCOME UNKNOWN/.test(q("SELECT what FROM spend").get().what));
});

test("unclear, then Duffel's order.created webhook settles it, and a repeat of the event does nothing", async () => {
  createAnswers.push({ status: 500, placeAnyway: true });
  const out = await book();
  const e = event("order.created", { order_id: duffelOrders[0].id, metadata: { reason_booking_id: out.booking_id } }, "wev_same");
  assert.equal((await orders.webhookRequest(e)).status, 200);
  await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "verified");
  const again = await orders.webhookRequest(e);
  assert.equal(JSON.parse(JSON.stringify(again.body)).duplicate, true);
  assert.equal(captures().length, 1);
});

test("unclear, then order.creation_failed: the hold is released and they hear it", async () => {
  createAnswers.push({ status: 500 });
  const out = await book();
  await orders.webhookRequest(event("order.creation_failed", { offer_id: orders.get(out.booking_id).offer_id }));
  await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "failed");
  assert.equal(voids().length, 1); assert.equal(captures().length, 0);
  assert.match(allSaid(), /didn't go through/);
  assert.equal(trust.spendToday(C).spent_cents, 0);
});

test("unclear for 24 hours and no order anywhere: released, and they hear exactly that", async () => {
  createAnswers.push({ status: 500 });
  const out = await book();
  await orders.sweep(); await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "unknown", "not yet");
  clock.skip(orders.UNKNOWN_GIVE_UP_MS + 1000);
  await orders.sweep(); await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "failed");
  assert.equal(voids().length, 1);
  assert.match(allSaid(), /After 24 hours/);
  assert.equal(trust.spendToday(C).spent_cents, 0);
});

test("a restart in the middle of the airline call: treated as unclear, never sent again", async () => {
  const out = await quoted();
  db.db.prepare("UPDATE flight_bookings SET status = 'booking', stripe_pi = 'pi_1', spend_id = NULL WHERE id = ?").run(out.booking_id);
  await orders.sweep(); await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "unknown");
  assert.equal(orderPosts().length, 0);
  assert.match(allSaid(), /can't say it's booked yet/);
});

test("confirmed but no e-ticket yet: never says ticketed, then says so once the ticket is there", async () => {
  ticketsIssued = false;
  const out = await book();
  assert.equal(orders.get(out.booking_id).status, "booked");
  assert.equal(said.length, 1);
  assert.match(said[0].t, /confirmed your booking, ABC123/);
  assert.ok(!/ticket 12/.test(said[0].t));
  await orders.sweep(); await orders.idle();
  assert.equal(said.length, 1, "not told twice");
  ticketsIssued = true;
  await orders.webhookRequest(event("air.order.changed", { id: duffelOrders[0].id }));
  await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "verified");
  assert.equal(said.filter(s => /You're booked/.test(s.t)).length, 1);
});

// ---------------------------------------------------------------- cancelling and changing
test("cancel: the refund is quoted, confirmed once, and only the airline's amount goes back", async () => {
  const out = await book();
  const quote = await runTool("flight_cancel_quote", { booking_id: out.booking_id }, { conversationId: C });
  assert.equal(quote.ok, true, JSON.stringify(quote));
  assert.equal(quote.refund, "$150.00"); assert.equal(quote.fees_kept, "$10.00");
  const r = orders.get(out.booking_id);
  assert.equal(r.cancel_refund_cents, 15000);
  const done = await orders.cancelConfirm(C, out.booking_id);
  assert.equal(done.ok, true);
  assert.equal(orders.get(out.booking_id).status, "cancelled");
  assert.equal(refunds().length, 1); assert.equal(refunds()[0].body.amount, "15000");
  assert.equal(refunds()[0].key, `flight-refund-${r.cancel_id}-0`);
  const again = await orders.cancelConfirm(C, out.booking_id);
  assert.equal(again.ok, false);
  assert.equal(refunds().length, 1);
  assert.match(allSaid(), /Cancelled\. Booking ABC123 is off, and \$150\.00 is on its way back/);
});

test("a refund bigger than the first payment is split over the ticket and the paid change", async () => {
  const out = await book();
  const ch = await orders.changeQuote(C, { booking_id: out.booking_id, change_offer_id: "oco_1" });
  await approveVia(ch.url); await orders.idle();
  db.db.exec("UPDATE flight_bookings SET cancel_id = 'ore_1', cancel_refund_cents = 22000, cancel_state = 'confirming'");
  calls.length = 0;
  await orders.webhookRequest(event("order_cancellation.confirmed", { order_id: duffelOrders[0].id }));
  assert.deepEqual(refunds().map(x => x.body.amount), ["20000", "2000"]);
  assert.deepEqual(refunds().map(x => x.key), ["flight-refund-ore_1-0", "flight-refund-ore_1-1"]);
});

test("cancel is gated: it asks for a yes before running", async () => {
  const out = await book();
  await runTool("flight_cancel_quote", { booking_id: out.booking_id }, { conversationId: C });
  const res = await runTool("flight_cancel_confirm", { booking_id: out.booking_id }, { conversationId: C });
  assert.ok(res.needs_confirmation || res.blocked || res.ok === false, JSON.stringify(res));
  assert.equal(orders.get(out.booking_id).status, "verified", "not cancelled without a yes");
});

test("an unclear cancel answer is never called cancelled and never sent again; the sweep settles it", async () => {
  const out = await book();
  await orders.cancelQuote(C, out.booking_id);
  confirmCancelAnswer = { status: 500 };
  const res = await orders.cancelConfirm(C, out.booking_id);
  assert.equal(res.unknown_outcome, true);
  assert.equal(orders.get(out.booking_id).status, "verified");
  assert.equal((await orders.cancelConfirm(C, out.booking_id)).ok, false);
  await orders.sweep(); await orders.idle();
  assert.equal(orders.get(out.booking_id).status, "cancelled");
  assert.equal(refunds().length, 1);
});

test("a change that costs money: Face ID, a hold, then the change, then the charge", async () => {
  const out = await book();
  calls.length = 0; said.length = 0;
  const ch = await runTool("flight_change_quote", { booking_id: out.booking_id, change_offer_id: "oco_1" }, { conversationId: C });
  assert.equal(ch.ok, true, JSON.stringify(ch));
  assert.equal(ch.amount, "$45.00 to pay");
  const res = await approveVia(ch.url);
  assert.equal(res.status, 200, res.body);
  await orders.idle();
  assert.equal(holds().length, 1); assert.equal(holds()[0].body.amount, "4500");
  assert.equal(calls.filter(c => /order_changes\/oce_1\/actions\/confirm$/.test(c.path)).length, 1);
  assert.equal(captures().length, 1);
  assert.match(allSaid(), /Changed\./); assert.match(allSaid(), /\$45\.00 charged/);
  assert.equal(trust.spendToday(C).spent_cents, 21000 + 4500);
});

test("a cheaper change refunds the difference", async () => {
  changeTotal = "-30.00";
  const out = await book();
  calls.length = 0; said.length = 0;
  const ch = await orders.changeQuote(C, { booking_id: out.booking_id, change_offer_id: "oco_1" });
  assert.equal(ch.ok, true); assert.equal(ch.amount, "$30.00 back");
  await approveVia(ch.url); await orders.idle();
  assert.equal(holds().length, 0);
  assert.equal(refunds().length, 1); assert.equal(refunds()[0].body.amount, "3000");
  assert.match(allSaid(), /\$30\.00 is on its way back/);
});

test("an unclear change answer is never called changed, and the sweep settles it without resending", async () => {
  const out = await book();
  calls.length = 0; said.length = 0;
  const ch = await orders.changeQuote(C, { booking_id: out.booking_id, change_offer_id: "oco_1" });
  confirmChangeAnswer = { status: 500 };
  await approveVia(ch.url); await orders.idle();
  assert.match(allSaid(), /can't say it's done/); assert.ok(!/^Changed/.test(allSaid()));
  await orders.sweep(); await orders.idle();
  assert.equal(calls.filter(c => /actions\/confirm$/.test(c.path)).length, 1);
  assert.equal(captures().length, 1);
  assert.match(allSaid(), /Changed\./);
});

// ---------------------------------------------------------------- airlines changing things
const AIC = () => ({ ...fixture("airline_change.json").data, order_id: duffelOrders[0].id });

test("a schedule change reaches them by text inside 15 seconds of Duffel knowing, before the event is acknowledged", async () => {
  await book();
  said.length = 0;
  const started = Date.now();
  const res = await orders.webhookRequest(event("order.airline_initiated_change_detected", AIC()));
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(said.length, 1);
  assert.match(said[0].t, /Your airline changed your flight on booking ABC123/);
  assert.match(said[0].t, /It was JFK→LAX DL123/);
  assert.match(said[0].t, /It's now JFK→LAX DL123 .*9:40 AM/);
  assert.match(said[0].t, /haven't accepted anything/);
});

test("a flight the airline cancelled is named as cancelled", async () => {
  await book();
  said.length = 0;
  await orders.webhookRequest(event("order.airline_initiated_change_detected", { ...AIC(), added: [] }));
  assert.match(said[0].t, /Your airline cancelled your flight/);
});

test("the text fails at first: retried within the window; if it never lands, Duffel is told to resend and the sweep keeps the duty", async () => {
  await book();
  said.length = 0;
  let fails = 2;
  orders.attach({ say: (c, t) => { if (fails-- > 0) throw new Error("down"); said.push({ c, t }); } });
  await orders.webhookRequest(event("order.airline_initiated_change_detected", AIC(), "wev_a"));
  assert.equal(said.length, 1);

  q("DELETE FROM flight_airline_changes").run();
  orders.attach({ say: () => { throw new Error("down"); } });
  const e = event("order.airline_initiated_change_detected", { ...AIC(), id: "aic_2" }, "wev_b");
  const res = await orders.webhookRequest(e);
  assert.equal(res.status, 500);
  orders.attach({ say: (c, t) => { said.push({ c, t }); } });
  said.length = 0;
  await orders.sweep(); await orders.idle();
  assert.equal(said.length, 1, "the sweep delivered it");
  // Duffel's retry finds it already told, and does not text it again.
  assert.equal((await orders.webhookRequest(e)).status, 200);
  assert.equal(said.length, 1);
});

test("the same event twice is told once; a bad signature is refused", async () => {
  await book();
  said.length = 0;
  const e = event("order.airline_initiated_change_detected", AIC(), "wev_c");
  await orders.webhookRequest(e); await orders.webhookRequest(e);
  assert.equal(said.length, 1);
  assert.equal((await orders.webhookRequest({ rawBody: e.rawBody, headers: { "x-duffel-signature": "t=1,v1=00" } })).status, 401);
  assert.equal((await orders.webhookRequest({ rawBody: e.rawBody, headers: {} })).status, 401);
});

test("accepting the airline's new time is gated, then goes through once", async () => {
  await book();
  await orders.webhookRequest(event("order.airline_initiated_change_detected", AIC()));
  const open = orders.openAirlineChanges(C);
  assert.equal(open.length, 1);
  const gated = await runTool("flight_airline_change_accept", { change_id: open[0].id }, { conversationId: C });
  assert.ok(gated.needs_confirmation || gated.blocked || gated.ok === false, JSON.stringify(gated));
  assert.equal(calls.filter(c => /actions\/accept$/.test(c.path)).length, 0);
  const out = await orders.airlineChangeAccept(C, open[0].id);
  assert.equal(out.ok, true);
  assert.equal((await orders.airlineChangeAccept(C, open[0].id)).ok, false);
  assert.equal(calls.filter(c => /actions\/accept$/.test(c.path)).length, 1);
});

test("someone else's booking is not there for them", async () => {
  const out = await book();
  assert.equal((await orders.cancelQuote("dm:other", out.booking_id)).ok, false);
  assert.equal(orders.status("dm:other", out.booking_id).bookings.length, 0);
});
