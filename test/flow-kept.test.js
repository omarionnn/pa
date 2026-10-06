// The 7:09 PM incident, replayed against the real model.
//
// test/kept.test.js proves the plumbing: the pages Reason made are in front of the model on a turn
// they start, and a sweep leaves one line in the thread rather than a bundle. What it cannot prove
// is the thing Omari actually asked for on 2026-10-06 — that "About leaving", minutes after Reason's
// own 7pm workout nudge, is read as being about the workout, and that a guide Reason wrote for him
// the night before gets offered rather than forgotten.
//
// Asserts on facts, not wording: the reply does not ask what the message is about, and it carries
// either the guide's own link or a word that could only have come from the page's title. Skipped
// with no model reachable (no API key, no claude-cli backend).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-kept-"));
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
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, stamp } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;"
    + " DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM pages; DELETE FROM timers;");
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
    const handle = `in-${clock.now()}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return { reply, bubbles: fake.sent.map(m => m.text) };
  }
  return { rt, says };
}

test(`"about leaving" after its own workout nudge is the workout, and the guide it wrote gets offered (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    // The night before: a guide, kept on a page. Its title is the only place the word "lats" exists.
    const page = await runTool("page_create", {
      title: "Your back building guide: lats, rows, pull-ups",
      blocks: [
        { type: "section", title: "The plan" },
        { type: "steps", items: ["Pull-ups, 3 sets to failure", "Barbell rows, 4 x 8", "Face pulls, 3 x 15"] },
      ],
    }, { conversationId: C });
    assert.equal(page.ok, true, page.error);

    // The thread as it stood at 7:08 PM: the nudge Reason itself sent eight minutes earlier, and
    // the only thing the model can see before "About leaving".
    clock.skip(20 * 3600_000);
    db.saveConversation(C, [
      { role: "user", content: `[event ${stamp()}] timer #59 fired (set for ${stamp()}). your note: "nudge omari to do today's workout (oct challenge), he said he'd do it around 7pm". Decide whether to say something. If nothing is worth sending, reply NO_REPLY.` },
      { role: "assistant", content: "7pm, workout time 💪 today's october challenge one is waiting on you" },
    ]);

    const { bubbles } = await says("About leaving");
    const said = bubbles.join("\n");
    assert.ok(said.length > 0, "it answered");
    assert.doesNotMatch(said, /leaving for what|for what\?|something else\?|what do you mean/i,
      `it asked what the message was about, with its own nudge as the last thing it said: ${JSON.stringify(said)}`);
    // The guide's own link is the one fact that could only have come from the note on the turn;
    // a word off its title is the fallback. The first run of this test (2026-10-06) came back
    // "nice, have a good one 💪 if today's a back day, here's your back guide: <link>".
    assert.ok(said.includes(page.link) || /lats|back (day|guide)/i.test(said),
      `it had a guide it wrote for exactly this and did not bring it: ${JSON.stringify(said)}`);
    assert.match(said, /workout|work out|gym|train|lift|session|back day|back guide|go get it|have a good one/i,
      `it did not read "about leaving" as the workout: ${JSON.stringify(said)}`);
  } finally { rt.stop(); }
});
