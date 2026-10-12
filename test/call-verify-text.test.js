// The cross-channel handoff: a call texts "reply yes here and I'll [do the thing]", and the
// person's "Yes" arrives as an inbound text. Without this, the text handler runs a model turn
// that has never heard of the call, sees "Yes" in the context of the last text (a news page),
// and says "yes to what?" — which is how the 2026-10-12 bug happened.
//
// The fix: Router.drain checks for a pending call verification before running a model turn.
// When the single text is a clear yes or no, it handles it directly — marks the call verified
// (or not), writes the reply into the thread, and sends a brief ack. The model never runs.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-verify-text-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_BURST_MAX_MS = "0";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const CONV = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM calls; DELETE FROM pending_inbound; DELETE FROM accounts;
    DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM outbox;`);
  db.saveConversation(CONV, [
    { role: "user", content: "what's happening in Nigeria?" },
    { role: "assistant", content: "Here is the latest from Nigeria..." },
  ]);
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

function harness() {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind, at: clock.now() });
      return "ok";
    },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ to, text, chatId, conversationId: c, channel }) => {
    await fake.send({ to, text, chatId });
  });
  return { runtime, router, fake, turns, logs };
}

const ownerCall = (over = {}) => db.createCall(CONV, {
  provider: "elevenlabs", toNumber: OWNER, isOwner: true,
  goal: "Omari called Reason", facts: [], direction: "in",
  externalId: "conv_in", state: "in_progress", ...over,
});

let n = 0;
const inbound = (text, over = {}) => ({
  channel: "fake", externalId: `e-${++n}`, from: OWNER, text,
  chatId: null, service: "iMessage", at: clock.now(), ...over,
});

// ---------- the 2026-10-12 bug ----------

test("a texted 'yes' during a call with a pending verification does not run a model turn", async () => {
  const { router, fake, turns, logs } = harness();
  const call = ownerCall();
  db.updateCall(CONV, call.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 1 });

  const result = await router.deliver(inbound("Yes"));

  // The model turn never ran.
  assert.equal(turns.length, 0, "no model turn should run for a verification reply");
  // The call is now verified.
  const updated = db.getCall(CONV, call.id);
  assert.ok(updated.verified_at, "the call should be marked verified");
  assert.equal(updated.verified_how, "text");
  // An ack was texted back.
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].text, /carrying on/i);
  // The thread has the user's message and the ack, but no confused "yes to what?".
  const messages = db.loadConversation(CONV);
  const last = messages[messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.match(last.content, /carrying on/i);
  assert.ok(result.callVerification === "yes");
});

test("a texted 'no' during a call with a pending verification sends an ack without a model turn", async () => {
  const { router, fake, turns } = harness();
  const call = ownerCall();
  db.updateCall(CONV, call.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 1 });

  const result = await router.deliver(inbound("no"));

  assert.equal(turns.length, 0, "no model turn for a verification refusal");
  // The call is NOT verified.
  const updated = db.getCall(CONV, call.id);
  assert.equal(updated.verified_at, null);
  // The ack went out.
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].text, /won't do that/i);
  assert.ok(result.callVerification === "no");
});

test("an unclear reply during a pending verification still runs a normal model turn", async () => {
  const { router, fake, turns } = harness();
  const call = ownerCall();
  db.updateCall(CONV, call.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 1 });

  await router.deliver(inbound("what are you talking about?"));

  // The model turn DID run — this was not a clear yes/no.
  assert.equal(turns.length, 1, "an unclear reply should run a normal model turn");
  assert.equal(db.getCall(CONV, call.id).verified_at, null);
});

test("a text with no pending call verification runs a normal model turn", async () => {
  const { router, turns } = harness();
  // No active call at all.
  await router.deliver(inbound("Yes"));

  assert.equal(turns.length, 1, "without a pending verification, the turn runs normally");
});

test("a text after the call has ended runs a normal model turn even if verify was pending", async () => {
  const { router, turns } = harness();
  const call = ownerCall();
  db.updateCall(CONV, call.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 1 });
  // End the call.
  db.updateCall(CONV, call.id, { state: "completed" });

  await router.deliver(inbound("Yes"));

  // The call has ended_at set, so no pending verification is found.
  assert.equal(turns.length, 1, "after the call ends, a 'yes' is a normal message");
});

test("a burst of several texts during a pending verification runs a normal turn", async () => {
  const { router, turns } = harness();
  const call = ownerCall();
  db.updateCall(CONV, call.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 1 });

  // Two texts arriving as a burst — not a single yes/no.
  db.holdInbound({
    conversationId: CONV, channel: "fake", address: OWNER, chatId: null,
    externalId: "e-burst-1", text: "yes", quietMs: 0, maxMs: 0,
  });
  db.holdInbound({
    conversationId: CONV, channel: "fake", address: OWNER, chatId: null,
    externalId: "e-burst-2", text: "and also check the weather", quietMs: 0, maxMs: 0,
  });

  // Drain directly since we pre-loaded the pending_inbound.
  await router.drain(CONV);

  assert.equal(turns.length, 1, "a burst is never a verification answer — run the turn");
});

test("'yeah' and 'nope' are recognised as yes/no by the verification check", async () => {
  // "yeah" → yes
  {
    const { router, fake, turns } = harness();
    const call = ownerCall();
    db.updateCall(CONV, call.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 1 });
    await router.deliver(inbound("yeah"));
    assert.equal(turns.length, 0);
    assert.ok(db.getCall(CONV, call.id).verified_at);
  }

  // "nope" → no
  {
    beforeEach();  // clean state
    const { router, fake, turns } = harness();
    const call = ownerCall();
    db.updateCall(CONV, call.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 1 });
    await router.deliver(inbound("nope"));
    assert.equal(turns.length, 0);
    assert.equal(db.getCall(CONV, call.id).verified_at, null);
    assert.match(fake.sent[0].text, /won't/i);
  }
});
