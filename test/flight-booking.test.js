// Booking a flight through AgentCard (src/flightbook.js, flight_* tools, purchase_confirm's flight
// guards). Recorded sandbox answers (test/fixtures/agentcard-flights/*.json, 2026-10-25) and the
// constructed variants next to them; the fake AgentCard (test/fixture-agentcard.js). No key, no
// network beyond 127.0.0.1, no Google and no real AgentCard.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentCard } from "./fixture-agentcard.js";
import * as F from "./fixtures/agentcard-flights/constructed.js";

const dir = mkdtempSync(join(tmpdir(), "reason-flightbook-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "55".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool, toolsFor } = await import("../src/tools.js");
const agentcard = await import("../src/agentcard.js");
const fb = await import("../src/flightbook.js");
const db = await import("../src/db.js");
const offers = await import("../src/offers.js");
const purchasesnote = await import("../src/purchasesnote.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const KOFI = "dm:kofi";
let fake, messages, now0;
const owner = (t) => ({ role: "user", content: "[Sat, Oct 24, 2026, 9:30 PM] Omari: " + t });
const call = (name, input, c = OMARI) => runTool(name, input, { conversationId: c, messages, judge: async () => ({ verdict: "yes" }) });
const say = (t, c = OMARI) => { messages = [...(messages ?? []), owner(t)]; offers.beginTurn(c, t, "user"); };
const tick = (ms) => { clock.now = ((t) => () => t)(clock.now() + ms); };

const TESTY = { given_name: "Testy", family_name: "Spikeson", born_on: "1990-01-15", gender: "m", email: "spike-test@example.com", phone: "+12025550143" };

/** The recorded cart, read the way Reason reads every AgentCard turn. */
async function readThrough(body) {
  fake.set({ turns: [body] });
  const token = db.getAgentcardUser(OMARI).access_token;
  const t = await agentcard.buyConversation(token, "x");
  assert.equal(t.ok, true, JSON.stringify(t));
  return t;
}

/** A traveler as flight_traveler_save + a later "yes that's right" leave it. */
async function confirmedTraveler(c = OMARI, t = TESTY) {
  say("book it for me, here are my details", c);
  const saved = await call("flight_traveler_save", t, c);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  tick(1000);
  say("yes those are right", c);
  const ok = await call("flight_traveler_confirm", { traveler_ids: [saved.traveler_id], said: "yes those are right" }, c);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  return saved.traveler_id;
}

/**
 * A flight row exactly as flight_book leaves it — the cart AgentCard really answered, the travelers
 * fingerprinted, the quote stamped — so the confirm path can be driven before Fli's search lands.
 */
async function flightRow(body, travelerIds) {
  const t = await readThrough(body);
  const travelers = travelerIds.map(id => db.getFlightTraveler(OMARI, id));
  db.recordAgentcardPurchase({ conversationId: OMARI, buyConversationId: t.conversation_id, status: "cart_shown", cartHash: t.cart.hash, amountCents: t.cart.total_cents, merchant: t.cart.merchant_name, what: `${t.cart.items[0].name}, for Testy S.` });
  db.markAgentcardPurchase(t.conversation_id, { kind: "flight", cartJson: JSON.stringify(t.cart), travelerIds: JSON.stringify(travelerIds), travelerFp: fb.travelerFingerprint(travelers), quoteCheckedAt: clock.now(), ticketingState: "quoted" });
  return t;
}

/** confirm_request → their yes → confirm_record, on the target purchase_confirm hands back. */
async function yesFor(t) {
  const refused = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash });
  assert.ok(refused.use_target, JSON.stringify(refused));
  const req = await call("confirm_request", { action: "purchase_confirm", summary: `Book it for ${t.cart.total}?`, stakes: "money", amount: t.cart.total_cents / 100, target: refused.use_target });
  say("yes book it");
  const granted = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(granted.state, "granted", JSON.stringify(granted));
  return { target: refused.use_target, yes: req.confirmation_id };
}

before(async () => {
  now0 = clock.now;
  fake = await startAgentCard();
  config.agentcardClientId = "ac-client-flights";
  config.agentcardClientSecret = "ac-secret-flights";
  config.agentcardApiBase = fake.url;
  config.publicUrl = "";
  config.maxSpendPerDay = 1000;
  config.flightBooking = true;
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI, channel: "test", address: "+12025559876", name: "Kofi" });
  db.setSpendCaps(OMARI, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "five hundred a thing" });
  agentcard.forgetAccessToken();
  messages = [owner("add my card")];
  assert.equal((await call("vault_enroll", {})).ok, true);
  // Connected, as a finished vault link leaves them: their own token, good for days of ticked clock.
  fake.state.liveBuyTokens.add("acut_flights");
  fake.state.tokenUser.set("acut_flights", "usr_8f3k2m");
  db.saveAgentcardConnection({ conversationId: OMARI, userId: "usr_8f3k2m", accessToken: "acut_flights", refreshToken: "acrt_flights", expiresAt: clock.now() + 30 * 86_400_000 });
  assert.equal(db.getAgentcardUser(OMARI)?.access_token, "acut_flights");
});
after(async () => { clock.now = now0; config.flightBooking = false; await fake.close(); rmSync(dir, { recursive: true, force: true }); });

// ---------- the price, exactly as the cart itemizes it ----------

test("the recorded sandbox flight cart: one fare line, fees with no label, taxes not broken out, a final total", async () => {
  const t = await readThrough(F.recorded("3-passenger"));
  assert.equal(fb.isFlightCart(t.cart), true);
  assert.equal(t.cart.estimate_flag_sent, false, "the real flight cart carries no totalIsEstimate key");
  assert.equal(t.next_action, "confirm");
  const v = fb.priceView(t.cart);
  assert.deepEqual(v.fare.map(f => f.amount), ["$173.14"]);
  assert.equal(v.fees.itemized, false);
  assert.equal(v.fees.unlabelled.amount, "$4.33");
  assert.equal(v.taxes.itemized, false);
  assert.equal(v.total, "$177.47");
  assert.equal(v.final, true, v.finality);
  assert.match(v.fare_rules, /not verified/);
  const lines = fb.priceLines(v).join("\n");
  assert.doesNotMatch(lines, /tax(es)?: \$/i, "no tax amount is ever invented");
  assert.match(lines, /taxes: not broken out/);
});

test("a cart with itemized fee and tax lines shows each line as labelled, and taxes as itemized", async () => {
  const t = await readThrough(F.itemizedTurn());
  const v = fb.priceView(t.cart);
  assert.equal(v.fees.itemized, true);
  assert.deepEqual(v.fees.lines.map(l => [l.label, l.amount]), [["Taxes and carrier-imposed fees", "$25.14"], ["Booking fee", "$4.33"]]);
  assert.equal(v.fees.unlabelled, undefined, "the lines add up to the fee figure");
  assert.equal(v.taxes.itemized, true);
  assert.equal(v.final, true);
});

test("an estimated total, or a hold above the total, or no hold at all, is never final", async () => {
  for (const body of [F.estimateTurn(), F.ceilingAboveTurn()]) {
    const t = await readThrough(body);
    assert.equal(fb.totalFinality(t.cart).final, false, JSON.stringify(t.cart));
  }
  const t = await readThrough(F.recorded("3-passenger"));
  assert.equal(fb.totalFinality({ ...t.cart, ceiling_cents: null }).final, false);
});

// ---------- the itinerary ----------

test("AgentCard's legs are matched to the picked option on airports and wall-clock minutes, never on words", async () => {
  const t = await readThrough(F.recorded("1-search"));
  const opt = { legs: [{ from: "JFK", to: "BOS", depart: "2026-11-12T08:07", arrive: "2026-11-12T09:25", airline: "AA", flight_number: "1234" }] };
  const hit = fb.catalogMatch(t.catalog.items, opt);
  assert.equal(hit?.product_id, "p_36d273f8ae8a");
  assert.equal(fb.catalogMatch(t.catalog.items, { legs: [{ ...opt.legs[0], depart: "2026-11-12T08:08" }] }), null, "a minute off is a different flight");
  assert.equal(fb.itineraryMatches(hit.flight.legs, [...fb.optionLegs(opt), ...fb.optionLegs(opt)]).match, false, "a leg count mismatch never matches");
});

// ---------- booking states ----------

test("each booking state is mapped from the record, and only a ticketed status WITH ticket numbers is booked", () => {
  const S = (row, ticketing) => fb.bookingState(row, { ticketing });
  assert.equal(S({ status: "cart_shown" }).state, "quoted");
  assert.equal(S({ status: "awaiting_approval" }).state, "approval_pending");
  assert.equal(S({ status: "awaiting_approval", authorization_state: "approved" }).state, "payment_approved");
  const placed = S({ status: "placed", charge_status: "settled", retailer_order_id: "ABC123" });
  assert.equal(placed.state, "ticketing_pending");
  assert.equal(placed.booked, false);
  assert.match(placed.words, /payment went through, and ticketing is not confirmed/);
  assert.match(placed.words, /ABC123 — that is not a ticket/);
  assert.equal(S({ status: "outcome_unknown" }).state, "outcome_unknown");
  assert.equal(S({ status: "declined", decline_code: "card_declined" }).state, "declined");
  assert.equal(S({ status: "cancelled" }).state, "cancelled");

  // With known fields (injected: AgentCard's real ones are not known yet), the provider's own words decide.
  const FIELDS = { status: [{ field: "ticketing.status", issued: ["ticketed"], reserved: ["held"] }], tickets: ["ticketing.tickets"], locator: ["ticketing.pnr"] };
  const held = fb.ticketingFrom({ ticketing: { status: "held", pnr: "QX7Y2Z" } }, FIELDS);
  assert.equal(S({ status: "placed" }, held).state, "reserved");
  const issuedNoNumbers = fb.ticketingFrom({ ticketing: { status: "ticketed", pnr: "QX7Y2Z" } }, FIELDS);
  assert.equal(S({ status: "placed" }, issuedNoNumbers).state, "ticketing_pending", "a ticketed status with no ticket number is not proof");
  const issued = fb.ticketingFrom({ ticketing: { status: "ticketed", pnr: "QX7Y2Z", tickets: ["0012345678901"] } }, FIELDS);
  const done = S({ status: "placed" }, issued);
  assert.equal(done.state, "issued");
  assert.equal(done.booked, true);
  assert.match(done.words, /0012345678901/);
});

test("with no ticketing fields known, nothing in a placed order — 'confirmed', a locator, 'ticketed' — is read as a ticket", () => {
  assert.deepEqual(fb.TICKETING_FIELDS, { status: [], tickets: [], locator: [] }, "stays empty until a real flight order is seen");
  const raw = { status: "confirmed", booking_reference: "QX7Y2Z", ticketing_status: "ticketed", ticket_numbers: ["0012345678901"], retailer_order_id: "QX7Y2Z" };
  const t = fb.ticketingFrom(raw);
  assert.equal(t.issued, false);
  assert.equal(fb.bookingState({ status: "placed" }, { ticketing: t }).state, "ticketing_pending");
});

// ---------- travelers ----------

test("a traveler is kept unconfirmed, read back, and confirmed only on a LATER message in their own words", async () => {
  say("book it, I'm Testy Spikeson born 1990-01-15");
  const saved = await call("flight_traveler_save", TESTY);
  assert.equal(saved.confirmed, false);
  assert.match(saved.read_back, /Testy Spikeson, born 1990-01-15/);
  const same = await call("flight_traveler_confirm", { traveler_ids: [saved.traveler_id], said: "book it" });
  assert.equal(same.blocked, "not_read_back", "the turn that wrote them cannot confirm them");
  tick(1000);
  say("yep all correct");
  assert.equal((await call("flight_traveler_confirm", { traveler_ids: [saved.traveler_id], said: "all correct!!" })).ok, false, "words not in their message");
  assert.equal((await call("flight_traveler_confirm", { traveler_ids: [saved.traveler_id], said: "yep all correct" })).ok, true);
  assert.ok(db.getFlightTraveler(OMARI, saved.traveler_id).confirmed_at);
  // A correction is a new read-back: unconfirmed again.
  tick(1000);
  say("actually my last name is Spikesen");
  await call("flight_traveler_save", { ...TESTY, family_name: "Spikesen", traveler_id: saved.traveler_id });
  assert.equal(db.getFlightTraveler(OMARI, saved.traveler_id).confirmed_at, null);
  // Missing fields are asked for, never guessed.
  const bad = await call("flight_traveler_save", { ...TESTY, phone: "202-555-0143" });
  assert.equal(bad.blocked, "incomplete");
});

test("traveler details are sealed at rest — a copy of the database is not a copy of anyone's ID", async () => {
  await confirmedTraveler();
  const raw = db.db.prepare("SELECT details FROM flight_travelers WHERE conversation_id = ?").all(OMARI).map(r => r.details).join("\n");
  assert.doesNotMatch(raw, /1990-01-15|Spikeson|spike-test@example\.com/);
  assert.match(raw, /^enc:v1:/m);
});

test("isolation: one person's travelers are never listed, confirmed, used or deleted from another's Reason", async () => {
  const mine = await confirmedTraveler();
  say("who do you have saved for flights", KOFI);
  const list = await call("flight_travelers", {}, KOFI);
  assert.equal(list.travelers.length, 0, JSON.stringify(list));
  assert.equal(db.getFlightTraveler(KOFI, mine), null);
  tick(1000);
  say("yes that's right", KOFI);
  assert.equal((await call("flight_traveler_confirm", { traveler_ids: [mine], said: "yes that's right" }, KOFI)).ok, false);
  assert.equal((await call("flight_traveler_save", { ...TESTY, given_name: "Hijack", traveler_id: mine }, KOFI)).ok, false);
  assert.equal((await call("flight_traveler_forget", { traveler_id: mine }, KOFI)).ok, false);
  assert.equal(db.getFlightTraveler(OMARI, mine).given_name, "Testy", "untouched");
  assert.equal((await call("flight_book", { search_id: 1, option: 1, traveler_ids: [mine] }, KOFI)).ok, false);
});

// ---------- the confirm: one payment path, with a flight's guards ----------

test("the yes is pinned to the travelers too: a corrected passenger voids it even though AgentCard's hash does not move", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { target, yes } = await yesFor(t);
  assert.match(target, /travelers \[[0-9a-f]{12}\]/);
  tick(1000);
  say("wait, spell it Spikesen");
  await call("flight_traveler_save", { ...TESTY, family_name: "Spikesen", traveler_id: id });
  tick(1000);
  say("yes that's right now");
  await call("flight_traveler_confirm", { traveler_ids: [id], said: "yes that's right now" });
  const before = fake.state.confirmCalls.length;
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.equal(out.blocked, "travelers_changed", JSON.stringify(out));
  assert.equal(fake.state.confirmCalls.length, before, "nothing was sent to AgentCard");
});

test("an estimated total blocks the approval: nothing is sent, nothing asked", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.estimateTurn(), [id]);
  const before = fake.state.confirmCalls.length;
  // Refused before the gate: there is no target to collect a yes against, so nobody is asked.
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash });
  assert.equal(out.blocked, "total_not_final", JSON.stringify(out));
  assert.equal(out.use_target, undefined);
  assert.equal(fake.state.confirmCalls.length, before);
});

test("a stale quote is re-quoted, never confirmed", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { yes } = await yesFor(t);
  tick(config.flightQuoteMaxAgeMs + 1000);
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.notEqual(out.ok, true);
  assert.ok(out.blocked === "quote_stale" || /expired|stale|minutes/.test(out.error ?? ""), JSON.stringify(out));
});

test("the passkey pause: the link goes on its own, with its expiry; an expired approval is a fresh quote, never a retry", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { yes } = await yesFor(t);
  const expires = new Date(clock.now() + 15 * 60_000).toISOString();
  fake.set({ confirms: [F.approvalPause(expires)] });
  const paused = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.equal(paused.blocked, "vault_approval_required", JSON.stringify(paused));
  assert.equal(paused.approval_url, "https://vault.agentcard.sh/authorize?id=cauth_flight1");
  assert.match(paused.error, /OWN message/);
  assert.match(paused.error, /Face ID or Touch ID on iPhone, face or fingerprint unlock on Android, or their master password/);
  assert.match(paused.error, /never a retry/);
  const row = db.getAgentcardPurchase(t.conversation_id);
  assert.equal(row.approval_expires_at, Date.parse(expires));
  assert.equal(purchasesnote.flightStatusWords(row), "flight waiting for their approval, not charged, not booked");

  tick(16 * 60_000);
  const before = fake.state.confirmCalls.length;
  const late = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.notEqual(late.ok, true);
  assert.equal(fake.state.confirmCalls.length, before, "an expired approval is never confirmed again");
  assert.equal(db.getAgentcardPurchase(t.conversation_id).decline_code, "approval_expired");
});

test("a declined confirm: not booked, nothing charged, said as declined", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { yes } = await yesFor(t);
  fake.set({ confirms: [F.declinedConfirm] });
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.equal(out.blocked, "declined");
  assert.match(out.error, /Nothing was charged/);
  assert.equal(fb.bookingState(db.getAgentcardPurchase(t.conversation_id)).state, "declined");
});

test("the recorded sandbox confirm: declined sandbox_mode, nothing charged", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { yes } = await yesFor(t);
  const rec = F.recorded("4-confirm-sandbox");
  fake.set({ confirms: [{ body: rec }] });
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.equal(out.blocked, "declined");
  assert.equal(out.decline_code, "sandbox_mode");
});

test("an unknown outcome is never retried: one confirm goes out, the record is read, and it stays unknown", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { yes } = await yesFor(t);
  const t0 = config.agentcardTimeoutMs;
  config.agentcardTimeoutMs = 800;
  fake.set({ confirms: ["hang"], conversation: { turn_in_progress: true } });
  let out;
  try { out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes }); }
  finally { config.agentcardTimeoutMs = t0; }
  assert.equal(out.blocked, "outcome_unknown", JSON.stringify(out));
  const sent = fake.state.confirmCalls.filter(x => x.conversation_id === t.conversation_id).length;
  assert.equal(sent, 1);
  fake.set({ conversation: null });
  const again = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.notEqual(again.ok, true);
  assert.equal(fake.state.confirmCalls.filter(x => x.conversation_id === t.conversation_id).length, 1, "never a second confirm");
  assert.equal(fb.bookingState(db.getAgentcardPurchase(t.conversation_id)).state, "outcome_unknown");
  // Settled as AgentCard would settle it, so the tests after this one start with no unknown booking.
  db.markAgentcardPurchase(t.conversation_id, { status: "declined", declineCode: "test_settled" });
});

test("an order placed is NOT booked: payment, then ticketing pending — even when AgentCard's own reply says 'booked'", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { yes } = await yesFor(t);
  fake.set({ confirms: [F.placedConfirm], conversation: "tracked", orderRead: { status: "confirmed", retailer_order_id: "QX7Y2Z" } });
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.booking_state, "ticketing_pending");
  assert.equal(out.booked, false);
  assert.match(out.note, /ticketing is not confirmed/);
  assert.match(out.note, /Do NOT say it is booked/);
  const row = db.getAgentcardPurchase(t.conversation_id);
  assert.equal(row.ticketing_state, "ticketing_pending");
  assert.ok(row.order_raw_json.includes("QX7Y2Z"), "the order's own record is kept whole for the first live booking");
  assert.match(purchasesnote.flightStatusWords(row), /TICKETING NOT CONFIRMED/);
  const tr = await call("purchase_track", { conversation_id: t.conversation_id });
  assert.equal(tr.booking_state, "ticketing_pending", JSON.stringify(tr));
  assert.equal(tr.booked, false);
  fake.set({ conversation: null, orderRead: undefined });
});

// ---------- the switch, and the other roads in ----------

test("flag off: no booking tool is shown or runs, and a flight row cannot be confirmed", async () => {
  config.flightBooking = false;
  try {
    const names = toolsFor(OMARI).map(t => t.name);
    for (const n of ["flight_book", "flight_traveler_save", "flight_traveler_confirm", "flight_travelers", "flight_traveler_forget"]) assert.ok(!names.includes(n), n);
    say("book it");
    const r = await call("flight_traveler_save", TESTY);
    assert.equal(r.blocked, "not_available");
    assert.match(r.error, /Google Flights link/);
  } finally { config.flightBooking = true; }
  const names = toolsFor(OMARI).map(t => t.name);
  assert.ok(names.includes("flight_book"));
});

test("the generic purchase tool never carts a flight — by AgentCard's merchant slug", async () => {
  say("buy me a flight to boston");
  fake.set({ turns: [F.recorded("1-search")] });
  const r = await call("purchase", { ask: "a flight from JFK to BOS on Nov 12", address_street: "1 Main St", address_city: "New York", address_state: "NY", address_zip: "10001", address_phone: "+12025551234" });
  assert.equal(r.blocked, "flight_not_here", JSON.stringify(r));
});

test("a suggestion never books: flight_book refuses on a turn they did not start", async () => {
  const id = await confirmedTraveler();
  offers.beginTurn(OMARI, "", "notice");
  const r = await call("flight_book", { search_id: 1, option: 1, traveler_ids: [id] });
  assert.equal(r.blocked, "not_their_turn");
});

// ---------- flight_book: the whole road, from a Fli search option to AgentCard's cart ----------

const OPTION = {
  option: 1, price: "$173", airline: "American", flights: "AA1234 JFK→BOS",
  legs: [{ from: "JFK", to: "BOS", depart: "2026-11-12T08:07", arrive: "2026-11-12T09:25", airline: "AA", flight_number: "1234" }],
  link: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20BOS", key: "AA1234@2026-11-12",
};
const searchFor = (c = OMARI, option = OPTION, sent = {}) => db.recordFlightSearch(c, {
  kind: "flights", outcome: "ok", found: 4, options: [option],
  params: { asked: {}, sent: { origin: "JFK", destination: "BOS", departure_date: "2026-11-12", cabin: "ECONOMY", adults: 1, children: 0, infants_in_seat: 0, infants_on_lap: 0, ...sent } },
});
const verified = (over = {}) => async () => ({ ok: true, still_there: true, price_then: "$173", price_now: "$173", moved: false, ...over });
const book = (input, verify = verified(), c = OMARI) => runTool("flight_book", input, { conversationId: c, messages, flightVerify: verify, judge: async () => ({ verdict: "yes" }) });
const recordedTurns = () => [F.recorded("1-search"), F.recorded("2-pick"), F.recorded("3-passenger")];

test("flight_book: fresh quote → AgentCard search → the exact flight picked by its legs → the confirmed passenger sent → the cart's own numbers", async () => {
  const id = await confirmedTraveler();
  const sid = searchFor();
  say("book the 8:07 for me");
  const asks = fake.state.asks.length;
  fake.set({ turns: recordedTurns() });
  const out = await book({ search_id: sid, option: 1, traveler_ids: [id] });
  assert.equal(out.ok, true, JSON.stringify(out));
  const sent = fake.state.asks.slice(asks);
  assert.equal(sent.length, 3);
  assert.match(sent[0].ask, /JFK to BOS departing 2026-11-12 08:07/);
  assert.deepEqual(sent[1].pick, { product_id: "p_36d273f8ae8a" }, "the exact offer, by AgentCard's own id");
  assert.match(sent[2].ask, /Testy Spikeson .*1990-01-15.*not any saved earlier/);
  assert.equal(out.total, "$177.47");
  assert.equal(out.price.final, true);
  assert.ok(out.price_lines.includes("fees (AgentCard gives one figure, no breakdown): $4.33"));
  assert.match(out.note, /Fare rules were not verified/);
  assert.match(out.note, /Google Flights/);
  assert.equal(out.google_flights_link, OPTION.link);
  const row = db.getAgentcardPurchase(out.conversation_id);
  assert.equal(row.kind, "flight");
  assert.equal(row.ticketing_state, "quoted");

  // …and on through the one payment path, to the recorded sandbox decline.
  const { yes } = await yesFor({ conversation_id: out.conversation_id, cart: { hash: out.cart_hash, total: out.total, total_cents: out.price.total_cents } });
  fake.set({ confirms: [{ body: F.recorded("4-confirm-sandbox") }] });
  const confirmed = await call("purchase_confirm", { conversation_id: out.conversation_id, cart_hash: out.cart_hash, confirmation_id: yes });
  assert.equal(confirmed.decline_code, "sandbox_mode", JSON.stringify(confirmed));
});

test("flight_book: a moved price stops before AgentCard is asked anything, until they say go on at the new price", async () => {
  const id = await confirmedTraveler();
  const sid = searchFor();
  say("book it");
  const asks = fake.state.asks.length;
  const moved = await book({ search_id: sid, option: 1, traveler_ids: [id] }, verified({ moved: true, price_now: "$198", change: "up $25" }));
  assert.equal(moved.blocked, "price_moved");
  assert.match(moved.error, /\$198 now \(was \$173\)/);
  assert.equal(fake.state.asks.length, asks, "AgentCard was not asked");
  fake.set({ turns: recordedTurns() });
  const ok = await book({ search_id: sid, option: 1, traveler_ids: [id], continue_at_new_price: true }, verified({ moved: true, price_now: "$198" }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("flight_book: a search that could not re-check, or a flight that is gone, books nothing and hands over the link", async () => {
  const id = await confirmedTraveler();
  const sid = searchFor();
  say("book it");
  const asks = fake.state.asks.length;
  const blocked = await book({ search_id: sid, option: 1, traveler_ids: [id] }, async () => ({ ok: false, error: "Google is rate-limiting", stale: true }));
  assert.equal(blocked.blocked, "quote_unverified");
  assert.match(blocked.error, /Google Flights link/);
  const gone = await book({ search_id: sid, option: 1, traveler_ids: [id] }, verified({ still_there: false }));
  assert.equal(gone.blocked, "flight_gone");
  assert.equal(fake.state.asks.length, asks);
});

test("flight_book: AgentCard not offering the same legs is said as that, with the link — never a near match", async () => {
  const id = await confirmedTraveler();
  const sid = searchFor(OMARI, { ...OPTION, legs: [{ ...OPTION.legs[0], depart: "2026-11-12T08:15" }] });
  say("book it");
  fake.set({ turns: recordedTurns() });
  const out = await book({ search_id: sid, option: 1, traveler_ids: [id] });
  assert.equal(out.blocked, "not_offered", JSON.stringify(out));
  assert.match(out.error, /Google Flights link/);
  fake.set({ turns: [] });
});

test("flight_book: an estimated total is never offered for approval", async () => {
  const id = await confirmedTraveler();
  const sid = searchFor();
  say("book it");
  fake.set({ turns: [F.recorded("1-search"), F.recorded("2-pick"), F.estimateTurn()] });
  const out = await book({ search_id: sid, option: 1, traveler_ids: [id] });
  assert.equal(out.blocked, "total_not_final", JSON.stringify(out));
  assert.match(out.error, /Do NOT ask them to approve it/);
});

test("flight_book: unconfirmed travelers, a seat count that doesn't match, children, and another person's search all refuse", async () => {
  say("book it, I'm Testy");
  const raw = await call("flight_traveler_save", TESTY);
  const sid = searchFor();
  assert.equal((await book({ search_id: sid, option: 1, traveler_ids: [raw.traveler_id] })).blocked, "travelers_not_confirmed");
  const id = await confirmedTraveler();
  say("book it");
  assert.equal((await book({ search_id: searchFor(OMARI, OPTION, { adults: 2 }), option: 1, traveler_ids: [id] })).blocked, "traveler_count");
  assert.equal((await book({ search_id: searchFor(OMARI, OPTION, { children: 1 }), option: 1, traveler_ids: [id] })).blocked, "party_not_supported");
  const kofis = searchFor(KOFI);
  const theirs = await book({ search_id: kofis, option: 1, traveler_ids: [id] });
  assert.equal(theirs.ok, false);
  assert.match(theirs.error, /no option 1 in flight search/);
});

test("the search result offers both ways to finish only when booking is on — and search-only words when it is off", async () => {
  const desc = (on) => { config.flightBooking = on; try { return toolsFor(OMARI).find(t => t.name === "flight_search").description; } finally { config.flightBooking = true; } };
  assert.match(desc(false), /SEARCH ONLY — Reason never books/);
  const on = desc(true);
  assert.doesNotMatch(on, /Reason never books/);
  assert.match(on, /Two ways to finish/);
  assert.match(on, /without pushing either/);
});

test("a fare that moved at the confirm (409) is a fresh flight_book, never a confirm of the new cart on the old yes", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  const { yes } = await yesFor(t);
  const dearer = { ...F.recorded("3-passenger").cart, totalCents: 18990, approvedCeilingCents: 18990, hash: "dearer000000001" };
  fake.set({ confirms: [{ httpStatus: 409, body: { error: "the cart's price changed since it was shown", code: "cart_price_changed", cart: dearer, carts: [dearer] } }] });
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.equal(out.blocked, "cart_changed", JSON.stringify(out));
  assert.match(out.error, /\$189\.90/);
  assert.match(out.error, /flight_book again/);
  const before = fake.state.confirmCalls.length;
  const again = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash, confirmation_id: yes });
  assert.equal(again.blocked, "quote_stale", JSON.stringify(again));
  assert.equal(fake.state.confirmCalls.length, before);
});

test("an unknown outcome stays unknown however much later: no fresh quote, no new yes, no new flight priced", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  db.markAgentcardPurchase(t.conversation_id, { status: "outcome_unknown" });
  // Long past the quote window: still said as unknown, never "the price is stale, quote again".
  tick(config.flightQuoteMaxAgeMs + 60_000);
  const before = fake.state.confirmCalls.length;
  const late = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash });
  assert.equal(late.blocked, "outcome_unknown", JSON.stringify(late));
  assert.equal(late.use_target, undefined, "no yes is collected for it");
  assert.doesNotMatch(late.error, /flight_book again/);
  // And no second flight is priced while the first may already be a booking.
  const sid = searchFor();
  say("ok just book it again then");
  const asks = fake.state.asks.length;
  const again = await book({ search_id: sid, option: 1, traveler_ids: [id] });
  assert.equal(again.blocked, "outcome_unknown", JSON.stringify(again));
  assert.equal(again.conversation_id, t.conversation_id);
  assert.equal(fake.state.asks.length, asks, "AgentCard was not asked");
  assert.equal(fake.state.confirmCalls.length, before, "nothing was confirmed");
  db.markAgentcardPurchase(t.conversation_id, { status: "declined", declineCode: "test_settled" });
});

test("a placed flight order is never confirmed again, even after the quote window", async () => {
  const id = await confirmedTraveler();
  const t = await flightRow(F.recorded("3-passenger"), [id]);
  db.markAgentcardPurchase(t.conversation_id, { status: "placed", orderId: "ord_flight_x" });
  tick(config.flightQuoteMaxAgeMs + 60_000);
  const out = await call("purchase_confirm", { conversation_id: t.conversation_id, cart_hash: t.cart.hash });
  assert.equal(out.blocked, "already_placed", JSON.stringify(out));
  assert.doesNotMatch(out.error, /flight_book again/);
});
