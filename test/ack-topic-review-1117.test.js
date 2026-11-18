// Review of REASON_TAPBACK_TOPIC (src/acktopic.js, src/tapbackack.js), 2026-11-17.
//
//   one message, one reaction: a food order's status tapback (src/food.js) owns its request text from
//   the moment the order exists. The 👀/topic tapback comes off before ⏳ goes on, nothing from
//   tapbackack ever lands on that text after, and its ✅ never overwrites the order's status;
//   a sensitive text never gets a topic emoji: exactly the switch-off 👀, or 🔍 for a lookup;
//   25 realistic texts, traps included, pinned;
//   a line that cannot react sends nothing, and nothing here is waited on by the reply.
//
// No model and no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-ack-topic-1117-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_TAPBACK_ACK = "on";
process.env.REASON_FOOD = "owner";

const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const ack = await import("../src/tapbackack.js");
const topic = await import("../src/acktopic.js");
const food = await import("../src/food.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const CONV = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  ack.reset();
  process.env.REASON_TAPBACK_ACK = "on";
  process.env.REASON_TAPBACK_TOPIC = "on";
  db.db.exec("DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM inbound_messages; DELETE FROM food_orders;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function arrived(handle, text) {
  db.db.prepare("DELETE FROM inbound_messages WHERE external_id = ?").run(handle);
  db.claimInbound({ channel: "fake", externalId: handle, conversationId: CONV, text });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
}
function harness() {
  const router = new Router({ runtime: { on() {}, inbound: async () => {} } });
  const fake = router.register(new FakeChannel({ number: LINE }));
  food._attach({ say: async () => {}, wake: async () => {}, channels: () => router });
  return { router, fake };
}
const reactions = (fake) => fake.reactCalls.map(r => r.reaction);

// ---------- one message, one reaction ----------

test("a food order opened after the topic tapback: 🍽️ comes off, ⏳ goes on, and the turn's ✅ never lands", async () => {
  arrived("F-1", "need a dinner spot in soho, order me thai from somewhere good");
  const { router, fake } = harness();
  const ctx = { conversationId: CONV, channels: router };
  ack.noteTool(ctx, "nearby_places", { ok: true }, { type: "restaurant" });
  await ack.settled(CONV);
  assert.deepEqual(reactions(fake), ["🍽️"]);
  await food.startOrder(CONV, { requestHandle: "F-1" });
  ack.noteTool(ctx, "food_order", { ok: true }, {});
  ack.noteTool(ctx, "browser_open", { ok: true }, { url: "https://doordash.com" });
  await ack.settled(CONV);
  await ack.afterReply(CONV, { acts: [{ acting: true, ok: true }], channels: router });
  assert.deepEqual(reactions(fake), ["🍽️", "-🍽️", "⏳"]);
});

test("a food order that exists before the first tool: the order's ⏳ only, no topic after it", async () => {
  arrived("F-2", "order me pizza from joe's");
  const { router, fake } = harness();
  await food.startOrder(CONV, { requestHandle: "F-2" });
  const ctx = { conversationId: CONV, channels: router };
  ack.noteTool(ctx, "food_order", { ok: true }, {});
  ack.noteTool(ctx, "web_search", { ok: true }, { query: "joe's pizza" });
  await ack.settled(CONV);
  await ack.afterReply(CONV, { acts: [{ acting: true, ok: true }], channels: router });
  assert.deepEqual(reactions(fake), ["⏳"]);
  // a later status still replaces the order's own, as before
  await food.setStatus(food.openOrder(CONV), "needs");
  assert.deepEqual(reactions(fake), ["⏳", "❓"]);
});

test("switch off, same rule: 👀 comes off before ⏳, and the turn's ✅ never overwrites the order", async () => {
  process.env.REASON_TAPBACK_TOPIC = "off";
  arrived("F-3", "order me thai food");
  const { router, fake } = harness();
  const ctx = { conversationId: CONV, channels: router };
  ack.noteTool(ctx, "nearby_places", { ok: true }, { type: "restaurant" });
  await ack.settled(CONV);
  await food.startOrder(CONV, { requestHandle: "F-3" });
  await ack.settled(CONV);
  await ack.afterReply(CONV, { acts: [{ acting: true, ok: true }], channels: router });
  // today's 👀 → 🔍 for the lookup, then off before the order's ⏳; no ✅ from the turn after
  assert.deepEqual(reactions(fake), ["👀", "-👀", "🔍", "-🔍", "⏳"]);
});

test("a NEW text after a food order is untouched by the rule: it gets its own tapback", async () => {
  arrived("F-4", "order me thai food");
  const { router, fake } = harness();
  await food.startOrder(CONV, { requestHandle: "F-4" });
  arrived("F-5", "my laptop won't connect to the wifi");
  ack.noteTool({ conversationId: CONV, channels: router }, "web_search", { ok: true }, {});
  await ack.settled(CONV);
  assert.deepEqual(fake.reactCalls.map(r => `${r.messageHandle}:${r.reaction}`), ["F-4:⏳", "F-5:💻"]);
});

// ---------- sensitive ----------

test("sensitive texts never get a topic emoji: 👀, or 🔍 when the first tool is a lookup (today's)", async () => {
  for (const [text, tool, input, want] of [
    ["is this mole normal", "web_search", { query: "is this mole normal" }, ["🔍"]],
    ["my mom is in the hospital, find flights", "flight_search", {}, ["🔍"]],
    ["draft a breakup text", "document_create", {}, ["👀"]],
    ["my card got declined at dinner", "bank", {}, ["👀"]],
    ["find a dentist near me", "nearby_places", { type: "dentist" }, ["🔍"]],
  ]) {
    ack.reset();
    arrived("S-1", text);
    const { router, fake } = harness();
    ack.noteTool({ conversationId: CONV, channels: router }, tool, { ok: true }, input);
    await ack.settled(CONV);
    assert.deepEqual(reactions(fake), want, text);
  }
});

// ---------- 25 texts ----------

const CASES = [
  ["my card got declined at dinner", "web_search", {}, "👀"],
  ["book a table and get me an uber there", "nearby_places", { type: "restaurant" }, "👀"],
  ["my mom is in the hospital, find flights", "flight_search", {}, "👀"],
  ["cancel my gym", "browser_open", { url: "https://planetfitness.com" }, "👀"],
  ["is this mole normal", "web_search", { query: "is this mole normal" }, "👀"],
  ["draft a breakup text", "document_create", {}, "👀"],
  ["court date reminder", "timer_set", {}, "👀"],
  ["¿me puedes reservar una mesa para dos esta noche?", "nearby_places", { type: "restaurant" }, "🍽️"],
  ["flights", "flight_search", {}, "✈️"],
  ["", "web_search", {}, "👀"],
  ["lol jess did you see that", "web_search", {}, "👀"],
  ["my laptop keeps crashing after the update", "web_search", { query: "laptop crashing after update" }, "💻"],
  ["find me a cheap blender on amazon", "shop_search", { query: "blender" }, "🛍️"],
  ["get me an uber to jfk", "uber_options", {}, "🚕"],
  ["how long to get to the office with traffic", "directions", {}, "🗺️"],
  ["what's on my calendar tomorrow", "calendar_events", {}, "📅"],
  ["any emails from the landlord?", "gmail_search", {}, "✉️"],
  ["play something chill on spotify", "spotify_play", {}, "🎵"],
  ["summarize this youtube video", "video_understand", {}, "🎬"],
  ["I can't log into my chase account", "signin_start", {}, "🔑"],
  ["I got laid off today, can you help me update my resume", "document_create", {}, "👀"],
  ["order me pizza, I'm broke till friday tho", "food_order", {}, "👀"],
  ["find a dentist near me", "nearby_places", { type: "dentist" }, "👀"],
  ["buy me some time with the landlord, I'm behind on rent", "gmail_send", {}, "👀"],
  ["what's the best protein powder for weight loss", "shop_search", { query: "protein powder weight loss" }, "👀"],
];

test("25 texts, traps included: a topic only when it is sure", () => {
  assert.equal(CASES.length, 25);
  const got = CASES.map(([text, tool, input]) => topic.topicFor({ tool, input, text }).emoji ?? "👀");
  assert.deepEqual(got, CASES.map(c => c[3]));
  // an image with no words and nothing in the tool: nothing to go on
  assert.equal(topic.topicFor({ tool: "image_describe", input: {}, text: "" }).emoji ?? "👀", "👀");
});

// ---------- the line ----------

test("a line that cannot react: nothing sent, nothing thrown, and noteTool never waits on the line", async () => {
  arrived("C-1", "my laptop keeps crashing");
  const { router, fake } = harness();
  fake.react = undefined; // like the console or Linq: no react()
  assert.doesNotThrow(() => ack.noteTool({ conversationId: CONV, channels: router }, "web_search", { ok: true }, {}));
  await ack.settled(CONV);
  assert.deepEqual(fake.reactCalls, []);

  ack.reset();
  arrived("C-2", "my laptop keeps crashing");
  const h2 = harness();
  let calls = 0;
  h2.fake.react = () => { calls++; return new Promise(() => {}); }; // a line that never answers
  const t0 = Date.now();
  ack.noteTool({ conversationId: CONV, channels: h2.router }, "web_search", { ok: true }, {});
  const r = ack.afterReply(CONV, { acts: [{ acting: true, ok: true }], channels: h2.router }); // runtime does `void` this
  assert.ok(Date.now() - t0 < 50, "noteTool returned at once");
  assert.ok(r instanceof Promise);
  await new Promise(res => setTimeout(res, 20));
  assert.equal(calls, 1);
});
