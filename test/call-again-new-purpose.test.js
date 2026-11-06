// "Call X again" with a NEW purpose must carry the new purpose — never the old call's script.
//
// The live failure this reproduces (2026-11-05, owner thread): Sunday's call to Yaw (call 63) asked
// about Manchester United and hit a mailbox that takes no messages; it was filed
// `dropped_before_confirmation`. On Thursday Omari asked Reason to call Yaw again and tell him to text
// his own Reason. Reason confirmed that exact purpose, he said yes, and call_place was handed the new
// goal — but the redial check saw the old "dropped" call, rewrote the brief as "find out whether this
// already went through: <the Man U goal>", and the call Yaw heard was Sunday's script (call 74).
//
// Also: the first "call yaw again" found no call to Yaw at all, because call_status with no id read
// only the last five calls, all of them to Omari's own phone.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call-again-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
process.env.REASON_CALL_MAX_RETRIES = "1";
process.env.REASON_UNDO_SECONDS = "0";

const { runTool } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const db = await import("../src/db.js");
const redial = await import("../src/calls/redial.js");
const brief = await import("../src/calls/brief.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const YAW = "+16165550147";
const DAY = 24 * 60 * 60 * 1000;

const GOAL_A = "Ask Yaw whether he has heard how badly Manchester United are doing lately, tell him Omari says he will call him tonight, and ask whether tonight works for him.";
const FACTS_A = ["Omari says he will call Yaw tonight.", "Manchester United lost 2-0 at Chelsea yesterday."];
const GOAL_B = "Tell Yaw that Omari needs him to text his Reason assistant and ask it to call him, and then to let Omari know how that call goes.";
const FACTS_B = ["Omari would like Yaw to text his Reason assistant and ask it to call him."];

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads;");
});

const owner = (t) => ({ role: "user", content: `[Thu, Nov 5, 2026, 7:07 PM] Omari: ${t}` });

async function yesFor(summary, target) {
  const asked = await runTool("confirm_request", { action: "call_place", stakes: "third_party", target, summary },
    { conversationId: C, messages: [owner(summary)] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner(summary), owner("Yeah")], judge: async () => ({ verdict: "yes" }) });
  return asked.confirmation_id;
}

/** Sunday's call, settled exactly as call 63 was: a dead mailbox filed "dropped before confirmation". */
async function sundayCall(calls, { goal = GOAL_A, facts = FACTS_A, mayBook = false } = {}) {
  const id = await yesFor(`Call Yaw and ${goal}`, YAW);
  const out = await runTool("call_place", { to: YAW, goal, facts, may_book: mayBook, ...(mayBook ? { read_back: ["date", "time"], max_price_cents: 20000 } : {}), confirmation_id: id }, { conversationId: C, calls });
  assert.equal(out.ok, true, JSON.stringify(out));
  db.updateCall(C, out.call_id, {
    state: "completed", outcome_kind: "dropped_before_confirmation", end_reason: "remote_hung_up",
    transcript: "Them: This voicemail box has not been set up yet. Please try your call again later. Goodbye",
    machine_heard: "The voicemail box has not been set up yet.",
  });
  return out.call_id;
}

test("call Yaw again four days later with a new message: the call carries the NEW message, never the old one", async () => {
  const calls = new FakeCallProvider();
  await sundayCall(calls);
  clock.skip(4 * DAY + 8 * 60 * 60 * 1000);

  const id = await yesFor(`Call Yaw and tell him Omari needs him to text his Reason and ask it to call him, then let Omari know how it goes.`, YAW);
  const out = await runTool("call_place", { to: YAW, goal: GOAL_B, facts: FACTS_B, ask: ["Will he text his Reason?"], confirmation_id: id },
    { conversationId: C, calls });
  assert.equal(out.ok, true, JSON.stringify(out));

  const placed = calls.placed.at(-1);
  assert.equal(placed.goal, GOAL_B, "the provider dials with the purpose he just confirmed");
  assert.equal(placed.brief.goal, GOAL_B);
  assert.doesNotMatch(placed.brief.goal, /Manchester|already went through/);
  assert.ok(!placed.brief.facts.some(f => /Manchester|Chelsea/.test(f)), "no fact from Sunday's call rides along");
  assert.deepEqual(placed.brief.questions, ["Will he text his Reason?"]);
  const row = db.getCall(C, out.call_id);
  assert.equal(row.goal, GOAL_B);
  assert.equal(JSON.parse(row.brief).goal, GOAL_B);
  assert.equal(out.goal, GOAL_B, "and the model is told the goal it actually went with");
});

test("the same evening too: an asking-only call that dropped is simply rung again with what it is asked to carry now", async () => {
  const calls = new FakeCallProvider();
  await sundayCall(calls);
  clock.skip(30 * 60 * 1000);

  const id = await yesFor(`Call Yaw again and tell him to text his Reason and ask it to call him.`, YAW);
  const out = await runTool("call_place", { to: YAW, goal: GOAL_B, facts: FACTS_B, confirmation_id: id }, { conversationId: C, calls });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(calls.placed.at(-1).brief.goal, GOAL_B);
  assert.equal(db.getCall(C, out.call_id).attempt, 2, "still counted as the second try at this number today");
});

test("a third call to a friend days later is not refused as 'out of tries' for good", async () => {
  const calls = new FakeCallProvider();
  await sundayCall(calls);
  clock.skip(2 * 60 * 60 * 1000);
  await sundayCall(calls, { goal: GOAL_B, facts: FACTS_B });
  clock.skip(5 * DAY);

  const r = redial.safeToRedial(C, { toNumber: YAW, brief: brief.buildBrief({ goal: "Wish Yaw a happy birthday." }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mode, "first");
  assert.equal(r.brief, undefined, "no old brief comes back to replace the new one");
});

test("a dropped call that COULD have booked still comes back to check first — and carries the new purpose after it, booking off", async () => {
  const calls = new FakeCallProvider();
  const BOOK = "Book a table for four at eight on Saturday under Omari.";
  await sundayCall(calls, { goal: BOOK, facts: ["party of four"], mayBook: true });
  clock.skip(60 * 60 * 1000);

  const NEW = "Ask whether they have a vegetarian tasting menu.";
  const id = await yesFor(`Call them again and ask whether they have a vegetarian tasting menu.`, YAW);
  const out = await runTool("call_place", { to: YAW, goal: NEW, ask: ["Is there a vegetarian tasting menu?"], confirmation_id: id },
    { conversationId: C, calls });
  assert.equal(out.ok, true, JSON.stringify(out));
  const b = calls.placed.at(-1).brief;
  assert.match(b.goal, /Find out whether this already went through/, "the never-book-twice check is kept");
  assert.match(b.goal, /Book a table for four/);
  assert.match(b.goal, /vegetarian tasting menu/, "and the new purpose is on the call, not dropped");
  assert.equal(b.approved.book, false);
  assert.deepEqual(b.questions, ["Is there a vegetarian tasting menu?"]);
});

test("call_status with no id still finds Sunday's call to Yaw behind five newer calls to the owner", async () => {
  const calls = new FakeCallProvider();
  const sunday = await sundayCall(calls);
  for (let i = 0; i < 5; i++) {
    clock.skip(60 * 60 * 1000);
    const row = db.createCall(C, { provider: "fake", toNumber: OWNER, isOwner: true, goal: `Omari asked to be called (${i}).`, facts: [], announcement: "hey Omari" });
    db.updateCall(C, row.id, { state: "completed", outcome_kind: "dropped_before_confirmation" });
  }
  const out = await runTool("call_status", {}, { conversationId: C, calls });
  assert.equal(out.calls.length, 5);
  assert.ok(!out.calls.some(cv => cv.call_id === sunday), "the five in full are all to the owner — the old shape missed Yaw");
  const line = out.earlier_calls.find(e => e.call_id === sunday);
  assert.ok(line, "Sunday's call is in the index the model reads");
  assert.match(line.goal, /Yaw/);
  assert.equal(line.to, YAW);
  assert.match(out.earlier_note, /before saying there is none/);
});
