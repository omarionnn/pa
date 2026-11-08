// Messages to only some guests (owner request 2026-11-08): an organizer's message now, or one they
// scheduled, can go to the guests they pick by name or to the ones who joined since a time. Pinned:
//
//   - the floor never moves: only joined guests, never one who muted, left or was taken off, whoever
//     was picked — and a pick naming somebody who isn't a guest is refused before any yes is asked;
//   - by text the yes is pinned to the words AND the guests: the target names how many and who, a
//     different pick is a different target, and someone muting between the ask and the send makes it
//     a different target too; everyone is pinned exactly as before;
//   - a scheduled pick is kept on the row and on the message it goes out as, so the sweep (and a
//     restart mid-send) reaches exactly those guests;
//   - the page: a "who gets it" choice, a preview with the exact count and every name, and a send
//     step that re-checks who it reaches; the history and the waiting list say who it was for.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { withYes } from "./fixture-yes.js";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-some-"));
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
const schedule = await import("../src/eventschedule.js");
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
const COOKIE = { owner: "reason_page=tok-owner-some-00001", ama: "reason_page=tok-ama-some-000001" };
const TZ = "America/New_York";
const HOUR = 60 * 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations;
    DELETE FROM inbound_messages; DELETE FROM page_sessions; DELETE FROM event_scheduled;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  for (const [c, a, n] of [[C.ama, AMA, "Ama"], [C.kofi, KOFI, "Kofi"], [C.yaw, YAW, "Yaw"], [C.esi, ESI, "Esi"], [C.abena, ABENA, "Abena"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
    db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(c);
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: false });
  }
  db.startPageSession("p-owner", "tok-owner-some-00001", { conversationId: OWNER_C });
  db.startPageSession("p-ama", "tok-ama-some-000001", { conversationId: C.ama });
});

function harness() {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel };
}
const at = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };
function nyDay(days, hh, mm = 0) {
  const d = new Date(clock.now() + days * 24 * HOUR);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
const settle = () => new Promise(r => setTimeout(r, 30));
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to).map(m => m.text);
const tool = (name, input, c, rt) => runTool(name, input, { conversationId: c, messages: [], events: rt });
const form = (o) => new URLSearchParams(o).toString();
async function req(h, ev, { sub = null, method = "GET", body = null, query = {}, cookie = "" } = {}) {
  const headers = { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test", host: "files.example.test" };
  return await eventRequestFor({ publicId: ev.public_id, sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router });
}
const post = (h, ev, fields, cookie = COOKIE.owner) => req(h, ev, { sub: "manage", method: "POST", body: typeof fields === "string" ? fields : form(fields), cookie });
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hiddenField = (html, name) => unesc((new RegExp(`name="${name}" value="([^"]*)"`).exec(html) ?? [])[1] ?? "");

/**
 * Five on the list: Ama, Esi and Abena joined; Kofi joined and muted the event; Yaw was taken off.
 * Abena joined a day after the others.
 */
async function party(h) {
  const out = events.create(OWNER_C, {
    name: "Halloween Party", description: "costumes", starts_at: nyDay(5, 21), timezone: TZ, location: "12 Elm St",
    welcome_message: "", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: false,
  });
  assert.equal(out.ok, true);
  const ev = out.event;
  const add = (c, name) => db.addAttendee({ eventId: ev.id, conversationId: c, displayName: name, via: "text" }).attendee;
  const g = { ama: add(C.ama, "Ama"), kofi: add(C.kofi, "Kofi"), yaw: add(C.yaw, "Yaw"), esi: add(C.esi, "Esi") };
  db.updateAttendeeRow(g.kofi.id, { muted: 1 });
  db.updateAttendeeRow(g.yaw.id, { state: "removed" });
  const before = clock.now();
  clock.skip(24 * HOUR);
  g.abena = add(C.abena, "Abena");
  await settle();
  h.channel.sent.length = 0;
  return { ev: db.getEventRow(ev.id), g, sinceWall: schedule.localInput(ev, before + 12 * HOUR) };
}

// ---------- who it can reach ----------

test("a pick is joined guests of this event only; muted guests are kept out whoever is picked", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  assert.deepEqual(events.pickAudience(ev, { guestIds: [g.esi.id, g.ama.id] }), { ok: true, audience: { guests: [g.ama.id, g.esi.id].sort((a, b) => a - b) } });
  assert.equal(events.pickAudience(ev, { guestIds: [g.ama.id, g.yaw.id] }).reason, "not_guests", "a guest who was taken off can't be picked");
  assert.deepEqual(events.pickAudience(ev, { guestIds: [g.ama.id, 99999] }).ids, [99999]);
  assert.equal(events.pickAudience(ev, { guestIds: [] }).reason, "none_picked");
  assert.equal(events.pickAudience(ev, { guestIds: [g.ama.id], joinedAfter: "2026-01-01T00:00" }).reason, "both");
  assert.equal(events.pickAudience(ev, { joinedAfter: "friday" }).reason, "bad_time");
  assert.deepEqual(events.pickAudience(ev, {}), { ok: true, audience: null }, "nothing picked is everyone");

  const two = { guests: [g.ama.id, g.kofi.id] };
  assert.deepEqual(events.recipients(ev, "blast", two).map(a => a.display_name), ["Ama"], "Kofi muted it");
  const reach = events.audience(ev, "blast", two);
  assert.deepEqual([reach.guests, reach.muted, reach.names], [1, 1, ["Ama"]]);
  assert.deepEqual(events.audience(ev, "blast").guests, 3, "everyone: Ama, Esi, Abena");
  // An unreadable stored pick never falls back to everyone.
  assert.equal(events.recipients(ev, "blast", "{not json").length, 0);
  // The cancellation always goes to everyone, muted guests too.
  assert.equal(events.recipients(ev, "cancel", two).length, 4);
});

test("joined since: only the guests who joined at or after the time", async () => {
  const h = harness();
  const { ev, sinceWall } = await party(h);
  const pick = events.pickAudience(ev, { joinedAfter: sinceWall });
  assert.equal(pick.ok, true);
  assert.deepEqual(events.recipients(ev, "blast", pick.audience).map(a => a.display_name), ["Abena"]);
  assert.match(events.audienceLabel(ev, pick.audience), /^guests who joined since /);
});

test("joined since: a guest who left and came back keeps their first join time, so they are not new (owner decision 2026-11-08)", async () => {
  const h = harness();
  const { ev, g, sinceWall } = await party(h);
  // Esi joined before the time, left, and came back after it.
  assert.equal(db.leaveAttendee(g.esi.id), true);
  clock.skip(HOUR);
  const back = db.addAttendee({ eventId: ev.id, conversationId: C.esi, displayName: "Esi", via: "text" });
  assert.equal(back.ok, true);
  assert.ok(back.attendee.joined_at > back.attendee.first_joined_at, "joined_at moved, first_joined_at did not");
  assert.equal(back.attendee.first_joined_at, g.esi.joined_at);
  const pick = events.pickAudience(ev, { joinedAfter: sinceWall });
  assert.deepEqual(events.recipients(ev, "blast", pick.audience).map(a => a.display_name), ["Abena"], "Esi is not counted as new");
  // The guest list (and the page's JOINED line) shows the same first join.
  assert.equal(events.guestList(ev).find(x => x.guest_id === g.esi.id).joined, new Date(g.esi.joined_at).toISOString());
});

// ---------- by text ----------

test("by text: the target names the count and every guest; nothing goes before the yes; then only they get it", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const input = { event_id: ev.id, message: "can you two come early?", only_guest_ids: [g.ama.id, g.esi.id] };
  const unasked = await tool("event_blast", input, OWNER_C, h.runtime);
  assert.equal(unasked.blocked, "needs_confirmation");
  assert.match(unasked.use_target, /blast to Halloween Party \(event #\d+\) to 2 guests you picked — 2 get it: Ama, Esi \{[0-9a-f]{12}\}: "can you two come early\?" \[[0-9a-f]{16}\]/);
  assert.deepEqual(unasked.reaches, { to: "2 guests you picked", guests: 2, names: ["Ama", "Esi"] });
  assert.equal(h.channel.sent.length, 0, "nobody is texted before the yes");
  assert.notEqual(tools.blastTarget(OWNER_C, { ...input, only_guest_ids: [g.ama.id] }), unasked.use_target, "another pick is another target");
  assert.match(tools.blastTarget(OWNER_C, { event_id: ev.id, message: "hi" }), /^blast to Halloween Party \(event #\d+\): "hi" \[[0-9a-f]{16}\]$/, "everyone is pinned exactly as before");

  const sent = await withYes(runTool, "event_blast", input, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.sent.guests, 2);
  await settle();
  const body = events.blastBody(ev, "can you two come early?");
  assert.ok(sentTo(h, AMA).includes(body) && sentTo(h, ESI).includes(body));
  for (const n of [KOFI, YAW, ABENA]) assert.equal(sentTo(h, n).length, 0, `${n} isn't in it`);
  const [m] = events.sentMessages(ev);
  assert.equal(m.audience, events.audienceKey({ guests: [g.ama.id, g.esi.id] }));
});

test("by text: a pick naming somebody who isn't a guest is refused before any yes is asked", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const out = await tool("event_blast", { event_id: ev.id, message: "hi", only_guest_ids: [g.ama.id, g.yaw.id] }, OWNER_C, h.runtime);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "not_guests");
  assert.ok(!out.use_target, "no yes is collected for something that can't go");
  assert.match(out.error, new RegExp(`#${g.yaw.id}`));
  const both = await tool("event_blast", { event_id: ev.id, message: "hi", only_guest_ids: [g.ama.id], only_joined_after: "2026-01-01T00:00" }, OWNER_C, h.runtime);
  assert.equal(both.reason, "both");
  // A guest can't use a pick to reach anybody: the organizer refusal comes first.
  const guest = await tool("event_blast", { event_id: ev.id, message: "hi", only_guest_ids: [g.esi.id] }, C.ama, h.runtime);
  assert.equal(guest.ok, false);
  assert.ok(!guest.use_target);
  assert.equal(h.channel.sent.length, 0);
});

test("by text: a guest muting between the ask and the send makes it a different target, so the old yes doesn't carry it", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const input = { event_id: ev.id, message: "quick one", only_guest_ids: [g.ama.id, g.esi.id] };
  const before = tools.blastTarget(OWNER_C, input);
  db.updateAttendeeRow(g.esi.id, { muted: 1 });
  const afterMute = tools.blastTarget(OWNER_C, input);
  assert.notEqual(afterMute, before);
  assert.match(afterMute, /1 get it: Ama/);
});

test("by text: a scheduled message for some guests is pinned, kept on the row, and the sweep reaches only them", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const ctx = { conversationId: OWNER_C, messages: [], events: h.runtime };
  const input = { event_id: ev.id, message: "drinks after?", send_at: nyDay(2, 18), only_guest_ids: [g.ama.id, g.esi.id] };
  const unasked = await tool("event_schedule", input, OWNER_C, h.runtime);
  assert.match(unasked.use_target, /to 2 guests you picked — 2 get it: Ama, Esi/);
  assert.deepEqual(unasked.reaches.names, ["Ama", "Esi"]);
  const set = await withYes(runTool, "event_schedule", input, ctx);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual(set.names_today, ["Ama", "Esi"]);
  const [row] = db.scheduledFor(ev.id, ["pending"]);
  assert.equal(row.audience, events.audienceKey({ guests: [g.ama.id, g.esi.id] }));
  const list = await tool("event_scheduled", { event_id: ev.id, action: "list" }, OWNER_C, h.runtime);
  assert.equal(list.waiting[0].to, "2 guests you picked");
  // Esi leaves before it goes: she doesn't get it.
  db.updateAttendeeRow(g.esi.id, { state: "left", left_at: clock.now() });
  at(row.send_at + 60_000);
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  const body = events.blastBody(ev, "drinks after?");
  assert.deepEqual(sentTo(h, AMA), [body]);
  for (const n of [ESI, KOFI, YAW, ABENA]) assert.equal(sentTo(h, n).length, 0);
  assert.equal(db.scheduledRow(row.id).state, "sent");
  assert.equal(db.eventMessage(db.scheduledRow(row.id).message_id).audience, row.audience, "the message carries the pick");
});

test("by text: changing a picked message's words keeps its guests; widening to everyone is said in so many words", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const ctx = { conversationId: OWNER_C, messages: [], events: h.runtime };
  const set = await withYes(runTool, "event_schedule", { event_id: ev.id, message: "cousins only", send_at: nyDay(2, 18), only_guest_ids: [g.ama.id, g.esi.id] }, ctx);
  const change = { event_id: ev.id, scheduled_id: set.scheduled_id, message: "cousins only, new words", send_at: nyDay(2, 18) };
  const unasked = await tool("event_schedule", change, OWNER_C, h.runtime);
  assert.match(unasked.use_target, /\(replacing #\d+\) to 2 guests you picked — 2 get it: Ama, Esi/, "the yes for a word fix names the same two");
  const changed = await withYes(runTool, "event_schedule", change, ctx);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(db.scheduledRow(set.scheduled_id).audience, events.audienceKey({ guests: [g.ama.id, g.esi.id] }), "still the two of them");
  const widen = await tool("event_schedule", { ...change, to_everyone: true }, OWNER_C, h.runtime);
  assert.match(widen.use_target, /now to everyone, was 2 guests you picked/);
  const wide = await withYes(runTool, "event_schedule", { ...change, to_everyone: true }, ctx);
  assert.equal(wide.ok, true);
  assert.equal(db.scheduledRow(set.scheduled_id).audience, null);
  // The page's change of a picked message back to everyone widens it too, through its own confirm.
  const again = schedule.schedule({ ev, conversationId: OWNER_C, message: "page one", sendAt: nyDay(3, 9), audience: { guests: [g.ama.id] } });
  const prev = await post(h, ev, { action: "schedule", step: "preview", message: "page one", send_at: nyDay(3, 9), to: "everyone", id: String(again.row.id) });
  assert.match(unesc(prev.body), /Reason texts this to everyone on the event/);
  await post(h, ev, { action: "schedule", step: "set", message: "page one", send_at: nyDay(3, 9), to: "everyone", id: String(again.row.id) });
  assert.equal(db.scheduledRow(again.row.id).audience, null);
});

test("a scheduled pick claimed by a process that stopped is finished to the same guests only", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const s = schedule.schedule({ ev, conversationId: OWNER_C, message: "just you", sendAt: nyDay(2, 10), audience: { guests: [g.esi.id] } });
  assert.equal(s.ok, true);
  at(s.row.send_at + 30_000);
  // Claimed, then the process stopped before anybody was texted.
  db.claimScheduledMessage(s.row.id, (r) => events.blastBody(ev, r.body), "scheduled");
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.deepEqual(sentTo(h, ESI), [events.blastBody(ev, "just you")]);
  assert.equal(h.channel.sent.length, 1, "nobody else");
});

test("joined since, scheduled: somebody who joins after it was set but before it goes gets it too", async () => {
  const h = harness();
  const { ev, sinceWall } = await party(h);
  const s = schedule.schedule({ ev, conversationId: OWNER_C, message: "welcome newcomers", sendAt: nyDay(2, 10), audience: events.pickAudience(ev, { joinedAfter: sinceWall }).audience });
  assert.equal(s.reach.guests, 1);
  db.addAttendee({ eventId: ev.id, conversationId: "dm:fake:+13475550009", displayName: "Late", via: "text" });
  db.upsertAccount({ conversationId: "dm:fake:+13475550009", channel: "fake", address: "+13475550009", name: "Late" });
  db.upsertThread({ conversationId: "dm:fake:+13475550009", channel: "fake", address: "+13475550009", isOwner: false });
  at(s.row.send_at + 30_000);
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  const body = events.blastBody(ev, "welcome newcomers");
  assert.deepEqual(sentTo(h, ABENA), [body]);
  assert.deepEqual(sentTo(h, "+13475550009"), [body]);
  assert.equal(sentTo(h, AMA).length, 0, "Ama joined before the time");
});

test("the same words to two different picks inside a few minutes are two messages, not one", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const body = events.blastBody(ev, "you're on snacks");
  const a = await events.broadcast({ runtime: h.runtime, ev, kind: "blast", body, audience: { guests: [g.ama.id] } });
  const b = await events.broadcast({ runtime: h.runtime, ev, kind: "blast", body, audience: { guests: [g.esi.id] } });
  assert.notEqual(a.message_id, b.message_id);
  const again = await events.broadcast({ runtime: h.runtime, ev, kind: "blast", body, audience: { guests: [g.ama.id] } });
  assert.equal(again.message_id, a.message_id, "the same pick asked twice is still one message");
  await settle();
  assert.equal(sentTo(h, AMA).length, 1);
  assert.equal(sentTo(h, ESI).length, 1);
});

test("the tool descriptions hand the reading of who they meant to the model, and the guest list carries guest_id", () => {
  const defs = Object.fromEntries(toolsFor(OWNER_C).map(t => [t.name, t]));
  for (const n of ["event_blast", "event_schedule"]) {
    assert.ok(defs[n].input_schema.properties.only_guest_ids, `${n} takes only_guest_ids`);
    assert.ok(defs[n].input_schema.properties.only_joined_after, `${n} takes only_joined_after`);
    assert.match(defs[n].description, /read who they mean against the list from event_guests/);
    assert.match(defs[n].description, /ask before calling/);
  }
  assert.match(defs.event_guests.description, /guest_id \(what only_guest_ids takes/);
});

// ---------- the page ----------

test("page: the who-gets-it choice lists joined guests only, never removed ones or phone numbers", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const page = await req(h, ev, { cookie: COOKIE.owner });
  assert.equal(page.status, 200);
  for (const s of ["02</span> · MESSAGE GUESTS", "Text your guests", "WHO GETS IT", "Everyone · 3 guests", "Only guests I pick", "Guests who joined since"]) assert.ok(unesc(page.body).includes(s), `has ${s}`);
  for (const x of [g.ama, g.esi, g.abena, g.kofi]) assert.ok(page.body.includes(`name="g" value="${x.id}"`), `${x.display_name} can be picked`);
  assert.ok(!page.body.includes(`name="g" value="${g.yaw.id}"`), "a guest who was taken off can't be picked");
  assert.ok(!/3475550/.test(page.body));
  // Both forms carry it: now and later.
  assert.equal((page.body.match(/<fieldset class="mg-pick">/g) ?? []).length, 2);
});

test("page: a muted guest is in the pick list with no muted label, and still gets nothing when picked (owner decision 2026-11-08)", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const page = await req(h, ev, { cookie: COOKIE.owner });
  const picks = (/<div class="mg-picks"[^>]*>([\s\S]*?)<\/div>/.exec(page.body) ?? [])[1] ?? "";
  assert.ok(picks.includes(`name="g" value="${g.kofi.id}"`), "Kofi (muted) can be picked");
  assert.ok(!/mute/i.test(picks), "no muted label anywhere in the pick list");
  assert.ok(!("muted" in events.guestList(ev)[0]), "the text tool's guest list carries no muted flag either");
  const pick = events.pickAudience(ev, { guestIds: [g.kofi.id, g.ama.id] });
  assert.deepEqual(events.recipients(ev, "blast", pick.audience).map(a => a.display_name), ["Ama"], "recipients stay joined and unmuted");
});

test("page: the preview shows the exact count and every name; send reaches only them; history says who", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const fields = `action=blast&step=preview&message=${encodeURIComponent("costume check at 8")}&to=some&g=${g.ama.id}&g=${g.kofi.id}&g=${g.esi.id}`;
  const prev = await post(h, ev, fields);
  assert.equal(prev.status, 200);
  const text = unesc(prev.body);
  assert.match(text, /Send this to 2 guests\?/);
  assert.match(text, /Only 2 guests get it: Ama and Esi\. Nobody else on the event does\./);
  assert.match(text, /1 guest you picked muted the event and won't get it\./);
  assert.match(text, /WHO GETS IT · 2/);
  assert.match(text, /Send to 2 guests/);
  assert.equal(h.channel.sent.length, 0, "a preview sends nothing");
  const pin = hiddenField(prev.body, "pin");
  assert.equal(hiddenField(prev.body, "g"), [g.ama.id, g.kofi.id, g.esi.id].join(","));
  const send = await post(h, ev, { action: "blast", step: "send", message: "costume check at 8", to: "some", g: [g.ama.id, g.kofi.id, g.esi.id].join(","), pin });
  assert.equal(send.status, 303);
  assert.match(send.headers.Location, /done=blast&n=2&f=0&g=2#message/);
  await settle();
  const body = events.blastBody(ev, "costume check at 8");
  assert.deepEqual([sentTo(h, AMA), sentTo(h, ESI)], [[body], [body]]);
  for (const n of [KOFI, YAW, ABENA]) assert.equal(sentTo(h, n).length, 0);
  const after = unesc((await req(h, ev, { cookie: COOKIE.owner })).body);
  assert.match(after, /MESSAGE TO 3 GUESTS YOU PICKED · /);
});

test("page: if who it reaches changed since the preview, the send step shows the new list and sends nothing", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const prev = await post(h, ev, { action: "blast", step: "preview", message: "hey", to: "some", g: `${g.ama.id},${g.esi.id}` });
  const pin = hiddenField(prev.body, "pin");
  db.updateAttendeeRow(g.esi.id, { muted: 1 });
  const send = await post(h, ev, { action: "blast", step: "send", message: "hey", to: "some", g: `${g.ama.id},${g.esi.id}`, pin });
  assert.equal(send.status, 200);
  const text = unesc(send.body);
  assert.match(text, /Who gets it changed since you looked/);
  assert.match(text, /Only 1 guest gets it: Ama\./);
  assert.equal(h.channel.sent.length, 0);
  assert.equal(events.sentMessages(ev).length, 0);
});

test("page: nothing ticked, or a hand-made post naming a removed guest, is refused with a plain line and sends nothing", async () => {
  const h = harness();
  const { ev, g } = await party(h);
  const none = await post(h, ev, { action: "blast", step: "preview", message: "hey", to: "some" });
  assert.equal(none.status, 200);
  assert.match(unesc(none.body), /Tick at least one guest, or send it to everyone\./);
  const removed = await post(h, ev, { action: "blast", step: "send", message: "hey", to: "some", g: String(g.yaw.id), pin: String(g.yaw.id) });
  assert.equal(removed.status, 200);
  assert.match(unesc(removed.body), /isn't on the event any more/);
  const noTime = await post(h, ev, { action: "blast", step: "preview", message: "hey", to: "since", joined_after: "" });
  assert.match(unesc(noTime.body), /Pick the date and time they joined since\./);
  assert.equal(h.channel.sent.length, 0);
  // A guest's browser posting a pick gets the flat not-found.
  assert.equal((await post(h, ev, { action: "blast", step: "send", message: "hey", to: "some", g: String(g.esi.id) }, COOKIE.ama)).status, 404);
});

test("page: schedule for some guests — preview names them, the waiting list says who, and change keeps the pick", async () => {
  const h = harness();
  const { ev, g, sinceWall } = await party(h);
  const wall = nyDay(3, 10);
  const prev = await post(h, ev, { action: "schedule", step: "preview", message: "set up crew: 6pm", send_at: wall, to: "some", g: `${g.ama.id},${g.esi.id}` });
  const text = unesc(prev.body);
  assert.match(text, /Schedule this for the guests you picked\?/);
  assert.match(text, /It goes only to 2 guests: Ama and Esi\. Nobody else on the event will get it\./);
  assert.match(text, /If one of them leaves before then, they won't get it\./);
  const set = await post(h, ev, { action: "schedule", step: "set", message: "set up crew: 6pm", send_at: wall, to: "some", g: `${g.ama.id},${g.esi.id}`, pin: hiddenField(prev.body, "pin") });
  assert.equal(set.status, 303);
  const [row] = db.scheduledFor(ev.id, ["pending"]);
  assert.equal(row.audience, events.audienceKey({ guests: [g.ama.id, g.esi.id] }));
  const page = unesc((await req(h, ev, { cookie: COOKIE.owner })).body);
  assert.match(page, /TO 2 GUESTS YOU PICKED: AMA, ESI/);
  const edit = await req(h, ev, { cookie: COOKIE.owner, query: { edit: String(row.id) } });
  assert.match(edit.body, new RegExp(`name="g" value="${g.ama.id}" checked`));
  assert.match(edit.body, /name="to" value="some" checked/);
  // Joined since, on the page.
  const since = await post(h, ev, { action: "schedule", step: "preview", message: "newcomers!", send_at: wall, to: "since", joined_after: sinceWall });
  assert.match(unesc(since.body), /Right now that's 1 guest: Abena\./);
  assert.match(unesc(since.body), /Anybody else who joins before it goes gets it too/);
  assert.equal(h.channel.sent.length, 0);
});

test("everyone still works exactly as before on the page", async () => {
  const h = harness();
  const { ev } = await party(h);
  const prev = await post(h, ev, { action: "blast", step: "preview", message: "hello all", to: "everyone" });
  assert.match(unesc(prev.body), /Send this to everyone\?/);
  assert.match(unesc(prev.body), /Reason texts this to 3 guests/);
  const send = await post(h, ev, { action: "blast", step: "send", message: "hello all", to: "everyone" });
  assert.equal(send.status, 303);
  await settle();
  for (const n of [AMA, ESI, ABENA]) assert.equal(sentTo(h, n).length, 1);
  assert.equal(sentTo(h, KOFI).length, 0);
  assert.equal(events.sentMessages(ev)[0].audience, null);
});
