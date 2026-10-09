// Start small: one useful first move, not a wall of plan.
//
// "I need to find a job" is the shape of ask that gets the worst answer. It is enormous, it is
// vague, and the obliging thing to do with it is a twelve-step career plan — impressive, takes a
// minute to read, moves nothing. The useful answer is five roles that actually match, today, with
// the rest written down for later.
//
// Four things are under test here:
//
//   1. **A job started small carries exactly ONE active step**, whatever is on the rest of the list.
//      That is the whole feature as something code can check: `left` is held, not in progress.
//   2. The setting is per person, defaults ON for everybody, and is turned off in plain words —
//      stored on their account with their sentence, the way notice_mode is.
//   3. It reaches the model on BOTH backends, as a turn note, and never into the saved thread.
//   4. **It is about size and not permission.** Turning it either way changes nothing about the
//      gate, and nothing about it is held behind a yes.
//
// No model anywhere in here. No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-small-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { runTool, ALWAYS_NEEDS_CONFIRMATION } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");
const { activeSteps, laterSteps, parseSheet, FIRST_MOVE_STATES } = await import("../src/sheet.js");
const small = await import("../src/small.js");
const { userMessageFor } = await import("../src/agent.js");
const { activityBlocks } = await import("../src/activity.js");
const { checkContent } = await import("../src/pages/content.js");

const C = "dm:small";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM tasks; DELETE FROM task_log; DELETE FROM accounts; DELETE FROM permissions;
    DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM conversations; DELETE FROM threads;
    DELETE FROM whys; DELETE FROM preferences; DELETE FROM pages;`);
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

const call = (name, input = {}, extra = {}) => runTool(name, input, { conversationId: C, messages: [], ...extra });

/** The job the whole feature is named after: huge, vague, and started small. */
async function jobSearch() {
  const t = await call("task_start", {
    title: "find Omari a job", goal: "an offer he actually wants",
    sheet: {
      stakes: "low",
      first_move: { what: "find five roles that match what he does", state: "doing" },
      left: ["rewrite the CV for the best of them", "work out who to ask for a referral", "line up the applications",
        "prep for a first-round", "keep a list of what came back"],
    },
  });
  assert.equal(t.ok, true, JSON.stringify(t));
  return t.task;
}

// ---------- 1. exactly one active step ----------

test("a task opened under start small carries exactly one active step", async () => {
  const task = await jobSearch();
  const row = db.getTask(C, task.id);
  assert.deepEqual(activeSteps(row.sheet), ["find five roles that match what he does"]);
  assert.equal(activeSteps(row.sheet).length, 1,
    "five things on the list and one of them happening is the whole point");
  assert.equal(laterSteps(row.sheet).length, 5, "and the rest is written down rather than thrown away");
});

test("the model is told the list is held, not underway, and told to promote one at a time", async () => {
  const task = await jobSearch();
  const view = await call("task_list", {});
  const job = view.tasks.find(t => t.id === task.id);
  assert.deepEqual(job.on_now, ["find five roles that match what he does"]);
  assert.equal(job.held_for_later.length, 5);
  assert.equal(job.sheet.first_move.what, "find five roles that match what he does");
  assert.equal(job.sheet.first_move.state, "doing");
  assert.match(job.sheet.first_move_note, /ONE thing this job is on/);
  assert.match(job.sheet.first_move_note, /held for later and is not being worked/i);
  assert.match(job.sheet.first_move_note, /promote the next thing/);
  // The list itself is still there: holding it is not losing it.
  assert.equal(job.whats_left.length, 5);
});

test("finishing the first move frees the list, and the note says to take the next one", async () => {
  const task = await jobSearch();
  const done = await call("task_update", {
    task_id: task.id, progress: "sent him five that match",
    sheet: { first_move: { what: "find five roles that match what he does", state: "done" } },
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  const row = db.getTask(C, task.id);
  assert.equal(activeSteps(row.sheet).length, 5, "with the first move done the list is live again");
  assert.deepEqual(laterSteps(row.sheet), [], "and nothing is being held any more");
  assert.match(done.task.sheet.first_move_note, /first move is done/);
  assert.match(done.task.sheet.first_move_note, /one at a time/);
  assert.ok(db.getTask(C, task.id).sheet.first_move.done_at, "and when it finished is on the row");
});

test("a move waiting on them is not reported as underway", async () => {
  const t = await call("task_start", {
    title: "help Omari move", goal: "him in a new place by november",
    sheet: {
      first_move: { what: "pick one neighbourhood to start in", state: "offered" },
      left: ["three flats in it", "book the viewings"],
    },
  });
  const view = await call("task_list", {});
  const job = view.tasks.find(x => x.id === t.task.id);
  assert.deepEqual(job.on_now, ["pick one neighbourhood to start in"]);
  assert.match(job.sheet.first_move_note, /waiting on them/);
  assert.match(job.sheet.first_move_note, /do not go ahead with it on your own/);
});

test("a job with no first move behaves exactly as it always did", async () => {
  const t = await call("task_start", {
    title: "chase the handyman", goal: "him booked for friday",
    sheet: { left: ["ring him again", "try the other number"] },
  });
  const row = db.getTask(C, t.task.id);
  assert.deepEqual(activeSteps(row.sheet), ["ring him again", "try the other number"],
    "with no first move, `left` is the whole of what is still to do");
  assert.deepEqual(laterSteps(row.sheet), []);
  const view = await call("task_list", {});
  const job = view.tasks.find(x => x.id === t.task.id);
  assert.equal(job.sheet.first_move, undefined, "and nothing is said about one");
  assert.equal(job.sheet.first_move_note, undefined);
  assert.equal(job.held_for_later, undefined);
});

test("a first move needs something they could tell happened, and a real state", async () => {
  const t = await call("task_start", { title: "sort the finances", goal: "a budget he keeps to" });
  const blank = await call("task_update", { task_id: t.task.id, sheet: { first_move: { what: "  " } } });
  assert.equal(blank.ok, false);
  assert.match(blank.error, /one useful move you are taking now/);

  const bad = await call("task_update", { task_id: t.task.id, sheet: { first_move: { what: "list the subscriptions", state: "pending" } } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, new RegExp(FIRST_MOVE_STATES.join(", ")));
  assert.equal(db.getTask(C, t.task.id).sheet.first_move, null, "and nothing was written on either");

  const good = await call("task_update", { task_id: t.task.id, sheet: { first_move: { what: "list the subscriptions" } } });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(db.getTask(C, t.task.id).sheet.first_move.state, "doing", "no state given means you are on it");
});

test("clearing the first move is allowed, and when it started survives a state change", async () => {
  const task = await jobSearch();
  const started = db.getTask(C, task.id).sheet.first_move.at;
  clock.skip(3600_000);
  await call("task_update", { task_id: task.id, sheet: { first_move: { what: "find five roles that match what he does", state: "offered" } } });
  assert.equal(db.getTask(C, task.id).sheet.first_move.at, started, "'when did you start that' stays answerable");

  await call("task_update", { task_id: task.id, sheet: { first_move: null } });
  assert.equal(db.getTask(C, task.id).sheet.first_move, null);
  assert.equal(activeSteps(db.getTask(C, task.id).sheet).length, 5);
});

test("a sheet written before this field existed reads as having no first move", () => {
  const old = parseSheet(JSON.stringify({ left: ["ring him again"], stakes: "low" }));
  assert.equal(old.first_move, null);
  assert.deepEqual(activeSteps(old), ["ring him again"]);
});

test("the open page shows the one move as happening and the rest as after it", async () => {
  await jobSearch();
  const { blocks } = activityBlocks({ tasks: db.listTasks(C) });
  const checked = checkContent(blocks);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const line = blocks.flatMap(b => b.items ?? []).find(i => i.label === "find five roles that match what he does");
  assert.ok(line, JSON.stringify(blocks));
  assert.match(line.note, /the one thing this is on right now/);
  const after = blocks.flatMap(b => b.items ?? []).find(i => i.label === "rewrite the CV for the best of them");
  assert.equal(after.note, "after that", "the held steps read as queued rather than as happening");
});

// ---------- 2. the setting, per person, on by default ----------

test("start small is on for everybody by default, and that is said to be a default", () => {
  const s = small.startSmallFor(C);
  assert.equal(s.on, true);
  assert.equal(s.theirs, false);
  assert.equal(s.isTheDefault, true);
  assert.equal(small.DEFAULT_ON, true);
  assert.equal(db.startSmallPrefs(C).on, null, "nobody has said anything, which is not the same as 0");
});

test("they turn it off in plain words, and their sentence is kept", async () => {
  const out = await call("start_small", { on: false, said: "just give me the whole plan, i'll read it" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.start_small, false);
  assert.equal(out.their_words, "just give me the whole plan, i'll read it");
  assert.equal(out.was, true, "and what it was before comes back");
  assert.match(out.note, /whole thing laid out/);
  assert.match(out.note, /not permission/);

  const s = small.startSmallFor(C);
  assert.equal(s.on, false);
  assert.equal(s.theirs, true, "0 is a real answer and it is theirs");
  assert.equal(s.isTheDefault, false);
  assert.equal(s.said, "just give me the whole plan, i'll read it");
});

test("they turn it back on, which is different from never having been asked", async () => {
  await call("start_small", { on: false, said: "just give me the whole plan" });
  const out = await call("start_small", { on: true, said: "actually no, one thing at a time was better" });
  assert.equal(out.ok, true);
  assert.equal(out.start_small, true);
  const s = small.startSmallFor(C);
  assert.equal(s.on, true);
  assert.equal(s.theirs, true);
  assert.equal(s.isTheDefault, false, "they chose it, so the page must not call it a default");
  assert.equal(s.said, "actually no, one thing at a time was better");
});

test("setting it the way it already is changes nothing and says so", async () => {
  await call("start_small", { on: false, said: "whole plan please" });
  const again = await call("start_small", { on: false, said: "i said the whole plan" });
  assert.equal(again.already_set_that_way, true);
  assert.match(again.note, /already how they have it/);
  assert.equal(small.startSmallFor(C).said, "i said the whole plan", "their newest words are the ones kept");
});

test("a setting with no sentence behind it is refused, and nothing is written", async () => {
  const out = await call("start_small", { on: false, said: "   " });
  assert.equal(out.ok, false);
  assert.match(out.error, /word for word/);
  assert.equal(db.startSmallPrefs(C).on, null);
});

test("one person's setting is not another's", async () => {
  const other = "dm:somebody-else";
  db.upsertAccount({ conversationId: other, channel: "test", address: "+14445550000", name: "Ama", isOperator: false });
  await call("start_small", { on: false, said: "whole plan please" });
  assert.equal(small.startSmallFor(other).on, true, "still the default for her");
  assert.equal(small.startSmallFor(other).isTheDefault, true);
});

test("it is on their memory page, in their words, next to the other thing they control", async () => {
  const page = await call("memory_page", {});
  assert.equal(page.start_small.on, true);
  assert.equal(page.start_small.isTheDefault, true);
  let text = page.page_blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
  assert.match(text, /one useful move at a time/);
  assert.match(text, /the default — you have not changed it/);
  assert.match(text, /just give me the whole plan/, "the page says how to change it");

  await call("start_small", { on: false, said: "stop drip-feeding me, give me all of it" });
  const after = await call("memory_page", {});
  text = after.page_blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
  assert.match(text, /the whole thing/);
  assert.match(text, /stop drip-feeding me/, "their own sentence is on the page");
  assert.equal(checkContent(after.page_blocks).ok, true);
});

// ---------- 3. it reaches the model, on both backends, and not the thread ----------

test("the note says which way they have it, in both directions", async () => {
  assert.match(small.smallNote(C), /start small is ON/);
  assert.match(small.smallNote(C), /the default — they have not changed it/);
  assert.match(small.smallNote(C), /ONE useful first move/);
  assert.match(small.smallNote(C), /first_move/);

  await call("start_small", { on: false, said: "just give me the whole plan" });
  assert.match(small.smallNote(C), /start small is OFF/);
  assert.match(small.smallNote(C), /just give me the whole plan/);
  assert.match(small.smallNote(C), /do not offer to start small/);
});

test("the note goes to the model and not into the thread's history", () => {
  const { forModel, forHistory } = userMessageFor({
    prefix: "[Tue, Oct 6, 2026, 7:09 PM] Omari:", text: "i need to find a job",
    turnNote: [small.smallNote(C)],
  });
  assert.match(forModel.content, /start small is ON/);
  assert.doesNotMatch(forHistory.content, /start small/,
    "a copy left in the thread would go on describing a setting they have since changed");
  assert.match(forHistory.content, /i need to find a job/);
});

test("both backends read the setting, including the one the live Reason runs on", () => {
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /smallNote\(/, `${file} must tell the model which way this person has it`);
  }
  // And the behaviour itself is in the prompt both backends share.
  const prompt = readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(prompt, /Start small\./);
  assert.match(prompt, /ONE useful first move, not a plan/);
  assert.match(prompt, /sheet\.first_move/);
});

// ---------- 4. size, not permission ----------

test("start small either way changes nothing about what needs a yes", async () => {
  const before = [...ALWAYS_NEEDS_CONFIRMATION].sort();

  // Off: they asked for more words, not more latitude.
  await call("start_small", { on: false, said: "just give me the whole plan, do what you need to" });
  const send = await call("message_send", { to: "+14155559876", text: "is the 8pm free?" }, { channels: fakeChannels() });
  assert.equal(send.ok, false, JSON.stringify(send));
  assert.equal(send.blocked, "needs_confirmation");
  assert.equal(send.nearly_covered_by, undefined, "a size setting is not a near miss on a permission");

  // And back on.
  await call("start_small", { on: true, said: "one thing at a time" });
  const again = await call("message_send", { to: "+14155559876", text: "is the 8pm free?" }, { channels: fakeChannels() });
  assert.equal(again.blocked, "needs_confirmation");

  assert.deepEqual([...ALWAYS_NEEDS_CONFIRMATION].sort(), before, "and the gated list did not move");
  assert.deepEqual(db.listPermissions(C, { includeClosed: true }), [], "nothing became a permission");
});

test("a first move on a sheet is not a yes for the move", async () => {
  // The honest failure to rule out: "I'll do one useful thing" quietly becoming "and I may do it".
  await call("task_start", {
    title: "cancel the gym", goal: "the membership actually ended",
    sheet: { first_move: { what: "email them the cancellation request", state: "doing" } },
  });
  const mail = await call("gmail_send", { to: ["memberships@gym.test"], subject: "Cancellation", body: "Please cancel." });
  assert.equal(mail.ok, false, JSON.stringify(mail));
  assert.equal(mail.blocked, "needs_confirmation");
});

test("the setting is on their own account row, so an export and a delete already carry it", async () => {
  await call("start_small", { on: false, said: "whole plan please" });
  const row = db.db.prepare("SELECT start_small, start_small_said FROM accounts WHERE conversation_id = ?").get(C);
  assert.equal(row.start_small, 0);
  assert.equal(row.start_small_said, "whole plan please");
});

/** A texting channel that goes nowhere, so the gate is the only thing under test. */
function fakeChannels() {
  const out = [];
  return { out, list: () => [{ name: "fake" }], send: async (m) => { out.push(m); return { ok: true, delivered: true }; } };
}
