// The arithmetic half of rhythms: evidence gathering, the bar, keep, expire.
// No model needed. The bar is code's to guarantee.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-rhythms-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const rhythms = await import("../src/rhythms.js");
const notice = await import("../src/notice.js");
const { clock } = await import("../src/config.js");

const C = "dm:rhythms";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => clock.reset());

// Seed inbound messages spread across time so evidenceFor has something to read.
function seedMessages(conversationId, times) {
  for (const t of times) {
    db.db.prepare("INSERT INTO inbound_messages (conversation_id, channel, external_id, text, received_at) VALUES (?, ?, ?, ?, ?)")
      .run(conversationId, "test", `msg-${t}`, "hi", t);
  }
}

function seedOutbound(conversationId, times) {
  for (const t of times) {
    db.db.prepare("INSERT INTO outbox (conversation_id, message_id, body, state, to_owner, sent_at) VALUES (?, ?, ?, 'sent', 1, ?)")
      .run(conversationId, `out-${t}`, "hello", t);
  }
}

// Make evidence points spanning weeks, all at the same hour.
function threeWeeksOfEvening(now) {
  const times = [];
  for (let d = 0; d < 21; d += 3) {
    const t = now - d * DAY + 21 * HOUR; // ~9pm each
    times.push(t);
  }
  return times;
}

// ---------- evidenceFor ----------

test("evidenceFor gathers inbound messages and computes distributions", () => {
  const now = Date.parse("2026-10-15T12:00:00-04:00");
  const times = threeWeeksOfEvening(now);
  seedMessages(C, times);

  const ev = rhythms.evidenceFor({ conversationId: C, now, timeZone: "America/New_York", days: 21 });
  assert.ok(ev.count >= 3, "found messages");
  assert.ok(ev.points.length >= 3, "has point refs");
  assert.ok(ev.by_hour.length > 0, "hour distribution");
  assert.ok(ev.span_days >= 14, `span_days ${ev.span_days} >= 14`);
  assert.ok(ev.points[0].ref.startsWith("m"), "refs have m prefix");
});

test("evidenceFor with no messages returns empty", () => {
  const conv = "dm:empty-ev";
  db.upsertAccount({ conversationId: conv, channel: "test", address: "+15551110000", name: "Nobody", isOperator: false });
  const ev = rhythms.evidenceFor({ conversationId: conv, now: clock.now(), timeZone: "America/New_York" });
  assert.equal(ev.count, 0);
  assert.equal(ev.span_days, 0);
});

// ---------- enoughToLookAt ----------

test("not enough points fails", () => {
  const ev = { count: 2, span_days: 20, points: [] };
  const got = rhythms.enoughToLookAt(ev);
  assert.equal(got.ok, false);
  assert.match(got.why, /floor/);
});

test("not enough span fails", () => {
  const ev = { count: 10, span_days: 7, points: [] };
  const got = rhythms.enoughToLookAt(ev);
  assert.equal(got.ok, false);
  assert.match(got.why, /span/);
});

test("enough of both passes", () => {
  const ev = { count: 10, span_days: 15, points: [] };
  assert.equal(rhythms.enoughToLookAt(ev).ok, true);
});

// ---------- check ----------

test("check refuses with no 'use'", () => {
  const evidence = { points: [{ ref: "m1", at: 1000 }, { ref: "m2", at: 2000 }, { ref: "m3", at: 1000 + 15 * DAY }] };
  const proposal = { about: "evenings", inference: "busy after 9pm", evidence: ["m1", "m2", "m3"], use: "" };
  const got = rhythms.check(proposal, evidence);
  assert.equal(got.ok, false);
  assert.match(got.why, /use/i);
});

test("check refuses with fabricated refs", () => {
  const evidence = { points: [{ ref: "m1", at: 1000 }, { ref: "m2", at: 2000 }, { ref: "m3", at: 1000 + 15 * DAY }] };
  const proposal = { about: "evenings", inference: "busy after 9pm", evidence: ["m1", "m2", "m99"], use: "hold non-urgent things" };
  const got = rhythms.check(proposal, evidence);
  assert.equal(got.ok, false);
  assert.match(got.why, /not a row/);
});

test("check refuses with too few points", () => {
  const evidence = { points: [{ ref: "m1", at: 1000 }, { ref: "m2", at: 2000 }] };
  const proposal = { about: "evenings", inference: "busy", evidence: ["m1", "m2"], use: "hold stuff" };
  const got = rhythms.check(proposal, evidence);
  assert.equal(got.ok, false);
  assert.match(got.why, /floor/);
});

test("check refuses when span is too short", () => {
  const base = Date.parse("2026-10-15T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m1", at: base },
    { ref: "m2", at: base + 1 * DAY },
    { ref: "m3", at: base + 5 * DAY },
  ]};
  const proposal = { about: "evenings", inference: "up late", evidence: ["m1", "m2", "m3"], use: "hold till evening" };
  const got = rhythms.check(proposal, evidence);
  assert.equal(got.ok, false);
  assert.match(got.why, /day/);
});

test("check passes with valid proposal", () => {
  const base = Date.parse("2026-10-01T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m1", at: base },
    { ref: "m2", at: base + 7 * DAY },
    { ref: "m3", at: base + 14 * DAY },
  ]};
  const proposal = { about: "evenings", inference: "deals with work after 9pm", evidence: ["m1", "m2", "m3"], use: "hold non-urgent things till the evening" };
  const got = rhythms.check(proposal, evidence);
  assert.equal(got.ok, true);
  assert.equal(got.about, "evenings");
  assert.equal(got.points.length, 3);
  assert.ok(got.span_days >= 14);
});

// ---------- keep ----------

test("keep stores a pattern as a guess with PATTERN_SOURCE", () => {
  const base = Date.parse("2026-10-01T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m10", at: base },
    { ref: "m20", at: base + 7 * DAY },
    { ref: "m30", at: base + 14 * DAY },
  ]};
  const proposal = { about: "evenings", inference: "up after nine", evidence: ["m10", "m20", "m30"], use: "hold non-urgent things" };
  const out = rhythms.keep({ conversationId: C, proposal, evidence });
  assert.equal(out.ok, true);
  assert.ok(out.id > 0);
  assert.equal(out.already_noticed, false);

  const rows = db.listPatterns(C);
  assert.ok(rows.some(r => r.id === out.id));
});

test("keep is idempotent — same pattern is recognized as already_noticed", () => {
  const base = Date.parse("2026-09-20T22:00:00-04:00");
  const evidence = { points: [
    { ref: "m40", at: base },
    { ref: "m50", at: base + 7 * DAY },
    { ref: "m60", at: base + 14 * DAY },
  ]};
  const proposal = { about: "saturdays", inference: "saturdays are gone", evidence: ["m40", "m50", "m60"], use: "do not nudge on saturday" };
  const first = rhythms.keep({ conversationId: C, proposal, evidence });
  assert.equal(first.ok, true);
  assert.equal(first.already_noticed, false);

  const again = rhythms.keep({ conversationId: C, proposal, evidence });
  assert.equal(again.ok, true);
  assert.equal(again.already_noticed, true);
  assert.equal(again.id, first.id);
});

// ---------- expire ----------

test("expire drops patterns unsupported for EXPIRE_DAYS", () => {
  const c2 = "dm:expire-test";
  db.upsertAccount({ conversationId: c2, channel: "test", address: "+15559990000", name: "Test", isOperator: false });

  const base = Date.parse("2026-09-10T21:00:00-04:00");
  clock.skip(base - clock.now());
  const evidence = { points: [
    { ref: "m100", at: base },
    { ref: "m200", at: base + 7 * DAY },
    { ref: "m300", at: base + 14 * DAY },
  ]};
  rhythms.keep({ conversationId: c2, proposal: {
    about: "bedtime", inference: "asleep by midnight", evidence: ["m100", "m200", "m300"], use: "no texts after 12"
  }, evidence });

  assert.equal(db.listPatterns(c2).length, 1, "pattern was stored");

  const now = base + (rhythms.EXPIRE_DAYS + 1) * DAY;
  const expired = rhythms.expire({ conversationId: c2, now });
  assert.equal(expired.length, 1, "one pattern expired");
  assert.equal(db.listPatterns(c2).length, 0, "gone from the DB");
});

test("expire leaves recently supported patterns alone", () => {
  const c3 = "dm:expire-keep";
  db.upsertAccount({ conversationId: c3, channel: "test", address: "+15559990001", name: "Keep", isOperator: false });

  const base = Date.parse("2026-09-10T21:00:00-04:00");
  clock.skip(base - clock.now());
  const evidence = { points: [
    { ref: "m110", at: base },
    { ref: "m210", at: base + 7 * DAY },
    { ref: "m310", at: base + 14 * DAY },
  ]};
  const out = rhythms.keep({ conversationId: c3, proposal: {
    about: "mornings", inference: "not a morning person", evidence: ["m110", "m210", "m310"], use: "no morning nudges"
  }, evidence });

  const later = base + 20 * DAY;
  db.supportPattern(c3, out.id, later);

  const now = later + 10 * DAY;
  const expired = rhythms.expire({ conversationId: c3, now });
  assert.equal(expired.length, 0, "recently supported — not expired");
  assert.equal(db.listPatterns(c3).length, 1, "still in DB");
});

// ---------- localWeekday ----------

test("localWeekday returns the right day in a timezone", () => {
  const wed = Date.parse("2026-10-14T20:00:00-04:00"); // a Wednesday in New York
  assert.equal(rhythms.localWeekday(wed, "America/New_York"), 3); // Wed is index 3
});
