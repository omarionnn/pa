// A photo read against the conversation it arrived in.
//
// Most of this behaviour is the model's judgement and cannot be asserted without spending credit,
// so what is tested here is everything code decides: what the model was GIVEN, which rules are in
// front of it on both backends, and the one guard that holds whatever it decides — that a reading
// of a picture cannot be written down as a fact about somebody.
//
// The wording of an actual reply is listed in docs/unverified.md as needing a live run.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-photoctx-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";

const { SYSTEM, systemFor, userMessageFor } = await import("../src/agent.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM conversations; DELETE FROM accounts; DELETE FROM threads; DELETE FROM pending_inbound; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM media_items; DELETE FROM people; DELETE FROM person_facts; DELETE FROM usage;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.burstQuietMs = 0;
});

// ---------- the rules, on both backends ----------

test("the three things a picture is are named, and kept apart", () => {
  assert.match(SYSTEM, /what is actually in it, what they have TOLD you, and what you are guessing/);
  assert.match(SYSTEM, /Keep a guess a guess/);
});

test("the congrats failure is named so it cannot come back", () => {
  assert.match(SYSTEM, /congrats on the new car/);
  assert.match(SYSTEM, /is this one you're looking at/);
  assert.match(SYSTEM, /a photo arriving is not news about their life/i);
});

test("nothing visible in a photograph may be stated off one", () => {
  assert.match(SYSTEM, /Never state a model, a year, a price, who owns it, or that they bought it, off a picture/);
});

test("a question on the picture is answered first, and a picture with no context gets a question", () => {
  assert.match(SYSTEM, /answer that question first/);
  assert.match(SYSTEM, /ask what you are looking at in one short line/);
  assert.match(SYSTEM, /never force it to fit/);
});

test("a correction replaces the earlier reading and never becomes a saved fact", () => {
  assert.match(SYSTEM, /that's my friend's car/);
  assert.match(SYSTEM, /their version replaces yours/);
  assert.match(SYSTEM, /A reading of a picture never becomes something you know about them/);
});

test("both backends get the same rules, including the one the live Reason runs on", () => {
  // systemFor is what src/backends/claude-cli.js hands the CLI, so there is one prompt and not two
  // that have to be kept alike. Checked for a non-operator too, since that path rewrites the top.
  const forSomebodyElse = systemFor({ name: "Kofi", isOperator: false });
  for (const needle of [
    /what is actually in it, what they have TOLD you, and what you are guessing/,
    /congrats on the new car/,
    /A reading of a picture never becomes something you know about them/,
  ]) assert.match(forSomebodyElse, needle);
});

// ---------- what the model is actually given ----------

test("the picture and the thread it arrived in reach the model together", async () => {
  const seen = [];
  const runtime = new Runtime({ runTurn: async (t) => { seen.push(t); return "ok"; } });
  const router = new Router({ runtime });
  router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;

  // What they said first is a real message in the thread, which is what "relevant earlier
  // messages" means in practice: the next turn loads it.
  db.saveConversation("dm:owner", [
    { role: "user", content: "[Sun, Oct 5, 2026, 1:00 PM] Omari: i'm thinking about buying a car" },
    { role: "assistant", content: "nice, what are you looking at?" },
  ]);

  await router.deliver({
    channel: "fake", externalId: "e-1", from: OWNER, text: "", said: "",
    chatId: null, service: "iMessage", at: clock.now(),
    attachments: [{ kind: "image", filename: "IMG_1.jpg", url: "https://cdn.test/IMG_1.jpg" }],
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].attachments.length, 1, "the photo");
  assert.equal(db.loadConversation("dm:owner").some(m => /thinking about buying a car/.test(String(m.content))), true,
    "and the thing they said before it, still in the thread");
});

test("an uncaptioned photo arrives as a photo and no words, with nothing invented around it", () => {
  const { forModel } = userMessageFor({
    prefix: "[Sun, Oct 5, 2026, 1:35 PM] Omari:",
    text: "",
    blocks: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } }],
  });
  assert.equal(forModel.content[0].type, "image");
  assert.equal(forModel.content[1].text.trim(), "[Sun, Oct 5, 2026, 1:35 PM] Omari:",
    "no caption is not a caption Reason wrote");
});

// ---------- the guard that holds whatever the model decides ----------

test("a reading of a picture cannot be saved as a fact, and nothing is written when it is tried", async () => {
  const out = await runTool("remember", {
    about: "Omari", fact: "bought a black civic", source: "i_saw_it_in_a_photo",
  }, { conversationId: "dm:owner" });

  assert.equal(out.ok, false);
  assert.equal(out.refused, "not_something_they_said");
  assert.match(out.error, /reading of a picture/);
  assert.match(out.error, /ask them/);
  assert.equal(db.recall("dm:owner", "Omari").length, 0, "and the row was never written");
});

test("something Reason worked out is refused the same way", async () => {
  const out = await runTool("remember", {
    about: "Kofi", fact: "probably drives", source: "i_worked_it_out",
  }, { conversationId: "dm:owner" });
  assert.equal(out.ok, false);
  assert.match(out.error, /worked out/);
  assert.equal(db.recall("dm:owner", "Kofi").length, 0);
});

test("what they actually told you is still saved, exactly as it was before", async () => {
  const said = await runTool("remember", {
    about: "Kofi", fact: "allergic to shellfish", source: "they_said",
  }, { conversationId: "dm:owner" });
  assert.equal(said.ok, true);

  // And with no source at all, which is every call that was written before this rule existed.
  const plain = await runTool("remember", { about: "Timi", fact: "vegetarian" }, { conversationId: "dm:owner" });
  assert.equal(plain.ok, true);
  assert.deepEqual(db.recall("dm:owner", "").map(p => p.about).sort(), ["Kofi", "Timi"]);
});

test("there is no way a picture writes to memory on its own: the two writes are both tools", async () => {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;

  await router.deliver({
    channel: "fake", externalId: "e-2", from: OWNER, text: "", said: "",
    chatId: null, service: "iMessage", at: clock.now(),
    attachments: [{ kind: "image", filename: "car.jpg", url: "https://cdn.test/car.jpg" }],
  });

  assert.equal(db.recall("dm:owner", "").length, 0, "a photo arriving writes nothing about anybody");
  assert.equal(db.mediaFor("dm:owner").length, 1, "it writes a row in the record of what arrived, and that is all");
});
