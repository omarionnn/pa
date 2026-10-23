// A commute "leave by" is a saved place, a home and a clock. Nothing in it is read from Google, so a
// person who has never connected Google still gets one (2026-10-23: the gather returned at the Google
// token check first, and commutes were below it). And the arrive-by time is THEIR wall clock, wherever
// this process runs — the live server is on UTC.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-commute-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const notice = await import("../src/notice.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM saved_places; DELETE FROM accounts;");
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
});

// Friday 2026-10-23, 7:00 AM in New York (EDT, UTC-4) = 11:00 UTC.
const SEVEN_AM_NY = Date.parse("2026-10-23T11:00:00Z");

function savedCommute({ arriveBy = 9 * 60, days = "MTWTF..", travelMinutes = 35 } = {}) {
  db.savePlace(C, { name: "home", address: "350 5th Ave, New York", lat: 40.7484, lng: -73.9857 });
  db.savePlace(C, { name: "work", address: "1 Wall St, New York", lat: 40.7074, lng: -74.0113, mode: "transit", travelMinutes, arriveBy, days });
}

test("no Google connected: the gather still carries today's commute", async () => {
  savedCommute();
  const bundle = await notice.gather({ conversationId: C, now: SEVEN_AM_NY });
  assert.equal(bundle.ok, true, "a bundle with a commute in it is something to look at, not 'not connected'");
  const commute = bundle.candidates.find(c => c.key.startsWith("commute:work@"));
  assert.ok(commute, "the commute is a candidate without any Google account");
  assert.equal(commute.kind, "calendar_leave_by");
  assert.match(commute.what, /leave by 8:10 AM to get to work by 9:00 AM/);
});

test("the arrive-by is their wall clock: 9:00 AM New York is 13:00 UTC, not 09:00 UTC", async () => {
  savedCommute();
  const [c] = await notice.commuteCandidates({ conversationId: C, now: SEVEN_AM_NY, timeZone: "America/New_York" });
  // 9:00 AM EDT minus 35 min transit minus the 15 min buffer = 8:10 AM EDT = 12:10 UTC.
  assert.equal(c.starts, "2026-10-23T12:10:00.000Z");
});

test("not today, already past, or no home: no candidate", async () => {
  savedCommute({ days: ".....SS" });
  assert.deepEqual(await notice.commuteCandidates({ conversationId: C, now: SEVEN_AM_NY, timeZone: "America/New_York" }), []);

  savedCommute({ arriveBy: 7 * 60 + 30 }); // 7:30 arrival, leave-by 6:40 — already gone at 7:00
  assert.deepEqual(await notice.commuteCandidates({ conversationId: C, now: SEVEN_AM_NY, timeZone: "America/New_York" }), []);

  db.db.exec("DELETE FROM saved_places");
  db.savePlace(C, { name: "work", address: "1 Wall St", lat: 40.7074, lng: -74.0113, mode: "transit", travelMinutes: 35, arriveBy: 540, days: "MTWTF.." });
  const none = await notice.commuteCandidates({ conversationId: C, now: SEVEN_AM_NY, timeZone: "America/New_York" });
  // No saved home: only the install default could stand in, and this test install has none.
  assert.deepEqual(none, []);
});
