// Phone calls, with a provider that dials nothing. No API key, no telephony account, no ringing.
//
// What this proves is the part that has to be right before a real provider is ever plugged in:
// that calling a third party cannot happen without an explicit yes naming that exact number,
// that a placed call is never reported as a finished one, that only the approved facts go out,
// and that every call leaves a receipt whether it connected or not.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-calls-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const { CallProvider } = await import("../src/calls/provider.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const PLACE = "+12125559999";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads;");
});

const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });

/** Ask, answer yes, and hand back the confirmation id — the gate's happy path, stated not read. */
async function yesFor(summary, { action = "call_place", target } = {}) {
  const asked = await runTool("confirm_request", { action, summary, ...(target ? { target } : {}) },
    { conversationId: C, messages: [owner("do it")] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("do it"), owner("yeah go")], judge: async () => ({ verdict: "yes" }) });
  return asked.confirmation_id;
}

test("with no provider, call_place says so and nothing is recorded", async () => {
  const out = await runTool("call_place", { to: OWNER, goal: "tell them dinner moved" }, { conversationId: C });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
  assert.match(out.error, /cannot call anyone/i);
  assert.equal(db.listCalls(C).length, 0);
});

test("a provider that is switched off is not_connected, and capabilities repeats it", async () => {
  const calls = new FakeCallProvider({ live: false });
  const out = await runTool("call_place", { to: OWNER, goal: "x" }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.match(out.error, /REASON_TELEPHONY_KEY/);

  const phone = capabilitiesNow({ calls }).find(c => c.name === "phone_calls");
  assert.equal(phone.status, "not connected");
  assert.match(phone.what, /do not offer to/i);
});

test("the base CallProvider refuses rather than pretending", async () => {
  const p = new CallProvider();
  assert.equal(p.status().status, "not_connected");
  assert.equal((await p.place({})).ok, false);
  assert.equal((await p.check("x")).ok, false);
});

test("calling a third party without a yes is refused, and no phone is dialled", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: PLACE, goal: "ask for a table for 4 at 8" }, { conversationId: C, calls });

  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.deepEqual(calls.placed, [], "nothing rang");
  assert.equal(db.listCalls(C).length, 0, "and no call row was invented");

  const ledger = db.listActions(C);
  assert.equal(ledger[0].outcome, "blocked");
  assert.equal(ledger[0].target, `call:${PLACE}`, "the refusal names the number it would have rung");
});

test("a yes for one number does not authorize another", async () => {
  const calls = new FakeCallProvider();
  const id = await yesFor(`ring ${PLACE} to ask for a table for 4 at 8pm Saturday`, { target: PLACE });

  const wrong = await runTool("call_place", { to: "+13475550000", goal: "same thing", confirmation_id: id }, { conversationId: C, calls });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.blocked, "wrong_target");
  assert.match(wrong.error, /was for '\+12125559999', not '\+13475550000'/);
  assert.deepEqual(calls.placed, [], "the other number was never dialled");

  // And the yes it was aimed at still works, because nothing was spent on the refusal.
  const right = await runTool("call_place", { to: PLACE, goal: "the real one", confirmation_id: id }, { conversationId: C, calls });
  assert.equal(right.ok, true);
  assert.equal(calls.placed[0].to, PLACE);
});

test("a yes that never said who it was for cannot reach anyone", async () => {
  const calls = new FakeCallProvider();
  const id = await yesFor("ring the italian place");       // no target recorded
  const out = await runTool("call_place", { to: PLACE, goal: "x", confirmation_id: id }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "no_target_on_record");
  assert.match(out.error, /does not say who/i);
  assert.deepEqual(calls.placed, []);
});

test("how the number is written is not a different number", async () => {
  const calls = new FakeCallProvider();
  const id = await yesFor(`ring ${PLACE}`, { target: "+1 (212) 555-9999" });
  const out = await runTool("call_place", { to: PLACE, goal: "x", confirmation_id: id }, { conversationId: C, calls });
  assert.equal(out.ok, true, "formatting is not identity");
});

test("a real yes rings exactly once, shares only the approved facts, and leaves a receipt", async () => {
  const calls = new FakeCallProvider();
  const id = await yesFor(`ring ${PLACE} to ask for a table for 4 at 8pm Saturday, under Omari, 202-555-1234`, { target: PLACE });

  const out = await runTool("call_place", {
    to: PLACE, goal: "ask for a table for 4 at 8pm Saturday",
    facts: ["the name is Omari", "party of 4", "callback 202-555-1234"],
    confirmation_id: id,
  }, { conversationId: C, calls });

  assert.equal(out.ok, true);
  assert.equal(out.state, "placing");
  assert.match(out.note, /NOT finished/i);
  assert.equal(calls.placed.length, 1);
  assert.deepEqual(calls.placed[0].facts, ["the name is Omari", "party of 4", "callback 202-555-1234"],
    "the call may say these and nothing else");
  assert.equal(calls.placed[0].maxSeconds, 600);

  const ledger = db.listActions(C);
  assert.equal(ledger[0].outcome, "ok");
  assert.match(ledger[0].receipt, /Rang \+12125559999/);
  assert.match(ledger[0].receipt, /party of 4/);
  assert.equal(ledger[0].confirmation_id, id);

  // And the yes is spent: a second call on it is refused.
  const twice = await runTool("call_place", { to: PLACE, goal: "again", confirmation_id: id }, { conversationId: C, calls });
  assert.equal(twice.ok, false);
  assert.equal(twice.blocked, "already_spent");
  assert.equal(calls.placed.length, 1);
});

test("calling the owner needs no yes", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: "owner", goal: "tell them the handyman cancelled" }, { conversationId: C, calls });
  assert.equal(out.ok, true);
  assert.equal(calls.placed[0].to, OWNER);
  assert.equal(db.listCalls(C)[0].is_owner, 1);
});

test("a call that is still ringing has no outcome to claim", async () => {
  const calls = new FakeCallProvider({ ringFirst: true });
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });

  const mid = await runTool("call_status", { call_id }, { conversationId: C, calls });
  assert.equal(mid.calls[0].state, "ringing");
  assert.equal(mid.calls[0].still_going, true);
  assert.equal(mid.calls[0].outcome, null);
  assert.equal(mid.calls[0].what_was_said, null);
  assert.match(mid.note, /do not say you do/i);

  const done = await runTool("call_status", { call_id }, { conversationId: C, calls });
  assert.equal(done.calls[0].state, "completed");
  assert.equal(done.calls[0].still_going, false);
  assert.match(done.calls[0].what_was_said, /Answered/);
  assert.equal(done.calls[0].seconds, 42);
  assert.equal(done.calls[0].cost, "$0.03");
});

test("a finished call is read off the record and never re-dialled", async () => {
  const calls = new FakeCallProvider();
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  await runTool("call_status", { call_id }, { conversationId: C, calls });
  const checksAfterSettling = calls.checks.get("fake-call-1");

  await runTool("call_status", { call_id }, { conversationId: C, calls });
  assert.equal(calls.checks.get("fake-call-1"), checksAfterSettling, "a settled call is not asked about again");
  assert.equal(calls.placed.length, 1, "and certainly not rung again");
});

test("nobody picking up is a real outcome, reported as itself", async () => {
  const calls = new FakeCallProvider({ script: [{ state: "no_answer", outcome: "nobody picked up", summary: "Rang out after 30 seconds.", transcript: "", durationS: 30, costCents: 1 }] });
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  const out = await runTool("call_status", { call_id }, { conversationId: C, calls });
  assert.equal(out.calls[0].state, "no_answer");
  assert.equal(out.calls[0].outcome, "nobody picked up");
  assert.equal(out.calls[0].still_going, false);
});

test("a call that cannot be placed says nobody's phone rang, and is on the record", async () => {
  const calls = new FakeCallProvider({ script: [{ placeFails: "no lines available" }] });
  const out = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });

  assert.equal(out.ok, false);
  assert.match(out.error, /nobody's phone rang/i);
  assert.match(out.error, /no lines available/);

  const row = db.getCall(C, out.call_id);
  assert.equal(row.state, "failed");
  assert.match(row.outcome, /could not be placed/);
});

test("a provider that throws is survived, not crashed through", async () => {
  const calls = new FakeCallProvider();
  calls.place = async () => { throw new Error("socket hang up"); };
  const out = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.match(out.error, /socket hang up/);
  assert.equal(db.getCall(C, out.call_id).state, "failed");
});

test("a number that is not a number is refused before anything is recorded", async () => {
  const calls = new FakeCallProvider();
  const id = await yesFor("ring the place", { target: "the italian place" });
  const out = await runTool("call_place", { to: "the italian place", goal: "x", confirmation_id: id }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.match(out.error, /E\.164/);
  assert.deepEqual(calls.placed, []);
});

test("with no number on file for this person, calling them says so rather than dialling nothing", async () => {
  // Their number comes off their own account now, not off one global setting.
  const noNumber = "dm:fake:nobody";
  db.upsertAccount({ conversationId: noNumber, channel: "test", address: "", name: "Kofi" });
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: noNumber, calls });
  assert.equal(out.ok, false);
  assert.match(out.error, /no number on file/i);
  assert.deepEqual(calls.placed, []);
});

test("a conversation that belongs to nobody cannot place a call at all", async () => {
  // In production an unapproved number never gets a turn, so this should be unreachable. The
  // guard does not rely on that: with no account there is nobody to act for, so nothing runs.
  const calls = new FakeCallProvider();
  const nobodys = "dm:fake:+14155559876";

  const out = await runTool("call_place", { to: "owner", goal: "pretend to be omari" }, { conversationId: nobodys, calls });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "no_account");
  assert.deepEqual(calls.placed, []);
});

test("call_status with no id lists this conversation's calls only", async () => {
  const calls = new FakeCallProvider();
  await runTool("call_place", { to: "owner", goal: "one" }, { conversationId: C, calls });
  const mine = await runTool("call_status", {}, { conversationId: C, calls });
  assert.equal(mine.count, 1);

  const theirs = await runTool("call_status", {}, { conversationId: "dm:elsewhere", calls });
  assert.equal(theirs.count, 0);
  assert.match(theirs.note, /no calls/i);
});

test("with a provider live, capabilities says calls work and names the gate", () => {
  const phone = capabilitiesNow({ calls: new FakeCallProvider() }).find(c => c.name === "phone_calls");
  assert.equal(phone.status, "live");
  assert.match(phone.what, /needs an explicit yes/i);
});
