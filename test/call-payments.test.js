// Reason never gives payment details by phone.
//
// This is a hard rule, not a preference, so it is enforced in two places that do not depend on
// each other: the call request is scanned before anything is dialled, and the call itself carries
// a standing instruction to decline if the other side asks for payment. Either one alone would be
// one refactor away from being lost.
//
// Why a phone call specifically: every call Reason places is recorded, the provider may transcribe
// it, and the person on the other end is unverified. "We just need a card to hold the table" is
// the exact moment this has to not happen, and it is the moment it would sound reasonable.
//
// No API key, nothing rings.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call-pay-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
// Calling hours off in here, so these tests do not depend on what time it is when the suite runs
// (REASON_CALL_QUIET_HOURS defaults to 21:00-08:00, and a suite run at midnight would see every
// call refused for the hour rather than for the reason being tested). The window itself is proven
// in test/call-handling.test.js, against a fixed clock.
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const { runTool, WONT_DO } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const { announcementFor, callRulesFor, requireCallRules } = await import("../src/calls/provider.js");
const { findPaymentDetails, checkCallForPaymentDetails } = await import("../src/calls/payments.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads;");
});

// A card number that passes Luhn, so the detector is tested on the real shape.
const CARD = "4242 4242 4242 4242";

// ---------- the request cannot carry payment details ----------

test("a call carrying a card number in the facts is refused before it dials", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", {
    to: OWNER, goal: "hold the table for 4 at 8",
    facts: ["Omari, party of 4", `card ${CARD}`],
  }, { conversationId: C, calls });

  assert.equal(out.ok, false);
  assert.equal(out.status, "payment_details_refused");
  assert.deepEqual(out.found, ["what looks like a card number"]);
  assert.match(out.error, /never gives payment details by phone/i);
  // And it says what to do instead, so this is a redirect rather than a dead end.
  assert.match(out.error, /pay link|payment link|another way/i);

  assert.equal(calls.placed.length, 0, "nothing was dialled");
  assert.equal(db.listCalls(C).length, 0, "and no call row exists");
});

test("the goal is scanned too, not just the facts", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", {
    to: OWNER, goal: "book it and give them the cvv 123 when they ask",
    facts: ["Omari"],
  }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.equal(out.status, "payment_details_refused");
  assert.equal(calls.placed.length, 0);
});

test("the refusal never echoes the card number back", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: OWNER, goal: "pay with card", facts: [`card number ${CARD}`] },
    { conversationId: C, calls });
  const everything = JSON.stringify(out);
  assert.doesNotMatch(everything, /4242/, "a guard that repeats the number has leaked it anyway");
  assert.match(everything, /card number/i, "but it still says what kind of thing it found");
});

test("the detector knows the credential shapes, including a bare Luhn-valid number", () => {
  assert.deepEqual(findPaymentDetails(`${CARD}`), ["what looks like a card number"]);
  assert.deepEqual(findPaymentDetails("4242-4242-4242-4242"), ["what looks like a card number"]);
  assert.ok(findPaymentDetails("my card number is on file").includes("a card number"));
  assert.ok(findPaymentDetails("cvv 455").includes("a card security code"));
  assert.ok(findPaymentDetails("the security code is 455").includes("a card security code"));
  assert.ok(findPaymentDetails("expiry 08/29").includes("a card expiry date"));
  assert.ok(findPaymentDetails("routing number 021000021").includes("a bank routing number"));
  assert.ok(findPaymentDetails("sort code 12-34-56").includes("a bank sort code"));
  assert.ok(findPaymentDetails("IBAN GB33BUKB20201555555555").includes("an IBAN"));
  assert.ok(findPaymentDetails("my pin is 4123").includes("a PIN"));
});

test("the ordinary things you say to a restaurant are not blocked", () => {
  // A guard that fires on "do they take card" is a guard nobody can use.
  for (const ok of [
    "party of 4 at 8pm",
    "do they take card or is it cash only",
    "Omari, and we'll pay at the door",
    "my number is +1 202 555 1234",
    "confirmation 7781",
    "ask if they can do 8:30 instead",
    "booking reference ABC-99210",
    "we'd like the tasting menu, it's $95 a head",
  ]) {
    assert.deepEqual(findPaymentDetails(ok), [], `should not fire on: ${ok}`);
  }
  assert.equal(checkCallForPaymentDetails({ goal: "table for 4 at 8", facts: ["Omari", "party of 4"] }).ok, true);
});

test("a long digit run that is not a card is left alone", () => {
  // 16 digits, fails Luhn: a confirmation code, not a card.
  assert.deepEqual(findPaymentDetails("confirmation 1234567890123456"), []);
});

test("an empty or missing call is fine, not an error", () => {
  assert.deepEqual(findPaymentDetails(""), []);
  assert.deepEqual(findPaymentDetails(undefined), []);
  assert.equal(checkCallForPaymentDetails().ok, true);
  assert.equal(checkCallForPaymentDetails({ goal: "x" }).ok, true);
});

// ---------- every field the call is handed, not just goal and facts (audit lead 31) ----------
//
// The brief carries more than goal and facts: requirements ("everything they are going to ask
// for"), the questions in `ask`, and approved_terms all reach the voice prompt. A card number
// in any of them is the same card number on a recording.

test("a card number in the requirements is refused before it dials", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", {
    to: OWNER, goal: "book a table for 2 at 8pm",
    requirements: { name: "Omari", "card to hold it": `${CARD} exp 12/28 cvv 123` },
  }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.equal(out.status, "payment_details_refused");
  assert.doesNotMatch(JSON.stringify(out), /4242|cvv 123/i, "and the refusal does not echo it");
  assert.equal(calls.placed.length, 0, "nothing was dialled");
  assert.equal(db.listCalls(C).length, 0, "and no call row exists");
});

test("a requirements KEY is scanned as well as its value", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", {
    to: OWNER, goal: "book a table for 2 at 8pm",
    requirements: { [`card ${CARD}`]: "yes" },
  }, { conversationId: C, calls });
  assert.equal(out.status, "payment_details_refused");
  assert.equal(calls.placed.length, 0);
});

test("the questions in ask are scanned", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", {
    to: OWNER, goal: "book a table for 2 at 8pm", ask: ["is cvv 123 ok to hold it?"],
  }, { conversationId: C, calls });
  assert.equal(out.status, "payment_details_refused");
  assert.equal(calls.placed.length, 0);
});

test("approved_terms are scanned", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", {
    to: OWNER, goal: "book a table for 2 at 8pm",
    approved_terms: [`a deposit on card number ${CARD}`],
  }, { conversationId: C, calls });
  assert.equal(out.status, "payment_details_refused");
  assert.equal(calls.placed.length, 0);
});

test("ordinary requirements, questions and terms still go through", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", {
    to: OWNER, goal: "book a table for 2 at 8pm",
    requirements: { name: "Omari", people: "2", phone: "+12025551234" },
    ask: ["do they take card or is it cash only?"],
    approved_terms: ["we'll pay at the door"],
  }, { conversationId: C, calls });
  assert.equal(out.ok, true, out.error);
  assert.equal(calls.placed.length, 1);
});

test("a whole brief is screened, including one carried forward into a redial", async () => {
  const { buildBrief, askWhetherItWentThrough } = await import("../src/calls/brief.js");
  const { checkBriefForPaymentDetails } = await import("../src/calls/payments.js");
  const old = buildBrief({ goal: "book a table for 2 at 8pm", requirements: { "card to hold it": `${CARD}` } });
  const redial = askWhetherItWentThrough(old);
  assert.equal(redial.requirements["card to hold it"], CARD, "the redial carries the old requirements");
  assert.equal(checkBriefForPaymentDetails(redial).ok, false, "so the final brief is screened, not only the input");
  assert.equal(checkBriefForPaymentDetails(buildBrief({ goal: "x", questions: ["security code 123?"] })).ok, false);
  assert.equal(checkBriefForPaymentDetails(buildBrief({ goal: "x", approved: { book: true, terms: [`${CARD}`] } })).ok, false);
  assert.equal(checkBriefForPaymentDetails(buildBrief({ goal: "table for 2", requirements: { name: "Omari" } })).ok, true);
});

// ---------- the call carries the rule with it ----------

test("every placed call carries the no-payment rule and what to do instead", async () => {
  const calls = new FakeCallProvider();
  const out = await runTool("call_place", { to: OWNER, goal: "ask about a table", facts: ["Omari"] },
    { conversationId: C, calls });
  assert.equal(out.ok, true);

  const rules = calls.placed[0].rules;
  assert.ok(Array.isArray(rules) && rules.length, "the provider is handed the rules");
  const all = rules.join(" ");
  assert.match(all, /never give out payment details/i);
  assert.match(all, /card number/i);
  assert.match(all, /payment link|take payment another way/i);
  assert.match(all, /Tell Omari afterwards that payment was asked for/i);

  // Reported back to the model so it knows the call will decline on its behalf.
  assert.deepEqual(out.rules, rules);
  assert.match(out.note, /never to give out payment details/i);
});

test("a provider handed no rules, or rules without the payment one, refuses to dial", async () => {
  const calls = new FakeCallProvider();
  const announcement = announcementFor({ ownerName: "Omari" });

  const none = await calls.place({ to: OWNER, goal: "x", facts: [], maxSeconds: 60, announcement });
  assert.equal(none.ok, false);
  assert.match(none.error, /must carry its standing rules/i);

  const wrong = await calls.place({ to: OWNER, goal: "x", facts: [], maxSeconds: 60, announcement, rules: ["be polite"] });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /never pays by phone/i);

  assert.equal(calls.placed.length, 0, "neither was dialled");
});

test("requireCallRules accepts the real rules and nothing less", () => {
  assert.equal(requireCallRules({ rules: callRulesFor({ ownerName: "Omari" }) }).ok, true);
  assert.equal(requireCallRules({ rules: [] }).ok, false);
  assert.equal(requireCallRules({ rules: ["", "  "] }).ok, false);
  assert.equal(requireCallRules({}).ok, false);
  assert.equal(requireCallRules({ rules: "not an array" }).ok, false);
});

// ---------- what Reason says it will not do ----------

test("capabilities answers what Reason will not do, separately from what is not connected", async () => {
  const out = await runTool("capabilities", {}, { conversationId: C, calls: new FakeCallProvider() });

  const pay = out.wont_do.find(w => w.name === "pay_by_phone");
  assert.ok(pay, "paying by phone is on the won't-do list");
  assert.match(pay.what, /card number/i);
  assert.match(pay.what, /payment link|another way/i);

  const code = out.wont_do.find(w => w.name === "coding_workspace");
  assert.ok(code, "code is out of scope and says so");
  assert.match(code.what, /no repositories|no pull requests/i);
  assert.match(code.what, /not coming later/i);

  // The distinction is the point: a thing waiting on a key must not look like a thing Reason
  // refuses, or the model starts apologising for one and offering workarounds for the other.
  assert.match(out.note, /wont_do/);
  assert.equal(out.capabilities.some(c => c.name === "pay_by_phone"), false);
  assert.equal(out.capabilities.some(c => c.name === "coding_workspace"), false);
});

test("the won't-do list is not something a connected key can turn on", () => {
  // If anybody ever gives these a `status`, they have misunderstood the list.
  for (const w of WONT_DO) {
    assert.equal("status" in w, false, `${w.name} must not have a status`);
  }
});
