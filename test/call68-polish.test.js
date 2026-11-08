// Call 68 (2026-11-01), Omari's own GPT-Live call about the car caption — good, with four rough edges, offline:
//   1. "I'll text that to you." was said before the opinion: the result quoted his caption ("i texted Reason
//      one voice note…") and that read as a send claim. Quoted words are not a claim; the honest line goes
//      where a real claim was;
//   2. the first answer was the whole critique, a rewrite read out and a three-way question: own calls are
//      told one point at a time, never a long text read aloud, one question;
//   3. "Hmm. Lemme have a think." then Reason skipped and the line sat silent: a skip on their own call is not
//      a hold, the turn is told to follow through on a "let me think", and the voice still says something;
//   4. the opener showed twice in the transcript (once in the recording): the seed gives way to the real words.
// Nothing dials, nothing runs a model, nothing reaches the network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call68-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
delete process.env.REASON_CALL_AMBIENCE;

const gl = await import("../src/calls/gptlive.js");
const voice = await import("../src/calls/voice.js");
const prompt = await import("../src/calls/voice-prompt.js");
const { EXTRA_BODY_KEYS } = await import("../src/calls/voice.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };
const CAPTION = "no chat because wym i'm still tracking bills, passport renewals, school schedules, and errands in five apps??? i texted Reason one voice note and it turned the forgotten task into a confirmed, trackable action without another download";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM threads; DELETE FROM accounts;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  Object.assign(config, { callIdentity: false, callVoice: "", callAmbience: "", ...TWILIO });
});

const call = (over = {}) => db.createCall(C, {
  provider: over.provider ?? "gptlive", toNumber: "+12025551234", isOwner: true,
  goal: "Talk Omari through the car ad screenshot", facts: ["Car one: strong opener, the back half reads like copy"],
  announcement: over.announcement ?? "hey Omari — got the car one again, wanted to talk it through.", state: "placing",
  externalId: over.externalId,
});

function fakeTimers() {
  let t = 1_000_000;
  let q = [];
  let n = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++n; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { q = q.filter(x => x.id !== id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        t = next.at;
        next.fn();
        await new Promise(r => setImmediate(r));
      }
      t = end;
    },
  };
}
function fakeTwilio() {
  const sent = [];
  const handlers = { msg: [], close: [] };
  return {
    sent, open: () => true, send: (s) => sent.push(JSON.parse(s)), close: () => {},
    onMessage: (f) => handlers.msg.push(f), onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
  };
}
function fakeLive() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  return {
    sent, socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()), emit: (e) => h.event.forEach(f => f(e)),
    of: (type) => sent.filter(e => e.type === type),
  };
}
function startCall({ row = call(), brain = async () => ({ text: "", tools: [] }) } = {}) {
  config.callVoice = "gptlive";
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const lines = [];
  const c = new gl.GptLiveCall({ call: db.getCall(C, row.id) ?? row, twilio, openLive: () => live.socket, brain, now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  live.emit({ type: "session.started", session: { id: "s68" } });
  return { c, timers, twilio, live, lines };
}
const voiceSays = (live, text) => live.emit({ type: "session.output_transcript.delta", delta: text });
const theySay = (live, text) => live.emit({ type: "session.input_transcript.delta", delta: text });
const delegate = (live, id) => live.emit({ type: "session.delegation.created", delegation: { id, type: "delegation", target: "client" } });

// ---------- 1. the stray "I'll text that to you." ----------

test("call 68: a result quoting his caption claims no send, and is said as it came", () => {
  const said = `Honest take: the opener is strong. It ends on "${CAPTION}", which sounds like marketing copy. Want to keep it, or rework it?`;
  const r = gl.withoutUnbackedSends(said, []);
  assert.equal(r.dropped, 0);
  assert.equal(r.text, said);
  assert.equal(gl.withoutUnbackedSends(`The line “i texted Reason one voice note” is the hook.`, []).dropped, 0, "curly quotes too");
});

test("a real unbacked send is still caught, and the honest line takes its place — not the front of the reply", () => {
  const r = gl.withoutUnbackedSends("Sounds good. Just texted. Pick whichever one feels most like you.", ["end_call"]);
  assert.equal(r.dropped, 1);
  assert.equal(r.text, "Sounds good. I'll text that to you. Pick whichever one feels most like you.");
  const two = gl.withoutUnbackedSends("I've sent it. Just texted you the other one too. Anything else?", []);
  assert.equal(two.dropped, 2);
  assert.equal(two.text, "I'll text that to you. Anything else?", "said once");
  assert.equal(gl.withoutUnbackedSends(`I've texted you "the tighter caption".`, []).dropped, 1, "a claim around a quote is still a claim");
  // An inch mark is not a quotation, and a lone quote mark is kept as it was (review, call 68).
  const inch = gl.withoutUnbackedSends('It has a 5" screen. I texted you the link. Also "great".', []);
  assert.equal(inch.dropped, 1);
  assert.equal(inch.text, `It has a 5" screen. I'll text that to you. Also "great".`);
  const lone = gl.withoutUnbackedSends('He said "hi. I sent you the link.', []);
  assert.equal(lone.text, `He said "hi. I'll text that to you.`);
});

test("call 68's first answer reaches the voice with no stray line in front", async () => {
  const text = `Honest take: the opener is strong. The back half quotes "${CAPTION}" and that reads like an ad.`;
  const { live, timers, lines } = startCall({ brain: async () => ({ text, tools: [], endCall: null }) });
  theySay(live, " Yeah, um, what do you think about it");
  delegate(live, "d1");
  await timers.advance(10);
  const result = live.of("session.commentary.append").find(e => e.delegation_id === "d1").content;
  assert.doesNotMatch(result, /I'll text that to you/);
  assert.match(result, /^Honest take/);
  assert.ok(!lines.some(l => l.gptlive_unbacked_send), "no guard trip logged");
});

// ---------- 2. one point at a time ----------

test("own calls: Reason's call turn is told one point at a time, never a long text read aloud, one question", () => {
  const frame = prompt.ownerCallFrame({ name: "Omari" });
  assert.match(frame, /one point at a time: one to three short sentences, then stop and let them react/);
  assert.match(frame, /Never read a long text out loud — a rewrite, a draft, a caption/);
  assert.match(frame, /offer to text it; text it only once they want it/);
  assert.match(frame, /At most one question per reply, and never a menu of options/);
  assert.ok(prompt.ownerCallFrame({ name: "Omari", identity: true }).includes("one point at a time"), "with identity on too");
});

test("own calls: the voice is told the same; calls to somebody else are not", () => {
  const own = gl.liveInstructions({ name: "Omari", owner: true });
  assert.match(own, /one point at a time, a few short sentences, then let them react/);
  assert.match(own, /Never read a long text out loud; offer to text it\. Ask at most one question at a time\./);
  assert.match(own, /friendly and warm, like a friend/, "warmth kept (call 76: without the chatty probing)");
  assert.doesNotMatch(gl.liveInstructions({ name: "Omari", owner: false }), /one point at a time/);
});

// ---------- 3. a "let me think" is never left hanging ----------

test("call 68: the voice says it's thinking, Reason skips — a short follow-up is still spoken", async () => {
  const { live, timers, lines } = startCall({ brain: async () => ({ text: "", tools: ["skip_turn"], calls: [], endCall: null, skip: true }) });
  voiceSays(live, "Do you want it to stay in that everyday juggling space? Or lean into the calling angle again?");
  await timers.advance(5000);
  delegate(live, "d2");
  voiceSays(live, "Hmm. Lemme have a think.");
  await timers.advance(10);
  const result = live.of("session.commentary.append").find(e => e.delegation_id === "d2");
  assert.ok(result, "a spoken result, not 'say nothing'");
  assert.equal(result.content, gl.SKIP_FOLLOW_UP);
  assert.ok(!live.of("session.thinking.append").some(e => e.delegation_id === "d2" && /Say nothing/.test(e.content)));
  assert.ok(lines.some(l => l.gptlive_skip_followed_up));
});

test("a skip with no promise made stays quiet, as before; so does one after they spoke again", async () => {
  {
    const { live, timers } = startCall({ brain: async () => ({ text: "", tools: ["skip_turn"], skip: true }) });
    theySay(live, " hang on, let me grab my keys");
    delegate(live, "d1");
    await timers.advance(10);
    assert.ok(live.of("session.thinking.append").some(e => e.delegation_id === "d1" && /Say nothing more/.test(e.content)));
    assert.ok(!live.of("session.commentary.append").some(e => e.delegation_id === "d1"));
  }
  {
    let release;
    const { live, timers } = startCall({ brain: () => new Promise(r => { release = r; }) });
    delegate(live, "d1");
    voiceSays(live, "One sec, let me check.");
    await timers.advance(1000);
    theySay(live, " actually I'm still talking");
    release({ text: "", tools: ["skip_turn"], skip: true });
    await timers.advance(10);
    assert.ok(!live.of("session.commentary.append").some(e => e.delegation_id === "d1"), "they've moved on: no hand-back over them");
  }
});

test("a line call's empty result is unchanged: never a follow-up of the voice's own", () => {
  const { c } = startCall();
  c.line = true;
  assert.equal(c.promisedThought({ startedAt: 0, ack: "let me check" }), false);
  c.line = false;
  const at = c.lastCallerAt + 1;
  assert.equal(c.promisedThought({ startedAt: at, ack: "let me check" }), true);
  assert.equal(c.promisedThought({ startedAt: at, ack: "Mm-hmm." }), false);
  assert.equal(c.promisedThought({ startedAt: at, ack: "Yeah." }), false, "a bare yeah is listening, not a promise");
  for (const said of ["Hmm. Lemme have a think.", "Hmm, yeah okay, I'm giving it some thought.", "Give me a moment. I'll have a proper think.", "Alright, one sec, I'm on it.", "Give me a moment to mull it over carefully.", "Right, let me chew on that one."]) {
    assert.equal(c.promisedThought({ startedAt: at, ack: said }), true, `the live voice's own words: ${said}`);
  }
  assert.equal(c.promisedThought({ startedAt: at, ack: "I think the second line looks great — want me to tweak it?" }), false, "plain speech is no promise");
  assert.equal(c.promisedThought({ startedAt: at, ack: "Let me think — which one do you like?" }), false, "already handed back");
});

test("the quiet line on their own call asks for the 'let me think' to be followed through; others unchanged", () => {
  const ended = [{ role: "user", content: "what do you think" }, { role: "assistant", content: "Hmm. Lemme have a think." }];
  assert.equal(voice.endOnTheirSide(ended).at(-1).content, voice.LINE_IS_QUIET);
  const own = voice.endOnTheirSide(ended, { own: true }).at(-1).content;
  assert.equal(own, voice.OWN_LINE_IS_QUIET);
  assert.match(own, /Never leave a "let me think" hanging/);
  assert.match(own, /call skip_turn and wait — never write NO_REPLY/);
});

// The Reason call turn, end to end with a scripted model (the OpenAI-style request shape, as in call-machines).
const scripted = (...events) => async function* () {
  for (const e of events) {
    if (typeof e === "string") yield { type: "text", text: e };
    else yield { type: "tool_use", name: e.tool, id: `tu_${Math.random().toString(36).slice(2, 7)}`, input: e.input ?? {} };
  }
};
async function drain(stream) {
  const raw = [];
  for await (const s of stream) raw.push(s);
  const chunks = raw.filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6)));
  return { said: chunks.map(c => c.choices[0].delta.content ?? "").join(""), toolCalls: chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []) };
}
const turn = async (row, generate, messages, seen = []) => drain((await voice.llmRequest({
  rawBody: JSON.stringify({ model: "reason", stream: true, messages, extra_body: { [EXTRA_BODY_KEYS.callId]: row.id, [EXTRA_BODY_KEYS.conversationId]: C } }),
  headers: {},
  generate: (req) => { seen.push(req); return generate(req); },
})).stream);

test("call 68: a skip on their own call is a pause in the conversation, never a hold", async () => {
  const row = call({ provider: "gptlive", externalId: "conv_68" });
  const messages = [{ role: "user", content: "what do you think" }, { role: "assistant", content: "Hmm. Lemme have a think." }];
  const seen = [];
  const r = await turn(row, scripted({ tool: "skip_turn", input: { reason: "waiting for Omari to answer the juggling vs calling question" } }), messages, seen);
  assert.equal(r.toolCalls[0]?.function?.name, "skip_turn", "the skip still goes to the platform");
  const after = db.getCall(C, row.id);
  assert.ok(!after.hold_since, "no hold clock started");
  assert.equal(Number(after.hold_waits ?? 0), 0);
  const asked = JSON.stringify(seen.at(-1) ?? {});
  assert.ok(asked.includes("Never leave a \\\"let me think\\\" hanging"), "the turn was told to follow through");
});

// ---------- 4. the opener once ----------

test("call 68: the opener said in pieces around their 'Hello' is in the transcript once", async () => {
  const { c, live, timers } = startCall();
  await timers.advance(1900);
  voiceSays(live, "hey Omari — got the car one again,");
  theySay(live, " Hello");
  voiceSays(live, " wanted to talk it through.");
  await timers.advance(3000);
  theySay(live, " Yeah, um, what do you think about it");
  const reason = c.turns.filter(t => t.who === "reason").map(t => t.text.trim());
  assert.deepEqual(reason, ["hey Omari — got the car one again,", "wanted to talk it through."]);
  assert.equal(c.messages().filter(m => /got the car one again/.test(m.content)).length, 1);
});

test("until the voice speaks, the seeded opener stands in (a hand-off before the first word still has it)", () => {
  const { c } = startCall();
  assert.equal(c.messages()[0]?.content, "hey Omari — got the car one again, wanted to talk it through.");
});
