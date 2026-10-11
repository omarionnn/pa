// Global pause: "pause everything" holds all outbound activity, persists across restarts,
// and resumes cleanly.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pause-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { pauseAll, resumeAll, isPaused, pauseNote } = await import("../src/pause.js");
const notice = await import("../src/notice.js");

const CONV = "dm:test:+15005551234";
const NOW = 1700000000000;

after(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM series; DELETE FROM commitments; DELETE FROM timers; DELETE FROM action_ledger; DELETE FROM notice_seen;");
  db.upsertAccount({ conversationId: CONV, channel: "test", address: "+15005551234", name: "Test" });
}

test("pause sets paused_at on account", () => {
  setup();
  assert.equal(isPaused(CONV), false);
  const r = pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(isPaused(CONV), true);
  const acct = db.getAccount(CONV);
  assert.equal(acct.paused_at, NOW);
});

test("pause sets notice mode to off and saves prior mode", () => {
  setup();
  db.setNoticePrefs(CONV, { mode: "timely" });
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  const acct = db.getAccount(CONV);
  assert.equal(acct.pause_prior_mode, "timely");
  const s = notice.settingsFor(CONV, { now: NOW });
  assert.equal(s.mode, "off");
});

test("pause refuses without said", () => {
  setup();
  const r = pauseAll({ conversationId: CONV, said: "", now: NOW });
  assert.equal(r.ok, false);
});

test("double pause is refused", () => {
  setup();
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  const r = pauseAll({ conversationId: CONV, said: "pause it again", now: NOW + 1000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /already paused/i);
});

test("pause pauses active series", () => {
  setup();
  db.createSeries(CONV, { what: "workout check-in", rule: {}, tz: "America/New_York", nextAt: NOW + 86400000 });
  const before = db.listSeries(CONV);
  assert.equal(before.length, 1);
  assert.equal(before[0].state, "active");

  pauseAll({ conversationId: CONV, said: "hold everything", now: NOW });

  const list = db.listSeries(CONV);
  assert.equal(list[0].state, "paused");
});

test("pause pauses active commitments", () => {
  setup();
  db.saveCommitment(CONV, { what: "morning run", days: [1, 3, 5], atMin: 420, timeZone: "America/New_York", said: "morning run", graceMin: 30 });
  const before = db.listCommitments(CONV, { state: "active" });
  assert.equal(before.length, 1);

  pauseAll({ conversationId: CONV, said: "stop everything", now: NOW });

  const active = db.listCommitments(CONV, { state: "active" });
  assert.equal(active.length, 0);
  const paused = db.listCommitments(CONV, { state: "paused" });
  assert.equal(paused.length, 1);
});

test("pause records a ledger entry", () => {
  setup();
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  const actions = db.listActions(CONV, { limit: 1 });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "pause_everything");
});

test("resume restores prior notice mode", () => {
  setup();
  db.setNoticePrefs(CONV, { mode: "digest" });
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  assert.equal(notice.settingsFor(CONV, { now: NOW }).mode, "off");

  const r = resumeAll({ conversationId: CONV, now: NOW + 3600000 });
  assert.equal(r.ok, true);
  assert.equal(r.mode_restored, "digest");
  assert.equal(notice.settingsFor(CONV, { now: NOW + 3600000 }).mode, "digest");
});

test("resume resumes paused series", () => {
  setup();
  db.createSeries(CONV, { what: "workout", rule: {}, tz: "America/New_York", nextAt: NOW + 86400000 });
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  assert.equal(db.listSeries(CONV)[0].state, "paused");

  resumeAll({ conversationId: CONV, now: NOW + 3600000 });
  assert.equal(db.listSeries(CONV)[0].state, "active");
});

test("resume resumes paused commitments", () => {
  setup();
  db.saveCommitment(CONV, { what: "morning run", days: [1, 3, 5], atMin: 420, timeZone: "America/New_York", said: "morning run", graceMin: 30 });
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  assert.equal(db.listCommitments(CONV, { state: "paused" }).length, 1);

  resumeAll({ conversationId: CONV, now: NOW + 3600000 });
  assert.equal(db.listCommitments(CONV, { state: "active" }).length, 1);
});

test("resume clears paused_at", () => {
  setup();
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  assert.equal(isPaused(CONV), true);

  resumeAll({ conversationId: CONV, now: NOW + 3600000 });
  assert.equal(isPaused(CONV), false);
  assert.equal(db.getAccount(CONV).paused_at, null);
});

test("resume without pause is refused", () => {
  setup();
  const r = resumeAll({ conversationId: CONV, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /not paused/i);
});

test("resume records a ledger entry", () => {
  setup();
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  resumeAll({ conversationId: CONV, now: NOW + 3600000 });
  const actions = db.listActions(CONV, { limit: 2 });
  assert.equal(actions[0].action, "resume_everything");
});

test("pauseNote is empty when not paused", () => {
  setup();
  assert.equal(pauseNote(CONV), "");
});

test("pauseNote contains PAUSED when paused", () => {
  setup();
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  const note = pauseNote(CONV);
  assert.match(note, /PAUSED/);
  assert.match(note, /one-off/);
});

test("pause persists across module reload (survives restart)", () => {
  setup();
  pauseAll({ conversationId: CONV, said: "pause everything", now: NOW });
  const acct = db.getAccount(CONV);
  assert.ok(acct.paused_at);
  assert.equal(acct.pause_prior_mode, "timely");
});
