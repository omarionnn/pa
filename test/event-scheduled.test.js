// Scheduled messages and the automatic reminders (src/eventschedule.js), by text and on the
// organizer's page. Pinned here:
//
//   - a scheduled message is a blast with a clock: the same words (blastBody), the same guests
//     (joined, not muted), tracked per guest, shown in the page's history with sent / failed counts;
//   - by text it sits behind the confirm gate like event_blast, the yes pinned to the words AND the
//     time, and a time in the past is refused before anybody is asked for a yes;
//   - it goes once: two passes never both send it, and a row a stopped process left mid-send is
//     finished on the next pass without a second copy to anybody;
//   - nothing goes for a cancelled event, while it is paused, to a guest who left or was removed, or
//     hours late;
//   - reminders: on for new events, off for events made before; the day before at 6 PM and two hours
//     before, in the event's zone, never while the time is hidden, never at night, once per start time;
//   - the page: preview + count + confirm, change, cancel, each reminder on / off, and nobody but the
//     organizer can post any of it.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { withYes } from "./fixture-yes.js";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-event-scheduled-"));
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

const OWNER = "+12025551234", AMA = "+13475550000", KOFI = "+13475550001", YAW = "+13475550002", ESI = "+13475550003";
const OWNER_C = config.ownerConversation, AMA_C = `dm:fake:${AMA}`, KOFI_C = `dm:fake:${KOFI}`, YAW_C = `dm:fake:${YAW}`, ESI_C = `dm:fake:${ESI}`;
const LINE = "+16562167455";
const COOKIE = { owner: "reason_page=tok-owner-sched-0001", ama: "reason_page=tok-ama-sched-0001", kofi: "reason_page=tok-kofi-sched-0001" };
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
  for (const [c, a, n] of [[AMA_C, AMA, "Ama"], [KOFI_C, KOFI, "Kofi"], [YAW_C, YAW, "Yaw"], [ESI_C, ESI, "Esi"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
    db.db.prepare("UPDATE accounts SET contact_card_sent_at = 1 WHERE conversation_id = ?").run(c);
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: false });
  }
  db.startPageSession("p-owner", "tok-owner-sched-0001", { conversationId: OWNER_C });
  db.startPageSession("p-ama", "tok-ama-sched-0001", { conversationId: AMA_C });
  db.startPageSession("p-kofi", "tok-kofi-sched-0001", { conversationId: KOFI_C });
});

function harness() {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel };
}
/** Move the clock to an instant. */
const at = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };
/** A wall-clock time in New York, `days` from now, at hh:mm. */
function nyDay(days, hh, mm = 0) {
  const d = new Date(clock.now() + days * 24 * HOUR);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
const ms = (wall) => events.parseStartsAt(wall, TZ);
const make = (organizer, over = {}) => {
  const out = events.create(organizer, {
    name: "Halloween Party", description: "costumes mandatory", starts_at: nyDay(5, 21), timezone: TZ, location: "12 Elm St, Apt 4",
    welcome_message: "", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: false, ...over,
  });
  assert.equal(out.ok, true);
  return out.event;
};
const join = async (c, ev, pw = "pumpkin") => (await events.joinExisting({ conversationId: c, link: events.eventUrl(ev), password: pw, inDirectory: true })).attendee;
/** Straight onto the guest list, past the join rate limit, for tests about what happens after. */
const add = (c, ev) => db.addAttendee({ eventId: ev.id, conversationId: c, displayName: c.slice(-4), via: "text" }).attendee;
const settle = () => new Promise(r => setTimeout(r, 30));
const sentTo = (h, to) => h.channel.sent.filter(m => m.to === to).map(m => m.text);
const tool = (name, input, c, rt) => runTool(name, input, { conversationId: c, messages: [], events: rt });
const form = (o) => new URLSearchParams(o).toString();
async function req(h, ev, { sub = null, method = "GET", body = null, query = {}, cookie = "", origin = null } = {}) {
  const headers = { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test", host: "files.example.test" };
  if (origin) headers.origin = origin;
  return await eventRequestFor({ publicId: ev.public_id, sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router });
}
const post = (h, ev, fields, cookie = COOKIE.owner) => req(h, ev, { sub: "manage", method: "POST", body: form(fields), cookie });
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const bubbles = (html) => [...html.matchAll(/<p class="mg-bubble"[^>]*>([\s\S]*?)<\/p>/g)].map(m => unesc(m[1]));

/** Three guests: Ama, Kofi (muted), Yaw (removed). */
async function party(h, over = {}) {
  const ev = make(OWNER_C, over);
  await join(AMA_C, ev); await join(KOFI_C, ev); await join(YAW_C, ev);
  db.updateAttendeeRow(db.attendeeRow(ev.id, KOFI_C).id, { muted: 1 });
  db.updateAttendeeRow(db.attendeeRow(ev.id, YAW_C).id, { state: "removed" });
  await settle();
  h.channel.sent.length = 0;
  return db.getEventRow(ev.id);
}

// ---------- defaults ----------

test("reminders are on for a new event and off for one made before reminders existed", () => {
  const ev = make(OWNER_C);
  assert.equal(ev.remind_day_before, 1);
  assert.equal(ev.remind_soon, 1);
  // An event row written the way every event before this change was: without the two columns.
  db.db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, tz, password_hash, organizer_token, created_at, updated_at)
    VALUES ('oldoldoldoldold1', ?, 'Old One', 'old one', ?, 'scrypt$x', 'old-token-old-token-old-token-01', 1, 1)`).run(OWNER_C, TZ);
  const old = db.eventByPublicId("oldoldoldoldold1");
  assert.equal(old.remind_day_before, 0);
  assert.equal(old.remind_soon, 0);
  assert.deepEqual(schedule.reminders(old).map(r => r.on), [false, false]);
});

test("the two tools are shown to an organizer and not to a guest who organizes nothing", () => {
  make(OWNER_C);
  config.events = "owner";
  const names = (c) => toolsFor(c).map(t => t.name);
  assert.ok(names(OWNER_C).includes("event_schedule") && names(OWNER_C).includes("event_scheduled"));
  assert.ok(!names(AMA_C).includes("event_schedule") && !names(AMA_C).includes("event_scheduled"));
});

// ---------- by text ----------

test("by text: no yes sets nothing and hands back a target pinned to the words and the time; a yes sets it", async () => {
  const h = harness();
  const ev = await party(h);
  const input = { event_id: ev.id, message: "bring a dish!", send_at: nyDay(3, 10) };
  const unasked = await tool("event_schedule", input, OWNER_C, h.runtime);
  assert.equal(unasked.blocked, "needs_confirmation");
  assert.match(unasked.use_target, /scheduled message to Halloween Party .* at .*10:00 AM.*"bring a dish!"/);
  assert.equal(db.scheduledFor(ev.id).length, 0, "nothing is set before the yes");
  const other = tools.scheduleTarget(OWNER_C, { ...input, send_at: nyDay(3, 11) });
  assert.notEqual(other, unasked.use_target, "another time is another target");
  assert.notEqual(tools.scheduleTarget(OWNER_C, { ...input, message: "bring two dishes" }), unasked.use_target, "other words are another target");
  const set = await withYes(runTool, "event_schedule", input, { conversationId: OWNER_C, messages: [], events: h.runtime });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.guests_today, 1, "Ama only: Kofi muted, Yaw removed");
  assert.equal(set.text_guests_get, events.blastBody(ev, "bring a dish!"));
  const [row] = db.scheduledFor(ev.id, ["pending"]);
  assert.equal(row.send_at, ms(nyDay(3, 10)));
  assert.equal(h.channel.sent.length, 0, "scheduling texts nobody");
  const list = await tool("event_scheduled", { event_id: ev.id, action: "list" }, OWNER_C, h.runtime);
  assert.deepEqual(list.waiting.map(w => [w.scheduled_id, w.message]), [[row.id, "bring a dish!"]]);
  assert.deepEqual(list.reminders.map(r => r.which), ["day_before", "two_hours"]);
});

test("by text: a time in the past is refused before any yes is asked for; a guest can't schedule", async () => {
  const h = harness();
  const ev = await party(h);
  const past = await tool("event_schedule", { event_id: ev.id, message: "hi", send_at: nyDay(-1, 10) }, OWNER_C, h.runtime);
  assert.equal(past.ok, false);
  assert.equal(past.reason, "past");
  assert.ok(!past.use_target, "no yes is collected for something that can't happen");
  const guest = await tool("event_schedule", { event_id: ev.id, message: "hijack", send_at: nyDay(2, 10) }, AMA_C, h.runtime);
  assert.equal(guest.ok, false);
  assert.ok(!guest.use_target);
  assert.equal(db.scheduledFor(ev.id).length, 0);
});

test("by text: change needs its own yes; cancel needs none and sends nothing", async () => {
  const h = harness();
  const ev = await party(h);
  const ctx = { conversationId: OWNER_C, messages: [], events: h.runtime };
  const t12 = ms(nyDay(3, 12));
  const set = await withYes(runTool, "event_schedule", { event_id: ev.id, message: "first words", send_at: nyDay(3, 10) }, ctx);
  const changeUnasked = await tool("event_schedule", { event_id: ev.id, scheduled_id: set.scheduled_id, message: "new words", send_at: nyDay(3, 12) }, OWNER_C, h.runtime);
  assert.equal(changeUnasked.blocked, "needs_confirmation");
  assert.match(changeUnasked.use_target, /replacing #\d+/);
  const changed = await withYes(runTool, "event_schedule", { event_id: ev.id, scheduled_id: set.scheduled_id, message: "new words", send_at: nyDay(3, 12) }, ctx);
  assert.equal(changed.changed, true);
  assert.deepEqual(db.scheduledFor(ev.id, ["pending"]).map(r => [r.body, r.send_at]), [["new words", ms(nyDay(3, 12))]]);
  const gone = await tool("event_scheduled", { event_id: ev.id, action: "cancel", scheduled_id: set.scheduled_id }, OWNER_C, h.runtime);
  assert.equal(gone.ok, true);
  assert.equal(db.scheduledFor(ev.id, ["pending"]).length, 0);
  at(t12 + 60_000);
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(h.channel.sent.length, 0, "a cancelled message never goes");
});

// ---------- sending ----------

test("it goes at its time, once, to joined unmuted guests only, and shows in the history with counts", async () => {
  const h = harness();
  const ev = await party(h);
  const set = schedule.schedule({ ev, conversationId: OWNER_C, message: "doors at 9!", sendAt: nyDay(2, 18) });
  assert.equal(set.ok, true);
  const due = set.row.send_at;
  at(due - 60_000);
  await schedule.sweep({ runtime: h.runtime });
  assert.equal(h.channel.sent.length, 0, "not before its time");
  at(due + 30_000);
  const out = await Promise.all([schedule.sweep({ runtime: h.runtime }), schedule.sweep({ runtime: h.runtime })]);
  await settle();
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  const body = events.blastBody(ev, "doors at 9!");
  assert.deepEqual(sentTo(h, AMA).filter(t => t === body).length, 1, "Ama gets it exactly once across overlapping passes");
  assert.equal(sentTo(h, KOFI).length, 0, "muted");
  assert.equal(sentTo(h, YAW).length, 0, "removed");
  assert.equal(out.reduce((n, o) => n + o.messages, 0), 1);
  assert.equal(db.scheduledRow(set.row.id).state, "sent");
  const [hist] = events.sentMessages(ev);
  assert.deepEqual([hist.kind, hist.body, hist.total, hist.sent, hist.failed], ["scheduled", body, 1, 1, 0]);
});

test("a row left mid-send by a stopped process is finished on the next pass, nobody gets a second copy", async () => {
  const h = harness();
  const ev = make(OWNER_C);
  await join(AMA_C, ev); await join(ESI_C, ev);
  await settle();
  h.channel.sent.length = 0;
  const set = schedule.schedule({ ev, conversationId: OWNER_C, message: "see you soon", sendAt: nyDay(1, 12) });
  at(set.row.send_at + 1000);
  // The process claims it, reaches Ama, and stops before Esi.
  const claimed = db.claimScheduledMessage(set.row.id, (r) => events.blastBody(ev, r.body), "scheduled");
  await events.deliver({ runtime: h.runtime, message: db.eventMessage(claimed.message_id), conversationId: AMA_C });
  await settle();
  assert.equal(db.scheduledRow(set.row.id).state, "sending");
  // A new process: a fresh runtime, the same database. Its first pass finishes the row.
  const h2 = harness();
  const out = await h2.runtime.eventScheduled();
  await settle();
  assert.equal(out.resumed, 1);
  const body = events.blastBody(ev, "see you soon");
  assert.equal([...sentTo(h, AMA), ...sentTo(h2, AMA)].filter(t => t === body).length, 1, "Ama once");
  assert.equal(sentTo(h2, ESI).filter(t => t === body).length, 1, "Esi once, on the restart");
  assert.equal(db.scheduledRow(set.row.id).state, "sent");
  await h2.runtime.eventScheduled();
  await settle();
  assert.equal(sentTo(h2, ESI).filter(t => t === body).length, 1, "and not again");
});

test("the full runtime sweep carries it (the pass a boot starts every 15 s)", async () => {
  const h = harness();
  const ev = await party(h);
  const s = schedule.schedule({ ev, conversationId: OWNER_C, message: "from the sweep", sendAt: nyDay(1, 15) });
  at(s.row.send_at + 5000);
  const out = await h.runtime.sweep();
  await settle();
  assert.equal(out.event_scheduled.messages, 1, JSON.stringify(out.event_scheduled));
  assert.ok(sentTo(h, AMA).includes(events.blastBody(ev, "from the sweep")));
});

test("nothing goes for a cancelled event; its waiting messages are cancelled with it", async () => {
  const h = harness();
  const ev = await party(h);
  const s = schedule.schedule({ ev, conversationId: OWNER_C, message: "still on?", sendAt: nyDay(2, 10) });
  await tools.runEventTool("event_cancel", { event_id: ev.id }, { conversationId: OWNER_C, events: h.runtime });
  await settle();
  h.channel.sent.length = 0;
  assert.deepEqual(db.scheduledFor(ev.id).map(r => r.state), ["cancelled"]);
  at(s.row.send_at + 1000);
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(h.channel.sent.length, 0);
});

test("paused when due: it waits; resumed in time, it goes; hours late, it is dropped as missed, never sent stale", async () => {
  const h = harness();
  const ev = await party(h);
  const a = schedule.schedule({ ev, conversationId: OWNER_C, message: "goes after resume", sendAt: nyDay(2, 10) });
  const b = schedule.schedule({ ev, conversationId: OWNER_C, message: "too late now", sendAt: nyDay(2, 11) });
  events.pause(ev.id);
  const c = schedule.schedule({ ev, conversationId: OWNER_C, message: "stale", sendAt: nyDay(3, 10) });
  at(b.row.send_at + 1000);
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(h.channel.sent.length, 0, "nothing while paused");
  await events.resume({ runtime: h.runtime, eventId: ev.id });
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(db.scheduledRow(a.row.id).state, "sent");
  assert.equal(db.scheduledRow(b.row.id).state, "sent");
  assert.equal(sentTo(h, AMA).length, 2);
  // Reason down for three hours across a message's time: dropped, and the organizer's page says so.
  at(c.row.send_at + 3 * HOUR);
  const out = await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(out.missed, 1);
  assert.equal(db.scheduledRow(c.row.id).state, "missed");
  assert.ok(!sentTo(h, AMA).some(t => /stale/.test(t)));
  assert.equal(schedule.missedFor(db.getEventRow(ev.id)).length, 1);
});

test("a guest who leaves before the time doesn't get it; one who joins before it does", async () => {
  const h = harness();
  const ev = await party(h);
  const s = schedule.schedule({ ev, conversationId: OWNER_C, message: "who gets this", sendAt: nyDay(2, 10) });
  db.leaveAttendee(db.attendeeRow(ev.id, AMA_C).id);
  await join(ESI_C, ev);
  await settle();
  h.channel.sent.length = 0;
  at(s.row.send_at + 1000);
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(sentTo(h, AMA).length, 0);
  assert.equal(sentTo(h, ESI).length, 1);
});

// ---------- reminders ----------

test("reminders: the day before at 6 PM and two hours before, in the event's zone, once each, hidden place left out", async () => {
  const h = harness();
  const ev = await party(h);
  const start = ev.starts_at;
  const dayBefore = ms(nyDay(4, 18));
  assert.equal(schedule.reminderAt(ev, "day_before"), dayBefore);
  assert.equal(schedule.reminderAt(ev, "two_hours"), start - 2 * HOUR);
  at(dayBefore - 60_000);
  await schedule.sweep({ runtime: h.runtime });
  assert.equal(h.channel.sent.length, 0);
  at(dayBefore + 60_000);
  await schedule.sweep({ runtime: h.runtime });
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  const day = sentTo(h, AMA);
  assert.equal(day.length, 1, "once");
  assert.equal(day[0], `reminder: Halloween Party is tomorrow — ${events.whenLine(ev)}.`);
  assert.ok(!/Elm/.test(day[0]), "the location is still hidden, so it isn't in it");
  assert.equal(sentTo(h, KOFI).length + sentTo(h, YAW).length, 0, "muted and removed guests get no reminder");
  assert.equal(schedule.reminderStatus(db.getEventRow(ev.id), "day_before").state, "sent");
  // The place shared since: the two-hours one carries it.
  db.updateEventRow(ev.id, { location_released: 1 });
  at(start - 2 * HOUR + 60_000);
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(sentTo(h, AMA).length, 2);
  assert.match(sentTo(h, AMA)[1], /^reminder: Halloween Party starts in about 2 hours, at 9:00 PM E[SD]T\.\nwhere: 12 Elm St, Apt 4$/);
  const hist = events.sentMessages(db.getEventRow(ev.id));
  assert.deepEqual(hist.map(m => [m.kind, m.sent]), [["reminder", 1], ["reminder", 1]]);
});

test("reminders: never while the time is hidden, never at night, never when off, never for an old event", async () => {
  const h = harness();
  const hidden = await party(h, { show_time_on_join: false });
  const early = make(OWNER_C, { name: "Breakfast", starts_at: nyDay(5, 9), password: "eggs1" });
  add(AMA_C, early);
  const off = make(OWNER_C, { name: "Dinner", password: "rice1" });
  add(AMA_C, off);
  schedule.setReminder(off, "day_before", false);
  schedule.setReminder(db.getEventRow(off.id), "two_hours", false);
  const old = make(OWNER_C, { name: "Old Party", password: "olden" });
  add(AMA_C, old);
  db.db.prepare("UPDATE events SET remind_day_before = 0, remind_soon = 0 WHERE id = ?").run(old.id);
  await settle();
  h.channel.sent.length = 0;
  assert.equal(schedule.reminderStatus(hidden, "day_before").state, "time_hidden");
  assert.equal(schedule.reminderStatus(db.getEventRow(early.id), "two_hours").state, "night", "7 AM is the night there");
  const times = [ms(nyDay(4, 18)) + 60_000, ms(nyDay(5, 7)) + 60_000, ms(nyDay(5, 19)) + 60_000];
  for (const t of times) {
    at(t);
    await schedule.sweep({ runtime: h.runtime });
  }
  await settle();
  const got = sentTo(h, AMA);
  assert.deepEqual(got, [`reminder: Breakfast is tomorrow — ${events.whenLine(db.getEventRow(early.id))}.`], "only Breakfast's day-before one");
});

test("an event made after its reminder's time doesn't send it late", async () => {
  const h = harness();
  // Made at 7 PM on the day, for 9 PM: yesterday's 6 PM one is long gone by.
  at(ms(nyDay(1, 19)));
  const late = make(OWNER_C, { name: "Tonight", starts_at: nyDay(0, 21), password: "tonite" });
  add(AMA_C, late);
  await settle();
  h.channel.sent.length = 0;
  assert.equal(schedule.reminderStatus(late, "day_before").state, "too_late");
  await schedule.sweep({ runtime: h.runtime });
  await settle();
  assert.equal(sentTo(h, AMA).length, 0);
});

test("by text: a reminder turned off and on, and the list says where each stands", async () => {
  const h = harness();
  const ev = await party(h);
  const off = await tool("event_scheduled", { event_id: ev.id, action: "reminder", reminder: "two_hours", enabled: false }, OWNER_C, h.runtime);
  assert.equal(off.ok, true);
  assert.equal(off.reminder.state, "off");
  assert.equal(db.getEventRow(ev.id).remind_soon, 0);
  const list = await tool("event_scheduled", { event_id: ev.id, action: "list" }, OWNER_C, h.runtime);
  assert.deepEqual(list.reminders.map(r => r.state), ["upcoming", "off"]);
  assert.equal((await tool("event_scheduled", { event_id: ev.id, action: "reminder", reminder: "two_hours", enabled: true }, AMA_C, h.runtime)).ok, false, "a guest can't");
});

// ---------- the page ----------

test("page: the section, preview with the exact text and the count, nothing set until confirmed, then it's waiting", async () => {
  const h = harness();
  const ev = await party(h);
  const page = await req(h, ev, { cookie: COOKIE.owner });
  for (const s of ["03</span> · LATER", "Send it later", "WAITING TO GO", "AUTOMATIC REMINDERS", "THE DAY BEFORE", "TWO HOURS BEFORE", 'href="#schedule"']) assert.ok(page.body.includes(s), `has ${s}`);
  const wall = nyDay(3, 10);
  const prev = await post(h, ev, { action: "schedule", step: "preview", message: "  bring a dish  ", send_at: wall });
  assert.equal(prev.status, 200);
  assert.deepEqual(bubbles(prev.body), [events.blastBody(ev, "bring a dish")]);
  assert.match(prev.body, /That&#39;s 1 guest right now|That's 1 guest right now/);
  assert.match(prev.body, /1 guest muted this event/);
  assert.equal(db.scheduledFor(ev.id).length, 0, "a preview sets nothing");
  const set = await post(h, ev, { action: "schedule", step: "set", message: "  bring a dish  ", send_at: wall });
  assert.equal(set.status, 303);
  assert.match(set.headers.Location, /done=scheduled&s=\d+#schedule/);
  const [row] = db.scheduledFor(ev.id, ["pending"]);
  assert.deepEqual([row.body, row.send_at], ["bring a dish", ms(wall)]);
  const after = await req(h, ev, { cookie: COOKIE.owner, query: { done: "scheduled", s: String(row.id) } });
  assert.match(after.body, new RegExp(`Scheduled\\. It goes ${schedule.whenText(ev, row.send_at).replace(/[()]/g, ".")}`));
  assert.ok(bubbles(after.body).includes(events.blastBody(ev, "bring a dish")), "it's in the waiting list as it will read");
  assert.equal(h.channel.sent.length, 0);
});

test("page: a past time is refused with a plain line; change and cancel take a confirm and do what they say", async () => {
  const h = harness();
  const ev = await party(h);
  const past = await post(h, ev, { action: "schedule", step: "preview", message: "hi", send_at: nyDay(-1, 10) });
  assert.equal(past.status, 200);
  assert.match(unesc(past.body), /That time has already passed/);
  const s = schedule.schedule({ ev, conversationId: OWNER_C, message: "first", sendAt: nyDay(3, 10) });
  const editPage = await req(h, ev, { cookie: COOKIE.owner, query: { edit: String(s.row.id) } });
  assert.match(editPage.body, /Changing the message set for/);
  assert.match(editPage.body, new RegExp(`value="${nyDay(3, 10)}"`));
  const changePrev = await post(h, ev, { action: "schedule", step: "preview", id: String(s.row.id), message: "second", send_at: nyDay(3, 12) });
  assert.match(changePrev.body, /Change this scheduled message\?/);
  assert.equal(db.scheduledRow(s.row.id).body, "first");
  await post(h, ev, { action: "schedule", step: "set", id: String(s.row.id), message: "second", send_at: nyDay(3, 12) });
  assert.deepEqual([db.scheduledRow(s.row.id).body, db.scheduledRow(s.row.id).send_at], ["second", ms(nyDay(3, 12))]);
  assert.equal(db.scheduledFor(ev.id, ["pending"]).length, 1, "changed in place, not a second one");
  const cancelPrev = await post(h, ev, { action: "sched_cancel", step: "review", id: String(s.row.id) });
  assert.match(cancelPrev.body, /Cancel this scheduled message\?/);
  assert.equal(db.scheduledRow(s.row.id).state, "pending");
  await post(h, ev, { action: "sched_cancel", step: "do", id: String(s.row.id) });
  assert.equal(db.scheduledRow(s.row.id).state, "cancelled");
  assert.equal(h.channel.sent.length, 0);
});

test("page: a reminder off is one tap; on shows when it goes and the text first", async () => {
  const h = harness();
  const ev = await party(h);
  assert.equal((await post(h, ev, { action: "reminder", which: "day_before", step: "do", enabled: "0" })).status, 303);
  assert.equal(db.getEventRow(ev.id).remind_day_before, 0);
  const review = await post(h, ev, { action: "reminder", which: "day_before", step: "review", enabled: "1" });
  assert.match(review.body, /Turn on the day-before reminder\?/);
  assert.deepEqual(bubbles(review.body), [schedule.reminderBody(ev, "day_before")]);
  assert.ok(review.body.includes(`It goes ${schedule.whenText(ev, schedule.reminderAt(ev, "day_before"))}`));
  assert.equal(db.getEventRow(ev.id).remind_day_before, 0, "still off until confirmed");
  await post(h, ev, { action: "reminder", which: "day_before", step: "do", enabled: "1" });
  assert.equal(db.getEventRow(ev.id).remind_day_before, 1);
});

test("page: nobody but the organizer can schedule, change, cancel or switch a reminder — the flat not-found", async () => {
  const h = harness();
  const ev = await party(h);
  make(KOFI_C, { name: "Kofi's Dinner", password: "jollof" });
  const s = schedule.schedule({ ev, conversationId: OWNER_C, message: "mine", sendAt: nyDay(3, 10) });
  const before = JSON.stringify([db.scheduledFor(ev.id), db.getEventRow(ev.id)]);
  const actions = [
    { action: "schedule", step: "set", message: "hijack", send_at: nyDay(3, 11) },
    { action: "schedule", step: "set", id: String(s.row.id), message: "hijack", send_at: nyDay(3, 11) },
    { action: "sched_cancel", step: "do", id: String(s.row.id) },
    { action: "reminder", which: "two_hours", step: "do", enabled: "0" },
  ];
  for (const fields of actions) {
    for (const [who, cookie] of [["signed out", ""], ["a guest", COOKIE.ama], ["another event's organizer", COOKIE.kofi]]) {
      const out = await post(h, ev, fields, cookie);
      assert.equal(out.status, 404, `${who} posting ${fields.action}`);
    }
  }
  assert.equal(JSON.stringify([db.scheduledFor(ev.id), db.getEventRow(ev.id)]), before);
  // And another event's waiting message can't be reached through this event's page.
  const kev = db.eventsOrganizedBy(KOFI_C)[0];
  const theirs = schedule.schedule({ ev: kev, conversationId: KOFI_C, message: "kofi's", sendAt: nyDay(3, 10) });
  await post(h, ev, { action: "sched_cancel", step: "do", id: String(theirs.row.id) });
  await post(h, ev, { action: "schedule", step: "set", id: String(theirs.row.id), message: "hijack", send_at: nyDay(3, 11) });
  assert.deepEqual([db.scheduledRow(theirs.row.id).state, db.scheduledRow(theirs.row.id).body], ["pending", "kofi's"]);
  const peek = await req(h, ev, { cookie: COOKIE.owner, query: { edit: String(theirs.row.id) } });
  assert.ok(!/kofi&#39;s|kofi's/.test(peek.body), "?edit= only opens this event's own messages");
});
