// Somebody rings the number: who gets answered, who gets one line, and what is said first.
//
// This is the number's voice webhook (Twilio → /calls/gptlive/inbound, `inboundTwiml`), and it runs
// DURING THE RING, so what it must not do is as important as what it does: no model turn anywhere in
// it, and nothing that waits on a channel. Everything it sends — the master's question, the once-ever
// recording note — is queued as a database row and picked up by the outbox pass well inside the call.
//
// The policy being pinned is the one a TEXT from a stranger already gets, because it is the same
// policy and mostly the same code: a number nobody approved costs the operator nothing, and ringing
// the number instead of texting it does not grant anybody an invitation.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-inbound-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
// The daily call caps are proven here on the owner's own thread, so the operator's exemption from
// them is off (REASON_CALL_CAPS_EXEMPT; its default is proven in test/accounts.test.js).
process.env.REASON_CALL_CAPS_EXEMPT = "none";
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";

const { whoseCallIsThis, openingLineFor, recordingNoteFor, MAX_RING_BACKS = 3 } = await import("../src/calls/inbound.js");
const gl = await import("../src/calls/gptlive.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const FRIEND = "+12125551111";
const STRANGER = "+13475559999";
const NUMBER = "+16465550000";
const TWILIO = { callVoice: "gptlive", twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: NUMBER, openaiKey: "sk-test" };
const NEUTRAL = "Hi, you've reached Reason. I can't take calls from this number right now. Thanks, bye.";

/** A router with one live texting channel, so the master can be reached. */
const router = {
  get: (name) => (name === "sendblue" ? { status: () => ({ status: "live" }) } : null),
  statuses: () => [{ name: "sendblue", status: "live" }, { name: "console", status: "live" }],
};
const noRouter = { get: () => null, statuses: () => [] };

let sids = 0;
/** One ring of the number, Twilio-signed, as Twilio posts it. Returns the TwiML answer. */
const ring = (from = OWNER, { sid = `CA${++sids}`, via = router } = {}) => {
  const params = { CallSid: sid, From: from, To: NUMBER };
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  return gl.inboundTwiml({
    rawBody: new URLSearchParams(params).toString(),
    headers: { "x-twilio-signature": gl.twilioSignature(url, params) },
    router: via,
  });
};
const STREAM = /<Connect><Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\/([A-Za-z0-9_-]+)"\/><\/Connect>/;
const streamToken = (out) => out.body.match(STREAM)?.[1] ?? null;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  Object.assign(config, TWILIO);
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM blocked_numbers; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM turned_away; DELETE FROM stranger_calls;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: OWNER, name: "Omari", isOperator: true });
});

const outbox = () => db.db.prepare("SELECT * FROM outbox ORDER BY id").all();
const callCount = () => db.db.prepare("SELECT COUNT(*) n FROM calls").get().n;

/** The newest INBOUND call row. Picked by direction and id, because the outbound call it is a reply to
 *  was created in the same millisecond and `listCalls` orders by time. */
const lastInbound = () => db.db.prepare("SELECT * FROM calls WHERE direction = 'in' ORDER BY id DESC LIMIT 1").get();

// ---------- a number Reason knows ----------

test("the operator's own number reaches their own Reason, whatever they ring from", () => {
  const out = ring(OWNER, { sid: "CA_own" });
  assert.equal(out.status, 200);
  assert.equal(out.type, "text/xml");
  // On the record before a word is said, and the stream Twilio opens is that row's own.
  const row = db.listCalls(C)[0];
  assert.ok(row, "a call row on the operator's conversation");
  assert.equal(streamToken(out), row.webhook_token);
  assert.equal(row.direction, "in");
  assert.equal(row.external_id, "gptlive:CA_own");
  assert.equal(row.is_owner, 1);
  assert.equal(row.state, "in_progress");
  assert.equal(row.provider, "gptlive");
  assert.deepEqual(row.facts, [], "an inbound call shares nothing with anybody");
  // The disclosure is NOT recited at the person who set this up.
  assert.equal(row.announcement, "");
});

test("a call joins the conversation that number already texts, not a second empty one", () => {
  // The bug this exists to prevent: a conversation id has the channel in it, so admitting a caller
  // on a channel named after the call provider would hand them a second Reason with no memory and
  // no open jobs, and the text ten minutes later would land somewhere else.
  db.upsertAccount({ conversationId: "dm:sendblue:+12125551111", channel: "sendblue", address: FRIEND, name: "Kofi" });
  const who = whoseCallIsThis(FRIEND);
  assert.equal(who.allow, true);
  assert.equal(who.conversationId, "dm:sendblue:+12125551111");

  const out = ring(FRIEND);
  const rows = db.listCalls("dm:sendblue:+12125551111");
  assert.equal(rows.length, 1);
  assert.equal(streamToken(out), rows[0].webhook_token);
  assert.equal(callCount(), 1, "no second conversation anywhere");
  assert.equal(db.listCalls(C).length, 0, "nothing on the operator's");
});

test("the opening line is a clean greeting, never a context dump", async () => {
  const { runTool } = await import("../src/tools.js");
  await runTool("task_start", { title: "book Carbone for Saturday", goal: "a table for four" }, { conversationId: C, messages: [] });

  // The lead-in ("ah," / "hey —" …) is drawn at random on every call.
  assert.match(openingLineFor({ person: { name: "Omari" }, conversationId: C }), /hey Omari — what's up\?$/);
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
  assert.doesNotMatch(first.body, /recorded/, "nothing said on the line about it");
  const queued = outbox();
  assert.equal(queued.length, 1);
  assert.match(queued[0].body, /every call is recorded/);
  assert.match(queued[0].body, /just telling u once/);
  assert.equal(queued[0].address, OWNER);

  // Rings again: nothing more is said about it. A disclosure said once is a disclosure; said on
  // every call it is a nag.
  ring();
  assert.equal(outbox().length, 1);
  assert.ok(db.getAccount(C).told_calls_recorded_at > 0);
});

test("with nowhere to text, the note is not marked as told — so the next call still tells them", () => {
  db.db.exec("DELETE FROM accounts");
  db.upsertAccount({ conversationId: C, channel: "console", address: "console", name: "Omari", isOperator: true });
  const row = db.createCall(C, { provider: "gptlive", toNumber: OWNER, isOwner: true, goal: "x", facts: [], direction: "in" });
  const r = recordingNoteFor({ conversationId: C, row });
  assert.equal(r.queued, false);
  assert.match(r.why, /no texting channel/);
  assert.equal(db.getAccount(C).told_calls_recorded_at, null, "they still have not been told");
});

// ---------- a number nobody approved ----------

test("the neutral line (blocked, paused, removed) names nobody, whatever the operator is called", async () => {
  const sc = await import("../src/calls/stranger.js");
  const saved = config.ownerName;
  try {
    for (const n of ["Omari", "Ama"]) {
      config.ownerName = n;
      assert.equal(sc.neutralLine(), NEUTRAL);
    }
  } finally { config.ownerName = saved; }
});

test("an unknown caller gets the stranger's stream, kept against their number, and nobody's data", () => {
  const out = ring(STRANGER, { sid: "CA_cold" });
  assert.equal(out.status, 200);
  const token = streamToken(out);
  assert.match(token ?? "", /^[0-9a-f]{32}$/, "a stream of its own, not a call row's");
  assert.doesNotMatch(out.body, /Omari|\+12025551234|dm:owner/, "nothing about any user in what Twilio is handed");

  // Nothing of theirs exists: no account, no call row, no conversation. Only their stranger_calls entry.
  assert.equal(db.accountByNumber(STRANGER), null);
  assert.equal(callCount(), 0);
  const kept = db.db.prepare("SELECT * FROM stranger_calls").all();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].phone, STRANGER);
  assert.equal(kept[0].external_id, "gptlive:CA_cold");
});

test("the master is asked about them, queued rather than sent, on the texting channel", () => {
  ring(STRANGER);
  const queued = outbox();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].conversation_id, C);
  // The channel their new Reason would be set up on, not the call provider's name — approving
  // somebody onto that would set up an account Reason cannot send a text to.
  assert.equal(queued[0].channel, "sendblue");
  assert.match(queued[0].body, /\+13475559999/);
  const request = db.db.prepare("SELECT * FROM access_requests WHERE address = ?").get(STRANGER);
  assert.equal(request.channel, "sendblue");
  // What the master sees of them, quoted. A call has no words, and inventing a sentence for a
  // stranger would be putting words in somebody's mouth.
  assert.match(request.first_message, /called your number instead of texting it/);
});

test("the same stranger ringing six times troubles the master once", () => {
  for (let i = 0; i < 6; i++) assert.ok(streamToken(ring(STRANGER)));
  assert.equal(outbox().length, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 1);
});

test("a withheld number is a stranger, and nothing is written down about nobody", () => {
  for (const from of ["", "anonymous"]) {
    const out = ring(from);
    assert.equal(out.status, 200);
    assert.ok(streamToken(out), "the stranger's stream");
  }
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 0);
  assert.equal(outbox().length, 0);
  assert.equal(callCount(), 0);
  // Their row (for the recording they are told about) carries no number, so it matches nobody, ever.
  assert.deepEqual(db.db.prepare("SELECT DISTINCT phone FROM stranger_calls").all().map(r => r.phone), [""]);
});

test("with no line to text on, the stranger still gets their stream and no request is written", () => {
  // Nowhere to ask the master and nowhere to answer this person if the answer were yes. A request
  // nobody can act on is worse than none.
  const out = ring(STRANGER, { via: noRouter });
  assert.equal(out.status, 200);
  assert.ok(streamToken(out));
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 0);
  assert.equal(outbox().length, 0);
});

const saysNeutral = (body) => body.includes(`>${NEUTRAL}</Say><Hangup/>`);

test("a blocked number gets the neutral line, no pitch, and nothing else at all", () => {
  db.blockNumber(STRANGER, "they kept ringing");
  const out = ring(STRANGER);
  assert.equal(out.status, 200);
  assert.ok(saysNeutral(out.body), out.body);
  assert.doesNotMatch(out.body, /<Stream/, "no pitch: Twilio says it and hangs up");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM access_requests").get().n, 0);
  assert.equal(outbox().length, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stranger_calls").get().n, 0);
  assert.equal(whoseCallIsThis(STRANGER).reason, "blocked");
});

test("a paused or removed account gets the neutral line every time: no pitch, no operator name", () => {
  db.upsertAccount({ conversationId: "dm:sendblue:+12125551111", channel: "sendblue", address: FRIEND, name: "Kofi" });
  for (const state of ["paused", "removed"]) {
    db.setAccountState("dm:sendblue:+12125551111", state);
    assert.equal(whoseCallIsThis(FRIEND).reason, state);
    for (let i = 0; i < 2; i++) {
      const out = ring(FRIEND);
      assert.ok(saysNeutral(out.body), out.body);
      assert.doesNotMatch(out.body, /Omari|Kofi|<Stream/);
    }
  }
  assert.equal(callCount(), 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stranger_calls").get().n, 0);
});

// ---------- what it costs ----------

test("the day's call cap counts a call that came IN, and refuses past it", () => {
  // A cap that only applies to calls Reason places is a cap somebody can get round by dialling in.
  const was = config.maxCallsPerDay;
  try {
    config.maxCallsPerDay = 2;
    assert.ok(streamToken(ring()));
    assert.ok(streamToken(ring()));
    const third = ring();
    assert.equal(third.status, 200);
    assert.match(third.body, /that's 2 calls today/);
    assert.match(third.body, /text me instead/);
    assert.match(third.body, /<Hangup\/>/);
    assert.equal(streamToken(third), null, "no stream past the cap");
    // The refused one is not written down as a call and does not use up another of their day.
    assert.equal(callCount(), 2);
    assert.equal(db.usageToday(C, today()).calls, 2);
  } finally {
    config.maxCallsPerDay = was;
  }
});

test("the minutes cap counts a call that came in too", () => {
  const was = config.maxCallMinutesPerDay;
  try {
    config.maxCallMinutesPerDay = 5;
    db.bumpUsage(C, today(), "call_seconds", 6 * 60);
    const out = ring();
    assert.match(out.body, /6 minutes of calls today/);
    assert.match(out.body, /<Hangup\/>/);
    assert.equal(callCount(), 0);
  } finally {
    config.maxCallMinutesPerDay = was;
  }
});

/** The day a cap is counted against, in the operator's timezone — same as src/accounts.js. */
function today() {
  return new Date(clock.now()).toLocaleDateString("en-CA", { timeZone: config.tz });
}

// ---------- a place ringing back ----------

const RESTAURANT = "+12125558888";

/** A call Reason made to a place, left in the state the given outcome describes. */
const calledThem = (over = {}) => {
  const row = db.createCall(C, {
    provider: "gptlive", toNumber: RESTAURANT, isOwner: false,
    goal: "ask if they can do a table for eight on Saturday",
    facts: ["the name is Omari", "eight people"], announcement: "x", externalId: "gptlive:CA_out_1",
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

  const r = ring(RESTAURANT);
  assert.equal(r.status, 200);
  // A THIRD-PARTY call, never an owner one. The row the owner path would have written says
  // `isOwner: true`, and a restaurant must never get one.
  const row = lastInbound();
  assert.equal(streamToken(r), row.webhook_token);
  assert.equal(row.is_owner, 0);
  assert.equal(row.direction, "in");
  assert.equal(row.errand_id, e.id);
  assert.match(row.goal, /ringing back about: ask if they can do a table for eight/);
  assert.deepEqual(JSON.parse(row.facts), ["the name is Omari", "eight people"]);
  // And they are told what they are talking to, because they are a person who has not been told.
  assert.match(row.announcement, /AI assistant/);
  assert.match(row.announcement, /recorded/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stranger_calls").get().n, 0, "not kept as a stranger");
  assert.equal(outbox().length, 0, "the master is not asked about a place Reason rang");
});

test("the returning call inherits the brief, so a call that was only asking still only asks", () => {
  calledThem({ brief: JSON.stringify({ goal: "ask about a table", approved: { book: false }, readBack: [] }) });
  ring(RESTAURANT);
  assert.equal(JSON.parse(lastInbound().brief).approved.book, false);
});

test("a number nobody called is still a stranger, and the master still hears about it", () => {
  const r = ring(STRANGER);
  assert.equal(r.status, 200);
  assert.ok(streamToken(r));
  assert.equal(db.listCalls(C).length, 0);
  assert.equal(outbox().length, 1);
});

test("a call that was already settled is not reopened by a ring back", () => {
  calledThem({ outcome_kind: "confirmed" });
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false, "there is no open question to continue");
  calledThem({ outcome_kind: "refused_by_them" });
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false);
  // Rung anyway: a stranger, with no call row opened on the operator's conversation.
  ring(RESTAURANT);
  assert.equal(lastInbound(), undefined);
  assert.equal(db.db.prepare("SELECT phone FROM stranger_calls").get()?.phone, RESTAURANT);
});

test("a ring back about something from last month is not that errand continuing", () => {
  calledThem({ outcome_kind: "hold_gave_up" });
  assert.equal(whoseCallIsThis(RESTAURANT).allow, true);
  clock.skip(25 * 60 * 60 * 1000);
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false, "a day later it is somebody ringing about something else");
  ring(RESTAURANT);
  assert.equal(lastInbound(), undefined, "a stranger, not the old errand");
});

// Security audit lead 30: a ring-back runs on the operator's conversation, whose daily call caps are
// exempt by default, so the number of ring-backs one call of Reason's opens has to be bounded here.
test("one call of Reason's opens a few ring-backs, not an unlimited line on the operator's bill", () => {
  calledThem({ outcome_kind: "hold_gave_up" });
  for (let i = 0; i < MAX_RING_BACKS; i++) {
    assert.equal(whoseCallIsThis(RESTAURANT).callingBack, true, `ring-back ${i + 1} is the errand`);
    ring(RESTAURANT);
  }
  const inbound = () => db.db.prepare("SELECT COUNT(*) n FROM calls WHERE direction = 'in'").get().n;
  assert.equal(inbound(), MAX_RING_BACKS);
  // The next one is a stranger: no third-party call opened on the operator's conversation.
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false);
  for (let i = 0; i < 5; i++) ring(RESTAURANT);
  assert.equal(inbound(), MAX_RING_BACKS, "no more errand calls past the budget");
  // A fresh call from Reason opens a fresh budget.
  calledThem({ outcome_kind: "hold_gave_up" });
  assert.equal(whoseCallIsThis(RESTAURANT).callingBack, true);
});

test("a ring-back does not slide the window: it stays a day from Reason's own call", () => {
  calledThem({ outcome_kind: "hold_gave_up" });
  clock.skip(23 * 60 * 60 * 1000);
  ring(RESTAURANT);
  assert.equal(lastInbound()?.is_owner, 0, "inside the day: the errand");
  clock.skip(2 * 60 * 60 * 1000);
  assert.equal(whoseCallIsThis(RESTAURANT).allow, false, "25 h after Reason rang, the ring-back row does not keep it open");
});

test("the number a call gives out to be rung back on is the install's own", async () => {
  // Without the install's Twilio number there is no usable return number, and a call that invents
  // one sends a busy place to a phone nobody answers.
  const { buildBrief } = await import("../src/calls/brief.js");
  assert.equal(buildBrief({ goal: "x" }).returnNumber, "");
  assert.equal(buildBrief({ goal: "x", returnNumber: NUMBER }).returnNumber, NUMBER);
  // The call a user asks for from inside a call hands out the number this install rings from.
  assert.match(readFileSync(new URL("../src/calls/fromcall.js", import.meta.url), "utf8"), /returnNumber: config\.twilioFrom \|\| ""/);
});
