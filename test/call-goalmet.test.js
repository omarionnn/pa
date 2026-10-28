// A call that did what it was for, with nothing to agree (src/calls/goalmet.js). Call 46, 2026-10-27:
// "Reach Jeffrey and ask him to call Omari back" — Jeff: "Yeah, this is me." … "For sure. I will." —
// was filed `dropped_before_confirmation`, so it never counted and the stamps book stayed empty.
//
//   - only a finished third-party call that reached a person and settled nothing is asked about
//   - the model's read moves it to `goal_met` (a success); "no", an error or no CLI leave it alone
//   - something else settling the call first wins; one question per call
//   - goal_met is a finished errand to the stamps
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-goalmet-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.REASON_WEB_DAILY;
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const stamps = await import("../src/stamps.js");
const goal = await import("../src/calls/goalmet.js");
const outcome = await import("../src/calls/outcome.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const JEFF = `Reason: Hey, hi — this is an AI assistant calling for Omari.
Them: Uh, why are you calling?
Reason: I'm calling on behalf of Omari, and I'm trying to reach Jeffrey. Is this Jeffrey?
Them: Yeah, this is me.
Reason: Great, thanks Jeff. Omari would like you to call him back when you get a chance.
Them: For sure. I will.
Reason: Perfect, thank you so much, Jeff. Have a good one.`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  delete process.env.REASON_WEB_DAILY;
  stamps.installStamps({ tell: null, delayMs: 0 });
  db.db.exec("DELETE FROM accounts; DELETE FROM calls; DELETE FROM stamps; DELETE FROM tasks;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari Nyarko", isOperator: true });
});

function call({ is_owner = 0, direction = "out", ...fields } = {}) {
  const now = Date.now();
  const r = db.db.prepare(`INSERT INTO calls (conversation_id, provider, to_number, goal, is_owner, direction, created_at, updated_at) VALUES (?, 'fake', '+16165550100', ?, ?, ?, ?, ?)`)
    .run(C, "Reach Jeffrey and ask him to call Omari back when he gets a chance.", is_owner, direction, now, now);
  return db.updateCall(C, Number(r.lastInsertRowid), { state: "completed", transcript: JEFF, outcome_kind: "dropped_before_confirmation", ended_at: now, ...fields });
}
const says = (met, why = "Jeffrey took the message.") => async () => ({ value: { met, why } });

test("goal_met is a success that reached a person and is never redialled", () => {
  assert.equal(outcome.isSuccess("goal_met"), true);
  assert.equal(outcome.reachedAPerson("goal_met"), true);
  assert.equal(outcome.redialMode("goal_met"), "no");
});

test("only a third-party call that reached a person and settled nothing is asked about", () => {
  assert.equal(goal.judgeable(call()), true);
  assert.equal(goal.judgeable(call({ is_owner: 1 })), false);
  assert.equal(goal.judgeable(call({ direction: "in" })), false);
  assert.equal(goal.judgeable(call({ outcome_kind: "confirmed" })), false);
  assert.equal(goal.judgeable(call({ outcome_kind: "line_silent" })), false);
  assert.equal(goal.judgeable(call({ transcript: "Reason: Hello?\nThem: ...\nReason: Hello?" })), false);
});

test("the Jeffrey call: the model says the goal was met → goal_met, and the book gets its first seal", async () => {
  process.env.REASON_WEB_DAILY = "owner";
  const row = call();
  assert.deepEqual(db.db.prepare("SELECT type FROM stamps").all(), []);
  const r = await goal.settleGoal(C, row, { ask: says(true) });
  assert.equal(r.outcome_kind, "goal_met");
  assert.equal(r.outcome, outcome.OUTCOMES.goal_met.label);
  assert.deepEqual(db.db.prepare("SELECT type, ref FROM stamps").all().map(x => ({ ...x })), [{ type: "first", ref: "first" }]);
});

test("they answered and nothing was achieved: the row stays as it was", async () => {
  const row = call({ transcript: "Reason: Is Jeffrey there?\nThem: Wrong number, sorry.\nReason: Okay, bye." });
  const r = await goal.settleGoal(C, row, { ask: says(false, "Jeffrey was never reached.") });
  assert.equal(r.outcome_kind, "dropped_before_confirmation");
});

test("never guesses upward: an error, an answer off the schema, or a throw leave the row alone", async () => {
  for (const ask of [async () => ({ error: "cli down" }), async () => ({ value: { met: "yes" } }), async () => { throw new Error("boom"); }]) {
    const row = call();
    assert.equal((await goal.settleGoal(C, row, { ask })).outcome_kind, "dropped_before_confirmation");
  }
  // Off the CLI backend (and in tests) the real ask is never made.
  assert.equal(await goal.judgeGoal(call()), null);
});

test("something else settling the call first wins, and one call is asked about once", async () => {
  const row = call();
  let asked = 0;
  const slow = async () => { asked++; db.updateCall(C, row.id, { outcome_kind: "voicemail_left" }); return { value: { met: true, why: "x" } }; };
  const [a, b] = [goal.settleGoal(C, row, { ask: slow }), goal.settleGoal(C, row, { ask: slow })];
  assert.equal(goal.goalPending(row.id) !== null, true);
  await Promise.all([a, b]);
  assert.equal(asked, 1);
  assert.equal(db.getCall(C, row.id).outcome_kind, "voicemail_left");
  assert.equal(goal.goalPending(row.id), null);
});
