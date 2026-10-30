// Everyday seals (REASON_STAMPS_EVERYDAY, 2026-10-30). The owner had a call that got what it was for and
// a run of research, and an empty book: every seal in the starter catalog is rare (an hour on hold, a
// phone menu beaten, the small hours, three from one text). With the flag on:
//
//   - Rang on your behalf: a call to someone else whose outcome is a success (confirmed, goal_met),
//     unless a rarer seal already marks that call; never a call to the owner, never a call that failed
//   - Looked into, thoroughly: research closed done, one a week (from Monday, on their clock)
//   - the backfill awards both from the record and tells nobody
//   - the book offers their hints first, and an empty page centres its not-yet spots
//
// Flag off: nothing new is awarded, and the hints are as they were.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stamps-everyday-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const stamps = await import("../src/stamps.js");
const wx = await import("../src/pages/webseals.js");
const { clock } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const T0 = Date.parse("2026-10-27T18:00:00Z"); // 2 PM in New York: never the small hours
const DAY = 86_400_000;
const told = [];

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_WEB_DAILY = "owner";
  process.env.REASON_STAMPS_WAX = "on";
  process.env.REASON_STAMPS_EVERYDAY = "on";
  delete process.env.REASON_STAMPS_TIERS;
  told.length = 0;
  stamps.installStamps({ tell: (c, line) => told.push(line), delayMs: 0 });
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM stamps; DELETE FROM stamp_jobs; DELETE FROM stamp_step_times;
    DELETE FROM messages; DELETE FROM tasks; DELETE FROM calls; DELETE FROM research;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari Nyarko", isOperator: true });
  // A first errand already done, so `first` is spoken for (as in the owner's real book).
  const t = Number(db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at) VALUES (?, 't', 'g', 'running', 3, ?, ?)").run(OWNER_C, T0 - 30 * DAY, T0 - 30 * DAY).lastInsertRowid);
  clock.skip(T0 - 30 * DAY - Date.now());
  db.finishTask(OWNER_C, t, { state: "done", outcome: "ok" });
  clock.reset();
});

const setNow = (t) => { clock.reset(); clock.skip(t - Date.now()); };
// The rows this (untiered) book draws: research is also stored per question, for REASON_STAMPS_TIERS.
const seals = (type) => db.db.prepare("SELECT * FROM stamps WHERE conversation_id = ? AND type = ? AND ref NOT LIKE 'research:q:%' ORDER BY earned_at").all(OWNER_C, type);

function endCall(kind, { at = T0, isOwner = 0, holdS = 0, presses = null } = {}) {
  setNow(at);
  const id = Number(db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, is_owner, created_at, updated_at, hold_total_s, menu_presses) VALUES (?, 'fake', '+18005551212', 'g', ?, ?, ?, ?, ?)")
    .run(OWNER_C, isOwner, at - 60_000, at - 60_000, holdS, JSON.stringify(presses ?? [])).lastInsertRowid);
  db.db.prepare("UPDATE calls SET ended_at = ? WHERE id = ?").run(at, id);
  db.updateCall(OWNER_C, id, { state: "completed", outcome_kind: kind });
  return id;
}
function endResearch(at) {
  setNow(at);
  const id = Number(db.db.prepare("INSERT INTO research (conversation_id, question, created_at, updated_at) VALUES (?, 'q', ?, ?)").run(OWNER_C, at - 60_000, at - 60_000).lastInsertRowid);
  db.finishResearch(OWNER_C, id);
  return id;
}

test("a call that got what it was for is Rang on your behalf; a failed call, a call to the owner, earn nothing", () => {
  const met = endCall("goal_met");
  endCall("dropped_before_confirmation", { at: T0 + 60_000 });
  endCall("confirmed", { at: T0 + 120_000, isOwner: 1 });
  const rang = seals("rang");
  assert.equal(rang.length, 1);
  assert.equal(rang[0].ref, `call:${met}`);
  assert.equal(rang[0].source, "live");
  assert.deepEqual(told, [], "owner mode: nothing is said in the thread");
});

test("an outcome written mid-call waits for the line to go down: a hold that runs past 30 min is Held, never also Rang; a ring-back in is not Rang", () => {
  setNow(T0);
  const id = Number(db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, is_owner, created_at, updated_at, hold_total_s, menu_presses) VALUES (?, 'fake', '+18005551212', 'g', 0, ?, ?, 0, '[]')").run(OWNER_C, T0, T0).lastInsertRowid);
  db.updateCall(OWNER_C, id, { outcome_kind: "confirmed" });
  assert.equal(seals("rang").length, 0, "not while the call is still going");
  db.db.prepare("UPDATE calls SET hold_total_s = ? WHERE id = ?").run(40 * 60, id);
  setNow(T0 + 45 * 60_000);
  db.updateCall(OWNER_C, id, { state: "completed" });
  assert.equal(seals("long_hold").length, 1, "awarded live at the end of the call");
  assert.equal(seals("rang").length, 0);
  const back = endCall("goal_met", { at: T0 + DAY });
  db.db.prepare("UPDATE calls SET direction = 'in' WHERE id = ?").run(back);
  db.db.exec("DELETE FROM stamps WHERE type = 'rang'");
  assert.deepEqual(stamps.backfill(OWNER_C), {}, "a call that came in is not one Reason rang");
});

test("a rarer seal on the same call wins: an IVR beaten is Spoke to the manager, not also Rang", () => {
  endCall("confirmed", { presses: [{ digit: "1" }] });
  assert.equal(seals("human").length, 1);
  assert.equal(seals("rang").length, 0);
});

test("research done is Looked into, thoroughly: one a week, Monday to Sunday on their clock", () => {
  endResearch(T0); // Tuesday 27 October, 2 PM in New York
  endResearch(T0 + 3_600_000);
  endResearch(T0 + DAY);
  // Sunday 1 November, 11:30 PM in New York is already Monday in UTC: still this week on their clock.
  endResearch(Date.parse("2026-11-02T04:30:00Z"));
  assert.equal(seals("looked_into").length, 1, "one week: one seal");
  assert.equal(seals("looked_into")[0].ref, "research:week:2026-10-26");
  endResearch(T0 + 7 * DAY);
  assert.deepEqual(seals("looked_into").map(r => r.ref), ["research:week:2026-10-26", "research:week:2026-11-02"]);
});

test("flag off: neither is awarded, live or by the backfill, and the hints are the rare ones", () => {
  process.env.REASON_STAMPS_EVERYDAY = "off";
  endCall("goal_met");
  endResearch(T0);
  assert.equal(seals("rang").length + seals("looked_into").length, 0);
  assert.deepEqual(stamps.backfill(OWNER_C), {});
  assert.equal(stamps.award(OWNER_C, { type: "rang", ref: "call:x", at: T0 }), null);
  assert.deepEqual(stamps.sealHintOrder(), stamps.SEAL_HINT_ORDER);
});

test("backfill: the record's goal_met calls and research days become seals, told to nobody", () => {
  process.env.REASON_STAMPS_EVERYDAY = "off";
  endCall("goal_met");
  endResearch(T0 - 2 * DAY);
  endResearch(T0 - 2 * DAY + 60_000);
  endResearch(T0);
  process.env.REASON_STAMPS_EVERYDAY = "on";
  assert.deepEqual(stamps.backfill(OWNER_C, { dryRun: true }), { looked_into: 2, rang: 1 });
  assert.deepEqual(stamps.backfill(OWNER_C), { looked_into: 2, rang: 1 });
  assert.deepEqual(stamps.backfill(OWNER_C), {}, "idempotent");
  assert.ok(db.db.prepare("SELECT * FROM stamps WHERE type IN ('rang','looked_into')").all().every(r => r.source === "backfill" && r.told_at == null));
  assert.deepEqual(told, []);
});

test("the book: everyday seals read in wax with a story, their hints come first, an empty page centres its spots", () => {
  const empty = wx.renderSealBook({ all: [], first: "Omari" });
  assert.match(empty, /<ul class="none">/);
  assert.ok(empty.indexOf("a call that got what it was for") < empty.indexOf("a question, researched properly"));
  endCall("goal_met");
  const all = db.db.prepare("SELECT * FROM stamps WHERE conversation_id = ? ORDER BY earned_at, id").all(OWNER_C)
    .map(r => ({ ...stamps.summarize(r), row: r }));
  const rang = all.find(s => s.type === "rang");
  assert.equal(rang.wax, "black");
  assert.match(rang.ring, / ·$/);
  assert.match(rang.story, /It was no trouble\.$/);
  const page = wx.renderSealBook({ all, first: "Omari" });
  assert.match(page, /Rang on your behalf/);
  assert.doesNotMatch(page, /<ul class="none">/);
  assert.doesNotMatch(page, /a call that got what it was for/, "an earned kind is no longer a hint");
});

test("phone widths: the book is two seals a row, scaled to the cell, and the not-yet spots are two-up too; wider stays auto-fill", () => {
  const page = wx.renderSealBook({ all: [], first: "Omari" });
  const phone = page.match(/@media \(max-width:480px\)\{(.*?)\}\n/)?.[1] ?? "";
  assert.match(phone, /\.sheet ul,\.sheet ul\.none\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(phone, /\.sheet li \.seal\{width:100%;height:auto\}/);
  assert.match(page, /\.sheet ul\{[^}]*repeat\(auto-fill,minmax\(170px,1fr\)\)/, "desktop grid unchanged");
});
