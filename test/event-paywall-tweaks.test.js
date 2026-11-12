// Two follow-ups to the event paywall (owner, 2026-11-11; #491, REASON_EVENT_PAYWALL_TS):
//
//   1. A guest over this month's free conversations who texts event business — "can't make it", an RSVP
//      change, an answer to the host's question — gets through free: the turn runs, nothing is counted,
//      no pay line, and their own event tools work in that turn. Only a real ask of Reason counts.
//      (src/eventbusiness.js, read by meaning; with no read, only a reply inside a day of the event's
//      own line to them passes.)
//   2. A yes to the surprise-call offer of the event onboarding (#487, REASON_EVENT_ONBOARDING): that
//      first call is on Reason — placed even with the month's 2 free calls used or the conversations
//      over, and it does not use one of the 2. (src/plan.js giftCall, src/eventonboarding.js)
//
// Through the real router, runtime timer sweep, outbox and database; the model's turn and the side
// read are stated.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-paywall-tweaks-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_TOKEN_KEY = "55".repeat(32);
process.env.REASON_EVENTS = "on";
process.env.REASON_WELCOME_CARDS = "on";
process.env.REASON_PAYWALL = "on";
process.env.REASON_FREE_TIER = "monthly";
process.env.REASON_PAYWALL_SHIP_TS = "2026-10-31T00:00:00Z";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_PRICE_ID = "price_test_2499";
process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.test/reason";
delete process.env.REASON_AUTO_ADMIT;

const events = await import("../src/events.js");
const eo = await import("../src/eventonboarding.js");
const plan = await import("../src/plan.js");
const accounts = await import("../src/accounts.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const eventbiz = await import("../src/eventbusiness.js");
const { runTool } = await import("../src/tools.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
const OWNER_C = config.ownerConversation;
const DAY = 24 * 3_600_000;
const MIN = 60_000;
let n = 0;
const newNumber = () => `+1646556${String(1000 + (n++)).slice(-4)}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  config.web = true;
  config.onboarding = "on";
  config.autoAdmit = true;
  config.testNumbers = [];
  process.env.REASON_EVENT_ONBOARDING = "on";
  // The cut-off: a minute ago. Everything made in a test is after it unless dated back on purpose.
  process.env.REASON_EVENT_PAYWALL_TS = String(clock.now() - MIN);
  db.db.exec(`DELETE FROM accounts; DELETE FROM plan; DELETE FROM usage; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations; DELETE FROM timers;
    DELETE FROM inbound_messages; DELETE FROM access_requests; DELETE FROM event_onboarding;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(OWNER_C);
  db.upsertThread({ conversationId: OWNER_C, channel: "fake", address: MASTER, isOwner: true });
});

function harness({ reply = "got it!", business = null, inTurn = null } = {}) {
  const turns = [], reads = [];
  const runtime = new Runtime({
    runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); if (inTurn) await inTurn(conversationId); return reply; },
    screen: async () => ({ verdict: "clear" }),
  });
  // The side reads, stated: "did they use Reason for other things" (the morning after) and "is this
  // event business" (src/eventbusiness.js). `business`: true | false | null (no read at all).
  const ask = async ({ prompt }) => {
    if (/since joining/.test(prompt)) return { value: { other: false } };
    if (/Their newest message/.test(prompt)) { reads.push(prompt); return business === null ? { error: "side model down" } : { value: { event_business: typeof business === "function" ? business(prompt) : business } }; }
    return { error: "no stated read" };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {} } });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel, turns, reads };
}
let seq = 0;
const texts = (from, body) => ({ channel: "fake", externalId: `p${++seq}`, from, text: body, at: clock.now() });
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to);
const show = (m) => m.carousel ? `[carousel ${m.carousel.length}]` : m.media?.url ? `${m.text} [card]` : m.text;
function localDate(ms) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms); }
function makeEvent(organizer = OWNER_C) {
  const out = events.create(organizer, {
    name: "Rooftop Dinner", description: "dinner on the roof", starts_at: `${localDate(Date.now() + 2 * DAY)}T19:00`, location: "12 Elm St",
    welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: false,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.event;
}
async function joinByText(h, ev, num, name = "Esi") {
  const claim = events.makeClaim({ ev, displayName: name });
  return await h.router.deliver(texts(num, events.claimText(ev, claim.code)));
}
const conv = (num) => db.accountByAddress("fake", num)?.conversation_id;
const used = (c) => plan.status(c).sessions_used;
/** Over this month's 20: the plan row says 21 conversations in the current month, last text 40 minutes ago. */
function overCeiling(c) {
  const now = clock.now();
  accounts.countUse(c, "turn", 0);
  db.db.prepare("INSERT OR IGNORE INTO plan (conversation_id, sessions_used, first_seen_at, status, updated_at) VALUES (?, 0, ?, 'trial', ?)").run(plan.planId(c), now, now);
  const start = plan.periodOf(plan.row(c).first_seen_at, now).start;
  db.db.prepare("UPDATE plan SET sessions_used = 21, period_sessions = 21, period_start = ?, last_inbound_at = ? WHERE conversation_id = ?").run(start, now - 40 * MIN, plan.planId(c));
  assert.equal(plan.status(c).status, "lapsed");
}
async function hostMessage(h, ev, c, body = "doors at 7, bring a jacket") {
  const message = db.insertEventMessage(ev.id, "blast", events.blastBody(ev, body));
  return await events.deliver({ runtime: h.runtime, message, conversationId: c });
}


const PAY = /buy\.stripe|24\.99/;
async function guest(h, ev, name = "Esi") {
  const num = newNumber();
  await joinByText(h, ev, num, name);
  return { num, c: conv(num) };
}
/** The month's 2 free calls, used. */
function callsUsed(c) { accounts.countUse(c, "turn"); plan.noteCall(c); plan.noteCall(c); assert.equal(plan.status(c).calls_left, 0); }
/** Walk a guest to the call offer: the morning after, their reply to "how was it?", the cards, the offer. */
async function toOffer(h, ev, num, c) {
  const at = eo.morningAfter(db.getEventRow(ev.id), c);
  clock.skip(at + 60_000 - clock.now());
  await h.runtime.tick();
  assert.equal(eo.rowOf(c).state, "asked");
  await h.router.deliver(texts(num, "so fun!"));
  assert.equal(eo.rowOf(c).state, "offered");
}

// ---------- 1. event business is free ----------

test("over the ceiling, \"can't make it\": the turn runs, no pay line, nothing counted, and their event tools work in that turn only", async () => {
  const seen = {};
  const h = harness({ business: true, inTurn: async (c) => {
    seen.leave = await plan.gate(c, "event_leave");
    seen.answer = await plan.gate(c, "event_answer");
    seen.host = await plan.gate(c, "event_blast");
    seen.other = await plan.gate(c, "email_send");
  } });
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  overCeiling(c);
  const counted = plan.row(c).period_sessions, mark = sentTo(h, num).length;
  await h.router.deliver(texts(num, "so sorry, can't make it anymore"));
  assert.equal(h.turns.length, 1, "the normal turn answers it");
  assert.match(h.turns[0].text, /about an event they are a guest at/);
  const out = sentTo(h, num).slice(mark).map(show);
  assert.deepEqual(out, ["got it!"]);
  assert.ok(!out.some(t => PAY.test(t)), "no pay line");
  assert.equal(plan.row(c).period_sessions, counted, "not one of their conversations");
  assert.equal(seen.leave, null, "event_leave is not refused in the free turn");
  assert.equal(seen.answer, null, "event_answer is not refused in the free turn");
  assert.equal(seen.host?.blocked, "trial_over", "a host's tool is still refused");
  assert.equal(seen.other?.blocked, "trial_over", "anything else that acts is still refused");
  assert.equal((await plan.gate(c, "event_leave"))?.blocked, "trial_over", "after the turn the gate is whole again");
});

test("over the ceiling, an RSVP change and an answer to the host's question both get through free", async () => {
  const h = harness({ business: true });
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  overCeiling(c);
  const counted = plan.row(c).period_sessions;
  await hostMessage(h, ev, c, "quick one: any allergies?");
  const mark = sentTo(h, num).length;
  await h.router.deliver(texts(num, "no allergies, but i'm bringing a plus one now"));
  clock.skip(45 * MIN);
  await h.router.deliver(texts(num, "actually make that just me"));
  assert.equal(h.turns.length, 2);
  assert.ok(!sentTo(h, num).slice(mark).some(m => PAY.test(m.text ?? "")), "no pay line on either");
  assert.equal(plan.row(c).period_sessions, counted);
  assert.match(h.reads[0], /any allergies\?/, "the read sees the host's line they are answering");
});

test("over the ceiling, a real ask of Reason still meets the ceiling: no turn, the one line + link", async () => {
  const h = harness({ business: false });
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  overCeiling(c);
  const mark = sentTo(h, num).length;
  await h.router.deliver(texts(num, "can you book me a table friday?"));
  assert.equal(h.turns.length, 0, "no model turn");
  assert.equal(h.reads.length, 1, "it was read, and it is not event business");
  assert.ok(sentTo(h, num).slice(mark).some(m => PAY.test(m.text ?? "")), "the pay line");
  assert.equal(await plan.gate(c, "event_leave").then(r => r?.blocked), "trial_over", "nothing was waived");
});

test("no read is made for anybody it cannot matter to: a guest under the ceiling (counted as usual), and somebody over it who is at no event", async () => {
  const h = harness({ business: true });
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  clock.skip(40 * MIN);
  const before = used(c);
  await h.router.deliver(texts(num, "can't make it, sorry!"));
  assert.equal(h.reads.length, 0, "under the ceiling: no read");
  assert.equal(used(c), before + 1, "and it counts like any conversation");
  // Over the ceiling, but they left the event: an ordinary person over the ceiling.
  db.db.prepare("UPDATE event_attendees SET state = 'left' WHERE conversation_id = ?").run(c);
  overCeiling(c);
  const mark = sentTo(h, num).length, turns = h.turns.length;
  await h.router.deliver(texts(num, "can't make it"));
  assert.equal(h.reads.length, 0, "no event: no read");
  assert.equal(h.turns.length, turns);
  assert.ok(sentTo(h, num).slice(mark).some(m => PAY.test(m.text ?? "")));
});

test("the host of an event is not its guest: over the ceiling their texts meet it as before", async () => {
  const h = harness({ business: true });
  const hostNum = newNumber();
  await h.router.deliver(texts(hostNum, "hi"));
  const hc = conv(hostNum);
  makeEvent(hc);
  overCeiling(hc);
  assert.deepEqual(eventbiz.guestEvents(hc), []);
  const turns = h.turns.length;
  await h.router.deliver(texts(hostNum, "push the dinner to 8"));
  assert.equal(h.turns.length, turns);
  assert.equal(h.reads.length, 0);
});

test("an event long over is no longer event business", async () => {
  const h = harness({ business: true });
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  clock.skip(db.getEventRow(ev.id).starts_at - clock.now() + eventbiz.AFTER_MS + DAY);
  overCeiling(c);
  const mark = sentTo(h, num).length;
  await h.router.deliver(texts(num, "that dinner was great"));
  assert.equal(h.reads.length, 0);
  assert.equal(h.turns.length, 0);
  assert.ok(sentTo(h, num).slice(mark).some(m => PAY.test(m.text ?? "")));
});

test("with no read (side model down): a reply inside a day of the host's message passes free; a text out of the blue meets the ceiling", async () => {
  const h = harness({ business: null });
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  overCeiling(c);
  const counted = plan.row(c).period_sessions;
  // Out of the blue (the join's own lines are the event's too: move past their day).
  clock.skip(eventbiz.REPLY_MS + 60 * MIN);
  let mark = sentTo(h, num).length;
  await h.router.deliver(texts(num, "what's a good ramen place?"));
  assert.equal(h.turns.length, 0, "no read and no event line to answer: the ceiling");
  assert.ok(sentTo(h, num).slice(mark).some(m => PAY.test(m.text ?? "")));
  // The host writes; their reply follows it.
  clock.skip(45 * MIN);
  await hostMessage(h, ev, c, "are you still coming?");
  mark = sentTo(h, num).length;
  await h.router.deliver(texts(num, "yes!! see you there"));
  assert.equal(h.turns.length, 1, "taken as the reply to the event's line");
  assert.ok(!sentTo(h, num).slice(mark).some(m => PAY.test(m.text ?? "")));
  assert.equal(plan.row(c).period_sessions, counted + 1, "only the ramen ask was counted");
});

// ---------- 2. the surprise call is on Reason ----------

test("a yes to the surprise-call offer: the call is placed with the month's 2 calls used, and it does not use one of the 2", async () => {
  const h = harness();
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  await toOffer(h, ev, num, c);
  callsUsed(c);
  const ctx = { conversationId: c, messages: [], kind: "user" };
  const refused = await runTool("call_place", { to: "+13475550000", goal: "say happy birthday to Kojo", facts: [] }, ctx);
  assert.equal(refused.blocked, "free_calls_used", "before the yes: the 2 are used");
  await h.router.deliver(texts(num, "yes!! call my friend kojo"));
  assert.equal(plan.giftedCall(c), true, "the yes set one call aside");
  assert.equal(await plan.callPlaceGate(c), null, "call_place is not refused for the month's calls");
  const out = await runTool("call_place", { to: "+13475550000", goal: "say happy birthday to Kojo", facts: [] }, ctx);
  assert.notEqual(out.blocked, "free_calls_used", JSON.stringify(out).slice(0, 300));
  assert.notEqual(out.blocked, "trial_over");
  // The call goes out (what call_place does once it is dialled): the free one is spent, the count stands.
  const calls = plan.row(c).period_calls;
  assert.equal(plan.useGiftCall(c), true);
  assert.equal(plan.row(c).period_calls, calls, "not one of the month's 2");
  assert.equal(plan.giftedCall(c), false, "one call, once");
  assert.equal(plan.useGiftCall(c), false);
  assert.equal((await plan.callPlaceGate(c))?.blocked, "free_calls_used", "the next call is refused as before");
});

test("with calls left, the free call still does not use one: 2 left before, 2 left after", async () => {
  const h = harness();
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  await toOffer(h, ev, num, c);
  await h.router.deliver(texts(num, "sure"));
  assert.equal(plan.status(c).calls_left, 2);
  // tools.js, once the call is dialled: `if (!plan.useGiftCall(c)) plan.noteCall(c)`.
  if (!plan.useGiftCall(c)) plan.noteCall(c);
  assert.equal(plan.status(c).calls_left, 2, "the surprise call was free");
  if (!plan.useGiftCall(c)) plan.noteCall(c);
  assert.equal(plan.status(c).calls_left, 1, "their next call is the first of their 2");
});

test("call_place spends the free call rather than counting it (the one line in src/tools.js)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.match(src, /if \(!plan\.useGiftCall\(c\)\) plan\.noteCall\(c\);/);
  assert.equal(src.match(/plan\.noteCall\(c\)/g).length, 1, "call_place counts a call in one place only");
});

test("a no to the offer sets nothing aside; an offer gone stale neither", async () => {
  const h = harness();
  const ev = makeEvent();
  const a = await guest(h, ev, "Esi");
  const b = await guest(h, ev, "Yaw");
  await toOffer(h, ev, a.num, a.c);
  await h.router.deliver(texts(b.num, "great night"));
  assert.equal(eo.rowOf(b.c).state, "offered");
  await h.router.deliver(texts(a.num, "no thanks"));
  assert.equal(plan.giftedCall(a.c), false);
  clock.skip(eo.OFFER_FRESH_MS + MIN);
  await h.router.deliver(texts(b.num, "yes do it"));
  assert.equal(plan.giftedCall(b.c), false, "two days on, a yes is not an answer to the offer");
});

test("the free call does not outlive the offer's two days", async () => {
  const h = harness();
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  await toOffer(h, ev, num, c);
  await h.router.deliver(texts(num, "yes"));
  assert.equal(plan.giftedCall(c), true);
  clock.skip(eo.OFFER_FRESH_MS + MIN);
  assert.equal(plan.giftedCall(c), false);
  callsUsed(c);
  assert.equal((await plan.callPlaceGate(c))?.blocked, "free_calls_used");
});

test("a guest over the ceiling who says yes: the texts that set the call up are not met by the pay line, call_place is not refused, and nothing is counted", async () => {
  const seen = [];
  const h = harness({ inTurn: async (c) => { seen.push({ call: await plan.gate(c, "call_place"), other: (await plan.gate(c, "email_send"))?.blocked }); } });
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  overCeiling(c);
  await toOffer(h, ev, num, c);
  const counted = plan.row(c).period_sessions, mark = sentTo(h, num).length, turns = h.turns.length;
  await h.router.deliver(texts(num, "yes!"));
  clock.skip(45 * MIN);
  await h.router.deliver(texts(num, "call kojo at 347 555 0000 and sing happy birthday"));
  assert.equal(h.turns.length, turns + 2, "both texts reach the turn");
  assert.ok(!sentTo(h, num).slice(mark).some(m => PAY.test(m.text ?? "")), "no pay line while the free call is being set up");
  assert.equal(plan.row(c).period_sessions, counted);
  assert.deepEqual(seen.slice(-2).map(s => s.call), [null, null], "call_place is let past the lapsed gate");
  assert.deepEqual(seen.slice(-2).map(s => s.other), ["trial_over", "trial_over"], "nothing else is");
  // Once the call is placed, the ceiling is back.
  assert.equal(plan.useGiftCall(c), true);
  clock.skip(45 * MIN);
  const m2 = sentTo(h, num).length;
  await h.router.deliver(texts(num, "now call my mum too"));
  assert.equal(h.turns.length, turns + 2, "no turn");
  assert.ok(sentTo(h, num).slice(m2).some(m => PAY.test(m.text ?? "")));
});

test("the set-up texts are few: a guest over the ceiling who never places the call gets CALL_SETUP_TURNS of them, then the ceiling", async () => {
  const h = harness();
  const ev = makeEvent();
  const { num, c } = await guest(h, ev);
  overCeiling(c);
  await toOffer(h, ev, num, c);
  await h.router.deliver(texts(num, "yes"));
  const turns = h.turns.length;
  for (let i = 0; i < eo.CALL_SETUP_TURNS + 1; i++) { clock.skip(31 * MIN); await h.router.deliver(texts(num, `hmm let me think ${i}`)); }
  assert.equal(h.turns.length, turns + eo.CALL_SETUP_TURNS);
  assert.ok(sentTo(h, num).some(m => PAY.test(m.text ?? "")), "then the one line + link");
});
