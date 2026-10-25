// Events, read by meaning: with the real model, what people say about events reaches the right tool
// (src/eventtools.js). No regex decides any of it — the model does, off the tool descriptions — so this
// is the test that the descriptions are good enough. Skipped with no model reachable; run it with
// REASON_BACKEND=claude-cli (the subscription), never on Reason's paid key.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-events-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "owner";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const OWNER_C = "dm:owner";
const KOFI_C = `dm:fake:${KOFI}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;
    DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries; DELETE FROM event_join_attempts;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
});

function harness() {
  const tools = [];
  const rt = new Runtime({ log: (e) => { if (e?.tool) tools.push({ name: e.tool, input: e.input, out: e.out }); } });
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  async function says(c, address, handle, text) {
    clock.skip(90_000);
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: c, text });
    db.upsertThread({ conversationId: c, channel: "fake", address, isOwner: true, service: "iMessage", lastInboundId: handle });
    return await rt.inbound(c, text, { channel: "fake", to: address, fromOwner: true });
  }
  return { rt, fake, tools, says };
}
const called = (tools, name) => tools.filter(t => t.name === name);

function ownerEvent() {
  const out = events.create(OWNER_C, {
    name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St",
    password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true,
  });
  assert.equal(out.ok, true);
  return out.event;
}

test(`organizing: the setup questions are asked, the location/time release asked separately, and the event made only when all are in (${label})`, { skip }, async () => {
  const { rt, tools, says } = harness();
  try {
    const replies = [];
    replies.push(await says(OWNER_C, OWNER, "C-1", "i want to throw a halloween party saturday oct 31 at 9pm and have people join through you"));
    assert.equal(called(tools, "event_create").filter(t => t.out?.ok).length, 0, "nothing made from a first message missing answers");
    replies.push(await says(OWNER_C, OWNER, "C-2", "call it Spooky Night. costume party, bring a drink. it's at 12 elm st"));
    replies.push(await says(OWNER_C, OWNER, "C-3", "password is batcave. welcome message: so glad you're coming"));
    replies.push(await says(OWNER_C, OWNER, "C-4", "show the time when they join but keep the address hidden til the day. yes they can see who's going, no cap"));
    if (!db.allEvents().length) replies.push(await says(OWNER_C, OWNER, "C-5", "yep that's everything, make it"));
    const ev = db.allEvents()[0];
    assert.ok(ev, `made: ${JSON.stringify(tools.map(t => t.name))} / ${JSON.stringify(replies)}`);
    assert.equal(ev.name, "Spooky Night");
    assert.equal(ev.time_released, 1);
    assert.equal(ev.location_released, 0);
    assert.equal(ev.guest_list_visible, 1);
    assert.ok(await events.checkPassword("batcave", ev.password_hash));
    assert.ok(!/batcave/.test(JSON.stringify(tools.map(t => t.input))), "the password is sealed in the tool log");
  } finally { await rt.shutdown(); }
});

test(`an existing user joins by text: asked for the password, then in (${label})`, { skip }, async () => {
  ownerEvent();
  const { rt, tools, says } = harness();
  try {
    await says(KOFI_C, KOFI, "J-1", "omari invited me to his halloween party, can you get me in?");
    if (!db.attendeeRow(db.allEvents()[0].id, KOFI_C)) await says(KOFI_C, KOFI, "J-2", "the password is pumpkin");
    const att = db.attendeeRow(db.allEvents()[0].id, KOFI_C);
    assert.equal(att?.state, "joined", `joined: ${JSON.stringify(tools.map(t => [t.name, t.out?.reason ?? t.out?.ok]))}`);
    assert.equal(att.via, "text");
    assert.equal(db.getAccount(KOFI_C).name, "Kofi", "same account, no onboarding");
  } finally { await rt.shutdown(); }
});

test(`an existing user pastes the link: the event is read from it, the password asked for, then in (${label})`, { skip }, async () => {
  const ev = ownerEvent();
  const { rt, tools, says } = harness();
  try {
    const first = await says(KOFI_C, KOFI, "L-1", events.eventUrl(ev));
    assert.ok(called(tools, "event_lookup").length, `looked it up: ${JSON.stringify(tools.map(t => t.name))}`);
    assert.equal(db.attendeeRow(ev.id, KOFI_C), null, "not joined on the link alone");
    assert.ok(!/Elm/.test(String(first)), "the hidden address is not in the reply");
    await says(KOFI_C, KOFI, "L-2", "pumpkin");
    const att = db.attendeeRow(ev.id, KOFI_C);
    assert.equal(att?.state, "joined", `joined: ${JSON.stringify(tools.map(t => [t.name, t.out?.reason ?? t.out?.ok]))}`);
    assert.equal(att.via, "link");
  } finally { await rt.shutdown(); }
});

test(`a guest asking where it is is told the organizer hasn't shared it — never the address (${label})`, { skip }, async () => {
  const ev = ownerEvent();
  await events.joinExisting({ conversationId: KOFI_C, name: "Halloween Party", password: "pumpkin" });
  const { rt, says } = harness();
  try {
    const reply = await says(KOFI_C, KOFI, "Q-1", "where's omari's halloween party at? what's the address");
    assert.ok(!/Elm/i.test(String(reply)), String(reply));
    assert.ok(ev);
  } finally { await rt.shutdown(); }
});

test(`in two events, "change the location" is asked about and nothing changes until answered (${label})`, { skip }, async () => {
  const a = events.create(OWNER_C, { name: "Birthday Dinner", description: "dinner for my birthday", starts_at: "2026-11-02T20:00", location: "Nobu", password: "candles", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }).event;
  const b = events.create(OWNER_C, { name: "Rooftop Party", description: "drinks on the roof", starts_at: "2026-11-07T21:00", location: "the roof at 5 Main", password: "skyline", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }).event;
  const { rt, tools, says } = harness();
  try {
    const reply = await says(OWNER_C, OWNER, "W-1", "change the location to 40 Bond St");
    assert.equal(db.getEventRow(a.id).location, "Nobu", `untouched: ${JSON.stringify(tools.map(t => [t.name, t.out?.reason ?? t.out?.ok]))}`);
    assert.equal(db.getEventRow(b.id).location, "the roof at 5 Main");
    assert.ok(/birthday|rooftop|which/i.test(String(reply)), `asked which: ${reply}`);
    await says(OWNER_C, OWNER, "W-2", "the rooftop one");
    assert.equal(db.getEventRow(b.id).location, "40 Bond St", `changed after the answer: ${JSON.stringify(tools.map(t => [t.name, t.out?.reason ?? t.out?.ok]))}`);
    assert.equal(db.getEventRow(a.id).location, "Nobu");
  } finally { await rt.shutdown(); }
});

test(`rides, read by meaning: "i can drive 2 from fort greene around 8:15" is an offer; "yes pair us" answers the match (${label})`, { skip }, async () => {
  const { config } = await import("../src/config.js");
  const rides = await import("../src/eventrides.js");
  config.eventRides = true;
  rides._setGeocoder(async (q) => ({ "fort greene": { lat: 40.6895, lng: -73.976 }, "clinton hill": { lat: 40.6897, lng: -73.9655 } })[String(q).toLowerCase()] ?? null);
  const d = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const ev = events.create(OWNER_C, { name: "Halloween Party", description: "costumes", starts_at: `${d}T21:00`, location: "88 Party Pl", password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }).event;
  db.updateEventRow(ev.id, { rides_enabled: 1 });
  await events.joinExisting({ conversationId: KOFI_C, name: "Halloween Party", password: "pumpkin" });
  const AMA = "+13475550000", AMA_C = `dm:fake:${AMA}`;
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: AMA, name: "Ama" });
  await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin" });
  const { rt, tools, says } = harness();
  try {
    await says(KOFI_C, KOFI, "R-1", "for the halloween party, i can drive 2 people from fort greene, leaving around 8:15");
    const offer = db.liveRideOffer(ev.id, KOFI_C);
    assert.equal(offer?.kind, "offer", `recorded: ${JSON.stringify(tools.map(t => [t.name, t.input?.action, t.out?.reason ?? t.out?.ok]))}`);
    assert.equal(offer.seats, 2);
    assert.match(offer.area, /fort greene/i);
    await rides.record({ runtime: rt, conversationId: AMA_C, eventId: ev.id, kind: "need", area: "Clinton Hill", leaveAt: `${d}T20:20` });
    assert.equal(db.rideMatchesFor(ev.id, ["pending"]).length, 1);
    await says(KOFI_C, KOFI, "R-2", "yes pair us");
    const m = db.rideMatchesFor(ev.id)[0];
    assert.equal(m.driver_answer, "yes", `answered: ${JSON.stringify(tools.map(t => [t.name, t.input?.action, t.out?.state ?? t.out?.reason]))}`);
  } finally { await rt.shutdown(); config.eventRides = false; rides._setGeocoder(null); }
});
