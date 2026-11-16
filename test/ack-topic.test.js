// REASON_TAPBACK_TOPIC (src/acktopic.js, src/tapbackack.js): the first tapback on a text says what it
// is about (💻 a tech problem, 🛍️ shopping...) instead of 👀, decided by code from the first tool and
// their words, with no model call.
//
//   does every row of the table fire on its own case, and fall back to 👀 on a near miss?
//   is a tie 👀, and is anything sensitive or unscreened 👀?
//   are the swaps only ⏰ and ✅, so one text never flickers through three emoji?
//   does a channel that cannot show any emoji keep today's behaviour?
//   with the switch off, is it exactly today's 👀 → 🔍?
//
// No model and no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-ack-topic-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_TAPBACK_ACK = "on";

const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const ack = await import("../src/tapbackack.js");
const topic = await import("../src/acktopic.js");
const { checkReaction } = await import("../src/expressive.js");
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
  db.db.exec("DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function arrived(handle, text) {
  db.claimInbound({ channel: "fake", externalId: handle, conversationId: CONV, text });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle.replace(/_\d+$/, "") });
}

function harness() {
  const router = new Router({ runtime: { on() {}, inbound: async () => {} } });
  const fake = router.register(new FakeChannel({ number: LINE }));
  return { router, fake };
}
const reactions = (fake) => fake.reactCalls.map(r => r.reaction);

/** One text, its tools in order, then the reply going out; what landed on the text. */
async function turn(text, tools, { acted = false, ctx = {}, before = null } = {}) {
  arrived("H-1", text);
  const { router, fake } = harness();
  if (before) before(fake);
  const c = { conversationId: CONV, channels: router, ...ctx };
  for (const [name, input = {}, out = { ok: true }] of tools) ack.noteTool(c, name, out, input);
  await ack.settled(CONV);
  await ack.afterReply(CONV, { acts: acted ? [{ acting: true, ok: true }] : [], channels: router });
  return reactions(fake);
}

const pick = (args) => topic.topicFor(args).emoji ?? "👀";

// ---------- the table ----------

test("every emoji in the table is one emoji a Sendblue reaction takes, and none means two things", () => {
  const seen = new Map();
  for (const r of topic.TOPICS) {
    assert.equal(checkReaction(r.emoji).ok, true, `${r.topic}: ${r.emoji}`);
    assert.equal([...new Intl.Segmenter().segment(r.emoji)].length, 1, r.topic);
    assert.ok(!seen.has(r.emoji), `${r.emoji} is both ${seen.get(r.emoji)} and ${r.topic}`);
    seen.set(r.emoji, r.topic);
    assert.notEqual(r.emoji, ack.ACK.done, "✅ only ever means done");
    assert.notEqual(r.emoji, ack.ACK.seen, "👀 is the fallback, not a topic");
  }
});

// [topic, positive case, near miss that must be 👀]
const ROWS = [
  ["💻", { tool: "web_search", input: { query: "wifi dropping fix" }, text: "my wifi keeps dropping every 10 min" },
         { tool: "web_search", text: "what laptop should i get for work" }],
  ["🛍️", { tool: "browser_open", input: { url: "https://www.amazon.com/dp/B0X" }, text: "can you reorder my protein powder" },
         { tool: "memory_search", text: "buy me some time with jake, tell him i'm 10 late" }],
  ["🍽️", { tool: "nearby_places", input: { type: "restaurant", cuisine: "thai" }, text: "good thai near me?" },
         { tool: "memory_search", text: "move my dinner with sam to 8" }],
  ["✈️", { tool: "flight_search", input: {}, text: "flights to miami next fri, after 5pm" },
         { tool: "memory_search", text: "i tripped on the stairs lol" }],
  ["🚕", { tool: "uber_request", input: {}, text: "get me an uber to the airport" },
         { tool: "memory_search", text: "my car broke down" }],
  ["🗺️", { tool: "directions", input: {}, text: "how long to get to jfk from midtown at 5" },
         { tool: "memory_search", text: "how far along is the project" }],
  ["💳", { tool: "bank", input: { action: "balance" }, text: "what's in checking" },
         { tool: "memory_search", text: "what's the balance of power in the senate now" }],
  ["📅", { tool: "calendar_events", input: {}, text: "am i free thursday at 3" },
         { tool: "memory_search", text: "what's the schedule for the knicks game" }],
  ["✉️", { tool: "gmail_search", input: { query: "from:delta" }, text: "find the email from delta about my flight" },
         { tool: "memory_search", text: "email the hotel and ask about late checkout" }],
  ["📞", { tool: "call_place", input: {}, text: "can you call joe's and ask if they're open late" },
         { tool: "web_search", text: "what do you call a group of crows" }],
  ["📝", { tool: "document_create", input: {}, text: "make me a doc of my packing list" },
         { tool: "web_search", text: "best avocado toast in williamsburg" }],
  ["🔍", { tool: "research", input: {}, text: "do a deep dive on standing desks" },
         { tool: "memory_search", text: "look at this" }],
  ["💪", { tool: "web_search", input: {}, text: "find a pilates class near me saturday morning" },
         { tool: "memory_search", text: "run me through the plan for tomorrow" }],
  ["🎵", { tool: "spotify_search", input: { query: "chill" }, text: "play something chill" },
         { tool: "memory_search", text: "stop playing games and tell me the plan" }],
  ["🎬", { tool: "video_understand", input: { url: "https://youtu.be/abc" }, text: "what's this video about" },
         { tool: "memory_search", text: "set up a video call with the team" }],
  ["🔑", { tool: "signin_open", input: {}, text: "log me into my united account" },
         { tool: "memory_search", text: "what's the wifi password at the hotel" }],
];

for (const [emoji, yes, near] of ROWS) {
  test(`${emoji}: its own case gets it, the near miss gets 👀`, () => {
    assert.equal(pick(yes), emoji, yes.text);
    assert.equal(pick(near), "👀", near.text);
  });
}

test("every row of the table has a case above (a new row needs one)", () => {
  const covered = new Set(ROWS.map(r => r[0]));
  for (const r of topic.TOPICS) if (r.topic !== "reminder") assert.ok(covered.has(r.emoji), r.topic);
});

test("a reminder is never ⏰ before it is set: their words only mark the topic", () => {
  assert.equal(topic.topicFor({ tool: "memory_search", text: "remind me at 5 to call mom" }).topic, "reminder");
  assert.equal(pick({ tool: "memory_search", text: "remind me to buy milk" }), "👀", "reminder + shopping is a tie");
});

// ---------- ties ----------

test("two topics at once is 👀: in their words, or the tool saying one thing and the words another", () => {
  assert.equal(pick({ tool: "memory_search", text: "order thai food and email me the receipt" }), "👀");
  assert.equal(pick({ tool: "calendar_events", text: "find us a dinner spot for friday" }), "👀", "calendar tool, food words");
  assert.equal(pick({ tool: "web_search", text: "the wifi at the hotel isn't working" }), "👀", "tech + travel");
  assert.equal(topic.topicFor({ tool: "calendar_events", text: "find us a dinner spot for friday" }).why, "tie");
});

test("the tool's topic stands when the words agree or say nothing", () => {
  assert.equal(pick({ tool: "uber_request", text: "uber to the airport pls" }), "🚕", "ride + travel words, ride tool");
  assert.equal(pick({ tool: "calendar_create", text: "put the dinner from sam's email on my calendar" }), "📅");
  assert.equal(pick({ tool: "shop_card", text: "yes that one" }), "🛍️");
});

test("an exact tool name beats a prefix: spotify_connect is 🔑, not 🎵", () => {
  assert.equal(pick({ tool: "spotify_connect", text: "hook up my spotify" }), "👀", "'hook up' is on the sensitive list");
  assert.equal(pick({ tool: "spotify_connect", text: "connect it" }), "🔑");
});

// ---------- sensitive ----------

test("anything sensitive is 👀, whatever else matches", () => {
  const cases = [
    { tool: "calendar_create", text: "book a doctor's appointment for tuesday" },
    { tool: "browser_open", input: { url: "https://www.amazon.com/s?k=condoms" }, text: "add condoms to my cart" },
    { tool: "shop_card", input: { query: "pregnancy test" }, text: "add this to my cart" },
    { tool: "bank", text: "i'm broke till friday, how much did i spend on food" },
    { tool: "subscription_cancel", text: "cancel my hinge subscription" },
    { tool: "web_search", text: "my therapist's office app won't open" },
    { tool: "meal_estimate", text: "log my lunch" },
    { tool: "flight_search", text: "flights home for the funeral" },
    { tool: "gmail_send", text: "email my lawyer back" },
  ];
  for (const c of cases) assert.equal(topic.topicFor(c).topic, null, c.text);
  for (const c of cases) assert.equal(topic.topicFor(c).why, "sensitive", c.text);
});

test("a text the safety screen did not clear is 👀", () => {
  for (const verdict of ["borderline", "crisis", "unscreened", "pending", "harm"]) {
    assert.equal(topic.topicFor({ tool: "flight_search", text: "flights to miami", harm: { verdict } }).why, "screen", verdict);
  }
  assert.equal(pick({ tool: "flight_search", text: "flights to miami", harm: { verdict: "clear" } }), "✈️");
});

// ---------- on their text: the swaps ----------

test("the topic goes on first, a lookup after it changes nothing, and done swaps it for ✅", async () => {
  const got = await turn("my wifi keeps dropping every 10 min", [["web_search", { query: "wifi drops" }], ["web_lookup"], ["memory_search"]], { acted: true });
  assert.deepEqual(got, ["💻", "-💻", "✅"]);
});

test("a topic stays when the turn only answered", async () => {
  assert.deepEqual(await turn("flights to miami next fri", [["flight_search"]]), ["✈️"]);
});

test("a topic then a reminder set: ⏰, and the reply leaves it there", async () => {
  assert.deepEqual(await turn("flights to miami next fri", [["flight_search"], ["timer_set", {}, { ok: true }]], { acted: true }), ["✈️", "-✈️", "⏰"]);
});

test("a reminder set as the first tool is ⏰ straight away, not 👀 then ⏰", async () => {
  assert.deepEqual(await turn("remind me at 5 to call mom", [["timer_set", {}, { ok: true }]]), ["⏰"]);
});

test("a reminder that failed to set is 👀, never ⏰", async () => {
  assert.deepEqual(await turn("remind me at 5 to call mom", [["timer_set", {}, { ok: false, error: "no" }]]), ["👀"]);
});

test("a first lookup with nothing else to go on is 🔍 straight away, not 👀 then 🔍", async () => {
  assert.deepEqual(await turn("what's the population of lagos", [["web_search"], ["web_lookup"]]), ["🔍"]);
});

test("👀 from a tie or a sensitive text stays 👀 through a lookup: no flicker", async () => {
  assert.deepEqual(await turn("book a doctor's appointment for tuesday", [["calendar_events"], ["web_search"]]), ["👀"]);
});

test("one text never carries more than one swap before ✅ or ⏰", async () => {
  for (const [text, tools] of [
    ["my laptop won't turn on", [["web_search"], ["browser_open", { url: "https://support.apple.com" }], ["timer_set", {}, { ok: true }]]],
    ["get me an uber to the airport", [["get_location"], ["uber_options"], ["uber_request"]]],
  ]) {
    ack.reset();
    const got = await turn(text, tools, { acted: true });
    const ons = got.filter(r => !r.startsWith("-"));
    assert.ok(ons.length <= 2, `${text}: ${got.join(" ")}`);
    assert.ok(ons.slice(1).every(r => r === "✅" || r === "⏰"), `${text}: ${got.join(" ")}`);
  }
});

test("their texts sent together are read together: a tie across them is 👀", async () => {
  arrived("H-0", "order me thai food");
  const got = await turn("and email jess the deck", [["memory_search"]], { ctx: { answering: { handle: "H-1", texts: 2 } } });
  assert.deepEqual(got, ["👀"]);
});

test("a text the screen did not clear gets 👀 on the thread too", async () => {
  assert.deepEqual(await turn("flights to miami", [["flight_search"]], { ctx: { harm: { verdict: "borderline" } } }), ["👀"]);
});

// ---------- the channel, the switch, the people ----------

test("a channel that cannot show any emoji keeps today's 👀 → 🔍", async () => {
  const got = await turn("my wifi keeps dropping", [["web_search"]], { before: (fake) => { fake.customReactions = false; } });
  assert.deepEqual(got, ["👀", "-👀", "🔍"]);
});

test("switch off: exactly today's 👀 → 🔍, and no topic", async () => {
  for (const v of [undefined, "off", "nonsense"]) {
    ack.reset();
    if (v === undefined) delete process.env.REASON_TAPBACK_TOPIC; else process.env.REASON_TAPBACK_TOPIC = v;
    assert.deepEqual(await turn("my wifi keeps dropping", [["web_search"]]), ["👀", "-👀", "🔍"], String(v));
    ack.reset();
    assert.deepEqual(await turn("flights to miami", [["flight_search"], ["timer_set", {}, { ok: true }]], { acted: true }), ["👀", "-👀", "🔍", "-🔍", "⏰"], String(v));
  }
});

test("'owner' covers the operator's thread and nobody else's", async () => {
  process.env.REASON_TAPBACK_TOPIC = "owner";
  assert.deepEqual(await turn("flights to miami", [["flight_search"]]), ["✈️"]);
  ack.reset();
  db.db.exec("DELETE FROM accounts;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Sam", isOperator: false });
  assert.deepEqual(await turn("flights to miami", [["flight_search"]]), ["👀", "-👀", "🔍"], "today's, for everyone else");
});

test("the topic switch alone does nothing: it rides on REASON_TAPBACK_ACK", async () => {
  process.env.REASON_TAPBACK_ACK = "off";
  assert.deepEqual(await turn("flights to miami", [["flight_search"]]), []);
});

test("a Web message and an event turn still get nothing", async () => {
  assert.deepEqual(await turn("flights to miami", [["flight_search"]], { ctx: { channel: "web" } }), []);
  ack.reset();
  assert.deepEqual(await turn("flights to miami", [["flight_search"]], { ctx: { kind: "event" } }), []);
});
