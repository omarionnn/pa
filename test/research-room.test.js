// Research room: every planned query gets searched, big questions get more room, and a run a cap
// still cuts short gets ONE background follow-up — bounded per person per day.
//
// Run #78 (2026-10-30 01:04 UTC) is the shape: four planned queries, the first returned enough to
// fill all eight pages, and Stripe / Skyfire / Payman were never searched. No model, no key, no
// network: the provider is the fake, every page is a fake read, the wake is a scripted turn.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-research-room-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_TASK_MAX_ATTEMPTS = "3";
delete process.env.TAVILY_API_KEY;
delete process.env.PARALLEL_API_KEY;

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const { fakeProvider } = await import("../src/search.js");
const research = await import("../src/research.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "dm:research-room";
const FRIEND = "dm:research-room-friend";
db.upsertAccount({ conversationId: OWNER, channel: "test", address: "+12025550101", name: "Omari", isOperator: true });
db.upsertAccount({ conversationId: FRIEND, channel: "test", address: "+12025550102", name: "Ama", isOperator: false });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  // Noon in New York, so a follow-up's wake is never held for somebody's night (runtime sleepsUntil).
  clock.reset();
  clock.skip(Date.parse("2026-10-30T16:00:00Z") - clock.now());
  db.db.exec("DELETE FROM research; DELETE FROM research_sources; DELETE FROM research_queries;"
    + " DELETE FROM tasks; DELETE FROM task_log; DELETE FROM action_ledger; DELETE FROM seen_urls;");
});

/** `n` results for one query, each on its own site so the one-per-site rule does not hide anything. */
const hits = (tag, n) => Array.from({ length: n }, (_, i) => ({
  title: `${tag} ${i}`, url: `https://${tag}-${i}.example/page`, snippet: `${tag} ${i} snippet`,
}));
const openRobots = async () => ({ allowed: true, checked: false, why: "fixture", rule: null });
const lookup = async (url) => ({ ok: true, url, title: `page at ${url}`, text: `what ${url} says`, images: [] });
const deps = (p, caps = {}) => ({ searchProvider: p, robots: openRobots, lookup, researchCaps: caps });
const call = (c, input, ctx) => runTool("research", input, { conversationId: c, ...ctx });
const tasksIn = (c) => db.db.prepare("SELECT * FROM tasks WHERE conversation_id = ?").all(c);
const readFrom = (out, tag) => out.sources.filter(s => s.url.includes(`//${tag}-`)).length;

// The four queries run #78 planned, word for word, and what each of them turns up.
const Q78 = [
  "Visa Intelligent Commerce vs Mastercard Agent Pay passkey per purchase",
  "Stripe agentic commerce issuing for agents saved payment methods per user",
  "AgentCard vs Basis Theory vs Skyfire vs Payman AI agent payments",
  "reddit building AI agent that buys things card vault passkey",
];
const provider78 = () => fakeProvider({ answers: {
  [Q78[0]]: hits("networks", 8), [Q78[1]]: hits("stripe", 3), [Q78[2]]: hits("startups", 3), [Q78[3]]: hits("reddit", 3),
} });
const MAIN_CAPS = { maxSearches: 5, maxPages: 8, maxSeconds: 90 }; // origin/main's defaults, pinned

test("run #78: one query that could fill every page no longer crowds out the other three", async () => {
  const p = provider78();
  const out = await call(OWNER, {
    question: "which service can vault each user's card with a passkey per agent purchase", kind: "choice", queries: Q78,
  }, deps(p, MAIN_CAPS));

  assert.equal(out.ok, true);
  assert.deepEqual(p.calls.map(c => c.query), Q78, "every planned query was searched");
  assert.equal(out.searches_used, 4);
  assert.deepEqual(out.queries_left, []);
  assert.equal(out.pages_read, 8, "the page cap still holds");
  for (const tag of ["networks", "stripe", "startups", "reddit"]) {
    assert.ok(readFrom(out, tag) >= 2, `${tag}: at least its fair share was read`);
  }
  // Snippets are always logged: the first query's unread results are still there to quote.
  assert.ok(out.snippets_only.some(s => s.url.includes("//networks-")));
  assert.equal(out.follow_up, undefined, "nothing was left unsearched, so nothing is owed later");
  assert.equal(db.getResearch(OWNER, out.research_id).state, "done");
});

test("leftover pages go to the best remaining picks once every query has had its share", async () => {
  const p = fakeProvider({ answers: { a: hits("a", 10), b: hits("b", 1) } });
  const out = await call(OWNER, { question: "a or b?", queries: ["a", "b"] }, deps(p, MAIN_CAPS));
  assert.equal(out.pages_read, 8, "b had one result, so a's unread ones took the rest of the room");
  assert.equal(readFrom(out, "b"), 1);
  assert.equal(readFrom(out, "a"), 7);
  assert.equal(out.cut_short, "pages", "more was worth reading than the budget allowed, and it says so");
});

test("big questions get more room; small ones keep today's caps", async () => {
  assert.equal(research.isBig({ kind: "choice", queries: ["x"] }), true);
  assert.equal(research.isBig({ kind: "fact", queries: ["x", "y", "z"] }), true);
  assert.equal(research.isBig({ kind: "fact", queries: ["x"], options: ["a", "b", "c"] }), true);
  assert.equal(research.isBig({ kind: "fact", queries: ["x", "y"], options: ["a", "b"] }), false);
  assert.deepEqual(research.capsFor({ big: false }), { maxSearches: 5, maxPages: 8, maxSeconds: 90 });
  assert.deepEqual(research.capsFor({ big: true }), { maxSearches: 8, maxPages: 14, maxSeconds: 150 });

  const small = await call(OWNER, { question: "small?", kind: "fact", queries: ["s1", "s2"] },
    deps(fakeProvider({ answers: { "*": hits("small", 8) } })));
  assert.equal(db.getResearch(OWNER, small.research_id).big, false);
  assert.equal(small.pages_read, 8);

  const big = await call(OWNER, { question: "big?", kind: "choice", queries: ["b1", "b2"], new_subject: true },
    deps(fakeProvider({ answers: { b1: hits("big1", 8), b2: hits("big2", 8) } })));
  assert.equal(db.getResearch(OWNER, big.research_id).big, true);
  assert.equal(big.pages_read, 14);

  const named = await call(OWNER, { question: "which of three?", kind: "fact", queries: ["n1"], options: ["x", "y", "z"], new_subject: true },
    deps(fakeProvider({ answers: { "*": hits("named", 20) } })));
  assert.equal(db.getResearch(OWNER, named.research_id).big, true, "three named options is big");

  const tenQ = Array.from({ length: 10 }, (_, i) => `q${i}`);
  const wide = await call(OWNER, { question: "wide?", kind: "choice", queries: tenQ, new_subject: true },
    deps(fakeProvider({ answers: { "*": [] } })));
  assert.equal(wide.searches_used, 8, "a big run gets eight searches");
});

test("cut with queries left: one follow-up task, its wake carries the same run on and texts once", async () => {
  const p = fakeProvider({ answers: { "*": hits("x", 2), q3: hits("late", 2), q4: hits("later", 2) } });
  const first = await call(OWNER, { question: "which agent card service?", kind: "fact", queries: ["q1", "q2", "q3", "q4"] },
    deps(p, { maxSearches: 2 }));

  assert.equal(first.cut_short, "searches");
  assert.deepEqual(first.queries_left, ["q3", "q4"]);
  assert.equal(first.follow_up?.scheduled, true);
  assert.match(first.follow_up_note, /still digging/i);
  assert.doesNotMatch(first.follow_up_note, /"/, "intent, never words to type");
  const tasks = tasksIn(OWNER);
  assert.equal(tasks.length, 1, "exactly one follow-up task");
  assert.equal(first.follow_up.task_id, tasks[0].id);
  const run = db.getResearch(OWNER, first.research_id);
  assert.equal(run.continue_task_id, tasks[0].id);
  assert.equal(run.state, "open", "kept open for the follow-up");

  const sent = [];
  let wake = null;
  const rt = new Runtime({
    runTurn: async ({ text }) => {
      assert.match(text, new RegExp(`research_id ${first.research_id}`), "the wake knows which run to carry on");
      wake = await runTool("research", { research_id: first.research_id }, { conversationId: OWNER, ...deps(p, { maxSearches: 2 }) });
      return "two more turned up: late 0 and later 0 — doesn't change the pick";
    },
  });
  rt.on("outbound", (m) => sent.push(m));

  clock.skip((config.researchContinueWakeMin + 1) * 60_000);
  const out = await rt.runTasks();
  assert.equal(out.woke, 1);
  assert.equal(wake.ok, true);
  assert.equal(wake.research_id, first.research_id, "the same run, not a new one");
  assert.deepEqual(p.calls.map(c => c.query), ["q1", "q2", "q3", "q4"], "the fresh slice ran what was left");
  assert.ok(readFrom(wake, "late") >= 1 && readFrom(wake, "later") >= 1);
  assert.equal(wake.follow_up?.delivering, true);
  assert.match(wake.follow_up_note, /only what is new/i);
  assert.equal(sent.length, 1, "one follow-up text");
  assert.equal(sent[0].fromTask, tasks[0].id);

  assert.equal(db.getTask(OWNER, tasks[0].id).state, "done");
  assert.equal(db.getResearch(OWNER, first.research_id).state, "done");

  // Never a stream: nothing wakes for it again, however long it waits.
  clock.skip(24 * 60 * 60_000);
  const later = await rt.runTasks();
  assert.equal(later.woke, 0);
  assert.equal(sent.length, 1);
});

test("a follow-up never chains into another, even when its own slice is cut short too", async () => {
  const many = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const p = fakeProvider({ answers: { "*": hits("m", 2) } });
  const caps = { maxSearches: 2, continueSearches: 2 };
  const first = await call(OWNER, { question: "lots?", kind: "fact", queries: many.slice(0, 2).concat(many.slice(2)) }, deps(p, caps));
  assert.equal(first.follow_up?.scheduled, true);

  const again = await call(OWNER, { research_id: first.research_id }, deps(p, caps));
  assert.equal(again.searches_used, 4);
  assert.equal(again.queries_left.length, 4, "still cut short, with queries left");
  assert.equal(again.follow_up?.delivering, true, "this carry-on is the follow-up");
  assert.equal(again.follow_up?.scheduled, undefined, "and it schedules no other");
  assert.equal(tasksIn(OWNER).length, 1, "still exactly one follow-up task");
  assert.equal(db.getResearch(OWNER, first.research_id).state, "done", "the run closes; no more digging on it");
});

test("calling it enough cancels the follow-up: nothing is owed", async () => {
  const p = fakeProvider({ answers: { "*": hits("e", 2) } });
  const first = await call(OWNER, { question: "enough?", kind: "fact", queries: ["e1", "e2", "e3"] }, deps(p, { maxSearches: 1 }));
  assert.equal(first.follow_up?.scheduled, true);
  await call(OWNER, { research_id: first.research_id, enough: true, enough_why: "the maker page settles it" }, deps(p));
  assert.equal(db.getTask(OWNER, first.follow_up.task_id).state, "cancelled");
});

test("a deep run gets no extra follow-up: its own task already wakes for it", async () => {
  const p = fakeProvider({ answers: { "*": hits("d", 2) } });
  const out = await call(OWNER, { question: "deep?", queries: ["d1", "d2"], deep: true }, deps(p, { maxSearches: 1 }));
  assert.ok(out.task_id);
  assert.equal(out.follow_up, undefined);
  assert.equal(tasksIn(OWNER).length, 1);
});

test("per-day cap: a third follow-up is refused for a non-owner, and the next day it resets", async () => {
  const p = fakeProvider({ answers: { "*": hits("f", 2) } });
  const ask = (n) => call(FRIEND, { question: `question ${n}?`, kind: "fact", queries: ["f1", "f2"], new_subject: true }, deps(p, { maxSearches: 1 }));

  assert.equal((await ask(1)).follow_up?.scheduled, true);
  assert.equal((await ask(2)).follow_up?.scheduled, true);
  const third = await ask(3);
  assert.equal(third.follow_up?.scheduled, false);
  assert.equal(third.follow_up.why, "daily_limit");
  assert.match(third.follow_up_note, /based on what you got/i);
  assert.match(third.follow_up_note, /offer to keep looking/i);
  assert.equal(tasksIn(FRIEND).length, 2);

  clock.skip(24 * 60 * 60_000);
  assert.equal((await ask(4)).follow_up?.scheduled, true, "a new day, a new allowance");

  // The owner's allowance is bigger.
  const own = [];
  for (let i = 0; i < 6; i++) {
    own.push((await call(OWNER, { question: `owner ${i}?`, kind: "fact", queries: ["o1", "o2"], new_subject: true }, deps(p, { maxSearches: 1 }))).follow_up?.scheduled);
  }
  assert.deepEqual(own, [true, true, true, true, true, false]);
});

// ---------------------------------------------------------------------------
// the follow-up is one-shot in code, whatever its wake does
// ---------------------------------------------------------------------------

const cutRun = async (tag) => {
  const p = fakeProvider({ answers: { "*": hits(tag, 2) } });
  const first = await call(OWNER, { question: `${tag}?`, kind: "fact", queries: [`${tag}1`, `${tag}2`, `${tag}3`] }, deps(p, { maxSearches: 1 }));
  assert.equal(first.follow_up?.scheduled, true);
  return { p, first, taskId: first.follow_up.task_id };
};

test("a wake that never carries the run on: the task closes, nothing wakes again, the run stops blocking", async () => {
  const { first, taskId } = await cutRun("idle");
  let turns = 0;
  const sent = [];
  const rt = new Runtime({
    runTurn: async () => {
      turns++;
      await runTool("task_update", { task_id: taskId, progress: "looked at it", wake_in_minutes: 15 }, { conversationId: OWNER });
      return "NO_REPLY";
    },
  });
  rt.on("outbound", (m) => sent.push(m));

  clock.skip((config.researchContinueWakeMin + 1) * 60_000);
  assert.equal((await rt.runTasks()).woke, 1);
  assert.equal(db.getTask(OWNER, taskId).open, false, "closed after its one wake");
  assert.equal(db.getResearch(OWNER, first.research_id).state, "done", "and so is the run");

  for (let i = 0; i < 8; i++) { clock.skip(20 * 60_000); await rt.runTasks(); }
  assert.equal(turns, 1, "it never wakes a second time");
  assert.equal(sent.filter(m => /keeps breaking|gotten nowhere/.test(m.text)).length, 0, "no gave-up text");

  const next = await call(OWNER, { question: "a new question", kind: "fact", queries: ["n1"] },
    deps(fakeProvider({ answers: { "*": hits("n", 1) } })));
  assert.notEqual(next.blocked, "research_open", "the closed run no longer blocks new research");
});

test("the follow-up's step errors: the wake still gets a note to send one honest line", async () => {
  const { first, taskId } = await cutRun("boom");
  const p = fakeProvider({ answers: { "*": hits("boomlate", 2) } }); // new pages, so a read is attempted
  const sent = [];
  let wake = null;
  const rt = new Runtime({
    runTurn: async () => {
      wake = await runTool("research", { research_id: first.research_id }, {
        conversationId: OWNER, searchProvider: p, lookup, robots: async () => { throw new Error("robots exploded"); },
        researchCaps: { maxSearches: 1 },
      });
      return "couldn't get to the rest of that one — what i sent earlier is what i've got. want me to try again?";
    },
  });
  rt.on("outbound", (m) => sent.push(m));

  clock.skip((config.researchContinueWakeMin + 1) * 60_000);
  await rt.runTasks();
  assert.equal(wake.ok, false);
  assert.equal(wake.follow_up?.finished_the_rest, false);
  assert.match(wake.follow_up_note, /honest line/i);
  assert.equal(db.getTask(OWNER, taskId).state, "failed");
  assert.equal(db.getResearch(OWNER, first.research_id).state, "done");
  assert.equal(sent.length, 1, "the one honest line goes out");
  clock.skip(60 * 60_000);
  await rt.runTasks();
  assert.equal(sent.length, 1);
});

test("a wake turn that crashes gets one retry, then closes quietly", async () => {
  const { first, taskId } = await cutRun("crash");
  let turns = 0;
  const sent = [];
  const rt = new Runtime({ runTurn: async () => { turns++; throw new Error("model fell over"); } });
  rt.on("outbound", (m) => sent.push(m));

  clock.skip((config.researchContinueWakeMin + 1) * 60_000);
  for (let i = 0; i < 10; i++) { await rt.runTasks(); clock.skip(30 * 60_000); }
  assert.equal(turns, 2, "one try and one retry");
  assert.equal(db.getTask(OWNER, taskId).open, false);
  assert.equal(db.getResearch(OWNER, first.research_id).state, "done");
  assert.deepEqual(sent.map(m => m.text), [], "no 'keeps breaking' text for a background extra");
});
