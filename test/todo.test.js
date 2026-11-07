// The to-do list (src/todo.js, REASON_TODO). No model, no network, no phone: the model's reading of
// the list is stated as tool input, calls go through the fake provider, the judge is stated.
//
// The questions are mostly about the approval rule, which is enforced in code:
//
//   does one yes to the plan let Reason call a business the plan named?          (yes, without asking)
//   does it reach somebody they know, a call that could spend, an unnamed shop?  (no — the normal gate)
//   does a plan changed after the ask ride the old yes?                          (no)
//   does the checklist page follow the jobs by itself?                           (yes, on every change)
//   is the wrap-up sent once, and only once everything is settled?              (yes)
//   with the flag off, does anything change for anybody?                         (no)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-todo-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_PUBLIC_URL = "https://reason.example";
process.env.REASON_TODO = "owner";

const { runTool, toolsFor } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const todo = await import("../src/todo.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "dm:+13105550123";
const PLUMBER = "+12125550100";
const SALON = "+12125550111";
const MOM = "+14155559876";
const UNNAMED = "+12125550199";

after(() => rmSync(dir, { recursive: true, force: true }));
// A fixed, daytime clock: the wrap-up keeps out of their night, so nothing here may turn on when the suite runs.
const NOON = Date.parse("2026-10-30T12:00:00-04:00");
beforeEach(() => {
  process.env.REASON_TODO = "owner";
  clock.reset();
  clock.skip(NOON - Date.now());
  db.db.exec(`DELETE FROM todo_lists; DELETE FROM todo_items; DELETE FROM confirmations; DELETE FROM calls; DELETE FROM usage;
    DELETE FROM action_ledger; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM pages; DELETE FROM important_people;
    DELETE FROM people; DELETE FROM person_facts; DELETE FROM accounts;`);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550123", name: "Ama", isOperator: false });
});

const owner = (t) => ({ role: "user", content: `[Fri, Oct 30, 2026, 3:00 PM] Omari: ${t}` });
const ctx = (over = {}) => ({ conversationId: C, messages: [owner("here's my list")], ...over });

const LIST = {
  source: "photo", title: "saturday",
  items: [
    { text: "Call plumber re: kitchen leak", short: "plumber", group: "mine", how: "call for the earliest slot", businesses: [{ name: "Joe's Plumbing", phone: PLUMBER }] },
    { text: "haircut", short: "haircut", group: "mine", how: "book a cut", money: true, money_note: "about $40", businesses: [{ name: "Fade Masters", phone: SALON }] },
    { text: "call mom about thanksgiving", short: "mom", group: "ask", question: "want me to call her, or text?", businesses: [{ name: "Mom", phone: MOM }] },
    { text: "renew passport", short: "passport", group: "mine", how: "find the form and the nearest office" },
    { text: "gym", short: "gym", group: "theirs", how: "a reminder at 6pm" },
  ],
};

/** The plan made, asked, answered yes and approved — the whole road the model walks. */
async function approved(list = LIST) {
  const plan = await runTool("todo_plan", list, ctx());
  assert.equal(plan.ok, true, plan.error);
  const asked = await runTool("confirm_request", { action: "todo_approve", target: plan.approval_target, summary: "go ahead with the plan for the list" }, ctx());
  assert.ok(asked.confirmation_id, JSON.stringify(asked));
  const rec = await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("here's my list"), owner("yes do it all")], judge: async () => ({ verdict: "yes" }) });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const shown = { role: "assistant", content: plan.plan_text };
  const ok = await runTool("todo_approve", { list_id: plan.list_id, confirmation_id: asked.confirmation_id }, ctx({ messages: [owner("here's my list"), shown, owner("yes do it all")] }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  return { plan, approval: ok };
}

// ---------- making the list ----------

test("a list becomes one plan in three groups that names every business and every money item", async () => {
  db.addImportantPerson(C, { who: "Mom", why: "family", contact: MOM });
  const plan = await runTool("todo_plan", LIST, ctx());
  assert.equal(plan.ok, true);
  const items = db.todoItems(plan.list_id);
  assert.equal(items.length, 5, "every item, none left out");
  assert.deepEqual(items.map(i => i.grp), ["mine", "mine", "ask", "mine", "theirs"]);

  const t = plan.plan_text;
  assert.match(t, /i'll handle these:/);
  assert.match(t, /i need one thing from you:/);
  assert.match(t, /only you can do these:/);
  assert.match(t, /Joe's Plumbing \(212\) 555-0100/, "the business and its number are on the plan");
  assert.match(t, /Fade Masters/);
  assert.match(t, /may cost money \(about \$40\)/, "the money item is flagged");
  assert.match(t, /want me to call her, or text\?/, "the one question");
  assert.match(t, /Mom is someone you know, so i'll ask before calling/, "a person they know is never filed as a business");
  assert.match(t, /good to go\?$/);

  assert.equal(plan.approval_target, `to-do list #${plan.list_id} [${db.getTodoList(C, plan.list_id).plan_fp}]`);
  assert.ok(plan.treated_as_people.some(p => /Mom/.test(p)));

  // The checklist page exists from the start, waiting on the go-ahead.
  const list = db.getTodoList(C, plan.list_id);
  const page = db.getPageIn(C, list.page_id);
  assert.ok(page, "a checklist page row");
  assert.equal(page.blocks[0].type, "status");
  assert.equal(page.blocks[0].headline, "Waiting for your go-ahead");
});

test("nothing on the list starts before the yes, and the yes has to come through the gate", async () => {
  const plan = await runTool("todo_plan", LIST, ctx());
  const bare = await runTool("todo_approve", { list_id: plan.list_id, confirmation_id: 999 }, ctx());
  assert.equal(bare.ok, false);
  assert.equal(bare.blocked, "no_such_confirmation");
  const early = await runTool("todo_item_update", { list_id: plan.list_id, item: 1, status: "done" }, ctx());
  assert.equal(early.ok, false);
  assert.match(early.error, /not been approved/);
  assert.equal(db.getTodoList(C, plan.list_id).state, "planning");
});

test("a plan changed after the ask does not ride the old yes", async () => {
  const plan = await runTool("todo_plan", LIST, ctx());
  const asked = await runTool("confirm_request", { action: "todo_approve", target: plan.approval_target, summary: "the plan" }, ctx());
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("x"), owner("yes")], judge: async () => ({ verdict: "yes" }) });
  // The model sneaks another business in before approving.
  const more = { ...LIST, list_id: plan.list_id, items: [...LIST.items, { text: "dry cleaning", short: "dry cleaning", group: "mine", businesses: [{ name: "Spotless", phone: UNNAMED }] }] };
  await runTool("todo_plan", more, ctx());
  const out = await runTool("todo_approve", { list_id: plan.list_id, confirmation_id: asked.confirmation_id }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "wrong_target");
  assert.equal(db.getTodoList(C, plan.list_id).state, "planning");
});

// ---------- the grant ----------

test("after the yes, a business the plan named is called without asking again", async () => {
  await approved();
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: PLUMBER, goal: "ask for the earliest slot to fix a kitchen leak" }, ctx({ calls }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(calls.placed.length, 1);
  assert.equal(calls.placed[0].to, PLUMBER);
  assert.match(out.permission_note, /yes do it all/, "the receipt quotes their own words of approval");
  // The disclosure and the recording notice are still written by code, as for any call.
  assert.match(calls.placed[0].announcement, /AI/);
  const row = db.listActions(C).find(a => a.action === "call_place");
  assert.equal(row.outcome, "ok");
  assert.match(row.receipt, /No yes was asked for/);
  assert.equal(db.pendingConfirmations(C).filter(x => x.action === "call_place").length, 0, "nobody was asked");
});

test("confirm_request for a business the plan named is answered 'not needed' and records nothing", async () => {
  await approved();
  const before = db.pendingConfirmations(C).length;
  const out = await runTool("confirm_request", { action: "call_place", target: PLUMBER, summary: "call Joe's Plumbing" }, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.not_needed, true);
  assert.equal(out.business, "Joe's Plumbing");
  assert.equal(db.pendingConfirmations(C).length, before);
});

test("the grant never covers somebody they know, even if the model files them as a business", async () => {
  // Kofi is in memory with his number among his facts; the model calls him "Kofi's Auto".
  const p = db.upsertPerson(C, "Kofi");
  db.db.prepare("INSERT INTO person_facts (person_id, fact, created_at) VALUES (?, ?, ?)").run(p.id, "phone is (917) 555-0142", clock.now());
  const list = { source: "text", items: [{ text: "car service", short: "car", group: "mine", businesses: [{ name: "Kofi's Auto", phone: "+19175550142" }] }] };
  await approved(list);
  assert.equal(db.approvedTodoLists(C)[0].grant.length, 0, "a known person never enters the grant");
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: "+19175550142", goal: "book a service" }, ctx({ calls }));
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.deepEqual(calls.placed, []);
});

test("a number that becomes somebody they know after the yes is asked about again", async () => {
  await approved();
  db.addImportantPerson(C, { who: "Joe (my cousin)", contact: "212-555-0100" });
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: PLUMBER, goal: "the leak" }, ctx({ calls }));
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.match(out.todo_list_does_not_cover, /somebody they know/);
  assert.deepEqual(calls.placed, []);
});

test("the grant never covers money: a call that could agree to spend still asks", async () => {
  await approved();
  const calls = new FakeCallProvider();
  // The haircut item is flagged money: asking is fine, booking is not.
  const book = await runTool("call_place", { to: SALON, goal: "book a cut saturday", may_book: true, read_back: ["date", "time"] }, ctx({ calls }));
  assert.equal(book.ok, false);
  assert.equal(book.blocked, "needs_confirmation");
  assert.match(book.todo_list_does_not_cover, /money/);
  // A price cap on a call to the plumber (not a money item) is money all the same.
  const capped = await runTool("call_place", { to: PLUMBER, goal: "book the fix", may_book: true, max_price_cents: 20000, read_back: ["price"] }, ctx({ calls }));
  assert.equal(capped.ok, false);
  assert.match(capped.todo_list_does_not_cover, /money/);
  assert.deepEqual(calls.placed, []);
  // And only asking what a cut costs is not money.
  const ask = await runTool("call_place", { to: SALON, goal: "ask what a cut costs saturday" }, ctx({ calls }));
  assert.equal(ask.ok, true, JSON.stringify(ask));
});

test("a business the plan did not name is asked about as usual", async () => {
  await approved();
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: UNNAMED, goal: "ask about dry cleaning" }, ctx({ calls }));
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.match(out.todo_list_does_not_cover, /does not name a business/);
  const asked = await runTool("confirm_request", { action: "call_place", target: trust.personPin("call_place", { to: UNNAMED, goal: "ask about dry cleaning" }), summary: "call Spotless" }, ctx());
  assert.ok(asked.confirmation_id, "the normal ask happens");
  assert.equal(asked.not_needed, undefined);
});

test("a number found after the yes joins the grant only when they typed it, and only for a business the plan named", async () => {
  const list = { source: "text", items: [{ text: "vet appointment", short: "vet", group: "mine", businesses: [{ name: "Paws Clinic" }] }] };
  const { plan } = await approved(list);
  const offers = await import("../src/offers.js");
  const VET = "+12125550177";
  const calls = new FakeCallProvider();
  // Laundering, as the review found it: a made-up number tried, refused (the refusal repeats it), then attached.
  offers.beginTurn(C, "ok go", "user");
  const tried = await runTool("call_place", { to: VET, goal: "earliest appointment" }, ctx({ calls }));
  assert.equal(tried.blocked, "needs_confirmation");
  offers.noteSource(C, { name: "Paws Clinic", phone: "(212) 555-0177" }); // and a lookup said it too
  const laundered = await runTool("todo_item_update", { list_id: plan.list_id, item: 1, business: { name: "Paws Clinic", phone: VET } }, ctx());
  assert.match(laundered.note, /did not give you that number themselves/);
  assert.equal(db.getTodoList(C, plan.list_id).grant[0].phone, "");
  assert.equal((await runTool("call_place", { to: VET, goal: "x" }, ctx({ calls }))).blocked, "needs_confirmation");
  // They type it.
  offers.beginTurn(C, "paws is 212-555-0177", "user");
  const typed = await runTool("todo_item_update", { list_id: plan.list_id, item: 1, business: { name: "Paws Clinic", phone: VET } }, ctx());
  assert.match(typed.note, /now on the approved plan/);
  assert.equal((await runTool("call_place", { to: VET, goal: "earliest appointment" }, ctx({ calls }))).ok, true);
  // Another shop for the same item is not the plan's, typed or not.
  offers.beginTurn(C, "or other vet 212 555 0188", "user");
  const other = await runTool("todo_item_update", { list_id: plan.list_id, item: 1, business: { name: "Other Vet", phone: "+12125550188" } }, ctx());
  assert.match(other.note, /was not named in the plan/);
  assert.equal((await runTool("call_place", { to: "+12125550188", goal: "x" }, ctx({ calls }))).blocked, "needs_confirmation");
});

test("numbers are compared whole: the same ten digits in another country are not the plan's business", async () => {
  await approved();
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: "+442125550100", goal: "x" }, ctx({ calls }));
  assert.equal(out.blocked, "needs_confirmation");
  assert.deepEqual(calls.placed, []);
  assert.equal(todo.sameNumber("2125550100", "+1 (212) 555-0100"), true);
});

test("a money call refused under the list can still be asked about and approved the normal way", async () => {
  await approved();
  const calls = new FakeCallProvider();
  const book = await runTool("call_place", { to: SALON, goal: "book a cut saturday", may_book: true, read_back: ["date", "time"] }, ctx({ calls }));
  assert.equal(book.blocked, "needs_confirmation");
  const asked = await runTool("confirm_request", { action: "call_place", target: trust.personPin("call_place", { to: SALON, goal: "book a cut saturday", may_book: true, read_back: ["date", "time"] }), summary: "book a cut at Fade Masters saturday, about $40" }, ctx());
  assert.ok(asked.confirmation_id, JSON.stringify(asked));
  assert.equal(asked.not_needed, undefined);
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("x"), owner("yes book it")], judge: async () => ({ verdict: "yes" }) });
  const ok = await runTool("call_place", { to: SALON, goal: "book a cut saturday", may_book: true, read_back: ["date", "time"], confirmation_id: asked.confirmation_id }, ctx({ calls }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // And an ask that says money is never short-circuited.
  const m = await runTool("confirm_request", { action: "call_place", target: trust.personPin("call_place", { to: PLUMBER, goal: "book the plumber", may_book: true }), stakes: "money", summary: "book the plumber, $150" }, ctx());
  assert.ok(m.confirmation_id);
});

test("an 'ask' item's business is not covered until they answer; a dropped item stays dropped", async () => {
  const list = { source: "text", items: [
    { text: "dentist", short: "dentist", group: "ask", question: "tue or thu?", businesses: [{ name: "Smile Dental", phone: "+12125550122" }] },
    { text: "plumber", short: "plumber", group: "mine", businesses: [{ name: "Joe's Plumbing", phone: PLUMBER }] },
  ] };
  const { plan } = await approved(list);
  const calls = new FakeCallProvider();
  const early = await runTool("call_place", { to: "+12125550122", goal: "book" }, ctx({ calls }));
  assert.match(early.todo_list_does_not_cover, /waiting on their answer/);
  await runTool("todo_item_update", { list_id: plan.list_id, item: 1, group: "mine" }, ctx());
  assert.equal((await runTool("call_place", { to: "+12125550122", goal: "ask for thursday" }, ctx({ calls }))).ok, true);
  await runTool("todo_item_update", { list_id: plan.list_id, item: 2, status: "dropped" }, ctx());
  const back = await runTool("todo_item_update", { list_id: plan.list_id, item: 2, status: "todo" }, ctx());
  assert.equal(back.ok, false);
  assert.equal((await runTool("call_place", { to: PLUMBER, goal: "x" }, ctx({ calls }))).blocked, "needs_confirmation");
});

test("the yes cannot approve a plan they were never shown", async () => {
  const plan = await runTool("todo_plan", LIST, ctx());
  const asked = await runTool("confirm_request", { action: "todo_approve", target: plan.approval_target, summary: "the plan" }, ctx());
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("x"), owner("yes")], judge: async () => ({ verdict: "yes" }) });
  const vague = { role: "assistant", content: "i've got a plan for your list, want me to go?" };
  const out = await runTool("todo_approve", { list_id: plan.list_id, confirmation_id: asked.confirmation_id }, ctx({ messages: [owner("x"), vague, owner("yes")] }));
  assert.equal(out.blocked, "plan_not_shown");
  assert.match(out.error, /Joe's Plumbing/);
  assert.equal(db.getTodoList(C, plan.list_id).state, "planning");
  assert.equal(db.getConfirmation(C, asked.confirmation_id).consumed_at, null, "the yes is not spent");
  // Reworded "how" is a different plan: a fresh fingerprint.
  const fp = db.getTodoList(C, plan.list_id).plan_fp;
  await runTool("todo_plan", { ...LIST, list_id: plan.list_id, items: LIST.items.map((i, n) => n === 0 ? { ...i, how: "book them for saturday" } : i) }, ctx());
  assert.notEqual(db.getTodoList(C, plan.list_id).plan_fp, fp);
});

test("a list's grant reaches nobody else's conversation", async () => {
  process.env.REASON_TODO = "on";
  await approved();
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: PLUMBER, goal: "x" }, { conversationId: OTHER, messages: [], calls });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
});

// ---------- the checklist ----------

test("the checklist page is redrawn whenever a task on the list changes, a call's outcome included", async () => {
  const { plan, approval } = await approved();
  assert.match(approval.link, /^https:\/\/reason\.example\/p\/.+\?k=/);
  const list = db.getTodoList(C, plan.list_id);
  const rev0 = db.getPageIn(C, list.page_id).revision;

  const task = await runTool("task_start", { title: "get the plumber in", goal: "a plumber booked for the leak" }, ctx());
  await runTool("todo_item_update", { list_id: plan.list_id, item: 1, task_id: task.task.id }, ctx());
  const rev1 = db.getPageIn(C, list.page_id).revision;
  assert.ok(rev1 > rev0);
  assert.equal(db.todoItems(plan.list_id)[0].status, "doing");

  // The task moves on by itself — no todo tool is called — and the page follows.
  await runTool("task_update", {
    task_id: task.task.id, state: "waiting_on_other", progress: "left a message",
    sheet: { waiting: [{ on: "Joe's Plumbing", for: "a call back thursday", next_check: new Date(clock.now() + 86_400_000).toISOString() }] },
  }, ctx());
  const item = db.todoItems(plan.list_id)[0];
  assert.equal(item.status, "waiting");
  assert.match(item.note, /Joe's Plumbing: a call back thursday/);
  const page = db.getPageIn(C, list.page_id);
  assert.ok(page.revision > rev1, "redrawn on the task change");
  const mine = page.blocks.find(b => b.type === "timeline" && b.title === "I'm handling");
  assert.equal(mine.items[0].state, "waiting");

  // A call's outcome written onto the job by the post-call path redraws it too.
  const rev2 = page.revision;
  db.logTask(task.task.id, "call", "called +12125550100: they can come thursday 9am");
  assert.ok(db.getPageIn(C, list.page_id).revision > rev2);

  await runTool("task_finish", { task_id: task.task.id, state: "done", outcome: "plumber booked thursday 9am" }, ctx({ lookup: async () => [] }));
  assert.equal(db.todoItems(plan.list_id)[0].status, "done");
  const done = db.getPageIn(C, list.page_id);
  assert.match(done.blocks[0].headline, /^1 of 5 done$/);
});

test("work that could be a list item is told which items nothing is working yet, until they are linked", async () => {
  const { plan } = await approved();
  const t = await runTool("task_start", { title: "plumber", goal: "a plumber booked" }, ctx());
  assert.deepEqual(t.todo_list.not_started.map(x => x.item), [1, 2, 4], "the 'mine' items with nothing on them");
  await runTool("todo_item_update", { list_id: plan.list_id, item: 1, task_id: t.task.id }, ctx());
  await runTool("todo_item_update", { list_id: plan.list_id, item: 2, status: "done" }, ctx());
  await runTool("todo_item_update", { list_id: plan.list_id, item: 4, status: "dropped" }, ctx());
  const later = await runTool("task_update", { task_id: t.task.id, progress: "rang them" }, ctx());
  assert.equal(later.todo_list, undefined, "nothing left unlinked: nothing said");
  const plain = await runTool("task_list", {}, ctx());
  assert.equal(plain.todo_list, undefined, "a read is never nudged");
  process.env.REASON_TODO = "off";
  const off = await runTool("task_start", { title: "x", goal: "y" }, ctx());
  assert.equal(off.todo_list, undefined);
});

// ---------- the wrap-up ----------

test("one wrap-up, written by code, once every item is done, waiting or theirs — and never twice", async () => {
  const { plan } = await approved();
  const L = plan.list_id;
  const said = [];
  const say = (c, text, meta) => said.push({ c, text, meta });

  await runTool("todo_item_update", { list_id: L, item: 1, status: "waiting", note: "plumber calls back thu" }, ctx());
  await runTool("todo_item_update", { list_id: L, item: 2, status: "done" }, ctx());
  // Mom's question is still out: not yet.
  clock.skip(10 * 60_000);
  assert.equal(todo.wrapUps({ say }).wrapped, 0);
  await runTool("todo_item_update", { list_id: L, item: 3, group: "mine", status: "done" }, ctx());
  await runTool("todo_item_update", { list_id: L, item: 4, status: "done" }, ctx());
  // Settled, but only just: it waits for the list to sit still.
  assert.equal(todo.wrapUps({ say }).wrapped, 0);
  clock.skip(todo.WRAP_QUIET_MS + 1000);
  // Their night holds it.
  assert.equal(todo.wrapUps({ say, inTheirNight: () => true }).wrapped, 0);
  assert.equal(todo.wrapUps({ say }).wrapped, 1);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /^3 of 5 done; plumber calls back thu, i'll chase it; gym is yours\nhttps:\/\/reason\.example\/p\//);
  assert.equal(said[0].meta.idempotencyKey, `todo-wrap:${L}`);

  clock.skip(60 * 60_000);
  assert.equal(todo.wrapUps({ say }).wrapped, 0, "never a second one");
  assert.equal(said.length, 1);
  // A waiting item keeps the list (and its grant) open for the chase.
  assert.equal(db.getTodoList(C, L).state, "approved");
  await runTool("todo_item_update", { list_id: L, item: 1, status: "done" }, ctx());
  assert.equal(db.getTodoList(C, L).state, "closed", "nothing left waiting: closed, and its grant with it");
  assert.equal(todo.grantCovering({ conversationId: C, action: "call_place", target: PLUMBER }).ok, false);
});

test("the runtime's own sweep sends the wrap-up, once", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const { plan } = await approved({ source: "text", items: [{ text: "email landlord", short: "landlord email", group: "mine" }] });
  await runTool("todo_item_update", { list_id: plan.list_id, item: 1, status: "done" }, ctx());
  clock.skip(todo.WRAP_QUIET_MS + 1000);
  const turns = [];
  const rt = new Runtime({ log: () => {}, runTurn: async (x) => { turns.push(x); return "NO_REPLY"; } });
  const out = [];
  rt.on("outbound", (e) => out.push(e));
  const swept = await rt.sweep();
  assert.equal(swept.todo_wraps.wrapped, 1);
  const wraps = out.filter(e => /^1 of 1 done\n/.test(e.text ?? ""));
  assert.equal(wraps.length, 1, JSON.stringify(out.map(e => e.text)));
  assert.equal(wraps[0].idempotencyKey, `todo-wrap:${plan.list_id}`);
  assert.equal((await rt.sweep()).todo_wraps.wrapped, 0, "the next sweep sends nothing");
});

test("a list wrapped up with a job still waiting closes by itself when that job finishes", async () => {
  const { plan } = await approved({ source: "text", items: [
    { text: "plumber", short: "plumber", group: "mine", businesses: [{ name: "Joe's Plumbing", phone: PLUMBER }] },
    { text: "gym", short: "gym", group: "theirs" },
  ] });
  const t = await runTool("task_start", { title: "plumber", goal: "booked" }, ctx());
  await runTool("todo_item_update", { list_id: plan.list_id, item: 1, task_id: t.task.id }, ctx());
  await runTool("task_update", { task_id: t.task.id, state: "waiting_on_other",
    sheet: { waiting: [{ on: "Joe's Plumbing", for: "a call back", next_check: new Date(clock.now() + 86_400_000).toISOString() }] } }, ctx());
  clock.skip(todo.WRAP_QUIET_MS + 1000);
  assert.equal(todo.wrapUps({ say: () => {} }).wrapped, 1);
  assert.equal(db.getTodoList(C, plan.list_id).state, "approved", "the chase still needs the grant");
  await runTool("task_finish", { task_id: t.task.id, state: "done", outcome: "booked thursday" }, ctx({ lookup: async () => [] }));
  assert.equal(db.getTodoList(C, plan.list_id).state, "closed");
});

test("a list whose every item was dropped sends no wrap-up", async () => {
  const { plan } = await approved({ source: "text", items: [{ text: "plumber", short: "plumber", group: "mine" }, { text: "gym", short: "gym", group: "theirs" }] });
  await runTool("todo_item_update", { list_id: plan.list_id, item: 1, status: "dropped" }, ctx());
  clock.skip(todo.WRAP_QUIET_MS + 1000);
  assert.equal(todo.wrapUps({ say: () => assert.fail("said something") }).wrapped, 0);
});

// ---------- flag off ----------

test("with REASON_TODO off nothing changes for anybody", async () => {
  // A list approved while it was on, then switched off.
  const { plan } = await approved();
  process.env.REASON_TODO = "off";
  const names = toolsFor(C).map(t => t.name);
  for (const n of todo.TODO_TOOLS) assert.ok(!names.includes(n), `${n} hidden`);
  const refused = await runTool("todo_plan", LIST, ctx());
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked, "not_available");
  const approve = await runTool("todo_approve", { list_id: plan.list_id, confirmation_id: 1 }, ctx());
  assert.equal(approve.blocked, "not_available", "refused before anybody could be asked");

  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: PLUMBER, goal: "x" }, ctx({ calls }));
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(out.todo_list_does_not_cover, undefined, "the refusal reads exactly as it always did");
  assert.deepEqual(calls.placed, []);
  const asked = await runTool("confirm_request", { action: "call_place", target: trust.personPin("call_place", { to: PLUMBER, goal: "x" }), summary: "call" }, ctx());
  assert.ok(asked.confirmation_id);

  // A task changing does not redraw anything, and the sweep says nothing.
  const list = db.getTodoList(C, plan.list_id);
  const rev = db.getPageIn(C, list.page_id).revision;
  const task = db.createTask(C, { title: "t", goal: "g", maxAttempts: 3 });
  db.db.prepare("UPDATE todo_items SET task_id = ? WHERE list_id = ? AND n = 1").run(task.id, plan.list_id);
  db.updateTask(C, task.id, { progress: "did a thing" });
  assert.equal(db.getPageIn(C, list.page_id).revision, rev);
  const said = [];
  clock.skip(60 * 60_000);
  assert.equal(todo.wrapUps({ say: (...a) => said.push(a) }).wrapped, 0);
  assert.equal(said.length, 0);
});

test("owner mode: the operator only", async () => {
  process.env.REASON_TODO = "owner";
  assert.ok(toolsFor(C).some(t => t.name === "todo_plan"));
  assert.ok(!toolsFor(OTHER).some(t => t.name === "todo_plan"));
  const out = await runTool("todo_plan", LIST, { conversationId: OTHER, messages: [] });
  assert.equal(out.blocked, "not_available");
});

test("todo_approve can never be a standing permission", async () => {
  const permissions = await import("../src/permissions.js");
  assert.ok(permissions.NEVER_STANDING.has("todo_approve"));
  assert.ok(permissions.GATED_ACTIONS.has("todo_approve"));
});
