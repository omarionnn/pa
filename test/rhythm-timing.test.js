// Rhythm timing: rhythmHours, rhythmMoment, momentFor with rhythms, momentWithReason.
// The part that moves a non-urgent nudge into a rhythm window — and the three refusals that
// make it safe to have on at all.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-rtime-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const notice = await import("../src/notice.js");
const { clock } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = "America/New_York";

after(() => rmSync(dir, { recursive: true, force: true }));

// ---------- rhythmHours ----------

test("rhythmHours extracts hour range from evidence", () => {
  const row = { evidence: [{ hour: 20 }, { hour: 22 }, { hour: 21 }] };
  const h = notice.rhythmHours(row);
  assert.ok(h);
  assert.equal(h.from, 20);
  assert.equal(h.to, 22);
  assert.equal(h.points, 3);
});

test("rhythmHours returns null with too few points", () => {
  assert.equal(notice.rhythmHours({ evidence: [{ hour: 20 }] }), null);
  assert.equal(notice.rhythmHours({ evidence: [] }), null);
  assert.equal(notice.rhythmHours({}), null);
  assert.equal(notice.rhythmHours(null), null);
});

test("rhythmHours ignores invalid hours", () => {
  const row = { evidence: [{ hour: 20 }, { hour: "bad" }, { hour: 22 }] };
  const h = notice.rhythmHours(row);
  assert.ok(h);
  assert.equal(h.from, 20);
  assert.equal(h.to, 22);
});

// ---------- rhythmMoment ----------

test("rhythmMoment returns the original time when already inside the window", () => {
  const at = Date.parse("2026-10-15T21:00:00-04:00"); // 9pm, inside 20-22
  const rhythm = { evidence: [{ hour: 20 }, { hour: 22 }, { hour: 21 }], use: "hold non-urgent things" };
  const got = notice.rhythmMoment(at, { timeZone: TZ, rhythms: [rhythm] });
  assert.equal(got.at, at);
  assert.equal(got.why, "");
});

test("rhythmMoment shifts a morning time into an evening window", () => {
  const at = Date.parse("2026-10-15T10:00:00-04:00"); // 10am
  const rhythm = { evidence: [{ hour: 20 }, { hour: 22 }, { hour: 21 }], use: "hold till evening" };
  const got = notice.rhythmMoment(at, { timeZone: TZ, rhythms: [rhythm] });
  assert.ok(got.at > at, "moved forward");
  const shifted = new Date(got.at);
  const h = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(shifted));
  assert.ok(h >= 20, `shifted to ${h}:00 which is inside the evening window`);
  assert.equal(got.why, "hold till evening");
});

test("rhythmMoment never moves into quiet hours", () => {
  const at = Date.parse("2026-10-15T10:00:00-04:00");
  const rhythm = { evidence: [{ hour: 23 }, { hour: 23 }, { hour: 23 }], use: "late night" };
  const got = notice.rhythmMoment(at, {
    timeZone: TZ, rhythms: [rhythm],
    quietStart: 22, quietEnd: 8,
  });
  // The rhythm window (23:00) is entirely within quiet hours (22-08), so it should not be used
  assert.equal(got.at, at, "did not move — rhythm is entirely in quiet hours");
});

test("rhythmMoment does not move backward or more than a day out", () => {
  const at = Date.parse("2026-10-15T22:00:00-04:00"); // 10pm
  const rhythm = { evidence: [{ hour: 8 }, { hour: 10 }, { hour: 9 }], use: "morning person" };
  const got = notice.rhythmMoment(at, { timeZone: TZ, rhythms: [rhythm] });
  assert.ok(got.at >= at, "never moved backward");
  assert.ok(got.at <= at + DAY, "never more than a day out");
});

test("rhythmMoment with no rhythms returns as-is", () => {
  const at = Date.parse("2026-10-15T10:00:00-04:00");
  const got = notice.rhythmMoment(at, { timeZone: TZ, rhythms: [] });
  assert.equal(got.at, at);
  assert.equal(got.why, "");
});

test("rhythmMoment with no timezone returns as-is", () => {
  const at = Date.parse("2026-10-15T10:00:00-04:00");
  const rhythm = { evidence: [{ hour: 20 }, { hour: 22 }, { hour: 21 }], use: "hold" };
  const got = notice.rhythmMoment(at, { timeZone: "", rhythms: [rhythm] });
  assert.equal(got.at, at);
});

// ---------- momentFor with rhythms ----------

test("momentFor shifts a timeless candidate into rhythm window", () => {
  const now = Date.parse("2026-10-15T10:00:00-04:00");
  const candidate = { kind: "mail_unread", what: "a bill" }; // no starts time
  const rhythm = { evidence: [{ hour: 20 }, { hour: 22 }, { hour: 21 }], use: "hold" };
  const at = notice.momentFor(candidate, now, { timeZone: TZ, rhythms: [rhythm] });
  assert.ok(at >= now, "never backward");
  const h = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(new Date(at)));
  assert.ok(h >= 20, `shifted to ${h}:00`);
});

test("momentFor does not shift a candidate with its own time", () => {
  const now = Date.parse("2026-10-15T10:00:00-04:00");
  const future = new Date(now + 3 * HOUR).toISOString();
  const candidate = { kind: "calendar_moved", what: "a meeting", starts: future };
  const rhythm = { evidence: [{ hour: 20 }, { hour: 22 }, { hour: 21 }], use: "hold" };
  const at = notice.momentFor(candidate, now, { timeZone: TZ, rhythms: [rhythm] });
  // With a starts time, momentFor uses its own lead-time logic, not rhythms
  assert.ok(at <= now + 3 * HOUR, "respects the event's own timing");
});

// ---------- momentWithReason ----------

test("momentWithReason includes the rhythm's use as the reason", () => {
  const now = Date.parse("2026-10-15T10:00:00-04:00");
  const candidate = { kind: "mail_unread", what: "a bill" };
  const rhythm = { evidence: [{ hour: 20 }, { hour: 22 }, { hour: 21 }], use: "hold non-urgent things till the evening" };
  const got = notice.momentWithReason(candidate, now, { timeZone: TZ, rhythms: [rhythm] });
  assert.ok(got.at >= now);
  assert.equal(got.why, "hold non-urgent things till the evening");
});

test("momentWithReason returns empty why for timed candidates", () => {
  const now = Date.parse("2026-10-15T10:00:00-04:00");
  const future = new Date(now + 3 * HOUR).toISOString();
  const candidate = { kind: "calendar_moved", what: "a meeting", starts: future };
  const got = notice.momentWithReason(candidate, now, { timeZone: TZ, rhythms: [] });
  assert.equal(got.why, "");
});
