// Spec v3 §13, pinned (§15 test 15): rides between an event's guests. Off, nobody is asked. On: the
// day-before ask goes once (never to a muted guest, never in the night); a driver and a rider from
// the same area are suggested one match at a time, best fit first; neither sees more than a first
// name and a general area before both agree; nothing is set until both say yes; a cancellation tells
// the other side at once; the organizer sees counts only; no suggestion goes out while the time or
// place is hidden; addresses are refused; a reported pair is never suggested again.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-rides-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_EVENT_RIDES = "on";

const events = await import("../src/events.js");
const rides = await import("../src/eventrides.js");
const db = await import("../src/db.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { atLocal } = await import("../src/series.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const P = { ama: "+13475550000", yaw: "+16465550111", kofi: "+14155559876", esi: "+17185550123", kwame: "+19175550144" };
const C = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, `dm:fake:${v}`]));
const TZ = "America/New_York";

// Where areas are, without the network. Fort Greene ↔ Clinton Hill ≈ 0.9 km; Astoria ≈ 10 km away.
const PLACES = {
  "fort greene": { lat: 40.6895, lng: -73.9760 }, "clinton hill": { lat: 40.6897, lng: -73.9655 },
  "astoria": { lat: 40.7644, lng: -73.9235 }, "12 dekalb ave": { lat: 40.69, lng: -73.97, address: true },
};
rides._setGeocoder(async (q) => PLACES[String(q).toLowerCase()] ?? null);

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  config.eventRides = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM ride_offers; DELETE FROM ride_matches;
    DELETE FROM ride_asks; DELETE FROM ride_blocks; DELETE FROM conversations;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  for (const [k, v] of Object.entries(P)) db.upsertAccount({ conversationId: C[k], channel: "fake", address: v, name: k[0].toUpperCase() + k.slice(1) });
});

function fakeRuntime() {
  const sent = [];
  return {
    sent,
    to: (c) => sent.filter(s => s.conversationId === c).map(s => s.text),
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

// Today in New York, read ONCE. Every date below is counted from it in calendar days. It used to be
// `Date.now() + days * 24h`, read again at every call: in the hour after midnight before the clocks
// go back, "two days from now" and "one day from now" were the same date (a 25-hour day), so the
// "too early" sweep was really the day before and asked everybody; and a run that crossed midnight
// had DAY on one calendar and the later dates on the next.
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
/** A local wall-clock date `days` from today in New York, as YYYY-MM-DD. */
function dayFromNow(days) {
  const [y, m, d] = TODAY.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
/** Move the clock to this local wall-clock moment. */
function goTo(isoLocal) {
  const [date, time] = isoLocal.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  clock.reset();
  clock.skip(atLocal({ year, month, day, hour, minute }, TZ) - Date.now());
}

const DAY = dayFromNow(3);
function party({ rides: on = true, ...over } = {}) {
  const out = events.create(OWNER_C, {
    name: "Halloween Party", description: "costumes", starts_at: `${DAY}T21:00`, location: "88 Party Pl",
    password: "pumpkin", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, ...over,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  if (on) db.updateEventRow(out.event.id, { rides_enabled: 1 });
  return db.getEventRow(out.event.id);
}
const join_ = async (who, extra = {}) => (await events.joinExisting({ conversationId: C[who], name: "Halloween Party", password: "pumpkin", ...extra })).attendee;
const ride = (who, input, rt) => runTool("event_ride", input, { conversationId: C[who], messages: [], events: rt });

test("with rides off, nobody is asked, nothing is matched, and the guest isn't shown the ride tool", async () => {
  const rt = fakeRuntime();
  const ev = party({ rides: false });
  await join_("ama");
  goTo(`${dayFromNow(2)}T12:00`);
  const out = await rides.sweep({ runtime: rt });
  assert.equal(out.asked ?? 0, 0);
  assert.equal(rt.sent.length, 0);
  assert.ok(!toolsFor(C.ama).some(t => t.name === "event_ride"));
  const r = await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:15`, seats: 2 }, rt);
  assert.equal(r.ok, false);
  // And REASON_EVENT_RIDES off: not even an organizer can turn it on.
  config.eventRides = false;
  assert.ok(!toolsFor(OWNER_C).some(t => t.name === "event_rides_setting"));
});

test("the day-before ask: once, to each unmuted guest, in the daytime; a guest who joins on the day is asked right after", async () => {
  const rt = fakeRuntime();
  const ev = party();
  await join_("ama"); await join_("yaw");
  const kofi = await join_("kofi");
  db.updateAttendeeRow(kofi.id, { muted: 1 });
  // Two days before: too early.
  goTo(`${dayFromNow(1)}T12:00`);
  assert.equal((await rides.sweep({ runtime: rt })).asked, 0);
  // The day before, at night: quiet hours.
  goTo(`${dayFromNow(2)}T22:30`);
  assert.equal((await rides.sweep({ runtime: rt })).asked, 0);
  // The day before, midday: Ama and Yaw, once each; Kofi muted.
  goTo(`${dayFromNow(2)}T12:00`);
  assert.equal((await rides.sweep({ runtime: rt })).asked, 2);
  assert.equal((await rides.sweep({ runtime: rt })).asked, 0, "never twice");
  assert.equal(rt.to(C.ama).length, 1);
  assert.match(rt.to(C.ama)[0], /Halloween Party tomorrow — are you driving and happy to offer a seat, or looking for a ride\?/);
  assert.equal(rt.to(C.kofi).length, 0, "muted guests are never asked");
  // Esi joins on the day: asked on the next pass.
  goTo(`${DAY}T13:00`);
  await join_("esi");
  assert.equal((await rides.sweep({ runtime: rt })).asked, 1);
  assert.match(rt.to(C.esi)[0], /Halloween Party today —/);
  // The organizer is never asked.
  assert.equal(rt.to(OWNER_C).length, 0);
});

test("a driver and a rider from the same area: one suggestion, first name and area only; nothing set until both say yes", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama", { inDirectory: true, instagram: "ama.k" });
  await join_("yaw");
  db.updateAttendeeRow(db.attendeeRow(ev.id, C.ama).id, { display_name: "Ama Mensah" });
  const drv = await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:15`, seats: 2 }, rt);
  assert.equal(drv.ok, true, JSON.stringify(drv));
  assert.equal(rt.sent.length, 0, "nobody to match yet");
  const rdr = await ride("yaw", { event_id: ev.id, action: "need", area: "Clinton Hill", leave_at: `${DAY}T20:30` }, rt);
  assert.equal(rdr.ok, true);
  assert.equal(rdr.note, "A match was just suggested to them as its own text; don't repeat it.");
  const toAma = rt.to(C.ama).at(-1), toYaw = rt.to(C.yaw).at(-1);
  assert.match(toAma, /Yaw needs a ride there from around Clinton Hill, leaving about 8:30/);
  assert.match(toYaw, /Ama \(@ama\.k on instagram\) is driving from around Fort Greene/);
  for (const t of [toAma, toYaw]) {
    assert.ok(!/Mensah|\+1\d{10}|3475550000|6465550111/.test(t), `first name and area only: ${t}`);
    assert.match(t, /^Halloween Party —/, "says which event");
  }
  // Yaw hasn't put his Instagram on the directory: Ama doesn't get it.
  assert.ok(!/instagram/.test(toAma));
  // One says yes: not set.
  const y1 = await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  assert.equal(y1.state, "waiting_on_other");
  assert.equal(db.rideMatchesFor(ev.id, ["agreed"]).length, 0);
  // Both: agreed, plan to both, and the how-to-coordinate question.
  const y2 = await ride("yaw", { event_id: ev.id, action: "answer", yes: true }, rt);
  assert.equal(y2.state, "agreed");
  assert.match(rt.to(C.yaw).at(-1), /you're set: Ama is giving you a ride, pickup around Clinton Hill, between 8:15 PM and 8:45 PM/);
  assert.match(rt.to(C.ama).at(-1), /through me — i'll pass messages along — or should i introduce you directly/);
  // Numbers only once BOTH say intro.
  await ride("ama", { event_id: ev.id, action: "coordinate", mode: "intro" }, rt);
  assert.ok(!rt.sent.some(s => /6465550111|3475550000/.test(s.text)), "one yes shares nothing");
  const intro = await ride("yaw", { event_id: ev.id, action: "coordinate", mode: "intro" }, rt);
  assert.equal(intro.introduced, true);
  assert.match(rt.to(C.ama).at(-1), /Yaw is \+16465550111/);
  assert.match(rt.to(C.yaw).at(-1), /Ama is \+13475550000/);
  // Messages pass along.
  await ride("yaw", { event_id: ev.id, action: "message", message: "running 5 late" }, rt);
  assert.match(rt.to(C.ama).at(-1), /from Yaw, about your ride: running 5 late/);
});

test("one suggestion at a time, best fit first; a far-away driver is never suggested; a no moves on to the next", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  for (const w of ["ama", "kofi", "esi", "yaw"]) await join_(w);
  await ride("kofi", { event_id: ev.id, action: "offer", area: "Astoria", leave_at: `${DAY}T20:30`, seats: 3 }, rt);
  await ride("esi", { event_id: ev.id, action: "offer", area: "Clinton Hill", leave_at: `${DAY}T20:00`, seats: 1 }, rt);
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  // Yaw is in Fort Greene: Ama (0 km) before Esi (0.9 km); Kofi in Astoria never.
  const toYaw = rt.to(C.yaw);
  assert.equal(toYaw.length, 1, "one suggestion, never a list");
  assert.match(toYaw[0], /Ama is driving from around Fort Greene/);
  assert.equal(rt.to(C.esi).length, 0);
  // Yaw says no: that pair is spent, and the next best (Esi) is suggested.
  await ride("yaw", { event_id: ev.id, action: "answer", yes: false }, rt);
  assert.match(rt.to(C.ama).at(-1), /that ride pairing didn't work out/);
  assert.match(rt.to(C.yaw).at(-1), /Esi is driving from around Clinton Hill/);
  assert.ok(!rt.to(C.kofi).some(t => /ride match/.test(t)), "Astoria is not the same general area");
  // Sweeping again suggests nothing new while Yaw has one in front of him, and never Ama again.
  await rides.sweep({ runtime: rt });
  assert.equal(rt.to(C.yaw).filter(t => /ride match/.test(t)).length, 2);
});

test("a cancellation tells the other side right away and puts them back in line; a change does too", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); await join_("yaw"); await join_("esi");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("yaw", { event_id: ev.id, action: "answer", yes: true }, rt);
  assert.deepEqual(events.organizerView(db.getEventRow(ev.id)).rides, { matched: 2, still_looking: 0 });
  // Ama drops out: Yaw told at once, back to looking.
  await ride("ama", { event_id: ev.id, action: "cancel" }, rt);
  assert.match(rt.to(C.yaw).at(-1), /Ama can't do the ride you'd sorted anymore\. i'll keep looking/);
  assert.equal(db.liveRideOffer(ev.id, C.yaw).status, "open");
  // Esi offers: Yaw gets a new suggestion.
  await ride("esi", { event_id: ev.id, action: "offer", area: "Clinton Hill", leave_at: `${DAY}T20:15`, seats: 1 }, rt);
  assert.match(rt.to(C.yaw).at(-1), /Esi is driving/);
  // Esi changes her time while it's pending: Yaw told, and (still fitting) suggested again only once a new pair is made.
  await ride("esi", { event_id: ev.id, action: "offer", area: "Astoria", leave_at: `${DAY}T20:15`, seats: 1 }, rt);
  assert.match(rt.to(C.yaw).at(-1), /Esi can't do the ride i suggested anymore/);
});

test("the organizer sees counts only, never who rides with whom", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  for (const w of ["ama", "yaw", "esi", "kwame"]) await join_(w);
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  await ride("esi", { event_id: ev.id, action: "need", area: "Astoria", leave_at: `${DAY}T20:30` }, rt);
  await ride("kwame", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:40` }, rt);
  await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("yaw", { event_id: ev.id, action: "answer", yes: true }, rt);
  const out = await runTool("event_rides_setting", { event_id: ev.id }, { conversationId: OWNER_C, messages: [], events: rt });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.counts, { matched: 2, still_looking: 2 });
  assert.ok(!/Ama|Yaw|Esi|Kwame|Fort Greene|Astoria/.test(JSON.stringify(out)), "no names, no areas");
  const view = await runTool("event_info", { event_id: ev.id }, { conversationId: OWNER_C, messages: [], events: rt });
  assert.deepEqual(view.rides, { matched: 2, still_looking: 2 });
  const guests = await runTool("event_guests", { event_id: ev.id }, { conversationId: OWNER_C, messages: [], events: rt });
  assert.ok(!/ride|Fort Greene/.test(JSON.stringify(guests)));
  // The organizer turns it on and off; a guest can't.
  assert.equal((await runTool("event_rides_setting", { event_id: ev.id, enabled: false }, { conversationId: C.ama, messages: [], events: rt })).ok, false);
});

test("no suggestion while the place or time is hidden — interest is held, and matched once the organizer releases", async () => {
  const rt = fakeRuntime();
  const ev = party({ show_location_on_join: false });
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); await join_("yaw");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  const r = await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  assert.equal(r.held, true);
  await rides.sweep({ runtime: rt });
  assert.ok(!rt.sent.some(s => /ride match/.test(s.text)), "held");
  assert.ok(!rt.sent.some(s => /88 Party/.test(s.text)), "the hidden address never appears");
  await runTool("event_release", { event_id: ev.id, detail: "location" }, { conversationId: OWNER_C, messages: [], events: rt });
  await rides.sweep({ runtime: rt });
  assert.ok(rt.to(C.yaw).some(t => /ride match/.test(t)));
  assert.ok(!rt.sent.filter(s => /ride match/.test(s.text)).some(s => /88 Party/.test(s.text)), "a match never carries the event's address");
});

test("intake: a street address is refused (neighborhoods only); a muted guest's offer is saved but they're told matches can't reach them", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama");
  const addr = await ride("ama", { event_id: ev.id, action: "offer", area: "12 Dekalb Ave", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  assert.equal(addr.reason, "address");
  assert.equal(db.liveRideOffer(ev.id, C.ama), null);
  db.updateAttendeeRow(db.attendeeRow(ev.id, C.ama).id, { muted: 1 });
  const muted = await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  assert.equal(muted.ok, true);
  assert.match(muted.muted, /muted/);
});

test("report a problem: never paired again, the other side hears only that the ride is off, the organizer only if asked", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); await join_("yaw");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  const rep = await ride("yaw", { event_id: ev.id, action: "report" }, rt);
  assert.equal(rep.ok, true);
  assert.equal(rep.organizer_told, false);
  assert.ok(!rt.to(OWNER_C).length, "organizer not told unless asked");
  assert.ok(!/report/i.test(rt.to(C.ama).at(-1)), "Ama isn't told it was a report");
  // Even after changing details, never suggested to each other again.
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:20`, seats: 2 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:25` }, rt);
  assert.equal(db.rideMatchesFor(ev.id, ["pending"]).length, 0);
  // With tell_organizer: the organizer hears it.
  await join_("esi");
  await ride("esi", { event_id: ev.id, action: "offer", area: "Clinton Hill", leave_at: `${DAY}T20:25`, seats: 1 }, rt);
  // Yaw has been paired with two people now: a report has to say which.
  const vague = await ride("yaw", { event_id: ev.id, action: "report", tell_organizer: true }, rt);
  assert.equal(vague.reason, "which_person");
  assert.deepEqual(vague.names.sort(), ["Ama", "Esi"]);
  const rep2 = await ride("yaw", { event_id: ev.id, action: "report", about: "Esi", tell_organizer: true }, rt);
  assert.equal(rep2.organizer_told, true);
  assert.match(rt.to(OWNER_C).at(-1), /a guest reported a problem with a ride pairing: Yaw about Esi/);
});

test("the day-of reminder goes once to each side of an agreed ride, a few hours before; leaving releases the other side", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); const yaw = await join_("yaw"); await join_("esi");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 2 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("yaw", { event_id: ev.id, action: "answer", yes: true }, rt);
  goTo(`${DAY}T17:00`);
  assert.equal((await rides.sweep({ runtime: rt })).reminded, 0, "not yet");
  goTo(`${DAY}T18:30`);
  assert.equal((await rides.sweep({ runtime: rt })).reminded, 1);
  assert.equal((await rides.sweep({ runtime: rt })).reminded, 0, "once");
  assert.match(rt.to(C.ama).at(-1), /Halloween Party today — reminder: you're giving Yaw a ride, pickup around Fort Greene/);
  // Yaw leaves the event: Ama is told, and the offer is let go on the next pass.
  db.leaveAttendee(yaw.id);
  await rides.sweep({ runtime: rt });
  assert.match(rt.to(C.ama).at(-1), /Yaw can't do the ride you'd sorted anymore/);
  assert.equal(db.liveRideOffer(ev.id, C.yaw), null);
});

test("the rides note: what was asked, the suggestion waiting on them, the agreed plan — for the model, turn-only", async () => {
  const rt = fakeRuntime();
  const ev = party();
  await join_("ama"); await join_("yaw");
  goTo(`${dayFromNow(2)}T12:00`);
  await rides.sweep({ runtime: rt });
  assert.match(rides.ridesNote(C.ama), /you asked them whether they're driving/);
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  assert.match(rides.ridesNote(C.yaw), /you suggested pairing them with Ama \(Fort Greene\) and are waiting on their yes or no/);
  assert.equal(rides.ridesNote(OWNER_C), "", "the organizer has no rides note");
  config.eventRides = false;
  assert.equal(rides.ridesNote(C.yaw), "", "nothing at all with rides off");
});


// ---------- the review's cases (PR #129) ----------

test("no day-before ask while the time is hidden ('tomorrow' would give the date away); it goes once the time is out", async () => {
  const rt = fakeRuntime();
  const ev = party({ show_time_on_join: false });
  await join_("ama");
  goTo(`${dayFromNow(2)}T12:00`);
  assert.equal((await rides.sweep({ runtime: rt })).asked, 0);
  assert.equal(rt.sent.length, 0);
  db.updateEventRow(ev.id, { time_released: 1 });
  assert.equal((await rides.sweep({ runtime: rt })).asked, 1);
});

test("a driver with two riders reports one: only that pairing ends, the other rider is untouched, and the driver's freed seat is offered again", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  for (const w of ["ama", "yaw", "esi", "kwame"]) await join_(w);
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 2 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("yaw", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("esi", { event_id: ev.id, action: "need", area: "Clinton Hill", leave_at: `${DAY}T20:30` }, rt);
  await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("esi", { event_id: ev.id, action: "answer", yes: true }, rt);
  assert.equal(db.liveRideOffer(ev.id, C.ama).status, "matched", "full");
  const before = rt.to(C.esi).length;
  assert.equal((await ride("ama", { event_id: ev.id, action: "report" }, rt)).reason, "which_person");
  const r = await ride("ama", { event_id: ev.id, action: "report", about: "Yaw" }, rt);
  assert.equal(r.ok, true);
  assert.equal(rt.to(C.esi).length, before, "Esi hears nothing — her ride stands");
  assert.equal(db.rideMatchesFor(ev.id, ["agreed"]).length, 1);
  assert.match(rt.to(C.yaw).at(-1), /Ama can't do the ride you'd sorted anymore/);
  assert.equal(db.liveRideOffer(ev.id, C.ama).status, "open", "a seat is free again");
  await ride("kwame", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:35` }, rt);
  assert.match(rt.to(C.kwame).at(-1), /Ama is driving/, "the freed seat is matched");
  // …and never Yaw again.
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:31` }, rt);
  assert.ok(!db.rideMatchesFor(ev.id, ["pending"]).some(m => db.rideOffer(m.rider_offer_id).conversation_id === C.yaw));
});

test("after a no, the same two people are never suggested again — even with new offers", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); await join_("yaw");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  await ride("yaw", { event_id: ev.id, action: "answer", yes: false }, rt);
  await ride("yaw", { event_id: ev.id, action: "cancel" }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:35` }, rt);
  await rides.sweep({ runtime: rt });
  assert.equal(db.rideMatchesFor(ev.id, ["pending"]).length, 0);
});

test("an edit that still fits keeps the agreed ride and tells the other side what changed; one that doesn't ends it", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); await join_("yaw");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:15`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:15` }, rt);
  await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("yaw", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  assert.equal(db.rideMatchesFor(ev.id, ["agreed"]).length, 1, "still on");
  assert.match(rt.to(C.ama).at(-1), /Yaw changed their ride details; you're still on\. now: pickup around Fort Greene, between 8:15 PM and 8:45 PM/);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Astoria", leave_at: `${DAY}T20:30` }, rt);
  assert.equal(db.rideMatchesFor(ev.id, ["agreed"]).length, 0);
  assert.match(rt.to(C.ama).at(-1), /Yaw can't do the ride you'd sorted anymore/);
});

test("nothing unprompted at night: a late offer waits for the morning; a lapsed suggestion is said, by day, to both", async () => {
  const rt = fakeRuntime();
  const ev = party();
  await join_("ama"); await join_("yaw");
  goTo(`${dayFromNow(1)}T23:30`);
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  const late = await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  assert.match(late.note, /night/);
  assert.equal(rt.sent.length, 0, "nobody texted at 23:30");
  goTo(`${dayFromNow(2)}T02:00`);
  await rides.sweep({ runtime: rt });
  assert.equal(rt.sent.length, 0, "nor at 2am");
  goTo(`${dayFromNow(2)}T09:30`);
  await rides.sweep({ runtime: rt });
  assert.ok(rt.to(C.yaw).some(t => /ride match/.test(t)), "suggested in the morning");
  // Nobody answers for 12 hours: by then it's night — lapses the next morning, both told.
  goTo(`${dayFromNow(2)}T22:00`);
  await rides.sweep({ runtime: rt });
  assert.equal(db.rideMatchesFor(ev.id, ["pending"]).length, 1, "not ended in the night");
  goTo(`${DAY}T09:15`);
  await rides.sweep({ runtime: rt });
  assert.match(rt.to(C.ama).find(t => /lapsed/.test(t)) ?? "", /that ride suggestion lapsed/);
  assert.match(rt.to(C.yaw).find(t => /lapsed/.test(t)) ?? "", /that ride suggestion lapsed/);
  assert.equal(rt.sent.filter(s => /ride match/.test(s.text)).length, 2, "the lapsed pair is not suggested again");
});

test("leaving the event ends the ride at once — the partner is told without waiting for a sweep", async () => {
  const rt = fakeRuntime();
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); await join_("yaw");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  await ride("ama", { event_id: ev.id, action: "answer", yes: true }, rt);
  await ride("yaw", { event_id: ev.id, action: "answer", yes: true }, rt);
  await runTool("event_leave", { event_id: ev.id }, { conversationId: C.ama, messages: [], events: rt });
  assert.match(rt.to(C.yaw).at(-1), /Ama can't do the ride you'd sorted anymore/);
  assert.equal(db.liveRideOffer(ev.id, C.ama), null);
});

test("the thread: a ride text goes into the receiver's thread queued behind their turns, never into the actor's own (their turn records it), never twice", async () => {
  const rt = fakeRuntime();
  const queued = [];
  rt.enqueue = (c, fn) => { queued.push(c); return Promise.resolve().then(fn); };
  const ev = party();
  goTo(`${dayFromNow(2)}T12:00`);
  await join_("ama"); await join_("yaw");
  await ride("ama", { event_id: ev.id, action: "offer", area: "Fort Greene", leave_at: `${DAY}T20:30`, seats: 1 }, rt);
  await ride("yaw", { event_id: ev.id, action: "need", area: "Fort Greene", leave_at: `${DAY}T20:30` }, rt);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(queued, [C.ama], "Ama's thread gets the match, through her queue; Yaw's turn records his own");
  const amaThread = db.loadConversation(C.ama);
  assert.equal(amaThread.at(-1).role, "assistant");
  assert.match(amaThread.at(-1).content, /ride match: Yaw/);
  assert.match(amaThread.at(-2).content, /nothing from them — Reason texted them on its own/);
  assert.equal(db.loadConversation(C.yaw).length, 0);
});

test("with REASON_EVENT_RIDES off, the organizer's view carries no ride counts", async () => {
  const ev = party();
  assert.ok(events.organizerView(db.getEventRow(ev.id)).rides);
  config.eventRides = false;
  assert.equal(events.organizerView(db.getEventRow(ev.id)).rides, undefined);
});

// The two sweep failure lines once logged the first line of the error message, which can be what a
// guest typed (an address, a name). Only the error's class, a word-shaped code and the length go out.
test("a failed event sweep logs the error's class, code and length — never its message", async () => {
  const ev = party();
  const lines = [];
  const secret = "pick me up at 12 Dekalb Ave, Ama's phone 347 555 0000";
  const now = { [Symbol.toPrimitive]() { throw Object.assign(new TypeError(secret + "\nsecond line"), { code: "E_RIDE" }); } };
  const out = await rides.sweep({ runtime: fakeRuntime(), now, log: (l) => lines.push(l) });
  assert.equal(out.failed, 1);
  assert.deepEqual(lines, [{ event_rides_event_failed: ev.id, error: "TypeError", code: "E_RIDE", message_length: secret.length + 12 }]);
  assert.ok(!JSON.stringify(lines).includes("Dekalb"));
});

test("the runtime's sweep wrapper logs the shape only, and a code that isn't word-shaped is dropped", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const lines = [];
  const was = Object.getOwnPropertyDescriptor(config, "eventRides");
  Object.defineProperty(config, "eventRides", { configurable: true, get() { throw Object.assign(new Error("12 Dekalb Ave"), { code: "no such place 12 Dekalb" }); } });
  try {
    const out = await Runtime.prototype.eventRides.call({ log: (l) => lines.push(l) }, {});
    assert.deepEqual(out, { failed: true });
  } finally { Object.defineProperty(config, "eventRides", was); }
  assert.deepEqual(lines, [{ event_rides_failed: true, error: "Error", code: null, message_length: 13 }]);
  assert.ok(!JSON.stringify(lines).includes("Dekalb"));
});
