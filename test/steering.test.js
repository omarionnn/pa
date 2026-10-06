// Cheap steering: "shorter", "wrong person", "leave that alone", "actually friday", "including fees".
//
// A short correction fixes the thing in front of Reason and sticks for the rest of the job. What is
// tested here is the part code owns: the correction is recorded with their own words, it holds on
// every later read of the sheet, a yes never carries over to the amended detail, the old recipient
// is never reached, and "leave that alone" closes ONE job and names what had already gone out.
//
// Nothing here reads their words to decide what they meant — the model does that. These tests say
// what a reply meant (the judge is injected) and check what the guards do with it.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-steer-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBERS = "+12025551234";
process.env.REASON_CONFIRM_WINDOW_MIN = "10";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { clock } = await import("../src/config.js");
const { openWorkNote } = await import("../src/openwork.js");

const C = "dm:steer";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
db.upsertThread({ conversationId: C, channel: "test", address: "+12025551234", isOwner: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM outbox;");
});

const owner = (t) => ({ role: "user", content: `[Tue, Oct 6, 2026, 3:00 PM] Omari: ${t}` });
const fakeJudge = (result) => {
  const judge = async (arg) => { judge.calls.push(arg); return result; };
  judge.calls = [];
  return judge;
};

/** A channel that records every send instead of making one. Ground truth for "who was reached". */
function fakeRouter() {
  const sends = [];
  return {
    sends,
    list: () => [{ name: "test" }],
    send: async (args) => { sends.push(args); return { ok: true, id: `m${sends.length}` }; },
  };
}

const call = (name, input = {}, extra = {}) => runTool(name, input, { conversationId: C, ...extra });

const start = () => call("task_start", {
  title: "find a place", goal: "a place under 2k by nov 1",
  sheet: { constraints: { budget: { value: "under $2000 a month", source: "them", said: "under $2k a month" } } },
});

test("'including fees' is recorded with their words and holds for the rest of the job", async () => {
  const { id } = (await start()).task;

  // Before: the first option arrives as a bare rent figure.
  await call("task_update", {
    task_id: id,
    sheet: { options: [{ id: "l1", label: "441 Graham — $1,850/mo", status: "open" }] },
  });

  // They say two words. Reason applies it and carries on.
  const steered = await call("task_update", {
    task_id: id,
    steer: { said: "including fees", changed: "every price from here on is rent + fees, not rent" },
    sheet: {
      constraints: { fees_included: { value: "every total shown includes fees", source: "them", said: "including fees" } },
      options: [{ id: "l1", label: "441 Graham — $2,050/mo all in ($1,850 + $200 fees)", status: "open" }],
    },
  });
  assert.equal(steered.ok, true);
  assert.deepEqual(steered.task.sheet.steers, [{ they_said: "including fees", so_you_changed: "every price from here on is rent + fees, not rent", at: steered.task.sheet.steers[0].at }]);
  assert.equal(steered.task.sheet.constraints.fees_included.from, "they said it");

  // After: two days and a restart later, the correction is still in front of the model — both on
  // the wake path (the sheet on the row) and on an ordinary turn (the open-work note).
  clock.skip(2 * 24 * 60 * 60_000);
  const fresh = db.getTask(C, id);
  assert.equal(fresh.sheet.constraints.fees_included.source, "them");
  const note = openWorkNote(C);
  assert.match(note, /includes fees/);
  assert.match(note, /they said it/);
  assert.match(note, /do not ask for anything already on one/i);
});

test("a steer needs their words and what it changed, or it is not a record of anything", async () => {
  const { id } = (await start()).task;
  const noWords = await call("task_update", { task_id: id, steer: { changed: "made it friday" } });
  assert.equal(noWords.ok, false);
  const noChange = await call("task_update", { task_id: id, steer: { said: "actually friday" } });
  assert.equal(noChange.ok, false);
});

test("'actually friday' changes the detail and the yes does not carry over", async () => {
  // Reason asks about Thursday.
  const asked = await call("confirm_request", {
    action: "browser_submit", target: "441 Graham viewing, Thu Oct 8 2026, 6pm",
    summary: "book the 441 Graham viewing for Thursday Oct 8 at 6pm",
  }, { messages: [owner("set up the viewing")] });
  assert.equal(asked.state, "waiting_for_yes");

  // "actually friday". The judge reads it as a yes to something different.
  const judge = fakeJudge({ verdict: "change", note: "they want Friday, not Thursday" });
  const read = await call("confirm_record", { confirmation_id: asked.confirmation_id }, {
    messages: [owner("set up the viewing"), owner("actually friday")], judge,
  });
  assert.equal(read.ok, false);
  assert.equal(read.state, "changed");
  assert.equal(read.quote, "actually friday");
  assert.match(read.wants, /Friday/);
  // The refusal is the instruction, and it is: change the details, ask once more. Not re-explain.
  assert.match(read.error, /Nothing is authorized/);
  assert.match(read.error, /Change the details first/);
  assert.match(read.error, /ask once more/i);

  // Nothing is authorized and nothing is refused: the old ask is still open, not dead.
  const row = db.getConfirmation(C, asked.confirmation_id);
  assert.equal(row.granted_at, null);
  assert.equal(row.refused_at, null, "they did not say no — they said yes to something else");

  // Trying to commit Thursday anyway is refused on the old ask.
  const old = await call("browser_submit", {
    what: "441 Graham viewing, Thu Oct 8 2026, 6pm", ref: "e1",
    confirmation_id: asked.confirmation_id,
  });
  assert.equal(old.ok, false);
  assert.match(old.error, /no yes on it yet/i);

  // The amended ask: the same action, the new line, and that is all it takes.
  const again = await call("confirm_request", {
    action: "browser_submit", target: "441 Graham viewing, Fri Oct 9 2026, 6pm",
    summary: "book the 441 Graham viewing for Friday Oct 9 at 6pm",
  }, { messages: [owner("set up the viewing"), owner("actually friday")] });
  const granted = await call("confirm_record", { confirmation_id: again.confirmation_id }, {
    messages: [owner("set up the viewing"), owner("actually friday"), owner("yep")], judge: fakeJudge({ verdict: "yes" }),
  });
  assert.equal(granted.state, "granted");

  // And the new yes covers Friday only. Thursday on the new yes is refused by target.
  const thursdayOnNewYes = await call("browser_submit", {
    what: "441 Graham viewing, Thu Oct 8 2026, 6pm", ref: "e1",
    confirmation_id: again.confirmation_id,
  });
  assert.equal(thursdayOnNewYes.ok, false);
  assert.equal(thursdayOnNewYes.blocked, "wrong_target");
  assert.match(thursdayOnNewYes.error, /exact details Omari was shown/i);
});

test("'wrong person' — the old number is never reached, on the old yes or the new one", async () => {
  const router = fakeRouter();
  const WRONG = "+12125550111";
  const RIGHT = "+13475550222";

  // Reason asks about the wrong person and gets a real yes for THAT number.
  const asked = await call("confirm_request", {
    action: "message_send", target: WRONG, summary: `text ${WRONG}: "hey, still ok for friday?"`,
  }, { messages: [owner("tell him friday works")] });
  const granted = await call("confirm_record", { confirmation_id: asked.confirmation_id }, {
    messages: [owner("tell him friday works"), owner("go on then")], judge: fakeJudge({ verdict: "yes" }),
  });
  assert.equal(granted.state, "granted");

  // "wrong person". Reason must not ride that yes to a different number...
  const rerouted = await call("message_send", {
    to: RIGHT, text: "hey, still ok for friday?", confirmation_id: asked.confirmation_id,
  }, { channels: router });
  assert.equal(rerouted.ok, false);
  assert.equal(rerouted.blocked, "wrong_target");
  assert.match(rerouted.error, /one person Omari was shown/i);
  assert.deepEqual(router.sends, [], "nothing left the machine");

  // ...and once it has a yes for the right person, the WRONG one is still unreachable.
  const reasked = await call("confirm_request", {
    action: "message_send", target: RIGHT, summary: `text ${RIGHT} instead: "hey, still ok for friday?"`,
  }, { messages: [owner("tell him friday works"), owner("wrong person, it's kofi on 347 555 0222")] });
  await call("confirm_record", { confirmation_id: reasked.confirmation_id }, {
    messages: [owner("tell him friday works"), owner("wrong person, it's kofi on 347 555 0222"), owner("yeah that one")],
    judge: fakeJudge({ verdict: "yes" }),
  });

  const toOldOnNewYes = await call("message_send", {
    to: WRONG, text: "hey, still ok for friday?", confirmation_id: reasked.confirmation_id,
  }, { channels: router });
  assert.equal(toOldOnNewYes.ok, false);
  assert.equal(toOldOnNewYes.blocked, "wrong_target");
  assert.deepEqual(router.sends, [], "still nothing, to either of them");

  // The right person, on the right yes, goes.
  const sent = await call("message_send", {
    to: RIGHT, text: "hey, still ok for friday?", confirmation_id: reasked.confirmation_id,
  }, { channels: router });
  assert.equal(sent.ok, true);
  assert.equal(router.sends.length, 1);
  assert.equal(router.sends[0].to, RIGHT);
  assert.ok(!router.sends.some(s => s.to === WRONG), "the first number was never texted, at any point");

  // And the ledger agrees: one refusal per attempt, one send, nothing to the old number.
  const reached = db.listActions(C).filter(a => a.action === "message_send" && a.outcome === "ok");
  assert.equal(reached.length, 1);
  assert.equal(reached[0].target, `text:${RIGHT}`);
});

test("'leave that alone' cancels one job, says what went out, and touches nothing else", async () => {
  const router = fakeRouter();
  const drop = (await start()).task;
  const keep = (await call("task_start", { title: "chase the handyman", goal: "he calls back" })).task;

  // Something really did go out while the apartment job was open.
  const asked = await call("confirm_request", {
    action: "message_send", target: "+13475550222", summary: `text +13475550222: "are you still showing 441 graham?"`,
  }, { messages: [owner("ask the broker")] });
  await call("confirm_record", { confirmation_id: asked.confirmation_id }, {
    messages: [owner("ask the broker"), owner("yeah")], judge: fakeJudge({ verdict: "yes" }),
  });
  await call("message_send", {
    to: "+13475550222", text: "are you still showing 441 graham?", confirmation_id: asked.confirmation_id,
  }, { channels: router });
  assert.equal(router.sends.length, 1);

  const cancelled = await call("task_finish", {
    task_id: drop.id, state: "cancelled", outcome: "they said leave it",
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task.state, "cancelled");
  assert.equal(cancelled.went_out_while_it_was_open.length, 1);
  assert.match(cancelled.went_out_while_it_was_open[0].what, /are you still showing 441 graham/);
  assert.ok(cancelled.window, "and the window it is read over is named");
  assert.match(cancelled.note, /really went out/);
  assert.match(cancelled.note, /cannot be taken back/);
  assert.match(cancelled.note, /nothing else was touched/);

  // Nothing else moved: the other job, the ledger, the channel.
  assert.equal(db.getTask(C, keep.id).state, "running");
  assert.equal(db.getTask(C, keep.id).open, true);
  assert.equal(router.sends.length, 1, "cancelling sent nobody anything");
  assert.equal(db.listActions(C).filter(a => a.action === "message_send").length, 1);
});

test("a cancel with nothing behind it says exactly that", async () => {
  const { id } = (await start()).task;
  const out = await call("task_finish", { task_id: id, state: "cancelled", outcome: "called off before anything happened" });
  assert.deepEqual(out.went_out_while_it_was_open, []);
  assert.match(out.note, /nothing to undo/i);
  assert.match(out.note, /Do not cancel, change or touch anything else/);
});

test("the turn is told what is open and what is waiting on an answer, so a steer has a referent", async () => {
  const { id } = (await start()).task;
  const asked = await call("confirm_request", {
    action: "browser_submit", target: "441 Graham viewing, Thu Oct 8 2026, 6pm",
    summary: "book the 441 Graham viewing for Thursday at 6pm",
  }, { messages: [owner("set up the viewing")] });

  const note = openWorkNote(C);
  assert.match(note, /waiting on an answer about/);
  assert.ok(note.includes(`"confirmation_id":${asked.confirmation_id}`));
  assert.match(note, /Thursday at 6pm/);
  assert.ok(note.includes(`"task_id":${id}`));
  assert.match(note, /short steer/);
  assert.match(note, /never make them explain it again/i);
  assert.match(note, /amended line/);
});

test("a pending ask they have already answered is not asked again", async () => {
  const asked = await call("confirm_request", {
    action: "browser_submit", target: "x", summary: "do the thing",
  }, { messages: [owner("do it")] });
  const pending = await call("confirm_pending", {});
  assert.equal(pending.count, 1);
  assert.equal(pending.waiting_on_an_answer[0].confirmation_id, asked.confirmation_id);
  assert.match(pending.note, /do not ask again/i);

  // Once it is answered it is off the list, so there is nothing to re-ask about.
  await call("confirm_record", { confirmation_id: asked.confirmation_id }, {
    messages: [owner("do it"), owner("yep")], judge: fakeJudge({ verdict: "yes" }),
  });
  assert.equal((await call("confirm_pending", {})).count, 0);
});

test("a steer cannot smuggle a change to something they said", async () => {
  const { id } = (await start()).task;
  const out = await call("task_update", {
    task_id: id,
    steer: { said: "whatever's easiest", changed: "put the budget up" },
    sheet: { constraints: { budget: { value: "under $2800 a month", source: "assumed" } } },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, "needs_them");
  assert.equal(db.getTask(C, id).sheet.constraints.budget.value, "under $2000 a month");
  assert.deepEqual(db.getTask(C, id).sheet.steers, [], "and the steer did not land either");
});
