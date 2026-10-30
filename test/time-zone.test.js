// Per-person time zone (src/zone.js, src/zonescope.js). Until 2026-10-30 every reminder ran on the
// install's zone (Eastern) for everybody. Now, before the first clock-time action for somebody whose
// zone is not confirmed, Reason holds the action, asks once with its best guess and why, and their
// answer finishes it. No model, no network.
//
//   a 312 number → guessed Central "because a 312 area code"; +44 → London; an email address → no phone guess
//   the guess order: confirmed > Web browser > shared location > calendar > phone > the install's zone
//   "remind me at 9 tomorrow" → held, nothing set, the guess handed back; their yes → set at 9 THEIR time
//   they say no, Denver → 9 Mountain, the action still done, never asked to repeat it
//   "remind me in 10 minutes" → set at once, nothing held, nobody asked
//   confirmed already, or the switch off → no question at all (the old behaviour)
//   a held action from yesterday is not done on a late answer
//   DST: 9am the Monday after the clocks change carries the winter offset; 2:30 on the spring night rolls forward
//   travel: a shared location on another clock is asked about once per zone, never applied
//   stamps inside their turn are on their clock; outside, the install's, unchanged
//   the Web poll's browser zone is kept as a guess; the operator starts confirmed
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-tz-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_TZ_ASK = "on";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const zone = await import("../src/zone.js");
const zonescope = await import("../src/zonescope.js");
const { config, clock, stamp } = await import("../src/config.js");
const { signalRequest } = await import("../src/pages/webnotify.js");

const CONV = "dm:friend";
const FRIEND = "+13125550123"; // a Chicago area code
const DAY = 86_400_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.tzAsk = true;
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM threads; DELETE FROM notice_sweeps;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: FRIEND, name: "Ama" });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: FRIEND, isOwner: false, service: "iMessage" });
});

/** "The day after tomorrow at 09:00" as a bare wall clock, so the test never goes stale. */
function wallInTwoDays(tz, hhmm = "09:00") {
  const d = new Date(Date.now() + 2 * DAY).toLocaleDateString("en-CA", { timeZone: tz });
  return `${d}T${hhmm}:00`;
}
const ctx = () => ({ conversationId: CONV });

test("phone guess: a 312 number is Central, +44 is London, +233 is Accra, an email is no guess", () => {
  assert.deepEqual(zone.zoneFromPhone("+13125550123"), { zone: "America/Chicago", areaCode: "312", countryPrefix: "1" });
  assert.equal(zone.zoneFromPhone("+12125550123").zone, "America/New_York");
  assert.equal(zone.zoneFromPhone("+14155550123").zone, "America/Los_Angeles");
  assert.equal(zone.zoneFromPhone("+447700900123").zone, "Europe/London");
  assert.equal(zone.zoneFromPhone("+447700900123").countryPrefix, "44");
  assert.equal(zone.zoneFromPhone("+233241234567").zone, "Africa/Accra");
  assert.equal(zone.zoneFromPhone("ama@example.com"), null);
  assert.equal(zone.zoneFromPhone(""), null);
});

test("guess order: confirmed > browser > location > calendar > phone > the install's zone", () => {
  const g = () => zone.guessZone(CONV);
  assert.equal(g().zone, "America/Chicago");
  assert.equal(g().signal, "phone");
  assert.match(g().because, /312 area code/);
  db.noticeSweep(CONV);
  db.markNoticeSwept(CONV, { timeZone: "America/Denver" });
  assert.equal(g().signal, "calendar");
  assert.equal(g().zone, "America/Denver");
  db.setZoneFields(CONV, { place: "America/Phoenix" });
  assert.equal(g().signal, "location");
  db.setZoneFields(CONV, { web: "America/Los_Angeles" });
  assert.equal(g().signal, "web");
  assert.equal(g().zone, "America/Los_Angeles");
  db.setZoneFields(CONV, { confirmed: "Europe/London" });
  assert.equal(g().signal, "confirmed");
  // Nothing at all: the install's zone, and it says so.
  db.db.exec("UPDATE accounts SET address = 'ama@example.com', notice_tz = NULL, web_tz = NULL, place_tz = NULL; DELETE FROM notice_sweeps; UPDATE threads SET address = 'ama@example.com';");
  assert.equal(g().zone, "America/New_York");
  assert.equal(g().signal, "default");
});

test("'remind me at 9' with no confirmed zone: held, nothing set, the guess and its reason handed back", async () => {
  const wall = wallInTwoDays("America/Chicago");
  const out = await runTool("timer_set", { fire_at: `${wall}-04:00`, note: "call the landlord" }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.status, "confirm_time_zone");
  assert.equal(out.guess.zone, "America/Chicago");
  assert.equal(out.guess.name, "Central time");
  assert.match(out.guess.because, /312 area code/);
  assert.match(out.error, /do NOT call timer_set again/);
  assert.equal(db.listTimers(CONV).length, 0);
  assert.equal(db.zoneRow(CONV).pending.tool, "timer_set");
});

test("their yes finishes the held reminder at 9 THEIR time, without being asked again", async () => {
  const wall = wallInTwoDays("America/Chicago");
  await runTool("timer_set", { fire_at: `${wall}-04:00`, note: "call the landlord" }, ctx());
  const out = await runTool("time_zone", { zone: "America/Chicago", their_words: "yep" }, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.held_action, "timer_set");
  assert.equal(out.done.ok, true);
  const timers = db.listTimers(CONV);
  assert.equal(timers.length, 1);
  assert.equal(new Date(timers[0].fire_at).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }), "9:00 AM");
  assert.equal(db.zoneRow(CONV).pending, null);
  assert.equal(zone.confirmedZone(CONV), "America/Chicago");
  // The next one is not held.
  const again = await runTool("timer_set", { fire_at: `${wall.replace("09:00", "10:00")}-05:00`, note: "gym" }, ctx());
  assert.equal(again.ok, true);
});

test("they say no, they're in Denver: 9 Mountain, and the reminder is still done", async () => {
  const wall = wallInTwoDays("America/Denver");
  await runTool("timer_set", { fire_at: `${wall}-04:00`, note: "dentist" }, ctx());
  const out = await runTool("time_zone", { zone: "America/Denver", their_words: "no, I'm in Denver" }, ctx());
  assert.equal(out.done.ok, true);
  const [t] = db.listTimers(CONV);
  assert.equal(new Date(t.fire_at).toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" }), "9:00 AM");
});

test("'remind me in 10 minutes' needs no zone: set at once, nothing held", async () => {
  const at = new Date(Date.now() + 10 * 60_000).toISOString();
  const out = await runTool("timer_set", { fire_at: at, note: "take the pasta off", relative: true }, ctx());
  assert.equal(out.ok, true);
  assert.equal(db.listTimers(CONV).length, 1);
  assert.equal(db.zoneRow(CONV).pending, null);
});

test("a standing series asks too (its hour is an hour of their day)", async () => {
  const out = await runTool("timer_set", { note: "how the job search is going", repeat: { kind: "weekly", hour: 9, weekdays: ["monday"] } }, ctx());
  assert.equal(out.status, "confirm_time_zone");
});

test("confirmed already, or the switch off: no question, the old behaviour", async () => {
  const wall = wallInTwoDays("America/New_York");
  config.tzAsk = false;
  const off = await runTool("timer_set", { fire_at: `${wall}-04:00`, note: "a" }, ctx());
  assert.equal(off.ok, true);
  config.tzAsk = true;
  db.setZoneFields(CONV, { confirmed: "America/New_York" });
  const on = await runTool("timer_set", { fire_at: `${wall.replace("09:00", "11:00")}-05:00`, note: "b" }, ctx());
  assert.equal(on.ok, true);
});

test("a held action older than the window is not done on a late answer", async () => {
  const wall = wallInTwoDays("America/Chicago");
  await runTool("timer_set", { fire_at: `${wall}-04:00`, note: "late" }, ctx());
  clock.skip(zone.PENDING_TTL_MS + 60_000);
  const out = await runTool("time_zone", { zone: "America/Chicago", their_words: "yes" }, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.done, undefined);
  assert.equal(db.listTimers(CONV).length, 0);
});

test("a zone that is not a zone is refused and nothing is saved", async () => {
  const out = await runTool("time_zone", { zone: "EST", their_words: "est" }, ctx());
  assert.equal(out.ok, false);
  assert.equal(zone.confirmedZone(CONV), "");
});

test("DST: 9am the Monday after the clocks go back carries the winter offset; a spring-forward 2:30 rolls forward", () => {
  // Held on Fri Oct 30 (CDT, -05:00) for Mon Nov 2 (CST, -06:00).
  const r = zone.rewriteForZone("timer_set", { fire_at: "2026-11-02T09:00:00-04:00", note: "x" }, "America/Chicago");
  assert.equal(r.fire_at, "2026-11-02T09:00:00-06:00");
  // The fall-back hour happens twice: the first one.
  assert.equal(new Date(zone.wallToInstant("2026-11-01T01:30", "America/New_York")).toISOString(), "2026-11-01T05:30:00.000Z");
  // 2:30 on the spring-forward night never happens: 3:30 EDT, never 1:30.
  assert.equal(new Date(zone.wallToInstant("2027-03-14T02:30", "America/New_York")).toISOString(), "2027-03-14T07:30:00.000Z");
  // London and New York change on different weekends.
  assert.equal(zone.isoIn(zone.wallToInstant("2026-10-26T09:00", "Europe/London"), "Europe/London"), "2026-10-26T09:00:00+00:00");
  // Calendar times keep the wall clock and lose the guessed offset; the calendar is told the zone.
  assert.equal(zone.rewriteForZone("calendar_create", { start: "2026-11-02T15:00:00-04:00", end: "2026-11-02T16:00:00" }, "America/Chicago").start, "2026-11-02T15:00:00");
  assert.equal(zone.rewriteForZone("commitment_set", { at: "07:00" }, "America/Chicago").time_zone, "America/Chicago");
});

test("travel: a shared location on another clock is asked about once, and nothing changes", () => {
  db.setZoneFields(CONV, { confirmed: "America/New_York" });
  assert.equal(zone.sawLocation(CONV, 40.71, -74.0), null, "home: nothing to ask");
  const chi = zone.sawLocation(CONV, 41.88, -87.63);
  assert.equal(chi.now_in, "America/Chicago");
  assert.match(chi.note, /Ask them ONCE/);
  assert.equal(zone.confirmedZone(CONV), "America/New_York", "never applied silently");
  assert.equal(zone.sawLocation(CONV, 41.88, -87.63), null, "asked once for this zone");
  assert.equal(zone.sawLocation(CONV, 42.33, -83.05), null, "Detroit keeps New York's clock");
  assert.equal(zone.sawLocation(CONV, 34.05, -118.24).now_in, "America/Los_Angeles", "a new zone is a new question");
});

test("stamps: inside their turn on their clock with its name; outside, the install's, exactly as before", () => {
  const at = Date.UTC(2026, 9, 30, 15, 0);
  const before = stamp(at);
  assert.equal(before, "Fri, Oct 30, 2026, 11:00 AM");
  db.setZoneFields(CONV, { confirmed: "America/Chicago" });
  const theirs = zonescope.runFor(CONV, () => stamp(at));
  assert.equal(theirs, "Fri, Oct 30, 2026, 10:00 AM CDT");
  assert.equal(zonescope.runFor(CONV, () => config.tz), "America/Chicago");
  assert.equal(stamp(at), before);
  assert.equal(config.tz, "America/New_York");
  // Unconfirmed: their turn is still on the install's zone.
  db.setZoneFields(CONV, { confirmed: "" });
  assert.equal(zonescope.runFor(CONV, () => stamp(at)), before);
});

test("the Web poll keeps the browser's zone as a guess, never as their answer", async () => {
  // Straight through the helper the poll calls (the poll needs a signed-in cookie).
  assert.equal(zone.sawBrowserZone(CONV, "America/Los_Angeles"), true);
  assert.equal(zone.sawBrowserZone(CONV, "not a zone"), false);
  assert.equal(db.zoneRow(CONV).web, "America/Los_Angeles");
  assert.equal(zone.confirmedZone(CONV), "");
  const r = await signalRequest({ method: "GET", headers: { "x-reason-tz": "Europe/London" } });
  assert.equal(r.status, 401, "no cookie, nothing kept");
  assert.equal(db.zoneRow(CONV).web, "America/Los_Angeles");
});

test("the operator starts confirmed on the install's zone; nobody else is touched", () => {
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  assert.equal(zone.preconfirmOperator(), 1);
  assert.equal(zone.confirmedZone("dm:owner"), "America/New_York");
  assert.equal(zone.confirmedZone(CONV), "");
  assert.equal(zone.preconfirmOperator(), 0, "once");
});
