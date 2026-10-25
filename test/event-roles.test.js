// Spec v3 §11 and §14, pinned: a role belongs to one membership of one event, never to the person.
// The same account organizes event A and is a plain guest at event B; every tool and every page asks
// "which event, and what role here" before anything else. And "which event does this mean?": with
// more than one that could fit, nothing is done until the person (or the conversation) has named one
// — never the newest one picked silently. (§15 tests 11, 12 and 14.)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-roles-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "on";

const { runTool } = await import("../src/tools.js");
const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { eventPageRequest } = await import("../src/pages/event.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const AMA_C = "dm:fake:+13475550000";
const YAW_C = "dm:fake:+16465550111";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertAccount({ conversationId: YAW_C, channel: "fake", address: "+16465550111", name: "Yaw" });
});

function fakeRuntime() {
  const sent = [];
  return {
    sent,
    async _tell(conversationId, text, { idempotencyKey }) {
      const have = db.db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idempotencyKey);
      if (have) return { ok: true, outbox_id: have.id, duplicate: true };
      sent.push({ conversationId, text });
      const now = clock.now();
      const id = db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at)
        VALUES (?, ?, 'fake', 'x', ?, 'sent', ?, ?)`).run(idempotencyKey, conversationId, text, now, now).lastInsertRowid;
      return { ok: true, outbox_id: Number(id) };
    },
  };
}
const tool = (name, input, c, rt = fakeRuntime()) => runTool(name, input, { conversationId: c, messages: [], events: rt });
const make = (c, over = {}) => {
  const out = events.create(c, {
    name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
    welcome_message: "", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true, ...over,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.event;
};
const join_ = async (c, name, password) => {
  const r = await events.joinExisting({ conversationId: c, name, password });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.attendee;
};
const page = (ev, { sub = null, query = {} } = {}) => eventPageRequest({ publicId: ev.public_id, sub, method: "GET", query, headers: {}, readBody: async () => null });

test("the organizer's own membership carries role organizer; it is never counted, listed, texted or given a guest page", async () => {
  const a = make(KOFI_C, { name: "Kofi's Birthday", password: "candles" });
  const row = db.attendeeRow(a.id, KOFI_C);
  assert.equal(row.role, "organizer");
  assert.equal(db.joinedCount(a.id), 0, "the organizer is not a guest in the count");
  assert.equal(db.attendeesOf(a.id).length, 0);
  assert.equal(db.attendeeByToken(row.token), null, "the organizer row's token opens no guest page");
  assert.equal(events.roleIn(KOFI_C, a.id).role, "organizer");
  await join_(AMA_C, "Kofi's Birthday", "candles");
  const rt = fakeRuntime();
  await tool("event_blast", { event_id: a.id, message: "bring snacks" }, KOFI_C, rt);
  assert.deepEqual(rt.sent.map(s => s.conversationId), [AMA_C], "a blast reaches guests, never the organizer");
  assert.deepEqual(events.guestList(a).map(g => g.display_name), ["Ama"]);
  // Joining your own event, by any route, is refused as before.
  const self = await events.joinExisting({ conversationId: KOFI_C, name: "Kofi's Birthday", password: "candles" });
  assert.equal(self.reason, "organizer");
});

test("an event made before roles existed gets its organizer row once, on start", async () => {
  const a = make(KOFI_C);
  db.db.prepare("DELETE FROM event_attendees WHERE event_id = ? AND role = 'organizer'").run(a.id);
  assert.equal(events.roleIn(KOFI_C, a.id), null);
  // The same statement db.js runs at start, run again: idempotent, and it restores the organizer.
  db.db.exec(`INSERT OR IGNORE INTO event_attendees (event_id, conversation_id, display_name, in_directory, via, token, joined_at, updated_at, role)
    SELECT e.id, e.organizer_conversation_id, '', 0, 'organizer', lower(hex(randomblob(24))), e.created_at, e.created_at, 'organizer' FROM events e`);
  assert.equal(events.roleIn(KOFI_C, a.id).role, "organizer");
});

test("§15.11 mixed roles: organizes A, guest at B — edits and blasts A; in B sees guest details only and every organizer action is refused", async () => {
  const a = make(KOFI_C, { name: "Kofi's Birthday", password: "candles", location: "Kofi's place" });
  const b = make(AMA_C, { name: "Ama's Dinner", password: "jollof", location: "88 Hidden Ln", show_location_on_join: false });
  await join_(KOFI_C, "Ama's Dinner", "jollof");
  await join_(YAW_C, "Kofi's Birthday", "candles");

  assert.equal(events.roleIn(KOFI_C, a.id).role, "organizer");
  assert.equal(events.roleIn(KOFI_C, b.id).role, "guest");
  assert.equal(events.roleIn(AMA_C, a.id), null, "organizing B gives Ama nothing in A");

  // A: Kofi organizes — update and blast work.
  const up = await tool("event_update", { event_id: a.id, event_named: "my birthday", description: "cake at 9" }, KOFI_C);
  assert.equal(up.ok, true, JSON.stringify(up));
  const bl = await tool("event_blast", { event_id: a.id, event_named: "Kofi's Birthday", message: "bring snacks" }, KOFI_C);
  assert.equal(bl.ok, true, JSON.stringify(bl));

  // B: Kofi is a guest — every organizer tool says so, and nothing changes.
  const before = JSON.stringify([db.getEventRow(b.id), db.attendeesOf(b.id, { state: null })]);
  for (const [name, extra] of [["event_guests", {}], ["event_update", { location: "elsewhere" }], ["event_release", { detail: "location" }],
    ["event_blast", { message: "hi all" }], ["event_password_rotate", { new_password: "mine!!" }], ["event_guest_remove", { guest_id: 1 }], ["event_cancel", {}]]) {
    const out = await tool(name, { event_id: b.id, event_named: "Ama's Dinner", ...extra }, KOFI_C);
    assert.equal(out.ok, false, name);
    assert.equal(out.reason, "guest_there", `${name}: ${out.error}`);
    assert.ok(!/Hidden Ln|jollof|Yaw/.test(JSON.stringify(out)), `${name} leaks nothing`);
  }
  assert.equal(JSON.stringify([db.getEventRow(b.id), db.attendeesOf(b.id, { state: null })]), before, "B unchanged");

  // B, read as Kofi: guest view only — the unreleased address is not in it.
  const info = await tool("event_info", { event_id: b.id, event_named: "Ama's Dinner" }, KOFI_C);
  assert.equal(info.ok, true);
  assert.equal(info.role, "guest");
  assert.ok(!/Hidden Ln/.test(JSON.stringify(info)));
  assert.equal(info.guest_list_page, undefined, "no organizer page link");
  // A, read as Kofi: the organizer's view, with his own address.
  const infoA = await tool("event_info", { event_id: a.id, event_named: "Kofi's Birthday" }, KOFI_C);
  assert.equal(infoA.role, "organizer");
  assert.match(JSON.stringify(infoA), /Kofi's place/);

  // event_list keeps them apart.
  const list = await tool("event_list", {}, KOFI_C);
  assert.deepEqual(list.organizing.map(e => e.name), ["Kofi's Birthday"]);
  assert.deepEqual(list.going_to.map(e => e.name), ["Ama's Dinner"]);

  // The pages: Kofi's guest token for B opens B's guest page only, never the organizer view; his
  // organizer key for A opens nothing on B.
  const kb = db.attendeeRow(b.id, KOFI_C);
  const asGuest = await page(b, { sub: "who", query: { t: kb.token } });
  assert.equal(asGuest.status, 200);
  assert.ok(!/Hidden Ln/.test(asGuest.body), "guest page shows no unreleased address");
  assert.ok(!/Your guest list, with everyone/.test(asGuest.body), "not the organizer's view");
  const crossKey = await page(b, { sub: "who", query: { t: db.getEventRow(a.id).organizer_token } });
  assert.equal(crossKey.status, 404, "A's organizer key opens nothing on B");
  // His leftover organizer row on A carries no guest token: it cannot open A's guest page either.
  const orgRow = db.attendeeRow(a.id, KOFI_C);
  assert.equal((await page(a, { sub: "who", query: { t: orgRow.token } })).status, 404);
});

test("§15.12 ambiguity: in two events, 'change the location' asks which and does nothing until answered", async () => {
  const a = make(KOFI_C, { name: "Birthday Dinner", password: "candles", location: "Kofi's place" });
  const b = make(KOFI_C, { name: "Rooftop Party", password: "skyline", location: "the roof" });
  const before = JSON.stringify([db.getEventRow(a.id), db.getEventRow(b.id)]);

  // No naming at all — whichever id the model reached for (the newest, say), nothing happens.
  for (const id of [a.id, b.id]) {
    const out = await tool("event_update", { event_id: id, location: "a new place" }, KOFI_C);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "which_event");
    assert.deepEqual(out.choices.map(c => c.name).sort(), ["Birthday Dinner", "Rooftop Party"]);
  }
  // A naming that points at the OTHER event than the id is refused too.
  const crossed = await tool("event_update", { event_id: b.id, event_named: "the birthday dinner", location: "x" }, KOFI_C);
  assert.equal(crossed.reason, "which_event");
  // A naming that fits both is not an answer.
  const vague = await tool("event_blast", { event_id: a.id, event_named: "my event", message: "hi" }, KOFI_C);
  assert.equal(vague.reason, "which_event");
  assert.equal(JSON.stringify([db.getEventRow(a.id), db.getEventRow(b.id)]), before, "nothing changed while it was unclear");

  // Answered: the rooftop party, in their words.
  const done = await tool("event_update", { event_id: b.id, event_named: "rooftop", location: "the other roof" }, KOFI_C);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(db.getEventRow(b.id).location, "the other roof");
  assert.equal(db.getEventRow(a.id).location, "Kofi's place");

  // A guest in two events asking "who's going?" is asked too.
  await join_(AMA_C, "Birthday Dinner", "candles");
  await join_(AMA_C, "Rooftop Party", "skyline");
  const who = await tool("event_info", { event_id: a.id }, AMA_C);
  assert.equal(who.reason, "which_event");
  assert.ok(!/Kofi's place|the other roof/.test(JSON.stringify(who)), "the question shows only what a guest may see");
  assert.equal((await tool("event_info", { event_id: a.id, event_named: "Birthday Dinner" }, AMA_C)).ok, true);

  // Exactly one event they could mean: no question.
  const c = make(YAW_C, { name: "Game Night", password: "dice" });
  assert.equal((await tool("event_update", { event_id: c.id, description: "bring a game" }, YAW_C)).ok, true);
  // Kofi organizes two and is a guest at one: a guest-only command (mute) can only mean that one — no question.
  await join_(KOFI_C, "Game Night", "dice");
  assert.equal((await tool("event_mute", { event_id: c.id, muted: true }, KOFI_C)).ok, true, "mute fits only the one he's a guest at");
  // …but "what time is it?" could be any of the three: asked.
  assert.equal((await tool("event_info", { event_id: c.id }, KOFI_C)).reason, "which_event");
});

test("§15.12 two events with the same name still resolve from their links", async () => {
  const a = make(KOFI_C, { name: "Halloween Party", password: "pumpkin" });
  const b = make(AMA_C, { name: "Halloween Party", password: "ghosts" });
  await join_(YAW_C, "Halloween Party", "pumpkin");
  await join_(YAW_C, "Halloween Party", "ghosts");
  // By name alone it's both: asked.
  assert.equal((await tool("event_info", { event_id: a.id, event_named: "Halloween Party" }, YAW_C)).reason, "which_event");
  // By link: exactly the one.
  const ra = await tool("event_info", { event_id: a.id, event_named: events.eventUrl(a) }, YAW_C);
  assert.equal(ra.ok, true);
  assert.equal(ra.organizer, "Kofi");
  assert.equal((await tool("event_info", { event_id: b.id, event_named: events.eventUrl(a) }, YAW_C)).reason, "which_event", "a's link never acts on b");
  assert.equal((await tool("event_info", { event_id: b.id, event_named: events.eventUrl(b) }, YAW_C)).organizer, "Ama");
  // Or by name with who's organizing it.
  assert.equal((await tool("event_info", { event_id: b.id, event_named: "Ama's halloween party" }, YAW_C)).ok, true);
});

test("§15.14 two events, one organizer: a guest of one sees nothing of the other — details, directory or anything else", async () => {
  const a = make(KOFI_C, { name: "Friday Party", password: "friday", location: "Friday Place", show_location_on_join: true });
  const b = make(KOFI_C, { name: "Saturday Dinner", password: "saturday", location: "Saturday Place", show_location_on_join: true });
  await join_(AMA_C, "Friday Party", "friday");
  await join_(YAW_C, "Saturday Dinner", "saturday");
  db.updateAttendeeRow(db.attendeeRow(b.id, YAW_C).id, { in_directory: 1, instagram: "yaw.real" });

  assert.equal(events.roleIn(AMA_C, b.id), null);
  for (const [name, extra] of [["event_info", {}], ["event_directory", { in_directory: true }], ["event_leave", {}], ["event_mute", { muted: true }]]) {
    const out = await tool(name, { event_id: b.id, ...extra }, AMA_C);
    assert.equal(out.ok, false, name);
    assert.ok(!/Saturday|yaw/i.test(JSON.stringify(out)), `${name} says nothing about B`);
  }
  const list = await tool("event_list", {}, AMA_C);
  assert.ok(!/Saturday/.test(JSON.stringify(list)));
  // Her token for A opens nothing on B.
  const mine = db.attendeeRow(a.id, AMA_C);
  assert.equal((await page(b, { sub: "who", query: { t: mine.token } })).status, 404);
  // And on A's page, nobody from B.
  const pa = await page(a, { sub: "who", query: { t: mine.token } });
  assert.ok(!/yaw|Saturday Place/i.test(pa.body));
});

test("every message to guests says which event it is from", async () => {
  const rt = fakeRuntime();
  const a = make(KOFI_C, { name: "Kofi's Birthday", password: "candles", show_location_on_join: false });
  await join_(AMA_C, "Kofi's Birthday", "candles");
  await join_(YAW_C, "Kofi's Birthday", "candles");
  await tool("event_blast", { event_id: a.id, message: "bring snacks" }, KOFI_C, rt);
  await tool("event_update", { event_id: a.id, starts_at: "2026-10-31T22:00" }, KOFI_C, rt);
  await tool("event_release", { event_id: a.id, detail: "location" }, KOFI_C, rt);
  await tool("event_guest_remove", { event_id: a.id, guest_id: db.attendeeRow(a.id, YAW_C).id }, KOFI_C, rt);
  await tool("event_cancel", { event_id: a.id }, KOFI_C, rt);
  assert.ok(rt.sent.length >= 5);
  for (const s of rt.sent) assert.match(s.text, /Kofi's Birthday/, `names the event: ${s.text}`);
  assert.match(events.welcomeText(a, db.attendeeRow(a.id, AMA_C)), /Kofi's Birthday/);
});
