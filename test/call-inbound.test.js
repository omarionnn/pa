// Somebody rings the number: who gets answered, who gets one line, and what is said first.
//
// This is the webhook that runs DURING THE RING, so what it must not do is as important as what it
// does: no model turn anywhere in it, and nothing that waits on a channel. Everything it sends —
// the master's question, the once-ever recording note — is queued as a database row and picked up by
// the outbox pass well inside the call.
//
// The policy being pinned is the one a TEXT from a stranger already gets, because it is the same
// policy and mostly the same code: a number nobody approved costs the operator nothing, and ringing
// the number instead of texting it does not grant anybody an invitation.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-inbound-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.ELEVENLABS_API_KEY = "eleven-test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ELEVENLABS_LLM_SECRET = "llm-test-secret";
process.env.ELEVENLABS_WEBHOOK_SECRET = "hook-test-secret";
process.env.ELEVENLABS_VOICE_ID = "voice_test";
process.env.REASON_UNDO_SECONDS = "0";

const { inboundRequest, whoseCallIsThis, openingLineFor, recordingNoteFor, INBOUND_PATH } = await import("../src/calls/inbound.js");
const { ElevenLabsCallProvider } = await import("../src/calls/elevenlabs.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const FRIEND = "+12125551111";
const STRANGER = "+13475559999";

/** A router with one live texting channel, so the master can be reached. */
const router = {
  get: (name) => (name === "sendblue" ? { status: () => ({ status: "live" }) } : null),
  statuses: () => [{ name: "sendblue", status: "live" }, { name: "console", status: "live" }],
};
const noRouter = { get: () => null, statuses: () => [] };

const provider = () => new ElevenLabsCallProvider();

const ring = (over = {}, opts = {}) => inboundRequest({
  rawBody: JSON.stringify({
    caller_id: OWNER, agent_id: "agent_test", called_number: "+16465550000",
    call_sid: "CA1", conversation_id: "conv_ring", ...over,
  }),
  provider: provider(), router, ...opts,
});

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM blocked_numbers; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM turned_away;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: OWNER, name: "Omari", isOperator: true });
});

const outbox = () => db.db.prepare("SELECT * FROM outbox ORDER BY id").all();

/** The newest INBOUND call row. Picked by direction and id, because the outbound call it is a reply to
 *  was created in the same millisecond and `listCalls` orders by time. */
const lastInbound = () => db.db.prepare("SELECT * FROM calls WHERE direction = 'in' ORDER BY id DESC LIMIT 1").get();

// ---------- the route only exists when it really works ----------

test("a provider that is not this one, or cannot answer a phone, has no route here", () => {
  assert.equal(inboundRequest({ rawBody: "{}", provider: null }).status, 404);
  assert.equal(inboundRequest({ rawBody: "{}", provider: { status: () => ({ name: "bland", status: "live" }) } }).status, 404);

  // Set up to RING a phone but not to answer one. The honest answer is that this is not set up,
  // which is better than a call answered by half a Reason.
  const half = inboundRequest({ rawBody: "{}", provider: new ElevenLabsCallProvider({ webhookSecret: "" }), router });
  assert.equal(half.status, 503);
  assert.match(half.body.error, /ELEVENLABS_WEBHOOK_SECRET/);

  assert.equal(ring({ conversation_id: "" }).status, 400);
  assert.equal(inboundRequest({ rawBody: "{", provider: provider(), router }).status, 400);
  assert.equal(INBOUND_PATH, "/calls/elevenlabs/inbound");
});

// ---------- a number Reason knows ----------

test("while the phone is still ringing, the call's prompt is sent ahead to warm the model's cache", () => {
  // The first turn of a call used to pay a cold read of ~120k tokens of prefix (every tool plus the
  // system prompt) before its first word. The ring is the time to pay it, and this is the hook that
  // does: asked for with the row that was just written, and never awaited — a webhook that runs
  // during the ring must answer at once.
  const asked = [];
  const out = ring({}, { warm: (args) => { asked.push(args); return Promise.resolve({ warmed: true }); } });
  assert.equal(out.status, 200);
  assert.equal(asked.length, 1, "asked for exactly once");
  const row = db.listCalls(C)[0];
  assert.equal(asked[0].call.id, row.id, "with the call that was just created");
  assert.equal(asked[0].call.is_owner, 1);

  // Nobody Reason knows gets one line and a hang-up, and no model is spent on them — including this.
  asked.length = 0;
  assert.equal(ring({ caller_id: STRANGER }, { warm: (args) => { asked.push(args); return Promise.resolve({ warmed: true }); } }).status, 200);
  assert.equal(asked.length, 0, "a stranger's call warms nothing");
});

test("the operator's own number reaches their own Reason, whatever they ring from", () => {
  const out = ring();
  assert.equal(out.status, 200);
  assert.equal(out.body.type, "conversation_initiation_client_data");
  assert.equal(out.body.dynamic_variables.owner_name, "Omari");
  assert.equal(out.body.dynamic_variables.reason_kind, "owner");
  assert.equal(out.body.dynamic_variables.reason_conversation_id, C);
  // One pinned voice.
  assert.equal(out.body.conversation_config_override.tts.voice_id, "voice_test");

  // On the record before a word is said, with the platform's id on it so the custom-LLM endpoint
  // can find the call at all — there is nothing of Reason's in an inbound turn's body to go on.
  const row = db.listCalls(C)[0];
  assert.equal(row.direction, "in");
  assert.equal(row.external_id, "conv_ring");
  assert.equal(row.is_owner, 1);
  assert.equal(row.state, "in_progress");
  assert.equal(row.provider, "elevenlabs");
  assert.deepEqual(row.facts, [], "an inbound call shares nothing with anybody");
  // The disclosure is NOT recited at the person who set this up.
  assert.equal(row.announcement, "");
  assert.equal(out.body.dynamic_variables.reason_call_id, row.id);
});

test("a call joins the conversation that number already texts, not a second empty one", () => {
  // The bug this exists to prevent: a conversation id has the channel in it, so admitting a caller
  // on a channel called "elevenlabs" would hand them a second Reason with no memory and no open
  // jobs, and the text ten minutes later would land somewhere else.
  db.upsertAccount({ conversationId: "dm:sendblue:+12125551111", channel: "sendblue", address: FRIEND, name: "Kofi" });
  const who = whoseCallIsThis(FRIEND);
  assert.equal(who.allow, true);
  assert.equal(who.conversationId, "dm:sendblue:+12125551111");

  const out = ring({ caller_id: FRIEND });
  assert.equal(out.body.dynamic_variables.reason_conversation_id, "dm:sendblue:+12125551111");
  assert.equal(out.body.dynamic_variables.owner_name, "Kofi");
  assert.equal(db.listCalls("dm:sendblue:+12125551111").length, 1);
  assert.equal(db.listCalls("dm:elevenlabs:+12125551111").length, 0);
});

test("the opening line is a clean greeting, never a context dump", async () => {
  const { runTool } = await import("../src/tools.js");
  await runTool("task_start", { title: "book Carbone for Saturday", goal: "a table for four" }, { conversationId: C, messages: [] });

  const line = openingLineFor({ person: { name: "Omari" }, conversationId: C });
  assert.match(line, /hey Omari — what's up\?$/);
  // The lead-in ("ah," / "hey —" …) is drawn at random on every call, so the ring's own opener is
  // the same greeting, not the same bytes as a second draw.
  assert.match(ring().body.conversation_config_override.agent.first_message, /hey Omari — what's up\?$/);

  db.db.exec("DELETE FROM tasks");
  assert.match(openingLineFor({ person: { name: "Omari" }, conversationId: C }), /hey Omari — what's up\?$/);
});

test("the greeting never mentions open tasks, no matter how fresh", async () => {
  const { runTool } = await import("../src/tools.js");
  await runTool("task_start", { title: "book the dentist", goal: "a slot" }, { conversationId: C, messages: [] });
  assert.match(openingLineFor({ person: { name: "Omari" }, conversationId: C }), /hey Omari — what's up\?$/);
});

test("the recording note goes out once, ever, and never recites itself on the call", () => {
  const first = ring();
  assert.equal(first.body.conversation_config_override.agent.first_message.includes("recorded"), false);
  const queued = outbox();
  assert.equal(queued.length, 1);
  assert.match(queued[0].body, /every call is recorded/);
  assert.match(queued[0].body, /just telling u once/);
  assert.equal(queued[0].address, OWNER);

  // Rings again: nothing more is said about it. A disclosure said once is a disclosure; said on
  // every call it is a nag.
  ring({ conversation_id: "conv_ring_2" });
  assert.equal(outbox().length, 1);
  assert.ok(db.getAccount(C).told_calls_recorded_at > 0);
});

test("with nowhere to text, the note is not marked as told — so the next call still tells them", () => {
  db.db.exec("DELETE FROM accounts");
  db.upsertAccount({ conversationId: C, channel: "console", address: "console", name: "Omari", isOperator: true });
  const row = db.createCall(C, { provider: "elevenlabs", toNumber: OWNER, isOwner: true, goal: "x", facts: [], direction: "in" });
  const r = recordingNoteFor({ conversationId: C, row });
  assert.equal(r.queued, false);
  assert.match(r.why, /no texting channel/);
  assert.equal(db.getAccount(C).told_calls_recorded_at, null, "they still have not been told");
});

// ---------- a number nobody approved ----------

test("a stranger gets one line, the call ends, and no turn is ever run for them", () => {
  const out = ring({ caller_id: STRANGER });
  assert.equal(out.status, 200);
  const agent = out.body.conversation_config_override.agent;
  assert.match(agent.first_message, /AI assistant for Omari/);
  assert.match(agent.first_message, /not set up to take calls from this number/);
  // The prompt is replaced AND end_call is the only tool. The prompt override is the half that
  // matters: an allowed end_call on a full Reason would be a stranger talking to a full Reason.
  assert.match(agent.prompt.prompt, /call the end_call tool immediately/);
  assert.deepEqual(agent.prompt.tools, [{ type: "system", name: "end_call" }]);
  assert.equal(out.body.dynamic_variables.reason_kind, "stranger");

  // Nothing of theirs exists: no account, no call row, no conversation.
  assert.equal(db.accountByNumber(STRANGER), null);
  assert.equal(db.listCalls("dm:elevenlabs:+13475559999").length, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 0);
});

test("the master is asked about them, queued rather than sent, on the texting channel", () => {
  ring({ caller_id: STRANGER });
  const queued = outbox();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].conversation_id, C);
  // The channel their new Reason would be set up on, not "elevenlabs" — approving somebody onto the
  // call provider's name would set up an account Reason cannot send a text to.
  assert.equal(queued[0].channel, "sendblue");
  assert.match(queued[0].body, /\+13475559999/);
  const request = db.db.prepare("SELECT * FROM access_requests WHERE address = ?").get(STRANGER);
  assert.equal(request.channel, "sendblue");
  // What the master sees of them, quoted. A call has no words, and inventing a sentence for a
  // stranger would be putting words in somebody's mouth.
  assert.match(request.first_message, /called your number instead of texting it/);
});

test("the same stranger ringing six times troubles the master once", () => {
  ring({ caller_id: STRANGER });
  ring({ caller_id: STRANGER, conversation_id: "c2" });
  ring({ caller_id: STRANGER, conversation_id: "c3" });
  assert.equal(outbox().length, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 1);
});

test("a withheld number is a stranger, and nothing is written down about nobody", () => {
  const out = ring({ caller_id: "" });
  assert.equal(out.status, 200);
  assert.match(out.body.conversation_config_override.agent.first_message, /not set up to take calls/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 0);
  assert.equal(outbox().length, 0);
});

test("with no line to text on, the stranger still gets their line and no request is written", () => {
  // Nowhere to ask the master and nowhere to answer this person if the answer were yes. A request
  // nobody can act on is worse than none.
  const out = inboundRequest({
    rawBody: JSON.stringify({ caller_id: STRANGER, conversation_id: "conv_x" }),
    provider: provider(), router: noRouter,
  });
  assert.equal(out.status, 200);
  assert.match(out.body.conversation_config_override.agent.first_message, /not set up to take calls/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 0);
});

test("a blocked number gets the stranger line and nothing else at all", () => {
  db.blockNumber(STRANGER, "they kept ringing");
  const out = ring({ caller_id: STRANGER });
  assert.match(out.body.conversation_config_override.agent.first_message, /not set up to take calls/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 0);
  assert.equal(outbox().length, 0);
  assert.equal(whoseCallIsThis(STRANGER).reason, "blocked");
});

test("a paused account is told once, in their own words, and then left alone", () => {
  db.upsertAccount({ conversationId: "dm:sendblue:+12125551111", channel: "sendblue", address: FRIEND, name: "Kofi" });
  db.setAccountState("dm:sendblue:+12125551111", "paused");
  assert.equal(whoseCallIsThis(FRIEND).reason, "paused");

  const first = ring({ caller_id: FRIEND });
  assert.match(first.body.conversation_config_override.agent.first_message, /paused this for now/);
  assert.match(first.body.conversation_config_override.agent.first_message, /nothing of yours is gone/);
  // Repeating it on every call turns Reason into the thing making unsolicited calls.
  const again = ring({ caller_id: FRIEND, conversation_id: "c2" });
  assert.match(again.body.conversation_config_override.agent.first_message, /not set up to take calls/);
  // And no call row for either: nothing was answered.
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 0);
});

// ---------- what it costs ----------

test("the day's call cap counts a call that came IN, and refuses past it", () => {
  // A cap that only applies to calls Reason places is a cap somebody can get round by dialling in.
  const was = config.maxCallsPerDay;
  try {
    config.maxCallsPerDay = 2;
    assert.equal(ring().status, 200);
    assert.equal(ring({ conversation_id: "c2" }).status, 200);
    const third = ring({ conversation_id: "c3" });
    assert.equal(third.status, 200);
    assert.match(third.body.conversation_config_override.agent.first_message, /that's 2 calls today/);
    assert.match(third.body.conversation_config_override.agent.first_message, /text me instead/);
    assert.equal(third.body.dynamic_variables.reason_why, "daily_call_cap");
    // The refused one is not written down as a call and does not use up another of their day.
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 2);
    assert.equal(db.usageToday(C, require_today()).calls, 2);
  } finally {
    config.maxCallsPerDay = was;
  }
});

test("the minutes cap counts a call that came in too", () => {
  const was = config.maxCallMinutesPerDay;
  try {
    config.maxCallMinutesPerDay = 5;
    db.bumpUsage(C, require_today(), "call_seconds", 6 * 60);
    const out = ring();
    assert.match(out.body.conversation_config_override.agent.first_message, /6 minutes of calls today/);
    assert.equal(out.body.dynamic_variables.reason_why, "daily_call_minutes_cap");
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 0);
  } finally {
    config.maxCallMinutesPerDay = was;
  }
});

/** The day a cap is counted against, in the operator's timezone — same as src/accounts.js. */
function require_today() {
  return new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: config.tz });
}

// ---------- a place ringing back ----------

const RESTAURANT = "+12125558888";

/** A call Reason made to a place, left in the state the given outcome describes. */
const calledThem = (over = {}) => {
  const row = db.createCall(C, {
    provider: "elevenlabs", toNumber: RESTAURANT, isOwner: false,
    goal: "ask if they can do a table for eight on Saturday",
    facts: ["the name is Omari", "eight people"], announcement: "x", externalId: "conv_out_1",
  });
  db.updateCall(C, row.id, { state: "completed", outcome_kind: "answered", ...over });
  return db.getCall(C, row.id);
};

test("a place Reason called is not a stranger when it rings back — it rejoins its own errand", () => {
  const e = db.createErrand(C, { goal: "a table for eight", questions: ["how much"] });
  const out = calledThem({ errand_id: e.id, brief: JSON.stringify({ goal: "ask about a table for eight", approved: { book: false } }) });

  const who = whoseCallIsThis(RESTAURANT);
  assert.equal(who.allow, true);
  assert.equal(who.callingBack, true);
  assert.equal(who.errandId, e.id);
  assert.equal(who.aboutCall.id, out.id);

  const r = ring({ caller_id: RESTAURANT, conversation_id: "conv_back" });
  assert.equal(r.status, 200);
  // A THIRD-PARTY call, never an owner one. The row the owner path would have written says
  // `isOwner: true`, and a restaurant must never get one.
  assert.equal(r.body.dynamic_variables.reason_kind, "third_party");
  const row = lastInbound();
  assert.equal(row.is_owner, 0);
  assert.equal(row.direction, "in");
  assert.equal(row.errand_id, e.id);
  // And they are told what they are talking to, because they are a person who has not been told.
  assert.match(r.body.conversation_config_override.agent.first_message, /AI assistant/);
  assert.match(r.body.conversation_config_override.agent.first_message, /recorded/);
  assert.match(r.body.conversation_config_override.agent.first_message, /calling back about/);
});

test("the returning call inherits the brief, so a call that was only asking still only asks", () => {
  calledThem({ brief: JSON.stringify({ goal: "ask about a table", approved: { book: false }, readBack: [] }) });
  ring({ caller_id: RESTAURANT, conversation_id: "conv_back" });
  assert.equal(JSON.parse(lastInbound().brief).approved.book, false);
});

test("a number nobody called is still a stranger, and the master still hears about it", () => {
  const r = ring({ caller_id: STRANGER, conversation_id: "conv_cold" });
  assert.equal(r.status, 200);
  assert.match(r.body.conversation_config_override.agent.first_message, /not set up to take calls/);
  assert.equal(db.listCalls(C).length, 0);
});

test("a call that was already settled is not reopened by a ring back", () => {
  calledThem({ outcome_kind: "confirmed" });
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false, "there is no open question to continue");
  calledThem({ outcome_kind: "refused_by_them" });
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false);
});

test("a ring back about something from last month is not that errand continuing", () => {
  calledThem({ outcome_kind: "hold_gave_up" });
  assert.equal(whoseCallIsThis(RESTAURANT).allow, true);
  clock.skip(25 * 60 * 60 * 1000);
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false, "a day later it is somebody ringing about something else");
});

test("the number a call gives out to be rung back on is the install's own", async () => {
  // Without ELEVENLABS_PHONE_NUMBER there is no usable return number, and a call that invents one
  // sends a busy place to a phone nobody answers.
  const { buildBrief } = await import("../src/calls/brief.js");
  assert.equal(buildBrief({ goal: "x" }).returnNumber, "");
  assert.equal(buildBrief({ goal: "x", returnNumber: "+16465550000" }).returnNumber, "+16465550000");
});
