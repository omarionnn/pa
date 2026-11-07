// Several calls that are one request, through the real tools.
//
// test/call-handling.test.js proves the modules and test/call-onthephone.test.js proves what happens on
// the line. This proves the part the model actually touches: that `call_place` builds a brief from what
// the owner approved and refuses one it cannot, that an errand's legs all get the same questions, that
// the quiet window and the did-this-already-happen check run before anybody's phone rings, and that
// `call_errand_status` reports who never answered rather than quietly dropping them.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-errand-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
process.env.REASON_MAX_CALLS_PER_DAY = "0";
process.env.REASON_CALL_MAX_PARALLEL = "3";
process.env.REASON_CALL_MAX_RETRIES = "1";
process.env.REASON_CALL_QUIET_HOURS = "21:00-08:00";
process.env.REASON_UNDO_SECONDS = "0";

const { runTool } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { clock, config } = await import("../src/config.js");
const errandMod = await import("../src/calls/errand.js");
const brief = await import("../src/calls/brief.js");

const C = config.ownerConversation;
let nth = 0;
const newNumber = () => `+1212555${String(4000 + (nth += 1)).slice(-4)}`;

// A fixed, daytime clock, so nothing in here turns on what time the suite runs.
const NOON = Date.parse("2026-10-07T12:00:00-04:00");
const atNoon = () => { clock.reset(); clock.skip(NOON - Date.now()); };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM call_errands; DELETE FROM call_quotes; DELETE FROM call_commitments;");
  atNoon();
});

const owner = (t) => ({ role: "user", content: `[Wed, Oct 7, 2026, 12:00 PM] Omari: ${t}` });

// A call's yes is pinned to the person AND the brief (audit lead 26), so the ask can only be made
// once the brief is known: yesFor marks the call as one he said yes to, and place asks about exactly
// the call_place input it is about to send (trust.personPin of it), records the yes, then places it.
async function yesFor(summary) {
  return { yesFor: summary };
}

async function askAndRecord(summary, input) {
  const asked = await runTool("confirm_request", { action: "call_place", summary, target: trust.personPin("call_place", input) },
    { conversationId: C, messages: [owner("do it")] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("do it"), owner("yeah go")], judge: async () => ({ verdict: "yes" }) });
  return asked.confirmation_id;
}

const place = async (args, calls) => {
  if (args.confirmation_id?.yesFor) {
    const { confirmation_id, ...input } = args;
    args = { ...input, confirmation_id: await askAndRecord(confirmation_id.yesFor, input) };
  }
  return runTool("call_place", args, { conversationId: C, calls });
};

// ---------- the brief, built from what he approved ----------

test("a call with no may_book is an asking call, and says so in what comes back", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const out = await place({
    to, goal: "ask what a deep clean costs", confirmation_id: await yesFor(`ring ${to} about a clean`, to),
  }, calls);

  assert.equal(out.ok, true);
  assert.equal(out.may_agree, false);
  assert.match(out.note, /ASKING only/);
  assert.match(out.note, /do not tell Omari it is arranged/);
  // The brief really went to the provider, as its own argument.
  assert.equal(calls.placed[0].brief.approved.book, false);
  // And it is on the row, so the voice turn an hour from now is held to it.
  assert.equal(JSON.parse(db.getCall(C, out.call_id).brief).approved.book, false);
});

test("a booking call carries its ceiling and what has to be read back", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const out = await place({
    to, goal: "book the clean for Saturday", may_book: true, max_price_cents: 20000,
    approved_terms: ["a deposit of up to fifty dollars"], read_back: ["date", "time", "price"],
    requirements: { name: "Omari", address: "180 Lafayette St" },
    confirmation_id: await yesFor(`ring ${to} to book`, to),
  }, calls);

  assert.equal(out.ok, true);
  assert.equal(out.may_agree, true);
  const b = calls.placed[0].brief;
  assert.equal(b.approved.maxCents, 20000);
  assert.deepEqual(b.readBack, ["date", "time", "price"]);
  assert.equal(b.requirements.name, "Omari");
  assert.match(out.note, /MAY agree/);
});

test("a booking call that names nothing to read back is refused before anybody's phone rings", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const out = await place({
    to, goal: "book it", may_book: true, confirmation_id: await yesFor(`ring ${to}`, to),
  }, calls);
  assert.equal(out.ok, false);
  assert.equal(out.status, "brief_refused");
  assert.match(out.error, /has to name what gets read back/);
  assert.equal(calls.placed.length, 0);
  assert.equal(db.listCalls(C).length, 0, "nothing is written down for a call that was never allowed");
});

test("the hold budget is per call and really reaches the row", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const out = await place({
    to, goal: "ask about a clean", max_hold_minutes: 12, confirmation_id: await yesFor(`ring ${to}`, to),
  }, calls);
  assert.equal(out.waits_up_to_minutes, 12);
  assert.equal(db.getCall(C, out.call_id).hold_budget_s, 720);
  assert.match(out.note, /wait on hold up to 12 minute/);
});

// ---------- not at half eleven at night ----------

test("a third party is not rung inside the quiet window, and it is said out loud", async () => {
  const calls = new FakeCallProvider();
  clock.skip(Date.parse("2026-10-07T23:30:00-04:00") - clock.now());
  const to = newNumber();
  const out = await place({ to, goal: "ask about a clean", confirmation_id: await yesFor(`ring ${to}`, to) }, calls);

  assert.equal(out.ok, false);
  assert.equal(out.status, "quiet_hours");
  assert.match(out.error, /23:30/);
  assert.match(out.error, /Nobody's phone rang/);
  assert.match(out.error, /it is the hour, not a failure/);
  assert.match(out.error, /REASON_CALL_QUIET_HOURS/);
  assert.equal(calls.placed.length, 0);
});

test("his own phone is never silenced by the window", async () => {
  const calls = new FakeCallProvider();
  clock.skip(Date.parse("2026-10-07T23:30:00-04:00") - clock.now());
  const out = await place({ to: "owner", goal: "tell him the clean is booked" }, calls);
  assert.equal(out.ok, true, "a call he asked for at midnight is a call he asked for");
});

// ---------- did this already happen ----------

test("a call that dropped after 'yes' comes back to ASK, and cannot book", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const first = await place({
    to, goal: "book a table for four at eight", may_book: true, max_price_cents: 20000,
    read_back: ["date", "time"], confirmation_id: await yesFor(`ring ${to} to book`, to),
  }, calls);
  db.updateCall(C, first.call_id, { state: "completed", outcome_kind: "dropped_before_confirmation" });

  const second = await place({
    to, goal: "book a table for four at eight", may_book: true, max_price_cents: 20000,
    read_back: ["date", "time"], confirmation_id: await yesFor(`ring ${to} again`, to),
  }, calls);

  assert.equal(second.ok, true);
  // The goal was REWRITTEN. This is the whole point: calling back with the original goal is how
  // somebody ends up with two tables and two charges.
  assert.match(second.goal, /Find out whether this already went through/);
  assert.equal(second.may_agree, false);
  assert.equal(calls.placed[1].brief.approved.book, false);
  assert.equal(db.getCall(C, second.call_id).attempt, 2);
});

test("a number with something already booked at it is not rung back to book again", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const first = await place({
    to, goal: "book the clean", may_book: true, max_price_cents: 20000, read_back: ["date"],
    confirmation_id: await yesFor(`ring ${to} to book`, to),
  }, calls);
  db.createCommitment(C, { callId: first.call_id, what: "the clean on Saturday", state: "committed" });
  db.updateCommitment(C, db.callCommitments(C, first.call_id)[0].id, { state: "committed", reference: "AA-9" });

  const again = await place({
    to, goal: "book the clean", may_book: true, max_price_cents: 20000, read_back: ["date"],
    confirmation_id: await yesFor(`ring ${to}`, to),
  }, calls);
  assert.equal(again.ok, false);
  assert.equal(again.status, "already_happened");
  assert.match(again.error, /already arranged/);
  assert.match(again.note, /already arranged/);
  assert.equal(calls.placed.length, 1, "the second call never happened");
});

test("one voicemail per number: the second attempt is refused", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const first = await place({ to, goal: "ask about a clean", confirmation_id: await yesFor(`ring ${to}`, to) }, calls);
  db.updateCall(C, first.call_id, { state: "voicemail", outcome_kind: "voicemail_left", voicemail_left: 1 });

  const again = await place({ to, goal: "ask about a clean", confirmation_id: await yesFor(`ring ${to}`, to) }, calls);
  assert.equal(again.ok, false);
  assert.match(again.error, /Do not ring back to leave another/);
});

// ---------- one errand, several legs ----------

test("an errand hands every leg the same questions, and no leg of an inquiry can book", async () => {
  const calls = new FakeCallProvider();
  const e = await runTool("call_errand_start", { goal: "cheapest deep clean this week" }, { conversationId: C });
  assert.equal(e.ok, true);
  assert.deepEqual(e.asking, brief.CORE_QUESTIONS);
  assert.equal(e.max_at_once, 3);
  assert.match(e.note, /SAME questions/);
  assert.match(e.note, /never answered, which you must not leave out/);

  const legs = [];
  for (let i = 0; i < 3; i++) {
    const to = newNumber();
    const out = await place({
      to, goal: "ask the questions", errand_id: e.errand_id,
      // Asked for explicitly, and refused anyway: the errand's kind is the ceiling.
      may_book: true, max_price_cents: 99999, read_back: ["price"],
      confirmation_id: await yesFor(`ring ${to}`, to),
    }, calls);
    assert.equal(out.ok, true);
    assert.equal(out.may_agree, false, "an inquiry errand's leg can never book");
    assert.deepEqual(out.asking, brief.CORE_QUESTIONS);
    legs.push(out);
  }
  for (const p of calls.placed) assert.deepEqual(p.brief.questions, brief.CORE_QUESTIONS);

  // A fourth while three are live is over the parallel limit.
  const to4 = newNumber();
  const fourth = await place({
    to: to4, goal: "ask the questions", errand_id: e.errand_id, confirmation_id: await yesFor(`ring ${to4}`, to4),
  }, calls);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.status, "errand_full");
  assert.match(fourth.error, /REASON_CALL_MAX_PARALLEL/);
});

test("errand_status reports who never answered, labels firm vs estimate, and asks him to decide", async () => {
  const calls = new FakeCallProvider();
  const e = await runTool("call_errand_start", { goal: "cheapest deep clean this week" }, { conversationId: C });

  const made = [];
  for (const spec of [
    { place: "Clean Co", total: 18000, firmness: "firm", earliest: "Thursday", holds: "until Thursday", outcome: "answered" },
    { place: "Bright", total: 21000, firmness: "estimate", earliest: "tomorrow", holds: "", outcome: "answered" },
    { place: "Dustbusters", total: null, firmness: "unknown", earliest: "", holds: "", outcome: "no_answer" },
  ]) {
    const to = newNumber();
    const out = await place({ to, goal: "ask", errand_id: e.errand_id, confirmation_id: await yesFor(`ring ${to}`, to) }, calls);
    db.updateCall(C, out.call_id, { state: "completed", outcome_kind: spec.outcome });
    errandMod.noteAnswer(C, {
      errandId: e.errand_id, callId: out.call_id, place: spec.place, totalCents: spec.total,
      firmness: spec.firmness, earliest: spec.earliest, holdsUntil: spec.holds,
    });
    made.push(out);
  }

  const st = await runTool("call_errand_status", { errand_id: e.errand_id }, { conversationId: C });
  assert.equal(st.ok, true);
  assert.equal(st.called, 3);
  assert.equal(st.reached, 2);
  assert.equal(st.still_ringing, 0);
  assert.deepEqual(st.quotes.map(q => [q.place, q.total_cents, q.firmness]), [
    ["Clean Co", 18000, "firm"], ["Bright", 21000, "estimate"],
  ]);
  assert.deepEqual(st.never_answered, [{ place: "Dustbusters", what_happened: "could not reach them" }]);

  // What he actually reads: his own example's shape, written from rows.
  assert.match(st.for_the_owner, /^I reached 2 of 3 places\./m);
  assert.match(st.for_the_owner, /Clean Co: \$180.*cheapest/);
  assert.match(st.for_the_owner, /Dustbusters: could not reach them/);
  assert.match(st.for_the_owner, /Want me to book one\?$/);
  assert.match(st.note, /Committing is Omari's/);

  // And it is treated as what it is: words strangers said down a phone.
  assert.ok(st.untrusted_content, "a place that wants Reason to do something is as plausible as a web page that does");
  assert.match(st.untrusted_source, /what was said on the phone/);
});

test("an errand still ringing is not presented as a final answer", async () => {
  const calls = new FakeCallProvider();
  const e = await runTool("call_errand_start", { goal: "x" }, { conversationId: C });
  const to = newNumber();
  await place({ to, goal: "ask", errand_id: e.errand_id, confirmation_id: await yesFor(`ring ${to}`, to) }, calls);
  const st = await runTool("call_errand_status", { errand_id: e.errand_id }, { conversationId: C });
  assert.equal(st.still_ringing, 1);
  assert.match(st.note, /still going, so this is not the final answer/);
});

test("a booking errand serialises its bookings behind one lock", async () => {
  const calls = new FakeCallProvider();
  const e = await runTool("call_errand_start", { goal: "book the cheapest", kind: "booking" }, { conversationId: C });
  const to = newNumber();
  const first = await place({
    to, goal: "book it", errand_id: e.errand_id, may_book: true, max_price_cents: 20000, read_back: ["date"],
    confirmation_id: await yesFor(`ring ${to}`, to),
  }, calls);
  assert.equal(first.ok, true);
  assert.equal(first.may_agree, true, "a booking errand's leg may book");

  // A second booking leg while the first is live is refused: bookings are one at a time, always.
  const to2 = newNumber();
  const second = await place({
    to: to2, goal: "book it", errand_id: e.errand_id, may_book: true, max_price_cents: 20000, read_back: ["date"],
    confirmation_id: await yesFor(`ring ${to2}`, to2),
  }, calls);
  assert.equal(second.ok, false);
  assert.match(second.error, /one at a time/);
});

test("an errand that nobody quoted says so and offers something, rather than an empty comparison", async () => {
  const calls = new FakeCallProvider();
  const e = await runTool("call_errand_start", { goal: "x" }, { conversationId: C });
  const to = newNumber();
  const out = await place({ to, goal: "ask", errand_id: e.errand_id, confirmation_id: await yesFor(`ring ${to}`, to) }, calls);
  db.updateCall(C, out.call_id, { state: "no_answer", outcome_kind: "no_answer" });
  const st = await runTool("call_errand_status", { errand_id: e.errand_id }, { conversationId: C });
  assert.deepEqual(st.quotes, []);
  assert.match(st.for_the_owner, /I reached 0 of 1 place\./);
  assert.match(st.for_the_owner, /Nobody gave me a price/);
});

// ---------- what call_status is allowed to claim ----------

test("a call that reached somebody and settled nothing is reported as not done", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const out = await place({ to, goal: "ask about a clean", confirmation_id: await yesFor(`ring ${to}`, to) }, calls);
  const st = await runTool("call_status", { call_id: out.call_id }, { conversationId: C, calls });
  const view = st.calls[0];

  // The fake provider's call completes and its transcript reads perfectly well. Nothing on the call
  // confirmed anything, so the outcome is the honest one.
  assert.equal(view.state, "completed");
  assert.equal(view.what_happened, "the call dropped before it was confirmed");
  assert.match(view.is_it_done, /^NO\./);
  assert.match(view.is_it_done, /Do not tell Omari this is done, arranged or booked/);
  // And the one that prevents a double booking.
  assert.match(view.is_it_done, /ring back to ASK whether it exists, never to make it again/);
});

test("a confirmed call says so, and says what the confirmation rests on", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const out = await place({
    to, goal: "book it", may_book: true, max_price_cents: 20000, read_back: ["date"],
    confirmation_id: await yesFor(`ring ${to}`, to),
  }, calls);
  // Confirmed on the call, with no reference and nothing promised in writing.
  db.updateCall(C, out.call_id, { outcome_kind: "confirmed", confirmation_strength: "spoken_only" });
  const spoken = (await runTool("call_status", { call_id: out.call_id }, { conversationId: C, calls })).calls[0];
  assert.match(spoken.is_it_done, /Confirmed on the call ONLY/);
  assert.match(spoken.is_it_done, /that is what it rests on/);

  // With a reference it is a different claim, and he is given the reference.
  db.updateCall(C, out.call_id, { confirmation_ref: "XK-2291", confirmation_strength: "documented" });
  const documented = (await runTool("call_status", { call_id: out.call_id }, { conversationId: C, calls })).calls[0];
  assert.match(documented.is_it_done, /^Yes — confirmed, reference XK-2291/);
  assert.equal(documented.confirmation, "XK-2291");
});

test("a hold that ran out reports as that, with how long it waited, and not as a failure", async () => {
  const calls = new FakeCallProvider();
  const to = newNumber();
  const out = await place({ to, goal: "ask", confirmation_id: await yesFor(`ring ${to}`, to) }, calls);
  db.updateCall(C, out.call_id, { outcome_kind: "hold_gave_up", hold_total_s: 300, hold_gave_up: 1 });
  const view = (await runTool("call_status", { call_id: out.call_id }, { conversationId: C, calls })).calls[0];
  assert.equal(view.what_happened, "nobody came to the phone in time");
  assert.equal(view.held_for_seconds, 300);
  assert.match(view.is_it_done, /waited on hold for as long as it was allowed/);
});
