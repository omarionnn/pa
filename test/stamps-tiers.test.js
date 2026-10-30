// One seal per kind (REASON_STAMPS_TIERS, 2026-10-30). The owner's book showed "Looked into, thoroughly"
// four times over. With the flag on:
//
//   - every kind is in the book once; an everyday seal earned again counts up instead of adding a copy
//   - at 10, 25, 50 and 100 the same seal is upgraded in place: dated the day the tier was reached, it
//     moves to the newest spot (NEW), and the first-earned date stays on hover
//   - research counts once per question per day on their clock (case and punctuation don't make it new)
//   - a rare seal earned again stays its first one
//   - the backfill turns the record into the true count, tells nobody; flag off brings #251's book back
//   - at `on`, a seal earned again is told only when it reaches a tier
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stamps-tiers-"));
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
const { seal } = await import("../src/seal.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const T0 = Date.parse("2026-10-05T18:00:00Z"); // Monday 5 October, 2 PM in New York
const DAY = 86_400_000;
const told = [];

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  Object.assign(process.env, { REASON_WEB_DAILY: "owner", REASON_STAMPS_WAX: "on", REASON_STAMPS_EVERYDAY: "on", REASON_STAMPS_TIERS: "on" });
  told.length = 0;
  stamps.installStamps({ tell: (c, line) => told.push(line), delayMs: 0 });
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM stamps; DELETE FROM stamp_jobs; DELETE FROM stamp_step_times;
    DELETE FROM messages; DELETE FROM tasks; DELETE FROM calls; DELETE FROM research;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari Nyarko", isOperator: true });
});

const setNow = (t) => { clock.reset(); clock.skip(t - Date.now()); };
function research(at, question) {
  setNow(at);
  const id = Number(db.db.prepare("INSERT INTO research (conversation_id, question, created_at, updated_at) VALUES (?, ?, ?, ?)").run(C, question, at - 60_000, at - 60_000).lastInsertRowid);
  db.finishResearch(C, id);
  return id;
}
function call(at) {
  setNow(at);
  const id = Number(db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, is_owner, created_at, updated_at, hold_total_s, menu_presses) VALUES (?, 'fake', '+18005551212', 'g', 0, ?, ?, 0, '[]')").run(C, at - 60_000, at - 60_000).lastInsertRowid);
  db.db.prepare("UPDATE calls SET ended_at = ? WHERE id = ?").run(at, id);
  db.updateCall(C, id, { state: "completed", outcome_kind: "goal_met" });
  return id;
}
const book = () => stamps.listStamps(C).filter(s => !s.outside);
const one = (type) => { const all = book().filter(s => s.type === type); assert.equal(all.length, 1, `one ${type} seal`); return all[0]; };

test("tiers: 1 until 10, then 10, 25, 50, 100; the next goal; the line under the name", () => {
  assert.deepEqual([1, 9, 10, 24, 25, 49, 50, 99, 100, 250].map(stamps.tierOf), [1, 1, 10, 10, 25, 25, 50, 50, 100, 100]);
  assert.deepEqual([1, 9, 10, 62, 100].map(stamps.nextTier), [10, 10, 25, 100, null]);
  assert.equal(stamps.countLine(1), "Once · next at 10");
  assert.equal(stamps.countLine(4), "4 times · next at 10");
  assert.equal(stamps.countLine(120), "120 times");
});

test("no duplicates: twelve questions, three calls and two nights are one seal each, counted", () => {
  for (let i = 0; i < 12; i++) research(T0 + i * DAY, `question ${i}`);
  for (let i = 0; i < 3; i++) call(T0 + i * DAY + 3_600_000);
  // Two rare seals of one kind (two separate nights): still one in the book, the first.
  stamps.award(C, { type: "night_shift", ref: "night:2026-10-06", at: T0 + DAY });
  stamps.award(C, { type: "night_shift", ref: "night:2026-10-09", at: T0 + 4 * DAY });
  const types = book().map(s => s.type);
  assert.deepEqual([...types].sort(), ["looked_into", "night_shift", "rang"]);
  const li = one("looked_into");
  assert.equal(li.count, 12);
  assert.equal(li.tier, 10);
  assert.equal(li.next, 25);
  assert.equal(li.countLine, "12 times · next at 25");
  assert.equal(one("rang").count, 3);
  assert.equal(one("night_shift").count, undefined, "a rare seal carries no count");
  assert.equal(one("night_shift").date, "OCT 6");
});

test("the seal's date is the day its tier was reached; first earned stays on hover; an upgrade lands as NEW", () => {
  for (let i = 0; i < 9; i++) research(T0 + i * DAY, `q${i}`);
  call(T0 + 20 * DAY);
  let v = wx.sealBookView(book());
  assert.equal(v.on[0].type, "rang", "the call is newest while research is at nine");
  assert.equal(one("looked_into").date, "OCT 5");
  research(T0 + 25 * DAY, "the tenth");
  const li = one("looked_into");
  assert.equal(li.tier, 10);
  assert.equal(li.date, "OCT 30");
  assert.equal(li.firstDate, "OCT 5");
  v = wx.sealBookView(book());
  assert.equal(v.newestId, li.id, "the upgraded seal is the newest");
  const page = wx.renderSealBook({ all: book(), first: "Omari" });
  assert.match(page, /title="First earned OCT 5">OCT 30 · NEW</);
  assert.equal(page.match(/Looked into, thoroughly<\/span>/g).length, 1);
  assert.match(page, /10 times · next at 25/);
  assert.match(page, /class="tier tier-10"/);
});

test("counting: the same question the same day counts once (case, punctuation, spacing); next day or another question counts", () => {
  research(T0, "Best ramen near me?");
  research(T0 + 3_600_000, "best   ramen near me");
  research(T0 + 7_200_000, "BEST RAMEN, NEAR ME!");
  assert.equal(one("looked_into").count, 1);
  research(T0 + 7_300_000, "best pho near me");
  research(T0 + DAY, "Best ramen near me?");
  assert.equal(one("looked_into").count, 3);
  // A day is their day: 11:30 PM in New York and 12:30 AM the next morning are two days.
  research(Date.parse("2026-10-08T03:30:00Z"), "late one");
  research(Date.parse("2026-10-08T04:30:00Z"), "late one");
  assert.equal(one("looked_into").count, 5);
});

test("the seal drawing: each tier its own look over the same wax; the plain seal is unchanged", () => {
  const plain = seal({ wax: "green", ring: "R ·", date: "OCT 5 2026" }).replace(/ws[0-9a-z]+/g, "id");
  assert.equal(seal({ wax: "green", ring: "R ·", date: "OCT 5 2026", tier: 1 }).replace(/ws[0-9a-z]+/g, "id"), plain);
  assert.doesNotMatch(plain, /class="tier/);
  const at = (tier) => seal({ wax: "green", ring: "R ·", tier });
  assert.match(at(10), /tier-10/); assert.match(at(10), />10<\/textPath>/); assert.match(at(10), /#9c3b2e/);
  assert.doesNotMatch(at(10), /stroke="#a8823c"/, "no gold ring at 10");
  assert.match(at(25), /stroke="#a8823c"/);
  assert.match(at(50), /#b98b34/, "the ribbon turns gold at 50");
  assert.match(at(100), />· 100 ·<\/textPath>/);
  assert.match(at(100), /stroke="#c9a24a"/, "a gilded edge at 100");
  assert.doesNotMatch(seal({ wax: "blank", ring: "R ·", tier: 10 }), /class="tier/, "a not-yet spot never has a tier");
});

test("migration: four weekly seals and a call become one research seal at its true count and one Rang, told to nobody; flag off brings them back", () => {
  process.env.REASON_STAMPS_TIERS = "off";
  // The owner's record: research on 13 distinct question-days across four weeks (two repeats), one call.
  const days = [0, 0, 1, 2, 2, 7, 8, 9, 14, 15, 16, 21, 22];
  days.forEach((d, i) => research(T0 + d * DAY + i * 60_000, `question ${i}`));
  research(T0 + 60 * 60_000, "question 0"); // the same question, the same day
  research(T0 + 2 * DAY + 90 * 60_000, "QUESTION 4?"); // ditto
  call(T0 + 22 * DAY + 3_600_000);
  // As #251 left it: the weekly rows (and, since this code, the per-question rows written beside them).
  db.db.exec("DELETE FROM stamps WHERE ref LIKE 'research:q:%'");
  assert.equal(book().filter(s => s.type === "looked_into").length, 4, "#251's book: four alike");
  const outbox = db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n;
  process.env.REASON_STAMPS_TIERS = "on";
  assert.deepEqual(stamps.backfill(C, { dryRun: true }), { looked_into: 13 });
  assert.deepEqual(stamps.backfill(C), { looked_into: 13 });
  assert.deepEqual(stamps.backfill(C), {}, "idempotent");
  const li = one("looked_into");
  assert.equal(li.count, 13);
  assert.equal(li.tier, 10);
  assert.equal(li.firstDate, "OCT 5");
  assert.equal(one("rang").count, 1);
  assert.equal(one("rang").countLine, "Once · next at 10");
  assert.deepEqual(told, []);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, outbox, "nothing sent");
  process.env.REASON_STAMPS_TIERS = "off";
  assert.equal(book().filter(s => s.type === "looked_into").length, 4, "rollback: the weekly book, untouched");
});

test("at on: the first of a kind is told, a repeat is not, a tier is told with its count", () => {
  process.env.REASON_WEB_DAILY = "on";
  research(T0, "q0");
  assert.deepEqual(told, ["That one went into your book: Looked into, thoroughly."]);
  for (let i = 1; i < 9; i++) research(T0 + i * DAY, `q${i}`);
  assert.equal(told.length, 1, "repeats are counted, not told");
  research(T0 + 9 * DAY, "q9");
  assert.deepEqual(told.at(-1), "That one went into your book: Looked into, thoroughly, ten times now.");
  assert.equal(told.length, 2);
});

test("Home's New in your book: a repeat isn't new, a tier is", () => {
  for (let i = 0; i < 9; i++) research(T0 + i * DAY, `q${i}`);
  const now9 = T0 + 30 * DAY;
  assert.equal(stamps.newestStamp(C, { now: now9 }), null, "nine, the last nine days ago or more: nothing new");
  research(T0 + 29 * DAY, "q9");
  const n = stamps.newestStamp(C, { now: now9 });
  assert.equal(n.type, "looked_into");
  assert.equal(n.tier, 10);
});
