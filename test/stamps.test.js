// Stamps (src/stamps.js, src/pages/webstamps.js; handoff 2026-10-27 "Coming back daily" §2 + Sharing).
// One pinned test per rule:
//
//   - the catalog: nine types, each one shape (round | rect | oval | ring) and one ink (rust | ink); a
//     fixed tilt -8..+7 from the stamp's own identity
//   - awarded where errands really finish (db.completionBus): a task done, a call's outcome, an order
//     placed / ticket issued — and only for a conversation REASON_WEB_DAILY allows (off: nothing; owner:
//     the operator only)
//   - idempotent: the same completion told twice, or a backfill after, never makes a second stamp
//   - told once in the thread, one line, ONLY at `on` (never at `owner`, never from the backfill)
//   - abroad and whole_trip are never awarded (no source); their hints stay
//   - newestStamp / stampMarkup: the exports Home uses
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stamps-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_SITE_URL = "https://heyreason.test";
delete process.env.REASON_WEB_DAILY;
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const stamps = await import("../src/stamps.js");
const { clock } = await import("../src/config.js");
const { dailyMode, dailyAllowedFor } = await import("../src/dailyflag.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const told = [];
/** Move Reason's clock to `t` (config.clock only skips). */
const setNow = (t) => { clock.reset(); clock.skip(t - Date.now()); };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  delete process.env.REASON_WEB_DAILY;
  told.length = 0;
  stamps.installStamps({ tell: async (c, text, meta) => { told.push({ c, text, meta }); return { ok: true }; }, delayMs: 0 });
  db.db.exec(`DELETE FROM accounts; DELETE FROM threads; DELETE FROM tasks; DELETE FROM calls; DELETE FROM stamps; DELETE FROM stamp_shares;
    DELETE FROM inbound_messages; DELETE FROM agentcard_purchases; DELETE FROM watches; DELETE FROM offers;`);
  for (const [c, a, n, op] of [[OWNER_C, "+12025551234", "Omari Nyarko", true], [KOFI_C, "+14155559876", "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
  }
});

// 2 PM New York on 2026-10-20, and 3 AM the next night.
const DAY = Date.parse("2026-10-20T18:00:00Z");
const NIGHT = Date.parse("2026-10-21T07:00:00Z");
function doneTask(conv, { at = DAY, handle = null, title = "errand" } = {}) {
  setNow(at - 60_000);
  const t = db.createTask(conv, { title, goal: title, maxAttempts: 3 });
  const id = t.id ?? t.task?.id ?? t;
  if (handle) db.db.prepare("UPDATE tasks SET origin_handle = ? WHERE id = ?").run(handle, id);
  setNow(at);
  db.finishTask(conv, id, { state: "done", outcome: "done" });
  return id;
}
const typesOf = (conv) => db.db.prepare("SELECT type FROM stamps WHERE conversation_id = ? ORDER BY id").all(conv).map(r => r.type);

test("the flag file: off by default, owner, on (every spelling the brief names)", () => {
  assert.equal(dailyMode(), "off");
  for (const [v, want] of [["owner", "owner"], [" OWNER ", "owner"], ["on", "on"], ["1", "on"], ["true", "on"], ["yes", "on"], ["nope", "off"]]) {
    process.env.REASON_WEB_DAILY = v;
    assert.equal(dailyMode(), want, v);
  }
  process.env.REASON_WEB_DAILY = "owner";
  assert.equal(dailyAllowedFor(OWNER_C), true);
  assert.equal(dailyAllowedFor(KOFI_C), false);
  assert.equal(dailyAllowedFor(""), false);
});

test("the catalog: nine types, one shape and one ink each, and a fixed tilt -8..+7", () => {
  assert.deepEqual(stamps.TYPES.sort(), ["abroad", "early", "first", "human", "long_hold", "night_shift", "price_drop", "three_in_one", "whole_trip"]);
  for (const k of Object.values(stamps.CATALOG)) {
    assert.ok(["round", "rect", "oval", "ring"].includes(k.shape));
    assert.ok(["rust", "ink"].includes(k.ink));
    assert.ok(k.hint && k.name);
  }
  assert.equal(new Set(Object.values(stamps.CATALOG).map(k => k.shape)).size, 4, "all four shapes are used");
  assert.equal(stamps.CATALOG.abroad.earnable, false, "no country on record");
  assert.equal(stamps.CATALOG.whole_trip.earnable, false, "no stays on record");
  const tilts = new Set();
  for (let i = 0; i < 200; i++) {
    const r = stamps.rotationFor("c", "first", `task:${i}`);
    assert.ok(r >= -8 && r <= 7, String(r));
    assert.equal(r, stamps.rotationFor("c", "first", `task:${i}`), "the same every time");
    tilts.add(r);
  }
  assert.equal(tilts.size, 16);
});

test("off: a finished task earns nothing (zero behaviour change)", () => {
  doneTask(OWNER_C);
  assert.deepEqual(typesOf(OWNER_C), []);
});

test("owner: the operator's first done task earns First errand; nobody else's earns anything; nothing is told", () => {
  process.env.REASON_WEB_DAILY = "owner";
  const id = doneTask(OWNER_C);
  doneTask(KOFI_C);
  assert.deepEqual(typesOf(OWNER_C), ["first"]);
  assert.deepEqual(typesOf(KOFI_C), []);
  const row = db.db.prepare("SELECT * FROM stamps WHERE conversation_id = ?").get(OWNER_C);
  assert.equal(row.task_id, id);
  assert.equal(row.ref, "first");
  assert.equal(row.source, "live");
  assert.equal(told.length, 0, "never an outbound message at owner");
  // A second task is not a first errand.
  doneTask(OWNER_C, { at: DAY + 3_600_000 });
  assert.deepEqual(typesOf(OWNER_C), ["first"]);
});

test("on: told once in the thread, one line, no confetti; the same completion told again makes nothing new", () => {
  process.env.REASON_WEB_DAILY = "on";
  const id = doneTask(KOFI_C);
  assert.deepEqual(typesOf(KOFI_C), ["first"]);
  assert.equal(told.length, 1);
  assert.equal(told[0].c, KOFI_C);
  assert.equal(told[0].text, "That one earned a stamp for your book: First errand.");
  assert.doesNotMatch(told[0].text, /\n|🎉|!/);
  assert.match(told[0].meta.idempotencyKey, /^stamp:\d+$/);
  db.completionBus.emit("task", { conversationId: KOFI_C, id });
  assert.equal(typesOf(KOFI_C).length, 1);
  assert.equal(told.length, 1, "told once");
  assert.ok(db.db.prepare("SELECT told_at FROM stamps").get().told_at);
});

test("night shift: finished 12–6 AM on their clock with nothing from them for an hour; one per night", () => {
  process.env.REASON_WEB_DAILY = "owner";
  doneTask(OWNER_C, { at: DAY });
  doneTask(OWNER_C, { at: NIGHT });
  doneTask(OWNER_C, { at: NIGHT + 600_000 });
  assert.deepEqual(typesOf(OWNER_C), ["first", "night_shift"]);
  assert.equal(db.db.prepare("SELECT ref FROM stamps WHERE type = 'night_shift'").get().ref, "night:2026-10-21");
  // Awake: they texted twenty minutes before it finished the next night.
  const next = NIGHT + 86_400_000;
  db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES ('fake', 'x1', ?, ?)").run(OWNER_C, next - 20 * 60_000);
  doneTask(OWNER_C, { at: next });
  assert.equal(typesOf(OWNER_C).filter(t => t === "night_shift").length, 1);
});

test("three in one: three errands done from one text (same inbound handle) earn it once, on the third", () => {
  process.env.REASON_WEB_DAILY = "owner";
  doneTask(OWNER_C, { handle: "h-1", at: DAY });
  doneTask(OWNER_C, { handle: "h-1", at: DAY + 1000 });
  assert.ok(!typesOf(OWNER_C).includes("three_in_one"));
  doneTask(OWNER_C, { handle: "h-1", at: DAY + 2000 });
  doneTask(OWNER_C, { handle: "h-1", at: DAY + 3000 });
  assert.equal(typesOf(OWNER_C).filter(t => t === "three_in_one").length, 1);
  const s = db.db.prepare("SELECT * FROM stamps WHERE type = 'three_in_one'").get();
  assert.doesNotMatch(s.ref, /h-1/, "the handle itself is not kept");
  assert.equal(JSON.parse(s.detail_json).count, 3);
});

function call(conv, fields) {
  const r = db.db.prepare(`INSERT INTO calls (conversation_id, provider, to_number, goal, created_at, updated_at, brief) VALUES (?, 'fake', '+18005551212', 'g', ?, ?, ?)`)
    .run(conv, DAY, DAY, JSON.stringify({ place: "Comcast Xfinity" }));
  const id = Number(r.lastInsertRowid);
  setNow(DAY);
  db.updateCall(conv, id, { state: "completed", ...fields });
  return id;
}

test("calls: The long hold at 30+ minutes on hold with a person reached; Got through to a human after a phone menu", () => {
  process.env.REASON_WEB_DAILY = "owner";
  call(OWNER_C, { hold_total_s: 52 * 60, outcome_kind: "confirmed" });
  assert.deepEqual(typesOf(OWNER_C), ["long_hold", "first"]);
  const hold = db.db.prepare("SELECT * FROM stamps WHERE type = 'long_hold'").get();
  assert.equal(JSON.parse(hold.detail_json).minutes, 52);
  call(OWNER_C, { menu_presses: JSON.stringify(["1", "3", "0"]), outcome_kind: "answered" });
  assert.ok(typesOf(OWNER_C).includes("human"));
  // Not a story: 29 minutes, a hold given up, a menu that ended at voicemail.
  db.db.exec("DELETE FROM stamps");
  call(OWNER_C, { hold_total_s: 29 * 60, outcome_kind: "confirmed" });
  call(OWNER_C, { hold_total_s: 90 * 60, outcome_kind: "hold_gave_up" });
  call(OWNER_C, { menu_presses: JSON.stringify(["1"]), outcome_kind: "voicemail_left" });
  assert.deepEqual(typesOf(OWNER_C).filter(t => t !== "first"), []);
});

test("purchases: Price drop when the order is the offer a price watch proved lower; Early for a flight booked 7+ days out", () => {
  process.env.REASON_WEB_DAILY = "owner";
  const offer = Number(db.db.prepare("INSERT INTO offers (conversation_id, source, product, seller, price_cents, fetched_at) VALUES (?, 'page', 'Lamp', 'Target', 6000, ?)").run(OWNER_C, DAY).lastInsertRowid);
  db.db.prepare("INSERT INTO watches (conversation_id, url, looking_for, every_ms, created_at, kind, baseline_cents, alert_offer_id) VALUES (?, 'https://x', 'price', 3600000, ?, 'price', 10000, ?)").run(OWNER_C, DAY, offer);
  setNow(DAY);
  db.db.prepare("INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, merchant, amount_cents, offer_id, created_at, updated_at) VALUES (?, 'buy-1', 'awaiting_approval', 'Target', 6000, ?, ?, ?)").run(OWNER_C, offer, DAY, DAY);
  db.markAgentcardPurchase("buy-1", { status: "placed" });
  const drop = db.db.prepare("SELECT * FROM stamps WHERE type = 'price_drop'").get();
  assert.ok(drop);
  assert.equal(JSON.parse(drop.detail_json).savedCents, 4000);
  const legs = [{ origin: "JFK", destination: "LHR", departureAt: "2026-10-30T08:00:00" }];
  db.db.prepare("INSERT INTO agentcard_purchases (conversation_id, buy_conversation_id, status, kind, flight_json, created_at, updated_at) VALUES (?, 'buy-2', 'placed', 'flight', ?, ?, ?)").run(OWNER_C, JSON.stringify({ legs }), DAY, DAY);
  db.markAgentcardPurchase("buy-2", { ticketingState: "issued" });
  const early = db.db.prepare("SELECT * FROM stamps WHERE type = 'early'").get();
  assert.equal(JSON.parse(early.detail_json).days, 9);
  assert.equal(typesOf(OWNER_C).filter(t => t === "abroad").length, 0, "never abroad: no country on record");
});

test("backfill: the same rules over old rows, only INSERTs, never tells, and a second run adds nothing", () => {
  // Rows that finished while the flag was off.
  doneTask(OWNER_C, { at: DAY });
  doneTask(OWNER_C, { at: NIGHT });
  const tasksBefore = JSON.stringify(db.db.prepare("SELECT * FROM tasks ORDER BY id").all());
  assert.deepEqual(typesOf(OWNER_C), []);
  process.env.REASON_WEB_DAILY = "on";
  assert.deepEqual(stamps.backfill(OWNER_C, { dryRun: true }), { first: 1, night_shift: 1 });
  assert.deepEqual(typesOf(OWNER_C), [], "a dry run writes nothing");
  assert.deepEqual(stamps.backfill(OWNER_C), { first: 1, night_shift: 1 });
  assert.deepEqual(stamps.backfill(OWNER_C), {});
  assert.equal(told.length, 0, "the backfill never tells anyone, even at on");
  assert.equal(JSON.stringify(db.db.prepare("SELECT * FROM tasks ORDER BY id").all()), tasksBefore, "tasks untouched");
  assert.deepEqual(db.db.prepare("SELECT DISTINCT source FROM stamps").all().map(r => r.source), ["backfill"]);
  // A live completion after the backfill: the first stays the first.
  doneTask(OWNER_C, { at: NIGHT + 86_400_000 * 2 - 12 * 3_600_000 });
  assert.equal(typesOf(OWNER_C).filter(t => t === "first").length, 1);
});

test("newestStamp: the newest within the window as a StampSummary, else null", () => {
  process.env.REASON_WEB_DAILY = "owner";
  assert.equal(stamps.newestStamp(OWNER_C), null);
  doneTask(OWNER_C, { at: DAY });
  setNow(DAY + 2 * 86_400_000);
  const s = stamps.newestStamp(OWNER_C);
  assert.deepEqual(Object.keys(s).filter(k => ["id", "type", "name", "detail", "story", "earnedAt", "shape", "ink", "rotation", "ariaLabel"].includes(k)).sort(),
    ["ariaLabel", "detail", "earnedAt", "id", "ink", "name", "rotation", "shape", "story", "type"]);
  assert.equal(s.type, "first");
  assert.equal(s.name, "First errand");
  assert.equal(s.ariaLabel, "Stamp: First errand");
  assert.ok(s.story.length > 20);
  setNow(DAY + 8 * 86_400_000);
  assert.equal(stamps.newestStamp(OWNER_C), null, "older than 7 days");
  assert.ok(stamps.newestStamp(OWNER_C, { days: 30 }));
  assert.equal(stamps.newestStamp(KOFI_C, { days: 30 }), null, "only its own conversation");
});

test("stampMarkup: CSS stamp, role=img with the full label, its tilt, three tiers, ink by type", () => {
  const s = { type: "long_hold", name: "The long hold", detail: "52 MIN", rotation: -8, ariaLabel: "Stamp: The long hold, 52 minutes" };
  const html = stamps.stampMarkup(s);
  assert.match(html, /role="img" aria-label="Stamp: The long hold, 52 minutes"/);
  assert.match(html, /rotate\(-8deg\)/);
  assert.match(html, /border:4px double var\(--pen,#9c3b2e\)/);
  assert.match(html, />THE<\/span><span[^>]*>LONG HOLD<\/span><span[^>]*>52 MIN</);
  assert.match(stamps.stampMarkup({ ...s, type: "night_shift", ariaLabel: "x" }), /outline:1px dashed var\(--ink,#2a2520\)/);
  assert.match(stamps.stampMarkup(s, { size: "sm" }), /width:100px;height:100px/);
  assert.equal(stamps.stampMarkup(null), "");
  assert.match(stamps.blankMarkup("whole_trip"), /dashed[\s\S]*>\?</);
});

test("on: a conversation with no account of its own (a group, an event thread) earns nothing and is told nothing", () => {
  process.env.REASON_WEB_DAILY = "on";
  doneTask("group:fake:abc");
  assert.deepEqual(typesOf("group:fake:abc"), []);
  assert.equal(told.length, 0);
});

test("on: a stamp earned in the small hours is kept but never mentioned before 7 AM on their clock", () => {
  process.env.REASON_WEB_DAILY = "on";
  doneTask(KOFI_C, { at: NIGHT });
  assert.deepEqual(typesOf(KOFI_C), ["first", "night_shift"]);
  assert.equal(told.length, 0, "no text at 3 AM");
});
