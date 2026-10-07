// Why, not just what: the reason they stated, kept apart from the facts and used to rank.
//
// The failure this is written against is small and it decides the whole answer. "I want to move" is
// one job; "I want to move to save money" and "I want to move for a shorter commute" are two, and
// before this table existed the difference lived in one sentence that got trimmed out of the model's
// context after sixty messages. The fifth flat came back ranked the way the second one was, with a
// confident line on top of it.
//
// So five things are under test here:
//
//   1. A reason is written down with their sentence on it, and REFUSED without one. A reason nobody
//      stated is worse than no reason, because five options get sorted by it and look deliberate.
//   2. It reaches the pick — the sheet the model is handed, on this job and on the next one — with
//      the instruction to rank and phrase by it, and never to invent one.
//   3. A correction SUPERSEDES: the new reason stands, the old one is kept as replaced rather than
//      erased, and the old wording stops existing anywhere it was carried forward.
//   4. It is theirs: its own numbered section on the memory page, droppable by id, in the export and
//      in the delete, and taken by a `forget` of its subject.
//   5. **A reason is never a permission.** It is a goal, and the gate has never read this table.
//
// No model anywhere in here. No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-why-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");
const { whyView, sheetView } = await import("../src/sheet.js");
const { openWorkNote } = await import("../src/openwork.js");
const memory = await import("../src/memory.js");
const { checkContent } = await import("../src/pages/content.js");
const { exportData, deleteData } = await import("../src/data.js");

const C = "dm:why";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM whys; DELETE FROM preferences; DELETE FROM person_facts; DELETE FROM people;
    DELETE FROM guesses; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM permissions;
    DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM conversations; DELETE FROM threads;`);
  // Re-made every time, because one of the tests below really runs a data delete — which takes the
  // account row with it, and the gate refuses everything on a conversation that belongs to nobody.
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

const call = (name, input = {}, extra = {}) => runTool(name, input, { conversationId: C, messages: [], ...extra });

const moveTask = () => db.createTask(C, {
  title: "find a flat", goal: "a one-bed they can move into by november",
  wakeAt: clock.now() + 60_000, maxAttempts: 3,
});

// ---------- 1. the reason, with their sentence on it ----------

test("a stated reason is written down with their words, and the same one twice is one row", async () => {
  const out = await call("why_note", {
    about: "moving", why: "to save money", said: "i want to move to save money",
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.about, "moving");
  assert.equal(out.why, "to save money");
  assert.equal(out.their_words, "i want to move to save money");
  assert.equal(out.already_knew, false);
  assert.match(out.note, /RANK/);
  assert.match(out.note, /NOT permission/);

  const again = await call("why_note", {
    about: "moving", why: "to save money", said: "like i said, it's a money thing",
  });
  assert.equal(again.already_knew, true);
  assert.equal(db.listWhys(C).length, 1, "the same reason twice does not make the list longer");
});

test("a reason with no sentence behind it is refused, and nothing is written", async () => {
  const out = await call("why_note", { about: "moving", why: "to save money", said: "   " });
  assert.equal(out.ok, false);
  assert.match(out.error, /word for word/);
  assert.match(out.error, /ask them/, "the refusal says what to do instead");
  assert.equal(db.listWhys(C).length, 0);
});

test("a reason pinned to a task that does not exist is refused rather than written loose", async () => {
  const out = await call("why_note", {
    about: "moving", why: "to save money", said: "i want to move to save money", task_id: 999,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /No task #999/);
  assert.equal(db.listWhys(C).length, 0);
});

test("the task it was said on is kept, and does NOT limit it to that task", async () => {
  const t = moveTask();
  const out = await call("why_note", {
    about: "moving", why: "to save money", said: "i want to move to save money", task_id: t.id,
  });
  assert.equal(out.said_on_task, t.id);
  // A second, unrelated job: the reason is still on its sheet, because it is per person and not per task.
  const other = db.createTask(C, { title: "find a storage unit", goal: "somewhere for the boxes", wakeAt: clock.now() + 60_000, maxAttempts: 3 });
  const view = await call("task_list", {});
  const job = view.tasks.find(x => x.id === other.id);
  assert.deepEqual(job.sheet.their_reasons.map(w => w.why), ["to save money"]);
  assert.equal(job.sheet.their_reasons[0].first_said_on_task, t.id);
});

// ---------- 2. it reaches the pick, with the instruction attached ----------

test("the reason is on the sheet with the rank-and-phrase instruction and the never-invent rule", async () => {
  moveTask();
  await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  const view = await call("task_list", {});
  const sheet = view.tasks[0].sheet;
  assert.deepEqual(sheet.their_reasons.map(w => w.they_said), ["i want to move to save money"]);
  assert.match(sheet.reasons_note, /Rank and phrase/);
  assert.match(sheet.reasons_note, /cheaper, since you said this is about saving/);
  assert.match(sheet.reasons_note, /ONE short clause/);
  assert.match(sheet.reasons_note, /NEVER invent one/);
  // And it does not pretend every reason fits every job.
  assert.match(sheet.reasons_note, /do not stretch one to fit/);
});

test("a reason stated on one job reaches the next job three weeks later", async () => {
  const first = moveTask();
  await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money", task_id: first.id });
  db.finishTask(C, first.id, { state: "done", outcome: "signed the Bushwick place" });

  clock.skip(21 * 24 * 60 * 60 * 1000);
  const later = db.createTask(C, { title: "find a moving company", goal: "someone to shift it on the 1st", wakeAt: clock.now() + 60_000, maxAttempts: 3 });
  const view = await call("task_list", {});
  const job = view.tasks.find(x => x.id === later.id);
  assert.deepEqual(job.sheet.their_reasons.map(w => w.why), ["to save money"]);
});

test("the reason travels in the open-work note, so a turn they started knows it too", async () => {
  moveTask();
  await call("why_note", { about: "moving", why: "a shorter commute", said: "honestly it's the commute, 90 mins each way is killing me" });
  const note = openWorkNote(C);
  assert.match(note, /a shorter commute/);
  assert.match(note, /90 mins each way/, "their own sentence travels, not just your compression of it");
});

test("no stated reason means nothing is said about reasons at all", async () => {
  moveTask();
  const view = await call("task_list", {});
  assert.equal(view.tasks[0].sheet.their_reasons, undefined, "an empty list is not a section");
  assert.equal(view.tasks[0].sheet.reasons_note, undefined);
});

test("a superseded reason never reaches the sheet, so nothing is ranked by a goal they moved off", () => {
  const row = db.stateWhy(C, { about: "moving", why: "to save money", said: "i want to move to save money" });
  db.correctWhy(C, row.id, { why: "a shorter commute", said: "it's not about money, it's the commute" });
  const whys = whyView(db.listWhys(C));
  assert.deepEqual(whys.map(w => w.why), ["a shorter commute"]);
  const sheet = sheetView({}, { whys });
  assert.equal(sheet.their_reasons.length, 1);
  assert.doesNotMatch(JSON.stringify(sheet), /save money/);
});

// ---------- 3. a correction supersedes, and the old wording stops existing ----------

test("a corrected reason replaces the old one, and the old row is kept as replaced rather than erased", async () => {
  const first = await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  const out = await call("memory_fix", {
    row: "why", id: first.reason_id,
    said: "it's not about money, it's the commute", instead: "a shorter commute",
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.was, "to save money");
  assert.equal(out.now, "a shorter commute");
  assert.equal(out.replaced, first.reason_id);
  assert.ok(out.now_reason_id > first.reason_id);
  assert.match(out.note, /kept as replaced/);

  // What stands is the new one, and only the new one.
  assert.deepEqual(db.listWhys(C).map(w => w.why), ["a shorter commute"]);
  // The audit trail is on disk: the old row points at the one that replaced it.
  const all = db.listWhys(C, { includeSuperseded: true });
  assert.equal(all.length, 2);
  const old = all.find(w => w.id === first.reason_id);
  assert.ok(old.superseded_at, "the old row is stamped");
  assert.equal(old.superseded_by, out.now_reason_id);
  assert.equal(old.why, "to save money", "and its wording is kept, so 'you told me it was money' stays checkable");
  // The subject came along; it is the same thing they are doing, for a different reason.
  assert.equal(db.getWhy(C, out.now_reason_id).about, "moving");
  assert.equal(db.getWhy(C, out.now_reason_id).said, "it's not about money, it's the commute");
});

test("the old reason is taken out of everything that was carrying it forward", async () => {
  const first = await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  // The reading is in the thread twice over, which is where the next turn would read it back from.
  db.saveConversation(C, [
    { role: "user", content: "[Tue] Omari: any luck with the flats" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "memory_page", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ whys: [{ why: "to save money" }] }) }] },
    { role: "assistant", content: "put the cheap one first since this is to save money" },
  ]);
  const out = await call("memory_fix", {
    row: "why", id: first.reason_id,
    said: "it's not about money, it's the commute", instead: "a shorter commute",
  });
  assert.equal(out.ok, true);
  assert.ok(out.also_cleared.tool_results >= 1, JSON.stringify(out.also_cleared));
  assert.ok(out.also_cleared.things_you_said >= 1, JSON.stringify(out.also_cleared));
  const thread = JSON.stringify(db.loadConversation(C));
  assert.doesNotMatch(thread, /to save money/, "the next turn cannot read the corrected reason back");
});

test("a reason cannot be corrected twice through the same number, which would fork the record", async () => {
  const first = await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  await call("memory_fix", { row: "why", id: first.reason_id, said: "it's the commute", instead: "a shorter commute" });
  const again = await call("memory_fix", { row: "why", id: first.reason_id, said: "actually schools", instead: "the schools" });
  assert.equal(again.ok, false);
  assert.match(again.error, /already replaced/);
  assert.deepEqual(db.listWhys(C).map(w => w.why), ["a shorter commute"], "and nothing forked");
});

test("a correction with no new goal is refused rather than blanking the row", async () => {
  const first = await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  const out = await call("memory_fix", { row: "why", id: first.reason_id, said: "nah" });
  assert.equal(out.ok, false);
  assert.match(out.error, /pass 'instead'/);
  assert.equal(db.listWhys(C).length, 1);
});

test("a correction aimed at a number that is not there says to go and get the real one", async () => {
  const out = await call("memory_fix", { row: "why", id: 404, said: "it's the commute", instead: "a shorter commute" });
  assert.equal(out.ok, false);
  assert.match(out.error, /no reason #404/i);
  assert.match(out.error, /memory_page/);
});

// ---------- 4. it is theirs ----------

test("it has its own numbered section on the memory page, in words a person reads", async () => {
  await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  const out = await call("memory_page", {});
  assert.equal(out.counts.whys, 1);
  assert.equal(out.whys[0].why, "to save money");
  assert.equal(out.whys[0].they_said, "i want to move to save money");

  const titles = out.page_blocks.filter(b => b.type === "section").map(b => b.title);
  assert.ok(titles.includes("Why you're doing things"), titles.join(" | "));
  const rows = out.page_blocks.find(b => b.type === "rows" && b.items.some(i => i.name === "to save money"));
  assert.ok(rows, "the reason is a row with a number on it");
  assert.equal(rows.items[0].n, `#${out.whys[0].id}`);
  assert.match(rows.items[0].detail, /about moving/);
  assert.match(rows.items[0].detail, /i want to move to save money/);
  // The page says the two things that matter about a reason: it changes the order, and it is never invented.
  const text = out.page_blocks.filter(b => b.type === "text").map(b => b.text).join(" ");
  assert.match(text, /change what I put first/);
  assert.match(text, /never make one up/);
  // And the answer the model writes is told to say them as goals rather than as facts.
  assert.match(out.note, /RANK by/);
  assert.match(out.note, /not as facts about them/);
  // The blocks are real page blocks.
  const checked = checkContent(out.page_blocks);
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("nothing stated means no section, and an empty record still reads as empty", async () => {
  const out = await call("memory_page", {});
  assert.equal(out.counts.whys, 0);
  assert.ok(!out.page_blocks.some(b => b.type === "section" && b.title === "Why you're doing things"));
  assert.match(out.note, /do not know anything about them yet/);
});

test("a reason is dropped by id, and only that row goes", async () => {
  const a = await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  const b = await call("why_note", { about: "the job hunt", why: "before the lease runs out", said: "i need something before the lease ends in march" });
  const out = await call("memory_drop", { row: "why", id: a.reason_id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.dropped, "to save money");
  assert.equal(db.getWhy(C, a.reason_id), null);
  assert.equal(db.getWhy(C, b.reason_id).why, "before the lease runs out", "the other row did not move");
  assert.equal(db.dropWhy(C, a.reason_id).ok, false, "and it cannot be dropped twice");
});

test("dropping the standing reason does not hand back the one they already corrected", () => {
  const first = db.stateWhy(C, { about: "moving", why: "to save money", said: "i want to move to save money" });
  const fixed = db.correctWhy(C, first.id, { why: "a shorter commute", said: "it's the commute" });
  db.dropWhy(C, fixed.why.id);
  assert.deepEqual(db.listWhys(C), [], "nothing stands for that subject now");
  assert.equal(db.getWhy(C, first.id).superseded_by, fixed.why.id, "and the replaced row stays replaced");
});

test("'forget about the move' takes why they were doing it, not just the facts", async () => {
  db.remember(C, "moving", "wants to be out by november");
  await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  await call("why_note", { about: "the job hunt", why: "a shorter commute", said: "the commute is killing me" });
  const out = await call("forget", { about: "moving" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.reasons_dropped, 1);
  assert.deepEqual(db.listWhys(C).map(w => w.about), ["the job hunt"], "only that subject's reason went");
});

test("one person's reasons are not another's", () => {
  const other = "dm:somebody-else";
  db.upsertAccount({ conversationId: other, channel: "test", address: "+14445550000", name: "Ama", isOperator: false });
  const mine = db.stateWhy(C, { about: "moving", why: "to save money", said: "i want to move to save money" });
  assert.equal(db.listWhys(other).length, 0);
  assert.equal(db.getWhy(other, mine.id), null, "and not reachable by id either");
});

test("an export carries their reasons including the replaced ones, and a delete takes them", async () => {
  const first = db.stateWhy(C, { about: "moving", why: "to save money", said: "i want to move to save money" });
  db.correctWhy(C, first.id, { why: "a shorter commute", said: "it's the commute" });
  const out = exportData({ conversation: C, audio: false });
  assert.equal(out.tables.whys.length, 2, "the audit trail is part of their copy of their own data");
  assert.ok(out.tables.whys.some(w => w.said === "i want to move to save money"));

  const gone = await deleteData({ conversation: C, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) });
  assert.equal(gone.rows.whys, 2);
  assert.equal(db.listWhys(C, { includeSuperseded: true }).length, 0);
});

// ---------- 5. a reason is never a permission ----------

test("a stated reason cannot open a gated action", async () => {
  // Three reasons, including two that read like a licence if anybody ever treated one as one.
  await call("why_note", { about: "the groceries", why: "to stop wasting food", said: "just get the usual every week, i'm sick of binning things" });
  await call("why_note", { about: "the flight", why: "to be there for the wedding", said: "i have to be in accra by the 12th whatever it costs" });
  await call("why_note", { about: "moving", why: "to save money", said: "i want to move to save money" });
  assert.equal(db.listWhys(C).length, 3);

  const send = await call("message_send", { to: "+14155559876", text: "is the 8pm free?" }, { channels: fakeChannels() });
  assert.equal(send.ok, false, JSON.stringify(send));
  assert.equal(send.blocked, "needs_confirmation");
  assert.equal(send.nearly_covered_by, undefined, "a reason is not a near miss on a permission, it is a different kind of thing");
  assert.deepEqual(db.listPermissions(C, { includeClosed: true }), [], "and nothing in the permissions table came from any of it");
});

test("a real permission still works, which is what makes the test above mean something", async () => {
  await call("why_note", { about: "the flight", why: "to be there for the wedding", said: "i have to be in accra by the 12th whatever it costs" });
  db.grantPermission(C, { said: "you can text the restaurant without asking me", action: "message_send", target: "+14155559876" });
  const send = await call("message_send", { to: "+14155559876", text: "hi, this is Reason, Omari's assistant — is the 8pm free?" }, { channels: fakeChannels() });
  assert.equal(send.ok, true, JSON.stringify(send));
});

test("the gate never reads the reasons table", () => {
  for (const file of ["../src/permissions.js", "../src/trust.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /listWhys|FROM whys|stateWhy/,
      `${file} is part of the gate and must not know this table exists`);
  }
});

/** A texting channel that goes nowhere, so the gate is the only thing under test. */
function fakeChannels() {
  const out = [];
  return { out, list: () => [{ name: "fake" }], send: async (m) => { out.push(m); return { ok: true, delivered: true }; } };
}

// ---------- the rule reaches the model, on both backends ----------

test("both backends carry the reason to the model, including the one the live Reason runs on", () => {
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /openWorkNote\(/, `${file} must put the open sheets — which carry the reasons — in front of the model`);
    assert.match(src, /systemFor/, `${file} must build its prompt from the shared system text`);
  }
  // And the rule itself is in that shared text, so neither backend can be missing it.
  const prompt = readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(prompt, /why_note/);
  assert.match(prompt, /NEVER invent one/);
});
