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
// Calling hours off in here, so these tests do not depend on what time it is when the suite runs
// (REASON_CALL_QUIET_HOURS defaults to 21:00-08:00, and a suite run at midnight would see every
// call refused for the hour rather than for the reason being tested). The window itself is proven
// in test/call-handling.test.js, against a fixed clock.
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
// Not an undo-window test: anything reaching a third party is normally held for 30 seconds
// before it really goes, which would make every send in here come back 'held' instead of done.
// Off, so these keep asking what they are about. test/undo-window.test.js is where the window
// itself is proven.
process.env.REASON_UNDO_SECONDS = "0";

const { runTool, capabilitiesNow, settleLostCalls, callLostAfterMs } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const { CallProvider } = await import("../src/calls/provider.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
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

test("an ask to ring somebody that never says who is refused before anybody is asked", async () => {
  const asked = await runTool("confirm_request", { action: "call_place", summary: "ring the italian place" },
    { conversationId: C, messages: [owner("ring them")] });
  assert.equal(asked.ok, false, "a yes tied to no number could never have placed a call");
  assert.equal(asked.blocked, "ask_says_nothing");
  assert.ok(asked.missing.some(m => /target/.test(m)));
  assert.equal(asked.confirmation_id, undefined);
});

test("a yes that never said who it was for cannot reach anyone", async () => {
  const calls = new FakeCallProvider();
  // Written straight through the gate, because the tool now refuses to ASK this one (above). The
  // guard underneath is its own property and still has to hold for a row from any other source.
  const asked = trust.requestConfirmation({
    conversationId: C, messages: [owner("ring them")],
    action: "call_place", summary: "ring the italian place", stakes: "third_party",
  });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("ring them"), owner("yeah go")], judge: async () => ({ verdict: "yes" }) });

  const out = await runTool("call_place", { to: PLACE, goal: "x", confirmation_id: asked.confirmation_id }, { conversationId: C, calls });
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

test("a call to the owner opens with a greeting, not 'a call for Omari' and the recording line (2026-10-17)", async () => {
  // The owner's conversation has somewhere to text, so the once-ever recording note can go out.
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: OWNER, name: "Omari", isOperator: true });
  db.db.exec("UPDATE accounts SET told_calls_recorded_at = NULL; DELETE FROM outbox;");
  const outbox = () => db.db.prepare("SELECT * FROM outbox ORDER BY id").all().filter(o => /every call is recorded/.test(o.body));

  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: "owner", goal: "tell them the handyman cancelled" }, { conversationId: C, calls });
  assert.equal(out.ok, true);
  const opened = calls.placed[0].announcement;
  assert.doesNotMatch(opened, /recorded|AI assistant|call(ing)? for/i, opened);
  assert.match(opened, /^hey Omari, what's up\?$/, "the owner is asked straight away, not just greeted");
  assert.doesNotMatch(out.note, /opened by saying it is an AI assistant/);
  assert.equal(db.listCalls(C)[0].announcement, opened);

  // The disclosure still happens — once, by text, the same note an inbound call sends — and a
  // second call does not say it again.
  assert.equal(outbox().length, 1);
  await runTool("call_place", { to: "owner", goal: "again" }, { conversationId: C, calls });
  assert.equal(outbox().length, 1, "told once ever");

  // And a third party still hears the full line.
  const id = await yesFor("call the restaurant", { target: PLACE });
  await runTool("call_place", { to: PLACE, goal: "book a table", confirmation_id: id }, { conversationId: C, calls });
  assert.match(calls.placed.at(-1).announcement, /AI assistant calling for Omari.*recorded/);
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

// ---------- a row that says a call is going, long after it stopped ----------
//
// Found 2026-10-17: four owner calls from 2026-10-12 still read `in_progress` five days later. A row
// leaves that state when the post-call webhook arrives or when `call_status` asks — and these got
// neither, so nothing was ever going to settle them. `pendingCallVerification` and `liveErrandCalls`
// both read "is a call going", and "is a call live right now?" is the question asked before a restart.

test("a call still claiming to be in progress is settled from the provider, late", async () => {
  const calls = new FakeCallProvider();
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  assert.equal(db.getCall(C, call_id).state, "placing", "nothing has settled it yet");

  // Not yet: a call that started a minute ago may really be going, and the provider is not asked
  // about a live call on a timer.
  clock.skip(60_000);
  assert.deepEqual(await settleLostCalls({ calls }), { found: 0, settled: 0, unknown: 0, still_going: 0 });

  clock.skip(callLostAfterMs());
  const seen = [];
  const out = await settleLostCalls({ calls, log: (l) => seen.push(l) });
  assert.deepEqual(out, { found: 1, settled: 1, unknown: 0, still_going: 0 });

  // Settled through the same path a webhook uses, so the row got everything it would have got.
  const row = db.getCall(C, call_id);
  assert.equal(row.state, "completed");
  assert.equal(row.outcome, "they answered");
  assert.equal(row.duration_s, 42);
  assert.match(row.transcript, /sure, that works/);
  assert.ok(row.ended_at, "and it has an end time");
  assert.ok(seen.some(l => l.call_settled_late === call_id));

  // Once settled it is not a lost call any more, however many sweeps follow.
  assert.equal((await settleLostCalls({ calls })).found, 0);
});

test("a call the provider says is still going is believed, not written off", async () => {
  // A business call on hold for twenty minutes is a call. Guessing against the only thing that
  // knows is how a live call gets written down as dead.
  const calls = new FakeCallProvider({ script: [{ state: "in_progress", outcome: "on the call now" }] });
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  clock.skip(callLostAfterMs() + 1000);

  const out = await settleLostCalls({ calls });
  assert.deepEqual(out, { found: 1, settled: 0, unknown: 0, still_going: 1 });
  assert.equal(db.getCall(C, call_id).state, "placing", "left exactly as it was");
  assert.equal(db.getCall(C, call_id).ended_at, null);
});

test("a call nobody can account for says that, rather than claiming an outcome", async () => {
  // The real shape of the four found on 2026-10-12: a row with an id nobody will answer about. It
  // must not become "they answered" and it must not stay "on the call now".
  const calls = new FakeCallProvider();
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  calls.results.delete("fake-call-1");
  clock.skip(callLostAfterMs() + 1000);

  const seen = [];
  const out = await settleLostCalls({ calls, log: (l) => seen.push(l) });
  assert.deepEqual(out, { found: 1, settled: 0, unknown: 1, still_going: 0 });

  const row = db.getCall(C, call_id);
  assert.equal(row.state, "failed");
  assert.match(row.outcome, /not known how this call ended/);
  assert.equal(row.outcome_kind, "failed");
  assert.ok(row.ended_at, "it has an end time, so nothing reads it as live");
  // A missing recording is a broken promise and raises a fault. This is a call nobody can prove
  // happened, so there is no promise to have broken.
  assert.equal(row.recording_state, "not_applicable");
  assert.equal(db.listActions(C).filter(r => r.action === "call_recording").length, 0);
  assert.ok(seen.some(l => l.call_lost === call_id));
});

test("with no provider at all, a stuck row is still not left claiming to be live", async () => {
  const calls = new FakeCallProvider();
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  clock.skip(callLostAfterMs() + 1000);

  // The install's provider was switched off between the call and the sweep.
  const out = await settleLostCalls({ calls: null });
  assert.deepEqual(out, { found: 1, settled: 0, unknown: 1, still_going: 0 });
  assert.match(db.getCall(C, call_id).outcome, /nothing ever reported/);
  assert.equal(db.getCall(C, call_id).state, "failed");
});

test("the sweep settles lost calls without being asked, and reports what it did", async () => {
  // The whole point: the two existing paths both need a trigger, and these rows got neither.
  const calls = new FakeCallProvider();
  const { call_id } = await runTool("call_place", { to: "owner", goal: "x" }, { conversationId: C, calls });
  clock.skip(callLostAfterMs() + 1000);

  const { Runtime } = await import("../src/runtime.js");
  const runtime = new Runtime({ runTurn: async () => "", calls, log: () => {} });
  const out = await runtime.lostCalls();
  assert.deepEqual(out, { found: 1, settled: 1, unknown: 0, still_going: 0 });
  assert.equal(db.getCall(C, call_id).state, "completed");
});

// ---------- the lost-call window is the platform's ceiling, not the 10-minute setting ----------
// Since b10b6ab no per-call ceiling is sent to the voice platform (ElevenLabs refused the override), so a call runs to
// the agent's own limit — an hour. Owner calls of 14–15 minutes have happened (calls 32, 35). Sweeping
// at callMaxMinutes + 15 (25 minutes) wrote a live half-hour call down as lost.

test("a call thirty minutes in is still a call: the sweep waits for the platform's hour, plus grace", async () => {
  // A provider that cannot be reached is the case that matters: the sweep then writes the row off.
  const { call_id } = await runTool("call_place", { to: "owner", goal: "a long one" }, { conversationId: C, calls: new FakeCallProvider() });
  db.updateCall(C, call_id, { state: "in_progress" });

  clock.skip(30 * 60 * 1000);
  const seen = [];
  const out = await settleLostCalls({ calls: null, log: (l) => seen.push(l) });
  assert.equal(out.found, 0, "a 30-minute-old call in progress is not swept");
  assert.equal(db.getCall(C, call_id).state, "in_progress");
  assert.ok(!seen.some(l => l.call_lost), "and nothing says it was lost");
  assert.ok(callLostAfterMs() >= 3600 * 1000, "the window is at least the platform's 3600 s ceiling");

  // Past the platform's hour and the grace, nobody can say how it ended: then it is written down.
  clock.skip(callLostAfterMs());
  assert.equal((await settleLostCalls({ calls: null })).unknown, 1);
  assert.equal(db.getCall(C, call_id).state, "failed");
});

test("a call nobody answered keeps the short window: swept after 25 minutes, not an hour", async () => {
  // A missed scheduled call owes its text promptly, and a stuck `placing` row counts against an
  // errand's parallel limit. Only a call somebody is talking on gets the platform's hour.
  const { call_id } = await runTool("call_place", { to: "owner", goal: "never picked up" }, { conversationId: C, calls: new FakeCallProvider() });
  assert.equal(db.getCall(C, call_id).state, "placing");
  clock.skip(30 * 60 * 1000);
  const out = await settleLostCalls({ calls: null });
  assert.equal(out.found, 1, "a 30-minute-old call still placing is swept");
  assert.equal(db.getCall(C, call_id).state, "failed");
  assert.ok(callLostAfterMs("placing") <= 25 * 60 * 1000);
});
