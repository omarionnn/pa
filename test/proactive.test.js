// Everything Reason does unprompted, without the model: timers firing, watches re-checking,
// dropped threads getting picked back up, and the rate limit that stops it nagging.
// The turn runner, the page fetch and the watch check are all injected, so what is tested here
// is the schedule and the bookkeeping — which is exactly the part code is responsible for.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-proactive-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_NUDGE_MAX_PER_DAY = "2";
process.env.REASON_NUDGE_GAP_MIN = "1200";   // 20h
process.env.REASON_FOLLOWUP_IDLE_MIN = "180"; // 3h

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const C = "dm:proactive";

// Every conversation belongs to somebody now, and the router is what creates that account in
// production. A test that drives the tools directly sets one up the same way.
for (const [id, addr] of [[C, "+12025551234"]]) db.upsertAccount({ conversationId: id, channel: "test", address: addr, name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM plans; DELETE FROM timers; DELETE FROM watches; DELETE FROM nudges; DELETE FROM conversations; DELETE FROM action_ledger;");
});

/** A runtime whose turns are recorded instead of sent to a model. `reply` is what it "says". */
function harness({ reply = "sent something", lookup, checkWatch } = {}) {
  const turns = [];
  const outbound = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind });
      return typeof reply === "function" ? reply({ text, n: turns.length }) : reply;
    },
    lookup: lookup ?? (async () => ({ ok: true, text: "nothing yet", title: "t", url: "u" })),
    checkWatch: checkWatch ?? (async () => ({ met: false, why: "unchanged" })),
  });
  return { rt, turns, outbound };
}

/** A conversation and a plan that both last moved `agoMs` ago, in the status asked for. */
function stalePlan({ openQuestions = ["what time works"], agoMs = 4 * HOUR, status = "planning" } = {}) {
  // Locking refuses a plan with open questions, so build the status through the real transitions
  // with none, then put the questions back by hand. That way these tests prove the status is what
  // takes a plan out of scope, not an empty question list.
  const plan = db.createPlan(C, {
    title: "Dinner at Carbone", kind: "dinner",
    open_questions: status === "planning" || status === "cancelled" ? openQuestions : [],
  });
  if (status === "cancelled") db.setPlanStatus(C, plan.id, "cancelled");
  if (status === "locked" || status === "done") {
    db.setPlanStatus(C, plan.id, "locked");
    if (status === "done") db.setPlanStatus(C, plan.id, "done");
  }
  if (status !== "planning" && openQuestions.length) {
    const data = JSON.parse(db.db.prepare("SELECT data FROM plans WHERE id = ?").get(plan.id).data);
    data.open_questions = openQuestions;
    db.db.prepare("UPDATE plans SET data = ? WHERE id = ?").run(JSON.stringify(data), plan.id);
  }
  db.saveConversation(C, [{ role: "user", content: "dinner sometime?" }]);
  const then = clock.now() - agoMs;
  db.db.exec(`UPDATE plans SET updated_at = ${then} WHERE id = ${plan.id}`);
  db.db.exec(`UPDATE conversations SET updated_at = ${then} WHERE id = '${C}'`);
  return plan;
}

// ---------- timers: the day-of reminder and the morning after ----------

test("a day-of reminder fires once, as a message, and never again", async () => {
  const { rt, turns } = harness();
  const plan = db.createPlan(C, { title: "Dinner at Carbone", when: "Fri Oct 9, 8:00 PM" });
  db.setPlanStatus(C, plan.id, "locked");
  const timer = db.createTimer(C, { fireAt: clock.now() + 6 * HOUR, note: "day-of reminder: Carbone 8pm", planId: plan.id });

  assert.equal(await rt.tick(), 0, "nothing is due yet");
  assert.equal(turns.length, 0, "and nothing was said");

  clock.skip(6 * HOUR + MIN);
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  assert.equal(await rt.tick(), 1, "it is due now");

  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, "event", "it arrives as an event turn, not as the owner talking");
  assert.match(turns[0].text, /day-of reminder: Carbone 8pm/, "the note is in the event");
  assert.match(turns[0].text, /Dinner at Carbone/, "and the plan as it stands now");
  assert.equal(sent.length, 1, "it actually went out");
  assert.equal(sent[0].fromTimer, timer.id);

  // Fired is fired.
  clock.skip(HOUR);
  assert.equal(await rt.tick(), 0);
  assert.equal(turns.length, 1, "a fired timer does not fire twice");
  assert.ok(db.getTimer(C, timer.id).fired_at);
});

test("a morning-after check-in is its own timer and fires on its own", async () => {
  const { rt, turns } = harness();
  const plan = db.createPlan(C, { title: "Dinner at Carbone", when: "Fri Oct 9, 8:00 PM" });
  db.setPlanStatus(C, plan.id, "locked");
  const dayOf = db.createTimer(C, { fireAt: clock.now() + 6 * HOUR, note: "day-of reminder", planId: plan.id });
  const after = db.createTimer(C, { fireAt: clock.now() + 20 * HOUR, note: "how was carbone?", planId: plan.id });

  clock.skip(6 * HOUR + MIN);
  await rt.tick();
  assert.equal(turns.length, 1, "only the day-of one so far");
  assert.ok(db.getTimer(C, after.id).fired_at === null, "the morning-after is still pending");

  clock.skip(14 * HOUR);
  await rt.tick();
  assert.equal(turns.length, 2);
  assert.match(turns[1].text, /how was carbone\?/);
  assert.ok(db.getTimer(C, dayOf.id).fired_at && db.getTimer(C, after.id).fired_at, "both spent");
});

test("silence on an event turn sends nothing", async () => {
  const { rt, turns } = harness({ reply: null });
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  db.createTimer(C, { fireAt: clock.now() - MIN, note: "probably not worth a message" });
  await rt.tick();
  assert.equal(turns.length, 1, "it was asked");
  assert.equal(sent.length, 0, "and it chose to say nothing");
});

test("a cancelled timer never fires", async () => {
  const { rt, turns } = harness();
  const t = db.createTimer(C, { fireAt: clock.now() + MIN, note: "nope" });
  db.cancelTimer(C, t.id);
  clock.skip(10 * MIN);
  assert.equal(await rt.tick(), 0);
  assert.equal(turns.length, 0);
});

// ---------- dropped threads ----------

test("a thread with something open and hours of silence gets picked back up", async () => {
  const { rt, turns } = harness();
  const plan = stalePlan({ openQuestions: ["what time works"], agoMs: 4 * HOUR });
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));

  const out = await rt.followUp();
  assert.equal(out.candidates, 1);
  assert.equal(out.asked, 1);
  assert.equal(out.sent, 1);
  assert.equal(turns[0].kind, "event");
  assert.match(turns[0].text, /what time works/, "the event names the open question");
  assert.match(turns[0].text, /NO_REPLY/, "and leaves it free to say nothing");
  assert.equal(sent[0].fromFollowUp, plan.id);
  assert.equal(db.listNudges(C).length, 1);
  assert.ok(db.listNudges(C)[0].sent_at, "a sent nudge is recorded as sent");
});

test("a thread that is still warm is left alone", async () => {
  const { rt, turns } = harness();
  stalePlan({ agoMs: 30 * MIN });
  const out = await rt.followUp();
  assert.equal(out.candidates, 0, "30 minutes is not a dropped thread");
  assert.equal(turns.length, 0);
});

test("nothing open means nothing to chase", async () => {
  const { rt, turns } = harness();
  stalePlan({ openQuestions: [], agoMs: 10 * HOUR });
  assert.equal((await rt.followUp()).candidates, 0);
  assert.equal(turns.length, 0);
});

for (const status of ["locked", "cancelled", "done"]) {
  test(`a ${status} plan is never chased`, async () => {
    const { rt, turns } = harness();
    stalePlan({ openQuestions: ["what time works"], agoMs: 10 * HOUR, status });
    assert.equal((await rt.followUp()).candidates, 0);
    assert.equal(turns.length, 0);
  });
}

// ---------- the rate limit ----------

test("the same plan is not raised twice inside the gap", async () => {
  const { rt, turns } = harness();
  const plan = stalePlan({ agoMs: 4 * HOUR });
  assert.equal((await rt.followUp()).sent, 1);

  // Still stale, still open, but it was just raised.
  clock.skip(2 * HOUR);
  db.db.exec(`UPDATE conversations SET updated_at = ${clock.now() - 6 * HOUR} WHERE id = '${C}'`);
  const second = await rt.followUp();
  assert.equal(second.candidates, 1, "it is still a candidate");
  assert.equal(second.asked, 0, "but it was not asked about again");
  assert.deepEqual(second.skipped, [{ plan_id: plan.id, reason: "too_soon_for_this_plan" }]);
  assert.equal(turns.length, 1, "no second model call was spent");

  // Once the gap has passed it may be raised again.
  clock.skip(20 * HOUR);
  db.db.exec(`UPDATE conversations SET updated_at = ${clock.now() - 6 * HOUR} WHERE id = '${C}'`);
  db.db.exec(`UPDATE plans SET updated_at = ${clock.now() - 6 * HOUR} WHERE id = ${plan.id}`);
  assert.equal((await rt.followUp()).asked, 1);
});

test("the daily cap holds across plans, and across a restart", async () => {
  const { rt, turns } = harness();
  const ago = clock.now() - 5 * HOUR;
  const plans = [1, 2, 3].map(n => db.createPlan(C, { title: `Plan ${n}`, open_questions: ["when"] }));
  db.saveConversation(C, [{ role: "user", content: "a few things" }]);
  db.db.exec(`UPDATE plans SET updated_at = ${ago}; UPDATE conversations SET updated_at = ${ago} WHERE id = '${C}'`);

  const out = await rt.followUp();
  assert.equal(out.candidates, 3, "all three are dropped");
  assert.equal(out.sent, 2, "but only two messages went out");
  assert.deepEqual(out.skipped, [{ plan_id: plans[2].id, reason: "daily_cap" }]);
  assert.equal(turns.length, 2, "the capped one cost no model call");

  // A brand new Runtime shares the table, so the cap is not reset by restarting.
  const fresh = harness();
  db.db.exec(`UPDATE plans SET updated_at = ${clock.now() - 5 * HOUR}; UPDATE conversations SET updated_at = ${clock.now() - 5 * HOUR} WHERE id = '${C}'`);
  const again = await fresh.rt.followUp();
  assert.equal(again.asked, 0, "the limit lives in the database, not in the process");
  assert.ok(again.skipped.every(s => ["daily_cap", "too_soon_for_this_plan"].includes(s.reason)));
  assert.equal(fresh.turns.length, 0);

  // And it is a rolling 24h, not a counter that never clears.
  clock.skip(25 * HOUR);
  db.db.exec(`UPDATE plans SET updated_at = ${clock.now() - 5 * HOUR}; UPDATE conversations SET updated_at = ${clock.now() - 5 * HOUR} WHERE id = '${C}'`);
  assert.ok((await harness().rt.followUp()).asked > 0, "a day later it may speak again");
});

test("choosing to stay quiet does not spend the daily cap", async () => {
  const { rt } = harness({ reply: null });
  const ago = clock.now() - 5 * HOUR;
  [1, 2, 3].map(n => db.createPlan(C, { title: `Plan ${n}`, open_questions: ["when"] }));
  db.saveConversation(C, [{ role: "user", content: "stuff" }]);
  db.db.exec(`UPDATE plans SET updated_at = ${ago}; UPDATE conversations SET updated_at = ${ago} WHERE id = '${C}'`);

  const out = await rt.followUp();
  assert.equal(out.asked, 3, "all three were considered, because nothing was sent");
  assert.equal(out.sent, 0);
  assert.equal(db.listNudges(C).filter(n => n.sent_at).length, 0, "no nudge counts as sent");
});

// ---------- watches ----------

const setWatch = (input) => runTool("watch_set", input, { conversationId: C, messages: [] });

test("watch_set refuses what it cannot read, and floors the interval", async () => {
  assert.equal((await setWatch({ url: "carbone", looking_for: "a table" })).ok, false);
  assert.equal((await setWatch({ url: "file:///etc/passwd", looking_for: "a table" })).ok, false);

  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table for 2", every_minutes: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.watch.every_minutes, config.watchMinEveryMin, "a 1-minute watcher is floored");
  assert.match(out.note, /floor/);
  assert.equal(out.watch.status, "watching");
  assert.equal(out.watch.checks, 0);
});

test("a watch is re-checked on its schedule, not every tick", async () => {
  let reads = 0;
  const { rt } = harness({ lookup: async () => { reads++; return { ok: true, text: `read ${reads}` }; } });
  await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table for 2", every_minutes: 30 });

  assert.deepEqual(await rt.checkWatches(), { checked: 1, met: 0, gave_up: 0 }, "first check happens right away");
  assert.deepEqual(await rt.checkWatches(), { checked: 0, met: 0, gave_up: 0 }, "not due again yet");
  clock.skip(31 * MIN);
  assert.equal((await rt.checkWatches()).checked, 1, "due again after the interval");
  assert.equal(reads, 2);
});

test("a watch fires once when the condition is met, and stops", async () => {
  const seen = [];
  const { rt, turns } = harness({
    lookup: async () => ({ ok: true, text: "8:00 PM available" }),
    checkWatch: async (arg) => { seen.push(arg); return { met: true, why: "the page lists 8:00 PM" }; },
  });
  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table for 2 around 8", note: "dinner friday", every_minutes: 30 });
  const id = out.watch.id;
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));

  assert.deepEqual(await rt.checkWatches(), { checked: 1, met: 1, gave_up: 0 });
  assert.deepEqual(seen[0], { lookingFor: "a table for 2 around 8", text: "8:00 PM available", previousText: null },
    "the checker gets what they want, the page, and what it said last time");

  const w = db.getWatch(C, id);
  assert.ok(w.met_at, "recorded as met");
  assert.equal(w.met_why, "the page lists 8:00 PM");
  assert.equal(sent.length, 1, "they were told");
  assert.equal(sent[0].fromWatch, id);
  assert.match(turns[0].text, /8:00 PM available/, "the event carries what the page actually said");
  assert.match(turns[0].text, /dinner friday/, "and why they wanted it");

  // It is done. It is not checked again, ever.
  clock.skip(10 * HOUR);
  assert.deepEqual(await rt.checkWatches(), { checked: 0, met: 0, gave_up: 0 });
  assert.equal(turns.length, 1, "and it does not tell them twice");
});

test("a watch that cannot read the page is not met, and keeps trying", async () => {
  const checks = [];
  const { rt, turns } = harness({
    lookup: async () => ({ ok: false, error: "503 from the site" }),
    checkWatch: async () => { checks.push(1); return { met: true, why: "should never be asked" }; },
  });
  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table", every_minutes: 30 });

  assert.deepEqual(await rt.checkWatches(), { checked: 1, met: 0, gave_up: 0 });
  assert.equal(checks.length, 0, "an unreadable page is never handed to the checker");
  assert.equal(db.getWatch(C, out.watch.id).met_at, null, "and nothing is claimed");
  assert.equal(turns.length, 0, "nobody is bothered about a failed read");
  assert.equal(db.getWatch(C, out.watch.id).checks, 1, "but the attempt is counted");
});

test("a lookup that throws is survived, not propagated", async () => {
  const { rt } = harness({ lookup: async () => { throw new Error("socket hang up"); } });
  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table" });
  assert.deepEqual(await rt.checkWatches(), { checked: 1, met: 0, gave_up: 0 });
  assert.equal(db.getWatch(C, out.watch.id).met_at, null);
});

test("an unsure checker never fires the watch", async () => {
  const { rt, turns } = harness({
    lookup: async () => ({ ok: true, text: "please sign in" }),
    checkWatch: async () => ({ met: false, why: "a sign-in wall", error: "timeout" }),
  });
  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table" });
  await rt.checkWatches();
  assert.equal(db.getWatch(C, out.watch.id).met_at, null);
  assert.equal(turns.length, 0);
});

test("the page is remembered between checks, so a change can be seen", async () => {
  let n = 0;
  const seen = [];
  const { rt } = harness({
    lookup: async () => ({ ok: true, text: `state ${++n}` }),
    checkWatch: async (arg) => { seen.push(arg.previousText); return { met: false, why: "no" }; },
  });
  await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a change", every_minutes: 30 });
  await rt.checkWatches();
  clock.skip(31 * MIN);
  await rt.checkWatches();
  assert.deepEqual(seen, [null, "state 1"], "the second check knows what the first one saw");
});

test("watch_cancel stops it, and says so honestly the second time", async () => {
  const { rt } = harness({ checkWatch: async () => ({ met: true, why: "would have fired" }) });
  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table" });
  const id = out.watch.id;

  const off = await runTool("watch_cancel", { watch_id: id }, { conversationId: C, messages: [] });
  assert.equal(off.ok, true);
  assert.equal(off.watch.status, "called_off");

  assert.deepEqual(await rt.checkWatches(), { checked: 0, met: 0, gave_up: 0 }, "a cancelled watch is not checked");
  const twice = await runTool("watch_cancel", { watch_id: id }, { conversationId: C, messages: [] });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /already called off/);
  assert.equal((await runTool("watch_cancel", { watch_id: 9999 }, { conversationId: C, messages: [] })).ok, false);
});

test("watch_list tells the truth about what is running", async () => {
  const ctx = { conversationId: C, messages: [] };
  const empty = await runTool("watch_list", {}, ctx);
  assert.equal(empty.count, 0);
  assert.match(empty.note, /you did not actually set it up/);

  const a = await setWatch({ url: "http://127.0.0.1:9/a", looking_for: "a table" });
  await setWatch({ url: "http://127.0.0.1:9/b", looking_for: "a price drop" });
  assert.equal((await runTool("watch_list", {}, ctx)).count, 2);

  await runTool("watch_cancel", { watch_id: a.watch.id }, ctx);
  assert.equal((await runTool("watch_list", {}, ctx)).count, 1, "a called-off watch is not running");
  assert.equal((await runTool("watch_list", { include_closed: true }, ctx)).count, 2);
});

test("a watch gives up after the ceiling instead of running forever", async () => {
  const { rt, turns } = harness();
  const out = await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table", every_minutes: 30 });
  // config is read at module load, so drive it to the real ceiling instead of faking one.
  db.db.exec(`UPDATE watches SET checks = ${config.watchMaxChecks - 1} WHERE id = ${out.watch.id}`);

  const r = await rt.checkWatches();
  assert.equal(r.checked, 1);
  assert.equal(r.gave_up, 1, "it stops rather than checking forever");
  assert.ok(db.getWatch(C, out.watch.id).gave_up_at);
  assert.match(turns.at(-1).text, /has stopped|stopped watching/i, "and it says so");

  clock.skip(10 * HOUR);
  assert.equal((await rt.checkWatches()).checked, 0, "a watch that gave up is not checked again");
});

// ---------- the whole pass ----------

test("one sweep does timers, watches and dropped threads together", async () => {
  const { rt, turns } = harness({ checkWatch: async () => ({ met: true, why: "found" }) });
  db.createTimer(C, { fireAt: clock.now() - MIN, note: "day-of" });
  await setWatch({ url: "http://127.0.0.1:9/x", looking_for: "a table" });
  stalePlan({ agoMs: 5 * HOUR });

  const out = await rt.sweep();
  assert.equal(out.timers, 1);
  assert.equal(out.watches.met, 1);
  assert.equal(out.follow.sent, 1);
  assert.equal(turns.length, 3, "three separate event turns, one per thing that happened");
  assert.ok(turns.every(t => t.kind === "event"));
});
