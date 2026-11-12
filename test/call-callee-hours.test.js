// The 9pm-8am rule on calls to other people runs on the CALLEE's clock (2026-11-11): the place's own zone
// when a lookup gave its location, else the number's area code, else the account holder's zone. Until
// then it was the server's Eastern clock for everyone, so a California office could be rung at 5:30am.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-callee-hours-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
delete process.env.REASON_CALL_QUIET_HOURS;

const brief = await import("../src/calls/brief.js");
const zone = await import("../src/zone.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const WEST = "sendblue:+14155550001"; // an account holder in California (by their own number)
const EAST = "sendblue:+12125550002";
const SF = "+14155550123";
const NYC = "+12125550123";
const TOLL_FREE = "+18005551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM threads; DELETE FROM accounts;");
  db.saveConversation(WEST, []);
  db.saveConversation(EAST, []);
  db.upsertAccount({ conversationId: WEST, channel: "sendblue", address: "+14155550001", name: "Ama", isOperator: false });
  db.upsertAccount({ conversationId: EAST, channel: "sendblue", address: "+12125550002", name: "Kofi", isOperator: false });
});

const at = (iso) => Date.parse(iso);
const ok = (now, number, conv = EAST) => {
  const z = zone.calleeZone(number, conv);
  return brief.withinCallingHours({ now, tz: z.zones ?? z.zone, whose: z.source });
};

test("whose clock: the number's area code; a toll-free number falls back to the account holder's zone, never just the server's", () => {
  assert.deepEqual(zone.calleeZone(SF, EAST), { zone: "America/Los_Angeles", source: "number" });
  assert.deepEqual(zone.calleeZone(NYC, WEST), { zone: "America/New_York", source: "number" });
  assert.deepEqual(zone.calleeZone("(415) 555-0123", EAST), { zone: "America/Los_Angeles", source: "number" });
  assert.deepEqual(zone.calleeZone("+442071234567", EAST), { zone: "Europe/London", source: "number" });
  // No area code to read: the account holder's own zone (here from their number), not the install's Eastern.
  assert.equal(config.installTz, "America/New_York");
  assert.deepEqual(zone.calleeZone(TOLL_FREE, WEST), { zone: "America/Los_Angeles", source: "account" });
  assert.deepEqual(zone.calleeZone(TOLL_FREE, EAST), { zone: "America/New_York", source: "account" });
  // A zone they confirmed wins over their number.
  db.setZoneFields(WEST, { confirmed: "America/Denver", confirmedAt: 1 });
  assert.deepEqual(zone.calleeZone(TOLL_FREE, WEST), { zone: "America/Denver", source: "account" });
});

test("a California number at 8:30am Eastern must not ring (5:30am there); a New York number may", () => {
  const now = at("2026-11-12T08:30:00-05:00");
  const ca = ok(now, SF);
  assert.equal(ca.ok, false);
  assert.match(ca.error, /05:30/);
  assert.match(ca.error, /America\/Los_Angeles/);
  assert.match(ca.error, /Nobody's phone rang/);
  assert.equal(ok(now, NYC).ok, true);
  // 11:00 ET is 8:00 PT: the window opens.
  assert.equal(ok(at("2026-11-12T10:59:00-05:00"), SF).ok, false);
  assert.equal(ok(at("2026-11-12T11:00:00-05:00"), SF).ok, true);
});

test("the evening edge is the callee's too: 9:30pm Eastern still rings California (6:30pm), and midnight Eastern does not (9pm)", () => {
  assert.equal(ok(at("2026-11-12T21:30:00-05:00"), SF).ok, true);
  assert.equal(ok(at("2026-11-12T21:30:00-05:00"), NYC).ok, false);
  assert.equal(ok(at("2026-11-12T23:59:00-05:00"), SF).ok, true, "8:59pm Pacific");
  assert.equal(ok(at("2026-11-13T00:00:00-05:00"), SF).ok, false, "9:00pm Pacific");
  // A West-coast account ringing New York at 6:30pm Pacific: it is 9:30pm there.
  assert.equal(ok(at("2026-11-12T18:30:00-08:00"), NYC, WEST).ok, false);
});

test("DST edges: the callee's wall clock decides on the days the clocks change, and in a place that never changes them", () => {
  // Spring forward, 2026-03-08: 2am PST becomes 3am PDT. 14:59 UTC = 7:59 PDT (held), 15:00 UTC = 8:00 PDT (rings).
  assert.equal(ok(at("2026-03-08T14:59:00Z"), SF).ok, false);
  assert.equal(ok(at("2026-03-08T15:00:00Z"), SF).ok, true);
  // The day before, still PST: 15:00 UTC = 7:00 (held), 16:00 UTC = 8:00.
  assert.equal(ok(at("2026-03-07T15:00:00Z"), SF).ok, false);
  assert.equal(ok(at("2026-03-07T16:00:00Z"), SF).ok, true);
  // Fall back, 2026-11-01: 2am PDT becomes 1am PST. 15:59 UTC = 7:59 PST (held), 16:00 UTC = 8:00 PST.
  assert.equal(ok(at("2026-11-01T15:00:00Z"), SF).ok, false, "8am PDT no longer exists that morning: it is 7am PST");
  assert.equal(ok(at("2026-11-01T16:00:00Z"), SF).ok, true);
  // Evening of the change: 9pm PST is 05:00 UTC the next day (was 04:00 UTC the night before).
  assert.equal(ok(at("2026-11-01T04:00:00Z"), SF).ok, false, "Oct 31, 9:00pm PDT");
  assert.equal(ok(at("2026-11-02T04:00:00Z"), SF).ok, true, "Nov 1, 8:00pm PST");
  assert.equal(ok(at("2026-11-02T05:00:00Z"), SF).ok, false, "Nov 1, 9:00pm PST");
  // Eastern on its own spring-forward morning: 11:59 UTC = 7:59 EDT, 12:00 UTC = 8:00 EDT.
  assert.equal(ok(at("2026-03-08T11:59:00Z"), NYC).ok, false);
  assert.equal(ok(at("2026-03-08T12:00:00Z"), NYC).ok, true);
  // Arizona keeps one clock all year (UTC-7): 8am there is 15:00 UTC in July and in January.
  assert.equal(zone.calleeZone("+16025551234", EAST).zone, "America/Phoenix");
  for (const day of ["2026-07-15", "2026-01-15"]) {
    assert.equal(ok(at(`${day}T14:59:00Z`), "+16025551234").ok, false);
    assert.equal(ok(at(`${day}T15:00:00Z`), "+16025551234").ok, true);
  }
});

test("a place a lookup returned is timed by where it IS, whatever its number's area code says", () => {
  // A Honolulu shop with a 212 number.
  assert.equal(zone.notePlace({ phone: "+1 212-555-0177", latitude: 21.3069, longitude: -157.8583 }), "Pacific/Honolulu");
  assert.deepEqual(zone.calleeZone("+12125550177", EAST), { zone: "Pacific/Honolulu", source: "place" });
  // 1pm Eastern (EST) is 8am in Honolulu; 12:59 is 7:59.
  assert.equal(ok(at("2026-11-12T12:59:00-05:00"), "+12125550177").ok, false);
  assert.equal(ok(at("2026-11-12T13:00:00-05:00"), "+12125550177").ok, true);
  assert.equal(zone.notePlace({ phone: "+12125550178" }), "", "no location: nothing kept");
  assert.equal(zone.calleeZone("+12125550178", EAST).source, "number");
});

test("an area code that covers two clocks: held while it is night on either", () => {
  const idaho = zone.calleeZone("+12085551234", EAST);
  assert.equal(idaho.source, "number");
  assert.ok(idaho.zones.includes("America/Boise") && idaho.zones.includes("America/Los_Angeles"));
  // 8:30am Mountain is 7:30am Pacific: north Idaho is still asleep.
  assert.equal(ok(at("2026-11-12T08:30:00-07:00"), "+12085551234").ok, false);
  assert.equal(ok(at("2026-11-12T09:00:00-07:00"), "+12085551234").ok, true);
});
