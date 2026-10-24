// The background loop paying for work it had already done. No model, no network.
//
// The audit on 2026-10-18 read the live box's sweep and found five ways it spent model turns, or
// lost work, for nothing:
//
//   do two passes run at once?                                     (no — the second is skipped)
//   does the status page see a pass that never finished?           (yes — it reads the end stamp)
//   is a watched page read and judged twice by overlapping passes? (no — the check is claimed first)
//   is the model asked about a page that has not changed?          (no — it is the same text)
//   is a held thing the model keeps passing on offered for ever?   (no — three times, then dropped)
//   is a turn started for held things nothing has changed about?   (no — skipped)
//   is the same renewal raised every morning of its lead window?   (no — once per renewal date)
//   is somebody with no Google offered a receipts scan?            (no — it needs their Gmail)
//   is the scan offer repeated daily while the list stays stale?   (no — once per stale stretch)
//   is a memory extraction lost to a restart mid-flight?           (no — it goes back in the queue)
//
// Each answer is one pinned test below.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-sweep-waste-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const notice = await import("../src/notice.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const C = "dm:sweep-waste";
const TZ = "America/New_York";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  // Ten in the morning where they are, so quiet hours never decide a test by accident.
  for (let i = 0; i < 48 && notice.localHour(clock.now(), TZ) !== 10; i++) clock.skip(HOUR);
  db.db.exec(`DELETE FROM timers; DELETE FROM watches; DELETE FROM notice_seen; DELETE FROM notice_budget;
    DELETE FROM notice_sweeps; DELETE FROM subscriptions; DELETE FROM oauth_tokens; DELETE FROM accounts;
    DELETE FROM usage; DELETE FROM extraction_queue;`);
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  config.noticeEveryMs = 2 * HOUR;
  config.noticeQuietStart = 22;
  config.noticeQuietEnd = 8;
});

/** A runtime whose turns are recorded instead of sent to a model. */
function harness({ reply = null, lookup, checkWatch, runTurn } = {}) {
  const turns = [];
  const logs = [];
  const rt = new Runtime({
    log: (e) => logs.push(e),
    runTurn: runTurn ?? (async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind });
      return typeof reply === "function" ? reply({ text, n: turns.length }) : reply;
    }),
    lookup: lookup ?? (async () => ({ ok: true, text: "nothing yet" })),
    checkWatch: checkWatch ?? (async () => ({ met: false, why: "not yet" })),
  });
  return { rt, turns, logs };
}

const setWatch = (input) => runTool("watch_set", input, { conversationId: C, messages: [] });

// ---------- one pass at a time ----------

test("a sweep that starts while the last one is still running is skipped, and says so", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const turns = [];
  const { rt, logs } = harness({ runTurn: async ({ text }) => { turns.push(text); await gate; return null; } });
  db.createTimer(C, { fireAt: clock.now() - MIN, note: "stretch" });

  const first = rt.sweep();
  await new Promise(r => setImmediate(r));
  assert.equal(turns.length, 1, "the first pass is mid-turn");

  const second = await rt.sweep();
  assert.deepEqual(second, { skipped: "a pass is still running" });
  assert.ok(logs.some(l => l.sweep === "skipped"), "the skip is logged");
  assert.equal(rt.lastSweepDoneAt, undefined, "nothing has finished yet, so nothing says it has");

  release();
  const done = await first;
  assert.equal(done.timers, 1);
  assert.equal(turns.length, 1, "the timer was run once, by the pass that got there");
  assert.equal(rt.lastSweepDoneAt, clock.now(), "a finished pass stamps when it finished");

  // And the guard lets go: the next pass runs.
  assert.notEqual((await rt.sweep()).skipped, "a pass is still running");
});

// ---------- watches ----------

test("two passes that reach the same due watch read and judge the page once, and tell them once", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let reads = 0;
  const { rt, turns } = harness({
    reply: "a table opened up",
    lookup: async () => { reads++; await gate; return { ok: true, text: "8:00 PM available" }; },
    checkWatch: async () => ({ met: true, why: "the page lists 8:00 PM" }),
  });
  await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table for 2", every_minutes: 30 });

  const first = rt.checkWatches();
  await new Promise(r => setImmediate(r));
  const second = await rt.checkWatches();
  assert.deepEqual(second, { checked: 0, met: 0, gave_up: 0 }, "the check was claimed before the page was read");

  release();
  assert.deepEqual(await first, { checked: 1, met: 1, gave_up: 0 });
  assert.equal(reads, 1, "one read of the page");
  assert.equal(turns.length, 1, "one text about it");
});

test("a page that reads exactly as it did last time is not put to the model again", async () => {
  const asked = [];
  const { rt } = harness({
    lookup: async () => ({ ok: true, text: "fully booked" }),
    checkWatch: async (arg) => { asked.push(arg); return { met: false, why: "still booked" }; },
  });
  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table for 2", every_minutes: 30 });

  await rt.checkWatches();
  clock.skip(31 * MIN);
  assert.deepEqual(await rt.checkWatches(), { checked: 1, met: 0, gave_up: 0 });
  assert.equal(asked.length, 1, "the second check cost no model call");
  assert.equal(db.getWatch(C, out.watch.id).checks, 2, "but it is still counted toward the ceiling");

  // A verdict that failed is not a verdict: the same text is judged again rather than waved through.
  db.db.exec(`UPDATE watches SET last_seen = NULL WHERE id = ${out.watch.id}`);
  const flaky = harness({
    lookup: async () => ({ ok: true, text: "fully booked" }),
    checkWatch: async (arg) => { asked.push(arg); return { met: false, why: "could not check", error: "timeout" }; },
  });
  clock.skip(31 * MIN);
  await flaky.rt.checkWatches();
  assert.equal(db.getWatch(C, out.watch.id).last_seen, null, "an errored check does not store the page as judged");
  clock.skip(31 * MIN);
  await flaky.rt.checkWatches();
  assert.equal(asked.length, 3, "so the next check asks again");
});

// ---------- held notices ----------

/** A bundle the way `notice.gather` returns one, with exactly the candidates given. */
const bundleOf = (...keys) => async () => ({
  ok: true, time_zone: TZ, context: [], accounts: [], failed: [],
  candidates: keys.map(k => ({ kind: "follow_on", key: k, what: `the ${k} thing finished` })),
});

test("a held thing the model has already passed on does not start a turn on its own", async () => {
  db.setNoticeWindow(C, { askedAt: clock.now(), answeredAt: clock.now() });
  const { rt, turns } = harness({ reply: null });

  const first = await rt.notice({ gatherWith: bundleOf("a") });
  assert.equal(first.turns, 1, "fresh, so the model is asked");
  assert.equal(db.getNotice(C, "a").offered, 1);

  clock.skip(config.noticeEveryMs + MIN);
  const second = await rt.notice({ gatherWith: bundleOf("a") });
  assert.equal(second.turns, 0, "the same held thing, nothing new: no turn");
  assert.deepEqual(second.skipped, [{ conversation: C, why: "nothing_new_since_last_turn" }]);
  assert.equal(turns.length, 1);
  assert.ok(db.heldNotices(C).some(r => r.key === "a"), "it is still held, so it can still ride on a reply");
});

test("a held thing put to the model three times and never said is dropped, not offered a fourth", async () => {
  db.setNoticeWindow(C, { askedAt: clock.now(), answeredAt: clock.now() });
  const { rt, turns } = harness({ reply: null });

  // Something fresh each round, so each round is a real turn with the old thing beside it.
  for (const fresh of ["a", "b", "c"]) {
    await rt.notice({ gatherWith: bundleOf(fresh) });
    clock.skip(config.noticeEveryMs + MIN);
  }
  assert.equal(turns.length, 3);
  assert.ok(db.getNotice(C, "a").dropped_at, "three turns passed on it, so it is let go");
  assert.ok(!db.heldNotices(C).some(r => r.key === "a"), "and it is not offered again");
  assert.ok(db.heldNotices(C).some(r => r.key === "b"), "the one seen twice is still held");
  assert.equal(db.getNotice(C, "c").offered, 1);
});

test("held in quiet hours is not the model passing on it, and never counts toward the three", async () => {
  db.setNoticeWindow(C, { askedAt: clock.now(), answeredAt: clock.now() });
  const { rt, turns } = harness({ reply: null });
  for (let i = 0; i < 48 && notice.localHour(clock.now(), TZ) !== 23; i++) clock.skip(HOUR);
  for (let night = 0; night < 4; night++) {
    await rt.notice({ gatherWith: bundleOf("a") });
    clock.skip(config.noticeEveryMs + MIN);
    for (let i = 0; i < 48 && notice.localHour(clock.now(), TZ) !== 23; i++) clock.skip(HOUR);
  }
  assert.equal(turns.length, 0, "nothing was put to the model at night");
  const row = db.getNotice(C, "a");
  assert.equal(row.offered, 0);
  assert.equal(row.dropped_at, null, "so it is still there for the morning");
});

// ---------- subscriptions ----------

test("a renewal is raised once, not on every morning of its lead window", async () => {
  db.setNoticeWindow(C, { askedAt: clock.now(), answeredAt: clock.now() });
  db.markSubscriptionScanned(C, clock.now());          // a fresh list, so only the renewal is in play
  const { rt, turns } = harness({ reply: null });
  const sub = db.recordSubscription(C, { merchant: "Netflix", amountCents: 1549, cadence: "monthly" }).subscription;
  db.setRenewalAt(C, sub.id, clock.now() + 2 * DAY + HOUR);

  assert.equal((await rt.subscriptionWatch()).turns, 1, "the first morning it is news");
  clock.skip(DAY);
  assert.equal((await rt.subscriptionWatch()).turns, 0, "the next morning it is the same renewal");
  clock.skip(DAY);
  assert.equal((await rt.subscriptionWatch()).turns, 0);
  assert.equal(turns.length, 1);
});

test("somebody with no Google connected is never offered a receipts scan", async () => {
  const { rt, turns } = harness({ reply: null });
  const out = await rt.subscriptionWatch();
  assert.equal(out.turns, 0);
  assert.deepEqual(out.skipped, [{ conversation: C, why: "no_google_for_a_scan" }]);
  assert.equal(turns.length, 0);
});

test("the scan offer is made once per stale stretch, not once a day", async () => {
  db.saveOauthTokens(C, "google", { accessToken: "ya29.x", refreshToken: "1//r", accountLabel: "me@example.com" });
  const { rt, turns } = harness({ reply: null });

  assert.equal((await rt.subscriptionWatch()).turns, 1, "never scanned: offered");
  clock.skip(DAY);
  assert.equal((await rt.subscriptionWatch()).turns, 0, "still never scanned: not offered again");

  // A scan starts a new stretch, and once that one goes stale it may be offered again.
  db.markSubscriptionScanned(C, clock.now());
  clock.skip((config.subscriptionScanStaleDays + 1) * DAY);
  assert.equal((await rt.subscriptionWatch()).turns, 1);
  assert.equal(turns.length, 2);
});

// ---------- extraction ----------

test("an extraction left mid-flight by a restart goes back in the queue at startup", () => {
  const ev = db.writeEvent({ conversationId: C, role: "user", content: "my sister is called Ama", at: clock.now() });
  db.enqueueExtraction(C, ev);
  assert.equal(db.claimExtractions({ limit: 5 }).length, 1);
  assert.equal(db.claimExtractions({ limit: 5 }).length, 0, "claimed, and the process stops here");

  const { rt, logs } = harness();
  rt.start(60 * 60_000);
  rt.stop();
  assert.equal(db.claimExtractions({ limit: 5 }).length, 1, "the new process picks it back up");
  assert.ok(logs.some(l => l.requeued_extractions === 1));
});
