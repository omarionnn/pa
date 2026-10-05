// Inline replies — one message pinned under another, in both directions. No model, no network.
//
// The questions worth asking are mostly about what must NOT happen:
//
//   can a refused pin lose the message?                (no — it goes once more, unpinned)
//   can that second attempt ever be a second text?     (no — only after a 400, where nothing was sent)
//   can a reply be pinned under the wrong thread?      (no — the handle is looked up in one conversation)
//   does a pin outlive the turn that asked for it?     (no — it is used once, or dropped)
//   is a reply to the message right above pinned?      (no — that is just a reply)
//   does "that one" arrive without saying which one?   (no — the turn is told what it was sent under)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-replies-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const replies = await import("../src/replies.js");
const outbox = await import("../src/outbox.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const LINE = "+15122164639";
const CONV = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pending_inbound; DELETE FROM channel_limits; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM inbound_parts;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  // No waiting for the rest of a burst here: every text is its own turn unless a test says otherwise.
  config.burstQuietMs = 0;
  config.burstMaxMs = 0;
});

/**
 * A router whose turns are a function the test supplies, with the reply sent the way serve.js
 * sends it — through the router, carrying whatever the turn asked for it to be pinned under.
 */
function harness({ turn = async () => "ok", channel = {} } = {}) {
  const turns = [];
  const logs = [];
  let router;
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (t) => { turns.push(t); return await turn(t, { tool: (name, input) => runTool(name, input, { conversationId: t.conversationId, channels: router }) }); },
  });
  router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: LINE, ...channel }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel: name, replyTo }) => {
    await router.send({ channel: name, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  return { runtime, router, fake, turns, logs, tool: (name, input) => runTool(name, input, { conversationId: CONV, channels: router }) };
}

let n = 0;
const inbound = (over = {}) => ({
  channel: "fake", externalId: `e-${++n}`, from: OWNER, text: "hey",
  chatId: null, service: "iMessage", at: clock.now(), ...over,
});

/** Three texts from them, a moment apart, each answered — a thread with some history in it. */
async function history(router) {
  for (const [externalId, text] of [["H-table", "can u find a table for 4 on friday"], ["H-gift", "also what should i get kofi for his birthday"], ["H-rain", "is it gonna rain tmrw"]]) {
    clock.skip(60_000);
    await router.deliver(inbound({ externalId, text }));
  }
}

const sendblue = (fetchImpl) => {
  const saved = { id: config.sendblueKeyId, key: config.sendblueSecretKey, from: config.sendblueFrom, secret: config.sendblueWebhookSecret };
  config.sendblueKeyId = "k"; config.sendblueSecretKey = "s"; config.sendblueFrom = LINE; config.sendblueWebhookSecret = "w";
  const restore = () => {
    config.sendblueKeyId = saved.id; config.sendblueSecretKey = saved.key;
    config.sendblueFrom = saved.from; config.sendblueWebhookSecret = saved.secret;
  };
  return { ch: new SendblueChannel({ fetchImpl }), restore };
};
const answer = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) });

// ---------- Sendblue: the request the docs document ----------

test("a pinned send is an ordinary send with reply_to on it, exactly as the docs show", async () => {
  const calls = [];
  const { ch, restore } = sendblue(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return answer(200, { status: "QUEUED", message_handle: "m-new", reply_to: { message_handle: "H-table", part_index: 0 }, thread_originator: { message_handle: "H-table" } });
  });
  try {
    const out = await ch.send({ to: OWNER, text: "got u a 7:30 at lucali", replyTo: "H-table" });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/send-message$/);
    assert.deepEqual(calls[0].body.reply_to, { message_handle: "H-table" }, "only the handle — part_index and thread_originator are response fields");
    assert.equal(calls[0].body.content, "got u a 7:30 at lucali");
    assert.equal(out.delivered.reply_to, "H-table", "what it ended up under, read from Sendblue's answer");
    assert.equal(out.delivered.reply_dropped, undefined);
  } finally { restore(); }
});

test("an ordinary send carries no reply_to at all", async () => {
  const calls = [];
  const { ch, restore } = sendblue(async (url, init) => { calls.push(JSON.parse(init.body)); return answer(200, { status: "QUEUED", message_handle: "m1" }); });
  try {
    const out = await ch.send({ to: OWNER, text: "hi" });
    assert.equal("reply_to" in calls[0], false);
    assert.equal(out.delivered.reply_to, null);
  } finally { restore(); }
});

test("a refused pin does not lose the message: it goes once more, unpinned", async () => {
  // "A rejected reply is not sent as a standalone message ... Handle the returned 400 response as
  // a validation failure." So after a 400 nothing has gone, and sending it plain is safe.
  const calls = [];
  const { ch, restore } = sendblue(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return body.reply_to
      ? answer(400, { status: "ERROR", message: "reply target is not in a replyable state" })
      : answer(200, { status: "QUEUED", message_handle: "m2" });
  });
  try {
    const out = await ch.send({ to: OWNER, text: "got u a 7:30 at lucali", replyTo: "H-gone" });
    assert.equal(out.ok, true, "the message arrived");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].reply_to, { message_handle: "H-gone" });
    assert.equal("reply_to" in calls[1], false, "the second attempt is the same message with no pin");
    assert.equal(calls[1].content, "got u a 7:30 at lucali");
    assert.equal(out.delivered.reply_to, null);
    assert.match(out.delivered.reply_dropped, /not in a replyable state/);
  } finally { restore(); }
});

test("only a 400 is answered that way — a timeout or a 5xx is never sent twice", async () => {
  // After a 400 nothing was sent. After anything else that is not known, and a second POST could
  // be a second text on somebody's phone.
  for (const fail of [async () => answer(500, { message: "internal" }), async () => { throw new Error("socket hang up"); }]) {
    let count = 0;
    const { ch, restore } = sendblue(async () => { count++; return await fail(); });
    try {
      const out = await ch.send({ to: OWNER, text: "hi", replyTo: "H-table" });
      assert.equal(out.ok, false);
      assert.equal(count, 1, "one request, and the outbox decides what happens next");
    } finally { restore(); }
  }
});

test("when the pin was not the problem, the real refusal is what comes back", async () => {
  let count = 0;
  const { ch, restore } = sendblue(async () => { count++; return answer(400, { status: "DECLINED", error_key: "OPTED_OUT", error_code: 4000, message: "recipient opted out" }); });
  try {
    const out = await ch.send({ to: FRIEND, text: "hi", replyTo: "H-table" });
    assert.equal(out.ok, false);
    assert.equal(count, 2);
    assert.equal(out.error_key, "OPTED_OUT");
  } finally { restore(); }
});

test("a message THEY sent as an inline reply says which message it was under", async () => {
  const { ch, restore } = sendblue(async () => answer(200, {}));
  const body = (over) => JSON.stringify({
    content: "that one", is_outbound: false, status: "RECEIVED", message_handle: "H-new",
    number: OWNER, from_number: OWNER, to_number: LINE, group_id: "", media_url: "", service: "iMessage", ...over,
  });
  try {
    const under = await ch.receive({ rawBody: body({ reply_to: { message_handle: "M-OURS", part_index: 0 }, thread_originator: { message_handle: "M-FIRST" } }), headers: { "sb-signing-secret": "w" } });
    assert.equal(under.inbound[0].replyTo, "M-OURS", "the immediate parent, not the start of the thread");
    assert.equal(under.inbound[0].text, "that one", "the adapter adds nothing — it does not know what M-OURS said");

    const plain = await ch.receive({ rawBody: body({}), headers: { "sb-signing-secret": "w" } });
    assert.equal(plain.inbound[0].replyTo, null);
  } finally { restore(); }
});

// ---------- inbound: the turn is told what it was sent under ----------

test("a reply under one of Reason's messages reaches the turn with that message quoted", async () => {
  const { router, turns, fake } = harness({ turn: async ({ text }) => (text.includes("lucali") ? null : "lucali at 7:30 or rubirosa at 8?") });
  await router.deliver(inbound({ externalId: "H-1", text: "find me a table friday" }));
  const ours = fake.sent[0].message_id;

  clock.skip(600_000);
  await router.deliver(inbound({ externalId: "H-2", text: "is it gonna rain" }));
  await router.deliver(inbound({ externalId: "H-3", text: "the first one", replyTo: ours }));

  const last = turns.at(-1).text;
  assert.match(last, /^\[they sent this as an inline reply to your message: "lucali at 7:30 or rubirosa at 8\?"/);
  assert.match(last, /\nthe first one$/, "their own words are still there, after the note");
});

test("a reply under their OWN earlier message says so, and quotes it", async () => {
  const { router, turns } = harness();
  await router.deliver(inbound({ externalId: "H-1", text: "find me a table friday" }));
  await router.deliver(inbound({ externalId: "H-2", text: "is it gonna rain" }));
  await router.deliver(inbound({ externalId: "H-3", text: "make it saturday actually", replyTo: "H-1" }));
  assert.match(turns.at(-1).text, /^\[they sent this as an inline reply to their own earlier message: "find me a table friday"/);
});

test("a reply under a message there is no record of says exactly that, and guesses nothing", async () => {
  const { router, turns } = harness();
  await router.deliver(inbound({ externalId: "H-1", text: "that one", replyTo: "NEVER-SEEN" }));
  assert.match(turns[0].text, /^\[they sent this as an inline reply to an earlier message, and there is no record of which one/);
  assert.match(turns[0].text, /ask\]\nthat one$/);
});

test("a handle from somebody else's thread is no record at all", async () => {
  const { router, turns } = harness();
  db.claimInbound({ channel: "fake", externalId: "THEIRS", conversationId: "dm:fake:+14155559876", text: "my card number is 4242" });
  await router.deliver(inbound({ externalId: "H-1", text: "what about this", replyTo: "THEIRS" }));
  assert.doesNotMatch(turns[0].text, /4242/, "nothing from another conversation is ever quoted");
  assert.match(turns[0].text, /no record of which one/);
});

test("a handle matches whatever case it comes back in", () => {
  db.claimInbound({ channel: "fake", externalId: "99DCC379-DD76", conversationId: CONV, text: "find me a table" });
  assert.match(replies.inboundReplyLine(CONV, "99dcc379-dd76"), /their own earlier message: "find me a table"/);
});

test("an ordinary message gets no note at all", async () => {
  const { router, turns } = harness();
  await router.deliver(inbound({ text: "hey" }));
  assert.equal(turns[0].text, "hey");
});

// ---------- outbound: the reply_to tool ----------

test("reply_to pins this turn's reply under the message it quoted, and only that reply", async () => {
  let ask = false;
  const { router, fake } = harness({
    turn: async (_t, { tool }) => {
      if (!ask) return "ok";
      const r = await tool("reply_to", { quote: "table for 4" });
      assert.equal(r.ok, true);
      assert.deepEqual(r.under, { from: "them", said: "can u find a table for 4 on friday" });
      return "got u 7:30 at lucali";
    },
  });
  await history(router);
  ask = true;
  await router.deliver(inbound({ externalId: "H-now", text: "any luck" }));
  ask = false;

  const pinned = fake.sent.at(-1);
  assert.equal(pinned.text, "got u 7:30 at lucali");
  assert.equal(pinned.reply_to, "H-table", "under the message about the table, three messages back");
  assert.equal(db.getThread(CONV).reply_target, null, "and the pointer is spent");

  // The next turn's reply is an ordinary one.
  await router.deliver(inbound({ externalId: "H-after", text: "ty" }));
  assert.equal(fake.sent.at(-1).reply_to, undefined);
  assert.equal(fake.attempts.at(-1).replyTo, null);
});

test("the pin is on the outbox row, so a reply retried later is still pinned", async () => {
  const { router, fake, tool } = harness({ channel: { failTimes: 1 } });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
  const first = await router.send({ channel: "fake", to: OWNER, text: "got u 7:30", conversationId: CONV, toOwner: true, replyTo: "H-table" });
  assert.equal(first.queued, true, "the first attempt failed at something that can work later");
  assert.equal(db.getOutbound(first.outbox_id).reply_to, "H-table");

  const again = await outbox.attempt({ id: first.outbox_id, router });
  assert.equal(again.ok, true);
  assert.equal(fake.sent.at(-1).reply_to, "H-table");
  void tool;
});

test("one of Reason's own messages can be replied under too", async () => {
  const { router, fake, tool } = harness({ turn: async ({ text }) => (text.includes("table") ? "on it, checking lucali" : "ok") });
  await router.deliver(inbound({ externalId: "H-1", text: "find me a table friday" }));
  const ours = fake.sent[0].message_id;
  await router.deliver(inbound({ externalId: "H-2", text: "is it gonna rain" }));

  const r = await tool("reply_to", { quote: "checking lucali" });
  assert.equal(r.ok, true);
  assert.equal(r.under.from, "you");
  assert.equal(db.getThread(CONV).reply_target, ours);
});

test("a reply to the message right above is just a reply, and nothing is pinned", async () => {
  const { router, tool } = harness({ turn: async () => null });
  await history(router);
  const r = await tool("reply_to", { quote: "gonna rain" });
  assert.equal(r.ok, false);
  assert.match(r.error, /last message in the thread/);
  assert.match(r.error, /just answer/);
  assert.equal(db.getThread(CONV).reply_target, null);
});

test("in a burst, the earlier text can be pinned and the last one cannot", async () => {
  // Two texts held as one turn: both have handles, and "the last one" is the second.
  const { router, tool } = harness({ turn: async () => null });
  await router.deliver(inbound({ externalId: "B-1", text: "whats the address for sat" }));
  await router.deliver(inbound({ externalId: "B-2", text: "and did the handyman reply" }));
  assert.equal((await tool("reply_to", { quote: "handyman" })).ok, false);
  const first = await tool("reply_to", { quote: "address for sat" });
  assert.equal(first.ok, true);
  assert.equal(db.getThread(CONV).reply_target, "B-1");
});

test("words that are in no message pin nothing, and say so", async () => {
  const { router, tool } = harness({ turn: async () => null });
  await history(router);
  const none = await tool("reply_to", { quote: "the dentist appointment" });
  assert.equal(none.ok, false);
  assert.match(none.error, /no message in this thread has the words/);
  assert.match(none.error, /normal message/);

  const short = await tool("reply_to", { quote: "ok" });
  assert.equal(short.ok, false);
  assert.match(short.error, /too short/);
  assert.equal(db.getThread(CONV).reply_target, null);
});

test("when the same words were said twice, the nearer one is used and named", async () => {
  const { router, tool } = harness({ turn: async () => null });
  await router.deliver(inbound({ externalId: "D-1", text: "book the usual place" }));
  await router.deliver(inbound({ externalId: "D-2", text: "book the usual place for 6 not 4" }));
  await router.deliver(inbound({ externalId: "D-3", text: "u there" }));
  const r = await tool("reply_to", { quote: "Book the  usual place" });
  assert.equal(r.ok, true, "case and spacing do not matter");
  assert.equal(r.under.said, "book the usual place for 6 not 4");
  assert.equal(db.getThread(CONV).reply_target, "D-2");
});

test("a pin can only point inside this conversation", async () => {
  const { router, tool } = harness({ turn: async () => null });
  await history(router);
  db.claimInbound({ channel: "fake", externalId: "THEIRS", conversationId: "dm:fake:+14155559876", text: "meet me at the pier at nine" });
  const r = await tool("reply_to", { quote: "meet me at the pier" });
  assert.equal(r.ok, false);
  assert.equal(db.getThread(CONV).reply_target, null);
});

test("an SMS thread is told to use words, and nothing is pinned", async () => {
  const { router, tool } = harness({ turn: async () => null });
  await history(router);
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "SMS" });
  const r = await tool("reply_to", { quote: "table for 4" });
  assert.equal(r.ok, false);
  assert.equal(r.supported, false);
  assert.match(r.error, /SMS, and inline replies are iMessage only/);
  assert.match(r.error, /normal message/);
});

test("a channel that cannot pin says so, and is never handed a handle", async () => {
  const { router, fake, tool } = harness({ turn: async () => null, channel: { inlineReplies: false } });
  await history(router);
  const r = await tool("reply_to", { quote: "table for 4" });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot pin a reply/);

  // Even if a handle reaches the router some other way, it stops there.
  await router.send({ channel: "fake", to: OWNER, text: "hi", conversationId: CONV, toOwner: true, replyTo: "H-table" });
  assert.equal(fake.attempts.at(-1).replyTo, null);
  assert.equal(fake.sent.at(-1).text, "hi", "and the message still went");
});

test("with no texting thread at all, reply_to says there is nothing to reply inside", async () => {
  const r = await runTool("reply_to", { quote: "table for 4" }, { conversationId: CONV, channels: null });
  assert.equal(r.ok, false);
  assert.equal(r.status, "not_connected");
});

test("a pin the turn never used does not land on the next turn's reply", async () => {
  let mode = "pin-then-silent";
  const { router, fake } = harness({
    turn: async (_t, { tool }) => {
      if (mode === "pin-then-silent") { assert.equal((await tool("reply_to", { quote: "table for 4" })).ok, true); return null; }
      return "ok";
    },
  });
  mode = "plain";
  await history(router);
  mode = "pin-then-silent";
  await router.deliver(inbound({ externalId: "H-x", text: "nvm" }));
  assert.equal(db.getThread(CONV).reply_target, null, "taken when the turn ended, though nothing was sent");

  mode = "plain";
  await router.deliver(inbound({ externalId: "H-y", text: "hello" }));
  assert.equal(fake.attempts.at(-1).replyTo, null);
});

test("message_send to them uses the pin, so the reply after it is not pinned twice", async () => {
  let go = false;
  const { router, fake } = harness({
    turn: async (_t, { tool }) => {
      if (!go) return "ok";
      await tool("reply_to", { quote: "kofi for his birthday" });
      const sent = await tool("message_send", { to: "owner", text: "he said he wants the jordans" });
      assert.equal(sent.ok, true);
      return "want me to find them in his size?";
    },
  });
  await history(router);
  go = true;
  await router.deliver(inbound({ externalId: "H-now", text: "any ideas yet" }));

  const [pinned, after_] = fake.sent.slice(-2);
  assert.equal(pinned.text, "he said he wants the jordans");
  assert.equal(pinned.reply_to, "H-gift");
  assert.equal(after_.text, "want me to find them in his size?");
  assert.equal(after_.reply_to, undefined, "one pin, one message");
});

test("a text to somebody else never takes the pin", async () => {
  const { router, tool } = harness({ turn: async () => null });
  await history(router);
  await tool("reply_to", { quote: "table for 4" });
  // Refused by the gate (no confirmation), which is the point: it never got as far as the pin.
  await tool("message_send", { to: FRIEND, text: "hi" });
  assert.equal(db.getThread(CONV).reply_target, "H-table", "still there for the reply to the person who asked");
});

test("when the pin is refused on the way out, the reply still arrives", async () => {
  let go = false;
  const { router, fake, logs } = harness({
    channel: { replyAs: "rejected" },
    turn: async (_t, { tool }) => { if (go) await tool("reply_to", { quote: "table for 4" }); return go ? "got u 7:30 at lucali" : "ok"; },
  });
  await history(router);
  go = true;
  await router.deliver(inbound({ externalId: "H-now", text: "any luck" }));
  assert.equal(fake.sent.at(-1).text, "got u 7:30 at lucali");
  assert.equal(fake.sent.at(-1).reply_to, undefined);
  assert.ok(logs.some(l => l.reply_dropped), "and the log says the pin was dropped");
});

// ---------- capabilities ----------

test("capabilities tells the truth about inline replies, per thread", async () => {
  const { router } = harness();
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
  const live = capabilitiesNow({ channels: router, conversationId: CONV }).find(c => c.name === "inline_replies");
  assert.equal(live.status, "live");
  assert.match(live.what, /never for an ordinary reply/);

  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "SMS" });
  const sms = capabilitiesNow({ channels: router, conversationId: CONV }).find(c => c.name === "inline_replies");
  assert.equal(sms.status, "not connected");
  assert.match(sms.what, /This thread is SMS/);

  const none = capabilitiesNow({ channels: null, conversationId: CONV }).find(c => c.name === "inline_replies");
  assert.equal(none.status, "not connected");
});
