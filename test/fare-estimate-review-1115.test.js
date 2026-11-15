// Review of the 11-15 fare change (src/offers.js guardReply, labelled estimates): a labelled estimate
// stands only for a price they asked of a thing or a trip. These pin what it must never let through:
// an invented figure about their own money or records, a figure credited to a business or an app, an
// unlabelled figure riding on the label of the sentence after it, and a sent message to anyone.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-fare-review-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:fare-review";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const offers = await import("../src/offers.js");
const { runTool } = await import("../src/tools.js");

const C = "dm:fare-review";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM conversations; DELETE FROM event_log; DELETE FROM media_items; DELETE FROM person_facts;");
});

const TAXI = "How much is a taxi from the train station to 430 Example St";
/** The draft goes back once, then the rewrite is checked for the last time (the turn's reply). */
function lastCheck(rewrite, { own = TAXI, kind = "user" } = {}) {
  offers.beginTurn(C, own, kind);
  offers.guardReply(C, "A cab is about $75.", { turnReply: true });
  offers.beginTurn(C, "", kind, { carry: true });
  return offers.guardReply(C, rewrite, { turnReply: true });
}
const dropped = (g) => g.flags.find(f => f.rule === "dollar_dropped")?.figures ?? [];
const kept = (g) => g.flags.find(f => f.rule === "dollar_estimate_kept")?.figures ?? [];

test("a figure about their own money or records never stands as an 'estimate', asked or not", () => {
  const cases = [
    ["how much is in my checking", "You have about $2,400 in checking, my estimate based on the last 2 weeks."],
    ["how much is in my savings", "Savings should be around $8,100, my rough estimate assuming 3 deposits since June."],
    ["how much did I pay for the hotel", "The hotel came to about $640, my estimate based on 3 nights."],
    ["how much was I charged by Verizon", "Verizon hit your card for about $95, my estimate based on your usual plan."],
    ["how much do I owe Sam", "Your share is about $45, my estimate assuming dinner split 4 ways."],
    ["how much is my electric bill", "Your electric bill is about $130 this month, my estimate based on 30 days."],
    ["how much was the receipt", "The receipts add to about $88, my estimate based on 2 receipts."],
    ["how much is my Netflix subscription", "Your Netflix subscription is about $15.49, my estimate based on the standard plan."],
    ["how much is my rent", "Rent is about $1,900, my estimate based on 12 months."],
    ["how much will my refund be", "Refunds usually land around $120, my estimate based on 2 returns."],
    ["how much did I spend on food", "Food ran you about $300, my estimate based on 4 weeks of deposits."],
  ];
  for (const [own, rewrite] of cases) {
    const g = lastCheck(rewrite, { own });
    assert.equal(kept(g).length, 0, `${own} → ${g.text}`);
    assert.doesNotMatch(g.text, /\$\d/, `${own} → ${g.text}`);
  }
});

test("a figure credited to an app, a site or a business never stands as Reason's own estimate", () => {
  for (const rewrite of [
    "Uber is showing about $64, my estimate assuming 16 miles.",
    "Uber's estimated fare is $64 for the 16 miles.",
    "Joe's Taxi estimates about $64, assuming 16 miles.",
    "A quote from Joe's Taxi would be about $64, my estimate based on 16 miles.",
    "Their site lists about $64, my estimate assuming 16 miles.",
    "Lyft quotes about $64, my estimate assuming 16 miles.",
    "According to Lyft it's about $64, my estimate assuming 16 miles.",
  ]) {
    const g = lastCheck(rewrite);
    assert.equal(kept(g).length, 0, rewrite);
    assert.doesNotMatch(g.text, /\$64/, rewrite);
  }
});

test("one labelled estimate covers only itself: an unlabelled figure beside it still goes", () => {
  const g = lastCheck("The hotel there is $189 a night. My estimate for the cab is about $64, assuming 16 miles.");
  assert.deepEqual(dropped(g), ["$189"]);
  assert.deepEqual(kept(g), ["$64"]);
  assert.doesNotMatch(g.text, /\$189/);
  assert.match(g.text, /\$64/);
  assert.doesNotMatch(g.text, /couldn't confirm a price/, "a price is left, so no lead line");
  // An unlabelled figure whose next sentence labels its own number is not labelled by it.
  const h = lastCheck("Parking is $40. A cab is about $64, by my estimate, assuming 16 miles.");
  assert.deepEqual(dropped(h), ["$40"]);
  assert.match(h.text, /\$64/);
});

test("one hedge word is no label, and a label with nothing it assumes is no estimate", () => {
  for (const rewrite of ["A cab is roughly $64.", "A cab is about $64, give or take.", "Probably around $64 for the ride.", "A cab is about $64, my estimate."]) {
    const g = lastCheck(rewrite);
    assert.deepEqual(dropped(g), ["$64"], rewrite);
    assert.ok(g.text.startsWith(offers.PRICE_LEFT_OUT) || g.text === offers.PRICE_LEFT_OUT, g.text);
  }
});

test("only a price ask opens the door: time, debts, balances and a turn not theirs do not", () => {
  const rewrite = "It's about $64, my estimate assuming 16 miles.";
  for (const own of ["how much time do I have before the train", "how much longer is the drive", "how much do I owe Sam", "how much is in my checking", "what's my balance"]) {
    const g = lastCheck(rewrite, { own });
    assert.deepEqual(dropped(g), ["$64"], own);
    assert.doesNotMatch(g.text, /couldn't confirm a price/, `${own}: no price was asked, so no price line`);
  }
  for (const kind of ["brief", "agent", "system"]) assert.deepEqual(dropped(lastCheck(rewrite, { kind })), ["$64"], kind);
  // A price of a thing or a trip does open it.
  for (const own of ["how much is a flight to Denver in December", "what would a cab cost to JFK", "how much for a hotel near the venue"]) {
    assert.deepEqual(kept(lastCheck(rewrite, { own })), ["$64"], own);
  }
});

test("what leans on a dropped sentence goes; a sentence carrying a sourced figure stays", () => {
  offers.beginTurn(C, TAXI, "user");
  offers.noteSource(C, { snippet: "Metered fare: $3.00 initial charge, plus 70 cents per 1/5 mile." });
  offers.guardReply(C, "A cab is about $75.", { turnReply: true });
  offers.beginTurn(C, "", "user", { carry: true });
  const g = offers.guardReply(C, "A cab runs $64. That's the $3.00 flag drop plus the meter. Want me to call a car service?", { turnReply: true });
  assert.deepEqual(dropped(g), ["$64"]);
  assert.match(g.text, /\$3\.00 flag drop/, "the sourced figure is not taken with its neighbour");
  assert.doesNotMatch(g.text, /couldn't confirm a price/, "a sourced price is left, so no lead line");
});

test("never an empty reply, never the lead line twice, never the lead line with nothing but a link", () => {
  let g = lastCheck("A cab runs $64. That assumes 16 miles.");
  assert.equal(g.text, offers.PRICE_LEFT_OUT);
  g = lastCheck("A cab runs $64. That assumes 16 miles.\n\nI couldn't confirm the price, though. Want me to check?");
  assert.equal((g.text.match(/couldn't confirm/g) ?? []).length, 1, g.text);
  g = lastCheck("A cab runs $64.\n\nhttps://m.uber.com/ul/?action=setPickup");
  assert.ok(g.text.startsWith(offers.PRICE_NOT_GIVEN), g.text);
  assert.match(g.text, /m\.uber\.com/);
});

test("a check that is not the turn's reply keeps a labelled estimate's figure unsent (message_send, drafts)", () => {
  // message_send: guardReply without turnReply; anything it would send back is refused.
  offers.beginTurn(C, TAXI, "user");
  const text = "A cab should run about $64, my estimate assuming 16 miles.";
  for (const carry of [false, true]) {
    if (carry) offers.beginTurn(C, "", "user", { carry: true });
    const g = offers.guardReply(C, text, { asks: false });
    assert.ok(g.recompose, "still sent back");
    assert.ok(offers.sendBack(C, g.fixes), "and refused every time");
    assert.equal(g.text, text, "never edited in their name");
    assert.doesNotMatch(g.recompose, /may give your own estimate/, "no invitation to resend an estimate that is refused anyway");
  }
});

test("message_send of a labelled estimate, to them or to anybody else, is refused exactly as before", async () => {
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Tester", isOperator: true });
  const sent = [];
  const channels = { list: () => [{ name: "test" }], send: async (m) => { sent.push(m); return { ok: true, delivered: true }; } };
  offers.beginTurn(C, TAXI, "user");
  const messages = [{ role: "user", content: "[Sun, Nov 15, 2026, 1:00 PM] Tester: " + TAXI }];
  const out = await runTool("message_send", { to: "owner", text: "A cab should run about $64, my estimate assuming 16 miles." }, { conversationId: C, messages, channels, judge: async () => ({ verdict: "yes" }) });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.blocked, "unchecked_figures");
  assert.equal(sent.length, 0);
});

// Found in review, not fixed here (it is on main too, and needs the figure matched to what the fact is
// about, not a small change): a saved fact is read for every number in it, so a cab fare made up as
// "$60" stands as "remembered" on an unrelated fact that happens to say $60.
test("an invented fare does not stand on an unrelated saved fact with the same number", { todo: "figures are matched to saved facts by amount only (offers.js theirSources)" }, () => {
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Tester", isOperator: true });
  db.remember(C, "self", "The heaviest user costs about $60 per month");
  const g = lastCheck("A cab to JFK is $60.", { own: "how much is a cab to JFK" });
  assert.doesNotMatch(g.text, /\$60/);
});
