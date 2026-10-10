// How Reason behaves when a job takes longer than a reply — the part code owns. The acknowledgement
// and the estimate are the model's, and the prompt is checked for them; what is tested here is
// that a task's late result lands under the text that asked for it, that a wake in their night
// waits for their morning, and that a turn which dies says so instead of going silent.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-longtask-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_TASK_WAKE_MIN = "15";

const { Runtime, stallLine } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const { SYSTEM } = await import("../src/agent.js");
const replies = await import("../src/replies.js");
const notice = await import("../src/notice.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const C = "dm:owner";
const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM conversations; DELETE FROM timers; DELETE FROM watches; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM accounts;");
  db.upsertAccount({ conversationId: C, channel: "test", address: OWNER, name: "Omari", isOperator: true });
});

/** A runtime whose turns are a script instead of a model. Outbound is collected, pin and all. */
function harness(onTurn = async () => null) {
  const sent = [];
  const turns = [];
  const rt = new Runtime({
    runTurn: async (t) => {
      turns.push(t);
      return onTurn(t, { tool: (name, input) => runTool(name, input, { conversationId: t.conversationId, ...(t.answering ? { answering: t.answering } : {}) }) });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, sent, turns };
}

/** A text from them, on record the way the router puts one there. */
const theirs = (externalId, text) => db.claimInbound({ channel: "test", externalId, conversationId: C, text });

/** Move the test clock to the next time it is this hour where Omari is. */
function skipToLocalHour(h) {
  let t = clock.now();
  while (notice.localHour(t, "America/New_York") !== h) t += 15 * MIN;
  clock.skip(t - clock.now());
}

const taskIdIn = (text) => Number(text.match(/task #(\d+)/)[1]);

// ---------- the prompt carries the rules ----------

test("the prompt says: acknowledge first with a range, update only with news, lead with the answer, name what is done and not", () => {
  assert.match(SYSTEM, /the FIRST thing you do is tell them, in one message_send/);
  assert.match(SYSTEM, /range, never a promise/);
  assert.match(SYSTEM, /progress line goes out ONLY with news in it/);
  assert.match(SYSTEM, /Never narrate steps/);
  assert.match(SYSTEM, /say "nothing was done"/);
  assert.match(SYSTEM, /couldn't finish X because Y\. done: A\. not done: B\./);
  assert.match(SYSTEM, /back on the airbnb search:/);
  // "on it" is allowed as the acknowledgement that work is starting, and still refused as a claim.
  assert.match(SYSTEM, /"on it" only as the acknowledgement that you are starting the work right now/);
  assert.match(SYSTEM, /Never say "found it", "booked" or "sent" unless a tool did that thing this turn/);
});

// ---------- a task remembers the text that asked for it ----------

test("task_start keeps the handle of the text it was asked under, and nothing when there was none", async () => {
  theirs("T-1", "find me a table for 4 friday");
  const out = await runTool("task_start", { title: "find a table", goal: "a table for 4 friday" }, { conversationId: C, answering: { handle: "T-1", texts: 1 } });
  assert.equal(out.ok, true);
  assert.equal(db.getTask(C, out.task.id).origin_handle, "T-1");

  const plain = await runTool("task_start", { title: "chase the handyman", goal: "a date from him" }, { conversationId: C });
  assert.equal(db.getTask(C, plain.task.id).origin_handle, null);
});

test("a task's result, later, lands under the text that started it once the thread has moved on", async () => {
  skipToLocalHour(14);
  theirs("T-ask", "find me a table for 4 friday");
  const t = db.createTask(C, { title: "find a table", goal: "a table for 4 friday", wakeAt: clock.now() + 15 * MIN, maxAttempts: 3, originHandle: "T-ask" });
  const { rt, sent, turns } = harness(async (turn, { tool }) => {
    await tool("task_update", { task_id: taskIdIn(turn.text), progress: "lucali has a 7:30" });
    return "back on the table: lucali has 7:30 fri, want it?";
  });

  clock.skip(5 * MIN);
  theirs("T-later", "lol did u see the game");
  clock.skip(11 * MIN);
  await rt.runTasks();

  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /may land well after unrelated conversation/, "the wake is told its words may land out of order");
  assert.match(turns[0].text, /orientation/, "and told to open with orientation");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /lucali/);
  assert.equal(sent[0].replyTo, "T-ask", "pinned under the ask, not loose after the game");
});

test("…but not when their text is still the last thing in the thread — that is just a reply", async () => {
  skipToLocalHour(14);
  theirs("T-only", "chase the handyman");
  db.createTask(C, { title: "chase the handyman", goal: "a date", wakeAt: clock.now() + 15 * MIN, maxAttempts: 3, originHandle: "T-only" });
  const { rt, sent } = harness(async (turn, { tool }) => {
    await tool("task_update", { task_id: taskIdIn(turn.text), progress: "he says tuesday" });
    return "handyman says tuesday 10am";
  });
  clock.skip(16 * MIN);
  await rt.runTasks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyTo, undefined);
});

test("a task nothing in the thread asked for is never pinned, though the wake is still told to orient", async () => {
  skipToLocalHour(14);
  theirs("T-x", "hey");
  db.createTask(C, { title: "research: monitors", goal: "a pick", wakeAt: clock.now() + 15 * MIN, maxAttempts: 3 });
  const { rt, sent, turns } = harness(async (turn, { tool }) => {
    await tool("task_update", { task_id: taskIdIn(turn.text), progress: "narrowed to two" });
    return "monitors: the dell, 27in";
  });
  clock.skip(16 * MIN);
  await rt.runTasks();
  // The orientation advice is unconditional now: a task wake can land after unrelated conversation
  // whether or not it was pinned, so it is always worth a few words of context. What stays
  // conditional is the pin itself.
  assert.match(turns[0].text, /orientation/);
  assert.equal(sent[0].replyTo, undefined, "nothing in the thread asked for it, so nothing to pin under");
});

test("latePin: only a text that is in this thread and no longer the newest", () => {
  assert.equal(replies.latePin(C, null), null);
  assert.equal(replies.latePin(C, "nope"), null, "a handle from nowhere pins nothing");
  theirs("L-1", "one");
  assert.equal(replies.latePin(C, "L-1"), null, "the message right above is just a reply");
  clock.skip(1000);
  theirs("L-2", "two");
  assert.equal(replies.latePin(C, "L-1"), "L-1");
});

// ---------- their night ----------

test("a wake in their night waits for their morning, unless they are plainly up", async () => {
  skipToLocalHour(21);
  theirs("N-ask", "find me a flight to boston thursday");
  const t = db.createTask(C, { title: "boston flight", goal: "a flight thursday", wakeAt: clock.now() + 6 * HOUR, maxAttempts: 3, originHandle: "N-ask" });
  const { rt, turns } = harness(async () => "found one");

  clock.skip(6 * HOUR + MIN); // about 3am where they are
  assert.equal(notice.inTheirNight(C), true, "the test clock is in their night");
  let out = await rt.runTasks();
  assert.equal(turns.length, 0, "no step taken in the middle of their night");
  assert.equal(out.resting, 1);
  const row = db.getTask(C, t.id);
  assert.equal(row.wakes, 0, "the wake was not counted against the job");
  assert.equal(notice.inTheirNight(C, row.next_wake_at), false, "put off until their morning");
  assert.ok(row.next_wake_at > clock.now() && row.next_wake_at - clock.now() < 8 * HOUR);

  // Plainly up: a text from them just now, and the job runs.
  theirs("N-up", "cant sleep lol any luck w the flight");
  db.scheduleTask(t.id, clock.now());
  out = await rt.runTasks();
  assert.equal(turns.length, 1);
  assert.equal(out.woke, 1);
});

test("quietEndsAt walks forward to the first waking quarter hour, and is now when it is not quiet", () => {
  skipToLocalHour(3);
  const end = notice.quietEndsAt(clock.now(), "America/New_York", { start: 22, end: 8 });
  assert.equal(notice.localHour(end, "America/New_York"), 8);
  assert.ok(end - clock.now() <= 5 * HOUR + 15 * MIN);
  skipToLocalHour(14);
  assert.equal(notice.quietEndsAt(clock.now(), "America/New_York", { start: 22, end: 8 }), clock.now());
});

// ---------- a turn that dies ----------

test("a turn that dies says so in one line, and says nothing went out when nothing did", async () => {
  const { rt, sent } = harness(async () => { throw new Error("claude exited 1"); });
  const reply = await rt.inbound(C, "find me a flight", { channel: "test", to: OWNER, fromOwner: true });
  assert.match(reply, /broke on my end/);
  assert.match(reply, /nothing went out/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, reply);
});

test("the stall line is honest about what already went out", () => {
  assert.match(stallLine({ sentAny: false }), /nothing went out/);
  assert.match(stallLine({ sentAny: true }), /what i already sent you stands/);
  assert.doesNotMatch(stallLine({ sentAny: true }), /nothing went out/);
});

test("a turn that works is untouched by the catch", async () => {
  const { rt, sent } = harness(async () => "7:40 at the amc");
  const reply = await rt.inbound(C, "what time is the movie", { channel: "test", to: OWNER, fromOwner: true });
  assert.equal(reply, "7:40 at the amc");
  assert.equal(sent.length, 1);
  assert.equal(config.taskMaxAttempts > 0, true);
});
