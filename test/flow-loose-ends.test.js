// "Where were we?" answered by the real model, in the order the rule says.
//
// `test/loose-ends.test.js` proves the tool: `task_list` hands back `done_so_far`, `whats_left` and
// `needs_from_you`, and its note spells out the order. What it cannot prove is the thing that is
// actually promised to somebody who puts their phone down for a day — that the model, asked an
// ordinary question, answers in that order rather than leading with what it still wants. A model
// that opens with the question has turned a status update into a demand, and every offline test
// would still be green.
//
// So one turn, one assertion that matters: what has happened comes before what is left, and the one
// thing on them comes last. Asserts on the ORDER of facts that could only have come off the sheet —
// never on wording, which is the model's. Skipped with no model reachable (no API key, no claude-cli
// backend).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-loose-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;"
    + " DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM pages;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A real runtime on a fake iMessage thread, delivered the way serve.js delivers it. */
function harness() {
  const rt = new Runtime();
  const router = new Router();
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async (m) => { await deliver({ ...m, media: null }); });

  async function says(text) {
    clock.skip(120_000);
    const handle = `in-${clock.now()}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return { reply, bubbles: fake.sent.map(m => m.text) };
  }
  return { rt, says };
}

const call = (name, input = {}) => runTool(name, input, { conversationId: C });

test(`"where were we" comes back done, then left, then the one ask (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    // A job mid-flight. Every token below exists only on this sheet, so an answer containing them
    // was read off the sheet rather than improvised — and the three are deliberately distinct
    // strings, so where each one lands in the reply is a fact about order and not a coincidence.
    const { id } = (await call("task_start", { title: "find a place", goal: "a place under 2k incl fees by nov 1" })).task;
    await call("task_update", {
      task_id: id,
      sheet: { stakes: "money" },
      progress: "read 3 listing pages near the L; 441 graham is $1,850 + $200 fees",
    });
    await call("task_update", {
      task_id: id,
      sheet: { left: ["get the super's number", "ask about the move-in date"] },
    });
    await call("task_update", {
      task_id: id, state: "waiting_on_you",
      sheet: {
        needs: {
          question: "tuesday or wednesday for the viewing?",
          tradeoff: "tuesday it's still listed, wednesday you could see two places",
        },
      },
    });

    const { bubbles } = await says("hey where were we");
    const said = bubbles.join("\n");
    assert.ok(said.length > 0, "it answered");

    const at = (re, what) => {
      const m = said.match(re);
      assert.ok(m, `${what} is not in the answer at all: ${JSON.stringify(said)}`);
      return m.index;
    };
    const done = at(/441|1,?850/i, "what has already happened");
    const left = at(/super/i, "what is still left");
    const ask = at(/tuesday|wednesday/i, "the one thing it needs from them");

    assert.ok(done < ask,
      `the ask came before what is done, which turns an update into a demand: ${JSON.stringify(said)}`);
    assert.ok(left < ask,
      `the ask came before what is left: ${JSON.stringify(said)}`);
    assert.ok(done < left,
      `what is left came before what is done: ${JSON.stringify(said)}`);

    // And the job is still theirs to answer: reading it back is not an answer to it.
    assert.equal(db.getTask(C, id).state, "waiting_on_you");
    assert.equal(db.getTask(C, id).sheet.needs.question, "tuesday or wednesday for the viewing?");
  } finally { rt.stop(); }
});
