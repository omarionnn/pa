// Everything Reason is working on, on one page, at a link that stays the same.
//
// The point of the page is that it is built from the rows. A page the model composed could say a
// job is running when the row says it finished, and the person reading it has no way to tell. So
// every assertion here is about what the blocks say against what the tasks table says — never
// about wording Reason chose.
//
// The second point is the link. A page of open work is only worth keeping if tomorrow's tap shows
// tomorrow's state, so the page is updated in place and the id never moves.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-activity-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { activityBlocks, headlineFor } = await import("../src/activity.js");
const { renderPage } = await import("../src/pages/render.js");

const C = "dm:activity";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM pages;");
});

const call = (name, input = {}) => runTool(name, input, { conversationId: C });
const blockOf = (blocks, type) => blocks.filter(b => b.type === type);

async function aJobWaitingOnThem() {
  const t = await call("task_start", { title: "find a place", goal: "under 2k by nov 1" });
  await call("task_update", {
    task_id: t.task.id,
    progress: "looked at streeteasy, three worth seeing",
    state: "waiting_on_you",
    sheet: {
      needs: { question: "stretch to 2.2k, or further from the L?", tradeoff: "more money, or a longer commute" },
      left: ["book the two viewings"],
      options: [{ id: "graham", label: "441 Graham", status: "rejected", rejected_because: { words: "too dear", reading: "price" } }],
    },
  });
  return t.task.id;
}

test("the page is built from the rows: every open job is on it, under what it is really doing", async () => {
  const id = await aJobWaitingOnThem();
  await call("task_start", { title: "chase the handyman", goal: "a callback" });
  const r = await call("activity_page");
  assert.equal(r.ok, true);
  const page = db.getPageIn(C, r.page_id);
  const titles = blockOf(page.blocks, "timeline").map(b => b.title);
  assert.equal(titles.length, 2);
  assert.ok(titles.some(x => x.startsWith("find a place") && x.includes("waiting on you")));
  assert.ok(titles.some(x => x.startsWith("chase the handyman") && x.includes("working on it")));
  // What really happened is on it, as a finished step, read off the progress log.
  const first = blockOf(page.blocks, "timeline").find(b => b.title.startsWith("find a place"));
  assert.ok(first.items.some(i => i.label.includes("streeteasy") && i.state === "done"));
  assert.ok(first.items.some(i => i.label === "book the two viewings" && i.state === "plain"));
  assert.equal(id > 0, true);
});

test("what is on them comes first, before any progress report", async () => {
  await aJobWaitingOnThem();
  const r = await call("activity_page");
  const page = db.getPageIn(C, r.page_id);
  const rows = page.blocks.findIndex(b => b.type === "rows" && b.title.startsWith("What I need from you"));
  const firstJob = page.blocks.findIndex(b => b.type === "timeline");
  assert.ok(rows > -1, "the ask is on the page");
  assert.ok(rows < firstJob, "and it is above the jobs");
  assert.equal(page.blocks[rows].items[0].name, "stretch to 2.2k, or further from the L?");
  assert.match(page.blocks[rows].items[0].detail, /longer commute/);
  assert.equal(r.on_them, 1);
});

test("the same link, brought up to date, every time", async () => {
  await aJobWaitingOnThem();
  const first = await call("activity_page");
  await call("task_start", { title: "chase the handyman", goal: "a callback" });
  const second = await call("activity_page");
  assert.equal(second.page_id, first.page_id, "the link they kept still works");
  assert.equal(second.revision, first.revision + 1);
  assert.equal(db.listPages(C).length, 1, "no second page was made");
  assert.equal(blockOf(db.getPageIn(C, second.page_id).blocks, "timeline").length, 2);
});

test("what they already ruled out is folded shut rather than left off", async () => {
  await aJobWaitingOnThem();
  const r = await call("activity_page");
  const details = blockOf(db.getPageIn(C, r.page_id).blocks, "details");
  assert.equal(details.length, 1);
  assert.match(details[0].text, /441 Graham/);
  assert.match(details[0].text, /too dear/);
});

test("a job that finished in the last couple of days is still answerable; an old one is not", async () => {
  const t = await call("task_start", { title: "book the table", goal: "a table saturday" });
  await call("task_finish", { task_id: t.task.id, state: "done", outcome: "8pm saturday, under your name" });
  const fresh = await call("activity_page");
  const rows = blockOf(db.getPageIn(C, fresh.page_id).blocks, "rows").find(b => b.title.startsWith("Finished"));
  assert.equal(rows.items[0].name, "book the table");
  assert.equal(rows.items[0].value, "done");

  clock.skip(72 * 60 * 60 * 1000);
  const later = await call("activity_page");
  assert.equal(later.finished, 0);
  assert.equal(blockOf(db.getPageIn(C, later.page_id).blocks, "rows").some(b => b.title.startsWith("Finished")), false);
});

test("nothing open says exactly that, and does not invent a question", async () => {
  const r = await call("activity_page");
  assert.equal(r.open, 0);
  assert.equal(r.headline, "Nothing open");
  assert.match(r.note, /do not invent/);
  const page = db.getPageIn(C, r.page_id);
  assert.match(page.blocks.find(b => b.type === "text").text, /never actually started it/);
});

test("the page renders, and a job with nothing on it yet is still a readable block", () => {
  const { blocks } = activityBlocks({
    tasks: [{ id: 1, title: "chase the handyman", state: "running", open: true, log: [], sheet: { needs: null, waiting: [], blocked: null, left: [], options: [] } }],
  });
  const line = blocks.find(b => b.type === "timeline");
  assert.equal(line.items.length, 1);
  assert.match(line.items[0].label, /nothing has happened/);
  const html = renderPage({ id: "x", title: "What I'm working on", blocks, created_at: Date.now(), shared: false }, { forName: "Omari" });
  assert.match(html, /chase the handyman/);
});

test("the headline counts what is true, in the order it matters", () => {
  assert.equal(headlineFor({ open: 0, onThem: 0, stuck: 0 }), "Nothing open");
  assert.equal(headlineFor({ open: 1, onThem: 0, stuck: 0 }), "1 job open");
  assert.equal(headlineFor({ open: 3, onThem: 1, stuck: 1 }), "3 jobs open · 1 waiting on you · 1 stuck");
});

test("a stuck job says what stopped it and what would unstick it", async () => {
  const t = await call("task_start", { title: "get the lease", goal: "the signed lease" });
  await call("task_update", {
    task_id: t.task.id, state: "blocked",
    sheet: {
      routes: [{ tried: "their portal", failed_because: "403" }, { tried: "calling", failed_because: "nobody picks up" }],
      blocked: { what: "the portal will not let me in", unblock: "the agent emailing the pdf straight to you" },
    },
  });
  const r = await call("activity_page");
  assert.equal(r.stuck, 1);
  const line = blockOf(db.getPageIn(C, r.page_id).blocks, "timeline")[0];
  const stop = line.items.find(i => i.state === "failed");
  assert.match(stop.label, /will not let me in/);
  assert.match(stop.note, /emailing the pdf/);
});

test("a job waiting on somebody else says who, and that Reason is the one checking", async () => {
  const t = await call("task_start", { title: "chase the handyman", goal: "a callback" });
  await call("task_update", {
    task_id: t.task.id, state: "waiting_on_other",
    sheet: { waiting: [{ on: "Kofi", for: "whether saturday works" }] },
  });
  const r = await call("activity_page");
  const line = blockOf(db.getPageIn(C, r.page_id).blocks, "timeline")[0];
  const wait = line.items.find(i => i.state === "waiting");
  assert.match(wait.label, /Kofi — whether saturday works/);
  assert.match(wait.note, /without being asked/);
  assert.equal(r.on_them, 0, "waiting on somebody else is not waiting on them");
});

test("they can throw the page away, and the next one is an honest new link", async () => {
  await aJobWaitingOnThem();
  const first = await call("activity_page");
  await call("page_delete", { page_id: first.page_id });
  const second = await call("activity_page");
  assert.notEqual(second.page_id, first.page_id);
  assert.equal(db.listPages(C).length, 1);
});
