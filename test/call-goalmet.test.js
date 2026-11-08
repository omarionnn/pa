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

// One fixed daytime moment, 11:00 on the morning of the Jeffrey call in New York. The calls below end
// "now", and a call that ends between midnight and 6am on the owner's clock also earns a night_shift
// seal (src/stamps.js) — so on the real clock the first-seal test failed every night and passed by day.
const MORNING = Date.parse("2026-10-27T15:00:00Z");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  clock.skip(MORNING - Date.now());
  delete process.env.REASON_WEB_DAILY;
  stamps.installStamps({ tell: null, delayMs: 0 });
  db.db.exec("DELETE FROM accounts; DELETE FROM calls; DELETE FROM stamps; DELETE FROM tasks; DELETE FROM call_commitments;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari Nyarko", isOperator: true });
});

const at = (row, to) => { db.db.prepare("UPDATE calls SET to_number = ? WHERE id = ?").run(to, row.id); return db.getCall(C, row.id); };
function call({ is_owner = 0, direction = "out", brief = "{}", ...fields } = {}) {
  const now = clock.now();
  const r = db.db.prepare(`INSERT INTO calls (conversation_id, provider, to_number, goal, is_owner, direction, brief, created_at, updated_at) VALUES (?, 'fake', '+16165550100', ?, ?, ?, ?, ?, ?)`)
    .run(C, "Reach Jeffrey and ask him to call Omari back when he gets a chance.", is_owner, direction, brief, now, now);
  return db.updateCall(C, Number(r.lastInsertRowid), { state: "completed", transcript: JEFF, outcome_kind: "dropped_before_confirmation", ended_at: now, ...fields });
}
const says = (met, why = "Jeffrey took the message.") => async () => ({ value: { met, why } });

test("goal_met is a success that reached a person and is never redialled", () => {
  assert.equal(outcome.isSuccess("goal_met"), true);
  assert.equal(outcome.reachedAPerson("goal_met"), true);
  assert.equal(outcome.redialMode("goal_met"), "no");
});

test("only a call that reached a person and settled nothing is asked about (their own call too, 2026-11-07)", () => {
  assert.equal(goal.judgeable(call()), true);
  assert.equal(goal.judgeable(call({ is_owner: 1 })), true);
  assert.equal(goal.judgeable(call({ direction: "in" })), false);
  assert.equal(goal.judgeable(call({ outcome_kind: "confirmed" })), false);
  assert.equal(goal.judgeable(call({ outcome_kind: "line_silent" })), false);
  assert.equal(goal.judgeable(call({ transcript: "Reason: Hello?\nThem: ...\nReason: Hello?" })), false);
  // Cleared to book: only the read-back gate settles whether it was done; a machine answering it still names itself.
  const booking = call({ brief: JSON.stringify({ approved: { book: true } }) });
  assert.equal(goal.kindFrom(booking, { met: true, how: "talked" }), "");
  assert.equal(goal.kindFrom(booking, { met: false, how: "hung_up_early" }), "");
  assert.equal(goal.kindFrom(booking, { met: false, how: "voicemail_not_set_up" }), "voicemail_full");
});

test("a transcript that grew while it was being read is read again", async () => {
  const row = call({ transcript: "Reason: Hi, is this Jeffrey?\nThem: Yeah, this is me." });
  const seen = [];
  const ask = async ({ prompt }) => {
    seen.push(prompt);
    if (seen.length === 1) { db.updateCall(C, row.id, { transcript: JEFF }); return { value: { met: false, why: "cut off" } }; }
    return { value: { met: true, why: "took the message" } };
  };
  const r = await goal.settleGoal(C, row, { ask });
  assert.equal(seen.length, 2);
  assert.match(seen[1], /For sure\. I will\./);
  assert.equal(r.outcome_kind, "goal_met");
});

test("an answer of no on the whole transcript is asked once", async () => {
  let n = 0;
  await goal.settleGoal(C, call(), { ask: async () => { n++; return { value: { met: false, why: "no" } }; } });
  assert.equal(n, 1);
});

test("the Jeffrey call: the model says the goal was met → goal_met, and the book gets its first seal", async () => {
  process.env.REASON_WEB_DAILY = "owner";
  const row = call();
  assert.deepEqual(db.db.prepare("SELECT type FROM stamps").all(), []);
  const r = await goal.settleGoal(C, row, { ask: says(true) });
  assert.equal(r.outcome_kind, "goal_met");
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

test("security R2-I: a book-cleared call the read files as a machine keeps its label, and its redial stays ask-only with booking off", async () => {
  const redial = await import("../src/calls/redial.js");
  const BOOK = JSON.stringify({ goal: "Book a table for two Saturday at 8 under Omari.", approved: { book: true, maxCents: null, terms: [], upTo: "" } });
  const next = { goal: "Book a table", approved: { book: true } };
  const KIND = { recording: "machine_recording", voicemail_greeting: "voicemail_no_message", voicemail_not_set_up: "voicemail_full" };
  let n = 0;
  for (const how of Object.keys(KIND)) {
    const to = `+1616555030${n++}`;
    const row = at(call({ brief: BOOK, transcript: "Reason: Hi, a table for two Saturday at eight.\nThem: Sure, you're booked for Saturday at eight.\nThem: Please leave a message after the tone." }), to);
    const r = await goal.settleGoal(C, row, { ask: async () => ({ value: { met: false, how, why: "a recording" } }) });
    assert.equal(r.outcome_kind, KIND[how], `${how}: the label is as before`);
    const again = redial.safeToRedial(C, { toNumber: to, brief: next });
    assert.equal(again.mode, "ask", how);
    assert.notEqual(again.brief?.approved?.book, true, how);
  }
  // Any commitment on the call (even a declined one, which the earlier checks do not look at): the same.
  const c2 = at(call({ outcome_kind: "machine_recording" }), "+16165550399");
  assert.equal(redial.safeToRedial(C, { toNumber: "+16165550399", brief: next }).mode, "retry", "asking-only, no commitment: a plain retry");
  db.createCommitment(C, { callId: c2.id, what: "a table for two", state: "declined" });
  assert.equal(redial.safeToRedial(C, { toNumber: "+16165550399", brief: next }).mode, "ask");
  // Cleared to book but nothing on the line said a word (no answer): still a plain retry.
  const c3 = at(call({ brief: BOOK, outcome_kind: "no_answer", transcript: "" }), "+16165550398");
  assert.equal(redial.safeToRedial(C, { toNumber: "+16165550398", brief: next }).mode, "retry");
});

test("security R2-I: maybe-booked → ask-only check nobody answered → the next redial is still ask-only with booking off", async () => {
  const redial = await import("../src/calls/redial.js");
  const { askWhetherItWentThrough } = await import("../src/calls/brief.js");
  const { config } = await import("../src/config.js");
  const was = config.callMaxRetries;
  config.callMaxRetries = 5;
  try {
    const BOOK = { goal: "Book a table for two Saturday at 8 under Omari.", approved: { book: true, maxCents: null, terms: [], upTo: "" } };
    const next = { goal: "Book a table", approved: { book: true } };
    const SPOKE = "Reason: Hi, a table for two Saturday at eight.\nThem: Sure, you're booked for Saturday at eight.";
    const CHECK = JSON.stringify(askWhetherItWentThrough(BOOK, { what: BOOK.goal }));
    for (const [n, follow] of [
      ["no answer", { outcome_kind: "no_answer", transcript: "" }],
      ["failed", { outcome_kind: "failed", transcript: "" }],
      ["a check that reached a person and dropped", { outcome_kind: "dropped_before_confirmation", transcript: "Reason: Checking on a booking.\nThem: Hang on—" }],
    ]) {
      const to = `+161655504${String(n.length).padStart(2, "0")}`;
      at(call({ brief: JSON.stringify(BOOK), transcript: SPOKE }), to); // dropped_before_confirmation: ask-only on main too
      const first = redial.safeToRedial(C, { toNumber: to, brief: next });
      assert.equal(first.mode, "ask", n);
      at(call({ brief: CHECK, ...follow }), to);
      const again = redial.safeToRedial(C, { toNumber: to, brief: next });
      assert.equal(again.mode, "ask", n);
      assert.notEqual(again.brief?.approved?.book, true, n);
      assert.match(again.brief.goal, /^Find out whether this already went through, and change nothing: Book a table for two/, `${n}: the check is about the booking, not about the check`);
    }
    // Calls that could not have booked, rung out and rung again: a plain retry as before.
    const to = "+16165550480";
    at(call({ outcome_kind: "picked_up" }), to);
    at(call({ outcome_kind: "no_answer", transcript: "" }), to);
    assert.equal(redial.safeToRedial(C, { toNumber: to, brief: next }).mode, "retry");
  } finally { config.callMaxRetries = was; }
});
