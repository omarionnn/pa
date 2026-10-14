// What Reason has worked out about how somebody lives — and every bar it has to clear first.
//
// An inference is the first kind of memory in Reason that nobody handed it. A fact came out of
// somebody's mouth; a guess came off a photo they sent; a rhythm is Reason watching a person for
// three weeks and forming a view. So this file is mostly refusals, and each one is a sentence
// somebody would say out loud:
//
//   1. **"Three late nights isn't a life."** Three evidence points, spanning a fortnight, every one
//      a row that really exists. Thin evidence is refused by CODE after the model has spoken, so a
//      model that reads a rhythm off one busy week stores nothing.
//   2. **"You already said that."** The same rhythm read twice is one row, and the second reading
//      says the evidence still bears it out rather than writing a near-duplicate.
//   3. **"That's not me any more."** A pattern nothing has borne out for three weeks is deleted.
//      Nobody corrected anything; the thing stopped being true, which a fact never does on its own.
//   4. **"Don't read into my texts."** No deletes every row and stops the pass, every pass.
//   5. **"Nobody asked me."** Until they have been asked, nothing is kept at all — and the one
//      inference the pass may compute is held, not stored, as the example in the question.
//   6. **"You asked me that already."** Once in a lifetime, and only when something would really
//      change.
//   7. **"Why did that arrive at six?"** A rhythm moves WHEN a non-urgent catch lands, with the
//      inference's own words as the reason — and never into the hours they said they were asleep.
//   8. **"That's wrong."** A correction scrubs the old wording out of everything carrying it.
//
// The fake model is the one from test/landed.test.js: `new Runtime({ runTurn })`. No API key, no
// network, no real messages. What a fake model cannot settle — whether its sense of "that is a real
// rhythm and not noise" is any good — is docs/unverified.md's problem, not this file's.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-inferences-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const notice = await import("../src/notice.js");
const rhythms = await import("../src/rhythms.js");
const memory = await import("../src/memory.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const { checkContent } = await import("../src/pages/content.js");
const { exportData } = await import("../src/data.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OMARI = "dm:owner";
const TZ = "America/New_York";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM guesses; DELETE FROM pattern_asks; DELETE FROM inbound_messages; DELETE FROM outbox;
    DELETE FROM notice_seen; DELETE FROM notice_budget; DELETE FROM notice_sweeps; DELETE FROM accounts;
    DELETE FROM conversations; DELETE FROM timers; DELETE FROM usage; DELETE FROM person_facts; DELETE FROM people;
    DELETE FROM action_ledger; DELETE FROM threads;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  // They have been asked their hours and answered, which the pass requires before it asks anything
  // of its own — the patterns question is never the first question somebody gets.
  db.setNoticeWindow(OMARI, { tz: TZ, start: 8, end: 22, askedAt: clock.now(), answeredAt: clock.now() });
  config.noticePerDay = 1;
  config.noticeHardCap = 3;
  config.noticeQuietStart = 22;
  config.noticeQuietEnd = 8;
});

const call = (name, input, { conversationId = OMARI, kind = "event", ...rest } = {}) =>
  runTool(name, input, { conversationId, kind, messages: [], ...rest });

/**
 * One message from them, at a real past moment, with no body.
 *
 * Written straight into the table with an explicit `received_at` rather than through claimInbound,
 * which stamps `clock.now()`: the whole subject here is messages landing on particular days three
 * weeks apart, and a helper that could not say when something arrived could not set any of it up.
 */
let seq = 0;
function texted(at) {
  seq++;
  db.db.prepare(`INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, text)
    VALUES ('test', ?, ?, ?, 'x')`).run(`in-${seq}-${at}`, OMARI, at);
  return db.db.prepare("SELECT id FROM inbound_messages WHERE external_id = ?").get(`in-${seq}-${at}`).id;
}

/** The moment, today, at a given hour of THEIR clock, `daysAgo` back. */
function theirHour(hour, daysAgo = 0) {
  let t = clock.now() - daysAgo * DAY;
  for (let i = 0; i < 48; i++) {
    if (notice.localHour(t, TZ) === hour) return t;
    t -= HOUR;
  }
  throw new Error(`never reached ${hour}:00 local`);
}

function skipToLocalHour(hour) {
  for (let i = 0; i < 48; i++) {
    if (notice.localHour(clock.now(), TZ) === hour) return;
    clock.skip(HOUR);
  }
  throw new Error(`never reached ${hour}:00 local`);
}

/** Late-evening messages on five days spread over three weeks: a real rhythm, by the numbers. */
function threeWeeksOfLateEvenings() {
  const refs = [];
  for (const daysAgo of [20, 16, 11, 6, 2]) refs.push(`m${texted(theirHour(21, daysAgo))}`);
  return refs;
}

/**
 * The fake model, as test/landed.test.js has it.
 *
 * `rhythmEvidence` is forwarded from the turn into every tool call the fake model makes, because
 * that is what the real runTurn does with a pass's `ctx` — and it is the thing the two writers
 * refuse without, so a harness that dropped it would be proving the refusal and nothing else.
 */
function harness(answer) {
  const turns = [];
  const sent = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind, rhythmEvidence = null }) => {
      turns.push({ conversationId, text, kind });
      return await answer({
        conversationId, text, kind, n: turns.length,
        call: (name, input, extra = {}) => runTool(name, input, {
          conversationId, kind, messages: [], ...(rhythmEvidence ? { rhythmEvidence } : {}), ...extra,
        }),
      });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, turns, sent };
}

/** Patterns on, with one row already there, for the tests that are about what happens next. */
function sayYesAndNote({ refs, about = "work stuff", inference = "deals with work stuff after 9pm", use = "hold non-urgent things till the evening" }) {
  db.setPatterns(OMARI, { patterns: "on", said: "yeah go for it", setAt: clock.now() });
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const out = rhythms.keep({ conversationId: OMARI, proposal: { about, inference, evidence: refs, use }, evidence });
  assert.equal(out.ok, true, JSON.stringify(out));
  return { id: out.id, evidence };
}

// ---------- 1. the schema, and an older install's database ----------

test("a pattern is a guess row with receipts, what it changes, and a clock on it", () => {
  const refs = threeWeeksOfLateEvenings();
  const { id } = sayYesAndNote({ refs });

  const row = db.getPattern(OMARI, id);
  assert.equal(row.how, "i_noticed_a_pattern");
  assert.equal(row.use, "hold non-urgent things till the evening");
  assert.equal(row.evidence.length, 5, "the receipts are on the row");
  assert.ok(row.evidence.every(e => typeof e.ref === "string" && Number.isInteger(e.hour)));
  assert.ok(row.last_supported_at, "and a clock, because a pattern expires and a fact does not");
  assert.equal(row.confirmed_at, null);

  // It is a guess, and it is NOT in the guesses list: "I read it off a picture" and "I watched you
  // for three weeks" are two different claims and the page says so in two different ways.
  assert.deepEqual(db.listGuesses(OMARI).map(g => g.id), []);
  assert.deepEqual(db.listGuesses(OMARI, { includePatterns: true }).map(g => g.id), [id]);
  assert.deepEqual(db.listPatterns(OMARI).map(p => p.id), [id]);
  assert.equal(db.PATTERN_SOURCE, "i_noticed_a_pattern");
  assert.ok(db.GUESS_SOURCES.includes("i_noticed_a_pattern"));
});

test("the migration adds the three columns to a guesses table that was built without them", () => {
  // The real shape of the problem: CREATE TABLE IF NOT EXISTS leaves an older install's table
  // exactly as it was, so a column added later has to be added by hand. This is that table.
  const cols = db.db.prepare("PRAGMA table_info(guesses)").all().map(c => c.name);
  for (const col of ["evidence", "use", "last_supported_at"]) {
    assert.ok(cols.includes(col), `guesses has no ${col} column`);
  }
  // Written as an older install would have: no evidence, no use, no clock. It still reads.
  db.db.prepare("INSERT INTO guesses (conversation_id, about, guess, how, noted_at) VALUES (?, ?, ?, ?, ?)")
    .run(OMARI, "Omari", "bought a civic", "i_saw_it_in_a_photo", clock.now());
  const old = db.listGuesses(OMARI);
  assert.equal(old.length, 1);
  assert.equal(old[0].evidence, "[]", "the default, not null");
  assert.equal(old[0].use, "");
  assert.equal(old[0].last_supported_at, null);
  assert.equal(db.listPatterns(OMARI).length, 0, "and an old guess is not a pattern");

  // And the account's own three columns, plus the one on notice_seen that carries the reason.
  const acct = db.db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  for (const col of ["patterns", "patterns_said", "patterns_asked_at", "patterns_set_at"]) {
    assert.ok(acct.includes(col), `accounts has no ${col} column`);
  }
  assert.ok(db.db.prepare("PRAGMA table_info(notice_seen)").all().some(c => c.name === "moment_why"));
  assert.ok(db.db.prepare("PRAGMA table_info(notice_sweeps)").all().some(c => c.name === "last_rhythm_day"));
});

// ---------- 2. the gate: three points, two weeks, real rows, a use ----------

test("thin evidence is refused by code, however sure the model was", () => {
  const refs = threeWeeksOfLateEvenings();
  db.setPatterns(OMARI, { patterns: "on", said: "go for it", setAt: clock.now() });
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const good = { about: "work stuff", inference: "deals with work stuff after 9pm", evidence: refs, use: "hold things till the evening" };

  // Two points is not a pattern.
  const two = rhythms.keep({ conversationId: OMARI, proposal: { ...good, evidence: refs.slice(0, 2) }, evidence });
  assert.equal(two.ok, false);
  assert.match(two.why, /2 evidence point\(s\); 3 is the floor/);

  // Three points all inside one week is a busy week.
  const packed = [`m${texted(theirHour(21, 3))}`, `m${texted(theirHour(21, 2))}`, `m${texted(theirHour(21, 1))}`];
  const fresh = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const narrow = rhythms.keep({ conversationId: OMARI, proposal: { ...good, evidence: packed }, evidence: fresh });
  assert.equal(narrow.ok, false);
  assert.match(narrow.why, /inside 2 day\(s\)/);
  assert.match(narrow.why, /at least 14/);

  // Evidence it made up is not evidence.
  const invented = rhythms.keep({ conversationId: OMARI, proposal: { ...good, evidence: ["m9001", "m9002", "m9003"] }, evidence });
  assert.equal(invented.ok, false);
  assert.match(invented.why, /not rows that was in front of you|are not rows/);

  // And nothing that changes nothing is stored, whatever the evidence says.
  const useless = rhythms.keep({ conversationId: OMARI, proposal: { ...good, use: "   " }, evidence });
  assert.equal(useless.ok, false);
  assert.match(useless.why, /nothing is stored without 'use'/);

  assert.equal(db.listPatterns(OMARI).length, 0, "four refusals, four rows not written");

  // The real one goes in, so the bar is a bar and not a wall.
  assert.equal(rhythms.keep({ conversationId: OMARI, proposal: good, evidence }).ok, true);
  assert.equal(db.listPatterns(OMARI).length, 1);
});

test("the same rhythm twice is one row, and the second reading starts its clock again", () => {
  const refs = threeWeeksOfLateEvenings();
  const { id, evidence } = sayYesAndNote({ refs });
  const first = db.getPattern(OMARI, id).last_supported_at;

  clock.skip(2 * DAY);
  const again = rhythms.keep({
    conversationId: OMARI,
    proposal: { about: "work stuff", inference: "deals with work stuff after 9pm", evidence: refs, use: "hold non-urgent things till the evening" },
    evidence,
  });
  assert.equal(again.ok, true);
  assert.equal(again.id, id, "the same row");
  assert.equal(again.already_noticed, true);
  assert.equal(db.listPatterns(OMARI).length, 1, "and not a near-duplicate beside it");
  assert.ok(db.getPattern(OMARI, id).last_supported_at > first, "its clock started again");
});

// ---------- 3. patterns expire; facts do not ----------

test("a pattern nothing has borne out for three weeks is deleted, and a fact beside it is not", async () => {
  const refs = threeWeeksOfLateEvenings();
  const { id } = sayYesAndNote({ refs });
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });

  // Twenty days on, nothing has said otherwise: still there. Nothing expires early.
  clock.skip(20 * DAY);
  assert.deepEqual(rhythms.expire({ conversationId: OMARI, now: clock.now() }), []);
  assert.equal(db.listPatterns(OMARI).length, 1);

  clock.skip(2 * DAY);
  const gone = rhythms.expire({ conversationId: OMARI, now: clock.now() });
  assert.deepEqual(gone.map(g => g.id), [id]);
  assert.equal(db.listPatterns(OMARI).length, 0, "the claim stopped being true, so it went");
  assert.equal((await call("recall", { about: "Kofi" })).count, 1, "and what they TOLD you is untouched");
  assert.equal(rhythms.EXPIRE_DAYS, 21);
});

test("pattern_still is what keeps one alive, and anything unnamed is left to expire", async () => {
  const refs = threeWeeksOfLateEvenings();
  const { id, evidence } = sayYesAndNote({ refs });
  const second = rhythms.keep({
    conversationId: OMARI,
    proposal: { about: "saturdays", inference: "saturdays are gone", evidence: refs, use: "not expect an answer on a saturday" },
    evidence,
  });
  assert.equal(second.ok, true);

  clock.skip(19 * DAY);
  const held = await call("pattern_still", { ids: [id, 9001] }, { rhythmEvidence: evidence });
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.deepEqual(held.still_holds.map(h => h.id), [id]);
  assert.deepEqual(held.no_such_pattern, [9001], "a number that is not theirs is said so, not silently taken");

  // Three weeks after that, the one nobody vouched for is gone and the one that was is not.
  clock.skip(5 * DAY);
  const gone = rhythms.expire({ conversationId: OMARI, now: clock.now() });
  assert.deepEqual(gone.map(g => g.id), [second.id]);
  assert.deepEqual(db.listPatterns(OMARI).map(p => p.id), [id]);
});

// ---------- 4. off deletes everything and stops the pass ----------

test("'no' deletes every rhythm and the pass does not run again", async () => {
  const refs = threeWeeksOfLateEvenings();
  sayYesAndNote({ refs });
  assert.equal(db.listPatterns(OMARI).length, 1);

  const off = await call("patterns_set", { on: false, said: "nah stop reading into my texts" });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.patterns, "off");
  assert.equal(off.their_words, "nah stop reading into my texts");
  assert.deepEqual(off.deleted, ["deals with work stuff after 9pm"]);
  assert.equal(db.listPatterns(OMARI).length, 0, "keeping them and merely not adding more is not a no");
  assert.equal(notice.settingsFor(OMARI).patterns, "off");

  // And the pass itself: no turn, and it goes on deleting anything that turns up.
  db.setPatterns(OMARI, { patterns: "off" });
  db.noteGuess(OMARI, { about: "x", guess: "y", how: db.PATTERN_SOURCE, evidence: [], use: "z" });
  skipToLocalHour(2);
  const { rt, turns } = harness(async () => { throw new Error("the pass must not pay for a turn when they said no"); });
  try {
    const out = await rt.rhythms({ now: clock.now() });
    assert.equal(out.turns, 0);
    assert.equal(turns.length, 0);
    assert.equal(out.deleted, 1);
    assert.ok(out.skipped.some(s => s.why === "patterns_off"));
    assert.equal(db.listPatterns(OMARI).length, 0);
  } finally { rt.stop(); }
});

test("their answer needs their own words, either way", async () => {
  const noWords = await call("patterns_set", { on: true, said: "  " });
  assert.equal(noWords.ok, false);
  assert.match(noWords.error, /word for word/);
  assert.equal(notice.settingsFor(OMARI).patterns, "not_asked", "nothing moved");
});

// ---------- 5. nothing is kept until they are asked, and the example is held ----------

test("while nobody has asked, the pass stores nothing and holds one example for the question", async () => {
  threeWeeksOfLateEvenings();
  assert.equal(notice.settingsFor(OMARI).patterns, "not_asked");
  // Their morning, not their night: the question is the one branch that has to reach a person.
  skipToLocalHour(10);

  const { rt, turns, sent } = harness(async ({ text, call: t }) => {
    assert.match(text, /the one question about noticing patterns/);
    assert.match(text, /The rows themselves/);
    assert.ok(!/'x'|\btext:/.test(text), "no message bodies anywhere near the model");
    const refs = [...text.matchAll(/\bm(\d+)\b/g)].map(m => `m${m[1]}`);
    const held = await t("patterns_ask", {
      about: "work stuff", inference: "deals with work stuff after 9pm",
      evidence: refs, use: "hold non-urgent things till the evening",
    });
    assert.equal(held.ok, true, JSON.stringify(held));
    assert.equal(held.stored, false);
    return "btw i've noticed you deal with work stuff after 9pm, so i've been holding non-urgent things till then."
      + " want me to keep picking up patterns like that? you can see and delete any of them anytime";
  });
  try {
    const out = await rt.rhythms({ now: clock.now() });
    assert.equal(out.asked, 1, JSON.stringify(out));
    assert.equal(turns.length, 1);
    assert.equal(sent.length, 1, "the question really went out");
    assert.match(sent[0].text, /want me to keep picking up patterns/);

    // NOTHING is on their page. The example is parked, which is a different thing.
    assert.equal(db.listPatterns(OMARI).length, 0, "not kept — they have not said yes");
    assert.equal(memory.remembered({ conversationId: OMARI }).counts.patterns, 0);
    const parked = db.patternAsk(OMARI);
    assert.equal(parked.inference, "deals with work stuff after 9pm");
    assert.equal(parked.use, "hold non-urgent things till the evening");
    assert.ok(parked.evidence.length >= 3);

    // And it cost them their one unprompted text for the day, like anything else Reason starts.
    assert.equal(notice.budgetFor(OMARI, { now: clock.now(), timeZone: TZ }).sent, 1);
    // And it is now asked, for good: the stamp goes on only because the text really went out.
    assert.ok(notice.settingsFor(OMARI).patternsAskedAt);
  } finally { rt.stop(); }
});

test("a question that was composed and never sent is not a question that was asked", async () => {
  threeWeeksOfLateEvenings();
  skipToLocalHour(10);
  // The model does the work, calls the tool, and then thinks better of it. That happens, and the
  // one chance in somebody's life to be asked this must not be spent on a text nobody got.
  const { rt, sent } = harness(async ({ text, call: t }) => {
    const refs = [...text.matchAll(/\bm(\d+)\b/g)].map(m => `m${m[1]}`);
    const held = await t("patterns_ask", {
      about: "work stuff", inference: "deals with work stuff after 9pm",
      evidence: refs, use: "hold non-urgent things till the evening",
    });
    assert.equal(held.ok, true, JSON.stringify(held));
    return "";                                            // NO_REPLY, as the real turn resolves it
  });
  try {
    const out = await rt.rhythms({ now: clock.now() });
    assert.equal(sent.length, 0);
    assert.equal(out.asked, 0);
    assert.equal(notice.settingsFor(OMARI).patternsAskedAt, null, "still unasked");
    assert.equal(db.patternAsk(OMARI), null, "and nothing left parked");
    assert.equal(notice.budgetFor(OMARI, { now: clock.now(), timeZone: TZ }).sent, 0, "and it cost them nothing");

    // So tomorrow may ask it properly.
    clock.skip(DAY);
    skipToLocalHour(10);
    const second = harness(async ({ text, call: t }) => {
      const refs = [...text.matchAll(/\bm(\d+)\b/g)].map(m => `m${m[1]}`);
      await t("patterns_ask", {
        about: "work stuff", inference: "deals with work stuff after 9pm",
        evidence: refs, use: "hold non-urgent things till the evening",
      });
      return "btw i've noticed you deal with work stuff after 9pm — want me to keep picking stuff like that up?";
    });
    try {
      assert.equal((await second.rt.rhythms({ now: clock.now() })).asked, 1);
      assert.equal(second.sent.length, 1);
      assert.ok(notice.settingsFor(OMARI).patternsAskedAt);
    } finally { second.rt.stop(); }
  } finally { rt.stop(); }
});

test("somebody who asked for nothing unprompted is not asked this out of the blue", async () => {
  threeWeeksOfLateEvenings();
  db.setNoticePrefs(OMARI, { mode: "off" });
  skipToLocalHour(10);
  const { rt, turns } = harness(async () => { throw new Error("it asked anyway"); });
  try {
    const out = await rt.rhythms({ now: clock.now() });
    assert.equal(turns.length, 0);
    assert.ok(out.skipped.some(s => s.why === "initiative is off"), JSON.stringify(out.skipped));
  } finally { rt.stop(); }
});

test("a yes keeps the example they actually saw; a no keeps nothing", async () => {
  const refs = threeWeeksOfLateEvenings();
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const points = refs.map(r => evidence.points.find(p => p.ref === r));
  db.holdPatternAsk(OMARI, {
    about: "work stuff", inference: "deals with work stuff after 9pm", evidence: points,
    use: "hold non-urgent things till the evening",
  });
  db.setPatterns(OMARI, { askedAt: clock.now() });

  const yes = await call("patterns_set", { on: true, said: "yeah that's actually true, keep doing it" });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(yes.patterns, "on");
  assert.ok(yes.kept_as_pattern, "the row they agreed to is the row they saw");
  const row = db.getPattern(OMARI, yes.kept_as_pattern);
  assert.equal(row.guess, "deals with work stuff after 9pm");
  assert.equal(row.use, "hold non-urgent things till the evening");
  assert.equal(row.evidence.length, refs.length);
  assert.equal(db.patternAsk(OMARI), null, "the parking space is let go");

  // The other way round, from a fresh ask: a no keeps nothing at all.
  db.db.exec("DELETE FROM guesses;");
  db.setPatterns(OMARI, { patterns: null, said: "", setAt: null });
  db.holdPatternAsk(OMARI, { about: "work stuff", inference: "deals with work stuff after 9pm", evidence: points, use: "hold things" });
  const no = await call("patterns_set", { on: false, said: "nah i'd rather you didn't" });
  assert.equal(no.ok, true, JSON.stringify(no));
  assert.equal(db.listPatterns(OMARI).length, 0);
  assert.equal(db.patternAsk(OMARI), null);
});

test("pattern_note refuses outright until they have said yes, and on any turn but the pass", async () => {
  const refs = threeWeeksOfLateEvenings();
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const good = { about: "work stuff", inference: "deals with work stuff after 9pm", evidence: refs, use: "hold things till the evening" };

  const unasked = await call("pattern_note", good, { rhythmEvidence: evidence });
  assert.equal(unasked.ok, false);
  assert.match(unasked.error, /Nobody has asked them/);

  db.setPatterns(OMARI, { patterns: "off", said: "no" });
  const refused = await call("pattern_note", good, { rhythmEvidence: evidence });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /said no/);

  // And with a yes, but on an ordinary turn — no rows in front of it, so nothing to rest on.
  db.setPatterns(OMARI, { patterns: "on", said: "go on then" });
  const loose = await call("pattern_note", good, { kind: "user" });
  assert.equal(loose.ok, false);
  assert.match(loose.error, /only written on the reflection turn/);
  assert.match(loose.error, /that is remember/);
  assert.equal(db.listPatterns(OMARI).length, 0);
});

// ---------- 6. asked once, and only when something would change ----------

test("the question is asked once in a lifetime, whatever the answer was", async () => {
  threeWeeksOfLateEvenings();
  skipToLocalHour(10);
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const refs = evidence.points.map(p => p.ref);
  const ask = { about: "work stuff", inference: "deals with work stuff after 9pm", evidence: refs, use: "hold things till the evening" };

  const first = await call("patterns_ask", ask, { rhythmEvidence: evidence });
  assert.equal(first.ok, true, JSON.stringify(first));
  // Even inside the same turn: the parking space is taken and the budget is spent.
  const second = await call("patterns_ask", ask, { rhythmEvidence: evidence });
  assert.equal(second.ok, false, JSON.stringify(second));

  // And once it has really gone out, the pass never comes back to it — not after a yes, and not
  // after silence, which is the case that would otherwise nag somebody forever.
  db.setPatterns(OMARI, { askedAt: clock.now() });
  const { rt, turns } = harness(async () => { throw new Error("it asked twice"); });
  try {
    const out = await rt.rhythms({ now: clock.now() });
    assert.equal(turns.length, 0);
    assert.ok(out.skipped.some(s => s.why === "asked once, never answered"), JSON.stringify(out.skipped));
  } finally { rt.stop(); }
});

test("nothing is asked off thin evidence: a weak example gets a no, so it is not asked at all", async () => {
  // Three messages in three days. A shape, and not a rhythm.
  const refs = [3, 2, 1].map(d => `m${texted(theirHour(21, d))}`);
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const out = await call("patterns_ask", {
    about: "work stuff", inference: "deals with work stuff after 9pm", evidence: refs, use: "hold things",
  }, { rhythmEvidence: evidence });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "not_enough_behind_it");
  assert.match(out.error, /asked once in their life/);
  assert.equal(db.patternAsk(OMARI), null, "nothing parked");
  assert.equal(notice.settingsFor(OMARI).patternsAskedAt, null, "and the question is still unasked");
});

test("the pass pays for no turn when there is not enough to look at", async () => {
  texted(theirHour(21, 1));
  texted(theirHour(21, 0));
  db.setPatterns(OMARI, { patterns: "on", said: "go on" });
  skipToLocalHour(2);
  const { rt, turns } = harness(async () => { throw new Error("it looked anyway"); });
  try {
    const out = await rt.rhythms({ now: clock.now() });
    assert.equal(turns.length, 0);
    assert.equal(out.looked, 0);
    assert.ok(out.skipped.some(s => /is the floor|has to span/.test(s.why)), JSON.stringify(out.skipped));
  } finally { rt.stop(); }
});

test("the pass runs in their night, once a day", async () => {
  threeWeeksOfLateEvenings();
  db.setPatterns(OMARI, { patterns: "on", said: "go on" });

  // Two in the afternoon is not when this happens.
  skipToLocalHour(14);
  const day = harness(async () => { throw new Error("it ran in the middle of their day"); });
  try {
    const out = await day.rt.rhythms({ now: clock.now() });
    assert.equal(day.turns.length, 0);
    assert.ok(out.skipped.some(s => s.why === "not their night"));
  } finally { day.rt.stop(); }

  // Two in the morning is. And only once.
  skipToLocalHour(2);
  const night = harness(async ({ text }) => {
    assert.match(text, /what you have noticed about how they live/);
    return "NO_REPLY";
  });
  try {
    assert.equal((await night.rt.rhythms({ now: clock.now() })).turns, 1);
    clock.skip(HOUR);
    const twice = await night.rt.rhythms({ now: clock.now() });
    assert.equal(twice.turns, 0, "once a day");
    assert.ok(twice.skipped.some(s => s.why === "already today"));
    assert.equal(night.turns.length, 1);
  } finally { night.rt.stop(); }
});

// ---------- 7. what a rhythm actually does: the moment, and nothing else ----------

test("a rhythm moves when a non-urgent catch lands, and says so in the inference's own words", () => {
  const refs = threeWeeksOfLateEvenings();
  const { id } = sayYesAndNote({ refs });
  const rows = db.listPatterns(OMARI);
  const hours = notice.rhythmHours(rows[0]);
  assert.deepEqual([hours.from, hours.to], [21, 21], "the window is arithmetic over the rows, not a reading of the sentence");

  skipToLocalHour(10);
  const now = clock.now();
  const opts = { timeZone: TZ, quietStart: 23, quietEnd: 8, rhythms: rows };
  // A bill has no moment of its own, so this is the one thing a rhythm gets to choose.
  const bill = notice.momentWithReason({ kind: "mail_due", what: "a bill" }, now, opts);
  assert.equal(notice.localHour(bill.at, TZ), 21, `landed at ${notice.localHour(bill.at, TZ)}:00`);
  assert.equal(bill.why, "hold non-urgent things till the evening", "the reason is the inference's own words");
  assert.ok(bill.at > now && bill.at < now + DAY);

  // A meeting at two o'clock is nudged before two o'clock, whatever anybody noticed about evenings.
  const twoTomorrow = theirHour(14) + DAY;
  const meeting = notice.momentWithReason({ kind: "calendar_moved", starts: new Date(twoTomorrow).toISOString() }, now, opts);
  assert.equal(meeting.why, "", "a thing with its own clock keeps its own clock");
  assert.ok(meeting.at < twoTomorrow);

  // And with nothing noticed, nothing moves.
  const plain = notice.momentWithReason({ kind: "mail_due" }, now, { ...opts, rhythms: [] });
  assert.equal(plain.at, now);
  assert.equal(plain.why, "");
});

test("a rhythm never moves anything into the hours they said they were asleep", () => {
  // Their rows are all at 23:00, which is a real rhythm and is not an invitation to text at 23:00.
  for (const daysAgo of [20, 15, 9, 3]) texted(theirHour(23, daysAgo));
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const late = evidence.points.filter(p => p.hour === 23).map(p => p.ref);
  db.setPatterns(OMARI, { patterns: "on", said: "ok" });
  const out = rhythms.keep({
    conversationId: OMARI,
    proposal: { about: "the late shift", inference: "is up late", evidence: late, use: "wait until late" },
    evidence,
  });
  assert.equal(out.ok, true, JSON.stringify(out));

  skipToLocalHour(10);
  const now = clock.now();
  const moment = notice.momentWithReason({ kind: "mail_due" }, now, {
    timeZone: TZ, quietStart: 22, quietEnd: 8, rhythms: db.listPatterns(OMARI),
  });
  assert.equal(moment.at, now, "the hours they gave outrank a pattern nobody asked them about");
  assert.equal(moment.why, "");
});

test("the sweep writes the shifted moment and the reason onto the row, and notice_status says why", async () => {
  const refs = threeWeeksOfLateEvenings();
  sayYesAndNote({ refs });
  skipToLocalHour(10);
  const rows = db.listPatterns(OMARI);
  const moment = notice.momentWithReason({ kind: "mail_due", what: "a bill" }, clock.now(), {
    timeZone: TZ, quietStart: 23, quietEnd: 8, rhythms: rows,
  });
  const row = db.recordNotice(OMARI, {
    kind: "mail_due", key: "due:test:1", what: `a bill, still unread`,
    momentAt: moment.at, momentWhy: moment.why, at: clock.now(),
  });
  db.holdNotice(row.id, clock.now());

  const status = await call("notice_status", {});
  const held = status.noticed_and_not_said.find(h => /a bill/.test(h.what));
  assert.equal(held.because, "hold non-urgent things till the evening");
  assert.ok(held.waiting_until, "and when, so the hour is not presented as though nothing chose it");
  assert.equal(status.patterns, "on");
  assert.equal(status.rhythms.length, 1);
  assert.equal(status.rhythms[0].so_i, "hold non-urgent things till the evening");
  assert.equal(status.rhythms[0].hours, "21:00-21:00");
  assert.match(status.rhythms_note, /These are GUESSES/);
  assert.match(status.rhythms_note, /Never state one back as a fact/);
});

// ---------- 8. the page, and every row of it theirs ----------

test("the page shows the rhythms as guesses, with what each one changed and the setting beside it", async () => {
  const refs = threeWeeksOfLateEvenings();
  sayYesAndNote({ refs });
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });

  const out = await call("memory_page", {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.counts.patterns, 1);
  assert.equal(out.counts.guesses, 0, "a pattern is not in the guesses list");
  assert.equal(out.patterns[0].i_think, "deals with work stuff after 9pm");
  assert.equal(out.patterns[0].so_i, "hold non-urgent things till the evening");
  assert.equal(out.patterns[0].off, 5);
  assert.equal(out.patterns[0].hours, "21:00-21:00");
  assert.ok(Number.isInteger(out.patterns[0].id) && out.patterns[0].id > 0);

  const page = checkContent(out.page_blocks);
  assert.equal(page.ok, true, JSON.stringify(page));
  const titles = page.blocks.filter(b => b.type === "section").map(b => b.title);
  assert.ok(titles.includes("What I've noticed about your rhythms"), JSON.stringify(titles));
  const text = JSON.stringify(page.blocks);
  assert.match(text, /deals with work stuff after 9pm/);
  assert.match(text, /so I hold non-urgent things till the evening/);
  assert.match(text, /Guesses across a few weeks, not facts/);
  assert.match(text, /These expire on their own/);
  assert.match(text, /Noticing patterns: \*\*on\*\*/);
  assert.match(text, /yeah go for it/, "their own sentence, verbatim");

  // The text answer is told the order and told to say what each one changed.
  assert.match(out.note, /rhythms are guesses too/);
  assert.match(out.note, /Say what each one CHANGED/);
  assert.ok(out.note.indexOf("GUESSING") < out.note.indexOf("rhythms you have noticed"));
  assert.match(out.how_to_correct, /row "pattern"/);
  assert.match(out.how_to_correct, /patterns_set with on=false/);
});

test("the page is honest when nobody has been asked, and when they said no", async () => {
  const unasked = await call("memory_page", {});
  assert.equal(unasked.initiative.patterns, "not asked yet");
  assert.match(JSON.stringify(unasked.page_blocks), /I have not asked you yet/);

  await call("patterns_set", { on: false, said: "no thanks" });
  const no = await call("memory_page", {});
  assert.equal(no.initiative.patterns, "off");
  const text = JSON.stringify(no.page_blocks);
  assert.match(text, /Noticing patterns: \*\*off\*\*/);
  assert.match(text, /no thanks/);
  assert.ok(!text.includes("What I've noticed about your rhythms"));
});

test("correcting a rhythm changes that one row and scrubs the old wording out of the thread", async () => {
  const refs = threeWeeksOfLateEvenings();
  const { id } = sayYesAndNote({ refs });
  const second = rhythms.keep({
    conversationId: OMARI,
    proposal: { about: "saturdays", inference: "saturdays are gone", evidence: refs, use: "not expect an answer on a saturday" },
    evidence: rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ }),
  });
  assert.equal(second.ok, true);

  // The old reading in both the places it really lives: a saved tool result, and something Reason
  // said off the back of it. The next turn reads both.
  db.saveConversation(OMARI, [
    { role: "user", content: "why'd that come in so late" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "i think you deals with work stuff after 9pm so i held it" },
        { type: "tool_use", id: "t1", name: "memory_page", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ patterns: [{ i_think: "deals with work stuff after 9pm" }] }) }] },
  ]);

  const fix = await call("memory_fix", {
    row: "pattern", id, said: "it's not work, it's that i'm only free after the kid's asleep",
    instead: "is only free after about 9",
  });
  assert.equal(fix.ok, true, JSON.stringify(fix));
  assert.equal(fix.was, "deals with work stuff after 9pm");
  assert.equal(fix.now, "is only free after about 9");

  // Exactly one row moved, and the other rhythm is untouched.
  assert.equal(db.getPattern(OMARI, id).guess, "is only free after about 9");
  assert.ok(db.getPattern(OMARI, id).corrected_at);
  assert.equal(db.getPattern(OMARI, second.id).guess, "saturdays are gone");

  // And the old wording is nowhere a next turn could read it.
  const thread = JSON.stringify(db.loadConversation(OMARI));
  assert.ok(!thread.includes("deals with work stuff after 9pm"), "not in the saved thread");
  assert.ok(fix.also_cleared.tool_results >= 1, JSON.stringify(fix.also_cleared));
  assert.ok(fix.also_cleared.things_you_said >= 1, JSON.stringify(fix.also_cleared));
  assert.ok(!JSON.stringify((await call("memory_page", {})).page_blocks).includes("deals with work stuff after 9pm"));

  // One dropped is one gone.
  const dropped = await call("memory_drop", { row: "pattern", id: second.id });
  assert.equal(dropped.ok, true, JSON.stringify(dropped));
  assert.equal(dropped.dropped, "saturdays are gone");
  assert.deepEqual(db.listPatterns(OMARI).map(p => p.id), [id]);
});

test("forgetting a person takes the patterns about them, and an export carries them", async () => {
  const refs = threeWeeksOfLateEvenings();
  sayYesAndNote({ refs, about: "Kofi", inference: "hears from Kofi in the evenings", use: "not chase Kofi in the morning" });
  await call("remember", { about: "Kofi", fact: "allergic to shellfish", source: "they_said" });

  const dump = exportData({ conversation: OMARI, audio: false });
  assert.equal(dump.tables.guesses.length, 1);
  assert.equal(dump.tables.guesses[0].how, "i_noticed_a_pattern");
  assert.equal(dump.tables.guesses[0].use, "not chase Kofi in the morning");
  assert.ok(dump.tables.pattern_asks, "and the parked example has a table in the export");

  const out = await call("forget", { about: "Kofi" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.patterns_dropped, 1);
  assert.equal(db.listPatterns(OMARI).length, 0, "a forget that left the pattern behind would still be timing off her");
});

// ---------- the pass, end to end, with a stubbed model ----------

test("the reflection pass: one silent turn, the row re-checked, one new rhythm, nothing sent", async () => {
  const refs = threeWeeksOfLateEvenings();
  const { id } = sayYesAndNote({ refs });
  // A second shape in the numbers: saturdays, over three weeks.
  const saturdays = [];
  for (const daysAgo of [19, 12, 5]) saturdays.push(theirHour(11, daysAgo));
  for (const at of saturdays) texted(at);
  skipToLocalHour(3);

  const { rt, turns, sent } = harness(async ({ text, call: t }) => {
    // Code has put the evidence and the existing row in front of it, and no message bodies.
    assert.match(text, /By hour of their day/);
    assert.match(text, /By day of the week/);
    assert.match(text, new RegExp(`#${id} about work stuff`));
    assert.match(text, /Call pattern_still with the ids that still hold/);
    assert.match(text, /This turn sends NOTHING/);

    const still = await t("pattern_still", { ids: [id] });
    assert.equal(still.ok, true, JSON.stringify(still));

    // The second shape: the three late mornings, read off the lines in the frame rather than off
    // anything the test knows — a ref the model could not have seen is refused by code.
    const mornings = [...text.matchAll(/^ {2}(m\d+) +\w+ [^(]+\(11:00/gm)].map(m => m[1]);
    assert.equal(mornings.length, 3, `the frame lists the late mornings: ${mornings}`);
    const noted = await t("pattern_note", {
      about: "mornings", inference: "is about in the late morning too",
      evidence: mornings, use: "not sit on something until the evening when it is already late morning",
    });
    assert.equal(noted.ok, true, JSON.stringify(noted));
    assert.equal(noted.already_noticed, false);
    return "i noticed a thing about your mornings";          // and it is thrown away
  });
  try {
    const out = await rt.rhythms({ now: clock.now() });
    assert.equal(out.turns, 1, JSON.stringify(out));
    assert.equal(out.looked, 1);
    assert.equal(turns.length, 1);
    assert.equal(sent.length, 0, "the pass sends nothing, whatever the model wrote");

    const now = db.listPatterns(OMARI);
    assert.equal(now.length, 2);
    assert.deepEqual(now.map(p => p.guess).sort(), ["deals with work stuff after 9pm", "is about in the late morning too"]);
    assert.ok(db.getPattern(OMARI, id).last_supported_at >= clock.now() - MIN, "the old one was borne out");
  } finally { rt.stop(); }
});

test("the model gets when, never what: no message text reaches the frame", () => {
  db.db.prepare(`INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, text)
    VALUES ('test', 'secret-1', ?, ?, 'my pin is 4821 and the lawyer called')`).run(OMARI, theirHour(21, 18));
  for (const d of [12, 5]) texted(theirHour(21, d));
  const evidence = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  const frame = rhythms.reflectFrame({ conversationId: OMARI, evidence, rows: [] });
  assert.ok(!frame.includes("4821"), "a message body in the frame would make this a different feature");
  assert.ok(!frame.includes("lawyer"));
  assert.equal(evidence.points.length, 3);
  assert.ok(evidence.points.every(p => !("text" in p)));
});

test("the evidence is counts and times off real rows, with the span that decides everything", () => {
  const refs = threeWeeksOfLateEvenings();
  const got = rhythms.evidenceFor({ conversationId: OMARI, now: clock.now(), timeZone: TZ });
  assert.equal(got.count, 5);
  assert.equal(got.span_days, 18, `20 days ago to 2 days ago: ${got.span_days}`);
  assert.deepEqual(got.points.map(p => p.ref), refs);
  assert.ok(got.points.every(p => p.hour === 21));
  assert.deepEqual(got.by_hour, [{ hour: 21, count: 5 }]);
  assert.equal(got.by_weekday.length, 7);
  assert.ok(got.days_with_nothing.length > 10, "the days nothing arrived are evidence too");
  assert.equal(rhythms.enoughToLookAt(got).ok, true);
  assert.equal(rhythms.WINDOW_DAYS, 21);
  assert.equal(rhythms.MIN_POINTS, 3);
  assert.equal(rhythms.MIN_SPAN_DAYS, 14);
});

test("one person's rhythms are not another's", () => {
  const other = "dm:somebody-else";
  db.upsertAccount({ conversationId: other, channel: "test", address: "+14445550000", name: "Ama", isOperator: false });
  const refs = threeWeeksOfLateEvenings();
  const { id } = sayYesAndNote({ refs });
  assert.equal(memory.remembered({ conversationId: other }).counts.patterns, 0);
  assert.equal(db.getPattern(other, id), null, "and not reachable by number either");
  assert.equal(notice.settingsFor(other).patterns, "not_asked");
});
