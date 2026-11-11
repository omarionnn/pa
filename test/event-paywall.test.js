// Event joiners pay like anybody else (owner, 2026-11-11, src/plan.js eventPaywallTs, REASON_EVENT_PAYWALL_TS):
//
//   somebody new who joins Reason through an EVENT from the cut-off on is on the monthly free tier, like
//   somebody who texted in on their own — not free for good; nothing is said to them about it
//   everybody who joined through an event before the cut-off keeps what they had (free for good)
//   invites are untouched: an invite from a free-for-good member still makes a free-for-good account
//   the event's own lines (the welcome, the join line, a host message, the morning after) never count
//   toward their conversations, and go out even to a guest over the ceiling; a reply to Reason's own
//   "how was it?" is not one of their conversations either; their own asks count, as for anyone
//
// Through the real router, runtime timer sweep, outbox and database; the model's turn is stated.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-paywall-"));
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

function harness({ reply = "glad it was fun!" } = {}) {
  const turns = [];
  const runtime = new Runtime({
    runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return reply; },
    screen: async () => ({ verdict: "clear" }),
  });
  const ask = async ({ prompt }) => {
    if (/since joining/.test(prompt)) return { value: { other: false } };
    return { error: "no stated read" };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {} } });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel, turns };
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
/** Over this month's 20: the plan row says 21 conversations in the current month. */
function overCeiling(c) {
  const now = clock.now();
  db.db.prepare(`INSERT INTO plan (conversation_id, sessions_used, first_seen_at, last_inbound_at, status, updated_at, period_start, period_sessions, period_calls)
    VALUES (?, 21, ?, ?, 'trial', ?, ?, 21, 0) ON CONFLICT(conversation_id) DO UPDATE SET sessions_used = 21, period_sessions = 21, period_start = excluded.period_start, last_inbound_at = excluded.last_inbound_at`)
    .run(plan.planId(c), now, now - 40 * MIN, now, now);
  assert.equal(plan.status(c).status, "lapsed");
}
async function hostMessage(h, ev, c, body = "doors at 7, bring a jacket") {
  const message = db.insertEventMessage(ev.id, "blast", events.blastBody(ev, body));
  return await events.deliver({ runtime: h.runtime, message, conversationId: c });
}

// ---------- who is free for good ----------

test("a new event joiner (after the cut-off) is on the free tier, not free for good — even on the operator's event; nothing said about it", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  assert.equal(db.getAccount(c).joined_via_event, ev.id);
  assert.equal(plan.grandfathered(c), false);
  const st = plan.status(c);
  assert.equal(st.status, "trial");
  assert.equal(st.monthly, true);
  assert.equal(st.left, plan.FREE_CONVERSATIONS);
  // Nothing on join mentions money, a trial or a limit.
  for (const m of sentTo(h, num)) assert.doesNotMatch(show(m), /\$|free|trial|limit|subscri|pay/i);
});

test("an event joiner from before the cut-off keeps free for good", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  // Ship the rule after they joined: they came in before it.
  process.env.REASON_EVENT_PAYWALL_TS = String(clock.now() + MIN);
  assert.equal(plan.grandfathered(c), true);
  assert.equal(plan.status(c).status, "free");
  // Dated back instead: same answer with the cut-off where it was.
  process.env.REASON_EVENT_PAYWALL_TS = String(clock.now() - MIN);
  assert.equal(plan.grandfathered(c), false);
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(clock.now() - 2 * MIN, c);
  assert.equal(plan.grandfathered(c), true);
});

test("the cut-off unset (or garbage): the old rule — an event a free-for-good member made still makes a free-for-good account", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  for (const v of ["", "not a date"]) {
    process.env.REASON_EVENT_PAYWALL_TS = v;
    assert.equal(plan.eventPaywallTs(), null);
    assert.equal(plan.grandfathered(c), true, JSON.stringify(v));
  }
  delete process.env.REASON_EVENT_PAYWALL_TS;
  assert.equal(plan.grandfathered(c), true);
  // Seconds and dates read as ms.
  process.env.REASON_EVENT_PAYWALL_TS = "1794000000";
  assert.equal(plan.eventPaywallTs(), 1794000000000);
  process.env.REASON_EVENT_PAYWALL_TS = "2026-11-11T23:00:00Z";
  assert.equal(plan.eventPaywallTs(), Date.parse("2026-11-11T23:00:00Z"));
});

test("invites are untouched: an invitee of a free-for-good member made after the cut-off is free for good; the operator and test numbers too", () => {
  const num = newNumber();
  const c = `dm:fake:${num}`;
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name: "Friend", isOperator: false });
  db.db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(OWNER_C, c);
  assert.ok(db.getAccount(c).created_at >= plan.eventPaywallTs());
  assert.equal(plan.grandfathered(c), true);
  assert.equal(plan.status(c).status, "free");
  // An invite AND an event on the same account: the invite is the way in, as before.
  const ev = makeEvent();
  db.db.prepare("UPDATE accounts SET joined_via_event = ? WHERE conversation_id = ?").run(ev.id, c);
  assert.equal(plan.grandfathered(c), true);
  // The next link down from a NEW event guest: the guest is on the free tier, so their invitee is too.
  const g = newNumber(), gc = `dm:fake:${g}`;
  db.upsertAccount({ conversationId: gc, channel: "fake", address: g, name: "Guest", isOperator: false });
  db.db.prepare("UPDATE accounts SET joined_via_event = ? WHERE conversation_id = ?").run(ev.id, gc);
  const i = newNumber(), ic = `dm:fake:${i}`;
  db.upsertAccount({ conversationId: ic, channel: "fake", address: i, name: "Chain", isOperator: false });
  db.db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(gc, ic);
  assert.equal(plan.grandfathered(gc), false);
  assert.equal(plan.grandfathered(ic), false);
  // The operator and a test number: free, event or not.
  assert.equal(plan.status(OWNER_C).status, "free");
  config.testNumbers = [g];
  assert.equal(plan.grandfathered(gc), true);
});

// ---------- the event's lines are not their conversations ----------

test("the join text, the welcome, the join line and a host message count nothing; the guest's own ask counts one", async () => {
  const h = harness({ reply: "it's at 12 Elm St" });
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  assert.ok(sentTo(h, num).length >= 2, "welcome + join line went");
  assert.equal(used(c), 0, "joining is not a conversation");
  clock.skip(3 * 3_600_000);
  const r = await hostMessage(h, ev, c);
  assert.notEqual(r.state, "failed");
  assert.ok(sentTo(h, num).some(m => /doors at 7/.test(m.text)));
  assert.equal(used(c), 0, "reading the host's message is not a conversation");
  await h.router.deliver(texts(num, "what's the address again?"));
  assert.equal(h.turns.length, 1);
  assert.equal(used(c), 1, "their own ask counts, as for anyone");
});

test("over the ceiling: host messages and the morning after still go; the reply to 'how was it?' gets its answer, not the pay line, and counts nothing; their own next ask meets the ceiling", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  overCeiling(c);
  const before = sentTo(h, num).length;
  await hostMessage(h, ev, c, "running 10 min late");
  assert.ok(sentTo(h, num).some(m => /running 10 min late/.test(m.text)), "the host's message reaches an over-the-ceiling guest");
  // The morning after.
  const at = eo.morningAfter(db.getEventRow(ev.id), c);
  clock.skip(at + 60_000 - clock.now());
  await h.runtime.tick();
  assert.deepEqual(sentTo(h, num).slice(before + 1).map(show), ["how was Rooftop Dinner?"], "A goes to them all the same");
  assert.equal(eo.rowOf(c).state, "asked");
  const counted = plan.row(c).period_sessions;
  await h.router.deliver(texts(num, "so fun!"));
  assert.equal(h.turns.length, 1, "the reply to A is answered by the normal turn");
  const after = sentTo(h, num).slice(before + 2).map(show);
  assert.equal(after[0], "glad it was fun!");
  assert.ok(!after.some(t => /buy\.stripe|24\.99/.test(t)), "no pay line on Reason's own onboarding");
  assert.equal(plan.row(c).period_sessions, counted, "not one of their conversations");
  assert.equal(eo.rowOf(c).state, "offered");
  // The answer to the call offer: Reason's too.
  await h.router.deliver(texts(num, "no thanks"));
  assert.equal(h.turns.length, 2);
  assert.equal(plan.row(c).period_sessions, counted);
  // Their own ask later: the ceiling, as for anyone.
  clock.skip(40 * MIN);
  const mark = sentTo(h, num).length;
  await h.router.deliver(texts(num, "can you book me a table friday?"));
  assert.equal(h.turns.length, 2, "no model turn over the ceiling");
  assert.ok(sentTo(h, num).slice(mark).some(m => /24\.99|stripe/.test(m.text)), "the one line + link");
});

test("a free-tier guest under the ceiling: the reply to 'how was it?' leaves the count where it was", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  const at = eo.morningAfter(db.getEventRow(ev.id), c);
  clock.skip(at + 60_000 - clock.now());
  await h.runtime.tick();
  assert.equal(eo.rowOf(c).state, "asked");
  await h.router.deliver(texts(num, "loved it"));
  assert.equal(used(c), 0);
  assert.equal(eo.awaitingReply(c), true, "the call offer is still open");
  await h.router.deliver(texts(num, "maybe later"));
  assert.equal(used(c), 0);
  assert.equal(eo.awaitingReply(c), false);
  clock.skip(40 * MIN);
  await h.router.deliver(texts(num, "remind me to call mom at 6"));
  assert.equal(used(c), 1);
  // accounts.countUse without visit counts the day's turn but no conversation.
  clock.skip(40 * MIN);
  clock.skip(40 * MIN);
  accounts.countUse(c, "turn", 1, { visit: false });
  assert.equal(used(c), 1);
});

test("a row stuck in 'asked' (the turn failed, no reply): only ONE uncounted reply, then their texts count", async () => {
  const h = harness({ reply: null });
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  const at = eo.morningAfter(db.getEventRow(ev.id), c);
  clock.skip(at + 60_000 - clock.now());
  await h.runtime.tick();
  assert.equal(eo.rowOf(c).state, "asked");
  await h.router.deliver(texts(num, "it was great"));
  assert.equal(used(c), 0, "the reply to A is free");
  assert.equal(eo.rowOf(c).state, "asked", "no reply went, so the row stays asked");
  clock.skip(40 * MIN);
  await h.router.deliver(texts(num, "can you find me a dentist"));
  assert.equal(used(c), 1, "not a second free turn");
  assert.equal(eo.claimFreeReply(c), false);
});
