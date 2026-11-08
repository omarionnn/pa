// Changing who sees the guest list, and the cap, after an event is made (owner request 2026-11-08,
// events next-round #3). Pinned:
//
//   - hiding the list is quiet: nobody is texted, guests stop seeing it, each guest's choice is kept;
//   - showing it never puts anybody on it who didn't choose it: guests who joined while it was private
//     come off it and are asked once (never a muted guest, never at night); by text that needs the
//     organizer's yes, pinned to exactly who is asked; guests who chose it before are back, unasked;
//   - a cap is never a reason to take anybody off: at or under the number in, new joins close (on
//     every route), and open again only when fewer than the cap are in; guests are never told;
//   - the page: both settings in the Guests section, a confirm step with the exact text and who gets
//     asked (re-checked on the send step), and a confirm step only for a cap that closes joining.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { withYes } from "./fixture-yes.js";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-limits-"));
process.env.REASON_DB_PATH = pathJoin(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_CADDY_SECRET = "caddy-test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
delete process.env.REASON_AUTO_ADMIT;

const events = await import("../src/events.js");
const tools = await import("../src/eventtools.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { eventRequestFor } = await import("../src/http.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234", AMA = "+13475550000", KOFI = "+13475550001", YAW = "+13475550002", ESI = "+13475550003", ABENA = "+13475550004";
const OWNER_C = config.ownerConversation;
const C = { ama: `dm:fake:${AMA}`, kofi: `dm:fake:${KOFI}`, yaw: `dm:fake:${YAW}`, esi: `dm:fake:${ESI}`, abena: `dm:fake:${ABENA}` };
const LINE = "+16562167455";
const COOKIE = { owner: "reason_page=tok-owner-lim-000001", ama: "reason_page=tok-ama-lim-0000001" };
const TZ = "America/New_York";
const HOUR = 60 * 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  // Noon in New York, so a list note may go (never 21:00–09:00 in the event's zone).
  const d = new Date(); d.setUTCHours(17, 0, 0, 0);
  clock.skip(d.getTime() + 24 * HOUR - Date.now());
  config.events = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations;
    DELETE FROM inbound_messages; DELETE FROM page_sessions;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  for (const [c, a, n] of [[C.ama, AMA, "Ama"], [C.kofi, KOFI, "Kofi"], [C.yaw, YAW, "Yaw"], [C.esi, ESI, "Esi"], [C.abena, ABENA, "Abena"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
    db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(c);
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: false });
  }
  db.startPageSession("p-owner", "tok-owner-lim-000001", { conversationId: OWNER_C });
  db.startPageSession("p-ama", "tok-ama-lim-0000001", { conversationId: C.ama });
});

function harness() {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel };
}
const settle = () => new Promise(r => setTimeout(r, 40));
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to).map(m => m.text);
const tool = (name, input, c, rt) => runTool(name, input, { conversationId: c, messages: [], events: rt });
const form = (o) => new URLSearchParams(o).toString();
async function req(h, ev, { sub = null, method = "GET", body = null, query = {}, cookie = "" } = {}) {
  const headers = { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test", host: "files.example.test" };
  return await eventRequestFor({ publicId: ev.public_id, sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router });
}
const post = (h, ev, fields, cookie = COOKIE.owner) => req(h, ev, { sub: "manage", method: "POST", body: form(fields), cookie });
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hiddenField = (html, name) => unesc((new RegExp(`name="${name}" value="([^"]*)"`).exec(html) ?? [])[1] ?? "");
const row = (ev, c) => db.attendeeRow(ev.id, c);
const listed = (ev) => events.directoryEntries(ev).map(e => e.name);

/**
 * A private event, joined by text the way a text join does it (on the list by default): Ama, Kofi
 * (who muted it) and Esi. The organizer is not on a private list.
 */
async function privateParty(h, { capacity } = {}) {
  const out = events.create(OWNER_C, {
    name: "Rooftop Night", description: "drinks", starts_at: "2027-06-05T20:00", timezone: TZ, location: "9 Pine St",
    welcome_message: "", password: "skyline", show_time_on_join: true, show_location_on_join: false, guest_list_visible: false, ...(capacity ? { capacity } : {}),
  });
  assert.equal(out.ok, true);
  const ev = out.event;
  const add = (c, name) => db.addAttendee({ eventId: ev.id, conversationId: c, displayName: name, inDirectory: true, via: "text" }).attendee;
  const g = { ama: add(C.ama, "Ama"), kofi: add(C.kofi, "Kofi"), esi: add(C.esi, "Esi") };
  db.updateAttendeeRow(g.kofi.id, { muted: 1 });
  await settle();
  h.channel.sent.length = 0;
  return { ev: db.getEventRow(ev.id), g };
}

// ---------- who sees the list ----------

test("a join counts as choosing the list only while guests can see it", async () => {
  const h = harness();
  const { ev, g } = await privateParty(h);
  assert.equal(row(ev, C.ama).in_directory, 1, "a text join ticks the default");
  assert.equal(row(ev, C.ama).list_chosen, 0, "but on a private list that isn't a choice");
  // Opting in on purpose is a choice, even while private ("saved in case that changes").
  db.updateAttendeeRow(g.esi.id, { in_directory: 0 });
  db.updateAttendeeRow(g.esi.id, { in_directory: 1 });
  assert.equal(row(ev, C.esi).list_chosen, 1);
  // A page save that leaves a private event's ticked box ticked is not.
  db.updateAttendeeRow(g.ama.id, { in_directory: 1, display_name: "Ama B" });
  assert.equal(row(ev, C.ama).list_chosen, 0);
  // Joining a shown list with the box ticked is.
  const shown = events.create(OWNER_C, { name: "Open House", description: "x", starts_at: "2027-06-06T20:00", timezone: TZ, location: "x", password: "openhouse", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }).event;
  const yaw = db.addAttendee({ eventId: shown.id, conversationId: C.yaw, displayName: "Yaw", inDirectory: true, via: "text" }).attendee;
  assert.equal(yaw.list_chosen, 1);
});

test("hiding a shown list is quiet, and each guest's choice is kept", async () => {
  const h = harness();
  const ev0 = events.create(OWNER_C, { name: "Open House", description: "x", starts_at: "2027-06-06T20:00", timezone: TZ, location: "x", password: "openhouse", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }).event;
  const ama = db.addAttendee({ eventId: ev0.id, conversationId: C.ama, displayName: "Ama", inDirectory: true, via: "text" }).attendee;
  db.settleListNote(ama.id, "ask", "sent");
  await settle();
  h.channel.sent.length = 0;
  const out = await tool("event_settings", { event_id: ev0.id, guest_list_visible: false }, OWNER_C, h.runtime);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.blocked, undefined, "hiding needs no yes");
  assert.equal(out.guest_list_visible, false);
  assert.match(out.list_note, /nobody was texted/);
  const ev = db.getEventRow(ev0.id);
  assert.equal(ev.guest_list_visible, 0);
  assert.equal(events.guestView(ev, row(ev, C.ama)).guest_list, "kept private by the organizer");
  assert.equal(row(ev, C.ama).in_directory, 1, "her choice is kept");
  await settle();
  assert.equal(h.channel.sent.length, 0, "nobody is texted");
  // Shown again: she chose it, so she's back on it, and nobody is asked or needs a yes.
  const again = await tool("event_settings", { event_id: ev.id, guest_list_visible: true }, OWNER_C, h.runtime);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.asked, 0);
  assert.ok(listed(db.getEventRow(ev.id)).includes("Ama"));
  await events.sweepListNotes({ runtime: h.runtime });
  await settle();
  assert.equal(h.channel.sent.length, 0);
});

test("by text: showing a private list with guests needs the yes, pinned to who is asked; nothing changes before it", async () => {
  const h = harness();
  const { ev, g } = await privateParty(h);
  const input = { event_id: ev.id, guest_list_visible: true };
  const unasked = await tool("event_settings", input, OWNER_C, h.runtime);
  assert.equal(unasked.blocked, "needs_confirmation");
  assert.match(unasked.use_target, /^show the who's-going list of Rooftop Night \(event #\d+\) and ask 2 guests who joined while it was private: Ama, Esi \{[0-9a-f]{12}\}$/);
  assert.deepEqual(unasked.asks.names, ["Ama", "Esi"], "Kofi muted the event, so he isn't asked");
  assert.equal(unasked.asks.muted_not_asked, 1);
  assert.equal(unasked.asks.text_they_get, "Omari turned on a who's-going list for Rooftop Night, so guests can see who else is coming. you're not on it — if you'd like to be, just let me know (you'd show as Ama).");
  assert.equal(db.getEventRow(ev.id).guest_list_visible, 0, "nothing changed before the yes");
  // Somebody muting between the ask and the yes is a different target.
  db.updateAttendeeRow(g.esi.id, { muted: 1 });
  assert.notEqual(tools.settingsTarget(OWNER_C, input), unasked.use_target);
  db.updateAttendeeRow(g.esi.id, { muted: 0 });
  assert.equal(tools.settingsTarget(OWNER_C, input), unasked.use_target);

  const done = await withYes(runTool, "event_settings", input, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.asked, 2);
  assert.match(done.list_note, /3 guests who joined while it was private are off it/);
  assert.match(done.list_note, /on it themselves, as Omari/);
  const after = db.getEventRow(ev.id);
  assert.equal(after.guest_list_visible, 1);
  // Nobody who didn't choose it shows: only the organizer, who turned it on.
  assert.deepEqual(listed(after), ["Omari"]);
  for (const c of [C.ama, C.kofi, C.esi]) assert.equal(row(after, c).in_directory, 0);

  // The sweep asks Ama and Esi once each; Kofi muted it and gets nothing.
  await events.sweepListNotes({ runtime: h.runtime });
  await settle();
  assert.deepEqual(sentTo(h, AMA), ["Omari turned on a who's-going list for Rooftop Night, so guests can see who else is coming. you're not on it — if you'd like to be, just let me know (you'd show as Ama)."]);
  assert.equal(sentTo(h, ESI).length, 1);
  assert.equal(sentTo(h, KOFI).length, 0);
  await events.sweepListNotes({ runtime: h.runtime });
  await settle();
  assert.equal(sentTo(h, AMA).length, 1, "asked once, never chased");

  // Ama says yes, in her words; the model puts her on it. Now she's on it by choice.
  const yes = await tool("event_directory", { event_id: ev.id, in_directory: true }, C.ama, h.runtime);
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(row(after, C.ama).list_chosen, 1);
  assert.deepEqual(listed(db.getEventRow(ev.id)), ["Omari", "Ama"]);
});

test("the ask waits for the morning, and is dropped if the list goes private again first", async () => {
  const h = harness();
  const { ev } = await privateParty(h);
  // 22:00 in New York.
  clock.skip(10 * HOUR);
  await withYes(runTool, "event_settings", { event_id: ev.id, guest_list_visible: true }, { conversationId: OWNER_C, messages: [], events: h.runtime });
  await events.sweepListNotes({ runtime: h.runtime });
  await settle();
  assert.equal(h.channel.sent.length, 0, "not at night");
  await tool("event_settings", { event_id: ev.id, guest_list_visible: false }, OWNER_C, h.runtime);
  clock.skip(12 * HOUR);
  await events.sweepListNotes({ runtime: h.runtime });
  await settle();
  assert.equal(h.channel.sent.length, 0, "the list is private again, so the ask is moot");
});

test("showing a list nobody would be asked about needs no yes", async () => {
  const h = harness();
  const ev = events.create(OWNER_C, { name: "Quiet One", description: "x", starts_at: "2027-06-06T20:00", timezone: TZ, location: "x", password: "quietone", show_time_on_join: true, show_location_on_join: true, guest_list_visible: false }).event;
  const out = await tool("event_settings", { event_id: ev.id, guest_list_visible: true }, OWNER_C, h.runtime);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(db.getEventRow(ev.id).guest_list_visible, 1);
});

test("refusals come before any yes: somebody else's event, a guest, both a cap and no cap, nothing to change", async () => {
  const h = harness();
  const { ev } = await privateParty(h);
  const stranger = await tool("event_settings", { event_id: ev.id, guest_list_visible: true }, C.yaw, h.runtime);
  assert.equal(stranger.ok, false);
  assert.ok(!stranger.use_target && !stranger.asks, "a stranger is told nothing about the event");
  const guest = await tool("event_settings", { event_id: ev.id, capacity: 2 }, C.ama, h.runtime);
  assert.equal(guest.ok, false);
  assert.equal(db.getEventRow(ev.id).capacity, null);
  const both = await tool("event_settings", { event_id: ev.id, capacity: 4, no_cap: true }, OWNER_C, h.runtime);
  assert.match(both.error, /not both/);
  const none = await tool("event_settings", { event_id: ev.id }, OWNER_C, h.runtime);
  assert.match(none.error, /Nothing to change/);
  const zero = await tool("event_settings", { event_id: ev.id, capacity: 0 }, OWNER_C, h.runtime);
  assert.equal(zero.ok, false);
  assert.ok(toolsFor(OWNER_C).some(t => t.name === "event_settings"), "organizers see it");
});

// ---------- the cap ----------

test("a cap under the number in takes nobody off, closes joins on every route, and opens again only under the cap", async () => {
  const h = harness();
  const { ev } = await privateParty(h);
  const out = await tool("event_settings", { event_id: ev.id, capacity: 2 }, OWNER_C, h.runtime);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.blocked, undefined, "a cap texts nobody, so no yes");
  assert.deepEqual([out.capacity, out.going, out.joins_closed], [2, 3, true]);
  assert.equal(out.capacity_note, "3 are already in, more than the new cap of 2. Nobody was taken off. New joins are closed until fewer than 2 are in. Guests aren't told about a cap.");
  assert.equal(db.joinedCount(ev.id), 3, "nobody taken off");
  await settle();
  assert.equal(h.channel.sent.length, 0, "nobody texted");

  // Text join: refused as full, with words that promise nothing.
  const j = await tool("event_join", { link: events.eventUrl(ev), password: "skyline", display_name: "Abena" }, C.abena, h.runtime);
  assert.equal(j.reason, "full");
  assert.match(j.error, /same password works/);
  assert.match(j.error, /no waitlist/);
  // One leaves: still 2, still full. Another leaves: 1 < 2, a spot is open.
  assert.equal(db.leaveAttendee(row(ev, C.ama).id), true);
  assert.equal(db.addAttendee({ eventId: ev.id, conversationId: C.abena, displayName: "Abena", via: "text" }).reason, "full");
  // The join page, signed in: the same refusal, in the page's words.
  db.startPageSession("p-abena", "tok-abena-lim-000001", { conversationId: C.abena });
  const page = await req(h, ev, { sub: "join", method: "POST", body: form({ password: "skyline", display_name: "Abena" }), cookie: "reason_page=tok-abena-lim-000001" });
  assert.match(unesc(page.body), /This event is full right now\. If a spot opens up, the same link and password will work\./);
  assert.equal(db.joinedCount(ev.id), 2, "still full at 2 of 2");
  assert.equal(db.leaveAttendee(row(ev, C.esi).id), true);
  assert.equal(db.addAttendee({ eventId: ev.id, conversationId: C.abena, displayName: "Abena", via: "text" }).ok, true);
});

test("a cap at exactly the number in, a raise, and no cap", async () => {
  const h = harness();
  const { ev } = await privateParty(h, { capacity: 10 });
  const exact = await tool("event_settings", { event_id: ev.id, capacity: 3 }, OWNER_C, h.runtime);
  assert.match(exact.capacity_note, /^That's exactly how many are in \(3\), so new joins are closed now\. Nobody was taken off\./);
  const raised = await tool("event_settings", { event_id: ev.id, capacity: 5 }, OWNER_C, h.runtime);
  assert.match(raised.capacity_note, /^Up to 5 guests: 3 in, room for 2 more\./);
  assert.equal(raised.joins_closed, false);
  const off = await tool("event_settings", { event_id: ev.id, no_cap: true }, OWNER_C, h.runtime);
  assert.equal(off.capacity, null);
  assert.equal(db.getEventRow(ev.id).capacity, null);
  // Both at once: a list change and a cap, one call.
  const both = await tool("event_settings", { event_id: ev.id, guest_list_visible: false, capacity: 8 }, OWNER_C, h.runtime);
  assert.equal(both.ok, true);
  assert.equal(db.getEventRow(ev.id).capacity, 8);
});

// ---------- the page ----------

test("page: the Guests section shows both settings, and a stranger can't post them", async () => {
  const h = harness();
  const { ev } = await privateParty(h, { capacity: 3 });
  const r = await req(h, ev, { cookie: COOKIE.owner });
  assert.equal(r.status, 200);
  assert.match(r.body, /WHO SEES THE GUEST LIST/);
  assert.match(r.body, />PRIVATE</);
  assert.match(r.body, /Show the list to guests/);
  assert.match(r.body, /HOW MANY CAN JOIN/);
  assert.match(r.body, /FULL · 3 OF 3/);
  assert.match(r.body, /cap 3 \(full\)/);
  assert.match(r.body, /joined while the list was private/);
  const bad = await post(h, ev, { action: "cap", step: "do", capacity: "1" }, COOKIE.ama);
  assert.equal(bad.status, 404);
  assert.equal(db.getEventRow(ev.id).capacity, 3);
});

test("page: showing the list previews who gets asked and the exact text, and re-checks it on the send step", async () => {
  const h = harness();
  const { ev, g } = await privateParty(h);
  const review = await post(h, ev, { action: "list", step: "review", visible: "1" });
  assert.equal(review.status, 200);
  const html = unesc(review.body);
  assert.match(html, /Show the guest list to guests\?/);
  assert.match(html, /3 guests joined while it was private/);
  assert.match(html, /Reason texts 2 of them once to ask, never at night\. 1 won't be texted: they muted the event or were already asked\./);
  assert.match(html, /WHO GETS ASKED · 2/);
  assert.ok(html.includes("you're not on it — if you'd like to be, just let me know (you'd show as Ama)."));
  assert.equal(db.getEventRow(ev.id).guest_list_visible, 0, "the review changes nothing");
  const pin = hiddenField(review.body, "pin");
  // Esi mutes before the click: the page shows the new list instead of going ahead.
  db.updateAttendeeRow(g.esi.id, { muted: 1 });
  const stale = await post(h, ev, { action: "list", step: "do", visible: "1", pin });
  assert.equal(stale.status, 200);
  assert.match(stale.body, /changed since you looked/);
  assert.equal(db.getEventRow(ev.id).guest_list_visible, 0);
  const pin2 = hiddenField(stale.body, "pin");
  const ok = await post(h, ev, { action: "list", step: "do", visible: "1", pin: pin2 });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.Location, /done=list_shown&n=1#guests/);
  assert.equal(db.getEventRow(ev.id).guest_list_visible, 1);
  const landed = await req(h, ev, { cookie: COOKIE.owner, query: { done: "list_shown", n: "1" } });
  assert.match(unesc(landed.body), /Reason is asking 1 guest who joined while it was private/);
  // And hiding: one step, quiet.
  const hide = await post(h, ev, { action: "list", step: "review", visible: "0" });
  assert.match(unesc(hide.body), /Nobody is texted/);
  const hid = await post(h, ev, { action: "list", step: "do", visible: "0", pin: "x" });
  assert.equal(hid.status, 303);
  assert.equal(db.getEventRow(ev.id).guest_list_visible, 0);
});

test("page: only a cap that closes joining is asked about; bad input is refused; empty is no cap", async () => {
  const h = harness();
  const { ev } = await privateParty(h);
  const room = await post(h, ev, { action: "cap", step: "review", capacity: "10" });
  assert.equal(room.status, 303, "a cap with room saves straight away");
  assert.equal(db.getEventRow(ev.id).capacity, 10);
  const close = await post(h, ev, { action: "cap", step: "review", capacity: "2" });
  assert.equal(close.status, 200);
  const html = unesc(close.body);
  assert.match(html, /Set the cap to 2\?/);
  assert.match(html, /3 guests are already in, more than 2\. Nobody is taken off the event\./);
  assert.match(html, /A spot opens only when fewer than 2 are in\./);
  assert.equal(db.getEventRow(ev.id).capacity, 10, "nothing saved yet");
  const set = await post(h, ev, { action: "cap", step: "do", capacity: "2" });
  assert.equal(set.status, 303);
  assert.equal(db.getEventRow(ev.id).capacity, 2);
  assert.equal(db.joinedCount(ev.id), 3);
  const landed = await req(h, ev, { cookie: COOKIE.owner, query: { done: "cap_saved" } });
  assert.match(unesc(landed.body), /3 are already in, more than 2\. Nobody was taken off/);
  for (const bad of ["0", "-1", "2.5", "lots", "100001"]) {
    const r = await post(h, ev, { action: "cap", step: "review", capacity: bad });
    assert.equal(r.status, 200, bad);
    assert.match(r.body, /whole number from 1 to 100,000/);
  }
  const none = await post(h, ev, { action: "cap", step: "review", capacity: "" });
  assert.equal(none.status, 303);
  assert.equal(db.getEventRow(ev.id).capacity, null);
  await settle();
  assert.equal(h.channel.sent.length, 0, "a cap never texts anyone");
});
