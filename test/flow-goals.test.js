// Goal-driven recurring offers, walked end to end against the real model.
//
// test/goals.test.js proves the plumbing: the states, the dedup, the confirm gate, the cap. What it
// cannot prove is the part that was actually asked for, because all of it is the model's reading:
//
//   - "i'm job searching" — said in passing, with nothing asked — is NOTICED as a goal rather than
//     answered once and forgotten.
//   - the offer and the one missing question arrive in the same breath, in one line.
//   - what he already said is USED: somebody who said "product roles, nyc or remote, mid-level" is
//     not asked about the city again.
//   - nothing starts until he says yes, and then the schedule is said back once.
//   - a firing actually goes and looks, and only what he has never seen goes over.
//   - "nah i'm good" ends the pitching for good, and a month of other conversation does not bring
//     it back.
//
// Asserts on facts rather than wording — which rows exist, which state they are in, which words
// the line contains — never on phrasing. Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-goals.test.js
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-goals-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = process.env.REASON_PUBLIC_URL || "https://reason.example.test";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const goals = await import("../src/goals.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM goals; DELETE FROM goal_matches; DELETE FROM series; DELETE FROM timers;"
    + " DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;"
    + " DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function harness() {
  const rt = new Runtime();
  const router = new Router();
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async (m) => { await deliver({ ...m, media: null }); });

  async function says(text) {
    const handle = `in-${clock.now()}-${Math.random().toString(36).slice(2, 7)}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const before = fake.sent.length;
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return { reply, said: fake.sent.slice(before).map(m => m.text).join("\n") };
  }
  /** Move the clock to the next firing and run one sweep, the way the live server would. */
  async function reachNextFiring() {
    const next = db.listTimers(C)[0];
    assert.ok(next, "nothing was armed, so nothing can fire");
    const before = fake.sent.length;
    clock.skip(Math.max(0, next.fire_at - clock.now()) + HOUR);
    await rt.sweep();
    return fake.sent.slice(before).map(m => m.text).join("\n");
  }
  return { rt, says, fake, reachNextFiring };
}

test(`"i'm job searching" becomes a goal with an offer, and nothing runs until he says yes (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    clock.skip(Date.parse("2026-10-07T18:00:00Z") - clock.now());

    // Said in passing, nothing asked. The failure this test exists against is answering it once
    // and forgetting, which is what every assistant already does.
    const first = await says("ngl this week has been rough. i'm job searching now");
    assert.ok(first.said.length > 0, "it answered");
    const rows = db.listGoals(C);
    assert.equal(rows.length, 1, `it did not write the goal down: ${JSON.stringify(first.said)}`);
    const id = rows[0].id;
    assert.match(rows[0].what, /job|work|role/i, `the goal is not about the job search: ${rows[0].what}`);
    assert.match(rows[0].said, /job searching/i, "his own words are on the row");

    // The offer, in one line, with the one thing it still needs in the same breath.
    assert.equal(rows[0].offers, 1, `it never offered the standing help: ${JSON.stringify(first.said)}`);
    assert.match(first.said, /search|look|keep an eye|daily|weekly|every/i,
      `the offer does not mention keeping it going: ${JSON.stringify(first.said)}`);
    assert.match(first.said, /\?/, `it offered without asking what counts as a match: ${JSON.stringify(first.said)}`);
    // Nothing has started: an offer is not a yes.
    assert.equal(db.listSeries(C).length, 0, "nothing was scheduled off an offer nobody answered");
    assert.equal(rows[0].state, "offered");

    // He answers with three things at once. All three have to land, and none of them may be
    // asked about again.
    clock.skip(2 * 60_000);
    const answered = await says("product roles, nyc or remote, mid-level. daily is fine, only ones that actually match");
    const criteria = goals.criteriaOf(db.goalById(C, id));
    const asJson = JSON.stringify(criteria).toLowerCase();
    assert.ok(Object.keys(criteria).length >= 2, `it kept almost none of what he said: ${asJson}`);
    assert.match(asJson, /product/, `the role is not written down: ${asJson}`);
    assert.match(asJson, /nyc|remote|new york/, `the place is not written down: ${asJson}`);
    // And it must not ask about any of it again.
    assert.doesNotMatch(answered.said, /\bwhat (city|area|kind of (role|job))|where (would|do) you want/i,
      `it asked for something he just told it: ${JSON.stringify(answered.said)}`);

    // Either it has already confirmed and started, or it has said the shape back and is waiting on
    // the yes. Both are correct; what is NOT correct is a search running with no yes behind it.
    const afterAnswer = db.goalById(C, id);
    if (afterAnswer.state !== "running") {
      assert.equal(db.listSeries(C).length, 0, "it started a standing search he never agreed to");
      clock.skip(60_000);
      const yes = await says("yeah that's right");
      assert.equal(db.goalById(C, id).state, "running",
        `a yes to the shape did not start it: ${JSON.stringify(yes.said)}`);
    }

    // Running, with a real standing check-in behind it and the schedule said back once.
    const run = db.goalById(C, id);
    assert.equal(run.state, "running");
    assert.ok(run.series_id, "a standing check-in is behind it");
    assert.ok(run.criteria_confirmed_at, "and his yes is on the row");
    assert.equal(db.seriesById(run.series_id).state, "active");
    assert.ok(db.pendingSeriesTimer(run.series_id), "the first firing is armed");
    assert.ok(db.listActions(C).some(a => a.action === "goal_start" && a.outcome === "ok"), "with a receipt");
  } finally { rt.stop(); }
});

test(`"nah i'm good" ends the pitching for good, and a month of other talk does not bring it back (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    clock.skip(Date.parse("2026-10-07T18:00:00Z") - clock.now());

    const first = await says("i'm trying to find an apartment in brooklyn");
    const rows = db.listGoals(C);
    assert.equal(rows.length, 1, `the goal was not written down: ${JSON.stringify(first.said)}`);
    const id = rows[0].id;
    assert.equal(rows[0].offers, 1, `it never offered: ${JSON.stringify(first.said)}`);

    clock.skip(60_000);
    const no = await says("nah i'm good, i'll just look myself");
    assert.equal(db.goalById(C, id).state, "declined",
      `a no was not recorded as one: ${JSON.stringify(no.said)}`);
    assert.match(db.goalById(C, id).declined_said, /good|myself|nah/i, "with his own words on it");
    // And it takes it well: no second version of the offer in the same breath.
    assert.doesNotMatch(no.said, /are you sure|just so you know|let me know if you change/i,
      `it argued with the no: ${JSON.stringify(no.said)}`);
    assert.equal(db.listSeries(C).length, 0, "nothing is running");

    // A month on, with the subject coming up again in his own words. Reason may help with the
    // thing — that was never what he refused — but the standing offer is over.
    clock.skip(31 * DAY);
    const later = await says("saw a 1-bed in bed-stuy for 2.4, is that a decent price rn?");
    assert.equal(db.goalById(C, id).state, "declined",
      `the no was undone: ${JSON.stringify(later.said)}`);
    assert.equal(db.goalById(C, id).offers, 1, `it pitched the standing help again: ${JSON.stringify(later.said)}`);
    assert.equal(db.listSeries(C).length, 0, "and nothing was started behind it");
    assert.ok(later.said.length > 0, "it still answered the question he actually asked");
  } finally { rt.stop(); }
});

test(`a firing goes and looks, and the same listing never goes over twice (${label})`, { skip }, async () => {
  const { rt, says, reachNextFiring } = harness();
  try {
    clock.skip(Date.parse("2026-10-07T18:00:00Z") - clock.now());

    // Set up through the tools rather than through four turns of conversation: what this test is
    // about is the FIRING, and the setup is proved against the real model by the first test above.
    const noted = goals.note({ conversationId: C, what: "job searching", said: "i'm job searching", help: "a daily search" });
    const id = noted.goal.goal_id;
    goals.setCriteria({
      conversationId: C, goalId: id, confirmed: true,
      criteria: { role: "product manager", where: "remote", level: "mid" },
    });
    goals.setDelivery({ conversationId: C, goalId: id, delivery: "only the ones that actually match" });
    const started = goals.start({ conversationId: C, goalId: id, repeat: { kind: "daily", hour: 9, their_time: true } });
    assert.equal(started.ok, true, JSON.stringify(started));

    // One listing already sent, so the dedup has something to be tested against.
    db.recordGoalMatch(C, id, { matchKey: "jobs.example/pm-acme", title: "PM at Acme", url: "https://jobs.example/pm-acme", source: "jobs.example" });
    db.markGoalMatchesSent(id, db.goalMatches(id, { limit: 1 }).map(m => m.id));

    const fired = await reachNextFiring();
    // With no search connected in the test environment it may honestly have nothing — what must
    // never happen is a text that only says it looked, or one naming the listing he already has.
    assert.doesNotMatch(fired, /PM at Acme|jobs\.example\/pm-acme/,
      `it sent him a listing he has already seen: ${JSON.stringify(fired)}`);
    assert.doesNotMatch(fired, /^(nothing new|no new|didn't find anything)/i,
      `a line whose only content is that it looked: ${JSON.stringify(fired)}`);
    // Anything it did send went through the gate, so nothing was claimed that is not written down.
    const matches = db.goalMatches(id, { limit: 20 });
    for (const m of matches) {
      if (!m.sent_at) continue;
      assert.ok(m.source, `${m.match_key} went over with no source behind it`);
    }
    // The series is untouched by a quiet firing: it comes round again tomorrow.
    assert.equal(db.seriesById(db.goalById(C, id).series_id).state, "active");
    assert.ok(db.pendingSeriesTimer(db.goalById(C, id).series_id), "the next one is armed");

    // And stop is one line.
    clock.skip(HOUR);
    const stop = await says("stop sending me job stuff");
    const after = db.goalById(C, id);
    assert.ok(["dropped", "paused", "done"].includes(after.state),
      `a clear stop left it ${after.state}: ${JSON.stringify(stop.said)}`);
    if (after.state === "dropped") {
      assert.equal(db.listTimers(C).length, 0, "and nothing is left armed");
    }
  } finally { rt.stop(); }
});
