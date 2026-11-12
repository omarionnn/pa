// REASON_DELIVERY_GATED: "sent" means the carrier confirmed it, not that it took the request.
//
// The gap this closes: Sendblue answers 200 QUEUED to /api/send-message and the outbox marked the
// row `sent` on that; what Sendblue said afterwards on the same webhook (SENT, DELIVERED, or ERROR
// with the reason) was dropped as an "outbound echo". A text that was never delivered was on
// record as sent, the tool told the model "you may say you sent it", and nobody was ever told.
//
//   does the carrier's ERROR turn a sent row into a failed one?        (yes — and the person is told once)
//   does a pending send ever get called "sent"?                         (no — the tool says "on its way")
//   does a DELIVERED get stamped?                                       (yes — delivery_status, delivered_at)
//   is a third party's failure told to the owner, as before?            (yes — the same ownerFailureLine)
//   does the switch being off change nothing?                           (yes — ignored, old wording)
//
// No model and no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-delivery-gated-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_DELIVERY_GATED = "on";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { makeDeliver } = await import("../src/deliver.js");
const { runTool } = await import("../src/tools.js");
const outbox = await import("../src/outbox.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const LINE = "+15122164639";
const CONV = "dm:owner";
const SECRET = "a-shared-webhook-secret";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_DELIVERY_GATED = "on";
  db.db.exec("DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM action_ledger; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM incidents;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: "H-1" });
});

/** The server's wiring: a carrier that reports delivery later, the outbox, and the sweep's deliver. */
function harness({ channel = {} } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async () => null, channels: router, deliver });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: LINE, reportsDelivery: true, ...channel }));
  return { runtime, router, fake, logs };
}

const sendTool = (input, router) => runTool("message_send", input, { conversationId: CONV, channels: router });

// ---------- a pending send is never "sent" ----------

test("accepted by the carrier is 'on its way', not 'sent' — the tool says which words to use", async () => {
  const { router, fake } = harness();
  const out = await sendTool({ to: "owner", text: "table's at 8" }, router);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.delivery, "pending");
  assert.match(out.note, /NOT confirmed delivery/);
  assert.match(out.note, /on its way/);
  assert.doesNotMatch(out.note, /You may say you sent it/);
  assert.equal(fake.sent.length, 1, "it did leave");
  const row = db.getOutbound(out.delivered ? db.outboundByMessageId("fake", fake.sent[0].message_id).id : 0);
  assert.equal(row.state, "sent", "the outbox's 'sent' still means the carrier took it");
  assert.equal(row.delivery_status, null, "and nothing has been claimed about delivery");
});

test("a carrier that never reports delivery keeps the old wording: accepted is all there is", async () => {
  const { router } = harness({ channel: { reportsDelivery: false } });
  const out = await sendTool({ to: "owner", text: "table's at 8" }, router);
  assert.equal(out.ok, true);
  assert.equal(out.delivery, undefined);
  assert.match(out.note, /You may say you sent it/);
});

// ---------- the carrier's later word ----------

test("DELIVERED is stamped on the row; SENT is kept without the stamp", async () => {
  const { router, fake } = harness();
  await sendTool({ to: "owner", text: "one" }, router);
  const id = fake.sent[0].message_id;
  let r = outbox.noteDelivery({ channel: "fake", messageId: id, status: "SENT" });
  assert.equal(r.status, "SENT");
  let row = db.outboundByMessageId("fake", id);
  assert.equal(row.delivery_status, "SENT");
  assert.equal(row.delivered_at, null);
  r = outbox.noteDelivery({ channel: "fake", messageId: id, status: "DELIVERED" });
  assert.equal(r.delivered, true);
  row = db.outboundByMessageId("fake", id);
  assert.equal(row.delivery_status, "DELIVERED");
  assert.ok(row.delivered_at > 0);
  assert.equal(row.state, "sent");
});

test("ERROR after acceptance: the row is failed, the person gets one correction line, and only once", async () => {
  const { runtime, router, fake } = harness();
  await sendTool({ to: "owner", text: "your table's at 8 at carbone" }, router);
  const id = fake.sent[0].message_id;
  const r = outbox.noteDelivery({ channel: "fake", messageId: id, status: "ERROR", error: "iMessage not delivered; number not reachable" });
  assert.equal(r.failed, true);
  const row = db.outboundByMessageId("fake", id);
  assert.equal(row.state, "failed");
  assert.equal(row.last_error_key, "DELIVERY_ERROR");
  assert.match(row.last_error, /not reachable/);
  // What the next turn is told, through the machinery that already existed.
  assert.match(outbox.undeliveredNotice(db.undeliveredFor(CONV)), /never arrived/);

  // And, without waiting for a next turn, one line now.
  await runtime.outbox({ router });
  const lines = fake.sent.slice(1).map(s => s.text);
  assert.equal(lines.length, 1, "one correction");
  assert.match(lines[0], /^quick correction: my last text didn't get through/);
  assert.match(lines[0], /carbone/, "with what it said, so they still have it");
  assert.match(lines[0], /not reachable/);
  await runtime.outbox({ router });
  assert.equal(fake.sent.length, 2, "said once");
  // A second ERROR about the same row changes nothing.
  assert.equal(outbox.noteDelivery({ channel: "fake", messageId: id, status: "ERROR", error: "again" }).ignored, "already failed");
});

test("a correction line that itself fails is never corrected again", async () => {
  const { runtime, router, fake } = harness();
  await sendTool({ to: "owner", text: "first" }, router);
  outbox.noteDelivery({ channel: "fake", messageId: fake.sent[0].message_id, status: "ERROR", error: "dead" });
  await runtime.outbox({ router });
  assert.equal(fake.sent.length, 2);
  // The carrier refuses the correction too.
  outbox.noteDelivery({ channel: "fake", messageId: fake.sent[1].message_id, status: "ERROR", error: "dead again" });
  await runtime.outbox({ router });
  assert.equal(fake.sent.length, 2, "no correction about the correction");
  assert.equal(db.ownUndeliveredUntold().length, 0, "and nothing is left owed");
});

test("a text to somebody else reported undelivered reaches the owner through the line that already existed", async () => {
  const { runtime, router, fake } = harness();
  const r = await router.send({ channel: "fake", to: FRIEND, text: "omari's running 10 late", conversationId: CONV, toOwner: false });
  assert.equal(r.ok, true);
  const id = fake.sent[0].message_id;
  outbox.noteDelivery({ channel: "fake", messageId: id, status: "ERROR", error: "the number is not reachable" });
  await runtime.outbox({ router });
  const toOwner = fake.sent.filter(s => s.to === OWNER).map(s => s.text);
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0], new RegExp(`that text to \\${FRIEND} never actually went out`));
  assert.match(toOwner[0], /not reachable/);
});

test("an unknown handle, and a callback with no handle, are ignored without complaint", () => {
  assert.deepEqual(outbox.noteDelivery({ channel: "fake", messageId: "nope", status: "ERROR" }), { ignored: "no such message" });
  assert.deepEqual(outbox.noteDelivery({ channel: "fake", messageId: "", status: "ERROR" }), { ignored: "no such message" });
});

// ---------- Sendblue's callback, as it arrives ----------

function configure() {
  config.sendblueKeyId = "test-key-id"; config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE; config.sendblueWebhookSecret = SECRET; config.sendblueWebhookSecretHeader = "sb-signing-secret";
}
function unconfigure() { config.sendblueKeyId = ""; config.sendblueSecretKey = ""; config.sendblueFrom = ""; config.sendblueWebhookSecret = ""; }

test("Sendblue's outbound status callback is read as a delivery report, and still gets its 200 with no turn", async () => {
  configure();
  try {
    const ch = new SendblueChannel();
    const headers = { "sb-signing-secret": SECRET, "content-type": "application/json" };
    const body = (status, extra = {}) => JSON.stringify({
      accountEmail: "x", content: "your table's at 8", is_outbound: true, status, message_handle: "out-77",
      error_code: null, error_message: null, error_reason: null, from_number: LINE, number: OWNER, to_number: OWNER,
      date_sent: "2026-11-11T20:00:00.000Z", date_updated: "2026-11-11T20:00:01.000Z", message_type: "message", group_id: "", service: "iMessage", ...extra,
    });
    const ok = await ch.receive({ rawBody: body("DELIVERED"), headers });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.inbound, []);
    assert.deepEqual(ok.delivery, { channel: "sendblue", messageId: "out-77", status: "DELIVERED", error: null });

    const bad = await ch.receive({ rawBody: body("ERROR", { error_code: 22, error_message: "Message failed to send", error_reason: "iMessage not delivered" }), headers });
    assert.equal(bad.status, 200);
    assert.equal(bad.delivery.status, "ERROR");
    assert.match(bad.delivery.error, /failed to send; iMessage not delivered; code 22/);

    // And through the router, the outbox hears it.
    const { router, fake } = harness();
    router.register(ch);
    await sendTool({ to: "owner", text: "your table's at 8" }, router);
    db.db.prepare("UPDATE outbox SET channel = 'sendblue', message_id = 'out-77' WHERE message_id = ?").run(fake.sent[0].message_id);
    const hook = await router.webhook({ channel: "sendblue", rawBody: body("ERROR", { error_message: "Message failed to send" }), headers });
    assert.equal(hook.status, 200);
    assert.equal(hook.delivery.failed, true);
    assert.equal(db.outboundByMessageId("sendblue", "out-77").state, "failed");
  } finally { unconfigure(); }
});

// ---------- the switch ----------

test("off: the callback is ignored and the tool's wording is what it was", async () => {
  process.env.REASON_DELIVERY_GATED = "off";
  const { router, fake } = harness();
  const out = await sendTool({ to: "owner", text: "hi" }, router);
  assert.match(out.note, /You may say you sent it/);
  assert.equal(out.delivery, undefined);
  const r = outbox.noteDelivery({ channel: "fake", messageId: fake.sent[0].message_id, status: "ERROR", error: "x" });
  assert.equal(r.ignored, "off");
  assert.equal(db.outboundByMessageId("fake", fake.sent[0].message_id).state, "sent");
});
