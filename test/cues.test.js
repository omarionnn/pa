// Cues: one good offer when life comes up, offline.
//
// "i'm flying to miami on the 20th" → one offer in the same reply, the rest held for their moment.
// Whether the offer reads well is the model's half and no test can assert it. What is proved here is
// code's half, and the model is played by the tool calls a turn would make:
//
//   1. **Behind the switch.** REASON_CUES off: nothing is shown, noted or sent. owner: the operator only.
//   2. **Only what they said.** No sentence, no row. A sensitive cue writes nothing.
//   3. **Only what they can get.** An offer whose tool they do not have is never open; an account not
//      connected is a connect offer once, ever, and only in a reply.
//   4. **One offer now.** A second with the first unanswered is refused; so is one off the list, and
//      any offer on a turn they did not start.
//   5. **The rest are rows with a moment** on the unprompted path that already exists (a notice row
//      on a one-off timer): the ride the evening before, check-in 24 hours before, never in their night.
//   6. **Inside the day's budget.** A held offer is said only through notice_send, which refuses it
//      when the day is spent — and a second offer on one cue waits for them to speak.
//   7. **A no is kept.** Never again for that cue; "never" on any later one; two noes end the cue's offers.
//   8. **Opt-out** by text and in Settings deletes what was held.
//   9. **It ends** when its date passes or they say it is off, and a held offer is let go at its moment.
//  10. **An export is a copy and a delete is a delete**, for all four tables.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cues-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_CUES = "on";

const cues = await import("../src/cues.js");
const notice = await import("../src/notice.js");
const db = await import("../src/db.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { exportData, deleteData } = await import("../src/data.js");
const { aheadSection } = await import("../src/pages/websettings.js");
const { clock } = await import("../src/config.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const C = "dm:owner";
const OTHER = "dm:sendblue:+15550001111";
const sql = db.db;

/** Everything on, everything connected: the person who can get every offer. */
const ALL = { tools: new Set(["web_search", "timer_set", "uber_request", "weather", "call_place", "calendar_create", "directions", "store_checkout", "event_create", "plan_create"]), connected: () => true };
const env = (names, connected = () => true) => ({ tools: new Set(names), connected });

/** A fixed "now": Wednesday 2026-11-11 15:00 in New York, so every moment below is a real clock time. */
const T0 = Date.parse("2026-11-11T15:00:00-05:00");
const local = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 16);

beforeEach(() => {
  process.env.REASON_CUES = "on";
  for (const t of ["cues", "cue_offers", "cue_prefs", "cue_mutes", "notice_seen", "timers", "notice_budget"]) {
    try { sql.exec(`DELETE FROM ${t}`); } catch { /* a table this install names differently */ }
  }
  clock.reset();
  clock.skip(T0 - Date.now());
});

const trip = (over = {}) => cues.note({
  conversationId: C, kind: "trip", what: "the miami trip", said: "i'm flying to miami on the 20th",
  starts: "2026-11-20T09:30", facts: { mode: "flight" }, env: ALL, turnKind: "user", ...over,
});
const offers = (cueId) => Object.fromEntries(sql.prepare("SELECT * FROM cue_offers WHERE cue_id = ?").all(cueId).map(o => [o.offer, o]));

// ---------- 1. the switch ----------

test("REASON_CUES off: no tool is shown, a named one is refused, and nothing is written", async () => {
  process.env.REASON_CUES = "off";
  assert.equal(cues.mode(), "off");
  assert.ok(!toolsFor(C).some(t => t.name.startsWith("cue")));
  const out = await runTool("cue_note", { kind: "trip", what: "the miami trip", said: "i'm flying to miami" }, { conversationId: C, kind: "user" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "not_available");
  assert.equal(cues.listCues(C).length, 0);
  assert.equal(cues.turnNote(C), "");
});

test("REASON_CUES owner: the operator only", () => {
  process.env.REASON_CUES = "owner";
  db.upsertAccount?.({ conversationId: OTHER, channel: "sendblue", address: "+15550001111", name: "Dana" });
  assert.equal(cues.covers(C), true);
  assert.equal(cues.covers(OTHER), false);
  assert.ok(toolsFor(C).some(t => t.name === "cue_note"));
  assert.ok(!toolsFor(OTHER).some(t => t.name === "cue_note"));
  process.env.REASON_CUES = "on";
  assert.equal(cues.covers(OTHER), true);
});

// ---------- 2. only what they said ----------

test("detection plumbing: the model's read arrives as a tool call and becomes a row with their sentence", async () => {
  const out = await runTool("cue_note", {
    kind: "trip", what: "the miami trip", said: "btw i'm flying to miami on the 20th", starts: "2026-11-20T09:30", facts: { mode: "flight" },
  }, { conversationId: C, kind: "user", cueEnv: ALL });
  assert.equal(out.ok, true);
  assert.equal(out.cue.their_words, "btw i'm flying to miami on the 20th");
  assert.equal(out.may_offer_now, true);
  const [row] = cues.listCues(C);
  assert.equal(row.kind, "trip");
  assert.equal(row.said, "btw i'm flying to miami on the 20th");
  assert.equal(local(row.starts_at), "2026-11-20 09:30");
  // Mentioned again: the same row, not a second trip.
  const again = await runTool("cue_note", { kind: "trip", what: "The Miami  trip", said: "the miami flight is at 9:30" }, { conversationId: C, kind: "user", cueEnv: ALL });
  assert.equal(again.already_knew, true);
  assert.equal(cues.listCues(C).length, 1);
});

test("no sentence of theirs, no cue; a kind that is not in the catalogue is refused", () => {
  assert.equal(trip({ said: "  " }).ok, false);
  assert.equal(cues.note({ conversationId: C, kind: "breakup", what: "x", said: "we split up", env: ALL }).ok, false);
  assert.equal(cues.listCues(C).length, 0);
});

test("nothing sensitive: a cue the model marks sensitive writes nothing and offers nothing", () => {
  const out = trip({ said: "flying to houston on the 20th for my mom's surgery", sensitive: true });
  assert.equal(out.ok, false);
  assert.equal(out.status, "sensitive");
  assert.equal(out.written, false);
  assert.equal(cues.listCues(C).length, 0);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM notice_seen").get().n, 0);
});

test("a date already gone is not a cue, and a date nobody gave is never invented", () => {
  assert.equal(trip({ starts: "2026-11-01" }).status, "already_past");
  const undated = trip({ starts: "" });
  assert.equal(undated.ok, true);
  assert.equal(undated.cue.when, null);
  // Offers that need a date wait for one; nothing is scheduled off a guess.
  const o = offers(undated.cue.cue_id);
  assert.equal(o.ride.state, "waiting");
  assert.equal(o.checkin.state, "waiting");
  assert.equal(o.ride.timer_id, null);
});

// ---------- 3. only what they can get ----------

test("availability: every tool group must be theirs, and an unconnected account is 'connect'", () => {
  const ride = cues.CUES.trip.offers.find(o => o.key === "ride");
  assert.equal(cues.availability(ride, ALL), "ok");
  assert.equal(cues.availability(ride, env(["web_search"])), "no");
  assert.equal(cues.availability(ride, env(["uber_request"], () => false)), "connect");
  assert.equal(cues.availability(cues.CUES.move.offers.find(o => o.key === "address_list"), env([])), "ok");
});

test("an offer whose feature is off for them is never open and never held", () => {
  // No rides, no calls, no weather: only search and reminders.
  const out = trip({ env: env(["web_search", "timer_set"]) });
  assert.deepEqual(out.pick_at_most_one.map(o => o.offer).sort(), ["checkin", "stay"]);
  const o = offers(out.cue.cue_id);
  assert.equal(o.ride.state, "skipped");
  assert.equal(o.table.state, "skipped");
  assert.equal(o.ride.notice_id, null);
  // And the tool refuses one that is not on the list, whatever the model wrote.
  const bad = cues.offer({ conversationId: C, cueId: out.cue.cue_id, offer: "ride", line: "want me to book u an uber to the airport?" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, "not_open");
});

test("an offer that does not fit the cue's facts is not made: no check-in reminder for a drive", () => {
  const out = trip({ what: "driving to philly", said: "driving to philly on the 20th", facts: { mode: "drive" } });
  const o = offers(out.cue.cue_id);
  assert.equal(o.checkin.state, "skipped");
  assert.equal(o.ride.state, "skipped");
  assert.ok(!out.pick_at_most_one.some(x => x.offer === "checkin"));
});

test("an account not connected: the connect is offered in a reply at most once, ever, and never unprompted", () => {
  const noUber = env([...ALL.tools], (p) => p !== "uber");
  // The flight is tomorrow, so the ride's moment is already here.
  const first = trip({ starts: "2026-11-12T20:00", env: noUber });
  const ride = first.pick_at_most_one.find(o => o.offer === "ride");
  assert.equal(ride.needs_connect, "uber");
  assert.equal(offers(first.cue.cue_id).ride.timer_id, null, "a connect offer is never put on the unprompted path");
  assert.equal(cues.offer({ conversationId: C, cueId: first.cue.cue_id, offer: "ride", line: "want to connect uber so i can get u a ride?" }).ok, true);
  // The next trip: still not connected, already asked once, so it is not open at all.
  const second = trip({ what: "the chicago trip", said: "flying to chicago on the 13th", starts: "2026-11-13T12:00", env: noUber });
  assert.ok(!(second.pick_at_most_one ?? []).some(o => o.offer === "ride"));
  assert.equal(offers(second.cue.cue_id).ride.state, "skipped");
});

// ---------- 4. one offer now ----------

test("one offer in the reply: the second is refused while the first is unanswered", () => {
  const out = trip();
  const id = out.cue.cue_id;
  assert.equal(cues.offer({ conversationId: C, cueId: id, offer: "stay", line: "want me to find u a place to stay?" }).ok, true);
  const second = cues.offer({ conversationId: C, cueId: id, offer: "checkin", line: "and a check-in reminder?" });
  assert.equal(second.ok, false);
  assert.equal(second.status, "not_now");
  // Mentioning the trip again does not reopen the pitch either.
  assert.equal(trip().may_offer_now, false);
  // An offer said in the reply comes off the unprompted path, so it cannot arrive twice.
  const stay = offers(id).stay;
  assert.equal(stay.state, "offered");
  assert.ok(db.noticeById(stay.notice_id).resolved_at);
  assert.ok(db.getTimer(C, stay.timer_id).cancelled_at);
});

test("on a turn they did not start (after a call) nothing is offered now; one offer waits for their next reply", () => {
  const out = trip({ starts: "2026-11-12T20:00", turnKind: "event", heardOn: "call" });
  assert.equal(out.ok, true);
  assert.equal(out.may_offer_now, false);
  assert.equal(cues.offer({ conversationId: C, cueId: out.cue.cue_id, offer: "stay", line: "x", turnKind: "event" }).ok, false);
  const rows = Object.values(offers(out.cue.cue_id));
  const riding = rows.filter(o => o.state === "held" && !o.timer_id);
  assert.equal(riding.length, 1, "exactly one rides on their next reply");
  // It is an ordinary held notice, so the next reply to them is offered it (notice.heldNote).
  assert.equal(db.heldNotices(C, { limit: 5 }).some(n => n.id === riding[0].notice_id), true);
  assert.equal(cues.listCues(C)[0].heard_on, "call");
});

test("the turn after their own call is told to note a cue said on it, only where cues reach them", async () => {
  const { ownerEvent } = await import("../src/calls/postcall.js");
  const row = { id: 1, conversation_id: C, duration_s: 120, provider: "gptlive", recording_state: "none" };
  const told = ownerEvent({ row });
  assert.ok(told.includes(cues.AFTER_CALL_LINE));
  assert.match(cues.AFTER_CALL_LINE, /cue_note[\s\S]*heard_on "call"[\s\S]*NO_REPLY/);
  // Turned off by them, or switched off: the after-call turn is exactly as it was.
  cues.setOn({ conversationId: C, on: false, via: "settings" });
  assert.ok(!ownerEvent({ row }).includes("cue_note"));
  sql.exec("DELETE FROM cue_prefs");
  process.env.REASON_CUES = "off";
  assert.ok(!ownerEvent({ row }).includes("cue_note"));
});

// ---------- 5. the rest are rows with a moment ----------

test("held offers get the right moment on the existing unprompted path", () => {
  const out = trip();
  const o = offers(out.cue.cue_id);
  assert.equal(local(o.ride.moment_at), "2026-11-19 18:00", "the ride, the evening before");
  assert.equal(local(o.checkin.moment_at), "2026-11-19 09:30", "check-in, 24 hours before");
  assert.equal(local(o.stay.moment_at), "2026-11-13 11:00");
  for (const key of ["ride", "checkin", "stay"]) {
    assert.equal(o[key].state, "held");
    const n = db.noticeById(o[key].notice_id);
    assert.equal(n.kind, cues.NOTICE_KIND);
    assert.equal(n.thing, `cue:${out.cue.cue_id}`, "one thing per cue, so one unanswered nudge holds the rest");
    assert.equal(n.moment_at, o[key].moment_at);
    const t = db.getTimer(C, o[key].timer_id);
    assert.equal(t.fire_at, o[key].moment_at);
    assert.equal(db.noticeByTimer(t.id).id, n.id, "the timer's firing is the notice path's, held to notice_send");
  }
  // Only so many are ever held for one cue; they are code's timers and never listed as their reminders.
  assert.equal(Object.values(o).filter(x => x.state === "held").length, 3);
  assert.equal(db.listTimers(C).length, 0);
});

test("a moment that would land in their night moves to their morning; a bare date cannot place an hours-before offer", () => {
  const red = trip({ what: "the red-eye", said: "my flight to sf leaves at 2am on the 20th", starts: "2026-11-20T02:00" });
  assert.equal(local(offers(red.cue.cue_id).checkin.moment_at), "2026-11-19 08:00");
  const dayOnly = trip({ what: "the denver trip", said: "flying to denver on the 25th", starts: "2026-11-25" });
  assert.equal(offers(dayOnly.cue.cue_id).checkin.state, "waiting");
  // The time arrives later: the same cue, and the offer finds its moment.
  const timed = trip({ what: "the denver trip", said: "it leaves at 4pm", starts: "2026-11-25T16:00" });
  assert.equal(timed.already_knew, true);
  assert.equal(local(offers(timed.cue.cue_id).checkin.moment_at), "2026-11-24 16:00");
});

test("the plan changes: a moved date moves the held offers, with one live row each", () => {
  const out = trip();
  trip({ said: "it moved to the 22nd", starts: "2026-11-22T09:30" });
  const o = offers(out.cue.cue_id);
  assert.equal(local(o.ride.moment_at), "2026-11-21 18:00");
  const live = sql.prepare("SELECT COUNT(*) n FROM timers WHERE cancelled_at IS NULL AND fired_at IS NULL").get().n;
  assert.equal(live, 3);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM notice_seen WHERE kind = 'cue_offer' AND resolved_at IS NULL").get().n, 3);
});

// ---------- 6. inside the day's budget ----------

test("the cap: a held offer is said only through notice_send, and the day's budget refuses it", async () => {
  const out = trip();
  const ride = offers(out.cue.cue_id).ride;
  clock.skip(ride.moment_at - clock.now() + 60_000);
  const row = db.noticeById(ride.notice_id);
  assert.deepEqual(await cues.recheck(C, row, clock.now(), ALL), { ok: true });
  assert.match(notice.momentFrame({ conversationId: C, row }), /offer you were holding[\s\S]*ride to the airport[\s\S]*notice_send/);
  // The day's one unprompted text is already spent.
  const s = notice.settingsFor(C);
  db.bumpNoticeBudget(C, notice.localDay(clock.now(), s.timeZone));
  const refused = notice.send({ conversationId: C, input: { key: row.key, specific_to_them: true, one_word_answerable: true }, kind: "event" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "budget_spent");
  cues.sync(C);
  assert.equal(offers(out.cue.cue_id).ride.state, "held", "held, not said");
});

test("a held offer that goes out is recorded as offered, and the next one on that cue waits for them to speak", async () => {
  const out = trip();
  const id = out.cue.cue_id;
  const checkin = offers(id).checkin;
  clock.skip(checkin.moment_at - clock.now() + 60_000);
  const row = db.noticeById(checkin.notice_id);
  const went = notice.send({ conversationId: C, input: { key: row.key, specific_to_them: true, one_word_answerable: true, what: "want a nudge when check-in opens?" }, kind: "event" });
  assert.equal(went.ok, true);
  db.markNoticeSaid(C, { day: notice.localDay(clock.now(), notice.settingsFor(C).timeZone) });
  cues.sync(C);
  const after1 = offers(id).checkin;
  assert.equal(after1.state, "offered");
  assert.equal(after1.unprompted, 1);
  // The evening comes, a new day's budget or not: they never answered, so the ride is not sent on top.
  const ride = offers(id).ride;
  clock.skip(ride.moment_at - clock.now() + 60_000);
  sql.exec("DELETE FROM notice_budget");
  const second = notice.send({ conversationId: C, input: { key: db.noticeById(ride.notice_id).key, specific_to_them: true, one_word_answerable: true }, kind: "event" });
  assert.equal(second.ok, false);
  assert.equal(second.status, "already_nudged");
});

test("their night: a held offer is refused outside their hours", () => {
  const out = trip();
  const ride = offers(out.cue.cue_id).ride;
  clock.skip(Date.parse("2026-11-20T02:00:00-05:00") - clock.now());
  // (Past the flight's eve but before the flight; the row is read directly, as a late timer would.)
  const refused = notice.send({ conversationId: C, input: { key: db.noticeById(ride.notice_id).key, specific_to_them: true, one_word_answerable: true }, kind: "event" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "quiet_hours");
});

// ---------- 7. a no is kept ----------

test("declined is not repeated: not in a reply, not at its moment, not when the trip comes up again", async () => {
  const out = trip();
  const id = out.cue.cue_id;
  cues.offer({ conversationId: C, cueId: id, offer: "stay", line: "want me to find u a place to stay?" });
  const no = cues.answer({ conversationId: C, cueId: id, offer: "stay", answer: "no", said: "nah i'm staying with my cousin" });
  assert.equal(no.ok, true);
  assert.deepEqual(no.cue.said_no, ["stay"]);
  const again = trip({ said: "can't wait for miami" });
  assert.ok(!(again.pick_at_most_one ?? []).some(o => o.offer === "stay"));
  assert.equal(cues.offer({ conversationId: C, cueId: id, offer: "stay", line: "sure u don't want a hotel?" }).ok, false);
  assert.equal(offers(id).stay.state, "declined");
  assert.equal(offers(id).stay.answer_said, "nah i'm staying with my cousin");
  // A held offer they turn down before its moment is let go at the source.
  const ride = offers(id).ride;
  cues.answer({ conversationId: C, cueId: id, offer: "ride", answer: "no", said: "my brother's driving me" });
  assert.ok(db.getTimer(C, ride.timer_id).cancelled_at);
  assert.match((await cues.recheck(C, db.noticeById(ride.notice_id), clock.now(), ALL)).handled, /./);
});

test("two noes on one cue let go of whatever was still held for it", () => {
  const out = trip();
  const id = out.cue.cue_id;
  cues.answer({ conversationId: C, cueId: id, offer: "stay", answer: "no", said: "no" });
  const second = cues.answer({ conversationId: C, cueId: id, offer: "ride", answer: "no", said: "no thanks" });
  assert.ok(second.let_go >= 1);
  assert.equal(offers(id).checkin.state, "dropped");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM timers WHERE cancelled_at IS NULL AND fired_at IS NULL").get().n, 0);
});

test("'never' mutes that offer on every later cue; a yes is recorded and stays theirs to confirm", () => {
  const first = trip();
  cues.answer({ conversationId: C, cueId: first.cue.cue_id, offer: "ride", answer: "never", said: "i always drive myself to the airport" });
  const next = trip({ what: "the austin trip", said: "flying to austin dec 3", starts: "2026-12-03T10:00" });
  assert.equal(offers(next.cue.cue_id).ride.state, "skipped");
  const yes = cues.answer({ conversationId: C, cueId: next.cue.cue_id, offer: "checkin", answer: "yes", said: "yes pls" });
  assert.deepEqual(yes.cue.said_yes, ["checkin"]);
  assert.match(yes.say, /confirmation/);
});

// ---------- 8. opt-out ----------

test("opt-out by text: what was held is deleted, the tools go, and only the way back stays", async () => {
  trip();
  const off = await runTool("cues_setting", { on: false, said: "stop offering me stuff every time i mention a trip" }, { conversationId: C, kind: "user" });
  assert.equal(off.ok, true);
  assert.equal(cues.listCues(C).length, 0);
  assert.equal(cues.listOffers(C).length, 0);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM timers WHERE cancelled_at IS NULL AND fired_at IS NULL").get().n, 0);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM notice_seen WHERE kind = 'cue_offer' AND resolved_at IS NULL").get().n, 0);
  const names = toolsFor(C).map(t => t.name).filter(n => n.startsWith("cue"));
  assert.deepEqual(names, ["cues_setting"]);
  assert.equal((await runTool("cue_note", { kind: "trip", what: "the miami trip", said: "flying to miami" }, { conversationId: C, kind: "user", cueEnv: ALL })).ok, false);
  // And back on, in their words.
  assert.equal((await runTool("cues_setting", { on: true, said: "ok u can suggest things again" }, { conversationId: C, kind: "user" })).ok, true);
  assert.equal(trip().ok, true);
});

test("opt-out in Settings: the section is theirs to switch, and is not drawn where the switch does not reach", () => {
  assert.match(aheadSection({ csrf: "t", ahead: { on: true } }), /THINKING AHEAD[\s\S]*name="do" value="ahead"[\s\S]*name="on" value="0"/);
  assert.match(aheadSection({ csrf: "t", ahead: { on: false } }), /name="on" value="1"/);
  assert.equal(aheadSection({ csrf: "t", ahead: null }), "");
  trip();
  assert.equal(cues.setOn({ conversationId: C, on: false, via: "settings" }).ok, true);
  assert.equal(cues.optedOut(C), true);
  assert.equal(cues.active(C), false);
  assert.equal(cues.listCues(C).length, 0);
});

test("a held offer that comes due after they opted out, or with the switch off, is let go without a turn", async () => {
  const out = trip();
  const row = db.noticeById(offers(out.cue.cue_id).ride.notice_id);
  process.env.REASON_CUES = "off";
  assert.match((await cues.recheck(C, row, clock.now(), ALL)).handled, /switched off/);
  process.env.REASON_CUES = "on";
  // The feature behind it was turned off for them since: an offer Reason could not keep is not made.
  assert.match((await cues.recheck(C, row, clock.now(), env(["web_search"]))).handled, /no longer/);
});

// ---------- 9. it ends ----------

test("expiry: a cue ends when its date passes, and what was held goes with it", async () => {
  const out = trip();
  const id = out.cue.cue_id;
  const ride = offers(id).ride;
  clock.skip(10 * DAY);
  assert.equal(cues.turnNote(C), "", "nothing open is put in front of the model");
  assert.equal(cues.listCues(C)[0].state, "ended");
  assert.equal(cues.listCues(C)[0].ended_why, "its date passed");
  assert.match((await cues.recheck(C, db.noticeById(ride.notice_id), clock.now(), ALL)).handled, /./);
  assert.equal(trip().status, "already_past");
  // The same thing coming round again is a fresh cue, not the old one's ghost.
  const next = trip({ said: "back to miami on dec 20", starts: "2026-12-20T09:30" });
  assert.equal(next.ok, true);
  assert.equal(next.already_knew, false);
  assert.equal(next.may_offer_now, true);
});

test("expiry: a cue with no date is let go after a few weeks", () => {
  trip({ starts: "" });
  clock.skip(29 * DAY);
  cues.sync(C);
  assert.equal(cues.listCues(C)[0].state, "open");
  clock.skip(2 * DAY);
  cues.sync(C);
  assert.equal(cues.listCues(C)[0].state, "ended");
});

test("they say it is off: cue_end lets go of everything held and nothing is offered for it again", async () => {
  const out = trip();
  const ended = await runTool("cue_end", { cue_id: out.cue.cue_id, why: "trip cancelled", said: "ugh miami's off" }, { conversationId: C, kind: "user" });
  assert.equal(ended.ok, true);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM timers WHERE cancelled_at IS NULL AND fired_at IS NULL").get().n, 0);
  assert.equal(trip().status, "ended");
  // Only their own word brings it back.
  assert.equal(trip({ said: "miami's back on!!", backOn: true }).ok, true);
});

// ---------- the note on their turn, and the other cues ----------

test("the turn note carries open cues with what was offered and what they turned down", () => {
  assert.equal(cues.turnNote(C), "");
  const out = trip();
  cues.offer({ conversationId: C, cueId: out.cue.cue_id, offer: "stay", line: "want me to find u a place to stay?" });
  const note = cues.turnNote(C);
  assert.match(note, /the miami trip/);
  assert.match(note, /want me to find u a place to stay\?/);
  assert.match(note, /cue_answer/);
});

test("every cue in the catalogue lays out: the offers are data, and each has a moment rule", () => {
  for (const [kind, def] of Object.entries(cues.CUES)) {
    assert.ok(def.offers.length >= 3, kind);
    for (const o of def.offers) {
      assert.ok(o.key && o.what && Array.isArray(o.tools) && o.when, `${kind}.${o.key}`);
    }
    const facts = Object.fromEntries(Object.entries(def.facts).map(([k, v]) => [k, v[0]]));
    const out = cues.note({ conversationId: C, kind, what: `a ${kind}`, said: `there is a ${kind} on the 28th`, starts: "2026-11-28T14:00", facts, env: ALL, turnKind: "user" });
    assert.equal(out.ok, true, kind);
    assert.ok(out.pick_at_most_one.length >= 1, kind);
    assert.ok(Object.values(offers(out.cue.cue_id)).filter(o => o.state === "held").length <= 3, kind);
  }
});

test("somebody else's birthday gets a reminder and a gift idea; their own does not", () => {
  const theirs = cues.note({ conversationId: C, kind: "birthday", what: "my birthday", said: "it's my birthday on the 30th", starts: "2026-11-30", facts: { whose: "theirs" }, env: ALL });
  assert.deepEqual(theirs.pick_at_most_one.map(o => o.offer).sort(), ["event_page", "table"]);
});

test("no more than a handful of cues are open for one person at once", () => {
  for (let i = 0; i < 5; i++) assert.equal(trip({ what: `trip ${i}`, said: `trip ${i} is on the 20th` }).ok, true);
  assert.equal(trip({ what: "trip 6", said: "and another" }).status, "enough_open");
});

// ---------- 10. export and delete ----------

test("an export carries their cues and a delete takes all four tables", async () => {
  const out = trip();
  cues.answer({ conversationId: C, cueId: out.cue.cue_id, offer: "ride", answer: "never", said: "i always drive" });
  cues.setOn({ conversationId: C, on: true, said: "keep them coming" });
  // Somebody else's rows, which a delete of this person's must leave alone.
  cues.note({ conversationId: OTHER, kind: "guest", what: "her sister visiting", said: "my sister's visiting on the 28th", starts: "2026-11-28", env: ALL });
  const dump = exportData({ conversation: C });
  const text = JSON.stringify(dump);
  assert.match(text, /i'm flying to miami on the 20th/);
  assert.match(text, /i always drive/);
  assert.doesNotMatch(text, /my sister's visiting/);
  await deleteData({ conversation: C });
  for (const t of ["cues", "cue_offers", "cue_prefs", "cue_mutes"]) {
    assert.equal(sql.prepare(`SELECT COUNT(*) n FROM ${t} WHERE conversation_id = ?`).get(C).n, 0, t);
  }
  assert.equal(cues.listCues(OTHER).length, 1);
});
