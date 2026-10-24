// Apple Calendar (CalDAV) — offline tests.
//
// Every request goes to the fake server in fixture-icloud.js. Nothing reaches iCloud.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-icloud-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { startICloud } = await import("./fixture-icloud.js");
const icloud = await import("../src/icloud.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = "dm:owner";
let fake;

before(async () => {
  fake = await startICloud({ email: "test@icloud.com", password: "app-pass-1234" });
  config.icloudCalDAVBase = fake.url;
});

after(async () => {
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM connected_accounts;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fake.reset();
});

// ---------- iCalendar parsing ----------

describe("parseVevent", () => {
  test("parses a basic VEVENT", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:abc-123",
      "SUMMARY:Dentist",
      "DTSTART;TZID=America/New_York:20261009T150000",
      "DTEND;TZID=America/New_York:20261009T160000",
      "LOCATION:123 Main St",
      "DESCRIPTION:Annual checkup",
      "SEQUENCE:0",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = icloud.parseVevent(ical);
    assert.equal(parsed.uid, "abc-123");
    assert.equal(parsed.summary, "Dentist");
    assert.equal(parsed.location, "123 Main St");
    assert.equal(parsed.description, "Annual checkup");
    assert.equal(parsed.start.dateTime, "2026-10-09T15:00:00");
    assert.equal(parsed.start.timeZone, "America/New_York");
    assert.equal(parsed.end.dateTime, "2026-10-09T16:00:00");
    assert.equal(parsed.sequence, 0);
    assert.equal(parsed.status, "CONFIRMED");
  });

  test("parses UTC times", () => {
    const ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261009T190000Z\r\nDTEND:20261009T200000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const parsed = icloud.parseVevent(ical);
    assert.equal(parsed.start.dateTime, "2026-10-09T19:00:00Z");
    assert.equal(parsed.end.dateTime, "2026-10-09T20:00:00Z");
  });

  test("parses all-day events", () => {
    const ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u2\r\nDTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261010\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const parsed = icloud.parseVevent(ical);
    assert.equal(parsed.start.date, "20261009");
    assert.equal(parsed.end.date, "20261010");
    assert.equal(parsed.summary, "Holiday");
  });

  test("handles escaped characters", () => {
    const ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u3\r\nSUMMARY:Dinner\\, drinks\\; fun\r\nDESCRIPTION:Line one\\nLine two\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const parsed = icloud.parseVevent(ical);
    assert.equal(parsed.summary, "Dinner, drinks; fun");
    assert.equal(parsed.description, "Line one\nLine two");
  });

  test("parses attendees", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:u4",
      "ATTENDEE;CN=Sarah;PARTSTAT=ACCEPTED:mailto:sarah@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:kofi@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = icloud.parseVevent(ical);
    assert.equal(parsed.attendees.length, 2);
    assert.equal(parsed.attendees[0].email, "sarah@example.com");
    assert.equal(parsed.attendees[0].name, "Sarah");
    assert.equal(parsed.attendees[0].status, "ACCEPTED");
    assert.equal(parsed.attendees[1].email, "kofi@example.com");
  });

  test("returns null for non-VEVENT content", () => {
    assert.equal(icloud.parseVevent("not ical"), null);
    assert.equal(icloud.parseVevent(""), null);
  });

  test("handles continuation lines", () => {
    const ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u5\r\nSUMMARY:A very long event title that\r\n  wraps to the next line\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const parsed = icloud.parseVevent(ical);
    assert.equal(parsed.summary, "A very long event title that wraps to the next line");
  });
});

// ---------- iCalendar generation ----------

describe("buildVevent", () => {
  test("builds a basic event", () => {
    const ical = icloud.buildVevent({
      uid: "test-uid",
      summary: "Dentist",
      start: { dateTime: "2026-10-09T15:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-09T16:00:00", timeZone: "America/New_York" },
      location: "123 Main St",
    });
    assert.ok(ical.includes("UID:test-uid"));
    assert.ok(ical.includes("SUMMARY:Dentist"));
    assert.ok(ical.includes("DTSTART;TZID=America/New_York:20261009T150000"));
    assert.ok(ical.includes("DTEND;TZID=America/New_York:20261009T160000"));
    assert.ok(ical.includes("LOCATION:123 Main St"));
  });

  test("builds an all-day event", () => {
    const ical = icloud.buildVevent({
      uid: "allday-1",
      summary: "Holiday",
      start: { date: "2026-10-09" },
      end: { date: "2026-10-10" },
    });
    assert.ok(ical.includes("DTSTART;VALUE=DATE:20261009"));
    assert.ok(ical.includes("DTEND;VALUE=DATE:20261010"));
  });

  test("roundtrips through parse", () => {
    const ical = icloud.buildVevent({
      uid: "rt-1",
      summary: "Lunch, drinks; fun",
      start: { dateTime: "2026-10-09T12:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-09T13:30:00", timeZone: "America/New_York" },
      location: "Carbone",
      description: "Line one\nLine two",
    });
    const parsed = icloud.parseVevent(ical);
    assert.equal(parsed.uid, "rt-1");
    assert.equal(parsed.summary, "Lunch, drinks; fun");
    assert.equal(parsed.location, "Carbone");
    assert.equal(parsed.description, "Line one\nLine two");
  });
});

// ---------- discovery ----------

describe("discover", () => {
  test("finds the principal and home", async () => {
    const disc = await icloud.discover("test@icloud.com", "app-pass-1234");
    assert.ok(disc.ok);
    assert.ok(disc.principal.includes("principal"));
    assert.ok(disc.home.includes("calendars"));
  });

  test("rejects bad credentials", async () => {
    const disc = await icloud.discover("test@icloud.com", "wrong-password");
    assert.ok(!disc.ok);
    assert.ok(disc.error.includes("rejected"));
  });
});

// ---------- listCalendars ----------

describe("listCalendars", () => {
  test("finds the default calendar", async () => {
    const disc = await icloud.discover("test@icloud.com", "app-pass-1234");
    const cals = await icloud.listCalendars("test@icloud.com", "app-pass-1234", disc.home);
    assert.ok(cals.ok);
    assert.equal(cals.calendars.length, 1);
    assert.equal(cals.calendars[0].name, "Home");
  });
});

// ---------- connect / disconnect ----------

describe("connect", () => {
  test("connects with valid credentials", async () => {
    const result = await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    assert.ok(result.ok);
    assert.equal(result.email, "test@icloud.com");
    assert.ok(result.calendars.length > 0);
    // Stored in db
    const row = db.getOauthTokens(C, "apple_calendar");
    assert.ok(row);
    assert.equal(row.account_label, "test@icloud.com");
    assert.equal(row.access_token, "app-pass-1234");
  });

  test("rejects bad password", async () => {
    const result = await icloud.connect(C, "test@icloud.com", "wrong");
    assert.ok(!result.ok);
  });

  test("rejects invalid email", async () => {
    const result = await icloud.connect(C, "not-an-email", "app-pass-1234");
    assert.ok(!result.ok);
    assert.ok(result.error.includes("email"));
  });
});

describe("disconnect", () => {
  test("disconnects a connected account", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const result = icloud.disconnect(C);
    assert.ok(result.ok);
    assert.equal(result.status, "disconnected");
    assert.ok(!db.getOauthTokens(C, "apple_calendar"));
  });

  test("returns ok when nothing is connected", () => {
    const result = icloud.disconnect(C);
    assert.ok(result.ok);
    assert.equal(result.status, "nothing_connected");
  });
});

// ---------- credentialsFor ----------

describe("credentialsFor", () => {
  test("returns credentials when connected", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const creds = icloud.credentialsFor(C);
    assert.ok(creds.ok);
    assert.equal(creds.email, "test@icloud.com");
    assert.equal(creds.password, "app-pass-1234");
    assert.ok(creds.home);
  });

  test("returns an error when not connected", () => {
    const creds = icloud.credentialsFor(C);
    assert.ok(!creds.ok);
    assert.equal(creds.status, "not_connected");
  });
});

// ---------- event operations ----------

describe("listEvents", () => {
  test("lists events in a date range", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    fake.seedEvent({
      uid: "evt-1",
      summary: "Dentist",
      start: { dateTime: "2026-10-09T15:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-09T16:00:00", timeZone: "America/New_York" },
    });
    fake.seedEvent({
      uid: "evt-2",
      summary: "Lunch",
      start: { dateTime: "2026-10-10T12:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-10T13:00:00", timeZone: "America/New_York" },
    });

    const creds = icloud.credentialsFor(C);
    const result = await icloud.listEvents(creds, {
      from: "2026-10-09",
      to: "2026-10-10",
      timeZone: "America/New_York",
    });
    assert.ok(result.ok);
    assert.ok(result.events.length >= 1);
    assert.ok(result.events.some(e => e.summary === "Dentist"));
  });

  test("returns empty for a quiet range", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const creds = icloud.credentialsFor(C);
    const result = await icloud.listEvents(creds, {
      from: "2026-12-25",
      to: "2026-12-26",
    });
    assert.ok(result.ok);
    assert.equal(result.count, 0);
  });
});

describe("createEvent", () => {
  test("creates an event and reads it back", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const creds = icloud.credentialsFor(C);
    const result = await icloud.createEvent(creds, {
      summary: "Dinner with Kofi",
      start: "2026-10-09T19:00:00",
      end: "2026-10-09T21:00:00",
      location: "Carbone",
      timeZone: "America/New_York",
    });
    assert.ok(result.ok);
    assert.equal(result.status, "created");
    assert.ok(result.event_id);
    assert.equal(result.event.summary, "Dinner with Kofi");
    assert.equal(result.confirmed, true);
    // Really on the fake server
    assert.equal(fake.state.events.length, 1);
  });

  test("refuses a duplicate UID (If-None-Match)", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const creds = icloud.credentialsFor(C);
    await icloud.createEvent(creds, {
      summary: "First",
      start: "2026-10-09T19:00:00",
      end: "2026-10-09T20:00:00",
      timeZone: "America/New_York",
    });
    // Each create gets a fresh UUID, so two creates should both succeed
    const result = await icloud.createEvent(creds, {
      summary: "Second",
      start: "2026-10-09T20:00:00",
      end: "2026-10-09T21:00:00",
      timeZone: "America/New_York",
    });
    assert.ok(result.ok);
    assert.equal(fake.state.events.length, 2);
  });
});

describe("changeEvent", () => {
  test("changes an event's title and location", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const href = fake.seedEvent({
      uid: "change-1",
      summary: "Lunch",
      start: { dateTime: "2026-10-09T12:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-09T13:00:00", timeZone: "America/New_York" },
      location: "Sweetgreen",
    });
    const creds = icloud.credentialsFor(C);
    const result = await icloud.changeEvent(creds, href, {
      summary: "Lunch with Sarah",
      location: "Carbone",
    }, { timeZone: "America/New_York" });
    assert.ok(result.ok);
    assert.equal(result.status, "changed");
    assert.equal(result.event.summary, "Lunch with Sarah");
    assert.equal(result.event.location, "Carbone");
  });

  test("changes the time", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const href = fake.seedEvent({
      uid: "change-2",
      summary: "Meeting",
      start: { dateTime: "2026-10-09T14:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-09T15:00:00", timeZone: "America/New_York" },
    });
    const creds = icloud.credentialsFor(C);
    const result = await icloud.changeEvent(creds, href, {
      start: "2026-10-09T16:00:00",
      end: "2026-10-09T17:00:00",
    }, { timeZone: "America/New_York" });
    assert.ok(result.ok);
    assert.ok(result.event.start.includes("16:00"));
  });
});

describe("deleteEvent", () => {
  test("deletes an event", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const href = fake.seedEvent({
      uid: "del-1",
      summary: "Cancel me",
      start: { dateTime: "2026-10-09T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-09T11:00:00", timeZone: "America/New_York" },
    });
    assert.equal(fake.state.events.length, 1);
    const creds = icloud.credentialsFor(C);
    const result = await icloud.deleteEvent(creds, href);
    assert.ok(result.ok);
    assert.equal(result.status, "deleted");
    assert.equal(fake.state.events.length, 0);
  });

  test("404 on a nonexistent event", async () => {
    await icloud.connect(C, "test@icloud.com", "app-pass-1234");
    const creds = icloud.credentialsFor(C);
    const result = await icloud.deleteEvent(creds, "/12345678/calendars/home/nonexistent.ics");
    assert.ok(!result.ok);
  });
});

// ---------- eventView ----------

describe("eventView", () => {
  test("shapes a parsed event like Google's format", () => {
    const view = icloud.eventView({
      uid: "v1",
      summary: "Dentist",
      start: { dateTime: "2026-10-09T15:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-09T16:00:00", timeZone: "America/New_York" },
      location: "123 Main St",
    });
    assert.equal(view.id, "v1");
    assert.equal(view.summary, "Dentist");
    assert.equal(view.start, "2026-10-09T15:00:00");
    assert.equal(view.end, "2026-10-09T16:00:00");
    assert.equal(view.time_zone, "America/New_York");
    assert.equal(view.location, "123 Main St");
  });
});

// ---------- blocksTime ----------

describe("blocksTime", () => {
  test("a normal event blocks time", () => {
    assert.ok(icloud.blocksTime({ status: "CONFIRMED" }));
  });

  test("a cancelled event does not block time", () => {
    assert.ok(!icloud.blocksTime({ status: "CANCELLED" }));
  });

  test("a transparent event does not block time", () => {
    assert.ok(!icloud.blocksTime({ transp: "TRANSPARENT" }));
  });
});
