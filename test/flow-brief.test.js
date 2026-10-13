// A brief, walked against the real model: given a situation, does Reason act or ask?
//
// The text is Omari's own from 2026-10-12, word for word. That night the live Reason answered
// "what time do you usually leave the house?", then "which station do you get on at, and which
// line?", and only after "where's the proactiveness" did it work out the route, set the Thu–Sun
// morning check and say the leave time — everything it could have done on the first turn.
//
// What this asserts is the shape of the first reply and the state it leaves, not the wording:
// no question in it, a route and a leave time in it, one standing check set for the four days
// at a morning hour, and no asked_back row in the ledger. Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-brief.test.js
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-brief-"));
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
const series = await import("../src/series.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const COMMUTE = "I leave at 3247 Bruner Ave I work at 430 w 17st on Thursday to Sunday from 8am to 8pm. I take the train. So update me on that";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM series; DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts;"
    + " DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;"
    + " DELETE FROM action_ledger;");
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
    const handle = `in-${clock.now()}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const before = fake.sent.length;
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return { reply, said: fake.sent.slice(before).map(m => m.text).join("\n") };
  }
  return { rt, says, fake };
}

test(`a commute brief gets the route, the leave time and the standing check — and no question (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    // Tuesday night, 10:13pm New York — when it actually happened.
    clock.skip(Date.parse("2026-10-13T02:13:00Z") - clock.now());
    const first = await says(COMMUTE);
    assert.ok(first.said.length > 0, "it answered");
    // For a report that wants the words and not only the verdict: FLOW_PRINT=1.
    if (process.env.FLOW_PRINT) console.log(`\nREASON SAID:\n${first.said}\n`);

    // The whole point: no question in front of the work.
    assert.ok(!first.said.includes("?"), `it asked instead of acting: ${JSON.stringify(first.said)}`);
    assert.equal(db.listActions(C).filter(a => a.action === "asked_back").length, 0, "and the ledger agrees");

    // It worked the route out itself and said when to leave.
    assert.match(first.said, /\b(5|2|6|train|subway)\b/i, `no route in it: ${JSON.stringify(first.said)}`);
    assert.match(first.said, /\b\d{1,2}(:\d{2})?\s*(am|a\.m\.)?\b/i, `no leave time in it: ${JSON.stringify(first.said)}`);

    // One standing check, the four days he named, in the morning before 7:50.
    const rows = db.listSeries(C);
    assert.equal(rows.length, 1, `expected one standing check, got ${rows.length}: ${JSON.stringify(first.said)}`);
    const rule = series.parseRule(rows[0].rule);
    assert.equal(rule.kind, "weekly", JSON.stringify(rule));
    assert.deepEqual([...rule.weekdays].sort(), [0, 4, 5, 6], `thu-sun, got ${JSON.stringify(rule.weekdays)}`);
    assert.ok(rule.hour < 8, `a morning check, got hour ${rule.hour}`);
    assert.match(rows[0].what, /commute|train|leave|7:50|w 17|17th/i, rows[0].what);

    // And it said when the first one lands — a day, not just "set".
    assert.match(first.said, /thu|thursday/i, `never said when the first check is: ${JSON.stringify(first.said)}`);
  } finally { rt.stop(); }
});
