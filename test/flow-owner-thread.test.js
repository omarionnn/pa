// A tester asks for a link to be texted to them. It must reach the tester, never the operator.
//
// Real model, real tool loop, fake channel: the 10-27 incident in Yaw's thread (outbox 1850), where
// message_send {to:"owner"} was delivered to the operator's phone. Asserts only on where things
// landed, never on wording.
//
// Run it:  REASON_BACKEND=claude-cli node --import ./test/paid-key-guard.js --test test/flow-owner-thread.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-owner-thread-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_BURST_QUIET_MS = "0";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OPERATOR = "+12025551234";
const YAW = "+16165557647";
const C = `dm:fake:${YAW}`;

let rt, router, fake;
before(() => {
  clock.reset();
  rt = new Runtime();
  router = new Router({ runtime: rt });
  fake = router.register(new FakeChannel({ media: true }));
  rt.turnExtras = { ...(rt.turnExtras ?? {}), channels: router };
  db.upsertAccount({ conversationId: C, channel: fake.name, address: YAW, name: "Yaw", isOperator: false });
  db.upsertThread({ conversationId: C, channel: fake.name, address: YAW, chatId: null, service: "iMessage" });
});
after(() => { rt.stop(); rmSync(dir, { recursive: true, force: true }); });

test(`a tester's "send me the flight link" never lands on the operator's phone (${label})`, { skip }, async () => {
  const reply = await rt.inbound(C, "im about to jump on a call. text me the google flights link for seattle to DC one way tomorrow as its own message so i have it");
  assert.ok(typeof reply === "string", "it answered");

  const sends = db.db.prepare("SELECT action, attempted, result FROM action_ledger WHERE conversation_id = ? AND action = 'message_send'").all(C);
  const toOperator = fake.sent.filter(s => s.to === OPERATOR);
  console.log(JSON.stringify({ message_sends: sends.map(s => ({ to: JSON.parse(s.attempted).to, sent_to: JSON.parse(s.result).sent_to })), fake_sent_to: fake.sent.map(s => s.to), reply: reply.slice(0, 160) }));
  assert.equal(toOperator.length, 0, "nothing reached the operator's phone");
  for (const s of sends) {
    const r = JSON.parse(s.result);
    if (r.sent_to) assert.equal(r.sent_to, YAW, "every text the model sent went to Yaw");
  }
  assert.ok(sends.length > 0 || /google\.com\/travel\/flights|flights/i.test(reply), "the link reached Yaw one way or the other");
});
