// The owner's announcement script (scripts/announce.js). Temp database, stubbed sender, no
// network, no model:
//
//   is it only people who texted in the last 30 days?
//   are opted-out, paused, removed, blocked and Sendblue-opted-out people left out?
//   is one phone number one recipient, however many conversations it has?
//   does a rerun text nobody twice?
//   is somebody whose night it is skipped now and picked up on a later run?
//   does the dry run send nothing and write nothing?
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-announce-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.REASON_NOTICE_QUIET_START;
delete process.env.REASON_NOTICE_QUIET_END;

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const A = await import("../scripts/announce.js");

const DAY = 24 * 60 * 60 * 1000;
const NOON_NY = Date.parse("2026-10-26T16:00:00Z");   // 12:00 New York, 01:00 Tokyo
const conv = (n) => `dm:sendblue:${n}`;
let ext = 0;

function person(number, { daysAgo = 1, channel = "sendblue", c = conv(number) } = {}) {
  db.upsertAccount({ conversationId: c, channel, address: number, name: "Someone" });
  db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, text) VALUES (?, ?, ?, ?, '')")
    .run(channel, `x${++ext}`, c, clock.now() - daysAgo * DAY);
  return c;
}

function stubRouter() {
  const sent = [];
  return { sent, sendNow: async (m) => { sent.push(m); return { ok: true, delivered: { message_id: `m${sent.length}` } }; } };
}

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  clock.skip(NOON_NY - Date.now());
  db.db.exec("DELETE FROM accounts; DELETE FROM outbox; DELETE FROM inbound_messages; DELETE FROM blocked_numbers;");
});

test("only people with an inbound text in the last 30 days", () => {
  person("+14155550001", { daysAgo: 2 });
  person("+14155550002", { daysAgo: 29 });
  person("+14155550003", { daysAgo: 31 });
  person("+14155550004", { channel: "console", c: "console:x" });
  const a = A.audience();
  assert.deepEqual(a.recipients.map(r => r.address).sort(), ["+14155550001", "+14155550002"]);
});

test("opted-out people are left out, by every route the repo has", () => {
  person("+14155550010");
  const removed = person("+14155550011");
  db.db.prepare("UPDATE accounts SET state = 'removed' WHERE conversation_id = ?").run(removed);
  const paused = person("+14155550012");
  db.setPaused(paused, { at: clock.now(), priorMode: null });
  const off = person("+14155550013");
  db.setNoticePrefs(off, { mode: "off" });
  person("+14155550014");
  db.blockNumber("+14155550014");
  const sbOut = person("+14155550015", { daysAgo: 5 });
  db.enqueueOutbound({ idemKey: "k-optout", conversationId: sbOut, channel: "sendblue", address: "+14155550015", body: "hi" });
  db.db.prepare("UPDATE outbox SET state = 'failed', last_error_key = 'OPTED_OUT', failed_at = ? WHERE idem_key = 'k-optout'").run(clock.now() - DAY);
  const a = A.audience();
  assert.deepEqual(a.recipients.map(r => r.address), ["+14155550010"]);
  assert.equal(a.excluded.optedOut, 5);
});

test("one phone number is one recipient", () => {
  person("+14155550020", { c: "dm:sendblue:+14155550020" });
  person("+1 (415) 555-0020", { c: "dm:other:dup", channel: "linq" });
  const a = A.audience();
  assert.equal(a.recipients.length, 1);
  assert.equal(a.excluded.duplicate, 1);
});

test("an opt-out on one conversation covers the number's other conversations; blocks match by digits", () => {
  const sb = person("+14155550025");
  db.setNoticePrefs(sb, { mode: "off" });
  person("+1 415 555 0025", { c: "dm:linq:dup", channel: "linq", daysAgo: 0 });
  person("+14155550026");
  db.blockNumber("+1 (415) 555-0026");
  const a = A.audience();
  assert.equal(a.recipients.length, 0);
  assert.equal(a.excluded.optedOut, 2);
});

test("a rerun never texts a number twice, even when its other channel is now the most recent", async () => {
  person("+14155550027", { daysAgo: 2 });
  const router = stubRouter();
  await A.sendAll({ router, gapMs: 0 });
  assert.equal(router.sent.length, 2);
  person("+14155550027", { c: "dm:linq:later", channel: "linq", daysAgo: 0 });
  await A.sendAll({ router, gapMs: 0 });
  assert.equal(router.sent.length, 2);
  assert.equal(A.audience().excluded.alreadySent, 1);
});

test("dry run renders the two bubbles, sends nothing and writes nothing", () => {
  person("+14155550030");
  const before = db.db.prepare("SELECT total_changes() n").get().n;
  const out = A.renderDryRun(A.audience());
  assert.equal(db.db.prepare("SELECT total_changes() n").get().n, before);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);
  assert.match(out, /recipients: 1\n/);
  assert.match(out, /opted-out 0, already-sent 0, quiet-hours 0/);
  assert.ok(out.includes(A.ANNOUNCEMENTS["events-1025"].bubbles[0]));
  assert.ok(out.includes("reason.omarinyarko.com/updates"));
  assert.ok(!out.includes("415"), "never a phone number");
  assert.ok(!out.includes("Someone"), "never a name");
});

test("the send goes as two bubbles in order, and a rerun texts nobody twice", async () => {
  person("+14155550040");
  person("+14155550041");
  const router = stubRouter();
  const gaps = [];
  const r1 = await A.sendAll({ router, gapMs: 3000, sleep: async (ms) => { gaps.push(ms); } });
  assert.equal(r1.sent, 2);
  assert.deepEqual(gaps, [3000]);
  assert.equal(router.sent.length, 4);
  assert.deepEqual(router.sent.slice(0, 2).map(m => m.text), A.ANNOUNCEMENTS["events-1025"].bubbles);
  // Never read back to them as "a message didn't go".
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM outbox WHERE told_at IS NULL").get().n, 0);

  const r2 = await A.sendAll({ router, gapMs: 0 });
  assert.equal(r2.sent, 0);
  assert.equal(router.sent.length, 4);
  assert.equal(A.audience().excluded.alreadySent, 2);
});

test("a failed first bubble is not retried by a rerun either, and the link never goes before it", async () => {
  person("+14155550045");
  const router = { sent: [], sendNow: async (m) => { router.sent.push(m); return { ok: false, retryable: false, error: "nope" }; } };
  const r = await A.sendAll({ router, gapMs: 0 });
  assert.equal(r.failed, 1);
  assert.equal(router.sent.length, 1);
  await A.sendAll({ router, gapMs: 0 });
  assert.equal(router.sent.length, 1);
});

test("their night: skipped now, picked up on a later run", async () => {
  person("+14155550050");
  const tokyo = person("+14155550051");
  db.setNoticeWindow(tokyo, { tz: "Asia/Tokyo" });
  const a = A.audience();
  assert.equal(a.recipients.length, 1);
  assert.equal(a.excluded.quietHours, 1);
  const router = stubRouter();
  await A.sendAll({ router, gapMs: 0 });
  assert.equal(router.sent.length, 2);

  clock.skip(10 * 60 * 60 * 1000);   // 11:00 in Tokyo, 22:00 in New York
  const later = A.audience();
  assert.deepEqual(later.recipients.map(r => r.conversationId), [tokyo]);
  assert.equal(later.excluded.alreadySent, 1);
  await A.sendAll({ router, gapMs: 0 });
  assert.equal(router.sent.length, 4);
});

test("the read-only quiet-hours check agrees with src/notice.js", async () => {
  const notice = await import("../src/notice.js");
  const a = person("+14155550070");
  const b = person("+14155550071");
  db.setNoticeWindow(b, { tz: "Asia/Tokyo", start: 7, end: 23 });
  const c = person("+14155550072");
  db.setNoticePrefs(c, { snoozeUntil: clock.now() + DAY });
  for (const id of [a, b, c]) {
    for (const h of [0, 3, 7, 12, 21, 22, 23]) {
      const at = NOON_NY + h * 60 * 60 * 1000;
      assert.equal(A.inTheirNight(id, at), notice.inTheirNight(id, at));
      assert.equal(A.theirSettings(id, at).mode, notice.settingsFor(id, { now: at }).mode);
    }
  }
});

test("owner can be skipped; arguments refuse anything unknown and default to a dry run", () => {
  const owner = person("+12025551234", { c: "dm:owner" });
  db.db.prepare("UPDATE accounts SET is_operator = 1 WHERE conversation_id = ?").run(owner);
  person("+14155550060");
  assert.equal(A.audience().recipients.length, 2);
  const s = A.audience({ skipOwner: true });
  assert.equal(s.recipients.length, 1);
  assert.equal(s.excluded.owner, 1);
  assert.equal(A.parseArgs([]).send, false);
  assert.equal(A.parseArgs(["--send", "--confirm=events-1025"]).confirm, "events-1025");
  assert.throws(() => A.parseArgs(["--sned"]));
  assert.throws(() => A.parseArgs(["--id=nope"]));
});
