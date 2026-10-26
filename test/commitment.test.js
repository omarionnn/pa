// It notices when you skip, offline: the commitment, the grace window, the session and the number.
//
// What is proved here is the half that is code's, because that is the half that has to be right
// whatever the model does — and on this subject the half that has to be right is mostly a list of
// things that must NOT happen:
//
//   1. **The time is theirs.** A commitment carries its own zone, stamped at save time, so 7am is
//      7am where they are and a Reason in New York does not nudge somebody in London at two in the
//      morning. Including across a daylight-saving change, which is where adding seven days lands
//      an hour out.
//   2. **Nothing before the grace window closes, and nothing after the day has gone.** 7:05 is not
//      late. Half past eleven is not a nudge, it is a verdict, so that one is DROPPED rather than
//      held — the one thing in Reason that is better lost than late.
//   3. **One nudge per occurrence.** Not one per sweep, and never a second one.
//   4. **Anything they said settles it.** "Already went", "cant today", "my knee hurts" — each of
//      them means no nudge, no re-ask, and nothing said next time.
//   5. **Never a number nobody logged.** The session and the progression line are read off
//      commitment_logs and there is no other source. With no history the frame says so.
//   6. **A run of them is a wrong schedule, not a reason to push harder.**
//   7. **Stop means stop**, and what they logged is kept rather than deleted.
//   8. **It does not spend their day's one unprompted text**, because a schedule they set is not
//      something Reason went and found — while their waking window and "off" still apply.
//   9. **The frame cannot text.** A model that writes a lovely line and skips `notice_send` sends
//      nothing at all.
//  10. **An export is a copy and a delete is a delete**, for both new tables.
//
// The model is faked throughout. What a fake cannot settle — whether a real model reads "omw" as
// going and writes a line with no shame in it — is test/flow-habit.test.js against the real model,
// and what neither can settle is in docs/unverified.md.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-standing-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { Runtime } = await import("../src/runtime.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { userMessageFor } = await import("../src/agent.js");
const commitment = await import("../src/commitment.js");
const notice = await import("../src/notice.js");
const db = await import("../src/db.js");
const { exportData, deleteData } = await import("../src/data.js");
const { config, clock } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OMARI = "dm:owner";
const TZ = "America/New_York";
const TUE = 2;
const FRI = 5;

const call = (name, input, { conversationId = OMARI, kind = "user" } = {}) =>
  runTool(name, input, { conversationId, kind, messages: [] });

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM commitments; DELETE FROM commitment_logs; DELETE FROM notice_seen;
    DELETE FROM notice_budget; DELETE FROM notice_sweeps; DELETE FROM accounts; DELETE FROM action_ledger;
    DELETE FROM timers; DELETE FROM usage; DELETE FROM conversations; DELETE FROM inbound_messages;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  // They have answered the opt-in question: 8:00-22:00 in New York. Every test here is about a
  // commitment rather than about the setup question, and the one test about their hours sets its own.
  db.setNoticeWindow(OMARI, { timeZone: TZ, start: 8, end: 22, askedAt: clock.now(), answeredAt: clock.now() });
  config.habitGraceMin = 10;
  config.habitWindowMin = 180;
  config.habitRunOfSkips = 3;
  config.noticePerDay = 1;
  config.noticeQuietStart = 22;
  config.noticeQuietEnd = 8;
  // Start every test somewhere harmless and far from any commitment's time: the next Monday noon.
  skipTo({ weekday: 1, hour: 12, zone: TZ });
});

/**
 * Forward to the next moment it is this weekday at this wall-clock time, where they are.
 *
 * Every test in this file turns on "it is now ten past seven on a Friday", and reading the suite's
 * own clock would mean a file that passes on a Tuesday afternoon and fails on a Friday morning —
 * which is the one time you would want to trust it.
 */
function skipTo({ weekday, hour, minute = 0, zone = TZ }) {
  for (let ahead = 0; ahead < 16; ahead++) {
    const day = notice.localDay(clock.now() + ahead * DAY, zone);
    if (commitment.weekdayIn(commitment.instantOf(day, 12 * 60, zone), zone) !== weekday) continue;
    const target = commitment.instantOf(day, hour * 60 + minute, zone);
    if (target <= clock.now()) continue;
    clock.skip(target - clock.now());
    return clock.now();
  }
  throw new Error(`never reached weekday ${weekday} at ${hour}:${minute} in ${zone}`);
}

/** The commitment off the card, saved the way the model would save it. */
async function legDay({ at = "07:00", days = [TUE, FRI], zone = TZ } = {}) {
  const out = await call("commitment_set", {
    what: "leg day", days, at, time_zone: zone,
    said: `leg day ${days.includes(TUE) ? "tuesdays and " : ""}fridays ${at}`,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

/**
 * A runtime whose turns are a fake model.
 *
 * `answer` gets the frame the real model would read plus a `call` that runs a real tool on a turn of
 * the right kind, so the gate and the plumbing are real and only the judgement is stubbed. A string
 * is "it said this"; null is NO_REPLY.
 */
function harness(answer) {
  const turns = [];
  const sent = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind });
      return await answer({
        conversationId, text, kind, n: turns.length,
        key: (String(text).match(/key "([^"]+)"/) ?? [])[1] ?? "",
        call: (name, input) => runTool(name, input, { conversationId, kind, messages: [] }),
      });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, turns, sent };
}

/** The fake model that does the right thing: claims the key, then writes the line. */
const saysIt = (line) => async ({ key, call: c }) => {
  const got = await c("notice_send", {
    key, what: line, why_now: "they said this time and it has gone past",
    specific_to_them: true, one_word_answerable: true,
  });
  return got.ok ? line : null;
};

// ---------- what they said, and whose clock it is on ----------

test("a commitment is their words, their days and THEIR zone, stamped at save time", async () => {
  const out = await legDay();
  assert.equal(out.what, "leg day");
  assert.equal(out.at, "07:00");
  assert.equal(out.days, "tuesdays and fridays");
  assert.equal(out.their_zone, TZ);
  assert.equal(out.guessed_the_zone, false);

  const row = db.commitmentById(out.commitment_id);
  assert.equal(row.time_zone, TZ, "the zone is on the row, not read off the install at nudge time");
  assert.deepEqual(commitment.daysOf(row), [TUE, FRI]);
  assert.equal(row.at_min, 7 * 60);
  assert.match(row.said, /leg day tuesdays and fridays/, "their sentence is what the row rests on");
});

test("saying it again changes the one commitment and keeps everything logged against it", async () => {
  const first = await legDay();
  db.logSession(OMARI, {
    commitmentId: first.commitment_id, day: "2026-10-02", kind: "went",
    items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }], said: "squats 185x8",
  });

  const again = await call("commitment_set", {
    what: "leg day", days: [TUE, FRI], at: "08:00", time_zone: TZ, said: "actually make it 8",
  });
  assert.equal(again.commitment_id, first.commitment_id, "one leg day, not two");
  assert.equal(again.at, "08:00");
  assert.equal(db.listCommitments(OMARI, { state: null }).length, 1);
  assert.equal(db.sessionLogs(first.commitment_id).length, 1, "the session they logged survived the change");
  assert.equal(again.last_session.items[0].weight, "185");
});

test("a zone this machine does not know is refused rather than silently becoming the install's", async () => {
  const out = await call("commitment_set", {
    what: "run", days: [1], at: "06:00", time_zone: "America/NewYork", said: "i run mondays at 6",
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /not a time zone/i);
  assert.match(out.error, /ask them/i, "it says to ask rather than to guess");
  assert.equal(db.listCommitments(OMARI, { state: null }).length, 0, "nothing was saved on a guess");
});

test("7am means 7am where THEY are, not where Reason is", async () => {
  const out = await legDay({ zone: "Europe/London" });
  const row = db.commitmentById(out.commitment_id);
  skipTo({ weekday: FRI, hour: 7, minute: 15, zone: "Europe/London" });
  assert.equal(commitment.skipsNow({ conversationId: OMARI }).nudges.length, 1, "late in London");

  // And the same wall-clock moment in New York is the middle of the night there, which is exactly
  // the bug this zone column exists for: a nudge timed off the install's clock.
  assert.notEqual(notice.localHour(clock.now(), TZ), 7);
  void row;
});

test("a 7am commitment is still 7am after the clocks change", () => {
  const row = db.saveCommitment(OMARI, {
    what: "leg day", days: [FRI], atMin: 7 * 60, timeZone: TZ, said: "leg day fridays 7am",
  });
  // Either side of the US autumn change (1 November 2026): the offset moves, the wall clock does not.
  const before = commitment.instantOf("2026-10-30", 7 * 60, TZ);
  const after = commitment.instantOf("2026-11-06", 7 * 60, TZ);
  assert.equal(notice.localHour(before, TZ), 7);
  assert.equal(notice.localHour(after, TZ), 7);
  assert.notEqual(after - before, 7 * DAY, "the instant moved by an hour, which is the whole point");
  void row;
});

// ---------- the grace window, and the window after it ----------

test("five past is not late; a bit after ten past is", async () => {
  await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 5 });
  assert.equal(commitment.skipsNow({ conversationId: OMARI }).nudges.length, 0, "they may be walking out of the door");

  clock.skip(6 * MIN);
  const now = commitment.skipsNow({ conversationId: OMARI });
  assert.equal(now.nudges.length, 1);
  assert.equal(now.nudges[0].commitment.what, "leg day");
});

test("a Wednesday is not one of its days and costs nothing", async () => {
  await legDay();
  skipTo({ weekday: 3, hour: 9 });
  const { nudges, quiet } = commitment.skipsNow({ conversationId: OMARI });
  assert.equal(nudges.length, 0);
  assert.match(quiet[0].why, /not one of its days/);
});

test("past the window the morning has gone: nothing goes out, and nothing is held for later", async () => {
  await legDay();
  skipTo({ weekday: FRI, hour: 11, minute: 30 });   // 7:10 + 3h window, passed
  const { nudges, quiet } = commitment.skipsNow({ conversationId: OMARI });
  assert.equal(nudges.length, 0);
  assert.match(quiet[0].why, /window has gone/);

  const { rt, turns } = harness(saysIt("nope"));
  const out = await rt.commitments();
  assert.equal(turns.length, 0, "no model was paid to decide this");
  assert.equal(out.due, 0);
  assert.equal(db.heldNotices(OMARI).length, 0, "and nothing is sitting there to fold into tonight's reply");
  rt.stop();
});

test("a nudge the gate would not let out is dropped, not held, so it never arrives late", async () => {
  await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  // The model writes nothing at all: the line never goes, and the occurrence is done with.
  const { rt, turns, sent } = harness(async () => null);
  const out = await rt.commitments();
  assert.equal(turns.length, 1, "it got its one turn");
  assert.equal(sent.length, 0);
  assert.equal(out.nudged, 0);
  assert.equal(db.heldNotices(OMARI).length, 0,
    "a missed 7am must never ride out on tonight's reply — that is a reproach, not help");
  rt.stop();
});

// ---------- one nudge, and anything they say settles it ----------

test("one nudge per occurrence, however many sweeps run", async () => {
  await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const { rt, turns, sent } = harness(saysIt("leg day. you said 7am and it's 7:12 👀"));
  await rt.commitments();
  clock.skip(20 * MIN);
  await rt.commitments();
  clock.skip(20 * MIN);
  await rt.commitments();
  assert.equal(turns.length, 1, "one turn, not one per sweep");
  assert.equal(sent.length, 1);
  rt.stop();
});

test("they already went: nothing is noticed and no turn is paid for", async () => {
  const set = await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 5 });
  const logged = await call("commitment_log", { commitment_id: set.commitment_id, kind: "went", said: "already went" });
  assert.equal(logged.ok, true, JSON.stringify(logged));

  clock.skip(20 * MIN);
  const { rt, turns } = harness(saysIt("x"));
  await rt.commitments();
  assert.equal(turns.length, 0);
  assert.match(commitment.skipsNow({ conversationId: OMARI }).quiet[0].why, /already settled: went/);
  rt.stop();
});

test('"cant today" is accepted, settles it, and there is no second nudge and no guilt', async () => {
  const set = await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const { rt, turns, sent } = harness(saysIt("leg day. you said 7am and it's 7:12 👀"));
  await rt.commitments();
  assert.equal(sent.length, 1);

  const logged = await call("commitment_log", { commitment_id: set.commitment_id, kind: "missed", said: "cant today" });
  assert.equal(logged.ok, true);
  assert.match(logged.note, /SETTLED/);
  assert.match(logged.note, /no re-ask/i);
  assert.match(logged.say, /no guilt/i);
  assert.doesNotMatch(logged.say, /tomorrow/i, "no 'tomorrow then?'");

  // Every later sweep that day, including after a fresh message from them, says nothing.
  for (const mins of [20, 60, 120]) {
    clock.skip(mins * MIN);
    await rt.commitments();
  }
  assert.equal(sent.length, 1, "one nudge all day, and their no was the end of it");
  rt.stop();
});

test('"my knee hurts" gets no plan and no push, and the tool says so in words', async () => {
  const set = await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const logged = await call("commitment_log", { commitment_id: set.commitment_id, kind: "hurt", said: "my knee hurts" });
  assert.equal(logged.ok, true);
  assert.match(logged.note, /SETTLED/);
  for (const forbidden of [/rest it/i, /probably just/i, /advice/i, /asking what happened/i]) {
    assert.match(logged.say, forbidden, `the instruction names ${forbidden} as a thing not to do`);
  }

  const { rt, turns } = harness(saysIt("x"));
  await rt.commitments();
  assert.equal(turns.length, 0, "nothing is nudged about a session they are hurt for");
  rt.stop();
});

test("a session logged as hurt makes the NEXT nudge ask how it is before any lifts", async () => {
  const set = await legDay();
  db.logSession(OMARI, { commitmentId: set.commitment_id, day: notice.localDay(clock.now(), TZ), kind: "hurt", said: "knee" });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const row = commitment.skipsNow({ conversationId: OMARI }).nudges[0];
  assert.equal(row.hurtLast, true);
  const frame = commitment.skipFrame({ conversationId: OMARI, row });
  assert.match(frame, /told you something hurt/i);
  assert.match(frame, /no plan, no number/i);
});

test('"move it to 8" restarts the clock rather than nudging ten minutes later', async () => {
  const set = await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const moved = await call("commitment_log", { commitment_id: set.commitment_id, kind: "moved", at: "08:00", said: "move it to 8" });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.now_due, "08:00");

  assert.equal(commitment.skipsNow({ conversationId: OMARI }).nudges.length, 0, "it is not late any more");
  clock.skip(30 * MIN);                                   // 7:42
  assert.equal(commitment.skipsNow({ conversationId: OMARI }).nudges.length, 0);
  clock.skip(30 * MIN);                                   // 8:12
  const late = commitment.skipsNow({ conversationId: OMARI }).nudges;
  assert.equal(late.length, 1);
  assert.equal(commitment.clockFace(late[0].occurrence.atMin), "08:00", "and it names the time they moved it to");
  // The schedule itself is untouched: next Tuesday is still 7am.
  assert.equal(db.commitmentById(set.commitment_id).at_min, 7 * 60);
});

test("a moved one needs the new time, and says so rather than guessing at midnight", async () => {
  const set = await legDay();
  const out = await call("commitment_log", { commitment_id: set.commitment_id, kind: "moved", said: "push it back" });
  assert.equal(out.ok, false);
  assert.match(out.error, /needs the new time/i);
});

// ---------- making it easy: the session and the number ----------

test("the nudge hands over their last session and the numbers they really hit", async () => {
  const set = await legDay();
  db.logSession(OMARI, {
    commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "squats 185x8",
    items: [
      { what: "squats", weight: "185", sets: 4, reps: 8 },
      { what: "rdl", weight: "135", sets: 3, reps: 10 },
      { what: "lunges", sets: 3, reps: 12 },
    ],
  });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const row = commitment.skipsNow({ conversationId: OMARI }).nudges[0];
  const frame = commitment.skipFrame({ conversationId: OMARI, row });

  assert.match(frame, /leg day/);
  assert.match(frame, /07:00/, "it names the time they said");
  assert.match(frame, /squats/);
  assert.match(frame, /rdl/);
  assert.match(frame, /lunges/);
  assert.match(frame, /185/);
  assert.match(frame, /only figures you may say THEY did/, "what they lifted is a closed list");
  // And the one number that is NOT off that list: the figure it asks them for. The first live run of
  // this answered "omw" with "put more on the bar" — obediently, because the frame said "go a bit
  // more" and then forbade any weight not on the list. A hedge hands the decision straight back,
  // which is the one thing the card is about not doing, so the hedges are refused by name and the
  // ask is stated to be a figure.
  assert.match(frame, /you hit 185 last week\. go 190/, "the card's own line is the shape it is given");
  assert.match(frame, /you finish it with a number/i, "the ask is a figure, not 'a bit more'");
  assert.match(frame, /put more on the bar/, "and the hedges are named");
  // Lunges had no weight, so nothing may be said about one.
  assert.equal(row.numbers.some(n => n.what === "lunges"), false);
  assert.match(frame, /never any number at all for an exercise with none against it/i);
});

test("no history means no plan and no number: it says so instead of inventing either", async () => {
  await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const row = commitment.skipsNow({ conversationId: OMARI }).nudges[0];
  assert.deepEqual(row.plan.items, []);
  assert.deepEqual(row.numbers, []);

  const frame = commitment.skipFrame({ conversationId: OMARI, row });
  assert.match(frame, /no logged session/i);
  assert.match(frame, /Do not invent one/i);
  assert.match(frame, /NO logged numbers/);
  assert.match(frame, /not got last time's numbers/i);
  assert.doesNotMatch(frame, /you hit \d/, "there is no fabricated 'you hit 185 last week' in it");
});

test("the plan is their last real session, and a missed one does not become the plan", async () => {
  const set = await legDay();
  const id = set.commitment_id;
  db.logSession(OMARI, { commitmentId: id, day: "2026-09-25", kind: "went", said: "squats 175", items: [{ what: "squats", weight: "175", sets: 4, reps: 8 }] });
  db.logSession(OMARI, { commitmentId: id, day: "2026-10-02", kind: "went", said: "squats 185", items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }] });
  db.logSession(OMARI, { commitmentId: id, day: "2026-10-06", kind: "missed", said: "cant today" });

  const row = db.commitmentById(id);
  assert.equal(commitment.sessionPlan(row).from, "2026-10-02", "the newest one they actually went to");
  const numbers = commitment.lastNumbers(row);
  assert.equal(numbers.length, 1);
  assert.equal(numbers[0].weight, "185", "the latest real figure, never the older one and never an average");
  assert.equal(numbers[0].on, "2026-10-02");
});

test("a plain 'went' is logged as showing up, and later numbers for the same session keep it one", async () => {
  const set = await legDay();
  const day = notice.localDay(clock.now(), TZ);
  await call("commitment_log", { commitment_id: set.commitment_id, kind: "went", said: "went" });
  const bare = db.sessionOn(set.commitment_id, day);
  assert.equal(bare.kind, "went");
  assert.deepEqual(commitment.itemsOf(bare), [], "attendance with no numbers on it is a real answer");

  await call("commitment_log", {
    commitment_id: set.commitment_id, kind: "went", said: "squats 185x8",
    items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }],
  });
  assert.equal(db.sessionLogs(set.commitment_id).length, 1, "one session, not two");

  // And a vaguer line afterwards does not lose the numbers.
  await call("commitment_log", { commitment_id: set.commitment_id, kind: "went", said: "yeah i went" });
  assert.equal(commitment.itemsOf(db.sessionOn(set.commitment_id, day))[0].weight, "185");
});

// ---------- a run of them is a wrong schedule ----------

test("three in a row gets the schedule question instead of a fourth nudge, once", async () => {
  const set = await legDay({ days: [FRI] });
  const row = db.commitmentById(set.commitment_id);
  // Set on the Monday, then three Fridays go by with nothing said about any of them. The first two
  // are closed out; the third is the one in front of us.
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const run = commitment.runOfSkips(row);
  assert.equal(run.missed, 2, "two closed-out Fridays behind this one");

  const { nudges, asks } = commitment.skipsNow({ conversationId: OMARI });
  assert.equal(nudges.length, 0, "it does not nudge a fourth time");
  assert.equal(asks.length, 1);

  const frame = commitment.wrongScheduleFrame({ conversationId: OMARI, row: asks[0] });
  assert.match(frame, /do NOT nudge/i);
  assert.match(frame, /move it or drop it/i);
  assert.match(frame, /No count at them, no streak/i);
  assert.match(frame, /commitment_end/);

  const { rt, turns, sent } = harness(saysIt("7am fridays isn't landing — move it or drop it?"));
  await rt.commitments();
  assert.equal(sent.length, 1);
  clock.skip(30 * MIN);
  await rt.commitments();
  assert.equal(turns.length, 1, "asked once");
  rt.stop();
});

test("a run that they accounted for is counted as accounted for", async () => {
  const set = await legDay({ days: [FRI] });
  const row = db.commitmentById(set.commitment_id);
  for (let i = 0; i < 3; i++) skipTo({ weekday: FRI, hour: 7, minute: 12 });
  for (const occ of commitment.pastOccurrences(row).slice(1, 3)) {
    db.logSession(OMARI, { commitmentId: row.id, day: occ.day, kind: "missed", said: "cant today" });
  }
  const run = commitment.runOfSkips(row);
  assert.equal(run.missed, 2);
  assert.equal(run.accounted, 2, "somebody who told Reason twice has said something, and the frame needs to know");
});

test("one they went to breaks the run", async () => {
  const set = await legDay({ days: [FRI] });
  const row = db.commitmentById(set.commitment_id);
  for (let i = 0; i < 3; i++) skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const past = commitment.pastOccurrences(row);
  db.logSession(OMARI, { commitmentId: row.id, day: past[1].day, kind: "went", said: "went" });
  assert.equal(commitment.runOfSkips(row).missed, 0);
  assert.equal(commitment.skipsNow({ conversationId: OMARI }).nudges.length, 1, "an ordinary nudge, not the schedule question");
});

test("a brand-new commitment has no history of being missed", async () => {
  // Set on the Monday, and the first Friday it has ever had is the one in front of us. The eight
  // weeks of Fridays before it existed were never theirs to miss.
  const set = await legDay({ days: [FRI] });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  assert.equal(commitment.runOfSkips(db.commitmentById(set.commitment_id)).missed, 0);
  assert.equal(commitment.skipsNow({ conversationId: OMARI }).asks.length, 0,
    "so their first ever one is an ordinary nudge, never \"that's the third you've missed\"");
  assert.equal(commitment.skipsNow({ conversationId: OMARI }).nudges.length, 1);
});

// ---------- stop means stop ----------

test("commitment_end stops it now, keeps what they logged, and leaves no door open", async () => {
  const set = await legDay();
  db.logSession(OMARI, { commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "went", items: [{ what: "squats", weight: "185" }] });

  const out = await call("commitment_end", { commitment_id: set.commitment_id, said: "stop nudging me about the gym" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.state, "ended");
  assert.match(out.kept, /1 logged session/);
  assert.match(out.say, /no guilt/i);
  assert.match(out.say, /are you sure/i, "the instruction names 'are you sure' as a thing not to say");
  assert.equal(db.sessionLogs(set.commitment_id).length, 1, "what they did happened; it is not deleted");

  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const { rt, turns } = harness(saysIt("x"));
  await rt.commitments();
  assert.equal(turns.length, 0, "nothing more goes out about it");
  rt.stop();
});

test("paused keeps the thing and stops the nudging, and saying it again restarts it with the numbers intact", async () => {
  const set = await legDay();
  db.logSession(OMARI, { commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "went", items: [{ what: "squats", weight: "185" }] });
  await call("commitment_end", { commitment_id: set.commitment_id, state: "paused", said: "stop texting me about it" });
  assert.equal(db.commitmentById(set.commitment_id).state, "paused");
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  assert.equal(commitment.skipsNow({ conversationId: OMARI }).nudges.length, 0);

  const back = await legDay();
  assert.equal(back.commitment_id, set.commitment_id);
  assert.equal(db.commitmentById(set.commitment_id).state, "active");
  assert.equal(back.last_session.items[0].weight, "185");
});

// ---------- their hours, their initiative, their day's budget ----------

test("it does not spend their one unprompted text, because they set the schedule", async () => {
  await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const { rt, sent } = harness(saysIt("leg day. you said 7am and it's 7:12 👀"));
  await rt.commitments();
  assert.equal(sent.length, 1);

  const budget = notice.budgetFor(OMARI, { timeZone: TZ });
  assert.equal(budget.sent, 0, "a schedule they set is not a catch Reason went and found");
  assert.equal(budget.spent, false, "so the day's one real catch is still there for a bill that matters");
  const receipt = db.listActions(OMARI, { limit: 5 }).find(r => r.action === "notice_send");
  assert.ok(receipt, "it still leaves a receipt");
  assert.equal(receipt.result.counted_against_today, false);
  assert.equal(receipt.result.their_own_schedule, true, "and the receipt says which it was");
  rt.stop();
});

test("the hour they named carries its own permission: a 5am commitment gets its 5:10 nudge", async () => {
  const set = await call("commitment_set", {
    what: "run", days: [FRI], at: "05:00", time_zone: TZ, said: "i run fridays at 5am",
  });
  assert.equal(set.ok, true);
  // Said out loud at save time, because it is easy to assume it either way. It is not a warning
  // that nothing will happen — it is the honest scope of the exception they just made.
  assert.ok(set.outside_their_hours, "saving it hands back the mismatch to be said in one line");
  assert.match(set.outside_their_hours.note, /WILL go out at 05:00/);
  assert.match(set.outside_their_hours.note, /nothing else that early/);

  skipTo({ weekday: FRI, hour: 5, minute: 12 });
  const { rt, sent } = harness(saysIt("run. you said 5 and it's 5:12 👀"));
  await rt.commitments();
  assert.equal(sent.length, 1, "they named 5am, so 5:12 is a time they said was alright");
  rt.stop();
});

test("and it widens nothing: past the hour they named, their night is their night again", async () => {
  await call("commitment_set", { what: "run", days: [FRI], at: "05:00", time_zone: TZ, said: "i run fridays at 5am" });
  // Inside the occurrence's three-hour window but no longer the hour they said, and still before 8.
  skipTo({ weekday: FRI, hour: 6, minute: 40 });
  const { nudges } = commitment.skipsNow({ conversationId: OMARI });
  assert.equal(nudges.length, 1, "it is still a missed one");
  const allowed = commitment.mayNudgeNow({ conversationId: OMARI, occurrence: nudges[0].occurrence });
  assert.equal(allowed.ok, false);
  assert.match(allowed.why, /the hour they named has passed/);

  const { rt, turns } = harness(saysIt("x"));
  const out = await rt.commitments();
  assert.equal(turns.length, 0, "no model is paid to decide something code will refuse");
  assert.match(out.skipped[0].why, /night/);
  rt.stop();
});

test("a commitment in their waking hours needs no exception, and says nothing about one", async () => {
  const set = await call("commitment_set", { what: "piano", days: [FRI], at: "20:00", time_zone: TZ, said: "piano fridays at 8pm" });
  assert.equal(set.outside_their_hours, undefined);
});

test('"stop texting me unprompted" stops this too', async () => {
  await legDay();
  notice.setMode({ conversationId: OMARI, mode: "off", said: "only answer when i ask" });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const { rt, turns } = harness(saysIt("x"));
  const out = await rt.commitments();
  assert.equal(turns.length, 0);
  assert.equal(out.skipped[0].why, "initiative_off");
  rt.stop();
});

test("the frame cannot text: a line that skipped notice_send goes nowhere", async () => {
  await legDay();
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const { rt, turns, sent } = harness(async () => "leg day. you said 7am 👀");
  await rt.commitments();
  assert.equal(turns.length, 1);
  assert.equal(sent.length, 0, "whatever it wrote, nothing left without the gate");
  rt.stop();
});

test("two commitments missed on one morning is still one text", async () => {
  await legDay();
  await call("commitment_set", { what: "piano", days: [FRI], at: "07:00", time_zone: TZ, said: "piano fridays 7am too" });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });
  const { rt, turns, sent } = harness(saysIt("leg day. you said 7am 👀"));
  await rt.commitments();
  await rt.commitments();
  assert.equal(turns.length, 1, "one at a time: picking the first and letting the other go");
  assert.equal(sent.length, 1);
  rt.stop();
});

// ---------- what rides on a turn they start ----------

test("what they have standing is in front of the model on their own turns, with the numbers", async () => {
  const set = await legDay();
  db.logSession(OMARI, {
    commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "squats 185x8",
    items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }],
  });
  skipTo({ weekday: FRI, hour: 7, minute: 12 });

  const note = commitment.commitmentNote(OMARI);
  assert.match(note, /leg day/);
  assert.match(note, /tuesdays and fridays/);
  assert.match(note, /185/);
  assert.match(note, /time went past with nothing logged/);
  assert.match(note, /never estimate, average or round/i);

  // On their turn and nowhere else, and only in what the model reads — not in the history, which
  // would go on describing a schedule they have since changed.
  const { forModel, forHistory } = userMessageFor({ prefix: "[now] Omari:", text: "already went", turnNote: [note] });
  assert.match(forModel.content, /leg day/);
  assert.equal(/leg day/.test(JSON.stringify(forHistory)), false);
});

test("nothing standing means no note at all", () => {
  assert.equal(commitment.commitmentNote(OMARI), "");
});

test("commitment_list is the truth of it, and never a score", async () => {
  const set = await legDay();
  db.logSession(OMARI, { commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "went", items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }] });
  const out = await call("commitment_list", {});
  assert.equal(out.ok, true);
  assert.equal(out.commitments.length, 1);
  const row = out.commitments[0];
  assert.equal(row.what, "leg day");
  assert.equal(row.their_zone, TZ);
  assert.equal(row.their_words, "leg day tuesdays and fridays 07:00");
  assert.equal(row.their_numbers[0].weight, "185");
  assert.equal(row.recent[0].on, "2026-10-02");
  assert.match(out.note, /never to say back at them as a count/i);

  const empty = await call("commitment_list", {}, { conversationId: "dm:nobody" });
  assert.deepEqual(empty.commitments, []);
  assert.match(empty.note, /Nothing standing/);
});

test("a commitment from another conversation is not touchable from this one", async () => {
  db.upsertAccount({ conversationId: "dm:other", channel: "test", address: "+15550000", name: "Someone" });
  const theirs = db.saveCommitment("dm:other", { what: "run", days: [1], atMin: 360, timeZone: TZ, said: "i run mondays" });
  for (const [name, input] of [
    ["commitment_log", { commitment_id: theirs.id, kind: "went", said: "went" }],
    ["commitment_end", { commitment_id: theirs.id, said: "stop" }],
  ]) {
    const out = await call(name, input);
    assert.equal(out.ok, false, name);
    assert.match(out.error, /no commitment/i);
  }
});

// ---------- the honest capability line ----------

test("capabilities says it is live and says what it cannot know", () => {
  const row = capabilitiesNow({ conversationId: OMARI, ownerName: "Omari" }).find(x => x.name === "standing_commitments");
  assert.ok(row, "it is in the manifest");
  assert.equal(row.status, "live");
  assert.match(row.what, /cannot see a gym, a watch or an app/i,
    "'did I go' is answered from what they said, and the manifest has to make that sayable");
  assert.match(row.what, /Nothing about calories, weight or their body/i);
});

// ---------- an export is a copy, a delete is a delete ----------

test("both tables are in an export and a delete takes them", async () => {
  const set = await legDay();
  db.logSession(OMARI, {
    commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "squats 185x8 felt heavy",
    items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }],
  });

  const dump = exportData({ conversation: OMARI, audio: false });
  for (const t of ["commitments", "commitment_logs"]) assert.ok(dump.tables[t]?.length, `${t} is in the export`);
  const text = JSON.stringify(dump);
  assert.ok(text.includes("leg day tuesdays and fridays 07:00"), "their own sentence is in it");
  assert.ok(text.includes("squats 185x8 felt heavy"), "and so is what they said about the session");

  const deleted = await deleteData({ conversation: OMARI, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });
  for (const t of ["commitments", "commitment_logs"]) {
    assert.ok(deleted.rows[t] >= 1, `${t}: rows deleted`);
    assert.equal(db.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} is empty`);
  }
});

// ---------- the page that answers "what do you know about me" ----------
//
// The schedule and the weights are things they TOLD Reason, so the place they are correctable is
// the same page as everything else it knows. A commitment that could only be changed by remembering
// a tool exists would be a feature that owns somebody's morning.

test("what they do on a schedule is on the memory page, with the numbers under it", async () => {
  const set = await legDay();
  db.logSession(OMARI, {
    commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "squats 185x8",
    items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }, { what: "rdl", weight: "135", sets: 3, reps: 10 }],
  });

  const out = await call("memory_page", {});
  assert.equal(out.ok, true);
  assert.equal(out.counts.commitments, 1, "it is counted, so the page is not 'nothing yet'");
  const row = out.commitments[0];
  assert.equal(row.id, set.commitment_id, "with the number they correct it by");
  assert.equal(row.what, "leg day");
  assert.equal(row.at, "07:00");
  assert.equal(row.their_zone, TZ, "their zone, not the install's");
  assert.equal(row.they_said, "leg day tuesdays and fridays 07:00", "and their own sentence");
  assert.deepEqual(row.their_numbers.map(n => `${n.what} ${n.weight}`), ["squats 185", "rdl 135"]);

  const blocks = JSON.stringify(out.page_blocks);
  assert.match(blocks, /What you do on a schedule/, "it has its own section");
  assert.match(blocks, /tuesdays and fridays at 07:00/, "the schedule in words");
  assert.match(blocks, /squats — 185 4x8/, "and every number they logged is its own row");
  assert.match(blocks, /you told me this on 2026-10-02/, "said as something they reported, never as a measurement");

  // The one-text correction, named on the page itself and in what the model is told.
  assert.match(blocks, /just tell me the new one/i);
  assert.match(out.how_to_correct, /commitment_set with the same thing and the new time/);
  assert.match(out.how_to_correct, /Never memory_fix for those/);
  assert.match(out.note, /only ones you may say/i);
});

test("and correcting it really is one text: the new time keeps every session logged against it", async () => {
  const set = await legDay();
  db.logSession(OMARI, {
    commitmentId: set.commitment_id, day: "2026-10-02", kind: "went", said: "squats 185x8",
    items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }],
  });

  const moved = await call("commitment_set", {
    what: "leg day", days: [TUE, FRI], at: "08:00", time_zone: TZ, said: "make leg day 8",
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.commitment_id, set.commitment_id, "the same row, not a second leg day");

  const after = await call("memory_page", {});
  assert.equal(after.counts.commitments, 1, "still one");
  assert.equal(after.commitments[0].at, "08:00", "at the time they just said");
  assert.deepEqual(after.commitments[0].their_numbers.map(n => n.weight), ["185"], "and the 185 survived the change");
});

test("a dropped one is not something it knows any more", async () => {
  const set = await legDay();
  await call("commitment_end", { commitment_id: set.commitment_id, said: "drop leg day" });

  const out = await call("memory_page", {});
  assert.equal(out.counts.commitments, 0, "off the page the moment they say so");
  assert.ok(!JSON.stringify(out.page_blocks).includes("What you do on a schedule"));
  // But not deleted: what they did happened, and saying it again picks it back up.
  assert.equal(db.sessionLogs(set.commitment_id, { limit: 5 }).length, 0);
  assert.equal(db.commitmentById(set.commitment_id).state, "ended");
});

test("a page with nothing but a commitment on it is not an empty page", async () => {
  await legDay();
  const out = await call("memory_page", {});
  const blocks = JSON.stringify(out.page_blocks);
  assert.ok(!blocks.includes("Nothing yet"), "a schedule is something it knows about them");
  assert.doesNotMatch(out.note, /do not know anything about them yet/);
});
