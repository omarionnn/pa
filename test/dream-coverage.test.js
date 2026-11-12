// The nightly memory review's coverage, its read of phone calls, and what it notices across days
// (src/dream.js, 2026-11-12). Live had 16 accounts, 13 who had said something, and only 4 ever
// reviewed: nine people whose last message was more than a week old were queued every night, found
// "nothing new", and were never read.
//
//   (1) somebody never reviewed whose messages are all older than a week gets a first review
//   (2) a missed window is caught up later the same day
//   (3) a run of restarts cannot ask again: the ask is on disk, and a fresh boot waits
//   (4) a backlog past the caps is read by a second pass the same day; never more than 3 asks a day
//   (5) a skipped ask (CLI over its limit at 4am) is tried again later, not lost till tomorrow
//   (6) what they said on their own call is read and can be cited like a text (REASON_REVIEW_CALLS)
//   (7) what a business said on a call made for them is shown marked and can never be cited as theirs
//   (8) an unverified caller's words are not theirs either; a forgotten call line is never read
//   (9) the extractor is told who is speaking on a call: a business is never "the user"
//  (10) patterns: two different days of their own messages, or it is refused; sensitive refused;
//       kept as a guess (never a fact), on the memory page, removable; a no to patterns reads nobody
//
// No model, no network, no API key.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-dream-cov-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Ama";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_BACKEND = "claude-cli";

const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const dream = await import("../src/dream.js");
const extract = await import("../src/extract.js");
const memory = await import("../src/memory.js");
const webmemory = await import("../src/pages/webmemory.js");
const daily = await import("../src/daily.js");
const { cliConfig } = await import("../src/backends/cli.js");
cliConfig.bin = join(dir, "no-claude-here");

const C = "dm:cov-ama";      // the operator
const K = "dm:cov-kojo";     // somebody invited
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025550111", name: "Ama", isOperator: true });
db.upsertAccount({ conversationId: K, channel: "test", address: "+12025550112", name: "Kojo", isOperator: false });

const DAY = 24 * 3600_000;
const NIGHT = Date.parse("2026-11-12T09:30:00Z");   // 4:30am in New York
const NOON = Date.parse("2026-11-12T17:00:00Z");    // noon in New York, after the window
const empty = { facts: [], rules_new: [], rules_merge: [], rules_retire: [] };
const noRebuild = async () => {};
const UP = 60 * 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_BACKEND = "claude-cli";
  config.reviewCalls = "off";
  config.reviewPatterns = "off";
  dream.resetDreams();
  db.db.exec(`DELETE FROM person_facts; DELETE FROM people; DELETE FROM event_log; DELETE FROM treat_rules; DELETE FROM calls;
    DELETE FROM memory_reviews; DELETE FROM memory_review_passes; DELETE FROM profile_blocks; DELETE FROM guesses; DELETE FROM recall_forgotten;
    UPDATE accounts SET patterns = NULL, patterns_said = NULL;`);
});

const say = (c, role, content, at, extra = {}) => db.writeEvent({ conversationId: c, role, content, at, ...extra });
/** A finished call and its lines in the event log, the way src/calls/postcall.js writes them. */
function call(c, { own = true, direction = "out", verified = false, at = NIGHT - 3600_000, lines = [] } = {}) {
  const row = db.createCall(c, { provider: "gptlive", toNumber: "+12025550199", isOwner: own, goal: "a call", facts: [], direction, state: "completed" });
  if (verified) db.updateCall(c, row.id, { verified_at: at });
  const ids = lines.map(([who, text], i) => say(c, who === "them" ? "call_user" : "call_assistant", text, at + i * 1000, { channel: "call", messageId: String(row.id) }));
  return { id: row.id, ids };
}
const msgOf = (prompt, words) => Number(new RegExp(`\\[m(\\d+)\\] \\([^)]*\\): [^\\n]*${words}`).exec(prompt)?.[1]);
/** A sweep whose queued jobs run at once; resolves when they have. */
async function sweep(now, { uptimeMs = UP } = {}) {
  const jobs = [];
  clock.reset(); clock.skip(now - Date.now());
  const out = dream.sweepDreams({ now, uptimeMs, queue: (key, fn) => { const p = Promise.resolve().then(fn); jobs.push(p); return p; } });
  await Promise.all(jobs);
  await new Promise(r => setTimeout(r, 5));
  return out;
}

// ---------------------------------------------------------------- coverage

test("(1) never reviewed, every message older than a week: the first review reads their newest messages", async () => {
  say(K, "user", "i'm a carpenter in tema", NIGHT - 20 * DAY);
  say(K, "assistant", "nice", NIGHT - 20 * DAY + 1000);
  let seen = "";
  const out = await dream.reviewOne(K, { now: NIGHT, rebuild: noRebuild, ask: async ({ prompt }) => { seen = prompt; return { value: empty }; } });
  assert.equal(out.ok, true, "read, not 'nothing new'");
  assert.match(seen, /carpenter in tema/);
  const st = db.memoryReviewState(K);
  assert.equal(st.last_outcome, "reviewed");
  assert.ok(st.last_event_id > 0, "the watermark moved, so they are not queued for nothing every night");
  // Nothing new since: the next night's sweep leaves them alone.
  dream.setDreamAsk(async () => { throw new Error("must not be asked"); });
  assert.equal((await sweep(NIGHT + DAY)).queued, 0);
});

test("(1b) a first review with something this week still reads only the week", async () => {
  say(K, "user", "old thing from the summer", NIGHT - 40 * DAY);
  say(K, "user", "new thing from yesterday", NIGHT - DAY);
  let seen = "";
  await dream.reviewOne(K, { now: NIGHT, rebuild: noRebuild, ask: async ({ prompt }) => { seen = prompt; return { value: empty }; } });
  assert.match(seen, /new thing from yesterday/);
  assert.doesNotMatch(seen, /old thing from the summer/);
});

test("(2) a missed window is caught up later the same day, once", async () => {
  say(K, "user", "we moved to denver", NIGHT - 3600_000);
  let asks = 0;
  dream.setDreamAsk(async () => { asks++; return { value: empty }; });
  // The server was down from 4 to 7. At noon:
  const out = await sweep(NOON);
  assert.equal(out.queued, 1);
  assert.equal(out.caught_up, 1);
  assert.equal(asks, 1);
  assert.equal(db.memoryReviewState(K).last_day, "2026-11-12");
  assert.equal((await sweep(NOON + 3600_000)).queued, 0, "done for today");
  assert.equal(asks, 1);
});

test("(2b) before tonight's hour nothing is due", async () => {
  say(K, "user", "hello there", NIGHT - 3 * 3600_000);
  dream.setDreamAsk(async () => ({ value: empty }));
  assert.equal((await sweep(Date.parse("2026-11-12T07:00:00Z"))).queued, 0, "2am in New York");
});

test("(3) a restart storm cannot ask again: the ask is on disk, and a fresh boot starts no catch-up", async () => {
  say(K, "user", "i start the new job monday", NIGHT - 3600_000);
  let asks = 0;
  dream.setDreamAsk(async () => { asks++; return { value: empty }; });
  // A process that booted a minute ago does not start a catch-up at all.
  assert.equal((await sweep(NOON, { uptimeMs: 60_000 })).queued, 0);
  // A pass is queued and the process dies before it finishes (the job never runs).
  const dead = dream.sweepDreams({ now: NOON, uptimeMs: UP, queue: () => new Promise(() => {}) });
  assert.equal(dead.queued, 1);
  // Ten restarts over the next hours: the same person is not asked again inside the gap.
  for (let i = 1; i <= 10; i++) {
    dream.resetDreams();   // what a restart does to process memory
    dream.setDreamAsk(async () => { asks++; return { value: empty }; });
    assert.equal((await sweep(NOON + i * 20 * 60_000)).queued, 0, `restart ${i}`);
  }
  assert.equal(asks, 0);
  // Past the gap it is asked, once.
  dream.resetDreams();
  dream.setDreamAsk(async () => { asks++; return { value: empty }; });
  assert.equal((await sweep(NOON + dream.CATCHUP_GAP_MS + 60_000)).queued, 1);
  assert.equal(asks, 1);
});

test("(3b) in the window, a pass cut off by a restart is asked again only after half an hour", async () => {
  say(K, "user", "i got the keys today", NIGHT - 3600_000);
  dream.setDreamAsk(async () => ({ value: empty }));
  assert.equal(dream.sweepDreams({ now: NIGHT, uptimeMs: 0, queue: () => new Promise(() => {}) }).queued, 1);
  dream.resetDreams();
  let asks = 0;
  dream.setDreamAsk(async () => { asks++; return { value: empty }; });
  assert.equal((await sweep(NIGHT + 5 * 60_000, { uptimeMs: 0 })).queued, 0);
  assert.equal((await sweep(NIGHT + 31 * 60_000, { uptimeMs: 0 })).queued, 1, "the window needs no settle time");
  assert.equal(asks, 1);
});

test("(4) a backlog past the caps gets another pass the same day, and never more than three asks a day", async () => {
  for (let i = 0; i < dream.MAX_MESSAGES * 4 + 20; i++) say(K, "user", `thing number ${i} that i said`, NIGHT - 2 * DAY + i * 1000);
  let asks = 0;
  dream.setDreamAsk(async () => { asks++; return { value: empty }; });
  assert.equal((await sweep(NIGHT)).queued, 1);
  assert.equal(db.memoryReviewState(K).last_outcome, "reviewed_more");
  const wm1 = db.memoryReviewState(K).last_event_id;
  assert.equal((await sweep(NIGHT + 3600_000)).queued, 0, "not again inside the gap");
  assert.equal((await sweep(NIGHT + dream.CATCHUP_GAP_MS + 1000)).queued, 1);
  assert.ok(db.memoryReviewState(K).last_event_id > wm1, "the second pass read on from the first");
  assert.equal((await sweep(NIGHT + 2 * dream.CATCHUP_GAP_MS + 2000)).queued, 1);
  assert.equal((await sweep(NIGHT + 3 * dream.CATCHUP_GAP_MS + 3000)).queued, 0, "three asks a day at most");
  assert.equal(asks, dream.MAX_PASSES_PER_DAY);
});

test("(5) an ask that was skipped at 4am is tried again later that day", async () => {
  say(K, "user", "my brother kwame is visiting", NIGHT - 3600_000);
  dream.setDreamAsk(async () => ({ error: new Error("usage limit reached") }));
  await sweep(NIGHT);
  assert.match(db.memoryReviewState(K).last_outcome, /^skipped:/);
  let asked = 0;
  dream.setDreamAsk(async () => { asked++; return { value: empty }; });
  assert.equal((await sweep(NIGHT + 3600_000)).queued, 0);
  assert.equal((await sweep(NIGHT + dream.CATCHUP_GAP_MS + 1000)).queued, 1);
  assert.equal(asked, 1);
  assert.equal(db.memoryReviewState(K).last_outcome, "reviewed");
});

test("the API backend still skips everything, catch-up included", async () => {
  say(K, "user", "hello", NIGHT - 3600_000);
  process.env.REASON_BACKEND = "api";
  assert.equal(dream.sweepDreams({ now: NOON, uptimeMs: UP }).skipped, "not_on_cli");
});

// ---------------------------------------------------------------- calls

test("(6) what they said on their own call is read and cited like a text", async () => {
  config.reviewCalls = "on";
  const m1 = say(K, "user", "i live in harlem", NIGHT - 5 * 3600_000);
  const f = db.remember(K, "Kojo", "Lives in Harlem", { source: "inferred", confidence: 0.8, sourceMessageIds: [m1] }).factId;
  const { ids } = call(K, { lines: [["them", "we moved to the bronx last week by the way"], ["reason", "oh nice, noted"]] });
  let seen = "";
  const out = await dream.reviewOne(K, {
    now: NIGHT, rebuild: noRebuild,
    ask: async ({ prompt, system }) => {
      seen = prompt;
      assert.match(system, /said on a phone call/);
      return { value: { ...empty, facts: [{ id: f, action: "correct", wording: "Lives in the Bronx", message: msgOf(prompt, "moved to the bronx") }] } };
    },
  });
  assert.match(seen, new RegExp(`\\[m${ids[0]}\\] \\(user, on a phone call, [^)]*\\): we moved to the bronx`));
  assert.match(seen, new RegExp(`\\[m${ids[1]}\\] \\(assistant, on a phone call with them, `));
  assert.equal(out.corrected, 1);
  assert.deepEqual(db.activeFacts(K).map(x => x.fact), ["Lives in the Bronx"]);
});

test("(6b) switch off: calls are not in the read, and a call alone does not queue a review", async () => {
  call(K, { lines: [["them", "we moved to the bronx last week by the way"]] });
  dream.setDreamAsk(async () => { throw new Error("must not be asked"); });
  assert.equal((await sweep(NIGHT)).queued, 0);
  config.reviewCalls = "owner";
  assert.equal(dream.reviewCallsFor(K), false);
  assert.equal(dream.reviewCallsFor(C), true);
  assert.equal((await sweep(NIGHT)).queued, 0, "'owner' is the operator only");
  config.reviewCalls = "on";
  dream.setDreamAsk(async () => ({ value: empty }));
  assert.equal((await sweep(NIGHT)).queued, 1, "on: something said on a call is something said");
});

test("(7) a business's words on a call made for them are marked and can never be cited as theirs", async () => {
  config.reviewCalls = "on";
  const m1 = say(K, "user", "book me a table at lucali for friday", NIGHT - 5 * 3600_000);
  const f = db.remember(K, "Kojo", "Wants a table at Lucali on Friday", { source: "inferred", confidence: 0.8, sourceMessageIds: [m1] }).factId;
  const { ids } = call(K, { own: false, lines: [["them", "we're closed fridays, and honestly you should stop sending so many texts"], ["reason", "understood, thanks"]] });
  let seen = "";
  const out = await dream.reviewOne(K, {
    now: NIGHT, rebuild: noRebuild,
    ask: async ({ prompt }) => {
      seen = prompt;
      return { value: { ...empty,
        facts: [{ id: f, action: "retire", message: ids[0] }, { id: f, action: "correct", wording: "Does not want a table", message: ids[0] }],
        rules_new: [{ rule: "Send fewer texts", why: "said so", message: ids[0] }] } };
    },
  });
  assert.match(seen, new RegExp(`\\[m${ids[0]}\\] \\(other, the other side of a call made for them — not the person, `));
  assert.equal(out.retired, 0);
  assert.equal(out.corrected, 0);
  assert.equal(out.rules_added, 0);
  assert.ok(out.refused >= 2);
  assert.deepEqual(db.activeFacts(K).map(x => x.fact), ["Wants a table at Lucali on Friday"]);
  assert.equal(db.activeRules(K).length, 0);
  // And a call to a business alone is not "they said something".
  assert.equal(db.hasEventsSince(K, m1, { calls: true }), false);
});

test("(8) an unverified caller is not the person; a verified inbound call is; a forgotten call line is never read", async () => {
  config.reviewCalls = "on";
  say(K, "user", "morning", NIGHT - 6 * 3600_000);
  const spoof = call(K, { direction: "in", verified: false, lines: [["them", "stop reminding me about rent forever"]] });
  const real = call(K, { direction: "in", verified: true, lines: [["them", "please never ring me before nine"], ["them", "my pin is something i regret saying"]] });
  db.db.prepare("INSERT INTO recall_forgotten (conversation_id, source_table, row_id, at) VALUES (?, 'event_log', ?, ?)").run(K, real.ids[1], NIGHT);
  let seen = "";
  const out = await dream.reviewOne(K, {
    now: NIGHT, rebuild: noRebuild,
    ask: async ({ prompt }) => {
      seen = prompt;
      return { value: { ...empty, rules_new: [
        { rule: "Stop rent reminders", why: "asked", message: spoof.ids[0] },
        { rule: "Don't ring before 9am", why: "asked on a call", message: real.ids[0] },
      ] } };
    },
  });
  assert.match(seen, /\(caller, on a phone call, caller not verified — not the person, /);
  assert.doesNotMatch(seen, /regret saying/);
  assert.equal(out.rules_added, 1);
  assert.deepEqual(db.activeRules(K).map(r => r.rule), ["Don't ring before 9am"]);
});

test("(9) the extractor is told who is speaking on a call", () => {
  const own = call(K, { lines: [["them", "my daughter abena starts school in january"], ["reason", "lovely"]] });
  const biz = call(K, { own: false, lines: [["them", "i have two kids myself and we close at nine"], ["reason", "thanks"]] });
  const ev = (id) => db.db.prepare("SELECT * FROM event_log WHERE id = ?").get(id);
  assert.equal(extract.speakerOf(ev(own.ids[0])), "user, said on a phone call");
  assert.equal(extract.speakerOf(ev(biz.ids[0])), extract.OTHER_PARTY);
  const { prompt } = extract.batchPrompt(K, [ev(own.ids[0]), ev(biz.ids[0])], "");
  assert.match(prompt, /\[1\] \(user, said on a phone call\):\nmy daughter abena/);
  assert.match(prompt, /\[2\] \(other party on a phone call the assistant made for the user — NOT the user\):\ni have two kids/);
  assert.doesNotMatch(prompt, /\(call_user\)/);
  assert.equal(extract.speakerOf({ role: "user" }), "user");
});

// ---------------------------------------------------------------- patterns across days

/** Three weeks of somebody asking the same thing on different days. */
function weeks(c) {
  const ids = [];
  for (const d of [20, 13, 6, 6]) ids.push(say(c, "user", `what's the weather before i head to the site (${d})`, NIGHT - d * DAY + (ids.length * 60_000)));
  ids.push(say(c, "user", "you sent three options again, just pick one", NIGHT - 9 * DAY));
  ids.push(say(c, "assistant", "sorry — here's the one", NIGHT - 9 * DAY + 1000));
  return ids;
}
const patternAnswer = (patterns, still = []) => async ({ feature }) => feature === "memory_patterns" ? { value: { patterns, still } } : { value: empty };

test("(10) off by default; 'owner' is the operator; 'on' needs their own yes; a no always wins", () => {
  assert.equal(dream.patternsFor(C), false);
  config.reviewPatterns = "owner";
  assert.equal(dream.patternsFor(C), true);
  assert.equal(dream.patternsFor(K), false);
  config.reviewPatterns = "on";
  assert.equal(dream.patternsFor(K), false, "nobody is read who has not said yes");
  db.setPatterns(K, { patterns: "on", said: "yeah go for it", setAt: NIGHT });
  assert.equal(dream.patternsFor(K), true);
  db.setPatterns(C, { patterns: "off", said: "stop reading into my texts", setAt: NIGHT });
  assert.equal(dream.patternsFor(C), false, "the operator's own no wins over the switch");
});

test("(10a) a recurring ask on two different days is kept as a guess with its receipts, never a fact", async () => {
  config.reviewPatterns = "owner";
  const ids = weeks(C);
  let seen = "";
  const logs = [];
  const out = await dream.noticePatterns(C, {
    now: NIGHT, log: (l) => logs.push(l),
    ask: async ({ prompt, system, feature }) => {
      seen = prompt;
      assert.equal(feature, "memory_patterns");
      assert.match(system, /at least two DIFFERENT days/);
      return { value: { still: [], patterns: [
        { kind: "repeated_ask", pattern: "asks for the weather before heading to the site", use: "offer the weather in the morning", messages: [ids[0], ids[1], ids[2]], sensitive: false },
      ] } };
    },
  });
  assert.equal(out.noticed, 1);
  assert.doesNotMatch(seen, /here's the one/, "only their own lines are read");
  const rows = db.listNoticed(C);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].how, db.NOTICED_SOURCE);
  assert.deepEqual(rows[0].evidence.map(e => e.ref), ids.slice(0, 3).map(i => `m${i}`));
  assert.equal(new Set(rows[0].evidence.map(e => e.day)).size, 3);
  assert.equal(db.activeFacts(C).length, 0, "not a fact");
  // On the memory page as something Reason thinks, said as a pattern; and in memory_list as a guess.
  const page = webmemory.memoryView(db.getAccount(C));
  const listed = memory.remembered({ conversationId: C, now: NIGHT });
  const g = listed.guesses.find(x => x.id === rows[0].id);
  assert.equal(g.noticed_pattern, true);
  assert.equal(g.on_days, 3);
  assert.match(g.how, /a pattern I think I see, not something they told me/);
  if (page) assert.match(page.guesses.find(x => x.id === rows[0].id).text, /a pattern noticed on 3 different days/);
  // The log carries counts, never the words.
  assert.doesNotMatch(JSON.stringify(logs), /weather|site/);
  // Nothing is texted about it: the daily question never picks a noticed pattern.
  assert.equal(daily.questionFor(C, "2026-11-12", NIGHT), null);
});

test("(10b) one day, a made-up citation, the assistant's line, an unknown kind or a sensitive one: refused", async () => {
  config.reviewPatterns = "owner";
  const ids = weeks(C);
  const out = await dream.noticePatterns(C, { now: NIGHT, ask: patternAnswer([
    { kind: "repeated_ask", pattern: "asks twice on one day", use: "x", messages: [ids[2], ids[3]], sensitive: false },
    { kind: "repeated_ask", pattern: "rests on nothing shown", use: "x", messages: [999991, 999992], sensitive: false },
    { kind: "assistant_mistake", pattern: "rests on the assistant's own line", use: "x", messages: [ids[4], ids[5]], sensitive: false },
    { kind: "mood", pattern: "seems low on mondays", use: "x", messages: [ids[0], ids[1]], sensitive: false },
    { kind: "routine", pattern: "goes to the clinic every week", use: "x", messages: [ids[0], ids[1]], sensitive: true },
    { kind: "routine", pattern: "no sensitive flag given at all", use: "x", messages: [ids[0], ids[1]] },
  ]) });
  assert.equal(out.noticed, 0);
  assert.equal(out.refused, 6);
  assert.equal(db.listNoticed(C).length, 0);
});

test("(10c) once a week; borne out again it is supported, not doubled; unsupported for four weeks it expires", async () => {
  config.reviewPatterns = "owner";
  const ids = weeks(C);
  const p = { kind: "repeated_ask", pattern: "asks for the weather before heading to the site", use: "offer it", messages: [ids[0], ids[1]], sensitive: false };
  await dream.noticePatterns(C, { now: NIGHT, ask: patternAnswer([p]) });
  const id = db.listNoticed(C)[0].id;
  assert.deepEqual(await dream.noticePatterns(C, { now: NIGHT + DAY, ask: async () => { throw new Error("not due"); } }), { skipped: "not_due" });
  // A week on: the same thing again, by its N-number and by the same words — one row, fresh receipts.
  const again = await dream.noticePatterns(C, { now: NIGHT + 7 * DAY + 1000, ask: async ({ prompt }) => {
    assert.match(prompt, new RegExp(`N${id} asks for the weather`));
    return { value: { patterns: [p], still: [{ id, messages: [ids[2]] }] } };
  } });
  assert.equal(again.noticed, 0);
  assert.equal(again.supported, 2);
  assert.equal(db.listNoticed(C).length, 1);
  // Five weeks with nothing bearing it out: gone.
  const later = await dream.noticePatterns(C, { now: NIGHT + 7 * DAY + 29 * DAY, ask: patternAnswer([]) });
  assert.equal(later.expired, 1);
  assert.equal(db.listNoticed(C).length, 0);
});

test("(10d) theirs to remove: a dismissed one is never noticed again, and a no to patterns deletes them all", async () => {
  config.reviewPatterns = "owner";
  const ids = weeks(C);
  const p = { kind: "repeated_ask", pattern: "asks for the weather before heading to the site", use: "offer it", messages: [ids[0], ids[1]], sensitive: false };
  const q = { kind: "assistant_mistake", pattern: "has had to say 'just pick one' more than once", use: "send one option", messages: [ids[4], ids[0]], sensitive: false };
  await dream.noticePatterns(C, { now: NIGHT, ask: patternAnswer([p, q]) });
  assert.equal(db.listNoticed(C).length, 2);
  const row = db.listNoticed(C).find(r => /weather/.test(r.guess));
  assert.equal(db.dismissGuess(C, row.id).ok, true);
  const out = await dream.noticePatterns(C, { now: NIGHT + 8 * DAY, ask: patternAnswer([p]) });
  assert.equal(out.noticed, 0);
  assert.equal(db.listNoticed(C).length, 1, "the one they said no to stays gone");
  db.dropPatterns(C);
  assert.equal(db.listNoticed(C).length, 0);
  db.setPatterns(C, { patterns: "off", said: "stop reading into my texts", setAt: NIGHT });
  assert.deepEqual(await dream.noticePatterns(C, { now: NIGHT + 30 * DAY, ask: async () => { throw new Error("nobody who said no is read"); } }), { skipped: "off" });
});

test("(10e) the pass rides behind the nightly review, and never costs it", async () => {
  config.reviewPatterns = "owner";
  const ids = weeks(C);
  say(C, "user", "morning", NIGHT - 3600_000);
  const features = [];
  dream.setDreamAsk(async ({ feature }) => {
    features.push(feature);
    if (feature === "memory_patterns") throw new Error("the CLI fell over");
    return { value: empty };
  });
  const logs = [];
  const out = await dream.reviewOne(C, { now: NIGHT, rebuild: noRebuild, log: (l) => logs.push(l) });
  assert.equal(out.ok, true);
  assert.deepEqual(features, ["memory_review", "memory_patterns"]);
  assert.equal(db.memoryReviewState(C).last_outcome, "reviewed");
  assert.ok(logs.some(l => l.memory_patterns === "skipped"), "and it is tried again the next night, not next week");
  assert.ok(db.memoryReviewState(C).patterns_at < NIGHT - 5 * DAY);
  // Somebody the switch does not cover is never asked a second question.
  say(K, "user", "morning", NIGHT - 3600_000);
  say(K, "user", "morning again", NIGHT - 3 * DAY);
  features.length = 0;
  await dream.reviewOne(K, { now: NIGHT, rebuild: noRebuild });
  assert.deepEqual(features, ["memory_review"]);
  void ids;
});
