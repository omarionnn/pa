// What a real phone call is actually like: hold, phone menus, a receptionist putting you through, a
// price that changed, a line that dropped right after "yes", and six places asked the same questions.
//
// No model and no network. These are the owner's own acceptance tests from 2026-10-06 reduced to the
// parts that are decidable without audio — which is most of them, because almost every one of these
// failures is a state machine getting it wrong rather than a voice mishearing something.
//
// The ones that genuinely need a phone (does `skip_turn` really stay silent through hold MUSIC; is a
// new person detectable from the audio at all) are in docs/unverified.md and are Friday's.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-callhandling-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_HOLD_SECONDS = "300";
process.env.REASON_CALL_MAX_PARALLEL = "3";
process.env.REASON_CALL_MAX_RETRIES = "1";

const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const hold = await import("../src/calls/hold.js");
const commit = await import("../src/calls/commit.js");
const errand = await import("../src/calls/errand.js");
const redial = await import("../src/calls/redial.js");
const outcome = await import("../src/calls/outcome.js");
const brief = await import("../src/calls/brief.js");
const readback = await import("../src/calls/readback.js");

const C = config.ownerConversation;

// Every call gets its own number unless a test names one. The tests share one database, and the
// redial rules are deliberately keyed on the NUMBER rather than the errand — so two tests that both
// used a default number would have the second one tripping the first one's retry limit. That is the
// rules working; sharing a number by accident is the test's bug.
let nth = 0;
const newNumber = () => `+1212555${String(1000 + (nth += 1)).slice(-4)}`;

const makeCall = (over = {}) => {
  const row = db.createCall(C, {
    provider: "gptlive", toNumber: over.to_number ?? newNumber(), isOwner: false,
    goal: "book a table", facts: [], announcement: "x",
  });
  if (Object.keys(over).length) db.updateCall(C, row.id, over);
  return db.getCall(C, row.id);
};

beforeEach(() => { clock.reset(); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

// ---------- hold ----------

test("hold is measured by us, because their silence timer never fires against music", () => {
  const call = makeCall();
  assert.equal(hold.onHold(call), false);

  const first = hold.noteWaiting(call, { reason: "hold music" });
  assert.equal(first.wait, true);
  assert.equal(hold.onHold(call), true);

  clock.skip(90_000);
  const second = hold.noteWaiting(call, { reason: "still music" });
  assert.equal(second.wait, true);
  assert.equal(second.seconds, 90);
  assert.equal(hold.holdSeconds(call), 90);
  assert.equal(hold.holdLeft(call), 210);
});

test("a long hold inside the limit: the human comes back and it picks up where it was", () => {
  const call = makeCall();
  hold.noteWaiting(call);
  clock.skip(240_000);
  assert.equal(hold.noteWaiting(call).wait, true, "four minutes is inside the five-minute budget");

  // Reason speaks instead of waiting, which is the whole detector: no regex, no audio analysis.
  const off = hold.noteSpeaking(call);
  assert.equal(off.waited, 240);
  assert.equal(hold.onHold(call), false);
  // The time is banked, so a second hold on the same call adds to it rather than starting over.
  assert.equal(hold.holdSeconds(call), 240);
  hold.noteWaiting(call);
  clock.skip(30_000);
  assert.equal(hold.holdSeconds(call), 270);
});

test("a hold that blows the budget ends politely, and is not reported as a failure", () => {
  const call = makeCall();
  hold.noteWaiting(call);
  clock.skip(301_000);
  const gone = hold.noteWaiting(call);
  assert.equal(gone.wait, false);
  assert.match(gone.line, /holding a while/i);
  assert.match(gone.line, /try again later/i);
  // The hold is closed out rather than left open, or every later read would keep growing it.
  assert.equal(hold.onHold(db.getCall(C, call.id)), false);
  assert.equal(db.getCall(C, call.id).hold_gave_up, 1);

  const kind = outcome.outcomeFor({ state: "completed", gaveUpOnHold: true });
  assert.equal(kind, "hold_gave_up");
  assert.equal(outcome.isSuccess(kind), false);
  assert.equal(outcome.OUTCOMES[kind].label, "nobody came to the phone in time");
  // And crucially NOT "could not reach them": it did reach them, which changes what he does next.
  assert.notEqual(kind, "no_answer");
});

test("a per-call budget from the brief beats the install default", () => {
  const call = makeCall({ hold_budget_s: 60 });
  hold.noteWaiting(call);
  clock.skip(61_000);
  assert.equal(hold.noteWaiting(call).wait, false);
});

// ---------- a different human on the line ----------

test("a transfer re-says the announcement, because the disclosure belongs to the person", () => {
  const call = makeCall();
  hold.markAnnounced(call, { party: 1 });
  hold.noteWaiting(call);
  clock.skip(20_000);

  const put = hold.newParty(call, { who: "the catering manager" });
  assert.equal(put.newPerson, true);
  assert.equal(put.announce, true);
  assert.equal(put.party, 2);
  assert.match(put.announcement, /AI assistant/);
  assert.match(put.announcement, /Omari/);
  assert.match(put.announcement, /recorded/);
  // Context survives: one sentence of catch-up, never a restart.
  assert.match(put.note, /ONE sentence/);
  assert.match(put.note, /you have not lost the call/i);
  assert.match(put.note, /Do not ask them to repeat/);
  // The hold ended when they spoke.
  assert.equal(hold.onHold(call), false);
});

test("the same person coming back from hold is not re-introduced to", () => {
  const call = makeCall();
  hold.markAnnounced(call, { party: 1 });
  hold.noteWaiting(call);
  clock.skip(130_000);

  const back = hold.newParty(call, { who: "the same guy", same: true });
  assert.equal(back.newPerson, false);
  assert.equal(back.announce, false);
  assert.equal(back.party, 1);
  assert.match(back.note, /Same person/);
  assert.match(back.note, /do not re-introduce/i);
  assert.match(back.note, /2 minute/);
});

test("the person on the line now is not read the disclosure twice", () => {
  const call = makeCall();
  hold.markAnnounced(call, { party: 1 });
  const second = hold.newParty(call, { who: "catering" });
  assert.equal(second.announce, true);
  hold.markAnnounced(call, { party: second.party });
  assert.deepEqual(hold.partiesTold(call), [1, 2]);

  // The real repeat risk: several turns with the same person. Calling it again for whoever is already
  // on the line changes nothing and says nothing.
  assert.equal(hold.markAnnounced(call).length, 2);
  const stillThem = hold.newParty(call, { who: "catering", same: true });
  assert.equal(stillThem.announce, false);
});

test("a handover BACK to someone who already heard it discloses again, which is the safe direction", () => {
  // Each handover is a new party number, so being put back to the first receptionist reads the line
  // out to them a second time. That is a known, deliberate wart rather than an oversight: the model
  // can tell that somebody different is speaking, but not reliably that it is the person from four
  // minutes ago. Over-disclosing costs one sentence; under-disclosing means a human who never knew
  // they were talking to an AI on a recorded call, so the tie is broken towards saying it again.
  const call = makeCall();
  hold.markAnnounced(call, { party: 1 });
  const toCatering = hold.newParty(call, { who: "catering" });
  hold.markAnnounced(call, { party: toCatering.party });
  const backToReception = hold.newParty(call, { who: "reception again" });
  assert.equal(backToReception.party, 3);
  assert.equal(backToReception.announce, true);
});

// ---------- phone menus ----------

test("a menu key is pressed, re-sent once, and then refused so a stuck menu is not billed forever", () => {
  const call = makeCall();
  assert.equal(hold.notePress(call, { tones: "2" }).ok, true);
  const again = hold.notePress(call, { tones: "2" });
  assert.equal(again.ok, true, "their docs say some IVRs miss in-band tones, so twice is legitimate");

  const third = hold.notePress(call, { tones: "2" });
  assert.equal(third.ok, false);
  assert.equal(third.stuck, true);
  assert.match(third.error, /option for a person you have not tried/);
  assert.deepEqual(hold.pressed(call), ["2", "2"]);
});

test("pause characters survive, and prose presses nothing rather than being salvaged", () => {
  const call = makeCall();
  assert.equal(hold.notePress(call, { tones: "1w1W#" }).tones, "1w1W#");
  // Separators are separators.
  assert.equal(hold.notePress(call, { tones: " 1w1, 2 " }).tones, "1w12");

  // Prose is refused. Stripping invalid characters out of "press 1w1 now" yields "1w1w" — the `w` comes
  // from "now" — which is a pause nobody asked for, pressed into somebody's phone system. Guessing is
  // worse than refusing here, and refusing comes back as a sentence the call can say out loud.
  const prose = hold.notePress(call, { tones: "press 1w1 now" });
  assert.equal(prose.ok, false);
  assert.match(prose.error, /is not a key sequence, so nothing was pressed/);
  assert.equal(hold.notePress(call, { tones: "abc" }).ok, false);
  assert.equal(hold.notePress(call, { tones: "" }).ok, false);
});

// ---------- what it may agree to ----------

test("an inquiry call cannot agree to anything, however good the offer", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "ask what a deep clean costs" });
  assert.equal(b.approved.book, false, "a brief agrees to nothing unless somebody said so");

  const r = commit.propose({ call, brief: b, what: "a deep clean on Saturday for $150" });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "ask_only");
  assert.match(r.say, /you are asking/i);
  assert.match(r.say, /Do not say yes/);
  // The attempt is on the record: "it nearly booked that" is the interesting thing to read later.
  assert.equal(db.callCommitments(C, call.id).length, 1);
  assert.equal(db.callCommitments(C, call.id)[0].state, "declined");
});

test("a price inside the approved ceiling goes ahead, and nothing is confirmed until they say yes", () => {
  const call = makeCall();
  const b = brief.buildBrief({
    goal: "book the deep clean", approved: { book: true, maxCents: 20000 }, readBack: ["date", "time", "price"],
  });
  const at = Date.parse("2026-10-14T15:00:00-04:00");
  const details = [...readback.moment({ at }), readback.detail({ kind: "price", value: 18000 })];

  const r = commit.propose({ call, brief: b, what: "a deep clean Wednesday at three", totalCents: 18000, details });
  assert.equal(r.allowed, true);
  assert.match(r.say, /Read the details back/);
  assert.match(r.say, new RegExp(`confirm_commitment with id ${r.commitment.id}`));

  // Proposed is not confirmed. A call that ends here is reported as not confirmed.
  assert.equal(db.getCommitment(C, r.commitment.id).state, "proposed");
  const notYet = outcome.confirmationFrom({ readBack: true, theyYes: false });
  assert.equal(notYet.confirmed, false);
  assert.equal(notYet.kind, "dropped_before_confirmation");

  const done = commit.confirm({ call, commitmentId: r.commitment.id, theySaidYes: true, reference: "XK-2291", details });
  assert.equal(done.ok, true);
  assert.equal(done.strength, "documented");
  assert.equal(db.getCommitment(C, r.commitment.id).state, "committed");
  assert.equal(db.getCall(C, call.id).confirmation_ref, "XK-2291");
});

test("a fee outside what was approved pauses, texts him the difference, and agrees to nothing", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: ["date"] });
  const sent = [];
  const r = commit.propose({
    call, brief: b, what: "the clean", totalCents: 18000,
    terms: ["a fifty dollar deposit", "no refund inside 24 hours"],
    details: readback.moment({ at: Date.parse("2026-10-14T15:00:00-04:00") }),
    tell: (t) => { sent.push(t); return true; },
  });

  assert.equal(r.allowed, false);
  assert.equal(r.reason, "needs_owner");
  assert.equal(r.outside.length, 2, "both terms are outside, because neither was approved");
  assert.equal(db.getCommitment(C, r.commitment.id).state, "paused_for_owner");
  assert.ok(Number(db.getCommitment(C, r.commitment.id).asked_owner_at) > 0);

  // He is asked, mid-call, with the question first because he is being interrupted.
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^On the phone now/);
  assert.match(sent[0], /fifty dollar deposit/);
  assert.match(sent[0], /Yes or no/);

  // And the call neither agrees nor refuses.
  assert.match(r.say, /Do NOT agree/);
  assert.match(r.say, /keep them talking/);

  const kind = outcome.outcomeFor({ state: "completed", pausedForOwner: true, spoke: true });
  assert.equal(kind, "needs_owner");
  assert.equal(outcome.isSuccess(kind), false);
});

test("a price over the ceiling is outside even when every term was approved", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 15000, terms: ["a fifty dollar deposit"] }, readBack: ["date"] });
  const out = commit.outsideApproval(b, { totalCents: 18000, terms: ["a fifty dollar deposit"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "price");
  assert.match(out[0].what, /over the a hundred and fifty dollars you approved/);
});

test("a term the owner did approve is not flagged", () => {
  const b = brief.buildBrief({ goal: "x", approved: { book: true, terms: ["a fifty dollar deposit"] } });
  assert.equal(commit.outsideApproval(b, { terms: ["a fifty dollar deposit"] }).length, 0);
  // Punctuation and case do not matter.
  assert.equal(commit.outsideApproval(b, { terms: ["A $50 deposit — a fifty dollar deposit."] }).length, 0);
});

test("a term that only nearly matches pauses anyway, and that is the intended direction", () => {
  // "a deposit of up to fifty dollars" approved, "a fifty dollar deposit" offered. A person would call
  // that the same thing. This does not, because the only ways to decide it are a model reading meaning
  // — which is not what a safety floor should rest on — or string heuristics, which get it wrong
  // silently. So it asks him. The cost of being wrong this way is a text he answers in four seconds;
  // the cost of being wrong the other way is a charge he never agreed to.
  const b = brief.buildBrief({ goal: "x", approved: { book: true, terms: ["a deposit of up to fifty dollars"] } });
  const out = commit.outsideApproval(b, { terms: ["a fifty dollar deposit"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "term");
});

test("asking for card details is refused outright, not paused for approval", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 50000 }, readBack: ["date"] });
  const sent = [];
  const r = commit.propose({
    call, brief: b, what: "the booking", totalCents: 1000,
    terms: ["they need the card number to hold it"],
    tell: (t) => { sent.push(t); return true; },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "payment_details");
  // An instruction the model says in its own words (calmWhy), not a fixed opening phrase to read out.
  assert.match(r.say, /own words/i, "said in the model's own words");
  assert.match(r.say, /card or account details/i, "names what is not shared");
  assert.match(r.say, /money safe/i, "and why");
  assert.match(r.say, /payment link|another way/i, "then what it can do instead");
  assert.doesNotMatch(r.say, /Tell them you cannot take or give payment details/, "no fixed opening phrase before the instruction");
  assert.equal(sent.length, 0, "this is not a thing to ask him about; it is refused");
});

test("a detail nobody heard blocks the agreement before the approval maths runs", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 100 }, readBack: ["price"] });
  const r = commit.propose({
    call, brief: b, what: "the booking", totalCents: 999999,
    details: [readback.detail({ kind: "price", value: "[inaudible]", label: "price" })],
  });
  assert.equal(r.reason, "unclear", "unclear is checked first: agreeing to a misheard price is worse than to a high one");
  assert.match(r.say, /spell it out/);
});

test("a booking brief with nothing to read back is refused when it is built", () => {
  const bad = brief.buildBrief({ goal: "book it", approved: { book: true }, readBack: [] });
  const check = brief.requireBrief({ brief: bad });
  assert.equal(check.ok, false);
  assert.match(check.error, /has to name what gets read back/);
  assert.equal(brief.requireBrief({ brief: brief.buildBrief({ goal: "ask" }) }).ok, true);
});

test("an owner who never answers ends the call having agreed to nothing", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 100 }, readBack: ["date"] });
  const r = commit.propose({
    call, brief: b, what: "x", totalCents: 50000,
    details: readback.moment({ at: Date.parse("2026-10-14T15:00:00-04:00") }),
    tell: () => true,
  });
  const m = db.getCommitment(C, r.commitment.id);
  assert.equal(commit.ownerOutOfTime(m), false);
  clock.skip(91_000);
  assert.equal(commit.ownerOutOfTime(m), true);
  // And his answer, when it comes, is applied by the ordinary gate rather than judged here.
  assert.equal(commit.ownerAnswered({ conversationId: C, commitmentId: m.id, yes: true }).state, "proposed");
});

test("a commitment still waiting on him cannot be confirmed by the call", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 100 }, readBack: ["date"] });
  const r = commit.propose({
    call, brief: b, what: "x", totalCents: 50000,
    details: readback.moment({ at: Date.parse("2026-10-14T15:00:00-04:00") }), tell: () => true,
  });
  const bad = commit.confirm({ call, commitmentId: r.commitment.id, theySaidYes: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /still waiting on Omari/);
  assert.match(bad.error, /Do not tell them it is confirmed/);
});

// The 2026-10-07 rehearsal: a cleaner named a fifty dollar deposit in the same breath as the price,
// before any date was settled. The completeness check fired first, so the answer was "ask them for the
// date", the deposit was never escalated, and four proposals later Omari had not been told about it
// once — while the call said "I'm checking the deposit with Omari right now" out loud.
test("a term he never approved reaches him even though no date has been settled yet", () => {
  const call = makeCall();
  const b = brief.buildBrief({
    goal: "book a deep clean", approved: { book: true, maxCents: 20000 }, readBack: ["date", "time"],
  });
  const sent = [];
  const r = commit.propose({
    call, brief: b, what: "a deep clean of a two-bed flat", totalCents: 18000,
    terms: ["a fifty dollar deposit to hold the slot"],
    details: [], // nothing established: they had not given a date yet
    tell: (t) => { sent.push(t); return true; },
  });

  assert.equal(r.reason, "needs_owner", "not 'incomplete' — the deposit is the thing that cannot wait");
  assert.equal(db.getCommitment(C, r.commitment.id).state, "paused_for_owner");
  assert.equal(sent.length, 1, "and he is actually texted, which is the whole point");
  assert.match(sent[0], /fifty dollar deposit/);

  // Both things, in the right order: agree to nothing, and use his answering time to get the rest.
  assert.match(r.say, /Do NOT agree/);
  assert.match(r.say, /While you wait, get the date and the time/);
  // And it may honestly say it is checking, because the text has already gone.
  assert.match(r.say, /that has actually happened/);
});

test("a deposit they named out loud cannot be left out of the proposal", () => {
  // The second half of the same rehearsal failure, and the dangerous half. The model proposed the
  // booking without the deposit in `terms`, so there was nothing outside what he approved, so the
  // proposal was ALLOWED — a confirmed booking with a fifty dollar condition on it he never saw.
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: [] });
  const sent = [];
  const r = commit.propose({
    call, brief: b, what: "the clean on Saturday at nine", totalCents: 18000, terms: [],
    theirWords: "that's a hundred and eighty all in. We do need a fifty dollar deposit to hold the slot though.",
    details: readback.moment({ at: Date.parse("2026-10-10T09:00:00-04:00") }),
    tell: (t) => { sent.push(t); return true; },
  });

  assert.equal(r.allowed, false);
  assert.equal(r.reason, "terms_missing");
  assert.match(r.say, /they have just mentioned a deposit/i);
  assert.match(r.say, /EVERY condition they named/);
  // It is told not to claim it is checking, because at this point nothing is.
  assert.match(r.say, /do not say you are checking/i);
  assert.equal(sent.length, 0, "he is not texted about a condition nobody has described yet");

  // Proposed again with the deposit in it, the ordinary path runs and he is asked.
  const again = commit.propose({
    call, brief: b, what: "the clean on Saturday at nine", totalCents: 18000,
    terms: ["a fifty dollar deposit to hold the slot"],
    theirWords: "we do need a fifty dollar deposit to hold the slot though.",
    details: readback.moment({ at: Date.parse("2026-10-10T09:00:00-04:00") }),
    tell: (t) => { sent.push(t); return true; },
  });
  assert.equal(again.reason, "needs_owner");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /fifty dollar deposit/);
});

test("nothing they said about conditions means the proposal stands on its own", () => {
  // The floor above must not fire on an ordinary quote, or every clean booking needs a second round.
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: [] });
  const r = commit.propose({
    call, brief: b, what: "the clean", totalCents: 18000, terms: [],
    theirWords: "that's a hundred and eighty, all in, and Saturday at nine is free.",
    details: readback.moment({ at: Date.parse("2026-10-10T09:00:00-04:00") }),
  });
  assert.equal(r.allowed, true);
});

test("he is asked once per call, not once per proposal", () => {
  // Three near-identical "need your word" texts inside two minutes, in the rehearsal, because each
  // re-proposal of the same booking paused and texted again. His phone being duplicated is the same
  // failure as the booking being duplicated.
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: [] });
  const sent = [];
  const args = {
    call, brief: b, what: "the clean", totalCents: 18000, terms: ["a fifty dollar deposit"],
    details: readback.moment({ at: Date.parse("2026-10-10T09:00:00-04:00") }),
    tell: (t) => { sent.push(t); return true; },
  };

  const first = commit.propose({ ...args });
  assert.equal(first.reason, "needs_owner");
  assert.equal(sent.length, 1);

  const second = commit.propose({ ...args, what: "the clean, said slightly differently" });
  assert.equal(second.reason, "already_asked");
  assert.equal(sent.length, 1, "and no second text");
  assert.equal(second.commitment.id, first.commitment.id, "it is the same open question");
  assert.match(second.say, /has already been asked/);
  assert.match(second.say, /Do NOT agree/);

  // Once he answers, a fresh difference can reach him again.
  commit.ownerAnswered({ conversationId: C, commitmentId: first.commitment.id, yes: false, said: "no" });
  const third = commit.propose({ ...args, terms: ["a hundred dollar deposit now"] });
  assert.equal(third.reason, "needs_owner");
  assert.equal(sent.length, 2);
});

test("its own refusal to give card details is not read as asking for them", () => {
  // A proposal was DECLINED for wanting payment details because the model had written "I cannot take
  // or give card details over the phone" into it: the refusal working, reported honestly, and then
  // read as the offence.
  assert.equal(commit.wantsPaymentDetails("they want the card number read out"), "card number");
  assert.equal(commit.wantsPaymentDetails("I cannot take or give card details over the phone"), null);
  assert.equal(commit.wantsPaymentDetails("no bank details were given"), null);
  // Two sentences: the refusal does not cover a real ask in the next one.
  assert.equal(commit.wantsPaymentDetails("I can't give card details. They are asking for the cvv."), "cvv");

  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: [] });
  const r = commit.propose({
    call, brief: b, what: "the clean at nine", totalCents: 18000,
    terms: ["a fifty dollar deposit, and I cannot give card details over the phone"],
    details: readback.moment({ at: Date.parse("2026-10-10T09:00:00-04:00") }),
    tell: () => true,
  });
  assert.notEqual(r.reason, "payment_details");
  assert.equal(r.reason, "needs_owner", "the deposit is the real thing here, and he hears about it");
});

test("when he cannot be reached it is told not to say it is checking with him", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 100 }, readBack: ["date"] });
  const r = commit.propose({
    call, brief: b, what: "x", totalCents: 50000,
    details: readback.moment({ at: Date.parse("2026-10-14T15:00:00-04:00") }),
    tell: () => false,
  });
  assert.equal(r.askedOwner, false);
  assert.match(r.say, /Do not say you are checking with them, because you are not/);
});

test("a difference that rests on a number nobody heard is cleared up before he is asked about it", () => {
  const call = makeCall();
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 100 }, readBack: ["price"] });
  const sent = [];
  const r = commit.propose({
    call, brief: b, what: "x", totalCents: 50000,
    details: [{ kind: "price", label: "price", unclear: true, spoken: "", exact: null }],
    tell: (t) => { sent.push(t); return true; },
  });
  // "Five hundred dollars, which is over the one dollar you approved" is not a fact when the price
  // came off a bad line. He is not interrupted with it; they are asked to say it again.
  assert.equal(r.reason, "unclear");
  assert.equal(sent.length, 0);
  assert.match(r.say, /did not catch the price/);
});

test("his yes to a deposit is not a yes to a booking with no date on it", () => {
  const call = makeCall();
  const b = brief.buildBrief({
    goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: ["date", "time"],
  });
  const r = commit.propose({
    call, brief: b, what: "the clean", totalCents: 18000,
    terms: ["a fifty dollar deposit"], details: [], tell: () => true,
  });
  assert.equal(commit.ownerAnswered({ conversationId: C, commitmentId: r.commitment.id, yes: true }).state, "proposed");

  // Approved, and still not bookable: he said yes to the deposit, not to a date nobody has given.
  const bad = commit.confirm({ call, brief: b, commitmentId: r.commitment.id, theySaidYes: true, details: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /do not tell them it is booked/);
  assert.match(bad.error, /date or the time/);
  assert.equal(db.getCommitment(C, r.commitment.id).state, "proposed", "and nothing was recorded");

  // With the details, the same call goes through.
  const good = commit.confirm({
    call, brief: b, commitmentId: r.commitment.id, theySaidYes: true,
    details: readback.moment({ at: Date.parse("2026-10-10T09:00:00-04:00") }),
  });
  assert.equal(good.ok, true);
  assert.equal(db.getCommitment(C, r.commitment.id).state, "committed");
});

// ---------- honest outcomes ----------

test("confirmed is unreachable without a read-back and a yes", () => {
  assert.equal(outcome.confirmationFrom({ readBack: false, theirYes: true }).confirmed, false);
  assert.equal(outcome.confirmationFrom({ readBack: true, theirYes: false }).confirmed, false);
  assert.equal(outcome.confirmationFrom({ readBack: true, theirYes: true }).confirmed, true);
});

test("what a confirmation rests on is recorded, so he can see which kind he has", () => {
  const ref = outcome.confirmationFrom({ readBack: true, theirYes: true, reference: "XK-1" });
  assert.equal(ref.strength, "documented");
  const promised = outcome.confirmationFrom({ readBack: true, theirYes: true, writtenPromised: true });
  assert.equal(promised.strength, "promised_in_writing");
  const spoken = outcome.confirmationFrom({ readBack: true, theirYes: true });
  assert.equal(spoken.strength, "spoken_only");
  assert.match(outcome.ownerLine("confirmed", { strength: "spoken_only" }), /only on the call/);
  assert.match(outcome.ownerLine("confirmed", { reference: "XK-1" }), /reference XK-1/);
});

test("two outcomes count as success, and a warm call with no confirmation is neither", () => {
  // `goal_met` is never derived here: only the model's read of a transcript sets it (src/calls/goalmet.js).
  const successes = outcome.OUTCOME_KINDS.filter(outcome.isSuccess);
  assert.deepEqual(successes, ["confirmed", "goal_met"]);
  for (const s of [{}, { spoke: true }, { state: "completed" }, { state: "completed", spoke: true, asked: true }]) {
    assert.notEqual(outcome.outcomeFor(s), "goal_met");
  }
  // Reached a person, had a lovely chat, settled nothing.
  assert.equal(outcome.outcomeFor({ state: "completed", spoke: true }), "dropped_before_confirmation");
  // Reached a person and got the answers it rang for: that is `answered`, which is not success.
  assert.equal(outcome.outcomeFor({ state: "completed", spoke: true, asked: true }), "answered");
  assert.equal(outcome.isSuccess("answered"), false);
});

test("a hold that ran out is told apart from nobody picking up", () => {
  assert.equal(outcome.outcomeFor({ state: "no_answer" }), "no_answer");
  assert.equal(outcome.outcomeFor({ state: "no_answer", gaveUpOnHold: true }), "hold_gave_up");
  assert.equal(outcome.reachedAPerson("refused_by_them"), true);
  assert.equal(outcome.reachedAPerson("no_answer"), false);
});

// ---------- never twice ----------

test("a dropped-after-yes call comes back to ASK, with booking switched off", () => {
  const b = brief.buildBrief({ goal: "book a table for four at eight", approved: { book: true, maxCents: 20000 }, readBack: ["date", "time"] });
  const call = makeCall();
  db.updateCall(C, call.id, { outcome_kind: "dropped_before_confirmation", state: "completed", brief: JSON.stringify(b) });

  const r = redial.safeToRedial(C, { toNumber: call.to_number });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "ask", "not 'retry' — retrying is how somebody gets two tables");
  assert.equal(r.brief.approved.book, false);
  assert.match(r.brief.goal, /Find out whether this already went through/);
  assert.match(r.brief.goal, /do NOT make it now/);
});

test("a number with something already agreed at it is not called back to agree again", () => {
  const call = makeCall({ to_number: "+12125558888" });
  const b = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 20000 }, readBack: ["date"] });
  const r = commit.propose({
    call, brief: b, what: "a table for four at eight", totalCents: 18000,
    details: readback.moment({ at: Date.parse("2026-10-14T15:00:00-04:00") }),
  });
  commit.confirm({ call, commitmentId: r.commitment.id, theySaidYes: true, reference: "AA-1" });

  const check = redial.safeToRedial(C, { toNumber: "+12125558888" });
  assert.equal(check.ok, false);
  assert.equal(check.alreadyDone, true);
  assert.match(check.error, /already arranged/);
  assert.match(check.error, /reference AA-1/);
});

test("one voicemail per number, ever — a second is worse than none", () => {
  const call = makeCall({ to_number: "+12125557777" });
  db.updateCall(C, call.id, { outcome_kind: "voicemail_left", voicemail_left: 1, state: "voicemail" });
  const check = redial.safeToRedial(C, { toNumber: "+12125557777" });
  assert.equal(check.ok, false);
  assert.equal(check.voicemailAlready, true);
  assert.match(check.error, /Do not ring back to leave another/);
  assert.equal(outcome.redialMode("voicemail_left"), "no");
});

test("the retry limit stops a number being rung forever", () => {
  const n = "+12125556666";
  makeCall({ to_number: n, outcome_kind: "no_answer", state: "no_answer" });
  const first = redial.safeToRedial(C, { toNumber: n });
  assert.equal(first.ok, true);
  assert.equal(first.mode, "retry");
  assert.equal(first.attempt, 2);

  makeCall({ to_number: n, outcome_kind: "no_answer", state: "no_answer" });
  const second = redial.safeToRedial(C, { toNumber: n });
  assert.equal(second.ok, false);
  assert.equal(second.outOfTries, true);
  assert.match(second.error, /REASON_CALL_MAX_RETRIES/);
});

test("a number nobody has called yet is simply callable", () => {
  const r = redial.safeToRedial(C, { toNumber: "+12125550000" });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "first");
});

// ---------- one errand, many calls ----------

test("every leg of an errand gets the same questions, and an inquiry leg can never book", () => {
  const e = errand.open(C, { goal: "cheapest deep clean that can do this week" });
  assert.deepEqual(e.questions, brief.CORE_QUESTIONS);
  assert.ok(e.questions.some(q => /how long that price is good for/.test(q)), "the one most likely to get dropped");

  const leg = errand.briefForLeg(e, { place: "Clean Co", returnNumber: "+12125551111" });
  assert.deepEqual(leg.questions, e.questions);
  assert.equal(leg.approved.book, false);
  // Even asked for explicitly: the errand's kind is the ceiling.
  assert.equal(errand.briefForLeg(e, { book: true }).approved.book, false);
});

test("parallel is for asking; bookings are one at a time and that is not a setting", () => {
  const e = errand.open(C, { goal: "x", kind: "booking" });
  for (let i = 0; i < 3; i++) {
    const k = makeCall();
    db.updateCall(C, k.id, { errand_id: e.id, state: "in_progress" });
  }
  const full = errand.roomForAnother(C, e.id);
  assert.equal(full.ok, false);
  assert.match(full.error, /REASON_CALL_MAX_PARALLEL/);

  const booking = errand.roomForAnother(C, e.id, { booking: true });
  assert.equal(booking.ok, false);
  assert.match(booking.error, /one at a time/);
});

test("two calls cannot both be the one that books: the claim is atomic", () => {
  const e = errand.open(C, { goal: "x", kind: "booking" });
  const a = makeCall();
  const b2 = makeCall();
  db.updateCall(C, a.id, { errand_id: e.id });
  db.updateCall(C, b2.id, { errand_id: e.id });
  const bf = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 50000 }, readBack: ["date"] });
  const details = readback.moment({ at: Date.parse("2026-10-14T15:00:00-04:00") });

  const first = commit.propose({ call: db.getCall(C, a.id), brief: bf, errandId: e.id, what: "a", totalCents: 100, details });
  assert.equal(first.allowed, true);

  const second = commit.propose({ call: db.getCall(C, b2.id), brief: bf, errandId: e.id, what: "b", totalCents: 100, details });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "already_committing");
  assert.match(second.say, /would double it up/);
});

test("six places, the same questions, a comparable summary — and the two that never answered are in it", () => {
  const e = errand.open(C, { goal: "deep clean this week" });
  const places = [
    { place: "Clean Co", total: 18000, firmness: "firm", earliest: "Thursday", holds: "until Thursday", outcome: "answered" },
    { place: "Bright", total: 21000, firmness: "estimate", earliest: "tomorrow", holds: "", outcome: "answered" },
    { place: "Sparkle", total: 25000, firmness: "firm", earliest: "next Monday", holds: "a week", outcome: "answered" },
    { place: "Maids4U", total: null, firmness: "unknown", earliest: "", holds: "", outcome: "answered" },
    { place: "Dustbusters", total: null, firmness: "unknown", earliest: "", holds: "", outcome: "no_answer" },
    { place: "Shine", total: null, firmness: "unknown", earliest: "", holds: "", outcome: "voicemail_left" },
  ];
  for (const p of places) {
    const k = makeCall();
    db.updateCall(C, k.id, { errand_id: e.id, state: "completed", outcome_kind: p.outcome });
    if (p.outcome === "answered") {
      errand.noteAnswer(C, {
        errandId: e.id, callId: k.id, place: p.place, totalCents: p.total,
        firmness: p.firmness, earliest: p.earliest, holdsUntil: p.holds,
      });
    } else {
      // Unreached places still get a name in the summary, from the quote row or the number.
      errand.noteAnswer(C, { errandId: e.id, callId: k.id, place: p.place, firmness: "unknown" });
    }
  }

  const c = errand.compare(C, e.id);
  assert.equal(c.legs.length, 6);
  assert.equal(c.reached.length, 4);
  assert.equal(c.unreached.length, 2);
  assert.equal(c.cheapest.place, "Clean Co");
  assert.equal(c.priced.length, 3);

  const text = errand.summary(C, e.id);
  assert.match(text, /^I reached 4 of 6 places\./m);
  assert.match(text, /Clean Co: \$180.*firm.*cheapest/);
  assert.match(text, /Bright: \$210.*an estimate/);
  // Reached but no price is its own fact, not folded into the unreached.
  assert.match(text, /Maids4U: .*no price/);
  assert.match(text, /Dustbusters: could not reach them/);
  assert.match(text, /Shine: left a voicemail/);
  // Committing is his.
  assert.match(text, /Want me to book one\?$/);
  // And "best" is never claimed silently.
  assert.ok(!/\bbest deal\b/i.test(text), text);
});

test("the tradeoff is named: cheapest is not silently best", () => {
  const e = errand.open(C, { goal: "x" });
  const mk = (place, total, firmness, earliest) => {
    const k = makeCall();
    db.updateCall(C, k.id, { errand_id: e.id, state: "completed", outcome_kind: "answered" });
    errand.noteAnswer(C, { errandId: e.id, callId: k.id, place, totalCents: total, firmness, earliest });
  };
  mk("Cheap but slow", 18000, "estimate", "in three weeks");
  mk("Dearer but tomorrow", 21000, "firm", "tomorrow");

  const text = errand.summary(C, e.id);
  assert.match(text, /Cheapest isn't automatically best here/);
  assert.match(text, /only an estimate/);
  assert.match(text, /Dearer but tomorrow could do tomorrow for \$210/);
});

test("total_cents is added up from price and fees, because 'cheapest' means what they would charge", () => {
  const e = errand.open(C, { goal: "x" });
  const k = makeCall();
  const q = errand.noteAnswer(C, { errandId: e.id, callId: k.id, place: "P", priceCents: 15000, feesCents: 3000, firmness: "firm" });
  assert.equal(q.total_cents, 18000);
});

test("a place that would not quote never arrives in the comparison as costing nothing", () => {
  // The bug this pins, found while writing the six-places test: `Number(null)` is 0 and
  // `Number.isFinite(0)` is true, so a missing price became a quote of $0 — which sorted straight to
  // the top and got reported as "cheapest". The owner's "'best deal' must never silently mean the
  // lowest advertised price" failing through a type coercion, with the worst possible winner: a place
  // that never gave a number at all.
  const e = errand.open(C, { goal: "x" });
  const priced = makeCall();
  const silent = makeCall();
  for (const [k, place, total] of [[priced, "Said a price", 18000], [silent, "Wouldn't say", null]]) {
    db.updateCall(C, k.id, { errand_id: e.id, state: "completed", outcome_kind: "answered" });
    errand.noteAnswer(C, { errandId: e.id, callId: k.id, place, totalCents: total, firmness: "firm" });
  }
  const q = db.quoteForCall(C, silent.id);
  assert.equal(q.total_cents, null, "absent, not zero");

  const c = errand.compare(C, e.id);
  assert.equal(c.priced.length, 1);
  assert.equal(c.cheapest.place, "Said a price");

  const text = errand.summary(C, e.id);
  assert.ok(!/\$0/.test(text), text);
  assert.match(text, /Wouldn't say: .*no price/);
});

test("approving a booking without naming a ceiling is not a ceiling of zero", () => {
  // Same coercion, the other end of it: `Number(null)` is 0 would have made maxCents 0, so every price
  // was over the limit and every booking paused for approval — caution-shaped, but it means Reason can
  // never book anything.
  const b = brief.buildBrief({ goal: "book it", approved: { book: true }, readBack: ["date"] });
  assert.equal(b.approved.maxCents, null);
  assert.equal(commit.outsideApproval(b, { totalCents: 50000 }).length, 0);
  // A ceiling that was actually named still binds.
  const capped = brief.buildBrief({ goal: "book it", approved: { book: true, maxCents: 10000 }, readBack: ["date"] });
  assert.equal(commit.outsideApproval(capped, { totalCents: 50000 }).length, 1);
});

test("a firmness the model made up is not trusted into the column", () => {
  const e = errand.open(C, { goal: "x" });
  const k = makeCall();
  const q = errand.noteAnswer(C, { errandId: e.id, callId: k.id, place: "P", firmness: "pretty sure" });
  assert.equal(q.firmness, "unknown");
});

test("closing an errand reports what is still being held rather than quietly dropping it", () => {
  const e = errand.open(C, { goal: "x", kind: "booking" });
  const k = makeCall();
  db.updateCall(C, k.id, { errand_id: e.id });
  const bf = brief.buildBrief({ goal: "book", approved: { book: true, maxCents: 50000 }, readBack: ["date"] });
  commit.propose({
    call: db.getCall(C, k.id), brief: bf, errandId: e.id, what: "held slot", totalCents: 100,
    details: readback.moment({ at: Date.parse("2026-10-14T15:00:00-04:00") }),
  });
  const closed = errand.close(C, e.id, { decision: "went with somewhere else" });
  assert.equal(closed.stillHeld.length, 1);
  assert.equal(closed.errand.decision, "went with somewhere else");
  assert.ok(closed.errand.closed_at);
});

// ---------- quiet hours ----------

test("third-party calls are held in the quiet window; the owner's own never are", () => {
  const night = Date.parse("2026-10-07T23:30:00-04:00");
  const blocked = brief.withinCallingHours({ now: night });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /23:30/);
  assert.match(blocked.error, /Nobody's phone rang/);
  assert.match(blocked.error, /it is the hour, not a failure/);

  assert.equal(brief.withinCallingHours({ now: night, toOwner: true }).ok, true);
  assert.equal(brief.withinCallingHours({ now: Date.parse("2026-10-07T14:00:00-04:00") }).ok, true);
  // An empty window turns it off rather than blocking everything.
  assert.equal(brief.withinCallingHours({ now: night, window: "" }).ok, true);
});

test("whether they spoke is read from the transcript, and dots are not speech", async () => {
  const outcome = await import("../src/calls/outcome.js");
  assert.equal(outcome.theySpoke("Reason: hi\nThem: ...\nReason: hello?\nThem: …"), false);
  assert.equal(outcome.theySpoke("Reason: hi\nThem: ...\nThem: yes, two copies"), true);
  assert.equal(outcome.theySpoke("Reason: hola\nThem: sí"), true);
  // Nothing to go on is not a silent line: Bland's transcript can land after the call says done.
  assert.equal(outcome.theySpoke(""), null);
  assert.equal(outcome.theySpoke("Them: ..."), null);
  assert.equal(outcome.outcomeFor({ state: "completed", spoke: true, silent: true }), "line_silent");
  assert.equal(outcome.outcomeFor({ state: "completed", spoke: true, silent: true, voicemail: true }), "voicemail_left");
  assert.equal(outcome.reachedAPerson("line_silent"), false);
  assert.equal(outcome.redialMode("line_silent"), "retry");
  assert.equal(outcome.ownerLine("line_silent", { place: "the Strand" }), "the Strand: the line was silent — nobody spoke.");
  // The owner's own call is framed right by the provider and left alone.
  assert.equal(outcome.callSummary({ row: { is_owner: 1 }, providerSummary: "Omari called Reason." }), "Omari called Reason.");
});
