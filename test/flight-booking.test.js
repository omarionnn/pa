// What is left of flight booking now that there is no booking route (src/flightbook.js): the switch
// and the route it needs, travelers (read-back, confirmation, sealing, isolation), the booking states,
// and the refusals that keep a flight from ever being bought through AgentCard. AgentCard's flight
// route (flight_book) was removed 2026-11-11; the fake AgentCard (test/fixture-agentcard.js) is here
// only to prove its general purchase tools refuse a flight. No key, no network beyond 127.0.0.1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentCard } from "./fixture-agentcard.js";

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
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const KOFI = "dm:kofi";
let fake, messages, now0;
const owner = (t) => ({ role: "user", content: "[Sat, Oct 24, 2026, 9:30 PM] Omari: " + t });
const call = (name, input, c = OMARI) => runTool(name, input, { conversationId: c, messages, judge: async () => ({ verdict: "yes" }) });
const say = (t, c = OMARI) => { messages = [...(messages ?? []), owner(t)]; offers.beginTurn(c, t, "user"); };
const tick = (ms) => { clock.now = ((t) => () => t)(clock.now() + ms); };

const TESTY = { given_name: "Testy", family_name: "Spikeson", born_on: "1990-01-15", gender: "m", email: "spike-test@example.com", phone: "+12025550143" };

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

before(async () => {
  now0 = clock.now;
  fake = await startAgentCard();
  config.agentcardClientId = "ac-client-flights";
  config.agentcardClientSecret = "ac-secret-flights";
  config.agentcardApiBase = fake.url;
  config.publicUrl = "";
  config.maxSpendPerDay = 1000;
  config.flightBooking = true;
  fb._setRoute("test");   // a stand-in route: the parts a real one will reuse are driven through it
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
after(async () => { clock.now = now0; config.flightBooking = false; fb._setRoute(null); await fake.close(); rmSync(dir, { recursive: true, force: true }); });

// ---------- the booking states ----------

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

test("isolation: one person's travelers are never listed, confirmed, changed or deleted from another's Reason", async () => {
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
});

// ---------- the switch: the flag AND a booking route ----------

const TRAVELER_TOOLS = ["flight_traveler_save", "flight_traveler_confirm", "flight_travelers", "flight_traveler_forget"];
const names = (c) => toolsFor(c).map(t => t.name);
const searchWords = (c) => toolsFor(c).find(t => t.name === "flight_search").description;

test("there is no booking route: with the flag on for everyone, nobody sees or runs a flight tool, and no mail is read", async () => {
  fb._setRoute(null);
  try {
    assert.equal(fb.bookingRoute(), null);
    for (const c of [OMARI, KOFI]) {
      assert.equal(fb.bookingEnabled(c), false);
      for (const n of TRAVELER_TOOLS) assert.ok(!names(c).includes(n), `${c} ${n}`);
      assert.match(searchWords(c), /SEARCH ONLY — Reason never books/);
    }
    say("book it, here are my details");
    const r = await call("flight_traveler_save", TESTY);
    assert.equal(r.blocked, "not_available");
    assert.match(r.error, /Google Flights link/);
    const tc = await import("../src/ticketcheck.js");
    const seen = [];
    await tc.checkTickets({ now: clock.now(), tell: async () => ({ ok: true }), gmail: { search: async (...a) => { seen.push(a); return []; } }, read: async () => null });
    assert.equal(seen.length, 0, "the e-ticket check reads nothing without a route");
  } finally { fb._setRoute("test"); }
});

test("AgentCard's flight tool is gone: flight_book is not a tool for anyone, whatever the flag or the route", async () => {
  for (const flag of [true, "owner", false]) {
    config.flightBooking = flag;
    try {
      for (const c of [OMARI, KOFI]) assert.ok(!names(c).includes("flight_book"), `${flag} ${c}`);
    } finally { config.flightBooking = true; }
  }
  say("book option 1");
  const r = await call("flight_book", { search_id: 1, option: 1, traveler_ids: [1] });
  assert.notEqual(r?.ok, true, JSON.stringify(r));
  assert.equal(fake.state.confirmCalls.length, 0, "nothing was sent to AgentCard");
});

test("flag off: no traveler tool is shown or runs", async () => {
  config.flightBooking = false;
  try {
    for (const n of TRAVELER_TOOLS) assert.ok(!names(OMARI).includes(n), n);
    say("book it");
    const r = await call("flight_traveler_save", TESTY);
    assert.equal(r.blocked, "not_available");
    assert.match(r.error, /Google Flights link/);
  } finally { config.flightBooking = true; }
  for (const n of TRAVELER_TOOLS) assert.ok(names(OMARI).includes(n), n);
});

test("REASON_FLIGHT_BOOKING=owner: with a route, the owner has the traveler tools; anyone else sees none and is refused, exactly as off", async () => {
  config.flightBooking = "owner";
  try {
    for (const n of TRAVELER_TOOLS) assert.ok(names(OMARI).includes(n), n);
    assert.equal(fb.bookingEnabled(OMARI), true);
    assert.ok(await confirmedTraveler(OMARI));
    for (const n of TRAVELER_TOOLS) assert.ok(!names(KOFI).includes(n), n);
    assert.equal(fb.bookingEnabled(KOFI), false);
    assert.equal(fb.bookingEnabled(), false, "no conversation is never the owner");
    say("book it, here are my details", KOFI);
    const r = await call("flight_traveler_save", TESTY, KOFI);
    assert.equal(r.blocked, "not_available");
    assert.match(r.error, /Google Flights link/);
  } finally { config.flightBooking = true; }
  // On (1/true/on/yes): everyone. Off: no one.
  for (const n of TRAVELER_TOOLS) { assert.ok(names(OMARI).includes(n), n); assert.ok(names(KOFI).includes(n), n); }
  config.flightBooking = false;
  try {
    for (const n of TRAVELER_TOOLS) { assert.ok(!names(OMARI).includes(n), n); assert.ok(!names(KOFI).includes(n), n); }
  } finally { config.flightBooking = true; }
});

test("a flight search is search only, flag on or off: the Google Flights link is the one way to book", async () => {
  for (const flag of [true, "owner", false]) {
    config.flightBooking = flag;
    try {
      const d = searchWords(OMARI);
      assert.match(d, /SEARCH ONLY — Reason never books/, String(flag));
      assert.doesNotMatch(d, /flight_book|Two ways to finish|AgentCard/, String(flag));
    } finally { config.flightBooking = true; }
  }
});

// ---------- a flight is never bought through AgentCard ----------

/** An AgentCard answer whose catalog is its flights merchant — the one field the refusal reads. */
const FLIGHT_CATALOG_TURN = {
  conversation_id: "conv_flightcatalog0001", status: "needs_input", reply: "Here are some flights.", messages: [],
  cart: null, carts: [], unmatched: [],
  catalog: { merchant: "flights", merchant_name: "Agentcard Flights", store: null, items: [], as_of: "2026-10-25T01:45:19.026Z", presented: true },
};

test("the generic purchase tool never carts a flight — by AgentCard's merchant slug", async () => {
  say("buy me a flight to boston");
  fake.set({ turns: [FLIGHT_CATALOG_TURN] });
  const r = await call("purchase", { ask: "a flight from JFK to BOS on Nov 12", address_street: "1 Main St", address_city: "New York", address_state: "NY", address_zip: "10001", address_phone: "+12025551234" });
  assert.equal(r.blocked, "flight_not_here", JSON.stringify(r));
  assert.doesNotMatch(r.error, /flight_book/);
  assert.match(r.error, /Google Flights link/);
});

test("purchase_confirm never confirms a flight: a flight row an older build left, or a flight cart on any row, is refused and nothing is sent", async () => {
  // A row exactly as the removed flight_book left one.
  db.recordAgentcardPurchase({ conversationId: OMARI, buyConversationId: "conv_old_flight_row", status: "cart_shown", cartHash: "h_old", amountCents: 17747, merchant: "Agentcard Flights", what: "JFK to BOS, for Testy S." });
  db.markAgentcardPurchase("conv_old_flight_row", { kind: "flight", cartJson: JSON.stringify({ merchant: "flights", total_cents: 17747, ceiling_cents: 17747 }), travelerIds: "[1]", travelerFp: "abc", quoteCheckedAt: clock.now(), ticketingState: "quoted" });
  // And an ordinary row whose cart is AgentCard's flights merchant.
  db.recordAgentcardPurchase({ conversationId: OMARI, buyConversationId: "conv_stray_flight_cart", status: "cart_shown", cartHash: "h_stray", amountCents: 9900, merchant: "Agentcard Flights", what: "a flight" });
  db.markAgentcardPurchase("conv_stray_flight_cart", { cartJson: JSON.stringify({ merchant: "flights" }) });
  const before = fake.state.confirmCalls.length;
  for (const [conv, hash] of [["conv_old_flight_row", "h_old"], ["conv_stray_flight_cart", "h_stray"]]) {
    say("yes book it");
    const out = await call("purchase_confirm", { conversation_id: conv, cart_hash: hash });
    assert.equal(out.blocked, "flight_not_here", JSON.stringify(out));
    assert.match(out.error, /doesn't book flights here/);
    assert.match(out.error, /Nothing was charged/);
    assert.equal(out.use_target, undefined, "no target to collect a yes for");
  }
  assert.equal(fake.state.confirmCalls.length, before, "nothing was sent to AgentCard");
});

// ---------- privacy: sealed in the ledger, the log, the export ----------

test("passenger details never reach the action ledger or the tool log; ids and states do", async () => {
  const { sealTravelers } = await import("../src/privacy.js");
  const trust = await import("../src/trust.js");
  const back = fb.readBack({ ...TESTY, label: "Testy S." });
  const rowId = trust.ledgerWrite({ conversationId: OMARI, action: "flight_traveler_confirm", input: { traveler_ids: [7], said: "yes" }, out: { ok: false, blocked: "travelers_not_confirmed", error: `Not yet: read it back — "${back}"`, travelers: [back], search_id: 3 } });
  const row = db.db.prepare("SELECT * FROM action_ledger WHERE id = ?").get(typeof rowId === "object" ? rowId.id : rowId);
  const all = JSON.stringify(row);
  for (const secret of ["1990-01-15", "Spikeson", "spike-test@example.com", "+12025550143"]) assert.ok(!all.includes(secret), `${secret} leaked: ${all.slice(0, 300)}`);
  assert.ok(all.includes("travelers_not_confirmed"));
  const logged = sealTravelers("flight_traveler_save", { ...TESTY, label: "Testy S." });
  assert.equal(logged.born_on, "[sealed]");
  assert.equal(logged.label, "Testy S.");
  assert.deepEqual(sealTravelers("web_search", { q: "Spikeson" }), { q: "Spikeson" }, "other tools are untouched");
});

test("an export carries the bookings and the passengers it has, with the passenger details still sealed; a delete takes them", async () => {
  const data = await import("../src/data.js");
  await confirmedTraveler(KOFI);
  const out = data.exportData({ conversation: KOFI, audio: false, files: false });
  const rows = out.tables.flight_travelers;
  assert.ok(rows.length >= 1);
  assert.match(rows[0].details, /^\[not exported: passenger details stay sealed/);
  assert.ok(!JSON.stringify(out).includes("1990-01-15"));
  assert.ok("agentcard_purchases" in out.tables && "flight_ticket_watch" in out.tables);
  await data.deleteData({ conversation: KOFI });
  assert.equal(db.listFlightTravelers(KOFI).length, 0);
});
