// A form in a photo, walked against the real model: does Reason fill it in, and can it still
// answer about it one turn later with the picture gone?
//
// This is Omari's own case from 2026-10-13. He sent a photo of a caregiver job form with eight
// scenario questions on it. The live Reason said "want me to write answers for all 8?", and on
// the next turn "I can't see the photo anymore, and I never wrote down the exact wording of the
// 8 questions — can you send the picture again?"
//
// What this asserts is the shape of the two replies and the state they leave, not the wording:
// the first reply has no question in it and answers at least the first and last questions; the
// note stored for the photo has the form's own words in it; and the second turn — "redo number 4,
// shorter", with the photo no longer attached — answers about handling a client's finances
// without asking for the picture, either from the note or by photo_look. Skipped with no model.
//
//   REASON_BACKEND=claude-cli node --test test/flow-form.test.js
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-form-"));
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
// A message with a photo is one turn, now, not held for the rest of a burst.
process.env.REASON_BURST_QUIET_MS = "0";
// On the subscription backend the router serves only the operator's test numbers (src/backends/guard.js).
process.env.REASON_TEST_NUMBERS = process.env.REASON_TEST_NUMBERS || "+12025551234";

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
const FORM_PNG = readFileSync(new URL("./fixtures/pictures/caregiver-form.png", import.meta.url));
const FORM_URL = "https://cdn.example.test/caregiver-form.png";
// The photo's host is a stand-in: every fetch of it — the turn it arrives on, and photo_look
// later — is answered with the fixture, so the only thing live here is the model.
const serving = async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => FORM_PNG });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM media_items; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM pending_inbound;"
    + " DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function harness() {
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.turnExtras.fetchImpl = serving;
  const toolCalls = [];
  const baseLog = rt.log;
  rt.log = (l) => { if (l?.tool) toolCalls.push(l.tool); baseLog?.(l); };
  rt.on("outbound", async (m) => { await deliver({ ...m, media: null }); });
  let n = 0;
  async function says(text, { photo = false } = {}) {
    const handle = `in-${++n}-${clock.now()}`;
    const before = fake.sent.length;
    await router.deliver({
      channel: "fake", externalId: handle, from: OWNER, text, said: text, chatId: null, service: "iMessage", at: clock.now(),
      attachments: photo ? [{ kind: "image", filename: "caregiver-form.png", url: FORM_URL }] : [],
    });
    return { said: fake.sent.slice(before).map(m => m.text).join("\n") };
  }
  return { rt, says, fake, toolCalls };
}

test(`a photo of a form is filled in without a question, and answered about a turn later with the picture gone (${label})`, { skip, timeout: 600_000 }, async () => {
  // src/media.js fetches the photo itself; the host above is answered by the fixture.
  const media = await import("../src/media.js");
  const realImages = media.imagesFor;
  const { rt, says, toolCalls } = harness();
  rt.turnExtras.images = (atts, opts) => realImages(atts, { ...opts, fetchImpl: serving });
  try {
    const first = await says("", { photo: true });
    if (process.env.FLOW_PRINT) console.log(`\nREASON SAID (1):\n${first.said}\n`);
    assert.ok(first.said.length > 0, "it answered");

    // The whole point: it filled the form in rather than offering to.
    assert.ok(!/want me to|should i|shall i|do you want/i.test(first.said), `it offered instead of doing: ${JSON.stringify(first.said)}`);
    assert.match(first.said, /medication/i, `question 1 not answered: ${JSON.stringify(first.said)}`);
    assert.match(first.said, /de-?escalat|calm|aggress/i, `question 8 not answered: ${JSON.stringify(first.said)}`);

    // The photo was written down as its own words, not as the chat reply.
    const rows = db.mediaFor(C, { kinds: ["image"] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].coverage, "looked");
    assert.match(rows[0].description, /refuses to take their medication/i, `the form's words are not in the note: ${JSON.stringify(rows[0].description.slice(0, 300))}`);
    assert.match(rows[0].description, /finances/i, rows[0].description.slice(0, 300));

    // One turn on, the picture gone: it answers about question 4 and never asks for the photo.
    const second = await says("redo number 4, shorter");
    if (process.env.FLOW_PRINT) console.log(`\nREASON SAID (2):\n${second.said}\nTOOLS: ${toolCalls.join(", ")}\n`);
    assert.ok(second.said.length > 0, "it answered");
    assert.ok(!/send (it|the (photo|picture|pic)) again|can't see (the|that) (photo|picture)|no longer see|resend/i.test(second.said),
      `it asked for the photo again: ${JSON.stringify(second.said)}`);
    assert.match(second.said, /financ|money|job description|outside my role|not something i can/i, `not about question 4: ${JSON.stringify(second.said)}`);
    assert.ok(!second.said.includes("?"), `a question instead of the redo: ${JSON.stringify(second.said)}`);

    // Something only the picture can answer. The note is made to say nothing about colour first,
    // because a good note often does — and then the only way to the answer is back to the pixels,
    // through the real CLI: photo_look, and an MCP image block it actually reads.
    if (process.env.FLOW_PRINT) console.log(`\nNOTE KEPT:\n${rows[0].description}\n`);
    db.describeMedia(rows[0].id, rows[0].description.replace(/\b(pink|red|rose|salmon|blush|coloured|colored|colour|color)\w*/gi, ""));
    const third = await says("what colour are the answer boxes on that form");
    if (process.env.FLOW_PRINT) console.log(`\nREASON SAID (3):\n${third.said}\nTOOLS: ${toolCalls.join(", ")}\n`);
    assert.ok(toolCalls.includes("photo_look"), `it never looked again: tools were ${JSON.stringify(toolCalls)}`);
    assert.ok(!/send (it|the (photo|picture|pic)) again|can't see|no longer see|resend/i.test(third.said), `it asked for the photo again: ${JSON.stringify(third.said)}`);
    assert.match(third.said, /pink|red|rose|salmon|blush/i, `it did not see the boxes: ${JSON.stringify(third.said)}`);
  } finally { rt.stop(); }
});
