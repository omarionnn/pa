// The event onboarding (src/eventonboarding.js, REASON_EVENT_ONBOARDING, owner 2026-11-11): somebody
// new who joins through an event link gets the organizer's welcome and ONE line from Reason, nothing
// asked; event things only while it lasts; the morning after, "how was {event}?", and only after they
// answer it, "i can do more than events…", the seven cards and the surprise-call offer. Once ever, never
// for existing or stopped people, never a nudge; off is exactly as before. Through the real router,
// runtime timer sweep, outbox and database; the model's turn and side reads are stated.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-onb-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_WELCOME_CARDS = "on";
delete process.env.REASON_EVENT_ONBOARDING;
delete process.env.REASON_AUTO_ADMIT;

const events = await import("../src/events.js");
const eo = await import("../src/eventonboarding.js");
const ob = await import("../src/onboarding.js");
const welcome = await import("../src/welcome.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { armNow } = await import("../scripts/event-after-now.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const AMA = "+13475550000";
const LINE = "+16562167455";
const OWNER_C = config.ownerConversation;
const AMA_C = `dm:fake:${AMA}`;
let n = 0;
const newNumber = () => `+1646555${String(1000 + (n++)).slice(-4)}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  config.web = true;
  config.onboarding = "on";
  config.testNumbers = [];
  process.env.REASON_EVENT_ONBOARDING = "on";
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations; DELETE FROM timers;
    DELETE FROM inbound_messages; DELETE FROM access_requests; DELETE FROM event_onboarding;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(OWNER_C);
  db.upsertThread({ conversationId: OWNER_C, channel: "fake", address: MASTER, isOwner: true });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: AMA, name: "Ama" });
  db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(AMA_C);
  db.upsertThread({ conversationId: AMA_C, channel: "fake", address: AMA, isOwner: true });
});

/** `other`: what the side read says about their texts since the join. */
function harness({ other = false, reply = "glad it was fun!", verdict = "clear" } = {}) {
  const turns = [];
  const reads = [];
  const runtime = new Runtime({
    runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return reply; },
    screen: async () => ({ verdict }),
  });
  const ask = async ({ prompt, system }) => {
    reads.push({ prompt, system });
    if (/Their name: /.test(prompt)) return { value: { line: "nice to meet you" } };
    if (/since joining/.test(prompt)) return typeof other === "function" ? other(prompt) : { value: { other } };
    return { error: "no stated read" };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {} } });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel, turns, reads };
}
/** Sendblue's carousel on the fake line. */
function withCarousel(h) {
  h.channel.sendCarousel = async ({ to, mediaUrls }) => {
    const delivered = { channel: "fake", to, text: "", carousel: mediaUrls, at: clock.now() };
    h.channel.sent.push(delivered);
    return { ok: true, supported: true, delivered };
  };
}
let seq = 0;
const texts = (from, body) => ({ channel: "fake", externalId: `m${++seq}`, from, text: body, at: clock.now() });
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to);
const show = (m) => m.carousel ? `[carousel ${m.carousel.length}]` : m.media?.url ? `${m.text} [card]` : m.text;

// An event two days from now at 7pm New York time, made by the owner (the welcome shows him as the host).
const DAY = 24 * 3_600_000;
function localDate(ms) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms); }
function makeEvent(organizer = OWNER_C, over = {}) {
  const out = events.create(organizer, {
    name: "Rooftop Dinner", description: "dinner on the roof", starts_at: `${localDate(Date.now() + 2 * DAY)}T19:00`, location: "12 Elm St",
    welcome_message: "so glad you're coming!", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: false, ...over,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.event;
}
async function joinByText(h, ev, num, name = "Esi") {
  const claim = events.makeClaim({ ev, displayName: name });
  return await h.router.deliver(texts(num, events.claimText(ev, claim.code)));
}
const conv = (num) => db.accountByAddress("fake", num)?.conversation_id;
const afterTimers = (c) => db.db.prepare("SELECT * FROM timers WHERE conversation_id = ? AND label = ? AND fired_at IS NULL AND cancelled_at IS NULL").all(c, eo.LABEL);
/** To the morning after: 10:00 New York the day after the event, plus a minute; then the runtime's sweep. */
async function toMorningAfter(h, ev, c) {
  const at = eo.morningAfter(db.getEventRow(ev.id), c);
  clock.skip(at + 60_000 - clock.now());
  await h.runtime.tick();
}

// ---------- the switch ----------

test("mode: unset/off/garbage → off, owner → owner, on/1/true → on", () => {
  for (const [v, m] of [[undefined, "off"], ["off", "off"], ["nah", "off"], ["owner", "owner"], ["OWNER", "owner"], ["on", "on"], ["1", "on"], ["true", "on"]]) {
    if (v === undefined) delete process.env.REASON_EVENT_ONBOARDING; else process.env.REASON_EVENT_ONBOARDING = v;
    assert.equal(eo.mode(), m, String(v));
  }
});

test("flag off is exactly as before: the welcome, then the first-chat onboarding; no line, no row, no timer", async () => {
  for (const flag of ["off", "owner"]) {
    process.env.REASON_EVENT_ONBOARDING = flag;
    const h = harness();
    const ev = makeEvent();
    const num = newNumber();
    const r = await joinByText(h, ev, num);
    assert.equal(r.event, "joined");
    const got = sentTo(h, num).map(show);
    assert.ok(got.includes(ob.INTRO), `${flag}: the old first chat runs for a stranger: ${got.join(" | ")}`);
    assert.ok(!got.some(t => /keep you posted/.test(t)), flag);
    assert.equal(eo.rowOf(conv(num)), null, flag);
    assert.equal(afterTimers(conv(num)).length, 0, flag);
    db.db.exec("DELETE FROM events; DELETE FROM event_claims; DELETE FROM event_attendees;");
  }
});

// ---------- on join ----------

test("on join: the organizer's welcome, then ONE line from Reason, nothing else — no question, no card, no cards, no turn", async () => {
  const h = harness();
  withCarousel(h);
  const ev = makeEvent();
  const num = newNumber();
  const r = await joinByText(h, ev, num, "Esi");
  assert.equal(r.event, "joined");
  assert.equal(r.eventOnboarding, "joined");
  const got = sentTo(h, num);
  assert.equal(got.length, 2, got.map(show).join(" | "));
  assert.match(got[0].text, /so glad you're coming/);
  assert.equal(got[1].text, "i'm Reason, i'll keep you posted on Rooftop Dinner. need the address, a ride, or to message Omari? just text me.");
  assert.ok(!got.some(m => m.media || m.carousel), "no contact card, no cards");
  assert.ok(!got.some(m => /\?$/.test(m.text) && !/need the address/.test(m.text)), "no question");
  assert.equal(h.turns.length, 0);
  const acct = db.getAccount(conv(num));
  assert.equal(acct.name, "Esi", "the name typed on the page is kept");
  assert.equal(acct.onboarding, null, "the first-chat flow never starts");
  assert.equal(acct.welcome_cards, null);
  assert.equal(eo.rowOf(acct.conversation_id).state, "joined");
  // The morning after: 10:00 New York, the day after the event, on the timer system.
  const [t] = afterTimers(acct.conversation_id);
  assert.ok(t, "a morning-after timer");
  assert.equal(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(t.fire_at), "10:00");
  assert.equal(localDate(t.fire_at), localDate(Date.now() + 3 * DAY));
  assert.equal(db.listTimers(acct.conversation_id).length, 0, "not one of their reminders");
  assert.match(JSON.stringify(db.loadConversation(acct.conversation_id)), /keep you posted/, "the line is in their history");
});

test("the host's first name only when the welcome shows the organizer; else 'the host'", () => {
  assert.equal(eo.JOIN_LINE("Game Night", eo.hostFirst("Kofi Mensah")), "i'm Reason, i'll keep you posted on Game Night. need the address, a ride, or to message Kofi? just text me.");
  assert.equal(eo.JOIN_LINE("Game Night", eo.hostFirst(null)), "i'm Reason, i'll keep you posted on Game Night. need the address, a ride, or to message the host? just text me.");
});

test("during the event: their questions get the normal turn, told they are a guest and not to pitch; no contact card", async () => {
  const h = harness({ reply: "it's at 12 Elm St" });
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  await h.router.deliver(texts(num, "what's the address again"));
  assert.equal(h.turns.length, 1);
  assert.match(h.turns[0].text, /are a guest/);
  assert.match(h.turns[0].text, /Do not pitch Reason/);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!sentTo(h, num).some(m => m.media), "no contact card while the event lasts");
  assert.equal(db.getAccount(conv(num)).contact_card_sent_at, null);
});

// ---------- the morning after ----------

test("morning after: A alone, then it WAITS; their reply → the normal answer, then B, the carousel, C; the call offer's answer is the normal turn; then the card", async () => {
  const h = harness();
  withCarousel(h);
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  const before = sentTo(h, num).length;
  // Not before its time.
  await h.runtime.tick();
  assert.equal(sentTo(h, num).length, before);
  await toMorningAfter(h, ev, c);
  let got = sentTo(h, num).slice(before).map(show);
  assert.deepEqual(got, ["how was Rooftop Dinner?"], "A alone");
  assert.equal(eo.rowOf(c).state, "asked");
  assert.equal(h.turns.length, 0, "no model turn for A");
  // It waits: hours go by, nothing more.
  clock.skip(6 * 3_600_000);
  await h.runtime.tick();
  assert.equal(sentTo(h, num).length, before + 1);

  await h.router.deliver(texts(num, "so fun, the food was amazing"));
  assert.equal(h.turns.length, 1, "their reply gets the normal turn");
  assert.match(h.turns[0].text, /how was Rooftop Dinner\?/);
  assert.match(h.turns[0].text, /Do not say what else Reason can do/);
  got = sentTo(h, num).slice(before + 1).map(show);
  assert.deepEqual(got, ["glad it was fun!", eo.MORE_LINE, "[carousel 7]", eo.CALL_LINE], "answer first, then B, ONE carousel, C");
  assert.equal(eo.MORE_LINE, "i can do more than events, here's some of what i do");
  assert.equal(eo.CALL_LINE, "want to start with a surprise call from me to a friend?");
  assert.equal(db.getAccount(c).welcome_cards, "direct", "the cards are theirs now: never again");
  assert.equal(eo.rowOf(c).state, "offered");

  // Their answer to C: the normal turn, told what C asked (a yes goes through the call flow as it is).
  h.channel.sent.length = 0;
  await h.router.deliver(texts(num, "yes!"));
  assert.equal(h.turns.length, 2);
  assert.match(h.turns[1].text, /surprise call from me to a friend/);
  assert.match(h.turns[1].text, /ask who to call and what it is for, then follow every usual call rule exactly/);
  assert.equal(eo.rowOf(c).state, "done");
  await new Promise(r => setTimeout(r, 30));
  assert.ok(sentTo(h, num).some(m => m.media?.url && /\.vcf$/.test(m.media.url)), "the contact card, now they have engaged");
  // Their next text: nothing of this flow any more.
  await h.router.deliver(texts(num, "thanks"));
  assert.doesNotMatch(h.turns[2].text, /surprise call|how was|are a guest/);
});

test("no reply to A: nothing more, ever — no nudge, no timer", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  await toMorningAfter(h, ev, c);
  const count = sentTo(h, num).length;
  for (let i = 0; i < 5; i++) { clock.skip(DAY); await h.runtime.tick(); }
  assert.equal(sentTo(h, num).length, count);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL").get(c).n, 0);
});

test("a 'no' to C ends it: no nudge afterwards", async () => {
  const h = harness({ reply: "all good" });
  withCarousel(h);
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  await toMorningAfter(h, ev, c);
  await h.router.deliver(texts(num, "it was great"));
  await h.router.deliver(texts(num, "nah"));
  const count = sentTo(h, num).length;
  for (let i = 0; i < 4; i++) { clock.skip(DAY); await h.runtime.tick(); }
  assert.equal(sentTo(h, num).length, count);
  assert.equal(eo.rowOf(c).state, "done");
});

test("the timer survives a restart: a new runtime's sweep sends A", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const h2 = harness(); // a fresh process: new runtime, router and channel, the same database
  await toMorningAfter(h2, ev, conv(num));
  assert.deepEqual(sentTo(h2, num).map(show), ["how was Rooftop Dinner?"]);
});

test("the event moved later: the timer follows it; cancelled: nothing", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  const first = eo.morningAfter(db.getEventRow(ev.id), c);
  db.updateEventRow(ev.id, { starts_at: ev.starts_at + 3 * DAY });
  clock.skip(first + 60_000 - clock.now());
  await h.runtime.tick();
  assert.ok(!sentTo(h, num).some(m => /how was/.test(m.text)), "not on the old morning");
  assert.equal(afterTimers(c)[0].fire_at, eo.morningAfter(db.getEventRow(ev.id), c));
  db.updateEventRow(ev.id, { status: "cancelled" });
  await toMorningAfter(h, ev, c);
  assert.ok(!sentTo(h, num).some(m => /how was/.test(m.text)));
  assert.equal(eo.rowOf(c).state, "skipped");
});

// ---------- who never gets it ----------

test("existing users never: Ama (already on Reason) joining gets the welcome alone, no line, no row", async () => {
  const h = harness();
  const ev = makeEvent();
  await joinByText(h, ev, AMA, "Ama");
  const got = sentTo(h, AMA).map(show);
  assert.ok(got.some(t => /so glad you're coming/.test(t)));
  assert.ok(!got.some(t => /keep you posted/.test(t)), got.join(" | "));
  assert.equal(eo.rowOf(AMA_C), null);
});

test("stopped, paused, muted or left: the morning after sends nothing", async () => {
  for (const stop of [
    (c) => db.setAccountState(c, "paused"),
    (c) => db.db.prepare("UPDATE accounts SET paused_at = ? WHERE conversation_id = ?").run(clock.now(), c),
    (c, ev) => db.updateAttendeeRow(db.attendeeRow(ev.id, c).id, { muted: 1 }),
    (c, ev) => db.updateAttendeeRow(db.attendeeRow(ev.id, c).id, { state: "left" }),
  ]) {
    clock.reset();
    const h = harness();
    const ev = makeEvent();
    const num = newNumber();
    await joinByText(h, ev, num);
    const c = conv(num);
    stop(c, ev);
    await toMorningAfter(h, ev, c);
    await h.runtime.tick();
    assert.ok(!sentTo(h, num).some(m => /how was/.test(m.text)), String(stop));
    db.db.exec("DELETE FROM events; DELETE FROM event_claims; DELETE FROM event_attendees;");
  }
});

test("already a Reason user by other means: welcome cards already had, or texted about non-event things → skipped", async () => {
  // The cards.
  let h = harness();
  let ev = makeEvent();
  let num = newNumber();
  await joinByText(h, ev, num);
  db.setWelcomeCards(conv(num), "direct");
  await toMorningAfter(h, ev, conv(num));
  assert.ok(!sentTo(h, num).some(m => /how was/.test(m.text)));
  assert.equal(eo.rowOf(conv(num)).why, "had_welcome_cards");
  // A non-event text, read by the model at the morning after.
  clock.reset();
  db.db.exec("DELETE FROM events; DELETE FROM event_claims; DELETE FROM event_attendees;");
  h = harness({ other: true, reply: "done, reminder set" });
  ev = makeEvent();
  num = newNumber();
  await joinByText(h, ev, num);
  await h.router.deliver(texts(num, "remind me to call my mom tomorrow"));
  await toMorningAfter(h, ev, conv(num));
  assert.ok(!sentTo(h, num).some(m => /how was/.test(m.text)));
  assert.equal(eo.rowOf(conv(num)).why, "already_using_reason");
  assert.ok(h.reads.some(r => /remind me to call my mom/.test(r.prompt)), "their texts were what the model read");
  // Event-only texts: the read says no, and A goes.
  clock.reset();
  db.db.exec("DELETE FROM events; DELETE FROM event_claims; DELETE FROM event_attendees;");
  h = harness({ other: false, reply: "12 Elm St" });
  ev = makeEvent();
  num = newNumber();
  await joinByText(h, ev, num);
  await h.router.deliver(texts(num, "where is it?"));
  await toMorningAfter(h, ev, conv(num));
  assert.ok(sentTo(h, num).some(m => m.text === "how was Rooftop Dinner?"));
});

test("once per person ever, across events: a second event's join and morning after send nothing more", async () => {
  const h = harness();
  withCarousel(h);
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  const c = conv(num);
  await toMorningAfter(h, ev, c);
  await h.router.deliver(texts(num, "loved it"));
  await h.router.deliver(texts(num, "no thanks"));
  // A second event from somebody else, joined later: no line (they are on Reason now), no second round.
  clock.reset();
  const ev2 = makeEvent(AMA_C, { name: "Game Night", password: "dice" });
  const count = sentTo(h, num).length;
  await joinByText(h, ev2, num);
  assert.ok(!sentTo(h, num).slice(count).some(m => /keep you posted|how was/.test(m.text)));
  assert.equal(eo.register({ conversationId: c, eventId: ev2.id }).fresh, false);
  await toMorningAfter(h, ev2, c);
  assert.ok(!sentTo(h, num).slice(count).some(m => /how was|surprise call/.test(m.text) || m.carousel));
  assert.equal(sentTo(h, num).filter(m => m.carousel).length, 1, "the cards once");
});

// ---------- owner ----------

test("owner: only the owner's numbers, even with an existing account; a stranger gets today's flow", async () => {
  process.env.REASON_EVENT_ONBOARDING = "owner";
  const h = harness();
  const ev = makeEvent(AMA_C, { name: "Ama's Brunch" });
  // The owner joins Ama's event by text: the line, although his account exists.
  await joinByText(h, ev, MASTER, "Omari");
  const mine = sentTo(h, MASTER).map(show);
  assert.ok(mine.some(t => /so glad you're coming/.test(t)));
  assert.equal(mine.at(-1), "i'm Reason, i'll keep you posted on Ama's Brunch. need the address, a ride, or to message Ama? just text me.");
  assert.equal(eo.rowOf(OWNER_C).state, "joined");
  // A stranger: exactly as today.
  const num = newNumber();
  await joinByText(h, ev, num);
  assert.ok(sentTo(h, num).map(show).includes(ob.INTRO));
  assert.equal(eo.rowOf(conv(num)), null);
  // A REASON_TEST_NUMBERS number is the owner's too.
  const test1 = newNumber();
  config.testNumbers = [test1];
  assert.equal(eo.covers({ conversationId: `dm:fake:${test1}`, address: test1, newAccount: false }), true);
});

test("scripts/event-after-now.js: arms A for right now on the owner's thread, through the live sweep; refuses off and strangers", async () => {
  const h = harness();
  withCarousel(h);
  process.env.REASON_EVENT_ONBOARDING = "off";
  const ev = makeEvent(AMA_C, { name: "Ama's Brunch" });
  assert.equal((await armNow({ event: ev.id })).outcome, "refused");
  process.env.REASON_EVENT_ONBOARDING = "owner";
  const num = newNumber();
  db.upsertAccount({ conversationId: `dm:fake:${num}`, channel: "fake", address: num, name: "Kofi" });
  assert.equal((await armNow({ event: ev.id, guest: `dm:fake:${num}` })).outcome, "refused", "never a stranger");
  const out = await armNow({ event: ev.public_id });
  assert.equal(out.outcome, "armed", JSON.stringify(out));
  assert.equal(out.conversationId, OWNER_C);
  // The owner is not even on the guest list and the event is days away: forced, it goes now.
  await h.runtime.tick();
  assert.deepEqual(sentTo(h, MASTER).map(show), ["how was Ama's Brunch?"]);
  await h.router.deliver(texts(MASTER, "it was lovely"));
  assert.deepEqual(sentTo(h, MASTER).slice(1).map(show), ["glad it was fun!", eo.MORE_LINE, "[carousel 7]", eo.CALL_LINE]);
  // Again: the owner can start over.
  assert.equal((await armNow({ event: ev.id })).outcome, "armed");
  await h.runtime.tick();
  assert.equal(sentTo(h, MASTER).at(-1).text, "how was Ama's Brunch?");
});

test("no carousel on the line: the cards' fall-backs, in the same place between B and C", async () => {
  const h = harness();
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  await toMorningAfter(h, ev, conv(num));
  await h.router.deliver(texts(num, "great"));
  const got = sentTo(h, num).map(show);
  const iB = got.indexOf(eo.MORE_LINE), iC = got.indexOf(eo.CALL_LINE);
  assert.ok(iB > 0 && iC > iB, got.join(" | "));
  assert.equal(iC - iB - 1, welcome.CARDS.length, "seven cards between B and C");
});

test("a reply to A days later is not its answer: no cards, no call offer", async () => {
  const h = harness({ reply: "sure" });
  withCarousel(h);
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  await toMorningAfter(h, ev, conv(num));
  clock.skip(eo.ASK_FRESH_MS + 3_600_000);
  await h.router.deliver(texts(num, "can you find me a plumber"));
  assert.ok(!sentTo(h, num).some(m => m.text === eo.MORE_LINE || m.carousel || m.text === eo.CALL_LINE));
  assert.doesNotMatch(h.turns.at(-1).text, /how was/);
  assert.equal(eo.rowOf(conv(num)).state, "done");
});

test("a reply to A that needs care (the harm screen): no cards, no call offer, no contact card", async () => {
  const h = harness({ reply: "i'm here. are you safe right now?", verdict: "crisis" });
  withCarousel(h);
  const ev = makeEvent();
  const num = newNumber();
  await joinByText(h, ev, num);
  await toMorningAfter(h, ev, conv(num));
  await h.router.deliver(texts(num, "honestly awful, i want to disappear"));
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!sentTo(h, num).some(m => m.text === eo.MORE_LINE || m.carousel || m.text === eo.CALL_LINE || m.media));
  assert.equal(eo.rowOf(conv(num)).state, "done");
});
