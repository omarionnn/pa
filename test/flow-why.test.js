// "I want to move to save money" — against the real model, the reason has to change the answer.
//
// test/why.test.js proves the plumbing: the reason is written down with their sentence on it, it is
// on the sheet of every later job on the subject, and it carries the instruction to rank by it. What
// that cannot prove is the thing the whole feature is for — that a stated reason really does reorder
// the options, rather than being written down and then ignored. Two turns:
//
//   1. They state it. Reason has to WRITE IT DOWN, with their own words, as a reason and not a fact.
//   2. They ask for a pick between a cheap far one and an expensive near one. With "to save money"
//      on record, the cheap one is the answer and the line says why.
//
// Asserts on the database and on which figure the answer leads with, never on wording. Skipped with
// no model reachable (no API key, no claude-cli backend).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-why-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = process.env.REASON_PUBLIC_URL || "https://reason.example.test";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;"
    + " DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM tasks; DELETE FROM task_log;"
    + " DELETE FROM whys; DELETE FROM preferences; DELETE FROM timers;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

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
    const before = fake.sent.length;
    const handle = `in-${clock.now()}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return { reply, said: fake.sent.slice(before).map(m => m.text).join("\n") };
  }
  return { rt, says };
}

test(`"move to save money" is written down as a reason, and then the cheap one is the pick (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    // ---- 1. they state it ----
    const first = await says("i wanna move, rent here is killing me and i'm trying to save money. help me find a 1 bed in brooklyn");
    assert.ok(first.said.length > 0, "it answered");

    const whys = db.listWhys(C);
    assert.ok(whys.length >= 1,
      `they stated a reason and it was not written down. whys: ${JSON.stringify(whys)}`);
    const money = whys.find(w => /money|sav|cheap|cost|rent|budget/i.test(`${w.why} ${w.said}`));
    assert.ok(money, `the reason on record is not the one they gave: ${JSON.stringify(whys)}`);
    assert.ok(money.said.trim().length > 0, "a reason with no sentence behind it is not allowed to exist");
    assert.match(money.said, /money|sav|rent/i,
      `'said' has to quote them, not be your paraphrase: ${JSON.stringify(money.said)}`);
    // It went in as a reason and not as a fact about them: the facts table is for what they told
    // Reason stays true, and "trying to save money" is a goal.
    assert.ok(!db.listFacts(C).some(f => /sav(e|ing) money/i.test(f.fact)),
      `the reason was duplicated into the facts list, where nothing ranks by it: ${JSON.stringify(db.listFacts(C))}`);

    // ---- 2. the pick ----
    const pick = await says("ok real question. 2100 a month 50 mins from work, or 2900 a month 15 mins from work. which do i take");
    const said = pick.said;
    assert.ok(said.length > 0, "it answered the question");

    const cheap = said.search(/2,?100/);
    const dear = said.search(/2,?900/);
    assert.ok(cheap !== -1, `it did not name the cheaper place at all: ${JSON.stringify(said)}`);
    assert.ok(dear === -1 || cheap < dear,
      `with "saving money" on record the cheap one is the answer and the answer goes first: ${JSON.stringify(said)}`);
    // And it says WHY, in their own terms, rather than picking silently.
    assert.match(said, /sav|money|cheap|budget|800|rent/i,
      `it ranked by the reason and never said so, which is the half they can check: ${JSON.stringify(said)}`);
  } finally { rt.stop(); }
});
