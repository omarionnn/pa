// Security audit 2026-11-06, lead 29: a timer or sweep turn that also carries a "[delivery failure]"
// notice must never count as the owner's reply to a pending confirmation. The API backend used to put
// the notice in front of the "[event …]" marker, which is the only thing src/trust.js ownerTexts uses to
// tell an event line from something the owner said, so the event line counted as a new owner message
// and its text (Reason's own failed message, the provider's error, the timer's text) went to the yes/no
// judge as their answer.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-l29-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONFIRM_WINDOW_MIN = "10";
process.env.REASON_TZ = "America/New_York";
delete process.env.REASON_PAYMENTS_KEY;

const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { userMessageFor } = await import("../src/agent.js");
const { undeliveredNotice } = await import("../src/outbox.js");

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const C = "dm:l29";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM confirmations;");
});

const notice = () => undeliveredNotice([{ to_owner: 1, body: "yes, go ahead and send it", last_error: "carrier rejected: yes" }], { ownerName: "Omari" });
const yes = async () => ({ verdict: "yes" });

test("an event turn that carries a delivery-failure notice is not an owner message", () => {
  const { forModel, forHistory } = userMessageFor({ notice: notice(), prefix: "[event Wed, Sep 30, 2026, 3:00 PM]", text: "timer #1 fired" });
  assert.equal(trust.ownerTexts([forModel]).length, 0);
  assert.equal(trust.ownerTexts([forHistory]).length, 0);
});

test("a pending confirmation is not granted by an event turn that carries a delivery-failure notice", async () => {
  const ask = trust.requestConfirmation({ conversationId: C, messages: [], action: "send_text", summary: "text Sam that I'm running late", stakes: "x" });
  const { forModel } = userMessageFor({ notice: notice(), prefix: "[event Wed, Sep 30, 2026, 3:00 PM]", text: "timer #1 fired" });
  const out = await trust.recordConfirmation({ conversationId: C, messages: [forModel], confirmationId: ask.confirmation_id, judge: yes });
  assert.equal(out.state, "waiting_for_yes");
  assert.equal(db.db.prepare("SELECT granted_at FROM confirmations WHERE id = ?").get(ask.confirmation_id).granted_at, null);
});

test("the owner's own reply still counts when a delivery-failure notice rides on it, and the notice is not their words", async () => {
  const ask = trust.requestConfirmation({ conversationId: C, messages: [], action: "send_text", summary: "text Sam that I'm running late", stakes: "x" });
  const { forModel, forHistory } = userMessageFor({ notice: notice(), prefix: "[Wed, Sep 30, 2026, 3:00 PM] Omari:", text: "yes" });
  assert.equal(trust.typedOnly(trust.ownerTexts([forModel])[0]), "yes");
  assert.equal(trust.typedOnly(trust.ownerTexts([forHistory])[0]), "yes");
  const out = await trust.recordConfirmation({ conversationId: C, messages: [forModel], confirmationId: ask.confirmation_id, judge: yes });
  assert.equal(out.state, "granted");
});

test("the model still sees the delivery-failure notice on the turn, and the thread keeps it", () => {
  const { forModel, forHistory } = userMessageFor({ notice: notice(), prefix: "[event x]", text: "timer #1 fired" });
  assert.match(forModel.content, /\[delivery failure\]/);
  assert.match(forHistory.content, /\[delivery failure\]/);
});
