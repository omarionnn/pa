// Goal-driven recurring offers, offline.
//
// The card is "i'm job searching" → "what kinds of jobs? i can set up a daily or weekly search for
// u" → criteria → one confirm → it runs. Whether the offer reads well is the model's half and is
// not a thing a test can assert. What is proved here is the half that is code's, and every one of
// these is a rule that has to hold for WEEKS, long after the turn that set it is out of the thread:
//
//   1. **A no is forever.** An offer they turned down is refused by the tool, not by a prompt —
//      not reworded, not a month later, and not because the model thought the moment was good. The
//      only way back is them asking, with their words.
//   2. **One offer, then it waits.** A second pitch with nothing said in between is refused.
//   3. **Ask only what is missing.** Criteria merge; an answer is never lost and never re-asked.
//   4. **Nothing runs unconfirmed.** Criteria, cadence and delivery all settled AND the criteria
//      agreed to, or `goal_start` refuses.
//   5. **A changed criterion needs a new yes.** A yes to the old wording was not a yes to this one.
//   6. **The same thing is never sent twice.** Dedup is a UNIQUE constraint, so an eighth firing
//      cannot resend what the first one sent.
//   7. **The looking is a series**, so pause, resume and stop are the machinery that already
//      exists, and stopping really stops the firings rather than only the row saying so.
//   8. **An export is a copy and a delete is a delete**, including both new tables.
//
// No model and no network. The goal is written down from a tool call, which is exactly what a turn
// does with it.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-goals-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const goals = await import("../src/goals.js");
const series = await import("../src/series.js");
const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { exportData, deleteData } = await import("../src/data.js");
const { sweepRetention } = await import("../src/privacy.js");
const { config, clock } = await import("../src/config.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OMARI = "dm:owner";

const call = (name, input, { conversationId = OMARI, kind = "user" } = {}) =>
  runTool(name, input, { conversationId, kind, messages: [] });

beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM goals; DELETE FROM goal_matches; DELETE FROM series; DELETE FROM timers;
    DELETE FROM action_ledger; DELETE FROM inbound_messages; DELETE FROM accounts; DELETE FROM conversations;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  config.maxGoals = 5;
  config.maxSeries = 10;
});
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Their message landing, which is what lifts the "one offer, then it waits" hold.
 *
 * Through the real claim path, because `lastInboundAt` is what that hold is read from and a test
 * that wrote the row its own way would be asserting against a column nothing else uses.
 */
let said = 0;
function theySaid(text) {
  assert.equal(db.claimInbound({ channel: "test", externalId: `in-${++said}`, conversationId: OMARI, text }), true);
}

/** A goal noticed, as a turn would write one down. */
async function noticed({ what = "job searching", said = "i'm job searching", help = "a daily search for roles" } = {}) {
  const r = await call("goal_note", { what, said, help });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

/** All the way to running, which several tests need as a starting point. */
async function running({ hour = 9 } = {}) {
  const note = await noticed();
  const id = note.goal.goal_id;
  await call("goal_offer", { goal_id: id, line: "what kinds of jobs? i can set up a daily or weekly search for u" });
  await call("goal_criteria", { goal_id: id, criteria: { role: "product", where: "nyc or remote", level: "mid" } });
  await call("goal_delivery", { goal_id: id, cadence: "daily", delivery: "only the ones that actually match" });
  await call("goal_criteria", { goal_id: id, criteria: { role: "product" }, confirmed: true });
  const started = await call("goal_start", { goal_id: id, repeat: { kind: "daily", hour, their_time: true } });
  assert.equal(started.ok, true, JSON.stringify(started));
  return { id, started };
}

// ---------- noticing one ----------

test("a goal is written down from their own words, and it says what is still unknown", async () => {
  const r = await noticed();
  assert.equal(r.goal.state, "noticed");
  assert.equal(r.goal.their_words, "i'm job searching");
  assert.equal(r.may_offer, true);
  assert.deepEqual(r.goal.still_missing.map(m => m.what), ["criteria", "cadence", "delivery"]);
  // Writing it down is not offering anything and nothing is running.
  assert.equal(r.goal.offers_made, 0);
  assert.equal(db.listSeries(OMARI).length, 0);
});

test("a goal is never invented: no verbatim sentence, no row", async () => {
  const r = await call("goal_note", { what: "job searching", said: "   " });
  assert.equal(r.ok, false);
  assert.match(r.error, /their own words/);
  assert.equal(db.listGoals(OMARI).length, 0, "nothing was written down");
});

test("the same goal mentioned again is the same row, and does not reset anything", async () => {
  const first = await noticed();
  await call("goal_criteria", { goal_id: first.goal.goal_id, criteria: { where: "brooklyn" } });
  const again = await call("goal_note", { what: "job searching", said: "still job searching tbh" });
  assert.equal(again.goal.goal_id, first.goal.goal_id);
  assert.equal(again.already_knew, true);
  assert.deepEqual(again.goal.criteria, { where: "brooklyn" }, "what they already told you survives");
  assert.equal(db.listGoals(OMARI).length, 1);
});

// ---------- the offer, and the no ----------

test("one offer, then it waits for them: a second pitch with nothing said in between is refused", async () => {
  const { goal } = await noticed();
  const first = await call("goal_offer", { goal_id: goal.goal_id, line: "what kinds of jobs? i can set a daily search up" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.goal.state, "offered");

  const second = await call("goal_offer", { goal_id: goal.goal_id, line: "want me to watch for jobs?" });
  assert.equal(second.ok, false);
  assert.equal(second.status, "not_now");
  assert.match(second.error, /have not said anything since/);
  assert.equal(db.goalById(OMARI, goal.goal_id).offers, 1, "the pitch was not spent twice");
});

test("once they have said anything at all, the subject is open again", async () => {
  const { goal } = await noticed();
  await call("goal_offer", { goal_id: goal.goal_id, line: "what kinds of jobs?" });
  clock.skip(2 * DAY);
  theySaid("hey what's the weather");
  const again = await call("goal_offer", { goal_id: goal.goal_id, line: "still want me to watch for product roles?" });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(db.goalById(OMARI, goal.goal_id).offers, 2);
});

test("a no is permanent: the offer is refused forever, in code, and a month does not soften it", async () => {
  const { goal } = await noticed();
  await call("goal_offer", { goal_id: goal.goal_id, line: "want a daily search?" });
  theySaid("nah i'm good, i'll just look myself");
  const no = await call("goal_declined", { goal_id: goal.goal_id, said: "nah i'm good, i'll just look myself" });
  assert.equal(no.ok, true, JSON.stringify(no));
  assert.equal(no.goal.state, "declined");
  assert.equal(no.goal.their_no, "nah i'm good, i'll just look myself");

  // A month later, and with them having said plenty since: still refused.
  clock.skip(31 * DAY);
  theySaid("any jobs about?");
  const again = await call("goal_offer", { goal_id: goal.goal_id, line: "want me to set that daily search up now?" });
  assert.equal(again.ok, false);
  assert.equal(again.status, "declined");
  assert.match(again.error, /never pitch it again/);
  // And nothing can start behind the offer either.
  const started = await call("goal_start", { goal_id: goal.goal_id, repeat: { kind: "daily", hour: 9 } });
  assert.equal(started.ok, false);
  assert.equal(started.status, "declined");
});

test("the only way back from a no is them asking, with their words", async () => {
  const { goal } = await noticed();
  await call("goal_declined", { goal_id: goal.goal_id, said: "don't worry about it" });

  const onItsOwn = await call("goal_reopen", { goal_id: goal.goal_id, said: "  " });
  assert.equal(onItsOwn.ok, false);
  assert.match(onItsOwn.error, /words THEY used/);
  assert.equal(db.goalById(OMARI, goal.goal_id).state, "declined");

  const asked = await call("goal_reopen", { goal_id: goal.goal_id, said: "actually can u do that daily search" });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.goal.state, "noticed");
  // Reopening is not a fresh start for the pitching: the count stands.
  assert.equal(asked.goal.offers_made, db.goalById(OMARI, goal.goal_id).offers);
});

test("the declined ones ride along on every turn, which is the only way the no can hold", async () => {
  const { goal } = await noticed();
  await call("goal_declined", { goal_id: goal.goal_id, said: "nah i'm good" });
  const note = goals.goalNote(OMARI);
  assert.match(note, /turned DOWN/);
  assert.match(note, /nah i'm good/);
  assert.match(note, /Never offer the standing version of any of those again/);
});

test("a declined offer is never offered by goal_list either: it says so out loud", async () => {
  const { goal } = await noticed();
  await call("goal_declined", { goal_id: goal.goal_id, said: "nah" });
  const list = await call("goal_list", {});
  assert.equal(list.goals.length, 1);
  assert.equal(list.goals[0].state, "declined");
  assert.match(list.declined_note, /never offered again/);
});

// ---------- ask only what is missing ----------

test("criteria merge: every answer adds, nothing is lost, and nothing is asked for twice", async () => {
  const { goal } = await noticed();
  const one = await call("goal_criteria", { goal_id: goal.goal_id, criteria: { role: "product", where: "nyc or remote" } });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.deepEqual(one.still_missing, ["cadence", "delivery"], "criteria is no longer missing");

  const two = await call("goal_criteria", { goal_id: goal.goal_id, criteria: { level: "mid" } });
  assert.deepEqual(two.goal.criteria, { role: "product", where: "nyc or remote", level: "mid" },
    "the city they gave first is still there");
  // Taken back explicitly, which is the only way a criterion goes.
  const three = await call("goal_criteria", { goal_id: goal.goal_id, criteria: { level: null } });
  assert.deepEqual(Object.keys(three.goal.criteria).sort(), ["role", "where"]);
});

test("changing a criterion clears their yes, because a yes to the old wording was not a yes to this", async () => {
  const { id } = await running();
  assert.equal(db.goalById(OMARI, id).criteria_confirmed_at > 0, true);
  const changed = await call("goal_criteria", { goal_id: id, criteria: { where: "anywhere remote" } });
  assert.equal(changed.changed, true);
  assert.equal(changed.goal.criteria_confirmed, false);
  assert.match(changed.note, /confirmation is cleared/);
  // Adding something NEW is not a change and does not clear it.
  await call("goal_criteria", { goal_id: id, criteria: { where: "anywhere remote" }, confirmed: true });
  const added = await call("goal_criteria", { goal_id: id, criteria: { pay: "150k+" } });
  assert.equal(added.changed, false);
  assert.equal(added.goal.criteria_confirmed, true);
});

// ---------- nothing runs unconfirmed ----------

test("goal_start refuses until all three are settled, naming which is short", async () => {
  const { goal } = await noticed();
  const nothing = await call("goal_start", { goal_id: goal.goal_id, repeat: { kind: "daily", hour: 9 } });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.status, "not_confirmed");
  // The cadence comes from `repeat`, so it is not what is missing — the other two are.
  assert.deepEqual(nothing.still_missing, ["criteria", "delivery"]);
  assert.equal(db.listSeries(OMARI).length, 0, "nothing was scheduled");

  await call("goal_criteria", { goal_id: goal.goal_id, criteria: { role: "product" } });
  await call("goal_delivery", { goal_id: goal.goal_id, delivery: "only the good ones" });
  const unconfirmed = await call("goal_start", { goal_id: goal.goal_id, repeat: { kind: "daily", hour: 9 } });
  assert.equal(unconfirmed.ok, false, "everything is known, but they never said yes to it");
  assert.equal(unconfirmed.status, "not_confirmed");
  assert.match(unconfirmed.error, /have not been confirmed/);
  assert.equal(db.listSeries(OMARI).length, 0);

  await call("goal_criteria", { goal_id: goal.goal_id, criteria: { role: "product" }, confirmed: true });
  const go = await call("goal_start", { goal_id: goal.goal_id, repeat: { kind: "daily", hour: 9, their_time: true } });
  assert.equal(go.ok, true, JSON.stringify(go));
});

test("starting it makes a real standing check-in, with a timer armed and the schedule in plain words", async () => {
  const { id, started } = await running({ hour: 9 });
  assert.match(started.schedule, /every day at 9am/);
  const row = db.goalById(OMARI, id);
  assert.ok(row.series_id, "a series is behind it");
  assert.equal(row.state, "running");
  assert.equal(row.cadence, started.schedule, "the cadence said back is the real schedule, not a paraphrase");
  const standing = db.seriesById(row.series_id);
  assert.equal(standing.state, "active");
  assert.ok(db.pendingSeriesTimer(standing.id), "the first firing is armed from the moment they are told");
  // And the goal is findable from the series, which is how a firing knows it is a search.
  assert.equal(db.goalBySeries(standing.id)?.id, id);
});

test("the cap is real, and it says to ask which to stop rather than starting another quietly", async () => {
  config.maxGoals = 1;
  await running();
  const second = await call("goal_note", { what: "finding an apartment", said: "also trying to find a place" });
  await call("goal_criteria", { goal_id: second.goal.goal_id, criteria: { beds: "1" }, confirmed: true });
  await call("goal_delivery", { goal_id: second.goal.goal_id, delivery: "a page once a week" });
  const blocked = await call("goal_start", { goal_id: second.goal.goal_id, repeat: { kind: "weekly", hour: 9, weekdays: ["monday"] } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, "too_many");
  assert.match(blocked.error, /ask which to stop/);
});

// ---------- the firing: what it found ----------

test("the same thing is never sent twice, however many firings later", async () => {
  const { id } = await running();
  const first = await call("goal_found", {
    goal_id: id,
    matches: [
      { key: "jobs.example/1", title: "PM at Acme", url: "https://jobs.example/1", source: "jobs.example" },
      { key: "jobs.example/2", title: "PM at Beta", url: "https://jobs.example/2", source: "jobs.example" },
    ],
  }, { kind: "event" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.fresh.length, 2);

  // Eight firings later, the first two come up again in the search results.
  clock.skip(8 * DAY);
  const second = await call("goal_found", {
    goal_id: id,
    matches: [
      { key: "jobs.example/1", title: "PM at Acme", url: "https://jobs.example/1", source: "jobs.example" },
      { key: "jobs.example/3", title: "PM at Gamma", url: "https://jobs.example/3", source: "jobs.example" },
    ],
  }, { kind: "event" });
  assert.equal(second.fresh.length, 1);
  assert.equal(second.fresh[0].key, "jobs.example/3");
  assert.equal(second.already_sent, 1);
  assert.deepEqual(second.skipped_as_seen, ["jobs.example/1"]);
});

test("nothing new is the ordinary answer, and the tool says to say nothing", async () => {
  const { id } = await running();
  const empty = await call("goal_found", { goal_id: id, matches: [] }, { kind: "event" });
  assert.equal(empty.ok, true);
  assert.equal(empty.nothing_new, true);
  assert.match(empty.say, /NO_REPLY/);

  await call("goal_found", { goal_id: id, matches: [{ key: "a", title: "A", source: "x.example" }] }, { kind: "event" });
  const allSeen = await call("goal_found", { goal_id: id, matches: [{ key: "a", title: "A", source: "x.example" }] }, { kind: "event" });
  assert.equal(allSeen.nothing_new, true);
  assert.match(allSeen.say, /never send the same listing twice/);
});

test("a match with no source is refused, because nobody could check it", async () => {
  const { id } = await running();
  const r = await call("goal_found", { goal_id: id, matches: [{ key: "a", title: "A", source: "   " }] }, { kind: "event" });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs a `source`/);
});

test("nothing goes over for a goal that is not running", async () => {
  const { id } = await running();
  await call("goal_state", { goal_id: id, state: "dropped", why: "stop sending me jobs" });
  const r = await call("goal_found", { goal_id: id, matches: [{ key: "a", source: "x.example" }] }, { kind: "event" });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing is being looked for/);
});

test("a firing hands over the confirmed criteria and everything already sent", async () => {
  const { id } = await running();
  await call("goal_found", { goal_id: id, matches: [{ key: "jobs.example/1", title: "PM at Acme", source: "jobs.example" }] }, { kind: "event" });
  const frame = goals.checkFrame(db.goalById(OMARI, id));
  assert.match(frame, /job searching/);
  assert.match(frame, /"role":"product"/);
  assert.match(frame, /PM at Acme/);
  assert.match(frame, /Never any of those again/);
  assert.match(frame, /goal_found/);
  assert.match(frame, /NO_REPLY/);
});

// ---------- pause, resume, stop ----------

test("pausing really stops the firings; resuming arms the next one, never the ones it missed", async () => {
  const { id } = await running();
  const seriesId = db.goalById(OMARI, id).series_id;

  const paused = await call("goal_state", { goal_id: id, state: "paused" });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.equal(db.goalById(OMARI, id).state, "paused");
  assert.equal(db.seriesById(seriesId).state, "paused");
  assert.ok(!db.pendingSeriesTimer(seriesId), "nothing is left armed");

  // A fortnight passes while it is paused. Coming back does not fire fourteen mornings.
  clock.skip(14 * DAY);
  const back = await call("goal_state", { goal_id: id, state: "running" });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(db.seriesById(seriesId).state, "active");
  const armed = db.pendingSeriesTimer(seriesId);
  assert.ok(armed, "one firing is armed");
  assert.ok(armed.fire_at > clock.now(), "and it is in the future, not a backlog");
});

test("they got the job: the search ends, nothing comes round again, and what it sent stays answerable", async () => {
  const { id } = await running();
  const seriesId = db.goalById(OMARI, id).series_id;
  await call("goal_found", { goal_id: id, matches: [{ key: "jobs.example/1", title: "PM at Acme", source: "jobs.example" }] }, { kind: "event" });

  const done = await call("goal_state", { goal_id: id, state: "done", why: "i got the job" });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(db.goalById(OMARI, id).state, "done");
  assert.equal(db.seriesById(seriesId).state, "ended");
  assert.ok(!db.pendingSeriesTimer(seriesId), "nothing is armed");
  assert.equal(db.goalById(OMARI, id).series_id, null, "and nothing still points at it as resumable");
  // What was found stays written down: "what did you send me" has to still have an answer.
  assert.equal(db.countGoalMatches(id).sent, 1);
  assert.equal(done.goal.told_them_about, 1);
});

test("a declined offer stops any search behind it too", async () => {
  const { id } = await running();
  const seriesId = db.goalById(OMARI, id).series_id;
  const no = await call("goal_declined", { goal_id: id, said: "stop sending me these" });
  assert.equal(no.stopped_the_search, true);
  assert.equal(db.seriesById(seriesId).state, "ended");
});

test("more than one running and a bare stop does not say which", async () => {
  await running();
  const second = await call("goal_note", { what: "finding an apartment", said: "trying to find a place too" });
  await call("goal_criteria", { goal_id: second.goal.goal_id, criteria: { beds: "1" }, confirmed: true });
  await call("goal_delivery", { goal_id: second.goal.goal_id, delivery: "a page once a week" });
  await call("goal_start", { goal_id: second.goal.goal_id, repeat: { kind: "weekly", hour: 9, weekdays: ["monday"], their_time: true } });
  const list = await call("goal_list", {});
  assert.equal(list.goals.filter(g => g.state === "running").length, 2);
  assert.match(list.note, /does not say which/);
});

// ---------- the record, the note, and the data ----------

test("every one of these leaves a receipt, because none of it is reconstructable from a reply", async () => {
  const { id } = await running();
  await call("goal_found", { goal_id: id, matches: [{ key: "jobs.example/1", source: "jobs.example" }] }, { kind: "event" });
  await call("goal_state", { goal_id: id, state: "done", why: "i got the job" });
  const actions = db.listActions(OMARI, { limit: 50 }).map(r => r.action);
  for (const a of ["goal_note", "goal_offer", "goal_start", "goal_found", "goal_state"]) {
    assert.ok(actions.includes(a), `${a} is on the record (got ${actions.join(", ")})`);
  }
});

test("the turn note carries what is still missing and never recites what they already said", async () => {
  const { goal } = await noticed();
  await call("goal_criteria", { goal_id: goal.goal_id, criteria: { role: "product" } });
  const note = goals.goalNote(OMARI);
  assert.match(note, /job searching/);
  assert.match(note, /still_missing/);
  assert.match(note, /anything already in criteria is never asked for again/);
  // With nothing of theirs at all, there is no note to carry.
  db.db.exec("DELETE FROM goals");
  assert.equal(goals.goalNote(OMARI), "");
});

test("an export is a copy and a delete is a delete, for both new tables", async () => {
  const { id } = await running();
  await call("goal_found", { goal_id: id, matches: [{ key: "jobs.example/1", title: "PM at Acme", source: "jobs.example" }] }, { kind: "event" });

  const copy = exportData({ conversation: OMARI, audio: false, files: false });
  assert.equal(copy.tables.goals.length, 1);
  assert.equal(copy.tables.goals[0].said, "i'm job searching");
  assert.equal(copy.tables.goal_matches.length, 1);
  assert.equal(copy.tables.goal_matches[0].title, "PM at Acme");

  await deleteData({ conversation: OMARI });
  assert.equal(db.listGoals(OMARI).length, 0);
  assert.equal(db.countGoalMatches(id).found, 0);
});

test("retention drops the listings' words and keeps the row, so nothing is ever sent twice", async () => {
  const { id } = await running();
  await call("goal_found", { goal_id: id, matches: [{ key: "jobs.example/1", title: "PM at Acme", url: "https://jobs.example/1", source: "jobs.example" }] }, { kind: "event" });

  clock.skip(400 * DAY);
  sweepRetention({ now: clock.now(), contentDays: 30, recordDays: 3650 });
  const kept = db.goalMatches(id, { limit: 5 });
  assert.equal(kept.length, 1, "the row survives, which is what stops a repeat");
  assert.equal(kept[0].title, "", "but the listing's own words are gone");
  assert.equal(kept[0].match_key, "jobs.example/1");
  // And a goal still running is never swept away, however old.
  assert.equal(db.goalById(OMARI, id)?.state, "running");
});

test("a declined goal is never swept away either, because the no is the thing that has to hold", async () => {
  const { goal } = await noticed();
  await call("goal_declined", { goal_id: goal.goal_id, said: "nah i'm good" });
  clock.skip(5 * 365 * DAY);
  sweepRetention({ now: clock.now(), contentDays: 30, recordDays: 365 });
  const row = db.goalById(OMARI, goal.goal_id);
  assert.ok(row, "still there five years on");
  assert.equal(row.state, "declined");
});

// ---------- the schedule itself is the series' job, not this file's ----------

test("an hour nobody named is pulled out of their night, and one they named is honoured", async () => {
  const { id } = await running({ hour: 7 });
  const armed = db.pendingSeriesTimer(db.goalById(OMARI, id).series_id);
  const standing = db.seriesById(db.goalById(OMARI, id).series_id);
  assert.equal(series.partsIn(armed.fire_at, standing.tz).hour, 7, "they said 7, so it is 7");

  // One Reason picked, in the middle of their night: moved to 8, like any other series.
  const other = await call("goal_note", { what: "finding a car", said: "looking for a used car" });
  await call("goal_criteria", { goal_id: other.goal.goal_id, criteria: { kind: "estate" }, confirmed: true });
  await call("goal_delivery", { goal_id: other.goal.goal_id, delivery: "only good ones" });
  const go = await call("goal_start", { goal_id: other.goal.goal_id, repeat: { kind: "daily", hour: 3, their_time: false } });
  assert.equal(go.ok, true, JSON.stringify(go));
  const row = db.seriesById(db.goalById(OMARI, other.goal.goal_id).series_id);
  const fire = db.pendingSeriesTimer(row.id);
  assert.equal(series.partsIn(fire.fire_at, row.tz).hour, 8, "nobody asked to be woken at three");
});
